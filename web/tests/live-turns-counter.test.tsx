// 实时对话头行计数的三处措辞（档 live-turns-counter-two-denominators）。
//
// 现场：用户看现网 run 直接问「显示累计 6 轮，为什么只看到 3 轮」。真相是**没有
// 任何数据被隐藏** —— 3 路 × 每路 2 条 = 6，尾窗 LANE_TAIL=3 根本没触发。三处措辞
// 在骗人，逐条钉在下面：
//   ① 分母裸着并排：「累计 6 轮」是**跨路合计**，紧跟的「本页只留每路最近 3 轮」
//      是**每路上限** —— 两个不同分母摆在一起，只能被读成「6 条里只给我看 3 条」。
//      改成把路数写进合计（「3 路合计 6 条」）。
//   ② 截断提示**无条件**印：没触发也印，与本仓「无条件印出没发生的事」同族。
//      改成只在真折叠时印，且印**实际折叠掉的条数**。
//   ③ 单位词：这个数数的是**单条消息**（用户 1 + Agent 1 = 2），印成「2 轮」违反
//      直觉（人认为一轮 = 一问一答）→ 一律「条」。
//
// 直渲 LiveTurnsPanel + 手搓 LiveTurnsState（同 r2-consolidation-live-turns 的
// 夹具手法）：要钉的是「同一份数据下头行怎么说」，不必过一整条流。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import LiveTurnsPanel, { laneTestId } from "../src/pages/plan/LiveTurnsPanel";
import {
  LANE_TAIL, type LiveLane, type LiveTurn, type LiveTurnsState,
} from "../src/pages/plan/liveTurns";

const TS = 1786438800000;

function turn(seq: number, role: LiveTurn["role"]): LiveTurn {
  return { seq, role, roleRaw: null, turnNo: seq, message: `第 ${seq} 条`, ts: TS, blank: null };
}

/** 一路：kept = 内存里还留着的条数，dropped = 已真丢弃的老条数 */
function lane(key: string, kept: number, dropped = 0): LiveLane {
  return {
    key, kind: "dataset", caseKey: key, agentName: "support-bot",
    turns: Array.from({ length: kept }, (_, i) => turn(i + 1, i % 2 === 0 ? "user" : "agent")),
    dropped, total: kept + dropped, blank: 0, lastTs: TS,
  };
}

function state(lanes: LiveLane[], extra: Partial<LiveTurnsState> = {}): LiveTurnsState {
  const total = lanes.reduce((n, l) => n + l.total, 0);
  return {
    lanes, total,
    attacker: 0, target: 0,
    user: Math.ceil(total / 2), agent: Math.floor(total / 2),
    other: 0, blank: 0, retiredLanes: 0, retiredTurns: 0,
    ...extra,
  };
}

const countText = () => screen.getByTestId("plan-live-turns-count").textContent ?? "";

afterEach(cleanup);

describe("实时对话头行计数：分母、截断提示、单位词", () => {
  it("防恒真：LANE_TAIL 仍是 3（下面两条用例的数字依赖它）", () => {
    expect(LANE_TAIL).toBe(3);
  });

  it("每路 2 条 × 3 路（一条都没折叠）：合计带路数分母，**不出现**截断提示", () => {
    // 用户当时看到的正是这一屏：6 条全在，界面却说「只留每路最近 3 轮」
    render(<LiveTurnsPanel turns={state([lane("case-1", 2), lane("case-2", 2), lane("case-3", 2)])} live />);
    expect(countText()).toContain("3 路合计 6 条");
    // 截断没发生就不许提截断（本仓「无条件印出没发生的事」同族缺陷）
    expect(countText()).not.toContain("已折叠");
    expect(countText()).not.toContain("只显示最近");
    // 单位词：一律「条」，不许再出现「N 轮」这种把一问一答数成两轮的说法
    expect(countText()).not.toMatch(/\d+ 轮/);
  });

  it("某路 5 条（尾窗真触发）：出现提示且写明折叠掉 2 条", () => {
    render(<LiveTurnsPanel turns={state([lane("case-1", 5)])} live />);
    expect(countText()).toContain("1 路合计 5 条");
    expect(countText()).toContain(`每路只显示最近 ${LANE_TAIL} 条`);
    expect(countText()).toContain("已折叠 2 条");
  });

  it("折叠条数按**当前视图**算：那一路展开后提示自己消失", () => {
    render(<LiveTurnsPanel turns={state([lane("case-1", 5)])} live />);
    expect(countText()).toContain("已折叠 2 条");
    fireEvent.click(screen.getByTestId(`${laneTestId("case-1")}-expand`));
    expect(countText()).not.toContain("已折叠");
  });

  it("多路只有一路触发：折叠数是各路之和，不按最长那路虚报", () => {
    render(<LiveTurnsPanel turns={state([lane("case-1", 5), lane("case-2", 2), lane("case-3", 7)])} live />);
    // case-1 折 2 + case-3 折 4 = 6（case-2 一条没折）
    expect(countText()).toContain("3 路合计 14 条");
    expect(countText()).toContain("已折叠 6 条");
  });

  it("已释放（真丢弃）与已淘汰路数的量词同步改「条」", () => {
    render(<LiveTurnsPanel
      turns={state([lane("case-1", 4, 6)], { retiredLanes: 1, retiredTurns: 3 })}
      live
    />);
    expect(countText()).toContain("已结束的 1 路共 3 条已释放");
    expect(countText()).not.toMatch(/\d+ 轮/);
  });
});
