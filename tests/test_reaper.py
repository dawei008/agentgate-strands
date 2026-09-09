"""陈旧 running 收敛器 + 读侧 stale（UI-029 批 2，承接 stale-running-run-reaper 档案）。

Lambda/microVM 被硬杀（8h maxLifetime / OOM / 发版 / idle 回收）时
execute_plan_run 的 finally 根本不执行，开跑那条 running marker 永远停在
running。本文件钉三件事：

  1. 读侧 `stale: bool`：list_plan_runs / get_plan_run / list_recent_runs 输出
     的每条 run 都带它 —— 读时判、**不写库**（前端批 3 零判定逻辑只消费）；
     终态记录恒 False。
  2. reap_stale_runs：有界扫描，只改判 `started_epoch >= REAPER_EPOCH_FLOOR`
     （机制上线时刻）的记录 —— 存量僵尸**永不碰**（用户常设指令「旧数据不修」，
     档案 ⛔ 段）；改判走条件写（status=running），输给真终态就放手；幂等。
  3. 改判后的 run 与既有 error 终态（_converge_interrupted）同刑：status="error"
     + 可读原因（注明心跳超时判定）+ finished_*，已写入的字段一个不清。

moto 提供真 DynamoDB，不碰真表/真 agent/真 LLM。
Run: python3 -m pytest tests/test_reaper.py -q
"""

import copy
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import planrun  # noqa: E402
import stalecheck  # noqa: E402

TABLE = "eval-catalog-test"
REGION = "us-west-2"

FLOOR = planrun.REAPER_EPOCH_FLOOR
NOW = FLOOR + 10 * 86400  # 上线 10 天后的一次扫描（reap 的 now 显式传入）


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
        p = mock.patch.object(planrun, "_table", return_value=self.table)
        p.start()
        self.addCleanup(p.stop)

    def put_run(self, sk: str, status: str = "running", **fields) -> dict:
        """一条 PLANRUN 摘要项，形状照 execute_plan_run 的 running marker。"""
        item = {"pk": "PLANRUN", "sk": sk,
                "plan_id": sk.split("#")[0], "plan_name": "线上评估周巡检",
                "agent_name": "support-bot", "status": status,
                "triggered_by": "manual", "started_at": "2026-08-25 10:00 UTC",
                "stage_summaries": "[]", "overview": "{}",
                "s3_key": "", "proposals": "[]", **fields}
        self.table.put_item(Item=item)
        return item

    def raw(self, sk: str) -> dict:
        return self.table.get_item(Key={"pk": "PLANRUN", "sk": sk}).get("Item")


class ReadSideStale(Fixture):
    """读侧附 stale：读时判、不写库；终态恒 False。"""

    def test_list_plan_runs_marks_a_dead_running_row(self):
        now = int(time.time())
        self.put_run("plan-a#20260825000001",
                     started_epoch=now - stalecheck.CEILING_S - 60)
        self.put_run("plan-a#20260825000002", started_epoch=now - 60)
        rows = {r["run_key"]: r for r in planrun.list_plan_runs("plan-a")}
        self.assertTrue(rows["plan-a#20260825000001"]["stale"])
        self.assertFalse(rows["plan-a#20260825000002"]["stale"])

    def test_terminal_and_legacy_rows_are_never_stale(self):
        now = int(time.time())
        self.put_run("plan-a#20260825000001", status="completed",
                     started_epoch=now - 10 * 3600, score="0.8")
        self.put_run("plan-a#20260825000002", status="error",
                     started_epoch=now - 10 * 3600, error="x")
        # 极老记录：连 started_epoch 都没有 → 无从判定 → False（保守）
        self.put_run("plan-a#20260825000003")
        for r in planrun.list_plan_runs("plan-a"):
            self.assertFalse(r["stale"], r["run_key"])

    def test_get_plan_run_carries_the_same_verdict(self):
        now = int(time.time())
        self.put_run("plan-a#20260825000001",
                     started_epoch=now - 1200,
                     heartbeat_epoch=now - stalecheck.HEARTBEAT_STALE_AFTER_S - 5)
        self.assertTrue(planrun.get_plan_run("plan-a#20260825000001")["stale"])

    def test_list_recent_runs_projection_feeds_the_predicate(self):
        """常驻轮询 feed 的投影必须带判据字段，否则 stale 恒走退化分支。"""
        now = int(time.time())
        self.put_run("plan-a#20260825000001",
                     started_epoch=now - 1200,
                     heartbeat_epoch=now - stalecheck.HEARTBEAT_STALE_AFTER_S - 5)
        self.put_run("plan-b#20260825000002",
                     started_epoch=now - 1200, heartbeat_epoch=now - 30)
        rows = {r["run_key"]: r for r in planrun.list_recent_runs()}
        self.assertTrue(rows["plan-a#20260825000001"]["stale"])
        self.assertFalse(rows["plan-b#20260825000002"]["stale"])

    def test_reading_never_writes_anything_back(self):
        """stale 是读时判定：读三条路各走一遍，库里的字节一个不变。"""
        now = int(time.time())
        self.put_run("plan-a#20260825000001",
                     started_epoch=now - stalecheck.CEILING_S - 60)
        before = copy.deepcopy(self.raw("plan-a#20260825000001"))
        planrun.list_plan_runs("plan-a")
        planrun.get_plan_run("plan-a#20260825000001")
        planrun.list_recent_runs()
        after = self.raw("plan-a#20260825000001")
        self.assertEqual(before, after, "读侧把判定写回库里了")
        self.assertNotIn("stale", after)


class Reaper(Fixture):
    """reap_stale_runs：只收敛上线后的新陈旧记录，条件写、幂等、有界。"""

    def stale_started(self) -> int:
        return NOW - stalecheck.CEILING_S - 3600  # 超天花板，仍 >= FLOOR

    def test_stale_post_floor_run_converges_to_error(self):
        started = self.stale_started()
        self.put_run("plan-a#20260825000001", started_epoch=started)
        out = planrun.reap_stale_runs(now=NOW)
        self.assertEqual(out["reaped"], ["plan-a#20260825000001"])
        row = planrun.get_plan_run("plan-a#20260825000001")
        self.assertEqual(row["status"], "error")
        self.assertIn("心跳超时判定", row["error"])
        self.assertIn("未收敛", row["error"])  # 用户能区分「平台没收尾」与「Agent 跑挂了」

    def test_pre_floor_zombie_is_never_touched(self):
        """存量僵尸（上线前开跑）：哪怕早就超天花板也不改判 ——
        用户常设指令「旧数据不修」，动它们必须另问用户（档案 ⛔ 段）。"""
        self.put_run("plan-old#20260820000000", started_epoch=FLOOR - 86400)
        out = planrun.reap_stale_runs(now=NOW)
        self.assertEqual(out["reaped"], [])
        after = self.raw("plan-old#20260820000000")
        self.assertEqual(after["status"], "running")
        self.assertNotIn("error", after)

    def test_fresh_running_run_is_left_alone(self):
        self.put_run("plan-a#20260825000001", started_epoch=NOW - 120)
        # 心跳新鲜的长跑 run 同样不许碰（预估早过了也不行：一级话语权）
        self.put_run("plan-b#20260825000002", started_epoch=NOW - 2 * 3600,
                     heartbeat_epoch=NOW - 30, estimated_duration_s=60)
        out = planrun.reap_stale_runs(now=NOW)
        self.assertEqual(out["reaped"], [])
        self.assertEqual(self.raw("plan-a#20260825000001")["status"], "running")
        self.assertEqual(self.raw("plan-b#20260825000002")["status"], "running")

    def test_missed_heartbeats_reap_without_waiting_for_the_ceiling(self):
        self.put_run("plan-a#20260825000001", started_epoch=NOW - 1200,
                     heartbeat_epoch=NOW - stalecheck.HEARTBEAT_STALE_AFTER_S - 5)
        out = planrun.reap_stale_runs(now=NOW)
        self.assertEqual(out["reaped"], ["plan-a#20260825000001"])

    def test_reaping_preserves_what_the_money_already_bought(self):
        """改判只补终态与原因：预估/开始时间/已有环节摘要一个不清（档案验收项）。"""
        started = self.stale_started()
        summaries = '[{"type": "observe", "status": "completed", "sessions": 3}]'
        self.put_run("plan-a#20260825000001", started_epoch=started,
                     estimated_duration_s=600, stage_summaries=summaries,
                     estimated_cost_usd="1.23")
        planrun.reap_stale_runs(now=NOW)
        after = self.raw("plan-a#20260825000001")
        self.assertEqual(int(after["started_epoch"]), started)
        self.assertEqual(int(after["estimated_duration_s"]), 600)
        self.assertEqual(after["estimated_cost_usd"], "1.23")
        self.assertEqual(after["stage_summaries"], summaries)
        self.assertEqual(int(after["finished_epoch"]), NOW)
        self.assertEqual(int(after["duration_s"]), NOW - started)

    def test_second_sweep_is_a_no_op(self):
        """幂等：连扫两次，第二次零写入、状态不抖（finished_epoch 不被顶掉）。"""
        self.put_run("plan-a#20260825000001", started_epoch=self.stale_started())
        planrun.reap_stale_runs(now=NOW)
        out2 = planrun.reap_stale_runs(now=NOW + 600)
        self.assertEqual(out2["reaped"], [])
        self.assertEqual(out2["lost_race"], 0)
        self.assertEqual(int(self.raw("plan-a#20260825000001")["finished_epoch"]), NOW)

    def test_real_terminal_state_wins_the_race(self):
        """先落终态再 reap → 条件写放手，绝不把真终态打回改判 error。"""
        self.put_run("plan-a#20260825000001", status="completed",
                     started_epoch=self.stale_started(), score="0.9",
                     finished_at="2026-08-25 11:00 UTC")
        before = copy.deepcopy(self.raw("plan-a#20260825000001"))
        # 扫描层：filter 直接排除终态
        self.assertEqual(planrun.reap_stale_runs(now=NOW)["reaped"], [])
        # 写入层：哪怕扫描时它还是 running、写入前一瞬落了终态（赛跑窗口），
        # ConditionExpression 也要挡住 —— 直接对终态项调条件写验证。
        self.assertFalse(planrun._reap_write(
            "plan-a#20260825000001", before, NOW))
        self.assertEqual(self.raw("plan-a#20260825000001"), before)

    def test_scan_is_bounded(self):
        """读取上界：检视条数压在 REAPER_SCAN_CAP 之内，报告 truncated。"""
        for i in range(6):
            self.put_run(f"plan-{i:02d}#20260825000001",
                         started_epoch=self.stale_started())
        with mock.patch.object(planrun, "REAPER_SCAN_CAP", 3):
            out = planrun.reap_stale_runs(now=NOW)
        self.assertTrue(out["truncated"])
        self.assertLessEqual(out["examined"], 3)
        self.assertLessEqual(len(out["reaped"]), 3)

    def test_reaped_row_wears_the_existing_error_form(self):
        """同刑：与 _converge_interrupted（进程存活的中断收敛）读出同一副形态 ——
        status/error/finished_* 齐、score 与 s3_key 都是 None、不伪造数字。"""
        started = self.stale_started()
        self.put_run("plan-a#20260825000001", started_epoch=started)
        planrun.reap_stale_runs(now=NOW)
        plan = {"plan_id": "plan-b", "name": "线上评估周巡检",
                "agent_name": "support-bot"}
        planrun._converge_interrupted(
            plan, "plan-b#20260825000002", "manual", "2026-08-25 10:00 UTC",
            started, [], "CancelledError")
        reaped = planrun.get_plan_run("plan-a#20260825000001")
        converged = planrun.get_plan_run("plan-b#20260825000002")
        self.assertEqual(set(reaped), set(converged), "两条 error 终态键集合不同")
        for row in (reaped, converged):
            self.assertEqual(row["status"], "error")
            self.assertTrue(row["error"])
            self.assertTrue(row["finished_at"])
            self.assertIsInstance(row["finished_epoch"], int)
            self.assertIsInstance(row["duration_s"], int)
            self.assertIsNone(row["score"])
            self.assertIsNone(row["s3_key"])
            self.assertFalse(row["stale"])  # 已收敛 → 不再陈旧


class DispatchGuard(unittest.TestCase):
    """main.py 的 action 分发行在位（触发形态照 plansched 的 Scheduler 直调先例；
    真建 schedule 的 CDK/CLI 动作在部署侧，不在本批）。"""

    src = (Path(__file__).resolve().parent.parent / "app" / "main.py").read_text()

    def test_reap_action_is_dispatched(self):
        self.assertIn('action == "reap_stale_runs"', self.src)
        self.assertIn("planrun.reap_stale_runs()", self.src)


if __name__ == "__main__":
    unittest.main()
