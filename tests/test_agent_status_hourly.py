"""`agent_status.hourly` —— 24 个 1h 桶的会话量，从同一次 Logs Insights 查询本地分桶。

钉四件事：
  1. 桶数 == window_hours，桶起点从 now-24h 起每小时一格，标签 = 桶起点（分钟精度 UTC）；
  2. 每个会话只归它窗内最早 span 所在的桶 ⇒ sum(hourly) == metrics.sessions.value；无数据桶 0；
  3. 仍然只发一次查询（与五个数共用）；
  4. 无日志组 / 查询失败 / 截断 ⇒ hourly == [] 且 unavailable_reason 照旧。

Run: python3 -m pytest tests/test_agent_status_hourly.py -q
"""

import sys
import unittest
from datetime import timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import agentstatus  # noqa: E402
from test_agent_status import NOW, _Base, cur, invoke_agent_row, prev, tool_row  # noqa: E402


class Hourly(_Base):
    def test_24_buckets_labels_and_first_span_assignment(self):
        # s1 在 now-1h 桶（最早 span cur(1.5) 落在 [now-2h, now-1h) 桶 = index 22）
        # s1 还有一条更晚的工具 span 在 index 23 桶 —— 不重复计
        # s2、s3 同落 index 20 桶（cur(3.2) / cur(3.9)）；前窗会话 p1 不进 hourly
        self.rows = [
            invoke_agent_row("s1", cur(1.5), 2.0),
            tool_row("s1", cur(0.5)),
            invoke_agent_row("s2", cur(3.2), 1.0),
            invoke_agent_row("s3", cur(3.9), 1.0),
            invoke_agent_row("p1", prev(1), 1.0),
        ]
        out = self.status()
        hourly = out["hourly"]
        self.assertEqual(len(hourly), 24)
        self.assertEqual(hourly[0]["hour"], (NOW - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%MZ"))
        self.assertEqual(hourly[0]["hour"], "2026-09-02T08:00Z")
        self.assertEqual(hourly[23]["hour"], "2026-09-03T07:00Z")
        counts = [b["sessions"] for b in hourly]
        self.assertEqual(counts[22], 1)
        self.assertEqual(counts[23], 0)
        self.assertEqual(counts[20], 2)
        self.assertEqual(sum(counts), out["metrics"]["sessions"]["value"])
        self.assertEqual(sum(counts), 3)
        self.assertEqual(self.query.call_count, 1, "hourly 不许多发查询")

    def test_empty_window_is_24_zeros(self):
        self.rows = []
        hourly = self.status()["hourly"]
        self.assertEqual([b["sessions"] for b in hourly], [0] * 24)

    def test_no_span_source_gives_empty_hourly(self):
        with mock.patch.object(agentstatus.tracesource, "resolve_span_config",
                               return_value=None):
            out = self.status()
        self.assertEqual(out["hourly"], [])
        self.assertIn("日志组", out["unavailable_reason"]["sessions"])

    def test_query_failure_gives_empty_hourly(self):
        self.query.side_effect = TimeoutError("Logs Insights query timed out for lg")
        out = self.status()
        self.assertEqual(out["hourly"], [])
        self.assertIn("timed out", out["unavailable_reason"]["sessions"])

    def test_truncated_gives_empty_hourly(self):
        self.rows = [invoke_agent_row(f"s{i}", cur(1), 1.0) for i in range(10000)]
        self.assertEqual(self.status()["hourly"], [])

    def test_window_hours_drives_bucket_count(self):
        self.rows = [invoke_agent_row("s1", NOW - timedelta(minutes=30), 1.0)]
        out = agentstatus.agent_status("support-bot", window_hours=6)
        self.assertEqual(len(out["hourly"]), 6)
        self.assertEqual(out["hourly"][5]["sessions"], 1)
        self.assertEqual(out["hourly"][0]["hour"], "2026-09-03T02:00Z")


if __name__ == "__main__":
    unittest.main()
