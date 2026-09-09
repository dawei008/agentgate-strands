// bigscreen-ago-nan：大屏相对时间 ago() 对不可解析的 started_at（空串 / "N/A" /
// 乱码）无 NaN 闸，差值一路 NaN 穿过所有分支，渲染成字面「NaN 天前」。
// 后端对缺 started_at 的历史 item 显式回退空串，这条形状真实可达。
// 未知态文案取同文件既有写法（fmtHM 的「—」），不新造词。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTest } from "../src/lib/config";
import { sseFrames, BIGSCREEN_PLANS } from "../src/mocks/handlers";
import BigscreenPage from "../src/pages/bigscreen/BigscreenPage";
import { ago } from "../src/pages/bigscreen/derive";
import type { BigscreenRun } from "../src/pages/bigscreen/types";
import { useSession } from "../src/stores/session";

describe("ago()：不可解析输入 → 「—」，不出 NaN（本缺陷专属锚点）", () => {
  it("空串（后端缺 started_at 的回退形状）", () => {
    expect(ago("")).toBe("—");
  });
  it('"N/A" 与乱码串', () => {
    expect(ago("N/A")).toBe("—");
    expect(ago("端到端不可解析的字符串")).toBe("—");
  });
  it("四种退化输入都不含 NaN", () => {
    for (const v of ["", "N/A", "乱码", "0000-99-99"]) {
      expect(ago(v)).not.toContain("NaN");
    }
  });
});

describe("ago()：合法输入四档输出逐字节不变", () => {
  const NOW = Date.parse("2026-09-03T12:00:00Z");
  it("刚刚 / N 分钟前 / N 小时前 / N 天前", () => {
    expect(ago("2026-09-03 12:00 UTC", NOW)).toBe("刚刚");
    expect(ago("2026-09-03 11:30 UTC", NOW)).toBe("30 分钟前");
    expect(ago("2026-09-03 09:00 UTC", NOW)).toBe("3 小时前");
    expect(ago("2026-09-01 12:00 UTC", NOW)).toBe("2 天前");
  });
  it("档位边界：59 分钟前 / 1 小时前、23 小时前 / 1 天前", () => {
    expect(ago("2026-09-03 11:01 UTC", NOW)).toBe("59 分钟前");
    expect(ago("2026-09-03 11:00 UTC", NOW)).toBe("1 小时前");
    expect(ago("2026-09-02 13:00 UTC", NOW)).toBe("23 小时前");
    expect(ago("2026-09-02 12:00 UTC", NOW)).toBe("1 天前");
  });
});

// ================= 渲染层：缺 started_at 的记录上大屏不出现 "NaN" =================

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

/** 后端真实可达形状：缺 started_at 回退空串，其余字段健康。
 *  agent 名用夹具方案既有的「交易助手」——Agent 卡片网格按 PAGE_SIZE 轮播，
 *  新造 agent 名会落到第 2 页永远等不到；这条 run 是数据集里唯一一条，
 *  卡片页脚的相对时间只能出自它。 */
const NO_TS_RUN = {
  run_key: "r_no_started_at", plan_id: "plan_60df13", plan_name: "敏感信息泄露",
  agent_name: "交易助手", status: "completed", score: 0.81,
  started_at: "", duration_s: 96, total_cost_usd: 0.22, skip_reason: null,
  stage_summaries: [
    { type: "observe", status: "completed", overall_mean: 0.81, sessions: 8 },
  ],
} as BigscreenRun;

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as { action?: string };
    switch (payload.action) {
      case "list_plans":
        return sseResponse([{ event: "plans", plans: BIGSCREEN_PLANS }]);
      case "list_recent_runs":
        return sseResponse([{ event: "recent_runs", runs: [NO_TS_RUN] }]);
      default:
        return sseResponse([{ event: "error", error: `未实现 ${payload.action}` }]);
    }
  }));
}

function renderPage(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  resetConfigForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  window.history.replaceState(null, "", "/?mock=bigscreen-ok#/bigscreen");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("大屏渲染层：缺 started_at 的 run 卡片页脚", () => {
  it("页脚显示未知态「—」，卡片内不出现 NaN", async () => {
    stubFetch();
    renderPage(<BigscreenPage />);
    const card = await screen.findByTestId("bs-acard-交易助手");
    // 锚点挑注入 run 的专属数据：卡片主数字 0.81 只能来自这条 run 的 observe 分
    // （runs 未加载时卡片已在，页脚是「无运行记录」——不等这个锚会读到加载中间态）
    await waitFor(() => expect(within(card).getByText("0.81")).toBeInTheDocument());
    const foot = card.querySelector(".bs-a-foot");
    expect(foot?.textContent).not.toContain("NaN");
    expect(foot?.textContent).toContain("—");
  });
});
