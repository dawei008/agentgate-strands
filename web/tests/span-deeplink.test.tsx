// span 级深链（用户 2026-09-07：报告页台账「查看 trace」能到会话，但问题里点名的 span 还要人在树里找）：
//   · 路由：#/run/<key>?session=<sid>&span=<span_id> ⇒ Route.span；坏值 / 空值降级同 ?session=
//   · run 页三态：span 在那条会话里 ⇒ 树展开 + 该 trace 行选中 + 右栏 SPAN 详情 + scrollIntoView 落在该行而不是会话行；
//     span 不在这条会话里 ⇒ 仍选会话 + 状态「链接指向的 span <前 8 位> 不在这条会话里」（只此态出现）；
//     不带 span ⇒ 与批 route-query 逐字相同（无 span 状态文案）
//   · 报告页：问题文本里有 span id ⇒ 「查看 trace」href 追加 &span=<第一个>、title 追加「· span <前 8 位>」；
//     台账 span chip 是 <a>，href = 同一条问题的会话底座 + &span=<id>；shift+点击复制（普通点击不复制）
// 锚点纪律：等的都是目标数据专属（那条 span 的 trace-row、带 span 的问题行），不拿「页面渲染了」当门槛。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHash } from "../src/router";
import RunDetailPage from "../src/pages/run/RunDetailPage";
import ReportPage from "../src/pages/report/ReportPage";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import {
  sseFrames, MOCK_PLAN_RUN, PLAN_RUNS, ANNOTATIONS, MOCK_PLAN_RUN_OBSERVE, OBSERVE_PLAN_RUNS, OBSERVE_RUN_KEY,
} from "../src/mocks/handlers";
import { shortSessionId } from "../src/pages/plan/reportRows";
import { spanIdsOf, withSpanParam } from "../src/pages/agents/detail/hub/IssueLedger";
import type { SynthesisIssue } from "../src/pages/plan/types";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: PLAN_RUNS }],
  get_plan_run: (p) => [{ event: "plan_run", ...MOCK_PLAN_RUN, run_key: p.run_key }],
  list_plans: () => [{ event: "plans", plans: [] }],
  list_datasets: () => [{ event: "datasets", datasets: [] }],
  list_annotations: (p) => [{ event: "annotations", run_key: p.run_key, items: ANNOTATIONS.filter((a) => a.run_key === p.run_key) }],
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
function qcNew() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

beforeEach(() => {
  overrides = {};
  resetConfigForTest();
  resetRunFlightForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.querySelectorAll("[data-testid=toast]").forEach((el) => el.remove());
});

// ==================== 1. 路由 ====================
const RUN_KEY_WITH_HASH = "plan-ddd666#20260904013117";
const SID = "dsh-trace-e5d8fb96-5a9f-4d42-8d12-a742b7bd3fa5";
const SPAN = "9d3331d19d18ccc5";

describe("路由：&span=", () => {
  it("?session=<sid>&span=<id> ⇒ session + span 都挂上；顺序无关", () => {
    const base = `#/run/${encodeURIComponent(RUN_KEY_WITH_HASH)}`;
    expect(parseHash(`${base}?session=${encodeURIComponent(SID)}&span=${SPAN}`))
      .toEqual({ view: "run", id: RUN_KEY_WITH_HASH, session: SID, span: SPAN });
    expect(parseHash(`${base}?span=${SPAN}&session=${encodeURIComponent(SID)}`))
      .toEqual({ view: "run", id: RUN_KEY_WITH_HASH, session: SID, span: SPAN });
  });
  it("只有 session / 都没有 ⇒ 与批 route-query 形态逐字相同（不多 span: undefined 键）；空值降级", () => {
    const base = `#/run/${encodeURIComponent(RUN_KEY_WITH_HASH)}`;
    expect(parseHash(`${base}?session=${encodeURIComponent(SID)}`)).toEqual({ view: "run", id: RUN_KEY_WITH_HASH, session: SID });
    expect(parseHash(base)).toEqual({ view: "run", id: RUN_KEY_WITH_HASH });
    expect(parseHash(`${base}?session=${encodeURIComponent(SID)}&span=`)).toEqual({ view: "run", id: RUN_KEY_WITH_HASH, session: SID });
    // 畸形编码不抛，原样字符串
    expect(parseHash(`${base}?session=${encodeURIComponent(SID)}&span=%ZZ`)).toEqual({ view: "run", id: RUN_KEY_WITH_HASH, session: SID, span: "%ZZ" });
  });
  it("withSpanParam：已有查询串用 &，没有用 ?", () => {
    expect(withSpanParam("#/run/k?session=s", SPAN)).toBe(`#/run/k?session=s&span=${SPAN}`);
    expect(withSpanParam("#/run/k", SPAN)).toBe(`#/run/k?span=${SPAN}`);
  });
});

// ==================== 2. run 页三态 ====================
const RUN_KEY = "plan-aaa111#2026-08-11T09:00:00Z";
/** 夹具首个 observe 会话（transcript = MOCK_TRANSCRIPT_EVENTS，span id sp-1…sp-9） */
const FIRST = MOCK_PLAN_RUN.report.stages[0].session_details![0];
const FIRST_SID = FIRST.session_id;
/** 一条 tool 行（sp-6 check_change_eligibility）：选中后右栏是 SPAN 详情 */
const TOOL_SPAN = "sp-6";

function renderRun(session?: string, span?: string) {
  return render(
    <QueryClientProvider client={qcNew()}>
      <RunDetailPage id={RUN_KEY} session={session} span={span} />
    </QueryClientProvider>,
  );
}

describe("运行详情 ?session=&span=", () => {
  it("命中：树展开、trace 行 on、右栏 SPAN 详情、scrollIntoView 落在该 trace 行（不是会话行）、无状态文案", async () => {
    const scrolled: Array<{ el: Element; arg: unknown }> = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) { scrolled.push({ el: this, arg }); };
    try {
      renderRun(FIRST_SID, TOOL_SPAN);
      const row = await screen.findByTestId(`trace-row-${TOOL_SPAN}`);
      expect(row.className).toContain(" on");
      expect(screen.getByText("SPAN", { selector: ".ct" })).toBeInTheDocument();
      expect(within(screen.getByTestId("detail-pane")).getByText("check_change_eligibility")).toBeInTheDocument();
      await waitFor(() => expect(scrolled.some((s) => s.el === row)).toBe(true));
      expect(scrolled.find((s) => s.el === row)!.arg).toEqual({ block: "center" });
      // 会话行没被滚（滚的是 span 行）；会话行仍展开，但选中态在 span 行不在会话行
      const sessRow = screen.getByTestId(`session-row-${FIRST_SID}`);
      expect(scrolled.some((s) => s.el === sessRow)).toBe(false);
      expect(sessRow.className).toContain(" open");
      expect(sessRow.className).not.toContain(" on");
      expect(screen.queryByTestId("span-deeplink-missing")).toBeNull();
      expect(screen.queryByTestId("session-deeplink-missing")).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("消息行（assistant sp-4）也能被 span 深链选中：右栏 AGENT 全文", async () => {
    renderRun(FIRST_SID, "sp-4");
    const row = await screen.findByTestId("trace-row-sp-4");
    expect(row.className).toContain(" on");
    expect(screen.getByText("AGENT", { selector: ".ct" })).toBeInTheDocument();
  });

  it("span 不在这条会话里：仍选会话 + 「链接指向的 span <前 8 位> 不在这条会话里」（title = 完整 id）", async () => {
    const ghost = "deadbeefcafe0123";
    renderRun(FIRST_SID, ghost);
    const note = await screen.findByTestId("span-deeplink-missing");
    expect(note).toHaveTextContent("链接指向的 span deadbeef 不在这条会话里");
    expect(note.getAttribute("title")).toBe(ghost);
    const sessRow = screen.getByTestId(`session-row-${FIRST_SID}`);
    expect(sessRow.className).toContain(" on");
    expect(screen.getByTestId(`trace-tree-${FIRST_SID}`)).toBeInTheDocument();
    expect(screen.getByText("会话", { selector: ".ct" })).toBeInTheDocument();
    // 会话都找不到时不出 span 那句（会话那句由 route-query 钉）
  });

  it("会话不在本次 run：只出会话那句，不出 span 那句", async () => {
    renderRun("dsh-trace-00000000-dead-beef-0000-000000000000", TOOL_SPAN);
    await screen.findByTestId("session-deeplink-missing");
    expect(screen.queryByTestId("span-deeplink-missing")).toBeNull();
  });

  it("只带 session 不带 span：无 span 状态文案，会话行选中（与批 route-query 相同）", async () => {
    renderRun(FIRST_SID);
    await screen.findByTestId(`trace-tree-${FIRST_SID}`);
    expect(screen.getByTestId(`session-row-${FIRST_SID}`).className).toContain(" on");
    expect(screen.queryByTestId("span-deeplink-missing")).toBeNull();
  });
});

// ==================== 3. 报告页：href 带 span + chip 跳转 ====================
const ISSUES = MOCK_PLAN_RUN_OBSERVE.synthesis_issues as unknown as SynthesisIssue[];
/** 夹具里问题文本本来就带 `span <16 hex>` 的那一条（有会话证据） */
const WITH_SPAN = ISSUES.find((it) => /span [0-9a-f]{16}/.test(it.problem) && it.evidence.some((e) => e.kind === "session"))!;
const SPAN_ID = spanIdsOf(WITH_SPAN.problem)[0];
const WITH_SPAN_SID = WITH_SPAN.evidence.find((e) => e.kind === "session")!.ref;
const RUN_BASE = `#/run/${encodeURIComponent(OBSERVE_RUN_KEY)}`;
const SID_A = "dsh-trace-aaaa1111-0000-4000-8000-000000000001";
/** 两个 span id 的问题：href 只挂第一个，两枚 chip 各挂自己的 */
const TWO_SPANS: SynthesisIssue = {
  ...ISSUES[0], id: "2span001", recommendation: "建议 T", recommendation_source: null,
  problem: "span 0bba0638263aff91 之后又在 span e9a246b455fd2149 重复调用",
  evidence: [{ kind: "session", ref: SID_A }],
};
/** 只有用例证据但文本里有 span id：没有会话就无处定位 ⇒ href 不挂 span、chip 退回复制 */
const NO_SESSION_SPAN: SynthesisIssue = {
  ...ISSUES[0], id: "n05e55p1", recommendation: "建议 N", recommendation_source: null,
  problem: "用例里 span f6c58b41bb68d89e 超时", evidence: [{ kind: "case", ref: "case-3" }],
};

function renderReport(extra: SynthesisIssue[] = []) {
  location.hash = `#/report/${encodeURIComponent(OBSERVE_RUN_KEY)}`;
  overrides.list_plan_runs = (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: OBSERVE_PLAN_RUNS }];
  overrides.get_plan_run = (p) => [{
    event: "plan_run", ...MOCK_PLAN_RUN_OBSERVE, run_key: p.run_key,
    synthesis_issues: [...ISSUES, ...extra],
  }];
  return render(<QueryClientProvider client={qcNew()}><ReportPage id={OBSERVE_RUN_KEY} /></QueryClientProvider>);
}

describe("报告页「查看 trace」与 span chip", () => {
  it("问题文本有 span id ⇒ 「查看 trace」href = ?session=<sid>&span=<第一个 id>，title 追加「· span <前 8 位>」", async () => {
    renderReport();
    const link = await screen.findByTestId(`agent-issue-${WITH_SPAN.id}-trace`);
    expect(link).toHaveAttribute("href", `${RUN_BASE}?session=${encodeURIComponent(WITH_SPAN_SID)}&span=${SPAN_ID}`);
    expect(link.getAttribute("title")).toBe(
      `运行详情 · 会话 ${shortSessionId(WITH_SPAN_SID)} · 在 trace 里按 span id 定位 · span ${SPAN_ID.slice(0, 8)}`
      + (WITH_SPAN.evidence.filter((e) => e.kind === "session").length > 1
        ? ` · 另 ${WITH_SPAN.evidence.filter((e) => e.kind === "session").length - 1} 条见左栏` : ""));
    // 解析回来就是 run 路由 + session + span
    expect(parseHash(link.getAttribute("href")!)).toEqual({ view: "run", id: OBSERVE_RUN_KEY, session: WITH_SPAN_SID, span: SPAN_ID });
  });

  it("两个 span id：href 只挂第一个；两枚 chip 各自 href 带自己的 id；没有会话证据 ⇒ href 不挂 span、chip 是复制按钮", async () => {
    renderReport([TWO_SPANS, NO_SESSION_SPAN]);
    const link = await screen.findByTestId("agent-issue-2span001-trace");
    expect(link).toHaveAttribute("href", `${RUN_BASE}?session=${encodeURIComponent(SID_A)}&span=0bba0638263aff91`);
    const row = screen.getByTestId("agent-issue-2span001");
    const c1 = within(row).getByTestId("agent-issue-2span001-span-0bba0638263aff91");
    const c2 = within(row).getByTestId("agent-issue-2span001-span-e9a246b455fd2149");
    expect(c1.tagName).toBe("A");
    expect(c1).toHaveAttribute("href", `${RUN_BASE}?session=${encodeURIComponent(SID_A)}&span=0bba0638263aff91`);
    expect(c2).toHaveAttribute("href", `${RUN_BASE}?session=${encodeURIComponent(SID_A)}&span=e9a246b455fd2149`);
    expect(c1.getAttribute("title")).toBe("在 trace 里定位到这个 span · shift+点击复制");

    const noSess = screen.getByTestId("agent-issue-n05e55p1-trace");
    expect(noSess).toHaveAttribute("href", RUN_BASE);
    expect(noSess.getAttribute("title")).not.toContain("span f6c58b41");
    const chip = within(screen.getByTestId("agent-issue-n05e55p1")).getByTestId("agent-issue-n05e55p1-span-f6c58b41bb68d89e");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.getAttribute("title")).toBe("在 trace 里按 span id 定位 · 点击复制");
  });

  it("chip：普通点击不复制（走链接跳转，事件不被拦）；shift+点击 ⇒ preventDefault + clipboard + toast", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderReport();
    const chip = await screen.findByTestId(`agent-issue-${WITH_SPAN.id}-span-${SPAN_ID}`);
    expect(chip.tagName).toBe("A");
    expect(chip).toHaveAttribute("href", `${RUN_BASE}?session=${encodeURIComponent(WITH_SPAN_SID)}&span=${SPAN_ID}`);
    // 普通点击：不 preventDefault（fireEvent 返回 true）、不写剪贴板
    expect(fireEvent.click(chip)).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    // shift+点击：拦住导航、复制
    expect(fireEvent.click(chip, { shiftKey: true })).toBe(false);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SPAN_ID));
    expect(await screen.findByTestId("toast")).toHaveTextContent("已复制 span id");
  });
});
