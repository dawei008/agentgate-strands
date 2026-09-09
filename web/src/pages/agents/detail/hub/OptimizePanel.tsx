// ③ 优化（ADR-0016 决定 1 ③ + 分数口径修订 + 设计骨架 v2 / 变体 A 行表，批 optimize-ledger）。
//
// 口径 = 该 Agent 最近一次 completed run（可由 ?this= 预选）vs 同一计划里的上一次 completed
// run —— 自动选，用户不用勾；右上「任意两次对比」链到 #/compare/<prev>/<this>。
//
// 版面自上而下：
//   1. 口径行（这一次 / 上一次 / 任意两次对比）；
//   2. 评估器面板（hub/EvaluatorPanel）：评估计划里配了几个评估器就几行，头部一句话只数
//      「几个过线 / 谁没过」，**不出现合成分**；行可点 ⇒ 台账按该评估器过滤；
//   3. 问题台账（hub/IssueLedger）：这一次 run 的 synthesis_issues；老 run 为 [] ⇒ 回落挂
//      compare/AnalysisSections（两段散文卡 + 采纳追踪，趋势卡关掉 —— 那张画的是合成分）。
// 数据全走 list_plan_runs（与 ② / 报告页 / 对比页同 queryKey ⇒ 一份请求）。
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiOne, type ApiEvent } from "../../../../lib/api";
import { fmtRunTime } from "../../../../lib/time";
import { navigate } from "../../../../router";
import AnalysisSections, { generateInputOf } from "../../../compare/AnalysisSections";
import { SIDE_WORD, type CompareViewRun } from "../../../plan/compare/CompareView";
import type { PlanRunDetail, PlanRunSummary, PlanRunsEvent } from "../../../plan/types";
import type { RunSummary } from "../../types";
import { RUNS_LIMIT } from "../RunsBlock";
import { asPlanRun, latestCompleted, prevCompleted, seqOf } from "./derive";
import EvaluatorPanel from "./EvaluatorPanel";
import IssueLedger from "./IssueLedger";
import { evaluatorHeadline, evaluatorPanelRows, trendRunsAsc } from "./optimizeDerive";
import "./optimize.css";

const enc = encodeURIComponent;

export default function OptimizePanel({ pool, poolReady, thisKey }: {
  /** 该 Agent 的 list_recent_runs 投影（与 ② 运行记录同一份查询） */
  pool: RunSummary[] | undefined;
  poolReady: boolean;
  /** 报告页页脚带过来的预选「这一次」；不在池子里或未完成 ⇒ 退回最近一次 completed */
  thisKey?: string;
}) {
  // 预选「这一次」：先在该 Agent 的候选池里找；池子只有最近 RUNS_LIMIT 条，报告页带来的
  // run_key 可能更早 ⇒ 退到它所属计划的历史里找（plan_id = run_key 的 `#` 前缀，与
  // ReportPage / AnalysisSections 同一读法）。都没有 / 没完成 ⇒ 退回最近一次 completed。
  const poolPick = thisKey ? pool?.find((r) => r.run_key === thisKey && r.status === "completed") : undefined;
  const prefixPlan = thisKey && !poolPick ? thisKey.split("#")[0] : "";
  const preQuery = useQuery({
    queryKey: ["plan_runs", prefixPlan],
    queryFn: () => apiOne<PlanRunsEvent>({ action: "list_plan_runs", plan_id: prefixPlan }, "plan_runs"),
    enabled: prefixPlan !== "",
  });
  const fromHistory = prefixPlan
    ? preQuery.data?.runs.find((r) => r.run_key === thisKey && r.status === "completed")
    : undefined;
  const thisRun = useMemo<RunSummary | null>(() => {
    if (poolPick) return poolPick;
    if (fromHistory) {
      const sibling = pool?.find((r) => r.plan_id === prefixPlan);
      return {
        ...fromHistory,
        plan_id: prefixPlan,
        plan_name: sibling?.plan_name ?? prefixPlan,
        agent_name: sibling?.agent_name ?? "",
        started_at: fromHistory.started_at == null ? undefined : String(fromHistory.started_at),
      };
    }
    return latestCompleted(pool);
  }, [pool, poolPick, fromHistory, prefixPlan]);
  const planId = thisRun?.plan_id ?? "";
  const runKey = thisRun?.run_key ?? "";

  // 同一计划的历史：找「上一次」+ 编 #N + 评估器面板与台账的全部数据。
  // queryKey 与报告页 / AnalysisSections 同键 ⇒ 一份请求
  const runsQuery = useQuery({
    queryKey: ["plan_runs", planId],
    queryFn: () => apiOne<PlanRunsEvent>({ action: "list_plan_runs", plan_id: planId }, "plan_runs"),
    enabled: planId !== "",
  });
  const planRuns = runsQuery.data?.runs;
  const prev = prevCompleted(planRuns, runKey);
  const thisSeq = seqOf(planRuns, runKey);
  const prevSeq = seqOf(planRuns, prev?.run_key);
  // 「这一次」在计划历史里的那一行（带 synthesis_issues / proposals / 完整环节摘要）；
  // 历史还没到时退到候选池那行（只够画面板的本次分，没有台账）
  const thisPlanRun = useMemo<PlanRunSummary | null>(() => {
    const hit = planRuns?.find((r) => r.run_key === runKey);
    if (hit) return hit;
    return thisRun ? asPlanRun(thisRun) : null;
  }, [planRuns, runKey, thisRun]);

  // 「生成改进稿」的料住在这一次的归档里（agent_name + observe 会话明细）：与报告页 /
  // 对比页同 queryKey（["plan_run", key]）
  const detailQuery = useQuery({
    queryKey: ["plan_run", runKey],
    queryFn: () => apiOne<PlanRunDetail & ApiEvent>({ action: "get_plan_run", run_key: runKey }, "plan_run"),
    enabled: runKey !== "",
  });
  const generate = useMemo(() => generateInputOf(detailQuery.data, runKey), [detailQuery.data, runKey]);

  // 评估器面板：这一次 vs 上一次的环节摘要；小趋势取到这一次为止的最近 8 次 completed
  const rows = useMemo(() => evaluatorPanelRows(thisPlanRun, prev), [thisPlanRun, prev]);
  const headline = evaluatorHeadline(rows);
  const trendRuns = useMemo(() => trendRunsAsc(planRuns, runKey), [planRuns, runKey]);
  const trendSeqs = {
    first: seqOf(planRuns, trendRuns[0]?.run_key),
    last: seqOf(planRuns, trendRuns[trendRuns.length - 1]?.run_key),
  };

  // 台账过滤（点面板行 / 台账里的来源 chip）：同名再点一次 = 清除
  const [filter, setFilter] = useState<string | null>(null);
  const toggleFilter = (name: string) => setFilter((f) => (f === name ? null : name));

  const issues = thisPlanRun?.synthesis_issues ?? [];
  const viewPool = useMemo<CompareViewRun[]>(() => (pool ?? []).map(asPlanRun), [pool]);

  // 数据未到时**永不 return null**（样板 = ① 的路径卡，见 TopologyCard 的骨架态）：
  // 之前这里整块 return null，深链冷开（#/agent/<name>/optimize）在 list_recent_runs
  // 那几秒里是一片空白，用户读成「这个 Tab 没有内容」。改成骨架 + 一行说清在等哪份数据；
  // 预选的 run 还在计划历史里找时也别用「最近一次」顶上（会闪一下再换），仍走这条骨架。
  if (!poolReady || (prefixPlan !== "" && preQuery.isLoading)) {
    return (
      <div data-testid="agent-optimize">
        <div className="hub-opt-head" data-testid="agent-optimize-skeleton">
          <span className="skeleton-bar" style={{ width: 320 }} aria-hidden="true" />
          <span className="card-sub" data-testid="agent-optimize-pending">
            {!poolReady
              ? `正在取这个 Agent 最近 ${RUNS_LIMIT} 次运行，挑出最近一次已完成的…`
              : `正在「${prefixPlan}」的运行历史里定位 run ${thisKey}…`}
          </span>
        </div>
      </div>
    );
  }
  if (!thisRun) {
    return <p className="agent-detail-empty" data-testid="agent-optimize-empty">还没有已完成的运行。</p>;
  }
  const pair = prev ? { aKey: prev.run_key, bKey: thisRun.run_key } : null;
  const compareHref = pair ? `#/compare/${enc(pair.aKey)}/${enc(pair.bKey)}` : `#/compare/${enc(thisRun.run_key)}`;
  const reportHref = `#/report/${enc(thisRun.run_key)}`;

  return (
    <div data-testid="agent-optimize">
      <div className="hub-opt-head" data-testid="agent-optimize-head">
        <span data-testid="agent-optimize-this">
          <span className="hub-side">{SIDE_WORD.b}</span>
          <b>run{thisSeq != null ? ` #${thisSeq}` : ""}</b> · {thisRun.plan_name} · {fmtRunTime(thisRun.started_at)}
        </span>
        <span data-testid="agent-optimize-prev">
          <span className="hub-side">{SIDE_WORD.a}</span>
          {prev
            ? <><b>run{prevSeq != null ? ` #${prevSeq}` : ""}</b> · {fmtRunTime(prev.started_at)}</>
            : runsQuery.isLoading ? "…" : <b>—</b>}
        </span>
        <span className="spacer" />
        <button type="button" className="btn-link" data-testid="agent-optimize-compare"
                onClick={() => navigate(compareHref)}>
          任意两次对比 →
        </button>
      </div>

      {headline && (
        <EvaluatorPanel
          rows={rows}
          headline={headline}
          trendRuns={trendRuns}
          trendSeqs={trendSeqs}
          thisSeq={thisSeq}
          prevSeq={prevSeq}
          filter={filter}
          onFilter={toggleFilter}
        />
      )}

      {issues.length > 0 ? (
        <IssueLedger
          issues={issues}
          thisKey={thisRun.run_key}
          thisSeq={thisSeq}
          planId={planId}
          planRuns={planRuns ?? []}
          filter={filter}
          onFilter={toggleFilter}
          onClearFilter={() => setFilter(null)}
          generate={generate}
          // 报告页没有行级锚点（router 只收 run_key）⇒ 落到这一次的报告
          onJumpEvidence={() => navigate(reportHref)}
        />
      ) : pair ? (
        // 老形状（没有 synthesis_issues）：两段散文卡 + 采纳追踪原样；趋势卡不挂——它画的是
        // 合成分，评估器面板已取代它。引用 chip 的落点（逐用例对照）住在对比页 ⇒ 点 chip 去对比页
        <AnalysisSections pair={pair} pool={viewPool} onJump={() => navigate(compareHref)} showTrend={false} />
      ) : null}
    </div>
  );
}
