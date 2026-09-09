"""Oversized runs must persist, not vanish (P1: 2026-08-24 data loss).

Incident: a 20-attack red-team run (10-16 turns each, target replies up to ~1.3KB)
serialized to a 2.1MB DynamoDB item. PutItem answered

    ValidationException: Item size has exceeded the maximum allowed size

the exception escaped the run executor, the plan stage collapsed to
{type, status: error, error} and every transcript was lost — after ~$1.81 of
real attacks had been paid for.

These tests use moto's real DynamoDB + S3 (moto enforces the 400KB item limit,
verified) so the failure mode is reproduced rather than mocked away. Nothing here
touches a live table, bucket, agent, or LLM.

Run: python3 -m pytest tests/test_run_persist_size.py -q
"""

import json
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
DDB_LIMIT = 400 * 1024

# ~2000 chars/turn of Chinese, matching the incident's shape (CJK is ~3 bytes
# per char in UTF-8, which is what actually blows the byte-counted limit).
FILLER = "被测智能体在本轮对话里给出了完整回复，包含策略解释、边界说明与拒绝话术。"


def text(n: int) -> str:
    return (FILLER * (n // len(FILLER) + 1))[:n]


def big_redteam_run(run_id="rt-20260824090808", attacks=20, turns=16,
                    content=2000, status="completed") -> dict:
    """The incident, reproduced at its documented scale (20 x 16 x ~2000 chars)."""
    return {
        "run_id": run_id, "agent": "dsh-agent",
        "strategies": ["gradual_escalation"],
        "risk_categories": ["guideline_bypass"],
        "judge_model": "us.anthropic.claude-sonnet-4-5",
        "cases": [{"name": f"guideline_bypass_{i}", "input": text(300),
                   "risk_category": "guideline_bypass", "actor_goal": text(200),
                   "context": text(250), "severity": "high",
                   "success_criteria": text(180)} for i in range(attacks)],
        "status": status,
        "started_at": "2026-08-24 09:08 UTC", "started_epoch": 1787000888,
        "finished_at": "2026-08-24 09:41 UTC", "finished_epoch": 1787002888,
        "duration_s": 2000,
        "attacks": attacks, "completed": attacks, "judged": attacks,
        "errored": 0, "silenced": 0, "target_unreachable": 0,
        "attacker_declined": 0, "breached": 3, "breach_rate": 0.15,
        "verdict": "FAIL", "actual_cost_usd": 1.81,
        "estimate": {"attacks": attacks, "estimated_cost_usd": 0.62},
        "live_turns": [{"case": f"attack#{i % attacks + 1}", "role": "target",
                        "message": text(1500), "turn_no": i % turns + 1}
                       for i in range(attacks * turns)],
        "results": [{
            "case_name": f"guideline_bypass_{i}__gradual_escalation",
            "base_case": f"guideline_bypass_{i}",
            "risk_category": "guideline_bypass", "strategy": "gradual_escalation",
            "severity": "high", "objective": text(200),
            "success_criteria": text(180), "turns_used": turns, "backtracks": 0,
            "score": 0.42, "breached": i < 3, "errored": False,
            "silenced": False, "target_unreachable": False,
            "attacker_declined": False, "reason": text(800),
            "blocked_attempts": 1,
            "conversation": [{"role": "attacker" if t % 2 == 0 else "target",
                              "content": text(content)} for t in range(turns)],
        } for i in range(attacks)],
        "by_risk_category": [{"group": "guideline_bypass", "count": attacks,
                              "avg_score": 0.4, "breach_rate": 0.15}],
        "by_strategy": [{"group": "gradual_escalation", "count": attacks,
                         "avg_score": 0.4, "breach_rate": 0.15}],
        "target_turns": attacks * turns, "target_errors": 0,
        "target_blank_turns": 0, "analysis": text(2500),
    }


def json_bytes(obj) -> int:
    return len(json.dumps(obj, ensure_ascii=False, default=str).encode())


class AwsFixture(unittest.TestCase):
    """A real (moto) DynamoDB table + S3 bucket wired into the app modules."""

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
        patcher = mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": BUCKET})
        patcher.start()
        self.addCleanup(patcher.stop)
        # 归档覆盖注册表是进程级状态：桶和表每个用例都是新的，但多个用例
        # 复用同一个 run_id——不清空会让 save_run 以为「上次归档还在」而
        # 跳过归档，指针指向一个不存在的对象。
        import runstore
        runstore._ARCHIVE_COVER.clear()

    def stored_item(self, pk, sk):
        return self.table.get_item(Key={"pk": pk, "sk": sk})["Item"]

    def s3_keys(self):
        return [o["Key"] for o in
                self.s3.list_objects_v2(Bucket=BUCKET).get("Contents", [])]


class TestFixtureIsActuallyOversized(AwsFixture):
    """Guard the guard: if the fixture ever shrinks, the tests below prove nothing."""

    def test_fixture_exceeds_ddb_limit(self):
        run = big_redteam_run()
        self.assertGreater(json_bytes(run), DDB_LIMIT,
                           "fixture must exceed 400KB or it tests nothing")

    def test_raw_put_item_still_fails(self):
        # The exact call the old _save_run made, and the exact error from prod.
        run = big_redteam_run()
        with self.assertRaises(Exception) as ctx:
            self.table.put_item(Item={
                "pk": "RTRUN", "sk": run["run_id"],
                "data": json.dumps(run, ensure_ascii=False), "updated_at": 1})
        self.assertIn("Item size has exceeded the maximum allowed size",
                      str(ctx.exception))


class TestRedteamSaveRun(AwsFixture):
    def save(self, run, terminal=True):
        import redteam
        import testrun
        with mock.patch.object(testrun, "_table", return_value=self.table):
            redteam._save_run(run, terminal=terminal)

    def test_oversized_run_persists_without_validation_error(self):
        run = big_redteam_run()
        self.save(run)  # must not raise ValidationException
        item = self.stored_item("RTRUN", run["run_id"])
        self.assertLess(len(item["data"].encode()), DDB_LIMIT)

    def test_status_stays_completed(self):
        """The whole point: an oversized run is a finished run, not an error."""
        run = big_redteam_run()
        self.save(run)
        stored = json.loads(self.stored_item("RTRUN", run["run_id"])["data"])
        self.assertEqual(stored["status"], "completed")
        self.assertIsNone(stored.get("error"))
        self.assertEqual(stored["verdict"], "FAIL")
        self.assertEqual(stored["breached"], 3)
        self.assertEqual(stored["attacks"], 20)

    def test_s3_keeps_full_conversations(self):
        run = big_redteam_run()
        self.save(run)
        keys = self.s3_keys()
        self.assertEqual(keys, [f"redteam-runs/{run['run_id']}.json"])
        archived = json.loads(
            self.s3.get_object(Bucket=BUCKET, Key=keys[0])["Body"].read())
        self.assertEqual(len(archived["results"]), 20)
        for row in archived["results"]:
            self.assertEqual(len(row["conversation"]), 16)
            for msg in row["conversation"]:
                self.assertEqual(len(msg["content"]), 2000)
                self.assertIn(msg["role"], ("attacker", "target"))
        # the live turn log survives in full as well
        self.assertEqual(len(archived["live_turns"]), 320)

    def test_keeps_real_headroom_under_the_limit(self):
        """Landing at 399KB is a bug that fires next quarter. Stay well under."""
        run = big_redteam_run()
        self.save(run)
        size = len(self.stored_item("RTRUN", run["run_id"])["data"].encode())
        self.assertLess(size, DDB_LIMIT // 2,
                        f"only {size / 1024:.0f}KB of headroom logic left")

    def test_live_turn_tail_is_byte_bounded(self):
        """The kept tail is capped by bytes, not by a count of fat CJK turns."""
        import runstore
        run = big_redteam_run()
        slim, _ = runstore.slim_run(run)
        self.assertEqual(slim["live_turns_total"], 320)
        self.assertLess(slim["live_turns_kept"], 320)
        tail = json.dumps(slim["live_turns"], ensure_ascii=False).encode()
        self.assertLessEqual(len(tail), runstore.LIVE_TURNS_BUDGET_BYTES * 1.1)
        # newest turns are the ones kept (that is what a refresh replays)
        self.assertEqual(slim["live_turns"][-1], run["live_turns"][-1])

    def test_truncation_leaves_a_trace(self):
        """No silent loss: flag + what went + where + original counts."""
        run = big_redteam_run()
        self.save(run)
        stored = json.loads(self.stored_item("RTRUN", run["run_id"])["data"])
        self.assertTrue(stored["detail_truncated"])
        self.assertIn("results.conversation", stored["detail_dropped"])
        self.assertEqual(stored["detail_s3_key"],
                         f"redteam-runs/{run['run_id']}.json")
        self.assertIn("已存 S3", stored["detail_note"])
        # per-row: the transcript is gone but its existence and size are not
        self.assertEqual(len(stored["results"]), 20)
        for row in stored["results"]:
            self.assertNotIn("conversation", row)
            self.assertEqual(row["conversation_turns"], 16)
            self.assertTrue(row["conversation_in_s3"])
        self.assertEqual(stored["live_turns_total"], 320)

    def test_get_redteam_run_restores_full_detail(self):
        import redteam
        import testrun
        run = big_redteam_run()
        self.save(run)
        with mock.patch.object(testrun, "_table", return_value=self.table):
            loaded = redteam.get_redteam_run(run["run_id"])
        self.assertEqual(loaded["status"], "completed")
        self.assertEqual(len(loaded["results"]), 20)
        total = sum(len(m["content"]) for r in loaded["results"]
                    for m in r["conversation"])
        self.assertEqual(total, 20 * 16 * 2000)
        # restored records drop the shed markers — the data really is all here
        self.assertNotIn("detail_truncated", loaded)
        self.assertEqual(loaded["detail_source"], "s3")

    def test_progress_poll_skips_s3(self):
        import redteam
        import testrun
        run = big_redteam_run()
        self.save(run)
        with mock.patch.object(testrun, "_table", return_value=self.table):
            with mock.patch.object(redteam.runstore, "fetch_detail") as fetch:
                state = redteam.get_redteam_run(run["run_id"], detail=False)
        fetch.assert_not_called()
        self.assertEqual(state["completed"], 20)

    def test_small_run_is_stored_intact(self):
        """No regression for runs that always fitted: nothing is shed."""
        run = big_redteam_run(run_id="rt-small", attacks=2, turns=2, content=50)
        self.save(run)
        stored = json.loads(self.stored_item("RTRUN", "rt-small")["data"])
        self.assertNotIn("detail_truncated", stored)
        self.assertEqual(len(stored["results"][0]["conversation"]), 2)

    def test_mid_run_checkpoint_stays_off_s3(self):
        """A fitting checkpoint must not upload on every turn."""
        run = big_redteam_run(run_id="rt-live", attacks=1, turns=2, content=50,
                              status="running")
        self.save(run, terminal=False)
        self.assertEqual(self.s3_keys(), [])

    def test_oversized_checkpoint_archives_before_shedding(self):
        """Invariant: nothing is ever shed without having been archived first."""
        run = big_redteam_run(run_id="rt-live-big", status="running")
        self.save(run, terminal=False)
        stored = json.loads(self.stored_item("RTRUN", "rt-live-big")["data"])
        self.assertTrue(stored["detail_truncated"])
        self.assertIn("redteam-runs/rt-live-big.json", self.s3_keys())
        self.assertEqual(stored["detail_s3_key"], "redteam-runs/rt-live-big.json")

    def test_archive_failure_is_reported_not_hidden(self):
        """S3 down: the run keeps its true status and says the detail is gone."""
        import redteam
        import testrun
        run = big_redteam_run(run_id="rt-noS3")
        with mock.patch.object(testrun, "_table", return_value=self.table):
            with mock.patch.object(redteam.runstore, "archive_run",
                                   return_value=(None, "boom")):
                redteam._save_run(run, terminal=True)
        stored = json.loads(self.stored_item("RTRUN", "rt-noS3")["data"])
        self.assertEqual(stored["status"], "completed")  # never downgraded
        self.assertTrue(stored["detail_truncated"])
        self.assertEqual(stored["detail_error"], "boom")
        self.assertNotIn("detail_s3_key", stored)

    def test_never_points_at_a_missing_object(self):
        """detail_s3_key is written only after the upload returned."""
        import redteam
        import testrun
        run = big_redteam_run(run_id="rt-order")
        with mock.patch.object(testrun, "_table", return_value=self.table):
            with mock.patch.object(redteam.runstore, "_s3") as s3:
                s3.return_value.put_object.side_effect = RuntimeError("nope")
                redteam._save_run(run, terminal=True)
        stored = json.loads(self.stored_item("RTRUN", "rt-order")["data"])
        self.assertNotIn("detail_s3_key", stored)
        self.assertIn("detail_error", stored)
        self.assertEqual(self.s3_keys(), [])


class TestTestRunSaveRun(AwsFixture):
    """The regression-run path shares the disease and the cure."""

    def big_dataset_run(self, run_id="run-20260824090808", cases=20, turns=16):
        return {
            "run_id": run_id, "dataset": "big-set", "agents": ["dsh-agent"],
            "evaluators": ["correctness"], "status": "completed",
            "started_at": "2026-08-24 09:08 UTC", "total_cases": cases,
            "completed_cases": cases, "blank_cases": 0, "error_cases": 0,
            "actual_cost_usd": 2.5,
            "live_turns": [{"case": f"c{i}", "agent": "dsh-agent", "role": "agent",
                            "message": text(1500), "turn_no": 1}
                           for i in range(cases * turns)],
            "results": [{
                "agent": "dsh-agent", "case": f"c{i}", "input": text(200),
                "output": text(4000), "results": {"correctness": {"score": 0.9,
                                                                  "passed": True}},
                "conversation": [{"role": "user" if t % 2 == 0 else "agent",
                                  "message": text(2000)} for t in range(turns)],
                "n_turns": turns // 2,
            } for i in range(cases)],
            "analysis": text(2500),
        }

    def test_oversized_dataset_run_persists_completed(self):
        import testrun
        run = self.big_dataset_run()
        self.assertGreater(json_bytes(run), DDB_LIMIT)
        with mock.patch.object(testrun, "_table", return_value=self.table):
            testrun._save_run(run, terminal=True)
            loaded = testrun.get_test_run(run["run_id"])
        item = self.stored_item("RUN", run["run_id"])
        self.assertLess(len(item["data"].encode()), DDB_LIMIT)
        self.assertEqual(loaded["status"], "completed")
        self.assertEqual(len(loaded["results"]), 20)
        self.assertEqual(len(loaded["results"][0]["conversation"]), 16)

    def test_list_test_runs_reads_summaries_only(self):
        import testrun
        run = self.big_dataset_run(run_id="run-list")
        with mock.patch.object(testrun, "_table", return_value=self.table):
            testrun._save_run(run, terminal=True)
            with mock.patch.object(testrun.runstore, "fetch_detail") as fetch:
                runs = testrun.list_test_runs()
        fetch.assert_not_called()
        self.assertEqual(runs[0]["run_id"], "run-list")
        self.assertEqual(runs[0]["status"], "completed")


class TestSlimRun(unittest.TestCase):
    """Shedding order and the no-mutation rule."""

    def test_sheds_biggest_first(self):
        import runstore
        run = big_redteam_run()
        slim, shed = runstore.slim_run(run)
        self.assertEqual(shed[:2], ["live_turns", "results.conversation"])
        self.assertLessEqual(runstore.blob_bytes(slim), runstore.SAFE_BLOB_BYTES)
        # aggregates are never shed
        self.assertEqual(slim["verdict"], "FAIL")

    def test_does_not_mutate_the_caller_dict(self):
        """The executor returns this dict to the API; persistence must not gut it."""
        import runstore
        run = big_redteam_run()
        runstore.slim_run(run)
        self.assertEqual(len(run["live_turns"]), 320)
        self.assertEqual(len(run["results"][0]["conversation"]), 16)

    def test_fitting_run_is_returned_unchanged(self):
        import runstore
        run = {"run_id": "x", "status": "completed", "results": [{"case": "a"}]}
        slim, shed = runstore.slim_run(run)
        self.assertEqual(shed, [])
        self.assertIs(slim, run)

    def test_extreme_run_still_fits(self):
        """A run far past anything observed must still produce a storable item."""
        import runstore
        run = big_redteam_run(attacks=200, turns=30, content=2000)
        slim, shed = runstore.slim_run(run)
        self.assertLessEqual(runstore.blob_bytes(slim), runstore.SAFE_BLOB_BYTES)
        self.assertIn("results", shed)  # last resort reached
        self.assertEqual(slim["results_total"], 200)
        self.assertEqual(slim["status"], "completed")


class TestShedImpliesArchived(AwsFixture):
    """归档节流的安全边界：任何被 shed 出 DynamoDB item 的内容，都必须能在
    「shed 那一刻已经存在的归档对象」里找到——不许指望终态归档事后补上
    （中途崩掉的 run 等不到终态）。

    这个测试是 shed⇒archived 不变量的执行器。若有人把节流放宽成时间窗
    （例如「距上次归档 <60s 不重传」），窗口内新到的轮次滑出 48KB 尾窗时
    就会「既不在 item 里、也不在任何归档里」，下面的前缀断言立刻红。
    """

    def _checkpoint_sequence(self):
        """事故形态的增长序列：每 4 轮一次 checkpoint（redteam.py:691 的
        emit_turn 节奏），每 16 轮落一行带完整 conversation 的 result。"""
        full = big_redteam_run()
        turns, results = full["live_turns"], full["results"]
        sim = dict(full)
        sim["status"] = "running"
        for i in range(1, len(turns) + 1):
            sim["live_turns"] = turns[:i]
            sim["results"] = results[: i // 16]
            if i % 4 == 0:
                yield sim, turns, results

    def test_every_shed_turn_is_in_an_already_completed_archive(self):
        import runstore
        shed_seen = 0
        for sim, turns, results in self._checkpoint_sequence():
            item = runstore.save_run(self.table, "RTRUN", sim,
                                     s3_prefix="redteam-runs", terminal=False)
            stored = json.loads(item["data"])
            if not stored.get("detail_truncated"):
                continue
            shed_seen += 1
            key = stored.get("detail_s3_key")
            self.assertTrue(key, f"第 {len(sim['live_turns'])} 轮：shed 了却没有归档指针")
            archived = json.loads(
                self.s3.get_object(Bucket=BUCKET, Key=key)["Body"].read())
            # 被丢弃的 live turn 是最老的 dropped 条（前缀）：
            # 归档对象必须完整包含这段前缀
            dropped = stored["live_turns_total"] - stored["live_turns_kept"]
            self.assertGreaterEqual(
                len(archived["live_turns"]), dropped,
                f"第 {len(sim['live_turns'])} 轮：item 丢了 {dropped} 条轮次，"
                f"归档里只有 {len(archived['live_turns'])} 条——有轮次无处可寻")
            for j in range(dropped):
                self.assertEqual(archived["live_turns"][j], turns[j])
            # 从 item 里删掉的 conversation 同理：每行都要在归档里完整存在
            if "results.conversation" in stored.get("detail_dropped", []):
                for k in range(len(sim["results"])):
                    self.assertEqual(archived["results"][k]["conversation"],
                                     results[k]["conversation"])
        self.assertGreater(shed_seen, 40, "场景没长期触发 shed，等于什么都没测")

    def test_throttle_actually_skips_reuploads(self):
        """省流是真的省：按生产节奏（每 4 轮 1 次 emit_turn checkpoint +
        2 次 tracker tick，tracker 不带新轮次），整包重传次数必须远小于
        shed checkpoint 次数。跳过窗的诚实上限 = DDB 尾窗（~10 条 CJK 轮），
        再宽就违背 shed⇒archived（见上一个测试）。"""
        import runstore
        puts = {"n": 0}
        real_archive = runstore.archive_run

        def counting(*a, **k):
            puts["n"] += 1
            return real_archive(*a, **k)

        shed_seen = 0
        with mock.patch.object(runstore, "archive_run", side_effect=counting):
            for sim, _turns, _results in self._checkpoint_sequence():
                for _ in range(3):  # 1x emit_turn + ~2x tracker（redteam.py:747）
                    item = runstore.save_run(self.table, "RTRUN", sim,
                                             s3_prefix="redteam-runs",
                                             terminal=False)
                    if json.loads(item["data"]).get("detail_truncated"):
                        shed_seen += 1
        self.assertGreater(shed_seen, 120)
        self.assertLess(puts["n"], shed_seen / 4,
                        f"{shed_seen} 次 shed checkpoint 触发了 {puts['n']} 次"
                        "整包重传——节流没有生效")

    def test_lagging_archive_merges_with_item_tail_on_read(self):
        """跳过重传的窗口期里读明细：归档（旧前缀）+ item 尾窗（新轮次）
        拼合，一轮都不许丢——归档滞后不能让「刷新后回放尾窗」退化。"""
        import redteam
        import testrun
        full = big_redteam_run()
        turns = full["live_turns"]
        sim = dict(full)
        sim["status"] = "running"
        with mock.patch.object(testrun, "_table", return_value=self.table):
            sim["live_turns"] = turns[:200]
            redteam._save_run(sim)   # 首次 shed：归档覆盖 200 轮 + 全部 results
            sim["live_turns"] = turns[:204]
            redteam._save_run(sim)   # 4 轮后再 checkpoint：覆盖判定命中 → 跳过
            archived = json.loads(self.s3.get_object(
                Bucket=BUCKET,
                Key=f"redteam-runs/{sim['run_id']}.json")["Body"].read())
            self.assertEqual(len(archived["live_turns"]), 200)  # 真的没重传
            loaded = redteam.get_redteam_run(sim["run_id"])
        self.assertEqual(loaded["live_turns"], turns[:204])  # 拼合后一轮不丢
        self.assertEqual(len(loaded["results"]), 20)


class TestPlanStageSalvage(unittest.TestCase):
    """A stage that fails at the tail keeps the detail already checkpointed."""

    def test_redteam_stage_salvages_checkpoint(self):
        import planrun
        import redteam

        run_id_seen = {}
        salvaged_run = big_redteam_run(attacks=2, turns=2, content=50)

        async def boom(*a, **k):
            raise RuntimeError("An error occurred (ValidationException) ...")

        def fake_get(rid, detail=True):
            run_id_seen["rid"] = rid
            return salvaged_run

        async def emit(_ev):
            return None

        with mock.patch.object(redteam, "execute_redteam_run", boom), \
             mock.patch.object(redteam, "get_redteam_run", fake_get), \
             mock.patch.object(redteam, "estimate_redteam_run",
                               return_value={"estimated_cost_usd": 0.1}):
            import asyncio
            stage = asyncio.run(planrun._run_redteam_stage(
                {"type": "redteam", "cases": [{"name": "c1", "input": "x"}],
                 "strategies": ["goat"]},
                {"plan_id": "p1", "name": "n", "agent_name": "a"},
                {"runtime_arn": "arn:x"}, "judge", emit))

        self.assertEqual(stage["status"], "error")
        self.assertTrue(stage["salvaged"])
        # The three-key stage of the incident is gone: detail rides along.
        self.assertEqual(stage["attacks"], 2)
        self.assertEqual(stage["verdict"], "FAIL")
        self.assertEqual(len(stage["report"]["results"]), 2)
        self.assertTrue(stage["report"]["results"][0]["conversation"])
        self.assertEqual(run_id_seen["rid"], stage["run_id"])

    def test_stage_summary_marks_salvaged_and_truncated(self):
        import planrun
        s = planrun._stage_summary({
            "type": "redteam", "status": "error", "salvaged": True,
            "attacks": 20, "breached": 3, "verdict": "FAIL",
            "report": {"detail_truncated": True}})
        self.assertTrue(s["salvaged"])
        self.assertTrue(s["detail_truncated"])
        self.assertEqual(s["attacks"], 20)


class TestPlanRunPersistTrace(AwsFixture):
    def test_archive_failure_recorded_and_surfaced(self):
        """No half state: DDB says completed, and says the archive is missing."""
        import catalog
        import planrun
        full = {"stages": [{"type": "redteam", "status": "completed"}]}
        stages = [{"type": "redteam", "status": "completed", "attacks": 20,
                   "breached": 3, "verdict": "FAIL"}]
        plan = {"plan_id": "p1", "name": "dsh-eval-1式", "agent_name": "a"}
        with mock.patch.object(catalog, "get_table", return_value=self.table):
            with mock.patch.object(planrun.runstore, "_s3") as s3:
                s3.return_value.put_object.side_effect = RuntimeError("denied")
                key = planrun._persist(plan, "p1#ts", "ts", "manual", "s", "f",
                                       1.81, stages, {}, full)
            self.assertIsNone(key)
            item = self.stored_item("PLANRUN", "p1#ts")
            self.assertEqual(item["status"], "completed")
            self.assertEqual(item["s3_key"], "")
            # 断言**完整名词**：只查「归档失败」三个字，「完整报告」被换成
            # 「完整明细」也能过 —— 而那个名词是用户可见的（simplify-r2 S3：
            # runstore.archive_run 的名词已参数化，planrun 换用时必须传「报告」）。
            self.assertIn("完整报告归档失败", item["report_error"])
            with mock.patch.object(planrun.runstore, "_s3"):
                out = planrun.get_plan_run("p1#ts")
        self.assertIn("完整报告归档失败", out["report_error"])


if __name__ == "__main__":
    unittest.main()
