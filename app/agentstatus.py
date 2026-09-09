"""agent_status：一个 Agent 的「现状（观测）」—— ADR-0016 ① 区的数据源。

只读 action。数据源只用已经在拉的那批东西：
  · Logs Insights（discovery._run_insights_query）—— 48h 内该 Agent 的 span 行，
    **一次查询**拉出全部字段后本地聚合出五个数（24h 窗 vs 前一个 24h 窗）；
  · planrun.list_recent_runs —— 最近一次评估结果与连续跌破目标线的告警；
  · plan.list_plans —— 定时表达式 → 下次运行；
  · pricing.get_prices + metrics.compute_session_metrics —— Agent 侧成本口径与
    线上评估环节**同一份**代码。
算不出的数一律 null 并在 unavailable_reason 里写原因，绝不编数。
`hourly`（24 个桶的会话量）从同一批 span 本地分桶得出，不多发查询。
fleetstatus.fleet_status 逐 Agent 复用 build_status（runs / plans 由它一次读好再分发）。

观测层要薄（ADR-0016「更大的角度」）：这里只放「要不要评、要不要改」所需的几个数，
trace 级深挖一律深链 CloudWatch（cloudwatch_url），不重做 APM。
"""

import logging
import math
import re
from datetime import datetime, timedelta, timezone

import catalog
import plan as plan_mod
import planrun
import pricing
import tracesource
import ttlcache
from diagnosis import LOW_SCORE_THRESHOLD
from discovery import (REGION, _run_insights_query, build_span_filters, eval_session_filter,
                       list_agents)
from metrics import compute_session_metrics

logger = logging.getLogger("eval-anything")

WINDOW_HOURS = 24
# Logs Insights 单次查询的结果行上限。达到它 = 聚合不完整 ⇒ 五个数全 null。
INSIGHTS_ROW_LIMIT = 10000
# 告警口径：同一计划最近连续 ≥ ALERT_MIN_STREAK 次 completed run 某评估器都低于
# ALERT_TARGET。目标线取全站唯一的低分线（diagnosis.needs_diagnosis 同一个常量，
# 前端 TREND_TARGET 同值）—— 计划对象今天没有 threshold 字段，有了以后改这里。
ALERT_MIN_STREAK = 3
ALERT_TARGET = LOW_SCORE_THRESHOLD
METRIC_NAMES = ("sessions", "p95_latency_ms", "agent_cost_usd", "blank_rate",
                "tool_failure_rate")
# 告警/最近一次要回看的 run 条数上限（list_recent_runs 本身有 500 条分区读上限）。
RUNS_LOOKBACK = 100
# 进程内缓存 TTL：与 fleet_status / agent_topology / 会话对比同一个数（唯一住所在 ttlcache）。
CACHE_TTL_SECONDS = ttlcache.DEFAULT_TTL_SECONDS

_NS = 1_000_000_000

# build_status 的结果按 (agent_name, window_hours) 缓存。fleet_status 逐 Agent 调
# 的就是 build_status ⇒ 从舰队页点进详情页时那次 8.9s 的 Insights 查询不再重跑。
_cache = ttlcache.TtlCache(CACHE_TTL_SECONDS)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------- agent ----------

def list_known_agents() -> list[dict]:
    """Agent 集合 = discover 的口径：catalog 缓存优先，没有缓存才现扫（不回写缓存）。"""
    cached = catalog.cached_agents()
    return cached["agents"] if cached else list_agents()


def _find_agent(agent_name: str) -> dict | None:
    return next((a for a in list_known_agents() if a.get("agent_name") == agent_name), None)


# ---------- spans → 五个数 ----------

def build_status_query(scope_filter: str = "", service_filter: str = "",
                       include_test: bool = False, log_stream: str = "") -> str:
    """一条 Insights 查询拉出五个数所需的全部字段（逐 span 一行，本地聚合）。

    别名与 `_rows_to_spans` 一一对应。`evaltest` 会话按 list_recent_sessions 的默认
    口径排除（回归测试自己打出来的流量不算线上会话）——**同一份子句** =
    `discovery.eval_session_filter`，不在这里另抄一遍；`include_test=True` 时不加这条
    过滤（discovery.build_session_query 同名开关），给 topology 一次查询拿两类会话后
    在 Python 侧按前缀分流用。默认（False）查询文本逐字不变。按开始时间倒序 + limit：
    真截断时至少知道截断了（行数 == 上限 ⇒ 全 null），而不是悄悄少算旧的一半。
    """
    test_filter = eval_session_filter(include_test)
    return (
        "fields attributes.session.id as sid, traceId as tid, name,"
        " startTimeUnixNano as t0, endTimeUnixNano as t1,"
        " status.code as status_code, scope.name as scope_name,"
        " attributes.gen_ai.tool.status as tool_status,"
        " attributes.gen_ai.request.model as model,"
        " attributes.gen_ai.usage.input_tokens as in_tok,"
        " attributes.gen_ai.usage.prompt_tokens as prompt_tok,"
        " attributes.gen_ai.usage.output_tokens as out_tok,"
        # prompt-cache 两种拼写都投影（metrics._CACHE_*_ATTRS 同一份口径）：漏了它们
        # 就是「输入 36 token」那条 P1 —— Anthropic 式 span 的 input_tokens 只是未缓存份。
        " attributes.gen_ai.usage.cache_read.input_tokens as cr_tok,"
        " attributes.gen_ai.usage.cache_write.input_tokens as cw_tok,"
        " attributes.gen_ai.usage.cache_read_input_tokens as cr_tok2,"
        " attributes.gen_ai.usage.cache_write_input_tokens as cw_tok2,"
        " attributes.gen_ai.response.finish_reasons as finish_reasons"
        " | filter ispresent(attributes.session.id)"
        f"{build_span_filters(scope_filter, service_filter, log_stream)}"
        f"{test_filter}"
        " | sort startTimeUnixNano desc"
        f" | limit {INSIGHTS_ROW_LIMIT}"
    )


def query_status_rows(cfg: dict, lookback_days: int,
                     include_test: bool = False) -> tuple[list[list[dict]], str]:
    """五个数 / 拓扑共用的取数动作：(rows, span_origin)。

    按 `tracesource.read_plans(cfg)` 顺序试，**主源查到就不查回退**（配了 aws/spans
    的 agent 才有第二项；见 tracesource 文件头的两派分流）。查询本身出错照旧上抛 ——
    调用方把它译成「这次算不出」而不是 500。
    """
    plans = tracesource.read_plans(cfg)
    rows: list[list[dict]] = []
    origin = plans[0]["span_origin"]
    for i, plan in enumerate(plans):
        rows = _run_insights_query(
            plan["log_group"],
            build_status_query(plan["scope_filter"], plan["service_filter"],
                               include_test=include_test, log_stream=plan["log_stream"]),
            lookback_days)
        origin = plan["span_origin"]
        if rows or i == len(plans) - 1:
            break
    return rows, origin


def _num_from_insights(value) -> float | None:
    """Insights 的字段全是**字符串** ⇒ 这里是「解析成数字」，不是「判断是不是数字」。

    与 ttlcache.is_number 语义相反（那个是守卫，吃已经是数的值）—— 曾同名叫 _num，
    与 fleetstatus/sessioncompare 的守卫同名不同义，收敛守卫时一并改名钉开。
    """
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _rows_to_spans(rows: list[list[dict]]) -> list[dict]:
    """Insights 结果行 → metrics.compute_session_metrics 吃的 span dict 形状。"""
    spans = []
    for r in rows:
        f = {c["field"]: c["value"] for c in r if "field" in c}
        t0, t1 = _num_from_insights(f.get("t0")), _num_from_insights(f.get("t1"))
        if t0 is None:
            continue
        attrs = {"session.id": f.get("sid", "")}
        if f.get("model"):
            attrs["gen_ai.request.model"] = f["model"]
        for src, dst in (("in_tok", "gen_ai.usage.input_tokens"),
                         ("prompt_tok", "gen_ai.usage.prompt_tokens"),
                         ("out_tok", "gen_ai.usage.output_tokens"),
                         ("cr_tok", "gen_ai.usage.cache_read.input_tokens"),
                         ("cw_tok", "gen_ai.usage.cache_write.input_tokens"),
                         ("cr_tok2", "gen_ai.usage.cache_read_input_tokens"),
                         ("cw_tok2", "gen_ai.usage.cache_write_input_tokens")):
            n = _num_from_insights(f.get(src))
            if n is not None:
                attrs[dst] = int(n)
        if f.get("tool_status"):
            attrs["gen_ai.tool.status"] = f["tool_status"]
        if f.get("finish_reasons"):
            attrs["gen_ai.response.finish_reasons"] = f["finish_reasons"]
        spans.append({
            "name": f.get("name", ""), "trace_id": f.get("tid", ""),
            "start_time": int(t0), "end_time": int(t1) if t1 is not None else 0,
            "scope": {"name": f.get("scope_name", "")},
            "status": {"code": f.get("status_code", "")},
            "attributes": attrs,
        })
    return spans


def _p95(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)]


def _is_blank(span: dict) -> bool:
    """空响应口径（CONTEXT.md「空家族」）：被测 Agent 输出 0 字节 —— trace 上表现为
    finish_reasons 含 content_filtered，或 invoke_agent 的 output_tokens == 0。
    缺 usage 属性 ≠ 0 token：读不到就不算空。

    现网实测（2026-09-03，tauairline_agentfable5 日志组 400 行 span）：Strands tracer
    **不写** gen_ai.response.finish_reasons（0/400 行有此字段），而 invoke_agent 聚合
    span 带 gen_ai.usage.output_tokens（69/69）⇒ 生效的判据实际是后者；finish_reasons
    只对别的采集管道（ADOT/aws/spans）起作用。"""
    attrs = span.get("attributes") or {}
    if "content_filtered" in str(attrs.get("gen_ai.response.finish_reasons", "")):
        return True
    out = attrs.get("gen_ai.usage.output_tokens")
    return isinstance(out, int) and out == 0


def _tool_failed(span: dict) -> bool:
    status = str((span.get("status") or {}).get("code", "")).upper()
    tool_status = str((span.get("attributes") or {}).get("gen_ai.tool.status", "")).lower()
    return status == "ERROR" or tool_status in ("error", "failed", "failure")


def _cost_usd(spans: list[dict], prices: dict) -> tuple[float | None, str | None]:
    """被测 Agent 自身的模型花费（不含 judge）。

    与线上评估环节同一份口径（metrics.compute_session_metrics：provider span →
    strands chat span，绝不叠加 invoke_agent 聚合）。只有 invoke_agent 聚合层带
    usage 时（子 span 未被采集）退到聚合层 —— 仍是单层计数，不重复。
    有任何未定价模型就 null：把已定价那部分报成「成本」会被当成全额读。
    """
    m = compute_session_metrics(spans, prices)
    if m["tokens"]["total"] == 0:
        agg = [s for s in spans if s.get("name", "").startswith("invoke_agent")
               and (s.get("attributes") or {}).get("gen_ai.usage.output_tokens") is not None]
        if agg:
            m = compute_session_metrics(
                [{**s, "name": "chat(aggregate)"} for s in agg], prices)
    unpriced = m["cost"].get("unpriced_models") or []
    if unpriced:
        return None, f"未定价模型：{', '.join(sorted(unpriced))}（可在单价配置里补价）"
    return round(m["cost"]["usd"], 4), None


def _window_metrics(spans: list[dict], prices: dict, label: str) -> tuple[dict, dict, dict]:
    """一个 24h 窗内的五个数 → ({name: value|None}, {name: reason}, counts)。

    counts 是五个数背后的原始计数（sessions / blank_sessions / invoke_sessions /
    tool_calls / tool_failures），fleet_status 拿它们跨 Agent 相加算舰队异常率 ——
    比率不能相加，计数可以。
    """
    values: dict = {}
    reasons: dict = {}
    counts: dict = {"blank_sessions": 0, "invoke_sessions": 0,
                    "tool_calls": 0, "tool_failures": 0}
    sessions = {s["attributes"].get("session.id") for s in spans} - {"", None}
    values["sessions"] = counts["sessions"] = len(sessions)

    bounds: dict[str, list[int]] = {}
    for s in spans:
        tid, t0, t1 = s.get("trace_id"), s["start_time"], s["end_time"]
        if tid and t0 and t1:
            lo, hi = bounds.get(tid, [t0, t1])
            bounds[tid] = [min(lo, t0), max(hi, t1)]
    p95 = _p95([(hi - lo) / _NS for lo, hi in bounds.values()])
    values["p95_latency_ms"] = int(round(p95 * 1000)) if p95 is not None else None
    if p95 is None:
        reasons["p95_latency_ms"] = f"{label}无会话 trace"

    if spans:
        values["agent_cost_usd"], reason = _cost_usd(spans, prices)
        if reason:
            reasons["agent_cost_usd"] = reason
    else:
        values["agent_cost_usd"] = 0.0

    last_invoke: dict[str, dict] = {}
    for s in spans:
        if not s.get("name", "").startswith("invoke_agent"):
            continue
        sid = s["attributes"].get("session.id")
        if sid and (sid not in last_invoke or s["start_time"] > last_invoke[sid]["start_time"]):
            last_invoke[sid] = s
    if last_invoke:
        blank = sum(1 for s in last_invoke.values() if _is_blank(s))
        counts["blank_sessions"], counts["invoke_sessions"] = blank, len(last_invoke)
        values["blank_rate"] = round(blank / len(last_invoke), 4)
    else:
        values["blank_rate"] = None
        reasons["blank_rate"] = (f"{label}无会话" if not sessions
                                 else f"{label}无 invoke_agent span，无法判定空响应")

    tools = [s for s in spans if s.get("name", "").startswith("execute_tool")]
    if tools:
        failed = sum(1 for s in tools if _tool_failed(s))
        counts["tool_calls"], counts["tool_failures"] = len(tools), failed
        values["tool_failure_rate"] = round(failed / len(tools), 4)
    else:
        values["tool_failure_rate"] = None
        reasons["tool_failure_rate"] = (f"{label}无会话" if not sessions
                                        else f"{label}无工具调用")
    return values, reasons, counts


def _null_metrics(reason: str) -> dict:
    # span_origin=None ⇒ 这次没读到任何一个组（没有观测源 / 查询失败 / 截断）。
    # 与 "central"/"runtime_group" 三态区分：不是「读了中心组读到 0 条」。
    return {"metrics": {k: {"value": None, "prev": None, "delta": None} for k in METRIC_NAMES},
            "reasons": {k: reason for k in METRIC_NAMES},
            "hourly": [], "counts": None, "span_origin": None}


def _bucket_label(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%MZ")


def hourly_sessions(spans: list[dict], window_hours: int, now: datetime) -> list[dict]:
    """本窗 [now - window_hours, now) 等分成 window_hours 个 1h 桶的会话量。

    每个会话只归一个桶 —— 它在窗内**最早**一条 span 的开始时间所在桶（会话跨小时
    不重复计），所以 sum(hourly[*].sessions) == metrics.sessions.value。桶标签 =
    桶起点（分钟精度 UTC）；窗起点非整点时标签也非整点，这是刻意的：桶严格是
    24h 窗的等分，不另设整点窗。无数据的桶给 0。
    """
    start = now - timedelta(hours=window_hours)
    start_ns = int(start.timestamp() * _NS)
    first_seen: dict[str, int] = {}
    for s in spans:
        sid = s["attributes"].get("session.id")
        if not sid:
            continue
        t0 = s["start_time"]
        if sid not in first_seen or t0 < first_seen[sid]:
            first_seen[sid] = t0
    buckets = [0] * window_hours
    for t0 in first_seen.values():
        idx = (t0 - start_ns) // (3600 * _NS)
        if 0 <= idx < window_hours:
            buckets[idx] += 1
    return [{"hour": _bucket_label(start + timedelta(hours=i)), "sessions": n}
            for i, n in enumerate(buckets)]


NO_SPAN_SOURCE = "该 Agent 没有 runtime 日志组，也未配置 span 源"


def compute_metrics(agent: dict, cfg: dict | None, window_hours: int,
                    now: datetime, prices: dict | None = None) -> dict:
    """五个数（本窗 / 前窗 / 差）+ 逐小时会话量 + 原因表 + 原始计数。一次 Logs Insights 查询。

    返回 {"metrics", "hourly", "reasons", "counts"}；算不出（无日志组 / 查询失败 /
    截断）时 metrics 全 null、hourly 为 []、counts 为 None。
    cfg = tracesource.resolve_span_config(agent)（调用方解析一次，深链也用它）。
    prices = pricing.get_prices()["prices"]；省略则自己读（单 Agent 路径的旧行为）。
    舰队扇出走注入（fleet_status 读一次传给全部 Agent），队形同 runs= / plans=。
    """
    if cfg is None:
        return _null_metrics(NO_SPAN_SOURCE)
    lookback_days = max(1, math.ceil(2 * window_hours / 24))
    try:
        rows, span_origin = query_status_rows(cfg, lookback_days)
    except Exception as e:  # 超时 / 无日志组 / 权限：都是「这次算不出」，不是 500
        logger.info("agent_status insights query failed for %s",
                    agent.get("agent_name"), exc_info=True)
        return _null_metrics(f"Logs Insights 查询失败：{str(e)[:200]}")
    if len(rows) >= INSIGHTS_ROW_LIMIT:
        return _null_metrics(
            f"{2 * window_hours}h 内 span 行数达到 Logs Insights 单次查询上限 "
            f"{INSIGHTS_ROW_LIMIT}，聚合不完整")

    spans = _rows_to_spans(rows)
    cut_cur = int((now - timedelta(hours=window_hours)).timestamp() * _NS)
    cut_prev = int((now - timedelta(hours=2 * window_hours)).timestamp() * _NS)
    cur = [s for s in spans if s["start_time"] >= cut_cur]
    prev = [s for s in spans if cut_prev <= s["start_time"] < cut_cur]

    if prices is None:
        prices = pricing.get_prices()["prices"]
    cur_v, cur_r, cur_c = _window_metrics(cur, prices, f"近 {window_hours}h 窗内")
    prev_v, prev_r, prev_c = _window_metrics(prev, prices, f"前一个 {window_hours}h 窗内")
    metrics, reasons = {}, {}
    for k in METRIC_NAMES:
        v, p = cur_v.get(k), prev_v.get(k)
        delta = round(v - p, 4) if isinstance(v, (int, float)) and isinstance(p, (int, float)) else None
        metrics[k] = {"value": v, "prev": p, "delta": delta}
        parts = [r for r in (cur_r.get(k), prev_r.get(k)) if r]
        if parts:
            reasons[k] = "；".join(parts)
    return {"metrics": metrics, "reasons": reasons,
            "hourly": hourly_sessions(cur, window_hours, now),
            "counts": {"cur": cur_c, "prev": prev_c},
            "span_origin": span_origin}


# ---------- runs → last_run / alerts ----------

def _run_evaluator_values(run: dict) -> dict[str, float]:
    """一次 run 里每个评估器的分：observe 环节 mean_score、dataset 环节 mean；
    同名出现在多个环节取均值。"""
    acc: dict[str, list[float]] = {}
    for st in run.get("stage_summaries") or []:
        if st.get("status") != "completed":
            continue
        if st.get("type") == "observe":
            pairs = ((k, v.get("mean_score")) for k, v in (st.get("summary") or {}).items())
        elif st.get("type") == "dataset":
            pairs = ((k, v.get("mean")) for k, v in (st.get("evaluator_stats") or {}).items())
        else:
            continue
        for name, score in pairs:
            if isinstance(score, (int, float)):
                acc.setdefault(name, []).append(float(score))
    return {k: round(sum(v) / len(v), 4) for k, v in acc.items()}


def last_run_summary(runs: list[dict]) -> tuple[dict | None, dict]:
    """最近一次**已结束**的 run（running 跳过）→ 契约里的 last_run + 原因表。"""
    run = next((r for r in runs if r.get("status") != "running"), None)
    if run is None:
        return None, {}
    reasons: dict = {}
    dataset_rates = [st.get("pass_rate") for st in run.get("stage_summaries") or []
                     if st.get("type") == "dataset" and st.get("status") == "completed"
                     and st.get("pass_rate") is not None]
    dataset_pass_rate = None
    if len(dataset_rates) == 1:
        dataset_pass_rate = dataset_rates[0]
    elif len(dataset_rates) > 1:
        reasons["last_run.dataset_pass_rate"] = "多个回归环节，摘要项无 judged_cases 无法合并"
    # 只出 pass_rate，没有 X/Y：摘要项只存 pass_rate / cases / blank_cases，分母
    # judged_cases 只在 S3 全文里（cases 含空响应与调用失败的用例，不能冒充分母）。
    attacks = breached = 0
    for st in run.get("stage_summaries") or []:
        if st.get("type") == "redteam" and st.get("status") == "completed":
            attacks += int(st.get("attacks") or 0)
            breached += int(st.get("breached") or 0)
    return {
        "run_key": run.get("run_key"), "plan_id": run.get("plan_id"),
        "plan_name": run.get("plan_name"), "status": run.get("status"),
        "observe_mean": run.get("score"),
        "dataset_pass_rate": dataset_pass_rate,
        "redteam_blocked": f"{attacks - breached}/{attacks}" if attacks > 0 else None,
        "finished_at": run.get("finished_at") or None,
    }, reasons


def evaluator_alerts(runs: list[dict], target: float = ALERT_TARGET,
                     min_streak: int = ALERT_MIN_STREAK) -> list[dict]:
    """同一计划最近连续 ≥ min_streak 次 completed run 里某评估器都 < target。

    按计划分组（评估器是计划配的，目标线也是计划级的概念）；streak 从该计划最新一次
    completed run 往回数，遇到一次达标或该评估器缺席即断。runs 须新→旧。
    """
    by_plan: dict[str, list[dict]] = {}
    for r in runs:
        if r.get("status") == "completed":
            by_plan.setdefault(r.get("plan_id") or "", []).append(r)
    alerts = []
    for plan_runs in by_plan.values():
        values = [_run_evaluator_values(r) for r in plan_runs]
        for name in sorted(values[0]) if values else []:
            streak = []
            for r, v in zip(plan_runs, values):
                if name in v and v[name] < target:
                    streak.append((r, v[name]))
                else:
                    break
            if len(streak) >= min_streak:
                alerts.append({
                    "kind": "evaluator_below_target",
                    "plan_id": plan_runs[0].get("plan_id"),
                    "plan_name": plan_runs[0].get("plan_name"),
                    "evaluator": name, "target": target, "streak": len(streak),
                    "values": [v for _, v in reversed(streak)],       # 旧→新
                    "since_run": streak[-1][0].get("run_key"),
                    "until_run": streak[0][0].get("run_key"),
                })
    return alerts


# ---------- plans → next_run ----------

_MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
           "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
# EventBridge 数字 dow：1=周日 … 7=周六；内部统一成 0=周日 … 6=周六
_DAYS_EB = {"sun": 1, "mon": 2, "tue": 3, "wed": 4, "thu": 5, "fri": 6, "sat": 7}


def _parse_cron_field(raw: str, lo: int, hi: int, names: dict | None) -> set[int] | None:
    """一段 cron 字段 → 取值集合；`*`/`?` 返回 None（= 不限）。语法错误抛 ValueError。"""
    raw = raw.strip().lower()
    if raw in ("*", "?"):
        return None

    def atom(tok: str) -> int:
        if names and tok in names:
            return names[tok]
        v = int(tok)
        if not lo <= v <= hi:
            raise ValueError(tok)
        return v

    out: set[int] = set()
    for part in raw.split(","):
        step = 1
        if "/" in part:
            part, step_s = part.split("/", 1)
            step = int(step_s)
            if step <= 0:
                raise ValueError(part)
        if part == "*":
            a, b = lo, hi
        elif "-" in part:
            a_s, b_s = part.split("-", 1)
            a, b = atom(a_s), atom(b_s)
        else:
            a = atom(part)
            b = hi if "/" in raw else a
        if a > b:
            raise ValueError(part)
        out.update(range(a, b + 1, step))
    return out


def next_cron_fire(expr: str, now: datetime) -> datetime | None:
    """EventBridge `cron(分 时 日 月 周 年)` 的下一次触发（UTC，分钟粒度）。

    与 web/src/pages/plan/cronEngine.ts 的 nextRuns 同语义：日与周都非 * 时取「或」；
    含 L/W/# 扩展语法或一年内无触发返回 None。rate(...) 不在这里 —— 它的相位由
    EventBridge 创建时刻决定，本地推不出来。
    """
    m = re.fullmatch(r"\s*cron\((.*)\)\s*", expr or "", flags=re.IGNORECASE)
    if not m:
        return None
    parts = m.group(1).split()
    if len(parts) != 6:
        return None
    if any(re.search(r"[lw#]", re.sub(r"[a-z]{3}", "", p.lower())) for p in parts):
        return None
    try:
        minute = _parse_cron_field(parts[0], 0, 59, None)
        hour = _parse_cron_field(parts[1], 0, 23, None)
        dom = _parse_cron_field(parts[2], 1, 31, None)
        month = _parse_cron_field(parts[3], 1, 12, _MONTHS)
        dow_eb = _parse_cron_field(parts[4], 1, 7, _DAYS_EB)
        year = _parse_cron_field(parts[5], 1970, 2199, None)
    except ValueError:
        return None
    dow = {v - 1 for v in dow_eb} if dow_eb is not None else None

    def day_ok(d: datetime) -> bool:
        ok_dom = dom is None or d.day in dom
        ok_dow = dow is None or (d.weekday() + 1) % 7 in dow
        if dom is not None and dow is not None:
            return d.day in dom or (d.weekday() + 1) % 7 in dow
        return ok_dom and ok_dow

    t = now.replace(second=0, microsecond=0) + timedelta(minutes=1)
    limit = now + timedelta(days=366)
    while t <= limit:
        if year is not None and t.year not in year:
            if t.year > max(year):
                return None
            t = datetime(t.year + 1, 1, 1, tzinfo=t.tzinfo)
            continue
        if month is not None and t.month not in month:
            nxt = (t.replace(day=1) + timedelta(days=32)).replace(day=1)
            t = nxt.replace(hour=0, minute=0)
            continue
        if not day_ok(t):
            t = (t + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        if hour is not None and t.hour not in hour:
            t = (t + timedelta(hours=1)).replace(minute=0)
            continue
        if minute is not None and t.minute not in minute:
            t += timedelta(minutes=1)
            continue
        return t
    return None


def next_scheduled_run(plans: list[dict], now: datetime) -> tuple[dict | None, dict]:
    """该 Agent 所有带定时的计划里最早的下一次 → 契约 next_run + 原因表。"""
    candidates = []
    reasons: dict = {}
    for p in plans:
        sched = p.get("schedule") or {}
        cron = (sched.get("cron") or "").strip()
        if not cron:
            continue
        at = next_cron_fire(cron, now)
        entry = {"plan_id": p.get("plan_id"), "plan_name": p.get("name"),
                 "at": at.strftime("%Y-%m-%dT%H:%M:%SZ") if at else None,
                 "budget_usd": sched.get("budget_usd")}
        if at is None:
            entry_reason = (f"{cron} 的相位由 EventBridge 创建时刻决定，无法本地推算"
                            if cron.lower().startswith("rate(")
                            else f"{cron} 无法本地推算（不支持的语法或一年内无触发）")
        else:
            entry_reason = None
        candidates.append((at, entry, entry_reason))
    if not candidates:
        return None, reasons
    known = [c for c in candidates if c[0] is not None]
    if known:
        _, entry, _ = min(known, key=lambda c: c[0])
        return entry, reasons
    _, entry, reason = candidates[0]
    reasons["next_run.at"] = reason
    return entry, reasons


# ---------- CloudWatch 深链 ----------

def log_group_url(log_group: str) -> str:
    """CloudWatch 控制台日志组页（日志组名在 URL 片段里双重编码：`/` → `$252F`）。"""
    enc = log_group.replace("/", "$252F")
    return (f"https://{REGION}.console.aws.amazon.com/cloudwatch/home?region={REGION}"
            f"#logsV2:log-groups/log-group/{enc}")


# ---------- 入口 ----------

def build_status(agent: dict, *, window_hours: int, now: datetime,
                 runs: list[dict], plans: list[dict],
                 prices: dict | None = None) -> tuple[dict, dict | None]:
    """一个 Agent 的现状对象 + 原始计数（fleet 汇总用）。

    runs = 该 Agent 的 run（新→旧，≤ RUNS_LOOKBACK 条）；plans = 该 Agent 的计划；
    prices = 价目表（省略则自己读）。
    调用方负责取数：agent_status 自己查，fleet_status 一次读好按 Agent 分发。
    """
    agent_name = agent.get("agent_name")
    reasons: dict = {}
    cfg = tracesource.resolve_span_config(agent)

    obs = compute_metrics(agent, cfg, window_hours, now, prices)
    reasons.update(obs["reasons"])

    last_run, r = last_run_summary(runs)
    reasons.update(r)
    alerts = evaluator_alerts(runs)

    next_run, r = next_scheduled_run(plans, now)
    reasons.update(r)

    # 深链指向**这次真读到数的那个组**：回退命中时 cfg["log_group"] 是 aws/spans，
    # 而 span 在专属 runtime 组里 —— 给中心组的链接会让人打开一个空查询。
    read_group = cfg.get("log_group") if cfg else None
    if obs.get("span_origin") == tracesource.ORIGIN_RUNTIME_GROUP and cfg:
        read_group = cfg.get("fallback_log_group") or read_group
    if read_group:
        url = log_group_url(read_group)
    else:
        url = None
        reasons["cloudwatch_url"] = NO_SPAN_SOURCE

    status = {
        "event": "agent_status",
        "agent_name": agent_name,
        "window_hours": window_hours,
        "metrics": obs["metrics"],
        "hourly": obs["hourly"],
        "span_origin": obs.get("span_origin"),
        "last_run": last_run,
        "alerts": alerts,
        "next_run": next_run,
        "cloudwatch_url": url,
        "unavailable_reason": reasons,
    }
    # 谁算的都记账：fleet_status 逐 Agent 调的也是这里 ⇒ 舰队页算过的那一份，
    # 紧接着点进详情页就是命中，不再重发那条 Insights 查询。
    _cache.put((agent_name, int(window_hours)), status)
    return status, obs["counts"]


def agent_status(agent_name: str, window_hours: int = WINDOW_HOURS,
                 refresh: bool = False) -> dict:
    """一个 Agent 的现状。找不到 Agent 抛 ValueError（措辞即错误帧原话）。

    进程内缓存按 (agent_name, window_hours) 分键、TTL CACHE_TTL_SECONDS，命中返回原结果
    + cached=true + cache_age_s；refresh=True 绕过并覆盖。缓存由 build_status 写入，所以
    fleet_status 先算过的那一份在这里也算命中（同一个 build_status，同一个键）。
    Agent 不存在的判定在读缓存**之前**：错误帧不受缓存影响。
    """
    agent = _find_agent(agent_name)
    if agent is None:
        raise ValueError(f"Agent '{agent_name}' 不存在")
    key = (agent_name, int(window_hours))
    if not refresh:
        hit = _cache.get(key)
        if hit is not None:
            return {**hit[0], "cached": True, "cache_age_s": hit[1]}
    status, _ = build_status(
        agent, window_hours=window_hours, now=_now(),
        runs=planrun.list_recent_runs(limit=RUNS_LOOKBACK, agent_name=agent_name),
        plans=plan_mod.list_plans(agent_name))
    return {**status, "cached": False, "cache_age_s": 0}
