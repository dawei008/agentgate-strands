// Agent 页测试共用夹具（从原 agents-pages.test.tsx 顶部抽出，逻辑不变）。
// fetch 直接 mock（与 tests/api.test.ts 同套路）：config.json 假 cfg，apiPath 按 action 分发。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetConfigForTest } from "../../src/lib/config";
import {
  sseFrames, AGENTS, AGENT_PLANS, AGENT_RUNS, AGENT_CONFIG, PROBE_RESULT, AUTOCONF_OUTCOMES,
  applyAgentMeta, agentStatusOf, agentTopologyOf, fleetStatus,
} from "../../src/mocks/handlers";
import { useSession } from "../../src/stores/session";

export const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

export type Payload = { action?: string } & Record<string, unknown>;

export function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** 默认 action 分发（照 MSW handlers 的假数据），单测可覆写个别 action */
export function defaultDispatch(payload: Payload): Response {
  switch (payload.action) {
    case "discover":
      return sseResponse([{
        // 与 MSW handlers / 真后端同刑：discover 每行都过显示元数据 overlay
        // （display_name / version_label 两个键恒在，见 catalog.apply_agent_meta）
        event: "agents", region: "us-west-2", agents: applyAgentMeta(AGENTS),
        // 真实后端给 epoch 秒——测试假数据保持同形态，才能盯住格式化
        from_cache: !payload.refresh, refreshed_at: 1786780500,
      }]);
    case "list_plans":
      return sseResponse([{
        event: "plans",
        plans: AGENT_PLANS.filter((p) => !payload.agent_name || p.agent_name === payload.agent_name),
      }]);
    case "list_recent_runs":
      return sseResponse([{
        event: "recent_runs",
        runs: AGENT_RUNS.filter((r) => !payload.agent_name || r.agent_name === payload.agent_name),
      }]);
    case "get_agent_config":
      return sseResponse([{ event: "agent_config", agent_name: payload.agent_name, ...AGENT_CONFIG }]);
    case "set_agent_config":
      return sseResponse([{ event: "agent_config_set", agent_name: payload.agent_name }]);
    case "set_agent_meta":
      // 回执形态照 app/main.py 的 agent_meta_set 分支（agent_name 原样回来）
      return sseResponse([{
        event: "agent_meta_set", agent_name: payload.agent_name,
        display_name: String(payload.display_name ?? ""),
        version_label: String(payload.version_label ?? ""),
        updated_at: 1787000000,
      }]);
    case "probe_agent_invoke":
      return sseResponse([
        { event: "heartbeat", phase: "probe_agent_invoke", agent: payload.agent_name },
        { ...PROBE_RESULT, agent_name: payload.agent_name },
      ]);
    case "auto_configure_agent":
      return autoconfResponse("saved", payload);
    // 首页（ADR-0016）：fleet_status 一次拿全；agent_status 逐台（详情页 ① 现状区用）
    case "fleet_status":
      return sseResponse([fleetStatus()]);
    case "agent_status": {
      const st = agentStatusOf(String(payload.agent_name ?? ""));
      return st
        ? sseResponse([{ event: "agent_status", ...st }])
        : sseResponse([{ event: "error", error: `Agent '${String(payload.agent_name)}' 不存在` }]);
    }
    // ① 现状「路径」卡（ADR-0017 D4）：与 MSW 桩同一份数据（support-bot 有图 / research-agent 未配置 span 源）
    case "agent_topology": {
      const topo = agentTopologyOf(String(payload.agent_name ?? ""), undefined, undefined,
                                   payload.include_eval == null ? null : Boolean(payload.include_eval));
      return topo
        ? sseResponse([topo])
        : sseResponse([{ event: "error", error: `Agent '${String(payload.agent_name)}' 不存在` }]);
    }
    // 首页优化行读最近一次 run 所属计划的处方：默认无历史（各用例按需覆写）
    case "list_plan_runs":
      return sseResponse([{ event: "plan_runs", plan_id: payload.plan_id, runs: [] }]);
    default:
      return sseResponse([{ event: "error", error: `未实现 ${payload.action}` }]);
  }
}

/** 自动推断五态 SSE 响应（照 MSW 假数据：heartbeat → progress × N → 终态） */
export function autoconfResponse(outcome: keyof typeof AUTOCONF_OUTCOMES, payload: Payload): Response {
  const spec = AUTOCONF_OUTCOMES[outcome];
  return sseResponse([
    { event: "heartbeat", phase: "auto_configure_agent" },
    ...spec.progress.map((p) => ({ ...p, agent_name: payload.agent_name })),
    { ...spec.final, agent_name: payload.agent_name },
  ]);
}

/** 记录所有 API 请求体；overrides 按 action 覆写响应 */
export function stubFetch(overrides: Record<string, (payload: Payload) => Response> = {}) {
  const calls: Payload[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    calls.push(payload);
    const handler = overrides[payload.action ?? ""];
    return handler ? handler(payload) : defaultDispatch(payload);
  }));
  return calls;
}

export function renderPage(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** 每个测试文件调用一次：注册与原单文件一致的 beforeEach/afterEach */
export function setupAgentsPageHooks() {
  beforeEach(() => {
    resetConfigForTest();
    useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
    location.hash = "";
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // showToast 直接挂 document.body（React 树外），逐测清掉
    document.querySelectorAll(".wb-toast").forEach((el) => el.remove());
  });
}
