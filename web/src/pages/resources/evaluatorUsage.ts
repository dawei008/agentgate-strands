// 评估器页「跨 Agent 表现」的纯派生（ADR-0016 舰队级：区分「Agent 差」与「尺子太严」）。
//
// 数据源只有一个：list_recent_runs（跨评估计划 run 流，每条带 agent_name / status /
// stage_summaries）。评估器在某 Agent 上的分从环节摘要里读 ——
//   · dataset 环节 `evaluator_stats[名].mean`（plan/derive.evaluatorRows）
//   · observe 环节 `summary[名].mean_score`（plan/derive.observeEvaluatorRows）
// 两处读法与 Agent 详情 ③ 优化面板（hub/optimizeDerive.evaluatorScores）同源，这里不
// 重抄字段名。红队环节没有逐评估器分，不进这张表。
//
// ⚠️ ADR-0003 硬线：一个数都不跨评估器合成。这里每格是「某评估器在某 Agent 上最近一次
// completed run 的分」，行级判读只**数** Agent，不出任何合成分。
import { SCORE_TARGET, evaluatorRows, observeEvaluatorRows } from "../plan/derive";
import type { StageSummary } from "../plan/types";
import { toMillis } from "../../lib/scoring";

export { SCORE_TARGET };

/** 「长期过不了」的门槛：某 Agent 在该评估器上**连续**这么多次 completed run 都 < 目标线 */
export const STREAK_MIN = 3;

/** list_recent_runs 一行里本派生用到的字段（RunSummary 的子集，宽收：只声明读的键） */
export interface UsageRun {
  run_key: string;
  agent_name: string;
  status: string;
  started_at?: string | number | null;
  stage_summaries?: StageSummary[] | null;
}

export interface AgentCell {
  agent: string;
  /** 该 Agent 最近一次 completed run 里这个评估器的分 */
  latest: number;
  latestRunKey: string;
  /** 从最近一次往回数、连续 < SCORE_TARGET 的 completed run 次数；一次达标即断。过线时为 0 */
  streak: number;
}

export type Verdict =
  /** 所有在用 Agent 都连续 ≥ STREAK_MIN 次未过线 ⇒ 问题更像在尺子 */
  | { kind: "strict" }
  /** 部分 Agent 最近一次未过线（含长期过不了的） */
  | { kind: "partial"; n: number }
  /** 在用 Agent 最近一次都过线 */
  | { kind: "ok" }
  /** 没有任何 run 出过分 */
  | { kind: "none" };

export interface UsageRow {
  name: string;
  /** 有它出分的 Agent（去重），按 Agent 名排序 */
  agents: AgentCell[];
  verdict: Verdict;
}

export interface UsageTable {
  rows: UsageRow[];
  /** 拿到的 run 总数（样本口径「近 N 次 run」的 N） */
  totalRuns: number;
  /** 其中 completed 的条数（真正入统计的） */
  completedRuns: number;
}

/**
 * 一条 run 里每个评估器名 → 分。只读 completed 环节（半截环节的数字不是结论）。
 * 同名评估器在同一 run 的 observe 与 dataset 环节都出分时取**较低**的那个：这张表回答
 * 的是「它在哪些 Agent 上过不了线」，任一环节没过就该算没过。
 */
export function runEvaluatorScores(run: UsageRun): Map<string, number> {
  const out = new Map<string, number>();
  const put = (name: string, mean: number | null) => {
    if (mean == null) return;
    const prev = out.get(name);
    out.set(name, prev == null ? mean : Math.min(prev, mean));
  };
  for (const st of run.stage_summaries ?? []) {
    if (st.status !== "completed") continue;
    if (st.type === "observe") {
      for (const r of observeEvaluatorRows(st)) put(r.name, r.mean);
    } else if (st.type === "dataset") {
      for (const r of evaluatorRows(st)) put(r.name, r.mean);
    }
  }
  return out;
}

/** 最近的在前；started_at 解析不出的排最后 */
function sortRunsNewestFirst(runs: UsageRun[]): UsageRun[] {
  return [...runs].sort((a, b) => (toMillis(b.started_at) || 0) - (toMillis(a.started_at) || 0));
}

/** 从最近一次往回数连续未过线的次数（一次达标即断） */
export function leadingFailStreak(scoresNewestFirst: number[]): number {
  let n = 0;
  for (const s of scoresNewestFirst) {
    if (s >= SCORE_TARGET) break;
    n += 1;
  }
  return n;
}

export function rowVerdict(agents: AgentCell[]): Verdict {
  if (agents.length === 0) return { kind: "none" };
  if (agents.every((a) => a.streak >= STREAK_MIN)) return { kind: "strict" };
  const n = agents.filter((a) => a.latest < SCORE_TARGET).length;
  return n > 0 ? { kind: "partial", n } : { kind: "ok" };
}

/** 排序：「尺子偏严？」在前 → 「N 个 Agent 未过线」按 N 降序 → 其余按在用 Agent 数降序；同档保持传入顺序 */
function verdictRank(v: Verdict): number {
  switch (v.kind) {
    case "strict": return 0;
    case "partial": return 1;
    default: return 2;
  }
}

export function sortUsageRows(rows: UsageRow[]): UsageRow[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ra = verdictRank(a.r.verdict);
      const rb = verdictRank(b.r.verdict);
      if (ra !== rb) return ra - rb;
      if (a.r.verdict.kind === "partial" && b.r.verdict.kind === "partial" && a.r.verdict.n !== b.r.verdict.n) {
        return b.r.verdict.n - a.r.verdict.n;
      }
      if (a.r.agents.length !== b.r.agents.length) return b.r.agents.length - a.r.agents.length;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/**
 * @param runs list_recent_runs 返回的 run（任意顺序、任意状态；这里只算 completed）
 * @param evaluatorNames 评估器页列出的名字（内置 + 自定义）。没出过分的也照列一行；
 *   run 里出现但不在这份名单里的名字（已删的自定义评估器等）追加在后。
 */
export function deriveEvaluatorUsage(runs: UsageRun[], evaluatorNames: string[]): UsageTable {
  const completed = sortRunsNewestFirst(runs.filter((r) => r.status === "completed"));
  // 评估器 → Agent → 分（最近的在前）
  const byEval = new Map<string, Map<string, { scores: number[]; latestRunKey: string }>>();
  for (const run of completed) {
    for (const [name, score] of runEvaluatorScores(run)) {
      let agents = byEval.get(name);
      if (!agents) { agents = new Map(); byEval.set(name, agents); }
      const cell = agents.get(run.agent_name);
      if (cell) cell.scores.push(score);
      else agents.set(run.agent_name, { scores: [score], latestRunKey: run.run_key });
    }
  }
  const names = [...evaluatorNames];
  for (const n of byEval.keys()) if (!names.includes(n)) names.push(n);
  const rows: UsageRow[] = names.map((name) => {
    const agents: AgentCell[] = [...(byEval.get(name) ?? new Map<string, { scores: number[]; latestRunKey: string }>()).entries()]
      .map(([agent, c]) => ({
        agent, latest: c.scores[0], latestRunKey: c.latestRunKey, streak: leadingFailStreak(c.scores),
      }))
      .sort((a, b) => a.agent.localeCompare(b.agent));
    return { name, agents, verdict: rowVerdict(agents) };
  });
  return { rows: sortUsageRows(rows), totalRuns: runs.length, completedRuns: completed.length };
}

// 分数展示不在本模块：**同名遮蔽** lib/scoring.fmtScore 的那份已删（它少了 null
// 分支，且四舍五入让 [0.695,0.70) 印成 "0.70" 而同一枚 chip 的 warn 态说「低于
// 0.70」）。消费方 EvaluatorUsage.tsx 直接用 lib/scoring.fmtScoreFloor —— chip 的
// 分与它自己的过/未过着色并排，属于「与阈值结论并排」那一档。

/** Agent chip 深链：Agent 详情 ③ 优化 Tab（逐评估器面板就在那里） */
export const agentOptimizeHref = (agent: string) => `#/agent/${encodeURIComponent(agent)}/optimize`;
