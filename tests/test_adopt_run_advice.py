"""报告「本次建议」条目的采纳（ADR-0014 §6，adopt_run_advice）。

条目是前端从本次诊断根因自聚合的（strands SDK 没有可用的 recommend 包），
不预先落库；采纳时才以修法原文为 summary 追加一条**生成即已采纳**的 proposal。
本文件钉住的设计不变量：

  · **同一持久化形状**：写进的还是那个 `proposals` JSON 数组 —— 追加后
    set_proposal_adopted 能按同一下标操作它、_build_overview 的 adoption_note
    下次 run 零改动吃到它（闭环消费端不用知道两种来源）。
  · **additive**：既有条目（attach_proposal 三键）一个键不改、一条不动。
  · **幂等**：同一条修法重复采纳返回已有条目（同下标），不追加第二条。
  · 空修法 / run 不存在：ValueError 原话（main.py 转 {event:"error"}）。
  · refs 逐条截断 + 封顶条数（DDB 400KB item 的防线）。

moto 的真 DynamoDB；不碰真表 / 真 LLM。
运行：python3 -m pytest tests/test_adopt_run_advice.py -q
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

TABLE = "eval-catalog-test"
REGION = "us-west-2"
RUN_KEY = "plan-adv001#20260831090000"
FIX = "在系统提示词中加入：改签工具超时后先做一次带退避的重试，仍失败时给出改签工单入口。"
REFS = ["线上评估 · sess-a41f9c2b", "回归测试 · case-2"]


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
        import catalog
        import planrun
        self.planrun = planrun
        p = mock.patch.object(catalog, "get_table", return_value=self.table)
        p.start()
        self.addCleanup(p.stop)

    def seed_run(self, proposals: list | None = None, run_key: str = RUN_KEY):
        self.table.put_item(Item={
            "pk": "PLANRUN", "sk": run_key,
            "plan_id": run_key.split("#")[0], "status": "completed",
            "proposals": json.dumps(proposals or [], ensure_ascii=False),
        })
        return run_key

    def proposals(self, run_key: str = RUN_KEY) -> list:
        item = self.table.get_item(
            Key={"pk": "PLANRUN", "sk": run_key}).get("Item") or {}
        return json.loads(item.get("proposals") or "[]")

    def call(self, payload):
        import main

        async def go():
            return [ev async for ev in main.invoke(payload)]
        return asyncio.run(go())


class AdoptRunAdvice(Fixture):
    def test_appends_a_pre_adopted_proposal_entry(self):
        self.seed_run()
        index, entry = self.planrun.adopt_run_advice(RUN_KEY, FIX, REFS)
        self.assertEqual(index, 0)
        stored = self.proposals()
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0], entry)
        # 生成即已采纳（adopted_at 与 generated_at 同刻写入，不是 None）
        self.assertEqual(entry["summary"], FIX[:300])
        self.assertTrue(entry["adopted_at"])
        self.assertEqual(entry["adopted_at"], entry["generated_at"])
        self.assertEqual(entry["source"], "run_advice")
        self.assertEqual(entry["refs"], REFS)

    def test_existing_attach_proposal_entries_are_untouched(self):
        old = {"summary": "改写 rebook_flight 工具描述。",
               "generated_at": "2026-08-20 07:15 UTC", "adopted_at": None}
        self.seed_run(proposals=[old])
        index, _ = self.planrun.adopt_run_advice(RUN_KEY, FIX, [])
        self.assertEqual(index, 1)  # 只追加：下标接在既有条目之后
        stored = self.proposals()
        self.assertEqual(stored[0], old)  # additive：旧条目逐键原样

    def test_idempotent_same_fix_returns_existing_entry(self):
        self.seed_run()
        first, entry1 = self.planrun.adopt_run_advice(RUN_KEY, FIX, REFS)
        # strip 后全等（去重规则照 SDK recommendations 的 strip+全等）
        again, entry2 = self.planrun.adopt_run_advice(RUN_KEY, f"  {FIX}\n", REFS)
        self.assertEqual((first, entry1), (again, entry2))
        self.assertEqual(len(self.proposals()), 1)

    def test_same_summary_from_llm_proposal_does_not_collide(self):
        # 幂等判据是 source+summary 双键：LLM 改进稿（无 source）撞同名摘要
        # 不算「已采纳过的建议」——那是另一份东西
        self.seed_run(proposals=[{"summary": FIX[:300],
                                  "generated_at": "2026-08-20 07:15 UTC",
                                  "adopted_at": None}])
        index, _ = self.planrun.adopt_run_advice(RUN_KEY, FIX, [])
        self.assertEqual(index, 1)
        self.assertEqual(len(self.proposals()), 2)

    def test_blank_fix_and_missing_run_raise_valueerror(self):
        self.seed_run()
        with self.assertRaises(ValueError):
            self.planrun.adopt_run_advice(RUN_KEY, "   ", [])
        with self.assertRaises(ValueError):
            self.planrun.adopt_run_advice("nope#1", FIX, [])
        self.assertEqual(self.proposals(), [])  # 失败不落任何条目

    def test_refs_are_clipped_per_item_and_capped(self):
        self.seed_run()
        _, entry = self.planrun.adopt_run_advice(
            RUN_KEY, FIX, ["长" * 500] + [f"r{i}" for i in range(80)])
        self.assertEqual(len(entry["refs"]), 50)
        self.assertEqual(entry["refs"][0], "长" * 200)

    def test_set_proposal_adopted_can_address_the_new_entry_by_index(self):
        # 同一形状的硬证据：追加后既有的按下标操作原样可用（取消采纳走老口子）
        self.seed_run()
        index, _ = self.planrun.adopt_run_advice(RUN_KEY, FIX, [])
        p = self.planrun.set_proposal_adopted(RUN_KEY, index, False)
        self.assertIsNone(p["adopted_at"])

    def test_adoption_note_consumes_adopted_advice_next_run(self):
        # 闭环消费端零改动：_build_overview 对上一次 run 的已采纳条目按
        # adopted_at 过滤，不认识 source/refs 也照常吃到
        self.seed_run()
        self.planrun.adopt_run_advice(RUN_KEY, FIX, REFS)
        prev = self.table.get_item(Key={"pk": "PLANRUN", "sk": RUN_KEY})["Item"]
        prev = dict(prev)
        prev["proposals"] = json.loads(prev["proposals"])
        prev["stage_summaries"] = []
        overview = self.planrun._build_overview({}, [], prev)
        note = overview.get("adoption_note")
        self.assertIsNotNone(note)
        self.assertEqual(note["proposals"][0]["summary"], FIX[:300])


class ActionLayer(Fixture):
    def test_action_yields_advice_adopted_with_index_and_proposal(self):
        self.seed_run()
        events = self.call({"action": "adopt_run_advice", "run_key": RUN_KEY,
                            "fix": FIX, "refs": REFS})
        self.assertEqual(len(events), 1)
        ev = events[0]
        self.assertEqual(ev["event"], "advice_adopted")
        self.assertEqual(ev["run_key"], RUN_KEY)
        self.assertEqual(ev["index"], 0)
        self.assertEqual(ev["proposal"]["summary"], FIX[:300])
        self.assertTrue(ev["proposal"]["adopted_at"])

    def test_action_errors_speak_the_valueerror_text(self):
        self.seed_run()
        blank = self.call({"action": "adopt_run_advice", "run_key": RUN_KEY,
                           "fix": ""})
        self.assertEqual(blank[0]["event"], "error")
        self.assertIn("修法文本", blank[0]["error"])
        missing = self.call({"action": "adopt_run_advice", "run_key": "nope#1",
                             "fix": FIX})
        self.assertEqual(missing[0]["event"], "error")
        self.assertIn("不存在", missing[0]["error"])


if __name__ == "__main__":
    unittest.main()
