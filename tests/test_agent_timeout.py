"""被测 Agent 调用的读超时墙与超时话术（P1，2026-08-31）。

现网实锤：bi-metrics 方案两轮里 bi-metrics-06/10 每轮必挂，
error=`Read timeout on endpoint URL: "None"`、duration_s=66.5/67.0 —— 正是
botocore 默认 read_timeout=60s 的签名。根因是 `testrun._agent_client()` 建的是
裸 `boto3.client("bedrock-agentcore")`，而仓内其它调 LLM/Agent 的 client 都各配
了墙（judgellm 900s / probe 45s）。

本文件钉两件事：
  1. client 的 config 三键现值（read_timeout=300 / connect_timeout=10 /
     retries total_max_attempts=1）——读的是**真 client 的 meta.config**，防将来
     回退成裸 client（裸 client 三个断言全红，不是只掉一根）。retries 单独有钉：
     对被测 Agent 的重试 = 重跑用例 = 双倍费用 + 同一 runtimeSessionId 复用出
     脏会话，boto legacy 默认会对部分错误自动重试。
  2. ReadTimeoutError 的行级话术：用户读到的不再是裸英文异常串，而是「墙多高 +
     按什么口径计 + 原始异常附后」；**判定口径不变** —— 仍是调用失败档
     （无 results、不进判分），通用异常分支的原样 str(e) 也不许被顺手改掉。

moto 的真 DynamoDB；被测 Agent / judge 全部打桩，不发起任何真调用。
运行：python3 -m pytest tests/test_agent_timeout.py -q
"""

import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from botocore.exceptions import ReadTimeoutError
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

os.environ.pop("ARTIFACTS_BUCKET", None)

import catalog  # noqa: E402
import testrun  # noqa: E402

TABLE = "eval-catalog-test"
REGION = "us-west-2"
AGENT = "support-bot"
META = {AGENT: {"runtime_arn": "arn:aws:bedrock-agentcore:us-west-2:1:runtime/x",
                "model": "anthropic.claude-sonnet-5"}}


class AgentClientConfigPinsItsTimeouts(unittest.TestCase):
    """三键现值钉在真 client 的 meta.config 上（不是钉调用 kwargs）：
    「config= 被整个删掉」与「值被改」都会红。"""

    def setUp(self):
        testrun._agent_client_cached = None
        self.addCleanup(lambda: setattr(testrun, "_agent_client_cached", None))

    def test_read_timeout_is_300_not_the_60s_default(self):
        cfg = testrun._agent_client().meta.config
        self.assertEqual(cfg.read_timeout, 300,
                         "读超时回退了：60s 默认值会杀死 66s+ 的合法慢用例"
                         "（现网 bi-metrics-06/10）")

    def test_connect_timeout_is_10(self):
        self.assertEqual(testrun._agent_client().meta.config.connect_timeout, 10)

    def test_exactly_one_total_attempt_no_auto_retry(self):
        """对被测 Agent 的重试 = 重跑用例 = 双倍费用 + 脏会话。
        注意键名是 total_max_attempts（含首发的总次数，两种 retry mode 语义一致）。"""
        retries = testrun._agent_client().meta.config.retries or {}
        self.assertEqual(retries.get("total_max_attempts"), 1)

    def test_the_wall_constant_and_the_config_are_the_same_number(self):
        """话术里的「300s」由 AGENT_READ_TIMEOUT_S 生成 —— 常量与 config 必须
        同一个数，否则错误信息报的墙高是假的。"""
        self.assertEqual(testrun.AGENT_READ_TIMEOUT_S,
                         testrun._agent_client().meta.config.read_timeout)


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
        for p in (mock.patch.object(catalog, "get_table", return_value=self.table),
                  mock.patch.object(catalog, "TABLE_NAME", TABLE),
                  mock.patch.object(catalog, "get_agent_config", return_value={}),
                  mock.patch.object(testrun, "_table", return_value=self.table),
                  mock.patch.object(testrun.pricing, "get_prices",
                                    return_value={"prices": {}}),
                  mock.patch.object(testrun, "_generate_run_analysis",
                                    mock.AsyncMock(return_value="解析"))):
            p.start()
            self.addCleanup(p.stop)

    def _run(self, invoke):
        dataset = {"name": "bi-metrics", "cases": [{"name": "bi-metrics-06",
                                                    "input": "跨月对比指标"}]}
        with mock.patch.object(testrun, "invoke_agent", invoke):
            return asyncio.run(testrun.execute_test_run(
                "run-20260831050000", dataset, [AGENT], [], "judge-model", {},
                META, {"estimated_cost_usd": 1.0}))


class TimeoutRowSpeaksHuman(DdbFixture):
    """超时用例的行级 error：话术可读，口径不变。"""

    def _timeout_run(self):
        def invoke(arn, cfg, case_input, sid):
            raise ReadTimeoutError(endpoint_url="None")
        return self._run(invoke)

    def test_error_names_the_wall_and_the_accounting(self):
        row = self._timeout_run()["results"][0]
        self.assertIn("调用被测 Agent 超时（300s 内未完成）", row["error"])
        self.assertIn("不计入本环节均分与通过率", row["error"])  # 限定词随源文案（评审修正：与空响应话术同刑）

    def test_original_exception_string_rides_along(self):
        """排查还得靠原始串（它是「60s 默认值签名」这类诊断的原材料）。"""
        row = self._timeout_run()["results"][0]
        self.assertIn('Read timeout on endpoint URL: "None"', row["error"])

    def test_still_the_invocation_failure_tier(self):
        """不改判定口径：无 results（从没进判分）、不是 blank/eval_skipped 档，
        run 照常收敛为 completed。"""
        run = self._timeout_run()
        row = run["results"][0]
        self.assertNotIn("results", row)
        self.assertNotIn("eval_skipped", row)
        self.assertNotIn("blank_output", row)
        self.assertEqual(run["status"], "completed")

    def test_generic_errors_keep_their_raw_str(self):
        """通用异常分支一字不动：只有 ReadTimeoutError 换话术。"""
        def invoke(arn, cfg, case_input, sid):
            raise RuntimeError("目标端炸了")
        row = self._run(invoke)["results"][0]
        self.assertEqual(row["error"], "目标端炸了")
        self.assertNotIn("超时", row["error"])


if __name__ == "__main__":
    unittest.main()
