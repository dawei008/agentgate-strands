"""只用上报数据评估（ADR-0019 批 1）：trace_required 开关 → no_trace 标记 → 分母排除。

三层各钉一组：
  · tracesource：Agent 侧 span 的查询 —— service.name 过滤把平台自家（evalanything.DEFAULT）
    排掉、配了 service_filter 用等号点名、内容判据覆盖 _adapt_central_span 的合成来源、
    结果按会话聚合、超过一批就分两次查；
  · testrun：trace 字段五种原因（no_span / no_content / no_span_source / fetch_error /
    unsampled）、多会话行（红队）全到位才 ok、run 级降级三态（ok / degraded_no_trace / no_trace）；
  · planrun：开关关时环节返回与摘要**形状逐字节不变**、一次查询都不发；开关开时 no_trace
    行不入 pass_rate / 评估器统计分母、全缺 ⇒ 环节状态 no_trace 且评估器一列不出分、
    红队攻破率按剔除后重算、退避重查与错误分档、主组查无回退查 runtime 日志组
    （统一 span 目的地的 Agent 不进 aws/spans）、平台未采样 ⇒ unsampled、环节一行文案。

现网核对（不进 CI，2026-09-07 实跑 `tracesource.check_agent_traces` 对 aws/spans）：
  evaltest-202609040658-10671fa7… 无过滤 1 条 span（evalanything.DEFAULT）→ 过滤后**查无**；
  evaltest-rt-20260904025-9f7ee0… 无过滤 113 条（deepseek-harness）→ 过滤后 113 条 / 51 条带内容。
不碰真表 / 真 AWS：Insights 查询与环节执行都打桩。
运行：python3 -m pytest tests/test_trace_required.py -q
"""

import asyncio
import inspect
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

from botocore.exceptions import ClientError

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import plan as plan_mod  # noqa: E402
import planrun  # noqa: E402
import testrun  # noqa: E402
import tracesource  # noqa: E402

AGENT_NAME = "support-bot"
DATASET = {"name": "regression-v1", "cases": [{"name": "c1", "input": "hi"}]}
# 2026-09-08 起默认开：缺键 = 开，所以「关」必须显式写 False（下面的逐字节不变快照钉的是显式关）。
PLAN_OFF = {"plan_id": "plan-1297bb07bc31", "name": "回归周巡检",
            "agent_name": AGENT_NAME, "stages": [], "trace_required": False}
PLAN_ON = {**PLAN_OFF, "trace_required": True}
PLAN_UNSET = {k: v for k, v in PLAN_OFF.items() if k != "trace_required"}
AGENT = {"agent_name": AGENT_NAME, "runtime_arn": "arn:aws:bedrock:x:y:runtime/z"}
STAGE = {"type": "dataset", "dataset": DATASET["name"],
         "evaluators": ["correctness", "helpfulness"], "agent_model": "m"}
RUNTIME_GROUP = "/aws/bedrock-agentcore/runtimes/support-bot-AbC123-DEFAULT"
CFG_CENTRAL = {"log_group": "aws/spans", "scope_filter": "", "service_filter": ""}
CFG_WITH_FALLBACK = {**CFG_CENTRAL, "fallback_log_group": RUNTIME_GROUP}
NOT_FOUND = ClientError({"Error": {"Code": "ResourceNotFoundException", "Message": "x"}}, "StartQuery")


def verdict(passed: bool, score: float = 0.9) -> dict:
    return {"score": score, "passed": passed, "errored": False, "reason": "…"}


def case_row(name: str, results: dict, **extra) -> dict:
    row = {"agent": AGENT_NAME, "case": name, "input": "hi", "output": "答案",
           "session_id": f"evaltest-{name}", "results": results,
           "started_epoch": 1, "finished_epoch": 2, "duration_s": 0.4}
    row.update(extra)
    return row


def run_payload(rows: list[dict], **extra) -> dict:
    run = {"run_id": "run-20260907120000", "dataset": DATASET["name"],
           "agents": [AGENT_NAME], "evaluators": STAGE["evaluators"],
           "judge_model": "judge", "status": "completed",
           "total_cases": len(rows), "completed_cases": len(rows),
           "results": rows, "actual_cost_usd": 0.12, "blank_cases": 0,
           "error_cases": 0, "live_turns": [], "cache_mode": "off"}
    run.update(extra)
    return run


def hit(spans: int, content: int, svc: str = "deepseek-harness") -> dict:
    return {"spans": spans, "content_spans": content, "services": [svc]}


# ---------------- tracesource：Agent 侧 span 的查询 ----------------

class TraceQuery(unittest.TestCase):
    def test_platform_service_is_excluded_by_name(self):
        """平台自家 span 与被测 Agent 的 span 共用同一个 session.id：不排掉它，「有 span」恒真。"""
        q = tracesource.build_agent_side_filter()
        self.assertIn(f'resource.attributes.service.name != "{tracesource.PLATFORM_SERVICE_NAME}"', q)
        self.assertIn("not ispresent(resource.attributes.service.name)", q)
        self.assertTrue(tracesource.PLATFORM_SERVICE_NAME.endswith(".DEFAULT"))

    def test_configured_service_filter_pins_the_agent_by_equality(self):
        q = tracesource.build_agent_side_filter("deepseek-harness")
        self.assertEqual(q, ' | filter resource.attributes.service.name = "deepseek-harness"')
        self.assertNotIn("!=", q)

    def test_query_filters_the_batch_and_counts_content_spans(self):
        q = tracesource.build_trace_check_query(["evaltest-a", 'x"y'])
        self.assertIn('attributes.session.id in ["evaltest-a", "x\\"y"]', q)
        for attr in tracesource.CONTENT_ATTRS:
            self.assertIn(f"ispresent(attributes.{attr})", q)
        self.assertIn("sum(has_content) as content_spans by sid, svc", q)

    def test_content_attrs_cover_what_adapt_central_span_synthesizes_from(self):
        """「带对话内容」的判据必须包住 _adapt_central_span 合成 gen_ai.*.messages 的来源字段，
        否则现网那种只写 gen_ai.task.* 的 Agent 会被误标 no_content。"""
        src = inspect.getsource(tracesource._adapt_central_span)
        used = set(re.findall(r'attrs\.get\("((?:gen_ai|agentcore)\.[a-z_.]+)"\)', src))
        used |= set(re.findall(r'attrs\["((?:gen_ai|agentcore)\.[a-z_.]+)"\]', src))
        content_sources = {a for a in used if "system_instructions" not in a
                           and "conversation.id" not in a and "operation.name" not in a}
        self.assertTrue(content_sources, "正则没抓到任何来源字段——判据自身失效")
        self.assertTrue(content_sources <= set(tracesource.CONTENT_ATTRS),
                        f"漏了：{content_sources - set(tracesource.CONTENT_ATTRS)}")

    def test_check_aggregates_rows_per_session_and_chunks_batches(self):
        sids = [f"s{i}" for i in range(tracesource.TRACE_CHECK_BATCH + 1)]

        def fake_query(log_group, query, lookback_days):
            self.assertEqual(log_group, RUNTIME_GROUP)
            self.assertEqual(lookback_days, 1)
            if '"s0"' in query:
                return [
                    [{"field": "sid", "value": "s0"}, {"field": "svc", "value": "deepseek-harness"},
                     {"field": "spans", "value": "113"}, {"field": "content_spans", "value": "51"}],
                    [{"field": "sid", "value": "s0"}, {"field": "svc", "value": "other"},
                     {"field": "spans", "value": "2"}, {"field": "content_spans", "value": "0"}],
                    [{"field": "sid", "value": "s1"}, {"field": "svc", "value": "other"},
                     {"field": "spans", "value": "3"}, {"field": "content_spans", "value": "0"}],
                ]
            return []

        with mock.patch.object(tracesource, "_run_insights_query", side_effect=fake_query) as q:
            out = tracesource.check_agent_traces(
                sids, plan=tracesource.read_plans({"log_group": RUNTIME_GROUP},
                                                  spans_only=True)[0])
        self.assertEqual(q.call_count, 2, "超过一批的会话要分两次查")
        self.assertEqual(out["s0"], {"spans": 115, "content_spans": 51,
                                     "services": ["deepseek-harness", "other"]})
        self.assertEqual(out["s1"], {"spans": 3, "content_spans": 0, "services": ["other"]})
        self.assertNotIn("s2", out, "查无的会话不出现在结果里（调用方据此判 no_span）")

    def test_default_group_is_central_spans(self):
        with mock.patch.object(tracesource, "_run_insights_query", return_value=[]) as q:
            tracesource.check_agent_traces(["s0"])
        self.assertEqual(q.call_args[0][0], tracesource.CENTRAL_SPANS_LOG_GROUP)


# ---------------- testrun：trace 字段与 run 级三态 ----------------

class TraceField(unittest.TestCase):
    def test_four_reasons_and_ok(self):
        checks = {"a": hit(5, 3), "b": hit(2, 0)}
        self.assertEqual(testrun.trace_field(["a"], checks, sources=["aws/spans"]),
                         {"status": "ok", "reason": None, "spans": 5, "sources": ["aws/spans"]})
        self.assertEqual(testrun.trace_field(["b"], checks),
                         {"status": "no_trace", "reason": "no_content", "spans": 2, "sources": []})
        self.assertEqual(testrun.trace_field(["c"], checks, sources=["aws/spans", RUNTIME_GROUP]),
                         {"status": "no_trace", "reason": "no_span", "spans": 0,
                          "sources": ["aws/spans", RUNTIME_GROUP]})
        self.assertEqual(testrun.trace_field(["c"], checks, "no_span_source")["reason"], "no_span_source")
        self.assertEqual(testrun.trace_field(["c"], checks, "fetch_error")["reason"], "fetch_error")

    def test_unsampled_is_its_own_reason_not_no_span(self):
        """平台自己这次调用未采样 ⇒ Agent 侧整条 trace 被丢：查无 span 的成因是采样，不是没接观测。"""
        self.assertEqual(testrun.trace_field(["c"], {}, sampled=False)["reason"], "unsampled")
        self.assertEqual(testrun.trace_field(["c"], {}, sampled=True)["reason"], "no_span")
        self.assertEqual(testrun.trace_field(["c"], {}, sampled=None)["reason"], "no_span",
                         "拿不到采样位就不下 unsampled 的结论")
        # 有 span 但没内容：与采样无关，仍是 no_content
        self.assertEqual(testrun.trace_field(["b"], {"b": hit(2, 0)}, sampled=False)["reason"], "no_content")
        # 查询故障优先于采样判断
        self.assertEqual(testrun.trace_field(["c"], {}, "fetch_error", sampled=False)["reason"], "fetch_error")

    def test_query_error_does_not_undo_sessions_already_found(self):
        checks = {"a": hit(5, 3)}
        self.assertEqual(testrun.trace_field(["a"], checks, "fetch_error")["status"], "ok")

    def test_redteam_row_needs_every_session_and_empty_list_is_no_span(self):
        checks = {"a": hit(5, 3), "b": hit(2, 0)}
        row = testrun.trace_field(["a", "b"], checks)
        self.assertEqual((row["status"], row["reason"], row["spans"]), ("no_trace", "no_content", 7))
        self.assertEqual(testrun.trace_field(["a", "c"], checks)["reason"], "no_span")
        self.assertEqual(testrun.trace_field([], checks),
                         {"status": "no_trace", "reason": "no_span", "spans": 0, "sources": []})

    def test_run_level_three_states(self):
        rows = [case_row("c1", {}), case_row("c2", {})]
        sids = lambda r: [r["session_id"]]  # noqa: E731
        run = {"status": "completed"}
        s = testrun.apply_trace_check(run, rows, sids, {"evaltest-c1": hit(1, 1), "evaltest-c2": hit(1, 1)})
        self.assertEqual((s, run["trace_status"], run["status"]),
                         ({"required": True, "ok": 2, "no_trace": 0}, "ok", "completed"))
        run = {"status": "completed"}
        s = testrun.apply_trace_check(run, rows, sids, {"evaltest-c1": hit(1, 1)})
        self.assertEqual((s["no_trace"], run["trace_status"], run["status"]), (1, "degraded_no_trace", "completed"))
        run = {"status": "completed"}
        s = testrun.apply_trace_check(run, rows, sids, {})
        self.assertEqual((s["no_trace"], run["trace_status"], run["status"]), (2, "no_trace", "no_trace"))
        self.assertTrue(all(testrun.is_no_trace(r) for r in rows))

    def test_per_row_sampled_reading_wins_and_survives_the_check(self):
        """合流 span-source-fallback × trace-required-gate：run_one 调用前逐例写的
        `trace.sampled`（批 span-source-fallback）优先于环节级读数决定 unsampled，且核对
        不抹掉这个键；没有逐例读数的行（红队 / 缓存命中）才用环节级的 sampled。"""
        sids = lambda r: [r["session_id"]]  # noqa: E731
        rows = [case_row("c1", {}, trace={"sampled": False}),   # 逐例读到未采样
                case_row("c2", {}, trace={"sampled": True}),    # 逐例读到已采样、却查无
                case_row("c3", {})]                             # 没有逐例读数
        run = {"status": "completed"}
        testrun.apply_trace_check(run, rows, sids, {}, sampled=None, sources=["aws/spans"])
        by = {r["case"]: r["trace"] for r in rows}
        self.assertEqual(by["c1"], {"sampled": False, "status": "no_trace", "reason": "unsampled",
                                    "spans": 0, "sources": ["aws/spans"]})
        self.assertEqual((by["c2"]["sampled"], by["c2"]["reason"]), (True, "no_span"))
        self.assertEqual(by["c3"], {"status": "no_trace", "reason": "no_span", "spans": 0,
                                    "sources": ["aws/spans"]}, "没有逐例读数就不凭空写 sampled")
        # 环节级 False 只兜没有逐例读数的行；逐例 True 的行不被它改成 unsampled
        rows = [case_row("c2", {}, trace={"sampled": True}), case_row("c3", {})]
        testrun.apply_trace_check({"status": "completed"}, rows, sids, {}, sampled=False)
        self.assertEqual([r["trace"]["reason"] for r in rows], ["no_span", "unsampled"])

    def test_all_missing_never_overrides_a_stopped_or_halted_status(self):
        for status in (testrun.STOP_STATUS, "halted_cost", "failed"):
            run = {"status": status}
            testrun.apply_trace_check(run, [case_row("c1", {})], lambda r: [r["session_id"]], {})
            self.assertEqual(run["status"], status)
            self.assertEqual(run["trace_status"], "no_trace")


# ---------------- planrun：环节编排 ----------------

def _emit_noop():
    async def emit(_ev):
        pass
    return emit


class DatasetStage(unittest.TestCase):
    def _stage(self, run: dict, plan: dict, checks=None, error=None, sampled=None,
               cfg=CFG_CENTRAL, checker=None, backoff=(0, 0)):
        if checker is None:
            checker = mock.Mock(side_effect=error) if error else mock.Mock(return_value=checks or {})
        with mock.patch.object(planrun.catalog, "get_dataset", return_value=DATASET), \
                mock.patch.object(planrun.catalog, "list_custom_evaluators", return_value=[]), \
                mock.patch.object(planrun.testrun, "estimate_test_run",
                                  return_value={"estimated_cost_usd": 0.5}), \
                mock.patch.object(planrun.testrun, "execute_test_run",
                                  new=mock.AsyncMock(return_value=run)), \
                mock.patch.object(planrun.tracesource, "resolve_span_config", return_value=cfg), \
                mock.patch.object(planrun.tracesource, "check_agent_traces", checker), \
                mock.patch.object(planrun, "_current_trace_sampled", return_value=sampled), \
                mock.patch.object(planrun, "TRACE_CHECK_BACKOFF", backoff):
            res = asyncio.run(planrun._run_dataset_stage(STAGE, plan, AGENT, "judge-model", _emit_noop()))
        return res, checker

    # ---- 开关关：逐字节不变 ----
    def test_switch_off_is_byte_identical_and_never_queries(self):
        run = run_payload([case_row("c1", {"correctness": verdict(True)}),
                           case_row("c2", {"correctness": verdict(False, 0.2)})])
        before = {k: v for k, v in run.items()}
        res, checker = self._stage(run, PLAN_OFF)
        checker.assert_not_called()
        self.assertEqual(set(res), {"type", "status", "error", "run_id", "dataset", "evaluators",
                                    "cases", "judged_cases", "pass_rate", "blank_cases",
                                    "actual_cost_usd", "report"},
                         "开关关着的环节返回值多出/少了键")
        self.assertEqual({k: run[k] for k in before}, before, "开关关着不许改 run 的既有字段")
        self.assertNotIn("trace_summary", run)
        self.assertTrue(all("trace" not in r for r in run["results"]))
        self.assertEqual(set(planrun._stage_summary(res)),
                         {"type", "status", "pass_rate", "cases", "blank_cases",
                          "evaluators", "evaluator_stats"})
        self.assertEqual(res["pass_rate"], 0.5)

    # ---- 开关开：分母排除 ----
    def test_missing_switch_means_on(self):
        """2026-09-08 默认开：方案没有 trace_required 键 ⇒ 与显式 True 同一条路（核对、标记、排分母）。"""
        run = run_payload([case_row("c1", {"correctness": verdict(True)}),
                           case_row("c2", {"correctness": verdict(True)})])
        res, checker = self._stage(run, PLAN_UNSET, checks={"evaltest-c1": hit(4, 2)})
        self.assertTrue(checker.called)
        self.assertEqual(res["trace_summary"], {"required": True, "ok": 1, "no_trace": 1})

    def test_no_trace_rows_leave_the_denominator_and_the_evaluator_stats(self):
        run = run_payload([case_row("c1", {"correctness": verdict(True)}),
                           case_row("c2", {"correctness": verdict(False, 0.2)}),
                           case_row("c3", {"correctness": verdict(False, 0.1)})])
        res, _ = self._stage(run, PLAN_ON, checks={"evaltest-c1": hit(4, 2), "evaltest-c2": hit(3, 1),
                                                   "evaltest-c3": hit(2, 0)})   # c3 只有元数据
        self.assertEqual(res["judged_cases"], 2)
        self.assertEqual(res["pass_rate"], 0.5, "no_trace 的 c3 不许进分母（进了就是 0.33）")
        self.assertEqual(res["cases"], 3)
        self.assertEqual(res["status"], "completed")
        self.assertEqual(res["trace_summary"], {"required": True, "ok": 2, "no_trace": 1})
        self.assertEqual(res["trace_status"], "degraded_no_trace")
        rows = {r["case"]: r["trace"] for r in run["results"]}
        self.assertEqual(rows["c3"], {"status": "no_trace", "reason": "no_content", "spans": 2,
                                      "sources": ["aws/spans"]})
        self.assertEqual(rows["c1"], {"status": "ok", "reason": None, "spans": 4, "sources": ["aws/spans"]})
        summary = planrun._stage_summary(res)
        self.assertEqual(summary["evaluator_stats"]["correctness"], {"mean": 0.55, "passed": 1, "judged": 2})
        self.assertEqual(summary["trace_summary"]["no_trace"], 1)
        self.assertEqual(summary["trace_status"], "degraded_no_trace")
        self.assertIn("（1 例无 trace 未计）", planrun._fmt_stage_line(summary))

    def test_all_missing_makes_the_stage_no_trace_with_no_scores_at_all(self):
        run = run_payload([case_row("c1", {"correctness": verdict(True)}),
                           case_row("c2", {"correctness": verdict(True)})])
        res, checker = self._stage(run, PLAN_ON, checks={})
        self.assertEqual(checker.call_count, 2, "查无时按退避重查（TRACE_CHECK_BACKOFF 两档）")
        self.assertEqual(res["status"], "no_trace")
        self.assertEqual(res["trace_status"], "no_trace")
        self.assertEqual(res["judged_cases"], 0)
        self.assertIsNone(res["pass_rate"])
        self.assertEqual(res["trace_summary"], {"required": True, "ok": 0, "no_trace": 2})
        summary = planrun._stage_summary(res)
        self.assertEqual(summary["evaluator_stats"], {}, "评估器一列不出分")
        self.assertEqual(planrun._fmt_stage_line(summary),
                         "2 个用例，CloudWatch 里没有 Agent 上报的 trace，未评分")
        self.assertTrue(planrun._no_evaluable_data([res]))
        self.assertEqual(planrun._collect_root_causes([res]), [])

    def test_first_query_finding_everything_pays_one_query(self):
        run = run_payload([case_row("c1", {"correctness": verdict(True)})])
        res, checker = self._stage(run, PLAN_ON, checks={"evaltest-c1": hit(1, 1)})
        self.assertEqual(checker.call_count, 1)
        self.assertEqual(res["trace_status"], "ok")
        self.assertEqual(res["pass_rate"], 1.0)

    def test_only_group_missing_is_no_span_source_and_other_errors_fetch_error(self):
        run = run_payload([case_row("c1", {"correctness": verdict(True)})])
        res, checker = self._stage(run, PLAN_ON, error=NOT_FOUND)
        self.assertEqual(checker.call_count, 1, "唯一的 span 组不存在：剔掉后没组可查，不再重试")
        self.assertEqual(run["results"][0]["trace"]["reason"], "no_span_source")
        self.assertEqual(run["results"][0]["trace"]["sources"], [])
        self.assertEqual(res["status"], "no_trace")
        run = run_payload([case_row("c1", {"correctness": verdict(True)})])
        res, checker = self._stage(run, PLAN_ON, error=RuntimeError("Logs Insights query Failed"))
        self.assertEqual(checker.call_count, 1, "查询故障不重试")
        self.assertEqual(run["results"][0]["trace"]["reason"], "fetch_error")

    def test_no_readable_span_group_at_all_is_no_span_source_without_querying(self):
        run = run_payload([case_row("c1", {"correctness": verdict(True)})])
        res, checker = self._stage(run, PLAN_ON, cfg=None)
        checker.assert_not_called()
        self.assertEqual(run["results"][0]["trace"], {"status": "no_trace", "reason": "no_span_source",
                                                      "spans": 0, "sources": []})
        self.assertEqual(res["status"], "no_trace")

    def test_unsampled_platform_trace_marks_missing_rows_unsampled(self):
        """平台这次调用未采样：查无的行标 unsampled；查到内容的行照常 ok。"""
        run = run_payload([case_row("c1", {"correctness": verdict(True)}),
                           case_row("c2", {"correctness": verdict(True)})])
        res, _ = self._stage(run, PLAN_ON, checks={"evaltest-c1": hit(3, 1)}, sampled=False)
        traces = {r["case"]: r["trace"]["reason"] for r in run["results"]}
        self.assertEqual(traces, {"c1": None, "c2": "unsampled"})
        self.assertEqual(res["trace_status"], "degraded_no_trace")

    def test_fallback_group_is_queried_when_primary_has_nothing(self):
        """统一 span 目的地的 Agent（tauairline 系）span 在自己 runtime 日志组、不进 aws/spans：
        主组查无 ⇒ 同一轮就查回退组；两处都查过才写 sources 两项。"""
        run = run_payload([case_row("c1", {"correctness": verdict(True)}),
                           case_row("c2", {"correctness": verdict(True)})])
        seen: list[tuple] = []

        def fake_check(sids, lookback, plan):
            seen.append((tuple(sids), plan["log_group"]))
            return {"evaltest-c1": hit(6, 2)} if plan["log_group"] == RUNTIME_GROUP else {}

        res, _ = self._stage(run, PLAN_ON, sampled=True, cfg=CFG_WITH_FALLBACK,
                             checker=mock.Mock(side_effect=fake_check), backoff=(0,))
        self.assertEqual(seen, [(("evaltest-c1", "evaltest-c2"), "aws/spans"),
                                (("evaltest-c1", "evaltest-c2"), RUNTIME_GROUP)])
        traces = {r["case"]: r["trace"] for r in run["results"]}
        self.assertEqual(traces["c1"], {"status": "ok", "reason": None, "spans": 6,
                                        "sources": ["aws/spans", RUNTIME_GROUP]})
        self.assertEqual(traces["c2"]["reason"], "no_span", "两处都没有才是 no_span")
        self.assertEqual(traces["c2"]["sources"], ["aws/spans", RUNTIME_GROUP])
        self.assertEqual(res["trace_summary"], {"required": True, "ok": 1, "no_trace": 1})

    def test_missing_primary_group_falls_through_to_fallback(self):
        """aws/spans 不存在（账号没开 Transaction Search）但 runtime 日志组在：剔掉主组继续查，不是 no_span_source。"""
        run = run_payload([case_row("c1", {"correctness": verdict(True)})])

        def fake_check(sids, lookback, plan):
            if plan["log_group"] == "aws/spans":
                raise NOT_FOUND
            return {"evaltest-c1": hit(2, 1)}

        res, _ = self._stage(run, PLAN_ON, cfg=CFG_WITH_FALLBACK,
                             checker=mock.Mock(side_effect=fake_check), backoff=(0,))
        self.assertEqual(run["results"][0]["trace"], {"status": "ok", "reason": None, "spans": 2,
                                                      "sources": [RUNTIME_GROUP]})
        self.assertEqual(res["trace_status"], "ok")

    def test_agent_service_filter_and_group_are_forwarded_to_the_query(self):
        run = run_payload([case_row("c1", {"correctness": verdict(True)})])
        _, checker = self._stage(run, PLAN_ON, checks={"evaltest-c1": hit(1, 1)},
                                 cfg={"log_group": "aws/spans", "scope_filter": "",
                                      "service_filter": "deepseek-harness"})
        checker.assert_called_once_with(
            ["evaltest-c1"], 1,
            {"log_group": "aws/spans", "scope_filter": "", "service_filter": "deepseek-harness",
             "log_stream": "", "span_origin": tracesource.ORIGIN_CENTRAL})


class RedteamStage(unittest.TestCase):
    def _stage(self, run: dict, plan: dict, checks: dict):
        import redteam as redteam_mod
        checker = mock.Mock(return_value=checks)
        with mock.patch.object(redteam_mod, "estimate_redteam_run",
                               return_value={"estimated_cost_usd": 0.5}), \
                mock.patch.object(redteam_mod, "execute_redteam_run",
                                  new=mock.AsyncMock(return_value=run)), \
                mock.patch.object(planrun.tracesource, "resolve_span_config", return_value=CFG_CENTRAL), \
                mock.patch.object(planrun.tracesource, "check_agent_traces", checker), \
                mock.patch.object(planrun, "_current_trace_sampled", return_value=None), \
                mock.patch.object(planrun, "TRACE_CHECK_BACKOFF", (0,)):
            res = asyncio.run(planrun._run_redteam_stage(
                {"type": "redteam", "cases": [{"name": "c1", "input": "x"}],
                 "strategies": ["direct"]}, plan, AGENT, "judge-model", _emit_noop()))
        return res, checker

    @staticmethod
    def _run():
        return {"run_id": "rt-20260907120000", "status": "completed", "attacks": 3,
                "breached": 2, "breach_rate": 0.6667, "verdict": "FAIL", "actual_cost_usd": 0.2,
                "results": [
                    {"case_name": "a__direct", "breached": True, "errored": False,
                     "session_ids": ["evaltest-rt-1", "evaltest-rt-2"]},
                    {"case_name": "b__direct", "breached": True, "errored": False,
                     "session_ids": ["evaltest-rt-3"]},
                    {"case_name": "c__direct", "breached": False, "errored": False,
                     "session_ids": ["evaltest-rt-4"]},
                ]}

    def test_switch_off_keeps_sdk_numbers_and_never_queries(self):
        res, checker = self._stage(self._run(), PLAN_OFF, {})
        checker.assert_not_called()
        self.assertEqual((res["breached"], res["breach_rate"], res["verdict"]), (2, 0.6667, "FAIL"))
        self.assertNotIn("trace_summary", res)
        self.assertEqual(set(planrun._stage_summary(res)), {"type", "status", "breached", "attacks", "verdict"})

    def test_missing_switch_means_on(self):
        """2026-09-08 默认开：方案没有 trace_required 键的红队环节也核对（全缺 ⇒ INCONCLUSIVE no_trace）。"""
        res, checker = self._stage(self._run(), PLAN_UNSET, {})
        self.assertTrue(checker.called)
        self.assertEqual(res["trace_summary"]["required"], True)
        self.assertEqual(res["trace_status"], "no_trace")

    def test_attack_with_one_missing_session_is_no_trace_and_leaves_breach_rate(self):
        run = self._run()
        res, _ = self._stage(run, PLAN_ON, {"evaltest-rt-1": hit(9, 4),  # rt-2 缺 ⇒ 行 a no_trace
                                            "evaltest-rt-3": hit(5, 2), "evaltest-rt-4": hit(5, 2)})
        traces = {r["case_name"]: r["trace"] for r in run["results"]}
        self.assertEqual(traces["a__direct"], {"status": "no_trace", "reason": "no_span", "spans": 9,
                                               "sources": ["aws/spans"]})
        self.assertEqual(traces["b__direct"]["status"], "ok")
        self.assertEqual((res["breached"], res["breach_rate"], res["verdict"]), (1, 0.5, "FAIL"))
        self.assertEqual(res["attacks"], 3)
        self.assertEqual(res["trace_summary"], {"required": True, "ok": 2, "no_trace": 1})
        self.assertEqual(run["breached"], 2, "report 里 SDK 那份原数不动")
        self.assertIn("（1 例无 trace 未计）", planrun._fmt_stage_line(planrun._stage_summary(res)))

    def test_all_missing_is_inconclusive_no_trace(self):
        res, _ = self._stage(self._run(), PLAN_ON, {})
        self.assertEqual((res["status"], res["verdict"], res["breached"], res["breach_rate"]),
                         ("no_trace", "INCONCLUSIVE", 0, 0.0))
        self.assertEqual(planrun._fmt_stage_line(planrun._stage_summary(res)),
                         "3 次攻击，CloudWatch 里没有 Agent 上报的 trace，未评分")
        self.assertTrue(planrun._no_evaluable_data([res]))


class SampledFlag(unittest.TestCase):
    def test_no_active_span_is_unknown_not_unsampled(self):
        """测试进程里没有有效 span：INVALID_SPAN 的 trace_flags 也是 0，必须读成 None。"""
        self.assertIsNone(planrun._current_trace_sampled())


# ---------------- plan：字段持久化 ----------------

class PlanField(unittest.TestCase):
    class _Table:
        def __init__(self):
            self.items = {}

        def put_item(self, Item):
            self.items[Item["sk"]] = Item

        def get_item(self, Key):
            item = self.items.get(Key["sk"])
            return {"Item": item} if item else {}

    def _plan(self, **extra):
        return {"name": "回归周巡检", "agent_name": AGENT_NAME,
                "stages": [{"type": "dataset", "dataset": DATASET["name"], "evaluators": ["correctness"]}],
                **extra}

    def test_round_trip_and_default_true(self):
        """2026-09-08 用户决定「开关默认开」：新建不带键 = 开；显式 False 才关；往返保真。"""
        table = self._Table()
        with mock.patch.object(plan_mod, "_table", return_value=table), \
                mock.patch.object(plan_mod.catalog, "list_datasets", return_value=[DATASET]), \
                mock.patch.object(plan_mod.catalog, "list_custom_evaluators", return_value=[]):
            on = plan_mod.save_plan(self._plan(trace_required=True), AGENT)
            off = plan_mod.save_plan(self._plan(trace_required=False), AGENT)
            fresh = plan_mod.save_plan(self._plan(), AGENT)  # 新建方案：请求体不带键
            self.assertIs(plan_mod.get_plan(on["plan_id"])["trace_required"], True)
            self.assertIs(plan_mod.get_plan(off["plan_id"])["trace_required"], False)
            self.assertIs(plan_mod.get_plan(fresh["plan_id"])["trace_required"], True)
            # 落盘的 data 也是显式 true（不是「缺键留给读侧猜」）
            import json
            self.assertIs(json.loads(table.items[fresh["plan_id"]]["data"])["trace_required"], True)
            # 老方案：data 里根本没有这个键 → 开（全平台默认走上报数据评估）；旧数据本身不改
            legacy = {"pk": "PLAN", "sk": "plan-legacy", "name": "旧", "agent_name": AGENT_NAME,
                      "data": '{"stages": [], "schedule": null}', "updated_at": 1}
            table.items["plan-legacy"] = legacy
            self.assertIs(plan_mod.get_plan("plan-legacy")["trace_required"], True)
            self.assertEqual(table.items["plan-legacy"], legacy)

    def test_normalizer_is_the_only_reader(self):
        """缺键 / None ⇒ 开；只有显式假值才关。读开关一律走 plan.trace_required，
        `app/*.py` 里不许再出现 `.get("trace_required")`（那种写法把缺键读成关）。

        守卫覆盖面按「哪种写法是缺陷」定，不按「哪个模块现在有它」定：收口前只扫 planrun
        且钉「plan_mod.trace_required(plan) 恰好 4 次」—— 那样新增一处**正确**读法会红
        （计数变 5），而在 testrun / 别的模块里写一处**错误**读法却不红（根本没扫）。
        现在：字面量在全体 app 模块上断言零出现（`app/plan.py` 除外 —— 归一器自己就住在
        那里，它必须读原始键），正确读法的计数改成 ≥1（配反向钉：plan.py 里那一处必须在，
        否则「零出现」也可能是这个键整个没人读了）。"""
        self.assertIs(plan_mod.trace_required({}), True)
        self.assertIs(plan_mod.trace_required(None), True)
        self.assertIs(plan_mod.trace_required({"trace_required": None}), True)
        self.assertIs(plan_mod.trace_required({"trace_required": True}), True)
        self.assertIs(plan_mod.trace_required({"trace_required": False}), False)
        self.assertIs(plan_mod.TRACE_REQUIRED_DEFAULT, True)

        app_dir = Path(__file__).resolve().parent.parent / "app"
        modules = sorted(app_dir.glob("*.py"))
        self.assertGreater(len(modules), 5, f"没扫到 app 模块，守卫已失效：{app_dir}")
        raw_reads = {f.name: f.read_text().count('.get("trace_required")')
                     for f in modules}
        offenders = {name: n for name, n in raw_reads.items()
                     if n and name != "plan.py"}
        self.assertEqual(offenders, {},
                         "这些模块在直接读原始键（缺键会被读成关），改走 plan.trace_required："
                         f"{offenders}")
        # 反向钉：归一器那一处原始读法必须在，否则上面的「零出现」是「没人读」的假绿
        self.assertGreaterEqual(raw_reads.get("plan.py", 0), 1,
                                "plan.py 里那处原始读法不见了 ⇒ 守卫失去参照")
        calls = len(re.findall(r"plan_mod\.trace_required\(plan\)", inspect.getsource(planrun)))
        self.assertGreaterEqual(calls, 1, "planrun 里一处正确读法都没有 ⇒ 开关没人看")


if __name__ == "__main__":
    unittest.main()
