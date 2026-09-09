// ③ hero 四格 + ④ 成本时延小条。
//
// 四格 = 过线评估器 N/M · 会话/用例/攻击数 · 问题条目数 · 成本。**没有**「本环节合成」
// 那一格（契约里那格删掉：分数口径修订后决策看单项，合成均值只作次要小字，放在评估器
// 区的标题旁）。hero 复用 styles/ui.css 的 .kpi-strip（全站唯一玻璃卡，纪律 1 白名单），
// 格内零 blur。
import type { CostText } from "../../lib/cost";
import { EMPTY_MARK } from "../../lib/renderText";
import { SCORE_TARGET } from "../plan/derive";
import { matrixRowAnchor, shortSessionId } from "../plan/reportRows";
import type { SynthesisIssue } from "../plan/types";
import {
  f2s, f3, issueFixTypeCounts, type PageMetrics, type PageVerdictFacts, type RowTally,
} from "./model";

export function ReportHero({ facts, tally, issues, cost, metrics }: {
  facts: PageVerdictFacts;
  tally: RowTally;
  issues: SynthesisIssue[];
  /** run 级成本，已按 lib/cost.fmtCost 排好（真 0 / 部分 / 全缺三态在那里定） */
  cost: CostText;
  metrics: PageMetrics | null;
}) {
  const scored = facts.scoredRefs.length;
  const passEv = scored - facts.underRefs.length;
  const fixCounts = issueFixTypeCounts(issues);
  const costDash = cost.text === EMPTY_MARK;
  return (
    <div className="kpi-strip rpg-hero" style={{ "--kpi-cols": 3 } as React.CSSProperties} data-testid="report-hero">
      <div className="kpi kpi-hero" data-testid="report-hero-evaluators">
        <div className="kpi-label">过线评估器 <span className="kpi-scope">· 目标线 {f3(SCORE_TARGET)}</span></div>
        <div className="kpi-hero-row">
          <span className="kpi-hero-num">
            {scored > 0 ? passEv : "—"}
            {scored > 0 && <span className="denom"> / {scored}</span>}
          </span>
        </div>
        <div className="kpi-foot" data-testid="report-hero-evaluators-sub">
          {scored === 0 ? "没有一个评估器评出分数" : facts.underRefs.length === 0 ? (
            <><span className="dot good" /> 全部过线</>
          ) : (
            <><span className="dot warn" /><span className="mono">{facts.underRefs.map((r) => r.tile.name).join(" · ")}</span> 未过线</>
          )}
        </div>
      </div>
      <div className="kpi" data-testid="report-hero-rows">
        <div className="kpi-label">{tally.parts.length ? tally.parts.map((p) => p.unit).join(" · ") : "会话"}</div>
        <div className="kpi-val">
          {tally.parts.length === 0 ? "—" : tally.parts.map((p, i) => (
            <span key={p.unit}>{i > 0 && <span className="unit"> · </span>}{p.count}</span>
          ))}
        </div>
        <div className="kpi-foot" data-testid="report-hero-rows-sub">
          {tally.parts.length > 0 && (
            <>
              <span className="mono">{tally.pass}</span> 全过 · <span className="mono">{tally.fail}</span> 有未过项
              {tally.none > 0 && <> · <span className="mono">{tally.none}</span> 没跑成</>}
            </>
          )}
        </div>
      </div>
      <div className="kpi" data-testid="report-hero-issues">
        <div className="kpi-label">问题条目</div>
        <div className="kpi-val">{issues.length}</div>
        <div className="kpi-foot" data-testid="report-hero-issues-sub">
          {fixCounts.map((c, i) => (
            <span key={c.fixType}>{i > 0 && " · "}<span className="mono">{c.count}</span> {c.fixType}</span>
          ))}
        </div>
      </div>
      <div className="kpi" data-testid="report-hero-cost">
        <div className="kpi-label">成本</div>
        <div className={`kpi-val${costDash ? " is-dash" : ""}`} title={cost.title}>
          {cost.text}
          {cost.badge && <span className="badge" title={cost.title} data-testid="report-hero-cost-badge">{cost.badge}</span>}
        </div>
        <div className="kpi-foot" data-testid="report-hero-cost-sub">
          {costDash && cost.partial && "模型未定价"}
          {metrics?.tokensTotal != null && (
            <>{costDash && cost.partial && " · "}<span className="mono">{metrics.tokensTotal}</span> tokens</>
          )}
        </div>
      </div>
    </div>
  );
}

/** ④ 成本时延一行小条（只有 observe 环节带 metrics；没有就整条不画） */
export function PerfBar({ metrics, onJump }: {
  metrics: PageMetrics;
  onJump: (anchorId: string) => void;
}) {
  const slow = metrics.slowest;
  return (
    <div className="rpg-perf" data-testid="report-perf">
      {metrics.tokensTotal != null && (
        <span>
          <span className="k lat">tokens</span><span className="v">{metrics.tokensTotal}</span>
          {(metrics.tokensInput != null || metrics.tokensOutput != null) && (
            <span className="note">（输入 <span className="v">{metrics.tokensInput ?? "—"}</span> · 输出 <span className="v">{metrics.tokensOutput ?? "—"}</span>）</span>
          )}
        </span>
      )}
      {metrics.llmCalls != null && <span><span className="k">模型调用</span><span className="v">{metrics.llmCalls}</span></span>}
      {metrics.toolCalls != null && <span><span className="k">工具调用</span><span className="v">{metrics.toolCalls}</span></span>}
      {metrics.latencyAvg != null && <span><span className="k">平均时延</span><span className="v">{f2s(metrics.latencyAvg)}</span></span>}
      {metrics.latencyMax != null && (
        <span>
          <span className="k">最大时延</span><span className="v">{f2s(metrics.latencyMax)}</span>
          {slow && (
            <span className="note">
              {" · "}
              <a
                className="rpg-sid"
                href={`#${matrixRowAnchor(slow.groupIndex, slow.row.name)}`}
                title={slow.row.name}
                data-testid="report-perf-slowest"
                onClick={(e) => { e.preventDefault(); onJump(matrixRowAnchor(slow.groupIndex, slow.row.name)); }}
              >
                {shortSessionId(slow.row.name)}
              </a>
              {slow.row.metrics?.llmCalls != null && <>，{slow.row.metrics.llmCalls} 次模型调用</>}
            </span>
          )}
        </span>
      )}
      {metrics.unpricedModels.length > 0 && (
        <span><span className="k">未定价模型</span><span className="v">{metrics.unpricedModels.join(" · ")}</span></span>
      )}
    </div>
  );
}
