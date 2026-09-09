"""Oversized datasets must be refused with a usable message, not vanish (P1).

Incident shape (BH-005): `save_dataset` caps the case *count* (MAX_CASES=200)
but never the *bytes*. AI-generated red-team cases carry untruncated free text
(opening message + target_context + success_criteria, `redteam.py:326-331`), so
200 cases serialize to ~1.2MB, sail through the count gate and reach PutItem:

    ValidationException: Item size has exceeded the maximum allowed size

That is a botocore ClientError, not a ValueError, so it escapes the
`except (KeyError, ValueError)` in `main.py`'s save_dataset branch, escapes the
async generator, and the framework wrapper emits one last-words frame
(`bedrock_agentcore/runtime/app.py:887-891`) that carries no `event` field —
which the web client cannot map to an application error. The dataset is not
stored and the freshly generated cases (component state only) die on refresh.
Sibling path `runstore` was fixed for this in 023400e; `save_dataset` was not.

These tests use moto's real DynamoDB (moto enforces the 400KB item limit,
verified) so the failure mode is reproduced rather than mocked away. Nothing
here touches a live table, bucket, agent or LLM.

Run: python3 -m pytest tests/test_dataset_save_size.py -q
"""

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

os.environ.pop("ARTIFACTS_BUCKET", None)

import catalog  # noqa: E402

TABLE = "eval-catalog-test"
REGION = "us-west-2"
DDB_LIMIT = 400 * 1024

# Red-team case text as the generator actually produces it: Chinese free text,
# ~3 bytes per char in UTF-8 — which is what blows the byte-counted limit while
# the count gate sees a comfortable 200.
FILLER = "该攻击话术围绕权限伪装展开，先建立可信身份，再要求越权操作。"


def text(n: int) -> str:
    """n characters (not bytes) of red-team-shaped filler."""
    return (FILLER * (n // len(FILLER) + 1))[:n]


def big_redteam_cases(count=200, chars=600) -> list[dict]:
    """The reported shape: MAX_CASES cases, none of their fields truncated."""
    return [{"name": f"guideline_bypass_{i}", "input": text(chars),
             "risk_category": "guideline_bypass", "actor_goal": text(130),
             "context": text(chars), "severity": "high",
             "success_criteria": text(130), "traits": {}}
            for i in range(count)]


def ascii_cases(total_bytes: int) -> list[dict]:
    """One case whose serialized size is ~total_bytes (1 byte per char)."""
    return [{"name": "c1", "input": "a" * total_bytes}]


def json_bytes(obj) -> int:
    return len(json.dumps(obj, ensure_ascii=False).encode())


class DdbFixture(unittest.TestCase):
    """A real (moto) DynamoDB table wired into catalog."""

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
        patcher = mock.patch.object(catalog, "get_table", return_value=self.table)
        patcher.start()
        self.addCleanup(patcher.stop)
        name_patcher = mock.patch.object(catalog, "TABLE_NAME", TABLE)
        name_patcher.start()
        self.addCleanup(name_patcher.stop)

    def stored(self, name):
        return self.table.get_item(Key={"pk": "DATASET", "sk": name}).get("Item")


class TestFixtureIsActuallyOversized(DdbFixture):
    """Guard the guard: if the fixture ever shrinks, the tests below prove nothing."""

    def test_fixture_passes_the_count_gate(self):
        cases = big_redteam_cases()
        self.assertLessEqual(len(cases), catalog.MAX_CASES)

    def test_fixture_exceeds_ddb_limit(self):
        self.assertGreater(json_bytes(big_redteam_cases()), DDB_LIMIT,
                           "fixture must exceed 400KB or it tests nothing")

    def test_raw_put_item_still_fails(self):
        # The exact call save_dataset used to make, and the exact error from prod.
        with self.assertRaises(Exception) as ctx:
            self.table.put_item(Item={
                "pk": "DATASET", "sk": "rt-big",
                "cases": json.dumps(big_redteam_cases(), ensure_ascii=False),
                "updated_at": 1})
        self.assertIn("Item size has exceeded the maximum allowed size",
                      str(ctx.exception))


class TestOversizedRejectedActionably(DdbFixture):
    def test_raises_valueerror_not_clienterror(self):
        """ValueError is the contract: main.py's save_dataset branch catches
        (KeyError, ValueError) and turns it into an {event: "error"} frame.
        Any other exception type escapes the entrypoint."""
        with self.assertRaises(ValueError) as ctx:
            catalog.save_dataset("rt-big", big_redteam_cases(), kind="redteam")
        self.assertNotIn("ValidationException", str(ctx.exception))

    def test_message_says_how_many_how_big_and_what_to_do(self):
        with self.assertRaises(ValueError) as ctx:
            catalog.save_dataset("rt-big", big_redteam_cases(), kind="redteam")
        msg = str(ctx.exception)
        self.assertIn("200 条", msg)          # how many
        self.assertIn("KB", msg)              # how big / what the ceiling is
        self.assertIn("400 KB", msg)          # the ceiling itself
        self.assertIn("拆", msg)              # what to do about it
        self.assertNotIn("ValidationException", msg)

    def test_nothing_is_written(self):
        with self.assertRaises(ValueError):
            catalog.save_dataset("rt-big", big_redteam_cases(), kind="redteam")
        self.assertIsNone(self.stored("rt-big"))

    def test_existing_dataset_is_not_clobbered(self):
        catalog.save_dataset("rt-big", [{"name": "keep", "input": "q"}],
                             kind="redteam")
        with self.assertRaises(ValueError):
            catalog.save_dataset("rt-big", big_redteam_cases(), kind="redteam")
        kept = json.loads(self.stored("rt-big")["cases"])
        self.assertEqual([c["name"] for c in kept], ["keep"])


class TestSizeBoundary(DdbFixture):
    """The guard must not become a new outage: normal datasets keep saving."""

    def test_normal_dataset_saves(self):
        catalog.save_dataset("reg-normal",
                             [{"name": f"c{i}", "input": text(200)}
                              for i in range(50)],
                             kind="regression")
        self.assertEqual(len(json.loads(self.stored("reg-normal")["cases"])), 50)

    def test_large_but_fitting_dataset_saves(self):
        # ~300KB: well over anything users hit today, still under the ceiling.
        catalog.save_dataset("reg-300k", ascii_cases(300 * 1024), kind="regression")
        self.assertIsNotNone(self.stored("reg-300k"))

    def test_just_under_the_guard_saves(self):
        cases = ascii_cases(catalog.SAFE_ITEM_BYTES - 2048)
        catalog.save_dataset("reg-edge", cases, kind="regression")
        self.assertIsNotNone(self.stored("reg-edge"))

    def test_just_over_the_guard_is_refused(self):
        # Deliberately refuses a narrow band DynamoDB would still accept: the
        # headroom absorbs DDB's own accounting and the metadata a later edit
        # may add. Refusing with a message beats failing on next week's save.
        cases = ascii_cases(catalog.SAFE_ITEM_BYTES + 2048)
        with self.assertRaises(ValueError):
            catalog.save_dataset("reg-over", cases, kind="regression")
        self.assertIsNone(self.stored("reg-over"))


class TestEntrypointStreamsAnErrorEvent(DdbFixture):
    """End of the chain: what the web client actually receives."""

    def _collect(self, payload):
        import main

        async def run():
            return [ev async for ev in main.invoke(payload)]
        return asyncio.run(run())

    def test_oversized_save_yields_error_event(self):
        events = self._collect({"action": "save_dataset", "name": "rt-big",
                                "cases": big_redteam_cases(), "kind": "redteam"})
        self.assertEqual([e["event"] for e in events], ["error"])
        self.assertIn("400 KB", events[0]["error"])
        self.assertIn("拆", events[0]["error"])

    def test_normal_save_still_yields_dataset_saved(self):
        events = self._collect({"action": "save_dataset", "name": "reg-ok",
                                "cases": [{"name": "c1", "input": "q"}],
                                "kind": "regression"})
        self.assertEqual(events, [{"event": "dataset_saved", "name": "reg-ok"}])

    def test_ddb_rejection_still_becomes_an_error_event(self):
        """Defense in depth: if the pre-check ever under-counts (here: simulated
        by raising its ceiling), DynamoDB's own rejection must still leave the
        stream with an application-level error frame. A ClientError escaping the
        generator leaves only the framework's last-words frame, which carries no
        `event` field and reads to the user as "未收到 dataset_saved"."""
        with mock.patch.object(catalog, "SAFE_ITEM_BYTES", 100 * 1024 * 1024):
            events = self._collect({"action": "save_dataset", "name": "rt-big",
                                    "cases": big_redteam_cases(),
                                    "kind": "redteam"})
        self.assertEqual([e["event"] for e in events], ["error"])
        # 真因不被掩盖：ops 在 CloudWatch 里、用户在弹窗里看到的是同一句话
        self.assertIn("ValidationException", events[0]["error"])


if __name__ == "__main__":
    unittest.main()
