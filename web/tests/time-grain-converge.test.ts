// 时间排版三份同型副本收敛（批 fmt-converge 第 4 条）。
//
// 缺陷形态：report/badcase.fmtAnnotAt、agents/home/derive.fmtStamp、同文件 fmtHour
// 各自私写 `Date.parse` + `toISOString().slice(…)`。三份与 lib/time.fmtTime 同形，
// 但都丢了 fmtTime 攒下来的处理 —— 每一道都是踩过的实拍坑：
//   · 剥 `" UTC"` 后缀 —— 后端**所有 run 时间戳**的真形态是
//     `strftime("%Y-%m-%d %H:%M UTC")`，不剥会拼出 "…T09:00 UTCZ" → NaN；
//   · 认裸 epoch 串 —— Langfuse 注册源的时间戳是 `str(int(...))`，
//     「缓存于 1787030227」是用户实拍截图里抓到的 bug；
//   · 不把认不出的串喂给 Date.parse —— V8 会把 "0" 解析成 2000-01-01，
//     即「不知道什么时候」被渲染成一个具体历史日期。
//
// 收敛做法是给 fmtTime 加**粒度**参数（三档），不是再写第四份。
import { describe, expect, it } from "vitest";
import { fmtTime } from "../src/lib/time";
import { fmtAnnotAt } from "../src/pages/report/badcase";
import { fmtHour, fmtStamp } from "../src/pages/agents/home/derive";

const ISO = "2026-08-11T09:07:33Z";

describe("fmtTime 的粒度参数：三档切自同一个 ISO 串", () => {
  it("同一个输入三档", () => {
    expect(fmtTime(ISO)).toBe("2026-08-11 09:07");            // 缺省 ymd-hm
    expect(fmtTime(ISO, "ymd-hm")).toBe("2026-08-11 09:07");
    expect(fmtTime(ISO, "md-hm")).toBe("08-11 09:07");
    expect(fmtTime(ISO, "hm")).toBe("09:07");
  });

  it("三道处理在每一档上都在（不是只有缺省档才有）", () => {
    // 剥 " UTC" 后缀
    expect(fmtTime("2026-08-11 09:07 UTC", "md-hm")).toBe("08-11 09:07");
    expect(fmtTime("2026-08-11 09:07 UTC", "hm")).toBe("09:07");
    // 裸 epoch 秒串
    expect(fmtTime("1786785600", "md-hm")).toBe("08-15 09:20"); // 现算：2026-08-15T09:20:00Z
    // 数字 0 / 非正 epoch = 缺失，不渲染成 1970
    expect(fmtTime(0, "md-hm")).toBe("—");
    expect(fmtTime(0, "hm")).toBe("—");
  });
});

describe("badcase.fmtAnnotAt：改调 fmtTime 后拿到的三道处理", () => {
  it("常规 ISO 不变（收敛前后逐字同）", () => {
    expect(fmtAnnotAt(ISO)).toBe("2026-08-11 09:07");
  });

  it("带 \" UTC\" 后缀的 run 时间戳形态能认（旧实现靠 V8 宽松解析，后缀一改就 NaN）", () => {
    expect(fmtAnnotAt("2026-08-11 09:07 UTC")).toBe("2026-08-11 09:07");
  });

  it("裸 epoch 秒串排版成时刻，不再原样印出一串数字", () => {
    expect(fmtAnnotAt("1786785600")).toBe("2026-08-15 09:20");
  });

  it("认不出的串原样透出，不喂给 Date.parse（旧实现把 \"0\" 说成 2000-01-01）", () => {
    expect(Date.parse("0")).not.toBeNaN(); // V8 真会认，这是旧实现的坑
    expect(fmtAnnotAt("0")).toBe("0");
    expect(fmtAnnotAt("刚刚")).toBe("刚刚");
  });
});

describe("home/derive.fmtStamp / fmtHour：粒度不同，解析同源", () => {
  it("粒度照旧（fmtStamp 带月日、fmtHour 只有时分）", () => {
    expect(fmtStamp(ISO)).toBe("08-11 09:07");
    expect(fmtHour(ISO)).toBe("09:07");
  });

  it("缺失占位符两处刻意不同：fmtStamp 破折号、fmtHour 空串（小时轴上不占位）", () => {
    expect(fmtStamp(null)).toBe("—");
    expect(fmtStamp("")).toBe("—");
    expect(fmtHour(null)).toBe("");
    expect(fmtHour("")).toBe("");
  });

  it("两处都拿到了 \" UTC\" 后缀与裸 epoch 串", () => {
    expect(fmtStamp("2026-08-11 09:07 UTC")).toBe("08-11 09:07");
    expect(fmtHour("2026-08-11 09:07 UTC")).toBe("09:07");
    expect(fmtStamp("1786785600")).toBe("08-15 09:20");
  });

  it("认不出的串原样透出（与收敛前同向：不编日期）", () => {
    expect(fmtStamp("待定")).toBe("待定");
    expect(fmtHour("待定")).toBe("待定");
  });
});
