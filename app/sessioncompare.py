"""compare_sessions / pair_rows（ADR-0017 D3 后端）：两份 run 里的两行并排，diff 在服务端算。

数据源与 `get_plan_run` **同源**：run 摘要来自 DDB，明细来自 S3 归档（`run["report"]`），
本模块只读 `planrun.get_plan_run` / `planrun.list_plan_runs`，不碰 planrun / transcript 的
任何既有函数体。三种环节各自的「行」住在归档里的不同字段（写侧 `planrun.py`）：

  · observe  ⇒ `report.stages[i].session_details[]`，行键 = `session_id`；
               行上有 `transcript{events, system_prompt}`（transcript.build_transcript 产物）、
               `results{评估器: {score, passed, errored, reason, label}}`、
               `metrics{tokens, cost, latency, llm_calls, tool_calls}`（metrics.compute_session_metrics，
               受环节 metric_keys 过滤——用户没勾 tokens 时 by_model 整键缺席）；
  · dataset  ⇒ `report.stages[i].report.results[]`，行键 = `case`（testrun 写侧的键名，**不是** name）；
               行上有 `input` / `output` / `conversation`（多轮才有）/ `results` / `duration_s` /
               `tool_evidence{status, count}`；没有 transcript、没有 metrics、没有 system_prompt；
  · redteam  ⇒ `report.stages[i].report.results[]`，行键 = `case_name`；
               行上有 `objective` / `conversation[{role, content}]` / `score` / `breached` / `errored` / `reason`；
               没有逐评估器 results —— 本模块把攻击结论合成为一个 `redteam` 键。

`attributes` 固定 8 键（ATTRIBUTE_KEYS），取不到为 None；`system_prompt` 只有 observe 行有
（transcript.system_prompt，来自 AgentInvocationSpan.metadata.system_prompt 或原始 span 属性），
dataset / redteam 行的 `model` 取所属环节配置的 `agent_model`（report.plan.stages[i]）。
"""

import difflib
import json
import logging
import re

import planrun
import ttlcache
from ttlcache import is_number

logger = logging.getLogger(__name__)

ATTRIBUTE_KEYS = ["model", "tokens.input", "tokens.output", "llm_calls", "tool_calls",
                  "latency.avg_s", "cost.usd", "system_prompt"]

# 超过这个长度的字符串属性差异附字级 text_diff（system_prompt 无论长短都附）
LONG_TEXT_CHARS = 80
# 工具入参 / 返回值在时间线事件里的截断长度（契约：arguments(截 300) / result(截 300)）
EVENT_FIELD_CAP = 300
# 会话事件只回这些键（别把整份 transcript——span_id / slow / agent——回出来）
EVENT_KEYS = ("n", "type", "t_offset_s", "text", "name", "duration_s", "error", "arguments", "result")
# run_index 用的历史读取上界：每周几十条 run，500 条 ≈ 数年
RUN_HISTORY_CAP = 500

_WS = re.compile(r"\s+")


class CompareError(ValueError):
    """用户可读的中文错误（main.py 原样回 error 事件）。"""


def normalize_key(text) -> str:
    """题面归一化：strip、连续空白折成一个空格、casefold（与 catalog.normalize_case_input 同口径）。"""
    if text is None:
        return ""
    return _WS.sub(" ", str(text)).strip().casefold()


def text_diff(left: str, right: str) -> list[dict]:
    """字级 diff：op ∈ equal / delete / insert；SequenceMatcher 的 replace 拆成 delete + insert。"""
    out = []
    sm = difflib.SequenceMatcher(None, left, right, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            out.append({"op": "equal", "text": left[i1:i2]})
        elif tag == "delete":
            out.append({"op": "delete", "text": left[i1:i2]})
        elif tag == "insert":
            out.append({"op": "insert", "text": right[j1:j2]})
        else:  # replace
            out.append({"op": "delete", "text": left[i1:i2]})
            out.append({"op": "insert", "text": right[j1:j2]})
    return out


def attribute_diff(left: dict, right: dict) -> list[dict]:
    """只列两侧不等的键。change：added（左 None 右有）/ removed（左有右 None）/ modified。

    两侧都是字符串且（键是 system_prompt 或任一侧 > LONG_TEXT_CHARS）⇒ 附 text_diff。
    键序照 ATTRIBUTE_KEYS，再补两边多出来的键（当前没有，防御）。
    """
    keys = list(ATTRIBUTE_KEYS) + [k for k in list(left) + list(right)
                                   if k not in ATTRIBUTE_KEYS]
    seen, out = set(), []
    for key in keys:
        if key in seen:
            continue
        seen.add(key)
        lv, rv = left.get(key), right.get(key)
        if lv == rv:
            continue
        if lv is None:
            change = "added"
        elif rv is None:
            change = "removed"
        else:
            change = "modified"
        item = {"key": key, "left": lv, "right": rv, "change": change}
        if isinstance(lv, str) and isinstance(rv, str) and (
                key == "system_prompt" or max(len(lv), len(rv)) > LONG_TEXT_CHARS):
            item["text_diff"] = text_diff(lv, rv)
        out.append(item)
    return out


# ---------- 取 run 与行 ----------

# 一次对比要把同两份 run 反复取回来：get_plan_run×2（compare_sessions 两侧）→ pair_rows
# 两侧 → 配对表里每对再来一次 compare_sessions，一份归档 GET + json.loads 6~10 遍。
# 每次都是 1 次 DDB get_item + 1 次 S3 get_object + 整份报告解析。
#
# 只缓存**已结束**的 run（status != running）：S3 那份报告是一次写死的归档，跑着的 run
# 还在长。⚠️ 但**摘要项本身**在终态之后仍会被改（planrun.attach_proposal /
# set_proposal_adopted / adopt_run_advice 都对完成的 run `SET proposals`）—— 本模块一个
# 都不读，可「归档不可变」只对报告成立，不对整个 run 对象成立，所以仍留 TTL 当正确性
# 上界，不做「永不过期」。上限 8 条：报告是整份 JSON，键随 run_key 长，必须有淘汰。
_RUN_CACHE_CAP = 8
CACHE_TTL_SECONDS = ttlcache.DEFAULT_TTL_SECONDS
_run_cache = ttlcache.TtlCache(CACHE_TTL_SECONDS, max_entries=_RUN_CACHE_CAP)


def _load_run(run_key: str) -> dict:
    hit = _run_cache.get(run_key)
    if hit is not None:
        return hit[0]
    run = planrun.get_plan_run(run_key)
    if not run:
        raise CompareError(f"run '{run_key}' 不存在")
    if not isinstance(run.get("report"), dict):
        if run.get("report_error"):
            raise CompareError(f"run '{run_key}' 完整报告读取失败，无法对比")
        raise CompareError(f"run '{run_key}' 没有完整报告，无法对比")
    # 失败不进缓存（报告可能只是还没归档好，下次要真去读）；调用方只读不改这个对象。
    if run.get("status") != "running":
        _run_cache.put(run_key, run)
    return run


def _stages(run: dict) -> list[tuple[int, dict, dict]]:
    """[(环节序号 1-based, 环节结果, 环节配置)]。配置来自 report.plan.stages 同下标（缺则 {}）。"""
    report = run.get("report") or {}
    results = report.get("stages") or []
    configs = (report.get("plan") or {}).get("stages") or []
    out = []
    for i, res in enumerate(results):
        if not isinstance(res, dict):
            continue
        cfg = configs[i] if i < len(configs) and isinstance(configs[i], dict) else {}
        out.append((i + 1, res, cfg))
    return out


def _iter_rows(run: dict):
    """按归档顺序产出 (row_key, stage_type, stage_no, raw, cfg)。"""
    for stage_no, res, cfg in _stages(run):
        st = res.get("type")
        if st == "observe":
            for d in res.get("session_details") or []:
                if isinstance(d, dict) and d.get("session_id"):
                    yield str(d["session_id"]), st, stage_no, d, cfg
        elif st == "dataset":
            for r in (res.get("report") or {}).get("results") or []:
                if isinstance(r, dict) and r.get("case"):
                    yield str(r["case"]), st, stage_no, r, cfg
        elif st == "redteam":
            for r in (res.get("report") or {}).get("results") or []:
                if isinstance(r, dict) and r.get("case_name"):
                    yield str(r["case_name"]), st, stage_no, r, cfg


def _find_row(run: dict, row_key: str) -> dict:
    for key, st, stage_no, raw, cfg in _iter_rows(run):
        if key == row_key:
            return {"row_key": key, "stage_type": st, "stage_no": stage_no, "raw": raw, "cfg": cfg}
    # 报告页红队行的前端键是 `<case_name>#<下标>`（reportRows.attackRowsOf）：容下它
    m = re.fullmatch(r"(.+)#(\d+)", row_key)
    if m:
        for key, st, stage_no, raw, cfg in _iter_rows(run):
            if st == "redteam" and key == m.group(1):
                return {"row_key": key, "stage_type": st, "stage_no": stage_no, "raw": raw, "cfg": cfg}
    raise CompareError(f"run '{run.get('run_key')}' 里没有 '{row_key}'")


# ---------- 行 → 事件 / 属性 / 结果 / 题面 ----------

def _cap(value, n: int = EVENT_FIELD_CAP):
    if value is None:
        return None
    s = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return s if len(s) <= n else s[:n - 1] + "…"


def _events_observe(raw: dict) -> list[dict]:
    events = ((raw.get("transcript") or {}).get("events") or [])
    out = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        item = {k: ev.get(k) for k in EVENT_KEYS if k in ev}
        if "arguments" in item:
            item["arguments"] = _cap(item["arguments"])
        if "result" in item:
            item["result"] = _cap(item["result"])
        out.append(item)
    return out


def _events_dataset(raw: dict) -> list[dict]:
    convo = raw.get("conversation")
    out = []
    if isinstance(convo, list) and convo:
        # 多轮（testrun._simulate_conversation 的 turns：{role, message}）；逐轮没有时间戳
        for m in convo:
            if not isinstance(m, dict):
                continue
            role = "user" if m.get("role") == "user" else "assistant"
            out.append({"n": len(out) + 1, "type": role, "t_offset_s": None,
                        "text": str(m.get("message") if m.get("message") is not None
                                    else m.get("content") or "")})
        return out
    out.append({"n": 1, "type": "user", "t_offset_s": 0.0, "text": str(raw.get("input") or "")})
    reply = raw.get("output")
    if reply is not None or raw.get("error"):
        dur = raw.get("duration_s")
        out.append({"n": 2, "type": "assistant",
                    "t_offset_s": round(float(dur), 2) if isinstance(dur, (int, float)) else None,
                    "text": str(reply if reply is not None else ""),
                    **({"error": str(raw["error"])[:EVENT_FIELD_CAP]} if raw.get("error") else {})})
    return out


def _events_redteam(raw: dict) -> list[dict]:
    out = []
    for m in raw.get("conversation") or []:
        if not isinstance(m, dict):
            continue
        role = "user" if m.get("role") in ("attacker", "user") else "assistant"
        out.append({"n": len(out) + 1, "type": role, "t_offset_s": None,
                    "text": str(m.get("content") or "")})
    return out


def _num(v):
    """数值原样返回，非数值（含 bool）⇒ None。守卫与 fleetstatus / topology 同一份。"""
    return v if is_number(v) else None


def _main_model(metrics: dict | None) -> str | None:
    by_model = ((metrics or {}).get("tokens") or {}).get("by_model") or {}
    if not isinstance(by_model, dict) or not by_model:
        return None
    # 会话主模型 = 调用次数最多的那个（并列取 token 多的）
    return max(by_model, key=lambda k: ((by_model[k] or {}).get("calls") or 0,
                                        ((by_model[k] or {}).get("input") or 0)
                                        + ((by_model[k] or {}).get("output") or 0)))


def _attributes_observe(raw: dict) -> dict:
    m = raw.get("metrics") if isinstance(raw.get("metrics"), dict) else {}
    tokens = m.get("tokens") or {}
    tool_count = _num((m.get("tool_calls") or {}).get("count"))
    if tool_count is None and isinstance(raw.get("transcript"), dict):
        # 没勾 tool_calls 指标时，时间线里的 tool 事件数照样是事实
        evs = raw["transcript"].get("events") or []
        tool_count = sum(1 for e in evs if isinstance(e, dict) and e.get("type") == "tool")
    return {
        "model": _main_model(m),
        "tokens.input": _num(tokens.get("input")),
        "tokens.output": _num(tokens.get("output")),
        "llm_calls": _num((m.get("llm_calls") or {}).get("count")),
        "tool_calls": tool_count,
        "latency.avg_s": _num((m.get("latency") or {}).get("avg_s")),
        "cost.usd": _num((m.get("cost") or {}).get("usd")),
        "system_prompt": (raw.get("transcript") or {}).get("system_prompt") or None,
    }


# 下面两个只列**取得到的**键：唯一调用方 _attributes_of 按 ATTRIBUTE_KEYS 投影，
# 缺席的键一律补 None ⇒ 手写一串 None 只是把同一件事说两遍。
def _attributes_dataset(raw: dict, cfg: dict) -> dict:
    te = raw.get("tool_evidence") if isinstance(raw.get("tool_evidence"), dict) else {}
    dur = _num(raw.get("duration_s"))
    return {
        "model": cfg.get("agent_model") or None,
        # captured 且 count 是数才算取到；unavailable 的 count 是 None（toolevidence 三态）
        "tool_calls": _num(te.get("count")),
        "latency.avg_s": round(dur, 2) if dur is not None else None,
    }


def _attributes_redteam(raw: dict, cfg: dict) -> dict:
    return {"model": cfg.get("agent_model") or None}


def _results_of(found: dict, full: bool) -> dict:
    """评估器判定。full=True 回 {score, passed, label, reason}（compare_sessions），
    False 只回 {score, passed}（pair_rows 配对表）。redteam 行合成一个 `redteam` 键。"""
    raw, st = found["raw"], found["stage_type"]
    if st == "redteam":
        errored = bool(raw.get("errored"))
        breached = bool(raw.get("breached"))
        item = {"score": _num(raw.get("score")),
                "passed": None if errored else (not breached)}
        if full:
            item["label"] = None if errored else ("攻破" if breached else "守住")
            item["reason"] = raw.get("reason")
        return {"redteam": item}
    out = {}
    for name, v in (raw.get("results") or {}).items():
        if not isinstance(v, dict):
            continue
        item = {"score": _num(v.get("score")),
                "passed": v.get("passed") if isinstance(v.get("passed"), bool) else None}
        if full:
            item["label"] = v.get("label")
            item["reason"] = v.get("reason")
        out[str(name)] = item
    return out


def _align_text(found: dict) -> str:
    raw, st = found["raw"], found["stage_type"]
    if st == "observe":
        for ev in ((raw.get("transcript") or {}).get("events") or []):
            if isinstance(ev, dict) and ev.get("type") == "user":
                return str(ev.get("text") or "")
        return ""
    if st == "dataset":
        return str(raw.get("input") or "")
    if raw.get("objective"):
        return str(raw["objective"])
    for m in raw.get("conversation") or []:
        if isinstance(m, dict) and m.get("role") in ("attacker", "user"):
            return str(m.get("content") or "")
    return ""


def _events_of(found: dict) -> list[dict]:
    st = found["stage_type"]
    if st == "observe":
        return _events_observe(found["raw"])
    if st == "dataset":
        return _events_dataset(found["raw"])
    return _events_redteam(found["raw"])


def _attributes_of(found: dict) -> dict:
    st = found["stage_type"]
    if st == "observe":
        attrs = _attributes_observe(found["raw"])
    elif st == "dataset":
        attrs = _attributes_dataset(found["raw"], found["cfg"])
    else:
        attrs = _attributes_redteam(found["raw"], found["cfg"])
    return {k: attrs.get(k) for k in ATTRIBUTE_KEYS}


def _plan_run_order(plan_id: str) -> dict[str, int] | None:
    """该计划 run_key → 第几次（1-based）。历史读不到 ⇒ None（不猜）。"""
    try:
        runs = planrun.list_plan_runs(plan_id, limit=RUN_HISTORY_CAP)
    except Exception:
        logger.exception("run history unavailable for run_index: plan %s", plan_id)
        return None
    keys = sorted({str(r.get("run_key") or r.get("sk") or "") for r in runs if isinstance(r, dict)})
    return {k: i + 1 for i, k in enumerate(keys)}


def _run_index(run: dict, order_by_plan: dict | None = None) -> int | None:
    """「这个计划的第 N 次运行」：按 run_key（sk = plan_id#时间戳，字典序即时间序）升序数。
    历史读不到 / 本条不在窗口内 ⇒ None（不猜）。与前端 CompareView.seqOf 同口径（按 plan_id 分组）。

    order_by_plan：调用方给的 plan_id → 序号表的**局部**记忆（compare_sessions 两侧常同计划，
    甚至同一条 run）—— list_plan_runs 刻意不投影（方案页要 plan_synthesis 免拉 S3），
    每条带 2-4KB，同一份 500 条历史查两遍只为一个下标。省略则每次自己查（旧行为）。
    """
    plan_id, run_key = run.get("plan_id"), run.get("run_key")
    if not plan_id or not run_key:
        return None
    memo = order_by_plan if order_by_plan is not None else {}
    if plan_id not in memo:
        memo[plan_id] = _plan_run_order(plan_id)
    order = memo[plan_id]
    return None if order is None else order.get(run_key)


def _side(run: dict, found: dict, order_by_plan: dict | None = None) -> dict:
    return {
        "run_key": run.get("run_key"),
        "row_key": found["row_key"],
        "stage_type": found["stage_type"],
        "started_at": run.get("started_at") or None,
        "run_index": _run_index(run, order_by_plan),
        "events": _events_of(found),
        "attributes": _attributes_of(found),
        "results": _results_of(found, full=True),
    }


def _side_spec(spec, label: str) -> tuple[str, str]:
    spec = spec if isinstance(spec, dict) else {}
    run_key = str(spec.get("run_key") or "").strip()
    if not run_key:
        raise CompareError(f"{label}.run_key 不能为空")
    row_key = str(spec.get("row_key") or "").strip()
    if not row_key:
        raise CompareError(f"{label}.row_key 不能为空")
    return run_key, row_key


# ---------- 动作 ----------

def compare_sessions(left, right) -> dict:
    """{"left": {run_key, row_key}, "right": {...}} → session_compare 事件体（不含 event 键）。
    任何用户可读的失败抛 CompareError。"""
    l_run_key, l_row_key = _side_spec(left, "left")
    r_run_key, r_row_key = _side_spec(right, "right")
    l_run = _load_run(l_run_key)
    r_run = l_run if r_run_key == l_run_key else _load_run(r_run_key)
    l_found = _find_row(l_run, l_row_key)
    r_found = _find_row(r_run, r_row_key)
    order_by_plan: dict = {}  # 两侧同计划（很常见）⇒ 那 500 条历史只查一遍
    l_side = _side(l_run, l_found, order_by_plan)
    r_side = _side(r_run, r_found, order_by_plan)
    l_text = _align_text(l_found)
    return {
        "left": l_side,
        "right": r_side,
        "attribute_diff": attribute_diff(l_side["attributes"], r_side["attributes"]),
        "attribute_total": len(ATTRIBUTE_KEYS),
        "aligned": bool(l_text) and normalize_key(l_text) == normalize_key(_align_text(r_found)),
        "align_key": l_text,
    }


def pair_rows(left_run_key, right_run_key) -> dict:
    """两份 run 的全部行按题面归一化配对 → row_pairs 事件体。
    顺序：已对齐（按左侧行序）→ 左侧独有（左侧行序）→ 右侧独有（右侧行序）。
    同题多行按出现顺序一一配对（第 3 条左行配第 3 条同题右行）。"""
    l_key = str(left_run_key or "").strip()
    if not l_key:
        raise CompareError("left_run_key 不能为空")
    r_key = str(right_run_key or "").strip()
    if not r_key:
        raise CompareError("right_run_key 不能为空")
    l_run = _load_run(l_key)
    r_run = l_run if r_key == l_key else _load_run(r_key)

    def rows(run):
        out = []
        for key, st, stage_no, raw, cfg in _iter_rows(run):
            found = {"row_key": key, "stage_type": st, "stage_no": stage_no, "raw": raw, "cfg": cfg}
            out.append((found, _align_text(found)))
        return out

    l_rows, r_rows = rows(l_run), rows(r_run)
    unmatched_right = {}
    for idx, (found, text) in enumerate(r_rows):
        unmatched_right.setdefault(normalize_key(text), []).append(idx)
    matched_right: set[int] = set()
    aligned, left_only = [], []
    for found, text in l_rows:
        norm = normalize_key(text)
        bucket = unmatched_right.get(norm) if norm else None
        if bucket:
            j = bucket.pop(0)
            matched_right.add(j)
            r_found, _ = r_rows[j]
            aligned.append({"align_key": text,
                            "left_row_key": found["row_key"], "right_row_key": r_found["row_key"],
                            "left_results": _results_of(found, full=False),
                            "right_results": _results_of(r_found, full=False)})
        else:
            left_only.append({"align_key": text, "left_row_key": found["row_key"],
                              "right_row_key": None,
                              "left_results": _results_of(found, full=False), "right_results": None})
    right_only = [{"align_key": text, "left_row_key": None, "right_row_key": found["row_key"],
                   "left_results": None, "right_results": _results_of(found, full=False)}
                  for j, (found, text) in enumerate(r_rows) if j not in matched_right]
    pairs = aligned + left_only + right_only
    return {"pairs": pairs, "aligned": len(aligned), "total": len(pairs)}
