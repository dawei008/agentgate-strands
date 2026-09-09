// 成本显示口径（现网 P1 2026-09-08：无价 / 部分成本被印成 $0.00）——四个成本位各钉三态：
//   真 0 印 $0.00 / 部分印数字 + 「部分」+ title 未定价名单 / 全缺（旧 run）0 印「—」。
// 反向钉：agent_usd=null 与 agent_usd=0 同一组数字**不许同形**（null 不是 0）。
// 四处都只调 lib/cost.fmtCost（单元三态见 lib-cost.test.ts）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import ReportPage from "../src/pages/report/ReportPage";
import StatusPanel from "../src/pages/agents/detail/hub/StatusPanel";
import AgentCard from "../src/pages/agents/home/AgentCard";
import { RunStrip } from "../src/pages/compare/SessionPanels";
import { attributesOfMetrics, fmtAttr } from "../src/pages/compare/pairsDerive";
import {
  MOCK_PLAN_RUN, MOCK_PLAN_RUN_OBSERVE, MOCK_PLAN_RUN_TRACE, OBSERVE_PLAN_RUNS, OBSERVE_RUN_KEY,
  PLAN_RUNS, TRACE_RUN_KEY, agentStatusOf, sseFrames,
} from "../src/mocks/handlers";
import type { AgentStatus } from "../src/pages/agents/home/types";
import type { AgentItem } from "../src/pages/agents/types";
import type { SessionSide } from "../src/lib/apiTypes";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

function sse(events: unknown[]): Response {
  return new Response(sseFrames(events), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const RUN_BY_KEY: Record<string, unknown> = {
  [OBSERVE_RUN_KEY]: MOCK_PLAN_RUN_OBSERVE,
  [TRACE_RUN_KEY]: MOCK_PLAN_RUN_TRACE,
};

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [] }],
  list_plan_runs: (p) => [{
    event: "plan_runs", plan_id: p.plan_id,
    runs: p.plan_id === "plan-ddd666" ? OBSERVE_PLAN_RUNS : PLAN_RUNS,
  }],
  get_plan_run: (p) => [{ event: "plan_run", ...(RUN_BY_KEY[String(p.run_key)] ?? MOCK_PLAN_RUN), run_key: p.run_key }],
  list_datasets: () => [{ event: "datasets", datasets: [] }],
  list_annotations: (p) => [{ event: "annotations", run_key: p.run_key, items: [] }],
  estimate_plan_run: (p) => [{ event: "plan_run_estimate", plan_id: p.plan_id, stages: [], estimated_cost_usd: 2.0 }],
};

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    const handler = overrides[payload.action] ?? DEFAULTS[payload.action];
    if (!handler) return sse([{ event: "error", error: `未打桩 action '${payload.action}'` }]);
    return sse(handler(payload));
  }));
}

function renderQ(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
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

// ---- 夹具现算 ----
const TRACE_DS = MOCK_PLAN_RUN_TRACE.report.stages[0] as { report: Record<string, unknown> };
const TRACE_BD = TRACE_DS.report.cost_breakdown as { judge_usd: number; agent_usd: null; unpriced: string[] };
const DSH_MODEL = MOCK_PLAN_RUN_OBSERVE.report.stages[0].metrics.cost.unpriced_models[0];
const RUN_0811_DS = MOCK_PLAN_RUN.report.stages.find((s) => s.type === "dataset") as { report: Record<string, unknown> };

async function openReport(runKey: string) {
  location.hash = `#/report/${encodeURIComponent(runKey)}`;
  renderQ(<ReportPage id={runKey} />);
  return await screen.findByTestId("report-hero-cost");
}

describe("① 报告页 hero 成本格", () => {
  it("夹具前提：TRACE 桩的回归子 run 是「部分」形态（agent_usd null、cost_is_partial true、unpriced 点名）", () => {
    expect(TRACE_DS.report.cost_is_partial).toBe(true);
    expect(TRACE_BD.agent_usd).toBeNull();
    expect(TRACE_BD.unpriced).toEqual(["support-bot"]);
    // 0811 桩是「完整」形态；红队子 run 照 redteam.py 不带这两个键
    expect(RUN_0811_DS.report.cost_is_partial).toBe(false);
    const rt = MOCK_PLAN_RUN.report.stages.find((s) => s.type === "redteam") as { report: Record<string, unknown> };
    expect("cost_breakdown" in rt.report).toBe(false);
  });

  it("部分：total 0.20 里被测 Agent 无价 ⇒ $0.20 + 「部分」，title = 未定价：support-bot", async () => {
    const cell = await openReport(TRACE_RUN_KEY);
    expect(cell).toHaveTextContent(`$${MOCK_PLAN_RUN_TRACE.total_cost_usd.toFixed(2)}`);
    const badge = within(cell).getByTestId("report-hero-cost-badge");
    expect(badge).toHaveTextContent("部分");
    expect(badge.className).toBe("badge");
    expect(badge).toHaveAttribute("title", "未定价：support-bot");
    expect(cell.querySelector(".kpi-val")).toHaveAttribute("title", "未定价：support-bot");
    expect(cell).not.toHaveTextContent("$0.00");
  });

  it("反向钉：同一组数字把 agent_usd 从 null 改成 0（且 cost_is_partial=false）⇒ 数字相同但**不再**标「部分」", async () => {
    overrides.get_plan_run = (p) => [{
      event: "plan_run", ...MOCK_PLAN_RUN_TRACE, run_key: p.run_key,
      report: {
        ...MOCK_PLAN_RUN_TRACE.report,
        stages: MOCK_PLAN_RUN_TRACE.report.stages.map((s, i) => i !== 0 ? s : {
          ...s, report: { ...TRACE_DS.report, cost_is_partial: false, unpriced_agents: [],
            cost_breakdown: { ...TRACE_BD, agent_usd: 0, unpriced: [] } },
        }),
      },
    }];
    const cell = await openReport(TRACE_RUN_KEY);
    expect(cell).toHaveTextContent("$0.20");
    expect(within(cell).queryByTestId("report-hero-cost-badge")).toBeNull();
    expect(cell.querySelector(".kpi-val")).not.toHaveAttribute("title");
    // 把 null 当 0 加出来的总额与部分态的数字同为 0.20 —— 区分只能靠标记，所以标记是必需的
    expect(`$${(TRACE_BD.judge_usd + Number(null) + 0.12).toFixed(2)}`).toBe("$0.20");
  });

  it("无价（观测环节模型未定价、total 0）⇒ 「—」+「部分」，title 列模型名，副行仍是既有文案", async () => {
    const cell = await openReport(OBSERVE_RUN_KEY);
    expect(cell.querySelector(".kpi-val")).toHaveTextContent(/^—/);
    expect(within(cell).getByTestId("report-hero-cost-badge")).toHaveAttribute("title", `未定价：${DSH_MODEL}`);
    expect(screen.getByTestId("report-hero-cost-sub")).toHaveTextContent("模型未定价");
    expect(cell).not.toHaveTextContent("$0.00");
  });

  it("完整非 0（0811 桩）⇒ $0.31，不标", async () => {
    const cell = await openReport(MOCK_PLAN_RUN.run_key);
    expect(cell).toHaveTextContent("$0.31");
    expect(within(cell).queryByTestId("report-hero-cost-badge")).toBeNull();
  });

  it("真 0：纯回归 run、total 0、cost_is_partial=false 且 agent_usd 是数 ⇒ $0.00", async () => {
    const ds = { ...RUN_0811_DS, actual_cost_usd: 0,
      report: { ...RUN_0811_DS.report, actual_cost_usd: 0, cost_breakdown: { judge_usd: 0, agent_usd: 0, unpriced: [] }, cost_is_partial: false } };
    overrides.get_plan_run = (p) => [{
      event: "plan_run", ...MOCK_PLAN_RUN, run_key: p.run_key, total_cost_usd: 0,
      stage_summaries: MOCK_PLAN_RUN.stage_summaries.filter((s) => s.type === "dataset"),
      report: { ...MOCK_PLAN_RUN.report, stages: [ds] },
    }];
    const cell = await openReport(MOCK_PLAN_RUN.run_key);
    expect(cell).toHaveTextContent("$0.00");
    expect(within(cell).queryByTestId("report-hero-cost-badge")).toBeNull();
  });

  it("全缺：旧 run 没有 cost_breakdown / cost_is_partial，total 0 ⇒ 「—」不标（0 分不出真 0 还是算不出）", async () => {
    const { cost_breakdown: _b, cost_is_partial: _p, ...bare } = RUN_0811_DS.report;
    void _b; void _p;
    overrides.get_plan_run = (p) => [{
      event: "plan_run", ...MOCK_PLAN_RUN, run_key: p.run_key, total_cost_usd: 0,
      report: { ...MOCK_PLAN_RUN.report,
        stages: MOCK_PLAN_RUN.report.stages.map((s) => s.type === "dataset" ? { ...s, report: bare } : s) },
    }];
    const cell = await openReport(MOCK_PLAN_RUN.run_key);
    expect(cell.querySelector(".kpi-val")).toHaveTextContent(/^—$/);
    expect(within(cell).queryByTestId("report-hero-cost-badge")).toBeNull();
    expect(screen.getByTestId("report-hero-cost-sub")).not.toHaveTextContent("模型未定价");
    expect(cell).not.toHaveTextContent("$0.00");
  });
});

// ---- Agent 详情 ① 现状 ----
const BASE = agentStatusOf("support-bot") as unknown as AgentStatus;
function withCost(value: number | null, reason?: string): AgentStatus {
  return {
    ...BASE,
    metrics: { ...BASE.metrics, agent_cost_usd: { value, prev: value, delta: value == null ? null : 0 } },
    unavailable_reason: { ...BASE.unavailable_reason, ...(reason ? { "metrics.agent_cost_usd": reason } : {}) },
  };
}
const UNPRICED_REASON = "未定价模型：us.anthropic.claude-sonnet-4-5（可在单价配置里补价）";

describe("② Agent 详情 ① 现状「Agent 侧成本」格 + 下次运行预估", () => {
  const cellText = () => screen.getByTestId("agent-obs-cost").querySelector(".kpi-v") as HTMLElement;

  it("有价 ⇒ $41.60（agent_status 非 null 即完整：未定价时后端给 null 不给数）", async () => {
    renderQ(<StatusPanel name="support-bot" status={withCost(41.6)} loading={false} error={null} planRuns={[]} />);
    expect(cellText()).toHaveTextContent("$41.60");
  });

  it("真 0 ⇒ $0.00", async () => {
    renderQ(<StatusPanel name="support-bot" status={withCost(0)} loading={false} error={null} planRuns={[]} />);
    expect(cellText()).toHaveTextContent("$0.00");
  });

  it("无价 ⇒ 「—」，原因（未定价模型：…）在 title", async () => {
    renderQ(<StatusPanel name="support-bot" status={withCost(null, UNPRICED_REASON)} loading={false} error={null} planRuns={[]} />);
    expect(cellText()).toHaveTextContent("—");
    expect(cellText()).toHaveAttribute("title", UNPRICED_REASON);
    expect(cellText()).not.toHaveTextContent("$0.00");
  });

  it("下次运行预估：stages[i].cost_is_partial=true + unpriced_agents ⇒ $0.26 + 「部分」+ title", async () => {
    overrides.estimate_plan_run = (p) => [{
      event: "plan_run_estimate", plan_id: p.plan_id, estimated_cost_usd: 0.2625,
      stages: [{ type: "dataset", cases: 5, estimated_cost_usd: 0.2625, cost_is_partial: true, unpriced_agents: ["support-bot"] }],
    }];
    renderQ(<StatusPanel name="support-bot" status={BASE} loading={false} error={null} planRuns={[]} />);
    const cost = screen.getByTestId("agent-next-run-cost");
    await waitFor(() => expect(cost).toHaveTextContent("$0.26"));
    expect(within(cost).getByTestId("agent-next-run-cost-badge")).toHaveTextContent("部分");
    expect(within(cost).getByTestId("agent-next-run-cost-badge")).toHaveAttribute("title", "未定价：support-bot");
    expect(cost).toHaveTextContent("预估");
  });

  it("下次运行预估：无未定价 ⇒ $2.00 不标", async () => {
    renderQ(<StatusPanel name="support-bot" status={BASE} loading={false} error={null} planRuns={[]} />);
    const cost = screen.getByTestId("agent-next-run-cost");
    await waitFor(() => expect(cost).toHaveTextContent("$2.00"));
    expect(within(cost).queryByTestId("agent-next-run-cost-badge")).toBeNull();
  });
});

// ---- 首页 Agent 卡 ----
const AGENT: AgentItem = { agent_name: "support-bot", runtime_arn: "arn:aws:bedrock-agentcore:us-west-2:1:runtime/support-bot-abc123", has_logs: true };
function card(status: AgentStatus) {
  return renderQ(
    <AgentCard agent={AGENT} status={status} statusLoading={false} statusError={null} severity="none"
      runningRow={undefined} lastRow={undefined} proposals={undefined} optimizeHref={null} hot={false} />,
  );
}

describe("③ 首页 Agent 卡成本格", () => {
  it("有价 ⇒ $41.60", () => {
    card(withCost(41.6));
    expect(screen.getByTestId("agent-card-support-bot-cost")).toHaveTextContent("$41.60");
  });
  it("真 0 ⇒ $0.00", () => {
    card(withCost(0));
    expect(screen.getByTestId("agent-card-support-bot-cost")).toHaveTextContent("$0.00");
  });
  it("无价（值 null）⇒ 「—」，不是 $0.00", () => {
    card(withCost(null, UNPRICED_REASON));
    const cell = screen.getByTestId("agent-card-support-bot-cost");
    expect(cell.querySelector(".obs-v")).toHaveTextContent(/^—$/);
    expect(cell).not.toHaveTextContent("$0.00");
  });
});

// ---- 评估分析 · 会话对比 ----
function side(cost: number | null): SessionSide {
  return {
    run_key: "plan-aaa111#2026-08-11T09:00:00Z", row_key: "sess-1", stage_type: "observe", started_at: "2026-08-11 09:00 UTC",
    run_index: 3, events: [], results: {},
    attributes: { model: "m", "tokens.input": 10, "tokens.output": 5, llm_calls: 1, tool_calls: 0, "latency.avg_s": 1.5, "cost.usd": cost, system_prompt: null },
  };
}

describe("④ 会话对比 run 元信息条 / 属性格成本", () => {
  it("有价 ⇒ 四位小数 $0.0240", () => {
    renderQ(<RunStrip side={side(0.024)} which="a" testid="strip" />);
    expect(screen.getByTestId("strip")).toHaveTextContent("成本 $0.0240");
    expect(fmtAttr("cost.usd", 0.024)).toBe("$0.0240");
  });
  it("0 且部分与否不可判（session_compare 属性不带未定价名单）⇒ 「—」，绝不 $0.0000", () => {
    renderQ(<RunStrip side={side(0)} which="a" testid="strip" />);
    expect(screen.getByTestId("strip")).toHaveTextContent("成本 —");
    expect(screen.getByTestId("strip")).not.toHaveTextContent("$0.0000");
    expect(fmtAttr("cost.usd", 0)).toBeNull();
  });
  it("缺（null）⇒ 「—」", () => {
    renderQ(<RunStrip side={side(null)} which="b" testid="strip" />);
    expect(screen.getByTestId("strip")).toHaveTextContent("成本 —");
    expect(fmtAttr("cost.usd", null)).toBeNull();
  });
  it("归档路径：metrics.cost.usd 0 + unpriced_models（模型无价按 0 累加）⇒ 属性格空，不印 $0.0000", () => {
    const a = attributesOfMetrics({ cost: { usd: 0, by_model: {}, unpriced_models: [DSH_MODEL] }, tokens: { input: 3, output: 2 } }, null);
    expect(a["cost.usd"]).toBe(0);
    expect(fmtAttr("cost.usd", a["cost.usd"])).toBeNull();
  });
});
