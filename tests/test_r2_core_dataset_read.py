"""「按名找一个数据集」= 一次 get_item，不是读全部数据集的全部 cases（E2）。

背景（simplify-r2 效率镜头 E2）
  `catalog.list_datasets()` 读整个 DATASET 分区并 json.loads 每个集合的**全部
  cases**（单集上限约 396KB，catalog.py 自述）。五个调用点却只要其中一条：
    main.py  extend_dataset（AI 追加）/ estimate|start_test_run
    planrun  estimate_plan_run 的 dataset 环节 / _redteam_cases / _run_dataset_stage
  每个方案的每个环节、每次回归启动与预估都要付一遍这个放大（它还是工作台逐方案
  预估那个乘法的内层）。修法：`catalog.get_dataset(name)` 单读，同形返回。

本文件钉两件事：形状与旧写法**逐字节同形**（含 kind 兜底/空缺省），以及五个调用点
再也不会退回全量读（list_datasets 打成「一调就炸」的桩）。

moto 提供真 DynamoDB。不触任何线上表/桶/Agent/LLM。
Run: python3 -m pytest tests/test_r2_core_dataset_read.py -q
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

import catalog  # noqa: E402
import planrun  # noqa: E402

TABLE = "eval-catalog-test"
REGION = "us-west-2"

CASE = {"name": "case-1", "input": "帮我改签", "expected_output": "已改签"}

NO_FULL_READ = mock.patch.object(
    catalog, "list_datasets",
    side_effect=AssertionError("按名找一个数据集不许读全部数据集的全部 cases"))


def ds_item(name: str, **extra) -> dict:
    item = {"pk": "DATASET", "sk": name,
            "cases": json.dumps([CASE], ensure_ascii=False),
            "updated_at": 1787000000}
    item.update(extra)
    return item


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
        self.reads = []
        for p in (mock.patch.object(catalog, "get_table", return_value=self.table),
                  mock.patch.object(catalog, "TABLE_NAME", TABLE)):
            p.start()
            self.addCleanup(p.stop)


class GetDatasetIsTheSameShape(Fixture):
    def test_identical_to_the_matching_list_element(self):
        """三种形态各比一次：普通回归集 / rt- 前缀推断 / 带元数据的红队集。"""
        self.table.put_item(Item=ds_item("orders-v1"))
        self.table.put_item(Item=ds_item("rt-jailbreak"))  # kind 靠命名前缀兜底
        self.table.put_item(Item=ds_item(
            "rt-policy", kind="redteam", target_agent="support-bot",
            risk_categories=json.dumps(["violence"]),
            source_keys=json.dumps(["sources/a.pdf"])))
        listed = {d["name"]: d for d in catalog.list_datasets()}
        for name, want in listed.items():
            self.assertEqual(catalog.get_dataset(name), want, name)

    def test_missing_updated_at_falls_back_to_zero_like_the_list(self):
        item = ds_item("legacy")
        del item["updated_at"]
        self.table.put_item(Item=item)
        self.assertEqual(catalog.get_dataset("legacy")["updated_at"], 0)

    def test_cases_come_back_whole(self):
        self.table.put_item(Item=ds_item("orders-v1"))
        got = catalog.get_dataset("orders-v1")
        self.assertEqual(got["cases"], [CASE])
        self.assertEqual(got["case_count"], 1)


class GetDatasetMisses(Fixture):
    def test_unknown_name_is_none_not_an_exception(self):
        """旧写法是 `next(..., None)` —— 找不到返回 None，调用侧据此出中文文案。"""
        self.assertIsNone(catalog.get_dataset("ghost"))

    def test_empty_name_is_none_without_any_request(self):
        """空名字是**正常**分支（红队环节没配用例集），而 DynamoDB 的键属性不接受
        空串（ValidationException）—— 必须在发请求之前短路。"""
        with mock.patch.object(catalog, "get_table",
                               side_effect=AssertionError("空名字不许发请求")):
            self.assertIsNone(catalog.get_dataset(""))
            self.assertIsNone(catalog.get_dataset("   "))
            self.assertIsNone(catalog.get_dataset(None))

    def test_no_table_configured_is_none(self):
        with mock.patch.object(catalog, "TABLE_NAME", ""):
            self.assertIsNone(catalog.get_dataset("orders-v1"))


class PlanrunCallSites(Fixture):
    def test_redteam_stage_cases_by_name(self):
        self.table.put_item(Item=ds_item("rt-jailbreak"))
        with NO_FULL_READ:
            self.assertEqual(
                planrun._redteam_cases({"cases_dataset": "rt-jailbreak"}), [CASE])

    def test_redteam_stage_without_a_case_set_is_empty(self):
        with NO_FULL_READ:
            self.assertEqual(planrun._redteam_cases({}), [])

    def test_embedded_cases_still_short_circuit(self):
        with NO_FULL_READ:
            self.assertEqual(planrun._redteam_cases({"cases": [CASE]}), [CASE])

    def test_estimate_says_the_dataset_is_gone_verbatim(self):
        plan = {"plan_id": "p1", "name": "n", "agent_name": "support-bot",
                "stages": [{"type": "dataset", "dataset": "deleted-set",
                            "evaluators": ["correctness"]}]}
        # 价目表也住 catalog 那张表（R4 起 pricing 直接复用它）：置空 = 只用内置价目
        with NO_FULL_READ, mock.patch.object(catalog, "TABLE_NAME", ""):
            est = planrun.estimate_plan_run(plan, {"runtime_arn": "arn:aws:x"})
        self.assertEqual(est["stages"][0]["error"], "数据集 'deleted-set' 不存在")
        self.assertEqual(est["stages"][0]["estimated_cost_usd"], 0.0)

    def test_dataset_stage_run_says_the_dataset_is_gone_verbatim(self):
        async def emit(_ev):
            pass

        with NO_FULL_READ:
            res = asyncio.run(planrun._run_dataset_stage(
                {"type": "dataset", "dataset": "deleted-set",
                 "evaluators": ["correctness"]},
                {"plan_id": "p1", "name": "n", "agent_name": "support-bot"},
                {"runtime_arn": "arn:aws:x"}, "judge-model", emit))
        self.assertEqual(res, {"type": "dataset", "status": "error",
                               "error": "数据集 'deleted-set' 不存在"})


class MainCallSites(Fixture):
    """两个 action 的「找不到」文案逐字不变（前端按它显示）。"""

    def _drain(self, payload) -> list[dict]:
        import main

        async def go():
            return [ev async for ev in main.invoke(payload)]

        return asyncio.run(go())

    def test_test_run_dataset_not_found(self):
        with NO_FULL_READ:
            events = self._drain({"action": "estimate_test_run", "dataset": "ghost"})
        self.assertEqual(events, [{"event": "error",
                                   "error": "dataset 'ghost' not found"}])

    def test_extend_dataset_not_found(self):
        with NO_FULL_READ:
            events = self._drain({"action": "generate_dataset",
                                  "extend_dataset": "ghost"})
        self.assertEqual(events, [{"event": "error",
                                   "error": "dataset 'ghost' not found"}])


class TheOldPatternIsGone(unittest.TestCase):
    def test_no_find_one_by_scanning_all_datasets(self):
        """这个惯用法很容易被下一个人抄回来 —— 调用侧一处都不许留。

        判据是 `next((d for d in catalog.list_datasets()`（「按名找一个」），不是
        list_datasets 本身：plan.validate_plan 要的是**全部名字**的集合，那是这个
        函数的正当用法。"""
        app = Path(__file__).resolve().parent.parent / "app"
        offenders = [p.name for p in sorted(app.glob("*.py"))
                     if "next((d for d in catalog.list_datasets()" in p.read_text()]
        self.assertEqual(offenders, [], f"仍在扫全部数据集找一个：{offenders}")


if __name__ == "__main__":
    unittest.main()
