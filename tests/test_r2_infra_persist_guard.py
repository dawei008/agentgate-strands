"""S13 前半：终态落库的守卫抽成 `runstore.final_persist_guard`（Track B）。

「终态落库永不 raise」这条口径有三个形态：runstore.save_final（RUN / RTRUN）与
planrun 自写的第三份（打字段摘要项 + 独立 full_report + 返回 s3_key，复用不可行，
裁决见 simplify-r1 backlog S13）。本批只抽守卫、只让 save_final 内部改用它 ——
**planrun 采用归 Track A**，所以这里同时钉住「守卫已经能承接第三形态的参数」
（noun / field / ident 三个位）。

为什么这条口径值钱：2026-08-24 的事故就是终态 put_item 抛出去，把一次已经花完钱
的运行变成一条裸 error —— 结果早已产出、也照样返回给了调用方，落库失败该记**在
run 上**，不该带着运行一起倒下。

Run: python3 -m pytest tests/test_r2_infra_persist_guard.py -q
"""

import contextlib
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
TABLE = "eval-catalog-test"

# 52a5bcf 的 app/runstore.py:397 原文（预言机：一个字都不许变）
def pre_change_sentence(msg: str) -> str:
    return f"结果落库失败（本次结果未能存档）：{msg[:300]}"


def a_run(run_id="rt-20260825090000") -> dict:
    return {"run_id": run_id, "agent": "dsh-agent", "status": "completed",
            "attacks": 2, "breached": 1, "verdict": "FAIL",
            "results": [{"case_name": "esc_1", "score": 0.8,
                         "conversation": [{"role": "attacker", "content": "越权"}]}],
            "live_turns": [{"case": "attack#1", "role": "target",
                            "message": "我不能这么做", "turn_no": 1}]}


class GuardIsAReusableContextManager(unittest.TestCase):
    def test_it_is_a_context_manager(self):
        self.assertTrue(hasattr(runstore, "final_persist_guard"))
        with runstore.final_persist_guard({}, "RUN/x"):
            pass

    def test_happy_path_leaves_the_run_untouched(self):
        run = a_run()
        before = json.dumps(run, ensure_ascii=False, sort_keys=True)
        with runstore.final_persist_guard(run, "RUN/x"):
            pass
        self.assertEqual(json.dumps(run, ensure_ascii=False, sort_keys=True), before)

    def test_a_failure_is_recorded_on_the_run_not_raised(self):
        run = a_run()
        with self.assertLogs("eval-anything", level="ERROR"):
            with runstore.final_persist_guard(run, "RTRUN/rt-1"):
                raise RuntimeError("ProvisionedThroughputExceededException")
        self.assertEqual(run["persist_error"],
                         pre_change_sentence("ProvisionedThroughputExceededException"))

    def test_the_reason_is_clipped_at_300_chars(self):
        run = a_run()
        with self.assertLogs("eval-anything", level="ERROR"):
            with runstore.final_persist_guard(run, "RUN/x"):
                raise RuntimeError("长" * 500)
        self.assertEqual(run["persist_error"], pre_change_sentence("长" * 500))
        self.assertEqual(run["persist_error"].count("长"), 300)

    def test_the_log_line_names_the_record(self):
        run = a_run()
        with self.assertLogs("eval-anything", level="ERROR") as logs:
            with runstore.final_persist_guard(run, "RTRUN/rt-20260825090000"):
                raise RuntimeError("boom")
        self.assertIn("final persist failed (RTRUN/rt-20260825090000)",
                      "\n".join(logs.output))

    def test_noun_and_field_are_parameterised_for_the_third_form(self):
        """planrun 的第三形态（Track A 采用）：名词与留痕字段都是参数位。"""
        report = {}
        with self.assertLogs("eval-anything", level="ERROR"):
            with runstore.final_persist_guard(report, "PLANRUN/p#1", noun="摘要",
                                              field="summary_error"):
                raise RuntimeError("x")
        self.assertEqual(report, {"summary_error": "摘要落库失败（本次摘要未能存档）：x"})

    def test_defaults_reproduce_the_existing_wording(self):
        run = {}
        with self.assertLogs("eval-anything", level="ERROR"):
            with runstore.final_persist_guard(run, "RUN/x"):
                raise RuntimeError("y")
        self.assertEqual(list(run), ["persist_error"])
        self.assertEqual(run["persist_error"], pre_change_sentence("y"))

    def test_a_lambda_timeout_signal_still_propagates(self):
        """守卫只吞 Exception：KeyboardInterrupt / SystemExit 这类必须照旧穿过去，
        否则容器被回收时会被静默记成一次「落库失败」。"""
        run = {}
        with self.assertRaises(KeyboardInterrupt):
            with runstore.final_persist_guard(run, "RUN/x"):
                raise KeyboardInterrupt
        self.assertEqual(run, {})


class SaveFinalUsesTheGuard(unittest.TestCase):
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
        self.s3 = boto3.client("s3", region_name=REGION)
        self.s3.create_bucket(Bucket=BUCKET,
                              CreateBucketConfiguration={"LocationConstraint": REGION})
        p = mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": BUCKET})
        p.start()
        self.addCleanup(p.stop)
        runstore._ARCHIVE_COVER.clear()
        self.addCleanup(runstore._ARCHIVE_COVER.clear)

    def test_terminal_save_still_writes_item_and_archive(self):
        run = a_run()
        self.assertIsNone(runstore.save_final(self.table, "RTRUN", run,
                                              s3_prefix="redteam-runs"))
        self.assertNotIn("persist_error", run)
        item = self.table.get_item(Key={"pk": "RTRUN", "sk": run["run_id"]})["Item"]
        self.assertEqual(json.loads(item["data"])["verdict"], "FAIL")
        self.assertEqual([o["Key"] for o in
                          self.s3.list_objects_v2(Bucket=BUCKET)["Contents"]],
                         [f"redteam-runs/{run['run_id']}.json"])

    def test_a_broken_table_never_takes_the_finished_run_down(self):
        run = a_run()
        broken = mock.Mock()
        broken.put_item.side_effect = RuntimeError("ValidationException: nope")
        with self.assertLogs("eval-anything", level="ERROR"):
            runstore.save_final(broken, "RTRUN", run, s3_prefix="redteam-runs")
        # 结果一条不丢（照旧交回调用方），失败只记在 run 上
        self.assertEqual(run["status"], "completed")
        self.assertEqual(len(run["results"]), 1)
        self.assertEqual(run["persist_error"],
                         pre_change_sentence("ValidationException: nope"))
        # 明细仍已归档：终态 archive 在 put_item 之前（顺序不变量）
        self.assertEqual([o["Key"] for o in
                          self.s3.list_objects_v2(Bucket=BUCKET)["Contents"]],
                         [f"redteam-runs/{run['run_id']}.json"])

    def test_the_minimal_item_fallback_is_still_tried_first(self):
        """既有两级兜底：put_item 失败先降级成最小项，只有它也失败才记 persist_error。"""
        run = a_run()
        calls = []

        def flaky(Item):
            calls.append(Item)
            if len(calls) == 1:
                raise RuntimeError("throttled")
            return {}

        table = mock.Mock()
        table.put_item.side_effect = flaky
        with self.assertLogs("eval-anything", level="ERROR"):
            runstore.save_final(table, "RUN", run, s3_prefix="test-runs")
        self.assertEqual(len(calls), 2)
        self.assertTrue(json.loads(calls[1]["data"])["detail_truncated"])
        self.assertNotIn("persist_error", run)


class GuardIsTheOneDefinition(unittest.TestCase):
    src = (APP / "runstore.py").read_text()

    def test_save_final_delegates_to_the_guard(self):
        at = self.src.index("def save_final(")
        body = self.src[at:self.src.index("\n\n\n", at)]
        self.assertIn("with final_persist_guard(", body)
        self.assertNotIn("except Exception", body)
        # 文案与字段名只在守卫里落地（docstring 里提一句 persist_error 是契约说明）
        self.assertNotIn('run["persist_error"] =', body)
        self.assertNotIn("落库失败", body)

    def test_the_guard_uses_contextlib(self):
        self.assertIn("@contextlib.contextmanager", self.src)
        self.assertIn("import contextlib", self.src)

    def test_the_sentence_has_one_home_in_runstore(self):
        self.assertEqual(self.src.count("落库失败（本次"), 1)


if __name__ == "__main__":
    unittest.main()
