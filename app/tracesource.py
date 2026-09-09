"""Trace-source abstraction: where a session's observability data comes from.

AgentCore runtime traces live in CloudWatch. Everything that reads them —
provider construction, session enumeration, raw-span metrics — is funnelled
through this module so the evaluation pipeline never touches log groups
directly. Besides an agent's dedicated runtime log group, a per-agent
span_source override (catalog.set_span_source) can point at the centralized
`aws/spans` group written by CloudWatch Transaction Search / ADOT.

`get_evaluation_data` returns (data, raw_spans) rather than just data. The raw
spans matter: metrics.py counts tokens off raw span attributes, and CloudWatch's
parser hands them over through a module-level global (patches.LAST_PARSED_SPANS).
Returning them explicitly keeps a session from being priced against whichever
session happened to be parsed before it.
"""

import json
import logging
import os
import re

from discovery import (LOG_GROUP_PREFIX, REGION, _run_insights_query, build_span_filters,
                       escape_insights_literal, filter_span_records, list_recent_sessions)

logger = logging.getLogger("eval-anything")

# CloudWatch Transaction Search / ADOT writes every instrumented service's
# spans into this one account-level log group. **Only** agents whose image
# ships its own ADOT collector end up here (live: the dsh* family) — for them
# the dedicated runtime log group's `spans` stream stays empty.
#
# The other camp (live 2026-09-07: the tauairline_* family — CodeZip +
# `opentelemetry-instrument` + aws-opentelemetry-distro 0.19, execution role
# with logs:PutResourcePolicy) uses AgentCore's default "unified span
# destination": spans land in the agent's OWN runtime log group under
# `@logStream = "spans"` (fable5: 528 spans / 52 sessions in 30 days there,
# 0 in aws/spans). So "the runtime group is always empty" is false as a
# general statement, which is why `resolve_span_config` hands out a
# `fallback_log_group` whenever the configured source is aws/spans: read the
# central group first, and only when it yields nothing, read the runtime
# group's `spans` stream. Record shape is the same CloudWatch structured-span
# JSON in both places (verified side by side: attributes.session.id,
# resource.attributes.service.name, scope.name, traceId, *TimeUnixNano — the
# runtime-group record just carries an extra `events` list), so one parser
# serves both and nothing downstream forks on the origin.
CENTRAL_SPANS_LOG_GROUP = "aws/spans"
# The stream inside a runtime log group that holds spans. The group also has
# stdout/stderr/otel-rt-logs streams; a fallback read MUST pin this one.
RUNTIME_SPANS_STREAM = "spans"
# `span_origin` values stamped on every session/fetch result.
ORIGIN_CENTRAL = "central"              # read from a configured shared span group
ORIGIN_RUNTIME_GROUP = "runtime_group"  # read from the agent's own runtime log group

# ---------- 只用上报数据评估（ADR-0019 批 1）：Agent 侧 span 的判据 ----------
#
# 平台自己调被测 Agent 时**也发 span**（botocore bedrock-agentcore 插桩，span 名
# `Bedrock AgentCore.InvokeAgentRuntime`，带同一个 attributes.session.id），
# resource.attributes.service.name = "<RUNTIME_NAME>.DEFAULT"（AgentCore 以
# 「runtime 名.endpoint 名」命名；现网 2026-09-07 aws/spans 七天实查：evalanything.DEFAULT
# 13374 条 span / 929 个会话，**0 条**带 gen_ai 对话内容）。「aws/spans 里有没有 Agent
# 侧 span」若不排掉它，对每个 evaltest 会话都恒为真。RUNTIME_NAME 与 infra
# （eval_runtime_stack.RUNTIME_NAME → 运行时环境变量）同源。
PLATFORM_SERVICE_NAME = f"{os.environ.get('RUNTIME_NAME') or 'evalanything'}.DEFAULT"

# 「带对话内容」= span 属性里有这几个键之一。前两个是 OTel GenAI 语义约定里 mapper 直接
# 读的；后四个是 `_adapt_central_span` 会**合成**前两个的来源（invoke_agent 的
# gen_ai.task.* / agentcore.invocation.*，现网 deepseek-harness 实证）。只有元数据
# 没有文本的会话（如平台自家那条 InvokeAgentRuntime）不算「有 trace」。
#
# 判据与还原**共用这一份声明**：`build_content_predicate` 只从 CONTENT_SOURCES 生成
# Insights 判据，CI 钉（tests/test_content_predicate_sdk_pin.py）拿 events 那半与 SDK
# 源码里真读的事件名对拍，断言我们的集合 ⊇ SDK 的。别在别处另抄一份名字列表 ——
# 收口前 CONTENT_EVENT_NAMES 手抄了三个，与 SDK 真读的五个**互不包含**。
CONTENT_SOURCES: dict[str, tuple[str, ...]] = {
    "attrs": (
        "gen_ai.input.messages", "gen_ai.output.messages",
        "gen_ai.task.input", "gen_ai.task.output",
        "agentcore.invocation.user_prompt", "agentcore.invocation.agent_response",
    ),
    # 「带对话内容」的**第二条路**：span 的 inline events。两派埋点把对话放在不同地方 ——
    #   · dsh 派（镜像内自带 ADOT collector，span 进 aws/spans）：对话在 span **attributes**，
    #     CONTENT_ATTRS 那六个键里必有一个（现网 2026-09-08 同日红队 run 31 ok / 1 no_trace）；
    #   · fable5 派（CodeZip + opentelemetry-instrument + AgentCore 统一 span 目的地，span 进
    #     自己 runtime 组的 `spans` 流）：对话在 span 的 **inline events** 上，attributes 里
    #     22 个键全是元数据 + system_prompt，CONTENT_ATTRS **一个都不中**（现网 2026-09-08
    #     实测：回归 run 的 5 个会话 spans 5~10、sampled，却全被判 no_content）。
    # 所以内容判据 = 「attributes 有内容」**或**「inline events 有对话事件」。
    #
    # 为什么按 @message 的原样字节匹配、不按结构取：CloudWatch Insights 确实把 inline events
    # 摊成 `events.0.name` / `events.0.attributes.content` 这种路径（2026-09-08 实查可取到值），
    # 但**下标不定** —— 同一批会话里 invoke_agent 的 events = [user.message, choice]、chat 的
    # = [system.message, user.message, choice]、execute_event_loop_cycle 的
    # = [user.message, assistant.message, …]，一条 span 最多 5 个事件。按下标穷举等于给
    # 「事件多一个就漏判」留门。
    #
    # 为什么不误收平台自家的 span（三重）：
    #   ① service.name 那道过滤照旧在（`build_agent_side_filter`），平台自家那条
    #      InvokeAgentRuntime span 先被排掉；
    #   ② 平台自家 span 是 botocore 插桩发的，**没有 events 字段** —— 现网 2026-09-08 对
    #      aws/spans 里 `service.name = "evalanything.DEFAULT"` 的 16861 条 span 实测，本判据
    #      命中 **0** 条；
    #   ③ 判据锚在紧凑 JSON 的键值对 `"name":"<事件名>"` 上，而对话正文里出现同样字符串时
    #      会被转义成 `\"name\":\"…\"`（字节不同），所以正文伪造不出「有内容」。
    # 不收 `gen_ai.system.message`：那是 system_prompt，不是对话内容 —— fable5 的 attributes
    # 里本来就有 system_prompt，把它算成「有内容」等于把只有元数据的会话判成有 trace。
    "events": (
        "gen_ai.user.message", "gen_ai.assistant.message", "gen_ai.choice",
        # 下面两个是 SDK 还原时**也会读**、而我们判据里原先没有的（收口前两侧集合互不
        # 包含）。补齐后我们的集合是 SDK 的超集，CI 钉按这个方向断言（⊇，不是 ==）：
        # 判据比还原宽只会多等一轮 span，判据比还原窄会把还原得出内容的会话标成
        # no_content —— 后者才是丢分。
        "gen_ai.tool.message",                       # _convert_inference_span / _convert_tool_execution_span
        "gen_ai.client.inference.operation.details",  # 当前 OTel GenAI 统一事件，三个 converter 都读
    ),
}
CONTENT_ATTRS = CONTENT_SOURCES["attrs"]
CONTENT_EVENT_NAMES = CONTENT_SOURCES["events"]
# 一次 Insights 查询最多核对的会话数：`in [...]` 字面量 64 字 × 60 ≈ 4KB，
# 远在查询串 10KB 上限之内。
TRACE_CHECK_BATCH = 60


# ---------- centralized span-group support (aws/spans) ----------
#
# Recon against live aws/spans data (us-west-2, 2026-08-22): spans carry NO
# runtime ARN / agent-name attribute — resource.attributes has only
# service.name / service.version / deployment.environment.name / user.id.
# So which agent a span belongs to cannot be derived; it is configured per
# agent (catalog.set_span_source) as {log_group, scope_filter, service_filter}.


def runtime_log_group(agent: dict) -> str:
    """该 Agent 自己的 runtime 日志组名，推不出来返回空串。

    三个来源，按可信度取：discovery.list_agents 已经把真名放在 `log_group`（那是
    describe-log-groups 现查的，含 endpoint 后缀，可能是 BASELINE 而不是 DEFAULT），
    没有就按 runtime id / ARN 拼默认端点的名字。**只认 runtime 前缀的组**：配了
    span_source 的 agent 的 `log_group` 可能已经是 `aws/spans`，那不是它的专属组。
    """
    lg = agent.get("log_group") or ""
    if lg.startswith(LOG_GROUP_PREFIX):
        return lg
    runtime_id = agent.get("runtime_id") or ""
    if not runtime_id:
        arn = str(agent.get("runtime_arn") or "")
        m = re.search(r"runtime/([^/:]+)", arn)
        runtime_id = m.group(1) if m else ""
    if not runtime_id:
        return ""
    return f"{LOG_GROUP_PREFIX}{runtime_id}-DEFAULT"


def _cfg_with_fallback(agent: dict, log_group: str, src: dict) -> dict:
    """{log_group, scope_filter, service_filter} + 该加则加的 fallback_log_group。

    回退规则**只有这一份**：`resolve_span_config`（列会话 / 五个数 / 拓扑 / dataset
    取证据）与 `_central_evaluation_data`（观测评估）都从这里拿 cfg。两处各写一遍
    的话，「哪条路径会回退」就会悄悄漂成两个答案。

    回退源只在主源是**共享** span 组时才加：那是「span 可能根本不在这里」的唯一
    情形（两派分流见文件头）。用户显式把 span_source 指到别的组 = 他知道 span 在
    哪，替他去猜 runtime 组等于拿另一个组的 span 当证据。主源本来就是专属组时也
    不加（那时 fallback 会与主源同名，同一批字节查两遍）。
    """
    cfg = {"log_group": log_group,
           "scope_filter": src.get("scope_filter", ""),
           "service_filter": src.get("service_filter", "")}
    if log_group == CENTRAL_SPANS_LOG_GROUP:
        fallback = runtime_log_group(agent)
        if fallback and fallback != log_group:
            cfg["fallback_log_group"] = fallback
    return cfg


def read_plans(cfg: dict, spans_only: bool = False) -> list[dict]:
    """`cfg` → 按顺序试的读法清单，每项 {log_group, scope_filter, service_filter,
    log_stream, span_origin}。**span 读路只有这一份**：列会话 / 五个数 / 拓扑
    （agentstatus.query_status_rows）、按会话取数（fetch_session_with_origin）、评分取数
    （fetch_scoring_session）、环节后核对（planrun._check_traces → check_agent_traces）
    都从这里拿清单。各自再判一遍的话，「哪个组带哪些过滤、限哪条流」就会漂成几个答案
    （2026-09-08 收口前实测确有两处对不上，读数表见 tests/test_span_read_paths.py）。

    第一项永远是主源（cfg["log_group"] 原样带它的过滤条件）；`fallback_log_group`
    存在时追加第二项 = 专属 runtime 组的 `spans` 流，**不带** scope/service 过滤
    （那两个过滤器是给共享组挑一个 service 用的，专属组里只有这一个 agent 的 span，
    带上去只会把真数据全滤掉）。

    调用方的义务是**顺序试、短路**：第一项查到就不查第二项（见 `fetch_session` /
    `list_sessions`），别每次双查。

    主源的 `log_stream` 默认空（读整个组）；cfg 显式带 `log_stream` 时原样透传 ——
    只用上报数据评估的评分阶段（testrun._fetch_scoring_session）按核对真查过的组
    逐个直读，读到回退的 runtime 组时就得把「只认 spans 流」这条规则一起带过去，
    否则同一个组在回退读法里限流、直读时不限，两条路读出两种字节。

    `spans_only=True` = **核对口径**：专属 runtime 组（组名带 LOG_GROUP_PREFIX 前缀）
    一律只认 `spans` 流，主源也算。为什么核对与取数在这一格上口径不同、而且是故意的：
    核对在**数条数**（`count(*)` / `sum(has_content)`），那个组里 stdout / stderr /
    otel-rt-logs 流的 JSON 行也可能带 attributes.session.id，不限流就是把应用日志数
    成 span；取数是把整组的记录交给 parser 归一，非 span 的行在 `_session_from_records`
    里本来就被丢掉，限流只会多一条「万一 span 不在这个流名下就整会话取不到」的风险。
    默认 False = 取数口径，与收口前逐字节一致。
    """
    primary_stream = cfg.get("log_stream", "")
    if spans_only and not primary_stream and cfg["log_group"].startswith(LOG_GROUP_PREFIX):
        primary_stream = RUNTIME_SPANS_STREAM
    plans = [{
        "log_group": cfg["log_group"],
        "scope_filter": cfg.get("scope_filter", ""),
        "service_filter": cfg.get("service_filter", ""),
        "log_stream": primary_stream,
        "span_origin": (ORIGIN_CENTRAL if cfg["log_group"] == CENTRAL_SPANS_LOG_GROUP
                        else ORIGIN_RUNTIME_GROUP),
    }]
    if cfg.get("fallback_log_group"):
        plans.append({
            "log_group": cfg["fallback_log_group"],
            "scope_filter": "",
            "service_filter": "",
            "log_stream": RUNTIME_SPANS_STREAM,
            "span_origin": ORIGIN_RUNTIME_GROUP,
        })
    return plans


def resolve_span_source(agent: dict) -> dict | None:
    """Effective span-source override for this agent, or None when unset.

    agent["span_source"] (in-memory: probes, validation runs) wins over the
    persisted catalog config, so a source can be exercised end-to-end without
    writing production configuration first.
    """
    src = agent.get("span_source")
    if not isinstance(src, dict) or not src:
        import catalog
        src = catalog.get_span_source(agent.get("agent_name", ""))
    if not isinstance(src, dict):
        return None
    if not (src.get("log_group") or src.get("scope_filter") or src.get("service_filter")):
        return None
    return src


def _normalize_name(value: str) -> str:
    return "".join(c for c in value.lower() if c.isalnum())


def probe_central_spans(agent: dict, lookback_days: int) -> dict | None:
    """Best-effort probe of the centralized aws/spans group. Never raises.

    Called when an agent's runtime log group yields zero sessions: if some
    Transaction Search / ADOT pipeline is writing this agent's spans to
    aws/spans instead, the enumeration there tells the user where to point
    span_source. Returns a hint dict for the UI, or None when aws/spans is
    absent/empty (probing is a courtesy, not a requirement).

    The hint carries all session-bearing service.names as candidates because
    spans hold no agent identity: a service.name rarely equals the AgentCore
    runtime name (live example: agent "dshAgentCoreEval" emits
    service.name="deepseek-harness"). Name-variant matches are flagged so the
    UI can preselect, but the user confirms — the probe never writes config.
    """
    query = (
        "fields resource.attributes.service.name as service"
        " | filter ispresent(attributes.session.id)"
        " and ispresent(resource.attributes.service.name)"
        " | stats count(*) as span_count, latest(@timestamp) as last_ts by service"
        " | sort last_ts desc | limit 20"
    )
    try:
        rows = _run_insights_query(CENTRAL_SPANS_LOG_GROUP, query, lookback_days)
    except Exception:
        logger.info("aws/spans probe failed (group missing or inaccessible); no hint",
                    exc_info=True)
        return None

    agent_key = _normalize_name(agent.get("agent_name", ""))
    candidates = []
    for row in rows:
        fields = {f["field"]: f["value"] for f in row}
        service = fields.get("service")
        if not service:
            continue
        service_key = _normalize_name(service)
        matched = bool(agent_key) and (agent_key in service_key or service_key in agent_key)
        candidates.append({
            "service": service,
            "span_count": int(fields.get("span_count", 0)),
            "last_ts": int(fields.get("last_ts", 0)),
            "name_match": matched,
        })
    if not candidates:
        return None
    candidates.sort(key=lambda c: (not c["name_match"], -c["last_ts"]))
    matched_any = any(c["name_match"] for c in candidates)
    return {
        "kind": "central_spans",
        "log_group": CENTRAL_SPANS_LOG_GROUP,
        "matched": matched_any,
        "candidates": candidates,
        "message": (
            "该 Agent 的 runtime 日志组里没有 span，但集中式 aws/spans 日志组里"
            "发现了带会话的 trace"
            + ("（其中有 service 名与 Agent 名相近）" if matched_any else "")
            + "。若下列 service 之一属于该 Agent，请在调用配置里保存 span 源"
            "设置（log_group=aws/spans + service 过滤）。"
        ),
    }


def _adapt_central_span(span: dict) -> None:
    """Adapt one parsed aws/spans span dict in place for the SDK mappers.

    Three gaps between the ADOT/Transaction Search span shape and what
    GenericGenAISessionMapper + transcript.py consume (all verified against
    live deepseek-harness spans):

    1. Session filter: the mapper matches sessions on gen_ai.conversation.id
       *or* session.id — with conversation.id winning. These spans carry an
       internal conversation id there (e.g. "session-<uuid>") while the
       platform session id lives at session.id ("dsh-web-*"), so the mapper
       would filter every trace out. Promote session.id over it.
    2. invoke_agent prompts: user/assistant text sits at gen_ai.task.input/
       output (and agentcore.invocation.*), none of which the mapper reads.
       Synthesize the gen_ai.input/output.messages attributes it does read.
    3. system_prompt: lives at gen_ai.system_instructions (JSON blocks);
       transcript.py's fallback reads a flat attributes["system_prompt"].
    """
    attrs = span.get("attributes")
    if not isinstance(attrs, dict):
        return
    sid = attrs.get("session.id")
    if sid:
        attrs["gen_ai.conversation.id"] = sid

    if attrs.get("gen_ai.operation.name") == "invoke_agent":
        user = attrs.get("gen_ai.task.input") or attrs.get("agentcore.invocation.user_prompt")
        resp = attrs.get("gen_ai.task.output") or attrs.get("agentcore.invocation.agent_response")
        if user and not attrs.get("gen_ai.input.messages"):
            attrs["gen_ai.input.messages"] = json.dumps(
                [{"role": "user", "parts": [{"type": "text", "content": str(user)}]}],
                ensure_ascii=False)
        if resp and not attrs.get("gen_ai.output.messages"):
            attrs["gen_ai.output.messages"] = json.dumps(
                [{"role": "assistant", "parts": [{"type": "text", "content": str(resp)}]}],
                ensure_ascii=False)

    if not attrs.get("system_prompt") and attrs.get("gen_ai.system_instructions"):
        raw = attrs["gen_ai.system_instructions"]
        try:
            blocks = json.loads(raw) if isinstance(raw, str) else raw
            text = "\n".join(
                str(b.get("content", "")) for b in blocks
                if isinstance(b, dict) and b.get("content")
            ) if isinstance(blocks, list) else str(raw)
        except (json.JSONDecodeError, TypeError):
            text = str(raw)
        if text:
            attrs["system_prompt"] = text


def _fetch_central_session_records(log_group: str, session_id: str, lookback_days: int,
                                   scope_filter: str, service_filter: str,
                                   log_stream: str = "") -> list[dict]:
    """All raw span records for one session from a (possibly shared) span group."""
    from discovery import build_span_filters, escape_insights_literal

    query = (
        'fields @message'
        f' | filter attributes.session.id = "{escape_insights_literal(session_id)}"'
        f'{build_span_filters(scope_filter, service_filter, log_stream)}'
        " | sort @timestamp asc | limit 10000"
    )
    rows = _run_insights_query(log_group, query, lookback_days)
    records = []
    for row in rows:
        for field in row:
            if field.get("field") == "@message":
                try:
                    records.append(json.loads(field["value"]))
                except (json.JSONDecodeError, KeyError):
                    logger.warning("central spans: unparseable @message skipped")
    return records


def _session_from_records(log_group: str, session_id: str, records: list[dict]):
    """Raw span records -> (Session, adapted span dicts). Raises SessionNotFoundError.

    Deliberately free of patches.LAST_PARSED_SPANS bookkeeping: that global is
    documented (patches.py:54-56) as safe only because sessions are evaluated
    sequentially, and the dataset path calls this from up to RUN_TTL_BATCH tasks
    at once. Callers that own the global (the observability path) set it around
    this call; callers that don't, don't.
    """
    from strands_evals.mappers.cloudwatch_parser import CloudWatchLogsParser
    from strands_evals.mappers import utils as mapper_utils
    from strands_evals.providers.exceptions import SessionNotFoundError

    span_dicts = CloudWatchLogsParser(records).parse()
    for span in span_dicts:
        _adapt_central_span(span)
    if not span_dicts:
        raise SessionNotFoundError(
            f"{log_group}: no normalizable spans for session_id='{session_id}'")

    # module attribute, not from-import: picks up patches._detect_with_dict_guard
    mapper = mapper_utils.detect_otel_mapper(span_dicts)
    session = mapper.map_to_session(span_dicts, session_id)
    if not session.traces:
        raise SessionNotFoundError(
            f"{log_group}: spans found for session_id='{session_id}' "
            "but none were convertible")
    return session, span_dicts


def _central_evaluation_data(agent: dict, src: dict, session_id: str,
                             lookback_days: int) -> tuple[dict, list[dict]]:
    """get_evaluation_data over a configured span group (e.g. aws/spans).

    CloudWatchProvider can't serve this: it queries the runtime log group for
    body-format event records (empty for these agents) and treats aws/spans as
    a hierarchy side-channel only. Here the span group is the *primary* source:
    fetch → CloudWatchLogsParser → shape adaptation → auto-detected mapper —
    the same pipeline the provider runs, minus the empty-group dead end.
    """
    import patches
    from strands_evals.types.evaluation import TaskOutput
    from strands_evals.types.trace import AgentInvocationSpan

    cfg = _cfg_with_fallback(agent, _effective_span_group(agent, src), src)

    patches.LAST_PARSED_SPANS = []
    session, span_dicts, span_origin = fetch_session_with_origin(
        cfg, session_id, lookback_days)
    if span_origin != ORIGIN_CENTRAL:
        logger.info("session '%s' 的 span 不在配置的共享组里，读的是回退源（%s）",
                    session_id, span_origin)
    # keep the shared slot consistent with the CloudWatch path (transcript.py's
    # system_prompt fallback reads it) even when parse() isn't patched
    patches.LAST_PARSED_SPANS = span_dicts

    output = next(
        (sp.agent_response
         for tr in reversed(session.traces)
         for sp in reversed(tr.spans)
         if isinstance(sp, AgentInvocationSpan) and sp.agent_response),
        "",
    )
    return TaskOutput(output=output, trajectory=session), span_dicts


def resolve_span_config(agent: dict) -> dict | None:
    """Flatten where this agent's spans live into a plain, reusable dict.

    Returns {log_group, scope_filter, service_filter}, or None when the agent
    has no readable span group at all (no runtime log group AND no override) —
    callers degrade rather than raise, because "this agent has no observability"
    is a legitimate state, not an error.

    Resolved **once per agent** by the dataset path so a per-case fetch loop
    doesn't re-read the span_source config out of DynamoDB for every case.
    """
    try:
        src = resolve_span_source(agent) or {}
    except Exception:
        logger.info("span_source lookup failed for '%s'; treating as unset",
                    agent.get("agent_name", "?"), exc_info=True)
        src = {}
    log_group = src.get("log_group") or agent.get("log_group")
    if not log_group:
        return None
    return _cfg_with_fallback(agent, log_group, src)


def _read_span_records(plan: dict, session_id: str, lookback_days: int,
                       low_latency: bool) -> list[dict]:
    """One read attempt: the raw span records this plan's group holds for the session.

    `low_latency=True` swaps **only the fetch** for `filter_log_events`
    (discovery.filter_span_records): everything after it — parser, shape
    adaptation, mapper — is the same `_session_from_records` call, so the two
    readings differ in latency and nothing else. The dataset path needs it
    because its whole budget is 14 s while Insights takes 78~116 s to make the
    same bytes queryable; the observability path does **not** pass it and keeps
    the Insights read verbatim — it isn't on a per-case clock, and it depends on
    the scope/service narrowing.

    低延迟读法在**回退**这一步照样可用：`filter_log_events` 支持 `logStreamNames`，
    所以「只读 spans 流」这个必需的收窄不需要 Insights（scope/service 过滤才需要）。
    """
    scope_filter, service_filter = plan.get("scope_filter", ""), plan.get("service_filter", "")
    log_stream = plan.get("log_stream", "")
    if low_latency and not (scope_filter or service_filter):
        return filter_span_records(plan["log_group"], session_id, lookback_days,
                                   [log_stream] if log_stream else None)
    # 配了 scope/service 过滤 = 这是个**共享** span 组（aws/spans 混着所有
    # instrumented service 的 span）。那两个过滤器只有 Insights 能应用；在本地
    # 复现它们得猜 `resource.attributes.service.name` 在原始记录里的键形状，而猜
    # 错的方向是**把别的 agent 的 span 当成本次证据**——比慢一个数量级坏得多。
    # 所以这里如实走回慢读法（与修复前同刑，不是新的退化），并留一行日志说明。
    if low_latency:
        logger.info("span 源配了过滤条件（共享组），低延迟读法不适用；"
                    "本次仍走 Insights：%s", plan["log_group"])
    return _fetch_central_session_records(plan["log_group"], session_id, lookback_days,
                                          scope_filter, service_filter, log_stream)


def fetch_session_with_origin(cfg: dict, session_id: str, lookback_days: int = 1,
                              low_latency: bool = False):
    """One session's real trace + where it came from: (Session, span_dicts, span_origin).

    Tries `read_plans(cfg)` in order and **short-circuits**: the fallback group is
    only read when the primary holds nothing for this session, so the common case
    still costs exactly one read. Raises SessionNotFoundError when no plan has it.
    Unlike get_evaluation_data this touches **no** module-level state, so it is
    safe to call concurrently (the dataset path runs RUN_TTL_BATCH cases at once).

    ⚠️ Enumerate by query, never by describe-log-groups: a runtime group that
    demonstrably holds spans can still report storedBytes=0 (live example
    2026-08-26: tauairline_airlineagent_v3-EXAMPLE0002-DEFAULT).
    """
    from strands_evals.providers.exceptions import SessionNotFoundError

    plans = read_plans(cfg)
    for plan in plans:
        records = _read_span_records(plan, session_id, lookback_days, low_latency)
        if not records:
            continue
        try:
            session, span_dicts = _session_from_records(plan["log_group"], session_id, records)
        except SessionNotFoundError:
            # 这个组里有带这个 sid 的行，但没有一条能归一成 span（例如某条日志流的
            # 普通日志正好提到了 sid）。与「这个组里没有」同档：继续试下一个组。
            if plan is plans[-1]:
                raise
            continue
        return session, span_dicts, plan["span_origin"]
    raise SessionNotFoundError(
        f"{' / '.join(p['log_group'] for p in plans)}: "
        f"no spans found for session_id='{session_id}'")


def fetch_session(cfg: dict, session_id: str, lookback_days: int = 1,
                  low_latency: bool = False):
    """`fetch_session_with_origin` 的两元组门面：(Session, span_dicts)。

    取数逻辑只有一份（回退、短路、限流名都在那边），这里给不关心来源的调用方
    （dataset 路径取工具证据）用。
    """
    session, span_dicts, _origin = fetch_session_with_origin(
        cfg, session_id, lookback_days, low_latency)
    return session, span_dicts


def content_event_predicate(name: str) -> str:
    r"""一个 inline event 名 → 「这条 span 带这个事件」的 Insights 判据。

    现网 span 记录是**紧凑** JSON（`…,"name":"gen_ai.choice","attributes":{…}`，键与值之间
    没有空格 —— 2026-09-08 对 fable5 那批 44 条记录实测：含 `"name":"gen_ai.choice"` 的 25
    条，含带空格写法 `"name": "gen_ai.choice"` 的 **0** 条）。事件名里的 `.` 转义成 `\.`：
    正则里不转义的 `.` 能匹配任意字符，虽然对这几个字面量无害，但判据不该靠「无害」立着。
    """
    lit = name.replace(".", "\\.")
    return f'@message like /"name":"{lit}"/'


def build_content_predicate() -> str:
    """「这条 span 带对话内容」的 Insights 判据（attributes **或** inline events）。

    两派埋点合起来才是完整判据：`CONTENT_SOURCES["attrs"]` 走属性（dsh 派 +
    `_adapt_central_span` 合成的来源），`CONTENT_SOURCES["events"]` 走 inline events
    （fable5 派）。任一命中即算有内容 —— 与属性侧本来就是六个键的「或」同一个口径。

    判据**只从 CONTENT_SOURCES 生成**：名字列表另抄一份的话，加了名字而判据没跟上
    （或反过来）不会有任何东西红。
    """
    terms = [f"ispresent(attributes.{a})" for a in CONTENT_SOURCES["attrs"]]
    terms += [content_event_predicate(n) for n in CONTENT_SOURCES["events"]]
    return " or ".join(terms)


def build_agent_side_filter(service_filter: str = "") -> str:
    """Agent 侧 span 的 `| filter` 子句（只用上报数据评估，ADR-0019）。

    Agent 配了 span 源的 service_filter ⇒ 用等号点名（与 build_span_filters 同一条
    子句，最准）；没配 ⇒ 排除平台自家的 service.name。`not ispresent(...)` 一并放进来：
    没写 resource.attributes.service.name 的 span 不可能是平台自家发的（botocore 插桩
    恒带），按 Agent 侧算 —— 漏判方向是「把 Agent 的 span 当成没有」，那会把用例误标
    no_trace，比误把平台 span 当 Agent 的要好，但也不该白丢。
    """
    if service_filter:
        return build_span_filters("", service_filter)
    lit = escape_insights_literal(PLATFORM_SERVICE_NAME)
    return (' | filter not ispresent(resource.attributes.service.name)'
            f' or resource.attributes.service.name != "{lit}"')


def build_trace_check_query(session_ids: list[str], service_filter: str = "",
                            log_stream: str = "") -> str:
    """一批会话 → 「每个会话 × service 有几条 span、几条带对话内容」的 Insights 查询。

    `log_stream` 非空时加 `@logStream` 限定（build_span_filters 同一条子句）：runtime
    专属组的 stdout / otel-rt-logs 流里的 JSON 行也可能带 attributes.session.id，不限
    就是把应用日志数进 `spans`。

    「带对话内容」的判据是 `build_content_predicate()` —— attributes **或** inline
    events，两派埋点各走一条（见 CONTENT_ATTRS / CONTENT_EVENT_NAMES 上方那段）。
    """
    sids = ", ".join(f'"{escape_insights_literal(s)}"' for s in session_ids)
    content = build_content_predicate()
    return (
        "fields attributes.session.id as sid, resource.attributes.service.name as svc,"
        f" ({content}) as has_content"
        f" | filter attributes.session.id in [{sids}]"
        f"{build_agent_side_filter(service_filter)}"
        f"{build_span_filters('', '', log_stream)}"
        " | stats count(*) as spans, sum(has_content) as content_spans by sid, svc"
    )


def check_agent_traces(session_ids: list[str], lookback_days: int = 1,
                       plan: dict | None = None) -> dict[str, dict]:
    """核对一批会话在**一个** span 组里有没有 **Agent 侧、带对话内容** 的 span。

    `plan` = `read_plans(cfg, spans_only=True)` 的一项（{log_group, service_filter,
    log_stream, …}）。这里**不再自己判**「哪个组该限哪条流」：那条规则只住在
    `read_plans` 里（收口前这里按组名前缀判、正典按结构判，对没配 span 源的 Agent
    两者不同集）。不给 plan ⇒ 退回共享组不限流（探针 / 手工核对用）。
    `plan["scope_filter"]` 在这条路上**不参与**：核对查询里从来没有 scope.name 子句
    （共享组靠 service.name 就够点名一个 agent），列在 plan 里是给取数那条路用的。

    返回 {session_id: {"spans": n, "content_spans": m, "services": [...]}}；查无一条
    Agent 侧 span 的会话**不出现**在结果里（调用方据此判 no_span）。查询本身的异常
    原样上抛（调用方分 no_span_source / fetch_error）。

    与 fetch_session 的分工：那条路按会话取全量记录再过 parser/mapper（工具证据、
    批 2 的对话还原都要它）；这里只回答「有没有、有没有内容」，一次查询核对一批
    （TRACE_CHECK_BATCH 个），因为核对发生在环节结束后、要等 Insights 可见性
    （78~116 s，见 discovery.py 读法注释），逐会话各查一遍会把等待乘上用例数。
    """
    plan = plan or {}
    log_group = plan.get("log_group") or CENTRAL_SPANS_LOG_GROUP
    service_filter = plan.get("service_filter", "")
    log_stream = plan.get("log_stream", "")
    out: dict[str, dict] = {}
    for i in range(0, len(session_ids), TRACE_CHECK_BATCH):
        chunk = session_ids[i:i + TRACE_CHECK_BATCH]
        rows = _run_insights_query(
            log_group, build_trace_check_query(chunk, service_filter, log_stream), lookback_days)
        for row in rows:
            fields = {f["field"]: f["value"] for f in row}
            sid = fields.get("sid")
            if not sid:
                continue
            slot = out.setdefault(sid, {"spans": 0, "content_spans": 0, "services": []})
            slot["spans"] += int(float(fields.get("spans") or 0))
            slot["content_spans"] += int(float(fields.get("content_spans") or 0))
            svc = fields.get("svc")
            if svc and svc not in slot["services"]:
                slot["services"].append(svc)
    return out


def build_provider(agent: dict, lookback_days: int):
    """Construct the SDK TraceProvider this agent's traces live behind."""
    from strands_evals.providers import CloudWatchProvider

    return CloudWatchProvider(
        log_group=agent["log_group"], region=REGION, lookback_days=lookback_days
    )


def get_evaluation_data(agent: dict, session_id: str, lookback_days: int) -> tuple[dict, list[dict]]:
    """Pull one session. Returns (evaluation_data, raw_span_dicts).

    The raw spans are what metrics.py aggregates. They come from the CloudWatch
    parser patch's global; we clear it first so a provider error can't leave
    the previous session's spans standing in for this one's. For agents with a
    span_source override the spans are read from the configured (centralized)
    span group instead of the runtime log group.
    """
    import patches

    src = resolve_span_source(agent)
    if src is not None:
        return _central_evaluation_data(agent, src, session_id, lookback_days)

    provider = build_provider(agent, lookback_days)
    patches.LAST_PARSED_SPANS = []
    data = provider.get_evaluation_data(session_id)
    return data, patches.LAST_PARSED_SPANS


def merge_sessions(primary: list[dict], fallback: list[dict],
                   max_sessions: int) -> list[dict]:
    """两个 span 组各自的会话表 → 一张按 session.id 去重的表，新→旧，截到上限。

    同一个 session.id 出现在两处时**主源那份留下**（含它的 span_origin / span_count）：
    重复不是异常，一个 agent 换过埋点方式（自带 collector ↔ AgentCore 默认目的地）
    就会在同一个 lookback 窗里两处都有 span，把它算两次 = 会话数虚高一倍。
    """
    merged: dict[str, dict] = {}
    for sess in list(primary) + list(fallback):
        sid = sess.get("session_id")
        if not sid or sid in merged:
            continue
        merged[sid] = sess
    ordered = sorted(merged.values(), key=lambda x: int(x.get("last_ts") or 0), reverse=True)
    return ordered[:max_sessions] if max_sessions else ordered


def list_sessions_from_cfg(cfg: dict, lookback_days: int, max_sessions: int,
                           include_test: bool = False) -> list[dict]:
    """Recent sessions for a resolved span config; each row carries `span_origin`.

    主源先查，**只有它一条都没查到**才查回退源（`read_plans` 的第二项 = 专属
    runtime 组的 `spans` 流），然后 `merge_sessions` 去重 —— 不每次双查。
    """
    plans = read_plans(cfg)
    primary = plans[0]
    rows = list_recent_sessions(primary["log_group"], lookback_days, max_sessions,
                                include_test,
                                scope_filter=primary["scope_filter"],
                                service_filter=primary["service_filter"],
                                log_stream=primary["log_stream"])
    for sess in rows:
        sess["span_origin"] = primary["span_origin"]
    if rows or len(plans) == 1:
        return rows

    extra: list[dict] = []
    for plan in plans[1:]:
        try:
            found = list_recent_sessions(plan["log_group"], lookback_days, max_sessions,
                                         include_test,
                                         scope_filter=plan["scope_filter"],
                                         service_filter=plan["service_filter"],
                                         log_stream=plan["log_stream"])
        except Exception:
            # 回退源查不动（组不存在 / 权限 / 超时）不能把主源那句「这个 agent 没有
            # 会话」变成 500：回退本来是补救，补救失败就退回补救前的读数。
            logger.info("回退 span 源枚举失败：%s", plan["log_group"], exc_info=True)
            continue
        for sess in found:
            sess["span_origin"] = plan["span_origin"]
        extra += found
    return merge_sessions(rows, extra, max_sessions)


def list_sessions(agent: dict, lookback_days: int, max_sessions: int,
                  include_test: bool = False) -> list[dict]:
    """Recent session ids for an agent, newest first.

    Same return shape all backends: [{session_id, last_ts, span_count,
    span_origin}]. With a span_source override the enumeration runs against the
    configured span group narrowed by its scope/service filters, and falls back
    to the agent's own runtime log group (`spans` stream) when that comes back
    empty; without an override it reads the runtime log group directly.
    """
    src = resolve_span_source(agent)
    if src is not None:
        # 只为保留那句可操作的报错（过滤器-only 配置 + 没有 runtime 组）。
        _effective_span_group(agent, src)
    cfg = resolve_span_config(agent)
    if cfg is None:
        # 没有 runtime 日志组、也没有 span 源 = 这个 agent 没有可读的观测源。
        # 「没有会话」是它的真实状态，不是错误（调用方按空表降级）。
        return []
    return list_sessions_from_cfg(cfg, lookback_days, max_sessions, include_test)


def _effective_span_group(agent: dict, src: dict) -> str:
    """The log group a span_source override reads from.

    A filters-only override narrows the agent's own runtime group — which only
    makes sense if that group exists. Fail with an actionable message instead
    of handing None to Logs Insights.
    """
    log_group = src.get("log_group") or agent.get("log_group")
    if not log_group:
        raise ValueError(
            f"agent '{agent.get('agent_name', '?')}' 的 span_source 只配了过滤条件"
            "，但该 Agent 没有 runtime 日志组可过滤——请在 span_source 里明确 "
            f"log_group（例如 {CENTRAL_SPANS_LOG_GROUP}）。")
    return log_group


# ---------- 只用上报数据评估（ADR-0019 批 2）：从 span 还原评分输入 ----------

def _plain_text(value) -> str:
    """把 mapper 交出来的「回复」还原成干净正文。

    GenericGenAISessionMapper 从 `gen_ai.choice` 事件取 agent_response 时是
    `str(event_attrs["message"])`（SDK generic_gen_ai_session_mapper.py:348）——
    形如 `[{'text': '…'}]` 的字符串，不是正文（toolevidence 模块开头那段「为什么是
    嫁接不是替换」讲的就是它）。这里只认两种可解析形状：JSON 或 Python 字面量的
    list[dict]，取每个 dict 的 text / content 拼起来；解析不出就原样返回 —— 宁可把
    一段 JSON 交给 judge，也不能把一段正文误当结构丢掉。
    """
    text = value if isinstance(value, str) else str(value or "")
    stripped = text.strip()
    if not (stripped.startswith("[") and stripped.endswith("]")):
        return text
    try:
        parsed = json.loads(stripped)
    except (json.JSONDecodeError, TypeError):
        import ast
        try:
            parsed = ast.literal_eval(stripped)
        except (ValueError, SyntaxError, MemoryError, RecursionError):
            return text
    if not isinstance(parsed, list) or not parsed:
        return text
    parts = []
    for item in parsed:
        if not isinstance(item, dict):
            return text
        piece = item.get("text") if isinstance(item.get("text"), str) else item.get("content")
        if isinstance(piece, str) and piece:
            parts.append(piece)
    return "\n".join(parts) if parts else text


def scoring_input_from_session(session) -> dict | None:
    """一条真 Session（fetch_session 的返回）→ 回归用例的评分输入；没有最终回复 ⇒ None。

    返回 {"output", "turns", "tool_calls", "span_ids"}：
    - output：最终 assistant 回复 = **结束最晚**的、agent_response 非空的
      AgentInvocationSpan（invoke_agent 是整次调用最外层的 span、最后结束 ——
      与 toolevidence.is_complete 同一条判据；aws/spans 现网 dsh 系会话的它带
      gen_ai.output.messages，`_adapt_central_span` 由 gen_ai.task.output 合成）；
    - turns：逐轮消息 [{"role": "user"|"assistant", "message", "span_id"}]，
      顺序与 transcript.build_transcript 的时间线一致；
    - tool_calls：工具调用 [{"name", "arguments", "result", "error", "duration_s",
      "span_id"}] —— 就是 transcript 时间线里 type == "tool" 的事件，不另起一套形状；
    - span_ids：贡献了以上内容的 span id（去重、按时间线序），报告页据此回链原 span。

    None 的含义只有一个：Agent 侧有 span，但**还原不出最终回复**（只有元数据 /
    只有 chat 与工具 span、invoke_agent 没露面）。上层记 no_trace 原因 `no_content`
    （复用批 1 的枚举，不另加一种）。output 不从 turns 末条取而是直接扫 span：
    build_transcript 有 MAX_EVENTS 截断与同文折叠，长会话的末条 assistant 可能不在
    时间线里，而「有最终回复」这件事不该被展示层的截断左右。
    """
    import transcript
    from strands_evals.types.trace import AgentInvocationSpan

    candidates = [sp for trace in session.traces for sp in trace.spans
                  if isinstance(sp, AgentInvocationSpan) and str(sp.agent_response or "").strip()]
    if not candidates:
        return None
    # 结束时间缺失的排最前（排不到「最晚」）；同刻按出现顺序取后者
    final = max(candidates, key=lambda sp: (sp.span_info.end_time is not None,
                                            sp.span_info.end_time.timestamp()
                                            if sp.span_info.end_time else 0))
    output = _plain_text(final.agent_response)
    if not output.strip():
        return None

    events = transcript.build_transcript(session).get("events") or []
    turns = [{"role": ev["type"], "message": _plain_text(ev.get("text", "")),
              "span_id": ev.get("span_id")}
             for ev in events if ev["type"] in ("user", "assistant")]
    tool_calls = [{"name": ev.get("name"), "arguments": ev.get("arguments"),
                   "result": ev.get("result"), "error": ev.get("error"),
                   "duration_s": ev.get("duration_s"), "span_id": ev.get("span_id")}
                  for ev in events if ev["type"] == "tool"]
    span_ids = list(dict.fromkeys(ev["span_id"] for ev in events if ev.get("span_id")))
    fsid = final.span_info.span_id
    if fsid and fsid not in span_ids:
        span_ids.append(fsid)
    return {"output": output, "turns": turns, "tool_calls": tool_calls, "span_ids": span_ids}


# ---------- 只用上报数据评估（ADR-0019 批 2 / 批 3）：评分阶段按会话取数与多轮还原 ----------


def fetch_scoring_session(cfg: dict | None, session_id: str, sources: list[str]):
    """核对已确认该会话有内容 span 之后，按会话取全量记录用于评分：
    (Session, None) 或 (None, no_trace 原因键 "no_content" / "fetch_error")。永不抛。

    **一次、不退避**：核对那步已经等到内容 span 在 Insights 里可见（135 s 预算在那里付过），
    这里再退避就是同一笔等待付两次。按核对真查过的日志组（`sources`）顺序试：主 span 组
    （aws/spans 这类共享组只走 Insights 且带 cfg 的 scope/service 过滤 —— 同一 session.id
    下还有平台自家的 InvokeAgentRuntime span，用 filter_log_events 拉全组会把它一起捞进来）；
    回退的 runtime 专属组只认 spans 流、走低延迟读法（filter_log_events）。
    全部 SessionNotFound ⇒ no_content（核对说有、取数说无，只能是内容还原不出）；查询本身
    出错 ⇒ fetch_error。回归（testrun._fetch_scoring_session）与红队（redteam 批 3）共用这一份。
    """
    from strands_evals.providers.exceptions import SessionNotFoundError

    cfg = cfg or {}
    groups = [g for g in (sources or []) if g] or ([cfg["log_group"]] if cfg.get("log_group") else [])
    # 「这个组该带哪些过滤、限哪条流」一律问正典（read_plans），不在这里按 cfg 的字段
    # 同一性再判一遍。主源那一趟仍原样把 cfg 交给 fetch_session —— 它带着
    # fallback_log_group，所以那一趟内部照旧按 read_plans 顺序试并短路。
    by_group = {p["log_group"]: p for p in (read_plans(cfg) if cfg.get("log_group") else [])}
    for group in groups:
        if group == cfg.get("log_group"):
            gcfg = cfg
        else:
            gcfg = by_group.get(group) or {"log_group": group, "scope_filter": "",
                                           "service_filter": "", "log_stream": ""}
        low_latency = (group != CENTRAL_SPANS_LOG_GROUP
                       and not (gcfg.get("scope_filter") or gcfg.get("service_filter")))
        try:
            session, _spans = fetch_session(gcfg, session_id, 1, low_latency)
            return session, None
        except SessionNotFoundError:
            continue
        except Exception:
            logger.exception("trace scoring fetch failed: %s @ %s", session_id, group)
            return None, "fetch_error"
    return None, "no_content"


def invocation_turns(session) -> list[dict]:
    """一条真 Session → 逐轮 [{"role": "user"|"assistant", "message", "span_id"}]，**按调用配对**。

    每个 `AgentInvocationSpan` 出一对（user_prompt → user、agent_response → assistant），按
    span 的 (start_time, end_time) 排序；两侧都空的 span 不出轮次。

    为什么不用 `transcript.build_transcript` 的扁平时间线（`scoring_input_from_session` 的
    `turns` 走的是那条）：那条把 assistant 锚在 span **结束**时刻，而被测 Agent 的下一轮
    invoke_agent 可能在上一轮的回复 span 结束**之前**就开始 —— 于是按时刻排序会把轮次穿插成
    「攻击 / 攻击 / 回复 / 回复」。现网实测（2026-09-07，aws/spans，deepseek-harness，09-04 的
    `evaltest-rt-20260904025-9f7ee01d…` 与 `…-2e729f5e…`）两条会话都是 5 轮，扁平时间线各有一处
    穿插（第 5、6 条同为攻击方，第 7、8 条同为被测方）。多轮评分输入的顺序不能被这种重叠左右，
    所以按调用配对。也顺带绕开 build_transcript 的 MAX_EVENTS 截断与同文折叠。
    """
    from strands_evals.types.trace import AgentInvocationSpan

    spans = [sp for trace in session.traces for sp in trace.spans
             if isinstance(sp, AgentInvocationSpan)]

    def order(sp):
        si = sp.span_info
        return (si.start_time.timestamp() if si.start_time else 0.0,
                si.end_time.timestamp() if si.end_time else 0.0)

    turns: list[dict] = []
    for sp in sorted(spans, key=order):
        span_id = sp.span_info.span_id
        for role, raw in (("user", sp.user_prompt), ("assistant", sp.agent_response)):
            text = _plain_text(raw) if raw else ""
            if text.strip():
                turns.append({"role": role, "message": text, "span_id": span_id})
    return turns


def conversation_from_sessions(sessions: list) -> dict | None:
    """多个真 Session（红队一行攻击落过的会话，按轮换顺序）→ 评分用的整段对话；
    **任一**会话一轮都还原不出 ⇒ None（上层记 no_trace 原因 `no_content`，复用批 1 枚举）。
    为什么不肯把缺一段的对话交出去：一行攻击的会话缺一段 = judge 看到的是半场对话，
    而攻破往往就发生在缺掉的那一轮；口径与「全部会话都有内容 span 才算 ok」同源。

    返回 {"conversation", "replies", "span_ids"}：
    - conversation：`[{"role": "attacker"|"target", "content": …}, …]` —— 与 SDK 攻击循环写进
      `AttackResult.conversation` 的形状相同（strategies/*/__init__.py 的
      `conversation.append({"role": "attacker"|"target", …})`），让 AttackSuccessEvaluator 无感；
      轮次按 `invocation_turns` 的调用配对（user → attacker、assistant → target），多会话按传入
      顺序拼接（backtrack 轮换出的新会话接在旧会话之后 —— 那就是被测 Agent 真实经历的顺序）；
    - replies：target 侧逐轮正文（与调用返回逐轮对拍用）；
    - span_ids：贡献了轮次的 span id，去重、按会话序再按调用序。
    """
    conversation: list[dict] = []
    replies: list[str] = []
    span_ids: list[str] = []
    for session in sessions:
        if session is None:
            return None
        turns = invocation_turns(session)
        if not turns:
            return None
        for turn in turns:
            role = "attacker" if turn["role"] == "user" else "target"
            conversation.append({"role": role, "content": turn["message"]})
            if role == "target":
                replies.append(turn["message"])
            sid = turn.get("span_id")
            if sid and sid not in span_ids:
                span_ids.append(sid)
    if not conversation:
        return None
    return {"conversation": conversation, "replies": replies, "span_ids": span_ids}
