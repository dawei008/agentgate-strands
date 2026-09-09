"""planrun 换用 runstore 的守卫与归档：文案与语义逐字不变（S13 后半 + S3 后半）。

两处收敛：
  · 归档块 → `runstore.archive_run(..., noun="报告")`：S3-first、上传返回后才记
    key、失败留痕的措辞，此前 planrun 手搓了一份同形实现。
  · 终态守卫 → `runstore.final_persist_guard(...)`：「终态落库永不 raise，失败记
    在 run 上」这条口径的唯一定义点。

⚠️ 两个名词是**用户可见**的且已在线上，收敛不许碰：
    归档失败 → 「完整报告归档失败：…」（archive_run 的 noun="报告"）
    落库失败 → 「结果落库失败（本次结果未能存档）：…」（守卫的**默认** noun
               「结果」—— 传 noun="报告" 会把这句改掉，那是文案漂移）
留痕字段同理：persist_error（不是 report_error，两者语义相反）。

moto 提供真 DynamoDB / S3。不触任何线上表/桶/Agent/LLM。
Run: python3 -m pytest tests/test_r2_core_final_guard.py -q
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

APP = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(APP))

import catalog  # noqa: E402
import planrun  # noqa: E402
import runstore  # noqa: E402

TABLE = "eval-catalog-test"
BUCKET = "eval-artifacts-test"
REGION = "us-west-2"

PLAN = {"plan_id": "plan-1297bb07bc31", "name": "线上评估周巡检",
        "agent_name": "support-bot"}
STAGES = [{"type": "observe", "status": "completed", "sessions": 2,
           "summary": {}, "overall_mean": 0.83}]


def a_report() -> dict:
    return {"run_key": f"{PLAN['plan_id']}#20260824090808",
            "stages": STAGES, "plan_synthesis": "## 整体趋势\n很长的全文"}


class Fixture(unittest.TestCase):
    def setUp(self):
        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)
        runstore._s3_client = None
        catalog._table = None
        self.addCleanup(setattr, runstore, "_s3_client", None)
        self.addCleanup(setattr, catalog, "_table", None)
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
        for p in (mock.patch.object(catalog, "get_table", return_value=self.table),
                  mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": BUCKET})):
            p.start()
            self.addCleanup(p.stop)

    def persist(self, report=None, **kw):
        report = report if report is not None else a_report()
        self.report = report
        return planrun._persist(PLAN, f"{PLAN['plan_id']}#ts", "ts", "manual",
                                "2026-08-24 09:08 UTC", "2026-08-24 09:21 UTC",
                                1.4321, STAGES, {"stage_lines": []}, report, **kw)

    def stored(self, sk: str | None = None) -> dict:
        return self.table.get_item(Key={"pk": "PLANRUN",
                                        "sk": sk or f"{PLAN['plan_id']}#ts"})["Item"]


class ArchiveThroughRunstore(Fixture):
    def test_key_shape_and_body_are_unchanged(self):
        key = self.persist()
        self.assertEqual(key, f"reports/{PLAN['plan_id']}/ts.json")
        obj = boto3.client("s3", region_name=REGION).get_object(
            Bucket=BUCKET, Key=key)
        self.assertEqual(obj["ContentType"], "application/json; charset=utf-8")
        self.assertEqual(json.loads(obj["Body"].read()), a_report())
        self.assertEqual(self.stored()["s3_key"], key)

    def test_upload_failure_says_完整报告归档失败_verbatim(self):
        with mock.patch.object(runstore, "_s3") as s3:
            s3.return_value.put_object.side_effect = RuntimeError("denied")
            key = self.persist()
        self.assertIsNone(key, "上传失败还记了 key → 摘要项指向不存在的对象")
        item = self.stored()
        self.assertEqual(item["s3_key"], "")
        self.assertEqual(item["report_error"], "完整报告归档失败：denied")
        self.assertEqual(item["status"], "completed", "归档失败不许改 run 的状态")

    def test_unconfigured_bucket_says_完整报告无法归档_verbatim(self):
        with mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": ""}):
            key = self.persist()
        self.assertIsNone(key)
        self.assertEqual(self.stored()["report_error"],
                         "ARTIFACTS_BUCKET 未配置，完整报告无法归档")

    def test_the_noun_is_not_the_default_one(self):
        """裸替（忘传 noun）会写成「完整明细…」—— 那是用户可见的文案漂移。"""
        with mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": ""}):
            self.persist()
        self.assertNotIn("完整明细", self.stored()["report_error"])


class GuardThroughRunstore(Fixture):
    def _flaky_table(self, fail_from: int):
        real_put = self.table.put_item
        calls = {"n": 0}

        def put(**kw):
            calls["n"] += 1
            if calls["n"] >= fail_from:
                raise RuntimeError("ProvisionedThroughputExceededException")
            return real_put(**kw)

        table = mock.MagicMock(wraps=self.table)
        table.put_item.side_effect = put
        table.get_item.side_effect = self.table.get_item
        return table

    def test_summary_failure_degrades_and_never_raises(self):
        """第一次 put 失败 → 降级摘要项落库（带 s3_key，报告不孤儿），不抛。"""
        table = self._flaky_table(fail_from=1)
        real_put = self.table.put_item
        table.put_item.side_effect = [
            RuntimeError("throttled"), real_put]  # 第 2 次真写
        with mock.patch.object(planrun, "_table", return_value=table):
            key = self.persist()
        self.assertEqual(key, f"reports/{PLAN['plan_id']}/ts.json")
        self.assertNotIn("persist_error", self.report, "降级成功不许留落库失败")

    def test_total_failure_is_recorded_on_the_run_verbatim(self):
        """连降级都写不进去 → 不抛，文案与字段逐字不变（守卫用默认名词「结果」）。"""
        table = self._flaky_table(fail_from=1)
        with mock.patch.object(planrun, "_table", return_value=table), \
                self.assertLogs("eval-anything", level="ERROR"):
            key = self.persist()
        self.assertEqual(key, f"reports/{PLAN['plan_id']}/ts.json",
                         "报告在 S3，s3_key 必须照旧随终帧返回")
        note = self.report["persist_error"]
        self.assertTrue(note.startswith("结果落库失败（本次结果未能存档）："), note)
        self.assertIn("ProvisionedThroughputExceededException", note)
        # 不许换成「报告落库失败」：那是另一句话
        self.assertNotIn("报告落库失败", note)

    def test_the_trace_field_is_persist_error_not_report_error(self):
        """report_error 的语义正好相反（「报告缺失但摘要可用」，5 处活消费方）。"""
        table = self._flaky_table(fail_from=1)
        with mock.patch.object(planrun, "_table", return_value=table), \
                self.assertLogs("eval-anything", level="ERROR"):
            self.persist()
        self.assertIn("persist_error", self.report)
        self.assertNotIn("report_error", self.report)

    def test_a_base_exception_still_gets_out(self):
        """守卫只吞 Exception：容器被回收（BaseException）不许被静默记成落库失败。"""
        table = mock.MagicMock()
        table.put_item.side_effect = KeyboardInterrupt()
        with mock.patch.object(planrun, "_table", return_value=table):
            with self.assertRaises(KeyboardInterrupt):
                self.persist()
        self.assertNotIn("persist_error", self.report)


class OneHomeForEachRule(unittest.TestCase):
    def test_planrun_borrows_both_helpers(self):
        body = (APP / "planrun.py").read_text()
        body = body[body.index("def _persist("):body.index("def record_skipped_run(")]
        self.assertIn("runstore.archive_run(", body)
        self.assertIn("runstore.final_persist_guard(", body)

    def test_no_hand_rolled_guard_left(self):
        """手搓形态的两个标志：自己拼那句留痕、自己 put_object。
        只看**代码行** —— 注释里引用这两句（说明不许改动它们）是有意的。"""
        code = [ln for ln in (APP / "planrun.py").read_text().splitlines()
                if not ln.lstrip().startswith("#")]
        for mark in ("落库失败（本次", "put_object("):
            hits = [ln for ln in code if mark in ln]
            self.assertEqual(hits, [], f"planrun 仍手搓 {mark}：{hits}")

    def test_the_two_sentences_live_in_runstore(self):
        src = (APP / "runstore.py").read_text()
        self.assertIn('f"完整{noun}归档失败：{str(e)[:200]}"', src)
        self.assertIn('f"{noun}落库失败（本次{noun}未能存档）：{str(e)[:300]}"', src)


if __name__ == "__main__":
    unittest.main()
