"""Logs Insights 结果轮询的格子：0.25 s 起、按「到达时刻倍增」、单次封顶 1.0 s。

为什么钉到轮询时刻而不是只钉两个常量：这条改动的收益与风险都在**格子落在哪儿** ——
恒 1.0 s 时查询完成被向上取整到整秒（平均白等半格，趟数一乘就是秒级）；而「单次延时
倍增」这种直觉写法的到达时刻是 0.25 / 0.75 / 1.75 …，**跳过 1.0**，对 0.80 s 就绪的查询
反而比旧法慢 0.75 s（本地实测踩到过）。所以判据 = 到达时刻集合必须是旧格 {1,2,3,…}
的超集（⇒ 对任何就绪时刻都不比旧法晚），外加头 1 秒里多出的两个细格。

运行：python3 -m pytest tests/test_insights_poll_backoff.py -q
"""

import sys
import unittest
from itertools import accumulate
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import discovery  # noqa: E402


class FakeLogs:
    """前 `running` 次报 Running，之后 Complete。"""

    def __init__(self, running: int, final: str = "Complete"):
        self.running = running
        self.final = final
        self.polls = 0

    def start_query(self, **kw):
        return {"queryId": "q1"}

    def get_query_results(self, queryId):
        self.polls += 1
        if self.polls <= self.running:
            return {"status": "Running"}
        return {"status": self.final, "results": [[{"field": "x", "value": "1"}]]}


def _poll(running: int, final: str = "Complete") -> tuple[list[float], FakeLogs]:
    sleeps: list[float] = []
    fake = FakeLogs(running, final)
    with mock.patch.object(discovery, "_logs_client", return_value=fake), \
            mock.patch.object(discovery.time, "sleep", side_effect=sleeps.append):
        rows = _poll.rows = discovery._run_insights_query("g", "fields @message", 1)
    assert isinstance(rows, list)
    return sleeps, fake


class PollGrid(unittest.TestCase):
    def test_sleep_sequence(self):
        sleeps, fake = _poll(running=5)
        self.assertEqual(sleeps, [0.25, 0.25, 0.5, 1.0, 1.0])
        self.assertEqual(fake.polls, 6, "第一次查询在任何 sleep 之前（0 秒那格）")

    def test_arrival_times_are_a_superset_of_the_old_one_second_grid(self):
        """对任何就绪时刻都不比恒 1.0 s 慢的**结构性**根据。"""
        sleeps, _ = _poll(running=8)
        arrivals = list(accumulate(sleeps))
        self.assertEqual(arrivals, [0.25, 0.5, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
        # 同一段墙钟视野内（0 → 最后一次到达）旧格的每个点都得在新格里。视野按新格的
        # 末点算，不按轮询次数算：同样 8 次轮询新格只走到 6.0 s、旧格走到 8.0 s（覆盖
        # 60 s 视野新法多付两次 get_query_results，这是这条改动的成本侧）。
        old_grid = [float(i) for i in range(1, int(arrivals[-1]) + 1)]
        self.assertEqual(old_grid, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
        self.assertTrue(set(old_grid) <= set(arrivals),
                        f"到达时刻漏了旧格里的点：{sorted(set(old_grid) - set(arrivals))}")

    def test_single_delay_never_exceeds_the_cap(self):
        sleeps, _ = _poll(running=12)
        self.assertLessEqual(max(sleeps), discovery.QUERY_POLL_MAX_SECONDS)
        self.assertEqual(sleeps[0], discovery.QUERY_POLL_START_SECONDS)

    def test_first_poll_completing_costs_no_sleep(self):
        sleeps, fake = _poll(running=0)
        self.assertEqual((sleeps, fake.polls), ([], 1))

    def test_failed_query_still_raises_and_timeout_still_trips(self):
        fake = FakeLogs(0, final="Failed")
        with mock.patch.object(discovery, "_logs_client", return_value=fake), \
                self.assertRaises(RuntimeError):
            discovery._run_insights_query("g", "q", 1)
        with mock.patch.object(discovery, "_logs_client", return_value=FakeLogs(99)), \
                mock.patch.object(discovery, "QUERY_TIMEOUT_SECONDS", 0.0), \
                self.assertRaises(TimeoutError):
            discovery._run_insights_query("g", "q", 1)


if __name__ == "__main__":
    unittest.main()
