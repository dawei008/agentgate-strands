// 评估器页「跨 Agent 表现」面板（ADR-0016 舰队级：同一把尺子在所有 Agent 上都过不了，
// 问题更像在尺子）。口径全在 evaluatorUsage.ts，这里只摆版面。
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import type { RecentRunsEvent } from "../agents/types";
import { EMPTY_MARK } from "../../lib/renderText";
// chip 上的分与它自己的 warn 着色 / title 里的「低于 0.70」并排 ⇒ 走 fmtScoreFloor，
// 不用本页此前那份私写的 toFixed(2)（它遮蔽了 lib 的同名函数还少了 null 分支）。
import { fmtScoreFloor } from "../../lib/scoring";
import {
  SCORE_TARGET, STREAK_MIN, agentOptimizeHref, deriveEvaluatorUsage,
  type AgentCell, type UsageRow, type Verdict,
} from "./evaluatorUsage";

/**
 * list_recent_runs 的 limit。与评估分析页候选池同值（ComparePage.POOL_LIMIT=200）且
 * queryKey 同形 ⇒ 两页共用一份缓存。后端硬顶 500（planrun.py list_recent_runs 分区扫描
 * 上限）；mock 桩不看 limit、整份返回。
 */
export const USAGE_RUNS_LIMIT = 200;

/** @param evaluatorNames 评估器页列出的名字；null = 评估器列表还没到（表等两路数据都到才画） */
export default function EvaluatorUsage({ evaluatorNames }: { evaluatorNames: string[] | null }) {
  const runsQuery = useQuery({
    queryKey: ["recent-runs", USAGE_RUNS_LIMIT],
    queryFn: () =>
      apiOne<RecentRunsEvent>({ action: "list_recent_runs", limit: USAGE_RUNS_LIMIT }, "recent_runs"),
  });
  const runs = runsQuery.data?.runs;
  const table = useMemo(
    () => (runs && evaluatorNames ? deriveEvaluatorUsage(runs, evaluatorNames) : null),
    [runs, evaluatorNames],
  );
  // 有出分的行照旧在上；「在用 Agent = 0」的评估器折成表尾一行（现网 31 Agent × 20 评估器
  // 大多数格子会是 0，逐行列是噪音），点「展开」才逐行列
  const scored = useMemo(() => table?.rows.filter((r) => r.agents.length > 0) ?? [], [table]);
  const unscored = useMemo(() => table?.rows.filter((r) => r.agents.length === 0) ?? [], [table]);
  const [showUnscored, setShowUnscored] = useState(false);
  const inUse = scored.length;

  return (
    <div className="card res-usage" data-testid="evaluator-usage">
      <div className="card-head">
        <span
          className="card-title"
          title={`每格 = 该评估器在该 Agent 最近一次 completed run 里的分；目标线 ${SCORE_TARGET.toFixed(2)}`}
        >
          跨 Agent 表现
        </span>
        <span className="card-count" data-testid="evaluator-usage-count">{inUse}</span>
        <span className="spacer" />
        {table && (
          <span
            className="card-sub"
            data-testid="evaluator-usage-sample"
            title={`取最近 ${USAGE_RUNS_LIMIT} 次 run，拿到 ${table.totalRuns} 条，其中 completed ${table.completedRuns} 条入统计`}
          >
            近 {table.totalRuns} 次 run · 只算 completed
          </span>
        )}
      </div>

      {!runsQuery.isError && !table && <div className="card-body subtle">加载中…</div>}
      {runsQuery.isError && (
        <div className="card-body res-error" data-testid="evaluator-usage-error">
          {runsQuery.error instanceof Error ? runsQuery.error.message : String(runsQuery.error)}
        </div>
      )}

      {/* 空态 = 一个评估器都没出过分（一条 run 都没有，或有 run 但没有 completed 的逐评估器分） */}
      {table && inUse === 0 && (
        <div className="card-body">
          <div className="u-empty" data-testid="evaluator-usage-empty">
            <p>还没有 run 出过分</p>
            <a className="btn-link" href="#/workbench" data-testid="evaluator-usage-empty-action">
              先跑一次评估计划
            </a>
          </div>
        </div>
      )}

      {table && inUse > 0 && (
        <table className="u-table res-usage-table" data-testid="evaluator-usage-table">
          <colgroup>
            <col style={{ width: 220 }} />
            <col style={{ width: 110 }} />
            <col />
            <col style={{ width: 180 }} />
          </colgroup>
          <thead>
            <tr>
              <th>评估器</th>
              <th className="r">在用 Agent</th>
              <th>各 Agent 最近一次分</th>
              <th title={`「尺子偏严？」= 所有在用 Agent 都连续 ${STREAK_MIN} 次以上未过线（${SCORE_TARGET.toFixed(2)}）；「N 个 Agent 未过线」= 最近一次分低于目标线的 Agent 数`}>
                判读
              </th>
            </tr>
          </thead>
          <tbody>
            {scored.map((r) => <UsageRowView key={r.name} row={r} />)}
            {unscored.length > 0 && (
              <tr data-testid="evaluator-usage-collapsed">
                <td colSpan={4} className="subtle">
                  其余 {unscored.length} 个评估器近 {table.totalRuns} 次 run 没出过分 ·{" "}
                  <button
                    type="button"
                    className="btn-link"
                    aria-expanded={showUnscored}
                    data-testid="evaluator-usage-toggle"
                    onClick={() => setShowUnscored((v) => !v)}
                  >
                    {showUnscored ? "收起" : "展开"}
                  </button>
                </td>
              </tr>
            )}
            {showUnscored && unscored.map((r) => <UsageRowView key={r.name} row={r} />)}
          </tbody>
        </table>
      )}
    </div>
  );
}

function UsageRowView({ row }: { row: UsageRow }) {
  return (
    <tr data-testid={`evaluator-usage-row-${row.name}`}>
      <td><span className="lat">{row.name}</span></td>
      <td className="r mono" data-testid={`evaluator-usage-row-${row.name}-agents`}>{row.agents.length}</td>
      <td>
        {row.agents.length === 0 ? (
          <span className="subtle">{EMPTY_MARK}</span>
        ) : (
          <div className="res-usage-chips">
            {row.agents.map((a) => <AgentChip key={a.agent} evaluator={row.name} cell={a} />)}
          </div>
        )}
      </td>
      <td data-testid={`evaluator-usage-row-${row.name}-verdict`}>
        <VerdictCell verdict={row.verdict} />
      </td>
    </tr>
  );
}

function AgentChip({ evaluator, cell }: { evaluator: string; cell: AgentCell }) {
  const low = cell.latest < SCORE_TARGET;
  return (
    <a
      className={`chip res-usage-chip${low ? " warn" : ""}`}
      href={agentOptimizeHref(cell.agent)}
      data-testid={`evaluator-usage-chip-${evaluator}-${cell.agent}`}
      title={low
        ? `${cell.agent} 在 ${evaluator} 上最近 ${cell.streak} 次 completed run 都低于 ${SCORE_TARGET.toFixed(2)}`
        : `${cell.agent} 在 ${evaluator} 上最近一次 completed run 的分`}
    >
      <span className="lat">{cell.agent}</span>
      <span className="n">{fmtScoreFloor(cell.latest)}</span>
      {cell.streak >= STREAK_MIN && (
        <span className="res-usage-streak" data-testid={`evaluator-usage-streak-${evaluator}-${cell.agent}`}>
          连续 {cell.streak} 次
        </span>
      )}
    </a>
  );
}

function VerdictCell({ verdict }: { verdict: Verdict }) {
  switch (verdict.kind) {
    case "strict":
      return (
        <span
          className="badge bad"
          title={`所有在用 Agent 在这把尺子上都连续 ${STREAK_MIN} 次以上未过线（${SCORE_TARGET.toFixed(2)}）`}
        >
          尺子偏严？
        </span>
      );
    case "partial":
      return <span className="badge warn">{verdict.n} 个 Agent 未过线</span>;
    default:
      return <span className="subtle">{EMPTY_MARK}</span>;
  }
}
