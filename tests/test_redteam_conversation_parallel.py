"""红队一行攻击的多会话取数：并发、保序、降级原因仍取顺序上第一个。

收口前逐个 `await`：k 个会话 = k 趟 Insights 读的墙钟串起来（每趟都是独立的读，互不依赖）。
改 `asyncio.gather` 后要同时成立三件，缺一件就是语义变了：
  · 真并发（k 趟 → 1 趟墙钟）；
  · 还原用的会话顺序仍是 backtrack 轮换顺序（gather 按传入顺序回结果）；
  · 任一会话取不到 ⇒ 返回**顺序上第一个**失败的原因（与「碰到第一个就返回」同一个答案），
    代价是失败路径上剩下那几趟已经发出去了 —— 这一条也钉住，别当成没成本。
运行：python3 -m pytest tests/test_redteam_conversation_parallel.py -q
"""

import asyncio
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import planrun  # noqa: E402
import testrun  # noqa: E402

AGENT = {"agent_name": "rt-agent", "log_group": "aws/spans"}
CFG = {"log_group": "aws/spans", "scope_filter": "", "service_filter": ""}
SIDS = ["evaltest-rt-1", "evaltest-rt-2", "evaltest-rt-3", "evaltest-rt-4"]
FETCH_SECONDS = 0.05


class Restore(unittest.TestCase):
    def _run(self, outcomes: dict):
        """outcomes: sid → (session, degrade)。返回 (结果, 真去取过的 sid, 峰值并发)。"""
        lock = threading.Lock()
        live: set[str] = set()
        peak = 0
        asked: list[str] = []

        def fake_fetch(cfg, sid, sources):
            nonlocal peak
            self.assertEqual(cfg, CFG)
            self.assertEqual(sources, ["aws/spans"])
            with lock:
                asked.append(sid)
                live.add(sid)
                peak = max(peak, len(live))
            time.sleep(FETCH_SECONDS)
            with lock:
                live.discard(sid)
            return outcomes[sid]

        with mock.patch.object(planrun.tracesource, "resolve_span_config", return_value=CFG), \
                mock.patch.object(planrun.tracesource, "fetch_scoring_session",
                                  side_effect=fake_fetch), \
                mock.patch.object(planrun.tracesource, "conversation_from_sessions",
                                  side_effect=lambda ss: {"conversation": list(ss)}):
            t0 = time.monotonic()
            out = asyncio.run(planrun._restore_attack_conversation(AGENT, SIDS, ["aws/spans"]))
            elapsed = time.monotonic() - t0
        return out, asked, peak, elapsed

    def test_all_ok_is_concurrent_and_keeps_the_order(self):
        (conv, degrade), asked, peak, elapsed = self._run(
            {sid: (f"S:{sid}", None) for sid in SIDS})
        self.assertIsNone(degrade)
        self.assertEqual(conv["conversation"], [f"S:{sid}" for sid in SIDS],
                         "还原用的会话顺序必须是传入顺序（backtrack 轮换顺序）")
        self.assertEqual(sorted(asked), sorted(SIDS))
        self.assertGreaterEqual(peak, 2, f"没并发起来（峰值 {peak}）")
        self.assertLess(elapsed, len(SIDS) * FETCH_SECONDS,
                        f"墙钟 {elapsed:.3f}s 不比串行短 ⇒ 还是 k 趟")

    def test_first_failure_in_order_decides_the_reason(self):
        """第 2、3 个都失败且原因不同：取顺序上第一个（第 2 个的），不是最先返回的那个。"""
        outcomes = {sid: (f"S:{sid}", None) for sid in SIDS}
        outcomes[SIDS[1]] = (None, testrun.TRACE_REASON_NO_CONTENT)
        outcomes[SIDS[2]] = (None, testrun.TRACE_REASON_FETCH_ERROR)
        (conv, degrade), asked, _peak, _elapsed = self._run(outcomes)
        self.assertIsNone(conv)
        self.assertEqual(degrade, testrun.TRACE_REASON_NO_CONTENT)
        self.assertEqual(sorted(asked), sorted(SIDS),
                         "失败路径上剩下那几趟已经发出去了（并发的代价，写在 docstring 里）")

    def test_missing_reason_falls_back_to_no_content(self):
        outcomes = {sid: (f"S:{sid}", None) for sid in SIDS}
        outcomes[SIDS[0]] = (None, None)
        (conv, degrade), _asked, _peak, _elapsed = self._run(outcomes)
        self.assertEqual((conv, degrade), (None, testrun.TRACE_REASON_NO_CONTENT))

    def test_no_sessions_never_reads(self):
        with mock.patch.object(planrun.tracesource, "resolve_span_config", return_value=CFG), \
                mock.patch.object(planrun.tracesource, "fetch_scoring_session") as f:
            out = asyncio.run(planrun._restore_attack_conversation(AGENT, [], ["aws/spans"]))
        self.assertEqual(out, (None, testrun.TRACE_REASON_NO_SPAN))
        f.assert_not_called()


if __name__ == "__main__":
    unittest.main()
