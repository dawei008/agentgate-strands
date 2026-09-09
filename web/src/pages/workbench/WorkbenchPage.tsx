// 评估计划页（#/workbench）：舰队级排程看板（ADR-0016 决定 3 / 舰队级 d）——
// 一计划一行，回答「什么时候跑、花多少、上次结果如何」；下方保留最近运行表。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import { apiOne } from "../../lib/api";
import { startPlanRun, useRunFlight } from "../../lib/runFlight";
import { useAuth } from "../../lib/auth";
import { navigate } from "../../router";
import { deriveKpi, type WorkbenchKpi } from "./kpi";
import { deriveBoard, fmtNext, fmtUTC, type Board, type BoardRow } from "./board";
import { showToast } from "../../components/toast";
import type { Plan, PlansEvent } from "../../lib/apiTypes";
import type { RecentRunsEvent, RunRow } from "./types";
import { fmtRunTime } from "../../lib/time";
import {
  effectiveScore, fmtScore, runBadge, runOutcome, stageLabel, type RunOutcome,
} from "../../lib/scoring";
import "./workbench.css";
import PageHeader from "../../components/layout/PageHeader";
import RunConfirmCard from "../../components/RunConfirmCard";

const SKELETON_ROWS = 4;

// 环节全集（顺序即显示顺序）
// 展示名走 lib/scoring.stageLabel（术语七词唯一权威，ADR-0003）——这里只定顺序
const STAGE_ORDER: Array<{ type: string; label: string }> =
  ["observe", "dataset", "redteam"].map((type) => ({ type, label: stageLabel(type) }));

const RECENT_RUNS_LIMIT = 20;

/** 看板表头（骨架屏与真表共用一份，免得两处漂开） */
const BOARD_HEADERS: Array<{ label: string; cls?: string }> = [
  { label: "计划名" },
  { label: "Agent" },
  { label: "环节" },
  { label: "定时" },
  { label: "单次预算 $", cls: "num" },
  { label: "本月花费 $", cls: "num" },
  { label: "下次运行" },
  { label: "最近结果" },
  { label: "操作", cls: "wb-col-action" },
];

export default function WorkbenchPage() {
  const { authed } = useAuth();

  const plansQuery = useQuery({
    queryKey: ["plans"],
    queryFn: () => apiOne<PlansEvent>({ action: "list_plans" }, "plans"),
  });
  const runsQuery = useQuery({
    queryKey: ["recent-runs"],
    queryFn: () =>
      apiOne<RecentRunsEvent>({ action: "list_recent_runs", limit: RECENT_RUNS_LIMIT }, "recent_runs"),
  });

  const plans = plansQuery.data?.plans;
  const runs = runsQuery.data?.runs;
  const now = Date.now();
  const board = deriveBoard(plans, runs, now);
  const kpi = deriveKpi(runs, plans, now, board);

  return (
    <section data-testid="page-workbench">
      <PageHeader
        title="评估计划"
        actions={
          // 监控大屏入口（次级链接）：大屏不进侧栏导航，挂墙场景直接输 URL，
          // 这里是唯一的应用内入口
          <button
            className="btn-link"
            data-testid="bigscreen-link"
            onClick={() => navigate("#/bigscreen")}
          >
            大屏
          </button>
        }
      />

      <KpiStrip kpi={kpi} />

      {plansQuery.isError && (
        <p className="wb-error" data-testid="plans-load-error">
          {plansQuery.error instanceof Error ? plansQuery.error.message : String(plansQuery.error)}
        </p>
      )}

      {plansQuery.isLoading ? (
        <PlansSkeleton />
      ) : plans && plans.length === 0 ? (
        <div className="u-empty" data-testid="plans-empty">
          <p>还没有评估计划</p>
          <NewPlanButton authed={authed} testid="plans-empty-new" />
        </div>
      ) : plans ? (
        <BoardCard board={board} authed={authed} />
      ) : null}

      {runsQuery.isError && (
        <p className="wb-error" data-testid="runs-load-error">
          {runsQuery.error instanceof Error ? runsQuery.error.message : String(runsQuery.error)}
        </p>
      )}
      {runs && <RecentRunsCard runs={runs} />}
    </section>
  );
}

// ---------- KPI 条 ----------

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function KpiStrip({ kpi }: { kpi: WorkbenchKpi }) {
  const next = kpi.next;
  return (
    <div className="kpi-strip" style={{ "--kpi-cols": 3 } as CSSProperties} data-testid="kpi-strip">
      <div className="kpi kpi-hero" data-testid="kpi-next-run">
        <div className="kpi-label">
          <span className="dot viz1" aria-hidden="true" />
          下次运行
          <span className="kpi-scope">UTC</span>
        </div>
        <div className="kpi-hero-row">
          {next && next.nextRun ? (
            <span className="kpi-hero-num data-lg" data-testid="kpi-next-run-val">
              {`${String(next.nextRun.getUTCHours()).padStart(2, "0")}:${String(next.nextRun.getUTCMinutes()).padStart(2, "0")}`}
              <span className="denom"> {fmtUTC(next.nextRun).slice(0, 8)}</span>
            </span>
          ) : (
            <span
              className="kpi-hero-num data-lg"
              data-testid="kpi-next-run-val"
              // rate 计划的相位由 EventBridge 创建时刻决定，前端推不出 —— 不伪造时刻
              title={kpi.hasRate ? "只有 rate 周期计划，相位未知" : undefined}
            >
              —
            </span>
          )}
        </div>
        <div className="kpi-hero-meta" data-testid="kpi-next-run-meta">
          {next ? (
            <>
              <span className="wb-kpi-plan">{next.plan.name}</span>
              <span>{next.cronText}</span>
            </>
          ) : kpi.hasRate ? (
            <span>rate 周期 · 相位未知</span>
          ) : (
            <span>无定时计划</span>
          )}
        </div>
      </div>
      <div className="kpi" data-testid="kpi-scheduled">
        <div className="kpi-label">带定时计划数</div>
        <div className="kpi-val" data-testid="kpi-scheduled-val">{kpi.scheduledCount}</div>
      </div>
      <div className="kpi" data-testid="kpi-month-spend">
        <div className="kpi-label">
          <span className="dot viz2" aria-hidden="true" />
          本月花费
          <span className="kpi-scope">UTC · completed</span>
        </div>
        <div
          className="kpi-val"
          data-testid="kpi-month-spend-val"
          title={kpi.monthSpend == null
            ? `本月（UTC）内暂无 completed 运行样本（最近 ${RECENT_RUNS_LIMIT} 条运行内）`
            : `本月（UTC）completed 运行 ${kpi.monthSpendN} 次的 total_cost_usd 之和 · 来源：最近 ${RECENT_RUNS_LIMIT} 条运行`}
        >
          {kpi.monthSpend != null ? fmtUsd(kpi.monthSpend) : "—"}
        </div>
      </div>
      <div className="kpi" data-testid="kpi-runs-24h">
        <div className="kpi-label">近 24h 运行数</div>
        <div className="kpi-val" data-testid="kpi-runs-24h-val">{kpi.runs24h}</div>
      </div>
    </div>
  );
}

// ---------- 排程看板 ----------

function NewPlanButton({ authed, testid }: { authed: boolean; testid: string }) {
  return (
    <button
      className="btn btn-primary"
      data-testid={testid}
      disabled={!authed}
      title={!authed ? "请先登录" : undefined}
      onClick={() => navigate("#/plan/new")}
    >
      + 新建计划
    </button>
  );
}

/** 表头上一行的告警条：定时计划里最近一次失败/部分失败的计划数 + 本月花费合计；
 *  全部正常时给一句中性现状（计划数 · 带定时数 · 下次哪个几点跑），不写「一切正常」。 */
function BoardAlertBar({ board }: { board: Board }) {
  const a = board.alert;
  const spend = a.monthSpend != null ? fmtUsd(a.monthSpend) : "—";
  if (a.badScheduled.length > 0) {
    const names = a.badScheduled.slice(0, 3).map((r) => r.plan.name).join("、");
    const more = a.badScheduled.length > 3 ? ` 等` : "";
    return (
      <div className="wb-board-bar" data-tone="bad" data-testid="board-alert" role="status">
        <span className="status-dot error" aria-hidden="true" />
        <span>
          <b className="num">{a.badScheduled.length}</b> 个定时计划最近一次运行失败或部分失败：{names}{more}
        </span>
        <span className="spacer" />
        <span className="wb-board-bar-spend">本月花费 <b className="num">{spend}</b></span>
      </div>
    );
  }
  return (
    <div className="wb-board-bar" data-tone="neutral" data-testid="board-alert" role="status">
      <span>
        <b className="num">{a.planCount}</b> 个计划 · <b className="num">{a.scheduledCount}</b> 个带定时
        {a.next && a.next.nextRun
          ? <> · 下次 <span className="mono">{fmtNext(a.next.nextRun)}</span> {a.next.plan.name}</>
          : a.hasRate ? <> · 下次 rate 周期 · 相位未知</> : null}
      </span>
      <span className="spacer" />
      <span className="wb-board-bar-spend">本月花费 <b className="num">{spend}</b></span>
    </div>
  );
}

function BoardCard({ board, authed }: { board: Board; authed: boolean }) {
  return (
    <div className="card" data-testid="plans-card">
      <div className="card-head">
        <span className="card-title">评估计划</span>
        <span className="card-count" data-testid="plans-count">{board.rows.length}</span>
        <span className="spacer" />
        <span className="card-sub">时间为 UTC</span>
        <NewPlanButton authed={authed} testid="plans-new" />
      </div>
      <BoardAlertBar board={board} />
      <table className="u-table roomy wb-plans-table" data-testid="plans-table">
        <thead>
          <tr>
            {BOARD_HEADERS.map((h) => <th key={h.label} className={h.cls}>{h.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {board.rows.map((r) => (
            <BoardRowTr key={r.plan.plan_id} row={r} authed={authed} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BoardRowTr({ row, authed }: { row: BoardRow; authed: boolean }) {
  const { plan } = row;
  const id = plan.plan_id;
  return (
    <tr data-testid={`plan-row-${id}`}>
      <td className="cell-2l">
        <button
          className="wb-plan-name cell-main"
          data-testid={`plan-row-${id}-open`}
          onClick={() => navigate(`#/plan/${encodeURIComponent(id)}`)}
        >
          {plan.name}
        </button>
        <div className="cell-sub">{id}</div>
      </td>
      <td>
        <a
          className="lat wb-agent-link"
          href={`#/agent/${encodeURIComponent(plan.agent_name)}/evaluate`}
          data-testid={`plan-row-${id}-agent`}
        >
          {plan.agent_name}
        </a>
      </td>
      <td>
        <StageChain stages={plan.stages} planId={id} />
      </td>
      <td
        className="wb-schedule"
        data-testid={`plan-row-${id}-cron`}
        title={row.cronError ? `cron 解析失败：${row.cronError}` : row.cron || undefined}
      >
        {row.cronText}
      </td>
      <td className="num" data-testid={`plan-row-${id}-budget`}>
        <BudgetCell row={row} />
      </td>
      <td
        className="num"
        data-testid={`plan-row-${id}-spend`}
        title={row.monthSpend == null
          ? `本月（UTC）内暂无该计划的 completed 运行样本（最近 ${RECENT_RUNS_LIMIT} 条运行内）`
          : `本月（UTC）completed 运行 ${row.monthSpendN} 次的 total_cost_usd 之和 · 来源：最近 ${RECENT_RUNS_LIMIT} 条运行`}
      >
        {row.monthSpend != null ? row.monthSpend.toFixed(2) : <span className="subtle">—</span>}
      </td>
      <td className="mono wb-next" data-testid={`plan-row-${id}-next`}
        title={row.nextRun ? fmtUTC(row.nextRun) : undefined}>
        {row.nextRun ? row.nextRunText : <span className="subtle">{row.nextRunText}</span>}
      </td>
      <td data-testid={`plan-row-${id}-last`}>
        <LastRunCell lastRun={plan.last_run} />
      </td>
      <td className="wb-col-action">
        <RunPlanButton plan={plan} authed={authed} />
      </td>
    </tr>
  );
}

function StageChain({ stages, planId }: { stages?: Plan["stages"]; planId: string }) {
  const present = new Set((stages ?? []).map((s) => s.type));
  return (
    <span className="stages" data-testid={`plan-row-${planId}-stages`}>
      {/* 只列计划真含的环节（用户定案：未选的不显示，置灰会让全选计划与
          部分选计划看起来一样，扫不出差异）；空计划显示 — */}
      {STAGE_ORDER.filter(({ type }) => present.has(type)).map(({ type, label }) => (
        <span key={type} data-stage={type}>
          {label}
        </span>
      ))}
      {STAGE_ORDER.every(({ type }) => !present.has(type)) && <span className="off">—</span>}
    </span>
  );
}

/** runOutcome 五态 → status-dot 语义色（既有变量，无新色）：
 *  ok→绿 / partial→琥珀 / failed·error→红 / nodata·skipped→中性 / running→accent */
function outcomeDot(oc: RunOutcome, status: string): string {
  if (oc.kind === "ok") return "completed";
  if (oc.kind === "partial") return "warn";
  if (oc.kind === "failed") return "error";
  if (oc.kind === "nodata") return "skipped";
  return status === "running" ? "running" : status === "error" ? "error" : "skipped";
}

/** 「最近结果」单元格。终态口径 = lib/scoring.ts runOutcome（按环节判定，
 *  与全站 badge 同判，UI-013/UI-025）：
 *    未运行            该计划从未有过 run（后端 last_run: null）
 *    完成 [分数]       环节全成功——纯回归/纯红队也算完成，分数只在有 observe 分时显示
 *    部分失败/失败     有环节炸了，绝不显示成绿色「完成」
 *    跳过/运行中       非终态走后端 status（线上 PLANRUN 分区暂无 running item，
 *                      渲染路径先备好，见 types.ts PlanLastRun 注释）
 */
function LastRunCell({ lastRun }: { lastRun?: Plan["last_run"] }) {
  if (!lastRun) return <span className="subtle">未运行</span>;
  const oc = runOutcome(lastRun);
  // 分值走 effectiveScore（不是 lastRun.score）：8/21 之前落库的 run 顶层 score 是
  // null、分在 observe 环节 overall_mean 里 —— 直读的表现与本族其余显示位略有不同
  // （这里是**一个数都不显**，不是显「—」），但同样是「同一个量两个住址」那件事：
  // 同一次 run 在计划详情页挂着 0.74，这一列却说不出任何数字。
  // 纯回归/纯红队计划在这里仍然无数字（ADR-0003 硬线：通过率不是均分）。
  const score = effectiveScore(lastRun);
  return (
    <span className="wb-lastrun">
      <span className={`status-dot ${outcomeDot(oc, lastRun.status)}`} aria-hidden="true" />
      <span className="wb-lastrun-label">{oc.label}</span>
      {score != null && <span className="num">{score.toFixed(2)}</span>}
    </span>
  );
}

/** 「单次预算 $」：schedule.budget_usd（app/plan.py 定时必带，>0）；无定时/存量
 *  字符串形态没有预算 → —。「超预算」由 list_plans 出口 join 的 estimated_cost_usd
 *  对比得出——后端没有 over_budget 键。 */
function BudgetCell({ row }: { row: BoardRow }) {
  const { budget } = row;
  if (budget == null) return <span className="subtle">—</span>;
  const est = row.plan.estimated_cost_usd;
  return (
    <>
      {budget.toFixed(2)}
      {est != null && est > budget && (
        <span className="badge warn wb-over-budget" title={`单次预估 $${est.toFixed(2)} > 预算 $${budget.toFixed(2)}`}>
          超预算
        </span>
      )}
    </>
  );
}

function RunPlanButton({ plan, authed }: { plan: Plan; authed: boolean }) {
  // 二次确认（缺陷 2）：run_plan 一发就真花钱且无撤销口，点「运行」先开卡
  const [confirming, setConfirming] = useState(false);
  const qc = useQueryClient();
  // 在飞状态走模块级通道（缺陷 1）：点完这颗按钮本页就 navigate 走人，组件当场
  // 卸载，进度只能存在组件之外；同一条通道让计划详情页那颗按钮也一起锁上。
  const flight = useRunFlight(plan.plan_id);

  function run() {
    // 旧写法是 void callApi(…, () => {}).catch(() => {}) + 无条件 showToast("已开始")：
    // 后端 {event:"error"} 被空回调吞、fetch 异常被 catch 吞，用户看到「已开始」
    // 其实一个字都没跑。改由 startPlanRun 消费整条流：真接单才报喜，失败照实弹。
    if (!startPlanRun(plan.plan_id, { qc, notify: showToast })) {
      showToast("该计划已有一次运行在进行中");
    }
    navigate(`#/plan/${encodeURIComponent(plan.plan_id)}`);
  }
  return (
    <>
      <button
        className="btn-link"
        data-testid={`plan-row-${plan.plan_id}-run`}
        disabled={!authed || flight.running}
        title={!authed ? "请先登录" : flight.running ? "该计划正在运行中" : undefined}
        onClick={() => setConfirming(true)}
      >
        {flight.running ? "运行中…" : "运行"}
      </button>
      <RunConfirmCard
        target={confirming ? plan : null}
        onCancel={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); run(); }}
      />
    </>
  );
}

// ---------- 最近运行表 ----------

/** 耗时格式：Xm Ys（不足 1 分钟只显 Ys） */
export function formatDuration(s: number | null | undefined): string {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

/** 结果 badge —— 口径全站唯一实现 lib/scoring.ts runBadge（按环节判定）。
 *  此前这里只看 status，于是环节炸掉的 run 照样绿色「完成」（UI-025），
 *  而纯回归/纯红队跑成功的 run 与 observe 空转的 run 长得一样（UI-013）。 */
function RunStatusBadge({ run }: { run: RunRow }) {
  const badge = runBadge(run);
  return (
    <span className={badge.cls} data-testid={`run-row-${run.run_key}-badge`}>
      <span className="dot" aria-hidden="true" />
      {badge.label}
    </span>
  );
}

function RecentRunsCard({ runs }: { runs: RunRow[] }) {
  return (
    <div className="card" data-testid="runs-card">
      <div className="card-head">
        <span className="card-title">最近运行</span>
        <span className="card-count" data-testid="runs-count">{runs.length}</span>
        <span className="spacer" />
        <span className="card-sub">时间为 UTC</span>
      </div>
      {runs.length === 0 ? (
        <div className="card-body">
          <p className="subtle" data-testid="runs-empty">还没有运行记录</p>
        </div>
      ) : (
        <table className="u-table wb-runs-table" data-testid="runs-table">
          <thead>
            <tr>
              <th>计划</th>
              <th>Agent</th>
              <th>状态</th>
              <th className="num">分数</th>
              <th className="num">耗时</th>
              <th>时间</th>
              <th className="wb-col-action">操作</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.run_key} data-testid={`run-row-${r.run_key}`}>
                <td>{r.plan_name}</td>
                <td className="lat">{r.agent_name}</td>
                <td><RunStatusBadge run={r} /></td>
                {/* 取值走 effectiveScore（不是 r.score）：8/21 之前落库的 run 顶层
                    score 是 null、分在 observe 环节 overall_mean 里 —— 直读会让这一列
                    显示「—」，而计划详情页早就把它算进去了。真没有分仍是「—」：
                    兜底只换取值住址，不造 0。 */}
                <td className="num">{fmtScore(effectiveScore(r))}</td>
                <td className="num">{formatDuration(r.duration_s)}</td>
                {/* 真后端 started_at 带 " UTC" 后缀；表头已一次性声明时区，
                    单元格走 fmtRunTime 剥后缀，避免逐行重复 UTC */}
                <td className="mono wb-time">{fmtRunTime(r.started_at)}</td>
                <td className="wb-col-action">
                  <button
                    className="btn-link"
                    data-testid={`run-row-${r.run_key}-view`}
                    onClick={() => navigate(`#/plan/${encodeURIComponent(r.plan_id)}`)}
                  >
                    查看
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- 骨架屏（照 AgentsPage 模式：带表头） ----------

function PlansSkeleton() {
  return (
    <div className="card" aria-hidden="true" data-testid="plans-skeleton">
      <div className="card-head">
        <span className="card-title">评估计划</span>
      </div>
      <table className="u-table roomy wb-plans-table">
        <thead>
          <tr>
            {BOARD_HEADERS.map((h) => <th key={h.label} className={h.cls}>{h.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <tr key={i}>
              <td><span className="skeleton-bar" style={{ width: "70%" }} /></td>
              <td><span className="skeleton-bar" style={{ width: "60%" }} /></td>
              <td><span className="skeleton-bar" style={{ width: "80%" }} /></td>
              <td><span className="skeleton-bar" style={{ width: "70%" }} /></td>
              <td className="num"><span className="skeleton-bar" style={{ width: 36 }} /></td>
              <td className="num"><span className="skeleton-bar" style={{ width: 36 }} /></td>
              <td><span className="skeleton-bar" style={{ width: "60%" }} /></td>
              <td><span className="skeleton-bar" style={{ width: "50%" }} /></td>
              <td className="wb-col-action"><span className="skeleton-bar" style={{ width: 28 }} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
