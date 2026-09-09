// 顶栏「搜索 ⌘K」命令面板（批 topnav-search，用户 2026-09-07 报「agent 页面里搜索按钮不生效」）：
//   ❶ 点搜索框开面板，输入框自动聚焦；Ctrl+K / ⌘K 开、Esc 关，关后焦点回到入口；
//   ❷ 四组只读 react-query 缓存：面板打开不发 list_plans / evaluators / list_datasets 请求，
//      但缓存里有的四组都能搜到（阳性：在 #/agents 上搜到数据集 —— 首页自己绝不会拉数据集）；
//   ❸ 输入 "sup" 出 support-bot；中文子串（改过显示名的 Agent 用显示名也能搜到，原名作副标）；
//   ❹ 每组 ≤ 5；前缀命中排在子串命中前；
//   ❺ ↑↓ 移动、Enter 跳转（Agent → #/agent/<name>/status，计划 → #/plan/<id>）；点击同理；
//   ❻ 无匹配文案；空输入不出结果只有 placeholder；
//   ❼ 面板里「均分 / 方案 / 工作台 / 资源库」零出现（术语七词）。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTest } from "../src/lib/config";
import { sseFrames } from "../src/mocks/handlers";
import Shell from "../src/components/layout/Shell";
import { useSession } from "../src/stores/session";
import { matchRank, searchGroups, type SearchItem } from "../src/components/search/searchIndex";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
type Payload = { action?: string } & Record<string, unknown>;

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}

const AGENTS = {
  event: "agents", region: "us-west-2", from_cache: false,
  agents: [
    { agent_name: "support-bot", runtime_arn: "", source: "agentcore", has_logs: true, display_name: "客服助手", version_label: "" },
    { agent_name: "sales-bot", runtime_arn: "", source: "agentcore", has_logs: true, display_name: "", version_label: "" },
    { agent_name: "ops-superuser", runtime_arn: "", source: "agentcore", has_logs: true, display_name: "", version_label: "" },
  ],
};
const PLANS = {
  event: "plans",
  plans: [
    { plan_id: "p-sup#1", name: "support 回归", agent_name: "support-bot" },
    { plan_id: "p-sales", name: "sales 夜间", agent_name: "sales-bot" },
  ],
};
// 7 个 ev 开头 ⇒ 评估器组必须截到 5（≤5 的判据用非平凡值）
const EVALUATORS = {
  event: "evaluators",
  available: ["ev_a", "ev_b", "ev_c", "ev_d"],
  dataset_only: ["ev_e"],
  multimodal: ["ev_f"],
  scopes: {}, default: [],
  custom: [{ name: "ev_custom_support", rubric: "", scope: "all", created_at: 1, updated_at: 1, blocks: null }],
};
const DATASETS = {
  event: "datasets",
  datasets: [
    { name: "support-faq", kind: "regression", case_count: 0, cases: [], target_agent: "", risk_categories: [], updated_at: 1 },
    { name: "rt-probes", kind: "redteam", case_count: 0, cases: [], target_agent: "sales-bot", risk_categories: [], updated_at: 2 },
  ],
};

const seen: string[] = [];
function dispatch(payload: Payload): Response {
  seen.push(payload.action ?? "");
  switch (payload.action) {
    case "discover": return sseResponse([AGENTS]);
    case "list_recent_runs": return sseResponse([{ event: "recent_runs", runs: [] }]);
    // 首页会拉 fleet_status 等：永不解析的流，本文件不测首页内容
    default: return new Response(new ReadableStream<Uint8Array>(), {
      status: 200, headers: { "Content-Type": "text/event-stream" },
    });
  }
}

/** 预热四组缓存（模拟用户逛过四个页面），staleTime 无限 ⇒ 页面自己也不会重拉 */
function renderShell(seed = true): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (seed) {
    qc.setQueryData(["agents"], AGENTS);
    qc.setQueryData(["plans"], PLANS);
    qc.setQueryData(["evaluators"], EVALUATORS);
    qc.setQueryData(["datasets"], DATASETS);
  }
  return render(<QueryClientProvider client={qc}><Shell /></QueryClientProvider> as ReactElement);
}

const openByClick = () => {
  fireEvent.click(screen.getByTestId("topnav-search"));
  return screen.getByTestId("cmdk-input") as HTMLInputElement;
};
const type = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });

beforeEach(() => {
  resetConfigForTest();
  seen.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("config.json")) return Response.json(CFG);
    return dispatch(JSON.parse(String(init?.body)) as Payload);
  }));
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  location.hash = "#/agents";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.classList.remove("is-authed");
  location.hash = "";
});

describe("❶ 开关：点入口 / Ctrl+K / ⌘K 开，Esc 关", () => {
  it("初始无面板；点搜索框开面板且输入框已聚焦；Esc 关并把焦点还给入口", () => {
    renderShell();
    expect(screen.queryByTestId("cmdk")).toBeNull();
    const btn = screen.getByTestId("topnav-search");
    expect(btn).toHaveAttribute("aria-expanded", "false");
    // 真浏览器 mousedown 会把焦点落到按钮上，jsdom 的 click 不会 —— 手动补这一步，
    // 断的是「关后焦点回到打开前的元素」
    btn.focus();
    const input = openByClick();
    expect(screen.getByTestId("cmdk")).toHaveAttribute("role", "dialog");
    expect(document.activeElement).toBe(input);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("cmdk")).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("Ctrl+K 与 ⌘K 都开面板；裸 k 不开；点遮罩关", () => {
    renderShell();
    fireEvent.keyDown(window, { key: "k" });
    expect(screen.queryByTestId("cmdk")).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("cmdk-input"));
    fireEvent.click(screen.getByTestId("cmdk-mask"));
    expect(screen.queryByTestId("cmdk")).toBeNull();
    fireEvent.keyDown(window, { key: "K", metaKey: true });
    expect(screen.getByTestId("cmdk")).toBeInTheDocument();
  });

  it("空输入：只有 placeholder，没有结果列也没有「没有匹配」", () => {
    renderShell();
    const input = openByClick();
    expect(input.placeholder).toBe("输入 Agent、评估计划、评估器或数据集名称");
    expect(screen.queryByTestId("cmdk-list")).toBeNull();
    expect(screen.queryByTestId("cmdk-empty")).toBeNull();
  });
});

describe("❷ 只读缓存：不为面板发请求，但缓存里的四组都能搜到", () => {
  it("在 #/agents 上搜到数据集 / 评估器 / 计划（首页自己绝不拉这三样），且三个 action 零请求", () => {
    renderShell();
    const input = openByClick();
    type(input, "sup");
    expect(screen.getByTestId("cmdk-item-dataset-support-faq")).toHaveTextContent("support-faq");
    expect(screen.getByTestId("cmdk-item-evaluator-ev_custom_support")).toBeInTheDocument();
    expect(screen.getByTestId("cmdk-item-plan-p-sup#1")).toHaveTextContent("support 回归");
    expect(seen.filter((a) => ["list_plans", "evaluators", "list_datasets"].includes(a))).toEqual([]);
  });

  it("缓存是冷的（没逛过别的页）⇒ 那些组不出现，不发请求补拉；有查询无结果显示无匹配", () => {
    renderShell(false);
    const input = openByClick();
    type(input, "support");
    expect(screen.queryByTestId("cmdk-group-plan")).toBeNull();
    expect(screen.queryByTestId("cmdk-group-dataset")).toBeNull();
    expect(seen.filter((a) => ["list_plans", "evaluators", "list_datasets"].includes(a))).toEqual([]);
  });
});

describe("❸ 匹配：sup → support-bot；中文子串命中显示名，原名作副标", () => {
  it('输入 "sup" 出 support-bot（显示名「客服助手」为主显、原名为副标）与 ops-superuser', () => {
    renderShell();
    const input = openByClick();
    type(input, "sup");
    const agentGroup = screen.getByTestId("cmdk-group-agent");
    const items = within(agentGroup).getAllByRole("option");
    expect(items.map((el) => el.getAttribute("data-testid"))).toEqual([
      // 前缀命中（agent_name 以 sup 开头）排在子串命中（ops-superuser）前
      "cmdk-item-agent-support-bot",
      "cmdk-item-agent-ops-superuser",
    ]);
    expect(items[0].querySelector(".cmdk-item-label")).toHaveTextContent("客服助手");
    expect(items[0].querySelector(".cmdk-item-sub")).toHaveTextContent("support-bot");
    // sales-bot 不含 sup
    expect(screen.queryByTestId("cmdk-item-agent-sales-bot")).toBeNull();
  });

  it("中文直接子串：「客服」命中改过显示名的 Agent；大小写不敏感：SUP 同 sup", () => {
    renderShell();
    const input = openByClick();
    type(input, "客服");
    expect(screen.getByTestId("cmdk-item-agent-support-bot")).toBeInTheDocument();
    type(input, "SUP");
    expect(screen.getByTestId("cmdk-item-agent-support-bot")).toBeInTheDocument();
  });
});

describe("❹ 分组各 ≤ 5，组序 Agent → 评估计划 → 评估器 → 数据集", () => {
  it("7 个 ev 开头的评估器只出 5 条", () => {
    renderShell();
    const input = openByClick();
    type(input, "ev");
    const g = screen.getByTestId("cmdk-group-evaluator");
    expect(within(g).getAllByRole("option")).toHaveLength(5);
  });

  it("组序固定四段，组名只用术语七词里的四个", () => {
    renderShell();
    const input = openByClick();
    type(input, "s");
    const heads = Array.from(document.querySelectorAll(".cmdk-group-head")).map((el) => el.textContent);
    expect(heads).toEqual(["Agent", "评估计划", "评估器", "数据集"]);
  });
});

describe("❺ 键盘 / 点击跳转", () => {
  it("Enter 跳第一条（Agent → #/agent/<name>/status）并关面板", () => {
    renderShell();
    const input = openByClick();
    type(input, "sup");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(location.hash).toBe("#/agent/support-bot/status");
    expect(screen.queryByTestId("cmdk")).toBeNull();
  });

  it("↓ 两次到评估计划（plan_id 带 # 要编码成 %23），↑ 一次回 Agent 第二条；Enter 落 #/plan/<id>", () => {
    renderShell();
    const input = openByClick();
    type(input, "sup");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByTestId("cmdk-item-plan-p-sup#1")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByTestId("cmdk-item-agent-ops-superuser")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(location.hash).toBe("#/plan/p-sup%231");
  });

  it("点击评估器条目 → #/evaluators；点击数据集条目 → #/datasets", () => {
    renderShell();
    let input = openByClick();
    type(input, "ev_a");
    fireEvent.click(screen.getByTestId("cmdk-item-evaluator-ev_a"));
    expect(location.hash).toBe("#/evaluators");
    input = openByClick();
    type(input, "rt-");
    fireEvent.click(screen.getByTestId("cmdk-item-dataset-rt-probes"));
    expect(location.hash).toBe("#/datasets");
  });
});

describe("❻ 无匹配 / ❼ 术语", () => {
  it("zzz 无匹配：显示「没有匹配的 Agent / 评估计划 / 评估器 / 数据集」，无结果列", () => {
    renderShell();
    const input = openByClick();
    type(input, "zzz");
    expect(screen.getByTestId("cmdk-empty")).toHaveTextContent("没有匹配的 Agent / 评估计划 / 评估器 / 数据集");
    expect(screen.queryByTestId("cmdk-list")).toBeNull();
  });

  it("面板全文（有结果态 + 无结果态）里「均分 / 方案 / 工作台 / 资源库」零出现", () => {
    renderShell();
    const input = openByClick();
    for (const q of ["s", "zzz"]) {
      type(input, q);
      const text = screen.getByTestId("cmdk").textContent ?? "";
      for (const bad of ["均分", "方案", "工作台", "资源库"]) expect(text).not.toContain(bad);
    }
  });
});

describe("searchIndex 纯函数", () => {
  const idx: SearchItem[] = [
    { group: "agent", key: "x-sup", label: "x-sup", terms: ["x-sup"] },
    { group: "agent", key: "sup-y", label: "sup-y", terms: ["sup-y"] },
    { group: "plan", key: "p", label: "计划", terms: ["计划", "p"] },
  ];
  it("matchRank：前缀 2 / 子串 1 / 不中 0 / 空查询 0", () => {
    expect(matchRank(idx[1], "SUP")).toBe(2);
    expect(matchRank(idx[0], "sup")).toBe(1);
    expect(matchRank(idx[0], "zz")).toBe(0);
    expect(matchRank(idx[0], "  ")).toBe(0);
  });
  it("searchGroups：前缀先于子串；空查询空结果；limit 生效", () => {
    expect(searchGroups(idx, "sup").map((g) => g.items.map((i) => i.key))).toEqual([["sup-y", "x-sup"]]);
    expect(searchGroups(idx, "")).toEqual([]);
    expect(searchGroups(idx, "sup", 1)[0].items.map((i) => i.key)).toEqual(["sup-y"]);
    expect(searchGroups(idx, "计").map((g) => g.group)).toEqual(["plan"]);
  });
});
