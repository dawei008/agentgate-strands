"""读侧产出键集 × `list_recent_runs` 投影列集：两边互钉（UI-029 批 3）。

为什么要这条守卫（`test_r2_core_projection.py` 那族的教训）：**投影漏一列不会
KeyError**，而是键还在、值悄悄变成缺省值 —— 消费方于是「少一列」而不是「炸一声」。
既有那族用「整项读 vs 投影读」逐键对比钉住它，但对比用的夹具是**终态** run，
而批 1 的三个中途字段（heartbeat_epoch / progress / checkpoint_s3_key）只在
**running** 记录上有值：终态整条 put_item 覆盖即清场（`_planrun_item` 不携带
它们）。于是拿终态夹具比，两边都是 None，漏投影照样全绿。

本文件补两件：
  1. **静态互钉**：`_run_from_item`（含它内部调用的 `stalecheck.is_stale`）真实
     读到的每一个 item 属性，都必须在 ProjectionExpression 的列集里 —— 除了
     刻意省掉的三大块（plan_synthesis / overview / proposals，见既有那族）。
     任一边加字段而另一边不改，这里就红。
  2. **running 夹具的行为对比**：带满中途字段的 running 记录，整项读与投影读
     逐键相等。

旧数据不修：老 run 查无这三个键 → 读出 **None**，不回填、不给 0/{}（
`heartbeat_epoch: 0` 会让前端显示「最后心跳 56 年前」）。也在这里钉。

moto 提供真 DynamoDB（真投影语义），不触任何线上表/桶/Agent/LLM。
Run: python3 -m pytest tests/test_planrun_projection_parity.py -q
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

# 投影刻意省掉的四大块（既有 test_r2_core_projection.SHED 同一份口径；
# synthesis_issues 是 ledger-data 批加的第四块，与 plan_synthesis 同一理由）：
# 没有任何消费方读它们，而 plan_synthesis 是 2-4KB/条的综合报告全文。
SHED = {"plan_synthesis", "overview", "proposals", "synthesis_issues"}

# 批 1 的 progress 写入形态：`json.dumps({...})` 存成**字符串**
# （app/planrun.py:_write_stage_checkpoint —— 与 stage_summaries/overview 同一存法）
PROGRESS = {
    "stages_done": 1, "stages_total": 3, "stage": "observe",
    "stage_summaries_partial": [
        {"type": "observe", "status": "completed", "overall_mean": 0.82,
         "sessions": 6, "summary": {}},
    ],
}


def running_item(plan_id="plan-a", ts="20260826010203", **extra) -> dict:
    """开跑 marker + 批 1 中途字段全带的 **running** 记录。"""
    item = {
        "pk": "PLANRUN", "sk": f"{plan_id}#{ts}",
        "plan_id": plan_id, "plan_name": "线上评估周巡检",
        "agent_name": "support-bot",
        "status": "running", "triggered_by": "manual",
        "started_at": "2026-08-26 01:02 UTC", "started_epoch": 1787706123,
        "stage_summaries": "[]", "overview": "{}", "s3_key": "", "proposals": "[]",
        "agent_version_label": "v1.3", "agent_runtime_arn": "arn:aws:x:runtime/y",
        # 批 1 写侧三件 + 陈旧判定二级判据
        "heartbeat_epoch": 1787706183,
        "progress": json.dumps(PROGRESS, ensure_ascii=False),
        "checkpoint_s3_key": f"checkpoints/{plan_id}/{ts}/stage-1.json",
        "estimated_duration_s": 600,
    }
    item.update(extra)
    return item


class Recorder(dict):
    """记录 `_run_from_item` 真实读到的属性名（`.get()` 与 `[]` 两条路）。"""

    def __init__(self, base):
        super().__init__(base)
        self.touched: set[str] = set()

    def get(self, key, default=None):
        self.touched.add(key)
        return super().get(key, default)

    def __getitem__(self, key):
        self.touched.add(key)
        return super().__getitem__(key)


def projection_columns() -> set[str]:
    """`list_recent_runs` 实际发出的 ProjectionExpression 列集（别名已还原）。"""
    seen: dict = {}

    class FakeTable:
        def query(self, **kwargs):
            seen.update(kwargs)
            return {"Items": []}

    with mock.patch.object(planrun, "_table", return_value=FakeTable()):
        planrun.list_recent_runs()
    expr = seen["ProjectionExpression"]
    names = seen.get("ExpressionAttributeNames") or {}
    cols = {c.strip() for c in expr.split(",")}
    return {names.get(c, c) for c in cols}


class ProjectionCoversEveryReadKey(unittest.TestCase):
    """静态互钉：读侧读到的属性 ⊆ 投影列集 ∪ 刻意省掉的三大块。"""

    def setUp(self):
        self.touched = self._touched_keys()
        self.projected = projection_columns()

    @staticmethod
    def _touched_keys() -> set[str]:
        rec = Recorder(running_item())
        planrun._run_from_item(rec)
        return set(rec.touched)

    def test_guard_is_not_vacuous(self):
        """防恒真：两个集合都非空，且各自带着招牌字段。"""
        self.assertGreater(len(self.touched), 15, self.touched)
        self.assertGreater(len(self.projected), 15, self.projected)
        for key in ("sk", "status", "stage_summaries", "started_epoch",
                    "heartbeat_epoch", "progress", "checkpoint_s3_key"):
            self.assertIn(key, self.touched, f"读侧应当读 {key}")

    def test_every_key_the_read_side_touches_is_projected(self):
        missing = {k for k in self.touched if k not in self.projected} - SHED - {"pk"}
        self.assertEqual(missing, set(),
                         "这些属性读侧要读、投影没给 —— 它们在跨方案 feed 里会"
                         "悄悄变成缺省值（不会报错）：加字段务必同步 "
                         "list_recent_runs 的 ProjectionExpression")

    def test_the_three_unread_blocks_stay_out_of_the_projection(self):
        """省字节是投影的目的：三大块**不许**因为本守卫被顺手加回去。"""
        for key in SHED:
            self.assertNotIn(key, self.projected, key)


@mock_aws()
class RunningRowSurvivesTheProjection(unittest.TestCase):
    def setUp(self):
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

    def test_full_read_and_projected_read_agree_on_a_running_row(self):
        raw = running_item()
        self.table.put_item(Item=raw)
        want = planrun._run_from_item(raw)
        got = planrun.list_recent_runs()[0]
        self.assertEqual(set(got), set(want), "键集合必须一模一样")
        for key in want:
            if key in SHED:
                continue
            self.assertEqual(got[key], want[key], f"字段 {key} 在投影后变了")
        # 招牌字段真的过来了（不是两边都 None 的恒真）
        self.assertEqual(got["progress"]["stages_done"], 1)
        self.assertEqual(got["heartbeat_epoch"], 1787706183)
        self.assertTrue(got["checkpoint_s3_key"].endswith("stage-1.json"))


class ReadSideShapeOfTheThreeInFlightFields(unittest.TestCase):
    """三个中途字段到前端的**真形态**（mock 同刑的依据 + 旧数据不修）。"""

    def test_progress_json_string_becomes_a_dict(self):
        out = planrun._run_from_item(running_item())
        self.assertEqual(out["progress"], PROGRESS)
        self.assertIsInstance(out["heartbeat_epoch"], int)

    def test_old_runs_get_none_not_zero_or_empty(self):
        """老 run 查无此键 → None。**不回填、不给 0/{}**：heartbeat_epoch=0 会
        让前端显示「最后心跳 56 年前」，progress={} 会显示「0/0 环节」。"""
        old = {"pk": "PLANRUN", "sk": "plan-a#20260101000000", "status": "completed",
               "stage_summaries": "[]", "overview": "{}", "proposals": "[]"}
        out = planrun._run_from_item(old)
        self.assertIsNone(out["heartbeat_epoch"])
        self.assertIsNone(out["progress"])
        self.assertIsNone(out["checkpoint_s3_key"])

    def test_unparsable_progress_degrades_to_none_instead_of_exploding(self):
        """进度是增益：一个坏中途字段绝不许让整条运行历史读不出来。"""
        out = planrun._run_from_item(running_item(progress="{不是 JSON"))
        self.assertIsNone(out["progress"])
        # 其余字段照常
        self.assertEqual(out["status"], "running")
        self.assertEqual(out["heartbeat_epoch"], 1787706183)

    def test_non_dict_progress_is_not_passed_through(self):
        """写侧只写对象；读到别的形状（列表/数字）一律降级 None，不往前端漏。"""
        self.assertIsNone(planrun._run_from_item(running_item(progress="[1,2]"))["progress"])


if __name__ == "__main__":
    unittest.main()
