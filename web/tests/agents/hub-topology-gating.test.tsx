// ① 现状「路径」卡不吃 agent_status 门控（现网 12 秒空窗，真登录实测 2026-09-08）：
//   · agent_status 冷调 8.9s，StatusPanel 旧代码 `if (!status) return null` 把整行路径卡一起吞掉
//     ⇒ 那 9 秒里 data-testid=agent-topology 根本不在 DOM，用户读成「拓扑没有了」；
//   · 之后 agent_topology 自己再花 3.3s ⇒ 只有标题 + 一根骨架条，读不出在等什么。
// 本文件钉四件：
//   1) status 在途 ⇒ 路径卡（含 testid）立即在 DOM，五数还是骨架；
//   2) status 到达 ⇒ 路径卡**不重挂载**（同一个 DOM 节点 + 展开态与选中节点都还在 +
//      run_key 补上后会话行由 span 变成 a，证明是同一个实例吃到了新数据，不是重挂载重来）；
//   3) topology 在途 ⇒ 卡内一行「正在聚合近 7 天线上会话的 span…」，数据一到就消失；
//   4) agent_status 报错 ⇒ 原话照出，路径卡照在。
// 手法：两条查询各自可控——`deferredSse()` 给一个 body 是空 ReadableStream 的 200 响应，
// 请求一直挂着（= 现网冷调那几秒），`send()` 才推帧收流。锚点一律挑目标数据专属的 testid：
// 门槛数据（路径卡）与断言数据（五数 / 会话行）不同源，不能互相当门槛。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentTopologyEvent } from "../../src/lib/apiTypes";
import { agentStatusOf, agentTopologyOf, sseFrames } from "../../src/mocks/handlers";
import AgentDetailPage from "../../src/pages/agents/AgentDetailPage";
import TopologyCard from "../../src/pages/agents/detail/hub/TopologyCard";
import { renderPage, setupAgentsPageHooks, sseResponse, stubFetch, type Payload } from "./harness";

setupAgentsPageHooks();

const FIX = agentTopologyOf("support-bot") as AgentTopologyEvent;
const STATUS = agentStatusOf("support-bot") as unknown as Record<string, unknown> & {
  last_run: { run_key: string } | null;
};
const RUN_KEY = STATUS.last_run!.run_key;

/** 一直挂着的 SSE 响应：send() 之前 fetch 已返回但流不给数据 ⇒ 那条 useQuery 停在 isLoading */
function deferredSse() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  return {
    response: () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    send(events: unknown[]) {
      ctl.enqueue(new TextEncoder().encode(sseFrames(events)));
      ctl.close();
    },
  };
}

const topoOf = (p: Payload) => sseResponse([{ ...FIX, agent_name: p.agent_name }]);
const statusOf = (p: Payload) => sseResponse([{ event: "agent_status", ...STATUS, agent_name: p.agent_name }]);

describe("路径卡 · 不受 agent_status 门控", () => {
  it("status 在途：路径卡与 testid 立即在 DOM（五数还是骨架）；status 到了才出五数", async () => {
    const status = deferredSse();
    stubFetch({ agent_status: status.response, agent_topology: topoOf });
    renderPage(<AgentDetailPage name="support-bot" />);

    // 第一帧就在：不 await（await 会把「9 秒后才出现」也算过）
    expect(screen.getByTestId("agent-topology")).toBeInTheDocument();
    expect(screen.getByTestId("agent-status-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-obs")).toBeNull();
    expect(screen.queryByTestId("agent-last-run")).toBeNull();

    // status 还挂着，路径卡已经拿到自己的数据、能读出折叠一句
    expect(await screen.findByTestId("agent-topology-summary")).toHaveTextContent("5 个节点");
    expect(screen.queryByTestId("agent-obs")).toBeNull();

    status.send([{ event: "agent_status", ...STATUS }]);
    expect(await screen.findByTestId("agent-obs")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-status-skeleton")).toBeNull();
  });

  it("status 到达不重挂载：同一个 DOM 节点，展开态 / 选中节点不掉，会话行补上 run_key 变可点", async () => {
    const status = deferredSse();
    stubFetch({ agent_status: status.response, agent_topology: topoOf });
    renderPage(<AgentDetailPage name="support-bot" />);

    // status 在途就把卡展开、选一个节点（内部 useState：重挂载会全丢）
    fireEvent.click(await screen.findByTestId("agent-topology-summary"));
    const wrap = screen.getByTestId("agent-topology-expanded");
    const bash = within(wrap).getAllByTestId("agent-topology-node").find((g) => g.dataset.node === "tool:bash")!;
    fireEvent.click(bash);
    const detail = screen.getByTestId("agent-topology-node-detail");
    expect(detail.dataset.node).toBe("tool:bash");
    // 这一刻没有 run_key（status 在途）⇒ 会话行按现有降级口径：不可点 + 那句 title
    const before = within(detail).getAllByTestId("agent-topology-session-row");
    expect(before).toHaveLength(2);
    for (const r of before) {
      expect(r.tagName).toBe("SPAN");
      expect(r.getAttribute("title")).toBe("这条会话没进过线上评估 run");
    }
    // 身份钉：拿节点本身，不是 testid 查询结果（重挂载 ⇒ 新的 DOM 节点）
    const cardNode = screen.getByTestId("agent-topology");
    const wrapNode = screen.getByTestId("agent-topology-expanded");

    status.send([{ event: "agent_status", ...STATUS }]);
    await screen.findByTestId("agent-obs");

    expect(screen.getByTestId("agent-topology")).toBe(cardNode);
    expect(screen.getByTestId("agent-topology-expanded")).toBe(wrapNode);
    expect(screen.getByTestId("agent-topology-node-detail").dataset.node).toBe("tool:bash");
    // 同一个实例吃到新 run_key：行从 span 变成带 href 的 a（重挂载会退回折叠态，取不到这些行）
    const after = await within(screen.getByTestId("agent-topology-node-detail"))
      .findAllByTestId("agent-topology-session-row");
    await waitFor(() => expect(after[0].tagName).toBe("A"));
    expect(after[0].getAttribute("href")).toContain(`#/run/${encodeURIComponent(RUN_KEY)}?session=`);
  });

  it("agent_status 报错：原话照出，路径卡不被一起吞掉", async () => {
    stubFetch({
      agent_status: () => sseResponse([{ event: "error", error: "Agent 'support-bot' 不存在" }]),
      agent_topology: topoOf,
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    expect(await screen.findByTestId("agent-status-error")).toHaveTextContent("Agent 'support-bot' 不存在");
    expect(screen.getByTestId("agent-topology")).toBeInTheDocument();
    expect(await screen.findByTestId("agent-topology-summary")).toHaveTextContent("5 个节点");
  });
});

describe("路径卡 · 骨架说明在等什么", () => {
  it("agent_topology 在途：一行「正在聚合近 7 天线上会话的 span…」；数据一到这行消失、换成折叠一句", async () => {
    const topo = deferredSse();
    stubFetch({ agent_topology: topo.response, agent_status: statusOf });
    renderPage(<TopologyCard name="support-bot" />);

    const pending = screen.getByTestId("agent-topology-pending");
    expect(pending).toHaveTextContent("正在聚合近 7 天线上会话的 span");
    expect(screen.getByTestId("agent-topology-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-topology-summary")).toBeNull();
    // 骨架条是装饰，文案行不是：这一行必须能被读屏读到
    expect(screen.getByTestId("agent-topology-skeleton").getAttribute("aria-hidden")).toBeNull();
    expect(pending.closest("[aria-hidden='true']")).toBeNull();

    topo.send([FIX]);
    expect(await screen.findByTestId("agent-topology-summary")).toHaveTextContent("5 个节点");
    expect(screen.queryByTestId("agent-topology-pending")).toBeNull();
    expect(screen.queryByTestId("agent-topology-skeleton")).toBeNull();
  });
});

describe("agent_topology 契约 · span_origin", () => {
  it("类型里可读可写，值域只有 central / runtime_group / null（tsc 判）", () => {
    // 后端 app/topology.py:351 恒带此键；值来自 app/tracesource.py 的两个常量
    const central: AgentTopologyEvent = { ...FIX, span_origin: "central" };
    const runtime: AgentTopologyEvent = { ...FIX, span_origin: "runtime_group" };
    const none: AgentTopologyEvent = { ...FIX, span_origin: null };
    expect([central.span_origin, runtime.span_origin, none.span_origin]).toEqual(["central", "runtime_group", null]);
    // 反向钉：值域外的串必须红（这行不再报错 = 类型被写宽了）
    // @ts-expect-error span_origin 不接受 "runtime"（不是 tracesource 里的常量）
    const bad: AgentTopologyEvent = { ...FIX, span_origin: "runtime" };
    expect(bad.span_origin).toBe("runtime");
  });
});
