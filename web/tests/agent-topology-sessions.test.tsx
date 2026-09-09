// 路径卡 · 会话级两件（批 topology-sessions，用户 2026-09-07 现网反馈「点节点右侧最近会话是 —」+
// 「要能看单个会话走的那条路」）。
//   a) 节点详情「最近会话」：行数 / 顺序（后端倒序照列）/ ≤ 10 截断 / 每行 短 id · 时刻 · 耗时 · 报错标记 /
//      链接 href = #/run/<agent_status.last_run.run_key>?session=<sid>；没有 last_run ⇒ 行不可点 + title
//   b) 卡头「按会话」：右栏列 session_paths（≤ 10、顺序照后端）；点一条 ⇒ 路上节点 / 边 .path、其余 .dim；
//      再点取消；关掉「按会话」高亮撤；点节点回到详情、高亮撤
//   c) 纯函数：pathHighlight / sessionTraceHref / recentSessionsOf
// 夹具 = mocks/handlers 的 support-bot 桩（8 会话：6 条 start→agent、2 条经 write/bash/bash/read）；
// run_key 从同一份桩的 agent_status 读，不硬编。锚点都挑目标数据专属（那条 tool 节点的会话行、点亮那条会话的 sid）。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentTopologyEvent, TopologyNode } from "../src/lib/apiTypes";
import { agentStatusOf, agentTopologyOf } from "../src/mocks/handlers";
import TopologyCard from "../src/pages/agents/detail/hub/TopologyCard";
import { pathHighlight, recentSessionsOf, sessionTraceHref } from "../src/pages/agents/detail/hub/topology";
import { shortSessionId } from "../src/pages/plan/reportRows";
import { renderPage, setupAgentsPageHooks, sseResponse, stubFetch, type Payload } from "./agents/harness";

setupAgentsPageHooks();

const FIX = agentTopologyOf("support-bot") as AgentTopologyEvent;
const STATUS = agentStatusOf("support-bot") as unknown as { last_run: { run_key: string } | null };
const RUN_KEY = STATUS.last_run!.run_key;
const topoWith = (patch: Partial<AgentTopologyEvent>) => (p: Payload) =>
  sseResponse([{ ...FIX, agent_name: p.agent_name, ...patch }]);
const statusWith = (patch: Record<string, unknown>) => (p: Payload) =>
  sseResponse([{ event: "agent_status", ...STATUS, agent_name: p.agent_name, ...patch }]);

const bashNode = FIX.nodes.find((n) => n.id === "tool:bash")!;
const startNode = FIX.nodes.find((n) => n.id === "start")!;
/** 桩里经过 tool:bash 的那 2 条会话（新→旧） */
const BASH_SIDS = bashNode.recent_sessions.map((r) => r.session_id);

async function openCard() {
  fireEvent.click(await screen.findByTestId("agent-topology-summary"));
  return screen.getByTestId("agent-topology-expanded");
}
const nodeEl = (wrap: HTMLElement, id: string) =>
  within(wrap).getAllByTestId("agent-topology-node").find((g) => g.dataset.node === id)!;
const edgeEl = (wrap: HTMLElement, from: string, to: string) =>
  within(wrap).getAllByTestId("agent-topology-edge").find((g) => g.dataset.from === from && g.dataset.to === to)!;

describe("a) 节点详情「最近会话」", () => {
  it("tool:bash ⇒ 2 行、顺序照后端（新在前）、每行 短 id · MM-DD HH:mm · 耗时；href = #/run/<last_run.run_key>?session=<完整 id>", async () => {
    stubFetch();
    renderPage(<TopologyCard name="support-bot" />);
    const wrap = await openCard();
    fireEvent.click(nodeEl(wrap, "tool:bash"));
    // 锚点 = 这条节点专属的会话行（run_key 来自 agent_status，两条查询都到了才有 href）
    const rows = await within(screen.getByTestId("agent-topology-node-detail")).findAllByTestId("agent-topology-session-row");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dataset.sid)).toEqual(BASH_SIDS);
    expect(BASH_SIDS.length).toBe(2);
    await waitFor(() => expect(rows[0].tagName).toBe("A"));
    for (const [i, r] of rows.entries()) {
      const rs = bashNode.recent_sessions[i];
      expect(r).toHaveAttribute("href", `#/run/${encodeURIComponent(RUN_KEY)}?session=${encodeURIComponent(rs.session_id)}`);
      expect(r.getAttribute("title")).toContain(rs.session_id);
      expect(r).toHaveTextContent(shortSessionId(rs.session_id));
      expect(r).toHaveTextContent("0.06s");           // bash 在该会话走了两次 × 0.03
      expect(r.textContent).not.toContain("报错");
    }
    // 第一行的时刻 = 该节点在该会话里首见时刻（桩：会话开始 + 2s）→ "09-07 07:42"
    expect(rows[0]).toHaveTextContent("09-07 07:42");
    // 卡头小标写行数
    expect(screen.getByTestId("agent-topology-detail-sessions")).toHaveTextContent("最近会话2");
  });

  it("start ⇒ 8 行全列、耗时「—」；报错会话带「报错」标记；后端多给 12 条界面只列 10", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({
      session_id: `sess-0000000${(i + 1).toString(16).padStart(1, "0")}-x${i}`, at: `2026-09-0${(i % 7) + 1}T00:00:00Z`,
      duration_s: null, failed: i === 0,
    }));
    const nodes: TopologyNode[] = FIX.nodes.map((n) => (n.id === "start" ? { ...n, recent_sessions: twelve } : n));
    stubFetch({ agent_topology: topoWith({ nodes }) });
    renderPage(<TopologyCard name="support-bot" />);
    const wrap = await openCard();
    fireEvent.click(nodeEl(wrap, "start"));
    const detail = screen.getByTestId("agent-topology-node-detail");
    const rows = within(detail).getAllByTestId("agent-topology-session-row");
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.dataset.sid)).toEqual(twelve.slice(0, 10).map((s) => s.session_id));
    expect(rows[0]).toHaveTextContent("报错");
    expect(rows[1].textContent).not.toContain("报错");
    expect(rows[0]).toHaveTextContent("—");
    // 桩原样：start 8 行
    expect(startNode.recent_sessions).toHaveLength(8);
  });

  it("agent_status 没有 last_run ⇒ 行不是链接、title「这条会话没进过线上评估 run」", async () => {
    stubFetch({ agent_status: statusWith({ last_run: null }) });
    renderPage(<TopologyCard name="support-bot" />);
    const wrap = await openCard();
    fireEvent.click(nodeEl(wrap, "tool:bash"));
    const rows = within(screen.getByTestId("agent-topology-node-detail")).getAllByTestId("agent-topology-session-row");
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.tagName).toBe("SPAN");
      expect(r.getAttribute("href")).toBeNull();
      expect(r.getAttribute("title")).toBe("这条会话没进过线上评估 run");
    }
  });

  it("recent_sessions 为 [] ⇒ 「—」（不编行）", async () => {
    stubFetch({ agent_topology: topoWith({ nodes: FIX.nodes.map((n) => ({ ...n, recent_sessions: [] })) }) });
    renderPage(<TopologyCard name="support-bot" />);
    const wrap = await openCard();
    fireEvent.click(nodeEl(wrap, "agent"));
    const detail = screen.getByTestId("agent-topology-node-detail");
    expect(within(detail).queryAllByTestId("agent-topology-session-row")).toHaveLength(0);
    expect(screen.getByTestId("agent-topology-detail-sessions")).toHaveTextContent("最近会话0");
  });
});

describe("b) 卡头「按会话」：单会话级拓扑", () => {
  it("打开 ⇒ 右栏列 8 条会话（顺序照后端）；点第一条（经 write/bash/read）⇒ 路上 5 节点 .path、其余 .dim，边同理；再点取消", async () => {
    stubFetch();
    renderPage(<TopologyCard name="support-bot" />);
    const wrap = await openCard();
    // 折叠态 / 未点前没有这个 chip 之外的高亮
    const chip = screen.getByTestId("agent-topology-by-session");
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    const list = screen.getByTestId("agent-topology-session-paths");
    const rows = within(list).getAllByTestId("agent-topology-session-path");
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.dataset.sid)).toEqual(FIX.session_paths.map((p) => p.session_id));
    // 没点之前：图上没有 path / dim
    expect(screen.getByTestId("agent-topology-svg").dataset.highlight).toBeUndefined();
    expect(nodeEl(wrap, "agent").classList.contains("dim")).toBe(false);

    const first = FIX.session_paths[0];
    expect(first.path).toEqual(["start", "tool:write", "tool:bash", "tool:bash", "tool:read", "agent"]);
    expect(rows[0]).toHaveTextContent(shortSessionId(first.session_id));
    expect(rows[0]).toHaveTextContent("5 步");
    fireEvent.click(rows[0]);
    expect(rows[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("agent-topology-svg").dataset.highlight).toBe("session");
    for (const id of ["start", "tool:write", "tool:bash", "tool:read", "agent"]) {
      expect(nodeEl(wrap, id).classList.contains("path")).toBe(true);
      expect(nodeEl(wrap, id).classList.contains("dim")).toBe(false);
    }
    // 这条会话走过的边亮、没走过的（start → agent 直连）压暗
    expect(edgeEl(wrap, "tool:write", "tool:bash").classList.contains("path")).toBe(true);
    expect(edgeEl(wrap, "tool:bash", "tool:bash").classList.contains("path")).toBe(true);
    expect(edgeEl(wrap, "start", "agent").classList.contains("dim")).toBe(true);
    expect(edgeEl(wrap, "start", "agent").classList.contains("path")).toBe(false);
    // 再点同一条 ⇒ 取消
    fireEvent.click(rows[0]);
    expect(rows[0]).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("agent-topology-svg").dataset.highlight).toBeUndefined();
    expect(nodeEl(wrap, "start").classList.contains("path")).toBe(false);
    expect(edgeEl(wrap, "start", "agent").classList.contains("dim")).toBe(false);
  });

  it("点一条只走 start → agent 的会话 ⇒ 工具节点全 dim；关掉「按会话」⇒ 列表没了、高亮撤；点节点 ⇒ 回节点详情且高亮撤", async () => {
    stubFetch();
    renderPage(<TopologyCard name="support-bot" />);
    const wrap = await openCard();
    fireEvent.click(screen.getByTestId("agent-topology-by-session"));
    const rows = within(screen.getByTestId("agent-topology-session-paths")).getAllByTestId("agent-topology-session-path");
    const plain = FIX.session_paths.findIndex((p) => p.path.length === 2);
    fireEvent.click(rows[plain]);
    expect(rows[plain]).toHaveTextContent("1 步");
    for (const id of ["tool:write", "tool:bash", "tool:read"]) expect(nodeEl(wrap, id).classList.contains("dim")).toBe(true);
    expect(nodeEl(wrap, "agent").classList.contains("path")).toBe(true);
    expect(edgeEl(wrap, "start", "agent").classList.contains("path")).toBe(true);
    // 关掉「按会话」
    fireEvent.click(screen.getByTestId("agent-topology-by-session"));
    expect(screen.queryByTestId("agent-topology-session-paths")).toBeNull();
    expect(screen.getByTestId("agent-topology-node-table")).toBeInTheDocument();
    expect(nodeEl(wrap, "tool:bash").classList.contains("dim")).toBe(false);
    // 再打开、点亮、然后点节点 ⇒ 节点详情 + 高亮撤 + chip 关
    fireEvent.click(screen.getByTestId("agent-topology-by-session"));
    fireEvent.click(within(screen.getByTestId("agent-topology-session-paths")).getAllByTestId("agent-topology-session-path")[0]);
    expect(screen.getByTestId("agent-topology-svg").dataset.highlight).toBe("session");
    fireEvent.click(nodeEl(wrap, "tool:bash"));
    expect(screen.getByTestId("agent-topology-node-detail").dataset.node).toBe("tool:bash");
    expect(screen.getByTestId("agent-topology-by-session")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("agent-topology-svg").dataset.highlight).toBeUndefined();
  });

  it("session_paths 为 [] ⇒ 列表「—」；带 failed_nodes 的会话行带「报错 N」", async () => {
    stubFetch({ agent_topology: topoWith({ session_paths: [] }) });
    renderPage(<TopologyCard name="support-bot" />);
    await openCard();
    fireEvent.click(screen.getByTestId("agent-topology-by-session"));
    expect(screen.queryByTestId("agent-topology-session-paths")).toBeNull();
    expect(screen.getByTestId("agent-topology-detail")).toHaveTextContent("会话0");
  });

  it("failed_nodes > 0 ⇒ 行带「报错 N」", async () => {
    const paths = FIX.session_paths.map((p, i) => (i === 1 ? { ...p, failed_nodes: 2 } : p));
    stubFetch({ agent_topology: topoWith({ session_paths: paths }) });
    renderPage(<TopologyCard name="support-bot" />);
    await openCard();
    fireEvent.click(screen.getByTestId("agent-topology-by-session"));
    const rows = within(screen.getByTestId("agent-topology-session-paths")).getAllByTestId("agent-topology-session-path");
    expect(rows[1]).toHaveTextContent("报错 2");
    expect(rows[0].textContent).not.toContain("报错");
  });
});

describe("c) 纯函数", () => {
  it("pathHighlight：节点集 + 相邻边键（自环也算）", () => {
    const h = pathHighlight(["start", "tool:bash", "tool:bash", "agent"]);
    expect([...h.nodes]).toEqual(["start", "tool:bash", "agent"]);
    expect([...h.edges]).toEqual(["start>tool:bash", "tool:bash>tool:bash", "tool:bash>agent"]);
    expect(pathHighlight(["start"]).edges.size).toBe(0);
  });
  it("sessionTraceHref：run_key 含 # 要编码；没 run_key ⇒ null", () => {
    expect(sessionTraceHref("plan-a#2026-09-01T00:00:00Z", "sess-1")).toBe("#/run/plan-a%232026-09-01T00%3A00%3A00Z?session=sess-1");
    expect(sessionTraceHref(null, "sess-1")).toBeNull();
    expect(sessionTraceHref(undefined, "sess-1")).toBeNull();
  });
  it("recentSessionsOf：只截断到 10，不重排", () => {
    const rs = Array.from({ length: 12 }, (_, i) => ({ session_id: `s${i}`, at: null, duration_s: null, failed: false }));
    expect(recentSessionsOf({ recent_sessions: rs }).map((r) => r.session_id)).toEqual(rs.slice(0, 10).map((r) => r.session_id));
    expect(recentSessionsOf({ recent_sessions: [] })).toEqual([]);
  });
});
