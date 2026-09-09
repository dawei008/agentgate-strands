// 首页 = Agent 总览（观测视角，ADR-0016「舰队级」；版面契约
// .scratch/adr0016-home/variant-b3-observe.html）。回答「我有哪些 Agent、它们现在
// 在线上跑得怎样、哪个要我动手」：
//   hero「舰队一眼」→ 待处理动作卡 → 每个 Agent 一张卡（观测五个数为主体，
//   评估 / 优化退成卡底两行）。「跨 Agent 共性问题」本批不做（不放假占位）。
// 数据源：discover（有哪些 Agent）+ fleet_status（一次拿全：agents[] / fleet / todo）
// + list_recent_runs（评估行的 M/K、失败原因、进行中）+ 最近一次 run 所属计划的
// list_plan_runs（优化行的处方计数）。
// 单 Agent 规则：只有 1 个 Agent 时首页直接落到该 Agent 详情，不渲染列表。
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { apiOne } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { navigate } from "../../router";
import PageHeader from "../../components/layout/PageHeader";
import type { PlanRunsEvent } from "../plan/types";
import type { AgentsRowsEvent, RecentRunsEvent, RunSummary } from "./types";
import type { FleetStatusEvent } from "./home/types";
import {
  agentSeverity, fmtStamp, proposalCounts, SORT_KEYS, sortRows, type SortKey,
} from "./home/derive";
import FleetHero from "./home/FleetHero";
import Freshness from "./home/Freshness";
import TodoCards from "./home/TodoCards";
import AgentCard from "./home/AgentCard";
import { agentTabHash } from "./detail/hub/tabs";
import "./agents.css";

// 与工作台同参：query key + limit 完全一致，TanStack 才会共享缓存不重复打
const RECENT_RUNS_LIMIT = 20;
const enc = encodeURIComponent;

export default function AgentsPage() {
  const { authed } = useAuth();
  const queryClient = useQueryClient();
  const [rescanning, setRescanning] = useState(false);
  const [rescanError, setRescanError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("priority");

  const query = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiOne<AgentsRowsEvent>({ action: "discover" }, "agents"),
  });
  const agents = query.data?.agents;

  // 单 Agent 规则：直接落详情
  const single = agents && agents.length === 1 ? agents[0].agent_name : null;
  useEffect(() => {
    if (single) navigate(`#/agent/${enc(single)}`);
  }, [single]);

  const fleet = useQuery({
    queryKey: ["fleet-status"],
    queryFn: () => apiOne<FleetStatusEvent>({ action: "fleet_status" }, "fleet_status"),
    enabled: Boolean(agents && agents.length > 1),
  });
  const runsQuery = useQuery({
    queryKey: ["recent-runs"],
    queryFn: () =>
      apiOne<RecentRunsEvent>({ action: "list_recent_runs", limit: RECENT_RUNS_LIMIT }, "recent_runs"),
    enabled: Boolean(agents && agents.length > 1),
  });

  const statusByName = useMemo(() => {
    const m = new Map<string, FleetStatusEvent["agents"][number]>();
    for (const s of fleet.data?.agents ?? []) m.set(s.agent_name, s);
    return m;
  }, [fleet.data]);

  const runs = runsQuery.data?.runs ?? [];
  const runByKey = useMemo(() => new Map(runs.map((r) => [r.run_key, r] as const)), [runs]);
  const runningByAgent = useMemo(() => {
    const m = new Map<string, RunSummary>();
    for (const r of runs) if (r.status === "running" && !m.has(r.agent_name)) m.set(r.agent_name, r);
    return m;
  }, [runs]);

  // 优化行：最近一次 run 所属计划的处方计数 —— 每个不同 plan_id 一条 list_plan_runs
  // （key 与计划详情页同款，共享缓存）
  const planIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of fleet.data?.agents ?? []) if (s.last_run?.plan_id) ids.add(s.last_run.plan_id);
    return [...ids].sort();
  }, [fleet.data]);
  const planRunQueries = useQueries({
    queries: planIds.map((id) => ({
      queryKey: ["plan_runs", id],
      queryFn: () => apiOne<PlanRunsEvent>({ action: "list_plan_runs", plan_id: id }, "plan_runs"),
    })),
  });
  // 不 memo：依赖数组长度随计划数变（React 会告警），而这张 Map 每次现建只是几次 set
  const planRunsById = new Map<string, PlanRunsEvent["runs"]>();
  planIds.forEach((id, i) => {
    const d = planRunQueries[i]?.data;
    if (d) planRunsById.set(id, d.runs ?? []);
  });

  const rows = useMemo(() => {
    if (!agents) return [];
    const list = agents.map((agent) => {
      const status = statusByName.get(agent.agent_name);
      const lastRow = status?.last_run ? runByKey.get(status.last_run.run_key) : undefined;
      const severity = agentSeverity(status, lastRow);
      return {
        agent, status, lastRow, severity,
        name: agent.agent_name,
        alerts: status?.alerts.length ?? 0,
        sessions: status?.metrics.sessions.value ?? null,
        cost: status?.metrics.agent_cost_usd.value ?? null,
        runningRow: runningByAgent.get(agent.agent_name),
      };
    });
    return sortRows(list, sort);
  }, [agents, statusByName, runByKey, runningByAgent, sort]);

  async function rescan() {
    setRescanning(true);
    setRescanError(null);
    try {
      const fresh = await apiOne<AgentsRowsEvent>({ action: "discover", refresh: true }, "agents");
      queryClient.setQueryData(["agents"], fresh);
      // fleet_status 有 5 分钟进程内缓存：重新扫描要 refresh:true 绕过，否则拿回的还是 cached:true 那份
      if (fresh.agents.length > 1) {
        const status = await apiOne<FleetStatusEvent>({ action: "fleet_status", refresh: true }, "fleet_status");
        queryClient.setQueryData(["fleet-status"], status);
      }
    } catch (e) {
      setRescanError(e instanceof Error ? e.message : String(e));
    } finally {
      setRescanning(false);
    }
  }

  const data = query.data;
  const fleetData = fleet.data;
  const fleetError = fleet.isError
    ? (fleet.error instanceof Error ? fleet.error.message : String(fleet.error))
    : null;
  // 页头右侧时间窗：fleet 的 generated_at 往前推 window_hours
  const windowText = fleetData ? (() => {
    const end = Date.parse(fleetData.generated_at);
    if (Number.isNaN(end)) return `近 ${fleetData.window_hours}h`;
    const start = new Date(end - fleetData.window_hours * 3_600_000).toISOString();
    return `近 ${fleetData.window_hours}h · ${fmtStamp(start)} → ${fmtStamp(fleetData.generated_at)}`
      + (fleetData.cached ? " · 缓存" : "");
  })() : null;

  return (
    <section data-testid="page-agents" className="page-home">
      <PageHeader
        title="Agent"
        meta={windowText ? (
          <span className="page-window" data-testid="home-window">
            <span className="live" aria-hidden="true" />{windowText}
          </span>
        ) : null}
        actions={
          <button
            className="btn ghost"
            data-testid="agents-rescan"
            disabled={!authed || rescanning}
            title={!authed ? "请先登录" : undefined}
            onClick={rescan}
          >
            {rescanning ? "扫描中…" : "重新扫描"}
          </button>
        }
      />

      {/* 两个来源的「数据多旧」分开标（舰队五数 computed_at/cache_age_s；Agent 目录 refreshed_at，
          超 24h 窗口才出徽章）——原「缓存于 …」一句混了两处时刻，见 home/Freshness.tsx */}
      <Freshness discover={data} fleet={fleetData} />
      {rescanError && (
        <p className="agents-error" data-testid="agents-rescan-error">{rescanError}</p>
      )}
      {query.isError && (
        <p className="agents-error" data-testid="agents-load-error">
          {query.error instanceof Error ? query.error.message : String(query.error)}
        </p>
      )}

      {query.isLoading ? (
        <HomeSkeleton />
      ) : agents && agents.length === 0 ? (
        <div className="agents-empty" data-testid="agents-empty">
          <p>尚未接入 Agent</p>
          <button
            className="btn"
            data-testid="agents-empty-rescan"
            disabled={!authed || rescanning}
            title={!authed ? "请先登录" : undefined}
            onClick={rescan}
          >
            {rescanning ? "扫描中…" : "扫描 Agent"}
          </button>
        </div>
      ) : single ? (
        // 单 Agent：正在跳详情，不渲染列表
        <p className="agents-cache-note" data-testid="agents-single-redirect">→ {single}</p>
      ) : agents ? (
        <>
          {fleetData ? <FleetHero data={fleetData} /> : fleetError ? (
            <p className="agents-error" data-testid="fleet-error">{fleetError}</p>
          ) : (
            <div className="kpi-strip fleet-hero" aria-hidden="true" data-testid="fleet-skeleton">
              {Array.from({ length: 5 }, (_, i) => (
                <div className="kpi-cell" key={i}><span className="skeleton-bar" style={{ width: 96 }} /></div>
              ))}
            </div>
          )}

          {fleetData && <TodoCards items={fleetData.todo} />}

          <div className="row-title">
            <h2>全部 Agent <span className="card-count" data-testid="agents-count">{agents.length}</span></h2>
            <div className="sort-group" role="group" aria-label="排序" data-testid="agents-sort">
              {SORT_KEYS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className="chip"
                  aria-pressed={sort === s.key}
                  onClick={() => setSort(s.key)}
                  data-testid={`agents-sort-${s.key}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="agents-grid" data-testid="agents-grid">
            {rows.map((r) => {
              const planId = r.status?.last_run?.plan_id;
              const planRuns = planId ? planRunsById.get(planId) : undefined;
              // 优化格 → 该 Agent 详情 ③（ADR-0016 门；③ 内默认口径 = 最近一次 vs 上一次）
              const optimizeHref = planId ? agentTabHash(r.name, "optimize") : null;
              return (
                <AgentCard
                  key={r.name}
                  agent={r.agent}
                  status={r.status}
                  statusLoading={fleet.isLoading}
                  statusError={fleetError}
                  severity={r.severity}
                  runningRow={r.runningRow}
                  lastRow={r.lastRow}
                  proposals={planRuns ? proposalCounts(planRuns) : undefined}
                  optimizeHref={optimizeHref}
                  hot={r.severity === "bad" || r.severity === "warn"}
                />
              );
            })}
          </div>
        </>
      ) : null}
    </section>
  );
}

function HomeSkeleton() {
  return (
    <div className="agents-grid" aria-hidden="true" data-testid="agents-skeleton">
      {Array.from({ length: 3 }, (_, i) => (
        <div className="card agent-card" key={i}>
          <div className="agent-head"><span className="skeleton-bar" style={{ width: 140 }} /></div>
          <div className="agent-obs">
            <span className="skeleton-bar" style={{ width: 72, height: 18 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
