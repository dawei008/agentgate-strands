"""span 去向分两派 ⇒ 读取方必须会回退；采样位必须被读出来。

现网实证（2026-09-07，us-west-2）：
  ⒜ tauairline 系（CodeZip + `opentelemetry-instrument` + aws-opentelemetry-distro
     0.19）走 AgentCore 的「统一 span 目的地」默认：span 落在**自己的 runtime 日志
     组**里的 `@logStream="spans"`（fable5 30 天 528 条 / 52 会话），共享
     `aws/spans` 里 0 条。
  ⒝ dsh 系镜像自带 ADOT collector ⇒ span 进共享 `aws/spans`，自己日志组的 spans
     流为空。
所以「专属日志组永远为空」只对 ⒝ 成立。配了 `aws/spans` 的 agent 一旦是 ⒜（或中途
换过埋点方式），主源读到 0 条与「这个 agent 没开观测」在数据面同形 —— 回退读法就是
把这两件事分开的唯一办法。

另一半是采样：被测 Agent 的 ADOT 默认采样器 `parentbased_always_on` 跟着调用方走，
本服务受账号 X-Ray 默认 5% 规则约束 ⇒ 约 85% 的调用带 sampled=0 的父过去，被测
Agent 丢掉整条 trace（fable5 2026-09-07 当天 25 次调用日志全 `trace_sampled=False`、
零 span；08-16 为 True 时 span 齐全）。infra 那行 `OTEL_TRACES_SAMPLER=always_on`
是修法，`testrun.current_trace_sampled()` 是读数。

夹具是现网原样导出的 runtime 组记录（与 test_tool_evidence 共用同一份 JSON）——
回退读到的就是这个形状，不手抄。
Run: python3 -m pytest tests/test_span_fallback.py -q
"""

import ast
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
sys.path.insert(0, str(APP))

import patches  # noqa: E402

patches.apply()

import agentstatus  # noqa: E402
import discovery  # noqa: E402
import testrun  # noqa: E402
import topology  # noqa: E402
import tracesource  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "agentcore_spans_tau_airline_16.json"
SESSION_ID = "evaltest-202608261402-a21f78ee45d54295909e8c2fd73c45a6"
RUNTIME_GROUP = "/aws/bedrock-agentcore/runtimes/tauairline_agentfable5-EXAMPLE0001-DEFAULT"
CENTRAL = "aws/spans"


def _records() -> list[dict]:
    return json.loads(FIXTURE.read_text())


def _message_rows(records) -> list[list[dict]]:
    """Insights `fields @message` 结果行的形状。"""
    return [[{"field": "@message", "value": json.dumps(r, ensure_ascii=False)}]
            for r in records]


class TestFallbackConfig(unittest.TestCase):
    """`resolve_span_config` 加不加 `fallback_log_group` 的两态，逐个成因钉。"""

    def _cfg(self, agent, src=None):
        with mock.patch.object(tracesource, "resolve_span_source", return_value=src):
            return tracesource.resolve_span_config(agent)

    def test_runtime_group_primary_gets_no_fallback(self):
        """主源已经是专属组 ⇒ 不加回退（否则回退与主源同名，同一批字节查两遍）。"""
        cfg = self._cfg({"agent_name": "fable5", "log_group": RUNTIME_GROUP})
        self.assertEqual(cfg["log_group"], RUNTIME_GROUP)
        self.assertNotIn("fallback_log_group", cfg)

    def test_central_primary_falls_back_to_the_agents_own_group(self):
        cfg = self._cfg({"agent_name": "fable5", "log_group": RUNTIME_GROUP},
                        src={"log_group": CENTRAL, "service_filter": "svc"})
        self.assertEqual(cfg["log_group"], CENTRAL)
        self.assertEqual(cfg["fallback_log_group"], RUNTIME_GROUP)

    def test_fallback_derived_from_runtime_arn_when_no_log_group_known(self):
        """agent 记录里只有 ARN（dataset 路径的 meta 就可能这样）也要推得出来。"""
        cfg = self._cfg({"agent_name": "fable5", "log_group": CENTRAL,
                         "runtime_arn": "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
                                        "runtime/tauairline_agentfable5-EXAMPLE0001"},
                        src={"log_group": CENTRAL})
        self.assertEqual(cfg["fallback_log_group"], RUNTIME_GROUP)

    def test_fallback_derived_from_runtime_id(self):
        cfg = self._cfg({"agent_name": "fable5", "log_group": CENTRAL,
                         "runtime_id": "tauairline_agentfable5-EXAMPLE0001"},
                        src={"log_group": CENTRAL})
        self.assertEqual(cfg["fallback_log_group"], RUNTIME_GROUP)

    def test_explicit_other_log_group_is_left_alone(self):
        """用户显式把 span 源指到别的组 = 他知道 span 在哪。替他猜 runtime 组，
        猜错的方向是**拿另一个组的 span 当这个 agent 的证据**。"""
        cfg = self._cfg({"agent_name": "x", "log_group": RUNTIME_GROUP},
                        src={"log_group": "my/own/spans"})
        self.assertEqual(cfg["log_group"], "my/own/spans")
        self.assertNotIn("fallback_log_group", cfg)

    def test_no_runtime_identity_means_no_fallback_key(self):
        cfg = self._cfg({"agent_name": "x", "log_group": CENTRAL}, src={"log_group": CENTRAL})
        self.assertNotIn("fallback_log_group", cfg)

    def test_field_name_is_exactly_fallback_log_group(self):
        """字段名对外承诺过（另一个批次按这个名字消费）：改名要在这里先红。"""
        cfg = self._cfg({"agent_name": "fable5", "log_group": RUNTIME_GROUP},
                        src={"log_group": CENTRAL})
        self.assertIn("fallback_log_group", cfg)
        self.assertEqual(sorted(cfg), ["fallback_log_group", "log_group",
                                       "scope_filter", "service_filter"])


class TestCfgIsResolvedInOnePlace(unittest.TestCase):
    """观测路径与其余路径必须拿到**同一份** cfg（回退规则只有一处）。

    反面：两处各写一遍回退规则 ⇒ 「哪条路径会回退」漂成两个答案，而症状是
    「列会话看得见的会话，点进去评估说查不到」——两边都不报错。
    """

    AGENT = {"agent_name": "fable5", "log_group": RUNTIME_GROUP,
             "runtime_id": "tauairline_agentfable5-EXAMPLE0001"}
    SRC = {"log_group": CENTRAL, "scope_filter": "", "service_filter": "svc"}

    def test_both_paths_build_the_same_cfg(self):
        with mock.patch.object(tracesource, "resolve_span_source", return_value=self.SRC):
            listing = tracesource.resolve_span_config(self.AGENT)
        observing = tracesource._cfg_with_fallback(
            self.AGENT, tracesource._effective_span_group(self.AGENT, self.SRC), self.SRC)
        self.assertEqual(listing, observing)
        self.assertEqual(listing["fallback_log_group"], RUNTIME_GROUP)

    def test_the_rule_lives_in_exactly_one_function(self):
        """量具自检 + 唯一性：`fallback_log_group` 的**写入**只许出现一次。"""
        tree = ast.parse((APP / "tracesource.py").read_text())
        writers = set()
        for fn in ast.walk(tree):
            if not isinstance(fn, ast.FunctionDef):
                continue
            for node in ast.walk(fn):
                if (isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant)
                        and node.slice.value == "fallback_log_group"
                        and isinstance(node.ctx, ast.Store)):
                    writers.add(fn.name)
        self.assertEqual(writers, {"_cfg_with_fallback"})


class TestReadPlans(unittest.TestCase):
    def test_single_plan_without_fallback(self):
        plans = tracesource.read_plans({"log_group": RUNTIME_GROUP})
        self.assertEqual(len(plans), 1)
        self.assertEqual(plans[0]["span_origin"], tracesource.ORIGIN_RUNTIME_GROUP)
        self.assertEqual(plans[0]["log_stream"], "")

    def test_two_plans_order_and_origins(self):
        plans = tracesource.read_plans({"log_group": CENTRAL, "service_filter": "svc",
                                        "fallback_log_group": RUNTIME_GROUP})
        self.assertEqual([p["log_group"] for p in plans], [CENTRAL, RUNTIME_GROUP])
        self.assertEqual([p["span_origin"] for p in plans],
                         [tracesource.ORIGIN_CENTRAL, tracesource.ORIGIN_RUNTIME_GROUP])

    def test_fallback_pins_the_spans_stream(self):
        """专属组里还有 stdout/stderr/otel-rt-logs 流；不限流名就会把普通日志行
        当 span 数（那些行里也能带 session id）。"""
        plans = tracesource.read_plans({"log_group": CENTRAL,
                                        "fallback_log_group": RUNTIME_GROUP})
        self.assertEqual(plans[1]["log_stream"], tracesource.RUNTIME_SPANS_STREAM)
        self.assertEqual(plans[1]["log_stream"], "spans")

    def test_fallback_drops_the_shared_group_filters(self):
        """反向钉：scope/service 过滤是给共享组挑一个 service 用的。带到专属组上
        会把真数据全滤掉（那里的 service.name 是 `<agent>.DEFAULT`，不是配置里
        那个），结果与「专属组也是空的」同形。"""
        plans = tracesource.read_plans({"log_group": CENTRAL, "scope_filter": "scopeX",
                                        "service_filter": "deepseek-harness",
                                        "fallback_log_group": RUNTIME_GROUP})
        self.assertEqual(plans[1]["scope_filter"], "")
        self.assertEqual(plans[1]["service_filter"], "")
        # 主源那份必须原样保留
        self.assertEqual(plans[0]["service_filter"], "deepseek-harness")


class TestFetchFallback(unittest.TestCase):
    CFG = {"log_group": CENTRAL, "scope_filter": "", "service_filter": "svc",
           "fallback_log_group": RUNTIME_GROUP}

    def _insights(self, by_group: dict):
        """按日志组分发结果的 Insights 替身；记录每次 (log_group, query)。"""
        calls = []

        def fake(log_group, query, lookback_days):
            calls.append({"log_group": log_group, "query": query})
            return by_group.get(log_group, [])

        patcher = mock.patch.object(tracesource, "_run_insights_query", fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        return calls

    def test_primary_empty_then_fallback_hits(self):
        calls = self._insights({RUNTIME_GROUP: _message_rows(_records())})
        session, spans, origin = tracesource.fetch_session_with_origin(
            self.CFG, SESSION_ID, 30)
        self.assertEqual(origin, tracesource.ORIGIN_RUNTIME_GROUP)
        self.assertEqual(len(spans), len(_records()))
        self.assertTrue(session.traces)
        self.assertEqual([c["log_group"] for c in calls], [CENTRAL, RUNTIME_GROUP])
        # 回退那一次必须限流名，且不带主源的 service 过滤
        self.assertIn('@logStream = "spans"', calls[1]["query"])
        self.assertNotIn("svc", calls[1]["query"])
        self.assertIn("svc", calls[0]["query"])
        self.assertNotIn("@logStream", calls[0]["query"])

    def test_primary_hit_never_reads_the_fallback(self):
        """性能判据：主源查到就不查回退（别每次双查）。"""
        calls = self._insights({CENTRAL: _message_rows(_records())})
        _session, _spans, origin = tracesource.fetch_session_with_origin(
            self.CFG, SESSION_ID, 30)
        self.assertEqual(origin, tracesource.ORIGIN_CENTRAL)
        self.assertEqual([c["log_group"] for c in calls], [CENTRAL])

    def test_both_empty_raises_and_names_both_groups(self):
        from strands_evals.providers.exceptions import SessionNotFoundError

        self._insights({})
        with self.assertRaises(SessionNotFoundError) as ctx:
            tracesource.fetch_session_with_origin(self.CFG, SESSION_ID, 30)
        self.assertIn(CENTRAL, str(ctx.exception))
        self.assertIn(RUNTIME_GROUP, str(ctx.exception))

    def test_two_tuple_facade_matches(self):
        self._insights({RUNTIME_GROUP: _message_rows(_records())})
        session, spans = tracesource.fetch_session(self.CFG, SESSION_ID, 30)
        self.assertTrue(session.traces)
        self.assertEqual(len(spans), len(_records()))

    def test_low_latency_fallback_reads_only_the_spans_stream(self):
        """低延迟读法（dataset 路径的 14 秒预算）在回退这一步照样能限流名 ——
        `filter_log_events` 支持 `logStreamNames`，不必退回 Insights。"""
        calls = []

        class _FakeLogs:
            def filter_log_events(self, **kw):
                calls.append(kw)
                return {"events": [{"message": json.dumps(r, ensure_ascii=False)}
                                   for r in _records()]}

        original = discovery._logs_client
        discovery._logs_client = lambda: _FakeLogs()
        self.addCleanup(lambda: setattr(discovery, "_logs_client", original))
        # 主源带 service 过滤 ⇒ 主源仍走 Insights（本地过滤不了共享组），返回空
        self._insights({})
        _session, _spans, origin = tracesource.fetch_session_with_origin(
            self.CFG, SESSION_ID, 1, True)
        self.assertEqual(origin, tracesource.ORIGIN_RUNTIME_GROUP)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["logStreamNames"], ["spans"])
        self.assertEqual(calls[0]["logGroupName"], RUNTIME_GROUP)

    def test_no_fallback_config_reads_once_and_says_central(self):
        calls = self._insights({CENTRAL: _message_rows(_records())})
        _s, _sp, origin = tracesource.fetch_session_with_origin(
            {"log_group": CENTRAL, "service_filter": "svc"}, SESSION_ID, 30)
        self.assertEqual(origin, tracesource.ORIGIN_CENTRAL)
        self.assertEqual(len(calls), 1)


def _sess(sid, ts, n=1):
    return {"session_id": sid, "last_ts": ts, "span_count": n}


class TestSessionMerge(unittest.TestCase):
    def test_dedupe_keeps_the_primary_row(self):
        primary = [dict(_sess("s1", 300), span_origin="central")]
        fallback = [dict(_sess("s1", 100, 9), span_origin="runtime_group"),
                    dict(_sess("s2", 200), span_origin="runtime_group")]
        out = tracesource.merge_sessions(primary, fallback, 10)
        self.assertEqual([s["session_id"] for s in out], ["s1", "s2"])
        self.assertEqual(out[0]["span_origin"], "central")
        self.assertEqual(out[0]["span_count"], 1)

    def test_sorted_newest_first_and_capped(self):
        out = tracesource.merge_sessions([_sess("a", 100)],
                                         [_sess("b", 900), _sess("c", 500)], 2)
        self.assertEqual([s["session_id"] for s in out], ["b", "c"])

    def test_rows_without_session_id_are_dropped(self):
        out = tracesource.merge_sessions([{"last_ts": 5}], [_sess("a", 1)], 10)
        self.assertEqual([s["session_id"] for s in out], ["a"])


class TestListSessionsFallback(unittest.TestCase):
    CFG = {"log_group": CENTRAL, "scope_filter": "", "service_filter": "svc",
           "fallback_log_group": RUNTIME_GROUP}

    def _lrs(self, by_group: dict, error_groups=()):
        calls = []

        def fake(log_group, lookback_days, max_sessions, include_test=False,
                 scope_filter="", service_filter="", log_stream=""):
            calls.append({"log_group": log_group, "log_stream": log_stream,
                          "service_filter": service_filter})
            if log_group in error_groups:
                raise RuntimeError("Logs Insights query Failed")
            return [dict(s) for s in by_group.get(log_group, [])]

        patcher = mock.patch.object(tracesource, "list_recent_sessions", fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        return calls

    def test_primary_sessions_are_tagged_central_and_cost_one_query(self):
        calls = self._lrs({CENTRAL: [_sess("s1", 500)]})
        out = tracesource.list_sessions_from_cfg(self.CFG, 30, 10)
        self.assertEqual([s["span_origin"] for s in out], ["central"])
        self.assertEqual([c["log_group"] for c in calls], [CENTRAL])

    def test_empty_primary_falls_back_and_tags_runtime_group(self):
        calls = self._lrs({RUNTIME_GROUP: [_sess("s1", 500), _sess("s2", 400)]})
        out = tracesource.list_sessions_from_cfg(self.CFG, 30, 10)
        self.assertEqual([s["session_id"] for s in out], ["s1", "s2"])
        self.assertEqual({s["span_origin"] for s in out}, {"runtime_group"})
        self.assertEqual([c["log_group"] for c in calls], [CENTRAL, RUNTIME_GROUP])
        self.assertEqual(calls[1]["log_stream"], "spans")
        self.assertEqual(calls[1]["service_filter"], "")

    def test_fallback_query_failure_degrades_to_the_primary_reading(self):
        """回退是补救。补救查不动（组不存在/权限/超时）不许把「没有会话」变成 500。"""
        self._lrs({}, error_groups=(RUNTIME_GROUP,))
        self.assertEqual(tracesource.list_sessions_from_cfg(self.CFG, 30, 10), [])

    def test_no_span_source_at_all_lists_nothing(self):
        with mock.patch.object(tracesource, "resolve_span_source", return_value=None):
            self.assertEqual(
                tracesource.list_sessions({"agent_name": "x", "log_group": ""}, 30, 10), [])


NOW_ROWS = [[{"field": "sid", "value": "s1"},
             {"field": "tid", "value": "t1"},
             {"field": "name", "value": "invoke_agent Strands Agents"},
             {"field": "t0", "value": "1000000000000000000"},
             {"field": "t1", "value": "1000000001000000000"}]]


class TestStatusRowsFallback(unittest.TestCase):
    """五个数 / 拓扑共用的取数：主源空才查回退，并如实报 span_origin。"""

    CFG = {"log_group": CENTRAL, "scope_filter": "", "service_filter": "svc",
           "fallback_log_group": RUNTIME_GROUP}

    def _insights(self, by_group):
        calls = []

        def fake(log_group, query, lookback_days):
            calls.append({"log_group": log_group, "query": query})
            return by_group.get(log_group, [])

        patcher = mock.patch.object(agentstatus, "_run_insights_query", fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        return calls

    def test_primary_hit_reads_once(self):
        calls = self._insights({CENTRAL: NOW_ROWS})
        rows, origin = agentstatus.query_status_rows(self.CFG, 2)
        self.assertEqual(len(rows), 1)
        self.assertEqual(origin, "central")
        self.assertEqual([c["log_group"] for c in calls], [CENTRAL])

    def test_fallback_hit_reports_runtime_group_and_pins_the_stream(self):
        calls = self._insights({RUNTIME_GROUP: NOW_ROWS})
        rows, origin = agentstatus.query_status_rows(self.CFG, 2)
        self.assertEqual(len(rows), 1)
        self.assertEqual(origin, "runtime_group")
        self.assertIn('@logStream = "spans"', calls[1]["query"])
        self.assertNotIn("svc", calls[1]["query"])

    def test_both_empty_reports_the_last_group_tried(self):
        self._insights({})
        rows, origin = agentstatus.query_status_rows(self.CFG, 2)
        self.assertEqual(rows, [])
        self.assertEqual(origin, "runtime_group")

    def test_include_test_reaches_both_reads(self):
        calls = self._insights({})
        agentstatus.query_status_rows(self.CFG, 2, include_test=True)
        for c in calls:
            self.assertNotIn("evaltest", c["query"])


class TestSpanOriginInPayloads(unittest.TestCase):
    """span_origin 要能被上层读到：agent_status 与 agent_topology 两处。"""

    AGENT = {"agent_name": "fable5", "log_group": RUNTIME_GROUP,
             "runtime_arn": "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
                            "runtime/tauairline_agentfable5-EXAMPLE0001"}
    CFG = {"log_group": CENTRAL, "scope_filter": "", "service_filter": "svc",
           "fallback_log_group": RUNTIME_GROUP}

    def _insights(self, by_group):
        def fake(log_group, query, lookback_days):
            return by_group.get(log_group, [])

        patcher = mock.patch.object(agentstatus, "_run_insights_query", fake)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _rows_now(self, now):
        t0 = int((now.timestamp() - 60) * 1_000_000_000)
        return [[{"field": "sid", "value": "s1"}, {"field": "tid", "value": "t1"},
                 {"field": "name", "value": "invoke_agent Strands Agents"},
                 {"field": "t0", "value": str(t0)},
                 {"field": "t1", "value": str(t0 + 1_000_000_000)}]]

    def test_metrics_carry_the_origin_and_the_deep_link_points_at_it(self):
        from datetime import datetime, timezone

        now = datetime(2026, 9, 7, 12, 0, tzinfo=timezone.utc)
        self._insights({RUNTIME_GROUP: self._rows_now(now)})
        with mock.patch.object(agentstatus.pricing, "get_prices",
                               return_value={"prices": {}}):
            obs = agentstatus.compute_metrics(self.AGENT, self.CFG, 24, now)
        self.assertEqual(obs["span_origin"], "runtime_group")
        # 深链必须指向**真读到数的那个组**：给 aws/spans 的链接会打开一个空查询
        self.assertIn("runtimes", agentstatus.log_group_url(RUNTIME_GROUP))

    def test_null_metrics_origin_is_none_not_a_group_name(self):
        obs = agentstatus.compute_metrics(self.AGENT, None, 24,
                                         agentstatus._now())
        self.assertIsNone(obs["span_origin"])

    def test_topology_payload_carries_the_origin(self):
        from datetime import datetime, timezone

        now = datetime(2026, 9, 7, 12, 0, tzinfo=timezone.utc)
        self._insights({RUNTIME_GROUP: self._rows_now(now)})
        with mock.patch.object(agentstatus, "_now", return_value=now), \
             mock.patch.object(agentstatus.tracesource, "resolve_span_config",
                               return_value=self.CFG):
            out = topology._compute(self.AGENT, 7, True)
        self.assertEqual(out["span_origin"], "runtime_group")

    def test_topology_unavailable_still_has_the_key(self):
        with mock.patch.object(agentstatus.tracesource, "resolve_span_config",
                               return_value=None):
            out = topology._compute(self.AGENT, 7, None)
        self.assertIsNone(out["span_origin"])


class TestSampledReading(unittest.TestCase):
    """`trace.sampled` 的两态 + 缺测态。用真的 SpanContext，不糊 mock 的返回值。"""

    def _in_span(self, sampled: bool):
        from opentelemetry import context as otel_context
        from opentelemetry import trace as otel_trace

        ctx = otel_trace.SpanContext(
            trace_id=0x000102030405060708090A0B0C0D0E0F,
            span_id=0x0001020304050607,
            is_remote=False,
            trace_flags=otel_trace.TraceFlags(
                otel_trace.TraceFlags.SAMPLED if sampled else otel_trace.TraceFlags.DEFAULT),
        )
        token = otel_context.attach(
            otel_trace.set_span_in_context(otel_trace.NonRecordingSpan(ctx)))
        self.addCleanup(lambda: otel_context.detach(token))

    def test_sampled_true(self):
        self._in_span(True)
        self.assertIs(testrun.current_trace_sampled(), True)

    def test_sampled_false(self):
        self._in_span(False)
        self.assertIs(testrun.current_trace_sampled(), False)

    def test_no_active_span_reads_none_not_false(self):
        """None ≠ False：读不出采样位时说「未采样」就是拿缺测当阴性。"""
        self.assertIsNone(testrun.current_trace_sampled())

    def test_the_case_entry_gets_the_reading(self):
        """判据下在**写入点**上：run_one 里必须有 entry["trace"] = {"sampled": …}，
        且它的值来自 current_trace_sampled()。

        为什么按 AST 不按跑一遍 run_dataset：那条路径要真 agent + 真 judge。
        """
        tree = ast.parse((APP / "testrun.py").read_text())
        fn = next(n for n in ast.walk(tree)
                  if isinstance(n, ast.AsyncFunctionDef) and n.name == "run_one")
        called = [n for n in ast.walk(fn) if isinstance(n, ast.Call)
                  and isinstance(n.func, ast.Name) and n.func.id == "current_trace_sampled"]
        self.assertEqual(len(called), 1, "采样位必须在 run_one 里读一次")
        writes = [n for n in ast.walk(fn) if isinstance(n, ast.Assign)
                  and any(isinstance(t, ast.Subscript)
                          and isinstance(t.slice, ast.Constant) and t.slice.value == "trace"
                          for t in n.targets)]
        self.assertEqual(len(writes), 1, 'entry["trace"] 必须被赋值一次')
        self.assertIn("sampled", ast.dump(writes[0].value))

    def test_baggage_传法一个字节不改(self):
        """反向钉：采样位是**读**出来的，不许顺手改 baggage 的传法。

        `invoke_agent_runtime` 一旦带 `baggage=` 参数：它是被建模的头 ⇒ SigV4 会签它，
        instrumentation 再在签名后覆盖 ⇒ AccessDeniedException；而在 OTel context 里
        设 baggage 才是对的（见 tracesource / _target_session_baggage 的注释）。
        """
        src = (APP / "testrun.py").read_text()
        tree = ast.parse(src)
        fn = next(n for n in ast.walk(tree)
                  if isinstance(n, ast.FunctionDef) and n.name == "invoke_agent_raw")
        call = next(n for n in ast.walk(fn) if isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Attribute)
                    and n.func.attr == "invoke_agent_runtime")
        self.assertNotIn("baggage", [kw.arg for kw in call.keywords])
        self.assertIn("_target_session_baggage", ast.dump(fn))


class TestSamplerIsPinnedInInfra(unittest.TestCase):
    """`OTEL_TRACES_SAMPLER=always_on` 必须在运行时的 env 块里。

    被测 Agent 的 parentbased 采样器跟着我们走 ⇒ 少了这一行，评估调用有约 85%
    在被测侧被整条丢掉，而「Agent 没上报 span」与「这次没被采样」在读取侧同形。
    """

    STACK = ROOT / "infra/stacks/eval_runtime_stack.py"

    def _env_dict(self):
        tree = ast.parse(self.STACK.read_text())
        for node in ast.walk(tree):
            if (isinstance(node, ast.keyword) and node.arg == "environment_variables"
                    and isinstance(node.value, ast.Dict)):
                return {k.value: v for k, v in zip(node.value.keys, node.value.values)
                        if isinstance(k, ast.Constant)}
        self.fail("CfnRuntime 的 environment_variables 没找到 —— 量具坏了，不是没配")

    def test_sampler_env_is_always_on(self):
        env = self._env_dict()
        self.assertIn("OTEL_TRACES_SAMPLER", env)
        self.assertEqual(env["OTEL_TRACES_SAMPLER"].value, "always_on")

    def test_the_scanner_sees_the_known_neighbours(self):
        """量具自检：同一个 env 块里已知为真的键必须被抓到（抓不到就是解析坏了，
        而「一个键都没抓到」与「这一行没配」在断言里同形）。"""
        env = self._env_dict()
        self.assertIn("RUNTIME_NAME", env)
        self.assertIn("CATALOG_TABLE", env)


if __name__ == "__main__":
    unittest.main()
