// 逐评估器指标（报告侧）：回归环节的摘要现在带 evaluators + evaluator_stats，
// 界面必须把「谁在拖分」显示出来 —— 用户原话：
//   「这里测试只显示回归测试分数，实际上评估器有很多指标都需要显示啊」
// 现场：纯回归方案 run #2 的四个评估器 harmfulness 1.00 / correctness 1.00 /
// instruction_following 0.90 / refusal 0.50，通过率 50% —— 界面只有「通过率 50%」
// 一个数，看不出是 refusal 拖的。
//
// 契约来源（逐字对齐，防 mock 漂移）：
//   app/planrun.py:910-939 `_evaluator_stats` + :960-975 `_stage_summary` dataset 分支
//   tests/test_evaluator_stats_field.py（后端把形态钉在这里）
// 三条硬语义在本文件各有专属用例：
//   1) 全被限流的评估器**留名**（judged=0 / mean=null）——从列表消失会被读成
//      「它评过且没问题」；
//   2) mean=null 显示中性文案，**绝不**显示 0 或空白（0 是「评了且很差」）；
//   3) 老 run 没有这两个字段 → 优雅降级为「不画」，绝不 NaN/undefined。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PlanDetailPage from "../src/pages/plan/PlanDetailPage";
// 旧报告页壳（渲染共享视图 ReportView，抽屉正文）：独立页已换成变体 A，见 tests/legacyReportPage.tsx
import ReportPage from "./legacyReportPage";
import { evaluatorRows } from "../src/pages/plan/derive";
import { sseFrames } from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import type { StageSummary } from "../src/pages/plan/types";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

/** 用户现场那四个评估器（形态逐字照 tests/test_evaluator_stats_field.py:80-83：
    {mean, passed, judged}，mean 已 round 4）。 */
const EV_STATS = {
  harmfulness: { mean: 1.0, passed: 2, judged: 2 },
  correctness: { mean: 1.0, passed: 2, judged: 2 },
  instruction_following: { mean: 0.9, passed: 2, judged: 2 },
  refusal: { mean: 0.5, passed: 1, judged: 2 },
};

const DATASET_STAGE: StageSummary = {
  type: "dataset", status: "completed", pass_rate: 0.5, cases: 2, blank_cases: 0,
  dataset: "safety-regression-v1",
  evaluators: ["harmfulness", "correctness", "instruction_following", "refusal"],
  evaluator_stats: EV_STATS,
};

const PLAN = {
  plan_id: "plan-reg01",
  name: "安全回归巡检",
  agent_name: "support-bot",
  updated_at: 1755500000,
  // 纯回归方案（无线上评估环节）：用户的真实场景
  stages: [{
    type: "dataset", dataset: "safety-regression-v1",
    evaluators: ["harmfulness", "correctness", "instruction_following", "refusal"],
  }],
  schedule: null,
};

/** 纯回归 run：**顶层 score 必为 null**（后端只在有 observe overall_mean 时写） */
const REG_RUNS = [
  {
    run_key: "rk-2", status: "completed", score: null,
    started_at: "2026-08-24 16:51", duration_s: 103, triggered_by: "manual",
    stage_summaries: [DATASET_STAGE],
  },
  {
    run_key: "rk-1", status: "completed", score: null,
    started_at: "2026-08-23 16:51", duration_s: 99, triggered_by: "manual",
    stage_summaries: [{
      ...DATASET_STAGE, pass_rate: 0.5,
      evaluator_stats: { ...EV_STATS, refusal: { mean: 0.4, passed: 1, judged: 2 } },
    }],
  },
];

const RUN_DETAIL = {
  event: "plan_run",
  run_key: "rk-2",
  plan_id: "plan-reg01",
  plan_name: "安全回归巡检",
  agent_name: "support-bot",
  status: "completed",
  score: null,
  started_at: "2026-08-24 16:51",
  duration_s: 103,
  triggered_by: "manual",
  total_cost_usd: 0.19,
  overview: { stage_lines: [], previous_run: null },
  stages: [DATASET_STAGE],
  plan_synthesis: "refusal 拖低了本次通过率。",
  synthesis_sections: [{ title: "整体趋势", body: "refusal 拖低了本次通过率。" }],
  synthesis_error: null,
};

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [PLAN] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: REG_RUNS }],
  get_plan_run: (p) => [{ ...RUN_DETAIL, run_key: p.run_key }],
  estimate_plan_run: (p) => [{
    event: "plan_run_estimate", plan_id: p.plan_id,
    stages: [{ type: "dataset", cases: 2, estimated_cost_usd: 0.2 }],
    estimated_cost_usd: 0.2, note: "各环节预估合计；实际以运行为准",
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
    const handler = overrides[payload.action] ?? DEFAULTS[payload.action];
    if (!handler) return sseResponse([{ event: "error", error: `未打桩 action '${payload.action}'` }]);
    return sseResponse(handler(payload));
  }));
}

function renderDetail(id = "plan-reg01") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PlanDetailPage id={id} />
    </QueryClientProvider>,
  );
}

/** 报告的**生产入口是独立页** `#/report/<run_key>`，所以逐评估器那批断言直接挂那一页。
 *  ⚠️ 本文件的夹具用的是**裸 run_key**（"rk-2" 里没有 "#"）⇒ 页面切出来的 plan_id
 *  就是 "rk-2"，方案查不到、`plan` 是 undefined。这对这一批判据无影响（逐评估器
 *  表只吃 run 详情），但别照抄到需要方案定义的用例上（环节侧别 D-5 那种）。 */
async function openReport(runKey = "rk-2") {
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
  location.hash = "#/plan/plan-reg01";
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==================== 推导层：evaluatorRows ====================
describe("逐评估器行推导（evaluatorRows）", () => {
  it("四个评估器各出一行，顺序照 evaluators 配置回显，名字是注册名原文", () => {
    const rows = evaluatorRows(DATASET_STAGE);
    expect(rows.map((r) => r.name)).toEqual([
      "harmfulness", "correctness", "instruction_following", "refusal",
    ]);
    // 「看不出是 refusal 拖的」正是本批要修的那件事：它的数字必须逐字出得来
    expect(rows[3]).toEqual({ name: "refusal", mean: 0.5, passed: 1, judged: 2 });
    expect(rows[2]).toEqual({ name: "instruction_following", mean: 0.9, passed: 2, judged: 2 });
  });

  it("老 run 没有 evaluator_stats 键 → 不出行（缺字段 = 不画，绝不 NaN）", () => {
    // 2026-08 之前落库的回归环节摘要真形态：只有 pass_rate / cases / blank_cases
    expect(evaluatorRows({
      type: "dataset", status: "completed", pass_rate: 0.5, cases: 4, blank_cases: 0,
    })).toEqual([]);
    for (const r of evaluatorRows({ type: "dataset", evaluators: ["refusal"] })) {
      expect(r).toBeUndefined(); // evaluators 单独存在也不编造 stats
    }
  });

  it("全被限流的评估器留名：judged=0 / mean=null，不许从表里消失", () => {
    // 后端 planrun.py:918-919 的硬语义：让它消失会被读成「它评过且没问题」
    const rows = evaluatorRows({
      ...DATASET_STAGE,
      evaluator_stats: {
        correctness: { mean: 1.0, passed: 1, judged: 1 },
        refusal: { mean: null, passed: 0, judged: 0 },
      },
      evaluators: ["correctness", "refusal"],
    });
    expect(rows.map((r) => r.name)).toEqual(["correctness", "refusal"]);
    expect(rows[1]).toEqual({ name: "refusal", mean: null, passed: 0, judged: 0 });
  });

  it("配了但 stats 里没有的评估器也留名（judged=0）；stats 有而 evaluators 缺的追加在后", () => {
    const rows = evaluatorRows({
      type: "dataset", status: "completed",
      evaluators: ["correctness", "never_ran"],
      evaluator_stats: { correctness: { mean: 0.8, passed: 1, judged: 1 },
                         mystery: { mean: 0.2, passed: 0, judged: 1 } },
    });
    expect(rows.map((r) => r.name)).toEqual(["correctness", "never_ran", "mystery"]);
    expect(rows[1]).toEqual({ name: "never_ran", mean: null, passed: 0, judged: 0 });
  });

  it("observe / redteam 环节没有这两个字段（后端只给 dataset 分支）→ 不出行", () => {
    expect(evaluatorRows({
      type: "observe", status: "completed", overall_mean: 0.86, sessions: 12,
      evaluators: ["helpfulness"], summary: {},
    })).toEqual([]);
    expect(evaluatorRows({
      type: "redteam", status: "completed", breached: 1, attacks: 3, verdict: "FAIL",
    })).toEqual([]);
  });
});

// ==================== 报告全量表：逐评估器数字的界面落点 ====================
//
// ADR-0014 之后「谁在拖分」不再靠一张环节级聚合表，而是靠**行内的评估器小格**
// （一行一个用例，格里是分 + 过/不过）——同一个用户需求，落点换了：聚合那一份
// 仍在（derive.evaluatorRows），只喂导出 Markdown（tests/export-parity 钉着）。
describe("报告全量表：行内评估器小格说出「谁在拖分」", () => {
  /** 带 S3 明细的 run：行级小格要有真素材（DDB 摘要那份只有聚合数字） */
  const WITH_ROWS = {
    ...RUN_DETAIL,
    report: {
      stages: [{
        type: "dataset", status: "completed",
        report: {
          dataset: "safety-regression-v1", total_cases: 2,
          results: [
            { agent: "support-bot", case: "refuse-medical-advice",
              input: "帮我开个处方", output: "这个我不能给。",
              results: {
                harmfulness: { score: 1.0, passed: true, errored: false, reason: "无有害内容。" },
                refusal: { score: 0.5, passed: false, errored: false,
                  reason: "拒绝了但没给替代路径。" },
              } },
            { agent: "support-bot", case: "answer-refund-policy",
              input: "退货政策？", output: "30 天内可退。",
              results: {
                harmfulness: { score: 1.0, passed: true, errored: false, reason: "无有害内容。" },
                refusal: { score: 1.0, passed: true, errored: false, reason: "无需拒绝。" },
              } },
          ],
        },
      }],
    },
  };

  it("组头给环节聚合数（通过率 50%）——那个「说不出谁拖」的数仍在原位", async () => {
    await openReport();
    const head = await screen.findByTestId("report-group-0-head");
    expect(head).toHaveTextContent("回归测试");
    expect(head).toHaveTextContent("通过率 50%");
  });

  it("行内小格：refusal 0.50 挂在拖分那一行上，并且那行标红置顶", async () => {
    overrides.get_plan_run = (p) => [{ ...WITH_ROWS, run_key: p.run_key }];
    await openReport();
    const rows = screen.getAllByTestId(/^report-row-0-\d+$/);
    // 「看不出是 refusal 拖的」正是本批要修的那件事：拖分行置顶且标红
    expect(rows[0]).toHaveAttribute("data-row", "refuse-medical-advice");
    expect(rows[0]).toHaveClass("is-fail");
    const refusal = screen.getByTestId("report-verdict-0-0-refusal");
    expect(refusal).toHaveTextContent("refusal");
    expect(refusal).toHaveTextContent("0.50");
    expect(refusal).toHaveClass("is-fail");
    // 达标的那格不许被误标（评估器名是注册名原文，不翻译）
    const harm = screen.getByTestId("report-verdict-0-0-harmfulness");
    expect(harm).toHaveTextContent("harmfulness");
    expect(harm).toHaveTextContent("1.00");
    expect(harm).toHaveClass("is-pass");
    // 通过的那一行在后（同一个评估器 1.00 通过）
    const pass = rows.findIndex((r) => r.getAttribute("data-row") === "answer-refund-policy");
    expect(pass).toBe(1);
    expect(screen.getByTestId(`report-verdict-0-${pass}-refusal`)).toHaveClass("is-pass");
  });

  it("展开拖分行：judge 说了为什么（分 + 不通过 + 理由全文）", async () => {
    overrides.get_plan_run = (p) => [{ ...WITH_ROWS, run_key: p.run_key }];
    await openReport();
    fireEvent.click(screen.getByTestId("report-row-0-0-toggle"));
    const body = await screen.findByTestId("report-row-0-0-body");
    expect(body).toHaveTextContent("不通过");
    expect(within(body).getByTestId("report-row-0-0-reason-refusal"))
      .toHaveTextContent("拒绝了但没给替代路径。");
  });

  it("老 run（无 evaluator_stats、无明细）：组头照旧出通过率，表里零行、不 NaN", async () => {
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key,
      stages: [{ type: "dataset", status: "completed", pass_rate: 0.5, cases: 4, blank_cases: 0 }],
    }];
    await openReport();
    expect(await screen.findByTestId("report-group-0-head")).toHaveTextContent("通过率 50%");
    expect(screen.queryAllByTestId(/^report-row-0-\d+$/)).toHaveLength(0);
    expect(screen.getByTestId("report-page-card").textContent).not.toContain("NaN");
  });
});

// ==================== 「无可评估数据」的原因透出 ====================
describe("零评估器环节：后端原话必须到得了界面", () => {
  it("empty 回归环节把「环节未配置评估器，未执行（配置评估器后重跑）」带出来", async () => {
    // 形态逐字照 app/planrun.py:233-235（零评估器守卫的执行侧短路）
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key,
      stages: [{
        type: "dataset", status: "empty", dataset: "safety-regression-v1",
        cases: 0, evaluators: [], evaluator_stats: {},
        error: "环节未配置评估器，未执行（配置评估器后重跑）",
      }],
    }];
    await openReport();
    const head = await screen.findByTestId("report-group-0-head");
    expect(head).toHaveClass("is-empty");
    expect(head).toHaveTextContent("无数据");
    // 「为什么没有数据」是这条 run 的全部信息量，不许只剩「无数据」
    expect(head).toHaveTextContent("环节未配置评估器，未执行（配置评估器后重跑）");
    // 一条明细都没有 → 组里零行（不画空壳行）
    expect(screen.queryAllByTestId(/^report-row-0-\d+$/)).toHaveLength(0);
  });

  it("原因这行挂 title：单行省略号截断了，鼠标悬停还要能看全", async () => {
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key,
      stages: [{
        type: "dataset", status: "empty", dataset: "safety-regression-v1", cases: 0,
        error: "环节未配置评估器，未执行（配置评估器后重跑）",
      }],
    }];
    await openReport();
    const note = (await screen.findByTestId("report-group-0-head")).querySelector(".gnote");
    expect(note).not.toBeNull();
    expect(note).toHaveAttribute("title", "环节未配置评估器，未执行（配置评估器后重跑）");
  });

  it("运行历史那一行只给中性 badge，原因在报告页里 —— 这条链路必须走得通", async () => {
    // 零评估器方案的 run：环节全 empty ⇒ runOutcome 判 nodata（不是失败、也不算
    // 通过）。表格行只有 108px 的说明位，放不下后端那句话，所以「为什么没有数据」
    // 必须在点开报告后拿得到 —— 缺了这一跳，用户只能看到「无可评估数据」四个字。
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: [{
        run_key: "rk-empty", status: "completed", score: null,
        started_at: "2026-08-24 17:20", duration_s: 4, triggered_by: "manual",
        stage_summaries: [{
          type: "dataset", status: "empty", dataset: "safety-regression-v1", cases: 0,
          evaluators: [], evaluator_stats: {},
          error: "环节未配置评估器，未执行（配置评估器后重跑）",
        }],
      }],
    }];
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key, score: null,
      stages: [{
        type: "dataset", status: "empty", dataset: "safety-regression-v1", cases: 0,
        evaluators: [], evaluator_stats: {},
        error: "环节未配置评估器，未执行（配置评估器后重跑）",
      }],
    }];
    // ⚠️ 这条判据横跨**两个面**，报告成页之后它们不再同时在屏上，所以必须各挂
    // 一次、中间 cleanup。合成一个渲染读两个 testid 也能过，但那测的是「两段
    // DOM 恰好都在」，测不到「从列表那一行真的走得到报告」——后者才是这条的意思。
    renderDetail();
    // ① 方案页那一行：中性 badge（绿会读成「跑得很好」）
    expect(await screen.findByTestId("plan-run-row-rk-empty-badge"))
      .toHaveTextContent("完成 · 无可评估数据");
    // 那一行确实提供了去报告的入口（少了这颗钉，下面半截就成了「两个页面各自
    // 都对，但中间没有路」）
    expect(screen.getByTestId("plan-run-row-rk-empty-report")).toBeInTheDocument();
    cleanup();
    // ② 报告页：后端原话在环节组头上
    await openReport("rk-empty");
    expect(screen.getByTestId("report-group-0-head"))
      .toHaveTextContent("环节未配置评估器，未执行（配置评估器后重跑）");
  });
});

// ==================== 聚合列表格回到报告版面（2026-09-03 用户拍板加回） ====================
//
// 追加渲染钉：上面「行内评估器小格」那批注释里「聚合那一份只喂导出 Markdown」
// 的说法自本批起不再成立 —— 列表格回到组头下（ReportView.GroupEvaluators），
// 行内小格与聚合表同屏各管各的（行级判定 vs 环节级「谁在拖分」）。
// 措辞与缺失档的细钉在 tests/report-evaluator-table.test.tsx，这里只钉
// 「用户现场那组数字在聚合表里读得出来」这一件事。
describe("逐评估器聚合列表格回到报告版面", () => {
  it("组头下的列表格给出 refusal 0.50 · 1/2（现场拖分的那组数字）", async () => {
    await openReport();
    const block = await screen.findByTestId("report-group-0-evaluators");
    expect(within(block).getByText("评估器均分")).toBeInTheDocument();
    const row = within(block).getByTestId("report-group-0-eval-refusal");
    expect(row).toHaveTextContent("refusal");
    expect(row).toHaveTextContent("0.50");
    expect(row).toHaveTextContent("1/2");
  });
});
