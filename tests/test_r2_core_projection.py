"""`list_recent_runs` 的投影：省掉没人读的三大块，其余逐字段零损失（E1）。

背景（simplify-r2 效率镜头 E1）
  这个 feed 是全站唯一的**常驻轮询**读：大屏 30s + refetchIntervalInBackground，
  外加工作台与 Agents 列表各自一次。它此前读 PLANRUN 分区至 500 条**全属性** item，
  逐条 json.loads —— 而摘要项里的 plan_synthesis 是综合报告全文（2-4KB/条，
  planrun._persist 的注释自证），overview / proposals 又各是一段 JSON，四个消费方
  （工作台 / Agents 列表 / Agent 详情 RunsBlock / 大屏）**一个都不读**。

  所以加投影。风险全在「少投了一个字段」：消费方会悄悄少一列，而且 run 终态判定
  就靠 stage_summaries（UI-025，环节炸掉的 run 不许显示成绿色「完成」）。本文件用
  「整项读 vs 投影读」逐键对比钉住这条 —— 加字段忘了同步投影，这里就红。

moto 提供真 DynamoDB（真投影语义），不触任何线上表/桶/Agent/LLM。
Run: python3 -m pytest tests/test_r2_core_projection.py -q
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import planrun  # noqa: E402

TABLE = "eval-catalog-test"
REGION = "us-west-2"

# 没人读的四大块（synthesis_issues 为 ledger-data 批新增）：投影省掉它们，
# _run_from_item 于是给出缺省值
SHED = {"plan_synthesis": None, "overview": {}, "proposals": [], "synthesis_issues": []}

SYNTHESIS = "## 整体趋势\n很长的综合报告全文。" * 60  # ~2KB，现场真实量级


def full_item(plan_id="plan-a", ts="20260824090808", **extra) -> dict:
    """一条**全字段**终态摘要项（形状照 planrun._persist 的 put_item）。"""
    item = {
        "pk": "PLANRUN", "sk": f"{plan_id}#{ts}",
        "plan_id": plan_id, "plan_name": "线上评估周巡检",
        "agent_name": "support-bot",
        "status": "completed", "triggered_by": "manual",
        "started_at": "2026-08-24 09:08 UTC", "finished_at": "2026-08-24 09:21 UTC",
        "started_epoch": 1787000880, "finished_epoch": 1787001660,
        "duration_s": 780,
        "score": "0.8125",
        "total_cost_usd": "1.4321",
        "stage_summaries": json.dumps(
            [{"type": "observe", "status": "completed", "overall_mean": 0.8125,
              "sessions": 8, "summary": {}},
             {"type": "redteam", "status": "error", "breached": 0, "attacks": 0,
              "verdict": None, "error": "ValidationException: Item size ..."}],
            ensure_ascii=False),
        "overview": json.dumps({"stage_lines": [{"type": "observe", "text": "评估 8 个会话"}],
                                "previous_run": None}, ensure_ascii=False),
        "proposals": json.dumps([{"summary": "补充多轮上下文", "generated_at": "x",
                                  "adopted_at": None}], ensure_ascii=False),
        "plan_synthesis": SYNTHESIS,
        "synthesis_issues": json.dumps([{"id": "a1b2c3d4", "problem": "x", "evidence": [],
                                         "root_cause": "y", "recommendation": "z",
                                         "fix_type": "OTHERS", "first_seen_run": "k",
                                         "last_seen_run": "k", "occurrences": 1,
                                         "depends_on": [], "status": "open"}]),
        "s3_key": f"reports/{plan_id}/{ts}.json",
    }
    item.update(extra)
    return item


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


class RecentRunsProjection(Fixture):
    def test_every_other_field_is_byte_identical_to_a_full_read(self):
        raw = full_item()
        self.table.put_item(Item=raw)
        want = planrun._run_from_item(raw)          # 整项读（投影前的行为）
        got = planrun.list_recent_runs()[0]         # 投影读（现在的行为）
        self.assertEqual(set(got), set(want), "键集合必须一模一样")
        for key in want:
            if key in SHED:
                continue
            self.assertEqual(got[key], want[key], f"字段 {key} 在投影后变了")

    def test_only_the_three_unread_blocks_are_shed(self):
        self.table.put_item(Item=full_item())
        got = planrun.list_recent_runs()[0]
        for key, absent_value in SHED.items():
            self.assertEqual(got[key], absent_value, key)

    def test_the_2kb_synthesis_never_leaves_dynamodb(self):
        """省字节是本条的**目的**：投影没生效时这里会看到全文。"""
        self.table.put_item(Item=full_item())
        seen = []
        real = planrun._run_from_item
        with mock.patch.object(planrun, "_run_from_item",
                               side_effect=lambda i: seen.append(i) or real(i)):
            planrun.list_recent_runs()
        self.assertEqual(len(seen), 1)
        for key in SHED:
            self.assertNotIn(key, seen[0], f"{key} 还是被拉回来了")

    def test_stage_summaries_survive_for_the_ui_025_verdict(self):
        """环节摘要是 run 终态判定的原料，投影少了它 run 会显示成绿色「完成」。"""
        self.table.put_item(Item=full_item())
        stages = planrun.list_recent_runs()[0]["stage_summaries"]
        self.assertEqual([s["type"] for s in stages], ["observe", "redteam"])
        self.assertEqual(stages[1]["status"], "error")

    def test_sort_tie_break_still_reads_started_epoch(self):
        """同一分钟内的两条 run 按 started_epoch 排 —— 该字段必须在投影里。"""
        self.table.put_item(Item=full_item("plan-a", "20260824090801",
                                           started_epoch=1787000881))
        self.table.put_item(Item=full_item("plan-b", "20260824090859",
                                           started_epoch=1787000899))
        runs = planrun.list_recent_runs()
        self.assertEqual([r["plan_id"] for r in runs], ["plan-b", "plan-a"])

    def test_agent_name_filter_still_works(self):
        self.table.put_item(Item=full_item("plan-a"))
        self.table.put_item(Item=full_item("plan-b", agent_name="other-bot"))
        runs = planrun.list_recent_runs(agent_name="other-bot")
        self.assertEqual([r["plan_id"] for r in runs], ["plan-b"])

    def test_running_marker_row_has_no_fabricated_numbers(self):
        """开跑那条最小记录（无 score / 无 finished）经投影后仍是空值，不是 0。"""
        self.table.put_item(Item={
            "pk": "PLANRUN", "sk": "plan-a#20260824091000",
            "plan_id": "plan-a", "plan_name": "p", "agent_name": "support-bot",
            "status": "running", "triggered_by": "manual",
            "started_at": "2026-08-24 09:10 UTC", "started_epoch": 1787001000,
            "stage_summaries": "[]", "overview": "{}", "s3_key": "", "proposals": "[]"})
        row = planrun.list_recent_runs()[0]
        self.assertEqual(row["status"], "running")
        self.assertIsNone(row["score"])
        self.assertIsNone(row["duration_s"])
        self.assertIsNone(row["total_cost_usd"])
        self.assertEqual(row["stage_summaries"], [])


class PlanRunsListStaysFat(Fixture):
    """`list_plan_runs` **不投影**：方案页要综合报告全文，免得再拉一次 S3
    （planrun._persist 里那条注释就是它的契约）。"""

    def test_plan_synthesis_still_comes_back(self):
        self.table.put_item(Item=full_item())
        run = planrun.list_plan_runs("plan-a")[0]
        self.assertEqual(run["plan_synthesis"], SYNTHESIS)
        self.assertTrue(run["overview"]["stage_lines"])
        self.assertEqual(len(run["proposals"]), 1)

    def test_latest_run_summary_also_untouched(self):
        self.table.put_item(Item=full_item())
        self.assertEqual(planrun.latest_run_summary("plan-a")["plan_synthesis"],
                         SYNTHESIS)


if __name__ == "__main__":
    unittest.main()
