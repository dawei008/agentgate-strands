"""Invoke-template connectivity probe.

The dataset-regression / red-team stages construct requests from a per-agent
payload template (catalog AGENTCFG). Until now a wrong template only surfaced
mid-run; probe_invoke fires ONE real call through the exact code path a run
uses (testrun.invoke_agent_raw -> join_sse -> walk_response_path) and hands
the raw response structure back so the user can verify the template and pick
the response_path that holds the agent's final answer.

Guarantees:
  - exactly one invocation (boto retries disabled), hard read timeout;
  - nothing is written: no run record, no cache entry, no scores;
  - logs carry only sizes and latency, never response bodies.
"""

import json
import logging
import re
import time
import uuid

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError, ConnectTimeoutError, ReadTimeoutError

import catalog
import testrun
from discovery import REGION

logger = logging.getLogger("eval-anything")

# 45s 而非 60s：CloudFront 的源静默超时是 60s，若探测也用 60s，最坏情况下
# boto 要到第 60s 才抛 ReadTimeout，而心跳最后一次发在 45s —— 中间那 15s 静默
# 正好贴着 CloudFront 的墙。45s 足够覆盖冷启动 + 一轮工具调用，且给心跳循环
# 留出余量。约束：main.py 的心跳间隔必须严格小于本值（见那里的注释）。
DEFAULT_TIMEOUT_S = 45
# 无害的默认测试输入：不触发工具副作用，也便于在响应里肉眼定位回答文本。
DEFAULT_SAMPLE_INPUT = "你好，请用一句话介绍你自己。"

# response_path 用 None 作"未指定"哨兵：空字符串 "" 是一个有意义的值（显式
# 表示"不做路径提取，整段文本即输出"），所以判断一律用 `is None`，绝不能用
# `or` 短路——`"" or cfg[...]` 会吃掉第三种语义，让用户无法在探测时验证
# "留空" 这个配置本身。

# response_paths 展平的边界：数组只展开前 2 个元素、深度上限 6 层、
# 条目上限 60 条 —— 大响应也不会把 SSE 事件打爆。
FLATTEN_MAX_DEPTH = 6
FLATTEN_MAX_ARRAY = 2
FLATTEN_MAX_ENTRIES = 60
PREVIEW_CHARS = 120

RAW_LIMIT = 4000        # response_raw 回传上限（字符）
EXTRACT_LIMIT = 2000    # extracted_text 回传上限（字符）

# ---------------------------------------------------------------------------
# 配置自动推断（auto_configure_agent 用）
# ---------------------------------------------------------------------------

# 已知标准响应形状白名单：命中即 high（response_path 的点号形式）。
KNOWN_RESPONSE_PATHS = (
    "output.message.content.0.text",   # AgentCore/Converse 标准形状
    "result.text",
    "response.text",
    "result",
    "response",
    "output.text",
    "message.content.0.text",
    "completion",
    "answer",
    "text",
)

# 模板池：自动重试按此顺序（已保存的非默认模板会被排到第一位，见
# probe_with_template_pool）。
TEMPLATE_POOL = (
    '{"prompt": "{input}"}',
    '{"message": "{input}"}',
    '{"input": "{input}"}',
    '{"query": "{input}"}',
)
POOL_TIMEOUT_S = 20   # 模板池单次探测超时：4 个模板总预算 ~80s 上限

# 多 string 叶子打分的字段名启发式
_POSITIVE_KEYS = ("answer", "text", "content", "message", "output",
                  "result", "response", "completion", "reply")
_NEGATIVE_KEYS = ("log", "debug", "trace", "error", "id", "key",
                  "arn", "token", "session", "timestamp", "time",
                  "version", "status", "model", "role", "type")
_NAME_BONUS = 60      # 字段名像"面向用户的回答"
_NAME_PENALTY = 80    # 字段名像日志/元数据
_TS_PENALTY = 60      # 内容形似时间戳
# ISO 时间戳或 10-13 位 epoch
_TS_RE = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|(?<!\d)\d{10,13}(?!\d)")

MAX_CANDIDATES = 4


def _leaf_field_name(response_path: str) -> str:
    """路径最后一个非数字段（content.0.text -> text）。"""
    for seg in reversed(response_path.split(".")):
        if not seg.isdigit():
            return seg.lower()
    return response_path.lower()


def _score_leaf(entry: dict) -> dict:
    preview = entry.get("preview") or ""
    length = len(preview)
    name = _leaf_field_name(entry.get("response_path") or "")
    reasons = []
    score = length
    bonus = 0
    pos = [k for k in _POSITIVE_KEYS if k in name]
    neg = [k for k in _NEGATIVE_KEYS if k in name]
    if pos:
        score += _NAME_BONUS
        bonus += _NAME_BONUS
        reasons.append(f"字段名 '{name}' 更像面向用户的回答")
    if neg:
        score -= _NAME_PENALTY
        bonus -= _NAME_PENALTY
        reasons.append(f"字段名 '{name}' 更像日志/标识等元数据")
    if _TS_RE.search(preview):
        score -= _TS_PENALTY
        bonus -= _TS_PENALTY
        reasons.append("内容形似时间戳")
    return {"response_path": entry["response_path"], "preview": preview,
            "length": length, "score": score, "bonus": bonus,
            "reasons": reasons}


def _candidate(scored: dict, extra_reason: str | None = None) -> dict:
    reasons = list(scored["reasons"])
    if extra_reason:
        reasons.insert(0, extra_reason)
    return {"response_path": scored["response_path"],
            "preview": scored["preview"], "length": scored["length"],
            "reason": "；".join(reasons) if reasons else "无明显信号，按长度排序"}


def infer_response_path(response_paths: list[dict],
                        extracted_whole: str | None = None) -> dict:
    """从 flatten_response 的路径列表推断最终回答所在的 response_path。

    Args:
      response_paths   flatten_response 的条目列表（响应非 JSON 时传 []）
      extracted_whole  响应非 JSON 时的整段文本（用于判定 plaintext）

    Returns:
      confidence  "high" | "low" | "none"
      best        推荐的 response_path（plaintext/整段响应时为 ""；low/none 为 None）
      candidates  候选（[{response_path, preview, length, reason}]，按分排序，
                  low 时供前端选择；high 时首位即 best）
      plaintext   整段响应就是纯文本（无 JSON 结构 / 根即字符串标量）时 True
    """
    none_result = {"confidence": "none", "best": None,
                   "candidates": [], "plaintext": False}
    entries = [e for e in (response_paths or [])
               if e.get("response_path") is not None]  # 剔除 truncated 占位

    # 1. 整段响应就是纯文本（响应体非 JSON，无可选路径）
    if not entries:
        if (extracted_whole or "").strip():
            return {"confidence": "high", "best": "", "candidates": [],
                    "plaintext": True}
        return none_result

    # 1b. 整个响应是一个 JSON 标量（flatten 的 is_whole_response 条目）
    whole = next((e for e in entries if e.get("is_whole_response")), None)
    if whole is not None:
        if whole.get("type") == "string" and (whole.get("preview") or "").strip():
            return {"confidence": "high", "best": "", "candidates": [],
                    "plaintext": True}
        return none_result

    strings = [e for e in entries if e.get("type") == "string"]
    # 5. 没有任何 string 叶子
    if not strings:
        return none_result

    # 2. 只有一个 string 叶子
    if len(strings) == 1:
        s = _score_leaf(strings[0])
        return {"confidence": "high", "best": strings[0]["response_path"],
                "candidates": [_candidate(s, "唯一的字符串字段")],
                "plaintext": False}

    # 3. 已知标准形状白名单（按白名单顺序取第一个命中）
    by_path = {e["response_path"]: e for e in strings}
    for known in KNOWN_RESPONSE_PATHS:
        if known in by_path:
            s = _score_leaf(by_path[known])
            return {"confidence": "high", "best": known,
                    "candidates": [_candidate(s, "命中已知标准响应形状")],
                    "plaintext": False}

    # 4. 多个 string 叶子：启发式打分
    scored = sorted((_score_leaf(e) for e in strings),
                    key=lambda s: s["score"], reverse=True)
    top, second = scored[0], scored[1]
    len_dominant = (top["length"] >= 2 * max(second["length"], 1)
                    and top["score"] >= second["score"])
    only_positive = top["bonus"] > 0 and all(s["bonus"] <= 0 for s in scored[1:])
    if len_dominant or only_positive:
        extra = ("文本长度显著领先其余字段" if len_dominant
                 else "唯一一个字段名/内容像回答的字段")
        return {"confidence": "high", "best": top["response_path"],
                "candidates": [_candidate(top, extra)], "plaintext": False}

    return {"confidence": "low", "best": None,
            "candidates": [_candidate(s) for s in scored[:MAX_CANDIDATES]],
            "plaintext": False}


def normalize_template(template: str) -> str:
    """模板去重口径：JSON 规范化（键序无关）；非法 JSON 退回去空白原文。"""
    try:
        return json.dumps(json.loads(template), sort_keys=True,
                          ensure_ascii=False)
    except (json.JSONDecodeError, TypeError):
        return (template or "").strip()


def _plaintext_win(r: dict) -> bool:
    """探测返回非 JSON 纯文本：probe_invoke 标 ok=False + plaintext=True，但对
    自动配置而言这是成功——模板可用，response_path 留空即整段文本。"""
    return bool(r.get("plaintext")) and bool((r.get("extracted_text") or "").strip())


def probe_with_template_pool(agent: dict, sample_input: str | None = None,
                             on_attempt=None) -> dict:
    """按模板池顺序逐个 probe_invoke，第一个可用即停。

    顺序：已保存的模板排第一位，再按 TEMPLATE_POOL；按 JSON 规范化去重，
    最多尝试 4 个；单次探测超时 POOL_TIMEOUT_S（20s），总预算 ~80s。
    纯文本响应（probe ok=False 但 plaintext）视为成功（见 _plaintext_win）。

    Args:
      on_attempt  可选回调，每个模板探测完立即以 attempt 行调用（供上层流式
                  推进度事件；回调异常不影响探测）。

    Returns:
      ok               任一模板可用
      winner_template  成功的模板（失败为 None）
      attempts         [{template, ok, error, latency_ms}]（全失败时完整保留）
      ...              并入最后一次 probe_invoke 的完整结果
    """
    cfg = catalog.get_agent_config(agent.get("agent_name", ""))
    saved = (cfg.get("payload_template") or "").strip()
    ordered = ([saved] if saved else []) + list(TEMPLATE_POOL)
    pool, seen = [], set()
    for tpl in ordered:
        key = normalize_template(tpl)
        if key in seen:
            continue
        seen.add(key)
        pool.append(tpl)
    pool = pool[:len(TEMPLATE_POOL)]  # 总预算：最多 4 个

    attempts: list[dict] = []
    last: dict | None = None
    for tpl in pool:
        r = probe_invoke(agent, payload_template=tpl,
                         sample_input=sample_input, timeout=POOL_TIMEOUT_S)
        last = r
        win = bool(r.get("ok")) or _plaintext_win(r)
        attempt = {"template": tpl, "ok": win,
                   "error": None if win else r.get("error"),
                   "latency_ms": r.get("latency_ms", 0)}
        attempts.append(attempt)
        if on_attempt is not None:
            try:
                on_attempt(dict(attempt))
            except Exception:
                logger.exception("on_attempt callback failed")
        if win:
            # 纯文本胜出时清掉 probe 的"响应不是 JSON"提示——对自动配置这不是错误
            return {**r, "ok": True, "error": None, "winner_template": tpl,
                    "attempts": attempts}
    out = dict(last) if last else {"error": "没有可尝试的模板"}
    out.update({"ok": False, "winner_template": None, "attempts": attempts})
    return out


def _json_type(v) -> str:
    if isinstance(v, bool):  # bool 是 int 子类，必须先判
        return "boolean"
    if isinstance(v, str):
        return "string"
    if isinstance(v, (int, float)):
        return "number"
    if v is None:
        return "null"
    if isinstance(v, list):
        return "array"
    return "object"


def _preview(v) -> str:
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
    return s[:PREVIEW_CHARS]


def flatten_response(obj) -> tuple[list[dict], bool]:
    """Flatten a decoded JSON response into selectable paths.

    Returns (entries, truncated). Each entry:
      path          human-readable, bracket indices: output.message.content[0].text
      response_path the dot form walk_response_path/正式 run 接受的格式:
                    output.message.content.0.text —— 前端选中后可直接存进
                    AGENTCFG 的 response_path 字段
      type          string|number|boolean|null|array|object|truncated
      preview       值的前 120 字（容器为其 JSON 序列化的前 120 字）

    Two entry kinds are NOT selectable paths and carry a flag instead:
      type=="truncated"        数组未展开部分的占位（response_path 为 None）
      is_whole_response==True  整个响应就是一个标量/空容器，path="$"、
                               response_path=""（三态里的"不提取"），前端应显示
                               "整段响应"而不是一条可选路径

    Arrays expand only their first FLATTEN_MAX_ARRAY elements (a marker entry
    notes how many were skipped); containers deeper than FLATTEN_MAX_DEPTH are
    reported as one object/array entry instead of being expanded; the whole
    list stops at FLATTEN_MAX_ENTRIES.
    """
    entries: list[dict] = []
    truncated = False

    def visit(node, dpath: str, rpath: str, depth: int):
        nonlocal truncated
        if len(entries) >= FLATTEN_MAX_ENTRIES:
            truncated = True
            return
        if isinstance(node, dict) and node and depth < FLATTEN_MAX_DEPTH:
            for k, v in node.items():
                visit(v, f"{dpath}.{k}" if dpath else str(k),
                      f"{rpath}.{k}" if rpath else str(k), depth + 1)
                if len(entries) >= FLATTEN_MAX_ENTRIES:
                    truncated = True
                    return
        elif isinstance(node, list) and node and depth < FLATTEN_MAX_DEPTH:
            for i, v in enumerate(node[:FLATTEN_MAX_ARRAY]):
                visit(v, f"{dpath}[{i}]",
                      f"{rpath}.{i}" if rpath else str(i), depth + 1)
                if len(entries) >= FLATTEN_MAX_ENTRIES:
                    truncated = True
                    return
            if len(node) > FLATTEN_MAX_ARRAY:
                entries.append({
                    "path": f"{dpath}[{FLATTEN_MAX_ARRAY}..{len(node) - 1}]",
                    "response_path": None, "type": "truncated",
                    "preview": f"数组共 {len(node)} 个元素，仅展开前 {FLATTEN_MAX_ARRAY} 个",
                })
        elif not rpath:
            # 根节点本身就是叶子（整个响应是一个标量或空容器）。它的
            # response_path 只能是 ""，而 "" 在三态语义里正是"不做路径提取、
            # 整段文本即输出"——对这种响应恰好是对的。但前端若把它当普通
            # 路径条目渲染，用户会看到"选了一条却等于没选"，所以显式标注，
            # 前端应渲染为"整段响应（无需路径）"而不是一条可选路径。
            entries.append({"path": "$", "response_path": "",
                            "is_whole_response": True,
                            "type": _json_type(node),
                            "note": "整个响应就是这个值，无需提取路径"
                                    "（response_path 留空即可）",
                            "preview": _preview(node)})
        else:
            # 叶子值，或到达深度上限/空容器：记一条，不再往下展开
            entries.append({"path": dpath, "response_path": rpath,
                            "type": _json_type(node), "preview": _preview(node)})

    visit(obj, "", "", 0)
    return entries, truncated


def _probe_client(timeout: int):
    """One-shot client: retries off so the probe can never bill twice; the
    read timeout is the probe's hard wall against a hung stream."""
    return boto3.client(
        "bedrock-agentcore", region_name=REGION,
        config=BotoConfig(connect_timeout=10, read_timeout=timeout,
                          retries={"max_attempts": 0}),
    )


def _classify_client_error(e: ClientError, agent_name: str) -> str:
    code = (e.response.get("Error") or {}).get("Code", "")
    msg = (e.response.get("Error") or {}).get("Message", "")[:200]
    if code in ("ResourceNotFoundException",):
        return f"Runtime 不存在或已删除（{agent_name}）：{msg}"
    if code in ("AccessDeniedException", "UnauthorizedException", "403"):
        return f"无权限调用该 Runtime（检查本服务角色的 bedrock-agentcore:InvokeAgentRuntime 权限）：{msg}"
    if code in ("ValidationException",):
        return f"请求参数被 Runtime 拒绝（多为 payload 结构不符合目标 Agent 预期）：{msg}"
    if code in ("ThrottlingException", "TooManyRequestsException"):
        return f"被限流，请稍后重试：{msg}"
    return f"调用失败（{code or type(e).__name__}）：{msg}"


def probe_invoke(agent: dict, payload_template: str | None = None,
                 sample_input: str | None = None,
                 response_path: str | None = None,
                 timeout: int = DEFAULT_TIMEOUT_S) -> dict:
    """Fire one real invocation with the given template; report the raw shape.

    Both the template and the extraction rule can be overridden per probe, so
    the UI closes the loop "点一条路径 -> 立刻确认它取到的就是最终回答 -> 再保存"
    without having to write an unverified config into AGENTCFG first.

    response_path is three-state (None is the sentinel, see module top):
      None  未指定 -> 用已保存的 cfg["response_path"]
      "x.y" 用这条路径
      ""    显式"不做路径提取，整段文本即输出"（不回落到已保存值）

    Returns (never raises):
      ok                  模板可用、调用成功、且按本次提取规则取到了非空文本
      request_payload     实际发出的 payload（解析后的 JSON 对象；模板非法时为渲染出的原文）
      response_raw        原始响应体（截断到 RAW_LIMIT 字符）+ response_bytes 全长
      response_paths      展平后的可选路径（见 flatten_response）
      response_path_used  本次实际使用的提取规则（"" 表示整段文本）
      response_path_from  "request"（本次传入）或 "saved"（AGENTCFG 已保存值）
      extracted_text      按本次提取规则取到的最终文本
      latency_ms          调用耗时
      error               失败时的用户可读原因（不含 traceback）
      plain_text          True = 响应是纯文本（非 JSON）。这是**成功**形态：
                          正式 run 把整段文本当输出，response_path 留空即可。
                          此时 ok=True、error=None、response_paths 为空
                          （纯文本没有可选路径）。前端据此走绿色成功态，
                          不要因为 response_paths 空就判成失败。
    """
    agent_name = agent.get("agent_name", "")
    result = {"ok": False, "request_payload": None, "response_raw": None,
              "response_paths": [], "response_path_used": None,
              "response_path_from": None, "extracted_text": None,
              "latency_ms": 0, "error": None}

    runtime_arn = agent.get("runtime_arn") or ""
    if not runtime_arn:
        result["error"] = f"{agent_name} 没有 Runtime ARN，无法调用（请先刷新 Agent 列表）。"
        return result

    cfg = catalog.get_agent_config(agent_name)
    template = payload_template if (payload_template or "").strip() \
        else cfg["payload_template"]
    # 三态：必须用 `is None`，不能写 `response_path or cfg[...]`（见模块顶部注释）。
    path_from_request = response_path is not None
    path = response_path if path_from_request else cfg.get("response_path", "")
    result["response_path_used"] = path
    result["response_path_from"] = "request" if path_from_request else "saved"
    case_input = (sample_input or "").strip() or DEFAULT_SAMPLE_INPUT

    # 与正式 run 完全相同的渲染：testrun.render_payload 负责 {input} 的 JSON 转义。
    rendered = testrun.render_payload(template, case_input)
    try:
        result["request_payload"] = json.loads(rendered)
    except json.JSONDecodeError as e:
        result["request_payload"] = rendered[:RAW_LIMIT]
        result["error"] = (f"模板 JSON 非法：替换 {{input}} 后无法解析"
                           f"（第 {e.lineno} 行第 {e.colno} 列：{e.msg}）。"
                           "请检查引号/逗号，占位符写作 {input}。")
        return result

    # 'evaltest-' 前缀让观测会话列表照常把探测流量过滤掉（discovery 的 test_filter）。
    sid = f"evaltest-probe-{uuid.uuid4().hex}"[:64]
    t0 = time.monotonic()
    try:
        body = testrun.invoke_agent_raw(runtime_arn, rendered, sid,
                                        client=_probe_client(timeout))
    except (ReadTimeoutError, ConnectTimeoutError):
        result["latency_ms"] = int((time.monotonic() - t0) * 1000)
        result["error"] = (f"调用超时（{timeout}s 内未完成）：目标 Agent 可能在冷启动、"
                           "长时间执行工具，或 payload 结构不被识别导致挂起。")
        return result
    except ClientError as e:
        result["latency_ms"] = int((time.monotonic() - t0) * 1000)
        result["error"] = _classify_client_error(e, agent_name)
        return result
    except Exception as e:
        result["latency_ms"] = int((time.monotonic() - t0) * 1000)
        logger.exception("probe invoke failed for %s", agent_name)
        result["error"] = f"调用失败（{type(e).__name__}）：{str(e)[:200]}"
        return result
    result["latency_ms"] = int((time.monotonic() - t0) * 1000)
    # 响应体可能含业务数据：日志只记长度与耗时，不打印内容。
    logger.info("probe %s: %d bytes in %d ms", agent_name, len(body),
                result["latency_ms"])

    result["response_bytes"] = len(body)
    result["response_raw"] = body[:RAW_LIMIT]
    result["response_raw_truncated"] = len(body) > RAW_LIMIT

    if not body.strip():
        result["error"] = ("目标返回 0 字节空响应（HTTP 200）：常见原因是其模型内容"
                           "过滤拦截了本次生成，或 Agent 对该 payload 结构没有产出。"
                           "换一个 sample_input 重试；若持续为空需检查目标 Agent。")
        return result

    # 与正式 run 相同的两步：SSE data 行合并 -> JSON 路径提取。
    text = testrun.join_sse(body)
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        # 响应不是 JSON = 目标返回纯文本。这**不是失败**：正式 run 会把整段文本
        # 当输出，response_path 留空即可，无需改造 Agent。
        #
        # 曾经这里回 ok=False + error 字符串，前端照 ok 判色渲染成红字报错——
        # 判定语义错在后端，修在这里。契约：ok=True + plain_text=True + error=None。
        # plaintext（无下划线）为 auto_configure 模板池的同义标记，两键并存，
        # 待前后端统一为 plain_text 后移除。
        result["plaintext"] = True
        result["extracted_text"] = text[:EXTRACT_LIMIT]
        result["plain_text"] = True
        result["ok"] = True
        return result

    paths, truncated = flatten_response(obj)
    result["response_paths"] = paths
    if truncated:
        result["response_paths_truncated"] = True

    if path:
        try:
            extracted = str(testrun.walk_response_path(obj, path))
        except Exception:
            # 措辞按路径来源区分：说"已保存的规则"而实际是用户刚点的那条，会
            # 把人引到错误的地方去改。
            origin = "本次选择的提取路径" if path_from_request else "已保存的提取规则"
            result["error"] = (f"{origin} response_path='{path}' 在本次响应中取不到值；"
                               "请从 response_paths 里选择实际存放最终回答的路径。")
            return result
    else:
        extracted = text  # 正式 run 在无 response_path 时的行为：整段文本
    result["extracted_text"] = extracted[:EXTRACT_LIMIT]
    if not extracted.strip():
        rule = f"response_path='{path}'" if path else "整段文本（response_path 留空）"
        result["error"] = (f"调用成功，但按本次提取规则（{rule}）取到的文本为空；"
                           "请从 response_paths 里选择正确路径。")
        return result

    result["ok"] = True
    return result
