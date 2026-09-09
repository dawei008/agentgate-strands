"""app/ttlcache.py：TTL 缓存 + 数值守卫。四个用途（fleet_status / agent_status /
agent_topology / 会话对比的终态归档）共用这一份，所以它自己也要有直接的红绿。

钉住：
  1. 未命中 / 命中 / 过期三态，`age_s` = 距**写入时刻**的整秒（不是距上次读）；
  2. 过期边界右开：deadline 那一刻算过期（与旧的三份 `hit[0] > now` 逐字同义）；
  3. max_entries 满了淘汰**最早写入**的一条，重写一个键算最新；
  4. is_number：bool 不算数（JSON 里 True 会被 isinstance(v, int) 放过去）。

Run: python3 -m pytest tests/test_ttlcache.py -q
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

import ttlcache  # noqa: E402


class Guard(unittest.TestCase):
    def test_bool_is_not_a_number(self):
        for v in (True, False):
            self.assertFalse(ttlcache.is_number(v), repr(v))

    def test_ints_and_floats_are(self):
        for v in (0, -3, 1.5, 0.0):
            self.assertTrue(ttlcache.is_number(v), repr(v))

    def test_everything_else_is_not(self):
        for v in (None, "", "1", [], {}, object()):
            self.assertFalse(ttlcache.is_number(v), repr(v))


class Ttl(unittest.TestCase):
    def setUp(self):
        self.clock = {"t": 1000.0}
        p = mock.patch.object(ttlcache, "_monotonic", side_effect=lambda: self.clock["t"])
        p.start()
        self.addCleanup(p.stop)

    def test_miss_hit_expire_and_age(self):
        c = ttlcache.TtlCache(300)
        self.assertIsNone(c.get("k"))
        c.put("k", {"v": 1})
        self.assertEqual(c.get("k"), ({"v": 1}, 0))
        self.clock["t"] += 42
        self.assertEqual(c.get("k"), ({"v": 1}, 42), "age 是距写入时刻，不是距上次读")
        self.clock["t"] += 100
        self.assertEqual(c.get("k")[1], 142)
        self.clock["t"] += 158  # 共 300：正好到期
        self.assertIsNone(c.get("k"), "deadline 那一刻就算过期（右开）")

    def test_one_second_before_the_deadline_still_hits(self):
        c = ttlcache.TtlCache(300)
        c.put("k", 1)
        self.clock["t"] += 299
        self.assertEqual(c.get("k"), (1, 299))

    def test_rewrite_resets_the_age(self):
        c = ttlcache.TtlCache(300)
        c.put("k", 1)
        self.clock["t"] += 100
        c.put("k", 2)
        self.assertEqual(c.get("k"), (2, 0))

    def test_keys_grow_unbounded_without_max_entries(self):
        c = ttlcache.TtlCache(300)
        for i in range(50):
            c.put(i, i)
        self.assertEqual(len(list(c)), 50)

    def test_max_entries_evicts_the_oldest_write(self):
        c = ttlcache.TtlCache(300, max_entries=3)
        for k in "abcd":
            c.put(k, k)
        self.assertEqual(list(c), ["b", "c", "d"])
        self.assertIsNone(c.get("a"))
        # 重写 b 让它变成最新 ⇒ 下一次淘汰的是 c
        c.put("b", "b2")
        c.put("e", "e")
        self.assertEqual(list(c), ["d", "b", "e"])
        self.assertEqual(c.get("b")[0], "b2")

    def test_clear(self):
        c = ttlcache.TtlCache(300)
        c.put("k", 1)
        c.clear()
        self.assertEqual(list(c), [])
        self.assertIsNone(c.get("k"))


if __name__ == "__main__":
    unittest.main()
