// 只用上报数据评估（ADR-0019 批 1）的前端面：
//   · 评估计划编辑器的开关「只用上报数据评估」往返（2026-09-08 起默认开）：新建 / 缺键回填为勾选、
//     显式 false 回填为未选；请求体两态都显式带键（后端 plan.trace_required() 缺键 = 开，关必须显式）；
//   · 报告页三态：没开开关的 run 零痕迹（既有夹具 MOCK_PLAN_RUN 不带 badge、不带 data-trace）；
//     降级 run（MOCK_PLAN_RUN_TRACE：两环节各缺 1 例）头部 badge「2 例无 trace」、no_trace 行的格
//     显示「无 trace」而不是分、格 title 写原因键名原话、评估器 tile 均分把 no_trace 行剔掉；
//     全缺 run（夹具就地改成每行 no_trace）badge 走 bad 档。
// 期望值一律从夹具现算；锚点挑目标数据专属文本（no_trace 行的 badge），不拿页面壳当门槛。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReportPage from "../src/pages/report/ReportPage";
import PlanEditor from "../src/pages/plan/PlanEditor";
import { TRACE_REASON_TEXT, traceMarkOf, traceTitle } from "../src/pages/report/model";
import {
  sseFrames, MOCK_PLAN_RUN, MOCK_PLAN_RUN_TRACE, PLAN_RUNS, TRACE_RUN_KEY,
} from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};
let calls: Payload[] = [];

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}

const PLAN: import("../src/pages/plan/types").Plan = {
  plan_id: "plan-aaa111",
  name: "FAQ 周回归",
  agent_name: "support-bot",
  updated_at: 1755500000,
  stages: [{ type: "dataset", dataset: "faq-v3", evaluators: ["correctness"] }],
  schedule: null,
  trace_required: true,
};

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [PLAN] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: PLAN_RUNS }],
  get_plan_run: (p) => [{
    event: "plan_run",
    ...(String(p.run_key) === TRACE_RUN_KEY ? MOCK_PLAN_RUN_TRACE : MOCK_PLAN_RUN),
    run_key: p.run_key,
  }],
  list_datasets: () => [{
    event: "datasets",
    datasets: [{ name: "faq-v3", kind: "regression", target_agent: "", case_count: 2 }],
  }],
  list_annotations: (p) => [{ event: "annotations", run_key: p.run_key, items: [] }],
  // 形态照 plan.test.tsx 的 EVALUATORS_EVENT（后端 evaluators 事件：available / dataset_only /
  // multimodal / scopes / custom / metrics / default / default_metrics）
  evaluators: () => [{
    event: "evaluators",
    available: ["helpfulness"],
    dataset_only: ["correctness"],
    multimodal: [],
    scopes: { correctness: ["dataset"], helpfulness: ["observe", "dataset"] },
    custom: [], metrics: ["tokens"], default: [], default_metrics: ["tokens"],
  }],
  discover: () => [{
    event: "agents", region: "us-west-2", from_cache: true,
    agents: [{ agent_name: "support-bot", runtime_arn: "arn:a" }],
  }],
  save_plan: (p) => {
    const plan = p.plan as Record<string, unknown>;
    return [{
      event: "plan_saved",
      plan: { ...plan, plan_id: (plan.plan_id as string) || "plan-new123" },
      scheduled: false, schedule_error: null,
    }];
  },
};

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    calls.push(payload);
    const handler = overrides[payload.action] ?? DEFAULTS[payload.action];
    if (!handler) return sseResponse([{ event: "error", error: `未打桩 action '${payload.action}'` }]);
    return sseResponse(handler(payload));
  }));
}

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function renderReport(runKey: string) {
  return render(
    <QueryClientProvider client={newQc()}>
      <ReportPage id={runKey} />
    </QueryClientProvider>,
  );
}

function renderEditor(plan?: typeof PLAN) {
  return render(
    <QueryClientProvider client={newQc()}>
      <PlanEditor plan={plan} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  overrides = {};
  calls = [];
  resetConfigForTest();
  resetRunFlightForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
  location.hash = `#/report/${encodeURIComponent(TRACE_RUN_KEY)}`;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- 夹具现算 ----
type TraceRaw = { status: string; reason: string | null; spans: number; sources: string[] };
type DsRow = { case: string; trace: TraceRaw; results: { correctness: { score: number; passed: boolean } } };
type RtRow = { case_name: string; breached: boolean; trace: TraceRaw };
const DS = MOCK_PLAN_RUN_TRACE.report.stages[0];
const DS_ROWS = DS.report.results as unknown as DsRow[];
const RT = MOCK_PLAN_RUN_TRACE.report.stages[1];
const RT_ROWS = RT.report.results as unknown as RtRow[];
const DS_NO_TRACE = DS_ROWS.map((r, i) => ({ r, i })).filter(({ r }) => r.trace.status === "no_trace");
const DS_OK = DS_ROWS.filter((r) => r.trace.status === "ok");
const RT_NO_TRACE = RT_ROWS.map((r, i) => ({ r, i })).filter(({ r }) => r.trace.status === "no_trace");
const TOTAL_NO_TRACE = MOCK_PLAN_RUN_TRACE.stage_summaries
  .reduce((n, s) => n + (s.trace_summary?.no_trace ?? 0), 0);
const f3 = (n: number) => n.toFixed(3);
/** 剔掉 no_trace 行后的 correctness 均分（与含它时不同，才证明剔了） */
const OK_MEAN = DS_OK.reduce((a, r) => a + r.results.correctness.score, 0) / DS_OK.length;
const ALL_MEAN = DS_ROWS.reduce((a, r) => a + r.results.correctness.score, 0) / DS_ROWS.length;

describe("评估计划编辑器：开关「只用上报数据评估」往返", () => {
  it("回填：trace_required=true 的方案勾选态为选中；title 一句写在 label 上", async () => {
    renderEditor(PLAN);
    const box = await screen.findByTestId("plan-form-trace-required");
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("plan-form-trace-required-label"))
      .toHaveAttribute("title", "打开后，CloudWatch 里没有 Agent 上报 trace 的用例不评分");
    expect(screen.getByTestId("plan-form-trace-required-label")).toHaveTextContent("只用上报数据评估");
  });

  it("取消勾选后保存：请求体**显式带** trace_required: false（缺键会被后端读成开，关必须显式）", async () => {
    renderEditor(PLAN);
    const box = await screen.findByTestId("plan-form-trace-required");
    fireEvent.click(box);
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const body = calls.find((c) => c.action === "save_plan")!.plan as Record<string, unknown>;
    expect(body.trace_required).toBe(false);
    expect(body.plan_id).toBe("plan-aaa111");
  });

  it("2026-09-08 默认开：缺键（新建 / 旧方案）回填为勾选；直接保存请求体带 trace_required: true", async () => {
    renderEditor({ ...PLAN, trace_required: undefined });
    const box = await screen.findByTestId("plan-form-trace-required");
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("plan-form-save"));
    await waitFor(() => expect(calls.some((c) => c.action === "save_plan")).toBe(true));
    const body = calls.find((c) => c.action === "save_plan")!.plan as Record<string, unknown>;
    expect(body.trace_required).toBe(true);
  });

  it("显式 false 的方案回填为未选中（只有显式 false 才关）", async () => {
    renderEditor({ ...PLAN, trace_required: false });
    const box = await screen.findByTestId("plan-form-trace-required");
    expect((box as HTMLInputElement).checked).toBe(false);
  });
});

describe("报告页：run 头部降级 badge 与矩阵行态三态", () => {
  it("态一：没开开关的 run（既有夹具）零痕迹——无 badge、无 data-trace、格照常出分", async () => {
    renderReport(MOCK_PLAN_RUN.run_key);
    await screen.findByTestId("report-cell-1-0-correctness");
    expect(screen.queryByTestId("report-head-trace")).toBeNull();
    expect(document.querySelectorAll("[data-trace]").length).toBe(0);
    expect(screen.getByTestId("page-report").textContent).not.toContain("无 trace");
  });

  it("态二：降级 run——badge「N 例无 trace」（N 从两环节 trace_summary 现算）+ title 说清不评分不入分母", async () => {
    renderReport(TRACE_RUN_KEY);
    const badge = await screen.findByTestId("report-head-trace");
    expect(badge).toHaveTextContent(`${TOTAL_NO_TRACE} 例无 trace`);
    expect(badge.classList.contains("warn")).toBe(true);
    expect(badge.classList.contains("bad")).toBe(false);
    expect(badge.getAttribute("title")).toContain("不评分、不入通过率分母");
    expect(badge.getAttribute("title")).toContain(`${TOTAL_NO_TRACE} 例`);
  });

  it("态二：回归 no_trace 行的评估器格显示「无 trace」而不是分；title 写原因键名原话；ok 行照常出分", async () => {
    renderReport(TRACE_RUN_KEY);
    const { r, i } = DS_NO_TRACE[0];
    const cell = await screen.findByTestId(`report-cell-0-${i}-correctness`);
    expect(cell).toHaveTextContent("无 trace");
    expect(cell.textContent).not.toContain(f3(r.results.correctness.score));
    expect(cell.getAttribute("data-trace")).toBe(r.trace.reason);
    const title = cell.getAttribute("title") ?? "";
    expect(title).toContain(r.trace.reason);
    expect(title).toContain(TRACE_REASON_TEXT[r.trace.reason as keyof typeof TRACE_REASON_TEXT]);
    expect(title).toContain(`${r.trace.spans} 条`);
    // 行本身：data-trace + 行尾 badge + 行态归 none
    const row = screen.getByTestId(`report-row-0-${i}`);
    expect(row.getAttribute("data-trace")).toBe("no_trace");
    expect(row.className).toContain("is-none");
    expect(within(row).getByTestId(`report-row-0-${i}-trace`)).toHaveTextContent("无 trace");
    // ok 行照常：分数在格里、无 data-trace 标记
    const okIndex = DS_ROWS.findIndex((x) => x.trace.status === "ok");
    const okCell = screen.getByTestId(`report-cell-0-${okIndex}-correctness`);
    expect(okCell).toHaveTextContent(f3(DS_ROWS[okIndex].results.correctness.score));
    expect(okCell.getAttribute("data-trace")).toBeNull();
  });

  it("态二：评估器 tile 的该评估器均分剔掉 no_trace 行（与含它时不同数）", async () => {
    renderReport(TRACE_RUN_KEY);
    const mean = await screen.findByTestId("report-tile-0-correctness-mean");
    expect(OK_MEAN).not.toBeCloseTo(ALL_MEAN, 3);
    expect(mean).toHaveTextContent(f3(OK_MEAN));
    expect(mean.textContent).not.toContain(f3(ALL_MEAN));
    expect(screen.getByTestId("report-tile-0-correctness-pass"))
      .toHaveTextContent(`${DS_OK.filter((r) => r.results.correctness.passed).length}/${DS_OK.length}`);
  });

  it("态二：红队 no_trace 攻击的结果格显示「无 trace」，不是攻破 / 守住；hero 没跑成计数含它", async () => {
    renderReport(TRACE_RUN_KEY);
    const { r, i } = RT_NO_TRACE[0];
    const cell = await screen.findByTestId(`report-cell-1-${i}-result`);
    expect(cell).toHaveTextContent("无 trace");
    expect(cell.textContent).not.toContain("攻破");
    expect(cell.getAttribute("title")).toContain(r.trace.reason);
    expect(screen.getByTestId("report-row-1-" + i).getAttribute("data-trace")).toBe("no_trace");
    // hero 第二格副行：没跑成 = 两环节 no_trace 行数之和（夹具里没有别的 none 行）
    expect(screen.getByTestId("report-hero-rows-sub")).toHaveTextContent(`${TOTAL_NO_TRACE} 没跑成`);
  });

  it("态三：全缺 run——每行 no_trace、trace_summary ok=0 ⇒ badge 走 bad 档，title 说本次未评分", async () => {
    const all = structuredClone(MOCK_PLAN_RUN_TRACE) as typeof MOCK_PLAN_RUN_TRACE;
    for (const st of all.report.stages) {
      for (const row of st.report.results as { trace: { status: string; reason: string | null; spans: number; sources: string[] } }[]) {
        row.trace = { status: "no_trace", reason: "no_span", spans: 0, sources: ["aws/spans"] };
      }
      const n = st.report.results.length;
      st.trace_summary = { required: true, ok: 0, no_trace: n };
      st.trace_status = "no_trace";
      st.status = "no_trace";
    }
    all.stage_summaries.forEach((s, k) => {
      const n = all.report.stages[k].report.results.length;
      s.trace_summary = { required: true, ok: 0, no_trace: n };
      s.trace_status = "no_trace";
      s.status = "no_trace";
    });
    const total = all.stage_summaries.reduce((n, s) => n + s.trace_summary.no_trace, 0);
    overrides.get_plan_run = (p) => [{ event: "plan_run", ...all, run_key: p.run_key }];
    renderReport(TRACE_RUN_KEY);
    const badge = await screen.findByTestId("report-head-trace");
    expect(badge).toHaveTextContent(`${total} 例无 trace`);
    expect(badge.classList.contains("bad")).toBe(true);
    expect(badge.getAttribute("title")).toContain("未评分");
    // 每一行都是 no_trace 行态
    expect(document.querySelectorAll('tr[data-trace="no_trace"]').length).toBe(total);
    expect(document.querySelectorAll('tr[data-trace="ok"]').length).toBe(0);
  });
});

describe("model：trace 标记的读法", () => {
  it("缺键 / 不认识的 status → null；四种原因各配一句；title 含键名原话与 span 数", () => {
    expect(traceMarkOf(undefined)).toBeNull();
    expect(traceMarkOf({ status: "weird" })).toBeNull();
    // 评分出身四键（批 2 的 scoredFrom / responseMatches / outputResponse + 批 3 红队行的
    // responseConversation）缺行原物 ⇒ null / null / "" / ""
    expect(traceMarkOf({ status: "ok", reason: null, spans: 3 }))
      .toEqual({ status: "ok", reason: null, spans: 3, sources: [], scoredFrom: null,
                 responseMatches: null, outputResponse: "", responseConversation: "" });
    // 后端五种原因键名（testrun.TRACE_REASON_*）一个不少，且 unsampled 不并进 no_span
    expect(Object.keys(TRACE_REASON_TEXT).sort())
      .toEqual(["fetch_error", "no_content", "no_span", "no_span_source", "unsampled"]);
    for (const reason of Object.keys(TRACE_REASON_TEXT) as (keyof typeof TRACE_REASON_TEXT)[]) {
      const m = traceMarkOf({ status: "no_trace", reason, spans: 1, sources: ["aws/spans", "/aws/bedrock-agentcore/runtimes/x-DEFAULT"] })!;
      expect(m.reason).toBe(reason);
      expect(traceTitle(m)).toContain(reason);
      expect(traceTitle(m)).toContain(TRACE_REASON_TEXT[reason]);
      expect(traceTitle(m)).toContain("查过 aws/spans 与 /aws/bedrock-agentcore/runtimes/x-DEFAULT");
    }
    // 后端将来多一种原因：不认识的键名不崩，reason 落 null，title 仍说得出「无 trace」
    const m = traceMarkOf({ status: "no_trace", reason: "future_reason", spans: 0 })!;
    expect(m.reason).toBeNull();
    expect(traceTitle(m)).toContain("无 trace");
  });
});
