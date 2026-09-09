"""judge 费用一分钱都没记 → 成本熔断整条链路失效（P1，2026-08-24 生产实测）。

现场：run `plan-e0634c304c95#20260824184019`，judge_model=
`global.anthropic.claude-sonnet-5`，40 次 judge 调用，
`estimate.estimated_cost_usd=0.42` 而 `actual_cost_usd=0.0`。
0.42 正是 40 × 2500/1000 × (0.003×0.9 + 0.015×0.1) —— 预估里**整整 100%
是 judge 费用**（该环节 agent_model 为空，被测侧预估本来就按 0 计）。

机制（`testrun.py` 的完成循环）：
  · 记账只累加**被测 Agent** 侧，judge 调用从头到尾没有任何计费口；
  · 被测侧那句 `if p:` 没有 else，查无价就整段跳过；
  · 于是 `actual_cost_usd` 恒 0 ⇒ 紧随其后的 `if budget and actual > budget`
    **永不为真** ⇒ 熔断计数器恒 0，预算（预估×3）形同虚设。
「成本显示 0」与「熔断死了」是同一处代码的两个症状。

三条不变量，本文件逐条钉：
  1. judge 侧照实计入，且查无价时用**与预估同一个**兜底费率
     （pricing.judge_price），绝不静默计 0 —— 熔断保护不能依赖价表恰好有行；
  2. 缓存命中的**被测 Agent** 侧豁免必须保住（命中没调 Agent），但同一条命中
     的重新判分是真 judge 调用，照实计 —— 那正是 reuse 模式的用途；
  3. 被测 Agent 的模型查无价时**不伪造费率**（预估侧也按 0 计，熔断比的是实际
     与那个预估），但不再一声不响：名字进 run 的 unpriced_agents 留痕。

moto 的真 DynamoDB；被测 Agent / judge / strands Experiment 全部打桩，
不发起任何真运行、不花一分钱。
运行：python3 -m pytest tests/test_judge_pricing_circuit.py -q
"""

import asyncio
import os
import sys
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

os.environ.pop("ARTIFACTS_BUCKET", None)

TABLE = "eval-catalog-test"
REGION = "us-west-2"
AGENT = "support-bot"
JUDGE = "global.anthropic.claude-sonnet-5"
# 生产现场的形态：被测环节没有配 agent_model（预估侧因此把被测费用按 0 计）
META_NO_MODEL = {AGENT: {"runtime_arn": "arn:aws:bedrock-agentcore:us-west-2:1:runtime/x",
                         "model": ""}}
META_PRICED = {AGENT: {"runtime_arn": "arn:aws:bedrock-agentcore:us-west-2:1:runtime/x",
                       "model": "anthropic.claude-sonnet-5"}}
SONNET = {"anthropic.claude-sonnet-5": {"input": 0.003, "output": 0.015,
                                        "source": "builtin", "updated_at": None}}


# ---------------------------------------------------------------- 费率解析

class JudgePriceFallback(unittest.TestCase):
    """judge 费率解析：有行用行，无行用兜底并说出来（不碰 AWS）。"""

    def setUp(self):
        import pricing
        self.pricing = pricing
        self.builtin = {k: {**v, "source": "builtin", "updated_at": None}
                        for k, v in pricing.BUILTIN_PRICES.items()}

    def test_default_judge_model_is_priced_by_the_builtin_table(self):
        """DDB 的 PRICE 分区可以一行价格都没有（现场就是），内置表必须兜住
        judge 模型族 —— 区域前缀与版本尾巴都要能归一。"""
        from registry import DEFAULT_JUDGE_MODEL
        for model in (DEFAULT_JUDGE_MODEL, "global.anthropic.claude-sonnet-5",
                      "us.anthropic.claude-sonnet-5-v1:0",
                      "anthropic.claude-sonnet-5", "claude-sonnet-5"):
            rate, unpriced = self.pricing.judge_price(model, self.builtin)
            self.assertFalse(unpriced, f"{model} 在内置价表里查不到价")
            self.assertEqual((rate["input"], rate["output"]), (0.003, 0.015))

    def test_unknown_judge_model_falls_back_instead_of_zero(self):
        """judge 是**我们自己**配置的模型（可换成 OpenAI 兼容端点的任意名字）：
        查无价就用兜底费率，绝不返回「没有价」让调用方计 0。"""
        rate, unpriced = self.pricing.judge_price("my-private-judge", {})
        self.assertTrue(unpriced)
        self.assertEqual(rate, self.pricing.JUDGE_PRICE_FALLBACK)

    def test_fallback_is_the_same_rate_the_estimate_uses(self):
        """预估侧此前把 {0.003, 0.015} 内联在四处；实际记账侧一处都没有。
        两侧必须是同一个常量，否则熔断比的是两把尺子。"""
        self.assertEqual(self.pricing.JUDGE_PRICE_FALLBACK,
                         {"input": 0.003, "output": 0.015})


# ---------------------------------------------------------------- 记账/熔断

class FakeReport:
    """strands EvaluationReport 的最小形状（_collect_results 只读这四个序列）。"""

    def __init__(self, names, score):
        self.cases = [{"evaluator": n} for n in names]
        self.reasons = ["判定理由" for _ in names]
        self.scores = [score for _ in names]
        self.test_passes = [score >= 0.5 for _ in names]


class FakeExperiment:
    """替掉 strands_evals.Experiment：产出判定行，但不发一次 judge 调用。"""

    def __init__(self, cases=None, evaluators=None, **kw):
        self._names = [e.name for e in (evaluators or [])]

    async def run_evaluations_async(self, task, **kw):
        task(None)
        return FakeReport(self._names, 0.9)


class FakeStore:
    """结果缓存的最小替身：全命中或全不命中。"""

    def __init__(self, hit_output: str | None):
        self.hit_output = hit_output
        self.saved = []
        self.skipped: list = []
        self.rejected: list = []

    def load(self, case_name):
        if self.hit_output is None:
            return None
        return SimpleNamespace(actual_output=self.hit_output, metadata={})

    def save(self, case_name, data):
        self.saved.append(case_name)

    def stats(self):
        return {}


class ActualCostAccrual(unittest.TestCase):
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
        self.testrun = testrun
        for p in (mock.patch.object(catalog, "get_table", return_value=self.table),
                  mock.patch.object(catalog, "TABLE_NAME", TABLE),
                  mock.patch.object(catalog, "get_agent_config", return_value={}),
                  mock.patch.object(testrun, "_table", return_value=self.table),
                  mock.patch.object(testrun, "RUN_TTL_BATCH", 1),
                  mock.patch.object(testrun, "_generate_run_analysis",
                                    new=mock.AsyncMock(return_value="解析"))):
            p.start()
            self.addCleanup(p.stop)

    def _run(self, prices: dict, evaluators=("correctness",), n_cases=2,
             estimate_usd=1.0, meta=META_NO_MODEL, cache_hit=None,
             judge_model=JUDGE, run_id="run-20260824180000"):
        dataset = {"name": "faq", "cases": [{"name": f"c{i}", "input": "问题"}
                                            for i in range(n_cases)]}
        self.invoked = []
        self.store = FakeStore(cache_hit)

        def fake_invoke(arn, cfg, case_input, sid):
            self.invoked.append(case_input)
            return "这是一段真实回答"

        with ExitStack() as stack:
            # 传输件转公名（simplify-r2 L2）：patch 目标随之去下划线，行为不变
            stack.enter_context(mock.patch.object(self.testrun, "invoke_agent",
                                                  fake_invoke))
            stack.enter_context(mock.patch.object(
                self.testrun.pricing, "get_prices",
                return_value={"prices": prices, "last_sync": None}))
            stack.enter_context(mock.patch.object(
                self.testrun, "build_evaluators",
                lambda names, model, rubrics=None: [SimpleNamespace(name=n)
                                                    for n in names]))
            stack.enter_context(mock.patch("strands_evals.Experiment",
                                           FakeExperiment))
            import evalcache
            stack.enter_context(mock.patch.object(evalcache, "make_store",
                                                 return_value=self.store))
            return asyncio.run(self.testrun.execute_test_run(
                run_id, dataset, [AGENT], list(evaluators), judge_model, {},
                meta, {"estimated_cost_usd": estimate_usd},
                cache_mode="off" if cache_hit is None else "reuse"))

    def _judge_only_cost(self, n_calls: int, rate=(0.003, 0.015)) -> float:
        return round(n_calls * (self.testrun.JUDGE_TOKENS_PER_EVAL / 1000)
                     * (rate[0] * 0.9 + rate[1] * 0.1), 4)

    # ---- 不变量 1：judge 侧照实计入，无价用兜底 ----

    def test_judge_calls_are_billed_when_nothing_is_priced(self):
        """价表整个是空的（现场：PRICE 分区只有 _last_sync 一行）：judge 调用
        照兜底费率计入，绝不再是 0。"""
        run = self._run(prices={})
        self.assertEqual(run["actual_cost_usd"], self._judge_only_cost(2),
                         "judge 费用没进实际成本（修复前恒 0.0）")

    def test_judge_calls_are_billed_when_the_target_model_is_unpriced(self):
        """现场形态：judge 有价、被测 agent_model 为空。预估的 0.42 全是 judge
        费用，实际侧必须算出同一族的数字。"""
        run = self._run(prices=SONNET, n_cases=4)
        self.assertEqual(run["actual_cost_usd"], self._judge_only_cost(4))

    # ---- 不变量 1b：无价的被测 Agent 不许把「judge 侧」读成全额（P1，2026-09-04）----

    def test_unpriced_target_marks_cost_partial_and_nulls_agent_side(self):
        """现场：四份不同模型的回归 run 成本全等于预估 0.4725。两侧都只剩 judge 项，
        Agent 侧 0 被当成「这次运行的全额」展示。修后：actual_cost_usd 仍 = 可算部分
        （judge），但 cost_is_partial=true、cost_breakdown.agent_usd=null、unpriced 点名。"""
        run = self._run(prices=SONNET, n_cases=4)
        self.assertTrue(run["cost_is_partial"])
        bd = run["cost_breakdown"]
        self.assertIsNone(bd["agent_usd"])
        self.assertEqual(bd["unpriced"], [AGENT])
        self.assertEqual(bd["judge_usd"], self._judge_only_cost(4))
        self.assertEqual(run["actual_cost_usd"], bd["judge_usd"],
                         "actual_cost_usd 必须恒等于可算部分之和")

    def test_priced_target_is_not_partial_and_splits_judge_from_agent(self):
        run = self._run(prices=SONNET, n_cases=2, meta=META_PRICED)
        self.assertFalse(run["cost_is_partial"])
        bd = run["cost_breakdown"]
        self.assertEqual(bd["unpriced"], [])
        self.assertEqual(bd["judge_usd"], self._judge_only_cost(2))
        self.assertGreater(bd["agent_usd"], 0.0)
        self.assertAlmostEqual(run["actual_cost_usd"], bd["judge_usd"] + bd["agent_usd"],
                               places=3)

    def test_cache_hit_with_unpriced_target_is_not_partial(self):
        """缓存命中根本没调被测 Agent：不是「无价」，也不算 partial。"""
        run = self._run(prices=SONNET, n_cases=2, cache_hit="录好的回答")
        self.assertFalse(run["cost_is_partial"])
        self.assertEqual(run["cost_breakdown"]["agent_usd"], 0.0)
        self.assertEqual(run["cost_breakdown"]["unpriced"], [])

    def test_estimate_says_partial_when_target_unpriced(self):
        est = self.testrun.estimate_test_run(
            {"name": "faq", "cases": [{"name": "c0", "input": "问题"}]},
            [AGENT], ["correctness"], META_NO_MODEL)
        self.assertTrue(est["cost_is_partial"])
        self.assertEqual(est["unpriced_agents"], [AGENT])
        est2 = self.testrun.estimate_test_run(
            {"name": "faq", "cases": [{"name": "c0", "input": "问题"}]},
            [AGENT], ["correctness"], META_PRICED)
        self.assertFalse(est2["cost_is_partial"])

    def test_every_evaluator_is_a_judge_call(self):
        """两个评估器 = 每个用例两次 judge 调用（口径同 estimate_test_run 的
        n_judge_calls = 用例 × Agent × 评估器）。"""
        run = self._run(prices=SONNET, evaluators=("correctness", "helpfulness"),
                        n_cases=2)
        self.assertEqual(run["actual_cost_usd"], self._judge_only_cost(4))

    def test_unpriced_judge_leaves_a_trace_on_the_run(self):
        """按兜底费率算出来的成本必须自报出身，不能装成实测值。"""
        run = self._run(prices={}, judge_model="my-private-judge")
        self.assertTrue(run.get("unpriced_judge"),
                        "judge 无价却一声不响（成本数字来源不可辨）")

    def test_priced_judge_gains_no_trace(self):
        """回归：judge 有价的正常 run 不许多出这个字段。"""
        run = self._run(prices=SONNET)
        self.assertNotIn("unpriced_judge", run)

    # ---- 不变量 1 的要害：熔断真的会触发 ----

    def test_cost_circuit_trips_with_an_unpriced_judge(self):
        """本缺陷的要害：judge 无价 + 超预算 → 熔断真的触发。
        预算 = 预估 × 3 = $0.003，4 个用例的 judge 费用远超它。
        （修复前：actual 恒 0 ⇒ `actual > budget` 永不为真 ⇒ 一路跑到底）"""
        run = self._run(prices={}, judge_model="my-private-judge", n_cases=4,
                        estimate_usd=0.001)
        self.assertEqual(run["status"], "halted_cost",
                         "熔断没触发：无价 judge 把熔断计数器锁在 0")
        self.assertIn("熔断", run["error"])
        self.assertLess(run["completed_cases"], run["total_cases"],
                        "熔断了却把全部用例跑完（钱照烧）")
        self.assertLess(len(self.invoked), 4,
                        "熔断之后还继续真调了被测 Agent")

    def test_cost_circuit_stays_quiet_within_budget(self):
        """回归：预算充足的 run 不许被新记账口误伤成熔断。"""
        run = self._run(prices=SONNET, n_cases=4, estimate_usd=1.0)
        self.assertEqual(run["status"], "completed")
        self.assertEqual(len(self.invoked), 4)

    # ---- 不变量 2：缓存命中的被测侧豁免不许被兜底伤到 ----

    def test_cache_hits_stay_exempt_from_target_side_cost(self):
        """缓存命中没有调用被测 Agent —— 被测侧一分钱不许计（既有正确行为），
        新增的 judge 记账不许把它算回来。"""
        cached = self._run(prices=SONNET, meta=META_PRICED, n_cases=2,
                           cache_hit="缓存里的回答")
        self.assertEqual(len(self.invoked), 0, "缓存命中却真调了被测 Agent")
        self.assertEqual(cached["actual_cost_usd"], self._judge_only_cost(2),
                         "缓存命中把被测 Agent 侧的费用也算进来了")
        fresh = self._run(prices=SONNET, meta=META_PRICED, n_cases=2,
                          run_id="run-20260824180001")
        self.assertGreater(fresh["actual_cost_usd"], cached["actual_cost_usd"],
                           "真调用与缓存命中花的钱一样多 —— 豁免没了")

    def test_cache_hit_with_an_unpriced_target_is_not_traced(self):
        """缓存命中不计费是刻意豁免，不是「无价」—— 不许进 unpriced_agents。"""
        run = self._run(prices={}, meta=META_NO_MODEL, cache_hit="缓存里的回答")
        self.assertNotIn("unpriced_agents", run)

    def test_cache_hits_still_pay_the_judge(self):
        """命中省的是被测调用，重新判分是真 judge 调用（reuse 模式的全部用途）。"""
        run = self._run(prices=SONNET, meta=META_PRICED, cache_hit="缓存里的回答")
        self.assertGreater(run["actual_cost_usd"], 0.0,
                           "缓存命中的重新判分被算成 0 —— reuse 模式下熔断又死了")

    # ---- 不变量 3：被测模型无价留痕但不伪造 ----

    def test_unpriced_target_model_is_traced_not_faked(self):
        """被测 Agent 的模型价格天然不可知：预估侧按 0 计并列进 unpriced_agents，
        实际侧照同一口径（凭空加价会把正常运行判成超支），但必须留痕 —— 口径同
        metrics.py 的 unpriced_models。"""
        run = self._run(prices={}, meta=META_NO_MODEL)
        self.assertEqual(run.get("unpriced_agents"), [AGENT])
        self.assertEqual(run["actual_cost_usd"], self._judge_only_cost(2),
                         "给无价的被测模型伪造了费率")

    def test_priced_target_model_gains_no_trace(self):
        """回归：被测模型有价的正常 run 不许多出这个字段。"""
        run = self._run(prices=SONNET, meta=META_PRICED)
        self.assertNotIn("unpriced_agents", run)

    # ---- 落库：留痕与成本随 checkpoint 出库 ----

    def test_cost_and_traces_survive_persistence(self):
        """记账与留痕要能被读回（方案页/报告抽屉读的就是出库后的 run）。"""
        run = self._run(prices={}, judge_model="my-private-judge")
        stored = self.testrun.get_test_run("run-20260824180000")
        self.assertEqual(stored["actual_cost_usd"], run["actual_cost_usd"])
        self.assertTrue(stored.get("unpriced_judge"))
        self.assertEqual(stored.get("unpriced_agents"), [AGENT])


# ---------------------------------------------------------------- 红队同族

class RedteamAccrual(unittest.TestCase):
    """红队侧记账（`_accrue_cost`）是同一族模式：judge 侧此前就有兜底，
    但兜底出身没有任何留痕；被测侧同样是 `if p:` 无 else。"""

    def setUp(self):
        import redteam
        self.redteam = redteam

    def _accrue(self, prices, agent_model, judge_model=JUDGE):
        with mock.patch.object(self.redteam.pricing, "get_prices",
                               return_value={"prices": prices, "last_sync": None}):
            return self.redteam._accrue_cost(4000, 4, agent_model, judge_model)

    def test_judge_side_is_billed_with_no_price_row(self):
        """价表全空时红队的 judge/攻击方费用照兜底费率计（既有行为，钉住）。"""
        self.assertGreater(self._accrue({}, ""), 0.0)

    def test_unpriced_judge_uses_the_shared_fallback_rate(self):
        """与 testrun 同一个兜底常量：两处各写一份字面量迟早漂移成两把尺子。"""
        import pricing
        rate = pricing.JUDGE_PRICE_FALLBACK
        expected = round(4 * (self.redteam.ATTACK_TOKENS_PER_TURN / 1000)
                         * (rate["input"] * 0.85 + rate["output"] * 0.15), 4)
        self.assertEqual(self._accrue({}, ""), expected)

    def test_target_side_is_billed_when_priced(self):
        """回归：被测模型有价时被测侧照旧计入（比无价时更贵）。"""
        self.assertGreater(self._accrue(SONNET, "anthropic.claude-sonnet-5"),
                           self._accrue(SONNET, ""))


if __name__ == "__main__":
    unittest.main()
