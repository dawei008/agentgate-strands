// 线上评估（observe）环节的**实时会话清单**纯状态层：评完一条落一行。
//
// ── 为什么不是分栏对话（liveTurns 那套）────────────────────────────────────
// observe 评的是**已经结束**的 trace（历史会话），后端不发、也发不出逐轮事件：
// app/planrun.py:_run_observe_stage 的出口只有 session_result / session_error
// 两种。而且会话是并发评的（STAGE_CONCURRENCY=4 的 semaphore + asyncio
// .as_completed），完成顺序**乱序**，既没有轮次概念也没有稳定顺序。硬塞进
// 对话分栏是错的抽象 —— 会画出一堆只有一行的空栏，还得为「第几轮」编个数。
// 故这里是清单：一条会话评完就落一行，行序 = **评完的顺序**（不是会话时间序，
// 界面必须写明，否则用户会以为是按时间排的）。
//
// ── 三种事件（形态照后端源码核实，不猜）──────────────────────────────────
//
// A) observe_sessions —— app/planrun.py:_run_observe_stage（本批新增）
//    {"event":"observe_sessions","stage":N,"total":M}
//    M = 本环节**计划评**的会话数，做「已评 N/M」的分母。没有它前端只能数上去
//    （「已评 3 个」），说不出进度。空会话的 run 不发（后端在 empty 分支之后
//    才 emit），故 total 恒 ≥ 1 或压根没有。
//
// B) session_result —— app/main.py:_evaluate_session 的返回原样透传
//    {"event":"session_result","agent":…,"session_id":…,"span_count":N,
//     "output_preview":"…","results":{<评估器>:{score,passed,errored,reason}},
//     "metrics":…|null,"transcript":…|null,"diagnosis":…|null,
//     ["no_content":true,"warning":"…"]}
//
// C) session_error —— 同上，取失败分支
//    {"event":"session_error","agent":…,"session_id":…,"span_count":N,"error":"…"}
//
// ── 四个数据坑（都在后端源码里有据，不是防御性臆想）────────────────────────
//
//  1. `score` 可以是 **null**（app/main.py:148 `None if errored else …`）。
//     judge 被限流 / SDK 抛异常时 SDK 把它伪造成 0 分 + reason 里塞错误串，
//     后端识别出来置 null 并标 errored —— 前端**绝不能把 null 当 0** 参与均分，
//     那正是「空响应被判 0 分」那类事故的同一个形状。
//
//  2. `reason` **可能不是字符串**。dataset 那侧后端做了 `str(report.reasons[i])`
//     （app/testrun.py:527），observe 这侧**没有**（app/main.py:151 直接透传），
//     所以结构化 judge 的 reason 会以对象形态上线（实测形态 `{summary: "…"}`）。
//     直接 `{r.reason}` 渲染 React 会抛 "Objects are not valid as a React child"
//     → 白屏。这是前端第二个白屏入口（第一个是 RunDetailPage:831 的同一个字段），
//     故规范化必须在**状态层**做，组件永远只拿到 string。
//
//  3. `session_error` 可能缺字段：`error` 缺/空 → 给中性兜底文案而不是空白；
//     极端情况连 `session_id` 都没有时**仍然落这一行**（丢掉一条失败会话比行键
//     难看严重得多），用到达序造唯一键。
//
//  4. **乱序**到达 + 可能重复：React key 必须用 `session_id`（不是数组下标，
//     也不是到达序 —— 重发同一条会话时下标/序号会漂）。同 id 再来一次按
//     **原位替换**，不新增一行、不重复计数。
//
// ── no_content 与分数口径（docs/adr/0003-score-required-for-success.md，
//    含 2026-08-24 Amendment：成功与分数拆成两条正交口径）────────────────────
// `no_content: true`（住所：`app/observe.py` 的 `evaluate_session` —— 该函数按
// `output_preview` 是否空白置位；不写行号，搬一次就过期）= trace 里根本没有消息
// 内容。**成因不在前端猜**：后端按本次观测到的 span 分档写进 `warning`（查不到
// span / span 没写全 / 已写全但没内容 / 分不出来），前端原样透传那句话。
// 后端把所有分数强制置 null。这类会话与「评估器全挂」都不是 0 分，一律走中性档，
// 不进本环节均分。
import type { ApiEvent } from "../../lib/api";

/** 清单**内存上限**：超出的老行真丢弃（不是隐藏）。
 *  50 = 编辑器 max_sessions 的上限（PlanEditor.tsx:649 clampInt(…,1,50)）。
 *  手挑 session_ids 那条专家路径**没有上限**（后端只过滤空白串），所以这个
 *  封顶不是装饰 —— 用户粘 500 个 id 进去时它是唯一的护栏。 */
export const ROW_KEEP = 50;

/** 一行会话的结论档（**没有 0 分档** —— 实时期不做判定，分数由后端给）：
 *    scored     有可用分数
 *    no-score   评完了但没有可用分数（评估器全 errored，如 judge 被限流）
 *    no-content trace 无消息内容（no_content:true），本就无从评分
 *    errored    session_error：这条会话根本没评上 */
export type ObserveStatus = "scored" | "no-score" | "no-content" | "errored";

export interface ObserveScore {
  /** 评估器名（results 的 key） */
  name: string;
  /** null = 无可用分数（errored 或 no_content 置空）——**不是 0 分** */
  score: number | null;
  errored: boolean;
  /** 已规范化成字符串的 reason（后端可能给对象，见顶部坑 2） */
  reason: string;
}

export interface ObserveRow {
  /** 到达序（= 评完的顺序）。只用于展示「第 N 条评完」与兜底键，**不做 React key** */
  seq: number;
  /** React key。同 id 重发按原位替换（见顶部坑 4） */
  key: string;
  /** 后端 session_id 原文；缺失时为 null */
  sessionId: string | null;
  agent: string | null;
  status: ObserveStatus;
  /** 均分：只统计有数的分数；无可评分项 → null（**不是 0**） */
  mean: number | null;
  scores: ObserveScore[];
  /** session_error 的原因（其它档为 null） */
  error: string | null;
  /** 后端 warning（no_content 时解释为什么没内容） */
  warning: string | null;
  spanCount: number | null;
  outputPreview: string;
  /** 前端接收时刻（后端逐会话事件不带时间戳） */
  ts: number;
}

export interface ObserveSessionsState {
  /** 按**评完顺序**排列（不是会话时间序） */
  rows: ObserveRow[];
  /** observe_sessions 给的分母；null = 还没收到 → 界面只说「已评 N」不编分母 */
  total: number | null;
  /** 分母所属环节号（一个方案可以有两个 observe 环节，换环节要换分母） */
  totalStage: number | null;
  scored: number;
  noScore: number;
  noContent: number;
  errored: number;
  /** 超上限被真丢弃的老行数（只留计数） */
  dropped: number;
}

export const EMPTY_OBSERVE_SESSIONS: ObserveSessionsState = {
  rows: [], total: null, totalStage: null,
  scored: 0, noScore: 0, noContent: 0, errored: 0, dropped: 0,
};

/**
 * 任意 reason → 可渲染字符串（坑 2 的唯一出口）。
 *
 * observe 这侧后端不做 str() 强转，结构化 judge 的 reason 会是对象。直接把它
 * 交给 JSX 就是白屏，故在状态层收口：
 *   · string          → 原样（trim 掉两端空白）
 *   · {summary: "…"}  → 取 summary（实测形态；再套一层对象时递归取）
 *   · 其它对象/数组   → JSON 序列化（读得懂总比白屏好，也便于排查真形态）
 *   · null/undefined  → ""
 */
export function reasonText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const rec = v as Record<string, unknown>;
    // 实测形态 {summary: "…"}；也见过 {summary: {text: …}} 这种再套一层
    if ("summary" in rec) {
      const inner = reasonText(rec.summary);
      if (inner) return inner;
    }
    if ("reason" in rec) {
      const inner = reasonText(rec.reason);
      if (inner) return inner;
    }
    try {
      return JSON.stringify(v);
    } catch {
      // 循环引用（SSE 解析出来的不会有，但兜住总比抛异常好）
      return "（无法显示的 reason 结构）";
    }
  }
  return String(v);
}

/** results（评估器 → {score,…}）→ 规范化数组。顺序照后端 key 顺序，不排序
 *  ——排序会让同一 run 里两条会话的评估器列顺序不一致，肉眼对不上。 */
export function scoresOf(results: unknown): ObserveScore[] {
  if (!results || typeof results !== "object" || Array.isArray(results)) return [];
  return Object.entries(results as Record<string, unknown>).map(([name, raw]) => {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const errored = r.errored === true;
    // errored 时后端已置 null；这里再把「errored 却带着数字」的情况也挡掉
    // ——SDK 伪造的 0 分绝不能因为后端某天漏置 null 就漏进均分
    const score = !errored && typeof r.score === "number" && Number.isFinite(r.score)
      ? r.score : null;
    return { name, score, errored, reason: reasonText(r.reason) };
  });
}

/** 均分：只统计有数的分数；一条也没有 → null（**不是 0**，见顶部坑 1） */
export function meanOf(scores: ObserveScore[]): number | null {
  const ok = scores.map((s) => s.score).filter((v): v is number => typeof v === "number");
  if (ok.length === 0) return null;
  return ok.reduce((a, b) => a + b, 0) / ok.length;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 会话 id 短形态。与滚动日志里那行**同口径**（useRunPlan 复用本函数）——
 *  同一条会话在日志和清单里必须显示成同一个短 id，否则用户对不上。
 *
 *  这条「同一个短 id」的要求不止管本页两处：报告页的矩阵行 / tile / 裁决句走的是
 *  **首段 8 位 hex**（lib/text.shortSessionId），而这里此前是「截前 12 字 + …」
 *  ⇒ 同一条会话在实时清单里是 `dsh-trace-e5…`、在报告里是 `e5d8fb96`，跑完一看
 *  对不上。收敛到 lib 那一份；本导出保留给本模块的两个消费点（清单行 / 滚动日志）。 */
export { shortSessionId } from "../../lib/text";

/** 事件 → 一行（非本层事件返回 null）。seq 用于兜底键与「第 N 条」标签 */
export function observeRowOf(ev: ApiEvent, seq: number, now: number): ObserveRow | null {
  const rec = ev as { event: string } & Record<string, unknown>;
  if (rec.event !== "session_result" && rec.event !== "session_error") return null;

  const sessionId = str(rec.session_id);
  // 连 session_id 都没有时仍然落行：丢一条失败会话比键难看严重得多（坑 3）
  const key = sessionId ?? `(未知会话)#${seq}`;
  const agent = str(rec.agent);
  const spanCount = typeof rec.span_count === "number" && Number.isFinite(rec.span_count)
    ? rec.span_count : null;
  const base = {
    seq, key, sessionId, agent, spanCount, ts: now,
    warning: str(rec.warning),
  };

  if (rec.event === "session_error") {
    return {
      ...base, status: "errored", mean: null, scores: [],
      // error 缺/空 → 中性兜底，不留空白（坑 3）
      error: str(rec.error) ?? "评分失败（后端未给原因）",
      outputPreview: "",
    };
  }

  const scores = scoresOf(rec.results);
  const mean = meanOf(scores);
  const noContent = rec.no_content === true;
  const status: ObserveStatus = noContent ? "no-content"
    : mean == null ? "no-score" : "scored";
  return {
    ...base, status, mean, scores, error: null,
    outputPreview: typeof rec.output_preview === "string" ? rec.output_preview : "",
  };
}

type CounterKey = "scored" | "noScore" | "noContent" | "errored";

const COUNTER: Record<ObserveStatus, CounterKey> = {
  scored: "scored", "no-score": "noScore",
  "no-content": "noContent", errored: "errored",
};

/** 计数**累计**，不从 rows 重算：超 ROW_KEEP 丢掉的老行仍要算进「已评 N」，
 *  按 rows 重算会让分子在丢行后往回缩（界面从「已评 51」变回「已评 50」）。
 *  同 id 重发（先 session_error 后 session_result 那种）要减掉旧档再加新档。 */
function bumped(
  state: ObserveSessionsState, rows: ObserveRow[], dropped: number,
  added: ObserveStatus, removed: ObserveStatus | null,
): ObserveSessionsState {
  const next: ObserveSessionsState = { ...state, rows, dropped };
  if (removed) {
    const k = COUNTER[removed];
    next[k] = Math.max(0, next[k] - 1);
  }
  const k = COUNTER[added];
  next[k] += 1;
  return next;
}

/**
 * 累积一条 observe 事件。返回新对象；**非本层事件返回原引用**（不触发重渲）。
 *
 * 三种事件都在这里收：
 *   · observe_sessions → 记分母（换环节号即换分母，旧行不动）
 *   · session_result / session_error → 落一行（同 id 原位替换）
 */
export function pushObserveSession(
  state: ObserveSessionsState,
  ev: ApiEvent,
  now: number,
): ObserveSessionsState {
  const rec = ev as { event: string } & Record<string, unknown>;

  if (rec.event === "observe_sessions") {
    const total = typeof rec.total === "number" && Number.isFinite(rec.total) && rec.total > 0
      ? Math.floor(rec.total) : null;
    if (total == null) return state; // 不合契约就当没收到，绝不编一个分母
    const stage = typeof rec.stage === "number" ? rec.stage : null;
    if (total === state.total && stage === state.totalStage) return state;
    return { ...state, total, totalStage: stage };
  }

  const row = observeRowOf(ev, state.rows.length + state.dropped + 1, now);
  if (!row) return state;

  const idx = state.rows.findIndex((r) => r.key === row.key);
  const replaced = idx >= 0 ? state.rows[idx] : null;
  let rows = replaced
    // 同 id 重发：原位替换（行位置不跳动），沿用原来的 seq 让「第 N 条」稳定
    ? state.rows.map((r, i) => (i === idx ? { ...row, seq: r.seq } : r))
    : [...state.rows, row];

  let dropped = state.dropped;
  if (rows.length > ROW_KEEP) {
    const overflow = rows.length - ROW_KEEP;
    rows = rows.slice(overflow);
    dropped += overflow;
  }
  return bumped(state, rows, dropped, row.status, replaced?.status ?? null);
}

/** 已落行数（含被丢弃的老行）= 「已评 N/M」的分子 */
export function doneCount(state: ObserveSessionsState): number {
  return state.scored + state.noScore + state.noContent + state.errored;
}
