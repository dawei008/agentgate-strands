// Agent 详情四 Tab 枢纽（ADR-0016 ①②④ + ③ 临时挂载，批 agent-hub）。
// 真夹具：src/mocks/handlers 的 agent_status 桩（support-bot / research-agent）、AGENT_RUNS、
// AGENT_PLANS；plan_runs 按用例覆写（默认桩对 plan-ddd444 返回 []）。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AGENT_PLANS, AGENT_RUNS, MOCK_PLAN_RUN, MOCK_PLAN_RUN_PREV, PLAN_RUNS, PREV_RUN_KEY, agentStatusOf } from "../../src/mocks/handlers";
import AgentDetailPage from "../../src/pages/agents/AgentDetailPage";
import AgentsPage from "../../src/pages/agents/AgentsPage";
import ReportPage from "../../src/pages/report/ReportPage";
import { activeNav } from "../../src/components/layout/TopNav";
import { parseHash } from "../../src/router";
import { agentTabHash } from "../../src/pages/agents/detail/hub/tabs";
import { renderPage, setupAgentsPageHooks, sseResponse, stubFetch, type Payload } from "./harness";

setupAgentsPageHooks();

const LAST_KEY = "plan-ddd444#2026-08-21T05:00:00Z";
const PREV_KEY = "plan-ddd444#2026-08-14T05:00:00Z";
/** plan-ddd444 的两次 completed（list_plan_runs 投影）：#1 = 08-14 通过率 80%，#2 = last_run 那次 90% */
const DDD_RUNS = [
  { run_key: LAST_KEY, status: "completed", score: null, started_at: "2026-08-21 05:00 UTC", duration_s: 52,
    stage_summaries: [{ type: "dataset", status: "completed", pass_rate: 0.9, cases: 10, blank_cases: 0,
      evaluators: ["correctness", "refusal"],
      evaluator_stats: { correctness: { mean: 0.94 }, refusal: { mean: 0.55 } } }], proposals: [] },
  { run_key: PREV_KEY, status: "completed", score: null, started_at: "2026-08-14 05:00 UTC", duration_s: 50,
    stage_summaries: [{ type: "dataset", status: "completed", pass_rate: 0.8, cases: 10, blank_cases: 0,
      evaluators: ["correctness", "refusal"],
      evaluator_stats: { correctness: { mean: 0.9 }, refusal: { mean: 0.58 } } }],
    proposals: [{ summary: "补充退货政策知识库", generated_at: "2026-08-14 05:10 UTC", adopted_at: "" }] },
];
const dddRuns = (p: Payload) => sseResponse([{
  event: "plan_runs", plan_id: p.plan_id, runs: p.plan_id === "plan-ddd444" ? DDD_RUNS : [],
}]);
const ESTIMATE = (p: Payload) => sseResponse([{
  event: "plan_run_estimate", plan_id: p.plan_id, stages: [{ type: "dataset" }], estimated_cost_usd: 2.0,
}]);

describe("hash 子路由：#/agent/<name>/status|evaluate|optimize|config", () => {
  it("无子段落 ① 现状；四段各解析成对应 tab；?this= 解码成预选 run_key", () => {
    expect(parseHash("#/agent/support-bot")).toEqual({ view: "agent", name: "support-bot", tab: "status", thisKey: undefined });
    expect(parseHash("#/agent/support-bot/status")).toMatchObject({ tab: "status" });
    expect(parseHash("#/agent/support-bot/evaluate")).toMatchObject({ name: "support-bot", tab: "evaluate" });
    expect(parseHash("#/agent/support-bot/config")).toMatchObject({ tab: "config" });
    expect(parseHash(agentTabHash("support-bot", "optimize", LAST_KEY)))
      .toEqual({ view: "agent", name: "support-bot", tab: "optimize", thisKey: LAST_KEY });
    expect(agentTabHash("support-bot", "status")).toBe("#/agent/support-bot");
    // 名字里的编码字符照旧先拼后解；末段不是 tab 名就是名字的一部分
    expect(parseHash("#/agent/a%2Fb")).toMatchObject({ name: "a/b", tab: "status" });
  });

  it("顶栏归属：四个子路由都点亮「Agent」", () => {
    for (const t of ["", "/status", "/evaluate", "/optimize", "/config"]) {
      expect(activeNav(parseHash(`#/agent/support-bot${t}`))).toBe("agents");
    }
  });
});

describe("枢纽页壳：页头 + 四 Tab", () => {
  it("默认落 ① 现状：Tab 名恰为 现状/评估/优化/配置，① 选中、其余面板 hidden", async () => {
    stubFetch({ estimate_plan_run: ESTIMATE });
    renderPage(<AgentDetailPage name="support-bot" />);
    const tabs = screen.getByTestId("agent-tabs");
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent?.replace(/[①②③④]/g, "").trim().split(/\s|\d/)[0]))
      .toEqual(["现状", "评估", "优化", "配置"]);
    expect(screen.getByTestId("agent-tab-status")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("agent-tab-panel-status")).not.toHaveAttribute("hidden");
    for (const t of ["evaluate", "optimize", "config"]) {
      expect(screen.getByTestId(`agent-tab-${t}`)).toHaveAttribute("aria-selected", "false");
      expect(screen.getByTestId(`agent-tab-panel-${t}`)).toHaveAttribute("hidden");
    }
    // 点 Tab = 改 hash（子路由）
    fireEvent.click(screen.getByTestId("agent-tab-config"));
    expect(location.hash).toBe("#/agent/support-bot/config");
    fireEvent.click(screen.getByTestId("agent-tab-status"));
    expect(location.hash).toBe("#/agent/support-bot");
  });

  it("页头：主按钮「运行「<计划名>」· 预估 $」；元信息 RUNTIME / 版本变更 / 下次运行", async () => {
    stubFetch({ estimate_plan_run: ESTIMATE });
    renderPage(<AgentDetailPage name="support-bot" />);
    const btn = await screen.findByTestId("agent-run-latest");
    await waitFor(() => expect(btn).toHaveTextContent("运行「FAQ 周回归」 · 预估 $2.00"));
    expect(await screen.findByTestId("agent-head-runtime")).toHaveTextContent("runtime/support-bot-abc123");
    expect(screen.getByTestId("agent-head-updated")).toHaveTextContent("2026-08-10");
    // 下次运行 = agent_status.next_run（FAQ 周回归 · 下周一 03:00）
    await waitFor(() => expect(screen.getByTestId("agent-head-next").textContent).toMatch(/^\d{2}-\d{2} 03:00$/));
    // 无 running 行 ⇒ 不画运行中胶囊
    expect(screen.queryByTestId("agent-head-running")).toBeNull();
  });

  it("有 running 行 ⇒ 页头运行中胶囊 · 计划名，点 → 计划详情", async () => {
    stubFetch({
      list_recent_runs: () => sseResponse([{ event: "recent_runs", runs: AGENT_RUNS.filter((r) => r.agent_name === "research-agent") }]),
      agent_status: () => sseResponse([{ event: "agent_status", ...agentStatusOf("research-agent") }]),
    });
    renderPage(<AgentDetailPage name="research-agent" />);
    const pill = await screen.findByTestId("agent-head-running");
    expect(pill).toHaveTextContent("运行中 · 调研全链路验收");
    fireEvent.click(pill);
    expect(location.hash).toBe("#/plan/plan-ccc333");
  });

  it("Tab 小字：① 「1 条告警 · run #2 完成」② 「N 计划 · M 次运行」③ 「1 未采纳」④ 「已配置」", async () => {
    stubFetch({ list_plan_runs: dddRuns, estimate_plan_run: ESTIMATE });
    renderPage(<AgentDetailPage name="support-bot" />);
    await waitFor(() => expect(screen.getByTestId("agent-tab-status-sum")).toHaveTextContent("1 条告警 · run #2 完成"));
    const plans = AGENT_PLANS.filter((p) => p.agent_name === "support-bot").length;
    const runs = AGENT_RUNS.filter((r) => r.agent_name === "support-bot").length;
    expect(screen.getByTestId("agent-tab-evaluate-sum")).toHaveTextContent(`${plans} 计划 · ${runs} 次运行`);
    await waitFor(() => expect(screen.getByTestId("agent-tab-optimize-sum")).toHaveTextContent("1 未采纳"));
    await waitFor(() => expect(screen.getByTestId("agent-tab-config-sum")).toHaveTextContent("已配置"));
  });

  it("术语七词：四个面板渲染完，页面 textContent 里「方案」出现 0 次", async () => {
    stubFetch({ list_plan_runs: dddRuns, estimate_plan_run: ESTIMATE });
    renderPage(<AgentDetailPage name="support-bot" />);
    await screen.findByTestId("agent-plans-table");
    await screen.findByTestId("agent-runs-table");
    await screen.findByTestId("agent-config-response-path");
    await screen.findByTestId("agent-identity-display-name");
    const text = screen.getByTestId("page-agent-detail").textContent ?? "";
    const hits = text.match(/方案/g)?.length ?? 0;
    expect(hits, `「方案」在页面文本里出现 ${hits} 次`).toBe(0);
    // 阳性对照：换成术语后的词真在
    expect(text).toContain("评估计划");
  });
});

describe("① 现状", () => {
  it("五个观测数各带较前一日；会话量曲线；null 画「—」且原因进 title", async () => {
    stubFetch({ list_plan_runs: dddRuns, estimate_plan_run: ESTIMATE });
    renderPage(<AgentDetailPage name="support-bot" />);
    const obs = await screen.findByTestId("agent-obs");
    expect(within(obs).getByTestId("agent-obs-sessions")).toHaveTextContent("4,812");
    // (4812 − 4530) / 4530 = 6.2%
    expect(within(obs).getByTestId("agent-obs-sessions-delta")).toHaveTextContent("▲ 6.2% 较前一日 4,530");
    expect(within(obs).getByTestId("agent-obs-spark")).toBeInTheDocument();
    expect(within(obs).getByTestId("agent-obs-p95")).toHaveTextContent("3.4s");
    expect(within(obs).getByTestId("agent-obs-p95")).toHaveTextContent("▼ 0.3s 较前一日");
    expect(within(obs).getByTestId("agent-obs-cost")).toHaveTextContent("$41.60");
    expect(within(obs).getByTestId("agent-obs-cost")).toHaveTextContent("▲ $3.10 较前一日");
    expect(within(obs).getByTestId("agent-obs-blank")).toHaveTextContent("1.8%");
    expect(within(obs).getByTestId("agent-obs-blank")).toHaveTextContent("▲ 0.4pp");
    expect(within(obs).getByTestId("agent-obs-toolfail")).toHaveTextContent("2.6%");
    expect(within(obs).getByTestId("agent-obs-toolfail")).toHaveTextContent("▼ 0.9pp");
    // 上升 = 变差 → warn；下降 → 默认色
    expect(within(obs).getByTestId("agent-obs-cost").querySelector(".delta")).toHaveClass("warn");
    expect(within(obs).getByTestId("agent-obs-p95").querySelector(".delta")).not.toHaveClass("warn");
  });

  it("research-agent：五个数全 null → 五个「—」、title 带原因、不画曲线；下次运行 — 带 rate 原因；无 CloudWatch", async () => {
    stubFetch({
      list_recent_runs: () => sseResponse([{ event: "recent_runs", runs: [] }]),
    });
    renderPage(<AgentDetailPage name="research-agent" />);
    const obs = await screen.findByTestId("agent-obs");
    for (const id of ["agent-obs-p95", "agent-obs-cost", "agent-obs-blank", "agent-obs-toolfail"]) {
      const v = within(obs).getByTestId(id).querySelector(".kpi-v")!;
      expect(v).toHaveTextContent("—");
      expect(v.getAttribute("title")).toContain("没有 span 组");
    }
    expect(within(obs).getByTestId("agent-obs-sessions").querySelector(".kpi-v")!.getAttribute("title")).toContain("没有 span 组");
    expect(within(obs).queryByTestId("agent-obs-spark")).toBeNull();
    // 不编数：观测条里没有任何数字冒充观测值
    expect(obs.textContent).not.toMatch(/\d\.\d%|\$\d|\d\.\ds/);
    const at = screen.getByTestId("agent-next-run-at");
    expect(at).toHaveTextContent("—");
    expect(at.getAttribute("title")).toContain("rate(1 day)");
    expect(screen.queryByTestId("agent-cloudwatch")).toBeNull();
    expect(screen.getByTestId("agent-cloudwatch-none").getAttribute("title")).toContain("没有 span 组");
    // 最近一次为 skipped：状态原话上 badge
    expect(screen.getByTestId("agent-last-run-status")).toHaveTextContent("skipped");
  });

  it("最近一次评估：run #2 · 计划名 · 时刻；线上评估分「—」/ 回归 90.0%（唯一来源 dataset_pass_rate）/ 红队「—」；较 run #1 只给有符号差、无 ▲▼", async () => {
    stubFetch({ list_plan_runs: dddRuns, estimate_plan_run: ESTIMATE });
    renderPage(<AgentDetailPage name="support-bot" />);
    const card = await screen.findByTestId("agent-last-run");
    await waitFor(() => expect(within(card).getByTestId("agent-last-run-sub")).toHaveTextContent("run #2 · 下单意图回归 · 2026-08-21 05:01 UTC"));
    expect(within(card).getByTestId("agent-last-observe")).toHaveTextContent("—");
    const ds = within(card).getByTestId("agent-last-dataset");
    expect(ds).toHaveTextContent("90.0%");
    expect(ds).toHaveTextContent("+10.0pp 较 run #1");
    expect(ds.textContent).not.toMatch(/[▲▼]/);
    expect(within(card).getByTestId("agent-last-redteam")).toHaveTextContent("—");
    // 分数位不显示合成均分
    expect(card.textContent).not.toContain("均分");
    fireEvent.click(within(card).getByTestId("agent-last-run-report"));
    expect(location.hash).toBe(`#/report/${encodeURIComponent(LAST_KEY)}`);
  });

  // 回归格的两态（后端已不再给 dataset_pass 那个 X/Y 字段，批 simp-A2）：
  // 现造 agent_status 桩——rate 有值 ⇒ 百分数、无 title；rate 为 null ⇒ 「—」+ rate 自己的原因进 title。
  it("回归格只读 dataset_pass_rate：有值给百分数（无 title）/ null 给「—」+ last_run.dataset_pass_rate 的原话", async () => {
    const base = agentStatusOf("support-bot") as unknown as Record<string, unknown> & {
      last_run: Record<string, unknown>; unavailable_reason: Record<string, string>;
    };
    const REASON = "多个回归环节，摘要项无 judged_cases 无法合并";
    const statusWith = (rate: number | null, reason: Record<string, string>) => () => sseResponse([{
      event: "agent_status", ...base,
      last_run: { ...base.last_run, dataset_pass_rate: rate },
      unavailable_reason: reason,
    }]);

    // 反向钉：桩里硬塞回 dataset_pass 的 X/Y 形态，格子里也不许出现它（那条读法已删）
    stubFetch({
      agent_status: () => sseResponse([{
        event: "agent_status", ...base,
        last_run: { ...base.last_run, dataset_pass: "8/10", dataset_pass_rate: 0.9 },
        unavailable_reason: {},
      }]),
      list_plan_runs: dddRuns, estimate_plan_run: ESTIMATE,
    });
    const legacy = renderPage(<AgentDetailPage name="support-bot" />);
    await waitFor(() => expect(screen.getByTestId("agent-last-dataset")).toHaveTextContent("90.0%"));
    expect(screen.getByTestId("agent-last-dataset").textContent).not.toContain("8/10");
    legacy.unmount();

    stubFetch({ agent_status: statusWith(0.9, {}), list_plan_runs: dddRuns, estimate_plan_run: ESTIMATE });
    const first = renderPage(<AgentDetailPage name="support-bot" />);
    const has = await screen.findByTestId("agent-last-dataset");
    await waitFor(() => expect(has).toHaveTextContent("90.0%"));
    expect(has.querySelector(".v")!.getAttribute("title")).toBeNull();
    first.unmount();

    stubFetch({
      agent_status: statusWith(null, { "last_run.dataset_pass_rate": REASON }),
      list_plan_runs: dddRuns, estimate_plan_run: ESTIMATE,
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    const none = await screen.findByTestId("agent-last-dataset");
    await waitFor(() => expect(none.querySelector(".v")).toHaveTextContent("—"));
    expect(none.querySelector(".v")!.getAttribute("title")).toBe(REASON);
    // 不编数：这一格没有任何百分数冒充通过率
    expect(none.textContent).not.toMatch(/\d\.\d%/);
  });

  it("告警卡：1 条「refusal 连续 3 次未过目标线 0.7」+ 三个值；点 → ③；下次运行卡：计划 chip · 时刻 · 预估 $ · CloudWatch 深链", async () => {
    stubFetch({ list_plan_runs: dddRuns, estimate_plan_run: ESTIMATE });
    renderPage(<AgentDetailPage name="support-bot" />);
    const alerts = await screen.findByTestId("agent-alerts");
    expect(within(alerts).getByTestId("agent-alerts-count")).toHaveTextContent("1");
    const row = within(alerts).getByTestId("agent-alert");
    expect(row).toHaveTextContent("「下单意图回归」refusal 连续 3 次未过目标线 0.7");
    expect(row).toHaveTextContent("0.61 / 0.58 / 0.55");
    fireEvent.click(row);
    expect(location.hash).toBe("#/agent/support-bot/optimize");

    const next = screen.getByTestId("agent-next-run");
    expect(within(next).getByTestId("agent-next-run-plan")).toHaveTextContent("FAQ 周回归");
    expect(within(next).getByTestId("agent-next-run-at").textContent).toMatch(/^\d{2}-\d{2} 03:00约 \d+ (小时|天)后$/);
    await waitFor(() => expect(within(next).getByTestId("agent-next-run-cost")).toHaveTextContent("$2.00 预估"));
    expect(within(next).getByTestId("agent-cloudwatch")).toHaveAttribute("href", expect.stringContaining("console.aws.amazon.com/cloudwatch"));
    expect(within(next).getByTestId("agent-cloudwatch")).toHaveAttribute("target", "_blank");
  });

  it("agent_status 报错：原话直出，不吞", async () => {
    stubFetch({ agent_status: () => sseResponse([{ event: "error", error: "Agent 'support-bot' 不存在" }]) });
    renderPage(<AgentDetailPage name="support-bot" />);
    expect(await screen.findByTestId("agent-status-error")).toHaveTextContent("Agent 'support-bot' 不存在");
  });
});

describe("② 评估 / ③ 优化 / ④ 配置", () => {
  it("② 面板 = 评估计划表 + 运行历史；run 行 → 运行报告", async () => {
    stubFetch({ estimate_plan_run: ESTIMATE });
    renderPage(<AgentDetailPage name="support-bot" tab="evaluate" />);
    const panel = screen.getByTestId("agent-tab-panel-evaluate");
    expect(panel).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("agent-tab-panel-status")).toHaveAttribute("hidden");
    await within(panel).findByTestId("agent-plans-table");
    const runs = await within(panel).findByTestId("agent-runs-table");
    fireEvent.click(within(runs).getByTestId("agent-run-row-plan-aaa111#2026-08-11T09:00:00Z-open"));
    expect(location.hash).toBe("#/report/plan-aaa111%232026-08-11T09%3A00%3A00Z");
  });

  it("③ 自动选口径：这一次 = 最近一次 completed（run #2）· 上一次 = 同计划 run #1；「任意两次对比」→ #/compare/<prev>/<this>", async () => {
    stubFetch({ list_plan_runs: dddRuns, estimate_plan_run: ESTIMATE });
    renderPage(<AgentDetailPage name="support-bot" tab="optimize" />);
    const head = await screen.findByTestId("agent-optimize-head");
    await waitFor(() => expect(within(head).getByTestId("agent-optimize-prev")).toHaveTextContent("上一次run #1"));
    expect(within(head).getByTestId("agent-optimize-this")).toHaveTextContent("这一次run #2 · 下单意图回归");
    fireEvent.click(within(head).getByTestId("agent-optimize-compare"));
    expect(location.hash).toBe(`#/compare/${encodeURIComponent(PREV_KEY)}/${encodeURIComponent(LAST_KEY)}`);
    // DDD_RUNS 没有 synthesis_issues（老形状）⇒ 回落挂 AnalysisSections：#1 的那条处方在「未采纳」组；
    // 合成分趋势卡不挂（评估器面板取代它，ADR-0016 口径修订），台账不画
    expect(await screen.findByTestId("analysis-adoption")).toHaveTextContent("补充退货政策知识库");
    expect(screen.queryByTestId("analysis-trend")).toBeNull();
    expect(screen.queryByTestId("agent-issue-ledger")).toBeNull();
    expect(screen.getByTestId("agent-evaluator-headline")).toHaveTextContent("2 个评估器 · 1 过线 · refusal 0.55 未过");
    expect(screen.getByTestId("agent-optimize").textContent).not.toContain("均分");
  });

  it("③ ?this= 预选：这一次 = run #1，没有更早的 completed ⇒ 上一次「—」、不挂分析块", async () => {
    stubFetch({ list_plan_runs: dddRuns, estimate_plan_run: ESTIMATE });
    renderPage(<AgentDetailPage name="support-bot" tab="optimize" thisKey={PREV_KEY} />);
    const head = await screen.findByTestId("agent-optimize-head");
    await waitFor(() => expect(within(head).getByTestId("agent-optimize-this")).toHaveTextContent("这一次run #1"));
    await waitFor(() => expect(within(head).getByTestId("agent-optimize-prev")).toHaveTextContent("上一次—"));
    expect(screen.queryByTestId("analysis-sections")).toBeNull();
  });

  it("③ 没有 completed run ⇒ 空态一句", async () => {
    stubFetch({ list_recent_runs: () => sseResponse([{ event: "recent_runs", runs: [] }]) });
    renderPage(<AgentDetailPage name="support-bot" tab="optimize" />);
    expect(await screen.findByTestId("agent-optimize-empty")).toHaveTextContent("还没有已完成的运行");
  });

  it("④ 面板 = 身份与版本 + 调用配置", async () => {
    stubFetch();
    renderPage(<AgentDetailPage name="support-bot" tab="config" />);
    const panel = screen.getByTestId("agent-tab-panel-config");
    expect(panel).not.toHaveAttribute("hidden");
    expect(within(panel).getByTestId("agent-identity-block")).toBeInTheDocument();
    expect(within(panel).getByTestId("agent-config-block")).toBeInTheDocument();
  });
});

describe("门：首页卡片格 / 报告页页脚", () => {
  it("首页评估行 → ②，优化行 → ③", async () => {
    stubFetch({
      discover: () => sseResponse([{ event: "agents", region: "us-west-2", from_cache: false, agents: [
        { agent_name: "support-bot", runtime_arn: "", source: "agentcore", has_logs: true, display_name: "", version_label: "" },
        { agent_name: "research-agent", runtime_arn: "", source: "agentcore", has_logs: false, display_name: "", version_label: "" },
      ] }]),
      list_plan_runs: dddRuns,
    });
    renderPage(<AgentsPage />);
    const card = await screen.findByTestId("agent-card-support-bot");
    fireEvent.click(await within(card).findByTestId("agent-card-support-bot-eval"));
    expect(location.hash).toBe("#/agent/support-bot/evaluate");
    fireEvent.click(within(card).getByTestId("agent-card-support-bot-opt"));
    expect(location.hash).toBe("#/agent/support-bot/optimize");
    fireEvent.click(within(card).getByTestId("agent-card-support-bot-obs"));
    expect(location.hash).toBe("#/agent/support-bot");
  });

  it("报告页「与上次对比」→ 该 Agent 的 ③，带 ?this=<本次 run_key>", async () => {
    stubFetch({
      list_plans: () => sseResponse([{ event: "plans", plans: AGENT_PLANS }]),
      list_plan_runs: (p) => sseResponse([{ event: "plan_runs", plan_id: p.plan_id, runs: PLAN_RUNS }]),
      get_plan_run: (p) => sseResponse([{
        event: "plan_run", ...(String(p.run_key) === PREV_RUN_KEY ? MOCK_PLAN_RUN_PREV : MOCK_PLAN_RUN), run_key: p.run_key,
      }]),
      list_datasets: () => sseResponse([{ event: "datasets", datasets: [] }]),
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ReportPage id={MOCK_PLAN_RUN.run_key} /></QueryClientProvider>);
    const btn = await screen.findByTestId("report-drawer-compare");
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    expect(location.hash).toBe(agentTabHash("support-bot", "optimize", MOCK_PLAN_RUN.run_key));
    expect(location.hash).toContain("/optimize?this=");
  });
});
