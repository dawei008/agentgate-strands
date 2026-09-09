// simplify-r2 Track D · S9 的对刑测试：LiveTurnsPanel 折叠条**三种可达状态**的
// DOM 逐字节钉死。
//
// 背景：`{folded > 0 && …}` 与 `{folded <= 0 && expanded && …}` 是两个互斥块，
// 同 className、同 `-expand` testid、同 onToggle，第二个只少了计数文字并硬编码了
// 共享三元本就产出的按钮标签（backlog S9）。合并成一块前先把三种状态的 outerHTML
// 记下来 —— 合并后必须一字不差，否则这条红。
//
// 三种可达状态（folded = lane.total - 可见轮数）：
//   1. folded > 0            —— 有折叠计数（展开态/收起态各一份按钮文案）
//   2. folded <= 0 && 展开   —— 只剩「只看最近 N 轮」按钮（展开后内存里就是全文）
//   3. folded <= 0 && 收起   —— 整块不存在
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import LiveTurnsPanel from "../src/pages/plan/LiveTurnsPanel";
import { LANE_TAIL, type LiveLane, type LiveTurn, type LiveTurnsState } from "../src/pages/plan/liveTurns";

const TS = 1786438800000;

function turn(seq: number): LiveTurn {
  return {
    seq, role: "attacker", roleRaw: null, turnNo: seq,
    message: `第 ${seq} 条`, ts: TS, blank: null,
  };
}

/** 一路：total 与内存里保留的轮数分开给（dropped = 真丢弃的老轮次） */
function lane(key: string, kept: number, dropped: number): LiveLane {
  return {
    key, kind: "redteam", caseKey: key, agentName: null,
    turns: Array.from({ length: kept }, (_, i) => turn(i + 1)),
    dropped, total: kept + dropped, blank: 0, lastTs: TS,
  };
}

function state(lanes: LiveLane[]): LiveTurnsState {
  return {
    lanes,
    total: lanes.reduce((n, l) => n + l.total, 0),
    attacker: 0, target: 0, user: 0, agent: 0, other: 0, blank: 0,
    retiredLanes: 0, retiredTurns: 0,
  };
}

/** 某一路的折叠条 outerHTML（不存在 → null） */
function foldHtml(laneKey: string): string | null {
  const el = screen.getByTestId(`plan-live-lane-${laneKey}`);
  return el.querySelector(".atk-fold")?.outerHTML ?? null;
}

afterEach(cleanup);

describe("S9 · 折叠条三态 DOM（合并互斥块前后必须逐字节相同）", () => {
  it("LANE_TAIL 仍是 3（下面的字面 HTML 依赖它）", () => {
    expect(LANE_TAIL).toBe(3);
  });

  it("状态 1 收起态：计数 + 「展开本路」", () => {
    render(<LiveTurnsPanel turns={state([lane("attack#1", 5, 0)])} live />);
    expect(foldHtml("attack-1")).toBe(
      '<div class="atk-fold">前 2 条已折叠'
      + '<button type="button" class="btn-link atk-fold-btn"'
      + ' data-testid="plan-live-lane-attack-1-expand">展开本路</button></div>',
    );
  });

  it("状态 1 展开态 + 有真丢弃：计数带「已释放」小句，按钮变「只看最近 3 条」", () => {
    render(<LiveTurnsPanel turns={state([lane("attack#2", 8, 6)])} live />);
    fireEvent.click(screen.getByTestId("plan-live-lane-attack-2-expand"));
    expect(foldHtml("attack-2")).toBe(
      '<div class="atk-fold">前 6 条已折叠（其中 6 条已释放，不再留存全文）'
      + '<button type="button" class="btn-link atk-fold-btn"'
      + ' data-testid="plan-live-lane-attack-2-expand">只看最近 3 条</button></div>',
    );
  });

  it("状态 2（folded<=0 且展开）：只剩按钮，没有计数文字", () => {
    render(<LiveTurnsPanel turns={state([lane("attack#3", 5, 0)])} live />);
    fireEvent.click(screen.getByTestId("plan-live-lane-attack-3-expand"));
    expect(foldHtml("attack-3")).toBe(
      '<div class="atk-fold">'
      + '<button type="button" class="btn-link atk-fold-btn"'
      + ' data-testid="plan-live-lane-attack-3-expand">只看最近 3 条</button></div>',
    );
  });

  it("状态 3（folded<=0 且收起）：整块不存在，也没有 -expand 按钮", () => {
    render(<LiveTurnsPanel turns={state([lane("attack#4", 2, 0)])} live />);
    expect(foldHtml("attack-4")).toBeNull();
    expect(screen.queryByTestId("plan-live-lane-attack-4-expand")).toBeNull();
  });

  it("同屏三态互不干扰（一路展开不影响另一路）", () => {
    render(<LiveTurnsPanel turns={state([
      lane("attack#1", 5, 0), lane("attack#2", 2, 0),
    ])} live />);
    fireEvent.click(screen.getByTestId("plan-live-lane-attack-1-expand"));
    expect(foldHtml("attack-1")).toContain("只看最近 3 条");
    expect(foldHtml("attack-2")).toBeNull();
  });
});
