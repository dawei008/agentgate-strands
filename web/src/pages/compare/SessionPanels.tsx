// 会话对比 / 回放的四块面板（ADR-0017 D3 / F8）：run 元信息条、属性表（diff 版与
// 单栏版）、评估器表（双栏版与单栏版）、2 行可展开的理由格。SessionDiff（双栏）与
// SessionReplay（单栏）各自拼装，判据在 pairsDerive。
//
// 界面零通用散文：静态字串只有标题 / 表头 / 状态词 / 动作词。
// 玻璃纪律：全是真 <table> + 实心面，零 backdrop-filter；chip 走既有 .badge。
import { useState } from "react";
import { EMPTY_MARK } from "../../lib/renderText";
import { fmtRunTime } from "../../lib/time";
import type { AttributeDiff, SessionSide, SessionSideResult, TextDiffOp } from "../../lib/apiTypes";
import { ATTRIBUTE_KEYS, DELTA_CLASS, DELTA_WORD, deltaOf, fmtAttr, fmtDelta } from "./pairsDerive";

export type Side = "a" | "b";
export const SIDE_LABEL: Record<Side, string> = { a: "左 run", b: "右 run" };

const f3 = (n: number) => n.toFixed(3);

// ---------- run 元信息条 ----------

export function RunStrip({ side, which, testid }: { side: SessionSide; which: Side; testid: string }) {
  const a = side.attributes;
  const num = (v: number | null) => (v == null ? EMPTY_MARK : String(v));
  return (
    <div className={`pr-run is-side-${which}`} data-testid={testid}>
      <span className="pr-run-lbl">{SIDE_LABEL[which]}</span>
      <span className="pr-run-key num" title={side.run_key || undefined}>
        {side.run_index != null && <span className="pr-run-idx">#{side.run_index}</span>}
        {side.started_at ? fmtRunTime(side.started_at) : side.run_key ? side.run_key : null}
      </span>
      <span className="pr-run-m num">
        <span>in <b>{num(a["tokens.input"])}</b> · out <b>{num(a["tokens.output"])}</b></span>
        <span>耗时 <b>{a["latency.avg_s"] == null ? EMPTY_MARK : `${a["latency.avg_s"].toFixed(2)}s`}</b></span>
        <span>模型调用 <b>{num(a.llm_calls)}</b> · 工具调用 <b>{num(a.tool_calls)}</b></span>
        <span>成本 <b>{fmtAttr("cost.usd", a["cost.usd"]) ?? EMPTY_MARK}</b></span>
      </span>
    </div>
  );
}

/** 单栏时另一侧的位置：一句 chip 说明那侧没有同题（不是留白） */
export function MissingStrip({ which, testid }: { which: Side; testid: string }) {
  return (
    <div className="pr-run is-missing" data-testid={testid}>
      <span className="badge warn">{SIDE_LABEL[which]} 无同题会话</span>
    </div>
  );
}

// ---------- 属性 ----------

const CHANGE_BADGE: Record<AttributeDiff["change"], { cls: string; text: string }> = {
  added: { cls: "ok", text: "Added" },
  removed: { cls: "bad", text: "Removed" },
  modified: { cls: "warn", text: "Modified" },
};

/** text_diff → 左侧（equal + delete 划线）或右侧（equal + insert 绿底） */
function DiffText({ ops, which }: { ops: TextDiffOp[]; which: Side }) {
  return (
    <span className="pr-difftext">
      {ops.map((op, i) => {
        if (op.op === "equal") return <span key={i}>{op.text}</span>;
        if (op.op === "delete") return which === "a" ? <del key={i}>{op.text}</del> : null;
        return which === "b" ? <ins key={i}>{op.text}</ins> : null;
      })}
    </span>
  );
}

function AttrValue({ k, v, diff, which, testid }: {
  k: string; v: unknown; diff?: TextDiffOp[]; which: Side; testid: string;
}) {
  const [open, setOpen] = useState(false);
  const text = fmtAttr(k, v);
  const pre = k === "system_prompt";
  if (text == null && !diff) return <td className="pr-attr-v is-empty" data-testid={testid}>{EMPTY_MARK}</td>;
  const long = pre && (text ?? "").length > 160;
  return (
    <td className={`pr-attr-v${pre ? " is-pre" : ""}`} data-testid={testid}>
      <div className={pre && !open ? "pr-clamp3" : undefined}>
        {diff ? <DiffText ops={diff} which={which} /> : text}
      </div>
      {(long || diff) && pre && (
        <button type="button" className="btn-link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "收起" : "展开"}
        </button>
      )}
    </td>
  );
}

/** 双栏：只列有差异的属性（attribute_diff 原样，服务端已算） */
export function AttrDiffTable({ diff, total, left, right, testid }: {
  diff: AttributeDiff[];
  total: number;
  left: SessionSide;
  right: SessionSide;
  testid: string;
}) {
  return (
    <section className="pr-sec" data-testid={testid}>
      <div className="pr-sec-h">
        <h3>属性 diff</h3>
        <span className="pr-sec-r num" data-testid={`${testid}-count`}>差异 {diff.length} / {total}</span>
      </div>
      <table className="u-table pr-attr">
        <colgroup><col className="c-k" /><col /><col /><col className="c-st" /></colgroup>
        <thead>
          <tr>
            <th scope="col">属性</th>
            <th scope="col" className="is-side-a">左 run · {fmtRunTime(left.started_at) || left.run_key}</th>
            <th scope="col" className="is-side-b">右 run · {fmtRunTime(right.started_at) || right.run_key}</th>
            <th scope="col">变更</th>
          </tr>
        </thead>
        <tbody>
          {diff.length === 0 ? (
            <tr><td colSpan={4} className="pr-attr-none" data-testid={`${testid}-none`}>
              <span className="num">{total}</span> 项属性两侧相同
            </td></tr>
          ) : diff.map((d) => {
            const badge = CHANGE_BADGE[d.change];
            return (
              <tr key={d.key} className={`is-${d.change}`} data-testid={`${testid}-row-${d.key}`}>
                <td className="pr-attr-k mono">{d.key}</td>
                <AttrValue k={d.key} v={d.left} diff={d.text_diff} which="a" testid={`${testid}-row-${d.key}-left`} />
                <AttrValue k={d.key} v={d.right} diff={d.text_diff} which="b" testid={`${testid}-row-${d.key}-right`} />
                <td><span className={`badge ${badge.cls}`} data-testid={`${testid}-row-${d.key}-change`}>{badge.text}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** 单栏：八项属性全列（无 diff） */
export function AttrTable({ side, which, testid }: { side: SessionSide; which: Side; testid: string }) {
  return (
    <section className="pr-sec" data-testid={testid}>
      <div className="pr-sec-h">
        <h3>属性</h3>
        <span className="pr-sec-r num">{ATTRIBUTE_KEYS.length} 项</span>
      </div>
      <table className="u-table pr-attr is-single">
        <colgroup><col className="c-k" /><col /></colgroup>
        <thead>
          <tr>
            <th scope="col">属性</th>
            <th scope="col" className={`is-side-${which}`}>
              {SIDE_LABEL[which]}{side.started_at ? ` · ${fmtRunTime(side.started_at)}` : ""}
            </th>
          </tr>
        </thead>
        <tbody>
          {ATTRIBUTE_KEYS.map((k) => (
            <tr key={k} data-testid={`${testid}-row-${k}`}>
              <td className="pr-attr-k mono">{k}</td>
              <AttrValue k={k} v={side.attributes[k]} which={which} testid={`${testid}-row-${k}-v`} />
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---------- 评估器 ----------

function ScoreCell({ r, testid }: { r: SessionSideResult | null; testid: string }) {
  if (!r || r.score == null) return <div className="pr-sc" data-testid={testid}><span className="pr-sc-num num is-na">{EMPTY_MARK}</span></div>;
  const tone = r.passed === true ? "ok" : r.passed === false ? "warn" : "";
  return (
    <div className="pr-sc" data-testid={testid}>
      <span className={`pr-sc-num num${r.passed === false ? " is-fail" : ""}`}>{f3(r.score)}</span>
      {r.label && <span className={`badge ${tone}`} data-testid={`${testid}-label`}>{r.label}</span>}
    </div>
  );
}

/** judge 理由：默认 2 行，点开全文 */
function Reason({ text, testid }: { text: string | null; testid: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return <div className="pr-reason is-na" data-testid={testid}>{EMPTY_MARK}</div>;
  return (
    <div className="pr-reason" data-testid={testid}>
      <div className={open ? undefined : "pr-clamp2"}>{text}</div>
      <button type="button" className="btn-link" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "收起" : "展开"}
      </button>
    </div>
  );
}

function evaluatorNames(...sides: SessionSide[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sides) for (const k of Object.keys(s.results)) if (!seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}

const passCount = (s: SessionSide) => Object.values(s.results).filter((r) => r.passed === true).length;

/** 双栏：每评估器一行，左分+标签 · 右分+标签 · Δ · 理由左 · 理由右 */
export function EvalDiffTable({ left, right, testid }: { left: SessionSide; right: SessionSide; testid: string }) {
  const names = evaluatorNames(left, right);
  return (
    <section className="pr-sec" data-testid={testid}>
      <div className="pr-sec-h">
        <h3>评估器</h3>
        <span className="pr-sec-r num">左过 {passCount(left)}/{names.length} · 右过 {passCount(right)}/{names.length}</span>
      </div>
      <table className="u-table pr-ev">
        <colgroup>
          <col className="c-n" /><col className="c-s" /><col className="c-s" /><col className="c-d" /><col /><col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">评估器</th>
            <th scope="col" className="is-side-a">左 run 分 · 判定</th>
            <th scope="col" className="is-side-b">右 run 分 · 判定</th>
            <th scope="col" className="r">Δ</th>
            <th scope="col">理由 · 左</th>
            <th scope="col">理由 · 右</th>
          </tr>
        </thead>
        <tbody>
          {names.map((n) => {
            const l = left.results[n] ?? null;
            const r = right.results[n] ?? null;
            const d = deltaOf(l?.score, r?.score);
            return (
              <tr key={n} data-testid={`${testid}-row-${n}`}>
                <td className="pr-ev-n mono">{n}</td>
                <td><ScoreCell r={l} testid={`${testid}-row-${n}-left`} /></td>
                <td><ScoreCell r={r} testid={`${testid}-row-${n}-right`} /></td>
                <td className={`pr-delta num r${d ? ` ${DELTA_CLASS[d.dir]}` : ""}`} data-testid={`${testid}-row-${n}-delta`} title={d ? DELTA_WORD[d.dir] : undefined}>
                  {d ? fmtDelta(d) : EMPTY_MARK}
                </td>
                <td><Reason text={l?.reason ?? null} testid={`${testid}-row-${n}-reason-left`} /></td>
                <td><Reason text={r?.reason ?? null} testid={`${testid}-row-${n}-reason-right`} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** 单栏：该侧评估器分 · 判定 · 理由 */
export function EvalTable({ side, which, testid }: { side: SessionSide; which: Side; testid: string }) {
  const names = evaluatorNames(side);
  return (
    <section className="pr-sec" data-testid={testid}>
      <div className="pr-sec-h">
        <h3>评估器</h3>
        <span className="pr-sec-r num">过 {passCount(side)}/{names.length}</span>
      </div>
      <table className="u-table pr-ev is-single">
        <colgroup><col className="c-n" /><col className="c-s" /><col /></colgroup>
        <thead>
          <tr>
            <th scope="col">评估器</th>
            <th scope="col" className={`is-side-${which}`}>{SIDE_LABEL[which]} 分 · 判定</th>
            <th scope="col">理由</th>
          </tr>
        </thead>
        <tbody>
          {names.length === 0 ? (
            <tr><td colSpan={3} className="pr-attr-none" data-testid={`${testid}-none`}>0 个评估器</td></tr>
          ) : names.map((n) => (
            <tr key={n} data-testid={`${testid}-row-${n}`}>
              <td className="pr-ev-n mono">{n}</td>
              <td><ScoreCell r={side.results[n] ?? null} testid={`${testid}-row-${n}-score`} /></td>
              <td><Reason text={side.results[n]?.reason ?? null} testid={`${testid}-row-${n}-reason`} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
