// 单行顶栏（ADR-0016 nav-b 契约）的专属钉子：
//   ❶ 品牌 = 门/闸 mark + AgentGate，点回首页；
//   ❷ 详情页在导航上的归属（plan/run/report → 评估计划，agent → Agent），评估分析/大屏零激活；
//   ❸ ⌘K / Ctrl+K 开命令面板（面板本体钉在 tests/topnav-search.test.tsx；此前只聚焦入口 = 死按钮）；
//   ❹ 环境 chip：prod · <region>，region 优先 config.json，其次 discover 缓存，都没有只剩 prod；
//   ❺ 时间窗「近 24h」静态；
//   ❻ 吸顶后加深：scrollY > 0 切 .scrolled 类；
//   ❼ 头像首字母从会话 token（JWT payload）取，解不出给 "A"；点头像开设置抽屉（含账户行）。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTest } from "../src/lib/config";
import { sseFrames } from "../src/mocks/handlers";
import Shell from "../src/components/layout/Shell";
import { activeNav, userInitial } from "../src/components/layout/TopNav";
import { parseHash } from "../src/router";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
type Payload = { action?: string } & Record<string, unknown>;

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}

/** 两台 Agent（单台会触发首页直落详情）；region 是本文件 ❹ 的断言数据 */
const DISCOVER = {
  event: "agents", region: "us-west-2", from_cache: false,
  agents: [
    { agent_name: "a", runtime_arn: "", source: "agentcore", has_logs: true, display_name: "", version_label: "" },
    { agent_name: "b", runtime_arn: "", source: "agentcore", has_logs: true, display_name: "", version_label: "" },
  ],
};

let cfg: Record<string, unknown> = CFG;
function dispatch(payload: Payload): Response {
  switch (payload.action) {
    case "discover": return sseResponse([DISCOVER]);
    case "list_plans": return sseResponse([{ event: "plans", plans: [] }]);
    case "list_recent_runs": return sseResponse([{ event: "recent_runs", runs: [] }]);
    // 首页会拉 fleet_status：给一个永不解析的流，本文件不测首页内容
    default: return new Response(new ReadableStream<Uint8Array>(), {
      status: 200, headers: { "Content-Type": "text/event-stream" },
    });
  }
}

function renderShell(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Shell /></QueryClientProvider> as ReactElement);
}

/** HS256 形状的假 JWT（只有 payload 会被读；签名段随便） */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (s: string) => Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`;
}

beforeEach(() => {
  resetConfigForTest();
  cfg = CFG;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("config.json")) return Response.json(cfg);
    return dispatch(JSON.parse(String(init?.body)) as Payload);
  }));
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  location.hash = "#/workbench";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.classList.remove("is-authed");
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
});

describe("❶ 品牌", () => {
  it("门/闸 mark（#i-gate）+ AgentGate 字标；点击回首页 #/agents", () => {
    renderShell();
    const brand = screen.getByTestId("brand");
    expect(brand).toHaveTextContent("AgentGate");
    expect(brand.querySelector("svg use")?.getAttribute("href")).toBe("#i-gate");
    fireEvent.click(brand);
    expect(location.hash).toBe("#/agents");
  });
});

describe("❷ 导航归属", () => {
  it("activeNav：agents/agent → Agent；workbench/plan/plan-new/plan-edit/run/report → 评估计划；compare/bigscreen → 无", () => {
    expect(activeNav(parseHash("#/agents"))).toBe("agents");
    expect(activeNav(parseHash("#/agent/x"))).toBe("agents");
    expect(activeNav(parseHash("#/workbench"))).toBe("workbench");
    expect(activeNav(parseHash("#/plan/p1"))).toBe("workbench");
    expect(activeNav(parseHash("#/plan/new"))).toBe("workbench");
    expect(activeNav(parseHash("#/plan/p1/edit"))).toBe("workbench");
    expect(activeNav(parseHash("#/run/p1%23t"))).toBe("workbench");
    expect(activeNav(parseHash("#/report/p1%23t"))).toBe("workbench");
    expect(activeNav(parseHash("#/evaluators"))).toBe("evaluators");
    expect(activeNav(parseHash("#/datasets"))).toBe("datasets");
    expect(activeNav(parseHash("#/compare"))).toBeNull();
    expect(activeNav(parseHash("#/bigscreen"))).toBeNull();
  });

  it("#/plan/:id 点亮评估计划；主线 Agent 是 .on 胶囊只在 Agent 族路由", () => {
    location.hash = "#/plan/p1";
    renderShell();
    expect(screen.getByTestId("nav-workbench")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("nav-workbench")).toHaveClass("on");
    expect(screen.getByTestId("nav-agents")).not.toHaveClass("on");
    // 次级三项降一级：.sub；主线不是
    expect(screen.getByTestId("nav-workbench")).toHaveClass("sub");
    expect(screen.getByTestId("nav-agents")).not.toHaveClass("sub");
  });

  // 批 topnav-narrow（2026-09-03 热修）：三项资产导航在窄屏曾被 CSS display:none 整段藏掉。
  // jsdom **不算媒体查询**，这里钉不了「可见」，只钉 DOM 存在性 + 文案 + 点击去向；
  // 「任何 @media 里都不许 display:none」由 tests/topnav-narrow-guard.test.ts 在 CSS 原文上钉。
  // 导航项是 <button>（不是 <a>），没有 href —— 去向由 onClick → navigate(hash) 给出，
  // 所以这里用「点它 ⇒ location.hash」代替 href 断言。
  it("三项 .nb-link.sub（评估计划 / 评估器 / 数据集）始终渲染在 DOM，点击各去其 hash", () => {
    renderShell();
    const subs = [
      ["nav-workbench", "评估计划", "#/workbench"],
      ["nav-evaluators", "评估器", "#/evaluators"],
      ["nav-datasets", "数据集", "#/datasets"],
    ] as const;
    const group = screen.getByRole("navigation", { name: "评估资产" });
    expect(group.querySelectorAll(".nb-link.sub")).toHaveLength(3);
    for (const [testid, label, hash] of subs) {
      const el = screen.getByTestId(testid);
      expect(el).toHaveClass("nb-link");
      expect(el).toHaveClass("sub");
      expect(el).toHaveTextContent(label);
      expect(group).toContainElement(el);
      fireEvent.click(el);
      expect(location.hash).toBe(hash);
    }
  });
});

describe("❸ ⌘K 搜索入口", () => {
  it("入口外观：搜索 + kbd ⌘K；⌘K / Ctrl+K / 点击都开命令面板并聚焦其输入框", () => {
    renderShell();
    const search = screen.getByTestId("topnav-search");
    expect(search).toHaveTextContent("搜索");
    expect(search.querySelector("kbd")).toHaveTextContent("⌘K");
    expect(screen.queryByTestId("cmdk")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("cmdk-input"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("cmdk")).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("cmdk-input"));
    fireEvent.keyDown(document, { key: "Escape" });
    // 裸 k 不开
    fireEvent.keyDown(window, { key: "k" });
    expect(screen.queryByTestId("cmdk")).toBeNull();
    // 入口不再是装饰件：点击开面板（用户 2026-09-07 报障的那一下）
    fireEvent.click(search);
    expect(screen.getByTestId("cmdk")).toBeInTheDocument();
  });
});

describe("❹ 环境 chip / ❺ 时间窗", () => {
  it("没有 region 来源时只显示 prod（不写死区域）", () => {
    renderShell();
    expect(screen.getByTestId("brand-env")).toHaveTextContent(/^prod$/);
    expect(screen.getByTestId("topnav-window")).toHaveTextContent("近 24h");
  });

  it("首页拉过 discover 后，chip 从同一条缓存取 region：prod · us-west-2", async () => {
    location.hash = "#/agents";
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId("brand-env")).toHaveTextContent("prod · us-west-2"));
  });

  it("config.json 带 region 时优先它（infra 后续写入即生效）", async () => {
    cfg = { ...CFG, region: "eu-west-1" };
    location.hash = "#/agents";
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId("brand-env")).toHaveTextContent("prod · eu-west-1"));
  });
});

describe("❻ 吸顶加深", () => {
  it("scrollY > 0 切 .scrolled；回到顶部去掉", () => {
    renderShell();
    const top = screen.getByTestId("topnav");
    expect(top).not.toHaveClass("scrolled");
    Object.defineProperty(window, "scrollY", { value: 24, configurable: true });
    act(() => { window.dispatchEvent(new Event("scroll")); });
    expect(top).toHaveClass("scrolled");
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    act(() => { window.dispatchEvent(new Event("scroll")); });
    expect(top).not.toHaveClass("scrolled");
  });
});

describe("❼ 头像 / 账户", () => {
  it("userInitial：JWT payload 的 username 首字母大写；非 JWT / 空 → A", () => {
    expect(userInitial(fakeJwt({ username: "jane.doe" }))).toBe("J");
    expect(userInitial(fakeJwt({ "cognito:username": "wei" }))).toBe("W");
    expect(userInitial(fakeJwt({ email: "ops@example.com" }))).toBe("O");
    expect(userInitial("t")).toBe("A");
    expect(userInitial(null)).toBe("A");
    expect(userInitial(`${fakeJwt({}).split(".")[0]}.!!!.x`)).toBe("A");
  });

  it("头像显示会话首字母；点开设置抽屉，账户行有登录态 + 退出", () => {
    useSession.setState({ token: fakeJwt({ username: "jane" }), authed: true, everAuthed: true, authExpired: false });
    renderShell();
    const avatar = screen.getByTestId("topnav-user");
    expect(avatar).toHaveTextContent(/^J$/);
    expect(screen.queryByTestId("account-row")).toBeNull();
    fireEvent.click(avatar);
    const drawer = screen.getByTestId("settings-drawer");
    expect(within(drawer).getByTestId("account-who")).toHaveTextContent("已登录");
    expect(within(drawer).getByTestId("account-logout")).toHaveTextContent("退出登录");
  });

  it("版本戳在顶栏工具区（testid app-version）", () => {
    renderShell();
    expect(screen.getByTestId("topnav")).toContainElement(screen.getByTestId("app-version"));
  });

  it("顶栏零角标、无「评估分析」「大屏」、无齿轮按钮", () => {
    renderShell();
    const top = screen.getByTestId("topnav");
    expect(top.querySelector('[data-testid^="nav-"][data-testid$="-count"]')).toBeNull();
    expect(top).not.toHaveTextContent("评估分析");
    expect(top).not.toHaveTextContent("大屏");
    expect(screen.queryByTestId("settings-drawer-toggle")).toBeNull();
  });
});
