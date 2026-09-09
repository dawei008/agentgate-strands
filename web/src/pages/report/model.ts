// 报告页（变体 A「评估器优先」）的**页级**聚合：把 reportRows 的环节级派生
// （reportGroups / evaluatorTiles / stageMetricsOf）拼成整页要的几个数。
// 纯函数、零 JSX，便于直测；行层与评估器层的口径都在 pages/plan/reportRows.ts，
// 这里只做「跨环节相加」与「挑最差」两件事，不发明第三种口径。
import { stageDisplayLabel, type StageLabelCtx } from "../plan/derive";
import { UNIT_WORD } from "../plan/compare/derive";
import {
  conversationText, evaluatorTiles, evaluatorVerdictFacts, stageMetricsOf,
  type EvaluatorTile, type EvaluatorVerdictFacts, type ReportGroup, type ReportRow,
  type StageMetrics,
} from "../plan/reportRows";
import type { SynthesisIssue } from "../plan/types";
import type { ScoredFrom } from "../../lib/apiTypes";
import { fmtPctInt } from "../../lib/scoring";

/** 环节行的单位名词（矩阵行头 / 结论一句 / hero 第二格都用它）：表在
 *  plan/compare/derive.UNIT_WORD（全站唯一一份）；认不出的环节类型退到「行」。 */
export function unitOf(type: string): string {
  return UNIT_WORD[type] ?? "行";
}

// ---------- 只用上报数据评估（ADR-0019 批 1）：行级 trace 标记 ----------
//
// 后端在每条回归用例 / 红队攻击行上写 `trace: {status, reason, spans}`（testrun.trace_field），
// 环节摘要上写 `trace_summary: {required, ok, no_trace}`。no_trace 的行**不打分**：矩阵格
// 显示「无 trace」而不是分，行态归「没跑成」（rowTally / 结论一句的 none），评估器 tile
// 的均分与通过率把它剔掉（后端 evaluator_stats 同一口径）。四种原因是后端的键名原话，
// 这里只配一句解释进 title。

export type TraceReason = "no_span" | "no_content" | "no_span_source" | "fetch_error" | "unsampled";
export interface TraceMark {
  status: "ok" | "no_trace";
  reason: TraceReason | null;
  spans: number;
  /** 真去查过的日志组（主 span 组 + 回退的 runtime 日志组）；老形态缺键 → [] */
  sources: string[];
  /** 批 2：这一行的评分输入出身（行上 `scored_from`）；批 1 形态 / 没判的行 → null */
  scoredFrom: ScoredFrom | null;
  /** 批 2：InvokeAgentRuntime 的返回与 trace 还原的最终回复是否一致（`response_matches_trace`）；
   *  没判 / 批 1 形态 → null */
  responseMatches: boolean | null;
  /** 批 2：原返回文本（`output_response`，后端截 4000 字）；没判 / 批 1 形态 → "" */
  outputResponse: string;
  /** 批 3（红队行）：驾驭时被测 Agent 返回的那份对话（`conversation_response`，角色标注逐条
   *  拼接后的文本）；回归行 / 没判 / 批 1、批 2 形态 → ""。评分用的那份在行的 `conversation` 上。 */
  responseConversation: string;
}

type ScoringKeys = "scoredFrom" | "responseMatches" | "outputResponse" | "responseConversation";

/** 行上的评分出身键 → 评分出身；缺键即 null（老 run / 关着开关 / 没判的 no_trace 行）。
 *  批 2 的回归行给 `output_response`（文本），批 3 的红队行给 `conversation_response`（对话数组）。 */
export function scoringOf(rawRow: unknown): Pick<TraceMark, ScoringKeys> {
  const r = (rawRow && typeof rawRow === "object" ? rawRow : {}) as {
    scored_from?: unknown; response_matches_trace?: unknown; output_response?: unknown;
    conversation_response?: unknown;
  };
  const scoredFrom = r.scored_from === "trace" || r.scored_from === "response" ? r.scored_from : null;
  return {
    scoredFrom,
    responseMatches: scoredFrom && typeof r.response_matches_trace === "boolean" ? r.response_matches_trace : null,
    outputResponse: scoredFrom && typeof r.output_response === "string" ? r.output_response : "",
    responseConversation: scoredFrom ? conversationText(r.conversation_response) : "",
  };
}

/** 按 trace 评分的格 title（状态不是散文：只在按 trace 判过分的行上出现；返回与 trace
 *  不一致时多一段，一致时不说）。不是按 trace 评分的行 → ""（不写 title）。 */
export function scoredTitle(mark: TraceMark | null): string {
  if (!mark || mark.scoredFrom !== "trace") return "";
  return mark.responseMatches === false ? "按 trace 评分 · 返回与 trace 不一致" : "按 trace 评分";
}

/** 五种 no_trace 原因 → 格 title 一句（键名是后端原话 testrun.TRACE_REASON_*；句子只解释那个键） */
export const TRACE_REASON_TEXT: Record<TraceReason, string> = {
  no_span: "查过的 span 日志组里都没有该会话的 Agent 侧 span（只有平台自家的调用记录，或什么都没有）",
  no_content: "有该会话的 Agent 侧 span，但没有 gen_ai 对话内容（只有元数据）",
  no_span_source: "该 Agent 没有可读的 span 日志组（无 runtime 日志组也无 span 源，或日志组不存在）",
  fetch_error: "核对 span 时查询出错（限流 / 超时），该会话未能核对",
  unsampled: "平台自己这次调用的 trace 未被采样，被测 Agent 随之丢弃整条 trace——不是 Agent 没接观测",
};

/** 一条结果行上的 trace 标记；老 run / 关着开关的 run 缺键 → null（矩阵形态不变）。
 *  rawRow（可选）是整条结果行：批 2 的评分出身三键住在行上，不在 trace 子对象里。 */
export function traceMarkOf(raw: unknown, rawRow?: unknown): TraceMark | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as { status?: unknown; reason?: unknown; spans?: unknown; sources?: unknown };
  if (t.status !== "ok" && t.status !== "no_trace") return null;
  const reason = typeof t.reason === "string" && t.reason in TRACE_REASON_TEXT ? (t.reason as TraceReason) : null;
  const sources = Array.isArray(t.sources) ? t.sources.filter((s): s is string => typeof s === "string" && s !== "") : [];
  return { status: t.status, reason, spans: typeof t.spans === "number" ? t.spans : 0, sources, ...scoringOf(rawRow) };
}

/** 行 → 标记：行的 `order` 是后端原序下标（reportGroups 排序前记下），与
 *  `detail.report.results[]` 一一对应（caseRows / attackRowsOf 都是 1:1 map）。 */
export function traceOf(group: ReportGroup, row: ReportRow): TraceMark | null {
  if (row.order == null) return null;
  const raws = group.detail?.report?.results;
  if (!Array.isArray(raws)) return null;
  const raw = raws[row.order] as { trace?: unknown } | undefined;
  return traceMarkOf(raw?.trace, raw);
}

/** 格 / 行的 title：原因原话（键名 + 一句解释 + 查到几条 span） */
export function traceTitle(mark: TraceMark): string {
  const why = mark.reason ? `${mark.reason} · ${TRACE_REASON_TEXT[mark.reason]}` : "no_trace";
  const where = mark.sources.length > 0 ? ` · 查过 ${mark.sources.join(" 与 ")}` : "";
  return `无 trace · ${why}${where} · Agent 侧 span ${mark.spans} 条`;
}

/** no_trace 行的有效行态：它没有分，归「没跑成」 */
export function effectiveOutcome(row: ReportRow, mark: TraceMark | null): ReportRow["outcome"] {
  return mark?.status === "no_trace" ? "none" : row.outcome;
}

/** 一个环节在页上的投影：展示名 + 评估器 tile + 聚合指标 */
export interface StageView {
  group: ReportGroup;
  label: string;
  unit: string;
  tiles: EvaluatorTile[];
  metrics: StageMetrics | null;
  /** 行 key → trace 标记（只有开了只用上报数据评估的回归 / 红队环节有条目） */
  traces: Map<string, TraceMark>;
}

export function stageViews(groups: ReportGroup[], ctx: StageLabelCtx): StageView[] {
  return groups.map((group) => {
    const traces = new Map<string, TraceMark>();
    for (const r of group.rows) {
      const m = traceOf(group, r);
      if (m) traces.set(r.key, m);
    }
    // tile 的均分 / 通过率剔掉 no_trace 行（后端 _evaluator_stats 同一口径）；没有标记
    // 的环节原样传，不复制
    const scored = traces.size
      ? { ...group, rows: group.rows.filter((r) => traces.get(r.key)?.status !== "no_trace") }
      : group;
    return {
      group,
      label: stageDisplayLabel(group.stage, group.index, ctx),
      unit: unitOf(group.type),
      tiles: evaluatorTiles(scored),
      // metrics 只在 S3 明细环节上（DDB 摘要没有）；两份都试，先明细
      metrics: stageMetricsOf(group.detail) ?? stageMetricsOf(group.stage),
      traces,
    };
  });
}

/** run 头部降级 badge 的料：开了开关的环节里 ok / no_trace 各几行（没开 → null）。
 *  先读 DDB 摘要的 trace_summary（S3 缺时也在），没有就按行标记现数。 */
export interface TraceTally {
  ok: number;
  noTrace: number;
  /** 全部行都 no_trace（任一开了开关的环节 status = no_trace，或没有一行 ok） */
  allMissing: boolean;
}

export function traceTally(views: StageView[]): TraceTally | null {
  let ok = 0;
  let noTrace = 0;
  let any = false;
  for (const v of views) {
    const s = v.group.stage.trace_summary;
    if (s && typeof s === "object") {
      any = true;
      ok += Number(s.ok) || 0;
      noTrace += Number(s.no_trace) || 0;
      continue;
    }
    if (v.traces.size === 0) continue;
    any = true;
    for (const m of v.traces.values()) if (m.status === "ok") ok += 1; else noTrace += 1;
  }
  if (!any) return null;
  return { ok, noTrace, allMissing: noTrace > 0 && ok === 0 };
}

/** 矩阵行序 = 后端原序（会话 #1 就是第一条会话）；没记 order 的老夹具保持原数组序 */
export function matrixRows(group: ReportGroup): ReportRow[] {
  return [...group.rows].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** 带环节归属的 tile（多环节 run 里同名评估器可能出现两次，按环节区分） */
export interface TileRef {
  view: StageView;
  tile: EvaluatorTile;
}

export function allTiles(views: StageView[]): TileRef[] {
  return views.flatMap((view) => view.tiles.map((tile) => ({ view, tile })));
}

/** 结论一句的事实料（跨环节）：worst 带回它所在的环节，句子里的单位名词才对得上 */
export interface PageVerdictFacts extends EvaluatorVerdictFacts {
  worstRef: TileRef | null;
  /** 有均分的全部 tile（含 under 与过线；worstRef 在其中） */
  scoredRefs: TileRef[];
  underRefs: TileRef[];
  /** worst 评估器下没过的行 + 最常见的判定标签（judge 原话，英文） */
  worstFailing: { rows: ReportRow[]; label: string | null };
  /** 在 worst 所在环节里「所有评估器都没过」的行（0..n，句子只点第一条） */
  allFailRows: ReportRow[];
  /** 红队：被攻破 / 有结论的攻击数（没有红队环节 → null）。评估器维度说不出它，句子单独带 */
  breached: { n: number; total: number } | null;
  /** 没跑成的行数（空响应 / 调用失败 / 拉取失败 / 无有效结论），跨环节相加 */
  none: number;
}

export function pageVerdictFacts(views: StageView[]): PageVerdictFacts {
  const refs = allTiles(views);
  const base = evaluatorVerdictFacts(refs.map((r) => r.tile));
  const worstRef = base.worst ? refs.find((r) => r.tile === base.worst) ?? null : null;
  const scoredRefs = refs.filter((r) => r.tile.mean != null);
  const underRefs = scoredRefs.filter((r) => r.tile.under);
  let worstFailing: PageVerdictFacts["worstFailing"] = { rows: [], label: null };
  let allFailRows: ReportRow[] = [];
  if (worstRef) {
    const g = worstRef.view.group;
    const name = worstRef.tile.name;
    const labelCount = new Map<string, number>();
    const rows: ReportRow[] = [];
    for (const r of g.rows) {
      const v = r.verdicts.find((x) => x.name === name);
      if (!v || v.errored || v.passed !== false) continue;
      rows.push(r);
      if (v.label) labelCount.set(v.label, (labelCount.get(v.label) ?? 0) + 1);
    }
    let label: string | null = null;
    let best = 0;
    for (const [k, n] of labelCount) if (n > best) { best = n; label = k; }
    worstFailing = { rows, label };
    const evNames = worstRef.view.tiles.map((t) => t.name);
    allFailRows = g.rows.filter((r) => {
      const live = r.verdicts.filter((v) => !v.errored && evNames.includes(v.name));
      return live.length > 0 && live.length === evNames.length && live.every((v) => v.passed === false);
    });
  }
  let breached: { n: number; total: number } | null = null;
  let none = 0;
  for (const v of views) {
    for (const r of v.group.rows) if (effectiveOutcome(r, v.traces.get(r.key) ?? null) === "none") none += 1;
    if (v.group.type === "redteam") {
      // no_trace 的攻击行没有结论：不进攻破 / 有结论计数
      const judged = v.group.rows.filter((r) => r.breached != null && v.traces.get(r.key)?.status !== "no_trace");
      const prev: { n: number; total: number } = breached ?? { n: 0, total: 0 };
      breached = {
        n: prev.n + judged.filter((r) => r.breached === true).length,
        total: prev.total + judged.length,
      };
    }
  }
  return { ...base, worstRef, scoredRefs, underRefs, worstFailing, allFailRows, breached, none };
}

/** hero 第二格：行数按环节单位分开数（「4 会话」/「3 用例 · 3 攻击」），
 *  副行 = 全过 / 有未过项 / 没跑成 三档计数（rowOutcomeOf 的三值）。 */
export interface RowTally {
  parts: { unit: string; count: number }[];
  pass: number;
  fail: number;
  none: number;
}

export function rowTally(views: StageView[]): RowTally {
  const parts: RowTally["parts"] = [];
  let pass = 0;
  let fail = 0;
  let none = 0;
  for (const v of views) {
    if (v.group.rows.length === 0) continue;
    const hit = parts.find((p) => p.unit === v.unit);
    if (hit) hit.count += v.group.rows.length;
    else parts.push({ unit: v.unit, count: v.group.rows.length });
    for (const r of v.group.rows) {
      const o = effectiveOutcome(r, v.traces.get(r.key) ?? null);
      if (o === "pass") pass += 1;
      else if (o === "fail") fail += 1;
      else none += 1;
    }
  }
  return { parts, pass, fail, none };
}

/** 问题条目按 fix_type 计数（SDK RCAItem 三值；空 → OTHERS，与 adviceBucket 同规则） */
export function issueFixTypeCounts(issues: SynthesisIssue[]): { fixType: string; count: number }[] {
  const order = ["SYSTEM_PROMPT_FIX", "TOOL_DESCRIPTION_FIX", "OTHERS"];
  const counts = new Map<string, number>();
  for (const it of issues) {
    const k = it.fix_type === "SYSTEM_PROMPT_FIX" || it.fix_type === "TOOL_DESCRIPTION_FIX"
      ? it.fix_type : "OTHERS";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return order.filter((k) => counts.has(k)).map((k) => ({ fixType: k, count: counts.get(k) as number }));
}

/** 跨环节的指标合计（只有 observe 环节带 metrics；没有一个环节带 → null） */
export interface PageMetrics extends StageMetrics {
  /** 最大时延落在哪一行（tile 深链用） */
  slowest: { groupIndex: number; row: ReportRow } | null;
}

export function pageMetrics(views: StageView[]): PageMetrics | null {
  const withM = views.filter((v) => v.metrics);
  if (withM.length === 0) return null;
  const sum = (pick: (m: StageMetrics) => number | null) => {
    const nums = withM.map((v) => pick(v.metrics as StageMetrics)).filter((n): n is number => n != null);
    return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
  };
  const max = (pick: (m: StageMetrics) => number | null) => {
    const nums = withM.map((v) => pick(v.metrics as StageMetrics)).filter((n): n is number => n != null);
    return nums.length ? Math.max(...nums) : null;
  };
  // 平均时延：按轮次加权没有分母（聚合里只剩 avg），多环节时退到各环节平均的均值
  const avgs = withM.map((v) => (v.metrics as StageMetrics).latencyAvg).filter((n): n is number => n != null);
  const unpriced: string[] = [];
  for (const v of withM) for (const m of (v.metrics as StageMetrics).unpricedModels) if (!unpriced.includes(m)) unpriced.push(m);
  let slowest: PageMetrics["slowest"] = null;
  for (const v of views) {
    for (const r of v.group.rows) {
      const lat = r.metrics?.latencyMax;
      if (lat == null) continue;
      if (!slowest || lat > (slowest.row.metrics?.latencyMax ?? -1)) slowest = { groupIndex: v.group.index, row: r };
    }
  }
  return {
    tokensTotal: sum((m) => m.tokensTotal),
    tokensInput: sum((m) => m.tokensInput),
    tokensOutput: sum((m) => m.tokensOutput),
    costUsd: sum((m) => m.costUsd),
    unpricedModels: unpriced,
    llmCalls: sum((m) => m.llmCalls),
    toolCalls: sum((m) => m.toolCalls),
    latencyAvg: avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null,
    latencyMax: max((m) => m.latencyMax),
    slowest,
  };
}

// ---------- 数字格式（页内统一，三位小数是 judge 分的原生精度） ----------
export const f3 = (n: number) => n.toFixed(3);
export const f2s = (n: number) => `${n.toFixed(2)}s`;
/** 比率 → 百分数整数。实现在 lib/scoring.fmtPctInt（全站唯一）；本页消费点
 *  （EvaluatorTiles 的逐评估器通过率、VerdictLine 的「通过 N%」）分母都是判定会话数，
 *  属整数档。保留本名字：页内两个消费点从这里取，不必逐个改 import。 */
export const pct = fmtPctInt;
