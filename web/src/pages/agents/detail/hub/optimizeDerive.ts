// ③ 优化的纯派生（ADR-0016「分数口径修订」+「问题台账」）。组件只摆版面，口径都在这里。
//
// 两个数据源、零后端依赖：
//   · 评估器面板 ← 该 Agent 最近一次 completed run 与其之前 completed run 的**环节摘要**
//     （observe `summary[名].mean_score` / dataset `evaluator_stats[名].mean` / redteam
//     `attacks - breached`），走 list_plan_runs 那份（与 ②/报告页共享缓存）；
//   · 问题台账 ← 这一次 run 的 `synthesis_issues[]`（契约 docs/payload-contract.md
//     「问题台账」）；老 run 为 `[]` ⇒ 调用方回落两段散文卡，这里不造条目。
//
// ⚠️ ADR-0003 硬线不动：这里一个数都不跨评估器合成。头部一句话只数「几个过线 / 谁没过」，
// 不出现任何合成分。
import { textOf } from "../../../../lib/renderText";
// 分数排版一律走 lib/scoring 的两个函数，本文件不私写 toFixed(2)：
// 与阈值结论**并排**的位用 fmtScoreFloor（[0.695,0.70) 不许印成 "0.70"），
// 其余用 fmtScore。哪一处是哪一档，逐处注在调用点上。
import { fmtPctInt, fmtScore, fmtScoreFloor } from "../../../../lib/scoring";
import { SCORE_TARGET, evaluatorRows, observeEvaluatorRows, runRedteamTally, sortRunsDesc } from "../../../plan/derive";
import type { PlanRunSummary, RunProposal, StageSummary, SynthesisIssue } from "../../../plan/types";

export { SCORE_TARGET };

export type EvaluatorStageType = "observe" | "dataset" | "redteam";

/** 面板上给红队环节那一行用的名字（评估器名位置；红队没有逐评估器分，整环节一行） */
export const REDTEAM_ROW_NAME = "红队拦截";

/** 评估器面板的一行：评估计划里配了几个评估器就几行；红队环节整体一行（「拦截 a/b」） */
export interface EvaluatorPanelRow {
  /** `${stage}:${name}`（同名评估器在两个环节里是两个数、两种分母 —— 不合并） */
  key: string;
  name: string;
  stage: EvaluatorStageType;
  /** 本次分（红队 = 拦截数 / 攻击数 的比值，展示用 redteam 字段）；null = 一条判定都没有 */
  cur: number | null;
  /** 上一次同键的分；null = 上一次没有这个评估器 / 没有上一次 */
  prev: number | null;
  /** 红队行的原始计数（展示「拦截 a/b」）；非红队为 null */
  redteam: { blocked: number; attacks: number } | null;
  prevRedteam: { blocked: number; attacks: number } | null;
  /** 过 / 未过目标线；cur 为 null 时 null（没有判定就不下结论） */
  pass: boolean | null;
}

type StagedRun = { stage_summaries?: StageSummary[] | null } | null | undefined;

/** 一条 run 的逐评估器读数表（键 → 数）。只读 **completed** 环节：半截环节的数字不是结论。 */
export function evaluatorScores(run: StagedRun): Map<string, EvaluatorPanelRow> {
  const out = new Map<string, EvaluatorPanelRow>();
  for (const st of run?.stage_summaries ?? []) {
    if (st.status !== "completed") continue;
    if (st.type === "observe") {
      for (const r of observeEvaluatorRows(st)) {
        const key = `observe:${r.name}`;
        if (out.has(key)) continue;
        out.set(key, row(key, r.name, "observe", r.mean));
      }
    } else if (st.type === "dataset") {
      for (const r of evaluatorRows(st)) {
        const key = `dataset:${r.name}`;
        if (out.has(key)) continue;
        out.set(key, row(key, r.name, "dataset", r.mean));
      }
    }
  }
  // 红队：一个 run 内 completed 红队环节求和（runRedteamTally 的口径），整体一行
  const rt = run ? runRedteamTally(run as PlanRunSummary) : null;
  if (rt && rt.attacks > 0) {
    const blocked = rt.attacks - rt.breached;
    out.set(`redteam:${REDTEAM_ROW_NAME}`, {
      key: `redteam:${REDTEAM_ROW_NAME}`, name: REDTEAM_ROW_NAME, stage: "redteam",
      cur: blocked / rt.attacks, prev: null,
      redteam: { blocked, attacks: rt.attacks }, prevRedteam: null,
      // 红队的硬事实 = 一次都没被攻破（与 adoption_effect 的 breached 判据同一条）
      pass: rt.breached === 0,
    });
  }
  return out;
}

function row(key: string, name: string, stage: EvaluatorStageType, cur: number | null): EvaluatorPanelRow {
  return {
    key, name, stage, cur, prev: null, redteam: null, prevRedteam: null,
    pass: cur == null ? null : cur >= SCORE_TARGET,
  };
}

/**
 * 面板行 = 这一次 run 的评估器读数 + 上一次同键读数。**未过置顶**（pass=false → null → true），
 * 组内保持环节摘要里的原序（用户在编辑器里配的顺序）。
 */
export function evaluatorPanelRows(thisRun: StagedRun, prevRun: StagedRun): EvaluatorPanelRow[] {
  const cur = evaluatorScores(thisRun);
  const prev = evaluatorScores(prevRun);
  const rows = [...cur.values()].map((r) => {
    const p = prev.get(r.key);
    return { ...r, prev: p?.cur ?? null, prevRedteam: p?.redteam ?? null };
  });
  const rank = (r: EvaluatorPanelRow) => (r.pass === false ? 0 : r.pass === null ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b));
}

/**
 * 头部一句话：「N 个评估器 · M 过线 · <最差评估器> <分> 未过 · 红队拦截 a/b 未达」。
 * 只列未过项；全过写「N 个评估器 · 全部过线」。**不出现合成分**（ADR-0003 / 口径修订）。
 * 没有一行 ⇒ null（调用方不画面板）。
 */
export function evaluatorHeadline(rows: EvaluatorPanelRow[]): string | null {
  if (rows.length === 0) return null;
  const passed = rows.filter((r) => r.pass === true).length;
  const failing = rows.filter((r) => r.pass === false);
  if (failing.length === 0) return `${rows.length} 个评估器 · 全部过线`;
  const parts = [`${rows.length} 个评估器`, `${passed} 过线`];
  const scored = failing.filter((r) => r.stage !== "redteam" && r.cur != null);
  if (scored.length > 0) {
    const worst = scored.reduce((a, b) => (b.cur as number) < (a.cur as number) ? b : a);
    // 「<分> 未过」= 数值与阈值结论同一句里并排 ⇒ 向下取整（0.6987 印 "0.70 未过"
    // 是自相矛盾的话）。判定精度四位，显示两位，floor 让矛盾在数学上不可能。
    parts.push(`${worst.name} ${fmtScoreFloor(worst.cur)} 未过`);
  }
  const rt = failing.find((r) => r.stage === "redteam" && r.redteam);
  if (rt?.redteam) parts.push(`红队拦截 ${rt.redteam.blocked}/${rt.redteam.attacks} 未达`);
  return parts.join(" · ");
}

/** 「较上一次」格：分用 ▲▼ + 两位小数；红队用 ▲▼ + 拦截数差；任一侧缺 / 相等 ⇒ null */
export function rowDelta(r: EvaluatorPanelRow): { dir: "up" | "down"; text: string } | null {
  if (r.stage === "redteam") {
    if (!r.redteam || !r.prevRedteam) return null;
    const d = r.redteam.blocked - r.prevRedteam.blocked;
    if (d === 0) return null;
    return { dir: d > 0 ? "up" : "down", text: `${d > 0 ? "▲" : "▼"}${Math.abs(d)}` };
  }
  if (r.cur == null || r.prev == null) return null;
  const d = r.cur - r.prev;
  if (Math.abs(d) < 0.005) return null;
  // 差值不是分：它旁边没有阈值结论（"▲0.03" 与「过/未过」无关）⇒ 用 fmtScore 不用 floor。
  return { dir: d > 0 ? "up" : "down", text: `${d > 0 ? "▲" : "▼"}${fmtScore(Math.abs(d))}` };
}

// ---------- 最近 8 次小趋势 ----------

export const TREND_WINDOW = 8;

/** 趋势取样：到「这一次」为止（含）的最近 TREND_WINDOW 次 completed run，时间升序。
 *  thisKey 不在历史里 ⇒ 取最近 TREND_WINDOW 次（不拿别的 run 冒充这一次）。 */
export function trendRunsAsc<T extends PlanRunSummary>(
  runs: T[] | undefined, thisKey: string | null | undefined, limit = TREND_WINDOW,
): T[] {
  if (!runs) return [];
  const desc = sortRunsDesc(runs);
  const idx = thisKey ? desc.findIndex((r) => r.run_key === thisKey) : -1;
  return desc.slice(idx < 0 ? 0 : idx).filter((r) => r.status === "completed").slice(0, limit).reverse();
}

/**
 * 面板一行的逐 run 序列（与 trendRunsAsc 同批同序）；那次没有这个键 ⇒ null（线断开，不补 0）。
 *
 * 收**预算好的**读数表数组（`runsAsc.map(evaluatorScores)`），不收 run 数组：此前这里
 * 每行都自己重跑一遍 `evaluatorScores(r)`，而它在 `rows.map` 里被调用 ⇒ 派生量是
 * 行数 × TREND_WINDOW（8 行的面板 = 64 次全量重算，每次都要走 observeEvaluatorRows /
 * evaluatorRows / runRedteamTally）。调用方（EvaluatorPanel）用 useMemo 算一次 8 个 Map
 * 给所有行共享，派生从 R×8 降到 8。
 */
export function rowSeries(scoresAsc: Map<string, EvaluatorPanelRow>[], key: string): (number | null)[] {
  return scoresAsc.map((m) => m.get(key)?.cur ?? null);
}

/**
 * 版本变更竖线落点（下标 i = 第 i 个点与前一个点之间）。口径照 derive.versionMarkers：
 * 第一个点不画；标签没变不画；缺快照的 run 既不出竖线也不重置上一次标签。
 */
export function versionChangeIndices(runsAsc: PlanRunSummary[]): { at: number; label: string }[] {
  const out: { at: number; label: string }[] = [];
  let prev = "";
  runsAsc.forEach((r, i) => {
    const cur = (r.agent_version_label ?? "").trim();
    if (!cur) return;
    if (i > 0 && prev && cur !== prev) out.push({ at: i, label: cur });
    prev = cur;
  });
  return out;
}

// ---------- 问题台账 ----------

export type LedgerGroupKey = "pending" | "open" | "adopted" | "resolved";

export const LEDGER_GROUP_LABEL: Record<LedgerGroupKey, string> = {
  pending: "待建议",
  open: "未采纳",
  adopted: "已采纳待验证",
  resolved: "已解决",
};

/** fix_type → 小标签 */
export const FIX_TYPE_LABEL: Record<string, string> = {
  SYSTEM_PROMPT_FIX: "改系统提示词",
  TOOL_DESCRIPTION_FIX: "改工具描述",
  OTHERS: "其他",
};

/** 建议文本 → proposals[].summary 的匹配键（与后端 _proposal_match_key / RunAdvice.persistedAdoptedAt 同规则） */
export function proposalMatchKey(text: string | null | undefined): string {
  return (text ?? "").trim().slice(0, 300);
}

/** 建议在计划各 run 的 proposals 里对回的那一条（有 adopted_at 的优先）；对不上 ⇒ null */
export interface MatchedProposal {
  runKey: string;
  index: number;
  proposal: RunProposal;
  adoptedAt: string;
}

export function matchProposal(
  runs: PlanRunSummary[] | undefined, recommendation: string | null | undefined,
): MatchedProposal | null {
  const key = proposalMatchKey(recommendation);
  if (!key || !runs) return null;
  let hit: MatchedProposal | null = null;
  for (const r of sortRunsDesc(runs)) {
    (r.proposals ?? []).forEach((p, index) => {
      if (textOf(p?.summary) !== key) return;
      const adoptedAt = textOf(p?.adopted_at).trim();
      if (!hit || (adoptedAt && !hit.adoptedAt)) hit = { runKey: r.run_key, index, proposal: p, adoptedAt };
    });
  }
  return hit;
}

/**
 * 分组：待建议（recommendation null）→ 未采纳（open）→ 已采纳待验证（adopted）→ 已解决（resolved）。
 * 状态直接读后端算好的 `status`（按 proposals 对回，规则在契约里）；本会话刚采纳的由调用方
 * 用 `adoptedNow` 覆盖成 adopted。未采纳组内**本次新增**（first_seen_run == 本次）排前。
 */
export function ledgerGroups(
  issues: SynthesisIssue[], thisKey: string, adoptedNow: ReadonlySet<string> = new Set(),
): Record<LedgerGroupKey, SynthesisIssue[]> {
  const g: Record<LedgerGroupKey, SynthesisIssue[]> = { pending: [], open: [], adopted: [], resolved: [] };
  for (const it of issues) {
    if (!it.recommendation) { g.pending.push(it); continue; }
    if (it.status === "resolved") { g.resolved.push(it); continue; }
    if (it.status === "adopted" || adoptedNow.has(it.id)) { g.adopted.push(it); continue; }
    g.open.push(it);
  }
  const isNew = (it: SynthesisIssue) => (it.first_seen_run === thisKey ? 0 : 1);
  g.open = [...g.open].sort((a, b) => isNew(a) - isNew(b));
  return g;
}

/** 按来源评估器过滤（evaluators 含该名）；filter 为空 ⇒ 原样 */
export function filterIssues(issues: SynthesisIssue[], evaluator: string | null): SynthesisIssue[] {
  if (!evaluator) return issues;
  return issues.filter((it) => (it.evaluators ?? []).includes(evaluator));
}

/** 效果格的展示投影（只投影，不判定 —— 判定归后端 judge_adoption_effect） */
export interface EffectView {
  kind: "improved" | "unchanged" | "regressed" | "pending" | "inconclusive" | "none";
  /** 前后值行（improved / regressed）："correctness 0.62 → 0.85" / "case-9 fail → pass" */
  lines: string[];
  reason: string | null;
}

export function effectView(p: RunProposal | null | undefined): EffectView {
  const e = p?.adoption_effect;
  if (!e || !e.verdict) return { kind: "none", lines: [], reason: null };
  const lines: string[] = [];
  // 效果格印的是「前 → 后」两个值，旁边没有过/未过结论（判定归后端
  // judge_adoption_effect 的 verdict）⇒ fmtScore 档，不用 floor。
  const fmt = fmtScore;
  // 定稿三态都把前后值摆出来（「无效」也要让人看见是 0.92 → 0.94 这种线内移动，不是没变）
  if (e.verdict === "improved" || e.verdict === "unchanged" || e.verdict === "regressed") {
    for (const m of e.metrics ?? []) {
      if (m.name === "breached") lines.push(`攻破 ${m.before ?? "—"} → ${m.after ?? "—"}`);
      else if (m.name === "pass_rate") lines.push(`通过率 ${fmtPctInt(m.before)} → ${fmtPctInt(m.after)}`);
      else lines.push(`${m.name} ${fmt(m.before)} → ${fmt(m.after)}`);
    }
    for (const c of e.cases ?? []) lines.push(`${c.ref} ${c.before} → ${c.after}`);
  }
  const kind = (["improved", "unchanged", "regressed", "pending", "inconclusive"] as const)
    .find((k) => k === e.verdict) ?? "inconclusive";
  return { kind, lines, reason: e.reason ?? null };
}
