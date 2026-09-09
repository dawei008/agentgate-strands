// 失败环节的原因不许被吞（生产实拍 2026-08-25）。
//
// 现场：plan-8c7b6ad3cd5d#20260824121230 的报告抽屉里，红队环节行只有
// 「红队测试 攻破 0/0」**一个注记都没有**，而下方警示条却写着
// 「红队测试环节执行失败。…失败原因见上方环节列表。」—— 指引指向一个空位。
//
// 根因：StageLine 的注记表达式只在 `status === "empty"` 那一支读
// `stage.error ?? stage.skip_reason`；`status === "error"` 走 dataset/evaluators
// 那一支，而后端失败环节的摘要里正好没有 dataset/evaluators
// （planrun.py:_stage_summary 只带 type/status/error + 该类型的数字），
// 于是注记算成空串，PutItem 超限那句原话整段消失。
//
// 契约来源（逐字对齐，防 mock 漂移）：
//   app/planrun.py:942-953 `_stage_summary` —— `error` 键**只在有 error 时存在**，
//   值是 `str(res["error"])[:300]`；失败环节没有 dataset/evaluators 可显示。
//   失败环节夹具不新造：直接钉 mocks/handlers.ts 里 UI-025 那条部分失败 run
//   （`plan-aaa111#2026-07-14T03:00:00Z`，error 文本取自线上实测）——mock 与
//   单测同一份，谁改了另一个立刻红。
//
// 本文件钉三件事：
//   1) error 环节行的注记 = 后端原话（不加「可能」类修饰，不换成通用文案）；
//   2) 这行挂 title —— 600px 抽屉单行省略号，长 ValidationException 必被截断，
//      看不全等于还是把原因吃掉（同 325392d 给 empty 环节做的处理）；
//   3) empty 那一支不回归（「最近 30 天没有可评估的会话」链路仍通），
//      且导出（exportReport）对失败环节同样带原因行 —— 屏幕与导出同刑。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// 旧报告页壳（渲染共享视图 ReportView，抽屉正文）：独立页已换成变体 A，见 tests/legacyReportPage.tsx
import ReportPage from "./legacyReportPage";
import { buildReportMarkdown } from "../src/pages/plan/exportReport";
import { sseFrames, PLAN_RUNS } from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import { runOutcome } from "../src/lib/scoring";
import type { StageSummary } from "../src/pages/plan/types";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

/** UI-025 那条部分失败 run 的红队环节，直接取自 mock（不新造夹具）：
 *  形态是 `{type, status:"error", error, breached, attacks, verdict}` ——
 *  只有 type/status/error + 红队数字，**没有** dataset/evaluators 可显示，
 *  正是注记走 dataset 那一支时会算成空串的原因。 */
const MOCK_FAIL_RUN = PLAN_RUNS.find((r) => r.run_key === "plan-aaa111#2026-07-14T03:00:00Z")!;
const REDTEAM_ERR = MOCK_FAIL_RUN.stage_summaries.find((s) => s.type === "redteam") as StageSummary;

/** 后端原话（单行必被省略号截断 → title 必须给全文） */
const PUTITEM_ERR = REDTEAM_ERR.error as string;

const OBSERVE_OK: StageSummary = {
  type: "observe", status: "completed", evaluators: ["helpfulness"],
  overall_mean: 0.86, sessions: 12,
};

const PLAN = {
  plan_id: "plan-8c7b6ad3cd5d",
  name: "红队巡检",
  agent_name: "support-bot",
  updated_at: 1755500000,
  stages: [
    { type: "observe", evaluators: ["helpfulness"] },
    { type: "redteam", cases_dataset: "redteam-v1", evaluators: [] },
  ],
  schedule: null,
};

const RUNS = [{
  run_key: "plan-8c7b6ad3cd5d#20260824121230",
  status: "completed", score: 0.86,
  started_at: "2026-08-24 12:12", duration_s: 812, triggered_by: "manual",
  stage_summaries: [OBSERVE_OK, REDTEAM_ERR],
}];

const RUN_DETAIL = {
  event: "plan_run",
  run_key: RUNS[0].run_key,
  plan_id: "plan-8c7b6ad3cd5d",
  plan_name: "红队巡检",
  agent_name: "support-bot",
  status: "completed",
  score: 0.86,
  started_at: "2026-08-24 12:12",
  duration_s: 812,
  triggered_by: "manual",
  total_cost_usd: 1.92,
  overview: { stage_lines: [], previous_run: null },
  stages: [OBSERVE_OK, REDTEAM_ERR],
  plan_synthesis: null,
  synthesis_sections: [],
  synthesis_error: null,
};

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [PLAN] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: RUNS }],
  get_plan_run: (p) => [{ ...RUN_DETAIL, run_key: p.run_key }],
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
    const handler = overrides[payload.action] ?? DEFAULTS[payload.action];
    if (!handler) return sseResponse([{ event: "error", error: `未打桩 action '${payload.action}'` }]);
    return sseResponse(handler(payload));
  }));
}

/** 报告的**生产入口是独立页** `#/report/<run_key>`（用户原话：抽屉「很多字但只有
 *  一半屏幕能看」），所以这一批断言直接挂那一页，不再走「方案页 → 点查看报告 →
 *  等抽屉」。少一跳，顺带把「run_key 自己就够定位一份报告」一起测了（页面只收
 *  run_key，plan_id 是它的前缀）。
 *  「运行历史那一行点了会去报告页」属于方案页的动线，由 tests/plan.test.tsx 钉；
 *  「抽屉壳还在」由 tests/report-table.test.tsx 钉。 */
async function openReport(runKey = RUNS[0].run_key) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ReportPage id={runKey} />
    </QueryClientProvider>,
  );
  await screen.findByTestId("report-drawer-head");
  await waitFor(() =>
    expect(screen.queryByTestId("report-drawer-loading")).not.toBeInTheDocument());
}

beforeEach(() => {
  overrides = {};
  resetConfigForTest();
  resetRunFlightForTest();
  location.hash = "#/plan/plan-8c7b6ad3cd5d";
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ADR-0014：环节的原话住址从「① 环节表的一行」换成**全量表的组头**
// （.rt-ghead 的 .gnote），判据仍是同一份 derive.stageKind/stageNote —— 变的是
// 落点，不是口径。
describe("失败环节：后端原话必须到得了环节组头", () => {
  it("夹具锚点：mock 那条失败环节确实只有 error、没有 dataset/evaluators", () => {
    // 缺陷成立的前提。哪天 mock 顺手补了 dataset 名，这条先红，下面几条的
    // 「原因被吞」就不再是同一个现场了。
    expect(PUTITEM_ERR).toContain("ValidationException");
    expect(REDTEAM_ERR.status).toBe("error");
    expect(REDTEAM_ERR.dataset).toBeUndefined();
    expect(REDTEAM_ERR.cases_dataset).toBeUndefined();
    expect(REDTEAM_ERR.evaluators).toBeUndefined();
  });

  it("error 环节组头的注记 = 后端原话（此前只有「攻破 0/0」，原因整段消失）", async () => {
    await openReport();
    const head = await screen.findByTestId("report-group-1-head");
    expect(head).toHaveClass("is-failed");
    expect(head).toHaveTextContent("执行失败");
    expect(head).toHaveTextContent("攻破 0/0");
    // 缺陷正身：这句必须在
    expect(head).toHaveTextContent(PUTITEM_ERR);
  });

  it("裁决句说「红队测试环节执行失败」时，组头真的有原因（不指向空位）", async () => {
    await openReport();
    expect(screen.getByTestId("report-verdict")).toHaveTextContent("红队测试环节执行失败");
    const gnote = (await screen.findByTestId("report-group-1-head")).querySelector(".gnote");
    expect(gnote).not.toBeNull();
    expect(gnote).toHaveTextContent(PUTITEM_ERR);
  });

  it("原因这行挂 title：单行省略号截断了还要能看全（同 empty 环节的处理）", async () => {
    await openReport();
    const gnote = (await screen.findByTestId("report-group-1-head")).querySelector(".gnote");
    expect(gnote).toHaveAttribute("title", PUTITEM_ERR);
  });

  it("有 dataset 名的失败环节：原因优先于数据集名（原因才是这行的信息量）", async () => {
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key, status: "error", score: null,
      stages: [{
        type: "dataset", status: "error", dataset: "faq-v3",
        evaluators: ["correctness"], error: "Agent 调用超时",
      }],
    }];
    await openReport();
    const head = await screen.findByTestId("report-group-0-head");
    expect(head).toHaveTextContent("Agent 调用超时");
    expect(head.querySelector(".gnote")).toHaveAttribute("title", "Agent 调用超时");
  });

  it("status=completed 但带了 error 文本：同样算失败，原因照样显示", async () => {
    // 注记的判据必须与红点那一处（`status==="error" || Boolean(stage.error)`）
    // 是同一个，否则这一路照样吞 —— 后端把 run 级失败/熔断说明上浮到环节时
    // （planrun.py:303-307），status 未必是 "error"。lib/scoring.ts
    // isStageFailed 两条都兜，这里也必须两条都兜。
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key,
      stages: [{
        type: "dataset", status: "completed", dataset: "faq-v3", cases: 4,
        error: "成本超过单次预算上限 $2.00，已熔断",
      }],
    }];
    await openReport();
    const head = await screen.findByTestId("report-group-0-head");
    expect(head).toHaveClass("is-failed");
    expect(head).toHaveTextContent("成本超过单次预算上限 $2.00，已熔断");
    expect(head.querySelector(".gnote"))
      .toHaveAttribute("title", "成本超过单次预算上限 $2.00，已熔断");
  });

  it("halted_cost 环节（带熔断留痕）：原因也在这行上", async () => {
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key,
      stages: [{
        type: "dataset", status: "halted_cost", dataset: "faq-v3", cases: 4,
        error: "成本超过单次预算上限 $2.00，已熔断",
      }],
    }];
    await openReport();
    expect(await screen.findByTestId("report-group-0-head"))
      .toHaveTextContent("成本超过单次预算上限 $2.00，已熔断");
  });
});

describe("不回归：empty 与正常环节的注记各走各的路", () => {
  it("empty 环节仍是「无数据」+ 后端原话（325392d 那条链路）", async () => {
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key, score: null,
      stages: [{
        type: "observe", status: "empty", sessions: 0, overall_mean: null,
        error: "最近 30 天没有可评估的会话",
      }],
    }];
    await openReport();
    const head = await screen.findByTestId("report-group-0-head");
    expect(head).toHaveClass("is-empty");
    expect(head).toHaveTextContent("无数据");
    expect(head).toHaveTextContent("最近 30 天没有可评估的会话");
    expect(head.querySelector(".gnote"))
      .toHaveAttribute("title", "最近 30 天没有可评估的会话");
  });

  it("empty 且后端没给原因：注记留空，不拿 dataset 名冒充「为什么没有数据」", async () => {
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key, score: null,
      stages: [{
        type: "dataset", status: "empty", dataset: "safety-regression-v1",
        cases: 0, evaluators: ["correctness"],
      }],
    }];
    await openReport();
    const head = await screen.findByTestId("report-group-0-head");
    expect(head).toHaveTextContent("无数据");
    expect(head.querySelector(".gnote")).toBeNull();
  });

  it("正常环节注记仍是「数据集 · 评估器」，不被原因逻辑波及", async () => {
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key, score: null,
      stages: [{
        type: "dataset", status: "completed", dataset: "safety-regression-v1",
        pass_rate: 1, cases: 4, evaluators: ["correctness", "refusal"],
      }],
    }];
    await openReport();
    const gnote = (await screen.findByTestId("report-group-0-head")).querySelector(".gnote");
    expect(gnote).toHaveTextContent("safety-regression-v1 · correctness · refusal");
  });
});

// exportReport 同族排查（S5 记过它与抽屉逐行复写 `stage.error ?? stage.skip_reason`）：
// 导出侧的 stageLine 本来就有独立的 failed 分支写原因 —— 没有吞。这两条钉住它，
// 别在后续收敛 stageNote 时把导出侧的原因一起收掉。
describe("导出同刑：失败环节的原因也在 Markdown 里", () => {
  const base = {
    runKey: RUNS[0].run_key, seq: 1, planId: "plan-8c7b6ad3cd5d",
    detail: RUN_DETAIL, status: "completed", score: 0.86,
    cost: 1.92, startedAt: "2026-08-24 12:12", durationS: 812,
    triggeredBy: "manual", sections: [], now: new Date("2026-08-25T01:00:00Z"),
  };

  it("失败环节写「执行失败（原话）」，正常环节照常写数字", () => {
    const stages = [OBSERVE_OK, REDTEAM_ERR];
    const md = buildReportMarkdown({
      ...base, stages,
      outcome: runOutcome({ status: "completed", score: 0.86, stage_summaries: stages }),
    });
    expect(md).toContain(`- **红队测试**：执行失败（${PUTITEM_ERR}）`);
    expect(md).toContain("- **线上评估**：12 会话 · 本环节均分 0.86");
  });

  it("empty 环节写「无数据（原话）」，与抽屉那一行同口径", () => {
    const stages: StageSummary[] = [{
      type: "observe", status: "empty", sessions: 0, overall_mean: null,
      error: "最近 30 天没有可评估的会话",
    }];
    const md = buildReportMarkdown({
      ...base, score: null, stages,
      outcome: runOutcome({ status: "completed", score: null, stage_summaries: stages }),
    });
    expect(md).toContain("- **线上评估**：无数据（最近 30 天没有可评估的会话）");
  });
});
