// ① 现状「路径」卡（ADR-0017 D4，批 topology-frontend，用户选变体 A 卡内展开）。
// 真夹具：src/mocks/handlers 的 agent_topology 桩（support-bot 有图 = fixture-topology.json；
// research-agent 未配置 span 源）；报错节点 / 没有会话 两态按用例覆写数据。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentTopologyEvent } from "../src/lib/apiTypes";
import { agentTopologyOf } from "../src/mocks/handlers";
import AgentDetailPage from "../src/pages/agents/AgentDetailPage";
import TopologyCard from "../src/pages/agents/detail/hub/TopologyCard";
import { displayId, edgeGeom, fitText, layerOf, layout, strokeTier, summarize } from "../src/pages/agents/detail/hub/topology";
import { renderPage, setupAgentsPageHooks, sseResponse, stubFetch, type Payload } from "./agents/harness";

setupAgentsPageHooks();

const FIX = agentTopologyOf("support-bot") as AgentTopologyEvent;
const topoWith = (patch: Partial<AgentTopologyEvent>) => (p: Payload) =>
  sseResponse([{ ...FIX, agent_name: p.agent_name, ...patch }]);

async function openCard() {
  const btn = await screen.findByTestId("agent-topology-summary");
  fireEvent.click(btn);
  return screen.getByTestId("agent-topology-expanded");
}

describe("路径卡 · 折叠一句", () => {
  it("卡头「近 7 天 · 8 会话」，「同源」只进 title；一句 = 5 个节点 · 最慢 tool:bash 0.03s · 最常路径 start → agent 75.0%", async () => {
    stubFetch();
    renderPage(<TopologyCard name="support-bot" />);
    const sub = await screen.findByTestId("agent-topology-sub");
    expect(sub).toHaveTextContent("近 7 天 · 8 会话");
    expect(sub.textContent).not.toContain("同源");
    expect(sub.getAttribute("title")).toContain("与上方会话量同源");

    const line = screen.getByTestId("agent-topology-summary");
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("agent-topology-node-count")).toHaveTextContent("5");
    expect(screen.getByTestId("agent-topology-slowest")).toHaveTextContent("tool:bash 0.03s");
    expect(screen.getByTestId("agent-topology-top-path").textContent?.replace(/\s+/g, " ")).toBe("start→agent 75.0%");
    expect(line).toHaveTextContent("打开");
    // 折叠态不画图
    expect(screen.queryByTestId("agent-topology-svg")).toBeNull();
  });

  it("slowest / top_path 缺值 ⇒ 「—」，不编数", async () => {
    stubFetch({ agent_topology: topoWith({ slowest: null, top_path: null, nodes: FIX.nodes.map((n) => ({ ...n, avg_s: null })) }) });
    renderPage(<TopologyCard name="support-bot" />);
    expect(await screen.findByTestId("agent-topology-slowest")).toHaveTextContent("—");
    expect(screen.getByTestId("agent-topology-top-path")).toHaveTextContent("—");
  });
});

describe("路径卡 · 展开态", () => {
  it("点开：SVG 里 5 个节点、6 条边；节点写「N 次 · 平均 Xs」；右栏先列节点表；再点收起", async () => {
    stubFetch();
    renderPage(<TopologyCard name="support-bot" />);
    const wrap = await openCard();
    expect(screen.getByTestId("agent-topology-summary")).toHaveAttribute("aria-expanded", "true");
    expect(within(wrap).getAllByTestId("agent-topology-node")).toHaveLength(5);
    expect(within(wrap).getAllByTestId("agent-topology-edge")).toHaveLength(6);
    const bash = within(wrap).getAllByTestId("agent-topology-node").find((g) => g.dataset.node === "tool:bash")!;
    expect(bash).toHaveTextContent("4 次 · 平均 0.03s");
    expect(bash.classList.contains("err")).toBe(false);
    // 自环边有 title 标注
    const selfEdge = within(wrap).getAllByTestId("agent-topology-edge").find((g) => g.dataset.from === "tool:bash" && g.dataset.to === "tool:bash")!;
    expect(selfEdge.querySelector("title")?.textContent).toBe("tool:bash → tool:bash · 2 次 · 自环");
    // 右栏：节点表 5 行，按次数降序
    const rows = within(screen.getByTestId("agent-topology-node-table")).getAllByTestId("agent-topology-node-row");
    expect(rows.map((r) => r.dataset.node)).toEqual(["agent", "start", "tool:bash", "tool:read", "tool:write"]);
    // 卡头「收起」
    fireEvent.click(screen.getByTestId("agent-topology-collapse"));
    expect(screen.queryByTestId("agent-topology-expanded")).toBeNull();
    expect(screen.getByTestId("agent-topology-summary")).toHaveAttribute("aria-expanded", "false");
  });

  it("点节点 ⇒ 右栏详情（次数 / 平均 / P95 / 报错 + 进入边 · 出去边）；点另一节点切换；✕ 回节点表", async () => {
    stubFetch();
    renderPage(<TopologyCard name="support-bot" />);
    const wrap = await openCard();
    const node = (id: string) => within(wrap).getAllByTestId("agent-topology-node").find((g) => g.dataset.node === id)!;
    fireEvent.click(node("tool:bash"));
    const detail = screen.getByTestId("agent-topology-node-detail");
    expect(detail.dataset.node).toBe("tool:bash");
    expect(screen.getByTestId("agent-topology-detail-count")).toHaveTextContent("4");
    expect(screen.getByTestId("agent-topology-detail-avg")).toHaveTextContent("0.03s");
    expect(screen.getByTestId("agent-topology-detail-p95")).toHaveTextContent("0.05s");
    expect(screen.getByTestId("agent-topology-detail-errors")).toHaveTextContent("0");
    expect(screen.getByTestId("agent-topology-detail-errors").classList.contains("bad")).toBe(false);
    // 进入边：tool:write → bash、bash → bash（自环）；出去边：bash → bash、bash → tool:read
    expect(screen.getByTestId("agent-topology-detail-ins")).toHaveTextContent("2");
    expect(screen.getByTestId("agent-topology-detail-outs")).toHaveTextContent("2");
    expect(detail.textContent).toContain("← tool:write");
    expect(detail.textContent).toContain("→ tool:read");
    expect(detail.textContent).toContain("自环");
    // 选中节点带 sel 类，其余不带
    expect(node("tool:bash").classList.contains("sel")).toBe(true);
    expect(node("agent").classList.contains("sel")).toBe(false);
    // 「最近会话」：tool:bash 出现过的 2 条会话（细节在 agent-topology-sessions.test.tsx）
    const sess = screen.getByTestId("agent-topology-detail-sessions");
    expect(sess).toHaveTextContent("最近会话2");
    expect(within(detail).getAllByTestId("agent-topology-session-row")).toHaveLength(2);

    fireEvent.click(node("agent"));
    expect(screen.getByTestId("agent-topology-node-detail").dataset.node).toBe("agent");
    expect(screen.getByTestId("agent-topology-detail-avg")).toHaveTextContent("—");
    expect(screen.getByTestId("agent-topology-detail-ins")).toHaveTextContent("2");
    expect(screen.getByTestId("agent-topology-detail-outs")).toHaveTextContent("0");

    fireEvent.click(screen.getByTestId("agent-topology-deselect"));
    expect(screen.queryByTestId("agent-topology-node-detail")).toBeNull();
    expect(screen.getByTestId("agent-topology-node-table")).toBeInTheDocument();
    // 节点表行也能选
    fireEvent.click(within(screen.getByTestId("agent-topology-node-table")).getAllByTestId("agent-topology-node-row")[0]);
    expect(screen.getByTestId("agent-topology-node-detail").dataset.node).toBe("agent");
  });

  it("errors > 0 的节点：图上带 err 类 + 「报错 N」，详情报错格带 bad 类；其余节点不上色", async () => {
    stubFetch({
      agent_topology: topoWith({ nodes: FIX.nodes.map((n) => (n.id === "tool:bash" ? { ...n, errors: 2 } : n)) }),
    });
    renderPage(<TopologyCard name="support-bot" />);
    const wrap = await openCard();
    const nodes = within(wrap).getAllByTestId("agent-topology-node");
    const bash = nodes.find((g) => g.dataset.node === "tool:bash")!;
    expect(bash.classList.contains("err")).toBe(true);
    expect(bash).toHaveTextContent("报错 2");
    expect(nodes.filter((g) => g.classList.contains("err"))).toHaveLength(1);
    fireEvent.click(bash);
    expect(screen.getByTestId("agent-topology-detail-errors")).toHaveTextContent("2");
    expect(screen.getByTestId("agent-topology-detail-errors").classList.contains("bad")).toBe(true);
    // 节点表里的报错格同样
    fireEvent.click(screen.getByTestId("agent-topology-deselect"));
    const row = within(screen.getByTestId("agent-topology-node-table")).getAllByTestId("agent-topology-node-row")
      .find((r) => r.dataset.node === "tool:bash")!;
    expect(row.querySelector("td.num.bad")?.textContent).toBe("2");
  });
});

describe("路径卡 · 无数据态", () => {
  it("未配置 span 源（research-agent）：一行「未配置 span 源 · 去 ④ 配置 →」，不画图；原因原话进 title", async () => {
    stubFetch();
    renderPage(<TopologyCard name="research-agent" />);
    const line = await screen.findByTestId("agent-topology-unavailable");
    expect(line.dataset.kind).toBe("no_span_source");
    expect(line).toHaveTextContent("未配置 span 源");
    expect(screen.queryByTestId("agent-topology-summary")).toBeNull();
    expect(screen.queryByTestId("agent-topology-svg")).toBeNull();
    fireEvent.click(screen.getByTestId("agent-topology-goto-config"));
    expect(location.hash).toBe("#/agent/research-agent/config");
  });

  it("近 7 天没有会话：一行「近 7 天没有会话」，无配置链接", async () => {
    stubFetch({
      agent_topology: topoWith({
        sessions: 0, nodes: [], edges: [], top_path: null, slowest: null, unavailable_reason: "近 7 天没有会话",
      }),
    });
    renderPage(<TopologyCard name="support-bot" />);
    const line = await screen.findByTestId("agent-topology-unavailable");
    expect(line.dataset.kind).toBe("other");
    expect(line).toHaveTextContent("近 7 天没有会话");
    expect(screen.queryByTestId("agent-topology-goto-config")).toBeNull();
    expect(screen.queryByTestId("agent-topology-svg")).toBeNull();
  });

  it("另两句不可用原话照显示；「span 行数达上限」那句含 span 但不能画成「未配置」", async () => {
    const LIMIT = "近 7 天 span 行数达到 Logs Insights 单次查询上限 10000，聚合不完整";
    stubFetch({
      agent_topology: topoWith({ sessions: 0, nodes: [], edges: [], top_path: null, slowest: null, unavailable_reason: LIMIT }),
    });
    const { unmount } = renderPage(<TopologyCard name="support-bot" />);
    let line = await screen.findByTestId("agent-topology-unavailable");
    expect(line.dataset.kind).toBe("other");
    expect(screen.getByTestId("agent-topology-unavailable-reason")).toHaveTextContent(LIMIT);
    expect(screen.queryByTestId("agent-topology-goto-config")).toBeNull();
    unmount();

    const FAIL = "Logs Insights 查询失败：QueryTimeout after 60s";
    stubFetch({
      agent_topology: topoWith({ sessions: 0, nodes: [], edges: [], top_path: null, slowest: null, unavailable_reason: FAIL }),
    });
    renderPage(<TopologyCard name="support-bot" />);
    line = await screen.findByTestId("agent-topology-unavailable");
    expect(screen.getByTestId("agent-topology-unavailable-reason")).toHaveTextContent(FAIL);
    expect(line.dataset.kind).toBe("other");
  });

  it("后端错误帧原话直出（不吞）", async () => {
    stubFetch({ agent_topology: () => sseResponse([{ event: "error", error: "Agent 'ghost' 不存在" }]) });
    renderPage(<TopologyCard name="ghost" />);
    expect(await screen.findByTestId("agent-topology-error")).toHaveTextContent("Agent 'ghost' 不存在");
  });
});

describe("路径卡 · 层次 / 横向切换（ADR-0017 待定点 4 · 一期做）", () => {
  it("折叠态没有切换 chip；展开后卡头出「层次 / 横向」，默认层次；切横向 ⇒ 节点 5 / 边 6 不变、画布换横向", async () => {
    stubFetch();
    renderPage(<TopologyCard name="support-bot" />);
    await screen.findByTestId("agent-topology-summary");
    expect(screen.queryByTestId("agent-topology-orient")).toBeNull();
    const wrap = await openCard();
    const seg = screen.getByTestId("agent-topology-orient");
    expect(seg).toHaveAttribute("aria-label", "布局");
    expect(screen.getByTestId("agent-topology-orient-v")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("agent-topology-orient-h")).toHaveAttribute("aria-pressed", "false");
    const svgV = screen.getByTestId("agent-topology-svg");
    expect(svgV.dataset.orient).toBe("v");
    const hV = Number(svgV.getAttribute("height"));

    fireEvent.click(screen.getByTestId("agent-topology-orient-h"));
    expect(screen.getByTestId("agent-topology-orient-h")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("agent-topology-orient-v")).toHaveAttribute("aria-pressed", "false");
    const svgH = screen.getByTestId("agent-topology-svg");
    expect(svgH.dataset.orient).toBe("h");
    expect(Number(svgH.getAttribute("height"))).toBeLessThan(hV);
    expect(within(wrap).getAllByTestId("agent-topology-node")).toHaveLength(5);
    expect(within(wrap).getAllByTestId("agent-topology-edge")).toHaveLength(6);
    // 横向：层自左而右 —— start 最左、agent 最右
    const xOf = (id: string) => Number(/translate\((-?[\d.]+),/.exec(
      within(wrap).getAllByTestId("agent-topology-node").find((g) => g.dataset.node === id)!.getAttribute("transform")!)![1]);
    expect(xOf("start")).toBeLessThan(xOf("tool:write"));
    expect(xOf("tool:read")).toBeLessThan(xOf("agent"));
    // 自环在横向态仍有 title
    const selfEdge = within(wrap).getAllByTestId("agent-topology-edge").find((g) => g.dataset.from === "tool:bash" && g.dataset.to === "tool:bash")!;
    expect(selfEdge.querySelector("title")?.textContent).toContain("自环");
  });

  it("chip 状态保持在展开态内：切横向后点节点、看详情，仍是横向；切回层次同理", async () => {
    stubFetch();
    renderPage(<TopologyCard name="support-bot" />);
    const wrap = await openCard();
    fireEvent.click(screen.getByTestId("agent-topology-orient-h"));
    fireEvent.click(within(wrap).getAllByTestId("agent-topology-node").find((g) => g.dataset.node === "tool:bash")!);
    expect(screen.getByTestId("agent-topology-node-detail").dataset.node).toBe("tool:bash");
    expect(screen.getByTestId("agent-topology-orient-h")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("agent-topology-svg").dataset.orient).toBe("h");
    // 详情栏内容与布局无关
    expect(screen.getByTestId("agent-topology-detail-ins")).toHaveTextContent("2");
    fireEvent.click(screen.getByTestId("agent-topology-orient-v"));
    expect(screen.getByTestId("agent-topology-svg").dataset.orient).toBe("v");
    expect(screen.getByTestId("agent-topology-node-detail").dataset.node).toBe("tool:bash");
    expect(within(wrap).getAllByTestId("agent-topology-edge")).toHaveLength(6);
  });
});

describe("路径卡 · 挂载与守卫", () => {
  it("挂在 ① 现状三卡之后；「均分」不裸出现；术语「方案」0 次", async () => {
    stubFetch({
      estimate_plan_run: (p) => sseResponse([{ event: "plan_run_estimate", plan_id: p.plan_id, stages: [], estimated_cost_usd: 2.0 }]),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    // 门槛锚点挑三卡里最后那张：路径卡现在**不等 agent_status**（见 StatusPanel 门控），
    // 拿 agent-topology 当锚点会在 status 未到时就放行，三卡还不在 DOM 里 ⇒ 顺序断言取不到数。
    await screen.findByTestId("agent-next-run");
    const card = screen.getByTestId("agent-topology");
    const panel = screen.getByTestId("agent-tab-panel-status");
    expect(panel.contains(card)).toBe(true);
    // 顺序：最近一次评估 / 告警 / 下次运行 之后
    const order = ["agent-last-run", "agent-alerts", "agent-next-run", "agent-topology"]
      .map((id) => screen.getByTestId(id));
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    await openCard();
    await waitFor(() => expect(screen.getByTestId("agent-topology-expanded")).toBeInTheDocument());
    expect(card.textContent).not.toContain("均分");
    expect(card.textContent).not.toContain("方案");
  });
});

describe("topology.ts 纯派生", () => {
  it("层 = start 起最长路径：start 0 / tool:write 1 / tool:bash 2（自环不算）/ tool:read 3 / agent 4；同层横排、总高随层数", () => {
    const layer = layerOf(FIX.nodes, FIX.edges);
    expect(layer).toEqual({ start: 0, "tool:write": 1, "tool:bash": 2, "tool:read": 3, agent: 4 });
    const lay = layout(FIX.nodes, FIX.edges, 760);
    expect(lay.pos.start.y).toBeLessThan(lay.pos["tool:write"].y);
    expect(lay.pos["tool:read"].y).toBeLessThan(lay.pos.agent.y);
    expect(lay.H).toBe(16 * 2 + 5 * 60 + 4 * 64);
    // 有环也不死循环：a → b → a
    const cyc = layerOf(
      [{ id: "a", kind: "agent", label: "a", count: 1, avg_s: null, p95_s: null, errors: 0, recent_sessions: [] },
       { id: "b", kind: "tool", label: "b", count: 1, avg_s: null, p95_s: null, errors: 0, recent_sessions: [] }],
      [{ from: "a", to: "b", count: 1 }, { from: "b", to: "a", count: 1 }],
    );
    expect(Object.keys(cyc).sort()).toEqual(["a", "b"]);
  });

  it("契约样例（agent → model ⇄ tool 有环）：回头边剔掉后 start 0 / agent 1 / model 2 / tool:bash 3；模型节点界面写短名", async () => {
    const MODEL = "model:us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    const nodes: AgentTopologyEvent["nodes"] = [
      { id: "start", kind: "start", label: "start", count: 8, avg_s: null, p95_s: null, errors: 0, recent_sessions: [] },
      { id: "agent", kind: "agent", label: "agent", count: 8, avg_s: 4.21, p95_s: 9.8, errors: 0, recent_sessions: [] },
      { id: "tool:bash", kind: "tool", label: "bash", count: 4, avg_s: 0.03, p95_s: 0.05, errors: 2, recent_sessions: [] },
      { id: MODEL, kind: "model", label: "claude-sonnet-4-5", count: 12, avg_s: 3.9, p95_s: 8.1, errors: 0, recent_sessions: [] },
    ];
    const edges = [
      { from: "start", to: "agent", count: 8 }, { from: "agent", to: MODEL, count: 8 },
      { from: MODEL, to: "tool:bash", count: 4 }, { from: "tool:bash", to: MODEL, count: 4 },
    ];
    expect(layerOf(nodes, edges)).toEqual({ start: 0, agent: 1, [MODEL]: 2, "tool:bash": 3 });
    const lay = layout(nodes, edges, 760);
    for (const p of Object.values(lay.pos)) for (const v of Object.values(p)) expect(Number.isFinite(v)).toBe(true);
    expect(displayId(MODEL, nodes)).toBe("claude-sonnet-4-5");
    expect(displayId("tool:bash", nodes)).toBe("tool:bash");
    expect(fitText("abcdefghij", 6)).toBe("abcde…");

    stubFetch({
      agent_topology: topoWith({
        nodes, edges, sessions: 8,
        top_path: { nodes: ["start", "agent", MODEL], count: 6, share: 0.75 },
        slowest: { id: "agent", avg_s: 4.21 },
      }),
    });
    renderPage(<TopologyCard name="support-bot" />);
    const tp = await screen.findByTestId("agent-topology-top-path");
    expect(tp.textContent?.replace(/\s+/g, " ")).toBe("start→agent→claude-sonnet-4-5 75.0%");
    expect(tp.getAttribute("title")).toBe(`start → agent → ${MODEL}`);
    expect(screen.getByTestId("agent-topology-slowest")).toHaveTextContent("agent 4.21s");
    const wrap = await openCard();
    const modelNode = within(wrap).getAllByTestId("agent-topology-node").find((g) => g.dataset.node === MODEL)!;
    expect(modelNode.querySelector("text.t1")?.textContent).toBe("claude-sonnet-4-5");
    expect(modelNode.querySelector("title")?.textContent).toContain(MODEL);
    fireEvent.click(modelNode);
    expect(screen.getByTestId("agent-topology-detail-id")).toHaveTextContent("claude-sonnet-4-5");
    expect(screen.getByTestId("agent-topology-detail-id").getAttribute("title")).toBe(MODEL);
    // 进入边 agent / tool:bash，出去边 tool:bash
    expect(screen.getByTestId("agent-topology-detail-ins")).toHaveTextContent("2");
    expect(screen.getByTestId("agent-topology-detail-outs")).toHaveTextContent("1");
  });

  it("道：start/agent 在主轴、工具另一道 ⇒ 层次态 start 与 agent 同 x、工具同 x 且靠右；横向态层 → x 递增、道 → y", () => {
    const v = layout(FIX.nodes, FIX.edges, 760, "v");
    expect(v.pos.start.x).toBe(v.pos.agent.x);
    expect(v.pos["tool:write"].x).toBe(v.pos["tool:bash"].x);
    expect(v.pos["tool:write"].x).toBeGreaterThan(v.pos.start.x);
    const h = layout(FIX.nodes, FIX.edges, 760, "h");
    expect(h.orient).toBe("h");
    expect(h.H).toBe(380);
    expect(h.pos.start.x).toBeLessThan(h.pos["tool:write"].x);
    expect(h.pos["tool:bash"].x).toBeLessThan(h.pos["tool:read"].x);
    expect(h.pos["tool:read"].x).toBeLessThan(h.pos.agent.x);
    expect(h.pos.start.y).toBe(h.pos.agent.y);
    expect(h.pos["tool:bash"].y).toBeGreaterThan(h.pos.start.y);
    for (const p of Object.values(h.pos)) { expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y + p.h).toBeLessThanOrEqual(380); }
    // 横向态：跨层边右出左进（起点 = a 右边缘中点）；自环在上方
    const g = edgeGeom(h.pos.start, h.pos.agent, false, [], "h");
    expect(g.d.startsWith(`M${h.pos.start.x + h.pos.start.w},${h.pos.start.y + h.pos.start.h / 2}`)).toBe(true);
    const loop = edgeGeom(h.pos["tool:bash"], h.pos["tool:bash"], true, [], "h");
    expect(loop.ly).toBeLessThan(h.pos["tool:bash"].y);
  });

  it("同一直线被中间节点挡住的边会鼓弧让开（层次态竖线 / 横向态横线）", () => {
    const a = { x: 100, y: 0, w: 176, h: 60 };
    const mid = { x: 100, y: 124, w: 176, h: 60 };
    const b = { x: 100, y: 248, w: 176, h: 60 };
    const straight = edgeGeom(a, b, false, [], "v");
    const bowed = edgeGeom(a, b, false, [mid], "v");
    expect(straight.d).not.toBe(bowed.d);
    expect(Math.abs(bowed.lx - straight.lx)).toBeGreaterThan(40);
    const ha = { x: 0, y: 100, w: 136, h: 48 };
    const hm = { x: 200, y: 100, w: 136, h: 48 };
    const hb = { x: 400, y: 100, w: 136, h: 48 };
    expect(edgeGeom(ha, hb, false, [hm], "h").d).not.toBe(edgeGeom(ha, hb, false, [], "h").d);
  });

  it("边粗细三档；自环几何；summarize 从 nodes 现算最慢", () => {
    expect(strokeTier(6, 6)).toBe(3.5);
    expect(strokeTier(2, 6)).toBe(2.5);
    expect(strokeTier(1, 6)).toBe(1.5);
    expect(strokeTier(1, 0)).toBe(1.5);
    const box = { x: 100, y: 100, w: 176, h: 60 };
    expect(edgeGeom(box, box, true).self).toBe(true);
    const down = edgeGeom(box, { ...box, y: 300 }, false);
    expect(down.d.startsWith("M188,160")).toBe(true);
    const s = summarize({ nodes: FIX.nodes, slowest: null, top_path: FIX.top_path });
    expect(s.slowest).toEqual({ id: "tool:bash", avg_s: 0.03 });
    expect(s.nodeCount).toBe(5);
  });
});

// ---------- 评估流量三档（后端 include_eval · sessions_scope） ----------
// 真夹具：billing-bot（真实 0 / 评估 3 ⇒ 自动态 eval_only）、legal-qa（窗内一条 span 都没有）；
// 「live 且另有评估会话」态 support-bot 夹具没有（评估 0，视觉基线 24 号那张要保持不变），按用例覆写。
import { scopeChip, unavailableKind } from "../src/pages/agents/detail/hub/topology";

describe("路径卡 · 评估流量 chip", () => {
  it("support-bot（真实 8 · 评估 0）：不画 chip；请求里不带 include_eval", async () => {
    const calls = stubFetch();
    renderPage(<TopologyCard name="support-bot" />);
    await screen.findByTestId("agent-topology-summary");
    expect(screen.queryByTestId("agent-topology-scope")).toBeNull();
    const req = calls.find((c) => c.action === "agent_topology")!;
    expect("include_eval" in req).toBe(false);
  });

  it("billing-bot（自动态退到 eval_only）：静态 chip「含评估流量」+ title 说清是回归测试 / 红队测试的会话；折叠句用评估会话数 3", async () => {
    stubFetch();
    renderPage(<TopologyCard name="billing-bot" />);
    const chip = await screen.findByTestId("agent-topology-scope");
    expect(chip.dataset.scope).toBe("eval_only");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.textContent).toBe("含评估流量");
    expect(chip.getAttribute("title")).toBe("近 7 天没有真实流量，图里是回归测试 / 红队测试的会话");
    expect(screen.getByTestId("agent-topology-sub")).toHaveTextContent("近 7 天 · 3 会话");
    // 正文里不出现解释性散文：那句只在 title
    const card = screen.getByTestId("agent-topology");
    expect(card.textContent).not.toContain("没有真实流量");
    // 有图可展开
    expect(screen.getByTestId("agent-topology-node-count")).toHaveTextContent("5");
    await openCard();
    expect(screen.getAllByTestId("agent-topology-node")).toHaveLength(5);
  });

  it("live 且另有评估会话：可点 chip「只看真实流量 · 另有评估会话 5」；点了带 include_eval:true 重取 ⇒ 「含评估流量 · 真实 8 · 评估 5」且折叠句换成 13 会话；再点回自动态", async () => {
    const calls = stubFetch({
      agent_topology: (p) => sseResponse([{
        ...FIX, agent_name: p.agent_name, live_sessions: 8, eval_sessions: 5,
        sessions_scope: p.include_eval ? "live+eval" : "live",
        sessions: p.include_eval ? 13 : 8,
      }]),
    });
    renderPage(<TopologyCard name="support-bot" />);
    const chip = await screen.findByTestId("agent-topology-scope");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.dataset.scope).toBe("live");
    expect(chip.textContent).toBe("只看真实流量 · 另有评估会话 5");
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("agent-topology-sub")).toHaveTextContent("近 7 天 · 8 会话");
    const before = calls.filter((c) => c.action === "agent_topology").length;

    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByTestId("agent-topology-scope").dataset.scope).toBe("live+eval"));
    const reqs = calls.filter((c) => c.action === "agent_topology");
    expect(reqs.length).toBe(before + 1);
    expect(reqs[reqs.length - 1]).toMatchObject({ action: "agent_topology", agent_name: "support-bot", include_eval: true });
    const chip2 = screen.getByTestId("agent-topology-scope");
    expect(chip2.textContent).toBe("含评估流量 · 真实 8 · 评估 5");
    expect(chip2).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("agent-topology-sub")).toHaveTextContent("近 7 天 · 13 会话");

    fireEvent.click(chip2);
    await waitFor(() => expect(screen.getByTestId("agent-topology-scope").dataset.scope).toBe("live"));
    const last = calls.filter((c) => c.action === "agent_topology").pop()!;
    expect("include_eval" in last).toBe(false);
    expect(screen.getByTestId("agent-topology-sub")).toHaveTextContent("近 7 天 · 8 会话");
  });

  it("mock 的 billing-bot 三档：include_eval:false ⇒ 「近 7 天没有会话」且 agent_reports_spans 为真；true ⇒ live+eval 同一张图", () => {
    const off = agentTopologyOf("billing-bot", undefined, undefined, false) as AgentTopologyEvent;
    expect(off.unavailable_reason).toBe("近 7 天没有会话");
    expect(off.sessions_scope).toBe("live");
    expect(off.agent_reports_spans).toBe(true);
    expect(off.eval_sessions).toBe(3);
    const on = agentTopologyOf("billing-bot", undefined, undefined, true) as AgentTopologyEvent;
    expect(on.sessions_scope).toBe("live+eval");
    expect(on.sessions).toBe(3);
    expect(on.nodes).toEqual((agentTopologyOf("billing-bot") as AgentTopologyEvent).nodes);
  });
});

describe("路径卡 · 两句空态", () => {
  it("legal-qa：「近 7 天 Agent 未上报任何 span（含评估流量）」+ 只在此态出现的状态行「回归测试的调用也没留下 trace，这个 Agent 没接 OTel 上报」；无配置链接、无 chip", async () => {
    stubFetch();
    renderPage(<TopologyCard name="legal-qa" />);
    const line = await screen.findByTestId("agent-topology-unavailable");
    expect(line.dataset.kind).toBe("no_spans");
    expect(screen.getByTestId("agent-topology-unavailable-reason")).toHaveTextContent("近 7 天 Agent 未上报任何 span（含评估流量）");
    expect(screen.getByTestId("agent-topology-no-spans-note")).toHaveTextContent("回归测试的调用也没留下 trace，这个 Agent 没接 OTel 上报");
    expect(screen.queryByTestId("agent-topology-goto-config")).toBeNull();
    expect(screen.queryByTestId("agent-topology-scope")).toBeNull();
    expect(screen.queryByTestId("agent-topology-summary")).toBeNull();
  });

  it("「近 7 天没有会话」与「未配置 span 源」都不带那行状态行", async () => {
    stubFetch({
      agent_topology: topoWith({
        sessions: 0, nodes: [], edges: [], top_path: null, slowest: null, unavailable_reason: "近 7 天没有会话",
        live_sessions: 0, eval_sessions: 0, agent_reports_spans: true,
      }),
    });
    const { unmount } = renderPage(<TopologyCard name="support-bot" />);
    const line = await screen.findByTestId("agent-topology-unavailable");
    expect(line.dataset.kind).toBe("other");
    expect(screen.queryByTestId("agent-topology-no-spans-note")).toBeNull();
    unmount();

    stubFetch();
    renderPage(<TopologyCard name="research-agent" />);
    await screen.findByTestId("agent-topology-unavailable");
    expect(screen.queryByTestId("agent-topology-no-spans-note")).toBeNull();
  });

  it("显式只看真实流量却只有评估会话（后端 include_eval:false 形态）：原话「近 7 天没有会话」，chip 仍提示另有评估会话", async () => {
    stubFetch({
      agent_topology: topoWith({
        sessions: 0, nodes: [], edges: [], top_path: null, slowest: null, unavailable_reason: "近 7 天没有会话",
        sessions_scope: "live", live_sessions: 0, eval_sessions: 3, agent_reports_spans: true,
      }),
    });
    renderPage(<TopologyCard name="support-bot" />);
    await screen.findByTestId("agent-topology-unavailable");
    expect(screen.getByTestId("agent-topology-unavailable-reason")).toHaveTextContent("近 7 天没有会话");
    expect(screen.getByTestId("agent-topology-scope").textContent).toBe("只看真实流量 · 另有评估会话 3");
  });
});

describe("topology.ts · unavailableKind / scopeChip", () => {
  it("unavailableKind 三分：未配置 span 源 / 未上报任何 span / 其余（行数上限那句含 span 但归其余）", () => {
    expect(unavailableKind("未配置 span 源")).toBe("no_span_source");
    expect(unavailableKind("近 7 天 Agent 未上报任何 span（含评估流量）")).toBe("no_spans");
    expect(unavailableKind("近 30 天 Agent 未上报任何 span（含评估流量）")).toBe("no_spans");
    expect(unavailableKind("近 7 天没有会话")).toBe("other");
    expect(unavailableKind("近 7 天 span 行数达到 Logs Insights 单次查询上限 10000，聚合不完整")).toBe("other");
    expect(unavailableKind(null)).toBe("other");
  });

  it("scopeChip：eval_only 静态 / live+eval 可点回自动 / live 且 E>0 可点带 true / live 且 E=0 不画", () => {
    const base = { lookback_days: 7 };
    const a = scopeChip({ ...base, sessions_scope: "eval_only", live_sessions: 0, eval_sessions: 3 })!;
    expect([a.label, a.next]).toEqual(["含评估流量", null]);
    expect(a.title).toBe("近 7 天没有真实流量，图里是回归测试 / 红队测试的会话");
    const b = scopeChip({ ...base, sessions_scope: "live+eval", live_sessions: 8, eval_sessions: 5 })!;
    expect([b.label, b.next]).toEqual(["含评估流量 · 真实 8 · 评估 5", undefined]);
    const c = scopeChip({ ...base, sessions_scope: "live", live_sessions: 8, eval_sessions: 5 })!;
    expect([c.label, c.next]).toEqual(["只看真实流量 · 另有评估会话 5", true]);
    expect(scopeChip({ ...base, sessions_scope: "live", live_sessions: 8, eval_sessions: 0 })).toBeNull();
  });
});
