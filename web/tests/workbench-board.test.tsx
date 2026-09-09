// 排程看板测试（批 plans-board，ADR-0016 决定 3 / 舰队级 d）。
// 纯函数部分盯 pages/workbench/board.ts；渲染部分 fetch 直接 mock（与
// tests/workbench-page.test.tsx 同套路）。时钟一律钉死在 2026-09-03（周四）12:00 UTC，
// 所有期望时刻由 cron 手算：aaa111 周一 03:00 → 09-07；ddd666 每天 04:00 → 09-04；
// fff888 周二 02:00 → 09-08。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectProseGone } from "./prose";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { sseFrames, AGENT_PLANS, AGENT_RUNS } from "../src/mocks/handlers";
import {
  RATE_PHASE_UNKNOWN, deriveBoard, monthSpendOf, rateText,
} from "../src/pages/workbench/board";
import WorkbenchPage from "../src/pages/workbench/WorkbenchPage";
import type { Plan } from "../src/lib/apiTypes";
import type { RunRow } from "../src/pages/workbench/types";
import { useSession } from "../src/stores/session";

const NOW = Date.parse("2026-09-03T12:00:00Z");

// ---------- 夹具 ----------

function plan(over: Partial<Plan> & { plan_id: string }): Plan {
  return { name: over.plan_id, agent_name: "support-bot", stages: [{ type: "observe" }], ...over };
}
function run(over: Partial<RunRow> & { run_key: string; plan_id: string }): RunRow {
  return {
    plan_name: over.plan_id, agent_name: "support-bot", status: "completed", score: 0.8,
    started_at: "2026-09-02 09:00 UTC", duration_s: 60, total_cost_usd: 0.1, ...over,
  };
}

const OK_RUN = { run_key: "k", status: "completed", score: 0.8, finished_at: "2026-09-01 09:00 UTC",
  stage_summaries: [{ type: "observe", status: "completed", overall_mean: 0.8, sessions: 2 }] };
const FAILED_RUN = { run_key: "k", status: "error", score: null, finished_at: "2026-09-01 09:00 UTC",
  stage_summaries: [{ type: "observe", status: "error", error: "boom" }] };
const PARTIAL_RUN = { run_key: "k", status: "completed", score: 0.7, finished_at: "2026-09-01 09:00 UTC",
  stage_summaries: [
    { type: "observe", status: "completed", overall_mean: 0.7, sessions: 2 },
    { type: "redteam", status: "error", error: "boom" },
  ] };

// 四种定时形态各一：每天 04:00（最早）、周一 03:00、rate、无定时
const P_DAILY = plan({ plan_id: "p-daily", name: "每日巡检", schedule: { cron: "cron(0 4 * * ? *)", budget_usd: 1 }, last_run: OK_RUN });
const P_MON = plan({ plan_id: "p-mon", name: "周一回归", schedule: { cron: "cron(0 3 ? * MON *)", budget_usd: 2 }, last_run: PARTIAL_RUN });
const P_RATE = plan({ plan_id: "p-rate", name: "rate 计划", schedule: "rate(6 hours)", last_run: null });
const P_NONE_OK = plan({ plan_id: "p-none-ok", name: "手动 A", schedule: null, last_run: OK_RUN });
const P_NONE_BAD = plan({ plan_id: "p-none-bad", name: "手动 B", schedule: null, last_run: FAILED_RUN });

// ---------- 纯函数 ----------

describe("deriveBoard 列数据", () => {
  it("定时列：cron → humanize 人话；rate → 每 n 单位；无定时 → 手动；预算只认对象形态的 budget_usd", () => {
    const { rows } = deriveBoard([P_DAILY, P_MON, P_RATE, P_NONE_OK], [], NOW);
    const by = (id: string) => rows.find((r) => r.plan.plan_id === id)!;
    expect(by("p-daily").cronText).toBe("每天 04:00 UTC 运行");
    expect(by("p-mon").cronText).toBe("每周一 03:00 UTC 运行");
    expect(by("p-rate").cronText).toBe("每 6 小时");
    expect(by("p-none-ok").cronText).toBe("手动");
    expect(by("p-daily").budget).toBe(1);
    expect(by("p-rate").budget).toBeNull();   // 存量字符串形态没有预算
    expect(by("p-none-ok").budget).toBeNull();
  });

  it("rateText：三种单位；非 rate 原样返回", () => {
    expect(rateText("rate(1 day)")).toBe("每 1 天");
    expect(rateText("rate(15 minutes)")).toBe("每 15 分钟");
    expect(rateText("rate(6 hours)")).toBe("每 6 小时");
    expect(rateText("cron(0 4 * * ? *)")).toBe("cron(0 4 * * ? *)");
  });

  it("下次运行：cron 用 cronEngine 推算（09-04 04:00 / 09-07 03:00）；无定时 —", () => {
    const { rows } = deriveBoard([P_DAILY, P_MON, P_NONE_OK], [], NOW);
    const by = (id: string) => rows.find((r) => r.plan.plan_id === id)!;
    expect(by("p-daily").nextRun?.toISOString()).toBe("2026-09-04T04:00:00.000Z");
    expect(by("p-daily").nextRunText).toBe("09-04 04:00");
    expect(by("p-mon").nextRun?.toISOString()).toBe("2026-09-07T03:00:00.000Z");
    expect(by("p-none-ok").nextRun).toBeNull();
    expect(by("p-none-ok").nextRunText).toBe("—");
  });

  it("rate 相位未知不伪造时刻：nextRun null，文案是「rate 周期 · 相位未知」且不含任何 HH:mm", () => {
    const { rows, alert } = deriveBoard([P_RATE], [], NOW);
    expect(rows[0].kind).toBe("rate");
    expect(rows[0].nextRun).toBeNull();
    expect(rows[0].nextRunText).toBe(RATE_PHASE_UNKNOWN);
    expect(rows[0].nextRunText).not.toMatch(/\d{2}:\d{2}/);
    // 只有 rate 计划：全表 next 也不许编一个出来
    expect(alert.next).toBeNull();
    expect(alert.hasRate).toBe(true);
    expect(alert.scheduledCount).toBe(1);
  });

  it("解析失败的存量 cron：kind=invalid、原串照显、cronError 带引擎原话、不推下次", () => {
    const bad = plan({ plan_id: "p-bad", schedule: { cron: "0 3 * *", budget_usd: 1 } });
    const { rows } = deriveBoard([bad], [], NOW);
    expect(rows[0].kind).toBe("invalid");
    expect(rows[0].cronText).toBe("0 3 * *");
    expect(rows[0].cronError).toContain("需要 5 段");
    expect(rows[0].nextRun).toBeNull();
  });
});

describe("deriveBoard 本月花费", () => {
  const runs: RunRow[] = [
    // 本月 completed → 算
    run({ run_key: "a1", plan_id: "p-daily", started_at: "2026-09-01 00:00 UTC", total_cost_usd: 0.5 }),
    run({ run_key: "a2", plan_id: "p-daily", started_at: "2026-09-03 11:00 UTC", total_cost_usd: 0.25 }),
    // 上月最后一分钟 completed → 不算（UTC 月界）
    run({ run_key: "a3", plan_id: "p-daily", started_at: "2026-08-31 23:59 UTC", total_cost_usd: 9 }),
    // 本月 error / running → 不算
    run({ run_key: "a4", plan_id: "p-daily", status: "error", started_at: "2026-09-02 09:00 UTC", total_cost_usd: 9 }),
    run({ run_key: "a5", plan_id: "p-daily", status: "running", started_at: "2026-09-03 11:30 UTC", total_cost_usd: 9, duration_s: null }),
    // 本月 completed 但 total_cost_usd 缺失 → 不进样本
    run({ run_key: "a6", plan_id: "p-daily", started_at: "2026-09-02 10:00 UTC", total_cost_usd: null }),
    // 别的计划的本月 completed → 不进这个计划，但进全表合计
    run({ run_key: "b1", plan_id: "p-mon", started_at: "2026-09-02 10:00 UTC", total_cost_usd: 1 }),
  ];

  it("只算本月 UTC 内 status=completed 且带 total_cost_usd 的 run：0.5 + 0.25，样本 2", () => {
    const { rows, alert } = deriveBoard([P_DAILY, P_MON, P_NONE_OK], runs, NOW);
    const daily = rows.find((r) => r.plan.plan_id === "p-daily")!;
    expect(daily.monthSpend).toBeCloseTo(0.75, 10);
    expect(daily.monthSpendN).toBe(2);
    // 全表合计 = 0.75 + 1，样本 3
    expect(alert.monthSpend).toBeCloseTo(1.75, 10);
    expect(alert.monthSpendN).toBe(3);
  });

  it("样本 0 → null（显 —，不是 0.00）", () => {
    const { rows } = deriveBoard([P_NONE_OK], runs, NOW);
    expect(rows[0].monthSpend).toBeNull();
    expect(rows[0].monthSpendN).toBe(0);
    expect(monthSpendOf([], NOW)).toEqual({ sum: 0, n: 0 });
  });
});

describe("deriveBoard 排序与告警", () => {
  it("有定时先于无定时；下次运行早的在前；rate（推不出）夹在中间", () => {
    // 故意乱序喂入
    const { rows } = deriveBoard([P_NONE_OK, P_RATE, P_MON, P_DAILY], [], NOW);
    const ids = rows.map((r) => r.plan.plan_id);
    expect(ids.indexOf("p-daily")).toBeLessThan(ids.indexOf("p-mon"));      // 09-04 早于 09-07
    expect(ids.indexOf("p-mon")).toBeLessThan(ids.indexOf("p-rate"));       // 可推算 < 推不出
    expect(ids.indexOf("p-rate")).toBeLessThan(ids.indexOf("p-none-ok"));   // 带定时 < 无定时
  });

  it("同组内最近结果差的在前（失败 < 完成 < 未运行）", () => {
    const never = plan({ plan_id: "p-none-never", name: "手动 C", schedule: null, last_run: null });
    const { rows } = deriveBoard([never, P_NONE_OK, P_NONE_BAD], [], NOW);
    expect(rows.map((r) => r.plan.plan_id)).toEqual(["p-none-bad", "p-none-ok", "p-none-never"]);
  });

  it("告警条：只数**带定时**且最近一次失败/部分失败的计划；无定时的失败不进", () => {
    const { alert } = deriveBoard([P_DAILY, P_MON, P_RATE, P_NONE_BAD], [], NOW);
    expect(alert.badScheduled.map((r) => r.plan.plan_id)).toEqual(["p-mon"]);  // 部分失败
    expect(alert.planCount).toBe(4);
    expect(alert.scheduledCount).toBe(3);
    expect(alert.next?.plan.plan_id).toBe("p-daily");
  });
});

// ---------- 渲染 ----------

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
type Payload = { action?: string } & Record<string, unknown>;

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}
function stubFetch(overrides: Record<string, (payload: Payload) => Response> = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    const handler = overrides[payload.action ?? ""];
    if (handler) return handler(payload);
    switch (payload.action) {
      case "list_plans": return sseResponse([{ event: "plans", plans: AGENT_PLANS }]);
      case "list_recent_runs": return sseResponse([{ event: "recent_runs", runs: AGENT_RUNS }]);
      default: return sseResponse([{ event: "error", error: `未实现 ${payload.action}` }]);
    }
  }));
}
function renderPage(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  resetConfigForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  location.hash = "#/workbench";
  resetRunFlightForTest();
  vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("排程看板渲染", () => {
  it("九个列头齐全，是真 <table class=u-table>，卡壳是 .card", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    const table = await screen.findByTestId("plans-table");
    expect(table.tagName).toBe("TABLE");
    expect(table).toHaveClass("u-table");
    expect(table.closest(".card")).not.toBeNull();
    for (const h of ["计划名", "Agent", "环节", "定时", "单次预算 $", "本月花费 $", "下次运行", "最近结果", "操作"]) {
      expect(within(table).getByRole("columnheader", { name: h })).toBeInTheDocument();
    }
  });

  it("默认假数据的行序：ddd666(09-04) → aaa111(09-07) → fff888(09-08) → ccc333(rate) → bbb222(手动)", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    const table = await screen.findByTestId("plans-table");
    // 锚点挑目标数据专属：rate 行那格的专属文案
    await waitFor(() =>
      expect(within(table).getByTestId("plan-row-plan-ccc333-next")).toHaveTextContent(RATE_PHASE_UNKNOWN));
    const ids = within(table).getAllByRole("row")
      .map((tr) => tr.getAttribute("data-testid"))
      .filter((t): t is string => !!t && t.startsWith("plan-row-"));
    expect(ids).toEqual([
      "plan-row-plan-ddd666", "plan-row-plan-aaa111", "plan-row-plan-fff888",
      "plan-row-plan-ccc333", "plan-row-plan-bbb222",
    ]);
    expect(within(table).getByTestId("plan-row-plan-ddd666-next")).toHaveTextContent("09-04 04:00");
    expect(within(table).getByTestId("plan-row-plan-aaa111-next")).toHaveTextContent("09-07 03:00");
    // rate 行：定时列人话、下次运行不伪造时刻
    expect(within(table).getByTestId("plan-row-plan-ccc333-cron")).toHaveTextContent("每 1 天");
    expect(within(table).getByTestId("plan-row-plan-ccc333-next")).not.toHaveTextContent(/\d{2}:\d{2}/);
  });

  it("告警条：ddd666 带定时且最近一次部分失败 → 1 个；bbb222 失败但无定时不进；带本月花费合计", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    const bar = await screen.findByTestId("board-alert");
    // 锚点：告警态专属的计划名（中性态不出现它）
    await waitFor(() => expect(bar).toHaveTextContent("越权与泄露巡检"));
    expect(bar).toHaveAttribute("data-tone", "bad");
    expect(bar).toHaveTextContent("1 个定时计划最近一次运行失败或部分失败");
    expect(bar).not.toHaveTextContent("红队巡检");
    expect(bar).toHaveTextContent("本月花费");
  });

  it("全部正常：告警条是一句中性现状（计划数 · 带定时数 · 下次 时刻 计划名），不写「一切正常」", async () => {
    stubFetch({
      list_plans: () => sseResponse([{ event: "plans", plans: [P_DAILY, P_RATE, P_NONE_OK] }]),
      list_recent_runs: () => sseResponse([{ event: "recent_runs", runs: [] }]),
    });
    renderPage(<WorkbenchPage />);
    const bar = await screen.findByTestId("board-alert");
    await waitFor(() => expect(bar).toHaveTextContent("每日巡检"));
    expect(bar).toHaveAttribute("data-tone", "neutral");
    expect(bar).toHaveTextContent("3 个计划");
    expect(bar).toHaveTextContent("2 个带定时");
    expect(bar).toHaveTextContent("下次 09-04 04:00 每日巡检");
    expect(bar).not.toHaveTextContent("一切正常");
    // 本月无样本 → —
    expect(bar).toHaveTextContent("本月花费 —");
  });

  it("本月花费格：样本 0 显 — 且 title 说明；有样本显金额", async () => {
    stubFetch({
      list_plans: () => sseResponse([{ event: "plans", plans: [P_DAILY, P_MON] }]),
      list_recent_runs: () => sseResponse([{ event: "recent_runs", runs: [
        run({ run_key: "a1", plan_id: "p-daily", started_at: "2026-09-01 00:00 UTC", total_cost_usd: 0.5 }),
        run({ run_key: "a3", plan_id: "p-mon", started_at: "2026-08-31 23:59 UTC", total_cost_usd: 9 }),
      ] }]),
    });
    renderPage(<WorkbenchPage />);
    await waitFor(() =>
      expect(screen.getByTestId("plan-row-p-daily-spend")).toHaveTextContent("0.50"));
    const none = screen.getByTestId("plan-row-p-mon-spend");
    expect(none).toHaveTextContent("—");
    expect(none.getAttribute("title")).toContain("暂无该计划的 completed 运行样本");
  });

  it("空态一句话带动作：还没有评估计划 + 新建计划按钮", async () => {
    stubFetch({
      list_plans: () => sseResponse([{ event: "plans", plans: [] }]),
      list_recent_runs: () => sseResponse([{ event: "recent_runs", runs: [] }]),
    });
    renderPage(<WorkbenchPage />);
    const empty = await screen.findByTestId("plans-empty");
    expect(empty).toHaveTextContent("还没有评估计划");
    expect(within(empty).getByTestId("plans-empty-new")).toHaveTextContent("新建计划");
  });

  it("术语七词：整页 DOM（版面 + title）「方案」「工作台」「资源库」0 处；最近运行表头是「计划」", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    await screen.findByTestId("plans-table");
    const runsTable = await screen.findByTestId("runs-table");
    expect(within(runsTable).getByRole("columnheader", { name: "计划" })).toBeInTheDocument();
    const page = screen.getByTestId("page-workbench");
    expectProseGone(page, "方案", "工作台", "资源库");
    // 「均分」不得裸出现在这页
    expect(page.textContent).not.toContain("均分");
  });
});
