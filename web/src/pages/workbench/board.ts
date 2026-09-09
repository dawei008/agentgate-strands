// 排程看板推导（纯函数，测试直接盯这里）。回答三个问题：所有计划**什么时候跑**、
// **花多少**、**上次结果如何**（ADR-0016 决定 3 / 舰队级 d）。
//
// 数据来源（实测字段名）：
//   - 定时 / 单次预算：list_plans 的 plan.schedule = {cron, budget_usd}（app/plan.py），
//     历史 DDB 可能残留旧字符串形态（只有 cron 没有预算）。
//   - 下次运行：前端 cronEngine 按 cron 推算（后端 list_plans 不带 next_run）。
//     rate(...) 的相位由 EventBridge 创建时刻决定，前端推不出 —— 写「相位未知」，
//     绝不伪造时刻。
//   - 本月花费：list_recent_runs 每行的 total_cost_usd（planrun.py:_run_from_item），
//     只算本月 UTC 内 status=completed 的 run；list_recent_runs 只取最近 N 条，所以
//     这是**近 N 条里的**本月合计，title 里注明来源。
//   - 最近结果：list_plans 出口 join 的 plan.last_run（runOutcome 按环节判定）。
import type { Plan } from "../../lib/apiTypes";
import type { RunRow } from "./types";
import { scheduleCron } from "../plan/types";
import { fmtUTC, humanize, isRate, nextRuns, pad, parseCron, rateHuman } from "../plan/cronEngine";
import { parseUtc, runOutcome, toMillis, type RunOutcomeKind } from "../../lib/scoring";

export type ScheduleKind = "none" | "cron" | "rate" | "invalid";

export interface BoardRow {
  plan: Plan;
  /** 原始定时表达式；无定时为空串 */
  cron: string;
  kind: ScheduleKind;
  /** 定时列人话：cron 走 humanize；rate 走「每 n 单位」；无定时「手动」；解析失败给原串 */
  cronText: string;
  /** 解析失败时 cronEngine 的错误原话（进 title） */
  cronError: string | null;
  /** schedule.budget_usd；字符串形态/无定时 → null */
  budget: number | null;
  /** 本月 UTC completed run 的 total_cost_usd 之和；样本 0 → null */
  monthSpend: number | null;
  monthSpendN: number;
  /** cron 才有；rate / 无定时 / 解析失败 → null */
  nextRun: Date | null;
  /** 下次运行列文案 */
  nextRunText: string;
  /** 最近结果排序权重（越小越差；未运行沉底） */
  outcomeRank: number;
}

export interface BoardAlert {
  /** 带定时且最近一次 run 失败 / 部分失败的计划 */
  badScheduled: BoardRow[];
  /** 所有计划本月花费合计；样本 0 → null */
  monthSpend: number | null;
  monthSpendN: number;
  planCount: number;
  scheduledCount: number;
  /** 全表最早的下次运行（cron 可推算者） */
  next: BoardRow | null;
  /** 有 rate 计划但推不出相位 */
  hasRate: boolean;
}

export interface Board {
  rows: BoardRow[];
  alert: BoardAlert;
}

/** 最近结果排序权重：越小越差。failed 与后端已判 error 的 run 同档（都是「跑坏了」），
 *  partial 次之，nodata（空转）再次，skipped/running 中性，ok 最后；未运行沉底。 */
const OUTCOME_RANK: Record<RunOutcomeKind, number> = {
  failed: 0,
  partial: 1,
  nodata: 2,
  status: 3,
  ok: 5,
};
export const RANK_BAD_MAX = OUTCOME_RANK.partial;
const RANK_NEVER_RUN = 9;

export function outcomeRankOf(lastRun: Plan["last_run"]): number {
  if (!lastRun) return RANK_NEVER_RUN;
  const oc = runOutcome(lastRun);
  if (oc.kind === "status" && (lastRun.status === "error" || lastRun.status === "failed")) return OUTCOME_RANK.failed;
  return OUTCOME_RANK[oc.kind];
}

/** rate(n unit) → 「每 n 单位」；人话与单位白名单都住在 cronEngine（rateHuman），这里只调用。
 *  非 rate 原样返回（定时列的降级口径：认不出就把原串给人看）。 */
export function rateText(expr: string): string {
  return rateHuman(expr) ?? expr;
}

export const RATE_PHASE_UNKNOWN = "rate 周期 · 相位未知";

/** 下次运行短式：MM-DD HH:mm（表格列）；fmtUTC 带周几，hero 用 */
export function fmtNext(d: Date): string {
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export { fmtUTC };

function sameUtcMonth(ms: number, now: number): boolean {
  const a = new Date(ms);
  const b = new Date(now);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

/** 一批 run 的本月 UTC completed 花费：{sum, n}；n=0 时 sum 无意义 */
export function monthSpendOf(runs: RunRow[], now: number): { sum: number; n: number } {
  let sum = 0;
  let n = 0;
  for (const r of runs) {
    if (r.status !== "completed") continue;
    if (typeof r.total_cost_usd !== "number" || !Number.isFinite(r.total_cost_usd)) continue;
    const t = toMillis(r.started_at);
    if (!Number.isFinite(t) || !t || !sameUtcMonth(t, now)) continue;
    sum += r.total_cost_usd;
    n += 1;
  }
  return { sum, n };
}

export function deriveRow(plan: Plan, runs: RunRow[], now: number): BoardRow {
  const cron = scheduleCron(plan.schedule).trim();
  const budget = typeof plan.schedule === "object" && plan.schedule != null
    && typeof plan.schedule.budget_usd === "number" && plan.schedule.budget_usd > 0
    ? plan.schedule.budget_usd : null;

  let kind: ScheduleKind = "none";
  let cronText = "手动";
  let cronError: string | null = null;
  let nextRun: Date | null = null;
  let nextRunText = "—";
  if (cron) {
    if (isRate(cron)) {
      kind = "rate";
      cronText = rateText(cron);
      nextRunText = RATE_PHASE_UNKNOWN;
    } else {
      const p = parseCron(cron);
      if (p.ok) {
        kind = "cron";
        cronText = humanize(p) ?? cron;
        nextRun = nextRuns(p, new Date(now), 1)[0] ?? null;
        nextRunText = nextRun ? fmtNext(nextRun) : "—";
      } else {
        kind = "invalid";
        cronText = cron;
        cronError = p.err;
      }
    }
  }

  const mine = runs.filter((r) => r.plan_id === plan.plan_id);
  const spend = monthSpendOf(mine, now);

  const outcomeRank = outcomeRankOf(plan.last_run);

  return {
    plan, cron, kind, cronText, cronError, budget,
    monthSpend: spend.n ? spend.sum : null, monthSpendN: spend.n,
    nextRun, nextRunText, outcomeRank,
  };
}

/** 排序组：可推算下次运行 0 → 带定时但推不出（rate / 解析失败）1 → 无定时 2 */
function scheduleGroup(r: BoardRow): number {
  if (r.nextRun) return 0;
  if (r.kind === "none") return 2;
  return 1;
}

export function compareRows(a: BoardRow, b: BoardRow): number {
  const ga = scheduleGroup(a);
  const gb = scheduleGroup(b);
  if (ga !== gb) return ga - gb;
  if (a.nextRun && b.nextRun && a.nextRun.getTime() !== b.nextRun.getTime()) {
    return a.nextRun.getTime() - b.nextRun.getTime();
  }
  if (a.outcomeRank !== b.outcomeRank) return a.outcomeRank - b.outcomeRank;
  return a.plan.name.localeCompare(b.plan.name, "zh-Hans-CN");
}

export function deriveBoard(
  plans: Plan[] | undefined,
  runs: RunRow[] | undefined,
  now: number = Date.now(),
): Board {
  const rs = runs ?? [];
  const rows = (plans ?? []).map((p) => deriveRow(p, rs, now)).sort(compareRows);

  const badScheduled = rows.filter((r) => r.kind !== "none" && r.outcomeRank <= RANK_BAD_MAX);
  const spend = monthSpendOf(rs.filter((r) => rows.some((row) => row.plan.plan_id === r.plan_id)), now);
  const next = rows.find((r) => r.nextRun) ?? null;
  return {
    rows,
    alert: {
      badScheduled,
      monthSpend: spend.n ? spend.sum : null,
      monthSpendN: spend.n,
      planCount: rows.length,
      scheduledCount: rows.filter((r) => r.kind !== "none").length,
      next,
      hasRate: rows.some((r) => r.kind === "rate"),
    },
  };
}

/** 近 24h 运行数（与旧 KPI 同口径：started_at 落在 now-24h 内） */
export function runs24hOf(runs: RunRow[] | undefined, now: number): number {
  const dayAgo = now - 24 * 3600_000;
  return (runs ?? []).filter((r) => {
    const t = parseUtc(r.started_at);
    return Number.isFinite(t) && t >= dayAgo && t <= now;
  }).length;
}
