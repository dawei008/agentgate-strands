// 坏例入数据集 + 人工标注（ADR-0017 D1 / D2）的**纯函数层**：哪一格算坏例、
// 去重键、默认目标集、用例形状、反查「已入集」。零 JSX，便于直测；抽屉与矩阵
// 只消费这里的结果，不各算一遍。
//
// 口径（ADR-0017 D1）：
//   · 坏例来源只有两类：observe 行「判未过且非 errored」的格 → regression 集；
//     redteam 行「攻破」→ redteam 集。dataset 行的未过用例本来就在集里，**不给入口**。
//   · 去重键 = input strip → 连续空白折一个空格 → casefold 全等（与后端同一规则）。
//   · 默认目标集 `<agent>-badcases`（regression）/ `<agent>-badcases-rt`（redteam）。
//   · name = `<run 短号>-<行名短号>`，不参与去重。
import type { CaseVerdict } from "../plan/derive";
import { shortSessionId, type ReportGroup, type ReportRow } from "../plan/reportRows";
import type { DatasetLite } from "../plan/types";
import type { CaseAnnotation, CaseSource, IntakeCase } from "../../lib/apiTypes";
import { fmtTime } from "../../lib/time";

export type IntakeKind = "regression" | "redteam";

/** 一格是不是坏例：判未过且非 errored（与 model.ts / reportRows 的「未过」同一判定） */
export function isBadVerdict(v: CaseVerdict | null | undefined): boolean {
  return !!v && !v.errored && v.passed === false;
}

/** 行上所有未过的判定（errored 剔除） */
export function failedVerdicts(row: ReportRow): CaseVerdict[] {
  return row.verdicts.filter((v) => isBadVerdict(v));
}

/** 这一行能不能入集（ADR D1 两类来源）；dataset 行恒 false */
export function isIntakeRow(group: ReportGroup, row: ReportRow): boolean {
  if (group.type === "observe") return failedVerdicts(row).length > 0;
  if (group.type === "redteam") return row.breached === true;
  return false;
}

export function intakeKindOf(group: ReportGroup): IntakeKind | null {
  if (group.type === "observe") return "regression";
  if (group.type === "redteam") return "redteam";
  return null;
}

/** 一个待入集的坏例（矩阵行 → 抽屉的输入） */
export interface IntakeItem {
  gi: number;
  row: ReportRow;
  kind: IntakeKind;
  /** source.kind */
  sourceKind: CaseSource["kind"];
  /** 用户输入（会话 = 首条用户输入；攻击 = 红队首条攻击话术，缺则攻击目的）——也是去重键的料 */
  input: string;
  /** 仅攻击：攻击目的（后端把 objective 同步写到红队集的 actor_goal，两键都存） */
  objective?: string;
  /** Agent 实际回复（期望输出的**错答草稿**） */
  reply: string;
  failed: CaseVerdict[];
}

const AGENT_TAG = "【Agent】";
const ATTACKER_TAG = "【红队】";

/** 红队攻击对话（conversationText 拼出来的角色标注行）里最后一条 Agent 回复 */
export function lastAgentLine(conversation: string): string {
  const lines = conversation.split("\n").filter((l) => l.startsWith(AGENT_TAG));
  return lines.length ? lines[lines.length - 1].slice(AGENT_TAG.length) : "";
}

/** 红队攻击对话里第一条攻击话术（红队集用例的 input 就是它） */
export function firstAttackerLine(conversation: string): string {
  const hit = conversation.split("\n").find((l) => l.startsWith(ATTACKER_TAG));
  return hit ? hit.slice(ATTACKER_TAG.length) : "";
}

export function intakeItemOf(group: ReportGroup, row: ReportRow): IntakeItem | null {
  const kind = intakeKindOf(group);
  if (!kind || !isIntakeRow(group, row)) return null;
  if (kind === "regression") {
    return {
      gi: group.index, row, kind, sourceKind: "session",
      input: row.prompt ?? "", reply: row.reply ?? row.output, failed: failedVerdicts(row),
    };
  }
  return {
    gi: group.index, row, kind, sourceKind: "attack",
    input: firstAttackerLine(row.conversation) || row.input, objective: row.input,
    reply: lastAgentLine(row.conversation), failed: failedVerdicts(row),
  };
}

/** 本次 run 全部可入集的行（页脚计数 / 批量态清单），按矩阵原序 */
export function intakeItems(groups: ReportGroup[]): IntakeItem[] {
  const out: IntakeItem[] = [];
  for (const g of groups) {
    const rows = [...g.rows].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const r of rows) {
      const it = intakeItemOf(g, r);
      if (it) out.push(it);
    }
  }
  return out;
}

/** 页脚入口 / 抽屉标题共用的「范围」短语：N 个未过会话 · M 个被攻破攻击（只有一类时只说那一类） */
function intakeScope(items: IntakeItem[]): { sessions: number; attacks: number; scope: string } {
  const sessions = items.filter((i) => i.sourceKind === "session").length;
  const attacks = items.length - sessions;
  const scope = attacks === 0 ? `${sessions} 个未过会话`
    : sessions === 0 ? `${attacks} 个被攻破攻击`
      : `${sessions} 个未过会话 · ${attacks} 个被攻破攻击`;
  return { sessions, attacks, scope };
}

/** 页脚入口文案：「从 N 个未过会话中选择加入数据集…」—— 末尾省略号 = 点了会打开选择，不是一键全加
 *  （用户 2026-09-07 现网反馈：旧文案「把本次 N 个未过会话加入数据集」读成全加）。空 ⇒ null（不画入口）。 */
export function intakeEntryLabel(items: IntakeItem[]): string | null {
  if (items.length === 0) return null;
  return `从 ${intakeScope(items).scope}中选择加入数据集…`;
}

/** 批量抽屉标题：「选择要加入数据集的会话」（只有攻击 ⇒ 攻击；两类都有 ⇒ 会话与攻击） */
export function intakeDrawerTitle(items: IntakeItem[]): string {
  const { sessions, attacks } = intakeScope(items);
  const what = attacks === 0 ? "会话" : sessions === 0 ? "攻击" : "会话与攻击";
  return `选择要加入数据集的${what}`;
}

/** 去重键：strip → 连续空白折一个空格 → casefold（与后端 append_dataset_cases 同一规则） */
export function normalizeInput(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export function defaultDatasetName(agent: string, kind: IntakeKind): string {
  const base = agent.trim() || "agent";
  return kind === "redteam" ? `${base}-badcases-rt` : `${base}-badcases`;
}

/** run 短号 = run_key 的 `#` 后半（时间戳）；没有 `#` 时用整串 */
export function runShortId(runKey: string): string {
  const i = runKey.indexOf("#");
  return i >= 0 ? runKey.slice(i + 1) : runKey;
}

export function caseNameOf(runKey: string, item: IntakeItem): string {
  const rowShort = item.sourceKind === "session" ? shortSessionId(item.row.name) : item.row.name;
  return `${runShortId(runKey)}-${rowShort}`;
}

/** 数据集里已有用例（按去重键索引）：值 = 该用例原物（取 expected_output 作「集内现值」） */
export type CaseIndex = Map<string, Record<string, unknown>>;

export function caseIndexOf(ds: DatasetLite | null | undefined): CaseIndex {
  const idx: CaseIndex = new Map();
  for (const c of ds?.cases ?? []) {
    const input = typeof c.input === "string" ? c.input : "";
    if (!input.trim()) continue;
    const k = normalizeInput(input);
    if (!idx.has(k)) idx.set(k, c as Record<string, unknown>);
  }
  return idx;
}

/** 同题面是否已在集内（去重预判）；命中回该用例原物 */
export function existingCaseOf(idx: CaseIndex, input: string): Record<string, unknown> | null {
  return idx.get(normalizeInput(input)) ?? null;
}

/** 这个 run 已入集的行名集合：遍历所有数据集用例的 source.run_key（刷新后「已入集」靠它） */
export function addedRowKeys(datasets: DatasetLite[] | null | undefined, runKey: string): Set<string> {
  const out = new Set<string>();
  for (const d of datasets ?? []) {
    for (const c of d.cases ?? []) {
      const src = (c as { source?: unknown }).source as Partial<CaseSource> | undefined;
      if (src && typeof src === "object" && src.run_key === runKey && typeof src.row_key === "string") {
        out.add(src.row_key);
      }
    }
  }
  return out;
}

/** 未过判定里最低的分（source.score）；一个都没有数 → null */
export function worstScore(failed: CaseVerdict[]): number | null {
  const nums = failed.map((v) => v.score).filter((s): s is number => typeof s === "number");
  return nums.length ? Math.min(...nums) : null;
}

export function buildCase(args: {
  runKey: string;
  item: IntakeItem;
  expected: string;
  humanScore?: 0 | 0.5 | 1 | null;
  notes?: string;
  now?: Date;
}): IntakeCase {
  const { runKey, item, expected } = args;
  const source: CaseSource = {
    run_key: runKey,
    row_key: item.row.name,
    kind: item.sourceKind,
    evaluators_failed: item.failed.map((v) => v.name),
    score: worstScore(item.failed),
    added_at: (args.now ?? new Date()).toISOString(),
  };
  if (args.humanScore != null) source.human_score = args.humanScore;
  const out: IntakeCase = {
    name: caseNameOf(runKey, item),
    input: item.input,
    source,
  };
  // redteam 集不要求 expected_output（契约）：空就不带键；regression 由门（expectedBlockReason）保证非空
  if (expected.trim() || item.kind === "regression") out.expected_output = expected;
  if (item.sourceKind === "attack" && item.objective) out.objective = item.objective;
  const notes = (args.notes ?? "").trim();
  if (notes) out.notes = notes;
  return out;
}

/** 期望输出能不能提交：与错答草稿逐字相同 ⇒ 禁用（存错答等于固化缺陷）；regression 集为空也禁用
 *  （契约：`第 N 条 expected_output 为空` 整批拒）；redteam 集不要求 expected_output，空放行。
 *  可提交 ⇒ null。 */
export function expectedBlockReason(expected: string, draft: string, kind: IntakeKind = "regression"): string | null {
  if (!expected.trim()) return kind === "regression" ? "期望输出为空 · 「加入数据集」不可用" : null;
  if (expected === draft) return "未改动 · 「加入数据集」不可用";
  return null;
}

/** 标注索引键（行名 + 评估器 / overall） */
export function annotKey(rowKey: string, evaluator: string): string {
  return `${rowKey} ${evaluator}`;
}

export function annotationIndex(items: CaseAnnotation[] | null | undefined): Map<string, CaseAnnotation> {
  const m = new Map<string, CaseAnnotation>();
  for (const a of items ?? []) m.set(annotKey(a.row_key, a.evaluator), a);
  return m;
}

/** 人工分 → 展示串（0 / 0.5 / 1 原样，不补小数位） */
export function fmtHuman(score: number): string {
  return score === 0.5 ? "0.5" : String(score);
}

/** ISO 时间 → "YYYY-MM-DD HH:mm"（标注行的「已标注 · 0.5 · 时间」）。
 *
 *  排版走 lib/time.fmtTime：此前这里私写 `Date.parse` + `toISOString().slice(0,16)`，
 *  与 fmtTime 同形但丢了它攒的三道处理 —— 剥 `" UTC"` 后缀（后端 run 时间戳的真形态
 *  就带这个后缀，不剥会拼出 "…T09:00 UTCZ" → NaN）、认裸 epoch 串（Langfuse 源那族）、
 *  把数字 `0` 当缺失（后端「没有这个时间戳」的统一回退，照 1970 渲染等于编一个日期）。
 *  标注 at 现在只由前端写成 ISO，但同型副本就是靠「现在恰好用不上」活着的。 */
export function fmtAnnotAt(iso: string): string {
  return fmtTime(iso);
}
