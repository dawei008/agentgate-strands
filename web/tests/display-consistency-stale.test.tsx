// 陈旧 running 的两处收口：同一条 run 不许在两页说两句话，且死路不许留活入口。
//
// 缺陷形状（UI-029 批 3 交付时点名，两处都在那批 owns 之外）：
//   1. 后端读侧已经把 `stale` 投给了每一行（`app/stalecheck.py:is_stale` 三级判据
//      → `planrun.py:_run_from_item`），方案详情页据此显示中性「疑似中断」，而
//      **运行详情页左栏 run 列表不读它** ⇒ 同一条 run 在方案页是「疑似中断」、在
//      运行详情页仍是「运行中」。与 effective-score 那族（一个量多个住址）同形。
//   2. 陈旧行仍留着可点的「停止」入口。对一个已失联的进程点停止只会写一个
//      `stop_requested` 标志，而**没有任何东西会消费它**（执行进程早没了；改判归
//      reaper 的独立扫描）—— 用户点完看到「已请求停止」，然后什么都不会发生。
//
// 前端**零判定逻辑**：两处都只消费后端那个布尔。判据抄成第二份就等于让 reaper、
// 读侧、将来的并发闸门各算一遍（那一份的住所是 app/stalecheck.py）。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expectProseGone } from "./prose";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunDetailPage from "../src/pages/run/RunDetailPage";
import PlanDetailPage from "../src/pages/plan/PlanDetailPage";
import { STALE_RUNNING_BADGE, STATUS_LABEL } from "../src/lib/scoring";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import { sseFrames, AGENT_PLANS, PLAN_RUNS, REATTACH_PLAN_RUNS } from "../src/mocks/handlers";

/** 疑似中断那一行（真夹具 REATTACH_PLAN_RUNS 的 ②：stale=true、无心跳） */
const STALE_KEY = "plan-aaa111#2026-08-26T00:05:00Z";
/** 同一份夹具里的**活着的** running（心跳新鲜、stale=false）—— 对照组 */
const LIVE_KEY = "plan-aaa111#2026-08-26T02:40:00Z";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action?: string } & Record<string, unknown>;

const staleRow = () =>
  REATTACH_PLAN_RUNS.find((r) => r.run_key === STALE_KEY) as Record<string, unknown>;

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

let calls: Payload[] = [];
let overrides: Record<string, (p: Payload) => unknown[]> = {};

/** 默认桩喂 REATTACH_PLAN_RUNS（`?mock=reattach` 那份真夹具：一行活 running +
 *  一行 stale=true + 一行被 reaper 改判的 error）。默认 PLAN_RUNS 里没有陈旧行，
 *  夹具形态出处见 handlers.ts 的 REATTACH_PLAN_RUNS 注释。 */
const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: AGENT_PLANS }],
  list_plan_runs: (p) => [
    { event: "plan_runs", plan_id: p.plan_id, runs: REATTACH_PLAN_RUNS },
  ],
  list_recent_runs: () => [{ event: "recent_runs", runs: [] }],
  list_datasets: () => [{ event: "datasets", datasets: [] }],
  discover: () => [{
    event: "agents", region: "us-west-2", from_cache: true,
    agents: [{ agent_name: "support-bot", runtime_arn: "arn:a" }],
  }],
  estimate_plan_run: (p) => [{
    event: "plan_run_estimate", plan_id: p.plan_id,
    stages: [{ type: "observe", judge_calls: 20, estimated_cost_usd: 0.12 }],
    estimated_cost_usd: 0.42, note: "预估",
  }],
  // 陈旧 run 还没有归档（s3_key 空 ⇒ 没有 report）—— 形态照 handlers 的
  // runningRunDetail：运行详情页中/右栏无明细，本文件只看左栏那一行。
  get_plan_run: (p) => [{
    event: "plan_run", run_key: p.run_key, plan_id: "plan-aaa111",
    plan_name: "FAQ 周回归", agent_name: "support-bot", status: "running",
    score: null, started_at: "2026-08-26 00:05 UTC", duration_s: null,
    triggered_by: "schedule", stage_summaries: [], overview: {}, s3_key: null,
    stale: true, heartbeat_epoch: null, progress: null, checkpoint_s3_key: null,
  }],
  stop_plan_run: (p) => [{
    event: "plan_run_stop_requested", run_key: p.run_key, status: "running",
    requested: true, already: false, message: "已请求停止，将在下一个检查点生效",
  }],
};

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    calls.push(payload);
    const handler = overrides[String(payload.action)] ?? DEFAULTS[String(payload.action)];
    if (!handler) return sseResponse([{ event: "error", error: `未打桩 ${payload.action}` }]);
    return sseResponse(handler(payload));
  }));
}

function renderWith(node: ReactElement): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  calls = [];
  overrides = {};
  resetConfigForTest();
  resetRunFlightForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==================== ⓿ mock 同刑 + 前端零判定自证 ====================
describe("⓿ mock 同刑：stale 是后端字段，前端一行判定都不许有", () => {
  const planrunPy = readFileSync(resolve(process.cwd(), "../app/planrun.py"), "utf8");
  const stalecheckPy = readFileSync(resolve(process.cwd(), "../app/stalecheck.py"), "utf8");

  it("防恒真：两份源码都读到了，判据函数在 stalecheck 里", () => {
    expect(planrunPy.length).toBeGreaterThan(1000);
    expect(stalecheckPy).toMatch(/^def is_stale\(/m);
  });

  it("`stale` 由读侧唯一出口 _run_from_item 产出，且值来自 stalecheck.is_stale", () => {
    expect(planrunPy).toContain('"stale": stalecheck.is_stale(item, time.time())');
  });

  it("夹具那一行的形态与后端产得出的一致：running + stale=true + **无心跳**", () => {
    const row = staleRow();
    expect(row, "REATTACH_PLAN_RUNS 缺 stale=true 那一行").toBeTruthy();
    expect(row.status).toBe("running");
    expect(row.stale).toBe(true);
    // 心跳新鲜就不可能陈旧（一级判据）—— 两者同时出现是后端产不出的形态
    expect(row).not.toHaveProperty("heartbeat_epoch");
  });

  it("展示投影复用既有常量，且**没有**塞进后端 status 那张表（五态不许变六态）", () => {
    expect(STALE_RUNNING_BADGE).toEqual({ cls: "badge warn", label: "疑似中断" });
    expect(Object.values(STATUS_LABEL)).not.toContain("疑似中断");
    expect(STATUS_LABEL.running).toBe("运行中");
  });

  it("前端不许出现第二份判据：运行详情页只读布尔，不算心跳/时长/天花板", () => {
    const page = readFileSync(
      resolve(process.cwd(), "src/pages/run/RunDetailPage.tsx"), "utf8");
    // 消费那个布尔 + 复用既有展示常量（不新造第二个「疑似中断」字面量）
    expect(page).toMatch(/stale\s*===\s*true/);
    expect(page).toContain("STALE_RUNNING_BADGE");
    // 文案住所只有 lib/scoring.ts：本页不许出现第二个「疑似中断」**字符串字面量**
    // （注释里提它当然可以 —— 判据是它有没有被当成代码里的文案写死）
    expect(page, "本页写死了「疑似中断」文案（住所只有 lib/scoring.ts）")
      .not.toMatch(/["'`][^"'`\n]*疑似中断/);
    // 判据的原料一个都不许在本页出现（出现就说明判定被抄成了第二份）
    for (const raw of ["heartbeat_epoch", "estimated_duration_s"]) {
      expect(page, `运行详情页不该读 ${raw}（判据只在后端一份）`).not.toContain(raw);
    }
  });
});

// ==================== ① 运行详情页左栏：同一条 run 同一句话 ====================
describe("① 运行详情页左栏：陈旧 running 显示「疑似中断」", () => {
  it("陈旧那一行是「疑似中断」，不再是「运行中」", async () => {
    location.hash = `#/run/${encodeURIComponent(STALE_KEY)}`;
    renderWith(<RunDetailPage id={STALE_KEY} />);
    // 锚点 = 断言同源的事实（那一行的文案本身）
    await waitFor(() =>
      expect(screen.getByTestId(`run-row-${STALE_KEY}`)).toHaveTextContent("疑似中断"));
    expect(screen.getByTestId(`run-row-${STALE_KEY}`)).not.toHaveTextContent("运行中");
  });

  it("视觉态是既有 warn（不是猩红）：只是**疑似**，且这次运行真花过钱", async () => {
    location.hash = `#/run/${encodeURIComponent(STALE_KEY)}`;
    renderWith(<RunDetailPage id={STALE_KEY} />);
    const row = await screen.findByTestId(`run-row-${STALE_KEY}`);
    await waitFor(() => expect(row).toHaveTextContent("疑似中断"));
    const badge = within(row).getByText("疑似中断");
    expect(badge).toHaveClass("badge", "warn");
    expect(badge).not.toHaveClass("bad");
  });

  it("活着的 running 一字未变：仍是「运行中」（stale=false 不许被这条带走）", async () => {
    location.hash = `#/run/${encodeURIComponent(LIVE_KEY)}`;
    renderWith(<RunDetailPage id={LIVE_KEY} />);
    await waitFor(() =>
      expect(screen.getByTestId(`run-row-${LIVE_KEY}`)).toHaveTextContent("运行中"));
    expect(screen.getByTestId(`run-row-${LIVE_KEY}`)).not.toHaveTextContent("疑似中断");
  });

  // ⚠️ **违规才红的钉**（唯一能把「零判定逻辑」测成真的办法）：diff 里出现 `stale`
  // 区分不了「读后端字段渲染」与「自己又算了一遍」，只有下面这条能。
  //
  // 夹具是**故意自相矛盾的毛刺**，不是后端产得出的形态（`stalecheck.is_stale` 一级
  // 判据：有心跳且 now − heartbeat > 210s 必回 True，所以真后端给不出「心跳很旧 ∧
  // stale=false」）。它的用途只有一个：把「前端有没有自己按心跳算」变成可判定 ——
  // 谁在前端补一句 heartbeat 判定，这条立刻红。别照它推断契约。
  it("**违规钉**：stale=false 但心跳很旧 → 仍显「运行中」（前端零判定逻辑）", async () => {
    const oldBeat = Math.floor(Date.now() / 1000) - 7200; // 2 小时前，远超 210s 阈值
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: [{
        ...staleRow(), stale: false,
        heartbeat_epoch: oldBeat,
        started_epoch: Math.floor(Date.now() / 1000) - 7800,
        estimated_duration_s: 60,
      }],
    }];
    location.hash = `#/run/${encodeURIComponent(STALE_KEY)}`;
    renderWith(<RunDetailPage id={STALE_KEY} />);
    await waitFor(() =>
      expect(screen.getByTestId(`run-row-${STALE_KEY}`)).toHaveTextContent("运行中"));
    expect(screen.getByTestId(`run-row-${STALE_KEY}`),
           "前端自己按心跳/预估算了一遍 —— 判据只许有后端那一份")
      .not.toHaveTextContent("疑似中断");
  });

  it("缺 stale 键的老响应按 false 处理（前端绝不自己补判）", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: [{ ...staleRow(), stale: undefined }],
    }];
    location.hash = `#/run/${encodeURIComponent(STALE_KEY)}`;
    renderWith(<RunDetailPage id={STALE_KEY} />);
    await waitFor(() =>
      expect(screen.getByTestId(`run-row-${STALE_KEY}`)).toHaveTextContent("运行中"));
    expect(screen.getByTestId(`run-row-${STALE_KEY}`)).not.toHaveTextContent("疑似中断");
  });
});

// ==================== ② 陈旧行的「停止」入口置灰 ====================
describe("② 方案详情页：陈旧 running 行的「停止」置灰并说清理由", () => {
  beforeEach(() => { location.hash = "#/plan/plan-aaa111"; });

  it("陈旧行的停止按钮 disabled，且理由进 title（按钮**不删**）", async () => {
    renderWith(<PlanDetailPage id="plan-aaa111" />);
    const btn = await screen.findByTestId(`plan-run-row-${STALE_KEY}-stop`);
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("停止");           // 入口仍在（删了像功能消失）
    expect(btn.getAttribute("title")).toContain("已失联");
    expect(btn.getAttribute("title")).toContain("不会被消费");
    // 「巡检会将其改判为终态」是机制讲解，对任何陈旧行恒成立 ⇒ 从 title 删
    // （prose-sweep 2026-09-03；此前钉的是它**在**）
    expectProseGone(btn, "巡检");
  });

  it("点不动：点了也不发 stop_plan_run（死路不许留活入口）", async () => {
    renderWith(<PlanDetailPage id="plan-aaa111" />);
    const btn = await screen.findByTestId(`plan-run-row-${STALE_KEY}-stop`);
    fireEvent.click(btn);
    // 确认卡都不该开（disabled 按钮不响应），更不该发请求
    expect(screen.queryByTestId("confirm-card-ok")).not.toBeInTheDocument();
    expect(calls.some((c) => c.action === "stop_plan_run")).toBe(false);
  });

  it("活着的 running 行的停止入口照旧可点（这条闸门只对陈旧行）", async () => {
    renderWith(<PlanDetailPage id="plan-aaa111" />);
    const btn = await screen.findByTestId(`plan-run-row-${LIVE_KEY}-stop`);
    expect(btn).toBeEnabled();
    expect(btn.getAttribute("title")).toBeNull();
  });

  it("终态行本来就没有停止入口（无操作 ≠ 置灰，两件事别混）", async () => {
    renderWith(<PlanDetailPage id="plan-aaa111" />);
    await screen.findByTestId(`plan-run-row-${LIVE_KEY}-stop`);
    const settled = "plan-aaa111#2026-08-11T09:00:00Z";
    expect(screen.queryByTestId(`plan-run-row-${settled}-stop`)).not.toBeInTheDocument();
  });

  it("同一行的 badge 仍是「疑似中断」（置灰与展示态读的是同一个布尔）", async () => {
    renderWith(<PlanDetailPage id="plan-aaa111" />);
    const badge = await screen.findByTestId(`plan-run-row-${STALE_KEY}-badge`);
    expect(badge).toHaveTextContent(STALE_RUNNING_BADGE.label);
  });
});

// ==================== ③ 默认夹具（无陈旧行）零行为变化 ====================
describe("③ 没有陈旧行时一切照旧（默认 PLAN_RUNS）", () => {
  it("默认那条老 running 的停止入口可点（它的 stale 是 false，是真值不是默认值）", async () => {
    overrides.list_plan_runs = (p) => [
      { event: "plan_runs", plan_id: p.plan_id, runs: PLAN_RUNS },
    ];
    location.hash = "#/plan/plan-aaa111";
    renderWith(<PlanDetailPage id="plan-aaa111" />);
    const key = "plan-aaa111#2026-08-25T06:10:00Z";
    const btn = await screen.findByTestId(`plan-run-row-${key}-stop`);
    expect(btn).toBeEnabled();
    expect(screen.getByTestId(`plan-run-row-${key}-badge`)).toHaveTextContent("运行中");
  });
});
