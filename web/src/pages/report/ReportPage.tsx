// 运行报告独立页（`#/report/<run_key>`）· 变体 A「评估器优先」（批 report-redesign-a）。
//
// 为什么成页而不是把抽屉改宽：内容量决定容器 —— 评估器 tile + 行 × 评估器矩阵 +
// 逐格判定理由 + 问题条目，远超一屏；成页顺手买到可加书签、可后退、可发给同事。
// 计划详情里的报告抽屉（plan/ReportDrawer.tsx → ReportView）继续用旧视图，本批只改整页。
//
// 版面契约 = .scratch/report-redesign/variant-a-evaluators.html（用户 2026-09-04 选定），
// 自上而下：① 页头（PageHeader）+ 元信息 → ② 结论一句 → ③ hero 四格 → ④ 成本时延小条 →
// ⑤ 评估器 tile → ⑥ 行 × 评估器 矩阵（每环节一张卡）→ ⑦ 问题条目（复用 IssueLedger）→ ⑧ 页脚。
// 分数口径（CONTEXT.md「线上评估均分」词条 2026-09-03 修订）：决策看每个评估器过不过
// 0.70 目标线，不看合成均值；合成分只作评估器区标题旁的次要小字。
//
// 路由参数只有 run_key 一个（可分享的那一串就是它）；plan_id 是它的 `#` 前缀。
// 数据：get_plan_run（报告本体，唯一渲染闸门）+ list_plans / list_plan_runs（页头返回位、
// #N、← →、与上次对比 —— 都是增强，拉不到只降级不空白）。
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiOne, type ApiEvent } from "../../lib/api";
import type { AnnotationsEvent, CaseAnnotation } from "../../lib/apiTypes";
import { navigate } from "../../router";
import PageHeader from "../../components/layout/PageHeader";
import { agentTabHash } from "../agents/detail/hub/tabs";
import IssueLedger, { spanIdsOf, withSpanParam } from "../agents/detail/hub/IssueLedger";
import {
  SCORE_TARGET, reportDrilldowns, reportStages, sectionsOf, sortRunsDesc,
  triggerLabel, versionSnapshot, type StageLabelCtx,
} from "../plan/derive";
import { evidenceRowOf, matrixRowAnchor, reportGroups, runVerdict, shortSessionId } from "../plan/reportRows";
import { runNeighbors } from "../plan/ReportView";
import { comparableReason } from "../plan/compare/derive";
import { buildReportMarkdown, downloadTextFile, nextFrame, reportFileName } from "../plan/exportReport";
import type {
  DatasetsEvent, IssueEvidence, PlanRunDetail, PlanRunsEvent, PlansEvent, SynthesisIssue, SynthesisSection,
} from "../plan/types";
import { fmtDuration, runOutcome, stageLabel } from "../../lib/scoring";
import { fmtRunTime } from "../../lib/time";
import { EMPTY_MARK } from "../../lib/renderText";
import { costFactsOf, fmtCost } from "../../lib/cost";
import { f3, pageMetrics, pageVerdictFacts, rowTally, stageViews, traceTally } from "./model";
import VerdictLine from "./VerdictLine";
import { PerfBar, ReportHero } from "./ReportHero";
import EvaluatorTiles from "./EvaluatorTiles";
import StageMatrix, { type OpenCell } from "./StageMatrix";
import ReportFooter from "./ReportFooter";
import BadcaseDrawer, { type IntakeMode } from "./BadcaseDrawer";
import { addedRowKeys, annotationIndex, intakeEntryLabel, intakeItemOf, intakeItems } from "./badcase";
import "./report.css";

/** 路由参数 = run_key，可尾随 `?row=<行名>`（数据集页「来自 线上评估 run」chip 的深链落点）。
 *  路由层只认单参数，查询串留给本页自己切 —— run_key 自身不含 `?`。 */
export function splitReportId(id: string): { runKey: string; row: string | null } {
  const q = id.indexOf("?");
  if (q < 0) return { runKey: id, row: null };
  const params = new URLSearchParams(id.slice(q + 1));
  const row = params.get("row");
  return { runKey: id.slice(0, q), row: row && row.trim() ? row : null };
}

export default function ReportPage({ id: rawId }: { id: string }) {
  const { runKey: id, row: rowParam } = useMemo(() => splitReportId(rawId), [rawId]);
  // run_key = `<plan_id>#<ts>`。切前缀而不是再要一个路由参数 —— 同 run 详情页那一份读法。
  const planId = id.split("#")[0];

  const plansQuery = useQuery({
    queryKey: ["plans"],
    queryFn: () => apiOne<PlansEvent>({ action: "list_plans" }, "plans"),
  });
  // 运行历史：只为 `#N` 序号、← → 切换、与上次对比、问题条目对回 proposals 这几件**增强**。
  // 绝不当渲染闸门：报告本体由下面的 get_plan_run 独自决定。
  const runsQuery = useQuery({
    queryKey: ["plan_runs", planId],
    queryFn: () =>
      apiOne<PlanRunsEvent>({ action: "list_plan_runs", plan_id: planId }, "plan_runs"),
  });
  const plan = plansQuery.data?.plans.find((p) => p.plan_id === planId);
  const runs = useMemo(() => sortRunsDesc(runsQuery.data?.runs ?? []), [runsQuery.data]);

  // 当前正在看的 run：本地态 + replaceState 镜像到地址栏（不压历史、不触发路由重挂载）
  const [runKey, setRunKey] = useState(id);
  useEffect(() => { setRunKey(id); }, [id]);
  useEffect(() => {
    const target = `#/report/${encodeURIComponent(runKey)}`;
    if (window.location.hash !== target) window.history.replaceState(null, "", target);
  }, [runKey]);

  const { idx, seq, summary, older, newer } = runNeighbors(runs, runKey);

  // ← → 切换相邻 run（输入态与带修饰键的组合放过，同 ReportView）
  const navRef = useRef(setRunKey);
  navRef.current = setRunKey;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      const to = e.key === "ArrowLeft" ? older : newer;
      if (to) navRef.current(to.run_key);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [older, newer]);

  // ---- 报告本体（权威）----
  const query = useQuery({
    queryKey: ["plan_run", runKey],
    queryFn: () =>
      apiOne<PlanRunDetail & ApiEvent>({ action: "get_plan_run", run_key: runKey }, "plan_run"),
  });
  const d = query.data;
  const datasetsQuery = useQuery({
    queryKey: ["datasets"],
    queryFn: () => apiOne<DatasetsEvent>({ action: "list_datasets" }, "datasets"),
  });
  const labelCtx: StageLabelCtx = useMemo(() => ({
    planStages: plan?.stages,
    datasets: datasetsQuery.data?.datasets,
  }), [plan, datasetsQuery.data]);
  // 人工标注（ADR-0017 D2）：页面加载时拉一次；保存后就地写回缓存，不重拉
  const qc = useQueryClient();
  const annotationsQuery = useQuery({
    queryKey: ["annotations", runKey],
    queryFn: () => apiOne<AnnotationsEvent>({ action: "list_annotations", run_key: runKey }, "annotations"),
  });
  const annotations = useMemo(() => annotationIndex(annotationsQuery.data?.items), [annotationsQuery.data]);
  const onAnnotated = (a: CaseAnnotation) => {
    qc.setQueryData<AnnotationsEvent>(["annotations", runKey], (prev) => ({
      event: "annotations", run_key: runKey,
      items: [
        ...(prev?.items ?? []).filter((x) => !(x.row_key === a.row_key && x.evaluator === a.evaluator)),
        a,
      ],
    }));
  };

  const status = d?.status ?? summary?.status ?? "";
  const score = typeof d?.score === "number" ? d.score : summary?.score ?? null;
  const skipReason = d?.skip_reason ?? summary?.skip_reason ?? null;
  const stages = reportStages(d);
  const outcome = runOutcome({ status, score, stage_summaries: stages });
  const noData = outcome.kind === "nodata";

  const groups = useMemo(() => reportGroups(d), [d]);
  const views = useMemo(() => stageViews(groups, labelCtx), [groups, labelCtx]);
  const facts = useMemo(() => pageVerdictFacts(views), [views]);
  const fallbackVerdict = useMemo(
    () => runVerdict({ outcome, groups, skipReason }),
    [outcome, groups, skipReason],
  );
  const tally = useMemo(() => rowTally(views), [views]);
  const metrics = useMemo(() => pageMetrics(views), [views]);
  // 只用上报数据评估（ADR-0019 批 1）：开了开关且有用例缺 trace ⇒ 头部降级 badge
  const traces = useMemo(() => traceTally(views), [views]);
  const issues = useMemo(() => (Array.isArray(d?.synthesis_issues) ? d.synthesis_issues : []), [d]);

  // 成本（lib/cost 唯一口径）：total_cost_usd 是各环节有价部分之和；拆分 / 部分标记今天只在
  // S3 全量 report.stages[i].report 上（testrun 的 run 对象），DDB 摘要 stage_summaries 还没上浮
  // ⇒ 先读 report.stages，读不到再退到 reportStages（将来 planrun 上浮后那里也有）。
  // 观测环节的 metrics.cost.unpriced_models 同样让成本变「部分」（Agent 侧无价）。
  const cost = useMemo(() => {
    const full = costFactsOf(d?.report?.stages);
    const facts = full.breakdown == null && full.isPartial === undefined ? costFactsOf(stages) : full;
    return fmtCost(d?.total_cost_usd, facts.breakdown, facts.isPartial, { unpriced: metrics?.unpricedModels ?? [] });
  }, [d, stages, metrics]);
  const startedAt = d?.started_at ?? summary?.started_at;
  const durationS = d?.duration_s ?? summary?.duration_s;
  const triggeredBy = d?.triggered_by ?? summary?.triggered_by;
  const version = versionSnapshot(d, summary);
  const agentName = (d?.agent_name ?? plan?.agent_name ?? "").trim();

  // ---- 展开态 / 深链落点（都按 runKey 重置：换 run 不许带着上一份的格）----
  const [openCell, setOpenCell] = useState<OpenCell | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => { setOpenCell(null); setTarget(null); }, [runKey]);

  // ---- 坏例入集 / 人工标注抽屉（ADR-0017 D1）----
  const [intake, setIntake] = useState<IntakeMode | null>(null);
  const [intakeOpen, setIntakeOpen] = useState(false);
  // 本会话内刚入集的行名；与数据集 cases 的 source.run_key 反查取并集（刷新后仍显示）
  const [addedNow, setAddedNow] = useState<Set<string>>(() => new Set());
  useEffect(() => { setIntake(null); setIntakeOpen(false); setAddedNow(new Set()); }, [runKey]);
  const added = useMemo(() => {
    const s = addedRowKeys(datasetsQuery.data?.datasets, runKey);
    for (const k of addedNow) s.add(k);
    return s;
  }, [datasetsQuery.data, runKey, addedNow]);
  const items = useMemo(() => intakeItems(groups), [groups]);
  // 「从 N 个未过会话中选择加入数据集…」：省略号 = 打开选择抽屉（默认 0 勾），不是一键全加
  const intakeLabel = useMemo(() => intakeEntryLabel(items), [items]);
  const openIntake = (row: import("../plan/reportRows").ReportRow, col: string, focus: "dataset" | "annotate") => {
    const g = groups.find((x) => x.rows.some((r) => r.key === row.key));
    const item = g ? intakeItemOf(g, row) : null;
    if (!item) return;
    setIntake({ mode: "single", item, col, focus });
    setIntakeOpen(true);
  };
  const openIntakeAll = () => {
    if (items.length === 0) return;
    setIntake({ mode: "batch", items });
    setIntakeOpen(true);
  };

  // 深链 `?row=<行名>`：数据来了就定位到那一行（只在首次命中时滚一次）
  const rowParamDone = useRef<string | null>(null);
  useEffect(() => {
    if (!rowParam || rowParamDone.current === rowParam || groups.length === 0) return;
    for (const g of groups) {
      const hit = g.rows.find((r) => r.name === rowParam);
      if (!hit) continue;
      rowParamDone.current = rowParam;
      const anchorId = matrixRowAnchor(g.index, hit.name);
      setTarget(anchorId);
      document.getElementById(anchorId)?.scrollIntoView?.({ block: "center" });
      break;
    }
  }, [rowParam, groups]);
  const toggleCell = (cell: OpenCell) => setOpenCell((cur) =>
    cur && cur.gi === cell.gi && cur.rowKey === cell.rowKey && cur.col === cell.col ? null : cell);
  const jumpTo = (anchorId: string) => {
    setTarget(anchorId);
    const el = document.getElementById(anchorId);
    el?.scrollIntoView?.({ block: "center" });
  };
  // 证据 chip 的 href 必须是**路由器认得的地址**（本页 `?row=` 深链），不能是裸行锚点 `#rp-row-…`：
  // 真浏览器点 <a href="#rp-row-…"> 会把 location.hash 改成非路由串 ⇒ parseHash 认不出 ⇒ 落回首页
  //（用户 2026-09-07「问题台账没有和 trace 对应」的一半就是这个；jsdom 不跟随锚点导航，老测试没红）。
  // 点击本身由 IssueLedger preventDefault 后走 onJumpEvidence 页内滚动 + 高亮；href 留给复制 / 中键新开。
  const evidenceHref = (ev: IssueEvidence) => {
    const hit = evidenceRowOf(groups, ev);
    return hit ? `#/report/${encodeURIComponent(runKey)}?row=${encodeURIComponent(hit.row.name)}` : null;
  };
  const onJumpEvidence = (ev: IssueEvidence) => {
    const hit = evidenceRowOf(groups, ev);
    if (hit) jumpTo(matrixRowAnchor(hit.groupIndex, hit.row.name));
  };
  // 每条问题的「查看 trace」：页脚同一底座（`#/run/<run_key>`，运行详情三栏 trace 视图）+ 会话级深链：
  // 证据里有会话 id ⇒ `?session=<第一条会话的完整 id>`（RunDetailPage 预选并展开那条会话，见 router `run`）；
  // 多条会话时 title 追加「另 N 条见左栏」；没有会话证据（只有用例证据）⇒ 维持 run 级。
  // span 级：问题文本 / 证据里点名的 16 位十六进制 span id（spanIdsOf，与台账 chip 同一识别）取第一个，
  // 在会话深链后再挂 `&span=<id>`（RunDetailPage 在那条会话的 trace 树里选中它）；title 追加「· span <前 8 位>」。
  // run 级（没有会话）不挂 span——没有会话就无处定位。
  const sessionTraceBase = (it: SynthesisIssue) => {
    const sids = it.evidence.filter((e) => e.kind === "session" && e.ref).map((e) => e.ref);
    return sids.length === 0 ? null : { sids, href: `#/run/${encodeURIComponent(runKey)}?session=${encodeURIComponent(sids[0])}` };
  };
  const issueTraceHref = (it: SynthesisIssue) => {
    const base = sessionTraceBase(it);
    if (!base) {
      return {
        href: `#/run/${encodeURIComponent(runKey)}`,
        title: "运行详情 · run 级 trace · 左栏按环节展开对应行 · 在 trace 里按 span id 定位",
      };
    }
    const { sids } = base;
    const more = sids.length > 1 ? ` · 另 ${sids.length - 1} 条见左栏` : "";
    const spanId = spanIdsOf([it.problem, ...it.evidence.map((e) => e.ref)].join(" "))[0];
    return {
      href: spanId ? withSpanParam(base.href, spanId) : base.href,
      title: `运行详情 · 会话 ${shortSessionId(sids[0])} · 在 trace 里按 span id 定位${spanId ? ` · span ${spanId.slice(0, 8)}` : ""}${more}`,
    };
  };
  /** 台账 span chip 的深链：同一条问题的会话底座 + `&span=<这个 id>`；没有会话证据 ⇒ null（chip 退回复制） */
  const spanTraceHref = (it: SynthesisIssue, spanId: string) => {
    const base = sessionTraceBase(it);
    return base ? withSpanParam(base.href, spanId) : null;
  };
  const [issueFilter, setIssueFilter] = useState<string | null>(null);

  // ---- 与上次对比：往更早方向找最近一个可对比的 run（闸门同运行历史行）----
  const prevComparable = useMemo(() => {
    if (idx < 0) return null;
    for (let i = idx + 1; i < runs.length; i++) if (comparableReason(runs[i]) == null) return runs[i];
    return null;
  }, [idx, runs]);
  const compareBlocked = comparableReason({ status })
    ?? (prevComparable ? null : "没有可对比的上一次运行（这是本评估计划最早一次有报告的运行）");
  const onCompare = () => {
    if (!prevComparable) return;
    navigate(agentName
      ? agentTabHash(agentName, "optimize", runKey)
      : `#/compare/${encodeURIComponent(prevComparable.run_key)}/${encodeURIComponent(runKey)}`);
  };

  // ---- 导出 Markdown：只用已加载的这份数据（导出是文档，与屏幕各自为政）----
  const sections: SynthesisSection[] = useMemo(() => sectionsOf(d), [d]);
  const drills = useMemo(() => reportDrilldowns(d), [d]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportBlocked = query.isLoading ? "报告仍在加载，稍候即可导出"
    : query.isError ? "报告加载失败，无法导出——请先重试加载"
    : !d ? "报告数据尚未就绪"
    : null;
  async function onExport() {
    if (exportBlocked || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      await nextFrame();
      const md = buildReportMarkdown({
        runKey, seq, planId, detail: d, status, score, outcome,
        // 导出只收数字（exportReport 归 plan/ 批）：页面判成「—」的（无价 / 算不出的 0）不给它数，
        // 免得 markdown 里印回 $0.00；「部分」标记导出侧暂未带（遗留，见本批回报）
        cost: cost.text === EMPTY_MARK || typeof d?.total_cost_usd !== "number" ? null : d.total_cost_usd,
        startedAt, durationS, triggeredBy, skipReason, stages, sections, drills,
      });
      downloadTextFile(reportFileName(d?.plan_name, startedAt), md);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  const multi = views.length > 1;
  const evaluatorViews = views.filter((v) => v.tiles.length > 0);

  return (
    <section className="rpage" data-testid="page-report">
      <PageHeader
        back={{ label: plan?.name ?? d?.plan_name ?? planId, to: `#/plan/${encodeURIComponent(planId)}` }}
        title={<>运行报告{seq != null && <span className="sub mono">#{seq}</span>}</>}
        meta={(
          <>
            <span className="chip rpage-key" data-testid="report-head-key">{runKey}</span>
            {groups.map((g) => (
              <span key={g.index} className="badge" data-testid={`report-head-stage-${g.index}`}>{stageLabel(g.type)}</span>
            ))}
            {traces && traces.noTrace > 0 && (
              <span
                className={`badge ${traces.allMissing ? "bad" : "warn"}`}
                data-testid="report-head-trace"
                title={traces.allMissing
                  ? `只用上报数据评估已开启：这 ${traces.noTrace} 例在 CloudWatch aws/spans 里都没有 Agent 上报的 trace，本次回归 / 红队环节未评分`
                  : `只用上报数据评估已开启：这 ${traces.noTrace} 例在 CloudWatch aws/spans 里没有 Agent 上报的 trace，不评分、不入通过率分母；其余 ${traces.ok} 例照常`}
              >
                {traces.noTrace} 例无 trace
              </span>
            )}
          </>
        )}
        testid="report-head"
      />

      <div className="rpage-body" key={runKey}>
        {/* 元信息行：只摆这一次的数（开始 / 用时 / agent / 版本 / 目标线 / 触发） */}
        <div className="rpg-meta" data-testid="report-meta">
          <span><span className="k">开始</span><span className="v">{fmtRunTime(startedAt)}</span></span>
          <span><span className="k">用时</span><span className="v">{fmtDuration(durationS)}</span></span>
          {agentName && <span><span className="k lat">agent</span><span className="v">{agentName}</span></span>}
          <span><span className="k">版本</span><span className="v" data-testid="report-drawer-version">{version || EMPTY_MARK}</span></span>
          <span><span className="k">目标线</span><span className="v">{f3(SCORE_TARGET)}</span></span>
          {triggeredBy && <span><span className="k">触发</span><span className="v">{triggerLabel(triggeredBy)}</span></span>}
        </div>

        {query.isLoading && <p className="rpg-loading" data-testid="report-drawer-loading">加载报告中…</p>}
        {query.isError && (
          <p className="plan-editor-error" data-testid="report-drawer-error">
            {query.error instanceof Error ? query.error.message : String(query.error)}
          </p>
        )}

        {!query.isLoading && !query.isError && (
          <>
            {/* ② 结论一句 */}
            <VerdictLine facts={facts} fallback={fallbackVerdict} onJump={jumpTo} />

            {/* ③ hero 四格 + ④ 成本时延小条 */}
            <ReportHero facts={facts} tally={tally} issues={issues} cost={cost} metrics={metrics} />
            {metrics && <PerfBar metrics={metrics} onJump={jumpTo} />}

            {/* ⑤ 评估器 tile（每环节一排；多环节 tile 名旁带环节名） */}
            {evaluatorViews.map((v) => {
              const under = v.tiles.filter((t) => t.under).length;
              const stageMean = v.group.type === "observe"
                ? (typeof v.group.stage.overall_mean === "number" ? v.group.stage.overall_mean : null)
                : (typeof v.group.stage.score === "number" ? v.group.stage.score : null);
              return (
                <section className="rpg-section" key={v.group.index} data-testid={`report-evaluators-${v.group.index}`}>
                  <div className="rpg-sec-head">
                    <h2>评估器{multi && <span className="rpg-sec-sub"> · {v.label}</span>}</h2>
                    <span className="rpg-sec-sub" data-testid={`report-evaluators-${v.group.index}-sub`}>
                      {v.tiles.length} 个 · {under} 个未过线 · 目标线 <span className="mono">{f3(SCORE_TARGET)}</span>
                      {stageMean != null && (
                        <span
                          className="rpg-sec-mean"
                          title="多个评估器等权平均出来的数，只作观测量；决策看上面每一格过不过目标线"
                          data-testid={`report-evaluators-${v.group.index}-stage-mean`}
                        >
                          {" "}· 本环节均分 <span className="mono">{f3(stageMean)}</span>（次要）
                        </span>
                      )}
                    </span>
                  </div>
                  <EvaluatorTiles view={v} showStage={multi} onJump={jumpTo} />
                </section>
              );
            })}

            {/* ⑥ 行 × 评估器 矩阵：每环节一张卡 */}
            {views.map((v) => (
              <StageMatrix
                key={v.group.index}
                view={v}
                open={openCell}
                onToggle={toggleCell}
                target={target}
                showStage={multi}
                annotations={annotations}
                added={added}
                onIntake={openIntake}
              />
            ))}

            {/* ⑦ 问题条目：复用 Agent 详情 ③ 的台账组件（同一个采纳链路：set_proposal_adopted /
                adopt_run_advice）。只列这一次 run 的条目；老 run 没台账（[]）⇒ 整卡不画。 */}
            {issues.length > 0 && (
              <IssueLedger
                issues={issues}
                thisKey={runKey}
                thisSeq={seq}
                planId={planId}
                planRuns={runs}
                filter={issueFilter}
                onFilter={(name) => setIssueFilter((f) => (f === name ? null : name))}
                onClearFilter={() => setIssueFilter(null)}
                generate={null}
                onJumpEvidence={onJumpEvidence}
                evidenceHref={evidenceHref}
                traceHref={issueTraceHref}
                spanChips
                spanHref={spanTraceHref}
                foldSimilar
                title="问题条目"
                showOthers={false}
              />
            )}
          </>
        )}

        {/* ⑧ 页脚 */}
        <ReportFooter
          exporting={exporting}
          exportBlocked={exportBlocked}
          exportError={exportError}
          onExport={onExport}
          compareBlocked={compareBlocked}
          onCompare={onCompare}
          noData={noData}
          planId={planId}
          runKey={runKey}
          older={older}
          newer={newer}
          onNavigate={setRunKey}
          intakeLabel={intakeLabel}
          onIntakeAll={openIntakeAll}
        />
      </div>

      <BadcaseDrawer
        open={intakeOpen}
        onClose={() => setIntakeOpen(false)}
        mode={intake}
        runKey={runKey}
        agentName={agentName}
        datasets={datasetsQuery.data?.datasets ?? []}
        annotations={annotations}
        onAdded={(rowKeys) => setAddedNow((prev) => { const s = new Set(prev); for (const k of rowKeys) s.add(k); return s; })}
        onAnnotated={onAnnotated}
      />
    </section>
  );
}
