// ① 现状「路径」卡（ADR-0017 D4，用户选变体 A「卡内展开」）：数据 = agent_topology（单 Agent，
// 近 lookback_days 天线上会话的 span 聚合）。默认折叠成一句（N 节点 · 最慢节点 · 最常路径占比），
// 点开在原位撑开：左 2/3 有向图（SVG），右 1/3 节点详情（点节点切换；没选时列节点表）。
// 图有两种布局（卡头「层次 / 横向」切换，ADR-0017 待定点 4 于 2026-09-07 定为一期做）：
// 层次 = 层自上而下（默认）；横向 Flow = 同一份 nodes/edges 换坐标轴，层自左而右。
// 0 会话 / 未配置 span 源 / 未上报任何 span ⇒ 卡内一行原因，不画空图。
// **只需要 name**：agent_topology 自己打，agent_status 只借来拿 last_run.run_key 给「最近会话」行
// 做深链（没拿到 ⇒ 那些行不可点）。故 status 未到时本卡照常渲染（骨架 + 一行「在等什么」）。
// 评估流量三档（后端 include_eval）：默认省略 = 自动，真实为零退到评估会话（chip「含评估流量」）；
// 卡头 chip 可点切到 include_eval:true（两类一起）或切回；切换 = 换 react-query key 重新请求。
// 会话级（批 topology-sessions，用户 2026-09-07 现网反馈）：节点详情「最近会话」列后端 recent_sessions
// （≤ 10 行，每行链到运行详情 `#/run/<run_key>?session=<sid>`；run_key = ① 现状「最近一次评估」那条
// agent_status.last_run.run_key —— 路径卡数据是线上 span 聚合、不属于某个 run；没有 ⇒ 行不可点）；
// 卡头「按会话」chip 打开右栏 session_paths 列表，点一条 ⇒ 图里该会话走过的节点与边点亮、其余压暗
// （只改 class，不改布局）= 单会话级拓扑。
// 版面契约 .scratch/adr0017-designs/topology/contract-variant-a.html；派生与几何在 topology.ts。
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { apiOne, type ApiEvent } from "../../../../lib/api";
import type { AgentTopologyEvent, TopologyEdge, TopologyNode, TopologySessionPath } from "../../../../lib/apiTypes";
import { navigate } from "../../../../router";
import { shortSessionId } from "../../../plan/reportRows";
// 主路占比 = 观测比率档（分母是会话数）⇒ lib/scoring.fmtPct。此前经 topology.fmtShare
// 这个别名取同一个函数，同概念双名已删。
import { fmtPct } from "../../../../lib/scoring";
import type { AgentStatusEvent } from "../../home/types";
import { agentTabHash } from "./tabs";
import {
  ARROW, displayId, edgeGeom, edgesOf, fitText, fmtAt, fmtS, kindOf, layout, pathHighlight,
  recentSessionsOf, scopeChip, sessionPathsOf, sessionTraceHref, strokeTier, summarize, unavailableKind,
  type NodeBox, type Orient, type PathHighlight,
} from "./topology";
import "./topology.css";

const GRAPH_W = 760;

export default function TopologyCard({ name }: { name: string }) {
  // undefined = 自动（请求里不带 include_eval）；true = 含评估流量
  const [includeEval, setIncludeEval] = useState<true | undefined>(undefined);
  const q = useQuery({
    queryKey: ["agent_topology", name, includeEval ?? "auto"],
    queryFn: () => apiOne<AgentTopologyEvent>(
      { action: "agent_topology", agent_name: name, ...(includeEval ? { include_eval: true } : {}) },
      "agent_topology"),
  });
  // 会话行深链的 run_key 来源：① 现状「最近一次评估」那条（agent_status.last_run.run_key）。
  // 与 AgentDetailPage 同 queryKey（["agent-status", name]）—— 同一份缓存，不多打一次请求。
  const statusQ = useQuery({
    queryKey: ["agent-status", name],
    queryFn: () => apiOne<AgentStatusEvent & ApiEvent>({ action: "agent_status", agent_name: name }, "agent_status"),
  });
  const runKey = statusQ.data?.last_run?.run_key ?? null;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [orient, setOrient] = useState<Orient>("v");
  // 「按会话」：右栏列 session_paths；hlSid = 点亮的那条会话（null = 没点）
  const [bySession, setBySession] = useState(false);
  const [hlSid, setHlSid] = useState<string | null>(null);
  const t = q.data;
  const hasGraph = !!t && !t.unavailable_reason && t.nodes.length > 0;
  const paths = t ? sessionPathsOf(t) : [];
  const hlPath = bySession && hlSid ? paths.find((p) => p.session_id === hlSid) ?? null : null;
  const hl = hlPath ? pathHighlight(hlPath.path) : null;

  const pickNode = (id: string) => {
    // 点节点回到节点详情：「按会话」态与高亮一起撤
    setBySession(false);
    setHlSid(null);
    setSelected((cur) => (cur === id ? null : id));
  };
  const toggleBySession = () => {
    setBySession((v) => {
      if (v) setHlSid(null);
      else setSelected(null);
      return !v;
    });
  };

  return (
    <section className="card" data-testid="agent-topology">
      <div className="card-head">
        <span className="card-title">路径</span>
        {t && (
          <span className="card-sub" data-testid="agent-topology-sub"
                title={`与上方会话量同源：同一 span 源（${t.sessions_source || "—"}）· ${t.window.from} → ${t.window.to}`}>
            近 {t.lookback_days} 天 · <span className="topo-num">{t.sessions}</span> 会话
          </span>
        )}
        {t && <ScopeChipView t={t} onPick={setIncludeEval} />}
        <span className="spacer" />
        {hasGraph && open && (
          <>
            <div className="topo-seg" role="group" aria-label="布局" data-testid="agent-topology-orient">
              <button type="button" aria-pressed={orient === "v"} data-testid="agent-topology-orient-v"
                      onClick={() => setOrient("v")}>层次</button>
              <button type="button" aria-pressed={orient === "h"} data-testid="agent-topology-orient-h"
                      onClick={() => setOrient("h")}>横向</button>
            </div>
            <div className="topo-seg" role="group" aria-label="范围" data-testid="agent-topology-scope-seg">
              <button type="button" aria-pressed={bySession} data-testid="agent-topology-by-session"
                      title={`右栏列最近 ${paths.length} 条会话；点一条在图里只亮它走过的路`}
                      onClick={toggleBySession}>按会话</button>
            </div>
            <button type="button" className="btn-link" data-testid="agent-topology-collapse" onClick={() => setOpen(false)}>
              收起
            </button>
          </>
        )}
      </div>
      <div className="card-body">
        {q.isError ? (
          <p className="agents-error" style={{ margin: 0 }} data-testid="agent-topology-error">
            {q.error instanceof Error ? q.error.message : String(q.error)}
          </p>
        ) : !t ? (
          // 骨架不只是一根条：现网实测 agent_topology 冷调 3.3s（Logs Insights 查询），
          // 光有骨架条时用户读不出在等什么。这一行说清等的是哪份数据（近 7 天 = 请求不带
          // lookback_days ⇒ 后端 topology.DEFAULT_LOOKBACK_DAYS）；数据一到整块换成折叠一句。
          <div className="path-skeleton" data-testid="agent-topology-skeleton">
            <span className="skeleton-bar" style={{ width: 320 }} aria-hidden="true" />
            <span className="card-sub" style={{ marginLeft: "var(--sp-3)" }} data-testid="agent-topology-pending">
              正在聚合近 7 天线上会话的 span…
            </span>
          </div>
        ) : t.unavailable_reason || t.nodes.length === 0 ? (
          <Unavailable name={name} t={t} />
        ) : (
          <>
            <SummaryLine t={t} open={open} onToggle={() => setOpen((v) => !v)} />
            {open && (
              <div className="topo-wrap" data-testid="agent-topology-expanded">
                <div className="topo-graph">
                  <Graph nodes={t.nodes} edges={t.edges} selected={selected} orient={orient} hl={hl}
                         onPick={pickNode} />
                </div>
                <div className="topo-detail" data-testid="agent-topology-detail">
                  {bySession ? (
                    <SessionPathList paths={paths} nodes={t.nodes} active={hlSid} runKey={runKey}
                                     onPick={(sid) => setHlSid((cur) => (cur === sid ? null : sid))} />
                  ) : selected && t.nodes.some((n) => n.id === selected) ? (
                    <NodeDetail node={t.nodes.find((n) => n.id === selected)!} nodes={t.nodes} edges={t.edges}
                                runKey={runKey} onClose={() => setSelected(null)} />
                  ) : (
                    <NodeTable nodes={t.nodes} onPick={setSelected} />
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ---------- 卡头「评估流量」chip ----------
// 文案与可点性由 topology.scopeChip 决定；这里只摆：可点 ⇒ button.chip（aria-pressed = 当前含评估），
// 不可点（eval_only）⇒ span.chip.static。计数走 mono。
function ScopeChipView({ t, onPick }: { t: AgentTopologyEvent; onPick: (v: true | undefined) => void }) {
  const c = scopeChip(t);
  if (!c) return null;
  const label = c.label.split(/(\d+)/).map((part, i) => (/^\d+$/.test(part) ? <span key={i} className="n">{part}</span> : part));
  if (c.next === null) {
    return (
      <span className="chip topo-scope static" data-testid="agent-topology-scope" data-scope={c.scope} title={c.title}>
        {label}
      </span>
    );
  }
  return (
    <button type="button" className="chip topo-scope" data-testid="agent-topology-scope" data-scope={c.scope}
            aria-pressed={c.scope === "live+eval"} title={c.title} onClick={() => onPick(c.next as true | undefined)}>
      {label}
    </button>
  );
}

// ---------- 不可用一行 ----------
// 原话照显示（近 N 天没有会话 / 近 N 天 Agent 未上报任何 span（含评估流量）/ Logs Insights 查询失败：… /
// 行数达上限）；只有「未配置 span 源」这一句配「去 ④ 配置 →」；只有「未上报任何 span」这一句下面多一行
// 对当下状态的判断（回归测试的调用也没留 trace ⇒ 没接 OTel 上报）。nodes 空但 reason 也空（不该发生）⇒ 写「—」。
function Unavailable({ name, t }: { name: string; t: AgentTopologyEvent }) {
  const kind = unavailableKind(t.unavailable_reason);
  return (
    <div className="path-unavail-wrap">
      <div className="path-unavail" data-testid="agent-topology-unavailable" data-kind={kind}
           title={t.sessions_source ? `span 源：${t.sessions_source}` : undefined}>
        <svg className="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M5 8h6" /></svg>
        {kind === "no_span_source" ? (
          <>
            <span>未配置 span 源</span>
            <button type="button" className="btn-link" data-testid="agent-topology-goto-config"
                    onClick={() => navigate(agentTabHash(name, "config"))}>
              去 ④ 配置 →
            </button>
          </>
        ) : (
          <span data-testid="agent-topology-unavailable-reason">{t.unavailable_reason || "—"}</span>
        )}
      </div>
      {kind === "no_spans" && (
        <div className="path-unavail-note" data-testid="agent-topology-no-spans-note">
          回归测试的调用也没留下 trace，这个 Agent 没接 OTel 上报
        </div>
      )}
    </div>
  );
}

// ---------- 折叠一句 ----------
function SummaryLine({ t, open, onToggle }: { t: AgentTopologyEvent; open: boolean; onToggle: () => void }) {
  const s = summarize(t);
  return (
    <button type="button" className="path-line" aria-expanded={open} onClick={onToggle}
            data-testid="agent-topology-summary" aria-controls="agent-topology-graph">
      <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="2" width="4" height="3.5" rx="1" /><rect x="10.5" y="2" width="4" height="3.5" rx="1" />
        <rect x="6" y="10.5" width="4" height="3.5" rx="1" /><path d="M3.5 5.5v2.5h9V5.5M8 8v2.5" />
      </svg>
      <span>
        <span className="topo-num" data-testid="agent-topology-node-count">{s.nodeCount}</span> 个节点
        <span className="topo-sep">·</span>
        最慢 {s.slowest ? (
          <span data-testid="agent-topology-slowest" title={s.slowest.id}>
            <span className="topo-nid">{displayId(s.slowest.id, t.nodes)}</span> <span className="topo-num">{fmtS(s.slowest.avg_s)}</span>
          </span>
        ) : <span data-testid="agent-topology-slowest">—</span>}
        <span className="topo-sep">·</span>
        最常路径 {s.topPath ? (
          <span data-testid="agent-topology-top-path" title={s.topPath.nodes.join(" → ")}>
            <Chain ids={s.topPath.nodes.map((id) => displayId(id, t.nodes))} /> <span className="topo-num">{fmtPct(s.topPath.share)}</span>
          </span>
        ) : <span data-testid="agent-topology-top-path">—</span>}
      </span>
      <span className="open">{open ? "收起" : "打开"}</span>
      <svg className="ico chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
  );
}

function Chain({ ids }: { ids: string[] }) {
  return (
    <span className="topo-chain">
      {ids.map((id, i) => (
        <span key={`${id}:${i}`}>
          {i > 0 && <span className="arr">→</span>}
          {id}
        </span>
      ))}
    </span>
  );
}

// ---------- 层次布局有向图 ----------
// hl 非空 = 「按会话」点亮了一条路：路上的节点 / 边加 .path，其余加 .dim；hl 为空两种 class 都不加。
function Graph({ nodes, edges, selected, orient, hl, onPick }: {
  nodes: TopologyNode[]; edges: TopologyEdge[]; selected: string | null; orient: Orient;
  hl: PathHighlight | null; onPick: (id: string) => void;
}) {
  // layout() 每次渲染都重跑（选中节点 / 高亮会话 / 收起展开都触发一次）而它只依赖
  // nodes/edges/orient ⇒ 套一层 useMemo。`boxes` 同理：每条边喂 edgeGeom 的
  // 「除自己两端之外的全部节点框」原来是逐边重建一份数组（O(E×N) 次 pos 查表 + 分配），
  // 现在框数组只建一次，逐边只剩一次 filter。收益毫秒级，形态零变化。
  const lay = useMemo(() => layout(nodes, edges, GRAPH_W, orient), [nodes, edges, orient]);
  const boxes = useMemo(
    () => nodes.map((n) => ({ id: n.id, box: lay.pos[n.id] })).filter((b): b is { id: string; box: NodeBox } => !!b.box),
    [nodes, lay],
  );
  const maxC = useMemo(() => edges.reduce((m, e) => Math.max(m, e.count), 0), [edges]);
  const tall = orient === "v";
  const hlCls = (on: boolean) => (hl ? (on ? " path" : " dim") : "");
  return (
    <svg className="topo-svg" id="agent-topology-graph" viewBox={`0 0 ${lay.W} ${lay.H}`} width={lay.W} height={lay.H}
         role="img" aria-label={`路径图 · ${nodes.length} 个节点 · ${edges.length} 条边`} data-testid="agent-topology-svg"
         data-orient={orient} data-highlight={hl ? "session" : undefined}>
      <defs>
        <marker id="topo-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth={ARROW} markerHeight={ARROW}
                markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path className="topo-arrow" d="M0 0 10 5 0 10z" />
        </marker>
        <marker id="topo-arr-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth={ARROW} markerHeight={ARROW}
                markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path className="topo-arrow hi" d="M0 0 10 5 0 10z" />
        </marker>
        <marker id="topo-arr-path" viewBox="0 0 10 10" refX="9" refY="5" markerWidth={ARROW} markerHeight={ARROW}
                markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path className="topo-arrow path" d="M0 0 10 5 0 10z" />
        </marker>
      </defs>
      {edges.map((e) => {
        const a = lay.pos[e.from]; const b = lay.pos[e.to];
        if (!a || !b) return null;
        const blockers = boxes.filter((n) => n.id !== e.from && n.id !== e.to).map((n) => n.box);
        const g = edgeGeom(a, b, e.from === e.to, blockers, orient);
        const hi = selected != null && (e.from === selected || e.to === selected);
        const onPath = !!hl?.edges.has(`${e.from}>${e.to}`);
        const lw = e.count >= 10 ? 30 : 24;
        const marker = onPath ? "topo-arr-path" : hi ? "topo-arr-hi" : "topo-arr";
        return (
          <g key={`${e.from}>${e.to}`} data-testid="agent-topology-edge" data-from={e.from} data-to={e.to}
             className={hlCls(onPath).trim() || undefined}>
            <path className={`topo-e${hi ? " hi" : ""}${hlCls(onPath)}`} d={g.d} strokeWidth={strokeTier(e.count, maxC)}
                  markerEnd={`url(#${marker})`}>
              <title>{`${e.from} → ${e.to} · ${e.count} 次${g.self ? " · 自环" : ""}`}</title>
            </path>
            <g className={`topo-elab${hi ? " hi" : ""}${hlCls(onPath)}`} transform={`translate(${g.lx.toFixed(1)},${g.ly.toFixed(1)})`}>
              <rect x={-lw / 2} y={-9} width={lw} height={18} rx={6} />
              <text>{e.count}</text>
            </g>
          </g>
        );
      })}
      {nodes.map((n) => {
        const p = lay.pos[n.id];
        if (!p) return null;
        const sel = n.id === selected;
        const err = n.errors > 0;
        // 右上角类型标只在放得下时画（窄框 / 长名字先让名字）；类型仍在 title 与详情栏
        const name = displayId(n.id, nodes);
        const showKind = p.w >= 130 && name.length <= Math.floor((p.w - 24 - 40) / 7.2);
        const maxChars = Math.floor((p.w - 24 - (showKind ? 40 : 0)) / 7.2);
        const title = `${n.id} · ${kindOf(n)} · ${n.count} 次 · 平均 ${fmtS(n.avg_s)} · P95 ${fmtS(n.p95_s)} · 报错 ${n.errors}`;
        return (
          <g key={n.id} className={`topo-n${sel ? " sel" : ""}${err ? " err" : ""}${hlCls(!!hl?.nodes.has(n.id))}`}
             role="button" tabIndex={0}
             aria-pressed={sel} data-testid="agent-topology-node" data-node={n.id}
             transform={`translate(${p.x},${p.y})`}
             onClick={() => onPick(n.id)}
             onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onPick(n.id); } }}>
            <title>{title}</title>
            <rect width={p.w} height={p.h} rx={8} />
            <text className="t1" x={12} y={tall ? 20 : 15}>{fitText(name, maxChars)}</text>
            {showKind && <text className="kind" x={p.w - 10} y={tall ? 20 : 15}>{kindOf(n)}</text>}
            <text className="t2" x={12} y={tall ? 41 : 33}>
              {n.count} 次{tall && <> · 平均 {fmtS(n.avg_s)}</>}
              {err && <tspan className="errs"> · 报错 {n.errors}</tspan>}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------- 右栏：没选节点时列节点表 ----------
function NodeTable({ nodes, onPick }: { nodes: TopologyNode[]; onPick: (id: string) => void }) {
  const rows = [...nodes].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  return (
    <>
      <div className="topo-nd-sec first">节点<span className="n">{nodes.length}</span></div>
      <table className="u-table topo-nd-table" data-testid="agent-topology-node-table">
        <colgroup><col /><col style={{ width: "4.5em" }} /><col style={{ width: "5.5em" }} /><col style={{ width: "4.5em" }} /></colgroup>
        <thead><tr><th>节点</th><th className="num">次数</th><th className="num">平均</th><th className="num">报错</th></tr></thead>
        <tbody>
          {rows.map((n) => (
            <tr key={n.id} className="pick" tabIndex={0} data-testid="agent-topology-node-row" data-node={n.id}
                onClick={() => onPick(n.id)}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onPick(n.id); } }}>
              <td><span className="topo-nid" title={n.id}>{displayId(n.id, nodes)}</span></td>
              <td className="num">{n.count}</td>
              <td className="num">{fmtS(n.avg_s)}</td>
              <td className={`num${n.errors > 0 ? " bad" : ""}`}>{n.errors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ---------- 右栏：节点详情 ----------
function NodeDetail({ node, nodes, edges, runKey, onClose }: {
  node: TopologyNode; nodes: TopologyNode[]; edges: TopologyEdge[]; runKey: string | null; onClose: () => void;
}) {
  const { ins, outs } = edgesOf(edges, node.id);
  const recent = recentSessionsOf(node);
  return (
    <div data-testid="agent-topology-node-detail" data-node={node.id}>
      <div className="topo-nd-head">
        <span className="topo-nid" data-testid="agent-topology-detail-id" title={node.id}>{displayId(node.id, nodes)}</span>
        <span className="chip">{kindOf(node)}</span>
        <button type="button" className="btn ghost mini close" aria-label="取消选中" data-testid="agent-topology-deselect"
                onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="topo-nd-stats" data-testid="agent-topology-detail-stats">
        <div><span className="k">次数</span><span className="v" data-testid="agent-topology-detail-count">{node.count}</span></div>
        <div><span className="k">平均</span><span className="v" data-testid="agent-topology-detail-avg">{fmtS(node.avg_s)}</span></div>
        <div><span className="k">P95</span><span className="v" data-testid="agent-topology-detail-p95">{fmtS(node.p95_s)}</span></div>
        <div>
          <span className="k">报错</span>
          <span className={`v${node.errors > 0 ? " bad" : ""}`} data-testid="agent-topology-detail-errors">{node.errors}</span>
        </div>
      </div>
      <div className="topo-nd-sec">进入边<span className="n" data-testid="agent-topology-detail-ins">{ins.length}</span></div>
      <EdgeTable list={ins} dir="in" nodes={nodes} />
      <div className="topo-nd-sec">出去边<span className="n" data-testid="agent-topology-detail-outs">{outs.length}</span></div>
      <EdgeTable list={outs} dir="out" nodes={nodes} />
      <div className="topo-nd-sec" data-testid="agent-topology-detail-sessions">
        最近会话<span className="n">{recent.length}</span>
      </div>
      {recent.length === 0 ? <div className="topo-nd-empty">—</div> : (
        <ul className="topo-sess" data-testid="agent-topology-detail-sessions-list">
          {recent.map((r) => {
            const href = sessionTraceHref(runKey, r.session_id);
            const body = (
              <>
                <span className="topo-nid sid">{shortSessionId(r.session_id)}</span>
                <span className="at">{fmtAt(r.at)}</span>
                <span className="num">{fmtS(r.duration_s)}</span>
                {r.failed ? <span className="badge bad">报错</span> : <span className="ok" />}
              </>
            );
            return (
              <li key={r.session_id}>
                {href ? (
                  <a className="topo-sess-row" href={href} data-testid="agent-topology-session-row" data-sid={r.session_id}
                     title={`${r.session_id} · 在运行详情的 trace 里打开这条会话`}>
                    {body}
                  </a>
                ) : (
                  <span className="topo-sess-row nolink" data-testid="agent-topology-session-row" data-sid={r.session_id}
                        title="这条会话没进过线上评估 run">
                    {body}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------- 右栏：「按会话」列表（单会话级拓扑） ----------
// 一行 = 短 id · 时刻 · N 步 · 报错节点数；点一条 ⇒ 图里只亮它走过的路（aria-pressed），再点取消。
function SessionPathList({ paths, nodes, active, runKey, onPick }: {
  paths: TopologySessionPath[]; nodes: TopologyNode[]; active: string | null; runKey: string | null;
  onPick: (sid: string) => void;
}) {
  return (
    <>
      <div className="topo-nd-sec first">会话<span className="n">{paths.length}</span></div>
      {paths.length === 0 ? <div className="topo-nd-empty">—</div> : (
        <ul className="topo-sess" data-testid="agent-topology-session-paths">
          {paths.map((p) => {
            const on = p.session_id === active;
            const href = sessionTraceHref(runKey, p.session_id);
            return (
              <li key={p.session_id}>
                <button type="button" className="topo-sess-row" aria-pressed={on}
                        data-testid="agent-topology-session-path" data-sid={p.session_id}
                        title={`${p.session_id} · ${p.path.map((id) => displayId(id, nodes)).join(" → ")}${href ? "" : " · 这条会话没进过线上评估 run"}`}
                        onClick={() => onPick(p.session_id)}>
                  <span className="topo-nid sid">{shortSessionId(p.session_id)}</span>
                  <span className="at">{fmtAt(p.at)}</span>
                  <span className="num">{p.path.length - 1} 步</span>
                  {p.failed_nodes > 0 ? <span className="badge bad">报错 {p.failed_nodes}</span> : <span className="ok" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function EdgeTable({ list, dir, nodes }: { list: TopologyEdge[]; dir: "in" | "out"; nodes: TopologyNode[] }) {
  if (list.length === 0) return <div className="topo-nd-empty">—</div>;
  return (
    <table className="u-table topo-nd-table">
      <colgroup><col /><col style={{ width: "4.5em" }} /></colgroup>
      <tbody>
        {list.map((e) => {
          const other = dir === "in" ? e.from : e.to;
          return (
            <tr key={`${e.from}>${e.to}`}>
              <td>
                <span className="dir">{dir === "in" ? "←" : "→"}</span>{" "}
                <span className="topo-nid" title={other}>{displayId(other, nodes)}</span>
                {e.from === e.to && <span className="topo-nd-empty"> · 自环</span>}
              </td>
              <td className="num">{e.count}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
