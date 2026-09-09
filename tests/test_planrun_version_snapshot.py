"""护栏 1（快照冻结）：run 落库时把「当时的版本标签 + runtime ARN」冻进 run 记录。

事后改版本标签**不影响历史 run 的归属** —— 趋势竖线与（后续的）对比视图读 run
快照，不读 Agent 当前值。旧数据不修：快照字段只在新 run 上出现，老 run 缺字段 →
读出 None，展示侧降级（不显示版本 chip），绝不回填。

唯一写点 = `planrun._planrun_item`（J4 收敛后的 PLANRUN 骨架构造函数，四个写入点
共用它）。本文件同时钉住：
  · 取值来源 = 开跑时该 agent 的元数据（AGENTMETA）与 discovery 的 runtime ARN；
  · 同一个 run_key 的**第二次**覆盖写（终态 _persist）仍用开跑那一刻的值 ——
    run 跑了十分钟，中途改标签不许把这次 run 的归属挪到新版本上；
  · 读不到（没配表 / agent 不在册 / 没标注过）→ **不写这个字段**，而不是写空串：
    「没有」要能与「标注为空」区分，且 _planrun_item 的骨架字段集不许被撑大
    （tests/test_r2_core_planrun_item.py 逐处锁死四个写入点的字段集）；
  · list_recent_runs 的投影带上这两个字段 —— 漏投影会让这个常驻轮询 feed 里
    版本恒为空（planrun.py 那份投影清单的注释自述：加字段要同步）。

moto 提供真 DynamoDB；不触任何线上表/桶/Agent/LLM。
Run: python3 -m pytest tests/test_planrun_version_snapshot.py -q
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
import planrun  # noqa: E402

TABLE = "eval-catalog-test"
REGION = "us-west-2"

AGENT_NAME = "support-bot"
ARN = "arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/support-bot-abc123"
ARN_V2 = "arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/support-bot-def456"

PLAN = {"plan_id": "plan-1297bb07bc31", "name": "线上评估周巡检",
        "agent_name": AGENT_NAME,
        "stages": [{"type": "observe", "evaluators": ["helpfulness"], "metrics": []}]}

DISCOVERED = {"agent_name": AGENT_NAME, "runtime_arn": ARN, "has_logs": True,
              "log_group": "/aws/bedrock-agentcore/runtimes/support-bot-abc123-DEFAULT"}


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
                  mock.patch.object(catalog, "TABLE_NAME", TABLE),
                  mock.patch.object(planrun, "_table", return_value=self.table)):
            p.start()
            self.addCleanup(p.stop)
        # 每个用例一张干净的冻结缓存（同一进程里跑多个 run 不许互相串味）
        planrun._SNAPSHOT_CACHE.clear()
        self.addCleanup(planrun._SNAPSHOT_CACHE.clear)

    def put_agent(self, runtime_arn: str = ARN) -> None:
        agent = {**DISCOVERED, "runtime_arn": runtime_arn}
        self.table.put_item(Item={"pk": "AGENT", "sk": AGENT_NAME,
                                  "data": json.dumps(agent, ensure_ascii=False),
                                  "refreshed_at": 1787000000})

    def item(self, run_key: str) -> dict:
        return self.table.get_item(Key={"pk": "PLANRUN", "sk": run_key})["Item"]


class TheSnapshotIsWritten(Fixture):
    def test_label_and_arn_land_on_the_run_item(self):
        self.put_agent()
        catalog.set_agent_meta(AGENT_NAME, version_label="v1.2")
        item = planrun._planrun_item(PLAN, "k#1", "running", "manual", "t")
        self.assertEqual(item["agent_version_label"], "v1.2")
        self.assertEqual(item["agent_runtime_arn"], ARN)

    def test_read_path_brings_it_back(self):
        self.put_agent()
        catalog.set_agent_meta(AGENT_NAME, version_label="v1.2")
        run_key = planrun.record_skipped_run(PLAN, "无新增线上会话")
        run = planrun.list_plan_runs(PLAN["plan_id"])[0]
        self.assertEqual(run["run_key"], run_key)
        self.assertEqual(run["agent_version_label"], "v1.2")
        self.assertEqual(run["agent_runtime_arn"], ARN)

    def test_recent_runs_projection_carries_it(self):
        """常驻轮询 feed 走 ProjectionExpression —— 漏投影这里就恒为 None。"""
        self.put_agent()
        catalog.set_agent_meta(AGENT_NAME, version_label="v1.2")
        planrun.record_skipped_run(PLAN, "无新增线上会话")
        feed = planrun.list_recent_runs(agent_name=AGENT_NAME)
        self.assertEqual(feed[0]["agent_version_label"], "v1.2")
        self.assertEqual(feed[0]["agent_runtime_arn"], ARN)

    def test_arn_alone_is_enough(self):
        """还没标注过版本，但 runtime ARN 一直有 —— ARN 照样冻结（对比视图要用）。"""
        self.put_agent()
        item = planrun._planrun_item(PLAN, "k#1", "running", "manual", "t")
        self.assertEqual(item["agent_runtime_arn"], ARN)
        self.assertNotIn("agent_version_label", item)


class TheSnapshotIsFrozen(Fixture):
    def test_editing_the_label_does_not_touch_history(self):
        """护栏 1 的正身：落 run 后改 Agent 版本标签 → 历史 run 的快照不变。"""
        self.put_agent()
        catalog.set_agent_meta(AGENT_NAME, version_label="v1.2")
        run_key = planrun.record_skipped_run(PLAN, "无新增线上会话")
        catalog.set_agent_meta(AGENT_NAME, version_label="v9.9")
        self.assertEqual(self.item(run_key)["agent_version_label"], "v1.2")
        self.assertEqual(
            planrun.list_plan_runs(PLAN["plan_id"])[0]["agent_version_label"], "v1.2")

    def test_a_mid_run_edit_does_not_move_this_run_to_the_new_version(self):
        """同一个 run_key 的两次覆盖写（开跑 marker → 终态 _persist）用**同一个**
        快照：run 跑了十分钟，中途改标签不许把这次 run 挪到新版本上。"""
        self.put_agent()
        catalog.set_agent_meta(AGENT_NAME, version_label="v1.2")
        marker = planrun._planrun_item(PLAN, "k#1", "running", "manual", "t")
        catalog.set_agent_meta(AGENT_NAME, version_label="v9.9")
        terminal = planrun._planrun_item(PLAN, "k#1", "completed", "manual", "t",
                                        score="0.83")
        self.assertEqual(marker["agent_version_label"], "v1.2")
        self.assertEqual(terminal["agent_version_label"], "v1.2")

    def test_the_next_run_picks_up_the_new_label(self):
        """冻结是**按 run** 的，不是进程级缓存：下一次 run 必须读到新标签。"""
        self.put_agent()
        catalog.set_agent_meta(AGENT_NAME, version_label="v1.2")
        planrun._planrun_item(PLAN, "k#1", "running", "manual", "t")
        catalog.set_agent_meta(AGENT_NAME, version_label="v9.9")
        self.put_agent(ARN_V2)
        nxt = planrun._planrun_item(PLAN, "k#2", "running", "manual", "t")
        self.assertEqual(nxt["agent_version_label"], "v9.9")
        self.assertEqual(nxt["agent_runtime_arn"], ARN_V2)


class OldRunsAreNotBackfilled(Fixture):
    def test_missing_fields_read_as_none(self):
        """老 run（本功能之前落库）没有这两个字段 → None，展示侧不画 chip。"""
        self.table.put_item(Item={
            "pk": "PLANRUN", "sk": "plan-old#20260801030000",
            "plan_id": "plan-old", "plan_name": "老方案", "agent_name": AGENT_NAME,
            "status": "completed", "triggered_by": "schedule",
            "started_at": "2026-08-01 03:00 UTC", "score": "0.74",
            "stage_summaries": "[]", "overview": "{}", "s3_key": "", "proposals": "[]"})
        run = planrun.list_plan_runs("plan-old")[0]
        self.assertIsNone(run["agent_version_label"])
        self.assertIsNone(run["agent_runtime_arn"])

    def test_unknown_agent_writes_no_snapshot_keys(self):
        """agent 不在 discovery 缓存里（刚删掉 / 从未扫描）→ 一个字段都不写。
        绝不写空串：那会让「没有快照」与「标注为空」分不开，也会撑大
        _planrun_item 的骨架字段集（test_r2_core_planrun_item 逐处锁死）。"""
        item = planrun._planrun_item(PLAN, "k#1", "running", "manual", "t")
        self.assertNotIn("agent_version_label", item)
        self.assertNotIn("agent_runtime_arn", item)

    def test_a_broken_catalog_read_never_breaks_the_run_record(self):
        """记账不许拖垮 run：元数据读失败就当没有快照，run 记录照旧落库。"""
        with mock.patch.object(catalog, "get_cached_agent",
                               side_effect=RuntimeError("DDB 抖了")):
            item = planrun._planrun_item(PLAN, "k#1", "running", "manual", "t")
        self.assertNotIn("agent_version_label", item)
        self.assertEqual(item["status"], "running")


if __name__ == "__main__":
    unittest.main()
