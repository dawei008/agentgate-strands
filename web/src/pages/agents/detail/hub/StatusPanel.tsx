// ① 现状（观测）：数据 = agent_status（单 Agent）。五个观测数一排（会话量大字 +
// 24 点曲线 / P95 / 成本 / 空响应率 / 工具失败率，各带较前一日）+ 三张卡：
// 最近一次评估（→ 运行报告）/ 告警（→ ③）/ 下次运行（预估成本 · CloudWatch 深链）
// + 整行「路径」卡（ADR-0017 D4，TopologyCard，数据另打 agent_topology）。
// **路径卡不受 agent_status 门控**：status 未到 / 拉失败时它照常渲染（自己的骨架态），
// 只有五数与三卡等 status。
// null ⇒ 「—」，原因（unavailable_reason）进对应格 title；hourly 为 [] 不画曲线。
// 内容形态以 /tmp/od-v2/hub.png 为准；观测条借 ui.css .kpi-strip（全站唯一玻璃卡 = hero）。
import { useMemo } from "react";
import { costFactsOf, fmtCost } from "../../../../lib/cost";
import { fmtScore } from "../../../../lib/scoring";
import { navigate } from "../../../../router";
import { usePlanEstimate } from "../../../../components/RunConfirmCard";
import type { PlanRunSummary } from "../../../plan/types";
import Sparkline from "../../home/Sparkline";
import {
  deltaClass, fmtDeltaPct, fmtDeltaPp, fmtDeltaSec, fmtDeltaUsd, fmtInt, fmtPct, fmtSec,
} from "../../home/derive";
import type { AgentStatus } from "../../home/types";
import {
  evalFacts, fmtStamp, parseBlocked, prevCompleted, reasonOf, relFuture, seqOf,
  signedDelta, signedDeltaPp,
} from "./derive";
import { agentTabHash } from "./tabs";
import TopologyCard from "./TopologyCard";

const enc = encodeURIComponent;

export default function StatusPanel({ name, status, loading, error, planRuns }: {
  name: string;
  status: AgentStatus | undefined;
  loading: boolean;
  /** agent_status 拉失败的原话（不吞） */
  error: string | null;
  /** last_run 所属计划的运行历史（#N 序号与「较上一次」的来源）；在途 = undefined */
  planRuns: PlanRunSummary[] | undefined;
}) {
  // 门控只包五数与三卡（它们逐格读 status）；「路径」卡在门控**之外**——它自己打
  // agent_topology，只借 status.last_run.run_key 给节点详情「最近会话」行做深链（拿不到 ⇒
  // 那些行不可点，见 TopologyCard）。现网实测：agent_status 冷调 8.9s，之前整块 return null
  // 会把路径卡一起吞掉，用户在这 9 秒里读成「拓扑没有了」。
  // 子元素槽位固定两格（[门控内容, TopologyCard]）—— status 到达只换第 0 格，第 1 格恒是
  // TopologyCard ⇒ React 按下标复用同一个实例，卡片不重挂载、内部展开态与请求不重来。
  return (
    <div data-testid="agent-status">
      {error ? (
        <p className="agents-error" data-testid="agent-status-error">{error}</p>
      ) : loading && !status ? (
        <div className="kpi-strip hub-obs" aria-hidden="true" data-testid="agent-status-skeleton">
          {Array.from({ length: 5 }, (_, i) => (
            <div className="kpi-cell" key={i}><span className="skeleton-bar" style={{ width: 96 }} /></div>
          ))}
        </div>
      ) : status ? (
        <Observed name={name} status={status} planRuns={planRuns} />
      ) : null}
      {/* ADR-0017 D4「路径」卡：三卡之下，整行；数据另打 agent_topology */}
      <TopologyCard name={name} />
    </div>
  );
}

/** 五数一排 + 三张卡：逐格读 status，故整块受 status 门控（DOM 与 status 到达前后同形） */
function Observed({ name, status, planRuns }: {
  name: string;
  status: AgentStatus;
  planRuns: PlanRunSummary[] | undefined;
}) {
  const m = status.metrics;
  const sessions = m.sessions;
  const r = (key: string) => reasonOf(status, key);

  return (
    <>
      <section className="kpi-strip hub-obs" aria-label="近 24h 观测" data-testid="agent-obs">
        <div className="kpi-cell kpi-hero" data-testid="agent-obs-sessions">
          <div className="kpi-k">近 {status.window_hours}h 会话量</div>
          <div>
            <div className="kpi-v" title={r("metrics.sessions")}>
              {fmtInt(sessions.value)}
              <span className={`delta ${deltaClass(sessions.delta)}`.trim()} data-testid="agent-obs-sessions-delta">
                {fmtDeltaPct(sessions)}{sessions.prev != null && sessions.value != null ? ` 较前一日 ${fmtInt(sessions.prev)}` : ""}
              </span>
            </div>
            <Sparkline hourly={sessions.hourly} label="按小时会话量" testid="agent-obs-spark" />
          </div>
        </div>
        <Obs k={<><span className="lat">P95</span> 时延</>} value={fmtSec(m.p95_latency_ms.value)}
             delta={fmtDeltaSec(m.p95_latency_ms.delta)} rawDelta={m.p95_latency_ms.delta}
             title={r("metrics.p95_latency_ms")} testid="agent-obs-p95" />
        {/* agentstatus._cost_usd：窗内有任何未定价模型 ⇒ 值 null + 原因（title）；所以一个数就是完整的，
            isPartial 传 false —— 0 是真 0（有价模型、零 token），印 $0.00 */}
        <Obs k="Agent 侧成本" value={fmtCost(m.agent_cost_usd.value, null, false).text}
             delta={fmtDeltaUsd(m.agent_cost_usd.delta)} rawDelta={m.agent_cost_usd.delta}
             title={r("metrics.agent_cost_usd")} testid="agent-obs-cost" />
        <Obs k="空响应率" value={fmtPct(m.blank_rate.value)}
             delta={fmtDeltaPp(m.blank_rate.delta)} rawDelta={m.blank_rate.delta}
             title={r("metrics.blank_rate")} testid="agent-obs-blank" />
        <Obs k="工具调用失败率" value={fmtPct(m.tool_failure_rate.value)}
             delta={fmtDeltaPp(m.tool_failure_rate.delta)} rawDelta={m.tool_failure_rate.delta}
             title={r("metrics.tool_failure_rate")} testid="agent-obs-toolfail" />
      </section>

      <div className="hub-cards">
        <LastRunCard status={status} planRuns={planRuns} />
        <AlertsCard name={name} status={status} />
        <NextRunCard status={status} />
      </div>
    </>
  );
}

function Obs({ k, value, delta, rawDelta, title, testid }: {
  k: React.ReactNode; value: string; delta: string; rawDelta: number | null; title?: string; testid: string;
}) {
  return (
    <div className="kpi-cell" data-testid={testid}>
      <div className="kpi-k">{k}</div>
      <div className="kpi-v" title={title}>{value}</div>
      <div className={`kpi-s delta ${deltaClass(rawDelta)}`.trim()}>
        {delta}{delta !== "—" ? " 较前一日" : ""}
      </div>
    </div>
  );
}

// ---------- 最近一次评估 ----------
function LastRunCard({ status, planRuns }: { status: AgentStatus; planRuns: PlanRunSummary[] | undefined }) {
  const last = status.last_run;
  const seq = seqOf(planRuns, last?.run_key);
  const prev = prevCompleted(planRuns, last?.run_key);
  const prevSeq = seqOf(planRuns, prev?.run_key);
  const pf = evalFacts(prev);
  const vs = prevSeq != null ? `较 run #${prevSeq}` : "较上一次";
  const r = (key: string) => reasonOf(status, key);

  const blocked = parseBlocked(last?.redteam_blocked);
  const blockedRate = blocked ? blocked.blocked / blocked.attacks : null;
  const prevBlockedRate = pf.redteam ? pf.redteam.blocked / pf.redteam.attacks : null;

  return (
    <section className="card" data-testid="agent-last-run">
      <div className="card-head">
        <span className="card-title">最近一次评估</span>
        {last && (
          <span className="card-sub" data-testid="agent-last-run-sub">
            {seq != null ? `run #${seq} · ` : ""}{last.plan_name}{last.finished_at ? ` · ${last.finished_at}` : ""}
          </span>
        )}
        {last && last.status !== "completed" && (
          <span className={`badge ${last.status === "error" || last.status === "failed" ? "bad" : "warn"}`}
                data-testid="agent-last-run-status">
            {last.status}
          </span>
        )}
        <span className="spacer" />
        {last && (
          <button type="button" className="btn-link" data-testid="agent-last-run-report"
                  onClick={() => navigate(`#/report/${enc(last.run_key)}`)}>
            运行报告 →
          </button>
        )}
      </div>
      {!last ? (
        <div className="hub-empty" data-testid="agent-last-run-empty">未评估</div>
      ) : (
        <div className="hub-stats">
          <Stat k="线上评估分" testid="agent-last-observe"
                v={fmtScore(last.observe_mean)} title={r("last_run.observe_mean")}
                s={prev ? signedDelta(last.observe_mean, pf.observe, 2) : null} vs={vs} />
          {/* 回归格只有 pass_rate 一个来源：后端 dataset_pass（X/Y 形态）恒 null，已随批 simp-A2 删字段 */}
          <Stat k="回归测试" testid="agent-last-dataset"
                v={fmtPct(last.dataset_pass_rate)}
                title={last.dataset_pass_rate == null ? r("last_run.dataset_pass_rate") : undefined}
                s={prev ? signedDeltaPp(last.dataset_pass_rate, pf.passRate) : null} vs={vs} />
          <Stat k="红队测试 · 拦截" testid="agent-last-redteam"
                v={blocked ? <>{blocked.blocked}<span className="denom"> / {blocked.attacks}</span></> : "—"}
                title={blocked ? undefined : r("last_run.redteam_blocked")}
                s={prev ? signedDeltaPp(blockedRate, prevBlockedRate) : null} vs={vs} />
        </div>
      )}
    </section>
  );
}

function Stat({ k, v, s, vs, title, testid }: {
  k: string; v: React.ReactNode; s: string | null; vs: string; title?: string; testid: string;
}) {
  return (
    <div className="hub-stat" data-testid={testid}>
      <span className="k">{k}</span>
      <span className="v" title={title}>{v}</span>
      {s && <span className="s">{s} {vs}</span>}
    </div>
  );
}

// ---------- 告警 ----------
function AlertsCard({ name, status }: { name: string; status: AgentStatus }) {
  const alerts = status.alerts;
  return (
    <section className="card barred" data-severity={alerts.length > 0 ? "warn" : undefined} data-testid="agent-alerts">
      <div className="card-head">
        <span className="card-title">告警</span>
        <span className="card-count" data-testid="agent-alerts-count">{alerts.length}</span>
        <span className="spacer" />
        {alerts.length > 0 && (
          <button type="button" className="btn-link" data-testid="agent-alerts-optimize"
                  onClick={() => navigate(agentTabHash(name, "optimize"))}>
            去优化 →
          </button>
        )}
      </div>
      {alerts.length === 0 ? (
        <div className="hub-empty" data-testid="agent-alerts-empty">—</div>
      ) : (
        <div className="hub-alerts">
          {alerts.map((a) => (
            <button
              key={`${a.plan_id}:${a.evaluator}`}
              type="button"
              className="hub-alert"
              data-testid="agent-alert"
              onClick={() => navigate(agentTabHash(name, "optimize"))}
            >
              <span className="dot" aria-hidden="true" />
              <span className="main">
                「{a.plan_name}」{a.evaluator} 连续 <b>{a.streak}</b> 次未过目标线 {a.target}
              </span>
              <span className="sub">{a.values.join(" / ")}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- 下次运行 ----------
function NextRunCard({ status }: { status: AgentStatus }) {
  const next = status.next_run;
  const estimate = usePlanEstimate(next?.plan_id ?? null);
  // 预估侧同口径：stages[i].{cost_is_partial, unpriced_agents}（testrun.estimate_test_run）
  // ⇒ 被测 Agent 无价时预估只含 judge 侧，标「部分」，名单进 title
  const est = useMemo(() => {
    if (!estimate.data) return null;
    const f = costFactsOf(estimate.data.stages);
    return fmtCost(estimate.data.estimated_cost_usd, f.breakdown, f.isPartial);
  }, [estimate.data]);
  const rel = relFuture(next?.at);
  const cw = status.cloudwatch_url;
  return (
    <section className="card" data-testid="agent-next-run">
      <div className="card-head">
        <span className="card-title">下次运行</span>
        <span className="spacer" />
        {next && <span className="chip" data-testid="agent-next-run-plan">{next.plan_name}</span>}
      </div>
      <div className="hub-next">
        {!next ? (
          <span className="hub-empty" style={{ padding: 0 }} data-testid="agent-next-run-none">无定时</span>
        ) : (
          <>
            <span className="when" title={next.at ? undefined : reasonOf(status, "next_run.at")} data-testid="agent-next-run-at">
              {next.at ? fmtStamp(next.at) : "—"}
              {rel && <span className="rel">{rel}</span>}
            </span>
            <span className="cost" data-testid="agent-next-run-cost">
              {est ? <><b title={est.title}>{est.text}</b>{est.badge && <span className="badge" title={est.title} data-testid="agent-next-run-cost-badge">{est.badge}</span>} 预估</>
                : estimate.isError ? `预估失败：${estimate.error instanceof Error ? estimate.error.message : String(estimate.error)}`
                : estimate.isLoading ? "预估中…"
                : next.budget_usd != null ? <>单次预算 <b>${next.budget_usd.toFixed(2)}</b></> : null}
            </span>
          </>
        )}
        {cw ? (
          <a className="btn ghost mini hub-ext" href={cw} target="_blank" rel="noopener noreferrer" data-testid="agent-cloudwatch">
            在 CloudWatch 查看 trace ↗
          </a>
        ) : (
          <span className="hub-empty" style={{ padding: 0 }} title={reasonOf(status, "cloudwatch_url")} data-testid="agent-cloudwatch-none">
            CloudWatch —
          </span>
        )}
      </div>
    </section>
  );
}
