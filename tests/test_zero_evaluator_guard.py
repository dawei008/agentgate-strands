"""零评估器的回归环节可保存、可运行、真烧钱，最后只说一句「无可评估数据」。

现场（生产，2026-08-24）：run `plan-e0634c304c95#20260824165133` 的回归环节
`evaluators: []`，真调了被测 Agent 10 次（每条 10.3s），judged=0，通过率「—」。
钱花了、时间花了，产出为零。

两处漏洞，两层守卫（本文件逐条钉）：
  1. **保存时**：`plan.validate_plan` 只有 observe 环节要求「至少一个评估器或
     指标」，dataset 分支只查数据集存在不存在 —— 零评估器的方案存得下去。
  2. **运行时（护旧方案）**：已经存下来的方案还会照跑。`_run_dataset_stage`
     在评估器为空时必须短路成 status="empty" + 说明，**一次被测 Agent 都不调、
     一分钱都不花**。empty 在前端 `lib/scoring.ts` 是「执行成功但没东西可评」，
     不算失败（isStageFailed 里 empty 第一个出局）—— 正合这里的事实。

红队环节不受影响：它没有评估器这一维（用 strategies + AttackSuccessEvaluator）。

不碰真表 / 真 agent / 真 LLM。
运行：python3 -m pytest tests/test_zero_evaluator_guard.py -q
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import plan as plan_mod  # noqa: E402
import planrun  # noqa: E402

AGENT_NAME = "support-bot"
AGENT = {"agent_name": AGENT_NAME, "runtime_arn": "arn:aws:bedrock:x:y:runtime/z"}
DATASET = {"name": "regression-v1", "cases": [{"name": "c1", "input": "hi"}]}
PLAN = {"plan_id": "plan-e0634c304c95", "name": "回归周巡检",
        "agent_name": AGENT_NAME, "stages": []}


def dataset_stage(**over) -> dict:
    return {"type": "dataset", "dataset": DATASET["name"],
            "evaluators": ["correctness"], "agent_model": "m", **over}


# ------------------------------------------------------------ 第一层：保存时

class SaveTimeGuard(unittest.TestCase):
    def _validate(self, stages: list[dict]):
        with mock.patch.object(plan_mod.catalog, "list_datasets",
                               return_value=[DATASET]), \
                mock.patch.object(plan_mod.catalog, "list_custom_evaluators",
                                  return_value=[]):
            plan_mod.validate_plan({**PLAN, "stages": stages}, AGENT)

    def test_dataset_stage_without_evaluators_is_rejected(self):
        """现场那张方案存不进去（文案风格照 observe 那句）。"""
        with self.assertRaises(ValueError) as cm:
            self._validate([dataset_stage(evaluators=[])])
        self.assertIn("环节 1", str(cm.exception))
        self.assertIn("评估器", str(cm.exception))

    def test_missing_evaluators_key_is_rejected_too(self):
        """键干脆没有（UI 老 payload / 手写 API）与空数组同刑。"""
        stage = dataset_stage()
        stage.pop("evaluators")
        with self.assertRaises(ValueError):
            self._validate([stage])

    def test_the_offending_stage_is_named_by_position(self):
        """多环节方案要说清是第几环节 —— 用户面对的是一列环节卡片。"""
        with self.assertRaises(ValueError) as cm:
            self._validate([dataset_stage(),
                            dataset_stage(evaluators=[])])
        self.assertIn("环节 2", str(cm.exception))

    def test_dataset_stage_with_an_evaluator_still_saves(self):
        """回归：正常的回归环节照旧通过。"""
        self._validate([dataset_stage()])

    def test_observe_stage_rule_is_untouched(self):
        """回归：观测环节的既有口径不变（评估器**或**指标，二者之一即可）。"""
        self._validate([{"type": "observe", "evaluators": [], "metrics": ["cost"]}])
        with self.assertRaises(ValueError) as cm:
            self._validate([{"type": "observe", "evaluators": [], "metrics": []}])
        self.assertIn("评估器或指标", str(cm.exception))

    def test_redteam_stage_needs_no_evaluators(self):
        """回归：红队环节没有评估器这一维，不许被新守卫误伤。"""
        self._validate([{"type": "redteam", "cases_dataset": "rt-set"}])

    def test_missing_dataset_still_reports_the_dataset(self):
        """回归：数据集不存在仍按既有文案报（两个问题各说各的）。"""
        with self.assertRaises(ValueError) as cm:
            self._validate([dataset_stage(dataset="不存在的集")])
        self.assertIn("数据集", str(cm.exception))


# ------------------------------------------------------------ 第二层：运行时

class RunTimeShortCircuit(unittest.TestCase):
    """已存下来的旧方案照样会跑 —— 执行侧必须自己拦住，且不花钱。"""

    def _stage(self, stage: dict, run=None):
        async def emit(_ev):
            pass

        self.execute = mock.AsyncMock(return_value=run or {
            "status": "completed", "total_cases": 1, "completed_cases": 1,
            "results": [], "actual_cost_usd": 0.1, "blank_cases": 0})
        self.estimate = mock.Mock(return_value={"estimated_cost_usd": 0.5})
        with mock.patch.object(planrun.catalog, "get_dataset",
                               return_value=DATASET), \
                mock.patch.object(planrun.catalog, "list_custom_evaluators",
                                  return_value=[]), \
                mock.patch.object(planrun.testrun, "estimate_test_run",
                                  self.estimate), \
                mock.patch.object(planrun.testrun, "execute_test_run",
                                  self.execute):
            return asyncio.run(planrun._run_dataset_stage(
                stage, PLAN, AGENT, "judge-model", emit))

    def test_no_evaluators_never_invokes_the_agent(self):
        """要害：一次被测 Agent 调用都不许发生（现场是 10 次 × 10.3s）。"""
        res = self._stage(dataset_stage(evaluators=[]))
        self.assertFalse(self.execute.called,
                         "零评估器的环节还是真跑了回归（继续烧钱）")
        self.assertFalse(self.estimate.called,
                         "连预估都不必算：这一环根本不会执行")
        self.assertEqual(res["actual_cost_usd"], 0.0)

    def test_status_is_empty_not_error_and_says_what_to_do(self):
        """empty = 「执行成功但没东西可评」（scoring.ts 的口径），并给出下一步。
        不用 error：这不是执行失败，而是配置没填完。"""
        res = self._stage(dataset_stage(evaluators=[]))
        self.assertEqual(res["status"], "empty")
        self.assertIn("评估器", res["error"])
        self.assertIn("重跑", res["error"])

    def test_the_reason_reaches_the_stage_summary(self):
        """摘要是方案页/大屏/报告抽屉唯一读到的东西 —— 原因必须出库。"""
        summary = planrun._stage_summary(self._stage(dataset_stage(evaluators=[])))
        self.assertEqual(summary["status"], "empty")
        self.assertIn("评估器", summary["error"])
        self.assertIsNone(summary["pass_rate"])
        self.assertEqual(summary["cases"], 0)

    def test_the_stage_line_states_the_reason(self):
        """环节一行话不许印成「0 个用例，通过率 —」（读起来像跑过了）。"""
        line = planrun._fmt_stage_line(
            planrun._stage_summary(self._stage(dataset_stage(evaluators=[]))))
        self.assertIn("评估器", line)
        self.assertNotIn("通过率", line)

    def test_a_configured_stage_still_runs(self):
        """回归：配了评估器的环节照旧真跑。"""
        res = self._stage(dataset_stage())
        self.assertTrue(self.execute.called)
        self.assertEqual(res["status"], "completed")


if __name__ == "__main__":
    unittest.main()
