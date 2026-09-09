"""Agent 显示元数据（显示名 + 版本标签）的存取与两道护栏。

功能（用户拍板的设计，档 .scratch/triage-r1/issues/agent-version-labels.md）：
Agent = 显示名 + 版本标签 + runtime。显示名默认 = AgentCore discovery 的名字，
版本标签由用户在界面上填（**人工标签替代自动指纹**）—— 同一个 agent 改进后换了
runtime 再评一次，趋势里要分得出是哪一版。

本文件钉的是后端那两条不可让的性质：

  护栏 2（关联键不动）—— 界面改的是**显示名**，存在自己的 AGENTMETA 行；
    `agent_name` 是关联键（方案绑定 / run 归属 / evaltest 会话前缀），改显示名
    绝不能碰它。直接改键会让历史数据全部失联，所以这里按名查方案 / 查 run /
    查调用配置各钉一遍「改名后照常命中」。

  元数据与 discovery 分居 —— refresh_agents 是**replace-all**（删除不在册的
    AGENT 行再重写），元数据混进 AGENT 行就会被一次重新扫描抹掉。故 AGENTMETA
    独立 pk，且 overlay 只发生在**返回时**（存的 AGENT blob 保持纯 discovery 数据）。

moto 提供真 DynamoDB；不触任何线上表/桶/Agent/LLM。
Run: python3 -m pytest tests/test_catalog_agent_meta.py -q
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import catalog  # noqa: E402
import plan as plan_mod  # noqa: E402
import planrun  # noqa: E402

TABLE = "eval-catalog-test"
REGION = "us-west-2"

AGENT_NAME = "support-bot"
ARN = "arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/support-bot-abc123"

DISCOVERED = {"agent_name": AGENT_NAME, "runtime_id": "support-bot-abc123",
              "runtime_arn": ARN, "description": "客服问答", "status": "READY",
              "last_updated": "2026-08-10 08:00:00+00:00",
              "log_group": "/aws/bedrock-agentcore/runtimes/support-bot-abc123-DEFAULT",
              "has_logs": True}


class Fixture(unittest.TestCase):
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
                  mock.patch.object(catalog, "TABLE_NAME", TABLE)):
            p.start()
            self.addCleanup(p.stop)

    def put_agent(self, agent: dict | None = None) -> None:
        """一条 discovery 缓存行（refresh_agents 的写入形态）。"""
        a = agent or DISCOVERED
        self.table.put_item(Item={"pk": "AGENT", "sk": a["agent_name"],
                                  "data": json.dumps(a, ensure_ascii=False),
                                  "refreshed_at": 1787000000})


class ReadWrite(Fixture):
    def test_unmarked_agent_reads_empty_not_missing(self):
        """从未标注过 → 两个字段空串 + updated_at None（**不是 KeyError**）。"""
        meta = catalog.get_agent_meta(AGENT_NAME)
        self.assertEqual(meta["display_name"], "")
        self.assertEqual(meta["version_label"], "")
        self.assertIsNone(meta["updated_at"])

    def test_set_then_read_back_both_fields(self):
        catalog.set_agent_meta(AGENT_NAME, display_name="客服机器人",
                               version_label="v1.2")
        meta = catalog.get_agent_meta(AGENT_NAME)
        self.assertEqual(meta["display_name"], "客服机器人")
        self.assertEqual(meta["version_label"], "v1.2")
        self.assertIsInstance(meta["updated_at"], int)

    def test_omitted_field_keeps_its_previous_value(self):
        """只改版本标签不该把显示名抹掉（整条 put_item 的经典踩点）。"""
        catalog.set_agent_meta(AGENT_NAME, display_name="客服机器人",
                               version_label="v1.2")
        catalog.set_agent_meta(AGENT_NAME, version_label="v1.3")
        meta = catalog.get_agent_meta(AGENT_NAME)
        self.assertEqual(meta["display_name"], "客服机器人")
        self.assertEqual(meta["version_label"], "v1.3")

    def test_empty_string_clears_the_label(self):
        """空串 = 清除标注（回落到 discovery 原名 / 无版本 chip）——
        与「没传这个字段」是两件事。"""
        catalog.set_agent_meta(AGENT_NAME, display_name="客服机器人")
        catalog.set_agent_meta(AGENT_NAME, display_name="")
        self.assertEqual(catalog.get_agent_meta(AGENT_NAME)["display_name"], "")

    def test_whitespace_is_stripped(self):
        catalog.set_agent_meta(AGENT_NAME, version_label="  v2.0  ")
        self.assertEqual(catalog.get_agent_meta(AGENT_NAME)["version_label"], "v2.0")

    def test_no_agent_name_is_rejected(self):
        with self.assertRaises(ValueError):
            catalog.set_agent_meta("  ", display_name="x")

    def test_nothing_to_write_is_rejected(self):
        """两个字段都没传 = 调用方在瞎写；静默写一条空 item 更糟。"""
        with self.assertRaises(ValueError):
            catalog.set_agent_meta(AGENT_NAME)

    def test_labels_are_length_capped(self):
        catalog.set_agent_meta(AGENT_NAME, display_name="名" * 500,
                               version_label="v" * 500)
        meta = catalog.get_agent_meta(AGENT_NAME)
        self.assertLessEqual(len(meta["display_name"]), catalog.AGENT_META_MAX_LEN)
        self.assertLessEqual(len(meta["version_label"]), catalog.AGENT_META_MAX_LEN)


class DiscoveryOverlay(Fixture):
    def test_cached_agents_carries_the_two_fields(self):
        self.put_agent()
        catalog.set_agent_meta(AGENT_NAME, display_name="客服机器人",
                               version_label="v1.2")
        agent = catalog.cached_agents()["agents"][0]
        self.assertEqual(agent["display_name"], "客服机器人")
        self.assertEqual(agent["version_label"], "v1.2")

    def test_unmarked_agent_still_has_the_keys(self):
        """前端契约稳定：没标注过也带这两个键（空串），不用判 undefined。"""
        self.put_agent()
        agent = catalog.cached_agents()["agents"][0]
        self.assertEqual(agent["display_name"], "")
        self.assertEqual(agent["version_label"], "")

    def test_overlay_never_touches_the_join_key(self):
        """护栏 2：显示名叠加在旁边，agent_name 原样（关联键）。"""
        self.put_agent()
        catalog.set_agent_meta(AGENT_NAME, display_name="完全不同的名字")
        agent = catalog.cached_agents()["agents"][0]
        self.assertEqual(agent["agent_name"], AGENT_NAME)
        self.assertEqual(agent["runtime_arn"], ARN)

    def test_stored_agent_row_stays_pure_discovery_data(self):
        """AGENT 行里的 data blob 不许被写进显示名 —— 那是 discovery 的原物，
        混进元数据后一次 refresh_agents 就会把两者一起覆盖。"""
        self.put_agent()
        catalog.set_agent_meta(AGENT_NAME, display_name="客服机器人")
        item = self.table.get_item(Key={"pk": "AGENT", "sk": AGENT_NAME})["Item"]
        self.assertNotIn("display_name", json.loads(item["data"]))

    def test_refresh_agents_replace_all_does_not_wipe_labels(self):
        """refresh_agents 删光再重写 AGENT 分区；元数据必须活下来。"""
        catalog.set_agent_meta(AGENT_NAME, display_name="客服机器人",
                               version_label="v1.2")
        with mock.patch.object(catalog, "list_agents", return_value=[dict(DISCOVERED)]):
            result = catalog.refresh_agents()
        self.assertEqual(result["agents"][0]["version_label"], "v1.2")
        self.assertEqual(catalog.get_agent_meta(AGENT_NAME)["display_name"], "客服机器人")

    def test_runtime_version_from_discovery_is_the_default_label(self):
        """「版本默认 = runtime version，读得到就填」：discovery 行带
        runtime_version 时它就是缺省标签；用户标注过则以标注为准。"""
        self.put_agent({**DISCOVERED, "runtime_version": "7"})
        self.assertEqual(catalog.cached_agents()["agents"][0]["version_label"], "7")
        catalog.set_agent_meta(AGENT_NAME, version_label="v1.2")
        self.assertEqual(catalog.cached_agents()["agents"][0]["version_label"], "v1.2")

    def test_get_cached_agent_is_the_same_shape_as_the_list_element(self):
        self.put_agent()
        catalog.set_agent_meta(AGENT_NAME, display_name="客服机器人",
                               version_label="v1.2")
        listed = catalog.cached_agents()["agents"][0]
        self.assertEqual(catalog.get_cached_agent(AGENT_NAME), listed)

    def test_get_cached_agent_unknown_name_is_none(self):
        self.assertIsNone(catalog.get_cached_agent("ghost"))


class JoinKeyUntouched(Fixture):
    """护栏 2 的实测：改显示名后，按 agent_name 查方案 / run / 调用配置全部照常命中。"""

    def setUp(self):
        super().setUp()
        for p in (mock.patch.object(plan_mod, "_table", return_value=self.table),
                  mock.patch.object(planrun, "_table", return_value=self.table)):
            p.start()
            self.addCleanup(p.stop)
        self.put_agent()
        plan_mod.save_plan(
            {"name": "FAQ 周回归", "agent_name": AGENT_NAME,
             "stages": [{"type": "observe", "evaluators": ["helpfulness"]}]},
            DISCOVERED)
        catalog.set_agent_config(AGENT_NAME, '{"prompt": "{input}"}')
        planrun.record_skipped_run(
            {"plan_id": "plan-x", "name": "FAQ 周回归", "agent_name": AGENT_NAME},
            "无新增线上会话")

    def test_plans_runs_and_config_still_match_after_a_rename(self):
        catalog.set_agent_meta(AGENT_NAME, display_name="完全不同的名字")
        self.assertEqual(len(plan_mod.list_plans(AGENT_NAME)), 1)
        self.assertEqual(len(planrun.list_recent_runs(agent_name=AGENT_NAME)), 1)
        self.assertEqual(
            catalog.get_agent_config(AGENT_NAME)["payload_template"],
            '{"prompt": "{input}"}')

    def test_the_display_name_is_not_a_lookup_key(self):
        """按显示名查 = 查不到（它不是键）。这条钉的是「别把显示名当键用」。"""
        catalog.set_agent_meta(AGENT_NAME, display_name="完全不同的名字")
        self.assertEqual(plan_mod.list_plans("完全不同的名字"), [])


if __name__ == "__main__":
    unittest.main()
