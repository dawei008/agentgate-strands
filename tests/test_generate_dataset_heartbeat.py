"""generate_dataset must emit heartbeat frames while converse blocks.

The judge call is one synchronous converse that can block ~90s with no other
frames in between; without heartbeats the web UI's liveness meter slides to
"possibly disconnected" (stale at 60s) while generation is in fact running,
and users refresh away a result that is only delivered on the stream.

No AWS calls — judgellm.converse is patched with a slow stub and the
heartbeat interval is shrunk so the test observes several beats.

Run: python3 -m pytest tests/test_generate_dataset_heartbeat.py -q
"""

import asyncio
import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

os.environ.pop("ARTIFACTS_BUCKET", None)  # skip the S3 source-archive branch

import main  # noqa: E402


def _slow_converse(delay, result):
    def converse(*args, **kwargs):
        time.sleep(delay)
        return result
    return converse


GOOD_RESULT = {
    "tool_input": {"cases": [{"name": "c1", "input": "q",
                              "expected_output": "e", "category": "x"}]},
    "text": "", "stop_reason": "tool_use",
}


def _collect(payload):
    async def run():
        events = []
        async for ev in main.invoke(payload):
            events.append(ev)
        return events
    return asyncio.run(run())


class TestGenerateDatasetHeartbeat(unittest.TestCase):
    def test_heartbeats_while_converse_blocks(self):
        with mock.patch.object(main, "GEN_HEARTBEAT_SECONDS", 0.05), \
             mock.patch.object(main.judgellm, "converse",
                               _slow_converse(0.25, GOOD_RESULT)):
            events = _collect({"action": "generate_dataset",
                               "context": "some docs", "case_shape": "single"})
        beats = [e for e in events if e["event"] == "heartbeat"]
        self.assertGreaterEqual(len(beats), 2, events)
        # exact frame shape the web mock and GenCasesForm expect
        for b in beats:
            self.assertEqual(b, {"event": "heartbeat", "phase": "generate_dataset"})
        self.assertEqual(events[-1]["event"], "dataset_generated")
        self.assertEqual(len(events[-1]["cases"]), 1)

    def test_fast_converse_needs_no_heartbeat(self):
        with mock.patch.object(main.judgellm, "converse",
                               _slow_converse(0, GOOD_RESULT)):
            events = _collect({"action": "generate_dataset",
                               "context": "some docs", "case_shape": "single"})
        self.assertEqual(events[-1]["event"], "dataset_generated")

    def test_converse_failure_still_yields_error_event(self):
        def boom(*a, **k):
            raise RuntimeError("bedrock down")
        with mock.patch.object(main, "GEN_HEARTBEAT_SECONDS", 0.05), \
             mock.patch.object(main.judgellm, "converse", boom):
            events = _collect({"action": "generate_dataset",
                               "context": "some docs", "case_shape": "single"})
        self.assertEqual(events[-1]["event"], "error")
        self.assertIn("bedrock down", events[-1]["error"])

    def test_gen_heartbeat_beats_frontend_waiting_threshold(self):
        # useLiveness.WAITING_AFTER_S is 10; the whole point of the fix is to
        # stay under it so the UI never leaves the "链路正常" tier.
        self.assertLess(main.GEN_HEARTBEAT_SECONDS, 10)


if __name__ == "__main__":
    unittest.main()
