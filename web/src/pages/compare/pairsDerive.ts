// 同题配对 / 会话并排 diff 的**派生与投影**（ADR-0017 D3 / F8，批 compare-frontend）。
// 判据一律住这里，组件只排版：
//   · Δ 箭头方向与色类（升 good / 降 bad / 平中性；单侧无分 ⇒ 无 Δ）
//   · 时间线两侧按 `n` 对位 + 差异判定（文本 / 工具名 / 入参 / 耗时任一不同 = 差异块）
//   · 归档（get_plan_run 的 S3 全量 report）→ 单栏回放要的 SessionSide 投影
//     —— 报告页「回放」与评估分析页未对齐行都走这一份，**不打 compare_sessions**：
//     单栏没有 diff 要算，而这两个入口手里本来就有整份归档（同 queryKey 缓存命中）。
import { fmtCost } from "../../lib/cost";
import { EMPTY_MARK, textOf } from "../../lib/renderText";
import type {
  PairResult, RowPair, SessionAttributes, SessionEvent, SessionSide, SessionSideResult,
} from "../../lib/apiTypes";

// ---------- Δ ----------

export type DeltaDir = "up" | "down" | "flat";

export interface Delta {
  dir: DeltaDir;
  /** 右 − 左 */
  value: number;
}

/** 两侧任一无分 ⇒ null（不画箭头，不画 0）。|Δ| < 0.0005 ⇒ 持平（三位小数下同值）。 */
export function deltaOf(left: number | null | undefined, right: number | null | undefined): Delta | null {
  if (typeof left !== "number" || typeof right !== "number") return null;
  const d = right - left;
  if (Math.abs(d) < 0.0005) return { dir: "flat", value: 0 };
  return { dir: d > 0 ? "up" : "down", value: d };
}

/** 箭头文本：`↑ +0.200` / `↓ −0.200` / `=`（U+2212 减号，与数字同宽字体对齐） */
export function fmtDelta(d: Delta): string {
  if (d.dir === "flat") return "=";
  const abs = Math.abs(d.value).toFixed(3);
  return d.dir === "up" ? `↑ +${abs}` : `↓ −${abs}`;
}

/** 颜色只给状态：升 good / 降 bad / 平中性 */
export const DELTA_CLASS: Record<DeltaDir, string> = { up: "is-up", down: "is-down", flat: "is-flat" };
export const DELTA_WORD: Record<DeltaDir, string> = { up: "升", down: "降", flat: "持平" };

// ---------- 配对表 ----------

/** 配对表的评估器列：两侧 results 键的并集，按左侧出现顺序，再补右侧独有 */
export function pairEvaluators(pairs: RowPair[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of pairs) {
    for (const k of [...Object.keys(p.left_results ?? {}), ...Object.keys(p.right_results ?? {})]) {
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
  }
  return out;
}

export type AlignState = "aligned" | "left-only" | "right-only";

export function alignStateOf(p: RowPair): AlignState {
  if (p.left_row_key != null && p.right_row_key != null) return "aligned";
  return p.left_row_key != null ? "left-only" : "right-only";
}

/** 对齐状态 chip 文案（未对齐要说清**哪一侧**没同题） */
export const ALIGN_LABEL: Record<AlignState, string> = {
  aligned: "已对齐",
  "left-only": "未对齐 · 右无同题",
  "right-only": "未对齐 · 左无同题",
};

export function pairScore(r: Record<string, PairResult> | null | undefined, ev: string): PairResult | null {
  const v = r?.[ev];
  return v ? v : null;
}

/** 时间线有没有刻度：所有事件都记了 t_offset_s 才有（一条 null 就整条按序号等距排） */
export function timedEvents(...sides: (SessionEvent[] | null | undefined)[]): boolean {
  return sides.every((evs) => (evs ?? []).every((e) => typeof e.t_offset_s === "number"));
}

// ---------- 时间线 ----------

export type BlockState = "same" | "modified" | "added" | "removed";

/** 双栏按 `n` 对位后的一轮：某侧缺 ⇒ null（对面画虚线占位） */
export interface TimelineRound {
  n: number;
  left: SessionEvent | null;
  right: SessionEvent | null;
  state: BlockState;
}

/** 文本 / 工具名 / 入参 / 耗时任一不同 = 差异块（与设计稿 sameEv 同刑） */
export function sameEvent(a: SessionEvent, b: SessionEvent): boolean {
  return a.type === b.type
    && textOf(a.text) === textOf(b.text)
    && (a.name ?? null) === (b.name ?? null)
    && JSON.stringify(a.arguments ?? null) === JSON.stringify(b.arguments ?? null)
    && (a.duration_s ?? null) === (b.duration_s ?? null);
}

export function timelineRounds(left: SessionEvent[], right: SessionEvent[]): TimelineRound[] {
  const ns = [...new Set([...left.map((e) => e.n), ...right.map((e) => e.n)])].sort((a, b) => a - b);
  return ns.map((n) => {
    const l = left.find((e) => e.n === n) ?? null;
    const r = right.find((e) => e.n === n) ?? null;
    const state: BlockState = l && r ? (sameEvent(l, r) ? "same" : "modified") : l ? "removed" : "added";
    return { n, left: l, right: r, state };
  });
}

/** 块头的角色词；tool 另带工具名 */
export const WHO: Record<string, string> = { user: "用户", assistant: "Agent", tool: "工具" };

/** 时间轴刻度步长：让相邻刻度至少隔 28px（与设计稿同一档位表） */
export function tickStep(scale: number): number {
  return [0.5, 1, 2, 5, 10, 30, 60].find((st) => st * scale >= 28) ?? 60;
}

// ---------- 属性 ----------

export const ATTRIBUTE_KEYS: (keyof SessionAttributes)[] = [
  "model", "tokens.input", "tokens.output", "llm_calls", "tool_calls", "latency.avg_s", "cost.usd", "system_prompt",
];

/** 属性值 → 单元格文本；null ⇒ "—"（EMPTY_MARK 由组件套） */
export function fmtAttr(key: string, v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    if (key === "latency.avg_s") return `${v.toFixed(2)}s`;
    // 会话成本走 lib/cost 唯一口径：session_compare 的属性只带 cost.usd 不带未定价名单
    // ⇒ 部分与否**不可判**（isPartial 传 undefined），0 分不出真 0 还是模型无价 ⇒ 空格；四位小数
    if (key === "cost.usd") {
      const t = fmtCost(v, null, undefined, { digits: 4 }).text;
      return t === EMPTY_MARK ? null : t;
    }
    return String(v);
  }
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// ---------- 归档 → SessionSide（单栏回放） ----------

/** get_plan_run 归档里本模块要读的最小形状（其余键不关心） */
export interface ArchiveLike {
  run_key?: string;
  started_at?: string | number | null;
  report?: {
    stages?: object[] | null;
  } | null;
}
export interface ArchiveStage {
  type?: string;
  session_details?: ArchiveSession[] | null;
  report?: { results?: ArchiveCase[] | null } | null;
}
interface ArchiveSession {
  session_id?: string;
  results?: Record<string, unknown>;
  metrics?: Record<string, Record<string, unknown> | undefined> | null;
  transcript?: { events?: unknown; system_prompt?: unknown } | null;
}
interface ArchiveCase {
  case?: string;
  case_name?: string;
  results?: Record<string, unknown>;
  duration_s?: number | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 会话 metrics（compute_session_metrics 五组对象）→ 八项属性 */
export function attributesOfMetrics(
  metrics: Record<string, Record<string, unknown> | undefined> | null | undefined,
  systemPrompt: unknown,
): SessionAttributes {
  const m = metrics ?? {};
  const byModel = m.tokens?.by_model;
  const models = byModel && typeof byModel === "object" ? Object.keys(byModel as object) : [];
  return {
    model: models.length > 0 ? models.join(", ") : null,
    "tokens.input": num(m.tokens?.input),
    "tokens.output": num(m.tokens?.output),
    llm_calls: num(m.llm_calls?.count),
    tool_calls: num(m.tool_calls?.count),
    "latency.avg_s": num(m.latency?.avg_s),
    "cost.usd": num(m.cost?.usd),
    system_prompt: typeof systemPrompt === "string" && systemPrompt ? systemPrompt : null,
  };
}

function resultsOf(raw: Record<string, unknown> | undefined): Record<string, SessionSideResult> {
  const out: Record<string, SessionSideResult> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const r = (v ?? {}) as Record<string, unknown>;
    out[k] = {
      score: num(r.score),
      passed: typeof r.passed === "boolean" ? r.passed : null,
      label: typeof r.label === "string" ? r.label : null,
      // reason 可能是对象（{summary}）：走 textOf 归一化，不裸渲
      reason: textOf(r.reason) || null,
    };
  }
  return out;
}

function eventsOf(raw: unknown): SessionEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const t = num(o.t_offset_s);
    return [{
      n: num(o.n) ?? i + 1,
      type: typeof o.type === "string" ? o.type : "assistant",
      // 归档没记时刻就留 null（时间线按序号排），不伪造 0
      t_offset_s: t,
      text: typeof o.text === "string" ? o.text : null,
      name: typeof o.name === "string" ? o.name : null,
      duration_s: num(o.duration_s),
      error: typeof o.error === "string" ? o.error : null,
      arguments: o.arguments ?? null,
      result: o.result ?? null,
    }];
  });
}

/** 归档 run 的身份（单栏回放的元信息条读它；报告页格详情只有环节没有 run ⇒ 全空） */
export interface SideMeta {
  run_key?: string;
  started_at?: string | number | null;
  run_index?: number | null;
}

/**
 * 一个 S3 明细环节里找这一行（会话 = session_id；回归 / 红队 = case 名）→ SessionSide。
 * 找不到 ⇒ null。回归用例没有 transcript ⇒ events 空、属性全 null（不伪造 t_offset），
 * 只有评估器表有料。`stage` 形状 = plan/types.ts StageDetail，这里只读四个键。
 */
export function sessionSideFromStage(
  stageRaw: object | null | undefined,
  rowKey: string,
  meta: SideMeta = {},
): SessionSide | null {
  if (!stageRaw) return null;
  // 只读四个键，逐键都有 typeof 守卫 ⇒ 这里收窄成本模块的最小形状是安全的
  const stage = stageRaw as ArchiveStage;
  const type = stage.type ?? "";
  const base = {
    run_key: meta.run_key ?? "",
    row_key: rowKey,
    stage_type: type,
    started_at: meta.started_at == null ? null : String(meta.started_at),
    run_index: meta.run_index ?? null,
  };
  if (type === "observe") {
    const s = (stage.session_details ?? []).find((x) => x.session_id === rowKey);
    if (!s) return null;
    return {
      ...base,
      events: eventsOf(s.transcript?.events),
      attributes: attributesOfMetrics(s.metrics, s.transcript?.system_prompt),
      results: resultsOf(s.results),
    };
  }
  const c = (stage.report?.results ?? []).find((x) => (x.case ?? x.case_name) === rowKey);
  if (!c) return null;
  return { ...base, events: [], attributes: attributesOfMetrics(null, null), results: resultsOf(c.results) };
}

/** 整份归档（get_plan_run）里逐环节找；第一个命中的环节算数 */
export function sessionSideFromArchive(
  archive: ArchiveLike | null | undefined,
  rowKey: string,
  runIndex: number | null = null,
): SessionSide | null {
  for (const st of archive?.report?.stages ?? []) {
    const side = sessionSideFromStage(st, rowKey, {
      run_key: archive?.run_key, started_at: archive?.started_at, run_index: runIndex,
    });
    if (side) return side;
  }
  return null;
}
