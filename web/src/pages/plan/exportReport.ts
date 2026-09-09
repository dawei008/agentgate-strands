// 运行报告导出（UI-011）：把报告抽屉**已加载**的 get_plan_run 数据拼成
// Markdown 下载。不发新请求、不需要后端改动。
//
// 诚实纪律（本项目硬口径，改这里前先读一遍）：
//   - 只写后端给了的数据。后端没给「通过 X/Y」就不推算——环节数字统一走
//     stageNumbers()，与抽屉界面同一个函数，保证导出与屏幕上一字不差。
//   - score 为空写「无可评估数据」，不是 0 分也不是留空让人误读成满分；
//     completed 且无分的 run 用中性表述（对齐 badge「完成 · 无可评估数据」）。
//   - report 缺失 / report_error 存在时，导出开头写明「以下仅为运行摘要」，
//     并在页脚如实标注数据来源，不假装这是一份完整归档。
//   - synthesis_error 原样写进导出，不悄悄吞掉。
//   - **屏幕上有的，导出里要有**：环节分析 / 逐评估器 / 用例明细三批能力先后
//     只进了抽屉，导出还停在三节（运行信息 / 环节结果 / 综合结论），于是
//     「下载报告」拿到的东西比屏幕少一大半。补齐时同样只搬后端给了的字段，
//     老 run 缺字段 → 对应节不输出（不留空标题、不写 0、不写 NaN）。
//   - 用例明细**只进摘要**（用例名 + 不通过的评估器 + judge 理由首句）：
//     现网单环节 10 行 × 输出最长 2470 字 + 理由 600 字，全文进导出会把一份
//     报告吹成几十万字，而「谁在拖分」这个问题首句就答完了；全文在屏幕上。
import type { PlanRunDetail, StageSummary, SynthesisSection } from "./types";
import {
  triggerLabel, stageNumbers,
  stageKind, stageNote, STAGE_KIND_TEXT,
  evaluatorRows, observeEvaluatorRows,
  type CaseNote, type CaseRow, type CaseVerdict, type SessionNote, type SessionRow,
  type StageDrilldown,
} from "./derive";
import { fmtPctInt, fmtScore, fmtDuration, STAGE_LABEL, type RunOutcome } from "../../lib/scoring";
// 截断加省略号的唯一实现（cap 各处不同，传参）。
import { clipText } from "../../lib/text";
import { fmtRunTime } from "../../lib/time";

/** 导出输入：抽屉已算好的展示值直接传进来——口径共用而不是重算一遍。 */
export interface ReportExportInput {
  runKey: string;
  /** 运行历史里的 #N 序号（抽屉头部同一个值）；无历史上下文时 null */
  seq: number | null;
  planId: string;
  /** get_plan_run 的结果；仍在加载 / 查询失败时为空（调用方应先拦住） */
  detail: PlanRunDetail | null | undefined;
  status: string;
  /** 界面口径的线上评估均分（scoreOf 的结果，= observe 环节综合分）：
   *  null = 没有 observe 分（纯回归/纯红队 run 也如此——这不代表失败，看 outcome） */
  score: number | null;
  /** run 终态（抽屉的 runOutcome 结果，badge 同一份）。「结果」行与提示
   *  引文都从这里投影——此前这里是 noData 布尔（status+score 的文本复写），
   *  部分失败的 run 会被导出成「完成 · 总分 X」（UI-025 口径洞）。 */
  outcome: RunOutcome;
  cost: number | null;
  startedAt: string | number | null | undefined;
  durationS: number | null | undefined;
  triggeredBy: string | null | undefined;
  skipReason?: string | null;
  stages: StageSummary[];
  sections: SynthesisSection[];
  /** 钻取块（抽屉 reportDrilldowns 的**同一份** useMemo 结果）：回归环节的
   *  环节分析 + 逐用例明细，线上评估环节的环节分析 + 逐会话明细。缺省 = 不输出
   *  明细节 —— 老调用方与只测前三节的夹具无需改动，`report` 读不到的 run
   *  （report_error 通路）天然是空数组。 */
  drills?: StageDrilldown[];
  /** 注入导出时间便于测试；缺省取当下 */
  now?: Date;
}

/** 文件名安全化：中文保留（现代文件系统与浏览器都吃得下），把路径分隔符、
 *  Windows 保留字符、空白与控制字符统一压成 `-`。空结果回退给 fallback。 */
export function safeFileSegment(raw: string | null | undefined, fallback: string): string {
  const s = (raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")   // 控制字符：显式码点，别写字面量
    .replace(/[/\\:*?"<>|#%&{}$!'`@+=~^;,\s]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60)
    .replace(/^[-.]+|[-.]+$/g, "");
  return s || fallback;
}

/** 时间片段：`2026-08-20 15:57 UTC` → `2026-08-20-1557`（后缀由 fmtRunTime 剥）。
 *  解析不出来就把原串安全化，绝不编一个假时间。 */
function timeSegment(startedAt: string | number | null | undefined): string {
  const t = fmtRunTime(startedAt); // "YYYY-MM-DD HH:mm" 或原串 或 "—"
  const m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}${m[3]}`;
  return safeFileSegment(t, "时间未知");
}

/** 文件名含方案名与运行时间（验收标准 2）。 */
export function reportFileName(planName: string | null | undefined,
                               startedAt: string | number | null | undefined): string {
  return `运行报告-${safeFileSegment(planName, "未命名评估计划")}-${timeSegment(startedAt)}.md`;
}

/** 顶部结果口径：outcome.label 与抽屉 badge 同一份（含「部分失败 · <环节>」）；
 *  有分才写分。
 *
 *  度量词照 CONTEXT.md 的口径表，两条都是硬约束：
 *   · 这个数叫「线上评估均分」（:93-96）= 该 run 各 observe 环节 overall_mean 的
 *     均值。**不叫「总分」**（:88-91 Avoid）——「总分/综合分」会被读成把三类环节
 *     合成一个数，而本产品绝不合成（ADR-0003 Amendment）。
 *   · 「均分」不得单独出现（:94-96）：裸词在同屏会被读成回归通过率或环节分，
 *     一律带限定词。 */
function resultLine(i: ReportExportInput): string {
  if (i.outcome.kind === "nodata") {
    return "完成 · 无可评估数据（本次运行不计入线上评估均分与趋势）";
  }
  const parts = [i.outcome.label || "—"];
  if (i.score != null) parts.push(`线上评估均分 ${fmtScore(i.score)}`);
  if (i.status === "skipped" && i.skipReason) parts.push(i.skipReason);
  return parts.join(" · ");
}

/** 完整报告（S3 归档）到位情况。返回 [开头警示语, 页脚来源标注]。 */
function reportProvenance(d: PlanRunDetail | null | undefined): [string | null, string] {
  const err = typeof d?.report_error === "string" ? d.report_error : null;
  if (err) return [`${err}——以下仅为运行摘要。`, "运行摘要（完整报告读取失败）"];
  if (d?.s3_key && !d?.report) {
    return ["完整报告读取失败，以下仅为运行摘要。", "运行摘要（完整报告读取失败）"];
  }
  if (d?.report) return [null, "完整报告归档 + 运行摘要"];
  return [null, "运行摘要"];
}

/** 环节一行：数字走 stageNumbers、分档与原话走 stageKind/stageNote ——
 *  三个函数都是抽屉环节行消费的**同一份**（derive.ts），所以「无数据 /
 *  已停止 / 执行失败」四档在屏幕与导出里一字不差。此前这里与
 *  ReportDrawer.StageLine 各写一套 if：用户主动停止的环节（status=stopped，
 *  带停止说明文本）两边都被判进「执行失败」，而 run 级是琥珀的「已停止」。 */
function stageLine(stage: StageSummary): string {
  const label = STAGE_LABEL[stage.type ?? ""] ?? stage.type ?? "环节";
  const kind = stageKind(stage);
  const note = stageNote(stage);
  if (kind === "normal") {
    return `- **${label}**：${stageNumbers(stage)}${note ? ` — ${note}` : ""}`;
  }
  // empty / stopped / failed：位上是状态词，括号里是后端原话（半截数字不写进
  // 这一行——failed 那档的数字仍在环节摘要与完整报告里）
  return `- **${label}**：${STAGE_KIND_TEXT[kind]}${note ? `（${note}）` : ""}`;
}

function exportStamp(now: Date): string {
  return `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// ---------- 回归环节明细（环节分析 + 逐评估器 + 未通过用例） ----------

/** 摘要里一句话的封顶长度：judge 理由现网封顶 600 字，一句话通常 20-60 字，
 *  120 是「说完一件事」与「不把导出撑爆」的折中。截断留省略号，不假装说完了。 */
const SENTENCE_CAP = 120;

/**
 * 取首句（摘要口径）。句末标记按中英文各一套；一句都断不出来就整段当一句
 * （judge 偶有不带句号的短理由）。换行/连续空白压成单空格 —— 摘要要能放进
 * Markdown 的一个列表项里，不能自带断行把列表劈开。
 */
function firstSentence(text: string): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = t.match(/^[^。！？!?]*[。！？!?]/);
  const s = (m ? m[0] : t).trim();
  return clipText(s, SENTENCE_CAP);
}

/** 逐评估器表（Markdown）。空数组（老 run 无 evaluator_stats）→ 不输出。
 *  两档缺失与屏幕上的表**同一套话**：judged=0 →「无可评估数据」（一条判定都
 *  没有），judged>0 但 mean 为空 →「—」。绝不用 0 顶替（0 是「评了且很差」）。 */
function evaluatorTable(stage: StageSummary | undefined): string[] {
  const rows = evaluatorRows(stage);
  if (rows.length === 0) return [];
  const L: string[] = ["**逐评估器**", ""];
  // 表头限定词照 CONTEXT.md 的度量口径：「均分」不得单独出现
  L.push("| 评估器 | 评估器均分 | 通过/判定 |", "| --- | --- | --- |");
  for (const r of rows) {
    const mean = r.mean == null ? (r.judged > 0 ? "—" : "无可评估数据") : r.mean.toFixed(2);
    const count = r.judged > 0 ? `${r.passed}/${r.judged}` : "—";
    L.push(`| ${r.name} | ${mean} | ${count} |`);
  }
  L.push("");
  return L;
}

/**
 * 这一行「为什么值得看」。三档互斥，取值顺序即优先级：
 *   有不通过的判定 → 「<评估器名> 不通过」（多个用 · 连），理由取第一条不通过的；
 *   没有判定但有后端说明（空响应 / Agent 报错 / 调用失败 / 评估执行失败 /
 *     拉取失败 / 无内容可评）→ 行尾标记 + 「未获判定」，理由取后端原话；
 *   判定全 errored（judge 挂了）→ 「评估失败 · 未获判定」。
 * 三档都不成立 = 这一行通过了，返回 null（不进摘要）。
 * 「未获判定」与「不通过」刻意分词：空响应不是 0 分，也不是「不通过」——
 * 它一条判定都没有（同 derive.CaseNote / evaluatorRows 的口径）。
 * 用例行与会话行共用（两侧的 verdicts/note 同构，档位语义同源）。
 */
function rowIssue(row: { verdicts: CaseVerdict[]; note: CaseNote | SessionNote | null }):
  { what: string; why: string } | null {
  const failed = row.verdicts.filter((v) => v.passed === false);
  if (failed.length > 0) {
    return {
      what: `${failed.map((v) => v.name).join(" · ")} 不通过`,
      why: firstSentence(failed[0].reason),
    };
  }
  if (row.note) {
    return { what: `${row.note.mark} · 未获判定`, why: firstSentence(row.note.text) };
  }
  if (row.verdicts.length > 0 && row.verdicts.every((v) => v.errored)) {
    return { what: "评估失败 · 未获判定", why: firstSentence(row.verdicts[0].reason) };
  }
  return null;
}

/** 未通过 / 未获判定的用例摘要。一个都没有 → 不输出（没有坏消息就别造空标题）。 */
function caseSummary(cases: CaseRow[]): string[] {
  const lines: string[] = [];
  for (const row of cases) {
    const issue = rowIssue(row);
    if (!issue) continue;
    const who = row.agent ? `（${row.agent}）` : "";
    lines.push(`- **${row.name}**${who}：${issue.what}${issue.why ? ` — ${issue.why}` : ""}`);
  }
  if (lines.length === 0) return [];
  return ["**未通过 / 未获判定的用例**", "", ...lines, ""];
}

/** 未通过 / 未获判定的会话摘要（observe 侧的 caseSummary 同位物，同一份 rowIssue）。 */
function sessionSummary(sessions: SessionRow[]): string[] {
  const lines: string[] = [];
  for (const row of sessions) {
    const issue = rowIssue(row);
    if (!issue) continue;
    lines.push(`- **${row.id}**：${issue.what}${issue.why ? ` — ${issue.why}` : ""}`);
  }
  if (lines.length === 0) return [];
  return ["**未通过 / 未获判定的会话**", "", ...lines, ""];
}

/** 线上评估的逐评估器表（分母单位是判定会话，与屏幕上 ObserveEvaluatorTable
 *  同一套话）。分母未记录（DDB 摘要通路）与判定为零分两档，绝不用 0 顶替。 */
function observeEvaluatorTable(stage: StageSummary | undefined): string[] {
  const rows = observeEvaluatorRows(stage);
  if (rows.length === 0) return [];
  const L: string[] = ["**逐评估器**", ""];
  L.push("| 评估器 | 评估器均分 | 通过率 | 判定会话 |", "| --- | --- | --- | --- |");
  for (const r of rows) {
    const mean = r.mean == null ? (r.judged === 0 ? "无可评估数据" : "—") : r.mean.toFixed(2);
    const rate = fmtPctInt(r.passRate);
    const judged = r.judged == null ? "未记录"
      : `${r.judged}${r.errored ? `（另 ${r.errored} 次评估未完成）` : ""}`;
    L.push(`| ${r.name} | ${mean} | ${rate} | ${judged} |`);
  }
  L.push("");
  return L;
}

/**
 * 一个回归环节的明细节。
 *
 * 小标题用 `**粗体**` 而**不是** `###`：环节分析是后端 judge 的原文，里面本来
 * 就带 `## ` 小节标题（RUN_ANALYSIS_PROMPT 强制的四节）。原样进导出是硬要求，
 * 那就不能再往它上面套一层同族标题——套了之后层级本身就在说谎。
 *
 * 逐评估器数据在 **DDB 摘要**（`i.stages[index]`.evaluator_stats）而分析/用例在
 * **S3 报告体**（drill）：两个数组同序同长（planrun.py:1101
 * `[_stage_summary(r) for r in stage_results]`），抽屉的环节行与钻取块也正是靠
 * 这条对齐（derive.reportStageDetails 的注释）。仍加一道 type 闸门 —— 万一哪天
 * 两条通路不同序，宁可不画这张表，也不能把 A 环节的评估器摆到 B 环节名下。
 */
function drillSection(drill: StageDrilldown, stages: StageSummary[]): string[] {
  const summary = stages[drill.index];
  // type 闸门按钻取块自己的侧别走：摘要数组与钻取块万一不同序，宁可不画表，
  // 也不能把 A 环节的评估器摆到 B 环节名下（也不能拿 dataset 的表刑量 observe）
  const matched = summary?.type === drill.type ? summary : undefined;
  const L: string[] = [];
  L.push(`## ${drill.label}环节明细${drill.dataset ? ` · ${drill.dataset}` : ""}`, "");
  if (drill.analysis) L.push("**环节分析**", "", drill.analysis, "");
  L.push(...(drill.type === "observe"
    ? observeEvaluatorTable(matched) : evaluatorTable(matched)));
  L.push(...caseSummary(drill.cases));
  L.push(...sessionSummary(drill.sessions));
  return L;
}

/** 抽屉数据 → Markdown 全文（纯函数，无 DOM）。 */
export function buildReportMarkdown(i: ReportExportInput): string {
  const d = i.detail;
  const planName = (d?.plan_name ?? "").trim() || i.planId || "未命名评估计划";
  const [warn, sourceNote] = reportProvenance(d);
  const L: string[] = [];

  L.push(`# 运行报告 · ${planName}`, "");
  if (warn) L.push(`**注意**：${warn}`, "");

  L.push("## 运行信息", "");
  L.push(`- 评估计划：${planName}`);
  if (d?.agent_name) L.push(`- Agent：${d.agent_name}`);
  L.push(`- 运行：${i.seq != null ? `#${i.seq} · ` : ""}\`${i.runKey}\``);
  const finished = d?.finished_at ? ` → ${fmtRunTime(d.finished_at)}` : "";
  L.push(`- 开始时间：${fmtRunTime(i.startedAt)}${finished}`);
  L.push(`- 耗时：${fmtDuration(i.durationS)}`);
  L.push(`- 触发方式：${triggerLabel(i.triggeredBy)}`);
  L.push(`- 成本：${i.cost != null ? `$${i.cost.toFixed(2)}` : "—"}`);
  L.push(`- 结果：${resultLine(i)}`, "");

  // 提示引文与抽屉的两条提示条一字不差（nodata 空转 / partial·failed 讲清哪一环炸了）
  if (i.outcome.kind === "nodata") {
    L.push(
      "> 本次评估管道空转。报告是对「为什么没有数据」的分析，不是对 Agent " +
      "质量的判断 —— 既不代表通过，也不代表退步，不计入趋势与线上评估均分。",
      "",
    );
  }
  if (i.outcome.kind === "partial" || i.outcome.kind === "failed") {
    L.push(
      `> ${i.outcome.failedStages.join(" · ")}环节执行失败。` +
      (i.outcome.kind === "partial"
        ? "其余环节的结果可用，但本次结论不完整——失败环节的数据缺失，不能当作「通过」。"
        : "本次运行没有任何环节跑完，报告中的结论不可用。"),
      "",
    );
  }

  L.push("## 环节结果", "");
  if (i.stages.length === 0) L.push("本次运行没有环节数据。", "");
  else L.push(...i.stages.map(stageLine), "");

  L.push("## 综合结论", "");
  if (d?.synthesis_error) L.push(`综合报告生成失败：${d.synthesis_error}`, "");
  if (i.sections.length === 0) {
    if (!d?.synthesis_error) L.push("本次运行没有综合报告。", "");
  } else {
    for (const s of i.sections) {
      L.push(`### ${s.title}`, "");
      const body = s.body.trim();
      L.push(body || "（本节无正文）", "");
    }
  }

  // 环节明细（回归逐用例 + 线上评估逐会话）：放在综合结论之后，与屏幕上的
  // 先后一致（抽屉正文是综合报告分节 → 钻取块）。整块的存在性完全由数据决定
  // —— 老 run / 读不到 report 的 run 一节都不出，不留「本次运行没有明细」这类空话。
  for (const drill of i.drills ?? []) {
    const block = drillSection(drill, i.stages);
    // 只有标题、没有任何内容（既无分析、无 stats、无未通过用例）→ 整块不出
    if (block.length > 2) L.push(...block);
  }

  L.push("---", "");
  L.push(`数据来源：AgentGate ${sourceNote} · 导出时间 ${exportStamp(i.now ?? new Date())}`);
  return L.join("\n") + "\n";
}

/** DOM 边界：造 Blob → 点一次隐藏 <a download> → 回收 URL。
 *  单测把 createObjectURL / click 打桩即可，不依赖真实浏览器下载行为。 */
export function downloadTextFile(filename: string, text: string,
                                 mime = "text/markdown;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 让「导出中」禁用态先落到屏幕上再干重活（大报告拼串 + Blob 可能几十毫秒，
 *  点了没反应会被当成又一个死按钮）。rAF 缺失（老 jsdom）退回 setTimeout。 */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}
