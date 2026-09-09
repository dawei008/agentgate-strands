// 「坏例入数据集 + 人工标注」右侧抽屉（ADR-0017 D1 + D2；批 badcase-frontend）。
//
// 版面契约 = .scratch/badcase-intake/contract-variant-a.html（OpenDesign 变体 A，用户
// 2026-09-07 选定）：640px 抽屉，单格态自上而下 为何是坏例 → 原文 → 人工标注 → 加入数据集，
// 底部「加入数据集」「仅保存标注」；批量态借变体 C 第 2 屏形态（左会话清单 + 右当前会话表单 +
// 顶部进度）放进同一个抽屉；成功态在抽屉顶部加一行「已加入 X · 共 N 条 · 打开数据集 →」。
// 批量态的勾选（批 badcase-ux-fix，用户 2026-09-07 反馈「复选框点不动 / 太绝对」）：默认 **0 勾**、
// 复选框**永远可勾**；「期望未改 ⇒ 不能入集」不再做成禁用，而是勾了没改的行给琥珀提示
// 「期望输出未改 · 点行编辑」，底部「加入 N 条」只数勾了且改过的，另一行小字「M 条已勾但期望未改」。
//
// 期望输出的门（ADR D1）：预填 Agent 实际回复作**错答草稿**并带警示条；与草稿逐字相同或为空
// ⇒ 不许提交（存错答等于把缺陷固化）。去重预判：同题面（normalizeInput 全等）已在集内 ⇒
// 「已在集内」+ 主按钮变「更新期望」（on_duplicate=update）。
// 人工分不改机器分（ADR D2）：这里只写 annotate_case；矩阵格里机器分不动、人工分并列小胶囊。
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import type {
  CaseAnnotatedEvent, CaseAnnotation, DatasetCasesAppendedEvent,
} from "../../lib/apiTypes";
import { EMPTY_MARK } from "../../lib/renderText";
import { stageLabel } from "../../lib/scoring";
import Drawer from "../../components/Drawer";
import { Icon } from "../../components/layout/Icons";
import type { DatasetLite } from "../plan/types";
import { shortSessionId } from "../plan/reportRows";
import type { CaseVerdict } from "../plan/derive";
import { f3 } from "./model";
import { Clamp } from "./StageMatrix";
import {
  annotKey, buildCase, caseIndexOf, defaultDatasetName, existingCaseOf, expectedBlockReason,
  fmtAnnotAt, fmtHuman, intakeDrawerTitle, type IntakeItem, type IntakeKind,
} from "./badcase";

export const BADCASE_DRAWER_WIDTH = 640;

export type HumanScore = 0 | 0.5 | 1;

/** 抽屉打开的两种态（页面持有）。single 的 `focus` 只决定打开后滚到哪一段。 */
export type IntakeMode =
  | { mode: "single"; item: IntakeItem; col: string; focus: "dataset" | "annotate" }
  | { mode: "batch"; items: IntakeItem[] };

export interface BadcaseDrawerProps {
  open: boolean;
  onClose: () => void;
  mode: IntakeMode | null;
  runKey: string;
  agentName: string;
  datasets: DatasetLite[];
  annotations: Map<string, CaseAnnotation>;
  /** 本会话内已入集的行名（成功后矩阵立刻打「已入集」；刷新后靠 source 反查） */
  onAdded: (rowKeys: string[], result: DatasetCasesAppendedEvent) => void;
  onAnnotated: (a: CaseAnnotation) => void;
}

const SCORES: HumanScore[] = [0, 0.5, 1];
/** 三档人工分各自的含义（现网反馈：按钮只见 0 / 0.5 / 1，用户问「这个分数是什么」→ 逐档 title） */
const SCORE_TITLE: Record<HumanScore, string> = {
  0: "不合格：Agent 这一格的回答你判为错 / 未达标",
  0.5: "部分合格：答对一部分或方向对但有明显缺陷",
  1: "合格：你判这一格的回答达标",
};
const SCORES_GROUP_TITLE = "你对这一格的人工判定。不改机器分，只并列显示；用于计算评估器与人工的一致率，并随入集写进 source.human_score";

/** 目标数据集的候选：同 kind 的现有集 + 默认集（不存在时标「将自动创建」） */
interface DsOption {
  name: string;
  count: number;
  exists: boolean;
  ds: DatasetLite | null;
}

function dsOptionsOf(datasets: DatasetLite[], kind: IntakeKind, agent: string): DsOption[] {
  const def = defaultDatasetName(agent, kind);
  const same = datasets.filter((d) => d.kind === kind);
  const opts: DsOption[] = same.map((d) => ({
    name: d.name, count: d.cases?.length ?? d.case_count ?? 0, exists: true, ds: d,
  }));
  if (!same.some((d) => d.name === def)) opts.unshift({ name: def, count: 0, exists: false, ds: null });
  else {
    // 默认集排最前
    opts.sort((a, b) => (a.name === def ? -1 : b.name === def ? 1 : 0));
  }
  return opts;
}

export default function BadcaseDrawer(props: BadcaseDrawerProps) {
  const { open, onClose, mode } = props;
  const label = mode?.mode === "batch" ? "批量加入数据集" : "标注并加入数据集";
  return (
    <Drawer open={open} onClose={onClose} width={BADCASE_DRAWER_WIDTH} label={label} className="rpg-bc" testId="badcase-drawer">
      {mode?.mode === "single" && <SingleIntake key={`${props.runKey}|${mode.item.row.key}|${mode.col}`} {...props} mode={mode} />}
      {mode?.mode === "batch" && <BatchIntake key={props.runKey} {...props} mode={mode} />}
    </Drawer>
  );
}

// ==================== 单格态 ====================

function SingleIntake({
  mode, runKey, agentName, datasets, annotations, onAdded, onAnnotated, onClose,
}: BadcaseDrawerProps & { mode: Extract<IntakeMode, { mode: "single" }> }) {
  const qc = useQueryClient();
  const { item, col } = mode;
  const row = item.row;
  const isAttack = item.sourceKind === "attack";
  const verdict: CaseVerdict | null = row.verdicts.find((v) => v.name === col) ?? null;
  const others = item.failed.filter((v) => v.name !== col);
  const headline = item.input || row.name;

  // ---- 人工标注 ----
  const evOptions = useMemo(() => {
    const names = row.verdicts.map((v) => v.name);
    const ordered = [...item.failed.map((v) => v.name), ...names.filter((n) => !item.failed.some((v) => v.name === n))];
    return [...ordered, "overall"];
  }, [row, item]);
  const [evSel, setEvSel] = useState<string>(verdict ? col : "overall");
  const existingAnnot = annotations.get(annotKey(row.name, evSel)) ?? null;
  const [score, setScore] = useState<HumanScore | null>(existingAnnot?.human_score ?? null);
  const [comment, setComment] = useState<string>(existingAnnot?.comment ?? "");
  // 切类型：把已有标注带进来（同一格重标覆盖旧值，先看见旧值）
  useEffect(() => {
    const a = annotations.get(annotKey(row.name, evSel)) ?? null;
    setScore(a?.human_score ?? null);
    setComment(a?.comment ?? "");
  }, [evSel, annotations, row.name]);

  // ---- 加入数据集 ----
  const options = useMemo(() => dsOptionsOf(datasets, item.kind, agentName), [datasets, item.kind, agentName]);
  const [dsName, setDsName] = useState<string>(options[0]?.name ?? defaultDatasetName(agentName, item.kind));
  const opt = options.find((o) => o.name === dsName) ?? options[0];
  const caseIdx = useMemo(() => caseIndexOf(opt?.ds), [opt]);
  const existing = existingCaseOf(caseIdx, item.input);
  const inSet = existing != null;
  const existingExpected = typeof existing?.expected_output === "string" ? existing.expected_output : "";
  const draft = item.reply;
  const [expected, setExpected] = useState<string>(inSet ? existingExpected : draft);
  const [touched, setTouched] = useState(false);
  // 换数据集：用户没动过文本域时跟着换（集内现值 / 错答草稿），动过就不覆盖
  useEffect(() => {
    if (touched) return;
    setExpected(inSet ? existingExpected : draft);
  }, [dsName, inSet, existingExpected, draft, touched]);
  const blockReason = expectedBlockReason(expected, draft, item.kind);

  const [busy, setBusy] = useState<"add" | "annot" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DatasetCasesAppendedEvent | null>(null);
  const [annotSaved, setAnnotSaved] = useState<CaseAnnotation | null>(null);

  const dsRef = useRef<HTMLElement>(null);
  const annotRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = mode.focus === "annotate" ? annotRef.current : dsRef.current;
    el?.scrollIntoView?.({ block: "start" });
    if (mode.focus === "annotate") el?.querySelector<HTMLButtonElement>(".rpg-bc-score")?.focus();
  }, [mode.focus]);

  async function saveAnnotation(): Promise<CaseAnnotation | null> {
    if (score == null) return null;
    // human_score 必须是 JSON 数（后端拒 "0.5" / true）；label = 类型（契约示例同形）；comment 上限 2000 字
    const res = await apiOne<CaseAnnotatedEvent>({
      action: "annotate_case", run_key: runKey, row_key: row.name, evaluator: evSel, human_score: score,
      label: evSel.slice(0, 120),
      ...(comment.trim() ? { comment: comment.trim().slice(0, 2000) } : {}),
    }, "case_annotated");
    onAnnotated(res.annotation);
    setAnnotSaved(res.annotation);
    return res.annotation;
  }

  async function onSaveAnnot() {
    if (score == null || busy) return;
    setBusy("annot"); setError(null);
    try { await saveAnnotation(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  async function onAdd() {
    if (blockReason || busy || !opt) return;
    setBusy("add"); setError(null);
    try {
      const annot = await saveAnnotation();
      const c = buildCase({
        runKey, item, expected, humanScore: annot?.human_score ?? null, notes: annot?.comment ?? "",
      });
      const res = await apiOne<DatasetCasesAppendedEvent>({
        action: "append_dataset_cases",
        dataset: opt.name, kind: item.kind, create_if_missing: true, target_agent: agentName,
        on_duplicate: inSet ? "update" : "skip", cases: [c],
      }, "dataset_cases_appended");
      setResult(res);
      setTouched(true);
      onAdded([row.name], res);
      await qc.invalidateQueries({ queryKey: ["datasets"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const shownAnnot = annotSaved ?? existingAnnot;
  const kindText = stageLabel(item.kind === "redteam" ? "redteam" : "dataset");

  return (
    <>
      <header className="rpg-bc-head">
        <div className="rpg-bc-title">
          <h2 title={headline} data-testid="badcase-title">{headline}</h2>
          <div className="id mono" title={row.name}>{row.name}</div>
        </div>
        {verdict && <span className="chip rpg-bc-chip bad mono">{col}</span>}
        {isAttack && <span className="badge bad">攻破</span>}
        <button type="button" className="btn ghost mini rpg-bc-x" aria-label="关闭" data-testid="badcase-close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      {result && <SuccessRow result={result} />}

      <div className="rpg-bc-body">
        {/* ① 为何是坏例 */}
        <section className="rpg-bc-sec" data-testid="badcase-why">
          <div className="rpg-bc-sec-h"><h3>为何是坏例</h3></div>
          <div className="rpg-bc-why">
            {verdict ? (
              <>
                <span className="chip rpg-bc-chip bad mono">{verdict.name}</span>
                <span className="rpg-bc-score-num mono">{verdict.score == null ? EMPTY_MARK : f3(verdict.score)}</span>
                {verdict.label && <span className="badge bad">{verdict.label}</span>}
              </>
            ) : (
              <span className="badge bad">攻破</span>
            )}
            <span className="rpg-bc-hint">评委理由</span>
          </div>
          <Clamp text={verdict ? verdict.reason : row.reason} lines={2} testid="badcase-reason" emptyText="judge 没有给出理由" />
          {others.length > 0 && (
            <div className="rpg-bc-also" data-testid="badcase-also">
              同{isAttack ? "攻击" : "会话"}另 {others.length} 项未过
              {others.map((v) => (
                <span key={v.name} className="chip rpg-bc-chip bad mono">
                  {v.name}<span className="cnt">{v.score == null ? EMPTY_MARK : f3(v.score)}</span>
                </span>
              ))}
            </div>
          )}
        </section>

        {/* ② 原文 */}
        <section className="rpg-bc-sec" data-testid="badcase-original">
          <div className="rpg-bc-sec-h"><h3>原文</h3></div>
          {isAttack && item.objective && (
            <div className="rpg-bc-msg">
              <span className="who">攻击目的</span>
              <Clamp text={item.objective} lines={2} testid="badcase-objective" emptyText={EMPTY_MARK} />
            </div>
          )}
          <div className="rpg-bc-msg">
            <span className="who">{isAttack ? "红队" : "用户"}</span>
            <Clamp text={item.input} lines={4} testid="badcase-input" emptyText={EMPTY_MARK} />
          </div>
          <div className="rpg-bc-msg">
            <span className="who">Agent</span>
            <Clamp text={item.reply} lines={4} testid="badcase-reply" emptyText={EMPTY_MARK} />
          </div>
        </section>

        {/* ③ 人工标注 */}
        <section className="rpg-bc-sec" ref={annotRef} data-testid="badcase-annotate">
          <div className="rpg-bc-sec-h">
            <h3>人工标注</h3>
            <span className="chip rpg-bc-chip" data-testid="badcase-score-legend" title={SCORES_GROUP_TITLE}>0 · 0.5 · 1 三档，与评委分并列</span>
            {shownAnnot && (
              <span className="rpg-bc-annot-state" data-testid="badcase-annot-state">
                <span className="badge run">已标注</span>
                <span className="mono">{fmtHuman(shownAnnot.human_score)}</span>·
                <span className="mono">{fmtAnnotAt(shownAnnot.at)}</span>
              </span>
            )}
          </div>
          <div className="rpg-bc-scores" role="group" aria-label="人工分" title={SCORES_GROUP_TITLE}>
            {SCORES.map((s) => (
              <button
                key={s}
                type="button"
                className="rpg-bc-score mono"
                title={SCORE_TITLE[s]}
                aria-pressed={score === s}
                data-testid={`badcase-score-${s}`}
                onClick={() => setScore(s)}
              >
                {fmtHuman(s)}
              </button>
            ))}
          </div>
          <div className="rpg-bc-fields">
            <label className="rpg-bc-fld">
              <span className="k">类型</span>
              <select className="u-select mono" value={evSel} data-testid="badcase-annot-type" onChange={(e) => setEvSel(e.target.value)}>
                {evOptions.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="rpg-bc-fld grow">
              <span className="k">备注</span>
              <input className="u-input" value={comment} placeholder="可选" maxLength={2000} data-testid="badcase-annot-comment" onChange={(e) => setComment(e.target.value)} />
            </label>
          </div>
        </section>

        {/* ④ 加入数据集 */}
        <section className="rpg-bc-sec" ref={dsRef} data-testid="badcase-dataset">
          <div className="rpg-bc-sec-h">
            <h3>加入数据集</h3>
            {inSet && <span className="badge ok right" data-testid="badcase-inset">已在集内</span>}
          </div>
          <div className="rpg-bc-stack">
            <label className="rpg-bc-fld">
              <span className="k">数据集</span>
              <select className="u-select mono" value={dsName} data-testid="badcase-ds" onChange={(e) => setDsName(e.target.value)}>
                {options.map((o) => (
                  <option key={o.name} value={o.name}>
                    {o.name} · {o.count} 条{o.exists ? "" : " · 将自动创建"}
                  </option>
                ))}
              </select>
              <span className="rpg-bc-ds-meta">
                <span className="chip rpg-bc-chip">{kindText}</span>
                <span className="chip rpg-bc-chip mono">{opt?.count ?? 0} 条</span>
                {opt && !opt.exists && <span className="badge warn" data-testid="badcase-ds-create">将自动创建</span>}
              </span>
            </label>
            <label className="rpg-bc-fld">
              <span className="k">输入 <code>input</code></span>
              <input className="u-input" readOnly value={item.input} data-testid="badcase-case-input" />
            </label>
            <label className="rpg-bc-fld">
              <span className="k">
                期望输出 <code>expected_output</code>
                {inSet ? <span className="rpg-bc-hint">集内现值</span>
                  : isAttack ? <span className="rpg-bc-hint">可选</span> : <span className="req">必填</span>}
              </span>
              {expected === draft && (
                <span className="rpg-bc-note-warn" data-testid="badcase-expected-warn">这是错答，请改成正确答案</span>
              )}
              <textarea
                className={`u-textarea rpg-bc-expected${expected === draft ? " is-warn" : ""}`}
                rows={7}
                value={expected}
                data-testid="badcase-expected"
                onChange={(e) => { setTouched(true); setExpected(e.target.value); }}
              />
            </label>
          </div>
        </section>
      </div>

      <footer className="rpg-bc-foot">
        <div className="rpg-bc-foot-main">
          <button
            type="button"
            className="btn"
            disabled={blockReason != null || busy != null}
            data-testid="badcase-add"
            onClick={onAdd}
          >
            {busy === "add" ? "保存中…" : inSet ? "更新期望" : "加入数据集"}
          </button>
          {blockReason && <span className="rpg-bc-hint" data-testid="badcase-add-reason">{blockReason}</span>}
        </div>
        <button
          type="button"
          className="btn ghost"
          disabled={score == null || busy != null}
          title={score == null ? "先选一个人工分" : undefined}
          data-testid="badcase-save-annot"
          onClick={onSaveAnnot}
        >
          {busy === "annot" ? "保存中…" : "仅保存标注"}
        </button>
        {error && <span className="plan-editor-error" role="alert" data-testid="badcase-error">{error}</span>}
      </footer>
    </>
  );
}

/** 成功行：已加入 X · 共 N 条 · 打开数据集 →（首次创建再多一句「为它建评估计划 →」） */
function SuccessRow({ result }: { result: DatasetCasesAppendedEvent }) {
  return (
    <div className="rpg-bc-ok" role="status" data-testid="badcase-success">
      <span>
        已加入 <b className="mono">{result.dataset}</b> · 共 <b className="mono">{result.case_count}</b> 条
        {result.updated > 0 && <> · 更新 <b className="mono">{result.updated}</b> 条</>}
      </span>
      <span className="rpg-bc-ok-links">
        <a href="#/datasets" data-testid="badcase-open-dataset">打开数据集 →</a>
        {result.created && (
          <a
            // 编辑器按 ?dataset= 预填数据集环节 + 计划名（PlanEditor presetDataset）
            href={`#/plan/new?dataset=${encodeURIComponent(result.dataset)}`}
            data-testid="badcase-new-plan"
            title={`为 ${result.dataset} 建一个评估计划（编辑器已预选这个数据集）`}
          >
            为它建评估计划 →
          </a>
        )}
      </span>
    </div>
  );
}

// ==================== 批量态 ====================

interface BatchRowState {
  selected: boolean;
  expected: string;
}

function BatchIntake({
  mode, runKey, agentName, datasets, annotations, onAdded, onClose,
}: BadcaseDrawerProps & { mode: Extract<IntakeMode, { mode: "batch" }> }) {
  const qc = useQueryClient();
  const items = mode.items;
  const kinds = useMemo(() => Array.from(new Set(items.map((i) => i.kind))), [items]);
  const optionsByKind = useMemo(() => {
    const m = new Map<IntakeKind, DsOption[]>();
    for (const k of kinds) m.set(k, dsOptionsOf(datasets, k, agentName));
    return m;
  }, [kinds, datasets, agentName]);
  const [dsByKind, setDsByKind] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const k of kinds) o[k] = optionsByKind.get(k)?.[0]?.name ?? defaultDatasetName(agentName, k);
    return o;
  });
  const optOf = (k: IntakeKind) => optionsByKind.get(k)?.find((o) => o.name === dsByKind[k]) ?? optionsByKind.get(k)?.[0];
  const idxByKind = useMemo(() => {
    const m = new Map<IntakeKind, ReturnType<typeof caseIndexOf>>();
    for (const k of kinds) m.set(k, caseIndexOf(optOf(k)?.ds));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds, dsByKind, optionsByKind]);

  const existingOf = (it: IntakeItem) => existingCaseOf(idxByKind.get(it.kind) ?? new Map(), it.input);

  // 默认一行都不勾：哪些进集由用户自己挑（已在集内的行预填集内现值，没在的预填错答草稿）
  const [rows, setRows] = useState<Record<string, BatchRowState>>(() => {
    const o: Record<string, BatchRowState> = {};
    for (const it of items) {
      const ex = existingOf(it);
      const exExpected = typeof ex?.expected_output === "string" ? ex.expected_output : "";
      o[it.row.key] = { selected: false, expected: ex ? exExpected : it.reply };
    }
    return o;
  });
  const [cur, setCur] = useState<string>(items[0]?.row.key ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<DatasetCasesAppendedEvent[]>([]);

  const validOf = (it: IntakeItem) => expectedBlockReason(rows[it.row.key]?.expected ?? "", it.reply, it.kind) == null;
  const selectedItems = items.filter((it) => rows[it.row.key]?.selected);
  // 真正会提交的 = 勾了且期望已改；勾了没改的只计数提示，不禁用复选框
  const effective = selectedItems.filter(validOf);
  const unedited = selectedItems.length - effective.length;
  const toAdd = effective.filter((it) => existingOf(it) == null);
  const toUpdate = effective.filter((it) => existingOf(it) != null);
  const done = items.filter(validOf).length;
  const allSelected = items.length > 0 && selectedItems.length === items.length;

  const current = items.find((it) => it.row.key === cur) ?? items[0];

  function setRow(key: string, patch: Partial<BatchRowState>) {
    setRows((r) => ({ ...r, [key]: { ...r[key], ...patch } }));
  }

  // 点行 ⇒ 右侧期望输出文本域聚焦（「先改期望」这条路要一眼看得见、一下就能打字）
  const expectedRef = useRef<HTMLTextAreaElement>(null);
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    if (focusTick > 0) expectedRef.current?.focus();
  }, [focusTick, cur]);
  const pickRow = (key: string) => {
    setCur(key);
    setFocusTick((t) => t + 1);
  };

  async function onSubmit() {
    if (busy || effective.length === 0) return;
    setBusy(true); setError(null);
    try {
      const out: DatasetCasesAppendedEvent[] = [];
      const keys: string[] = [];
      for (const k of kinds) {
        const group = effective.filter((it) => it.kind === k);
        if (group.length === 0) continue;
        const opt = optOf(k);
        if (!opt) continue;
        const anyUpdate = group.some((it) => existingOf(it) != null);
        const res = await apiOne<DatasetCasesAppendedEvent>({
          action: "append_dataset_cases",
          dataset: opt.name, kind: k, create_if_missing: true, target_agent: agentName,
          on_duplicate: anyUpdate ? "update" : "skip",
          cases: group.map((it) => {
            const a = annotations.get(annotKey(it.row.name, "overall"))
              ?? it.failed.map((v) => annotations.get(annotKey(it.row.name, v.name))).find((x) => x) ?? null;
            return buildCase({
              runKey, item: it, expected: rows[it.row.key].expected,
              humanScore: a?.human_score ?? null, notes: a?.comment ?? "",
            });
          }),
        }, "dataset_cases_appended");
        out.push(res);
        keys.push(...group.map((it) => it.row.name));
      }
      setResults(out);
      for (const res of out) onAdded(keys, res);
      await qc.invalidateQueries({ queryKey: ["datasets"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const title = intakeDrawerTitle(items);

  return (
    <>
      <header className="rpg-bc-head">
        <div className="rpg-bc-title">
          <h2 data-testid="badcase-title">{title}</h2>
          <div className="id mono">{runKey}</div>
        </div>
        <span className="rpg-bc-progress mono" data-testid="badcase-progress" title="已填好期望输出的行数 / 全部未过行">
          {done} / {items.length}<small>已填期望</small>
        </span>
        <button type="button" className="btn ghost mini rpg-bc-x" aria-label="关闭" data-testid="badcase-close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      {results.map((r) => <SuccessRow key={r.dataset} result={r} />)}

      <div className="rpg-bc-body">
        <section className="rpg-bc-sec rpg-bc-ds-row">
          {kinds.map((k) => {
            const opts = optionsByKind.get(k) ?? [];
            const opt = optOf(k);
            return (
              <label className="rpg-bc-fld" key={k}>
                <span className="k">数据集{kinds.length > 1 && <> · {stageLabel(k === "redteam" ? "redteam" : "dataset")}</>}</span>
                <select
                  className="u-select mono"
                  value={dsByKind[k]}
                  data-testid={`badcase-batch-ds-${k}`}
                  onChange={(e) => setDsByKind((d) => ({ ...d, [k]: e.target.value }))}
                >
                  {opts.map((o) => (
                    <option key={o.name} value={o.name}>{o.name} · {o.count} 条{o.exists ? "" : " · 将自动创建"}</option>
                  ))}
                </select>
                <span className="rpg-bc-ds-meta">
                  <span className="chip rpg-bc-chip">{stageLabel(k === "redteam" ? "redteam" : "dataset")}</span>
                  <span className="chip rpg-bc-chip mono">{opt?.count ?? 0} 条</span>
                  {opt && !opt.exists && <span className="badge warn">将自动创建</span>}
                </span>
              </label>
            );
          })}
        </section>

        <div className="rpg-bc-split">
          {/* 左：会话清单 */}
          <ol className="rpg-bc-list" data-testid="badcase-batch-list">
            {items.map((it) => {
              const st = rows[it.row.key];
              const valid = validOf(it);
              const inSet = existingOf(it) != null;
              // 勾了却没改期望：不禁用、不悄悄丢，行内琥珀字告诉人下一步是「点行编辑」
              const pendingEdit = !!st?.selected && !valid;
              const short = it.sourceKind === "session" ? shortSessionId(it.row.name) : it.row.name;
              return (
                <li key={it.row.key} className={`rpg-bc-item${it.row.key === current?.row.key ? " is-current" : ""}`} data-testid={`badcase-batch-row-${short}`}>
                  <input
                    type="checkbox"
                    checked={!!st?.selected}
                    aria-label={`选择 ${short}`}
                    title={pendingEdit ? "期望输出未改 · 改好才会计入「加入」" : undefined}
                    data-testid={`badcase-batch-check-${short}`}
                    onChange={(e) => setRow(it.row.key, { selected: e.target.checked })}
                  />
                  <button type="button" className="rpg-bc-item-main" aria-current={it.row.key === current?.row.key || undefined} onClick={() => pickRow(it.row.key)}>
                    <span className="q" title={it.input}>{it.input || it.row.name}</span>
                    <span className="meta mono">
                      {short}
                      {inSet && <span className="badge ok" data-testid={`badcase-batch-inset-${short}`}>已在集内</span>}
                    </span>
                    <span className="chips">
                      {it.failed.map((v) => (
                        <span key={v.name} className="chip rpg-bc-chip bad mono">{v.name}<span className="cnt">{v.score == null ? EMPTY_MARK : f3(v.score)}</span></span>
                      ))}
                      {it.failed.length === 0 && <span className="badge bad">攻破</span>}
                    </span>
                    <span className={`st${valid ? " ok" : ""}${pendingEdit ? " warn" : ""}`} data-testid={`badcase-batch-state-${short}`}>
                      {valid ? "✓ 期望输出" : pendingEdit ? "期望输出未改 · 点行编辑" : "期望输出 · 未改"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          {/* 右：当前会话表单 */}
          {current && (
            <div className="rpg-bc-cur" data-testid="badcase-batch-form">
              <div className="rpg-bc-why">
                {current.failed.map((v) => (
                  <span key={v.name} className="chip rpg-bc-chip bad mono">{v.name}<span className="cnt">{v.score == null ? EMPTY_MARK : f3(v.score)}</span></span>
                ))}
                {current.failed[0]?.label && <span className="badge bad">{current.failed[0].label}</span>}
              </div>
              <Clamp text={current.failed[0]?.reason ?? current.row.reason} lines={2} testid="badcase-batch-reason" emptyText="judge 没有给出理由" />
              <label className="rpg-bc-fld">
                <span className="k">输入 <code>input</code></span>
                <input className="u-input" readOnly value={current.input} />
              </label>
              <label className="rpg-bc-fld">
                <span className="k">
                  期望输出 <code>expected_output</code>
                  {existingOf(current) ? <span className="rpg-bc-hint">集内现值</span>
                    : current.sourceKind === "attack" ? <span className="rpg-bc-hint">可选</span> : <span className="req">必填</span>}
                </span>
                {rows[current.row.key]?.expected === current.reply && (
                  <span className="rpg-bc-note-warn">这是错答，请改成正确答案</span>
                )}
                <textarea
                  ref={expectedRef}
                  className={`u-textarea rpg-bc-expected${rows[current.row.key]?.expected === current.reply ? " is-warn" : ""}`}
                  rows={6}
                  value={rows[current.row.key]?.expected ?? ""}
                  data-testid="badcase-batch-expected"
                  onChange={(e) => setRow(current.row.key, { expected: e.target.value })}
                />
              </label>
            </div>
          )}
        </div>
      </div>

      <footer className="rpg-bc-foot">
        <label className="rpg-bc-selall">
          <input
            type="checkbox"
            checked={allSelected}
            aria-label="全选"
            data-testid="badcase-batch-selall"
            onChange={(e) => setRows((r) => {
              const o = { ...r };
              for (const it of items) o[it.row.key] = { ...o[it.row.key], selected: e.target.checked };
              return o;
            })}
          />
          已选 <span className="mono" data-testid="badcase-batch-selected">{selectedItems.length} / {items.length}</span>
        </label>
        {unedited > 0 && (
          <span className="rpg-bc-unedited" data-testid="badcase-batch-unedited" title="勾了但期望输出还是错答草稿的行：点行改好期望才会计入「加入」">
            <span className="mono">{unedited}</span> 条已勾但期望未改
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="btn ghost" data-testid="badcase-batch-cancel" onClick={onClose}>取消</button>
        <button
          type="button"
          className="btn"
          disabled={busy || effective.length === 0}
          data-testid="badcase-batch-submit"
          onClick={onSubmit}
        >
          {busy ? "保存中…" : (
            <>
              加入 <span className="mono">{toAdd.length}</span> 条
              {toUpdate.length > 0 && <> · 更新 <span className="mono">{toUpdate.length}</span> 条</>}
            </>
          )}
        </button>
        {error && <span className="plan-editor-error" role="alert" data-testid="badcase-error">{error}</span>}
      </footer>
    </>
  );
}
