"""运行中的 run 必须在历史里看得见（P1：2026-08-24 用户实测）。

现象：用户跑线上评估，运行**进行中**打开「运行历史」是空的（0 条）；他之前那次
被中断的 run 也无影无踪。查 DDB：该方案的 PLANRUN 记录**零条**。

根因：`execute_plan_run` 只在全部环节跑完后调一次 `_persist`。于是
  · 运行进行中 → 没有任何记录 → 历史表空 → 看起来像坏了
  · 中断 / 崩溃的 run → **永远**没有记录 → 钱花了却查无此事
这正是 `record_skipped_run` 注释里要防的「悄无声息看起来像坏了」，
但漏了 crashed / in-flight 这一族。

修法：开跑时先用同一个 run_key put 一条 status="running" 的最小记录，结束时
`_persist` 整条覆盖（**不做 update**，一次覆盖写天然收敛）。

本测试用 moto 的真 DynamoDB，验的是「记录在库里」这件事本身，不打桩 put_item。
不碰真表 / 真 agent / 真 LLM。
运行：python3 -m pytest tests/test_planrun_running_marker.py -q
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

TABLE = "eval-catalog-test"
REGION = "us-west-2"

PLAN = {
    "plan_id": "plan-1297bb07bc31",   # 用户那条真方案 id（现场即测例）
    "name": "线上评估周巡检",
    "agent_name": "support-bot",
    "stages": [{"type": "observe", "evaluators": ["helpfulness"], "metrics": []}],
}
AGENT = {"agent_name": "support-bot", "agent_arn": "arn:aws:bedrock:x:y:runtime/z"}


class RunningMarker(unittest.TestCase):
    def setUp(self):
        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)
        ddb = boto3.resource("dynamodb", region_name=REGION)
        self.table = ddb.create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST")

        import catalog
        import planrun
        self.planrun = planrun
        p = mock.patch.object(catalog, "get_table", return_value=self.table)
        p.start()
        self.addCleanup(p.stop)

    # ---- 驱动 ----

    def _run(self, stage_side_effect=None, synthesis=None):
        """跑一次 execute_plan_run，环节执行体打桩（不碰 LLM/trace/agent）。

        stage_side_effect 抛异常 = 模拟环节内部崩溃；直接让 execute_plan_run
        整体抛 = 模拟运行被中断（Lambda 超时/链路断）。
        """
        events = []

        async def emit(ev):
            events.append(ev)

        async def fake_observe(stage, agent, judge_model, emit_, stage_no=0):
            if stage_side_effect:
                raise stage_side_effect
            return {"type": "observe", "status": "completed", "sessions": 2,
                    "summary": {}, "overall_mean": 0.83, "metrics": None,
                    "session_details": [], "analysis": None,
                    "evaluators": ["helpfulness"], "metric_keys": []}

        with mock.patch.object(self.planrun, "_run_observe_stage", fake_observe), \
                mock.patch.object(self.planrun, "_generate_synthesis",
                                  new=mock.AsyncMock(return_value=synthesis)), \
                mock.patch.object(self.planrun, "latest_run_summary", return_value=None):
            report = asyncio.run(self.planrun.execute_plan_run(
                PLAN, AGENT, "judge-model", "manual", emit))
        return report, events

    def rows(self):
        return self.planrun.list_plan_runs(PLAN["plan_id"])

    # ---- 测试 ----

    def test_running_row_exists_before_the_run_finishes(self):
        """开跑就有一行：环节还没跑完时历史表就该有记录（现场就是这里空的）。"""
        seen = {}

        async def peek_stage(stage, agent, judge_model, emit_, stage_no=0):
            # 环节执行中间去查历史：这是用户「运行进行中打开运行历史」的时刻
            seen["rows"] = self.rows()
            return {"type": "observe", "status": "completed", "sessions": 1,
                    "summary": {}, "overall_mean": 0.9, "metrics": None,
                    "session_details": [], "analysis": None,
                    "evaluators": ["helpfulness"], "metric_keys": []}

        async def emit(ev):
            pass

        with mock.patch.object(self.planrun, "_run_observe_stage", peek_stage), \
                mock.patch.object(self.planrun, "_generate_synthesis",
                                  new=mock.AsyncMock(return_value=None)), \
                mock.patch.object(self.planrun, "latest_run_summary", return_value=None):
            asyncio.run(self.planrun.execute_plan_run(
                PLAN, AGENT, "judge-model", "manual", emit))

        self.assertEqual(len(seen["rows"]), 1, "运行进行中历史表仍然是空的")
        row = seen["rows"][0]
        self.assertEqual(row["status"], "running")
        self.assertEqual(row["plan_id"], PLAN["plan_id"])
        self.assertEqual(row["plan_name"], PLAN["name"])
        self.assertEqual(row["agent_name"], PLAN["agent_name"])
        self.assertEqual(row["triggered_by"], "manual")
        self.assertTrue(row["started_at"])
        self.assertIsNotNone(row["started_epoch"])

    def test_running_row_fabricates_no_terminal_numbers(self):
        """running 行不许伪造终态：无分数、无耗时、无结束时间、无环节摘要。"""
        seen = {}

        async def peek_stage(stage, agent, judge_model, emit_, stage_no=0):
            seen["row"] = self.rows()[0]
            return {"type": "observe", "status": "completed", "sessions": 1,
                    "summary": {}, "overall_mean": 0.9, "metrics": None,
                    "session_details": [], "analysis": None,
                    "evaluators": ["helpfulness"], "metric_keys": []}

        async def emit(ev):
            pass

        with mock.patch.object(self.planrun, "_run_observe_stage", peek_stage), \
                mock.patch.object(self.planrun, "_generate_synthesis",
                                  new=mock.AsyncMock(return_value=None)), \
                mock.patch.object(self.planrun, "latest_run_summary", return_value=None):
            asyncio.run(self.planrun.execute_plan_run(
                PLAN, AGENT, "judge-model", "manual", emit))

        row = seen["row"]
        # _run_from_item 要能容纳缺字段（不崩、不编数字）
        self.assertIsNone(row["score"])
        self.assertIsNone(row["duration_s"])
        self.assertIsNone(row["finished_epoch"])
        self.assertEqual(row["finished_at"], "")
        self.assertIsNone(row["total_cost_usd"])
        self.assertEqual(row["stage_summaries"], [])
        self.assertEqual(row["overview"], {})
        self.assertIsNone(row["s3_key"])

    def test_terminal_persist_overwrites_the_same_run_key(self):
        """结束时整条覆盖同一个 run_key：**不是**两行，且终态字段齐了。"""
        report, _ = self._run()
        rows = self.rows()
        self.assertEqual(len(rows), 1, "running 行没被覆盖，历史里出现了两行")
        row = rows[0]
        self.assertEqual(row["run_key"], report["run_key"])
        self.assertEqual(row["status"], "completed")
        self.assertTrue(row["finished_at"])
        self.assertIsNotNone(row["duration_s"])
        # observe 环节的 overall_mean 进了顶层 score（「有分数才算成功」口径）
        self.assertEqual(row["score"], 0.83)
        self.assertEqual(len(row["stage_summaries"]), 1)

    def test_crashed_stage_still_leaves_a_completed_row(self):
        """环节内部崩溃：既有行为是收进 stage summary 并照常落终态记录。"""
        report, _ = self._run(stage_side_effect=RuntimeError("agent unreachable"))
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "completed")
        self.assertEqual(rows[0]["stage_summaries"][0]["status"], "error")
        self.assertIsNone(rows[0]["score"])  # 没有分数就不许伪造
        self.assertEqual(report["stages"][0]["status"], "error")

    def test_interrupted_run_keeps_a_converged_row(self):
        """运行被中断（Lambda 超时/链路断）：记录**留在库里**，不再是「钱花了却
        查无此事」。

        2026-08-24 更新（BH-004 后半）：此前这里断言的是「行仍是 running」——那
        正是缺陷本身（marker 在异常路径上永不收敛，PlanDetailPage 的「最终状态以
        运行历史为准」指向的就是它）。现在 execute_plan_run 的 finally 会把它收敛
        成 error 终态。本例保留原意「记录必须在」，并加上收敛断言；收敛细节
        （不伪造数字、保留已完成环节）在 tests/test_planrun_terminal_persist.py。
        """
        async def emit(ev):
            pass

        async def boom(stage, agent, judge_model, emit_, stage_no=0):
            # 环节里就把整个协程掐掉（execute_plan_run 的 try 只包环节体，
            # 这里用 BaseException 家族的 CancelledError 模拟真中断）
            raise asyncio.CancelledError()

        with mock.patch.object(self.planrun, "_run_observe_stage", boom), \
                mock.patch.object(self.planrun, "latest_run_summary", return_value=None):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(self.planrun.execute_plan_run(
                    PLAN, AGENT, "judge-model", "manual", emit))

        rows = self.rows()
        self.assertEqual(len(rows), 1, "被中断的 run 仍然查无此事")
        self.assertEqual(rows[0]["status"], "error", "被中断的 run 永远停在 running")
        self.assertTrue(rows[0]["error"])

    def test_running_row_is_not_used_as_the_previous_run_baseline(self):
        """running 行不许当上一次运行的对比基线（会拿一条没分数的行去 diff）。"""
        self.table.put_item(Item={
            "pk": "PLANRUN", "sk": f"{PLAN['plan_id']}#20260824120000",
            "plan_id": PLAN["plan_id"], "plan_name": PLAN["name"],
            "agent_name": PLAN["agent_name"], "status": "running",
            "triggered_by": "manual", "started_at": "2026-08-24 12:00 UTC",
            "started_epoch": 1787054400,
            "stage_summaries": "[]", "overview": "{}", "s3_key": "", "proposals": "[]",
        })
        self.assertIsNone(self.planrun.latest_run_summary(PLAN["plan_id"]))

    def test_marker_failure_does_not_kill_the_run(self):
        """落库失败不拖垮 run：宁可少一条历史行，也不能因为记账把已付费的运行掐掉。"""
        real_put = self.table.put_item
        calls = {"n": 0}

        def flaky_put(**kw):
            calls["n"] += 1
            if calls["n"] == 1:  # 只让开跑那条 marker 失败
                raise RuntimeError("ProvisionedThroughputExceededException")
            return real_put(**kw)

        with mock.patch.object(self.table, "put_item", side_effect=flaky_put):
            report, _ = self._run()
        # run 照常跑完并交出终帧（execute_plan_run 的返回就是 plan_run_report 体）
        self.assertEqual(report["run_key"].split("#")[0], PLAN["plan_id"])
        self.assertEqual(report["stages"][0]["status"], "completed")
        # 终态那次写照常成功 —— 少的只是「运行中那一瞬间的可见性」
        self.assertEqual(self.rows()[0]["status"], "completed")


class SourceGuards(unittest.TestCase):
    src = (Path(__file__).resolve().parent.parent / "app" / "planrun.py").read_text()

    def test_marker_is_written_before_the_stage_loop(self):
        """顺序护栏：marker 必须在 `for i, stage in ...` **之前**写。
        挪到后面就退回「第一个环节跑完前历史仍然是空的」。

        锚点是 marker 那次 `_planrun_item(...)` 调用（J4 起四个写入点共用这个
        构造函数，字段集不变 —— 见 tests/test_r2_core_planrun_item.py）。"""
        marker_at = self.src.index('plan, run_key, "running", triggered_by, started')
        loop_at = self.src.index('for i, stage in enumerate(plan["stages"], 1):')
        self.assertLess(marker_at, loop_at)

    def test_marker_uses_put_not_update(self):
        """一次覆盖写：不引入 update_item，避免终态与 running 残留字段混在一条里。"""
        head = self.src[self.src.index("async def execute_plan_run"):
                        self.src.index("def _stage_summary")
                        if "def _stage_summary" in self.src else len(self.src)]
        self.assertNotIn("update_item", head)


if __name__ == "__main__":
    unittest.main()
