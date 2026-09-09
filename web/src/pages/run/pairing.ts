// 消息配对（右栏「一问一答」）：USER 行 ↔ 其后第一个 assistant 事件；
// AGENT 行 ↔ 其前最近的 USER 事件。纯函数，只吃 session.events
// （ViewTranscriptEvent[]，已归一化），不发请求、不改 mock 形状。
//
// 「一轮」= 一个 USER 事件到下一个 USER 事件之前。回复只在本轮内找：两条 USER
// 连着出现（第一条没等到回复）时，第一条判「这轮没有 Agent 回复」，而不是把
// 第二条的回复借过去 —— 否则 USER→回复 与 AGENT→前问 两个方向配出的对子不一致。
import type { ViewTranscriptEvent } from "./types";

export interface TurnPair {
  /** 提问（USER 事件）；AGENT 行在它之前没有 USER 时为 null */
  user: ViewTranscriptEvent | null;
  /** 回复（本轮第一个 assistant 事件）；USER 行之后本轮没有 assistant 时为 null */
  reply: ViewTranscriptEvent | null;
  /** 提问与回复之间的 tool 事件（没有回复时：提问到本轮结束之间的） */
  tools: ViewTranscriptEvent[];
}

/** 与 trace 树节点同式的键：span_id 缺时用序号兜（`n<序号>`） */
export function spanKeyOf(ev: ViewTranscriptEvent): string {
  return ev.span_id ?? `n${ev.n}`;
}

function toolsBetween(events: ViewTranscriptEvent[], from: number, to: number): ViewTranscriptEvent[] {
  return events.slice(from + 1, to).filter((e) => e.type === "tool");
}

/** 本轮结束位（下一个 USER 的下标；没有则 events.length） */
function turnEnd(events: ViewTranscriptEvent[], userIdx: number): number {
  for (let i = userIdx + 1; i < events.length; i++) {
    if (events[i].type === "user") return i;
  }
  return events.length;
}

/**
 * 以 events[index] 为锚配一轮问答。
 *  - 锚是 user：reply = 本轮第一个 assistant；tools = 两者之间（无回复时到本轮结束）。
 *  - 锚是 assistant：user = 之前最近的 user；tools = 两者之间。
 *  - 锚是 tool / 越界：三位全空（调用方不该拿 tool 行来配）。
 */
export function pairTurn(events: ViewTranscriptEvent[], index: number): TurnPair {
  const anchor = events[index];
  if (!anchor) return { user: null, reply: null, tools: [] };

  if (anchor.type === "user") {
    const end = turnEnd(events, index);
    let replyIdx = -1;
    for (let i = index + 1; i < end; i++) {
      if (events[i].type === "assistant") { replyIdx = i; break; }
    }
    const reply = replyIdx >= 0 ? events[replyIdx] : null;
    return { user: anchor, reply, tools: toolsBetween(events, index, replyIdx >= 0 ? replyIdx : end) };
  }

  if (anchor.type === "assistant") {
    let userIdx = -1;
    for (let i = index - 1; i >= 0; i--) {
      if (events[i].type === "user") { userIdx = i; break; }
    }
    const user = userIdx >= 0 ? events[userIdx] : null;
    return { user, reply: anchor, tools: userIdx >= 0 ? toolsBetween(events, userIdx, index) : [] };
  }

  return { user: null, reply: null, tools: [] };
}
