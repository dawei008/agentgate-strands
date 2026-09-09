"""让判官看得见被测 Agent 这一次真调过哪些工具。

**缺陷**：dataset 环节把一次问答手工包装成 SDK 的 Session
（`testrun._synthetic_session`），而那个 Session 里 `available_tools=[]`、
一条 `ToolExecutionSpan` 都没有。于是「必须**实际调用** X 工具」这类断言在结构上
不可验，判官只能按「我没看到」判分。现网实证（2026-08-26 两份真 run）：
`tau-airline-16-uncovered-rule` 两侧都**真的**调了 `transfer_to_human_agents`，
两侧 `policy_compliance` 都判 **0.0**，理由是一句在数据面为假的话
（「没有实际工具调用记录」）。反方向的同一个根因见 `tau-airline-14`：工具如实
返回的事实被判成「凭空编造」。

**证据不缺，是平台没去取**：被测 runtime 自己的日志组里，`execute_tool` span 记录
自带工具名，入参与返回值就在同一条记录的 inline `events` 里
（`gen_ai.tool.message` / `gen_ai.choice`，由 `patches` 补进 `span_events` 后
`GenericGenAISessionMapper` 直接消费）。按我们传下去的 `session.id` 就能查到。

本模块三件事：
1. `graft` —— 把真 `ToolExecutionSpan` 与 `available_tools` **嫁接**到合成 Session；
2. `evidence_field` —— 给用例行产出三态标记（captured N>0 / captured 0 / unavailable）；
3. `prompt_block` + `attach_to_output_evaluators` —— 给结构上读不到 trajectory 的
   评估器（自定义 rubric 走的 `OutputEvaluator`）在 judge prompt 里插一段 `<ToolCalls>`。

⚠️ **为什么是嫁接不是替换**：mapper 的 `agent_response` 取的是
`str(event_attrs["message"])`，形如 `[{'text': '…'}]` 的字符串。拿真 Session 整体
替掉合成 Session，`correctness` 的 "Candidate Response:" 与 `helpfulness` 的
"# Assistant's Response:" 就从干净正文变成 JSON blob —— 那会动到与本缺陷无关的
分数。嫁接之后 judge prompt 的唯一差异是**多出来**的 `Tool call:` / `Tool result:`
行（SDK `evaluator.py:234-254` 渲染），正文逐字节不变。

⚠️ **不许静默退化**：取不到 span 时**不要**把 `available_tools` 留成空表然后照常判分
—— 那正是本缺陷的形状。走 `unavailable` 那一档，用例行上说得出为什么。
"""

import logging

logger = logging.getLogger("eval-anything")

# 判官读到的工具清单最多列这么多条：一次会话现读最多 15 条同名工具调用，
# 全量贴进 prompt 会把 rubric 挤到上下文尾部。超出部分如实说「另有 N 条未列出」。
MAX_LISTED_CALLS = 40
# 单个入参/返回值的字符上限。返回值可能是整张订单 JSON；判官要的是「调了什么、
# 返回了什么性质的结果」，不是全文。截断留痕（与 testrun.REASON_TRUNCATED_MARK
# 同一条道理：被砍过的与本来就短的在字节上同形）。
MAX_VALUE_CHARS = 600
# 单个用例的工具明细总字符预算。**为什么要有它**：工具明细随 results 行进 DDB 的
# RUN item（runstore.SAFE_BLOB_BYTES = 360KB，超了按 live_turns → conversation →
# cases → results 的顺序 shed）。按上限硬算，40 条 × (600+600) = 48KB/用例 ×15 个
# 用例 = 720KB，会把整份实时轮次与对话记录挤掉 —— 那是比「判官少看几条」更坏的退化。
# 6000 字符 × 15 = 90KB，叠在现读那轮 results 行 111KB 上仍在预算内。
MAX_TOTAL_CHARS = 6000
VALUE_TRUNCATED_MARK = "…（已截断）"

STATUS_CAPTURED = "captured"
STATUS_UNAVAILABLE = "unavailable"

# 降级原因（给人看）。判「有没有拿到证据」一律读 tool_evidence["status"]，
# **不要**去这些句子里搜措辞 —— 措辞会改，判据不该跟着坏。
REASON_NO_SPAN_SOURCE = (
    "被测 Agent 没有可读的观测数据源（既无 runtime 日志组，也未配置 span 源），"
    "无法核实它本次是否真的调用了工具。含「必须实际调用某工具」这类要求的用例，"
    "其判定只反映回复文字，不代表工具是否真被调用。")
REASON_NOT_FOUND = (
    "在被测 Agent 的观测数据里查不到本次会话的 span（可能是遥测尚未可查，"
    "或该 Agent 未开启观测），无法核实它本次是否真的调用了工具。含「必须实际调用"
    "某工具」这类要求的用例，其判定只反映回复文字，不代表工具是否真被调用。")
REASON_INCOMPLETE = (
    "本次会话的 span 查到了，但代表「已写全」的 invoke_agent 记录在取数预算内一直没出现"
    "（遥测还在路上），此时读到的工具清单可能只是实际调用的一部分——宁可不给，也不给"
    "半份。含「必须实际调用某工具」这类要求的用例，其判定只反映回复文字，"
    "不代表工具是否真被调用。")
REASON_SKIPPED = (
    "同一个 Agent 前面的用例连一条 span 都没查到（多半是没开观测或 span 源配置有误），"
    "为免每个用例都白等一轮退避，本用例**没有去查**工具证据。含「必须实际调用某工具」"
    "这类要求的用例，其判定只反映回复文字，不代表工具是否真被调用。")
REASON_FETCH_FAILED = (
    "读取被测 Agent 的观测数据时出错，无法核实它本次是否真的调用了工具。"
    "含「必须实际调用某工具」这类要求的用例，其判定只反映回复文字，"
    "不代表工具是否真被调用。")
REASON_CACHE_HIT = (
    "命中结果缓存，本次未真实调用被测 Agent ⇒ 不存在「本次会话」的工具记录。"
    "缓存里只保留了当时的回复文字。含「必须实际调用某工具」这类要求的用例，"
    "应在关闭缓存复用后重跑才能核实。")

# 由实际调用推得的工具清单在描述里说清出身：`available_tools` 的语义是
# 「Agent 能调的全部工具」，而这一份是「观测到被调过的」，是子集不是全集。
# 不写出来，判官会把它读成「这个 Agent 只有这些工具」。
DERIVED_TOOL_DESC = "本次会话遥测里观测到该工具被调用（由实际调用推得，不是 Agent 的完整工具清单）"


def _clip(value, limit: int = MAX_VALUE_CHARS) -> str:
    text = value if isinstance(value, str) else str(value)
    if len(text) <= limit:
        return text
    return text[:limit] + VALUE_TRUNCATED_MARK


def _start(span):
    return span.span_info.start_time


def _split_spans(session):
    """(agent_spans, tool_spans) across every trace of a Session, time-ordered."""
    from strands_evals.types.trace import AgentInvocationSpan, ToolExecutionSpan

    agents, tools = [], []
    for trace in session.traces:
        for sp in trace.spans:
            if isinstance(sp, AgentInvocationSpan):
                agents.append(sp)
            elif isinstance(sp, ToolExecutionSpan):
                tools.append(sp)
    agents.sort(key=_start)
    tools.sort(key=_start)
    return agents, tools


def is_complete(real_session) -> bool:
    """真 Session 的 span 是否已经写全 —— 据此决定「还要不要再等一轮」。

    判据 = **至少一个 `AgentInvocationSpan` 且它的 `agent_response` 非空**。
    为什么是它：`invoke_agent` 是整次调用最外层的 span，最后才结束、才入导出队列，
    所以它一露面，先结束的那些（chat / execute_tool）此前就已经排过队。这不是
    协议保证（多批次导出、部分失败都能破坏它），但它是这批记录里唯一能把
    「查到一半」与「查全了」分开的信号 —— 少了它，第一次 0 秒查询很可能只捞到
    3 次调用里的 1 次，而「1 次」与「真的只调了 1 次」在数据面完全同形。

    ⚠️ **不能拿「有工具 span」当判据**：真的一次都没调工具的用例会永远等不到，
    最后按 `unavailable` 降级 —— 而阴性对照要的恰恰是 `captured` + `count == 0`。
    ⚠️ **也不能拿「有无父的根 span」当判据**：从 runtime 日志组捞一整个会话时，
    **没有任何一条 span 是无父的**（夹具实证：连最外层的 `POST /invocations`
    都挂在一个不在本会话记录里的父 span 上）。那道判据结构上不可能为真。
    """
    from strands_evals.types.trace import AgentInvocationSpan

    return any(isinstance(sp, AgentInvocationSpan) and sp.agent_response
               for trace in real_session.traces for sp in trace.spans)


def _real_turns(real_session) -> list[list]:
    """真 Session 拆成「一次 agent 调用一格」的工具列表。

    ⚠️ **不按 traceId 分格**：被测 runtime 的 OTel trace 跨调用复用（现读实证：
    同一个 traceId 底下 254 条 span 记录、几十个 spanId），按它分格会把一次多轮
    对话的全部调用压成一格，或把别的调用混进来。归属优先取 span 自带的
    `agent_span_id`：mapper 自己不填它（`generic_gen_ai_session_mapper.py:314`
    构造 ToolExecutionSpan 时没这个参数），但 `Trace.model_post_init`
    （SDK `types/trace.py:162-206`）会从每个 agent span 沿 parent 链下行补上，
    兜不到再落到 root agent span —— 所以现读的真 Session 里它是**有值**的
    （夹具实证：工具 span `c38c5ab1…` → agent span `1cd074cf…`）。
    时间兜底只管那些 parent 链够不到任何 agent span 的散落工具 span：
    落到 start_time 不晚于该工具的最后一个 agent span。

    分格只影响 `session_history` 里的交错顺序，**不影响判官看不看得见**：
    SDK 的 `previous_turns` 是跨 trace 累积的，且一格的工具在这一格的
    `TraceLevelInput` 之前就被追加进去（`trace_extractor.py:48/74/81`）。
    """
    agents, tools = _split_spans(real_session)
    if not tools:
        return []
    if not agents:
        return [tools]
    buckets: list[list] = [[] for _ in agents]
    by_id = {a.span_info.span_id: i for i, a in enumerate(agents) if a.span_info.span_id}
    for ts in tools:
        slot = by_id.get(ts.agent_span_id)
        if slot is None:
            slot = 0
            for i, a in enumerate(agents):
                if _start(a) <= _start(ts):
                    slot = i
        buckets[slot].append(ts)
    return buckets


def _tool_configs(real_session, tool_spans: list):
    """`available_tools` for the grafted agent spans.

    Prefer what the runtime actually declared (`gen_ai.agent.tools` /
    `gen_ai.tool.definitions`, which the mapper turns into ToolConfig at
    `generic_gen_ai_session_mapper.py:324-335`). That is the live path for the
    airline runtime: its invoke_agent span declares all 12 tools, so the graft
    hands the judge the **full roster**, not just what got called.

    The fallback — synthesize a ToolConfig per observed call — covers runtimes
    that declare nothing. It is labelled DERIVED_TOOL_DESC precisely because it
    is a subset of the roster, and a judge told "these are the agent's tools"
    would otherwise read "it had no other option".
    """
    from strands_evals.types.trace import ToolConfig

    declared, seen = [], set()
    for sp in _split_spans(real_session)[0]:
        for cfg in sp.available_tools or []:
            if cfg.name and cfg.name not in seen:
                seen.add(cfg.name)
                declared.append(cfg)
    if declared:
        return declared
    for ts in tool_spans:
        name = ts.tool_call.name
        if name and name not in seen:
            seen.add(name)
            declared.append(ToolConfig(name=name, description=DERIVED_TOOL_DESC))
    return declared


def graft(session, real_session) -> list[dict]:
    """把真 Session 的工具证据嫁接到合成 `session` 上（原地改），返回工具明细。

    改两处，都只**增加**信息：
    - 每个 `AgentInvocationSpan` 的 `available_tools`（原本恒为空表）；
    - 每个 Trace 追加真 `ToolExecutionSpan`（原本一条都没有）。

    `user_prompt` / `agent_response` 一个字节不动 —— 见模块开头「为什么是嫁接」。

    合成 Trace 数与真 agent 调用数不必相等（多轮对话里 simulator 的每一问一答是
    一格合成 Trace，而被测 runtime 可能把它们记在同一个 trace 里），所以按位置
    对齐、溢出的并入最后一格。
    """
    from strands_evals.types.trace import AgentInvocationSpan, SpanInfo, ToolExecutionSpan

    turns = _real_turns(real_session)
    syn_traces = list(session.traces)
    if not syn_traces:
        return []

    flat = [ts for bucket in turns for ts in bucket]
    tool_cfgs = _tool_configs(real_session, flat)

    n = len(syn_traces)
    assigned: list[list] = [list(turns[i]) if i < len(turns) else [] for i in range(n)]
    for bucket in turns[n:]:                      # 溢出并入最后一格
        assigned[-1].extend(bucket)

    for trace, bucket in zip(syn_traces, assigned):
        hosts = [sp for sp in trace.spans if isinstance(sp, AgentInvocationSpan)]
        for host in hosts:
            host.available_tools = list(tool_cfgs)
        if not bucket or not hosts:
            continue
        host = hosts[-1]
        for ts in bucket:
            trace.spans.append(ToolExecutionSpan(
                # span_id 保留真值：它是回溯到那条真 span 的连接键，也是
                # 「不串用例」判据的钉子（跨用例的 span_id 不会相等）。
                span_info=SpanInfo(trace_id=trace.trace_id,
                                   span_id=ts.span_info.span_id,
                                   session_id=session.session_id,
                                   parent_span_id=host.span_info.span_id,
                                   start_time=ts.span_info.start_time,
                                   end_time=ts.span_info.end_time),
                tool_call=ts.tool_call,
                tool_result=ts.tool_result,
                agent_span_id=host.span_info.span_id,
                metadata=ts.metadata or {}))

    return [_call_detail(ts) for ts in flat]


def _call_detail(ts) -> dict:
    return {"name": ts.tool_call.name,
            "arguments": _clip(ts.tool_call.arguments),
            "result": _clip(ts.tool_result.content),
            "error": _clip(ts.tool_result.error, 300) if ts.tool_result.error else "",
            "span_id": ts.span_info.span_id or ""}


def captured_field(calls: list[dict]) -> dict:
    """用例行上的 `tool_evidence`：拿到了证据（可能是 0 条调用，那也是证据）。

    ⚠️ `count == 0` 与 `status == "unavailable"` 是**两件不同的事**：前者是
    「查得到，且确实一次没调」（阴性对照要靠它成立），后者是「查不到，不知道」。
    合成一个「没有工具」会让本缺陷换个形状活下来。

    `count` 与 `names` 是**全量**的（不受两道预算影响）：一个用例调了 50 次工具、
    明细只列得下 5 条时，「调了 50 次」这个事实本身不许因为省字数而变成 5 次。
    列不下的条数写进 `omitted`，判官与报告读者都看得见有东西没列出来。
    """
    listed, spent = [], 0
    for c in calls[:MAX_LISTED_CALLS]:
        cost = len(c.get("arguments", "")) + len(c.get("result", "")) + len(c.get("error", ""))
        if listed and spent + cost > MAX_TOTAL_CHARS:
            break
        listed.append(c)
        spent += cost
    field = {"status": STATUS_CAPTURED, "count": len(calls), "calls": listed,
             "names": sorted({c["name"] for c in calls if c["name"]})}
    if len(calls) > len(listed):
        field["omitted"] = len(calls) - len(listed)
    return field


def unavailable_field(reason: str) -> dict:
    return {"status": STATUS_UNAVAILABLE, "count": None, "reason": reason}


def prompt_block(field: dict) -> str:
    """判官 prompt 里那段 `<ToolCalls>`，或者空串（= prompt 与今天逐字节相同）。

    三态各自的形状：
    - captured 且 N>0：逐条列出工具名/入参/返回值 —— 这是判「有没有实际调用」的证据；
    - captured 且 N==0：明确说「遥测里一次都没调」—— 这是阴性对照要读到的话，
      判官据此判不满足是**正确**的；
    - unavailable：**不出块**。宁可让判官只看文字（与修复前同刑），也不能把
      「我没取到」写成「它没调」—— 那正是本缺陷。
    """
    if not isinstance(field, dict) or field.get("status") != STATUS_CAPTURED:
        return ""
    calls = field.get("calls") or []
    if not calls:
        return ("<ToolCalls>\n"
                "本次会话的运行遥测已成功读取，其中**没有任何工具调用记录**"
                "（不是读不到，是确实一次都没有调用）。\n"
                "</ToolCalls>")
    lines = ["<ToolCalls>",
             "以下是被测 Agent 本次会话中**实际发生**的工具调用，来自它自身的运行遥测"
             "（不是它在回复里的说法）。回复文字里没写出来的调用，也照样发生过。"]
    for i, c in enumerate(calls, 1):
        lines.append(f"{i}. {c.get('name', '?')}")
        lines.append(f"   入参: {c.get('arguments', '')}")
        if c.get("error"):
            lines.append(f"   报错: {c['error']}")
        lines.append(f"   返回: {c.get('result', '')}")
    if field.get("omitted"):
        lines.append(f"（另有 {field['omitted']} 条调用未列出）")
    lines.append("</ToolCalls>")
    return "\n".join(lines)


def _insert_block(prompt, block: str) -> str:
    """把 `<ToolCalls>` 插在 `<Rubric>` **之前**。

    位置不是随手挑的：`compose_test_prompt` 把 rubric 放在最末且不带换行
    （`case_prompt_template.py`），rubric 是判官的指令 —— 证据必须在指令之前出现，
    否则「按上述内容评分」指向的是一段还没出现的文字。找不到 `<Rubric>` 就追加，
    不抛错：prompt 模板是 SDK 的，改版了也不该让整个 run 挂掉。
    """
    if not isinstance(prompt, str):     # 第二道保险：非字符串原样放行
        return prompt
    at = prompt.rfind("<Rubric>")
    if at < 0:
        return prompt + "\n" + block
    return prompt[:at] + block + "\n" + prompt[at:]


def attach_to_output_evaluators(evaluators: list, block: str) -> int:
    """给 `OutputEvaluator` 实例注入工具证据块，返回打中的个数。

    **为什么只打 OutputEvaluator**：它的 `_build_prompt` 调
    `compose_test_prompt` 时**不传** `uses_trajectory`（现读
    `output_evaluator.py:56`），所以它的 prompt 只有 Input/Output/
    ExpectedOutput/Rubric —— 结构上读不到 trajectory，嫁接对它毫无作用。
    内置的 TRACE_LEVEL 评估器相反：`_format_trace_level_prompt` 自己就渲染
    `Tool call:` / `Tool result:` 行，嫁接完成后它们**已经**看得见，再插一遍
    就是同一份证据说两次。自定义 rubric（如 `policy_compliance`，不在
    `registry.EVALUATOR_CLASSES` 里）走的正是 `OutputEvaluator`。

    `MultimodalOutputEvaluator` 是 `OutputEvaluator` 的子类，显式排除：它的
    prompt 里挂着图像 payload，而且图像用例的工具证据另说。

    实例属性覆盖而非改类：`Evaluator.to_dict()` 跳过 `_` 前缀的键，所以挂一个
    `_build_prompt` 到实例上不会进序列化；而改类会污染同进程里别的 run。
    """
    from strands_evals.evaluators.multimodal_output_evaluator import MultimodalOutputEvaluator
    from strands_evals.evaluators.output_evaluator import OutputEvaluator

    if not block:
        return 0
    hit = 0
    for ev in evaluators:
        if not isinstance(ev, OutputEvaluator) or isinstance(ev, MultimodalOutputEvaluator):
            continue
        original = ev._build_prompt

        def patched(*a, _orig=original, **kw):
            try:
                return _insert_block(_orig(*a, **kw), block)
            except Exception:
                logger.exception("tool-evidence injection failed; judging without it")
                return _orig(*a, **kw)

        ev._build_prompt = patched
        hit += 1
    return hit
