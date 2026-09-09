"""线上评估（observe）的领域核心：评一个会话、汇总、生成智能解析。

为什么是独立模块（L1，simplify-r2）
  这三件事是纯领域逻辑 —— 只依赖 tracesource/metrics/transcript/diagnosis/
  judgellm/registry，不碰 payload、不碰 app 状态、不 yield 任何事件。它们此前住在
  `main.py`（AgentCore 的 action 派发层），于是方案运行侧要用同一套评估口径时只能
  在函数体里 `import main as main_mod` 反手向上伸手 —— 那是为了躲开 main→planrun
  的模块级 import 环。结果「errored 不算 0 分」这条口径的**定义点**住在派发层，
  planrun 的单测还得连带加载 BedrockAgentCoreApp 与 patches。

  现在 main（线上评估 action）与 planrun（方案的 observe 环节）同向下 import 本
  模块，环消失，口径只有一处定义。本模块**不许**反向 import main / planrun
  （tests/test_r2_core_layering.py 钉死）。
"""

import asyncio
import json
import logging

from strands_evals import Case, Experiment
from strands_evals.providers.exceptions import TraceProviderError

import diagnosis as diagnosis_mod
import judgellm
import metrics as metrics_mod
import tracesource
import transcript as transcript_mod
from registry import build_evaluators

logger = logging.getLogger("eval-anything")


# ---------- judge 的分档词 label（SDK EvaluationOutput.label）----------
#
# 这两个函数在 observe 与 testrun 里各存一份、**逐字同源**（两个模块不许互相
# import，见本文件模块 docstring 的层次纪律）；同源性由
# tests/test_verdict_label.py 的 BothModulesReadTheLabelTheSameWay 维持。


def _detailed_row(report, i: int) -> list:
    """report.detailed_results 的第 i 行。SDK 允许它比 cases 短 —— 缺位给空行，
    不是给一个越界异常。"""
    detailed = getattr(report, "detailed_results", None) or []
    return detailed[i] if i < len(detailed) else []


def _one_label(detailed) -> str | None:
    """恰好一条判定且它带 label -> label[:80]；多条或没有 -> None。

    label 只有在「这一行判定就是这一条」时才说得清它在给谁分档；一行里挤了多条
    EvaluationOutput 就说不清了，宁可如实缺数据（界面显「—」）也不挑一条当代表。
    """
    outs = list(detailed or [])
    if len(outs) != 1:
        return None
    out = outs[0]
    label = out.get("label") if isinstance(out, dict) else getattr(out, "label", None)
    if not label:
        return None
    return str(label).strip()[:80] or None


# ---------- no_content 会话的警示语：只说这一次观测到了什么 ----------
#
# 词汇照抄 dataset 环节的 `toolevidence.REASON_NOT_FOUND` / `REASON_INCOMPLETE`
# （那两句已经把「查不到本次会话的 span」与「span 查到了、但代表『已写全』的
# invoke_agent 记录没出现」分成两档），只把落点从「工具是否真被调用」换成
# 「有没有消息内容可评」。
#
# ⚠️ 这里**不许**再把成因写成「多半是没开
# `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`」：现网实证
# （2026-09-02，bi_metrics_assistant）那个环境变量**是设着的**，真实原因是该会话
# 只有 4 条 span、停在第一个 event-loop cycle，收尾的 invoke_agent 记录从没出现。
# 猜错的成因把用户指向一个不存在的问题 —— 比不给成因更坏。只有第三档
# （span 已写全、里面确实没有内容）才轮得到那个开关，且仍写成「可能」。
WARN_NOT_FOUND = (
    "在被测 Agent 的观测数据里查不到本次会话的 span（可能是遥测尚未可查，"
    "或该 Agent 未开启观测），因此拿不到任何消息内容。")
WARN_INCOMPLETE = (
    "本次会话的 span 查到了，但代表「已写全」的 invoke_agent 记录没有出现"
    "（遥测还在路上，或这次调用没跑到收尾），读到的这一段里没有消息内容。")
WARN_NO_MESSAGES = (
    "本次会话的 span 已写全（invoke_agent 记录在），但记录里没有消息内容 —— "
    "可能是被测 Agent 未开启消息内容采集"
    "（OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT），也可能是内容被过滤。")
WARN_UNDECIDABLE = (
    "会话枚举时数到过 span，但这次取数没有带回任何 span 记录，也没有消息内容"
    " —— 分不出是查不到 span 还是 span 没写全。")


def _is_invoke_agent(span) -> bool:
    """一条原始 span 记录是不是收尾的 `invoke_agent`。

    两种写法都认：Strands tracer 写进 span 名（现读夹具形态
    `invoke_agent Strands Agents`），ADOT / Transaction Search 那条路写在
    `gen_ai.operation.name`（`tracesource._adapt_central_span` 读的就是它）。

    ⚠️ 名字比 metrics.py 的 `startswith("invoke_agent")` 严一档（要么整名相等，
    要么后面跟一个空格）：那边多认几条只是少数几个 token 不计入，这边多认一条会
    把「没写全」误报成「已写全、多半是采集开关没开」—— 正是本次要修掉的那种猜。
    宁可反向错（把已写全的说成没写全），那句话不会把用户指向不存在的问题。
    """
    if not isinstance(span, dict):
        return False
    name = str(span.get("name") or "")
    attrs = span.get("attributes")
    return (name == "invoke_agent" or name.startswith("invoke_agent ")
            or (isinstance(attrs, dict)
                and attrs.get("gen_ai.operation.name") == "invoke_agent"))


def no_content_warning(raw_spans, span_count: int = 0) -> str:
    """没有消息内容时给这个会话挂的话。判据全在手上，**不新增 AWS 调用**。

    唯一的原始材料是 `tracesource.get_evaluation_data` 的第二个返回值（本次会话
    的原始 span 记录）+ 会话枚举给的 `span_count`：
      · 一条 span 都没有，枚举也没给条数  -> 查不到本次会话的 span；
      · 一条 span 都没有，枚举却数到过    -> 两个来源对不上，如实说分不出来；
      · 有 span、没有 invoke_agent 记录   -> span 没写全，读到的只是一截；
      · 有 span、也有 invoke_agent 记录   -> 写全了却没有内容，这时才谈采集开关。
    """
    spans = list(raw_spans or [])
    if not spans:
        return WARN_UNDECIDABLE if span_count else WARN_NOT_FOUND
    if any(_is_invoke_agent(s) for s in spans):
        return WARN_NO_MESSAGES
    return WARN_INCOMPLETE


async def evaluate_session(agent: dict, session: dict, evaluator_names, judge_model,
                           lookback_days: int, custom_rubrics=None, metric_keys=None,
                           prices=None, cache_store=None):
    """Evaluate one session; returns a session_result or session_error event."""
    session_id = session["session_id"]
    base = {
        "agent": agent["agent_name"],
        "session_id": session_id,
        "span_count": session["span_count"],
    }
    try:
        data, raw_spans = tracesource.get_evaluation_data(agent, session_id, lookback_days)
    except TraceProviderError as e:
        return {"event": "session_error", **base, "error": str(e)}
    except Exception as e:  # transport/credential failures aren't TraceProviderError
        logger.exception("trace pull failed for %s", session_id)
        return {"event": "session_error", **base, "error": str(e)}

    session_metrics = None
    if metric_keys:
        try:
            raw = metrics_mod.compute_session_metrics(raw_spans, prices or {})
            session_metrics = metrics_mod.filter_metrics(raw, metric_keys)
        except Exception:
            logger.exception("metrics computation failed for %s", session_id)

    transcript = None
    try:
        transcript = transcript_mod.build_transcript(data["trajectory"])
    except Exception:
        logger.exception("transcript build failed for %s", session_id)

    if not evaluator_names:  # metrics-only run: no judge calls
        output_preview = str(data.get("output", ""))[:300]
        return {"event": "session_result", **base, "output_preview": output_preview,
                "results": {}, "metrics": session_metrics, "transcript": transcript}

    if "interactions" in evaluator_names and transcript:
        # InteractionsEvaluator consumes a node-flow view of the timeline
        data = dict(data)
        data["interactions"] = transcript_mod.to_interactions(transcript)

    case = Case(name=session_id, input=session_id, session_id=session_id)
    evaluators = build_evaluators(evaluator_names, judge_model, custom_rubrics)
    experiment = Experiment(cases=[case], evaluators=evaluators)
    # With a cache store, a hit skips the trace-pull-and-map step entirely and
    # re-judges the recorded EvaluationData — the point of "只重跑评分".
    report = await experiment.run_evaluations_async(
        lambda _case: data, evaluation_data_store=cache_store)

    results = {}
    for i, row in enumerate(report.cases):
        reason = report.reasons[i]
        # The SDK turns an evaluator exception (judge throttling, transport error)
        # into score=0/test_pass=False with the message in `reason`. That is not a
        # real "0 分" judgment — flag it so it stays out of means and pass rates.
        # Two phrasings, both fabricated by the SDK: _worker's task-level except
        # writes the first, _run_evaluator's own except/RetryError the second.
        # Matching only one let throttled evaluators score a real-looking 0.
        errored = str(reason or "").lstrip().startswith(
            ("An error occurred:", "Evaluator error:"))
        results[row.get("evaluator", f"evaluator_{i}")] = {
            "score": None if errored else report.scores[i],
            "passed": None if errored else bool(report.test_passes[i]),
            "errored": errored,
            "reason": reason,
            # judge 自己给的分档词（EvaluationOutput.label）。只在「恰好一条判定
            # 且它有 label」时上盘，其余一律 None —— 见 _one_label。
            "label": None if errored else _one_label(_detailed_row(report, i)),
        }
    output_preview = str(data.get("output", ""))[:300]
    no_content = not output_preview.strip()
    if no_content:
        # The judge scores "" as 0 with "the output is empty", which is
        # indistinguishable from a genuinely bad answer. Unlike dataset mode
        # (where empty means the target was content-filtered), here it usually
        # means the trace never carried content — either way there is nothing to
        # grade, so keep these out of means and pass rates instead of only
        # printing a warning next to a real-looking 0. Done before diagnosis so
        # the detector isn't sent hunting a fault in an answer we never saw.
        for r in results.values():
            r["errored"] = True
            r["score"] = None
            r["passed"] = None
            # 分没了，给这个分起的名字也一起走：没看到答案时 judge 的分档词
            # 说的是空字符串，不是这个会话。
            r["label"] = None

    diagnosis = None
    if diagnosis_mod.needs_diagnosis(results):
        try:
            diagnosis = await asyncio.to_thread(
                diagnosis_mod.diagnose, data["trajectory"], judge_model)
        except Exception:
            logger.exception("diagnosis failed for %s", session_id)

    result = {"event": "session_result", **base, "output_preview": output_preview,
              "results": results, "metrics": session_metrics, "transcript": transcript,
              "diagnosis": diagnosis}
    if no_content:
        result["no_content"] = True
        result["warning"] = no_content_warning(raw_spans, base["span_count"])
    return result


# 建议节的「四要素形状 + 落点枚举」规格 —— observe / testrun / planrun 三处**逐字
# 同源**（无共享模块，提示词各自内嵌；同源性由 tests/test_planrun_prompt_actions.py
# 的 test_the_three_modules_carry_byte_identical_action_item_specs 维持）。
#
# 为什么必须枚举落点：**平台看不见被测 Agent 的源码**，只看得见 trace、数据集、
# 评估器与方案配置。judge 一旦写出「在 src/agent.py:42 改」这类落点，用户会去找一个
# 不存在的地方 —— 那比不给建议更坏。所以落点被关进五类真看得见的东西，且证据不足时
# 必须明说「证据不足以定位到具体落点」而不是猜一个。
#
# 四要素的三个粗体标签是**前端的解析契约**（web/src/pages/plan/ReportDrawer.tsx 的
# ADVICE_TARGET / ADVICE_HOW / ADVICE_IMPACT 把它渲染成建议卡）：改标签名等于把那套
# 渲染打回段落。认不出形状的老报告一律降级成段落渲染，不许显示空卡片。
ACTION_ITEM_SPEC = """【四要素形状（强制）】每条建议写成下面这个形状：一条 `- ` 列表项起头，三个粗体标签
逐字保留、顺序不变，不许改写成整段散文。

- **落点**：<从下面五类里选一类，带真名>
  **改法**：<可直接照做的一句或一小段>
  **影响**：<N 个会话/用例，附 1-2 条证据引用>

【落点只能从这五类里选（强制）】评估平台**看不见被测 Agent 的源码**，只看得见 trace、
数据集、评估器与方案配置。因此严禁给出任何代码路径、文件名、行号、函数名——
「在 src/agent.py:42 改」这类落点是幻觉，会让用户去找一个不存在的地方，比不给建议更坏。
可用的落点只有：
1. 系统提示词的某一段——仅当材料里真的捕获到了系统提示词时才可用，并引用其中原文片段
   定位；没捕获到就不许说「你的系统提示词第 3 段」。
2. 某个工具的 description——工具名必须是材料里出现过的真名，不许自造工具。
3. 数据集里某条用例——用 [case:用例名@Agent名] 指名（材料里没有数据集用例时本类不适用）。
4. 评估器配置 / 方案环节配置——如「本环节只配了 goal_success_rate，建议补 correctness」。
5. Agent 的行为面——写成「你的 Agent 在处理 X 类输入时……」，只描述观察到的行为与期望
   行为，不给任何路径、行号。
证据不足以落到上面任何一类时，必须原样写「证据不足以定位到具体落点」，随后只描述现象
与期望行为——不许猜。

【排序与合并】① 按影响面（受影响的会话/用例数）从大到小排；② 同一根因合并成一条，
不许拆成多条；③ 最多 5 条——说清最值得改的五件比列十件有用；④「改法」里能给出可直接
粘贴的文本时（提示词补一句、工具 description 改写），另起一行用 `> ` 引文块单独放，
前端会把它渲染成可复制的块。"""


ANALYSIS_SYSTEM_PROMPT = f"""你是 AI Agent 评估分析师。你会收到一份对已部署 Agent 的
自动化评估结果（LLM-as-a-Judge 打分 + 理由 + 带编号的会话时间线）。请用中文输出一份简明的解析报告。

【溯源引用（强制）】陈述涉及具体会话的结论时，必须内联引用：
- 指向整个会话：[session:完整会话ID]
- 指向会话中某条具体消息/工具调用：[session:完整会话ID#N]（N 为时间线编号）
例如：会话 [session:abc123#3] 的工具调用耗时 6 秒，是延迟主因。
不引用来源的具体结论视为不合格。

结构：

## 总体结论
一两句话给出整体判断。

## 分评估器解读
每个评估器一小段：分数含义、judge 理由中的关键信息。分数区间参考：≥0.7 良好，0.4-0.7 一般，<0.4 需关注。

## 成本与性能
若数据含运行指标（token/预估成本/延迟/LLM 与工具调用统计），解读之：成本大头在哪、延迟是否异常及主因（模型慢还是工具慢）、多 Agent 时对比性价比。成本一律称"预估"。无指标数据则省略本节。

## 异常与关注点
失败会话、分数异常（如 0 分）、延迟/成本异常、内容缺失警告等，指出具体会话和原因。没有则写"无"。
注意区分两种"没分数"：`errored: true`（score 为 null）表示**评估器自身执行失败**
（judge 限流/网络错误），既不是低分也不是高分，已不计入均分与通过率——只报告"有 N 次评估
未完成、需排查后重跑"，**严禁**把它解读为 Agent 表现差或表现好。
另一种是 `no_content: true`：该会话的 trace **没有消息内容**。无内容可判分，其评估器结果
已一并置为 errored、不计入统计。请指出"这些会话缺少内容、评估结论不成立"，并**照该会话
`warning` 字段的原话**说明为什么没有内容——`warning` 已按本次观测到的 span 分好档
（查不到 span / span 没写全 / 已写全但没有消息内容 / 分不出来），**严禁**自行替它补一个
成因（如断言某个环境变量没开）。**不得**说成 Agent 答得差或答得好。

## 建议（行动清单）
把前面几节的发现收成一份可直接照做的清单。若数据含 diagnosis（故障检测+根因分析）
结果，先按 fix_type 归并同类，再按下面的四要素形状逐条写；证据引用用
[session:完整会话ID] 或 [session:完整会话ID#N]。
若 diagnosis 为 clean:true（诊断已运行但未发现执行故障），先明确说明"低分源于
风格/表达而非执行故障"，再按同一形状给建议。完全无 diagnosis 时，依据 judge 理由
按同一形状给 1-3 条。本节是整份报告最有用的部分：总长写不下时优先压缩前面几节，
不要砍建议条数或省掉四要素中的任何一要素。

{ACTION_ITEM_SPEC}

要求：直接引用 judge 理由与 diagnosis 中的事实，不要编造；总长不超过 700 字。"""


async def generate_analysis(judge_model: str, evaluator_names: list[str],
                            report_agents: dict, session_details: list[dict]) -> str:
    sessions_for_judge = []
    for s in session_details[:30]:
        entry = {k: v for k, v in s.items() if k != "transcript"}
        if s.get("transcript"):
            entry["timeline"] = transcript_mod.transcript_for_judge(s["transcript"])
        # diagnosis (failures + fix recommendations) informs the action list
        sessions_for_judge.append(entry)
    payload = {
        "evaluators": evaluator_names,
        "agents_summary": report_agents,
        "sessions": sessions_for_judge,
    }
    resp = await asyncio.to_thread(
        judgellm.converse, judge_model, ANALYSIS_SYSTEM_PROMPT,
        json.dumps(payload, ensure_ascii=False), 8000)
    text = resp["text"]
    if not text.strip():
        # Sonnet 5 emits reasoningContent first; if maxTokens runs out there the
        # reply carries no text block and this would silently return "" -- an
        # empty 智能解析 section that looks like "the judge had nothing to say".
        raise RuntimeError(
            f"解析生成未返回文本（stopReason={resp['stop_reason']}），"
            "疑似 maxTokens 被推理占满。")
    return text


def summarize(session_events: list[dict]) -> dict:
    """Aggregate per-evaluator mean scores and pass rates across sessions."""
    by_evaluator: dict[str, list] = {}
    for ev in session_events:
        for name, r in ev.get("results", {}).items():
            by_evaluator.setdefault(name, []).append(r)
    summary = {}
    for name, rows in by_evaluator.items():
        # Errored rows carry score=None; they are not 0 分 and must not drag means
        # down or count against the pass rate.
        judged = [r for r in rows if not r.get("errored")]
        scored = [r["score"] for r in judged if isinstance(r["score"], (int, float))]
        summary[name] = {
            "mean_score": round(sum(scored) / len(scored), 4) if scored else None,
            "pass_rate": (round(sum(1 for r in judged if r["passed"]) / len(judged), 4)
                          if judged else None),
            "sessions": len(judged),
            "errored": len(rows) - len(judged),
        }
    return summary
