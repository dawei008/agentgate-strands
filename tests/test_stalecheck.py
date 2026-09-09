"""stalecheck.is_stale：三级判据 × 字段缺失退化的形态矩阵（UI-029 批 2）。

判定函数是全站唯一住所（reaper / 读侧 stale / 将来的并发闸门共用），所以这里
直测纯函数本体：不碰 AWS、不碰 moto，`now` 全部显式传入 —— 函数自己不许取
墙钟，这个文件就是那条约束的执行者（哪天有人在里面塞了 time.time()，
边界用例会开始随机红）。

字段形态两族都造（批 1 尚未合流）：
  · 新 run：带 heartbeat_epoch / estimated_duration_s（批 1 引入的键）；
  · 老 run：只有 started_epoch，甚至连它都没有 —— 逐级退化必须逐级钉死。

Run: python3 -m pytest tests/test_stalecheck.py -q
"""

import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import stalecheck  # noqa: E402
from stalecheck import is_stale  # noqa: E402

NOW = 1_787_700_000  # 判定时刻（任意固定值：函数只看差值）


def running(**fields) -> dict:
    return {"status": "running", **fields}


class TierOneHeartbeat(unittest.TestCase):
    """一级：heartbeat_epoch 存在时它是唯一话语权（天花板除外）。"""

    def test_fresh_heartbeat_is_alive(self):
        run = running(started_epoch=NOW - 3600, heartbeat_epoch=NOW - 100)
        self.assertFalse(is_stale(run, NOW))

    def test_missed_beats_beyond_threshold_is_stale(self):
        run = running(started_epoch=NOW - 3600,
                      heartbeat_epoch=NOW - stalecheck.HEARTBEAT_STALE_AFTER_S - 1)
        self.assertTrue(is_stale(run, NOW))

    def test_exactly_at_threshold_is_not_stale_yet(self):
        """边界取严格大于：恰好压线不判死（误判不可逆，方向是保守）。"""
        run = running(started_epoch=NOW - 3600,
                      heartbeat_epoch=NOW - stalecheck.HEARTBEAT_STALE_AFTER_S)
        self.assertFalse(is_stale(run, NOW))

    def test_heartbeat_overrides_expired_estimate_window(self):
        """心跳新鲜时预估窗口不参与：跑得比预估久得多但还在心跳 = 活着。"""
        run = running(started_epoch=NOW - 5 * 3600, estimated_duration_s=60,
                      heartbeat_epoch=NOW - 30)
        self.assertFalse(is_stale(run, NOW))

    def test_heartbeat_works_even_without_started_epoch(self):
        """一级不依赖 started_epoch（防御：字段被单独写坏时判据不塌）。"""
        self.assertTrue(is_stale(
            running(heartbeat_epoch=NOW - 10_000), NOW))
        self.assertFalse(is_stale(
            running(heartbeat_epoch=NOW - 10), NOW))


class TierTwoEstimate(unittest.TestCase):
    """二级：无心跳字段（批 1 未合流前的记录）→ started + max(预估×系数, 下限)。"""

    def test_light_plan_reaped_after_floor_window(self):
        """轻量方案：预估 60s，窗口取下限 30min —— 超下限判死，不必等天花板。"""
        run = running(started_epoch=NOW - stalecheck.ESTIMATE_FLOOR_S - 1,
                      estimated_duration_s=60)
        self.assertTrue(is_stale(run, NOW))

    def test_light_plan_inside_floor_window_is_alive(self):
        """限流风暴下的轻量方案：预估×3 早过了，但还在下限窗口内 → 不误判。"""
        run = running(started_epoch=NOW - stalecheck.ESTIMATE_FLOOR_S + 60,
                      estimated_duration_s=60)
        self.assertFalse(is_stale(run, NOW))

    def test_heavy_plan_keeps_its_scaled_window(self):
        """重型方案（预估 2h）：窗口 = 2h×3 = 6h，5.5h 时还不许判死。"""
        run = running(started_epoch=NOW - int(5.5 * 3600),
                      estimated_duration_s=2 * 3600)
        self.assertFalse(is_stale(run, NOW))

    def test_heavy_plan_beyond_scaled_window_is_stale(self):
        run = running(started_epoch=NOW - 6 * 3600 - 1,
                      estimated_duration_s=2 * 3600)
        self.assertTrue(is_stale(run, NOW))


class TierThreeCeiling(unittest.TestCase):
    """天花板：8h(maxLifetime)+裕量，无论其余字段什么形态。"""

    def test_bare_old_run_beyond_ceiling_is_stale(self):
        """老 run（只有 started_epoch）：唯一能判它的就是天花板。"""
        run = running(started_epoch=NOW - stalecheck.CEILING_S - 1)
        self.assertTrue(is_stale(run, NOW))

    def test_bare_run_inside_ceiling_is_alive(self):
        run = running(started_epoch=NOW - stalecheck.CEILING_S + 60)
        self.assertFalse(is_stale(run, NOW))

    def test_ceiling_beats_a_fresh_heartbeat(self):
        """心跳字段被卡死在「新鲜」也救不了 8h+ 的 run：microVM 物理上已回收。"""
        run = running(started_epoch=NOW - stalecheck.CEILING_S - 1,
                      heartbeat_epoch=NOW - 1)
        self.assertTrue(is_stale(run, NOW))

    def test_ceiling_beats_a_huge_estimate(self):
        run = running(started_epoch=NOW - stalecheck.CEILING_S - 1,
                      estimated_duration_s=24 * 3600)
        self.assertTrue(is_stale(run, NOW))


class Degradation(unittest.TestCase):
    """缺哪个字段走哪级退化；判不了的一律 False（宁可漏判绝不误判）。"""

    def test_no_fields_at_all_is_never_stale(self):
        self.assertFalse(is_stale(running(), NOW))

    def test_terminal_statuses_are_never_stale(self):
        for status in ("completed", "error", "stopped", "halted_cost", "skipped", ""):
            with self.subTest(status=status):
                run = {"status": status, "started_epoch": NOW - 10 * 3600,
                       "heartbeat_epoch": NOW - 10 * 3600}
                self.assertFalse(is_stale(run, NOW))

    def test_ddb_decimal_and_string_forms_are_accepted(self):
        """DDB resource API 读出 Decimal；宽容读取不许因类型走错分支。"""
        stale = running(started_epoch=Decimal(NOW - 3600),
                        heartbeat_epoch=Decimal(NOW - 10_000))
        alive = running(started_epoch=str(NOW - 3600),
                        heartbeat_epoch=str(NOW - 10))
        self.assertTrue(is_stale(stale, NOW))
        self.assertFalse(is_stale(alive, NOW))

    def test_garbage_field_degrades_instead_of_crashing(self):
        """坏心跳值（空串/非数字）→ 当没有这级判据，退化到二级/天花板。"""
        run = running(started_epoch=NOW - stalecheck.ESTIMATE_FLOOR_S - 1,
                      heartbeat_epoch="", estimated_duration_s=60)
        self.assertTrue(is_stale(run, NOW))
        fresh = running(started_epoch=NOW - 60,
                        heartbeat_epoch="not-a-number")
        self.assertFalse(is_stale(fresh, NOW))

    def test_pure_function_same_inputs_same_answer(self):
        """同输入同答案（函数里没有墙钟）：两次调用隔任意久都一致。"""
        run = running(started_epoch=NOW - 3600, heartbeat_epoch=NOW - 100)
        self.assertEqual(is_stale(run, NOW), is_stale(run, NOW))
        self.assertTrue(is_stale(run, NOW + 10_000))  # 判定时刻后移才改变答案


if __name__ == "__main__":
    unittest.main()
