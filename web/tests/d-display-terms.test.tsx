// D-3 / D-4 / D-5 + 流式行量纲（domain-r1 拍板「全按推荐」）：同一件事在同一天
// 被同一批人看到时，必须叫同一个名字。
//
//   D-3 大屏「未计分（无有效输出）」→ 全站同词「无可评估数据」（判定不动，只改词）
//   D-4 环节级「完成」加限定 —— 裸词「完成」只归 run 级 badge
//   D-5 止血版：有方案定义在手的页面把 dataset + 模拟侧集合的环节叫「模拟测试」
//   流式行 dataset 环节的括号数字从「（0.00）」改成「（通过率 0%）」
import { describe, expect, it } from "vitest";
import { runOutcome, STAGE_LABEL } from "../src/lib/scoring";
import { STAGE_UI_LABEL } from "../src/pages/plan/PlanEditor";
import { logEntryOf } from "../src/pages/plan/useRunPlan";
import {
  stageDisplayLabel, stageNumbers, SIMULATION_STAGE_LABEL,
} from "../src/pages/plan/derive";
import { deriveAgents, deriveEvents, NO_SCORE_TEXT } from "../src/pages/bigscreen/derive";
import type { BigscreenRun } from "../src/pages/bigscreen/types";

// ==================== D-3 大屏与全站同词 ====================
//
// 「未计分」的字面含义覆盖了纯回归 run（它们也没分，却不是 nodata），
// 会把 D-1 的困惑搬到大屏上。判定早就是同一个函数（runOutcome），只有词不同。

/** completed 但环节全 empty → runOutcome 判 nodata（大屏与方案详情同一函数） */
const NODATA_RUN: BigscreenRun = {
  run_key: "r-nodata", plan_id: "p-1", plan_name: "文档问答巡检",
  agent_name: "doc-bot", status: "completed", started_at: "2026-08-22 03:20",
  duration_s: 12,
  stage_summaries: [{ type: "observe", status: "empty", overall_mean: null, sessions: 36 }],
};

describe("D-3 大屏 nodata 措辞与全站权威对刑", () => {
  it("权威侧：runOutcome 的 nodata label 含「无可评估数据」（字面量写死在测试里）", () => {
    // ⚠️ 左边是硬编码字面量、右边是 import 的权威：两边都取 import 的话，
    // 权威怎么漂移这条断言都恒真。
    expect(runOutcome(NODATA_RUN).label).toContain("无可评估数据");
    expect(runOutcome(NODATA_RUN).kind).toBe("nodata");
  });

  it("大屏事件侧栏：标题是权威 label 的子串，不再是「未计分（无有效输出）」", () => {
    const ev = deriveEvents([NODATA_RUN]);
    // 量词钉：先确认这条事件确实在（否则下面的否定断言恒真）
    expect(ev).toHaveLength(1);
    expect(ev[0].t).toBe("无可评估数据");
    expect(ev[0].lv).toBe("warn");
    // 对刑：大屏那句话必须是权威 badge 文案里的一段（大屏字号紧，只取词）
    expect(runOutcome(NODATA_RUN).label).toContain(ev[0].t);
    expect(ev[0].t).not.toContain("未计分");
    // 说明行保留「无有效输出」的事实，并且不留裸词「均分」
    expect(ev[0].d).toContain("无有效输出");
    expect(ev[0].d).toContain("线上评估均分");
  });

  it("大屏 Agent 卡标签：同一个词（此前是「未计分」）", () => {
    const agents = deriveAgents([NODATA_RUN], []);
    const a = agents.find((x) => x.name === "doc-bot")!;
    expect(a.level).toBe("warn");
    expect(a.tag?.t).toBe(NO_SCORE_TEXT);
    expect(a.tag?.t).toBe("无可评估数据");
    expect(runOutcome(NODATA_RUN).label).toContain(a.tag!.t);
  });
});

// ==================== D-4 环节级「完成」的限定词 ====================
//
// UI-013 的用户画面：环节说「完成（1.00）」，run badge 说「无可评估数据」——
// 同屏两个「完成」是两个层级的事。裸词「完成」只归 run 级（那是 ADR-0003
// Amendment 定型的五态 badge，全站高频，不动）；环节级必须带限定。

/** run 级 badge 的裸词「完成」：环节行不许再出现同一个裸词 */
const OK_RUN = {
  status: "completed", score: null,
  stage_summaries: [{ type: "dataset", status: "completed", pass_rate: 0.75 }],
};

describe("D-4 环节级「完成」带限定词，裸词只归 run 级", () => {
  it("run 级 badge 保持裸词「完成」（硬编码字面量钉权威）", () => {
    expect(runOutcome(OK_RUN).label).toBe("完成");
  });

  it("带「环节 N/M ·」前缀的行视作已限定：层级由前缀说清，原文不动", () => {
    const done = logEntryOf({
      event: "stage_done", stage: 2, total_stages: 2,
      summary: { type: "observe", status: "completed", overall_mean: 0.88, sessions: 2 },
    })!;
    expect(done.text).toBe("环节 2/2 · 线上评估：完成（0.88）");
    // 前缀在 = 这一行说的是环节，不是 run
    expect(done.text.startsWith("环节 2/2 · ")).toBe(true);
  });

  it("没有序号的旧形态（stage 是类型字符串）：裸「完成」→「本环节完成」", () => {
    const legacy = logEntryOf({ event: "stage_completed", stage: "redteam" })!;
    expect(legacy.text).toBe("红队测试：本环节完成");
    // 与 run 级 badge 的裸词不再同形（此前两行都是「…完成」）
    expect(legacy.text).not.toBe(`红队测试：${runOutcome(OK_RUN).label}`);
    expect(legacy.text).toContain("本环节");
  });

  it("失败 / 无数据两档不受影响（各自已有环节级说法）", () => {
    expect(logEntryOf({
      event: "stage_done", stage: 1,
      summary: { type: "observe", status: "empty", error: "最近 30 天没有可评估的会话" },
    })!.text).toBe("环节 1 · 线上评估：无数据（最近 30 天没有可评估的会话）");
    expect(logEntryOf({
      event: "stage_done", stage: 1, summary: { type: "redteam", status: "error", error: "boom" },
    })!.text).toBe("环节 1 · 红队测试：失败：boom");
  });
});

// ==================== 流式环节行的量纲（passrate-zero 档） ====================
//
// 现场：用户看到「完成（0.00）」并把它读成「Agent 全答错」，实际那是**通过率
// 0%**（口径不匹配问题另有档）。回归环节给的是 0-1 的比例，被按分数格式化成两位
// 小数，与线上评估均分**外观完全一致**，读者分不出量纲。方案详情早就按百分比
// 呈现同一个字段（derive.stageNumbers），两处不一致。
describe("流式环节完成行：按环节类型选量纲（不再把通过率印成 0.00）", () => {
  it("dataset：pass_rate=0 → 「通过率 0%」（此前是与均分同形的「0.00」）", () => {
    const line = logEntryOf({
      event: "stage_done", stage: 2, total_stages: 2,
      summary: { type: "dataset", status: "completed", pass_rate: 0, cases: 4, blank_cases: 0 },
    })!;
    expect(line.text).toBe("环节 2/2 · 回归测试：完成（通过率 0%）");
    expect(line.text).not.toContain("0.00");
    // 文案与方案详情/报告抽屉的同一个函数出同一句话
    expect(line.text).toContain(
      stageNumbers({ type: "dataset", status: "completed", pass_rate: 0, cases: 4 }));
  });

  it("dataset：pass_rate=1 → 100%；缺 pass_rate → 整段括号不出（不用 0 顶）", () => {
    expect(logEntryOf({
      event: "stage_done", stage: 1,
      summary: { type: "dataset", status: "completed", pass_rate: 1, cases: 4 },
    })!.text).toBe("环节 1 · 回归测试：完成（通过率 100%）");
    // 老 run / 摘要没给通过率：用例数不是结果，不摆进括号
    expect(logEntryOf({
      event: "stage_done", stage: 1,
      summary: { type: "dataset", status: "completed", cases: 4 },
    })!.text).toBe("环节 1 · 回归测试：完成");
  });

  it("observe：均分两位小数**呈现不变**（那一格本来就是分数量纲）", () => {
    expect(logEntryOf({
      event: "stage_done", stage: 1,
      summary: { type: "observe", status: "completed", overall_mean: 0.88, sessions: 2 },
    })!.text).toBe("环节 1 · 线上评估：完成（0.88）");
  });

  it("redteam：走它的既有口径「攻破 x/y」（0 次攻破是结论，不是没数据）", () => {
    const line = logEntryOf({
      event: "stage_done", stage: 3, total_stages: 3,
      summary: { type: "redteam", status: "completed", breached: 0, attacks: 12, verdict: null },
    })!;
    expect(line.text).toBe("环节 3/3 · 红队测试：完成（攻破 0/12）");
    expect(line.text).toContain(
      stageNumbers({ type: "redteam", status: "completed", breached: 0, attacks: 12 }));
  });
});

// ==================== D-5 环节展示名（模拟侧） ====================
//
// 用户用模拟集配好的环节，在运行页/运行历史/报告抽屉/导出/大屏里都被叫成
// 「回归测试」——「模拟测试」这个产品概念在结果侧完全消失。止血版（选项 2）
// 只改**有方案定义在手**的地方：报告抽屉的环节行与钻取块标题。

const SIM_DS = { name: "sim-rebooking", kind: "simulation", case_count: 2 };
const REG_DS = { name: "faq-v3", kind: "regression", case_count: 3 };
/** 历史多轮集：kind 仍是 regression，靠 cases 形态推断归模拟侧（lib/datasetSide 双读） */
const LEGACY_MULTI_DS = {
  name: "flow-multi", kind: "regression", case_count: 1,
  cases: [{ name: "t1", input: "开场", task_description: "完成订票" }],
};

describe("D-5 模拟侧数据集的环节展示名（stageDisplayLabel）", () => {
  it("术语不是新造的：与编辑器 UI 四类表的「模拟测试」同一个词", () => {
    // PlanEditor.STAGE_UI_LABEL 是「模拟测试」这个 UI 概念的既有住所
    // （CONTEXT.md:70-75），本批只是把它借到结果侧，不新造术语。
    expect(STAGE_UI_LABEL.simulation).toBe("模拟测试");
    expect(SIMULATION_STAGE_LABEL).toBe(STAGE_UI_LABEL.simulation);
    // 存储三类映射一行未动（术语五词不可变更）
    expect(STAGE_LABEL.dataset).toBe("回归测试");
  });

  it("dataset + 模拟侧集合 →「模拟测试」；固定侧 →「回归测试」", () => {
    const ctx = {
      planStages: [{ type: "dataset" as const, dataset: "sim-rebooking", evaluators: [] }],
      datasets: [SIM_DS, REG_DS],
    };
    expect(stageDisplayLabel({ type: "dataset", status: "completed" }, 0, ctx))
      .toBe("模拟测试");
    expect(stageDisplayLabel({ type: "dataset", status: "completed" }, 0, {
      planStages: [{ type: "dataset", dataset: "faq-v3", evaluators: [] }],
      datasets: [SIM_DS, REG_DS],
    })).toBe("回归测试");
  });

  it("历史多轮集（kind=regression 但用例带 task_description）也归模拟侧（双读）", () => {
    expect(stageDisplayLabel({ type: "dataset", status: "completed" }, 0, {
      planStages: [{ type: "dataset", dataset: "flow-multi", evaluators: [] }],
      datasets: [LEGACY_MULTI_DS],
    })).toBe("模拟测试");
  });

  it("名单没到齐 / 集合查不到 / 环节非 dataset：一律退回三类映射，绝不猜", () => {
    const planStages = [{ type: "dataset" as const, dataset: "sim-rebooking", evaluators: [] }];
    // datasets 未到（首帧、或本页没有那份查询）
    expect(stageDisplayLabel({ type: "dataset" }, 0, { planStages })).toBe("回归测试");
    expect(stageDisplayLabel({ type: "dataset" }, 0, { planStages, datasets: [] }))
      .toBe("回归测试");
    // 集合已被删掉（名单里没有这个名字）
    expect(stageDisplayLabel({ type: "dataset" }, 0, { planStages, datasets: [REG_DS] }))
      .toBe("回归测试");
    // 方案定义也没有（列表页口径）
    expect(stageDisplayLabel({ type: "dataset" }, 0, { datasets: [SIM_DS] })).toBe("回归测试");
    // 另两类环节不受影响
    expect(stageDisplayLabel({ type: "observe" }, 0, { planStages, datasets: [SIM_DS] }))
      .toBe("线上评估");
    expect(stageDisplayLabel({ type: "redteam" }, 0, { planStages, datasets: [SIM_DS] }))
      .toBe("红队测试");
  });

  it("run 自己报告体里的数据集名优先于方案定义（方案后来改过也不说错）", () => {
    const ctx = {
      // 方案现在指向固定集，但这一次 run 跑的是模拟集
      planStages: [{ type: "dataset" as const, dataset: "faq-v3", evaluators: [] }],
      datasets: [SIM_DS, REG_DS],
    };
    expect(stageDisplayLabel(
      { type: "dataset", report: { dataset: "sim-rebooking" } } as never, 0, ctx,
    )).toBe("模拟测试");
  });

  it("环节顺序与方案定义不同位时：同类型只有一个环节才敢对上", () => {
    const datasets = [SIM_DS, REG_DS];
    const planStages = [
      { type: "observe" as const, evaluators: [] },
      { type: "dataset" as const, dataset: "sim-rebooking", evaluators: [] },
    ];
    // 下标 0 是 dataset 环节而方案定义下标 0 是 observe → 退到「同类型只有一个」
    expect(stageDisplayLabel({ type: "dataset" }, 0, { planStages, datasets }))
      .toBe("模拟测试");
    // 两个同类型环节且不同位 → 不敢对（宁可显示三类映射，也不把 A 的名字挂给 B）
    expect(stageDisplayLabel({ type: "dataset" }, 0, {
      planStages: [
        { type: "observe", evaluators: [] },
        { type: "dataset", dataset: "sim-rebooking", evaluators: [] },
        { type: "dataset", dataset: "faq-v3", evaluators: [] },
      ],
      datasets,
    })).toBe("回归测试");
  });
});
