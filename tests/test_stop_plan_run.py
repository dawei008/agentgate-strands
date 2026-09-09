"""用户必须能中止一次正在花钱的方案运行（P0，pair-audit 缺口 #1 第一层）。

现场形态：红队环节跑了 33 分钟（真调用户的 Agent、真花钱），用户发现选错方案，
界面上没有停止、关掉浏览器也停不了 —— 后端在 Lambda 里继续跑继续花钱。
后端 49 个 action 里没有任何 stop/cancel/abort。

设计不变量（本文件逐条钉住）：
  · **意图持久化在 run 记录上**：调用侧与执行侧是两次不同的 Lambda 调用，
    内存标志根本读不到。写标志用 `update_item` 只加属性 —— 整条覆盖会与执行侧
    的终态 `put_item` 赛跑，把已经落好的终态打回半截 running。
  · **读标志不许变成每轮整项读**（同族反例：progress-poll-reads-whole-checkpoint）：
    `ProjectionExpression` 只取标志字段 + 按时间节流（≥5s 一次），标志一旦立起来
    就不再读。
  · **终态是自己的一个词**（stopped）：与「完成」「失败」「成本熔断」区分得开，
    不复用 error —— 那会让用户去查自己的 Agent。
  · **已付费的东西一律留下**：已完成环节的摘要、费用、S3 完整明细照常落库；
    没跑完的部分绝不伪造数字（不写 run 级综合分、不生成综合报告再花一次 judge 钱）。
  · **幂等**：对已终态的 run 调用是无操作 + 可读说明；返回文案只说「已请求停止，
    将在下一个检查点生效」这种可核验的真话，不说「已停止」（那时还没停）。

moto 的真 DynamoDB + 打桩 S3；不碰真表 / 真 agent / 真 LLM / 不发起任何 run_plan。
运行：python3 -m pytest tests/test_stop_plan_run.py -q
"""

import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from botocore.exceptions import ClientError
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

TABLE = "eval-catalog-test"
BUCKET = "eval-artifacts-test"
REGION = "us-west-2"

PLAN = {
    "plan_id": "plan-1297bb07bc31",
    "name": "线上评估周巡检",
    "agent_name": "support-bot",
    "stages": [{"type": "observe", "evaluators": ["helpfulness"], "metrics": []}],
}
PLAN_3STAGE = {**PLAN, "stages": PLAN["stages"] * 3}
AGENT = {"agent_name": "support-bot", "agent_arn": "arn:aws:bedrock:x:y:runtime/z"}
SYNTHESIS = "## 整体趋势\n首个数据点，暂无趋势可言。"
RUN_KEY = f"{PLAN['plan_id']}#20260824090000"


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
        p = mock.patch.object(catalog, "get_table", return_value=self.table)
        p.start()
        self.addCleanup(p.stop)
        n = mock.patch.object(catalog, "TABLE_NAME", TABLE)
        n.start()
        self.addCleanup(n.stop)
        e = mock.patch.dict(os.environ, {"ARTIFACTS_BUCKET": BUCKET})
        e.start()
        self.addCleanup(e.stop)
        self.s3 = mock.MagicMock()
        s = mock.patch.object(planrun.runstore, "_s3", return_value=self.s3)
        s.start()
        self.addCleanup(s.stop)
        # 节流缓存是模块级的：测试之间必须互不污染
        planrun._stop_polls.clear()
        self.addCleanup(planrun._stop_polls.clear)

    # ---- 夹具 ----

    def seed_run(self, status: str = "running", run_key: str = RUN_KEY, **extra):
        item = {
            "pk": "PLANRUN", "sk": run_key,
            "plan_id": PLAN["plan_id"], "plan_name": PLAN["name"],
            "agent_name": PLAN["agent_name"],
            "status": status, "triggered_by": "manual",
            "started_at": "2026-08-24 09:00 UTC", "started_epoch": 1787043600,
            "stage_summaries": "[]", "overview": "{}", "s3_key": "", "proposals": "[]",
        }
        item.update(extra)
        self.table.put_item(Item=item)
        return run_key

    def item(self, run_key: str = RUN_KEY) -> dict:
        return self.table.get_item(
            Key={"pk": "PLANRUN", "sk": run_key}).get("Item") or {}

    def rows(self):
        return self.planrun.list_plan_runs(PLAN["plan_id"])

    def call(self, payload):
        import main

        async def go():
            return [ev async for ev in main.invoke(payload)]
        return asyncio.run(go())


# ---------------------------------------------------------------- action 层

class StopAction(DdbFixture):
    """验收 1（action 存在且写得进意图）、4（幂等）、5（不存在的 run_key）。"""

    def test_action_writes_the_stop_intent_on_a_running_run(self):
        self.seed_run()
        events = self.call({"action": "stop_plan_run", "run_key": RUN_KEY})
        self.assertEqual([e["event"] for e in events], ["plan_run_stop_requested"])
        ev = events[0]
        self.assertTrue(ev["requested"])
        self.assertEqual(ev["run_key"], RUN_KEY)
        it = self.item()
        self.assertTrue(it.get("stop_requested"), "停止意图没有落到 run 记录上")
        self.assertTrue(it.get("stop_requested_at"))

    def test_flag_write_keeps_the_rest_of_the_row_intact(self):
        """`update_item` 只加属性：整条覆盖会与执行侧的终态 put_item 赛跑。"""
        self.seed_run()
        before = self.item()
        self.call({"action": "stop_plan_run", "run_key": RUN_KEY})
        after = self.item()
        for k, v in before.items():
            self.assertEqual(after.get(k), v, f"字段 {k} 被停止写覆盖了")
        self.assertEqual(after["status"], "running", "标志写把状态改了")

    def test_message_says_requested_not_stopped(self):
        """可核验的真话：此刻只是「已请求」，还没停。"""
        self.seed_run()
        msg = self.call({"action": "stop_plan_run", "run_key": RUN_KEY})[0]["message"]
        self.assertIn("已请求停止", msg)
        self.assertIn("检查点", msg)
        self.assertNotIn("已停止", msg)

    def test_missing_run_key_is_refused(self):
        events = self.call({"action": "stop_plan_run"})
        self.assertEqual([e["event"] for e in events], ["error"])
        self.assertIn("run_key", events[0]["error"])

    def test_unknown_run_key_yields_a_readable_error(self):
        """验收 5：明确错误事件，不抛裸异常（裸异常只留框架的 last-words 帧，
        前端根本认不出是应用错误 —— BH-005 的形态）。"""
        events = self.call({"action": "stop_plan_run", "run_key": "plan-nope#1"})
        self.assertEqual([e["event"] for e in events], ["error"])
        self.assertIn("plan-nope#1", events[0]["error"])
        self.assertIn("不存在", events[0]["error"])

    def test_stopping_a_finished_run_is_a_no_op_with_a_reason(self):
        """验收 4：已终态 → 不写任何东西，返回可读说明。"""
        self.seed_run(status="completed")
        ev = self.call({"action": "stop_plan_run", "run_key": RUN_KEY})[0]
        self.assertEqual(ev["event"], "plan_run_stop_requested")
        self.assertFalse(ev["requested"])
        self.assertIn("已完成", ev["message"])
        self.assertNotIn("stop_requested", self.item(),
                         "已终态的 run 上不许留停止标志")

    def test_no_op_message_carries_no_bare_english_status(self):
        """说明里不许把英文枚举原样印给用户（halted_cost 的老毛病）。"""
        self.seed_run(status="halted_cost")
        ev = self.call({"action": "stop_plan_run", "run_key": RUN_KEY})[0]
        self.assertNotIn("halted_cost", ev["message"])
        self.assertIn("熔断", ev["message"])

    def test_stopping_twice_is_idempotent(self):
        self.seed_run()
        first = self.call({"action": "stop_plan_run", "run_key": RUN_KEY})[0]
        at = self.item()["stop_requested_at"]
        second = self.call({"action": "stop_plan_run", "run_key": RUN_KEY})[0]
        self.assertTrue(first["requested"])
        self.assertTrue(second["requested"])
        self.assertTrue(second["already"], "第二次调用没说清「此前已请求过」")
        self.assertEqual(self.item()["stop_requested_at"], at,
                         "第二次调用重写了请求时间（不是无操作）")

    def test_request_stop_refuses_an_empty_run_key(self):
        with self.assertRaises(ValueError):
            self.planrun.request_stop("")

    def test_run_that_ends_mid_call_is_a_no_op_not_a_crash(self):
        """赛跑窗口：读到 running、写标志时 run 已经落终态 → 条件写不成立。
        必须变成可读的无操作，而不是把 ClientError 抛给用户（也不许给一条终态
        记录挂上一个毫无意义的停止标志）。"""
        self.seed_run()
        err = {"Error": {"Code": "ConditionalCheckFailedException",
                         "Message": "The conditional request failed"}}
        real_update = self.table.update_item

        def racing_update(**kw):
            # 用户点停止的同一瞬间，执行侧那条终态覆盖写落库了
            self.seed_run(status="completed")
            raise ClientError(err, "UpdateItem")

        with mock.patch.object(self.table, "update_item", side_effect=racing_update):
            ev = self.call({"action": "stop_plan_run", "run_key": RUN_KEY})[0]
        self.assertEqual(ev["event"], "plan_run_stop_requested")
        self.assertFalse(ev["requested"])
        self.assertIn("已完成", ev["message"])
        self.assertNotIn("stop_requested", self.item())
        self.assertIsNotNone(real_update)  # 夹具自证：真 update 没被调用到

    def test_other_ddb_errors_are_not_swallowed(self):
        """只有「条件不成立」是正常赛跑；别的写失败不许被伪装成无操作
        （沉默会让用户以为已经请求停止了，钱继续烧）。"""
        self.seed_run()
        err = {"Error": {"Code": "ProvisionedThroughputExceededException",
                         "Message": "slow down"}}
        with mock.patch.object(self.table, "update_item",
                               side_effect=ClientError(err, "UpdateItem")):
            with self.assertRaises(ClientError):
                self.planrun.request_stop(RUN_KEY)


# ------------------------------------------------------- 标志读取的成本（验收 6）

class StopFlagRead(DdbFixture):
    def spy_get_item(self):
        real = self.table.get_item
        calls = []

        def spy(**kw):
            calls.append(kw)
            return real(**kw)
        p = mock.patch.object(self.table, "get_item", side_effect=spy)
        p.start()
        self.addCleanup(p.stop)
        return calls

    def test_read_projects_only_the_flag(self):
        """整项读会把 2-4KB 的综合报告全文也拉回来（progress-poll 同族缺陷）。"""
        self.seed_run(plan_synthesis="x" * 3000)
        calls = self.spy_get_item()
        self.assertFalse(self.planrun.stop_requested(RUN_KEY))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].get("ProjectionExpression"), "stop_requested")

    def test_read_is_throttled_between_checkpoints(self):
        """每个用例/每轮都问一次，但真读按时间节流（≥5s 一次）。"""
        self.seed_run()
        calls = self.spy_get_item()
        for _ in range(50):
            self.planrun.stop_requested(RUN_KEY)
        self.assertEqual(len(calls), 1, "每轮都真读了一次 DDB")

    def test_throttle_expires_so_a_stop_still_lands(self):
        self.seed_run()
        calls = self.spy_get_item()
        base = 1000.0
        with mock.patch.object(self.planrun.time, "monotonic", return_value=base):
            self.assertFalse(self.planrun.stop_requested(RUN_KEY))
        self.seed_run(stop_requested=True)
        with mock.patch.object(
                self.planrun.time, "monotonic",
                return_value=base + self.planrun._STOP_POLL_INTERVAL_S + 0.1):
            self.assertTrue(self.planrun.stop_requested(RUN_KEY))
        self.assertEqual(len(calls), 2)

    def test_a_raised_flag_is_sticky_and_stops_reading(self):
        self.seed_run(stop_requested=True)
        calls = self.spy_get_item()
        self.assertTrue(self.planrun.stop_requested(RUN_KEY))
        for _ in range(10):
            self.assertTrue(self.planrun.stop_requested(RUN_KEY))
        self.assertEqual(len(calls), 1, "标志立起来之后还在反复读")

    def test_read_failure_never_stops_a_paid_run(self):
        """读不到标志 ≠ 用户请求了停止：读失败必须当没请求（记日志）。"""
        self.seed_run()
        with mock.patch.object(self.table, "get_item",
                               side_effect=RuntimeError("ThrottlingException")):
            self.assertFalse(self.planrun.stop_requested(RUN_KEY))


# --------------------------------------------------------- 执行侧（验收 2/3/7）

class StoppedPlanRun(DdbFixture):
    """环节循环的检查点 + 停止终态落库。"""

    def _run(self, plan=PLAN_3STAGE, stop_before_stage: int | None = 2,
             stage_results=None, dataset_result=None):
        """跑一次 execute_plan_run；stop_before_stage=N 表示第 N-1 个环节执行
        期间用户按下了停止（模拟另一次 Lambda 调用写标志）。"""
        results = list(stage_results or [observe_result(0.91), observe_result(0.5),
                                         observe_result(0.4)])
        self.stages_run = 0

        async def fake_observe(stage, agent, judge_model, emit_, stage_no=0):
            self.stages_run += 1
            if stop_before_stage is not None and self.stages_run == stop_before_stage - 1:
                self.planrun.request_stop(self.run_key_of())
            return results.pop(0)

        async def fake_dataset(stage, plan_, agent, judge_model, emit_, stop_check=None):
            self.stages_run += 1
            return dataset_result

        async def emit(_ev):
            pass

        self.synth = mock.AsyncMock(return_value=SYNTHESIS)
        with mock.patch.object(self.planrun, "_run_observe_stage", fake_observe), \
                mock.patch.object(self.planrun, "_run_dataset_stage", fake_dataset), \
                mock.patch.object(self.planrun, "_generate_synthesis", self.synth), \
                mock.patch.object(self.planrun, "latest_run_summary", return_value=None):
            return asyncio.run(self.planrun.execute_plan_run(
                plan, AGENT, "judge-model", "manual", emit))

    def run_key_of(self) -> str:
        """执行中那条 running marker 的 key（用户在界面上点的就是它）。"""
        rows = self.rows()
        self.assertTrue(rows, "开跑的 running 记录不在库里，前提不成立")
        return rows[0]["run_key"]

    # ---- 验收 2：下一个检查点终止后续环节 ----

    def test_remaining_stages_do_not_run(self):
        self._run()
        self.assertEqual(self.stages_run, 1,
                         "停止请求之后还继续跑了环节（继续花钱）")

    def test_finished_stage_results_are_kept(self):
        self._run()
        row = self.rows()[0]
        self.assertEqual(len(row["stage_summaries"]), 1)
        self.assertEqual(row["stage_summaries"][0]["overall_mean"], 0.91)
        self.assertEqual(row["total_cost_usd"], 0.12, "已花的钱没落库")

    def test_full_report_is_still_archived(self):
        """已付费的明细（transcript 等）只住在 S3，停止不许让它丢。"""
        self._run()
        self.assertTrue(self.s3.put_object.called, "S3 完整报告没写")
        self.assertTrue(self.rows()[0]["s3_key"], "摘要项没指向报告 → 明细成孤儿")

    def test_exactly_one_terminal_row(self):
        self._run()
        self.assertEqual(len(self.rows()), 1,
                         "running 行没被覆盖，历史里出现了两行")

    # ---- 验收 3：终态与完成/熔断/失败区分得开 ----

    def test_terminal_status_is_its_own_word(self):
        self._run()
        row = self.rows()[0]
        self.assertEqual(row["status"], self.planrun.STOP_STATUS)
        self.assertNotIn(row["status"], ("completed", "error", "failed", "halted_cost"))
        self.assertIn("停止", row["error"] or "")

    def test_stopped_row_fabricates_no_run_score(self):
        """半截 run 不许有 run 级综合分（分母是整个方案的 observe 环节）。
        环节自己的 overall_mean 仍在 stage_summaries 里，一个数字都没丢。"""
        self._run()
        row = self.rows()[0]
        self.assertIsNone(row["score"])
        self.assertEqual(row["stage_summaries"][0]["overall_mean"], 0.91)

    def test_no_synthesis_call_after_a_stop(self):
        """停止就是停止花钱：不再为半截 run 生成综合报告（一次 judge 调用），
        也不许留下「综合报告生成失败」——那是另一回事。"""
        self._run()
        self.assertFalse(self.synth.called, "停止之后还调了一次 judge")
        self.assertIsNone(self.rows()[0]["synthesis_error"])

    # ---- 环节内部（用例/攻击层）被停掉时，run 也到此为止 ----

    def test_a_stage_stopped_at_case_level_ends_the_run(self):
        """回归/红队环节在自己的检查点被停掉（status=stopped）→ 不许接着开下一个
        环节继续花钱。"""
        plan = {**PLAN, "stages": [{"type": "dataset", "dataset": "faq"},
                                   {"type": "observe", "evaluators": []}]}
        self._run(plan=plan, stop_before_stage=None,
                  dataset_result={"type": "dataset", "status": "stopped",
                                  "error": "已按用户请求停止", "cases": 8,
                                  "pass_rate": 1.0, "actual_cost_usd": 0.4})
        self.assertEqual(self.stages_run, 1)
        row = self.rows()[0]
        self.assertEqual(row["status"], self.planrun.STOP_STATUS)
        self.assertEqual(row["stage_summaries"][0]["status"], "stopped")

    def test_stage_line_states_the_stop_instead_of_a_pass_rate(self):
        """overview 的环节一行话不许把被掐断的半截说成「8 个用例，通过率 100%」
        （与成本熔断同一个坑）。"""
        line = self.planrun._fmt_stage_line(
            {"type": "dataset", "status": "stopped", "cases": 8, "pass_rate": 1.0,
             "error": "已按用户请求停止，本环节未跑完"})
        self.assertIn("停止", line)
        self.assertNotIn("通过率", line)

    # ---- 回归：没人按停止时行为一字不变 ----

    def test_untouched_run_still_completes_normally(self):
        self._run(stop_before_stage=None)
        self.assertEqual(self.stages_run, 3)
        row = self.rows()[0]
        self.assertEqual(row["status"], "completed")
        self.assertTrue(self.synth.called)
        self.assertEqual(row["score"], round((0.91 + 0.5 + 0.4) / 3, 4))
        self.assertEqual(row["plan_synthesis"], SYNTHESIS)


class SourceGuards(unittest.TestCase):
    src = (Path(__file__).resolve().parent.parent / "app" / "planrun.py").read_text()

    def test_stop_flag_is_written_with_update_not_put(self):
        """整条覆盖会与终态 put_item 赛跑 —— 停止写只许 update_item 加属性。"""
        body = self.src[self.src.index("def request_stop("):
                        self.src.index("def stop_requested(")]
        self.assertIn("update_item", body)
        self.assertNotIn("put_item", body)

    def test_terminal_write_still_uses_a_single_overwrite(self):
        """既有不变量不许被停止路径破坏：终态仍是一次整条覆盖写。"""
        body = self.src[self.src.index("async def execute_plan_run"):
                        self.src.index("def _stage_summary")]
        self.assertNotIn("update_item", body)

    def test_checkpoint_sits_at_the_top_of_the_stage_loop(self):
        """检查点必须在环节开始**之前**：宣布 stage_start 之后再说「没跑」更难读，
        而且那时环节体已经开始花钱了。"""
        loop_at = self.src.index('for i, stage in enumerate(plan["stages"], 1):')
        body = self.src[loop_at:loop_at + 900]
        self.assertLess(body.index("stop_requested(run_key)"),
                        body.index('"event": "stage_start"'))

    def test_stop_status_is_the_same_word_as_the_executors(self):
        """planrun / testrun / redteam 说的是同一个词（前端 scoring.ts 的
        STATUS_LABEL 也按它配中文），不许各写一个字面量。"""
        import planrun
        import redteam
        import testrun
        self.assertEqual(planrun.STOP_STATUS, "stopped")
        self.assertIs(planrun.STOP_STATUS, testrun.STOP_STATUS)
        self.assertIs(planrun.STOP_STATUS, redteam.STOP_STATUS)

    def test_flag_read_uses_a_projection(self):
        body = self.src[self.src.index("def stop_requested("):
                        self.src.index("# ---------- run orchestration ----------")]
        self.assertIn("ProjectionExpression", body)


if __name__ == "__main__":
    unittest.main()
