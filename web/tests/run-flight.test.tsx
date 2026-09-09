// 缺陷 1（P1）：后台发起的 run 无人消费。
//
// 旧行为（工作台 RunPlanButton / agents detail/actions.ts 同一份写法）：
//   void callApi({action:"run_plan",…}, () => {}).catch(() => {});
//   showToast("已开始");
// 三处坑：① 空回调把后端 {event:"error"} 吞掉；② .catch(()=>{}) 把 fetch 异常
// 吞掉；③「已开始」在任何响应到达之前就弹 —— 一个字都没跑也报喜。
// 且方案详情页**不消费**这条流（useRunPlan 的 state 是 hook 局部 useState），
// 于是 `running={runner.state.phase === "running"}` 对后台 run 恒 false，
// 运行按钮照样可点 → 同一个方案并发跑两次（真花两份钱）。
//
// 本文件用「工作台 + 方案详情页同树同 QueryClient」把跨组件通道钉住：
// 一处发起，另一处必须看见在飞并挡住第二次发起。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectProseGone } from "./prose";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTest } from "../src/lib/config";
import { sseFrames, AGENT_PLANS, AGENT_RUNS } from "../src/mocks/handlers";
import WorkbenchPage from "../src/pages/workbench/WorkbenchPage";
import PlanDetailPage from "../src/pages/plan/PlanDetailPage";
import {
  clearRunFlight, holdPlanRun, resetRunFlightForTest, runFlightOf, startPlanRun,
} from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
const PLAN_ID = "plan-aaa111";

type Payload = { action?: string } & Record<string, unknown>;

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** 手动可控的 SSE 流：run 一直在飞（不 close），用于「在飞时挡住第二次发起」 */
function controlledSse() {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
  return {
    response: new Response(stream, {
      status: 200, headers: { "Content-Type": "text/event-stream" },
    }),
    push(ev: unknown) { ctrl!.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)); },
    close() { ctrl!.close(); },
  };
}

// 形态照真后端：estimate（app/main.py:1414-1416 + planrun.py:91-93）、
// plan_runs（list_plan_runs 的 {event:"plan_runs", runs}）。
function defaultDispatch(payload: Payload): Response {
  switch (payload.action) {
    case "list_plans":
      return sseResponse([{ event: "plans", plans: AGENT_PLANS }]);
    case "list_recent_runs":
      return sseResponse([{ event: "recent_runs", runs: AGENT_RUNS }]);
    case "list_plan_runs":
      return sseResponse([{ event: "plan_runs", runs: [] }]);
    case "estimate_plan_run":
      return sseResponse([{
        event: "plan_run_estimate",
        plan_id: payload.plan_id,
        stages: [{ type: "observe", judge_calls: 20, estimated_cost_usd: 0.42 }],
        estimated_cost_usd: 0.42,
        note: "各环节预估合计（运行结束后还会生成一次评估计划级综合报告，"
          + "增加一次 judge 调用费用）；实际以运行为准",
      }]);
    default:
      return sseResponse([{ event: "error", error: `未实现 ${payload.action}` }]);
  }
}

function stubFetch(overrides: Record<string, (payload: Payload) => Response> = {}) {
  const calls: Payload[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    calls.push(payload);
    const handler = overrides[payload.action ?? ""];
    return handler ? handler(payload) : defaultDispatch(payload);
  }));
  return calls;
}

/** 工作台与方案详情页同树同 QueryClient：模拟「工作台发起 → 跳详情页看」 */
function renderBoth(ui?: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      {ui ?? (<><WorkbenchPage /><PlanDetailPage id={PLAN_ID} /></>)}
    </QueryClientProvider>,
  );
}

function countOf(calls: Payload[], action: string): number {
  return calls.filter((c) => c.action === action).length;
}

/** 所有 toast 的文本拼起来（toast 挂 document.body，React 树外） */
function toastText(): string {
  return [...document.querySelectorAll(".wb-toast")].map((el) => el.textContent).join(" | ");
}

/** 工作台方案行「运行」→ 二次确认卡「运行」（缺陷 2 加的一步） */
async function startFromWorkbench() {
  fireEvent.click(await screen.findByTestId(`plan-row-${PLAN_ID}-run`));
  // 确认卡只留成本披露；「预估为各环节合计，实际以运行为准」对任何预估恒成立 ⇒ 删
  // （prose-sweep 2026-09-03）
  expectProseGone(screen.getByTestId("confirm-card"), "实际以运行为准", "各环节合计");
  fireEvent.click(screen.getByTestId("confirm-card-ok"));
}

beforeEach(() => {
  resetConfigForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  location.hash = "#/workbench";
  // 模块级在途状态：逐测清干净，否则上一条用例漏下的在飞/错误会串味
  resetRunFlightForTest();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.querySelectorAll(".wb-toast").forEach((el) => el.remove());
});

describe("缺陷 1：后台 run 的可见性", () => {
  it("「已开始」不再无条件弹：后端首个事件到达前不报喜，到了才报", async () => {
    const stream = controlledSse();
    const calls = stubFetch({ run_plan: () => stream.response });
    renderBoth();
    await startFromWorkbench();
    // 请求已发出，但后端还一个字没回 → 此刻报喜就是撒谎
    await waitFor(() => expect(countOf(calls, "run_plan")).toBe(1));
    expect(toastText()).not.toContain("已开始");
    stream.push({ event: "run_started", plan_id: PLAN_ID });
    await waitFor(() => expect(toastText()).toContain("已开始"));
    stream.close();
  });

  it("后端 {event:\"error\"} 必须可见：toast + 详情页常驻错误条，且不报「已开始」", async () => {
    // 真后端形态：run_plan 与 estimate_plan_run 共用前置校验（app/main.py:1403-1412）
    const calls = stubFetch({
      run_plan: () => sseResponse([
        { event: "error", error: "unknown agent or no logs: support-bot" },
      ]),
    });
    renderBoth();
    await startFromWorkbench();
    await waitFor(() => expect(countOf(calls, "run_plan")).toBe(1));
    // toast 只活 2.6s，失败必须还有一条常驻的（详情页错误条）
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-background-error"))
        .toHaveTextContent("unknown agent or no logs: support-bot"));
    expect(toastText()).toContain("unknown agent or no logs: support-bot");
    expect(toastText()).not.toContain("已开始");
    // 发起失败 → 不许把方案锁死在「运行中…」，按钮得能再点
    expect(screen.getByTestId("plan-run")).toBeEnabled();
  });

  it("fetch 异常必须可见（不再被 .catch(()=>{}) 吞掉）", async () => {
    const calls = stubFetch({
      run_plan: () => { throw new Error("Failed to fetch"); },
    });
    renderBoth();
    await startFromWorkbench();
    await waitFor(() => expect(countOf(calls, "run_plan")).toBe(1));
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-background-error")).toHaveTextContent("Failed to fetch"));
    expect(toastText()).toContain("Failed to fetch");
  });

  it("框架层遗言帧（无 event 字段）同刑：透出 error_type + error", async () => {
    // bedrock_agentcore 在 entrypoint 抛异常时发的是这一帧（无 event 字段），
    // 口径同 lib/api.ts 的 frameworkErrorText
    stubFetch({
      run_plan: () => sseResponse([{
        error: "Item size has exceeded the maximum allowed size",
        error_type: "ValidationException",
        message: "An error occurred",
      }]),
    });
    renderBoth();
    await startFromWorkbench();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-background-error"))
        .toHaveTextContent("ValidationException"));
    expect(screen.getByTestId("plan-run-background-error"))
      .toHaveTextContent("Item size has exceeded the maximum allowed size");
  });

  it("plan_run_skipped（预算闸门）也算失败并透出 reason", async () => {
    stubFetch({
      run_plan: () => sseResponse([
        { event: "plan_run_skipped", plan_id: PLAN_ID, reason: "本月预算已用尽（budget_usd=2.0）" },
      ]),
    });
    renderBoth();
    await startFromWorkbench();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-background-error"))
        .toHaveTextContent("本月预算已用尽（budget_usd=2.0）"));
  });
});

describe("缺陷 1：在飞的 run 挡住第二次发起（跨组件通道）", () => {
  it("工作台发起 → 详情页运行按钮变「运行中…」且 disabled；流结束后恢复", async () => {
    const stream = controlledSse();
    const calls = stubFetch({ run_plan: () => stream.response });
    renderBoth();
    await startFromWorkbench();
    stream.push({ event: "run_started", plan_id: PLAN_ID });
    // 锚点挑目标数据专属：详情页那颗按钮的「运行中…」文案（不是通用的「运行」）
    await waitFor(() => expect(screen.getByTestId("plan-run")).toHaveTextContent("运行中…"));
    expect(screen.getByTestId("plan-run")).toBeDisabled();
    // 工作台自己那颗也锁住（同一通道）
    expect(screen.getByTestId(`plan-row-${PLAN_ID}-run`)).toBeDisabled();
    // 详情页显示「后台运行中」（本页 useRunPlan 是 idle，进度不在本页）
    expect(screen.getByTestId("plan-run-background")).toBeInTheDocument();
    // 「结束后运行历史会自动刷新」对任何后台 run 恒成立 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("plan-run-background"), "自动刷新");
    // 全程只发过一次 run_plan
    expect(countOf(calls, "run_plan")).toBe(1);

    stream.push({ event: "plan_run_report", plan_id: PLAN_ID, status: "completed" });
    stream.close();
    await waitFor(() => expect(screen.getByTestId("plan-run")).toBeEnabled());
    expect(screen.getByTestId("plan-run")).toHaveTextContent("运行");
    expect(screen.queryByTestId("plan-run-background")).toBeNull();
  });

  it("详情页自己发起（useRunPlan 消费流）→ 工作台那颗也锁住", async () => {
    const stream = controlledSse();
    const calls = stubFetch({ run_plan: () => stream.response });
    renderBoth();
    fireEvent.click(await screen.findByTestId("plan-run"));
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await waitFor(() => expect(countOf(calls, "run_plan")).toBe(1));
    await waitFor(() =>
      expect(screen.getByTestId(`plan-row-${PLAN_ID}-run`)).toBeDisabled());
    // 前台 run 走 useRunPlan 的进度卡，不重复挂「后台运行中」
    expect(screen.getByTestId("plan-run-progress")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-run-background")).toBeNull();
    stream.push({ event: "plan_run_report", plan_id: PLAN_ID, status: "completed" });
    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId(`plan-row-${PLAN_ID}-run`)).toBeEnabled());
  });

  // 竞态窗口：按钮 disabled 只挡「渲染之后」的点击。卡开着的这几秒里别处（另一个
  // 标签页动作 / Agent 页）把 run 发了，确认也不能再跑一次——闸门必须在模块层。
  it("确认卡开着时别处已发起：确认不再跑第二次，且明说原因", async () => {
    const calls = stubFetch();
    renderBoth();
    fireEvent.click(await screen.findByTestId(`plan-row-${PLAN_ID}-run`));
    const release = holdPlanRun(PLAN_ID); // 模拟别处刚刚发起
    expect(release).not.toBeNull();
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await waitFor(() => expect(toastText()).toContain("该计划已有一次运行在进行中"));
    expect(countOf(calls, "run_plan")).toBe(0);
    release?.();
  });

  it("模块层闸门本体：在飞期间 startPlanRun 返回 false 且不发第二个 run_plan", async () => {
    const stream = controlledSse();
    const calls = stubFetch({ run_plan: () => stream.response });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const notes: string[] = [];
    const deps = { qc, notify: (t: string) => notes.push(t) };
    expect(startPlanRun(PLAN_ID, deps)).toBe(true);
    await waitFor(() => expect(countOf(calls, "run_plan")).toBe(1));
    expect(startPlanRun(PLAN_ID, deps)).toBe(false);
    expect(countOf(calls, "run_plan")).toBe(1);
    // 另一个方案不受影响（闸门按 plan_id，不是全局锁）
    expect(startPlanRun("plan-bbb222", deps)).toBe(true);
    stream.close();
  });
});

// 停止运行（stop_plan_run）配套：拿到后端「这条 run 已经是终态」的回执时，
// 在飞标记必须跟着清 —— 流可能还被心跳撑着，不清就一直「运行中…」。
// 页面级的串联在 tests/plan-stop-run.test.tsx。
describe("在飞标记的手动收束（停止路径用）", () => {
  it("clearRunFlight 清 running，保留错误（失败原因要留在界面上）", () => {
    const release = holdPlanRun(PLAN_ID);
    expect(runFlightOf(PLAN_ID).running).toBe(true);
    clearRunFlight(PLAN_ID);
    expect(runFlightOf(PLAN_ID).running).toBe(false);
    // release 迟到也不许把标记翻回去
    release?.();
    expect(runFlightOf(PLAN_ID).running).toBe(false);
  });

  it("没有在飞时是无操作（不许凭空造一条空状态出来）", () => {
    clearRunFlight("plan-never-ran");
    expect(runFlightOf("plan-never-ran")).toEqual({ running: false, error: null });
  });
});

describe("缺陷 1：运行结束后刷新运行历史与预估", () => {
  it("流结束后 list_plan_runs 与 estimate_plan_run 都被重新请求", async () => {
    const stream = controlledSse();
    const calls = stubFetch({ run_plan: () => stream.response });
    renderBoth();
    // 等首屏两条查询各落地一次
    await waitFor(() => expect(countOf(calls, "list_plan_runs")).toBe(1));
    await startFromWorkbench();
    await waitFor(() => expect(countOf(calls, "estimate_plan_run")).toBeGreaterThan(0));
    stream.push({ event: "run_started", plan_id: PLAN_ID });
    const runsBefore = countOf(calls, "list_plan_runs");
    const estBefore = countOf(calls, "estimate_plan_run");
    stream.push({ event: "plan_run_report", plan_id: PLAN_ID, status: "completed" });
    stream.close();
    await waitFor(() => {
      expect(countOf(calls, "list_plan_runs")).toBeGreaterThan(runsBefore);
      expect(countOf(calls, "estimate_plan_run")).toBeGreaterThan(estBefore);
    });
  });
});
