// ③ 问题台账（ADR-0016 决定 1 ③：台账的单位是「问题」不是「段」）。五列表：
// 问题 · 根因 · 建议 · 采纳 · 效果 —— 一行横着走完闭环。
//
// 数据 = **这一次** run 的 `synthesis_issues[]`（契约「问题台账」）；分组：待建议
// （recommendation null）→ 未采纳（open）→ 已采纳待验证（adopted）→ 已解决（resolved，折叠）。
// 采纳格复用 compare/AnalysisSections 的 useAdoption（set_proposal_adopted；建议还没落成
// proposals 条目时走 adopt_run_advice）；「生成改进稿」复用 useGenerate + 确认卡。
// 「其他建议」组 = 计划各 run 的 proposals 里对不上任何台账建议的条目（例如刚生成的改进稿）：
// 不让付过钱的建议在 ③ 里消失。
//
// 界面零通用散文：静态字串只有表头 / 组名 / 状态词 / 动作词；每一句话都带这一次的数。
//
// 报告页专用的三个可选形态（批 badcase-ux-fix，默认全关、③ 优化页照旧）：`traceHref` 每条问题一个
// 「查看 trace」；`spanChips` 把问题文本里的 16 位十六进制 span id 渲成可点 chip —— 报告页再给
// `spanHref` 时 chip 是链接（点击 = 跳到运行详情那条会话的 trace 树并选中这条 span，`&span=` 深链；
// shift+点击 = 复制 id），没有 `spanHref`（或它给 null：问题没有会话证据、span 无处可定位）⇒ 点击复制；
// `foldSimilar` 把「同会话 + 同 fix_type + 建议前 40 字相同」的条目折成一组显示。
import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { EMPTY_MARK, textOf } from "../../../../lib/renderText";
import { clipText } from "../../../../lib/text";
import { Icon } from "../../../../components/layout/Icons";
import { showToast } from "../../../../components/toast";
import SynthesisText, { synthRefLabel } from "../../../../components/SynthesisText";
import {
  GenerateConfirmCard, useAdoption, useGenerate, type GenerateInput,
} from "../../../compare/AnalysisSections";
import { adoptionRows, type AdoptionRow } from "../../../plan/compare/derive";
import { sortRunsDesc } from "../../../plan/derive";
import type { IssueEvidence, PlanRunSummary, RunProposal, SynthesisIssue } from "../../../plan/types";
import { seqOf } from "./derive";
import {
  FIX_TYPE_LABEL, LEDGER_GROUP_LABEL, effectView, filterIssues, ledgerGroups, matchProposal,
  proposalMatchKey, type EffectView, type LedgerGroupKey,
} from "./optimizeDerive";

const ORDER: LedgerGroupKey[] = ["pending", "open", "adopted", "resolved"];

/** 表体的一维行清单（组头 / 领头 / 同类三种）——「四个组 × 折叠 × 同类」原来是三重嵌套 map，
 *  循环体里还现声明一个 20 个 props 的 rowOf 闭包，缩进到 18 空格。摊平后渲染只剩一层 map。 */
type LedgerRowItem =
  | { kind: "group"; key: string; group: LedgerGroupKey; count: number; collapsed: boolean }
  /** foldCount > 0 = 这一行是同类组的领头，`foldCount` 条同类折在它下面 */
  | { kind: "lead"; key: string; group: LedgerGroupKey; issue: SynthesisIssue; foldCount: number }
  | { kind: "more"; key: string; group: LedgerGroupKey; issue: SynthesisIssue; leadId: string };

/** 证据引用 → adopt_run_advice 的 refs 形态（「环节标签 · 行名」，后端取最后一段） */
function evidenceRef(ev: IssueEvidence): string {
  const stage = ev.kind === "case" ? "回归测试" : ev.kind === "session" ? "线上评估" : ev.kind === "redteam" ? "红队测试" : "";
  return stage ? `${stage} · ${ev.ref}` : ev.ref;
}

function evidenceLabel(ev: IssueEvidence): string {
  if (ev.kind === "session") return synthRefLabel({ kind: "session", id: ev.ref, msgNo: null });
  return ev.ref;
}

/** 独立成词的 16 位十六进制 = span id（OTel span id 的十六进制形态）。前后不许接字母数字或 `-`：
 *  会话 id `dsh-trace-e5d8fb96-…` 的 8/12 位段、`sess-<16hex>` 这种带前缀的会话 id 都不算。 */
const SPAN_ID_RE = /(?<![\w-])([0-9a-f]{16})(?![\w-])/g;

/** 文本里出现的 span id（去重、按出现顺序） */
export function spanIdsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SPAN_ID_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

async function copySpanId(id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(id);
    showToast("已复制 span id");
  } catch {
    showToast(`复制失败 · 请手动选中 ${id}`);
  }
}

/** `#/run/<key>?session=<sid>` 这类底座后面挂 `span=<id>`（已有查询串用 &，没有用 ?） */
export function withSpanParam(baseHref: string, spanId: string): string {
  return `${baseHref}${baseHref.includes("?") ? "&" : "?"}span=${encodeURIComponent(spanId)}`;
}

/** 问题文本：span id 就地替换成可点 chip，其余原样。
 *  有 href ⇒ <a>：点击跳 span 级深链，shift+点击复制；无 href ⇒ <button>：点击复制。 */
function ProblemText({ text, id, spanHref }: { text: string; id: string; spanHref?: (spanId: string) => string | null }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(SPAN_ID_RE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const sid = m[1];
    const href = spanHref?.(sid) ?? null;
    parts.push(href ? (
      <a
        key={`${at}-${sid}`}
        className="badge opt-span"
        href={href}
        title="在 trace 里定位到这个 span · shift+点击复制"
        data-testid={`${id}-span-${sid}`}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => {
          if (!e.shiftKey) return;
          e.preventDefault();
          void copySpanId(sid);
        }}
      >
        {sid}
      </a>
    ) : (
      <button
        key={`${at}-${sid}`}
        type="button"
        className="badge opt-span"
        title="在 trace 里按 span id 定位 · 点击复制"
        data-testid={`${id}-span-${sid}`}
        onClick={() => void copySpanId(sid)}
      >
        {sid}
      </button>
    ));
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** 同类键：同会话（session 证据集合）+ 同 fix_type + 建议前 40 字。没建议 / 没会话证据的条目不参与折叠。 */
export function similarKey(it: SynthesisIssue): string | null {
  const rec = (it.recommendation ?? "").trim();
  if (!rec) return null;
  const sessions = it.evidence.filter((e) => e.kind === "session").map((e) => e.ref).sort();
  if (sessions.length === 0) return null;
  return `${sessions.join(",")}|${it.fix_type ?? ""}|${rec.slice(0, 40)}`;
}

/** 折叠：首见的一条当领头，其余同键条目挂在它的 `more` 里（只改显示顺序与层级，不改数据） */
export function foldIssues(items: SynthesisIssue[]): { issue: SynthesisIssue; more: SynthesisIssue[] }[] {
  const out: { issue: SynthesisIssue; more: SynthesisIssue[] }[] = [];
  const lead = new Map<string, { issue: SynthesisIssue; more: SynthesisIssue[] }>();
  for (const it of items) {
    const k = similarKey(it);
    const hit = k ? lead.get(k) : undefined;
    if (hit) { hit.more.push(it); continue; }
    const entry = { issue: it, more: [] as SynthesisIssue[] };
    out.push(entry);
    if (k) lead.set(k, entry);
  }
  return out;
}

/**
 * 建议 → proposals 里那一条：`recommendation`（批 judge-zh 起是中文译文）与
 * `recommendation_source`（译前英文原话）**两把钥匙任一全等即命中**（契约「问题台账」
 * status 一栏）。只拿译文对会漏掉报告页从 `fix_recommendation` 原话采纳的历史英文记录
 * —— 那条记录的 summary 是英文，译文永远对不上。老台账没有 `recommendation_source`
 * 键（读回时后端当 recommendation 就是原话补上），undefined 走第二把钥匙时自然落空。
 */
export function matchIssueProposal(
  runs: PlanRunSummary[] | undefined, it: Pick<SynthesisIssue, "recommendation" | "recommendation_source">,
) {
  return matchProposal(runs, it.recommendation)
    ?? (it.recommendation_source ? matchProposal(runs, it.recommendation_source) : null);
}

export default function IssueLedger({
  issues, thisKey, thisSeq, planId, planRuns, filter, onFilter, onClearFilter, generate, onJumpEvidence,
  title = "问题台账", evidenceHref, showOthers = true, traceHref, spanChips = false, spanHref, foldSimilar = false,
}: {
  issues: SynthesisIssue[];
  thisKey: string;
  thisSeq: number | null;
  planId: string;
  planRuns: PlanRunSummary[];
  filter: string | null;
  onFilter: (name: string) => void;
  onClearFilter: () => void;
  /** null = 这一次没有可依据的会话 ⇒ 「生成改进稿」入口整块不画 */
  generate: GenerateInput | null;
  /** 证据 chip → 该 run 的报告 */
  onJumpEvidence: (ev: IssueEvidence) => void;
  /** 卡头标题（报告页写「问题条目」——那一页只列这一次 run 的条目；默认「问题台账」） */
  title?: string;
  /** 证据 chip 的深链（报告页：同页矩阵行锚点）。给了且返回非空 ⇒ 渲染成 <a href>，
   *  点击仍回调 onJumpEvidence；不给 / 返回 null ⇒ 原来的按钮形态。 */
  evidenceHref?: (ev: IssueEvidence) => string | null;
  /** 「其他建议」组（计划各 run 里对不上台账的 proposals）；报告页只讲本次 ⇒ 关掉 */
  showOthers?: boolean;
  /** 每条问题的「查看 trace」链接（报告页：有会话证据 ⇒ `#/run/<run_key>?session=<首条会话 id>` 会话级；
   *  只有用例证据 ⇒ 页脚同一构造 `#/run/<run_key>` run 级——构造与 title 都由调用方给）；不给 ⇒ 不画 */
  traceHref?: (issue: SynthesisIssue) => { href: string; title: string } | null;
  /** 问题文本里的 span id 渲成可点 chip；默认关。配 `spanHref` 时 chip 是 span 级深链，否则点击复制 + toast */
  spanChips?: boolean;
  /** 某条问题里某个 span id 的深链（`#/run/<key>?session=<sid>&span=<id>`）；null ⇒ 这条问题没有会话可定位 */
  spanHref?: (it: SynthesisIssue, spanId: string) => string | null;
  /** 「同会话 + 同 fix_type + 建议前 40 字相同」折成一组、默认收起（只是展示折叠，台账数据不动）；默认关 */
  foldSimilar?: boolean;
}) {
  const { adoptedAt, adopting, errors, adopt, adoptAdvice } = useAdoption(planId);
  const gen = useGenerate(planId);
  const [showResolved, setShowResolved] = useState(false);
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const toggleFold = (leadId: string) => setUnfolded((prev) => {
    const next = new Set(prev);
    if (next.has(leadId)) next.delete(leadId); else next.add(leadId);
    return next;
  });

  const adoptedNow = useMemo(() => new Set(Object.keys(adoptedAt)), [adoptedAt]);
  const groups = useMemo(() => ledgerGroups(issues, thisKey, adoptedNow), [issues, thisKey, adoptedNow]);
  const visible = useMemo(() => filterIssues(issues, filter), [issues, filter]);
  const visibleIds = useMemo(() => new Set(visible.map((it) => it.id)), [visible]);
  const byId = useMemo(() => new Map(issues.map((it) => [it.id, it] as const)), [issues]);
  const openCount = groups.pending.length + groups.open.length;

  // 表体行清单：组序 → 组头 → （折叠组收起时到此为止）→ 领头 + 它的同类。
  // 折叠开关态（unfolded）**不进**这份清单 —— 它只决定 more 行画不画，进来会让每次展开都重算。
  const rowItems = useMemo<LedgerRowItem[]>(() => {
    const out: LedgerRowItem[] = [];
    for (const g of ORDER) {
      const items = groups[g].filter((it) => visibleIds.has(it.id));
      if (items.length === 0) continue;
      const collapsed = g === "resolved" && !showResolved;
      out.push({ kind: "group", key: `group-${g}`, group: g, count: items.length, collapsed });
      if (collapsed) continue;
      const folded = foldSimilar ? foldIssues(items) : items.map((it) => ({ issue: it, more: [] as SynthesisIssue[] }));
      for (const { issue, more } of folded) {
        out.push({ kind: "lead", key: issue.id, group: g, issue, foldCount: more.length });
        for (const it of more) out.push({ kind: "more", key: it.id, group: g, issue: it, leadId: issue.id });
      }
    }
    return out;
  }, [groups, visibleIds, foldSimilar, showResolved]);

  // 「其他建议」：计划各 run 的 proposals 里对不上任何台账建议的条目（译文与原话两把钥匙都算对上）
  const recKeys = new Set(issues
    .flatMap((it) => [proposalMatchKey(it.recommendation), proposalMatchKey(it.recommendation_source)])
    .filter(Boolean));
  const others = adoptionRows(planRuns, () => 0);
  const otherRows = [...others.pending, ...others.done]
    .filter((r) => !recKeys.has(proposalMatchKey(r.summary)));

  const jumpTo = (id: string) => {
    const el = document.getElementById(`agent-issue-${id}`);
    el?.scrollIntoView?.({ block: "center" });
    (el as HTMLElement | null)?.focus?.();
  };

  const adoptIssue = (it: SynthesisIssue) => {
    if (!it.recommendation) return;
    const m = matchIssueProposal(planRuns, it);
    if (m) void adopt(m.runKey, m.index, it.id);
    else void adoptAdvice(thisKey, it.recommendation, it.evidence.map(evidenceRef), it.id);
  };

  const total = issues.length;
  return (
    <section className="card opt-ledger" data-testid="agent-issue-ledger" aria-label={title}>
      <div className="card-head">
        <span className="card-title">{title}</span>
        {filter ? (
          <>
            <span className="card-sub" data-testid="agent-ledger-sub">{visible.length} 条</span>
            <span className="chip" aria-pressed="true" data-testid="agent-ledger-filter">来源：{filter}</span>
            <button type="button" className="btn-link" data-testid="agent-ledger-clear" onClick={onClearFilter}>清除</button>
          </>
        ) : (
          <span className="card-sub" data-testid="agent-ledger-sub">{total} 条 · {openCount} 条待处理</span>
        )}
        {generate && (
          <>
            <span className="spacer" />
            <button
              type="button"
              className="btn-link"
              disabled={gen.phase === "loading"}
              data-testid="agent-ledger-generate"
              onClick={gen.open}
            >
              {gen.phase === "loading" ? "生成中…" : "生成改进稿"}
            </button>
          </>
        )}
      </div>
      {gen.error && <p className="opt-gen-error" data-testid="agent-ledger-generate-error">{gen.error}</p>}
      {generate && (
        <GenerateConfirmCard
          generate={generate}
          open={gen.phase === "confirm"}
          onConfirm={() => void gen.run(generate)}
          onCancel={gen.cancel}
        />
      )}
      <table className="u-table opt-ledger-table">
        <colgroup>
          <col className="c1" /><col className="c2" /><col className="c3" /><col className="c4" /><col className="c5" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">问题</th>
            <th scope="col">根因</th>
            <th scope="col">建议</th>
            <th scope="col">采纳</th>
            <th scope="col">效果</th>
          </tr>
        </thead>
        <tbody>
          {rowItems.map((r) => {
            if (r.kind === "group") {
              return (
                <tr key={r.key} className="opt-group" data-testid={`agent-ledger-group-${r.group}`}>
                  <td colSpan={5}>
                    {LEDGER_GROUP_LABEL[r.group]}<span className="cnt">{r.count}</span>
                    {r.group === "resolved" && (
                      <button
                        type="button"
                        className="btn-link opt-toggle"
                        data-testid="agent-ledger-toggle-resolved"
                        onClick={() => setShowResolved((v) => !v)}
                      >
                        {r.collapsed ? `展开 ${r.count} 条` : "收起"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            }
            // 同类行只在领头展开时画（折叠态下它不进 DOM，与折叠前同形）
            if (r.kind === "more" && !unfolded.has(r.leadId)) return null;
            const it = r.issue;
            return (
              <IssueRow
                key={r.key}
                issue={it}
                group={r.group}
                thisKey={thisKey}
                thisSeq={thisSeq}
                planRuns={planRuns}
                byId={byId}
                filter={filter}
                onFilter={onFilter}
                onJumpEvidence={onJumpEvidence}
                evidenceHref={evidenceHref}
                onJumpIssue={jumpTo}
                adoptedNowAt={adoptedAt[it.id]}
                adopting={adopting === it.id}
                busy={adopting != null}
                error={errors[it.id]}
                onAdopt={() => adoptIssue(it)}
                generate={generate}
                genPhase={gen.phase}
                onGenerate={gen.open}
                traceLink={traceHref?.(it) ?? null}
                spanChips={spanChips}
                spanHref={spanHref ? (sid) => spanHref(it, sid) : undefined}
                fold={r.kind === "lead" && r.foldCount > 0
                  ? { count: r.foldCount, open: unfolded.has(it.id), onToggle: () => toggleFold(it.id) }
                  : null}
              />
            );
          })}
          {visible.length === 0 && filter && (
            <tr className="opt-empty" data-testid="agent-ledger-empty">
              <td colSpan={5}>{filter} · run{thisSeq != null ? ` #${thisSeq}` : ""} 无关联问题</td>
            </tr>
          )}
          {!filter && showOthers && otherRows.length > 0 && (
            <>
              <tr className="opt-group" data-testid="agent-ledger-group-others">
                <td colSpan={5}>其他建议<span className="cnt">{otherRows.length}</span></td>
              </tr>
              {otherRows.map((row) => (
                <OtherRow
                  key={`${row.runKey}|${row.index}`}
                  row={row}
                  planRuns={planRuns}
                  thisSeq={thisSeq}
                  adoptedNowAt={adoptedAt[`${row.runKey}|${row.index}`]}
                  adopting={adopting === `${row.runKey}|${row.index}`}
                  busy={adopting != null}
                  error={errors[`${row.runKey}|${row.index}`]}
                  onAdopt={() => void adopt(row.runKey, row.index, `${row.runKey}|${row.index}`)}
                />
              ))}
            </>
          )}
        </tbody>
      </table>
    </section>
  );
}

/** 效果格的取数：本会话刚采纳成功、但归档里还没有 adoption_effect ⇒ 覆盖成「待验证」；
 *  否则读归档（effectView）。台账行与「其他建议」行同一句判断。 */
function effectNow(nowAt: string | undefined, persistedAt: string | undefined, p: RunProposal | null | undefined): EffectView {
  return nowAt && !persistedAt
    ? { kind: "pending", lines: [], reason: null }
    : effectView(p);
}

/** 效果格正文（第五列）：六态一处摆完 —— 台账行与「其他建议」行只差两个可选槽。
 *  `extra` = unchanged/regressed 时跟在数后面的东西（台账行的依赖 chip）；
 *  `legacy` = 没有 adoption_effect 时的老形态效果句（overview.adoption_note.score_changes）。
 *  `<td>` 与 data-testid 留在调用方 —— 现有断言按 `-effect` 取的就是那个 td。 */
function EffectCell({ effect, thisSeq, extra = null, legacy = [] }: {
  effect: EffectView;
  thisSeq: number | null;
  extra?: ReactNode;
  legacy?: string[];
}) {
  const nums = (lines: string[]) => lines.map((t, i) => <span className="opt-effect-num" key={i}>{t}</span>);
  return (
    <>
      {effect.kind === "pending" && (
        <span className="opt-faint">待 run{thisSeq != null ? ` #${thisSeq + 1}` : ""} 验证</span>
      )}
      {effect.kind === "improved" && nums(effect.lines)}
      {(effect.kind === "unchanged" || effect.kind === "regressed") && (
        <>
          <span className="opt-warn-text">{effect.kind === "unchanged" ? "无效" : "退步"}</span>
          {nums(effect.lines)}
          {extra}
        </>
      )}
      {effect.kind === "inconclusive" && (
        <>
          <span className="opt-faint">无法判定</span>
          {effect.reason && <span className="opt-sub">{effect.reason}</span>}
        </>
      )}
      {effect.kind === "none" && (legacy.length > 0
        ? nums(legacy)
        : <span className="opt-faint">{EMPTY_MARK}</span>)}
    </>
  );
}

function IssueRow({
  issue: it, group, thisKey, thisSeq, planRuns, byId, filter, onFilter, onJumpEvidence, evidenceHref, onJumpIssue,
  adoptedNowAt, adopting, busy, error, onAdopt, generate, genPhase, onGenerate,
  traceLink = null, spanChips = false, spanHref, fold = null,
}: {
  issue: SynthesisIssue;
  group: LedgerGroupKey;
  thisKey: string;
  thisSeq: number | null;
  planRuns: PlanRunSummary[];
  byId: Map<string, SynthesisIssue>;
  filter: string | null;
  onFilter: (name: string) => void;
  onJumpEvidence: (ev: IssueEvidence) => void;
  evidenceHref?: (ev: IssueEvidence) => string | null;
  onJumpIssue: (id: string) => void;
  /** 本会话刚采纳成功的时刻（空 = 没有） */
  adoptedNowAt?: string;
  adopting: boolean;
  busy: boolean;
  error?: string;
  onAdopt: () => void;
  generate: GenerateInput | null;
  genPhase: "idle" | "confirm" | "loading";
  onGenerate: () => void;
  /** 「查看 trace」链接（报告页给）；null ⇒ 不画 */
  traceLink?: { href: string; title: string } | null;
  spanChips?: boolean;
  spanHref?: (spanId: string) => string | null;
  /** 这一行是同类组的领头：`count` 条同类折在它下面（null ⇒ 不是领头 / 没同类） */
  fold?: { count: number; open: boolean; onToggle: () => void } | null;
}) {
  const id = `agent-issue-${it.id}`;
  const matched = matchIssueProposal(planRuns, it);
  const adoptedAt = adoptedNowAt ?? matched?.adoptedAt ?? "";
  const effect = effectNow(adoptedNowAt, matched?.adoptedAt, matched?.proposal);
  const isNew = it.first_seen_run === thisKey;
  const firstSeq = seqOf(planRuns, it.first_seen_run);
  const measuredSeq = seqOf(planRuns, matched?.proposal?.adoption_effect?.measured_run);
  const measuredRun = matched?.proposal?.adoption_effect?.measured_run
    ? planRuns.find((r) => r.run_key === matched.proposal.adoption_effect?.measured_run) : undefined;
  const measuredVersion = (measuredRun?.agent_version_label ?? "").trim();
  const deps = (it.depends_on ?? []).map((d) => byId.get(d)).filter((d): d is SynthesisIssue => !!d);
  const depsInEffect = effect.kind === "unchanged" || effect.kind === "regressed";
  const depChips = deps.length > 0 && (
    <span className="opt-deps" data-testid={`${id}-deps`}>
      <span className="k">依赖</span>
      {deps.map((d) => (
        <button
          key={d.id}
          type="button"
          className="badge opt-dep"
          data-testid={`${id}-dep-${d.id}`}
          title={d.problem}
          onClick={() => onJumpIssue(d.id)}
        >
          {clip(d.problem, 18)}
        </button>
      ))}
    </span>
  );
  return (
    <>
      <tr id={id} tabIndex={-1} className="opt-issue" data-testid={id} data-group={group}>
        <td className="c1">
          <div className="opt-p-title">{spanChips ? <ProblemText text={it.problem} id={id} spanHref={spanHref} /> : it.problem}</div>
          <div className="opt-p-meta">
            {isNew ? (
              <span className="badge opt-new" data-testid={`${id}-round`}>本次新增</span>
            ) : (
              <span className="badge badge-mono" data-testid={`${id}-round`}>
                {firstSeq != null ? `自 #${firstSeq} 持续 · ` : "持续 "}{it.occurrences} 次
              </span>
            )}
            {it.evidence.map((ev) => {
              const href = evidenceHref?.(ev) ?? null;
              return href ? (
                <a
                  key={`${ev.kind}|${ev.ref}`}
                  className="badge opt-ref"
                  href={href}
                  data-testid={`${id}-evidence`}
                  data-ref={ev.ref}
                  // 页内跳转自己做；拦住浏览器默认的锚点导航 —— 否则 hash 被改写，路由器认不出就落回首页。
                  // href 仍留着：悬停可见、可复制、中键新开。
                  onClick={(e: MouseEvent<HTMLAnchorElement>) => { e.preventDefault(); onJumpEvidence(ev); }}
                >
                  {evidenceLabel(ev)}
                </a>
              ) : (
                <button
                  key={`${ev.kind}|${ev.ref}`}
                  type="button"
                  className="badge opt-ref"
                  data-testid={`${id}-evidence`}
                  data-ref={ev.ref}
                  onClick={() => onJumpEvidence(ev)}
                >
                  {evidenceLabel(ev)}
                </button>
              );
            })}
            {traceLink && (
              <a
                className="badge opt-ref opt-trace"
                href={traceLink.href}
                title={traceLink.title}
                data-testid={`${id}-trace`}
              >
                <Icon name="ext" className="ic-sm" />查看 trace
              </a>
            )}
            {fold && (
              <button
                type="button"
                className="btn-link opt-fold"
                aria-expanded={fold.open}
                data-testid={`${id}-fold`}
                onClick={fold.onToggle}
              >
                {fold.open ? `收起 ${fold.count} 条同类` : `另有 ${fold.count} 条同类`}
              </button>
            )}
          </div>
          <div className="opt-p-src">
            <span className="k">来源</span>
            {it.evaluators.length === 0
              ? <span className="opt-faint">—</span>
              : it.evaluators.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="chip"
                  aria-pressed={filter === name}
                  data-testid={`${id}-evaluator`}
                  onClick={() => onFilter(name)}
                >
                  {name}
                </button>
              ))}
            {!depsInEffect && depChips}
          </div>
        </td>
        <td className="c2">{textOf(it.root_cause).trim() || <span className="opt-faint">{EMPTY_MARK}</span>}</td>
        <td className="c3" data-testid={`${id}-fix`}>
          {it.recommendation ? (
            <>
              {it.fix_type && <span className="opt-fixtype">{FIX_TYPE_LABEL[it.fix_type] ?? it.fix_type}</span>}
              {it.recommendation}
            </>
          ) : generate ? (
            <button
              type="button"
              className="btn-link"
              disabled={genPhase === "loading"}
              data-testid={`${id}-generate`}
              onClick={onGenerate}
            >
              {genPhase === "loading" ? "生成中…" : "生成改进稿"}
            </button>
          ) : (
            <span className="opt-faint">{EMPTY_MARK}</span>
          )}
        </td>
        <td className="c4" data-testid={`${id}-adopt`}>
          {adoptedAt ? (
            <>
              <span className="badge ok">已采纳</span>
              <span className="opt-sub mono">{adoptedAt}</span>
              {measuredSeq != null && (
                <span className="opt-sub mono" data-testid={`${id}-measured`}>
                  {measuredVersion ? `${measuredVersion} · ` : ""}run #{measuredSeq}
                </span>
              )}
            </>
          ) : it.recommendation ? (
            <button
              type="button"
              className="btn-link"
              disabled={busy}
              data-testid={`${id}-adopt-btn`}
              onClick={onAdopt}
            >
              {adopting ? "标记中…" : "采纳"}
            </button>
          ) : (
            <span className="opt-faint">{EMPTY_MARK}</span>
          )}
        </td>
        <td className="c5" data-testid={`${id}-effect`}>
          <EffectCell effect={effect} thisSeq={thisSeq} extra={depChips} />
        </td>
      </tr>
      {error && (
        <tr className="opt-row-error">
          <td colSpan={5} data-testid={`${id}-error`}>{error}</td>
        </tr>
      )}
    </>
  );
}

/** 「其他建议」行：proposals 条目原样（摘要 / 生成于 / 采纳 / 效果） */
function OtherRow({ row, planRuns, thisSeq, adoptedNowAt, adopting, busy, error, onAdopt }: {
  row: AdoptionRow;
  planRuns: PlanRunSummary[];
  thisSeq: number | null;
  adoptedNowAt?: string;
  adopting: boolean;
  busy: boolean;
  error?: string;
  onAdopt: () => void;
}) {
  const id = `agent-other-${row.runKey}-${row.index}`;
  const adoptedAt = adoptedNowAt ?? row.adoptedAt;
  const run = sortRunsDesc(planRuns).find((r) => r.run_key === row.runKey);
  const proposal = run?.proposals?.[row.index];
  const effect = effectNow(adoptedNowAt, row.adoptedAt, proposal);
  // 老形态的效果句（overview.adoption_note.score_changes）：没有 adoption_effect 时用它
  const legacy = effect.kind === "none" ? row.effect : [];
  return (
    <>
      <tr className="opt-issue" data-testid={id}>
        <td className="c1"><span className="opt-faint">{EMPTY_MARK}</span></td>
        <td className="c2"><span className="opt-faint">{EMPTY_MARK}</span></td>
        <td className="c3">
          <span className="opt-other-sum">{row.summary ? <SynthesisText text={row.summary} /> : EMPTY_MARK}</span>
          <span className="opt-sub mono">
            {row.seq != null ? `#${row.seq} · ` : ""}{row.generatedAt || EMPTY_MARK}
          </span>
        </td>
        <td className="c4" data-testid={`${id}-adopt`}>
          {adoptedAt ? (
            <>
              <span className="badge ok">已采纳</span>
              <span className="opt-sub mono">{adoptedAt}</span>
            </>
          ) : (
            <button type="button" className="btn-link" disabled={busy} data-testid={`${id}-adopt-btn`} onClick={onAdopt}>
              {adopting ? "标记中…" : "采纳"}
            </button>
          )}
        </td>
        <td className="c5" data-testid={`${id}-effect`}>
          <EffectCell effect={effect} thisSeq={thisSeq} legacy={legacy} />
        </td>
      </tr>
      {error && (
        <tr className="opt-row-error">
          <td colSpan={5} data-testid={`${id}-error`}>{error}</td>
        </tr>
      )}
    </>
  );
}

function clip(s: string, n: number): string {
  return clipText(textOf(s).trim(), n);
}
