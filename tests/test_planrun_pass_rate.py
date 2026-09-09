"""方案 dataset 环节通过率不许把「评估器全部执行失败」的用例算成通过（P1，BH-003）。

现象：judge 被限流（Bedrock ThrottlingException，本项目历史上真实发生）→ 每个用例的
评估器行全部 errored → 环节通过率显示 **100%**，而实际上一个判定都没产出。

根因：errored 的评估器行以 `{"score": None, "passed": None, "errored": True}` 写入
**非空** results dict（`testrun.py:_collect_results`），于是
  · 外层 `r.get("results")` 为真 → 全 errored 的用例仍进 judged（分母）
  · 内层 `all(v.get("passed") for v in … if not v.get("errored"))` 的生成器被过滤成
    空序列 → `all(()) is True` → 该用例被记成通过（分子）
两处叠加：全部 judge 失败时 pass_rate == 1.0。

口径基准（本次统一到「剔 errored」侧）：`observe.summarize` 先剔 errored 再算均分与
通过率；`testrun.py` 的报告提示词也明写 errored「已不计入均分」。

传播链（为什么是 P1）：_stage_summary → DDB stage_summaries → overview delta + 综合
报告文案 → 大屏 KPI / 方案页环节分 / 运行详情。

不碰真表 / 真 agent / 真 LLM：环节内部的 execute_test_run 打桩，只验通过率算术。
运行：python3 -m pytest tests/test_planrun_pass_rate.py -q
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import planrun  # noqa: E402

AGENT_NAME = "support-bot"
DATASET = {"name": "regression-v1", "cases": [{"name": "c1", "input": "hi"}]}
# 这里钉的是按 SDK 返回评分时的通过率算术，与 trace 核对无关 ⇒ 显式关（2026-09-08 起缺键 = 开，
# 会走 _mark_traces 把所有行标成 no_trace）。
PLAN = {"plan_id": "plan-1297bb07bc31", "name": "回归周巡检",
        "agent_name": AGENT_NAME, "stages": [], "trace_required": False}
AGENT = {"agent_name": AGENT_NAME, "runtime_arn": "arn:aws:bedrock:x:y:runtime/z"}
STAGE = {"type": "dataset", "dataset": DATASET["name"],
         "evaluators": ["correctness", "helpfulness"], "agent_model": "m"}

# judge 执行失败的评估器行，逐字照 testrun.py:_collect_results 的真形态
ERRORED = {"score": None, "passed": None, "errored": True,
           "reason": "An error occurred: ThrottlingException: Too many requests"}


def verdict(passed: bool, score: float = 0.9) -> dict:
    return {"score": score, "passed": passed, "errored": False, "reason": "…"}


def case_row(name: str, results: dict, **extra) -> dict:
    """testrun 的逐用例 entry 真形态（只留通过率会读到的字段）。"""
    row = {"agent": AGENT_NAME, "case": name, "input": "hi", "output": "答案",
           "session_id": f"evaltest-{name}", "results": results,
           "started_epoch": 1, "finished_epoch": 2, "duration_s": 0.4}
    row.update(extra)
    return row


def run_payload(rows: list[dict], **extra) -> dict:
    run = {"run_id": "run-20260824120000", "dataset": DATASET["name"],
           "agents": [AGENT_NAME], "evaluators": STAGE["evaluators"],
           "judge_model": "judge", "status": "completed",
           "total_cases": len(rows), "completed_cases": len(rows),
           "results": rows, "actual_cost_usd": 0.12, "blank_cases": 0,
           "error_cases": 0, "live_turns": [], "cache_mode": "off"}
    run.update(extra)
    return run


class DatasetPassRate(unittest.TestCase):
    def _stage(self, run: dict) -> dict:
        async def emit(_ev):
            pass

        with mock.patch.object(planrun.catalog, "get_dataset", return_value=DATASET), \
                mock.patch.object(planrun.catalog, "list_custom_evaluators", return_value=[]), \
                mock.patch.object(planrun.testrun, "estimate_test_run",
                                  return_value={"estimated_cost_usd": 0.5}), \
                mock.patch.object(planrun.testrun, "execute_test_run",
                                  new=mock.AsyncMock(return_value=run)):
            return asyncio.run(planrun._run_dataset_stage(
                STAGE, PLAN, AGENT, "judge-model", emit))

    def test_all_evaluators_errored_is_not_a_pass(self):
        """一个用例的所有评估器都执行失败 → 它没有判定：不进分母，更不算通过。"""
        res = self._stage(run_payload([
            case_row("c1", {"correctness": dict(ERRORED), "helpfulness": dict(ERRORED)}),
        ]))
        self.assertEqual(res["judged_cases"], 0,
                         "零判定的用例被算进了通过率分母")
        self.assertIsNone(res["pass_rate"],
                          "一个判定都没有，通过率必须是「—」而不是一个数字")

    def test_every_case_judge_failed_never_reads_as_100_percent(self):
        """全部用例 judge 失败（限流）→ 绝不能显示 100% 通过。"""
        res = self._stage(run_payload([
            case_row("c1", {"correctness": dict(ERRORED)}),
            case_row("c2", {"correctness": dict(ERRORED)}),
            case_row("c3", {"correctness": dict(ERRORED)}),
        ]))
        self.assertNotEqual(res["pass_rate"], 1.0, "全部 judge 失败却显示 100% 通过")
        self.assertIsNone(res["pass_rate"])
        self.assertEqual(res["judged_cases"], 0)

    def test_mixed_run_counts_only_cases_with_a_real_verdict(self):
        """混合：c1 全 errored、c2 有真判定且不通过 → judged=1、pass_rate=0.0。
        （修复前是 judged=2 / pass_rate=0.5——findings 里那组复现数字）"""
        res = self._stage(run_payload([
            case_row("c1", {"correctness": dict(ERRORED)}),
            case_row("c2", {"correctness": verdict(False, 0.2),
                            "helpfulness": dict(ERRORED)}),
        ]))
        self.assertEqual(res["judged_cases"], 1)
        self.assertEqual(res["pass_rate"], 0.0)

    def test_partly_errored_case_is_judged_on_its_real_verdicts(self):
        """别修过头：有 ≥1 个真判定的用例照常参与，errored 那行只是不参与判定。"""
        res = self._stage(run_payload([
            case_row("c1", {"correctness": verdict(True),
                            "helpfulness": dict(ERRORED)}),
            case_row("c2", {"correctness": verdict(True), "helpfulness": verdict(True)}),
        ]))
        self.assertEqual(res["judged_cases"], 2)
        self.assertEqual(res["pass_rate"], 1.0)

    def test_blank_and_error_cases_stay_out_of_the_denominator(self):
        """既有口径不变：空响应用例与调用失败用例仍不进通过率。"""
        res = self._stage(run_payload([
            case_row("c1", {"correctness": verdict(True)}),
            case_row("c2", {}, blank_output=True),
            case_row("c3", {}, error="target unreachable"),
        ], blank_cases=1))
        self.assertEqual(res["judged_cases"], 1)
        self.assertEqual(res["pass_rate"], 1.0)
        self.assertEqual(res["cases"], 3)

    def test_stage_status_and_cost_still_come_from_the_run(self):
        """通过率修复不许动环节其余字段（status/成本/报告体照原样带出）。"""
        run = run_payload([case_row("c1", {"correctness": verdict(True)})])
        res = self._stage(run)
        self.assertEqual(res["type"], "dataset")
        self.assertEqual(res["status"], "completed")
        self.assertEqual(res["dataset"], DATASET["name"])
        self.assertEqual(res["actual_cost_usd"], 0.12)
        self.assertIs(res["report"], run)


if __name__ == "__main__":
    unittest.main()
