// 展示口径统一批（fmt-converge）的 lib 原语直测 + 百分数分档表。
//
// 这四个函数是把「同一个量在不同页面印出不同样子」那族缺陷收成一处的落点：
//   · fmtPct / fmtPctInt —— 百分数两档，分档依据是**分母的量级**（注释在 scoring.ts）；
//   · clipText —— 第六份「截断加省略号」的唯一实现；
//   · shortSessionId —— 界面短会话 id 的唯一实现（原住 pages/plan/reportRows.ts）。
import { describe, it, expect } from "vitest";
import { fmtPct, fmtPctInt, runMetricChips } from "../src/lib/scoring";
import { clipText, shortSessionId } from "../src/lib/text";
import { fmtPct as homeFmtPct } from "../src/pages/agents/home/derive";
import { pct as reportPct } from "../src/pages/report/model";
import { stageNumbers } from "../src/pages/plan/derive";
import type { StageSummary } from "../src/pages/plan/types";

describe("fmtPct：一位小数（观测比率档）", () => {
  it("现网量级的比率保住那一位（整数档会把这两个数压成同一个）", () => {
    expect(fmtPct(0.006)).toBe("0.6%");
    expect(fmtPct(0.004)).toBe("0.4%");
    expect(fmtPct(0.018)).toBe("1.8%");
    expect(fmtPct(0.023)).toBe("2.3%");
  });
  it("零与满档", () => {
    expect(fmtPct(0)).toBe("0.0%");
    expect(fmtPct(1)).toBe("100.0%");
  });
  it("无值 / 非有限数 → 占位符（收敛前六处裸写会印 NaN%）", () => {
    expect(fmtPct(null)).toBe("—");
    expect(fmtPct(undefined)).toBe("—");
    expect(fmtPct(NaN)).toBe("—");
    expect(fmtPct(Infinity)).toBe("—");
  });
});

describe("fmtPctInt：整数（计数分母档）", () => {
  it("通过率那族：分母是用例数，只印整数", () => {
    expect(fmtPctInt(0.9)).toBe("90%");
    expect(fmtPctInt(0.875)).toBe("88%"); // 8 条里过 7 条
    expect(fmtPctInt(1)).toBe("100%");
    expect(fmtPctInt(0)).toBe("0%");
  });
  it("与收敛前的裸写 Math.round(v*100) 逐字同（含 .5 的舍入方向）", () => {
    for (const v of [0.005, 0.015, 0.125, 0.335, 0.665, 0.995]) {
      expect(fmtPctInt(v)).toBe(`${Math.round(v * 100)}%`);
    }
  });
  it("无值 / 非有限数 → 占位符", () => {
    expect(fmtPctInt(null)).toBe("—");
    expect(fmtPctInt(undefined)).toBe("—");
    expect(fmtPctInt(NaN)).toBe("—");
  });
  it("同一个 0.006 两档差一个数量级 —— 所以分档只能按量走，不能按页面走", () => {
    expect(fmtPct(0.006)).toBe("0.6%");
    expect(fmtPctInt(0.006)).toBe("1%");
  });
});

// ---------- 分档表：谁一位小数、谁整数 ----------
//
// 分档依据 = **量的分母**（不是页面）：
//   一位小数（fmtPct）  空响应率 / 工具调用失败率 / 异常率 / 拓扑主路占比
//                       —— 分母是会话量级，现网值 0.4%~2.3%；
//   整数（fmtPctInt）    dataset 通过率 / 逐评估器通过率 / 红队拦截率
//                       —— 分母是用例数或攻击数（10~50），一位小数是假精度。
//
// 入口判据用**函数同一性**（`toBe(同一个函数对象)`）而不是逐串对拍：某处漂回私写
// 实现时立刻红，且不必替每个页面造夹具。
describe("百分数分档表：各页入口指向 lib 的哪一档", () => {
  it("整数档入口：report/model.pct 就是 fmtPctInt 本身", () => {
    expect(reportPct).toBe(fmtPctInt);
  });

  it("一位小数档入口：agents/home/derive.fmtPct 就是 lib 的 fmtPct 本身", () => {
    expect(homeFmtPct).toBe(fmtPct);
  });

  it("run 结果 chip 的 dataset 通过率是整数档", () => {
    const chips = runMetricChips({
      status: "completed",
      stage_summaries: [{ type: "dataset", status: "completed", pass_rate: 0.875 }],
    });
    expect(chips).toEqual(["通过率 88%"]);
  });

  it("环节行关键数字的通过率与 chip 同精度（同一个量两个展示位）", () => {
    const stage = { type: "dataset", status: "completed", pass_rate: 0.875 } as StageSummary;
    expect(stageNumbers(stage)).toContain("通过率 88%");
  });

  it("守卫补上后：非有限数不再印 NaN%（收敛前六处裸写都会）", () => {
    expect(reportPct(NaN)).toBe("—");
    expect(homeFmtPct(NaN)).toBe("—");
  });
});

describe("clipText：截断加省略号", () => {
  it("超长截到 cap 并加「…」（cap 不含省略号）", () => {
    expect(clipText("abcdefghij", 4)).toBe("abcd…");
    expect(clipText("一二三四五", 2)).toBe("一二…");
  });
  it("恰好等长 / 更短 → 原样（不加省略号）", () => {
    expect(clipText("abcd", 4)).toBe("abcd");
    expect(clipText("ab", 4)).toBe("ab");
    expect(clipText("", 4)).toBe("");
  });
});

describe("shortSessionId：界面短显 = 首段 8 位 hex", () => {
  it("现网形态", () => {
    expect(shortSessionId("dsh-trace-e5d8fb96-7c21-4a19-9b3e-0f1a2b3c4d5e")).toBe("e5d8fb96");
  });
  it("mock 形态", () => {
    expect(shortSessionId("sess-7f3a9c21b8d4e6f0")).toBe("7f3a9c21");
  });
  it("没有 8 位 hex 段 → 原样（短 id 不许被截成认不出的样子）", () => {
    expect(shortSessionId("sess-abc")).toBe("sess-abc");
  });
  it("大写 hex 也认", () => {
    expect(shortSessionId("TRACE-E5D8FB96-XX")).toBe("E5D8FB96");
  });
  it("空 / null / undefined → 空串（调用方自己决定占位文案）", () => {
    expect(shortSessionId("")).toBe("");
    expect(shortSessionId(null)).toBe("");
    expect(shortSessionId(undefined)).toBe("");
  });
});
