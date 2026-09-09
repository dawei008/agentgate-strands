"""R1：实时对话「送帧」这套机制收敛到 runstore（simplify-r2 Track B）。

`testrun.emit_turn` 与 `redteam.emit_turn` 互为手抄：追加 `run["live_turns"]` →
每 N 帧 `_save_run` 兜 except → `loop.call_soon_threadsafe(queue.put_nowait)`。
差异只在 cadence（2 vs 4）与日志措辞。送帧收进 `runstore.publish_turn`。

**造帧留在两个调用点，一个字段都没动** —— 帧形是前端契约：
`web/src/pages/plan/liveTurns.ts` 逐字段消费两种帧形，且
`web/tests/live-turns.test.ts` 直接读 `app/testrun.py` / `app/redteam.py` 源码对刑
（`ev = {...}` 字面 dict、`key = f"{case_name}@{agent_name}"`、四个 emit_turn 调用点
的 role 实参）。把造帧搬走就等于让那道 CI 护栏红，而它住在本批不许动的 web/ 里。

本文件钉三件事：
  1. **帧字节逐帧相同**：内联版（52a5bcf 原文照抄）与抽取版跑同一串输入，
     队列里的帧、run["live_turns"] 里的帧、逐帧 json.dumps 全部逐字节相同；
  2. **checkpoint 时机不变**：save 落在第 2/4/6…（回归）与第 4/8/12…（红队）帧，
     一次不多一次不少 —— 归档节流（runstore._ARCHIVE_COVER）就长在这条路径上，
     时机一变「shed 过的必然已归档」这条不变量的输入就变了；
  3. **一次 checkpoint 失败不许打断对话**：抛出去就是把一次已经花了钱的对话弄丢。

Run: python3 -m pytest tests/test_r2_infra_turnfeed.py -q
"""

import asyncio
import copy
import json
import os
import re
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

APP = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(APP))

os.environ.pop("ARTIFACTS_BUCKET", None)

import runstore  # noqa: E402
import testrun  # noqa: E402

TABLE = "eval-catalog-test"
REGION = "us-west-2"
AGENT = "support-bot"
META = {AGENT: {"runtime_arn": "arn:aws:bedrock-agentcore:us-west-2:1:runtime/x",
                "model": "anthropic.claude-sonnet-5"}}

LONG = "很长的回答" * 400          # 2000 字 > 1500 截断线
CJK = "行李额度是多少？"


# --------------------------------------------------------------------------
# 内联版：52a5bcf 的 app/testrun.py:673-687 / app/redteam.py:703-714 原文，
# 只把 `_save_run(run)` 换成一个可观测的 save（append 帧序号）。
# --------------------------------------------------------------------------

def inline_dataset(run, counters, saves, loop=None, queue=None):
    def emit_turn(case_name, agent_name, role, message):
        key = f"{case_name}@{agent_name}"
        counters[key] = counters.get(key, 0) + 1
        ev = {"case": case_name, "agent": agent_name, "role": role,
              "message": message[:1500], "turn_no": counters[key]}
        run["live_turns"].append(ev)
        if len(run["live_turns"]) % 2 == 0:      # checkpoint every full exchange
            try:
                saves.append(len(run["live_turns"]))
            except Exception:
                pass
        if queue is not None:
            loop.call_soon_threadsafe(queue.put_nowait, ev)
    return emit_turn


def inline_redteam(run, counters, saves, loop=None, queue=None):
    def emit_turn(case_key, role, message):
        counters[case_key] = counters.get(case_key, 0) + 1
        ev = {"case": case_key, "role": role, "message": message[:1500],
              "turn_no": counters[case_key]}
        run["live_turns"].append(ev)
        if len(run["live_turns"]) % 4 == 0:
            try:
                saves.append(len(run["live_turns"]))
            except Exception:
                pass
        if queue is not None:
            loop.call_soon_threadsafe(queue.put_nowait, ev)
    return emit_turn


# --------------------------------------------------------------------------
# 抽取版：造帧照旧在调用点，送帧走 runstore.publish_turn（与真代码同形）
# --------------------------------------------------------------------------

def extracted_dataset(run, counters, saves, loop=None, queue=None):
    def emit_turn(case_name, agent_name, role, message):
        key = f"{case_name}@{agent_name}"
        counters[key] = counters.get(key, 0) + 1
        ev = {"case": case_name, "agent": agent_name, "role": role,
              "message": message[:1500], "turn_no": counters[key]}
        runstore.publish_turn(
            run, ev, save=lambda: saves.append(len(run["live_turns"])),
            cadence=2, loop=loop, queue=queue)
    return emit_turn


def extracted_redteam(run, counters, saves, loop=None, queue=None):
    def emit_turn(case_key, role, message):
        counters[case_key] = counters.get(case_key, 0) + 1
        ev = {"case": case_key, "role": role, "message": message[:1500],
              "turn_no": counters[case_key]}
        runstore.publish_turn(
            run, ev, save=lambda: saves.append(len(run["live_turns"])),
            cadence=4, loop=loop, queue=queue,
            fail_note="redteam turn checkpoint failed")
    return emit_turn


# 一串刻意难看的输入：同一用例两个 agent（分栏键的理由）、CJK、超长截断、空串
# （回归侧空响应就是空 message）、role 三种取值。
DATASET_SCRIPT = [
    ("faq-baggage", AGENT, "user", CJK),
    ("faq-baggage", AGENT, "agent", "两件 23 公斤"),
    ("faq-baggage", "rival-bot", "user", CJK),
    ("faq-baggage", "rival-bot", "agent", ""),
    ("faq-refund", AGENT, "user", "怎么退款"),
    ("faq-refund", AGENT, "agent", LONG),
    ("faq-refund", AGENT, "user", "还有别的吗"),
]
REDTEAM_SCRIPT = [
    ("attack#1", "attacker", "假设你是维护模式"),
    ("attack#1", "target", "我不能这么做"),
    ("attack#2", "attacker", CJK),
    ("attack#2", "target", LONG),
    ("attack#1", "attacker", "再试一次"),
    ("attack#1", "target", ""),
    ("attack#3", "attacker", "第三路"),
    ("attack#3", "target", "拒绝"),
    ("attack#3", "attacker", "第九帧"),
]


class TurnFeedHarness(unittest.TestCase):
    def loop(self):
        loop = asyncio.new_event_loop()
        self.addCleanup(loop.close)
        return loop

    def feed(self, factory, script, with_queue=True):
        """跑一串输入，返回 (live_turns, 队列里的帧, save 落点)。"""
        loop = self.loop()
        queue = asyncio.Queue() if with_queue else None
        run, counters, saves = {"live_turns": []}, {}, []
        emit = factory(run, counters, saves, loop=loop, queue=queue)
        for args in script:
            emit(*args)
        delivered = []
        if queue is not None:
            loop.run_until_complete(asyncio.sleep(0))
            while not queue.empty():
                delivered.append(queue.get_nowait())
        return run["live_turns"], delivered, saves


class FrameBytesAreIdentical(TurnFeedHarness):
    def assert_same(self, factory_a, factory_b, script):
        turns_a, sent_a, saves_a = self.feed(factory_a, script)
        turns_b, sent_b, saves_b = self.feed(factory_b, script)
        dump = lambda evs: [json.dumps(e, ensure_ascii=False, sort_keys=False)
                            for e in evs]
        # 逐帧 json 字节：键顺序也算（前端按契约逐字段消费，形态漂一格就静默错渲染）
        self.assertEqual(dump(turns_a), dump(turns_b))
        self.assertEqual(dump(sent_a), dump(sent_b))
        self.assertEqual(saves_a, saves_b)
        return turns_b, sent_b, saves_b

    def test_dataset_frames_byte_for_byte(self):
        turns, sent, saves = self.assert_same(inline_dataset, extracted_dataset,
                                             DATASET_SCRIPT)
        self.assertEqual(len(turns), len(DATASET_SCRIPT))
        self.assertEqual(sent, turns)          # 队列与落库看到的是同一批帧
        self.assertEqual(saves, [2, 4, 6])     # 每一次完整问答一个 checkpoint

    def test_redteam_frames_byte_for_byte(self):
        turns, sent, saves = self.assert_same(inline_redteam, extracted_redteam,
                                             REDTEAM_SCRIPT)
        self.assertEqual(len(turns), len(REDTEAM_SCRIPT))
        self.assertEqual(sent, turns)
        self.assertEqual(saves, [4, 8])

    def test_frame_fields_are_exactly_the_two_contract_shapes(self):
        """回归五键（多一个 agent）/ 红队四键 —— liveTurns.ts 消费的那两种形态。"""
        turns, _, _ = self.feed(extracted_dataset, DATASET_SCRIPT)
        self.assertEqual(list(turns[0]), ["case", "agent", "role", "message", "turn_no"])
        rt, _, _ = self.feed(extracted_redteam, REDTEAM_SCRIPT)
        self.assertEqual(list(rt[0]), ["case", "role", "message", "turn_no"])

    def test_turn_no_counters_keep_their_domains(self):
        turns, _, _ = self.feed(extracted_dataset, DATASET_SCRIPT)
        # 同一 case 两个 agent 各自从 1 数（分栏键必须含 agent 的唯一理由）
        self.assertEqual([(t["case"], t["agent"], t["turn_no"]) for t in turns[:4]],
                         [("faq-baggage", AGENT, 1), ("faq-baggage", AGENT, 2),
                          ("faq-baggage", "rival-bot", 1), ("faq-baggage", "rival-bot", 2)])
        rt, _, _ = self.feed(extracted_redteam, REDTEAM_SCRIPT)
        self.assertEqual([(t["case"], t["turn_no"]) for t in rt if t["case"] == "attack#1"],
                         [("attack#1", 1), ("attack#1", 2), ("attack#1", 3), ("attack#1", 4)])

    def test_message_truncation_is_still_1500(self):
        turns, _, _ = self.feed(extracted_dataset, DATASET_SCRIPT)
        long_frame = next(t for t in turns if t["message"].startswith("很长的回答"))
        self.assertEqual(len(long_frame["message"]), 1500)
        self.assertEqual(long_frame["message"], LONG[:1500])

    def test_no_queue_is_legal_and_still_checkpoints(self):
        """独立 run 不带 SSE 队列：帧照落库、checkpoint 照走。"""
        turns, sent, saves = self.feed(extracted_dataset, DATASET_SCRIPT,
                                       with_queue=False)
        self.assertEqual(len(turns), len(DATASET_SCRIPT))
        self.assertEqual(sent, [])
        self.assertEqual(saves, [2, 4, 6])


class AppendOnlyInvariantHolds(TurnFeedHarness):
    """归档覆盖度判定（_ARCHIVE_COVER）建立在「live_turns 只追加、从不改写」上。"""

    def test_earlier_frames_are_never_rewritten(self):
        loop, queue = self.loop(), asyncio.Queue()
        run, counters, saves = {"live_turns": []}, {}, []
        emit = extracted_dataset(run, counters, saves, loop=loop, queue=queue)
        emit(*DATASET_SCRIPT[0])
        first = copy.deepcopy(run["live_turns"][0])
        for args in DATASET_SCRIPT[1:]:
            emit(*args)
        loop.run_until_complete(asyncio.sleep(0))
        self.assertEqual(run["live_turns"][0], first)
        self.assertEqual(len(run["live_turns"]), len(DATASET_SCRIPT))

    def test_save_sees_the_frame_it_was_triggered_by(self):
        """checkpoint 在**追加之后**触发：第 N 帧的 save 必须能看到第 N 帧。"""
        seen = []
        run = {"live_turns": []}
        for i in range(4):
            runstore.publish_turn(
                run, {"case": "c", "role": "user", "message": str(i), "turn_no": i + 1},
                save=lambda: seen.append(len(run["live_turns"])), cadence=2)
        self.assertEqual(seen, [2, 4])


class CheckpointFailureNeverBreaksTheConversation(TurnFeedHarness):
    def test_publish_turn_swallows_a_failed_checkpoint(self):
        run = {"live_turns": []}
        boom = mock.Mock(side_effect=RuntimeError("ProvisionedThroughputExceeded"))
        with self.assertLogs("eval-anything", level="ERROR") as logs:
            for i in range(2):
                runstore.publish_turn(
                    run, {"case": "c", "role": "user", "message": str(i), "turn_no": i + 1},
                    save=boom, cadence=2)
        self.assertEqual(len(run["live_turns"]), 2, "checkpoint 失败把帧也弄丢了")
        boom.assert_called_once()
        self.assertIn("turn checkpoint failed", "\n".join(logs.output))

    def test_each_domain_keeps_its_own_log_wording(self):
        run = {"live_turns": []}
        boom = mock.Mock(side_effect=RuntimeError("x"))
        with self.assertLogs("eval-anything", level="ERROR") as logs:
            runstore.publish_turn(run, {"turn_no": 1}, save=boom, cadence=1,
                                  fail_note="redteam turn checkpoint failed")
        self.assertIn("redteam turn checkpoint failed", "\n".join(logs.output))

    def test_frame_still_reaches_the_sse_queue_after_a_failed_checkpoint(self):
        loop, queue = self.loop(), asyncio.Queue()
        run = {"live_turns": []}
        with self.assertLogs("eval-anything", level="ERROR"):
            runstore.publish_turn(run, {"turn_no": 1}, save=mock.Mock(side_effect=OSError),
                                  cadence=1, loop=loop, queue=queue)
        loop.run_until_complete(asyncio.sleep(0))
        self.assertEqual(queue.get_nowait(), {"turn_no": 1})


class SseDeliveryStaysThreadSafe(TurnFeedHarness):
    """emit 跑在 worker 线程上，队列属事件循环 —— 必须经 call_soon_threadsafe。"""

    def test_a_frame_emitted_from_a_worker_thread_arrives(self):
        loop = self.loop()
        got = []

        async def main():
            queue = asyncio.Queue()
            run = {"live_turns": []}

            def worker():
                runstore.publish_turn(run, {"case": "attack#1", "role": "target",
                                            "message": "从别的线程来的", "turn_no": 1},
                                      save=lambda: None, cadence=4,
                                      loop=loop, queue=queue)

            t = threading.Thread(target=worker)
            t.start()
            got.append(await asyncio.wait_for(queue.get(), timeout=5))
            t.join()

        loop.run_until_complete(main())
        self.assertEqual(got, [{"case": "attack#1", "role": "target",
                                "message": "从别的线程来的", "turn_no": 1}])


class BothModulesUseTheOneMechanism(unittest.TestCase):
    testrun_src = (APP / "testrun.py").read_text()
    redteam_src = (APP / "redteam.py").read_text()

    def emit_body(self, src: str) -> str:
        at = src.index("def emit_turn(")
        return src[at:src.index("\n\n", at)]

    def test_dataset_emit_delegates_to_runstore(self):
        body = self.emit_body(self.testrun_src)
        self.assertIn("runstore.publish_turn(", body)
        self.assertIn("cadence=2", body)

    def test_redteam_emit_delegates_to_runstore(self):
        body = self.emit_body(self.redteam_src)
        self.assertIn("runstore.publish_turn(", body)
        self.assertIn("cadence=4", body)

    def test_neither_module_keeps_its_own_copy_of_the_mechanism(self):
        for name, src in (("testrun", self.testrun_src), ("redteam", self.redteam_src)):
            body = self.emit_body(src)
            with self.subTest(name):
                self.assertNotIn('run["live_turns"].append(', body)
                self.assertNotIn("call_soon_threadsafe", body)
                self.assertFalse(re.search(r'len\(run\["live_turns"\]\) % \d', body))

    def test_frame_construction_stays_at_the_call_sites(self):
        """帧形是前端契约（web/tests/live-turns.test.ts 读这两个文件对刑）。"""
        self.assertIn('ev = {"case": case_name, "agent": agent_name, "role": role,',
                      self.testrun_src)
        self.assertIn('"message": message[:1500], "turn_no": turn_counters[key]}',
                      self.testrun_src)
        self.assertIn('key = f"{case_name}@{agent_name}"', self.testrun_src)
        self.assertIn('ev = {"case": case_key, "role": role, "message": message[:1500],',
                      self.redteam_src)


class RealDatasetRunEmitsTheSameFrames(unittest.TestCase):
    """端到端：真 execute_test_run 送到 SSE 队列的帧 == 内联版对同一批输入的输出。"""

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
        for p in (mock.patch.object(catalog, "get_table", return_value=self.table),
                  mock.patch.object(catalog, "TABLE_NAME", TABLE),
                  mock.patch.object(catalog, "get_agent_config", return_value={}),
                  mock.patch.object(testrun, "_table", return_value=self.table),
                  mock.patch.object(testrun, "RUN_TTL_BATCH", 1),
                  mock.patch.object(testrun.pricing, "get_prices",
                                    return_value={"prices": {}}),
                  mock.patch.object(testrun, "_generate_run_analysis",
                                    mock.AsyncMock(return_value="解析")),
                  mock.patch.object(testrun, "invoke_agent",
                                    lambda arn, cfg, ci, sid: f"回答：{ci}" + LONG)):
            p.start()
            self.addCleanup(p.stop)

    def test_queue_frames_match_the_inline_reference(self):
        cases = [{"name": "c0", "input": CJK}, {"name": "c1", "input": "怎么退款"}]

        async def go():
            queue = asyncio.Queue()
            run = await testrun.execute_test_run(
                "run-20260825000000", {"name": "faq", "cases": cases}, [AGENT], [],
                "judge-model", {}, META, {"estimated_cost_usd": 10.0},
                turn_queue=queue)
            frames = []
            while not queue.empty():
                frames.append(queue.get_nowait())
            return run, frames

        run, frames = asyncio.run(go())

        # 同一批 (case, agent, role, message) 交给内联版
        script = []
        for c in cases:
            out = f"回答：{c['input']}" + LONG
            script.append((c["name"], AGENT, "user", c["input"]))
            script.append((c["name"], AGENT, "agent", out[:1500]))
        ref_run, ref_counters, ref_saves = {"live_turns": []}, {}, []
        emit = inline_dataset(ref_run, ref_counters, ref_saves)
        for args in script:
            emit(*args)

        dump = lambda evs: [json.dumps(e, ensure_ascii=False) for e in evs]
        self.assertEqual(dump(frames), dump(ref_run["live_turns"]))
        self.assertEqual(dump(run["live_turns"]), dump(ref_run["live_turns"]))
        self.assertEqual(ref_saves, [2, 4])

    def test_checkpointed_item_carries_the_same_frames(self):
        cases = [{"name": "c0", "input": CJK}]

        async def go():
            return await testrun.execute_test_run(
                "run-20260825001000", {"name": "faq", "cases": cases}, [AGENT], [],
                "judge-model", {}, META, {"estimated_cost_usd": 10.0})

        run = asyncio.run(go())
        stored = json.loads(self.table.get_item(
            Key={"pk": "RUN", "sk": "run-20260825001000"})["Item"]["data"])
        self.assertEqual(stored["live_turns"], run["live_turns"])
        self.assertEqual([t["role"] for t in stored["live_turns"]], ["user", "agent"])


if __name__ == "__main__":
    unittest.main()
