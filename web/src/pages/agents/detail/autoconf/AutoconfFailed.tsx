import type { AgentAutoconfiguredEvent, AutoconfAttempt } from "../../types";

/** 态 failed：红 ✗ + 已试模板小表格 + 建议检查项 */
export default function AutoconfFailed({
  r,
  onRetry,
  onManual,
}: {
  r: AgentAutoconfiguredEvent;
  onRetry: () => void;
  onManual: (prefill?: { template?: string; responsePath?: string }) => void;
}) {
  const attempts: AutoconfAttempt[] = r.attempts ?? [];
  const totalMs = attempts.reduce((s, a) => s + (a.latency_ms ?? 0), 0);
  return (
    <div className="autoconf-result" data-testid="autoconf-failed">
      <div className="verdict">
        <span className="vmark bad" aria-hidden="true">✗</span>
        <span className="vtext">
          <span className="vtitle">
            <span className="badk">探测失败</span>
            {r.error && (
              <>
                {" · "}
                <span className="pathchip" style={{ color: "var(--bad)" }} data-testid="autoconf-failed-error">
                  {r.error}
                </span>
              </>
            )}
          </span>
          <span className="vsub">
            已自动尝试 <b>{attempts.length} 种常见模板</b>均失败
          </span>
          {attempts.length > 0 && (
            <span className="vmeta" data-testid="autoconf-vmeta">
              <span>{attempts.length} 次尝试</span>
              <span className="sep" />
              <span>累计 {totalMs.toLocaleString("en-US")} ms</span>
            </span>
          )}
        </span>
      </div>
      <div className="verdict-body">
        {/* 「建议检查」三条排障清单对任何失败恒成立 ⇒ 整块删（prose-sweep 2026-09-03）；
            逐模板的结果表是这一次的数据，保留 */}
        {attempts.length > 0 && (
          <>
            <div className="u-label">已自动尝试的模板</div>
            <div className="triedwrap">
              <table className="tried" data-testid="autoconf-tried">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>#</th>
                    <th>模板</th>
                    <th style={{ width: 128 }}>结果</th>
                    <th style={{ width: 80 }}>耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((a, i) => (
                    <tr key={i} data-testid={`autoconf-tried-${i}`}>
                      <td>{i + 1}</td>
                      <td>{a.template}</td>
                      <td className={a.ok ? "hit" : "fail"}>{a.ok ? "成功" : a.error || "失败"}</td>
                      <td>{typeof a.latency_ms === "number" ? `${a.latency_ms} ms` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="cand-actions">
          <button className="btn" data-testid="autoconf-retry" onClick={onRetry}>
            ↺ 重试
          </button>
          <button
            className="btn-secondary btn"
            data-testid="autoconf-failed-manual"
            onClick={() => onManual()}
          >
            手动编辑
          </button>
        </div>
      </div>
    </div>
  );
}
