// 只用上报数据评估（ADR-0019 批 2）的前端面：按 trace 评分的行在报告页矩阵格上的两态 title。
//   · 行上 scored_from = "trace" 且 response_matches_trace = false ⇒ 格 title
//     「按 trace 评分 · 返回与 trace 不一致」，格详情多一段「返回（与 trace 不一致）」原返回对照；
//   · scored_from = "trace" 且一致 ⇒ 格 title 只有「按 trace 评分」，详情不重复原返回；
//   · 批 1 形态 / 老 run（行上没有 scored_from）⇒ 格没有 title、没有 data-scored，详情标签仍是「实际输出」。
// 夹具从 MOCK_PLAN_RUN_TRACE 就地改出（mocks 不归本批，不在 handlers 里加字段）；期望值从夹具现算。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReportPage from "../src/pages/report/ReportPage";
import { scoredTitle, scoringOf, traceMarkOf } from "../src/pages/report/model";
import { sseFrames, MOCK_PLAN_RUN, MOCK_PLAN_RUN_TRACE, PLAN_RUNS, TRACE_RUN_KEY } from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: PLAN_RUNS }],
  get_plan_run: (p) => [{
    event: "plan_run",
    ...(String(p.run_key) === TRACE_RUN_KEY ? MOCK_PLAN_RUN_TRACE : MOCK_PLAN_RUN),
    run_key: p.run_key,
  }],
  list_annotations: (p) => [{ event: "annotations", run_key: p.run_key, items: [] }],
};

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    const handler = overrides[payload.action] ?? DEFAULTS[payload.action];
    if (!handler) return sseResponse([{ event: "error", error: `未打桩 action '${payload.action}'` }]);
    return sseResponse(handler(payload));
  }));
}

function renderReport(runKey: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ReportPage id={runKey} /></QueryClientProvider>);
}

beforeEach(() => {
  overrides = {};
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

// ---- 夹具现算：把两条 ok 行改成批 2 形态（一条不一致、一条一致），no_trace 行不动 ----
type Row = { output: string; trace: { status: string }; scored_from?: string; output_response?: string;
  response_matches_trace?: boolean };
const RESPONSE_TEXT = "返回：三十天内可退。";

function scoredFixture() {
  const all = structuredClone(MOCK_PLAN_RUN_TRACE) as typeof MOCK_PLAN_RUN_TRACE;
  const rows = all.report.stages[0].report.results as unknown as Row[];
  const ok = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.trace.status === "ok");
  const [mismatch, match] = ok;
  mismatch.r.scored_from = "trace";
  mismatch.r.output_response = RESPONSE_TEXT;
  mismatch.r.response_matches_trace = false;
  match.r.scored_from = "trace";
  match.r.output_response = match.r.output;
  match.r.response_matches_trace = true;
  return { all, mismatch, match, noTrace: rows.map((r, i) => ({ r, i })).find(({ r }) => r.trace.status === "no_trace")! };
}

describe("报告页：按 trace 评分的格 title 两态", () => {
  it("返回与 trace 不一致：格 title「按 trace 评分 · 返回与 trace 不一致」+ data-scored；详情并排原返回", async () => {
    const { all, mismatch } = scoredFixture();
    overrides.get_plan_run = (p) => [{ event: "plan_run", ...all, run_key: p.run_key }];
    renderReport(TRACE_RUN_KEY);
    const cell = await screen.findByTestId(`report-cell-0-${mismatch.i}-correctness`);
    expect(cell.getAttribute("title")).toBe("按 trace 评分 · 返回与 trace 不一致");
    expect(cell.getAttribute("data-scored")).toBe("trace");
    expect(cell.textContent).not.toContain("按 trace 评分");
    fireEvent.click(cell);
    const detail = `report-cell-0-${mismatch.i}-correctness-detail`;
    expect(screen.getByTestId(`${detail}-output`)).toHaveTextContent(mismatch.r.output);
    expect(screen.getByTestId(`${detail}-output`).parentElement?.parentElement?.textContent).toContain("实际输出（trace）");
    expect(screen.getByTestId(`${detail}-output-response`)).toHaveTextContent(RESPONSE_TEXT);
  });

  it("返回与 trace 一致：格 title 只有「按 trace 评分」；详情不重复原返回", async () => {
    const { all, match } = scoredFixture();
    overrides.get_plan_run = (p) => [{ event: "plan_run", ...all, run_key: p.run_key }];
    renderReport(TRACE_RUN_KEY);
    const cell = await screen.findByTestId(`report-cell-0-${match.i}-correctness`);
    expect(cell.getAttribute("title")).toBe("按 trace 评分");
    expect(cell.getAttribute("data-scored")).toBe("trace");
    fireEvent.click(cell);
    const detail = `report-cell-0-${match.i}-correctness-detail`;
    expect(screen.getByTestId(`${detail}-output`)).toHaveTextContent(match.r.output);
    expect(screen.queryByTestId(`${detail}-output-response`)).toBeNull();
  });

  it("no_trace 行不受影响：仍是「无 trace」格，没有 data-scored", async () => {
    const { all, noTrace } = scoredFixture();
    overrides.get_plan_run = (p) => [{ event: "plan_run", ...all, run_key: p.run_key }];
    renderReport(TRACE_RUN_KEY);
    const cell = await screen.findByTestId(`report-cell-0-${noTrace.i}-correctness`);
    expect(cell).toHaveTextContent("无 trace");
    expect(cell.getAttribute("data-scored")).toBeNull();
  });

  it("批 1 形态（行上没有 scored_from）：格无 title、无 data-scored；详情标签仍是「实际输出」", async () => {
    renderReport(TRACE_RUN_KEY);
    const rows = MOCK_PLAN_RUN_TRACE.report.stages[0].report.results as unknown as Row[];
    const okIndex = rows.findIndex((r) => r.trace.status === "ok");
    const cell = await screen.findByTestId(`report-cell-0-${okIndex}-correctness`);
    expect(cell.getAttribute("title")).toBeNull();
    expect(cell.getAttribute("data-scored")).toBeNull();
    fireEvent.click(cell);
    const detail = `report-cell-0-${okIndex}-correctness-detail`;
    const label = screen.getByTestId(`${detail}-output`).parentElement?.parentElement?.textContent ?? "";
    expect(label).toContain("实际输出");
    expect(label).not.toContain("实际输出（trace）");
    expect(screen.queryByTestId(`${detail}-output-response`)).toBeNull();
    expect(document.querySelectorAll("[data-scored]").length).toBe(0);
  });
});

describe("model：评分出身的读法", () => {
  it("scoringOf：键缺 ⇒ null/null/''；scored_from 不认识 ⇒ 当作缺；一致标记只在有出身时读", () => {
    // responseConversation 是批 3 给红队行加的第四键（回归行恒空串，见 trace-scoring-redteam）
    const BLANK = { scoredFrom: null, responseMatches: null, outputResponse: "", responseConversation: "" };
    expect(scoringOf(undefined)).toEqual(BLANK);
    expect(scoringOf({ scored_from: "weird", response_matches_trace: false, output_response: "x" }))
      .toEqual(BLANK);
    expect(scoringOf({ scored_from: "trace", response_matches_trace: false, output_response: "x" }))
      .toEqual({ scoredFrom: "trace", responseMatches: false, outputResponse: "x", responseConversation: "" });
    expect(scoringOf({ scored_from: "trace" }))
      .toEqual({ scoredFrom: "trace", responseMatches: null, outputResponse: "", responseConversation: "" });
  });

  it("scoredTitle：只在按 trace 评分的标记上出现；不一致多一段；一致 / 未知一致性不说", () => {
    const base = { status: "ok", reason: null, spans: 3, sources: ["aws/spans"] };
    expect(scoredTitle(null)).toBe("");
    expect(scoredTitle(traceMarkOf(base, {}))).toBe("");
    expect(scoredTitle(traceMarkOf(base, { scored_from: "trace", response_matches_trace: false, output_response: "r" })))
      .toBe("按 trace 评分 · 返回与 trace 不一致");
    expect(scoredTitle(traceMarkOf(base, { scored_from: "trace", response_matches_trace: true, output_response: "r" })))
      .toBe("按 trace 评分");
    expect(scoredTitle(traceMarkOf(base, { scored_from: "trace" }))).toBe("按 trace 评分");
  });
});
