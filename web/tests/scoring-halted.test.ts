// 成本熔断必须能被看见（P1 / 任务书缺陷 3）。
//
// 后端超预算时把 run 标成 `status="halted_cost"` 并中止（testrun.py:810 /
// redteam.py:753,767，COST_CIRCUIT_FACTOR=3.0）。这个 status 原样上到
// stage_summaries 与 run 行，而 lib/scoring.ts 此前**一个字都不认识它**：
//   · isStageFailed：既不是 empty 也不是 error、没有 error 文本 → 判「没失败」
//   · isStageEffective：要求 status==="completed" → 判「无有效结果」
// 两条都不成立 ⇒ 整个 run 落到 runOutcome 的第 4 级，显示中性的
// 「完成 · 无可评估数据」；单跑的回归/红队 run 行更直接把英文枚举
// "halted_cost" 印给用户（STATUS_LABEL 没有这一项，?? 兜底原样输出）。
// 用户的钱烧到熔断阈值，界面不说是被平台掐掉的。
//
// 口径定位：熔断归**失败/部分失败侧**（它确实没跑完，剩下的用例一个没测），
// 但带自己的文案「（成本熔断）」——它是刻意止损，不是 agent 崩了。把它折叠进
// 普通 error 会让人去查 agent，真实原因是超预算。
//
// 夹具形状逐字照后端 planrun.py:_stage_summary（DDB 真形态）。
import { describe, expect, it } from "vitest";
import {
  STATUS_LABEL,
  breachOf,
  isRunSuccess,
  isScored,
  isStageEffective,
  isStageFailed,
  runMetricChips,
  runOutcome,
  statusBadgeClass,
} from "../src/lib/scoring";

const OBS_OK = { type: "observe", status: "completed", overall_mean: 0.83, sessions: 4, summary: {} };
const DS_OK = { type: "dataset", status: "completed", pass_rate: 1, cases: 1, blank_cases: 0 };
const OBS_EMPTY = { type: "observe", status: "empty", error: "最近 30 天没有可评估的会话" };

// 熔断的回归环节：8 个用例只跑了 3 个，那 3 个恰好全通过 → pass_rate=1。
// 「通过率 100%」在这里是**半截数字**，绝不能当成一次完整成功的回归。
const DS_HALTED = {
  type: "dataset", status: "halted_cost", pass_rate: 1, cases: 8, blank_cases: 0,
  error: "实际成本 $1.53 超过预估的 3.0x（$0.51），已自动熔断中止",
};
// 本批修复之前落库的熔断环节：只有 status，没有 error 文本。判定必须认 status，
// 不能只靠文本，否则老 run 继续显示「完成 · 无可评估数据」。
const DS_HALTED_LEGACY = { type: "dataset", status: "halted_cost", pass_rate: 1, cases: 8 };
const RT_HALTED = {
  type: "redteam", status: "halted_cost", breached: 2, attacks: 20, verdict: "INCONCLUSIVE",
  error: "实际成本 $5.44 超过预估的 3.0x（$1.8），已自动熔断中止",
};

const run = (stages: Record<string, unknown>[] | undefined, score: number | null = null) =>
  ({ status: "completed", score, stage_summaries: stages });

describe("环节级：halted_cost 落失败侧", () => {
  it("熔断环节算失败、不算有效结果（两条判定都要认这个 status）", () => {
    expect(isStageFailed(DS_HALTED)).toBe(true);
    expect(isStageEffective(DS_HALTED)).toBe(false);
    expect(isStageFailed(RT_HALTED)).toBe(true);
    expect(isStageEffective(RT_HALTED)).toBe(false);
  });

  it("老数据（没有 error 文本）同样算失败——判定认 status，不靠文案", () => {
    expect(isStageFailed(DS_HALTED_LEGACY)).toBe(true);
  });

  it("回归：completed 环节与 empty 环节的判定一个字不变（empty 仍先于 error 出局）", () => {
    expect(isStageFailed(DS_OK)).toBe(false);
    expect(isStageEffective(DS_OK)).toBe(true);
    expect(isStageFailed(OBS_EMPTY)).toBe(false);
  });
});

describe("run 级：熔断的 run 不许显示成中性完成", () => {
  it("只有熔断环节 →「失败 · 回归测试（成本熔断）」，绝不是「完成 · 无可评估数据」", () => {
    const r = run([DS_HALTED]);
    const o = runOutcome(r);
    expect(o.kind).toBe("failed");
    expect(o.cls).toBe("badge bad");
    expect(o.label).toBe("失败 · 回归测试（成本熔断）");
    expect(o.label).not.toContain("无可评估数据");
    expect(isRunSuccess(r)).toBe(false);
  });

  it("有别的环节评到了东西 →「部分失败 · 回归测试（成本熔断）」", () => {
    const r = run([OBS_OK, DS_HALTED], 0.83);
    const o = runOutcome(r);
    expect(o.kind).toBe("partial");
    expect(o.cls).toBe("badge warn");
    expect(o.label).toBe("部分失败 · 回归测试（成本熔断）");
    // 部分失败照旧算成功运行（observe 那一环的结果是真的、可用的）
    expect(isRunSuccess(r)).toBe(true);
    expect(isScored(r)).toBe(true);
  });

  it("红队熔断同刑，多环节熔断各自带自己的文案", () => {
    expect(runOutcome(run([RT_HALTED])).label).toBe("失败 · 红队测试（成本熔断）");
    expect(runOutcome(run([DS_HALTED, RT_HALTED])).label)
      .toBe("失败 · 回归测试（成本熔断） · 红队测试（成本熔断）");
  });

  it("failedStages 仍只放环节名——报告抽屉/导出把它拼进「<环节>环节执行失败。」", () => {
    // ReportDrawer.tsx:436 与 exportReport.ts:145 直接 join 这个数组成句，
    // 塞进「（成本熔断）」会读成病句；括号只属于 badge 文案。
    expect(runOutcome(run([OBS_OK, DS_HALTED], 0.83)).failedStages).toEqual(["回归测试"]);
  });

  it("半截通过率不许当指标 chip 吐出来（3/8 个用例全通过 ≠ 通过率 100%）", () => {
    expect(runMetricChips(run([DS_HALTED]))).toEqual([]);
    expect(runMetricChips(run([OBS_OK, DS_HALTED], 0.83))).toEqual(["0.83"]);
  });

  it("breachOf：熔断的红队环节不进攻破数聚合（只认 completed）", () => {
    expect(breachOf({ stage_summaries: [RT_HALTED] })).toBeNull();
  });
});

describe("run 行状态：单跑的回归/红队 run 也不许印英文枚举", () => {
  it("halted_cost 有中文文案与 warn 语义类（风格同既有五态）", () => {
    expect(STATUS_LABEL.halted_cost).toBe("成本熔断中止");
    expect(statusBadgeClass("halted_cost")).toBe("badge warn");
    const o = runOutcome({ status: "halted_cost", score: null });
    expect(o.kind).toBe("status");
    expect(o.label).toBe("成本熔断中止");
    expect(o.cls).toBe("badge warn");
    expect(o.success).toBe(false);
  });

  it("同族：redteam.py:772 的 run 级 failed 也有中文文案", () => {
    expect(STATUS_LABEL.failed).toBe("失败");
    expect(statusBadgeClass("failed")).toBe("badge bad");
    expect(runOutcome({ status: "failed", score: null }).label).toBe("失败");
  });

  it("回归：既有四态文案与语义类一个字不变", () => {
    expect(STATUS_LABEL.completed).toBe("完成");
    expect(STATUS_LABEL.error).toBe("失败");
    expect(STATUS_LABEL.skipped).toBe("跳过");
    expect(STATUS_LABEL.running).toBe("运行中");
    expect(statusBadgeClass("completed")).toBe("badge ok");
    expect(statusBadgeClass("error")).toBe("badge bad");
    expect(statusBadgeClass("skipped")).toBe("badge warn");
    expect(statusBadgeClass("running")).toBe("badge run");
    expect(statusBadgeClass("wat")).toBe("badge");
  });
});
