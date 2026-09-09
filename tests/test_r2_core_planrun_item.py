"""PLANRUN 摘要项只有一个骨架构造点，四个写入点的字段集逐处不变（J4）。

四个写入点（开跑 running marker / 中断收敛 / 终态 _persist / 跳过记录）此前各自
手打 pk/sk + plan 身份 + status/triggered_by + 四个空 blob 缺省。它们是
`_run_from_item` 的读取契约：某一处漏写一个空 blob，读出来虽然不崩（缺字段被容纳
成 []/{}/None），但**前端判 run 终态的原料就是 stage_summaries**（UI-025）。

本文件把四处的字段集**逐个锁死**：收敛只许改「在哪拼」，不许改「拼出什么」。
终态设计（一次覆盖写、绝不伪造数字）由既有测试当保护网
（test_planrun_running_marker / test_planrun_terminal_persist / test_stop_plan_run）。

Run: python3 -m pytest tests/test_r2_core_planrun_item.py -q
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

APP = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(APP))

import planrun  # noqa: E402
import runstore  # noqa: E402

PLAN = {"plan_id": "plan-1297bb07bc31", "name": "线上评估周巡检",
        "agent_name": "support-bot",
        "stages": [{"type": "observe", "evaluators": ["helpfulness"], "metrics": []}]}
AGENT = {"agent_name": "support-bot", "runtime_arn": "arn:aws:x"}

# 每条 PLANRUN item 都有的骨架（键，不含各写入点自己那段）
SKELETON = {"pk", "sk", "plan_id", "plan_name", "agent_name",
            "status", "triggered_by", "started_at",
            "stage_summaries", "overview", "s3_key", "proposals"}


class TheSkeleton(unittest.TestCase):
    def test_identity_and_empty_blob_defaults(self):
        item = planrun._planrun_item(PLAN, "k", "running", "manual", "2026-08-24 09:08 UTC")
        self.assertEqual(set(item), SKELETON)
        self.assertEqual(item["pk"], "PLANRUN")
        self.assertEqual(item["sk"], "k")
        self.assertEqual(item["plan_id"], PLAN["plan_id"])
        self.assertEqual(item["plan_name"], PLAN["name"])
        self.assertEqual(item["agent_name"], PLAN["agent_name"])
        self.assertEqual(
            {k: item[k] for k in planrun._ITEM_EMPTY_BLOBS},
            {"stage_summaries": "[]", "overview": "{}", "s3_key": "", "proposals": "[]"})

    def test_extra_overrides_the_defaults(self):
        item = planrun._planrun_item(PLAN, "k", "completed", "schedule", "t",
                                     overview='{"stage_lines": []}', score="0.9")
        self.assertEqual(item["overview"], '{"stage_lines": []}')
        self.assertEqual(item["score"], "0.9")
        self.assertEqual(item["stage_summaries"], "[]")  # 没覆盖的仍是缺省

    def test_only_one_place_builds_the_item(self):
        """`Key={...}`（读/更新的主键）不算 —— 那是查一条，不是拼一条。"""
        lines = [ln for ln in (APP / "planrun.py").read_text().splitlines()
                 if '"pk": "PLANRUN"' in ln and "Key={" not in ln]
        self.assertEqual(len(lines), 1, f"又出现了第二处手拼：{lines}")


class Fixture(unittest.TestCase):
    """put_item 只捕获，不落库：本文件只关心「写了哪些字段」。"""

    def setUp(self):
        self.items = []
        self.table = mock.MagicMock()
        self.table.put_item.side_effect = lambda Item: self.items.append(Item)
        p = mock.patch.object(planrun, "_table", return_value=self.table)
        p.start()
        self.addCleanup(p.stop)


class FourWriters(Fixture):
    def _execute(self):
        async def emit(_ev):
            pass

        async def fake_observe(stage, agent, judge_model, emit_, stage_no=0):
            return {"type": "observe", "status": "completed", "sessions": 2,
                    "summary": {}, "overall_mean": 0.83, "metrics": None,
                    "session_details": [], "analysis": None,
                    "evaluators": ["helpfulness"], "metric_keys": []}

        with mock.patch.object(planrun, "_run_observe_stage", fake_observe), \
                mock.patch.object(planrun, "_generate_synthesis",
                                  new=mock.AsyncMock(return_value=None)), \
                mock.patch.object(planrun, "latest_run_summary", return_value=None), \
                mock.patch.object(planrun, "stop_requested", return_value=False), \
                mock.patch.object(runstore, "_s3", return_value=mock.MagicMock()), \
                mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": "b"}):
            return asyncio.run(planrun.execute_plan_run(
                PLAN, AGENT, "judge-model", "manual", emit))

    def test_running_marker_fields(self):
        self._execute()
        marker = self.items[0]
        # estimated_duration_s：UI-029 批 1 起 write-at-start 一次写入（陈旧判定
        # 二级判据原料）。只属于 running 期间：终态整条覆盖写不带它（下个测试的
        # 精确字段集就是保证），心跳/进度/检查点指针走条件写、也不在这条里。
        self.assertEqual(set(marker), SKELETON | {"started_epoch",
                                                  "estimated_duration_s"})
        self.assertEqual(marker["status"], "running")
        self.assertEqual(marker["triggered_by"], "manual")

    def test_terminal_persist_fields(self):
        report = self._execute()
        terminal = self.items[-1]
        self.assertEqual(
            set(terminal),
            SKELETON | {"started_epoch", "finished_at", "finished_epoch",
                        "duration_s", "total_cost_usd", "score"})
        self.assertEqual(terminal["sk"], marker_sk := self.items[0]["sk"])
        self.assertEqual(terminal["sk"], report["run_key"], marker_sk)
        self.assertEqual(terminal["status"], "completed")
        self.assertEqual(terminal["score"], "0.83")
        self.assertEqual(terminal["s3_key"], f"reports/{PLAN['plan_id']}/"
                         f"{report['run_key'].split('#')[1]}.json")

    def test_interrupted_convergence_fields(self):
        planrun._converge_interrupted(PLAN, "k#ts", "manual", "2026-08-24 09:08 UTC",
                                      1787000880, [], "CancelledError")
        item = self.items[0]
        self.assertEqual(
            set(item),
            SKELETON | {"error", "started_epoch", "finished_at", "finished_epoch",
                        "duration_s", "total_cost_usd"})
        self.assertEqual(item["status"], "error")
        self.assertIn("运行未正常结束", item["error"])
        self.assertEqual(item["s3_key"], "")      # 没有报告就不许指一个不存在的 key

    def test_skipped_record_fields(self):
        planrun.record_skipped_run(PLAN, "预算超限", {"estimated_cost_usd": 1.5})
        item = self.items[0]
        self.assertEqual(set(item),
                         SKELETON | {"skip_reason", "started_epoch",
                                     "estimated_cost_usd"})
        self.assertEqual(item["status"], "skipped")
        self.assertEqual(item["triggered_by"], "schedule")
        self.assertEqual(item["skip_reason"], "预算超限")
        self.assertEqual(item["estimated_cost_usd"], "1.5")

    def test_skipped_without_an_estimate_stays_empty_string(self):
        planrun.record_skipped_run(PLAN, "agent 不在册")
        self.assertEqual(self.items[0]["estimated_cost_usd"], "")

    def test_every_writer_carries_the_read_contract(self):
        """四路都带 stage_summaries —— 缺它前端判不出「部分失败」（UI-025）。"""
        self._execute()
        planrun._converge_interrupted(PLAN, "k#ts", "manual", "t", 1, [], None)
        planrun.record_skipped_run(PLAN, "r")
        self.assertGreaterEqual(len(self.items), 4)
        for item in self.items:
            with self.subTest(status=item["status"]):
                for key in planrun._ITEM_EMPTY_BLOBS:
                    self.assertIn(key, item)


if __name__ == "__main__":
    unittest.main()
