// 评估器页「跨 Agent 表现」（ADR-0016 舰队级：区分「Agent 差」与「尺子太严」）。
//
// 派生（evaluatorUsage.ts）：
//   · 数据源 list_recent_runs，只算 status=completed 的 run，只读 completed 环节；
//   · 分从 dataset `evaluator_stats[名].mean` / observe `summary[名].mean_score` 读
//     （复用 plan/derive.evaluatorRows / observeEvaluatorRows）；
//   · 每格 = 某评估器在某 Agent 最近一次 completed run 的分；Agent 去重；
//   · 「长期过不了」= 从最近一次往回连续 ≥3 次 < 0.70，一次达标即断；
//   · 判读：所有在用 Agent 都长期过不了 ⇒ 尺子偏严？；部分最近一次未过线 ⇒ N 个 Agent
//     未过线；都过 ⇒ —；没出过分 ⇒ Agent 数 0、其余 —。
//   · 排序：尺子偏严？ → N 降序 → 在用 Agent 数降序。
// 渲染（EvaluatorUsage.tsx）：两种判读各出现、chip 深链 #/agent/<name>/optimize、
//   未过线 chip 带 warn、连续 N 次尾注、样本口径「近 N 次 run · 只算 completed」、
//   空态一句话 + 「先跑一次评估计划」深链 #/workbench。
// fetch 打桩方式与 evaluator-descriptions.test.tsx 一致（stubGlobal + SSE Response）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import EvaluatorsPage from "../src/pages/resources/EvaluatorsPage";
import { resetConfigForTest } from "../src/lib/config";
import { useSession } from "../src/stores/session";
import { AGENT_RUNS, DDD_PLAN_RUNS, sseFrames } from "../src/mocks/handlers";
import {
  SCORE_TARGET, STREAK_MIN, deriveEvaluatorUsage, leadingFailStreak, runEvaluatorScores,
  type UsageRun,
} from "../src/pages/resources/evaluatorUsage";
import { SCORE_TARGET as HUB_TARGET } from "../src/pages/agents/detail/hub/optimizeDerive";

// ---------- 夹具 ----------

function datasetRun(
  agent: string, at: string, stats: Record<string, number>, status = "completed", stageStatus = "completed",
): UsageRun {
  return {
    run_key: `plan-x#${at}`, agent_name: agent, status, started_at: at,
    stage_summaries: [{
      type: "dataset", status: stageStatus, pass_rate: 0.5,
      evaluators: Object.keys(stats),
      evaluator_stats: Object.fromEntries(
        Object.entries(stats).map(([k, mean]) => [k, { mean, passed: 1, judged: 2 }]),
      ),
    }],
  };
}

function observeRun(agent: string, at: string, summary: Record<string, number>): UsageRun {
  return {
    run_key: `plan-o#${at}`, agent_name: agent, status: "completed", started_at: at,
    stage_summaries: [{
      type: "observe", status: "completed", overall_mean: 0.8, sessions: 3,
      summary: Object.fromEntries(
        Object.entries(summary).map(([k, mean_score]) => [k, { mean_score, pass_rate: 0.5 }]),
      ),
    }],
  };
}

const row = (t: ReturnType<typeof deriveEvaluatorUsage>, name: string) => {
  const r = t.rows.find((x) => x.name === name);
  if (!r) throw new Error(`没有 ${name} 这一行`);
  return r;
};

// ---------- 派生 ----------

describe("evaluatorUsage 派生", () => {
  it("目标线与 Agent 详情 ③ 优化面板同源（0.70）", () => {
    expect(SCORE_TARGET).toBe(0.7);
    expect(SCORE_TARGET).toBe(HUB_TARGET);
    expect(STREAK_MIN).toBe(3);
  });

  it("连续未过线从最近一次往回数，一次达标即断", () => {
    expect(leadingFailStreak([0.5, 0.6, 0.8, 0.4, 0.3])).toBe(2);
    expect(leadingFailStreak([0.9, 0.1, 0.1, 0.1])).toBe(0);
    expect(leadingFailStreak([0.1, 0.2, 0.3])).toBe(3);
    // 恰在目标线上算过
    expect(leadingFailStreak([0.7, 0.1])).toBe(0);
    expect(leadingFailStreak([])).toBe(0);
  });

  it("dataset 读 evaluator_stats[名].mean，observe 读 summary[名].mean_score；同一 run 两处都出分取较低者", () => {
    const d = runEvaluatorScores(datasetRun("a", "2026-09-01 01:00 UTC", { correctness: 0.62 }));
    expect(d.get("correctness")).toBe(0.62);
    const o = runEvaluatorScores(observeRun("a", "2026-09-01 01:00 UTC", { helpfulness: 0.91 }));
    expect(o.get("helpfulness")).toBe(0.91);
    const both: UsageRun = {
      run_key: "k", agent_name: "a", status: "completed", started_at: "2026-09-01 01:00 UTC",
      stage_summaries: [
        ...observeRun("a", "x", { helpfulness: 0.91 }).stage_summaries!,
        ...datasetRun("a", "x", { helpfulness: 0.55 }).stage_summaries!,
      ],
    };
    expect(runEvaluatorScores(both).get("helpfulness")).toBe(0.55);
  });

  it("只算 completed run 与 completed 环节；半截环节与 error/running run 的分不进表", () => {
    const t = deriveEvaluatorUsage([
      datasetRun("a", "2026-09-03 01:00 UTC", { refusal: 0.2 }, "error"),
      datasetRun("a", "2026-09-02 01:00 UTC", { refusal: 0.2 }, "running"),
      datasetRun("a", "2026-09-01 01:00 UTC", { refusal: 0.2 }, "completed", "error"),
      datasetRun("a", "2026-08-30 01:00 UTC", { refusal: 0.9 }),
    ], ["refusal"]);
    expect(t.totalRuns).toBe(4);
    expect(t.completedRuns).toBe(2);
    const r = row(t, "refusal");
    expect(r.agents).toEqual([{ agent: "a", latest: 0.9, latestRunKey: "plan-x#2026-08-30 01:00 UTC", streak: 0 }]);
    expect(r.verdict).toEqual({ kind: "ok" });
  });

  it("Agent 去重：同一 Agent 多次 run 只算一台，最近一次分取时间最新的（与传入顺序无关）", () => {
    const t = deriveEvaluatorUsage([
      datasetRun("a", "2026-08-01 01:00 UTC", { refusal: 0.3 }),
      datasetRun("a", "2026-08-03 01:00 UTC", { refusal: 0.5 }),   // 最新
      datasetRun("a", "2026-08-02 01:00 UTC", { refusal: 0.4 }),
    ], ["refusal"]);
    const r = row(t, "refusal");
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0].latest).toBe(0.5);
    expect(r.agents[0].streak).toBe(3);
    // 只有一台在用且它长期过不了 ⇒ 全体都过不了 ⇒ 尺子偏严？
    expect(r.verdict).toEqual({ kind: "strict" });
  });

  it("判读：一台连续 3 次 + 一台过线 ⇒ 「1 个 Agent 未过线」不是「尺子偏严？」；两台都连续 3 次 ⇒ 尺子偏严？", () => {
    const failing = [
      datasetRun("a", "2026-08-03 01:00 UTC", { refusal: 0.5 }),
      datasetRun("a", "2026-08-02 01:00 UTC", { refusal: 0.4 }),
      datasetRun("a", "2026-08-01 01:00 UTC", { refusal: 0.3 }),
    ];
    const partial = deriveEvaluatorUsage([...failing, observeRun("b", "2026-08-03 02:00 UTC", { refusal: 0.88 })], ["refusal"]);
    expect(row(partial, "refusal").verdict).toEqual({ kind: "partial", n: 1 });
    const strict = deriveEvaluatorUsage([
      ...failing,
      observeRun("b", "2026-08-03 02:00 UTC", { refusal: 0.61 }),
      observeRun("b", "2026-08-02 02:00 UTC", { refusal: 0.66 }),
      observeRun("b", "2026-08-01 02:00 UTC", { refusal: 0.69 }),
    ], ["refusal"]);
    expect(row(strict, "refusal").verdict).toEqual({ kind: "strict" });
    // 两台都最近一次未过线、但只有一台连续 3 次 ⇒ 2 个 Agent 未过线（不是尺子偏严）
    const two = deriveEvaluatorUsage([...failing, observeRun("b", "2026-08-03 02:00 UTC", { refusal: 0.2 })], ["refusal"]);
    expect(row(two, "refusal").verdict).toEqual({ kind: "partial", n: 2 });
  });

  it("没出过分的评估器照列一行（Agent 0、判读 none）；run 里有而名单里没有的名字追加在后", () => {
    const t = deriveEvaluatorUsage([datasetRun("a", "2026-08-01 01:00 UTC", { ghost_eval: 0.9 })], ["coherence"]);
    expect(t.rows.map((r) => r.name)).toEqual(["ghost_eval", "coherence"]);
    expect(row(t, "coherence").agents).toEqual([]);
    expect(row(t, "coherence").verdict).toEqual({ kind: "none" });
  });

  it("排序：尺子偏严？ → N 个未过线按 N 降序 → 其余按在用 Agent 数降序", () => {
    const runs: UsageRun[] = [
      // strict_e：a 连续 3 次
      datasetRun("a", "2026-08-03 01:00 UTC", { strict_e: 0.1, p2: 0.2, p1: 0.2, ok3: 0.9 }),
      datasetRun("a", "2026-08-02 01:00 UTC", { strict_e: 0.1 }),
      datasetRun("a", "2026-08-01 01:00 UTC", { strict_e: 0.1 }),
      // p2：b 也未过线（N=2）；p1：b 过线（N=1）；ok3：三台都过
      observeRun("b", "2026-08-03 02:00 UTC", { p2: 0.3, p1: 0.9, ok3: 0.9 }),
      observeRun("c", "2026-08-03 03:00 UTC", { ok3: 0.9, ok1: 0.8 }),
    ];
    const t = deriveEvaluatorUsage(runs, ["never", "ok1", "p1", "ok3", "p2", "strict_e"]);
    expect(t.rows.map((r) => r.name)).toEqual(["strict_e", "p2", "p1", "ok3", "ok1", "never"]);
  });

  it("空输入：0 run ⇒ 名单照列、totalRuns 0", () => {
    const t = deriveEvaluatorUsage([], ["coherence"]);
    expect(t.totalRuns).toBe(0);
    expect(t.rows).toHaveLength(1);
  });
});

// ---------- mock 素材 ----------

describe("mock 桩（handlers.ts AGENT_RUNS）", () => {
  it("ddd444 08-14 / 08-07 两次在 list_recent_runs 与 list_plan_runs 两个投影里逐字同值", () => {
    for (const key of ["plan-ddd444#2026-08-14T05:00:00Z", "plan-ddd444#2026-08-07T05:00:00Z"]) {
      const feed = AGENT_RUNS.find((r) => r.run_key === key) as Record<string, unknown> | undefined;
      const plan = DDD_PLAN_RUNS.find((r) => r.run_key === key) as Record<string, unknown> | undefined;
      expect(feed, `${key} 应在 AGENT_RUNS`).toBeTruthy();
      expect(plan, `${key} 应在 DDD_PLAN_RUNS`).toBeTruthy();
      for (const k of ["status", "score", "started_at", "duration_s", "agent_version_label", "stage_summaries"]) {
        expect(feed![k], `${key}.${k}`).toEqual(plan![k]);
      }
    }
  });

  it("现有桩足以出现两种判读：refusal 尺子偏严？（support-bot 连续 3 次）、correctness 1 个 Agent 未过线", () => {
    const t = deriveEvaluatorUsage(AGENT_RUNS as UsageRun[], ["correctness", "refusal", "coherence"]);
    const refusal = row(t, "refusal");
    expect(refusal.verdict).toEqual({ kind: "strict" });
    expect(refusal.agents).toEqual([
      { agent: "support-bot", latest: 0.55, latestRunKey: "plan-ddd444#2026-08-21T05:00:00Z", streak: 3 },
    ]);
    const correctness = row(t, "correctness");
    expect(correctness.verdict).toEqual({ kind: "partial", n: 1 });
    expect(correctness.agents.map((a) => [a.agent, a.latest, a.streak])).toEqual([
      ["research-agent", 0.62, 1],
      ["support-bot", 0.94, 0],
    ]);
    // 从没出过分的内置评估器：0 台
    expect(row(t, "coherence").agents).toEqual([]);
    // 排序：strict 在 partial 前
    expect(t.rows.slice(0, 2).map((r) => r.name)).toEqual(["refusal", "correctness"]);
  });
});

// ---------- 渲染 ----------

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

const EVALUATORS_EVENT = {
  event: "evaluators",
  // coherence / conciseness 从没出过分 ⇒ 折叠行「其余 2 个评估器…」
  available: ["coherence", "conciseness", "refusal"],
  dataset_only: ["correctness"],
  multimodal: [],
  scopes: {
    coherence: ["observe", "dataset"], conciseness: ["observe", "dataset"],
    refusal: ["observe", "dataset"], correctness: ["dataset"],
  },
  descriptions: {},
  custom: [],
  default: ["refusal"],
};

let recentRuns: unknown[] = AGENT_RUNS;

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as { action: string; limit?: number };
    const events = payload.action === "evaluators"
      ? [EVALUATORS_EVENT]
      : payload.action === "list_recent_runs"
        ? [{ event: "recent_runs", runs: recentRuns }]
        : [{ event: "error", error: `未打桩 action '${payload.action}'` }];
    return new Response(sseFrames(events), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }));
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}><EvaluatorsPage /></QueryClientProvider>);
}

beforeEach(() => {
  recentRuns = AGENT_RUNS;
  resetConfigForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("跨 Agent 表现面板", () => {
  it("两种判读各出现一行；strict 行排第一；chip 深链 optimize；未过线 chip 带 warn 与「连续 3 次」尾注", async () => {
    renderPage();
    // 锚点 = 目标数据专属文本（refusal 行的判读），不是「加载完成」类门槛
    await waitFor(() => expect(screen.getByTestId("evaluator-usage-row-refusal-verdict")).toHaveTextContent("尺子偏严？"));
    expect(screen.getByTestId("evaluator-usage-row-correctness-verdict")).toHaveTextContent("1 个 Agent 未过线");
    expect(screen.getByTestId("evaluator-usage-row-correctness-agents")).toHaveTextContent("2");
    // 在用 Agent = 0 的评估器默认折叠，不逐行列
    expect(screen.queryByTestId("evaluator-usage-row-coherence")).toBeNull();

    const rows = [...screen.getByTestId("evaluator-usage-table").querySelectorAll("tbody tr")]
      .map((tr) => tr.getAttribute("data-testid"));
    expect(rows.slice(0, 2)).toEqual(["evaluator-usage-row-refusal", "evaluator-usage-row-correctness"]);

    const chip = screen.getByTestId("evaluator-usage-chip-refusal-support-bot");
    expect(chip.getAttribute("href")).toBe("#/agent/support-bot/optimize");
    expect(chip.className).toContain("warn");
    expect(chip).toHaveTextContent("support-bot");
    expect(chip).toHaveTextContent("0.55");
    expect(screen.getByTestId("evaluator-usage-streak-refusal-support-bot")).toHaveTextContent("连续 3 次");

    const ok = screen.getByTestId("evaluator-usage-chip-correctness-support-bot");
    expect(ok.className).not.toContain("warn");
    expect(ok).toHaveTextContent("0.94");
    const low = screen.getByTestId("evaluator-usage-chip-correctness-research-agent");
    expect(low.getAttribute("href")).toBe("#/agent/research-agent/optimize");
    expect(low.className).toContain("warn");
    // 只 1 次未过线：没有尾注
    expect(screen.queryByTestId("evaluator-usage-streak-correctness-research-agent")).toBeNull();

    // 样本口径：N = 拿到的 run 数（含非 completed）
    expect(screen.getByTestId("evaluator-usage-sample")).toHaveTextContent(`近 ${AGENT_RUNS.length} 次 run · 只算 completed`);
    // 「均分」不裸出现在面板里
    expect(screen.getByTestId("evaluator-usage").textContent).not.toContain("均分");
  });

  it("在用 Agent = 0 的评估器折成表尾一行：文案含 N（几个评估器）与 M（近几次 run）", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("evaluator-usage-collapsed")).toBeInTheDocument());
    expect(screen.getByTestId("evaluator-usage-collapsed"))
      .toHaveTextContent(`其余 2 个评估器近 ${AGENT_RUNS.length} 次 run 没出过分`);
    expect(screen.getByTestId("evaluator-usage-toggle")).toHaveTextContent("展开");
    // 折叠行在有出分的行之后、是 tbody 最后一行
    const rows = [...screen.getByTestId("evaluator-usage-table").querySelectorAll("tbody tr")]
      .map((tr) => tr.getAttribute("data-testid"));
    expect(rows).toEqual(["evaluator-usage-row-refusal", "evaluator-usage-row-correctness", "evaluator-usage-collapsed"]);
  });

  it("点「展开」后没出过分的评估器逐行出现（Agent 0、其余 —），再点「收起」折回", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("evaluator-usage-toggle")).toBeInTheDocument());
    expect(screen.queryByTestId("evaluator-usage-row-coherence")).toBeNull();
    fireEvent.click(screen.getByTestId("evaluator-usage-toggle"));
    expect(screen.getByTestId("evaluator-usage-toggle")).toHaveTextContent("收起");
    expect(screen.getByTestId("evaluator-usage-row-coherence-agents")).toHaveTextContent("0");
    expect(screen.getByTestId("evaluator-usage-row-coherence-verdict")).toHaveTextContent("—");
    expect(screen.getByTestId("evaluator-usage-row-conciseness")).toBeInTheDocument();
    // 折叠行仍在，展开的行跟在它后面；有出分的行仍在上
    const rows = [...screen.getByTestId("evaluator-usage-table").querySelectorAll("tbody tr")]
      .map((tr) => tr.getAttribute("data-testid"));
    expect(rows).toEqual([
      "evaluator-usage-row-refusal", "evaluator-usage-row-correctness", "evaluator-usage-collapsed",
      "evaluator-usage-row-coherence", "evaluator-usage-row-conciseness",
    ]);
    fireEvent.click(screen.getByTestId("evaluator-usage-toggle"));
    expect(screen.queryByTestId("evaluator-usage-row-coherence")).toBeNull();
  });

  it("有 run 但一个评估器都没出过分（全为 0）：仍是空态一句话带动作，不画表", async () => {
    // 只有 running / error / 无逐评估器分的 run
    recentRuns = AGENT_RUNS.filter((r) => r.status !== "completed");
    renderPage();
    await waitFor(() => expect(screen.getByTestId("evaluator-usage-empty")).toBeInTheDocument());
    expect(screen.getByTestId("evaluator-usage-empty-action").getAttribute("href")).toBe("#/workbench");
    expect(screen.queryByTestId("evaluator-usage-table")).toBeNull();
    expect(screen.queryByTestId("evaluator-usage-collapsed")).toBeNull();
  });

  it("一条 run 都没有：空态一句话 + 「先跑一次评估计划」深链 #/workbench；不画表", async () => {
    recentRuns = [];
    renderPage();
    await waitFor(() => expect(screen.getByTestId("evaluator-usage-empty")).toBeInTheDocument());
    const act = screen.getByTestId("evaluator-usage-empty-action");
    expect(act).toHaveTextContent("先跑一次评估计划");
    expect(act.getAttribute("href")).toBe("#/workbench");
    expect(screen.queryByTestId("evaluator-usage-table")).toBeNull();
  });

  it("阈值带内的分向下取整：0.698 印 0.69，与同一枚 chip 的 warn 态/「低于 0.70」读得通", async () => {
    // 本页此前私写 `export const fmtScore = (v) => v.toFixed(2)`（**同名遮蔽** lib/scoring
    // 那份，还少了 null 分支），于是这一格印 "0.70" 而 chip 自己 warn 着色、title 说
    // 「低于 0.70」。0.698 是带内真值（字面量 0.695 的 double 在带外，toFixed 本来就给 0.69）。
    recentRuns = [datasetRun("edge-agent", "2026-08-30T00:00:00Z", { refusal: 0.698 })];
    renderPage();
    const chip = await waitFor(() => screen.getByTestId("evaluator-usage-chip-refusal-edge-agent"));
    expect(chip).toHaveTextContent("0.69");
    expect(chip.textContent).not.toContain("0.70");
    expect(chip.className).toContain("warn");
    expect(chip.getAttribute("title")).toContain(`低于 ${SCORE_TARGET.toFixed(2)}`);
  });

  it("run 流拉不到：面板报错，评估器列表照常", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("config.json")) return Response.json(CFG);
      const payload = JSON.parse(String(init?.body)) as { action: string };
      const events = payload.action === "evaluators"
        ? [EVALUATORS_EVENT]
        : [{ event: "error", error: "DDB 读超时" }];
      return new Response(sseFrames(events), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("evaluator-usage-error")).toHaveTextContent("DDB 读超时"));
    expect(screen.getByTestId("evaluator-row-refusal")).toBeInTheDocument();
  });
});
