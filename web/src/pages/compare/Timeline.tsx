// 会话时间线（ADR-0017 D3 / F8）：双栏与单栏是**同一个组件**——
// 传两侧 = 并排 diff（按 `n` 对位、同一时间刻度、中缝连线、差异块高亮）；
// 只传一侧 = 单栏回放（报告页格详情「回放」与未对齐行共用）。
//
// 纵向位置按 `t_offset_s` 比例排（px/s 的 scale 两侧同一个数，所以「同一刻度」
// 不是口头承诺而是同一个变量）；块与块之间至少留 GAP，密集处 scale 自动放大——
// 量的是真实 DOM 高度（useLayoutEffect），jsdom 里高度为 0 时退化成纯比例排布。
//
// 玻璃纪律：块是实心 --surface-2 + 发丝线；差异态只走左侧色条 + badge，零 blur。
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { EMPTY_MARK, inlineJson, textOf } from "../../lib/renderText";
import type { SessionEvent, SessionSide } from "../../lib/apiTypes";
import { WHO, tickStep, timedEvents, timelineRounds, type BlockState, type TimelineRound } from "./pairsDerive";

/** px / 秒的起点档；块挤不下时向上放大，封顶 MAX。长会话（几十秒）先按 TARGET_HEIGHT 压缩
 *  起点档（否则 25 s 的会话要 1600px 高），块之间仍由 GAP 兜底不重叠。 */
const BASE_SCALE = 64;
const MAX_SCALE = 320;
const MIN_SCALE = 12;
const TARGET_HEIGHT = 720;
const GAP = 12;
const PAD = 16;

const STATE_BADGE: Record<Exclude<BlockState, "same">, { cls: string; text: string }> = {
  modified: { cls: "warn", text: "Modified" },
  removed: { cls: "bad", text: "Removed" },
  added: { cls: "ok", text: "Added" },
};

interface Layout {
  tops: Record<string, number>;
  height: number;
  scale: number;
}

export default function Timeline({ left, right, testid }: {
  left: SessionSide | null;
  right: SessionSide | null;
  testid: string;
}) {
  const single = !(left && right);
  const rounds = useMemo<TimelineRound[]>(() => {
    if (left && right) return timelineRounds(left.events, right.events);
    const side = left ?? right;
    return (side?.events ?? []).map((e) => ({
      n: e.n, left: left ? e : null, right: right ? e : null, state: "same" as const,
    }));
  }, [left, right]);

  // 归档无时间戳（多轮回归 / 红队）⇒ 无刻度态：按序号等距排，尺子印 #n
  const timed = useMemo(() => timedEvents(left?.events, right?.events), [left, right]);

  // 哪些块展开了全文（key = `${side}:${n}`）；展开会改高度 ⇒ 重新排布
  const [openText, setOpenText] = useState<Set<string>>(() => new Set());
  const blockRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [layout, setLayout] = useState<Layout>({ tops: {}, height: PAD, scale: BASE_SCALE });

  useLayoutEffect(() => {
    const sides: ("l" | "r")[] = single ? [left ? "l" : "r"] : ["l", "r"];
    type B = { key: string; t: number; h: number };
    const cols = sides.map((s) => rounds.flatMap((r, idx) => {
      const ev = s === "l" ? r.left : r.right;
      const key = `${s}:${r.n}`;
      // 无刻度态：拿轮次下标当「时刻」，scale 仍然算但只用来撑开等距
      const t = !timed ? idx
        : (ev?.t_offset_s ?? (s === "l" ? r.right : r.left)?.t_offset_s ?? 0);
      return [{ key, t, h: blockRefs.current.get(key)?.offsetHeight ?? 0 }] as B[];
    }));
    const span = Math.max(0, ...cols.flatMap((col) => col.map((b) => b.t)));
    let scale = span > 0 ? Math.max(MIN_SCALE, Math.min(BASE_SCALE, TARGET_HEIGHT / span)) : BASE_SCALE;
    for (const col of cols) {
      col.forEach((b, i) => {
        if (i > 0 && b.t > col[i - 1].t) {
          scale = Math.max(scale, (col[i - 1].h + GAP) / (b.t - col[i - 1].t));
        }
      });
    }
    scale = Math.min(scale, MAX_SCALE);
    const tops: Record<string, number> = {};
    let bottom = 0;
    let maxT = 0;
    for (const col of cols) {
      let prev = -Infinity;
      for (const b of col) {
        const y = Math.max(b.t * scale, prev + GAP);
        tops[b.key] = y;
        prev = y + b.h;
        bottom = Math.max(bottom, prev);
        maxT = Math.max(maxT, b.t);
      }
    }
    const height = Math.max(bottom + PAD, Math.ceil(maxT) * scale + PAD);
    setLayout((cur) => {
      const same = cur.height === height && cur.scale === scale
        && Object.keys(tops).length === Object.keys(cur.tops).length
        && Object.entries(tops).every(([k, v]) => cur.tops[k] === v);
      return same ? cur : { tops, height, scale };
    });
  }, [rounds, openText, single, left, timed]);

  // 刻度：有时间戳 ⇒ 秒；无 ⇒ 每轮一格印 #n（位置 = 该轮的 top）
  const step = tickStep(layout.scale);
  const ticks: { y: number; label: string }[] = [];
  if (timed) {
    for (let t = 0; t * layout.scale <= layout.height - PAD; t += step) {
      ticks.push({ y: t * layout.scale, label: `${Number.isInteger(t) ? t : t.toFixed(1)} s` });
    }
  } else {
    for (const r of rounds) {
      const y = Math.min(layout.tops[`l:${r.n}`] ?? Infinity, layout.tops[`r:${r.n}`] ?? Infinity);
      ticks.push({ y: Number.isFinite(y) ? y + 10 : 0, label: `#${r.n}` });
    }
  }

  const toggleText = (key: string) => setOpenText((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const setRef = (key: string) => (el: HTMLDivElement | null) => {
    if (el) blockRefs.current.set(key, el); else blockRefs.current.delete(key);
  };

  const renderSide = (s: "l" | "r") => (
    <div className="pr-tl-side" data-testid={`${testid}-side-${s}`} style={{ height: layout.height }}>
      {rounds.map((r) => {
        const ev = s === "l" ? r.left : r.right;
        const key = `${s}:${r.n}`;
        const top = layout.tops[key] ?? 0;
        if (!ev) {
          // 对面有这一轮、本侧没有：虚线占位，位置跟着对面的时刻
          return (
            <div
              key={key}
              ref={setRef(key)}
              className="pr-tl-block is-ghost"
              style={{ top }}
              data-testid={`${testid}-ghost-${s}-${r.n}`}
            >
              {s === "l" ? "左 run 无此轮" : "右 run 无此轮"}
            </div>
          );
        }
        const state: BlockState = single ? "same" : r.state;
        return (
          <Block
            key={key}
            ev={ev}
            state={state}
            top={top}
            open={openText.has(key)}
            onToggle={() => toggleText(key)}
            setRef={setRef(key)}
            testid={`${testid}-block-${s}-${r.n}`}
          />
        );
      })}
    </div>
  );

  const head = (s: "l" | "r", side: SessionSide) => (
    <div className={`pr-tl-h is-side-${s === "l" ? "a" : "b"}`}>
      {s === "l" ? "左 run" : "右 run"}
      <span className="num">{side.events.length} 事件</span>
    </div>
  );

  return (
    <div className={`pr-tl${single ? " is-single" : ""}${timed ? "" : " is-untimed"}`} data-testid={testid} data-rounds={rounds.length} data-timed={timed}>
      <div className="pr-tl-colhead">
        <div />
        {left && head("l", left)}
        {!single && <div />}
        {right && head("r", right)}
      </div>
      <div className="pr-tl-body" style={{ height: layout.height }}>
        <div className="pr-tl-ruler">
          {ticks.map((t) => (
            <span key={t.label} className="pr-tl-tick" style={{ top: t.y }}>{t.label}</span>
          ))}
        </div>
        {timed && ticks.map((t) => (
          <div key={`g${t.label}`} className="pr-tl-grid" style={{ top: t.y }} aria-hidden="true" />
        ))}
        {left && renderSide("l")}
        {!single && (
          <div className="pr-tl-gut" aria-hidden="true">
            <svg viewBox={`0 0 40 ${layout.height}`} preserveAspectRatio="none" style={{ height: layout.height }}>
              {rounds.filter((r) => r.left && r.right).map((r) => {
                const y1 = (layout.tops[`l:${r.n}`] ?? 0) + 14;
                const y2 = (layout.tops[`r:${r.n}`] ?? 0) + 14;
                return (
                  <g key={r.n} className={r.state === "modified" ? "is-mod" : ""} data-testid={`${testid}-link-${r.n}`}>
                    <line x1="0" y1={y1} x2="40" y2={y2} />
                    <circle cx="0" cy={y1} r="2.5" />
                    <circle cx="40" cy={y2} r="2.5" />
                  </g>
                );
              })}
            </svg>
          </div>
        )}
        {right && renderSide("r")}
      </div>
    </div>
  );
}

/** 一轮一块：角色 · 时刻 · （差异态）· 耗时；正文 4 行截断可展开 */
function Block({ ev, state, top, open, onToggle, setRef, testid }: {
  ev: SessionEvent;
  state: BlockState;
  top: number;
  open: boolean;
  onToggle: () => void;
  setRef: (el: HTMLDivElement | null) => void;
  testid: string;
}) {
  const isTool = ev.type === "tool";
  const who = WHO[ev.type] ?? ev.type;
  // arguments / result：后端截过的字符串原样；归档原物是对象 ⇒ 压成单行 JSON
  const argText = ev.arguments == null ? "" : typeof ev.arguments === "string" ? ev.arguments : inlineJson(ev.arguments);
  const resText = ev.result == null ? "" : typeof ev.result === "string" ? ev.result : inlineJson(ev.result);
  const text = isTool
    ? [ev.name ? `${ev.name}(${argText})` : argText, ev.error ? `error: ${ev.error}` : resText ? `→ ${resText}` : ""]
      .filter(Boolean).join("\n")
    : textOf(ev.text);
  const long = text.length > 90 || text.split("\n").length > 4;
  const badge = state === "same" ? null : STATE_BADGE[state];
  return (
    <div
      ref={setRef}
      className={`pr-tl-block is-${ev.type}${state === "same" ? "" : ` is-${state}`}${ev.error ? " has-error" : ""}`}
      style={{ top }}
      data-testid={testid}
      data-state={state}
    >
      <div className="pr-tl-head">
        <span className={`badge${isTool ? " badge-mono" : ""}`}>
          {isTool && ev.name ? `${who} · ${ev.name}` : who}
        </span>
        {ev.t_offset_s != null && <span className="pr-tl-t num">{ev.t_offset_s.toFixed(2)} s</span>}
        {badge && <span className={`badge ${badge.cls}`} data-testid={`${testid}-state`}>{badge.text}</span>}
        <span className="pr-tl-meta num">
          {ev.duration_s != null && <span>耗时 <b>{ev.duration_s.toFixed(2)}s</b></span>}
        </span>
      </div>
      <div className={`pr-tl-text${open ? "" : " is-clamp"}`} data-testid={`${testid}-text`}>
        {text || EMPTY_MARK}
      </div>
      {long && (
        <button type="button" className="btn-link" onClick={onToggle} aria-expanded={open}>
          {open ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
}
