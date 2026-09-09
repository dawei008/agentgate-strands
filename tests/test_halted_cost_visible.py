"""成本熔断必须能被看见（P1，BH-005 族 / 任务书缺陷 3）。

现象：超预算时 `testrun.py` 与 `redteam.py` 把 run 标成 `status="halted_cost"`
并中止。这个 status 经 planrun 的 dataset/redteam 环节返回原样上到 stage
summary，而那两个返回 dict **没有 error 键** ⇒ 前端 `lib/scoring.ts`
  · isStageFailed：status 既不是 empty 也不是 error、Boolean(s.error) 为 false
    → 判「没失败」
  · isStageEffective：要求 status === "completed" → 「没有有效结果」
两条都不成立 ⇒ 整个 run 显示成中性的「完成 · 无可评估数据」：用户的钱烧到熔断
阈值，界面一个字都不说。

本测试钉后端半边（前端半边见 web/tests/scoring-halted.test.ts）：
  1. 熔断原因必须随环节摘要一起出库（大屏/报告抽屉读的就是 stage.error）
  2. dataset 侧此前连一条文案都没有 —— 补一条与 redteam 同风格的
  3. overview 的环节一行话不许把熔断说成正常的「N 个用例，通过率 X%」

不碰真表 / 真 agent / 真 LLM。
运行：python3 -m pytest tests/test_halted_cost_visible.py -q
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import planrun  # noqa: E402
import testrun  # noqa: E402

AGENT_NAME = "support-bot"
DATASET = {"name": "regression-v1", "cases": [{"name": "c1", "input": "hi"}]}
PLAN = {"plan_id": "plan-1297bb07bc31", "name": "回归周巡检",
        "agent_name": AGENT_NAME, "stages": []}
AGENT = {"agent_name": AGENT_NAME, "runtime_arn": "arn:aws:bedrock:x:y:runtime/z"}


def case_row(name: str, passed: bool = True) -> dict:
    return {"agent": AGENT_NAME, "case": name, "input": "hi", "output": "答案",
            "results": {"correctness": {"score": 0.9, "passed": passed,
                                        "errored": False, "reason": "…"}}}


class HaltedCostReachesTheStageSummary(unittest.TestCase):
    def _dataset_stage(self, run: dict) -> dict:
        async def emit(_ev):
            pass

        with mock.patch.object(planrun.catalog, "get_dataset", return_value=DATASET), \
                mock.patch.object(planrun.catalog, "list_custom_evaluators", return_value=[]), \
                mock.patch.object(planrun.testrun, "estimate_test_run",
                                  return_value={"estimated_cost_usd": 0.5}), \
                mock.patch.object(planrun.testrun, "execute_test_run",
                                  new=mock.AsyncMock(return_value=run)):
            return asyncio.run(planrun._run_dataset_stage(
                {"type": "dataset", "dataset": DATASET["name"],
                 "evaluators": ["correctness"], "agent_model": "m"},
                PLAN, AGENT, "judge-model", emit))

    def _redteam_stage(self, run: dict) -> dict:
        async def emit(_ev):
            pass

        import redteam as redteam_mod
        with mock.patch.object(redteam_mod, "estimate_redteam_run",
                               return_value={"estimated_cost_usd": 0.5}), \
                mock.patch.object(redteam_mod, "execute_redteam_run",
                                  new=mock.AsyncMock(return_value=run)):
            return asyncio.run(planrun._run_redteam_stage(
                {"type": "redteam", "cases": [{"name": "c1", "input": "x"}],
                 "strategies": ["goat"], "agent_model": "m"},
                PLAN, AGENT, "judge-model", emit))

    # ---- dataset 侧 ----

    def test_dataset_stage_carries_the_halt_reason(self):
        """熔断的回归环节必须带上原因，并随 _stage_summary 出库。"""
        run = {"status": "halted_cost", "total_cases": 8, "completed_cases": 3,
               "results": [case_row("c1"), case_row("c2")],
               "actual_cost_usd": 1.53, "blank_cases": 0,
               "error": testrun._cost_circuit_note(1.53, 0.51)}
        stage = self._dataset_stage(run)
        self.assertEqual(stage["status"], "halted_cost")
        self.assertTrue(stage.get("error"), "熔断原因没有随环节返回")
        self.assertIn("熔断", stage["error"])
        summary = planrun._stage_summary(stage)
        self.assertEqual(summary["status"], "halted_cost")
        self.assertIn("熔断", summary["error"])

    def test_completed_dataset_stage_gains_no_error_key(self):
        """回归：正常完成的环节不许多出 error 键（会被判成失败环节）。"""
        stage = self._dataset_stage({
            "status": "completed", "total_cases": 2, "results": [case_row("c1")],
            "actual_cost_usd": 0.2, "blank_cases": 0})
        self.assertIsNone(planrun._stage_summary(stage).get("error"))

    # ---- redteam 侧 ----

    def test_redteam_stage_carries_the_halt_reason(self):
        """红队侧后端早就有中文文案（redteam.py:768-769），此前在环节返回里被丢掉。"""
        run = {"status": "halted_cost", "attacks": 20, "breached": 2,
               "breach_rate": 0.1, "verdict": "INCONCLUSIVE",
               "actual_cost_usd": 5.44,
               "error": "实际成本 $5.44 超过预估的 3.0x（$1.8），已自动熔断中止"}
        stage = self._redteam_stage(run)
        self.assertEqual(stage["status"], "halted_cost")
        self.assertIn("熔断", stage.get("error", ""))
        self.assertIn("熔断", planrun._stage_summary(stage)["error"])

    def test_failed_redteam_run_also_surfaces_its_error(self):
        """同族：run 级 status="failed"（redteam.py:772-773）此前同样一句不说。"""
        stage = self._redteam_stage({
            "status": "failed", "attacks": 0, "actual_cost_usd": 0.0,
            "error": "AccessDeniedException: 目标 runtime 不可调用"})
        self.assertEqual(stage["status"], "failed")
        self.assertIn("AccessDenied", planrun._stage_summary(stage)["error"])

    # ---- 环节一行话 ----

    def test_stage_line_states_the_halt_instead_of_a_pass_rate(self):
        """overview 的环节一行话（方案页/报告抽屉直接显示）不许把熔断说成
        「8 个用例，通过率 100%」—— 那读起来像一次完整成功的回归。"""
        line = planrun._fmt_stage_line({
            "type": "dataset", "status": "halted_cost", "cases": 8,
            "pass_rate": 1.0,
            "error": testrun._cost_circuit_note(1.53, 0.51)})
        self.assertIn("熔断", line)
        self.assertNotIn("通过率", line)


class CostCircuitNote(unittest.TestCase):
    """dataset 侧此前只有 status，没有任何用户可见文案（redteam 有）。"""

    def test_note_names_the_threshold_and_the_actual_cost(self):
        note = testrun._cost_circuit_note(1.53, 0.51)
        self.assertIn("1.53", note)
        self.assertIn("0.51", note)
        self.assertIn(f"{testrun.COST_CIRCUIT_FACTOR}x", note)
        self.assertIn("熔断", note)

    def test_note_matches_the_redteam_phrasing(self):
        """两个模式的熔断文案同风格（用户在两处看到的是同一句话）。"""
        rt = ("实际成本 $1.53 超过预估的 3.0x（$0.51），已自动熔断中止")
        self.assertEqual(testrun._cost_circuit_note(1.53, 0.51), rt)


class SourceGuards(unittest.TestCase):
    src = (Path(__file__).resolve().parent.parent / "app" / "testrun.py").read_text()

    def test_halt_branch_records_the_reason(self):
        """熔断分支必须同时写 status 与 error —— 只写 status 就是本缺陷本身。"""
        at = self.src.index('run["status"] = "halted_cost"')
        window = self.src[at:at + 400]
        self.assertIn('run["error"] = _cost_circuit_note(', window)


if __name__ == "__main__":
    unittest.main()
