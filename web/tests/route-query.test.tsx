// hash 内查询串两条深链（用户 2026-09-07「问题台账要直接定位到会话」+ 入集抽屉「为它建评估计划」不知道选哪个集）：
//   · #/run/<run_key>?session=<session_id>：运行详情预选并展开那条会话；找不到 ⇒ 照旧 + 一条状态文案
//   · #/plan/new?dataset=<name>：新建编辑器预填数据集环节（名单里有同名项才预填）
// 路由解析、run 页、报告页 href/title 三态、编辑器两态、抽屉链接分五组钉。
// 锚点纪律：waitFor/findBy 的锚点都是**目标数据专属**（深链那条会话的 trace-tree、预填的那个集合名），
// 不拿「页面已渲染」这类门槛数据当锚点。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHash } from "../src/router";
import RunDetailPage from "../src/pages/run/RunDetailPage";
import ReportPage from "../src/pages/report/ReportPage";
import PlanEditor from "../src/pages/plan/PlanEditor";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import {
  sseFrames, MOCK_PLAN_RUN, PLAN_RUNS, AGENTS,
  ANNOTATIONS, MOCK_PLAN_RUN_OBSERVE, OBSERVE_PLAN_RUNS, OBSERVE_RUN_KEY,
} from "../src/mocks/handlers";
import { shortSessionId } from "../src/pages/plan/reportRows";
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
});

// ==================== 1. 路由解析 ====================
const RUN_KEY_WITH_HASH = "plan-ddd666#20260904013117";
const SID = "dsh-trace-e5d8fb96-5a9f-4d42-8d12-a742b7bd3fa5";

describe("路由解析：hash 内查询串", () => {
  it("#/run/<%23 key>?session=<sid> ⇒ id 解码含 #、session 挂上（查询串在 hash 内，不走 location.search）", () => {
    const hash = `#/run/${encodeURIComponent(RUN_KEY_WITH_HASH)}?session=${encodeURIComponent(SID)}`;
    expect(hash).toContain("%23");
    expect(parseHash(hash)).toEqual({ view: "run", id: RUN_KEY_WITH_HASH, session: SID });
  });
  it("无查询串 ⇒ 与旧形态逐字相同（不多一个 session: undefined 键）", () => {
    expect(parseHash(`#/run/${encodeURIComponent(RUN_KEY_WITH_HASH)}`)).toEqual({ view: "run", id: RUN_KEY_WITH_HASH });
  });
  it("坏查询串降级：畸形百分号 ⇒ 原样字符串；空值 / 别的键 / 只有 ? ⇒ 当没带；都不抛", () => {
    const base = `#/run/${encodeURIComponent(RUN_KEY_WITH_HASH)}`;
    expect(parseHash(`${base}?session=%ZZ`)).toEqual({ view: "run", id: RUN_KEY_WITH_HASH, session: "%ZZ" });
    expect(parseHash(`${base}?session=`)).toEqual({ view: "run", id: RUN_KEY_WITH_HASH });
    expect(parseHash(`${base}?foo=bar`)).toEqual({ view: "run", id: RUN_KEY_WITH_HASH });
    expect(parseHash(`${base}?`)).toEqual({ view: "run", id: RUN_KEY_WITH_HASH });
    // 多键：session 不必在首位
    expect(parseHash(`${base}?x=1&session=${encodeURIComponent(SID)}`)).toEqual({ view: "run", id: RUN_KEY_WITH_HASH, session: SID });
    // 只有查询串没有 run_key ⇒ 认不出，落首页（不是一个 id 为空的 run 路由）
    expect(parseHash("#/run/?session=abc")).toEqual({ view: "agents" });
  });
  it("#/plan/new?dataset=<name> ⇒ plan-new + dataset；无 / 空 / 坏 ⇒ 纯 plan-new；#/plan/new/edit 之类不受影响", () => {
    expect(parseHash(`#/plan/new?dataset=${encodeURIComponent("support-bot-badcases")}`))
      .toEqual({ view: "plan-new", dataset: "support-bot-badcases" });
    expect(parseHash("#/plan/new")).toEqual({ view: "plan-new" });
    expect(parseHash("#/plan/new?dataset=")).toEqual({ view: "plan-new" });
    expect(parseHash("#/plan/new?dataset=%E4%B8%AD%")).toEqual({ view: "plan-new", dataset: "%E4%B8%AD%" });
    expect(parseHash("#/plan/new/edit")).toEqual({ view: "plan-edit", id: "new" });
    expect(parseHash("#/plan/newer")).toEqual({ view: "plan", id: "newer" });
  });
});

// ==================== 2. run 页：预选 + 展开 + 找不到态 ====================
const RUN_KEY = "plan-aaa111#2026-08-11T09:00:00Z";
/** 夹具首个 observe 会话（有 events ⇒ 展开后有 trace 树，是深链专属锚点） */
const FIRST_SID = MOCK_PLAN_RUN.report.stages[0].session_details![0].session_id;

function renderRun(session?: string) {
  return render(
    <QueryClientProvider client={qcNew()}>
      <RunDetailPage id={RUN_KEY} session={session} />
    </QueryClientProvider>,
  );
}

describe("运行详情 ?session=", () => {
  it("命中：不点任何东西，那条会话的 trace 树已展开、行选中、右栏是会话详情、首帧后 scrollIntoView({block:center})", async () => {
    const scrolled: Array<{ el: Element; arg: unknown }> = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) { scrolled.push({ el: this, arg }); };
    try {
      renderRun(FIRST_SID);
      // 锚点 = 深链那条会话专属的 trace 树（没深链时它要点一下才出现）
      const tree = await screen.findByTestId(`trace-tree-${FIRST_SID}`);
      expect(tree).toBeInTheDocument();
      const row = screen.getByTestId(`session-row-${FIRST_SID}`);
      expect(row.className).toContain(" on");
      expect(row.className).toContain(" open");
      expect(screen.getByText("会话", { selector: ".ct" })).toBeInTheDocument();
      await waitFor(() => expect(scrolled.some((s) => s.el === row)).toBe(true));
      expect(scrolled.find((s) => s.el === row)!.arg).toEqual({ block: "center" });
      // 找到了 ⇒ 没有「不在本次 run 里」的状态文案
      expect(screen.queryByTestId("session-deeplink-missing")).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("jsdom 无 scrollIntoView 时不抛（可选调用）", async () => {
    const orig = Element.prototype.scrollIntoView;
    // @ts-expect-error 模拟 jsdom 缺这个方法
    delete Element.prototype.scrollIntoView;
    try {
      renderRun(FIRST_SID);
      expect(await screen.findByTestId(`trace-tree-${FIRST_SID}`)).toBeInTheDocument();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("找不到：中栏顶部一条状态「链接指向的会话 <短 id> 不在本次 run 里」，其余与不带参数完全相同（无展开、无选中）", async () => {
    const ghost = "dsh-trace-00000000-dead-beef-0000-000000000000";
    renderRun(ghost);
    const note = await screen.findByTestId("session-deeplink-missing");
    expect(note).toHaveTextContent(`链接指向的会话 ${shortSessionId(ghost)} 不在本次 run 里`);
    expect(note.getAttribute("title")).toBe(ghost);
    // 夹具会话都在、都没被展开或选中
    const row = screen.getByTestId(`session-row-${FIRST_SID}`);
    expect(row.className).not.toContain(" on");
    expect(screen.queryByTestId(`trace-tree-${FIRST_SID}`)).toBeNull();
    expect(within(screen.getByTestId("detail-pane")).queryByText(FIRST_SID)).toBeNull();
  });

  it("不带参数：没有状态文案、没有预选（与深链前逐字相同）", async () => {
    renderRun();
    await screen.findByTestId(`session-row-${FIRST_SID}`);
    expect(screen.queryByTestId("session-deeplink-missing")).toBeNull();
    expect(screen.queryByTestId(`trace-tree-${FIRST_SID}`)).toBeNull();
  });
});

// ==================== 3. 报告页问题台账「查看 trace」href/title 三态 ====================
const ISSUES = MOCK_PLAN_RUN_OBSERVE.synthesis_issues as unknown as SynthesisIssue[];
const RUN_BASE = `#/run/${encodeURIComponent(OBSERVE_RUN_KEY)}`;
const SID_A = "dsh-trace-aaaa1111-0000-4000-8000-000000000001";
const SID_B = "dsh-trace-bbbb2222-0000-4000-8000-000000000002";
const SID_C = "dsh-trace-cccc3333-0000-4000-8000-000000000003";
/** 三态各一条：只一条会话 / 三条会话 / 没有会话证据（只有用例）——id 都是夹具里没有的 8 位 */
const ONE_SESSION: SynthesisIssue = { ...ISSUES[0], id: "0ne5e551", problem: "只有一条会话证据的问题", recommendation: "建议 A", recommendation_source: null, evidence: [{ kind: "session", ref: SID_A }] };
const MANY_SESSIONS: SynthesisIssue = { ...ISSUES[0], id: "3ee55511", problem: "三条会话证据的问题", recommendation: "建议 B", recommendation_source: null, evidence: [{ kind: "case", ref: "case-7" }, { kind: "session", ref: SID_B }, { kind: "session", ref: SID_C }, { kind: "session", ref: SID_A }] };
const NO_SESSION: SynthesisIssue = { ...ISSUES[0], id: "n05e5510", problem: "只有用例证据的问题", recommendation: "建议 C", recommendation_source: null, evidence: [{ kind: "case", ref: "case-3" }] };

function renderReport() {
  location.hash = `#/report/${encodeURIComponent(OBSERVE_RUN_KEY)}`;
  overrides.list_plan_runs = (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: OBSERVE_PLAN_RUNS }];
  overrides.get_plan_run = (p) => [{
    event: "plan_run", ...MOCK_PLAN_RUN_OBSERVE, run_key: p.run_key,
    synthesis_issues: [ONE_SESSION, MANY_SESSIONS, NO_SESSION],
  }];
  return render(<QueryClientProvider client={qcNew()}><ReportPage id={OBSERVE_RUN_KEY} /></QueryClientProvider>);
}

describe("报告页「查看 trace」三态", () => {
  it("一条会话 ⇒ href 带 ?session=<完整 id>；title = 「运行详情 · 会话 <短 id> · 在 trace 里按 span id 定位」，不含「另 N 条」", async () => {
    renderReport();
    const link = await screen.findByTestId(`agent-issue-${ONE_SESSION.id}-trace`);
    expect(link).toHaveAttribute("href", `${RUN_BASE}?session=${encodeURIComponent(SID_A)}`);
    expect(link.getAttribute("title")).toBe(`运行详情 · 会话 ${shortSessionId(SID_A)} · 在 trace 里按 span id 定位`);
    expect(link.getAttribute("title")).not.toContain("另");
    // href 反解回路由：id 含 #、session 是完整 id（不是短 id）
    expect(parseHash(link.getAttribute("href")!)).toEqual({ view: "run", id: OBSERVE_RUN_KEY, session: SID_A });
  });

  it("多条会话 ⇒ 取**第一条会话**证据（跳过前面的用例证据）；title 追加「另 2 条见左栏」", async () => {
    renderReport();
    const link = await screen.findByTestId(`agent-issue-${MANY_SESSIONS.id}-trace`);
    expect(link).toHaveAttribute("href", `${RUN_BASE}?session=${encodeURIComponent(SID_B)}`);
    expect(link.getAttribute("title")).toBe(`运行详情 · 会话 ${shortSessionId(SID_B)} · 在 trace 里按 span id 定位 · 另 2 条见左栏`);
  });

  it("没有会话证据 ⇒ 维持 run 级现状：href 无 ?session、title 写「run 级 trace」", async () => {
    renderReport();
    const link = await screen.findByTestId(`agent-issue-${NO_SESSION.id}-trace`);
    expect(link).toHaveAttribute("href", RUN_BASE);
    expect(link.getAttribute("title")).toContain("run 级 trace");
    expect(link.getAttribute("title")).toContain("在 trace 里按 span id 定位");
    expect(link.getAttribute("title")).not.toContain("会话 ");
  });
});

// ==================== 4. 计划编辑器 ?dataset= 预填两态 ====================
const EDITOR_DATASETS = [
  { name: "support-bot-badcases", kind: "regression", target_agent: "support-bot", case_count: 3 },
  { name: "faq-v3", kind: "regression", target_agent: "", case_count: 2 },
  { name: "billing-bot-badcases-rt", kind: "redteam", target_agent: "", case_count: 1 },
];
function renderEditor(presetDataset?: string) {
  overrides.discover = () => [{ event: "agents", agents: AGENTS }];
  overrides.evaluators = () => [{
    event: "evaluators", available: ["coherence"], dataset_only: ["correctness"], multimodal: [],
    scopes: { coherence: ["observe", "dataset"], correctness: ["dataset"] }, custom: [],
    metrics: ["tokens"], default: [], default_metrics: ["tokens"],
  }];
  overrides.list_datasets = () => [{ event: "datasets", datasets: EDITOR_DATASETS }];
  overrides.redteam_options = () => [{ event: "redteam_options", strategies: [], default_strategies: [] }];
  return render(<QueryClientProvider client={qcNew()}><PlanEditor presetDataset={presetDataset} /></QueryClientProvider>);
}

describe("计划编辑器 ?dataset=", () => {
  it("名单里有同名回归集 ⇒ 数据集环节预选它；计划名默认「<target_agent> · 坏例回归」；Agent 下拉同预选", async () => {
    renderEditor("support-bot-badcases");
    // 锚点 = 预填那个集合名成为环节卡下拉的当前值（不是「下拉出现了」）
    const dsSelect = await screen.findByTestId("plan-stage-card-0-dataset");
    await waitFor(() => expect((dsSelect as HTMLSelectElement).value).toBe("support-bot-badcases"));
    expect(screen.getByTestId("plan-form-stage-count")).toHaveTextContent("1");
    expect((screen.getByTestId("plan-form-name") as HTMLInputElement).value).toBe("support-bot · 坏例回归");
    await waitFor(() => expect((screen.getByTestId("plan-form-agent") as HTMLSelectElement).value).toBe("support-bot"));
    expect(screen.queryByTestId("stage-missing-dataset")).toBeNull();
    expect(screen.queryByTestId("plan-form-error")).toBeNull();
  });

  it("target_agent 为空但名字形如 <agent>-badcases-rt ⇒ 从名字推 agent；红队集落红队卡（cases 下拉）", async () => {
    renderEditor("billing-bot-badcases-rt");
    const casesSelect = await screen.findByTestId("plan-stage-card-0-cases");
    await waitFor(() => expect((casesSelect as HTMLSelectElement).value).toBe("billing-bot-badcases-rt"));
    expect((screen.getByTestId("plan-form-name") as HTMLInputElement).value).toBe("billing-bot · 坏例回归");
  });

  it("有同名集但推不出 agent（target_agent 空、名字不是默认集形）⇒ 只预选集合，计划名留空", async () => {
    renderEditor("faq-v3");
    const dsSelect = await screen.findByTestId("plan-stage-card-0-dataset");
    await waitFor(() => expect((dsSelect as HTMLSelectElement).value).toBe("faq-v3"));
    expect((screen.getByTestId("plan-form-name") as HTMLInputElement).value).toBe("");
  });

  it("没有同名项 ⇒ 不预填、不报错：0 环节、名字空，与直进 #/plan/new 相同", async () => {
    renderEditor("ghost-dataset-not-in-list");
    await screen.findByTestId("plan-form-name");
    // 等名单到位（此时若要预填早就预填了）：以「回归卡添加钮可用且仍 0 环节」判
    await waitFor(() => expect((screen.getByTestId("plan-form-agent") as HTMLSelectElement).options.length).toBeGreaterThan(1));
    expect(screen.getByTestId("plan-form-stage-count")).toHaveTextContent("0");
    expect(screen.getByTestId("plan-form-stages-empty")).toBeInTheDocument();
    expect((screen.getByTestId("plan-form-name") as HTMLInputElement).value).toBe("");
    expect(screen.queryByTestId("plan-form-error")).toBeNull();
    expect(screen.queryByTestId("stage-missing-dataset")).toBeNull();
  });

  it("不带参数 ⇒ 0 环节（对照）", async () => {
    renderEditor();
    await screen.findByTestId("plan-form-name");
    await waitFor(() => expect((screen.getByTestId("plan-form-agent") as HTMLSelectElement).options.length).toBeGreaterThan(1));
    expect(screen.getByTestId("plan-form-stage-count")).toHaveTextContent("0");
  });
});
