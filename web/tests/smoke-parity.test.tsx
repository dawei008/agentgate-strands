// W3 冒烟等价性补测：旧版 scripts/ui_smoke.py 128 条断言里，
// React 版功能存在但 Vitest 没盖到的部分（b 类）。
// 覆盖：登录门三态 / 导航切换与 hash 路由 / 术语五词 / KPI·表格关键文案 /
//       错误形态（error 事件原文）/ toast·警告条 aria / 设计令牌计算值。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expectProseGone } from "./prose";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTest } from "../src/lib/config";
import { sseFrames, AGENT_PLANS, AGENT_RUNS } from "../src/mocks/handlers";
import Shell from "../src/components/layout/Shell";
import { parseHash } from "../src/router";
import { showToast } from "../src/components/toast";
import { useSession } from "../src/stores/session";
// tokens.css 原文：vitest 的 css 管线会把 ?raw 也吞成空串，直接读文件。
// jsdom 支持 <style> 注入后 getComputedStyle 取自定义属性。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// vitest 的 cwd = web/（vite.config.ts 所在目录）；jsdom 环境下
// import.meta.url 是 http scheme，不能 fileURLToPath。
const tokensCss = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action?: string } & Record<string, unknown>;

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function defaultDispatch(payload: Payload): Response {
  switch (payload.action) {
    case "list_plans":
      return sseResponse([{ event: "plans", plans: AGENT_PLANS }]);
    case "list_recent_runs":
      return sseResponse([{ event: "recent_runs", runs: AGENT_RUNS }]);
    case "discover":
      return sseResponse([{ event: "agents", agents: [] }]);
    case "evaluators":
      // 形态照后端契约：内置散在三个名字数组，自定义在 custom（共 3+1+1+1 = 6）
      return sseResponse([{
        event: "evaluators",
        available: ["coherence", "helpfulness", "refusal"],
        dataset_only: ["correctness"],
        multimodal: ["mm_correctness"],
        scopes: {}, default: [],
        custom: [{ name: "brand_tone", scope: "both", updated_at: 1755000000, blocks: [] }],
      }]);
    case "list_datasets":
      return sseResponse([{
        event: "datasets",
        datasets: [{
          name: "faq-regression-v3", kind: "regression",
          case_count: 1, cases: [{ name: "c1", input: "q", expected_output: "a" }],
          target_agent: "", risk_categories: [], updated_at: 1755500000,
        }],
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

/** beforeEach 里 stub 的请求记录（供「不为角标发请求」类断言用） */
let apiCalls: Payload[] = [];
const stubbedCalls = () => apiCalls;

function renderShell(): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}><Shell /></QueryClientProvider> as ReactElement);
}

beforeEach(() => {
  resetConfigForTest();
  apiCalls = stubFetch();
  location.hash = "#/workbench";
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.classList.remove("is-authed");
  document.querySelectorAll(".wb-toast").forEach((el) => el.remove());
});

// ---------- 登录门三态（旧冒烟 #13 未登录块；一步化后语义更新） ----------
describe("登录门形态", () => {
  /** 一步化后 AuthGate 未登录会 location.assign 跳 Cognito：jsdom 不支持导航，换可写桩 */
  function stubLocationForGate() {
    const assign = vi.fn();
    vi.stubGlobal("location", { origin: "http://localhost:3000", hash: "#/workbench", search: "", assign });
    return assign;
  }

  it("从未登录：一步化——门显示跳转中间态并自动跳 Cognito（带 lang=zh-CN），body 不带 is-authed", async () => {
    useSession.setState({ token: null, authed: false, everAuthed: false, authExpired: false });
    const assign = stubLocationForGate();
    renderShell();
    expect(screen.getByTestId("auth-gate")).toBeInTheDocument();
    expect(screen.getByTestId("auth-redirecting")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-login")).not.toBeInTheDocument();
    expect(document.body.classList.contains("is-authed")).toBe(false);
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(String(assign.mock.calls[0][0])).toContain("/oauth2/authorize");
    expect(String(assign.mock.calls[0][0])).toContain("lang=zh-CN");
  });

  it("登出回跳（signed_out 标记）：门面页可见（已退出登录 + 重新登录），不自动跳；Cognito 说明已删", async () => {
    useSession.setState({ token: null, authed: false, everAuthed: false, authExpired: false });
    sessionStorage.setItem("agentgate_signed_out", "1");
    const assign = stubLocationForGate();
    renderShell();
    expect(screen.getByTestId("auth-gate")).toHaveTextContent("已退出登录");
    expect(screen.getByTestId("auth-login")).toHaveTextContent("重新登录");
    // 此前钉的是「使用组织账户安全登录。身份验证由 Amazon Cognito 提供」**在** —— 对任何
    // 用户恒成立 ⇒ 删；默认态那句「登录后管理评估方案、运行记录和质量报告」同理
    // （prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("auth-gate"), "Amazon Cognito", "使用组织账户", "登录后管理");
    await new Promise((r) => setTimeout(r, 20));
    expect(assign).not.toHaveBeenCalled();
    sessionStorage.removeItem("agentgate_signed_out");
  });

  it("从未登录：页面上不得出现「登录已过期」（不为没发生过的事道歉）", async () => {
    useSession.setState({ token: null, authed: false, everAuthed: false, authExpired: false });
    const assign = stubLocationForGate();
    renderShell();
    expect(document.body.textContent).not.toContain("登录已过期");
    // 账户行随侧栏撤除搬进设置抽屉（头像 = 入口）；原钉 account-who 直接在版面
    fireEvent.click(screen.getByTestId("topnav-user"));
    expect(screen.getByTestId("account-who")).toHaveTextContent("未登录");
    // 等自动跳转落在桩上，避免测试结束后 unstub 让 assign 打到真 jsdom location
    await waitFor(() => expect(assign).toHaveBeenCalled());
  });

  it("已登录：门不渲染，body.is-authed，账户行（抽屉内）显示已登录 + 退出按钮", () => {
    renderShell();
    expect(screen.queryByTestId("auth-gate")).not.toBeInTheDocument();
    expect(document.body.classList.contains("is-authed")).toBe(true);
    fireEvent.click(screen.getByTestId("topnav-user"));
    expect(screen.getByTestId("account-who")).toHaveTextContent("已登录");
    expect(screen.getByTestId("account-logout")).toBeInTheDocument();
  });

  it("登录过期：门保持关闭（旧数据可见），role=alert 警告条 + 重新登录按钮", () => {
    useSession.setState({ token: null, authed: false, everAuthed: true, authExpired: true });
    renderShell();
    expect(screen.queryByTestId("auth-gate")).not.toBeInTheDocument();
    const banner = screen.getByTestId("auth-expired-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent("登录已过期");
    // 「请重新登录后继续操作」与旁边的按钮同义 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(banner, "请重新登录后继续操作");
    expect(within(banner).getByTestId("auth-relogin")).toHaveTextContent("重新登录");
    fireEvent.click(screen.getByTestId("topnav-user"));
    expect(screen.getByTestId("account-who")).toHaveTextContent("登录已过期");
  });
});

// ---------- 导航切换与 hash 路由（旧冒烟 #4/#6） ----------
// 2026-09-03 ADR-0016：左侧栏改单行顶栏。原钉「侧栏五项按拍板顺序 …/评估分析」改钉
// 「主线 Agent + 次级 评估计划/评估器/数据集」；「评估分析」项、计数角标两条钉子随契约撤除
// （前者改反向钉，后者改反向钉）；parseHash 默认落点由 workbench 改 agents。
describe("导航切换", () => {
  it("顶栏两组导航按契约顺序；当前项 aria-current=page；点击切 hash", () => {
    renderShell();
    const primary = screen.getByRole("navigation", { name: "主导航" });
    expect(within(primary).getAllByRole("button").map((b) => b.textContent)).toEqual(["Agent"]);
    const assets = screen.getByRole("navigation", { name: "评估资产" });
    const buttons = within(assets).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["评估计划", "评估器", "数据集"]);
    expect(buttons.map((b) => b.dataset.testid)).toEqual([
      "nav-workbench", "nav-evaluators", "nav-datasets",
    ]);
    expect(screen.getByTestId("nav-workbench")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("nav-agents")).not.toHaveAttribute("aria-current");
    fireEvent.click(screen.getByTestId("nav-agents"));
    expect(location.hash).toBe("#/agents");
  });

  // 原钉「侧栏评估分析项：点击切 #/compare，且不渲染角标」→ 反向：评估分析不在导航里，
  // 路由本身保留可直达（#/compare），且到了那页没有任何导航项被点亮。
  it("评估分析不在导航里，但 #/compare 路由保留可直达；该页零导航项激活", () => {
    location.hash = "#/compare";
    renderShell();
    expect(screen.queryByTestId("nav-compare")).toBeNull();
    expect(screen.getByTestId("topnav")).not.toHaveTextContent("评估分析");
    expect(screen.getByTestId("page-compare")).toBeInTheDocument();
    expect(document.querySelector('[data-testid^="nav-"][aria-current="page"]')).toBeNull();
  });

  // 原钉「导航计数：缓存有值才显示，无缓存不渲染角标」→ 角标整体撤除：数据到齐也没有。
  it("导航零角标：工作台数据到齐后没有任何 nav-*-count，也不为导航多发请求", async () => {
    renderShell();
    await screen.findByTestId("plans-table");
    expect(document.querySelector('[data-testid^="nav-"][data-testid$="-count"]')).toBeNull();
    const actions = stubbedCalls().map((c) => c.action);
    expect(actions).not.toContain("discover");
    expect(actions).not.toContain("evaluators");
    expect(actions).not.toContain("list_datasets");
  });

  it("详情页在导航上归属父列表：#/agent/:name 高亮 Agent 项", () => {
    location.hash = "#/agent/support-bot";
    renderShell();
    expect(screen.getByTestId("nav-agents")).toHaveAttribute("aria-current", "page");
  });

  it("parseHash：plan/new、plan/:id/edit、run/:id、未知 hash 与空 hash 落首页（Agent）", () => {
    expect(parseHash("#/plan/new")).toEqual({ view: "plan-new" });
    expect(parseHash("#/plan/p-1/edit")).toEqual({ view: "plan-edit", id: "p-1" });
    expect(parseHash("#/run/plan-a%23202608")).toEqual({ view: "run", id: "plan-a#202608" });
    expect(parseHash("#/nonsense")).toEqual({ view: "agents" });
    expect(parseHash("")).toEqual({ view: "agents" });
  });

  it("skip-link 存在且主区可编程聚焦（tabIndex=-1）", () => {
    renderShell();
    expect(screen.getByTestId("skip-link")).toHaveTextContent("跳到主要内容");
    expect(screen.getByTestId("main")).toHaveAttribute("tabindex", "-1");
  });
});

// ---------- 术语（2026-08-29 用户改版：评估计划/评估器/数据集/评估分析 + 三环节原词） ----------
describe("术语定案", () => {
  it("顶栏出现 评估计划/评估器/数据集/Agent（评估分析不在导航里）；环节链出现 线上评估/回归测试/红队测试", async () => {
    renderShell();
    const top = screen.getByTestId("topnav");
    expect(top).toHaveTextContent("评估计划");
    expect(top).toHaveTextContent("评估器");
    expect(top).toHaveTextContent("数据集");
    expect(top).toHaveTextContent("Agent");
    expect(top).not.toHaveTextContent("评估分析");
    // 方案表环节链（异步加载）
    // 环节链只显示方案真含的环节（用户定案）——plan[0] 含线上+回归，红队词在 plan[1]
    const stages = await screen.findByTestId(`plan-row-${AGENT_PLANS[0].plan_id}-stages`);
    expect(stages).toHaveTextContent("线上评估");
    expect(stages).toHaveTextContent("回归测试");
    const rtStages = screen.getByTestId(`plan-row-${AGENT_PLANS[1].plan_id}-stages`);
    expect(rtStages).toHaveTextContent("红队测试");
  });

  // 原钉「#i-logo sprite + prod 角标」：顶栏品牌 mark 换成门/闸几何（#i-gate，viewBox 20），
  // 环境 chip 仍 testid brand-env、以 prod 开头（region 段由 config/discover 现取，本页
  // 未拉 discover ⇒ 只有 prod）。#i-logo 仍在 sprite 里（登录卡在用）。
  it("品牌区：AgentGate 名 + #i-gate sprite 引用 + prod 环境 chip", () => {
    renderShell();
    const brand = screen.getByTestId("brand");
    expect(brand.textContent).toContain("AgentGate");
    expect(brand.querySelector("svg use")?.getAttribute("href")).toBe("#i-gate");
    expect(document.getElementById("i-gate")?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(screen.getByTestId("brand-env")).toHaveTextContent(/^prod$/);
  });
});

// ---------- KPI / 表格关键文案（旧冒烟 #1/#2/#12） ----------
describe("工作台关键文案", () => {
  // 批 plans-board：hero 从「线上评估均分」换成「下次运行」（ADR-0016：均分只作观测量，
  // 留在 Agent ① 现状）；次级三格 = 带定时计划数 / 本月花费 / 近 24h 运行数
  it("KPI 四格标签：下次运行/带定时计划数/本月花费/近 24h 运行数；「均分」不在这页", async () => {
    renderShell();
    const strip = await screen.findByTestId("kpi-strip");
    expect(strip).toHaveTextContent("下次运行");
    expect(strip).toHaveTextContent("带定时计划数");
    expect(strip).toHaveTextContent("本月花费");
    expect(strip).toHaveTextContent("近 24h 运行数");
    expect(strip).not.toHaveTextContent("均分");
  });

  it("计划表/最近运行表头齐全 + 一次性 UTC 时区声明（单元格无 UTC 后缀）", async () => {
    renderShell();
    const plansTable = await screen.findByTestId("plans-table");
    for (const h of ["计划名", "Agent", "环节", "定时", "单次预算 $", "本月花费 $", "下次运行", "最近结果", "操作"]) {
      expect(within(plansTable).getByRole("columnheader", { name: h })).toBeInTheDocument();
    }
    const runsCard = await screen.findByTestId("runs-card");
    expect(runsCard).toHaveTextContent("时间为 UTC");
    const runsTable = within(runsCard).getByTestId("runs-table");
    expect(within(runsTable).getAllByRole("cell").some((td) => td.textContent?.includes(" UTC")))
      .toBe(false);
  });

  it("skipped run 状态可见（旧冒烟：跳过 run 不冒充成功）", async () => {
    renderShell();
    const row = await screen.findByTestId("run-row-plan-ccc333#2026-08-21T03:00:00Z");
    expect(row).toHaveTextContent("跳过");
    expect(row.querySelector(".badge.ok")).toBeNull();
  });
});

// ---------- 错误形态（error 事件拦截提示） ----------
describe("错误形态", () => {
  it("list_plans 回 error 事件 → 页面显示 error 原文（不静默）", async () => {
    vi.unstubAllGlobals();
    stubFetch({
      list_plans: () => sseResponse([{ event: "error", error: "后端炸了：DynamoDB 限流" }]),
    });
    renderShell();
    const err = await screen.findByTestId("plans-load-error");
    expect(err).toHaveTextContent("后端炸了：DynamoDB 限流");
  });

  it("toast 是 role=status（aria-live 礼貌通报），到时自动移除", () => {
    vi.useFakeTimers();
    showToast("已开始");
    const toast = document.querySelector(".wb-toast");
    expect(toast).not.toBeNull();
    expect(toast).toHaveAttribute("role", "status");
    expect(toast).toHaveTextContent("已开始");
    vi.advanceTimersByTime(3000);
    expect(document.querySelector(".wb-toast")).toBeNull();
    vi.useRealTimers();
  });
});

// ---------- 设计令牌计算值（design-b 教训：换肤只动 tokens.css 一处） ----------
describe("设计令牌计算值（v3-C 暗色玻璃）", () => {
  it("--bg 为 C 案画布色且玻璃五件套齐全（空值 = :root 被注释杀掉）", () => {
    const style = document.createElement("style");
    style.textContent = tokensCss;
    document.head.appendChild(style);
    try {
      const cs = getComputedStyle(document.documentElement);
      // C 案画布：#0F172A 暗色（不是空、也不是浅色残留）
      expect(cs.getPropertyValue("--bg").trim().toLowerCase()).toBe("#0f172a");
      expect(cs.getPropertyValue("--accent").trim().toLowerCase()).toBe("#22c55e");
      // 玻璃五件套（纪律 1 的物质基础）一个不能空
      expect(cs.getPropertyValue("--glass-bg").trim()).toContain("rgba(27, 35, 54");
      expect(cs.getPropertyValue("--glass-border").trim()).not.toBe("");
      expect(cs.getPropertyValue("--glass-blur").trim()).toContain("blur(16px)");
      expect(cs.getPropertyValue("--glass-sheen").trim()).not.toBe("");
      expect(cs.getPropertyValue("--glass-shadow").trim()).not.toBe("");
      // 主按钮承文字：绿底配深字（白字压亮绿不达标）
      expect(cs.getPropertyValue("--text-on-accent").trim().toLowerCase()).toBe("#0f172a");
      // 焦点环 outline 型（box-shadow 环会被玻璃 glow 吃掉——原型实测坑）
      expect(cs.getPropertyValue("--focus-outline").trim()).toContain("#4ADE80");
      expect(cs.getPropertyValue("--shadow").trim()).not.toBe("");
    } finally {
      style.remove();
    }
  });
});
