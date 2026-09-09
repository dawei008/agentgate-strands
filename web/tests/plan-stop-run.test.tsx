// 「停止运行」前端控件（P0，pair-audit 缺口 #1 的前端一半）。
//
// 现场：红队环节跑了 33 分钟（真调用户的 Agent、真花钱），用户发现选错方案，
// 界面上没有停止；关掉浏览器也停不了。后端 action `stop_plan_run` 已合流
// （9dfbf7a），本文件钉住前端这一半。
//
// **后端语义是「请求停止」不是「同步停止」**（app/planrun.py:584-644）：
// 写 stop_requested 标志（条件写，只对 running 生效），执行侧在下一个检查点
// 收敛。所以界面上只许说「已请求停止，将在下一个检查点生效」，绝不许说「已停止」
// —— 那时它还在跑。三种回执逐字钉在 tests/test_stop_plan_run.py：
//   · running 首次   :129-138（requested:true / already:false）+ :150-156（文案）
//   · running 再次   :188-197（requested:true / already:true，幂等）
//   · 已终态无操作   :171-179（requested:false + 中文状态说明）
//   · run_key 缺失   :158-161（{event:"error"}）
//   · run_key 不存在 :163-169（{event:"error"}，含「不存在」）
// 本文件所有 stop 桩都照上面那几行的形态逐字来。**不许**造后端产不出的状态
// （mock 说谎是本项目三次白屏的根源）。
//
// run_key 的取得（本文件第 3 条用例钉住）：后端 plan_run_started
// （app/main.py:1464-1467）**不带 run_key**，只有终帧 plan_run_report 才带
// （app/main.py:1498）。所以在飞 run 的 key 唯一来源是运行历史里那条
// status=running 的记录（execute_plan_run 开跑就落，planrun.py:723-731）。
// 拿不到就把入口置灰，绝不发一个猜的 key。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectProseGone } from "./prose";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PlanDetailPage from "../src/pages/plan/PlanDetailPage";
import { STOP_WATCH_MAX_MS, stopWatchActive } from "../src/pages/plan/useRunPlan";
import { resetConfigForTest } from "../src/lib/config";
import { holdPlanRun, resetRunFlightForTest, runFlightOf } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import { sseFrames } from "../src/mocks/handlers";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
const PLAN_ID = "plan-aaa111";

type Payload = { action: string } & Record<string, unknown>;

let calls: Payload[] = [];
let overrides: Record<string, (p: Payload) => unknown[]> = {};

const PLAN = {
  plan_id: PLAN_ID,
  name: "FAQ 周回归",
  agent_name: "support-bot",
  updated_at: 1755500000,
  stages: [
    { type: "observe", evaluators: ["helpfulness"] },
    { type: "redteam", dataset: "jailbreak-probes" },
  ],
  schedule: null,
};

// run_key 形态照 planrun.py:707-708（plan_id#YYYYMMDDHHMMSS）
const RUNNING_KEY = `${PLAN_ID}#20260824090000`;
const DONE_KEY = `${PLAN_ID}#20260811090000`;

// 开跑那条 running marker 的形态照 planrun.py:723-731 过 _run_from_item：
// 没有 score、没有 duration_s、stage_summaries 是空数组（绝不伪造终态数字）。
const RUNNING_ROW = {
  run_key: RUNNING_KEY, status: "running", score: null,
  started_at: "2026-08-24 09:00 UTC", duration_s: null, triggered_by: "manual",
  stage_summaries: [],
};
const DONE_ROW = {
  run_key: DONE_KEY, status: "completed", score: 0.86,
  started_at: "2026-08-11 09:00 UTC", duration_s: 74, triggered_by: "schedule",
  stage_summaries: [
    { type: "observe", status: "completed", overall_mean: 0.86, sessions: 12, summary: {} },
  ],
};
// 停止终态：status=stopped（testrun.STOP_STATUS）、score 仍是 null（半截 run 不许
// 有 run 级综合分，test_stop_plan_run.py:371-377），已完成环节的摘要照常保留
// （:344-349），error 里一句中文说明（:364-369）。
const STOPPED_ROW = {
  ...RUNNING_ROW, status: "stopped", duration_s: 41,
  error: "已按用户请求停止：2 个环节里已完成 1 个，其余未执行",
  stage_summaries: [
    { type: "observe", status: "completed", overall_mean: 0.91, sessions: 6, summary: {} },
  ],
};

// ---- stop_plan_run 的四种回执（逐字照 planrun.request_stop 的返回 +
//      tests/test_stop_plan_run.py 的断言）----
const STOP_REQUESTED = {
  event: "plan_run_stop_requested", run_key: RUNNING_KEY, status: "running",
  requested: true, already: false, stop_requested_at: "2026-08-24 09:05 UTC",
  message: "已请求停止，将在下一个检查点生效（已完成环节的结果与已花费用照常保留）",
};
const STOP_ALREADY = {
  event: "plan_run_stop_requested", run_key: RUNNING_KEY, status: "running",
  requested: true, already: true, stop_requested_at: "2026-08-24 09:05 UTC",
  message: "此前已请求停止，仍在等待下一个检查点生效",
};
const STOP_NOOP = {
  event: "plan_run_stop_requested", run_key: RUNNING_KEY, status: "completed",
  requested: false, already: false,
  message: "这次运行已完成，无需停止（本次调用未改动任何记录）",
};
const STOP_UNKNOWN_KEY = { event: "error", error: `run '${RUNNING_KEY}' 不存在` };

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [PLAN] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: [RUNNING_ROW, DONE_ROW] }],
  estimate_plan_run: (p) => [{
    event: "plan_run_estimate", plan_id: p.plan_id,
    stages: [{ type: "observe", judge_calls: 20, estimated_cost_usd: 0.12 }],
    estimated_cost_usd: 0.12, note: "各环节预估合计；实际以运行为准",
  }],
  stop_plan_run: () => [STOP_REQUESTED],
};

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    calls.push(payload);
    const handler = overrides[payload.action] ?? DEFAULTS[payload.action];
    if (!handler) return sseResponse([{ event: "error", error: `未打桩 action '${payload.action}'` }]);
    return sseResponse(handler(payload));
  }));
}

/** 手动挡 run_plan 流（同 plan.test.tsx：流与控制器在 install 时同步建好） */
function installManualRunStream() {
  let pushFrame!: (ev: unknown) => void;
  let closeStream!: () => void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      pushFrame = (ev) => controller.enqueue(enc.encode(sseFrames([ev])));
      closeStream = () => controller.close();
    },
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    calls.push(payload);
    if (payload.action === "run_plan") {
      return new Response(stream, {
        status: 200, headers: { "Content-Type": "text/event-stream" },
      });
    }
    const handler = overrides[payload.action] ?? DEFAULTS[payload.action];
    if (!handler) return sseResponse([{ event: "error", error: `未打桩 '${payload.action}'` }]);
    return sseResponse(handler(payload));
  }));
  return { push: (ev: unknown) => pushFrame(ev), close: () => closeStream() };
}

function newQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderDetail(qc = newQc()) {
  return render(
    <QueryClientProvider client={qc}>
      <PlanDetailPage id={PLAN_ID} />
    </QueryClientProvider>,
  );
}

const stopCalls = () => calls.filter((c) => c.action === "stop_plan_run");
const rowStop = (key: string) => `plan-run-row-${key}-stop`;

/** 点停止入口 + 过确认卡 */
function clickStopAndConfirm(testid: string) {
  fireEvent.click(screen.getByTestId(testid));
  fireEvent.click(screen.getByTestId("confirm-card-ok"));
}

beforeEach(() => {
  calls = [];
  overrides = {};
  resetConfigForTest();
  location.hash = `#/plan/${PLAN_ID}`;
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
  resetRunFlightForTest();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ==================== 验收 1：进行中有入口，终态没有 ====================

describe("停止入口的出现条件", () => {
  it("运行历史里 running 行给出停止入口；终态行一个都没有", async () => {
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    expect(screen.getByTestId(rowStop(RUNNING_KEY))).toBeEnabled();
    expect(screen.queryByTestId(rowStop(DONE_KEY))).not.toBeInTheDocument();
  });

  it("当次流式会话：进度卡上的停止入口用运行历史那条 running 记录的 run_key", async () => {
    // running 行按**真后端时序**出现：write-at-start —— 那条记录是点了「运行」、
    // 开跑那一刻才落库的（planrun.execute_plan_run 开头），不是进页面就有。
    // 原夹具让它在点击**之前**就在，那个时序现实中不存在；UI-029 批 3 关闭
    // 「刷新 = 闸门清零」之后它还会把「运行」按钮锁住（权威读说这条方案已有一次
    // 运行在进行中）。本用例要钉的是「停止入口用哪个 run_key」，时序改对不动它。
    // 状态驱动、不按「第几拉」（本文件既有纪律：序数夹具是偶发红的同族根因）。
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: calls.some((c) => c.action === "run_plan") ? [RUNNING_ROW, DONE_ROW] : [DONE_ROW],
    }];
    const stream = installManualRunStream();
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    fireEvent.click(screen.getByTestId("plan-run"));
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await screen.findByTestId("plan-run-progress");
    // 首个事件触发运行历史刷新（useRunPlan.ts:161-165），running 行到位后
    // 停止入口才可点
    stream.push({ event: "plan_run_started", plan_id: PLAN_ID, stages: ["observe", "redteam"] });
    await waitFor(() => expect(screen.getByTestId("plan-run-stop")).toBeEnabled());
    clickStopAndConfirm("plan-run-stop");
    await waitFor(() => expect(stopCalls()).toHaveLength(1));
    expect(stopCalls()[0].run_key).toBe(RUNNING_KEY);
  });

  it("拿不到 run_key 的窗口期：进度卡停止入口置灰 + 说明，绝不发猜的 key", async () => {
    // 运行历史里还没有 running 记录（首刷比后端落 marker 更早的窗口期）
    overrides.list_plan_runs = (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: [DONE_ROW] }];
    const stream = installManualRunStream();
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    fireEvent.click(screen.getByTestId("plan-run"));
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await screen.findByTestId("plan-run-progress");
    stream.push({ event: "plan_run_started", plan_id: PLAN_ID, stages: ["observe"] });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("运行开始"));
    expect(screen.getByTestId("plan-run-stop")).toBeDisabled();
    expect(screen.getByTestId("plan-run-stop-hint")).toHaveTextContent("运行标识");
    expect(stopCalls()).toHaveLength(0);
  });
});

// ==================== 验收 2：二次确认 ====================

describe("停止的二次确认", () => {
  it("点停止只开卡：默认焦点在取消，取消不发 stop_plan_run", async () => {
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    fireEvent.click(screen.getByTestId(rowStop(RUNNING_KEY)));
    const card = screen.getByTestId("confirm-card");
    expect(card).toHaveAttribute("aria-label", "停止运行");
    expect(screen.getByTestId("confirm-card-cancel")).toHaveFocus();
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    expect(stopCalls()).toHaveLength(0);
  });

  it("卡上三句如实说明：费用不退、已完成环节保留、下一个检查点生效", async () => {
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    fireEvent.click(screen.getByTestId(rowStop(RUNNING_KEY)));
    const body = screen.getByTestId("confirm-card");
    expect(body).toHaveTextContent("已产生的费用不会退回");
    expect(body).toHaveTextContent("已完成环节的结果会保留");
    expect(body).toHaveTextContent("下一个检查点");
    // 不许承诺「立刻停止」
    expect(body).not.toHaveTextContent("立即停止");
    // 检查点机制的括号讲解（「正在跑的环节会先跑到自己的检查点，线上评估环节内部
    // 没有检查点…」）对任何 run 恒成立 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(body, "先跑到自己的检查点", "内部没有检查点");
  });
});

// ==================== 验收 3：中间态不撒谎 ====================

describe("已请求停止的中间态", () => {
  it("确认后发 stop_plan_run，界面进「已请求停止」态且不谎称已停止", async () => {
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickStopAndConfirm(rowStop(RUNNING_KEY));
    await waitFor(() => expect(stopCalls()).toHaveLength(1));
    expect(stopCalls()[0]).toMatchObject({ action: "stop_plan_run", run_key: RUNNING_KEY });
    const state = await screen.findByTestId(`${rowStop(RUNNING_KEY)}-state`);
    // 文案是后端回执原话（planrun.py:643-644）
    expect(state).toHaveTextContent("已请求停止，将在下一个检查点生效");
    expect(state).not.toHaveTextContent("已停止运行");
    // 再点一次没有意义：入口禁用
    expect(screen.getByTestId(rowStop(RUNNING_KEY))).toBeDisabled();
    // run 状态不被前端改写：仍是后端说的「运行中」
    expect(screen.getByTestId(`plan-run-row-${RUNNING_KEY}-badge`)).toHaveTextContent("运行中");
  });

  it("幂等回执（already:true）照后端原话呈现，不谎称已停止", async () => {
    overrides.stop_plan_run = () => [STOP_ALREADY];
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickStopAndConfirm(rowStop(RUNNING_KEY));
    const state = await screen.findByTestId(`${rowStop(RUNNING_KEY)}-state`);
    expect(state).toHaveTextContent("此前已请求停止，仍在等待下一个检查点生效");
  });
});

// ==================== 验收 4：终态到达后按终态显示 ====================

describe("后端收敛终态后的呈现", () => {
  it("停止请求落库后重拉运行历史：行自己刷成「已停止」badge，不用手动刷新", async () => {
    overrides.list_plan_runs = (p) => {
      // **状态驱动**（不按「第几拉」）：只要停止请求已经落库，之后每一拉都是终态。
      // 「拉了几次」不是契约 —— react-query 在满载下会多刷一次或把两次合并，按
      // 序数写的夹具（n > 1）就会把「停止后那一拉」错配到首刷上，于是断言等一个
      // 永不到来的 badge。这正是本文件偶发红的同族根因。
      const stopped = calls.some((c) => c.action === "stop_plan_run");
      return [{
        event: "plan_runs", plan_id: p.plan_id,
        runs: [stopped ? STOPPED_ROW : RUNNING_ROW, DONE_ROW],
      }];
    };
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickStopAndConfirm(rowStop(RUNNING_KEY));
    await waitFor(() =>
      expect(screen.getByTestId(`plan-run-row-${RUNNING_KEY}-badge`)).toHaveTextContent("已停止"));
    // 终态行不再给停止入口
    expect(screen.queryByTestId(rowStop(RUNNING_KEY))).not.toBeInTheDocument();
    // 也不再复述「将在下一个检查点生效」——badge 已经是答案，留着那句像还没停
    expect(screen.queryByTestId(`${rowStop(RUNNING_KEY)}-state`)).not.toBeInTheDocument();
    // 已完成环节的结果没丢（用户已付费的东西）
    expect(screen.getByTestId(`plan-run-row-${RUNNING_KEY}-report`)).toBeInTheDocument();
  });

  it("后端还没收敛：定时重拉运行历史，终态自己浮现（无需刷新）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // **状态 + 时钟驱动**（不按「第几拉」）：停止请求落库后，后端还要等自己的
    // 下一个检查点才收敛（读标志本身就有 ≥5s 节流，planrun.py:560-563）。
    // 判据取 4s —— 这里唯一要区分的两个时机是「停止请求刚落库的那一拉」（t≈0）
    // 与「之后的 5s 轮询」（t≈5000），取中间值对两端都有 1s 以上余量，不必再赌
    // 「拉到第几次」（满载下多刷/合并一次就错位，本文件偶发红的同族根因）。
    const CONVERGE_MS = 4000;
    let stopAt: number | null = null;
    overrides.stop_plan_run = () => {
      stopAt = Date.now();
      return [STOP_REQUESTED];
    };
    overrides.list_plan_runs = (p) => {
      const converged = stopAt != null && Date.now() - stopAt >= CONVERGE_MS;
      return [{
        event: "plan_runs", plan_id: p.plan_id,
        runs: [converged ? STOPPED_ROW : RUNNING_ROW, DONE_ROW],
      }];
    };
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickStopAndConfirm(rowStop(RUNNING_KEY));
    await screen.findByTestId(`${rowStop(RUNNING_KEY)}-state`);
    expect(screen.getByTestId(`plan-run-row-${RUNNING_KEY}-badge`)).toHaveTextContent("运行中");
    await vi.advanceTimersByTimeAsync(6000);
    await waitFor(() =>
      expect(screen.getByTestId(`plan-run-row-${RUNNING_KEY}-badge`)).toHaveTextContent("已停止"));
  });

  // 轮询闸门的判据是纯函数（stopWatchActive）：**封顶**必须有，否则一条永不收敛的
  // running 记录（Lambda 被硬杀 → 连 finally 都没跑，收尾归 stale-running-run-reaper
  // 那条 issue）会让页面开着就每 5s 打一次 list_plan_runs，一夜上万次。
  // 这里直接测判据（时间参数显式传入），不去跟假计时器 + react-query 的
  // refetchInterval 绕圈子 —— 那样的用例分不出「封顶生效」和「tick 没跑」。
  it("轮询闸门：在途/等收敛才盯着；超过封顶时长与非等待态一律收手", () => {
    const t0 = 1_700_000_000_000;
    expect(stopWatchActive({ phase: "idle" }, t0)).toBe(false);
    expect(stopWatchActive({ phase: "requesting" }, t0)).toBe(true);
    const req = { phase: "requested" as const, message: "已请求停止…", already: false, at: t0 };
    expect(stopWatchActive(req, t0 + 5000)).toBe(true);
    expect(stopWatchActive(req, t0 + STOP_WATCH_MAX_MS - 1)).toBe(true);
    expect(stopWatchActive(req, t0 + STOP_WATCH_MAX_MS)).toBe(false);
    // 已终态无操作 / 请求失败：没什么可等的
    expect(stopWatchActive({ phase: "noop", message: "已完成…", status: "completed" }, t0)).toBe(false);
    expect(stopWatchActive({ phase: "error", error: "boom" }, t0)).toBe(false);
  });

  it("流以终帧收束：进度卡不谎称「运行完成」，指向运行历史的终态", async () => {
    // 同上：running 行按 write-at-start 的真时序在**点了运行之后**才出现
    //（UI-029 批 3 之后，进页面就有 running 行 = 按钮被闸门锁住，点不动）
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: calls.some((c) => c.action === "run_plan") ? [RUNNING_ROW, DONE_ROW] : [DONE_ROW],
    }];
    const stream = installManualRunStream();
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    fireEvent.click(screen.getByTestId("plan-run"));
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await screen.findByTestId("plan-run-progress");
    stream.push({ event: "plan_run_started", plan_id: PLAN_ID, stages: ["observe", "redteam"] });
    await waitFor(() => expect(screen.getByTestId("plan-run-stop")).toBeEnabled());
    clickStopAndConfirm("plan-run-stop");
    await waitFor(() => expect(stopCalls()).toHaveLength(1));
    await screen.findByTestId("plan-run-stop-state");
    expect(screen.getByTestId("plan-run-progress-status"))
      .toHaveTextContent("已请求停止，将在下一个检查点生效");
    // 终帧：app/main.py:1498-1509 **不带 status**（后端刻意没发新 SSE 事件），
    // 所以前端不知道它是停下的还是跑完的 —— 一律不许说「运行完成」。
    stream.push({
      event: "plan_run_report", run_key: RUNNING_KEY, plan: PLAN, triggered_by: "manual",
      started_at: "2026-08-24 09:00 UTC", finished_at: "2026-08-24 09:06 UTC",
      duration_s: 41, overview: { stage_lines: ["线上评估：6 个会话，均分 0.91"] },
      plan_synthesis: null, synthesis_sections: [], synthesis_error: null,
      stages: [{ type: "observe", status: "completed", overall_mean: 0.91, sessions: 6 }],
    });
    stream.close();
    const status = await screen.findByTestId("plan-run-progress-status");
    await waitFor(() => expect(status).toHaveTextContent("运行已结束"));
    expect(status).not.toHaveTextContent("运行完成");
    // 此前钉的是这句里「运行历史」**在**（「…以下方运行历史里该条记录的状态为准
    // （停止的记录显示为「已停止」）」）—— 对任何已请求停止的 run 恒成立 ⇒ 只留
    // 「此前已请求停止」（prose-sweep 2026-09-03）
    expect(screen.getByTestId("plan-run-stop-note")).toHaveTextContent("此前已请求停止");
    expectProseGone(screen.getByTestId("plan-run-stop-note"), "运行历史", "显示为「已停止」");
    // 半截 run 不许给 run 级分数（后端 test_stopped_row_fabricates_no_run_score）。
    // ⚠️ 守卫词跟着屏幕文案迁移：「总分」是 CONTEXT.md:88-91 的 Avoid 词，已改名
    // 「线上评估均分」（CONTEXT.md:93-96）。断言不迁就会永真 —— UI-025 家族的
    // 这条守卫会静默解除，而它守的正是「半截 run 不许给 run 级分」。
    expect(status).not.toHaveTextContent("线上评估均分");
  });
});

// ==================== 验收 5：失败可见且不改写运行状态 ====================

describe("停止请求失败", () => {
  it("后端 error 事件：错误可见、行状态不被改写、入口恢复可点", async () => {
    overrides.stop_plan_run = () => [STOP_UNKNOWN_KEY];
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickStopAndConfirm(rowStop(RUNNING_KEY));
    const err = await screen.findByTestId(`${rowStop(RUNNING_KEY)}-error`);
    expect(err).toHaveTextContent("不存在");
    expect(err).toHaveAttribute("role", "alert");
    // 没有中间态（一个字都没请求到）
    expect(screen.queryByTestId(`${rowStop(RUNNING_KEY)}-state`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`plan-run-row-${RUNNING_KEY}-badge`)).toHaveTextContent("运行中");
    expect(screen.getByTestId(rowStop(RUNNING_KEY))).toBeEnabled();
  });

  it("框架层遗言帧（无 event 字段）同刑：透出后端异常真因", async () => {
    overrides.stop_plan_run = () => [{
      error: "Item size has exceeded the maximum allowed size",
      error_type: "ClientError",
      message: "An error occurred during invocation",
    }];
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickStopAndConfirm(rowStop(RUNNING_KEY));
    const err = await screen.findByTestId(`${rowStop(RUNNING_KEY)}-error`);
    expect(err).toHaveTextContent("ClientError");
    expect(err).toHaveTextContent("Item size has exceeded the maximum allowed size");
  });
});

// ==================== 验收 6：不依赖当次流式会话 ====================

describe("重新进入页面后的停止", () => {
  it("全程没有 run_plan：直接进页面也能停 running 记录", async () => {
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    expect(screen.queryByTestId("plan-run-progress")).not.toBeInTheDocument();
    clickStopAndConfirm(rowStop(RUNNING_KEY));
    await waitFor(() => expect(stopCalls()).toHaveLength(1));
    expect(calls.some((c) => c.action === "run_plan")).toBe(false);
  });

  it("后端说「已终态无需停止」：照原话说，并清掉在飞标记（页面不再假装在跑）", async () => {
    overrides.stop_plan_run = () => [STOP_NOOP];
    // 别处（工作台）发起的后台 run 在这条通道上登记着
    holdPlanRun(PLAN_ID);
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    expect(screen.getByTestId("plan-run")).toBeDisabled();
    clickStopAndConfirm(rowStop(RUNNING_KEY));
    const state = await screen.findByTestId(`${rowStop(RUNNING_KEY)}-state`);
    expect(state).toHaveTextContent("这次运行已完成，无需停止");
    expect(state).not.toHaveTextContent("已请求停止");
    // 权威读已说这条 run 是终态 → 在飞标记必须跟着清，否则按钮永远「运行中…」
    await waitFor(() => expect(screen.getByTestId("plan-run")).toBeEnabled());
    expect(runFlightOf(PLAN_ID).running).toBe(false);
    // 不变式（UI-029 批 3）：**权威终态回执之后，标记不许被复活** —— 本用例的
    // list_plan_runs 夹具从头到尾都还回着那条 running 行（后端列表落后于回执是
    // 常态），页面详情的在飞认领必须跳过它。这条不靠「哪一拉先到」，所以再等一拉
    // 也依然成立。
    await waitFor(() => expect(calls.filter((c) => c.action === "list_plan_runs").length)
      .toBeGreaterThan(1));
    expect(runFlightOf(PLAN_ID).running).toBe(false);
    expect(screen.getByTestId("plan-run")).toBeEnabled();
  });
});

// ==================== 验收 7：浏览器 mock（msw handler）也照后端形态 ====================
// 走 handlers.ts 本身发一次请求（与 contract-guard.test.ts 同法）：mock 与后端
// 漂移是本项目三次白屏的根源，dev 下点得通、线上点不通就是这么来的。
// 注意 PLAN_RUNS 夹具里没有 running 记录（本轮只许加 stop 分支），所以这里能覆盖
// 的是「已终态无操作」与「run_key 缺失/不存在」；running 那条由上面的页面级用例覆盖。

async function callMock(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { handlers, MOCK_ACCESS_TOKEN } = await import("../src/mocks/handlers");
  const apiHandler = handlers.find((h) =>
    String((h as { info?: { path?: unknown } }).info?.path ?? "").includes("/api/invoke"));
  const res = await (apiHandler as unknown as {
    run: (a: { request: Request }) => Promise<{ response?: Response }>;
  }).run({
    request: new Request("http://localhost/api/invoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-authorization": `Bearer ${MOCK_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    }),
  });
  const text = await res.response!.text();
  return JSON.parse(text.split("\n\n").filter(Boolean)[0].replace(/^data: /, ""));
}

describe("mocks/handlers 的 stop_plan_run 分支", () => {
  it("缺 run_key → error 事件（app/main.py:1407-1409）", async () => {
    const ev = await callMock({ action: "stop_plan_run" });
    expect(ev.event).toBe("error");
    expect(String(ev.error)).toContain("run_key");
  });

  it("run_key 不存在 → 可读的 error 事件（不留裸异常）", async () => {
    const ev = await callMock({ action: "stop_plan_run", run_key: "plan-nope#1" });
    expect(ev.event).toBe("error");
    expect(String(ev.error)).toContain("plan-nope#1");
    expect(String(ev.error)).toContain("不存在");
  });

  it("已终态的 run → requested:false + 中文状态说明（不印英文枚举）", async () => {
    const { PLAN_RUNS } = await import("../src/mocks/handlers");
    const done = PLAN_RUNS.find((r) => r.status === "completed")!;
    const ev = await callMock({ action: "stop_plan_run", run_key: done.run_key });
    expect(ev.event).toBe("plan_run_stop_requested");
    expect(ev.requested).toBe(false);
    expect(String(ev.message)).toContain("已完成");
    expect(String(ev.message)).not.toContain("completed");
  });
});
