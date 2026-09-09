"""Dataset test runs: invoke agents with predefined cases and grade the outputs.

Run lifecycle (all state in DynamoDB, pk="RUN"):
  start_test_run  -> creates RUN item (status=running), processes cases in
                     batches within the same invocation, checkpointing progress
                     after every case so the UI can poll get_test_run.
  cost circuit    -> if actual estimated spend exceeds 3x the upfront estimate,
                     the run stops with status=halted_cost.

Test invocations use session ids 'evaltest-<run>-<case>-<rand>' so
observability-mode session listings can filter them out.
"""

import asyncio
import contextlib
import json
import logging
import os
import time
import uuid

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config as BotoConfig
from botocore.exceptions import ReadTimeoutError

import catalog
import pricing
import runstore
import toolevidence
import tracesource
from discovery import REGION
from registry import DEFAULT_JUDGE_MODEL, MULTIMODAL_EVALUATORS, build_evaluators

logger = logging.getLogger("eval-anything")

RUN_TTL_BATCH = 5          # concurrent agent invocations
COST_CIRCUIT_FACTOR = 3.0
AVG_TOKENS_PER_CALL = 3000   # rough estimate for upfront cost projection
JUDGE_TOKENS_PER_EVAL = 2500
# An image costs the judge roughly (w*h)/750 input tokens; ~1500 covers a
# 1000x1000 screenshot. Charged per mm_* evaluator, since each is its own call
# and each re-sends the image.
MM_IMAGE_TOKENS_PER_EVAL = 1500
MAX_TURNS_HARD_CAP = 10      # beyond this a conversation adds no eval signal

# 取工具证据（toolevidence）时的退避秒数。**重试是必需的不是保险**：现读实测
# 一条工具 span 事件时间 14:05:23.373、摄取时间 14:05:28.024（+4.65s），而「已摄取」
# 也不等于「Insights 查得到」。上界 0+2+4+8 = 14 秒；取不到就降级，不重判、不抛错。
SPAN_FETCH_BACKOFF = (0, 2, 4, 8)
# 熔断阈值：同一个 agent 连着这么多个用例**一条 span 都没查到**才停止再试。
# **为什么不是 1**：现网 30/30 全灭就是「首例没中就熔断」造出来的 —— 一次超预算被
# 放大成整侧失败。代价不对称：多试一例最坏是给这个 agent 再付一轮 14 秒退避，
# 而熔错一次就是整侧工具证据全瞎。「读到一半」不计入（那说明观测是通的）。
SPAN_DEAD_AFTER_MISSES = 2

# judge 理由的字符上限。**为什么要有上限**：reason 随 results 行进 DDB 的 RUN item
# （runstore.SAFE_BLOB_BYTES = 360KB），超了就 shed 掉整批明细。
# **为什么 600 不够**（2026-08-26 拿航空 15 用例那两轮真报告现算）：90 条 reason 里
# **26 条正好 600 字符** = 全被砍，而且砍在 judge 说出扣分点**之前** —— 13/15 条
# helpfulness 判 0.833 的理由通篇是好话，扣的那 0.167 说不出为什么，
# 「照 judge 的理由改 prompt」这条路直接断在这里。
# **为什么是 1800**：同一批现算，reason 中位数 370 字符、未被砍的最长 518；把 13 条
# 到顶的全按 1800 算，那轮 results 行 65.7KB → 111KB，仍在 360KB 之内。
REASON_MAX_CHARS = 1800
# 截断必须留痕。被砍过的理由与「judge 本来就只说了这么多」在字节上**完全同形**，
# 读者会把半句话读成完整结论 —— 上面那 26 条就是这么被读成「全是好话」的。
# 标记给人看；reason_truncated / reason_chars 给程序看（措辞将来改了判据不跟着坏，
# 且 reason_chars 说得出**丢了多少**）。判「有没有被截断」一律读 reason_truncated，
# 别去 reason 里搜这句话。
REASON_TRUNCATED_MARK = "……（理由过长，已截断）"

# 用户主动停止的终态。**三个模块同一个词**：planrun.STOP_STATUS 与
# redteam.STOP_STATUS 都取这里（导入方向 planrun → testrun ← redteam，这里是
# 三者唯一的公共下游），前端 web/src/lib/scoring.ts 的 STATUS_LABEL 有对应中文
# 条目「已停止」。各写一个字面量迟早漂移成两个词，界面上就会露出英文枚举。
STOP_STATUS = "stopped"

# ---------- 只用上报数据评估（ADR-0019 批 1）：用例条目的 trace 字段 ----------
#
# 评估计划开了 trace_required 时，每个用例 / 攻击会话跑完后按会话 id 去 aws/spans 核对
# **Agent 侧、带对话内容**的 span（tracesource.check_agent_traces；核对与标记由 planrun
# 在环节结束后统一做，本文件只放形状与算术，红队侧共用同一份）。缺则该条标 no_trace：
# 不打分、不算 0 分、不入 pass_rate / 评估器统计分母、单列计数 —— 与 blank_output /
# error_output 同刑（空响应不是 0 分）。契约见 docs/payload-contract.md「只用上报数据评估」。
TRACE_OK = "ok"
TRACE_NO_TRACE = "no_trace"
# no_trace 原因（键名，不是给人看的句子；前端按键名配文案）：
TRACE_REASON_NO_SPAN = "no_span"              # 配置的 span 组（含回退组）里一条 Agent 侧 span 都没有
TRACE_REASON_NO_CONTENT = "no_content"        # 有 span 但没有 gen_ai 对话内容（只有元数据）
TRACE_REASON_NO_SPAN_SOURCE = "no_span_source"  # 没有可读的 span 组（无 runtime 日志组也无 span 源 / 组不存在）
TRACE_REASON_FETCH_ERROR = "fetch_error"      # 查询本身出错（限流 / 超时 / Failed）
# 第五种：平台自己这次调用的 trace **未被采样**。ADOT 默认 parentbased_always_on，平台调
# Agent 时带 traceparent，平台侧未采样 ⇒ 被测 Agent 直接丢弃整条 trace —— 查无 span 不是
# Agent 没接观测，是采样吃掉了（2026-09-07 实测：evalanything 约 85% 未采样，账号 X-Ray 5%
# 规则）。判据是平台当前 span context 的 sampled 位（planrun._current_trace_sampled）；
# 拿不到（无 OTel / 无有效 span）就不下这个结论，照 no_span。
TRACE_REASON_UNSAMPLED = "unsampled"
# run 级降级状态（run["trace_status"]）：有一例缺就降级；全部缺 ⇒ no_trace（评估器一列不出分）。
RUN_TRACE_OK = "ok"
RUN_TRACE_DEGRADED = "degraded_no_trace"
RUN_TRACE_NONE = "no_trace"
# ---------- 批 2：评分输入的出身（entry["scored_from"]） ----------
# trace_required 开着时，回归用例的评分输入不再是 InvokeAgentRuntime 返回的文本，而是
# 该会话 Agent 侧 span 还原出的对话（tracesource.scoring_input_from_session）。判过分的行
# 写 scored_from = "trace"，entry["output"] 换成 trace 还原的最终回复，原返回挪到
# entry["output_response"] 供对照，response_matches_trace 记两者（归一空白后）是否一致。
# "response" 是枚举里保留给「按返回评分」的值：批 2 里开着开关的行**不会**出现它（没有回退
# 到返回的路径 —— 用户的决定是 CloudWatch 里没有就不评估）；关着开关的行一个键都不多。
SCORED_FROM_TRACE = "trace"
SCORED_FROM_RESPONSE = "response"
# 写进 trace 字段的 span id 上限：每条 16 字符，40 条 ≈ 1KB / 用例，在 RUN item 预算内。
TRACE_SPAN_IDS_MAX = 40


def same_text(a: str, b: str) -> bool:
    """返回文本与 trace 还原的最终回复是否「一致」：只归一空白（连续空白折成一个、
    两端去掉），不做别的宽容 —— 差一个字也算不一致，报告页据此在格 title 上点明。"""
    norm = lambda s: " ".join(str(s or "").split())  # noqa: E731
    return norm(a) == norm(b)


def trace_field(session_ids: list[str], checks: dict[str, dict],
                error_reason: str | None = None, sampled: bool | None = None,
                sources: list[str] | None = None) -> dict:
    """一条结果行的 `trace` 字段：{status, reason, spans, sources}。

    session_ids：这一行落在哪些会话上（回归用例恒一个；红队攻击每次 backtrack 轮换一个，
    可能为空 —— 命中缓存 / 攻击未送达 / 话术撞车，redteam._row_session_ids）。
    checks：tracesource.check_agent_traces 的结果（查无的会话不在里面）。
    error_reason：查询整体失败时的原因（no_span_source / fetch_error），只落在**没查到**
    的会话上 —— 查询失败前已查到内容的会话照常算 ok。
    sampled：平台这次调用的 trace 有没有被采样；False 时查无的会话标 unsampled 而不是
    no_span（两者下一步动作不同：一个改采样器，一个改 Agent 的观测接法）。None = 不知道。
    读数只有一处（current_trace_sampled）：回归行在 run_one 调用前逐例读并写进
    `trace.sampled`；apply_trace_check 优先用行上那份，没有（红队行 / 缓存命中）才用
    环节级传进来的这个参数。
    sources：查过哪些日志组（主 span 组 + 回退组），写进字段让「两处都没有」说得出来。
    多会话的行：全部会话都有内容 span 才算 ok；reason 取第一个不 ok 的会话的原因；
    spans 是各会话 Agent 侧 span 数之和。
    """
    missing_reason = error_reason or (TRACE_REASON_UNSAMPLED if sampled is False
                                      else TRACE_REASON_NO_SPAN)
    spans = 0
    reason: str | None = None
    for sid in session_ids:
        hit = checks.get(sid)
        if hit is None:
            reason = reason or missing_reason
            continue
        spans += int(hit.get("spans") or 0)
        if not hit.get("content_spans"):
            reason = reason or TRACE_REASON_NO_CONTENT
    if not session_ids:
        reason = missing_reason
    status = TRACE_OK if reason is None else TRACE_NO_TRACE
    return {"status": status, "reason": reason, "spans": spans, "sources": list(sources or [])}


def is_no_trace(row: dict) -> bool:
    """这一行是否被标成 no_trace（分母排除的唯一判据 —— 别去读 reason）。"""
    trace = row.get("trace")
    return isinstance(trace, dict) and trace.get("status") == TRACE_NO_TRACE


def apply_trace_check(run: dict, rows: list[dict], sid_of, checks: dict[str, dict],
                      error_reason: str | None = None, sampled: bool | None = None,
                      sources: list[str] | None = None) -> dict:
    """给每条结果行写 `trace`，并在 run 上写 `trace_summary` / `trace_status`。

    sid_of(row) -> list[str]：这一行的会话 id 列表（回归 / 红队各自的读法由调用方给）。
    返回 trace_summary = {"required": True, "ok": n, "no_trace": m}。
    全部缺（rows 非空且 m == len(rows)）⇒ run["trace_status"] = "no_trace"，且 run 自身
    status 若仍是 completed 则改成 no_trace（停止 / 熔断 / 失败的状态优先，不覆盖）。
    """
    for row in rows:
        # 行上可能已有 run_one 调用前读的 `trace.sampled`（批 span-source-fallback：每例
        # 调用那一刻的采样位，比环节级读一次更贴这一例）：它优先当这一行的 sampled，
        # 且键原样保留 —— 核对只补 status / reason / spans / sources，不抹掉读数。
        prior = row.get("trace") if isinstance(row.get("trace"), dict) else {}
        row_sampled = prior.get("sampled")
        eff_sampled = row_sampled if isinstance(row_sampled, bool) else sampled
        row["trace"] = {**prior, **trace_field(list(sid_of(row) or []), checks, error_reason,
                                               eff_sampled, sources)}
    return summarize_trace(run, rows)


def summarize_trace(run: dict, rows: list[dict]) -> dict:
    """按行上已有的 `trace` 字段重算 run 的 `trace_summary` / `trace_status`（apply_trace_check
    的尾段；批 2 的评分阶段把「核对有内容、却还原不出最终回复」的行改成 no_content 之后
    再调一次，让汇总与行一致）。全部缺 ⇒ run 状态 completed 改 no_trace（其余状态不覆盖）。"""
    no = sum(1 for row in rows if is_no_trace(row))
    ok = len(rows) - no
    summary = {"required": True, "ok": ok, "no_trace": no}
    run["trace_summary"] = summary
    if rows and no == len(rows):
        run["trace_status"] = RUN_TRACE_NONE
        if run.get("status") == "completed":
            run["status"] = RUN_TRACE_NONE
    elif no:
        run["trace_status"] = RUN_TRACE_DEGRADED
    else:
        run["trace_status"] = RUN_TRACE_OK
    return summary


def _span_degrade(missing: bool, saw_spans: bool, misses: int) -> tuple[str, bool]:
    """取不到工具证据时的（降级原因, 要不要熔断这个 agent）。

    抽成模块级纯函数是为了**可单测**：三档退化在旧代码里全都塌成同一个
    `REASON_NOT_FOUND`，而它们的下一步动作互不相同 ——
    - `FETCH_FAILED`（查询本身出错：权限/限流/日志组不存在）：重试不会变好 ⇒ 立即熔断；
    - `INCOMPLETE`（span 在，但 invoke_agent 没露面）：观测明明是通的 ⇒ **不许**熔断，
      否则「遥测慢了一拍」会被放大成整侧工具证据全瞎（现网 30/30 就是这个形状）；
    - `NOT_FOUND`（一条都没查到）：连着 SPAN_DEAD_AFTER_MISSES 例都这样才熔断。
    """
    if not missing:
        return toolevidence.REASON_FETCH_FAILED, True
    if saw_spans:
        return toolevidence.REASON_INCOMPLETE, False
    return toolevidence.REASON_NOT_FOUND, misses >= SPAN_DEAD_AFTER_MISSES


def _stop_note(completed_cases: int, total_cases: int) -> str:
    """用户主动停止的用户可见说明（与 _cost_circuit_note 同一条道理：status
    单独一个人说不了话）。它落在 run["error"] 上，经 planrun 环节返回 →
    _stage_summary → DDB 一路带到方案页与报告抽屉。

    停止与熔断必须能分辨：熔断说「已自动熔断中止」（用户该去调预估/预算），
    停止说「已按用户请求停止」（用户自己刚做的动作）。混成一句话就会把人
    送错方向。
    """
    return (f"已按用户请求停止：{total_cases} 个用例中已完成 {completed_cases} 个，"
            "其余未执行（已完成用例的结果与已花费用照常保留）")


def _agent_timeout_note(exc: Exception) -> str:
    """调用被测 Agent 超时的行级说明（与 _stop_note/_cost_circuit_note 同族：
    裸异常串单独说不了话）。

    裸 ReadTimeoutError 的 str() 是 `Read timeout on endpoint URL: "None"` ——
    用户读到的是一个既不知道墙有多高、也不知道该拿这行怎么办的英文串。这里把
    三件事说全：超时墙是多少秒、这一行按什么口径计（仍是调用失败档，不进判分
    —— **不改判定口径**，只换话术）、原始异常附后供排查。
    """
    return (f"调用被测 Agent 超时（{AGENT_READ_TIMEOUT_S}s 内未完成）——"
            f"用例仍计为调用失败，不计入本环节均分与通过率。原始异常：{exc}")


def _cost_circuit_note(actual_cost: float, budget: float) -> str:
    """成本熔断的用户可见说明（与 redteam.py 的熔断文案逐字同形）。

    这条文案不是装饰：halted_cost 此前只是一个 status，前端 lib/scoring.ts 既不
    认识它、也拿不到任何原因文本，于是「超预算被平台掐掉」显示成中性的
    「完成 · 无可评估数据」——钱烧到阈值，界面一个字都不说（P1）。
    落在 run["error"] 上，经 planrun 环节返回 → _stage_summary → DDB
    stage_summaries 一路带到方案页/大屏/报告抽屉。
    """
    return (f"实际成本 ${actual_cost} 超过预估的 "
            f"{COST_CIRCUIT_FACTOR}x（${round(budget, 4)}），已自动熔断中止")


def _case_turns(case: dict) -> int:
    """1 for single-shot cases; capped max_turns for simulator-driven ones."""
    if not case.get("task_description"):
        return 1
    return min(int(case.get("max_turns", 5) or 5), MAX_TURNS_HARD_CAP)


def _table():
    # 复用 catalog 的缓存单例（plan.py:39 / planrun.py:45 同队形）：同表同区，而
    # RUN / RTRUN 的每次 checkpoint 都经这里 —— 每调 boto3.resource(...).Table(...)
    # 重建要连 service JSON 一起再解析一遍。
    return catalog.get_table()


# 被测 Agent 的读超时（秒）。裸 client 的 botocore 默认值是 60s，它会**杀死合法
# 慢用例**：现网 bi-metrics 方案两轮里 66s+ 的真用例每轮必挂（error=`Read timeout
# on endpoint URL: "None"`、duration_s≈66.5 —— 正是 60s 默认值的签名）。被测 Agent
# 的单用例合法耗时可到几分钟，所以取 300；不取 900（judgellm 的上界）—— 卡死的
# 用例会把整环节拖住 15 分钟 × 并发数，300 是「容纳合法慢」与「止损卡死」的折中。
AGENT_READ_TIMEOUT_S = 300

# 惰性单例（同 runstore._s3 / catalog.get_table 模式）：这是**每一次**被测 Agent
# 调用的必经之路 —— 回归每用例每轮、红队每攻击轮（redteam.py 经 invoke_agent）。
# 每调新建就是每调新建连接池 + 重做一次 TLS 握手（各 50-100ms），20 攻击 × 10-16
# 轮 = 200+ 次，全花在拖住攻击对话的那个 worker 线程上。boto3 client 线程安全，
# 红队多 worker 共用一个实例是安全的。
_agent_client_cached = None


def _agent_client():
    global _agent_client_cached
    if _agent_client_cached is None:
        _agent_client_cached = boto3.client(
            "bedrock-agentcore", region_name=REGION,
            # retries 必须显式钉成「总共 1 次尝试」：对被测 Agent 的重试 = 重跑
            # 用例 = 双倍费用 + 同一 runtimeSessionId 复用出脏会话（「被杀不重发」
            # 同族纪律）。boto 默认 legacy 模式会对部分错误自动重试，必须关掉；
            # 用 total_max_attempts 不用 max_attempts —— 后者在 legacy/standard
            # 两种模式下语义不同，前者在两种模式下都是「含首发的总次数」。
            config=BotoConfig(read_timeout=AGENT_READ_TIMEOUT_S,
                              connect_timeout=10,
                              retries={"total_max_attempts": 1}))
    return _agent_client_cached


def estimate_test_run(dataset: dict, agent_names: list[str], evaluator_names: list[str],
                      agents_meta: dict) -> dict:
    """Upfront cost/scale estimate shown before the user confirms.

    Multi-turn (simulator) cases cost max_turns agent calls plus max_turns
    simulated-user calls (judge-priced); conversations may stop earlier.
    """
    cases = dataset["cases"]
    n_cases = len(cases)
    total_turns = sum(_case_turns(c) for c in cases)
    multi_cases = sum(1 for c in cases if c.get("task_description"))
    n_invocations = total_turns * len(agent_names)
    n_sim_calls = sum(_case_turns(c) for c in cases if c.get("task_description")) * len(agent_names)
    n_judge_calls = n_cases * len(agent_names) * max(len(evaluator_names), 1)
    # Image tokens ride on top of the text-only judge estimate: only cases that
    # actually carry an image, times the mm_* evaluators selected.
    n_mm_evals = sum(1 for n in evaluator_names if n in MULTIMODAL_EVALUATORS)
    n_image_evals = (sum(1 for c in cases if case_image_key(c))
                     * len(agent_names) * n_mm_evals)

    prices = pricing.get_prices()["prices"]
    agent_cost = 0.0
    unpriced = []
    for name in agent_names:
        model = agents_meta.get(name, {}).get("model") or ""
        p = pricing.lookup_price(model, prices) if model else None
        if p:
            agent_cost += total_turns * (AVG_TOKENS_PER_CALL / 1000) * (p["input"] * 0.8 + p["output"] * 0.2)
        else:
            unpriced.append(name)
    judge_price, _ = pricing.judge_price(DEFAULT_JUDGE_MODEL, prices)
    judge_cost = (n_judge_calls + n_sim_calls) * (JUDGE_TOKENS_PER_EVAL / 1000) \
        * (judge_price["input"] * 0.9 + judge_price["output"] * 0.1)
    # Images are input-only tokens — no output-share split.
    judge_cost += n_image_evals * (MM_IMAGE_TOKENS_PER_EVAL / 1000) * judge_price["input"]

    return {
        "cases": n_cases,
        "multi_turn_cases": multi_cases,
        "agents": len(agent_names),
        "agent_invocations": n_invocations,
        "simulator_calls": n_sim_calls,
        "judge_calls": n_judge_calls,
        "image_judge_calls": n_image_evals,
        "estimated_cost_usd": round(agent_cost + judge_cost, 4),
        "unpriced_agents": unpriced,
        # 被测 Agent 无价 ⇒ 这个数只含 judge 侧（口径同运行侧 cost_is_partial）。
        "cost_is_partial": bool(unpriced),
        "note": "预估值：按平均 token 用量与最大轮数粗算；多轮对话达成目标会提前结束，实际以运行为准",
    }


def _judge_cost(entry: dict, judge_rate: dict) -> float:
    """一个用例**真实发生**的 judge 花费（token 系数与 estimate_test_run 同一套）。

    此前实际记账里根本没有 judge 这一项：只累加被测 Agent 侧。一次 40 个 judge
    调用的运行因此报 actual_cost_usd=0.0，而预估的 $0.42 里 100% 是 judge 费用
    ⇒ 熔断判据（实际 > 预估×3）永不为真（P1，2026-08-24 生产实测）。

    计入的调用与预估**建模的同一族**：产出了判定的每个评估器一次、多轮用例的
    模拟用户每轮一次、带图用例的 mm_* 评估器再加一份图片 input token。自动诊断
    与 run 级解析同样是 judge 调用，但预估侧也没建模它们 —— 熔断比的是实际与
    预估，两侧建模的调用集必须一致，否则一次正常运行也能被判成超支。
    errored 的判定照样计：调用发出去了，token 已经花了。
    缓存命中**要**计 judge（命中省掉的是被测 Agent 调用，记录下来的输出仍要重新
    判分，那正是 reuse 模式的用途），但不再计模拟用户 —— 对话是录好的。
    """
    verdicts = entry.get("results") or {}
    n_sim = 0 if entry.get("from_cache") else int(entry.get("n_turns") or 0)
    cost = ((len(verdicts) + n_sim) * (JUDGE_TOKENS_PER_EVAL / 1000)
            * (judge_rate["input"] * 0.9 + judge_rate["output"] * 0.1))
    if entry.get("image_key"):
        n_image = sum(1 for n in verdicts if n in MULTIMODAL_EVALUATORS)
        cost += n_image * (MM_IMAGE_TOKENS_PER_EVAL / 1000) * judge_rate["input"]
    return cost


# ---------- 被测 Agent 的传输层（公开件：probe.py / redteam.py 同用）----------
#
# 「怎么调被测 Agent」是回归 / 红队 / 连通性探测三个域共用的下层机制，不是回归域
# 的私事：probe.py 用 render_payload → invoke_agent_raw → join_sse →
# walk_response_path 复刻正式 run 的每一步（所以探测报的「取到的最终文本」按构造
# 就是真 run 会提取的那一段），redteam.py 的 AgentCoreTargetSession 用 invoke_agent
# 把攻击话术送上同一条线路。这几个名字此前带下划线，于是两个模块跨边界伸手拿
# 「私有件」——名字是私有的、事实是公共的。公名让契约与调用现实一致。


def render_payload(template: str, case_input: str) -> str:
    return template.replace("{input}", json.dumps(case_input, ensure_ascii=False)[1:-1])


def join_sse(body: str) -> str:
    """Collapse an SSE body's data: lines into one text; pass through otherwise.

    Split out of _extract_response so the invoke-template probe (probe.py) can
    reuse the exact same joining rule on the raw body it needs to show the user.
    """
    if not (body.lstrip().startswith("data:") or "\ndata:" in body):
        return body
    text_parts = []
    for line in body.splitlines():
        if line.startswith("data:"):
            chunk = line[5:].strip()
            try:
                val = json.loads(chunk)
                text_parts.append(val if isinstance(val, str) else json.dumps(val, ensure_ascii=False))
            except json.JSONDecodeError:
                text_parts.append(chunk)
    return "".join(text_parts)


def walk_response_path(obj, response_path: str):
    """The dot/index path rule runs use: 'output.message.0.text'. Raises on miss.

    Shared with probe.py so what the probe reports as "取到的最终文本" is by
    construction what a real run would extract."""
    for part in response_path.split("."):
        obj = obj[int(part)] if part.isdigit() else obj[part]
    return obj


def _extract_response(body: str, response_path: str) -> str:
    """Extract agent answer: SSE data lines are joined; JSON path when given."""
    text = join_sse(body)
    if response_path:
        try:
            return str(walk_response_path(json.loads(text), response_path))
        except Exception:
            return text
    return text


@contextlib.contextmanager
def _target_session_baggage(session_id: str):
    """Make the callee record OUR session id, not this service's.

    This service runs under the ADOT distro, which copies its own `session.id`
    into OTel baggage; botocore instrumentation injects that baggage into every
    outbound AWS request; the target agent's distro extracts it and stamps it on
    its spans IN PLACE OF the runtimeSessionId we passed. Result: the target's
    trace is labelled with the *eval service's* session id, the 'evaltest-'
    prefix never reaches CloudWatch, and test/attack traffic shows up in
    observability listings as if it were real user sessions.

    The fix has to happen in the OTel context, NOT as an `invoke_agent_runtime`
    baggage= parameter: `baggage` is a modelled header, so SigV4 signs it and
    the instrumentation then overwrites it post-signing -> AccessDeniedException
    "request signature does not match". Setting it here means the value the
    instrumentation injects is already the one we want.

    No-ops if OTel isn't installed (local runs), which is harmless: without the
    distro there is no ambient baggage to override.
    """
    try:
        from opentelemetry import baggage, context
    except ImportError:
        yield
        return
    token = context.attach(baggage.set_baggage("session.id", session_id))
    try:
        yield
    finally:
        context.detach(token)


def current_trace_sampled() -> bool | None:
    """本进程当前 span context 的采样位；读不到返回 None。

    **为什么这个数要落进每例结果**：被测 Agent 的 ADOT 默认采样器是
    `parentbased_always_on` —— 采不采样跟着**调用方**走。我们调它时 botocore
    instrumentation 会注入 traceparent，而本服务自己受账号 X-Ray 默认 5% 规则约束
    ⇒ 约 85% 的调用带着 sampled=0 的父到达，被测 Agent 于是把整条 trace 丢掉
    （现网 2026-09-07：fable5 当天 25 次调用日志 `trace_sampled=False`，一条 span
    都没有；08-16 那批为 True 时 span 齐全）。修在 infra 那一行
    `OTEL_TRACES_SAMPLER=always_on`；这里是**读数**，让「Agent 没上报 span」与
    「这一次根本没被采样」在报告里分得开，而不是都读成没开观测。

    None ≠ False：本地跑没装 OTel、或者没有活跃 span 时读不出采样位，那时候说
    「未采样」就是拿缺测当阴性。
    """
    try:
        from opentelemetry import trace as otel_trace
    except ImportError:
        return None
    ctx = otel_trace.get_current_span().get_span_context()
    if not getattr(ctx, "is_valid", False):
        return None
    flags = getattr(ctx, "trace_flags", None)
    sampled = getattr(flags, "sampled", None)
    return bool(sampled) if sampled is not None else None


def invoke_agent_raw(runtime_arn: str, payload: str, session_id: str,
                     client=None) -> str:
    """One invoke_agent_runtime call, body fully drained and decoded.

    The single place the wire call happens: invoke_agent (dataset runs, red
    teaming via redteam.py) and probe.probe_invoke (template connectivity test)
    both go through here, so a probe exercises exactly the code path a real run
    will use. `client` lets the probe pass one with a hard read timeout.
    """
    with _target_session_baggage(session_id):
        resp = (client or _agent_client()).invoke_agent_runtime(
            agentRuntimeArn=runtime_arn,
            runtimeSessionId=session_id,
            contentType="application/json",
            accept="application/json, text/event-stream",
            payload=payload,
        )
        raw = b"".join(chunk for chunk in resp["response"])
    return raw.decode("utf-8", errors="replace")


def invoke_agent(runtime_arn: str, cfg: dict, case_input: str, session_id: str) -> str:
    body = invoke_agent_raw(runtime_arn,
                            render_payload(cfg["payload_template"], case_input),
                            session_id)
    return _extract_response(body, cfg.get("response_path", ""))


def _save_run(run: dict, terminal: bool = False) -> None:
    """Checkpoint a regression run: full detail to S3, fitting summary to DynamoDB.

    Multi-turn cases embed whole conversations per result row, which is the same
    way red-team runs blew past DynamoDB's 400KB item limit and lost a paid run
    (see runstore). `terminal=True` marks the final states.
    """
    runstore.save_run(_table(), "RUN", run, s3_prefix="test-runs",
                      terminal=terminal)


def get_test_run(run_id: str, detail: bool = True) -> dict | None:
    """`detail=False` skips the S3 restore — for progress polls that read counters."""
    item = _table().get_item(Key={"pk": "RUN", "sk": run_id}).get("Item")
    return runstore.load_run(item, detail=detail) if item else None


def list_test_runs() -> list[dict]:
    items = _table().query(KeyConditionExpression=Key("pk").eq("RUN")).get("Items", [])
    runs = []
    for i in items:
        # Summary fields only — no S3 round trip per run for a list view.
        r = json.loads(i["data"])
        runs.append({k: r.get(k) for k in
                     ("run_id", "dataset", "agents", "status", "started_at",
                      "duration_s",  # 历史 run 无此字段 -> None，不伪造
                      "completed_cases", "total_cases", "actual_cost_usd")})
        runs[-1]["started_epoch"] = r.get("started_epoch")
    # 分钟级字符串仍是主排序键（字典序即时间序，历史 run 顺序不变）；
    # 秒级 epoch 只作同一分钟内的平局裁决。
    return sorted(runs, key=lambda r: (r.get("started_at") or "",
                                       r.get("started_epoch") or 0), reverse=True)


def _run_simulated_conversation(runtime_arn: str, cfg: dict, case: dict,
                                session_id: str, judge_model: str,
                                on_turn=None) -> dict:
    """Drive a multi-turn conversation: ActorSimulator plays the user, the
    deployed agent answers via invoke_agent_runtime on ONE session id (so the
    agent keeps its own conversational context). Returns transcript + final
    output."""
    from strands_evals import ActorSimulator, Case

    max_turns = _case_turns(case)
    sim_case = Case(
        name=case["name"], input=case["input"], session_id=session_id,
        metadata={"task_description": case.get("task_description", "")},
    )
    persona = (case.get("persona") or "").strip()
    template = None
    if persona:
        # prepend persona to the default template's behavior contract
        template = ("你正在扮演一名与 AI 客服对话的用户。人设（务必贯穿始终）：" + persona +
                    "\n\n目标：{goal}\n背景：{context}\n"
                    "根据助手的最新回复，以该人设的口吻输出下一句用户消息；"
                    "目标达成或无法推进时停止。")

    sim = ActorSimulator.from_case_for_user_simulator(
        case=sim_case, max_turns=max_turns,
        system_prompt_template=template, model=judge_model,
    )

    turns = []
    user_message = case["input"]
    agent_message = ""
    goal_reached = False
    while sim.has_next():
        if on_turn:
            on_turn("user", user_message)
        agent_message = invoke_agent(runtime_arn, cfg, user_message, session_id)
        if on_turn:
            on_turn("agent", agent_message[:2000])
        turns.append({"role": "user", "message": user_message})
        turns.append({"role": "agent", "message": agent_message[:2000]})
        result = sim.act(agent_message)
        so = result.structured_output
        if so is not None and getattr(so, "stop", False):
            goal_reached = True  # simulator decided the goal was met
            break
        user_message = str(so.message) if so is not None and so.message else ""
        if not user_message:
            break
    return {"turns": turns, "output": agent_message,
            "n_turns": len(turns) // 2, "goal_reached": goal_reached}


def _synthetic_session(session_id: str, user_input: str, output: str,
                       conversation: list[dict] | None = None):
    """Wrap an exchange into a Session so trace-level evaluators and the
    diagnosis detectors work in dataset mode.

    Multi-turn conversations produce one Trace per user->agent exchange —
    detectors and turn-aware evaluators then see real structure instead of
    one opaque blob.
    """
    from datetime import datetime, timezone
    from strands_evals.types.trace import AgentInvocationSpan, Session, SpanInfo, Trace

    now = datetime.now(timezone.utc)

    def make_trace(u, a):
        tid = uuid.uuid4().hex
        span = AgentInvocationSpan(
            span_info=SpanInfo(trace_id=tid, span_id=uuid.uuid4().hex[:16],
                               session_id=session_id, parent_span_id=None,
                               start_time=now, end_time=now),
            user_prompt=u,
            agent_response=a,
            available_tools=[],
        )
        return Trace(spans=[span], trace_id=tid, session_id=session_id)

    traces = []
    if conversation:
        pending_user = None
        for t in conversation:
            if t["role"] == "user":
                pending_user = t["message"]
            elif t["role"] == "agent" and pending_user is not None:
                traces.append(make_trace(pending_user, t["message"]))
                pending_user = None
    if not traces:
        traces = [make_trace(user_input, output)]
    return Session(traces=traces, session_id=session_id)


def case_image_key(case: dict) -> str:
    """The S3 key of this case's image, or "" for a text-only case.

    Images live in the artifacts bucket under sources/ (the same archive the AI
    generator already writes to) and are referenced by key, never inlined: a
    case list is stored as one DynamoDB item, and a few base64 images would blow
    the 400KB item limit for the whole dataset.
    """
    return str(case.get("image_key") or "").strip()


def _load_multimodal_input(case: dict):
    """Build the SDK's MultimodalInput for a case that carries an image.

    The image goes to the JUDGE, not to the target: the target is a Runtime that
    accepts a JSON text payload, so what we grade is whether its text answer is
    faithful to an image the *user* was looking at (a screenshot pasted into a
    support chat, a receipt, a seat map). Returns None when the case has no image
    or the bytes can't be fetched — the caller then falls back to text judging
    rather than failing the case.
    """
    key = case_image_key(case)
    if not key:
        return None
    from strands_evals.types.multimodal import ImageData, MultimodalInput

    bucket = os.environ.get("ARTIFACTS_BUCKET", "")
    if not bucket:
        raise ValueError("case has image_key but ARTIFACTS_BUCKET is unset")
    if not key.startswith("sources/"):
        raise ValueError(f"image_key must live under sources/: {key}")
    # 同一个归档桶、同一个区：与 run 明细归档共用 runstore 的缓存单例，不再
    # 每个带图用例现建一个 client。
    raw = runstore._s3().get_object(Bucket=bucket, Key=key)["Body"].read()
    fmt = key.rsplit(".", 1)[-1].lower()
    fmt = {"jpg": "jpeg"}.get(fmt, fmt)
    if fmt not in ("jpeg", "png", "gif", "webp"):
        raise ValueError(f"unsupported image format '{fmt}' (SDK accepts jpeg/png/gif/webp)")
    return MultimodalInput(
        media=ImageData(source=raw, format=fmt),
        instruction=case["input"],
        context=case.get("image_context") or None,
    )


def _to_evaluation_data(case: dict, entry: dict, task_out: dict):
    """Record one case's agent output for the cache.

    Only the agent side is stored (output + trajectory + the conversation kept
    in metadata for multi-turn replay); scores are deliberately excluded so a
    later run with different evaluators re-judges rather than reusing verdicts.
    """
    from strands_evals.types.evaluation import EvaluationData

    return EvaluationData(
        name=case["name"],
        input=case["input"],
        expected_output=case.get("expected_output"),
        actual_output=task_out["output"],
        actual_trajectory=task_out.get("trajectory"),
        actual_interactions=task_out.get("interactions"),
        metadata={"conversation": entry.get("conversation"),
                  "goal_reached": entry.get("goal_reached"),
                  "persona": entry.get("persona"),
                  "session_id": entry.get("session_id"),
                  # Reference only — the bytes are re-fetched from S3 on reuse.
                  # Inlining base64 here would blow the item limit for the row.
                  "image_key": case_image_key(case) or None},
    )


def _is_blank_output(output: str, conversation: list[dict] | None) -> bool:
    """True when the target produced nothing to grade.

    Same trap red teaming hit (see redteam.BLANK_TARGET_MARKER): the target's
    own model content filter blocks its generation and AgentCore streams **zero
    bytes** with HTTP 200 (its trace records
    `gen_ai.response.finish_reasons: ["content_filtered"]`, 0 tokens). Judges
    handed an empty output score it 0 with "the output is empty" — indistinguishable
    from a real bad answer, so it drags down mean score and pass rate and sends
    the diagnosis detector chasing a fault in an answer that was never produced.

    Multi-turn: only the *last* agent turn matters, since that is what `output`
    is; a conversation that filtered mid-way still ended with real content.
    """
    if output.strip():
        return False
    if conversation:
        last = next((t for t in reversed(conversation) if t.get("role") != "user"), None)
        return not str((last or {}).get("message", "")).strip()
    return True


def _is_error_output(output: str, conversation: list[dict] | None = None) -> str | None:
    """Error summary when the target returned an internal error object, else None.

    Sister trap to _is_blank_output, seen in production: the target agent's own
    model provider ran out of balance and the agent surfaced its internal
    exception as its "answer" — e.g.
    {"error": "Error code: 403 - {... 'NOT_ENOUGH_BALANCE' ...}",
     "error_type": "PermissionDeniedError", "message": "An error occurred ..."}.
    That is non-blank, so the blank check misses it, the judge scores the error
    JSON as a bad answer, and (worse) the row is cached and replayed after the
    user fixes the balance.

    Deliberately conservative — only fires when the ENTIRE output is one JSON
    error object; never substring matching, so a real answer that merely quotes
    the word "error" can't be hit. The stripped output must parse as a JSON
    object AND one of:
      - it has a non-empty string `error_type`, or
      - it has both `error` and `message` keys with a truthy `error`
        (truthy so {"error": null, "message": "ok", ...} success envelopes pass), or
      - its ONLY key is a truthy `error`.

    Multi-turn: mirrors _is_blank_output — only the *last* agent turn matters,
    checked via `conversation` because on cache reuse `output` is the joined
    transcript (with [用户]/[助手] prefixes), not the final agent message.
    """
    def _check(text: str) -> str | None:
        text = (text or "").strip()
        if not text.startswith("{"):
            return None
        try:
            obj = json.loads(text)
        except Exception:
            return None
        if not isinstance(obj, dict) or not obj:
            return None
        etype = obj.get("error_type")
        matched = (
            (isinstance(etype, str) and etype.strip())
            or ("error" in obj and "message" in obj and obj.get("error"))
            or (set(obj) == {"error"} and obj.get("error"))
        )
        if not matched:
            return None
        # Human-readable summary: prefer the `error` payload (carries the real
        # cause, e.g. NOT_ENOUGH_BALANCE) over the often-generic `message`.
        detail = ""
        for key in ("error", "message", "reason"):
            v = obj.get(key)
            if isinstance(v, dict):
                v = v.get("message") or v.get("reason") or json.dumps(v, ensure_ascii=False)
            if isinstance(v, str) and v.strip():
                detail = v.strip()
                break
        parts = [p for p in ((etype or "").strip() if isinstance(etype, str) else "",
                             detail) if p]
        summary = ": ".join(parts) or json.dumps(obj, ensure_ascii=False)
        return summary[:300]

    hit = _check(output)
    if hit is None and conversation:
        last = next((t for t in reversed(conversation) if t.get("role") != "user"), None)
        if last is not None:
            hit = _check(str(last.get("message", "")))
    return hit


def _unjudgeable_recording(data) -> str | None:
    """Reject cached dataset rows with nothing to judge (evalcache validate hook).

    Runs on save and on load. Save side is belt-and-braces (run_one returns
    before caching a blank or an error object); load side is what matters —
    rows recorded before this check existed would otherwise be replayed forever,
    each reuse producing the same fake 0 分 while the report tells the user to
    re-run. For error objects the load side is what makes "fix the target's
    balance, re-run" actually re-invoke the target instead of replaying the
    cached error.
    """
    if not str(data.actual_output or "").strip():
        return "blank_output"
    convo = (data.metadata or {}).get("conversation") if data.metadata else None
    if _is_error_output(str(data.actual_output or ""), convo):
        return "error_output"
    return None


def _reason_fields(reason: str) -> dict:
    """判定里与 reason 有关的三个字段（截断时如实说，不静默交出半句话）。

    `reason_chars` 是**原文**长度，不是截断后的 —— 它要回答的是「丢了多少」。
    """
    n = len(reason)
    if n <= REASON_MAX_CHARS:
        return {"reason": reason, "reason_truncated": False, "reason_chars": n}
    return {"reason": reason[:REASON_MAX_CHARS] + REASON_TRUNCATED_MARK,
            "reason_truncated": True, "reason_chars": n}


# ---------- judge 的分档词 label（SDK EvaluationOutput.label）----------
#
# 这两个函数在 observe 与 testrun 里各存一份、**逐字同源**（两个模块不许互相
# import，见 observe.py 模块 docstring 的层次纪律）；同源性由
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


def _collect_results(into: dict, report) -> None:
    """Fold one EvaluationReport's rows into a {evaluator: verdict} dict.

    Called once per Experiment. Text and multimodal evaluators run as separate
    experiments over the same recorded output, so their rows merge here — the
    evaluator name is the key and the two sets never collide (mm_* prefix).
    """
    for i, row in enumerate(report.cases):
        reason = str(report.reasons[i]) if i < len(report.reasons) else ""
        # SDK turns an evaluator exception into score=0/pass=False; that is a
        # failure to evaluate, not a 0 分 judgment. Both phrasings are the SDK's
        # own (_worker fabricates the first, _run_evaluator the second).
        errored = reason.lstrip().startswith(("An error occurred:", "Evaluator error:"))
        into[row.get("evaluator", f"e{len(into)}")] = {
            "score": None if errored else report.scores[i],
            "passed": None if errored else bool(report.test_passes[i]),
            "errored": errored,
            # judge 自己给的分档词（EvaluationOutput.label）。只在「恰好一条判定
            # 且它有 label」时上盘，其余一律 None —— 见 _one_label。
            "label": None if errored else _one_label(_detailed_row(report, i)),
            # errored 认的是**原文**开头，与截断无关（截断只动尾巴）
            **_reason_fields(reason),
        }


def _interactions_from_exchange(user_input: str, output: str,
                                conversation: list[dict] | None) -> list[dict]:
    """InteractionsEvaluator node flow for dataset mode."""
    steps = conversation or [{"role": "user", "message": user_input},
                             {"role": "agent", "message": output}]
    nodes, prev = [], None
    for i, t in enumerate(steps, 1):
        node = f"#{i} {t['role']}"
        nodes.append({"node_name": node, "dependencies": [prev] if prev else [],
                      "messages": [str(t["message"])[:1200]]})
        prev = node
    return nodes


async def execute_test_run(run_id: str, dataset: dict, agent_names: list[str],
                           evaluator_names: list[str], judge_model: str,
                           custom_rubrics: dict, agents_meta: dict,
                           estimate: dict, progress_cb=None,
                           turn_queue: "asyncio.Queue | None" = None,
                           cache_mode: str = "off", stop_check=None,
                           trace_mark=None) -> dict:
    """Run all cases x agents; checkpoint to DynamoDB after each case-result.

    trace_mark（可选，async (run, rows) -> trace_summary；只用上报数据评估 ADR-0019 批 2）：
    给了它，评分就从「每例调用完立刻判」改成三段 ——
      ① 环节内全部用例先调用完（行以未判形态进 results，被测 Agent 侧成本照记）；
      ② 调一次 trace_mark：按会话核对 Agent 侧带内容 span 并在行上写 `trace`
         （planrun._mark_traces，退避预算 135 s **整个环节付一次**，不是每例一次）；
      ③ 只给 trace 为 ok 的行评分，且评分输入是该会话 span 还原的对话
         （tracesource.scoring_input_from_session），不是 InvokeAgentRuntime 的返回；
         no_trace 的行不判、不花 judge 钱。
    缺省 None = 老行为：每例调用完立刻按返回判分，行上一个键都不多。

    stop_check（可选，同步可调用 → bool）：每个用例完成时问一次「用户请求停止了
    吗」。为真就照成本熔断那套动作收敛（取消全部在飞 task 并 break），已完成用例
    的结果一条不丢。方案运行传的是 planrun.stop_requested 的闭包（自带 ≥5s 节流，
    所以「每个用例问一次」不等于每个用例读一次 DynamoDB）；独立回归 run 传 None，
    行为与此前完全一致、一次读都不产生。

    turn_queue, when provided, receives live turn events
    {case, agent, role, message, turn_no} as conversations progress —
    the SSE loop drains it for real-time display. Turns are also appended
    to the RUN checkpoint under live_turns so a page refresh can rebuild.

    cache_mode ("off"|"record"|"reuse") controls the EvaluationDataStore: on a
    hit the agent is not invoked and the recorded output is re-judged, so a
    rubric change costs judge calls only. Scoped per dataset+agent.
    """
    import evalcache
    from strands_evals import Case, Experiment

    prices = pricing.get_prices()["prices"]
    cases = dataset["cases"]
    # started_at 分钟级字符串是既有展示契约，保持不变；秒级精度走 started_epoch。
    started_epoch = int(time.time())
    run = {
        "run_id": run_id, "dataset": dataset["name"], "agents": agent_names,
        "evaluators": evaluator_names, "judge_model": judge_model,
        "status": "running",
        "started_at": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(started_epoch)),
        "started_epoch": started_epoch,
        "total_cases": len(cases) * len(agent_names), "completed_cases": 0,
        "estimate": estimate, "actual_cost_usd": 0.0, "results": [],
        # 成本拆分（契约 docs/payload-contract.md「成本字段」）：actual_cost_usd 恒等于
        # 「算得出的部分之和」= judge_usd + 已定价被测 Agent 的费用；被测 Agent 无价时
        # agent_usd 置 null、cost_is_partial=true、unpriced 列出名字 —— 让「$0.47」
        # 能被读成「judge 侧 $0.47，Agent 侧未知」而不是这次运行的全额。
        # 2026-09-04 评审：三版 Claude + DeepSeek 四份回归 run 成本四位小数全等于预估
        # 0.4725 —— 不是回落成预估，而是两侧都只剩 judge 项且 judge 按常数 token 建模
        # （JUDGE_TOKENS_PER_EVAL），45 个判定一个不少时实际 ≡ 预估；Agent 侧 0 被读成全额。
        "cost_breakdown": {"judge_usd": 0.0, "agent_usd": 0.0, "unpriced": []},
        "cost_is_partial": False,
        "live_turns": [],  # cross-case turn log for refresh recovery
        "cache_mode": cache_mode,
    }
    # judge 侧费率与**预估同刑**：查无价就用同一个兜底价（pricing.judge_price），
    # 绝不因为「没有价」而不计 —— 记账恒 0 会让下面那道 `actual > budget` 的熔断
    # 永不为真。兜底出身在 run 上留痕（一次性，不是每个用例一条日志），否则用户
    # 看到的成本数字分不清是实测还是猜的。
    judge_rate, judge_unpriced = pricing.judge_price(judge_model, prices)
    if judge_unpriced:
        run["unpriced_judge"] = True
        logger.warning("judge model has no price row, billing judge calls at the "
                       "fallback rate: %s", judge_model)
    _save_run(run)

    sem = asyncio.Semaphore(RUN_TTL_BATCH)
    loop = asyncio.get_running_loop()
    turn_counters: dict[str, int] = {}
    # validate: a recording with an empty actual_output, or one that is just the
    # target's internal error object, can never be judged (see
    # _unjudgeable_recording) — keep it out, and drop old ones on read.
    cache_stores = {a: evalcache.make_store(f"{dataset['name']}@{a}", cache_mode,
                                            validate=_unjudgeable_recording)
                    for a in agent_names} if cache_mode != "off" else {}

    # 判官要看得见被测 Agent 这一次真调了哪些工具（toolevidence）。span 源**每个
    # agent 只解析一次**：resolve_span_config 会读 DynamoDB 里的 span_source 配置，
    # 按用例解析就是 15 次同样的读。None = 这个 agent 没有可读的观测源。
    span_cfgs = {a: tracesource.resolve_span_config(
                     {"agent_name": a, "log_group": agents_meta.get(a, {}).get("log_group") or ""})
                 for a in agent_names}
    # 熔断器：某个 agent 一次都没查到 span（没开观测 / span 源配错），后面的用例就
    # 不再试了。⚠️ 并发是 RUN_TTL_BATCH 个，所以最多有那么多用例已经在飞、各自付满
    # 一次 14 秒退避 —— 熔断器保证的是「不是每个用例都付」，不是「只付一次」。
    span_dead: set[str] = set()
    # 一条都没查到的用例数，按 agent 计（见 SPAN_DEAD_AFTER_MISSES）。
    span_misses: dict[str, int] = {}

    async def _fetch_real_session(agent_name: str, session_id: str):
        """按 session_id 取这一次调用的真 trace：(Session, "") 或 (None, 降级原因)。永不抛。"""
        from strands_evals.providers.exceptions import SessionNotFoundError

        cfg = span_cfgs.get(agent_name)
        if not cfg:
            return None, toolevidence.REASON_NO_SPAN_SOURCE
        if agent_name in span_dead:
            # 「这一例根本没去查」与「这一例真的查不到」是两件事，报告里必须分得开。
            return None, toolevidence.REASON_SKIPPED
        missing, saw_spans = True, False
        for delay in SPAN_FETCH_BACKOFF:
            if delay:
                await asyncio.sleep(delay)
            try:
                # low_latency：dataset 路径必须走 filter_log_events。同一批字节，
                # Insights 要 78~116 秒才查得到，而这里的全部预算是 14 秒
                # （读数见 discovery.filter_span_records 上方，探针在
                # .scratch/tau-airline/v4/probe_readpath.py）。
                session, _spans = await asyncio.to_thread(
                    tracesource.fetch_session, cfg, session_id, 1, True)
                # 查到了不等于写全了：invoke_agent 最后结束、最后入导出队列，它没
                # 露面就说明还有 span 在路上 —— 此时的「1 次调用」与「真的只调了
                # 1 次」在数据面同形。再等一轮（退避用完就按「读到一半」降级）。
                saw_spans = True
                if toolevidence.is_complete(session):
                    return session, ""
                continue
            except SessionNotFoundError:
                continue
            except Exception:
                # 查询本身出错（权限/限流/日志组不存在）与「还没写进去」不同刑：
                # 重试不会让它变好，直接熔断这个 agent。
                logger.exception("tool-evidence span fetch failed: %s", agent_name)
                missing = False
                break
        if missing and not saw_spans:
            span_misses[agent_name] = span_misses.get(agent_name, 0) + 1
        reason, trip = _span_degrade(missing, saw_spans, span_misses.get(agent_name, 0))
        if trip:
            span_dead.add(agent_name)
        return None, reason

    # 只用上报数据评估（批 2）：等评分的用例上下文（trace_mark 给了才用）。
    pending_judge: list[dict] = []

    async def _fetch_scoring_session(agent_name: str, session_id: str, sources: list[str]):
        """核对（trace_mark）已确认该会话有内容 span 之后，按会话取全量记录用于评分：
        (Session, None) 或 (None, no_trace 原因)。永不抛。

        **一次、不退避**：核对那步已经等到内容 span 在 Insights 里可见（135 s 预算在那里
        付过），这里再退避就是同一笔等待付两次。按核对真查过的日志组顺序试：主 span 组
        （aws/spans 这类共享组只走 Insights 且带 cfg 的 scope/service 过滤 —— 同一 session.id
        下还有平台自家的 InvokeAgentRuntime span，用 filter_log_events 拉全组会把它一起
        捞进来）；回退的 runtime 日志组走低延迟读法（filter_log_events，组是 Agent 独占的）。
        全部 SessionNotFound ⇒ no_content（核对说有、取数说无，只能是内容还原不出）；
        查询本身出错 ⇒ fetch_error。

        取数与回退那套读法**只有一份** = `tracesource.fetch_scoring_session`（批 3 起红队侧
        也走它）：两处各写一遍「共享组走 Insights、专属组只认 spans 流」的规则，迟早在一处
        改漂，而那正是「同一个组两条路读出两种字节」的成因。
        """
        return await asyncio.to_thread(tracesource.fetch_scoring_session,
                                       span_cfgs.get(agent_name) or {}, session_id, list(sources))

    def emit_turn(case_name: str, agent_name: str, role: str, message: str):
        """Thread-safe turn emitter: queue for SSE + checkpoint for recovery."""
        key = f"{case_name}@{agent_name}"
        turn_counters[key] = turn_counters.get(key, 0) + 1
        ev = {"case": case_name, "agent": agent_name, "role": role,
              "message": message[:1500], "turn_no": turn_counters[key]}
        # 造帧留在这里（帧形是前端契约：liveTurns.ts 逐字段消费，
        # web/tests/live-turns.test.ts 直接读本文件源码对刑）；送帧的三个动作
        # （追加 + 每 N 帧 checkpoint 兜 except + 跨线程投队列）与红队共用
        # runstore.publish_turn，cadence 是两边唯一的真差异。
        runstore.publish_turn(run, ev, save=lambda: _save_run(run),
                              cadence=2,  # checkpoint every full exchange
                              loop=loop, queue=turn_queue)

    async def run_one(agent_name: str, case: dict) -> dict | None:
        async with sem:
            # 入口检查点：拿到并发名额后的第一件事是问「停止落地了吗」。下面主循环
            # 的那道检查点在用例**完成之后**，而名额一还回去、下一例就被唤醒并把
            # invoke 提交进线程池 —— 这发生在主循环看见这次完成之前（asyncio 回调
            # 顺序：sem.release 的唤醒先于 task 完成回调）。只靠主循环随后的
            # cancel 能不能撤回那次提交，取决于工作线程抢没抢到；现网 stop_check
            # 里是一次阻塞的 DynamoDB 读、释放 GIL，几乎必然抢到 = 停止之后又真调
            # 一次被测 Agent。返回 None = 这一例一次调用都没发起（缓存命中也要花
            # judge 的钱，所以放在缓存查找之前），不算完成、不进结果。stop_check
            # 自带节流与粘滞（planrun.stop_requested），多问这一次不多一次读。
            # 钉：tests/test_stop_run_admission.py。
            if stop_check is not None and stop_check():
                return None
            cfg = catalog.get_agent_config(agent_name)
            arn = agents_meta[agent_name]["runtime_arn"]
            # AgentCore requires runtimeSessionId length >= 33
            sid = f"evaltest-{run_id[4:16]}-{uuid.uuid4().hex}"[:64]
            entry = {"agent": agent_name, "case": case["name"], "input": case["input"],
                     "session_id": sid, "expected_output": case.get("expected_output"),
                     "category": case.get("category")}
            if case_image_key(case):
                # surfaced in the report so a reader can open the exact image
                # the judge saw, rather than trusting the score blind
                entry["image_key"] = case_image_key(case)
            is_multi = bool(case.get("task_description"))

            # Per-case wall clock, mirroring the run-level
            # started_epoch/finished_epoch/duration_s fields. Started before the
            # cache lookup so a cache hit records its real (tiny) elapsed time
            # rather than a fabricated zero; every return path goes through
            # _finish so errored/blank/skipped cases carry timing too.
            case_started = time.time()

            def _finish() -> dict:
                case_finished = time.time()
                entry["started_epoch"] = int(case_started)
                entry["finished_epoch"] = int(case_finished)
                entry["duration_s"] = round(float(case_finished - case_started), 1)
                return entry

            # cache lookup before any agent call: a hit means we re-judge a
            # previously recorded output instead of invoking the agent again.
            store = cache_stores.get(agent_name)
            cached = await asyncio.to_thread(store.load, case["name"]) if store else None
            if cached is not None:
                output = str(cached.actual_output or "")
                entry["output"] = output[:4000]
                entry["from_cache"] = True
                meta = cached.metadata or {}
                if meta.get("conversation"):
                    entry["conversation"] = meta["conversation"]
                    entry["n_turns"] = len(meta["conversation"]) // 2
                    entry["goal_reached"] = meta.get("goal_reached", False)
                    entry["persona"] = meta.get("persona")
                    is_multi = True
                for t in (entry.get("conversation")
                          or [{"role": "user", "message": case["input"]},
                              {"role": "agent", "message": output}]):
                    emit_turn(case["name"], agent_name, t["role"], str(t["message"]))
            else:
                # 采样位在**调用前**读：被测 Agent 的 parentbased 采样器看的就是
                # 这一刻的 trace flags（asyncio.to_thread 会带着同一份 context 过去）。
                # 只有真调用了才写这个字段 —— 缓存命中那一支没有本次调用，写上去等于
                # 拿上一次的采样位替这一次背书。
                sampled = current_trace_sampled()
                if sampled is not None:
                    entry["trace"] = {"sampled": sampled}
                try:
                    if is_multi:
                        on_turn = lambda role, msg, _c=case["name"], _a=agent_name: \
                            emit_turn(_c, _a, role, msg)
                        convo = await asyncio.to_thread(
                            _run_simulated_conversation, arn, cfg, case, sid, judge_model,
                            on_turn)
                        output = convo["output"]
                        entry["output"] = output[:4000]
                        entry["conversation"] = convo["turns"]
                        entry["n_turns"] = convo["n_turns"]
                        entry["goal_reached"] = convo["goal_reached"]
                        entry["persona"] = case.get("persona") or None
                    else:
                        emit_turn(case["name"], agent_name, "user", case["input"])
                        output = await asyncio.to_thread(invoke_agent, arn, cfg, case["input"], sid)
                        entry["output"] = output[:4000]
                        emit_turn(case["name"], agent_name, "agent", output[:1500])
                except ReadTimeoutError as e:
                    # 与下面的通用分支同档（调用失败，不进判分），只是话术可读：
                    # 单/多轮都会走到这里（多轮经 _run_simulated_conversation →
                    # invoke_agent 原样上抛）。
                    entry["error"] = _agent_timeout_note(e)[:500]
                    return _finish()
                except Exception as e:
                    entry["error"] = str(e)[:500]
                    return _finish()

            if _is_blank_output(output, entry.get("conversation")):
                # Nothing to grade. Judging silence yields a 0 that reads exactly
                # like a bad answer, so skip the judges entirely and say why.
                entry["blank_output"] = True
                entry["eval_skipped"] = (
                    "被测 Agent 返回空响应（0 字节，非报错）：既未回答也未拒绝，"
                    "无内容可判分。常见原因是被测 Agent 侧的模型内容过滤拦截了本次生成"
                    "（其自身 trace 记为 finish_reason=content_filtered）。"
                    "本用例不计入均分与通过率；空白响应本身也是可用性缺陷，"
                    "应改为明确的拒绝话术。")
                return _finish()

            err_summary = _is_error_output(output, entry.get("conversation"))
            if err_summary:
                # The target answered with its own internal error object (e.g.
                # its model provider returned 403 NOT_ENOUGH_BALANCE and the
                # agent serialized the exception as its reply). Judging that
                # yields a low score indistinguishable from a bad answer, so
                # skip the judges and never cache it (see _unjudgeable_recording).
                entry["error_output"] = True
                entry["error_summary"] = err_summary
                entry["eval_skipped"] = (
                    "被测 Agent 返回的是其内部错误对象而非回答（常见原因：其模型供应商"
                    "余额不足、鉴权失败或内部异常），无有效回答可判分。"
                    "本用例不计入均分与通过率；该输出不会写入结果缓存，"
                    "修复被测 Agent 后重跑即可重新真实调用。")
                return _finish()

            if not evaluator_names:
                return _finish()
            ctx = {"agent_name": agent_name, "case": case, "entry": entry, "sid": sid,
                   "output": output, "is_multi": is_multi, "store": store, "cached": cached}
            if trace_mark is not None:
                # 只用上报数据评估：评分挪到环节内全部用例调用完、一次核对之后（第二
                # 阶段，见 execute_test_run 文档串）。这里只留下评分要用的上下文，行先以
                # 「未判」形态进 results —— 与调用失败 / 空响应的行在这一刻同形，核对
                # 之后才分得开（trace 字段）。
                pending_judge.append(ctx)
                return _finish()
            await _judge(ctx, output, entry.get("conversation"))
            return _finish()

    async def _judge(ctx: dict, output: str, convo: list[dict] | None,
                     real_session=None) -> None:
        """判分。output / convo 是评分输入：按返回评分时就是 entry 上的返回与驱动出的
        对话；按 trace 评分时是 scoring_input_from_session 还原的最终回复与逐轮消息，且
        real_session 已在评分阶段取好 —— 工具证据直接嫁接这一份，**不再** fetch。"""
        agent_name, case, entry, sid = ctx["agent_name"], ctx["case"], ctx["entry"], ctx["sid"]
        is_multi, store, cached = ctx["is_multi"], ctx["store"], ctx["cached"]
        try:
            # Multimodal evaluators need the image on case.input; text
            # evaluators must NOT get it (they'd stringify the payload
            # into the judge prompt). Run them as two experiments over
            # the same recorded output instead of one mixed batch.
            mm_names = [n for n in evaluator_names
                        if n in MULTIMODAL_EVALUATORS]
            text_names = [n for n in evaluator_names if n not in mm_names]
            mm_input = None
            if mm_names:
                try:
                    mm_input = _load_multimodal_input(case)
                except Exception as e:
                    # A missing/undecodable image must not silently become
                    # a text judgment that looks like a real multimodal score.
                    logger.exception("multimodal input load failed: %s", case["name"])
                    entry["multimodal_error"] = str(e)[:300]
                if mm_input is None and "multimodal_error" not in entry:
                    entry["multimodal_error"] = (
                        "该用例没有 image_key，多模态评估器退化为纯文本判分，"
                        "结果不代表图像理解能力")
            # wrap the exchange in a synthetic Session: trace-level
            # evaluators need it, output evaluators read output.
            # Multi-turn: judge sees the whole conversation as output.
            if is_multi and convo:
                convo_text = "\n".join(
                    f"[{'用户' if t['role'] == 'user' else '助手'}] {t['message']}"
                    for t in convo)
                task_out = {"output": convo_text,
                            "trajectory": _synthetic_session(sid, case["input"], convo_text, convo)}
            else:
                task_out = {"output": output,
                            "trajectory": _synthetic_session(sid, case["input"], output)}
            if "interactions" in evaluator_names:
                task_out["interactions"] = _interactions_from_exchange(
                    case["input"], output, convo)
            # Cached before the image is attached anywhere: the recording
            # keeps the text input + image_key, never the bytes (a base64
            # image would blow the 400KB DynamoDB item limit).
            if store is not None and cached is None:
                await asyncio.to_thread(store.save, case["name"],
                                        _to_evaluation_data(case, entry, task_out))

            # ---- 工具证据：判官必须看得见这一次真调了什么 ----
            # 缺陷本体就在上面那个 _synthetic_session：available_tools 恒空、
            # 一条 ToolExecutionSpan 都没有 ⇒ 「必须实际调用 X 工具」这类断言
            # 结构上不可验，真调了也判 0（tau-airline-16 现网两侧复现）。证据
            # 在被测 Agent 自己的 runtime 日志组里，按我们传下去的 sid 能查到。
            # 嫁接**在 store.save 之后**：缓存行的字节形状与今天保持一致
            # （命中时本来就重建合成 Session，存进去也没人读）。
            if entry.get("from_cache"):
                # 命中缓存 = 本次没有真实调用 ⇒ 不存在「本次会话」的工具记录。
                # 拿上一次的证据顶替这一次，就是把「查不到」写成「它调过」。
                real_session, degrade = None, toolevidence.REASON_CACHE_HIT
            elif real_session is not None:
                # 按 trace 评分：评分输入与工具证据出自同一份 Session（同一次 fetch）
                degrade = ""
            else:
                real_session, degrade = await _fetch_real_session(agent_name, sid)
            calls = None
            if real_session is not None:
                try:
                    calls = toolevidence.graft(task_out["trajectory"], real_session)
                except Exception:
                    # 失败就按「没取到」判，绝不让它把整个用例的判分带崩
                    logger.exception("tool-evidence graft failed: %s", case["name"])
                    degrade = toolevidence.REASON_FETCH_FAILED
            entry["tool_evidence"] = (
                toolevidence.captured_field(calls) if calls is not None
                else toolevidence.unavailable_field(degrade))

            entry["results"] = {}
            if text_names:
                ec = Case(name=case["name"], input=case["input"],
                          expected_output=case.get("expected_output"),
                          session_id=sid)
                # 自定义 rubric 走 OutputEvaluator，它的 prompt 结构上读不到
                # trajectory ⇒ 嫁接对它无效，得把证据插进 judge prompt。
                # 内置 TRACE_LEVEL 评估器不用插：嫁接完成后它们自己就渲染
                # Tool call/Tool result 行（SDK evaluator.py:234-254）。
                evs = build_evaluators(text_names, judge_model, custom_rubrics)
                toolevidence.attach_to_output_evaluators(
                    evs, toolevidence.prompt_block(entry["tool_evidence"]))
                _collect_results(entry["results"], await Experiment(
                    cases=[ec], evaluators=evs,
                ).run_evaluations_async(lambda _c: task_out))
            if mm_names:
                # Same output, same expected_output, different input: the
                # MultimodalInput carries the image the user was looking
                # at, so the judge grades the answer against the picture.
                mc = Case(name=case["name"], input=mm_input or case["input"],
                          expected_output=case.get("expected_output"),
                          session_id=sid)
                _collect_results(entry["results"], await Experiment(
                    cases=[mc],
                    evaluators=build_evaluators(mm_names, judge_model, custom_rubrics),
                ).run_evaluations_async(lambda _c: task_out))
            # auto-diagnose low scorers for the fix-action list
            import diagnosis as diagnosis_mod
            if diagnosis_mod.needs_diagnosis(entry["results"]):
                try:
                    entry["diagnosis"] = await asyncio.to_thread(
                        diagnosis_mod.diagnose, task_out["trajectory"], judge_model)
                except Exception:
                    logger.exception("run diagnosis failed: %s", case["name"])
        except Exception as e:
            entry["eval_error"] = str(e)[:500]

    async def _score_from_trace(ctx: dict) -> dict:
        """第三阶段：一条已核对为 ok 的行，按它会话的 span 还原对话来评分。

        取不到 / 还原不出最终回复 ⇒ 行改成 no_trace（原因 no_content / fetch_error），
        不判分；trace 字段的 spans / sources 原样保留。判了分的行写 scored_from =
        "trace"，output 换成 trace 还原的最终回复，原返回挪到 output_response，
        response_matches_trace 记两者是否一致 —— 不一致**不改判**（以 trace 为准），
        只留给报告页点明。
        """
        entry = ctx["entry"]
        async with sem:
            session, degrade = await _fetch_scoring_session(
                ctx["agent_name"], entry["session_id"], (entry.get("trace") or {}).get("sources") or [])
            si = tracesource.scoring_input_from_session(session) if session is not None else None
            if si is None:
                entry["trace"] = {**(entry.get("trace") or {}), "status": TRACE_NO_TRACE,
                                  "reason": degrade or TRACE_REASON_NO_CONTENT}
                return entry
            response_out = ctx["output"]
            entry["output_response"] = response_out[:4000]
            entry["output"] = si["output"][:4000]
            entry["scored_from"] = SCORED_FROM_TRACE
            entry["response_matches_trace"] = same_text(response_out, si["output"])
            entry["trace"] = {**(entry.get("trace") or {}),
                              "span_ids": list(si["span_ids"])[:TRACE_SPAN_IDS_MAX]}
            convo = None
            if ctx["is_multi"]:
                # 多轮（simulation 类）：judge 看的整段对话也从 span 还原；驾驭（模拟用户
                # 下一句说什么）仍按调用返回，entry["conversation"] 保留那份驱动记录。
                # 轮次按**调用配对**取（tracesource.invocation_turns），不用 si["turns"] 那条
                # 扁平时间线：assistant 锚在 span 结束时刻，下一轮 invoke_agent 可能在上一轮
                # 回复结束前就开始，按时刻排序会把轮次穿插成「用户 / 用户 / 助手 / 助手」
                # （2026-09-07 现网 aws/spans 两条 dsh 会话各有一处穿插，读数见 ADR 批 3 节）。
                convo = [{"role": "user" if t["role"] == "user" else "agent",
                          "message": t["message"]}
                         for t in tracesource.invocation_turns(session)]
            await _judge(ctx, si["output"], convo, real_session=session)
        return entry

    pending = [(a, c) for a in agent_names for c in cases]
    budget = estimate.get("estimated_cost_usd", 0) * COST_CIRCUIT_FACTOR

    def _settle(entry: dict | None, charge_agent: bool = True) -> bool:
        """一条结果行的记账 + 两道闸（成本熔断 / 用户停止）。返回 True = 闸门落下，
        调用方取消在飞 task 并 break。charge_agent=False 是按 trace 评分的第三阶段用的：
        被测 Agent 侧那笔在第一阶段（调用完）已经记过，这里只记 judge。
        entry=None = run_one 在入口检查点看见停止、一次调用都没发起：不是一次完成，
        不记账（也不进 results，见调用方），只走下面的停止闸 —— 停止标志粘滞，这一轮
        stop_check() 必然也为真，None 只是让它别先被记成一次完成。"""
        if entry is not None:
            # judge 侧照实计入（含缓存命中的重新判分）—— 见 _judge_cost。这一项此前
            # 整个不存在，是「成本恒 0 + 熔断死掉」的主因。
            judge_spend = _judge_cost(entry, judge_rate)
            agent_spend = 0.0
            if charge_agent:
                # rough actual-cost accrual from output size (chars/4 ≈ tokens);
                # cache hits never called the agent, so they cost nothing on this side
                out_tokens = len(entry.get("output", "")) / 4
                model = agents_meta.get(entry["agent"], {}).get("model") or ""
                p = None if entry.get("from_cache") else (
                    pricing.lookup_price(model, prices) if model else None)
                if p:
                    agent_spend = ((AVG_TOKENS_PER_CALL / 1000) * p["input"]
                                   + (out_tokens / 1000) * p["output"])
                elif not entry.get("from_cache"):
                    # 被测 Agent 的模型查无价：价格天然不可知（任意第三方模型），预估侧
                    # 同样按 0 计并把它列进 unpriced_agents —— 熔断比的就是实际与那个
                    # 预估，只在实际侧凭空加一个猜的费率会把正常运行判成超支。所以这里
                    # 照旧不计，但**不再一声不响**：名字进 run 的留痕列表（口径同
                    # metrics.py 的 unpriced_models），让「成本 0」有出处。
                    # judge 侧不同刑：那是我们自己配置的模型，费率可知且与预估同一个数。
                    # 缓存命中不进这个列表：那是刻意豁免，不是「无价」。
                    run["unpriced_agents"] = sorted({*(run.get("unpriced_agents") or []),
                                                     entry["agent"]})
                    # 无价 = Agent 侧未知：agent_usd 不再是一个数（0 会被读成「没花钱」）。
                    run["cost_is_partial"] = True
                    run["cost_breakdown"]["agent_usd"] = None
                    run["cost_breakdown"]["unpriced"] = run["unpriced_agents"]
            spend = judge_spend + agent_spend
            bd = run["cost_breakdown"]
            bd["judge_usd"] = round(bd["judge_usd"] + judge_spend, 4)
            if bd["agent_usd"] is not None:
                bd["agent_usd"] = round(bd["agent_usd"] + agent_spend, 4)
            if spend:
                run["actual_cost_usd"] = round(run["actual_cost_usd"] + spend, 4)
            if budget and run["actual_cost_usd"] > budget:
                run["status"] = "halted_cost"
                # status 单独一个人说不了话：前端只有拿到 error 才能把这次运行说成
                # 「成本熔断中止」而不是一次正常完成（见 _cost_circuit_note）。
                run["error"] = _cost_circuit_note(run["actual_cost_usd"], budget)
                logger.warning("test run cost circuit tripped: $%s > $%s",
                               run["actual_cost_usd"], round(budget, 4))
                return True
        # 用户主动停止：与成本熔断同一处、同一套动作（取消全部在飞 task 并
        # break）。放在熔断之后 —— 两者同时成立时熔断的说明更精确（钱已经烧到
        # 阈值），而且它已经把这一轮 break 掉了。
        if stop_check is not None and (entry is None or stop_check()):
            run["status"] = STOP_STATUS
            run["error"] = _stop_note(run["completed_cases"], run["total_cases"])
            logger.warning("test run stopped by request: %s (%d/%d cases)",
                           run_id, run["completed_cases"], run["total_cases"])
            return True
        return False

    tasks = [asyncio.ensure_future(run_one(a, c)) for a, c in pending]
    for fut in asyncio.as_completed(tasks):
        entry = await fut
        # None = run_one 在入口检查点看见停止、一次调用都没发起：不入账（不是一次
        # 完成），直接走 _settle 的停止分支 —— 停止标志粘滞，这一轮 stop_check() 必然
        # 也为真，只是别让它先被记成一次完成。钉：tests/test_stop_run_admission.py。
        if entry is not None:
            run["results"].append(entry)
            run["completed_cases"] += 1
        if _settle(entry):
            for t in tasks:
                t.cancel()
            break
        if progress_cb:
            progress_cb(run)
        _save_run(run)

    # ---- 只用上报数据评估（ADR-0019 批 2）：第二、三阶段 ----
    # 第一阶段被停止 / 熔断的 run 不进来（用户刚要求停止花钱；核对本身不花 judge 钱但要
    # 等 135 s）：行上不写 trace，planrun 环节结束后照批 1 的路补核对。
    if trace_mark is not None and run["status"] == "running":
        await trace_mark(run, run["results"])
        _save_run(run)
        score_tasks = [asyncio.ensure_future(_score_from_trace(ctx))
                       for ctx in pending_judge if not is_no_trace(ctx["entry"])]
        for fut in asyncio.as_completed(score_tasks):
            entry = await fut
            if _settle(entry, charge_agent=False):
                for t in score_tasks:
                    t.cancel()
                break
            if progress_cb:
                progress_cb(run)
            _save_run(run)
        # 评分阶段把「核对有内容、却还原不出最终回复」的行改成了 no_content ⇒ 汇总重算
        summarize_trace(run, run["results"])

    if run["status"] == "running":
        run["status"] = "completed"
    # 只用上报数据评估：全部 no_trace 的 run 状态 no_trace（summarize_trace 在 running 态
    # 改不了它 —— 那时 status 还不是 completed；停止 / 熔断 / 失败优先，不覆盖）
    if run.get("trace_status") == RUN_TRACE_NONE and run["status"] == "completed":
        run["status"] = RUN_TRACE_NONE
    finished_epoch = int(time.time())
    run["finished_at"] = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(finished_epoch))
    run["finished_epoch"] = finished_epoch
    run["duration_s"] = finished_epoch - started_epoch
    # Blank target responses are not judgments — count them so a report showing
    # fewer scored cases than total isn't read as cases going missing.
    run["blank_cases"] = sum(1 for r in run["results"] if r.get("blank_output"))
    # Same accounting for targets that replied with an internal error object:
    # skipped, not scored, and pointing at target-side infrastructure.
    run["error_cases"] = sum(1 for r in run["results"] if r.get("error_output"))
    if cache_stores:
        reused = sum(1 for r in run["results"] if r.get("from_cache"))
        run["cache"] = {"mode": cache_mode, "reused_cases": reused,
                        "invoked_cases": run["completed_cases"] - reused}
        # Rows the store refused: skipped = kept out on save, rejected = old
        # blank rows dropped on load. Without these a user sees "0 新记录" and
        # assumes the cache is broken.
        skipped = [x for s in cache_stores.values() for x in s.skipped]
        rejected = [x for s in cache_stores.values() for x in s.rejected]
        if skipped:
            run["cache"]["skipped"] = skipped[:50]
        if rejected:
            run["cache"]["rejected"] = rejected[:50]

    # LLM analysis over the comparison, same style as observability reports.
    # 被用户停止的 run 不做：解析是一次 judge 调用（真花钱），而用户刚刚明确要求
    # 停止花钱。但要**说清为什么没有** —— 沉默会被读成「这次解析本来就没有」
    # （文案形态照既有的失败分支）。
    if run["status"] == STOP_STATUS:
        run["analysis"] = "（已按用户请求停止，未生成解析报告）"
    else:
        try:
            run["analysis"] = await _generate_run_analysis(run, judge_model)
        except Exception as e:
            logger.exception("run analysis failed")
            run["analysis"] = f"（解析生成失败：{e}）"
    # Terminal state: detail is archived before the item records the outcome;
    # save_final records a persistence failure on the run instead of raising —
    # it must not discard results already paid for.
    runstore.save_final(_table(), "RUN", run, s3_prefix="test-runs")
    return run


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


RUN_ANALYSIS_PROMPT = f"""你是 AI Agent 评估分析师。你会收到一次「数据集回归测试」的结果：
同一批预定义用例分别由一个或多个 Agent 真实执行，并由 LLM judge 打分（可能含
correctness 对照期望答案）。请用中文输出解析报告，结构固定：

## 总体结论
一两句：整体通过情况；多 Agent 时点明谁最优。

## Agent 对比解读
每个 Agent 一小段：各评估器的表现、judge 理由中的关键事实；多 Agent 时给出
横向对比结论（质量差异体现在哪些用例上）。

## 用例级发现
指出得分最低/分歧最大的用例，引用 judge 理由说明原因；引用格式 [case:用例名@Agent名]。
`errored: true`（score 为 null）表示评估器自身执行失败、未产出评分，已不计入均分；
只报告"有多少次评估未完成、需排查后重跑"，不得当作 Agent 表现好或差的证据。
`blank_output: true` 表示**被测 Agent 返回了 0 字节空响应**（多为其自身模型内容过滤
拦截），无内容可判分，已跳过评估、不计入均分与通过率。不得说成"Agent 答错/答得差"，
也不得说成"Agent 正确拒绝"——两者都不成立。要单独指出这些用例**尚未获得有效结论、
需要排查后重跑**，并提醒空白响应本身是可用性缺陷（真实用户同样收到空白，
应改为明确的拒绝话术）。
`error_output: true` 表示**被测 Agent 返回的是其内部错误对象而非回答**（error_summary
给出错误摘要；常见原因：其模型供应商余额不足/鉴权失败/内部异常），已跳过评估、
不计入均分与通过率。这是被测 Agent 的基础设施故障而非回答质量问题——不得说成
"Agent 答错/答得差"。要单独指出这些用例**需先修复被测 Agent（如充值/修复凭证）
再重跑**，且该输出未写入缓存，重跑会重新真实调用。

## 建议（行动清单）
把前面几节的发现收成一份可直接照做的清单。若数据含 diagnosis（故障+根因+
fix_type/fix_recommendation），先按 fix_type 归并同类，再按下面的四要素形状逐条写。
若 diagnosis 为 clean:true（诊断已运行但未发现执行故障），先明确说明"低分源于
风格/表达/测试设计而非执行故障"，再按同一形状给建议。完全无 diagnosis 时按同一形状
给 1-3 条。本节是整份报告最有用的部分：总长写不下时优先压缩前面几节，不要砍建议条数
或省掉四要素中的任何一要素。

{ACTION_ITEM_SPEC}

要求：只引用数据中的事实；总长 ≤600 字。"""


async def _generate_run_analysis(run: dict, judge_model: str) -> str:
    payload = {
        "dataset": run["dataset"], "agents": run["agents"],
        "evaluators": run["evaluators"], "status": run["status"],
        "blank_cases": run.get("blank_cases") or 0,
        "error_cases": run.get("error_cases") or 0,
        "results": [
            {"agent": r["agent"], "case": r["case"],
             "input": str(r.get("input", ""))[:150],
             "expected_output": str(r.get("expected_output") or "")[:150],
             "output": str(r.get("output") or "")[:300],
             "blank_output": r.get("blank_output"),
             "error_output": r.get("error_output"),
             "error_summary": r.get("error_summary"),
             "error": r.get("error") or r.get("eval_error"),
             "diagnosis": r.get("diagnosis"),
             "scores": {k: {"score": v["score"], "reason": str(v["reason"])[:200]}
                        for k, v in (r.get("results") or {}).items()}}
            for r in run["results"][:60]
        ],
    }
    import judgellm
    resp = await asyncio.to_thread(
        judgellm.converse, judge_model, RUN_ANALYSIS_PROMPT,
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
