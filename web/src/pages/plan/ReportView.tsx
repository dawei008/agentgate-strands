// 运行报告的**共享视图**：独立报告页（#/report/:runKey，主路）与方案页的报告抽屉
// 用的是同一份。结构照 ADR-0014「报告只讲本次」：
//   头部（run 身份 + **裁决句** + 元信息小字）→ 全量表（一张表管三环节，
//   一行 = 一个用例/会话/攻击，失败行标红置顶，证据链在展开态）→
//   本次建议区（RunAdvice：本次诊断根因的纯前端聚合）→ 底部操作条。
// 任何跨 run 内容（趋势、反复问题、采纳效果、「较上次 Δ」）一律不在本视图 ——
// 那是评估分析页的辖区（旧「综合报告四段 + 环节明细下钻」已随 ADR-0014 下线；
// 导出 Markdown 是文档不是界面，那边的完整版合法，各自为政）。
//
// 版面、判据、派生全在这里 —— 两个壳（ReportDrawer.tsx / pages/report/ReportPage.tsx）
// 里不许出现任何口径/措辞：同一个 run 的报告在两处读出两个结论，比读出一个错
// 结论更难查（同 compare/CompareView.tsx 的纪律）。
// 样式同理跟着视图走：reportview.css 前缀是 .report-view（共享类），不是入口类。
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import type { ApiEvent } from "../../lib/api";
import { navigate } from "../../router";
import { Icon } from "../../components/layout/Icons";
import type {
  DatasetsEvent, Plan, PlanRunDetail, PlanRunSummary, StageSummary, SynthesisSection,
} from "./types";
import { fmtRunTime } from "../../lib/time";
import {
  triggerLabel, sectionsOf, reportScore, reportStages,
  stageKind, STAGE_KIND_TEXT, stageNote, stageNumbers, stageDisplayLabel,
  reportDrilldowns, versionSnapshot, evaluatorRows, observeEvaluatorRows, SCORE_TARGET,
  type CaseVerdict, type StageLabelCtx,
} from "./derive";
// 全量表与裁决句与本次建议的行层（ADR-0014）：纯函数在 reportRows.ts，这里只渲染
import {
  adviceGroups, reportGroups, runVerdict, type ReportGroup, type ReportRow,
} from "./reportRows";
// 「与上次对比」入口的闸门（运行中/跳过的 run 不能当对比对象）——
// 与运行历史行那个入口同一份判据，两处不许各写一套。ADR-0014：这个按钮是
// 跳评估分析的**门**，门不是内容，所以它留在页脚。
import { comparableReason } from "./compare/derive";
// 空位统一显示为长破折号：与 run 页同一个常量，「没有」要看得见
import { EMPTY_MARK } from "../../lib/renderText";
import { buildReportMarkdown, downloadTextFile, nextFrame, reportFileName } from "./exportReport";
// 本次建议区（ADR-0014 §6，F2）：本次诊断根因的纯前端聚合，替换旧「改进处方」
// 块（ImprovementBlock）在报告里的挂载 —— 那个组件已随 adr0014-migrate 批删除：
// 采纳追踪迁到评估分析页（pages/compare/AnalysisSections.tsx），页脚「与上次对比」
// 是通往那里的门。
import RunAdvice from "./RunAdvice";
import { fmtDuration, fmtScore, runOutcome } from "../../lib/scoring";
// 样式跟着视图走（同 compare/CompareView.tsx）：两个壳谁挂载这份视图，这份样式
// 就跟着到场，不靠壳自己记得 import —— 忘了的表现是「整页没样式」。
import "./reportview.css";

/**
 * 相邻 run（供 ← → 切换、#N 序号推导）。`runs` 最新在前、与运行历史表格
 * 同序，所以「更早」是 idx+1、「更新」是 idx-1，序号是 length-idx。
 *
 * 导出而不内联：两个壳都要知道「有没有上一个/下一个」（抽屉的按钮、页面的页头），
 * 而这套下标方向一旦各写一份，就迟早有一处写反 —— 写反的表现是「切到了另一个
 * run」，不是报错。
 */
export function runNeighbors(runs: PlanRunSummary[], runKey: string): {
  idx: number;
  seq: number | null;
  summary: PlanRunSummary | null;
  older: PlanRunSummary | null;
  newer: PlanRunSummary | null;
} {
  const idx = runs.findIndex((r) => r.run_key === runKey);
  return {
    idx,
    seq: idx >= 0 ? runs.length - idx : null,
    summary: idx >= 0 ? runs[idx] : null,
    older: idx >= 0 && idx + 1 < runs.length ? runs[idx + 1] : null,
    newer: idx > 0 ? runs[idx - 1] : null,
  };
}

/**
 * 报告视图本体（两个入口共吃一份）。
 *
 * 两个入口的差别**只由 `entry` 表达**，不靠「onClose 在不在」这种间接判据 ——
 * 那种写法下「页面」与「忘了传 onClose 的抽屉」长得一模一样。
 */
export function ReportView({ runKey, runs, planId, plan, entry, onClose, onNavigate, onCompare }: {
  runKey: string;
  /** 运行历史（最新在前，与表格同序）：供 #N 序号 / ← → 切换 */
  runs: PlanRunSummary[];
  planId: string;
  /** 方案定义（D-5）：环节展示名要判数据集侧别，只有方案定义知道这个环节
   *  指向哪个集合（`stage_summaries` 不带 dataset kind）。缺省 = 退回三类映射。 */
  plan?: Plan | null;
  /** 入口：抽屉多一个 ✕ 与 Esc 提示；页面靠浏览器后退与页头返回位，没有「关闭」 */
  entry: "drawer" | "page";
  /** 抽屉的关闭回调（`entry="page"` 时不传） */
  onClose?: () => void;
  onNavigate: (runKey: string) => void;
  /** 「与上次对比」（默认相邻两次）：宿主决定是开抽屉还是去对比页，这里只发意图。
   *  省略 = 不给这个入口。 */
  onCompare?: (aKey: string, bKey: string) => void;
}) {
  const { idx, seq, summary, older, newer } = runNeighbors(runs, runKey);

  // ← → 切换相邻 run。两个入口共用这一份 —— 从前它挂在 Drawer 的 onKeyDown 上，
  // 搬进视图是因为它是**视图的行为**（底部那句提示就写在视图里），页面入口没有
  // Drawer 可挂。
  // ⚠️ 输入态必须放过：在输入框里按 ← 是移动光标，不是「换一个 run」——
  // document 级监听不加这道闸就会两件事同时发生（抽屉上一直是这个毛病；
  // 视图当下没有常驻输入位，闸留着防回归）。
  // 带修饰键的组合也放过（⌘←/Alt← 是浏览器的后退）。
  const navRef = useRef(onNavigate);
  navRef.current = onNavigate;
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

  const query = useQuery({
    queryKey: ["plan_run", runKey],
    queryFn: () =>
      apiOne<PlanRunDetail & ApiEvent>({ action: "get_plan_run", run_key: runKey }, "plan_run"),
  });
  const d = query.data;
  // 数据集名单：只为判环节的**侧别**（D-5「模拟测试」）。与方案编辑器共用
  // queryKey ["datasets"] → 从编辑器过来时直接命中缓存，不重复打接口。
  // 拉不到（无权限/未打桩）时 data 为 undefined → 环节名退回三类映射，
  // 报告其余部分完全不受影响（这份查询绝不当渲染闸门）。
  const datasetsQuery = useQuery({
    queryKey: ["datasets"],
    queryFn: () => apiOne<DatasetsEvent>({ action: "list_datasets" }, "datasets"),
  });
  const labelCtx: StageLabelCtx = useMemo(() => ({
    planStages: plan?.stages,
    datasets: datasetsQuery.data?.datasets,
  }), [plan, datasetsQuery.data]);

  const status = d?.status ?? summary?.status ?? "";
  const score = scoreOf(d, summary);
  const skipReason = d?.skip_reason ?? summary?.skip_reason ?? null;

  const stages: StageSummary[] = reportStages(d);

  // run 终态按**环节**判定（lib/scoring.ts runOutcome，全站唯一实现）：
  // 环节数组走三重兜底（S3 全量 report.stages / DDB stage_summaries /
  // 终帧 stages），顶层 score 作为无环节老数据的退化输入。
  const outcome = runOutcome({ status, score, stage_summaries: stages });
  const noData = outcome.kind === "nodata";

  // ---- 全量表 + 裁决句（ADR-0014）：行现算，数字只说这一次 ----
  const groups: ReportGroup[] = useMemo(() => reportGroups(d), [d]);
  const verdict = useMemo(
    () => runVerdict({ outcome, groups, skipReason }),
    [outcome, groups, skipReason],
  );

  // ---- 本次建议（ADR-0014 §6）：本次诊断根因的纯前端聚合（无 LLM 调用）----
  const advice = useMemo(() => adviceGroups(groups), [groups]);
  // 引用 chip → 全量表行级跳转：目标交给 ReportTable（它持有展开态）。
  // seq 单调递增：连点同一 chip 也要重新滚一次（对象相等挡不住这件事）。
  const [jump, setJump] = useState<{ gi: number; rowKey: string; seq: number } | null>(null);
  const jumpSeq = useRef(0);
  const onJumpToRow = (gi: number, rowKey: string) => {
    jumpSeq.current += 1;
    setJump({ gi, rowKey, seq: jumpSeq.current });
  };
  // 引用 chip 的环节名：与组头同一份展示名（stageDisplayLabel，含 D-5 侧别）
  const stageLabelOf = (gi: number) => {
    const g = groups.find((x) => x.index === gi);
    return g ? stageDisplayLabel(g.stage, gi, labelCtx) : "";
  };

  const cost = d?.total_cost_usd
    ?? (typeof d?.overview?.cost_usd === "number" ? (d.overview.cost_usd as number) : null);
  const startedAt = d?.started_at ?? summary?.started_at;
  const durationS = d?.duration_s ?? summary?.duration_s;
  const triggeredBy = d?.triggered_by ?? summary?.triggered_by;
  // 版本快照（护栏 1）：这一次运行时的版本标签。两条通路 + 缺失降级都在
  // derive.versionSnapshot 里（run 对比的两栏 chip 读同一个函数，
  // 「绝不读 Agent 当前标签」这条护栏只能有一个住所）。
  const version = versionSnapshot(d, summary);

  // ---- 「与上次对比」（默认相邻两次）----
  // 往更早方向找最近一个**可对比**的 run：运行中的（还没有报告）与被跳过的
  // （只有一条 marker）都跳过 —— 闸门与运行历史行那个入口同一份判据
  // （compare/derive.comparableReason），两处不许各写一套。
  const prevComparable = useMemo(() => {
    if (idx < 0) return null;
    for (let i = idx + 1; i < runs.length; i++) {
      if (comparableReason(runs[i]) == null) return runs[i];
    }
    return null;
  }, [idx, runs]);
  // 置灰理由分两档，各说各的：本次不可对比 / 没有可对比的上一次
  const compareBlocked = comparableReason({ status })
    ?? (prevComparable ? null : "没有可对比的上一次运行（这是本评估计划最早一次有报告的运行）");

  // ---- 导出 Markdown（UI-011）：只用已加载的这份数据，不发新请求 ----
  // 导出是**文档**，与屏幕各自为政（ADR-0014）：综合报告分节与钻取明细已不在
  // 界面上，但仍原样进导出 —— 这两份派生只喂 buildReportMarkdown，不再喂 JSX。
  const sections: SynthesisSection[] = useMemo(() => sectionsOf(d), [d]);
  const drills = useMemo(() => reportDrilldowns(d), [d]);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // 数据没到齐/查询失败时不导出空壳；按钮禁用并用 title 说明为什么。
  const exportBlocked = query.isLoading ? "报告仍在加载，稍候即可导出"
    : query.isError ? "报告加载失败，无法导出——请先重试加载"
    : !d ? "报告数据尚未就绪"
    : null;

  async function onExport() {
    if (exportBlocked || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      await nextFrame(); // 先让「导出中」落屏，别让人以为又点了个死按钮
      const md = buildReportMarkdown({
        runKey, seq, planId, detail: d, status, score, outcome, cost,
        startedAt, durationS, triggeredBy,
        skipReason,
        stages, sections, drills,
      });
      downloadTextFile(reportFileName(d?.plan_name, startedAt), md);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    /* 共享类 .report-view 挂在视图自己的根上（不挂在壳上）：reportview.css 全靠它
       命中，挂到壳上就等于「换个壳就整页没样式」。入口修饰类另加一个。 */
    <div className={entry === "page" ? "report-view report-page" : "report-view"}>
      {/* ---- 头部：run 身份 + 裁决句 + 元信息小字 ---- */}
      <div className="rd-head" data-testid="report-drawer-head">
        <div className="rd-head-top">
          <span className="rd-runid" data-testid="report-drawer-runid">
            {seq != null && <span className="seq">#{seq}</span>}
            {seq != null && " · "}
            {fmtRunTime(startedAt)}
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          <button
            type="button"
            className="rd-close"
            aria-label="上一个（更早的 run）"
            disabled={!older}
            data-testid="report-drawer-prev"
            onClick={() => older && onNavigate(older.run_key)}
          >
            <Icon name="chev-l" className="ic-sm" />
          </button>
          <button
            type="button"
            className="rd-close"
            aria-label="下一个（更新的 run）"
            disabled={!newer}
            data-testid="report-drawer-next"
            onClick={() => newer && onNavigate(newer.run_key)}
          >
            <Icon name="chev-r" className="ic-sm" />
          </button>
          {/* ✕ 只在抽屉上：页面上「关闭」没有对象，返回由页头的返回位与浏览器
              后退承担（用户原话是要「看完了回运行列表」，不是关掉一个浮层）。 */}
          {entry === "drawer" && (
            <button
              type="button"
              className="rd-close"
              aria-label="关闭报告"
              data-testid="report-drawer-close"
              onClick={onClose}
            >
              <Icon name="close" className="ic-sm" />
            </button>
          )}
        </div>
        {/* 裁决句即头部（ADR-0014 第 2 条）：一句现算事实句，只列本次没过的东西。
            报告仍在加载时不写字 —— 半截数据算出的裁决不是裁决（数据到齐前这行
            由下方 loading 行代言）。 */}
        {!query.isLoading && (
          <p className={`rd-verdict is-${verdict.tone}`} data-testid="report-verdict">
            {verdict.text}
          </p>
        )}
        <div className="rd-meta" data-testid="report-drawer-meta">
          <span>{fmtDuration(durationS)}</span>
          <span className="sep" />
          <span className="cjk">{triggerLabel(triggeredBy)}触发</span>
          <span className="sep" />
          <span>{cost != null ? `$${cost.toFixed(2)}` : "$—"}</span>
          {version && (
            <>
              <span className="sep" />
              <span className="badge badge-mono" data-testid="report-drawer-version">
                {version}
              </span>
            </>
          )}
        </div>
      </div>

      {/* ---- 正文滚动：全量表 + 本次建议 ---- */}
      <div className="rd-body" data-testid="report-drawer-body">
        {query.isLoading && <p className="subtle" data-testid="report-drawer-loading">加载报告中…</p>}
        {query.isError && (
          <p className="plan-editor-error" data-testid="report-drawer-error">
            {query.error instanceof Error ? query.error.message : String(query.error)}
          </p>
        )}
        {!query.isLoading && !query.isError && (
          <>
            <ReportTable groups={groups} labelCtx={labelCtx} runKey={runKey} jump={jump} />
            {/* 本次建议区（无条目时组件自己不画，含标题——空区块 = 废话）。
                key={runKey}：← → 切换相邻 run 时整件重建 —— 采纳态是**这一个
                run** 的东西，绝不能跟着视图漂到下一个 run 上。 */}
            <RunAdvice
              key={runKey}
              advice={advice}
              runKey={runKey}
              planId={planId}
              proposals={Array.isArray(d?.proposals) ? d.proposals : []}
              stageLabelOf={stageLabelOf}
              onJumpToRow={onJumpToRow}
            />
          </>
        )}
      </div>

      {/* ---- 底部操作条 ---- */}
      <div className="rd-foot" data-testid="report-drawer-foot">
        <button
          type="button"
          className="btn ghost mini"
          /* 只在忙碌 / 数据未就绪时禁用——常态可点。title 只在被禁用时挂原因
             （那是这一次的状态数据）。 */
          disabled={exporting || exportBlocked != null}
          title={exportBlocked ?? undefined}
          data-testid="report-drawer-export"
          onClick={onExport}
        >
          <Icon name="download" className="ic-sm" />{exporting ? "导出中…" : "导出报告"}
        </button>
        {exportError && (
          <span className="plan-editor-error" data-testid="report-drawer-export-error">
            导出失败：{exportError}
          </span>
        )}
        {/* 与上次对比：跨 run 的问题去评估分析答（ADR-0014 页脚保留这扇门）。 */}
        {onCompare && (
          <button
            type="button"
            className="btn ghost mini"
            disabled={compareBlocked != null}
            title={compareBlocked ?? undefined}
            data-testid="report-drawer-compare"
            onClick={() => prevComparable && onCompare(prevComparable.run_key, runKey)}
          >
            与上次对比
          </button>
        )}
        {noData ? (
          <button
            type="button"
            className="btn ghost mini"
            data-testid="report-drawer-settings"
            onClick={() => navigate(`#/plan/${encodeURIComponent(planId)}/edit`)}
          >
            查看计划设置
          </button>
        ) : (
          <button
            type="button"
            className="btn ghost mini"
            data-testid="report-drawer-trace"
            onClick={() => navigate(`#/run/${encodeURIComponent(runKey)}`)}
          >
            <Icon name="ext" className="ic-sm" />查看 trace
          </button>
        )}
        <span className="spacer" />
        {/* 提示只说这个入口真有的键：页面上没有 Esc 可按，写上去就是假承诺 */}
        <span className="hint">
          {entry === "drawer" ? "Esc 关闭 · ← → 切换相邻 run" : "← → 切换相邻 run"}
        </span>
      </div>
    </div>
  );
}

// ---------- 全量表（一张表管三环节，ADR-0014 第 4 条） ----------
//
// 表格零玻璃（glass-guard 纪律 2）：所有底色走实心 tint/--bg2，无 backdrop-filter。
// 组头 = 环节展示名 + 该环节聚合数（stageNumbers：本环节均分/通过率/攻破…，
// 与导出的环节一行同一份函数）+ 状态原话（stageNote：empty/failed/stopped 的
// 后端原话，行级原因是「说这一次数据」的话）。
function ReportTable({ groups, labelCtx, runKey, jump }: {
  groups: ReportGroup[];
  /** 环节展示名上下文（D-5）：dataset 环节按侧别显示「回归测试」/「模拟测试」 */
  labelCtx: StageLabelCtx;
  runKey: string;
  /** 行级跳转口子（本次建议区的引用 chip）：展开并滚到那一行。seq 单调递增，
   *  连点同一 chip 也重滚一次。 */
  jump?: { gi: number; rowKey: string; seq: number } | null;
}) {
  // 展开态：一张表一份（key = 组下标:行 key）。行数量级 ≤ 几十，不做虚拟滚动。
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // 跳转：展开目标行 + 滚过去。行的折叠头（RowLine 的 tr）展开前就在 DOM 里，
  // 所以同一个 effect 里直接滚，不用等展开渲染。已处理的 seq 记在 ref 上 ——
  // effect 因 groups 变化重跑时不重放旧跳转。
  const tableRef = useRef<HTMLTableElement>(null);
  const handledJump = useRef(0);
  useEffect(() => {
    if (!jump || jump.seq === handledJump.current) return;
    handledJump.current = jump.seq;
    const g = groups.find((x) => x.index === jump.gi);
    const n = g ? g.rows.findIndex((r) => r.key === jump.rowKey) : -1;
    if (!g || n < 0) return; // 引用与行同源现算，对不上只可能是数据换代——不硬滚
    const key = `${g.index}:${jump.rowKey}`;
    setOpen((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    const el = tableRef.current?.querySelector(
      `[data-testid="report-row-${g.index}-${n}"]`);
    // jsdom 没有 scrollIntoView 实现 → 可选调用（测试钉展开态，不钉滚动）
    (el as HTMLElement | null)?.scrollIntoView?.({ block: "center" });
  }, [jump, groups]);
  if (groups.length === 0) return null;
  return (
    <table className="rt" data-testid="report-table" ref={tableRef}>
      {groups.map((g) => (
        <tbody key={g.index} data-testid={`report-group-${g.index}`}>
          <GroupHead group={g} labelCtx={labelCtx} />
          <GroupEvaluators group={g} />
          {g.rows.map((row, n) => (
            <Fragment key={row.key}>
              <RowLine
                row={row}
                gi={g.index}
                n={n}
                open={open.has(`${g.index}:${row.key}`)}
                onToggle={() => toggle(`${g.index}:${row.key}`)}
              />
              {open.has(`${g.index}:${row.key}`) && (
                <tr className="rt-detail" data-testid={`report-row-${g.index}-${n}-body`}>
                  <td colSpan={2}>
                    <RowDetail row={row} gi={g.index} n={n} runKey={runKey} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      ))}
    </table>
  );
}

// ---------- 逐评估器列表格（组头下、逐行前；2026-09-03 用户拍板加回） ----------
//
// ADR-0014 重写把这张聚合表撤成了行内小格，用户看后原话「现在报告又不是表格的
// 形式了？」——列表格加回（纯加法，其余版面不动）。推导与导出共用同一份
// （derive.evaluatorRows / observeEvaluatorRows），措辞与导出的 evaluatorTable /
// observeEvaluatorTable 同一套话。**一处刻意不同串**：observe 分母缺失这一格屏幕
// 写「分母未记录」（跟评估分析页 compare/derive.ts:793 同侧），导出在「判定会话」
// 列头下写「未记录」（exportReport.ts:243）——同义，屏幕那句自带限定词，不依赖读者
// 把格子接回列头。其余各档逐字同串：
//   dataset（分母 = 判定数）：judged=0 →「无可评估数据」（一条判定都没有）；
//   judged>0 但 mean 空 →「—」。**绝不**用 0 顶替任何一档（0 是「评了且很差」）。
//   observe（分母 = 判定会话数）：judged=null（DDB 摘要那一路不带分母）→
//   「分母未记录」，**绝不**拿环节的枚举会话数顶替。
// 空数组（老 run 无 evaluator_stats / summary）→ 整块不出（连表头都不出），
// 与导出的 `if (rows.length === 0) return []` 同刑；红队环节没有这套聚合 → 不出。
function GroupEvaluators({ group }: { group: ReportGroup }) {
  if (group.type === "dataset") return <DatasetEvaluators group={group} />;
  if (group.type === "observe") return <ObserveEvaluators group={group} />;
  return null;
}

/** 均分格：三档（数字 / 「—」 / 「无可评估数据」）只在这里画一次——dataset 与
 *  observe 两张表的差别只在**哪档配哪句**（分母语义不同），判句由调用方给。
 *  低于目标线（derive.SCORE_TARGET，与趋势图目标线同一条）转警示色。 */
function MeanCell({ mean, noneText }: { mean: number | null; noneText: string }) {
  if (mean == null) return <span className="emean is-none">{noneText}</span>;
  return (
    <span className={`emean${mean < SCORE_TARGET ? " is-low" : ""}`}>{mean.toFixed(2)}</span>
  );
}

function DatasetEvaluators({ group }: { group: ReportGroup }) {
  const rows = evaluatorRows(group.stage);
  if (rows.length === 0) return null;
  return (
    <tr className="rt-evals" data-testid={`report-group-${group.index}-evaluators`}>
      <td colSpan={2}>
        {/* 表头限定词照 CONTEXT.md 度量口径：裸「均分」不得单独出现——这一列与
            同屏的「本环节均分」「线上评估均分」是三个不同的数。分母写明是「判定」
            而不是用例数（errored 判定已被后端剔掉）。 */}
        <div className="rte is-head">
          <span className="ename">评估器</span>
          <span className="emean">评估器均分</span>
          <span className="ecount">通过/判定</span>
        </div>
        {rows.map((r) => (
          <div
            className="rte"
            key={r.name}
            data-testid={`report-group-${group.index}-eval-${r.name}`}
          >
            {/* 评估器名是注册名原文（资源库里用户自己选的 id），不翻译 */}
            <span className="ename lat" title={r.name}>{r.name}</span>
            <MeanCell mean={r.mean} noneText={r.judged > 0 ? "—" : "无可评估数据"} />
            <span className="ecount">{r.judged > 0 ? `${r.passed}/${r.judged}` : "—"}</span>
          </div>
        ))}
      </td>
    </tr>
  );
}

function ObserveEvaluators({ group }: { group: ReportGroup }) {
  const rows = observeEvaluatorRows(group.stage);
  if (rows.length === 0) return null;
  return (
    <tr className="rt-evals" data-testid={`report-group-${group.index}-evaluators`}>
      <td colSpan={2}>
        <div className="rte is-obs is-head">
          <span className="ename">评估器</span>
          <span className="emean">评估器均分</span>
          {/* 与 dataset 表的「通过/判定」刻意不同名：这一列是比率不是计数 */}
          <span className="ecount">通过率</span>
          <span className="eses">判定会话</span>
        </div>
        {rows.map((r) => (
          <div
            className="rte is-obs"
            key={r.name}
            data-testid={`report-group-${group.index}-eval-${r.name}`}
          >
            <span className="ename lat" title={r.name}>{r.name}</span>
            <MeanCell mean={r.mean} noneText={r.judged === 0 ? "无可评估数据" : "—"} />
            <span className="ecount">
              {r.passRate == null ? "—" : `${Math.round(r.passRate * 100)}%`}
            </span>
            {/* 分母 + 未完成次数都是这一次的数；分母没记就说没记 */}
            <span className={`eses${r.judged == null ? " is-none" : ""}`}>
              {r.judged == null
                ? "分母未记录"
                : `${r.judged}${r.errored ? `（另 ${r.errored} 次评估未完成）` : ""}`}
            </span>
          </div>
        ))}
      </td>
    </tr>
  );
}

/** 组头一行：环节名 + 聚合数（本环节均分/通过率/攻破，取现有 stage summary）+
 *  状态原话。分档判据与导出的环节一行**同一份**（derive.stageKind/stageNote/
 *  stageNumbers）：empty/stopped 的半截数字不是结论，位上摆状态词；failed 保留
 *  数字（现场信息），原话在右侧。 */
function GroupHead({ group, labelCtx }: { group: ReportGroup; labelCtx: StageLabelCtx }) {
  const { stage, index } = group;
  const kind = stageKind(stage);
  const note = stageNote(stage);
  const label = stageDisplayLabel(stage, index, labelCtx);
  return (
    <tr className={`rt-ghead is-${kind}`} data-testid={`report-group-${index}-head`}>
      {/* 弹性布局在内层 div：把 th 本身改成 flex 会破坏表格布局 */}
      <th colSpan={2}>
        <div className="g">
          <span className="gname cjk">{label}</span>
          <span className="gnum">
            {kind === "empty" || kind === "stopped" ? STAGE_KIND_TEXT[kind] : stageNumbers(stage)}
          </span>
          {kind === "failed" && <span className="gmark">执行失败</span>}
          {/* 注记单行省略号（组头要能一眼扫完）——必须挂 title：empty/失败环节的
              这行**就是**「为什么没有数据 / 为什么失败」的全部信息，被截断而无处
              看全等于把原因吃掉。 */}
          {note && <span className="gnote" title={note}>{note}</span>}
        </div>
      </th>
    </tr>
  );
}

// ---------- 行（折叠态 = 一眼看出谁没过；展开态 = 证据链） ----------
//
// 「有分数才算成功」的同族纪律，落到单条判定上：
//   errored → 中性「评估失败」（**不是** 0 —— 0 是「评了且很差」）；
//   score 缺失/非数字 → 「—」；0 → 老老实实显示 0.00 且判不通过。
function RowLine({ row, gi, n, open, onToggle }: {
  row: ReportRow;
  gi: number;
  n: number;
  open: boolean;
  onToggle: () => void;
}) {
  const id = `report-row-${gi}-${n}`;
  return (
    <tr
      className={`rt-row is-${row.outcome}${open ? " is-open" : ""}`}
      data-testid={id}
      data-row={row.name}
    >
      <td className="rt-name">
        <button
          type="button"
          className="rt-toggle"
          aria-expanded={open}
          data-testid={`${id}-toggle`}
          onClick={onToggle}
        >
          <Icon name="chev-r" className="ic-sm chev" />
          <span className="cname lat" title={row.name}>{row.name}</span>
          {row.sub && <span className="ccat" title={row.sub}>{row.sub}</span>}
        </button>
      </td>
      <td className="rt-cells">
        {/* 空响应/调用失败/拉取失败/无有效结论…：档位标记 + 后端原话在 title */}
        {row.note && (
          <span className={`cmark is-${row.note.kind}`} title={row.note.text || row.note.mark}>
            {row.note.mark}
          </span>
        )}
        {/* 红队行判定列只有 攻破/守住（errored 已由上面的标记说了） */}
        {row.kind === "attack" ? (
          row.breached != null && (
            <span
              className={`vchip ${row.breached ? "is-fail" : "is-pass"}`}
              data-testid={`${id}-breach`}
            >
              <span className="vs">{row.breached ? "攻破" : "守住"}</span>
            </span>
          )
        ) : (
          <VerdictChips verdicts={row.verdicts} testPrefix={`report-verdict-${gi}-${n}`} />
        )}
      </td>
    </tr>
  );
}

/** 展开态（ADR-0014 第 5 条的顺序）：judge 判词（label+分+reason）→ 原文对照
 *  （输入/期望/实际；红队 = 攻击对话全文，objective 当输入）→ 诊断（category+
 *  根因+修法；红队无诊断不渲染）→ 跳 trace（run 级；行级锚点是后续批）。 */
function RowDetail({ row, gi, n, runKey }: {
  row: ReportRow;
  gi: number;
  n: number;
  runKey: string;
}) {
  const id = `report-row-${gi}-${n}`;
  return (
    <div className="rt-body">
      {/* 没跑成的行：后端原话摆在最前面——「为什么没有结果」就是这一行的全部信息 */}
      {row.note?.text && <p className="rd-case-note">{row.note.text}</p>}

      {/* ① judge 判词 */}
      {row.kind === "attack" ? (
        row.breached != null && (
          <div className="rd-reasons">
            <div className="rd-reason" data-testid={`${id}-attack-verdict`}>
              <div className="rh">
                <span className={row.breached ? "vp is-fail" : "vp is-pass"}>
                  {row.breached ? "攻破" : "守住"}
                </span>
              </div>
              {row.reason && <LongText text={row.reason} testId={`${id}-reason`} />}
            </div>
          </div>
        )
      ) : (
        <VerdictReasons verdicts={row.verdicts} testId={id} />
      )}

      {/* ② 原文对照 */}
      {row.kind !== "session" && <CaseField label="输入" text={row.input} testId={`${id}-input`} />}
      {row.expected && (
        <CaseField label="期望输出" text={row.expected} testId={`${id}-expected`} />
      )}
      {row.kind === "attack" ? (
        <CaseField label="攻击对话" text={row.conversation} testId={`${id}-conversation`} />
      ) : (
        /* 会话行的「预览」是诚实措辞：后端只随明细带前 300 字（observe.py
           evaluate_session 的 output_preview），完整对话在运行详情页 */
        <CaseField
          label={row.kind === "session" ? "输出预览" : "实际输出"}
          text={row.output}
          testId={`${id}-output`}
        />
      )}

      {/* ③ 诊断（category + 根因 + 修法）；没有诊断整块不画 */}
      {row.diagnosis && (
        <div className="rt-diag" data-testid={`${id}-diagnosis`}>
          <div className="fl">诊断</div>
          {row.diagnosis.failures.map((f, i) => (
            <div className="rt-diag-f" key={i}>
              {f.category && <span className="ccat">{f.category}</span>}
              {f.evidence && <span className="ev">{f.evidence}</span>}
            </div>
          ))}
          {row.diagnosis.rootCauses.map((rc, i) => (
            <div className="rt-diag-rc" key={i} data-testid={`${id}-rootcause-${i}`}>
              {rc.fixType && <span className="ccat">{rc.fixType}</span>}
              {/* 根因（B1 新键）：旧形状 run 缺键 → 这一行不画，不拿枚举词顶替 */}
              {rc.explanation && (
                <p className="why" data-testid={`${id}-rootcause-${i}-why`}>{rc.explanation}</p>
              )}
              {rc.fix && <p className="fix">{rc.fix}</p>}
            </div>
          ))}
        </div>
      )}

      {/* ④ 跳 trace（run 级；行级锚点是后续批）。红队行带攻击会话 id
          （B1 契约 session_ids；空数组不画）——行级锚点落地前它们先以 mono
          文字在场。 */}
      <div className="rt-actions">
        {row.sessionIds.length > 0 && (
          <span className="rt-sids" data-testid={`${id}-sessions`}>
            {row.sessionIds.map((sid) => (
              <span className="badge badge-mono" key={sid}>{sid}</span>
            ))}
          </span>
        )}
        <button
          type="button"
          className="btn ghost mini"
          data-testid={`${id}-trace`}
          onClick={() => navigate(`#/run/${encodeURIComponent(runKey)}`)}
        >
          <Icon name="ext" className="ic-sm" />查看 trace
        </button>
      </div>
    </div>
  );
}

/** 折叠行尾的逐评估器小格（分 + 过/不过 + label 档位；三档配色/「评估失败」
 *  口径只能有一处定义）。label 缺（旧形状 run / errored）→ 整格不画。 */
function VerdictChips({ verdicts, testPrefix }: { verdicts: CaseVerdict[]; testPrefix: string }) {
  return (
    <>
      {verdicts.map((v) => (
        <span
          key={v.name}
          className={`vchip ${v.errored ? "is-none" : v.passed === false ? "is-fail" : v.passed ? "is-pass" : "is-none"}`}
          data-testid={`${testPrefix}-${v.name}`}
          title={v.reason || v.name}
        >
          <span className="vn">{v.name}</span>
          {v.label != null && (
            <span className="vlb" data-testid={`${testPrefix}-${v.name}-label`}>{v.label}</span>
          )}
          <span className="vs">
            {v.errored ? "评估失败" : fmtScore(v.score)}
          </span>
        </span>
      ))}
    </>
  );
}

/** 展开区：逐评估器判词（label + 分 + 过/不过 + reason 全文）。空判定 → 整块不画。 */
function VerdictReasons({ verdicts, testId }: { verdicts: CaseVerdict[]; testId: string }) {
  if (verdicts.length === 0) return null;
  return (
    <div className="rd-reasons">
      {verdicts.map((v) => (
        <div className="rd-reason" key={v.name}>
          <div className="rh">
            <span className="vn lat">{v.name}</span>
            {/* label 档位（B1 契约）：缺 = 不画这一格（旧形状 run 的降级） */}
            {v.label != null && (
              <span className="vlb" data-testid={`${testId}-label-${v.name}`}>{v.label}</span>
            )}
            <span className={`vs${v.errored ? " is-none" : ""}`}>
              {v.errored ? "评估失败（未产出判定）" : fmtScore(v.score)}
            </span>
            {!v.errored && v.passed != null && (
              <span className={v.passed ? "vp is-pass" : "vp is-fail"}>
                {v.passed ? "通过" : "不通过"}
              </span>
            )}
          </div>
          <LongText text={v.reason} testId={`${testId}-reason-${v.name}`} />
        </div>
      ))}
    </div>
  );
}

function CaseField({ label, text, testId }: { label: string; text: string; testId: string }) {
  return (
    <div className="rd-field">
      <div className="fl">{label}</div>
      <LongText text={text} testId={testId} />
    </div>
  );
}

/** 长文本截断长度：现网实际输出最长 2470 字、judge 理由封顶 600 字，全铺会把
 *  行列表撑成一条无法浏览的长卷（折叠态一行的可扫性就没了）。 */
const CLIP = 320;

/** 截断 + 展开全文。空值走 EMPTY_MARK（「没有」要看得见，不留静默空白）。 */
function LongText({ text, testId }: { text: string; testId: string }) {
  const [full, setFull] = useState(false);
  const long = text.length > CLIP;
  const shown = !text ? EMPTY_MARK : full || !long ? text : `${text.slice(0, CLIP)}…`;
  return (
    <div className="rd-long" data-testid={testId}>
      <span className="tx">{shown}</span>
      {long && (
        <button
          type="button"
          className="more"
          data-testid={`${testId}-more`}
          onClick={() => setFull((v) => !v)}
        >
          {full ? "收起" : `展开全文（${text.length} 字）`}
        </button>
      )}
    </div>
  );
}

function scoreOf(d: PlanRunDetail | undefined, summary: PlanRunSummary | null): number | null {
  // reportScore：顶层 score（真后端）→ 从 observe 环节 overall_mean 推导。
  // 此前这里首选 d.overview.score —— 真后端 overview 无该键，只是因为
  // summary（list_plan_runs 行）恰好带 score 才没显形；报告若在没有列表
  // 数据时打开（summary=null），分数会莫名变「—」。
  const fromDetail = reportScore(d);
  if (fromDetail != null) return fromDetail;
  if (typeof summary?.score === "number") return summary.score;
  return null;
}
