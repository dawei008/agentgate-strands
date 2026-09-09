"""共享的 DynamoDB 句柄有一个**公开**名字：`catalog.get_table()`（L4）。

它一直是事实公共 API —— evalcache / judgellm / plan / planrun / pricing / testrun
六个模块伸手拿它（外加 runstore 与 testrun 的注释拿它当范本）。名字却拼作私有，
于是每个调用点都在示范「跨模块碰下划线」，测试还按字符串 patch 一个私有名。

改名是全量的：**不留 alias**。留 alias 等于留两个名字，下一个人照旧抄私有那个。
本文件钉：公名在、私名彻底消失、六个模块拿到的是同一个对象。

Run: python3 -m pytest tests/test_r2_core_table_handle.py -q
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

TABLE = "eval-catalog-test"
REGION = "us-west-2"

# 六个跨模块消费者（L4 的原始清单 + Track B 合流后新增的 testrun）。
# pricing 是 R4 之后加入的：它此前养着自己那份逐字拷贝的 _get_table
# （细节见 tests/test_r2_core_price_table.py）。
CONSUMERS = ("evalcache", "judgellm", "plan", "planrun", "pricing", "testrun")


class ThePublicName(unittest.TestCase):
    def test_public_name_exists(self):
        self.assertTrue(callable(catalog.get_table))

    def test_the_private_name_is_gone_with_no_alias(self):
        self.assertFalse(hasattr(catalog, "_get_table"),
                         "留了 alias = 留了两个名字，下一个人照旧抄私有那个")

    def test_the_module_cache_stays_private(self):
        """缓存槽 `_table` 仍是私有实现细节 —— 公开的是取句柄这个动作。"""
        self.assertIn("_table", vars(catalog))

    def test_no_module_reaches_for_a_private_catalog_handle(self):
        offenders = [p.name for p in sorted(APP.glob("*.py"))
                     if "catalog._get_table" in p.read_text()]
        self.assertEqual(offenders, [], f"仍在碰私有名：{offenders}")

    def test_no_test_patches_the_private_name(self):
        """按字符串 patch 的测试 14 个，patch 目标必须一起迁 —— 漏一个就是
        「patch 了一个不存在的名字」（mock 会直接抛 AttributeError）。

        判据是两种真实写法：`catalog, "_get_table"`（patch.object 目标，含
        `judgellm.catalog` 这类前缀）与 `catalog._get_table`（源码文本断言）。
        别的模块提到这个词不算 —— 比如 R4 那个测试断言 pricing **没有**同名私有件。
        本文件自己也排除：上面那条 alias 守卫写的正是 `hasattr(catalog, "_get_table")`。"""
        tests = Path(__file__).resolve().parent
        offenders = []
        for path in sorted(tests.glob("test_*.py")):
            if path.name == Path(__file__).name:
                continue
            src = path.read_text()
            if 'catalog, "_get_table"' in src or "catalog._get_table" in src:
                offenders.append(path.name)
        self.assertEqual(offenders, [], f"仍在按私有名 patch：{offenders}")


class OneHandleForEveryone(unittest.TestCase):
    def setUp(self):
        catalog._table = None
        self.addCleanup(lambda: setattr(catalog, "_table", None))
        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)
        p = mock.patch.object(catalog, "TABLE_NAME", TABLE)
        p.start()
        self.addCleanup(p.stop)
        boto3.resource("dynamodb", region_name=REGION).create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST")

    def test_still_a_lazy_singleton(self):
        self.assertIs(catalog.get_table(), catalog.get_table())

    def test_every_consumer_module_sees_the_same_object(self):
        want = catalog.get_table()
        for name in CONSUMERS:
            with self.subTest(module=name):
                mod = __import__(name)
                self.assertIs(mod.catalog.get_table(), want)

    def test_a_real_round_trip_still_works(self):
        catalog.get_table().put_item(Item={"pk": "PING", "sk": "1", "data": "{}"})
        self.assertEqual(
            catalog.get_table().get_item(Key={"pk": "PING", "sk": "1"})["Item"]["data"],
            "{}")


if __name__ == "__main__":
    unittest.main()
