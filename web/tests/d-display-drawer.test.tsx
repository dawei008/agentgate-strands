// D-5 止血版（选项 2）的页面面：**有方案定义在手**的报告抽屉把
// dataset + 模拟侧集合的环节叫「模拟测试」；列表页保持「回归测试」口径。
//
// 用户现场：用模拟集配好的环节，在结果侧全被叫成「回归测试」——「模拟测试」
// 这个产品概念在结果侧完全消失，历史里分不出跑的是固定集还是多轮扮演。
//
// ⚠️ 止血版的已知代价（写在这里免得下一个人以为是漏改）：导出 Markdown
// （exportReport.ts，本批白名单外）仍按存储三类写「回归测试」，所以模拟侧
// 环节在**屏幕**与**导出**里会显示不同名字。收敛归 D-5 选项 1 / D-6
// （stageLabel(type, datasetKind) 收进 lib + 后端补 dataset kind 字段）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PlanDetailPage from "../src/pages/plan/PlanDetailPage";
// 旧报告页壳（渲染共享视图 ReportView，抽屉正文）：独立页已换成变体 A，见 tests/legacyReportPage.tsx
import ReportPage from "./legacyReportPage";
import { sseFrames } from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

const RUN_KEY = "plan-sim01#20260825020000";

/** 模拟侧方案：环节仍是存储三类的 dataset（ADR-0001），靠 dataset 指向的集合归类 */
const PLAN = {
  plan_id: "plan-sim01", name: "改签多轮巡检", agent_name: "support-bot",
  updated_at: 1787000000,
  stages: [{ type: "dataset", dataset: "sim-rebooking", evaluators: ["correctness"] }],
  schedule: null,
};

const DDB_STAGE = {
  type: "dataset", status: "completed", pass_rate: 0.9, cases: 2, blank_cases: 0,
  evaluators: ["correctness"],
  evaluator_stats: { correctness: { mean: 0.94, passed: 2, judged: 2 } },
};

const RUNS = [{
  run_key: RUN_KEY, status: "completed", score: null,
  started_at: "2026-08-25 02:00 UTC", duration_s: 186, triggered_by: "manual",
  stage_summaries: [DDB_STAGE],
}];

/** get_plan_run 真形态：DDB 摘要 + S3 报告体（analysis/results 只在后者） */
const DETAIL = {
  event: "plan_run", run_key: RUN_KEY, plan_id: "plan-sim01",
  plan_name: "改签多轮巡检", agent_name: "support-bot",
  status: "completed", score: null,
  started_at: "2026-08-25 02:00 UTC", duration_s: 186, triggered_by: "manual",
  stage_summaries: [DDB_STAGE],
  report: {
    stages: [{
      type: "dataset", status: "completed",
      report: {
        dataset: "sim-rebooking", analysis: "## 结论\n多轮任务完成度尚可。",
        results: [{
          case: "改签一次", agent: "support-bot", input: "帮我改签", output: "已改签。",
          results: { correctness: { score: 1, passed: true, errored: false, reason: "一致。" } },
        }],
      },
    }],
  },
  plan_synthesis: null, synthesis_sections: [], synthesis_error: null,
};

const DATASETS = [
  { name: "sim-rebooking", kind: "simulation", target_agent: "", case_count: 2 },
  { name: "faq-v3", kind: "regression", target_agent: "", case_count: 3 },
];

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [PLAN] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: RUNS }],
  list_datasets: () => [{ event: "datasets", datasets: DATASETS }],
  get_plan_run: () => [DETAIL],
  estimate_plan_run: (p) => [{
    event: "plan_run_estimate", plan_id: p.plan_id, stages: [],
    estimated_cost_usd: 0.2, note: "预估",
  }],
};

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    const handler = overrides[payload.action] ?? DEFAULTS[payload.action];
    if (!handler) return sseResponse([{ event: "error", error: `未打桩 action '${payload.action}'` }]);
    return sseResponse(handler(payload));
  }));
}

function renderDetail() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PlanDetailPage id="plan-sim01" />
    </QueryClientProvider>,
  );
}

/** 报告的生产入口是独立页 `#/report/<run_key>`，所以这一批 D-5 断言直接挂那一页。
 *  ⚠️ 这里**必须**是页面而不是直接挂 ReportView：侧别判定要 `plan.stages`，而页面
 *  是靠「run_key 的前缀就是 plan_id」自己去拉方案的 —— 换句话说，环节到底叫
 *  「模拟测试」还是「回归测试」这条链，前半截就在页面壳里。绕过它去喂 plan，
 *  测到的是我手动传对了，不是产品接对了。 */
async function openReport() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ReportPage id={RUN_KEY} />
    </QueryClientProvider>,
  );
  // ADR-0014：环节名的落点是全量表的**组头**（旧「① 环节表」已下线）
  return screen.findByTestId("report-group-0-head");
}

beforeEach(() => {
  overrides = {};
  resetConfigForTest();
  resetRunFlightForTest();
  location.hash = "#/plan/plan-sim01";
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("D-5 报告：模拟侧环节叫「模拟测试」", () => {
  it("全量表的组头用「模拟测试」，不再叫「回归测试」", async () => {
    const head = await openReport();
    // 锚点挑本环节专属：先等这一组的真实指标（通过率 90%）到齐再断言文案
    await waitFor(() => expect(head).toHaveTextContent("通过率 90%"));
    expect(head).toHaveTextContent("模拟测试");
    expect(head).not.toHaveTextContent("回归测试");
    // 存储层没变：环节还是 dataset，用例行照旧挂在这一组里（评估器小格带名）
    expect(screen.getByTestId("report-verdict-0-0-correctness")).toHaveTextContent("correctness");
  });

  it("固定侧集合仍是「回归测试」（同一份代码，两种集合两种名字）", async () => {
    overrides.list_plans = () => [{
      event: "plans",
      plans: [{ ...PLAN, stages: [{ type: "dataset", dataset: "faq-v3", evaluators: ["correctness"] }] }],
    }];
    overrides.get_plan_run = () => [{
      ...DETAIL,
      report: {
        stages: [{
          ...DETAIL.report.stages[0],
          report: { ...DETAIL.report.stages[0].report, dataset: "faq-v3" },
        }],
      },
    }];
    const line = await openReport();
    await waitFor(() => expect(line).toHaveTextContent("通过率 90%"));
    expect(line).toHaveTextContent("回归测试");
    expect(line).not.toHaveTextContent("模拟测试");
  });

  it("数据集名单拉不到时退回「回归测试」（不猜；也不因此炸掉抽屉）", async () => {
    overrides.list_datasets = () => [{ event: "error", error: "AccessDenied" }];
    const line = await openReport();
    await waitFor(() => expect(line).toHaveTextContent("通过率 90%"));
    expect(line).toHaveTextContent("回归测试");
    expect(line).not.toHaveTextContent("模拟测试");
  });

  it("列表页保持列表口径（选项 2 的边界）：运行历史那一行不出现「模拟测试」", async () => {
    renderDetail();
    const row = await screen.findByTestId(`plan-run-row-${RUN_KEY}`);
    // 量词钉：先确认这一行真渲染出了结果（badge + 指标 chip）
    expect(within(row).getByTestId(`plan-run-row-${RUN_KEY}-badge`)).toHaveTextContent("完成");
    expect(row).toHaveTextContent("通过率 90%");
    expect(row).not.toHaveTextContent("模拟测试");
  });
});
