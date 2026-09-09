// 资源库拆页 + 导航项改名（2026-08-29 用户拍板；2026-09-03 ADR-0016 侧栏→顶栏）的专属钉子：
// ❶ 两个新页各自渲染（评估器表格在 #/evaluators、四 tab 在 #/datasets）
// ❷ 旧链接 #/resources 落到评估器页（重定向语义，不保留 resources view）
// ❸ 顶栏两组顺序与 label 逐字（主线 Agent；次级 评估计划/评估器/数据集）
// ❹ 角标随顶栏契约撤除（反向钉）
// 锚点纪律：断言挑目标页专属数据（评估器页的「新建评估器」入口、
// 数据集页的 testdata-tab-redteam），不拿两页都有的东西当锚。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTest } from "../src/lib/config";
import { sseFrames } from "../src/mocks/handlers";
import Shell from "../src/components/layout/Shell";
import { parseHash } from "../src/router";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action?: string } & Record<string, unknown>;

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// 评估器 3+1+1 内置 + 1 自定义 = 6（角标断言用这个非平凡值）
const EVALUATORS_EVENT = {
  event: "evaluators",
  available: ["coherence", "helpfulness", "refusal"],
  dataset_only: ["correctness"],
  multimodal: ["mm_correctness"],
  scopes: {}, default: [],
  custom: [{ name: "brand_tone", scope: "both", updated_at: 1755000000, blocks: null }],
};

// 数据集 2 回归 + 1 红队 = 3：tab 计数 2/1，角标 = 数组全量 3（口径钉）
const DATASETS_EVENT = {
  event: "datasets",
  datasets: [
    { name: "faq-a", kind: "regression", case_count: 1,
      cases: [{ name: "c1", input: "q", expected_output: "a" }],
      target_agent: "", risk_categories: [], updated_at: 1755500000 },
    { name: "faq-b", kind: "regression", case_count: 1,
      cases: [{ name: "c1", input: "q2", expected_output: "a2" }],
      target_agent: "", risk_categories: [], updated_at: 1755500001 },
    { name: "rt-probes", kind: "redteam", case_count: 1,
      cases: [{ name: "c1", input: "攻击", risk_category: "guideline_bypass" }],
      target_agent: "bot", risk_categories: ["guideline_bypass"], updated_at: 1755500002 },
  ],
};

function dispatch(payload: Payload): Response {
  switch (payload.action) {
    case "evaluators": return sseResponse([EVALUATORS_EVENT]);
    case "list_datasets": return sseResponse([DATASETS_EVENT]);
    case "list_plans": return sseResponse([{ event: "plans", plans: [] }]);
    case "list_recent_runs": return sseResponse([{ event: "recent_runs", runs: [] }]);
    case "discover": return sseResponse([{ event: "agents", agents: [] }]);
    default: return sseResponse([{ event: "error", error: `未实现 ${payload.action}` }]);
  }
}

function renderShell(): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}><Shell /></QueryClientProvider> as ReactElement);
}

beforeEach(() => {
  resetConfigForTest();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("config.json")) return Response.json(CFG);
    return dispatch(JSON.parse(String(init?.body)) as Payload);
  }));
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.classList.remove("is-authed");
  location.hash = "";
});

describe("拆页：两个新页各自渲染", () => {
  it("#/evaluators 是评估器页：新建评估器入口 + 表格行，且没有数据集四 tab", async () => {
    location.hash = "#/evaluators";
    renderShell();
    expect(screen.getByTestId("page-evaluators")).toBeInTheDocument();
    // 评估器页专属入口
    expect(screen.getByTestId("evaluators-new")).toHaveTextContent("新建评估器");
    // 数据锚点：自定义评估器行只在 evaluators 数据到齐时出现
    await screen.findByTestId("evaluator-row-brand_tone");
    // 拆页反向钉：数据集块不在这页
    expect(screen.queryByTestId("testdata-card")).toBeNull();
    expect(screen.queryByTestId("testdata-tab-redteam")).toBeNull();
    // 导航高亮归自己
    expect(screen.getByTestId("nav-evaluators")).toHaveAttribute("aria-current", "page");
    // 删句双钉（2026-08-30 无废话终裁：版面无 + title 无）：页头 sub「定义
    // 「怎么评」——内置与自定义评分标准，供各环节判分」对任何时刻恒成立 =
    // 使用文档，整句删（16 处之代表：sub 一处钉在这里）。
    expect(screen.getByTestId("pagehead").querySelector(".sub")).toBeNull();
    expect(screen.queryByText(/内置与自定义评分标准/)).toBeNull();
    expect(document.querySelector('[title*="内置与自定义评分标准"]')).toBeNull();
  });

  it("#/datasets 是数据集页：四个 tab 齐全，且没有评估器表格", async () => {
    location.hash = "#/datasets";
    renderShell();
    expect(screen.getByTestId("page-datasets")).toBeInTheDocument();
    // 数据锚点：tab 计数只在 datasets 数据到齐时是 2（门槛数据 ≠ 断言数据，
    // 这里等的就是断言要用的那份计数）
    await waitFor(() =>
      expect(screen.getByTestId("testdata-tab-dataset")).toHaveTextContent("回归数据集 2"));
    expect(screen.getByTestId("testdata-tab-simulation")).toBeInTheDocument();
    expect(screen.getByTestId("testdata-tab-redteam")).toHaveTextContent("红队用例集 1");
    expect(screen.getByTestId("testdata-tab-observe")).toBeInTheDocument();
    // 拆页反向钉：评估器块不在这页
    expect(screen.queryByTestId("evaluators-table")).toBeNull();
    expect(screen.queryByTestId("evaluators-new")).toBeNull();
    expect(screen.getByTestId("nav-datasets")).toHaveAttribute("aria-current", "page");
  });
});

describe("旧地址 #/resources 重定向语义", () => {
  it("parseHash 把 #/resources 解析成 evaluators view（不保留 resources view）", () => {
    expect(parseHash("#/resources")).toEqual({ view: "evaluators" });
  });

  it("老书签 #/resources 落到评估器页，导航高亮评估器", async () => {
    location.hash = "#/resources";
    renderShell();
    expect(screen.getByTestId("page-evaluators")).toBeInTheDocument();
    expect(screen.getByTestId("evaluators-new")).toBeInTheDocument();
    expect(screen.getByTestId("nav-evaluators")).toHaveAttribute("aria-current", "page");
    await screen.findByTestId("evaluator-row-brand_tone");
  });
});

// 原钉「侧栏五项：Agent/评估器/数据集/评估计划/评估分析 + 计数角标」。ADR-0016 顶栏：
// 主线一项 Agent（aria-label 主导航）+ 次级三项 评估计划/评估器/数据集（aria-label
// 评估资产），「评估分析」不再在导航里；角标随契约整体撤除（原「评估器角标 = 页面
// 计数」「数据集角标 = 全量」两条改成反向钉：任何 nav-*-count 都不许再出现）。
describe("顶栏两组：主线 Agent + 次级三项，label 逐字，零角标", () => {
  it("主导航只有 Agent；评估资产按 评估计划/评估器/数据集 顺序，label 逐字", () => {
    location.hash = "#/workbench";
    renderShell();
    const primary = screen.getByRole("navigation", { name: "主导航" });
    expect(within(primary).getAllByRole("button").map((b) => b.textContent)).toEqual(["Agent"]);
    const assets = screen.getByRole("navigation", { name: "评估资产" });
    const buttons = within(assets).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["评估计划", "评估器", "数据集"]);
    expect(buttons.map((b) => b.dataset.testid)).toEqual([
      "nav-workbench", "nav-evaluators", "nav-datasets",
    ]);
    // 旧项彻底移除：资源库 / 评估分析 / 大屏 都不在导航里
    expect(screen.queryByTestId("nav-resources")).toBeNull();
    expect(screen.queryByTestId("nav-compare")).toBeNull();
    expect(screen.getByTestId("topnav")).not.toHaveTextContent("评估分析");
    expect(screen.getByTestId("topnav")).not.toHaveTextContent("大屏");
  });

  it("评估器页数据到齐后导航仍零角标（反向钉：不为角标发请求、也不渲染）", async () => {
    location.hash = "#/evaluators";
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId("evaluators-count")).toHaveTextContent("6"));
    expect(document.querySelector('[data-testid$="-count"][data-testid^="nav-"]')).toBeNull();
  });

  it("数据集页数据到齐后导航仍零角标", async () => {
    location.hash = "#/datasets";
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId("testdata-tab-dataset")).toHaveTextContent("回归数据集 2"));
    expect(document.querySelector('[data-testid$="-count"][data-testid^="nav-"]')).toBeNull();
  });

  it("点击评估器/数据集导航切 hash", () => {
    location.hash = "#/workbench";
    renderShell();
    fireEvent.click(screen.getByTestId("nav-evaluators"));
    expect(location.hash).toBe("#/evaluators");
    fireEvent.click(screen.getByTestId("nav-datasets"));
    expect(location.hash).toBe("#/datasets");
  });
});
