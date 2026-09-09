"""Discovery of AgentCore agents and their recent sessions via CloudWatch."""

import json
import os
import time
from datetime import datetime, timedelta, timezone

import boto3

REGION = os.environ.get("AWS_REGION", "us-west-2")
LOG_GROUP_PREFIX = "/aws/bedrock-agentcore/runtimes/"
# Insights 结果轮询的格子：0.25 s 起，**每次等到「目前已等的总时长」**（= 到达时刻倍增），
# 单次上限 1.0 s ⇒ 轮询时刻 0.25 / 0.5 / 1.0 / 2.0 / 3.0 / 4.0 …
#
# 为什么不恒 1.0 s（收口前如此）：查询的完成时刻被**向上取整到轮询格**，恒 1.0 s 时平均
# 白等半格 ≈ 0.5 s/趟，而冷开 hub / fleet_status 一次要发好几趟到十几趟查询，白等被趟数乘开。
#
# 为什么是「到达时刻倍增」而不是「单次延时倍增」：单次延时倍增（0.25→0.5→1.0）的到达时刻
# 是 0.25 / 0.75 / 1.75 / 2.75 …，**跳过了 1.0**——本地实测 2026-09-08：服务端 0.80 s 就绪时
# 旧法 1.000 s 拿到、它要等到 1.752 s（反而慢 0.75 s）。到达时刻倍增的格子是旧格
# {1,2,3,…} 的**超集**，所以对任何就绪时刻都不比旧法晚，只在头 1 秒里多两次
# get_query_results（廉价调用）。
QUERY_POLL_START_SECONDS = 0.25
QUERY_POLL_MAX_SECONDS = 1.0
QUERY_TIMEOUT_SECONDS = 60.0


def _control_client():
    return boto3.client("bedrock-agentcore-control", region_name=REGION)


def _logs_client():
    return boto3.client("logs", region_name=REGION)


def list_agents() -> list[dict]:
    """List READY agent runtimes with their runtime log groups (if any).

    An agent with no log group has never produced observability data and
    cannot be evaluated, so we flag it with has_logs=False instead of hiding
    it — the UI greys it out.
    """
    client = _control_client()
    runtimes = []
    token = None
    while True:
        kwargs = {"maxResults": 100}
        if token:
            kwargs["nextToken"] = token
        resp = client.list_agent_runtimes(**kwargs)
        runtimes.extend(resp.get("agentRuntimes", []))
        token = resp.get("nextToken")
        if not token:
            break

    logs = _logs_client()
    log_groups: dict[str, str] = {}
    paginator = logs.get_paginator("describe_log_groups")
    for page in paginator.paginate(logGroupNamePrefix=LOG_GROUP_PREFIX):
        for lg in page["logGroups"]:
            # /aws/bedrock-agentcore/runtimes/<runtimeId>-<endpoint> -> runtimeId
            suffix = lg["logGroupName"][len(LOG_GROUP_PREFIX):]
            runtime_id = suffix.rsplit("-", 1)[0]
            log_groups[runtime_id] = lg["logGroupName"]

    agents = []
    for rt in runtimes:
        runtime_id = rt["agentRuntimeId"]
        log_group = log_groups.get(runtime_id)
        agents.append(
            {
                "agent_name": rt["agentRuntimeName"],
                "runtime_id": runtime_id,
                "runtime_arn": rt["agentRuntimeArn"],
                "description": rt.get("description", ""),
                "status": rt["status"],
                "last_updated": str(rt.get("lastUpdatedAt", "")),
                "log_group": log_group,
                "has_logs": log_group is not None,
            }
        )
    return agents


def _run_insights_query(log_group: str, query: str, lookback_days: int) -> list[list[dict]]:
    logs = _logs_client()
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=lookback_days)
    qid = logs.start_query(
        logGroupName=log_group,
        startTime=int(start.timestamp()),
        endTime=int(end.timestamp()),
        queryString=query,
    )["queryId"]

    deadline = time.time() + QUERY_TIMEOUT_SECONDS
    delay, slept = QUERY_POLL_START_SECONDS, 0.0
    while time.time() < deadline:
        resp = logs.get_query_results(queryId=qid)
        if resp["status"] in ("Complete", "Failed", "Cancelled", "Timeout"):
            if resp["status"] != "Complete":
                raise RuntimeError(f"Logs Insights query {resp['status']} for {log_group}")
            return resp["results"]
        time.sleep(delay)
        slept += delay
        delay = min(slept, QUERY_POLL_MAX_SECONDS)  # 到达时刻倍增，封顶 1.0 s
    raise TimeoutError(f"Logs Insights query timed out for {log_group}")


# `filter_log_events` 读日志流本身，**不过 Logs Insights 的查询索引**。这两条读法
# 在这条链上差着两个数量级 —— 现场计时（2026-08-26，同一次调用、同一个 session、
# 同一个日志组，锚点 = agent 返回时刻）：`filter_log_events` 首次可见 **4.5 s**，
# Insights 首次可见 **115.7 s**（另一次探针 ~78 s）；而取工具证据的预算只有
# `testrun.SPAN_FETCH_BACKOFF` 累计 **14 s**。数据到位从来不是瓶颈：同一批 span 的
# `@ingestionTime` 只比事件时刻晚 3.3 s ⇒ 那 ~75~110 s 全在 Insights 的**查询可见性**上。
# 探针与逐秒读数：`.scratch/tau-airline/v4/probe_readpath.py`。
FILTER_EVENTS_PAGE_LIMIT = 1000
# 页数上限（≈20k 条事件；一个会话现读 5~254 条）。**必须有**：带 filterPattern 的
# 分页会吐出「0 条事件但仍有 nextToken」的页（它在扫描），没有上限就能转到超时。
FILTER_EVENTS_MAX_PAGES = 20


def _record_session_id(record: dict) -> str:
    """一条 span 记录自报的 session id，两种形状都认，取不到返回空串。

    记录里的键**字面量含点**（`attributes["session.id"]`），但换个导出管道也可能
    写成嵌套的 `attributes["session"]["id"]`。两种都读；读不到就算不匹配 ——
    宁可判成「还没到」（会重试、最后按查不到降级），也不能放进去当成本次证据。
    """
    attrs = record.get("attributes")
    if not isinstance(attrs, dict):
        return ""
    sid = attrs.get("session.id")
    if not sid:
        nested = attrs.get("session")
        sid = nested.get("id") if isinstance(nested, dict) else None
    return str(sid) if sid else ""


def filter_span_records(log_group: str, session_id: str, lookback_days: int,
                        log_stream_names: list[str] | None = None) -> list[dict]:
    """One session's raw span records, read straight off the log streams.

    `log_stream_names` 限定只读这几条流：runtime 专属日志组里除了 `spans` 流还有
    stdout/stderr/otel-rt-logs（tracesource 的回退读法只认 `spans`）。None = 全组。

    Same (log_group, session_id, lookback_days) contract and same return shape
    as the Insights read in tracesource._fetch_central_session_records, so the
    two are interchangeable downstream — everything after this point (parser,
    shape adaptation, mapper) is literally the same code.

    ⚠️ `filterPattern` is the **text** form `"<sid>"`, never the JSON form
    `{$.attributes.session.id = "<sid>"}`: the record's key literally contains
    dots, so "JSON path" and "key name with dots in it" are two readings of the
    same text — guessing wrong yields a constant 0 result, which is
    indistinguishable from "the spans haven't landed yet". Text match narrows
    server-side; the exact check happens locally, per record.

    ⚠️ No scope/service narrowing here (that's `build_span_filters`, which only
    Insights can apply). Callers must not point this at a *shared* span group.
    """
    logs = _logs_client()
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=lookback_days)
    records: list[dict] = []
    token = None
    for _ in range(FILTER_EVENTS_MAX_PAGES):
        kwargs = {
            "logGroupName": log_group,
            "startTime": int(start.timestamp() * 1000),
            "endTime": int(end.timestamp() * 1000) + 1000,
            "filterPattern": f'"{session_id}"',
            "limit": FILTER_EVENTS_PAGE_LIMIT,
        }
        if log_stream_names:
            kwargs["logStreamNames"] = list(log_stream_names)
        if token:
            kwargs["nextToken"] = token
        resp = logs.filter_log_events(**kwargs)
        for event in resp.get("events", []):
            try:
                record = json.loads(event["message"])
            except (json.JSONDecodeError, KeyError, TypeError):
                continue                      # 非 JSON 行（普通应用日志）不是 span
            if isinstance(record, dict) and _record_session_id(record) == session_id:
                records.append(record)
        token = resp.get("nextToken")
        if not token:
            return records
    # 到这里说明还有页没读完。**宁可报错也不返回半份**：截断过的证据与「它只调了
    # 这几次」在下游完全同形，而 graft 之后判官会把它当全量读。
    raise RuntimeError(
        f"{log_group}: session_id='{session_id}' 的 span 超过 "
        f"{FILTER_EVENTS_MAX_PAGES * FILTER_EVENTS_PAGE_LIMIT} 条事件仍未读完 —— "
        "拒绝返回截断的工具证据")


def escape_insights_literal(value: str) -> str:
    """Escape a user-supplied string for use inside a Logs Insights quoted literal."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def build_span_filters(scope_filter: str = "", service_filter: str = "",
                       log_stream: str = "") -> str:
    """`| filter ...` clauses narrowing a span query to one agent's spans.

    A dedicated runtime log group holds exactly one agent's spans, so no extra
    filters are needed there ("" comes back). A *centralized* span group
    (CloudWatch Transaction Search writes every instrumented service's spans to
    `aws/spans`) mixes many services — scope_filter (instrumentationScope name)
    and/or service_filter (resource.attributes.service.name) pick one agent's
    spans out of the shared stream.

    `log_stream` 限定 `@logStream`：runtime 专属日志组同时装着 stdout/stderr/
    otel-rt-logs 与 `spans` 流，tracesource 的回退读法只认后者（那几条日志流里的
    JSON 行也可能带 attributes.session.id，混进来就是把应用日志当 span 数）。
    """
    extra = ""
    if service_filter:
        extra += (' | filter resource.attributes.service.name = '
                  f'"{escape_insights_literal(service_filter)}"')
    if scope_filter:
        extra += f' | filter scope.name = "{escape_insights_literal(scope_filter)}"'
    if log_stream:
        extra += f' | filter @logStream = "{escape_insights_literal(log_stream)}"'
    return extra


# 评估流量的会话 id 前缀：testrun / redteam / probe 三处起名都是 f"evaltest-…"（实测
# 2026-09-08：三处 f-string 全带连字符，夹具里三个会话 id 同形）。Python 侧分流用的常量
# 也指向这一个（topology.EVAL_SESSION_PREFIX）。
EVAL_SESSION_PREFIX = "evaltest"


def eval_session_filter(include_test: bool = False) -> str:
    """Insights 侧「把评估流量排掉」的那条子句；include_test=True ⇒ 空串（一条都不加）。

    **只有这一份**：会话枚举（build_session_query）与五个数 / 拓扑
    （agentstatus.build_status_query）都调它。收口前两处逐字抄了同一句，改一处漂一处。

    为什么保留 `not like '<前缀>'` 这种**子串**判法、而不跟 Python 侧统一成前缀判法：
    子串比前缀**严**（多排掉「中间含 evaltest」的 id）。现网 id 一律以 `evaltest-` 开头，
    两种判法当下同集；但真要动，只有子串这一侧是「不放宽」的方向 —— 换成前缀会把
    「id 中间含 evaltest」的会话放进真实流量统计，而这里的默认口径本就是「真实流量要干净」。
    Python 侧分流（topology.is_eval_session）用前缀判是因为那边在给已取回的 span 分档，
    前缀是 id 真实的构造方式。两处判法不同是有意的，共用的是同一个前缀词。
    """
    return ("" if include_test
            else f" | filter attributes.session.id not like '{EVAL_SESSION_PREFIX}'")


def build_session_query(max_sessions: int, include_test: bool = False,
                        scope_filter: str = "", service_filter: str = "",
                        log_stream: str = "") -> str:
    """Assemble the Logs Insights session-enumeration query.

    Session ids live at attributes.session.id in both the runtime-group and the
    centralized aws/spans shapes (verified against real aws/spans data), so one
    query serves both — only the narrowing filters differ.
    """
    test_filter = eval_session_filter(include_test)
    extra = build_span_filters(scope_filter, service_filter, log_stream)
    return (
        "fields attributes.session.id"
        " | filter ispresent(attributes.session.id)"
        f"{extra}"
        f"{test_filter}"
        " | stats latest(@timestamp) as last_ts, count(*) as span_count by attributes.session.id"
        f" | sort last_ts desc | limit {int(max_sessions)}"
    )


def list_recent_sessions(log_group: str, lookback_days: int, max_sessions: int,
                         include_test: bool = False,
                         scope_filter: str = "", service_filter: str = "",
                         log_stream: str = "") -> list[dict]:
    """Return the most recent session ids in a span-bearing log group.

    Dataset test runs invoke agents with 'evaltest'-prefixed session ids;
    excluded by default so production stats stay clean. scope_filter /
    service_filter narrow the query when log_group is a shared span sink
    (e.g. the centralized `aws/spans` group) rather than a per-runtime group;
    log_stream narrows it to one stream (the runtime group's `spans` stream).
    """
    query = build_session_query(max_sessions, include_test, scope_filter, service_filter,
                                log_stream)
    rows = _run_insights_query(log_group, query, lookback_days)
    sessions = []
    for row in rows:
        fields = {f["field"]: f["value"] for f in row}
        sid = fields.get("attributes.session.id")
        if not sid:
            continue
        sessions.append(
            {
                "session_id": sid,
                "last_ts": int(fields.get("last_ts", 0)),
                "span_count": int(fields.get("span_count", 0)),
            }
        )
    return sessions
