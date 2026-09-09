// ⑥ 行 × 评估器 矩阵（一个环节一张卡，真 <table>）。
//
//   observe：行 = 会话（#序号 · 用户输入摘录 · 会话短 id · tokens · 模型调用数），
//            列 = 评估器（表头带该评估器均分），末列 P95（轮次最大时延）；
//   dataset：行 = 用例（#序号 · 题面摘录 · 用例名 · 分类·Agent），列 = 评估器；
//   redteam：无评估器列 —— 行 = 攻击，列 = 策略 · 严重度 · 结果（攻破/守住/无有效结论，
//            口径同 ReportView.RowLine：`breached = (not passed) and not errored`）。
//
// 格 = 分 + 判定标签（judge 原话英文）+ 通过/未过色点；**点格**在该行下方展开「格详情」：
// 评估器名 · 分 · 标签 · reason 全文（默认 2 行 + 展开）· 右侧该行的原文（会话 = 用户输入 /
// 最终回复；用例 = 输入 / 期望 / 实际）。同一时刻整页只开一格（开关态由页面持有）。
//
// 行锚点 id = reportRows.matrixRowAnchor（问题条目证据 / tile 最差行 / 最大时延会话都跳这里）。
import { useState } from "react";
import { EMPTY_MARK } from "../../lib/renderText";
import type { CaseAnnotation, ScoredFrom } from "../../lib/apiTypes";
import type { CaseVerdict } from "../plan/derive";
import { matrixRowAnchor, shortSessionId, type ReportRow } from "../plan/reportRows";
import { effectiveOutcome, f2s, f3, matrixRows, scoredTitle, traceTitle, type StageView, type TraceMark } from "./model";
import { annotKey, fmtAnnotAt, fmtHuman, isBadVerdict } from "./badcase";
// 会话回放（ADR-0017 F8）：单栏时间线组件与评估分析页同题配对共用一份（pages/compare 导出）
import SessionReplay from "../compare/SessionReplay";
import { sessionSideFromStage } from "../compare/pairsDerive";

/** 攻破三态（true / false / null）→ 色点 class · 状态 class · 词，一处映射。
 *  口径同 ReportView.RowLine：`breached = (not passed) and not errored`；
 *  null = 一条有效判定都没剩（不入分母），色点留空。 */
function breachView(b: boolean | null | undefined): { dot: string; state: string; text: string } {
  if (b === true) return { dot: "bad", state: "fail", text: "攻破" };
  if (b === false) return { dot: "good", state: "pass", text: "守住" };
  return { dot: "", state: "none", text: "无有效结论" };
}

/** 坏例入集 / 人工标注（ADR-0017 D1/D2）在矩阵上的两个投影 + 入口回调。
 *  可选：老调用方 / 旧夹具不带它们时矩阵形态不变（零入口、零胶囊）。 */
export interface IntakeProps {
  /** 人工标注索引（annotKey(行名, 评估器|overall)）；机器分不动，人工分并列小胶囊 */
  annotations?: Map<string, CaseAnnotation>;
  /** 已入集的行名（本会话内 + 数据集 source 反查的并集）；只在未过格上打「已入集」 */
  added?: Set<string>;
  /** 打开抽屉：行 + 列（红队恒 "result"）+ 先滚到哪一段 */
  onIntake?: (row: ReportRow, col: string, focus: "dataset" | "annotate") => void;
}

/** 页面持有的「哪一格开着」：环节下标 + 行 key + 列（评估器名；红队恒 "result"） */
export interface OpenCell {
  gi: number;
  rowKey: string;
  col: string;
}

export default function StageMatrix({ view, open, onToggle, target, showStage, annotations, added, onIntake }: {
  view: StageView;
  open: OpenCell | null;
  onToggle: (cell: OpenCell) => void;
  /** 当前高亮的行锚点 id（深链落点） */
  target: string | null;
  showStage: boolean;
} & IntakeProps) {
  const { group, unit } = view;
  const gi = group.index;
  const names = view.tiles.map((t) => t.name);
  const isObserve = group.type === "observe";
  const isRedteam = group.type === "redteam";
  const cols = isRedteam ? 3 : names.length + 1 + (isObserve ? 1 : 0);
  const rows = matrixRows(group);
  const cells = rows.length * names.length;

  return (
    <section className="card rpg-mx-card" data-testid={`report-matrix-${gi}`} aria-label={`${view.label} 矩阵`}>
      <div className="card-head">
        <span className="card-title">
          {showStage ? view.label : isRedteam ? "攻击 × 结果" : `${unit} × 评估器`}
        </span>
        <span className="card-sub" data-testid={`report-matrix-${gi}-sub`}>
          {showStage && !isRedteam && `${unit} × 评估器 · `}
          {rows.length} 个{unit}
          {!isRedteam && ` · ${names.length} 个评估器 · ${cells} 格`}
        </span>
        <span className="spacer" />
        {!isRedteam ? (
          <span className="rpg-legend">
            <span><span className="dot good" /> 判定通过</span>
            <span><span className="dot warn" /> 判定未过</span>
          </span>
        ) : (
          <span className="rpg-legend">
            <span><span className="dot bad" /> 攻破</span>
            <span><span className="dot good" /> 守住</span>
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="rpg-mx-empty" data-testid={`report-matrix-${gi}-empty`}>
          {group.stage.error ? String(group.stage.error) : `这一环节没有${unit}明细`}
        </p>
      ) : (
        <table className={`u-table fixed rpg-mx${isRedteam ? " is-redteam" : ""}`} data-testid={`report-matrix-${gi}-table`}>
          <colgroup>
            {isRedteam ? (
              <><col className="c-name" /><col className="c-strat" /><col className="c-result" /></>
            ) : (
              <>
                <col className="c-name" />
                {names.map((n) => <col key={n} className="c-ev" />)}
                {isObserve && <col className="c-lat" />}
              </>
            )}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">{unit}</th>
              {isRedteam ? (
                <>
                  <th scope="col">策略 · 严重度</th>
                  <th scope="col">结果</th>
                </>
              ) : (
                <>
                  {view.tiles.map((t) => (
                    <th
                      key={t.name}
                      scope="col"
                      className={`rpg-th-ev${t.under ? " is-under" : ""}`}
                      data-testid={`report-matrix-${gi}-th-${t.name}`}
                    >
                      <span className="mono">{t.name}</span>
                      <span className="m mono" title="该评估器均分">{t.mean == null ? EMPTY_MARK : f3(t.mean)}</span>
                    </th>
                  ))}
                  {isObserve && <th scope="col" className="r lat" title="轮次最大时延">P95</th>}
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, n) => {
              const anchor = matrixRowAnchor(gi, row.name);
              const openHere = open && open.gi === gi && open.rowKey === row.key ? open : null;
              return (
                <RowPair
                  key={row.key}
                  row={row}
                  n={n}
                  gi={gi}
                  names={names}
                  view={view}
                  anchor={anchor}
                  targeted={target === anchor}
                  openCol={openHere?.col ?? null}
                  onToggle={(col) => onToggle({ gi, rowKey: row.key, col })}
                  cols={cols}
                  trace={view.traces.get(row.key) ?? null}
                  annotations={annotations}
                  added={added}
                  onIntake={onIntake}
                />
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RowPair({ row, n, gi, names, view, anchor, targeted, openCol, onToggle, cols, trace = null, annotations, added, onIntake }: {
  row: ReportRow;
  n: number;
  gi: number;
  names: string[];
  view: StageView;
  anchor: string;
  targeted: boolean;
  openCol: string | null;
  onToggle: (col: string) => void;
  cols: number;
  /** 只用上报数据评估（ADR-0019 批 1）：这一行的 trace 标记；老 run / 关着开关 → null */
  trace?: TraceMark | null;
} & IntakeProps) {
  const id = `report-row-${gi}-${n}`;
  const isRedteam = view.group.type === "redteam";
  const isObserve = view.group.type === "observe";
  // no_trace 行：格里不显示分（显示「无 trace」），行态归「没跑成」
  const noTrace = trace?.status === "no_trace";
  const outcome = effectiveOutcome(row, trace);
  const headline = isObserve ? (row.prompt || row.name) : isRedteam ? row.name : (row.input || row.name);
  const openVerdict = openCol && openCol !== "result" ? row.verdicts.find((v) => v.name === openCol) ?? null : null;
  const isAdded = added?.has(row.name) ?? false;
  const overall = annotations?.get(annotKey(row.name, "overall")) ?? null;
  // 入口口径（ADR D1）：observe 行 = 判未过且非 errored 的格；redteam 行 = 攻破；dataset 行没有
  const intakeFor = (col: string): (() => void) | null => {
    if (!onIntake) return null;
    if (isObserve) {
      const v = row.verdicts.find((x) => x.name === col);
      return isBadVerdict(v) ? () => onIntake(row, col, "dataset") : null;
    }
    if (isRedteam) return row.breached === true ? () => onIntake(row, "result", "dataset") : null;
    return null;
  };
  const annotateFor = (col: string): (() => void) | null => {
    const f = intakeFor(col);
    return f && onIntake ? () => onIntake(row, isRedteam ? "result" : col, "annotate") : null;
  };
  return (
    <>
      <tr
        id={anchor}
        className={`rpg-row is-${outcome}${targeted ? " is-target" : ""}${openCol ? " is-open" : ""}`}
        data-testid={id}
        data-row={row.name}
        data-trace={trace?.status ?? undefined}
      >
        <td className="rpg-name">
          <div className="rpg-name-line">
            <span className="rpg-no mono">#{n + 1}</span>
            <span className="rpg-headline" title={headline}>{headline}</span>
          </div>
          <div className="rpg-name-sub mono" data-testid={`${id}-sub`}>
            {isObserve ? shortSessionId(row.name) : isRedteam ? "" : row.name}
            {isObserve && row.metrics?.tokens != null && <> · {row.metrics.tokens} tokens</>}
            {isObserve && row.metrics?.llmCalls != null && <> · {row.metrics.llmCalls} 次模型调用</>}
            {!isObserve && row.sub && <span className="rpg-name-cat"> {row.sub}</span>}
            {row.note && (
              <span className="badge rpg-note" title={row.note.text || row.note.mark} data-testid={`${id}-note`}>
                {row.note.mark}
              </span>
            )}
            {noTrace && trace && (
              <span className="badge rpg-trace" title={traceTitle(trace)} data-testid={`${id}-trace`}>
                无 trace
              </span>
            )}
            {overall && <HumanPill a={overall} testid={`${id}-human`} />}
          </div>
        </td>
        {isRedteam ? (
          <>
            <td className="rpg-strat">{row.sub || EMPTY_MARK}</td>
            <td className="rpg-cell-td">
              <button
                type="button"
                className={`rpg-cell${noTrace ? " is-trace" : ""}`}
                aria-expanded={openCol === "result"}
                data-testid={`report-cell-${gi}-${n}-result`}
                // 只用上报数据评估：no_trace 行说原因（批 1），按 trace 判过分的行说出身（批 3，
                // 与回归格同一句 model.scoredTitle）；两者都没有就不写 title
                title={(noTrace && trace ? traceTitle(trace) : scoredTitle(trace)) || undefined}
                data-scored={trace?.scoredFrom ?? undefined}
                onClick={() => onToggle("result")}
              >
                <span className="rpg-cell-score">
                  {noTrace ? (
                    <>
                      <span className="dot" />
                      <span className="rpg-breach is-none">无 trace</span>
                    </>
                  ) : (
                    <>
                      <span className={`dot ${breachView(row.breached).dot}`} />
                      <span className={`rpg-breach is-${breachView(row.breached).state}`}>
                        {breachView(row.breached).text}
                      </span>
                    </>
                  )}
                </span>
                {row.sessionIds.length > 0 && (
                  <span className="rpg-cell-label" title={row.sessionIds.join("\n")}>
                    {row.sessionIds.length} 个会话
                  </span>
                )}
                {isAdded && row.breached === true && <AddedMark testid={`report-cell-${gi}-${n}-result-added`} />}
              </button>
            </td>
          </>
        ) : (
          <>
            {names.map((ev) => {
              const v = row.verdicts.find((x) => x.name === ev);
              return (
                <td key={ev} className="rpg-cell-td">
                  {noTrace && trace ? (
                    <span
                      className="rpg-cell is-trace"
                      title={traceTitle(trace)}
                      data-testid={`report-cell-${gi}-${n}-${ev}`}
                      data-trace={trace.reason ?? "no_trace"}
                    >
                      <span className="rpg-cell-score"><span className="dot" />无 trace</span>
                    </span>
                  ) : (
                    <Cell
                      v={v ?? null}
                      open={openCol === ev}
                      testid={`report-cell-${gi}-${n}-${ev}`}
                      onToggle={() => onToggle(ev)}
                      human={annotations?.get(annotKey(row.name, ev)) ?? null}
                      added={isAdded && isObserve}
                      title={scoredTitle(trace)}
                      scoredFrom={trace?.scoredFrom ?? null}
                    />
                  )}
                </td>
              );
            })}
            {isObserve && (
              <td className="r mono rpg-lat" data-testid={`${id}-lat`}>
                {row.metrics?.latencyMax != null ? f2s(row.metrics.latencyMax) : EMPTY_MARK}
              </td>
            )}
          </>
        )}
      </tr>
      {openCol && (
        <tr className="rpg-detail" data-testid={`report-cell-${gi}-${n}-${openCol}-detail`}>
          <td colSpan={cols}>
            {isRedteam ? (
              <RedteamDetail
                row={row}
                n={n}
                mark={trace}
                testid={`report-cell-${gi}-${n}-result-detail`}
                onIntake={intakeFor("result")}
                onAnnotate={annotateFor("result")}
              />
            ) : (
              <CellDetail
                row={row}
                n={n}
                v={openVerdict}
                ev={openCol}
                view={view}
                testid={`report-cell-${gi}-${n}-${openCol}-detail`}
                onIntake={intakeFor(openCol)}
                onAnnotate={annotateFor(openCol)}
              />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/** 人工分小胶囊（ADR D2：与机器分并列、形态可辨 —— 「人工」字样 + 数字） */
function HumanPill({ a, testid }: { a: CaseAnnotation; testid: string }) {
  return (
    <span className="rpg-human" title={`人工分 · ${fmtAnnotAt(a.at)}${a.comment ? ` · ${a.comment}` : ""}`} data-testid={testid}>
      <span className="k">人工</span><span className="mono">{fmtHuman(a.human_score)}</span>
    </span>
  );
}

/** 「已入集」小标记（只打在未过格上） */
function AddedMark({ testid }: { testid: string }) {
  return <span className="rpg-added" data-testid={testid}>已入集</span>;
}

/** 一格：分 + 判定标签 + 色点。errored = 中性「评估失败」（不是 0）；没这个评估器的判定 = 「—」。
 *  人工分与「已入集」作第三行小标（机器分那一行原样不动）。 */
function Cell({ v, open, testid, onToggle, human = null, added = false, title = "", scoredFrom = null }: {
  v: CaseVerdict | null;
  open: boolean;
  testid: string;
  onToggle: () => void;
  human?: CaseAnnotation | null;
  added?: boolean;
  /** 只用上报数据评估（ADR-0019 批 2）：按 trace 评分的格 title（model.scoredTitle）；"" = 不写 */
  title?: string;
  /** 行上的评分出身（data-scored；老 run / 关着开关 → 不出属性） */
  scoredFrom?: ScoredFrom | null;
}) {
  if (!v) return <span className="rpg-cell-empty" data-testid={testid}>{EMPTY_MARK}</span>;
  const tone = v.errored ? "none" : v.passed === true ? "good" : v.passed === false ? "warn" : "none";
  const showAdded = added && isBadVerdict(v);
  return (
    <button
      type="button"
      className={`rpg-cell is-${tone}`}
      aria-expanded={open}
      data-testid={testid}
      data-score={v.score ?? ""}
      data-scored={scoredFrom ?? undefined}
      title={title || undefined}
      onClick={onToggle}
    >
      <span className="rpg-cell-score mono">
        <span className={`dot ${tone === "none" ? "" : tone}`} />
        {v.errored ? "评估失败" : v.score == null ? EMPTY_MARK : f3(v.score)}
      </span>
      {v.label && <span className="rpg-cell-label" data-testid={`${testid}-label`}>{v.label}</span>}
      {(human || showAdded) && (
        <span className="rpg-cell-tags">
          {human && <HumanPill a={human} testid={`${testid}-human`} />}
          {showAdded && <AddedMark testid={`${testid}-added`} />}
        </span>
      )}
    </button>
  );
}

/** 格详情里的两个入口（同一个抽屉，落点不同）；只在有入口的格上渲染 */
function IntakeButtons({ onIntake, onAnnotate, testid }: {
  onIntake: (() => void) | null;
  onAnnotate: (() => void) | null;
  testid: string;
}) {
  if (!onIntake) return null;
  return (
    <span className="rpg-intake">
      <button type="button" className="btn mini" data-testid={`${testid}-intake`} onClick={onIntake}>加入数据集</button>
      {onAnnotate && (
        <button type="button" className="btn ghost mini" data-testid={`${testid}-annotate`} onClick={onAnnotate}>标注</button>
      )}
    </span>
  );
}

/** 格详情：评估器名 · 分 · 标签 · reason（默认 2 行）· 右侧原文对照 */
function CellDetail({ row, n, v, ev, view, testid, onIntake = null, onAnnotate = null }: {
  row: ReportRow;
  n: number;
  v: CaseVerdict | null;
  ev: string;
  view: StageView;
  testid: string;
  onIntake?: (() => void) | null;
  onAnnotate?: (() => void) | null;
}) {
  const isObserve = view.group.type === "observe";
  const tone = !v || v.errored ? "" : v.passed === true ? " ok" : v.passed === false ? " warn" : "";
  // 只用上报数据评估：这一行的 trace 标记（批 2 起带评分出身）；老 run / 关着开关 → null
  const mark = view.traces.get(row.key) ?? null;
  // 「回放」（ADR-0017 F8）：这一行在 S3 明细环节里有会话 / 用例原物才给入口（没有就不画死按钮）
  const [replay, setReplay] = useState(false);
  const replaySide = sessionSideFromStage(view.group.detail, row.name);
  return (
    <>
    <div className="rpg-detail-grid">
      <div className="rpg-reason">
        <div className="rpg-detail-head">
          <span className="rpg-ev mono">{ev}</span>
          <span className="sc mono">{!v || v.errored || v.score == null ? EMPTY_MARK : f3(v.score)}</span>
          {v?.errored && <span className="badge">评估失败</span>}
          {v?.label && <span className={`badge${tone}`} data-testid={`${testid}-label`}>{v.label}</span>}
          <span className="who">
            {view.unit} #{n + 1} · <span className="rpg-sid mono" title={row.name}>{isObserve ? shortSessionId(row.name) : row.name}</span>
          </span>
          <IntakeButtons onIntake={onIntake} onAnnotate={onAnnotate} testid={testid} />
          {replaySide && (
            <button type="button" className="btn ghost mini" data-testid={`${testid}-replay`} aria-pressed={replay} onClick={() => setReplay(!replay)}>回放</button>
          )}
        </div>
        <Clamp text={v?.reason ?? ""} lines={2} testid={`${testid}-reason`} emptyText="judge 没有给出理由" />
      </div>
      <div className="rpg-excerpt">
        {isObserve ? (
          <>
            <Excerpt k="用户输入" text={row.prompt ?? ""} testid={`${testid}-prompt`} />
            <Excerpt k="最终回复" text={row.reply ?? row.output} testid={`${testid}-reply`} />
          </>
        ) : (
          <>
            <Excerpt k="输入" text={row.input} testid={`${testid}-input`} />
            {row.expected && <Excerpt k="期望输出" text={row.expected} testid={`${testid}-expected`} />}
            {/* 只用上报数据评估（批 2）：按 trace 判过分的行，实际输出就是 trace 还原的最终回复；
                返回与它不一致时把原返回并排给出（一致时不重复一遍同样的话） */}
            <Excerpt
              k={mark?.scoredFrom === "trace" ? "实际输出（trace）" : "实际输出"}
              text={row.output}
              testid={`${testid}-output`}
            />
            {mark?.scoredFrom === "trace" && mark.responseMatches === false && (
              <Excerpt k="返回（与 trace 不一致）" text={mark.outputResponse} testid={`${testid}-output-response`} />
            )}
          </>
        )}
      </div>
    </div>
    {replay && replaySide && <SessionReplay side={replaySide} testid={`${testid}-replay-panel`} />}
    </>
  );
}

/** 红队行详情：判定原话 + 攻击对话全文 + 落到的 target 会话 */
function RedteamDetail({ row, n, mark = null, testid, onIntake = null, onAnnotate = null }: {
  row: ReportRow;
  n: number;
  /** 只用上报数据评估（ADR-0019 批 3）：这一行的 trace 标记；老 run / 关着开关 → null */
  mark?: TraceMark | null;
  testid: string;
  onIntake?: (() => void) | null;
  onAnnotate?: (() => void) | null;
}) {
  const scoredFromTrace = mark?.scoredFrom === "trace";
  return (
    <div className="rpg-detail-grid">
      <div className="rpg-reason">
        <div className="rpg-detail-head">
          <span className={`rpg-breach is-${breachView(row.breached).state}`}>
            {breachView(row.breached).text}
          </span>
          <span className="who">攻击 #{n + 1} · <span className="rpg-sid" title={row.name}>{row.name}</span></span>
          <IntakeButtons onIntake={onIntake} onAnnotate={onAnnotate} testid={testid} />
        </div>
        <Clamp text={row.reason || row.note?.text || ""} lines={2} testid={`${testid}-reason`} emptyText="judge 没有给出理由" />
        {row.sessionIds.length > 0 && (
          <div className="rpg-sids mono" data-testid={`${testid}-sessions`}>
            {row.sessionIds.map((s) => <span key={s} className="chip">{s}</span>)}
          </div>
        )}
      </div>
      <div className="rpg-excerpt">
        {row.input && <Excerpt k="攻击目的" text={row.input} testid={`${testid}-objective`} />}
        {/* 只用上报数据评估（批 3）：按 trace 判过分的行，攻击对话就是 span 还原的那一份
            （judge 看的正是它）；返回与它不一致时把驾驭那份并排给出（一致时不重复） */}
        <Excerpt
          k={scoredFromTrace ? "攻击对话（trace）" : "攻击对话"}
          text={row.conversation}
          testid={`${testid}-conversation`}
        />
        {scoredFromTrace && mark.responseMatches === false && (
          <Excerpt k="返回（与 trace 不一致）" text={mark.responseConversation}
                   testid={`${testid}-conversation-response`} />
        )}
      </div>
    </div>
  );
}

function Excerpt({ k, text, testid }: { k: string; text: string; testid: string }) {
  return (
    <div>
      <div className="k">{k}</div>
      <Clamp text={text} lines={4} testid={testid} emptyText={EMPTY_MARK} />
    </div>
  );
}

/** 长文默认 N 行 + 「展开/收起」。jsdom 量不出溢出，展开钮按字数 / 换行数给
 *  （超过 N 行 × 40 字或自带换行才给钮；短文本没有钮，免得钮比字多）。 */
export function Clamp({ text, lines, testid, emptyText }: {
  text: string;
  lines: number;
  testid: string;
  emptyText: string;
}) {
  const [openState, setOpen] = useState(false);
  const t = text.trim();
  if (!t) return <div className="rpg-clamp is-empty" data-testid={testid}>{emptyText}</div>;
  const long = t.length > lines * 40 || t.split("\n").length > lines;
  return (
    <div className="rpg-clamp-wrap">
      <div
        className={`rpg-clamp${openState ? " is-open" : ""}`}
        style={{ "--rpg-lines": lines } as React.CSSProperties}
        data-testid={testid}
      >
        {t}
      </div>
      {long && (
        <button
          type="button"
          className="btn-link rpg-clamp-toggle"
          aria-expanded={openState}
          data-testid={`${testid}-toggle`}
          onClick={() => setOpen((v) => !v)}
        >
          {openState ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
}
