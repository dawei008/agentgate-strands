// Agent 详情页页面动作测试（原 agents-pages.test.tsx 的「AgentDetailPage 页面动作」describe，断言零语义改动）。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expectProseGone } from "../prose";
import { beforeEach, describe, expect, it } from "vitest";
import { resetRunFlightForTest } from "../../src/lib/runFlight";
import AgentDetailPage from "../../src/pages/AgentDetailPage";
import AgentsPage from "../../src/pages/AgentsPage";
import PlanEditor from "../../src/pages/plan/PlanEditor";
import { useSession } from "../../src/stores/session";
import {
  renderPage, setupAgentsPageHooks, sseResponse, stubFetch, type Payload,
} from "./harness";

setupAgentsPageHooks();
// 在飞状态是模块级的（lib/runFlight，缺陷 1）：逐测清零，否则上一条用例发起的 run
// 会让下一条的「运行」按钮一上来就是 disabled 的「运行中…」
beforeEach(() => { resetRunFlightForTest(); });

// ---------- 详情页可操作化（用户点名「除了看什么都干不了」） ----------
describe("AgentDetailPage 页面动作", () => {
  // 缺陷 2 起：两处发起运行入口（方案行「运行」/ 页头「运行最新方案」）都多
  // 一步二次确认卡（花真钱的动作不许一击直发）。ESTIMATE 形态逐字照真后端
  // （app/main.py:1414-1416 的 {event, plan_id, **estimate} + planrun.py:91-93）。
  const ESTIMATE = (p: Payload) => sseResponse([{
    event: "plan_run_estimate",
    plan_id: p.plan_id,
    stages: [{ type: "observe", judge_calls: 20, estimated_cost_usd: 0.42,
               note: "线上评估环节：仅产生 judge 费用，不调用被测 Agent" }],
    estimated_cost_usd: 0.42,
    note: "各环节预估合计（运行结束后还会生成一次评估计划级综合报告，"
      + "增加一次 judge 调用费用）；实际以运行为准",
  }]);

  it("方案行「运行」：确认后发 run_plan + toast「已开始」+ 跳 #/plan/:id，不触发行点击", async () => {
    const calls = stubFetch({
      run_plan: () => sseResponse([{ event: "run_started", plan_id: "plan-aaa111" }]),
      estimate_plan_run: ESTIMATE,
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    await screen.findByTestId("agent-plans-table");
    fireEvent.click(screen.getByTestId("agent-plan-row-plan-aaa111-run"));
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await waitFor(() => {
      expect(calls.some((c) => c.action === "run_plan" && c.plan_id === "plan-aaa111")).toBe(true);
    });
    // 缺陷 1 起：「已开始」要等后端首个事件（请求已发出 ≠ 后端已接单）
    await waitFor(() => expect(screen.getByTestId("toast")).toHaveTextContent("已开始"));
    // 跳的是方案详情（看进度），不是行点击的同款路径撞两次
    expect(location.hash).toBe("#/plan/plan-aaa111");
  });

  it("方案行「运行」点一下只开确认卡：不发 run_plan、不跳转；卡上有方案名与预估费用", async () => {
    const calls = stubFetch({ estimate_plan_run: ESTIMATE });
    renderPage(<AgentDetailPage name="support-bot" />);
    await screen.findByTestId("agent-plans-table");
    fireEvent.click(screen.getByTestId("agent-plan-row-plan-aaa111-run"));
    const card = screen.getByTestId("confirm-card");
    expect(card).toHaveAttribute("aria-label", "发起运行");
    expect(card).toHaveTextContent("FAQ 周回归");
    expect(calls.some((c) => c.action === "run_plan")).toBe(false);
    // 行点击（进详情）也不许被带出来
    expect(location.hash).toBe("");
    // 锚点挑目标数据专属：预估格里的真数字，不是「运行」这类通用文案
    await waitFor(() =>
      expect(screen.getByTestId("run-confirm-cost")).toHaveTextContent("$0.42"));
    // 取消 → 依旧一个请求都不发
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    expect(calls.some((c) => c.action === "run_plan")).toBe(false);
    expect(location.hash).toBe("");
  });

  it("区块头 [+ 新建评估计划]：跳 #/plan/new 且编辑器预选当前 Agent", async () => {
    stubFetch();
    const { unmount } = renderPage(<AgentDetailPage name="support-bot" />);
    await screen.findByTestId("agent-plans-table");
    fireEvent.click(screen.getByTestId("agent-plans-new"));
    expect(location.hash).toBe("#/plan/new");
    unmount();
    // 模拟路由切换后挂载编辑器：agent 下拉应预填 support-bot
    renderPage(<PlanEditor />);
    // 受控 select：等 discover 的选项载入后 value 才能生效
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-agent")).toHaveValue("support-bot"));
  });

  it("预选是一次性的：编辑器消费后再直进 #/plan/new 不残留", async () => {
    stubFetch();
    const detail = renderPage(<AgentDetailPage name="support-bot" />);
    await screen.findByTestId("agent-plans-table");
    fireEvent.click(screen.getByTestId("agent-plans-new"));
    detail.unmount();
    const first = renderPage(<PlanEditor />);
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-agent")).toHaveValue("support-bot"));
    first.unmount();
    // 第二次直进（没经过 Agent 详情页入口）：不该带上次的预选
    renderPage(<PlanEditor />);
    expect(screen.getByTestId("plan-form-agent")).toHaveValue("");
  });

  it("空态（该 Agent 无评估计划）：文案 + [+ 新建评估计划] 同样带预选", async () => {
    stubFetch({
      list_plans: () => sseResponse([{ event: "plans", plans: [] }]),
    });
    const { unmount } = renderPage(<AgentDetailPage name="research-agent" />);
    const empty = await screen.findByTestId("agent-plans-empty");
    // 改钉（agent-hub 批）：术语七词 —— 「评估方案」→「评估计划」
    expect(empty).toHaveTextContent("还没有评估计划");
    // 副句「为该 Agent 创建第一个方案，把线上评估、回归测试与红队测试串成一条链」是
    // 使用说明 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(empty, "串成一条链");
    fireEvent.click(within(empty).getByTestId("agent-plans-empty-new"));
    expect(location.hash).toBe("#/plan/new");
    unmount();
    renderPage(<PlanEditor />);
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-agent")).toHaveValue("research-agent"));
  });

  // 改钉（agent-hub 批）：按钮文案「运行最新方案」→「运行「<计划名>」· 预估 $」（title 不变）
  it("页头有计划态：主按钮按 updated_at 挑最新的发 run_plan + 跳其详情", async () => {
    const calls = stubFetch({
      run_plan: () => sseResponse([{ event: "run_started" }]),
      estimate_plan_run: ESTIMATE,
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    const btn = await screen.findByTestId("agent-run-latest");
    expect(btn).toHaveClass("btn", "btn-primary");
    // 假数据：plan-aaa111 updated_at=1755500000 > plan-bbb222 updated_at=1755300000
    expect(btn).toHaveAttribute("title", "运行「FAQ 周回归」");
    // 无方案态的新建按钮此时不该出现
    expect(screen.queryByTestId("agent-head-new-plan")).toBeNull();
    fireEvent.click(btn);
    // 二次确认卡：卡上写明挑中的是哪个方案（页头按钮自己不说方案名，
    // 挑错方案的误运行就靠这一步兜住）+ 预估费用
    const card = screen.getByTestId("confirm-card");
    expect(card).toHaveTextContent("FAQ 周回归");
    expect(calls.some((c) => c.action === "run_plan")).toBe(false);
    await waitFor(() =>
      expect(screen.getByTestId("run-confirm-cost")).toHaveTextContent("$0.42"));
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await waitFor(() => {
      expect(calls.some((c) => c.action === "run_plan" && c.plan_id === "plan-aaa111")).toBe(true);
    });
    expect(location.hash).toBe("#/plan/plan-aaa111");
  });

  it("页头无计划态：主按钮变 [+ 新建评估计划]（带预选），无运行按钮", async () => {
    stubFetch({
      list_plans: () => sseResponse([{ event: "plans", plans: [] }]),
    });
    const { unmount } = renderPage(<AgentDetailPage name="research-agent" />);
    const btn = await screen.findByTestId("agent-head-new-plan");
    expect(btn).toHaveClass("btn", "btn-primary");
    expect(screen.queryByTestId("agent-run-latest")).toBeNull();
    fireEvent.click(btn);
    expect(location.hash).toBe("#/plan/new");
    unmount();
    renderPage(<PlanEditor />);
    await waitFor(() =>
      expect(screen.getByTestId("plan-form-agent")).toHaveValue("research-agent"));
  });

  // 改钉（agent-hub 批）：原「页头次级动作『管理调用配置』滚动到调用配置区块」——四 Tab
  // 枢纽后调用配置住在 ④ 配置 Tab，页头不再有这颗按钮；入口 = 点 Tab ④（改 hash 子路由）。
  it("调用配置的入口 = Tab ④ 配置：点 → #/agent/<name>/config，面板里就是调用配置区块", async () => {
    stubFetch();
    renderPage(<AgentDetailPage name="support-bot" tab="config" />);
    expect(screen.queryByTestId("agent-goto-config")).toBeNull();
    fireEvent.click(screen.getByTestId("agent-tab-config"));
    expect(location.hash).toBe("#/agent/support-bot/config");
    expect(within(screen.getByTestId("agent-tab-panel-config")).getByTestId("agent-config-block")).toBeInTheDocument();
  });

  it("运行历史区块头「查看全部 →」跳工作台", async () => {
    stubFetch();
    renderPage(<AgentDetailPage name="support-bot" />);
    await screen.findByTestId("agent-runs-table");
    fireEvent.click(screen.getByTestId("agent-runs-all"));
    expect(location.hash).toBe("#/workbench");
  });

  it("未登录：计划行运行 / 新建 / 页头主按钮全部 disabled", async () => {
    useSession.setState({ token: null, authed: false, everAuthed: false, authExpired: false });
    stubFetch();
    renderPage(<AgentDetailPage name="support-bot" />);
    await screen.findByTestId("agent-plans-table");
    expect(screen.getByTestId("agent-plan-row-plan-aaa111-run")).toBeDisabled();
    expect(screen.getByTestId("agent-plans-new")).toBeDisabled();
    expect(await screen.findByTestId("agent-run-latest")).toBeDisabled();
  });

  // ---------- 统一返回位（用户点名「所有页面没有返回按钮」） ----------
  it("详情页页头有返回位：← Agent，点击回目录页", async () => {
    stubFetch();
    renderPage(<AgentDetailPage name="support-bot" />);
    const back = screen.getByTestId("pagehead-back");
    expect(back).toHaveTextContent("Agent");
    expect(back).toHaveClass("btn-link");
    fireEvent.click(back);
    expect(location.hash).toBe("#/agents");
  });

  it("一级页（Agent 目录）页头无返回位", async () => {
    stubFetch();
    renderPage(<AgentsPage />);
    // 首页改卡片（ADR-0016）：锚点由 agents-table 改 agents-grid
    await screen.findByTestId("agents-grid");
    expect(screen.queryByTestId("pagehead-back")).toBeNull();
  });
});
