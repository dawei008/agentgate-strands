"""零数据 run 不许发起综合报告 judge 调用 + Bedrock/OpenAI 重试预算加深（P2）。

现场形态（2026-08-25 用户实撞）：一次 run 唯一环节线上评估返回「最近 30 天没有
可评估的会话」（sessions 0）→ 仍走「生成综合报告…」（一次 judge 调用，真花钱，
而材料里一条可评估结果都没有）→ Bedrock `ServiceUnavailableException
(reached max retries: 2)` 直穿到用户界面。两个独立缺陷，本文件逐条钉住：

  1. **零数据短路，与 stopped 完全同形**：全部环节都没有可评估数据的 run 不生成
     综合报告 —— 有意没做，不写 synthesis_error（前端把它渲染成「综合报告生成
     失败」，而这里根本没失败），也不发 synthesis_start/done 事件；任一环节有
     数据照常生成。判定唯一住所 `_no_evaluable_data`，形态锚在各环节 result 的
     落库代码：observe `sessions==0` 或带 error（_run_observe_stage 的空会话
     return）、dataset 无 report.results（_run_dataset_stage）、redteam 无
     attacks（_run_redteam_stage，含 salvage 路）。
  2. **重试预算 2→4**：judgellm 两路（Bedrock retries.max_attempts / OpenAI
     max_retries）对瞬时 5xx 的预算太薄，503 两次就直穿给用户。

moto 的真 DynamoDB + 打桩 S3；judge 断到 judgellm.converse 这一层计数（mock
_generate_synthesis 会把被测的短路门自己短路掉）。不碰真表/真 LLM/不发起 run_plan。
运行：python3 -m pytest tests/test_planrun_synthesis_empty_guard.py -q
"""

import asyncio
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

TABLE = "eval-catalog-test"
BUCKET = "eval-artifacts-test"
REGION = "us-west-2"

PLAN = {
    "plan_id": "plan-2508aa31cafe",
    "name": "线上评估周巡检",
    "agent_name": "support-bot",
    "stages": [{"type": "observe", "evaluators": ["helpfulness"], "metrics": []}],
}
AGENT = {"agent_name": "support-bot", "agent_arn": "arn:aws:bedrock:x:y:runtime/z"}
SYNTHESIS = "## 整体趋势\n首个数据点，暂无趋势可言。"

# ---- 各环节 result 的真形态（逐条锚在 planrun 落库代码上，不许自创键名） ----

# _run_observe_stage 的空会话 return：
#   {"type": "observe", "status": "empty", "error": f"最近 {lookback} 天没有
#    可评估的会话", "sessions": 0}
OBSERVE_EMPTY = {"type": "observe", "status": "empty",
                 "error": "最近 30 天没有可评估的会话", "sessions": 0}
# 环节循环的兜底 except：{"type": ..., "status": "error", "error": str(e)[:500]}
OBSERVE_CRASH = {"type": "observe", "status": "error", "error": "boom"}
# _run_dataset_stage：数据集不存在（error，无 report）/ 未配评估器（empty，无 report）
DATASET_GONE = {"type": "dataset", "status": "error",
                "error": "数据集 'faq' 不存在"}
DATASET_NO_EVAL = {"type": "dataset", "status": "empty", "dataset": "faq",
                   "cases": 0, "actual_cost_usd": 0.0,
                   "error": "环节未配置评估器，未执行（配置评估器后重跑）"}
# _run_redteam_stage：执行失败且 checkpoint 也没抢救出东西（无 attacks 键）
REDTEAM_CRASH = {"type": "redteam", "status": "error", "run_id": "rt-x",
                 "error": "boom"}


def observe_ok(mean: float = 0.83) -> dict:
    """_run_observe_stage 正常 return 的字段集（sessions = 评出的会话数）。"""
    return {"type": "observe", "status": "completed", "sessions": 2,
            "summary": {}, "overall_mean": mean, "metrics": None,
            "session_details": [], "analysis": None, "actual_cost_usd": 0.12,
            "evaluators": ["helpfulness"], "metric_keys": []}


def dataset_ok() -> dict:
    """_run_dataset_stage 正常 return：report 就是 run，results 在 report 里。"""
    return {"type": "dataset", "status": "completed", "error": None,
            "run_id": "run-1", "dataset": "faq", "evaluators": ["correctness"],
            "cases": 1, "judged_cases": 1, "pass_rate": 1.0, "blank_cases": 0,
            "actual_cost_usd": 0.05,
            "report": {"results": [
                {"case": "c1",
                 "results": {"correctness": {"score": 1.0, "passed": True}}}]}}


def redteam_salvaged() -> dict:
    """_run_redteam_stage 的 error+salvage 路：攻击已付费，report/attacks 都在。"""
    return {**REDTEAM_CRASH, "attacks": 20, "breached": 3, "breach_rate": 0.15,
            "verdict": "risky", "actual_cost_usd": 0.8,
            "report": {"attacks": 20}, "salvaged": True}


class DdbFixture(unittest.TestCase):
    def setUp(self):
        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)
        self.table = boto3.resource("dynamodb", region_name=REGION).create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST")

        import catalog
        import planrun
        self.planrun = planrun
        p = mock.patch.object(catalog, "get_table", return_value=self.table)
        p.start()
        self.addCleanup(p.stop)
        n = mock.patch.object(catalog, "TABLE_NAME", TABLE)
        n.start()
        self.addCleanup(n.stop)
        e = mock.patch.dict(os.environ, {"ARTIFACTS_BUCKET": BUCKET})
        e.start()
        self.addCleanup(e.stop)
        self.s3 = mock.MagicMock()
        s = mock.patch.object(planrun.runstore, "_s3", return_value=self.s3)
        s.start()
        self.addCleanup(s.stop)
        planrun._stop_polls.clear()
        self.addCleanup(planrun._stop_polls.clear)

    def _run(self, stage_results: list[dict]):
        """跑一次 execute_plan_run，环节执行体按队列出栈打桩。

        judge 打桩在 judgellm.converse（_generate_synthesis 内 import judgellm
        后按属性取）：短路门是被测对象，必须让真的 _generate_synthesis 有机会
        跑到 converse 才算「真调了 judge」。
        """
        import judgellm

        plan = {**PLAN, "stages": [{"type": r["type"]} for r in stage_results]}
        results = list(stage_results)
        self.events: list[dict] = []

        async def emit(ev):
            self.events.append(ev)

        async def pop_stage(*_a, **_k):
            return results.pop(0)

        self.judge = mock.MagicMock(return_value={
            "text": SYNTHESIS, "tool_input": None, "stop_reason": "end_turn"})
        with mock.patch.object(self.planrun, "_run_observe_stage", pop_stage), \
                mock.patch.object(self.planrun, "_run_dataset_stage", pop_stage), \
                mock.patch.object(self.planrun, "_run_redteam_stage", pop_stage), \
                mock.patch.object(judgellm, "converse", self.judge):
            return asyncio.run(self.planrun.execute_plan_run(
                plan, AGENT, "judge-model", "manual", emit))

    def row(self) -> dict:
        rows = self.planrun.list_plan_runs(PLAN["plan_id"])
        self.assertEqual(len(rows), 1)
        return rows[0]


# ------------------------------------------------ 验收 1：零数据 run 短路

class ZeroDataRunSkipsSynthesis(DdbFixture):
    def test_empty_observe_run_makes_no_judge_call(self):
        """现场形态原样：唯一环节 sessions 0 → judge converse 一次都不许调。"""
        self._run([OBSERVE_EMPTY])
        self.assertEqual(self.judge.call_count, 0,
                         "零数据 run 仍发起了综合报告 judge 调用（真花钱）")

    def test_skip_is_deliberate_not_a_failure(self):
        """与 stopped 完全同形：plan_synthesis / synthesis_error 都是 None ——
        写了 synthesis_error 前端会渲染成「综合报告生成失败」，而这里没失败。"""
        report = self._run([OBSERVE_EMPTY])
        row = self.row()
        self.assertIsNone(row["plan_synthesis"])
        self.assertIsNone(row["synthesis_error"],
                          "有意没做被写成了「综合报告生成失败」")
        self.assertIsNone(report["plan_synthesis"])
        self.assertIsNone(report["synthesis_error"])

    def test_run_still_completes_normally(self):
        """短路的是综合报告，不是 run：终态照旧 completed（前端据环节判定渲染
        「完成 · 无可评估数据」），环节摘要照常落库。"""
        report = self._run([OBSERVE_EMPTY])
        self.assertEqual(report["status"], "completed")
        row = self.row()
        self.assertEqual(row["status"], "completed")
        self.assertEqual(len(row["stage_summaries"]), 1)
        self.assertEqual(row["stage_summaries"][0]["sessions"], 0)

    def test_no_synthesis_events_are_announced(self):
        """stopped 路连 synthesis_start/done 都不发（都在 stop_note is None 门
        里）—— 同形：不许先宣布「生成综合报告…」再没有下文。"""
        self._run([OBSERVE_EMPTY])
        kinds = [e.get("event") for e in self.events]
        self.assertNotIn("synthesis_start", kinds)
        self.assertNotIn("synthesis_done", kinds)

    def test_all_stage_types_empty_still_short_circuits(self):
        """三种环节的空形态混在一个 run 里，仍是零数据。"""
        self._run([OBSERVE_EMPTY, DATASET_GONE, DATASET_NO_EVAL,
                   OBSERVE_CRASH, REDTEAM_CRASH])
        self.assertEqual(self.judge.call_count, 0)
        self.assertIsNone(self.row()["synthesis_error"])


# ------------------------------------------------ 验收 2：反向钉 —— 有数据照常

class RunWithDataStillSynthesizes(DdbFixture):
    def test_observe_with_sessions_generates(self):
        report = self._run([observe_ok()])
        self.assertEqual(self.judge.call_count, 1)
        self.assertEqual(report["plan_synthesis"], SYNTHESIS)
        self.assertEqual(self.row()["plan_synthesis"], SYNTHESIS)
        kinds = [e.get("event") for e in self.events]
        self.assertIn("synthesis_start", kinds)
        self.assertIn("synthesis_done", kinds)

    def test_one_stage_with_data_among_empties_generates(self):
        """全部环节皆空才短路：任一环节有数据 → 照常生成。"""
        self._run([OBSERVE_EMPTY, dataset_ok(), REDTEAM_CRASH])
        self.assertEqual(self.judge.call_count, 1)
        self.assertEqual(self.row()["plan_synthesis"], SYNTHESIS)

    def test_salvaged_redteam_attacks_count_as_data(self):
        """checkpoint 抢救出的攻击是用户已付费的数据，谈得上趋势。"""
        self._run([redteam_salvaged()])
        self.assertEqual(self.judge.call_count, 1)


class NoEvaluableDataHelper(unittest.TestCase):
    """判定函数的形态矩阵（单一住所 _no_evaluable_data，直接单测各真形态）。"""

    def helper(self, results):
        import planrun
        return planrun._no_evaluable_data(results)

    def test_empty_shapes_are_empty(self):
        for res in (OBSERVE_EMPTY, OBSERVE_CRASH, DATASET_GONE,
                    DATASET_NO_EVAL, REDTEAM_CRASH):
            with self.subTest(res=res):
                self.assertTrue(self.helper([res]))

    def test_data_shapes_are_data(self):
        for res in (observe_ok(), dataset_ok(), redteam_salvaged()):
            with self.subTest(res=res):
                self.assertFalse(self.helper([res]))

    def test_dataset_salvage_with_no_results_is_still_empty(self):
        """salvage 路有 report 但一条结果都没抢救出来 → 仍是空。"""
        self.assertTrue(self.helper([{**DATASET_GONE, "cases": 0,
                                      "report": {"results": []},
                                      "salvaged": True}]))


# ------------------------------------------------ 验收 4：重试预算 2→4

class RetryBudget(unittest.TestCase):
    """瞬时 ServiceUnavailable 不许两发就直穿给用户 —— config 对象级断言，
    防「注释改了、参数静默回退」。"""

    def test_bedrock_converse_retry_budget_is_four(self):
        import judgellm

        captured: dict = {}
        fake = mock.MagicMock()
        fake.converse.return_value = {
            "output": {"message": {"content": [{"text": "ok"}]}},
            "stopReason": "end_turn"}

        def client(service, region_name=None, config=None):
            captured["config"] = config
            return fake

        with mock.patch.object(judgellm, "get_config", return_value={
                "provider": "bedrock", "model": "m",
                "base_url": "", "secret_id": ""}), \
                mock.patch.object(judgellm.boto3, "client", side_effect=client):
            judgellm.converse(None, None, "hi", 64)
        cfg = captured["config"]
        self.assertEqual(cfg.retries["max_attempts"], 4)
        # 权衡的另一半不许被顺手改掉：长推理响应仍要等得起
        self.assertEqual(cfg.read_timeout, 900)

    def test_openai_client_retry_budget_is_four(self):
        import judgellm

        fake_openai = types.ModuleType("openai")
        fake_openai.OpenAI = mock.MagicMock()
        with mock.patch.dict(sys.modules, {"openai": fake_openai}), \
                mock.patch.object(judgellm, "_api_key", return_value="k"):
            judgellm._openai_client({"base_url": "https://api.example.com/v1",
                                     "secret_id": "eval-anything/judge-openai"})
        kwargs = fake_openai.OpenAI.call_args.kwargs
        self.assertEqual(kwargs["max_retries"], 4)
        self.assertEqual(kwargs["timeout"], 900.0)


if __name__ == "__main__":
    unittest.main()
