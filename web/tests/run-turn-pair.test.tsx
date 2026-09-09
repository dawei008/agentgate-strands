// 运行详情右栏「一问一答」（2026-09-07 现网反馈：点 #1 USER 只见原话，问「agent
// 返回为什么没有显示在后面」）。fetch 打桩与 run-detail.test.tsx 同式；数据用
// mocks/handlers 的 MOCK_PLAN_RUN，首个 observe 会话 sess-a41f9c2b 是两轮：
//   #1 USER → #2 #3 TOOL → #4 AGENT；#5 USER → #6 TOOL · #7 #8 TOOL(err) → #9 AGENT
// 锚点纪律：每条断言挑目标轮**专属**的字样（第二轮的「改签」不会出现在第一轮里）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import RunDetailPage from "../src/pages/run/RunDetailPage";
import { resetConfigForTest } from "../src/lib/config";
import { useSession } from "../src/stores/session";
import { sseFrames, MOCK_PLAN_RUN, PLAN_RUNS } from "../src/mocks/handlers";
import { expectProseGone } from "./prose";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
const RUN_KEY = "plan-aaa111#2026-08-11T09:00:00Z";
const SID = "sess-a41f9c2b";

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: PLAN_RUNS }],
  get_plan_run: (p) => [{ event: "plan_run", ...MOCK_PLAN_RUN, run_key: p.run_key }],
};

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    const handler = overrides[payload.action] ?? DEFAULTS[payload.action];
    if (!handler) return new Response(sseFrames([{ event: "error", error: `未打桩 action '${payload.action}'` }]), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    return new Response(sseFrames(handler(payload)), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }));
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><RunDetailPage id={RUN_KEY} /></QueryClientProvider>);
}

/** 展开首个 observe 会话（已展开就不再点——会话行是 toggle，再点会收起）并点某一行；返回右栏 */
async function openAndClick(spanKey: string) {
  const row = await screen.findByTestId(`session-row-${SID}`);
  if (!screen.queryByTestId(`trace-tree-${SID}`)) fireEvent.click(row);
  const tree = await screen.findByTestId(`trace-tree-${SID}`);
  fireEvent.click(within(tree).getByTestId(`trace-row-${spanKey}`));
  return screen.findByTestId("detail-msg");
}

/** 把首会话的 transcript 截到 #8：第二轮 USER 之后没有 assistant */
function withoutLastReply() {
  const run = structuredClone(MOCK_PLAN_RUN) as typeof MOCK_PLAN_RUN;
  const sess = run.report.stages[0].session_details![0];
  const transcript = sess.transcript!;
  const events = transcript.events as { n: number }[];
  transcript.events = events.filter((e) => e.n !== 9) as typeof transcript.events;
  return run;
}

beforeEach(() => {
  overrides = {};
  resetConfigForTest();
  location.hash = `#/run/${encodeURIComponent(RUN_KEY)}`;
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("USER 行：原文 + 本轮回复", () => {
  it("点 #1 USER：上段原话（pre 不解析）、下段「回复」= #4 AGENT 全文，带 3.0s 与「3.0s 后」", async () => {
    renderPage();
    const pane = await openAndClick("sp-1");
    expect(within(pane).getByTestId("msg-text").tagName).toBe("PRE");
    expect(within(pane).getByTestId("msg-text")).toHaveTextContent("帮我查一下 2 月 14 号北京到上海的航班");
    expect(within(pane).getByText("回复", { selector: "b" })).toBeInTheDocument();
    expect(within(pane).getByTestId("msg-reply")).toHaveTextContent("为您找到 3 个航班");
    expect(within(pane).getByTestId("msg-reply-gap")).toHaveTextContent("3.0s 后");
    // 回复段头带它自己的 t_offset_s（3.0s），不是 USER 的 0.0s
    const heads = pane.querySelectorAll(".dsec-h .num");
    expect(Array.from(heads).map((n) => n.textContent)).toEqual(["0.0s", "3.0s"]);
    expect(within(pane).queryByTestId("msg-no-reply")).toBeNull();
    // 零通用散文：恒成立的话不进版面也不进 title
    expectProseGone(pane, "回复见下", "点击查看");
  });

  it("中间工具调用计数与失败数现算：#1 轮「2 次 · 失败 0」，#5 轮「3 次 · 失败 2」", async () => {
    renderPage();
    let pane = await openAndClick("sp-1");
    expect(within(pane).getByTestId("msg-turn-tools")).toHaveTextContent("中间 2 次工具调用 · 失败 0");
    pane = await openAndClick("sp-5");
    expect(within(pane).getByTestId("msg-turn-tools")).toHaveTextContent("中间 3 次工具调用 · 失败 2");
  });

  it("无回复态：第二轮 USER 之后没有 assistant ⇒ 「这轮没有 Agent 回复」，无 msg-reply；计数行仍在", async () => {
    overrides.get_plan_run = (p) => [{ event: "plan_run", ...withoutLastReply(), run_key: p.run_key }];
    renderPage();
    const pane = await openAndClick("sp-5");
    expect(within(pane).getByTestId("msg-no-reply")).toHaveTextContent("这轮没有 Agent 回复");
    expect(within(pane).queryByTestId("msg-reply")).toBeNull();
    expect(within(pane).queryByTestId("msg-reply-gap")).toBeNull();
    expect(within(pane).getByTestId("msg-turn-tools")).toHaveTextContent("中间 3 次工具调用 · 失败 2");
    // 阳性对照：同一夹具里第一轮仍有回复
    const pane1 = await openAndClick("sp-1");
    expect(within(pane1).getByTestId("msg-reply")).toHaveTextContent("为您找到 3 个航班");
    expect(within(pane1).queryByTestId("msg-no-reply")).toBeNull();
  });

  it("点计数行：左栏 #6 #7 #8 三条 tool 行加 on（与选中行同一套），#2 #3 不加；再点一下熄掉", async () => {
    renderPage();
    const pane = await openAndClick("sp-5");
    const tree = screen.getByTestId(`trace-tree-${SID}`);
    const row = (k: string) => within(tree).getByTestId(`trace-row-${k}`);
    const btn = within(pane).getByTestId("msg-turn-tools");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    for (const k of ["sp-6", "sp-7", "sp-8"]) expect(row(k).className).not.toContain(" on");

    fireEvent.click(btn);
    expect(within(pane).getByTestId("msg-turn-tools").getAttribute("aria-pressed")).toBe("true");
    for (const k of ["sp-6", "sp-7", "sp-8"]) expect(row(k).className).toContain(" on");
    for (const k of ["sp-2", "sp-3", "sp-9"]) expect(row(k).className).not.toContain(" on");
    expect(row("sp-5").className).toContain(" on"); // 选中行本身不掉
    // 右栏没换选：还是 #5 的一问一答
    expect(within(pane).getByTestId("msg-text")).toHaveTextContent("帮我改到 15 号");

    fireEvent.click(within(pane).getByTestId("msg-turn-tools"));
    for (const k of ["sp-6", "sp-7", "sp-8"]) expect(row(k).className).not.toContain(" on");
    expect(row("sp-5").className).toContain(" on");
  });
});

describe("AGENT 行：前问折叠 + 全文", () => {
  it("点 #9 AGENT：上段「提问」= #5 原话（折成一行，点开展开），下段 AGENT 全文照旧", async () => {
    renderPage();
    const pane = await openAndClick("sp-9");
    expect(within(pane).getByText("提问", { selector: "b" })).toBeInTheDocument();
    const q = within(pane).getByTestId("msg-question");
    expect(q).toHaveTextContent("帮我改到 15 号，不要加价太多的");
    expect(q).not.toHaveTextContent("帮我查一下");
    expect(q.getAttribute("aria-expanded")).toBe("false");
    expect(q.className).not.toContain(" open");
    fireEvent.click(q);
    expect(within(pane).getByTestId("msg-question").getAttribute("aria-expanded")).toBe("true");
    expect(within(pane).getByTestId("msg-question").className).toContain(" open");
    expect(within(pane).getByTestId("msg-text")).toHaveTextContent("抱歉，改签暂时无法完成");
    // AGENT 态不出 USER 态专属的三样
    expect(within(pane).queryByTestId("msg-reply")).toBeNull();
    expect(within(pane).queryByTestId("msg-turn-tools")).toBeNull();
    expect(within(pane).queryByTestId("msg-no-reply")).toBeNull();
  });

  it("多轮配对前后各取最近：#4 AGENT 配 #1；#5 USER 配 #9 而不是 #4", async () => {
    renderPage();
    let pane = await openAndClick("sp-4");
    expect(within(pane).getByTestId("msg-question")).toHaveTextContent("帮我查一下 2 月 14 号");
    expect(within(pane).getByTestId("msg-text")).toHaveTextContent("为您找到 3 个航班");
    pane = await openAndClick("sp-5");
    expect(within(pane).getByTestId("msg-reply")).toHaveTextContent("抱歉，改签暂时无法完成");
    expect(within(pane).getByTestId("msg-reply")).not.toHaveTextContent("为您找到");
    expect(within(pane).getByTestId("msg-reply-gap")).toHaveTextContent("6.3s 后");
  });
});
