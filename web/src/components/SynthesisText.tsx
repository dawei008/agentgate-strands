// 综合报告正文的 markdown-lite 渲染件（共享组件，首个消费方：运行详情页的
// 「综合报告」折叠块）。此前该页把 plan_synthesis 整段生文本打出来 ——
// `## `、`**`、`- `、`> `、[run:#N] 全裸露（用户 2026-08-31 原话「一大堆看不懂」）。
//
// 渲染件是 F1（99fc941 的 ReportView.tsx）删掉那套的**收窄复刻**：
//   parseReportBlocks / takeList / boldTokens / runRefTokens / caseTokens /
//   sessionTokens / InlineChips —— 切块与 ref 正则逐字沿用（多编号
//   `[run:#1→#2]` 的逐编号切分是修过一轮缺陷的，不重新发明）；建议卡
//   （tryAdvice 四要素）**不搬**——本组件只认综合报告实际会产的四样：
//   `- `/`1. ` 列表、`**粗体**`、`> ` 引用行、普通段落，不做全量 markdown
//   （不引依赖：多一个 markdown 依赖是多一份 XSS 面与包体）。
//
// 引用记号（[run:#N] / [case:名@agent] / [session:id]）→ 实心 chip
// （badge 语义类 + mono）。缺省 chips **不带跳转**（运行详情页没有跨 run 跳表），
// 也不挂 title 不写解释句（界面零通用散文，2026-08-30 终裁）。
// 评估分析页（adr0014-migrate 批）传 `onRefClick` 后，有落点的 chip 才渲成
// <button>（落点有无由 `jumpable` 判：没有落点的 chip 保持 <span>，不给一个点了
// 没反应的按钮）—— 不传这两个 prop 时输出与此前逐字节相同。
// session id 走**界面短显的唯一实现**（lib/text.shortSessionId = 首段 8 位 hex），
// 完整值在 data-full 属性里（可复制）。此前这里私写「截前 18 字 + …」，于是同一屏上
// 问题条目印 `dsh-trace-e5d8fb96…` 而矩阵行 / 裁决句印 `e5d8fb96`，读者对不上是哪一条。
import { useMemo } from "react";
import type { ReactNode } from "react";
import { shortSessionId } from "../lib/text";
import "./SynthesisText.css";

/** 正文里的一处引用（三种记号的结构化形态；`synthesisRefs` 与 chip 点击回调共用）。 */
export type SynthRef =
  | { kind: "run"; n: number }
  | { kind: "case"; name: string; agent: string }
  | { kind: "session"; id: string; msgNo: number | null };

/** 引用的可读标签（chip 上印的字）。 */
export function synthRefLabel(ref: SynthRef): string {
  if (ref.kind === "run") return `run:#${ref.n}`;
  if (ref.kind === "case") return ref.name;
  return shortSessionId(ref.id) + (ref.msgNo != null ? ` #${ref.msgNo}` : "");
}

/** 引用的完整值（data-full；case 带 agent、session 是完整 id；也是去重键）。 */
export function synthRefFull(ref: SynthRef): string {
  if (ref.kind === "run") return `run:#${ref.n}`;
  if (ref.kind === "case") return ref.agent ? `${ref.name}@${ref.agent}` : ref.name;
  return ref.id;
}

/** chip 的跳转选项：只在消费方要双向深链时传。 */
interface RefOpts {
  onRefClick?: (ref: SynthRef) => void;
  /** 这处引用在页面上有没有落点；缺省 = 有 onRefClick 就都算有 */
  jumpable?: (ref: SynthRef) => boolean;
}

/**
 * 用例引用：`[case:用例名@Agent名]`（引用格式由后端 prompt 强制，testrun.py:977）。
 * 正则逐字来自 99fc941 的 derive.CASE_REF（F1 随消费方一起删了，本组件是现在
 * 唯一消费方）：`@Agent名` **不保证存在**（实测现网 161 条引用里 36 条只有用例
 * 名），所以 Agent 段是可选组；用例名段不含 `@` 与 `]`。
 * 全局正则有 lastIndex 状态 —— 使用前必须置 0（消费点已置）。
 */
const CASE_REF = /\[case:([^\]@]+)(?:@([^\]]*))?\]/g;

/**
 * 会话引用：`[session:完整会话ID]` 或 `[session:完整会话ID#N]`（N = 时间线消息
 * 编号；格式由 observe.py ANALYSIS_SYSTEM_PROMPT 强制）。正则逐字来自 99fc941
 * 的 derive.SESSION_REF —— 会话 id 里没有 `#` 与 `]`（编号用 `#` 分隔正是仗着
 * 这一点）。全局正则有 lastIndex 状态，使用前必须置 0。
 */
const SESSION_REF = /\[session:([^\]#\s]+)(?:#(\d+))?\]/g;

// ---------- 切块层（历史 parseReportBlocks 的无建议卡版本） ----------

export type SynthListItem = { depth: number; text: string };

export type SynthBlock =
  | { kind: "p"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: SynthListItem[] };

const LIST_ITEM = /^([ \t]*)([-*•]|\d+[.)])[ \t]+(.*)$/;
const QUOTE_LINE = /^[ \t]*>[ \t]?(.*)$/;

function takeList(lines: string[], start: number): {
  block: Extract<SynthBlock, { kind: "list" }>; next: number;
} {
  const head = lines[start].match(LIST_ITEM)!;
  const ordered = /^\d/.test(head[2]);
  // 有序列表的起始序号取 judge 写的那个数（`start` 属性），**不重编号**：
  // 从 2 开始的清单被浏览器重编成 1 就是悄悄改了内容。
  const from = ordered ? parseInt(head[2], 10) : 1;
  const items: SynthListItem[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break;
    const m = line.match(LIST_ITEM);
    if (m) {
      if (/^\d/.test(m[2]) !== ordered) break; // 换了清单类型 → 另起一块
      const indent = m[1].replace(/\t/g, "  ").length;
      items.push({ depth: indent >= 2 ? 1 : 0, text: m[3].trim() });
      continue;
    }
    if (QUOTE_LINE.test(line)) break;
    // 缩进的非标记行 = 本项的软换行（judge 写长句会折行），不另起一段
    if (/^[ \t]+\S/.test(line) && items.length > 0) {
      items[items.length - 1].text += `\n${line.trim()}`;
      continue;
    }
    break;
  }
  return { block: { kind: "list", ordered, start: from, items }, next: i };
}

/** 正文切块：段落 / 引文块 / 列表。导出为纯函数便于直测。 */
export function parseSynthesisBlocks(body: string): SynthBlock[] {
  const lines = body.split("\n");
  const out: SynthBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") { i++; continue; }

    if (LIST_ITEM.test(lines[i])) {
      const { block, next } = takeList(lines, i);
      const last = out[out.length - 1];
      // 同型列表跨空行合并：不合并的话有序列表会从 1 重新数
      if (last && last.kind === "list" && last.ordered === block.ordered) {
        last.items.push(...block.items);
      } else out.push(block);
      i = Math.max(next, i + 1);
      continue;
    }

    if (QUOTE_LINE.test(lines[i])) {
      const buf: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(QUOTE_LINE);
        if (!m) break;
        buf.push(m[1]);
        i++;
      }
      const text = buf.join("\n").trim();
      if (text) out.push({ kind: "quote", text });
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "" || QUOTE_LINE.test(line) || LIST_ITEM.test(line)) break;
      buf.push(line);
      i++;
    }
    const text = buf.join("\n").trim();
    if (text) out.push({ kind: "p", text });
    if (buf.length === 0) i++; // 死循环保险：任何未预料的行也要往前走一格
  }
  return out;
}

// ---------- 行内层：ref chip 与加粗 ----------

// 溯源引用的整块形态：`[run:#…]` 方括号里**可以有多个编号**——现网真字节
// `[run:#1→#2]`（judge 连写两个 run），同族还写得出 `,`、`、`、`-`、空格分隔。
// 外层先抓整块，内层 RUN_NO 把编号逐个切出各自成 chip；区间形态（#1→#2）
// 只渲染两端两个 chip、**不展开中间**——中间的 run 没被 judge 点名，
// 造出来就是编数据。
const RUN_REF = /\[run:#[^\]]+\]/g;
const RUN_NO = /#(\d+)/g;

/** `**加粗**`：最内层，星号不跨行、不嵌套（与后端产出一致）。 */
const BOLD = /\*\*([^*\n]+)\*\*/g;

function boldTokens(chunk: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  BOLD.lastIndex = 0;
  while ((m = BOLD.exec(chunk)) !== null) {
    if (m.index > last) out.push(chunk.slice(last, m.index));
    out.push(<b key={`${keyBase}-b${m.index}`}>{m[1]}</b>);
    last = m.index + m[0].length;
  }
  if (last < chunk.length) out.push(chunk.slice(last));
  return out;
}

/** 行内会话引用：`[session:完整会话ID]` / `[session:完整会话ID#N]`。
 *  截尾显示，完整 id 落 data-full（可复制）。 */
function sessionTokens(chunk: string, keyBase: string, opts: RefOpts): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  SESSION_REF.lastIndex = 0;
  while ((m = SESSION_REF.exec(chunk)) !== null) {
    if (m.index > last) {
      out.push(...boldTokens(chunk.slice(last, m.index), `${keyBase}-s${last}`));
    }
    const sid = m[1].trim();
    const msgNo = m[2] ? Number(m[2]) : null;
    out.push(refChip({ kind: "session", id: sid, msgNo }, "syn-session-ref",
                     `${keyBase}-sr${m.index}`, opts));
    last = m.index + m[0].length;
  }
  if (last < chunk.length) {
    out.push(...boldTokens(chunk.slice(last), `${keyBase}-s${last}`));
  }
  return out;
}

/** 行内用例引用：`[case:用例名@Agent名]`（后端 prompt 强制格式）。 */
function caseTokens(chunk: string, keyBase: string, opts: RefOpts): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  CASE_REF.lastIndex = 0;
  while ((m = CASE_REF.exec(chunk)) !== null) {
    if (m.index > last) {
      out.push(...sessionTokens(chunk.slice(last, m.index), `${keyBase}-t${last}`, opts));
    }
    const name = m[1].trim();
    const agent = (m[2] ?? "").trim();
    out.push(refChip({ kind: "case", name, agent }, "syn-case-ref", `${keyBase}-c${m.index}`, opts));
    last = m.index + m[0].length;
  }
  if (last < chunk.length) {
    out.push(...sessionTokens(chunk.slice(last), `${keyBase}-t${last}`, opts));
  }
  return out;
}

/**
 * 一枚引用 chip。缺省是 <span>（与历史输出逐字节同）；消费方传了 onRefClick
 * 且这处引用有落点（jumpable）才是 <button>。两态都不挂 title（零通用散文）。
 */
function refChip(ref: SynthRef, testId: string, key: string, opts: RefOpts): ReactNode {
  const label = synthRefLabel(ref);
  const full = ref.kind === "run" ? undefined : synthRefFull(ref);
  const canJump = opts.onRefClick != null && (opts.jumpable ? opts.jumpable(ref) : true);
  if (canJump) {
    return (
      <button
        key={key}
        type="button"
        className="badge syn-ref is-link"
        data-testid={testId}
        data-full={full}
        onClick={() => opts.onRefClick!(ref)}
      >
        {label}
      </button>
    );
  }
  return (
    <span key={key} className="badge syn-ref" data-testid={testId} data-full={full}>
      {label}
    </span>
  );
}

/**
 * 一个 `[run:#…]` 整块 → chip 序列。块内**每个**编号各自成 chip；编号间的
 * 分隔符（→ , 、 - 空格）原样回填为普通文本——那是 judge 的原话，不代写。
 * 一个编号都切不出的块按原文渲染（与「正则不匹配」的降级同形，不吞字）。
 */
function runRefTokens(block: string, at: number, opts: RefOpts): ReactNode[] {
  const inner = block.slice("[run:".length, -1);
  const hits: { n: number; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  RUN_NO.lastIndex = 0;
  while ((m = RUN_NO.exec(inner)) !== null) {
    hits.push({ n: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }
  if (hits.length === 0) return [block];
  const out: ReactNode[] = [];
  hits.forEach((hit, k) => {
    if (k > 0) out.push(inner.slice(hits[k - 1].end, hit.start));
    out.push(refChip({ kind: "run", n: hit.n }, "syn-run-ref", `${at}-${k}-${hit.n}`, opts));
  });
  return out;
}

/** 块内 `[run:#…]` 的编号序列（与 runRefTokens 同一把正则；给 synthesisRefs 用）。 */
function runNosOf(block: string): number[] {
  const inner = block.slice("[run:".length, -1);
  const out: number[] = [];
  let m: RegExpExecArray | null;
  RUN_NO.lastIndex = 0;
  while ((m = RUN_NO.exec(inner)) !== null) out.push(Number(m[1]));
  return out;
}

/**
 * 正文里的全部引用，**去重、保首见序**（同一用例被点名三次只算一处）。
 * 三把正则与渲染层同一份 —— 渲染出几种 chip、这里就数出几处，两边不许各解一遍。
 * 评估分析页拿它画卡底「引用」行，并当采纳表未采纳组的排序键（契约里没有
 * 「预计影响用例数」这个字段，用 LLM 点名的引用数代）。
 */
export function synthesisRefs(text: string): SynthRef[] {
  const out: SynthRef[] = [];
  const seen = new Set<string>();
  const push = (r: SynthRef) => {
    const k = `${r.kind}|${synthRefFull(r)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(r);
  };
  let m: RegExpExecArray | null;
  RUN_REF.lastIndex = 0;
  while ((m = RUN_REF.exec(text)) !== null) {
    for (const n of runNosOf(m[0])) push({ kind: "run", n });
  }
  CASE_REF.lastIndex = 0;
  while ((m = CASE_REF.exec(text)) !== null) {
    push({ kind: "case", name: m[1].trim(), agent: (m[2] ?? "").trim() });
  }
  SESSION_REF.lastIndex = 0;
  while ((m = SESSION_REF.exec(text)) !== null) {
    push({ kind: "session", id: m[1].trim(), msgNo: m[2] ? Number(m[2]) : null });
  }
  return out;
}

/** 三种引用可以同段共存：run 引用最外层，非引用文本再过 case、session、加粗。 */
function InlineChips({ text, opts }: { text: string; opts: RefOpts }) {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  RUN_REF.lastIndex = 0;
  while ((m = RUN_REF.exec(text)) !== null) {
    if (m.index > last) {
      out.push(...caseTokens(text.slice(last, m.index), `r${last}`, opts));
    }
    out.push(...runRefTokens(m[0], m.index, opts));
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push(...caseTokens(text.slice(last), `r${last}`, opts));
  }
  return <>{out}</>;
}

// ---------- 组件 ----------

/** 列表块（两级）：连续的第二级项挂到最近的顶层项下。 */
function ListBlock({ block, opts }: { block: Extract<SynthBlock, { kind: "list" }>; opts: RefOpts }) {
  const tree: { text: string; children: string[] }[] = [];
  for (const it of block.items) {
    if (it.depth === 0 || tree.length === 0) tree.push({ text: it.text, children: [] });
    else tree[tree.length - 1].children.push(it.text);
  }
  const items = tree.map((node, i) => (
    <li key={i}>
      <InlineChips text={node.text} opts={opts} />
      {node.children.length > 0 && (
        <ul className="syn-list is-sub">
          {node.children.map((c, j) => <li key={j}><InlineChips text={c} opts={opts} /></li>)}
        </ul>
      )}
    </li>
  ));
  return block.ordered ? (
    <ol className="syn-list" start={block.start} data-testid="syn-list">{items}</ol>
  ) : (
    <ul className="syn-list" data-testid="syn-list">{items}</ul>
  );
}

/** 正文分块渲染：段落 / 引文块 / 列表；[run:#N]/[case:…]/[session:…] 内联转 chip。
 *  `onRefClick` / `jumpable` 见 RefOpts —— 都不传时输出与此前逐字节相同。 */
export default function SynthesisText({ text, onRefClick, jumpable }: {
  text: string;
  onRefClick?: (ref: SynthRef) => void;
  jumpable?: (ref: SynthRef) => boolean;
}) {
  const blocks = useMemo(() => parseSynthesisBlocks(text), [text]);
  const opts: RefOpts = { onRefClick, jumpable };
  return (
    <div className="syn-body">
      {blocks.map((block, i) => {
        if (block.kind === "quote") {
          return (
            <div key={i} className="syn-quote" data-testid="syn-quote">
              <InlineChips text={block.text} opts={opts} />
            </div>
          );
        }
        if (block.kind === "list") return <ListBlock key={i} block={block} opts={opts} />;
        return <p key={i} className="syn-p"><InlineChips text={block.text} opts={opts} /></p>;
      })}
    </div>
  );
}
