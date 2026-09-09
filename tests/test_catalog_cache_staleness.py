"""首页「缓存于 …」四天不动（P1，.scratch/triage-r1/issues/fleet-cache-never-expires.md）：成因钉 + 修法钉。

现网 2026-09-08 12:49 UTC 复查：页头「近 24h · 09-07 12:49 → 09-08 12:49」（无「· 缓存」后缀
⇒ 舰队五数是当次新算的），下一行「缓存于 2026-09-04 08:52 UTC」= 4 天前。两个时刻来自两个缓存：

  * 那句「缓存于」读的是 **discover** 的 `from_cache` / `refreshed_at` —— catalog 表 AGENT 分区
    （DDB 持久）的扫描时刻。修前 `catalog.cached_agents()` 只看分区有没有 item，**不看 refreshed_at**；
    `main.invoke` 的 discover 分支只在 `refresh=True` 或分区为空时才 `refresh_agents()`。
    全仓没有定时器 / run 结束回写 / 页面打开触发 —— 唯一写点是手点「重新扫描」。
    ⇒ 零 TTL、零自动触发点，四天前扫的就四天不动。
  * fleet_status 只有 `ttlcache.TtlCache(300)` 进程内缓存，**没有** DDB / S3 侧持久缓存，
    `cache_age_s` 结构上 ≤ 300；issue 里「fleet 的持久缓存（DDB/S3 侧）四天没换」这一层不存在。
  * 但 fleet_status 的 Agent 集合 = `agentstatus.list_known_agents()` = `catalog.cached_agents()`
    —— 五数是**对着 4 天前的目录**算的（log_group / has_logs / runtime_arn 全是旧的）。
    09-04 评审判「不成立」只看到了前一半（五数新算），漏了目录本身超龄且喂给了五数。

修法（过期自动重算，契约见 docs/payload-contract.md discover 节）：目录年龄 > 24h ⇒ discover
同步重扫一次再返回；失败照旧回旧目录但 `catalog_refresh` 记录失败原话，300s 防抖。

moto 提供真 DynamoDB；不触任何线上表 / Agent。
Run: python3 -m pytest tests/test_catalog_cache_staleness.py -q
"""

import asyncio
import json
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

import boto3
from boto3.dynamodb.conditions import Key
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import agentstatus  # noqa: E402
import catalog  # noqa: E402
import fleetstatus  # noqa: E402
import ttlcache  # noqa: E402

TABLE = "eval-catalog-test"
REGION = "us-west-2"
HOUR = 3600
FOUR_DAYS = 4 * 24 * HOUR


def discovered(name: str) -> dict:
    return {"agent_name": name, "runtime_id": f"{name}-abc123",
            "runtime_arn": f"arn:aws:bedrock-agentcore:{REGION}:111122223333:runtime/{name}-abc123",
            "description": "", "status": "READY", "last_updated": "2026-09-04 08:00:00+00:00",
            "log_group": f"/aws/bedrock-agentcore/runtimes/{name}-abc123-DEFAULT", "has_logs": True}


class Fixture(unittest.TestCase):
    age_s = FOUR_DAYS  # 子类改这个数就换目录年龄

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
        catalog._auto_refresh_failed.clear()
        self.addCleanup(catalog._auto_refresh_failed.clear)
        self.now = int(time.time())
        self.scanned_at = self.now - self.age_s
        for name in ("alpha", "beta"):
            self.table.put_item(Item={"pk": "AGENT", "sk": name,
                                      "data": json.dumps(discovered(name), ensure_ascii=False),
                                      "refreshed_at": self.scanned_at})
        # 现扫 = AgentCore 控制面 + CloudWatch，测试里换成会返回「新目录」的桩
        self.rescan = mock.Mock(return_value=[discovered("alpha"), discovered("beta"),
                                              discovered("gamma")])
        p = mock.patch.object(catalog, "list_agents", self.rescan)
        p.start()
        self.addCleanup(p.stop)

    def discover(self, **payload):
        import main

        async def go():
            return [ev async for ev in main.invoke({"action": "discover", **payload})]
        events = asyncio.run(go())
        self.assertEqual([e["event"] for e in events], ["agents"])
        return events[0]

    def ddb_agent_names(self) -> list[str]:
        items = self.table.query(KeyConditionExpression=Key("pk").eq("AGENT"))["Items"]
        return sorted(i["sk"] for i in items)


class StaleCatalogAutoRescans(Fixture):
    """目录 4 天前扫的（超过 24h 窗口）。"""

    def test_stale_catalog_triggers_one_sync_rescan_and_rewrites(self):
        """修前这里是 from_cache=True、refreshed_at=4 天前、rescan 0 次（成因复现，982342e）。"""
        ev = self.discover()
        self.assertFalse(ev["from_cache"])
        self.assertGreaterEqual(ev["refreshed_at"], self.now)
        self.assertEqual(self.rescan.call_count, 1)
        self.assertEqual([a["agent_name"] for a in ev["agents"]], ["alpha", "beta", "gamma"])
        self.assertEqual(ev["catalog_refresh"], {"attempted": True, "ok": True, "error": None})
        self.assertEqual(self.ddb_agent_names(), ["alpha", "beta", "gamma"], "重扫结果写回 DDB")

    def test_fleet_agent_set_follows_the_rescanned_catalog(self):
        """fleet_status / agent_status 的 Agent 集合读同一份目录 ⇒ discover 重扫后它们也拿到新目录。"""
        self.assertEqual([a["agent_name"] for a in agentstatus.list_known_agents()], ["alpha", "beta"])
        self.discover()
        self.assertEqual([a["agent_name"] for a in agentstatus.list_known_agents()],
                         ["alpha", "beta", "gamma"])
        self.assertEqual(self.rescan.call_count, 1, "list_known_agents 自己不重扫")

    def test_rescan_failure_serves_old_catalog_and_reports_it(self):
        """重扫抛错 ⇒ 不报错、回旧目录（旧 refreshed_at），catalog_refresh 带失败原话。"""
        self.rescan.side_effect = RuntimeError("ListAgentRuntimes ThrottlingException: Rate exceeded")
        ev = self.discover()
        self.assertTrue(ev["from_cache"])
        self.assertEqual(ev["refreshed_at"], self.scanned_at)
        self.assertEqual([a["agent_name"] for a in ev["agents"]], ["alpha", "beta"])
        self.assertEqual(ev["catalog_refresh"],
                         {"attempted": True, "ok": False,
                          "error": "ListAgentRuntimes ThrottlingException: Rate exceeded"})
        self.assertEqual(self.ddb_agent_names(), ["alpha", "beta"], "失败不动 DDB")

    def test_failure_is_debounced_for_300s_then_retried(self):
        clock = {"t": 1000.0}
        with mock.patch.object(ttlcache, "_monotonic", side_effect=lambda: clock["t"]):
            self.rescan.side_effect = RuntimeError("boom")
            self.discover()
            self.assertEqual(self.rescan.call_count, 1)
            clock["t"] += 299
            ev = self.discover()
            self.assertEqual(self.rescan.call_count, 1, "防抖期内不重试")
            self.assertEqual(ev["catalog_refresh"], {"attempted": False, "ok": False, "error": "boom"})
            self.assertTrue(ev["from_cache"])
            clock["t"] += 2
            self.rescan.side_effect = None
            ev = self.discover()
            self.assertEqual(self.rescan.call_count, 2, "过了 300s 再试")
            self.assertEqual(ev["catalog_refresh"]["ok"], True)
            self.assertFalse(ev["from_cache"])

    def test_error_text_is_capped_at_200_chars(self):
        self.rescan.side_effect = RuntimeError("x" * 500)
        ev = self.discover()
        self.assertEqual(len(ev["catalog_refresh"]["error"]), 200)

    def test_manual_refresh_unchanged(self):
        """refresh:true 照旧：强制重扫、不走自动路径（catalog_refresh 为 null）。"""
        ev = self.discover(refresh=True)
        self.assertFalse(ev["from_cache"])
        self.assertIsNone(ev["catalog_refresh"])
        self.assertEqual(self.rescan.call_count, 1)
        self.assertEqual(self.ddb_agent_names(), ["alpha", "beta", "gamma"])


class FreshCatalogUntouched(Fixture):
    """目录 23h 前扫的（窗口内）：不重扫、不写 DDB、catalog_refresh 为 null。"""
    age_s = 23 * HOUR

    def test_no_rescan_within_window(self):
        ev = self.discover()
        self.assertTrue(ev["from_cache"])
        self.assertEqual(ev["refreshed_at"], self.scanned_at)
        self.assertIsNone(ev["catalog_refresh"])
        self.assertEqual(self.rescan.call_count, 0)
        self.assertEqual(self.ddb_agent_names(), ["alpha", "beta"])

    def test_threshold_is_strictly_more_than_24h(self):
        cached = {"agents": [], "refreshed_at": 1_000_000}
        self.assertFalse(catalog.is_stale(cached, now=1_000_000 + catalog.CATALOG_MAX_AGE_SECONDS))
        self.assertTrue(catalog.is_stale(cached, now=1_000_000 + catalog.CATALOG_MAX_AGE_SECONDS + 1))
        self.assertEqual(catalog.CATALOG_MAX_AGE_SECONDS, agentstatus.WINDOW_HOURS * HOUR)
        # 老行没有 refreshed_at ⇒ 按 0 算（cached_agents 对缺键行也是 int(…, 0)）⇒ 真钟下必超龄
        self.assertTrue(catalog.is_stale({"agents": []}))
        self.assertEqual(catalog.catalog_age_s({"agents": []}, now=5), 5)


class FleetHasNoPersistentCache(Fixture):
    """fleet_status 的缓存只在进程内：DDB 里没有它的缓存项，age 结构上 ≤ TTL。"""

    def setUp(self):
        super().setUp()
        fleetstatus._cache.clear()
        self.addCleanup(fleetstatus._cache.clear)
        self.clock = {"t": 1000.0}
        p = mock.patch.object(ttlcache, "_monotonic", side_effect=lambda: self.clock["t"])
        p.start()
        self.addCleanup(p.stop)
        self.compute = mock.Mock(side_effect=lambda w: {
            "event": "fleet_status", "window_hours": w,
            "computed_at": "2026-09-08T12:49:00Z", "generated_at": "2026-09-08T12:49:00Z",
            "cached": False, "cache_age_s": 0})
        p = mock.patch.object(fleetstatus, "_compute", self.compute)
        p.start()
        self.addCleanup(p.stop)

    def test_cache_is_process_local_ttlcache_and_writes_nothing(self):
        self.assertIsInstance(fleetstatus._cache, ttlcache.TtlCache)
        self.assertEqual(fleetstatus.CACHE_TTL_SECONDS, ttlcache.DEFAULT_TTL_SECONDS)
        before = self.table.scan()["Items"]
        first = fleetstatus.fleet_status()
        self.assertFalse(first["cached"])
        self.clock["t"] += 299
        hit = fleetstatus.fleet_status()
        self.assertTrue(hit["cached"])
        self.assertEqual(hit["cache_age_s"], 299)
        self.assertEqual(hit["computed_at"], first["computed_at"])
        self.assertEqual(self.table.scan()["Items"], before, "DDB 里没有 fleet 的缓存项")

    def test_age_cannot_exceed_ttl(self):
        fleetstatus.fleet_status()
        self.clock["t"] += fleetstatus.CACHE_TTL_SECONDS + 1
        again = fleetstatus.fleet_status()
        self.assertFalse(again["cached"])
        self.assertEqual(again["cache_age_s"], 0)
        self.assertEqual(self.compute.call_count, 2)


if __name__ == "__main__":
    unittest.main()
