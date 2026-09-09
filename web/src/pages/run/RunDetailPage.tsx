// 运行详情：trace 三栏视图（结构照 ui-prototypes/trace-view/index.html）。
// 左栏 run 列表 → 中栏环节分组 + trace 树 → 右栏三态详情。
// 数据诚实纪律：只画契约里真有的字段；线上评估标「真实 trace」，
// 回归/红队标「合成 trajectory · 无跨度」——不是没渲染，是结构上没有。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import { navigate } from "../../router";
import type {
  BackendText, EvaluatorResult, PlanRunDetailEvent, PlanRunsEvent, RunEntry,
  RunSession, RunStage, SessionDiagnosisFailure, TranscriptEvent,
  ViewDiagnosisFailure, ViewEntry, ViewEvaluatorResult, ViewRunMeta, ViewSession,
  ViewStage, ViewTranscriptEvent,
} from "./types";
import "./run.css";
import PageHeader from "../../components/layout/PageHeader";
import ErrorBoundary from "../../components/ErrorBoundary";
// 综合报告正文的 markdown-lite 渲染件（分节正文 + ref chip）
import SynthesisText from "../../components/SynthesisText";
import { pairTurn, spanKeyOf } from "./pairing";
// 老数据 fallback：无 synthesis_sections 时前端按 `## ` 切（与后端同逻辑）
import { sectionsOf } from "../plan/derive";
import { shortSessionId } from "../plan/reportRows";
import { UNIT_WORD } from "../plan/compare/derive";
import {
  effectiveScore, fmtScore, runBadge, STAGE_LABEL, STALE_RUNNING_BADGE,
} from "../../lib/scoring";
import { fmtRunTime } from "../../lib/time";
// 后端形态 → 可渲染文本的归一化。真后端在 transcript.events[].arguments 给的是
// **dict**（app/transcript.py:64 原样透传 SDK 的 `ToolCall.arguments: dict`），
// diagnosis.failures[].category 给的是 **list[str]**（app/diagnosis.py:33 未
// str()）——裸渲对象就是 UI-026 那次「点开会话整页白屏」（React error #31）。
//
// ⚠️ 调用位置有纪律：`textOf` 只许出现在下面「契约归一化」那一段里（数据进
// 视图形态的**入层**），渲染点一律读已经收窄成 string 的视图字段。此前是反过来
// 的——21 个渲染点各自调一次 textOf（backlog S4 记的 44 / 层次评审记的 33 是
// 历次统计口径，R2-E 落批前实测 21），每个新渲染点都得记得调。渲染点现在剩下
// 的调用是另一码事：displayText 是「空位占位」的排版决定（入参已是 string），
// prettyJson/inlineJson 是 JSON 位成文（吃任意形态、恒返 string）。
import { displayText, inlineJson, prettyJson, textOf } from "../../lib/renderText";

const TRIGGER_LABEL: Record<string, string> = { manual: "手动", schedule: "定时" };

// run 终态 badge 收敛到 lib/scoring.ts runBadge（按环节判定）。此前这里是
// 一张只认顶层 status 的本地映射表：环节炸掉的 run 在左栏列表里照样绿色
// 「完成」（UI-025），纯回归/纯红队跑成功的 run 与空转 run 也无从区分。

// ---------- 纯函数（fmtDur / meanScore / isRetry 导出供测试） ----------
//
// 只有这三个被 tests/run-detail.test.tsx 直接 import。下面「契约归一化」段的
// 归一化助手全是模块内私有——别顺手加 export：假导出会让人以为它们是本页对外
// 契约（此前九个就是这么攒出来的），改签名时凭空多一层顾虑。

/** 74 → "1m14s"；59 → "59s"。
 *  ≥60 时先把总秒数取整再拆分钟/秒：分钟 floor、秒位 round 各自为政时，
 *  s%60 ∈ [59.5, 60) 会渲染出不存在的「1m60s」（119.6 → 1m60s，应为 2m00s；
 *  issue duration-format-minute-carry）。<60 分支原样透出（含小数），行为不变。 */
export function fmtDur(s: number | null | undefined): string {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  const t = Math.round(s);
  return `${Math.floor(t / 60)}m${String(t % 60).padStart(2, "0")}s`;
}

/** 有效分均值：errored 或 score=null 的不计入——不是 0 分 */
export function meanScore(results: Record<string, EvaluatorResult>): number | null {
  const valid = Object.values(results).filter((r) => !r.errored && r.score != null);
  if (!valid.length) return null;
  return valid.reduce((a, r) => a + (r.score as number), 0) / valid.length;
}

/** 紧邻同名 error 行 → retry。
 *  参数只要「有 type/name/error 三个字段」——真形态（TranscriptEvent，测试直接
 *  喂 mock 的原始事件）与归一化后的视图形态（ViewTranscriptEvent）都吃。
 *  注：入层归一化后 name 比较的是**文本**而不是引用，所以两个「内容相同的
 *  对象名」现在会判成同名；真形态里 name 是 str，这条只影响腐坏形态。 */
export function isRetry(
  events: { type: string; name?: BackendText; error?: BackendText }[],
  i: number,
): boolean {
  const ev = events[i];
  const prev = events[i - 1];
  return Boolean(
    ev?.type === "tool" && ev.error &&
    prev?.type === "tool" && prev.error && prev.name === ev.name,
  );
}

// fmtScore 收敛到 lib/scoring.ts（ADR-0003 口径单一来源）。
// 本页 fmtDur 输出带补零（"1m14s" 的秒位 padStart）与全站 fmtDuration 不同，保留。

// ---------- 契约归一化（真形态 → 本页视图形态） ----------
//
// get_plan_run 有两条通路（见 types.ts 顶部注释）：S3 全量 report.stages 才
// 带逐会话/逐用例明细，DDB 摘要 stage_summaries 只有聚合数字。这里把三种形态
// （S3 全量 / DDB 摘要 / 旧归档+mock）归一成一个 view 形状（types.ts 的 View*
// 家族），让下面的 JSX 只读一套字段——同一坑的另一处消费方
// plan/ReportDrawer.tsx 用的是同样的思路。
//
// **文本位也在这一层收**（R2-E / backlog S4）。此前这一层只统一键名，文本形态
// 的归一化被摊到了 21 个渲染点上（每处一个 `textOf()`）——层次是对的、位置是
// 错的：每个未来的渲染点（新列、tooltip、明细导出）都得记得调，漏一次就重开
// UI-026 那个 React #31。现在渲染点拿到的类型就是 string，漏不掉。
//
// 收窄四条规则见 types.ts 的 View* 段。这里只强调最要紧的一条：**归一化函数
// 一律不许抛异常**。它们跑在 useMemo 里，也就是环节/右栏 ErrorBoundary 的
// **外面**——在这儿抛就是整页白屏，正是围栏想防的那件事。所以数组一律先
// Array.isArray、数值位一概不碰（`.toFixed()` 类型错留在渲染点抛，由就近围栏
// 兜住并降级成卡片）。预防（收窄类型）与软化（围栏）是两层，都要。

/** 数字 or 数组 → 个数（DDB 摘要的 sessions/cases 是数字，明细通路是数组）。
 *  照 ReportDrawer.countOf 的语义。**不 export**：只有本文件消费（假导出会让人
 *  以为它是本页对外契约，见上面「别顺手加 export」那段）。 */
function countOf(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v.length;
  return null;
}

/** 文本位归一，但**保住「缺键」与「空值」的区分**（收窄规则 2）：
 *  null/undefined → null（"没这个键"），其余走 textOf。
 *  谁在用这个区分：entry.input/output（决定能否展开）、failure.span_id
 *  （决定 testid 退不退回序号）、event.error（决定 ATTRIBUTES 显 "null"）。 */
function textOrNull(v: unknown): string | null {
  return v == null ? null : textOf(v);
}

/** 评估结果表：真后端 session_error 分支整个缺 results；reason 是全仓库唯一
 *  没 str() 兜的文本位（app/main.py:151），在这里收成 string。 */
function normalizeResults(
  results?: Record<string, EvaluatorResult>,
): Record<string, ViewEvaluatorResult> {
  const out: Record<string, ViewEvaluatorResult> = {};
  for (const [name, r] of Object.entries(results ?? {})) {
    out[name] = { ...r, reason: textOf(r?.reason) };
  }
  return out;
}

/** trace 事件：text/name/error 收成文本，arguments/result 是 JSON 位原样透传
 *  （规则 4），t_offset_s/duration_s/slow 是数值位不碰（规则 3）。 */
function normalizeEvent(ev: TranscriptEvent): ViewTranscriptEvent {
  return {
    n: ev.n,
    type: ev.type,
    t_offset_s: ev.t_offset_s,
    span_id: textOrNull(ev.span_id),
    parent_span_id: ev.parent_span_id,
    text: textOf(ev.text),
    name: textOf(ev.name),
    error: textOrNull(ev.error),
    arguments: ev.arguments,
    result: ev.result,
    duration_s: ev.duration_s,
    slow: ev.slow,
  };
}

/** diagnosis 失败项：category 真形态是 list[str]、confidence/evidence 是
 *  str() 过的 list —— 三个都收成文本（数组用 " · " 连，不粘连成 "abc"）。 */
function normalizeFailure(f: SessionDiagnosisFailure): ViewDiagnosisFailure {
  return {
    span_id: textOrNull(f.span_id),
    category: textOf(f.category),
    confidence: textOf(f.confidence),
    evidence: textOf(f.evidence),
  };
}

/** 会话：transcript 包装层摊平成 events，diagnosis 补齐成必有字段。
 *  session_id 也过 textOf —— 它兼作 data-testid 与选中态 key，此前是模板
 *  字面量直插（对象会插成 "[object Object]"）。 */
function normalizeSession(s: RunSession): ViewSession {
  const events = s.transcript?.events;
  const failures = s.diagnosis?.failures;
  return {
    session_id: textOf(s.session_id),
    metrics: s.metrics,
    results: normalizeResults(s.results),
    diagnosis: {
      clean: s.diagnosis?.clean === true,
      failures: Array.isArray(failures) ? failures.map(normalizeFailure) : [],
    },
    events: Array.isArray(events) ? events.map(normalizeEvent) : [],
    no_content: s.no_content,
    error: textOrNull(s.error),
  };
}

/** 用例：三套键名在这里合完（dataset 侧 case/category/n_turns、
 *  redteam 侧 case_name/risk_category/turns_used、旧形态 name）。
 *  ⚠️ `??` 一律在**原值**上做、归一化后再收：先 textOf 会把「有键但空」变成
 *  ""，`??` 就穿不过去了（口径会从「缺键才回退」悄悄变成「空也回退」）。 */
function normalizeEntry(e: RunEntry): ViewEntry {
  return {
    name: textOf(e.case) || textOf(e.case_name) || textOf(e.name) || "—",
    input: textOrNull(e.input),
    output: textOrNull(e.output),
    category: textOf(e.category ?? e.risk_category),
    strategy: textOf(e.strategy),
    severity: textOf(e.severity),
    reason: textOf(e.reason),
    turns: e.n_turns ?? e.turns_used ?? null,
    duration_s: e.duration_s,
    blank_output: e.blank_output,
    breached: e.breached,
    errored: e.errored,
    // 真后端给的是说明字符串（testrun.py），不是 boolean —— 只当真假用
    evalSkipped: Boolean(e.eval_skipped),
    results: normalizeResults(e.results),
  };
}

/** observe 逐会话明细：真后端字段名 session_details，旧形态 sessions（数组时）。
 *  **归一化就在这里做**（S4 的落点）：出口是 ViewSession[]，渲染点读 string。 */
function sessionsOf(stage: RunStage): ViewSession[] {
  const raw = Array.isArray(stage.session_details) ? stage.session_details
    : Array.isArray(stage.sessions) ? stage.sessions
    : [];
  return raw.map(normalizeSession);
}

/** dataset/redteam 逐用例明细：真后端在 stage.report.results，
 *  旧形态在 entries；DDB 摘要通路的 cases 是数字，不是明细。
 *  同上，出口是归一化后的 ViewEntry[]。 */
function entriesOf(stage: RunStage): ViewEntry[] {
  const raw = Array.isArray(stage.report?.results) ? stage.report.results
    : Array.isArray(stage.entries) ? stage.entries
    : Array.isArray(stage.cases) ? stage.cases
    : [];
  return raw.map(normalizeEntry);
}

/** 环节分：observe 真字段是 overall_mean，dataset 用 pass_rate，
 *  旧形态统一叫 score。红队没有「分」（口径是攻破数），返 null。 */
function stageScore(stage: RunStage): number | null {
  if (typeof stage.score === "number") return stage.score;
  if (typeof stage.overall_mean === "number") return stage.overall_mean;
  if (stage.type === "dataset" && typeof stage.pass_rate === "number") return stage.pass_rate;
  return null;
}

/** 环节明细条数：明细数组优先，退回 DDB 摘要的聚合数字。 */
function stageCount(stage: RunStage, sessions: number, entries: number): number {
  const detail = stage.type === "observe" ? sessions : entries;
  if (detail > 0) return detail;
  return countOf(stage.type === "observe" ? stage.sessions : stage.cases) ?? 0;
}

/** 一个环节 → 视图形态：明细逐条归一化，环节自己的文本位（error / 数据集来源）
 *  也在这里收，数值位（breached/attacks/分数/条数）原样或算好带过去。 */
function normalizeStage(stage: RunStage): ViewStage {
  const sessions = sessionsOf(stage);
  const entries = entriesOf(stage);
  return {
    type: textOf(stage.type),
    error: textOrNull(stage.error),
    // dataset 环节键名 dataset、redteam 键名 cases_dataset
    source: textOf(stage.dataset ?? stage.cases_dataset),
    score: stageScore(stage),
    count: stageCount(stage, sessions.length, entries.length),
    breached: stage.breached,
    attacks: stage.attacks,
    sessions,
    entries,
  };
}

/** 环节数组：S3 全量优先（只有它含明细）→ DDB 摘要 → 旧归档/mock 顶层 stages。
 *  **不 export** —— 仅本文件消费。整棵树的归一化都从这个入口进去，所以调用方
 *  要把结果 useMemo 住（页面只算一次，右栏读同一份）。 */
function stagesOf(detail: PlanRunDetailEvent | undefined): ViewStage[] {
  if (!detail) return [];
  const s = detail.report?.stages ?? detail.stage_summaries ?? detail.stages;
  return Array.isArray(s) ? s.map(normalizeStage) : [];
}

/** metabar 的一套值：文本位归一化 + 数值位双读，每个值**算一次**（此前
 *  triggered_by 一个表达式里算三遍，synthesis_error/成本各两遍）。
 *  detail 未到时全给 ""/null，与 JSX 里 `detail && …` 的判空互不影响。
 *  综合报告正文不在这里：它的分节归一化在 plan/derive.sectionsOf（四个消费方同一份）。 */
function runMetaOf(detail: PlanRunDetailEvent | undefined): ViewRunMeta {
  return {
    score: detail ? runScore(detail) : null,
    cost: detail ? runCost(detail) : null,
    triggeredBy: textOf(detail?.triggered_by),
    synthesisError: textOf(detail?.synthesis_error),
  };
}

/** 会话成本：真后端 metrics.cost 是**对象** {usd,…}；曾按标量 .toFixed() 读会崩。 */
function sessionCost(s: ViewSession): number | null {
  const c = s.metrics?.cost as { usd?: number } | number | undefined;
  if (typeof c === "number") return c;
  if (c && typeof c.usd === "number") return c.usd;
  return null;
}

/** 会话延迟：真后端 metrics.latency 是对象 {turns,avg_s,max_s}；
 *  旧 mock 形态是 {avg,max}。 */
function sessionLatency(s: ViewSession): { avg: number | null; max: number | null } {
  const l = s.metrics?.latency as
    { avg_s?: number | null; max_s?: number | null; avg?: number; max?: number } | undefined;
  return {
    avg: l?.avg_s ?? l?.avg ?? null,
    max: l?.max_s ?? l?.max ?? null,
  };
}

/** 本 run 总成本：真后端顶层 total_cost_usd；旧形态在 overview.cost_usd。
 *  绝不裸读 overview.cost_usd.toFixed()——那是本页此前的白屏点。 */
function runCost(detail: PlanRunDetailEvent): number | null {
  if (typeof detail.total_cost_usd === "number") return detail.total_cost_usd;
  if (typeof detail.overview?.cost_usd === "number") return detail.overview.cost_usd;
  return null;
}

/** 综合分：真后端顶层 score（_run_from_item 由 observe 均分算出）；
 *  旧形态在 overview.score。口径同 ADR-0003：没有就是「—」，不伪造 0。 */
function runScore(detail: PlanRunDetailEvent): number | null {
  if (typeof detail.score === "number") return detail.score;
  if (typeof detail.overview?.score === "number") return detail.overview.score;
  return null;
}

/** "UpstreamTimeout: no response in 300ms" → ["UpstreamTimeout", "no response in 300ms"]
 *  入参已是归一化后的文本（视图形态），所以这里只负责切。 */
function splitError(s: string): [string, string] {
  const i = s.indexOf(":");
  if (i < 0) return [s, ""];
  return [s.slice(0, i), s.slice(i + 1).trim()];
}

// ---------- 选中态 ----------
// "msg" 是 additive 扩枚举（USER/AGENT 行点开右栏看全文）：既有三值一个不改，
// "span" 仍专指 tool 行（右栏 ATTRIBUTES/ARGUMENTS/RESULT 三段是工具专属形态）。
// msg.hl：右栏「中间 N 次工具调用」被点亮时，左栏要一并高亮的 tool 行键（spanKey）。
// 住在 Sel 里而不是另立 state：换选任何一行它就自然清空，不用再多一条同步规则。
type Sel =
  | { kind: "span"; sid: string; spanId: string }
  | { kind: "msg"; sid: string; spanId: string; hl?: string[] }
  | { kind: "session"; sid: string }
  | { kind: "case"; stage: string; name: string }
  | null;

/** 综合报告折叠块在 open Set 里的键（环节键形如 `observe:sess-…`，不撞） */
const SYNTH_OPEN_KEY = "synthesis";

/** `session` = `#/run/<run_key>?session=<session_id>` 会话级深链（报告页问题台账「查看 trace」带来）；
 *  `span` = `&span=<span_id>` span 级深链（台账里点名的 span chip 带来）：在预选会话的 trace 树里把那一行选中 */
export default function RunDetailPage({ id, session, span }: { id: string; session?: string; span?: string }) {
  const planId = id.split("#")[0];

  const runsQ = useQuery({
    queryKey: ["plan_runs", planId],
    queryFn: () => apiOne<PlanRunsEvent>({ action: "list_plan_runs", plan_id: planId }, "plan_runs"),
  });
  const detailQ = useQuery({
    queryKey: ["plan_run", id],
    queryFn: () => apiOne<PlanRunDetailEvent>({ action: "get_plan_run", run_key: id }, "plan_run"),
  });

  const [sel, setSel] = useState<Sel>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => { setSel(null); setOpen(new Set()); }, [id]);

  // v3-C：全站恒暗，trace 页不再有独立主题切换（原 dark state /
  // localStorage("trace-theme") / data-theme 副作用整体移除）。

  const detail = detailQ.data;

  const toggleOpen = (key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // 整棵明细树的归一化在这一次 useMemo 里做完（stagesOf → normalizeStage → …），
  // 右栏读的是同一份 —— 所以 RightPane 收 stages 而不是 detail：否则每次换选都要
  // 把整棵树重新归一化一遍。
  const stages = useMemo(() => stagesOf(detail), [detail]);

  // ---- 会话级深链（?session=）+ span 级深链（&span=）----
  // 找到该会话所在环节 ⇒ 展开该环节里的它、选中它、首帧后滚到视口中央；找不到 ⇒ 行为与
  // 没带参数完全相同，只在中栏顶部多一条状态（下面 session-deeplink-missing）。
  // 带 span 且该会话的 trace 树里有这条 span ⇒ 选中的是那一行（tool 行开 SPAN 详情、消息行开全文，
  // 与手点同一套 Sel），滚到那一行而不是会话行；span 不在这条会话里 ⇒ 仍选会话 + 一条状态
  // （span-deeplink-missing，只在此态出现）。
  // 只按 `${id}|${session}|${span}` 应用一次：用户之后手点别的会话，不许被深链拽回去。
  const deepLinkStage = useMemo(() => {
    if (!session) return null;
    const hit = stages.find((st) => st.sessions.some((s) => s.session_id === session));
    return hit ? hit.type : null;
  }, [stages, session]);
  // span 深链命中的那条事件（键与树节点 spanKey 同式：span_id 缺时是 n<序号>）；没带 span / 会话没找到 ⇒ null
  const deepLinkSpanEvent = useMemo(() => {
    if (!session || !span || !deepLinkStage) return null;
    const sess = findSession(stages, session);
    return sess?.events.find((e) => (e.span_id ?? `n${e.n}`) === span) ?? null;
  }, [stages, session, span, deepLinkStage]);
  const deepLinkApplied = useRef<string | null>(null);
  /** 待滚到的元素 testid（会话行 `session-row-<sid>` 或 trace 行 `trace-row-<spanKey>`） */
  const deepLinkScrollPending = useRef<string | null>(null);
  useEffect(() => {
    if (!session || !detail) return;
    const key = `${id}|${session}|${span ?? ""}`;
    if (deepLinkApplied.current === key) return;
    deepLinkApplied.current = key;
    if (!deepLinkStage) return;
    setOpen((prev) => new Set(prev).add(`${deepLinkStage}:${session}`));
    if (deepLinkSpanEvent) {
      const spanKey = deepLinkSpanEvent.span_id ?? `n${deepLinkSpanEvent.n}`;
      setSel(deepLinkSpanEvent.type === "tool"
        ? { kind: "span", sid: session, spanId: spanKey }
        : { kind: "msg", sid: session, spanId: spanKey });
      deepLinkScrollPending.current = `trace-row-${spanKey}`;
    } else {
      setSel({ kind: "session", sid: session });
      deepLinkScrollPending.current = `session-row-${session}`;
    }
  }, [id, session, span, detail, deepLinkStage, deepLinkSpanEvent]);
  // 选中行要等上面那次 setState 提交后才在 DOM 里，所以滚动放在「每次提交后」的 effect 里，
  // 见到待滚的行就滚一次并清掉。jsdom 没有 scrollIntoView ⇒ 可选调用。
  useEffect(() => {
    const tid = deepLinkScrollPending.current;
    if (!tid) return;
    const el = document.querySelector<HTMLElement>(`[data-testid="${tid.replace(/"/g, '\\"')}"]`);
    if (!el) return;
    deepLinkScrollPending.current = null;
    el.scrollIntoView?.({ block: "center" });
  });

  const totalCases = useMemo(
    () => stages.reduce((n, s) => n + s.count, 0), [stages]);
  const meta = useMemo(() => runMetaOf(detail), [detail]);
  const synthSections = useMemo(() => sectionsOf(detail), [detail]);
  const synthOpen = open.has(SYNTH_OPEN_KEY);

  return (
    <section className="runpage" data-testid="page-run-detail">
      {/* 返回位统一走 PageHeader back（全站同形态）；.run-head 仍保留
          自己的下间距覆盖与 .rid 样式 */}
      <PageHeader
        className="run-head"
        back={{
          // DDB 摘要通路没有 plan 键，扁平 plan_name 才是那条路上的名字
          label: detail?.plan?.name ?? detail?.plan_name ?? planId,
          to: `#/plan/${encodeURIComponent(planId)}`,
        }}
        title="运行详情"
        meta={<span className="rid" data-testid="run-head-key">{id}</span>}
      />

      {detail && (
        <div className="metabar" data-testid="run-metabar">
          <span className="item"><span className="k">综合分</span>
            <span className="v">{fmtScore(meta.score)}</span></span>
          {/* 「通过 X/Y」只有旧归档形态给得出（真后端 overview 无 passed/cases）；
              给不出就不画这一项——不画假数字。真后端的逐环节口径走下面
              overview.stage_lines（那是它真有的字段）。 */}
          {typeof detail.overview?.passed === "number"
            && typeof detail.overview?.cases === "number" && (
            <span className="item"><span className="k">通过</span>
              <span className="v">{detail.overview.passed}/{detail.overview.cases}</span></span>
          )}
          <span className="item"><span className="k">成本</span>
            <span className="v">
              {meta.cost != null ? `$${meta.cost.toFixed(2)}` : "—"}
            </span></span>
          <span className="item"><span className="k">耗时</span>
            <span className="v">{fmtDur(detail.duration_s)}</span></span>
          <span className="item"><span className="k">触发</span>
            <span className="v cjk">
              {meta.triggeredBy !== ""
                ? TRIGGER_LABEL[meta.triggeredBy] ?? meta.triggeredBy
                : "—"}
            </span></span>
          <span className="item"><span className="k">开始</span>
            {/* fmtRunTime 剥 " UTC" 后缀（真后端带、mock 不带），避免与表头
                「时间为 UTC」重复标注 */}
            <span className="v">{fmtRunTime(detail.started_at)}</span></span>
          {meta.synthesisError !== "" && (
            <span className="item"><span className="k">结论生成失败</span>
              <span className="v cjk" style={{ color: "var(--bad)" }}>
                {meta.synthesisError}
              </span></span>
          )}
        </div>
      )}

      {/* 综合报告：从 meta kv 行拿出来的独立折叠块（它是长文，摊开会把三栏
          主体挤走）。默认收起一行摘要，折叠壳复用本页手风琴（open Set）。
          没有 synthesis 的 run 整块缺席——不画空壳。 */}
      {synthSections.length > 0 && (
        <div className="synthblock" data-testid="run-synthesis">
          <button
            type="button"
            className={`synthhead${synthOpen ? " open" : ""}`}
            data-testid="run-synthesis-toggle"
            aria-expanded={synthOpen}
            onClick={() => toggleOpen(SYNTH_OPEN_KEY)}
          >
            <span className="tw">▶</span>
            <span className="st">综合报告 · {synthSections.length} 节</span>
          </button>
          {synthOpen && (
            <div className="synthbody" data-testid="run-synthesis-body">
              {synthSections.map((sec, i) => (
                <section key={i} className="synsec" data-testid={`run-synthesis-sec-${i}`}>
                  <h3 className="synsec-h">{sec.title}</h3>
                  <SynthesisText text={sec.body} />
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="run-cols">
        {/* ==================== 左栏：run 列表 ==================== */}
        <section className="col" aria-label="运行历史">
          <div className="colhead">
            <span className="ct">运行历史</span>
            <span className="cn">{runsQ.data?.runs.length ?? "…"}</span>
          </div>
          <div className="colbody" data-testid="run-list">
            {runsQ.isPending && <div className="col-note">加载中…</div>}
            {runsQ.isError && <div className="col-note err">运行列表加载失败：{(runsQ.error as Error).message}</div>}
            {runsQ.data?.runs.map((r) => {
              // 陈旧 running 的展示态：后端读侧判定这条 running 的执行进程已停
              // （app/stalecheck.py:is_stale），而 status 仍是 running —— 显示中性
              // 「疑似中断」。**前端零判定逻辑**：只消费后端那个布尔（判据抄成第二份
              // 就会与 reaper/并发闸门分叉）。改判落库归 reaper，这里只显示。
              // 与方案详情页 run 行逐字同款（同一条 run 两页不许说两句话）；
              // runBadge/STATUS_LABEL 一行不改 —— 那是五态的唯一权威。
              const badge = r.status === "running" && r.stale === true
                ? STALE_RUNNING_BADGE
                : runBadge(r);
              return (
                <button
                  key={r.run_key}
                  type="button"
                  className={`runrow${r.run_key === id ? " on" : ""}`}
                  data-testid={`run-row-${r.run_key}`}
                  aria-current={r.run_key === id ? "true" : undefined}
                  onClick={() => navigate(`#/run/${encodeURIComponent(r.run_key)}`)}
                >
                  <span className="l1">
                    {/* 剥 " UTC" 后缀（真后端带、mock 不带）——列内不重复标时区 */}
                    <span className="rk">{fmtRunTime(r.started_at)}</span>
                    <span className="hspace" />
                    <span className={badge.cls}>{badge.label}</span>
                  </span>
                  <span className="l2">
                    <span className="cjkword">
                      {r.triggered_by ? TRIGGER_LABEL[r.triggered_by] ?? r.triggered_by : "—"}
                    </span>
                    <span className="sep">·</span>
                    <span>{fmtDur(r.duration_s)}</span>
                    <span className="sep">·</span>
                    {/* 取值走 effectiveScore（不是 r.score）：8/21 之前落库的 run 顶层
                        score 是 null，分在 observe 环节 overall_mean 里 —— 直读会让
                        同一条 run 在方案详情页显示 0.74、在这里显示「—」（同一个量
                        两个住址，见 lib/scoring.ts effectiveScore）。真没有分的 run
                        仍是「—」：兜底只换取值住址，不伪造 0。 */}
                    <b>{fmtScore(effectiveScore(r))}</b>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ==================== 中栏：环节分组 + trace 树 ==================== */}
        <section className="col" aria-label="用例与调用链">
          <div className="colhead">
            <span className="ct">用例与调用链</span>
            <span className="cn">{detail ? totalCases : "…"}</span>
          </div>
          <div className="colbody">
            {detailQ.isPending && <div className="col-note">加载中…</div>}
            {detailQ.isError && <div className="col-note err">运行详情加载失败：{(detailQ.error as Error).message}</div>}
            {detail && stages.length === 0 && (
              <div className="col-note" data-testid="stages-empty">
                本次运行没有环节明细
              </div>
            )}
            {/* 深链会话不在本次 run（链接过期 / 粘错 run_key）：状态不是散文——只在找不到时出现 */}
            {detail && session && deepLinkStage == null && (
              <div className="col-note" data-testid="session-deeplink-missing" title={session}>
                链接指向的会话 <span className="mono">{shortSessionId(session)}</span> 不在本次 run 里
              </div>
            )}
            {/* 会话找到了、但链接点名的 span 不在这条会话的 trace 树里（问题文本写错 / 会话被重采）：只在此态出现 */}
            {detail && session && span && deepLinkStage != null && !deepLinkSpanEvent && (
              <div className="col-note" data-testid="span-deeplink-missing" title={span}>
                链接指向的 span <span className="mono">{span.slice(0, 8)}</span> 不在这条会话里
              </div>
            )}
            {/* 每个环节一道围栏：一个环节的字段异常不该带走另外两个环节，
                也不该带走左栏 run 列表和侧栏导航（UI-026 就是被整页带走的）。 */}
            {stages.map((stage, i) => (
              <ErrorBoundary
                key={`${stage.type}-${i}`}
                scope={`stage:${stage.type}`}
                testId={`stage-boundary-${stage.type}`}
                title={`${STAGE_LABEL[stage.type] ?? stage.type}环节的明细渲染失败`}
              >
                <StageGroup
                  stage={stage}
                  open={open}
                  sel={sel}
                  onToggle={toggleOpen}
                  onSel={setSel}
                />
              </ErrorBoundary>
            ))}
          </div>
        </section>

        {/* ==================== 右栏：三态详情 ==================== */}
        {/* 右栏是「点开某个会话/用例」的落点，也就是 UI-026 的爆点所在。
            单独围栏：详情渲染失败时左中两栏与侧栏照旧可用，还能换个会话再看。 */}
        <ErrorBoundary
          scope="run-detail:right-pane"
          testId="right-pane-boundary"
          title="这条明细渲染失败了"
        >
          <RightPane stages={stages} sel={sel} onSel={setSel} />
        </ErrorBoundary>
      </div>
    </section>
  );
}

// ==================== 中栏：环节分组 ====================
function StageGroup({ stage, open, sel, onToggle, onSel }: {
  stage: ViewStage;
  open: Set<string>;
  sel: Sel;
  onToggle: (key: string) => void;
  onSel: (sel: Sel) => void;
}) {
  const label = STAGE_LABEL[stage.type] ?? stage.type;
  // 单位名词走全站唯一那张表（红队此前在这里被叫成「用例」，与回归测试撞名）；
  // 认不出的环节类型退到「用例」——运行详情的环节带此前就是这个降级词。
  const unit = UNIT_WORD[stage.type] ?? "用例";
  return (
    <>
      <div className="stageband" data-testid={`stage-band-${stage.type}`}>
        <span className="sname">{label}</span>
        <span>
          {stage.source !== "" ? `${stage.source} · ` : ""}{stage.count} {unit}
          {/* 红队环节的口径是攻破数，不是分——真后端也不给它 score */}
          {stage.type === "redteam" && stage.breached != null
            ? ` · 攻破 ${stage.breached}/${stage.attacks ?? stage.count}`
            : ` · 环节分 ${fmtScore(stage.score)}`}
        </span>
        <span className="hspace" />
        {stage.type === "observe"
          ? <span className="srcnote real">真实 trace</span>
          : <span className="srcnote">合成 trajectory · 无跨度</span>}
      </div>
      {stage.error && (
        <div className="col-note err" data-testid={`stage-error-${stage.type}`}>{stage.error}</div>
      )}
      {stage.sessions.map((s) => (
        <SessionRows
          key={s.session_id}
          session={s}
          isOpen={open.has(`${stage.type}:${s.session_id}`)}
          sel={sel}
          onToggle={() => onToggle(`${stage.type}:${s.session_id}`)}
          onSel={onSel}
        />
      ))}
      {stage.entries.map((e, i) => (
        <EntryRows
          key={`${e.name}-${i}`}
          stage={stage}
          entry={e}
          isOpen={open.has(`${stage.type}:${e.name}`)}
          sel={sel}
          onToggle={() => onToggle(`${stage.type}:${e.name}`)}
          onSel={onSel}
        />
      ))}
    </>
  );
}

// ---------- observe：session 行 + trace 树 ----------
function SessionRows({ session, isOpen, sel, onToggle, onSel }: {
  session: ViewSession;
  isOpen: boolean;
  sel: Sel;
  onToggle: () => void;
  onSel: (sel: Sel) => void;
}) {
  // transcript 构建失败 / session_error 分支整个缺 transcript 与 results
  // —— 归一化层已经把它们兜成空数组 / 空表（ViewSession.events / .results）
  const events = session.events;
  const score = meanScore(session.results);
  const selected = sel?.kind === "session" && sel.sid === session.session_id;
  const lastOffset = events.length ? events[events.length - 1].t_offset_s ?? 0 : 0;
  return (
    <>
      <button
        type="button"
        className={`caserow${selected ? " on" : ""}${isOpen ? " open" : ""}`}
        data-testid={`session-row-${session.session_id}`}
        onClick={() => { onToggle(); onSel({ kind: "session", sid: session.session_id }); }}
      >
        <span className="tw">{events.length ? "▶" : ""}</span>
        <span className="nm">
          <span className="sid">{session.session_id}</span>
          {session.error && (
            <span className="badge bad" data-testid={`session-error-${session.session_id}`}>失败</span>
          )}
          {session.no_content && (
            <span className="badge warn" data-testid={`session-blank-${session.session_id}`}>
              无内容 · 已跳过评分
            </span>
          )}
        </span>
        <span className="meta">
          {session.error
            ? session.error
            : `${events.length} events · ${lastOffset.toFixed(1)}s`}
        </span>
        <span className={`sc${score == null ? " dim" : ""}`}>{fmtScore(score)}</span>
      </button>
      {isOpen && events.length > 0 && (
        <div className="tree" data-testid={`trace-tree-${session.session_id}`}>
          {events.map((ev, i) => {
            // telemetry 缺 span id 时后端给 null → 用序号兜住 key/选中态
            const spanKey = ev.span_id ?? `n${ev.n}`;
            return (
              <TraceRow
                key={spanKey}
                ev={ev}
                spanKey={spanKey}
                retry={isRetry(events, i)}
                maxDur={Math.max(...events.filter((e) => e.type === "tool").map((e) => e.duration_s ?? 0), 0)}
                selected={((sel?.kind === "span" || sel?.kind === "msg")
                  && sel.sid === session.session_id && sel.spanId === spanKey)
                  /* 右栏点了「中间 N 次工具调用」：那几条 tool 行与选中行同一套 on 高亮 */
                  || (sel?.kind === "msg" && sel.sid === session.session_id
                    && (sel.hl?.includes(spanKey) ?? false))}
                /* 三类行同等可点：tool 行开 SPAN 详情，USER/AGENT 行开消息全文
                   （kind 分开走——右栏形态不同，tool 的三段式不适用于消息行） */
                onSel={() => onSel(ev.type === "tool"
                  ? { kind: "span", sid: session.session_id, spanId: spanKey }
                  : { kind: "msg", sid: session.session_id, spanId: spanKey })}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

function TraceRow({ ev, spanKey, retry, maxDur, selected, onSel }: {
  ev: ViewTranscriptEvent;
  spanKey: string;
  retry: boolean;
  maxDur: number;
  selected: boolean;
  onSel?: () => void;
}) {
  const isTool = ev.type === "tool";
  const isErr = Boolean(ev.error);
  const badge = ev.type === "user" ? "USER" : ev.type === "assistant" ? "AGENT" : "TOOL";
  const badgeCls = ev.type === "user" ? "tb-user" : ev.type === "assistant" ? "tb-agent" : "tb-tool";
  const cls = `trow${isErr ? " iserr" : ""}${selected ? " on" : ""}`;
  const barPct = isTool && maxDur > 0 ? ((ev.duration_s ?? 0) / maxDur) * 100 : 0;
  const [errCode, errRest] = ev.error ? splitError(ev.error) : ["", ""];

  const body = (
    <>
      <span className="n">#{ev.n}</span>
      <span className={`tb ${badgeCls}`}>{badge}</span>
      {isTool
        ? (
          <>
            <span className="nm">{ev.name}</span>
            <span className="pm">
              {retry && <><span className="rt">↻ retry</span>{" · "}</>}
              {isErr
                ? <><span className="er">ERROR · {errCode}</span>{errRest ? ` · ${errRest}` : ""}</>
                /* arguments 真后端是 **dict**（不是字符串）——UI-026 的白屏点就在这。
                   压成单行 JSON 预览，语义对齐旧版 ui/app.js:2504 的 120 字截断。 */
                : inlineJson(ev.arguments)}
            </span>
          </>
        )
        : <span className="pm" style={{ color: "var(--text)" }}>{ev.text}</span>}
      {/* 无时间戳的 span 后端给 t_offset_s: null */}
      <span className="off num">{ev.t_offset_s != null ? `${ev.t_offset_s.toFixed(1)}s` : "—"}</span>
      {isTool
        ? (
          <span className="tbar" data-testid={`trace-bar-${spanKey}`}>
            <i
              className={isErr ? "err" : ev.slow ? "slow" : ""}
              style={{ width: `${barPct}%` }}
            />
          </span>
        )
        : <span className="tbar-void" />}
      <span className={`dur num${isTool ? (ev.slow ? " slowtxt" : "") : " na"}`}>
        {isTool && ev.duration_s != null ? `${ev.duration_s.toFixed(2)}s` : "—"}
      </span>
    </>
  );

  if (onSel) {
    return (
      <button type="button" className={cls} data-testid={`trace-row-${spanKey}`} onClick={onSel}>
        {body}
      </button>
    );
  }
  return <div className={cls} data-testid={`trace-row-${spanKey}`}>{body}</div>;
}

// ---------- dataset / redteam：case 行 + input/output 展开 ----------
function EntryRows({ stage, entry, isOpen, sel, onToggle, onSel }: {
  stage: ViewStage;
  entry: ViewEntry;
  isOpen: boolean;
  sel: Sel;
  onToggle: () => void;
  onSel: (sel: Sel) => void;
}) {
  const name = entry.name;
  const score = meanScore(entry.results);
  const selected = sel?.kind === "case" && sel.stage === stage.type && sel.name === name;
  // `!= null` 而不是「文本非空」：空响应用例（output: ""）也要能展开
  const expandable = entry.input != null || entry.output != null;
  return (
    <>
      <button
        type="button"
        className={`caserow${selected ? " on" : ""}${isOpen && expandable ? " open" : ""}`}
        data-testid={`case-row-${stage.type}-${name}`}
        onClick={() => {
          if (expandable) onToggle();
          onSel({ kind: "case", stage: stage.type, name });
        }}
      >
        <span className="tw">{expandable ? "▶" : ""}</span>
        <span className="nm">
          {name}
          {entry.category !== "" && <span className="badge">{entry.category}</span>}
          {/* errored 攻击没有判定——既不是攻破也不是抵御，绝不画成「已抵御」 */}
          {entry.errored
            ? <span className="badge" data-testid={`errored-badge-${name}`}>无有效结论</span>
            : (
              <>
                {entry.breached === true && <span className="badge bad" data-testid={`breach-badge-${name}`}>已攻破</span>}
                {entry.breached === false && <span className="badge ok">已抵御</span>}
              </>
            )}
          {entry.blank_output && (
            <span className="badge warn" data-testid={`blank-badge-${name}`}>空响应 · 已跳过评分</span>
          )}
        </span>
        <span className="meta">
          {entry.turns != null ? `${entry.turns} 轮 · ` : ""}
          {entry.duration_s != null ? `${entry.duration_s.toFixed(1)}s` : "—"}
        </span>
        <span className={`sc${score == null ? " dim" : ""}`}>{fmtScore(score)}</span>
      </button>
      {isOpen && expandable && (
        <div className="caseio" data-testid={`case-io-${stage.type}-${name}`}>
          <div className="iolbl lat">INPUT</div>
          <pre className="blk">{entry.input || "—"}</pre>
          <div className="iolbl lat">OUTPUT</div>
          <pre className="blk">{entry.output || (entry.blank_output ? "（空响应）" : "—")}</pre>
        </div>
      )}
    </>
  );
}

// ==================== 右栏 ====================
// 收的是**已归一化**的 stages（不是 detail）：整棵树的归一化在页面的 useMemo 里
// 做过一次，右栏换选时不该重来一遍。
// onSel 只有 msg 态用：右栏点「中间 N 次工具调用」要回写 Sel.hl 让左栏高亮。
function RightPane({ stages, sel, onSel }: { stages: ViewStage[]; sel: Sel; onSel: (sel: Sel) => void }) {
  let kind = "详情";
  let sub = "";
  let body: ReactNode = (
    <div className="run-empty" data-testid="detail-empty">
      <p>点击左侧步骤查看详情</p>
    </div>
  );

  if (sel) {
    if (sel.kind === "span") {
      const session = findSession(stages, sel.sid);
      const ev = (session?.events ?? []).find(
        (e) => (e.span_id ?? `n${e.n}`) === sel.spanId);
      if (session && ev) {
        kind = "SPAN";
        sub = ev.name || ev.span_id || `#${ev.n}`;
        body = <SpanDetail ev={ev} />;
      }
    } else if (sel.kind === "msg") {
      const session = findSession(stages, sel.sid);
      const ev = (session?.events ?? []).find(
        (e) => (e.span_id ?? `n${e.n}`) === sel.spanId);
      if (session && ev) {
        kind = ev.type === "user" ? "USER" : "AGENT";
        sub = `#${ev.n}`;
        body = (
          <MsgDetail
            ev={ev}
            events={session.events}
            hl={sel.hl ?? []}
            onHl={(keys) => onSel({ kind: "msg", sid: sel.sid, spanId: sel.spanId, hl: keys })}
          />
        );
      }
    } else if (sel.kind === "session") {
      const session = findSession(stages, sel.sid);
      const stage = stages.find((s) => s.sessions.some((x) => x.session_id === sel.sid));
      if (session && stage) {
        kind = "会话";
        sub = session.session_id;
        body = <SessionDetail session={session} stage={stage} />;
      }
    } else {
      const stage = stages.find((s) => s.type === sel.stage);
      const entry = stage && stage.entries.find((e) => e.name === sel.name);
      if (stage && entry) {
        kind = "用例";
        sub = entry.name;
        body = <EntryDetail entry={entry} stage={stage} />;
      }
    }
  }

  return (
    <section className="col" aria-label="详情">
      <div className="colhead">
        <span className="ct">{kind}</span>
        <span className="cs">{sub}</span>
        <span className="hspace" />
      </div>
      <div className="colbody" data-testid="detail-pane">{body}</div>
    </section>
  );
}

function findSession(stages: ViewStage[], sid: string): ViewSession | undefined {
  for (const s of stages) {
    const hit = s.sessions.find((x) => x.session_id === sid);
    if (hit) return hit;
  }
  return undefined;
}

// ---------- 态 A：tool span ----------
function SpanDetail({ ev }: { ev: ViewTranscriptEvent }) {
  return (
    <div data-testid="detail-span">
      <div className="dsec">
        <div className="dsec-h">
          <b className="lat">ATTRIBUTES</b>
          <span className="hspace" />
          {ev.slow && <span className="badge warn">慢调用</span>}
          {ev.error && <span className="badge bad">失败</span>}
        </div>
        <div className="attrs">
          <span className="ak">name</span><span className="av">{displayText(ev.name)}</span>
          <span className="ak">t_offset</span>
          <span className="av">{ev.t_offset_s != null ? `${ev.t_offset_s.toFixed(2)}s` : "—"}</span>
          <span className="ak">duration</span>
          <span className={`av${ev.slow ? " warntxt" : ""}`}>
            {ev.duration_s != null ? `${ev.duration_s.toFixed(2)}s` : "—"}
          </span>
          <span className="ak">error</span>
          {/* null（没这个键）显字面 "null"，"" （有键但空）显空 —— 视图类型把
              这个区分留住了（types.ts 收窄规则 2） */}
          <span className={`av${ev.error ? " bad" : " dim"}`}>
            {ev.error != null ? ev.error : "null"}
          </span>
        </div>
      </div>
      <div className="dsec">
        <div className="dsec-h"><b className="lat">ARGUMENTS</b></div>
        {/* arguments 是 dict（真后端），result 是 JSON 字符串——prettyJson 两种都吃 */}
        <pre className="blk" data-testid="span-arguments">{prettyJson(ev.arguments)}</pre>
        <div className="lbl2 lat">RESULT</div>
        <pre className="blk" data-testid="span-result">
          {ev.error
            ? <span className="je">{ev.error}</span>
            : prettyJson(ev.result)}
        </pre>
      </div>
    </div>
  );
}

// ---------- 态 A'：USER / AGENT 消息 —— 一问一答 ----------
// tool 行的三段式（ATTRIBUTES/ARGUMENTS/RESULT）是工具专属形态，消息行是文本：
// USER 原文进 pre（用户输入不做任何标记解析——那是别人的原话）；AGENT 尾答常是
// 长 markdown 文，复用 markdown-lite 渲染件（范围不扩：它只认列表/粗体/引用行/
// 段落 + 三类 ref）。
//
// 一行一消息时用户点 #1 USER 只看到自己的原话，问「agent 返回为什么没有显示在
// 后面」（2026-09-07 现网反馈）——所以右栏配成一轮：点 USER 行下面跟本轮回复
// （首个 assistant 事件）；点 AGENT 行上面带它答的那个提问（折成一行、可展开）。
// 配对是纯函数 pairing.ts，只吃 session.events。
function MsgDetail({ ev, events, hl, onHl }: {
  ev: ViewTranscriptEvent;
  events: ViewTranscriptEvent[];
  /** 左栏当前因本栏而高亮的 tool 行键 */
  hl: string[];
  onHl: (keys: string[]) => void;
}) {
  const pair = pairTurn(events, events.indexOf(ev));
  const off = (e: ViewTranscriptEvent) => (e.t_offset_s != null ? `${e.t_offset_s.toFixed(1)}s` : "—");

  if (ev.type === "user") {
    const reply = pair.reply;
    const toolKeys = pair.tools.map(spanKeyOf);
    const failed = pair.tools.filter((t) => t.error).length;
    const hlOn = toolKeys.length > 0 && toolKeys.every((k) => hl.includes(k));
    const gap = reply && reply.t_offset_s != null && ev.t_offset_s != null
      ? `${(reply.t_offset_s - ev.t_offset_s).toFixed(1)}s 后`
      : null;
    return (
      <div data-testid="detail-msg">
        <div className="dsec">
          <div className="dsec-h">
            <b className="lat">USER</b>
            <span className="hspace" />
            <span className="num">{off(ev)}</span>
          </div>
          <pre className="blk msgblk" data-testid="msg-text">{ev.text}</pre>
        </div>
        {toolKeys.length > 0 && (
          /* 点一下把左栏这几条 tool 行点亮（与选中行同一套 on），再点一下熄掉 */
          <button
            type="button"
            className={`turn-tools${hlOn ? " on" : ""}`}
            data-testid="msg-turn-tools"
            aria-pressed={hlOn}
            onClick={() => onHl(hlOn ? [] : toolKeys)}
          >
            中间 {toolKeys.length} 次工具调用 · 失败 {failed}
          </button>
        )}
        <div className="dsec">
          <div className="dsec-h">
            <b>回复</b>
            <span className="hspace" />
            {reply && (
              <>
                {gap && <span className="turn-gap" data-testid="msg-reply-gap">{gap}</span>}
                <span className="num">{off(reply)}</span>
              </>
            )}
          </div>
          {reply
            ? <div className="msgbody" data-testid="msg-reply"><SynthesisText text={reply.text} /></div>
            : <div className="turn-none" data-testid="msg-no-reply">这轮没有 Agent 回复</div>}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="detail-msg">
      {pair.user && <QuestionFold user={pair.user} off={off(pair.user)} />}
      <div className="dsec">
        <div className="dsec-h">
          <b className="lat">AGENT</b>
          <span className="hspace" />
          <span className="num">{off(ev)}</span>
        </div>
        <div className="msgbody" data-testid="msg-text"><SynthesisText text={ev.text} /></div>
      </div>
    </div>
  );
}

/** AGENT 态上段：它答的那个提问，默认折成一行（截断），点开看全文。 */
function QuestionFold({ user, off }: { user: ViewTranscriptEvent; off: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dsec">
      <div className="dsec-h">
        <b>提问</b>
        <span className="dim">#{user.n}</span>
        <span className="hspace" />
        <span className="num">{off}</span>
      </div>
      <button
        type="button"
        className={`turn-q${open ? " open" : ""}`}
        data-testid="msg-question"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tw">{open ? "▼" : "▶"}</span>
        <span className="qt">{user.text}</span>
      </button>
    </div>
  );
}

// ---------- 态 B：session ----------
function SessionDetail({ session, stage }: { session: ViewSession; stage: ViewStage }) {
  // metrics 整体可缺（未选 metric key）、每组也可单独缺（filter_metrics）
  const tokens = session.metrics?.tokens?.total;
  const cost = sessionCost(session);
  const { avg, max } = sessionLatency(session);
  const failures = session.diagnosis.failures;
  return (
    <div data-testid="detail-case">
      <div className="dsec">
        <div className="dsec-h">
          <b className="lat">ATTRIBUTES</b>
          <span className="hspace" />
          <span className="badge">{STAGE_LABEL[stage.type] ?? stage.type}</span>
          {session.no_content && <span className="badge warn">无内容 · 已跳过评分</span>}
        </div>
        <div className="attrs">
          <span className="ak">session_id</span>
          <span className="av">{displayText(session.session_id)}</span>
          <span className="ak">tokens</span>
          <span className="av">{typeof tokens === "number" ? tokens.toLocaleString() : "—"}</span>
          <span className="ak">cost_usd</span>
          <span className="av">{cost != null ? cost.toFixed(2) : "—"}</span>
          <span className="ak">latency</span>
          <span className="av">
            {avg != null || max != null
              ? `avg ${avg != null ? `${avg.toFixed(1)}s` : "—"} · max ${max != null ? `${max.toFixed(1)}s` : "—"}`
              : "—"}
          </span>
          {session.error && (
            <>
              <span className="ak">error</span>
              <span className="av bad">{session.error}</span>
            </>
          )}
        </div>
      </div>
      <ScorerSection results={session.results} />
      {!session.diagnosis.clean && failures.length > 0 && (
        <div className="dsec" data-testid="detail-diagnosis">
          <div className="dsec-h"><b className="lat">DIAGNOSIS</b></div>
          {failures.map((f, i) => (
            <div className="diagbox" key={f.span_id ?? i} data-testid={`diagnosis-${f.span_id ?? i}`}>
              {/* confidence 后端是 str(f.confidence)——字符串，不能 .toFixed()。
                  category / evidence 在 SDK 里是 list[str]（types/detector.py:55-57），
                  app/diagnosis.py:33 只对 confidence/evidence 做了 str()，category
                  原样透传 → 实测线上 17/17 条都是数组。数组直渲会粘连成 "abc"，
                  归一化层已用 " · " 连好；这里的 displayText 只管空位占位。 */}
              <b>{displayText(f.category)} · confidence {displayText(f.confidence)}</b>
              <div>
                证据：{displayText(f.evidence)}（span <span className="mono">{f.span_id}</span>）
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 态 B'：dataset / redteam case ----------
function EntryDetail({ entry, stage }: { entry: ViewEntry; stage: ViewStage }) {
  return (
    <div data-testid="detail-case">
      <div className="dsec">
        <div className="dsec-h">
          <b className="lat">ATTRIBUTES</b>
          <span className="hspace" />
          <span className="badge">{STAGE_LABEL[stage.type] ?? stage.type}</span>
          {entry.errored
            ? <span className="badge">无有效结论</span>
            : entry.breached === true && <span className="badge bad">已攻破</span>}
          {entry.blank_output && <span className="badge warn">空响应 · 已跳过评分</span>}
        </div>
        <div className="attrs">
          <span className="ak">name</span><span className="av">{displayText(entry.name)}</span>
          {entry.category !== "" && (
            <><span className="ak">category</span>
              <span className="av">{entry.category}</span></>
          )}
          {entry.strategy !== "" && (
            <><span className="ak">strategy</span><span className="av">{entry.strategy}</span></>
          )}
          {entry.severity !== "" && (
            <><span className="ak">severity</span><span className="av">{entry.severity}</span></>
          )}
          {entry.turns != null && (
            <><span className="ak">turns</span>
              <span className="av">{entry.turns}</span></>
          )}
          <span className="ak">duration</span>
          <span className="av">{entry.duration_s != null ? `${entry.duration_s.toFixed(1)}s` : "—"}</span>
        </div>
      </div>
      {/* eval_skipped 真后端给的是说明字符串（testrun.py），不是 boolean ——
          归一化层已经只取真假（ViewEntry.evalSkipped） */}
      <ScorerSection results={entry.results} skipped={entry.evalSkipped} />
      {/* 红队用例的判定理由不在 results 里，是顶层 reason（judge 原文） */}
      {entry.reason !== "" && (
        <div className="dsec" data-testid="detail-entry-reason">
          <div className="dsec-h"><b className="lat">JUDGE</b></div>
          <pre className="blk">{entry.reason}</pre>
        </div>
      )}
    </div>
  );
}

// ---------- SCORERS：正常画 meter，errored 画斜纹 + 未完成，绝不画 0 分条 ----------
function ScorerSection({ results, skipped }: {
  results: Record<string, ViewEvaluatorResult>;
  skipped?: boolean;
}) {
  const names = Object.keys(results);
  return (
    <div className="dsec">
      <div className="dsec-h">
        <b className="lat">SCORERS</b>
        <span className="hspace" />
        <span>{names.length} 项</span>
      </div>
      {names.length === 0 && (
        <div className="col-note" style={{ padding: 0 }} data-testid="scorers-empty">
          {skipped ? "空响应 · 已跳过评分——无评估结果" : "无评估结果"}
        </div>
      )}
      {names.map((name) => {
        const r = results[name];
        return (
          <div
            key={name}
            className={`scorer-row${r.errored ? " errored" : ""}`}
            data-testid={`scorer-${name}`}
          >
            <span className="sn">
              {name}
              {r.errored && <span className="badge" data-testid={`scorer-badge-${name}`}>未完成</span>}
            </span>
            <span className="meter">
              <span className="meter-track">
                {!r.errored && r.score != null && (
                  <span
                    className={`meter-fill${r.passed === false ? " warn" : ""}`}
                    data-testid={`scorer-fill-${name}`}
                    style={{ width: `${r.score * 100}%` }}
                  />
                )}
              </span>
            </span>
            <span className="sv">{r.errored ? "—" : fmtScore(r.score)}</span>
            {/* reason：实测 28 份线上报告 190 条全是字符串，但 app/main.py:151 是
                **唯一没有 str() 兜的** reason 赋值（其余 testrun/redteam/improve
                都 str() 过），judge 换实现就可能给对象——归一化层（normalizeResults）
                已经把它收成 string，这里读普通字符串。 */}
            <span className="rsn">{r.reason}</span>
          </div>
        );
      })}
    </div>
  );
}
