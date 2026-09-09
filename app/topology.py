"""agent_topology：把近 N 天线上会话的 span 聚合成路径图 —— ADR-0017 D4「路径」卡的数据源。

只读 action。数据源与 agent_status **同一条** Logs Insights 查询（agentstatus.build_status_query，
逐 span 一行）、同一个取数函数（agentstatus._run_insights_query）、同一个行→span 转换
（agentstatus._rows_to_spans），只是 lookback 换成 N 天、并以 include_test=True 拉全（那条
`not like 'evaltest'` 过滤挪到 Python 侧按会话 id 前缀分流 —— 一次查询同时拿到真实 / 评估两类
会话，Logs Insights 慢，不查两次）。会话口径 = 窗内出现过 span 的 `attributes.session.id`
去重数，与 agentstatus._window_metrics 的 `sessions` 逐字同式 ⇒ `live_sessions` == agent_status
的会话数、`nodes[start].count == sessions` 都是构造上成立的同源判据，不是两处各算一遍再对。

评估流量（会话 id 以 `evaltest` 开头：testrun / redteam / probe 三处都这么起名）三档
（include_eval）：None = 自动 —— 真实会话 > 0 用真实（sessions_scope "live"），== 0 时改用评估
会话（"eval_only"），两者都没有 ⇒ 空；True = 两类一起（"live+eval"）；False = 只真实（"live"）。
2026-09-07 实测本账号 32 个 Agent 7 天真实流量全零、deepseek-harness 系只有 evaltest 会话，
自动态就是为了这种账号「路径」卡还能画出图。

节点口径（每会话一条按开始时间排序的节点序列）：
  · start        每会话一次，序列首位；
  · agent        一次 assistant 回合（`invoke_agent*` span）= 一次访问，所有回合归同一个节点；
  · tool:<name>  一次 `execute_tool <name>` span = 一次访问；errors = status ERROR /
                 gen_ai.tool.status ∈ {error, failed, failure}（agentstatus._tool_failed 同一函数）；
  · model:<id>   一次带 gen_ai.request.model 的 `chat*` span = 一次访问；invoke_agent 聚合层
                 虽也带 model 属性，但不出模型节点（那是同一次调用的叠层）；取不到 chat 段就没有模型节点。
边 = 序列内相邻两节点，同一会话内同一条边走几次算几次。top_path = 各会话完整序列里出现最多的
一条（并列取最早出现的），share = 该路径会话数 / 会话数。时延 = span 时长，avg 两位小数、
p95 nearest-rank（agentstatus._p95）。

会话级两件（ADR-0017 D4「点节点右侧列最近 10 个会话 → 报告页」+ 用户 2026-09-07「要能看单个会话
走的那条路」）：每个节点带 recent_sessions（该节点出现过的会话，按该节点在会话里首次出现时刻倒序
≤ 10，逐条 session_id / at / duration_s = 该节点在该会话的总耗时 / failed）；响应顶层带
session_paths（每会话一条完整节点序列 + failed_nodes，按会话开始时刻倒序 ≤ 10）—— 前端「按会话」
高亮就是拿它把图里那条路点亮。两者的会话身份来自 sessions_from_spans(with_meta=True)；直接给
aggregate() 传裸事件列表（没有会话 id）时两者都为空，不编 id。

算不出（无 span 源 / 查询失败 / 行数截断 / 窗内 0 span / 窗内 0 会话）一律 nodes=[]、edges=[]
+ 一句中文 unavailable_reason，其余字段照常；绝不编数。「0 span」与「0 会话」分两句：前者
（含评估流量都没有一条 span）说明 Agent 根本没上报 trace，后者是有 span 但当前 scope 里没有会话。
缓存与 fleet_status 同款：进程内 5 分钟，键 (agent_name, lookback_days, include_eval)，
refresh=True 绕过并覆盖。零写。
"""

import logging
import re
from collections import Counter
from datetime import datetime, timedelta, timezone

import agentstatus
import discovery
import ttlcache
from ttlcache import is_number

logger = logging.getLogger("eval-anything")

DEFAULT_LOOKBACK_DAYS = 7
MAX_LOOKBACK_DAYS = 30
# 每节点 recent_sessions / 顶层 session_paths 各最多几条（ADR-0017 D4「最近 10 个会话」）
RECENT_SESSIONS_LIMIT = 10
CACHE_TTL_SECONDS = ttlcache.DEFAULT_TTL_SECONDS
NO_SPAN_SOURCE = "未配置 span 源"
# 评估流量的会话 id 前缀：**词只有一份** = discovery.EVAL_SESSION_PREFIX（Insights 侧那条
# `not like` 过滤 = discovery.eval_session_filter 也用它）。这里是前缀判法、那边是子串判法，
# 现网 id 一律以它开头 ⇒ 两种判法同集；为什么各留一种，见 discovery.eval_session_filter。
EVAL_SESSION_PREFIX = discovery.EVAL_SESSION_PREFIX
SCOPE_LIVE = "live"
SCOPE_EVAL_ONLY = "eval_only"
SCOPE_LIVE_EVAL = "live+eval"

_NS = 1_000_000_000
# 同一时刻的排序：agent 先于它发起的 model / tool 调用（invoke_agent 与首个 chat 常同毫秒开始）
_KIND_RANK = {"assistant": 0, "model": 1, "tool": 2}
# `<region>.<vendor>.` 或 `<vendor>.` 前缀：点后必须紧跟字母，`gpt-4.1` 这类版本点不算前缀
_MODEL_PREFIX = re.compile(r"^(?:[a-z]{2,6}\.)?[a-z][a-z0-9-]*\.(?=[a-z])")
_MODEL_VERSION_SUFFIX = re.compile(r"-v\d+(?::\d+)?$")
_MODEL_DATE_SUFFIX = re.compile(r"-\d{8}$")

_cache = ttlcache.TtlCache(CACHE_TTL_SECONDS)


# ---------- 模型短名 ----------

def model_short_name(model_id: str) -> str:
    """`us.anthropic.claude-sonnet-4-5-20250929-v1:0` → `claude-sonnet-4-5`。

    三步：去掉 `<region>.<vendor>.` / `<vendor>.` 前缀（点后须紧跟字母，`gpt-4.1` 不动）；
    去掉 `-vN` / `-vN:0` 版本后缀；去掉 `-YYYYMMDD` 日期段。不含这些片段的 id 原样返回。
    """
    s = _MODEL_PREFIX.sub("", model_id or "", count=1)
    s = _MODEL_VERSION_SUFFIX.sub("", s, count=1)
    s = _MODEL_DATE_SUFFIX.sub("", s, count=1)
    return s or model_id


# ---------- span → 会话事件 ----------

def _duration_s(span: dict) -> float | None:
    t0, t1 = span.get("start_time"), span.get("end_time")
    if not t0 or not t1 or t1 < t0:
        return None
    return (t1 - t0) / _NS


def _span_failed(span: dict) -> bool:
    return str((span.get("status") or {}).get("code", "")).upper() == "ERROR"


def _span_event(span: dict) -> dict | None:
    """一条 span → transcript 形状的事件（type assistant / tool / model），不相关的 span 返回 None。

    多带一个 at_ns（span 开始时刻，纳秒）：recent_sessions 的 `at` = 该节点在该会话里首次出现时刻。
    """
    name = span.get("name", "") or ""
    attrs = span.get("attributes") or {}
    at = span.get("start_time")
    if name.startswith("invoke_agent"):
        return {"type": "assistant", "duration_s": _duration_s(span), "at_ns": at,
                "error": "status ERROR" if _span_failed(span) else None}
    if name.startswith("execute_tool"):
        tool_name = name[len("execute_tool"):].strip() or "?"
        return {"type": "tool", "name": tool_name, "duration_s": _duration_s(span), "at_ns": at,
                "error": "tool failed" if agentstatus._tool_failed(span) else None}
    if name.startswith("chat") and attrs.get("gen_ai.request.model"):
        return {"type": "model", "model": str(attrs["gen_ai.request.model"]),
                "duration_s": _duration_s(span), "at_ns": at,
                "error": "status ERROR" if _span_failed(span) else None}
    return None


def sessions_from_spans(spans: list[dict], *, with_meta: bool = False):
    """agent_status 那条查询的 span → 每会话一列按开始时间排序的事件；会话按首个 span 时间升序。

    没有 assistant / tool / model 事件的会话（只有别的 span）也算一个会话（只剩 start 节点）：
    会话口径必须与 agentstatus._window_metrics 的 `sessions` 完全一致。
    with_meta=True 时返回 (sessions, meta)，meta 与 sessions 同序同长，每项
    {"session_id", "at_ns"}（at_ns = 该会话首个 span 的开始时刻）—— aggregate() 拿它给
    recent_sessions / session_paths 标会话身份。
    """
    by_sid: dict[str, list[tuple[int, int, dict]]] = {}
    first_seen: dict[str, int] = {}
    for s in spans:
        sid = (s.get("attributes") or {}).get("session.id")
        if not sid:
            continue
        t0 = s.get("start_time") or 0
        first_seen[sid] = min(first_seen.get(sid, t0), t0)
        bucket = by_sid.setdefault(sid, [])
        ev = _span_event(s)
        if ev is not None:
            bucket.append((t0, _KIND_RANK[ev["type"]], ev))
    out, meta = [], []
    for sid in sorted(by_sid, key=lambda k: (first_seen[k], k)):
        out.append([ev for _, _, ev in sorted(by_sid[sid], key=lambda x: (x[0], x[1]))])
        meta.append({"session_id": sid, "at_ns": first_seen[sid]})
    return (out, meta) if with_meta else out


# ---------- 会话事件 → 路径图 ----------

def _node_of(ev: dict) -> tuple[str, str, str] | None:
    """事件 → (id, kind, label)；user 事件不成节点（start 已代表会话入口）。"""
    t = ev.get("type")
    if t == "assistant":
        return "agent", "agent", "agent"
    if t == "tool":
        name = str(ev.get("name") or "?")
        return f"tool:{name}", "tool", name
    if t == "model":
        mid = str(ev.get("model") or "")
        if not mid:
            return None
        return f"model:{mid}", "model", model_short_name(mid)
    return None


def _round(v: float | None) -> float | None:
    return None if v is None else round(v, 2)


def _fmt_ns(ns) -> str | None:
    """纳秒时间戳 → ISO UTC 秒级（与 window.from/to 同格式）；None ⇒ None。"""
    if ns is None:
        return None
    return datetime.fromtimestamp(ns / _NS, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def aggregate(sessions: list[list[dict]], meta: list[dict] | None = None) -> dict:
    """每会话一列 transcript 形状事件 → {sessions, nodes, edges, top_path, slowest, session_paths}。

    事件字段：type ∈ {user, assistant, tool, model}；tool 带 name / duration_s / error；
    model 带 model / duration_s / error；assistant 带 duration_s / error（可缺）；at_ns 可缺。
    meta 与 sessions 同序同长（sessions_from_spans(with_meta=True) 的第二项）：每项
    {"session_id", "at_ns"}；不给 ⇒ 节点 recent_sessions 与顶层 session_paths 都为 []（没有会话
    身份就不编）。
    """
    if not sessions:
        return {"sessions": 0, "nodes": [], "edges": [], "top_path": None, "slowest": None,
                "session_paths": []}

    order: list[str] = ["start"]
    meta_of: dict[str, tuple[str, str]] = {"start": ("start", "start")}
    count: Counter = Counter()
    errors: Counter = Counter()
    durations: dict[str, list[float]] = {}
    edges: Counter = Counter()
    paths: Counter = Counter()
    # 会话级：每节点一列 {session_id, at_ns, duration_s, failed}；每会话一条完整路径
    per_node: dict[str, list[dict]] = {}
    session_paths: list[dict] = []

    for i, events in enumerate(sessions):
        m = meta[i] if meta and i < len(meta) else None
        sid = m.get("session_id") if m else None
        sess_at = m.get("at_ns") if m else None
        seq = ["start"]
        count["start"] += 1
        visits: dict[str, dict] = {"start": {"at_ns": sess_at, "duration_s": None, "failed": False}}
        for ev in events:
            node = _node_of(ev)
            if node is None:
                continue
            nid, kind, label = node
            if nid not in meta_of:
                meta_of[nid] = (kind, label)
                order.append(nid)
            seq.append(nid)
            count[nid] += 1
            failed = bool(ev.get("error"))
            if failed:
                errors[nid] += 1
            d = ev.get("duration_s")
            has_d = is_number(d)
            if has_d:
                durations.setdefault(nid, []).append(float(d))
            at = ev.get("at_ns")
            v = visits.get(nid)
            if v is None:
                visits[nid] = {"at_ns": at if at is not None else sess_at,
                               "duration_s": float(d) if has_d else None, "failed": failed}
            else:
                if at is not None and (v["at_ns"] is None or at < v["at_ns"]):
                    v["at_ns"] = at
                if has_d:
                    v["duration_s"] = (v["duration_s"] or 0.0) + float(d)
                v["failed"] = v["failed"] or failed
        for a, b in zip(seq, seq[1:]):
            edges[(a, b)] += 1
        paths[tuple(seq)] += 1
        if sid is not None:
            for nid, v in visits.items():
                per_node.setdefault(nid, []).append({"session_id": sid, **v})
            session_paths.append({"session_id": sid, "at_ns": sess_at, "path": list(seq),
                                  "failed_nodes": sum(1 for v in visits.values() if v["failed"])})

    def _recent(items: list[dict]) -> list[dict]:
        # 倒序：时刻大的在前；同刻按 id 稳定。没有时刻的排最后。
        items.sort(key=lambda x: (x["at_ns"] is None, -(x["at_ns"] or 0), x["session_id"]))
        return items[:RECENT_SESSIONS_LIMIT]

    nodes = []
    for nid in order:
        kind, label = meta_of[nid]
        ds = durations.get(nid) or []
        avg = sum(ds) / len(ds) if ds else None
        recent = [{"session_id": r["session_id"], "at": _fmt_ns(r["at_ns"]),
                   "duration_s": _round(r["duration_s"]), "failed": r["failed"]}
                  for r in _recent(per_node.get(nid) or [])]
        nodes.append({"id": nid, "kind": kind, "label": label, "count": count[nid],
                      "avg_s": _round(avg), "p95_s": _round(agentstatus._p95(ds)),
                      "errors": errors[nid], "recent_sessions": recent})

    top_seq, top_n = paths.most_common(1)[0]
    slow = max((n for n in nodes if n["kind"] != "start" and n["avg_s"] is not None),
               key=lambda n: n["avg_s"], default=None)
    return {
        "sessions": len(sessions),
        "nodes": nodes,
        "edges": [{"from": a, "to": b, "count": n} for (a, b), n in edges.items()],
        "top_path": {"nodes": list(top_seq), "count": top_n,
                     "share": round(top_n / len(sessions), 4)},
        "slowest": {"id": slow["id"], "avg_s": slow["avg_s"]} if slow else None,
        "session_paths": [{"session_id": p["session_id"], "at": _fmt_ns(p["at_ns"]),
                           "path": p["path"], "failed_nodes": p["failed_nodes"]}
                          for p in _recent(session_paths)],
    }


# ---------- 入口 ----------

def _parse_lookback(raw) -> int:
    if raw in (None, ""):
        return DEFAULT_LOOKBACK_DAYS
    try:
        n = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"lookback_days 须为 1–{MAX_LOOKBACK_DAYS} 的整数") from None
    return min(max(n, 1), MAX_LOOKBACK_DAYS)


def _sessions_source(cfg: dict | None) -> str | None:
    if not cfg:
        return None
    parts = [cfg["log_group"]]
    if cfg.get("service_filter"):
        parts.append(f"service={cfg['service_filter']}")
    if cfg.get("scope_filter"):
        parts.append(f"scope={cfg['scope_filter']}")
    return " · ".join(parts)


def _fmt(dt) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def is_eval_session(sid) -> bool:
    """评估流量判据：会话 id 以 `evaltest` 开头（回归测试 / 红队测试 / 探针都这么起名）。"""
    return str(sid or "").startswith(EVAL_SESSION_PREFIX)


def split_spans(spans: list[dict]) -> tuple[list[dict], list[dict]]:
    """一批 span → (真实流量, 评估流量)，按会话 id 前缀分；没有会话 id 的 span 归真实侧
    （sessions_from_spans 反正不计它）。"""
    live, evals = [], []
    for s in spans:
        sid = (s.get("attributes") or {}).get("session.id")
        (evals if is_eval_session(sid) else live).append(s)
    return live, evals


def _session_count(spans: list[dict]) -> int:
    return len({(s.get("attributes") or {}).get("session.id") for s in spans
                if (s.get("attributes") or {}).get("session.id")})


def _compute(agent: dict, lookback_days: int, include_eval: bool | None) -> dict:
    now = agentstatus._now()
    cfg = agentstatus.tracesource.resolve_span_config(agent)
    base = {
        "event": "agent_topology",
        "agent_name": agent.get("agent_name"),
        "lookback_days": lookback_days,
        "window": {"from": _fmt(now - timedelta(days=lookback_days)), "to": _fmt(now)},
        "sessions_source": _sessions_source(cfg),
        "cached": False,
        # 下面四个在算不出时也照给：scope 落回请求的默认档，计数 0 / False（不是 null——
        # 「没查到」与「查到 0」在这几个字段上同义：都是窗内没这类东西）
        "sessions_scope": SCOPE_LIVE_EVAL if include_eval else SCOPE_LIVE,
        "live_sessions": 0,
        "eval_sessions": 0,
        "agent_reports_spans": False,
        # 这批 span 是从哪个组读到的："central" / "runtime_group" / null（没读到）。
        "span_origin": None,
    }
    empty = aggregate([])

    if cfg is None:
        return {**base, **empty, "unavailable_reason": NO_SPAN_SOURCE}
    try:
        rows, span_origin = agentstatus.query_status_rows(cfg, lookback_days,
                                                          include_test=True)
        base["span_origin"] = span_origin
    except Exception as e:  # 超时 / 无日志组 / 权限：都是「这次算不出」，不是 500
        logger.info("agent_topology insights query failed for %s",
                    agent.get("agent_name"), exc_info=True)
        return {**base, **empty, "unavailable_reason": f"Logs Insights 查询失败：{str(e)[:200]}"}
    if len(rows) >= agentstatus.INSIGHTS_ROW_LIMIT:
        return {**base, **empty, "unavailable_reason":
                f"近 {lookback_days} 天 span 行数达到 Logs Insights 单次查询上限 "
                f"{agentstatus.INSIGHTS_ROW_LIMIT}，聚合不完整"}

    cut = int((now - timedelta(days=lookback_days)).timestamp() * _NS)
    spans = [s for s in agentstatus._rows_to_spans(rows) if s["start_time"] >= cut]
    live, evals = split_spans(spans)
    counts = {"live_sessions": _session_count(live), "eval_sessions": _session_count(evals),
              "agent_reports_spans": bool(spans)}
    if not spans:
        return {**base, **empty, **counts, "unavailable_reason":
                f"近 {lookback_days} 天 Agent 未上报任何 span（含评估流量）"}

    # 三档选 scope：显式 True 全拿；显式 False 只真实；自动 = 真实优先、真实为零才退到评估。
    # 只有三种去处 —— 「自动、真实为零、评估也为零」退回 LIVE（空图 + 下面那句没会话），
    # 与「显式 False」同一个去处，不单列一支。
    if include_eval is True:
        scope, chosen = SCOPE_LIVE_EVAL, spans
    elif (include_eval is None and counts["live_sessions"] == 0
            and counts["eval_sessions"] > 0):
        scope, chosen = SCOPE_EVAL_ONLY, evals
    else:
        scope, chosen = SCOPE_LIVE, live
    graph = aggregate(*sessions_from_spans(chosen, with_meta=True))
    if graph["sessions"] == 0:
        return {**base, **empty, **counts, "sessions_scope": scope,
                "unavailable_reason": f"近 {lookback_days} 天没有会话"}
    return {**base, **graph, **counts, "sessions_scope": scope, "unavailable_reason": None}


def agent_topology(agent_name: str, lookback_days=None, refresh: bool = False,
                   include_eval: bool | None = None) -> dict:
    """一个 Agent 近 N 天的路径图（契约见 docs/payload-contract.md `agent_topology` 小节）。

    找不到 Agent / lookback_days 不是整数 抛 ValueError（措辞即错误帧原话）；lookback_days
    省略默认 7，越界收到 [1, 30] 并在响应里回显实际取值。include_eval：None 自动 / True 含
    评估流量 / False 只真实流量（见模块说明）。缓存命中返回原结果 + cached=true。
    """
    days = _parse_lookback(lookback_days)
    agent = agentstatus._find_agent(agent_name)
    if agent is None:
        raise ValueError(f"Agent '{agent_name}' 不存在")
    key = (agent_name, days, include_eval)
    if not refresh:
        hit = _cache.get(key)
        if hit is not None:
            return {**hit[0], "cached": True, "cache_age_s": hit[1]}
    result = _compute(agent, days, include_eval)
    _cache.put(key, result)
    return {**result, "cached": False, "cache_age_s": 0}
