// 四个 Tab 的面板在**数据未到时 DOM 非空**（批 simp-B2 第 5 项）。
//
// 为什么成机制：上周只修了 ① 的路径卡（hub-cold-open-gating：`if (!status) return null`
// 把整行路径卡吞掉，现网 agent_status 冷调 8.9s），③ 优化面板同一形态原样留着 ——
// `if (!poolReady …) return null`（OptimizePanel.tsx:112），深链冷开
// `#/agent/<name>/optimize` 在 list_recent_runs 那几秒里是一片空白，读成「这个 Tab 没内容」。
// 现在四个面板都不许在数据未到时给空 DOM；③ 照 ① 那套：骨架 + 一行具体的「在等什么」
// （带这一次的数：最近 20 次运行 / 那个 plan_id 与 run_key），不写恒成立的通用散文。
//
// 手法：所有 action 的响应都是**挂着的** SSE（body 是永不关闭的 ReadableStream，
// = 现网冷调那几秒），于是每条 useQuery 都停在 isLoading。四个面板都挂载（非当前的
// hidden），一次渲染就能同时量四个。锚点挑各面板自己的 panelId，不拿别人的数据当门槛。
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { agentStatusOf } from "../../src/mocks/handlers";
import AgentDetailPage from "../../src/pages/agents/AgentDetailPage";
import { AGENT_TABS } from "../../src/pages/agents/detail/hub/tabs";
import { RUNS_LIMIT } from "../../src/pages/agents/detail/RunsBlock";
import { renderPage, setupAgentsPageHooks, sseResponse, stubFetch, type Payload } from "./harness";

setupAgentsPageHooks();

/** 一直挂着的 200 响应：fetch 已返回，流不给数据也不关 ⇒ 那条 useQuery 停在 isLoading */
function hang(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}
/** 除了点名的几个 action，其余全挂着（Proxy：stubFetch 按 action 取 handler）。
 *  ⚠️ 不许写 `{ ...HANG_ALL, x: … }` —— 展开 Proxy 走 ownKeys，空 target 展开出 `{}`，
 *  兜底 hang 会静默消失（那些 action 会落到 defaultDispatch 的真桩上，测的就不是「未到态」了）。 */
const hangExcept = (over: Record<string, (p: Payload) => Response> = {}) =>
  new Proxy(over, { get: (t, k: string) => t[k] ?? hang });
const HANG_ALL = hangExcept();

const STATUS = agentStatusOf("support-bot") as unknown as Record<string, unknown>;
const LAST_KEY = "plan-ddd444#2026-08-21T05:00:00Z";

describe("四个 Tab：数据未到时面板 DOM 非空", () => {
  it("①②③④ 首帧都有内容（不 await：await 会把「几秒后才出现」也算过）", () => {
    stubFetch(HANG_ALL);
    renderPage(<AgentDetailPage name="support-bot" />);
    for (const t of AGENT_TABS) {
      const panel = screen.getByTestId(`agent-tab-panel-${t}`);
      expect(panel.childElementCount, `${t} 面板的子节点数`).toBeGreaterThan(0);
      // 只有骨架条也不算过：面板里必须有话（骨架条自己 aria-hidden，读屏读不到）
      expect(panel.textContent?.trim(), `${t} 面板的文字`).not.toBe("");
    }
    // ① 与 ③ 各自的骨架锚点（②④ 是既有的「加载中…」一行，不在本批射程）
    expect(screen.getByTestId("agent-status-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("agent-topology")).toBeInTheDocument();
    expect(screen.getByTestId("agent-optimize")).toBeInTheDocument();
    expect(screen.getByTestId("agent-optimize-skeleton")).toBeInTheDocument();
  });

  it("③ 在等 list_recent_runs：一行说清等的是哪份数据（最近 20 次运行），且读屏能读到", () => {
    stubFetch(HANG_ALL);
    renderPage(<AgentDetailPage name="support-bot" tab="optimize" />);
    const panel = screen.getByTestId("agent-tab-panel-optimize");
    const pending = within(panel).getByTestId("agent-optimize-pending");
    expect(pending).toHaveTextContent(`正在取这个 Agent 最近 ${RUNS_LIMIT} 次运行`);
    expect(RUNS_LIMIT).toBe(20);
    // 骨架条是装饰，文案行不是
    expect(within(panel).getByTestId("agent-optimize-skeleton").getAttribute("aria-hidden")).toBeNull();
    expect(pending.closest("[aria-hidden='true']")).toBeNull();
    // 这一刻还没有口径行 / 空态文案（骨架不是把结论提前写出来）
    expect(within(panel).queryByTestId("agent-optimize-head")).toBeNull();
    expect(within(panel).queryByTestId("agent-optimize-empty")).toBeNull();
  });

  it("③ 在等预选 run 的计划历史：那一行报出 plan_id 与 run_key（不是通用「加载中」）", async () => {
    // 候选池先到（池子里没有这条 run ⇒ 退到 plan_id 的历史里找），list_plan_runs 仍挂着
    stubFetch(hangExcept({ list_recent_runs: () => sseResponse([{ event: "recent_runs", runs: [] }]) }));
    renderPage(<AgentDetailPage name="support-bot" tab="optimize" thisKey={LAST_KEY} />);
    const pending = screen.getByTestId("agent-optimize-pending");
    // 池子到达前是第一句（等 list_recent_runs），到达后换成第二句（等那个计划的历史）
    expect(pending).toHaveTextContent(`正在取这个 Agent 最近 ${RUNS_LIMIT} 次运行`);
    await waitFor(() =>
      expect(screen.getByTestId("agent-optimize-pending")).toHaveTextContent("「plan-ddd444」的运行历史"));
    expect(screen.getByTestId("agent-optimize-pending")).toHaveTextContent(LAST_KEY);
    // 全程没有落回空 DOM
    expect(screen.getByTestId("agent-tab-panel-optimize").childElementCount).toBeGreaterThan(0);
  });

  it("数据到位后骨架撤掉、换成口径行（骨架只多在未到态，不改到位态）", async () => {
    stubFetch({
      agent_status: () => sseResponse([{ event: "agent_status", ...STATUS }]),
      list_recent_runs: () => sseResponse([{ event: "recent_runs", runs: [] }]),
    });
    renderPage(<AgentDetailPage name="support-bot" tab="optimize" />);
    // 候选池到了但一条 completed 都没有 ⇒ 既有空态文案（不是骨架、也不是空 DOM）
    expect(await screen.findByTestId("agent-optimize-empty")).toHaveTextContent("还没有已完成的运行");
    await waitFor(() => expect(screen.queryByTestId("agent-optimize-skeleton")).toBeNull());
    expect(screen.queryByTestId("agent-optimize-pending")).toBeNull();
  });
});
