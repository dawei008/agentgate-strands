"""Build a numbered conversation timeline from a mapped Session.

Timeline events (in session start-time order):
  {"n": 1, "type": "user"|"assistant"|"tool", "t_offset_s": 1.23, ...,
   "span_id": str|None, "parent_span_id": str|None}
    user/assistant: {"text": full text}
    tool: {"name", "arguments", "result", "error", "duration_s"}
  span_id/parent_span_id come from the originating span's SpanInfo (None when
  telemetry lacks them) so the UI can join events back to raw trace spans;
  they are kept OUT of the duplicate-collapse key so #N anchors don't shift.

The numbering (#N) is the anchor scheme the analysis references
([session:ID#N]) and the UI scrolls to. system_prompt is returned separately
(long, collapsed by default in the drawer).
"""

MAX_EVENTS = 200
SLOW_SECONDS = 3.0


def _ts(dt):
    return dt.timestamp() if dt else None


def build_transcript(session) -> dict:
    """session: strands_evals Session (trajectory). Returns {events, system_prompt, truncated}."""
    raw = []  # (sort_ts, type, payload, (span_id, parent_span_id))
    system_prompt = None

    for trace in session.traces:
        for span in trace.spans:
            kind = type(span).__name__
            si = span.span_info
            start, end = _ts(si.start_time), _ts(si.end_time)
            # span identity for the trace view; None when telemetry lacks it
            span_ids = (getattr(si, "span_id", None) or None,
                        getattr(si, "parent_span_id", None) or None)

            # sub-agent identity, when telemetry provides it (multi-agent
            # orchestration with named agents); generic values are noise.
            meta = span.metadata or {}
            agent_name = meta.get("gen_ai.agent.name") or meta.get("agent.name") or None
            if agent_name in ("Strands Agents",):
                agent_name = None
            marker = {"agent": agent_name} if agent_name else {}

            if kind == "AgentInvocationSpan":
                if not system_prompt:
                    system_prompt = meta.get("system_prompt") or getattr(span, "system_prompt", None)
                if span.user_prompt:
                    raw.append((start or 0, "user",
                                {"text": str(span.user_prompt), **marker}, span_ids))
                if span.agent_response:
                    # anchor the reply at span end (after tools ran)
                    raw.append((end or start or 0, "assistant",
                                {"text": str(span.agent_response), **marker}, span_ids))

            elif kind == "ToolExecutionSpan":
                tc, tr_ = span.tool_call, span.tool_result
                duration = round(end - start, 2) if start and end else None
                raw.append(
                    (start or 0, "tool", {
                        "name": tc.name if tc else "?",
                        "arguments": tc.arguments if tc else None,
                        "result": str(tr_.content)[:2000] if tr_ and tr_.content is not None else None,
                        "error": str(tr_.error) if tr_ and tr_.error else None,
                        "duration_s": duration,
                        "slow": bool(duration and duration >= SLOW_SECONDS),
                        **marker,
                    }, span_ids)
                )

    # mapper drops the system_prompt attribute; recover it from raw spans
    if not system_prompt:
        try:
            import patches
            for sp in patches.LAST_PARSED_SPANS:
                v = (sp.get("attributes") or {}).get("system_prompt")
                if v:
                    system_prompt = v
                    break
        except Exception:
            pass

    raw.sort(key=lambda x: x[0])
    truncated = len(raw) > MAX_EVENTS
    raw = raw[:MAX_EVENTS]

    t0 = raw[0][0] if raw else 0
    events = []
    seen = set()
    for ts, etype, payload, (span_id, parent_span_id) in raw:
        # collapse exact duplicates (same text re-reported across traces);
        # span ids stay out of the key so re-reported spans still collapse
        key = (etype, str(payload)[:300])
        if key in seen:
            continue
        seen.add(key)
        events.append({
            "n": len(events) + 1,
            "type": etype,
            "t_offset_s": round(ts - t0, 2) if ts else None,
            **payload,
            "span_id": span_id,
            "parent_span_id": parent_span_id,
        })

    return {
        "events": events,
        "system_prompt": str(system_prompt)[:6000] if system_prompt else None,
        "truncated": truncated,
    }


def to_interactions(transcript: dict) -> list[dict]:
    """Convert a timeline into InteractionsEvaluator's Interaction list.

    Each event becomes one interaction node; dependencies point at the
    previous node, expressing the sequential flow observed in the trace.
    Sub-agent names (event['agent']) become node names when present.
    """
    interactions = []
    prev = None
    for ev in transcript.get("events", []):
        if ev["type"] == "tool":
            node = ev.get("agent") or f"tool:{ev.get('name', '?')}"
            msg = f"调用 {ev.get('name')}({ev.get('arguments')}) -> {str(ev.get('result'))[:400]}"
            if ev.get("error"):
                msg += f" [error: {ev['error']}]"
        else:
            node = ev.get("agent") or ev["type"]
            msg = str(ev.get("text", ""))[:1200]
        interactions.append({
            "node_name": f"#{ev['n']} {node}",
            "dependencies": [prev] if prev else [],
            "messages": [msg],
        })
        prev = f"#{ev['n']} {node}"
    return interactions


def transcript_for_judge(transcript: dict, limit_chars: int = 4000) -> list[dict]:
    """Compact numbered view fed to the analysis judge so it can cite #N."""
    out = []
    used = 0
    for ev in transcript.get("events", []):
        if ev["type"] == "tool":
            text = f"#{ev['n']} [tool {ev['name']}({ev.get('arguments')})] -> {str(ev.get('result'))[:120]}"
            if ev.get("slow"):
                text += f" (slow {ev['duration_s']}s)"
        else:
            text = f"#{ev['n']} [{ev['type']}] {str(ev.get('text'))[:200]}"
        used += len(text)
        if used > limit_chars:
            out.append({"n": ev["n"], "text": "…(truncated)"})
            break
        out.append({"n": ev["n"], "text": text})
    return out
