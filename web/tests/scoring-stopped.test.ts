// 用户主动停止的 run 不许把英文枚举 "stopped" 印给用户（同族：halted_cost）。
//
// 后端新增了「请求停止一次正在花钱的运行」的能力（app/planrun.py request_stop +
// stop_requested，检查点在环节循环 / testrun 的用例循环 / redteam 的进度循环）。
// 收敛后的 run 与被掐断的环节都带 `status="stopped"`，run 上还带一句中文说明
// （error 字段，既有通道）。
//
// 本文件只钉两件事（判定逻辑一步没动，那是 ADR-0003 的四级优先级）：
//   1. STATUS_LABEL / statusBadgeClass 认识 stopped —— 否则 runOutcome 的
//      `?? run.status` 兜底会把 "stopped" 原样印出来（halted_cost 就是这么漏的）；
//   2. 语义类与「跳过 / 成本熔断」同刑（warn 而非 bad）：用户主动中止不是崩了，
//      产出通常是半截而不是空，红色会读成「跑挂了」。
//
// 停止的 run 是**非 completed** 的，所以它走 runOutcome 的第 1 级（status 行），
// 环节判定根本不参与 —— 这也是为什么后端不给 stopped 的 run 写顶层 score。
import { describe, expect, it } from "vitest";
import {
  STATUS_LABEL,
  isRunSuccess,
  isScored,
  runMetricChips,
  runOutcome,
  statusBadgeClass,
} from "../src/lib/scoring";

// 停止的方案 run 的真形态（后端 planrun.py `_persist(status=STOP_STATUS)`）：
// 已完成环节的摘要留着、顶层 score 不写、error 说明为什么。
const STOPPED_RUN = {
  status: "stopped",
  score: null,
  error: "已按用户请求停止：第 2/3 个环节开始前中止，已完成 1 个环节的结果与费用照常保留",
  stage_summaries: [
    { type: "observe", status: "completed", overall_mean: 0.91, sessions: 4, summary: {} },
  ],
};

describe("停止终态：有中文文案、有语义类", () => {
  it("stopped 有中文文案（不许露出英文枚举）", () => {
    expect(STATUS_LABEL.stopped).toBe("已停止");
  });

  it("与「跳过 / 成本熔断」同刑：warn，不是 bad", () => {
    expect(statusBadgeClass("stopped")).toBe("badge warn");
    expect(statusBadgeClass("stopped")).toBe(statusBadgeClass("halted_cost"));
  });

  it("runOutcome 走 status 那一级：文案是「已停止」，不算成功运行", () => {
    const o = runOutcome(STOPPED_RUN);
    expect(o.kind).toBe("status");
    expect(o.label).toBe("已停止");
    expect(o.cls).toBe("badge warn");
    expect(o.success).toBe(false);
    expect(isRunSuccess(STOPPED_RUN)).toBe(false);
  });

  it("半截 run 不进均分/趋势，也不吐指标 chip", () => {
    expect(isScored(STOPPED_RUN)).toBe(false);
    // 环节里那个 0.91 是真的，但它属于「已完成的那一环」，不是这次 run 的结论
    expect(runMetricChips(STOPPED_RUN)).toEqual([]);
  });

  it("回归：既有六态文案与语义类一个字不变", () => {
    expect(STATUS_LABEL.completed).toBe("完成");
    expect(STATUS_LABEL.error).toBe("失败");
    expect(STATUS_LABEL.failed).toBe("失败");
    expect(STATUS_LABEL.skipped).toBe("跳过");
    expect(STATUS_LABEL.running).toBe("运行中");
    expect(STATUS_LABEL.halted_cost).toBe("成本熔断中止");
    expect(statusBadgeClass("completed")).toBe("badge ok");
    expect(statusBadgeClass("error")).toBe("badge bad");
    expect(statusBadgeClass("running")).toBe("badge run");
    expect(statusBadgeClass("wat")).toBe("badge");
  });
});
