"""J3：成本熔断文案单一住所（simplify-r2 Track B）。

`testrun._cost_circuit_note` 的 docstring 自己写着「与 redteam.py 的熔断文案逐字
同形」—— 而 redteam 那份是手抄的字面量。两份文案漂移一次，用户在回归与红队两处
读到的就是同一件事的两种说法，而前端 lib/scoring.ts 只认 status、说明全靠这句话。

同族的第二半：熔断**阈值**（COST_CIRCUIT_FACTOR）此前也是两个字面量。文案里引的
是「预估的 3.0x」，真正拦下 run 的是各自那个常量 —— 只改一边，文案就会当着用户
的面说谎。照 redteam.py:124 `STOP_STATUS = testrun.STOP_STATUS` 的既有队形收敛。

⚠️ 本文件顺带把 redteam 的**冻结 marker** 全文钉住（前端按前缀识别空响应/调用
失败，CI 另有一道读源码的护栏）：本批动了 redteam.py，marker 一字都不许挪。

Run: python3 -m pytest tests/test_r2_infra_circuit_note.py -q
"""

import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

APP = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(APP))

os.environ.pop("ARTIFACTS_BUCKET", None)

import redteam  # noqa: E402
import testrun  # noqa: E402

TABLE = "eval-catalog-test"
REGION = "us-west-2"
AGENT = "support-bot"

# 52a5bcf 的 app/redteam.py:801-802 手抄字面量（拼法逐字保留在这里当预言机）
def pre_change_literal(actual_cost, budget, factor=3.0) -> str:
    return (f"实际成本 ${actual_cost} 超过预估的 "
            f"{factor}x（${round(budget, 4)}），已自动熔断中止")


class RedteamHaltNote(unittest.TestCase):
    """红队取消路径的熔断分支：真跑一遍 execute_redteam_run（SDK 全打桩）。"""

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
        patches = [
            mock.patch.object(catalog, "get_table", return_value=self.table),
            mock.patch.object(catalog, "TABLE_NAME", TABLE),
            mock.patch.object(catalog, "get_agent_config", return_value={}),
            mock.patch.object(testrun, "_table", return_value=self.table),
            mock.patch.object(redteam, "PROGRESS_INTERVAL_S", 0.01),
            mock.patch.object(redteam, "_attacker_model", return_value=mock.MagicMock()),
            mock.patch.object(redteam, "_build_strategies", return_value=["strategy"]),
            mock.patch.object(redteam, "_to_redteam_case", return_value=object()),
            mock.patch.object(redteam, "_generate_redteam_analysis",
                              mock.AsyncMock(return_value="解析")),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def halt(self, cost: float, estimate_usd: float, run_id="rt-20260825120000"):
        cases = [{"name": "esc_1", "input": "越权", "risk_category": "guideline_bypass"}]

        class FakeExperiment:
            def __init__(self, **kw):
                pass

            async def run_evaluations_async(self, **kw):
                await asyncio.sleep(30)     # 长跑的攻击，只会被熔断取消
                return object()

        with mock.patch("strands_evals.experimental.redteam.RedTeamExperiment",
                        FakeExperiment), \
                mock.patch.object(redteam, "_accrue_cost", return_value=cost):
            return asyncio.run(redteam.execute_redteam_run(
                run_id, AGENT, "arn:x", cases, ["strategy"], "judge-model",
                "anthropic.claude-sonnet-5", {"estimated_cost_usd": estimate_usd},
                "off", None))

    def test_note_comes_from_the_shared_one(self):
        run = self.halt(cost=100.0, estimate_usd=0.1)
        self.assertEqual(run["status"], "halted_cost")
        budget = 0.1 * testrun.COST_CIRCUIT_FACTOR
        self.assertEqual(run["error"],
                         testrun._cost_circuit_note(run["actual_cost_usd"], budget))

    def test_note_is_byte_identical_to_the_pre_change_literal(self):
        # 每组都必须真的越界（cost > estimate × 3），否则熔断分支根本不跑
        for i, (cost, estimate) in enumerate([(100.0, 0.1), (1.53, 0.17),
                                              (0.9999, 0.05)]):
            with self.subTest(cost=cost):
                run = self.halt(cost=cost, estimate_usd=estimate,
                                run_id=f"rt-2026082512000{i}")
                self.assertEqual(run["error"],
                                 pre_change_literal(cost, estimate * 3.0))

    def test_both_modes_say_the_same_sentence(self):
        run = self.halt(cost=1.53, estimate_usd=0.17)
        dataset_side = testrun._cost_circuit_note(1.53, 0.17 * 3.0)
        self.assertEqual(run["error"], dataset_side)
        self.assertIn("已自动熔断中止", run["error"])

    def test_the_halted_run_is_persisted_with_that_note(self):
        self.halt(cost=100.0, estimate_usd=0.1)
        stored = redteam.get_redteam_run("rt-20260825120000")
        self.assertEqual(stored["status"], "halted_cost")
        self.assertEqual(stored["error"],
                         testrun._cost_circuit_note(stored["actual_cost_usd"],
                                                    0.1 * testrun.COST_CIRCUIT_FACTOR))


class OneHomeForTheSentence(unittest.TestCase):
    testrun_src = (APP / "testrun.py").read_text()
    redteam_src = (APP / "redteam.py").read_text()

    def test_the_sentence_is_written_down_exactly_once_in_app(self):
        """整句熔断说明（带实际成本与阈值）只有 testrun.py 一个住所。

        planrun.py:992 那句「成本超出预估，已自动熔断中止」**不是这句话的副本**：
        它是环节一行话在该环节**根本没有 error** 时的兜底措辞（不带任何数字），
        刻意不同。收敛与否属 Track A 的地盘，此处不连坐。
        """
        homes = [p.name for p in sorted(APP.glob("*.py"))
                 if "实际成本 $" in p.read_text()]
        self.assertEqual(homes, ["testrun.py"])

    def test_redteam_keeps_no_copy_of_the_wording(self):
        for fragment in ("实际成本 $", "超过预估的", "已自动熔断中止"):
            with self.subTest(fragment):
                self.assertNotIn(fragment, self.redteam_src)

    def test_redteam_calls_the_shared_one(self):
        self.assertIn("testrun._cost_circuit_note(", self.redteam_src)

    def test_dataset_halt_branch_still_records_its_own_reason(self):
        """既有护栏同族：熔断分支的 status 与 error 必须还在一起。"""
        at = self.testrun_src.index('run["status"] = "halted_cost"')
        self.assertIn('run["error"] = _cost_circuit_note(',
                      self.testrun_src[at:at + 400])


class OneThresholdConstant(unittest.TestCase):
    def test_redteam_borrows_the_factor_from_testrun(self):
        self.assertIs(redteam.COST_CIRCUIT_FACTOR, testrun.COST_CIRCUIT_FACTOR)
        self.assertEqual(testrun.COST_CIRCUIT_FACTOR, 3.0)

    def test_redteam_writes_no_second_literal(self):
        src = (APP / "redteam.py").read_text()
        self.assertEqual(src.count("COST_CIRCUIT_FACTOR = 3.0"), 0,
                         "文案引的是一个常量、拦 run 的是另一个 —— 改一边就会当"
                         "着用户的面说谎")


class FrozenMarkersUntouched(unittest.TestCase):
    """前端按前缀识别空响应/调用失败（liveTurns.ts + live-turns.test.ts 对刑）。"""

    BLANK = ("[被测 Agent 返回空响应：无任何输出，既未回答也未拒绝。"
             "常见原因是被测 Agent 侧的模型内容过滤拦截了本次生成"
             "（其自身 trace 记为 finish_reason=content_filtered）。"
             "不得据此判断它拒绝了攻击。]")
    FAILED = "[被测 Agent 调用失败：本轮攻击未送达，无法据此判断其安全性。错误："

    def test_blank_marker_is_byte_for_byte(self):
        self.assertEqual(redteam.BLANK_TARGET_MARKER, self.BLANK)

    def test_invoke_failed_marker_is_byte_for_byte(self):
        self.assertEqual(redteam.INVOKE_FAILED_MARKER, self.FAILED)

    def test_source_still_declares_them_the_same_way(self):
        src = (APP / "redteam.py").read_text()
        self.assertIn("BLANK_TARGET_MARKER = (", src)
        self.assertIn('INVOKE_FAILED_MARKER = "[被测 Agent 调用失败：', src)


if __name__ == "__main__":
    unittest.main()
