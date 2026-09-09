// 「路径」卡（ADR-0017 D4）的纯派生：折叠一句的三个数、层次布局、边的几何。
// 组件只摆版面；数字规则（时延两位小数 + s / 比率一位小数 + % / 缺值「—」）都在这里。
import type {
  AgentTopologyEvent, TopologyEdge, TopologyNode, TopologyNodeKind, TopologyRecentSession, TopologySessionPath,
} from "../../../../lib/apiTypes";
import { fmtStamp } from "../../home/derive";

/** 秒 → 两位小数 + s（0.03 → "0.03s"）；null → "—" */
export function fmtS(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(2)}s`;
}

/** 后端没给 kind 时按 id 前缀推（与 transcript.py 命名一致） */
export function kindOf(n: Pick<TopologyNode, "id"> & { kind?: TopologyNodeKind }): TopologyNodeKind {
  if (n.kind) return n.kind;
  if (n.id === "start") return "start";
  if (n.id === "agent") return "agent";
  if (n.id.startsWith("model:")) return "model";
  return "tool";
}

// ---------- 折叠一句 ----------

export interface TopologySummary {
  nodeCount: number;
  /** 最慢节点（后端 slowest；缺则从 nodes 里按 avg_s 现算）；没有带时长的节点 ⇒ null */
  slowest: { id: string; avg_s: number } | null;
  topPath: { nodes: string[]; share: number } | null;
}

export function summarize(t: Pick<AgentTopologyEvent, "nodes" | "slowest" | "top_path">): TopologySummary {
  let slowest = t.slowest ?? null;
  if (!slowest) {
    const timed = t.nodes.filter((n): n is TopologyNode & { avg_s: number } => n.avg_s != null && Number.isFinite(n.avg_s));
    if (timed.length) {
      const s = timed.reduce((a, b) => (b.avg_s > a.avg_s ? b : a));
      slowest = { id: s.id, avg_s: s.avg_s };
    }
  }
  const tp = t.top_path;
  const topPath = tp && tp.nodes.length > 0 ? { nodes: tp.nodes, share: tp.share } : null;
  return { nodeCount: t.nodes.length, slowest, topPath };
}

/** 不可用三种画法：原话恰为「未配置 span 源」（app/topology.py NO_SPAN_SOURCE）⇒ 配「去 ④ 配置 →」；
 *  「近 N 天 Agent 未上报任何 span（含评估流量）」⇒ no_spans，配一行「没接 OTel 上报」的状态判断；
 *  其余（近 N 天没有会话 / Logs Insights 查询失败：… / 行数达上限）原文照显示。
 *  不能按「含 span」判——行数上限那句也含 span；no_spans 锚「未上报任何 span」这一段。 */
export function unavailableKind(reason: string | null | undefined): "no_span_source" | "no_spans" | "other" {
  const r = (reason ?? "").trim();
  if (r === "未配置 span 源") return "no_span_source";
  if (/^近 \d+ 天 Agent 未上报任何 span/.test(r)) return "no_spans";
  return "other";
}

// ---------- 卡头「评估流量」chip ----------
//
// 后端三档 sessions_scope（契约 agent_topology「评估流量三档」）在卡头折叠句后面画成一枚 chip：
//   eval_only  「含评估流量」（静态；title 说清是回归测试 / 红队测试的会话）
//   live+eval  「含评估流量 · 真实 L · 评估 E」（可点 ⇒ 回自动态，去掉 include_eval）
//   live 且 E>0「只看真实流量 · 另有评估会话 E」（可点 ⇒ 带 include_eval:true 重取）
//   live 且 E=0 不画（没有可切的东西）。点 chip = 换 react-query key 重新请求，不在前端拼图。

export interface ScopeChip {
  scope: AgentTopologyEvent["sessions_scope"];
  label: string;
  title: string;
  /** 点了以后要带的 include_eval（undefined = 省略 ⇒ 自动态）；null = 不可点 */
  next: true | undefined | null;
}

export function scopeChip(t: Pick<AgentTopologyEvent, "sessions_scope" | "live_sessions" | "eval_sessions" | "lookback_days">): ScopeChip | null {
  const L = t.live_sessions ?? 0;
  const E = t.eval_sessions ?? 0;
  if (t.sessions_scope === "eval_only") {
    return {
      scope: "eval_only", label: "含评估流量", next: null,
      title: `近 ${t.lookback_days} 天没有真实流量，图里是回归测试 / 红队测试的会话`,
    };
  }
  if (t.sessions_scope === "live+eval") {
    return {
      scope: "live+eval", label: `含评估流量 · 真实 ${L} · 评估 ${E}`, next: undefined,
      title: "两类会话画在同一张图里；点一下回到只看真实流量",
    };
  }
  if (E > 0) {
    return {
      scope: "live", label: `只看真实流量 · 另有评估会话 ${E}`, next: true,
      title: `近 ${t.lookback_days} 天另有 ${E} 个回归测试 / 红队测试的会话没画进图；点一下一起画`,
    };
  }
  return null;
}

/** 节点在界面上的名字：模型节点 id 太长（model:us.anthropic.claude-…-v1:0）用后端短名 label，
 *  其余写 id（tool:bash 与折叠一句 / ADR 命名一致）。找不到节点 ⇒ 原 id。 */
export function displayId(id: string, nodes: Pick<TopologyNode, "id" | "kind" | "label">[]): string {
  const n = nodes.find((x) => x.id === id);
  if (!n) return id;
  return kindOf(n) === "model" && n.label ? n.label : n.id;
}

/** SVG 文本不会自动截断：超过 max 个字符截尾加 … */
export function fitText(s: string, max = 22): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------- 层次布局 ----------
//
// 层 = 从 start 出发的最长路径深度，同层横排居中。自环不算边；环路（model ⇄ tool 这类）先用一次
// 从 start 起的 DFS 把「指回在途节点」的回头边剔掉再算最长路径，回头边照常画（起点在上边缘）。
// 有向无环时所有非自环边都朝下。

export interface NodeBox { x: number; y: number; w: number; h: number }
export interface Layout {
  W: number;
  H: number;
  pos: Record<string, NodeBox>;
  layer: Record<string, number>;
  orient: Orient;
}

/** 布局方向：v = 层次（层自上而下，道横向）；h = 横向 Flow（层自左而右，道纵向） */
export type Orient = "v" | "h";

export const NODE_W = 176;
export const NODE_H = 60;
/** 横向态节点框（契约图：136 × 48） */
export const NODE_W_H = 136;
export const NODE_H_H = 48;
const PAD_X = 16;
const PAD_Y = 16;
const LAYER_GAP = 64;
/** 横向态画布高（契约图 380） */
const FLOW_H = 380;

export function layerOf(nodes: TopologyNode[], edges: TopologyEdge[]): Record<string, number> {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.from === e.to || !idSet.has(e.from) || !idSet.has(e.to)) continue;
    const arr = adj.get(e.from) ?? [];
    if (!arr.includes(e.to)) arr.push(e.to);
    adj.set(e.from, arr);
  }
  // 1) 从 start 起 DFS 找回头边（指向在途节点的边），剔掉后剩下的是 DAG
  const state: Record<string, 0 | 1 | 2> = {};
  const back = new Set<string>();
  const dfs = (u: string) => {
    state[u] = 1;
    for (const v of adj.get(u) ?? []) {
      if (state[v] === 1) back.add(`${u}>${v}`);
      else if (!state[v]) dfs(v);
    }
    state[u] = 2;
  };
  if (idSet.has("start")) dfs("start");
  for (const id of ids) if (!state[id]) dfs(id);
  // 2) DAG 上的最长路径深度（记忆化）
  const incoming = new Map<string, string[]>();
  for (const [from, tos] of adj) {
    for (const to of tos) {
      if (back.has(`${from}>${to}`)) continue;
      const arr = incoming.get(to) ?? [];
      arr.push(from);
      incoming.set(to, arr);
    }
  }
  const layer: Record<string, number> = {};
  const depth = (id: string): number => {
    if (layer[id] != null) return layer[id];
    let d = 0;
    for (const from of incoming.get(id) ?? []) d = Math.max(d, depth(from) + 1);
    layer[id] = d;
    return d;
  };
  for (const id of ids) depth(id);
  return layer;
}

/** 道（横向位置）：start / agent 走主轴，模型一道，工具一道。只按图里出现的道分配横坐标：
 *  1 道居中；2 道 30% / 68%（契约图的取法）；3 道 18% / 50% / 82%。 */
export function laneOf(n: Pick<TopologyNode, "id"> & { kind?: TopologyNodeKind }): 0 | 1 | 2 {
  const k = kindOf(n);
  return k === "start" || k === "agent" ? 0 : k === "model" ? 1 : 2;
}
const LANE_CENTERS: Record<number, number[]> = { 1: [0.5], 2: [0.3, 0.68], 3: [0.18, 0.5, 0.82] };

/** 层次态（v）：层 = 纵向（自上而下），道 = 横向；横向态（h）：层 = 横向（自左而右等距铺满），道 = 纵向。
 *  两态用同一份 layer / lane，只换坐标轴。 */
export function layout(nodes: TopologyNode[], edges: TopologyEdge[], W = 760, orient: Orient = "v"): Layout {
  const layer = layerOf(nodes, edges);
  const lanesPresent = [...new Set(nodes.map(laneOf))].sort();
  const centers = LANE_CENTERS[lanesPresent.length] ?? [0.5];
  const laneFrac = (n: TopologyNode) => centers[lanesPresent.indexOf(laneOf(n))];
  // 按 (层, 道) 分格；同格多个节点绕道心排（count 降序，主流靠前）
  const cells = new Map<string, TopologyNode[]>();
  let maxL = 0;
  for (const n of nodes) {
    const l = layer[n.id] ?? 0;
    maxL = Math.max(maxL, l);
    const key = `${l}:${laneOf(n)}`;
    const arr = cells.get(key) ?? [];
    arr.push(n);
    cells.set(key, arr);
  }
  const pos: Record<string, NodeBox> = {};
  if (orient === "v") {
    for (const arr of cells.values()) {
      arr.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
      const l = layer[arr[0].id] ?? 0;
      // 同格 k 个：框宽随 k 缩（下限 96），总宽不超过一道的份额
      const share = (W - 2 * PAD_X) / lanesPresent.length;
      const w = arr.length === 1 ? NODE_W : Math.max(96, Math.min(NODE_W, Math.floor((share - 12 * (arr.length - 1)) / arr.length)));
      const total = arr.length * w + (arr.length - 1) * 12;
      const left = Math.min(Math.max(PAD_X, W * laneFrac(arr[0]) - total / 2), W - PAD_X - total);
      arr.forEach((n, i) => {
        pos[n.id] = {
          x: Math.round(left + i * (w + 12)),
          y: PAD_Y + l * (NODE_H + LAYER_GAP),
          w,
          h: NODE_H,
        };
      });
    }
    const H = PAD_Y * 2 + (maxL + 1) * NODE_H + maxL * LAYER_GAP;
    return { W, H, pos, layer, orient };
  }
  const H = FLOW_H;
  // 层多时框随层距缩窄（下限 96），相邻层之间至少留 44 给边和计数标签
  const step0 = maxL > 0 ? (W - 2 * PAD_X - NODE_W_H) / maxL : 0;
  const w = maxL > 0 ? Math.max(96, Math.min(NODE_W_H, Math.floor(step0 - 44))) : NODE_W_H;
  const step = maxL > 0 ? (W - 2 * PAD_X - w) / maxL : 0;
  for (const arr of cells.values()) {
    arr.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    const l = layer[arr[0].id] ?? 0;
    const total = arr.length * NODE_H_H + (arr.length - 1) * 12;
    const top = Math.min(Math.max(PAD_Y, H * laneFrac(arr[0]) - total / 2), H - PAD_Y - total);
    arr.forEach((n, i) => {
      pos[n.id] = {
        x: Math.round(PAD_X + l * step),
        y: Math.round(top + i * (NODE_H_H + 12)),
        w,
        h: NODE_H_H,
      };
    });
  }
  return { W, H, pos, layer, orient };
}

// ---------- 边几何 ----------

/** 箭头长度：终点回退这么多，箭头尖才落在节点边缘 */
export const ARROW = 9;

export interface EdgeGeom {
  d: string;
  /** 计数标签落点 */
  lx: number;
  ly: number;
  self: boolean;
}

/** 竖直边被中间层的节点框挡住（同一道上跨层）⇒ 往旁边鼓一个弧让开 */
function blockedV(x: number, y0: number, y1: number, blockers: NodeBox[]): boolean {
  const top = Math.min(y0, y1); const bottom = Math.max(y0, y1);
  return blockers.some((n) => x > n.x && x < n.x + n.w && n.y < bottom && n.y + n.h > top);
}
function blockedH(y: number, x0: number, x1: number, blockers: NodeBox[]): boolean {
  const left = Math.min(x0, x1); const right = Math.max(x0, x1);
  return blockers.some((n) => y > n.y && y < n.y + n.h && n.x < right && n.x + n.w > left);
}

/** 边几何。层次态：跨层边下出上进、中段水平；同层边侧出侧进。横向态：跨层边右出左进、
 *  中段竖直；同列边下出上进。同一直线上被别的节点挡住 ⇒ 往挡路节点重心反侧鼓弧。 */
export function edgeGeom(a: NodeBox, b: NodeBox, self: boolean, blockers: NodeBox[] = [], orient: Orient = "v"): EdgeGeom {
  if (self) {
    if (orient === "h") {
      // 自环：节点上方小弧
      const x = a.x + a.w / 2; const y = a.y;
      return {
        d: `M${x - 12},${y} C${x - 40},${y - 46} ${x + 40},${y - 46} ${x + 12},${y + 1 - ARROW}`,
        lx: x, ly: y - 38, self: true,
      };
    }
    // 自环：节点右侧小弧
    const x = a.x + a.w; const y = a.y + a.h / 2;
    return {
      d: `M${x},${y - 12} C${x + 46},${y - 40} ${x + 46},${y + 40} ${x + ARROW},${y + 12}`,
      lx: x + 40, ly: y, self: true,
    };
  }
  const vSep = b.y >= a.y + a.h || a.y >= b.y + b.h;
  const hSep = b.x >= a.x + a.w || a.x >= b.x + b.w;
  // 主轴优先：层次态先看纵向分离，横向态先看横向分离
  const vertical = orient === "v" ? vSep : (!hSep && vSep);
  let p0: [number, number]; let p3: [number, number]; let p1: [number, number]; let p2: [number, number];
  if (vertical) {
    const down = b.y >= a.y + a.h;
    p0 = [a.x + a.w / 2, down ? a.y + a.h : a.y];
    p3 = [b.x + b.w / 2, down ? b.y - ARROW : b.y + b.h + ARROW];
    const mid = (p0[1] + p3[1]) / 2;
    p1 = [p0[0], mid]; p2 = [p3[0], mid];
    if (Math.abs(p0[0] - p3[0]) < 1 && blockedV(p0[0], p0[1], p3[1], blockers)) {
      const cx = blockers.reduce((s, n) => s + n.x + n.w / 2, 0) / blockers.length;
      const bow = (a.w / 2 + 40) * (cx >= p0[0] ? -1 : 1);
      p1 = [p0[0] + bow * 1.4, p0[1] + (p3[1] - p0[1]) * 0.25];
      p2 = [p0[0] + bow * 1.4, p0[1] + (p3[1] - p0[1]) * 0.75];
    }
  } else {
    const right = b.x >= a.x;
    p0 = [right ? a.x + a.w : a.x, a.y + a.h / 2];
    p3 = [right ? b.x - ARROW : b.x + b.w + ARROW, b.y + b.h / 2];
    const mid = (p0[0] + p3[0]) / 2;
    p1 = [mid, p0[1]]; p2 = [mid, p3[1]];
    if (Math.abs(p0[1] - p3[1]) < 1 && blockedH(p0[1], p0[0], p3[0], blockers)) {
      const cy = blockers.reduce((s, n) => s + n.y + n.h / 2, 0) / blockers.length;
      const bow = (a.h / 2 + 40) * (cy >= p0[1] ? -1 : 1);
      p1 = [p0[0] + (p3[0] - p0[0]) * 0.25, p0[1] + bow * 1.4];
      p2 = [p0[0] + (p3[0] - p0[0]) * 0.75, p0[1] + bow * 1.4];
    }
  }
  const lx = (p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]) / 8;
  const ly = (p0[1] + 3 * p1[1] + 3 * p2[1] + p3[1]) / 8;
  return {
    d: `M${p0[0]},${p0[1]} C${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`,
    // 标签让开线身：竖向边右移，横向边上移
    lx: vertical ? lx + 22 : lx,
    ly: vertical ? ly : ly - 15,
    self: false,
  };
}

/** 边粗细三档（随 count 相对最大值）：≥ 2/3 ⇒ 3.5，≥ 1/3 ⇒ 2.5，其余 1.5 */
export function strokeTier(count: number, max: number): 1.5 | 2.5 | 3.5 {
  if (max <= 0) return 1.5;
  const r = count / max;
  return r >= 2 / 3 ? 3.5 : r >= 1 / 3 ? 2.5 : 1.5;
}

/** 某节点的进入 / 出去边（自环两边都算） */
export function edgesOf(edges: TopologyEdge[], id: string): { ins: TopologyEdge[]; outs: TopologyEdge[] } {
  return {
    ins: edges.filter((e) => e.to === id),
    outs: edges.filter((e) => e.from === id),
  };
}

// ---------- 会话级：节点详情「最近会话」+ 「按会话」高亮 ----------

/** 界面最多列几条（后端契约本就 ≤ 10；这里再钉一次，旧后端多给也不撑破右栏） */
export const RECENT_SESSIONS_LIMIT = 10;

/** 节点详情要列的最近会话（后端已按 at 倒序，这里只截断，不重排） */
export function recentSessionsOf(node: Pick<TopologyNode, "recent_sessions">): TopologyRecentSession[] {
  return (node.recent_sessions ?? []).slice(0, RECENT_SESSIONS_LIMIT);
}

/** 「按会话」列表要列的会话路径（同上：只截断） */
export function sessionPathsOf(t: Pick<AgentTopologyEvent, "session_paths">): TopologySessionPath[] {
  return (t.session_paths ?? []).slice(0, RECENT_SESSIONS_LIMIT);
}

/** 会话行的深链：运行详情三栏 trace 视图里预选这条会话（router `run` 的 ?session=）。
 *  路径卡的数据是线上 span 聚合、不属于某个 run，run_key 取 Agent 详情 ① 现状「最近一次评估」那条
 *  （agent_status.last_run.run_key）；没有 ⇒ null（行不可点，title 说明）。 */
export function sessionTraceHref(runKey: string | null | undefined, sessionId: string): string | null {
  if (!runKey) return null;
  return `#/run/${encodeURIComponent(runKey)}?session=${encodeURIComponent(sessionId)}`;
}

/** 会话时刻：ISO → "MM-DD HH:mm"（UTC，与 ① 现状其它时刻同一格式）；缺 ⇒ "—" */
export const fmtAt = fmtStamp;

export interface PathHighlight {
  nodes: Set<string>;
  /** 边键 `${from}>${to}`（与 Graph 的 key 同式） */
  edges: Set<string>;
}

/** 一条会话路径 → 要点亮的节点与边集合（相邻两节点成一条边；自环也算） */
export function pathHighlight(path: string[]): PathHighlight {
  const nodes = new Set(path);
  const edges = new Set<string>();
  for (let i = 1; i < path.length; i++) edges.add(`${path[i - 1]}>${path[i]}`);
  return { nodes, edges };
}
