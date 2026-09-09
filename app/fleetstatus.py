"""fleet_status：所有 Agent 的现状 + 舰队汇总 —— ADR-0016「舰队级」首页（观测视角）的数据源。

只读 action。每个 Agent 复用 agentstatus.build_status（与 agent_status 完全同形，含 hourly），
各 Agent 的 Logs Insights 查询并发发起（线程池，上限 MAX_CONCURRENCY）；PLANRUN / PLAN 分区
各只读一次再按 Agent 分发。结果带 CACHE_TTL_SECONDS 进程内缓存（Lambda 热实例）。
单个 Agent 算不出 ⇒ 落 `unavailable[<agent>]`，不拖垮整体；绝不写 DDB / S3。

缓存只在进程内：catalog 表是单表设计（业务项与缓存项同一张表），往里写缓存项就是对
业务表的 put_item，与本 action「零写」的钉子相冲；首页一个 Lambda 热实例 5 分钟内的
重复刷新已被进程内缓存盖住，冷启动多付一轮查询（≈ 一次 agent_status × Agent 数 / 8）。
"""

import logging
from concurrent.futures import ThreadPoolExecutor

import plan as plan_mod
import planrun
import pricing
import ttlcache
from ttlcache import is_number

import agentstatus
from agentstatus import RUNS_LOOKBACK

logger = logging.getLogger("eval-anything")

MAX_CONCURRENCY = 8
CACHE_TTL_SECONDS = ttlcache.DEFAULT_TTL_SECONDS
# 观测类飙升门槛（硬事实，契约可复核）：较前一日翻倍 且 绝对值 ≥ 2%
SPIKE_RATIO = 2.0
SPIKE_MIN_RATE = 0.02
RUN_FAILED_STATUSES = ("error", "failed")
# list_recent_runs 的分区读上限：一次读全，按 Agent 分发后各取 RUNS_LOOKBACK 条
RUNS_PARTITION_CAP = 500
# todo 排序：观测类在前，同层内按此顺序，再按 agent_name
_KIND_ORDER = ("tool_failure_spike", "blank_spike", "budget", "run_failed",
               "evaluator_below_target")
_LAYER = {"tool_failure_spike": "observe", "blank_spike": "observe", "budget": "observe",
          "run_failed": "observe", "evaluator_below_target": "evaluate"}

_cache = ttlcache.TtlCache(CACHE_TTL_SECONDS)


# ---------- 逐 Agent ----------

def _degraded_status(agent: dict, window_hours: int, reason: str) -> dict:
    """build_status 抛异常时的占位对象：与 agent_status 同形，metrics 全 null。"""
    null = agentstatus._null_metrics(reason)
    return {
        "event": "agent_status", "agent_name": agent.get("agent_name"),
        "window_hours": window_hours, "metrics": null["metrics"], "hourly": [],
        "last_run": None, "alerts": [], "next_run": None, "cloudwatch_url": None,
        "unavailable_reason": {**null["reasons"], "agent_status": reason},
    }


def _one_agent(agent: dict, window_hours: int, now, runs: list[dict],
               plans: list[dict], prices: dict | None = None) -> tuple[dict, dict | None]:
    try:
        return agentstatus.build_status(agent, window_hours=window_hours, now=now,
                                        runs=runs, plans=plans, prices=prices)
    except Exception as e:  # 单个 Agent 出错不拖垮舰队
        logger.info("fleet_status: agent %s failed", agent.get("agent_name"), exc_info=True)
        return _degraded_status(agent, window_hours,
                                f"agent_status 计算失败：{str(e)[:200]}"), None


# ---------- 汇总 ----------

def _sum_metric(statuses: list[dict], name: str) -> dict:
    vals = [s["metrics"][name]["value"] for s in statuses if is_number(s["metrics"][name]["value"])]
    prevs = [s["metrics"][name]["prev"] for s in statuses if is_number(s["metrics"][name]["prev"])]
    value = round(sum(vals), 4) if vals else None
    prev = round(sum(prevs), 4) if prevs else None
    delta = round(value - prev, 4) if value is not None and prev is not None else None
    return {"value": value, "prev": prev, "delta": delta}


def _worst_p95(statuses: list[dict]) -> dict:
    best = None
    for s in statuses:
        v = s["metrics"]["p95_latency_ms"]["value"]
        if is_number(v) and (best is None or v > best[1]):
            best = (s["agent_name"], v)
    return {"agent_name": best[0] if best else None, "value_ms": best[1] if best else None}


def _anomaly_rate(counts: list[dict]) -> dict:
    """(空响应会话 + 工具失败 span) / 会话数，计数跨 Agent 相加再除（比率不能相加）。"""
    def rate(side: str):
        sessions = sum(c[side]["sessions"] for c in counts)
        if sessions == 0:
            return None
        bad = sum(c[side]["blank_sessions"] + c[side]["tool_failures"] for c in counts)
        return round(bad / sessions, 4)
    value, prev = rate("cur"), rate("prev")
    delta = round(value - prev, 4) if value is not None and prev is not None else None
    return {"value": value, "prev": prev, "delta": delta}


def _sum_hourly(statuses: list[dict]) -> list[dict]:
    series = [s["hourly"] for s in statuses if s["hourly"]]
    if not series:
        return []
    return [{"hour": series[0][i]["hour"], "sessions": sum(h[i]["sessions"] for h in series)}
            for i in range(len(series[0]))]


# ---------- todo ----------

def _pct(v: float) -> str:
    return f"{v * 100:.1f}%"


def _is_spike(value, prev) -> bool:
    return (is_number(value) and is_number(prev) and value >= SPIKE_MIN_RATE
            and value >= SPIKE_RATIO * prev)


def _todo_for(status: dict, runs: list[dict]) -> list[dict]:
    name = status["agent_name"]
    items: list[dict] = []

    def add(kind, fact, plan_id=None, run_key=None):
        items.append({"kind": kind, "layer": _LAYER[kind], "agent_name": name, "fact": fact,
                      "action": "view", "target": {"plan_id": plan_id, "run_key": run_key}})

    m = status["metrics"]
    for kind, metric, label in (("tool_failure_spike", "tool_failure_rate", "工具失败率"),
                                ("blank_spike", "blank_rate", "空响应率")):
        v, p = m[metric]["value"], m[metric]["prev"]
        if _is_spike(v, p):
            add(kind, f"{label} {_pct(v)}（前一日 {_pct(p)}）")

    lr = status["last_run"]
    if lr and lr.get("status") in RUN_FAILED_STATUSES:
        raw = next((r for r in runs if r.get("run_key") == lr.get("run_key")), {})
        fact = f"「{lr.get('plan_name')}」最近一次运行失败（{lr.get('finished_at') or '未记录结束时间'}）"
        if raw.get("error"):
            fact += f"：{str(raw['error'])[:80]}"
        add("run_failed", fact, lr.get("plan_id"), lr.get("run_key"))

    for a in status["alerts"]:
        add("evaluator_below_target",
            f"「{a['plan_name']}」{a['evaluator']} 连续 {a['streak']} 次低于 {a['target']}"
            f"（最近 {a['values'][-1]}）",
            a["plan_id"], a["until_run"])
    return items


def _sorted_todo(items: list[dict]) -> list[dict]:
    layer_rank = {"observe": 0, "evaluate": 1}
    return sorted(items, key=lambda t: (layer_rank[t["layer"]], _KIND_ORDER.index(t["kind"]),
                                        t["agent_name"] or ""))


# ---------- 入口 ----------

def _compute(window_hours: int) -> dict:
    now = agentstatus._now()
    agents = agentstatus.list_known_agents()

    runs_by_agent: dict[str, list[dict]] = {}
    for r in planrun.list_recent_runs(limit=RUNS_PARTITION_CAP):
        bucket = runs_by_agent.setdefault(r.get("agent_name") or "", [])
        if len(bucket) < RUNS_LOOKBACK:
            bucket.append(r)
    plans_by_agent: dict[str, list[dict]] = {}
    for p in plan_mod.list_plans():
        plans_by_agent.setdefault(p.get("agent_name") or "", []).append(p)
    # 价目表也进「读一次再分发」的队形（同 runs / plans）：原先扇出的每个 Agent 各查一遍
    # PRICE 分区，现网 32 个 Agent = 31 次白查。读不到就传 None，逐 Agent 退回自己读。
    try:
        prices = pricing.get_prices()["prices"]
    except Exception:
        logger.info("fleet_status: 价目表预读失败，逐 Agent 自己读", exc_info=True)
        prices = None

    def work(agent: dict):
        name = agent.get("agent_name") or ""
        return _one_agent(agent, window_hours, now, runs_by_agent.get(name, []),
                          plans_by_agent.get(name, []), prices)

    if agents:
        with ThreadPoolExecutor(max_workers=min(MAX_CONCURRENCY, len(agents))) as pool:
            results = list(pool.map(work, agents))
    else:
        results = []

    statuses = [s for s, _ in results]
    counts = [c for _, c in results if c is not None]
    unavailable = {s["agent_name"]: s["unavailable_reason"]
                   for s in statuses if s["unavailable_reason"]}
    todo: list[dict] = []
    for s in statuses:
        todo.extend(_todo_for(s, runs_by_agent.get(s["agent_name"] or "", [])))

    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "event": "fleet_status",
        "window_hours": window_hours,
        # computed_at = 五个数真正算出来的时刻（缓存命中时不变），前端「数据时刻」用它；
        # generated_at 同值，是老键名（前端还在读），两者都在契约里。
        "computed_at": stamp,
        "generated_at": stamp,
        "cached": False,
        "cache_age_s": 0,
        "agents": statuses,
        "fleet": {
            "agents": len(statuses),
            "sessions": _sum_metric(statuses, "sessions"),
            "cost_usd": _sum_metric(statuses, "agent_cost_usd"),
            "worst_p95": _worst_p95(statuses),
            "anomaly_rate": _anomaly_rate(counts),
            "hourly": _sum_hourly(statuses),
        },
        "todo": _sorted_todo(todo),
        "unavailable": unavailable,
    }


def fleet_status(window_hours: int = agentstatus.WINDOW_HOURS, refresh: bool = False) -> dict:
    """舰队现状（契约见 docs/payload-contract.md `fleet_status` 小节）。

    进程内缓存按 window_hours 分键，命中返回原结果 + cached=true（computed_at /
    generated_at 不变）+ cache_age_s（距原次计算的秒数）；refresh=True 绕过缓存并覆盖。

    2026-09-04 评审把首页「缓存于 01:27」读成了舰队五数过期 6 小时 —— 那行文案其实来自
    discover 的 Agent 目录缓存（catalog refreshed_at），与本 action 无关；当次 fleet_status
    是新算的（页头窗口末端 = 当时时刻且无「· 缓存」后缀）。这里没有失效缺陷可修，改动只是
    把「数据时刻」做成显式字段，让前端不必拿两处不同来源的时间拼一句话。
    """
    key = int(window_hours)
    if not refresh:
        hit = _cache.get(key)
        if hit is not None:
            return {**hit[0], "cached": True, "cache_age_s": hit[1]}
    result = _compute(key)
    _cache.put(key, result)
    return result
