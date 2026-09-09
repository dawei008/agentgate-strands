// 四 Tab 枢纽的纯派生（ADR-0016 ①③ + Tab 小字）。组件只摆版面，口径都在这里。
// 数据源：agent_status（home/types.ts）、list_plan_runs（plan/types.ts）、
// list_recent_runs（../types.ts）。算不出一律 null，组件画「—」，不编数。
import { effectiveScore, STATUS_LABEL } from "../../../../lib/scoring";
import { runPassRate, runRedteamTally, sortRunsDesc } from "../../../plan/derive";
import type { PlanRunSummary } from "../../../plan/types";
import { fmtStamp, proposalCounts } from "../../home/derive";
import type { AgentLastRun, AgentStatus } from "../../home/types";
import type { PlanSummary, RunSummary } from "../../types";

/** `#N`：与运行报告 / 计划详情同一个序——按 sortRunsDesc 的数组下标算（最早 = #1）。
 *  run 不在这份历史里 ⇒ null（不编号）。 */
export function seqOf(runs: PlanRunSummary[] | undefined, runKey: string | null | undefined): number | null {
  if (!runs || !runKey) return null;
  const desc = sortRunsDesc(runs);
  const idx = desc.findIndex((r) => r.run_key === runKey);
  return idx < 0 ? null : desc.length - idx;
}

/** 「上一次」：同一计划历史里、比 runKey 更早的第一个 completed run；没有 ⇒ null。
 *  runKey 不在历史里也是 null（不拿别的 run 冒充上一次）。 */
export function prevCompleted(
  runs: PlanRunSummary[] | undefined, runKey: string | null | undefined,
): PlanRunSummary | null {
  if (!runs || !runKey) return null;
  const desc = sortRunsDesc(runs);
  const idx = desc.findIndex((r) => r.run_key === runKey);
  if (idx < 0) return null;
  for (let i = idx + 1; i < desc.length; i++) {
    if (desc[i].status === "completed") return desc[i];
  }
  return null;
}

/** 该 Agent 最近一次 completed run（跨计划；list_recent_runs 投影）；没有 ⇒ null */
export function latestCompleted(pool: RunSummary[] | undefined): RunSummary | null {
  if (!pool) return null;
  const done = pool.filter((r) => r.status === "completed");
  if (done.length === 0) return null;
  return sortRunsDesc(done.map(asPlanRun))[0] as unknown as RunSummary;
}

/** list_recent_runs 行 → PlanRunSummary 形（三个「那边可选、这边必需」字段补 null；
 *  `?? null` 补的是缺键不是 0），与 ComparePage.toViewRun 同一读法。 */
export function asPlanRun<T extends RunSummary>(r: T): T & PlanRunSummary {
  return {
    ...r,
    score: r.score ?? null,
    started_at: r.started_at ?? null,
    duration_s: r.duration_s ?? null,
  } as T & PlanRunSummary;
}

// ---------- ① 最近一次评估 ----------

export interface EvalFacts {
  /** 线上评估分（run 顶层 / observe 环节均值） */
  observe: number | null;
  /** 回归测试通过率 */
  passRate: number | null;
  /** 红队拦截 (attacks − breached) / attacks */
  redteam: { blocked: number; attacks: number } | null;
}

/** 一条 run 摘要 → 三个事实（上一次的口径，与 last_run 的三个字段逐项对齐） */
export function evalFacts(run: PlanRunSummary | null | undefined): EvalFacts {
  if (!run) return { observe: null, passRate: null, redteam: null };
  const rt = runRedteamTally(run);
  return {
    observe: effectiveScore(run),
    passRate: runPassRate(run),
    redteam: rt && rt.attacks > 0 ? { blocked: rt.attacks - rt.breached, attacks: rt.attacks } : null,
  };
}

/** "10/12" → {blocked:10, attacks:12}；解析不出 ⇒ null */
export function parseBlocked(s: string | null | undefined): { blocked: number; attacks: number } | null {
  if (!s) return null;
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(s);
  if (!m) return null;
  const attacks = Number(m[2]);
  return attacks > 0 ? { blocked: Number(m[1]), attacks } : null;
}

/** 有符号差值（不带 ▲▼ 判断词）：+0.03 / −0.02；任一侧 null 或相等 ⇒ null */
export function signedDelta(cur: number | null | undefined, prev: number | null | undefined, digits: number): string | null {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  const d = cur - prev;
  if (Math.abs(d) < Math.pow(10, -digits) / 2) return null;
  return `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(digits)}`;
}

/** 百分点差（0.9444 vs 0.9 → +4.4pp） */
export function signedDeltaPp(cur: number | null | undefined, prev: number | null | undefined): string | null {
  const s = signedDelta(cur == null ? null : cur * 100, prev == null ? null : prev * 100, 1);
  return s ? `${s}pp` : null;
}

// 「算不出」的原因读法（逐项键 → 整体 agent_status）住在 home/derive：首页卡与 ① 现状同一份。
export { reasonOf } from "../../home/derive";

/** 距 now 的相对时刻（下次运行那一格的副读数）：未来「约 N 小时后」/「约 N 天后」，过去 ⇒ null */
export function relFuture(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || ms <= now) return null;
  const h = (ms - now) / 3_600_000;
  if (h < 1) return `约 ${Math.max(1, Math.round(h * 60))} 分钟后`;
  if (h < 48) return `约 ${Math.round(h)} 小时后`;
  return `约 ${Math.round(h / 24)} 天后`;
}

// ---------- Tab 小字 ----------

export interface TabSums {
  status: string | null;
  evaluate: string | null;
  optimize: string | null;
  config: string | null;
}

export function lastRunWord(last: AgentLastRun | null | undefined, seq: number | null): string {
  if (!last) return "未评估";
  const n = seq != null ? ` #${seq}` : "";
  return `run${n} ${STATUS_LABEL[last.status] ?? last.status}`;
}

export function tabSums(input: {
  status: AgentStatus | undefined;
  lastSeq: number | null;
  plans: PlanSummary[] | undefined;
  runs: RunSummary[] | undefined;
  /** list_recent_runs 的 limit（到顶就写 N+） */
  runsLimit: number;
  optimizeRuns: PlanRunSummary[] | undefined;
  version: string;
  configuredBy: "auto" | "manual" | null | undefined;
}): TabSums {
  const st = input.status;
  const status = st
    ? `${st.alerts.length} 条告警 · ${lastRunWord(st.last_run, input.lastSeq)}`
    : null;
  const evaluate = input.plans && input.runs
    ? `${input.plans.length} 计划 · ${input.runs.length}${input.runs.length >= input.runsLimit ? "+" : ""} 次运行`
    : null;
  // ③ 小字：最近一次 completed run 带问题台账 ⇒ 数台账的待处理（待建议 + 未采纳，与台账卡头
  // 同一个数）；老形状（没有 synthesis_issues）⇒ 退回 proposals 的未采纳数
  const thisKey = latestCompleted(input.runs)?.run_key;
  const thisIssues = input.optimizeRuns?.find((r) => r.run_key === thisKey)?.synthesis_issues ?? [];
  const optimize = input.optimizeRuns
    ? thisIssues.length > 0
      ? `${thisIssues.filter((it) => !it.recommendation || it.status === "open").length} 待处理`
      : `${proposalCounts(input.optimizeRuns).pending} 未采纳`
    : null;
  const configWord = input.configuredBy === undefined ? null
    : input.configuredBy ? "已配置" : "未配置";
  const config = [input.version || null, configWord].filter(Boolean).join(" · ") || null;
  return { status, evaluate, optimize, config };
}

export { fmtStamp };
