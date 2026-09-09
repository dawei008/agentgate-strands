"""UI-029 批 1：run_plan 持久化异步作业模型的后端半边（存活契约 + 增量落库）。

规格 `.scratch/ui029-spec/SPEC.md` §1/§2/§4/§5。必要性不是「15 分钟死线」——
执行体是 AgentCore Runtime（8h 上限），UiProxy 900s 只断可见性；本批消灭的是
① 存活是观测运气不是契约（SDK /ping 只在注册过 async task 时报 HealthyBusy，
   app/ 从不调它 → 平台按 idle 理论可回收）；
② 残余死亡路径（8h 上限/崩溃/发版）下 run 的中途成果零检查点全丢；
③ 断流后前端拿不到 run_key，无从轮询（run_key 此前只在终态 plan_run_report 里回）。

设计不变量（本文件逐条钉住）：
  · **中途写完全复制 request_stop 先例**：只加属性 + ConditionExpression
    status=running；条件失败静默放弃（终态已到），且绝不因此创建半条新 item。
  · **终态整条 put_item 不携带中途字段**（heartbeat_epoch / progress /
    checkpoint_s3_key / estimated_duration_s）→ 覆盖即清场，终态形状与今天
    完全一致，读侧零改动（§5；字段集精确锁在 test_r2_core_planrun_item）。
  · **检查点 S3 先落、成功才写 DDB 指针**（照 runstore.archive_run 双写序）；
    S3 失败 → 指针不写 → run 照常完成。
  · **心跳循环随 run 结束/异常必停**，不留孤儿 task。
  · **plan_run_started 带 run_key**，且发出时 write-at-start 的 running 行已在库。
  · add_async_task/complete_async_task 严格配平：异常路径 complete 也必须被调。

moto 的真 DynamoDB + 打桩 S3；不碰真表 / 真 agent / 真 LLM / 不发起任何真 run_plan。
运行：python3 -m pytest tests/test_planrun_async_contract.py -q
"""

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

TABLE = "eval-catalog-test"
BUCKET = "eval-artifacts-test"
REGION = "us-west-2"

PLAN = {
    "plan_id": "plan-1297bb07bc31",
    "name": "线上评估周巡检",
    "agent_name": "support-bot",
    "stages": [{"type": "observe", "evaluators": ["helpfulness"], "metrics": [],
                "max_sessions": 10}],
}
PLAN_2STAGE = {**PLAN, "stages": PLAN["stages"] * 2}
AGENT = {"agent_name": "support-bot", "agent_arn": "arn:aws:bedrock:x:y:runtime/z"}


def observe_result(mean: float = 0.83, cost: float = 0.12) -> dict:
    return {"type": "observe", "status": "completed", "sessions": 2,
            "summary": {}, "overall_mean": mean, "metrics": None,
            "session_details": [], "analysis": None, "actual_cost_usd": cost,
            "evaluators": ["helpfulness"], "metric_keys": []}


class DdbFixture(unittest.TestCase):
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

        import catalog
        import planrun
        self.planrun = planrun
        for patcher in (
                mock.patch.object(catalog, "get_table", return_value=self.table),
                mock.patch.object(catalog, "TABLE_NAME", TABLE),
                mock.patch.dict(os.environ, {"ARTIFACTS_BUCKET": BUCKET})):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.s3 = mock.MagicMock()
        s = mock.patch.object(planrun.runstore, "_s3", return_value=self.s3)
        s.start()
        self.addCleanup(s.stop)
        planrun._stop_polls.clear()
        self.addCleanup(planrun._stop_polls.clear)

    # ---- 夹具 ----

    def item(self, run_key: str) -> dict:
        return self.table.get_item(
            Key={"pk": "PLANRUN", "sk": run_key}).get("Item") or {}

    def rows(self):
        return self.planrun.list_plan_runs(PLAN["plan_id"])

    def run_key_of(self) -> str:
        rows = self.rows()
        self.assertTrue(rows, "开跑的 running 记录不在库里，前提不成立")
        return rows[0]["run_key"]

    def execute(self, plan=PLAN, stage=None, estimate=None, emit=None):
        """跑一次 execute_plan_run，环节执行体打桩（不碰 LLM/trace/agent）。"""
        events = []

        async def default_emit(ev):
            events.append(ev)

        async def default_stage(stage_, agent, judge_model, emit_, stage_no=0):
            return observe_result()

        with mock.patch.object(self.planrun, "_run_observe_stage",
                               stage or default_stage), \
                mock.patch.object(self.planrun, "_generate_synthesis",
                                  new=mock.AsyncMock(return_value=None)), \
                mock.patch.object(self.planrun, "latest_run_summary",
                                  return_value=None):
            report = asyncio.run(self.planrun.execute_plan_run(
                plan, AGENT, "judge-model", "manual", emit or default_emit,
                estimate=estimate))
        return report, events


# ------------------------------------------------------------------ 心跳落库

class Heartbeat(DdbFixture):
    def test_heartbeat_lands_while_running_and_terminal_clears_it(self):
        """执行期间 heartbeat_epoch 在库；终态整条覆盖后一个中途字段都不剩。"""
        seen = {}

        async def slow_stage(stage, agent, judge_model, emit_, stage_no=0):
            await asyncio.sleep(0.3)  # 放几拍心跳进来
            seen["item"] = self.item(self.run_key_of())
            return observe_result()

        with mock.patch.object(self.planrun, "_HEARTBEAT_INTERVAL_S", 0.05):
            self.execute(stage=slow_stage)

        self.assertIn("heartbeat_epoch", seen["item"],
                      "执行 0.3s（间隔 0.05s）后心跳仍未落库")
        self.assertGreater(int(seen["item"]["heartbeat_epoch"]), 0)
        terminal = self.item(self.run_key_of())
        self.assertEqual(terminal["status"], "completed")
        for field in ("heartbeat_epoch", "progress", "checkpoint_s3_key"):
            self.assertNotIn(field, terminal,
                             f"终态记录残留中途字段 {field}（§5 覆盖即清场被破坏）")

    def test_heartbeat_gives_up_silently_once_terminal(self):
        """终态已到：条件失败静默放弃，绝不给终态记录挂心跳。"""
        run_key = f"{PLAN['plan_id']}#20260825090000"
        self.table.put_item(Item={"pk": "PLANRUN", "sk": run_key,
                                  "status": "completed"})
        self.planrun._write_heartbeat(run_key)  # 不许抛
        self.assertNotIn("heartbeat_epoch", self.item(run_key))

    def test_heartbeat_never_creates_a_row(self):
        """running marker 没写成（开跑落库失败被吞）时，心跳条件写不许无中生有
        造出一条骨架不全的 item。"""
        self.planrun._write_heartbeat(f"{PLAN['plan_id']}#20260825091500")
        self.assertEqual(self.rows(), [])

    def test_heartbeat_task_does_not_outlive_the_run(self):
        """run 结束（正常路径）后事件循环上不留孤儿心跳 task。"""
        async def go():
            async def emit(_ev):
                pass

            async def stage(stage_, agent, judge_model, emit_, stage_no=0):
                return observe_result()

            with mock.patch.object(self.planrun, "_run_observe_stage", stage), \
                    mock.patch.object(self.planrun, "_generate_synthesis",
                                      new=mock.AsyncMock(return_value=None)), \
                    mock.patch.object(self.planrun, "latest_run_summary",
                                      return_value=None):
                await self.planrun.execute_plan_run(
                    PLAN, AGENT, "judge-model", "manual", emit)
            return [t for t in asyncio.all_tasks()
                    if t is not asyncio.current_task() and not t.done()]

        self.assertEqual(asyncio.run(go()), [])

    def test_heartbeat_task_stops_on_the_exception_path_too(self):
        """execute_plan_run 整体炸掉（中断收敛路径）：心跳 task 一样必须停。"""
        async def go():
            async def emit(_ev):
                pass

            async def boom(stage_, agent, judge_model, emit_, stage_no=0):
                raise BaseException("simulated interrupt")  # noqa: TRY002

            with mock.patch.object(self.planrun, "_run_observe_stage", boom), \
                    mock.patch.object(self.planrun, "latest_run_summary",
                                      return_value=None):
                try:
                    await self.planrun.execute_plan_run(
                        PLAN, AGENT, "judge-model", "manual", emit)
                except BaseException:
                    pass
            return [t for t in asyncio.all_tasks()
                    if t is not asyncio.current_task() and not t.done()]

        self.assertEqual(asyncio.run(go()), [])
        # 中断收敛路径同样不残留中途字段
        item = self.item(self.run_key_of())
        self.assertEqual(item["status"], "error")
        for field in ("heartbeat_epoch", "progress", "checkpoint_s3_key"):
            self.assertNotIn(field, item)


# -------------------------------------------------------- 逐环节检查点 + 进度

class StageCheckpoints(DdbFixture):
    def test_checkpoint_lands_in_s3_then_pointer_and_progress_in_ddb(self):
        """环节边界：S3 对象先落（checkpoints/<plan_id>/<ts>/stage-<i>.json，
        累计 stage_results 全量），成功后 DDB 指针 + progress 才更新。"""
        seen = {}

        async def stage(stage_, agent, judge_model, emit_, stage_no=0):
            if seen:  # 第 2 个环节执行中：查看第 1 个环节留下的检查点
                seen["item"] = self.item(self.run_key_of())
            seen.setdefault("count", 0)
            seen["count"] = seen["count"] + 1
            return observe_result(mean=0.9)

        report, _ = self.execute(plan=PLAN_2STAGE, stage=stage)

        ts = report["run_key"].split("#")[1]
        want_key = f"checkpoints/{PLAN['plan_id']}/{ts}/stage-1.json"
        put_keys = [c.kwargs["Key"] for c in self.s3.put_object.call_args_list]
        self.assertIn(want_key, put_keys, f"检查点对象没写进 S3：{put_keys}")

        item = seen["item"]
        self.assertEqual(item.get("checkpoint_s3_key"), want_key)
        progress = json.loads(item["progress"])
        self.assertEqual(progress["stages_done"], 1)
        self.assertEqual(progress["stages_total"], 2)
        self.assertEqual(progress["stage"], "observe")
        self.assertEqual(len(progress["stage_summaries_partial"]), 1)
        self.assertEqual(progress["stage_summaries_partial"][0]["overall_mean"], 0.9)

        body = json.loads(next(
            c.kwargs["Body"] for c in self.s3.put_object.call_args_list
            if c.kwargs["Key"] == want_key))
        self.assertEqual(body["run_key"], report["run_key"])
        self.assertEqual(len(body["stage_results"]), 1, "检查点必须是累计全量")
        self.assertEqual(body["stage_results"][0]["overall_mean"], 0.9)

    def test_checkpoint_carries_stage_run_ids(self):
        """规格点名的续跑链接缺口：检查点带各环节 run_id（observe 没有 → None），
        批 4 靠它把环节级检查点链接回 RUN/RTRUN 用例级明细。"""
        plan = {**PLAN, "stages": [{"type": "observe", "evaluators": ["h"]},
                                   {"type": "dataset", "dataset": "faq",
                                    "evaluators": ["h"]}]}

        async def fake_dataset(stage_, plan_, agent, judge_model, emit_,
                               stop_check=None):
            return {"type": "dataset", "status": "completed", "run_id": "run-777",
                    "dataset": "faq", "cases": 3, "judged_cases": 3,
                    "pass_rate": 1.0, "blank_cases": 0, "actual_cost_usd": 0.1,
                    "evaluators": ["h"], "report": {"results": [{"results": {}}]}}

        with mock.patch.object(self.planrun, "_run_dataset_stage", fake_dataset):
            report, _ = self.execute(plan=plan)

        ts = report["run_key"].split("#")[1]
        stage2_key = f"checkpoints/{PLAN['plan_id']}/{ts}/stage-2.json"
        body = json.loads(next(
            c.kwargs["Body"] for c in self.s3.put_object.call_args_list
            if c.kwargs["Key"] == stage2_key))
        self.assertEqual(body["stage_run_ids"], [None, "run-777"])

    def test_s3_failure_writes_no_pointer_and_the_run_still_completes(self):
        """S3 先行序：归档失败 → DDB 指针不写（绝不指向不存在的对象）→
        run 照常跑完（记账不许拖垮已付费的运行）。"""
        self.s3.put_object.side_effect = RuntimeError("S3 down")
        seen = {}

        async def stage(stage_, agent, judge_model, emit_, stage_no=0):
            if seen:
                seen["item"] = self.item(self.run_key_of())
            seen.setdefault("first", True)
            return observe_result()

        report, _ = self.execute(plan=PLAN_2STAGE, stage=stage)

        self.assertEqual(report["status"], "completed")
        self.assertNotIn("checkpoint_s3_key", seen["item"],
                         "S3 没写成却写了指针 —— 指向不存在的对象")
        self.assertEqual(self.item(self.run_key_of())["status"], "completed")

    def test_checkpoint_update_gives_up_after_terminal(self):
        """与终态覆盖写的赛跑：条件失败静默放弃，不给终态记录挂中途字段。"""
        run_key = f"{PLAN['plan_id']}#20260825090000"
        self.table.put_item(Item={"pk": "PLANRUN", "sk": run_key,
                                  "status": "completed"})
        self.planrun._write_stage_checkpoint(
            PLAN, run_key, "20260825090000", 1, 1, [observe_result()])
        item = self.item(run_key)
        self.assertNotIn("progress", item)
        self.assertNotIn("checkpoint_s3_key", item)

    def test_stopped_run_terminal_also_clears_midrun_fields(self):
        """停止流程与检查点共存：stopped 终态一样是整条覆盖、一样清场。"""
        async def stage(stage_, agent, judge_model, emit_, stage_no=0):
            self.planrun.request_stop(self.run_key_of())
            return observe_result()

        self.execute(plan=PLAN_2STAGE, stage=stage)
        item = self.item(self.run_key_of())
        self.assertEqual(item["status"], self.planrun.STOP_STATUS)
        for field in ("heartbeat_epoch", "progress", "checkpoint_s3_key",
                      "estimated_duration_s"):
            self.assertNotIn(field, item)


# ------------------------------------------------- plan_run_started 带 run_key

class RunKeyAnnouncement(DdbFixture):
    def test_started_event_carries_run_key_and_fires_after_write_at_start(self):
        """事件仍叫 plan_run_started、多带 run_key/started_epoch；发出那一刻
        write-at-start 的 running 行已经在库（断流即刻可轮询）。"""
        at_announce = {}
        events = []

        async def emit(ev):
            events.append(ev)
            if ev.get("event") == "plan_run_started":
                at_announce["rows"] = self.rows()

        report, _ = self.execute(estimate={"estimated_cost_usd": 0.5}, emit=emit)

        started = [e for e in events if e.get("event") == "plan_run_started"]
        self.assertEqual(len(started), 1, "plan_run_started 必须恰好一条")
        ev = started[0]
        self.assertEqual(ev["run_key"], report["run_key"])
        self.assertIsInstance(ev["started_epoch"], int)
        # 既有字段一个不动（老 UI 只认 stages；estimate 原样透传）
        self.assertEqual(ev["plan_id"], PLAN["plan_id"])
        self.assertEqual(ev["plan_name"], PLAN["name"])
        self.assertEqual(ev["agent"], PLAN["agent_name"])
        self.assertEqual(ev["stages"], ["observe"])
        self.assertEqual(ev["triggered_by"], "manual")
        self.assertEqual(ev["estimate"], {"estimated_cost_usd": 0.5})
        # 发出时 running 行已在库
        self.assertEqual(len(at_announce["rows"]), 1)
        self.assertEqual(at_announce["rows"][0]["status"], "running")
        self.assertEqual(at_announce["rows"][0]["run_key"], report["run_key"])

    def test_started_event_precedes_every_stage_event(self):
        _report, events = self.execute()
        kinds = [e.get("event") for e in events]
        self.assertEqual(kinds[0], "plan_run_started")
        self.assertIn("stage_start", kinds)


# ------------------------------------------------------- estimated_duration_s

class EstimatedDuration(DdbFixture):
    def test_marker_carries_the_regression_estimate(self):
        """write-at-start 一次写入；系数按现网 55 条终态 run 回归写死
        （observe 环节按计划口径 max_sessions 计）。"""
        seen = {}

        async def stage(stage_, agent, judge_model, emit_, stage_no=0):
            seen["item"] = self.item(self.run_key_of())
            return observe_result()

        self.execute(stage=stage)
        want = (self.planrun._DURATION_S_PER_STAGE
                + 10 * self.planrun._DURATION_S_PER_OBSERVE_SESSION)
        self.assertEqual(int(seen["item"]["estimated_duration_s"]), want)
        self.assertEqual(self.planrun.estimate_run_duration_s(PLAN), want)

    def test_estimate_payload_wins_when_it_carries_a_duration(self):
        """来源优先级：estimate 现产出里有时长就用它，不再自算。"""
        seen = {}

        async def stage(stage_, agent, judge_model, emit_, stage_no=0):
            seen["item"] = self.item(self.run_key_of())
            return observe_result()

        self.execute(stage=stage, estimate={"estimated_cost_usd": 0.5,
                                            "estimated_duration_s": 1234})
        self.assertEqual(int(seen["item"]["estimated_duration_s"]), 1234)

    def test_dataset_and_redteam_composition_counts(self):
        """回归/红队环节按计划口径计：数据集用例数、红队用例×策略。"""
        import catalog
        plan = {**PLAN, "stages": [
            {"type": "dataset", "dataset": "faq", "evaluators": ["h"]},
            {"type": "redteam", "cases": [{}, {}], "strategies": ["a", "b", "c"]},
        ]}
        with mock.patch.object(catalog, "get_dataset",
                               return_value={"name": "faq", "cases": [{}] * 10}):
            got = self.planrun.estimate_run_duration_s(plan)
        want = (2 * self.planrun._DURATION_S_PER_STAGE
                + 10 * self.planrun._DURATION_S_PER_DATASET_CASE
                + 6 * self.planrun._DURATION_S_PER_REDTEAM_ATTACK)
        self.assertEqual(got, want)

    def test_no_stages_means_none_not_zero(self):
        """算不出就不写（None）——批 2 判据走退化分支；0 秒是伪造数字。"""
        self.assertIsNone(self.planrun.estimate_run_duration_s(
            {"plan_id": "p", "stages": []}))

    def test_terminal_overwrite_drops_the_estimate(self):
        """终态覆盖写自然清场：estimated_duration_s 只属于 running 期间，
        终态有真 duration_s，形状与今天完全一致（读侧零改动）。"""
        self.execute()
        self.assertNotIn("estimated_duration_s", self.item(self.run_key_of()))


# ------------------------------------------------ 存活契约（main.py 的包裹层）

class LivenessContract(DdbFixture):
    """add_async_task/complete_async_task 包住 run_task：语义 = 向平台声明
    HealthyBusy（SDK app.py:314：有注册任务 → /ping 报 HealthyBusy），消灭
    「断流后被平台按 idle 回收」的不确定性。"""

    def _drive(self, execute_mock):
        import main

        with mock.patch.object(main.plan_mod, "get_plan", return_value=PLAN), \
                mock.patch.object(main.catalog, "cached_agents", return_value={
                    "agents": [{**AGENT, "has_logs": True}]}), \
                mock.patch.object(main.planrun, "estimate_plan_run",
                                  return_value={"estimated_cost_usd": 0.1}), \
                mock.patch.object(main.planrun, "execute_plan_run", execute_mock), \
                mock.patch.object(main.app, "add_async_task",
                                  return_value=99) as add, \
                mock.patch.object(main.app, "complete_async_task") as complete:
            async def go():
                return [ev async for ev in main.invoke(
                    {"action": "run_plan", "plan_id": PLAN["plan_id"],
                     "judge_model": "judge-model"})]
            events = asyncio.run(go())
        return events, add, complete

    @staticmethod
    def _final_report():
        return {"run_key": f"{PLAN['plan_id']}#20260825090000", "s3_key": "k",
                "plan": {k: PLAN[k] for k in ("plan_id", "name", "agent_name",
                                              "stages")},
                "triggered_by": "manual", "started_at": "t0", "finished_at": "t1",
                "started_epoch": 1, "finished_epoch": 2, "duration_s": 1,
                "overview": {}, "plan_synthesis": None, "synthesis_error": None,
                "stages": [], "status": "completed"}

    def test_task_is_registered_and_completed_on_the_happy_path(self):
        events, add, complete = self._drive(
            mock.AsyncMock(return_value=self._final_report()))
        self.assertEqual([e["event"] for e in events][-1], "plan_run_report")
        add.assert_called_once()
        self.assertEqual(add.call_args.args[0], "run_plan")
        complete.assert_called_once_with(99)

    def test_task_is_completed_on_the_exception_path_too(self):
        """异常路径 complete 也必须被调 —— 否则容器永远 HealthyBusy，
        平台再也不把它视作空闲（存活契约变成永动机）。"""
        events, _add, complete = self._drive(
            mock.AsyncMock(side_effect=RuntimeError("boom")))
        self.assertEqual(events[-1]["event"], "error")
        complete.assert_called_once_with(99)

    def test_ping_status_flips_to_healthy_busy_while_the_run_is_alive(self):
        """真 SDK 语义（不打桩 add/complete）：run 在飞 → HealthyBusy；
        结束 → Healthy。这是本批必要性论证的落地检验。"""
        import main
        from bedrock_agentcore.runtime import PingStatus

        seen = {}

        async def probe_execute(plan, agent, judge_model, triggered_by, emit,
                                **_kw):
            seen["during"] = main.app.get_current_ping_status()
            return self._final_report()

        with mock.patch.object(main.plan_mod, "get_plan", return_value=PLAN), \
                mock.patch.object(main.catalog, "cached_agents", return_value={
                    "agents": [{**AGENT, "has_logs": True}]}), \
                mock.patch.object(main.planrun, "estimate_plan_run",
                                  return_value={"estimated_cost_usd": 0.1}), \
                mock.patch.object(main.planrun, "execute_plan_run", probe_execute):
            async def go():
                return [ev async for ev in main.invoke(
                    {"action": "run_plan", "plan_id": PLAN["plan_id"],
                     "judge_model": "judge-model"})]
            asyncio.run(go())

        self.assertEqual(seen["during"], PingStatus.HEALTHY_BUSY)
        self.assertEqual(main.app.get_current_ping_status(), PingStatus.HEALTHY)


if __name__ == "__main__":
    unittest.main()
