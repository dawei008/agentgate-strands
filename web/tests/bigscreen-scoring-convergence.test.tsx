// 大屏分数口径收敛（scoreOf → lib/scoring.effectiveScore，单一住所）。
//
// 收敛前 bigscreen/derive.ts 的本地 scoreOf 与 effectiveScore 有三条实现差
// （scoring.ts 头部注释登记在案）：⑴ 读序相反（先环节后顶层 score）⑵ 多一条
// 环节 status==="completed" 过滤 ⑶ 算完不 round 4。三条均为**有意收敛**，
// 行为以 effectiveScore 为准（= 后端 planrun.py:_persist 的逐字同刑）。
//
// 三角钉纪律：对刑断言不许两边 import 同一个函数恒真 —— 下面至少一条用
// 硬编码字面量钉预期值（0.5013 / 0.7 / 0.83），另配 fixture 毛刺自检，
// 保证「夹具真的会产生浮点毛刺」这个前提本身不静默失效。
import { describe, expect, it } from "vitest";
import { effectiveScore } from "../src/lib/scoring";
import {
  deriveAgents, deriveEvents, deriveKpi, isScored, scoreOf,
} from "../src/pages/bigscreen/derive";
import type { BigscreenRun, StageSummary } from "../src/pages/bigscreen/types";

/** 假数据基准时刻（与 bigscreen.test.tsx / handlers.ts 两态数据集一致） */
const PINNED = Date.UTC(2026, 7, 22, 4, 12, 0);

function obs(mean: number | null, status = "completed"): StageSummary {
  return { type: "observe", status, overall_mean: mean, sessions: 10 };
}

function bsr(
  key: string,
  stages: StageSummary[],
  extra: Partial<BigscreenRun> = {},
): BigscreenRun {
  return {
    run_key: key, plan_id: "p1", plan_name: "客服主链路", agent_name: "支持助手",
    status: "completed", score: null, started_at: "2026-08-22 03:00 UTC",
    duration_s: 60, stage_summaries: stages, ...extra,
  };
}

describe("大屏分数口径收敛：差异⑶ round4（多 observe 浮点毛刺）", () => {
  it("KPI 均分吃 round4 后的值：两 observe 相加除二的毛刺不外漏", () => {
    // 夹具毛刺自检：这对字面量的原始均值确实带尾巴（不是恰好可表示的数）——
    // 没这条，下面的 toBe(0.5013) 在「夹具其实没毛刺」时会恒真。
    expect((0.5 + 0.5026) / 2).not.toBe(0.5013);
    const r = bsr("r_round4", [obs(0.5), obs(0.5026)]);
    // 硬编码字面量钉：收敛前本地 scoreOf 不 round，avg 是 0.5013000000000001
    expect(deriveKpi([r], [], PINNED).avg).toBe(0.5013);
    expect(scoreOf(r)).toBe(0.5013);
  });

  it("目标线比较吃 round4 后的值：原始均值 0.6999…998 不再触发「跌破目标线」", () => {
    // 三 observe 的原始均值 < 0.70（毛刺自检），round4 后恰为 0.70 —— 收敛前
    // 会报「线上评估均分跌破目标线 0.70：本次 0.70」这种自相矛盾的事件。
    expect((0.55 + 0.5556 + 0.9944) / 3).toBeLessThan(0.7);
    const r = bsr("r_line", [obs(0.55), obs(0.5556), obs(0.9944)]);
    expect(deriveKpi([r], [], PINNED).avg).toBe(0.7);
    // 事件侧栏：无任何事件（0.70 不低于目标线 0.70）
    expect(deriveEvents([r])).toEqual([]);
    // Agent 标签：达标，不是「低于目标」
    const a = deriveAgents([r], []).find((x) => x.name === "支持助手")!;
    expect(a.level).toBe("ok");
    expect(a.tag?.t).toBe("达标");
  });
});

describe("大屏分数口径收敛：差异⑴⑵ 与对刑（防再分叉）", () => {
  it("差异⑴ 读序：顶层 score 是 number 时以它为准（与 effectiveScore 同序）", () => {
    // 真数据上两址同值（顶层 score 就是后端按同算法写的）；此形状为分歧
    // 探针 —— 收敛前本地 scoreOf 先读环节得 0.9。
    const r = bsr("r_order", [obs(0.9)], { score: 0.83 });
    expect(scoreOf(r)).toBe(0.83);
    expect(deriveKpi([r], [], PINNED).avg).toBe(0.83);
  });

  it("差异⑵ 不加环节 status 过滤：与后端 _persist 逐字同刑", () => {
    // 契约上带 overall_mean 的 observe 必然 completed（planrun.py 只有两条
    // 返回路径），此形状不该出现 —— 断言的是「不加私货过滤、与后端算法
    // 逐字同刑」这条性质本身：收敛前本地 scoreOf 会把它滤掉得 null。
    const r = bsr("r_nofilter", [obs(0.9, "error")]);
    expect(scoreOf(r)).toBe(0.9);
    expect(isScored(r)).toBe(true);
  });

  it("对刑：大屏取分与 effectiveScore 同源（逐 run 相等，含 KPI 均分）", () => {
    const runs = [
      bsr("r_a", [obs(0.5), obs(0.5026)]),
      bsr("r_b", [obs(0.74)]),
      bsr("r_c", [obs(0.9)], { score: 0.83 }),
    ];
    for (const r of runs) expect(scoreOf(r)).toBe(effectiveScore(r));
    const want =
      runs.reduce((a, r) => a + (effectiveScore(r) as number), 0) / runs.length;
    expect(deriveKpi(runs, [], PINNED).avg).toBe(want);
  });
});

describe("大屏分数口径收敛：老形态 run 兜底不回退", () => {
  it("score:null + observe overall_mean（8/21 前落库形态）照旧有分", () => {
    // 收敛后走 effectiveScore 的环节兜底路径，行为与原 scoreOf 一致。
    const r = bsr("r_legacy", [obs(0.74)], { score: null });
    expect(isScored(r)).toBe(true);
    expect(scoreOf(r)).toBe(0.74);
    const k = deriveKpi([r], [], PINNED);
    expect(k.avg).toBe(0.74);
    expect(k.avgN).toBe(1);
    // mini 趋势同样吃到这条分
    const a = deriveAgents([r], []).find((x) => x.name === "支持助手")!;
    expect(a.hist).toEqual([0.74]);
    expect(a.score).toBe(0.74);
  });

  it("stage_summaries 为空 + 顶层 score（跳过环节的归档形态）照旧有分", () => {
    const r = bsr("r_toponly", [], { score: 0.77 });
    expect(scoreOf(r)).toBe(0.77);
    expect(isScored(r)).toBe(true);
  });
});
