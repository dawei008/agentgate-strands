// 方案详情页的版本快照：趋势图版本变更竖线 + run 行/报告抽屉头的版本 chip。
//
// **护栏 1（快照冻结）的前端一侧**：显示的版本一律来自 run 自己的快照
// （`agent_version_label`，后端 planrun._planrun_item 在落库那一刻冻进去的），
// **不读 Agent 当前值** —— 事后改标签不许改动历史 run 的归属与竖线位置。
// 老 run 没有这个字段（旧数据不修）→ 不画 chip、不画竖线，绝不显示一个空 chip。
//
// ⚠️ jsdom 下 ResponsiveContainer 量到 0×0，Recharts 不渲染 svg 内部
// （plan.test.tsx:593 的既有说明），所以图内的 ReferenceLine 只能在视觉基线里验；
// 这里断言的是 ①推导函数 versionMarkers ②图下方那行「版本变更」说明（同一份
// markers 渲染，屏幕上可读、可悬停）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PlanDetailPage from "../src/pages/plan/PlanDetailPage";
// 旧报告页壳（渲染共享视图 ReportView，抽屉正文）：独立页已换成变体 A，见 tests/legacyReportPage.tsx
import ReportPage from "./legacyReportPage";
import { versionMarkers, scoredRunsAsc } from "../src/pages/plan/derive";
import type { PlanRunSummary } from "../src/pages/plan/types";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import { sseFrames } from "../src/mocks/handlers";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;

let calls: Payload[] = [];
let overrides: Record<string, (p: Payload) => unknown[]> = {};

const PLAN = {
  plan_id: "plan-aaa111", name: "FAQ 周回归", agent_name: "support-bot",
  updated_at: 1755500000,
  stages: [{ type: "observe", evaluators: ["helpfulness"] }],
  schedule: null,
};

const OBS = (mean: number) => [
  { type: "observe", status: "completed", overall_mean: mean, sessions: 10, summary: {} },
];

/** 四条 run：两条带快照（v1.2 → v1.3）、两条老 run（无快照，降级路径）。
 *  字段名逐字照后端 planrun._run_from_item（agent_version_label /
 *  agent_runtime_arn；老 run 读出来是 null，不是 undefined）。 */
const RUNS: PlanRunSummary[] = [
  {
    run_key: "rk-4", status: "completed", score: 0.9,
    started_at: "2026-08-24 09:00", duration_s: 70, triggered_by: "manual",
    stage_summaries: OBS(0.9),
    agent_version_label: "v1.3",
    agent_runtime_arn: "arn:aws:bedrock-agentcore:us-west-2:1:runtime/support-bot-def456",
  },
  {
    run_key: "rk-3", status: "completed", score: 0.82,
    started_at: "2026-08-17 09:00", duration_s: 72, triggered_by: "schedule",
    stage_summaries: OBS(0.82),
    agent_version_label: "v1.2",
    agent_runtime_arn: "arn:aws:bedrock-agentcore:us-west-2:1:runtime/support-bot-abc123",
  },
  {
    run_key: "rk-2", status: "completed", score: 0.78,
    started_at: "2026-08-10 09:00", duration_s: 74, triggered_by: "schedule",
    stage_summaries: OBS(0.78),
    agent_version_label: null, agent_runtime_arn: null,
  },
  {
    run_key: "rk-1", status: "completed", score: 0.74,
    started_at: "2026-08-03 09:00", duration_s: 68, triggered_by: "schedule",
    stage_summaries: OBS(0.74),
    agent_version_label: null, agent_runtime_arn: null,
  },
];

const RUN_DETAIL = {
  event: "plan_run", plan_id: "plan-aaa111", plan_name: "FAQ 周回归",
  agent_name: "support-bot", status: "completed", score: 0.9,
  started_at: "2026-08-24 09:00", duration_s: 70, triggered_by: "manual",
  total_cost_usd: 0.31, overview: {},
  stages: [{ type: "observe", status: "completed", overall_mean: 0.9, sessions: 10 }],
  // 抽屉头的版本来源：真后端 get_plan_run 也带快照字段，但**老 run 没有** ——
  // 这个桩故意不带，逼消费方退到 run 摘要那一份（两条通路都得对）。
  plan_synthesis: null, synthesis_sections: [], synthesis_error: null,
};

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [PLAN] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: RUNS }],
  estimate_plan_run: (p) => [{
    event: "plan_run_estimate", plan_id: p.plan_id, stages: [],
    estimated_cost_usd: 0.42, note: "",
  }],
  get_plan_run: (p) => [{ ...RUN_DETAIL, run_key: p.run_key }],
  list_datasets: () => [{ event: "datasets", datasets: [] }],
  // Agent 的**当前**标签（v9.9）刻意与所有 run 快照都不同：任何一处把它显示出来
  // 就是读错了源（护栏 1）
  discover: () => [{
    event: "agents", region: "us-west-2", from_cache: true,
    agents: [{ agent_name: "support-bot", runtime_arn: "arn:a",
               display_name: "客服机器人", version_label: "v9.9" }],
  }],
};

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}

beforeEach(() => {
  calls = [];
  overrides = {};
  resetConfigForTest();
  location.hash = "#/plan/plan-aaa111";
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    calls.push(payload);
    const handler = overrides[payload.action] ?? DEFAULTS[payload.action];
    if (!handler) return sseResponse([{ event: "error", error: `未打桩 '${payload.action}'` }]);
    return sseResponse(handler(payload));
  }));
  resetRunFlightForTest();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderDetail() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}><PlanDetailPage id="plan-aaa111" /></QueryClientProvider>,
  );
}

/** 报告的生产入口是独立页 `#/report/<run_key>`。裸 run_key（"rk-3"）切不出方案，
 *  但版本 chip 只吃 run 详情 + run 摘要这两样，跟方案定义无关。 */
function renderReport(runKey: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}><ReportPage id={runKey} /></QueryClientProvider>,
  );
}

// ==================== 推导：版本变更竖线 ====================
describe("versionMarkers 版本变更竖线", () => {
  const asc = () => scoredRunsAsc(RUNS);

  it("按相邻 run 快照的差异画：v1.2 起一条、v1.3 起一条", () => {
    const marks = versionMarkers(asc());
    expect(marks.map((m) => m.label)).toEqual(["v1.2", "v1.3"]);
    // at = X 轴 label（与趋势点同一个格式化，否则竖线落不到轴上）
    expect(marks.map((m) => m.at)).toEqual(["08-17 09:00", "08-24 09:00"]);
    // prev 说得出「从什么换到什么」：第一条之前是老 run（无快照）
    expect(marks[0].prev).toBe("");
    expect(marks[1].prev).toBe("v1.2");
  });

  it("第一个点不画竖线：那里没有「相邻的上一次」可比", () => {
    const one = versionMarkers([
      { ...RUNS[3], agent_version_label: "v1.0" },
      { ...RUNS[2], agent_version_label: "v1.0" },
    ] as PlanRunSummary[]);
    expect(one).toEqual([]);
  });

  it("标签没变就没有竖线（同一版跑十次也只有数据点）", () => {
    const same = asc().map((r) => ({ ...r, agent_version_label: "v1.2" }));
    expect(versionMarkers(same)).toEqual([]);
  });

  it("老 run 缺快照不算版本变更（中间夹一条老 run 不许画成换版本）", () => {
    const withHole: PlanRunSummary[] = [
      { ...RUNS[3], agent_version_label: "v1.2" },
      { ...RUNS[2], agent_version_label: null },
      { ...RUNS[1], agent_version_label: "v1.2" },
    ];
    expect(versionMarkers(withHole)).toEqual([]);
  });

  it("全是老 run：一条竖线都没有（旧数据不修的降级路径）", () => {
    expect(versionMarkers([RUNS[3], RUNS[2]] as PlanRunSummary[])).toEqual([]);
  });

  it("空白标签等于没标注", () => {
    const blank: PlanRunSummary[] = [
      { ...RUNS[3], agent_version_label: "v1.2" },
      { ...RUNS[2], agent_version_label: "   " },
    ];
    expect(versionMarkers(blank)).toEqual([]);
  });

  it("scoredRunsAsc 与趋势取样同一批：只要有分 run，按时间升序", () => {
    expect(scoredRunsAsc(RUNS).map((r) => r.run_key))
      .toEqual(["rk-1", "rk-2", "rk-3", "rk-4"]);
  });
});

// ==================== 页面：run 行版本 chip ====================
describe("运行历史的版本 chip", () => {
  it("有快照的行显示快照标签，没快照的行不画 chip", async () => {
    renderDetail();
    expect(await screen.findByTestId("plan-run-row-rk-4-version")).toHaveTextContent("v1.3");
    expect(screen.getByTestId("plan-run-row-rk-3-version")).toHaveTextContent("v1.2");
    expect(screen.queryByTestId("plan-run-row-rk-2-version")).toBeNull();
    expect(screen.queryByTestId("plan-run-row-rk-1-version")).toBeNull();
  });

  it("护栏 1：显示的是 run 快照，不是 Agent 当前标签（当前是 v9.9）", async () => {
    renderDetail();
    const row = await screen.findByTestId("plan-run-row-rk-3");
    expect(row).toHaveTextContent("v1.2");
    expect(row).not.toHaveTextContent("v9.9");
    expect(screen.getByTestId("plan-runs-table")).not.toHaveTextContent("v9.9");
  });

  it("chip 是实心 badge（玻璃拟态纪律：chip/badge 实心底）", async () => {
    renderDetail();
    const chip = await screen.findByTestId("plan-run-row-rk-4-version");
    expect(chip).toHaveClass("badge");
    // 删句双钉（2026-08-30 无废话终裁：版面无 + title 无）：原 title「本次运行时
    // 的版本标签（运行时快照）」对任何 run 一字不差成立 = 使用文档，连 title 都
    // 不留（16 处之代表：title 一处钉在这里）。
    expect(chip.getAttribute("title")).toBeNull();
    expect(document.querySelector('[title*="运行时快照"]')).toBeNull();
  });
});

// ==================== 页面：趋势卡的版本变更行 ====================
describe("趋势卡的版本变更说明", () => {
  it("每条竖线一项，标签 + 时间；悬停说得出从哪一版换到哪一版", async () => {
    renderDetail();
    const wrap = await screen.findByTestId("plan-trend-versions");
    const v13 = within(wrap).getByTestId("plan-trend-version-v1.3");
    expect(v13).toHaveTextContent("v1.3");
    expect(v13).toHaveTextContent("08-24 09:00");
    expect(v13.getAttribute("title")).toContain("v1.2");
    expect(v13.getAttribute("title")).toContain("v1.3");
  });

  it("护栏 1：竖线只认 run 快照，Agent 当前标签 v9.9 不出现在趋势卡里", async () => {
    renderDetail();
    await screen.findByTestId("plan-trend-versions");
    expect(screen.getByTestId("plan-trend-card")).not.toHaveTextContent("v9.9");
  });

  it("没有任何版本变更时整行不画（不留一个空的「版本变更：」）", async () => {
    overrides = {
      list_plan_runs: (p) => [{
        event: "plan_runs", plan_id: p.plan_id,
        runs: RUNS.map((r) => ({ ...r, agent_version_label: null })),
      }],
    };
    renderDetail();
    await screen.findByTestId("plan-trend-chart");
    expect(screen.queryByTestId("plan-trend-versions")).toBeNull();
  });
});

// ==================== 报告头 ====================
describe("报告头的版本 chip", () => {
  it("显示这一次运行的版本（get_plan_run 没带就退到 run 摘要的快照）", async () => {
    renderReport("rk-3");
    const chip = await screen.findByTestId("report-drawer-version");
    expect(chip).toHaveTextContent("v1.2");
    expect(screen.getByTestId("report-drawer-head")).not.toHaveTextContent("v9.9");
  });

  it("老 run 的报告头不画版本 chip", async () => {
    renderReport("rk-2");
    await screen.findByTestId("report-drawer-head");
    // 锚点挑这一条专属：等报告体真到齐（加载态退场）再断言「没有」——
    // 否则 chip 还没渲染就先读到 null，两种成因同形。
    await waitFor(() =>
      expect(screen.queryByTestId("report-drawer-loading")).not.toBeInTheDocument());
    expect(screen.queryByTestId("report-drawer-version")).toBeNull();
  });
});
