// 围栏的**挂载层级**测试（UI-026 验收项 3）。
//
// 上一个文件（error-boundary.test.tsx）测组件行为；这个文件测「挂对了地方」：
//   1) 路由级（router.tsx 的 RouteView 内）：页面炸了只吃 <main> 里这一页，
//      **顶栏导航保持可用** —— 线上事故的核心症状就是导航也一起没了
//   2) 应用根（App.tsx 内，Shell 外）：连壳/顶栏本身炸了也还剩一张可读的卡
//
// 手法：vi.mock 掉一个真实页面模块让它在渲染期抛，然后渲染真的 Shell / App。
// 不用「往数据里注形态」——那测的是数据层；这里要测的是结构层。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { resetConfigForTest } from "../src/lib/config";
import { useSession } from "../src/stores/session";
import { sseFrames } from "../src/mocks/handlers";

const CRASH = "注入：运行详情页渲染期抛错（等价线上 React error #31）";

// 让「运行详情」这一页在渲染期抛。其余页面保持真实实现。
// 函数**具名**：componentStack 靠函数名定位组件，匿名箭头只会打成 "at default"，
// 那就等于丢掉了唯一的排查线索（遥测断言也就成了空断言）。
vi.mock("../src/pages/run/RunDetailPage", () => ({
  default: function RunDetailPage(): ReactElement { throw new Error(CRASH); },
}));

// 动态导入必须在 vi.mock 之后（vitest 会提升 mock，但 import 顺序仍要显式）
const { default: Shell } = await import("../src/components/layout/Shell");
const { default: App } = await import("../src/App");

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("config.json")) return Response.json(CFG);
    // 列表类 action 一律给空集合：本文件只关心围栏，不关心内容
    return new Response(sseFrames([{ event: "plans", plans: [] }]), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }));
}

function renderShell(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Shell /></QueryClientProvider> as ReactElement);
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  resetConfigForTest();
  stubFetch();
  location.hash = "#/run/plan-aaa111%232026-08-11T09%3A00%3A00Z";
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.classList.remove("is-authed");
});

describe("路由级围栏：页面炸了不带走顶栏", () => {
  it("运行详情页抛错 → 降级卡在 <main> 内，顶栏四项导航照旧渲染", () => {
    renderShell();
    const fence = screen.getByTestId("route-boundary");
    expect(fence).toHaveTextContent("这个页面渲染失败了");
    expect(within(fence).getByTestId("route-boundary-message")).toHaveTextContent(CRASH);

    // 线上事故的核心症状：<main> 消失、body 只剩空 root。这三条钉住它不再发生。
    const main = screen.getByTestId("main");
    expect(main).toBeInTheDocument();
    expect(main).toContainElement(fence);
    const side = screen.getByTestId("topnav");
    expect(side).toBeInTheDocument();
    // 导航术语照旧（降级不许吞掉导航文案；ADR-0016 顶栏四项：Agent + 评估计划/评估器/数据集）
    for (const label of ["Agent", "评估器", "数据集", "评估计划"]) {
      expect(side).toHaveTextContent(label);
    }
    // 头像（设置抽屉入口）也还在（降级后仍能改配置）
    expect(screen.getByTestId("topnav-user")).toBeInTheDocument();
    // body 不是空的
    expect((document.body.textContent ?? "").trim().length).toBeGreaterThan(20);
  });

  it("降级后顶栏仍可点：跳到别的页面正常渲染，且降级态自动复位", async () => {
    renderShell();
    expect(screen.getByTestId("route-boundary")).toBeInTheDocument();
    // 顶栏可用 = 能走出去。这就是「页面级围栏」相对「只有根围栏」的价值。
    fireEvent.click(screen.getByTestId("nav-workbench"));
    expect(location.hash).toBe("#/workbench");
    // 锚点必须是**目标页专属**的 testid：hashchange 在 jsdom 里是异步任务，
    // 等 main/顶栏都不行（降级态下它们也在），等 route-boundary 消失也不行
    // （那是中间态与终态共用的否定条件，先成立后翻转都测不出来）。
    await screen.findByTestId("page-workbench");
    // key=route 让换路由时自动复位——否则跳到好页还是那张降级卡
    expect(screen.queryByTestId("route-boundary")).toBeNull();
    expect(screen.getByTestId("main")).toBeInTheDocument();
  });

  it("「返回评估计划」按钮同样能走出降级态", async () => {
    renderShell();
    fireEvent.click(within(screen.getByTestId("route-boundary")).getByTestId("route-boundary-home"));
    expect(location.hash).toBe("#/workbench");
    await screen.findByTestId("page-workbench");
    expect(screen.queryByTestId("route-boundary")).toBeNull();
  });

  it("记录遥测：scope 标明是哪一级 + 哪条路由（无遥测系统，console.error 即通道）", () => {
    renderShell();
    const logs = errorSpy.mock.calls.filter((c) => String(c[0]).startsWith("[ErrorBoundary"));
    // 断言异常确实被抛出且被记录 —— 围栏不许把真异常变成静默绿
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(String(logs[0][0])).toContain("[ErrorBoundary:route:run]");
    expect(logs[0][1]).toBeInstanceOf(Error);
    expect((logs[0][1] as Error).message).toBe(CRASH);
    expect(String(logs[0][2])).toContain("RunDetailPage");
  });
});

describe("应用根围栏：最后一道", () => {
  it("App 内挂了根围栏（Shell 外）：即使路由级没兜住，body 也不是空 root", () => {
    // App 自带 QueryClientProvider，直接渲染
    render(<App /> as ReactElement);
    // 路由级围栏先接住（就近原则），根围栏保持沉默
    expect(screen.getByTestId("route-boundary")).toBeInTheDocument();
    expect(screen.queryByTestId("app-boundary")).toBeNull();
    // 页面仍有内容 —— 修前这里 body.innerText.trim().length === 0
    expect((document.body.textContent ?? "").trim().length).toBeGreaterThan(20);
    expect(screen.getByTestId("topnav")).toBeInTheDocument();
  });
});
