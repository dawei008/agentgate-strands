"""判官看不见工具调用：合成 Session 的 available_tools 恒空、零 ToolExecutionSpan。

现场（2026-08-26，航空 15 用例 baseline/v3 两轮真 run）：`tau-airline-16-uncovered-rule`
两侧都**真的**调了 `transfer_to_human_agents`，两侧 `policy_compliance` 都判 **0.0**，
理由是一句在数据面为假的话（「没有实际工具调用记录」）。反方向同根：`tau-airline-14`
里工具如实返回的事实被判成「凭空编造」。缺陷不在判官，在 `testrun._synthetic_session`
—— 它把一次问答手工包成 Session，`available_tools=[]` 写死、一条工具 span 都不带，
于是「必须实际调用 X 工具」这类断言**结构上不可验**。

夹具是**现网原样导出的两条记录**（`tests/fixtures/agentcore_spans_tau_airline_16.json`，
2026-08-26 从 `/aws/bedrock-agentcore/runtimes/tauairline_airlineagent_v3-EXAMPLE0002-DEFAULT`
按 session.id=`evaltest-202608261402-a21f78ee45d54295909e8c2fd73c45a6` 查出，未改一字）：
一条 `invoke_agent`、一条 `execute_tool transfer_to_human_agents`。**不手抄形状**——
工具入参与返回值藏在记录自带的 inline `events`（`gen_ai.tool.message` /
`gen_ai.choice`）里，手抄这层最容易抄成「看起来对但判官读不到」的假契约。

⚠️ 本文件必须显式 `patches.apply()`：把 inline `events` 抬进 `span_events` 的正是
`patches._parse_with_inline_events`，生产里由 `app/main.py` 导入时调用。不调它，
mapper 看不到入参/返回值，而**空入参与「没有调用」在下游同形** —— 那正是本缺陷。

不碰真 agent / 真 LLM / 真 AWS：夹具是离线 JSON，取数边界（Insights 查询）用假函数
接住并检查它到底按什么过滤。
运行：python3 -m pytest tests/test_tool_evidence.py -q
"""

import json
import sys
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(APP))

import patches  # noqa: E402

patches.apply()

import testrun  # noqa: E402
import toolevidence  # noqa: E402
import tracesource  # noqa: E402
from strands_evals.types.trace import (  # noqa: E402
    AgentInvocationSpan,
    ToolExecutionSpan,
)

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "agentcore_spans_tau_airline_16.json"
SESSION_ID = "evaltest-202608261402-a21f78ee45d54295909e8c2fd73c45a6"
REAL_TOOL = "transfer_to_human_agents"
REAL_TOOL_SPAN_ID = "c38c5ab1f6ac4975"      # 那条 execute_tool span 的真 spanId
CASE_INPUT = "我要托运一只 8 公斤的猫，另外餐食能不能升级海鲜餐？上月航班的里程也没补登。"
CASE_OUTPUT = "林先生，您的请求我已经为您转接人工客服了，请稍候。"


def _dict_literals(path: Path) -> list[set]:
    """一个源文件里每个 dict 字面量的字符串键集合（用于按形状而非按措辞下判据）。"""
    import ast

    out = []
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Dict):
            out.append({k.value for k in node.keys
                        if isinstance(k, ast.Constant) and isinstance(k.value, str)})
    return out


def _records(with_tool: bool = True) -> list[dict]:
    recs = json.loads(FIXTURE.read_text())
    if with_tool:
        return recs
    # 阴性对照：同一份夹具去掉工具记录 = 「查得到，且确实一次没调」
    return [r for r in recs
            if r.get("attributes", {}).get("gen_ai.operation.name") != "execute_tool"]


def _all_reasons() -> dict:
    """toolevidence 里**全部**降级原因常量（名 -> 文本）。

    ⚠️ 不写成手抄的元组：新加一档原因时，手抄那份**不报错，只是静默漏掉它** ——
    而这一族守卫（降级不许出块、措辞不许被读成「它没调」）恰恰是新常量最该过的。
    反向钉见 `test_the_guard_actually_enumerates_every_reason`：不加那道钉，
    前缀写错会让下面每个循环空转成绿。
    """
    return {n: getattr(toolevidence, n) for n in dir(toolevidence)
            if n.startswith("REASON_") and isinstance(getattr(toolevidence, n), str)}


def _real_session(with_tool: bool = True):
    session, _spans = tracesource._session_from_records("lg", SESSION_ID, _records(with_tool))
    return session


def _synthetic():
    return testrun._synthetic_session(SESSION_ID, CASE_INPUT, CASE_OUTPUT)


def _tools_of(session) -> list:
    return [sp for tr in session.traces for sp in tr.spans
            if isinstance(sp, ToolExecutionSpan)]


def _agents_of(session) -> list:
    return [sp for tr in session.traces for sp in tr.spans
            if isinstance(sp, AgentInvocationSpan)]


class TestSyntheticSessionIsBlind(unittest.TestCase):
    """先把缺陷本体钉住：没有嫁接，合成 Session 里一件证据都没有。"""

    def test_before_graft_no_tools_at_all(self):
        syn = _synthetic()
        hosts = _agents_of(syn)
        self.assertTrue(hosts, "合成 Session 至少要有一个 AgentInvocationSpan")
        for host in hosts:
            self.assertEqual(list(host.available_tools or []), [])
        self.assertEqual(_tools_of(syn), [])


class TestGraftAbsolute(unittest.TestCase):
    """**绝对判据**：嫁接后 available_tools 不再恒空、工具 span 不再恒零。

    为什么必须是绝对判据而不是「比修复前多」：`available_tools=[]` 是写死的常量，
    任何相对判据（多了/变了）在「两边都是空」时同样为真。
    """

    def test_available_tools_is_no_longer_empty(self):
        syn = _synthetic()
        toolevidence.graft(syn, _real_session())
        for host in _agents_of(syn):
            self.assertGreater(len(host.available_tools or []), 0,
                               "available_tools 仍为空 = 缺陷没修")
        names = {c.name for host in _agents_of(syn) for c in host.available_tools}
        # 现网这个 runtime 自己声明了全套工具（gen_ai.agent.tools），所以判官拿到的
        # 是**完整清单**而不只是被调过的那个 —— 这两件事不同刑，分别钉住。
        self.assertIn(REAL_TOOL, names)
        self.assertGreater(len(names), 1,
                           "声明式清单应含未被调用的工具；只剩 1 个说明退化成了「由调用推得」")

    def test_tool_span_is_grafted_with_real_payload(self):
        syn = _synthetic()
        calls = toolevidence.graft(syn, _real_session())
        spans = _tools_of(syn)
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0].tool_call.name, REAL_TOOL)
        # 入参与返回值来自记录自带的 inline events；空字符串说明 patches 那一层断了
        self.assertTrue(spans[0].tool_call.arguments, "工具入参为空 = inline events 没被消费")
        self.assertIn("TRANSFER_DONE", str(spans[0].tool_result.content))
        self.assertEqual([c["name"] for c in calls], [REAL_TOOL])

    def test_graft_does_not_touch_the_text_the_judge_grades(self):
        """嫁接只**增加**信息：正文一个字节不动。

        替换整个 Session 会把判官读到的 agent_response 换成 mapper 的
        `[{'text': …}]` blob，那会动到与本缺陷无关的 correctness/helpfulness。
        """
        syn = _synthetic()
        before = [(sp.user_prompt, sp.agent_response) for sp in _agents_of(syn)]
        toolevidence.graft(syn, _real_session())
        after = [(sp.user_prompt, sp.agent_response) for sp in _agents_of(syn)]
        self.assertEqual(before, after)
        self.assertEqual(after[-1][1], CASE_OUTPUT)


class TestJudgeCanSeeIt(unittest.TestCase):
    """证据必须真的出现在判官读到的那段文字里——嫁接了但判官读不到等于没修。"""

    def test_trace_level_evaluator_renders_the_tool_call(self):
        from strands_evals.extractors.trace_extractor import TraceExtractor
        from strands_evals.evaluators.helpfulness_evaluator import HelpfulnessEvaluator

        ev = HelpfulnessEvaluator(model="us.anthropic.claude-opus-5")
        syn = _synthetic()

        def rendered():
            parsed = TraceExtractor(ev.evaluation_level).extract(syn)
            return ev._format_trace_level_prompt(parsed[-1])

        self.assertNotIn("Tool call:", rendered())      # 阴性对照：修复前读不到
        toolevidence.graft(syn, _real_session())
        prompt = rendered()
        self.assertIn(f"Tool call: {REAL_TOOL}(", prompt)
        self.assertIn("Tool result:", prompt)
        self.assertIn("TRANSFER_DONE", prompt)

    def test_output_evaluator_gets_the_block_before_the_rubric(self):
        """自定义 rubric 走 OutputEvaluator，它的 prompt 结构上读不到 trajectory。

        位置有意义：rubric 是判官的指令且排在最末，证据必须在指令**之前**出现，
        否则「按上述内容评分」指向一段还没出现的文字。
        """
        from strands_evals.evaluators.output_evaluator import OutputEvaluator
        from strands_evals.types.evaluation import EvaluationData

        ev = OutputEvaluator(name="policy_compliance",
                             rubric=f"1. 必须实际调用 {REAL_TOOL} 工具",
                             model="us.anthropic.claude-opus-5")
        data = EvaluationData(input=CASE_INPUT, actual_output=CASE_OUTPUT)
        self.assertNotIn("ToolCalls", ev._build_prompt(data))   # 阴性对照

        syn = _synthetic()
        field = toolevidence.captured_field(toolevidence.graft(syn, _real_session()))
        hit = toolevidence.attach_to_output_evaluators(
            [ev], toolevidence.prompt_block(field))
        self.assertEqual(hit, 1)

        prompt = ev._build_prompt(data)
        self.assertIn(REAL_TOOL, prompt)
        self.assertLess(prompt.index("<ToolCalls>"), prompt.index("<Rubric>"),
                        "证据落在 rubric 之后 = 判官读指令时还没看到证据")
        # 正文没被这次注入改动
        self.assertIn(f"<Output>{CASE_OUTPUT}</Output>", prompt)

    def test_trace_level_evaluators_are_not_double_fed(self):
        """内置 TRACE_LEVEL 评估器嫁接后自己就看得见，不许再注入一遍。"""
        from strands_evals.evaluators.helpfulness_evaluator import HelpfulnessEvaluator
        from strands_evals.evaluators.output_evaluator import OutputEvaluator

        evs = [HelpfulnessEvaluator(model="m"),
               OutputEvaluator(name="policy_compliance", rubric="r", model="m")]
        self.assertEqual(toolevidence.attach_to_output_evaluators(evs, "<ToolCalls>x</ToolCalls>"), 1)

    def test_multimodal_output_evaluator_is_excluded(self):
        """MultimodalOutputEvaluator 是 OutputEvaluator 的子类，排除是必需的不是装饰。"""
        from strands_evals.evaluators.multimodal_output_evaluator import (
            MultimodalOutputEvaluator,
        )
        from strands_evals.evaluators.output_evaluator import OutputEvaluator

        self.assertTrue(issubclass(MultimodalOutputEvaluator, OutputEvaluator))
        mm = MultimodalOutputEvaluator(name="mm_visual_accuracy", rubric="r", model="m")
        self.assertEqual(toolevidence.attach_to_output_evaluators([mm], "<ToolCalls>x</ToolCalls>"), 0)

    def test_injection_is_per_instance_not_per_class(self):
        """改实例不改类：同进程里后建的评估器不许被上一次的证据污染。"""
        from strands_evals.evaluators.output_evaluator import OutputEvaluator
        from strands_evals.types.evaluation import EvaluationData

        first = OutputEvaluator(name="policy_compliance", rubric="r", model="m")
        toolevidence.attach_to_output_evaluators([first], "<ToolCalls>CASE-A</ToolCalls>")
        later = OutputEvaluator(name="policy_compliance", rubric="r", model="m")
        data = EvaluationData(input="i", actual_output="o")
        self.assertIn("CASE-A", first._build_prompt(data))
        self.assertNotIn("CASE-A", later._build_prompt(data))
        # 注入过的实例不许把补丁函数序列化进配置（to_dict 跳过 `_` 前缀）
        self.assertNotIn("_build_prompt", first.to_dict())


class TestNegativeControl(unittest.TestCase):
    """真的一次没调工具的用例，必须仍然判不满足——修复不许把「没调」变成「调了」。"""

    def test_no_tool_calls_is_captured_not_unavailable(self):
        syn = _synthetic()
        calls = toolevidence.graft(syn, _real_session(with_tool=False))
        self.assertEqual(calls, [])
        field = toolevidence.captured_field(calls)
        self.assertEqual(field["status"], toolevidence.STATUS_CAPTURED)
        self.assertEqual(field["count"], 0)      # 「查得到且确实没调」≠「查不到」
        self.assertEqual(field["names"], [])

    def test_zero_call_block_says_it_did_not_call(self):
        block = toolevidence.prompt_block(toolevidence.captured_field([]))
        self.assertTrue(block, "0 次调用也要出块：判官据此判不满足是正确的")
        self.assertNotIn(REAL_TOOL, block)
        self.assertIn("没有任何工具调用记录", block)

    def test_no_tool_spans_are_invented(self):
        syn = _synthetic()
        toolevidence.graft(syn, _real_session(with_tool=False))
        self.assertEqual(_tools_of(syn), [], "凭空造出工具 span = 换个形状的同一个缺陷")

    def test_completeness_gate_accepts_a_tool_less_session(self):
        """完备判据不许拿「有工具 span」当条件，否则阴性对照永远等不到、只能降级。"""
        self.assertTrue(toolevidence.is_complete(_real_session(with_tool=False)))
        self.assertTrue(toolevidence.is_complete(_real_session()))

    def test_completeness_gate_rejects_a_half_written_session(self):
        """只捞到工具 span、invoke_agent 还没落库 = 还没写全，要继续等。

        少了这道闸，第一次 0 秒查询可能只捞到 3 次调用里的 1 次，
        而「1 次」与「真的只调了 1 次」在数据面完全同形。
        """
        half = [r for r in _records()
                if r.get("attributes", {}).get("gen_ai.operation.name") == "execute_tool"]
        session, _ = tracesource._session_from_records("lg", SESSION_ID, half)
        self.assertTrue(_tools_of(session), "夹具前提：这份半截数据里确实有工具 span")
        self.assertFalse(toolevidence.is_complete(session))

    def test_parentless_root_would_never_fire_as_a_gate(self):
        """夹具实证：runtime 日志组捞出的会话里没有无父 span，那道判据结构上不可能真。"""
        self.assertTrue(all(r.get("parentSpanId") for r in _records()))


class TestDegradation(unittest.TestCase):
    """取不到证据时的三态。判「有没有拿到」一律读 status，**不许**去理由里搜措辞。"""

    def test_the_guard_actually_enumerates_every_reason(self):
        """反向钉：`_all_reasons()` 真的枚举到了东西，且是已知那几档的超集。

        少了它，`startswith("REASON_")` 写错一个字母就会让本类里每个循环空转 ——
        「一条都没检查」与「全都通过了」在绿色输出上完全同形。
        """
        found = _all_reasons()
        known = {"REASON_NO_SPAN_SOURCE", "REASON_NOT_FOUND", "REASON_INCOMPLETE",
                 "REASON_SKIPPED", "REASON_FETCH_FAILED", "REASON_CACHE_HIT"}
        self.assertLessEqual(known, set(found), f"漏了已知原因：{sorted(known - set(found))}")

    def test_every_reason_is_a_distinct_sentence(self):
        """三档退化必须说得出不同的话。

        修复前 `REASON_NOT_FOUND` 一个人干了三份活（查到 0 条 / 查到但没写全 /
        因为熔断根本没去查），排障时读不出到底是哪一种，而三者的下一步动作互不相同。
        """
        texts = list(_all_reasons().values())
        self.assertEqual(len(set(texts)), len(texts), "有两档降级原因是同一句话")

    def test_unavailable_emits_no_block(self):
        for name, reason in _all_reasons().items():
            field = toolevidence.unavailable_field(reason)
            self.assertEqual(field["status"], toolevidence.STATUS_UNAVAILABLE, name)
            self.assertIsNone(field["count"], name)   # None ≠ 0：不知道 ≠ 一次没调
            self.assertEqual(toolevidence.prompt_block(field), "",
                             f"{name}：降级时出块就会把「我没取到」写成「它没调」")

    def test_unavailable_leaves_the_judge_prompt_byte_identical(self):
        from strands_evals.evaluators.output_evaluator import OutputEvaluator
        from strands_evals.types.evaluation import EvaluationData

        ev = OutputEvaluator(name="policy_compliance", rubric="r", model="m")
        data = EvaluationData(input=CASE_INPUT, actual_output=CASE_OUTPUT)
        before = ev._build_prompt(data)
        field = toolevidence.unavailable_field(toolevidence.REASON_NOT_FOUND)
        self.assertEqual(
            toolevidence.attach_to_output_evaluators([ev], toolevidence.prompt_block(field)), 0)
        self.assertEqual(ev._build_prompt(data), before)

    def test_a_broken_field_never_fabricates_evidence(self):
        for junk in (None, {}, {"status": "captured"}, {"status": "?", "calls": [{"name": "x"}]}):
            self.assertNotIn("x", toolevidence.prompt_block(junk))

    def test_reason_text_is_never_the_judgement(self):
        """所有降级理由都在说「无法核实」，不许有一句能被读成「它没调」。"""
        for name, reason in _all_reasons().items():
            self.assertIn("不代表工具是否真被调用" if "缓存" not in reason else "重跑",
                          reason, name)


class TestNoCrossCaseBleed(unittest.TestCase):
    """一个用例的证据不许流到另一个用例。"""

    def test_grafted_span_keeps_the_real_id_and_the_synthetic_session_id(self):
        syn = _synthetic()
        toolevidence.graft(syn, _real_session())
        span = _tools_of(syn)[0]
        # span_id 保留真值 = 能回溯到那条真 span，也是跨用例不可能相等的钉子
        self.assertEqual(span.span_info.span_id, REAL_TOOL_SPAN_ID)
        self.assertEqual(span.span_info.session_id, SESSION_ID)
        hosts = _agents_of(syn)
        self.assertEqual(span.agent_span_id, hosts[-1].span_info.span_id)
        self.assertEqual(span.span_info.parent_span_id, hosts[-1].span_info.span_id)

    def test_grafting_one_session_leaves_another_untouched(self):
        other = _synthetic()
        toolevidence.graft(_synthetic(), _real_session())
        self.assertEqual(_tools_of(other), [])
        for host in _agents_of(other):
            self.assertEqual(list(host.available_tools or []), [])

    def test_graft_does_not_mutate_the_real_session(self):
        real = _real_session()
        before = [(sp.span_info.session_id, sp.agent_span_id) for sp in _tools_of(real)]
        toolevidence.graft(_synthetic(), real)
        self.assertEqual([(sp.span_info.session_id, sp.agent_span_id) for sp in _tools_of(real)],
                         before)

    def test_fetch_filters_by_the_session_id_we_asked_for(self):
        """取数边界：查询必须按 session.id 过滤，否则同一 traceId 下别的用例会混进来。

        现读实证：一个 runtime 的同一个 traceId 底下有 254 条 span 记录 —— 按 traceId
        取数会把整批调用当成这一次的证据。
        """
        seen = {}

        def fake_query(log_group, query, lookback_days):
            seen.update(log_group=log_group, query=query, lookback_days=lookback_days)
            return []

        original = tracesource._run_insights_query
        tracesource._run_insights_query = fake_query
        try:
            out = tracesource._fetch_central_session_records(
                "lg", SESSION_ID, 1, "", "")
        finally:
            tracesource._run_insights_query = original
        self.assertEqual(out, [])
        self.assertIn(f'attributes.session.id = "{SESSION_ID}"', seen["query"])
        self.assertNotIn("traceId", seen["query"])


class TestPersistedFieldStaysSmall(unittest.TestCase):
    """工具明细随 results 行进 DDB 的 RUN item：超预算会把实时轮次与对话挤掉。"""

    def test_call_detail_values_are_clipped(self):
        long_call = {"name": "t", "arguments": "a" * 5000, "result": "r" * 5000, "error": ""}
        field = toolevidence.captured_field([long_call])
        for c in field["calls"]:
            self.assertLessEqual(len(c["arguments"]),
                                 toolevidence.MAX_TOTAL_CHARS + len(toolevidence.VALUE_TRUNCATED_MARK))
        blob = len(json.dumps(field, ensure_ascii=False))
        self.assertLess(blob, 2 * toolevidence.MAX_TOTAL_CHARS)

    def test_count_and_names_stay_full_when_detail_is_budgeted(self):
        calls = [{"name": f"tool_{i}", "arguments": "a" * 900, "result": "r" * 900, "error": ""}
                 for i in range(60)]
        field = toolevidence.captured_field(calls)
        self.assertEqual(field["count"], 60, "列不下不许改写「调了多少次」这个事实")
        self.assertEqual(len(field["names"]), 60)
        self.assertLess(len(field["calls"]), 60)
        self.assertEqual(field["omitted"], 60 - len(field["calls"]))
        self.assertIn(f"另有 {field['omitted']} 条调用未列出",
                      toolevidence.prompt_block(field))

    def test_real_case_field_is_small(self):
        field = toolevidence.captured_field(toolevidence.graft(_synthetic(), _real_session()))
        self.assertLess(len(json.dumps(field, ensure_ascii=False)), 4000)


class TestSpanConfigResolution(unittest.TestCase):
    """log_group 必须一路传到取数点；漏了它这一整条链就静默退回「我没看到」。"""

    def test_runtime_log_group_is_enough(self):
        cfg = tracesource.resolve_span_config(
            {"agent_name": "a", "log_group": "/aws/bedrock-agentcore/runtimes/x-DEFAULT"})
        self.assertEqual(cfg["log_group"], "/aws/bedrock-agentcore/runtimes/x-DEFAULT")

    def test_no_log_group_means_no_span_source(self):
        self.assertIsNone(tracesource.resolve_span_config({"agent_name": "a", "log_group": ""}))

    def test_both_meta_builders_pass_log_group_down(self):
        """线上评估（main）与方案运行（planrun）两条 dispatch 都要带 log_group。

        方案运行走的是 planrun 那条；只修 main 等于没修航空这轮 A/B。

        ⚠️ 判据按 **AST 里的 dict 字面量**下，不搜 `"log_group"` 三个字：
        main.py 里 `log_group` 出现 5 处，只有 1 处是 agents_meta 构造
        （其余是 span_source 保存、会话刷新、列会话）。拿字符串搜，删掉那 1 处
        照样绿 —— 「没中」与「真没这道墙」在那种写法下无从分辨。
        这里认的是「每个把 runtime_arn 与 model 装进同一个 dict 的地方」：
        那个形状就是 agent 元信息，它必须同时带 log_group。
        """
        for name in ("main.py", "planrun.py"):
            metas = [d for d in _dict_literals(APP / name)
                     if {"runtime_arn", "model"} <= d]
            self.assertTrue(metas, f"{name} 里找不到 agent 元信息 dict（runtime_arn+model）")
            for keys in metas:
                self.assertIn("log_group", keys,
                              f"{name} 的 agent 元信息 dict 少了 log_group：{sorted(keys)}")

    def test_dataset_path_resolves_span_config_once_per_agent(self):
        """span 源解析必须是**按 agent** 一次，不是按用例一次。

        为什么在意：`resolve_span_config` 会读 DynamoDB 的 span_source 配置，
        挪进 run_one 就是 15 个用例读 15 次同样的东西。

        判据同样走 AST：`span_cfgs` 那个赋值的右值得是一个 dict 推导，
        且它 `for` 的正是 `agent_names`；再加一道反向钉 —— 整个模块里对
        `resolve_span_config` 的调用**恰好 1 处**，多出来的那处只能是
        per-case 路径。
        """
        import ast

        tree = ast.parse((APP / "testrun.py").read_text())
        comps = [node.value for node in ast.walk(tree)
                 if isinstance(node, ast.Assign)
                 and any(isinstance(t, ast.Name) and t.id == "span_cfgs" for t in node.targets)]
        self.assertEqual(len(comps), 1, "testrun.py 里没有（或不止一个）span_cfgs 赋值")
        comp = comps[0]
        self.assertIsInstance(comp, ast.DictComp, "span_cfgs 不是 dict 推导 ⇒ 可能改成了逐用例解析")
        iters = [g.iter.id for g in comp.generators if isinstance(g.iter, ast.Name)]
        self.assertEqual(iters, ["agent_names"], f"span_cfgs 不是按 agent_names 迭代：{iters}")
        self.assertIn("resolve_span_config", ast.dump(comp.value))

        calls = [n for n in ast.walk(tree)
                 if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                 and n.func.attr == "resolve_span_config"]
        self.assertEqual(len(calls), 1,
                         "resolve_span_config 被调了不止一次 ⇒ 有一处在按用例解析")


class _FakeLogs:
    """`logs` 客户端替身：按页吐 filter_log_events 结果，并记下每次的入参。"""

    def __init__(self, pages: list[dict]):
        self.pages, self.calls = pages, []

    def filter_log_events(self, **kw):
        self.calls.append(kw)
        return self.pages[min(len(self.calls) - 1, len(self.pages) - 1)]


def _events(records: list[dict]) -> list[dict]:
    return [{"message": json.dumps(r, ensure_ascii=False)} for r in records]


class TestLowLatencyReadPath(unittest.TestCase):
    """dataset 路径必须走 `filter_log_events`，不是 Logs Insights。

    现场计时（2026-08-26，同一次调用/同一 session/同一日志组，锚点 = agent 返回时刻）：
    `filter_log_events` 首次可见 **4.5 s**，Insights 首次可见 **115.7 s**（另一支探针
    ~78 s），而这条路径的全部预算是 `SPAN_FETCH_BACKOFF` 累计 **14 s** ⇒ 修复前每一例
    都必然超预算，再叠上熔断器就是现网那 30/30。摄取不是瓶颈（`@ingestionTime` 只慢
    3.3 s）—— 慢的是 Insights 的**查询可见性**，两者不同刑。
    """

    def _fake_logs(self, pages):
        import discovery
        fake = _FakeLogs(pages)
        original = discovery._logs_client
        discovery._logs_client = lambda: fake
        self.addCleanup(lambda: setattr(discovery, "_logs_client", original))
        return fake

    def test_dataset_fetch_reads_log_streams_not_insights(self):
        """判据下在**取数动作**上：谁被调了、谁没被调，两边都钉。"""
        fake = self._fake_logs([{"events": _events(_records())}])
        insights_calls = []
        original = tracesource._run_insights_query
        tracesource._run_insights_query = lambda *a, **kw: insights_calls.append(a) or []
        try:
            session, spans = tracesource.fetch_session(
                {"log_group": "lg", "scope_filter": "", "service_filter": ""},
                SESSION_ID, 1, True)
        finally:
            tracesource._run_insights_query = original
        self.assertTrue(_tools_of(session), "低延迟读法必须能产出同样的工具 span")
        self.assertEqual(len(spans), len(_records()))
        self.assertEqual(insights_calls, [], "低延迟路径不许再碰 Insights")
        self.assertEqual(len(fake.calls), 1)

    def test_filter_pattern_is_text_not_json_path(self):
        """`{$.attributes.session.id = …}` 这种 JSON 路径式**不许**出现。

        记录里的键字面量含点（`attributes["session.id"]`），「路径解析」与「键名带点」
        是同一段文字的两种读法 —— 猜错得到**恒 0**，而恒 0 与「span 还没到」在数据面
        完全同形，会被读成「这个 agent 没开观测」。文本匹配 + 本地精确核对没有歧义。
        """
        fake = self._fake_logs([{"events": []}])
        import discovery
        discovery.filter_span_records("lg", SESSION_ID, 1)
        pattern = fake.calls[0]["filterPattern"]
        self.assertEqual(pattern, f'"{SESSION_ID}"')
        self.assertNotIn("$.", pattern)

    def test_local_check_drops_another_session(self):
        """文本匹配只是缩小范围，**归属靠本地精确核对**。

        阴性对照：同一批字节里混进一条别的 session 的记录（真实成因：sid 是另一条的
        前缀，或它出现在别人的 message 正文里）。混进去就是把别的用例的工具调用
        当成本次证据 —— 比查不到坏得多。
        """
        import discovery
        other = json.loads(json.dumps(_records()[0]))
        other["attributes"]["session.id"] = SESSION_ID + "-somebody-else"
        self._fake_logs([{"events": _events(_records() + [other])}])
        got = discovery.filter_span_records("lg", SESSION_ID, 1)
        self.assertEqual(len(got), len(_records()))
        self.assertTrue(all(discovery._record_session_id(r) == SESSION_ID for r in got))

    def test_truncated_pages_raise_instead_of_returning_half(self):
        """页数用尽还有 nextToken ⇒ 报错，**不许**返回半份证据。

        截断过的工具清单与「它只调了这几次」在下游完全同形，而 graft 之后判官会把它
        当全量读 —— 那正是本缺陷换了个方向。
        """
        import discovery
        self._fake_logs([{"events": _events(_records()), "nextToken": "more"}])
        with self.assertRaises(RuntimeError):
            discovery.filter_span_records("lg", SESSION_ID, 1)

    def test_shared_span_group_falls_back_to_insights(self):
        """配了 scope/service 过滤 = 共享组（aws/spans）⇒ 仍走 Insights。

        那两个过滤器只有 Insights 应用得了；在本地复现要猜
        `resource.attributes.service.name` 的键形状，而猜错的方向是**把别的 agent 的
        span 当成本次证据**，比慢一个数量级坏得多。这里如实退回慢读法（与修复前同刑）。
        """
        import discovery
        fake = self._fake_logs([{"events": []}])
        seen = {}

        def fake_query(log_group, query, lookback_days):
            seen.update(log_group=log_group, query=query)
            return []

        original = tracesource._run_insights_query
        tracesource._run_insights_query = fake_query
        try:
            with self.assertRaises(Exception):     # 0 条 ⇒ SessionNotFoundError
                tracesource.fetch_session(
                    {"log_group": "aws/spans", "scope_filter": "",
                     "service_filter": "deepseek-harness"}, SESSION_ID, 1, True)
        finally:
            tracesource._run_insights_query = original
        self.assertIn("deepseek-harness", seen.get("query", ""))
        self.assertEqual(fake.calls, [], "共享组不许走本地过滤不了的低延迟读法")

    def test_observability_path_keeps_the_insights_read(self):
        """观测路径**不许**切到低延迟读法：它不在逐用例的 14 秒表上，且依赖那两个过滤器。

        判据按 AST 下在调用点上：`_central_evaluation_data` 走的是
        `fetch_session_with_origin`（回退逻辑在那里一份），而那个调用**不许**
        带第四个参数 —— `low_latency` 无论按位置还是按关键字传，都在这里被钉住。
        （2026-09-07 回退支持把取数从 `_fetch_central_session_records` 换成了
        `fetch_session_with_origin`；它默认 low_latency=False，所以「省略」就是
        「Insights」，但省略必须被验成省略，不能靠默认值背书。）
        """
        import ast

        tree = ast.parse((APP / "tracesource.py").read_text())
        fn = next(n for n in ast.walk(tree)
                  if isinstance(n, ast.FunctionDef) and n.name == "_central_evaluation_data")
        calls = [n for n in ast.walk(fn)
                 if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)]
        names = [n.func.id for n in calls]
        self.assertIn("fetch_session_with_origin", names)
        self.assertNotIn("filter_span_records", names)
        fetch = next(n for n in calls if n.func.id == "fetch_session_with_origin")
        self.assertLessEqual(len(fetch.args), 3,
                             "第四个位置参数就是 low_latency —— 观测路径不许传")
        self.assertNotIn("low_latency", [kw.arg for kw in fetch.keywords])


class TestCircuitBreakerTiers(unittest.TestCase):
    """三档退化与熔断决策：`testrun._span_degrade` 的真值表，逐格钉。"""

    def test_query_error_trips_immediately(self):
        reason, trip = testrun._span_degrade(missing=False, saw_spans=False, misses=1)
        self.assertEqual(reason, toolevidence.REASON_FETCH_FAILED)
        self.assertTrue(trip, "权限/限流/日志组不存在：重试不会变好")

    def test_incomplete_never_trips(self):
        """span 在、只是没写全 ⇒ 观测明明是通的，熔断器的前提为假。

        这就是现网 30/30 的成因：一次「遥测慢了一拍」被放大成整侧工具证据全瞎。
        """
        for misses in (0, 1, 99):
            reason, trip = testrun._span_degrade(missing=True, saw_spans=True, misses=misses)
            self.assertEqual(reason, toolevidence.REASON_INCOMPLETE)
            self.assertFalse(trip, f"misses={misses} 时把「读到一半」当成了「没有观测」")

    def test_not_found_needs_more_than_one_miss(self):
        self.assertGreaterEqual(testrun.SPAN_DEAD_AFTER_MISSES, 2,
                                "首例没中就熔断 = 现网 30/30 的那道放大器")
        for misses in range(1, testrun.SPAN_DEAD_AFTER_MISSES):
            self.assertFalse(testrun._span_degrade(True, False, misses)[1], f"misses={misses}")
        reason, trip = testrun._span_degrade(True, False, testrun.SPAN_DEAD_AFTER_MISSES)
        self.assertEqual(reason, toolevidence.REASON_NOT_FOUND)
        self.assertTrue(trip, "连着都查不到还不停手，就是每个用例白付一轮退避")

    def test_skipped_case_says_it_was_skipped(self):
        """熔断之后那些用例读得出「没去查」，而不是「查不到」。

        判据按 AST 下在 `_fetch_real_session` 里 `agent_name in span_dead` 那个分支上：
        它的 return 必须引 `REASON_SKIPPED`。搜字符串不行 —— `REASON_SKIPPED` 只要
        在文件里出现一次就能让 grep 变绿，哪怕它挂在别的分支上。
        """
        import ast

        tree = ast.parse((APP / "testrun.py").read_text())
        fn = next(n for n in ast.walk(tree)
                  if isinstance(n, ast.AsyncFunctionDef) and n.name == "_fetch_real_session")
        guards = [n for n in ast.walk(fn)
                  if isinstance(n, ast.If) and "span_dead" in ast.dump(n.test)]
        self.assertEqual(len(guards), 1, "找不到（或不止一处）熔断早退分支")
        returns = [n for n in ast.walk(guards[0]) if isinstance(n, ast.Return)]
        self.assertTrue(returns, "熔断分支没有 return ⇒ 它没在早退")
        self.assertIn("REASON_SKIPPED", ast.dump(returns[0]))
        self.assertNotIn("REASON_NOT_FOUND", ast.dump(returns[0]),
                         "「没去查」又被写成「查不到」了")


if __name__ == "__main__":
    unittest.main()
