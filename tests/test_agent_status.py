"""`agent_status` —— ADR-0016 ① 「现状（观测）」区的数据源（只读 action）。

钉五件事：
  1. 五个数按 24h 窗 vs 前 24h 窗**本地**聚合，Logs Insights **只发一次**查询；
     算不出的项 = null + unavailable_reason（不许编数：截断 / 查询失败 / 无日志组 /
     未定价模型 / 窗内无会话 都各有一句原因）；
  2. last_run 只讲最近一次**已结束**的 run（running 跳过）；回归那一栏只给 pass_rate
     （分母 judged_cases 不在摘要项里，X/Y 那个字段不出）；redteam_blocked ⇒ "10/12"；
  3. alerts 只有一种：同一计划下最近连续 ≥3 次 completed run 某评估器都低于目标线；
     streak 被一次达标或缺席打断就不报；
  4. next_run：cron(...) 本地推算下一次 UTC 时刻；rate(...) 相位不可知 ⇒ at=null + 原因；
  5. **不写库**：走 main.invoke 全程，DDB 写方法与 S3 put 一次都不许被调。

Run: python3 -m pytest tests/test_agent_status.py -q
"""

import asyncio
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import agentstatus  # noqa: E402

NOW = datetime(2026, 9, 3, 8, 0, tzinfo=timezone.utc)   # 周四
AGENT = {"agent_name": "support-bot", "has_logs": True,
         "log_group": "/aws/bedrock-agentcore/runtimes/support-bot-abc123-DEFAULT",
         "runtime_arn": "arn:aws:bedrock-agentcore:us-west-2:1:runtime/support-bot-abc123"}
CFG = {"log_group": AGENT["log_group"], "scope_filter": "", "service_filter": ""}
PRICES = {"prices": {"anthropic.claude-sonnet-5": {"input": 0.003, "output": 0.015}}}


def _ns(dt: datetime) -> int:
    return int(dt.timestamp() * 1_000_000_000)


def row(sid, tid, name, start, dur_s, **extra):
    """一条 Insights 结果行（字段名 = agentstatus 查询里的别名）。"""
    fields = {"sid": sid, "tid": tid, "name": name,
              "t0": str(_ns(start)), "t1": str(_ns(start + timedelta(seconds=dur_s)))}
    fields.update({k: str(v) for k, v in extra.items() if v is not None})
    return [{"field": k, "value": v} for k, v in fields.items()]


def invoke_agent_row(sid, start, dur_s, out_tok=100, model="us.anthropic.claude-sonnet-5",
                     finish=None):
    return row(sid, f"trace-{sid}", "invoke_agent Strands Agents", start, dur_s,
               scope_name="strands.telemetry.tracer", model=model,
               in_tok=1000, out_tok=out_tok, finish_reasons=finish)


def tool_row(sid, start, status_code="OK", tool_status="success"):
    return row(sid, f"trace-{sid}", "execute_tool lookup", start, 0.2,
               scope_name="strands.telemetry.tracer",
               status_code=status_code, tool_status=tool_status)


def cur(h):
    """本窗内的时刻：now - h 小时（0 < h < 24）。"""
    return NOW - timedelta(hours=h)


def prev(h):
    """前窗内的时刻：now - 24h - h 小时。"""
    return NOW - timedelta(hours=24 + h)


class _Base(unittest.TestCase):
    def setUp(self):
        agentstatus._cache.clear()  # 进程内缓存跨用例会串（同 agent+窗 = 同一个键）
        self.addCleanup(agentstatus._cache.clear)
        self.rows = []
        self.query = mock.Mock(side_effect=lambda *a, **k: self.rows)
        self.runs = []
        self.plans = []
        patches = [
            mock.patch.object(agentstatus, "_now", return_value=NOW),
            mock.patch.object(agentstatus, "_run_insights_query", self.query),
            mock.patch.object(agentstatus.catalog, "cached_agents",
                              return_value={"agents": [AGENT]}),
            mock.patch.object(agentstatus.tracesource, "resolve_span_config",
                              return_value=CFG),
            mock.patch.object(agentstatus.planrun, "list_recent_runs",
                              side_effect=lambda **k: self.runs),
            mock.patch.object(agentstatus.plan_mod, "list_plans",
                              side_effect=lambda *a, **k: self.plans),
            mock.patch.object(agentstatus.pricing, "get_prices", return_value=PRICES),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def status(self, name="support-bot", refresh=False):
        return agentstatus.agent_status(name, refresh=refresh)


class UnknownAgent(_Base):
    def test_error_wording(self):
        with self.assertRaises(ValueError) as cm:
            self.status("ghost")
        self.assertEqual(str(cm.exception), "Agent 'ghost' 不存在")


class CacheTokens(unittest.TestCase):
    """prompt-cache token 要进 Insights 投影并映射回 span attrs（metrics 才算得到）。

    现场（dsh harness，2026-09-04）：chat span 的 gen_ai.usage.input_tokens=3，
    cache_read.input_tokens=7932 —— 只投影 input_tokens 就是「8 次调用输入 36」。"""

    def test_query_projects_both_cache_spellings(self):
        q = agentstatus.build_status_query()
        for f in ("attributes.gen_ai.usage.cache_read.input_tokens",
                  "attributes.gen_ai.usage.cache_write.input_tokens",
                  "attributes.gen_ai.usage.cache_read_input_tokens",
                  "attributes.gen_ai.usage.cache_write_input_tokens"):
            self.assertIn(f, q)

    def test_rows_to_spans_maps_cache_fields_and_metrics_count_them(self):
        from metrics import compute_session_metrics
        rows = [row("s1", "t1", "chat us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                    NOW, 1.0, scope_name="opentelemetry.instrumentation.deepseek_harness",
                    model="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                    in_tok=3, out_tok=351, cr_tok=7932, cw_tok=834),
                row("s1", "t1", "chat", NOW, 1.0,
                    scope_name="opentelemetry.instrumentation.deepseek_harness",
                    in_tok=6, out_tok=111, cr_tok2=500, cw_tok2=0)]
        spans = agentstatus._rows_to_spans(rows)
        self.assertEqual(spans[0]["attributes"]["gen_ai.usage.cache_read.input_tokens"], 7932)
        self.assertEqual(spans[1]["attributes"]["gen_ai.usage.cache_read_input_tokens"], 500)
        m = compute_session_metrics(
            spans, {"anthropic.claude-sonnet-4-5": {"input": 0.003, "output": 0.015}})
        self.assertEqual(m["tokens"]["input"], 3 + 7932 + 834 + 6 + 500)
        self.assertEqual(m["tokens"]["input_uncached"], 9)
        self.assertEqual(m["tokens"]["cache_read"], 8432)
        self.assertEqual(m["tokens"]["cache_write"], 834)
        self.assertEqual(m["cost"]["unpriced_models"], [])


class Metrics(_Base):
    def seed_two_windows(self):
        # 本窗：3 会话；s2 的最后一次 invoke_agent 输出 0 token = 空响应；
        # 4 次工具调用其中 1 次 ERROR；三条 trace 端到端 2s / 4s / 10s ⇒ p95 = 10s
        self.rows += [
            invoke_agent_row("s1", cur(1), 2.0),
            invoke_agent_row("s2", cur(2), 4.0, out_tok=0),
            invoke_agent_row("s3", cur(3), 10.0),
            tool_row("s1", cur(1)), tool_row("s1", cur(1)),
            tool_row("s3", cur(3)), tool_row("s3", cur(3), status_code="ERROR",
                                             tool_status="error"),
        ]
        # 前窗：2 会话，无空响应，1 次工具调用（成功），trace 3s / 5s ⇒ p95 = 5s
        self.rows += [
            invoke_agent_row("p1", prev(1), 3.0),
            invoke_agent_row("p2", prev(2), 5.0),
            tool_row("p1", prev(1)),
        ]

    def test_one_query_and_five_numbers_with_deltas(self):
        self.seed_two_windows()
        out = self.status()
        self.assertEqual(self.query.call_count, 1, "五个数只许一次 Logs Insights 查询")
        self.assertEqual(out["event"], "agent_status")
        self.assertEqual(out["window_hours"], 24)
        m = out["metrics"]
        self.assertEqual(m["sessions"], {"value": 3, "prev": 2, "delta": 1})
        self.assertEqual(m["p95_latency_ms"], {"value": 10000, "prev": 5000, "delta": 5000})
        self.assertEqual(m["blank_rate"], {"value": round(1 / 3, 4), "prev": 0.0,
                                           "delta": round(1 / 3, 4)})
        self.assertEqual(m["tool_failure_rate"], {"value": 0.25, "prev": 0.0, "delta": 0.25})
        # 成本 = 每条 invoke_agent 1000 in / out 累计 × sonnet-5 单价
        # 本窗 in 3000 / out 200；前窗 in 2000 / out 200
        self.assertEqual(m["agent_cost_usd"]["value"], round(3 * 0.003 + 0.2 * 0.015, 4))
        self.assertEqual(m["agent_cost_usd"]["prev"], round(2 * 0.003 + 0.2 * 0.015, 4))
        self.assertEqual(out["unavailable_reason"], {})

    def test_query_window_covers_both_periods_and_excludes_evaltest(self):
        self.seed_two_windows()
        self.status()
        log_group, query, lookback_days = self.query.call_args.args
        self.assertEqual(log_group, CFG["log_group"])
        self.assertEqual(lookback_days, 2)
        self.assertIn("not like 'evaltest'", query)
        self.assertIn("limit 10000", query)

    def test_unpriced_model_gives_null_cost_with_reason(self):
        self.rows = [invoke_agent_row("s1", cur(1), 2.0, model="ppio.kimi-k2")]
        out = self.status()
        self.assertIsNone(out["metrics"]["agent_cost_usd"]["value"])
        self.assertIn("ppio.kimi-k2", out["unavailable_reason"]["agent_cost_usd"])

    def test_empty_window_reasons(self):
        self.rows = []
        out = self.status()
        m = out["metrics"]
        self.assertEqual(m["sessions"], {"value": 0, "prev": 0, "delta": 0})
        self.assertIsNone(m["p95_latency_ms"]["value"])
        self.assertEqual(m["agent_cost_usd"], {"value": 0.0, "prev": 0.0, "delta": 0.0})
        for k in ("p95_latency_ms", "blank_rate", "tool_failure_rate"):
            self.assertIn("无会话", out["unavailable_reason"][k], k)

    def test_truncated_result_nulls_everything(self):
        self.rows = [invoke_agent_row(f"s{i}", cur(1), 1.0) for i in range(10000)]
        out = self.status()
        for k, v in out["metrics"].items():
            self.assertEqual(v, {"value": None, "prev": None, "delta": None}, k)
            self.assertIn("10000", out["unavailable_reason"][k])

    def test_query_failure_nulls_everything_with_reason(self):
        self.query.side_effect = TimeoutError("Logs Insights query timed out for lg")
        out = self.status()
        for k, v in out["metrics"].items():
            self.assertEqual(v, {"value": None, "prev": None, "delta": None}, k)
            self.assertIn("timed out", out["unavailable_reason"][k])

    def test_no_span_source_at_all(self):
        with mock.patch.object(agentstatus.tracesource, "resolve_span_config",
                               return_value=None):
            out = self.status()
        self.assertEqual(self.query.call_count, 0)
        self.assertIsNone(out["metrics"]["sessions"]["value"])
        self.assertIn("日志组", out["unavailable_reason"]["sessions"])
        self.assertIsNone(out["cloudwatch_url"])
        self.assertIn("日志组", out["unavailable_reason"]["cloudwatch_url"])

    def test_cloudwatch_url_points_at_the_log_group(self):
        out = self.status()
        self.assertEqual(
            out["cloudwatch_url"],
            "https://us-west-2.console.aws.amazon.com/cloudwatch/home?region=us-west-2"
            "#logsV2:log-groups/log-group/$252Faws$252Fbedrock-agentcore$252Fruntimes"
            "$252Fsupport-bot-abc123-DEFAULT")


def run(key, status="completed", score=None, stages=None, plan_id="plan-a", finished="t"):
    return {"run_key": key, "plan_id": plan_id, "plan_name": f"计划 {plan_id}",
            "status": status, "score": score, "finished_at": finished,
            "stage_summaries": stages or []}


def observe(mean, **evals):
    return {"type": "observe", "status": "completed", "overall_mean": mean,
            "summary": {k: {"mean_score": v, "pass_rate": None} for k, v in evals.items()}}


def dataset(pass_rate, cases, **evals):
    return {"type": "dataset", "status": "completed", "pass_rate": pass_rate,
            "cases": cases, "blank_cases": 0,
            "evaluator_stats": {k: {"mean": v, "passed": 0, "judged": cases}
                                for k, v in evals.items()}}


def redteam(breached, attacks):
    return {"type": "redteam", "status": "completed", "breached": breached,
            "attacks": attacks}


class LastRun(_Base):
    def test_none_when_no_runs(self):
        self.assertIsNone(self.status()["last_run"])

    def test_skips_running_and_reports_three_stage_kinds(self):
        self.runs = [
            run("plan-a#3", status="running"),
            run("plan-a#2", score=0.86, finished="2026-09-02 07:12 UTC",
                stages=[observe(0.86, helpfulness=0.86),
                        dataset(0.9444, 18, correctness=0.9),
                        redteam(2, 12)]),
            run("plan-a#1", score=0.80),
        ]
        out = self.status()
        lr = out["last_run"]
        self.assertEqual(lr["run_key"], "plan-a#2")
        self.assertEqual(lr["plan_id"], "plan-a")
        self.assertEqual(lr["status"], "completed")
        self.assertEqual(lr["observe_mean"], 0.86)
        self.assertEqual(lr["dataset_pass_rate"], 0.9444)
        # X/Y 那一栏连字段都不出（原先是恒 None 的 dataset_pass + 一条取不到的 reason）
        self.assertNotIn("dataset_pass", lr)
        self.assertNotIn("last_run.dataset_pass", out["unavailable_reason"])
        self.assertEqual(lr["redteam_blocked"], "10/12")
        self.assertEqual(lr["finished_at"], "2026-09-02 07:12 UTC")

    def test_untested_kinds_are_null_without_reason(self):
        self.runs = [run("plan-a#1", score=0.8, stages=[observe(0.8, helpfulness=0.8)])]
        out = self.status()
        self.assertNotIn("dataset_pass", out["last_run"])
        self.assertIsNone(out["last_run"]["dataset_pass_rate"])
        self.assertIsNone(out["last_run"]["redteam_blocked"])
        self.assertNotIn("last_run.dataset_pass", out["unavailable_reason"])


class Alerts(_Base):
    def test_streak_of_four_below_target(self):
        # 新→旧：0.77 0.76 0.78 0.79 都 < 0.7? 不是 —— 用低于 0.7 的值
        self.runs = [
            run("plan-a#4", score=0.67, stages=[observe(0.67, 回答完整性=0.67, helpfulness=0.9)]),
            run("plan-a#3", score=0.66, stages=[observe(0.66, 回答完整性=0.66, helpfulness=0.6)]),
            run("plan-a#2", score=0.68, stages=[observe(0.68, 回答完整性=0.68, helpfulness=0.5)]),
            run("plan-a#1", score=0.69, stages=[observe(0.69, 回答完整性=0.69, helpfulness=0.9)]),
        ]
        alerts = self.status()["alerts"]
        self.assertEqual(len(alerts), 1, alerts)
        a = alerts[0]
        self.assertEqual(a["kind"], "evaluator_below_target")
        self.assertEqual(a["evaluator"], "回答完整性")
        self.assertEqual(a["plan_id"], "plan-a")
        self.assertEqual(a["target"], agentstatus.ALERT_TARGET)
        self.assertEqual(a["streak"], 4)
        self.assertEqual(a["values"], [0.69, 0.68, 0.66, 0.67])   # 旧→新
        self.assertEqual(a["since_run"], "plan-a#1")
        self.assertEqual(a["until_run"], "plan-a#4")

    def test_two_below_is_not_an_alert(self):
        self.runs = [
            run("plan-a#3", stages=[observe(0.6, x=0.6)]),
            run("plan-a#2", stages=[observe(0.6, x=0.6)]),
            run("plan-a#1", stages=[observe(0.9, x=0.9)]),
        ]
        self.assertEqual(self.status()["alerts"], [])

    def test_non_completed_runs_do_not_count_and_dataset_evaluators_do(self):
        self.runs = [
            run("plan-a#5", status="error", stages=[]),
            run("plan-a#4", stages=[dataset(0.5, 10, correctness=0.5)]),
            run("plan-a#3", stages=[dataset(0.5, 10, correctness=0.4)]),
            run("plan-a#2", stages=[dataset(0.5, 10, correctness=0.3)]),
            run("plan-a#1", stages=[dataset(0.9, 10, correctness=0.9)]),
        ]
        alerts = self.status()["alerts"]
        self.assertEqual([(a["evaluator"], a["streak"]) for a in alerts], [("correctness", 3)])

    def test_streaks_are_per_plan(self):
        self.runs = [
            run("plan-a#2", stages=[observe(0.6, x=0.6)]),
            run("plan-b#1", plan_id="plan-b", stages=[observe(0.6, x=0.6)]),
            run("plan-a#1", stages=[observe(0.6, x=0.6)]),
        ]
        self.assertEqual(self.status()["alerts"], [])


class NextRun(_Base):
    def test_none_when_nothing_scheduled(self):
        self.plans = [{"plan_id": "p", "name": "n", "schedule": None}]
        self.assertIsNone(self.status()["next_run"])

    def test_cron_next_fire_utc(self):
        self.plans = [
            {"plan_id": "p1", "name": "周一巡检",
             "schedule": {"cron": "cron(0 7 ? * MON *)", "budget_usd": 6.0}},
            {"plan_id": "p2", "name": "每天",
             "schedule": {"cron": "cron(30 9 * * ? *)", "budget_usd": 1.0}},
        ]
        nr = self.status()["next_run"]
        # NOW = 周四 08:00 ⇒ 最近的是当天 09:30 的 p2
        self.assertEqual(nr, {"plan_id": "p2", "plan_name": "每天",
                              "at": "2026-09-03T09:30:00Z", "budget_usd": 1.0})

    def test_cron_monday_from_thursday(self):
        self.assertEqual(agentstatus.next_cron_fire("cron(0 7 ? * MON *)", NOW),
                         datetime(2026, 9, 7, 7, 0, tzinfo=timezone.utc))
        # EventBridge 数字 dow：1=周日 ⇒ 2=周一
        self.assertEqual(agentstatus.next_cron_fire("cron(0 7 ? * 2 *)", NOW),
                         datetime(2026, 9, 7, 7, 0, tzinfo=timezone.utc))
        # 步进 / 区间 / 月名
        self.assertEqual(agentstatus.next_cron_fire("cron(*/15 8 ? SEP * *)", NOW),
                         datetime(2026, 9, 3, 8, 15, tzinfo=timezone.utc))
        self.assertEqual(agentstatus.next_cron_fire("cron(0 0 1 * ? *)", NOW),
                         datetime(2026, 10, 1, 0, 0, tzinfo=timezone.utc))
        # 年字段限定过去 ⇒ 永不触发
        self.assertIsNone(agentstatus.next_cron_fire("cron(0 0 * * ? 2025)", NOW))
        # L/W/# 扩展语法 ⇒ 不推算
        self.assertIsNone(agentstatus.next_cron_fire("cron(0 0 L * ? *)", NOW))

    def test_rate_expression_has_unknown_phase(self):
        self.plans = [{"plan_id": "p1", "name": "每 7 天",
                       "schedule": {"cron": "rate(7 days)", "budget_usd": 2.0}}]
        out = self.status()
        self.assertEqual(out["next_run"], {"plan_id": "p1", "plan_name": "每 7 天",
                                           "at": None, "budget_usd": 2.0})
        self.assertIn("rate(7 days)", out["unavailable_reason"]["next_run.at"])


class ReadOnlyThroughMain(unittest.TestCase):
    """全程走 main.invoke：DDB 写方法与 S3 put 一次都不许被调。"""

    def setUp(self):
        # 不清就可能命中缓存 ⇒ 一次库都不读，「零写」判据结构上不可能红（假绿）
        agentstatus._cache.clear()
        self.addCleanup(agentstatus._cache.clear)

    def _invoke(self, payload, table, s3):
        import main
        with mock.patch.object(main.catalog, "get_table", return_value=table), \
                mock.patch.object(main.catalog, "TABLE_NAME", "tbl"), \
                mock.patch.object(main.catalog, "cached_agents",
                                  return_value={"agents": [AGENT]}), \
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
        events = self._invoke({"action": "agent_status", "agent_name": "support-bot"}, table, s3)
        self.assertEqual([e["event"] for e in events], ["agent_status"])
        ev = events[0]
        self.assertEqual(ev["agent_name"], "support-bot")
        for key in ("metrics", "hourly", "last_run", "alerts", "next_run", "cloudwatch_url",
                    "unavailable_reason"):
            self.assertIn(key, ev)
        for w in ("put_item", "update_item", "delete_item", "batch_writer",
                  "batch_write_item", "transact_write_items"):
            self.assertFalse(getattr(table, w).called, f"table.{w} 被调用了")
        for w in ("put_object", "delete_object", "copy_object"):
            self.assertFalse(getattr(s3, w).called, f"s3.{w} 被调用了")

    def test_unknown_agent_error_frame(self):
        table = mock.MagicMock()
        s3 = mock.MagicMock()
        events = self._invoke({"action": "agent_status", "agent_name": "ghost"}, table, s3)
        self.assertEqual(events, [{"event": "error", "error": "Agent 'ghost' 不存在"}])
        self.assertFalse(table.put_item.called)

    def test_missing_name(self):
        events = self._invoke({"action": "agent_status"}, mock.MagicMock(), mock.MagicMock())
        self.assertEqual(events, [{"event": "error", "error": "agent_name is required."}])


class Cache(_Base):
    """进程内缓存：命中不再发 Insights 查询；键含 window_hours；refresh 绕过。"""

    def test_hit_within_ttl_then_window_key_then_refresh_then_expire(self):
        clock = {"t": 1000.0}
        with mock.patch.object(agentstatus.ttlcache, "_monotonic",
                               side_effect=lambda: clock["t"]):
            first = self.status()
            self.assertFalse(first["cached"])
            self.assertEqual(first["cache_age_s"], 0)
            self.assertEqual(self.query.call_count, 1)

            clock["t"] += 299
            second = self.status()
            self.assertTrue(second["cached"])
            self.assertEqual(second["cache_age_s"], 299)
            self.assertEqual(self.query.call_count, 1, "缓存命中不许再发查询")
            self.assertEqual({k: v for k, v in second.items()
                              if k not in ("cached", "cache_age_s")},
                             {k: v for k, v in first.items()
                              if k not in ("cached", "cache_age_s")})

            # window_hours 不同 = 另一个键
            self.assertFalse(agentstatus.agent_status("support-bot",
                                                      window_hours=6)["cached"])
            self.assertEqual(self.query.call_count, 2)

            # refresh 绕过并覆盖
            self.assertFalse(self.status(refresh=True)["cached"])
            self.assertEqual(self.query.call_count, 3)
            self.assertEqual(self.status()["cache_age_s"], 0, "refresh 覆盖了写入时刻")

            clock["t"] += 301
            self.assertFalse(self.status()["cached"])
            self.assertEqual(self.query.call_count, 4)

    def test_unknown_agent_still_raises_when_a_cached_entry_exists(self):
        self.status()
        with self.assertRaises(ValueError) as cm:
            self.status("ghost")
        self.assertEqual(str(cm.exception), "Agent 'ghost' 不存在")

    def test_build_status_write_is_what_fleet_reuses(self):
        # fleet_status 不经 agent_status，直接调 build_status ⇒ 它也得把缓存写上
        agent = agentstatus._find_agent("support-bot")
        agentstatus.build_status(agent, window_hours=24, now=NOW, runs=[], plans=[])
        self.assertEqual(self.query.call_count, 1)
        self.assertTrue(self.status()["cached"])
        self.assertEqual(self.query.call_count, 1)


if __name__ == "__main__":
    unittest.main()
