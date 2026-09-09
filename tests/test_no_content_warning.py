"""no_content 的警示语只许陈述本次观测到的事实，不许猜成因。

**缺陷**（2026-09-02 现网实测）：会话 trace 里没有消息内容时，平台一律挂
「the agent was likely deployed without
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true」。而出问题的
`bi_metrics_assistant` 那个环境变量**是设着的**（查过 runtime 配置）——真实原因是
该会话只有 4 条 span、停在第一个 event-loop cycle，收尾的 `invoke_agent` 记录从没
出现。一句猜错的成因把用户指向一个不存在的问题，比不给成因更坏。

分档判据只用手上已有的材料（`get_evaluation_data` 的第二个返回值 = 本次会话的原始
span 记录，加会话枚举给的 `span_count`），不新增任何 AWS 调用：
  · 一条 span 都没有        -> WARN_NOT_FOUND（查不到本次会话的 span）
  · 有 span、无 invoke_agent -> WARN_INCOMPLETE（没写全，读到的只是一截）
  · 有 span、有 invoke_agent -> WARN_NO_MESSAGES（写全了却没内容，才谈采集开关）
  · 无 span 但枚举数到过     -> WARN_UNDECIDABLE（两个来源对不上，说分不出来）

**阴性对照**：`test_a_session_with_content_gets_no_warning_and_stays_scorable`
—— 正常有内容的会话既不挂 warning、也不被标 errored。缺了它，「恒挂第 N 档」与
「按 span 分档」在正例上同形。

不碰真 agent / 真 LLM / 真 AWS：走**真的** `evaluate_session`（三档接线只有走那条
路才验得到），只把 trace 拉取与 Experiment 换成同形替身。
运行：python3 -m pytest tests/test_no_content_warning.py -q
"""

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import observe  # noqa: E402


def span(name="chat", operation=None, **attrs) -> dict:
    """一条原始 span 记录的同形替身（CloudWatchLogsParser 的产物形态）。"""
    if operation:
        attrs["gen_ai.operation.name"] = operation
    return {"name": name, "attributes": attrs}


def report(evaluators=("helpfulness",), score=0.9):
    """SDK EvaluationReport 的同形替身（observe 只按下标读这五项）。"""
    n = len(evaluators)
    return SimpleNamespace(
        cases=[{"evaluator": e} for e in evaluators],
        reasons=[""] * n,
        scores=[score] * n,
        test_passes=[True] * n,
        detailed_results=[[] for _ in range(n)],
    )


def run_session(output="", raw_spans=(), span_count=7) -> dict:
    """跑真的 evaluate_session，返回它组装出来的 session_result 事件。"""
    data = {"output": output, "trajectory": None}
    rep = report()

    class FakeExperiment:
        def __init__(self, cases=None, evaluators=None):
            pass

        async def run_evaluations_async(self, task, evaluation_data_store=None):
            return rep

    with mock.patch.object(observe.tracesource, "get_evaluation_data",
                           return_value=(data, list(raw_spans))), \
         mock.patch.object(observe, "build_evaluators", return_value=[object()]), \
         mock.patch.object(observe, "Experiment", FakeExperiment), \
         mock.patch.object(observe.transcript_mod, "build_transcript", return_value=None), \
         mock.patch.object(observe.diagnosis_mod, "needs_diagnosis", return_value=False):
        return asyncio.run(observe.evaluate_session(
            {"agent_name": "bi_metrics_assistant"},
            {"session_id": "sess-a41f9c2b", "span_count": span_count},
            ["helpfulness"], "global.anthropic.claude-sonnet-5", 30))


class TheWarningSaysWhatWasObserved(unittest.TestCase):
    """三档各自成立，且**只**成立那一档（互斥，不是「都含某个词」）。"""

    def test_no_spans_at_all_says_the_session_was_not_found(self):
        event = run_session(raw_spans=[], span_count=0)
        self.assertEqual(event["warning"], observe.WARN_NOT_FOUND)

    def test_spans_without_invoke_agent_say_the_trace_is_incomplete(self):
        """现网那一档（bi_metrics_assistant）：4 条 span、停在第一个
        event-loop cycle，收尾的 invoke_agent 记录从没出现。span 名照现读夹具
        `agentcore_spans_tau_airline_16.json` 的形态。"""
        event = run_session(raw_spans=[
            span("chat"), span("execute_tool query_metrics"),
            span("chat"), span("execute_tool query_metrics"),
        ], span_count=4)
        self.assertEqual(event["warning"], observe.WARN_INCOMPLETE)

    def test_a_complete_trace_without_messages_points_at_the_capture_switch(self):
        event = run_session(raw_spans=[
            span("chat"), span("invoke_agent Strands Agents")])
        self.assertEqual(event["warning"], observe.WARN_NO_MESSAGES)

    def test_a_name_that_merely_starts_with_invoke_agent_is_not_the_record(self):
        """边界探针（合成名，不是现网见过的形态）：认光前缀会把
        `invoke_agent…` 开头的别的名字读成收尾记录，于是「没写全」被误报成
        「已写全、多半是采集开关没开」—— 那正是本次要修掉的猜。"""
        event = run_session(raw_spans=[span("invoke_agent_stream_start")])
        self.assertEqual(event["warning"], observe.WARN_INCOMPLETE)

    def test_the_operation_attribute_counts_as_invoke_agent_too(self):
        """ADOT / Transaction Search 那条路不写 span 名，写
        `gen_ai.operation.name` —— 认不出它会把已写全的 trace 误报成没写全。"""
        event = run_session(raw_spans=[
            span("POST /invocations", operation="invoke_agent")])
        self.assertEqual(event["warning"], observe.WARN_NO_MESSAGES)

    def test_sources_that_disagree_are_reported_as_undecidable(self):
        """枚举数到过 span、这次取数一条没带回来：不许默认套采集开关那一档。"""
        event = run_session(raw_spans=[], span_count=12)
        self.assertEqual(event["warning"], observe.WARN_UNDECIDABLE)
        self.assertNotEqual(event["warning"], observe.WARN_NO_MESSAGES)


class TheWarningNeverGuessesACause(unittest.TestCase):
    """已被实测证伪的那句断言，不许在任何一档里出现。"""

    def test_only_the_complete_trace_tier_mentions_the_capture_switch(self):
        tiers = {
            "not_found": observe.WARN_NOT_FOUND,
            "incomplete": observe.WARN_INCOMPLETE,
            "undecidable": observe.WARN_UNDECIDABLE,
        }
        for name, text in tiers.items():
            with self.subTest(tier=name):
                self.assertNotIn("OTEL_INSTRUMENTATION_GENAI_CAPTURE", text)
        self.assertIn("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
                      observe.WARN_NO_MESSAGES)

    def test_no_tier_asserts_the_agent_was_deployed_without_the_flag(self):
        """旧文案的形状（「likely deployed without …」= 猜）一个字都不许留。"""
        for text in (observe.WARN_NOT_FOUND, observe.WARN_INCOMPLETE,
                     observe.WARN_NO_MESSAGES, observe.WARN_UNDECIDABLE):
            with self.subTest(text=text[:12]):
                self.assertNotIn("likely deployed", text)
                self.assertNotIn("unreliable", text)


class ExistingNoContentBehaviourIsUntouched(unittest.TestCase):
    """空响应不当 0 分那道守卫（ADR-0003）不许被这次改动动到。"""

    def test_no_content_still_errors_out_every_evaluator_score(self):
        event = run_session(raw_spans=[span("chat")])
        self.assertTrue(event["no_content"])
        row = event["results"]["helpfulness"]
        self.assertTrue(row["errored"])
        self.assertIsNone(row["score"])
        self.assertIsNone(row["passed"])
        self.assertIsNone(row["label"])

    def test_the_field_names_the_frontend_reads_are_unchanged(self):
        """`no_content` / `warning` 是 web/src/pages/** 的读点，改名等于白屏。"""
        event = run_session(raw_spans=[span("chat")])
        self.assertIn("no_content", event)
        self.assertIn("warning", event)
        self.assertIsInstance(event["warning"], str)


class AScoredSessionIsLeftAlone(unittest.TestCase):
    """阴性对照：有内容的会话不许挂 warning、不许被标 errored。"""

    def test_a_session_with_content_gets_no_warning_and_stays_scorable(self):
        event = run_session(output="本季度营收 1.2 亿元，同比 +8%。",
                            raw_spans=[span("chat")])
        self.assertNotIn("warning", event)
        self.assertNotIn("no_content", event)
        row = event["results"]["helpfulness"]
        self.assertFalse(row["errored"])
        self.assertEqual(row["score"], 0.9)
        self.assertTrue(row["passed"])

    def test_a_session_with_content_and_zero_spans_still_gets_no_warning(self):
        """warning 由「没有内容」触发，不由「没有 span」触发 —— 分档函数不许
        自己成为触发条件。"""
        event = run_session(output="有正文", raw_spans=[], span_count=0)
        self.assertNotIn("warning", event)


if __name__ == "__main__":
    unittest.main()
