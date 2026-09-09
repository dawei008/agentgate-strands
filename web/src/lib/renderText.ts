// 「后端任意形态 → 可渲染文本」的归一化。纯函数，无 React 依赖。
//
// 为什么需要这一层（UI-026 白屏事故）
//   点开线上评估会话整页白屏，React error #31
//   `Objects are not valid as a React child (object with keys {summary})`。
//   根因不在 scorer 的 reason（实测 28 份线上报告里 190 条 reason **全是字符串**），
//   而在 **transcript.events[].arguments**：
//     app/transcript.py:64  "arguments": tc.arguments if tc else None
//   `tc.arguments` 的 SDK 契约是 `dict`（strands_evals/types/trace.py:41），
//   后端**没有** str() 兜，原样落进 S3 报告。实测 428/428 次出现全是 dict。
//   本页两处把它当 React child 直渲（trace 行内摘要 + 右栏 ARGUMENTS 块），
//   于是「工具入参恰好只有 summary 一个键」的会话一点就炸整个应用。
//   旧版 ui/app.js:2504 用 `JSON.stringify(e.arguments ?? {})` 兜住了，
//   React 重写把这层兜底丢了——所以只有新版白屏。
//
// 纪律：**任何**来自后端的值进 JSX 文本位前都过这里，不许裸渲。
//   - React 能渲染字符串数组（`["a","b"]` → "ab"），所以 list 不炸但会粘连；
//     普通对象则直接抛 #31 拆掉整棵子树。两种都不可接受，都在这里归一。

/** 空位统一显示为长破折号——「没有」要看得见，不留静默空白。 */
export const EMPTY_MARK = "—";

/** 降级文本里 JSON 的截断长度：够定位问题，又不至于把一行撑爆。 */
const MAX_JSON = 300;

/** 行内 JSON 预览的截断长度（对齐旧版 ui/app.js:2504 的 120）。 */
const MAX_INLINE = 120;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function safeJson(v: unknown, indent?: number): string {
  try {
    // 循环引用 / BigInt 都会抛，抛了就退到 String()——绝不把对象漏给 JSX
    return JSON.stringify(v, null, indent) ?? String(v);
  } catch {
    return String(v);
  }
}

/** 未预期的结构：列出键 + 截断 JSON，让人能照着去查后端，而不是看一片空白。 */
function degraded(v: Record<string, unknown>): string {
  const keys = Object.keys(v);
  return `[未预期的结构 · 键：${keys.length ? keys.join(", ") : "无"}] ${clip(safeJson(v), MAX_JSON)}`;
}

/**
 * 文本位归一：reason / category / evidence 这类「后端说是字符串」的字段。
 *
 *   string           → 原样
 *   number / boolean → String()
 *   null/undefined   → ""（空态由调用方用 EMPTY_MARK 表达）
 *   数组             → 逐项归一后用 " · " 连（真后端 diagnosis.failures[].category
 *                      是 list[str]，直渲会粘连成 "abc"）
 *   {summary: str}   → 取 summary（judge/工具入参的摘要形态）
 *   其它对象         → 可诊断的降级文本，绝不直渲、绝不静默空白
 */
export function textOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return v.map(textOf).filter((s) => s !== "").join(" · ");
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.summary === "string" && o.summary !== "") return o.summary;
    return degraded(o);
  }
  return String(v);
}

/** textOf + 空态：给「一定要占位」的位置用。 */
export function displayText(v: unknown): string {
  const s = textOf(v);
  return s.trim() === "" ? EMPTY_MARK : s;
}

/**
 * 行内单行预览：工具入参这类结构化值，压成紧凑 JSON 并截断。
 * 语义对齐旧版 `JSON.stringify(e.arguments ?? {}).slice(0, 120)`。
 */
export function inlineJson(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return clip(v, MAX_INLINE);
  return clip(safeJson(v), MAX_INLINE);
}

/**
 * 代码块用的格式化 JSON。
 * 后端这里既可能给 JSON 字符串（dataset/redteam 的 result），也可能给**对象**
 * （observe 的 arguments 是 dict）。原实现签名是 `string`，对象走 JSON.parse
 * 抛错后把**对象本身**返回，于是右栏 ARGUMENTS 块也是一个 #31 崩点。
 */
export function prettyJson(v: unknown): string {
  if (v == null) return EMPTY_MARK;
  if (typeof v === "string") {
    try {
      return safeJson(JSON.parse(v), 2);
    } catch {
      return v;
    }
  }
  if (typeof v === "object") return safeJson(v, 2);
  return String(v);
}
