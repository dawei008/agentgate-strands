// duration-format-minute-carry：时长格式化进位错——分钟向下取整、秒四舍五入互不
// 联动，s%60 ∈ [59.5, 60) 时秒位进到 60 而分钟不动，渲染出不存在的「1m60s」。
// 真实输入带一位小数（testrun.py 用例耗时保留 1 位），该区间可达。
//
// 两处同型实现分开钉（格式差异——秒位是否补零——是 RunDetailPage.tsx 注释声明的
// **刻意**差异，不合并、不互抄）：
//   - web/src/pages/run/RunDetailPage.tsx fmtDur（补零形态 "2m00s"）
//   - web/src/lib/scoring.ts fmtDuration（无补零形态 "2m0s"；运行历史/报告抽屉/导出）
import { describe, expect, it } from "vitest";
import { fmtDur } from "../src/pages/run/RunDetailPage";
import { fmtDuration } from "../src/lib/scoring";

describe("fmtDur（运行详情页，补零形态）：进位带不再出「60 秒」", () => {
  it("本缺陷专属锚点：119.5–120 输出 2 分 0 秒形态，不是 1m60s", () => {
    expect(fmtDur(119.6)).toBe("2m00s");
    expect(fmtDur(119.5)).toBe("2m00s");
    expect(fmtDur(119.99)).toBe("2m00s");
  });

  it("小时量级同带：3599.6 → 60m00s（不是 59m60s）", () => {
    expect(fmtDur(3599.6)).toBe("60m00s");
  });

  it("回归钉：进位带之外逐字节不变", () => {
    expect(fmtDur(0)).toBe("0s");
    expect(fmtDur(0.4)).toBe("0.4s"); // <60 分支原样透出小数，行为不变
    expect(fmtDur(59.4)).toBe("59.4s");
    expect(fmtDur(60)).toBe("1m00s");
    expect(fmtDur(74)).toBe("1m14s");
    expect(fmtDur(119.4)).toBe("1m59s");
  });

  it("null / undefined 行为不变", () => {
    expect(fmtDur(null)).toBe("—");
    expect(fmtDur(undefined)).toBe("—");
  });
});

describe("fmtDuration（lib/scoring，无补零形态）：进位带不再出「60 秒」", () => {
  it("本缺陷专属锚点：119.5–120 输出 2 分 0 秒形态，不是 1m60s", () => {
    expect(fmtDuration(119.6)).toBe("2m0s");
    expect(fmtDuration(119.5)).toBe("2m0s");
    expect(fmtDuration(119.99)).toBe("2m0s");
  });

  it("同族退化带：<60 分支四舍五入后到 60 也要进位（59.6 → 1m0s，不是 60s）", () => {
    expect(fmtDuration(59.6)).toBe("1m0s");
  });

  it("小时量级同带：3599.6 → 60m0s（不是 59m60s）", () => {
    expect(fmtDuration(3599.6)).toBe("60m0s");
  });

  it("回归钉：进位带之外逐字节不变", () => {
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(0.4)).toBe("0s"); // 本函数一直取整，行为不变
    expect(fmtDuration(45)).toBe("45s");
    expect(fmtDuration(59.4)).toBe("59s");
    expect(fmtDuration(60)).toBe("1m0s");
    expect(fmtDuration(74)).toBe("1m14s");
    expect(fmtDuration(119.4)).toBe("1m59s");
  });

  it("null / undefined 行为不变", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(undefined)).toBe("—");
  });
});

describe("边界表不变式：两函数的秒位恒 < 60", () => {
  const SEC = /(?:\d+m)?([\d.]+)s$/;
  const CASES = [0, 0.4, 59.4, 59.6, 60, 74, 119.4, 119.5, 119.6, 119.99, 3599.6, 7199.7];
  it.each(CASES)("s=%s", (s) => {
    for (const out of [fmtDur(s), fmtDuration(s)]) {
      const m = SEC.exec(out);
      expect(m, `${out} 应形如 [Nm]Ns`).not.toBeNull();
      expect(Number(m![1]), `${out} 的秒位应 < 60`).toBeLessThan(60);
    }
  });
});
