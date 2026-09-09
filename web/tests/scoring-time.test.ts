// lib/scoring.ts 的时间解析契约测试（H-1）。
//
// 为什么单独一个文件：后端**所有** run 时间戳都是
// `strftime("%Y-%m-%d %H:%M UTC")`（planrun.py:387/466/502/690、
// testrun.py:574、redteam.py:662），而 mock 此前一律不带后缀。
// 于是带后缀这条真形态路径从未被任何测试碰到过——它「正确」纯属巧合：
// 旧实现判 `v.includes("T")`，因为 "UTC" 里恰好有个大写 T 而为 true，
// 再靠 V8 对 "2026-08-11 09:00 UTC" 的宽松解析兜住。后端一旦把后缀改成
// " Z" 或去掉，includes("T") 转 false → 拼成 "…T09:00 UTCZ" → NaN →
// 趋势图恒空、24h 窗口恒空、KPI 全「—」。现在改成显式剥后缀，这里锁住它。
import { describe, expect, it } from "vitest";
import { toMillis, parseUtc, fmtScore, fmtDuration } from "../src/lib/scoring";
import { fmtRunTime } from "../src/lib/time";

const EXPECT_MS = Date.UTC(2026, 7, 11, 9, 0, 0); // 2026-08-11T09:00:00Z

describe("toMillis：后端 run 时间戳的三种形态", () => {
  it("带 \" UTC\" 后缀（真后端形态）→ 正确的 UTC 毫秒", () => {
    expect(toMillis("2026-08-11 09:00 UTC")).toBe(EXPECT_MS);
  });

  it("不带后缀（旧归档/部分接口）→ 与带后缀等价", () => {
    expect(toMillis("2026-08-11 09:00")).toBe(EXPECT_MS);
    expect(toMillis("2026-08-11 09:00")).toBe(toMillis("2026-08-11 09:00 UTC"));
  });

  it("带秒 + 后缀 → 正确解析", () => {
    expect(toMillis("2026-08-11 09:00:30 UTC")).toBe(EXPECT_MS + 30_000);
  });

  it("ISO 串（含 T）→ 原样交给 Date.parse", () => {
    expect(toMillis("2026-08-11T09:00:00Z")).toBe(EXPECT_MS);
  });

  it("epoch 秒（数字）→ ×1000", () => {
    expect(toMillis(1786438800)).toBe(1786438800_000);
  });

  it("解析不再依赖「UTC 里有个 T」的巧合：后缀被显式剥离", () => {
    // 关键回归断言：若实现退回 includes("T") 分支，下面这个**小写** utc
    // 会走 Date.parse("2026-08-11 09:00 utc")（V8 仍宽松接受），
    // 但一旦后端换成不含 T 的后缀，旧实现必 NaN。这里同时锁住大小写。
    expect(toMillis("2026-08-11 09:00 utc")).toBe(EXPECT_MS);
    // 多余空白也不该破坏解析
    expect(toMillis("2026-08-11 09:00   UTC")).toBe(EXPECT_MS);
  });

  it("空/null/纯后缀 → NaN（不是 0——0 是合法时间戳 1970-01-01）", () => {
    expect(toMillis(null)).toBeNaN();
    expect(toMillis(undefined)).toBeNaN();
    expect(toMillis("")).toBeNaN();
    expect(toMillis("UTC")).toBeNaN();
    expect(toMillis("说不清")).toBeNaN();
  });

  it("parseUtc 是 toMillis 的字符串特例，语义一致", () => {
    expect(parseUtc("2026-08-11 09:00 UTC")).toBe(EXPECT_MS);
    expect(parseUtc("2026-08-11 09:00")).toBe(EXPECT_MS);
  });
});

describe("fmtRunTime：展示层剥后缀，行内不重复标 UTC", () => {
  it("带后缀输入 → 输出无 UTC 字样", () => {
    expect(fmtRunTime("2026-08-11 09:00 UTC")).toBe("2026-08-11 09:00");
  });

  it("不带后缀输入 → 同样输出", () => {
    expect(fmtRunTime("2026-08-11 09:00")).toBe("2026-08-11 09:00");
  });

  it("epoch 秒 → 格式化", () => {
    expect(fmtRunTime(1786438800)).toBe("2026-08-11 09:00");
  });

  it("解析失败 → 原样透出字符串；空值 → 「—」", () => {
    expect(fmtRunTime("说不清")).toBe("说不清");
    expect(fmtRunTime(null)).toBe("—");
    expect(fmtRunTime("")).toBe("—");
  });
});

describe("fmtScore / fmtDuration：无值给「—」不给 0", () => {
  it("fmtScore", () => {
    expect(fmtScore(0.8234)).toBe("0.82");
    expect(fmtScore(0)).toBe("0.00");   // 真 0 分要显示，别当空值
    expect(fmtScore(null)).toBe("—");
    expect(fmtScore(undefined)).toBe("—");
  });

  it("fmtDuration", () => {
    expect(fmtDuration(74)).toBe("1m14s");
    expect(fmtDuration(59)).toBe("59s");
    expect(fmtDuration(null)).toBe("—");
  });
});
