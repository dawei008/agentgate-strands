"""UI-029 批 4：从检查点续跑（`resume_plan_run`）。规格 `.scratch/ui029-spec/SPEC.md`
§4 + §8 批 4 行 + 开放问题 2 的采纳答案。

要消灭的缺口：残余死亡路径（8h maxLifetime / microVM 崩溃 / 发版换容器 / 平台按
idle 回收）下执行进程根本没机会收尾 —— reaper 把那条 running 改判成 error
（`_reap_write` 是 **update 只补字段**，所以 progress / checkpoint_s3_key 留在库
里），而此前用户唯一的出路是**整条方案重跑一遍**：已经付过钱的环节再付一次。

本文件钉住的不变量（逐条对应交付项）：
  · **注入已完成环节：不重跑**（被测环节执行体的调用计数必须是 0）
    与**不重计费**（终态 total_cost_usd = 注入环节 + 新跑环节，注入那部分一分不多）；
  · **同一个 run_key 原地续**（开放问题 2 的采纳答案）：attempt+1 +
    resumed_from 记来源检查点；历史行仍是一行，状态仍是 **running**（§2 不新增状态）；
  · **计费上界可算**：`resume_cost_ceiling` = 剩余环节预估合计（新增花费上界）
    + 被重跑那一个环节的预估（规格 §4 的「重计费上界 = 单环节预估」）；
  · **明确报错不半跑**：检查点缺失 / 对象不在 / JSON 坏 / 方案定义漂移 /
    run 不属于本方案 / 已完成或正在跑 —— 一律 ValueError，一个环节都不许开跑；
  · **半截环节整环节重跑**（§4 首版粒度）：被停止的那一环不算已完成；
  · **stop 语义对续跑中的 run 仍生效**，且**上一次的粘滞停止标志不许掐掉续跑**；
  · **终态覆盖写不残留中途字段**（§5 覆盖即清场，与首跑完全同形）。

moto 的真 DynamoDB + 真 S3（检查点走 runstore.archive_run/fetch_detail 的真路径）；
不碰真表 / 真桶 / 真 agent / 真 LLM，**不发起任何真 run_plan / resume_plan_run**。
运行：python3 -m pytest tests/test_planrun_resume.py -q
"""

import asyncio
import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

TABLE = "eval-catalog-test"
BUCKET = "eval-artifacts-test"
REGION = "us-west-2"

# 两环节方案（observe → dataset）：续跑的最小可辨形态 —— 第 1 环注入、第 2 环真跑。
PLAN = {
    "plan_id": "plan-1297bb07bc31",
    "name": "线上评估周巡检",
    "agent_name": "support-bot",
    "stages": [
        {"type": "observe", "evaluators": ["helpfulness"], "metrics": [],
         "max_sessions": 10},
        {"type": "dataset", "dataset": "faq", "evaluators": ["correctness"]},
    ],
}
AGENT = {"agent_name": "support-bot", "agent_arn": "arn:aws:bedrock:x:y:runtime/z"}

TS = "20260825120000"
RUN_KEY = f"{PLAN['plan_id']}#{TS}"
# 死掉那次的开跑时刻（远早于「现在」——正是 reaper 改判的那一族）
DEAD_STARTED_EPOCH = 1787_000_000

# 各环节预估（estimate_plan_run 的产出形态：stages 逐项带 estimated_cost_usd）
ESTIMATE = {
    "stages": [{"type": "observe", "judge_calls": 20, "estimated_cost_usd": 0.12},
               {"type": "dataset", "cases": 14, "estimated_cost_usd": 0.3}],
    "estimated_cost_usd": 0.42,
    "note": "各环节预估合计",
}


def observe_result(mean: float = 0.83, cost: float = 0.5, status="completed") -> dict:
    return {"type": "observe", "status": status, "sessions": 7,
            "summary": {}, "overall_mean": mean, "metrics": None,
            "session_details": [], "analysis": None, "actual_cost_usd": cost,
            "evaluators": ["helpfulness"], "metric_keys": []}


def dataset_result(cost: float = 0.25, status="completed") -> dict:
    return {"type": "dataset", "status": status, "run_id": "run-777",
            "dataset": "faq", "cases": 4, "judged_cases": 4, "pass_rate": 0.75,
            "blank_cases": 0, "actual_cost_usd": cost,
            "evaluators": ["correctness"],
            "report": {"results": [{"results": {}}], "evaluators": ["correctness"]}}


class ResumeFixture(unittest.TestCase):
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
        self.runstore = runstore
        for patcher in (
                mock.patch.object(catalog, "get_table", return_value=self.table),
                mock.patch.object(catalog, "TABLE_NAME", TABLE),
                mock.patch.dict(os.environ, {"ARTIFACTS_BUCKET": BUCKET})):
            patcher.start()
            self.addCleanup(patcher.stop)
        # 惰性单例（runstore._s3）：容器复用的缓存句柄可能是别的测试在 moto 之外
        # 建的 —— 归零后由本用例在 moto 里重建，用完再归零，不留给下一个用例。
        runstore._s3_client = None
        self.addCleanup(setattr, runstore, "_s3_client", None)
        planrun._stop_polls.clear()
        self.addCleanup(planrun._stop_polls.clear)
        planrun._SNAPSHOT_CACHE.clear()
        self.addCleanup(planrun._SNAPSHOT_CACHE.clear)

    # ---- 夹具：一条「被 reaper 改判、留着检查点」的 error 记录 ----

    def write_checkpoint(self, stage_results: list[dict], stage_no: int | None = None,
                         ts: str = TS) -> str:
        """按写侧的真形态归档一个检查点，返回 key。

        形态出处 = `_write_stage_checkpoint` 的 payload 字面量（run_key / plan_id /
        stages_done / stages_total / stage_run_ids / stage_results /
        written_at_epoch），路径 `checkpoints/<plan_id>/<ts>/stage-<i>.json`。
        """
        n = stage_no if stage_no is not None else len(stage_results)
        payload = {
            "run_key": f"{PLAN['plan_id']}#{ts}", "plan_id": PLAN["plan_id"],
            "stages_done": n, "stages_total": len(PLAN["stages"]),
            "stage_run_ids": [r.get("run_id") for r in stage_results],
            "stage_results": stage_results,
            "written_at_epoch": DEAD_STARTED_EPOCH + 120,
        }
        key, err = self.runstore.archive_run(
            payload, f"checkpoints/{PLAN['plan_id']}/{ts}", f"stage-{n}",
            noun="检查点")
        self.assertIsNone(err, err)
        return key

    def reaped_row(self, checkpoint_key: str | None, status: str = "error",
                   run_key: str = RUN_KEY, **extra) -> None:
        """reaper 改判后的那条记录（`_reap_write` = update 只补终态与原因，
        所以 progress / checkpoint_s3_key / heartbeat_epoch 全都留在库里）。"""
        item = {
            "pk": "PLANRUN", "sk": run_key,
            "plan_id": PLAN["plan_id"], "plan_name": PLAN["name"],
            "agent_name": PLAN["agent_name"],
            "status": status, "triggered_by": "manual",
            "started_at": "2026-08-25 12:00 UTC", "started_epoch": DEAD_STARTED_EPOCH,
            "stage_summaries": "[]", "overview": "{}", "s3_key": "", "proposals": "[]",
            "error": "运行未正常结束（心跳超时判定：执行进程未收敛…）",
            "finished_at": "2026-08-25 12:41 UTC",
            "finished_epoch": DEAD_STARTED_EPOCH + 2460,
            "duration_s": 2460,
            "heartbeat_epoch": DEAD_STARTED_EPOCH + 300,
            "estimated_duration_s": 530,
            "progress": json.dumps({"stages_done": 1, "stages_total": 2,
                                    "stage": "observe",
                                    "stage_summaries_partial": []}),
        }
        if checkpoint_key:
            item["checkpoint_s3_key"] = checkpoint_key
        item.update(extra)
        self.table.put_item(Item=item)

    def seed(self, injected: list[dict] | None = None, **row) -> str:
        """检查点 + 可续跑的 error 行；返回检查点 key。"""
        key = self.write_checkpoint(injected if injected is not None
                                    else [observe_result()])
        self.reaped_row(key, **row)
        return key

    def item(self, run_key: str = RUN_KEY) -> dict:
        return self.table.get_item(
            Key={"pk": "PLANRUN", "sk": run_key}).get("Item") or {}

    def rows(self):
        return self.planrun.list_plan_runs(PLAN["plan_id"])

    # ---- 驱动：真跑一次 resume（环节执行体打桩，计数每一次调用） ----

    def resume(self, plan=PLAN, estimate=ESTIMATE, run_key=RUN_KEY,
               observe=None, dataset=None, emit=None):
        calls = {"observe": 0, "dataset": 0}
        events: list[dict] = []

        async def default_emit(ev):
            events.append(ev)

        async def obs(stage_, agent, judge_model, emit_, stage_no=0):
            calls["observe"] += 1
            return observe(stage_no) if observe else observe_result()

        async def ds(stage_, plan_, agent, judge_model, emit_, stop_check=None):
            calls["dataset"] += 1
            if dataset:
                return dataset(stop_check)
            return dataset_result()

        ctx = self.planrun.resume_context(run_key, plan)
        with mock.patch.object(self.planrun, "_run_observe_stage", obs), \
                mock.patch.object(self.planrun, "_run_dataset_stage", ds), \
                mock.patch.object(self.planrun, "_generate_synthesis",
                                  new=mock.AsyncMock(return_value=None)), \
                mock.patch.object(self.planrun, "latest_run_summary",
                                  return_value=None):
            report = asyncio.run(self.planrun.execute_plan_run(
                plan, AGENT, "judge-model", "manual", emit or default_emit,
                estimate=estimate, resume=ctx))
        return report, calls, events


# ================================================ 注入：不重跑、不重计费

class InjectsDoneStagesWithoutRerunning(ResumeFixture):
    def test_done_stage_is_injected_and_never_re_executed(self):
        """已完成环节直接注入 —— 被测环节执行体的调用计数必须是 **0**。"""
        self.seed([observe_result(mean=0.83, cost=0.5)])
        report, calls, _ = self.resume()

        self.assertEqual(calls["observe"], 0,
                         "已完成的线上评估环节被重跑了 —— 用户为同一份结果付了两次钱")
        self.assertEqual(calls["dataset"], 1, "剩余环节没跑")
        self.assertEqual([s["type"] for s in report["stages"]],
                         ["observe", "dataset"])
        # 注入那一环的数字**逐字沿用检查点**（不是重算、不是清空）
        self.assertEqual(report["stages"][0]["overall_mean"], 0.83)
        self.assertEqual(report["stages"][0]["sessions"], 7)
        self.assertEqual(report["status"], "completed")

    def test_cost_only_grows_by_the_remaining_stages(self):
        """不重计费：终态 total_cost_usd = 注入环节 + 新跑环节，注入那部分一分不多。"""
        self.seed([observe_result(cost=0.5)])
        self.resume(dataset=lambda _stop: dataset_result(cost=0.25))
        row = self.rows()[0]
        self.assertEqual(row["total_cost_usd"], 0.75)

    def test_only_the_remaining_stages_emit_stage_events(self):
        """注入的环节不发 stage_start/stage_done：那一环这次并没有在跑，
        宣布「执行中」等于骗用户（也会让进度日志多出一条假行）。"""
        self.seed([observe_result()])
        _report, _calls, events = self.resume()
        starts = [e for e in events if e.get("event") == "stage_start"]
        self.assertEqual([e["stage"] for e in starts], [2])
        self.assertEqual(starts[0]["type"], "dataset")
        self.assertEqual(starts[0]["total_stages"], 2)

    def test_started_event_announces_the_resume_and_the_cost_ceiling(self):
        """事件仍叫 plan_run_started（同名同形、多带 resume 段）：run_key 是
        断流轮询的钥匙，resume 段是前端「第 N 环节继续 + 新增花费上界」的数据源。"""
        self.seed([observe_result()])
        _report, _calls, events = self.resume()
        started = [e for e in events if e.get("event") == "plan_run_started"]
        self.assertEqual(len(started), 1)
        ev = started[0]
        self.assertEqual(ev["run_key"], RUN_KEY)
        res = ev["resume"]
        self.assertEqual(res["attempt"], 2)
        self.assertEqual(res["stages_done"], 1)
        self.assertEqual(res["from_stage"], 2)
        self.assertEqual(res["stages_total"], 2)
        self.assertTrue(str(res["resumed_from"]).endswith("stage-1.json"))
        # 上界：剩余环节（第 2 环）预估 0.3；被重跑的那一个环节同样是第 2 环
        self.assertEqual(res["added_max_usd"], 0.3)
        self.assertEqual(res["rebill_max_usd"], 0.3)

    def test_report_carries_the_injected_stage_detail(self):
        """完整报告里注入环节的明细照旧在（那是用户已付费的真结果，不许丢）。"""
        self.seed([dict(observe_result(), session_details=[{"session_id": "s-1"}])])
        report, _calls, _events = self.resume()
        self.assertEqual(report["stages"][0]["session_details"],
                         [{"session_id": "s-1"}])


# ============================================ 身份：同 run_key、attempt+1

class SameRunKeyAttemptPlusOne(ResumeFixture):
    def test_history_stays_one_row_and_attempt_increments(self):
        """同一个 run_key 原地续：历史里仍是**一行**，attempt 2、
        resumed_from 记来源检查点，且状态仍是 running（不新增状态）。"""
        key = self.seed([observe_result()])
        seen = {}

        def peek(_stop):
            seen["item"] = self.item()
            seen["rows"] = self.rows()
            return dataset_result()

        report, _calls, _events = self.resume(dataset=peek)
        self.assertEqual(report["run_key"], RUN_KEY, "续跑另起了一个 run_key")
        self.assertEqual(len(seen["rows"]), 1, "历史行分裂成了两行")
        item = seen["item"]
        self.assertEqual(item["status"], "running")
        self.assertEqual(int(item["attempt"]), 2)
        self.assertEqual(item["resumed_from"], key)
        # 上一次的终态字段被整条覆盖清掉了：续跑期间不许残留 error/finished_at
        self.assertNotIn("error", item)
        self.assertNotIn("finished_at", item)

    def test_attempt_counts_up_across_resumes(self):
        """第三次尝试 = attempt 3（库里已有 attempt 2 时 +1，不是恒等于 2）。"""
        self.seed([observe_result()], attempt=2)
        ctx = self.planrun.resume_context(RUN_KEY, PLAN)
        self.assertEqual(ctx["attempt"], 3)

    def test_terminal_keeps_the_lineage_and_drops_the_midrun_fields(self):
        """终态整条覆盖写：血缘（attempt/resumed_from）留着 —— 那是「这次运行是
        续跑出来的」的唯一证据；中途字段（心跳/进度/检查点指针/预估时长）清场。"""
        key = self.seed([observe_result()])
        self.resume()
        item = self.item()
        self.assertEqual(item["status"], "completed")
        self.assertEqual(int(item["attempt"]), 2)
        self.assertEqual(item["resumed_from"], key)
        for field in ("heartbeat_epoch", "progress", "checkpoint_s3_key",
                      "estimated_duration_s"):
            self.assertNotIn(field, item,
                             f"终态记录残留中途字段 {field}（§5 覆盖即清场被破坏）")
        # 两个环节的摘要都在（注入的那一环也算这次运行的成果）
        self.assertEqual(len(json.loads(item["stage_summaries"])), 2)

    def test_report_object_is_the_same_run_ts(self):
        """S3 报告仍落在这条 run 自己的 ts 上（一次运行一份报告，不另起一份）。"""
        self.seed([observe_result()])
        self.resume()
        self.assertEqual(self.item()["s3_key"],
                         f"reports/{PLAN['plan_id']}/{TS}.json")

    def test_started_epoch_is_the_resume_moment_not_the_dead_attempt(self):
        """started_epoch 取**续跑时刻**：沿用死掉那次的（几天前）会让
        stalecheck 的天花板判据（8h+裕量，先判）立刻判 stale ——
        面板不恢复、reaper 下一轮直接把正在跑的续跑改判成 error。"""
        self.seed([observe_result()])
        seen = {}

        def peek(_stop):
            seen["item"] = self.item()
            return dataset_result()

        self.resume(dataset=peek)
        import stalecheck
        fresh = int(seen["item"]["started_epoch"])
        self.assertGreater(fresh, DEAD_STARTED_EPOCH)
        self.assertLessEqual(abs(fresh - int(time.time())), 60)
        self.assertFalse(stalecheck.is_stale(seen["item"], time.time()),
                         "续跑中的 run 一开跑就被判定陈旧")


# ================================================== 计费上界（给确认卡的数字）

class CostCeiling(ResumeFixture):
    def test_ceiling_is_the_remaining_stages_and_the_rerun_stage(self):
        """新增花费上界 = 剩余环节预估合计；重计费上界 = 被重跑那**一个**环节的预估
        （规格 §4）。第 3 环节起续跑的三环节方案上两个数不同 —— 这才分得清。"""
        plan = {**PLAN, "stages": [{"type": "observe", "max_sessions": 4},
                                   {"type": "dataset", "dataset": "faq"},
                                   {"type": "redteam", "cases": [{}]}]}
        estimate = {"stages": [{"type": "observe", "estimated_cost_usd": 0.12},
                               {"type": "dataset", "estimated_cost_usd": 0.3},
                               {"type": "redteam", "estimated_cost_usd": 1.85}],
                    "estimated_cost_usd": 2.27}
        got = self.planrun.resume_cost_ceiling(plan, 1, estimate)
        self.assertEqual(got["from_stage"], 2)
        self.assertEqual(got["stages_total"], 3)
        self.assertEqual(got["added_max_usd"], 2.15)   # 0.3 + 1.85
        self.assertEqual(got["rebill_max_usd"], 0.3)   # 被重跑的只有第 2 环

    def test_missing_estimate_gives_none_not_zero(self):
        """算不出就是 None：$0.00 会被读成「续跑不要钱」。"""
        for estimate in (None, {}, {"stages": []}, {"stages": [{"type": "observe"}]}):
            got = self.planrun.resume_cost_ceiling(PLAN, 1, estimate)
            self.assertIsNone(got["added_max_usd"], estimate)
            self.assertIsNone(got["rebill_max_usd"], estimate)
            self.assertEqual(got["from_stage"], 2)


# ============================== 明确报错不半跑（前置校验，一个环节都不许开跑）

class RefusesInsteadOfRunningHalfway(ResumeFixture):
    def assert_refused(self, part: str, **kw):
        with self.assertRaises(ValueError) as cm:
            self.planrun.resume_context(kw.pop("run_key", RUN_KEY),
                                        kw.pop("plan", PLAN))
        self.assertIn(part, str(cm.exception))
        return str(cm.exception)

    def test_missing_run_key(self):
        self.assert_refused("run_key", run_key="  ")

    def test_unknown_run(self):
        self.assert_refused("不存在", run_key=f"{PLAN['plan_id']}#20990101000000")

    def test_run_without_a_checkpoint(self):
        """检查点指针都没有（第一个环节结束前就断，或跑在本机制上线之前）。"""
        self.reaped_row(None)
        self.assert_refused("没有检查点")

    def test_checkpoint_object_is_gone(self):
        """指针在、S3 对象不在（归档被清理/桶换了）：明确报错，绝不当成空成果续跑。"""
        self.reaped_row(f"checkpoints/{PLAN['plan_id']}/{TS}/stage-1.json")
        self.assert_refused("检查点读取失败")

    def test_checkpoint_json_is_corrupt(self):
        """坏 JSON：fetch_detail 回 None —— 同样明确报错，不半跑。"""
        key = f"checkpoints/{PLAN['plan_id']}/{TS}/stage-1.json"
        boto3.client("s3", region_name=REGION).put_object(
            Bucket=BUCKET, Key=key,
            Body='{"stage_results": [不是 JSON'.encode())
        self.reaped_row(key)
        self.assert_refused("检查点读取失败")

    def test_checkpoint_without_stage_results(self):
        key = f"checkpoints/{PLAN['plan_id']}/{TS}/stage-1.json"
        boto3.client("s3", region_name=REGION).put_object(
            Bucket=BUCKET, Key=key, Body=b'{"stages_done": 1}')
        self.reaped_row(key)
        self.assert_refused("没有可注入的环节结果")

    def test_completed_run_is_refused(self):
        """已完成的 run 不给续（前端也不给入口）：那只会白花一次钱。"""
        self.seed([observe_result()], status="completed")
        msg = self.assert_refused("无法从检查点续跑")
        self.assertIn("已完成", msg)  # 中文状态词，不许把英文枚举印给用户

    def test_running_run_is_refused(self):
        """正在跑的 run 不给续（幂等闸门：两次点击不许并发烧两份钱）。"""
        self.seed([observe_result()], status="running")
        msg = self.assert_refused("无法从检查点续跑")
        self.assertIn("运行中", msg)

    def test_run_of_another_plan_is_refused(self):
        """run_key 与方案不匹配：拒绝 —— 否则会把别的方案的环节结果拼进这次运行。"""
        self.seed([observe_result()])
        other = {**PLAN, "plan_id": "plan-other000000"}
        self.assert_refused("不属于评估计划", plan=other)

    def test_all_stages_done_is_refused(self):
        """检查点说全部环节都完成了：没有可续的环节。"""
        key = self.write_checkpoint([observe_result(), dataset_result()])
        self.reaped_row(key)
        self.assert_refused("没有可续跑的环节")

    def test_plan_definition_drift_is_refused(self):
        """方案定义改过（环节类型不对位）：拒绝续跑 —— 硬拼会把回归结果说成红队。"""
        self.seed([observe_result()])
        drifted = {**PLAN, "stages": [{"type": "redteam", "cases": [{}]},
                                      {"type": "dataset", "dataset": "faq"}]}
        self.assert_refused("评估计划定义已改动", plan=drifted)

    def test_a_refusal_writes_nothing(self):
        """前置校验失败**不改动任何记录**：那条 error 行原样留着（旧数据不修）。"""
        self.reaped_row(None)
        before = self.item()
        self.assert_refused("没有检查点")
        self.assertEqual(self.item(), before)


# =========================================== 半截环节整环节重跑（§4 首版粒度）

class HalfDoneStageIsRerun(ResumeFixture):
    def test_stopped_stage_is_not_treated_as_done(self):
        """被停止那一环是半截的（写侧照旧把它归档进检查点）—— 续跑必须整环节重跑，
        绝不把半截数字当结论沿用。"""
        key = self.write_checkpoint(
            [observe_result(), dataset_result(status="stopped")])
        self.reaped_row(key, status="stopped")
        ctx = self.planrun.resume_context(RUN_KEY, PLAN)
        self.assertEqual(ctx["stages_done"], 1)
        self.assertEqual([s["type"] for s in ctx["stage_results"]], ["observe"])

        report, calls, _events = self.resume()
        self.assertEqual(calls["observe"], 0)
        self.assertEqual(calls["dataset"], 1, "半截的回归环节没有整环节重跑")
        self.assertEqual(report["stages"][1]["status"], "completed")

    def test_a_checkpoint_with_only_a_half_done_stage_is_refused(self):
        """唯一那一环就是半截的 → 没有任何可沿用的成果，等价于重新发起：明确拒绝。"""
        key = self.write_checkpoint([observe_result(status="stopped")], stage_no=1)
        self.reaped_row(key, status="stopped")
        with self.assertRaises(ValueError) as cm:
            self.planrun.resume_context(RUN_KEY, PLAN)
        self.assertIn("没有可沿用", str(cm.exception))


# ================================================ 停止语义对续跑同样生效

class StopStillWorksWhileResuming(ResumeFixture):
    def test_stop_requested_during_a_resume_converges_to_stopped(self):
        """续跑中的 run 一样受停止约束（环节边界/环节内部检查点都照旧）。"""
        plan = {**PLAN, "stages": PLAN["stages"] + [
            {"type": "dataset", "dataset": "faq", "evaluators": ["correctness"]}]}
        key = self.write_checkpoint([observe_result()])
        self.reaped_row(key)

        def stage2(_stop):
            self.planrun.request_stop(RUN_KEY)   # 第 2 环跑完那一刻用户点了停止
            return dataset_result()

        report, calls, _events = self.resume(plan=plan, dataset=stage2)
        self.assertEqual(report["status"], self.planrun.STOP_STATUS)
        self.assertEqual(calls["dataset"], 1, "停止请求之后又开了第 3 个环节")
        row = self.rows()[0]
        self.assertEqual(row["status"], "stopped")
        self.assertIn("已按用户请求停止", row["error"])
        # 已完成环节（含注入的那一环）的费用照常保留
        self.assertEqual(row["total_cost_usd"], 0.75)

    def test_a_sticky_stop_flag_from_the_dead_attempt_does_not_kill_the_resume(self):
        """上一次的停止标志**粘在同进程缓存里**（stop_requested 读到 True 后不再
        产生读）—— 续跑用的是同一个 run_key，不清缓存就会一开跑立刻「已停止」。"""
        self.seed([observe_result()], status="stopped")
        self.planrun._stop_polls[RUN_KEY] = (time.monotonic(), True)
        report, calls, _events = self.resume()
        self.assertEqual(calls["dataset"], 1,
                         "续跑被上一次的粘滞停止标志掐掉了（一个环节都没跑）")
        self.assertEqual(report["status"], "completed")


# ==================================== 续跑窗口期内再被硬杀 → **仍然可续**（P2 修）
#
# 缺陷（v0.11.0 里就有）：running 标记是**整条 put_item**，而续跑传的
# marker_extra 只有 {started_epoch, attempt, resumed_from} —— 不带
# checkpoint_s3_key ⇒ 从按下续跑到这次续跑的第一个新环节归档成功之间，那一行的
# 指针是空的（窗口 = 一个环节的时长）。窗口内再被硬杀，reaper 走 update 只补终态
# 与原因、**补不回一个已经被清掉的值** ⇒ 续跑入口消失，用户只能整条重跑，前面
# 已付费的环节再付一遍钱。
#
# 本组钉的是**行为**（「还能不能再续」），不是那一行的字段值：把指针写成垃圾串
# 也过不了 —— 第二次续跑要真的从检查点接上、真的不重跑已完成环节。

class _HardKill(BaseException):
    """硬杀的真形态（8h maxLifetime / microVM 回收 / 发版换容器）。

    继承 BaseException：环节循环那个 `except Exception` 抓不到它（抓到了就会被
    折成一条 error 环节结果接着跑，那是「进程还活着」的另一族路径）。真硬杀下
    `finally` 的收敛写根本没机会执行 —— 所以驱动里把 `_converge_interrupted`
    按成 no-op，库里留下的就是那条 running 标记原样。
    """


class AResumeKilledInsideItsOwnWindowStaysResumable(ResumeFixture):
    def kill_inside_the_window(self, run_key: str = RUN_KEY) -> dict:
        """真跑一次续跑，在**第一个新环节归档之前**把进程「杀掉」。

        杀点选在环节体内部：running 标记已落库、`_write_stage_checkpoint` 还轮不到
        —— 正是缺陷窗口的中点。返回被杀那一刻库里的那条记录。
        """
        async def emit(_ev):
            pass

        async def obs(*_a, **_k):
            raise AssertionError("已完成的环节被重跑了（注入没生效）")

        async def ds(_stage, _plan, _agent, _judge, _emit, stop_check=None):
            raise _HardKill("microVM reclaimed")

        ctx = self.planrun.resume_context(run_key, PLAN)
        with mock.patch.object(self.planrun, "_run_observe_stage", obs), \
                mock.patch.object(self.planrun, "_run_dataset_stage", ds), \
                mock.patch.object(self.planrun, "_converge_interrupted",
                                  lambda *a, **k: None), \
                mock.patch.object(self.planrun, "latest_run_summary",
                                  return_value=None):
            with self.assertRaises(_HardKill):
                asyncio.run(self.planrun.execute_plan_run(
                    PLAN, AGENT, "judge-model", "manual", emit,
                    estimate=ESTIMATE, resume=ctx))
        row = self.item(run_key)
        self.assertEqual(row["status"], "running",
                         "硬杀的形态没模拟对：库里已经不是那条 running 标记了")
        return row

    def reap(self, run_key: str = RUN_KEY) -> dict:
        """让**真的** reaper 改判它（`_reap_write` = update 只补终态与原因）。"""
        import stalecheck
        started = int(self.item(run_key)["started_epoch"])
        out = self.planrun.reap_stale_runs(now=started + stalecheck.CEILING_S + 60)
        self.assertIn(run_key, out["reaped"], "reaper 没有改判这条陈旧 running")
        return self.item(run_key)

    def test_a_resume_killed_before_its_first_checkpoint_can_still_be_resumed(self):
        """续跑开跑后中途死掉 → reaper 改判 error → **这条 run 仍然可续**。

        判据走真实链路：`resume_context` 不拒绝（它是「明确报错不半跑」的那道闸门），
        而且**真的再续一次**并跑完 —— 已完成环节仍然 0 次执行（不重跑、不重计费）。
        """
        key = self.seed([observe_result(cost=0.5)])
        self.kill_inside_the_window()
        row = self.reap()
        self.assertEqual(row["status"], "error")

        # ① 后端仍给续：不抛 ValueError，且接上的还是原来那个检查点
        ctx = self.planrun.resume_context(RUN_KEY, PLAN)
        self.assertEqual(ctx["resumed_from"], key)
        self.assertEqual(ctx["stages_done"], 1)
        self.assertEqual(ctx["attempt"], 3, "这是第三次尝试")
        # ② 前端入口仍在：判据 = isResumable(web/src/pages/plan/resume.ts) 的后端
        #    镜像，读的是 list_plan_runs 投影出来的那一行（前端真正拿到的形态）
        front = self.rows()[0]
        self.assertIn(front["status"], self.planrun.RESUMABLE_STATUSES)
        self.assertTrue(str(front["checkpoint_s3_key"] or "").strip(),
                        "前端拿到的那一行没有检查点指针 —— 续跑入口会消失")
        # ③ 真的再续一次：跑完、已付费环节 0 次执行、费用只长剩余环节那一截
        report, calls, _events = self.resume()
        self.assertEqual(calls["observe"], 0,
                         "第二次续跑把已付费的环节又跑了一遍（钱花两次）")
        self.assertEqual(calls["dataset"], 1, "剩余环节没跑")
        self.assertEqual(report["status"], "completed")
        final = self.item()
        self.assertEqual(int(final["attempt"]), 3)
        self.assertEqual(float(final["total_cost_usd"]), 0.75)

    def test_a_resume_that_finishes_still_clears_the_midrun_pointer(self):
        """既有不变量别弄坏：续跑**正常跑完**后，终态整条覆盖写照旧清掉中途字段
        （含检查点指针）—— 于是这条 completed 的 run 不给续（续也只是白花一次钱），
        前端入口天然不出现。"""
        self.seed([observe_result()])
        report, _calls, _events = self.resume()
        self.assertEqual(report["status"], "completed")
        item = self.item()
        for field in ("checkpoint_s3_key", "progress", "heartbeat_epoch",
                      "estimated_duration_s"):
            self.assertNotIn(field, item,
                             f"终态记录残留中途字段 {field}（§5 覆盖即清场被破坏）")
        front = self.rows()[0]
        self.assertIsNone(front["checkpoint_s3_key"])
        with self.assertRaises(ValueError) as cm:
            self.planrun.resume_context(RUN_KEY, PLAN)
        self.assertIn("无法从检查点续跑", str(cm.exception))

    def test_a_first_run_marker_carries_no_checkpoint_pointer(self):
        """首次运行（非续跑）的 running 标记**不带** checkpoint_s3_key：没有可沿用
        的东西，绝不伪造一个指针（那会指向不存在的对象，续跑读它必然失败）。

        钉的同样是行为：第一个环节结束前就被硬杀的那条 run，reaper 改判后
        `resume_context` 必须以「没有检查点」拒绝，而不是半跑。
        """
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        async def obs(*_a, **_k):
            raise _HardKill("microVM reclaimed")

        with mock.patch.object(self.planrun, "_run_observe_stage", obs), \
                mock.patch.object(self.planrun, "_converge_interrupted",
                                  lambda *a, **k: None), \
                mock.patch.object(self.planrun, "latest_run_summary",
                                  return_value=None):
            with self.assertRaises(_HardKill):
                asyncio.run(self.planrun.execute_plan_run(
                    PLAN, AGENT, "judge-model", "manual", emit, estimate=ESTIMATE))

        fresh_key = [e for e in events
                     if e.get("event") == "plan_run_started"][0]["run_key"]
        self.assertNotEqual(fresh_key, RUN_KEY, "首跑该另起一个 run_key")
        marker = self.item(fresh_key)
        self.assertEqual(marker["status"], "running")
        self.assertNotIn("checkpoint_s3_key", marker)
        self.assertNotIn("resumed_from", marker)

        self.reap(fresh_key)
        with self.assertRaises(ValueError) as cm:
            self.planrun.resume_context(fresh_key, PLAN)
        self.assertIn("没有检查点", str(cm.exception))


class SourceGuards(unittest.TestCase):
    src = (Path(__file__).resolve().parent.parent / "app" / "planrun.py").read_text()
    main_src = (Path(__file__).resolve().parent.parent / "app" / "main.py").read_text()

    def test_resume_is_dispatched_in_main(self):
        """main.py 有 resume_plan_run 的分发（与 run_plan 共用同一段前置校验、
        同一层存活契约、同一台事件泵 —— 不另养第二套编排）。"""
        self.assertIn("resume_plan_run", self.main_src)
        self.assertIn("resume_context", self.main_src)

    def test_resume_does_not_hand_build_a_planrun_item(self):
        """摘要项仍只有一个构造点（J4）：续跑走 _planrun_item + extra，不手拼。"""
        lines = [ln for ln in self.src.splitlines()
                 if '"pk": "PLANRUN"' in ln and "Key={" not in ln]
        self.assertEqual(len(lines), 1, f"又出现了第二处手拼：{lines}")

    def test_resume_context_reads_before_it_writes(self):
        """前置校验全部在 resume_context 里（纯读 + 抛错），它在 execute 之外 ——
        「明确报错不半跑」的结构保证：校验没过根本走不到 write-at-start。"""
        body = self.src[self.src.index("def resume_context"):]
        body = body[:body.index("\ndef ", 1)]
        self.assertNotIn("put_item", body)
        self.assertNotIn("update_item", body)


if __name__ == "__main__":
    unittest.main()
