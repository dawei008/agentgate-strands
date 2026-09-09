// 方案详情页（#/plan/:id）：定义/趋势/运行历史/报告的唯一结果场所。
// M1：页头 + 决策 KPI 行 + 运行历史表。样式一律 ui.css 组件类。
// 报告不在本页：运行历史「查看报告」跳独立报告页 #/report/<run_key>
//（内容量决定容器 —— 四节报告 + 逐用例明细远超一屏，抽屉与行内展开都装不下）。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import { navigate } from "../../router";
import type {
  Plan, PlansEvent, PlanRunsEvent, PlanRunSummary, PlanStage, PlanDeletedEvent,
} from "./types";
import { scheduleCron } from "./types";
import {
  deriveKpis, heartbeatAgeText, planHero, sortRunsDesc, stageProgressText, triggerLabel,
  reportScore,
} from "./derive";
// fmtScore 不再直接用：hero 数字（三形态）由 derive.planHero 格式化好，
// 页面只摆结果 —— 免得再出现「页面自己算一遍分数」的第二套口径
import {
  runBadge, runMetricChips, fmtDuration, STALE_RUNNING_BADGE, STATUS_LABEL,
} from "../../lib/scoring";
import { fmtRunTime } from "../../lib/time";
import TrendCard from "./TrendCard";
// run 对比（同方案两次运行并排）：本页的入口只有一个 —— 运行历史行的「对比」
// 动作（选两行）。报告里的「与上次对比」现在在报告页上，它走独立对比页
// #/compare/<a>/<b>，不再回头开本页这个抽屉。
import CompareDrawer, { type ComparePair } from "./compare/CompareDrawer";
import { comparableReason, orderComparePair } from "./compare/derive";
import {
  useRunPlan, useStopRun,
  type RunPlanState, type RunLogEntry, type StopRunState,
} from "./useRunPlan";
import LiveTurnsPanel from "./LiveTurnsPanel";
import ObserveSessionsPanel from "./ObserveSessionsPanel";
import { useLiveness, fmtClock, heartbeatLabel } from "../../lib/useLiveness";
import {
  adoptRunFlight, clearRunFlight, clearRunFlightError, holdPlanRun, isRunKnownSettled,
  pruneSettledRunKeys, useRunFlight, type RunFlightState,
} from "../../lib/runFlight";
import "./plan.css";
import PageHeader from "../../components/layout/PageHeader";
import ConfirmCard from "../../components/ConfirmCard";
import RunConfirmCard, { usePlanEstimate } from "../../components/RunConfirmCard";
// 从检查点续跑（UI-029 批 4）：入口可见性与计费上界的口径只有这一份纯函数
import { isResumable, resumeCeiling } from "./resume";

/** 已请求停止、还没等到终态时重拉运行历史的周期。后端读停止标志本身就有 ≥5s
 *  节流、检查点也不是随时到（app/planrun.py:560-563），更密的轮询换不来更早的
 *  终态，只是白打 list_plan_runs。 */
const STOP_POLL_MS = 5000;

/** 「这条方案有一次 run 还在跑」时重拉运行历史的周期（UI-029 批 3 交付 2，
 *  SPEC §6 定的 10s）。刷新恢复的进行中面板、行上的心跳与环节进度、以及终态的
 *  浮现全靠这一拉；后端心跳每 60s 一次、进度只在环节边界更新，更密没有意义。
 *
 *  闸门判据 = **后端读侧给的 `stale`**（app/stalecheck.py 那一份，前端零判定）。
 *  陈旧的 running 不轮询：它已经不动了，一条存量僵尸会让页面开着就每 10s 打一次，
 *  开一夜上万次（正是 STOP_WATCH_MAX_MS 那条注释担心的形状）。 */
const RUNNING_POLL_MS = 10_000;

export default function PlanDetailPage({ id }: { id: string }) {
  const plansQuery = useQuery({
    queryKey: ["plans"],
    queryFn: () => apiOne<PlansEvent>({ action: "list_plans" }, "plans"),
  });
  // 停止运行的状态机（按 run_key）：进度卡与运行历史那一行共用同一台
  const stop = useStopRun(id);
  const runsQuery = useQuery({
    queryKey: ["plan_runs", id],
    queryFn: () =>
      apiOne<PlanRunsEvent>({ action: "list_plan_runs", plan_id: id }, "plan_runs"),
    // 「已请求停止 → 实际停止」的第二段：后端不发新 SSE 事件，终态只能靠重拉
    // 运行历史看见（验收 4「无需刷新」）。闸门收得很紧 —— 只在「我请求过停止
    // 且那条 run 还是 running」时开，收敛后自己关；平时一次都不多打。
    refetchInterval: (query) => {
      const rows = query.state.data?.runs ?? [];
      if (rows.some((r) => r.status === "running" && stop.isPending(r.run_key))) {
        return STOP_POLL_MS;
      }
      // 有一条「还在跑且未陈旧」的 run（刷新恢复的进行中面板、心跳/进度、终态
      // 浮现都靠它）。判据只消费后端的 stale —— 见 RUNNING_POLL_MS 注释。
      if (rows.some((r) => r.status === "running" && r.stale !== true)) {
        return RUNNING_POLL_MS;
      }
      return false;
    },
  });

  const plan = plansQuery.data?.plans.find((p) => p.plan_id === id);
  const runs = useMemo(
    () => sortRunsDesc(runsQuery.data?.runs ?? []),
    [runsQuery.data],
  );
  const runner = useRunPlan(id);
  // 在飞 run 的 run_key：**流里没有**——后端 plan_run_started 不带它
  //（app/main.py:1464-1467），只有终帧 plan_run_report 带（:1498）。唯一来源是
  // 运行历史里那条 status=running 的记录（execute_plan_run 开跑就落库，
  // planrun.py:723-731；首个流事件到达时刷一次，useRunPlan.ts:161-165）。
  // 只有恰好一条时才认：多条（混进了陈旧 running 记录）宁可置灰，让用户在运行
  // 历史里逐行停 —— 绝不发一个猜的 key 去停别人的运行。
  const runningRuns = useMemo(() => runs.filter((r) => r.status === "running"), [runs]);
  const liveRunKey = runningRuns.length === 1 ? runningRuns[0].run_key : null;
  // 刷新恢复（UI-029 批 3 交付 2）：权威读里那条「还在跑**且未陈旧**」的 run。
  // stale 是后端读侧判的（app/stalecheck.py 三级判据 → _run_from_item 附上来），
  // 前端零判定逻辑、只消费 —— 陈旧的 running 不恢复面板、不轮询、不锁闸门
  //（它的执行进程已判定停止；改判成终态归 reaper，不是前端的活）。
  // 多条未陈旧 running（存量/并发误点）取最新那条：面板只讲一条 run，其余在下面
  // 运行历史里各有各的行与停止入口。
  // 第三个判据 isRunKnownSettled：**权威回执**（stop 的「已终态无需停止」）说这条
  // run 结束了，而运行历史那一拉可能还是上一秒的 running —— 认了它就会把刚清掉的
  // 在飞标记复活（页面永远「运行中…」）。**刻意不 useMemo**：登记是模块级集合，
  // 记进去那一刻（stop 回执到手，会触发一次渲染）就要生效，memo 的依赖数组盯不住它。
  const liveRun = runningRuns.find(
    (r) => r.stale !== true && !isRunKnownSettled(r.run_key)) ?? null;
  // 登记退休：权威读里已经不再 running 的 run_key 不必再记着（否则同一个 key
  // 将来再也认领不上）。
  const runningKeys = useMemo(() => runningRuns.map((r) => r.run_key), [runningRuns]);
  useEffect(() => { pruneSettledRunKeys(runningKeys); }, [runningKeys]);

  /** 确认后真发停止请求；成功（意图已落库）时把中间态也记进运行流状态机 */
  async function onStopRun(runKey: string) {
    const res = await stop.request(runKey);
    if (res.phase === "requested" && runKey === liveRunKey) runner.noteStopRequested();
  }
  const stopEntry: StopEntry = { stateOf: stop.stateOf, onStop: (k) => { void onStopRun(k); } };
  // 在飞通道（缺陷 1）：本页自己消费流的 run 也在这条通道上登记，工作台 / Agent
  // 详情页那两颗「运行」才会跟着锁；反过来，别处发起的后台 run 也靠它把本页按钮
  // 变成「运行中…」——useRunPlan 的 state 是 hook 局部的，看不见别人发起的 run。
  const flight = useRunFlight(id);
  // 在飞闸门的**权威读认领**（关闭 lib/runFlight 顶部「刷新 = 闸门清零」那条失明
  // 边界的前半段）：刷新后模块状态是空的，而 list_plan_runs 说得清「后端还有一条
  // 在跑」。认领上之后本页与工作台/Agent 页那三颗「运行」一起锁 —— 刷新一下就能
  // 再花一份钱这件事到此为止。
  // 只认领**自己领的那一份**：ref 记着「这次认领是我做的」，权威读说它终态了才由
  // 我释放；别人（本页/别页发起的真流）的在飞标记一个字都不碰。
  const adopted = useRef(false);
  useEffect(() => {
    if (liveRun && !flight.running && !adopted.current) {
      adopted.current = adoptRunFlight(id);
    } else if (!liveRun && adopted.current) {
      adopted.current = false;
      clearRunFlight(id);
    }
  }, [liveRun, flight.running, id]);
  // 卸载时把自己领的那份还回去（换方案/离开页面不该留一个锁着的闸门）
  useEffect(() => () => {
    if (adopted.current) {
      adopted.current = false;
      clearRunFlight(id);
    }
  }, [id]);

  /** 本页发起：先占位，再让 useRunPlan 读完整条流，无论成败都释放 */
  async function startRun() {
    const release = holdPlanRun(id);
    if (!release) return; // 已有一次在飞（按钮此时已 disabled，这里是并发兜底）
    try {
      await runner.run();
    } finally {
      release();
    }
  }

  /** 从检查点续跑（UI-029 批 4）：与首跑**同一条通路** —— 同一个在飞闸门、同一台
   *  状态机、同一张进度卡。后端那边它就是同一次运行（同 run_key、attempt+1，
   *  状态仍是 running），所以这里除了多一个 run_key 之外没有第二套逻辑。 */
  async function startResume(runKey: string) {
    const release = holdPlanRun(id);
    if (!release) return; // 已有一次在飞（入口此时已 disabled，这里是并发兜底）
    try {
      await runner.run(runKey);
    } finally {
      release();
    }
  }
  // 入口置灰的**唯一**判据：这条方案已有一次运行在飞（本页的流、别页发起的后台
  // run、或权威读认领上的那条 running 都算）。理由必须说出来 —— 只灰不说等于让
  // 用户莫名其妙（与页头「运行」按钮的 lockedHint 同一条纪律）。
  const runBusy = runner.state.phase === "running" || flight.running;
  const resumeEntry: ResumeEntry = {
    busyHint: runBusy
      ? "该评估计划有一次运行正在进行"
      : undefined,
    onResume: (k) => { void startResume(k); },
  };

  // 否定态判定纪律（UI-009）：isLoading 只在「无缓存的首次加载」为 true。新建方案
  // 保存后跳来时缓存里是**不含新方案**的旧列表——isLoading 已是 false 而 isFetching
  // 仍为 true，此前直落 !plan 闪现「找不到方案」，用户误判保存失败去重复创建。
  // 口径改为：只有「查询已结束且确实没有」才算不存在；取数在途一律显示加载态。
  const plansPending = plansQuery.isPending || plansQuery.isFetching;
  if (!plan && plansPending) {
    return (
      <section data-testid="page-plan-detail">
        <p className="subtle" data-testid="plan-loading">加载评估计划中…</p>
      </section>
    );
  }
  if (plansQuery.isError) {
    return (
      <section data-testid="page-plan-detail">
        <p className="plan-editor-error" data-testid="plan-error">
          {plansQuery.error instanceof Error ? plansQuery.error.message : String(plansQuery.error)}
        </p>
      </section>
    );
  }
  if (!plan) {
    return (
      <section data-testid="page-plan-detail">
        <div className="u-empty" data-testid="plan-not-found">
          <p>找不到评估计划 <span className="mono">{id}</span></p>
          <p className="sub">它可能已被删除。</p>
          <button type="button" className="btn ghost" onClick={() => navigate("#/workbench")}>
            返回评估计划
          </button>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="page-plan-detail">
      <PlanHead
        plan={plan}
        running={runner.state.phase === "running" || flight.running}
        /* 按钮为什么灰着要说清（UI-029 批 3）：别人/另一个标签页/上次刷新前发起的
           运行也会锁住它 —— 这是有意的（防同一方案被重复点掉两份钱），但只灰不说
           理由等于让用户莫名其妙。本页自己在跑时不给这句：进度卡就在下面。 */
        lockedHint={runner.state.phase === "idle" && liveRun
          ? `该评估计划有一次运行正在进行${
            heartbeatAgeText(liveRun.heartbeat_epoch, Date.now())
              ? ` · ${heartbeatAgeText(liveRun.heartbeat_epoch, Date.now())}`
              : ""}`
          : undefined}
        onRun={() => { void startRun(); }}
      />
      <RunProgress
        state={runner.state}
        onDismiss={runner.dismiss}
        stop={
          <StopRunControl
            runKey={liveRunKey}
            planName={plan.name}
            stop={stopEntry}
            testid="plan-run-stop"
            label="停止运行"
            disabledHint={
              runningRuns.length > 1
                ? "这条评估计划有多条运行中的记录，请在下方运行历史里逐条停止"
                : "正在获取本次运行的运行标识（后端落库后即可停止）…"
            }
          />
        }
      />
      {/* 后台 run（在工作台 / Agent 页发起，整条流由 lib/runFlight 消费）：本页
          useRunPlan 恒 idle，逐事件进度确实不在本页，但「正在跑」与失败真因必须
          说清——toast 只活 2.6 秒，且用户往往是从别的页面跳过来才看到这里。
          有权威读的在飞 run 时不重复报「后台运行中」：下面那张恢复面板讲的是同一
          件事，且它带心跳/进度/停止入口（失败真因不受此影响，照旧常驻）。 */}
      {runner.state.phase === "idle" && (
        <BackgroundRunNotice planId={id} flight={flight} suppressRunning={liveRun != null} />
      )}
      {/* 刷新恢复（交付 2）：本页没有流，但后端有一条未陈旧的 running —— 面板原地
          恢复并跟着 10s 轮询走，绝不再让用户「稍后自己刷新运行历史」。 */}
      {runner.state.phase === "idle" && liveRun && (
        <ReattachedRunPanel run={liveRun} planName={plan.name} stop={stopEntry} />
      )}
      <PlanKpiStrip planId={id} stages={plan.stages} runs={runs} loading={runsQuery.isLoading} />
      {/* stages 给趋势卡的空态用（D-2）：「有没有线上评估环节」是「成功 N 次
          却 0 个点」的原因，只有方案定义说得出 */}
      <TrendCard runs={runs} stages={plan.stages} />
      {/* plan 整份传下去：报告抽屉的环节展示名要按数据集侧别判「模拟测试」（D-5） */}
      <RunHistoryCard
        planId={id}
        plan={plan}
        runs={runs}
        query={runsQuery}
        stop={stopEntry}
        resume={resumeEntry}
        planName={plan.name}
      />
    </section>
  );
}

// ---------- 停止运行（P0：用户必须能中止一次正在花钱的运行）----------
//
// 两条路径共用本控件，靠 run_key 共享同一台状态机（useStopRun）：
//   (a) 当次流式会话——挂在运行进度卡的标题行；
//   (b) 重新进页面后运行历史里 status=running 的记录——挂在那一行的操作列
//       （不依赖流，刷新页面/换设备都能停）。
// 文案纪律：一律用后端回执 message 的原话（app/planrun.py:604-644）。此刻只是
// 「已请求停止，将在下一个检查点生效」，**不是**「已停止」——run 还在跑，钱还在
// 花，谎称停止会让用户以为可以走开了。终态那个词（「已停止」badge）由运行历史
// 那一行的 runBadge 给（lib/scoring.ts，stopped → badge warn），本文件不新造。

/** 停止入口需要的一小组能力（逐层往下传，而不是每层各自 useStopRun：
 *  同一次运行的两个入口必须共用一台状态机，否则一个说「已请求停止」，
 *  另一个还显示「停止」可点）。 */
type StopEntry = {
  stateOf: (runKey: string | null) => StopRunState;
  onStop: (runKey: string) => void;
};

// ---------- 从检查点续跑（UI-029 批 4：钱花过的环节不该再付一次）----------
//
// 入口只挂在「终态 error/stopped **且**留有 checkpoint_s3_key」的行上
// （判据 = pages/plan/resume.isResumable，前端零推断）。现实里这一族 = reaper 改判
// 的记录：`_reap_write` 是 update 只补终态与原因，检查点指针原样留着；走整条
// put_item 的两条终态路径覆盖即清场，completed 与老 run 天然没有指针 —— 入口
// 自然不出现（旧数据不修的展示侧降级，不是特判）。
//
// 确认卡是硬要求：这一按下去就真花钱，且**其中一段是重复计费**（半截环节整环节
// 重跑）。所以卡上必须同时写清「从第几环节继续」「新增花费上界」「重跑那一环最多
// 重复多少、此前那一截不退回」——用户点之前必须知道要再花多少钱。

/** 续跑入口需要的一小组能力（与 StopEntry 同款逐层往下传：预估查询只该有一个
 *  订阅，绝不在每一行各自 useQuery）。 */
type ResumeEntry = {
  /** 非空 = 这条方案已有一次运行在飞：入口置灰，并把这句理由写进 title */
  busyHint?: string;
  onResume: (runKey: string) => void;
};

/** 停止请求的回执文字（中间态说明 / 失败原因）。
 *  与按钮拆成两件是为了摆放：运行历史那一列只有 108px 宽（colgroup），后端那句
 *  完整回执塞进去会把行撑变形；表里它渲染在「结果」列——那一列本来就是放这类
 *  补充说明的地方（skipped 的 skip_reason 就在那儿）。 */
function StopRunMessages({ runKey, stop, testid, showPending = true }: {
  runKey: string | null;
  stop: StopEntry;
  testid: string;
  /** false = run 已经收敛到终态：别再复述「将在下一个检查点生效」（badge 就是
   *  答案，留着那句话反而像还没停）。失败原因不受此开关影响 —— 那次点击没生效，
   *  用户必须看得到。 */
  showPending?: boolean;
}) {
  const st = stop.stateOf(runKey);
  if (showPending && (st.phase === "requested" || st.phase === "noop")) {
    return <span className="subtle" data-testid={`${testid}-state`}> {st.message}</span>;
  }
  if (st.phase === "error") {
    return (
      <span className="plan-progress-error" role="alert" data-testid={`${testid}-error`}>
        停止请求失败：{st.error}
      </span>
    );
  }
  return null;
}

function StopRunControl({ runKey, planName, stop, testid, label, disabledHint, blockedReason,
                         withMessages }: {
  /** null = 还没拿到这次运行的 run_key（入口置灰，绝不发猜的 key） */
  runKey: string | null;
  planName: string;
  stop: StopEntry;
  testid: string;
  label: string;
  disabledHint?: string;
  /**
   * 非空 = 这次停止**不会有任何效果**，入口置灰并把这句话放进 title。
   *
   * 与 `disabledHint` 是两件事：那条说的是「还不知道该停哪个 run」（拿到 key 就能
   * 停），这条说的是「停了也没用」。当前唯一来源 = 陈旧 running（后端 `stale`）：
   * 执行进程已失联，`stop_plan_run` 只会写一个 `stop_requested` 标志，而**没有任何
   * 东西会消费它**（那个标志由执行进程在检查点自查；进程都没了）—— 界面却会回一句
   * 「已请求停止，将在下一个检查点生效」，等于承诺一件不会发生的事。真正的收敛归
   * reaper（`planrun.reap_stale_runs` 独立扫描改判成 error）。
   *
   * **按钮不删**：删了用户会以为「停止」这个功能没了/坏了。置灰 + 说清理由。
   */
  blockedReason?: string;
  /** false = 回执文字由调用方另处渲染（表格行：挪到「结果」列，见 StopRunMessages） */
  withMessages?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const st = stop.stateOf(runKey);
  // requesting/requested = 已经在停了，再点没有第二种效果（后端幂等，但界面
  // 不该邀请用户重复点）；noop = 后端说这条 run 已终态，也没什么可停的。
  const settled = st.phase === "requesting" || st.phase === "requested" || st.phase === "noop";
  return (
    <>
      <button
        type="button"
        className="btn-link danger"
        data-testid={testid}
        disabled={runKey == null || settled || blockedReason != null}
        // 置灰理由也进 title：表格行里没有位置铺一句说明
        title={runKey == null ? disabledHint : (blockedReason ?? undefined)}
        onClick={() => setConfirming(true)}
      >
        {/* 逐态如实：requested 才说「已请求停止」；noop（后端说这条 run 早已终态）
            保持原标签并置灰 —— 那次调用什么都没请求到，说「已请求停止」是撒谎。 */}
        {st.phase === "requesting" ? "请求停止中…"
          : st.phase === "requested" ? "已请求停止"
          : label}
      </button>
      {runKey == null && disabledHint && (
        <span className="subtle" data-testid={`${testid}-hint`}>{disabledHint}</span>
      )}
      {withMessages !== false && (
        <StopRunMessages runKey={runKey} stop={stop} testid={testid} />
      )}
      {/* initialFocus="cancel"：花钱/不可撤销的动作默认焦点落「取消」（UI-004，
          与删方案、发起运行同刑）。停止本身也不可撤销——停了就得重跑一次。 */}
      <ConfirmCard
        open={confirming}
        title="停止运行"
        danger
        initialFocus="cancel"
        confirmLabel="停止运行"
        body={
          <>
            <div>确定停止评估计划「<b>{planName}</b>」正在进行的这次运行？</div>
            <div>已产生的费用不会退回；已完成环节的结果会保留。</div>
            {/* 检查点机制的括号讲解（正在跑的环节先跑到自己的检查点 / 线上评估环节
                内部没有检查点）对任何 run 恒成立 ⇒ 删；只留后果本身 */}
            <div>停止将在下一个检查点生效。</div>
            {runKey && (
              <div className="mono subtle" data-testid={`${testid}-key`}>{runKey}</div>
            )}
          </>
        }
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          if (runKey) stop.onStop(runKey);
        }}
      />
    </>
  );
}

/**
 * 「从检查点重试」的二次确认卡（形制沿用既有确认卡：ConfirmCard +
 * initialFocus="cancel"，与删方案/发起运行/停止运行同刑，UI-004）。
 *
 * 金额从哪来：`estimate_plan_run` 的**逐环节**预估（queryKey 与页头 KPI、发起运行
 * 确认卡完全同款 ["plan_estimate", planId] —— 开卡直接命中缓存，不多打一次），
 * 按检查点键里的 `stage-<i>` 切片（resume.resumeCeiling，与后端
 * planrun.resume_cost_ceiling 同一句话）。预估拿不到就**如实说拿不到**：
 * 假装 $0.00 会把一个真花钱的动作说成免费。
 */
function ResumeConfirmCard({ run, planId, planName, stagesTotal, onCancel, onConfirm }: {
  /** null = 卡关着（此时不发预估请求） */
  run: PlanRunSummary | null;
  planId: string;
  planName: string;
  stagesTotal: number;
  onCancel: () => void;
  onConfirm: (runKey: string) => void;
}) {
  const estimate = usePlanEstimate(run ? planId : null);
  if (!run) return null;

  const ceiling = resumeCeiling(run.checkpoint_s3_key, stagesTotal, estimate.data?.stages);
  const reused = ceiling.fromStage - 1;
  const money = (v: number) => `$${v.toFixed(2)}`;
  const estError = estimate.isError
    ? (estimate.error instanceof Error ? estimate.error.message : String(estimate.error))
    : null;

  return (
    <ConfirmCard
      open
      title="从检查点重试"
      initialFocus="cancel"
      confirmLabel="从检查点继续"
      body={
        <>
          <div>
            确定从检查点继续评估计划「<b>{planName}</b>」的这次运行？会立即调用被测
            Agent / judge 并产生真实费用。
          </div>
          <div data-testid="plan-resume-confirm-cost">
            将从第 <b>{ceiling.fromStage}</b> 个环节继续（共 {ceiling.stagesTotal} 个）·{" "}
            {ceiling.addedMaxUsd != null ? (
              <>预计新增花费不超过 <b>{money(ceiling.addedMaxUsd)}</b></>
            ) : estError ? (
              <>预估失败：{estError}</>
            ) : estimate.isLoading ? (
              "预估中…"
            ) : (
              // 预估回来了但切不出数字（方案刚改过 / 某环节没给预估）：说不出来就
              // 说不出来 —— 绝不显示 $0.00
              "预估不可用（无法按环节切分，实际以运行为准）"
            )}
          </div>
          {reused > 0 && (
            <div>
              前 <b>{reused}</b> 个环节的结果直接沿用：<b>不重跑、不重新计费</b>。
            </div>
          )}
          <div>
            第 {ceiling.fromStage} 个环节会<b>整环节重跑</b>
            {ceiling.rebillMaxUsd != null
              ? <>：最多 <b>{money(ceiling.rebillMaxUsd)}</b> 属于重复计费，</>
              : "："}
            此前那一截已花的费用<b>不退回</b>。
          </div>
          {/* 「续跑仍算同一次运行：运行历史不会多出一行…」那段对任何续跑恒成立
              ⇒ 删（prose-sweep 2026-09-03） */}
          <div className="mono subtle" data-testid="plan-resume-confirm-key">
            {run.run_key}
          </div>
        </>
      }
      onCancel={onCancel}
      onConfirm={() => onConfirm(run.run_key)}
    />
  );
}

// ---------- 运行进度卡（M3 增强）：滚动式进度日志 + 计时 + 心跳活性 ----------
// 用户点名「不知道是死机还是在评估」：运行中恒显计时与心跳，>10s 无事件转琥珀
// 「等待响应…」，>60s 转红「可能已断开」。卡面不透明 --bg2（控件不玻璃纪律）。

const LOG_TAIL = 5;

/** 日志列表：默认只露最近 LOG_TAIL 条，老的折叠成「查看全部 N 条」 */
function RunLog({ entries }: { entries: RunLogEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? entries : entries.slice(-LOG_TAIL);
  const hidden = entries.length - visible.length;
  return (
    <div className="plan-progress-log" data-testid="plan-run-progress-log">
      {hidden > 0 && (
        <button
          type="button"
          className="btn-link plan-progress-expand"
          data-testid="plan-run-log-expand"
          onClick={() => setExpanded(true)}
        >
          查看全部 {entries.length} 条
        </button>
      )}
      {expanded && entries.length > LOG_TAIL && (
        <button
          type="button"
          className="btn-link plan-progress-expand"
          data-testid="plan-run-log-collapse"
          onClick={() => setExpanded(false)}
        >
          收起，只看最近 {LOG_TAIL} 条
        </button>
      )}
      <ol className="plan-progress-lines">
        {visible.map((e, i) => (
          <li key={`${e.ts}-${entries.length - visible.length + i}`} className={`line ${e.kind}`}>
            <span className="line-ts">
              {new Date(e.ts).toLocaleTimeString("zh-CN", { hour12: false })}
            </span>
            <span className="line-text">{e.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 「此前已请求停止」的收尾说明：终帧 plan_run_report **不带 run 状态**
 *  （app/main.py:1498-1509 的键集），所以前端无从判断这次运行是在检查点停下了
 *  还是抢在停止生效前跑完了 —— 只说得清的那句才说，终态指向运行历史。 */
function StopRequestedNote() {
  return (
    <p className="subtle" data-testid="plan-run-stop-note">
      此前已请求停止
    </p>
  );
}

export function RunProgress({ state, onDismiss, stop }: {
  state: RunPlanState;
  onDismiss: () => void;
  /** 停止入口（由页面注入 —— 它才知道在飞 run 的 run_key）；省略 = 不给入口 */
  stop?: ReactNode;
}) {
  const live = useLiveness(
    state.phase === "running",
    state.phase === "running" ? state.startedAt : null,
    state.phase === "running" ? state.lastEventAt : null,
  );
  if (state.phase === "idle") return null;

  if (state.phase === "failed") {
    return (
      <div className="plan-progress is-error" role="alert" data-testid="plan-run-progress">
        <div className="plan-progress-head">
          <span className="plan-progress-title" data-testid="plan-run-progress-status">
            {state.disconnected ? "连接中断" : "运行失败"} · 用时 {fmtClock(state.durationS)}
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn-link danger" data-testid="plan-run-dismiss" onClick={onDismiss}>
            关闭
          </button>
        </div>
        <p className="plan-progress-error" data-testid="plan-run-progress-error">
          {state.error}
          {/* 诚实兜底：run_plan 是后端任务，前端断流不杀它。
              ⚠️ 这一支现在**只**在「拿不到 run_key」（首帧之前就断，或老后端不发
              run_key）与「连续查询失败到上限」两种情况下走到 —— 拿到过 run_key 的
              断流走轮询，面板留在原地（useRunPlan 的 reattached 分支）。
              原文尾巴是「稍后刷新运行历史查看结果」，那是把用户请出界面自己刷新的
              死胡同（UI-029 §6 点名撤销）：本页会自己接手，说清这件事就够了。 */}
          {state.disconnected && "——连接中断，运行仍在后端继续。"}
        </p>
        {state.stopRequested && <StopRequestedNote />}
        <RunLog entries={state.entries} />
        <LiveTurnsPanel turns={state.turns} />
        <ObserveSessionsPanel sessions={state.sessions} />
      </div>
    );
  }

  if (state.phase === "done") {
    // 真后端 overview 里**没有** score（只有 stage_lines）——此前读
    // overview?.score，线上「总分」永不显示。改为顶层 score 优先、
    // 退回从 observe 环节 overall_mean 推导（口径同 ADR-0003 / bigscreen
    // derive.scoreOf：只认 completed 且有分的 observe 环节，无则「—」不伪造）。
    const score = reportScore(state.report);
    return (
      <div className="plan-progress is-done" role="status" data-testid="plan-run-progress">
        <div className="plan-progress-head">
          <span className="plan-progress-title" data-testid="plan-run-progress-status">
            {/* 请求过停止的 run 不许说「运行完成」，也不许给 run 级分数：终帧不带
                状态，而后端对被停止的 run 是**刻意不写**综合分的（半截 run 的分母
                不是整个方案，tests/test_stop_plan_run.py:371-377）。前端从环节均分
                反推出一个数会正好把那条纪律绕过去。
                这个数叫「线上评估均分」（CONTEXT.md:93-96 的白名单叫法）——它就是
                observe 环节综合分。**不叫「总分」**：CONTEXT.md:88-91 把「总分 /
                综合分」列为 Avoid，那两个词会被读成「把三类环节合成一个数」，而本
                产品绝不合成（ADR-0003 Amendment）。 */}
            {/* settledStatus 只有**轮询**这条路填得出（流式终帧不带 run 状态）：
                它是后端权威状态，非 completed 一律不许说「运行完成」、也不给
                run 级分数 —— 与 stopRequested 那一支同刑。 */}
            {state.settledStatus && state.settledStatus !== "completed"
              ? `运行已结束 · ${STATUS_LABEL[state.settledStatus] ?? state.settledStatus}`
                + ` · 用时 ${fmtClock(state.durationS)}`
              : state.stopRequested
                ? `运行已结束 · 用时 ${fmtClock(state.durationS)}`
                : `运行完成 · 用时 ${fmtClock(state.durationS)}`}
            {!state.stopRequested
              && !(state.settledStatus && state.settledStatus !== "completed")
              && typeof score === "number"
              ? ` · 线上评估均分 ${score.toFixed(2)}` : ""}
            {state.report.synthesis_error ? ` · 综合报告生成失败：${state.report.synthesis_error}` : ""}
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn-link" data-testid="plan-run-dismiss" onClick={onDismiss}>
            关闭
          </button>
        </div>
        {state.stopRequested && <StopRequestedNote />}
        <RunLog entries={state.entries} />
        <LiveTurnsPanel turns={state.turns} />
        <ObserveSessionsPanel sessions={state.sessions} />
      </div>
    );
  }

  // running：计时 + 三档心跳指示 + 滚动日志 + 三类环节的实时对话。
  // 断流之后（state.reattached）这张卡**不变成错误卡**：流没了，run 还在跑 ——
  // 活性指示换成「已转轮询」那一行，另加后端给的心跳与环节进度（交付 1/3）。
  return (
    <div className="plan-progress" role="status" data-testid="plan-run-progress">
      <div className="plan-progress-head">
        <span className="plan-progress-title" data-testid="plan-run-progress-status">
          <span className={state.suspectedStale ? "dot" : "dot viz1 pulse"} />
          {/* 中间态如实说：意图已落库，但运行**还在跑**（钱还在花），要到下一个
              检查点才停。绝不写「已停止」。
              suspectedStale = 后端判定执行进程已经停了（心跳停/超窗/过天花板）：
              那就不许再画一个还在走的秒表 —— 只说「疑似中断」，详情在下面那句。 */}
          {state.suspectedStale
            ? STALE_RUNNING_BADGE.label
            : state.stopRequested
              ? `已请求停止，将在下一个检查点生效 · 已 ${fmtClock(live?.elapsedS ?? 0)}`
              : `运行中 · 已 ${fmtClock(live?.elapsedS ?? 0)}`}
        </span>
        {state.reattached ? (
          <span className="plan-progress-liveness" data-testid="plan-run-reattached">
            <span className="dot" />
            实时连接已断开
            {state.pollError ? ` · 上次查询失败：${state.pollError}` : ""}
          </span>
        ) : live && (
          <span
            className={`plan-progress-liveness ${live.level}`}
            data-testid="plan-run-liveness"
          >
            <span className="dot" />
            {live.level === "ok" && `链路正常 · ${heartbeatLabel(live)}`}
            {live.level === "waiting" && "等待响应…"}
            {/* 死胡同文案撤销（UI-029 批 3）：原文是「可能已断开，最终状态以运行
                历史为准」——把用户请出界面去自己刷新。事实是流真断了会自动转轮询
                （见上一支），而这一档只是「流还开着但久无事件」。 */}
            {live.level === "stale" && "久无新事件 · 运行仍在后端继续"}
          </span>
        )}
        <RunLiveFacts
          heartbeatEpoch={state.heartbeatEpoch}
          progress={state.progress}
          testid="plan-run-live"
          now={Date.now()}
        />
        <span className="spacer" style={{ flex: 1 }} />
        {/* 停止入口只在运行中出现（终态两支根本走不到这里）——验收 1 */}
        {stop}
      </div>
      {state.suspectedStale && (
        <p className="subtle" data-testid="plan-run-suspected-stale">
          {STALE_RUNNING_BADGE.label}：后端已判定这次运行的执行进程停止。
        </p>
      )}
      <RunLog entries={state.entries} />
      <LiveTurnsPanel turns={state.turns} live />
      <ObserveSessionsPanel sessions={state.sessions} live />
    </div>
  );
}

// ---------- 后台 run 提示条（缺陷 1）----------
// 别处发起的 run 由 lib/runFlight 消费整条流，本页拿不到逐事件进度；这条提示条
// 负责两件事：①「正在后台跑」（免得用户看着 disabled 的按钮以为界面坏了）；
// ② 失败真因常驻（后端 {event:"error"} / plan_run_skipped / fetch 异常），
// 旧代码这些全被 () => {} 与 .catch(() => {}) 吞掉，界面上一个字都没有。
// 样式复用运行进度卡的既有类（.plan-progress 不透明 --bg2，无新 CSS）。
function BackgroundRunNotice({ planId, flight, suppressRunning }: {
  planId: string;
  flight: RunFlightState;
  /** true = 「正在跑」由权威读的恢复面板讲（ReattachedRunPanel），这里只留失败真因 */
  suppressRunning?: boolean;
}) {
  if (flight.error) {
    return (
      <div className="plan-progress is-error" role="alert" data-testid="plan-run-background-error">
        <div className="plan-progress-head">
          <span className="plan-progress-title">后台运行</span>
          <span className="spacer" style={{ flex: 1 }} />
          <button
            type="button"
            className="btn-link danger"
            data-testid="plan-run-background-dismiss"
            onClick={() => clearRunFlightError(planId)}
          >
            关闭
          </button>
        </div>
        <p className="plan-progress-error">{flight.error}</p>
      </div>
    );
  }
  if (!flight.running || suppressRunning) return null;
  return (
    <div className="plan-progress" role="status" data-testid="plan-run-background">
      <div className="plan-progress-head">
        <span className="plan-progress-title">
          <span className="dot viz1 pulse" />
          后台运行中
        </span>
      </div>
      <p className="subtle">
        这次运行是在别处发起的
      </p>
    </div>
  );
}

// ---------- 存活事实：心跳 + 环节进度（UI-029 批 3 交付 3）----------
//
// 三个消费点共用这一件（进度卡转轮询后 / 刷新恢复的面板 / 运行历史那一行），
// 免得同一句话长出三套措辞。**后端给了才显示**：老 run（批 1 之前落库）与终态
// run 查无这两个字段 → 整段不画，绝不伪造（心跳补 0 会印出「最后心跳 56 年前」，
// 进度补 0/0 会让用户以为一个环节都没跑完）。文案两句都在 derive（纯函数好测）。

function RunLiveFacts({ heartbeatEpoch, progress, testid, now }: {
  heartbeatEpoch?: number | null;
  progress?: PlanRunSummary["progress"];
  /** testid 前缀：`${testid}-heartbeat` / `${testid}-progress` */
  testid: string;
  /** 传入「现在」而不是在这里取墙钟：调用方（面板/表格行）在同一次渲染里
   *  可能画好几处，同一屏的两处心跳年龄不该差 1 秒 */
  now: number;
}) {
  const beat = heartbeatAgeText(heartbeatEpoch, now);
  const prog = stageProgressText(progress);
  if (!beat && !prog) return null;
  return (
    <>
      {beat && (
        <span className="subtle" data-testid={`${testid}-heartbeat`}>{beat}</span>
      )}
      {/* 两格之间的分隔点：进度卡头行靠 flex gap 撑开，但表格行里它们是**行内**
          相邻的（实测印成「最后心跳 8s 前已完成 1/2 环节」，两句话粘在一起） */}
      {beat && prog && <span className="subtle" aria-hidden="true">{" · "}</span>}
      {prog && (
        <span className="subtle" data-testid={`${testid}-progress`}>{prog}</span>
      )}
    </>
  );
}

// ---------- 刷新恢复的「进行中」面板（交付 2）----------
//
// 本页没有那条流（在别处发起 / 刚刷新过 / 换了台设备），但权威读说后端还有一条
// 未陈旧的 running —— 面板据此原地恢复：说清它在跑、跑到哪了、心跳多久前，
// 并给出**不依赖流**的停止入口。逐事件日志确实没有（那属于发起运行的那条连接），
// 这一点如实写在面板里，而不是让用户「稍后刷新运行历史」。
function ReattachedRunPanel({ run, planName, stop }: {
  run: PlanRunSummary;
  planName: string;
  stop: StopEntry;
}) {
  return (
    <div className="plan-progress" role="status" data-testid="plan-run-recovered">
      <div className="plan-progress-head">
        <span className="plan-progress-title" data-testid="plan-run-recovered-status">
          <span className="dot viz1 pulse" />
          运行中 · 开始于 {fmtRunTime(run.started_at)}
        </span>
        <RunLiveFacts
          heartbeatEpoch={run.heartbeat_epoch}
          progress={run.progress}
          testid="plan-run-recovered"
          now={Date.now()}
        />
        <span className="spacer" style={{ flex: 1 }} />
        {/* 停止入口用**这条 run 自己的 key**（不是页面级 liveRunKey）：多条
            running 并存时也精确，绝不发一个猜的 key 去停别人的运行。 */}
        <StopRunControl
          runKey={run.run_key}
          planName={planName}
          stop={stop}
          testid="plan-run-recovered-stop"
          label="停止运行"
          withMessages={false}
        />
      </div>
      <StopRunMessages
        runKey={run.run_key}
        stop={stop}
        testid="plan-run-recovered-stop"
      />
    </div>
  );
}

// ---------- 页头：方案名 + Agent + [运行][编辑][删除] ----------
function PlanHead({ plan, running, lockedHint, onRun }: {
  plan: Plan;
  running: boolean;
  /** 「运行」灰着的原因（权威读说这条方案有一次运行在进行中）；省略 = 不解释
   *  （本页自己在跑时进度卡就在下面，不必再说一遍） */
  lockedHint?: string;
  onRun: () => void;
}) {
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 发起运行的二次确认（缺陷 2）：与另外三处入口共用 RunConfirmCard
  const [runConfirmOpen, setRunConfirmOpen] = useState(false);

  // 确认后才走的真删除（deleting/deleteError 逻辑不动）
  async function onDelete() {
    setConfirmOpen(false);
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiOne<PlanDeletedEvent>(
        { action: "delete_plan", plan_id: plan.plan_id },
        "plan_deleted",
      );
      await qc.invalidateQueries({ queryKey: ["plans"] });
      navigate("#/workbench");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  return (
    <>
      <PageHeader
        testid="plan-head"
        back={{ label: "评估计划", to: "#/workbench" }}
        title={<span data-testid="plan-name">{plan.name}</span>}
        sub={
          <>
            <a
              className="plan-agent lat"
              href={`#/agent/${encodeURIComponent(plan.agent_name)}`}
              data-testid="plan-agent-link"
            >
              {plan.agent_name}
            </a>
            {/* schedule 契约是 {cron, budget_usd} 对象（历史数据可能是字符串）——
                统一走 scheduleCron 取显示文本，直渲对象会崩 */}
            {scheduleCron(plan.schedule)
              ? <span className="mono subtle"> · {scheduleCron(plan.schedule)}</span>
              : <span className="subtle"> · 仅手动</span>}
          </>
        }
        actions={
          <>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="plan-run"
            disabled={running}
            title={running ? lockedHint : undefined}
            onClick={() => setRunConfirmOpen(true)}
          >
            {running ? "运行中…" : "运行"}
          </button>
          {running && lockedHint && (
            <span className="subtle" data-testid="plan-run-locked-hint">{lockedHint}</span>
          )}
          <button
            type="button"
            className="btn-link"
            data-testid="plan-edit"
            onClick={() => navigate(`#/plan/${encodeURIComponent(plan.plan_id)}/edit`)}
          >
            编辑
          </button>
          <button
            type="button"
            className="btn-link danger"
            data-testid="plan-delete"
            disabled={deleting}
            onClick={() => setConfirmOpen(true)}
          >
            {deleting ? "删除中…" : "删除"}
          </button>
          </>
        }
      />
      {deleteError && (
        <p className="plan-editor-error" data-testid="plan-delete-error">{deleteError}</p>
      )}
      <RunConfirmCard
        target={runConfirmOpen ? plan : null}
        onCancel={() => setRunConfirmOpen(false)}
        onConfirm={() => { setRunConfirmOpen(false); onRun(); }}
      />
      {/* initialFocus="cancel"：危险动作默认焦点落「取消」（UI-004，与删数据集
          /删评估器同刑）。此前漏传，卡弹出后焦点在卡本体，一个回车就把方案
          连运行历史一起删掉。 */}
      <ConfirmCard
        open={confirmOpen}
        title="删除评估计划"
        body={<>确定删除评估计划「<b>{plan.name}</b>」？运行历史会一并归档删除。</>}
        confirmLabel="删除"
        danger
        initialFocus="cancel"
        onConfirm={onDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

// ---------- 决策 KPI 行：hero 主指标（按方案环节组成自适应）+ 成功运行 + 单次预估 ----------
function PlanKpiStrip({ planId, stages, runs, loading }: {
  planId: string;
  /** 方案定义的环节：hero 指标由它决定（D-1）——无 observe 环节的方案，
   *  「线上评估均分」永远是「—」，那正是用户读成「平台没跑成功」的画面 */
  stages: PlanStage[] | undefined;
  runs: PlanRunSummary[];
  loading: boolean;
}) {
  const kpis = useMemo(() => deriveKpis(runs), [runs]);
  const hero = useMemo(() => planHero(stages, runs), [stages, runs]);
  // 事件名是后端契约 plan_run_estimate（app/main.py:1265），不是 plan_run_estimated
  // ——此前前端/mock 一起拼错，测试全绿而线上 KPI 恒「—」。字面量类型让下次拼错死在编译期。
  const estimate = useQuery({
    queryKey: ["plan_estimate", planId],
    queryFn: () =>
      apiOne<{ event: "plan_run_estimate"; estimated_cost_usd: number }>(
        { action: "estimate_plan_run", plan_id: planId },
        "plan_run_estimate",
      ),
  });

  return (
    <div className="kpi-strip" style={{ "--kpi-cols": 2 } as React.CSSProperties} data-testid="plan-kpis">
      <div className="kpi kpi-hero">
        {/* 标签与 scope 都由方案组成决定（derive.planHero）：
            含 observe → 「线上评估均分 · 线上评估有分运行」（现状）
            无 observe 但含 dataset → 「回归通过率 · 跑完回归环节的运行」
            只有 redteam → 「红队攻破 · 最近一次红队运行」
            scope 文案必须与取样口径一致，且与右侧「成功运行」（按环节判定）
            刻意不同 —— 两个数合法不等（CONTEXT.md:145-150）。
            ⚠️ 换指标 ≠ 合成总分：三个量纲永不相加（ADR-0003 硬线）。 */}
        <div className="kpi-label">
          {hero.label} <span className="kpi-scope">{hero.scope}</span>
        </div>
        <div className="kpi-hero-row">
          {/* testid 保持历史名（hero 数值位，三形态共用）；口径由 data-metric 说 */}
          <span className="kpi-hero-num" data-testid="plan-kpi-avg" data-metric={hero.kind}>
            {loading ? "…" : hero.value ?? "—"}
            {!loading && hero.value != null && hero.denom
              ? <span className="denom">{hero.denom}</span>
              : null}
          </span>
          {hero.deltaText && (
            <span
              className={`kpi-hero-delta${hero.deltaNeg ? " neg" : ""}`}
              data-testid="plan-kpi-delta"
            >
              {hero.deltaText}
            </span>
          )}
        </div>
        <div className="kpi-hero-meta">
          {/* 空态原话按形态分（D-1）：「有 observe 却没跑出分」与「根本没有
              observe 环节」是两个不同的「—」，共用一句话等于没解释。 */}
          {!loading && hero.value == null ? (
            <span data-testid="plan-kpi-avg-empty">{hero.emptyText}</span>
          ) : (
            <span>{hero.meta}</span>
          )}
        </div>
      </div>
      <div className="kpi">
        <div className="kpi-label"><span className="dot good" />成功运行</div>
        <div className="kpi-val" data-testid="plan-kpi-success">
          {loading ? "…" : `${kpis.successCount}/${kpis.totalCount}`}
        </div>
        <div className="kpi-foot">有结果 / 总次数</div>
      </div>
      <div className="kpi">
        <div className="kpi-label"><span className="dot viz1" />单次预估</div>
        <div className="kpi-val" data-testid="plan-kpi-estimate">
          {estimate.isLoading
            ? "…"
            : estimate.data
              ? <>${estimate.data.estimated_cost_usd.toFixed(2)}</>
              : "—"}
        </div>
      </div>
    </div>
  );
}

// ---------- 运行历史 ----------
function RunHistoryCard({ planId, plan, runs, query, stop, resume, planName }: {
  planId: string;
  /** 方案定义（D-5）：只传给报告抽屉判环节展示名，表格本身仍是列表口径。
   *  续跑确认卡也读它的 stages.length（「共 N 个环节」与切片口径同源）。 */
  plan: Plan;
  runs: PlanRunSummary[];
  query: { isLoading: boolean; isError: boolean; error: unknown };
  /** 停止入口（只给 status=running 的行用，不依赖当次流式会话） */
  stop: StopEntry;
  /** 从检查点续跑入口（只给「终态 + 有检查点」的行用） */
  resume: ResumeEntry;
  planName: string;
}) {
  /** 对比选中的第一行（null = 没在选）。第二行一点就开抽屉 —— 「选两行」这件事
   *  不该再要一次「开始对比」的点击。 */
  const [pickKey, setPickKey] = useState<string | null>(null);
  /** 续跑确认卡当前问的是哪一行（null = 卡关着）。卡只有**一个实例**（挂在本卡
   *  底部，与两个抽屉同款）：每行各一个实例就等于每行各订阅一次预估查询。 */
  const [resumeKey, setResumeKey] = useState<string | null>(null);
  /** 对比抽屉的两个 run（null = 关）；A 恒为较早那次（orderComparePair） */
  const [comparePair, setComparePair] = useState<ComparePair | null>(null);

  /** 行上的「对比」被点：没选过 → 选中它；已选中它 → 取消；已选别的 → 开对比。 */
  function onPick(runKey: string) {
    if (pickKey === runKey) { setPickKey(null); return; }
    if (pickKey == null) { setPickKey(runKey); return; }
    const ordered = orderComparePair(runs, pickKey, runKey);
    setPickKey(null);
    if (!ordered) return;
    setComparePair(ordered);
  }

  const pickSeq = pickKey ? runs.length - runs.findIndex((r) => r.run_key === pickKey) : null;

  return (
    <div className="card" data-testid="plan-runs-card">
      <div className="card-head">
        <span className="card-title">运行历史</span>
        <span className="card-count" data-testid="plan-runs-count">{runs.length}</span>
        {/* 已选一行时的提示：说清还差什么，并给一条退出路径（选错了要能取消） */}
        {pickKey && (
          <>
            <span className="spacer" style={{ flex: 1 }} />
            <span className="subtle" data-testid="plan-compare-pick-hint">
              已选 #{pickSeq} 作为对比基准
            </span>
            <button
              type="button"
              className="btn-link"
              data-testid="plan-compare-pick-clear"
              onClick={() => setPickKey(null)}
            >
              取消
            </button>
          </>
        )}
      </div>
      {query.isLoading && <div className="card-body subtle">加载中…</div>}
      {query.isError && (
        <div className="card-body plan-editor-error" data-testid="plan-runs-error">
          {query.error instanceof Error ? query.error.message : String(query.error)}
        </div>
      )}
      {!query.isLoading && !query.isError && runs.length === 0 && (
        <div className="card-body subtle" data-testid="plan-runs-empty">
          还没有运行记录
        </div>
      )}
      {runs.length > 0 && (
        <table className="u-table" data-testid="plan-runs-table">
          <colgroup>
            <col style={{ width: 44 }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 76 }} />
            <col />
            <col style={{ width: 96 }} />
            {/* 操作列：查看报告 + 对比（running 行还有「停止」）——
                108px 是只有一个动作时的宽度，两个动作会把行挤变形 */}
            <col style={{ width: 156 }} />
          </colgroup>
          <thead>
            <tr>
              <th className="lat r">#</th>
              <th>时间</th>
              <th className="r">耗时</th>
              <th>结果</th>
              <th>触发方式</th>
              <th className="r">操作</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r, i) => (
              <RunRow
                key={r.run_key}
                run={r}
                seq={runs.length - i}
                /* 「查看报告」= 去独立报告页，不再开抽屉。内容量决定容器：这一面
                   远超一屏，读几分钟的长文不该关在浮层里；成页顺手买到可加书签、
                   可后退回这张运行历史表、可把链接发给同事。 */
                onOpen={() => navigate(`#/report/${encodeURIComponent(r.run_key)}`)}
                picked={pickKey === r.run_key}
                onPick={() => onPick(r.run_key)}
                stop={stop}
                resume={resume}
                onResumeAsk={() => setResumeKey(r.run_key)}
                planName={planName}
              />
            ))}
          </tbody>
        </table>
      )}
      <ResumeConfirmCard
        run={runs.find((r) => r.run_key === resumeKey) ?? null}
        planId={planId}
        planName={planName}
        stagesTotal={(plan.stages ?? []).length}
        onCancel={() => setResumeKey(null)}
        onConfirm={(k) => { setResumeKey(null); resume.onResume(k); }}
      />
      <CompareDrawer
        pair={comparePair}
        runs={runs}
        /* 关抽屉时把选择一起清掉：下一次对比从零开始选，免得残留的基准
           让用户下一次随手一点就开出一对他没想比的运行 */
        onClose={() => { setComparePair(null); setPickKey(null); }}
      />
    </div>
  );
}

function RunRow({ run, seq, onOpen, picked, onPick, stop, resume,
                 onResumeAsk, planName }: {
  run: PlanRunSummary;
  seq: number;
  /** 「查看报告」：现在是去 #/report/<run_key>（不再有「这一行的抽屉开着」这个态，
   *  所以行上也不再有选中高亮 —— 报告开在另一页，这张表里没有它的痕迹） */
  onOpen: () => void;
  /** 已被选为对比基准（再点另一行即可对比） */
  picked: boolean;
  onPick: () => void;
  stop: StopEntry;
  resume: ResumeEntry;
  /** 点「从检查点重试」= 开确认卡（真发请求在卡确认之后） */
  onResumeAsk: () => void;
  planName: string;
}) {
  // 陈旧 running 的展示态（UI-029 批 3 交付 4）：后端读侧判定这条 running 的执行
  // 进程已停（stalecheck.is_stale），status 却还是 running —— 显示中性「疑似中断」，
  // 判定与改判都不在前端（改判落库归 reaper）。runBadge/STATUS_LABEL 一行不改：
  // 那是五态的唯一权威，这里只是在 running 这一格上换用另一条展示投影。
  const badge = run.status === "running" && run.stale === true
    ? STALE_RUNNING_BADGE
    : runBadge(run);
  const chips = runMetricChips(run);
  const version = (run.agent_version_label ?? "").trim();
  const compareBlocked = comparableReason(run);
  return (
    <tr data-testid={`plan-run-row-${run.run_key}`}>
      <td className="num subtle">{seq}</td>
      <td className="mono" data-testid={`plan-run-row-${run.run_key}-time`}>
        {fmtRunTime(run.started_at)}
      </td>
      <td className="num">{fmtDuration(run.duration_s)}</td>
      <td>
        {/* 口径统一（lib/scoring.ts runOutcome）：按环节判定——纯回归/纯红队
            跑成功也是「完成」并展示该环节真实指标；有环节炸了走「部分失败」
            /「失败」；只有环节全 empty 才是中性「完成 · 无可评估数据」。 */}
        <span className={badge.cls} data-testid={`plan-run-row-${run.run_key}-badge`}>
          <span className="dot" />
          {badge.label}
          {chips.map((c) => (
            <span className="badge-mono" key={c}>{c}</span>
          ))}
        </span>
        {/* 版本 chip：**这一次运行时**的版本标签（run 快照，落库那一刻冻结）。
            不读 Agent 当前标签 —— 事后改标签不许改动历史 run 的归属（护栏 1）。
            老 run 没有快照（旧数据不修）→ 整个 chip 不画，绝不画一个空 chip。
            摆在结果 badge **外面**：badge 里装的是指标 chip（均分/通过率/攻破数），
            版本不是指标，混进去会被读成又一个数字。 */}
        {version && (
          <span
            className="badge badge-mono plan-run-version"
            data-testid={`plan-run-row-${run.run_key}-version`}
          >
            {version}
          </span>
        )}
        {run.status === "skipped" && run.skip_reason && (
          <span className="subtle" data-testid={`plan-run-row-${run.run_key}-skip-reason`}>
            {" "}{run.skip_reason}
          </span>
        )}
        {/* 运行中那一行的存活事实（交付 3）：心跳多久前 + 已完成几个环节。
            这一列本来就是放补充说明的地方（skip_reason / 停止回执都在这里）。
            老 run 缺字段 → 整段不画（RunLiveFacts 自己判），绝不伪造。 */}
        {run.status === "running" && " "}
        {run.status === "running" && (
          <RunLiveFacts
            heartbeatEpoch={run.heartbeat_epoch}
            progress={run.progress}
            testid={`plan-run-row-${run.run_key}`}
            now={Date.now()}
          />
        )}
        {/* 停止请求的回执（中间态说明 / 失败原因）跟在 badge 后面 —— 与
            skip_reason 同一个位置，那是本列既有的补充说明位；操作列只有 108px，
            塞不下后端那句完整回执。 */}
        <StopRunMessages
          runKey={run.run_key}
          stop={stop}
          testid={`plan-run-row-${run.run_key}-stop`}
          showPending={run.status === "running"}
        />
      </td>
      <td className="muted">{triggerLabel(run.triggered_by)}</td>
      <td>
        <div className="row-actions">
          <button
            type="button"
            className="btn-link"
            data-testid={`plan-run-row-${run.run_key}-report`}
            onClick={onOpen}
          >
            查看报告
          </button>
          {/* 对比：选两行并排看（默认从这一行开始选）。运行中的（还没有报告）与
              被跳过的（只有一条 marker）置灰并把原因写进 title —— 操作列没有位置
              铺一句说明。闸门与报告抽屉的「与上次对比」同一份判据。 */}
          <button
            type="button"
            className="btn-link"
            data-testid={`plan-run-row-${run.run_key}-compare`}
            aria-pressed={picked}
            disabled={compareBlocked != null}
            title={compareBlocked ?? undefined}
            onClick={onPick}
          >
            {picked ? "对比（已选）" : "对比"}
          </button>
          {/* 停止入口只挂在 running 行上（终态行不给——那是「无需停止」的无操作，
              后端也会照实拒绝）。这条路径**不依赖当次流式会话**：刷新页面、换台
              电脑打开都能停一次还在花钱的运行（验收 6）。 */}
          {run.status === "running" && (
            <StopRunControl
              runKey={run.run_key}
              planName={planName}
              stop={stop}
              testid={`plan-run-row-${run.run_key}-stop`}
              label="停止"
              // 陈旧行的停止是**死路**：进程已失联，标志写了没人消费（见
              // StopRunControl 的 blockedReason 注释）。入口保留但置灰，理由进
              // title —— 判据仍只有后端那个布尔，与本行 badge 读的是同一个。
              blockedReason={run.stale === true
                ? "该运行已失联，停止标志不会被消费"
                : undefined}
              withMessages={false}
            />
          )}
          {/* 从检查点重试（UI-029 批 4）：只对「终态 error/stopped 且留有检查点」
              的行出现（判据 resume.isResumable，前端零推断）—— completed 不给
              （白花一次钱）、老 run 没有那个字段自然不给（旧数据不修）。
              这条方案已有一次运行在飞时置灰并把理由写进 title：操作列没有位置
              铺一句说明，但「为什么灰着」必须说得出来。 */}
          {isResumable(run) && (
            <button
              type="button"
              className="btn-link"
              data-testid={`plan-run-row-${run.run_key}-resume`}
              disabled={resume.busyHint != null}
              title={resume.busyHint ?? undefined}
              onClick={onResumeAsk}
            >
              从检查点重试
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
