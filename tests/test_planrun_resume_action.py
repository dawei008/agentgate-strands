"""`resume_plan_run` 的 action 层（app/main.py 分发）—— UI-029 批 4。

分发只加一行动作，其余全部复用 run_plan 那一段：同一段前置校验（方案/agent）、
同一个 estimate、同一层存活契约（add/complete_async_task）、同一台事件泵、同一条
终帧 plan_run_report。本文件钉住四件在 planrun 单元测试里看不到的事：

  1. **plan_id 由 run_key 推导**（run_key = <plan_id>#<ts>）：前端只需要传 run_key；
  2. 前置校验失败 → **{"event":"error"} 应用错误帧**，不留裸异常穿出 async
     generator（那样前端只剩框架层遗言帧，认不出是应用错误 —— 与 stop_plan_run
     的 ValueError 转帧同刑）；
  3. 校验失败时**存活契约一次都不注册**、execute_plan_run 一次都没被调
     （「明确报错不半跑」在 action 层的形态：钱一分没花）；
  4. 成功路径把 resume 上下文原样交给 execute_plan_run（同 run_key、attempt+1），
     终帧仍是 plan_run_report。

不打真后端、不发起真运行：execute_plan_run 打桩，DDB 用 moto。
运行：python3 -m pytest tests/test_planrun_resume_action.py -q
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
    "plan_id": "plan-1297bb07bc31", "name": "线上评估周巡检",
    "agent_name": "support-bot",
    "stages": [{"type": "observe", "evaluators": ["helpfulness"], "max_sessions": 10},
               {"type": "dataset", "dataset": "faq", "evaluators": ["correctness"]}],
}
AGENT = {"agent_name": "support-bot", "has_logs": True,
         "runtime_arn": "arn:aws:bedrock:x:y:runtime/z"}
TS = "20260825120000"
RUN_KEY = f"{PLAN['plan_id']}#{TS}"

DONE_OBSERVE = {"type": "observe", "status": "completed", "sessions": 7,
                "summary": {}, "overall_mean": 0.83, "actual_cost_usd": 0.5,
                "evaluators": ["helpfulness"]}


class ResumeAction(unittest.TestCase):
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
        boto3.client("s3", region_name=REGION).create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": REGION})

        import catalog
        import planrun
        import runstore
        self.planrun = planrun
        for patcher in (
                mock.patch.object(catalog, "get_table", return_value=self.table),
                mock.patch.object(catalog, "TABLE_NAME", TABLE),
                mock.patch.dict(os.environ, {"ARTIFACTS_BUCKET": BUCKET})):
            patcher.start()
            self.addCleanup(patcher.stop)
        runstore._s3_client = None
        self.addCleanup(setattr, runstore, "_s3_client", None)
        planrun._stop_polls.clear()
        self.addCleanup(planrun._stop_polls.clear)
        planrun._SNAPSHOT_CACHE.clear()
        self.addCleanup(planrun._SNAPSHOT_CACHE.clear)

    def seed(self, with_checkpoint=True, status="error"):
        key = ""
        if with_checkpoint:
            boto3.client("s3", region_name=REGION).put_object(
                Bucket=BUCKET,
                Key=f"checkpoints/{PLAN['plan_id']}/{TS}/stage-1.json",
                Body=json.dumps({"run_key": RUN_KEY, "plan_id": PLAN["plan_id"],
                                 "stages_done": 1, "stages_total": 2,
                                 "stage_run_ids": [None],
                                 "stage_results": [DONE_OBSERVE]}).encode())
            key = f"checkpoints/{PLAN['plan_id']}/{TS}/stage-1.json"
        item = {"pk": "PLANRUN", "sk": RUN_KEY, "plan_id": PLAN["plan_id"],
                "plan_name": PLAN["name"], "agent_name": PLAN["agent_name"],
                "status": status, "triggered_by": "manual",
                "started_at": "2026-08-25 12:00 UTC", "started_epoch": 1787000000,
                "stage_summaries": "[]", "overview": "{}", "s3_key": "",
                "proposals": "[]", "error": "运行未正常结束（心跳超时判定…）"}
        if key:
            item["checkpoint_s3_key"] = key
        self.table.put_item(Item=item)
        return key

    def invoke(self, payload, execute=None):
        import main

        exe = execute or mock.AsyncMock(return_value={
            "run_key": RUN_KEY, "s3_key": f"reports/{PLAN['plan_id']}/{TS}.json",
            "plan": {k: PLAN[k] for k in ("plan_id", "name", "agent_name", "stages")},
            "triggered_by": "manual", "started_at": "t0", "finished_at": "t1",
            "started_epoch": 1, "finished_epoch": 2, "duration_s": 1,
            "overview": {}, "plan_synthesis": None, "synthesis_error": None,
            "stages": [DONE_OBSERVE], "status": "completed"})
        with mock.patch.object(main.plan_mod, "get_plan",
                              side_effect=lambda pid: PLAN if pid == PLAN["plan_id"]
                              else None), \
                mock.patch.object(main.catalog, "cached_agents",
                                  return_value={"agents": [AGENT]}), \
                mock.patch.object(main.planrun, "execute_plan_run", exe), \
                mock.patch.object(main.app, "add_async_task", return_value=7) as add, \
                mock.patch.object(main.app, "complete_async_task") as done:
            async def go():
                return [ev async for ev in main.invoke(payload)]
            return asyncio.run(go()), exe, add, done

    # ---- 1 + 4：成功路径 ----

    def test_run_key_alone_is_enough_and_the_context_is_passed_through(self):
        key = self.seed()
        events, exe, add, done = self.invoke(
            {"action": "resume_plan_run", "run_key": RUN_KEY})
        self.assertEqual([e["event"] for e in events][-1], "plan_run_report")
        exe.assert_awaited_once()
        ctx = exe.await_args.kwargs["resume"]
        self.assertEqual(ctx["run_key"], RUN_KEY)      # 同一个 run_key 原地续
        self.assertEqual(ctx["ts"], TS)
        self.assertEqual(ctx["attempt"], 2)            # attempt+1
        self.assertEqual(ctx["resumed_from"], key)
        self.assertEqual(ctx["stage_results"], [DONE_OBSERVE])
        self.assertEqual(ctx["stages_done"], 1)
        # 存活契约照旧配平（断流后不被平台按 idle 回收）
        self.assertEqual(add.call_args.args[0], "resume_plan_run")
        done.assert_called_once_with(7)

    def test_run_plan_still_gets_no_resume_context(self):
        """首跑一个字不变：resume=None（同一段编排，两种入口）。"""
        self.seed()
        _events, exe, add, _done = self.invoke(
            {"action": "run_plan", "plan_id": PLAN["plan_id"]})
        self.assertIsNone(exe.await_args.kwargs["resume"])
        self.assertEqual(add.call_args.args[0], "run_plan")

    # ---- 2 + 3：校验失败 = error 帧 + 一分钱没花 ----

    def assert_refused(self, payload, part):
        events, exe, add, _done = self.invoke(payload)
        self.assertEqual(events[-1]["event"], "error", events)
        self.assertIn(part, events[-1]["error"])
        exe.assert_not_awaited()          # 一个环节都没开跑
        add.assert_not_called()           # 存活契约都没注册
        return events[-1]["error"]

    def test_missing_run_key_is_an_error_frame(self):
        # plan_id 推导不出来 → 落到既有的「方案不存在」那句（同一段前置校验）
        self.assert_refused({"action": "resume_plan_run"}, "不存在")

    def test_unknown_run_is_an_error_frame(self):
        self.assert_refused(
            {"action": "resume_plan_run",
             "run_key": f"{PLAN['plan_id']}#20990101000000"}, "不存在")

    def test_run_without_checkpoint_is_an_error_frame(self):
        self.seed(with_checkpoint=False)
        self.assert_refused({"action": "resume_plan_run", "run_key": RUN_KEY},
                            "没有检查点")

    def test_completed_run_is_an_error_frame_with_a_chinese_status(self):
        self.seed(status="completed")
        msg = self.assert_refused({"action": "resume_plan_run", "run_key": RUN_KEY},
                                  "无法从检查点续跑")
        self.assertIn("已完成", msg)

    def test_broken_checkpoint_is_an_error_frame(self):
        self.seed()
        boto3.client("s3", region_name=REGION).delete_object(
            Bucket=BUCKET, Key=f"checkpoints/{PLAN['plan_id']}/{TS}/stage-1.json")
        self.assert_refused({"action": "resume_plan_run", "run_key": RUN_KEY},
                            "检查点读取失败")

    def test_the_refused_row_is_untouched(self):
        """拒绝之后那条记录一个字没改（旧数据不修 + 用户还能改完方案再来）。"""
        self.seed(status="completed")
        before = self.table.get_item(
            Key={"pk": "PLANRUN", "sk": RUN_KEY})["Item"]
        self.invoke({"action": "resume_plan_run", "run_key": RUN_KEY})
        after = self.table.get_item(Key={"pk": "PLANRUN", "sk": RUN_KEY})["Item"]
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
