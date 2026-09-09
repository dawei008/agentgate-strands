// lib/scoring.ts 的**分值读侧兜底**契约（2026-08-21 schema 演化 / 同页自相矛盾）。
//
// 缺陷现网实拍 `plan-c1202e599ada`：运行历史六行都挂着 0.74–0.78 的分数
// （运行历史 badge 走 stage_summaries[].overall_mean，老 run 有值），同一页的
// hero 却写「线上评估均分 ——」+「本方案还没有一次运行跑出线上评估分」、趋势写
// 「已有 0 次有分运行」（那两处走 isScored —— **修复前**它只认顶层 score；本文件
// 修好之后它走 effectiveScore，两个住址都认，见下方 describe）。
//
// 根因是 schema 演化，不是统计 bug：顶层 `score` 是 2026-08-22 才补进
// planrun.py:_persist 的（见该处注释），8/19–8/21 落库的 run **item 里没有这个
// 属性**（读路径 _run_from_item 把缺失补成 `score: null`，所以线上到前端的真形态
// 是 null，不是 undefined），而同一个量的另一个住所 —— observe 环节的
// overall_mean —— 一直都在。一个量两个住址，读侧只认新址 ⇒ 同页两个数打架。
//
// 修法是**读侧兜底**，不回填任何数据（旧数据不修，兼容形态常驻）：
// effectiveScore 先认顶层 score，缺了就从 observe 环节现推，算法与后端
// _persist 写顶层 score 那段逐字对齐（见 scoring.ts effectiveScore 注释）。
//
// 夹具形状逐字照后端 planrun.py:_stage_summary，数值照现网那条 run
// （`plan-c1202e599ada#20260820071501`：observe overall_mean 0.7539 / sessions 10）。
import { describe, expect, it } from "vitest";
import { effectiveScore, isScored } from "../src/lib/scoring";
import { deriveKpis, trendPoints } from "../src/pages/plan/derive";
import type { PlanRunSummary } from "../src/pages/plan/types";
import type { RunRow } from "../src/pages/workbench/types";

// ---- 老 run 的真形态（8/19–8/21 落库；顶层 score 为 null，环节里有分） ----
const OBS_LEGACY = {
  type: "observe", status: "completed", overall_mean: 0.7539, sessions: 10, summary: {},
};
const LEGACY_RUN = {
  status: "completed",
  score: null,
  started_at: "2026-08-20 07:15 UTC",
  stage_summaries: [OBS_LEGACY],
};
// 8/22 之后的新 run：顶层 score 已持久化
const NEW_RUN = {
  status: "completed",
  score: 0.78,
  started_at: "2026-08-23 07:15 UTC",
  stage_summaries: [{ type: "observe", status: "completed", overall_mean: 0.78, sessions: 10, summary: {} }],
};
// 硬线夹具（ADR-0003：绝不编造跨量纲分数）
const DS_OK = { type: "dataset", status: "completed", pass_rate: 1, cases: 8, blank_cases: 0 };
const RT_OK = { type: "redteam", status: "completed", breached: 0, attacks: 12, verdict: null };
const OBS_EMPTY = { type: "observe", status: "empty", error: "最近 30 天没有可评估的会话" };

describe("effectiveScore：顶层 score 与 observe overall_mean 是同一个量的两个住址", () => {
  it("老 run（顶层 score=null，observe overall_mean 在）→ 拿到环节里那个数", () => {
    expect(effectiveScore(LEGACY_RUN)).toBe(0.7539);
    // 这一条就是现网那页自相矛盾的修复点：运行历史显示 0.75，均分/趋势也必须收它
    expect(isScored(LEGACY_RUN)).toBe(true);
  });

  it("顶层属性整个缺失（DDB item 真形态）也兜住——不只兜 null", () => {
    const noKey = { status: "completed", stage_summaries: [OBS_LEGACY] };
    expect(effectiveScore(noKey)).toBe(0.7539);
    expect(isScored(noKey)).toBe(true);
  });

  it("新 run 以顶层 score 为准（有新址就不重算，两址一致时数字本来相同）", () => {
    expect(effectiveScore(NEW_RUN)).toBe(0.78);
    expect(isScored(NEW_RUN)).toBe(true);
  });

  it("overall_mean=0 是「0 分」不是「没有分」", () => {
    const zero = {
      status: "completed", score: null,
      stage_summaries: [{ ...OBS_LEGACY, overall_mean: 0 }],
    };
    expect(effectiveScore(zero)).toBe(0);
    expect(isScored(zero)).toBe(true);
  });

  it("多 observe 环节 → 等权均值，round 4（与后端 _persist 同算法）", () => {
    const two = {
      status: "completed", score: null,
      stage_summaries: [OBS_LEGACY, { ...OBS_LEGACY, overall_mean: 0.8123 }],
    };
    // python: round((0.7539+0.8123)/2, 4) == 0.7831
    expect(effectiveScore(two)).toBe(0.7831);
  });

  it("round 4 吃掉浮点毛刺：三个环节的均值不许以 0.7999999999999999 露到界面", () => {
    const three = {
      status: "completed", score: null,
      stage_summaries: [0.8, 0.9, 0.7].map((m) => ({ ...OBS_LEGACY, overall_mean: m })),
    };
    expect((0.8 + 0.9 + 0.7) / 3).not.toBe(0.8); // 未 round 的原值真长这样
    expect(effectiveScore(three)).toBe(0.8);     // python: round(…, 4) == 0.8
  });

  it("observe 环节 empty / 无环节且无分 → null（绝不拿 0 冒充）", () => {
    expect(effectiveScore({ status: "completed", score: null, stage_summaries: [OBS_EMPTY] })).toBeNull();
    expect(effectiveScore({ status: "completed", score: null, stage_summaries: [] })).toBeNull();
    expect(effectiveScore({ status: "completed", score: null })).toBeNull();
  });
});

describe("硬线反向钉：ADR-0003「绝不编造跨量纲分数」一字不松", () => {
  it("纯回归 run（只有 pass_rate）恒无分", () => {
    const r = { status: "completed", score: null, stage_summaries: [DS_OK] };
    expect(effectiveScore(r)).toBeNull();
    expect(isScored(r)).toBe(false);
  });

  it("纯红队 run（只有 attacks/breached）恒无分", () => {
    const r = { status: "completed", score: null, stage_summaries: [RT_OK] };
    expect(effectiveScore(r)).toBeNull();
    expect(isScored(r)).toBe(false);
  });

  it("回归+红队混跑（无 observe 环节）也不合成一个数", () => {
    const r = { status: "completed", score: null, stage_summaries: [DS_OK, RT_OK] };
    expect(effectiveScore(r)).toBeNull();
    expect(isScored(r)).toBe(false);
  });

  it("非 completed 的 run 恒无分：stopped / halted_cost / error / running / skipped", () => {
    for (const status of ["stopped", "halted_cost", "error", "failed", "running", "skipped"]) {
      const r = { status, score: null, stage_summaries: [OBS_LEGACY] };
      expect(effectiveScore(r), status).toBeNull();
      expect(isScored(r), status).toBe(false);
    }
  });

  it("非 completed 的 run 连顶层 score 都不认（半截 run 的分不是这次 run 的结论）", () => {
    const r = { status: "stopped", score: 0.91, stage_summaries: [OBS_LEGACY] };
    expect(effectiveScore(r)).toBeNull();
    expect(isScored(r)).toBe(false);
  });
});

describe("消费侧：老 run 进均分/趋势/工作台 KPI", () => {
  const legacyRuns = [
    { run_key: "plan-c1202e599ada#20260820071501", ...LEGACY_RUN, duration_s: 30 },
    {
      run_key: "plan-c1202e599ada#20260819071501", status: "completed", score: null,
      started_at: "2026-08-19 07:15 UTC", duration_s: 30,
      stage_summaries: [{ ...OBS_LEGACY, overall_mean: 0.7439 }],
    },
  ] as unknown as PlanRunSummary[];

  it("方案 KPI：均分不再是「—」，delta 按最近两次有分 run 算", () => {
    const k = deriveKpis(legacyRuns);
    expect(k.avgScore).toBeCloseTo((0.7539 + 0.7439) / 2, 10);
    expect(k.delta).toBeCloseTo(0.7539 - 0.7439, 10); // 最新 - 前一次
    expect(k.successCount).toBe(2);
  });

  it("趋势：两个点都在，score 取兜底出来的分值（不是 NaN、不是 0）", () => {
    const pts = trendPoints(legacyRuns);
    expect(pts.map((p) => p.score)).toEqual([0.7439, 0.7539]); // 时间升序
  });

  // 批 plans-board 起工作台 hero 不再算均分（ADR-0016：均分留在 Agent ① 现状）；
  // 消费侧硬线改钉 list_recent_runs 行形态（RunRow）上的判定/取值二元组本身。
  it("list_recent_runs 行形态：老 run 进线上评估均分样本（isScored 收、effectiveScore 取）", () => {
    const rows = [
      { run_key: "r1", plan_id: "p1", plan_name: "P", agent_name: "A", ...LEGACY_RUN },
    ] as unknown as RunRow[];
    const scored = rows.filter(isScored);
    expect(scored).toHaveLength(1);
    expect(effectiveScore(scored[0])).toBe(0.7539);
  });

  it("list_recent_runs 行形态：纯回归/纯红队 run 仍不进均分样本（硬线在消费侧同样成立）", () => {
    const rows = [
      { run_key: "r1", plan_id: "p1", plan_name: "P", agent_name: "A",
        status: "completed", score: null, started_at: "2026-08-20 07:15 UTC",
        stage_summaries: [DS_OK] },
      { run_key: "r2", plan_id: "p1", plan_name: "P", agent_name: "A",
        status: "completed", score: null, started_at: "2026-08-20 07:15 UTC",
        stage_summaries: [RT_OK] },
    ] as unknown as RunRow[];
    expect(rows.filter(isScored)).toHaveLength(0);
  });
});
