"""只用上报数据评估（ADR-0019 批 2）：回归用例的评分输入切到 span 还原的对话。

三层各钉一组：
  · tracesource.scoring_input_from_session：从真 Session 还原 output / turns / tool_calls /
    span_ids —— 最终回复取结束最晚的 invoke_agent；`[{'text': …}]` 形的回复还原成正文；
    工具事件形状与 transcript.build_transcript 同源；没有最终回复 ⇒ None；
    现网原样夹具（tau-airline-16 两条记录）能还原出评分输入；
  · testrun.execute_test_run(trace_mark=…)：关 = 一个键都不多、judge 收到的是返回文本；
    开 = 三段式（全部调用完 → 一次核对 → 只给 ok 行评分），judge 收到的是 trace 文本而不是
    返回（夹具让两者不同）、scored_from / output_response / response_matches_trace、工具证据
    与评分共用同一次 fetch、核对没过的行不判不 fetch、还原不出最终回复 ⇒ no_content、
    全缺 ⇒ run 状态 no_trace、第一阶段被停止 ⇒ 不核对、simulation 类多轮的整段对话也从
    span 还原（驾驭记录 entry["conversation"] 不动）；
  · planrun._run_dataset_stage：开关开 ⇒ 把 trace_mark 交给执行侧且不再事后重复核对；
    关 ⇒ trace_mark=None。

不碰真 agent / 真 judge / 真 AWS：被测 Agent、judge（Experiment）、取 span（fetch_session）
全部打桩；DynamoDB 走 moto。
运行：python3 -m pytest tests/test_trace_scoring.py -q
"""

import asyncio
import json
import os
import sys
import unittest
import uuid
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import boto3
from moto import mock_aws

APP = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(APP))

os.environ.pop("ARTIFACTS_BUCKET", None)

import patches  # noqa: E402

patches.apply()

import catalog  # noqa: E402
import planrun  # noqa: E402
import testrun  # noqa: E402
import tracesource  # noqa: E402
import transcript  # noqa: E402
from strands_evals.types.trace import (  # noqa: E402
    AgentInvocationSpan, Session, SpanInfo, ToolCall, ToolExecutionSpan, ToolResult, Trace,
)

TABLE = "eval-catalog-test"
REGION = "us-west-2"
AGENT = "support-bot"
RUNTIME_GROUP = "/aws/bedrock-agentcore/runtimes/support-bot-AbC123-DEFAULT"
CFG = {"log_group": RUNTIME_GROUP, "scope_filter": "", "service_filter": ""}
META = {AGENT: {"runtime_arn": "arn:aws:bedrock-agentcore:us-west-2:1:runtime/x",
                "model": "", "log_group": RUNTIME_GROUP}}
RESPONSE = "返回文本：30 天内可退货。"
TRACE_TEXT = "trace 文本：30 天内可无理由退货，需保留吊牌。"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "agentcore_spans_tau_airline_16.json"
FIXTURE_SID = "evaltest-202608261402-a21f78ee45d54295909e8c2fd73c45a6"

T0 = datetime(2026, 9, 7, 12, 0, 0, tzinfo=timezone.utc)


def _info(sid: str, start_s: float, end_s: float, span_id: str | None = None,
          parent: str | None = None) -> SpanInfo:
    return SpanInfo(trace_id="t" * 32, span_id=span_id or uuid.uuid4().hex[:16], session_id=sid,
                    parent_span_id=parent, start_time=T0 + timedelta(seconds=start_s),
                    end_time=T0 + timedelta(seconds=end_s))


def make_session(sid: str, exchanges: list[tuple], tools: list[tuple] = ()) -> Session:
    """exchanges: [(user, response, start_s, end_s[, span_id])]；tools: [(name, args, result, start_s)]。"""
    spans = []
    for ex in exchanges:
        user, resp, start_s, end_s = ex[:4]
        span_id = ex[4] if len(ex) > 4 else None
        spans.append(AgentInvocationSpan(span_info=_info(sid, start_s, end_s, span_id),
                                         user_prompt=user, agent_response=resp, available_tools=[]))
    for name, args, result, start_s in tools:
        spans.append(ToolExecutionSpan(span_info=_info(sid, start_s, start_s + 0.5, parent=spans[0].span_info.span_id),
                                       tool_call=ToolCall(name=name, arguments=args),
                                       tool_result=ToolResult(content=result),
                                       agent_span_id=spans[0].span_info.span_id))
    return Session(traces=[Trace(spans=spans, trace_id="t" * 32, session_id=sid)], session_id=sid)


# ---------------- tracesource：从 Session 还原评分输入 ----------------

class ScoringInput(unittest.TestCase):
    def test_final_output_is_the_latest_ending_invoke_agent(self):
        s = make_session("s1", [("第一问", "第一答", 0, 5, "a" * 16), ("第二问", "第二答", 6, 12, "b" * 16)],
                         tools=[("lookup", {"q": "x"}, "找到 3 条", 2)])
        si = tracesource.scoring_input_from_session(s)
        self.assertEqual(si["output"], "第二答")
        self.assertEqual([(t["role"], t["message"]) for t in si["turns"]],
                         [("user", "第一问"), ("assistant", "第一答"), ("user", "第二问"), ("assistant", "第二答")])
        self.assertEqual(si["turns"][1]["span_id"], "a" * 16)
        self.assertEqual(len(si["tool_calls"]), 1)
        self.assertEqual(si["tool_calls"][0]["name"], "lookup")
        self.assertEqual(si["tool_calls"][0]["result"], "找到 3 条")
        self.assertIn("a" * 16, si["span_ids"])
        self.assertIn("b" * 16, si["span_ids"])
        self.assertEqual(len(si["span_ids"]), len(set(si["span_ids"])), "span_ids 去重")

    def test_latest_by_end_time_not_by_order(self):
        """最终回复按结束时间挑，不按 span 在列表里的先后（多批导出的顺序不可信）。"""
        s = make_session("s1", [("问", "晚结束的答", 0, 20), ("问", "早结束的答", 1, 3)])
        self.assertEqual(tracesource.scoring_input_from_session(s)["output"], "晚结束的答")

    def test_tool_event_shape_is_the_transcript_one(self):
        """工具调用的键必须是 transcript.build_transcript 里 tool 事件的键的子集——不另起一套。"""
        s = make_session("s1", [("问", "答", 0, 5)], tools=[("lookup", {"q": "x"}, "r", 2)])
        tool_events = [e for e in transcript.build_transcript(s)["events"] if e["type"] == "tool"]
        self.assertTrue(tool_events)
        self.assertTrue(set(tracesource.scoring_input_from_session(s)["tool_calls"][0]) <= set(tool_events[0]))

    def test_choice_event_blob_is_unwrapped_to_plain_text(self):
        """mapper 从 gen_ai.choice 拿的回复是 str(list[dict])：judge 不该拿到那段 JSON 样的字符串。"""
        s = make_session("s1", [("问", "[{'text': '正文第一段'}, {'text': '正文第二段'}]", 0, 5)])
        self.assertEqual(tracesource.scoring_input_from_session(s)["output"], "正文第一段\n正文第二段")
        self.assertEqual(tracesource._plain_text('[{"type": "text", "text": "x"}]'), "x")
        self.assertEqual(tracesource._plain_text("答案是 [1, 2]"), "答案是 [1, 2]")
        self.assertEqual(tracesource._plain_text("[1, 2]"), "[1, 2]", "不是 list[dict] 就原样交出")

    def test_no_final_output_is_none(self):
        s = make_session("s1", [("问", "", 0, 5)], tools=[("lookup", {}, "r", 2)])
        self.assertIsNone(tracesource.scoring_input_from_session(s), "只有工具 span、没有回复 ⇒ None")
        self.assertIsNone(tracesource.scoring_input_from_session(make_session("s1", [("问", "   ", 0, 5)])))
        self.assertIsNone(tracesource.scoring_input_from_session(Session(traces=[], session_id="s1")))

    def test_live_fixture_restores_a_scoring_input(self):
        """现网原样导出的 tau-airline-16 两条记录（runtime 日志组形态）：invoke_agent + execute_tool。"""
        session, _ = tracesource._session_from_records("lg", FIXTURE_SID, json.loads(FIXTURE.read_text()))
        si = tracesource.scoring_input_from_session(session)
        self.assertIn("转接人工客服", si["output"])
        self.assertFalse(si["output"].startswith("["), "回复必须是正文，不是 [{'text': …}] 结构")
        self.assertEqual([c["name"] for c in si["tool_calls"]], ["transfer_to_human_agents"])
        self.assertEqual(si["tool_calls"][0]["span_id"], "c38c5ab1f6ac4975")
        self.assertEqual([t["role"] for t in si["turns"]], ["user", "assistant"])


# ---------------- testrun：三段式评分 ----------------

class FakeReport:
    def __init__(self, names, score=0.9):
        self.cases = [{"evaluator": n} for n in names]
        self.reasons = ["判定理由" for _ in names]
        self.scores = [score for _ in names]
        self.test_passes = [score >= 0.5 for _ in names]


JUDGE_INPUTS: list[dict] = []


class FakeExperiment:
    """替掉 strands_evals.Experiment：记下 judge 收到的 task_out，不发一次 judge 调用。"""

    def __init__(self, cases=None, evaluators=None, **kw):
        self._names = [e.name for e in (evaluators or [])]
        self._case = (cases or [None])[0]

    async def run_evaluations_async(self, task, **kw):
        out = task(None)
        JUDGE_INPUTS.append({"case": getattr(self._case, "name", None), "output": out["output"],
                             "trajectory": out.get("trajectory")})
        return FakeReport(self._names)


def make_mark(ok=lambda sid: True, sources=("aws/spans",)):
    """trace_mark 桩：按 sid 判有没有内容 span，走真 apply_trace_check；记下调用时刻的状态。"""
    calls: list[dict] = []

    async def mark(run, rows):
        calls.append({"rows": len(rows), "judged_before": sum(1 for r in rows if "results" in r),
                      "judge_calls_before": len(JUDGE_INPUTS)})
        checks = {r["session_id"]: {"spans": 5, "content_spans": 2, "services": ["svc"]}
                  for r in rows if r.get("session_id") and ok(r["session_id"])}
        return testrun.apply_trace_check(run, rows, lambda r: [r["session_id"]] if r.get("session_id") else [],
                                         checks, sources=list(sources))
    return mark, calls


class Harness(unittest.TestCase):
    def setUp(self):
        JUDGE_INPUTS.clear()
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
        for p in (mock.patch.object(catalog, "get_table", return_value=self.table),
                  mock.patch.object(catalog, "TABLE_NAME", TABLE),
                  mock.patch.object(catalog, "get_agent_config", return_value={}),
                  mock.patch.object(testrun, "_table", return_value=self.table),
                  mock.patch.object(testrun, "SPAN_FETCH_BACKOFF", (0,)),
                  mock.patch.object(testrun.pricing, "get_prices",
                                    return_value={"prices": {}, "last_sync": None}),
                  mock.patch.object(testrun.tracesource, "resolve_span_config", return_value=CFG),
                  mock.patch.object(testrun, "build_evaluators",
                                    lambda names, model, rubrics=None: [SimpleNamespace(name=n) for n in names]),
                  mock.patch("strands_evals.Experiment", FakeExperiment),
                  mock.patch.object(testrun, "_generate_run_analysis",
                                    new=mock.AsyncMock(return_value="解析"))):
            p.start()
            self.addCleanup(p.stop)
        self.fetches: list[tuple] = []
        self.invoked: list[str] = []

    def _run(self, *, trace_mark=None, sessions=None, cases=None, evaluators=("correctness",),
             stop_check=None, sim=None, response=RESPONSE):
        """sessions: sid 后缀无关 —— 桩按会话 id 回 Session；None ⇒ SessionNotFound。"""
        from strands_evals.providers.exceptions import SessionNotFoundError

        dataset = {"name": "faq", "cases": cases or [{"name": "c1", "input": "退货政策？"}]}

        def fake_invoke(arn, cfg, case_input, sid):
            self.invoked.append(sid)
            return response

        def fake_fetch(cfg, sid, lookback_days=1, low_latency=False):
            self.fetches.append((cfg["log_group"], sid, low_latency))
            session = (sessions or {}).get("*") or (sessions or {}).get(sid)
            if session is None:
                raise SessionNotFoundError(sid)
            return (session(sid) if callable(session) else session), []

        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(testrun, "invoke_agent", fake_invoke))
            stack.enter_context(mock.patch.object(testrun.tracesource, "fetch_session", fake_fetch))
            if sim is not None:
                stack.enter_context(mock.patch.object(testrun, "_run_simulated_conversation", sim))
            return asyncio.run(testrun.execute_test_run(
                "run-20260907120000", dataset, [AGENT], list(evaluators), "judge", {},
                META, {"estimated_cost_usd": 1.0}, stop_check=stop_check, trace_mark=trace_mark))


NEW_KEYS = {"scored_from", "output_response", "response_matches_trace", "trace"}


class SwitchOff(Harness):
    def test_judge_gets_the_response_and_rows_carry_no_new_keys(self):
        run = self._run(sessions={"*": lambda sid: make_session(sid, [("退货政策？", TRACE_TEXT, 0, 3)])})
        row = run["results"][0]
        self.assertEqual([j["output"] for j in JUDGE_INPUTS], [RESPONSE], "关着开关 judge 看的是返回")
        self.assertEqual(row["output"], RESPONSE)
        self.assertFalse(NEW_KEYS & set(row), f"关着开关行上多了键：{NEW_KEYS & set(row)}")
        self.assertNotIn("trace_summary", run)
        self.assertNotIn("trace_status", run)
        self.assertEqual(run["status"], "completed")
        # 工具证据那条路照旧自己去取（这是修复前就有的行为，不是批 2 加的）
        self.assertEqual(row["tool_evidence"]["status"], "captured")


class SwitchOn(Harness):
    def test_judge_gets_trace_text_not_the_response(self):
        mark, calls = make_mark()
        session = lambda sid: make_session(sid, [("退货政策？", TRACE_TEXT, 0, 3)],  # noqa: E731
                                           tools=[("policy_lookup", {"topic": "退货"}, "30 天", 1)])
        run = self._run(trace_mark=mark, sessions={"*": session},
                        cases=[{"name": "c1", "input": "退货政策？"}, {"name": "c2", "input": "改绑手机？"}])
        self.assertEqual(sorted(j["output"] for j in JUDGE_INPUTS), [TRACE_TEXT, TRACE_TEXT])
        for row in run["results"]:
            self.assertEqual(row["scored_from"], "trace")
            self.assertEqual(row["output"], TRACE_TEXT)
            self.assertEqual(row["output_response"], RESPONSE)
            self.assertIs(row["response_matches_trace"], False)
            self.assertEqual(row["trace"]["status"], "ok")
            self.assertEqual(row["trace"]["sources"], ["aws/spans"])
            self.assertTrue(row["trace"]["span_ids"], "评分用到的 span id 要落在 trace 字段上")
            self.assertEqual(row["results"]["correctness"]["score"], 0.9)
        self.assertEqual(run["trace_summary"], {"required": True, "ok": 2, "no_trace": 0})
        self.assertEqual(run["trace_status"], "ok")
        self.assertEqual(run["status"], "completed")

    def test_order_is_invoke_all_then_check_once_then_judge(self):
        mark, calls = make_mark()
        cases = [{"name": f"c{i}", "input": "问"} for i in range(3)]
        self._run(trace_mark=mark, sessions={"*": lambda sid: make_session(sid, [("问", TRACE_TEXT, 0, 3)])},
                  cases=cases)
        self.assertEqual(len(calls), 1, "核对整个环节一次，不是每例一次")
        self.assertEqual(calls[0], {"rows": 3, "judged_before": 0, "judge_calls_before": 0},
                         "核对发生在全部调用完、任何评分之前")
        self.assertEqual(len(self.invoked), 3)
        self.assertEqual(len(JUDGE_INPUTS), 3)

    def test_tool_evidence_and_scoring_share_one_fetch(self):
        mark, _ = make_mark()
        session = lambda sid: make_session(sid, [("问", TRACE_TEXT, 0, 3)],  # noqa: E731
                                           tools=[("policy_lookup", {"topic": "退货"}, "30 天", 1)])
        run = self._run(trace_mark=mark, sessions={"*": session})
        row = run["results"][0]
        self.assertEqual(len(self.fetches), 1, "评分与工具证据共用同一次 fetch")
        self.assertEqual(row["tool_evidence"]["status"], "captured")
        self.assertEqual(row["tool_evidence"]["names"], ["policy_lookup"])
        # 判官拿到的合成 Session 上已经嫁接了那条真工具 span
        traj = JUDGE_INPUTS[0]["trajectory"]
        tools = [sp for tr in traj.traces for sp in tr.spans if isinstance(sp, ToolExecutionSpan)]
        self.assertEqual([t.tool_call.name for t in tools], ["policy_lookup"])

    def test_fetch_reads_the_shared_group_with_insights_and_runtime_group_low_latency(self):
        """aws/spans 是共享组：同一 session.id 下还有平台自家 span，只能走 Insights 带过滤；
        runtime 日志组是 Agent 独占的，走低延迟读法。按核对真查过的组顺序试。"""
        mark, _ = make_mark(sources=("aws/spans", RUNTIME_GROUP))
        central_cfg = {"log_group": "aws/spans", "scope_filter": "", "service_filter": "deepseek-harness"}

        def only_runtime(sid):
            return make_session(sid, [("问", TRACE_TEXT, 0, 3)])

        from strands_evals.providers.exceptions import SessionNotFoundError

        def fake_fetch(cfg, sid, lookback_days=1, low_latency=False):
            self.fetches.append((cfg["log_group"], cfg.get("service_filter"), low_latency))
            if cfg["log_group"] == "aws/spans":
                raise SessionNotFoundError(sid)
            return only_runtime(sid), []

        with mock.patch.object(testrun.tracesource, "resolve_span_config", return_value=central_cfg), \
                mock.patch.object(testrun, "invoke_agent", lambda *a: RESPONSE), \
                mock.patch.object(testrun.tracesource, "fetch_session", fake_fetch):
            run = asyncio.run(testrun.execute_test_run(
                "run-20260907120001", {"name": "faq", "cases": [{"name": "c1", "input": "问"}]},
                [AGENT], ["correctness"], "judge", {}, META, {"estimated_cost_usd": 1.0}, trace_mark=mark))
        self.assertEqual(self.fetches, [("aws/spans", "deepseek-harness", False), (RUNTIME_GROUP, "", True)])
        self.assertEqual(run["results"][0]["scored_from"], "trace")

    def test_no_trace_rows_are_neither_fetched_nor_judged(self):
        mark, _ = make_mark(ok=lambda sid: sid.endswith(self.invoked[0][-8:]) if self.invoked else False)
        cases = [{"name": "c1", "input": "问"}, {"name": "c2", "input": "问"}]
        # 只有第一条被调用的会话有内容 span；第二条核对不过
        run = self._run(trace_mark=mark, sessions={"*": lambda sid: make_session(sid, [("问", TRACE_TEXT, 0, 3)])},
                        cases=cases)
        ok_rows = [r for r in run["results"] if r["trace"]["status"] == "ok"]
        no_rows = [r for r in run["results"] if r["trace"]["status"] == "no_trace"]
        self.assertEqual((len(ok_rows), len(no_rows)), (1, 1))
        self.assertEqual(len(self.fetches), 1, "核对没过的行不去 fetch")
        self.assertEqual(len(JUDGE_INPUTS), 1, "核对没过的行不判分（judge 钱省下）")
        self.assertNotIn("results", no_rows[0])
        self.assertNotIn("scored_from", no_rows[0])
        self.assertEqual(no_rows[0]["output"], RESPONSE, "没判的行 output 仍是返回（供对照），不换")
        self.assertEqual(no_rows[0]["trace"]["reason"], "no_span")
        self.assertEqual(run["trace_summary"], {"required": True, "ok": 1, "no_trace": 1})
        self.assertEqual(run["trace_status"], "degraded_no_trace")

    def test_no_final_output_becomes_no_content_and_all_missing_makes_run_no_trace(self):
        mark, _ = make_mark()
        # 核对说有内容 span，但取回的 Session 里没有 agent_response（只有工具 span）
        run = self._run(trace_mark=mark,
                        sessions={"*": lambda sid: make_session(sid, [("问", "", 0, 3)], tools=[("t", {}, "r", 1)])})
        row = run["results"][0]
        self.assertEqual(row["trace"]["status"], "no_trace")
        self.assertEqual(row["trace"]["reason"], "no_content")
        self.assertEqual(row["trace"]["spans"], 5, "核对读到的 span 数原样保留")
        self.assertNotIn("results", row)
        self.assertEqual(JUDGE_INPUTS, [])
        self.assertEqual(run["trace_summary"], {"required": True, "ok": 0, "no_trace": 1}, "汇总按评分阶段的改判重算")
        self.assertEqual(run["trace_status"], "no_trace")
        self.assertEqual(run["status"], "no_trace")

    def test_session_not_found_after_check_is_no_content_and_query_error_is_fetch_error(self):
        mark, _ = make_mark()
        run = self._run(trace_mark=mark, sessions={})
        self.assertEqual(run["results"][0]["trace"]["reason"], "no_content")

        def boom(cfg, sid, lookback_days=1, low_latency=False):
            raise RuntimeError("Logs Insights query Failed")

        mark, _ = make_mark()
        with mock.patch.object(testrun, "invoke_agent", lambda *a: RESPONSE), \
                mock.patch.object(testrun.tracesource, "fetch_session", boom):
            run = asyncio.run(testrun.execute_test_run(
                "run-20260907120002", {"name": "faq", "cases": [{"name": "c1", "input": "问"}]},
                [AGENT], ["correctness"], "judge", {}, META, {"estimated_cost_usd": 1.0}, trace_mark=mark))
        self.assertEqual(run["results"][0]["trace"]["reason"], "fetch_error")
        self.assertNotIn("results", run["results"][0])

    def test_matching_response_is_flagged_true(self):
        mark, _ = make_mark()
        run = self._run(trace_mark=mark, response="  30 天内\n可退货。 ",
                        sessions={"*": lambda sid: make_session(sid, [("问", "30 天内 可退货。", 0, 3)])})
        self.assertIs(run["results"][0]["response_matches_trace"], True, "只归一空白，其余逐字比")
        self.assertTrue(testrun.same_text("a  b", "a b"))
        self.assertFalse(testrun.same_text("a b", "a b。"))

    def test_stopped_in_phase_one_skips_the_check(self):
        mark, calls = make_mark()
        run = self._run(trace_mark=mark, stop_check=lambda: True,
                        sessions={"*": lambda sid: make_session(sid, [("问", TRACE_TEXT, 0, 3)])})
        self.assertEqual(run["status"], testrun.STOP_STATUS)
        self.assertEqual(calls, [], "用户刚要求停止：不再等 135 s 核对（planrun 环节结束后照批 1 兜底）")
        self.assertEqual(JUDGE_INPUTS, [])
        self.assertNotIn("trace_summary", run)

    def test_simulation_case_judges_the_conversation_restored_from_spans(self):
        """simulation 类数据集（task_description 多轮）：judge 看的整段对话也从 span 还原；
        驾驭出来的对话记录（entry["conversation"]）保留原样供对照。"""
        mark, _ = make_mark()
        driven = [{"role": "user", "message": "我要退货"}, {"role": "agent", "message": "返回 A1"},
                  {"role": "user", "message": "多久到账"}, {"role": "agent", "message": "返回 A2"}]

        def fake_sim(arn, cfg, case, sid, judge_model, on_turn=None):
            self.invoked.append(sid)
            return {"turns": driven, "output": "返回 A2", "n_turns": 2, "goal_reached": True}

        session = lambda sid: make_session(sid, [("我要退货", "trace A1", 0, 3), ("多久到账", "trace A2", 4, 8)])  # noqa: E731
        run = self._run(trace_mark=mark, sim=fake_sim, sessions={"*": session},
                        cases=[{"name": "sim-1", "input": "我要退货", "task_description": "退货并问到账时间",
                                "max_turns": 3}])
        self.assertEqual(JUDGE_INPUTS[0]["output"],
                         "[用户] 我要退货\n[助手] trace A1\n[用户] 多久到账\n[助手] trace A2")
        row = run["results"][0]
        self.assertEqual(row["conversation"], driven, "驾驭记录不动")
        self.assertEqual(row["output"], "trace A2")
        self.assertEqual(row["output_response"], "返回 A2")
        self.assertEqual(row["scored_from"], "trace")
        self.assertEqual(row["n_turns"], 2)
        # 合成 Session 按 trace 的两轮建：judge 的 trajectory 有两格
        self.assertEqual(len(JUDGE_INPUTS[0]["trajectory"].traces), 2)

    def test_simulation_turns_keep_their_order_when_invocation_spans_overlap(self):
        """批 3 口径：多轮顺序按**调用配对**取，不按扁平时间线 —— 第 2 轮 invoke_agent 在第 1 轮
        回复 span 结束之前就开始时（现网 aws/spans 实测形态），按时刻排序会把整段对话穿插成
        「用户 / 用户 / 助手 / 助手」，judge 读到的就不是这场对话的顺序了。"""
        mark, _ = make_mark()

        def fake_sim(arn, cfg, case, sid, judge_model, on_turn=None):
            return {"turns": [{"role": "user", "message": "我要退货"},
                              {"role": "agent", "message": "返回 A1"},
                              {"role": "user", "message": "多久到账"},
                              {"role": "agent", "message": "返回 A2"}],
                    "output": "返回 A2", "n_turns": 2, "goal_reached": True}

        # 第 1 轮 0~9s、第 2 轮 3~5s（重叠）
        session = lambda sid: make_session(  # noqa: E731
            sid, [("我要退货", "trace A1", 0, 9), ("多久到账", "trace A2", 3, 5)])
        self._run(trace_mark=mark, sim=fake_sim, sessions={"*": session},
                  cases=[{"name": "sim-1", "input": "我要退货", "task_description": "退货并问到账时间",
                          "max_turns": 3}])
        self.assertEqual(JUDGE_INPUTS[0]["output"],
                         "[用户] 我要退货\n[助手] trace A1\n[用户] 多久到账\n[助手] trace A2")
        # 阴性对照：同一条会话的扁平时间线确实是穿插的（这条口径不是多余的）
        flat = [t["role"] for t in tracesource.scoring_input_from_session(session("s"))["turns"]]
        self.assertEqual(flat, ["user", "user", "assistant", "assistant"])


# ---------------- planrun：把核对交给执行侧 ----------------

class StageWiring(unittest.TestCase):
    DATASET = {"name": "faq", "cases": [{"name": "c1", "input": "hi"}]}
    STAGE = {"type": "dataset", "dataset": "faq", "evaluators": ["correctness"], "agent_model": "m"}
    PLAN = {"plan_id": "plan-1", "name": "回归", "agent_name": AGENT, "stages": []}
    AGENT_D = {"agent_name": AGENT, "runtime_arn": "arn:x", "log_group": RUNTIME_GROUP}

    def _stage(self, plan: dict, run: dict, probe=None):
        """probe(exec_mock, mark_mock)：在打桩上下文**内**跑的额外断言（trace_mark 闭包引用的是
        planrun 模块全局 _mark_traces，出了上下文再调它就是真函数）。"""
        exec_mock = mock.AsyncMock(return_value=run)
        mark_mock = mock.AsyncMock(return_value={"required": True, "ok": 1, "no_trace": 0})

        async def emit(_ev):
            pass

        with mock.patch.object(planrun.catalog, "get_dataset", return_value=self.DATASET), \
                mock.patch.object(planrun.catalog, "list_custom_evaluators", return_value=[]), \
                mock.patch.object(planrun.testrun, "estimate_test_run", return_value={"estimated_cost_usd": 0.5}), \
                mock.patch.object(planrun.testrun, "execute_test_run", new=exec_mock), \
                mock.patch.object(planrun, "_mark_traces", new=mark_mock), \
                mock.patch.object(planrun.tracesource, "resolve_span_config",
                                  side_effect=AssertionError("不许碰真 span 配置")):
            asyncio.run(planrun._run_dataset_stage(self.STAGE, plan, self.AGENT_D, "judge", emit))
            if probe is not None:
                probe(exec_mock, mark_mock)
        return exec_mock, mark_mock

    @staticmethod
    def _run(**extra):
        run = {"run_id": "run-1", "dataset": "faq", "agents": [AGENT], "evaluators": ["correctness"],
               "judge_model": "judge", "status": "completed", "total_cases": 1, "completed_cases": 1,
               "results": [{"agent": AGENT, "case": "c1", "input": "hi", "output": "答", "session_id": "evaltest-1",
                            "results": {"correctness": {"score": 0.9, "passed": True, "errored": False}}}],
               "actual_cost_usd": 0.1, "blank_cases": 0}
        run.update(extra)
        return run

    def test_switch_on_hands_trace_mark_to_the_executor_and_does_not_recheck(self):
        def probe(exec_mock, mark_mock):
            tm = exec_mock.call_args.kwargs.get("trace_mark")
            self.assertTrue(callable(tm), "开着开关必须把 trace_mark 交给执行侧")
            mark_mock.assert_not_called()
            # 执行侧真调它时就是 planrun._mark_traces（agent + _dataset_sids 已绑定）
            asyncio.run(tm({"status": "running"}, []))
            mark_mock.assert_called_once()
            self.assertIs(mark_mock.call_args.args[2], self.AGENT_D)
            self.assertIs(mark_mock.call_args.args[3], planrun._dataset_sids)

        self._stage({**self.PLAN, "trace_required": True},
                    self._run(trace_summary={"required": True, "ok": 1, "no_trace": 0}, trace_status="ok"),
                    probe=probe)

    def test_switch_on_without_summary_falls_back_to_post_hoc_check(self):
        """第一阶段就被停止 / 熔断的 run（执行侧没走到核对）：环节结束后照批 1 补核对。"""
        _, mark_mock = self._stage({**self.PLAN, "trace_required": True}, self._run(status="stopped"))
        mark_mock.assert_called_once()

    def test_switch_off_passes_none(self):
        """关必须显式 False（2026-09-08 起缺键 = 开）。"""
        exec_mock, mark_mock = self._stage({**self.PLAN, "trace_required": False}, self._run())
        self.assertIsNone(exec_mock.call_args.kwargs.get("trace_mark"))
        mark_mock.assert_not_called()

    def test_missing_switch_defaults_on(self):
        """2026-09-08 用户决定默认开：方案没有 trace_required 键 ⇒ 照开着办，trace_mark 交给执行侧。"""
        self.assertNotIn("trace_required", self.PLAN)
        exec_mock, _ = self._stage(self.PLAN, self._run(trace_summary={"required": True, "ok": 1, "no_trace": 0},
                                                       trace_status="ok"))
        self.assertTrue(callable(exec_mock.call_args.kwargs.get("trace_mark")))


if __name__ == "__main__":
    unittest.main()
