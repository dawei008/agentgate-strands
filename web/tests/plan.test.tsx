// 方案详情页 + 方案编辑器测试。
// fetch 打桩方式与 resources.test.tsx 一致（stubGlobal + SSE Response）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectProseGone } from "./prose";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PlanDetailPage, { RunProgress } from "../src/pages/plan/PlanDetailPage";
import PlanEditor, { evaluatorsForStage, focusStagesArea } from "../src/pages/plan/PlanEditor";
// 旧报告页壳（渲染共享视图 ReportView，抽屉正文）：独立页已换成变体 A，见 tests/legacyReportPage.tsx
import ReportPage from "./legacyReportPage";
import { logEntryOf, type RunLogEntry } from "../src/pages/plan/useRunPlan";
import { deriveKpis, sectionsOf, trendPoints, trendStats, synthesisSections } from "../src/pages/plan/derive";
import { TREND_TARGET } from "../src/pages/plan/TrendCard";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import {
  sseFrames, BLANK_TARGET_MARKER, INVOKE_FAILED_MARKER, PLAN_RUNS,
  REGRESSION_PLAN_RUNS,
} from "../src/mocks/handlers";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;

let calls: Payload[] = [];
let overrides: Record<string, (p: Payload) => unknown[] | Promise<unknown[]>> = {};

const PLAN: import("../src/pages/plan/types").Plan = {
  plan_id: "plan-aaa111",
  name: "FAQ 周回归",
  agent_name: "support-bot",
  updated_at: 1755500000,
  stages: [
    { type: "observe", evaluators: ["helpfulness"] },
    { type: "dataset", dataset: "faq-v3", evaluators: ["correctness"] },
  ],
  // 契约对象（app/plan.py:109-117）；裸五段 cron 属存量数据，编辑保存时归一
  schedule: { cron: "0 3 * * 1", budget_usd: 2 },
};

// 每行带 stage_summaries（真后端 list_plan_runs → _run_from_item 无条件给，
// 老归档/skipped 是空数组）。环节字段逐字照 planrun.py:_stage_summary。
const RUNS = [
  {
    run_key: "rk-1", status: "completed", score: 0.86,
    started_at: "2026-08-11 09:00", duration_s: 74, triggered_by: "manual",
    stage_summaries: [
      { type: "observe", status: "completed", overall_mean: 0.86, sessions: 12, summary: {} },
    ],
  },
  {
    run_key: "rk-2", status: "completed", score: 0.78,
    started_at: "2026-08-09 03:00", duration_s: 81, triggered_by: "schedule",
    stage_summaries: [
      { type: "observe", status: "completed", overall_mean: 0.78, sessions: 10, summary: {} },
    ],
  },
  {
    run_key: "rk-3", status: "skipped", score: null,
    started_at: "2026-08-07 03:00", duration_s: 0, triggered_by: "schedule",
    skip_reason: "无新增线上会话",
    stage_summaries: [],
  },
  {
    run_key: "rk-4", status: "error", score: null,
    started_at: "2026-08-02 03:00", duration_s: 12, triggered_by: "schedule",
    stage_summaries: [{ type: "observe", status: "error", error: "judge 限流：ThrottlingException" }],
  },
];

const SYNTHESIS_TEXT = [
  "## 整体趋势",
  "均分从 0.74 升至 0.88（[run:#1] → [run:#2]）。",
  "",
  "## 反复出现的问题",
  "回归 case-2 持续答非所问（[run:#2]），建议补充知识库。",
  "",
  "## 改进采纳效果",
  "暂无已采纳的改进记录。",
  "",
  "## 当前优先建议",
  "补充「账户安全」知识库条目。",
].join("\n");

const RUN_DETAIL = {
  event: "plan_run",
  run_key: "rk-1",
  plan_id: "plan-aaa111",
  // 真后端 _run_from_item 顶层带 plan_name/agent_name（导出文件名与正文要用）
  plan_name: "FAQ 周回归",
  agent_name: "support-bot",
  status: "completed",
  // 综合分在**顶层**（真后端 _run_from_item；observe 环节均分算出）
  score: 0.86,
  started_at: "2026-08-11 09:00",
  duration_s: 74,
  triggered_by: "manual",
  overview: { score: 0.86, cases: 14, passed: 12, cost_usd: 0.31 },
  // 环节指标键逐字照 _stage_summary（observe→overall_mean/sessions、
  // dataset→pass_rate/cases）——此前是自造键（score/passed），runOutcome
  // 按环节判定后自造键会被判成「无有效结果」，把好 run 显示成 no-data
  // （正是 mock 说谎才测不出 UI-013 的形态）。dataset/evaluators 两键取自
  // S3 report.stages 全量形态（抽屉右侧注记消费它们）。
  stages: [
    { type: "observe", evaluators: ["helpfulness"], overall_mean: 0.86, sessions: 12, status: "completed" },
    { type: "dataset", dataset: "faq-v3", evaluators: ["correctness"], pass_rate: 0.75, cases: 2, status: "completed" },
  ],
  plan_synthesis: SYNTHESIS_TEXT,
  // 后端新字段（additive）：默认桩带上；fallback 用例会显式抹掉它
  synthesis_sections: [
    { title: "整体趋势", body: "均分从 0.74 升至 0.88（[run:#1] → [run:#2]）。" },
    { title: "反复出现的问题", body: "回归 case-2 持续答非所问（[run:#2]），建议补充知识库。" },
    { title: "改进采纳效果", body: "暂无已采纳的改进记录。" },
    { title: "当前优先建议", body: "补充「账户安全」知识库条目。" },
  ],
  synthesis_error: null,
};

const EVALUATORS_EVENT = {
  event: "evaluators",
  available: ["coherence", "helpfulness", "harmfulness"],
  dataset_only: ["correctness"],
  multimodal: ["mm_correctness"],
  scopes: {
    coherence: ["observe", "dataset"],
    helpfulness: ["observe", "dataset"],
    harmfulness: ["observe", "dataset", "redteam"],
    correctness: ["dataset"],
    mm_correctness: ["dataset"],
  },
  custom: [
    { name: "brand_tone", scope: "all", rubric: "…", created_at: 1, updated_at: 2, blocks: null },
    { name: "citation_quality", scope: "dataset", rubric: "…", created_at: 1, updated_at: 1, blocks: null },
  ],
  // observe 环节会话范围配套：零成本 trace 指标选项 + 新建默认值（后端 evaluators 事件同款字段）
  metrics: ["tokens", "cost", "latency", "llm_calls", "tool_calls"],
  default: [],
  default_metrics: ["tokens", "cost", "latency", "llm_calls", "tool_calls"],
};

const DATASETS_EVENT = {
  event: "datasets",
  datasets: [
    { name: "faq-v3", kind: "regression", target_agent: "", case_count: 2 },
    // 显式模拟集 + 历史多轮集（kind=regression 靠 cases 形态推断归模拟侧）
    { name: "sim-rebooking", kind: "simulation", target_agent: "", case_count: 2 },
    {
      name: "flow-multi", kind: "regression", target_agent: "", case_count: 1,
      cases: [{ name: "t1", input: "开场", task_description: "完成订票" }],
    },
    { name: "jailbreak-probes", kind: "redteam", target_agent: "support-bot", case_count: 1 },
    { name: "probes-other", kind: "redteam", target_agent: "research-agent", case_count: 3 },
  ],
};

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [PLAN] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: RUNS }],
  // 形态逐字照真后端（app/main.py:1414-1416 的 {event, plan_id, **estimate}
  // + planrun.py:91-93 的 {stages, estimated_cost_usd, note}）。顶层没有
  // cases 这个键（那是 dataset 环节自己的），此前的 cases:14 是 mock 幻觉。
  estimate_plan_run: (p) => [{
    event: "plan_run_estimate",
    plan_id: p.plan_id,
    stages: [
      { type: "observe", judge_calls: 20, estimated_cost_usd: 0.12,
        note: "线上评估环节：仅产生 judge 费用，不调用被测 Agent" },
      { type: "dataset", cases: 14, estimated_cost_usd: 0.3 },
    ],
    estimated_cost_usd: 0.42,
    note: "各环节预估合计（运行结束后还会生成一次评估计划级综合报告，"
      + "增加一次 judge 调用费用）；实际以运行为准",
  }],
  delete_plan: (p) => [{ event: "plan_deleted", plan_id: p.plan_id }],
  get_plan_run: (p) => [{ ...RUN_DETAIL, run_key: p.run_key }],
  evaluators: () => [EVALUATORS_EVENT],
  list_datasets: () => [DATASETS_EVENT],
  // 攻击策略菜单（app/main.py:981-987 契约的编辑器消费面）：
  // strategies 全量菜单；default_strategies 只进提示文案，不预填选中
  redteam_options: () => [{
    event: "redteam_options",
    // ⚠️ 与真后端同刑：strategy_menu() 返回对象数组（app/redteam.py:129），
    // 不是字符串数组。曾用字符串 + 虚构名，单测全绿而线上 React error #31 白屏。
    strategies: [
      { name: "gradual_escalation", label: "渐进升级", desc: "多轮逐步升温。", turns: 10, snapshot_safe: true },
      { name: "goat", label: "GOAT 自适应", desc: "每轮自适应调整手法。", turns: 5, snapshot_safe: true },
      { name: "bad_likert_judge", label: "评分量表诱导", desc: "借打分示例索取高危内容。", turns: 3, snapshot_safe: true },
      { name: "pair", label: "PAIR 单发迭代", desc: "反复改写单条越狱提示。", turns: 5, snapshot_safe: true },
    ],
    default_strategies: ["gradual_escalation", "goat"],
  }],
  discover: () => [{
    event: "agents", region: "us-west-2", from_cache: true,
    agents: [
      { agent_name: "support-bot", runtime_arn: "arn:a" },
      { agent_name: "research-agent", runtime_arn: "arn:b" },
    ],
  }],
  save_plan: (p) => {
    const plan = p.plan as Record<string, unknown>;
    return [{
      event: "plan_saved",
      plan: { ...plan, plan_id: (plan.plan_id as string) || "plan-new123" },
      scheduled: Boolean(plan.schedule),
      schedule_error: null,
    }];
  },
};

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
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
    return sseResponse(await handler(payload));
  }));
}

function newQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** qc 可外传：UI-009 要在同一个 QueryClient 上串「编辑页保存 → 详情页首帧」 */
function renderDetail(id = "plan-aaa111", qc = newQc()) {
  return render(
    <QueryClientProvider client={qc}>
      <PlanDetailPage id={id} />
    </QueryClientProvider>,
  );
}

function renderEditor(plan?: typeof PLAN, qc = newQc()) {
  return render(
    <QueryClientProvider client={qc}>
      <PlanEditor plan={plan} />
    </QueryClientProvider>,
  );
}

/** 发起运行 = 点「运行」+ 过二次确认卡（缺陷 2 起四处入口都有确认步；
    卡上预估费用的断言在下方「发起运行二次确认」describe，这里只做动作）。 */
function clickRunAndConfirm() {
  fireEvent.click(screen.getByTestId("plan-run"));
  fireEvent.click(screen.getByTestId("confirm-card-ok"));
}

/** 可控 list_plans 闸门：release 句柄在构造时同步捕获（Promise executor 同步执行），
    不藏在 async 回调里——夹具句柄必须在 install 返回时就绪。 */
function deferredPlans() {
  let release!: (plans: unknown[]) => void;
  const gate = new Promise<unknown[]>((resolve) => {
    release = (plans) => resolve([{ event: "plans", plans }]);
  });
  return { gate, release };
}

/** 等 evaluators 元数据灌进组件再返回：新建 observe 环节的默认评估器/指标在点击
    「+ 线上评估」的瞬间捕获（照旧版语义），测试必须先确保元数据已就绪——
    加一张临时 observe 卡等 chips 渲染出来（= 元数据已提交），再删掉复原。 */
async function primeEvaluatorsLoaded() {
  fireEvent.click(screen.getByTestId("plan-form-add-observe"));
  await screen.findByTestId("plan-stage-card-0-eval-coherence");
  fireEvent.click(screen.getByTestId("plan-stage-card-0-remove"));
}

beforeEach(() => {
  calls = [];
  overrides = {};
  resetConfigForTest();
  location.hash = "#/plan/plan-aaa111";
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
  // 在飞状态是模块级的（lib/runFlight，缺陷 1 的跨组件通道）：本文件有多条用例
  // 故意把流挂着不关（实时对话/心跳），不清零会让下一条用例的「运行」按钮
  // 一上来就是 disabled 的「运行中…」。
  resetRunFlightForTest();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==================== KPI 推导（纯函数） ====================
describe("KPI 推导", () => {
  it("均分只算 completed 且有分数的 run；delta = 最近两次成功分之差", () => {
    const k = deriveKpis(RUNS);
    expect(k.avgScore).toBeCloseTo((0.86 + 0.78) / 2, 10);
    expect(k.delta).toBeCloseTo(0.86 - 0.78, 10);
    expect(k.successCount).toBe(2);
    expect(k.totalCount).toBe(4);
  });

  it("无成功 run：均分 null、delta null；单次成功：delta null", () => {
    expect(deriveKpis([])).toEqual({ avgScore: null, delta: null, successCount: 0, totalCount: 0 });
    const one = deriveKpis([RUNS[0], RUNS[3]]);
    expect(one.avgScore).toBeCloseTo(0.86, 10);
    expect(one.delta).toBeNull();
  });
});

// ==================== 统一返回位（用户点名「所有页面没有返回按钮」） ====================
describe("PageHeader 返回位", () => {
  it("方案详情正常态：← 评估计划（此前只有加载失败态能回去）", async () => {
    renderDetail();
    await screen.findByTestId("plan-name");
    const back = screen.getByTestId("pagehead-back");
    expect(back).toHaveTextContent("评估计划");
    fireEvent.click(back);
    expect(location.hash).toBe("#/workbench");
  });

  it("编辑器编辑态：← 方案详情；新建态：← 评估计划", async () => {
    renderEditor(PLAN);
    let back = screen.getByTestId("pagehead-back");
    expect(back).toHaveTextContent("评估计划详情");
    fireEvent.click(back);
    expect(location.hash).toBe("#/plan/plan-aaa111");
    cleanup();
    renderEditor();
    back = screen.getByTestId("pagehead-back");
    expect(back).toHaveTextContent("评估计划");
    fireEvent.click(back);
    expect(location.hash).toBe("#/workbench");
  });
});

// ==================== M1：页头 + KPI + 运行历史 ====================
describe("详情页 M1", () => {
  it("页头：方案名 + agent 链接 + cron；KPI 行：均分/成功比/预估", async () => {
    renderDetail();
    await screen.findByTestId("plan-name");
    expect(screen.getByTestId("plan-name")).toHaveTextContent("FAQ 周回归");
    expect(screen.getByTestId("plan-agent-link")).toHaveAttribute("href", "#/agent/support-bot");
    // 保真度批次：页头改用 <PageHeader>，cron 落在 sub 里（plan-name 只剩方案名）
    expect(screen.getByTestId("plan-head")).toHaveTextContent("0 3 * * 1");
    await waitFor(() => expect(screen.getByTestId("plan-kpi-avg")).toHaveTextContent("0.82"));
    expect(screen.getByTestId("plan-kpi-success")).toHaveTextContent("2/4");
    await waitFor(() => expect(screen.getByTestId("plan-kpi-estimate")).toHaveTextContent("$0.42"));
    // KPI 脚注「按当前方案定义预估」对任何方案恒成立 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("plan-kpis"), "按当前方案定义预估");
  });

  it("运行历史表：列齐全 + skipped 行显示 skip_reason", async () => {
    renderDetail();
    const table = await screen.findByTestId("plan-runs-table");
    // 最新在前：rk-1 第一行
    const rows = within(table).getAllByTestId(/^plan-run-row-rk-\d$/);
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      "plan-run-row-rk-1", "plan-run-row-rk-2", "plan-run-row-rk-3", "plan-run-row-rk-4",
    ]);
    const first = within(rows[0]);
    expect(first.getByText("2026-08-11 09:00")).toBeInTheDocument();
    expect(first.getByText("1m14s")).toBeInTheDocument();
    expect(first.getByText("完成")).toBeInTheDocument();
    expect(first.getByText("0.86")).toBeInTheDocument();
    expect(first.getByText("手动")).toBeInTheDocument();
    expect(first.getByText("查看报告")).toBeInTheDocument();
    // skipped 行：badge=跳过 + skip_reason 原文
    expect(screen.getByTestId("plan-run-row-rk-3-skip-reason")).toHaveTextContent("无新增线上会话");
    expect(within(rows[2]).getByText("跳过")).toBeInTheDocument();
  });

  // 成本熔断两形态的**页面级**断言（simplify-r2 Track F 新夹具连带；档
  // mock-missing-halted-cost-fixture 的验收第 3 条）。用 mocks/handlers 那份真
  // PLAN_RUNS，不自造夹具 —— 要钉的正是「mock 里的熔断 run 走到界面上长什么样」。
  // 等待锚点挑**熔断那一行自己**的 testid（目标数据专属），不拿 plan-runs-table
  // 容器当锚点：表格在第一批数据到达时就出现，而这两行是同一批里的目标数据。
  it("熔断 run 的 badge 落失败侧并带「（成本熔断）」，绝不是「完成 · 无可评估数据」", async () => {
    overrides.list_plan_runs = (p) => [
      { event: "plan_runs", plan_id: p.plan_id, runs: PLAN_RUNS },
    ];
    renderDetail();
    // 全熔断（唯一的回归环节被掐）
    const full = await screen.findByTestId(
      "plan-run-row-plan-aaa111#2026-08-05T03:00:00Z-badge");
    expect(full).toHaveClass("badge", "bad");
    expect(full).toHaveTextContent("失败 · 回归测试（成本熔断）");
    expect(full).not.toHaveTextContent("无可评估数据");
    // 半截通过率不许当指标 chip 吐出来（12 个用例只判了 5 个）
    expect(full.querySelector(".badge-mono")).toBeNull();
    // 部分熔断（observe 评完了 + 红队环节被掐）
    const partial = screen.getByTestId(
      "plan-run-row-plan-aaa111#2026-07-30T03:00:00Z-badge");
    expect(partial).toHaveClass("badge", "warn");
    expect(partial).toHaveTextContent("部分失败 · 红队测试（成本熔断）");
    expect(partial).not.toHaveTextContent("无可评估数据");
    // 这一环真的评出了东西 ⇒ observe 均分照常作为指标 chip 显示
    expect(partial).toHaveTextContent("0.79");
  });

  // 纯回归方案夹具连带（simplify-r2 Track F；同族追加：mock 缺后端产得出的状态）。
  // 此前 mock 每个方案都含 observe 环节 ⇒ 趋势卡口径 B（通过率主线 + 逐评估器线）
  // 在 dev 下永远看不到。这里钉的是「那份夹具确实把口径 B 点亮了」。
  it("纯回归方案的运行历史 → 趋势卡走回归口径（通过率主线 + 逐评估器图例）", async () => {
    overrides.list_plan_runs = (p) => [
      { event: "plan_runs", plan_id: p.plan_id, runs: REGRESSION_PLAN_RUNS },
    ];
    renderDetail();
    // 锚点：逐评估器图例项本身（口径 B 专属，口径 A 单序列根本不出图例）
    const legend = await screen.findByTestId("plan-trend-legend-refusal");
    expect(screen.getByTestId("plan-trend-legend-pass-rate")).toHaveTextContent("90%");
    // 拖分的那个评估器：最近一次 0.55（「一个通过率说不出是谁在拖」）
    expect(legend).toHaveTextContent("0.55");
    expect(screen.getByTestId("plan-trend-legend-correctness")).toHaveTextContent("0.94");
    expect(screen.getByTestId("plan-trend-card")).toHaveTextContent("4 次回归运行");
    // 顶层 score 恒 null ⇒ 口径 A 的空态文案（「已有 0 次有分运行」）不许出现
    expect(screen.queryByTestId("plan-trend-empty")).not.toBeInTheDocument();
  });

  // 删除流程用例已搬至 confirm-card.test.tsx（window.confirm → ConfirmCard 玻璃确认卡）

  // 危险动作默认焦点纪律（UI-004）：删数据集、删评估器的 ConfirmCard 都传了
  // initialFocus="cancel"，删方案的漏传 —— 卡弹出后焦点在卡本体，一个回车
  // 就把方案连运行历史一起删掉（不可撤销）。此处只钉焦点落点，
  // 删除流程本身的断言仍在 confirm-card.test.tsx。
  it("删方案确认卡：默认焦点落在「取消」（回车误触不会删）", async () => {
    renderDetail();
    // 锚点挑本页专属数据（方案名），不是通用文案
    await screen.findByTestId("plan-name");
    fireEvent.click(screen.getByTestId("plan-delete"));
    expect(screen.getByTestId("confirm-card")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId("confirm-card-cancel"));
    // 回车落在取消键上 → 关卡、不发 delete_plan
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(calls.filter((c) => c.action === "delete_plan")).toHaveLength(0);
  });

  it("方案不存在：显示找不到 + 空历史空态文案", async () => {
    overrides.list_plans = () => [{ event: "plans", plans: [] }];
    renderDetail("plan-nope");
    await screen.findByTestId("plan-not-found");
    expect(screen.getByTestId("plan-not-found")).toHaveTextContent("plan-nope");
  });
});

// ==================== UI-009：否定态不抢在数据就绪之前 ====================
// 用户亲眼撞见：新建方案保存成功、跳详情页后先闪「找不到方案／它可能已被删除」，
// 数秒后同一 URL 自动恢复——误判保存失败去重复创建。根因是 isLoading 只在
// 「无缓存首次加载」为 true，而此刻缓存里是**不含新方案**的旧列表。
describe("UI-009 方案详情否定态时机", () => {
  const NEW_PLAN = {
    plan_id: "plan-new123",
    name: "刚建的方案",
    agent_name: "support-bot",
    updated_at: 1755500001,
    stages: [{ type: "dataset" as const, dataset: "faq-v3", evaluators: [] }],
    schedule: null,
  };

  it("保存新方案 → 详情页首帧就有方案，零「找不到方案」闪烁", async () => {
    const qc = newQc();
    // 复刻真实路径：从工作台进 #/plan/new，缓存里已有一份**不含新方案**的旧列表
    qc.setQueryData(["plans"], { event: "plans", plans: [PLAN] });
    // list_plans 挂在闸门上：跳转后详情页的 refetch 全程在途，
    // 首帧数据只可能来自编辑器写入的缓存
    const { gate, release } = deferredPlans();
    overrides.list_plans = () => gate as unknown as Promise<unknown[]>;
    overrides.save_plan = () => [{
      event: "plan_saved", plan: NEW_PLAN, scheduled: false, schedule_error: null,
    }];

    const editor = renderEditor(undefined, qc);
    await screen.findByTestId("plan-form-name");
    fireEvent.change(screen.getByTestId("plan-form-name"), { target: { value: "刚建的方案" } });
    const agentSelect = screen.getByTestId("plan-form-agent");
    await waitFor(() =>
      expect(within(agentSelect).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(agentSelect, { target: { value: "support-bot" } });
    fireEvent.click(screen.getByTestId("plan-form-add-dataset"));
    const dsSelect = await screen.findByTestId("plan-stage-card-0-dataset");
    await within(dsSelect).findByRole("option", { name: "faq-v3" });
    fireEvent.change(dsSelect, { target: { value: "faq-v3" } });
    fireEvent.click(screen.getByTestId("plan-form-save"));
    // 锚点挑「只有保存成功才成立」的跳转结果，不等次数
    await waitFor(() => expect(location.hash).toBe("#/plan/plan-new123"));
    editor.unmount();

    // 同一 QueryClient 渲染详情页：首帧（render 返回时）就必须是方案本体
    renderDetail("plan-new123", qc);
    expect(screen.queryByTestId("plan-not-found")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-name")).toHaveTextContent("刚建的方案");
    // 后台 refetch 落地（后端已含新方案）后仍稳定，不回退成否定态
    release([PLAN, NEW_PLAN]);
    await waitFor(() => expect(screen.getByTestId("plan-kpis")).toBeInTheDocument());
    expect(screen.queryByTestId("plan-not-found")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-name")).toHaveTextContent("刚建的方案");
  });

  it("陈旧缓存不含该方案且 refetch 在途：显示加载态，不渲染「找不到方案」", async () => {
    const qc = newQc();
    qc.setQueryData(["plans"], { event: "plans", plans: [PLAN] }); // 陈旧：无 plan-new123
    const { gate, release } = deferredPlans();
    overrides.list_plans = () => gate as unknown as Promise<unknown[]>;

    renderDetail("plan-new123", qc);
    // isLoading 为 false（有缓存）而 isFetching 为 true——正是本 bug 的窗口
    expect(screen.getByTestId("plan-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-not-found")).not.toBeInTheDocument();

    // 查询结束且后端确实没有 → 这才允许渲染否定态
    release([PLAN]);
    await screen.findByTestId("plan-not-found");
    expect(screen.getByTestId("plan-not-found")).toHaveTextContent("plan-new123");
  });
});

// ==================== M2：趋势数据映射 + 单次报告展开 ====================
describe("趋势数据映射", () => {
  it("只取成功 run，按时间升序，label 为 MM-DD HH:mm", () => {
    const pts = trendPoints(RUNS);
    expect(pts).toHaveLength(2);
    // 升序：rk-2(08-09) 在前，rk-1(08-11) 在后
    expect(pts.map((p) => p.score)).toEqual([0.78, 0.86]);
    expect(pts[0].label).toBe("08-09 03:00");
    expect(pts[1].label).toBe("08-11 09:00");
    expect(pts[0].t).toBeLessThan(pts[1].t);
  });

  it("成功 run <2 → 空数据（页面显示空态）；limit 截断取最近 N 次", () => {
    expect(trendPoints([RUNS[2], RUNS[3]])).toHaveLength(0);
    expect(trendPoints([RUNS[0], RUNS[3]])).toHaveLength(1);
    // limit=1 只留最近一次成功
    const one = trendPoints(RUNS, 1);
    expect(one).toHaveLength(1);
    expect(one[0].score).toBe(0.86);
  });

  it("页面：成功 <2 显示「首次运行完成后展示趋势」，≥2 渲染图表容器", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id, runs: [RUNS[0], RUNS[3]],
    }];
    renderDetail();
    await screen.findByTestId("plan-trend-card");
    await screen.findByTestId("plan-trend-empty");
    // 第 9 项：空态把触发条件显示出来（用户在线上看到空态不明白为什么）。
    // 文案是「有分运行」不是「成功运行」——趋势图的样本闸门是 isScored
    // （observe 分数），成功口径（isRunSuccess）比它宽（含纯回归/纯红队），
    // 两个词混用会出现「成功 3 次但样本只有 1」的数字矛盾（UI-013 修订）。
    expect(screen.getByTestId("plan-trend-empty"))
      .toHaveTextContent("已有 1 次有分运行，趋势图需要至少 2 次");
    expect(screen.queryByTestId("plan-trend-chart")).not.toBeInTheDocument();
    cleanup();

    overrides = {};
    renderDetail();
    await screen.findByTestId("plan-trend-card");
    await waitFor(() =>
      expect(screen.getByTestId("plan-trend-chart")).toBeInTheDocument());
    expect(screen.queryByTestId("plan-trend-empty")).not.toBeInTheDocument();
  });

  // ===== 第 9 项：图表按原型补全（面积 / 目标线标注 / 末点 / 区间统计列）=====
  it("趋势区间统计：最高/最低/均值/环比/跌破目标（从 runs 推）", () => {
    // RUNS 里成功两次：0.78(08-09) → 0.86(08-11)；目标线 0.7
    const stats = trendStats(trendPoints(RUNS), TREND_TARGET);
    expect(stats).not.toBeNull();
    expect(stats!.max).toBeCloseTo(0.86);
    expect(stats!.maxLabel).toBe("08-11 09:00");
    expect(stats!.min).toBeCloseTo(0.78);
    expect(stats!.minLabel).toBe("08-09 03:00");
    expect(stats!.avg).toBeCloseTo(0.82);
    expect(stats!.delta).toBeCloseTo(0.08);   // 末点 - 前一点
    expect(stats!.belowTarget).toBe(0);       // 两次都在 0.7 以上
    expect(stats!.count).toBe(2);
  });

  it("跌破目标计数：低于目标线的点被计入，环比为负时标记 neg", () => {
    const low = [
      { run_key: "a", status: "completed", score: 0.9, started_at: "2026-08-01 03:00",
        duration_s: 10, triggered_by: "schedule" },
      { run_key: "b", status: "completed", score: 0.5, started_at: "2026-08-02 03:00",
        duration_s: 10, triggered_by: "schedule" },
    ];
    const stats = trendStats(trendPoints(low), TREND_TARGET)!;
    expect(stats.belowTarget).toBe(1);
    expect(stats.delta).toBeCloseTo(-0.4);
  });

  it("页面：图表有面积填充 + 目标线标注 + 末点强调 + 右侧统计列", async () => {
    renderDetail();
    await screen.findByTestId("plan-trend-card");
    const chart = await screen.findByTestId("plan-trend-chart");
    // jsdom 下 ResponsiveContainer 量到 0×0，Recharts 不渲染 svg 内部——
    // 图元素（面积/末点/标注）只能在视觉基线里验（见 tests/visual/baseline/
    // 08-plan-detail.png）。这里只断言容器与统计列存在。
    expect(chart).toBeInTheDocument();
    // 右侧区间统计列数值
    const side = screen.getByTestId("plan-trend-stats");
    expect(side).toHaveTextContent("区间统计");
    expect(screen.getByTestId("trend-stat-max")).toHaveTextContent("0.86");
    expect(screen.getByTestId("trend-stat-min")).toHaveTextContent("0.78");
    expect(screen.getByTestId("trend-stat-avg")).toHaveTextContent("0.82");
    expect(screen.getByTestId("trend-stat-delta")).toHaveTextContent("+0.08");
    expect(screen.getByTestId("trend-stat-delta")).toHaveClass("pos");
    expect(screen.getByTestId("trend-stat-below")).toHaveTextContent("0 次");
  });
});

// ==================== 报告抽屉（右侧 600px，替代行内展开） ====================

describe("综合报告分节（纯函数，与后端 planrun.synthesis_sections 同逻辑）", () => {
  it("按 ## 标题切四节；引言并入首节 title=综合报告", () => {
    const s = synthesisSections("引言。\n\n" + SYNTHESIS_TEXT);
    expect(s.map((x) => x.title)).toEqual([
      "综合报告", "整体趋势", "反复出现的问题", "改进采纳效果", "当前优先建议",
    ]);
    expect(s[1].body).toContain("[run:#1]");
  });

  it("无标题命中：整段作单节 title=综合报告；空文本 → []", () => {
    expect(synthesisSections("纯文本报告，没有标题。"))
      .toEqual([{ title: "综合报告", body: "纯文本报告，没有标题。" }]);
    expect(synthesisSections(null)).toEqual([]);
    expect(synthesisSections("")).toEqual([]);
    expect(synthesisSections("  \n ")).toEqual([]);
    // 标题存在但正文为空：节保留（节数用于 n/N 计数）
    expect(synthesisSections("## 只有标题")).toEqual([{ title: "只有标题", body: "" }]);
  });

  // 四个消费方（报告页 / 评估分析 / 计划报告抽屉 / 运行详情）此前各写一遍这两行，
  // 只有运行详情做了 textOf 归一 —— 另三处遇到对象型 plan_synthesis 会炸整棵子树。
  it("sectionsOf：synthesis_sections 优先 / 缺则切 plan_synthesis / 无归档 → []", () => {
    expect(sectionsOf({ synthesis_sections: [{ title: "t", body: "b" }], plan_synthesis: "## 别用我" }))
      .toEqual([{ title: "t", body: "b" }]);
    // 空数组不算「有」：退回按 ## 切
    expect(sectionsOf({ synthesis_sections: [], plan_synthesis: "## 整体趋势\n升了" }))
      .toEqual([{ title: "整体趋势", body: "升了" }]);
    expect(sectionsOf({ plan_synthesis: null })).toEqual([]);
    expect(sectionsOf({})).toEqual([]);
    expect(sectionsOf(undefined)).toEqual([]);
    expect(sectionsOf(null)).toEqual([]);
  });

  it("sectionsOf：对象型输入不炸——plan_synthesis 是对象 / 分节的 title·body 是对象都归一成可渲染文本", () => {
    // 真后端实测会给对象（同 ViewRunMeta 一族的成因）；本层在 useMemo 里、错误围栏外，绝不许抛
    const secs = sectionsOf({ plan_synthesis: { summary: "整体持平" } });
    expect(secs).toEqual([{ title: "综合报告", body: "整体持平" }]);
    for (const [title, body] of secs.map((x) => [x.title, x.body])) {
      expect(typeof title).toBe("string");
      expect(typeof body).toBe("string");
    }
    // 认不出的键形：降级成可诊断文本（键名列出来），仍是字符串、仍不抛
    const weird = sectionsOf({ plan_synthesis: { foo: 1, bar: 2 } });
    expect(weird).toHaveLength(1);
    expect(weird[0].body).toContain("未预期的结构");
    expect(weird[0].body).toContain("foo, bar");
    // 数组形态（后端 list[str] 那族）：逐项归一后连起来，不粘连成一坨
    expect(sectionsOf({ plan_synthesis: ["甲", "乙"] })[0].body).toBe("甲 · 乙");
    // 分节数组里的 title/body 也可能是对象
    expect(sectionsOf({ synthesis_sections: [{ title: { summary: "趋势" }, body: null }] }))
      .toEqual([{ title: "趋势", body: "" }]);
    // 元素直接是 null / 非对象：不抛，给空节（字符串上取 .title 是 undefined ⇒ ""）
    expect(sectionsOf({ synthesis_sections: [null, "x"] }))
      .toEqual([{ title: "", body: "" }, { title: "", body: "" }]);
    // 非数组的 synthesis_sections（对象）不当分节用：退回 plan_synthesis
    expect(sectionsOf({ synthesis_sections: { a: 1 }, plan_synthesis: "## 整体趋势\n升了" }))
      .toEqual([{ title: "整体趋势", body: "升了" }]);
  });
});

describe("运行报告（独立页 #/report/<run_key>）", () => {
  /** 报告的**生产入口是独立页**，所以这一批断言挂那一页，不再走「方案页 →
   *  点查看报告 → 等抽屉」。
   *  ⚠️ 本文件夹具用的是**裸 run_key**（"rk-1" 没有 "#"）⇒ 页面切出来的 plan_id
   *  就是 "rk-1"，方案查不到、`plan` 为 undefined。对下面这批判据无影响（都只吃
   *  run 详情 + 运行历史），但**凡是判据落在 plan_id 上的用例必须自带真形态
   *  run_key**（`<plan_id>#<ts>`）—— 见「查看方案设置」那条。 */
  async function openReport(runKey = "rk-1") {
    render(
      <QueryClientProvider client={newQc()}>
        <ReportPage id={runKey} />
      </QueryClientProvider>,
    );
    await screen.findByTestId("report-drawer-head");
    // 头部先用 runs 摘要渲染；等 get_plan_run 灌完再断言（loading 消失）
    await waitFor(() =>
      expect(screen.queryByTestId("report-drawer-loading")).not.toBeInTheDocument());
  }

  it("打开报告页：发 get_plan_run；头部 #N mono+日期+裁决句；无浮层那一套", async () => {
    await openReport();
    expect(calls.find((c) => c.action === "get_plan_run"))
      .toMatchObject({ action: "get_plan_run", run_key: "rk-1" });
    // 成页 = 没有遮罩、没有 aria-modal、没有 ✕：读几分钟的长文不该被焦点圈禁。
    // （抽屉壳本身仍在、仍会给这几样 —— 反向钉在 tests/case-drilldown.test.tsx
    //   的 openInDrawer，那边挂 ReportDrawer 时这些 testid 是真出现的。）
    expect(screen.getByTestId("page-report")).toBeInTheDocument();
    expect(screen.queryByTestId("report-drawer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("report-drawer-mask")).not.toBeInTheDocument();
    expect(screen.queryByTestId("report-drawer-close")).not.toBeInTheDocument();
    // 头部：#4（最新 run，共 4 条）+ 日期 + 裁决句（ADR-0014：徽章排废除）
    // 锚点数据≠断言数据：openReport 等的是 report-drawer-loading 消失，那盯的是
    // get_plan_run（run 详情）；而 `#N` 的 seq 出自**另一个查询** —— ReportView.tsx:98
    // 的 runNeighbors(runs, runKey)（:68 `runs.length - idx`），列表慢一拍时 :248 的
    // `seq != null &&` 让整个 #N 不上屏。所以 seq 那半自己等（日期同源于 runs 摘要，
    // 排在 waitFor 之后即可）。
    await waitFor(() =>
      expect(screen.getByTestId("report-drawer-runid")).toHaveTextContent("#4"));
    expect(screen.getByTestId("report-drawer-runid")).toHaveTextContent("2026-08-11 09:00");
    // 本夹具两个环节都是**摘要形态**（无逐行明细）⇒ 裁决句走摘要退路：
    // 回归 pass_rate 0.75 < 1 ⇒ 「回归通过率 75%」（有明细时会说「N/M 没过」）。
    // 不许因为读不到行就说「全部过线」——那是把「没有明细」说成「没问题」。
    const verdict = screen.getByTestId("report-verdict");
    expect(verdict).toHaveTextContent("回归通过率 75%");
    expect(verdict).toHaveClass("is-bad");
    // 元信息行：耗时│触发│成本（Δ 较上次随 ADR-0014 下线）
    const meta = screen.getByTestId("report-drawer-meta");
    expect(meta).toHaveTextContent("1m14s");
    expect(meta).toHaveTextContent("手动触发");
    expect(meta).toHaveTextContent("$0.31");
    expect(screen.queryAllByTestId("report-drawer-delta")).toHaveLength(0);
    // 页头的 meta 位挂着这份报告的身份 —— 也就是要发给同事的链接里那一段
    expect(screen.getByTestId("report-head-key")).toHaveTextContent("rk-1");
  });

  it("version chip 与「与上次对比」常态不挂通用解释 title（删句双钉：版面无+title 无）", async () => {
    // 2026-08-30 无废话终裁：原 title「本次运行时的版本标签（运行时快照）」与
    // 「与上一次运行并排对比（逐量纲指标 + 用例三桶）」对任何 run 一字不差成立
    // = 使用文档，整个删。置灰原因（状态数据）另有用例钉着（run-compare 侧）。
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key, agent_version_label: "v1.2",
    }];
    await openReport();
    const chip = screen.getByTestId("report-drawer-version");
    expect(chip).toHaveTextContent("v1.2");
    expect(chip.getAttribute("title")).toBeNull();
    const cmp = screen.getByTestId("report-drawer-compare");
    expect(cmp).toBeEnabled();
    expect(cmp.getAttribute("title")).toBeNull();
  });

  it("裁决句非终态两档：error→「失败」；skipped→带 skip_reason 原话", async () => {
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key, status: "error",
      overview: {}, plan_synthesis: null, synthesis_sections: [],
    }];
    await openReport("rk-4");
    expect(screen.getByTestId("report-verdict")).toHaveTextContent("失败");
    cleanup();

    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key, status: "skipped",
      overview: {}, plan_synthesis: null, synthesis_sections: [],
      skip_reason: "无新增线上会话",
    }];
    installFetch();
    await openReport("rk-3");
    expect(screen.getByTestId("report-verdict"))
      .toHaveTextContent("跳过 · 无新增线上会话");
  });

  it("全量表按环节分组：组头 = 环节名 + 该环节聚合数 + 数据集/评估器注记", async () => {
    await openReport();
    // 旧「① 本次运行的环节」标题区已下线（ADR-0014）：环节改作表的组头
    expect(screen.queryAllByTestId("report-drawer-stages")).toHaveLength(0);
    const g0 = screen.getByTestId("report-group-0-head");
    expect(g0).toHaveTextContent("线上评估");
    expect(g0).toHaveTextContent("12 会话");
    expect(g0).toHaveTextContent("本环节均分 0.86");
    const g1 = screen.getByTestId("report-group-1-head");
    expect(g1).toHaveTextContent("回归测试");
    // 真形态只有 pass_rate（后端 dataset 环节没有 passed 键）
    expect(g1).toHaveTextContent("通过率 75%");
    expect(g1).toHaveTextContent("faq-v3");
    expect(g1).toHaveTextContent("correctness");
  });

  it("empty 环节：组头走「无数据」+ 原因灰字（半截数字不是结论）", async () => {
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key,
      stages: [{ type: "observe", status: "empty", error: "最近 30 天没有可评估的会话" }],
    }];
    await openReport();
    const g0 = screen.getByTestId("report-group-0-head");
    expect(g0).toHaveClass("is-empty");
    expect(g0).toHaveTextContent("无数据");
    expect(g0).toHaveTextContent("最近 30 天没有可评估的会话");
  });

  // 改进处方区（ImprovementBlock）已随 ADR-0014 §6 移出报告 ——「本次建议」区
  // （RunAdvice）顶替了那个位置；组件本体待迁评估分析页，行为由
  // tests/improvement-proposals.test.tsx 直挂覆盖。这里留**负钉**：那批 testid
  // 一个都不许回来（只卸挂载不留钉，等于给「悄悄挂回去」留了门）。
  // 量词钉（queryAllBy… → 0）而不是 queryBy…：单数写法在选择器写错时也返回
  // null，恒绿。
  it("旧改进处方区不再挂在报告里；默认桩无行级诊断 → 本次建议区也整块缺席", async () => {
    await openReport();
    for (const id of [
      "report-drawer-improve", "report-drawer-improve-gen",
      "report-drawer-improve-empty", "report-drawer-adoption-note",
    ]) {
      expect(screen.queryAllByTestId(id), id).toHaveLength(0);
    }
    // RUN_DETAIL 的环节是终帧形态、没有行级诊断 → 没有条目就没有区（含
    // 「本次建议」标题——空区块 = 废话）。有条目的正路在 tests/run-advice.test.tsx。
    expect(screen.queryAllByTestId("run-advice")).toHaveLength(0);
    expect(screen.getByTestId("report-page-card").textContent).not.toContain("本次建议");
  });

  /** 旧「② 综合报告」四段（整体趋势/反复出现的问题/改进采纳效果/当前优先建议）、
   *  它的 sticky 锚点条与字数计数、以及正文里的 [run:#N] / [case:…] / [session:…]
   *  引用层，全部随 ADR-0014 下线（跨 run 内容归评估分析页）。这里留一条**负钉**：
   *  那批 testid 一个都不许回来 —— 只删实现不留钉，等于给「悄悄改回去」留了门。 */
  it("旧综合报告区全下线：分节 / 锚点条 / 溯源 chip 一个 testid 都不在", async () => {
    await openReport();
    for (const id of [
      "report-part-synthesis", "report-part-drills", "report-drawer-nav",
      "report-drawer-sec-0", "report-drawer-src", "report-drawer-advices",
      "report-drawer-list", "report-drawer-empty",
    ]) {
      expect(screen.queryAllByTestId(id), id).toHaveLength(0);
    }
    // 四段的标题词也不在版面上（默认桩的 synthesis_sections 就是那四段）
    const card = screen.getByTestId("report-page-card");
    for (const t of ["整体趋势", "反复出现的问题", "改进采纳效果", "当前优先建议"]) {
      expect(card.textContent, t).not.toContain(t);
    }
  });

  it("← → 切换相邻 run：左=更早，右=更新；头部箭头同功能且到端点禁用", async () => {
    await openReport("rk-2"); // #3
    // 同上：进场那一刻的 #N 出自运行历史查询，不在 openReport 的门槛里
    await waitFor(() =>
      expect(screen.getByTestId("report-drawer-runid")).toHaveTextContent("#3"));
    // ← 更早：rk-3。**锚点纪律**：等的必须是断言同源的事实 —— 这里断言的是
    // 「切过去以后确实去拉了 rk-3 的报告」，那就等 calls 里出现那一次调用。
    // 此前等的是 DOM 的 report-drawer-runid 变 #2（切换瞬间由前端下标现算即成立，
    // 比抓取记录早一拍），满载时 ≈1/3 偶发红（plan-test-drawer-nav-flake 档）。
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(calls.some((c) => c.action === "get_plan_run" && c.run_key === "rk-3")).toBe(true));
    expect(screen.getByTestId("report-drawer-runid")).toHaveTextContent("#2");
    // → 两次回到最新 rk-1（#4）。键盘处理器闭包着当前 index，两次 keyDown 连发时
    // 第二次可能仍读到旧 index（少走一步 → 停在 #3），故每步各自等落定。
    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByTestId("report-drawer-runid")).toHaveTextContent("#3"));
    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByTestId("report-drawer-runid")).toHaveTextContent("#4"));
    // 已是最新：→ 无效果，头部「下一个」禁用
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.getByTestId("report-drawer-runid")).toHaveTextContent("#4");
    expect(screen.getByTestId("report-drawer-next")).toBeDisabled();
    expect(screen.getByTestId("report-drawer-prev")).toBeEnabled();
    fireEvent.click(screen.getByTestId("report-drawer-prev"));
    await waitFor(() =>
      expect(screen.getByTestId("report-drawer-runid")).toHaveTextContent("#3"));
  });

  it("无数据 run：中性裁决句「完成 · 无可评估数据」+「查看方案设置」跳编辑器", async () => {
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key, status: "completed",
      // 真形态：环节全 empty 的 run 顶层 score 必为 null（_persist 只在有
      // observe overall_mean 时写分）
      score: null,
      duration_s: 8, triggered_by: "schedule", overview: { cost_usd: 0 },
      stages: [{ type: "observe", status: "empty", error: "最近 30 天没有可评估的会话" }],
      plan_synthesis: "## 整体趋势\n本次运行未取得任何会话。\n\n## 反复出现的问题\n回溯窗口与流量节律不匹配。",
      synthesis_sections: undefined,
    }];
    // ⚠️ 这条的判据落在 **plan_id** 上（跳方案编辑器），而页面的 plan_id 是从
    // run_key 前缀切出来的 —— 所以这一条必须用真形态 run_key（`<plan_id>#<ts>`）。
    // 拿裸 "rk-3" 也能过前面的 badge/提示条断言，只有最后那句 hash 会读成
    // `#/plan/rk-3/edit`：夹具不真实与代码切错前缀**在屏幕上同形**。
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: [{ ...RUNS[2], run_key: "plan-aaa111#rk-3" }],
    }];
    await openReport("plan-aaa111#rk-3");
    // 中性裁决句：不能给绿（绿会读成「跑得很好」）
    const verdict = screen.getByTestId("report-verdict");
    expect(verdict).toHaveTextContent("完成 · 无可评估数据");
    expect(verdict).not.toHaveClass("is-ok");
    expect(verdict).toHaveClass("is-neutral");
    // 「无线上评估均分，不计入趋势」与「管道空转」两条通用警示随 ADR-0014 下线
    // （对所有空 run 一字不差成立 = 使用文档；导出是文档，那边的完整版仍合法，
    //  下面导出用例仍钉着「既不代表通过」在 md 里）。版面无 + title 无双钉。
    const card = screen.getByTestId("report-page-card");
    expectProseGone(card, "不计入趋势", "管道空转", "既不代表通过");
    expect(screen.queryAllByTestId("report-drawer-nodata-meta")).toHaveLength(0);
    expect(screen.queryAllByTestId("report-drawer-note")).toHaveLength(0);
    // 「为什么没有数据」仍在原位：组头的后端原话
    expect(screen.getByTestId("report-group-0-head"))
      .toHaveTextContent("最近 30 天没有可评估的会话");
    // 底部：查看 trace 换成查看方案设置
    expect(screen.queryByTestId("report-drawer-trace")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("report-drawer-settings"));
    expect(location.hash).toBe("#/plan/plan-aaa111/edit");
  });

  // UI-025：环节炸掉不许被「完成」或「空转」吞掉。夹具照线上实拍
  // plan-8c7b6ad3cd5d#20260824090808（红队环节 DDB PutItem 超限）。
  it("部分失败 run：裁决句先说哪一环炸了 + 组头带原话 + 保留查看 trace", async () => {
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key,
      stages: [
        { type: "observe", evaluators: ["helpfulness"], overall_mean: 0.86, sessions: 12, status: "completed" },
        { type: "redteam", status: "error", breached: 0, attacks: 0, verdict: null,
          error: "ValidationException: Item size has exceeded the maximum allowed size" },
      ],
    }];
    await openReport();
    // 裁决句第一段就是失败环节（它比任何行级数字都先说）
    const verdict = screen.getByTestId("report-verdict");
    expect(verdict).toHaveTextContent("红队测试环节执行失败");
    expect(verdict).toHaveClass("is-bad");
    // 「管道空转」那条通用提示条只属于 no-data，且已随 ADR-0014 整体下线
    expect(screen.queryAllByTestId("report-drawer-note")).toHaveLength(0);
    expect(screen.queryAllByTestId("report-drawer-fail-note")).toHaveLength(0);
    // 失败环节的组头带档位 + error 原文（原话不许被吞——线上真跑成过
    // 「红队测试 攻破 0/0」+ 注记空白；详细形态覆盖在 tests/error-note.test.tsx）
    const g1 = screen.getByTestId("report-group-1-head");
    expect(g1).toHaveClass("is-failed");
    expect(g1).toHaveTextContent(
      "ValidationException: Item size has exceeded the maximum allowed size");
    expect(g1.querySelector(".gnote")).toHaveAttribute(
      "title", "ValidationException: Item size has exceeded the maximum allowed size");
    // 部分失败不是 no-data：底部仍是查看 trace，不换「查看方案设置」
    expect(screen.getByTestId("report-drawer-trace")).toBeInTheDocument();
    expect(screen.queryByTestId("report-drawer-settings")).not.toBeInTheDocument();
  });

  it("底部操作条：导出报告数据到齐即可点；查看 trace 跳 #/run/:runKey", async () => {
    await openReport();
    // UI-011 前这里是硬 disabled 的死按钮；现在数据到齐就该能点
    expect(screen.getByTestId("report-drawer-export")).toBeEnabled();
    fireEvent.click(screen.getByTestId("report-drawer-trace"));
    expect(location.hash).toBe(`#/run/${encodeURIComponent("rk-1")}`);
  });

  /** 综合报告整块随 ADR-0014 下线 ⇒ 它的生成失败原话也不上屏了（那是跨 run 那
   *  一块的事）。**但不许悄悄吞掉**：导出仍如实写「综合报告生成失败：judge 超时」
   *  （下面导出那条钉着）。这里是屏幕侧的负钉 + 表照常渲染的正证据。 */
  it("synthesis_error：不上屏（综合报告已下线），全量表照常渲染", async () => {
    overrides.get_plan_run = (p) => [{
      ...RUN_DETAIL, run_key: p.run_key,
      plan_synthesis: null, synthesis_sections: [], synthesis_error: "judge 超时",
    }];
    await openReport();
    expect(screen.queryAllByTestId("report-drawer-synthesis-error")).toHaveLength(0);
    expect(screen.getByTestId("report-page-card").textContent).not.toContain("judge 超时");
    expect(screen.getByTestId("report-group-0-head")).toHaveTextContent("线上评估");
  });

  // 这一条量的是**方案页那一面的动线**（点了会去哪儿），所以它留在方案页上挂。
  it("点「查看报告」去独立报告页：不插行内报告、按钮文案不变、方案页不冒浮层", async () => {
    renderDetail();
    const table = await screen.findByTestId("plan-runs-table");
    fireEvent.click(within(table).getByTestId("plan-run-row-rk-1-report"));
    // 动线判据落在 URL：报告要能加书签、能后退回运行列表、能把链接发给同事
    // （用户原话：抽屉「很多字但只有一半屏幕能看」）。run_key 自带 "#" ⇒ 必是 %23。
    expect(location.hash).toBe(`#/report/${encodeURIComponent("rk-1")}`);
    // 一个按钮只有一种去处：方案页里不许同时再开一个报告浮层
    expect(screen.queryByTestId("report-drawer-head")).not.toBeInTheDocument();
    // 也不留上一代的行内展开残留
    expect(screen.queryByTestId("plan-run-row-rk-1-report-row")).not.toBeInTheDocument();
    const btn = screen.getByTestId("plan-run-row-rk-1-report");
    expect(btn).toHaveTextContent("查看报告");
    expect(btn).not.toHaveAttribute("aria-expanded");
    // 行数不变（4 条 run = 4 行）
    expect(within(table).getAllByTestId(/^plan-run-row-rk-\d$/)).toHaveLength(4);
  });

  // ---- 线上实测形态哨兵（报告抽屉侧的回归对照）----
  //
  // 报告抽屉本来就是对的（防御式契约：stages?/stage_summaries? 双收、overview
  // 宽类型、plan 字段平铺），线上实测也确认它好。contract-fix 这批动了
  // plan/types.ts（补顶层 score 声明）与 ReportDrawer.scoreOf（改用
  // derive.reportScore），所以必须验它**没被改坏**。
  // 形态取自 .scratch/contract-fix-prep/C-2-real-shape.md 的冻结快照。
  it("真实线上形态（24 键 / 无 stages / 无 plan / overview 仅两子键）：报告仍好", async () => {
    overrides.get_plan_run = (p) => [{
      event: "plan_run",
      run_key: p.run_key, sk: p.run_key,
      plan_id: "plan-aaa111", plan_name: "test111", agent_name: "support-bot",
      status: "completed", score: 0.78, triggered_by: "manual",
      started_at: "2026-08-20 15:57 UTC", finished_at: "2026-08-20 15:58 UTC",
      started_epoch: 1787241438, finished_epoch: 1787241502,
      duration_s: 64, total_cost_usd: 0.09,
      // overview 恰为两个子键（无 score/cases/passed/cost_usd）
      overview: {
        previous_run: null,
        stage_lines: [{ type: "observe", status: "completed", text: "评估 1 个会话，均分 0.78" }],
      },
      // 真名 stage_summaries；没有 stages 键
      stage_summaries: [
        { type: "observe", status: "completed", overall_mean: 0.78, sessions: 1, summary: {} },
      ],
      s3_key: "planruns/x.json", proposals: [],
      plan_synthesis: "首个数据点，暂无趋势可言。",
      synthesis_error: null,
      synthesis_sections: [{ title: "整体趋势", body: "首个数据点，暂无趋势可言。" }],
      skip_reason: null, report: null,
    }];
    await openReport();
    // 报告渲染得出、裁决句算得出（这个 run 一个失败都没有 ⇒ 全过）
    expect(screen.getByTestId("report-verdict")).toHaveTextContent("全部过线");
    // 不能被误判成「无数据 run」（那会给中性口径 + 换「查看方案设置」）
    expect(screen.getByTestId("report-verdict")).not.toHaveTextContent("无可评估数据");
    expect(screen.getByTestId("report-drawer-trace")).toBeInTheDocument();
    // 成本走顶层 total_cost_usd
    expect(screen.getByTestId("report-drawer-meta")).toHaveTextContent("$0.09");
    // 环节分组读 stage_summaries（真后端字段名）+ 分数从**顶层 score** 读到
    // （不是 overview.score —— 真后端没有那个键）
    const g0 = screen.getByTestId("report-group-0-head");
    expect(g0).toHaveTextContent("线上评估");
    expect(g0).toHaveTextContent("本环节均分 0.78");
    // 绝不出现对象直渲。「整份报告」这个范围在页面上是那张卡 —— 找不到容器与
    // 「没有对象直渲」在断言里同形，所以先钉住容器真在，再拿它的 textContent 说话。
    const card = screen.getByTestId("report-page-card");
    expect(card).toHaveTextContent("线上评估");
    expect(card.textContent).not.toContain("[object Object]");
  });

  // ---------- UI-011：导出报告（Markdown） ----------
  describe("导出报告", () => {
    /** jsdom 的 Blob 没有 .text()（只有浏览器/undici 有）——走 FileReader 读回正文 */
    function readBlob(b: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(fr.error ?? new Error("Blob 读取失败"));
        fr.readAsText(b);
      });
    }

    /** 下载边界打桩：真实浏览器下载行为不可测，拦 createObjectURL + a.click。
     *  返回的 grab() 读出实际被下载的文件名与正文（Blob 文本）。 */
    function stubDownload() {
      const blobs: Blob[] = [];
      const names: string[] = [];
      const origCreate = URL.createObjectURL;
      const origRevoke = URL.revokeObjectURL;
      URL.createObjectURL = vi.fn((b: Blob) => {
        blobs.push(b);
        return "blob:mock-url";
      }) as unknown as typeof URL.createObjectURL;
      URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(function (this: HTMLAnchorElement) {
          names.push(this.download);
        });
      return {
        restore() {
          URL.createObjectURL = origCreate;
          URL.revokeObjectURL = origRevoke;
          clickSpy.mockRestore();
        },
        count: () => names.length,
        async grab() {
          expect(names).toHaveLength(1);
          return { name: names[0], md: await readBlob(blobs[0]), type: blobs[0].type };
        },
      };
    }

    /** 点导出 → 等下载真的发生（等条件不等次数：锚点是「文件被 click 了」） */
    async function clickExport(dl: ReturnType<typeof stubDownload>) {
      // 常态可点时 title 必须为 null：原「下载本次运行报告（Markdown）」是功能
      // 说明书（2026-08-30 无废话终裁：删）；被禁用时的原因 title 另有用例。
      expect(screen.getByTestId("report-drawer-export").getAttribute("title")).toBeNull();
      fireEvent.click(screen.getByTestId("report-drawer-export"));
      await waitFor(() => expect(dl.count()).toBe(1));
    }

    it("成功下载：文件名含方案名与运行时间；正文含元数据/环节/综合结论", async () => {
      const dl = stubDownload();
      try {
        await openReport();
        await clickExport(dl);
        const { name, md, type } = await dl.grab();
        // 验收 2：文件名含方案名 + 运行时间
        expect(name).toBe("运行报告-FAQ-周回归-2026-08-11-0900.md");
        expect(type).toContain("text/markdown");
        // 验收 3：运行元数据
        expect(md).toContain("# 运行报告 · FAQ 周回归");
        expect(md).toContain("- 评估计划：FAQ 周回归");
        expect(md).toContain("- 运行：#4 · `rk-1`");
        expect(md).toContain("- 开始时间：2026-08-11 09:00");
        expect(md).toContain("- 耗时：1m14s");
        expect(md).toContain("- 触发方式：手动");
        expect(md).toContain("- 成本：$0.31");
        expect(md).toContain("- 结果：完成 · 线上评估均分 0.86");
        // 验收 3：环节结果——数字与界面同源（stageNumbers），后端给什么写什么
        // （夹具已改 _stage_summary 真键：observe→overall_mean、dataset→pass_rate；
        //   后端没有 passed/环节 score，「通过 X/Y」「本环节均分 0.75」不会再出现）
        expect(md).toContain("- **线上评估**：12 会话 · 本环节均分 0.86 — helpfulness");
        expect(md).toContain("- **回归测试**：通过率 75% — faq-v3 · correctness");
        // 验收 3：综合结论四节
        expect(md).toContain("### 整体趋势");
        expect(md).toContain("均分从 0.74 升至 0.88");
        expect(md).toContain("### 当前优先建议");
        expect(md).toContain("补充「账户安全」知识库条目。");
        // 诚实口径：不许出现后端没给的推算数字，也不许把无分写成 0
        expect(md).not.toContain("无可评估数据");
        // 导出不额外打接口（只用已加载数据）
        expect(calls.filter((c) => c.action === "get_plan_run")).toHaveLength(1);
      } finally {
        dl.restore();
      }
    });

    it("方案名含中文/空格/斜杠：文件名安全化，中文保留、斜杠不成路径", async () => {
      overrides.get_plan_run = (p) => [{
        ...RUN_DETAIL, run_key: p.run_key, plan_name: "FAQ 周回归 / v3:候选*",
      }];
      const dl = stubDownload();
      try {
        await openReport();
        await clickExport(dl);
        const { name } = await dl.grab();
        expect(name).toBe("运行报告-FAQ-周回归-v3-候选-2026-08-11-0900.md");
        expect(name).not.toContain("/");
        expect(name).not.toContain(":");
        expect(name).not.toContain("*");
      } finally {
        dl.restore();
      }
    });

    it("空数据报告（completed 无分）：中性表述，不写 0 分也不写「跑得很好」", async () => {
      overrides.get_plan_run = (p) => [{
        ...RUN_DETAIL, run_key: p.run_key, status: "completed",
        score: null, overview: {}, total_cost_usd: null, duration_s: 8,
        triggered_by: "schedule",
        stages: [{ type: "observe", status: "empty", error: "最近 30 天没有可评估的会话" }],
        plan_synthesis: null, synthesis_sections: [], synthesis_error: null,
      }];
      const dl = stubDownload();
      try {
        // 锚点：中性裁决句到位才说明这条无分数据真的灌进来了
        await openReport("rk-3");
        await waitFor(() => expect(screen.getByTestId("report-verdict"))
          .toHaveTextContent("完成 · 无可评估数据"));
        await clickExport(dl);
        const { md } = await dl.grab();
        expect(md).toContain("- 结果：完成 · 无可评估数据（本次运行不计入线上评估均分与趋势）");
        expect(md).toContain("本次评估管道空转");
        expect(md).toContain("既不代表通过，也不代表退步");
        // 空环节如实写原因，不编数字
        expect(md).toContain("- **线上评估**：无数据（最近 30 天没有可评估的会话）");
        expect(md).toContain("本次运行没有综合报告。");
        // 绝不出现 0 分 / 满分冒充。⚠️ 守卫词随「总分」改名迁到「线上评估均分」，
        // 且必须带数字（`\d`）：中性表述里本来就有「不计入线上评估均分与趋势」
        // 这句话，光断言词不出现会让这条守卫永真、静默解除（UI-025 家族）。
        expect(md).not.toMatch(/线上评估均分 0\.00/);
        expect(md).not.toMatch(/线上评估均分 \d/);
        expect(md).toContain("- 成本：—");
      } finally {
        dl.restore();
      }
    });

    it("部分失败 run：结果行与 badge 同刑「部分失败 · 红队测试」，失败引文替代空转", async () => {
      overrides.get_plan_run = (p) => [{
        ...RUN_DETAIL, run_key: p.run_key,
        stages: [
          { type: "observe", evaluators: ["helpfulness"], overall_mean: 0.86, sessions: 12, status: "completed" },
          { type: "redteam", status: "error", breached: 0, attacks: 0, verdict: null,
            error: "ValidationException: Item size has exceeded the maximum allowed size" },
        ],
      }];
      const dl = stubDownload();
      try {
        await openReport();
        await waitFor(() => expect(screen.getByTestId("report-verdict"))
          .toHaveTextContent("红队测试环节执行失败"));
        await clickExport(dl);
        const { md } = await dl.grab();
        // 「结果」行走 outcome.label（与 badge 同一份）——不许写成「完成」
        expect(md).toContain("- 结果：部分失败 · 红队测试 · 线上评估均分 0.86");
        expect(md).toContain("> 红队测试环节执行失败。其余环节的结果可用");
        expect(md).not.toContain("管道空转");
        // 失败环节写原因，不写假数字
        expect(md).toContain("- **红队测试**：执行失败（ValidationException: Item size has exceeded the maximum allowed size）");
      } finally {
        dl.restore();
      }
    });

    it("失败状态：error run 写「失败」；synthesis_error 与 report_error 如实写进导出", async () => {
      overrides.get_plan_run = (p) => [{
        ...RUN_DETAIL, run_key: p.run_key, status: "error", score: null,
        overview: {}, total_cost_usd: null,
        stages: [{ type: "dataset", status: "error", dataset: "faq-v3", error: "Agent 调用超时" }],
        plan_synthesis: null, synthesis_sections: [], synthesis_error: "judge 超时",
        s3_key: "planruns/x.json", report_error: "完整报告读取失败（摘要仍可用）",
      }];
      const dl = stubDownload();
      try {
        await openReport("rk-4");
        await waitFor(() => expect(screen.getByTestId("report-verdict"))
          .toHaveTextContent("失败"));
        await clickExport(dl);
        const { md } = await dl.grab();
        expect(md).toContain("- 结果：失败");
        // report 读不到 → 开头警示 + 页脚来源如实标注
        expect(md).toContain("**注意**：完整报告读取失败（摘要仍可用）——以下仅为运行摘要。");
        expect(md).toContain("运行摘要（完整报告读取失败）");
        // synthesis_error 不吞
        expect(md).toContain("综合报告生成失败：judge 超时");
        // 失败环节写失败原因，不写假数字
        expect(md).toContain("- **回归测试**：执行失败（Agent 调用超时）");
      } finally {
        dl.restore();
      }
    });

    it("导出失败：可感知错误（错误行 + 按钮恢复可点，不静默）", async () => {
      const dl = stubDownload();
      // 造 DOM 边界爆炸：createObjectURL 抛
      URL.createObjectURL = vi.fn(() => {
        throw new Error("Blob 创建失败");
      }) as unknown as typeof URL.createObjectURL;
      try {
        await openReport();
        fireEvent.click(screen.getByTestId("report-drawer-export"));
        // 验收 4：错误可感知
        await waitFor(() => expect(screen.getByTestId("report-drawer-export-error"))
          .toHaveTextContent("导出失败：Blob 创建失败"));
        // 验收 4：只在忙碌期间禁用——失败后按钮回到可点
        expect(screen.getByTestId("report-drawer-export")).toBeEnabled();
      } finally {
        dl.restore();
      }
    });

    it("数据未就绪不导出空壳：加载中/查询失败按钮禁用并说明原因", async () => {
      // 查询失败：get_plan_run 返 error 事件
      overrides.get_plan_run = () => [{ event: "error", error: "DDB 读失败" }];
      const dl = stubDownload();
      try {
        // 不能用 openReport()：它等的是「加载态退场」，而这条要的正是错误态 ——
        // 门槛与判据同源会让它在两种成因下都绿（报告到齐 / 报告炸了）。
        render(
          <QueryClientProvider client={newQc()}>
            <ReportPage id="rk-1" />
          </QueryClientProvider>,
        );
        // 锚点：查询错误行渲染出来才说明 isError 已成立
        await screen.findByTestId("report-drawer-error");
        const btn = screen.getByTestId("report-drawer-export");
        expect(btn).toBeDisabled();
        expect(btn).toHaveAttribute("title", expect.stringContaining("无法导出"));
        // 点也不该产出任何文件
        fireEvent.click(btn);
        expect(dl.count()).toBe(0);
      } finally {
        dl.restore();
      }
    });
  });
});

// ==================== M3：run_plan 流式（进度日志卡） ====================

/** 手动挡 run_plan 流：逐帧推，页面能看到中间进度
 *
 * 控制器必须在 install 时就绪，不能等 run_plan 那次 fetch 才赋值：进度卡在点击
 * 「运行」的同步阶段就渲染（phase=running 先于 fetch 落地），测试等到
 * plan-run-progress 后立刻 stream.close() 时，异步的 fetch 体可能还没跑，
 * closeStream 仍是 undefined → 满载下偶发 TypeError。故流与控制器在此同步建好，
 * fetch 只负责把它包成 Response。 */
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
    return sseResponse(await handler(payload));
  }));
  return {
    push: (ev: unknown) => pushFrame(ev),
    close: () => closeStream(),
    fail: (err: Error) => failStream(err),
  };
}

const logLines = () =>
  within(screen.getByTestId("plan-run-progress-log")).queryAllByRole("listitem");

describe("进度日志映射（logEntryOf 纯函数）", () => {
  it("heartbeat / turn / attack_turn 不进日志（heartbeat 只养活性时间戳）", () => {
    expect(logEntryOf({ event: "heartbeat", plan_id: "p" })).toBeNull();
    expect(logEntryOf({ event: "turn", run_id: "r" })).toBeNull();
    expect(logEntryOf({ event: "attack_turn", run_id: "r" })).toBeNull();
    expect(logEntryOf({ event: "plan_run_report" })).toBeNull();
  });

  it("session_result → 短 id + 本会话均分；session_error → 错误行（kind=bad）", () => {
    const ok = logEntryOf({
      event: "session_result", session_id: "sess-abcdef123456789",
      results: { helpfulness: { score: 0.9 }, coherence: { score: 0.7 } },
    })!;
    expect(ok.kind).toBe("good");
    // vocab-guard（D-8）迁词：这一格是**一条会话**的均值，同屏还有「本环节均分」
    // 与「线上评估均分」，裸词分不出量纲（CONTEXT.md「线上评估均分」词条）
    // 短 id = 首段 8 位 hex（批 fmt-converge 收敛到 lib/text；旧值 "sess-abcdef1…"）
    expect(ok.text).toBe("会话 abcdef12 评分完成 · 本会话均分 0.80");
    // 量词钉：上面那条 toBe 已把整句钉死，这里再钉「裸词 + 数字」的旧形态不复现
    //（不带数字的否定断言会被「本会话均分」自身包含而恒真）
    expect(ok.text).not.toMatch(/·\s*均分 0\.80/);
    // errored 评估器（score:null）不计入均分；全 null → 无可评分项
    const blank = logEntryOf({
      event: "session_result", session_id: "s1",
      results: { helpfulness: { score: null } },
    })!;
    expect(blank.text).toBe("会话 s1 评分完成 · 无可评分项");
    const bad = logEntryOf({ event: "session_error", session_id: "s2", error: "trace 拉取失败" })!;
    expect(bad.kind).toBe("bad");
    expect(bad.text).toBe("会话 s2 评分失败：trace 拉取失败");
  });

  it("后端 stage_start/stage_done（序号+type/summary）→ 环节行；empty/error 环节区分", () => {
    expect(logEntryOf({ event: "stage_start", stage: 1, type: "observe", total_stages: 2 })!.text)
      .toBe("环节 1/2 · 线上评估：执行中");
    const done = logEntryOf({
      event: "stage_done", stage: 2,
      summary: { type: "dataset", status: "completed", pass_rate: 0.75, cases: 4 },
    })!;
    expect(done.kind).toBe("good");
    // 回归环节给的是**通过率**（0-1 比例），不是分数：印成两位小数会与线上评估
    // 均分同形，用户把「完成（0.00）」读成「Agent 全答错」（档
    // stage-line-shows-pass-rate-as-score）。文案与方案详情/抽屉同一个函数。
    expect(done.text).toBe("环节 2 · 回归测试：完成（通过率 75%）");
    expect(done.text).not.toContain("0.75");
    // 0% 通过是结论（要显示）；没给通过率则整段括号不出（绝不用 0 顶）
    expect(logEntryOf({
      event: "stage_done", stage: 2,
      summary: { type: "dataset", status: "completed", pass_rate: 0, cases: 4 },
    })!.text).toBe("环节 2 · 回归测试：完成（通过率 0%）");
    expect(logEntryOf({
      event: "stage_done", stage: 2,
      summary: { type: "dataset", status: "completed", cases: 4 },
    })!.text).toBe("环节 2 · 回归测试：完成");
    // 另两类量纲各走各的（observe 两位小数不变，redteam 攻破 x/y）
    expect(logEntryOf({
      event: "stage_done", stage: 1,
      summary: { type: "observe", status: "completed", overall_mean: 0.88, sessions: 2 },
    })!.text).toBe("环节 1 · 线上评估：完成（0.88）");
    expect(logEntryOf({
      event: "stage_done", stage: 3,
      summary: { type: "redteam", status: "completed", breached: 0, attacks: 12 },
    })!.text).toBe("环节 3 · 红队测试：完成（攻破 0/12）");
    expect(logEntryOf({
      event: "stage_done", stage: 1,
      summary: { type: "observe", status: "empty", error: "最近 30 天没有可评估的会话" },
    })!.text).toBe("环节 1 · 线上评估：无数据（最近 30 天没有可评估的会话）");
    expect(logEntryOf({
      event: "stage_done", stage: 1,
      summary: { type: "redteam", status: "error", error: "boom" },
    })!.kind).toBe("bad");
  });

  it("综合报告事件：synthesis_start/done 两态", () => {
    expect(logEntryOf({ event: "synthesis_start" })!.text).toBe("生成综合报告…");
    expect(logEntryOf({ event: "synthesis_done", ok: true })!.kind).toBe("good");
    const failed = logEntryOf({ event: "synthesis_done", ok: false, error: "judge 超时" })!;
    expect(failed.kind).toBe("bad");
    expect(failed.text).toContain("judge 超时");
  });
});

// ==================== 缺陷 2：发起运行必须二次确认 ====================
// 四处入口（工作台方案行 / 方案详情页头 / Agent 详情方案行 / Agent 详情页头
// 「运行最新方案」）此前都是点一下直接花真钱。确认卡复用 ConfirmCard，
// 卡上给 estimate_plan_run 的预估费用。
describe("发起运行二次确认", () => {
  it("点运行只开卡：不发 run_plan；卡上有方案名与预估费用", async () => {
    renderDetail();
    await screen.findByTestId("plan-name");
    fireEvent.click(screen.getByTestId("plan-run"));
    const card = screen.getByTestId("confirm-card");
    expect(card).toHaveAttribute("aria-label", "发起运行");
    expect(card).toHaveTextContent("FAQ 周回归");
    expect(calls.filter((c) => c.action === "run_plan")).toHaveLength(0);
    // 锚点挑目标数据专属：预估格里的真数字（DEFAULTS.estimate_plan_run
    // 的 estimated_cost_usd=0.42），不是「运行」这类通用文案
    await waitFor(() =>
      expect(screen.getByTestId("run-confirm-cost")).toHaveTextContent("$0.42"));
    // 环节链走术语五词（estimate.stages 的 type → 中文名），让用户看清要跑什么
    expect(screen.getByTestId("run-confirm-stages"))
      .toHaveTextContent("线上评估 + 回归测试");
    // 进度卡也不许提前出现（那会让用户以为已经在跑）
    expect(screen.queryByTestId("plan-run-progress")).not.toBeInTheDocument();
  });

  it("危险花钱动作默认焦点落「取消」，取消后不发 run_plan", async () => {
    renderDetail();
    await screen.findByTestId("plan-name");
    fireEvent.click(screen.getByTestId("plan-run"));
    expect(document.activeElement).toBe(screen.getByTestId("confirm-card-cancel"));
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.action === "run_plan")).toHaveLength(0);
  });

  it("确认后才真跑：发 run_plan + 出进度卡", async () => {
    renderDetail();
    await screen.findByTestId("plan-name");
    clickRunAndConfirm();
    await waitFor(() =>
      expect(calls.some((c) => c.action === "run_plan" && c.plan_id === "plan-aaa111")).toBe(true));
    await screen.findByTestId("plan-run-progress");
  });

  it("预估在途：费用格显示「预估中…」，卡照样能开（确认不被预估卡住）", async () => {
    overrides.estimate_plan_run = () => new Promise<unknown[]>(() => {});
    renderDetail();
    await screen.findByTestId("plan-name");
    fireEvent.click(screen.getByTestId("plan-run"));
    expect(screen.getByTestId("run-confirm-cost")).toHaveTextContent("预估中…");
    expect(screen.getByTestId("confirm-card-ok")).toBeEnabled();
  });

  it("预估失败照实透出错误，不假装 $0.00（后端同一道闸门：方案不存在 / Agent 无日志）", async () => {
    // 真后端形态：app/main.py:1404-1412 对 estimate_plan_run 与 run_plan
    // 用的是同一段前置校验，预估报什么错运行就会报什么错
    overrides.estimate_plan_run = () => [{
      event: "error", error: "unknown agent or no logs: support-bot",
    }];
    renderDetail();
    await screen.findByTestId("plan-name");
    fireEvent.click(screen.getByTestId("plan-run"));
    await waitFor(() =>
      expect(screen.getByTestId("run-confirm-cost"))
        .toHaveTextContent("unknown agent or no logs: support-bot"));
    expect(screen.getByTestId("run-confirm-cost")).not.toHaveTextContent("$0.00");
  });
});

describe("运行流式", () => {
  it("日志累积不覆盖；heartbeat 不进日志；session_result 行；完成态用时 + 刷新历史+KPI", async () => {
    const NEW_RUN = {
      run_key: "rk-new", status: "completed", score: 0.92,
      started_at: "2026-08-12 10:00", duration_s: 60, triggered_by: "manual",
    };
    let runsCalls = 0;
    overrides.list_plan_runs = (p) => {
      runsCalls += 1;
      return [{
        event: "plan_runs", plan_id: p.plan_id,
        runs: runsCalls > 1 ? [NEW_RUN, ...RUNS] : RUNS,
      }];
    };
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    expect(runsCalls).toBe(1);
    const stream = installManualRunStream();

    clickRunAndConfirm();
    await waitFor(() =>
      expect(calls.some((c) => c.action === "run_plan" && c.plan_id === "plan-aaa111")).toBe(true));
    await screen.findByTestId("plan-run-progress");
    expect(screen.getByTestId("plan-run")).toBeDisabled();
    // 运行中标题行：计时 + 心跳活性指示
    expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent(/运行中 · 已 00:0\d/);
    expect(screen.getByTestId("plan-run-liveness")).toHaveTextContent("链路正常");

    stream.push({ event: "plan_run_started", plan_id: "plan-aaa111", stages: ["observe", "dataset"] });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("运行开始（2 个环节）"));
    stream.push({ event: "stage_start", stage: 1, type: "observe", total_stages: 2 });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("线上评估：执行中"));
    const linesBeforeHeartbeat = logLines().length;
    // heartbeat 不进日志：行数不变（老行为是覆盖成「运行中…」）
    stream.push({ event: "heartbeat", plan_id: "plan-aaa111" });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0)); // 让事件循环跑一拍
    expect(logLines()).toHaveLength(linesBeforeHeartbeat);
    expect(screen.getByTestId("plan-run-progress-log")).not.toHaveTextContent("heartbeat");
    // session_result → 会话行；session_error → 错误行
    stream.push({
      event: "session_result", session_id: "sess-1",
      results: { helpfulness: { score: 0.9 }, coherence: { score: 0.7 } },
    });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log"))
        .toHaveTextContent("会话 sess-1 评分完成 · 本会话均分 0.80"));
    stream.push({ event: "session_error", session_id: "sess-2", error: "trace 拉取失败" });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log"))
        .toHaveTextContent("会话 sess-2 评分失败：trace 拉取失败"));
    stream.push({
      event: "stage_done", stage: 1,
      summary: { type: "observe", status: "completed", overall_mean: 0.88, sessions: 2 },
    });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("线上评估：完成（0.88）"));
    // passrate-zero 现场（整条流跑一遍，不只是纯函数）：回归环节完成行必须说
    // 「通过率」——此前这里是「完成（0.00）」，与上一行的均分 0.88 同形，
    // 用户把它读成「Agent 全答错」。
    stream.push({
      event: "stage_done", stage: 2,
      summary: { type: "dataset", status: "completed", pass_rate: 0, cases: 4, blank_cases: 0 },
    });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log"))
        .toHaveTextContent("回归测试：完成（通过率 0%）"));
    expect(screen.getByTestId("plan-run-progress-log")).not.toHaveTextContent("回归测试：完成（0.00）");
    // 累积不覆盖：老行还在
    expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("线上评估：执行中");
    expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("会话 sess-1 评分完成");
    // 最终报告帧 → 完成态：用时 + 总分；日志保留
    stream.push({
      // 真形态：综合分在**顶层 score**，overview 只有 stage_lines
      event: "plan_run_report", run_key: "rk-new", score: 0.92,
      overview: { stage_lines: [{ type: "observe", status: "completed", text: "评估 2 个会话，均分 0.92" }], previous_run: null },
      stages: [], plan_synthesis: "好", synthesis_error: null, duration_s: 60,
    });
    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status"))
        .toHaveTextContent("运行完成 · 用时 01:00 · 线上评估均分 0.92"));
    expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("线上评估：完成（0.88）");
    // 历史刷新：list_plan_runs 第二次 + 新行出现 + KPI 更新
    await waitFor(() => expect(runsCalls).toBeGreaterThan(1));
    await screen.findByTestId("plan-run-row-rk-new");
    expect(screen.getByTestId("plan-kpi-success")).toHaveTextContent("3/5");
    expect(screen.getByTestId("plan-run")).toBeEnabled();
  });

  // P1（2026-08-24 用户实测）：运行**进行中**打开「运行历史」是空的，被中断的
  // run 也无影无踪。根因在后端（execute_plan_run 只在结束时落一次记录），已改成
  // 开跑先落一条 status="running"；前端这侧要在**首个事件**到达时刷一次历史，
  // 否则那一行要等到 run 结束才出现，等于修了后端界面上还是看不见。
  it("运行中历史就出现 running 行（首个事件即刷一次；只刷一次不打连环请求）", async () => {
    const RUNNING_ROW = {
      run_key: "rk-inflight", status: "running", score: null,
      started_at: "2026-08-24 16:03 UTC", duration_s: null, triggered_by: "manual",
    };
    let runsCalls = 0;
    overrides.list_plan_runs = (p) => {
      runsCalls += 1;
      return [{
        event: "plan_runs", plan_id: p.plan_id,
        // 后端开跑就落库 → 第二次拉取起就带上那条 running 行
        runs: runsCalls > 1 ? [RUNNING_ROW, ...RUNS] : RUNS,
      }];
    };
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    expect(runsCalls).toBe(1);
    expect(screen.queryByTestId("plan-run-row-rk-inflight")).not.toBeInTheDocument();

    const stream = installManualRunStream();
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    // 首个事件（这里是 plan_run_started）到达即刷历史
    stream.push({ event: "plan_run_started", plan_id: "plan-aaa111", stages: ["observe"] });
    // 锚点 = 那一行专属 testid：只有历史真被刷了且带回 running 行才成立
    await screen.findByTestId("plan-run-row-rk-inflight");
    // 运行还在跑（没有终帧），这行就已经看得见了 —— 正是现场缺的那件事
    expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("运行中");
    // 数据形态到位：running 行没有分数/耗时也不崩
    //（badge 文案与孤儿 running 的陈旧判定归 UI-025，这里只保证不炸）
    const row = screen.getByTestId("plan-run-row-rk-inflight");
    expect(row).toBeInTheDocument();

    // **只刷一次**：后面几十条事件不再触发 list_plan_runs
    const callsAfterFirst = runsCalls;
    for (let i = 0; i < 10; i += 1) {
      stream.push({ event: "heartbeat", plan_id: "plan-aaa111" });
    }
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-liveness")).toHaveTextContent("链路正常"));
    expect(runsCalls).toBe(callsAfterFirst);

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("日志折叠：>5 条只露最近 5 条 +「查看全部 N 条」，展开/收起可逆", async () => {
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    const stream = installManualRunStream();
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    // 初始 1 条（已发起运行）+ 7 条会话事件 = 8 条
    for (let i = 0; i < 7; i += 1) {
      stream.push({
        event: "session_result", session_id: `s-${i}`,
        results: { helpfulness: { score: 0.8 } },
      });
    }
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("会话 s-6"));
    expect(logLines()).toHaveLength(5);
    // 最老的（已发起运行 / s-0 / s-1）被折叠
    expect(screen.getByTestId("plan-run-progress-log")).not.toHaveTextContent("会话 s-1 评分完成");
    expect(screen.getByTestId("plan-run-progress-log")).not.toHaveTextContent("已发起运行");
    const expand = screen.getByTestId("plan-run-log-expand");
    expect(expand).toHaveTextContent("查看全部 8 条");
    fireEvent.click(expand);
    expect(logLines()).toHaveLength(8);
    expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("会话 s-0");
    fireEvent.click(screen.getByTestId("plan-run-log-collapse"));
    expect(logLines()).toHaveLength(5);
    stream.close(); // 收尾：等断流兜底态渲染完，避免 act 警告
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("断流兜底：流异常断开 ≠ run 失败——提示后台可能仍在运行 + 用时", async () => {
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    const stream = installManualRunStream();
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    stream.push({ event: "stage_start", stage: 1, type: "observe", total_stages: 1 });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("线上评估：执行中"));
    stream.fail(new Error("network error"));
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status"))
        .toHaveTextContent(/连接中断 · 用时 00:0\d/));
    // 诚实语义：run_plan 是后端任务，前端断流不杀它。
    // ⚠️ UI-029 批 3 改了这句的尾巴：原文「稍后刷新运行历史查看结果」是把用户请出
    // 界面自己刷新的死胡同（SPEC §6 点名撤销）—— 本页现在会自己接手（拿到 run_key
    // 的断流直接转轮询、面板不落这一支；这一支只剩「首帧之前就断」）。
    // 改判重钉（2026-08-30 无废话终裁）：机制解释半句「（前端断流不会杀它）」
    // 对任何断流恒成立 = 使用文档，删；用户此刻要知道的后果（仍在后端继续 /
    // 历史已自动刷新 / 本页会接手）保留。
    expect(screen.getByTestId("plan-run-progress-error"))
      .toHaveTextContent("连接中断，运行仍在后端继续。");
    expect(screen.getByTestId("plan-run-progress-error"))
      .not.toHaveTextContent("前端断流不会杀它");
    expect(screen.getByTestId("plan-run-progress-error"))
      .not.toHaveTextContent("稍后刷新运行历史查看结果");
    // 断流前的日志保留，帮用户判断断在哪一步
    expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("线上评估：执行中");
    expect(screen.getByTestId("plan-run")).toBeEnabled();
  });

  it("流正常关闭但无终帧：同样按断流兜底（链路被掐，不是 run 失败）", async () => {
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    const stream = installManualRunStream();
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
    // 同上：文案尾巴由 UI-029 批 3 换成「本页会恢复进行中面板继续跟」
    expect(screen.getByTestId("plan-run-progress-error"))
      .toHaveTextContent("运行仍在后端继续");
  });

  it("后端 error 事件 = run 真失败：显示原文，不带断流兜底文案，按钮恢复可用", async () => {
    overrides.run_plan = () => [
      { event: "run_started", plan_id: "plan-aaa111" },
      { event: "error", error: "unknown agent 'support-bot'" },
    ];
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickRunAndConfirm();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-error"))
        .toHaveTextContent("unknown agent 'support-bot'"));
    expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent(/运行失败 · 用时/);
    expect(screen.getByTestId("plan-run-progress-error"))
      .not.toHaveTextContent("仍在后台进行");
    expect(screen.getByTestId("plan-run")).toBeEnabled();
    // 关闭进度卡
    fireEvent.click(screen.getByTestId("plan-run-dismiss"));
    expect(screen.queryByTestId("plan-run-progress")).not.toBeInTheDocument();
  });

  // 框架层遗言帧（issue userunplan-ignores-framework-error-frame.md）：
  // 后端异常穿出 entrypoint 时 bedrock_agentcore 发的不是应用协议的
  // {event:"error"}，而是**无 event 字段**的 {error, error_type, message}
  // （bedrock_agentcore/runtime/app.py:887-891）。此前 useRunPlan 只认前者，这帧
  // 会掉进 logEntryOf 的兜底（印一行空事件名），最后按「流已结束但未收到
  // plan_run_report」报成「连接中断，运行可能仍在后台进行」—— 真因（DDB 超限、
  // 权限、判分模型报错）一个字都看不到，用户还会白等一个已经死掉的 run。
  // lib/api.ts:96 与 lib/runFlight.ts 早就各有一份识别逻辑。
  it("框架层遗言帧（无 event 字段）：显示后端异常真因，不报「连接中断」", async () => {
    overrides.run_plan = () => [
      { event: "plan_run_started", plan_id: "plan-aaa111", stages: ["observe"] },
      {
        error: "An error occurred (ValidationException) when calling the PutItem operation:"
          + " Item size has exceeded the maximum allowed size",
        error_type: "ClientError",
        message: "An error occurred during invocation",
      },
    ];
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    clickRunAndConfirm();
    const err = await screen.findByTestId("plan-run-progress-error");
    await waitFor(() => expect(err).toHaveTextContent("后端异常 ClientError"));
    expect(err).toHaveTextContent("Item size has exceeded the maximum allowed size");
    // run 真死了（≠ 断流）：不许挂「运行可能仍在后台进行」那句兜底
    expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent(/运行失败 · 用时/);
    expect(screen.getByTestId("plan-run-progress-status")).not.toHaveTextContent("连接中断");
    expect(err).not.toHaveTextContent("仍在后台进行");
    // 那句英文模板 message 不带信息，不呈现（与 lib/api.ts 同刑）
    expect(err).not.toHaveTextContent("An error occurred during invocation");
    // 兜底那行空事件名也不许留在日志里
    expect(screen.getByTestId("plan-run-progress-log")).not.toHaveTextContent("undefined");
  });
});

// ==================== 红队实时攻击对话（attack_turn 流 → 分栏面板） ====================
//
// 数据源 = app/redteam.py:675 emit_turn → app/planrun.py:264 emit：
//   {"event":"attack_turn","run_id":…,"case":"attack#N","role":…,"message":…,"turn_no":N}
// role **只有** attacker/target 两个值；case 是构造顺序编号（并发下 ≠ 用例顺序）。
// 这里的桩形态必须与真后端逐字一致 —— mock 凭想象写已造成三次线上事故。
//
// 等待锚点纪律：每一轮渲染出 plan-live-turn-{seq}（seq 是全局递增序号），
// 它是「这一条到齐」的专属 testid；不拿 plan-live-turns（第一轮就出现的
// 中间态容器）或 plan-live-lanes 当锚点。
describe("红队实时攻击对话", () => {
  // marker 全文用 mocks/handlers.ts 导出的那一份（simplify-r2 C4）：手抄第三份的
  // 后果是「后端 ↔ 抄本」对得上而 mock 自己漂走。文案的后端对刑在
  // tests/live-turns.test.ts（读 app/redteam.py 源码），这里只消费。
  const BLANK_MARKER = BLANK_TARGET_MARKER;
  const FAILED_MARKER = INVOKE_FAILED_MARKER;

  const atk = (
    caseKey: string, role: "attacker" | "target", turn_no: number, message: string,
  ) => ({
    event: "attack_turn", run_id: "rt-20260824175230",
    case: caseKey, role, message, turn_no,
  });

  /** 起流并进入运行中态 */
  async function startRun() {
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    const stream = installManualRunStream();
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    return stream;
  }

  it("非红队方案（零 attack_turn）：整格不渲染，不画空壳", async () => {
    const stream = await startRun();
    stream.push({ event: "stage_start", stage: 1, type: "observe", total_stages: 1 });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("线上评估：执行中"));
    expect(screen.queryByTestId("plan-live-turns")).not.toBeInTheDocument();
    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("三路并发 → 三栏并排；attack_turn 不进滚动日志（关键行不被冲掉）", async () => {
    const stream = await startRun();
    stream.push({ event: "stage_start", stage: 1, type: "redteam", total_stages: 1 });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("红队测试：执行中"));
    const logLinesBefore = logLines().length;

    stream.push(atk("attack#1", "attacker", 1, "值班经理话术开场"));
    stream.push(atk("attack#2", "attacker", 1, "合规评审话术开场"));
    stream.push(atk("attack#1", "target", 2, "需要订单号与登机人姓名"));
    stream.push(atk("attack#3", "attacker", 1, "角色扮演开场"));
    // 锚点 = 第 4 条轮次（seq=4）的专属 testid：只有它到齐这句才成立
    await screen.findByTestId("plan-live-turn-4");

    const lanes = within(screen.getByTestId("plan-live-lanes"))
      .getAllByTestId(/^plan-live-lane-redteam-attack-\d+$/);
    expect(lanes).toHaveLength(3);
    expect(screen.getByTestId("plan-live-lane-redteam-attack-1")).toHaveTextContent("攻击 #1");
    expect(screen.getByTestId("plan-live-lane-redteam-attack-3")).toHaveTextContent("攻击 #3");
    // 计数：3 路合计 4 条 · 攻 3 / 靶 1
    // ⚠️ 量词与分母由档 live-turns-counter-two-denominators 改口（用户原话「显示
    // 累计 6 轮，为什么只看到 3 轮」）：合计**把路数写进来**（原文的「累计 N 轮」
    // 与紧跟的「每路最近 3 轮」是两个不同分母裸着并排），量词从「轮」改「条」
    // （这个数数的是单条消息，一问一答是两条）。
    const count = screen.getByTestId("plan-live-turns-count");
    expect(count).toHaveTextContent("3 路合计 4 条");
    expect(count).toHaveTextContent("攻 3 / 靶 1");
    // 逐轮事件不进日志：行数不变、日志里没有对话正文
    expect(logLines()).toHaveLength(logLinesBefore);
    expect(screen.getByTestId("plan-run-progress-log")).not.toHaveTextContent("值班经理话术开场");
    expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("红队测试：执行中");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("每路尾窗只露最近 3 轮 +「展开本路」可看更全；老轮次真被丢弃", async () => {
    const stream = await startRun();
    for (let i = 1; i <= 6; i += 1) {
      stream.push(atk("attack#1", i % 2 === 1 ? "attacker" : "target", i, `第${i}轮正文`));
    }
    await screen.findByTestId("plan-live-turn-6");
    const lane = screen.getByTestId("plan-live-lane-redteam-attack-1");
    // 只露最近 3 轮：第 1/2/3 轮不在 DOM
    expect(lane).toHaveTextContent("第4轮正文");
    expect(lane).toHaveTextContent("第6轮正文");
    expect(lane).not.toHaveTextContent("第1轮正文");
    expect(lane).toHaveTextContent("前 3 条已折叠");
    // 展开本路 → 内存里还留着的老轮次放出来
    fireEvent.click(screen.getByTestId("plan-live-lane-redteam-attack-1-expand"));
    expect(lane).toHaveTextContent("第1轮正文");
    // 再点收回尾窗
    fireEvent.click(screen.getByTestId("plan-live-lane-redteam-attack-1-expand"));
    expect(lane).not.toHaveTextContent("第1轮正文");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("超内存上界后老轮次连「展开本路」也拿不回来（只留计数，不留全文）", async () => {
    const stream = await startRun();
    // 30 轮 > LANE_KEEP(24)：最老的 6 轮被真丢弃
    for (let i = 1; i <= 30; i += 1) {
      stream.push(atk("attack#1", i % 2 === 1 ? "attacker" : "target", i, `第${i}轮正文`));
    }
    await screen.findByTestId("plan-live-turn-30");
    fireEvent.click(screen.getByTestId("plan-live-lane-redteam-attack-1-expand"));
    const lane = screen.getByTestId("plan-live-lane-redteam-attack-1");
    // 全文已释放：第 1 轮取不回来，第 7 轮（=30-24+1）还在
    expect(lane).not.toHaveTextContent("第1轮正文");
    expect(lane).toHaveTextContent("第7轮正文");
    expect(lane).toHaveTextContent("6 条已释放");
    // 累计计数仍诚实
    expect(screen.getByTestId("plan-live-turns-count")).toHaveTextContent("1 路合计 30 条");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("靶侧空响应单独成形（silenced / errored 两种 marker），不按普通回复渲染", async () => {
    const stream = await startRun();
    stream.push(atk("attack#3", "attacker", 1, "角色扮演开场"));
    stream.push(atk("attack#3", "target", 2, BLANK_MARKER));
    stream.push(atk("attack#3", "target", 4, `${FAILED_MARKER}ReadTimeoutError]`));
    await screen.findByTestId("plan-live-turn-3");

    // 空响应轮带 data-blank 标记 + 明确不是「拒绝」的短标签
    expect(screen.getByTestId("plan-live-turn-2")).toHaveAttribute("data-blank", "silenced");
    expect(screen.getByTestId("plan-live-turn-2")).toHaveTextContent("空响应 · 0 字节");
    expect(screen.getByTestId("plan-live-turn-3")).toHaveAttribute("data-blank", "errored");
    expect(screen.getByTestId("plan-live-turn-3")).toHaveTextContent("调用失败 · 本轮未送达");
    // marker 原文保留（让排查者知道 judge 读到的就是这段）
    expect(screen.getByTestId("plan-live-turn-2")).toHaveTextContent("finish_reason=content_filtered");
    // 攻击方那条不许被判空
    expect(screen.getByTestId("plan-live-turn-1")).not.toHaveAttribute("data-blank");
    // 栏头如实说空响应轮数，且**不出现任何判定字样**
    const lane = screen.getByTestId("plan-live-lane-redteam-attack-3");
    expect(lane).toHaveTextContent("被测侧 2 条空响应");
    expect(lane).not.toHaveTextContent("已攻破");
    expect(lane).not.toHaveTextContent("已抵御");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("turn_no 空洞（断流重连）容忍：4 → 7 原样显示，不补齐不排序", async () => {
    const stream = await startRun();
    stream.push(atk("attack#1", "attacker", 4, "第四轮"));
    stream.push(atk("attack#1", "attacker", 7, "第七轮"));
    await screen.findByTestId("plan-live-turn-2");
    const lane = screen.getByTestId("plan-live-lane-redteam-attack-1");
    expect(lane).toHaveTextContent("第四轮");
    expect(lane).toHaveTextContent("第七轮");
    // 「第 N 轮」用的是实收条数（2），不是 turn_no 最大值（7）
    expect(lane).toHaveTextContent("共 2 条");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("红队路的常驻说明条已删：版面与 title 双无", async () => {
    const stream = await startRun();
    stream.push(atk("attack#1", "attacker", 1, "开场"));
    await screen.findByTestId("plan-live-turn-1");
    // 此前钉的是说明条**在**（「攻击对话在实时期只有攻击编号，没有用例名…构造顺序 ≠
    // 用例顺序…判定要等本次运行结束后的报告」且不可关）—— 对任何红队 run 恒成立 ⇒
    // 整块删（prose-sweep 2026-09-03）
    expect(screen.queryByTestId("plan-live-turns-honest")).toBeNull();
    expectProseGone(screen.getByTestId("plan-live-turns"),
      "只有攻击编号", "构造顺序 ≠ 用例顺序", "判定要等本次运行结束后的报告", "不做任何判定");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("整块可一键收起：收起后分栏与说明条都不渲染，头行还在", async () => {
    const stream = await startRun();
    stream.push(atk("attack#1", "attacker", 1, "开场"));
    await screen.findByTestId("plan-live-turn-1");
    fireEvent.click(screen.getByTestId("plan-live-turns-toggle"));
    expect(screen.getByTestId("plan-live-turns")).toHaveAttribute("data-open", "false");
    expect(screen.getByTestId("plan-live-turns-toggle")).toHaveAttribute("aria-expanded", "false");
    // 头行计数仍在（收起不等于失去进度感）
    expect(screen.getByTestId("plan-live-turns-count")).toHaveTextContent("1 路合计 1 条");
    fireEvent.click(screen.getByTestId("plan-live-turns-toggle"));
    expect(screen.getByTestId("plan-live-turns")).toHaveAttribute("data-open", "true");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("「跟随最新」关掉即冻结：新轮次只进计数不进视窗，重开即追上", async () => {
    const stream = await startRun();
    stream.push(atk("attack#1", "attacker", 1, "冻结前"));
    await screen.findByTestId("plan-live-turn-1");
    fireEvent.click(screen.getByTestId("plan-live-turns-follow"));
    expect(screen.getByTestId("plan-live-turns-follow")).not.toBeChecked();

    stream.push(atk("attack#1", "target", 2, "冻结后"));
    // 锚点挑「冻结提示出现」这个终态专属 testid（它只在有未显示轮次时才存在）
    await screen.findByTestId("plan-live-turns-frozen");
    expect(screen.getByTestId("plan-live-turns-frozen")).toHaveTextContent("新增 1 条未显示");
    expect(screen.getByTestId("plan-live-lane-redteam-attack-1")).not.toHaveTextContent("冻结后");
    // 累计计数仍走真数据（不骗用户）
    expect(screen.getByTestId("plan-live-turns-count")).toHaveTextContent("1 路合计 2 条");
    // 重新勾上 → 立刻追上最新
    fireEvent.click(screen.getByTestId("plan-live-turns-follow"));
    expect(screen.getByTestId("plan-live-lane-redteam-attack-1")).toHaveTextContent("冻结后");
    expect(screen.queryByTestId("plan-live-turns-frozen")).not.toBeInTheDocument();

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("chip「全部 / 最近 3 轮」切换所有栏的展开态", async () => {
    const stream = await startRun();
    for (let i = 1; i <= 5; i += 1) {
      stream.push(atk("attack#1", "attacker", i, `A第${i}轮`));
      stream.push(atk("attack#2", "attacker", i, `B第${i}轮`));
    }
    await screen.findByTestId("plan-live-turn-10");
    expect(screen.getByTestId("plan-live-lane-redteam-attack-1")).not.toHaveTextContent("A第1轮");
    fireEvent.click(screen.getByTestId("plan-live-turns-all"));
    expect(screen.getByTestId("plan-live-turns-all")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("plan-live-lane-redteam-attack-1")).toHaveTextContent("A第1轮");
    expect(screen.getByTestId("plan-live-lane-redteam-attack-2")).toHaveTextContent("B第1轮");
    fireEvent.click(screen.getByTestId("plan-live-turns-tail"));
    expect(screen.getByTestId("plan-live-lane-redteam-attack-1")).not.toHaveTextContent("A第1轮");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("断流后对话保留（帮判断断在哪一路第几轮），但不再说「进行中」", async () => {
    const stream = await startRun();
    stream.push(atk("attack#1", "attacker", 1, "断流前最后一句"));
    await screen.findByTestId("plan-live-turn-1");
    stream.fail(new Error("network error"));
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
    const lane = screen.getByTestId("plan-live-lane-redteam-attack-1");
    expect(lane).toHaveTextContent("断流前最后一句");
    // 流已断，不许再声称这路「进行中」；结论一律指向报告
    expect(lane).not.toHaveTextContent("进行中");
    // 「结论见报告」badge 是指路句，对任何已停推送的路恒成立 ⇒ 删（prose-sweep
    // 2026-09-03；此前钉的是它**在**）
    expectProseGone(lane, "结论见报告");
    expect(screen.getByTestId("plan-live-turns")).toHaveTextContent("已停止推送");
  });

  it("运行完成后对话仍在，且不出现任何攻破/抵御判定字样", async () => {
    const stream = await startRun();
    stream.push(atk("attack#1", "attacker", 1, "完成前的一句"));
    await screen.findByTestId("plan-live-turn-1");
    stream.push({
      event: "plan_run_report", run_key: "rk-rt", score: null,
      overview: { stage_lines: [], previous_run: null },
      stages: [], plan_synthesis: "", synthesis_error: null, duration_s: 30,
    });
    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("运行完成"));
    const panel = screen.getByTestId("plan-live-turns");
    expect(panel).toHaveTextContent("完成前的一句");
    expect(panel).not.toHaveTextContent("已攻破");
    expect(panel).not.toHaveTextContent("已抵御");
    expect(panel).not.toHaveTextContent("无有效结论");
  });

  it("role 出现第三种值 / 缺 case：整条丢弃，不瞎归类也不崩", async () => {
    const stream = await startRun();
    stream.push({ ...atk("attack#1", "attacker", 1, "judge 的旁白"), role: "judge" });
    stream.push({ ...atk("attack#1", "attacker", 1, "没有 case"), case: "" });
    stream.push(atk("attack#1", "attacker", 1, "唯一合法的一条"));
    await screen.findByTestId("plan-live-turn-1");
    expect(screen.getByTestId("plan-live-turns-count")).toHaveTextContent("1 路合计 1 条");
    expect(screen.getByTestId("plan-live-turns")).not.toHaveTextContent("judge 的旁白");
    expect(screen.getByTestId("plan-live-turns")).toHaveTextContent("唯一合法的一条");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });
});

// ============ 回归/模拟实时对话（turn 流 → 复用同一面板） ============
//
// 数据源 = app/testrun.py:601 emit_turn → app/planrun.py:218 emit：
//   {"event":"turn","run_id":…,"case":"<真用例名>","agent":"<agent 名>",
//    "role":"user"|"agent","message":…,"turn_no":N}
// 与 attack_turn 的三处**真差异**（见 src/pages/plan/liveTurns.ts 顶部）：
//   1. 多 `agent` 字段  2. case 是真用例名不是构造序号
//   3. turn_no 计数域是 `case@agent` → 分栏键必须含 agent
// 用户拍板「复用红队面板，三类环节统一看对话」，故这里验的是**同一个面板**在
// turn 侧的表现，不是另一个组件。
//
// 等待锚点纪律：锚点一律取 plan-live-turn-{seq}（seq 全局递增，只有那一条真到齐
// 才存在）。不拿 plan-live-turns / plan-live-lanes —— 它们第一条就出现，是中间态。
describe("回归/模拟实时对话", () => {
  /** 一条契约形态的 turn 事件（五个键 + run_id，一个不多一个不少） */
  const ds = (
    caseName: string, agent: string, role: "user" | "agent",
    turn_no: number, message: string,
  ) => ({
    event: "turn", run_id: "run-20260824175412",
    case: caseName, agent, role, message, turn_no,
  });

  const atk = (
    caseKey: string, role: "attacker" | "target", turn_no: number, message: string,
  ) => ({
    event: "attack_turn", run_id: "rt-20260824175230",
    case: caseKey, role, message, turn_no,
  });

  /** 分栏 testid：与 LiveTurnsPanel.laneTestId 同口径（`:`/`@` → `-`） */
  const dsLane = (caseName: string, agent: string) =>
    `plan-live-lane-dataset-${caseName}-${agent}`;

  async function startRun() {
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    const stream = installManualRunStream();
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    return stream;
  }

  it("栏头给**真用例名 + agent 名**（不是攻击编号），也不挂红队免责条", async () => {
    const stream = await startRun();
    stream.push({ event: "stage_start", stage: 1, type: "dataset", total_stages: 1 });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("回归测试：执行中"));
    const logLinesBefore = logLines().length;

    stream.push(ds("airline-rebooking-dialog", "support-bot", "user", 1, "机票想改到周五"));
    stream.push(ds("airline-rebooking-dialog", "support-bot", "agent", 2, "请提供订单号"));
    await screen.findByTestId("plan-live-turn-2");

    const lane = screen.getByTestId(dsLane("airline-rebooking-dialog", "support-bot"));
    expect(lane).toHaveTextContent("airline-rebooking-dialog");
    expect(lane).toHaveTextContent("support-bot");
    // 绝不套用红队那套「攻击 #N」的说法
    expect(lane).not.toHaveTextContent("攻击 #");
    // 计数按实际出现的角色列：只有 用户/Agent，不给攻/靶留 0
    const count = screen.getByTestId("plan-live-turns-count");
    expect(count).toHaveTextContent("路合计 2 条");
    expect(count).toHaveTextContent("用户 1 / Agent 1");
    expect(count).not.toHaveTextContent("攻 ");
    // 免责条是「attack#N 不是用例名」的边界说明；turn 侧 case 就是真用例名，
    // 挂上去反而误导 → 无红队路时不渲染
    expect(screen.queryByTestId("plan-live-turns-honest")).not.toBeInTheDocument();
    // 逐轮事件不进滚动日志（关键行不被冲掉）
    expect(logLines()).toHaveLength(logLinesBefore);
    expect(screen.getByTestId("plan-run-progress-log")).not.toHaveTextContent("请提供订单号");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("同一用例两个 agent：turn_no 都从 1 起也**分两栏**，内容不串", async () => {
    const stream = await startRun();
    stream.push(ds("airline-rebooking-dialog", "support-bot", "user", 1, "A 侧第一句"));
    stream.push(ds("airline-rebooking-dialog", "research-agent", "user", 1, "B 侧第一句"));
    stream.push(ds("airline-rebooking-dialog", "support-bot", "agent", 2, "A 侧第二句"));
    stream.push(ds("airline-rebooking-dialog", "research-agent", "agent", 2, "B 侧第二句"));
    await screen.findByTestId("plan-live-turn-4");

    const a = screen.getByTestId(dsLane("airline-rebooking-dialog", "support-bot"));
    const b = screen.getByTestId(dsLane("airline-rebooking-dialog", "research-agent"));
    expect(a).toHaveTextContent("A 侧第一句");
    expect(a).toHaveTextContent("A 侧第二句");
    expect(a).not.toHaveTextContent("B 侧");
    expect(b).toHaveTextContent("B 侧第一句");
    expect(b).not.toHaveTextContent("A 侧");
    // 两栏 turn_no 都是 1/2，React key 用全局 seq 才不撞（4 条都在 DOM 里）
    expect(screen.getByTestId("plan-live-turn-1")).toBeInTheDocument();
    expect(screen.getByTestId("plan-live-turn-3")).toBeInTheDocument();

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("被测侧 0 字节：回归/模拟没有 marker，空 message 也单独成形并说明不等于拒绝", async () => {
    const stream = await startRun();
    stream.push(ds("policy-refund-edge-case", "support-bot", "user", 1, "特价票能全退吗"));
    stream.push(ds("policy-refund-edge-case", "support-bot", "agent", 2, ""));
    await screen.findByTestId("plan-live-turn-2");

    const blank = screen.getByTestId("plan-live-turn-2");
    expect(blank).toHaveAttribute("data-blank", "silenced");
    expect(blank).toHaveTextContent("空响应 · 0 字节");
    // 后端这侧没有 marker 原文可展示 → 正文位写「被测 Agent 未产生任何输出」；
    // 「既未回答也未拒绝，不得据此判断它拒绝了请求」那半句对任何空响应恒成立 ⇒ 删
    // （prose-sweep 2026-09-03；此前钉的是「既未回答也未拒绝」**在**）
    expect(blank).toHaveTextContent("被测 Agent 未产生任何输出");
    expectProseGone(blank, "既未回答也未拒绝", "不得据此判断");
    // 输入侧那条不许被判空（空响应是被测侧的结论）
    expect(screen.getByTestId("plan-live-turn-1")).not.toHaveAttribute("data-blank");
    const lane = screen.getByTestId(dsLane("policy-refund-edge-case", "support-bot"));
    expect(lane).toHaveTextContent("被测侧 1 条空响应");
    // 实时期不做任何判定
    expect(lane).not.toHaveTextContent("不通过");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("未知 role（缓存回放的历史 conversation）：原样兜底，不丢内容也不崩", async () => {
    const stream = await startRun();
    // app/testrun.py:663 缓存命中回放读的是历史落盘 conversation 里的 t["role"]，
    // 旧数据可能有别的值 —— 红队侧整条丢，turn 侧必须留（内容是真发生过的）
    stream.push({ ...ds("legacy-cached-case", "support-bot", "user", 1, "历史第三种角色"), role: "assistant" });
    stream.push(ds("legacy-cached-case", "support-bot", "agent", 2, "正常那条"));
    await screen.findByTestId("plan-live-turn-2");

    const odd = screen.getByTestId("plan-live-turn-1");
    expect(odd).toHaveAttribute("data-role", "other");
    expect(odd).toHaveTextContent("历史第三种角色");
    // 计数把它单列，不混进 用户/Agent
    const count = screen.getByTestId("plan-live-turns-count");
    expect(count).toHaveTextContent("未知角色 1");
    expect(count).toHaveTextContent("用户 0 / Agent 1");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("三环节混跑（用户当下真跑的形态）：两类分组显示，免责条只为红队而挂", async () => {
    const stream = await startRun();
    stream.push(ds("faq-baggage-allowance", "support-bot", "user", 1, "行李额几件"));
    stream.push(atk("attack#1", "attacker", 1, "值班经理话术开场"));
    stream.push(ds("faq-baggage-allowance", "support-bot", "agent", 2, "经济舱 1 件 23kg"));
    await screen.findByTestId("plan-live-turn-3");

    // 组标题只在两类同时在场时出现，且用例组**不写死「回归测试」**
    //（后端 simulation/regression 同走 dataset runner，运行时分不开 —— UI-027）
    const dsGroup = screen.getByTestId("plan-live-group-dataset");
    const rtGroup = screen.getByTestId("plan-live-group-redteam");
    expect(dsGroup).toHaveTextContent("用例对话");
    expect(dsGroup).not.toHaveTextContent("回归测试");
    expect(rtGroup).toHaveTextContent("攻击对话");
    // 各组只装自己那类的栏
    expect(dsGroup).toHaveTextContent("faq-baggage-allowance");
    expect(dsGroup).not.toHaveTextContent("攻击 #1");
    expect(rtGroup).toHaveTextContent("攻击 #1");
    expect(rtGroup).not.toHaveTextContent("faq-baggage-allowance");
    // 混跑时也没有免责条（整块已删，见「红队路的常驻说明条已删」）
    expect(screen.queryByTestId("plan-live-turns-honest")).toBeNull();
    // 两组的计数都列出来
    const count = screen.getByTestId("plan-live-turns-count");
    expect(count).toHaveTextContent("攻 1 / 靶 0");
    expect(count).toHaveTextContent("用户 1 / Agent 1");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("路数按来源各自封顶：5 路用例（RUN_TTL_BATCH）与 3 路红队互不淘汰", async () => {
    const stream = await startRun();
    // 先来 5 路用例（后端 dataset 侧并发上限），再来 4 路红队（上限 3）
    for (let i = 1; i <= 5; i += 1) {
      stream.push(ds(`case-${i}`, "support-bot", "user", 1, `用例 ${i} 的输入`));
    }
    for (let i = 1; i <= 4; i += 1) {
      stream.push(atk(`attack#${i}`, "attacker", 1, `攻击 ${i} 开场`));
    }
    await screen.findByTestId("plan-live-turn-9");

    // 红队超限 → 淘汰红队里最久没动静的那路（attack#1），用例那 5 路一动不动
    // 用 data-kind 数栏，不用 testid 正则：`plan-live-lane-…-expand` / `-body`
    // 也以栏 testid 为前缀，正则会把控件一起数进来（第一版就这么错的）
    const dsGroup = screen.getByTestId("plan-live-group-dataset");
    expect(dsGroup.querySelectorAll('.atk-lane[data-kind="dataset"]')).toHaveLength(5);
    expect(dsGroup).toHaveTextContent("case-1");
    const rtGroup = screen.getByTestId("plan-live-group-redteam");
    expect(rtGroup.querySelectorAll('.atk-lane[data-kind="redteam"]')).toHaveLength(3);
    expect(rtGroup).not.toHaveTextContent("攻击 1 开场");
    // 淘汰如实交代，不假装没发生
    expect(screen.getByTestId("plan-live-turns-count"))
      .toHaveTextContent("已结束的 1 路共 1 条已释放");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("尾窗对 turn 同样生效：长跑模拟只露最近 3 轮，展开可看更全", async () => {
    const stream = await startRun();
    for (let i = 1; i <= 6; i += 1) {
      stream.push(ds("airline-rebooking-dialog", "support-bot",
        i % 2 === 1 ? "user" : "agent", i, `第${i}轮正文`));
    }
    await screen.findByTestId("plan-live-turn-6");
    const lane = screen.getByTestId(dsLane("airline-rebooking-dialog", "support-bot"));
    expect(lane).toHaveTextContent("第6轮正文");
    expect(lane).not.toHaveTextContent("第1轮正文");
    expect(lane).toHaveTextContent("前 3 条已折叠");
    fireEvent.click(screen.getByTestId(
      `${dsLane("airline-rebooking-dialog", "support-bot")}-expand`));
    expect(lane).toHaveTextContent("第1轮正文");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });
});

// ============ 线上评估实时会话清单（session_result 流 → 评完一条落一行） ============
//
// 数据源 = app/main.py:_evaluate_session 的返回，planrun.py:155 原样透传：
//   session_result: {event,agent,session_id,span_count,output_preview,
//                    results:{<评估器>:{score,passed,errored,reason}},
//                    metrics,transcript,diagnosis[,no_content,warning]}
//   session_error : {event,agent,session_id,span_count,error}
//   observe_sessions（本批新增后端）: {event,stage,total} —— 「已评 N/M」的分母
//
// 为什么不是对话分栏：observe 评的是已结束的 trace，没有轮次概念，且会话并发
// 乱序完成（STAGE_CONCURRENCY 的 semaphore + as_completed）。用户拍板「实时会话
// 清单：评完一条落一行」。
//
// 等待锚点纪律：锚点取**目标那一条会话专属**的行 testid
// （plan-observe-row-<session_id>），不拿 plan-observe-sessions / -rows
// （第一条就出现的中间态容器）。
describe("线上评估实时会话清单", () => {
  const sres = (
    id: string, results: Record<string, unknown>, extra: Record<string, unknown> = {},
  ) => ({
    event: "session_result", agent: "support-bot", session_id: id, span_count: 9,
    output_preview: "已为您改签至周五 08:15 的 MU5401。", results,
    metrics: null, transcript: null, diagnosis: null, ...extra,
  });
  const serr = (id: string, error?: string) => ({
    event: "session_error", agent: "support-bot", session_id: id, span_count: 0,
    ...(error === undefined ? {} : { error }),
  });
  const good = (score: number, reason: unknown = "回答完整。") =>
    ({ score, passed: true, errored: false, reason });
  const throttled = {
    score: null, passed: null, errored: true,
    reason: "An error occurred: ThrottlingException: Too many requests",
  };
  const row = (id: string) => `plan-observe-row-${id}`;

  async function startRun() {
    renderDetail();
    await screen.findByTestId("plan-runs-table");
    const stream = installManualRunStream();
    clickRunAndConfirm();
    await screen.findByTestId("plan-run-progress");
    return stream;
  }

  it("非 observe 方案（零会话事件）：整格不渲染，不画空壳", async () => {
    const stream = await startRun();
    stream.push({ event: "stage_start", stage: 1, type: "redteam", total_stages: 1 });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("红队测试：执行中"));
    expect(screen.queryByTestId("plan-observe-sessions")).not.toBeInTheDocument();
    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("只收到分母还没落行：仍不画（「已评 0/7」的空框比没有更让人焦虑）", async () => {
    const stream = await startRun();
    stream.push({ event: "stage_start", stage: 1, type: "observe", total_stages: 1 });
    stream.push({ event: "observe_sessions", stage: 1, total: 7 });
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-log")).toHaveTextContent("线上评估：执行中"));
    expect(screen.queryByTestId("plan-observe-sessions")).not.toBeInTheDocument();
    // 分母事件本身**不进滚动日志**（漏挡会印出光秃秃的「observe_sessions」）
    expect(screen.getByTestId("plan-run-progress-log")).not.toHaveTextContent("observe_sessions");
    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("评完一条落一行：分母来自 observe_sessions →「已评 3/7 会话」", async () => {
    const stream = await startRun();
    stream.push({ event: "stage_start", stage: 1, type: "observe", total_stages: 1 });
    stream.push({ event: "observe_sessions", stage: 1, total: 7 });
    stream.push(sres("sess-aaa111", { helpfulness: good(0.9), coherence: good(0.7) }));
    stream.push(serr("sess-bbb222", "TraceProviderError: no spans"));
    stream.push(sres("sess-ccc333", { helpfulness: good(0.8) }));
    // 锚点 = 第三条会话专属的行 testid：只有它到齐这句才成立
    await screen.findByTestId(row("sess-ccc333"));

    const count = screen.getByTestId("plan-observe-sessions-count");
    expect(count).toHaveTextContent("已评 3/7 会话");
    expect(count).toHaveTextContent("有分数 2");
    expect(count).toHaveTextContent("失败 1");
    // 行序 = 评完顺序（乱序完成，界面必须写明不是会话时间序）
    const ids = within(screen.getByTestId("plan-observe-rows"))
      .getAllByRole("listitem").map((li) => li.getAttribute("data-testid"));
    expect(ids).toEqual([row("sess-aaa111"), row("sess-bbb222"), row("sess-ccc333")]);
    // 此前钉的是说明条**在**（「按评完顺序排列，不是会话时间顺序…本会话均分只统计有
    // 分数的评估器…方案级结论与趋势见本次运行结束后的报告」）—— 对任何线上评估 run
    // 恒成立 ⇒ 整块删（prose-sweep 2026-09-03）；行序本身仍由上面的 ids 断言钉着
    expect(screen.queryByTestId("plan-observe-sessions-honest")).toBeNull();
    expectProseGone(screen.getByTestId("plan-observe-sessions"),
      "按评完顺序排列", "无分数一律不按 0 计", "见本次运行结束后的报告");
    // 均分：(0.9+0.7)/2
    expect(screen.getByTestId(`${row("sess-aaa111")}-mean`)).toHaveTextContent("0.80");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("没收到 observe_sessions（老后端）：只说「已评 N 会话」，**不编分母**", async () => {
    const stream = await startRun();
    stream.push(sres("sess-nod1", { helpfulness: good(0.9) }));
    await screen.findByTestId(row("sess-nod1"));
    const count = screen.getByTestId("plan-observe-sessions-count");
    expect(count).toHaveTextContent("已评 1 会话");
    expect(count).not.toHaveTextContent("/");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("score:null 的评估器显示「—」不是 0.00，且不把均分拉低", async () => {
    const stream = await startRun();
    stream.push(sres("sess-thr1", { helpfulness: good(0.8), coherence: throttled }));
    await screen.findByTestId(row("sess-thr1"));
    const li = screen.getByTestId(row("sess-thr1"));
    // 均分 = 0.8（不是 (0.8+0)/2 = 0.40）
    expect(screen.getByTestId(`${row("sess-thr1")}-mean`)).toHaveTextContent("0.80");
    expect(li).not.toHaveTextContent("0.40");
    expect(li).not.toHaveTextContent("0.00");
    // 挂掉那个评估器的分数位是「—」
    expect(li).toHaveTextContent("coherence—");
    expect(li).toHaveAttribute("data-status", "scored");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("评估器全挂 → 中性「无可评分项」，绝不显示 0 分", async () => {
    const stream = await startRun();
    stream.push(sres("sess-nos1", { helpfulness: throttled, coherence: throttled }));
    await screen.findByTestId(row("sess-nos1"));
    const li = screen.getByTestId(row("sess-nos1"));
    expect(li).toHaveAttribute("data-status", "no-score");
    expect(li).toHaveTextContent("无可评分项");
    expect(li).not.toHaveTextContent("0.00");
    // 计数也走中性档，不进「有分数」
    const count = screen.getByTestId("plan-observe-sessions-count");
    expect(count).toHaveTextContent("无可评分项 1");
    expect(count).not.toHaveTextContent("有分数");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("no_content:true → 「无内容可评」+ 原因（比一个 0 分有用得多）", async () => {
    const stream = await startRun();
    stream.push(sres("sess-nc1", { helpfulness: { ...throttled, reason: "the output is empty" } }, {
      no_content: true,
      warning: "trace has no captured message content — the agent was likely deployed "
        + "without OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true",
    }));
    await screen.findByTestId(row("sess-nc1"));
    const li = screen.getByTestId(row("sess-nc1"));
    expect(li).toHaveAttribute("data-status", "no-content");
    expect(li).toHaveTextContent("无内容可评");
    expect(li).not.toHaveTextContent("0.00");
    expect(screen.getByTestId(`${row("sess-nc1")}-warning`))
      .toHaveTextContent("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("reason 是**对象**（observe 侧后端不做 str 强转）：不白屏，详情里出文本", async () => {
    const stream = await startRun();
    stream.push(sres("sess-obj1", {
      helpfulness: {
        score: 0.66, passed: true, errored: false,
        reason: { summary: "结论正确，但未说明到账周期。", score_rationale: "0.66" },
      },
    }));
    await screen.findByTestId(row("sess-obj1"));
    // 没白屏：整卡还在
    expect(screen.getByTestId("plan-run-progress")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`${row("sess-obj1")}-expand`));
    expect(screen.getByTestId(`${row("sess-obj1")}-detail`))
      .toHaveTextContent("结论正确，但未说明到账周期。");
    // 不许把对象序列化成 [object Object] 糊在界面上
    expect(screen.getByTestId(row("sess-obj1"))).not.toHaveTextContent("[object Object]");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("session_error 缺 error：中性兜底文案，行不消失也不空白", async () => {
    const stream = await startRun();
    stream.push(serr("sess-bare1"));
    await screen.findByTestId(row("sess-bare1"));
    expect(screen.getByTestId(`${row("sess-bare1")}-error`))
      .toHaveTextContent("评分失败（后端未给原因）");
    expect(screen.getByTestId(row("sess-bare1"))).toHaveAttribute("data-status", "errored");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("同一 session_id 重发（重试成功）：原位替换，不新增行也不重复计数", async () => {
    const stream = await startRun();
    stream.push({ event: "observe_sessions", stage: 1, total: 2 });
    stream.push(serr("sess-rt1", "拉 trace 超时"));
    stream.push(sres("sess-other", { helpfulness: good(0.7) }));
    await screen.findByTestId(row("sess-other"));
    expect(screen.getByTestId(row("sess-rt1"))).toHaveAttribute("data-status", "errored");

    stream.push(sres("sess-rt1", { helpfulness: good(0.81) }));
    // 锚点挑「那一行变成已评分」这个终态（只有替换真发生了才成立）
    await waitFor(() =>
      expect(screen.getByTestId(row("sess-rt1"))).toHaveAttribute("data-status", "scored"));
    // 仍然只有两行，且顺序没跳
    const ids = within(screen.getByTestId("plan-observe-rows"))
      .getAllByRole("listitem").map((li) => li.getAttribute("data-testid"));
    expect(ids).toEqual([row("sess-rt1"), row("sess-other")]);
    const count = screen.getByTestId("plan-observe-sessions-count");
    expect(count).toHaveTextContent("已评 2/2 会话");
    expect(count).not.toHaveTextContent("失败");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("整块可一键收起：收起后清单与说明条都不渲染，头行计数还在", async () => {
    const stream = await startRun();
    stream.push(sres("sess-tg1", { helpfulness: good(0.9) }));
    await screen.findByTestId(row("sess-tg1"));
    fireEvent.click(screen.getByTestId("plan-observe-sessions-toggle"));
    expect(screen.getByTestId("plan-observe-sessions")).toHaveAttribute("data-open", "false");
    expect(screen.getByTestId("plan-observe-sessions-count")).toHaveTextContent("已评 1 会话");
    fireEvent.click(screen.getByTestId("plan-observe-sessions-toggle"));
    expect(screen.getByTestId("plan-observe-sessions")).toHaveAttribute("data-open", "true");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });

  it("断流后清单保留（帮判断评到第几条），但不再说「评估中」", async () => {
    const stream = await startRun();
    stream.push({ event: "observe_sessions", stage: 1, total: 7 });
    stream.push(sres("sess-cut1", { helpfulness: good(0.9) }));
    await screen.findByTestId(row("sess-cut1"));
    stream.fail(new Error("network error"));
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
    const panel = screen.getByTestId("plan-observe-sessions");
    expect(panel).toHaveTextContent("sess-cut1");
    // 断在第 1/7 条这件事要留着
    expect(screen.getByTestId("plan-observe-sessions-count")).toHaveTextContent("已评 1/7 会话");
    expect(panel).toHaveTextContent("已停止推送");
    expect(panel).not.toHaveTextContent("评估中");
  });

  it("混跑方案：会话清单与实时对话两格**同时在场**，各管各的", async () => {
    const stream = await startRun();
    stream.push({ event: "stage_start", stage: 1, type: "observe", total_stages: 2 });
    stream.push({ event: "observe_sessions", stage: 1, total: 2 });
    stream.push(sres("sess-mix1", { helpfulness: good(0.9) }));
    stream.push({ event: "stage_start", stage: 2, type: "dataset", total_stages: 2 });
    stream.push({
      event: "turn", run_id: "run-20260824175412", case: "faq-baggage-allowance",
      agent: "support-bot", role: "user", turn_no: 1, message: "行李额几件",
    });
    await screen.findByTestId("plan-live-turn-1");

    expect(screen.getByTestId("plan-observe-sessions")).toHaveTextContent("sess-mix1");
    expect(screen.getByTestId("plan-live-turns")).toHaveTextContent("faq-baggage-allowance");
    // 会话行不会跑进对话面板，对话轮次也不会跑进清单
    expect(screen.getByTestId("plan-live-turns")).not.toHaveTextContent("sess-mix1");
    expect(screen.getByTestId("plan-observe-sessions")).not.toHaveTextContent("行李额几件");

    stream.close();
    await waitFor(() =>
      expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("连接中断"));
  });
});

// ==================== 进度卡呈现（RunProgress 直渲：计时与三档心跳） ====================
describe("进度卡活性呈现", () => {
  const entry = (text: string): RunLogEntry => ({ ts: Date.now(), kind: "info", text });

  it("运行中计时：startedAt 65s 前 → 「已 01:05」；心跳 3s 前 → 链路正常", () => {
    render(
      <RunProgress
        state={{
          phase: "running", entries: [entry("运行开始")],
          startedAt: Date.now() - 65_000, lastEventAt: Date.now() - 3_000,
        }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId("plan-run-progress-status")).toHaveTextContent("运行中 · 已 01:05");
    const live = screen.getByTestId("plan-run-liveness");
    expect(live).toHaveClass("ok");
    expect(live).toHaveTextContent("链路正常 · 3s 前有心跳");
  });

  it("三档心跳：>10s 无事件转琥珀「等待响应…」，>60s 转红档（久无新事件）", () => {
    const { unmount } = render(
      <RunProgress
        state={{
          phase: "running", entries: [entry("运行开始")],
          startedAt: Date.now() - 20_000, lastEventAt: Date.now() - 15_000,
        }}
        onDismiss={() => {}}
      />,
    );
    let live = screen.getByTestId("plan-run-liveness");
    expect(live).toHaveClass("waiting");
    expect(live).toHaveTextContent("等待响应…");
    unmount();
    render(
      <RunProgress
        state={{
          phase: "running", entries: [entry("运行开始")],
          startedAt: Date.now() - 90_000, lastEventAt: Date.now() - 61_000,
        }}
        onDismiss={() => {}}
      />,
    );
    live = screen.getByTestId("plan-run-liveness");
    expect(live).toHaveClass("stale");
    // UI-029 批 3 撤掉了死胡同文案「可能已断开，最终状态以运行历史为准」（SPEC §6
    // 点名的那一句）：流真断了会自动转轮询（plan-reattach.test.tsx 钉），这一档只是
    // 「流还开着但久无事件」，不许把用户请出界面去自己刷新。
    // 改判重钉（2026-08-30 无废话终裁；删句双钉：版面无 + title 无）：机制解释
    // 半句「（断流会自动转为轮询）」对任何断流恒成立 = 使用文档，删；状态本体
    // 「久无新事件 · 运行仍在后端继续」是这一次 run 的话，留。
    expect(live).toHaveTextContent("久无新事件 · 运行仍在后端继续");
    expect(live).not.toHaveTextContent("断流会自动转为轮询");
    expect(live.getAttribute("title")).toBeNull();
    expect(document.querySelector('[title*="断流会自动转为轮询"]')).toBeNull();
    expect(live).not.toHaveTextContent("最终状态以运行历史为准");
  });

  it("完成态：用时 mm:ss + 线上评估均分（顶层 score）；无心跳指示", () => {
    render(
      <RunProgress
        state={{
          phase: "done",
          // 真形态：综合分在顶层 score（不是 overview.score——那是 mock 幻觉）
          report: { run_key: "rk", score: 0.86, overview: { stage_lines: [] } } as unknown as import("../src/pages/plan/types").PlanRunDetail,
          entries: [entry("运行开始")], startedAt: Date.now() - 74_000, durationS: 74,
        }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId("plan-run-progress-status"))
      .toHaveTextContent("运行完成 · 用时 01:14 · 线上评估均分 0.86");
    expect(screen.queryByTestId("plan-run-liveness")).not.toBeInTheDocument();
  });

  // H-5：真后端终帧 overview 里没有 score，只有 stage_lines。此前读
  // overview?.score 导致「总分」线上永不显示；现在顶层 score 优先、
  // 退回从 observe 环节 overall_mean 推导。
  it("完成态：无顶层 score 时从 observe 环节 overall_mean 推导线上评估均分", () => {
    render(
      <RunProgress
        state={{
          phase: "done",
          report: {
            run_key: "rk",
            overview: { stage_lines: [{ type: "observe", status: "completed", text: "评估 2 个会话，均分 0.9" }] },
            stages: [
              { type: "observe", status: "completed", overall_mean: 0.9, sessions: 2 },
              // 回归环节的 pass_rate 不是线上评估均分，绝不能被当成 run 级分数
              { type: "dataset", status: "completed", pass_rate: 0.5, cases: 4 },
            ],
          } as unknown as import("../src/pages/plan/types").PlanRunDetail,
          entries: [entry("运行开始")], startedAt: Date.now() - 74_000, durationS: 74,
        }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId("plan-run-progress-status"))
      .toHaveTextContent("线上评估均分 0.90");
  });

  it("完成态：没有任何可评分环节 → 整段不显示线上评估均分（不伪造 0）", () => {
    render(
      <RunProgress
        state={{
          phase: "done",
          report: {
            run_key: "rk",
            // 只有回归/红队环节，或 observe 环节 empty —— 都推不出线上评估均分
            overview: { stage_lines: [] },
            stages: [
              { type: "observe", status: "empty", error: "最近 30 天没有可评估的会话" },
              { type: "redteam", status: "completed", breached: 1, attacks: 3 },
            ],
          } as unknown as import("../src/pages/plan/types").PlanRunDetail,
          entries: [entry("运行开始")], startedAt: Date.now() - 74_000, durationS: 74,
        }}
        onDismiss={() => {}}
      />,
    );
    const status = screen.getByTestId("plan-run-progress-status");
    expect(status).toHaveTextContent("运行完成 · 用时 01:14");
    // 守卫词随「总分」改名迁移（CONTEXT.md:88-91 Avoid「总分」）——不迁就静默解除
    expect(status).not.toHaveTextContent("线上评估均分");
    expect(status).not.toHaveTextContent("0.00");
  });
});

// ==================== M4：方案编辑器 ====================
describe("评估器 scope 过滤（纯函数）", () => {
  const data = EVALUATORS_EVENT as Parameters<typeof evaluatorsForStage>[0];

  it("observe：内置按 scopes includes；dataset_only 不进；自定义只有 all/observe", () => {
    const names = evaluatorsForStage(data, "observe");
    expect(names).toContain("coherence");
    expect(names).toContain("brand_tone");          // scope=all 通吃
    expect(names).not.toContain("correctness");     // dataset_only
    expect(names).not.toContain("mm_correctness");  // scopes=["dataset"]
    expect(names).not.toContain("citation_quality"); // scope=dataset
  });

  it("dataset：dataset_only + 多模态 + scope=dataset 自定义都进", () => {
    const names = evaluatorsForStage(data, "dataset");
    expect(names).toEqual(expect.arrayContaining([
      "correctness", "mm_correctness", "citation_quality", "brand_tone", "coherence",
    ]));
  });

  it("redteam：只有 scopes 含 redteam 的内置 + all 自定义", () => {
    const names = evaluatorsForStage(data, "redteam");
    expect(names).toContain("harmfulness");
    expect(names).toContain("brand_tone");
    expect(names).not.toContain("coherence");
    expect(names).not.toContain("correctness");
  });
});

describe("方案编辑器", () => {
  it("四种环节卡可增删；observe 卡的评估器 chips 按 scope 过滤", async () => {
    renderEditor();
    await screen.findByTestId("plan-form-stages-empty");
    // 空态只说「还没有环节」；「用右上角按钮添加：线上评估（评线上真实会话）…」是使用
    // 说明 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("plan-form-stages-empty"), "用右上角按钮添加", "评线上真实会话");
    // 增：四钮各一张
    fireEvent.click(screen.getByTestId("plan-form-add-observe"));
    fireEvent.click(screen.getByTestId("plan-form-add-dataset"));
    fireEvent.click(screen.getByTestId("plan-form-add-simulation"));
    fireEvent.click(screen.getByTestId("plan-form-add-redteam"));
    expect(screen.getByTestId("plan-form-stage-count")).toHaveTextContent("4");
    expect(screen.getByTestId("plan-stage-card-0")).toHaveTextContent("线上评估");
    expect(screen.getByTestId("plan-stage-card-1")).toHaveTextContent("回归测试");
    expect(screen.getByTestId("plan-stage-card-2")).toHaveTextContent("模拟测试");
    expect(screen.getByTestId("plan-stage-card-3")).toHaveTextContent("红队测试");
    // observe 卡：dataset_only 评估器不出现
    const observeCard = screen.getByTestId("plan-stage-card-0");
    await within(observeCard).findByTestId("plan-stage-card-0-eval-coherence");
    expect(within(observeCard).queryByTestId("plan-stage-card-0-eval-correctness")).toBeNull();
    // dataset 卡：correctness 出现；数据集下拉只列固定侧（模拟侧/红队都不进）
    const datasetCard = screen.getByTestId("plan-stage-card-1");
    await within(datasetCard).findByTestId("plan-stage-card-1-eval-correctness");
    const dsSelect = within(datasetCard).getByTestId("plan-stage-card-1-dataset");
    const dsOptions = within(dsSelect).getAllByRole("option").map((o) => o.textContent);
    expect(dsOptions).toContain("faq-v3");
    expect(dsOptions).not.toContain("jailbreak-probes");
    expect(dsOptions).not.toContain("sim-rebooking");
    expect(dsOptions).not.toContain("flow-multi");
    // 删第二张 → 剩 3，模拟卡上移
    fireEvent.click(screen.getByTestId("plan-stage-card-1-remove"));
    expect(screen.getByTestId("plan-form-stage-count")).toHaveTextContent("3");
    expect(screen.getByTestId("plan-stage-card-1")).toHaveTextContent("模拟测试");
  });

  it("模拟环节卡：青色条 .kind.sim、下拉只列模拟侧集合（含形态推断）、卡内多轮说明", async () => {
    renderEditor();
    await screen.findByTestId("plan-form-stages-empty");
    fireEvent.click(screen.getByTestId("plan-form-add-simulation"));
    // 空卡（还没选集合）就按添加意图显示为模拟卡 + 青色条
    const kindEl = screen.getByTestId("plan-stage-card-0-kind");
    expect(kindEl).toHaveTextContent("模拟测试");
    expect(kindEl).toHaveClass("kind", "sim");
    // 下拉标签「模拟任务集」，只列模拟侧：显式 kind + 形态推断，固定/红队不进
    const simSelect = await screen.findByTestId("plan-stage-card-0-dataset");
    await waitFor(() =>
      expect(within(simSelect).getAllByRole("option").length).toBeGreaterThan(1));
    const opts = within(simSelect).getAllByRole("option").map((o) => o.textContent);
    expect(opts).toContain("sim-rebooking");
    expect(opts).toContain("flow-multi");
    expect(opts).not.toContain("faq-v3");
    expect(opts).not.toContain("jailbreak-probes");
    expect(screen.getByText("模拟任务集")).toBeInTheDocument();
    // 卡内说明「只列模拟集（多轮）。平台扮演用户与 Agent 多轮对话…」与回归卡的
    // 「只列固定用例集（单轮 / 图片）…」对任何方案恒成立 ⇒ 删（prose-sweep 2026-09-03；
    // 此前钉的是 sim-note **在**）
    expect(screen.queryByTestId("plan-stage-card-0-sim-note")).toBeNull();
    expectProseGone(screen.getByTestId("plan-stage-card-0"), "平台扮演用户", "只列模拟集", "只列固定用例集");
  });

  it("四钮产出的环节 type 仍是三类：模拟环节保存为 {type:\"dataset\"}，无表现层标记泄漏", async () => {
    renderEditor();
    await screen.findByTestId("plan-form-name");
    fireEvent.change(screen.getByTestId("plan-form-name"), { target: { value: "模拟方案" } });
    const agentSelect = screen.getByTestId("plan-form-agent");
    await waitFor(() =>
      expect(within(agentSelect).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(agentSelect, { target: { value: "support-bot" } });
    fireEvent.click(screen.getByTestId("plan-form-add-simulation"));
    const simSelect = await screen.findByTestId("plan-stage-card-0-dataset");
    await waitFor(() =>
      expect(within(simSelect).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(simSelect, { target: { value: "sim-rebooking" } });
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const call = calls.find((c) => c.action === "save_plan")!;
    const stages = (call.plan as { stages: Record<string, unknown>[] }).stages;
    // 存储三类：type 是 dataset，不是 simulation；_ui 标记已剥掉
    expect(stages).toEqual([{ type: "dataset", dataset: "sim-rebooking", evaluators: [] }]);
  });

  it("编辑回填两分支：dataset 环节按集合归类显示回归卡或模拟卡；找不到集合默认回归卡", async () => {
    const plan: import("../src/pages/plan/types").Plan = {
      plan_id: "plan-mix",
      name: "混编方案",
      agent_name: "support-bot",
      updated_at: 1755500000,
      stages: [
        { type: "dataset", dataset: "faq-v3", evaluators: [] },        // 固定侧 → 回归卡
        { type: "dataset", dataset: "sim-rebooking", evaluators: [] }, // 显式模拟 → 模拟卡
        { type: "dataset", dataset: "flow-multi", evaluators: [] },    // 形态推断 → 模拟卡
        { type: "dataset", dataset: "gone-ds", evaluators: [] },       // 找不到 → 默认回归卡
      ],
      schedule: "",
    };
    renderEditor(plan);
    await screen.findByTestId("plan-form-name");
    // 「回归测试」也是集合未加载时的默认文案，只等 card-0 会在 datasets 回来前就放行，
    // 于此断言 card-1 便偶发红。改等只有集合加载后才成立的 card-1=模拟测试。
    await waitFor(() =>
      expect(screen.getByTestId("plan-stage-card-1-kind")).toHaveTextContent("模拟测试"));
    expect(screen.getByTestId("plan-stage-card-0-kind")).toHaveTextContent("回归测试");
    expect(screen.getByTestId("plan-stage-card-0-kind")).toHaveClass("regress");
    expect(screen.getByTestId("plan-stage-card-1-kind")).toHaveTextContent("模拟测试");
    expect(screen.getByTestId("plan-stage-card-1-kind")).toHaveClass("sim");
    expect(screen.getByTestId("plan-stage-card-2-kind")).toHaveTextContent("模拟测试");
    expect(screen.getByTestId("plan-stage-card-3-kind")).toHaveTextContent("回归测试");
    // 模拟卡的评估器 scope 与回归卡一致（同 dataset scope）：correctness 两边都在
    await screen.findByTestId("plan-stage-card-1-eval-correctness");
    expect(screen.getByTestId("plan-stage-card-0-eval-correctness")).toBeInTheDocument();
  });

  it("血统警示：用例集 target_agent≠当前 agent 时出现，换回匹配集或换 agent 后消失", async () => {
    renderEditor();
    await screen.findByTestId("plan-form-name");
    const agentSelect = screen.getByTestId("plan-form-agent");
    await waitFor(() =>
      expect(within(agentSelect).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(agentSelect, { target: { value: "support-bot" } });
    fireEvent.click(screen.getByTestId("plan-form-add-redteam"));
    const casesSelect = await screen.findByTestId("plan-stage-card-0-cases");
    // 等 list_datasets 灌完下拉再选
    await waitFor(() =>
      expect(within(casesSelect).getAllByRole("option").length).toBeGreaterThan(1));
    // 选针对 research-agent 的用例集 → 警示出现（不阻断：保存按钮不因此禁用）
    fireEvent.change(casesSelect, { target: { value: "probes-other" } });
    expect(screen.getByTestId("plan-stage-card-0-lineage-warn"))
      .toHaveTextContent("⚠ 该用例集针对 research-agent 生成");
    // 换成匹配的 → 消失
    fireEvent.change(casesSelect, { target: { value: "jailbreak-probes" } });
    expect(screen.queryByTestId("plan-stage-card-0-lineage-warn")).toBeNull();
    // 再选不匹配的，然后把 agent 换成 research-agent → 也消失
    fireEvent.change(casesSelect, { target: { value: "probes-other" } });
    expect(screen.getByTestId("plan-stage-card-0-lineage-warn")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("plan-form-agent"), { target: { value: "research-agent" } });
    expect(screen.queryByTestId("plan-stage-card-0-lineage-warn")).toBeNull();
  });

  it("保存：请求体形状（schedule 为契约对象 {cron, budget_usd}，编辑带 plan_id）→ 跳详情页", async () => {
    renderEditor();
    await screen.findByTestId("plan-form-name");
    fireEvent.change(screen.getByTestId("plan-form-name"), { target: { value: "新方案" } });
    const agentSelect = screen.getByTestId("plan-form-agent");
    await waitFor(() =>
      expect(within(agentSelect).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(agentSelect, { target: { value: "support-bot" } });
    // 定时选择器高级档手写标准五段 → 保存时归一为 EventBridge cron(...) 形态；
    // 预算改 3.5 → 对象整体进请求体（app/plan.py:109-117 契约，字符串会 400）
    fireEvent.click(screen.getByTestId("sched-mode-advanced"));
    fireEvent.change(screen.getByTestId("sched-cron-input"), { target: { value: "0 3 * * 1" } });
    fireEvent.change(screen.getByTestId("sched-budget"), { target: { value: "3.5" } });
    await primeEvaluatorsLoaded();
    fireEvent.click(screen.getByTestId("plan-form-add-observe"));
    const chip = await screen.findByTestId("plan-stage-card-0-eval-helpfulness");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const call = calls.find((c) => c.action === "save_plan")!;
    expect(call.plan).toEqual({
      name: "新方案",
      agent_name: "support-bot",
      // 新建 observe 环节带会话范围默认值 + 全选指标（照旧版 app.js:1335-1336）
      stages: [{
        type: "observe",
        evaluators: ["helpfulness"],
        lookback_days: 30,
        max_sessions: 10,
        metrics: ["tokens", "cost", "latency", "llm_calls", "tool_calls"],
      }],
      // 保存归一：裸五段 → EventBridge cron(...)（plansched.py 直传 ScheduleExpression）；
      // 预算成对随行——这是后端强制的成本闸门
      schedule: { cron: "cron(0 3 ? * MON *)", budget_usd: 3.5 },
      // 只用上报数据评估：2026-09-08 起新建默认开，且两态都显式带键（trace-required.test.tsx 钉关的一态）
      trace_required: true,
    });
    // plan_saved → 跳新 plan 详情
    await waitFor(() => expect(location.hash).toBe("#/plan/plan-new123"));
  });

  it("定时选择器·预算必填：预算清空/≤0 保存就地拦截，不发请求；补上后放行", async () => {
    renderEditor(PLAN); // {cron: "0 3 * * 1", budget_usd: 2} → 简单档
    await screen.findByTestId("plan-form-name");
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-agent")).toHaveValue("support-bot"));
    // 清空预算 → 保存被拦，错误就地提示，不发 save_plan
    fireEvent.change(screen.getByTestId("sched-budget"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await screen.findByTestId("plan-form-error");
    expect(screen.getByTestId("plan-form-error")).toHaveTextContent("单次预算上限");
    expect(calls.some((c) => c.action === "save_plan")).toBe(false);
    // 负数同样拦截
    fireEvent.change(screen.getByTestId("sched-budget"), { target: { value: "-1" } });
    fireEvent.click(screen.getByTestId("plan-form-save"));
    expect(calls.some((c) => c.action === "save_plan")).toBe(false);
    // 补上合法预算 → 放行，请求体对象带新预算
    fireEvent.change(screen.getByTestId("sched-budget"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const call = calls.find((c) => c.action === "save_plan")!;
    expect((call.plan as Record<string, unknown>).schedule)
      .toEqual({ cron: "cron(0 3 ? * MON *)", budget_usd: 0.5 });
  });

  it("编辑回填三形态：对象原样；字符串遗留按 {cron, budget_usd:0} 回填并提示补预算；null 仅手动", async () => {
    // 形态 1：契约对象 → 简单档 + 预算回填
    const { unmount } = renderEditor({ ...PLAN, schedule: { cron: "0 3 * * 1", budget_usd: 4 } });
    await screen.findByTestId("plan-form-name");
    expect(screen.getByTestId("sched-mode-simple")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sched-budget")).toHaveValue(4);
    unmount();
    // 形态 2：存量 DDB 旧字符串 → cron 照常回填，预算 0 触发补预算警示（保存会被拦）
    const { unmount: unmount2 } = renderEditor({ ...PLAN, schedule: "cron(0 3 ? * MON *)" });
    await screen.findByTestId("plan-form-name");
    expect(screen.getByTestId("sched-mode-simple")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sched-day-1")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sched-budget-note")).toHaveTextContent("请设置预算");
    unmount2();
    // 形态 3：null → 仅手动，无预算输入
    renderEditor({ ...PLAN, schedule: null });
    await screen.findByTestId("plan-form-name");
    expect(screen.getByTestId("sched-mode-manual")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("sched-budget")).toBeNull();
  });

  it("observe 会话范围：三字段渲染 + 默认值（30/10/不含测试会话），metrics 全选默认", async () => {
    renderEditor();
    await screen.findByTestId("plan-form-name");
    await primeEvaluatorsLoaded(); // 默认评估器/指标在点击时捕获——先等元数据就绪
    fireEvent.click(screen.getByTestId("plan-form-add-observe"));
    expect(screen.getByTestId("plan-stage-card-0-observe-cfg")).toBeInTheDocument();
    // 三字段默认值照后端 .get 默认：30 / 10 / false
    const lookback = screen.getByTestId("plan-stage-card-0-lookback");
    const maxSessions = screen.getByTestId("plan-stage-card-0-max-sessions");
    expect(lookback).toHaveValue(30);
    // 三个字段的 title 讲解（「从最近 N 天的线上会话中抽样」「…这是成本闸门」
    // 「evaltest- 前缀的会话…默认排除」）对任何方案恒成立 ⇒ 删（prose-sweep 2026-09-03；
    // 此前钉的是 lookback 的 title **在**）
    expect(lookback).not.toHaveAttribute("title");
    expectProseGone(screen.getByTestId("plan-stage-card-0-observe-cfg"),
      "线上会话中抽样", "成本闸门", "evaltest- 前缀");
    expect(maxSessions).toHaveValue(10);
    expect(screen.getByTestId("plan-stage-card-0-include-test")).not.toBeChecked();
    // metrics chips：中文标签 + 默认全选（default_metrics）
    const tokensChip = screen.getByTestId("plan-stage-card-0-metric-tokens");
    expect(tokensChip).toHaveTextContent("Token");
    expect(tokensChip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("plan-stage-card-0-metric-cost")).toHaveTextContent("预估成本");
    expect(screen.getByTestId("plan-stage-card-0-metric-latency")).toHaveAttribute("aria-pressed", "true");
    // 双标签只留名字：「（LLM 逐会话评分，按会话数计费）」「（从 trace 直接计算，零成本）」
    // 是解释，对任何方案恒成立 ⇒ 删（prose-sweep 2026-09-03；此前钉的是带括号的全句**在**）
    expectProseGone(screen.getByTestId("plan-stage-card-0"), "按会话数计费", "按环节类型过滤", "零成本");
    // 非 observe 卡不出现会话范围配置区
    fireEvent.click(screen.getByTestId("plan-form-add-dataset"));
    expect(screen.queryByTestId("plan-stage-card-1-observe-cfg")).toBeNull();
  });

  it("observe 会话范围：min/max 约束——失焦收口到 1-120 / 1-50", async () => {
    renderEditor();
    await screen.findByTestId("plan-form-name");
    const agentSelect = screen.getByTestId("plan-form-agent");
    await waitFor(() =>
      expect(within(agentSelect).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.click(screen.getByTestId("plan-form-add-observe"));
    const lookback = screen.getByTestId("plan-stage-card-0-lookback");
    const maxSessions = screen.getByTestId("plan-stage-card-0-max-sessions");
    // min/max 属性齐全（浏览器 spinner 的约束）
    expect(lookback).toHaveAttribute("min", "1");
    expect(lookback).toHaveAttribute("max", "120");
    expect(maxSessions).toHaveAttribute("min", "1");
    expect(maxSessions).toHaveAttribute("max", "50");
    // 手输超界值：失焦收口（min/max 属性挡不住键盘输入）
    fireEvent.change(lookback, { target: { value: "999" } });
    fireEvent.blur(lookback);
    expect(lookback).toHaveValue(120);
    fireEvent.change(lookback, { target: { value: "0" } });
    fireEvent.blur(lookback);
    expect(lookback).toHaveValue(1);
    fireEvent.change(maxSessions, { target: { value: "51" } });
    fireEvent.blur(maxSessions);
    expect(maxSessions).toHaveValue(50);
  });

  it("observe 会话范围：include_test 勾选进请求体；metrics 可增减多选", async () => {
    renderEditor();
    await screen.findByTestId("plan-form-name");
    fireEvent.change(screen.getByTestId("plan-form-name"), { target: { value: "线上评估" } });
    const agentSelect = screen.getByTestId("plan-form-agent");
    await waitFor(() =>
      expect(within(agentSelect).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(agentSelect, { target: { value: "support-bot" } });
    await primeEvaluatorsLoaded();
    fireEvent.click(screen.getByTestId("plan-form-add-observe"));
    // 勾选包含测试会话
    const includeTest = screen.getByTestId("plan-stage-card-0-include-test");
    fireEvent.click(includeTest);
    expect(includeTest).toBeChecked();
    // metrics 多选：取消 tokens/llm_calls/tool_calls，剩 cost+latency
    fireEvent.click(screen.getByTestId("plan-stage-card-0-metric-tokens"));
    fireEvent.click(screen.getByTestId("plan-stage-card-0-metric-llm_calls"));
    fireEvent.click(screen.getByTestId("plan-stage-card-0-metric-tool_calls"));
    expect(screen.getByTestId("plan-stage-card-0-metric-tokens"))
      .toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("plan-stage-card-0-metric-cost"))
      .toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const call = calls.find((c) => c.action === "save_plan")!;
    const stages = (call.plan as { stages: Record<string, unknown>[] }).stages;
    expect(stages).toEqual([{
      type: "observe",
      evaluators: [],
      lookback_days: 30,
      max_sessions: 10,
      include_test: true,
      metrics: ["cost", "latency"],
    }]);
  });

  it("observe 会话范围：三字段改值后请求体带全（保存形状）", async () => {
    renderEditor();
    await screen.findByTestId("plan-form-name");
    fireEvent.change(screen.getByTestId("plan-form-name"), { target: { value: "范围方案" } });
    const agentSelect = screen.getByTestId("plan-form-agent");
    await waitFor(() =>
      expect(within(agentSelect).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(agentSelect, { target: { value: "support-bot" } });
    await primeEvaluatorsLoaded();
    fireEvent.click(screen.getByTestId("plan-form-add-observe"));
    fireEvent.change(screen.getByTestId("plan-stage-card-0-lookback"), { target: { value: "60" } });
    fireEvent.change(screen.getByTestId("plan-stage-card-0-max-sessions"), { target: { value: "25" } });
    const chip = await screen.findByTestId("plan-stage-card-0-eval-helpfulness");
    fireEvent.click(chip);
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const call = calls.find((c) => c.action === "save_plan")!;
    expect(call.plan).toEqual({
      name: "范围方案",
      agent_name: "support-bot",
      stages: [{
        type: "observe",
        evaluators: ["helpfulness"],
        lookback_days: 60,
        max_sessions: 25,
        metrics: ["tokens", "cost", "latency", "llm_calls", "tool_calls"],
      }],
      schedule: null, // 未设定时 = null（契约：null/缺省 = 仅手动）
      trace_required: true, // 2026-09-08 起新建默认开，两态都显式带键
    });
  });

  it("observe 会话范围：编辑回填原样显示，保存原样带回（含已下架指标 key 仍可见）", async () => {
    const plan: import("../src/pages/plan/types").Plan = {
      plan_id: "plan-scope",
      name: "旧版方案",
      agent_name: "support-bot",
      updated_at: 1755500000,
      stages: [{
        type: "observe",
        evaluators: ["helpfulness"],
        lookback_days: 14,
        max_sessions: 20,
        include_test: true,
        metrics: ["tokens", "legacy_metric"], // legacy_metric 已不在元数据里
      }],
      schedule: "",
    };
    renderEditor(plan);
    await screen.findByTestId("plan-form-name");
    // 回填：三字段原样
    expect(screen.getByTestId("plan-stage-card-0-lookback")).toHaveValue(14);
    expect(screen.getByTestId("plan-stage-card-0-max-sessions")).toHaveValue(20);
    expect(screen.getByTestId("plan-stage-card-0-include-test")).toBeChecked();
    // metrics 回填：只选中存储里有的；已下架 key 并入选项仍可见/可取消
    expect(screen.getByTestId("plan-stage-card-0-metric-tokens"))
      .toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(screen.getByTestId("plan-stage-card-0-metric-cost"))
        .toHaveAttribute("aria-pressed", "false"));
    expect(screen.getByTestId("plan-stage-card-0-metric-legacy_metric"))
      .toHaveAttribute("aria-pressed", "true");
    // 保存：原样带回 + plan_id
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const call = calls.find((c) => c.action === "save_plan")!;
    expect((call.plan as Record<string, unknown>).plan_id).toBe("plan-scope");
    const stages = (call.plan as { stages: Record<string, unknown>[] }).stages;
    expect(stages).toEqual([{
      type: "observe",
      evaluators: ["helpfulness"],
      lookback_days: 14,
      max_sessions: 20,
      include_test: true,
      metrics: ["tokens", "legacy_metric"],
    }]);
  });

  it("observe 会话范围：老方案缺字段按默认值显示（30/10/不勾），保存不虚构 include_test", async () => {
    renderEditor(PLAN); // PLAN 的 observe 环节没有会话范围字段
    await screen.findByTestId("plan-form-name");
    expect(screen.getByTestId("plan-stage-card-0-lookback")).toHaveValue(30);
    expect(screen.getByTestId("plan-stage-card-0-max-sessions")).toHaveValue(10);
    expect(screen.getByTestId("plan-stage-card-0-include-test")).not.toBeChecked();
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-agent")).toHaveValue("support-bot"));
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const call = calls.find((c) => c.action === "save_plan")!;
    const stages = (call.plan as { stages: Record<string, unknown>[] }).stages;
    // 没动过的环节不虚构字段：与后端 .get 默认对齐（缺省不发）
    expect(stages[0]).toEqual({ type: "observe", evaluators: ["helpfulness"] });
  });

  it("observe 会话范围：新环节默认评估器/指标取自 evaluators 元数据 default/default_metrics", async () => {
    overrides.evaluators = () => [{
      ...EVALUATORS_EVENT,
      default: ["helpfulness"],
      default_metrics: ["tokens", "cost"],
    }];
    renderEditor();
    await screen.findByTestId("plan-form-name");
    await primeEvaluatorsLoaded();
    fireEvent.click(screen.getByTestId("plan-form-add-observe"));
    const evalChip = await screen.findByTestId("plan-stage-card-0-eval-helpfulness");
    expect(evalChip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("plan-stage-card-0-eval-coherence"))
      .toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("plan-stage-card-0-metric-tokens"))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("plan-stage-card-0-metric-latency"))
      .toHaveAttribute("aria-pressed", "false");
  });

  it("定时选择器·编辑回填两分支：EB 形态可解析进简单档；非法/rate 进高级档", async () => {
    // 分支 1：mock 数据形态 {cron: "cron(0 3 ? * MON *)", budget_usd: 2} → 简单档，周一 03:00
    const ebPlan = { ...PLAN, schedule: { cron: "cron(0 3 ? * MON *)", budget_usd: 2 } };
    const { unmount } = renderEditor(ebPlan);
    await screen.findByTestId("plan-form-name");
    expect(screen.getByTestId("sched-mode-simple")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sched-day-1")).toHaveAttribute("aria-pressed", "true");
    unmount();
    // 分支 2：rate(1 day)（mock plan-ccc333 保留的存量字符串形态）→ 高级档原样保留
    renderEditor({ ...PLAN, plan_id: "plan-ccc333", schedule: "rate(1 day)" });
    await waitFor(() =>
      expect(screen.getByTestId("sched-mode-advanced")).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("sched-cron-input")).toHaveValue("rate(1 day)");
  });

  it("定时选择器·保存拦截：高级档非法表达式就地报错，不发请求", async () => {
    renderEditor(PLAN);
    await screen.findByTestId("plan-form-name");
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-agent")).toHaveValue("support-bot"));
    fireEvent.click(screen.getByTestId("sched-mode-advanced"));
    fireEvent.change(screen.getByTestId("sched-cron-input"), { target: { value: "0 25 * * 1" } });
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await screen.findByTestId("plan-form-error");
    expect(screen.getByTestId("plan-form-error")).toHaveTextContent("定时表达式非法");
    expect(calls.some((c) => c.action === "save_plan")).toBe(false);
    // 标准 cron「日周同限」EventBridge 表达不了 → 同样拦截
    fireEvent.change(screen.getByTestId("sched-cron-input"), { target: { value: "0 3 15 * 1" } });
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-error")).toHaveTextContent("EventBridge"));
    expect(calls.some((c) => c.action === "save_plan")).toBe(false);
  });

  it("定时选择器·仅手动档保存发 null（后端契约：null/缺省 = 不定时）", async () => {
    renderEditor(PLAN); // 原 schedule {cron: "0 3 * * 1", budget_usd: 2} → 简单档
    await screen.findByTestId("plan-form-name");
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-agent")).toHaveValue("support-bot"));
    fireEvent.click(screen.getByTestId("sched-mode-manual"));
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const call = calls.find((c) => c.action === "save_plan")!;
    expect((call.plan as Record<string, unknown>).schedule).toBeNull();
  });

  it("定时选择器·rate(1 day) + 预算：对象原样直通", async () => {
    renderEditor({ ...PLAN, schedule: { cron: "rate(1 day)", budget_usd: 1.5 } });
    await screen.findByTestId("plan-form-name");
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-agent")).toHaveValue("support-bot"));
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const call = calls.find((c) => c.action === "save_plan")!;
    expect((call.plan as Record<string, unknown>).schedule)
      .toEqual({ cron: "rate(1 day)", budget_usd: 1.5 });
  });

  // ===== 悬空数据集引用（生产实测：数据集清空后老方案引用指向空气）=====
  it("悬空引用：警示行出现，下拉保留「xxx（已删除）」disabled 选项且为当前值", async () => {
    const plan: import("../src/pages/plan/types").Plan = {
      plan_id: "plan-dangle",
      name: "test2",
      agent_name: "support-bot",
      updated_at: 1755500000,
      stages: [
        { type: "dataset", dataset: "multiturn-smoke", evaluators: [] }, // 已删除的集合
        { type: "redteam", cases_dataset: "smoke-test", evaluators: [] }, // 红队同款
      ],
      schedule: null,
    };
    renderEditor(plan);
    await screen.findByTestId("plan-form-name");
    // 警示行：两个环节各一条
    const warns = await screen.findAllByTestId("stage-missing-dataset");
    expect(warns).toHaveLength(2);
    expect(warns[0]).toHaveTextContent("引用的数据集「multiturn-smoke」已被删除");
    expect(warns[0]).toHaveTextContent("请先在数据集页重建，或移除此环节");
    expect(warns[1]).toHaveTextContent("引用的数据集「smoke-test」已被删除");
    // 下拉：原引用不静默丢失——「xxx（已删除）」disabled 选项且为当前值
    const dsSelect = screen.getByTestId("plan-stage-card-0-dataset");
    expect(dsSelect).toHaveValue("multiturn-smoke");
    const gone = within(dsSelect).getByRole("option", { name: "multiturn-smoke（已删除）" });
    expect(gone).toBeDisabled();
    const casesSelect = screen.getByTestId("plan-stage-card-1-cases");
    expect(casesSelect).toHaveValue("smoke-test");
    expect(within(casesSelect).getByRole("option", { name: "smoke-test（已删除）" })).toBeDisabled();
  });

  it("悬空引用：保存被前端预检拦截——报错含环节号与集合名，不发请求", async () => {
    const plan: import("../src/pages/plan/types").Plan = {
      plan_id: "plan-dangle",
      name: "test2",
      agent_name: "support-bot",
      updated_at: 1755500000,
      stages: [{ type: "dataset", dataset: "multiturn-smoke", evaluators: [] }],
      schedule: null,
    };
    renderEditor(plan);
    await screen.findByTestId("plan-form-name");
    // 预检依赖 list_datasets（名单未就绪时按设计不判，见 PlanEditor datasetsReady），
    // 而 plan-form-agent 来自 discover——等 agent 会在名单未到时就点保存，预检放行、
    // 请求发出、无错误行（曾偶发红）。改等警示行出现＝名单已就绪。
    await screen.findByTestId("stage-missing-dataset");
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await screen.findByTestId("plan-form-error");
    expect(screen.getByTestId("plan-form-error"))
      .toHaveTextContent("环节 1：数据集 'multiturn-smoke' 不存在");
    expect(calls.some((c) => c.action === "save_plan")).toBe(false);
  });

  it("悬空引用：重选为存在的集合 → 警示消失、保存成功", async () => {
    const plan: import("../src/pages/plan/types").Plan = {
      plan_id: "plan-dangle",
      name: "test2",
      agent_name: "support-bot",
      updated_at: 1755500000,
      stages: [{ type: "dataset", dataset: "multiturn-smoke", evaluators: [] }],
      schedule: null,
    };
    renderEditor(plan);
    await screen.findByTestId("stage-missing-dataset");
    const dsSelect = screen.getByTestId("plan-stage-card-0-dataset");
    // 等 list_datasets 灌完（存在的集合选项已渲染）再重选
    await within(dsSelect).findByRole("option", { name: "faq-v3" });
    fireEvent.change(dsSelect, { target: { value: "faq-v3" } });
    expect(screen.queryByTestId("stage-missing-dataset")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-agent")).toHaveValue("support-bot"));
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const call = calls.find((c) => c.action === "save_plan")!;
    const stages = (call.plan as { stages: Record<string, unknown>[] }).stages;
    expect(stages).toEqual([{ type: "dataset", dataset: "faq-v3", evaluators: [] }]);
    await waitFor(() => expect(location.hash).toBe("#/plan/plan-dangle"));
  });

  // ===== UI-010：0 环节不放行注定失败的保存 =====
  // 此前只填名称 + 选 Agent（环节数 0）保存按钮就已启用，点下去要等一趟后端
  // 往返才报「方案至少要有一个环节」，且错误出现后焦点丢失。
  it("UI-010：0 环节禁用保存 → 添加后可保存 → 全部删除后再次禁用", async () => {
    renderEditor();
    await screen.findByTestId("plan-form-name");
    fireEvent.change(screen.getByTestId("plan-form-name"), { target: { value: "只填名字" } });
    const agentSelect = screen.getByTestId("plan-form-agent");
    await waitFor(() =>
      expect(within(agentSelect).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(agentSelect, { target: { value: "support-bot" } });
    // 名称 + Agent 都齐了，但环节数 0 → 仍禁用（此前这里已启用）
    expect(screen.getByTestId("plan-form-stage-count")).toHaveTextContent("0");
    expect(screen.getByTestId("plan-form-save")).toBeDisabled();
    // 就地提示在环节区，且保存按钮 aria-describedby 指过来（禁用原因可及）
    expect(screen.getByTestId("plan-form-stages-required"))
      .toHaveTextContent("至少添加一个评估环节");
    expect(screen.getByTestId("plan-form-save"))
      .toHaveAttribute("aria-describedby", "plan-form-stages-required");

    // 添加一个环节 → 启用，提示消失
    fireEvent.click(screen.getByTestId("plan-form-add-observe"));
    expect(screen.getByTestId("plan-form-save")).toBeEnabled();
    expect(screen.queryByTestId("plan-form-stages-required")).not.toBeInTheDocument();

    // 删光环节 → 再次禁用，提示回来
    fireEvent.click(screen.getByTestId("plan-stage-card-0-remove"));
    expect(screen.getByTestId("plan-form-stage-count")).toHaveTextContent("0");
    expect(screen.getByTestId("plan-form-save")).toBeDisabled();
    expect(screen.getByTestId("plan-form-stages-required")).toBeInTheDocument();
  });

  it("UI-010：0 环节点保存不发 save_plan 请求（禁用 + onSave 二道闸）", async () => {
    renderEditor();
    await screen.findByTestId("plan-form-name");
    fireEvent.change(screen.getByTestId("plan-form-name"), { target: { value: "只填名字" } });
    const agentSelect = screen.getByTestId("plan-form-agent");
    await waitFor(() =>
      expect(within(agentSelect).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(agentSelect, { target: { value: "support-bot" } });
    fireEvent.click(screen.getByTestId("plan-form-save"));
    // 加一个环节再删掉，确保走过一轮渲染；期间仍不该有 save_plan
    fireEvent.click(screen.getByTestId("plan-form-add-dataset"));
    fireEvent.click(screen.getByTestId("plan-stage-card-0-remove"));
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-stages-required")).toBeInTheDocument());
    // 关键验收：注定失败的请求一次都没发出
    expect(calls.some((c) => c.action === "save_plan")).toBe(false);
    expect(screen.queryByTestId("plan-form-error")).not.toBeInTheDocument();
  });

  it("UI-010：焦点送到环节区首个「+ 添加环节」按钮（报错后不丢焦点）", async () => {
    renderEditor();
    await screen.findByTestId("plan-form-name");
    // onSave 的 0 环节分支调用 focusStagesArea 把焦点送回环节区；
    // 这里直接验这段行为（保存按钮此刻是禁用的，onClick 不会派发）
    const addObserve = screen.getByTestId("plan-form-add-observe");
    addObserve.blur();
    expect(document.activeElement).not.toBe(addObserve);
    expect(focusStagesArea()).toBe(true);
    expect(document.activeElement).toBe(addObserve);
  });

  // ===== 陈旧 datasets 缓存不得误报「已删除」（UI-009 姐妹 bug）=====
  // 用户亲眼撞见：新建方案时环节里短暂显示「…（已删除）」，然后又消失。
  // 根因同族——datasetsReady 只判「有数据」不判「新鲜」，陈旧名单被当成权威。
  it("陈旧 datasets 缓存 + refetch 在途：不误报「（已删除）」，新名单回来后正常", async () => {
    const qc = newQc();
    // 陈旧缓存：faq-v3 还没进过名单（比如上次取数时它尚未创建）
    qc.setQueryData(["datasets"], {
      event: "datasets",
      datasets: [{ name: "old-only", kind: "regression", target_agent: "", case_count: 1 }],
    });
    // refetch 挂闸门：全程在途，此刻组件手里只有陈旧名单
    let release!: () => void;
    const gate = new Promise<unknown[]>((resolve) => {
      release = () => resolve([DATASETS_EVENT]);
    });
    overrides.list_datasets = () => gate as unknown as Promise<unknown[]>;

    // 环节引用 faq-v3——真实存在，只是不在陈旧名单里
    const plan: import("../src/pages/plan/types").Plan = {
      plan_id: "plan-stale",
      name: "test-stale",
      agent_name: "support-bot",
      updated_at: 1755500000,
      stages: [{ type: "dataset", dataset: "faq-v3", evaluators: [] }],
      schedule: null,
    };
    renderEditor(plan, qc);
    // 锚点挑「只有目标环节卡渲染完才成立」的元素（下拉本体），不用中间态共用的 testid
    const dsSelect = await screen.findByTestId("plan-stage-card-0-dataset");
    // 取数在途：既不出警示行，也不出「（已删除）」disabled 选项
    expect(screen.queryByTestId("stage-missing-dataset")).not.toBeInTheDocument();
    expect(within(dsSelect).queryByRole("option", { name: "faq-v3（已删除）" }))
      .not.toBeInTheDocument();

    // 新名单回来（faq-v3 确实存在）→ 依然无误报，且成了正常可选项
    release();
    await within(dsSelect).findByRole("option", { name: "faq-v3" });
    expect(screen.queryByTestId("stage-missing-dataset")).not.toBeInTheDocument();
    expect(dsSelect).toHaveValue("faq-v3");
  });

  it("陈旧缓存期间保存不被误拦：预检同用新鲜闸门，合法引用照发请求", async () => {
    const qc = newQc();
    qc.setQueryData(["datasets"], {
      event: "datasets",
      datasets: [{ name: "old-only", kind: "regression", target_agent: "", case_count: 1 }],
    });
    // 闸门全程在途：点保存的瞬间组件手里只有陈旧名单（faq-v3 不在其中）
    const gate = new Promise<unknown[]>(() => { /* 永不 resolve：锁死陈旧窗口 */ });
    overrides.list_datasets = () => gate as unknown as Promise<unknown[]>;

    const plan: import("../src/pages/plan/types").Plan = {
      plan_id: "plan-stale2",
      name: "test-stale2",
      agent_name: "support-bot", // agentName 由 plan 直接初始化，canSave 无需等 discover
      updated_at: 1755500000,
      stages: [{ type: "dataset", dataset: "faq-v3", evaluators: [] }], // 真实存在
      schedule: null,
    };
    renderEditor(plan, qc);
    await screen.findByTestId("plan-stage-card-0-dataset");
    fireEvent.click(screen.getByTestId("plan-form-save"));
    // 陈旧名单不该把合法引用误判成「不存在」而白拦一次保存
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    expect(screen.queryByTestId("plan-form-error")).not.toBeInTheDocument();
  });

  it("名单新鲜后集合真的不存在：悬空提示能力保留（真警示 + 保存拦截）", async () => {
    // 与上一条互为对照：同样走陈旧缓存 → 新名单，但引用的集合在新名单里也没有
    const qc = newQc();
    qc.setQueryData(["datasets"], {
      event: "datasets",
      datasets: [{ name: "old-only", kind: "regression", target_agent: "", case_count: 1 }],
    });
    const plan: import("../src/pages/plan/types").Plan = {
      plan_id: "plan-gone",
      name: "test-gone",
      agent_name: "support-bot",
      updated_at: 1755500000,
      stages: [{ type: "dataset", dataset: "really-gone", evaluators: [] }],
      schedule: null,
    };
    renderEditor(plan, qc);
    // 新名单到齐后才判 → 真悬空仍被抓出（这是先前专门修的能力，不能改坏）
    const warn = await screen.findByTestId("stage-missing-dataset");
    expect(warn).toHaveTextContent("引用的数据集「really-gone」已被删除");
    const dsSelect = screen.getByTestId("plan-stage-card-0-dataset");
    expect(within(dsSelect).getByRole("option", { name: "really-gone（已删除）" })).toBeDisabled();
    // 保存仍被前端预检拦截，不发请求
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await screen.findByTestId("plan-form-error");
    expect(screen.getByTestId("plan-form-error"))
      .toHaveTextContent("环节 1：数据集 'really-gone' 不存在");
    expect(calls.some((c) => c.action === "save_plan")).toBe(false);
  });

  it("编辑模式：回填 + 保存带 plan_id；后端 error 原文展示", async () => {
    renderEditor(PLAN);
    await screen.findByTestId("plan-form-name");
    expect(screen.getByTestId("plan-form-name")).toHaveValue("FAQ 周回归");
    // "0 3 * * 1" 可回填 → 定时选择器进简单档，周一选中，只读框显示生成的 EB 形态
    expect(screen.getByTestId("sched-mode-simple")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sched-day-1")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sched-cron-readonly")).toHaveTextContent("cron(0 3 ? * MON *)");
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-agent")).toHaveValue("support-bot"));
    expect(screen.getByTestId("plan-form-stage-count")).toHaveTextContent("2");

    overrides.save_plan = () => [{ event: "error", error: "ValueError: stage 缺 dataset" }];
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await screen.findByTestId("plan-form-error");
    expect(screen.getByTestId("plan-form-error")).toHaveTextContent("ValueError: stage 缺 dataset");
    // 请求体带 plan_id
    const call = calls.find((c) => c.action === "save_plan")!;
    expect((call.plan as Record<string, unknown>).plan_id).toBe("plan-aaa111");
  });
});

// ==================== 红队环节攻击策略多选（#70 遗漏项） ====================
describe("红队攻击策略多选", () => {
  /** 建一张红队卡并等策略菜单灌进 chips。waitFor 锚点：策略 chip 本身——
      只有 redteam_options 数据到齐才渲染，不等默认文案共用的中间态元素。 */
  async function setupRedteamStage() {
    renderEditor();
    await screen.findByTestId("plan-form-name");
    fireEvent.change(screen.getByTestId("plan-form-name"), { target: { value: "红队方案" } });
    const agentSelect = screen.getByTestId("plan-form-agent");
    await waitFor(() =>
      expect(within(agentSelect).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(agentSelect, { target: { value: "support-bot" } });
    fireEvent.click(screen.getByTestId("plan-form-add-redteam"));
    await screen.findByTestId("plan-stage-card-0-strategy-gradual_escalation");
  }

  it("redteam 卡渲染策略 chip 多选（全量菜单、初始全不选）+ 默认策略提示；非红队卡不渲染", async () => {
    await setupRedteamStage();
    const picker = screen.getByTestId("plan-stage-card-0-strategies");
    for (const name of ["gradual_escalation", "goat", "bad_likert_judge", "pair"]) {
      // 不把 default_strategies 预填成选中——否则语义从「跟随默认」变「锁死当前默认」
      expect(within(picker).getByTestId(`plan-stage-card-0-strategy-${name}`))
        .toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.getByTestId("plan-stage-card-0-strategies-note"))
      .toHaveTextContent("未选择时使用默认策略集");
    // chip 上显示的是人类可读 label（不是 name，更不能是 "[object Object]"）。
    // 线上事故：菜单元素是对象，直渲触发 React error #31 整页白屏——此断言即哨兵。
    expect(within(picker).getByTestId("plan-stage-card-0-strategy-gradual_escalation"))
      .toHaveTextContent("渐进升级");
    expect(picker).not.toHaveTextContent("[object Object]");
    // 非红队卡无策略区
    fireEvent.click(screen.getByTestId("plan-form-add-observe"));
    fireEvent.click(screen.getByTestId("plan-form-add-dataset"));
    expect(screen.queryByTestId("plan-stage-card-1-strategies")).toBeNull();
    expect(screen.queryByTestId("plan-stage-card-2-strategies")).toBeNull();
  });

  it("点选两个策略 → 保存请求 stages[0].strategies 为点选顺序数组", async () => {
    await setupRedteamStage();
    fireEvent.click(screen.getByTestId("plan-stage-card-0-strategy-goat"));
    fireEvent.click(screen.getByTestId("plan-stage-card-0-strategy-bad_likert_judge"));
    expect(screen.getByTestId("plan-stage-card-0-strategy-goat"))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("plan-stage-card-0-strategy-bad_likert_judge"))
      .toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const call = calls.find((c) => c.action === "save_plan")!;
    const stages = (call.plan as { stages: Record<string, unknown>[] }).stages;
    expect(stages[0].strategies).toEqual(["goat", "bad_likert_judge"]);
  });

  it("不选（含点选后全部取消）→ 请求不含 strategies 字段 = 后端跟随默认名单", async () => {
    await setupRedteamStage();
    // 点选再取消：显式空数组同样剥掉（planrun.py:93 `or DEFAULT_STRATEGIES`
    // 语义下空数组等价缺失，缺失才是「跟随默认」的规范表达）
    fireEvent.click(screen.getByTestId("plan-stage-card-0-strategy-goat"));
    fireEvent.click(screen.getByTestId("plan-stage-card-0-strategy-goat"));
    expect(screen.getByTestId("plan-stage-card-0-strategy-goat"))
      .toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const call = calls.find((c) => c.action === "save_plan")!;
    const stages = (call.plan as { stages: Record<string, unknown>[] }).stages;
    expect("strategies" in stages[0]).toBe(false);
    expect(stages[0]).toEqual({ type: "redteam", cases_dataset: "", evaluators: [] });
  });

  it("编辑回填：存量 strategies 选中；菜单已下架的策略名并入选项仍可见/可取消", async () => {
    const plan: import("../src/pages/plan/types").Plan = {
      plan_id: "plan-rt",
      name: "红队巡检",
      agent_name: "support-bot",
      updated_at: 1755500000,
      stages: [{
        type: "redteam", cases_dataset: "jailbreak-probes", evaluators: [],
        strategies: ["gradual_escalation", "legacy_attack"],
      }],
      schedule: null,
    };
    renderEditor(plan);
    // 锚点：菜单里的未选中 chip（goat 只来自 redteam_options 数据）
    await screen.findByTestId("plan-stage-card-0-strategy-goat");
    expect(screen.getByTestId("plan-stage-card-0-strategy-gradual_escalation"))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("plan-stage-card-0-strategy-legacy_attack"))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("plan-stage-card-0-strategy-goat"))
      .toHaveAttribute("aria-pressed", "false");
    // 取消已下架策略后保存：字段只剩 gradual_escalation
    fireEvent.click(screen.getByTestId("plan-stage-card-0-strategy-legacy_attack"));
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-agent")).toHaveValue("support-bot"));
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const call = calls.find((c) => c.action === "save_plan")!;
    const stages = (call.plan as { stages: Record<string, unknown>[] }).stages;
    expect(stages[0].strategies).toEqual(["gradual_escalation"]);
  });
});
