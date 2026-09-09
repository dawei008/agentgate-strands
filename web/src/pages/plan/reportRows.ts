// ADR-0014 运行报告「只讲本次」的行层推导：裁决句 + 全量表（一张表管三环节）。
//
// 数据源与钻取层同一批（derive.reportStageDetails 的 S3 全量报告体），行的归一化
// 照 compare/derive.ts 三环节范式（datasetUnits/observeUnits/redteamUnits）——
// 但这里是**单 run 视图**，不做跨 run 对齐键。本文件只放纯函数（便于直测），
// 渲染在 ReportView.tsx。
//
// 判定口径（ADR-0014 第 3 条：全部用 SDK 自带 test_pass，不发明阈值、不比上次）：
//   · 行级过/挂 = per-case AND（所有有效判定都 passed 才算过）——逐字照
//     app/planrun.py:_stage_summary 的 dataset 分支（先剔 errored，
//     一条有效判定都不剩 → 不入分母），与 compare/derive.outcomeOf 同源；
//   · 红队行只有 攻破/守住（redteam.py:_shape_report：
//     `breached = (not passed) and not errored`；errored = 无有效结论）；
//   · 「没跑成」= 空响应 / 调用失败 / Agent 报错 / 评估执行失败 / trace 拉取失败 /
//     无内容可评 / 红队无有效结论 —— 全部保留在表里并计入裁决句，
//     让它消失会被读成「这一条没问题」。
import { textOf } from "../../lib/renderText";
import { fmtPctInt, type RunOutcome } from "../../lib/scoring";
import {
  caseRows, sessionRows, verdictsOf, reportStages, reportStageDetails, stageKind, SCORE_TARGET,
  type CaseVerdict,
} from "./derive";
import type {
  CaseResult, PlanRunDetail, SessionDiagnosis, StageDetail, StageSummary,
} from "./types";

// ---------- 行 ----------

/** 行级结果三档。fail 含红队「被攻破」；none = 没跑成（无有效判定）。 */
export type RowOutcome = "pass" | "fail" | "none";

/** 诊断的展示投影（category 数组 / confidence 字符串的真形态坑收在 diagnosisOf）。 */
export interface RowDiagnosisFailure {
  category: string;
  evidence: string;
}
export interface RowRootCause {
  /** 根因（B1 新键 root_cause_explanation；旧形状 run 缺键 → 空串，该行不渲染） */
  explanation: string;
  /** SYSTEM_PROMPT_FIX | TOOL_DESCRIPTION_FIX | OTHERS（SDK RCAItem.fix_type） */
  fixType: string;
  /** 修法（fix_recommendation 原话） */
  fix: string;
}
export interface RowDiagnosis {
  failures: RowDiagnosisFailure[];
  rootCauses: RowRootCause[];
}

/** 一行 = 一个用例 / 会话 / 攻击（全量表的行）。 */
export interface ReportRow {
  /** 组内稳定 key（后端不保证名字唯一，补下标） */
  key: string;
  kind: "case" | "session" | "attack";
  /** 用例名 / session_id / 攻击名 */
  name: string;
  /** 次要标识：分类·Agent / Agent / 策略·严重度 */
  sub: string;
  outcome: RowOutcome;
  /** 逐评估器判定（含 errored —— 它们要以「评估失败」出现，不能消失） */
  verdicts: CaseVerdict[];
  /** 仅红队行：true=攻破 false=守住；null = 无有效结论（errored） */
  breached: boolean | null;
  /** 没跑成的短标记 + 后端原话（没有原话就空串，不代后端编） */
  note: { kind: string; mark: string; text: string } | null;
  /** 输入 / objective；会话行恒空串（它不是数据集的题） */
  input: string;
  /** 期望输出（仅 dataset） */
  expected: string;
  /** 实际输出 / 输出预览（后端截前 300 字）；红队行恒空串（回答在对话里） */
  output: string;
  /** 红队攻击对话全文（角色标注逐条拼接）；其余环节恒空串 */
  conversation: string;
  /** 红队判定原话（redteam.py 三支各有各的 reason）；errored 的原话走 note */
  reason: string;
  /** 红队行（B1 契约新增）：攻击落在哪些 target 会话上；空数组 = 不渲染 */
  sessionIds: string[];
  /** 诊断（category+根因+修法）；红队无诊断管线 → 恒 null，不渲染 */
  diagnosis: RowDiagnosis | null;
  /** 仅会话行（报告页矩阵，批 report-redesign-a）：transcript 首条用户输入原文。
   *  可选：既有消费方 / 旧测试夹具不带它也合法；dataset 行的题面在 input。 */
  prompt?: string;
  /** 仅会话行：transcript 末条 assistant 全文（output 是后端截 300 字的预览）。 */
  reply?: string;
  /** 仅会话行：会话指标投影（tokens / 模型调用 / 工具调用 / 时延）；缺 → null */
  metrics?: RowMetrics | null;
  /** 后端原序下标（reportGroups 排序前记下；报告页矩阵按它排回原序） */
  order?: number;
}

/** 一个环节分组（tbody 组）。组头 metrics 取现有 stage summary（stageNumbers）。 */
export interface ReportGroup {
  /** 环节下标，与 stage_summaries 同序（planrun.py:1101 两数组同序同长） */
  index: number;
  type: string;
  stage: StageSummary;
  /** 失败行组内置顶：fail → none → pass，各档内保持后端原序（稳定排序） */
  rows: ReportRow[];
  /** fail 行数（置顶的那批） */
  failed: number;
  /** 对上的 S3 明细环节原物（带 metrics / analysis / session_details）；对不上 → null。
   *  报告页的成本时延条读它的 `metrics`（DDB 摘要 `stage` 上没有）。可选：既有夹具不带也合法。 */
  detail?: StageDetail | null;
}

/** 逐评估器判定 → 行级过/挂。口径逐字照 app/planrun.py:_stage_summary 的
 *  dataset 分支（与 compare/derive.outcomeOf 同一套）：先剔 errored；一条有效
 *  判定都不剩 → none；per-case AND。`excluded` 对应后端 judged 闸门的前两条
 *  （blank_output / error）。 */
export function rowOutcomeOf(verdicts: CaseVerdict[], excluded: boolean): RowOutcome {
  if (excluded) return "none";
  const live = verdicts.filter((v) => !v.errored);
  if (live.length === 0) return "none";
  return live.every((v) => v.passed === true) ? "pass" : "fail";
}

/**
 * 诊断原物 → 展示投影。真形态坑（RunDetailPage 的 DIAGNOSIS 块踩过，搬逻辑）：
 *   category 是 **list[str]**（app/diagnosis.py:33 未 str()）→ textOf 用 " · " 连；
 *   confidence 是 str(list[float])（"[0.9]"）—— 本表不展示它，不 toFixed；
 *   root_cause_explanation 是 B1 新键，旧形状 run 缺键 → 空串（那一行不渲染，
 *   **不**拿 causality 顶替 —— 那是 PRIMARY_FAILURE 这类枚举词，不是根因文本）。
 * failures 与 root_causes 都空（含 clean:true 的「诊断过、没发现执行故障」）→ null。
 */
export function diagnosisOf(diag: SessionDiagnosis | null | undefined): RowDiagnosis | null {
  if (!diag || typeof diag !== "object") return null;
  const failures = (Array.isArray(diag.failures) ? diag.failures : [])
    .map((raw) => {
      const f = (raw ?? {}) as Record<string, unknown>;
      return { category: textOf(f.category).trim(), evidence: textOf(f.evidence).trim() };
    })
    .filter((f) => f.category !== "" || f.evidence !== "");
  const rootCauses = (Array.isArray(diag.root_causes) ? diag.root_causes : [])
    .map((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      return {
        explanation: textOf(r.root_cause_explanation).trim(),
        fixType: textOf(r.fix_type).trim(),
        fix: textOf(r.fix_recommendation).trim(),
      };
    })
    .filter((r) => r.explanation !== "" || r.fix !== "");
  if (failures.length === 0 && rootCauses.length === 0) return null;
  return { failures, rootCauses };
}

/** 回归环节 → 用例行。行料直接用 derive.caseRows（运行报告与 run 对比读的是
 *  同一个函数，「这一行是什么」不许各算一遍）。 */
function datasetRowsOf(stage: StageDetail): ReportRow[] {
  return caseRows(stage).map((row) => ({
    key: row.key,
    kind: "case" as const,
    name: row.name,
    sub: [row.category, row.agent].filter(Boolean).join(" · "),
    outcome: rowOutcomeOf(
      row.verdicts,
      row.note?.kind === "blank" || row.note?.kind === "invoke_error",
    ),
    verdicts: row.verdicts,
    breached: null,
    note: row.note,
    input: row.input,
    expected: row.expected,
    output: row.output,
    conversation: "",
    reason: "",
    sessionIds: [],
    diagnosis: diagnosisOf(row.diagnosis),
  }));
}

/** 线上评估环节 → 会话行（derive.sessionRows 同一份行料）。
 *  拉取失败 / 无内容可评的会话无有效判定 → none（后端已把判定置 errored）。 */
function observeRowsOf(stage: StageDetail): ReportRow[] {
  // sessionRows 与 session_details 同序同长（1:1 map）⇒ 按下标回读原物里
  // sessionRows 刻意不搬的两键（transcript / metrics），只给报告页矩阵用
  const raws = Array.isArray(stage.session_details) ? stage.session_details : [];
  return sessionRows(stage).map((row, i) => {
    const raw = (raws[i] ?? {}) as { transcript?: unknown; metrics?: unknown };
    const texts = transcriptTexts(raw.transcript);
    return {
      key: row.key,
      kind: "session" as const,
      name: row.id,
      sub: row.agent,
      outcome: rowOutcomeOf(row.verdicts, row.note != null),
      verdicts: row.verdicts,
      breached: null,
      note: row.note,
      input: "",
      expected: "",
      output: row.output,
      conversation: "",
      reason: "",
      sessionIds: [],
      diagnosis: diagnosisOf(row.diagnosis),
      prompt: texts.input,
      reply: texts.reply || row.output,
      metrics: rowMetricsOf(raw.metrics),
    };
  });
}

/** 攻击对话全文：[{role: attacker|target, content}]（redteam.py:608）→ 逐条
 *  角色标注拼接。role 两族的归类照 compare/derive 的读法（attacker/user 是
 *  攻方，target/assistant 是被测 Agent）。非数组（errored 攻击可能整键缺）→ 空串。 */
export function conversationText(conversation: unknown): string {
  if (!Array.isArray(conversation)) return "";
  const lines: string[] = [];
  for (const raw of conversation) {
    const m = (raw ?? {}) as { role?: unknown; content?: unknown };
    const role = textOf(m.role).trim();
    const content = textOf(m.content);
    if (!content) continue;
    lines.push(`【${role === "attacker" || role === "user" ? "红队" : "Agent"}】${content}`);
  }
  return lines.join("\n");
}

/** 红队环节 → 攻击行。范式照 compare/derive.redteamUnits（redteam.py:_shape_report：
 *  `breached = (not passed) and not errored`；errored 行「既非攻破也非守住」）。 */
function attackRowsOf(stage: StageDetail): ReportRow[] {
  const raws = stage.report?.results;
  if (!Array.isArray(raws)) return [];
  return raws.map((raw, i) => {
    const r = (raw ?? {}) as CaseResult;
    const name = textOf(r.case_name).trim() || textOf(r.case).trim() || `攻击 ${i + 1}`;
    const errored = r.errored === true;
    const breached = r.breached === true;
    return {
      key: `${name}#${i}`,
      kind: "attack" as const,
      name,
      sub: [textOf(r.strategy).trim(), textOf(r.severity).trim()].filter(Boolean).join(" · "),
      outcome: (errored ? "none" : breached ? "fail" : "pass") as RowOutcome,
      // errored 攻击的 results 是 {} → 判定列表为空，原因走 note
      verdicts: verdictsOf(r.results),
      breached: errored ? null : breached,
      // errored 三支的原话在 reason 里（declined/unreachable/silenced）
      note: errored ? { kind: "errored", mark: "无有效结论", text: textOf(r.reason) } : null,
      input: textOf(r.objective),
      expected: "",
      output: "",
      conversation: conversationText(r.conversation),
      reason: errored ? "" : textOf(r.reason),
      sessionIds: Array.isArray(r.session_ids)
        ? r.session_ids.filter((x): x is string => typeof x === "string" && x.trim() !== "")
        : [],
      diagnosis: null, // redteam 无诊断管线（planrun._collect_root_causes 跳过）
    };
  });
}

/** 排序档位：失败行标红置顶（组内），没跑成其次，通过的在后；档内稳定保序。 */
const ROW_RANK: Record<RowOutcome, number> = { fail: 0, none: 1, pass: 2 };

/**
 * 全量表分组：一个环节一组，**摘要数组定分组**（reportStages 三重兜底 ——
 * 明细可能整个缺（老 run / S3 读失败），那种环节照样要有组头把摘要数字摆出来）。
 * 明细按同下标 + 同 type 对上（两数组同序同长，planrun.py:1101；type 闸门同
 * exportReport.drillSection —— 万一不同序，宁可没有行，也不把 A 环节的行摆到
 * B 环节名下）。
 */
export function reportGroups(d: PlanRunDetail | null | undefined): ReportGroup[] {
  const summaries = reportStages(d);
  const details = reportStageDetails(d);
  return summaries.map((stage, index) => {
    const det = details[index];
    const matched = det?.type === stage.type ? det : undefined;
    let rows: ReportRow[] = [];
    if (matched) {
      if (stage.type === "dataset") rows = datasetRowsOf(matched);
      else if (stage.type === "observe") rows = observeRowsOf(matched);
      else if (stage.type === "redteam") rows = attackRowsOf(matched);
    }
    return {
      index,
      type: stage.type ?? "",
      stage,
      // order = 后端原序下标（报告页矩阵按它排回原序：会话 #1 就是第一条会话；
      // 全量表仍用置顶排序）
      rows: rows.map((r, order) => ({ ...r, order }))
        .sort((a, b) => ROW_RANK[a.outcome] - ROW_RANK[b.outcome]),
      failed: rows.filter((r) => r.outcome === "fail").length,
      detail: matched ?? null,
    };
  });
}

// ---------- 本次建议（ADR-0014 第 6 条） ----------
//
// 为什么在前端自聚合（调度会话已查证）：strands SDK 没有可用的 recommend 包 ——
// `DiagnosisResult.recommendations` 只是 root_causes[].fix_recommendation 的
// strip+全等去重 property；Experiment 路线把它拍平成分号串。所以这里自聚合，
// 但**去重规则照抄 SDK**（strip 后全等）。数据源 = 本次 run 全量表各行的
// diagnosis.rootCauses（红队行无诊断天然缺席）；纯前端聚合，不发 LLM 调用。

/** 一条建议：同一修法（strip 后全等）合并多行的支持证据。 */
export interface AdviceEntry {
  /** 修法文本（fix_recommendation 原话，条目主体；也是去重键） */
  fix: string;
  /** SYSTEM_PROMPT_FIX | TOOL_DESCRIPTION_FIX | 其他（未知值归 OTHERS 组但原词保留；
   *  同一修法跨行 fix_type 不一致时取首见 —— SDK 的去重本来只看修法文本） */
  fixType: string;
  /** 根因解释（多行去重罗列，最多 3 条；条目至少有 1 条 —— 见 adviceGroups 注释） */
  explanations: string[];
  /** 引用：支持它的行（环节下标 + 行 key + 行名），点击跳全量表那一行。
   *  同一行的多条同修法根因只记一次引用（引用数 = 覆盖的**行**数）。 */
  refs: AdviceRef[];
}
export interface AdviceRef {
  groupIndex: number;
  rowKey: string;
  rowName: string;
}

/** fix_type 三组（ADR-0014 第 6 条）；空组整组不出（含组头）。 */
export interface AdviceGroup {
  fixType: "SYSTEM_PROMPT_FIX" | "TOOL_DESCRIPTION_FIX" | "OTHERS";
  label: string;
  entries: AdviceEntry[];
}

/** SDK RCAItem.fix_type 两个具名值之外（含空串/瞎编值）一律归 OTHERS 组。 */
function adviceBucket(fixType: string): AdviceGroup["fixType"] {
  if (fixType === "SYSTEM_PROMPT_FIX" || fixType === "TOOL_DESCRIPTION_FIX") return fixType;
  return "OTHERS";
}

/** 组序固定（ADR-0014 §6 的三组）；名字自解释，不配解释句。 */
const ADVICE_GROUP_DEFS: { fixType: AdviceGroup["fixType"]; label: string }[] = [
  { fixType: "SYSTEM_PROMPT_FIX", label: "改系统提示词" },
  { fixType: "TOOL_DESCRIPTION_FIX", label: "改工具描述" },
  { fixType: "OTHERS", label: "其他" },
];

/**
 * 聚合：全量表各行的诊断根因 → 按修法去重合并 → 按 fix_type 分三组 →
 * 组内按引用行数降序（覆盖失败多的在前；平局保持首见序 —— sort 稳定）。
 *
 * 一条根因要产/支持条目，修法与根因解释**都**得非空（diagnosisOf 已 strip）：
 *   · 修法空 → 没有可采纳的动作，**无引用不上屏**的钉就钉在这（结构上每条
 *     必然来自某行，但空修法的根因不产条目）；
 *   · 根因解释空 → ADR-0014 §6「每条 = 具体修法 + **根因理由** + 引用」三件
 *     缺一不上屏。root_cause_explanation 是 B1 新键 —— 这一条同时让旧形状 run
 *     （有 fix_recommendation、无解释）整个建议区天然缺席，与全量表诊断块的
 *     降级方向一致（不拿 causality 枚举词顶替根因文本）。
 */
export function adviceGroups(groups: ReportGroup[]): AdviceGroup[] {
  const byFix = new Map<string, AdviceEntry>();
  const order: AdviceEntry[] = [];
  for (const g of groups) {
    for (const row of g.rows) {
      if (!row.diagnosis) continue;
      const seenInRow = new Set<string>();
      for (const rc of row.diagnosis.rootCauses) {
        if (rc.fix === "" || rc.explanation === "") continue;
        let entry = byFix.get(rc.fix);
        if (!entry) {
          entry = { fix: rc.fix, fixType: rc.fixType, explanations: [], refs: [] };
          byFix.set(rc.fix, entry);
          order.push(entry);
        }
        if (entry.explanations.length < 3 && !entry.explanations.includes(rc.explanation)) {
          entry.explanations.push(rc.explanation);
        }
        if (!seenInRow.has(rc.fix)) {
          seenInRow.add(rc.fix);
          entry.refs.push({ groupIndex: g.index, rowKey: row.key, rowName: row.name });
        }
      }
    }
  }
  return ADVICE_GROUP_DEFS
    .map(({ fixType, label }) => ({
      fixType,
      label,
      entries: order
        .filter((e) => adviceBucket(e.fixType) === fixType)
        .sort((a, b) => b.refs.length - a.refs.length),
    }))
    .filter((g) => g.entries.length > 0);
}

// ---------- 裁决句 ----------

export interface RunVerdict {
  text: string;
  /** ok=全部过线（绿）；bad=列了失败（红）；neutral=非终态/无可评估数据 */
  tone: "ok" | "bad" | "neutral";
}

/**
 * 裁决句：只列本次没过的东西，数字现算自行级 passed/breached/errored——
 * 不比上次、不分档（ADR-0014 第 2/3 条）。
 *
 * 段序：环节执行失败 → 红队被攻破 → 回归没过 → 线上不过线 → 没跑成。
 * 全过 = 「全部过线」；空 run 沿用「完成 · 无可评估数据」（outcome.label 原话）；
 * 非终态（running/skipped/error）走 run 级 STATUS 投影（outcome.kind === "status"），
 * skipped 带 skip_reason 原话。
 *
 * 降级（rows 缺失的环节：老 run / report_error 通路只有 DDB 摘要）：改用摘要
 * 聚合数字判——红队 breached/attacks、回归 pass_rate；线上摘要说不出「哪几个
 * 会话」，只能说「有评估器不过线」（summary 里任一评估器 pass_rate < 1）。
 */
export function runVerdict(input: {
  outcome: RunOutcome;
  groups: ReportGroup[];
  skipReason?: string | null;
}): RunVerdict {
  const { outcome, groups } = input;
  if (outcome.kind === "status") {
    const skip = textOf(input.skipReason).trim();
    return { text: skip ? `${outcome.label} · ${skip}` : outcome.label || "—", tone: "neutral" };
  }
  if (outcome.kind === "nodata") return { text: outcome.label, tone: "neutral" };

  const segs: string[] = [];
  if (outcome.failedStages.length > 0) {
    segs.push(`${outcome.failedStages.join(" · ")}环节执行失败`);
  }

  let dsFail = 0;
  let dsJudged = 0;
  let hasDs = false;
  let obFail = 0;
  let rtBreached = 0;
  let rtTotal = 0;
  let none = 0;
  const fallback: string[] = [];
  for (const g of groups) {
    if (g.rows.length > 0) {
      for (const r of g.rows) {
        if (r.outcome === "none") none += 1;
        if (g.type === "dataset") {
          hasDs = true;
          if (r.outcome !== "none") {
            dsJudged += 1;
            if (r.outcome === "fail") dsFail += 1;
          }
        } else if (g.type === "observe") {
          if (r.outcome === "fail") obFail += 1;
        } else if (g.type === "redteam") {
          rtTotal += 1;
          if (r.breached === true) rtBreached += 1;
        }
      }
      continue;
    }
    // 摘要退路：只对正常跑完的环节判（failed 已由环节执行失败段说了；
    // empty/stopped 的半截数字不是结论）
    if (stageKind(g.stage) !== "normal") continue;
    if (g.type === "redteam") {
      const breached = g.stage.breached ?? 0;
      const attacks = g.stage.attacks ?? 0;
      if (breached > 0) fallback.push(`红队被攻破 ${breached}/${attacks}`);
    } else if (g.type === "dataset") {
      const rate = g.stage.pass_rate;
      if (typeof rate === "number" && rate < 1) {
        fallback.push(`回归通过率 ${fmtPctInt(rate)}`);
      }
    } else if (g.type === "observe") {
      const sum = g.stage.summary;
      const anyFail = sum && typeof sum === "object"
        && Object.values(sum).some((s) => typeof s?.pass_rate === "number" && s.pass_rate < 1);
      if (anyFail) fallback.push("线上有评估器不过线");
    }
  }

  if (rtBreached > 0) segs.push(`红队被攻破 ${rtBreached}/${rtTotal}`);
  if (hasDs && dsFail > 0) segs.push(`回归 ${dsFail}/${dsJudged} 没过`);
  if (obFail > 0) segs.push(`线上 ${obFail} 会话有评估器不过线`);
  segs.push(...fallback);
  if (none > 0) segs.push(`${none} 条没跑成`);

  if (segs.length === 0) return { text: "全部过线", tone: "ok" };
  return { text: segs.join(" · "), tone: "bad" };
}

// ---------- 报告页（变体 A「评估器优先」，批 report-redesign-a）的追加派生 ----------
//
// 决策口径（CONTEXT.md「线上评估均分」词条 2026-09-03 修订）：看**每个评估器**过不过
// 0.70 目标线，不看多个评估器的合成均值。所以这一层的单位是「评估器 tile」与
// 「行 × 评估器 格」，run 级合成分只作副行小字。全部纯函数，渲染在 pages/report/。

/** 会话行（observe）从 S3 明细里多带出来的会话指标（app/metrics.py
 *  compute_session_metrics：每组都是对象）。dataset / 红队行恒 null。 */
export interface RowMetrics {
  tokens: number | null;
  llmCalls: number | null;
  toolCalls: number | null;
  /** 轮次最大 / 平均时延（秒）；后端 latency.max_s / avg_s，缺 → null */
  latencyMax: number | null;
  latencyAvg: number | null;
}

/** 一个评估器在一个环节里的 tile（变体 A 的评估器维度）。
 *  mean/passRate 优先取后端环节摘要（observe `summary[name].mean_score` / dataset
 *  `evaluator_stats[name].mean`），缺了才从行现算；计数（通过/有效/报错/最差行）
 *  一律从行现算 —— 摘要没有「谁最差」。 */
export interface EvaluatorTile {
  name: string;
  /** 均分；null = 一条有效判定都没有（不显示 0） */
  mean: number | null;
  /** 通过率 0..1；null 同上 */
  passRate: number | null;
  passed: number;
  /** 有效判定数（剔 errored） */
  judged: number;
  errored: number;
  /** 未过线 = mean 有数且 < 目标线（mean 为 null 的不判：没评出来 ≠ 未过线） */
  under: boolean;
  /** 得分最低的行（并列全列；无有效判定 → 空数组） */
  worst: { rowKey: string; rowName: string; score: number }[];
}

/** transcript.events（app/transcript.py：{n,type:user|assistant|tool,text,…}）→
 *  首条用户输入 + 末条 assistant 文本。非数组 / 缺 text → 空串（不代编）。 */
export function transcriptTexts(transcript: unknown): { input: string; reply: string } {
  const t = (transcript ?? {}) as { events?: unknown };
  const events = Array.isArray(t.events) ? t.events : [];
  let input = "";
  let reply = "";
  for (const raw of events) {
    const e = (raw ?? {}) as { type?: unknown; text?: unknown };
    const text = textOf(e.text);
    if (!text) continue;
    if (e.type === "user" && !input) input = text;
    else if (e.type === "assistant") reply = text;
  }
  return { input, reply };
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 会话 metrics → 展示投影。非对象 → null（session_error 支整键缺；
 *  metric_keys 未配也为 null）；五个数全缺也 null（别画一排「—」）。 */
export function rowMetricsOf(metrics: unknown): RowMetrics | null {
  if (!metrics || typeof metrics !== "object") return null;
  const m = metrics as Record<string, Record<string, unknown> | undefined>;
  const out: RowMetrics = {
    tokens: finiteOrNull(m.tokens?.total),
    llmCalls: finiteOrNull(m.llm_calls?.count),
    toolCalls: finiteOrNull(m.tool_calls?.count),
    latencyMax: finiteOrNull(m.latency?.max_s),
    latencyAvg: finiteOrNull(m.latency?.avg_s),
  };
  if (Object.values(out).every((v) => v == null)) return null;
  return out;
}

/** 环节聚合指标（planrun.py:_run_observe_stage 的 `metrics` =
 *  metrics.aggregate_agent_metrics；metric_keys 未配 → None → null）。 */
export interface StageMetrics {
  tokensTotal: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costUsd: number | null;
  unpricedModels: string[];
  llmCalls: number | null;
  toolCalls: number | null;
  latencyAvg: number | null;
  latencyMax: number | null;
}

export function stageMetricsOf(stage: StageSummary | null | undefined): StageMetrics | null {
  const raw = (stage as { metrics?: unknown } | null | undefined)?.metrics;
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, Record<string, unknown> | undefined>;
  const unpricedRaw = m.cost?.unpriced_models;
  const unpriced = Array.isArray(unpricedRaw)
    ? unpricedRaw.filter((x): x is string => typeof x === "string")
    : [];
  return {
    tokensTotal: finiteOrNull(m.tokens?.total),
    tokensInput: finiteOrNull(m.tokens?.input),
    tokensOutput: finiteOrNull(m.tokens?.output),
    costUsd: finiteOrNull(m.cost?.usd),
    unpricedModels: unpriced,
    llmCalls: finiteOrNull(m.llm_calls?.count),
    toolCalls: finiteOrNull(m.tool_calls?.count),
    latencyAvg: finiteOrNull(m.latency?.avg_s),
    latencyMax: finiteOrNull(m.latency?.max_s),
  };
}

/** 环节里的评估器名单：配置原序 + 摘要 / 行判定里多出来的追加（与 derive.evaluatorRows /
 *  observeEvaluatorRows 同一条「配了但一条判定都没有的留名」语义）。红队环节没有
 *  评估器列 → 空数组（它的格是 攻破/守住/无结论）。 */
export function groupEvaluatorNames(group: ReportGroup): string[] {
  if (group.type === "redteam") return [];
  const names: string[] = [];
  const push = (n: unknown) => { if (typeof n === "string" && n && !names.includes(n)) names.push(n); };
  for (const n of group.stage.evaluators ?? []) push(n);
  const fromSummary = group.type === "observe"
    ? Object.keys(group.stage.summary ?? {})
    : Object.keys(group.stage.evaluator_stats ?? {});
  for (const n of fromSummary) push(n);
  for (const r of group.rows) for (const v of r.verdicts) push(v.name);
  return names;
}

/** 评估器 tile（变体 A ⑤）。目标线 = derive.SCORE_TARGET（全站唯一那条 0.70）。 */
export function evaluatorTiles(group: ReportGroup): EvaluatorTile[] {
  return groupEvaluatorNames(group).map((name) => {
    let passed = 0;
    let judged = 0;
    let errored = 0;
    let sum = 0;
    let min = Infinity;
    const worst: EvaluatorTile["worst"] = [];
    for (const r of group.rows) {
      const v = r.verdicts.find((x) => x.name === name);
      if (!v) continue;
      if (v.errored) { errored += 1; continue; }
      if (typeof v.score !== "number") continue;
      judged += 1;
      sum += v.score;
      if (v.passed === true) passed += 1;
      if (v.score < min) { min = v.score; worst.length = 0; }
      if (v.score === min) worst.push({ rowKey: r.key, rowName: r.name, score: v.score });
    }
    // 摘要里的均分 / 通过率优先（后端 round 过的那份，与列表页同数）
    const obs = group.type === "observe" ? group.stage.summary?.[name] : undefined;
    const ds = group.type === "dataset" ? group.stage.evaluator_stats?.[name] : undefined;
    const meanFromSummary = typeof obs?.mean_score === "number" ? obs.mean_score
      : typeof ds?.mean === "number" ? ds.mean : null;
    const mean = meanFromSummary ?? (judged > 0 ? sum / judged : null);
    const rateFromSummary = typeof obs?.pass_rate === "number" ? obs.pass_rate : null;
    const passRate = rateFromSummary ?? (judged > 0 ? passed / judged : null);
    return {
      name, mean, passRate, passed, judged, errored,
      under: mean != null && mean < SCORE_TARGET,
      worst,
    };
  });
}

/** 结论一句（变体 A ②）的事实料：最差评估器 = 均分最低的那一个（有均分者中取最小）。
 *  under = 未过线名单；allPass 只在「至少一个有均分且全部过线」时为 true。 */
export interface EvaluatorVerdictFacts {
  under: EvaluatorTile[];
  worst: EvaluatorTile | null;
  allPass: boolean;
  /** 有均分的 tile 里最低的均分（全过时给「最低 X」） */
  minMean: number | null;
}

export function evaluatorVerdictFacts(tiles: EvaluatorTile[]): EvaluatorVerdictFacts {
  const scored = tiles.filter((t) => t.mean != null);
  const under = scored.filter((t) => t.under);
  let worst: EvaluatorTile | null = null;
  for (const t of scored) if (!worst || (t.mean as number) < (worst.mean as number)) worst = t;
  return {
    under,
    worst,
    allPass: scored.length > 0 && under.length === 0,
    minMean: worst?.mean ?? null,
  };
}

/** 会话 id 的短形式（首段 8 位 hex）。实现已搬到 **lib/text.ts** —— 消费方跨
 *  components/ 与 pages/ 两层，而 components/ 不许 import pages/（SynthesisText.tsx
 *  就是因此另写了一份 18 字截尾版，同一屏上两个短形式对不上）。口径一字未改，
 *  这里保留导出：本模块的十来个消费点（矩阵行 / tile / 裁决句 / hero / 台账 /
 *  拓扑 / 运行详情）都从报告行层拿这条口径，不必逐个改 import。 */
export { shortSessionId } from "../../lib/text";

/** 矩阵行锚点 id（问题条目证据深链 / tile 最差行 / 最大时延会话都跳这里）。
 *  行名可能含空格与标点（用例名），用 encodeURIComponent 保证是合法 id 片段。 */
export function matrixRowAnchor(groupIndex: number, rowName: string): string {
  return `rp-row-${groupIndex}-${encodeURIComponent(rowName)}`;
}

/** 证据引用 → 矩阵行：session 引用对 observe 行名（session_id）、case 引用对
 *  dataset 行名（用例名）。找不到 → null（不深链、只显示文本）。 */
export function evidenceRowOf(
  groups: ReportGroup[], ev: { kind: string; ref: string },
): { groupIndex: number; row: ReportRow } | null {
  for (const g of groups) {
    if (ev.kind === "session" && g.type !== "observe") continue;
    if (ev.kind === "case" && g.type !== "dataset") continue;
    const row = g.rows.find((r) => r.name === ev.ref);
    if (row) return { groupIndex: g.index, row };
  }
  return null;
}
