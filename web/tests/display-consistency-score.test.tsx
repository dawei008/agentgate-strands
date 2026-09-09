// 同一个量不许有两个住址：run 顶层 score 的**取值显示位**全部走 effectiveScore。
//
// 缺陷形状（现网实拍 plan-c1202e599ada 的同族）：8/19–8/21 落库的 run 顶层 score
// 是 null，分在 observe 环节的 overall_mean 里（顶层 score 是 8/22 才补写的，见
// lib/scoring.ts effectiveScore 的长注释）。读侧兜底 `effectiveScore` 已经把 KPI /
// 趋势 / 成功计数救回来了，但**行级显示位**还在直读 `r.score` —— 于是同一条 run
// 在方案详情页显示 0.74、在运行详情页左栏显示「—」，两处对同一个事实说两句话。
//
// ⚠️ 缺陷签名不是「直读 `.score`」（那个 grep 命中三种语义，只有第一种是缺陷）：
//   ① **取值显示位** —— 本文件要清的那族（RunDetailPage 左栏 / RunsBlock 分数列 /
//      WorkbenchPage 运行表与「上次结果」/ ReportDrawer 的 Δ 较上次）；
//   ② **透传给已有兜底的函数** —— `runBadge({score: run.score ?? null, …})`
//      （原 AgentsPage 目录表；2026-09-03 首页改观测卡后该载体不存在，describe ⑤
//      改钉首页评估行「不显示合成均分」）。scoring.ts 内部自带 observe 兜底，改成
//      effectiveScore 是**回归**：无环节的老归档 run 走 `runMetricChips` 的退化分支，
//      那一支恰恰读顶层 score ⇒ 指标 chip 会消失、badge 从「完成」掉成「完成 · 无可评估数据」；
//   ③ **环节级分数**（`EvaluatorResult.score`，RunDetailPage 的 meanScore 与
//      逐评估器行）—— 另一个量纲，不在这条口径里。
//
// 夹具一律用 handlers.ts 真夹具那一行（`plan-aaa111#2026-08-20T07:15:00Z`，
// score:null + observe overall_mean 0.7412），不另造老形态：形态出处与「两个投影
// 逐字同值」由 mock-legacy-shape.test.tsx 钉着，本文件只测显示位。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunDetailPage from "../src/pages/run/RunDetailPage";
import RunsBlock from "../src/pages/agents/detail/RunsBlock";
import WorkbenchPage from "../src/pages/workbench/WorkbenchPage";
import AgentsPage from "../src/pages/agents/AgentsPage";
import { effectiveScore } from "../src/lib/scoring";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import { sseFrames, AGENT_PLANS, AGENT_RUNS, PLAN_RUNS, fleetStatus } from "../src/mocks/handlers";

/** 老形态那一行的身份证（两个投影同一次 run） */
const LEGACY_KEY = "plan-aaa111#2026-08-20T07:15:00Z";
/** 它的 observe 环节均分 —— 兜底算出来的就是这个数，显示成 "0.74" */
const LEGACY_MEAN = 0.7412;
/** 同方案上一次有分 run（顶层 score 就在库里那种），供 Δ 用例作被减数 */
const NEW_KEY = "plan-aaa111#2026-08-11T09:00:00Z";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action?: string } & Record<string, unknown>;

const planRow = () => PLAN_RUNS.find((r) => r.run_key === LEGACY_KEY)!;
const agentRow = () => AGENT_RUNS.find((r) => r.run_key === LEGACY_KEY)!;

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

let overrides: Record<string, (p: Payload) => unknown[]> = {};

/** 默认桩：**真夹具数组**原样喂进页面（本批测的就是它们在各页的显示） */
const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: AGENT_PLANS }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: PLAN_RUNS }],
  list_recent_runs: () => [{ event: "recent_runs", runs: AGENT_RUNS }],
  discover: () => [{
    event: "agents", region: "us-west-2", from_cache: true,
    agents: [{ agent_name: "support-bot", runtime_arn: "arn:a" }],
  }],
  estimate_plan_run: (p) => [{
    event: "plan_run_estimate", plan_id: p.plan_id,
    stages: [{ type: "observe", judge_calls: 20, estimated_cost_usd: 0.12 }],
    estimated_cost_usd: 0.42, note: "预估",
  }],
  // 运行详情页的中栏/右栏不在本文件射程内：给一份最小终态摘要即可（左栏那列
  // 走的是 list_plan_runs，与这份无关）。
  get_plan_run: (p) => [{
    event: "plan_run", run_key: p.run_key, plan_id: "plan-aaa111",
    plan_name: "FAQ 周回归", agent_name: "support-bot", status: "completed",
    started_at: "2026-08-20 07:15 UTC", duration_s: 68, triggered_by: "schedule",
    stage_summaries: planRow().stage_summaries, overview: {},
  }],
  list_datasets: () => [{ event: "datasets", datasets: [] }],
};

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
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
  overrides = {};
  resetConfigForTest();
  resetRunFlightForTest();
  location.hash = "#/workbench";
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==================== ⓿ mock 同刑：新读的字段形态从后端源码核 ====================
//
// 办法照 tests/mock-parity-plan-reattach.test.ts：**唯一依据是后端源码本身**
// （readFileSync + 现算），不是本文件抄的名单。本批新读一个字段
// （RunsBlock 的版本 chip 读 `agent_version_label`），它必须同时满足两件：
//   · 在 `_run_from_item` 的 return 里（读侧唯一出口）；
//   · 在 `list_recent_runs` 的 ProjectionExpression 里 —— RunsBlock 吃的正是这个
//     **投影**过的 feed，漏投影不会报错，只会让版本恒为空（后端那份清单的自述：
//     「给 _run_from_item 加字段时要同步这份清单」）。
describe("⓿ mock 同刑：版本 chip 读的字段在后端两处都真有", () => {
  const planrunPy = readFileSync(resolve(process.cwd(), "../app/planrun.py"), "utf8");

  /** `def <name>` 到下一个顶层 def 之间的函数体 */
  function funcBody(py: string, name: string): string {
    const m = new RegExp(`^(?:async )?def ${name}\\(`, "m").exec(py);
    if (!m) throw new Error(`找不到函数 ${name}`);
    const rest = py.slice(m.index);
    const next = /\n(?:async )?def /.exec(rest.slice(1));
    return next ? rest.slice(0, next.index + 1) : rest;
  }

  it("防恒真：两段源码都切出来了（正则一失配就成空串，断言会处处绿）", () => {
    expect(funcBody(planrunPy, "_run_from_item").length).toBeGreaterThan(500);
    expect(funcBody(planrunPy, "list_recent_runs")).toContain("ProjectionExpression");
  });

  it("`agent_version_label` 在 _run_from_item 的 return 与 list_recent_runs 的投影里", () => {
    expect(funcBody(planrunPy, "_run_from_item")).toContain('"agent_version_label"');
    expect(funcBody(planrunPy, "list_recent_runs")).toContain("agent_version_label");
  });

  it("`score` 仍是 run 项的顶层键（兜底是**读侧**的，不改后端契约）", () => {
    expect(funcBody(planrunPy, "_run_from_item")).toContain('"score"');
  });
});

// ==================== ① 运行详情页左栏 run 列表 ====================
describe("① 运行详情页左栏：老形态 run 不再显「—」", () => {
  it("同一条 run 的分数与方案页一致（0.74，不是「—」）", async () => {
    location.hash = `#/run/${encodeURIComponent(LEGACY_KEY)}`;
    renderWith(<RunDetailPage id={LEGACY_KEY} />);
    // 锚点 = 断言同源的事实本身（那一行的分数格），不拿「列表出现了」当门槛
    await waitFor(() =>
      expect(screen.getByTestId(`run-row-${LEGACY_KEY}`)).toHaveTextContent("0.74"));
    const row = screen.getByTestId(`run-row-${LEGACY_KEY}`);
    expect(row).not.toHaveTextContent("—");
    expect(row).toHaveTextContent("完成");
  });

  it("新形态 run（顶层 score 在库里）一字未变：0.86", async () => {
    location.hash = `#/run/${encodeURIComponent(NEW_KEY)}`;
    renderWith(<RunDetailPage id={NEW_KEY} />);
    await waitFor(() =>
      expect(screen.getByTestId(`run-row-${NEW_KEY}`)).toHaveTextContent("0.86"));
  });

  it("真没有分的 run 仍是「—」（兜底不许伪造 0.00）", async () => {
    const noScore = "plan-aaa111#2026-08-05T03:00:00Z"; // 全熔断：无 observe 分
    location.hash = `#/run/${encodeURIComponent(noScore)}`;
    renderWith(<RunDetailPage id={noScore} />);
    await waitFor(() =>
      expect(screen.getByTestId(`run-row-${noScore}`)).toHaveTextContent("—"));
    expect(screen.getByTestId(`run-row-${noScore}`)).not.toHaveTextContent("0.00");
  });
});

// ==================== ② Agent 详情运行记录表 ====================
describe("② Agent 详情 RunsBlock：分数列 + 版本 chip", () => {
  it("老形态那一行显示 0.74（此前是「—」，而同页 KPI 已计入它）", async () => {
    renderWith(<RunsBlock name="support-bot" />);
    await waitFor(() =>
      expect(screen.getByTestId(`agent-run-row-${LEGACY_KEY}`)).toHaveTextContent("0.74"));
    expect(screen.getByTestId(`agent-run-row-${LEGACY_KEY}-badge`)).toHaveTextContent("完成");
  });

  it("run 行版本 chip 读 run **自己的快照**（不是 Agent 当前标签）", async () => {
    // 真夹具 AGENT_RUNS 刻意不带版本快照两键（该缺的缺，见 handlers.ts 自述），
    // 所以这一条用**字段级**局部投影把快照喂进来 —— 形态由 ⓿ 组对着后端源码核过。
    overrides.list_recent_runs = () => [{
      event: "recent_runs",
      runs: AGENT_RUNS.map((r) =>
        r.run_key === LEGACY_KEY ? { ...r, agent_version_label: "v1.2" } : r),
    }];
    renderWith(<RunsBlock name="support-bot" />);
    const chip = await screen.findByTestId(`agent-run-row-${LEGACY_KEY}-version`);
    expect(chip).toHaveTextContent("v1.2");
    // 老 run 没有快照 → 整个 chip 不画（旧数据不修，绝不画空 chip）
    expect(screen.queryByTestId(`agent-run-row-${NEW_KEY}-version`)).not.toBeInTheDocument();
  });
});

// ==================== ③ 工作台两处 ====================
describe("③ 工作台：运行表分数列 + 方案表「上次结果」", () => {
  it("运行表：老形态那一行的分数列是 0.74（此前「—」，而同页 hero 已计入）", async () => {
    renderWith(<WorkbenchPage />);
    const table = await screen.findByTestId("runs-table");
    await waitFor(() =>
      expect(within(table).getByTestId(`run-row-${LEGACY_KEY}`)).toHaveTextContent("0.74"));
  });

  it("方案表「上次结果」：last_run 是老形态时也出数字（此前**一个数都不显**）", async () => {
    // last_run 走 list_plans 的 join 出口（PlanLastRun）。真夹具里没有老形态的
    // last_run，用局部投影造一个 —— 形态就是 PLAN_RUNS 那一行的同一族键。
    overrides.list_plans = () => [{
      event: "plans",
      plans: AGENT_PLANS.map((p) => p.plan_id !== "plan-aaa111" ? p : {
        ...p,
        last_run: {
          run_key: LEGACY_KEY, status: "completed", score: null,
          finished_at: "2026-08-20 07:16 UTC",
          stage_summaries: planRow().stage_summaries,
        },
      }),
    }];
    renderWith(<WorkbenchPage />);
    await waitFor(() =>
      expect(screen.getByTestId("plan-row-plan-aaa111")).toHaveTextContent("0.74"));
    // 终态口径一字未动：仍是「完成」（按环节判定）
    expect(screen.getByTestId("plan-row-plan-aaa111")).toHaveTextContent("完成");
  });

  it("纯回归方案的「上次结果」仍不显数字（ADR-0003 硬线：通过率不是均分）", async () => {
    renderWith(<WorkbenchPage />);
    const row = await screen.findByTestId("plan-row-plan-fff888");
    expect(row).toHaveTextContent("完成");
    expect(row).not.toHaveTextContent("0.90");
    expect(row).not.toHaveTextContent("0.9");
  });
});

// ==================== ④ 报告抽屉的「较上次」Δ：已随 ADR-0014 下线 ====================
//
// 报告只讲本次（ADR-0014 第 1 条）：「较上次 ▲0.07」不再出现在报告 DOM ——
// 那两条 DOM 钉（▲0.12 / rd-delta-pos）随之退役。effectiveScore 的老形态兜底
// **本身**仍被钉着：函数级在 scoring-legacy-score.test.ts（16 条内联夹具），
// 主路径显影在本文件 ①②③⑤ 四组；「报告 DOM 里没有『较上次』」的负钉在
// tests/report-verdict.test.tsx（ADR-0014 的 Avoid 词条）。
describe("④ 报告抽屉 Δ 较上次：ADR-0014 下线（被减数兜底仍钉在函数级）", () => {
  it("前提自证：老形态行的顶层 score 是 null，兜底读 observe 均分", () => {
    expect(planRow().score).toBeNull();
    expect(effectiveScore(planRow() as never)).toBe(LEGACY_MEAN);
  });
});

// ==================== ⑤ AgentsPage 回归钉（代码零改动） ====================
//
// 这两条不是新功能，是**反向**守卫：AgentsPage:223/228 把 score 透传给
// runBadge/runMetricChips，而 scoring.ts 内部已自带 observe 兜底。若有人照
// 「统一走 effectiveScore」的字面把这两处也换掉，第二条会立刻红 ——
// `runMetricChips` 的**无环节退化分支**恰恰读顶层 score，而 effectiveScore 在
// 无环节时恒 null ⇒ 老归档 run 的指标 chip 消失、badge 掉成「无可评估数据」。
// 2026-09-03 ADR-0016：Agent 目录表格改成首页观测卡，原 ② 那条透传（AgentsPage 的
// `runBadge({score: run.score ?? null})` + 指标 chip）载体不复存在。新载体 = 卡底「评估」行，
// 口径是「M/K 评估器过线」（ADR-0016 分数口径修订：决策位**不显示合成均分**）。原两条钉的
// 反向翻译：老形态 run 与无环节老归档 run 在首页都**不许**冒出 0.74 / 0.83 这种 run 级均分；
// 后者（环节摘要为空）连 M/K 都算不出 ⇒ 「—」，也不许说「无可评估数据」（那是 run 终态，
// 不是评估器分母的事）。
describe("⑤ 首页评估行：不显示合成均分（老形态 / 无环节老归档两族）", () => {
  const two = () => [{
    event: "agents", region: "us-west-2", from_cache: true,
    agents: [
      { agent_name: "support-bot", runtime_arn: "arn:a", display_name: "", version_label: "" },
      { agent_name: "research-agent", runtime_arn: "", display_name: "", version_label: "" },
    ],
  }];
  const fleetWithLegacy = () => {
    const ev = fleetStatus(Date.now(), ["support-bot", "research-agent"]);
    const sb = ev.agents.find((a) => a.agent_name === "support-bot")!;
    return [{
      ...ev,
      agents: ev.agents.map((a) => (a === sb ? {
        ...sb, alerts: [],
        last_run: { run_key: LEGACY_KEY, plan_id: "plan-aaa111", plan_name: "FAQ 周回归",
                    status: "completed", observe_mean: LEGACY_MEAN, dataset_pass: null,
                    dataset_pass_rate: null, redteam_blocked: null, finished_at: "2026-08-20 07:16 UTC" },
      } : a)),
    }];
  };

  it("老形态 run（顶层 score null、observe 0.7412）：评估行是「评估器 M/K 过线」，不出现 0.74", async () => {
    location.hash = "#/agents";
    overrides.discover = two;
    overrides.fleet_status = fleetWithLegacy;
    overrides.list_recent_runs = () => [{ event: "recent_runs", runs: [agentRow()] }];
    renderWith(<AgentsPage />);
    const row = await screen.findByTestId("agent-card-support-bot-eval");
    expect(row).toHaveTextContent("FAQ 周回归");
    // 该行 observe 摘要 summary 为 {}（老形态）⇒ 一个可数的评估器都没有 ⇒ 「—」
    expect(within(row).getByTestId("agent-card-support-bot-gate")).toHaveTextContent("评估器 — 过线");
    expect(row.textContent).not.toContain("0.74");
    expect(row.textContent).not.toContain("均分");
  });

  it("**无环节**的老归档 run（score 0.83、stage_summaries []）：评估行「评估器 — 过线」，不出现 0.83 也不说无可评估数据", async () => {
    location.hash = "#/agents";
    overrides.discover = two;
    overrides.fleet_status = fleetWithLegacy;
    overrides.list_recent_runs = () => [{
      event: "recent_runs",
      runs: [{ ...agentRow(), score: 0.83, stage_summaries: [] }],
    }];
    renderWith(<AgentsPage />);
    const row = await screen.findByTestId("agent-card-support-bot-eval");
    expect(within(row).getByTestId("agent-card-support-bot-gate")).toHaveTextContent("评估器 — 过线");
    expect(row.textContent).not.toContain("0.83");
    expect(row.textContent).not.toContain("无可评估数据");
    // 状态 badge 走 runOutcome 退化分支（有顶层分 ⇒ ok）：正常，不是「run 失败」
    expect(screen.getByTestId("agent-card-support-bot-badge")).toHaveTextContent("正常");
  });
});

// ==================== ⑥ 注释真话守卫（防同一句失实注释再长回来） ====================
//
// `lib/scoring.ts` 的 isScored 自 c34cb78 起走 effectiveScore 兜底，所以
// 「isScored / 顶层 score 语义一行未动」这句话是**假的**。它在 plan/derive.ts 里
// 有两处同文副本（TrendCard 那处已在上一批改准）。断言写成「符号引用 + 不写日期」：
// 写日期本身就会成为下一个漂移源（本仓已踩过）。
describe("⑥ 注释不许再声称 isScored 语义未动", () => {
  const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("plan/derive.ts 与 TrendCard.tsx 都不再有那句失实断言", () => {
    for (const f of ["src/pages/plan/derive.ts", "src/pages/plan/TrendCard.tsx"]) {
      const text = src(f);
      expect(text, `${f} 仍在声称 isScored 语义未动`)
        .not.toMatch(/isScored\s*\/\s*顶层\s*score\s*语义一行未动/);
    }
  });

  it("防恒真：那两个文件真的读到了内容，且仍在谈 ADR-0003 硬线", () => {
    for (const f of ["src/pages/plan/derive.ts", "src/pages/plan/TrendCard.tsx"]) {
      expect(src(f).length).toBeGreaterThan(1000);
      expect(src(f)).toContain("ADR-0003");
    }
  });
});
