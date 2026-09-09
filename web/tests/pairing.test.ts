// 右栏「一问一答」配对纯函数：USER→本轮第一个回复 / AGENT→之前最近的 USER。
// 夹具照 mocks/handlers 的 MOCK_TRANSCRIPT_EVENTS 形状（两轮：#1→#4、#5→#9），
// 这里直接手写视图形态（已归一化），不经页面。
import { describe, expect, it } from "vitest";
import { pairTurn, spanKeyOf } from "../src/pages/run/pairing";
import type { ViewTranscriptEvent } from "../src/pages/run/types";

function ev(
  n: number,
  type: ViewTranscriptEvent["type"],
  t: number | null,
  extra: Partial<ViewTranscriptEvent> = {},
): ViewTranscriptEvent {
  return {
    n, type, t_offset_s: t, span_id: `sp-${n}`, parent_span_id: null,
    text: type === "tool" ? "" : `msg-${n}`, name: type === "tool" ? `tool-${n}` : "",
    error: null, ...extra,
  };
}

/** 两轮：#1 USER → #2 #3 TOOL → #4 AGENT；#5 USER → #6 #7(err) #8(err) TOOL → #9 AGENT */
const TWO_TURNS: ViewTranscriptEvent[] = [
  ev(1, "user", 0.0),
  ev(2, "tool", 0.4),
  ev(3, "tool", 2.3),
  ev(4, "assistant", 3.0),
  ev(5, "user", 18.4),
  ev(6, "tool", 18.8),
  ev(7, "tool", 23.1, { error: "UpstreamTimeout: no response in 300ms" }),
  ev(8, "tool", 23.4, { error: "UpstreamTimeout: no response in 300ms" }),
  ev(9, "assistant", 24.7),
];

describe("pairTurn", () => {
  it("USER 锚：回复 = 之后第一个 assistant；tools = 两者之间的 tool 事件", () => {
    const p = pairTurn(TWO_TURNS, 0);
    expect(p.user?.n).toBe(1);
    expect(p.reply?.n).toBe(4);
    expect(p.tools.map((t) => t.n)).toEqual([2, 3]);
  });

  it("多轮：第二个 USER 配自己那轮的回复（#9），不越到第一轮；失败数从 error 现算", () => {
    const p = pairTurn(TWO_TURNS, 4);
    expect(p.user?.n).toBe(5);
    expect(p.reply?.n).toBe(9);
    expect(p.tools.map((t) => t.n)).toEqual([6, 7, 8]);
    expect(p.tools.filter((t) => t.error).length).toBe(2);
  });

  it("AGENT 锚：提问 = 之前最近的 USER（#9 → #5，不是 #1）", () => {
    const p = pairTurn(TWO_TURNS, 8);
    expect(p.reply?.n).toBe(9);
    expect(p.user?.n).toBe(5);
    expect(p.tools.map((t) => t.n)).toEqual([6, 7, 8]);
    const p4 = pairTurn(TWO_TURNS, 3);
    expect(p4.user?.n).toBe(1);
  });

  it("无回复：USER 之后没有 assistant ⇒ reply null，tools 数到本轮结束", () => {
    const events = [ev(1, "user", 0), ev(2, "tool", 0.5), ev(3, "tool", 1.0, { error: "boom" })];
    const p = pairTurn(events, 0);
    expect(p.reply).toBeNull();
    expect(p.tools.map((t) => t.n)).toEqual([2, 3]);
  });

  it("两条 USER 连着：第一条不借第二条的回复（两个方向配出的对子一致）", () => {
    const events = [ev(1, "user", 0), ev(2, "user", 1), ev(3, "assistant", 2)];
    expect(pairTurn(events, 0).reply).toBeNull();
    expect(pairTurn(events, 1).reply?.n).toBe(3);
    expect(pairTurn(events, 2).user?.n).toBe(2);
  });

  it("AGENT 之前没有 USER ⇒ user null；tool 锚 / 越界 ⇒ 三位全空", () => {
    const events = [ev(1, "assistant", 0), ev(2, "tool", 1)];
    expect(pairTurn(events, 0)).toEqual({ user: null, reply: events[0], tools: [] });
    expect(pairTurn(events, 1)).toEqual({ user: null, reply: null, tools: [] });
    expect(pairTurn(events, 9)).toEqual({ user: null, reply: null, tools: [] });
  });

  it("spanKeyOf：span_id 缺时用 n<序号> 兜，与 trace 树节点同式", () => {
    expect(spanKeyOf(ev(3, "tool", 0))).toBe("sp-3");
    expect(spanKeyOf(ev(5, "tool", 0, { span_id: null }))).toBe("n5");
  });
});
