"""线上评估（observe）环节的实时会话清单需要一个**分母**。

背景：observe 环节不发逐轮事件（会话是已完成的 trace，评的是历史，没有轮次
概念），只发 session_result / session_error —— 一条会话评完落一条。stage_start
里没有会话总数，前端就只能数上去（「已评 3 个」），永远说不出「3/10」。

本测试钉住新增的 observe_sessions 事件契约：
  {"event": "observe_sessions", "stage": <环节号>, "total": <本环节会话总数>}

三条硬纪律：
  1. **只加不改**：stage_start / session_result / session_error 的既有字段一个
     不动（改了前端两处白屏入口就会被踩到）。
  2. 空会话（list_sessions 返回 []）**不发**这个事件 —— 承诺了一个不会送达的
     分母，界面会永远卡在「已评 0/0」。
  3. `explicit` 手挑 session_ids 那条路（专家逃生口）**也要发** —— 它是最容易
     漏的分支，因为它绕过了 list_sessions。

字段名是 total 而不是 sessions：本环节的返回值里 `sessions` 已经表示「评完了
几条」（planrun.py 的 observe 结果与 _stage_summary 都是这个口径），拿同名 key
当分母，「3/10」就会变成「10/10」。

不碰任何真 AWS / 真 agent / 真 LLM：list_sessions 与 observe.evaluate_session 全打桩。
运行：python3 -m pytest tests/test_observe_sessions_event.py -q
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import planrun  # noqa: E402

AGENT = {"agent_name": "support-bot", "agent_arn": "arn:aws:bedrock:x:y:runtime/z"}


def sess(i: int) -> dict:
    return {"session_id": f"sess-{i:04d}", "last_ts": 1787000000 + i, "span_count": 7}


def ok_result(session_id: str) -> dict:
    """一条 session_result 的真形态（照 app/observe.py:evaluate_session 的返回）。"""
    return {
        "event": "session_result", "agent": AGENT["agent_name"],
        "session_id": session_id, "span_count": 7,
        "output_preview": "已为您改签至周五 08:15 的 MU5401。",
        "results": {"helpfulness": {"score": 0.9, "passed": True,
                                    "errored": False, "reason": "回答完整"}},
        "metrics": None, "transcript": None, "diagnosis": None,
    }


class _Harness:
    """跑一次 observe 环节，收集 emit 出去的事件流。"""

    def __init__(self, sessions, evaluate=None):
        self.sessions = sessions
        self.events = []
        self.evaluate = evaluate or (lambda s: ok_result(s["session_id"]))

    async def _emit(self, ev):
        self.events.append(ev)

    def run(self, stage=None, stage_no=2):
        stage = stage if stage is not None else {
            "type": "observe", "evaluators": ["helpfulness"], "metrics": [],
            "lookback_days": 30, "max_sessions": 10,
        }

        async def fake_evaluate(agent, session, *a, **kw):
            return self.evaluate(session)

        # 评估核心住在 observe（planrun 顶层 import 它，不再函数内 import main）
        observe_stub = mock.Mock()
        observe_stub.evaluate_session = fake_evaluate
        observe_stub.summarize = mock.Mock(return_value={})
        observe_stub.generate_analysis = mock.AsyncMock(return_value=None)
        metrics_stub = mock.Mock(METRIC_KEYS=set(),
                                 aggregate_agent_metrics=mock.Mock(return_value=None))
        trace_stub = mock.Mock(list_sessions=mock.Mock(return_value=self.sessions))

        with mock.patch.object(planrun, "observe", observe_stub), \
                mock.patch.dict(sys.modules, {"metrics": metrics_stub,
                                              "tracesource": trace_stub}), \
                mock.patch.object(planrun.catalog, "list_custom_evaluators",
                                  return_value=[]):
            self.result = asyncio.run(planrun._run_observe_stage(
                stage, AGENT, "judge-model", self._emit, stage_no))
        return self

    def of(self, name):
        return [e for e in self.events if e["event"] == name]


class ObserveSessionsEvent(unittest.TestCase):
    def test_emits_total_before_any_session_result(self):
        """分母必须**先于**任何一条会话结果到达，否则第一行落下来时还没有分母。"""
        h = _Harness([sess(i) for i in range(3)]).run(stage_no=2)
        kinds = [e["event"] for e in h.events]
        self.assertEqual(kinds[0], "observe_sessions", kinds)
        self.assertEqual(h.of("observe_sessions"),
                         [{"event": "observe_sessions", "stage": 2, "total": 3}])
        self.assertEqual(len(h.of("session_result")), 3)

    def test_contract_is_exactly_three_keys(self):
        """三个键，一个不多一个不少 —— 前端按这个形态解析。"""
        ev = _Harness([sess(0)]).run().of("observe_sessions")[0]
        self.assertEqual(set(ev), {"event", "stage", "total"})
        self.assertIsInstance(ev["total"], int)
        self.assertIsInstance(ev["stage"], int)

    def test_stage_no_comes_from_the_caller(self):
        """环节号原样透传：一个方案里两个 observe 环节要能分开。"""
        self.assertEqual(
            _Harness([sess(0)]).run(stage_no=5).of("observe_sessions")[0]["stage"], 5)

    def test_no_event_when_there_are_no_sessions(self):
        """空会话不发分母（发了界面会永远卡在「已评 0/0」）。"""
        h = _Harness([]).run()
        self.assertEqual(h.of("observe_sessions"), [])
        self.assertEqual(h.events, [])
        self.assertEqual(h.result["status"], "empty")
        # 既有返回字段不动：这里的 sessions 仍是「评完几条」= 0
        self.assertEqual(h.result["sessions"], 0)

    def test_explicit_session_ids_path_also_emits(self):
        """手挑 session_ids 的专家逃生口绕过 list_sessions，最容易漏发。"""
        stage = {"type": "observe", "evaluators": ["helpfulness"], "metrics": [],
                 "lookback_days": 30, "max_sessions": 10,
                 "session_ids": ["sess-aaa", " sess-bbb ", "", "   "]}
        h = _Harness([sess(9)]).run(stage=stage, stage_no=1)
        # 空白 id 被后端过滤掉 → 分母是**过滤后**的条数（2），不是原数组长度（4）
        self.assertEqual(h.of("observe_sessions"),
                         [{"event": "observe_sessions", "stage": 1, "total": 2}])
        self.assertEqual(
            sorted(e["session_id"] for e in h.of("session_result")),
            ["sess-aaa", "sess-bbb"])

    def test_total_counts_planned_sessions_not_successful_ones(self):
        """分母是**计划评的**条数，不是评成功的条数：失败的也占一格，
        否则一条 session_error 就会让「3/3」变成「2/3」再也补不齐。"""
        def evaluate(s):
            if s["session_id"] == "sess-0001":
                return {"event": "session_error", "agent": AGENT["agent_name"],
                        "session_id": s["session_id"], "span_count": 7,
                        "error": "TraceProviderError: no spans in window"}
            return ok_result(s["session_id"])

        h = _Harness([sess(i) for i in range(3)], evaluate=evaluate).run()
        self.assertEqual(h.of("observe_sessions")[0]["total"], 3)
        self.assertEqual(len(h.of("session_result")), 2)
        self.assertEqual(len(h.of("session_error")), 1)
        # 结果里的 sessions 是「评成功几条」——与事件里的 total 是两个量，别混
        self.assertEqual(h.result["sessions"], 2)

    def test_existing_session_events_untouched(self):
        """只加不改：session_result / session_error 的键集合没被动过。"""
        def evaluate(s):
            if s["session_id"] == "sess-0000":
                return {"event": "session_error", "agent": AGENT["agent_name"],
                        "session_id": s["session_id"], "span_count": 7,
                        "error": "boom"}
            return ok_result(s["session_id"])

        h = _Harness([sess(i) for i in range(2)], evaluate=evaluate).run()
        self.assertEqual(
            set(h.of("session_result")[0]),
            {"event", "agent", "session_id", "span_count", "output_preview",
             "results", "metrics", "transcript", "diagnosis"})
        self.assertEqual(
            set(h.of("session_error")[0]),
            {"event", "agent", "session_id", "span_count", "error"})


class EventNameIsNotAlreadyTaken(unittest.TestCase):
    def test_observe_sessions_is_a_new_event_name(self):
        """新事件名不能撞既有事件（撞了前端的 switch 会走错分支）。"""
        src = (Path(__file__).resolve().parent.parent / "app" / "planrun.py").read_text()
        self.assertEqual(src.count('"event": "observe_sessions"'), 1)

    def test_emitted_after_the_empty_return(self):
        """源码顺序护栏：emit 必须在 `if not sessions: return` **之后**。
        顺序反了，空会话 run 会先承诺一个 0 分母再什么都不送。"""
        src = (Path(__file__).resolve().parent.parent / "app" / "planrun.py").read_text()
        empty_at = src.index('"status": "empty"')
        emit_at = src.index('"event": "observe_sessions"')
        self.assertLess(empty_at, emit_at)


if __name__ == "__main__":
    unittest.main()
