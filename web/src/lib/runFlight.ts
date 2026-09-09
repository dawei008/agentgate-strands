// 「这条方案有一次 run 在飞」的跨组件通道（缺陷 1）。
//
// 为什么必须是**模块级** store（而不是组件 state / react-query 缓存 / context）：
//   · 组件 state 不行：发起点（工作台方案行、Agent 详情页）点完就 navigate 走人，
//     组件当场卸载；旧代码 useRunPlan 的 state 是 hook 局部 useState，于是方案
//     详情页对「别处发起的 run」一无所知，`running` 恒 false，按钮照样能点 →
//     同一个方案并发跑两次，花两份真钱。
//   · react-query 也不合适：这不是「服务器数据的缓存」，而是「本次页面会话里我
//     发起了什么」的本地事实，写进查询缓存会被 invalidate/refetch 冲掉。
//   · context 需要一个共同祖先来放 provider，而两个发起点分布在不同路由页；
//     模块级 store + useSyncExternalStore 是 React 18 官方的树外状态订阅口子。
//
// 边界（诚实说明，不假装解决）：
//   · 刷新页面 = 模块状态清零。**这条已由 `adoptRunFlight` 关掉一半**（UI-029
//     批 3）：方案详情页挂载时读 list_plan_runs（权威读），发现 status=running
//     且**未陈旧**的 run 就把在飞标记认领回来 —— 刷新后本页与工作台/Agent 页
//     那两颗「运行」照旧锁着。仍然剩下的那一半：**没打开过方案详情页**的会话
//     （直接在工作台点运行两次、中间刷新过）看不到这次认领 —— 那两个页面不做
//     这次权威读；真正的闸门仍要后端加（见下条）。
//   · **后端没有 per-plan 并发闸门**：app/main.py 的 run_plan 只做「方案存在 /
//     Agent 有日志」前置校验（app/main.py:1403-1412）就直接 execute_plan_run，
//     没有任何「该方案已有 running 的 PLANRUN 就拒绝」的判断。所以这层是前端
//     防误点，不是并发正确性保证；真正的闸门要后端加。
import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { callApi, type ApiEvent } from "./api";

export type RunFlightState = {
  /** true = 本次页面会话里，这条方案有一次 run 还在流里 */
  running: boolean;
  /** 最近一次失败原因（后端 error / plan_run_skipped / 框架遗言帧 / fetch 异常）；
   *  toast 只活 2.6 秒，失败必须留一条常驻的给用户看 */
  error: string | null;
};

/** 无在飞、无错误的稳定单例：useSyncExternalStore 的 getSnapshot 必须返回稳定引用 */
const IDLE: RunFlightState = { running: false, error: null };

const flights = new Map<string, RunFlightState>();
const listeners = new Set<() => void>();

function emit(): void {
  // 复制一份再遍历：回调里 React 可能同步退订
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function write(planId: string, next: RunFlightState): void {
  if (!next.running && next.error == null) flights.delete(planId);
  else flights.set(planId, next);
  emit();
}

export function runFlightOf(planId: string): RunFlightState {
  return flights.get(planId) ?? IDLE;
}

/** 订阅某方案的在飞/错误状态（树外 store → useSyncExternalStore） */
export function useRunFlight(planId: string): RunFlightState {
  return useSyncExternalStore(
    subscribe,
    () => runFlightOf(planId),
    () => IDLE,
  );
}

export function clearRunFlightError(planId: string): void {
  const cur = runFlightOf(planId);
  if (cur.error != null) write(planId, { running: cur.running, error: null });
}

/**
 * 「这条方案没有 run 在飞了」——**只在拿到后端的终态回执之后**调。
 *
 * 正常路径不需要它：holdPlanRun 的 release / startPlanRun 的 finally 在流结束时
 * 就清掉了标记（停止收敛成 stopped 走的也是这条路——流照常收束）。
 * 需要它的是「流还挂着、可 run 已经终态」那一格：stop_plan_run 的回执明说
 * `requested:false`（planrun.request_stop 对已终态 run 的无操作分支）时，权威读
 * 已经告诉我们这次运行结束了，而本地那条流可能还被心跳撑着——不清标记，页面
 * 就会一直显示「运行中…」，运行按钮一直锁着（用户眼里 = 界面坏了）。
 *
 * 诚实说明：本通道是 per-plan 的，不带 run_key。若此刻真有**另一次** run 在飞，
 * 这一清会把闸门提前放开（后端本来也没有并发闸门，见文件顶部）。相比「永远锁死」
 * 选这一边。
 */
export function clearRunFlight(planId: string): void {
  const cur = runFlightOf(planId);
  if (cur.running) write(planId, { running: false, error: cur.error });
}

// ---------- 「后端明说这条 run 已经终态了」的登记（UI-029 批 3）----------
//
// 为什么需要它：`stop_plan_run` 的**权威回执**可能说「这次运行已完成，无需停止」
// （planrun.request_stop 对已终态 run 的无操作分支），而**运行历史那一拉**可能还是
// 上一秒的 running 行。认领（adoptRunFlight）如果只看列表，就会在 clearRunFlight
// 之后立刻把标记复活 —— 页面永远显示「运行中…」。
//
// 修法**不靠时序**（不假设「终态那一拉先到」——本仓 11 例 waitFor 锚点事故都源于
// 这种赌）：权威回执一到就把 run_key 记进本集合，认领**跳过**集合里的 key；等列表
// 读回来那条真的不再是 running（或整条记录消失），登记自然退休（pruneSettledRunKeys）。
// 不变式：**权威终态回执之后，无论运行历史那一拉是什么，在飞标记都不许被复活。**
const settled = new Set<string>();

/** 权威回执说这条 run 已经是终态（stop 的 noop 分支）。 */
export function noteRunSettled(runKey: string): void {
  if (runKey) settled.add(runKey);
}

/** 认领判据之一：这条 run 已被权威回执判过终态 ⇒ 不许再当成在飞。 */
export function isRunKnownSettled(runKey: string): boolean {
  return settled.has(runKey);
}

/**
 * 登记退休：`stillRunning` = 权威读里**仍然**是 running 的 run_key 集合。
 * 不在其中的登记项说明列表已经追上回执（或那条记录没了），可以忘掉 ——
 * 否则一个永久登记会让同一个 run_key 将来再也不能被认领。
 */
export function pruneSettledRunKeys(stillRunning: Iterable<string>): void {
  const alive = new Set(stillRunning);
  for (const key of [...settled]) if (!alive.has(key)) settled.delete(key);
}

/**
 * 权威读认领（UI-029 批 3）：后端有一条 running 且**未陈旧**的 run ⇒ 把在飞标记
 * 登记上。关闭文件顶部「刷新 = 闸门清零」那条失明边界的前半段。
 *
 * ⚠️ 口径：这是 **UX 级**闸门（防同一个人在界面上重复点掉两份钱），**不是**
 * 防重复扣费的保障 —— 跨浏览器、另一台设备、直调 API 都绕得过。真正的守卫是
 * **后端 per-plan 并发闸门**（另档另批：run-plan-no-per-plan-concurrency-gate）。
 * 所以别把这段读成「已防止重复运行」。
 *
 * 谁调用：方案详情页（它本来就要拉 list_plan_runs），条件由**后端读侧**给的
 * `stale` 决定 —— 本模块与调用方都不自造陈旧判定，判据只有 app/stalecheck.py
 * 那一份（reaper / 读侧 / 将来的后端并发闸门共用同一个函数）。陈旧的 running
 * 不认领：它的执行进程已判定停止，认领会把闸门永久锁死（存量僵尸就是这么锁死的）。
 *
 * 幂等：已在飞（本会话自己发起的那条流）时**什么都不做**并返回 false —— 绝不
 * 覆盖真实在飞的登记。释放走既有 `clearRunFlight`（权威读说它终态了）。
 */
export function adoptRunFlight(planId: string): boolean {
  const cur = runFlightOf(planId);
  if (cur.running) return false;
  write(planId, { running: true, error: cur.error });
  return true;
}

/** 逐测清零（模块级状态会在同一文件的用例之间串味） */
export function resetRunFlightForTest(): void {
  flights.clear();
  settled.clear();
  emit();
}

/**
 * 占位：拿到返回值 = 这条方案的运行归你，用完必须调它释放；
 * 返回 null = 已有一次在飞，**别发第二次**。
 *
 * 给「自己消费流」的调用方用（方案详情页走 useRunPlan 自己读流，只需要在这条
 * 通道上登记，让别的页面看得见）。
 */
export function holdPlanRun(planId: string): (() => void) | null {
  if (runFlightOf(planId).running) return null;
  write(planId, { running: true, error: null });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // 释放只清 running，保留 error（失败原因要留在界面上）
    write(planId, { running: false, error: runFlightOf(planId).error });
  };
}

/**
 * 框架层遗言帧的文案；null = 不是这个形态。
 *
 * 后端异常穿出 entrypoint（app/main.py 的 invoke 是 async generator）时，
 * bedrock_agentcore 不发应用协议的 {event:"error"}，而是发
 *   {error: str(e), error_type: type(e).__name__, message: "An error occurred…"}
 * ——**没有 `event` 字段**（bedrock_agentcore/runtime/app.py:887-891）。不认这帧，
 * 消费方就只会报「未收到 X」/「连接中断」，把真因（如 DynamoDB 的
 * ValidationException: Item size has exceeded…）盖得一点不剩。
 * message 恒是那句英文模板，不带信息，故不呈现。
 *
 * 为什么住在本文件并导出：直连 callApi 的消费方现在有三个（本文件、lib/api.ts 的
 * apiOne、pages/plan/useRunPlan），而 api.ts 里那份 frameworkErrorText 是模块私有
 * 的、且 api.ts 不在本批改动范围内。把这一份导出去给 useRunPlan 复用，比再抄第三
 * 份好（抄三份必漂移）。→ 现存两份（api.ts:96 私有 + 本函数），逐字同源，
 * **改一处务必改两处**；等 api.ts 可动时收成一份。
 */
export function frameworkErrorText(ev: ApiEvent): string | null {
  const rec = ev as { event?: unknown; error?: unknown; error_type?: unknown };
  if (rec.event !== undefined || typeof rec.error !== "string") return null;
  const kind = typeof rec.error_type === "string" ? rec.error_type : "";
  return kind ? `后端异常 ${kind}：${rec.error}` : `后端异常：${rec.error}`;
}

/** 单条事件是否「明说的失败」；null = 不是失败帧 */
function failureText(ev: ApiEvent): string | null {
  const rec = ev as { event?: unknown; error?: unknown; reason?: unknown };
  if (rec.event === "error") return String(rec.error ?? "未知错误");
  // 预算闸门等跳过（planrun.py 的 plan_run_skipped）：没跑就是没跑，不能报「已开始」
  if (rec.event === "plan_run_skipped") return String(rec.reason ?? "本次运行已跳过");
  return frameworkErrorText(ev);
}

/** 后端明说的失败（≠ fetch/断流），只用于分类文案 */
class RunRejected extends Error {}

export type RunFlightDeps = {
  qc: QueryClient;
  /** 瞬时提示通道（实际是 components/toast 的 showToast）。注入而不是 import：
   *  注入后本 store 可脱离 DOM 测试（该机制原住 pages/workbench，那时还多一条
   *  「lib 不该反向依赖 pages」的理由；搬进 components/ 后前一条理由仍成立）。 */
  notify: (text: string) => void;
};

/**
 * 后台发起一次 run 并**把整条流消费到底**（这正是缺陷 1 的修法）：
 *   · 后端 {event:"error"} / plan_run_skipped / 框架遗言帧 / fetch 异常 → 可见
 *     （notify 瞬时 + store.error 常驻），旧代码是空回调 + .catch(()=>{}) 全吞。
 *   · 「已开始」只在**后端第一个事件真到达**之后弹（此前是无条件先报喜）。
 *   · 流在飞期间 running=true，第二次发起被挡（返回 false）。
 *   · 流结束（成功或失败）后失效 ["plan_runs", planId] 与
 *     ["plan_estimate", planId]，让运行历史与单次预估自己刷新。
 *
 * @returns false = 已有一次在飞，本次**没有**发起。
 */
export function startPlanRun(planId: string, { qc, notify }: RunFlightDeps): boolean {
  const release = holdPlanRun(planId);
  if (!release) return false;

  void (async () => {
    let started = false;
    try {
      await callApi({ action: "run_plan", plan_id: planId }, (ev) => {
        const fail = failureText(ev);
        if (fail) throw new RunRejected(fail);
        if (!started) {
          started = true;
          // 首个事件 = 后端已接单（真后端首帧也可能是 heartbeat，一样算接单）
          notify("已开始");
          // 后端开跑时就落了一条 status="running" 的 PLANRUN 记录
          //（planrun.py execute_plan_run 开头）→ 立刻刷一次运行历史，否则
          //「运行中打开运行历史是空的」。只刷这一次：一次 run 有几百条事件。
          void qc.invalidateQueries({ queryKey: ["plan_runs", planId] });
        }
      });
      // 流正常关闭却一个事件都没有 = 链路被掐，别静默当成功
      if (!started) throw new Error("后端未返回任何事件");
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const text = e instanceof RunRejected && !started
        ? `发起运行失败：${why}`
        : started
          ? `运行中断：${why}`
          : `发起运行失败：${why}`;
      write(planId, { running: true, error: text });
      notify(text);
    } finally {
      release();
      // 运行结束（不论成败）刷新历史 + 单次预估
      void qc.invalidateQueries({ queryKey: ["plan_runs", planId] });
      void qc.invalidateQueries({ queryKey: ["plan_estimate", planId] });
    }
  })();

  return true;
}
