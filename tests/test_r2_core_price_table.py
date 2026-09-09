"""价目表复用 catalog 的表与句柄，不再自己养一套（R4）。

`pricing.py` 此前有 REGION / TABLE_NAME / _get_table 三件与 `catalog.py` **逐字
同形**的拷贝：同一个 env（AWS_REGION / CATALOG_TABLE）读两遍、同一张表
（价目行就是 pk="PRICE"）建两个句柄。换表名、加缓存策略、改区域来源都得记住两处，
而 evalcache 早就是「直接用 catalog」的先例。

行为保持的依据：同 env 同默认值（us-west-2）、同表、同 pk —— 读写的字节完全一样，
只是句柄少了一个。本文件用 moto 真表验读写往返，并钉住「三件套确实没了」。

Run: python3 -m pytest tests/test_r2_core_price_table.py -q
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

APP = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(APP))

import catalog  # noqa: E402
import discovery  # noqa: E402
import pricing  # noqa: E402

TABLE = "eval-catalog-test"
REGION = "us-west-2"


class TheThreeCopiesAreGone(unittest.TestCase):
    def test_no_private_table_handle_of_its_own(self):
        self.assertFalse(hasattr(pricing, "_get_table"))
        self.assertNotIn("_table", vars(pricing))

    def test_table_name_comes_from_catalog(self):
        self.assertNotIn("TABLE_NAME", vars(pricing))
        with mock.patch.object(catalog, "TABLE_NAME", "somewhere-else"):
            self.assertEqual(catalog.TABLE_NAME, "somewhere-else")  # 唯一住址

    def test_region_is_imported_not_redefined(self):
        """REGION 仍是本模块属性（Pricing API 的 regionCode 过滤要它），
        但住址是 discovery —— 与 catalog / testrun / runstore 同一个。"""
        self.assertEqual(pricing.REGION, discovery.REGION)
        src = (APP / "pricing.py").read_text()
        self.assertNotIn('REGION = os.environ', src)
        self.assertIn("from discovery import REGION", src)

    def test_it_no_longer_builds_a_dynamodb_resource(self):
        self.assertNotIn('boto3.resource("dynamodb"', (APP / "pricing.py").read_text())


class ReadWriteRoundTrip(unittest.TestCase):
    def setUp(self):
        catalog._table = None
        self.addCleanup(lambda: setattr(catalog, "_table", None))
        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)
        p = mock.patch.object(catalog, "TABLE_NAME", TABLE)
        p.start()
        self.addCleanup(p.stop)
        self.table = boto3.resource("dynamodb", region_name=REGION).create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST")

    def test_the_same_handle_as_everyone_else(self):
        self.assertIs(pricing.catalog.get_table(), catalog.get_table())

    def test_set_then_read_back_a_manual_override(self):
        pricing.set_price("us.anthropic.claude-sonnet-5", 0.004, 0.02)
        prices = pricing.get_prices()["prices"]
        row = prices["anthropic.claude-sonnet-5"]     # 区域前缀被归一化掉
        self.assertEqual((row["input"], row["output"]), (0.004, 0.02))
        self.assertEqual(row["source"], "manual")
        # 落在同一张表的 PRICE 分区（此前是另一个句柄写的，字节一致）
        item = self.table.get_item(
            Key={"pk": "PRICE", "sk": "anthropic.claude-sonnet-5"})["Item"]
        self.assertEqual(item["input"], "0.004")

    def test_delete_falls_back_to_builtin(self):
        pricing.set_price("anthropic.claude-sonnet-5", 0.004, 0.02)
        pricing.delete_price("anthropic.claude-sonnet-5")
        row = pricing.get_prices()["prices"]["anthropic.claude-sonnet-5"]
        self.assertEqual(row["source"], "builtin")
        self.assertEqual(row["input"], pricing.BUILTIN_PRICES[
            "anthropic.claude-sonnet-5"]["input"])

    def test_last_sync_marker_still_read(self):
        self.table.put_item(Item={"pk": "PRICE", "sk": "_last_sync",
                                  "refreshed_at": 1787000000, "updated_models": 3})
        self.assertEqual(pricing.get_prices()["last_sync"],
                         {"at": 1787000000, "updated_models": 3})


class NoTableConfigured(unittest.TestCase):
    def test_builtin_only_and_no_request(self):
        """catalog.TABLE_NAME 为空（本地/单测）时一次请求都不发 —— 与改动前同。"""
        with mock.patch.object(catalog, "TABLE_NAME", ""), \
                mock.patch.object(catalog, "get_table",
                                  side_effect=AssertionError("没有表还去取句柄")):
            out = pricing.get_prices()
        self.assertIsNone(out["last_sync"])
        self.assertEqual(set(out["prices"]), set(pricing.BUILTIN_PRICES))
        self.assertTrue(all(v["source"] == "builtin" for v in out["prices"].values()))


if __name__ == "__main__":
    unittest.main()
