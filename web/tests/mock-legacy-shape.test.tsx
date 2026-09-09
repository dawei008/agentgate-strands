// 老形态 run 夹具的**界面显影**（档 mock-legacy-shape-coverage）。
//
// scoring-legacy-score.test.ts 已经把读侧兜底（effectiveScore：顶层 score 缺就从
// observe 环节 overall_mean 现推）钉到了函数级，但那 16 条断言全用**内联夹具**：
// 全仓唯一「completed ∧ 顶层 score:null ∧ observe overall_mean 有值」的 mock 行此前
// 只存在于 BIGSCREEN_RUNS_OK/ALERT（`bsRun` 工厂恒写 score:null），而大屏走的是
// 自己那份 scoreOf ——于是 dev 界面、页面级测试与视觉基线**从来没有**跑过这条兜底：
// 修复上线了，界面上一次都没显影过。
//
// 这个文件盯的是「夹具在主路径上」这件事本身：PLAN_RUNS / AGENT_RUNS 各有一行
// 老形态 run，且它带来的位移**逐个数字**落在方案详情与工作台的 KPI 上。
// 数字与派工参数同源（.scratch/mock-legacy-calc/expect.ts 是清单方那半，
// 这里是仓内那半 —— 两边同时红才说明是真回归，只有那边红是它该跟着改期望值）。
//
// ⚠️ 断言刻意写**具体数字**而不是「比原来大/小」：后者在夹具被误删时同样成立
// （0 条老形态行 → 均分回到 0.798，差值判定照样过），那就等于没有守卫。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlanDetailPage from "../src/pages/plan/PlanDetailPage";
import WorkbenchPage from "../src/pages/workbench/WorkbenchPage";
import {
  deriveKpis, scoredRunsAsc, trendPoints, versionMarkers,
} from "../src/pages/plan/derive";
import { deriveKpi } from "../src/pages/workbench/kpi";
import { effectiveScore, isScored } from "../src/lib/scoring";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import { sseFrames, AGENT_PLANS, AGENT_RUNS, PLAN_RUNS } from "../src/mocks/handlers";
import type { PlanRunSummary } from "../src/pages/plan/types";
import type { RunRow } from "../src/pages/workbench/types";

// 这一行的身份证：run_key（同一次 run 在两个投影里是同一个 key）。
const LEGACY_KEY = "plan-aaa111#2026-08-20T07:15:00Z";
/** 派工参数：observe 环节均分。刻意不与现网真 run（0.7539）同值，也不撞任何既有夹具分值 */
const LEGACY_MEAN = 0.7412;

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action?: string } & Record<string, unknown>;

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** 桩只做一件事：把**真夹具数组**原样喂进页面（不再另造一份局部 RUNS ——
 *  本文件测的就是 handlers.ts 那两个数组自己）。 */
function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    switch (payload.action) {
      case "list_plans":
        return sseResponse([{ event: "plans", plans: AGENT_PLANS }]);
      case "list_plan_runs":
        return sseResponse([
          { event: "plan_runs", plan_id: payload.plan_id, runs: PLAN_RUNS },
        ]);
      case "list_recent_runs":
        return sseResponse([{ event: "recent_runs", runs: AGENT_RUNS }]);
      case "estimate_plan_run":
        return sseResponse([{
          event: "plan_run_estimate", plan_id: payload.plan_id,
          stages: [{ type: "observe", judge_calls: 20, estimated_cost_usd: 0.12 }],
          estimated_cost_usd: 0.42, note: "预估",
        }]);
      case "discover":
        return sseResponse([{ event: "agents", region: "us-west-2", agents: [] }]);
      default:
        return sseResponse([{ event: "error", error: `未打桩 ${payload.action}` }]);
    }
  }));
}

function renderWith(node: ReactElement): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  resetConfigForTest();
  resetRunFlightForTest();
  location.hash = "#/plan/plan-aaa111";
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const planRow = () => PLAN_RUNS.find((r) => r.run_key === LEGACY_KEY);
const agentRow = () => AGENT_RUNS.find((r) => r.run_key === LEGACY_KEY);

describe("① 夹具形态：老 run 的真形状，两个投影同一次 run", () => {
  it("PLAN_RUNS / AGENT_RUNS 各有这一行（大屏那份不算 —— 大屏不走 effectiveScore）", () => {
    expect(planRow(), "PLAN_RUNS 缺老形态行").toBeTruthy();
    expect(agentRow(), "AGENT_RUNS 缺老形态行").toBeTruthy();
  });

  it("顶层 score **键在值空**（不是缺键、不是 0）；分在 stage_summaries 的 observe 里", () => {
    for (const row of [planRow()!, agentRow()!] as unknown as Record<string, unknown>[]) {
      expect(row).toHaveProperty("score");
      expect(row.score).toBeNull();
      expect(row.status).toBe("completed");
      // 字段名是 stage_summaries（权威锚 lib/scoring.ts）——写成 stages 不报错、
      // 数字一动不动，那种「形态对、键名错」的夹具等于零显影
      expect(row).not.toHaveProperty("stages");
      const stages = row.stage_summaries as Record<string, unknown>[];
      const obs = stages.find((s) => s.type === "observe")!;
      expect(obs.status).toBe("completed");
      expect(obs.overall_mean).toBe(LEGACY_MEAN);
    }
  });

  it("同一次 run 的两个投影值完全一致（不一致就是「读写不同源」缺陷的孪生形状）", () => {
    const p = planRow() as unknown as Record<string, unknown>;
    const a = agentRow() as unknown as Record<string, unknown>;
    for (const k of ["status", "score", "started_at", "duration_s"]) {
      expect(a[k], `两投影的 ${k} 不一致`).toEqual(p[k]);
    }
    expect(a.stage_summaries).toEqual(p.stage_summaries);
  });

  it("兜底读得出分，并进得了有分样本集（键名写错时这一条先红）", () => {
    for (const row of [planRow()!, agentRow()!]) {
      expect(effectiveScore(row as never)).toBe(LEGACY_MEAN);
      expect(isScored(row as never)).toBe(true);
    }
  });

  it("时间落在硬窗口内：> 8/11（现有最新有分 run）且 < 8/22（顶层 score 补写日）", () => {
    const t = Date.parse("2026-08-20T07:15:00Z");
    expect(Date.parse((planRow() as { started_at: string }).started_at.replace(" UTC", "Z")
      .replace(" ", "T"))).toBe(t);
    expect(t).toBeGreaterThan(Date.parse("2026-08-11T09:00:00Z"));
    expect(t).toBeLessThan(Date.parse("2026-08-22T00:00:00Z"));
  });

  it("两条「完成 · 无可评估数据」中性文案夹具（07-20 / 08-05）一字未动、仍是两条", () => {
    const nodata = (PLAN_RUNS as unknown as PlanRunSummary[]).filter(
      (r) => r.status === "completed" && r.score === null && effectiveScore(r) === null);
    expect(nodata.map((r) => r.run_key).sort()).toEqual([
      "plan-aaa111#2026-08-05T03:00:00Z",
      "plan-aaa111#2026-07-20T03:00:00Z",
    ].sort());
  });
});

describe("② 推导层：老形态行进均分 / 趋势 / 样本数", () => {
  const runs = PLAN_RUNS as unknown as PlanRunSummary[];

  it("方案 KPI：均分 0.78853…、环比 −0.1188（由涨转跌）、成功 7/11", () => {
    const k = deriveKpis(runs);
    expect(k.avgScore).toBeCloseTo(0.7885333333333332, 12);
    expect(k.delta).toBeCloseTo(-0.1188, 12);
    expect(k.successCount).toBe(7);
    expect(k.totalCount).toBe(11);
  });

  it("趋势 6 个点，末点是老形态那一行（分值来自兜底，不是 0、不是 NaN）", () => {
    const pts = trendPoints(runs);
    expect(pts).toHaveLength(6);
    expect(pts[pts.length - 1]).toEqual({
      t: Date.parse("2026-08-20T07:15:00Z"), label: "08-20 07:15", score: LEGACY_MEAN,
    });
  });

  it("版本竖线**不许多一根**：这一行的 v1.2 与 08-11 同值，只改分数口径一个变量", () => {
    expect(versionMarkers(scoredRunsAsc(runs))).toHaveLength(2);
  });

  // 批 plans-board 起工作台 hero 不再算均分（ADR-0016）；「老形态 run 进均分样本」
  // 这条硬线改在 lib/scoring 的判定/取值二元组上直接钉（isScored + effectiveScore
  // 同源），口径与此前 deriveKpi.avgScore 完全相同：completed 且有 observe 分。
  function meanScored(rows: RunRow[]): { avg: number | null; n: number } {
    const scored = rows.filter(isScored);
    return {
      avg: scored.length
        ? scored.reduce((s, r) => s + (effectiveScore(r) as number), 0) / scored.length : null,
      n: scored.length,
    };
  }

  it("list_recent_runs 全量：均分 0.8178、样本 4（老形态那一行在内）；工作台 runs24h 不动", () => {
    const rows = AGENT_RUNS as unknown as RunRow[];
    const m = meanScored(rows);
    expect(m.avg).toBeCloseTo(0.8178, 12);
    expect(m.n).toBe(4);
    expect(deriveKpi(rows, []).runs24h).toBe(5);
  });

  it("按 agent 过滤（Agent 详情的 list_recent_runs 口径）后同样是 0.8178 / 4", () => {
    const rows = (AGENT_RUNS as unknown as RunRow[]).filter(
      (r) => r.agent_name === "support-bot");
    const m = meanScored(rows);
    expect(m.avg).toBeCloseTo(0.8178, 12);
    expect(m.n).toBe(4);
  });
});

describe("③ 界面显影：数字真的印在页面上", () => {
  it("方案详情：hero 0.79 + 环比 -0.12（neg）、成功运行 7/11、趋势「6 次有分运行」", async () => {
    renderWith(<PlanDetailPage id="plan-aaa111" />);
    // 锚点挑目标数据专属的那一格（不是随便一个门槛元素）：hero 数字位
    await waitFor(() => expect(screen.getByTestId("plan-kpi-avg")).toHaveTextContent("0.79"));
    const delta = screen.getByTestId("plan-kpi-delta");
    expect(delta).toHaveTextContent("-0.12");
    expect(delta).toHaveClass("neg");        // 由涨（+0.07）转跌 —— 预期显影，不是回归
    expect(screen.getByTestId("plan-kpi-success")).toHaveTextContent("7/11");
    expect(screen.getByTestId("plan-trend-card")).toHaveTextContent("最近 6 次有分运行");
    expect(screen.getByTestId("trend-stat-delta")).toHaveTextContent("−0.12");
    expect(screen.getByTestId("trend-stat-delta")).toHaveClass("neg");
  });

  it("方案详情运行历史：老形态那一行 badge 是「完成」并挂着兜底出来的 0.74", async () => {
    renderWith(<PlanDetailPage id="plan-aaa111" />);
    const badge = await screen.findByTestId(`plan-run-row-${LEGACY_KEY}-badge`);
    expect(badge).toHaveTextContent("完成");
    expect(badge).toHaveTextContent("0.74");
    // 中性文案是「一个有效结果都没有」那两行的专属，这一行有分，不许套上去
    expect(badge).not.toHaveTextContent("无可评估数据");
  });

  it("工作台：运行表里老形态那一行 badge「完成」、分数格显兜底出来的 0.74（hero 已改下次运行）", async () => {
    location.hash = "#/workbench";
    renderWith(<WorkbenchPage />);
    const table = await screen.findByTestId("runs-table");
    const row = within(table).getByTestId(`run-row-${LEGACY_KEY}`);
    expect(within(row).getByTestId(`run-row-${LEGACY_KEY}-badge`)).toHaveTextContent("完成");
    expect(row).toHaveTextContent("0.74");
  });
});
