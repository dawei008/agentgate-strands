"""S3 前半：`archive_run` 的名词参数化（simplify-r2 Track B）。

planrun 手搓了一遍 runstore 的 S3-first 归档，连失败文案都是同一句、只有名词不同
（「完整报告归档失败」vs「完整明细归档失败」）。两个评审在 simplify-r1 都独立警告
过：**不能裸替** —— `report_error` 里的名词是**用户可见**的，而当时唯一相关的测试
只断言 `"归档失败" in report_error`，两种拼法都能过，所以测试拦不住这个错。

所以本文件的每一条都断言**完整名词**：默认 noun 逐字复现 runstore 现有的两句
（既有调用方输出零变化），noun="报告" 逐字复现 planrun 现在的两句（Track A 换用时
文案不会漂）。planrun 的换用不在本批。

Run: python3 -m pytest tests/test_r2_infra_archive_noun.py -q
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

import runstore  # noqa: E402

REGION = "us-west-2"
BUCKET = "eval-artifacts-test"

# 52a5bcf 原文（预言机）：runstore.py:276/284 与 planrun.py:1091/1093
RUNSTORE_UNSET = "ARTIFACTS_BUCKET 未配置，完整明细无法归档"
RUNSTORE_FAILED = "完整明细归档失败：{}"
PLANRUN_UNSET = "ARTIFACTS_BUCKET 未配置，完整报告无法归档"
PLANRUN_FAILED = "完整报告归档失败：{}"


def a_run() -> dict:
    return {"run_id": "rt-20260825110000", "status": "completed",
            "results": [{"case_name": "esc_1", "score": 0.8}]}


class DefaultNounKeepsExistingCallersByteIdentical(unittest.TestCase):
    def setUp(self):
        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)
        runstore._s3_client = None
        self.addCleanup(setattr, runstore, "_s3_client", None)

    def test_unconfigured_bucket_says_明细(self):
        with mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": ""}):
            key, err = runstore.archive_run(a_run(), "redteam-runs", "rt-1")
        self.assertIsNone(key)
        self.assertEqual(err, RUNSTORE_UNSET)

    def test_upload_failure_says_明细_and_clips_at_200(self):
        with mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": BUCKET}):
            with mock.patch.object(runstore, "_s3") as s3:
                s3.return_value.put_object.side_effect = RuntimeError("拒" * 400)
                with self.assertLogs("eval-anything", level="ERROR"):
                    key, err = runstore.archive_run(a_run(), "redteam-runs", "rt-1")
        self.assertIsNone(key)
        self.assertEqual(err, RUNSTORE_FAILED.format("拒" * 200))

    def test_success_path_is_unchanged(self):
        s3 = boto3.client("s3", region_name=REGION)
        s3.create_bucket(Bucket=BUCKET,
                         CreateBucketConfiguration={"LocationConstraint": REGION})
        run = a_run()
        with mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": BUCKET}):
            key, err = runstore.archive_run(run, "/redteam-runs/", run["run_id"])
        self.assertEqual(key, f"redteam-runs/{run['run_id']}.json")
        self.assertIsNone(err)
        body = s3.get_object(Bucket=BUCKET, Key=key)
        self.assertEqual(json.loads(body["Body"].read())["status"], "completed")
        self.assertEqual(body["ContentType"], "application/json; charset=utf-8")

    def test_prepared_body_is_still_reused_verbatim(self):
        s3 = boto3.client("s3", region_name=REGION)
        s3.create_bucket(Bucket=BUCKET,
                         CreateBucketConfiguration={"LocationConstraint": REGION})
        with mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": BUCKET}):
            key, err = runstore.archive_run(a_run(), "test-runs", "r1",
                                            body='{"已序列化": true}')
        self.assertIsNone(err)
        self.assertEqual(s3.get_object(Bucket=BUCKET, Key=key)["Body"].read(),
                         '{"已序列化": true}'.encode())


class ThirdFormCanAdoptWithoutTextDrift(unittest.TestCase):
    """noun="报告" 必须逐字等于 planrun 现在写的那两句（Track A 换用时的前置）。"""

    def setUp(self):
        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)
        runstore._s3_client = None
        self.addCleanup(setattr, runstore, "_s3_client", None)

    def test_unconfigured_bucket_says_报告(self):
        with mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": ""}):
            _, err = runstore.archive_run(a_run(), "plan-reports", "p1#ts",
                                          noun="报告")
        self.assertEqual(err, PLANRUN_UNSET)

    def test_upload_failure_says_报告(self):
        with mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": BUCKET}):
            with mock.patch.object(runstore, "_s3") as s3:
                s3.return_value.put_object.side_effect = RuntimeError("denied")
                with self.assertLogs("eval-anything", level="ERROR"):
                    _, err = runstore.archive_run(a_run(), "plan-reports", "p1#ts",
                                                  noun="报告")
        self.assertEqual(err, PLANRUN_FAILED.format("denied"))

    def test_the_two_spellings_are_distinguishable(self):
        """裸替（忘了传 noun）必须能被看见 —— 这正是 r1 两个评审警告的那个错。"""
        with mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": ""}):
            default = runstore.archive_run(a_run(), "p", "x")[1]
            report = runstore.archive_run(a_run(), "p", "x", noun="报告")[1]
        self.assertNotEqual(default, report)
        self.assertIn("完整明细", default)
        self.assertIn("完整报告", report)
        # 「归档失败」这三个字两种拼法都有 —— 只断言它等于什么都没断言
        self.assertIn("归档", default)
        self.assertIn("归档", report)

    def test_noun_is_keyword_only(self):
        """名词不许挤进位置参数（body 之后再加位置参数迟早传错）。"""
        with self.assertRaises(TypeError):
            runstore.archive_run(a_run(), "p", "x", None, "报告")


class RunItemStillSaysMingxi(unittest.TestCase):
    """端到端：RUN / RTRUN 的 detail_error 文案零变化（含完整名词）。"""

    def setUp(self):
        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)
        self.table = boto3.resource("dynamodb", region_name=REGION).create_table(
            TableName="eval-catalog-test",
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST")
        runstore._ARCHIVE_COVER.clear()
        self.addCleanup(runstore._ARCHIVE_COVER.clear)
        runstore._s3_client = None
        self.addCleanup(setattr, runstore, "_s3_client", None)

    def test_terminal_save_records_the_full_noun_on_the_item(self):
        with mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": BUCKET}):
            with mock.patch.object(runstore, "_s3") as s3:
                s3.return_value.put_object.side_effect = RuntimeError("denied")
                with self.assertLogs("eval-anything", level="ERROR"):
                    runstore.save_final(self.table, "RTRUN", a_run(),
                                        s3_prefix="redteam-runs")
        stored = json.loads(self.table.get_item(
            Key={"pk": "RTRUN", "sk": "rt-20260825110000"})["Item"]["data"])
        self.assertEqual(stored["detail_error"], RUNSTORE_FAILED.format("denied"))
        self.assertEqual(stored["status"], "completed")


class OneSentenceTemplate(unittest.TestCase):
    src = (APP / "runstore.py").read_text()

    # 断言写成 assertTrue(... in src, "短消息")：assertIn 失败时会把整份源码
    # 打进报告里，读都读不完。
    def test_the_sentence_is_built_from_the_noun_parameter(self):
        self.assertTrue('f"完整{noun}归档失败：' in self.src,
                        "归档失败文案没有从 noun 参数拼出来")
        self.assertTrue('f"ARTIFACTS_BUCKET 未配置，完整{noun}无法归档"' in self.src,
                        "桶未配置的文案没有从 noun 参数拼出来")

    def test_no_hardcoded_明细_left_in_archive_run(self):
        at = self.src.index("def archive_run(")
        body = self.src[at:self.src.index("\n\n\n", at)]
        self.assertNotIn("完整明细", body.split('"""')[-1],
                         "archive_run 的代码里还留着写死的名词")
        self.assertTrue('noun: str = "明细"' in body,
                        "默认名词不是「明细」——既有调用方文案会漂")


if __name__ == "__main__":
    unittest.main()
