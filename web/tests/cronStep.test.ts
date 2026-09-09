// 缺陷 1 回归：`a/b`（起始值 + 步长，无区间）的步长曾被整段丢弃。
// cron 语义：`a/b` ≡ `a-<该字段上界>/b`（从 a 起、每 b 步、到字段上界为止），
// 与 `*/b`（≡ `min-max/b`）、`a-b/c` 同族。丢步长 ⇒ 频率被静默低估数倍：
// `cron(0/15 * ? * * *)` 真实语义每小时 4 次，保存前唯一的频率-成本护栏
// （下次运行预览 + 人话描述）却按每小时 1 次显示。
//
// 各字段上界口径（parseField 的 min/max，随方言不同）：
//   分 0–59、时 0–23、日 1–31、月 1–12、年 1970–2199
//   周：标准五段 0–7（0/7 均为周日），EventBridge 1–7（1=周日，解析后统一 -1 平移）
import { describe, expect, it } from "vitest";
import { humanize, nextRuns, parseCron } from "../src/pages/plan/cronEngine";

/** 内部标准五段的段下标（parseCron 的 f） */
const MIN = 0, HOUR = 1, DOM = 2, MON = 3, DOW = 4;
const SEG_NAME = ["分", "时", "日", "月", "周"];

function setOf(expr: string, seg: number): number[] {
  const p = parseCron(expr);
  if (!p.ok) throw new Error(`应解析成功但失败：${expr} → ${p.err}`);
  return [...p.f[seg].set].sort((a, b) => a - b);
}

// 基准时间与 cronEngine.test.ts 一致：2026-08-22 00:47 UTC（周六）
const NOW = new Date(Date.UTC(2026, 7, 22, 0, 47, 0));
const iso = (d: Date) => d.toISOString().slice(0, 16);

describe("parseField：a/b 步长语义（缺陷 1）", () => {
  const cases: [expr: string, seg: number, want: number[], why: string][] = [
    // ---- 缺陷本体：a/b 形式，两方言 ----
    ["0/15 * * * *", MIN, [0, 15, 30, 45], "五段式 0/15 ≡ 0-59/15"],
    ["cron(0/15 * ? * * *)", MIN, [0, 15, 30, 45], "EB 六段 0/15，用户实测表达式"],
    ["5/10 * * * *", MIN, [5, 15, 25, 35, 45, 55], "起始值非 0"],
    ["0/5 * * * *", MIN, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55], "12 倍频那一档"],
    // ---- 上界钳制：起始值 + 步长越过上界时只剩起始值本身 ----
    ["50/20 * * * *", MIN, [50], "分上界 59：50+20=70 越界"],
    ["0 20/3 * * *", HOUR, [20, 23], "时上界 23：23 命中，26 越界"],
    ["0 22/5 * * *", HOUR, [22], "时上界 23：22+5=27 越界"],
    ["0 0 25/10 * *", DOM, [25], "日上界 31：25+10=35 越界"],
    ["0 0 1 11/3 *", MON, [11], "月上界 12：11+3=14 越界"],
    // ---- 其余字段的正确上界 ----
    ["0 0/6 * * *", HOUR, [0, 6, 12, 18], "时上界 23"],
    ["cron(0 9/5 ? * * *)", HOUR, [9, 14, 19], "时上界 23（EB）"],
    ["0 0 1/10 * *", DOM, [1, 11, 21, 31], "日上界 31（下界是 1 不是 0）"],
    ["0 0 1 2/4 *", MON, [2, 6, 10], "月上界 12"],
    ["0 0 1 JAN/6 *", MON, [1, 7], "英文月名 + 步长"],
    // ---- 周字段：两方言取值域不同（标准 0–7；EB 1–7 且 1=周日，解析后 -1）----
    ["0 0 * * 2/2", DOW, [2, 4, 6], "标准周：2,4,6（8 越界 7）"],
    ["0 0 * * 1/3", DOW, [0, 1, 4], "标准周上界 7：1,4,7 → 7 归一为 0（周日）"],
    ["cron(0 0 ? * 2/2 *)", DOW, [1, 3, 5], "EB 周 2,4,6=一三五 → 平移 1,3,5"],
    ["cron(0 0 ? * 6/4 *)", DOW, [5], "EB 周上界 7：6=周五，10 越界"],
    // ---- 回归：原本就正确的两种步长形式不得变形 ----
    ["*/15 * * * *", MIN, [0, 15, 30, 45], "回归：*/b"],
    ["0-59/15 * * * *", MIN, [0, 15, 30, 45], "回归：a-b/c 覆盖全域"],
    ["0-30/10 * * * *", MIN, [0, 10, 20, 30], "回归：a-b/c 半域（不得扩到上界）"],
    ["0 9-18 * * 1,3,5", HOUR, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18], "回归：无步长区间"],
    ["0/15 * * * *", HOUR, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], "回归：同表达式其它段仍为全集"],
    // ---- 逗号列表里每一项各自算步长 ----
    ["0,30/20 * * * *", MIN, [0, 30, 50], "列表项独立：{0} ∪ {30,50}"],
    // ---- 年字段（EB 第 6 段）上界 2199 ----
    ["cron(0 0 1 1 ? 2026/50)", -1, [2026, 2076, 2126, 2176], "年上界 2199"],
  ];

  it.each(cases)("%s 的%s段 → %j（%s）", (expr, seg, want) => {
    if (seg < 0) {
      const p = parseCron(expr);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(p.year).not.toBeNull();
      expect([...p.year!.set].sort((a, b) => a - b)).toEqual(want);
      return;
    }
    expect(setOf(expr, seg)).toEqual(want);
  });

  it("a/b 与等价的 a-<上界>/b 解析结果全等（分/时/日/月）", () => {
    const pairs: [string, string, number][] = [
      ["0/15 * * * *", "0-59/15 * * * *", MIN],
      ["7/13 * * * *", "7-59/13 * * * *", MIN],
      // 步长 1 也是步长：`a/1` 是 a 到上界的每一格，不是单值 a（判据是「有没有 /」）
      ["5/1 * * * *", "5-59/1 * * * *", MIN],
      ["0 5/4 * * *", "0 5-23/4 * * *", HOUR],
      ["0 0 3/7 * *", "0 0 3-31/7 * *", DOM],
      ["0 0 1 3/2 *", "0 0 1 3-12/2 *", MON],
    ];
    for (const [a, b, seg] of pairs) {
      expect(setOf(a, seg), `${a} 应等价于 ${b}（${SEG_NAME[seg]}）`).toEqual(setOf(b, seg));
    }
  });

  it("非法步长仍拒收（步长修复不得放宽校验）", () => {
    expect(parseCron("0/0 * * * *").ok).toBe(false);   // 步长 0
    expect(parseCron("0/x * * * *").ok).toBe(false);   // 步长非数字
    expect(parseCron("60/5 * * * *").ok).toBe(false);  // 起始值越界
    expect(parseCron("0 0 0/5 * *").ok).toBe(false);   // 日下界是 1
    expect(parseCron("0/5/2 * * * *").ok).toBe(false); // 多斜杠
  });
});

describe("a/b 步长的成本护栏：下次运行预览 + 人话描述（缺陷 1 的用户可见面）", () => {
  it("cron(0/15 * ? * * *) 未来 4 次 = 01:00/01:15/01:30/01:45（不是每小时一次）", () => {
    const runs = nextRuns(parseCron("cron(0/15 * ? * * *)"), NOW, 4).map(iso);
    expect(runs).toEqual([
      "2026-08-22T01:00", "2026-08-22T01:15", "2026-08-22T01:30", "2026-08-22T01:45",
    ]);
  });

  it("一小时窗口内触发次数 = 步长真实频率（0/15 → 4 次；0/5 → 12 次）", () => {
    const inOneHour = (expr: string) =>
      nextRuns(parseCron(expr), NOW, 60).filter((d) => d.getTime() <= NOW.getTime() + 3600e3).length;
    expect(inOneHour("cron(0/15 * ? * * *)")).toBe(4);
    expect(inOneHour("cron(0/5 * ? * * *)")).toBe(12);
  });

  it("5/10 * * * *（五段式）未来 3 次 = 00:55/01:05/01:15", () => {
    const runs = nextRuns(parseCron("5/10 * * * *"), NOW, 3).map(iso);
    expect(runs).toEqual(["2026-08-22T00:55", "2026-08-22T01:05", "2026-08-22T01:15"]);
  });

  it("人话描述报出全部触发分钟，不再只说一个", () => {
    expect(humanize(parseCron("0/15 * * * *")))
      // 「每小时 的第」的多余空格已修（issue cron-humanize-hourly-extra-space）——
      // 本 it 守的是「报出全部触发分钟」，期望串跟着新排版走
      .toBe("每小时的第 0、15、30、45 分 UTC 运行");
    expect(humanize(parseCron("5/10 * * * *")))
      .toBe("每小时的第 5、15、25、35、45、55 分 UTC 运行");
  });
});
