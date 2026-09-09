"""Stub tests for the centralized aws/spans trace-source support.

Covers the three pieces the feature adds (no AWS calls — Logs Insights is
mocked): query/filter assembly, list_sessions routing branches, and the
zero-session fallback probe hint.

Run: python3 -m pytest tests/test_span_source.py -q
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import discovery
import tracesource


class TestFilterAssembly(unittest.TestCase):
    def test_no_filters_yields_empty(self):
        self.assertEqual(discovery.build_span_filters(), "")

    def test_service_filter_clause(self):
        q = discovery.build_span_filters(service_filter="deepseek-harness")
        self.assertEqual(
            q, ' | filter resource.attributes.service.name = "deepseek-harness"')

    def test_scope_filter_clause(self):
        q = discovery.build_span_filters(scope_filter="opentelemetry.instrumentation.x")
        self.assertEqual(q, ' | filter scope.name = "opentelemetry.instrumentation.x"')

    def test_both_filters_service_first(self):
        q = discovery.build_span_filters("scopeA", "svcB")
        self.assertLess(q.index("service.name"), q.index("scope.name"))

    def test_quote_injection_escaped(self):
        q = discovery.build_span_filters(service_filter='x" or 1=1 | fields "y')
        # the quote must arrive escaped, not close the literal
        self.assertIn('\\"', q)
        self.assertNotIn(' = "x" or', q)

    def test_session_query_includes_filters_and_test_exclusion(self):
        q = discovery.build_session_query(7, include_test=False,
                                          scope_filter="s", service_filter="v")
        self.assertIn("not like 'evaltest'", q)
        self.assertIn('service.name = "v"', q)
        self.assertIn('scope.name = "s"', q)
        self.assertIn("limit 7", q)

    def test_session_query_include_test_drops_exclusion(self):
        q = discovery.build_session_query(5, include_test=True)
        self.assertNotIn("evaltest", q)


class TestListSessionsRouting(unittest.TestCase):
    AGENT = {"agent_name": "demo", "source": "agentcore",
             "log_group": "/aws/bedrock-agentcore/runtimes/demo-XYZ-DEFAULT"}

    def test_no_override_queries_runtime_group(self):
        with mock.patch.object(tracesource, "resolve_span_source", return_value=None), \
             mock.patch.object(tracesource, "list_recent_sessions",
                               return_value=[]) as lrs:
            tracesource.list_sessions(self.AGENT, 30, 10)
        # 无 override ⇒ 主源就是专属组：不带 scope/service 过滤，也不限流名
        # （那条组里 span 与 stdout 混着，但没有 override 的读法从来就是全组读，
        # 这次改动不许悄悄改它的窗口）。
        lrs.assert_called_once_with(self.AGENT["log_group"], 30, 10, False,
                                    scope_filter="", service_filter="", log_stream="")

    def test_override_routes_to_span_group_with_filters(self):
        agent = {**self.AGENT,
                 "span_source": {"log_group": "aws/spans",
                                 "scope_filter": "scopeX",
                                 "service_filter": "svcY"}}
        with mock.patch.object(tracesource, "list_recent_sessions",
                               return_value=[]) as lrs:
            tracesource.list_sessions(agent, 14, 5, include_test=True)
        # 主源这一次的入参逐格钉。**不是** assert_called_once：这里的替身返回空表，
        # 而空表正是回退的触发条件 ⇒ 第二次调用（专属组 spans 流）是预期行为，
        # 由 TestRuntimeGroupFallback 单独钉。
        self.assertEqual(lrs.call_args_list[0],
                         mock.call("aws/spans", 14, 5, True, scope_filter="scopeX",
                                   service_filter="svcY", log_stream=""))

    def test_override_without_log_group_keeps_runtime_group(self):
        # filters-only config: narrow the runtime group itself
        agent = {**self.AGENT, "span_source": {"service_filter": "svcY"}}
        with mock.patch.object(tracesource, "list_recent_sessions",
                               return_value=[]) as lrs:
            tracesource.list_sessions(agent, 30, 10)
        self.assertEqual(lrs.call_args.args[0], self.AGENT["log_group"])
        self.assertEqual(lrs.call_args.kwargs["service_filter"], "svcY")

    def test_filters_only_without_runtime_group_is_actionable_error(self):
        agent = {"agent_name": "demo", "source": "agentcore", "log_group": None,
                 "span_source": {"service_filter": "svcY"}}
        with self.assertRaises(ValueError) as ctx:
            tracesource.list_sessions(agent, 30, 10)
        self.assertIn("log_group", str(ctx.exception))

    def test_resolve_prefers_in_memory_over_catalog(self):
        agent = {**self.AGENT, "span_source": {"log_group": "aws/spans"}}
        import catalog
        with mock.patch.object(catalog, "get_span_source") as gss:
            src = tracesource.resolve_span_source(agent)
        gss.assert_not_called()
        self.assertEqual(src["log_group"], "aws/spans")

    def test_resolve_empty_config_means_none(self):
        import catalog
        with mock.patch.object(catalog, "get_span_source", return_value=None):
            self.assertIsNone(tracesource.resolve_span_source(dict(self.AGENT)))
        with mock.patch.object(catalog, "get_span_source",
                               return_value={"log_group": "", "scope_filter": "",
                                             "service_filter": ""}):
            self.assertIsNone(tracesource.resolve_span_source(dict(self.AGENT)))


def _rows(*services):
    """Fake Logs Insights stats rows: (service, span_count, last_ts)."""
    return [
        [{"field": "service", "value": s},
         {"field": "span_count", "value": str(n)},
         {"field": "last_ts", "value": str(ts)}]
        for s, n, ts in services
    ]


class TestFallbackProbe(unittest.TestCase):
    AGENT = {"agent_name": "dshAgentCoreEval", "source": "agentcore",
             "log_group": "/aws/bedrock-agentcore/runtimes/dsh-X-DEFAULT"}

    def test_hint_lists_candidates_and_flags_name_match(self):
        rows = _rows(("deepseek-harness", 28, 200), ("dshagentcoreeval-svc", 3, 100))
        with mock.patch.object(tracesource, "_run_insights_query", return_value=rows):
            hint = tracesource.probe_central_spans(self.AGENT, 30)
        self.assertEqual(hint["kind"], "central_spans")
        self.assertEqual(hint["log_group"], "aws/spans")
        self.assertTrue(hint["matched"])
        # matched candidate sorts first even though it is older
        self.assertEqual(hint["candidates"][0]["service"], "dshagentcoreeval-svc")
        self.assertTrue(hint["candidates"][0]["name_match"])
        self.assertFalse(hint["candidates"][1]["name_match"])
        self.assertIn("aws/spans", hint["message"])

    def test_no_match_still_returns_hint(self):
        rows = _rows(("deepseek-harness", 28, 200))
        with mock.patch.object(tracesource, "_run_insights_query", return_value=rows):
            hint = tracesource.probe_central_spans(self.AGENT, 30)
        self.assertFalse(hint["matched"])
        self.assertEqual(len(hint["candidates"]), 1)

    def test_empty_group_returns_none(self):
        with mock.patch.object(tracesource, "_run_insights_query", return_value=[]):
            self.assertIsNone(tracesource.probe_central_spans(self.AGENT, 30))

    def test_probe_never_raises(self):
        with mock.patch.object(tracesource, "_run_insights_query",
                               side_effect=RuntimeError("group missing")):
            self.assertIsNone(tracesource.probe_central_spans(self.AGENT, 30))


class TestCentralSpanAdaptation(unittest.TestCase):
    def _span(self, **attrs):
        return {"attributes": attrs}

    def test_session_id_promoted_over_conversation_id(self):
        span = self._span(**{"session.id": "dsh-web-1",
                             "gen_ai.conversation.id": "session-internal-uuid"})
        tracesource._adapt_central_span(span)
        self.assertEqual(span["attributes"]["gen_ai.conversation.id"], "dsh-web-1")

    def test_invoke_agent_task_io_becomes_messages(self):
        span = self._span(**{"gen_ai.operation.name": "invoke_agent",
                             "gen_ai.task.input": "你好",
                             "gen_ai.task.output": "答复"})
        tracesource._adapt_central_span(span)
        attrs = span["attributes"]
        self.assertIn('"你好"', attrs["gen_ai.input.messages"])
        self.assertIn('"答复"', attrs["gen_ai.output.messages"])

    def test_existing_messages_not_overwritten(self):
        span = self._span(**{"gen_ai.operation.name": "invoke_agent",
                             "gen_ai.task.input": "x",
                             "gen_ai.input.messages": "[]"})
        tracesource._adapt_central_span(span)
        self.assertEqual(span["attributes"]["gen_ai.input.messages"], "[]")

    def test_system_instructions_flattened(self):
        span = self._span(**{"gen_ai.system_instructions":
                             '[{"type":"text","content":"You are helpful."}]'})
        tracesource._adapt_central_span(span)
        self.assertEqual(span["attributes"]["system_prompt"], "You are helpful.")

    def test_non_dict_attributes_tolerated(self):
        tracesource._adapt_central_span({"attributes": None})  # must not raise


if __name__ == "__main__":
    unittest.main()
