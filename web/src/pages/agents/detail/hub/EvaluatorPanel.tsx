// ③ 评估器面板（ADR-0016「分数口径修订」，版面 = 变体 A 行表，契约
// .scratch/adr0016-optimize/variant-a-rows.html）。
//
// 评估计划里配了几个评估器就几行：评估器名 · 环节 · 本次分（红队「拦截 a/b」）· 较上一次 ▲▼
// · 目标线（过 / 未过 badge + 0.70）· 最近 8 次小趋势（目标线虚线 + 版本变更竖线）。
// 未过置顶高亮（排序在 optimizeDerive.evaluatorPanelRows）。行可点 ⇒ 台账按该评估器过滤
// （aria-pressed 表示当前过滤态）。
//
// 头部一句话 = 「N 个评估器 · M 过线 · <最差> <分> 未过 · 红队拦截 a/b 未达」——只列未过项，
// **不出现合成分**。表格零玻璃（.u-table 在实心卡上）。
// 本次分与「目标线 + 过/未过 badge」同一行并排 ⇒ 分一律走 fmtScoreFloor
// （[0.695,0.70) 印 "0.70" 而同行 badge 说「未过」是自相矛盾的话）。
import { useMemo } from "react";
import { STAGE_LABEL, fmtPctInt, fmtScoreFloor } from "../../../../lib/scoring";
import { SparkTrend } from "../../../plan/TrendCard";
import type { PlanRunSummary } from "../../../plan/types";
import {
  SCORE_TARGET, evaluatorScores, rowDelta, rowSeries, versionChangeIndices, type EvaluatorPanelRow,
} from "./optimizeDerive";

const KIND_CLASS: Record<EvaluatorPanelRow["stage"], string> = {
  observe: "online", dataset: "regress", redteam: "red",
};

export default function EvaluatorPanel({
  rows, headline, trendRuns, trendSeqs, thisSeq, prevSeq, filter, onFilter,
}: {
  rows: EvaluatorPanelRow[];
  headline: string;
  /** 小趋势取样（时间升序，≤ TREND_WINDOW 条，末位 = 这一次） */
  trendRuns: PlanRunSummary[];
  /** 取样首末的 #N（编不出为 null） */
  trendSeqs: { first: number | null; last: number | null };
  thisSeq: number | null;
  prevSeq: number | null;
  /** 当前过滤的评估器名（台账按它过滤）；null = 未过滤 */
  filter: string | null;
  onFilter: (name: string) => void;
}) {
  const markers = versionChangeIndices(trendRuns);
  // 逐 run 的读数表算一次，所有行共享：rowSeries 在 rows.map 里被调用，此前它自己重跑
  // evaluatorScores ⇒ 派生量是 行数 × 8。这里预算成 8 个 Map，降到 8。
  const trendScores = useMemo(() => trendRuns.map(evaluatorScores), [trendRuns]);
  const seqWord = (n: number | null) => (n != null ? ` #${n}` : "");
  return (
    <section className="card opt-panel" data-testid="agent-evaluator-panel" aria-label="评估器面板">
      <div className="card-head">
        <span className="card-title" data-testid="agent-evaluator-headline">{headline}</span>
        <span className="spacer" />
        {trendRuns.length >= 2 && (
          <span className="card-sub mono" data-testid="agent-evaluator-legend">
            近 {trendRuns.length} 次{trendSeqs.first != null && trendSeqs.last != null
              ? ` #${trendSeqs.first}–#${trendSeqs.last}` : ""}
            {markers.map((m) => {
              // 取样是连续的 completed run 段 ⇒ 第 i 个点的 #N = 首点 #N + i
              const seq = trendSeqs.first != null ? trendSeqs.first + m.at : null;
              return (
                <span key={`${m.at}-${m.label}`} className="opt-legend-ver" data-testid="agent-evaluator-version">
                  {" · "}版本 {m.label}{seq != null ? ` 起于 #${seq}` : ""}
                </span>
              );
            })}
          </span>
        )}
      </div>
      <table className="u-table opt-ev-table">
        <thead>
          <tr>
            <th scope="col">评估器</th>
            <th scope="col">环节</th>
            <th scope="col">本次{seqWord(thisSeq)}</th>
            <th scope="col">较上一次{seqWord(prevSeq)}</th>
            <th scope="col">目标线</th>
            <th scope="col" className="c-spark">趋势</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const on = filter === r.name;
            const delta = rowDelta(r);
            const series = rowSeries(trendScores, r.key);
            const nonNull = series.filter((v) => v != null).length;
            const target = r.stage === "redteam" ? 1 : SCORE_TARGET;
            const tone = r.pass === false ? "miss" : r.pass ? "ok" : "none";
            const select = () => onFilter(r.name);
            return (
              <tr
                key={r.key}
                role="button"
                tabIndex={0}
                aria-pressed={on}
                className={`opt-ev-row${r.pass === false ? " is-miss" : ""}${on ? " is-on" : ""}`}
                data-testid={`agent-evaluator-row-${r.key}`}
                onClick={select}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); }
                }}
              >
                <td className="c-name"><span className="opt-ev-name">{r.name}</span></td>
                <td><span className={`kind ${KIND_CLASS[r.stage]}`}>{STAGE_LABEL[r.stage]}</span></td>
                <td className="c-score" data-testid={`agent-evaluator-row-${r.key}-score`}>
                  {r.stage === "redteam" && r.redteam ? (
                    <span className="opt-score">
                      <span className="pre">拦截</span>{r.redteam.blocked}<span className="den">/{r.redteam.attacks}</span>
                    </span>
                  ) : r.cur == null ? (
                    <span className="opt-faint">无判定</span>
                  ) : (
                    <span className="opt-score">{fmtScoreFloor(r.cur)}</span>
                  )}
                </td>
                <td data-testid={`agent-evaluator-row-${r.key}-delta`}>
                  {delta
                    ? <span className={`opt-delta ${delta.dir}`}>{delta.text}</span>
                    : <span className="opt-delta flat">—</span>}
                </td>
                <td className="c-goal" data-testid={`agent-evaluator-row-${r.key}-goal`}>
                  {r.pass == null ? (
                    <span className="opt-faint">—</span>
                  ) : (
                    <>
                      <span className={`badge ${r.pass ? "ok" : "warn"}`}>
                        {r.pass ? "过" : r.stage === "redteam" ? "未达" : "未过"}
                      </span>
                      <span className="opt-target">
                        {r.stage === "redteam" ? "目标线 0 攻破" : `目标线 ${SCORE_TARGET.toFixed(2)}`}
                      </span>
                    </>
                  )}
                </td>
                <td className="c-spark">
                  {nonNull >= 2 ? (
                    <SparkTrend
                      values={series}
                      target={target}
                      markers={markers.map((m) => m.at)}
                      tone={tone}
                      // 序列末位就是「本次」那一格的同一个数 ⇒ 与它同档（floor），
                      // 否则同一行里格子印 0.69、朗读串印 0.70。
                      label={`${r.name} 最近 ${series.length} 次：${series
                        .map((v) => (v == null ? "无判定" : r.stage === "redteam" ? fmtPctInt(v) : fmtScoreFloor(v)))
                        .join("，")}`}
                    />
                  ) : (
                    <span className="opt-faint">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
