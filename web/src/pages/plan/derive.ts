// 纯推导函数：KPI / 趋势数据都从 list_plan_runs 的 runs 推，不多打接口。
// 成功口径 / badge / 格式化 / 时间解析收敛到 lib/scoring.ts（ADR-0003）。
import {
  effectiveScore, fmtDuration, fmtPctInt, fmtScore, isRunSuccess, isScored, toMillis,
  STAGE_LABEL, STATUS_LABEL,
} from "../../lib/scoring";
// 「后端任意形态 → 可渲染文本」只留一处实现（UI-026 白屏事故的产物）。
// 刻意 import 而非在 plan/ 侧再建一份同型件：那一层的价值全在「唯一」——
// 复制出第二份就等于给下一次 React #31 留一个没人记得同步的兜底。
// renderText.ts 是纯函数、无 React、无 run 页耦合——跨页消费成事实后已搬进 lib/。
import { textOf, EMPTY_MARK } from "../../lib/renderText";
// 数据集侧别（UI 四类/存储三类的双读规则）：D-5 的环节展示名靠它判「模拟侧」，
// 与方案编辑器分回归卡/模拟卡是**同一个**判定件（lib/datasetSide）。
import { isSimulationSide } from "../../lib/datasetSide";
import type {
  AdoptionNote, CaseResult, DatasetLite, ObserveSessionDetail, PlanRunDetail,
  PlanRunProgress, PlanRunSummary, PlanStage, SessionDiagnosis, StageDetail,
  StageSummary,
} from "./types";

/**
 * run 报告（run_plan 终帧 / get_plan_run）的综合分。
 *
 * 顶层 `score` 优先（planrun.py:_run_from_item 由 observe 环节均分算出），
 * 退回从环节摘要里的 observe `overall_mean` 现推。**不读 `overview.score`**
 * ——真后端 overview 只有 stage_lines / previous_run / adoption_note，
 * 那个键是 mock 幻觉，照它写的「运行完成 · 总分 X」线上永不显示。
 *
 * 口径同 ADR-0003 与 bigscreen/derive.ts scoreOf：只认 completed 且有分的
 * observe 环节；一个都没有就返回 null（由调用方显示「—」或整段不画），
 * 绝不用 0 或其它环节的分数冒充总分。
 */
export function reportScore(d: PlanRunDetail | null | undefined): number | null {
  if (typeof d?.score === "number") return d.score;
  const means = reportStages(d)
    .filter((s) => s.type === "observe" && s.status === "completed"
      && typeof s.overall_mean === "number")
    .map((s) => s.overall_mean as number);
  if (means.length) return means.reduce((a, b) => a + b, 0) / means.length;
  return null;
}

/** run 报告里的环节数组：三条数据通路（终帧 stages / DDB stage_summaries /
 *  S3 report.stages）。**只读一个键**是上周整页白屏的根因，消费方一律走这里。 */
export function reportStages(d: PlanRunDetail | null | undefined): StageSummary[] {
  return d?.stages ?? d?.stage_summaries ?? d?.report?.stages ?? [];
}

// ---------- 环节文案（抽屉渲染与导出共用，保证两处口径一字不差） ----------

// 环节展示名不在这里定义，也不从这里转出：唯一权威是 lib/scoring.STAGE_LABEL
// （ADR-0003）。本文件的 reportDrilldowns 从那里 import 来用，其它消费方同理。

/** 契约兼容：字段可能是数字（DDB stage_summaries）或数组（S3 全量 stages 的
    sessions/entries）——两条数据通路都要能读出计数 */
function countOf(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v.length;
  return null;
}

function breachedFromEntries(stage: StageSummary): number | null {
  const entries = stage.entries;
  if (!Array.isArray(entries)) return null;
  return entries.filter((e) => (e as { breached?: boolean }).breached).length;
}

/** 目标线 / 「拖分」阈值：原型 chart 语义的那条 0.7（trendCard 的 TREND_TARGET
 *  与环节 warn 判定同一条线，收敛成一个常量，别再各处手写 0.7）。
 *  纯显示强调用，不参与 run 终态判定（那在 lib/scoring.ts）。 */
export const SCORE_TARGET = 0.7;

export function isWarnStage(stage: StageSummary): boolean {
  if (stage.type === "redteam") {
    const breached = stage.breached ?? breachedFromEntries(stage);
    return (breached ?? 0) > 0;
  }
  const s = typeof stage.score === "number" ? stage.score
    : typeof stage.overall_mean === "number" ? stage.overall_mean : null;
  return s != null && s < SCORE_TARGET;
}

/** 关键数字（mono）：契约给什么就摆什么——mock/终帧带 score/cases/passed，
    真 get_plan_run 的 stage_summaries 带 sessions/overall_mean/pass_rate/breached。
    后端没给的数字**绝不推算**（例如只有 pass_rate 时不反推「通过 X/Y」）。

    ⚠️ 度量词带限定词「本环节均分」（CONTEXT.md:93-96 的白名单叫法）：这里的数
    是**这一个环节**的均分，与 run 级的「线上评估均分」、逐评估器表里的
    「评估器均分」在同一屏上共存 —— 裸词「均分」分不出是哪一个（也会被读成
    回归通过率）。这个串同时出现在抽屉环节行与导出的环节一行上。 */
export function stageNumbers(stage: StageSummary): string {
  const parts: string[] = [];
  if (stage.type === "observe") {
    const n = countOf(stage.sessions) ?? countOf(stage.cases);
    if (n != null) parts.push(`${n} 会话`);
    const mean = typeof stage.overall_mean === "number" ? stage.overall_mean
      : typeof stage.score === "number" ? stage.score : null;
    if (mean != null) parts.push(`本环节均分 ${mean.toFixed(2)}`);
  } else if (stage.type === "dataset") {
    const cases = countOf(stage.cases) ?? countOf(stage.entries);
    if (stage.passed != null && cases != null) parts.push(`通过 ${stage.passed}/${cases}`);
    else if (typeof stage.pass_rate === "number") parts.push(`通过率 ${fmtPctInt(stage.pass_rate)}`);
    else if (cases != null) parts.push(`${cases} 用例`);
    if (typeof stage.score === "number") parts.push(`本环节均分 ${stage.score.toFixed(2)}`);
  } else if (stage.type === "redteam") {
    const breached = stage.breached ?? breachedFromEntries(stage);
    const attacks = stage.attacks ?? countOf(stage.entries) ?? countOf(stage.cases);
    if (breached != null || attacks != null) {
      parts.push(`攻破 ${breached ?? 0}/${attacks ?? 0}`);
    } else if (typeof stage.score === "number") {
      parts.push(`本环节均分 ${stage.score.toFixed(2)}`);
    }
  } else if (typeof stage.score === "number") {
    parts.push(fmtScore(stage.score));
  }
  // 一个数字都没有 → EMPTY_MARK（「没有」要看得见）。流式环节行按这个记号
  // 判「整段括号不出」（useRunPlan.stageDoneTail），所以这里必须是那个常量
  // 而不是手写的破折号字面量。
  return parts.join(" · ") || EMPTY_MARK;
}

/**
 * 环节的**展示分档**（报告抽屉的环节分类行与导出的环节一行同一份判据）。
 *
 * 四档，顺序即判定优先级，**不可调换**：
 *   empty   —— status=empty：执行成功但没东西可评（observe 回溯窗口内没有会话，
 *              planrun.py:139）。它也带 error 文本（「最近 30 天没有可评估的
 *              会话」），所以必须第一个出局，否则会被判成执行失败。
 *   stopped —— status=stopped：**用户自己**按的停止（app/testrun.py:48
 *              STOP_STATUS，说明文本由 `_stop_note` 写在 error 上）。同样必须
 *              先于 failed —— 它带 error 文本，落进失败档就会被印成猩红的
 *              「执行失败」，而 lib/scoring.ts 对 stopped 是**刻意**的 warn 琥珀
 *              （statusBadgeClass:383「已停止」）：同一次运行 run 级琥珀、
 *              环节行猩红，是同屏两个口径。
 *   failed  —— status=error，或带 error 文本（含 halted_cost 成本熔断：它落
 *              失败侧，见 scoring.isStageFailed 的注释）。
 *   normal  —— 其余：照常显示数字与配置元信息。
 *
 * ⚠️ 这是**展示分档**，不是 run 终态判定。run 级口径在 lib/scoring.ts
 * （isStageFailed / runOutcome，服务「成功运行数」与结果 badge），一行未动 ——
 * 两处问题域不同：那边答「这次运行算不算成功」，这里答「这一行显示什么颜色、
 * 什么原话」。stopped 的 run 级正确性来自 run.status（runOutcome 对非
 * completed 直接走 status 分支），坏的只是环节行这一层。
 */
export type StageKind = "empty" | "stopped" | "failed" | "normal";

/** 环节状态 stopped 的取值来源：app/testrun.py:48 `STOP_STATUS = "stopped"`
 *  （planrun / redteam 都从那里取，前端 lib/scoring.ts STATUS_LABEL 有对应中文）。 */
const STAGE_STOPPED = "stopped";

export function stageKind(stage: StageSummary): StageKind {
  if (stage.status === "empty") return "empty";
  if (stage.status === STAGE_STOPPED) return "stopped";
  if (stage.status === "error" || Boolean(stage.error)) return "failed";
  return "normal";
}

/** 每档在「关键数字」位上的替代词（normal 那档摆数字，见 stageNumbers）。
 *  empty/stopped 不摆数字是刻意的：停止/无数据环节的半截数字不是结论
 *  （与后端 planrun.py:_fmt_stage_line 的 halted_cost / STOP_STATUS 分支同一条
 *  纪律）。**failed 那档保留数字**——UI-025 批次的既有行为，红队失败行上的
 *  「攻破 0/0」是现场信息，注记里另有原话。 */
export const STAGE_KIND_TEXT: Record<StageKind, string> = {
  empty: "无数据",
  // 与 run 级同词（scoring.STATUS_LABEL.stopped / planrun.py:597），不写第二份字面量
  stopped: STATUS_LABEL[STAGE_STOPPED],
  failed: "执行失败",
  normal: "",
};

/**
 * 环节注记（抽屉右侧灰字 / 导出括号里的原话，**同一份**来源）。
 *
 * 按档取源：
 *   empty   → 后端给的「为什么没有数据」原话（没给就留空——绝不拿 dataset 名
 *             冒充原因）；
 *   stopped → 停止说明原话；后端没给时退到与 planrun.py:996 `_fmt_stage_line`
 *             的 STOP_STATUS 分支逐字同款的兜底句（status 单独一个人说不了话）；
 *   failed  → 失败原因原话，**有就优先于配置元信息**（这行的信息量在原因）；
 *             没有原话才退到「数据集 · 评估器」—— UI-025 实拍：后端失败摘要里
 *             正好没有 dataset/evaluators，注记算成空串，下方警示条
 *             「失败原因见上方环节列表」指向一个空位；
 *   normal  → 数据集 · 评估器。
 * 原因一律按后端原话显示，不加「可能」类修饰。
 */
export function stageNote(stage: StageSummary): string {
  const reason = stage.error ?? stage.skip_reason ?? "";
  const meta = [stage.dataset ?? stage.cases_dataset, (stage.evaluators ?? []).join(" · ")]
    .filter(Boolean).join(" · ");
  switch (stageKind(stage)) {
    case "empty": return reason;
    case "stopped": return reason || "已按用户请求停止，本环节未跑完";
    case "failed": return reason || meta;
    default: return meta;
  }
}

// ---------- 环节展示名的「模拟侧」投影（D-5 止血版 = 决策文档的选项 2） ----------
//
// 存储层只有三类 type（ADR-0001），「模拟测试」是 UI 概念：方案编辑器有四类卡
// （PlanEditor.STAGE_UI_LABEL，按数据集侧别区分回归卡/模拟卡），而结果侧一律
// 三类映射 → 用户用模拟集配好的环节，在运行页/历史/抽屉/导出/大屏里都被叫成
// 「回归测试」，历史里分不出跑的是固定数据集还是多轮扮演。
//
// 止血版只在**有方案定义在手**的地方改（报告抽屉）：环节摘要本身不带数据集
// 侧别（`stage_summaries` 没有 dataset kind，后端补字段是选项 1 的活）。
// ⚠️ 已知代价：导出 Markdown（exportReport.ts，本批白名单外）仍写「回归测试」，
// 所以模拟侧环节在屏幕与导出里会显示不同名字。收敛归 D-5 选项 1 / D-6。

/** 「模拟测试」= UI 四类里的第四类。**不是新词**：唯一权威是
 *  PlanEditor.STAGE_UI_LABEL.simulation（CONTEXT.md:70-75 的住所），这里是
 *  结果侧的手写副本 —— 两者一致由 tests/d-display-terms.test.tsx 钉住
 *  （那条断言两边一个 import 一个字面量，收敛到一处归 D-6）。 */
export const SIMULATION_STAGE_LABEL = "模拟测试";

/** 判侧别需要的两样东西。两个都可缺 —— 缺了就退回三类映射（列表页口径），
 *  **绝不猜**：把固定集的环节叫成「模拟测试」比不改更糟。 */
export interface StageLabelCtx {
  /** 方案定义的环节（run 是照方案定义逐环节跑的，所以同序可比） */
  planStages?: PlanStage[];
  /** 资源库数据集名单（侧别判定走 lib/datasetSide 的双读规则） */
  datasets?: DatasetLite[];
}

/**
 * 这个环节指向哪个数据集。
 *
 * 取值顺序：
 *   1. **run 自己**报告体里的名字（S3 `report.dataset` / 环节 `dataset`）——
 *      那是这一次真跑的集合，方案后来被改过也不会说错；
 *      （DDB `stage_summaries` 从不写这个键：现网 63 份 run 零命中，
 *       见 stageDatasetName 的注释，所以下面这两步是常态路径）
 *   2. 方案定义的**同位**环节（同下标且同 type）；
 *   3. 方案里该 type **只有一个**环节时按它算 —— 环节顺序变过也不会错配；
 *      同类型有多个且不同位就返回空（宁可显示三类映射，也不把 A 的名字挂给 B）。
 */
function stageDatasetFor(
  stage: StageSummary | StageDetail, index: number, ctx: StageLabelCtx,
): string {
  const own = textOf(
    (stage as StageDetail).report?.dataset ?? stage.dataset ?? stage.cases_dataset,
  ).trim();
  if (own) return own;
  const plan = ctx.planStages ?? [];
  const at = plan[index];
  if (at && at.type === stage.type) return textOf(at.dataset).trim();
  const same = plan.filter((s) => s.type === stage.type);
  return same.length === 1 ? textOf(same[0].dataset).trim() : "";
}

/** 环节展示名（D-5）：dataset + 模拟侧集合 → 「模拟测试」，其余一律走
 *  lib/scoring.STAGE_LABEL（术语五词，存储三类）。 */
export function stageDisplayLabel(
  stage: StageSummary | StageDetail, index: number, ctx: StageLabelCtx,
): string {
  const base = STAGE_LABEL[stage.type ?? ""] ?? stage.type ?? "环节";
  if (stage.type !== "dataset") return base;
  const datasets = ctx.datasets ?? [];
  if (datasets.length === 0) return base; // 名单没到齐 = 不判
  const name = stageDatasetFor(stage, index, ctx);
  if (!name) return base;
  const ds = datasets.find((d) => d.name === name);
  if (!ds) return base;                   // 集合已删/改名 = 不判
  return isSimulationSide(ds) ? SIMULATION_STAGE_LABEL : base;
}

// ---------- 逐评估器指标（回归环节，2026-08 additive 字段的唯一消费入口） ----------

/** 一行 = 一个评估器在这一环节里的成绩。`name` 是**注册名原文**（资源库里
 *  用户可选的评估器 id，如 harmfulness / instruction_following）——不翻译。
 *  `mean` 为 null = 一条有效判定都没有（全被 judge 限流等），显示侧走中性文案，
 *  **绝不**显示 0（0 是「评了且很差」）。`judged` 是分母（判定数，非用例数）。 */
export interface EvaluatorRow {
  name: string;
  mean: number | null;
  passed: number;
  judged: number;
}

/**
 * 回归环节的逐评估器行（报告抽屉 / 单次报告共用，两处口径一字不差）。
 *
 * 数据源是后端 `_stage_summary` dataset 分支的两个字段（planrun.py:973-975）：
 *   evaluators      = 环节**配了什么**（配置回显）
 *   evaluator_stats = **谁评出了什么**（{name: {mean, passed, judged}}）
 * 只有 dataset 分支带这两个键，observe/redteam 的摘要形状未动。
 *
 * 三条硬语义（与后端 _evaluator_stats:910-939 的注释同源）：
 *  1) **老 run 没有 evaluator_stats 键** → 返回空数组（不画），绝不用 0/NaN
 *     冒充；`evaluators` 单独存在也不编造 stats。
 *  2) **配了但一条判定都没有的评估器留名**（judged=0 / mean=null）：让它从表里
 *     消失会被读成「它评过且没问题」，而事实是一条判定都没有。
 *  3) 顺序照 evaluators 原序（用户在编辑器里配的顺序），stats 里多出来的名字
 *     追加在后——「stats 里少/多一个名字」本身就是要透出的信息。
 *
 * ⚠️ 这些均分**只服务于逐评估器展示**：绝不许在此聚合成一个 run 级分数
 * （ADR-0003 硬线，顶层 score 只由 observe 环节 overall_mean 写）。
 */
export function evaluatorRows(stage: StageSummary | null | undefined): EvaluatorRow[] {
  const stats = stage?.evaluator_stats;
  if (!stats || typeof stats !== "object") return [];
  const names: string[] = [];
  for (const n of stage?.evaluators ?? []) {
    if (typeof n === "string" && !names.includes(n)) names.push(n);
  }
  for (const n of Object.keys(stats)) {
    if (!names.includes(n)) names.push(n);
  }
  return names.map((name) => {
    const s = stats[name];
    return {
      name,
      mean: typeof s?.mean === "number" ? s.mean : null,
      passed: typeof s?.passed === "number" ? s.passed : 0,
      judged: typeof s?.judged === "number" ? s.judged : 0,
    };
  });
}

/** 线上评估环节的逐评估器行。与 EvaluatorRow **刻意不是同一个类型**：分母单位
 *  不同（会话数 vs 判定数），键名也不同（mean_score/pass_rate vs mean）——
 *  合成一个类型只会让某一侧的分母被另一侧的字段名悄悄顶替。
 *  `judged`/`errored` 为 null = 那一路没记分母（DDB 摘要那一份），显示侧说
 *  「分母未记录」，**绝不**拿环节的枚举会话数顶替。 */
export interface ObserveEvaluatorRow {
  name: string;
  mean: number | null;
  passRate: number | null;
  /** 判定数（分母）；null = 未记录 */
  judged: number | null;
  /** 未评出数（无内容会话 / 判分失败）；null = 未记录 */
  errored: number | null;
}

/**
 * 线上评估环节的逐评估器行（observe 侧的 evaluatorRows）。
 *
 * 为什么必须有这一半：一个 run 的线上评估均分是三四个评估器等权平均出来的，
 * 只印那个均分时「哪个评估器拉低了」在界面上无处可读 —— 用户原话「更重要的
 * 也要去看每个评估器它的分数，以及产生的原因」。数据后端一直在给
 * （observe.py:summarize 写 `summary`），前端此前零消费。
 *
 * 三条语义与 evaluatorRows 同刑：
 *  1) 缺 `summary` 键 → 空数组（不画），绝不用 0 冒充；
 *  2) `mean_score` 缺/非数 → null（「一条判定都没有」≠「评了 0 分」）；
 *  3) 名单顺序照 `evaluators` 原序，`summary` 里多出来的追加在后。
 */
export function observeEvaluatorRows(
  stage: StageSummary | null | undefined,
): ObserveEvaluatorRow[] {
  const sum = stage?.summary;
  if (!sum || typeof sum !== "object") return [];
  const names: string[] = [];
  for (const n of stage?.evaluators ?? []) {
    if (typeof n === "string" && !names.includes(n)) names.push(n);
  }
  for (const n of Object.keys(sum)) if (!names.includes(n)) names.push(n);
  return names.map((name) => {
    const s = sum[name];
    return {
      name,
      mean: typeof s?.mean_score === "number" ? s.mean_score : null,
      passRate: typeof s?.pass_rate === "number" ? s.pass_rate : null,
      judged: typeof s?.sessions === "number" ? s.sessions : null,
      errored: typeof s?.errored === "number" ? s.errored : null,
    };
  });
}

// ---------- 环节分析 + 逐用例明细（报告抽屉的「钻取」层） ----------
//
// 用户原话：「没法看到一个分数偏低，但是找不到哪个拉低了，之前是抽屉可看」。
// 这一层是 React 重写时丢掉的旧版能力 —— 数据后端一直在给，前端零消费：
// 全仓 `grep analysis` 在 pages/plan|run 下一次都没命中过。
//
// 数据源（2026-08-25 逐条实测现网 63 份 S3 归档）：
//   report.stages[i].report.analysis  —— dataset 环节 41/41 都有，1000-1500 字
//   report.stages[i].report.results[] —— 逐用例，单环节最多 10 行（191 行总量）
// 都在 **S3 报告体**里，DDB 摘要（stage_summaries）一个都没有。

/**
 * 「带明细的」环节数组。与 reportStages 的取键顺序**刻意相反**：
 *   reportStages       优先 d.stages（终帧/mock）→ stage_summaries → report.stages
 *   reportStageDetails 优先 d.report.stages（S3 全量）→ d.stages（终帧原物）
 * 因为真后端 get_plan_run 的 `stage_summaries` 是聚合摘要、**明细为零**，
 * 拿它去找 analysis/results 只会永远空手而回（那正是本能力「数据在、界面没有」
 * 的形态）。**不读** stage_summaries 这一路。
 *
 * 两个数组同序同长（`[_stage_summary(r) for r in stage_results]`，
 * planrun.py:1101），所以下标可与环节分类区的 report-drawer-stage-N 对齐。
 */
export function reportStageDetails(d: PlanRunDetail | null | undefined): StageDetail[] {
  return d?.report?.stages ?? d?.stages ?? [];
}

/** 环节分析原文：observe 直挂 `analysis`，dataset/redteam 在 `report.analysis`
 *  （取键顺序照后端 planrun.py:468 的 `_stage_analysis_excerpts`，一字不差）。
 *  归一成 string —— 后端这两处都没有统一 str() 兜。 */
export function stageAnalysis(stage: StageDetail | null | undefined): string {
  if (!stage) return "";
  const raw = stage.analysis ?? stage.report?.analysis;
  return textOf(raw).trim();
}

/** 数据集名：只认 S3 报告体里的（`report.dataset` → 环节自己的 `dataset`）。
 *  **绝不**从 DDB `stage_summaries` 取 —— `_stage_summary` 从不写这个键，
 *  现网 63 份 run 零命中（那是 mock 里的死字段，别让新代码依赖上）。 */
export function stageDatasetName(stage: StageDetail | null | undefined): string {
  if (!stage) return "";
  return textOf(stage.report?.dataset ?? stage.dataset).trim();
}

/** 一个评估器对一个用例的判定。`errored` 时 score/passed 为 null ——
 *  显示侧走中性「评估失败」，**绝不**显示 0（同 evaluatorRows 的 null 口径）。 */
export interface CaseVerdict {
  name: string;
  score: number | null;
  passed: boolean | null;
  errored: boolean;
  reason: string;
  /** 单条判定的档位名（SDK EvaluationOutput.label，B1 契约新增）。
   *  缺键/非字符串/errored = null → 显示侧不渲染 label 格（旧形状 run 的降级）。
   *  可选字段：compare/derive.ts 自建判定对象不带它，additive 不逼改。 */
  label?: string | null;
}

/** 这一行为什么没有判定。四档各有各的话（口径照 testrun.py 的四个早退分支），
 *  绝不合并成一句「失败」：责任方与下一步动作完全不同。 */
export type CaseNoteKind = "blank" | "agent_error" | "invoke_error" | "eval_error";

export interface CaseNote {
  kind: CaseNoteKind;
  /** 行尾标记（短） */
  mark: string;
  /** 后端原话（展开后全文显示） */
  text: string;
}

/** 一行 = 一个用例 × 一个 Agent（多 Agent run 里同名用例各占一行）。 */
export interface CaseRow {
  /** 稳定 key = 用例名@Agent 名，与分析里的 `[case:用例名@Agent名]` 引用同构 */
  key: string;
  name: string;
  agent: string;
  category: string;
  input: string;
  output: string;
  expected: string;
  verdicts: CaseVerdict[];
  note: CaseNote | null;
  /** 行上的诊断原物（testrun.py:1061 `entry["diagnosis"]`；低分用例才有）。
   *  可选：既有消费方（compare/ 的行料、旧测试夹具）不带它也合法。 */
  diagnosis?: SessionDiagnosis | null;
}

/** 判定字典 → 判定行。dataset 的用例行与 observe 的会话行共用（两侧的
 *  `results` 是同一个形状：{评估器名: CaseVerdictRaw}，errored 口径同源）。
 *  导出：reportRows.ts 的红队行也吃它（红队 results 同形状，redteam.py），
 *  「errored 的 score/passed 是 null 不是 0」这条口径只能有一处实现。 */
export function verdictsOf(vs: CaseResult["results"]): CaseVerdict[] {
  if (!vs || typeof vs !== "object") return [];
  return Object.keys(vs).map((name) => {
    const v = vs[name] ?? {};
    const errored = v.errored === true;
    return {
      name,
      // errored 的行后端已经写成 null；这里再挡一层非数字形态，
      // 免得 undefined/字符串被 toFixed 打翻整个抽屉
      score: !errored && typeof v.score === "number" ? v.score : null,
      passed: !errored && typeof v.passed === "boolean" ? v.passed : null,
      errored,
      reason: textOf(v.reason),
      // B1 契约新增：档位名。缺键（旧形状 run）/ 非字符串 / errored → null，
      // 显示侧整格不渲染 —— 绝不拿别的字段顶替
      label: !errored && typeof v.label === "string" && v.label !== "" ? v.label : null,
    };
  });
}

/** 空/错的四档判定（顺序照后端早退顺序，四支互斥）。 */
function noteOf(raw: CaseResult): CaseNote | null {
  const invoke = textOf(raw.error).trim();
  if (invoke) return { kind: "invoke_error", mark: "调用失败", text: invoke };
  if (raw.blank_output === true) {
    return {
      kind: "blank", mark: "空响应",
      // 限定词照 CONTEXT.md:93-96（裸「均分」不得单独出现）：这一句说的是
      // 这一个回归环节的均分与通过率——「本环节均分」
      text: textOf(raw.eval_skipped).trim()
        || "被测 Agent 返回空响应（0 字节，非报错）：无内容可判分，"
          + "本用例不计入本环节均分与通过率。",
    };
  }
  if (raw.error_output === true) {
    const summary = textOf(raw.error_summary).trim();
    const skipped = textOf(raw.eval_skipped).trim();
    return {
      kind: "agent_error", mark: "Agent 报错",
      text: [skipped, summary].filter(Boolean).join(" ")
        || "被测 Agent 返回的是其内部错误对象而非回答，无有效回答可判分。",
    };
  }
  const evalErr = textOf(raw.eval_error).trim();
  if (evalErr) return { kind: "eval_error", mark: "评估执行失败", text: evalErr };
  return null;
}

/**
 * 一个回归环节的逐用例明细行。
 *
 * 对**老 run 一样有效**：数据在 S3 报告体里，不依赖 2026-08 才加的
 * evaluator_stats（那个字段缺失时 evaluatorRows 整表不画，而这里照样有行）。
 * `results` 整键缺失的行（实测 31/191：空响应/Agent 报错/调用失败）保留在列表里
 * 并带标记 —— 让它消失会被读成「这个用例没问题」。
 */
export function caseRows(stage: StageDetail | null | undefined): CaseRow[] {
  const raws = stage?.report?.results;
  if (!Array.isArray(raws)) return [];
  return raws.map((raw, i) => {
    const r = (raw ?? {}) as CaseResult;
    const name = textOf(r.case).trim();
    const agent = textOf(r.agent).trim();
    return {
      // 用例名理论上可能重复/为空（后端不保证唯一）：补下标兜住 key 唯一
      key: `${name || `#${i + 1}`}@${agent}#${i}`,
      name: name || `用例 ${i + 1}`,
      agent,
      category: textOf(r.category).trim(),
      input: textOf(r.input),
      output: textOf(r.output),
      expected: textOf(r.expected_output),
      verdicts: verdictsOf(r.results),
      note: noteOf(r),
      diagnosis: r.diagnosis && typeof r.diagnosis === "object" ? r.diagnosis : null,
    };
  });
}

/** 一条线上评估会话为什么没有判定。两档，词与实时会话清单（ObserveSessionsPanel）
 *  和 run 对比（compare/derive.observeUnits 的 noteMark）**同一套**，不新造第二个说法：
 *    error      = trace 拉取失败（session_error 支，results 整键缺失）；
 *    no_content = trace 里没有消息内容（后端已把全部判定置 errored）。
 *  text 只放后端原话（error 原文 / no_content 的 warning）——warning 缺失就空着，
 *  绝不代后端编一句解释。 */
export interface SessionNote {
  kind: "error" | "no_content";
  mark: string;
  text: string;
}

/** 一行 = 线上评估环节的一个会话（observe 侧的 CaseRow 同位物）。 */
export interface SessionRow {
  /** 稳定 key：session_id 补下标兜底（后端不保证非空） */
  key: string;
  /** session_id 原文 —— 展示身份，也是分析里 [session:…] 引用的配对键 */
  id: string;
  agent: string;
  /** 后端截过的输出预览（evaluate_session 的 output_preview，前 300 字）。
   *  完整对话在运行详情页的会话时间线里，这里不搬 transcript（几十 KB 到几 MB）。 */
  output: string;
  verdicts: CaseVerdict[];
  note: SessionNote | null;
  /** 会话诊断原物（observe.evaluate_session 的 diagnosis 键；低分会话才有）。 */
  diagnosis?: SessionDiagnosis | null;
}

/**
 * 线上评估环节的逐会话明细行。
 *
 * 数据只在 S3 报告体（stage.session_details，planrun.py:_run_observe_stage 的
 * `details`）；DDB 摘要一条都没有 —— reportStageDetails 那条取键顺序保证读的是
 * 对的那份。session_error 支只有 {agent, session_id, error}，verdicts 天然为空。
 */
export function sessionRows(stage: StageDetail | null | undefined): SessionRow[] {
  const raws = stage?.session_details;
  if (!Array.isArray(raws)) return [];
  return raws.map((raw, i) => {
    const s = (raw ?? {}) as ObserveSessionDetail;
    const id = textOf(s.session_id).trim();
    const err = textOf(s.error).trim();
    const note: SessionNote | null = err
      ? { kind: "error", mark: "拉取失败", text: err }
      : s.no_content === true
        ? { kind: "no_content", mark: "无内容可评", text: textOf(s.warning).trim() }
        : null;
    return {
      key: `${id || `#${i + 1}`}#${i}`,
      id: id || `(未知会话)#${i + 1}`,
      agent: textOf(s.agent).trim(),
      output: textOf(s.output_preview),
      verdicts: verdictsOf(s.results),
      note,
      diagnosis: s.diagnosis && typeof s.diagnosis === "object" ? s.diagnosis : null,
    };
  });
}

/** 一个可钻取的环节（环节分析 + 明细行）。dataset 装 cases，observe 装 sessions ——
 *  另一侧恒为空数组，type 是消费方分派渲染/导出形态的唯一判据。 */
export interface StageDrilldown {
  /** 环节下标，与环节分类区 report-drawer-stage-N 同一编号 */
  index: number;
  type: "dataset" | "observe";
  /** 术语五词（STAGE_LABEL） */
  label: string;
  /** 数据集名（仅 dataset；observe 恒空串） */
  dataset: string;
  analysis: string;
  cases: CaseRow[];
  sessions: SessionRow[];
}

/**
 * 报告抽屉的钻取区数据：**回归环节**（dataset）与**线上评估环节**（observe）
 * 逐个一块。observe 那半是「更重要的也要去看每个评估器它的分数，以及产生的原因」
 * 落在报告页的形态：run 对比早就把逐会话判分理由摆出来了，报告页此前只有回归侧。
 * 红队环节仍不出块（它的逐攻击明细归 run 对比与运行详情页，本函数不揽）。
 *
 * 只在真有东西可看时出块（有分析 或 有明细行）—— 老环节/其它类型环节
 * 不画、不占位（`report_error` 那条通路整份 report 都没有，天然返回空数组）。
 * 环节 status 不做闸门：执行失败的环节也可能带 salvage 出来的
 * report.results（planrun.py:_run_dataset_stage 的 error 分支），那是用户
 * 已经付过钱的明细，不许因为环节红了就藏起来。
 */
export function reportDrilldowns(d: PlanRunDetail | null | undefined): StageDrilldown[] {
  const out: StageDrilldown[] = [];
  reportStageDetails(d).forEach((stage, index) => {
    const type = stage?.type;
    if (type !== "dataset" && type !== "observe") return;
    const analysis = stageAnalysis(stage);
    const cases = type === "dataset" ? caseRows(stage) : [];
    const sessions = type === "observe" ? sessionRows(stage) : [];
    if (!analysis && cases.length === 0 && sessions.length === 0) return;
    out.push({
      index,
      type,
      label: STAGE_LABEL[type] ?? type,
      dataset: type === "dataset" ? stageDatasetName(stage) : "",
      analysis,
      cases,
      sessions,
    });
  });
  return out;
}

// ---------- 改进处方：证据 / 采纳追踪 ----------

/**
 * 低分门槛：**与后端 app/improve.py 的 `LOW_SCORE` 同一个值**（后者注释里写明
 * 「same threshold as diagnosis.needs_diagnosis」）。
 *
 * 刻意不复用同文件的 SCORE_TARGET（也是 0.7）：那是**展示口径**的目标线（低于
 * 它染警示色），这里是**后端判据**的复制品。两者今天同值，语义不同源 —— 合并
 * 会让「后端把判据调成 0.6」这种改动在前端悄悄跟着展示口径走或反之。
 * 同值关系由 tests/improvement-proposals.test.tsx 对着 improve.py 现读对钉。
 */
export const PROPOSAL_LOW_SCORE = 0.7;

/** 送 propose_improvements 的请求料 + 「够不够格生成」的答案。 */
export interface ImprovementPayload {
  /**
   * 后端 `sessions` 入参：**全部** observe 会话明细（剥掉 transcript、补盖
   * agent 名）。刻意不在前端预筛 —— 筛选权在后端 collect_evidence，前端只送料；
   * 少送一条就等于替后端决定了证据面。
   */
  sessions: Record<string, unknown>[];
  /** 其中够格当证据的条数（判据 = app/improve.py:collect_evidence，逐条对齐）。
   *  0 = 后端一定会抛「没有可用于生成改进稿的证据」，所以按钮不该给。 */
  usable: number;
}

/** 一条会话明细够不够当证据（判据逐行照 app/improve.py:collect_evidence）：
 *  agent 不符 / trace 拉取失败 / 无可评估内容 → 出局；
 *  再要求「有低分判定」或「有 failures / root_causes」中至少一样。 */
function isEvidence(s: ObserveSessionDetail, agentName: string): boolean {
  if (textOf(s.agent).trim() !== agentName) return false;
  if (textOf(s.error).trim() !== "" || s.no_content === true) return false;
  const results = s.results ?? {};
  const hasLow = Object.keys(results).some((name) => {
    const r = results[name] ?? {};
    // errored 判定的 score 是 null（「没评出来」，不是 0 分）—— 后端同样先剔它
    if (r.errored) return false;
    return typeof r.score === "number" && r.score < PROPOSAL_LOW_SCORE;
  });
  const diag = s.diagnosis ?? {};
  const hasDiag = (diag.failures?.length ?? 0) > 0 || (diag.root_causes?.length ?? 0) > 0;
  return hasLow || hasDiag;
}

/**
 * 改进处方的证据料：**线上评估环节**（observe）的逐会话明细。
 *
 * 为什么只认 observe：后端该 action 的入参就叫 `sessions`，
 * collect_evidence 逐条读 `session_id`，而生成提示词（app/improve.py 的
 * `PROPOSAL_SYSTEM_PROMPT`）强制「每处修改的 why 必须落到具体 session_id 或
 * 故障类别」。回归环节的用例行虽然也带 diagnosis（planrun.py:_collect_root_causes
 * 就是这么捞根因的），但它没有 session_id —— 送过去只会让 why 引到一个 null。
 * 回归侧的处方是另一件事，等后端给 `cases` 入参再接。
 *
 * agent 名补盖：details 的 agent 键来自 observe.evaluate_session 的结果，
 * 缺失时后端首行 `s.get("agent") != agent_name` 会把整批剔光（旧版
 * ui/app.js 也是这么补的）。多 Agent 混跑不存在于方案运行（方案定死一个 agent）。
 */
export function improvementPayload(
  d: PlanRunDetail | null | undefined, agentName: string,
): ImprovementPayload {
  const name = (agentName ?? "").trim();
  const sessions: Record<string, unknown>[] = [];
  let usable = 0;
  for (const stage of reportStageDetails(d)) {
    if (stage?.type !== "observe") continue;
    for (const raw of stage.session_details ?? []) {
      // transcript 是几十 KB 到几 MB 的对话全文，后端一个字都不读
      const { transcript: _drop, ...rest } = (raw ?? {}) as ObserveSessionDetail;
      const s = { ...rest, agent: textOf(rest.agent).trim() || name };
      sessions.push(s as Record<string, unknown>);
      if (isEvidence(s, name)) usable += 1;
    }
  }
  return { sessions, usable };
}

/** 本次 run 的采纳追踪（`overview.adoption_note`，app/planrun.py:_build_overview）。
 *  只有**上一次** run 有已采纳处方时后端才写这个键 —— 缺键是常态，返回 null
 *  由显示侧整块不画（绝不画一个空的「采纳后：—」）。 */
export function adoptionNoteOf(d: PlanRunDetail | null | undefined): AdoptionNote | null {
  const raw = (d?.overview ?? {})["adoption_note"];
  if (!raw || typeof raw !== "object") return null;
  const note = raw as AdoptionNote;
  const proposals = Array.isArray(note.proposals) ? note.proposals : [];
  const changes = Array.isArray(note.score_changes) ? note.score_changes : [];
  if (proposals.length === 0 && changes.length === 0) return null;
  return { proposals, score_changes: changes };
}

// ---------- 运行中 run 的存活/进度文案（UI-029 批 3 交付 3）----------
//
// 两条都遵守同一条规矩：**后端给了才说**。老 run（批 1 之前落库）与终态 run
// 查无这两个字段（终态整条 put_item 不携带中途字段）→ 返回 null，显示侧整段
// 不画。绝不补默认值：心跳补 0 会印出「最后心跳 56 年前」，进度补 0/0 会让
// 用户以为一个环节都没跑完（旧数据不修 = 也不许在展示侧伪造）。

/**
 * 「最后心跳 X 前」——后端 `heartbeat_epoch`（秒级 epoch）与现在的差。
 *
 * 时长格式借 lib/scoring.fmtDuration（全站唯一那份，与耗时列同形）。
 * 时钟偏差（后端写的心跳比本地时钟还“新”）不给负数，压到 0。
 */
export function heartbeatAgeText(
  epoch: number | null | undefined, nowMs: number,
): string | null {
  if (typeof epoch !== "number" || !(epoch > 0)) return null;
  const age = Math.max(0, Math.round(nowMs / 1000 - epoch));
  return `最后心跳 ${fmtDuration(age)} 前`;
}

/**
 * 「已完成 X/N 环节 · 最近完成 <环节名>」。
 *
 * `progress.stage` 是**刚结束**那个环节的类型（后端只在环节边界写进度，那一刻
 * 下一环还没开始）—— 所以这里说「最近完成」。写成「正在跑 X」就是编一个后端
 * 没说过的事实。环节展示名走 lib/scoring.STAGE_LABEL（唯一权威，ADR-0003）。
 * 缺字段或总数为 0 → null（不画「0/0 环节」）。
 */
export function stageProgressText(
  p: PlanRunProgress | null | undefined,
): string | null {
  const total = typeof p?.stages_total === "number" ? p.stages_total : 0;
  const done = typeof p?.stages_done === "number" ? p.stages_done : null;
  if (!total || done == null) return null;
  const raw = typeof p?.stage === "string" ? p.stage : "";
  const stage = raw ? (STAGE_LABEL[raw] ?? raw) : "";
  return `已完成 ${done}/${total} 环节${stage ? ` · 最近完成 ${stage}` : ""}`;
}

/** 表格展示顺序：最新在前。解析失败（toMillis=NaN）排最旧——`|| 0` 保留
 *  收敛前 toMillis 的 0-fallback 排序语义。
 *
 *  泛型而非固定 `PlanRunSummary[]`：跨方案对比页喂的行带 plan_id/plan_name
 *  （`list_recent_runs` 口径），窄成基类型会把那几个字段在返回值上丢掉，而丢掉的
 *  正是「两栏各是哪个方案」要读的字段。约束仍是 PlanRunSummary，行为一字未改。 */
export function sortRunsDesc<T extends PlanRunSummary>(runs: T[]): T[] {
  return [...runs].sort(
    (a, b) => (toMillis(b.started_at) || 0) - (toMillis(a.started_at) || 0),
  );
}

export interface PlanKpis {
  /** 有分 run（observe 综合分非空）的均分；无样本为 null。
   *  ⚠️ 只吃 observe 分——dataset/redteam 没有可比的连续分数，不编造。 */
  avgScore: number | null;
  /** 最近一次有分 - 前一次有分；不足两次为 null */
  delta: number | null;
  /** 成功运行次数。口径 = 按环节判定产出了有效结果（isRunSuccess）：
   *  纯回归/纯红队 run 也算（UI-013），部分失败也算（但 badge 会明说）；
   *  环节全 empty 的空转 run 与全环节失败的 run 不算（UI-025）。
   *  **与均分/趋势的样本口径刻意不同**：那两处只认 observe 分。 */
  successCount: number;
  /** 总运行次数 */
  totalCount: number;
}

export function deriveKpis(runs: PlanRunSummary[]): PlanKpis {
  const sorted = sortRunsDesc(runs);
  // 取值走 effectiveScore（不是 r.score）：8/21 之前那批 run 的顶层 score 是
  // null，分在 observe 环节的 overall_mean 里。判定与取值必须同源，否则
  // isScored 收下的样本会在这里读出 null → 均分 NaN、delta NaN。
  const scored = sorted.filter(isScored);
  const avgScore = scored.length
    ? scored.reduce((s, r) => s + (effectiveScore(r) as number), 0) / scored.length
    : null;
  const delta = scored.length >= 2
    ? (effectiveScore(scored[0]) as number) - (effectiveScore(scored[1]) as number)
    : null;
  return {
    avgScore,
    delta,
    successCount: sorted.filter(isRunSuccess).length,
    totalCount: sorted.length,
  };
}

// ---------- hero 指标（D-1：按方案环节组成自适应） ----------
//
// 为什么要这一层：顶层 score 只在存在 observe 环节 overall_mean 时写入
// （planrun.py:_persist），所以**不含 observe 环节的方案，「线上评估均分」永远
// 是「—」**，而右边「成功运行 2/2」同时是绿的。用户看到的第一眼数字恒为「—」，
// 必然得出「平台没跑成功」并再点一次运行（真花钱、真调 Agent）——已经发生过。
//
// ⚠️ ADR-0003 硬线：这里只是**换一个已有的数当 hero**，绝不合成跨量纲总分。
// 三个指标各自量纲不同（0-1 分 / 通过率 / 绝对计数），永不相加、永不平均成
// 一个数；「有没有分」那条口径本身（lib/scoring.ts 的 isScored / effectiveScore）
// 不由本节改动 —— 它的取分住址已经不只是顶层 score 了（isScored 走
// effectiveScore：顶层 score 缺就从 observe 环节 overall_mean 现推），
// 所以别再照「只认顶层 score」写代码；本节一个字都不碰那条口径。

/** hero 指标口径。含 observe 恒走 observe（混跑方案的分数仍是主角）；
 *  环节未知/为空也走 observe —— 「方案还没有环节」这件事由编辑器的缺项提示
 *  负责（UI-010），hero 不替它说话。 */
export type PlanMetricKind = "observe" | "regression" | "redteam";

export function planMetricKind(stages: PlanStage[] | null | undefined): PlanMetricKind {
  const types = new Set((stages ?? []).map((s) => s?.type));
  if (types.has("observe")) return "observe";
  if (types.has("dataset")) return "regression";
  if (types.has("redteam")) return "redteam";
  return "observe";
}

/** 一个 run 的回归通过率：**completed** dataset 环节 pass_rate 的等权均值。
 *  0 是结论不是空值（CONTEXT.md 通过率条）；没跑完的环节（error/halted_cost/
 *  empty）不出数 —— 半截运行的数字不是结论（同 regressionTrend 的取样闸门，
 *  两处共用本函数）。口径与 bigscreen/derive.passRateOf 一致（那份是大屏的
 *  同型实现，跨页收敛归 D-6）。 */
export function runPassRate(run: PlanRunSummary): number | null {
  return meanOf((run.stage_summaries ?? [])
    .filter((s) => s.type === "dataset" && s.status === "completed")
    .map((s) => s.pass_rate)
    .filter((v): v is number => typeof v === "number"));
}

/** 红队攻破/攻击数（一个 run 内 completed 红队环节求和）；没有跑完的红队环节 → null
 *  （「没测过」≠「0 次攻破」，口径同 lib/scoring.breachOf）。 */
export interface RedteamTally { breached: number; attacks: number }

export function runRedteamTally(run: PlanRunSummary): RedteamTally | null {
  const st = (run.stage_summaries ?? []).filter(
    (s) => s.type === "redteam" && s.status === "completed");
  if (!st.length) return null;
  return {
    breached: st.reduce((a, s) => a + (s.breached ?? 0), 0),
    attacks: st.reduce((a, s) => a + (s.attacks ?? 0), 0),
  };
}

/** hero 格的展示投影（三形态共用一个形状，渲染层不再分支）。 */
export interface PlanHero {
  kind: PlanMetricKind;
  /** KPI 标签（带限定词 —— 裸「均分」禁用，CONTEXT.md:93-96） */
  label: string;
  /** 取样口径小字（kpi-scope）：与数字的样本闸门必须一致 */
  scope: string;
  /** 主数字（已格式化）；null = 无样本 → 渲染层显示「—」 */
  value: string | null;
  /** 分母段（只有红队形态有：「3」+「/12」）；null = 不画 */
  denom: string | null;
  /** 环比（已带符号与单位）；null = 不足两个样本，或该形态刻意不做环比 */
  deltaText: string | null;
  deltaNeg: boolean;
  /** 有样本时的脚注 */
  meta: string;
  /** 无样本时的原话。**三形态各不相同**：「有 observe 却没跑出分」与「根本没有
   *  observe 环节」是两个不同的「—」，共用一句话就等于没解释（D-1 推荐里
   *  选项 2 的文案落点）。 */
  emptyText: string;
}

/** 通过率环比说「个百分点」而不是「+0.10」：后者与线上评估分同形，正是
 *  「把通过率读成分数」那条现场（stage-line-shows-pass-rate-as-score）。
 *  导出给 run 对比视图的并排 KPI 用（compare/derive.ts）—— 这句单位词只能有
 *  一个住所，两处各写一份就会漂成「+10%」那种读不出量纲的形态。 */
export function ppText(d: number): string {
  return `${d >= 0 ? "+" : "−"}${Math.round(Math.abs(d) * 100)} 个百分点`;
}

export function planHero(
  stages: PlanStage[] | null | undefined, runs: PlanRunSummary[],
): PlanHero {
  const kind = planMetricKind(stages);
  const sorted = sortRunsDesc(runs);

  if (kind === "regression") {
    const rates = sorted.map(runPassRate).filter((v): v is number => v != null);
    const avg = meanOf(rates);
    const delta = rates.length >= 2 ? rates[0] - rates[1] : null;
    return {
      kind, label: "回归通过率", scope: "跑完回归环节的运行",
      value: avg == null ? null : fmtPctInt(avg),
      denom: null,
      deltaText: delta == null ? null : ppText(delta),
      deltaNeg: (delta ?? 0) < 0,
      meta: `${rates.length} 次运行有通过率 / 共 ${sorted.length} 次`,
      emptyText: "本评估计划没有线上评估环节，而还没有一次运行跑完回归环节",
    };
  }

  if (kind === "redteam") {
    // 只取**最近一次**跑完红队的运行：攻破数是绝对计数，跨 run 累加会随历史
    // 单调上升，读不出「现在还挡不挡得住」。
    const tally = sorted.map(runRedteamTally).find((t) => t != null) ?? null;
    return {
      kind, label: "红队攻破", scope: "最近一次红队运行",
      value: tally == null ? null : String(tally.breached),
      denom: tally == null ? null : `/${tally.attacks}`,
      deltaText: null, deltaNeg: false,
      meta: `最近一次共 ${tally?.attacks ?? 0} 次攻击 · 共 ${sorted.length} 次运行`,
      emptyText: "本评估计划没有线上评估环节，而还没有一次运行跑完红队环节",
    };
  }

  // observe（含混跑方案）：口径与文案保持现状，只把空态那句话换成说原因的
  const kpis = deriveKpis(sorted);
  return {
    kind, label: "线上评估均分", scope: "线上评估有分运行",
    value: kpis.avgScore == null ? null : fmtScore(kpis.avgScore),
    denom: null,
    deltaText: kpis.delta == null
      ? null
      : `${kpis.delta >= 0 ? "+" : ""}${kpis.delta.toFixed(2)}`,
    deltaNeg: (kpis.delta ?? 0) < 0,
    meta: `最近 ${sorted.length} 次运行`,
    emptyText: "本评估计划有线上评估环节，但还没有一次运行跑出线上评估分",
  };
}

// ---------- 趋势空态的原因行（D-2） ----------
//
// 「成功运行 2/2」（口径 2，isRunSuccess）与「趋势 0 个点」（口径 1，isScored）
// 合法地不相等（CONTEXT.md:145-150），但此前**没有一处**说得出为什么可以不等 ——
// 用户把它读成数据丢了或统计有 bug（UI-013 之后残留的最后一处自相矛盾感知）。
//
// 这一行是**追加**的原因，不替换主句（主句是触发条件「差几次」，两套口径的原文
// 分别被 plan.test.tsx 与 evaluator-metrics-trend.test.tsx 钉着）。

export interface TrendEmptyFacts {
  /** 方案环节组成（planMetricKind） */
  kind: PlanMetricKind;
  /** 有分运行数（口径 1：趋势的样本闸门） */
  scoredCount: number;
  /** 成功运行数（口径 2：按环节判定） */
  successCount: number;
  totalCount: number;
  /** 口径 B（回归趋势）的点数：≥1 说明这张卡画的是回归口径 */
  regressionPoints: number;
}

/** 空态原因（一句话）；返回空串 = 不追加（主句已经说完）。 */
export function trendEmptyReason(f: TrendEmptyFacts): string {
  if (f.kind === "observe") {
    // 有 observe 环节却零有分运行 —— 与「根本没有 observe 环节」是**两件事**，
    // 绝不共用一句话（D-1/D-2 推荐的原话分列）
    if (f.scoredCount > 0 || f.totalCount === 0) return "";
    return `本评估计划有线上评估环节，但还没有一次运行跑出线上评估分`
      + `（成功运行 ${f.successCount}/${f.totalCount}）`;
  }
  const why = f.totalCount === 0
    ? "本评估计划还没有运行记录；它也没有线上评估环节，因此不会有分数点位"
    : f.successCount === f.totalCount
      // 用户困惑的原话形态：「都成功了，怎么趋势是 0」
      ? `本评估计划的 ${f.totalCount} 次运行都成功了，但没有线上评估环节，因此没有分数点位`
      : `本评估计划没有线上评估环节，因此没有分数点位`
        + `（成功运行 ${f.successCount}/${f.totalCount}）`;
  // 指路句（「趋势按回归通过率…再跑一次即可连线」「回归结果看上方…」）对任何同态
  // 方案恒成立 ⇒ 删，只留说这个方案自己的数的那一句（prose-sweep 2026-09-03）
  return why;
}

export interface TrendPoint {
  /** 毫秒时间戳（X 轴） */
  t: number;
  /** 轴/tooltip 标签："MM-DD HH:mm" */
  label: string;
  score: number;
}

/** 趋势图的取样：最近 limit 次**有分** run，按时间升序（图从左往右）。
 *  单独抽出来是为了让版本变更竖线（versionMarkers）与折线点**同一批 run** ——
 *  各自取一遍样，竖线就会落到轴上不存在的位置。 */
export function scoredRunsAsc(runs: PlanRunSummary[], limit = 20): PlanRunSummary[] {
  return sortRunsDesc(runs).filter(isScored).slice(0, limit).reverse();
}

/** 趋势数据：最近 limit 次成功 run，按时间升序（图从左往右）。<2 点视作空态。 */
export function trendPoints(runs: PlanRunSummary[], limit = 20): TrendPoint[] {
  return scoredRunsAsc(runs, limit)
    .map((r) => {
      const t = toMillis(r.started_at) || 0; // 解析失败保持旧 0-fallback（X 轴/label 走「—」）
      // 分值同样走 effectiveScore（isScored 的同源取值）：老 run 顶层 score 为
      // null，直读会给折线喂 null → 点位画在 0 上（比空态更糟）。
      return { t, label: fmtAxisTime(t), score: effectiveScore(r) as number };
    });
}

// ---------- 版本变更竖线（deploy marker，护栏 1 的展示侧） ----------
//
// 用户原话：「用户标记不同 runtime 对应 agent 不同版本」—— 同一个 agent 改进后
// 换了 runtime 再评一次，趋势里要看得出「这一段是哪一版」。竖线画在**相邻两次
// 运行的版本标签不同**的那一点上。
//
// ⚠️ 只读 run **自己的**快照 `agent_version_label`（落库那一刻冻结，见
// app/planrun.py:_planrun_item），**绝不**读 Agent 当前标签 —— 否则用户今天改一
// 次标签，过去半年的点位会全部重新归到新版本上（那正是护栏 1 要防的）。
// 老 run 没有快照（旧数据不修）→ 不参与，也不制造「版本回退」的假竖线。

export interface VersionMarker {
  /** 竖线落在哪一点：X 轴 label（与趋势点的 label 同一个格式化） */
  at: string;
  /** 这一点起的版本标签（run 快照） */
  label: string;
  /** 上一次见到的标签；"" = 之前的 run 都没有快照（老数据边界） */
  prev: string;
}

/**
 * 版本变更竖线。入参是**已按时间升序**的 run（与图的取样口径同一批：
 * scoredRunsAsc / regressionRunsAsc）。
 *
 * 三条口径：
 *   · **第一个点不画** —— 那里没有「相邻的上一次」可比，画一条只会让整段被读成
 *     「刚换的版本」；
 *   · 标签没变不画（同一版跑十次只有数据点）；
 *   · 缺快照的 run 既不出竖线，也**不重置**上一次的标签 —— 中间夹一条老 run
 *     不许被读成换了两次版本。
 */
export function versionMarkers(runsAsc: PlanRunSummary[]): VersionMarker[] {
  const out: VersionMarker[] = [];
  let prev = "";
  runsAsc.forEach((r, i) => {
    const cur = (r.agent_version_label ?? "").trim();
    if (!cur) return;
    if (i > 0 && cur !== prev) {
      out.push({ at: fmtAxisTime(toMillis(r.started_at) || 0), label: cur, prev });
    }
    prev = cur;
  });
  return out;
}

/**
 * 一个 run 的**版本标签快照**（报告抽屉头部的 chip 与 run 对比两栏的 chip 读
 * 同一个函数）。
 *
 * 两条通路都读：get_plan_run 带（真后端 _run_from_item 无条件带），拿不到就退到
 * 运行历史那一行的同名字段；两边都没有（本功能之前落库的 run）→ 空串，显示侧
 * 整个 chip 不画（旧数据不修，绝不画一个空 chip）。
 *
 * ⚠️ **绝不读 Agent 当前标签**（discover 的 version_label 是另一个字段）：事后
 * 改标签不许改动历史 run 的归属，否则用户今天改一次标签，过去半年的运行会全部
 * 重新归到新版本上（护栏 1）。护栏钉在 tests/run-compare.test.tsx 与
 * tests/plan-version-labels.test.tsx。
 */
export function versionSnapshot(
  detail: PlanRunDetail | null | undefined,
  summary: { agent_version_label?: string | null } | null | undefined,
): string {
  return String(detail?.agent_version_label ?? summary?.agent_version_label ?? "").trim();
}

/** 竖线的悬停/说明文案（图内标注与图下说明行同一份，两处不许各写一句）。 */
export function versionMarkerText(m: VersionMarker): string {
  return m.prev
    ? `版本 ${m.prev} → ${m.label}（这一次运行用的是 ${m.label}）`
    : `版本 ${m.label} 起（此前的运行没有版本标签）`;
}

// ---------- 纯回归方案的趋势（逐评估器 + 总体通过率） ----------
//
// 为什么要第二套口径：趋势图只认 observe 分，而纯回归方案的 run 顶层 score
// **恒为 null**（后端只在有 observe overall_mean 时写），于是用户看到的是一句
// 「已有 0 次有分运行」——方案跑得很好、每次都有四个评估器的分数，界面却说
// 没有分。用户原话：「这里应该显示每次评估后，评估器的分数和总体分数」。
//
// ⚠️ ADR-0003 硬线：这里的数字**只服务于这张趋势卡**。总体线只能是后端算好的
// pass_rate；逐评估器均分绝不许 reduce 成一个「总分」（那会立刻流进「线上评估
// 均分」KPI 与跨方案聚合，把回归通过率和线上评估分混成一个数）。「有没有分」那条
// 口径本身（lib/scoring.ts 的 isScored / effectiveScore）不由本节改动 —— 注意它的
// 取分住址已经不只是顶层 score（isScored 走 effectiveScore：顶层 score 缺就从
// observe 环节 overall_mean 现推），本节既不放宽它也不复制它。

/** 评估器序列在趋势点上的键名。`ev:` 前缀避免与 t/label/passRate 撞名
 *  （评估器是用户可自定义的注册名，真有人叫 label 也不会打翻数据）。 */
export function evSeriesKey(name: string): `ev:${string}` {
  return `ev:${name}`;
}

export interface RegressionTrendPoint {
  /** 毫秒时间戳（X 轴） */
  t: number;
  /** 轴/tooltip 标签："MM-DD HH:mm" */
  label: string;
  /** 总体通过率（0-1，后端 pass_rate 原值）——本图**唯一**的总体序列。
   *  老 run/环节没给 pass_rate 时为 null。 */
  passRate: number | null;
  /** 逐评估器均分，键 = evSeriesKey(注册名)。
   *  null = 那次一条有效判定都没有（全被 judge 限流）→ 线在此断开，**不补 0**。
   *  键整个缺失 = 那次 run 是老形态（没有 evaluator_stats 字段）。 */
  [series: `ev:${string}`]: number | null | string;
}

export interface RegressionTrend {
  /** 按时间升序（图从左往右）；<2 点由调用方走空态 */
  points: RegressionTrendPoint[];
  /** 图上每条线一个：窗口内**至少有过一次有效均分**的评估器（按配置回显顺序）。
   *  全程无判定的评估器在报告抽屉的表里留名（那里要说「一条判定都没有」），
   *  这里没有点可画，不进名单。 */
  evaluators: string[];
}

/** 等权均值；空样本 → null（**绝不返回 0**：0 是「评了且很差」）。
 *  hero 的回归通过率与 regressionTrend 的点位共用它。 */
function meanOf(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 口径 B 的取样：最近 limit 次「跑完了回归环节」的 run（附那些环节），时间升序。
 *  抽出来与 regressionRunsAsc 共用一份闸门 —— 版本竖线与点位必须同一批 run。 */
function regressionRowsAsc(
  runs: PlanRunSummary[], limit = 20,
): { run: PlanRunSummary; stages: StageSummary[] }[] {
  return sortRunsDesc(runs)
    .map((r) => ({
      run: r,
      stages: (r.stage_summaries ?? []).filter(
        (s) => s.type === "dataset" && s.status === "completed"),
    }))
    .filter((x) => x.stages.length > 0)
    .slice(0, limit)
    .reverse();
}

/** 口径 B 图上那批 run（供 versionMarkers 用，与点位同序同批）。 */
export function regressionRunsAsc(
  runs: PlanRunSummary[], limit = 20,
): PlanRunSummary[] {
  return regressionRowsAsc(runs, limit).map((x) => x.run);
}

/**
 * 回归口径的趋势数据：最近 limit 次「跑完了回归环节」的 run，按时间升序。
 *
 * 取样闸门 = 环节 status **completed**：error / halted_cost（成本熔断）/ empty
 * 都不出点——半截运行的数字不是结论（同 planrun.py:_fmt_stage_line 的 P1 注释）。
 * 一个 run 里有多个回归环节时按环节等权平均（与 reportScore 对多个 observe
 * 环节的处理同源），并在注释里说清这是等权而非按用例数加权。
 */
export function regressionTrend(
  runs: PlanRunSummary[], limit = 20,
): RegressionTrend {
  const rows = regressionRowsAsc(runs, limit);

  const evaluators: string[] = [];
  const points = rows.map(({ run, stages }) => {
    const t = toMillis(run.started_at) || 0; // 解析失败保持旧 0-fallback
    const point: RegressionTrendPoint = {
      t,
      label: fmtAxisTime(t),
      // 与 hero 的「回归通过率」**同一个函数**（runPassRate：completed dataset
      // 环节 pass_rate 等权均值）—— 图上的点与 KPI 的数不许各算一遍
      passRate: runPassRate(run),
    };
    // 同名评估器出现在多个回归环节：等权平均（点位是「这次运行该评估器的分」）
    const seen: string[] = [];
    const means = new Map<string, number[]>();
    for (const s of stages) {
      for (const row of evaluatorRows(s)) {
        if (!seen.includes(row.name)) seen.push(row.name);
        if (row.mean != null) {
          const xs = means.get(row.name) ?? [];
          xs.push(row.mean);
          means.set(row.name, xs);
        }
      }
    }
    for (const name of seen) {
      const m = meanOf(means.get(name) ?? []);
      point[evSeriesKey(name)] = m;
      // 有过有效均分才进线名单：全程 null 的线画不出任何点，只会在图例里
      // 挂一个空名字（它的「一条判定都没有」由报告抽屉的表说）
      if (m != null && !evaluators.includes(name)) evaluators.push(name);
    }
    return point;
  });

  return { points, evaluators };
}

/** 趋势区间统计（原型 plandetail.html 右侧 hairline 统计列的数据） */
export interface TrendStats {
  max: number;
  maxLabel: string;
  min: number;
  minLabel: string;
  avg: number;
  /** 最后两点的差；不足两点为 null */
  delta: number | null;
  /** 低于目标线的次数 */
  belowTarget: number;
  count: number;
}

/**
 * 从趋势点推区间统计。points 必须已按时间升序（trendPoints 的输出）。
 * 少于 1 点返回 null——调用方走空态。
 */
export function trendStats(points: TrendPoint[], target: number): TrendStats | null {
  if (points.length === 0) return null;
  let hi = points[0];
  let lo = points[0];
  let sum = 0;
  let below = 0;
  for (const p of points) {
    if (p.score > hi.score) hi = p;
    if (p.score < lo.score) lo = p;
    sum += p.score;
    if (p.score < target) below += 1;
  }
  const last = points[points.length - 1];
  const prev = points.length >= 2 ? points[points.length - 2] : null;
  return {
    max: hi.score, maxLabel: hi.label,
    min: lo.score, minLabel: lo.label,
    avg: sum / points.length,
    delta: prev ? last.score - prev.score : null,
    belowTarget: below,
    count: points.length,
  };
}

export function fmtAxisTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().slice(5, 16).replace("T", " ");
}

// fmtRunTime 搬到 lib/time.ts（消费方跨四个页面族，时间排版是那里的辖区，L6）。

export const TRIGGER_LABEL: Record<string, string> = {
  manual: "手动",
  schedule: "定时",
  scheduled: "定时",
  api: "API",
};

export function triggerLabel(v: string | null | undefined): string {
  if (!v) return "—";
  return TRIGGER_LABEL[v] ?? v;
}

// fmtScore/fmtDuration/STATUS_LABEL/statusBadgeClass/runBadge 已收敛到
// lib/scoring.ts（ADR-0003 口径单一来源），消费方直接从那里 import。

// ---------- 综合报告分节（报告抽屉） ----------

export interface SynthesisSection {
  title: string;
  body: string;
}

/**
 * 老数据 fallback：get_plan_run 没带 synthesis_sections 时，前端按 `## ` 行
 * 切分 plan_synthesis。逻辑必须与后端 planrun.synthesis_sections 一致：
 * - 无任何 `## ` 标题：整段作单节 title="综合报告"；
 * - 首个标题前的非空引言：作首节 title="综合报告"；
 * - 标题存在但正文为空：节保留（节数用于 n/N 计数）。
 */
/**
 * 一份 run 归档 → 综合报告分节，**四个消费方唯一的读法**（报告页 / 评估分析 /
 * 计划报告抽屉 / 运行详情此前各写一遍同样两行）：
 * - `synthesis_sections` 非空就用它（后端 planrun.synthesis_sections 已切好）；
 * - 缺则按 `## ` 切 `plan_synthesis`（老数据 fallback）。
 * title/body 一律过 textOf：`plan_synthesis` 实测会给**对象**（RunDetailPage 的
 * ViewRunMeta 一族同因），此前只有运行详情做了归一，另三处裸渲对象会炸整棵子树。
 * 本函数跑在 useMemo 里、错误围栏之外，绝不许抛。
 */
export function sectionsOf(d: {
  synthesis_sections?: unknown;
  plan_synthesis?: unknown;
} | null | undefined): SynthesisSection[] {
  if (!d) return [];
  const secs = Array.isArray(d.synthesis_sections) ? d.synthesis_sections : [];
  if (secs.length > 0) return secs.map((x) => ({ title: textOf(x?.title), body: textOf(x?.body) }));
  return synthesisSections(textOf(d.plan_synthesis));
}

export function synthesisSections(text: string | null | undefined): SynthesisSection[] {
  if (!text || !text.trim()) return [];
  const sections: SynthesisSection[] = [];
  let title: string | null = null; // null = 首个标题前的引言
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (title === null) {
      if (body) sections.push({ title: "综合报告", body });
    } else {
      sections.push({ title, body });
    }
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      title = line.slice(3).trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}
