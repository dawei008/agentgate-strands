"""list_plans 出口富化（last_run + estimated_cost_usd）的 join 契约。

工作台方案表的「上次结果」「单次预估 $」两列此前恒为「—」：前端消费端
（LastRunCell / 成本列）早已建好，但 list_plans 从不附带这两个字段。join
住在 app/planrun.py（PLANRUN 分区的投影/sk 模式知识与 estimate 都在那边；
曾因该文件被并行批次占用而暂放 main.py，simplify-r2 J1 搬回），
main.py 的 list_plans action 只调一次 `planrun.attach_plan_extras`。
这里锁死它的行为：

  - last_run = 该 plan 最新一条 PLANRUN（单次分页 query，非每 plan 一查），
    带 stage_summaries —— run 终态前端按环节判定（UI-025），环节炸掉的
    run 不能在方案表里显示成绿色「完成」，光给顶层 status 判不出来。
  - estimated_cost_usd = planrun.estimate_plan_run 合计（纯定义计算）；
    agent 不在册 / 估算抛错 -> None。
  - 任何一步失败都不许拖垮 list_plans 本体。

moto 提供真 DynamoDB（不触任何线上表/桶/Agent/LLM）。
Run: python3 -m pytest tests/test_list_plans_extras.py -q
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import main  # noqa: E402
import planrun  # noqa: E402

TABLE = "eval-catalog-test"
REGION = "us-west-2"

AGENT = {"agent_name": "support-bot", "runtime_arn": "arn:aws:x", "has_logs": True}


def run_item(plan_id: str, ts: str, status: str = "completed",
             score: str | None = "0.86",
             stage_summaries: list | None = None, **extra) -> dict:
    """形状照 planrun._persist 的 DDB item（score 以字符串存、summaries 存 JSON 串）。"""
    item = {
        "pk": "PLANRUN", "sk": f"{plan_id}#{ts}",
        "plan_id": plan_id, "plan_name": "p", "agent_name": "support-bot",
        "status": status, "triggered_by": "manual",
        "started_at": "2026-08-24 09:00 UTC", "finished_at": "2026-08-24 09:01 UTC",
        "stage_summaries": json.dumps(
            stage_summaries if stage_summaries is not None
            else [{"type": "observe", "status": "completed",
                   "overall_mean": 0.86, "sessions": 2, "summary": {}}],
            ensure_ascii=False),
        # 与 _persist 一致：综合报告全文也在摘要项里——join 的投影必须不带它
        "plan_synthesis": "很长的综合报告全文 " * 50,
        **extra,
    }
    if score is not None:
        item["score"] = score
    return item


def plan_row(plan_id: str, agent_name: str = "support-bot") -> dict:
    return {"plan_id": plan_id, "name": f"方案 {plan_id}", "agent_name": agent_name,
            "updated_at": 1, "stages": [{"type": "observe", "max_sessions": 5,
                                         "evaluators": ["helpfulness"]}]}


class Fixture(unittest.TestCase):
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
        p1 = mock.patch.object(planrun, "_table", return_value=self.table)
        p1.start(); self.addCleanup(p1.stop)
        # agent 名录：不触 discovery/AgentCore
        p2 = mock.patch.object(planrun.catalog, "cached_agents",
                               return_value={"agents": [AGENT]})
        p2.start(); self.addCleanup(p2.stop)


class TestLatestRunsByPlan(Fixture):
    def test_newest_run_per_plan_by_sk(self):
        # 三条 run：sk 时间戳字典序 = 时间序（_persist 的 %Y%m%d%H%M%S）
        for ts, score in (("20260820090000", "0.70"),
                          ("20260824090808", "0.86"),
                          ("20260822120000", "0.78")):
            self.table.put_item(Item=run_item("plan-a", ts, score=score))
        self.table.put_item(Item=run_item("plan-b", "20260801000000", score="0.50"))
        latest = planrun._latest_runs_by_plan()
        self.assertEqual(set(latest), {"plan-a", "plan-b"})
        self.assertEqual(latest["plan-a"]["sk"], "plan-a#20260824090808")
        self.assertEqual(str(latest["plan-a"]["score"]), "0.86")

    def test_projection_keeps_join_light(self):
        # 投影只取 join 需要的键——synthesis 全文（每条可达数 KB）绝不进内存
        self.table.put_item(Item=run_item("plan-a", "20260824090808"))
        latest = planrun._latest_runs_by_plan()
        self.assertNotIn("plan_synthesis", latest["plan-a"])
        self.assertIn("stage_summaries", latest["plan-a"])


class TestAttachPlanExtras(Fixture):
    def test_last_run_shape_and_error_stage_passthrough(self):
        # UI-025 实拍形态：顶层 completed，红队环节 error——stage_summaries
        # 必须原样带出，前端才能判成「部分失败」而不是绿色「完成」
        summaries = [
            {"type": "observe", "status": "completed", "overall_mean": 0.81,
             "sessions": 8, "summary": {}},
            {"type": "redteam", "status": "error", "breached": 0, "attacks": 0,
             "verdict": None,
             "error": "ValidationException: Item size has exceeded the maximum allowed size"},
        ]
        self.table.put_item(Item=run_item(
            "plan-a", "20260824090808", score="0.81", stage_summaries=summaries))
        plans = [plan_row("plan-a")]
        planrun.attach_plan_extras(plans)
        lr = plans[0]["last_run"]
        self.assertEqual(lr["run_key"], "plan-a#20260824090808")
        self.assertEqual(lr["status"], "completed")
        self.assertEqual(lr["score"], 0.81)
        self.assertEqual(lr["finished_at"], "2026-08-24 09:01 UTC")
        self.assertEqual(lr["stage_summaries"], summaries)

    def test_no_runs_means_none_not_fabricated(self):
        plans = [plan_row("plan-never-ran")]
        planrun.attach_plan_extras(plans)
        self.assertIsNone(plans[0]["last_run"])

    def test_score_absent_and_skipped_empty_summaries(self):
        # record_skipped_run 形态：无 score、stage_summaries 是 "[]"
        self.table.put_item(Item=run_item(
            "plan-a", "20260824090808", status="skipped", score=None,
            stage_summaries=[], skip_reason="预算超限"))
        plans = [plan_row("plan-a")]
        planrun.attach_plan_extras(plans)
        lr = plans[0]["last_run"]
        self.assertIsNone(lr["score"])
        self.assertEqual(lr["stage_summaries"], [])

    def test_estimate_happy_path_pure_computation(self):
        # observe-only 方案：estimate_plan_run 不碰数据集/Agent，纯定义计算
        # （价目表与目录同一张表，catalog.TABLE_NAME 为空 -> 只用内置价目表）
        plans = [plan_row("plan-a")]
        with mock.patch.object(planrun.catalog, "TABLE_NAME", ""):
            planrun.attach_plan_extras(plans)
        cost = plans[0]["estimated_cost_usd"]
        self.assertIsInstance(cost, float)
        self.assertGreater(cost, 0)

    def test_estimate_unknown_agent_or_failure_is_none(self):
        plans = [plan_row("plan-a", agent_name="ghost-agent")]
        planrun.attach_plan_extras(plans)
        self.assertIsNone(plans[0]["estimated_cost_usd"])

        plans2 = [plan_row("plan-b")]
        with mock.patch.object(planrun, "estimate_plan_run",
                               side_effect=RuntimeError("数据集已删")):
            planrun.attach_plan_extras(plans2)
        self.assertIsNone(plans2[0]["estimated_cost_usd"])

    def test_join_failure_never_breaks_list_plans(self):
        plans = [plan_row("plan-a")]
        with mock.patch.object(planrun, "_latest_runs_by_plan",
                               side_effect=RuntimeError("DDB 挂了")):
            planrun.attach_plan_extras(plans)  # 不抛
        self.assertIsNone(plans[0]["last_run"])


class TestListPlansActionCallsIt(unittest.TestCase):
    """action 出口确实调了这个 join（J1 搬家后调用点从 main 本地函数变成
    planrun.attach_plan_extras —— 漏调的话工作台两列会静默回到「—」）。"""

    def test_action_enriches_before_yielding(self):
        rows = [plan_row("plan-a")]

        def fake_attach(plans):
            plans[0]["last_run"] = "attached"

        async def go():
            with mock.patch.object(main.plan_mod, "list_plans", return_value=rows), \
                    mock.patch.object(main.planrun, "attach_plan_extras",
                                      side_effect=fake_attach) as spy:
                events = [ev async for ev in main.invoke({"action": "list_plans"})]
            return events, spy

        events, spy = asyncio.run(go())
        spy.assert_called_once_with(rows)
        self.assertEqual(events, [{"event": "plans", "plans": rows}])
        self.assertEqual(events[0]["plans"][0]["last_run"], "attached")


if __name__ == "__main__":
    unittest.main()
