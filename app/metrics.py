"""Per-session run metrics aggregated from raw trace spans.

Works on the parsed span dicts (CloudWatchLogsParser output) rather than the
mapped Session, because token/model/duration attributes live on raw spans.

Token counting uses only the model-level spans (scope
*.botocore.bedrock-runtime, or any span carrying gen_ai.request.model) to
avoid double counting: Strands tracer spans (chat / invoke_agent) aggregate
the same tokens again at higher levels.

Latency is per-trace end-to-end (one trace = one request/response turn),
reported as avg/max over turns — wall-clock across turns would count user
think-time between requests.
"""

from collections import defaultdict

METRIC_KEYS = ["tokens", "cost", "latency", "llm_calls", "tool_calls"]

_NS = 1_000_000_000


def _span_times(span: dict) -> tuple[float, float]:
    start, end = span.get("start_time", 0), span.get("end_time", 0)
    # raw records carry unix-nano ints; be tolerant of float seconds
    if isinstance(start, (int, float)) and start > 1e15:
        return start / _NS, end / _NS
    return float(start or 0), float(end or 0)


# Prompt-cache usage attributes. Two spellings are live: the dsh harness / OTel
# GenAI semconv style `gen_ai.usage.cache_read.input_tokens` (dotted) and the
# strands / botocore style `gen_ai.usage.cache_read_input_tokens` (underscored,
# see tests/fixtures/agentcore_spans_tau_airline_16.json). Anthropic's raw API
# name for the write side is `cache_creation_input_tokens`; accept it too.
_CACHE_READ_ATTRS = ("gen_ai.usage.cache_read.input_tokens",
                     "gen_ai.usage.cache_read_input_tokens")
_CACHE_WRITE_ATTRS = ("gen_ai.usage.cache_write.input_tokens",
                      "gen_ai.usage.cache_write_input_tokens",
                      "gen_ai.usage.cache_creation_input_tokens")


def _first_int(attrs: dict, names: tuple[str, ...]) -> int:
    for n in names:
        v = attrs.get(n)
        if v not in (None, ""):
            try:
                return int(v)
            except (TypeError, ValueError):
                continue
    return 0


def compute_session_metrics(span_dicts: list[dict], prices: dict) -> dict:
    """Aggregate metrics for one session from its raw span dicts.

    `tokens.input` is the **whole prompt** the model processed = uncached input
    + cache read + cache write. On Anthropic-style spans `gen_ai.usage.input_tokens`
    is only the uncached share (3 tokens next to a 7932-token cache read on the
    dsh harness), so summing that field alone reported "输入 36" for 8 calls
    (P1, 2026-09-04 review). The split is kept in `input_uncached` /
    `cache_read` / `cache_write`, and cost prices each share at its multiplier
    (pricing.usage_cost_usd).
    """
    from pricing import lookup_price, usage_cost_usd

    input_tokens = output_tokens = 0
    uncached_tokens = cache_read_tokens = cache_write_tokens = 0
    by_model: dict[str, dict] = defaultdict(
        lambda: {"input": 0, "output": 0, "calls": 0,
                 "input_uncached": 0, "cache_read": 0, "cache_write": 0})
    llm_durations: list[float] = []
    tool_count = 0
    tool_duration = 0.0
    trace_bounds: dict[str, list[float]] = {}

    # The same LLM call surfaces at several layers (botocore instrumentation,
    # Strands tracer "chat", and the invoke_agent aggregate), all carrying
    # token counts. Count exactly one layer: prefer provider instrumentation
    # spans (most granular), else Strands chat spans; never aggregates.
    token_spans = [
        s for s in span_dicts
        if (s.get("attributes") or {}).get("gen_ai.request.model")
        or ((s.get("attributes") or {}).get("gen_ai.usage.output_tokens")
            and not s.get("name", "").startswith("invoke_agent"))
    ]
    provider_spans = [
        s for s in token_spans
        if "strands" not in ((s.get("scope") or {}).get("name") or "")
        and not s.get("name", "").startswith("invoke_agent")
    ]
    strands_chat_spans = [
        s for s in token_spans
        if "strands" in ((s.get("scope") or {}).get("name") or "")
        and not s.get("name", "").startswith("invoke_agent")
    ]
    counted = provider_spans or strands_chat_spans

    for span in span_dicts:
        name = span.get("name", "")
        start, end = _span_times(span)
        tid = span.get("trace_id", "")
        if tid and start and end:
            lo, hi = trace_bounds.get(tid, [start, end])
            trace_bounds[tid] = [min(lo, start), max(hi, end)]
        if name.startswith("execute_tool"):
            tool_count += 1
            if start and end:
                tool_duration += end - start

    session_model = next(
        ((s.get("attributes") or {}).get("gen_ai.request.model")
         for s in token_spans
         if (s.get("attributes") or {}).get("gen_ai.request.model")),
        "unknown",
    )
    for span in counted:
        attrs = span.get("attributes") or {}
        model = attrs.get("gen_ai.request.model") or session_model
        uncached = int(attrs.get("gen_ai.usage.input_tokens", 0)
                       or attrs.get("gen_ai.usage.prompt_tokens", 0) or 0)
        cr = _first_int(attrs, _CACHE_READ_ATTRS)
        cw = _first_int(attrs, _CACHE_WRITE_ATTRS)
        inp = uncached + cr + cw
        out = int(attrs.get("gen_ai.usage.output_tokens", 0) or 0)
        input_tokens += inp
        uncached_tokens += uncached
        cache_read_tokens += cr
        cache_write_tokens += cw
        output_tokens += out
        m = by_model[model]
        m["input"] += inp
        m["input_uncached"] += uncached
        m["cache_read"] += cr
        m["cache_write"] += cw
        m["output"] += out
        m["calls"] += 1
        start, end = _span_times(span)
        if start and end:
            llm_durations.append(end - start)

    # 无价就按 0 累加并把模型名收进 unpriced —— 这里是**刻意**如此，不套用
    # pricing.judge_price 的兜底：by_model 全部来自被测 Agent 自己 trace 里的
    # gen_ai.request.model（任意第三方模型，价格天然不可知），而 judge 调用发生在
    # 本服务侧、根本不进这些 span。所以这段既不参与成本熔断（观测环节没有记账
    # 循环），也不该凭空给用户的模型编一个费率 —— 猜出来的钱会被当成实测值读。
    # judge 侧的兜底见 testrun._judge_cost / redteam._accrue_cost。
    cost = 0.0
    unpriced = []
    model_costs = {}
    for model, m in by_model.items():
        price = lookup_price(model, prices)
        if price:
            c = usage_cost_usd(price, m["input_uncached"], m["output"],
                               m["cache_read"], m["cache_write"])
            model_costs[model] = round(c, 6)
            cost += c
        else:
            unpriced.append(model)

    turn_latencies = sorted(hi - lo for lo, hi in trace_bounds.values())
    return {
        "tokens": {"input": input_tokens, "output": output_tokens,
                   "total": input_tokens + output_tokens,
                   "input_uncached": uncached_tokens,
                   "cache_read": cache_read_tokens, "cache_write": cache_write_tokens,
                   "by_model": {k: dict(v) for k, v in by_model.items()}},
        "cost": {"usd": round(cost, 6), "by_model": model_costs,
                 "unpriced_models": unpriced},
        "latency": {"turns": len(turn_latencies),
                    "avg_s": round(sum(turn_latencies) / len(turn_latencies), 2) if turn_latencies else None,
                    "max_s": round(turn_latencies[-1], 2) if turn_latencies else None},
        "llm_calls": {"count": len(llm_durations),
                      "avg_s": round(sum(llm_durations) / len(llm_durations), 2) if llm_durations else None,
                      "max_s": round(max(llm_durations), 2) if llm_durations else None},
        "tool_calls": {"count": tool_count, "total_s": round(tool_duration, 2)},
    }


def filter_metrics(metrics: dict, selected: list[str]) -> dict:
    """Keep only the metric groups the user asked for (cost implies tokens)."""
    keep = set(selected)
    if "cost" in keep:
        keep.add("tokens")
    return {k: v for k, v in metrics.items() if k in keep}


def aggregate_agent_metrics(session_metrics: list[dict]) -> dict:
    """Roll per-session metrics up to one agent-level summary."""
    if not session_metrics:
        return {}
    agg = {
        "tokens": {"input": 0, "output": 0, "total": 0,
                   "input_uncached": 0, "cache_read": 0, "cache_write": 0},
        "cost": {"usd": 0.0, "unpriced_models": set()},
        "latency": {"turns": 0, "avg_s": None, "max_s": None},
        "llm_calls": {"count": 0},
        "tool_calls": {"count": 0},
    }
    lat_products, lat_turns, lat_max = 0.0, 0, 0.0
    for m in session_metrics:
        t = m.get("tokens")
        if t:
            agg["tokens"]["input"] += t["input"]
            agg["tokens"]["output"] += t["output"]
            agg["tokens"]["total"] += t["total"]
            # 老报告没有拆分字段（.get）：那时 input 全算未缓存。
            for k in ("input_uncached", "cache_read", "cache_write"):
                agg["tokens"][k] += int(t.get(k) or 0)
        c = m.get("cost")
        if c:
            agg["cost"]["usd"] += c["usd"]
            agg["cost"]["unpriced_models"].update(c.get("unpriced_models", []))
        l = m.get("latency")
        if l and l.get("turns"):
            lat_turns += l["turns"]
            lat_products += (l["avg_s"] or 0) * l["turns"]
            lat_max = max(lat_max, l.get("max_s") or 0)
        for k in ("llm_calls", "tool_calls"):
            if m.get(k):
                agg[k]["count"] += m[k]["count"]
    agg["cost"]["usd"] = round(agg["cost"]["usd"], 6)
    agg["cost"]["unpriced_models"] = sorted(agg["cost"]["unpriced_models"])
    if lat_turns:
        agg["latency"] = {"turns": lat_turns,
                          "avg_s": round(lat_products / lat_turns, 2),
                          "max_s": round(lat_max, 2)}
    return agg
