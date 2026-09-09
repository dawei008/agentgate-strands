import { displayName, isRenamed } from "../../../lib/agentName";
import { fmtCost } from "../../../lib/cost";
import { runBadge, runOutcome, STATUS_LABEL } from "../../../lib/scoring";
import { shortArn } from "../../../lib/time";
import { navigate } from "../../../router";
import { gotoNewPlan } from "../detail/actions";
import type { AgentItem, RunSummary } from "../types";
import Sparkline from "./Sparkline";
import {
  deltaClass, evaluatorGate, fmtDeltaPct, fmtDeltaPp, fmtDeltaSec, fmtDeltaUsd, fmtInt, fmtPct,
  fmtSec, nextRunText, reasonOf, runFailureReason, severityBadge,
  type ProposalCounts, type Severity,
} from "./derive";
import type { AgentStatus } from "./types";
import { agentTabHash } from "../detail/hub/tabs";

export interface AgentCardProps {
  agent: AgentItem;
  /** fleet_status.agents 里这一份；fleet 还没到 / 该 Agent 缺席 → undefined */
  status: AgentStatus | undefined;
  /** fleet_status 整体在途（此时字段画骨架而不是「—」） */
  statusLoading: boolean;
  /** fleet_status 拉失败的原话（逐卡显示，不吞） */
  statusError: string | null;
  severity: Severity;
  /** list_recent_runs 里该 Agent 的 running 行（有 = 评估行显示进行中） */
  runningRow: RunSummary | undefined;
  /** list_recent_runs 里与 last_run.run_key 同键的那行（M/K 与失败原因的来源） */
  lastRow: RunSummary | undefined;
  /** 最近一次 run 所属计划的处方计数；undefined = 在途 / 无最近 run */
  proposals: ProposalCounts | undefined;
  /** 优化行的落点（该 Agent 详情 ③ 优化，ADR-0016 门） */
  optimizeHref: string | null;
  hot: boolean;
}

const enc = encodeURIComponent;

function Obs({
  k, mono, value, delta, testid,
}: { k: string; mono?: boolean; value: string; delta: string; testid: string }) {
  return (
    <div className="obs" data-testid={testid}>
      <span className={`obs-k${mono ? " lat" : ""}`}>{k}</span>
      <span className="obs-v">{value}</span>
      <span className={`delta ${deltaClass(delta === "—" ? null : delta.startsWith("▲") ? 1 : -1)}`.trim()}>
        {delta}
      </span>
    </div>
  );
}

/**
 * 每个 Agent 一张卡：头 = 名 · 版本标签 · runtime · 右上状态 badge；
 * 主体 = 近 24h 会话量大数字 + 24 点曲线（hourly 为空则只留数字）；
 * 一行四小数 P95 · 成本 · 空响应率 · 工具失败率（各带较前一日 ▲▼，上升染琥珀）；
 * 底部两行「评估」「优化」。需动手的卡（hot）略大、置顶由排序决定。
 */
export default function AgentCard(p: AgentCardProps) {
  const { agent, status, severity } = p;
  const name = agent.agent_name;
  const shown = displayName(agent);
  const version = (agent.version_label ?? "").trim();
  const runtime = shortArn(agent.runtime_arn);
  const badge = severityBadge(severity);
  const m = status?.metrics;
  const sessions = m?.sessions;
  const gotoDetail = () => navigate(`#/agent/${enc(name)}`);

  return (
    <article
      className={`card barred agent-card${p.hot ? " hot" : ""}`}
      data-severity={severity}
      data-testid={`agent-card-${name}`}
    >
      <header className="agent-head">
        <button type="button" className="agent-name" onClick={gotoDetail} data-testid={`agent-card-${name}-name`}>
          {shown}
        </button>
        {/* 改过显示名才补原名：它是关联键（方案绑定 / run 归属都按它走） */}
        {isRenamed(agent) && (
          <span className="agent-runtime" data-testid={`agent-card-${name}-key`}>{name}</span>
        )}
        {version && (
          <span className="agent-version" data-testid={`agent-card-${name}-version`}>{version}</span>
        )}
        {runtime && <span className="agent-runtime" data-testid={`agent-card-${name}-runtime`}>{runtime}</span>}
        {status && (
          <span className={badge.cls} data-testid={`agent-card-${name}-badge`}>{badge.label}</span>
        )}
      </header>

      <button type="button" className="agent-obs" onClick={gotoDetail} data-testid={`agent-card-${name}-obs`}>
        {p.statusError ? (
          <div className="agents-error" data-testid={`agent-card-${name}-error`}>{p.statusError}</div>
        ) : p.statusLoading && !status ? (
          <div className="vol-row" aria-hidden="true">
            <span className="skeleton-bar" style={{ width: 72, height: 18 }} />
          </div>
        ) : (
          <>
            <div className="vol-row">
              <span className="vol" title={reasonOf(status, "metrics.sessions")} data-testid={`agent-card-${name}-sessions`}>
                {fmtInt(sessions?.value)}
              </span>
              <span className="vol-k">会话 / 24h</span>
              <span
                className={`delta ${deltaClass(sessions?.delta)}`.trim()}
                data-testid={`agent-card-${name}-sessions-delta`}
              >
                {fmtDeltaPct(sessions)}
              </span>
            </div>
            <Sparkline
              hourly={sessions?.hourly}
              label={`${shown} 按小时会话量`}
              testid={`agent-card-${name}-spark`}
            />
            <div className="obs-grid">
              <Obs k="P95" mono value={fmtSec(m?.p95_latency_ms.value)}
                   delta={fmtDeltaSec(m?.p95_latency_ms.delta)} testid={`agent-card-${name}-p95`} />
              {/* agent_status 的 agent_cost_usd：未定价 ⇒ 值 null（原因在 unavailable_reason），
                  一个数就是完整的 ⇒ isPartial=false，0 印 $0.00（lib/cost 唯一口径） */}
              <Obs k="成本" value={fmtCost(m?.agent_cost_usd.value, null, false).text}
                   delta={fmtDeltaUsd(m?.agent_cost_usd.delta)} testid={`agent-card-${name}-cost`} />
              <Obs k="空响应" value={fmtPct(m?.blank_rate.value)}
                   delta={fmtDeltaPp(m?.blank_rate.delta)} testid={`agent-card-${name}-blank`} />
              <Obs k="工具失败" value={fmtPct(m?.tool_failure_rate.value)}
                   delta={fmtDeltaPp(m?.tool_failure_rate.delta)} testid={`agent-card-${name}-toolfail`} />
            </div>
          </>
        )}
      </button>

      {status && (
        <div className="state-rows">
          <EvalRow {...p} />
          {status.last_run && (
            <button
              type="button"
              className="state-row"
              onClick={() => p.optimizeHref && navigate(p.optimizeHref)}
              data-testid={`agent-card-${name}-opt`}
            >
              <span className="state-k">优化</span>
              <span className="state-v">
                {p.proposals ? (
                  <>未采纳 <span className="num">{p.proposals.pending}</span> · 已验证 <span className="num">{p.proposals.verified}</span></>
                ) : "—"}
              </span>
              <span className="state-s" />
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * 评估行四态：
 *   进行中   list_recent_runs 里有该 Agent 的 running 行 → 蓝 badge + 计划名
 *   未评估   last_run null → 「未评估」+ 新建评估计划（唯一动作）
 *   失败     last_run 失败 → 「<计划> 失败 · <原因>」+ 下次运行（**只留这两样**）
 *   完成     「<计划> · 评估器 M/K 过线」(+ 部分失败环节) + 每条告警一句 + 下次运行
 */
function EvalRow(p: AgentCardProps) {
  const { agent, status, runningRow, lastRow } = p;
  const name = agent.agent_name;
  if (!status) return null;
  const next = nextRunText(status.next_run, status.unavailable_reason);
  const right = (
    <span className="state-s" title={next.title} data-testid={`agent-card-${name}-next`}>{next.text}</span>
  );
  const rowProps = {
    className: "state-row",
    "data-testid": `agent-card-${name}-eval`,
  };

  // 评估格的落点 = 该 Agent 详情 ②（ADR-0016 门）；运行中 / 失败 / 完成同一扇门
  const gotoEvaluate = () => navigate(agentTabHash(name, "evaluate"));
  if (runningRow) {
    return (
      <button type="button" {...rowProps} onClick={gotoEvaluate}>
        <span className="state-k">评估</span>
        <span className="state-v">
          <span className="badge run">进行中</span>
          <span>{" "}{runningRow.plan_name}</span>
        </span>
        {right}
      </button>
    );
  }

  const last = status.last_run;
  if (!last) {
    return (
      <div {...rowProps}>
        <span className="state-k">评估</span>
        <span className="state-v"><span className="faint">未评估</span></span>
        <span className="state-s">
          <button
            type="button"
            className="btn-link"
            onClick={() => gotoNewPlan(name)}
            data-testid={`agent-card-${name}-new-plan`}
          >
            新建评估计划
          </button>
        </span>
      </div>
    );
  }

  const gotoRun = gotoEvaluate;
  const outcome = lastRow
    ? runOutcome({ status: lastRow.status, score: lastRow.score ?? null, stage_summaries: lastRow.stage_summaries })
    : null;
  const failed = last.status === "error" || last.status === "failed" || outcome?.kind === "failed";

  if (failed) {
    const reason = runFailureReason(lastRow);
    return (
      <button type="button" {...rowProps} onClick={gotoRun}>
        <span className="state-k">评估</span>
        <span className="state-v">
          <span className="num bad">{last.plan_name} 失败</span>
          {reason && <span>{" "}· {reason}</span>}
        </span>
        {right}
      </button>
    );
  }

  // 非 completed 且非失败（skipped / stopped / halted_cost）：后端 status 原话
  if (last.status !== "completed") {
    return (
      <button type="button" {...rowProps} onClick={gotoRun}>
        <span className="state-k">评估</span>
        <span className="state-v">
          <span className="num">{STATUS_LABEL[last.status] ?? last.status}</span>
          <span>{" "}· {last.plan_name}</span>
        </span>
        {right}
      </button>
    );
  }

  const gate = evaluatorGate(lastRow);
  const partial = outcome?.kind === "partial" ? runBadge({
    status: lastRow!.status, score: lastRow!.score ?? null, stage_summaries: lastRow!.stage_summaries,
  }).label : null;
  return (
    <button type="button" {...rowProps} onClick={gotoRun}>
      <span className="state-k">评估</span>
      <span className="state-v">
        <span>{last.plan_name}</span>
        {partial && <span className="badge warn">{partial}</span>}
        <span data-testid={`agent-card-${name}-gate`}>
          {" "}· 评估器 <span className="num">{gate ? `${gate.passed}/${gate.total}` : "—"}</span> 过线
        </span>
        {status.alerts.map((a) => (
          <span key={`${a.plan_id}:${a.evaluator}`} data-testid={`agent-card-${name}-alert`}>
            {" "}· {a.evaluator} 连续 <span className="num bad">{a.streak}</span> 次未过线
          </span>
        ))}
      </span>
      {right}
    </button>
  );
}
