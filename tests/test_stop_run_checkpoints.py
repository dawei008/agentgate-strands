"""停止请求要在**并发完成循环**里生效：回归的用例循环 / 红队的进度循环（P0）。

方案运行的环节边界检查点（tests/test_stop_plan_run.py）只能在两个环节之间停下来。
用户的真实处境是「红队环节已经跑了 33 分钟」——停止必须能在**环节内部**生效，
否则等于没有。

照抄的是已有的成本熔断模式（同一处、同一套动作）：
  · testrun：as_completed 循环里取消全部在飞 task 并 break，
    **已完成用例的结果一条不丢**（app/testrun.py 熔断分支）；
  · redteam：进度/熔断循环（每 5 秒）里 cancel exp_task。
所以本文件同时钉住两件事：停止真的生效，且**熔断的既有语义没被改写**
（用户停止绝不能被说成「成本熔断中止」——那是两个不同的事实、两种不同的动作）。

停止标志的读取节流在 planrun.stop_requested 里（tests/test_stop_plan_run.py 钉），
这里传入的 stop_check 是纯函数，一次 DDB 读都不产生 —— 也就顺带钉住了
「执行侧不自己再造一套轮询」。

moto 的真 DynamoDB；被测 Agent / judge / RedTeamExperiment 全部打桩，
不发起任何真运行、不花一分钱。
运行：python3 -m pytest tests/test_stop_run_checkpoints.py -q
"""

import asyncio
import os
import sys
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

os.environ.pop("ARTIFACTS_BUCKET", None)

TABLE = "eval-catalog-test"
REGION = "us-west-2"
AGENT = "support-bot"
META = {AGENT: {"runtime_arn": "arn:aws:bedrock-agentcore:us-west-2:1:runtime/x",
                "model": "anthropic.claude-sonnet-5"}}


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
        import testrun
        for p in (mock.patch.object(catalog, "get_table", return_value=self.table),
                  mock.patch.object(catalog, "TABLE_NAME", TABLE),
                  mock.patch.object(catalog, "get_agent_config", return_value={}),
                  # RUN / RTRUN 的落库都走 testrun._table()（redteam 也用它）
                  mock.patch.object(testrun, "_table", return_value=self.table)):
            p.start()
            self.addCleanup(p.stop)


# ------------------------------------------------- 回归：用例完成循环的检查点

class StoppedTestRun(DdbFixture):
    def setUp(self):
        super().setUp()
        import testrun
        self.testrun = testrun
        pr = mock.patch.object(testrun.pricing, "get_prices",
                               return_value={"prices": {}})
        pr.start()
        self.addCleanup(pr.stop)
        # 用例串行执行：停止发生在第 1 个用例之后，第 2 个用例必须**根本没开始**
        b = mock.patch.object(testrun, "RUN_TTL_BATCH", 1)
        b.start()
        self.addCleanup(b.stop)
        self.analysis = mock.AsyncMock(return_value="解析")
        a = mock.patch.object(testrun, "_generate_run_analysis", self.analysis)
        a.start()
        self.addCleanup(a.stop)

    def _run(self, stop_after: int | None = 1, n_cases: int = 4,
             estimate_usd: float = 1.0, price=None):
        dataset = {"name": "faq", "cases": [{"name": f"c{i}", "input": "问题"}
                                            for i in range(n_cases)]}
        self.invoked = []

        def fake_invoke(arn, cfg, case_input, sid):
            self.invoked.append(case_input)
            return "这是一段真实回答"

        def stop_check():
            return stop_after is not None and len(self.invoked) >= stop_after

        with ExitStack() as stack:
            # 传输件转公名（simplify-r2 L2）：patch 目标随之去下划线，行为不变
            stack.enter_context(mock.patch.object(self.testrun, "invoke_agent",
                                                  fake_invoke))
            if price is not None:
                stack.enter_context(mock.patch.object(
                    self.testrun.pricing, "lookup_price", return_value=price))
            return asyncio.run(self.testrun.execute_test_run(
                "run-20260824120000", dataset, [AGENT], [], "judge-model", {},
                META, {"estimated_cost_usd": estimate_usd},
                stop_check=stop_check if stop_after is not None else None))

    # ---- 停止真的生效 ----

    def test_remaining_cases_are_never_invoked(self):
        """此断言曾偶发 `2 != 1`：不是锚点不严，是缺陷 —— 主循环的检查点在用例
        完成之后，而名额一还回信号量下一例就已把 invoke 提交进线程池，cancel 能不能
        撤回取决于工作线程抢没抢到（成因与确定性红测见 tests/test_stop_run_admission.py）。
        修后 run_one 拿到名额的第一条语句就问 stop_check，第 2 例根本不提交，所以
        「执行次数 == 1」在这里是确定的，锚点不动。"""
        run = self._run()
        self.assertEqual(len(self.invoked), 1,
                         "停止之后还继续真调了被测 Agent（继续花钱）")
        self.assertEqual(run["total_cases"], 4)
        self.assertEqual(run["completed_cases"], 1)

    def test_status_is_stopped_not_halted_or_completed(self):
        run = self._run()
        self.assertEqual(run["status"], "stopped")
        self.assertIn("停止", run["error"])
        self.assertNotIn("熔断", run["error"],
                         "把用户主动停止说成成本熔断（两回事、两种动作）")

    def test_finished_case_results_survive(self):
        run = self._run()
        self.assertEqual(len(run["results"]), 1)
        self.assertEqual(run["results"][0]["output"], "这是一段真实回答")

    def test_terminal_state_is_persisted(self):
        self._run()
        stored = self.testrun.get_test_run("run-20260824120000")
        self.assertEqual(stored["status"], "stopped")
        self.assertEqual(len(stored["results"]), 1)

    def test_no_judge_call_after_a_stop(self):
        """停止就是停止花钱：不再为半截结果生成解析（一次 judge 调用），
        但要说清为什么没有 —— 沉默会被读成「解析本来就没有」。"""
        run = self._run()
        self.assertFalse(self.analysis.called, "停止之后还调了一次 judge")
        self.assertIn("停止", run["analysis"])

    # ---- 既有语义不许被改写 ----

    def test_untouched_run_still_completes(self):
        run = self._run(stop_after=None)
        self.assertEqual(run["status"], "completed")
        self.assertEqual(len(self.invoked), 4)
        self.assertTrue(self.analysis.called)

    def test_cost_circuit_still_says_halted_cost(self):
        """熔断路径一字不动：同一处代码上加了停止分支，不许把熔断也改了名。"""
        run = self._run(stop_after=None, estimate_usd=0.0001,
                        price={"input": 10.0, "output": 10.0})
        self.assertEqual(run["status"], "halted_cost")
        self.assertIn("熔断", run["error"])


# ------------------------------------------------- 红队：进度/熔断循环的检查点

class StoppedRedteamRun(DdbFixture):
    def setUp(self):
        super().setUp()
        import redteam
        import testrun
        self.redteam = redteam
        self.testrun = testrun
        # 进度循环的节奏（既有 5 秒）：测试里压到毫秒级，不新增任何轮询
        i = mock.patch.object(redteam, "PROGRESS_INTERVAL_S", 0.01)
        i.start()
        self.addCleanup(i.stop)
        # SDK 侧（攻击模型 / 策略对象 / case 对象）全部打桩：本测试关心的是
        # 检查点，不是 SDK
        for name, val in (("_attacker_model", mock.MagicMock()),
                          ("_build_strategies", ["strategy"]),
                          ("_to_redteam_case", object())):
            p = mock.patch.object(redteam, name, return_value=val)
            p.start()
            self.addCleanup(p.stop)
        self.analysis = mock.AsyncMock(return_value="解析")
        a = mock.patch.object(redteam, "_generate_redteam_analysis", self.analysis)
        a.start()
        self.addCleanup(a.stop)

    def _run(self, stop: bool, cost: float = 0.0, estimate_usd: float = 10.0):
        cases = [{"name": "esc_1", "input": "越权", "risk_category": "guideline_bypass"}]

        class FakeExperiment:
            def __init__(self, **kw):
                pass

            async def run_evaluations_async(self, **kw):
                await asyncio.sleep(30)   # 长跑的攻击：只会被检查点取消
                return object()

        def stop_check():
            return stop

        with mock.patch("strands_evals.experimental.redteam.RedTeamExperiment",
                        FakeExperiment), \
                mock.patch.object(self.redteam, "_accrue_cost", return_value=cost):
            return asyncio.run(self.redteam.execute_redteam_run(
                "rt-20260824120000", AGENT, "arn:x", cases, ["strategy"],
                "judge-model", "anthropic.claude-sonnet-5",
                {"estimated_cost_usd": estimate_usd}, "off", None,
                stop_check=stop_check))

    def test_in_flight_attacks_are_cancelled_on_a_stop(self):
        run = self._run(stop=True)
        self.assertEqual(run["status"], "stopped")
        self.assertIn("停止", run["error"])

    def test_a_stop_is_not_reported_as_a_cost_circuit(self):
        """红队的取消路径此前只有一个原因（熔断），停止必须分叉出来 ——
        否则用户看到的是「成本熔断中止」，去调预算，而真相是他自己按了停止。"""
        run = self._run(stop=True)
        self.assertNotIn("熔断", run["error"] or "")
        self.assertNotEqual(run["status"], "halted_cost")

    def test_stopped_redteam_run_is_persisted_and_costs_no_judge(self):
        self._run(stop=True)
        stored = self.redteam.get_redteam_run("rt-20260824120000")
        self.assertEqual(stored["status"], "stopped")
        self.assertFalse(self.analysis.called, "停止之后还调了一次 judge")

    def test_cost_circuit_still_says_halted_cost(self):
        run = self._run(stop=False, cost=100.0, estimate_usd=0.1)
        self.assertEqual(run["status"], "halted_cost")
        self.assertIn("熔断", run["error"])


class SourceGuards(unittest.TestCase):
    app = Path(__file__).resolve().parent.parent / "app"
    testrun_src = (app / "testrun.py").read_text()
    redteam_src = (app / "redteam.py").read_text()

    def test_testrun_stop_sits_in_the_existing_case_loop(self):
        """检查点必须长在既有的 as_completed 循环里（成本熔断旁边），
        不许新起一个轮询协程。

        ADR-0019 批 2 把「记账 + 两道闸」收进 `_settle`（两个 as_completed 循环共用：
        调用阶段与按 trace 评分阶段），所以这里认的是：循环体调 `_settle`、`_settle`
        里停止与熔断各自 `return True`、循环体对 True 取消全部在飞 task；仍不许 while True。"""
        body = self.testrun_src[
            self.testrun_src.index("for fut in asyncio.as_completed(tasks):"):
            self.testrun_src.index('if run["status"] == "running":')]
        self.assertIn("if _settle(entry", body)
        self.assertEqual(body.count("t.cancel()"), 2,
                         "两个 as_completed 循环（调用 / 按 trace 评分）都要「取消全部在飞 task」")
        self.assertNotIn("while True", body)
        settle = self.testrun_src[
            self.testrun_src.index("    def _settle(entry"):
            self.testrun_src.index("    tasks = [asyncio.ensure_future(run_one(a, c))")]
        self.assertIn("stop_check", settle)
        for mark in ('run["status"] = "halted_cost"', 'run["status"] = STOP_STATUS'):
            at = settle.index(mark)
            self.assertIn("return True", settle[at:at + 600],
                          f"{mark} 之后没有 return True ⇒ 循环不会取消在飞 task")
        self.assertNotIn("while True", settle)

    def test_testrun_halt_branch_still_records_its_own_reason(self):
        """既有护栏同族：熔断分支的 status 与 error 必须还在一起。"""
        at = self.testrun_src.index('run["status"] = "halted_cost"')
        self.assertIn('run["error"] = _cost_circuit_note(',
                      self.testrun_src[at:at + 400])

    def test_redteam_stop_shares_the_existing_progress_loop(self):
        body = self.redteam_src[
            self.redteam_src.index("    async def track():"):
            self.redteam_src.index("progress_task = asyncio.ensure_future(track())")]
        self.assertIn("stop_check", body)
        self.assertEqual(body.count("while True"), 1, "红队多了一个轮询循环")
        self.assertEqual(body.count("asyncio.sleep("), 1)
        self.assertIn("exp_task.cancel()", body)

    def test_redteam_frozen_markers_untouched(self):
        """冻结文案（前端按前缀识别空响应/调用失败）一字不许动。"""
        self.assertIn('INVOKE_FAILED_MARKER = "[被测 Agent 调用失败：',
                      self.redteam_src)
        self.assertIn("BLANK_TARGET_MARKER = (", self.redteam_src)

    def test_stop_status_is_one_literal(self):
        """两个执行模块说的是同一个词（redteam 取 testrun 的常量），
        不许各写一个字面量 —— 漂移成两个词界面上就会露出英文枚举。"""
        import redteam
        import testrun
        self.assertEqual(testrun.STOP_STATUS, "stopped")
        self.assertEqual(redteam.STOP_STATUS, testrun.STOP_STATUS)
        self.assertEqual(self.redteam_src.count('= "stopped"'), 0)


if __name__ == "__main__":
    unittest.main()
