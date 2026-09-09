// lib/scoring.ts 的 run 终态契约测试（UI-013 + UI-025 / ADR-0003 修订）。
//
// 为什么单独一个文件：终态判定是全站六处消费点（工作台/方案详情/Agent 详情/
// 运行详情/大屏/报告抽屉）的共同口径，页面测试只验各自的渲染投影，
// 口径本身的形态矩阵在这里锁死。
//
// 夹具形状逐字照后端 planrun.py:_stage_summary（DDB 真形态）：
//   observe → overall_mean / sessions / summary
//   dataset → pass_rate / cases / blank_cases
//   redteam → breached / attacks / verdict
// 两条历史事故都是「mock 自造键」测不出来的：纯回归/纯红队 run 顶层
// score 恒 null 被判成 no-data（UI-013）；stage.error 完全不参与终态，
// DDB 写超限炸掉的红队环节照样绿色「完成」（UI-025，线上实拍
// plan-8c7b6ad3cd5d#20260824090808）。
import { describe, expect, it } from "vitest";
import {
  breachOf,
  isRunSuccess,
  isScored,
  isStageEffective,
  isStageFailed,
  runMetricChips,
  runOutcome,
} from "../src/lib/scoring";

// ---- 真形态环节夹具（_stage_summary 逐字） ----
const OBS_OK = { type: "observe", status: "completed", overall_mean: 0.83, sessions: 4, summary: {} };
const OBS_EMPTY = { type: "observe", status: "empty", error: "最近 30 天没有可评估的会话" };
const DS_OK = { type: "dataset", status: "completed", pass_rate: 1, cases: 1, blank_cases: 0 };
const DS_ZERO = { type: "dataset", status: "completed", pass_rate: 0, cases: 3, blank_cases: 0 };
// verdict 缺省/null：真后端 INCONCLUSIVE / 老数据都可能——判定不许依赖它
const RT_OK = { type: "redteam", status: "completed", breached: 0, attacks: 12, verdict: null };
const RT_HIT = { type: "redteam", status: "completed", breached: 2, attacks: 12, verdict: "FAIL" };
// UI-025 实拍：红队环节 DDB PutItem 超限；attacks/breached 归零
const RT_ERR = {
  type: "redteam", status: "error", breached: 0, attacks: 0, verdict: null,
  error: "ValidationException: Item size has exceeded the maximum allowed size",
};
// 抢救路径（planrun.py:_run_redteam_stage except 分支）：status=error 但
// checkpoint 里捞回了攻击数据，还带 salvaged 标记
const RT_SALVAGED = {
  type: "redteam", status: "error", breached: 1, attacks: 3, verdict: null,
  error: "写入超时", salvaged: true,
};
const OBS_ERR = { type: "observe", status: "error", error: "judge 限流：ThrottlingException" };

const run = (stages: Record<string, unknown>[] | undefined, score: number | null = null) =>
  ({ status: "completed", score, stage_summaries: stages });

// ==================== UI-013：六种形态 ====================
describe("runOutcome：按环节判定（UI-013 六形态）", () => {
  it("dataset-only：顶层 score 恒 null 也是「完成」，chips 给通过率", () => {
    const r = run([DS_OK]);
    const o = runOutcome(r);
    expect(o.kind).toBe("ok");
    expect(o.cls).toBe("badge ok");
    expect(o.label).toBe("完成");
    expect(isRunSuccess(r)).toBe(true);
    expect(runMetricChips(r)).toEqual(["通过率 100%"]);
    // 硬线：成功≠有分——不进均分/趋势样本
    expect(isScored(r)).toBe(false);
  });

  it("dataset：pass_rate=0 是「0% 通过」这一结论，不是无数据", () => {
    const o = runOutcome(run([DS_ZERO]));
    expect(o.kind).toBe("ok");
    expect(runMetricChips(run([DS_ZERO]))).toEqual(["通过率 0%"]);
  });

  it("redteam-only：attacks>0 即有效——不依赖 verdict，breached=0 是「全部抵御」", () => {
    const r = run([RT_OK]);
    expect(runOutcome(r).kind).toBe("ok");
    expect(isRunSuccess(r)).toBe(true);
    expect(runMetricChips(r)).toEqual(["攻破 0/12"]);
    expect(isScored(r)).toBe(false);
  });

  it("observe-only：有 overall_mean →「完成」，且是唯一进均分/趋势的形态", () => {
    const r = run([OBS_OK], 0.83);
    expect(runOutcome(r).kind).toBe("ok");
    expect(isScored(r)).toBe(true);
    expect(runMetricChips(r)).toEqual(["0.83"]);
  });

  it("mixed：三环节全 completed →「完成」，chips 按环节各给真实指标", () => {
    const r = run([OBS_OK, DS_OK, RT_HIT], 0.83);
    expect(runOutcome(r).kind).toBe("ok");
    expect(runMetricChips(r)).toEqual(["0.83", "通过率 100%", "攻破 2/12"]);
  });

  it("all-empty：环节全 empty →「完成 · 无可评估数据」（中性），empty 带 error 文本也不算失败", () => {
    const r = run([OBS_EMPTY]);
    const o = runOutcome(r);
    expect(o.kind).toBe("nodata");
    expect(o.cls).toBe("badge"); // 中性，不给绿
    expect(o.label).toBe("完成 · 无可评估数据");
    expect(isRunSuccess(r)).toBe(false);
    expect(isStageFailed(OBS_EMPTY)).toBe(false); // empty 先于 error 判
  });

  it("无 stage_summaries（老归档）：退回顶层 score——有分「完成」，无分 no-data", () => {
    expect(runOutcome(run(undefined, 0.86)).kind).toBe("ok");
    expect(runOutcome(run(undefined, null)).kind).toBe("nodata");
    // record_skipped_run 写 "[]" → 读出空数组，同样走退化
    expect(runOutcome(run([], 0.86)).kind).toBe("ok");
    expect(runMetricChips(run(undefined, 0.86))).toEqual(["0.86"]);
  });
});

// ==================== UI-025：失败环节参与终态 ====================
describe("runOutcome：error 环节优先（UI-025 四形态）", () => {
  it("全成功：无 error 环节 →「完成」（对照组）", () => {
    expect(runOutcome(run([OBS_OK, DS_OK])).kind).toBe("ok");
  });

  it("正常空：empty 不是 error，继续落 no-data 侧", () => {
    expect(runOutcome(run([OBS_EMPTY])).kind).toBe("nodata");
  });

  it("单环节失败（线上实拍形态）：observe 有结果 + redteam 炸 →「部分失败 · 红队测试」", () => {
    const r = run([OBS_OK, RT_ERR], 0.83);
    const o = runOutcome(r);
    expect(o.kind).toBe("partial");
    expect(o.cls).toBe("badge warn"); // 复用既有语义类，不新造颜色
    expect(o.label).toBe("部分失败 · 红队测试");
    expect(o.failedStages).toEqual(["红队测试"]);
    // 部分失败仍算成功运行（产出了可用结果），但绝不是绿色「完成」
    expect(isRunSuccess(r)).toBe(true);
    // 有效环节的指标照常给（observe 的分），失败环节不给
    expect(runMetricChips(r)).toEqual(["0.83"]);
  });

  it("全部失败：一个有效结果都没有 →「失败 · <环节>」，不算成功", () => {
    const r = run([OBS_ERR, RT_ERR]);
    const o = runOutcome(r);
    expect(o.kind).toBe("failed");
    expect(o.cls).toBe("badge bad");
    expect(o.label).toBe("失败 · 线上评估 · 红队测试");
    expect(isRunSuccess(r)).toBe(false);
  });

  it("判定优先级不可调换：error 环节在前——炸掉的 run 绝不显示「完成 · 无可评估数据」", () => {
    // 只有一个 error 环节、没有任何有效结果：若先判 no-data 会落中性完成
    const o = runOutcome(run([RT_ERR]));
    expect(o.kind).toBe("failed");
    expect(o.label).not.toContain("无可评估数据");
  });

  it("抢救环节（status=error + checkpoint 数据 + salvaged）：落失败侧，不算有效结果", () => {
    expect(isStageFailed(RT_SALVAGED)).toBe(true);
    expect(isStageEffective(RT_SALVAGED)).toBe(false); // status!==completed
    expect(runOutcome(run([RT_SALVAGED])).kind).toBe("failed");
    // 与有效环节共存时是部分失败
    expect(runOutcome(run([OBS_OK, RT_SALVAGED], 0.83)).kind).toBe("partial");
  });
});

// ==================== 口径正交性与边界 ====================
describe("两条口径正交 + 非终态", () => {
  it("非 completed 的 run 直接走 status：running/skipped/error 不做环节判定", () => {
    expect(runOutcome({ status: "running", score: null }).label).toBe("运行中");
    expect(runOutcome({ status: "skipped", score: null }).cls).toBe("badge warn");
    expect(runOutcome({ status: "error", score: null }).cls).toBe("badge bad");
    // 即使挂着看似成功的环节，也不篡改后端已判的终态
    expect(runOutcome({ status: "error", score: null, stage_summaries: [OBS_OK] }).label)
      .toBe("失败");
  });

  it("chips 只属于 completed：跳过/运行中的 run 不挂指标（避免「跳过 · 0.86」）", () => {
    expect(runMetricChips({ status: "skipped", score: null, stage_summaries: [OBS_OK] }))
      .toEqual([]);
    expect(runMetricChips({ status: "running", score: 0.8 })).toEqual([]);
  });

  // write-at-start（planrun.py 开跑即落一条 running 记录）之后，**正在跑**的 run
  // 会带着半截 stage_summaries 落库：已完的环节有真数字，炸掉的环节已带 error，
  // 而这个 run 其实还没跑完。此时唯一正确的显示是「运行中」——既不能吐只算了
  // 一半的指标 chip（「通过率 100%」只统计了跑完的那部分），也不能被半截里的
  // error 提前判成失败。
  //
  // 这条钉的是**两个提前 return 的位置**：runOutcome 与 runMetricChips 都必须在
  // 读 stage_summaries **之前**就按 status 短路。目前该组合靠这个顺序而结构上
  // 不可达——不可达 ≠ 有保障，谁把那两行挪到判定之后，这里是唯一会喊的地方。
  it("write-at-start 半截：running + 含 error 环节仍只报「运行中」，无 chip、不提前判失败", () => {
    // 已完的 observe 有真分、红队环节已炸、dataset 还没开始（键就不在）
    const halfWritten = { status: "running", score: null, stage_summaries: [OBS_OK, RT_ERR] };

    const o = runOutcome(halfWritten);
    expect(o.label).toBe("运行中");
    expect(o.kind).toBe("status");
    expect(o.cls).toBe("badge run");
    // 半截里的 error 不得把在跑的 run 判成「失败」或「部分失败」
    expect(o.failedStages).toEqual([]);
    expect(o.success).toBe(false);
    expect(isRunSuccess(halfWritten)).toBe(false);
    // 已完环节的真数字也不得漏成 chip（「运行中 · 0.83」自相矛盾）
    expect(runMetricChips(halfWritten)).toEqual([]);
  });

  // 标题措辞改准（断言一行未动）：isScored 现在走 effectiveScore —— 取分有**两个
  // 住址**（顶层 score，或 8/21 之前那批老 run 的 observe 环节 overall_mean）。
  // 原话「只认顶层 score」已失指；这条钉的从来是另一件事：**只认 observe 这个量纲**。
  it("硬线：不为 dataset/redteam 编造分数——isScored 只认 observe 那个量", () => {
    // 纯回归/纯红队成功 run：isRunSuccess=true 而 isScored=false，两口径分开
    expect(isScored(run([DS_OK]))).toBe(false);
    expect(isScored(run([RT_OK]))).toBe(false);
    expect(isRunSuccess(run([DS_OK]))).toBe(true);
  });

  it("breachOf：只聚合 completed 红队环节；没测过 → null 不是 0", () => {
    expect(breachOf({ stage_summaries: [RT_HIT, RT_OK] })).toBe(2);
    expect(breachOf({ stage_summaries: [RT_ERR] })).toBeNull(); // error 不算
    expect(breachOf({ stage_summaries: [OBS_OK] })).toBeNull();
  });
});
