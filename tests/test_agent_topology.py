"""`agent_topology` —— ADR-0017 D4「路径」卡的数据源（只读 action）。

钉九件事：
  1. 节点口径：start 每会话一次；agent = assistant 回合；tool:<name> 带 errors / 时延；
     model:<id> 只在 chat 段带 gen_ai.request.model 时出现；
  2. 边 = 会话内按时间顺序相邻两节点，同一会话同一条边走几次算几次；
  3. top_path = 各会话完整节点序列里出现最多的一条，share = 该路径会话数 / 会话数；
  4. slowest = avg_s 最大的非 start 节点；时延两位小数、p95 nearest-rank；
  5. 模型短名 = 去掉 `<region>.<vendor>.` 前缀、`-vN:0` 后缀与 `-YYYYMMDD` 日期段；
  6. 同源：sessions 与 agentstatus 同一条 build_status_query（只多 include_test=True，那条
     evaltest 过滤挪到 Python 侧按前缀分流）、同一 _run_insights_query、同一 _rows_to_spans；
     nodes[start].count == sessions，live_sessions == agentstatus 会话口径；
  7. 不可用：无 span 源 / 窗内 0 span / 窗内 0 会话 / 查询失败 / 截断 各一句原因，nodes、edges 为 []；
  8. 缓存：5 分钟进程内，键 (agent_name, lookback_days, include_eval)，refresh 绕过；
  9. **不写库**：走 main.invoke 全程，DDB 写方法与 S3 put 一次都不许被调；
 10. 评估流量三档（include_eval None / True / False）：自动态真实优先、真实为零退到评估、
     两者皆无 ⇒ 「未上报任何 span」；一次查询在 Python 侧分流，不查两次；
     build_status_query 默认文本逐字不变（拿旧字符串钉）。
 11. 会话级（批 topology-sessions）：每节点 recent_sessions（按该节点在会话里首见时刻倒序 ≤ 10，
     duration_s = 该节点在该会话的总耗时，failed = 该节点在该会话里报过错）；顶层 session_paths
     （每会话一条完整路径，按会话开始倒序 ≤ 10）；top_path.count == 走同一条 path 的
     session_paths 条数；裸事件列表（无会话 id）两者皆空。

Run: python3 -m pytest tests/test_agent_topology.py -q
"""

import asyncio
import sys
import unittest
from datetime import timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import agentstatus  # noqa: E402
import topology  # noqa: E402
from test_agent_status import AGENT, CFG, NOW, PRICES, invoke_agent_row, row, tool_row  # noqa: E402

SONNET = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"


# ---------- 合成会话（transcript 形状的事件） ----------

def tool(name, duration_s, error=None):
    return {"type": "tool", "name": name, "duration_s": duration_s, "error": error}


def assistant(duration_s=None, error=None):
    return {"type": "assistant", "duration_s": duration_s, "error": error}


def model(model_id, duration_s, error=None):
    return {"type": "model", "model": model_id, "duration_s": duration_s, "error": error}


def user():
    return {"type": "user", "text": "hi"}


# 四个会话：
#   s1  start → agent → tool:bash → tool:bash
#   s2  start → agent → tool:bash(错) → tool:search
#   s3  start → agent
#   s4  start → agent
SESSIONS = [
    [user(), assistant(4.0), tool("bash", 0.03), tool("bash", 0.05)],
    [user(), assistant(6.0), tool("bash", 0.01, error="exit 1"), tool("search", 1.2)],
    [user(), assistant(2.0)],
    [user(), assistant(3.0)],
]


def by_id(nodes):
    return {n["id"]: n for n in nodes}


class Aggregate(unittest.TestCase):
    def setUp(self):
        self.out = topology.aggregate(SESSIONS)

    def test_start_count_equals_sessions(self):
        nodes = by_id(self.out["nodes"])
        self.assertEqual(self.out["sessions"], 4)
        self.assertEqual(nodes["start"]["count"], 4)
        self.assertEqual(nodes["start"]["kind"], "start")
        self.assertEqual(nodes["start"]["label"], "start")
        self.assertEqual((nodes["start"]["avg_s"], nodes["start"]["p95_s"], nodes["start"]["errors"]),
                         (None, None, 0))

    def test_node_counts_latency_and_errors(self):
        nodes = by_id(self.out["nodes"])
        self.assertEqual(set(nodes), {"start", "agent", "tool:bash", "tool:search"})
        agent = nodes["agent"]
        self.assertEqual((agent["kind"], agent["label"], agent["count"], agent["errors"]),
                         ("agent", "agent", 4, 0))
        self.assertEqual(agent["avg_s"], 3.75)          # (4+6+2+3)/4
        self.assertEqual(agent["p95_s"], 6.0)           # nearest-rank：ceil(0.95*4)=4 ⇒ 第 4 小
        bash = nodes["tool:bash"]
        self.assertEqual((bash["kind"], bash["label"], bash["count"], bash["errors"]),
                         ("tool", "bash", 3, 1))
        self.assertEqual(bash["avg_s"], 0.03)           # (0.03+0.05+0.01)/3 = 0.03
        self.assertEqual(bash["p95_s"], 0.05)
        search = nodes["tool:search"]
        self.assertEqual((search["count"], search["errors"], search["avg_s"], search["p95_s"]),
                         (1, 0, 1.2, 1.2))

    def test_edges_are_time_adjacent_and_multiplied_within_session(self):
        edges = {(e["from"], e["to"]): e["count"] for e in self.out["edges"]}
        self.assertEqual(edges, {
            ("start", "agent"): 4,
            ("agent", "tool:bash"): 2,
            ("tool:bash", "tool:bash"): 1,      # s1 连调两次 bash
            ("tool:bash", "tool:search"): 1,
        })

    def test_top_path_and_share(self):
        self.assertEqual(self.out["top_path"],
                         {"nodes": ["start", "agent"], "count": 2, "share": 0.5})

    def test_slowest_is_max_avg_excluding_start(self):
        self.assertEqual(self.out["slowest"], {"id": "agent", "avg_s": 3.75})

    def test_latency_rounds_to_two_decimals(self):
        out = topology.aggregate([[assistant(1.234567), tool("x", 0.006)],
                                  [assistant(1.0), tool("x", 0.016)]])
        nodes = by_id(out["nodes"])
        self.assertEqual(nodes["agent"]["avg_s"], 1.12)
        self.assertEqual(nodes["tool:x"]["avg_s"], 0.01)
        self.assertEqual(nodes["tool:x"]["p95_s"], 0.02)

    def test_missing_duration_gives_null_latency_and_null_slowest(self):
        out = topology.aggregate([[assistant(), tool("x", None)]])
        nodes = by_id(out["nodes"])
        self.assertIsNone(nodes["agent"]["avg_s"])
        self.assertIsNone(nodes["tool:x"]["p95_s"])
        self.assertIsNone(out["slowest"])

    def test_model_node_from_model_events_with_short_label(self):
        out = topology.aggregate([
            [assistant(5.0), model(SONNET, 3.9), tool("bash", 0.1), model(SONNET, 0.5)],
            [assistant(2.0), model(SONNET, 1.9)],
        ])
        nodes = by_id(out["nodes"])
        m = nodes[f"model:{SONNET}"]
        self.assertEqual((m["kind"], m["label"], m["count"], m["errors"]),
                         ("model", "claude-sonnet-4-5", 3, 0))
        self.assertEqual(m["avg_s"], 2.1)               # (3.9+0.5+1.9)/3
        edges = {(e["from"], e["to"]): e["count"] for e in out["edges"]}
        self.assertEqual(edges[("agent", f"model:{SONNET}")], 2)
        self.assertEqual(edges[(f"model:{SONNET}", "tool:bash")], 1)
        self.assertEqual(edges[("tool:bash", f"model:{SONNET}")], 1)

    def test_zero_sessions(self):
        out = topology.aggregate([])
        self.assertEqual((out["sessions"], out["nodes"], out["edges"], out["top_path"],
                          out["slowest"]), (0, [], [], None, None))

    def test_top_path_tie_breaks_by_first_seen(self):
        out = topology.aggregate([[assistant(1.0), tool("a", 0.1)], [assistant(1.0)],
                                  [assistant(1.0), tool("a", 0.1)], [assistant(1.0)]])
        self.assertEqual(out["top_path"]["nodes"], ["start", "agent", "tool:a"])
        self.assertEqual(out["top_path"]["share"], 0.5)


class ModelShortName(unittest.TestCase):
    def test_rules(self):
        cases = {
            SONNET: "claude-sonnet-4-5",
            "anthropic.claude-3-5-sonnet-20241022-v2:0": "claude-3-5-sonnet",
            "eu.amazon.nova-pro-v1:0": "nova-pro",
            "meta.llama3-1-70b-instruct-v1:0": "llama3-1-70b-instruct",
            "deepseek.r1-v1:0": "r1",
            "deepseek-chat": "deepseek-chat",
            "gpt-4.1": "gpt-4.1",
            "kimi-k2-0905-preview": "kimi-k2-0905-preview",
        }
        for raw, short in cases.items():
            self.assertEqual(topology.model_short_name(raw), short, raw)


# ---------- span → 会话事件（agent_status 同一条查询的行） ----------

def chat_row(sid, start, dur_s, model_id=SONNET, status_code="OK"):
    return row(sid, f"trace-{sid}", "chat", start, dur_s,
               scope_name="strands.telemetry.tracer", model=model_id, status_code=status_code)


def days_ago(d, hours=0):
    return NOW - timedelta(days=d, hours=hours)


class SpanAdapter(unittest.TestCase):
    def test_spans_become_ordered_session_events(self):
        spans = agentstatus._rows_to_spans([
            tool_row("s1", days_ago(1, 1) + timedelta(seconds=1)),
            invoke_agent_row("s1", days_ago(1, 1), 4.0),
            chat_row("s1", days_ago(1, 1) + timedelta(seconds=0.5), 0.4),
            tool_row("s1", days_ago(1, 1) + timedelta(seconds=2), status_code="ERROR",
                     tool_status="error"),
            invoke_agent_row("s0", days_ago(2), 1.0),       # 更早的会话排前
        ])
        sessions = topology.sessions_from_spans(spans)
        self.assertEqual([[e["type"] for e in s] for s in sessions],
                         [["assistant"], ["assistant", "model", "tool", "tool"]])
        s1 = sessions[1]
        self.assertEqual(s1[0]["duration_s"], 4.0)
        self.assertEqual((s1[1]["model"], s1[1]["duration_s"]), (SONNET, 0.4))
        self.assertEqual((s1[2]["name"], s1[2]["duration_s"], s1[2]["error"]),
                         ("lookup", 0.2, None))
        self.assertTrue(s1[3]["error"])

    def test_model_only_from_chat_spans(self):
        # invoke_agent 聚合 span 也带 gen_ai.request.model，但不出模型节点（避免叠层）
        spans = agentstatus._rows_to_spans([invoke_agent_row("s1", days_ago(1), 2.0)])
        out = topology.aggregate(topology.sessions_from_spans(spans))
        self.assertEqual({n["kind"] for n in out["nodes"]}, {"start", "agent"})

    def test_agent_error_from_status_code(self):
        spans = agentstatus._rows_to_spans([
            row("s1", "t1", "invoke_agent Strands Agents", days_ago(1), 1.0, status_code="ERROR")])
        out = topology.aggregate(topology.sessions_from_spans(spans))
        self.assertEqual(by_id(out["nodes"])["agent"]["errors"], 1)


# ---------- 端到端：agent_topology(agent_name, lookback_days) ----------

class _Base(unittest.TestCase):
    def setUp(self):
        topology._cache.clear()
        self.rows = []
        self.query = mock.Mock(side_effect=lambda *a, **k: self.rows)
        patches = [
            mock.patch.object(agentstatus, "_now", return_value=NOW),
            mock.patch.object(agentstatus, "_run_insights_query", self.query),
            mock.patch.object(agentstatus.catalog, "cached_agents",
                              return_value={"agents": [AGENT]}),
            mock.patch.object(agentstatus.tracesource, "resolve_span_config",
                              return_value=CFG),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def seed(self):
        self.rows += [
            invoke_agent_row("s1", days_ago(1), 4.0),
            tool_row("s1", days_ago(1) + timedelta(seconds=1)),
            invoke_agent_row("s2", days_ago(3), 2.0),
            invoke_agent_row("s3", days_ago(6, 23), 3.0),
            invoke_agent_row("old", days_ago(9), 3.0),   # 窗外：7 天前
        ]


class EndToEnd(_Base):
    def test_shape_window_and_source(self):
        self.seed()
        out = topology.agent_topology("support-bot")
        self.assertEqual(out["event"], "agent_topology")
        self.assertEqual(out["agent_name"], "support-bot")
        self.assertEqual(out["lookback_days"], 7)
        self.assertEqual(out["window"], {"from": "2026-08-27T08:00:00Z", "to": "2026-09-03T08:00:00Z"})
        self.assertEqual(out["sessions"], 3)
        self.assertEqual(out["sessions_source"], CFG["log_group"])
        self.assertEqual(by_id(out["nodes"])["start"]["count"], 3)
        self.assertEqual(out["top_path"], {"nodes": ["start", "agent"], "count": 2,
                                           "share": 0.6667})
        self.assertIsNone(out["unavailable_reason"])
        for key in ("nodes", "edges", "slowest", "cached"):
            self.assertIn(key, out)

    def test_same_query_same_fetcher_as_agent_status(self):
        self.seed()
        topology.agent_topology("support-bot", lookback_days=7)
        self.assertEqual(self.query.call_count, 1)
        log_group, query, lookback = self.query.call_args.args
        self.assertEqual(log_group, CFG["log_group"])
        # 与 agent_status 同一条查询，只少那一行 evaltest 过滤（挪到 Python 侧按前缀分流）
        self.assertEqual(query, agentstatus.build_status_query("", "", include_test=True))
        self.assertEqual(query,
                         agentstatus.build_status_query("", "").replace(
                             " | filter attributes.session.id not like 'evaltest'", ""))
        self.assertNotIn("evaltest", query)
        self.assertEqual(lookback, 7)

    def test_sessions_equal_agent_status_session_metric_on_same_spans(self):
        self.seed()
        out = topology.agent_topology("support-bot", lookback_days=7)
        spans = agentstatus._rows_to_spans(self.rows)
        cut = int((NOW - timedelta(days=7)).timestamp() * 1_000_000_000)
        window = [s for s in spans if s["start_time"] >= cut]
        values, _, _ = agentstatus._window_metrics(window, PRICES["prices"], "近 7 天")
        self.assertEqual(out["sessions"], values["sessions"])
        self.assertEqual(out["sessions"],
                         sum(h["sessions"] for h in agentstatus.hourly_sessions(window, 7 * 24, NOW)))

    def test_sessions_source_with_service_and_scope_filter(self):
        with mock.patch.object(agentstatus.tracesource, "resolve_span_config",
                               return_value={"log_group": "aws/spans", "scope_filter": "",
                                             "service_filter": "deepseek-harness"}):
            out = topology.agent_topology("support-bot")
        self.assertEqual(out["sessions_source"], "aws/spans · service=deepseek-harness")
        log_group, query, _ = self.query.call_args.args
        self.assertEqual(log_group, "aws/spans")
        self.assertEqual(query, agentstatus.build_status_query("", "deepseek-harness", include_test=True))
        self.assertIn('resource.attributes.service.name = "deepseek-harness"', query)

    def test_lookback_default_clamp_and_validation(self):
        self.assertEqual(topology.agent_topology("support-bot", lookback_days=None)["lookback_days"], 7)
        self.assertEqual(topology.agent_topology("support-bot", lookback_days=90)["lookback_days"], 30)
        self.assertEqual(topology.agent_topology("support-bot", lookback_days="3")["lookback_days"], 3)
        self.assertEqual(topology.agent_topology("support-bot", lookback_days=0)["lookback_days"], 1)
        with self.assertRaises(ValueError) as cm:
            topology.agent_topology("support-bot", lookback_days="abc")
        self.assertEqual(str(cm.exception), "lookback_days 须为 1–30 的整数")

    def test_unknown_agent(self):
        with self.assertRaises(ValueError) as cm:
            topology.agent_topology("ghost")
        self.assertEqual(str(cm.exception), "Agent 'ghost' 不存在")


class Unavailable(_Base):
    def assert_empty(self, out, reason):
        self.assertEqual(out["unavailable_reason"], reason)
        self.assertEqual((out["sessions"], out["nodes"], out["edges"], out["top_path"],
                          out["slowest"]), (0, [], [], None, None))
        # 其余字段照常
        for key in ("event", "agent_name", "lookback_days", "window", "sessions_source"):
            self.assertIn(key, out)

    def test_zero_spans_in_window_says_agent_reports_nothing(self):
        # 窗内一条 span 都没有（含评估流量）⇒ 是「没上报」不是「没会话」
        self.rows = [invoke_agent_row("old", days_ago(9), 3.0),
                     invoke_agent_row("evaltest-old", days_ago(8), 3.0)]
        out = topology.agent_topology("support-bot")
        self.assert_empty(out, "近 7 天 Agent 未上报任何 span（含评估流量）")
        self.assertFalse(out["agent_reports_spans"])
        self.assertEqual((out["live_sessions"], out["eval_sessions"], out["sessions_scope"]),
                         (0, 0, "live"))
        self.assertEqual(topology.agent_topology("support-bot", lookback_days=3,
                                                 refresh=True)["unavailable_reason"],
                         "近 3 天 Agent 未上报任何 span（含评估流量）")
        # 显式 include_eval=True 也一样是这句，scope 落回 live+eval
        out = topology.agent_topology("support-bot", include_eval=True)
        self.assertEqual(out["unavailable_reason"], "近 7 天 Agent 未上报任何 span（含评估流量）")
        self.assertEqual(out["sessions_scope"], "live+eval")

    def test_zero_sessions_in_scope_keeps_old_wording(self):
        # 有 span（评估流量）但显式只看真实 ⇒ 维持「近 N 天没有会话」，且 agent_reports_spans 为真
        self.rows = [invoke_agent_row("evaltest-rt-1", days_ago(1), 3.0)]
        out = topology.agent_topology("support-bot", include_eval=False)
        self.assert_empty(out, "近 7 天没有会话")
        self.assertTrue(out["agent_reports_spans"])
        self.assertEqual((out["live_sessions"], out["eval_sessions"], out["sessions_scope"]),
                         (0, 1, "live"))

    def test_no_span_source(self):
        with mock.patch.object(agentstatus.tracesource, "resolve_span_config",
                               return_value=None):
            out = topology.agent_topology("support-bot")
        self.assert_empty(out, "未配置 span 源")
        self.assertIsNone(out["sessions_source"])
        self.assertEqual(self.query.call_count, 0)

    def test_query_failure(self):
        self.query.side_effect = TimeoutError("Logs Insights query timed out for lg")
        out = topology.agent_topology("support-bot")
        self.assertTrue(out["unavailable_reason"].startswith("Logs Insights 查询失败："))
        self.assertIn("timed out", out["unavailable_reason"])
        self.assert_empty(out, out["unavailable_reason"])

    def test_truncated_result(self):
        self.rows = [invoke_agent_row(f"s{i}", days_ago(1), 1.0)
                     for i in range(agentstatus.INSIGHTS_ROW_LIMIT)]
        out = topology.agent_topology("support-bot")
        self.assertIn(str(agentstatus.INSIGHTS_ROW_LIMIT), out["unavailable_reason"])
        self.assertIn("近 7 天", out["unavailable_reason"])
        self.assert_empty(out, out["unavailable_reason"])


# ---------- 评估流量三档（include_eval） ----------

def eval_rows(n=2, day=2):
    """n 个评估会话（id 以 evaltest 开头，testrun/redteam/probe 同一个前缀），各一次 agent + 一次工具。"""
    out = []
    for i in range(n):
        sid = f"evaltest-rt-{i}"
        out += [invoke_agent_row(sid, days_ago(day, i), 2.0),
                tool_row(sid, days_ago(day, i) + timedelta(seconds=1))]
    return out


class EvalTraffic(_Base):
    def test_auto_prefers_live_and_reports_eval_count(self):
        self.seed()
        self.rows += eval_rows(2)
        out = topology.agent_topology("support-bot")
        self.assertEqual(self.query.call_count, 1, "一次查询，Python 侧分流")
        self.assertEqual(out["sessions_scope"], "live")
        self.assertEqual((out["sessions"], out["live_sessions"], out["eval_sessions"]), (3, 3, 2))
        self.assertTrue(out["agent_reports_spans"])
        self.assertIsNone(out["unavailable_reason"])
        self.assertEqual(by_id(out["nodes"])["start"]["count"], 3)
        # 评估会话的工具调用没有混进真实图：seed 只有 s1 一次 lookup
        self.assertEqual(by_id(out["nodes"])["tool:lookup"]["count"], 1)

    def test_auto_falls_back_to_eval_only_when_live_is_zero(self):
        self.rows = eval_rows(2) + [invoke_agent_row("old", days_ago(9), 3.0)]
        out = topology.agent_topology("support-bot")
        self.assertEqual(self.query.call_count, 1, "退到评估流量不再查第二次")
        self.assertEqual(out["sessions_scope"], "eval_only")
        self.assertEqual((out["sessions"], out["live_sessions"], out["eval_sessions"]), (2, 0, 2))
        self.assertTrue(out["agent_reports_spans"])
        self.assertIsNone(out["unavailable_reason"])
        self.assertEqual(by_id(out["nodes"])["start"]["count"], 2)
        self.assertEqual(by_id(out["nodes"])["tool:lookup"]["count"], 2)

    def test_auto_with_nothing_at_all_is_empty(self):
        self.rows = []
        out = topology.agent_topology("support-bot")
        self.assertEqual(out["unavailable_reason"], "近 7 天 Agent 未上报任何 span（含评估流量）")
        self.assertEqual((out["sessions"], out["nodes"], out["edges"]), (0, [], []))
        self.assertFalse(out["agent_reports_spans"])

    def test_explicit_true_merges_both(self):
        self.seed()
        self.rows += eval_rows(2)
        out = topology.agent_topology("support-bot", include_eval=True)
        self.assertEqual(out["sessions_scope"], "live+eval")
        self.assertEqual((out["sessions"], out["live_sessions"], out["eval_sessions"]), (5, 3, 2))
        self.assertEqual(by_id(out["nodes"])["start"]["count"], 5)
        self.assertEqual(by_id(out["nodes"])["tool:lookup"]["count"], 3)
        self.assertEqual(self.query.call_count, 1)

    def test_explicit_false_is_live_only_even_when_live_is_zero(self):
        self.rows = eval_rows(2)
        out = topology.agent_topology("support-bot", include_eval=False)
        self.assertEqual(out["sessions_scope"], "live")
        self.assertEqual(out["unavailable_reason"], "近 7 天没有会话")
        self.assertEqual((out["sessions"], out["live_sessions"], out["eval_sessions"]), (0, 0, 2))
        self.seed()
        out = topology.agent_topology("support-bot", include_eval=False, refresh=True)
        self.assertEqual((out["sessions"], out["live_sessions"], out["eval_sessions"]), (3, 3, 2))
        self.assertIsNone(out["unavailable_reason"])

    def test_live_sessions_equal_agent_status_metric_with_eval_mixed_in(self):
        # agent_status 那条查询在 Insights 侧排除 evaltest；这里在 Python 侧按前缀分流，
        # 两边的会话数必须相等（同源判据在有评估流量时仍成立）
        self.seed()
        self.rows += eval_rows(3)
        out = topology.agent_topology("support-bot")
        insights_filtered = [r for r in self.rows
                             if "evaltest" not in next(c["value"] for c in r if c["field"] == "sid")]
        spans = agentstatus._rows_to_spans(insights_filtered)
        cut = int((NOW - timedelta(days=7)).timestamp() * 1_000_000_000)
        window = [s for s in spans if s["start_time"] >= cut]
        values, _, _ = agentstatus._window_metrics(window, PRICES["prices"], "近 7 天")
        self.assertEqual(out["live_sessions"], values["sessions"])
        self.assertEqual(out["sessions"], values["sessions"])

    def test_split_helpers(self):
        self.assertTrue(topology.is_eval_session("evaltest-rt-abc"))
        self.assertTrue(topology.is_eval_session("evaltest-202608261402-a21f"))
        self.assertFalse(topology.is_eval_session("sess-1"))
        self.assertFalse(topology.is_eval_session(None))
        spans = agentstatus._rows_to_spans(eval_rows(1) + [invoke_agent_row("s1", days_ago(1), 1.0)])
        live, evals = topology.split_spans(spans)
        self.assertEqual(len(live), 1)
        self.assertEqual(len(evals), 2)


class BuildStatusQueryDefaultUnchanged(unittest.TestCase):
    """build_status_query 默认文本拿旧字符串逐字钉住；include_test=True 只少那一行。"""

    OLD = (
        "fields attributes.session.id as sid, traceId as tid, name,"
        " startTimeUnixNano as t0, endTimeUnixNano as t1,"
        " status.code as status_code, scope.name as scope_name,"
        " attributes.gen_ai.tool.status as tool_status,"
        " attributes.gen_ai.request.model as model,"
        " attributes.gen_ai.usage.input_tokens as in_tok,"
        " attributes.gen_ai.usage.prompt_tokens as prompt_tok,"
        " attributes.gen_ai.usage.output_tokens as out_tok,"
        " attributes.gen_ai.usage.cache_read.input_tokens as cr_tok,"
        " attributes.gen_ai.usage.cache_write.input_tokens as cw_tok,"
        " attributes.gen_ai.usage.cache_read_input_tokens as cr_tok2,"
        " attributes.gen_ai.usage.cache_write_input_tokens as cw_tok2,"
        " attributes.gen_ai.response.finish_reasons as finish_reasons"
        " | filter ispresent(attributes.session.id)"
        " | filter attributes.session.id not like 'evaltest'"
        " | sort startTimeUnixNano desc"
        " | limit 10000"
    )

    def test_default_is_byte_identical_to_pre_change_text(self):
        self.assertEqual(agentstatus.build_status_query(), self.OLD)
        self.assertEqual(agentstatus.build_status_query("", ""), self.OLD)
        self.assertEqual(agentstatus.build_status_query("", "", include_test=False), self.OLD)

    def test_include_test_drops_exactly_the_evaltest_line(self):
        q = agentstatus.build_status_query("", "", include_test=True)
        self.assertEqual(q, self.OLD.replace(" | filter attributes.session.id not like 'evaltest'", ""))
        self.assertNotIn("evaltest", q)
        # 带 service / scope 过滤时，位置关系不变：span 过滤在前、排序在后
        q2 = agentstatus.build_status_query("strands.telemetry.tracer", "deepseek-harness", include_test=True)
        self.assertIn(agentstatus.build_span_filters("strands.telemetry.tracer", "deepseek-harness")
                      + " | sort startTimeUnixNano desc", q2)
        self.assertNotIn("evaltest", q2)


class Cache(_Base):
    def test_hit_by_agent_and_lookback(self):
        self.seed()
        first = topology.agent_topology("support-bot", lookback_days=7)
        self.assertFalse(first["cached"])
        self.assertEqual(first["cache_age_s"], 0, "未命中也回 cache_age_s（与 fleet_status 同款）")
        again = topology.agent_topology("support-bot", lookback_days=7)
        self.assertEqual(self.query.call_count, 1)
        self.assertTrue(again["cached"])
        self.assertEqual({k: v for k, v in again.items() if k not in ("cached", "cache_age_s")},
                         {k: v for k, v in first.items() if k not in ("cached", "cache_age_s")})
        topology.agent_topology("support-bot", lookback_days=3)
        self.assertEqual(self.query.call_count, 2, "不同 lookback 是另一个键")
        self.assertEqual(set(topology._cache), {("support-bot", 7, None), ("support-bot", 3, None)})

    def test_include_eval_is_part_of_the_key(self):
        self.seed()
        topology.agent_topology("support-bot")
        topology.agent_topology("support-bot", include_eval=True)
        topology.agent_topology("support-bot", include_eval=False)
        self.assertEqual(self.query.call_count, 3, "三档各一个键")
        self.assertEqual(set(topology._cache),
                         {("support-bot", 7, None), ("support-bot", 7, True), ("support-bot", 7, False)})
        self.assertTrue(topology.agent_topology("support-bot", include_eval=True)["cached"])
        self.assertEqual(self.query.call_count, 3)

    def test_cache_age_s_counts_seconds_since_the_original_compute(self):
        self.seed()
        clock = {"t": 5000.0}
        with mock.patch.object(topology.ttlcache, "_monotonic", side_effect=lambda: clock["t"]):
            topology.agent_topology("support-bot")
            clock["t"] += 42
            self.assertEqual(topology.agent_topology("support-bot")["cache_age_s"], 42)

    def test_refresh_bypasses_and_ttl_expires(self):
        self.seed()
        topology.agent_topology("support-bot")
        topology.agent_topology("support-bot", refresh=True)
        self.assertEqual(self.query.call_count, 2)
        with mock.patch.object(topology.ttlcache, "_monotonic",
                               return_value=(topology.ttlcache._monotonic()
                                             + topology.CACHE_TTL_SECONDS + 1)):
            out = topology.agent_topology("support-bot")
        self.assertEqual(self.query.call_count, 3)
        self.assertFalse(out["cached"])


class ReadOnlyThroughMain(unittest.TestCase):
    """全程走 main.invoke：DDB 写方法与 S3 put 一次都不许被调。"""

    def _invoke(self, payload, table, s3, rows=()):
        import main
        topology._cache.clear()
        with mock.patch.object(main.catalog, "get_table", return_value=table), \
                mock.patch.object(main.catalog, "TABLE_NAME", "tbl"), \
                mock.patch.object(main.catalog, "cached_agents",
                                  return_value={"agents": [AGENT]}), \
                mock.patch.object(main.runstore, "_s3", return_value=s3), \
                mock.patch.object(agentstatus, "_now", return_value=NOW), \
                mock.patch.object(agentstatus.tracesource, "resolve_span_config",
                                  return_value=CFG), \
                mock.patch.object(agentstatus, "_run_insights_query", return_value=list(rows)):
            async def go():
                return [ev async for ev in main.invoke(payload)]
            return asyncio.run(go())

    def test_dispatch_never_writes(self):
        table = mock.MagicMock()
        table.query.return_value = {"Items": []}
        table.get_item.return_value = {}
        s3 = mock.MagicMock()
        events = self._invoke({"action": "agent_topology", "agent_name": "support-bot",
                               "lookback_days": 7}, table, s3,
                              rows=[invoke_agent_row("s1", days_ago(1), 4.0)])
        self.assertEqual([e["event"] for e in events], ["agent_topology"])
        ev = events[0]
        self.assertEqual((ev["agent_name"], ev["lookback_days"], ev["sessions"]),
                         ("support-bot", 7, 1))
        for key in ("window", "sessions_source", "nodes", "edges", "top_path", "slowest",
                    "unavailable_reason", "sessions_scope", "live_sessions", "eval_sessions",
                    "agent_reports_spans"):
            self.assertIn(key, ev)
        self.assertEqual(ev["sessions_scope"], "live")
        for w in ("put_item", "update_item", "delete_item", "batch_writer",
                  "batch_write_item", "transact_write_items"):
            self.assertFalse(getattr(table, w).called, f"table.{w} 被调用了")
        for w in ("put_object", "delete_object", "copy_object"):
            self.assertFalse(getattr(s3, w).called, f"s3.{w} 被调用了")

    def test_include_eval_passthrough(self):
        table, s3 = mock.MagicMock(), mock.MagicMock()
        table.query.return_value = {"Items": []}
        table.get_item.return_value = {}
        rows = [invoke_agent_row("evaltest-rt-1", days_ago(1), 2.0)]
        auto = self._invoke({"action": "agent_topology", "agent_name": "support-bot"}, table, s3, rows)[0]
        self.assertEqual((auto["sessions_scope"], auto["sessions"]), ("eval_only", 1))
        on = self._invoke({"action": "agent_topology", "agent_name": "support-bot",
                           "include_eval": True}, table, s3, rows)[0]
        self.assertEqual((on["sessions_scope"], on["sessions"]), ("live+eval", 1))
        off = self._invoke({"action": "agent_topology", "agent_name": "support-bot",
                            "include_eval": False}, table, s3, rows)[0]
        self.assertEqual((off["sessions_scope"], off["sessions"], off["unavailable_reason"]),
                         ("live", 0, "近 7 天没有会话"))
        for w in ("put_item", "update_item", "delete_item"):
            self.assertFalse(getattr(table, w).called)

    def test_error_frames(self):
        table, s3 = mock.MagicMock(), mock.MagicMock()
        self.assertEqual(self._invoke({"action": "agent_topology"}, table, s3),
                         [{"event": "error", "error": "agent_name is required."}])
        self.assertEqual(self._invoke({"action": "agent_topology", "agent_name": "ghost"}, table, s3),
                         [{"event": "error", "error": "Agent 'ghost' 不存在"}])
        self.assertEqual(self._invoke({"action": "agent_topology", "agent_name": "support-bot",
                                       "lookback_days": "x"}, table, s3),
                         [{"event": "error", "error": "lookback_days 须为 1–30 的整数"}])


# ---------- 会话级：recent_sessions / session_paths ----------

class SessionLevel(unittest.TestCase):
    """两会话夹具：
         old（2 天前）  agent 1.0s → tool:lookup 0.2s → tool:lookup 0.2s（ERROR）
         new（1 天前）  agent 2.0s → tool:lookup 0.2s
    """
    T_OLD = days_ago(2)
    T_NEW = days_ago(1)

    def graph(self):
        spans = agentstatus._rows_to_spans([
            invoke_agent_row("old", self.T_OLD, 1.0),
            tool_row("old", self.T_OLD + timedelta(seconds=0.5)),
            tool_row("old", self.T_OLD + timedelta(seconds=1), status_code="ERROR", tool_status="error"),
            invoke_agent_row("new", self.T_NEW, 2.0),
            tool_row("new", self.T_NEW + timedelta(seconds=0.3)),
        ])
        return topology.aggregate(*topology.sessions_from_spans(spans, with_meta=True))

    @staticmethod
    def iso(dt):
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    def test_recent_sessions_order_duration_failed(self):
        nodes = by_id(self.graph()["nodes"])
        # 倒序：new 在前；at = 该节点在该会话里首次出现的时刻（tool 是 +0.3s / +0.5s，不是会话开始）
        self.assertEqual(nodes["tool:lookup"]["recent_sessions"], [
            {"session_id": "new", "at": self.iso(self.T_NEW + timedelta(seconds=0.3)),
             "duration_s": 0.2, "failed": False},
            {"session_id": "old", "at": self.iso(self.T_OLD + timedelta(seconds=0.5)),
             "duration_s": 0.4, "failed": True},   # 两次 lookup 的总耗时；其中一次报错
        ])
        self.assertEqual(nodes["agent"]["recent_sessions"], [
            {"session_id": "new", "at": self.iso(self.T_NEW), "duration_s": 2.0, "failed": False},
            {"session_id": "old", "at": self.iso(self.T_OLD), "duration_s": 1.0, "failed": False},
        ])
        # start：at = 会话开始，没有时长
        self.assertEqual(nodes["start"]["recent_sessions"], [
            {"session_id": "new", "at": self.iso(self.T_NEW), "duration_s": None, "failed": False},
            {"session_id": "old", "at": self.iso(self.T_OLD), "duration_s": None, "failed": False},
        ])

    def test_session_paths_order_and_failed_nodes(self):
        out = self.graph()
        self.assertEqual(out["session_paths"], [
            {"session_id": "new", "at": self.iso(self.T_NEW), "path": ["start", "agent", "tool:lookup"],
             "failed_nodes": 0},
            {"session_id": "old", "at": self.iso(self.T_OLD),
             "path": ["start", "agent", "tool:lookup", "tool:lookup"], "failed_nodes": 1},
        ])
        # 节点 id 与 nodes[].id 同一套
        ids = {n["id"] for n in out["nodes"]}
        for p in out["session_paths"]:
            self.assertTrue(set(p["path"]) <= ids)

    def test_truncated_to_ten_newest_first(self):
        spans = agentstatus._rows_to_spans([
            invoke_agent_row(f"s{i:02d}", days_ago(6) + timedelta(hours=i), 1.0) for i in range(13)])
        out = topology.aggregate(*topology.sessions_from_spans(spans, with_meta=True))
        self.assertEqual(out["sessions"], 13)
        self.assertEqual([p["session_id"] for p in out["session_paths"]],
                         [f"s{i:02d}" for i in range(12, 2, -1)])          # 12..3，共 10 条
        agent = by_id(out["nodes"])["agent"]
        self.assertEqual(len(agent["recent_sessions"]), topology.RECENT_SESSIONS_LIMIT)
        self.assertEqual(agent["recent_sessions"][0]["session_id"], "s12")

    def test_top_path_count_matches_session_paths(self):
        # 4 会话：3 条走 start→agent，1 条 start→agent→tool（全部 ≤ 10，session_paths 是全集）
        spans = agentstatus._rows_to_spans([
            invoke_agent_row("a", days_ago(4), 1.0),
            invoke_agent_row("b", days_ago(3), 1.0),
            invoke_agent_row("c", days_ago(2), 1.0),
            invoke_agent_row("d", days_ago(1), 1.0),
            tool_row("d", days_ago(1) + timedelta(seconds=1)),
        ])
        out = topology.aggregate(*topology.sessions_from_spans(spans, with_meta=True))
        top = out["top_path"]
        same = [p for p in out["session_paths"] if p["path"] == top["nodes"]]
        self.assertEqual(top["count"], len(same))
        self.assertEqual(top["count"], 3)

    def test_plain_event_lists_have_no_session_identity(self):
        out = topology.aggregate(SESSIONS)
        self.assertEqual(out["session_paths"], [])
        for n in out["nodes"]:
            self.assertEqual(n["recent_sessions"], [])
        self.assertEqual(topology.aggregate([])["session_paths"], [])


class SessionLevelEndToEnd(_Base):
    def test_response_carries_recent_sessions_and_session_paths(self):
        self.seed()
        out = topology.agent_topology("support-bot")
        self.assertEqual([p["session_id"] for p in out["session_paths"]], ["s1", "s2", "s3"])
        self.assertEqual(out["session_paths"][0]["path"], ["start", "agent", "tool:lookup"])
        self.assertEqual(out["session_paths"][0]["at"], "2026-09-02T08:00:00Z")
        nodes = by_id(out["nodes"])
        self.assertEqual([r["session_id"] for r in nodes["agent"]["recent_sessions"]], ["s1", "s2", "s3"])
        self.assertEqual(nodes["tool:lookup"]["recent_sessions"],
                         [{"session_id": "s1", "at": "2026-09-02T08:00:01Z", "duration_s": 0.2, "failed": False}])
        # 不可用态：session_paths 也是 []（与 nodes / edges 同一档）
        topology._cache.clear()
        self.rows = []
        out = topology.agent_topology("support-bot", refresh=True)
        self.assertEqual(out["session_paths"], [])
        self.assertIsNotNone(out["unavailable_reason"])


if __name__ == "__main__":
    unittest.main()
