// 评估分析页「同题配对」tab + 双栏会话 diff + 单栏回放（ADR-0017 D3 / F8；批 compare-frontend）。
//
// 夹具 = 桩里 plan-aaa111 的 08-09（PREV_RUN_KEY）× 08-11（MOCK_PLAN_RUN）这一对：mock 的
// pair_rows / compare_sessions 就是照这对配的料（handlers.ts COMPARE_SESSIONS）。期望值一律从
// 桩数据 / 桩响应**现算**，锚点挑目标行专属的 testid（test-waitfor-anchor-discipline）。
// fetch 直接打 msw 的 mock handler（不另起一份桩）：页面读到的就是 mock 契约形状本身。
//
// 钉的判据：
//   1. 配对表行数 = pair_rows.total、表头「对齐 a / b」、tab 计数；未对齐行沉底灰显
//   2. Δ 三态：升 ↑（is-up）/ 降 ↓（is-down）/ 平 =（is-flat）；单侧无分 ⇒ 无 Δ
//   3. 点行原位展开双栏（两条 run 元信息条）、再点收起、两行同时展开
//   4. 属性 diff 只列 attribute_diff；system_prompt 的 text_diff 渲成 <del> / <ins>
//   5. 未对齐行展开 = 单栏回放 + 对面位置「X run 无同题会话」chip
//   6. 报告页格详情「回放」按钮打开同一个单栏组件（时间线轮数 = transcript 事件数）
//   7. mock 形状与契约逐字同形（键集 + 错误原话）
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ComparePage from "../src/pages/compare/ComparePage";
import ReportPage from "../src/pages/report/ReportPage";
import { AGENT_RUNS, COMPARE_SESSIONS, MOCK_ACCESS_TOKEN, MOCK_PLAN_RUN, PREV_RUN_KEY } from "../src/mocks/handlers";
import { deltaOf, fmtDelta } from "../src/pages/compare/pairsDerive";
import { orderComparePair } from "../src/pages/plan/compare/derive";
import { fmtRunTime } from "../src/lib/time";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
/** 谁在左由页面的 orderComparePair 按候选池（list_recent_runs = AGENT_RUNS）的 started_at 定，
 *  这里照同一个函数现算，不写死 —— 桩里 08-09 那行的 started_at 是 utcAgo(20)（存量分歧，旧数据不修），
 *  所以实际是 08-11 在左、08-09 在右；桩的 compare_sessions 料两侧对称，换序照样成立。 */
const ORDER = orderComparePair(AGENT_RUNS, PREV_RUN_KEY, MOCK_PLAN_RUN.run_key)!;
const LEFT = ORDER.aKey;
const RIGHT = ORDER.bKey;

/** 直接打 msw 的 mock handler（与 report-badcase-intake 同一招） */
async function callMock(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await mockResponse(payload);
  const text = await res.text();
  return JSON.parse(text.split("\n\n").filter(Boolean)[0].replace(/^data: /, ""));
}
async function mockResponse(payload: Record<string, unknown>): Promise<Response> {
  const { handlers } = await import("../src/mocks/handlers");
  const apiHandler = handlers.find((h) =>
    String((h as { info?: { path?: unknown } }).info?.path ?? "").includes("/api/invoke"))!;
  const out = await (apiHandler as unknown as {
    run: (a: { request: Request }) => Promise<{ response?: Response }>;
  }).run({
    request: new Request("http://localhost/api/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-authorization": `Bearer ${MOCK_ACCESS_TOKEN}` },
      body: JSON.stringify(payload),
    }),
  });
  return out.response!;
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("config.json")) return Response.json(CFG);
    return mockResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
  }));
}

function renderCompare() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ComparePage aKey={LEFT} bKey={RIGHT} /></QueryClientProvider>);
}
function renderReport(id: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ReportPage id={id} /></QueryClientProvider>);
}

beforeEach(() => {
  resetConfigForTest();
  resetRunFlightForTest();
  useSession.setState({ token: MOCK_ACCESS_TOKEN, authed: true, everAuthed: true, authExpired: false });
  installFetch();
  location.hash = `#/compare/${encodeURIComponent(LEFT)}/${encodeURIComponent(RIGHT)}`;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- 夹具现算 ----
type Side = (typeof COMPARE_SESSIONS)[string][string];
const L = COMPARE_SESSIONS[LEFT];
const R = COMPARE_SESSIONS[RIGHT];
const titleOf = (s: Side) => String(s.events.find((e) => e.type === "user")?.text ?? "");
/** 真差异那对：两侧都有、且属性不全等 */
const DIFF_KEY = Object.keys(L).find((k) => R[k] && JSON.stringify(L[k].attributes) !== JSON.stringify(R[k].attributes))!;
const DIFF_TITLE = titleOf(L[DIFF_KEY]);
/** 全部持平那对：两侧都有、属性全等 */
const SAME_KEY = Object.keys(L).find((k) => R[k] && k !== DIFF_KEY && titleOf(L[k]) !== "")!;
/** 孤儿行：题面为空的 session_error 会话（两侧各一行） */
const ORPHAN_KEY = Object.keys(L).find((k) => titleOf(L[k]) === "")!;

async function openPairsTab() {
  renderCompare();
  const tab = await screen.findByTestId("compare-tab-pairs");
  fireEvent.click(tab);
  await screen.findByTestId("pairs-table");
}

/** 配对表里某一行的 1 起下标（按 align_key 与对齐态定位，不按写死的行号） */
function rowIndexOf(alignKey: string, align: "aligned" | "left-only" | "right-only"): number {
  const rows = screen.getAllByTestId(/^pair-row-\d+$/);
  const i = rows.findIndex((r) => r.getAttribute("data-align-key") === alignKey && r.getAttribute("data-align") === align);
  expect(i, `没有 ${align} 的行「${alignKey}」`).toBeGreaterThanOrEqual(0);
  return i + 1;
}

// ---------------------------------------------------------------------------
describe("配对表：行数 / 对齐计数 / 沉底", () => {
  it("行数 = pair_rows.total，表头「对齐 aligned / total」，tab 计数同值", async () => {
    const ev = await callMock({ action: "pair_rows", left_run_key: LEFT, right_run_key: RIGHT });
    const pairs = ev.pairs as { left_row_key: string | null; right_row_key: string | null }[];
    const aligned = pairs.filter((p) => p.left_row_key && p.right_row_key).length;
    expect(aligned).toBe(2);
    expect(pairs.length).toBeGreaterThan(aligned);

    await openPairsTab();
    expect(screen.getAllByTestId(/^pair-row-\d+$/)).toHaveLength(pairs.length);
    expect(screen.getByTestId("pairs-aligned")).toHaveTextContent(`对齐 ${aligned} / ${pairs.length}`);
    expect(screen.getByTestId("compare-tab-pairs-n")).toHaveTextContent(String(pairs.length));
    expect(screen.getByTestId("pairs-sub")).toHaveTextContent(`${pairs.length} 行`);
  });

  it("已对齐在前、未对齐灰显沉底，chip 说清哪一侧没同题", async () => {
    await openPairsTab();
    const rows = screen.getAllByTestId(/^pair-row-\d+$/);
    const states = rows.map((r) => r.getAttribute("data-align"));
    const firstUn = states.indexOf("left-only");
    expect(firstUn).toBeGreaterThan(0);
    expect(states.slice(0, firstUn).every((s) => s === "aligned")).toBe(true);
    expect(states.slice(firstUn).every((s) => s !== "aligned")).toBe(true);
    for (const r of rows) {
      const st = r.getAttribute("data-align");
      const chip = within(r).getByTestId(/-align$/);
      if (st === "aligned") {
        expect(chip).toHaveTextContent("已对齐");
        expect(r.className).not.toContain("is-unaligned");
      } else {
        expect(r.className).toContain("is-unaligned");
        expect(chip).toHaveTextContent(st === "left-only" ? "未对齐 · 右无同题" : "未对齐 · 左无同题");
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("Δ：方向与色类只给状态", () => {
  it("纯函数：升 / 降 / 平 / 单侧无分", () => {
    expect(deltaOf(0.7, 0.9)).toEqual({ dir: "up", value: expect.closeTo(0.2, 6) });
    expect(fmtDelta(deltaOf(0.7, 0.9)!)).toBe("↑ +0.200");
    expect(fmtDelta(deltaOf(0.9, 0.8)!)).toBe("↓ −0.100");
    expect(fmtDelta(deltaOf(0.8, 0.8)!)).toBe("=");
    expect(deltaOf(0.8, 0.8004)!.dir).toBe("flat");
    expect(deltaOf(null, 0.9)).toBeNull();
    expect(deltaOf(0.9, undefined)).toBeNull();
  });

  it("真差异那对：三个评估器各落一态；孤儿行无 Δ", async () => {
    await openPairsTab();
    const i = rowIndexOf(DIFF_TITLE, "aligned");
    const dirs: Record<string, string> = {};
    for (const ev of Object.keys(L[DIFF_KEY].results)) {
      const l = L[DIFF_KEY].results[ev].score;
      const r = R[DIFF_KEY].results[ev].score;
      const d = deltaOf(l, r)!;
      const cell = screen.getByTestId(`pair-row-${i}-${ev}-delta`);
      expect(cell).toHaveTextContent(fmtDelta(d));
      expect(cell.getAttribute("data-dir")).toBe(d.dir);
      expect(cell.className).toContain(`is-${d.dir}`);
      // 色类只跟方向：升 good / 降 bad / 平中性 —— 三个类互斥
      expect(["is-up", "is-down", "is-flat"].filter((c) => cell.className.includes(c))).toEqual([`is-${d.dir}`]);
      dirs[d.dir] = ev;
    }
    expect(Object.keys(dirs).sort()).toEqual(["down", "flat", "up"]);

    const o = rowIndexOf("", "left-only");
    for (const ev of Object.keys(L[DIFF_KEY].results)) {
      const cell = screen.getByTestId(`pair-row-${o}-${ev}-delta`);
      expect(cell).toHaveTextContent("—");
      expect(cell.getAttribute("data-dir")).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
describe("原位展开：双栏 / 收起 / 多行同开", () => {
  it("点已对齐行 ⇒ 展开双栏（两条 run 元信息条）；再点收起；两行同时展开", async () => {
    await openPairsTab();
    const i = rowIndexOf(DIFF_TITLE, "aligned");
    const j = rowIndexOf(titleOf(L[SAME_KEY]), "aligned");
    const row = screen.getByTestId(`pair-row-${i}`);
    expect(row).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    const diff = await screen.findByTestId(`pair-row-${i}-diff`);
    expect(within(diff).getByTestId(`pair-row-${i}-diff-run-a`)).toHaveTextContent("左 run");
    expect(within(diff).getByTestId(`pair-row-${i}-diff-run-b`)).toHaveTextContent("右 run");
    // 元信息条读的是 attributes：in / out / 耗时 / 模型调用 / 工具调用 / 成本
    const a = L[DIFF_KEY].attributes;
    expect(within(diff).getByTestId(`pair-row-${i}-diff-run-a`))
      .toHaveTextContent(`in ${a["tokens.input"]} · out ${a["tokens.output"]}`);
    expect(within(diff).getByTestId(`pair-row-${i}-diff-run-a`)).toHaveTextContent(`#${L[DIFF_KEY].run_index}`);

    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId(`pair-row-${i}-expand`)).toBeNull();

    fireEvent.click(row);
    fireEvent.click(screen.getByTestId(`pair-row-${j}`));
    await screen.findByTestId(`pair-row-${i}-diff`);
    await screen.findByTestId(`pair-row-${j}-diff`);
    expect(screen.getAllByTestId(/^pair-row-\d+-expand$/)).toHaveLength(2);
  });

  it("时间线：两侧按 n 对位、同一刻度；文本不同的那一轮标 Modified 且连线标 is-mod", async () => {
    await openPairsTab();
    const i = rowIndexOf(DIFF_TITLE, "aligned");
    fireEvent.click(screen.getByTestId(`pair-row-${i}`));
    const tl = await screen.findByTestId(`pair-row-${i}-diff-tl`);
    const ln = L[DIFF_KEY].events.length;
    expect(tl.getAttribute("data-rounds")).toBe(String(Math.max(ln, R[DIFF_KEY].events.length)));
    expect(tl.getAttribute("data-timed")).toBe("true");
    // 桩里只有末轮 Agent 文本不同
    const changed = L[DIFF_KEY].events.filter((e, k) => e.text !== R[DIFF_KEY].events[k]?.text).map((e) => e.n as number);
    expect(changed).toHaveLength(1);
    for (const e of L[DIFF_KEY].events) {
      const n = e.n as number;
      const want = changed.includes(n) ? "modified" : "same";
      expect(within(tl).getByTestId(`pair-row-${i}-diff-tl-block-l-${n}`).getAttribute("data-state")).toBe(want);
      expect(within(tl).getByTestId(`pair-row-${i}-diff-tl-block-r-${n}`).getAttribute("data-state")).toBe(want);
      const link = within(tl).getByTestId(`pair-row-${i}-diff-tl-link-${n}`);
      expect(link.getAttribute("class") ?? "").toBe(want === "modified" ? "is-mod" : "");
    }
    // 差异块上有文字标（不只靠颜色）
    expect(within(tl).getByTestId(`pair-row-${i}-diff-tl-block-r-${changed[0]}-state`)).toHaveTextContent("Modified");
  });
});

// ---------------------------------------------------------------------------
describe("属性 diff：只列差异；system_prompt 字级 diff 渲成 del / ins", () => {
  it("行集 = attribute_diff 的键集；计数「差异 d / 8」；相同项不出现", async () => {
    const cmp = await callMock({
      action: "compare_sessions",
      left: { run_key: LEFT, row_key: DIFF_KEY }, right: { run_key: RIGHT, row_key: DIFF_KEY },
    });
    const diff = cmp.attribute_diff as { key: string; change: string; text_diff?: unknown[] }[];
    expect(diff.length).toBeGreaterThanOrEqual(3);
    expect(cmp.attribute_total).toBe(8);
    const sameKeys = ["model", "tokens.input", "tokens.output", "llm_calls", "tool_calls", "latency.avg_s", "cost.usd", "system_prompt"]
      .filter((k) => !diff.some((d) => d.key === k));
    expect(sameKeys.length).toBeGreaterThan(0);

    await openPairsTab();
    const i = rowIndexOf(DIFF_TITLE, "aligned");
    fireEvent.click(screen.getByTestId(`pair-row-${i}`));
    const attrs = await screen.findByTestId(`pair-row-${i}-diff-attrs`);
    expect(within(attrs).getByTestId(`pair-row-${i}-diff-attrs-count`)).toHaveTextContent(`差异 ${diff.length} / 8`);
    for (const d of diff) {
      const row = within(attrs).getByTestId(`pair-row-${i}-diff-attrs-row-${d.key}`);
      expect(within(row).getByTestId(`pair-row-${i}-diff-attrs-row-${d.key}-change`))
        .toHaveTextContent({ added: "Added", removed: "Removed", modified: "Modified" }[d.change]!);
    }
    for (const k of sameKeys) expect(within(attrs).queryByTestId(`pair-row-${i}-diff-attrs-row-${k}`)).toBeNull();

    // system_prompt：左格只有 del、右格只有 ins；拼回去分别等于两侧原文
    const sp = diff.find((d) => d.key === "system_prompt")!;
    expect(sp.text_diff!.length).toBeGreaterThan(1);
    const left = within(attrs).getByTestId(`pair-row-${i}-diff-attrs-row-system_prompt-left`);
    const right = within(attrs).getByTestId(`pair-row-${i}-diff-attrs-row-system_prompt-right`);
    expect(left.querySelectorAll("del").length).toBeGreaterThan(0);
    expect(left.querySelectorAll("ins")).toHaveLength(0);
    expect(right.querySelectorAll("ins").length).toBeGreaterThan(0);
    expect(right.querySelectorAll("del")).toHaveLength(0);
    expect(left.querySelector(".pr-difftext")!.textContent).toBe(L[DIFF_KEY].attributes.system_prompt);
    expect(right.querySelector(".pr-difftext")!.textContent).toBe(R[DIFF_KEY].attributes.system_prompt);
  });

  it("全部持平那对：属性 diff 零行、评估器 Δ 全 =", async () => {
    await openPairsTab();
    const j = rowIndexOf(titleOf(L[SAME_KEY]), "aligned");
    fireEvent.click(screen.getByTestId(`pair-row-${j}`));
    const attrs = await screen.findByTestId(`pair-row-${j}-diff-attrs`);
    expect(within(attrs).getByTestId(`pair-row-${j}-diff-attrs-count`)).toHaveTextContent("差异 0 / 8");
    expect(within(attrs).getByTestId(`pair-row-${j}-diff-attrs-none`)).toHaveTextContent("8 项属性两侧相同");
    const evals = screen.getByTestId(`pair-row-${j}-diff-evals`);
    for (const ev of Object.keys(R[SAME_KEY].results)) {
      const l = L[SAME_KEY].results[ev].score;
      const d = within(evals).getByTestId(`pair-row-${j}-diff-evals-row-${ev}-delta`);
      expect(d).toHaveTextContent(l == null ? "—" : "=");
    }
  });
});

// ---------------------------------------------------------------------------
describe("未对齐行：单栏回放 + 「无同题」chip", () => {
  it("左独有 ⇒ 左栏回放、右位置 chip「右 run 无同题会话」；右独有反之", async () => {
    await openPairsTab();
    const o = rowIndexOf("", "left-only");
    fireEvent.click(screen.getByTestId(`pair-row-${o}`));
    const replay = await screen.findByTestId(`pair-row-${o}-replay`);
    expect(replay.className).toContain("is-single");
    expect(within(replay).getByTestId(`pair-row-${o}-replay-missing`)).toHaveTextContent("右 run 无同题会话");
    expect(within(replay).getByTestId(`pair-row-${o}-replay-run`)).toHaveTextContent("左 run");
    expect(screen.queryByTestId(`pair-row-${o}-diff`)).toBeNull();
    // session_error 行：归档里有这条会话但没有 transcript ⇒ 0 事件、属性 8 行全 —
    const tl = within(replay).getByTestId(`pair-row-${o}-replay-tl`);
    expect(tl.getAttribute("data-rounds")).toBe("0");
    expect(within(replay).getAllByTestId(/^pair-row-\d+-replay-attrs-row-[^-]+$/)).toHaveLength(8);
    expect(within(replay).getByTestId(`pair-row-${o}-replay-evals-none`)).toHaveTextContent("0 个评估器");
    expect(ORPHAN_KEY).toBe("sess-deadbeef");
    expect(within(replay).getByTestId(`pair-row-${o}-replay-run`)).toHaveTextContent(fmtRunTime(L[ORPHAN_KEY].started_at));

    const p = rowIndexOf("", "right-only");
    fireEvent.click(screen.getByTestId(`pair-row-${p}`));
    const replay2 = await screen.findByTestId(`pair-row-${p}-replay`);
    expect(within(replay2).getByTestId(`pair-row-${p}-replay-missing`)).toHaveTextContent("左 run 无同题会话");
    expect(within(replay2).getByTestId(`pair-row-${p}-replay-run`)).toHaveTextContent("右 run");
  });
});

// ---------------------------------------------------------------------------
describe("报告页格详情「回放」：打开同一个单栏组件", () => {
  const OBS = MOCK_PLAN_RUN.report.stages[0] as unknown as {
    session_details: { session_id: string; results?: Record<string, unknown>; transcript?: { events: unknown[] } }[];
  };
  const SESSION_N = OBS.session_details.findIndex((s) => s.transcript && s.transcript.events.length > 0);
  const EV = Object.keys(OBS.session_details[SESSION_N].results ?? {})[0];
  const cell = `report-cell-0-${SESSION_N}-${EV}`;

  it("有 transcript 的会话格：按钮在，点开出单栏时间线（轮数 = transcript 事件数）；再点收起", async () => {
    renderReport(RIGHT);
    fireEvent.click(await screen.findByTestId(cell));
    const detail = await screen.findByTestId(`${cell}-detail`);
    const btn = within(detail).getByTestId(`${cell}-detail-replay`);
    expect(btn).toHaveTextContent("回放");
    expect(screen.queryByTestId(`${cell}-detail-replay-panel`)).toBeNull();
    fireEvent.click(btn);
    const panel = await screen.findByTestId(`${cell}-detail-replay-panel`);
    expect(panel.className).toContain("is-single");
    const tl = within(panel).getByTestId(`${cell}-detail-replay-panel-tl`);
    expect(tl.getAttribute("data-rounds")).toBe(String(OBS.session_details[SESSION_N].transcript!.events.length));
    // 报告页不传 missing ⇒ 只有一条元信息条，没有「无同题」chip
    expect(within(panel).queryByTestId(`${cell}-detail-replay-panel-missing`)).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByTestId(`${cell}-detail-replay-panel`)).toBeNull());
  });

  it("session_error 行（无 transcript / results）：格本身不存在 ⇒ 没有回放入口（阴性对照）", async () => {
    const errN = OBS.session_details.findIndex((s) => !s.transcript);
    expect(errN).toBeGreaterThanOrEqual(0);
    renderReport(RIGHT);
    await screen.findByTestId(cell);
    expect(screen.queryByTestId(`report-cell-0-${errN}-${EV}-detail-replay`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("mock 形状与契约逐字同形（pair_rows / compare_sessions）", () => {
  it("pair_rows：事件键集；行键集；缺席侧 row_key 与 results 都是 null；顺序 已对齐 → 左独有 → 右独有", async () => {
    const ev = await callMock({ action: "pair_rows", left_run_key: LEFT, right_run_key: RIGHT });
    expect(Object.keys(ev).sort()).toEqual(["aligned", "event", "pairs", "total"]);
    const pairs = ev.pairs as Record<string, unknown>[];
    for (const p of pairs) {
      expect(Object.keys(p).sort()).toEqual(["align_key", "left_results", "left_row_key", "right_results", "right_row_key"]);
      if (p.left_row_key == null) expect(p.left_results).toBeNull();
      if (p.right_row_key == null) expect(p.right_results).toBeNull();
    }
    expect(ev.total).toBe(pairs.length);
    expect(ev.aligned).toBe(pairs.filter((p) => p.left_row_key && p.right_row_key).length);
    const kinds = pairs.map((p) => (p.left_row_key && p.right_row_key ? 0 : p.left_row_key ? 1 : 2));
    expect([...kinds].sort((a, b) => a - b)).toEqual(kinds);
    // 换序调用：左右对调，配对数不变
    const rev = await callMock({ action: "pair_rows", left_run_key: RIGHT, right_run_key: LEFT });
    expect(rev.aligned).toBe(ev.aligned);
    expect(rev.total).toBe(ev.total);
  });

  it("compare_sessions：事件键集；八项属性键序固定；两侧 events 只带九键；aligned / align_key", async () => {
    const ev = await callMock({
      action: "compare_sessions",
      left: { run_key: LEFT, row_key: DIFF_KEY }, right: { run_key: RIGHT, row_key: DIFF_KEY },
    });
    expect(Object.keys(ev).sort()).toEqual(["align_key", "aligned", "attribute_diff", "attribute_total", "event", "left", "right"]);
    for (const side of [ev.left, ev.right] as Record<string, unknown>[]) {
      expect(Object.keys(side).sort()).toEqual(["attributes", "events", "results", "row_key", "run_index", "run_key", "stage_type", "started_at"]);
      expect(Object.keys(side.attributes as object)).toEqual(
        ["model", "tokens.input", "tokens.output", "llm_calls", "tool_calls", "latency.avg_s", "cost.usd", "system_prompt"]);
      for (const e of side.events as Record<string, unknown>[]) {
        expect(Object.keys(e).sort()).toEqual(["arguments", "duration_s", "error", "n", "name", "result", "t_offset_s", "text", "type"]);
      }
    }
    expect(ev.aligned).toBe(true);
    expect(ev.align_key).toBe(DIFF_TITLE);
    const sp = (ev.attribute_diff as { key: string; text_diff?: { op: string; text: string }[] }[]).find((d) => d.key === "system_prompt")!;
    expect(sp.text_diff!.every((o) => ["equal", "delete", "insert"].includes(o.op))).toBe(true);
    expect(sp.text_diff!.filter((o) => o.op !== "insert").map((o) => o.text).join("")).toBe(L[DIFF_KEY].attributes.system_prompt);
    expect(sp.text_diff!.filter((o) => o.op !== "delete").map((o) => o.text).join("")).toBe(R[DIFF_KEY].attributes.system_prompt);
  });

  it("错误原话逐字：不能为空 / 不存在 / 里没有", async () => {
    expect(await callMock({ action: "pair_rows", left_run_key: "", right_run_key: RIGHT }))
      .toEqual({ event: "error", error: "left_run_key 不能为空" });
    expect(await callMock({ action: "pair_rows", left_run_key: LEFT, right_run_key: "" }))
      .toEqual({ event: "error", error: "right_run_key 不能为空" });
    expect(await callMock({ action: "pair_rows", left_run_key: "plan-x#1", right_run_key: RIGHT }))
      .toEqual({ event: "error", error: "run 'plan-x#1' 不存在" });
    expect(await callMock({ action: "compare_sessions", left: { run_key: LEFT }, right: { run_key: RIGHT, row_key: DIFF_KEY } }))
      .toEqual({ event: "error", error: "left.row_key 不能为空" });
    expect(await callMock({ action: "compare_sessions", left: { run_key: LEFT, row_key: DIFF_KEY }, right: { row_key: DIFF_KEY } }))
      .toEqual({ event: "error", error: "right.run_key 不能为空" });
    expect(await callMock({ action: "compare_sessions", left: { run_key: LEFT, row_key: "sess-nope" }, right: { run_key: RIGHT, row_key: DIFF_KEY } }))
      .toEqual({ event: "error", error: `run '${LEFT}' 里没有 'sess-nope'` });
  });
});
