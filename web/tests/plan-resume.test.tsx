// UI-029 批 4：「从检查点重试」入口 + 带重计费上界的确认卡。
//
// 现场（SPEC §4）：残余死亡路径（8h maxLifetime / microVM 崩溃 / 发版换容器 /
// 平台按 idle 回收）下执行进程没机会收尾 —— reaper 把那条 running 改判成 error
// （改判走 update 只补字段，所以 checkpoint_s3_key 留在库里）。此前用户唯一的出路
// 是整条方案重跑：已经付过钱的环节再付一次。
//
// 本文件钉住三件：
//   ① **入口可见性四态**（判据只有后端字段，前端零推断）：
//      error + 有检查点 = 可见 / stopped + 有 = 可见 / completed = 不可见 /
//      老 run（缺 checkpoint_s3_key）= 不可见（旧数据不修的展示侧降级）。
//   ② **确认卡必须写明重计费上界**：用户点之前必须知道要再花多少钱 ——
//      「将从第 N 个环节继续，预计新增花费不超过 $X」，其中被重跑那一个环节的
//      预估另说一句（此前那一截的钱不退回）。算不出就说算不出，**绝不显示 $0.00**。
//   ③ 确认后发的是 `resume_plan_run`（只带 run_key），并进入与首跑同一张进度卡
//      （续跑仍是同一次运行、状态仍是 running —— 后端不新增状态，前端不新增面板）。
//
// waitFor 锚点纪律（本仓 11 例偶发红的同族根因）：锚点必须是**断言同源**的目标
// 数据专属 testid —— 表格容器在第一批数据到达就出现，而入口/确认卡是那一行自己的事。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { expectProseGone } from "./prose";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PlanDetailPage from "../src/pages/plan/PlanDetailPage";
import {
  checkpointStagesDone, isResumable, resumeCeiling,
} from "../src/pages/plan/resume";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import { sseFrames } from "../src/mocks/handlers";
import type { Plan } from "../src/pages/plan/types";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
const PLAN_ID = "plan-aaa111";
/** 死掉那次运行（reaper 已改判 error，检查点指针还在）。 */
const DEAD_KEY = "plan-aaa111#2026-08-26T00:05:00Z";
const CKPT = `checkpoints/${PLAN_ID}/2026-08-26T00:05:00Z/stage-1.json`;

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

/**
 * 被 reaper 改判的那一行 —— **形态出处是后端 `_reap_write`**（update 只补终态与
 * 原因）：status=error + 可读原因 + 结束时刻与耗时，而 stage_summaries 仍是
 * 开跑 marker 那个空数组、progress/checkpoint_s3_key/heartbeat_epoch 原样留着。
 * 走整条 put_item 的两条终态路径（_persist / _converge_interrupted）覆盖即清场，
 * 产不出「终态 + 检查点」这个组合 —— 所以入口只可能挂在这一族记录上。
 */
function reapedRow(extra: Record<string, unknown> = {}) {
  return {
    run_key: DEAD_KEY, status: "error", score: null,
    started_at: "2026-08-26 00:05 UTC", finished_at: "2026-08-26 00:46 UTC",
    duration_s: 2460, triggered_by: "manual", stage_summaries: [],
    error: "运行未正常结束（心跳超时判定：执行进程未收敛，疑似被平台回收或超时，"
      + "未产出完整报告；已完成环节的结果与费用照常保留）",
    stale: false,
    heartbeat_epoch: 1787000300,
    progress: {
      stages_done: 1, stages_total: 2, stage: "observe",
      stage_summaries_partial: [
        { type: "observe", status: "completed", overall_mean: 0.84, sessions: 7, summary: {} },
      ],
    },
    checkpoint_s3_key: CKPT,
    ...extra,
  };
}

/** 老 run（检查点机制上线前失败的那批）：三个中途字段一个都没有。 */
const LEGACY_ERROR_ROW = {
  run_key: "plan-aaa111#2026-08-02T03:00:00Z", status: "error", score: null,
  started_at: "2026-08-02 03:00 UTC", duration_s: 12, triggered_by: "schedule",
  stage_summaries: [{ type: "observe", status: "error", error: "judge 限流：ThrottlingException" }],
  stale: false,
};

const DONE_ROW = {
  run_key: "plan-aaa111#2026-08-11T09:00:00Z",
  status: "completed", score: 0.86, started_at: "2026-08-11 09:00 UTC",
  duration_s: 74, triggered_by: "manual",
  stage_summaries: [
    { type: "observe", status: "completed", overall_mean: 0.86, sessions: 12, summary: {} },
  ],
  stale: false,
};

/** estimate_plan_run 的真形态：stages 逐项带 estimated_cost_usd（后端
 *  planrun.estimate_plan_run 的 stages_out），顺序与方案环节一一对位。 */
const ESTIMATE_STAGES = [
  { type: "observe", judge_calls: 20, estimated_cost_usd: 0.12 },
  { type: "dataset", cases: 14, agent_invocations: 14, estimated_cost_usd: 0.3 },
];

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [PLAN] }],
  list_plan_runs: (p) => [{
    event: "plan_runs", plan_id: p.plan_id, runs: [reapedRow(), DONE_ROW],
  }],
  estimate_plan_run: (p) => [{
    event: "plan_run_estimate", plan_id: p.plan_id,
    stages: ESTIMATE_STAGES, estimated_cost_usd: 0.42, note: "预估",
  }],
  get_plan_run: () => [{
    event: "plan_run", run_key: DEAD_KEY, plan_id: PLAN_ID, status: "error",
    score: null, stage_summaries: [], overview: {}, proposals: [], s3_key: null,
    plan_synthesis: null, synthesis_error: null, synthesis_sections: [],
  }],
  evaluators: () => [{
    event: "evaluators", available: ["helpfulness"], dataset_only: ["correctness"],
    multimodal: [], scopes: {}, custom: [], metrics: [], default: [], default_metrics: [],
  }],
  list_datasets: () => [{ event: "datasets", datasets: [] }],
  discover: () => [{ event: "agents", region: "us-west-2", from_cache: true, agents: [] }],
  // 续跑流：首帧照后端 execute_plan_run 的 started_event（同名同形、多带
  // run_key/started_epoch，续跑时再多一个 resume 段）
  resume_plan_run: (p) => [{
    event: "plan_run_started", plan_id: PLAN_ID, plan_name: PLAN.name,
    agent: "support-bot", stages: ["observe", "dataset"], triggered_by: "manual",
    run_key: p.run_key, started_epoch: 1787040000,
    resume: {
      attempt: 2, resumed_from: CKPT, stages_done: 1,
      from_stage: 2, stages_total: 2, added_max_usd: 0.3, rebill_max_usd: 0.3,
    },
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

function renderDetail(id = PLAN_ID) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PlanDetailPage id={id} />
    </QueryClientProvider>,
  );
}

const resumeBtn = (key = DEAD_KEY) => `plan-run-row-${key}-resume`;
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

// ==================== 纯函数：检查点 → 第几环节 + 计费上界 ====================
describe("续跑判据与计费上界（纯函数）", () => {
  it("检查点 key 的 stage-<i> 就是已完成环节数（形态出处 = 写侧的路径）", () => {
    expect(checkpointStagesDone(CKPT)).toBe(1);
    expect(checkpointStagesDone("checkpoints/p/2026/stage-3.json")).toBe(3);
    // 认不出来的一律 null（绝不猜）：调用方按「一个环节都没完成」保守处理
    expect(checkpointStagesDone("reports/p/2026.json")).toBeNull();
    expect(checkpointStagesDone("")).toBeNull();
    expect(checkpointStagesDone(null)).toBeNull();
    expect(checkpointStagesDone(undefined)).toBeNull();
  });

  it("可续跑 = 终态 error/stopped ∧ 有检查点（四态齐，判据只看后端字段）", () => {
    expect(isResumable({ status: "error", checkpoint_s3_key: CKPT })).toBe(true);
    expect(isResumable({ status: "stopped", checkpoint_s3_key: CKPT })).toBe(true);
    expect(isResumable({ status: "failed", checkpoint_s3_key: CKPT })).toBe(true);
    // completed 不给：那只会白花一次钱（后端也照实拒绝）
    expect(isResumable({ status: "completed", checkpoint_s3_key: CKPT })).toBe(false);
    // 老 run 没有这个字段 → 不给（旧数据不修：不猜、不回填）
    expect(isResumable({ status: "error" })).toBe(false);
    expect(isResumable({ status: "error", checkpoint_s3_key: null })).toBe(false);
    // 还在跑的不给（幂等闸门：不许并发烧两份钱）
    expect(isResumable({ status: "running", checkpoint_s3_key: CKPT })).toBe(false);
    expect(isResumable({ status: "skipped", checkpoint_s3_key: CKPT })).toBe(false);
  });

  it("上界口径与后端 planrun.resume_cost_ceiling 同一句话", () => {
    const three = [{ estimated_cost_usd: 0.12 }, { estimated_cost_usd: 0.3 },
                   { estimated_cost_usd: 1.85 }];
    const got = resumeCeiling(CKPT, 3, three);
    expect(got.fromStage).toBe(2);
    expect(got.stagesTotal).toBe(3);
    expect(got.addedMaxUsd).toBe(2.15);   // 剩余环节合计 0.3 + 1.85
    expect(got.rebillMaxUsd).toBe(0.3);   // 被重跑的只有第 2 环
  });

  it("认不出检查点 → 保守当「从第 1 环节起」，上界给全量（绝不少报）", () => {
    const got = resumeCeiling("reports/p/x.json", 2, ESTIMATE_STAGES);
    expect(got.fromStage).toBe(1);
    expect(got.addedMaxUsd).toBe(0.42);
    expect(got.rebillMaxUsd).toBe(0.12);
  });

  it("预估缺失/条数对不上/**剩余**环节没数字 → null，不是 0（$0.00 = 「不要钱」）", () => {
    for (const stages of [undefined, [], [{ estimated_cost_usd: 0.1 }],
                          [{ estimated_cost_usd: 0.1 }, { error: "数据集不存在" }]]) {
      const got = resumeCeiling(CKPT, 2, stages);
      expect(got.addedMaxUsd, JSON.stringify(stages)).toBeNull();
      expect(got.rebillMaxUsd, JSON.stringify(stages)).toBeNull();
      expect(got.fromStage).toBe(2);
    }
  });

  it("只看**剩余**那一段：已沿用环节缺预估不影响上界（与后端切片口径一致）", () => {
    // 上界回答的是「接下来还要花多少」——第 1 环的预估缺不缺与这个问题无关
    const got = resumeCeiling(CKPT, 2, [{ type: "observe" }, { estimated_cost_usd: 0.3 }]);
    expect(got.addedMaxUsd).toBe(0.3);
    expect(got.rebillMaxUsd).toBe(0.3);
  });
});

// ==================== 交付 5：入口可见性四态 ====================
describe("交付 5：「从检查点重试」入口的可见性", () => {
  it("error + 有检查点 → 入口可见（reaper 改判的那一族）", async () => {
    renderDetail();
    const btn = await screen.findByTestId(resumeBtn());
    expect(btn).toHaveTextContent("从检查点重试");
    expect(btn).toBeEnabled();
  });

  it("stopped + 有检查点 → 入口可见（用户停掉的运行也能接着跑）", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: [reapedRow({ status: "stopped", error: "已按用户请求停止：第 2/2 个环节开始前中止" }),
             DONE_ROW],
    }];
    renderDetail();
    expect(await screen.findByTestId(resumeBtn())).toBeEnabled();
  });

  it("completed → 不给入口（跑完了再续只会白花一次钱）", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: [reapedRow({ status: "completed", score: 0.83 }), DONE_ROW],
    }];
    renderDetail();
    // 锚点 = 那一行自己的 badge（目标数据专属；不拿表格容器当锚点）
    await screen.findByTestId(`plan-run-row-${DEAD_KEY}-badge`);
    expect(screen.queryByTestId(resumeBtn())).not.toBeInTheDocument();
  });

  it("老 run（缺 checkpoint_s3_key）→ 不给入口，也不伪造一个能点的按钮", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id, runs: [LEGACY_ERROR_ROW, DONE_ROW],
    }];
    renderDetail();
    const row = await screen.findByTestId(`plan-run-row-${LEGACY_ERROR_ROW.run_key}`);
    expect(row).toHaveTextContent("失败");
    expect(screen.queryByTestId(resumeBtn(LEGACY_ERROR_ROW.run_key)))
      .not.toBeInTheDocument();
  });

  it("running 那一行给的是「停止」，不是「从检查点重试」", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: [reapedRow({ status: "running", finished_at: "", duration_s: null }), DONE_ROW],
    }];
    renderDetail();
    expect(await screen.findByTestId(`plan-run-row-${DEAD_KEY}-stop`)).toBeInTheDocument();
    expect(screen.queryByTestId(resumeBtn())).not.toBeInTheDocument();
  });

  it("这条方案已有一次运行在飞 → 入口置灰并说清理由（不许再花一份钱）", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: [reapedRow(),
             { ...DONE_ROW, run_key: "plan-aaa111#2026-08-26T03:00:00Z",
               status: "running", score: null, duration_s: null,
               heartbeat_epoch: Math.floor(Date.now() / 1000) - 8 }],
    }];
    renderDetail();
    const btn = await screen.findByTestId(resumeBtn());
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveAttribute("title", expect.stringContaining("正在进行"));
    // 「先等它结束（或停止它）再从检查点续跑」是操作说明 ⇒ 从 title 删；可续跑时的通用
    // title「从最近一个环节检查点继续：…不重跑、不重新计费」同理（prose-sweep 2026-09-03）
    expectProseGone(btn, "先等它结束", "再从检查点续跑");
  });
});

// ==================== 交付 6：确认卡写明重计费上界 ====================
describe("交付 6：确认卡必须说清要再花多少钱", () => {
  async function openCard() {
    renderDetail();
    fireEvent.click(await screen.findByTestId(resumeBtn()));
    return screen.findByTestId("confirm-card");
  }

  it("卡上写明从第几环节继续 + 新增花费上界 + 重计费那一段不退回", async () => {
    const card = await openCard();
    expect(card).toHaveTextContent("从检查点重试");
    const cost = await screen.findByTestId("plan-resume-confirm-cost");
    expect(cost).toHaveTextContent("将从第 2 个环节继续");
    expect(cost).toHaveTextContent("预计新增花费不超过 $0.30");
    // 被重跑的那一个环节（重计费上界）与「不退回」必须同时说清
    expect(card).toHaveTextContent("$0.30");
    expect(card).toHaveTextContent("不退回");
    // 沿用的那一段也要说清（用户才知道自己不是重跑整条方案）
    expect(card).toHaveTextContent("前 1 个环节");
    expect(card).toHaveTextContent(/不重跑|直接沿用/);
    // 目标 run 的身份摆在卡上（点错行的最后一道防线）
    expect(within(card).getByTestId("plan-resume-confirm-key")).toHaveTextContent(DEAD_KEY);
    // 「续跑仍算同一次运行：运行历史不会多出一行…（后端同一个运行标识、第 N 次尝试）」
    // 对任何续跑恒成立 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(card, "续跑仍算", "不会多出一行", "第 N 次尝试");
  });

  it("危险动作纪律（UI-004）：默认焦点落「取消」，且没点确认前不发任何请求", async () => {
    await openCard();
    expect(screen.getByTestId("confirm-card-cancel")).toHaveFocus();
    expect(countCalls("resume_plan_run")).toBe(0);
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument());
    expect(countCalls("resume_plan_run")).toBe(0);
  });

  it("预估拿不到：如实说预估失败，**绝不**显示 $0.00", async () => {
    overrides.estimate_plan_run = () => [{
      event: "error", error: "unknown agent or no logs: support-bot",
    }];
    const card = await openCard();
    // 锚点 = 那一格自己的文案（预估失败是**后一拍**才到的事实，容器早就在了）
    await waitFor(() => expect(screen.getByTestId("plan-resume-confirm-cost"))
      .toHaveTextContent(/预估失败|预估不可用/));
    expect(card).not.toHaveTextContent("$0.00");
    // 数字给不出也仍要说清从第几环节继续（那一半信息是确定的）
    expect(screen.getByTestId("plan-resume-confirm-cost")).toHaveTextContent("第 2 个环节");
  });

  it("确认 → 发 resume_plan_run（只带 run_key），并进入与首跑同一张进度卡", async () => {
    await openCard();
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await waitFor(() => expect(countCalls("resume_plan_run")).toBe(1));
    const sent = calls.find((c) => c.action === "resume_plan_run")!;
    expect(sent.run_key).toBe(DEAD_KEY);
    // 不新增状态、不新增面板：走首跑那张进度卡（后端续跑期间状态就是 running）
    const log = await screen.findByTestId("plan-run-progress-log");
    expect(log).toHaveTextContent("从第 2 个环节继续");
    expect(log).toHaveTextContent(/沿用 1 个环节|已沿用 1 个/);
    expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("运行中");
  });

  it("后端拒绝（检查点读不出来）→ 照实透出真因，不谎称已开始", async () => {
    overrides.resume_plan_run = () => [{
      event: "error",
      error: `检查点读取失败（对象缺失或内容损坏）：${CKPT}；无法续跑，请重新发起一次运行`,
    }];
    await openCard();
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    const err = await screen.findByTestId("plan-run-progress-error");
    expect(err).toHaveTextContent("检查点读取失败");
    expect(screen.getByTestId("plan-run-progress-status")).not.toHaveTextContent("运行完成");
  });
});
