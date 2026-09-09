"""0 分不是「没有分」：run 摘要读侧不许把 score=0 吃成 null。

与「空响应不是 0 分」（blank-output-not-a-zero-score）是**同族的反向**：那条说
「没产出不许算 0 分」，这条说「0 分不许算没产出」。两者共同的口径是
`CONTEXT.md` 那句「一个数是不是结论，由它有没有被算出来决定，不由它的大小决定」。

缺陷行 = `_run_from_item` 的
    "score": float(item["score"]) if item.get("score") else None
`if item.get("score")` 是**真值**判断：0 与「没有」在这里被折成同一件事。
同一模块的兄弟字段（`started_epoch` / `finished_epoch` / `duration_s` /
`heartbeat_epoch`）全都写的是 `is not None`，只有 score / total_cost_usd 用真值 ——
score 这一处由本批改掉。

## 血溅范围的诚实说明（先测后改时实测，别把它说大也别说小）

今天的**写侧**恰好救了它：`_persist` 落库前 `item["score"] = str(round(...))`，
所以 0 分写进去是字符串 `"0.0"` —— 非空字符串是**真**，读回 0.0 正确。
真正被吞的是 score 以 DynamoDB **Number**（boto3 读回 `Decimal`）存放的形态：
`Decimal("0")` 为假 ⇒ 读成 None。所以这是一处**潜伏**的错，不是当天在线上流血的
错：它只等一个把 score 写成数字的写点（DDB 的 N 型本来就合法，`float(...)` 那层
转换正是为了兼容 Decimal），到那天 0 分 run 会在全站显示「—」。

两件都钉住，缺一件这个坑就会以另一种形态回来：
  · 活路径（字符串）—— 真的跑一次全 0 分的线上评估 run，端到端读回 0.0；
  · 潜伏路径（Number）—— DDB 里放一个 N 型的 0，读回 0.0 不是 None。

moto 提供真 DynamoDB（Number 属性的 Decimal 往返也是真的）；S3 打桩。
不碰真表 / 真桶 / 真 agent / 真 LLM。
Run: python3 -m pytest tests/test_planrun_score_zero.py -q
"""

import asyncio
import os
import sys
import unittest
from decimal import Decimal
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
    "stages": [{"type": "observe", "evaluators": ["helpfulness"], "metrics": []}],
}
AGENT = {"agent_name": "support-bot", "agent_arn": "arn:aws:bedrock:x:y:runtime/z"}
SYNTHESIS = "## 整体趋势\n首个数据点，暂无趋势可言。"


def observe_result(mean: float) -> dict:
    """一个跑完的线上评估环节（形状照 _run_observe_stage 的返回值）。

    mean=0.0 是**合法结果**：所有会话都被评估器判了 0 分（评估器打 0 是判定，
    不是「没判」——没判的会话在 observe.py 里是 score=None + errored）。
    """
    return {"type": "observe", "status": "completed", "sessions": 2,
            "summary": {}, "overall_mean": mean, "metrics": None,
            "session_details": [], "analysis": None,
            "evaluators": ["helpfulness"], "metric_keys": []}


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

        import catalog
        import planrun
        self.planrun = planrun
        for p in (mock.patch.object(catalog, "get_table", return_value=self.table),
                  mock.patch.object(planrun, "_table", return_value=self.table),
                  mock.patch.dict(os.environ, {"ARTIFACTS_BUCKET": BUCKET})):
            p.start()
            self.addCleanup(p.stop)
        # S3 打桩：只要「报告落地了」，不验 S3 本身
        self.s3 = mock.MagicMock()
        s = mock.patch.object(planrun.runstore, "_s3", return_value=self.s3)
        s.start()
        self.addCleanup(s.stop)
        planrun._SNAPSHOT_CACHE.clear()
        self.addCleanup(planrun._SNAPSHOT_CACHE.clear)

    def run_plan(self, mean: float) -> dict:
        """真跑一次 execute_plan_run（只把环节执行与综合结论打桩）。"""
        async def emit(_ev):
            pass

        async def fake_observe(stage, agent, judge_model, emit_, stage_no=0):
            return observe_result(mean)

        with mock.patch.object(self.planrun, "_run_observe_stage", fake_observe), \
                mock.patch.object(self.planrun, "_generate_synthesis",
                                  new=mock.AsyncMock(return_value=SYNTHESIS)), \
                mock.patch.object(self.planrun, "latest_run_summary", return_value=None):
            return asyncio.run(self.planrun.execute_plan_run(
                PLAN, AGENT, "judge-model", "manual", emit))

    def put_run(self, sk: str, **extra) -> None:
        """直接落一条 PLANRUN 摘要项（骨架照 _planrun_item 的必备键）。"""
        self.table.put_item(Item={
            "pk": "PLANRUN", "sk": sk,
            "plan_id": PLAN["plan_id"], "plan_name": PLAN["name"],
            "agent_name": PLAN["agent_name"],
            "status": "completed", "triggered_by": "schedule",
            "started_at": "2026-08-20 07:15 UTC",
            "stage_summaries": "[]", "overview": "{}", "s3_key": "", "proposals": "[]",
            **extra})

    def rows(self) -> list[dict]:
        return self.planrun.list_plan_runs(PLAN["plan_id"])


class ZeroIsAScore(Fixture):
    """0 分 run 的三条读路径都得给出 0.0（不是 None、不是「—」）。"""

    def test_an_all_zero_observe_run_reads_back_as_zero(self):
        """活路径端到端：全 0 分的线上评估 run 落库再读回 = 0.0。

        写侧把 score 存成字符串（`str(round(...))` ⇒ `"0.0"`），所以这一条在
        修复前就是绿的 —— 它钉的是「别把写侧改成数字之后没人发现」这一半。
        """
        report = self.run_plan(0.0)
        self.assertEqual(report["stages"][0]["overall_mean"], 0.0)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["score"], 0.0)
        self.assertIsNotNone(rows[0]["score"], "0 分被读成「没有分」")

    def test_a_number_typed_zero_is_not_swallowed(self):
        """潜伏路径（本批的红）：score 以 DDB Number 存 0 → 读回 0.0 不是 None。

        `Decimal("0")` 为**假** ⇒ 真值判断把它折成「没有分」。Number 是 DDB 的
        合法类型，读侧那层 `float(...)` 转换本来就是为了兼容 Decimal。
        """
        self.put_run(f"{PLAN['plan_id']}#20260820071500", score=Decimal("0"))
        row = self.rows()[0]
        self.assertIsNotNone(row["score"], "score=0（Number）被真值判断吃成 None")
        self.assertEqual(row["score"], 0.0)

    def test_a_number_typed_nonzero_still_works(self):
        """防恒真：同形态的非 0 值本来就通得过（红只许出在 0 上）。"""
        self.put_run(f"{PLAN['plan_id']}#20260820071600", score=Decimal("0.74"))
        self.assertEqual(self.rows()[0]["score"], 0.74)

    def test_the_recent_runs_feed_agrees(self):
        """跨方案 feed 走 ProjectionExpression + 同一个 _run_from_item ——
        两条读路径对同一条 run 不许给出两个答案（同一个量两个住址那族）。"""
        self.put_run(f"{PLAN['plan_id']}#20260820071500", score=Decimal("0"))
        feed = self.planrun.list_recent_runs(agent_name=PLAN["agent_name"])
        self.assertEqual(len(feed), 1)
        self.assertEqual(feed[0]["score"], 0.0)


class MissingIsStillMissing(Fixture):
    """反向硬线不许被这次修复带走：**没有**分仍然是 None，绝不变 0.0。"""

    def test_no_score_attribute_reads_none(self):
        """空转 run（无 observe 分）压根不写这个属性 —— 读出 None。"""
        self.put_run(f"{PLAN['plan_id']}#20260819030000")
        self.assertIsNone(self.rows()[0]["score"])

    def test_the_running_marker_has_no_score(self):
        """开跑那条 marker 此刻还没有分 —— 不许伪造 0（运行中显示 0.00 = 撒谎）。"""
        item = self.planrun._planrun_item(PLAN, "k#1", "running", "manual", "t")
        self.assertNotIn("score", item)
        self.assertIsNone(self.planrun._run_from_item({**item, "sk": "k#1"})["score"])


if __name__ == "__main__":
    unittest.main()
