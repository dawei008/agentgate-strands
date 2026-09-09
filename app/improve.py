"""Turn diagnosis output into an adoptable improvement draft.

The report's action list says *what direction* to fix ("约束 agent 不得在无
工具结果时报出具体数据"); this module produces the *artifact*: a revised
system prompt, per-tool description rewrites, and whatever remains that
prompt/description changes cannot fix.

Evidence in, draft out — nothing is written back to the agent. The platform
cannot mutate a deployed agent's prompt, and should not: the draft is for a
human to review and apply in their own code.

Two output modes, decided by what the traces captured:
  - the system prompt was recovered  -> full revised prompt (minimal edits,
    original structure and language kept) plus a change list;
  - it was not                       -> paste-ready snippets with placement
    notes; inventing a "complete" prompt we never saw would be fiction.
"""

import asyncio
import json
import logging


logger = logging.getLogger("eval-anything")

# Enough sessions to show a pattern; more mostly repeats the same root causes
# and dilutes the prompt budget the revised text needs.
MAX_SESSIONS = 15
MAX_TOOLS = 30
LOW_SCORE = 0.7  # same threshold as diagnosis.needs_diagnosis


def collect_evidence(sessions: list[dict], agent_name: str) -> list[dict]:
    """Compact the report's per-session material into generator evidence.

    Keeps only what supports a change: low scores with their judge reasons,
    detected failures, root causes. Errored evaluators (score=None, judge
    infrastructure problems) and no_content sessions prove nothing about the
    agent and are dropped.
    """
    picked = []
    for s in sessions or []:
        if s.get("agent") != agent_name or s.get("error") or s.get("no_content"):
            continue
        diag = s.get("diagnosis") or {}
        low = {}
        for name, r in (s.get("results") or {}).items():
            score = r.get("score")
            if r.get("errored") or not isinstance(score, (int, float)):
                continue
            if score < LOW_SCORE:
                low[name] = {"score": score, "reason": str(r.get("reason", ""))[:400]}
        failures = diag.get("failures") or []
        root_causes = diag.get("root_causes") or []
        if not low and not failures and not root_causes:
            continue
        picked.append({
            "session_id": s.get("session_id"),
            "low_scores": low,
            "failures": failures,
            "root_causes": root_causes,
        })
    return picked[:MAX_SESSIONS]


PROPOSAL_SYSTEM_PROMPT = """你是资深 Agent 提示词工程师。你会收到一个已部署 AI Agent 的：
1. current_system_prompt —— 从真实运行 trace 恢复的系统提示词（可能为空，表示 trace 未采集到）
2. tools —— 工具清单（名称/描述/参数）
3. evidence —— 评估发现的问题，按会话组织：低分评估器的 judge 理由（low_scores）、
   故障检测结果（failures，含类别与证据）、根因分析（root_causes，含 fix_type 与修复方向）

任务：把"修复方向"落成**可直接采用的修改稿**，通过 submit_proposal 工具提交。

规则：
- current_system_prompt 非空时用 mode=full：保留原文的结构、语言和措辞，只做证据支持的最小
  修改，禁止整体重写或改变风格；每一处改动记入 changes。
- current_system_prompt 为空时用 mode=snippets：只给可粘贴片段并说明放哪，revised 留空；
  不要凭空编一份"完整"提示词——你没见过原文。
- 只修 evidence 里出现的问题；没有证据支持的"顺手优化"不要做。
- tool_descriptions 只能包含 tools 清单里真实存在的工具；没有工具描述类根因就给空数组。
- 每处修改的 why 必须落到具体 session_id 或故障类别，不得编造。
- 说明文字用中文；提示词正文（revised/snippets.text）保持原提示词的语言。"""

# Forced toolUse instead of "reply in JSON": prompt text routinely carries
# quotes/newlines that break hand-parsed JSON, and Bedrock validates tool
# input against this schema server-side.
_PROPOSAL_TOOL = {
    "toolSpec": {
        "name": "submit_proposal",
        "description": "提交最终改进稿",
        "inputSchema": {"json": {
            "type": "object",
            "properties": {
                "summary": {"type": "string",
                            "description": "一段话：改了什么、为什么（≤120字）"},
                "system_prompt": {
                    "type": "object",
                    "properties": {
                        "mode": {"type": "string", "enum": ["full", "snippets"]},
                        "revised": {"type": "string",
                                    "description": "mode=full 时完整修订版全文；否则空串"},
                        "snippets": {"type": "array", "items": {
                            "type": "object",
                            "properties": {
                                "placement": {"type": "string"},
                                "text": {"type": "string"},
                            },
                            "required": ["placement", "text"],
                        }},
                        "changes": {"type": "array", "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": ["新增", "修改", "删除"]},
                                "what": {"type": "string"},
                                "why": {"type": "string",
                                        "description": "引用 session_id 或故障类别"},
                            },
                            "required": ["kind", "what", "why"],
                        }},
                    },
                    "required": ["mode", "revised", "snippets", "changes"],
                },
                "tool_descriptions": {"type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "current": {"type": "string"},
                        "revised": {"type": "string"},
                        "why": {"type": "string"},
                    },
                    "required": ["name", "revised", "why"],
                }},
                "other_actions": {"type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "detail": {"type": "string",
                                   "description": "提示词/工具描述修不了的事（代码逻辑、超时、权限等）"},
                    },
                    "required": ["title", "detail"],
                }},
            },
            "required": ["summary", "system_prompt", "tool_descriptions", "other_actions"],
        }},
    }
}


async def propose(agent: dict, sessions: list[dict], judge_model: str,
                  lookback_days: int) -> dict:
    """Generate an improvement draft for one agent from report evidence.

    Raises ValueError with a user-facing message when there is nothing to work
    from or the generator's answer is unusable.
    """
    import redteam

    evidence = collect_evidence(sessions, agent["agent_name"])
    if not evidence:
        raise ValueError(
            "这些会话里没有可用于生成改进稿的证据（需要低分评估结果或诊断出的故障/根因）。")

    # Same trace-recovery path the red-team generator uses: system prompt,
    # declared tool inventory.
    spec = await asyncio.to_thread(redteam.build_target_spec, agent, lookback_days)
    current_prompt = (spec.get("system_prompt") or "")[:6000]
    tools = (spec.get("tools") or [])[:MAX_TOOLS]

    payload = {
        "current_system_prompt": current_prompt,
        "tools": tools,
        "evidence": evidence,
    }
    import judgellm
    # The full revised prompt can approach current_prompt's size, and
    # Sonnet 5 spends reasoning tokens out of the same budget -> 16k cap.
    resp = await asyncio.to_thread(
        judgellm.converse, judge_model, PROPOSAL_SYSTEM_PROMPT,
        json.dumps(payload, ensure_ascii=False), 16000,
        _PROPOSAL_TOOL, "submit_proposal")
    proposal = resp["tool_input"]
    if proposal is None:
        raise RuntimeError(
            f"改进稿生成未返回结构化结果（stopReason={resp.get('stopReason')}），"
            "疑似 maxTokens 被推理占满，可重试。")

    # A hallucinated tool row would send the user hunting a tool that doesn't
    # exist — drop anything not in the real inventory.
    real_tools = {t.get("name") for t in tools}
    proposal["tool_descriptions"] = [
        t for t in (proposal.get("tool_descriptions") or [])
        if t.get("name") in real_tools
    ]

    sp = proposal.get("system_prompt") or {}
    # Bedrock does not strictly enforce nested schema shapes: observed the model
    # returning system_prompt as a bare string (the prompt text itself).
    if isinstance(sp, str):
        sp = {"mode": "full" if current_prompt else "snippets",
              "revised": sp if current_prompt else "",
              "snippets": ([] if current_prompt else
                           [{"placement": "（模型未标注位置）", "text": sp}]),
              "changes": []}
        proposal["system_prompt"] = sp
    # The mode must reflect what we actually recovered, whatever the model said:
    # a "full" rewrite without an original is fiction, so demote it.
    if not current_prompt and sp.get("mode") == "full":
        sp["mode"] = "snippets"
        if sp.get("revised"):
            sp.setdefault("snippets", []).insert(
                0, {"placement": "（原提示词未采集到，此为模型起草的整体建议，谨慎采用）",
                    "text": sp["revised"]})
            sp["revised"] = ""
        proposal["system_prompt"] = sp

    fix_types: dict[str, int] = {}
    for e in evidence:
        for rc in e["root_causes"]:
            ft = rc.get("fix_type") or "OTHERS"
            fix_types[ft] = fix_types.get(ft, 0) + 1
    return {
        "proposal": proposal,
        "prompt_recovered": bool(current_prompt),
        # 原文随结果返回：前端要渲染修订前后的 diff，没有原文只能给全文替换。
        "current_prompt": current_prompt,
        "based_on": {
            "sessions": len(evidence),
            "failures": sum(len(e["failures"]) for e in evidence),
            "root_causes": sum(len(e["root_causes"]) for e in evidence),
            "fix_types": fix_types,
        },
    }
