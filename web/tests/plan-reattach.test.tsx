// UI-029 批 3：断流 ≠ 失败（转轮询）/ 刷新恢复 / 心跳与进度显示 / stale 展示。
//
// 现场（SPEC §1.2 结案）：74m16s 那次 run **什么都没丢** —— UiProxy 中继 900s
// 超时只断「看」不断「跑」（执行在 AgentCore microVM 里独活跑完并完整落库）。
// 丢的是可见性：前端把断流报成「连接中断，稍后刷新运行历史查看结果」这条死胡同，
// 用户于是失明 74 分钟。本文件钉住四件事：
//
//   ① 断流后**留在进行中面板**并转 get_plan_run(run_key) 轮询（10s），
//      终态到达即渲染报告；run_key 来自 plan_run_started（后端批 1 起带它）。
//   ② 刷新/重进页面时从 list_plan_runs 找 status=running 且 stale!==true 的 run
//      → 恢复「进行中」面板 + 10s 轮询 + 在飞闸门认领（关闭「刷新=闸门清零」）。
//   ③ 心跳与环节进度：后端给了才显示；**老 run 缺字段一律不显示、不伪造**。
//   ④ 陈旧 running 显示中性「疑似中断」（非错误红）；改判落库归 reaper。
//
// 陈旧判定**只有后端一份**（app/planrun.py:_run_from_item → stalecheck.is_stale
// 三级判据），前端零判定逻辑、只消费 `stale` 布尔 —— 所以这里的夹具一律直接给
// stale，绝不在测试里重算判据（重算等于把判据抄成第二份）。
//
// waitFor 锚点纪律（本仓 11 例偶发红的同族根因）：等待锚点必须是**断言同源的
// 事实**（目标数据专属的 testid / 那条文案本身），不拿容器可见当锚点 —— 面板容器
// 在第一批数据到达时就出现，而要断言的心跳/进度是后一拉才带回来的。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { expectProseGone } from "./prose";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PlanDetailPage from "../src/pages/plan/PlanDetailPage";
import { REATTACH_POLL_MS } from "../src/pages/plan/useRunPlan";
import { heartbeatAgeText, stageProgressText } from "../src/pages/plan/derive";
import { STALE_RUNNING_BADGE, STATUS_LABEL, statusBadgeClass } from "../src/lib/scoring";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest, runFlightOf } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import { sseFrames } from "../src/mocks/handlers";
import type { Plan } from "../src/pages/plan/types";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
const PLAN_ID = "plan-aaa111";
const RUN_KEY = "plan-aaa111#2026-08-26T02:40:00Z";

type Payload = { action: string } & Record<string, unknown>;

let calls: Payload[] = [];
let overrides: Record<string, (p: Payload) => unknown[]> = {};

const PLAN: Plan = {
  plan_id: PLAN_ID,
  name: "FAQ 周回归",
  agent_name: "support-bot",
  updated_at: 1755500000,
  stages: [
    { type: "observe", evaluators: ["helpfulness"] },
    { type: "dataset", dataset: "faq-v3", evaluators: ["correctness"] },
  ],
  schedule: { cron: "0 3 * * 1", budget_usd: 2 },
};

/** 已完成的历史行（页面 KPI/趋势要有素材，且证明终态行不被当成在飞 run）。 */
const DONE_ROW = {
  run_key: "plan-aaa111#2026-08-11T09:00:00Z",
  status: "completed", score: 0.86, started_at: "2026-08-11 09:00 UTC",
  duration_s: 74, triggered_by: "manual",
  stage_summaries: [
    { type: "observe", status: "completed", overall_mean: 0.86, sessions: 12, summary: {} },
  ],
  stale: false,
};

/** 秒级 epoch（后端 heartbeat_epoch 的量纲）。 */
const nowEpoch = () => Math.floor(Date.now() / 1000);

/** 新 running 行：心跳新鲜 + 已完成 1/2 环节（形态照后端读侧，见 mock 同刑测试）。 */
function freshRunningRow(extra: Record<string, unknown> = {}) {
  return {
    run_key: RUN_KEY, status: "running", score: null,
    started_at: "2026-08-26 02:40 UTC", finished_at: "", duration_s: null,
    triggered_by: "manual", stage_summaries: [], stale: false,
    heartbeat_epoch: nowEpoch() - 8,
    progress: {
      stages_done: 1, stages_total: 2, stage: "observe",
      stage_summaries_partial: [
        { type: "observe", status: "completed", overall_mean: 0.84, sessions: 7, summary: {} },
      ],
    },
    checkpoint_s3_key: "checkpoints/plan-aaa111/2026-08-26T02:40:00Z/stage-1.json",
    ...extra,
  };
}

/** 老 running 行：批 1 之前落库 —— 三个中途字段一个都没有（降级素材）。 */
const LEGACY_RUNNING_ROW = {
  run_key: "plan-aaa111#2026-08-20T07:15:00Z", status: "running", score: null,
  started_at: "2026-08-20 07:15 UTC", finished_at: "", duration_s: null,
  triggered_by: "schedule", stage_summaries: [], stale: false,
};

/** 陈旧 running 行：后端判定执行进程已死，status 仍是 running（改判归 reaper）。 */
const STALE_RUNNING_ROW = {
  run_key: "plan-aaa111#2026-08-26T00:05:00Z", status: "running", score: null,
  started_at: "2026-08-26 00:05 UTC", finished_at: "", duration_s: null,
  triggered_by: "schedule", stage_summaries: [], stale: true,
};

/** get_plan_run 对**运行中**的 run 的回执：真后端只回 DDB 摘要（s3_key 空 ⇒
 *  没有 report / 综合报告）。 */
function runningDetail(extra: Record<string, unknown> = {}) {
  return {
    event: "plan_run", run_key: RUN_KEY, plan_id: PLAN_ID, plan_name: "FAQ 周回归",
    agent_name: "support-bot", status: "running", score: null,
    started_at: "2026-08-26 02:40 UTC", finished_at: "", duration_s: null,
    total_cost_usd: null, stage_summaries: [], overview: {}, proposals: [],
    s3_key: null, plan_synthesis: null, synthesis_error: null, synthesis_sections: [],
    stale: false, heartbeat_epoch: nowEpoch() - 6,
    progress: {
      stages_done: 1, stages_total: 2, stage: "observe",
      stage_summaries_partial: [],
    },
    checkpoint_s3_key: "checkpoints/plan-aaa111/2026-08-26T02:40:00Z/stage-1.json",
    ...extra,
  };
}

/** get_plan_run 的终态回执（S3 全量归档已在，前端据此渲染报告）。 */
function settledDetail(status = "completed", extra: Record<string, unknown> = {}) {
  return {
    event: "plan_run", run_key: RUN_KEY, plan_id: PLAN_ID, plan_name: "FAQ 周回归",
    agent_name: "support-bot", status, score: status === "completed" ? 0.83 : null,
    started_at: "2026-08-26 02:40 UTC", finished_at: "2026-08-26 02:52 UTC",
    duration_s: 720, total_cost_usd: 1.02,
    stage_summaries: [
      { type: "observe", status: "completed", overall_mean: 0.83, sessions: 7, summary: {} },
    ],
    overview: { stage_lines: [] }, proposals: [], s3_key: "planruns/x.json",
    plan_synthesis: null, synthesis_sections: [], synthesis_error: null,
    stale: false, heartbeat_epoch: null, progress: null, checkpoint_s3_key: null,
    ...extra,
  };
}

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [PLAN] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: [DONE_ROW] }],
  estimate_plan_run: (p) => [{
    event: "plan_run_estimate", plan_id: p.plan_id,
    stages: [{ type: "observe", judge_calls: 20, estimated_cost_usd: 0.12 }],
    estimated_cost_usd: 0.42, note: "预估",
  }],
  get_plan_run: () => [settledDetail()],
  evaluators: () => [{
    event: "evaluators", available: ["helpfulness"], dataset_only: ["correctness"],
    multimodal: [], scopes: {}, custom: [], metrics: [], default: [], default_metrics: [],
  }],
  list_datasets: () => [{ event: "datasets", datasets: [] }],
  discover: () => [{ event: "agents", region: "us-west-2", from_cache: true, agents: [] }],
  stop_plan_run: (p) => [{
    event: "plan_run_stop_requested", run_key: p.run_key, status: "running",
    requested: true, already: false, stop_requested_at: "2026-08-26 02:45 UTC",
    message: "已请求停止，将在下一个检查点生效",
  }],
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
    if (!handler) return sseResponse([{ event: "error", error: `未打桩 '${payload.action}'` }]);
    return sseResponse(handler(payload));
  }));
}

/** 手控 run_plan 流（推帧 / 关流 / 报错），其余 action 照常打桩。 */
function installManualRunStream() {
  let pushFrame!: (ev: unknown) => void;
  let closeStream!: () => void;
  let failStream!: (err: Error) => void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      pushFrame = (ev) => controller.enqueue(enc.encode(sseFrames([ev])));
      closeStream = () => controller.close();
      failStream = (err) => controller.error(err);
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
  return {
    push: (ev: unknown) => pushFrame(ev),
    close: () => closeStream(),
    fail: (err: Error) => failStream(err),
  };
}

function renderDetail(id = PLAN_ID) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PlanDetailPage id={id} />
    </QueryClientProvider>,
  );
}

const clickRunAndConfirm = () => {
  fireEvent.click(screen.getByTestId("plan-run"));
  fireEvent.click(screen.getByTestId("confirm-card-ok"));
};

const countCalls = (action: string) => calls.filter((c) => c.action === action).length;

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==================== 交付 3 的两个纯函数（先钉文案与降级） ====================
describe("心跳/进度文案（纯函数）", () => {
  it("有心跳 → 「最后心跳 X 前」；缺字段/0/负值 → null（不显示、不伪造）", () => {
    const now = 1_800_000_000_000;
    expect(heartbeatAgeText(now / 1000 - 8, now)).toBe("最后心跳 8s 前");
    expect(heartbeatAgeText(now / 1000 - 185, now)).toBe("最后心跳 3m5s 前");
    // 老 run 三种「没有」都必须是 null —— 伪造 0 会印出「最后心跳 56 年前」
    expect(heartbeatAgeText(undefined, now)).toBeNull();
    expect(heartbeatAgeText(null, now)).toBeNull();
    expect(heartbeatAgeText(0, now)).toBeNull();
    // 读写两侧时钟偏差：不给负数
    expect(heartbeatAgeText(now / 1000 + 5, now)).toBe("最后心跳 0s 前");
  });

  it("进度 → 「已完成 X/N 环节 · 最近完成 <环节名>」；缺字段 → null", () => {
    expect(stageProgressText({
      stages_done: 1, stages_total: 2, stage: "observe", stage_summaries_partial: [],
    })).toBe("已完成 1/2 环节 · 最近完成 线上评估");
    // stage 是**刚结束**那个环节的类型（后端只在环节边界写进度）——文案说「最近
    // 完成」，绝不说成「正在跑」
    expect(stageProgressText({
      stages_done: 2, stages_total: 3, stage: "dataset", stage_summaries_partial: [],
    })).toBe("已完成 2/3 环节 · 最近完成 回归测试");
    expect(stageProgressText({ stages_done: 1, stages_total: 2, stage: null,
                               stage_summaries_partial: [] }))
      .toBe("已完成 1/2 环节");
    expect(stageProgressText(null)).toBeNull();
    expect(stageProgressText(undefined)).toBeNull();
    // 总数为 0 → 整段不画（绝不显示「0/0 环节」）
    expect(stageProgressText({ stages_done: 0, stages_total: 0, stage: null,
                               stage_summaries_partial: [] })).toBeNull();
  });
});

// ==================== 交付 4：stale 展示 ====================
describe("交付 4：陈旧 running 显示中性「疑似中断」", () => {
  it("展示态只加不改：既有 STATUS_LABEL/statusBadgeClass 一个字不动", () => {
    expect(STALE_RUNNING_BADGE.label).toBe("疑似中断");
    // 中性、**非错误红**：与 stopped/skipped/halted_cost 同刑（warn），不是 bad
    expect(STALE_RUNNING_BADGE.cls).toBe("badge warn");
    // 逐 class 判，不用子串（"badge" 本身含 "bad" 三个字母，子串判定恒真/恒假）
    expect(STALE_RUNNING_BADGE.cls.split(" ")).not.toContain("bad");
    // stale 不是后端 status —— 不许混进那两张五态映射表
    expect(STATUS_LABEL.running).toBe("运行中");
    expect(STATUS_LABEL).not.toHaveProperty("stale");
    expect(statusBadgeClass("running")).toBe("badge run");
    expect(statusBadgeClass("stale")).toBe("badge");
  });

  it("运行历史里陈旧那一行 badge = 疑似中断；未陈旧的行仍是运行中", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: [freshRunningRow(), STALE_RUNNING_ROW, DONE_ROW],
    }];
    renderDetail();
    // 锚点 = 陈旧那一行**自己**的 badge（目标数据专属）
    const stale = await screen.findByTestId(
      `plan-run-row-${STALE_RUNNING_ROW.run_key}-badge`);
    expect(stale).toHaveTextContent("疑似中断");
    expect(stale).toHaveClass("badge", "warn");
    expect(stale).not.toHaveClass("bad");
    expect(screen.getByTestId(`plan-run-row-${RUN_KEY}-badge`)).toHaveTextContent("运行中");
  });

  it("陈旧 running **不**恢复进行中面板（执行进程已判定停止，改判归 reaper）", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id, runs: [STALE_RUNNING_ROW, DONE_ROW],
    }];
    renderDetail();
    await screen.findByTestId(`plan-run-row-${STALE_RUNNING_ROW.run_key}-badge`);
    expect(screen.queryByTestId("plan-run-recovered")).not.toBeInTheDocument();
    // 也不许锁运行按钮：那条 run 已经不在跑了
    expect(screen.getByTestId("plan-run")).toBeEnabled();
    expect(runFlightOf(PLAN_ID).running).toBe(false);
  });
});

// ==================== 交付 2：刷新恢复 ====================
describe("交付 2：刷新/重进页面恢复「进行中」面板", () => {
  it("挂载时发现未陈旧的 running → 面板恢复 + 心跳与进度 + 停止入口", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id, runs: [freshRunningRow(), DONE_ROW],
    }];
    renderDetail();
    // 锚点 = 心跳那一格（目标数据专属：只有这一拉真带回 heartbeat_epoch 才成立）
    const beat = await screen.findByTestId("plan-run-recovered-heartbeat");
    expect(beat).toHaveTextContent(/最后心跳 \d+s 前/);
    expect(screen.getByTestId("plan-run-recovered-progress"))
      .toHaveTextContent("已完成 1/2 环节 · 最近完成 线上评估");
    expect(screen.getByTestId("plan-run-recovered-status")).toHaveTextContent("运行中");
    // 停止入口不依赖当次流式会话（换设备/刷新都能停一次在花钱的运行）
    expect(screen.getByTestId("plan-run-recovered-stop")).toBeEnabled();
    // 死胡同文案一个字都不许再出现
    expect(screen.getByTestId("plan-run-recovered"))
      .not.toHaveTextContent("最终状态以运行历史为准");
    // 「这次运行在后端继续执行；结束后运行历史自动刷新」对任何恢复面板恒成立 ⇒ 删
    // （prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("plan-run-recovered"), "后端继续执行", "自动刷新");
  });

  it("闸门认领：刷新后运行按钮仍锁着（关闭「刷新 = 闸门清零」的失明边界）", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id, runs: [freshRunningRow(), DONE_ROW],
    }];
    renderDetail();
    await screen.findByTestId("plan-run-recovered-heartbeat");
    await waitFor(() => expect(screen.getByTestId("plan-run")).toBeDisabled());
    expect(screen.getByTestId("plan-run")).toHaveTextContent("运行中…");
    // 跨页通道也认领上了（工作台 / Agent 详情那两颗「运行」跟着锁）
    expect(runFlightOf(PLAN_ID).running).toBe(true);
  });

  it("老 running（缺三件）：面板恢复但**不显示**心跳与进度，也不伪造 0", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id, runs: [LEGACY_RUNNING_ROW, DONE_ROW],
    }];
    renderDetail();
    const panel = await screen.findByTestId("plan-run-recovered");
    expect(screen.queryByTestId("plan-run-recovered-heartbeat")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plan-run-recovered-progress")).not.toBeInTheDocument();
    expect(panel).not.toHaveTextContent("最后心跳");
    expect(panel).not.toHaveTextContent("环节");
    expect(panel).not.toHaveTextContent("0/0");
    // 行上同样不画
    const row = screen.getByTestId(`plan-run-row-${LEGACY_RUNNING_ROW.run_key}`);
    expect(row).not.toHaveTextContent("最后心跳");
  });

  it("10s 轮询运行历史：终态浮现后面板自己消失、闸门放开、轮询停手", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let settled = false;
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: settled ? [settledDetail(), DONE_ROW] : [freshRunningRow(), DONE_ROW],
    }];
    renderDetail();
    await screen.findByTestId("plan-run-recovered-heartbeat");
    const before = countCalls("list_plan_runs");
    settled = true;
    await vi.advanceTimersByTimeAsync(11_000);
    await waitFor(() =>
      expect(screen.queryByTestId("plan-run-recovered")).not.toBeInTheDocument());
    expect(countCalls("list_plan_runs")).toBeGreaterThan(before);
    expect(runFlightOf(PLAN_ID).running).toBe(false);
    // 终态之后不再轮询（页面开一夜不许打上万次）
    const afterSettled = countCalls("list_plan_runs");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(countCalls("list_plan_runs")).toBe(afterSettled);
  });

  it("陈旧 running 不轮询（存量僵尸不许让页面每 10s 打一次）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id, runs: [STALE_RUNNING_ROW, DONE_ROW],
    }];
    renderDetail();
    await screen.findByTestId(`plan-run-row-${STALE_RUNNING_ROW.run_key}-badge`);
    const before = countCalls("list_plan_runs");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(countCalls("list_plan_runs")).toBe(before);
  });
});

// ==================== 交付 1：断流转轮询 ====================
describe("交付 1：断流 ≠ 失败，转 get_plan_run 轮询", () => {
  it("流断掉：进行中面板留在原地转轮询，不报「连接中断」、不给死胡同文案", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    overrides.get_plan_run = () => [runningDetail()];
    const stream = installManualRunStream();
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    // 首帧带 run_key（后端批 1 起：write-at-start 之后经 emit 通道发出）
    stream.push({
      event: "plan_run_started", plan_id: PLAN_ID, plan_name: "FAQ 周回归",
      agent: "support-bot", triggered_by: "manual", stages: ["observe", "dataset"],
      run_key: RUN_KEY, started_epoch: nowEpoch(),
    });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("运行开始"));
    stream.fail(new Error("network error"));
    // 锚点 = 转轮询那一格自己（断言同源）
    const line = await screen.findByTestId("plan-run-reattached");
    expect(line).toHaveTextContent("实时连接已断开");
    // 「每 10 秒查询一次运行状态」是轮询机制讲解，对任何断流恒成立 ⇒ 删
    // （prose-sweep 2026-09-03；此前钉的是「10 秒」**在**）
    expectProseGone(line, "秒查询一次运行状态");
    const status = screen.getByTestId("plan-run-progress-status");
    expect(status).toHaveTextContent("运行中");
    expect(status).not.toHaveTextContent("连接中断");
    expect(screen.getByTestId("plan-run-progress"))
      .not.toHaveTextContent("稍后刷新运行历史查看结果");
    expect(screen.queryByTestId("plan-run-progress-error")).not.toBeInTheDocument();

    // 10s 后第一次轮询：拿回心跳与进度（锚点是心跳那一格，不是面板容器）
    await vi.advanceTimersByTimeAsync(REATTACH_POLL_MS + 500);
    const beat = await screen.findByTestId("plan-run-live-heartbeat");
    expect(beat).toHaveTextContent(/最后心跳 \d+s 前/);
    expect(screen.getByTestId("plan-run-live-progress"))
      .toHaveTextContent("已完成 1/2 环节");
    expect(calls.filter((c) => c.action === "get_plan_run" && c.run_key === RUN_KEY).length)
      .toBeGreaterThan(0);
  });

  it("轮询到 completed 终态：即刻渲染报告（含线上评估均分）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    overrides.get_plan_run = () => {
      polls += 1;
      return [polls <= 1 ? runningDetail() : settledDetail()];
    };
    const stream = installManualRunStream();
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    stream.push({ event: "plan_run_started", plan_id: PLAN_ID, stages: ["observe"],
                  run_key: RUN_KEY });
    await screen.findByText(/运行开始/);
    stream.close();
    await screen.findByTestId("plan-run-reattached");
    await vi.advanceTimersByTimeAsync(REATTACH_POLL_MS * 2 + 1000);
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("运行完成"));
    expect(screen.getByTestId("plan-run-progress-status"))
      .toHaveTextContent("线上评估均分 0.83");
    expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("12:00");
  });

  it("轮询到非 completed 终态：不谎称「运行完成」，如实说后端状态", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    overrides.get_plan_run = () => [settledDetail("error", {
      error: "judge 限流：ThrottlingException",
    })];
    const stream = installManualRunStream();
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    stream.push({ event: "plan_run_started", plan_id: PLAN_ID, stages: ["observe"],
                  run_key: RUN_KEY });
    await screen.findByTestId("plan-run-progress-log");
    stream.close();
    await screen.findByTestId("plan-run-reattached");
    await vi.advanceTimersByTimeAsync(REATTACH_POLL_MS + 1000);
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("失败"));
    const status = screen.getByTestId("plan-run-progress-status");
    expect(status).not.toHaveTextContent("运行完成");
    // 失败的 run 不许给 run 级分数
    expect(status).not.toHaveTextContent("均分");
  });

  it("后端说 stale（心跳停了）：中性「疑似中断」并停手，不再轮询", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    overrides.get_plan_run = () => [runningDetail({ stale: true, heartbeat_epoch: null })];
    const stream = installManualRunStream();
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    stream.push({ event: "plan_run_started", plan_id: PLAN_ID, stages: ["observe"],
                  run_key: RUN_KEY });
    await screen.findByTestId("plan-run-progress-log");
    stream.close();
    await screen.findByTestId("plan-run-reattached");
    await vi.advanceTimersByTimeAsync(REATTACH_POLL_MS + 1000);
    const note = await screen.findByTestId("plan-run-suspected-stale");
    expect(note).toHaveTextContent("疑似中断");
    // 「已产生的费用与已完成环节的结果照常保留；这条记录会改判为终态，届时在下方运行
    // 历史里可见」对任何疑似中断恒成立 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(note, "照常保留", "改判为终态", "届时在下方运行历史");
    // 中性：不是错误卡（is-error 会把它画成红的）
    expect(screen.getByTestId("plan-run-progress")).not.toHaveClass("is-error");
    const after = countCalls("get_plan_run");
    await vi.advanceTimersByTimeAsync(REATTACH_POLL_MS * 3);
    expect(countCalls("get_plan_run")).toBe(after);
  });

  it("轮询不泄漏：组件卸载后一次都不再打 get_plan_run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    overrides.get_plan_run = () => [runningDetail()];
    const stream = installManualRunStream();
    const view = renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    stream.push({ event: "plan_run_started", plan_id: PLAN_ID, stages: ["observe"],
                  run_key: RUN_KEY });
    await screen.findByTestId("plan-run-progress-log");
    stream.close();
    await screen.findByTestId("plan-run-reattached");
    await vi.advanceTimersByTimeAsync(REATTACH_POLL_MS + 500);
    await waitFor(() => expect(countCalls("get_plan_run")).toBeGreaterThan(0));
    const atUnmount = countCalls("get_plan_run");
    view.unmount();
    await vi.advanceTimersByTimeAsync(REATTACH_POLL_MS * 4);
    expect(countCalls("get_plan_run")).toBe(atUnmount);
  });

  it("首帧之前就断（没有 run_key）：仍走既有断流兜底，绝不空轮询", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stream = installManualRunStream();
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    stream.fail(new Error("network error"));
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
    expect(screen.queryByTestId("plan-run-reattached")).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(REATTACH_POLL_MS * 2);
    expect(countCalls("get_plan_run")).toBe(0);
  });

  it("后端 error 事件仍是**真失败**：不转轮询（run 已经死了）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stream = installManualRunStream();
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    stream.push({ event: "plan_run_started", plan_id: PLAN_ID, stages: ["observe"],
                  run_key: RUN_KEY });
    await screen.findByTestId("plan-run-progress-log");
    stream.push({ event: "error", error: "方案不存在" });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-error")).toHaveTextContent("方案不存在"));
    expect(screen.queryByTestId("plan-run-reattached")).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(REATTACH_POLL_MS * 2);
    expect(countCalls("get_plan_run")).toBe(0);
  });

  it("查询连续失败到上限：收手并说清（不无限空转）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    overrides.get_plan_run = () => [{ event: "error", error: "run 'x' 不存在" }];
    const stream = installManualRunStream();
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    stream.push({ event: "plan_run_started", plan_id: PLAN_ID, stages: ["observe"],
                  run_key: RUN_KEY });
    await screen.findByTestId("plan-run-progress-log");
    stream.close();
    await screen.findByTestId("plan-run-reattached");
    await vi.advanceTimersByTimeAsync(REATTACH_POLL_MS * 4);
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-error")).toHaveTextContent("不存在"));
    const stopped = countCalls("get_plan_run");
    await vi.advanceTimersByTimeAsync(REATTACH_POLL_MS * 3);
    expect(countCalls("get_plan_run")).toBe(stopped);
  });
});
