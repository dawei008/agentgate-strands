import { navigate } from "../../../router";
import Sparkline from "./Sparkline";
import {
  deltaClass, fmtDeltaPct, fmtDeltaPp, fmtDeltaUsd, fmtInt, fmtPct, fmtSec, fmtUsd,
  isUnobserved, todoHref, todoSeverity,
} from "./derive";
import type { FleetStatusEvent } from "./types";

/**
 * 「舰队一眼」hero 带（观测口径在前）：近 24h 总会话量 + 24 点曲线 / 总成本 /
 * P95 最差（哪个 Agent）/ 异常率（空响应 + 工具失败）/ 右侧「需动手 N」逐条
 * （后端 todo 已排好：观测在前、评估在后，前端不重排）。
 * 数据 = fleet_status.fleet；算不出的项后端给 null ⇒ 这里画「—」。
 */
export default function FleetHero({ data }: { data: FleetStatusEvent }) {
  const f = data.fleet;
  // unavailable 的键与 agent_status.unavailable_reason 一致（也包含 last_run.* 之类）；
  // 「无观测数据」的判据在 derive.isUnobserved（与 ① 现状同一份键分类）
  const unavailable = Object.values(data.unavailable ?? {}).filter(isUnobserved).length;
  return (
    <section className="kpi-strip fleet-hero" aria-label="舰队一眼" data-testid="fleet-hero">
      <div className="kpi-cell kpi-hero" data-testid="fleet-sessions">
        <div className="kpi-k">近 24h 会话 · {f.agents} 个 Agent</div>
        <div>
          <div className="kpi-v">
            {fmtInt(f.sessions.value)}
            <span className={`delta ${deltaClass(f.sessions.delta)}`.trim()} data-testid="fleet-sessions-delta">
              {fmtDeltaPct(f.sessions)}{f.sessions.prev != null && f.sessions.value != null ? " 较前一日" : ""}
            </span>
          </div>
          <Sparkline hourly={f.hourly} label="舰队按小时会话量" testid="fleet-spark" />
          {unavailable > 0 && (
            <div className="kpi-s" data-testid="fleet-unavailable">{unavailable} 个 Agent 无观测数据</div>
          )}
        </div>
      </div>
      <div className="kpi-cell" data-testid="fleet-cost">
        <div className="kpi-k">总成本</div>
        <div className="kpi-v">{fmtUsd(f.cost_usd.value)}</div>
        <div className={`kpi-s delta ${deltaClass(f.cost_usd.delta)}`.trim()}>
          {fmtDeltaUsd(f.cost_usd.delta)}{f.cost_usd.delta ? " 较前一日" : ""}
        </div>
      </div>
      <div className="kpi-cell" data-testid="fleet-p95">
        <div className="kpi-k"><span className="lat">P95</span> 最差</div>
        <div className="kpi-v">{fmtSec(f.worst_p95?.value_ms)}</div>
        <div className="kpi-s">
          {f.worst_p95 ? <span className="name">{f.worst_p95.agent_name}</span> : "—"}
        </div>
      </div>
      <div className="kpi-cell" data-testid="fleet-anomaly">
        <div className="kpi-k">异常率 · 空响应 + 工具失败</div>
        <div className="kpi-v">{fmtPct(f.anomaly_rate.value)}</div>
        <div className={`kpi-s delta ${deltaClass(f.anomaly_rate.delta)}`.trim()}>
          {fmtDeltaPp(f.anomaly_rate.delta)}{f.anomaly_rate.delta ? " 较前一日" : ""}
        </div>
      </div>
      <div className="kpi-cell kpi-now" data-testid="fleet-todo">
        <div className="kpi-k">
          需动手 <span className={data.todo.length > 0 ? "count-warn" : "card-count"} data-testid="fleet-todo-count">
            {data.todo.length}
          </span>
        </div>
        {data.todo.map((t, i) => (
          <button
            key={`${t.kind}:${t.agent_name}:${i}`}
            type="button"
            className="now-line"
            onClick={() => navigate(todoHref(t))}
            data-testid={`fleet-now-${t.agent_name}`}
          >
            <span className={`now-dot ${todoSeverity(t)}`} aria-hidden="true" />
            <span className="now-src">{t.layer === "evaluate" ? "评估" : "观测"}</span>
            <span className="now-main"><span className="name">{t.agent_name}</span> {t.fact}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
