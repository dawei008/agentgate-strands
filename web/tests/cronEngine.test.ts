// cron 引擎单测：用例移植自 ui-prototypes/schedule-picker 原型（25+15+36 验证过的
// 解析/人话/nextRuns/回填判定），并补 EventBridge 方言（plansched.py 直传
// ScheduleExpression，dow 数字基准 1=周日 需平移）与保存归一的用例。
import { describe, expect, it } from "vitest";
import {
  bjEcho, buildCron, canBackfill, cronToSimple, fmtUTC, humanize,
  isRate, nextRuns, normalizeSchedule, parseCron, rateHuman, toEventBridge,
} from "../src/pages/plan/cronEngine";

// 原型钉死的基准时间：2026-08-22 00:47 UTC（周六）
const NOW = new Date(Date.UTC(2026, 7, 22, 0, 47, 0));

const iso = (d: Date) => d.toISOString().slice(0, 16);

describe("parseCron：标准五段方言", () => {
  it("单值：0 3 * * 1 → 周一，dow 内部 0=周日", () => {
    const p = parseCron("0 3 * * 1");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.dialect).toBe("standard");
    expect([...p.f[0].set]).toEqual([0]);
    expect([...p.f[1].set]).toEqual([3]);
    expect(p.f[2].star).toBe(true);
    expect([...p.f[4].set]).toEqual([1]);
  });

  it("周 7 归一为 0（周日）", () => {
    const p = parseCron("0 3 * * 7");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.f[4].set.has(0)).toBe(true);
    expect(p.f[4].set.has(7)).toBe(false);
  });

  it("步长：*/15 * * * * → 分钟 {0,15,30,45}", () => {
    const p = parseCron("*/15 * * * *");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect([...p.f[0].set].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect(p.f[0].star).toBe(false); // 带步长的 * 不算纯星号
  });

  it("区间 + 列表：0 9-18 * * 1,3,5", () => {
    const p = parseCron("0 9-18 * * 1,3,5");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.f[1].set.size).toBe(10);
    expect([...p.f[4].set].sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });

  it("英文月与星期名：0 3 * jan,jul mon-fri", () => {
    const p = parseCron("0 3 * jan,jul mon-fri");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect([...p.f[3].set].sort((a, b) => a - b)).toEqual([1, 7]);
    expect([...p.f[4].set].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("区间带步长：0-30/10 * * * * → {0,10,20,30}", () => {
    const p = parseCron("0-30/10 * * * *");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect([...p.f[0].set].sort((a, b) => a - b)).toEqual([0, 10, 20, 30]);
  });

  it("段数不足报错并给出段数", () => {
    const p = parseCron("0 3 * *");
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.err).toContain("需要 5 段");
    expect(p.err).toContain("4 段");
  });

  it("空串报 0 段", () => {
    const p = parseCron("");
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.err).toContain("0 段");
  });

  it("裸 6 段：提示疑似 EventBridge 需 cron(…) 包裹", () => {
    const p = parseCron("0 3 ? * MON *");
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.err).toContain("EventBridge");
    expect(p.err).toContain("cron(");
  });

  it("分钟越界：60 → 第 1 段报错，errSeg=0", () => {
    const p = parseCron("60 3 * * 1");
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.errSeg).toBe(0);
    expect(p.err).toContain("60 超出范围 0–59");
  });

  it("小时越界：25 → errSeg=1（原型状态 3 的错误态用例）", () => {
    const p = parseCron("0 25 * * 1");
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.errSeg).toBe(1);
    expect(p.err).toContain("25 超出范围 0–23");
  });

  it("区间起点大于终点报错", () => {
    const p = parseCron("0 3 20-5 * *");
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.errSeg).toBe(2);
    expect(p.err).toContain("起点大于终点");
  });

  it("非法步长 / 多斜杠 / 列表空项 / 非数字", () => {
    expect(parseCron("*/0 * * * *").ok).toBe(false);
    expect(parseCron("*/5/2 * * * *").ok).toBe(false);
    expect(parseCron("1,,2 * * * *").ok).toBe(false);
    expect(parseCron("abc * * * *").ok).toBe(false);
  });
});

describe("parseCron：EventBridge cron(…) 方言", () => {
  it("cron(0 3 ? * MON *)：英文名 dow → 内部 1=周一", () => {
    const p = parseCron("cron(0 3 ? * MON *)");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.dialect).toBe("eventbridge");
    expect([...p.f[4].set]).toEqual([1]);
    expect(p.f[2].star).toBe(true); // ? 视作 *
    expect(p.year).toBeNull();      // 年 * → null
  });

  it("EB 数字 dow 基准平移：2=周一 → 内部 1；1=周日 → 内部 0", () => {
    const mon = parseCron("cron(0 3 ? * 2 *)");
    expect(mon.ok).toBe(true);
    if (mon.ok) expect([...mon.f[4].set]).toEqual([1]);
    const sun = parseCron("cron(0 3 ? * 1 *)");
    expect(sun.ok).toBe(true);
    if (sun.ok) expect([...sun.f[4].set]).toEqual([0]);
    const sat = parseCron("cron(0 3 ? * 7 *)");
    expect(sat.ok).toBe(true);
    if (sat.ok) expect([...sat.f[4].set]).toEqual([6]);
  });

  it("每月形态：cron(30 23 15 * ? *)", () => {
    const p = parseCron("cron(30 23 15 * ? *)");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect([...p.f[2].set]).toEqual([15]);
    expect(p.f[4].star).toBe(true);
  });

  it("限定年份：cron(0 3 ? * MON 2027) → year 字段生效", () => {
    const p = parseCron("cron(0 3 ? * MON 2027)");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.year).not.toBeNull();
    expect(p.year!.set.has(2027)).toBe(true);
  });

  it("段数错误 / 缺右括号 / L W # 扩展语法拒收", () => {
    const five = parseCron("cron(0 3 * * ?)");
    expect(five.ok).toBe(false);
    if (!five.ok) expect(five.err).toContain("6 段");
    expect(parseCron("cron(0 3 ? * MON *").ok).toBe(false);
    const l = parseCron("cron(0 3 L * ? *)");
    expect(l.ok).toBe(false);
    if (!l.ok) expect(l.err).toContain("L/W/#");
    // 但英文名 WED / JUL 里的 W、L 不误报
    expect(parseCron("cron(0 3 ? JUL WED *)").ok).toBe(true);
  });

  it("EB dow 数字 0 越界（EB 是 1–7）", () => {
    const p = parseCron("cron(0 3 ? * 0 *)");
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.errSeg).toBe(4);
  });
});

describe("nextRuns：下次运行推算（基准 2026-08-22 00:47 UTC 周六）", () => {
  it("每周一三五 03:00 → 下三次：08-24(一) 08-26(三) 08-28(五)", () => {
    const runs = nextRuns(parseCron("0 3 * * 1,3,5"), NOW, 3);
    expect(runs.map(iso)).toEqual([
      "2026-08-24T03:00", "2026-08-26T03:00", "2026-08-28T03:00",
    ]);
  });

  it("EB 等价表达式推算结果一致（dow 平移正确的行为证据）", () => {
    const std = nextRuns(parseCron("0 3 * * 1,3,5"), NOW, 3).map(iso);
    const eb = nextRuns(parseCron("cron(0 3 ? * MON,WED,FRI *)"), NOW, 3).map(iso);
    const ebNum = nextRuns(parseCron("cron(0 3 ? * 2,4,6 *)"), NOW, 3).map(iso);
    expect(eb).toEqual(std);
    expect(ebNum).toEqual(std);
  });

  it("每月 15 日 23:30 → 09-15、10-15、11-15", () => {
    const runs = nextRuns(parseCron("30 23 15 * *"), NOW, 3);
    expect(runs.map(iso)).toEqual([
      "2026-09-15T23:30", "2026-10-15T23:30", "2026-11-15T23:30",
    ]);
  });

  it("日与周都限定时取「或」：0 0 23 8 6 → 8月23(周日≠周六但 dom 命中)之前先到 8月22 本身不含当前分钟", () => {
    // 2026-08-22 是周六：dom=23 或 dow=6(周六) → 当天 00:47 后最近的匹配是…
    // 22 号剩余时间已过 00:00，所以下一个 dow=6 是 08-29；dom=23 是 08-23。取或 → 08-23 先到。
    const runs = nextRuns(parseCron("0 0 23 8 6"), NOW, 2);
    expect(runs.map(iso)).toEqual(["2026-08-23T00:00", "2026-08-29T00:00"]);
  });

  it("2 月 30 日：366 天内无匹配 → 空数组", () => {
    expect(nextRuns(parseCron("0 0 30 2 *"), NOW, 1)).toEqual([]);
  });

  it("限定年份 2027：跳过 2026 年剩余的匹配", () => {
    const runs = nextRuns(parseCron("cron(0 3 ? * MON 2027)"), NOW, 1);
    expect(runs.map(iso)).toEqual(["2027-01-04T03:00"]);
  });

  it("非法表达式 → 空数组", () => {
    expect(nextRuns(parseCron("bad"), NOW, 3)).toEqual([]);
  });
});

describe("humanize：人话描述", () => {
  const h = (e: string) => humanize(parseCron(e));
  it("每周单日 / 多日", () => {
    expect(h("0 3 * * 1")).toBe("每周一 03:00 UTC 运行");
    expect(h("0 3 * * 1,3,5")).toBe("每周一、三、五 03:00 UTC 运行");
  });
  it("工作日 / 周末快捷语", () => {
    expect(h("0 3 * * 1-5")).toBe("每周一至周五 03:00 UTC 运行");
    expect(h("0 3 * * 0,6")).toBe("每周六、周日 03:00 UTC 运行");
  });
  it("每天 / 每月 / 每分钟 / 每 n 分钟", () => {
    expect(h("30 23 * * *")).toBe("每天 23:30 UTC 运行");
    expect(h("0 3 15 * *")).toBe("每月 15 日 03:00 UTC 运行");
    expect(h("* * * * *")).toBe("每分钟 UTC 运行");
    expect(h("*/15 * * * *")).toBe("每 15 分钟 UTC 运行");
  });
  it("原型状态 3：*/30 9-18 * * 1-5", () => {
    expect(h("*/30 9-18 * * 1-5"))
      .toBe("每周一至周五 09:00–18:59 之间每 30 分钟 UTC 运行");
  });
  it("每 n 小时（整点与非整点）", () => {
    expect(h("0 */2 * * *")).toBe("每 2 小时（整点） UTC 运行");
    expect(h("15 */6 * * *")).toBe("每 6 小时的第 15 分 UTC 运行");
  });
  it("限定月份 / EB 形态同语义同人话", () => {
    expect(h("0 3 1 1 *")).toBe("每年 1 月 1 日 03:00 UTC 运行");
    expect(h("cron(0 3 ? * MON *)")).toBe("每周一 03:00 UTC 运行");
  });
  it("非法 → null", () => {
    expect(h("bad expr")).toBeNull();
  });
});

describe("buildCron：简单档 → EventBridge 形态", () => {
  it("每天", () => {
    expect(buildCron({ freq: "daily", hour: 23, min: 30, days: [1], dom: 1 }))
      .toBe("cron(30 23 * * ? *)");
  });
  it("每周：dow 用 SUN–SAT 名字（回避数字基准差异），升序", () => {
    expect(buildCron({ freq: "weekly", hour: 3, min: 0, days: [5, 1, 3], dom: 1 }))
      .toBe("cron(0 3 ? * MON,WED,FRI *)");
    expect(buildCron({ freq: "weekly", hour: 3, min: 0, days: [6, 0], dom: 1 }))
      .toBe("cron(0 3 ? * SUN,SAT *)");
  });
  it("每月", () => {
    expect(buildCron({ freq: "monthly", hour: 3, min: 0, days: [1], dom: 15 }))
      .toBe("cron(0 3 15 * ? *)");
  });
});

describe("cronToSimple / canBackfill：回填判定", () => {
  it("每周：标准与 EB 形态都能回填，dow 归一到内部基准", () => {
    const std = cronToSimple("0 3 * * 1");
    expect(std).toMatchObject({ ok: true, freq: "weekly", hour: 3, min: 0, days: [1] });
    const eb = cronToSimple("cron(0 3 ? * MON *)");
    expect(eb).toMatchObject({ ok: true, freq: "weekly", days: [1] });
    const ebNum = cronToSimple("cron(0 3 ? * 2 *)"); // EB 2=周一
    expect(ebNum).toMatchObject({ ok: true, freq: "weekly", days: [1] });
  });
  it("每天 / 每月 / dow 区间", () => {
    expect(cronToSimple("30 23 * * *")).toMatchObject({ ok: true, freq: "daily", hour: 23, min: 30 });
    expect(cronToSimple("0 3 15 * *")).toMatchObject({ ok: true, freq: "monthly", dom: 15 });
    const wk = cronToSimple("0 3 * * 1-5");
    expect(wk.ok).toBe(true);
    if (wk.ok) expect([...wk.days].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
  it("roundtrip：buildCron 产物必可回填", () => {
    const s = { freq: "weekly" as const, hour: 11, min: 45, days: [2, 4], dom: 1 };
    const back = cronToSimple(buildCron(s));
    expect(back).toMatchObject({ ok: true, freq: "weekly", hour: 11, min: 45 });
    if (back.ok) expect([...back.days].sort((a, b) => a - b)).toEqual([2, 4]);
  });
  it("不可回填：步长 / 列表分时 / 限定月份 / 日周同限 / 日>28 / 限定年份 / 非法", () => {
    expect(cronToSimple("*/30 * * * *")).toMatchObject({ ok: false, reason: "分钟不是单一固定值" });
    expect(cronToSimple("0 9,18 * * *")).toMatchObject({ ok: false, reason: "小时不是单一固定值" });
    expect(cronToSimple("0 3 * 6 *")).toMatchObject({ ok: false, reason: "限定了月份" });
    expect(cronToSimple("0 3 15 * 1")).toMatchObject({ ok: false, reason: "同时限定了「日」和「星期」" });
    expect(cronToSimple("0 3 29 * *").ok).toBe(false);
    expect(cronToSimple("cron(0 3 ? * MON 2027)")).toMatchObject({ ok: false, reason: "限定了年份" });
    expect(cronToSimple("nope")).toMatchObject({ ok: false, reason: "表达式非法" });
    expect(canBackfill("0 3 * * 1")).toBe(true);
    expect(canBackfill("*/30 9-18 * * 1-5")).toBe(false);
    expect(canBackfill("rate(1 day)")).toBe(false);
  });
  it("星期步长不回填（原型明确排除）", () => {
    expect(cronToSimple("0 3 * * */2")).toMatchObject({ ok: false, reason: "星期使用了步长" });
  });
});

describe("toEventBridge / normalizeSchedule：保存归一", () => {
  it("标准五段 → cron(…)：dow 平移为名字，dom/dow 恰一个 ?", () => {
    expect(toEventBridge("0 3 * * 1")).toEqual({ ok: true, expr: "cron(0 3 ? * MON *)" });
    expect(toEventBridge("30 23 * * *")).toEqual({ ok: true, expr: "cron(30 23 * * ? *)" });
    expect(toEventBridge("0 3 15 * *")).toEqual({ ok: true, expr: "cron(0 3 15 * ? *)" });
    expect(toEventBridge("*/30 9-18 * * 1-5"))
      .toEqual({ ok: true, expr: "cron(*/30 9-18 ? * MON,TUE,WED,THU,FRI *)" });
  });
  it("已是 EB 形态：幂等（再归一不变形）", () => {
    expect(toEventBridge("cron(0 3 ? * MON *)")).toEqual({ ok: true, expr: "cron(0 3 ? * MON *)" });
  });
  it("日与周同限：EventBridge 无法表达标准 cron 的「或」语义 → 拒绝", () => {
    const r = toEventBridge("0 3 15 * 1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err).toContain("EventBridge");
  });
  it("normalizeSchedule：空串与 rate(…) 直通，非法拒绝", () => {
    expect(normalizeSchedule("")).toEqual({ ok: true, value: "" });
    expect(normalizeSchedule("  ")).toEqual({ ok: true, value: "" });
    expect(normalizeSchedule("rate(1 day)")).toEqual({ ok: true, value: "rate(1 day)" });
    expect(normalizeSchedule("0 3 * * 1")).toEqual({ ok: true, value: "cron(0 3 ? * MON *)" });
    expect(normalizeSchedule("0 25 * * 1").ok).toBe(false);
    expect(isRate("rate(7 days)")).toBe(true);
    expect(isRate("rate(x)")).toBe(false);
  });
  // 人话与判定同一条正则：三个单位各一句，非 rate 给 null（board.rateText 的原样返回由它兜）
  it("rateHuman：三种单位各自的人话；非 rate → null（与 isRate 同一份单位白名单）", () => {
    expect(rateHuman("rate(1 day)")).toBe("每 1 天");
    expect(rateHuman("rate(15 minutes)")).toBe("每 15 分钟");
    expect(rateHuman("rate(6 hours)")).toBe("每 6 小时");
    expect(rateHuman("  rate(2 HOURS)  ")).toBe("每 2 小时");
    expect(rateHuman("cron(0 4 * * ? *)")).toBeNull();
    expect(rateHuman("rate(1 week)")).toBeNull();
    // 反向钉：isRate 说是 rate 的串，rateHuman 一定说得出人话（两把尺子不许各认一套单位）
    for (const e of ["rate(1 minute)", "rate(30 minutes)", "rate(1 hour)", "rate(12 hours)", "rate(1 day)", "rate(7 days)"]) {
      expect(isRate(e)).toBe(true);
      expect(rateHuman(e)).not.toBeNull();
    }
  });
});

describe("时间换算辅助", () => {
  it("bjEcho：UTC+8 换算与跨日标记", () => {
    expect(bjEcho(3, 0)).toEqual({ text: "11:00", cross: false });
    expect(bjEcho(23, 30)).toEqual({ text: "07:30 （次日）", cross: true });
    expect(bjEcho(16, 0)).toEqual({ text: "00:00 （次日）", cross: true });
  });
  it("fmtUTC：MM-DD 周X HH:MM", () => {
    expect(fmtUTC(new Date(Date.UTC(2026, 7, 24, 3, 0)))).toBe("08-24 周一 03:00");
  });
});
