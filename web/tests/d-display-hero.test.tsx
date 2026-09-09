// D-1 / D-2（domain-r1 拍板「全按推荐」）：方案详情 hero 与趋势卡空态
// 不再对纯回归 / 纯红队方案说「当前均分 —」。
//
// 用户现场（decisions-needed.md 开头那次）：跑了两次回归 + 红队方案，看到
// 「当前均分 —」「趋势 0 次」，问「为什么趋势和分数还没出来」——代码行为全对
// （顶层 score 只由 observe 环节写，ADR-0003），错的是界面用同一批词说了两件事。
//
// 本文件钉两件：
//   D-1 hero 按**方案环节组成**选指标（含 observe→线上评估均分 / 无 observe 但含
//       dataset→回归通过率 / 只有 redteam→红队攻破 x/y），三种「—」各有各的原话；
//   D-2 趋势卡空态点名原因（有 observe 没跑出分 vs 根本没有 observe 环节）。
//
// ⚠️ ADR-0003 硬线的反向断言也在这里：hero 换了指标**不等于**合成了跨量纲总分 ——
// 同一批 run 走 deriveKpis 仍然 avgScore=null，lib/scoring.ts 一行未动。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { expectProseGone } from "./prose";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PlanDetailPage from "../src/pages/plan/PlanDetailPage";
import {
  deriveKpis, planHero, planMetricKind, runPassRate, trendEmptyReason,
} from "../src/pages/plan/derive";
import { sseFrames } from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import type { Plan, PlanRunSummary, PlanStage, StageSummary } from "../src/pages/plan/types";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

// ---------- 夹具：三种方案组成，各自的 run 形态照 planrun.py:_stage_summary ----------

const OBSERVE_STAGE: PlanStage = { type: "observe", evaluators: ["helpfulness"] };
const DATASET_STAGE: PlanStage = {
  type: "dataset", dataset: "faq-regression-v3", evaluators: ["correctness"],
};
const REDTEAM_STAGE: PlanStage = {
  type: "redteam", cases_dataset: "jailbreak-probes", evaluators: ["harmfulness"],
};

function dsStage(passRate: number): StageSummary {
  return {
    type: "dataset", status: "completed", pass_rate: passRate, cases: 10, blank_cases: 0,
    evaluators: ["correctness"],
    evaluator_stats: { correctness: { mean: 0.9, passed: 9, judged: 10 } },
  };
}

function rtStage(breached: number, attacks: number): StageSummary {
  return { type: "redteam", status: "completed", breached, attacks, verdict: null };
}

/** 纯回归 / 纯红队 run：顶层 score **恒 null**（后端只在有 observe overall_mean 时写） */
function run(key: string, at: string, stages: StageSummary[], score: number | null = null): PlanRunSummary {
  return {
    run_key: key, status: "completed", score, started_at: at,
    duration_s: 120, triggered_by: "manual", stage_summaries: stages,
  };
}

/** 最近在前（列表页同序） */
const REG_RUNS: PlanRunSummary[] = [
  run("reg-2", "2026-08-24 02:00", [dsStage(0.9)]),
  run("reg-1", "2026-08-17 02:00", [dsStage(0.8)]),
];

const RT_RUNS: PlanRunSummary[] = [
  run("rt-2", "2026-08-24 02:00", [rtStage(3, 12)]),
  run("rt-1", "2026-08-17 02:00", [rtStage(1, 12)]),
];

/** 含 observe 环节但一次都没跑出分（环节 empty：回溯窗口里没有会话） */
const OBS_EMPTY_RUNS: PlanRunSummary[] = [
  run("obs-1", "2026-08-24 02:00",
    [{ type: "observe", status: "empty", error: "最近 30 天没有可评估的会话" }]),
];

function planOf(id: string, stages: PlanStage[]): Plan {
  return {
    plan_id: id, name: `方案 ${id}`, agent_name: "support-bot",
    updated_at: 1755500000, stages, schedule: null,
  };
}

const PLANS: Record<string, Plan> = {
  "plan-mix": planOf("plan-mix", [OBSERVE_STAGE, DATASET_STAGE]),
  "plan-reg": planOf("plan-reg", [DATASET_STAGE]),
  // 只跑过一次回归：口径 B 的点数不足 2，趋势卡走空态（D-2 的落点之一）
  "plan-reg1": planOf("plan-reg1", [DATASET_STAGE]),
  "plan-rt": planOf("plan-rt", [REDTEAM_STAGE]),
  "plan-obs": planOf("plan-obs", [OBSERVE_STAGE]),
};

const RUNS_OF: Record<string, PlanRunSummary[]> = {
  "plan-mix": [run("mix-1", "2026-08-24 02:00",
    [{ type: "observe", status: "completed", overall_mean: 0.82, sessions: 4 }], 0.82)],
  "plan-reg": REG_RUNS,
  "plan-reg1": [REG_RUNS[0]],
  "plan-rt": RT_RUNS,
  "plan-obs": OBS_EMPTY_RUNS,
};

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: Object.values(PLANS) }],
  list_plan_runs: (p) => [{
    event: "plan_runs", plan_id: p.plan_id,
    runs: RUNS_OF[String(p.plan_id)] ?? [],
  }],
  estimate_plan_run: (p) => [{
    event: "plan_run_estimate", plan_id: p.plan_id, stages: [],
    estimated_cost_usd: 0.2, note: "预估",
  }],
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

function renderDetail(id: string) {
  location.hash = `#/plan/${id}`;
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
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==================== D-1 推导层 ====================
describe("D-1 hero 指标按方案环节组成自适应（planMetricKind / planHero）", () => {
  it("环节组成 → 指标口径：含 observe 恒走线上评估；无 observe 才看 dataset/redteam", () => {
    expect(planMetricKind([OBSERVE_STAGE])).toBe("observe");
    expect(planMetricKind([OBSERVE_STAGE, DATASET_STAGE])).toBe("observe");
    expect(planMetricKind([DATASET_STAGE])).toBe("regression");
    expect(planMetricKind([DATASET_STAGE, REDTEAM_STAGE])).toBe("regression");
    expect(planMetricKind([REDTEAM_STAGE])).toBe("redteam");
    // 环节未知（老数据 / 列表未带 stages）→ 退回线上评估口径（保持现状）
    expect(planMetricKind([])).toBe("observe");
    expect(planMetricKind(undefined)).toBe("observe");
  });

  it("纯回归方案：hero =「回归通过率」+ pass_rate 均值，环比按百分点", () => {
    const h = planHero([DATASET_STAGE], REG_RUNS);
    expect(h.kind).toBe("regression");
    expect(h.label).toBe("回归通过率");
    expect(h.value).toBe("85%");            // (0.9 + 0.8) / 2
    expect(h.deltaText).toBe("+10 个百分点"); // 0.9 - 0.8，不写成「+0.10」（那读成分数）
    expect(h.deltaNeg).toBe(false);
    // 度量词纪律（CONTEXT.md:93-96）：这一格一个「均分」字都不许出现
    expect(`${h.label}${h.scope}${h.value}${h.meta}`).not.toContain("均分");
  });

  it("单个 run 的回归通过率 = completed dataset 环节 pass_rate 等权均值（0% 是结论）", () => {
    expect(runPassRate(run("a", "2026-08-24 02:00", [dsStage(0)]))).toBe(0);
    expect(runPassRate(run("b", "2026-08-24 02:00", [dsStage(0.5), dsStage(1)]))).toBe(0.75);
    // 没跑完的环节不出数（半截数字不是结论）
    expect(runPassRate(run("c", "2026-08-24 02:00",
      [{ type: "dataset", status: "halted_cost", pass_rate: 1 }]))).toBeNull();
    expect(runPassRate(run("d", "2026-08-24 02:00", [rtStage(0, 3)]))).toBeNull();
  });

  it("纯红队方案：hero =「红队攻破 x/y」，取最近一次红队运行，不跨 run 累加", () => {
    const h = planHero([REDTEAM_STAGE], RT_RUNS);
    expect(h.kind).toBe("redteam");
    expect(h.label).toBe("红队攻破");
    expect(h.value).toBe("3");     // 最近一次 3/12，**不是** 4（1+3 的历史累加）
    expect(h.denom).toBe("/12");
    expect(h.deltaText).toBeNull(); // 绝对计数不做环比
    expect(`${h.label}${h.scope}${h.meta}`).not.toContain("均分");
  });

  it("含 observe 但没跑出分 / 无 observe 环节：两种「—」原话不同（不共用一句）", () => {
    const obs = planHero([OBSERVE_STAGE], OBS_EMPTY_RUNS);
    expect(obs.value).toBeNull();
    expect(obs.label).toBe("线上评估均分");
    expect(obs.emptyText).toContain("有线上评估环节");
    const reg = planHero([DATASET_STAGE], []);
    expect(reg.value).toBeNull();
    expect(reg.emptyText).toContain("没有线上评估环节");
    expect(reg.emptyText).not.toBe(obs.emptyText);
  });

  it("ADR-0003 硬线：换 hero 指标≠合成总分——同一批 run 的 avgScore 仍是 null", () => {
    expect(deriveKpis(REG_RUNS).avgScore).toBeNull();
    expect(deriveKpis(RT_RUNS).avgScore).toBeNull();
    // 而「成功运行」按环节判定照样是 2/2（口径 2，与上面那条正交）
    expect(deriveKpis(REG_RUNS).successCount).toBe(2);
    expect(deriveKpis(RT_RUNS).successCount).toBe(2);
  });
});

// ==================== D-1 页面 ====================
describe("D-1 hero 页面渲染（三形态）", () => {
  it("含 observe 的方案：hero 仍是线上评估均分（现状不动）", async () => {
    renderDetail("plan-mix");
    const hero = await screen.findByTestId("plan-kpi-avg");
    await waitFor(() => expect(hero).toHaveTextContent("0.82"));
    expect(hero.dataset.metric).toBe("observe");
    expect(screen.getByTestId("plan-kpis")).toHaveTextContent("线上评估均分");
  });

  it("纯回归方案：hero =「回归通过率 85%」，整条 KPI 里没有「均分」二字", async () => {
    renderDetail("plan-reg");
    const hero = await screen.findByTestId("plan-kpi-avg");
    // 锚点挑本方案专属数字（85% = 0.9/0.8 的均值），不是通用文案
    await waitFor(() => expect(hero).toHaveTextContent("85%"));
    expect(hero.dataset.metric).toBe("regression");
    const strip = screen.getByTestId("plan-kpis");
    expect(strip).toHaveTextContent("回归通过率");
    expect(strip).not.toHaveTextContent("均分");
    // 空态那句话不许同时在场（有数字就不是空态）
    expect(screen.queryByTestId("plan-kpi-avg-empty")).not.toBeInTheDocument();
  });

  it("纯红队方案：hero =「红队攻破 3/12」（分母走 .denom，不是分数）", async () => {
    renderDetail("plan-rt");
    const hero = await screen.findByTestId("plan-kpi-avg");
    await waitFor(() => expect(hero).toHaveTextContent("3"));
    expect(hero).toHaveTextContent("/12");
    expect(hero.dataset.metric).toBe("redteam");
    const strip = screen.getByTestId("plan-kpis");
    expect(strip).toHaveTextContent("红队攻破");
    expect(strip).not.toHaveTextContent("均分");
    expect(strip).not.toHaveTextContent("通过率");
  });

  it("含 observe 却没跑出分：hero 走「—」+ 说清是「有环节没分」而不是没环节", async () => {
    renderDetail("plan-obs");
    const empty = await screen.findByTestId("plan-kpi-avg-empty");
    expect(empty).toHaveTextContent("有线上评估环节");
    expect(screen.getByTestId("plan-kpi-avg")).toHaveTextContent("—");
    // 「暂无可评分的运行」那句旧文案（不说原因）不许再出现
    expect(screen.getByTestId("plan-kpis")).not.toHaveTextContent("暂无可评分的运行");
  });
});

// ==================== D-2 趋势空态点名原因 ====================
//
// 「成功运行 2/2」（口径 2）与「趋势 0 点」（口径 1）合法地不相等
// （CONTEXT.md:145-150），但此前**没有任何一处**告诉用户为什么可以不等。
// 原因行是**追加**的一句（主句仍是触发条件），口径 B 的既有文案与
// evaluator-metrics-trend.test.tsx 那张保护网一字未动。
describe("D-2 趋势卡空态原因（trendEmptyReason）", () => {
  it("没有 observe 环节 + 全部成功：点名「都成功了，但没有分数点位」", () => {
    const r = trendEmptyReason({
      kind: "redteam", scoredCount: 0, successCount: 2, totalCount: 2, regressionPoints: 0,
    });
    expect(r).toContain("2 次运行都成功了");
    expect(r).toContain("没有线上评估环节");
    expect(r).toContain("没有分数点位");
    // 指路句「红队结果看上方「红队攻破」与运行历史里…」对任何纯红队方案恒成立 ⇒ 删
    // （prose-sweep 2026-09-03；此前钉的是它**在**）
    expect(r).not.toMatch(/红队攻破|运行历史里/);
  });

  it("没有 observe 环节 + 部分成功：不谎称「都成功了」，如实给 M/N", () => {
    const r = trendEmptyReason({
      kind: "regression", scoredCount: 0, successCount: 1, totalCount: 3, regressionPoints: 0,
    });
    expect(r).not.toContain("都成功了");
    expect(r).toContain("成功运行 1/3");
    // 指路句「回归结果看上方「回归通过率」…」已删（同上）
    expect(r).not.toMatch(/回归通过率|运行历史里/);
  });

  it("有 observe 环节但尚无有分运行：另一句话（与上面那句不共用）", () => {
    const obs = trendEmptyReason({
      kind: "observe", scoredCount: 0, successCount: 1, totalCount: 2, regressionPoints: 0,
    });
    expect(obs).toContain("有线上评估环节");
    expect(obs).toContain("成功运行 1/2");
    expect(obs).not.toContain("没有线上评估环节");
    // 已经有 1 次有分运行时不再解释（主句「需要至少 2 次」已说完）
    expect(trendEmptyReason({
      kind: "observe", scoredCount: 1, successCount: 1, totalCount: 1, regressionPoints: 0,
    })).toBe("");
  });

  it("口径 B 只有 1 个点：只说本方案的数，不再追加「再跑一次即可连线」，且不说「有分运行」", () => {
    const r = trendEmptyReason({
      kind: "regression", scoredCount: 0, successCount: 1, totalCount: 1, regressionPoints: 1,
    });
    // 「趋势按回归通过率与逐评估器均分画，再跑一次即可连线」对任何只跑过一次的回归
    // 方案恒成立 ⇒ 删（prose-sweep 2026-09-03；此前钉的是「再跑一次」**在**）
    expect(r).toContain("1 次运行都成功了");
    expect(r).not.toMatch(/再跑一次|即可连线|趋势按/);
    expect(r).not.toContain("有分运行");
  });
});

describe("D-2 趋势卡空态页面渲染", () => {
  it("纯红队方案：空态点名「没有线上评估环节」，不再指路「红队攻破」", async () => {
    renderDetail("plan-rt");
    // 锚点挑**带次数**的那半句：「没有线上评估环节」立不住 —— runs 未落地时
    // 那句原因是「本方案还没有运行记录；它也没有线上评估环节…」（derive.ts:889），
    // 把它当锚点等到的是门槛数据。带 `2 次` 的这半句只有落地后才说得出。
    // 同时在 waitFor 里重查节点：这个 testid 有两个渲染方，节点可能被整个换掉。
    await waitFor(() => expect(screen.getByTestId("plan-trend-empty"))
      .toHaveTextContent("2 次运行都成功了"));
    const empty = screen.getByTestId("plan-trend-empty");
    expect(empty).toHaveTextContent("没有线上评估环节");
    // 指路句已删（见纯函数层那条）；此前钉的是「红队攻破」**在**
    expectProseGone(empty, "红队攻破", "运行历史里每次运行");
  });

  it("含 observe 却没跑出分：空态说「有线上评估环节」，不说「没有」", async () => {
    renderDetail("plan-obs");
    await waitFor(() => expect(screen.getByTestId("plan-trend-empty"))
      .toHaveTextContent("有线上评估环节"));
    const empty = screen.getByTestId("plan-trend-empty");
    expect(empty).not.toHaveTextContent("没有线上评估环节");
    // 主句（触发条件）保持原样
    expect(empty).toHaveTextContent("趋势图需要至少 2 次");
  });

  it("纯回归只跑过一次：口径 B 空态原文不动，不再追加「再跑一次即可连线」", async () => {
    renderDetail("plan-reg1");
    // ⚠️ 断言必须**在 waitFor 里重查节点**，不能捏着 findByTestId 拿到的旧句柄：
    // `plan-trend-empty` 由两个组件各渲染一份（TrendCard.tsx:182 通用那版 /
    // :306 回归那版），runs 落地前在场的是通用那版（「已有 0 次有分运行」），
    // 落地后整个节点被换掉 —— 旧句柄成了游离节点，textContent 永远不会变成
    // 期望的那句，只会等到超时（全套并跑时实测红）。
    await waitFor(() => expect(screen.getByTestId("plan-trend-empty"))
      .toHaveTextContent("已有 1 次回归运行，趋势图需要至少 2 次"));
    const empty = screen.getByTestId("plan-trend-empty");
    // 此前钉的是「再跑一次」**在**；那句与 TrendCard 的兜底句「本方案没有线上评估环节，
    // 趋势按回归通过率与逐评估器均分画」都对任何同态方案恒成立 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(empty, "再跑一次", "即可连线", "趋势按回归通过率");
    expect(empty).not.toHaveTextContent("有分运行");
  });
});
