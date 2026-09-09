"""回归环节摘要缺「逐评估器」这一层：只有一个 pass_rate，看不出是谁在拖分。

`_stage_summary` 的 dataset 分支此前只出 pass_rate / cases / blank_cases。
方案页、大屏、报告抽屉、趋势读的**只有**这份摘要（完整明细在 S3，列表页不拉），
于是「通过率 60%」既说不出是 correctness 还是 helpfulness 掉的，也说不出这一环
到底配了哪些评估器。本批补两个字段（前端批随后消费）：

  out["evaluators"]      = 环节配置回显（配了什么）
  out["evaluator_stats"] = {name: {"mean", "passed", "judged"}}（谁评出了什么）

口径与同文件 pass_rate 同源，**先剔 errored 再算**：评估器执行失败是「未产出
结论、需排查后重跑」，既不是通过也不是不通过（见 _run_dataset_stage 的长注释
与 observe.summarize）。上界是评估器个数（与用例数无关），进 DDB 摘要安全。

两条不许动的边界，本文件一并钉：
  · observe / redteam 的摘要形状不变；
  · 顶层 score 语义不变 —— 只在 observe 环节 overall_mean 存在时写
    （ADR-0003 硬线）。逐评估器均分**绝不**顺手变成一个 run 级分数。

moto 的真 DynamoDB + 打桩 S3；不碰真 agent / 真 LLM。
运行：python3 -m pytest tests/test_evaluator_stats_field.py -q
"""

import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import planrun  # noqa: E402

TABLE = "eval-catalog-test"
BUCKET = "eval-artifacts-test"
REGION = "us-west-2"
AGENT_NAME = "support-bot"
DATASET = {"name": "regression-v1", "cases": [{"name": "c1", "input": "hi"}]}
# 这里钉的是 evaluator_stats 的形状与算术，与 trace 核对无关 ⇒ 显式关（2026-09-08 起缺键 = 开）。
PLAN = {"plan_id": "plan-e0634c304c95", "name": "回归周巡检",
        "agent_name": AGENT_NAME, "stages": [{"type": "dataset"}], "trace_required": False}
AGENT = {"agent_name": AGENT_NAME, "runtime_arn": "arn:aws:bedrock:x:y:runtime/z"}

ERRORED = {"score": None, "passed": None, "errored": True,
           "reason": "An error occurred: ThrottlingException"}


def verdict(score: float, passed: bool) -> dict:
    return {"score": score, "passed": passed, "errored": False, "reason": "理由"}


def case_row(name: str, results: dict, **over) -> dict:
    return {"agent": AGENT_NAME, "case": name, "input": "hi", "output": "答案",
            "results": results, **over}


def dataset_stage_result(rows: list[dict], evaluators=("correctness", "helpfulness"),
                         **over) -> dict:
    """_run_dataset_stage 的返回形状（_stage_summary 的输入）。"""
    return {
        "type": "dataset", "status": "completed", "error": None,
        "run_id": "run-20260824165133", "dataset": DATASET["name"],
        "evaluators": list(evaluators),
        "cases": len(rows), "judged_cases": len(rows), "pass_rate": 1.0,
        "blank_cases": 0, "actual_cost_usd": 0.12,
        "report": {"run_id": "run-20260824165133", "status": "completed",
                   "evaluators": list(evaluators), "results": rows},
        **over,
    }


class EvaluatorStats(unittest.TestCase):
    def test_each_evaluator_gets_its_own_mean_and_counts(self):
        """要害：一个 pass_rate 说不出是谁在拖分 —— 逐评估器给出均分与计数。"""
        summary = planrun._stage_summary(dataset_stage_result([
            case_row("c1", {"correctness": verdict(1.0, True),
                            "helpfulness": verdict(0.5, False)}),
            case_row("c2", {"correctness": verdict(0.8, True),
                            "helpfulness": verdict(0.7, True)}),
        ]))
        self.assertEqual(summary["evaluator_stats"], {
            "correctness": {"mean": 0.9, "passed": 2, "judged": 2},
            "helpfulness": {"mean": 0.6, "passed": 1, "judged": 2},
        })

    def test_the_stage_echoes_the_evaluators_it_was_configured_with(self):
        """配了什么也要出库：没有它，「stats 里没有 helpfulness」分不清是
        没配还是全被限流。"""
        summary = planrun._stage_summary(dataset_stage_result(
            [case_row("c1", {"correctness": verdict(1.0, True)})],
            evaluators=("correctness", "helpfulness")))
        self.assertEqual(summary["evaluators"], ["correctness", "helpfulness"])

    def test_errored_verdicts_are_excluded_from_mean_and_counts(self):
        """口径与 pass_rate 同源：评估器执行失败不是 0 分，先剔再算。"""
        summary = planrun._stage_summary(dataset_stage_result([
            case_row("c1", {"correctness": verdict(1.0, True)}),
            case_row("c2", {"correctness": dict(ERRORED)}),
        ]))
        self.assertEqual(summary["evaluator_stats"]["correctness"],
                         {"mean": 1.0, "passed": 1, "judged": 1})

    def test_an_all_errored_evaluator_is_kept_with_zero_judgments(self):
        """全被限流的评估器不许从摘要里消失（沉默会被读成「它评过且没问题」）：
        名字留着，judged=0、mean 为空，如实说「一条判定都没有」。"""
        summary = planrun._stage_summary(dataset_stage_result([
            case_row("c1", {"correctness": verdict(1.0, True),
                            "helpfulness": dict(ERRORED)}),
        ]))
        self.assertEqual(summary["evaluator_stats"]["helpfulness"],
                         {"mean": None, "passed": 0, "judged": 0})

    def test_unjudgeable_cases_do_not_enter_the_counts(self):
        """空响应/调用失败的用例根本没有判定（testrun 直接跳过判分）——
        它们不许稀释任何评估器的均分。"""
        summary = planrun._stage_summary(dataset_stage_result([
            case_row("c1", {"correctness": verdict(0.6, True)}),
            case_row("c2", {}, blank_output=True),
            case_row("c3", {}, error=" 调用失败"),
        ]))
        self.assertEqual(summary["evaluator_stats"]["correctness"],
                         {"mean": 0.6, "passed": 1, "judged": 1})

    def test_mean_is_rounded_to_four_places(self):
        """摘要进 DDB：均分与全站其它均分同精度（round 4）。"""
        summary = planrun._stage_summary(dataset_stage_result([
            case_row("c1", {"correctness": verdict(1 / 3, True)}),
        ]))
        self.assertEqual(summary["evaluator_stats"]["correctness"]["mean"], 0.3333)

    def test_bounded_by_evaluator_count_not_case_count(self):
        """上界天然有界：100 个用例仍只有评估器个数条 —— 摘要项不会被撑爆。"""
        summary = planrun._stage_summary(dataset_stage_result(
            [case_row(f"c{i}", {"correctness": verdict(1.0, True)})
             for i in range(100)], evaluators=("correctness",)))
        self.assertEqual(len(summary["evaluator_stats"]), 1)
        self.assertEqual(summary["evaluator_stats"]["correctness"]["judged"], 100)

    def test_a_stage_without_a_report_still_summarizes(self):
        """明细被削去 S3 / 环节短路成 empty：不许抛，stats 为空即可。"""
        summary = planrun._stage_summary({"type": "dataset", "status": "empty",
                                          "cases": 0, "error": "环节未配置评估器"})
        self.assertEqual(summary["evaluator_stats"], {})
        self.assertEqual(summary["evaluators"], [])

    # ---- 边界：别的环节与顶层 score 不许被碰 ----

    def test_observe_summary_shape_is_untouched(self):
        summary = planrun._stage_summary({
            "type": "observe", "status": "completed", "sessions": 2,
            "overall_mean": 0.83,
            "summary": {"helpfulness": {"mean_score": 0.83, "pass_rate": 1.0}}})
        self.assertNotIn("evaluator_stats", summary)
        self.assertEqual(summary["overall_mean"], 0.83)

    def test_redteam_summary_shape_is_untouched(self):
        summary = planrun._stage_summary({
            "type": "redteam", "status": "completed", "attacks": 20,
            "breached": 2, "verdict": "PARTIAL"})
        self.assertNotIn("evaluator_stats", summary)
        self.assertEqual(summary["attacks"], 20)


class PersistRoundTrip(unittest.TestCase):
    """摘要落 DDB（JSON 串整存整取）再读回：新字段不许在路上掉。"""

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
        for p in (mock.patch.object(catalog, "get_table", return_value=self.table),
                  mock.patch.dict(os.environ, {"ARTIFACTS_BUCKET": BUCKET}),
                  mock.patch.object(planrun.runstore, "_s3", return_value=mock.MagicMock())):
            p.start()
            self.addCleanup(p.stop)

    def _persist(self, stage_results):
        planrun._persist(PLAN, f"{PLAN['plan_id']}#20260824165133", "20260824165133",
                         "manual", "2026-08-24 16:51 UTC", "2026-08-24 16:58 UTC",
                         0.12, stage_results, {"stage_lines": []},
                         {"stages": stage_results})
        return planrun.list_plan_runs(PLAN["plan_id"])[0]

    def test_evaluator_stats_survive_dynamodb(self):
        row = self._persist([dataset_stage_result([
            case_row("c1", {"correctness": verdict(1.0, True),
                            "helpfulness": verdict(0.5, False)}),
        ])])
        stats = row["stage_summaries"][0]["evaluator_stats"]
        self.assertEqual(stats["correctness"], {"mean": 1.0, "passed": 1, "judged": 1})
        self.assertEqual(stats["helpfulness"]["mean"], 0.5)
        self.assertEqual(row["stage_summaries"][0]["evaluators"],
                         ["correctness", "helpfulness"])

    def test_top_level_score_semantics_are_untouched(self):
        """ADR-0003 硬线：顶层 score 只在 observe 环节 overall_mean 存在时写。
        逐评估器均分绝不顺手变成一个 run 级分数（它会直接进均分与趋势）。"""
        row = self._persist([dataset_stage_result([
            case_row("c1", {"correctness": verdict(1.0, True)}),
        ])])
        self.assertIsNone(row["score"], "回归环节的均分被写成了 run 级综合分")

    def test_observe_still_writes_the_top_level_score(self):
        """回归：有 observe 环节时顶层 score 照旧。"""
        row = self._persist([{"type": "observe", "status": "completed",
                              "sessions": 2, "overall_mean": 0.83, "summary": {}}])
        self.assertEqual(row["score"], 0.83)


class StageResultCarriesItsEvaluators(unittest.TestCase):
    """环节配置回显要有真来源：执行侧把 evaluator_names 带进返回值。"""

    def _stage(self, run: dict, evaluators=("correctness",)) -> dict:
        async def emit(_ev):
            pass

        with mock.patch.object(planrun.catalog, "get_dataset", return_value=DATASET), \
                mock.patch.object(planrun.catalog, "list_custom_evaluators",
                                  return_value=[]), \
                mock.patch.object(planrun.testrun, "estimate_test_run",
                                  return_value={"estimated_cost_usd": 0.5}), \
                mock.patch.object(planrun.testrun, "execute_test_run",
                                  new=mock.AsyncMock(return_value=run)):
            return asyncio.run(planrun._run_dataset_stage(
                {"type": "dataset", "dataset": DATASET["name"],
                 "evaluators": list(evaluators), "agent_model": "m"},
                PLAN, AGENT, "judge-model", emit))

    def test_dataset_stage_returns_its_evaluator_names(self):
        res = self._stage({"status": "completed", "total_cases": 1,
                           "completed_cases": 1, "blank_cases": 0,
                           "actual_cost_usd": 0.1,
                           "results": [case_row("c1", {"correctness":
                                                       verdict(1.0, True)})]})
        self.assertEqual(res["evaluators"], ["correctness"])
        self.assertEqual(planrun._stage_summary(res)["evaluator_stats"],
                         {"correctness": {"mean": 1.0, "passed": 1, "judged": 1}})


if __name__ == "__main__":
    unittest.main()
