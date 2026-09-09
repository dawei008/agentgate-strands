// 分数趋势：纯回归方案（没有线上评估环节）此前是一句「已有 0 次有分运行」——
// 因为趋势只认 observe 分，而回归 run 的顶层 score 恒为 null。用户原话：
//   「分数趋势……这里应该显示每次评估后，评估器的分数和总体分数」
// 本文件钉住替代口径：每个评估器一条线（mean 随 run 序号）+ 总体通过率主线。
//
// ADR-0003 硬线的反向断言也在这里（趋势推导是最容易顺手把逐评估器均分
// reduce 成一个「总分」的地方）：
//   · 趋势点里**不存在**任何合成总分键，总体线只能是 pass_rate；
//   · 同一批 run 走 deriveKpis 仍然 avgScore=null —— 这些数字没进「线上评估
//     均分」KPI，也没进跨方案聚合（lib/scoring.ts 一行未动）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PlanDetailPage from "../src/pages/plan/PlanDetailPage";
import { deriveKpis, regressionTrend, trendPoints, evSeriesKey } from "../src/pages/plan/derive";
import { sseFrames } from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import type { PlanRunSummary, StageSummary } from "../src/pages/plan/types";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

const EVALUATORS = ["harmfulness", "correctness", "instruction_following", "refusal"];

/** 用户现场那一次（run #2）：refusal 0.50 拖着通过率 50%，其余都好 */
function dsStage(refusalMean: number, passRate: number, over: Partial<StageSummary> = {}): StageSummary {
  return {
    type: "dataset", status: "completed", dataset: "safety-regression-v1",
    pass_rate: passRate, cases: 2, blank_cases: 0,
    evaluators: EVALUATORS,
    evaluator_stats: {
      harmfulness: { mean: 1.0, passed: 2, judged: 2 },
      correctness: { mean: 1.0, passed: 2, judged: 2 },
      instruction_following: { mean: 0.9, passed: 2, judged: 2 },
      refusal: { mean: refusalMean, passed: 1, judged: 2 },
    },
    ...over,
  };
}

/** 纯回归 run：顶层 score **恒为 null**（后端只在有 observe overall_mean 时写） */
function regRun(key: string, at: string, stages: StageSummary[]): PlanRunSummary {
  return {
    run_key: key, status: "completed", score: null, started_at: at,
    duration_s: 100, triggered_by: "manual", stage_summaries: stages,
  };
}

const REG_RUNS: PlanRunSummary[] = [
  regRun("rk-2", "2026-08-24 16:51", [dsStage(0.5, 0.5)]),
  regRun("rk-1", "2026-08-23 16:51", [dsStage(0.4, 0.5)]),
];

const PLAN = {
  plan_id: "plan-reg01", name: "安全回归巡检", agent_name: "support-bot",
  updated_at: 1755500000,
  stages: [{ type: "dataset", dataset: "safety-regression-v1", evaluators: EVALUATORS }],
  schedule: null,
};

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [PLAN] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: REG_RUNS }],
  get_plan_run: (p) => [{ event: "plan_run", run_key: p.run_key, status: "completed",
    score: null, stages: [dsStage(0.5, 0.5)], plan_synthesis: null, synthesis_sections: [] }],
  estimate_plan_run: (p) => [{ event: "plan_run_estimate", plan_id: p.plan_id,
    stages: [], estimated_cost_usd: 0.2, note: "预估" }],
};

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    const handler = overrides[payload.action] ?? DEFAULTS[payload.action];
    if (!handler) return sseResponse([{ event: "error", error: `未打桩 action '${payload.action}'` }]);
    return sseResponse(handler(payload));
  }));
}

function renderDetail(id = "plan-reg01") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PlanDetailPage id={id} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  overrides = {};
  resetConfigForTest();
  resetRunFlightForTest();
  location.hash = "#/plan/plan-reg01";
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==================== 推导层（重心） ====================
describe("回归趋势推导（regressionTrend）", () => {
  it("两次运行两个点，时间升序；每点带总体通过率 + 四条评估器序列", () => {
    const { points, evaluators } = regressionTrend(REG_RUNS);
    expect(points).toHaveLength(2);
    expect(points[0].t).toBeLessThan(points[1].t);
    expect(points.map((p) => p.label)).toEqual(["08-23 16:51", "08-24 16:51"]);
    // 总体线 = pass_rate 原值（0-1），不是别的指标冒充
    expect(points.map((p) => p.passRate)).toEqual([0.5, 0.5]);
    // 每个评估器一条线：refusal 从 0.40 → 0.50
    expect(points.map((p) => p[evSeriesKey("refusal")])).toEqual([0.4, 0.5]);
    expect(points[1][evSeriesKey("instruction_following")]).toBe(0.9);
    expect(points[1][evSeriesKey("harmfulness")]).toBe(1);
    // 序列名单 = 图上的线，顺序照配置回显
    expect(evaluators).toEqual(EVALUATORS);
  });

  it("ADR-0003 反向断言：点里没有任何合成总分，总体线只能是 pass_rate", () => {
    const { points } = regressionTrend(REG_RUNS);
    const keys = Object.keys(points[1]).sort();
    expect(keys).toEqual([
      "ev:correctness", "ev:harmfulness", "ev:instruction_following", "ev:refusal",
      "label", "passRate", "t",
    ]);
    // 四个评估器均分的平均（0.85）绝不许作为「总分」出现在任何键上
    const synthesized = (1 + 1 + 0.9 + 0.5) / 4;
    expect(Object.values(points[1])).not.toContain(synthesized);
    // 「score」这个名字在趋势点里不存在——它是 observe 口径的专有词
    expect(points[1]).not.toHaveProperty("score");
    expect(points[1]).not.toHaveProperty("overall");
    expect(points[1]).not.toHaveProperty("overall_mean");
  });

  it("ADR-0003 反向断言：同一批 run 的 KPI 均分仍是 null（逐评估器分没进均分）", () => {
    const k = deriveKpis(REG_RUNS);
    expect(k.avgScore).toBeNull();
    expect(k.delta).toBeNull();
    // 但它们确实是成功运行（按环节判定，UI-013）——两条口径分开
    expect(k.successCount).toBe(2);
    // observe 口径的趋势本来就一个点都没有：这才是要换口径画的前提
    expect(trendPoints(REG_RUNS)).toHaveLength(0);
  });

  it("全被限流的评估器：那一点为 null（线断开），绝不补 0", () => {
    const runs = [
      regRun("rk-2", "2026-08-24 16:51", [dsStage(0.5, 0.5)]),
      regRun("rk-1", "2026-08-23 16:51", [{
        ...dsStage(0.4, 0.5),
        evaluator_stats: {
          harmfulness: { mean: 1.0, passed: 2, judged: 2 },
          correctness: { mean: 1.0, passed: 2, judged: 2 },
          instruction_following: { mean: 0.9, passed: 2, judged: 2 },
          refusal: { mean: null, passed: 0, judged: 0 },
        },
      }]),
    ];
    const { points, evaluators } = regressionTrend(runs);
    expect(points[0][evSeriesKey("refusal")]).toBeNull();
    expect(points[1][evSeriesKey("refusal")]).toBe(0.5);
    // 另一次有分 → 这条线仍在名单里（只是断了一段）
    expect(evaluators).toContain("refusal");
  });

  it("老 run（无 evaluator_stats）：那个点只画得出通过率就只画通过率", () => {
    const runs = [
      regRun("rk-2", "2026-08-24 16:51", [dsStage(0.5, 0.5)]),
      // 2026-08 之前落库的形态：只有 pass_rate / cases / blank_cases
      regRun("rk-1", "2026-08-23 16:51", [{
        type: "dataset", status: "completed", pass_rate: 0.75, cases: 4, blank_cases: 0,
      }]),
    ];
    const { points } = regressionTrend(runs);
    expect(points[0].passRate).toBe(0.75);
    expect(points[0][evSeriesKey("refusal")]).toBeUndefined();
    expect(points[1][evSeriesKey("refusal")]).toBe(0.5);
  });

  it("全程无有效判定的评估器不进线名单（报告表里留名，图上没有点可画）", () => {
    const runs = [
      regRun("rk-2", "2026-08-24 16:51", [{
        ...dsStage(0.5, 0.5),
        evaluators: ["correctness", "never_judged"],
        evaluator_stats: { correctness: { mean: 0.9, passed: 1, judged: 1 },
                           never_judged: { mean: null, passed: 0, judged: 0 } },
      }]),
      regRun("rk-1", "2026-08-23 16:51", [{
        ...dsStage(0.4, 0.5),
        evaluators: ["correctness", "never_judged"],
        evaluator_stats: { correctness: { mean: 0.8, passed: 1, judged: 1 },
                           never_judged: { mean: null, passed: 0, judged: 0 } },
      }]),
    ];
    const { evaluators } = regressionTrend(runs);
    expect(evaluators).toEqual(["correctness"]);
  });

  it("只认 completed 的回归环节：失败/熔断/empty 都不出点（半截数字不是结论）", () => {
    const runs = [
      regRun("rk-3", "2026-08-24 16:51", [{ type: "dataset", status: "error",
        error: "上游 502 · 已重试 2 次" }]),
      regRun("rk-2", "2026-08-23 16:51", [{ type: "dataset", status: "halted_cost",
        pass_rate: 1, cases: 2, evaluators: ["correctness"],
        evaluator_stats: { correctness: { mean: 1, passed: 2, judged: 2 } } }]),
      regRun("rk-1", "2026-08-22 16:51", [{ type: "dataset", status: "empty", cases: 0,
        evaluators: [], evaluator_stats: {},
        error: "环节未配置评估器，未执行（配置评估器后重跑）" }]),
      regRun("rk-0", "2026-08-21 16:51", [dsStage(0.6, 1)]),
    ];
    const { points } = regressionTrend(runs);
    expect(points).toHaveLength(1);
    expect(points[0].label).toBe("08-21 16:51");
  });

  it("有线上评估环节的方案不受影响：observe 口径的 trendPoints 一字不改", () => {
    const mixed: PlanRunSummary[] = [
      { run_key: "m-2", status: "completed", score: 0.86, started_at: "2026-08-11 09:00",
        duration_s: 74, triggered_by: "manual", stage_summaries: [
          { type: "observe", status: "completed", overall_mean: 0.86, sessions: 12 },
          dsStage(0.5, 0.5),
        ] },
      { run_key: "m-1", status: "completed", score: 0.78, started_at: "2026-08-09 03:00",
        duration_s: 81, triggered_by: "schedule", stage_summaries: [
          { type: "observe", status: "completed", overall_mean: 0.78, sessions: 10 },
        ] },
    ];
    expect(trendPoints(mixed).map((p) => p.score)).toEqual([0.78, 0.86]);
  });

  it("limit 截断取最近 N 次；无回归 run → 空", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      regRun(`rk-${i}`, `2026-08-2${i} 03:00`, [dsStage(0.5, i / 10)]));
    const { points } = regressionTrend(many, 2);
    expect(points.map((p) => p.passRate)).toEqual([0.3, 0.4]); // 最近两次，升序
    expect(regressionTrend([]).points).toEqual([]);
    expect(regressionTrend([{ run_key: "o", status: "completed", score: 0.8,
      started_at: "2026-08-01 03:00", duration_s: 1,
      stage_summaries: [{ type: "observe", status: "completed", overall_mean: 0.8 }] }]).points)
      .toEqual([]);
  });
});

// ==================== 趋势卡（页面） ====================
describe("趋势卡：纯回归方案改画逐评估器 + 通过率", () => {
  it("副标题说回归口径 + 图例列出四个评估器与通过率主线", async () => {
    renderDetail();
    await screen.findByTestId("plan-trend-card");
    await waitFor(() => expect(screen.getByTestId("plan-trend-chart")).toBeInTheDocument());
    // 不再是「0 次有分运行」那句误导（本方案根本没有线上评估环节）
    expect(screen.queryByTestId("plan-trend-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-trend-card")).not.toHaveTextContent("次有分运行");
    expect(screen.getByTestId("plan-trend-card")).toHaveTextContent("最近 2 次回归运行");
    expect(screen.getByTestId("plan-trend-card")).toHaveTextContent("4 个评估器");

    // 图例：主次分明（通过率是主线），评估器名原文不翻译
    const legend = screen.getByTestId("plan-trend-legend");
    expect(legend).toHaveTextContent("通过率");
    for (const name of EVALUATORS) {
      expect(screen.getByTestId(`plan-trend-legend-${name}`)).toHaveTextContent(name);
    }
    // 图例带最近一次的数字：「refusal 0.50」——一眼看出谁在拖
    expect(screen.getByTestId("plan-trend-legend-refusal")).toHaveTextContent("0.50");
    expect(screen.getByTestId("plan-trend-legend-pass-rate")).toHaveTextContent("50%");
  });

  it("区间统计列换成通过率口径（数字来自 pass_rate 序列）", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id, runs: [
        regRun("rk-2", "2026-08-24 16:51", [dsStage(0.5, 0.5)]),
        regRun("rk-1", "2026-08-23 16:51", [dsStage(0.4, 1)]),
      ],
    }];
    renderDetail();
    const side = await screen.findByTestId("plan-trend-stats");
    expect(side).toHaveTextContent("通过率");
    expect(screen.getByTestId("trend-stat-max")).toHaveTextContent("1.00");
    expect(screen.getByTestId("trend-stat-min")).toHaveTextContent("0.50");
    expect(screen.getByTestId("trend-stat-delta")).toHaveTextContent("−0.50");
    expect(screen.getByTestId("trend-stat-below")).toHaveTextContent("1 次");
  });

  it("只有一次回归运行：空态说回归口径，不说「0 次有分运行」", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: [regRun("rk-1", "2026-08-24 16:51", [dsStage(0.5, 0.5)])],
    }];
    renderDetail();
    // ⚠️ 锚点挑**目标数据专属**的那句，不用 findByTestId("plan-trend-empty")：
    // 这个节点在 list_plan_runs 落地之前就已经在场（那时渲染的是通用那一版
    // 「已有 0 次有分运行…」），拿它当锚点等到的是**门槛数据** —— 全套并跑时
    // 实测偶发红，收到的正是未落地那一版的文案。
    await waitFor(() => expect(screen.getByTestId("plan-trend-empty"))
      .toHaveTextContent("已有 1 次回归运行，趋势图需要至少 2 次"));
    const empty = screen.getByTestId("plan-trend-empty");
    expect(empty).not.toHaveTextContent("有分运行");
    expect(screen.queryByTestId("plan-trend-chart")).not.toBeInTheDocument();
  });

  it("一次回归 run 都没有（全失败）：回到原空态文案，不谈回归趋势", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: [{ run_key: "rk-1", status: "error", score: null,
        started_at: "2026-08-24 16:51", duration_s: 3, triggered_by: "manual",
        stage_summaries: [{ type: "dataset", status: "error", error: "上游 502" }] }],
    }];
    renderDetail();
    // ⚠️「已有 0 次有分运行」这句在 runs 落地**之前**就是这个值（未落地的通用
    // 空态一字不差）⇒ 它单独立不住：正确值与兜底值同形，断言分不出两态。先等
    // 只有落地后才成立的那句原因（未落地时是「本方案还没有运行记录；它也**没有**
    // 线上评估环节，因此**不会**有分数点位」，用词不同）。
    await waitFor(() => expect(screen.getByTestId("plan-trend-empty-reason"))
      .toHaveTextContent("本评估计划没有线上评估环节，因此没有分数点位"));
    const empty = screen.getByTestId("plan-trend-empty");
    expect(empty).toHaveTextContent("已有 0 次有分运行，趋势图需要至少 2 次");
    expect(screen.queryByTestId("plan-trend-legend")).not.toBeInTheDocument();
  });

  it("有线上评估分的方案：趋势卡行为保持原样（不出图例、副标题说有分运行）", async () => {
    overrides.list_plans = () => [{ event: "plans", plans: [{
      ...PLAN, stages: [{ type: "observe", evaluators: ["helpfulness"] },
                        { type: "dataset", dataset: "safety-regression-v1", evaluators: EVALUATORS }],
    }] }];
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id, runs: [
        { run_key: "m-2", status: "completed", score: 0.86, started_at: "2026-08-11 09:00",
          duration_s: 74, triggered_by: "manual", stage_summaries: [
            { type: "observe", status: "completed", overall_mean: 0.86, sessions: 12 },
            dsStage(0.5, 0.5)] },
        { run_key: "m-1", status: "completed", score: 0.78, started_at: "2026-08-09 03:00",
          duration_s: 81, triggered_by: "schedule", stage_summaries: [
            { type: "observe", status: "completed", overall_mean: 0.78, sessions: 10 }] },
      ],
    }];
    renderDetail();
    await screen.findByTestId("plan-trend-card");
    await waitFor(() => expect(screen.getByTestId("plan-trend-chart")).toBeInTheDocument());
    expect(screen.getByTestId("plan-trend-card")).toHaveTextContent("最近 2 次有分运行");
    expect(screen.queryByTestId("plan-trend-legend")).not.toBeInTheDocument();
    expect(screen.getByTestId("trend-stat-max")).toHaveTextContent("0.86");
  });
});
