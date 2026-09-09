// 评估分析页「同题配对」tab（ADR-0017 D3，用户选变体 B「表 + 页内展开」）。
//
// 配对表 = 真 <table>：题面摘录 · 每个评估器一组（左 · 右 · Δ）· 对齐状态；已对齐在前
// （后端 pair_rows 就是这个序），未对齐行灰显沉底。点行**原位展开**（允许多行同时开）：
//   · 已对齐 ⇒ compare_sessions → 双栏 diff（SessionDiff）
//   · 未对齐 ⇒ 单栏回放（SessionReplay，F8）：料取缓存里那一侧的 get_plan_run 归档
//     （queryKey ["plan_run", key] 与 CompareView 同键 ⇒ 不多打一次接口），另一侧位置
//     放「X run 无同题会话」chip。
// 「谁在左」沿用页面的 orderComparePair：pair.aKey（较早）恒左 = 上一次。
//
// 「在新页打开」（ADR-0013 兜底）本批**未做**：router 不在白名单且现无 `#/analysis/...` 子路由
// （parseHash 认不出会落首页）。
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiOne, type ApiEvent } from "../../lib/api";
import { EMPTY_MARK } from "../../lib/renderText";
import type { RowPair, RowPairsEvent, SessionCompareEvent } from "../../lib/apiTypes";
import type { PlanRunDetail } from "../plan/types";
import type { ComparePair } from "../plan/compare/CompareView";
import {
  ALIGN_LABEL, DELTA_CLASS, DELTA_WORD, alignStateOf, deltaOf, fmtDelta, pairEvaluators, pairScore,
  sessionSideFromArchive,
} from "./pairsDerive";
import SessionDiff from "./SessionDiff";
import SessionReplay from "./SessionReplay";
import "./pairs.css";

const f3 = (n: number) => n.toFixed(3);

/** pair_rows：tab 上的计数与表体共用这一份（ComparePage 调，结果传下来） */
export function usePairRows(pair: ComparePair | null) {
  return useQuery({
    queryKey: ["row_pairs", pair?.aKey ?? "", pair?.bKey ?? ""],
    enabled: pair != null,
    queryFn: () => apiOne<RowPairsEvent>(
      { action: "pair_rows", left_run_key: pair!.aKey, right_run_key: pair!.bKey }, "row_pairs"),
  });
}

export default function PairsCard({ pair, rows, loading, error }: {
  pair: ComparePair;
  rows: RowPairsEvent | undefined;
  loading: boolean;
  error: string | null;
}) {
  // 展开的行（key = 行下标，允许多行同时开）
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const toggle = (i: number) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  const pairs = rows?.pairs ?? [];
  const evals = pairEvaluators(pairs);
  const cols = 2 + evals.length * 3;

  return (
    <div className="card pr-card" data-testid="pairs-card">
      <div className="card-head">
        <span className="card-title">同题配对</span>
        {rows && <span className="card-sub" data-testid="pairs-sub">{rows.total} 行</span>}
      </div>
      {error ? (
        <p className="pr-error" data-testid="pairs-error">{error}</p>
      ) : loading || !rows ? (
        <div className="pr-sk" aria-hidden="true" data-testid="pairs-skeleton">
          {[0, 1, 2].map((i) => <div key={i} className="pr-sk-row" />)}
        </div>
      ) : pairs.length === 0 ? (
        <div className="u-empty" data-testid="pairs-empty"><p>两次运行没有可配对的行</p></div>
      ) : (
        <table className="u-table pr-table" data-testid="pairs-table">
          <colgroup>
            <col className="c-q" />
            {evals.map((e) => (
              <React.Fragment key={e}><col className="c-s" /><col className="c-s" /><col className="c-s" /></React.Fragment>
            ))}
            <col className="c-al" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" rowSpan={2}>题面</th>
              {evals.map((e) => (
                <th key={e} scope="colgroup" colSpan={3} className="pr-th-ev mono">{e}</th>
              ))}
              <th scope="col" rowSpan={2} className="pr-th-al" data-testid="pairs-aligned">
                对齐 <span className="num">{rows.aligned} / {rows.total}</span>
              </th>
            </tr>
            <tr>
              {evals.map((e) => (
                <React.Fragment key={e}>
                  <th scope="col" className="r pr-th-side is-side-a">左</th>
                  <th scope="col" className="r pr-th-side is-side-b">右</th>
                  <th scope="col" className="r pr-th-side">Δ</th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {pairs.map((p, i) => (
              <PairRow
                key={`${p.align_key}|${p.left_row_key ?? ""}|${p.right_row_key ?? ""}`}
                p={p}
                i={i}
                evals={evals}
                cols={cols}
                open={open.has(i)}
                onToggle={() => toggle(i)}
                pair={pair}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PairRow({ p, i, evals, cols, open, onToggle, pair }: {
  p: RowPair;
  i: number;
  evals: string[];
  cols: number;
  open: boolean;
  onToggle: () => void;
  pair: ComparePair;
}) {
  const state = alignStateOf(p);
  const unaligned = state !== "aligned";
  const id = `pair-row-${i + 1}`;
  const onKey = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
  };
  return (
    <>
      <tr
        className={`pr-row${unaligned ? " is-unaligned" : ""}${open ? " is-open" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-testid={id}
        data-align-key={p.align_key}
        data-align={state}
        onClick={onToggle}
        onKeyDown={onKey}
      >
        <td className="pr-q">
          <span className="pr-q-n num">{i + 1}</span>
          <span className="pr-q-txt cjk" title={p.align_key}>{p.align_key || EMPTY_MARK}</span>
          <i className="pr-caret" aria-hidden="true" />
        </td>
        {evals.map((e) => {
          const l = pairScore(p.left_results, e);
          const r = pairScore(p.right_results, e);
          const d = deltaOf(l?.score, r?.score);
          const sc = (x: typeof l, side: "a" | "b") => (
            <td
              className={`pr-sc-cell num r${x?.passed === false ? " is-fail" : ""}${x ? "" : " is-na"}`}
              data-testid={`${id}-${e}-${side === "a" ? "left" : "right"}`}
            >
              {x && x.score != null ? f3(x.score) : EMPTY_MARK}
            </td>
          );
          return (
            <React.Fragment key={e}>
              {sc(l, "a")}
              {sc(r, "b")}
              <td
                className={`pr-delta num r${d ? ` ${DELTA_CLASS[d.dir]}` : ""}`}
                data-testid={`${id}-${e}-delta`}
                data-dir={d?.dir ?? ""}
                title={d ? DELTA_WORD[d.dir] : undefined}
              >
                {d ? fmtDelta(d) : EMPTY_MARK}
              </td>
            </React.Fragment>
          );
        })}
        <td className="pr-al">
          <span className={`badge${unaligned ? " warn" : ""}`} data-testid={`${id}-align`}>{ALIGN_LABEL[state]}</span>
        </td>
      </tr>
      {open && (
        <tr className="pr-xrow" data-testid={`${id}-expand`}>
          <td colSpan={cols}>
            <div className="pr-xwell">
              {unaligned
                ? <UnalignedExpand p={p} pair={pair} testid={`${id}-replay`} />
                : <AlignedExpand p={p} pair={pair} testid={`${id}-diff`} />}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** 已对齐：compare_sessions → 双栏 */
function AlignedExpand({ p, pair, testid }: { p: RowPair; pair: ComparePair; testid: string }) {
  const q = useQuery({
    queryKey: ["session_compare", pair.aKey, p.left_row_key, pair.bKey, p.right_row_key],
    queryFn: () => apiOne<SessionCompareEvent>({
      action: "compare_sessions",
      left: { run_key: pair.aKey, row_key: p.left_row_key },
      right: { run_key: pair.bKey, row_key: p.right_row_key },
    }, "session_compare"),
  });
  if (q.isError) return <p className="pr-error" data-testid={`${testid}-error`}>{errText(q.error)}</p>;
  if (!q.data) return <div className="pr-sk" aria-hidden="true" data-testid={`${testid}-skeleton`}><div className="pr-sk-row" /><div className="pr-sk-row" /></div>;
  return <SessionDiff data={q.data} testid={testid} />;
}

/** 未对齐：有同题的那一侧从归档投影出单栏回放 */
function UnalignedExpand({ p, pair, testid }: { p: RowPair; pair: ComparePair; testid: string }) {
  const which: "a" | "b" = p.left_row_key != null ? "a" : "b";
  const runKey = which === "a" ? pair.aKey : pair.bKey;
  const rowKey = (which === "a" ? p.left_row_key : p.right_row_key) ?? "";
  const q = useQuery({
    queryKey: ["plan_run", runKey],
    queryFn: () => apiOne<PlanRunDetail & ApiEvent>({ action: "get_plan_run", run_key: runKey }, "plan_run"),
  });
  if (q.isError) return <p className="pr-error" data-testid={`${testid}-error`}>{errText(q.error)}</p>;
  if (!q.data) return <div className="pr-sk" aria-hidden="true" data-testid={`${testid}-skeleton`}><div className="pr-sk-row" /></div>;
  const side = sessionSideFromArchive(q.data, rowKey);
  if (!side) {
    return <p className="pr-error" data-testid={`${testid}-missing-row`}>归档里没有 <span className="mono">{rowKey}</span></p>;
  }
  return <SessionReplay side={side} which={which} missing={which === "a" ? "b" : "a"} testid={testid} />;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// React.Fragment 在 colgroup / thead 里按 key 分组用；显式引入避免自动运行时下的裸 React 引用
import React from "react";
