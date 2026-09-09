"""`fleet_status` —— ADR-0016 舰队级首页（观测视角）的数据源（只读 action）。

钉八件事：
  1. 形状：agents[*] 与 agent_status 对同一 Agent 的返回**逐字节同形**（含 hourly）；
  2. 舰队汇总：sessions / cost_usd 跨 Agent 相加，worst_p95 取最大，anomaly_rate =
     (空响应会话 + 工具失败 span) / 会话数 用**计数**相加再除，hourly 逐桶相加；
  3. 取数：每 Agent 一次 Insights 查询；PLANRUN / PLAN 分区各只读一次；
  4. 并发：各 Agent 查询并行、同时在飞 ≤ 8；
  5. 隔离：无日志组 / 查询失败 / 单 Agent 抛异常 都落 unavailable，agents 条数不少；
  6. todo 规则：spike = 翻倍且 ≥ 2%；run_failed = 最近一次已结束 run 为 error/failed；
     evaluator_below_target 复用 alerts；budget 不产生（计划没有月度预算字段）；观测类排前；
  7. 缓存：5 分钟进程内，命中 cached=true 且 generated_at 不变、不再发查询；refresh 绕过；
  8. **不写库**：走 main.invoke 全程，DDB 写方法与 S3 put 一次都不许被调。

Run: python3 -m pytest tests/test_fleet_status.py -q
"""

import asyncio
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import agentstatus  # noqa: E402
import fleetstatus  # noqa: E402
from test_agent_status import (NOW, PRICES, cur, invoke_agent_row, observe, prev,  # noqa: E402
                               run, tool_row)


def agent(name):
    return {"agent_name": name, "has_logs": True,
            "log_group": f"/aws/bedrock-agentcore/runtimes/{name}-x-DEFAULT",
            "runtime_arn": f"arn:aws:bedrock-agentcore:us-west-2:1:runtime/{name}-x"}


def cfg_for(a):
    return {"log_group": a["log_group"], "scope_filter": "", "service_filter": ""}


class _Fleet(unittest.TestCase):
    def setUp(self):
        fleetstatus._cache.clear()
        agentstatus._cache.clear()
        self.agents = [agent("alpha"), agent("beta")]
        self.rows_by_log_group: dict = {}
        self.no_source: set = set()
        self.runs: list = []
        self.plans: list = []
        self.query = mock.Mock(side_effect=self._query)

        def resolve(a):
            if a["agent_name"] in self.no_source:
                return None
            return cfg_for(a)

        def list_recent_runs(**k):
            runs = self.runs
            if k.get("agent_name"):
                runs = [r for r in runs if r.get("agent_name") == k["agent_name"]]
            return runs[:k.get("limit", 20)]

        def list_plans(agent_name=None):
            return [p for p in self.plans if not agent_name or p["agent_name"] == agent_name]

        self.list_recent_runs = mock.Mock(side_effect=list_recent_runs)
        self.list_plans = mock.Mock(side_effect=list_plans)
        self.get_prices = mock.Mock(return_value=PRICES)
        patches = [
            mock.patch.object(agentstatus, "_now", return_value=NOW),
            mock.patch.object(agentstatus, "_run_insights_query", self.query),
            mock.patch.object(agentstatus.catalog, "cached_agents",
                              side_effect=lambda: {"agents": self.agents}),
            mock.patch.object(agentstatus.tracesource, "resolve_span_config", side_effect=resolve),
            mock.patch.object(agentstatus.planrun, "list_recent_runs", self.list_recent_runs),
            mock.patch.object(agentstatus.plan_mod, "list_plans", self.list_plans),
            mock.patch.object(agentstatus.pricing, "get_prices", self.get_prices),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _query(self, log_group, query, lookback_days):
        rows = self.rows_by_log_group.get(log_group, [])
        if isinstance(rows, Exception):
            raise rows
        return rows

    def rows(self, name):
        return self.rows_by_log_group.setdefault(agent(name)["log_group"], [])

    def fleet(self, **k):
        return fleetstatus.fleet_status(**k)


def seed(t, name, cur_sessions, prev_sessions, *, blank=0, prev_blank=0,
         tools=0, failed=0, prev_tools=0, prev_failed=0, dur=2.0):
    """name 的两窗数据：cur_sessions 个本窗会话（前 blank 个空响应）、tools 次工具调用
    （前 failed 次失败）；前窗同理。会话时刻按 12 分钟错开（100 个会话也落在同一窗内）。"""
    r = t.rows(name)
    for i in range(cur_sessions):
        r.append(invoke_agent_row(f"{name}-s{i}", cur(1 + i * 0.2), dur,
                                  out_tok=0 if i < blank else 100))
    for i in range(tools):
        r.append(tool_row(f"{name}-s0", cur(1), status_code="ERROR" if i < failed else "OK",
                          tool_status="error" if i < failed else "success"))
    for i in range(prev_sessions):
        r.append(invoke_agent_row(f"{name}-p{i}", prev(1 + i * 0.2), dur,
                                  out_tok=0 if i < prev_blank else 100))
    for i in range(prev_tools):
        r.append(tool_row(f"{name}-p0", prev(1), status_code="ERROR" if i < prev_failed else "OK",
                          tool_status="error" if i < prev_failed else "success"))


class Shape(_Fleet):
    def test_agents_are_same_shape_as_agent_status(self):
        seed(self, "alpha", 3, 2, blank=1, tools=4, failed=1, prev_tools=2)
        seed(self, "beta", 2, 1, dur=5.0)
        self.runs = [run("plan-a#1", score=0.8, stages=[observe(0.8, x=0.8)]) | {"agent_name": "alpha"}]
        self.plans = [{"plan_id": "plan-a", "name": "计划 a", "agent_name": "alpha",
                       "schedule": {"cron": "cron(30 9 * * ? *)", "budget_usd": 1.0}}]
        out = self.fleet()
        self.assertEqual(out["event"], "fleet_status")
        self.assertEqual(out["window_hours"], 24)
        self.assertEqual(out["generated_at"], "2026-09-03T08:00:00Z")
        self.assertFalse(out["cached"])
        self.assertEqual([a["agent_name"] for a in out["agents"]], ["alpha", "beta"])
        queries = self.query.call_count
        for a in out["agents"]:
            # 详情页拿到的就是舰队刚算的那一份（build_status 写的缓存，同键命中）：
            # 形状只多两个缓存字段，且不再发查询。
            detail = agentstatus.agent_status(a["agent_name"])
            self.assertTrue(detail["cached"])
            self.assertEqual({k: v for k, v in detail.items()
                              if k not in ("cached", "cache_age_s")}, a)
        self.assertEqual(self.query.call_count, queries,
                         "舰队算过的 Agent，详情页不许再发 Insights 查询")
        self.assertEqual(out["fleet"]["agents"], 2)
        for key in ("agents", "fleet", "todo", "unavailable"):
            self.assertIn(key, out)
        for key in ("agents", "sessions", "cost_usd", "worst_p95", "anomaly_rate", "hourly"):
            self.assertIn(key, out["fleet"])


class Aggregation(_Fleet):
    def test_sums_max_and_anomaly_rate(self):
        # alpha：本窗 4 会话（1 空响应），4 工具 1 失败；前窗 2 会话，2 工具 0 失败
        seed(self, "alpha", 4, 2, blank=1, tools=4, failed=1, prev_tools=2, dur=2.0)
        # beta：本窗 6 会话（0 空响应），2 工具 2 失败；前窗 3 会话（1 空响应），1 工具 0 失败
        seed(self, "beta", 6, 3, tools=2, failed=2, prev_blank=1, prev_tools=1, dur=7.0)
        out = self.fleet()
        f = out["fleet"]
        self.assertEqual(f["sessions"], {"value": 10, "prev": 5, "delta": 5})
        a_cost = out["agents"][0]["metrics"]["agent_cost_usd"]
        b_cost = out["agents"][1]["metrics"]["agent_cost_usd"]
        self.assertEqual(f["cost_usd"]["value"], round(a_cost["value"] + b_cost["value"], 4))
        self.assertEqual(f["cost_usd"]["prev"], round(a_cost["prev"] + b_cost["prev"], 4))
        self.assertEqual(f["cost_usd"]["delta"], round(f["cost_usd"]["value"] - f["cost_usd"]["prev"], 4))
        self.assertEqual(f["worst_p95"], {"agent_name": "beta", "value_ms": 7000})
        # 异常率 = (空响应会话 1+0 + 工具失败 span 1+2) / 会话 10 = 0.4；前窗 (0+1 + 0) / 5 = 0.2
        self.assertEqual(f["anomaly_rate"], {"value": 0.4, "prev": 0.2, "delta": 0.2})
        # hourly 逐桶相加
        self.assertEqual(len(f["hourly"]), 24)
        self.assertEqual([b["hour"] for b in f["hourly"]],
                         [b["hour"] for b in out["agents"][0]["hourly"]])
        for i, b in enumerate(f["hourly"]):
            self.assertEqual(b["sessions"], out["agents"][0]["hourly"][i]["sessions"]
                             + out["agents"][1]["hourly"][i]["sessions"])
        self.assertEqual(sum(b["sessions"] for b in f["hourly"]), 10)
        self.assertEqual(out["unavailable"], {})

    def test_one_query_per_agent_and_single_partition_reads(self):
        seed(self, "alpha", 1, 1)
        seed(self, "beta", 1, 1)
        self.fleet()
        self.assertEqual(self.query.call_count, 2)
        self.assertEqual(sorted(c.args[0] for c in self.query.call_args_list),
                         sorted(a["log_group"] for a in self.agents))
        self.assertEqual(self.list_recent_runs.call_count, 1)
        self.assertIsNone(self.list_recent_runs.call_args.kwargs.get("agent_name"))
        self.assertEqual(self.list_plans.call_count, 1)

    def test_empty_fleet(self):
        self.agents = []
        out = self.fleet()
        self.assertEqual(out["agents"], [])
        self.assertEqual(out["fleet"]["agents"], 0)
        self.assertEqual(out["fleet"]["sessions"], {"value": None, "prev": None, "delta": None})
        self.assertEqual(out["fleet"]["worst_p95"], {"agent_name": None, "value_ms": None})
        self.assertEqual(out["fleet"]["hourly"], [])
        self.assertEqual(out["todo"], [])


class Concurrency(_Fleet):
    def test_parallel_capped_at_eight(self):
        self.agents = [agent(f"a{i:02d}") for i in range(12)]
        lock = threading.Lock()
        state = {"inflight": 0, "max": 0}

        def slow_query(log_group, query, lookback_days):
            with lock:
                state["inflight"] += 1
                state["max"] = max(state["max"], state["inflight"])
            time.sleep(0.2)
            with lock:
                state["inflight"] -= 1
            return []

        self.query.side_effect = slow_query
        t0 = time.monotonic()
        out = self.fleet()
        elapsed = time.monotonic() - t0
        self.assertEqual(len(out["agents"]), 12)
        self.assertEqual(self.query.call_count, 12)
        self.assertLessEqual(state["max"], fleetstatus.MAX_CONCURRENCY)
        self.assertGreaterEqual(state["max"], 2, "查询没有并发")
        self.assertLess(elapsed, 1.5, f"12×0.2s 串行要 2.4s，实测 {elapsed:.2f}s")


class Isolation(_Fleet):
    def test_no_source_query_failure_and_exception_land_in_unavailable(self):
        self.agents = [agent("alpha"), agent("beta"), agent("gamma"), agent("delta")]
        seed(self, "alpha", 2, 1, tools=1, prev_tools=1)
        self.no_source.add("beta")
        self.rows_by_log_group[agent("gamma")["log_group"]] = TimeoutError("query timed out for g")

        def resolve(a):
            if a["agent_name"] == "delta":
                raise RuntimeError("boom in delta")
            return None if a["agent_name"] in self.no_source else cfg_for(a)

        with mock.patch.object(agentstatus.tracesource, "resolve_span_config", side_effect=resolve):
            out = self.fleet()
        self.assertEqual([a["agent_name"] for a in out["agents"]],
                         ["alpha", "beta", "gamma", "delta"])
        self.assertNotIn("alpha", out["unavailable"])
        self.assertIn("日志组", out["unavailable"]["beta"]["sessions"])
        self.assertIn("timed out", out["unavailable"]["gamma"]["sessions"])
        self.assertIn("boom in delta", out["unavailable"]["delta"]["agent_status"])
        d = out["agents"][3]
        self.assertEqual(d["event"], "agent_status")
        self.assertEqual(set(d["metrics"]), set(agentstatus.METRIC_NAMES))
        self.assertIsNone(d["metrics"]["sessions"]["value"])
        self.assertEqual(d["hourly"], [])
        self.assertEqual(d["alerts"], [])
        # 汇总只算得出数的 Agent
        self.assertEqual(out["fleet"]["agents"], 4)
        self.assertEqual(out["fleet"]["sessions"], {"value": 2, "prev": 1, "delta": 1})


class Todo(_Fleet):
    def test_spike_rules_doubling_and_two_percent(self):
        # alpha：工具失败率 1/100=1% → 3/100=3%（翻倍且 ≥2%）⇒ 报；
        #        空响应率 1/50=2% → 3/100=3%（≥2% 但没翻倍）⇒ 不报
        seed(self, "alpha", 100, 50, blank=3, prev_blank=1, tools=100, failed=3,
             prev_tools=100, prev_failed=1)
        # beta：工具失败率 0 → 1/100=1%（翻倍但 <2%）⇒ 不报；空响应率 0 → 2/100=2% ⇒ 报（0 的两倍仍是 0）
        seed(self, "beta", 100, 100, blank=2, tools=100, failed=1, prev_tools=100)
        out = self.fleet()
        kinds = [(t["kind"], t["agent_name"]) for t in out["todo"]]
        self.assertEqual(kinds, [("tool_failure_spike", "alpha"), ("blank_spike", "beta")])
        t = out["todo"][0]
        self.assertEqual(t["layer"], "observe")
        self.assertEqual(t["action"], "view")
        self.assertEqual(t["target"], {"plan_id": None, "run_key": None})
        self.assertIn("3.0%", t["fact"])
        self.assertIn("1.0%", t["fact"])

    def test_prev_null_never_spikes(self):
        seed(self, "alpha", 100, 0, blank=50, tools=10, failed=10)   # 前窗无会话 ⇒ prev null
        self.assertEqual(self.fleet()["todo"], [])

    def test_run_failed_and_evaluator_alert_ordering_and_no_budget(self):
        seed(self, "alpha", 1, 1)
        seed(self, "beta", 1, 1)
        self.runs = [
            run("plan-b#4", status="running", plan_id="plan-b") | {"agent_name": "beta"},
            run("plan-b#3", status="error", plan_id="plan-b", finished="2026-09-03 07:00 UTC")
            | {"agent_name": "beta", "error": "Bedrock ThrottlingException"},
            run("plan-a#3", stages=[observe(0.6, 回答完整性=0.6)]) | {"agent_name": "alpha"},
            run("plan-a#2", stages=[observe(0.6, 回答完整性=0.65)]) | {"agent_name": "alpha"},
            run("plan-a#1", stages=[observe(0.6, 回答完整性=0.5)]) | {"agent_name": "alpha"},
        ]
        # 计划带 budget_usd（单次运行上限）—— 没有月度预算字段 ⇒ 不产生 budget 条目
        self.plans = [{"plan_id": "plan-a", "name": "计划 a", "agent_name": "alpha",
                       "schedule": {"cron": "cron(0 7 ? * MON *)", "budget_usd": 0.01}}]
        out = self.fleet()
        self.assertEqual([(t["kind"], t["layer"], t["agent_name"]) for t in out["todo"]],
                         [("run_failed", "observe", "beta"),
                          ("evaluator_below_target", "evaluate", "alpha")])
        rf = out["todo"][0]
        self.assertEqual(rf["action"], "view")
        self.assertEqual(rf["target"], {"plan_id": "plan-b", "run_key": "plan-b#3"})
        self.assertIn("计划 plan-b", rf["fact"])
        self.assertIn("ThrottlingException", rf["fact"])
        ev = out["todo"][1]
        self.assertEqual(ev["target"], {"plan_id": "plan-a", "run_key": "plan-a#3"})
        self.assertIn("回答完整性", ev["fact"])
        self.assertIn("3 次", ev["fact"])
        self.assertNotIn("budget", [t["kind"] for t in out["todo"]])


class PriceFanout(_Fleet):
    """价目表进「读一次再分发」的队形：扇出多少个 Agent 都只查 PRICE 分区一次。"""

    def test_prices_are_read_once_for_the_whole_fleet(self):
        seed(self, "alpha", 1, 1)
        seed(self, "beta", 1, 1)
        out = self.fleet()
        self.assertEqual(self.query.call_count, 2, "每 Agent 一条 Insights 查询（不变）")
        self.assertEqual(self.get_prices.call_count, 1,
                         "两个 Agent 只读一次价目表（原先各读一次）")
        # 注入没有改数：成本还是算得出来的
        self.assertIsNotNone(out["fleet"]["cost_usd"]["value"])

    def test_price_read_failure_falls_back_to_per_agent(self):
        seed(self, "alpha", 1, 1)
        seed(self, "beta", 1, 1)
        self.get_prices.side_effect = [RuntimeError("ddb down"), PRICES, PRICES]
        out = self.fleet()
        # 1 次预读（失败）+ 每个 Agent 各自补读 1 次 = 3；两个 Agent 都没垮
        self.assertEqual(self.get_prices.call_count, 3, "预读失败 ⇒ 逐 Agent 自己读")
        self.assertEqual(out["fleet"]["agents"], 2)
        for name, why in out["unavailable"].items():
            self.assertNotIn("agent_status", why, f"{name} 不许因价目表预读失败而降级")
        self.assertIsNotNone(out["fleet"]["cost_usd"]["value"])


class Cache(_Fleet):
    def test_hit_within_ttl_then_expire_and_refresh(self):
        seed(self, "alpha", 1, 1)
        seed(self, "beta", 1, 1)
        clock = {"t": 1000.0}
        with mock.patch.object(fleetstatus.ttlcache, "_monotonic",
                               side_effect=lambda: clock["t"]):
            first = self.fleet()
            self.assertFalse(first["cached"])
            self.assertEqual(first["cache_age_s"], 0)
            self.assertEqual(first["computed_at"], first["generated_at"],
                             "computed_at 是「数据时刻」的正名，与 generated_at 同值")
            self.assertEqual(self.query.call_count, 2)
            clock["t"] += 299
            second = self.fleet()
            self.assertTrue(second["cached"])
            self.assertEqual(second["generated_at"], first["generated_at"])
            self.assertEqual(second["computed_at"], first["computed_at"],
                             "命中时数据时刻不动")
            self.assertEqual(second["cache_age_s"], 299)
            self.assertEqual(second["agents"], first["agents"])
            self.assertEqual(self.query.call_count, 2, "缓存命中不许再发查询")
            # window_hours 不同 = 另一个键
            self.assertFalse(self.fleet(window_hours=6)["cached"])
            self.assertEqual(self.query.call_count, 4)
            # refresh 绕过
            self.assertFalse(self.fleet(refresh=True)["cached"])
            self.assertEqual(self.query.call_count, 6)
            clock["t"] += 301
            self.assertFalse(self.fleet()["cached"])
            self.assertEqual(self.query.call_count, 8)


class ReadOnlyThroughMain(unittest.TestCase):
    """全程走 main.invoke：DDB 写方法与 S3 put 一次都不许被调。"""

    def _invoke(self, payload, table, s3):
        import main
        fleetstatus._cache.clear()
        agentstatus._cache.clear()
        with mock.patch.object(main.catalog, "get_table", return_value=table), \
                mock.patch.object(main.catalog, "TABLE_NAME", "tbl"), \
                mock.patch.object(main.catalog, "cached_agents",
                                  return_value={"agents": [agent("alpha"), agent("beta")]}), \
                mock.patch.object(main.runstore, "_s3", return_value=s3), \
                mock.patch.object(agentstatus, "_run_insights_query", return_value=[]), \
                mock.patch.object(agentstatus.pricing, "get_prices", return_value=PRICES):
            async def go():
                return [ev async for ev in main.invoke(payload)]
            return asyncio.run(go())

    def test_dispatch_never_writes(self):
        table = mock.MagicMock()
        table.query.return_value = {"Items": []}
        table.get_item.return_value = {}
        s3 = mock.MagicMock()
        events = self._invoke({"action": "fleet_status"}, table, s3)
        self.assertEqual([e["event"] for e in events], ["fleet_status"])
        ev = events[0]
        self.assertEqual([a["agent_name"] for a in ev["agents"]], ["alpha", "beta"])
        self.assertEqual(ev["fleet"]["agents"], 2)
        for key in ("window_hours", "generated_at", "cached", "agents", "fleet", "todo",
                    "unavailable"):
            self.assertIn(key, ev)
        for w in ("put_item", "update_item", "delete_item", "batch_writer",
                  "batch_write_item", "transact_write_items"):
            self.assertFalse(getattr(table, w).called, f"table.{w} 被调用了")
        for w in ("put_object", "delete_object", "copy_object"):
            self.assertFalse(getattr(s3, w).called, f"s3.{w} 被调用了")


if __name__ == "__main__":
    unittest.main()
