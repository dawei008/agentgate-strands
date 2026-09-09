// 首页（Agent 总览 · 观测视角）的纯派生：口径与排版都在这里，组件只摆版面。
// 数据来源见 home/types.ts（fleet_status）与 ../types.ts（list_recent_runs / list_plan_runs）。
import { SCORE_TARGET } from "../../plan/derive";
import { runOutcome, isStageEffective, toMillis } from "../../../lib/scoring";
import { fmtTime } from "../../../lib/time";
import type { RunProposal } from "../../plan/types";
import type { RunSummary } from "../types";
import type { AgentStatus, HourlyBucket, MetricPair, NextRun, TodoItem } from "./types";

// ---------- 排版 ----------

/** 整数千分位（会话量）；null → "—" */
export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** 比率 → 百分数一位小数（0.018 → "1.8%"）；null / 非有限数 → "—"。
 *  实现已搬到 **lib/scoring.fmtPct**（全站唯一，与整数档 fmtPctInt 一起分档：
 *  本页这五个观测数的分母是会话量级，值落在 0.4%~2.3%，整数档会把它们压成同一个
 *  "0%"/"1%"）。保留本导出：五个消费面（FleetHero / AgentCard / StatusPanel /
 *  hub/topology / AgentsPage）从这里取，不必逐个改 import。 */
export { fmtPct } from "../../../lib/scoring";

/** 毫秒 → 秒一位小数（3400 → "3.4s"）；null → "—" */
export function fmtSec(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 美元两位小数；null → "—" */
export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `$${v.toFixed(2)}`;
}

const ARROW = (d: number) => (d > 0 ? "▲" : "▼");

/** 差值排版（与 fmt 同单位）：0 / null → "—"；否则 "▲ 0.4pp" 之类 */
export function fmtDelta(
  delta: number | null | undefined,
  render: (abs: number) => string,
): string {
  if (delta == null || !Number.isFinite(delta) || delta === 0) return "—";
  return `${ARROW(delta)} ${render(Math.abs(delta))}`;
}

/** 比率差 → 百分点（0.004 → "▲ 0.4pp"） */
export const fmtDeltaPp = (d: number | null | undefined) =>
  fmtDelta(d, (a) => `${(a * 100).toFixed(1)}pp`);
/** 毫秒差 → 秒 */
export const fmtDeltaSec = (d: number | null | undefined) =>
  fmtDelta(d, (a) => `${(a / 1000).toFixed(1)}s`);
/** 美元差 */
export const fmtDeltaUsd = (d: number | null | undefined) =>
  fmtDelta(d, (a) => `$${a.toFixed(2)}`);

/** 相对前一日的百分比变化（sessions）：prev 为 0/null → "—" */
export function fmtDeltaPct(m: MetricPair | null | undefined): string {
  if (!m || m.value == null || m.prev == null || m.prev === 0) return "—";
  const d = (m.value - m.prev) / m.prev;
  if (d === 0) return "—";
  return `${ARROW(d)} ${(Math.abs(d) * 100).toFixed(1)}%`;
}

/**
 * 差值的语义类：五个观测数都是「越小越好」，上升 = 变差 → warn（琥珀）；
 * 下降 = 变好 → 默认色（不用绿：绿在全站是「达标」，这里没有目标线）；
 * 0 / null → flat。
 */
export function deltaClass(delta: number | null | undefined): "warn" | "flat" | "" {
  if (delta == null || !Number.isFinite(delta) || delta === 0) return "flat";
  return delta > 0 ? "warn" : "";
}

// 下面两个都只是 lib/time.fmtTime 的**粒度**差别，解析一律交给它 —— 此前这里私写
// `Date.parse` + `toISOString().slice(…)`，与 fmtTime 同形但丢了它攒的三道处理
// （剥 " UTC" 后缀 / 认裸 epoch 串 / 把数字 0 当缺失）。缺失占位符两处不同，那是
// 各自版面决定的（小时轴上一个破折号会把刻度撑歪），留在调用侧。

/** ISO → "MM-DD HH:mm"（UTC）；解析失败 → 原样；无值 → "—" */
export function fmtStamp(iso: string | null | undefined): string {
  return fmtTime(iso, "md-hm");
}

/** ISO → "HH:mm"（UTC）；解析失败 → 原样；无值 → **空串**（小时轴上不占位） */
export function fmtHour(iso: string | null | undefined): string {
  return iso ? fmtTime(iso, "hm") : "";
}

/** 24 桶 → 峰值桶（并列取最早）；空数组 → null */
export function peakBucket(hourly: HourlyBucket[] | undefined | null): HourlyBucket | null {
  if (!hourly || hourly.length === 0) return null;
  return hourly.reduce((best, b) => (b.sessions > best.sessions ? b : best), hourly[0]);
}

// ---------- 评估行 ----------

export interface EvalGate {
  /** 均分 ≥ 目标线的评估器数 */
  passed: number;
  /** 该 run 线上评估 / 回归测试环节配的评估器数 */
  total: number;
}

/**
 * 「M/K 评估器过线」：K = 该 run 里**产出了有效结果**的线上评估 / 回归测试环节的
 * 评估器数（observe 取 `summary` 的键；dataset 取 `evaluators`，缺则取 `evaluator_stats`
 * 的键），M = 均分 ≥ SCORE_TARGET（0.70，与告警同一条线）的个数。
 * **不显示合成均分**（ADR-0016 分数口径修订）。一个可数的评估器都没有 → null（画「—」）。
 * 红队环节不进这个分母（拦截率不是均分）。
 */
export function evaluatorGate(run: RunSummary | null | undefined): EvalGate | null {
  if (!run || !run.stage_summaries) return null;
  let passed = 0;
  let total = 0;
  for (const s of run.stage_summaries) {
    if (!isStageEffective(s)) continue;
    const st = s as Record<string, unknown>;
    if (s.type === "observe") {
      const summary = (st.summary ?? {}) as Record<string, { mean_score?: number | null }>;
      for (const v of Object.values(summary)) {
        total += 1;
        if (typeof v?.mean_score === "number" && v.mean_score >= SCORE_TARGET) passed += 1;
      }
    } else if (s.type === "dataset") {
      const stats = (st.evaluator_stats ?? {}) as Record<string, { mean?: number | null }>;
      const names = Array.isArray(st.evaluators) && (st.evaluators as string[]).length > 0
        ? (st.evaluators as string[])
        : Object.keys(stats);
      for (const name of names) {
        total += 1;
        const mean = stats[name]?.mean;
        if (typeof mean === "number" && mean >= SCORE_TARGET) passed += 1;
      }
    }
  }
  return total > 0 ? { passed, total } : null;
}

/** 失败 run 的原因：run 级 `error`，否则第一个失败环节的 `error`；都没有 → null */
export function runFailureReason(run: RunSummary | null | undefined): string | null {
  if (!run) return null;
  const top = (run as { error?: string | null }).error;
  if (typeof top === "string" && top.trim()) return top.trim();
  for (const s of run.stage_summaries ?? []) {
    if ((s.status === "error" || s.status === "failed") && s.error) return String(s.error);
  }
  return null;
}

/** 下次运行那一格：无定时 / 推不出（带原因） / 时刻 */
export function nextRunText(
  next: NextRun | null | undefined,
  reasons: Record<string, string> | undefined,
): { text: string; title?: string } {
  if (!next) return { text: "无定时" };
  if (!next.at) return { text: "下次 —", title: reasons?.["next_run.at"] };
  return { text: `下次 ${fmtStamp(next.at)}` };
}

// ---------- 优化行 ----------

export interface ProposalCounts {
  /** adopted_at 为空的处方 */
  pending: number;
  /** 已采纳且下一次 run 判定 improved（`adoption_effect.verdict`） */
  verified: number;
}

/** 一个计划全部 run 上挂的处方数目（list_plan_runs 每行带 proposals；
 *  PlanRunSummary 类型没声明这个键 —— 与 ComparePage 的采纳追踪表同一读法，按行现取） */
export function proposalCounts(runs: ReadonlyArray<object>): ProposalCounts {
  let pending = 0;
  let verified = 0;
  for (const r of runs) {
    const raw = (r as { proposals?: unknown }).proposals;
    const list = Array.isArray(raw) ? (raw as RunProposal[]) : [];
    for (const p of list) {
      if (!p.adopted_at) { pending += 1; continue; }
      const effect = (p as { adoption_effect?: { verdict?: unknown } | null }).adoption_effect;
      if (effect?.verdict === "improved") verified += 1;
    }
  }
  return { pending, verified };
}

// ---------- 状态 / 排序 ----------

export type Severity = "bad" | "warn" | "ok" | "none";

/**
 * 卡片右上状态：
 *   bad  = 最近一次 run 失败（status error/failed，或按环节判定全失败）
 *   warn = 有评估器连续未过线告警，或最近一次 run 部分失败
 *   none = 从未评估（last_run null）
 *   ok   = 其余
 */
export function agentSeverity(
  status: AgentStatus | null | undefined,
  lastRow: RunSummary | null | undefined,
): Severity {
  if (!status || !status.last_run) return "none";
  const st = status.last_run.status;
  if (st === "error" || st === "failed") return "bad";
  if (lastRow) {
    const o = runOutcome({ status: lastRow.status, score: lastRow.score ?? null,
                           stage_summaries: lastRow.stage_summaries });
    if (o.kind === "failed") return "bad";
    if (o.kind === "partial") return "warn";
  }
  if (status.alerts.length > 0) return "warn";
  return "ok";
}

export function severityBadge(sev: Severity): { cls: string; label: string } {
  switch (sev) {
    case "bad": return { cls: "badge bad", label: "run 失败" };
    case "warn": return { cls: "badge warn", label: "告警" };
    case "ok": return { cls: "badge ok", label: "正常" };
    default: return { cls: "badge", label: "未评估" };
  }
}

export type SortKey = "priority" | "volume" | "cost" | "name";
export const SORT_KEYS: Array<{ key: SortKey; label: string }> = [
  { key: "priority", label: "最需要动手" },
  { key: "volume", label: "会话量" },
  { key: "cost", label: "成本" },
  { key: "name", label: "名称" },
];

export interface SortableRow {
  name: string;
  severity: Severity;
  alerts: number;
  sessions: number | null;
  cost: number | null;
}

const SEV_RANK: Record<Severity, number> = { bad: 0, warn: 1, ok: 2, none: 3 };
const descNullLast = (a: number | null, b: number | null) =>
  (a == null ? 1 : b == null ? -1 : a === b ? 0 : b - a);

/** 排序（稳定；null 数值一律沉底，名称作最终 tiebreak） */
export function sortRows<T extends SortableRow>(rows: T[], key: SortKey): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  return [...rows].sort((a, b) => {
    switch (key) {
      case "priority":
        return (SEV_RANK[a.severity] - SEV_RANK[b.severity])
          || (b.alerts - a.alerts)
          || descNullLast(a.sessions, b.sessions)
          || byName(a, b);
      case "volume": return descNullLast(a.sessions, b.sessions) || byName(a, b);
      case "cost": return descNullLast(a.cost, b.cost) || byName(a, b);
      default: return byName(a, b);
    }
  });
}

// ---------- 待处理动作 ----------

const enc = encodeURIComponent;

/** 待处理动作卡的按钮文案（后端本版只产 view；run / adopt 留在枚举里，前端按枚举映射） */
export function todoActionLabel(action: TodoItem["action"]): string {
  switch (action) {
    case "run": return "运行";
    case "adopt": return "采纳";
    default: return "去看";
  }
}

/**
 * 动作落点：view → 该 Agent 详情；run → 该计划的运行入口（计划详情页）；
 * adopt → 该 Agent 详情（优化区随 ADR-0016 ③ 落在那里；评估分析页需要两个 run_key，
 * 一条 todo 只带一个，这里不拼假对）。
 */
export function todoHref(item: TodoItem): string {
  if (item.action === "run" && item.target?.plan_id) return `#/plan/${enc(item.target.plan_id)}`;
  return `#/agent/${enc(item.agent_name)}`;
}

/** 待处理 kicker：层 + 类别（「观测 · run 失败」「评估 · 未过线」） */
export function todoKicker(item: TodoItem): string {
  const layer = item.layer === "evaluate" ? "评估" : "观测";
  switch (item.kind) {
    case "run_failed": return `${layer} · run 失败`;
    case "evaluator_below_target": return `${layer} · 未过线`;
    case "budget": return `${layer} · 预算`;
    default: return `${layer} · 告警`;
  }
}

export function todoSeverity(item: TodoItem): "bad" | "warn" {
  return item.kind === "run_failed" ? "bad" : "warn";
}

// ---------- 「算不出」的原因（unavailable_reason 的唯一读法） ----------
//
// 后端两种粒度：逐项键（`metrics.sessions` / `last_run.dataset_pass_rate` / `next_run.at` …）
// 与整个 Agent 计算抛异常时只写的 `agent_status`（此时逐项键一个都没有）。读法只此一份：
// 先取这一项自己的原因，没有就退到整体那句 —— 首页卡、① 现状五数三卡都调它。

/** 「—」旁边的原因（允许进 title：它是**这一次**算不出的事实，不是通用散文） */
export function reasonOf(
  status: { unavailable_reason?: Record<string, string> | null } | null | undefined,
  key: string,
): string | undefined {
  return status?.unavailable_reason?.[key] ?? status?.unavailable_reason?.agent_status;
}

/** 这一个 Agent 算不出**观测数**：五个数任一有自己的原因（metrics.*），或整块计算抛了异常
 *  （agent_status）。`last_run.*` / `next_run.*` / `cloudwatch_url` 这些键不算「无观测数据」
 *  —— 舰队 hero 的「N 个 Agent 无观测数据」按这个判据数。 */
export function isUnobserved(reason: Record<string, string> | null | undefined): boolean {
  return Object.keys(reason ?? {}).some((k) => k.startsWith("metrics.") || k === "agent_status");
}

// ---------- 数据新鲜度（首页那行「缓存于 …」的两个来源分开算） ----------

const DAY_S = 86_400;

/** 整秒 → 「N 秒前 / N 分钟前 / N 小时前 / N 天前」；null / 负数 → "—" */
export function fmtAgo(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.floor(seconds)} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < DAY_S) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / DAY_S)} 天前`;
}

/** discover.refreshed_at（epoch 秒 / 可解析时刻串）→ 距 nowMs 的整秒数；认不出 → null。
 *  解析走 lib/scoring.toMillis（数字按秒、串剥 " UTC" 后缀），不另写一份 Date.parse。 */
export function ageSeconds(stamp: number | string | null | undefined, nowMs: number): number | null {
  const ms = toMillis(stamp);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((nowMs - ms) / 1000));
}

/** Agent 目录是否超过观测窗口（默认 24h，与 catalog.CATALOG_MAX_AGE_SECONDS 同数）：
 *  严格大于；年龄认不出 ⇒ 不判超窗（不拿「不知道」冒充「过期」） */
export function catalogOverWindow(ageS: number | null, windowHours = 24): boolean {
  return ageS != null && ageS > windowHours * 3600;
}
