// Agent 详情页（#/agent/:name[/tab]）= 闭环枢纽（ADR-0016 决定 1，版面变体 B 页内 Tab）。
// 页头：Agent 名 · 版本标签 · 运行中 run 胶囊 · 「运行「<计划名>」· 预估 $」主按钮；
// 页头下一行元信息：RUNTIME · 版本变更 · 下次运行。
// 四 Tab：① 现状（默认，hub/StatusPanel）· ② 评估（PlansBlock + RunsBlock）
//        · ③ 优化（hub/OptimizePanel，临时挂 compare/AnalysisSections）· ④ 配置
//        （IdentityBlock + ConfigBlock）。四个面板都挂载、非当前的 hidden（与契约
//        variant-b-tabs.html 的 .panel/.on 同一做法），切 Tab 不丢面板内状态。
//
// 路由参数 `name` 是 **agent_name（关联键）**，页头显示的是**显示名**
// （lib/agentName.displayName）—— 两者刻意分开，护栏 2 见 IdentityBlock 的注释。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiOne, type ApiEvent } from "../../lib/api";
import { useRunFlight } from "../../lib/runFlight";
import { useAuth } from "../../lib/auth";
import { displayName } from "../../lib/agentName";
import { fmtTimeUtc, shortArn } from "../../lib/time";
import { navigate } from "../../router";
import type { AgentConfigEvent, PlansEvent, RecentRunsEvent } from "./types";
import type { AgentStatusEvent } from "./home/types";
import type { PlanRunsEvent } from "../plan/types";
import { nextRunText } from "./home/derive";
import "./agents.css";
import "./autoconf.css";
import PageHeader from "../../components/layout/PageHeader";
import IdentityBlock, { useAgentItem } from "./detail/IdentityBlock";
import ConfigBlock from "./detail/ConfigBlock";
import PlansBlock from "./detail/PlansBlock";
import RunsBlock, { RUNS_LIMIT } from "./detail/RunsBlock";
import { gotoNewPlan, runPlanAndGo } from "./detail/actions";
import RunConfirmCard, { usePlanEstimate } from "../../components/RunConfirmCard";
import HubTabs, { panelId } from "./detail/hub/HubTabs";
import StatusPanel from "./detail/hub/StatusPanel";
import OptimizePanel from "./detail/hub/OptimizePanel";
import { latestCompleted, seqOf, tabSums } from "./detail/hub/derive";
import { AGENT_TABS, type AgentTab } from "./detail/hub/tabs";

export default function AgentDetailPage({ name, tab = "status", thisKey }: {
  name: string;
  tab?: AgentTab;
  thisKey?: string;
}) {
  const { authed } = useAuth();
  const qc = useQueryClient();
  // 发起运行的二次确认（缺陷 2）：页头按钮写了计划名，仍要卡上的预估费用兜住误运行
  const [runConfirmOpen, setRunConfirmOpen] = useState(false);
  // 与 PlansBlock 同 queryKey——react-query 去重，只发一次请求
  const plansQuery = useQuery({
    queryKey: ["plans", name],
    queryFn: () => apiOne<PlansEvent>({ action: "list_plans", agent_name: name }, "plans"),
  });
  const plans = plansQuery.data?.plans;
  const latest =
    plans && plans.length > 0
      ? plans.reduce((a, b) => (b.updated_at > a.updated_at ? b : a))
      : null;
  // 在飞闸门（缺陷 1）：hook 不能条件调用，无计划时用 "" 占位——runFlightOf("")
  // 恒为 IDLE，而无计划时这颗按钮根本不渲染
  const flight = useRunFlight(latest?.plan_id ?? "");
  // 主按钮上的预估：与确认卡 / 计划详情 KPI 同 queryKey（["plan_estimate", id]），不重复打
  const estimate = usePlanEstimate(latest?.plan_id ?? null);
  // 页头名字走显示名（没标注 = 原名）；版本 chip 放 meta 槽而不是标题内 ——
  // h1 的文本仍只有名字（UI-001：每路由恰好一个 h1，见 page-header-semantics）
  const agent = useAgentItem(name);
  const version = (agent?.version_label ?? "").trim();

  // ① 现状的数据源：agent_status（只读单事件）
  const statusQuery = useQuery({
    queryKey: ["agent-status", name],
    queryFn: () => apiOne<AgentStatusEvent & ApiEvent>({ action: "agent_status", agent_name: name }, "agent_status"),
  });
  const status = statusQuery.data;
  // 与 RunsBlock 同 queryKey：运行中胶囊 / ② 计数 / ③ 候选都吃这一份
  const runsQuery = useQuery({
    queryKey: ["recent_runs", name],
    queryFn: () =>
      apiOne<RecentRunsEvent>({ action: "list_recent_runs", agent_name: name, limit: RUNS_LIMIT }, "recent_runs"),
  });
  const runs = runsQuery.data?.runs;
  const running = runs?.find((r) => r.status === "running");
  // last_run 所属计划的历史：#N 序号 + 「较上一次」（与 ③ / 报告页同键）
  const lastPlanId = status?.last_run?.plan_id ?? "";
  const lastPlanRuns = useQuery({
    queryKey: ["plan_runs", lastPlanId],
    queryFn: () => apiOne<PlanRunsEvent>({ action: "list_plan_runs", plan_id: lastPlanId }, "plan_runs"),
    enabled: lastPlanId !== "",
  });
  // ③ 的口径：最近一次 completed run 所属计划（常与 last_run 同计划 ⇒ 同键去重）
  const optPlanId = latestCompleted(runs)?.plan_id ?? "";
  const optPlanRuns = useQuery({
    queryKey: ["plan_runs", optPlanId],
    queryFn: () => apiOne<PlanRunsEvent>({ action: "list_plan_runs", plan_id: optPlanId }, "plan_runs"),
    enabled: optPlanId !== "",
  });
  // ④ 小字：与 ConfigBlock 同 queryKey
  const configQuery = useQuery({
    queryKey: ["agent_config", name],
    queryFn: () => apiOne<AgentConfigEvent>({ action: "get_agent_config", agent_name: name }, "agent_config"),
  });

  const sums = tabSums({
    status,
    lastSeq: seqOf(lastPlanRuns.data?.runs, status?.last_run?.run_key),
    plans,
    runs,
    runsLimit: RUNS_LIMIT,
    optimizeRuns: optPlanId ? optPlanRuns.data?.runs : (runsQuery.isSuccess ? [] : undefined),
    version,
    configuredBy: configQuery.data ? (configQuery.data.configured_by ?? null) : undefined,
  });
  const next = status ? nextRunText(status.next_run, status.unavailable_reason) : null;

  const runLabel = flight.running
    ? "运行中…"
    : latest
      ? `运行「${latest.name}」${estimate.data ? ` · 预估 $${estimate.data.estimated_cost_usd.toFixed(2)}` : ""}`
      : "";

  return (
    <section data-testid="page-agent-detail">
      <PageHeader
        back={{ label: "Agent", to: "#/agents" }}
        title={<span style={{ fontFamily: "var(--mono)" }}>{displayName(agent) || name}</span>}
        meta={
          <>
            {version ? (
              <span className="badge badge-mono" data-testid="agent-head-version">{version}</span>
            ) : null}
            {running ? (
              <button
                type="button"
                className="badge run hub-run-pill"
                data-testid="agent-head-running"
                onClick={() => navigate(`#/plan/${encodeURIComponent(running.plan_id)}`)}
              >
                <span className="dot" aria-hidden="true" />运行中 · {running.plan_name}
              </button>
            ) : null}
          </>
        }
        actions={
          plans &&
          (latest ? (
            <button
              className="btn btn-primary"
              data-testid="agent-run-latest"
              disabled={!authed || flight.running}
              title={
                !authed ? "请先登录"
                  : flight.running ? `「${latest.name}」正在运行中`
                    : `运行「${latest.name}」`
              }
              onClick={() => setRunConfirmOpen(true)}
            >
              {runLabel}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              data-testid="agent-head-new-plan"
              disabled={!authed}
              title={!authed ? "请先登录" : undefined}
              onClick={() => gotoNewPlan(name)}
            >
              + 新建评估计划
            </button>
          ))
        }
      />
      <RunConfirmCard
        target={runConfirmOpen ? latest : null}
        onCancel={() => setRunConfirmOpen(false)}
        onConfirm={() => {
          setRunConfirmOpen(false);
          if (latest) runPlanAndGo(latest.plan_id, qc);
        }}
      />

      <div className="metabar" data-testid="agent-head-meta">
        <span className="item">
          <span className="k">RUNTIME</span>
          <span className="v" title={agent?.runtime_arn || undefined} data-testid="agent-head-runtime">
            {shortArn(agent?.runtime_arn) || "—"}
          </span>
        </span>
        <span className="divider" aria-hidden="true" />
        <span className="item">
          <span className="k">版本变更</span>
          <span className="v" data-testid="agent-head-updated">{agent?.last_updated ? fmtTimeUtc(agent.last_updated) : "—"}</span>
        </span>
        <span className="divider" aria-hidden="true" />
        <span className="item">
          <span className="k">下次运行</span>
          <span className="v" title={next?.title} data-testid="agent-head-next">
            {next ? next.text.replace(/^下次 /, "") : "—"}
          </span>
        </span>
      </div>

      <HubTabs name={name} active={tab} sums={sums} />

      {AGENT_TABS.map((t) => (
        <section
          key={t}
          role="tabpanel"
          id={panelId(t)}
          aria-labelledby={`agent-tab-${t}`}
          hidden={t !== tab}
          data-testid={panelId(t)}
        >
          {t === "status" && (
            <StatusPanel
              name={name}
              status={status}
              loading={statusQuery.isLoading}
              error={statusQuery.isError
                ? (statusQuery.error instanceof Error ? statusQuery.error.message : String(statusQuery.error))
                : null}
              planRuns={lastPlanRuns.data?.runs}
            />
          )}
          {t === "evaluate" && (
            <>
              <PlansBlock name={name} />
              <RunsBlock name={name} />
            </>
          )}
          {t === "optimize" && (
            <OptimizePanel pool={runs} poolReady={runsQuery.isSuccess} thisKey={thisKey} />
          )}
          {t === "config" && (
            <>
              <IdentityBlock name={name} />
              <ConfigBlock name={name} />
            </>
          )}
        </section>
      ))}
    </section>
  );
}
