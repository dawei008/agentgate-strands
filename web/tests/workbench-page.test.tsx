// 工作台页测试（fetch 直接 mock，与 tests/agents-pages.test.tsx 同套路）。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expectProseGone } from "./prose";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { sseFrames, AGENT_PLANS, AGENT_RUNS } from "../src/mocks/handlers";
import { deriveKpi } from "../src/pages/workbench/kpi";
import WorkbenchPage, { formatDuration } from "../src/pages/workbench/WorkbenchPage";
import type { Plan } from "../src/lib/apiTypes";
import type { RunRow } from "../src/pages/workbench/types";
import { useSession } from "../src/stores/session";

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
    // 形态逐字照真后端（app/main.py:1414-1416 的 {event, plan_id, **estimate}
    // + planrun.py:91-93 的 {stages, estimated_cost_usd, note}）。
    // 环节项只保证有 type，其余键各环节自己给（observe→judge_calls、
    // dataset→cases…），数据集不存在时给 {error}。
    case "estimate_plan_run":
      return sseResponse([{
        event: "plan_run_estimate",
        plan_id: payload.plan_id,
        stages: [
          { type: "observe", judge_calls: 20, estimated_cost_usd: 0.12,
            note: "线上评估环节：仅产生 judge 费用，不调用被测 Agent" },
          { type: "dataset", cases: 10, estimated_cost_usd: 0.3 },
        ],
        estimated_cost_usd: 0.42,
        note: "各环节预估合计（运行结束后还会生成一次评估计划级综合报告，"
          + "增加一次 judge 调用费用）；实际以运行为准",
      }]);
    case "run_plan":
      return sseResponse([
        { event: "run_started", plan_id: payload.plan_id, run_id: "run-new-001" },
        { event: "run_finished", plan_id: payload.plan_id, run_id: "run-new-001", status: "completed", score: 0.88 },
      ]);
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

function renderPage(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  resetConfigForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  location.hash = "#/workbench";
  // 在飞状态是模块级的（lib/runFlight，缺陷 1）：逐测清零，否则上一条用例的 run
  // 会让下一条的「运行」按钮一上来就是 disabled 的「运行中…」
  resetRunFlightForTest();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.querySelectorAll(".wb-toast").forEach((el) => el.remove());
});

// ---------- KPI 推导（纯函数） ----------
// 批 plans-board：hero 从「线上评估均分」换成「下次运行」（ADR-0016 分数口径修订：
// 均分只作观测量，留在 Agent ① 现状）。排序 / 本月花费 / rate 相位的细口径在
// tests/workbench-board.test.tsx；这里只钉 deriveKpi 的四个出口。
describe("deriveKpi 推导", () => {
  // 2026-09-03（周四）12:00 UTC
  const NOW = Date.parse("2026-09-03T12:00:00Z");
  const runsFix: RunRow[] = [
    { run_key: "r1", plan_id: "p-reg", plan_name: "回归", agent_name: "a", status: "completed", score: 0.8, started_at: "2026-09-03 10:00", duration_s: 60, total_cost_usd: 0.5 },
    { run_key: "r2", plan_id: "p-reg", plan_name: "回归", agent_name: "a", status: "error", score: null, started_at: "2026-09-03 09:00", duration_s: 5, total_cost_usd: 0.9 },
    { run_key: "r3", plan_id: "p-obs", plan_name: "线上", agent_name: "a", status: "completed", score: 0.9, started_at: "2026-08-31 09:00", duration_s: 30, total_cost_usd: 0.7 },
    { run_key: "r4", plan_id: "p-obs", plan_name: "线上", agent_name: "a", status: "running", score: null, started_at: "2026-09-03 11:30", duration_s: null },
  ];
  const plansFix: Plan[] = [
    { plan_id: "p-reg", name: "回归", agent_name: "a", stages: [{ type: "dataset" }],
      schedule: { cron: "cron(0 3 ? * MON *)", budget_usd: 2 } },
    { plan_id: "p-obs", name: "线上", agent_name: "a", stages: [{ type: "observe" }], schedule: null },
  ];

  it("下次运行 = 最早的 cron 计划（周一 03:00 → 09-07）；带定时计划数只数 schedule 非空", () => {
    const kpi = deriveKpi(runsFix, plansFix, NOW);
    expect(kpi.next?.plan.plan_id).toBe("p-reg");
    expect(kpi.next?.nextRun?.toISOString()).toBe("2026-09-07T03:00:00.000Z");
    expect(kpi.scheduledCount).toBe(1);
    expect(kpi.hasRate).toBe(false);
  });

  it("本月花费：只算本月 UTC 的 completed（r1 0.5）；上月 completed 与本月 error 都不算", () => {
    const kpi = deriveKpi(runsFix, plansFix, NOW);
    expect(kpi.monthSpend).toBeCloseTo(0.5, 10);
    expect(kpi.monthSpendN).toBe(1);
  });

  it("本月无 completed 样本 → monthSpend null（页面显 —，不是 0）", () => {
    const kpi = deriveKpi([runsFix[1], runsFix[3]], plansFix, NOW);
    expect(kpi.monthSpend).toBeNull();
    expect(kpi.monthSpendN).toBe(0);
  });

  it("近 24h 运行数：只计 started_at 落在窗口内的（r3 三天前不算）", () => {
    const kpi = deriveKpi(runsFix, plansFix, NOW);
    expect(kpi.runs24h).toBe(3);
  });

  it("无 cron 计划：next null；只有 rate 计划时 hasRate=true（相位未知，不伪造时刻）", () => {
    expect(deriveKpi(runsFix, [plansFix[1]], NOW).next).toBeNull();
    const rateOnly: Plan[] = [{ plan_id: "p-rate", name: "R", agent_name: "a", schedule: "rate(1 day)" }];
    const k = deriveKpi(runsFix, rateOnly, NOW);
    expect(k.next).toBeNull();
    expect(k.hasRate).toBe(true);
    expect(k.scheduledCount).toBe(1);
    expect(deriveKpi(runsFix, undefined, NOW).scheduledCount).toBe(0);
  });
});

describe("formatDuration", () => {
  it("Xm Ys 格式；不足 1 分钟只显秒；null → —", () => {
    expect(formatDuration(74)).toBe("1m 14s");
    expect(formatDuration(12)).toBe("12s");
    expect(formatDuration(120)).toBe("2m 0s");
    expect(formatDuration(null)).toBe("—");
  });
});

// ---------- 计划表 ----------
describe("WorkbenchPage 计划表", () => {
  it("card 包 u-table：计划名主行+plan_id 副行、Agent 深链、定时人话、预算、运行文字链", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    const table = await screen.findByTestId("plans-table");
    expect(table).toHaveClass("u-table");
    expect(table.closest(".card")).not.toBeNull();
    expect(screen.getByTestId("plans-count")).toHaveTextContent(String(AGENT_PLANS.length));
    const row = within(table).getByTestId("plan-row-plan-aaa111");
    expect(row).toHaveTextContent("FAQ 周回归");
    expect(row).toHaveTextContent("plan-aaa111");
    const agent = within(row).getByTestId("plan-row-plan-aaa111-agent");
    expect(agent).toHaveTextContent("support-bot");
    expect(agent).toHaveAttribute("href", "#/agent/support-bot/evaluate");
    // 定时列是 cron 人话（cronEngine.humanize），原串进 title
    const cron = within(row).getByTestId("plan-row-plan-aaa111-cron");
    expect(cron).toHaveTextContent("每周一 03:00 UTC 运行");
    expect(cron).toHaveAttribute("title", "cron(0 3 ? * MON *)");
    // 单次预算 = schedule.budget_usd（2.0）
    expect(within(row).getByTestId("plan-row-plan-aaa111-budget")).toHaveTextContent("2.00");
    const run = within(row).getByTestId("plan-row-plan-aaa111-run");
    expect(run).toHaveClass("btn-link");
    expect(run).not.toHaveClass("btn");
    // 无定时：定时「手动」、预算 / 下次运行回退 —
    const noSched = within(table).getByTestId("plan-row-plan-bbb222");
    expect(within(noSched).getByTestId("plan-row-plan-bbb222-cron")).toHaveTextContent("手动");
    expect(within(noSched).getByTestId("plan-row-plan-bbb222-budget")).toHaveTextContent("—");
    expect(within(noSched).getByTestId("plan-row-plan-bbb222-next")).toHaveTextContent("—");
  });

  it("环节链：只显示计划真含的环节（用户定案：未选的不显示）", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    await screen.findByTestId("plans-table");
    // plan-bbb222 只有 redteam → 只显示红队测试一项
    const stages = screen.getByTestId("plan-row-plan-bbb222-stages");
    expect(stages).toHaveClass("stages");
    expect(stages.querySelector('[data-stage="observe"]')).toBeNull();
    expect(stages.querySelector('[data-stage="dataset"]')).toBeNull();
    expect(stages.querySelector('[data-stage="redteam"]')).not.toBeNull();
    expect(stages).not.toHaveTextContent("线上评估");
    expect(stages).not.toHaveTextContent("回归测试");
    expect(stages).toHaveTextContent("红队测试");
  });

  it("超预算：预估 > schedule.budget_usd 在预算格显示 .badge.warn（后端无 over_budget 键，前端推）", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    await screen.findByTestId("plans-table");
    // plan-ddd666：预算 1.0 < 预估 1.85 → 超预算，title 带两个数
    const over = screen.getByTestId("plan-row-plan-ddd666-budget");
    expect(over).toHaveTextContent("1.00");
    const badge = over.querySelector(".badge.warn");
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent("超预算");
    expect(badge).toHaveAttribute("title", "单次预估 $1.85 > 预算 $1.00");
    // 预算充足（aaa111：2.0 > 0.42）与无定时（bbb222：预算不存在，
    // 1.85 也谈不上超）都不显示
    expect(screen.getByTestId("plan-row-plan-aaa111-budget").querySelector(".badge")).toBeNull();
    expect(screen.getByTestId("plan-row-plan-bbb222-budget").querySelector(".badge")).toBeNull();
    // 存量字符串 schedule（ccc333: "rate(1 day)"）没有预算 → —
    expect(screen.getByTestId("plan-row-plan-ccc333-budget")).toHaveTextContent("—");
  });

  it("最近结果：状态点 + 分数；无 last_run 显示「未运行」；环节炸了显示部分失败", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    await screen.findByTestId("plans-table");
    const ok = screen.getByTestId("plan-row-plan-aaa111");
    expect(ok.querySelector(".status-dot.completed")).toBeTruthy();
    expect(ok).toHaveTextContent("完成");
    expect(ok).toHaveTextContent("0.86");
    // 从未运行：明说「未运行」，不再是含义不明的「—」
    const none = screen.getByTestId("plan-row-plan-ccc333");
    expect(none.querySelector(".status-dot")).toBeNull();
    expect(none).toHaveTextContent("未运行");
    // 上次运行部分失败（ddd666：observe 完成 + redteam 环节 DDB 写超限）：
    // 琥珀点 + 「部分失败 · 红队测试」——绝不显示成绿色「完成」（UI-025）
    const part = screen.getByTestId("plan-row-plan-ddd666");
    expect(part.querySelector(".status-dot.warn")).toBeTruthy();
    expect(part.querySelector(".status-dot.completed")).toBeNull();
    expect(part).toHaveTextContent("部分失败 · 红队测试");
    // 整体失败（bbb222）：红点 + 失败
    const err = screen.getByTestId("plan-row-plan-bbb222");
    expect(err.querySelector(".status-dot.error")).toBeTruthy();
    expect(err).toHaveTextContent("失败");
  });

  // 渲染路径先备好：线上 PLANRUN 分区暂无 running item（planrun.py 只在
  // run 结束时 _persist），默认 mock 不造后端产不出的态——这里用显式 stub
  // 锁住「后端一旦补 write-at-start，前端立即正确显示运行中」。
  it("最近结果「运行中」渲染路径：accent 点 + 文案", async () => {
    stubFetch({
      list_plans: () => sseResponse([{
        event: "plans",
        plans: [{
          plan_id: "plan-live", name: "跑着的计划", agent_name: "support-bot",
          stages: [{ type: "observe" }], schedule: null,
          last_run: { run_key: "plan-live#20260824090000", status: "running",
                      score: null, finished_at: null, stage_summaries: [] },
          estimated_cost_usd: 0.2,
        }],
      }]),
    });
    renderPage(<WorkbenchPage />);
    await screen.findByTestId("plans-table");
    const row = screen.getByTestId("plan-row-plan-live");
    expect(row.querySelector(".status-dot.running")).toBeTruthy();
    expect(row).toHaveTextContent("运行中");
  });

  it("计划名点击跳 #/plan/:id（button 语义）", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    const name = await screen.findByTestId("plan-row-plan-aaa111-open");
    expect(name.tagName).toBe("BUTTON");
    fireEvent.click(name);
    expect(location.hash).toBe("#/plan/plan-aaa111");
  });

  it("未登录：新建计划与运行均 disabled 且带 title", async () => {
    useSession.setState({ token: null, authed: false, everAuthed: false, authExpired: false });
    stubFetch();
    renderPage(<WorkbenchPage />);
    await screen.findByTestId("plans-table");
    const newBtn = screen.getByTestId("plans-new");
    expect(newBtn).toBeDisabled();
    expect(newBtn).toHaveAttribute("title", "请先登录");
    const runBtn = screen.getByTestId("plan-row-plan-aaa111-run");
    expect(runBtn).toBeDisabled();
    expect(runBtn).toHaveAttribute("title", "请先登录");
  });

  it("运行：确认后发 run_plan 请求 + toast「已开始」+ 跳 #/plan/:id", async () => {
    const calls = stubFetch();
    renderPage(<WorkbenchPage />);
    fireEvent.click(await screen.findByTestId("plan-row-plan-aaa111-run"));
    // 缺陷 2 起：发起运行多一步二次确认（下面用例专测这一步）
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    expect(location.hash).toBe("#/plan/plan-aaa111");
    await waitFor(() => {
      expect(calls.some((c) => c.action === "run_plan" && c.plan_id === "plan-aaa111")).toBe(true);
    });
    // 缺陷 1 起：「已开始」改成收到后端首个事件才弹（此前是无条件先报喜），
    // 请求已发出 ≠ 后端已接单，故这条必须自己 waitFor，不能借上面的锚点
    await waitFor(() => expect(screen.getByTestId("toast")).toHaveTextContent("已开始"));
  });

  // ===== 缺陷 2：发起运行必须二次确认（每一次误点都在花真钱） =====
  it("点运行只开确认卡：不发 run_plan、不跳转、不 toast；卡上有 estimate_plan_run 的预估费用", async () => {
    const calls = stubFetch();
    renderPage(<WorkbenchPage />);
    fireEvent.click(await screen.findByTestId("plan-row-plan-aaa111-run"));
    const card = screen.getByTestId("confirm-card");
    expect(card).toHaveTextContent("FAQ 周回归");
    expect(calls.some((c) => c.action === "run_plan")).toBe(false);
    expect(location.hash).toBe("#/workbench");
    expect(screen.queryByTestId("toast")).toBeNull();
    // 锚点挑目标数据专属：预估格里的真数字（estimate_plan_run 的
    // estimated_cost_usd=0.42），不是「运行」这类通用文案
    await waitFor(() =>
      expect(screen.getByTestId("run-confirm-cost")).toHaveTextContent("$0.42"));
    expect(calls.some((c) => c.action === "estimate_plan_run" && c.plan_id === "plan-aaa111"))
      .toBe(true);
  });

  it("确认卡取消：不发 run_plan、不跳转（误点的唯一出口）", async () => {
    const calls = stubFetch();
    renderPage(<WorkbenchPage />);
    fireEvent.click(await screen.findByTestId("plan-row-plan-aaa111-run"));
    await waitFor(() =>
      expect(screen.getByTestId("run-confirm-cost")).toHaveTextContent("$0.42"));
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    expect(calls.some((c) => c.action === "run_plan")).toBe(false);
    expect(location.hash).toBe("#/workbench");
  });

  it("空态：u-empty + 新建按钮", async () => {
    stubFetch({
      list_plans: () => sseResponse([{ event: "plans", plans: [] }]),
      list_recent_runs: () => sseResponse([{ event: "recent_runs", runs: [] }]),
    });
    renderPage(<WorkbenchPage />);
    const empty = await screen.findByTestId("plans-empty");
    expect(empty).toHaveClass("u-empty");
    expect(empty).toHaveTextContent("还没有评估计划");
    // 副句「创建第一个方案，把线上评估、回归测试与红队测试串成一条链」是使用说明 ⇒ 删；
    // 术语七词：「方案」一个不留（批 plans-board）
    expectProseGone(empty, "串成一条链", "方案");
    // 空态一句话带动作：新建按钮就在句旁
    expect(within(empty).getByTestId("plans-empty-new")).toBeEnabled();
    expect(within(empty).getByTestId("plans-empty-new")).toHaveTextContent("新建计划");
  });

  it("新建计划跳 #/plan/new", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    fireEvent.click(await screen.findByTestId("plans-new"));
    expect(location.hash).toBe("#/plan/new");
  });

  it("加载中显示带表头的骨架屏", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("config.json")) return Response.json(CFG);
      return new Promise<Response>(() => {});
    }));
    renderPage(<WorkbenchPage />);
    const skeleton = await screen.findByTestId("plans-skeleton");
    expect(within(skeleton).getByText("计划名")).toBeInTheDocument();
    expect(within(skeleton).getByText("环节")).toBeInTheDocument();
    expect(within(skeleton).getByText("下次运行")).toBeInTheDocument();
  });
});

// ---------- 最近运行表 ----------
describe("WorkbenchPage 最近运行表", () => {
  it("状态 badge 映射：completed=ok error=bad running=run skipped=warn", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    const table = await screen.findByTestId("runs-table");
    expect(table).toHaveClass("u-table");
    const badge = (id: string) =>
      within(table).getByTestId(`run-row-${id}`).querySelector(".badge");
    expect(badge("plan-aaa111#2026-08-11T09:00:00Z")).toHaveClass("ok");
    expect(badge("plan-bbb222#2026-08-10T21:00:00Z")).toHaveClass("bad");
    expect(badge("plan-ccc333#2026-08-21T06:00:00Z")).toHaveClass("run");
    // skipped：badge 收敛到 lib/scoring.ts runBadge 后与方案详情/报告抽屉
    // 同刑（statusBadgeClass: skipped→warn）。此前工作台本地映射表给中性，
    // 是三处消费点里唯一的例外。
    const skipped = badge("plan-ccc333#2026-08-21T03:00:00Z")!;
    expect(skipped).toHaveClass("warn");
    expect(skipped).not.toHaveClass("ok");
    expect(skipped).not.toHaveClass("bad");
    expect(skipped).not.toHaveClass("run");
  });

  it("按环节判定（UI-013/UI-025）：纯回归成功=完成；环节炸了=部分失败", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    const table = await screen.findByTestId("runs-table");
    // 纯回归 run：顶层 score 恒 null（后端只写 observe 分），但回归环节
    // 跑出了通过率 → 「完成」，绝不是「完成 · 无可评估数据」
    const reg = within(table).getByTestId(
      "run-row-plan-ddd444#2026-08-21T05:00:00Z-badge");
    expect(reg).toHaveClass("ok");
    expect(reg).toHaveTextContent("完成");
    expect(reg).not.toHaveTextContent("无可评估数据");
    // 部分失败 run（线上实拍：红队环节 DDB 写超限炸掉，顶层 status 仍
    // completed）：必须亮出失败环节，不能绿色「完成」吞掉 stage.error
    const part = within(table).getByTestId(
      "run-row-plan-eee555#2026-08-21T04:00:00Z-badge");
    expect(part).toHaveClass("warn");
    expect(part).toHaveTextContent("部分失败 · 红队测试");
  });

  it("分数/耗时/UTC 注记/查看跳转", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    const table = await screen.findByTestId("runs-table");
    const row = within(table).getByTestId("run-row-plan-aaa111#2026-08-11T09:00:00Z");
    expect(row).toHaveTextContent("0.86");
    expect(row).toHaveTextContent("1m 14s");
    expect(row).toHaveTextContent("2026-08-11 09:00");
    expect(screen.getByTestId("runs-card")).toHaveTextContent("时间为 UTC");
    const view = within(row).getByTestId("run-row-plan-aaa111#2026-08-11T09:00:00Z-view");
    expect(view).toHaveClass("btn-link");
    fireEvent.click(view);
    expect(location.hash).toBe("#/plan/plan-aaa111");
  });
});

// ---------- KPI 条渲染 ----------
describe("WorkbenchPage KPI 条", () => {
  it("kpi-strip：hero 是下次运行（.data-lg 时刻 + 计划名 + cron 人话），三个次级格是带定时数 / 本月花费 / 近 24h", async () => {
    // 钉死时钟：2026-09-03（周四）12:00 UTC。默认假数据里的 cron：
    //   aaa111 周一 03:00 → 09-07；ddd666 每天 04:00 → 09-04；fff888 周二 02:00 → 09-08
    // ⇒ 最早是 ddd666「越权与泄露巡检」09-04 04:00
    vi.useFakeTimers({ now: Date.parse("2026-09-03T12:00:00Z"), shouldAdvanceTime: true });
    try {
      stubFetch();
      renderPage(<WorkbenchPage />);
      const strip = await screen.findByTestId("kpi-strip");
      expect(strip).toHaveClass("kpi-strip");
      // 锚点挑目标数据专属：hero 里的计划名（不是「下次运行」这个两态都有的标签）
      await waitFor(() =>
        expect(screen.getByTestId("kpi-next-run-meta")).toHaveTextContent("越权与泄露巡检"));
      const val = screen.getByTestId("kpi-next-run-val");
      expect(val).toHaveClass("data-lg");
      expect(val).toHaveTextContent("04:00");
      expect(val).toHaveTextContent("09-04");
      expect(screen.getByTestId("kpi-next-run-meta")).toHaveTextContent("每天 04:00 UTC 运行");
      // 带定时：aaa111 / ccc333(rate 字符串) / ddd666 / fff888 = 4
      expect(screen.getByTestId("kpi-scheduled-val")).toHaveTextContent("4");
      // 均分不再是这页的主角（ADR-0016）：整条 strip 里没有「均分」
      expect(strip).not.toHaveTextContent("均分");
    } finally {
      vi.useRealTimers();
    }
  });

  it("本月花费：只加本月 UTC completed 的 total_cost_usd，格与 title 都说明口径", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-03T12:00:00Z"), shouldAdvanceTime: true });
    try {
      stubFetch({
        list_recent_runs: () => sseResponse([{
          event: "recent_runs",
          runs: [
            // 本月 completed → 算
            { run_key: "r1", plan_id: "plan-aaa111", plan_name: "FAQ 周回归", agent_name: "a", status: "completed", score: 0.8, started_at: "2026-09-02 09:00 UTC", duration_s: 60, total_cost_usd: 0.41 },
            // 本月 error → 不算
            { run_key: "r2", plan_id: "plan-aaa111", plan_name: "FAQ 周回归", agent_name: "a", status: "error", score: null, started_at: "2026-09-02 10:00 UTC", duration_s: 5, total_cost_usd: 0.9 },
            // 上月 completed → 不算
            { run_key: "r3", plan_id: "plan-aaa111", plan_name: "FAQ 周回归", agent_name: "a", status: "completed", score: 0.9, started_at: "2026-08-31 23:50 UTC", duration_s: 60, total_cost_usd: 0.7 },
          ],
        }]),
      });
      renderPage(<WorkbenchPage />);
      await waitFor(() =>
        expect(screen.getByTestId("kpi-month-spend-val")).toHaveTextContent("$0.41"));
      expect(screen.getByTestId("kpi-month-spend-val").getAttribute("title")).toContain("completed 运行 1 次");
      expect(screen.getByTestId("plan-row-plan-aaa111-spend")).toHaveTextContent("0.41");
    } finally {
      vi.useRealTimers();
    }
  });

  it("无数据时 hero 显示 —，meta 说「无定时计划」，本月花费 —，近 24h 0", async () => {
    stubFetch({
      list_plans: () => sseResponse([{ event: "plans", plans: [] }]),
      list_recent_runs: () => sseResponse([{ event: "recent_runs", runs: [] }]),
    });
    renderPage(<WorkbenchPage />);
    await screen.findByTestId("plans-empty");
    expect(screen.getByTestId("kpi-next-run-val")).toHaveTextContent("—");
    expect(screen.getByTestId("kpi-next-run-meta")).toHaveTextContent("无定时计划");
    expect(screen.getByTestId("kpi-scheduled-val")).toHaveTextContent("0");
    expect(screen.getByTestId("kpi-month-spend-val")).toHaveTextContent("—");
    expect(screen.getByTestId("kpi-runs-24h-val")).toHaveTextContent("0");
  });

  it("list_recent_runs 请求带 limit", async () => {
    const calls = stubFetch();
    renderPage(<WorkbenchPage />);
    await screen.findByTestId("runs-table");
    const call = calls.find((c) => c.action === "list_recent_runs")!;
    expect(typeof call.limit).toBe("number");
  });
});
