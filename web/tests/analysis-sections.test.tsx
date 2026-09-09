// 评估分析页的跨 run 区块（ADR-0014 后果②④，批 adr0014-migrate，变体 C）：
//   趋势图（复用 TrendCard 派生）→ 两段卡（反复出现的问题 / 改进采纳效果）→
//   采纳追踪表 → 既有三段（口径 / 逐环节 / 逐用例）。
//
// 三层钉：
//   ① 版面与缺席态：两次都选上才有整块；「整体趋势」「当前优先建议」两段正文
//      **不上屏**（趋势交给图、建议落进表）；老形状 run 两段卡缺席、图与表照常；
//   ② 双向深链：正文里的用例 chip 点了 → 下方逐用例对照里那一行展开；
//   ③ 采纳：数据源 = 该计划各 run 的 proposals（list_plan_runs 行上就带，
//      planrun._run_from_item），动作复用 set_proposal_adopted，成功就地翻转 +
//      失效 ["plan_runs", planId]，失败原话钉在行上；mock 与后端同刑（三角钉）。
//
// 夹具走**真 mock handler**（msw 那份），不另抄一份形状：list_plan_runs /
// get_plan_run / set_proposal_adopted 都是桩里那套读改写同一个数组的语义，
// 这里只对 list_recent_runs（候选池）与个别失败路径打 override。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ComparePage from "../src/pages/compare/ComparePage";
import { improvementPayload, sortRunsDesc } from "../src/pages/plan/derive";
import type { PlanRunDetail } from "../src/pages/plan/types";
import {
  handlers, MOCK_ACCESS_TOKEN, MOCK_PLAN_RUN, MOCK_PLAN_RUN_PREV, PLAN_RUNS, PREV_RUN_KEY,
  PLAN_RUN_DETAIL,
} from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
const planrunPy = readFileSync(resolve(process.cwd(), "../app/planrun.py"), "utf8");

const PLAN_ID = "plan-aaa111";
const RUN_KEY = MOCK_PLAN_RUN.run_key;          // 08-11 ＝「这一次」
const KEY_0820 = "plan-aaa111#2026-08-20T07:15:00Z";

type Payload = { action: string } & Record<string, unknown>;
type Frames = Record<string, unknown>[];
let overrides: Record<string, (p: Payload) => Frames> = {};
let calls: Payload[] = [];
let qc: QueryClient;

/** 候选池（list_recent_runs 口径）：拿运行历史那几行加上方案三字段，时间与
 *  list_plan_runs 那份逐字同值 —— AGENT_RUNS 里 08-09 那行是 utcAgo(20) 的相对
 *  时钟，会把「上一次」排到「这一次」后面（存量分歧，不在本批射程）。 */
const POOL = PLAN_RUNS.map((r) => ({
  ...r, plan_id: PLAN_ID, plan_name: "FAQ 周回归", agent_name: "support-bot",
}));

/** 走 msw 那份 handler 本身发一次请求（形状不抄第二份）。 */
async function viaMock(payload: Payload): Promise<Response> {
  const apiHandler = handlers.find((h) =>
    String((h as { info?: { path?: unknown } }).info?.path ?? "").includes("/api/invoke"));
  expect(apiHandler, "mocks/handlers.ts 应有 /api/invoke 的 handler").toBeTruthy();
  const res = await (apiHandler as unknown as {
    run: (a: { request: Request }) => Promise<{ response?: Response }>;
  }).run({
    request: new Request("http://localhost/api/invoke", {
      method: "POST",
      // 桩读的是 x-authorization（与 lib/api 同一个头名）
      headers: { "Content-Type": "application/json", "x-authorization": `Bearer ${MOCK_ACCESS_TOKEN}` },
      body: JSON.stringify(payload),
    }),
  });
  return res.response!;
}

async function framesOf(payload: Payload): Promise<Frames> {
  const text = await (await viaMock(payload)).text();
  return text.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, "")));
}

function sseResponse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    calls.push(payload);
    if (payload.action === "list_recent_runs") {
      return sseResponse([{ event: "recent_runs", runs: POOL }]);
    }
    const over = overrides[payload.action];
    if (over) return sseResponse(over(payload));
    return viaMock(payload);
  }));
}

function renderCompare(aKey = PREV_RUN_KEY, bKey = RUN_KEY) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ComparePage aKey={aKey} bKey={bKey} />
    </QueryClientProvider>,
  );
}

/** 等到整块到齐：锚点挑**采纳表的目标行**（它要 list_plan_runs 到；两段卡要
 *  get_plan_run 到；两者是两条请求，只等其中一条会跑在另一条前面）。 */
async function openAnalysis() {
  renderCompare();
  await screen.findByTestId(`analysis-adopt-row-${KEY_0820}-0`);
  await screen.findByTestId("analysis-section-recurring");
  return screen.getByTestId("analysis-sections");
}

/** `#N`：与运行历史表同一个排序函数产出（按数组下标算） */
function seqOf(runKey: string): number {
  const sorted = sortRunsDesc(PLAN_RUNS as never[]) as { run_key: string }[];
  const i = sorted.findIndex((r) => r.run_key === runKey);
  expect(i).toBeGreaterThanOrEqual(0);
  return sorted.length - i;
}

beforeEach(() => {
  overrides = {};
  calls = [];
  resetConfigForTest();
  resetRunFlightForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  location.hash = "#/compare";
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ① 版面：三块在既有三段之上；缺席态
// ---------------------------------------------------------------------------
describe("版面：趋势图 → 两段卡 → 采纳表，压在口径 / 逐环节 / 逐用例之上", () => {
  it("深链 (上一次, 这一次)：这一次是 08-11；整块在结果卡之前", async () => {
    const block = await openAnalysis();
    // 「这一次」身份落在 08-11 上（报告页那道门传的就是 (prev, this)）
    const picked = screen.getAllByTestId("compare-picked-ok");
    const mine = picked.find((c) => c.textContent?.includes("2026-08-11"))!;
    expect(mine).toHaveTextContent("这一次");
    // 版面顺序：分析区块 → 结果卡
    const result = screen.getByTestId("compare-result");
    expect(block.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("趋势图：线上评估均分的点位来自本计划全部有分 run（不是只有这两次），带目标线与区间统计", async () => {
    const block = await openAnalysis();
    const trend = within(block).getByTestId("analysis-trend");
    expect(trend).toHaveTextContent("线上评估均分");
    // 有分 run 数 = PLAN_RUNS 里 isScored 的行数（6），比「两次」多 ⇒ 图是计划级的
    expect(trend).toHaveTextContent("6 次有分运行");
    expect(trend).toHaveTextContent("目标线 0.7");
    // 区间统计列是 jsdom 下唯一量得到的图内容（svg 量到 0×0）
    expect(within(trend).getByTestId("trend-stat-max")).toHaveTextContent("0.86");
    // 「整体趋势」段正文**不上屏**——趋势交给图
    expect(block.textContent).not.toContain("近 3 次成功运行");
  });

  it("两段卡：只有「反复出现的问题」「改进采纳效果」；「当前优先建议」正文不出现", async () => {
    const block = await openAnalysis();
    const recurring = within(block).getByTestId("analysis-section-recurring");
    expect(recurring).toHaveTextContent("反复出现的问题");
    expect(recurring).toHaveTextContent("持续答非所问");
    // judge 引文块渲成 quote，不是裸 `> `
    expect(within(recurring).getByTestId("syn-quote")).toHaveTextContent("答非所问：未给出自助路径");
    expect(recurring.textContent).not.toContain("> judge");
    const adopted = within(block).getByTestId("analysis-section-adopted");
    expect(adopted).toHaveTextContent("改进采纳效果");
    expect(adopted).toHaveTextContent("暂无已采纳的改进记录");
    // 「当前优先建议」的条目不作为正文（它们落进采纳表的未采纳组）
    expect(block.textContent).not.toContain("为 case-2 涉及的");
    expect(screen.queryByText("当前优先建议")).toBeNull();
    expect(screen.queryByText("整体趋势")).toBeNull();
  });

  it("只选了一条 / 没选：整块缺席（不留空壳）", async () => {
    renderCompare("", "");
    await screen.findByTestId("compare-list");
    expect(screen.queryByTestId("analysis-sections")).toBeNull();
  });

  it("老形状 run（无 synthesis_sections 且 plan_synthesis 为空）：两段卡缺席，图与表照常", async () => {
    overrides.get_plan_run = (p) => [{
      event: "plan_run",
      ...(String(p.run_key) === PREV_RUN_KEY ? MOCK_PLAN_RUN_PREV : MOCK_PLAN_RUN),
      run_key: p.run_key, plan_synthesis: null, synthesis_sections: [],
    }];
    installFetch();
    renderCompare();
    await screen.findByTestId(`analysis-adopt-row-${KEY_0820}-0`);
    await screen.findByTestId("plan-compare-kpis");
    await waitFor(() => expect(screen.queryByTestId("plan-compare-loading")).toBeNull());
    expect(screen.getByTestId("analysis-trend")).toBeInTheDocument();
    expect(screen.getByTestId("analysis-adoption")).toBeInTheDocument();
    expect(screen.queryByTestId("analysis-synthesis")).toBeNull();
  });

  // 对象型 plan_synthesis（真后端实测形态，同 UI-026 白屏那族）：分节归一化已收口到
  // plan/derive.sectionsOf，四个消费方共用。此前这一处是 `synthesisSections(d.plan_synthesis)`
  // 裸传 —— 对象进去在 text.trim() 上抛 TypeError，useMemo 在错误围栏外 ⇒ 整块白掉。
  it("对象型 plan_synthesis 不炸：分析区块照常渲染（两段卡按「认不出的键形」缺席）", async () => {
    overrides.get_plan_run = (p) => [{
      event: "plan_run",
      ...(String(p.run_key) === PREV_RUN_KEY ? MOCK_PLAN_RUN_PREV : MOCK_PLAN_RUN),
      run_key: p.run_key, plan_synthesis: { foo: 1, bar: 2 }, synthesis_sections: [],
    }];
    installFetch();
    renderCompare();
    await screen.findByTestId(`analysis-adopt-row-${KEY_0820}-0`);
    await waitFor(() => expect(screen.queryByTestId("plan-compare-loading")).toBeNull());
    // 整块与两条既有内容都在（白屏时这三个 testid 一个都取不到）
    expect(screen.getByTestId("analysis-sections")).toBeInTheDocument();
    expect(screen.getByTestId("analysis-trend")).toBeInTheDocument();
    expect(screen.getByTestId("analysis-adoption")).toBeInTheDocument();
    // 归一后的那一节标题是「综合报告」，不含两段卡的标题 ⇒ 两段卡缺席
    expect(screen.queryByTestId("analysis-synthesis")).toBeNull();
  });

  it("有分节但两段标题都不在（只有整体趋势）：两段卡整块缺席，不画空卡", async () => {
    overrides.get_plan_run = (p) => [{
      event: "plan_run",
      ...(String(p.run_key) === PREV_RUN_KEY ? MOCK_PLAN_RUN_PREV : MOCK_PLAN_RUN),
      run_key: p.run_key,
      synthesis_sections: [{ title: "整体趋势", body: "首次运行，暂无趋势。" }],
    }];
    installFetch();
    renderCompare();
    await screen.findByTestId(`analysis-adopt-row-${KEY_0820}-0`);
    await waitFor(() => expect(screen.queryByTestId("plan-compare-loading")).toBeNull());
    expect(screen.queryByTestId("analysis-synthesis")).toBeNull();
    expect(screen.queryByText("首次运行，暂无趋势。")).toBeNull();
  });

  it("老数据 fallback：无 synthesis_sections 时按 `## ` 切 plan_synthesis（与 RunDetailPage 同一份）", async () => {
    overrides.get_plan_run = (p) => [{
      event: "plan_run",
      ...(String(p.run_key) === PREV_RUN_KEY ? MOCK_PLAN_RUN_PREV : MOCK_PLAN_RUN),
      run_key: p.run_key, synthesis_sections: null,
      plan_synthesis: "## 整体趋势\n略。\n## 反复出现的问题\n[case:case-2@support-bot] 连续两次答非所问。",
    }];
    installFetch();
    renderCompare();
    const card = await screen.findByTestId("analysis-section-recurring");
    expect(card).toHaveTextContent("连续两次答非所问");
    expect(screen.queryByTestId("analysis-section-adopted")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ② 双向深链：chip → 逐用例对照那一行
// ---------------------------------------------------------------------------
describe("引用 chip → 下方逐用例对照", () => {
  it("正文里的 [case:case-2] 是按钮；点了下方 case-2 那行展开并可见", async () => {
    const block = await openAnalysis();
    // 逐用例对照先到齐（两侧明细都要在）
    const row = await screen.findByTestId("plan-compare-pair-1-case-2");
    expect(row.className).not.toContain("is-open");
    const recurring = within(block).getByTestId("analysis-section-recurring");
    const chip = within(recurring).getAllByTestId("syn-case-ref")
      .find((c) => c.textContent === "case-2")!;
    expect(chip.tagName).toBe("BUTTON");
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByTestId("plan-compare-pair-1-case-2-body")).toBeInTheDocument());
  });

  it("卡底「引用」行：去重后的 case / session chip；有落点的是按钮，run 编号不是（没有跳转对象）", async () => {
    const block = await openAnalysis();
    const recurring = within(block).getByTestId("analysis-section-recurring");
    const refs = within(recurring).getByTestId("analysis-section-refs");
    const chips = within(refs).getAllByTestId("analysis-ref");
    const labels = chips.map((c) => c.textContent);
    // 正文里 case-2 出现一次、run:#2 与 run:#5 各一次、session 一次 ⇒ 去重后各一枚
    expect(labels.filter((l) => l === "case-2")).toHaveLength(1);
    expect(labels).toContain("run:#2");
    expect(labels).toContain("run:#5");
    // case-2 在下方逐用例对照里有行 ⇒ 按钮；run 编号没有落点 ⇒ 不是按钮
    expect(chips.find((c) => c.textContent === "case-2")!.tagName).toBe("BUTTON");
    expect(chips.find((c) => c.textContent === "run:#2")!.tagName).toBe("SPAN");
    // 零通用散文：chip 不挂 title
    for (const c of chips) expect(c).not.toHaveAttribute("title");
  });

  it("正文引用了下方没有的用例：chip 保持 span（不给一个点了没反应的按钮）", async () => {
    overrides.get_plan_run = (p) => [{
      event: "plan_run",
      ...(String(p.run_key) === PREV_RUN_KEY ? MOCK_PLAN_RUN_PREV : MOCK_PLAN_RUN),
      run_key: p.run_key,
      synthesis_sections: [
        { title: "反复出现的问题", body: "[case:ghost-99@support-bot] 与 [case:case-2@support-bot] 都失败。" },
      ],
    }];
    installFetch();
    renderCompare();
    const card = await screen.findByTestId("analysis-section-recurring");
    await screen.findByTestId("plan-compare-pair-1-case-2");
    await waitFor(() => {
      const chips = within(card).getAllByTestId("syn-case-ref");
      expect(chips.find((c) => c.textContent === "case-2")!.tagName).toBe("BUTTON");
      expect(chips.find((c) => c.textContent === "ghost-99")!.tagName).toBe("SPAN");
    });
  });
});

// ---------------------------------------------------------------------------
// ③ 采纳追踪表
// ---------------------------------------------------------------------------
describe("采纳追踪表：该计划各 run 的 proposals 合成一张表", () => {
  it("行数 = 各 run 处方总数；未采纳组在上、已采纳组在下；卡头写总数与未采纳数", async () => {
    const block = await openAnalysis();
    const card = within(block).getByTestId("analysis-adoption");
    expect(card).toHaveTextContent("采纳追踪");
    expect(card).toHaveTextContent("5 条建议");
    expect(card).toHaveTextContent("未采纳 3");
    const rows = within(card).getAllByTestId(/^analysis-adopt-row-.+-\d+$/);
    expect(rows).toHaveLength(5);
    // 组序：未采纳组行在已采纳组行之前
    const pending = within(card).getByTestId("analysis-adopt-group-pending");
    const done = within(card).getByTestId("analysis-adopt-group-done");
    expect(pending).toHaveTextContent("未采纳");
    expect(pending).toHaveTextContent("3");
    expect(done).toHaveTextContent("已采纳");
    expect(done).toHaveTextContent("2");
    expect(pending.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 「已忽略」在后端没有这个状态（adopted_at 只有 null / 时间两态）⇒ 不造这个词
    expect(card.textContent).not.toContain("已忽略");
  });

  it("未采纳组按引用数降序：08-20 那条摘要点名两个用例，排第 1；零引用的按 run 新→旧", async () => {
    const block = await openAnalysis();
    const card = within(block).getByTestId("analysis-adoption");
    const rows = within(card).getAllByTestId(/^analysis-adopt-row-.+-\d+$/);
    expect(rows[0]).toHaveAttribute("data-testid", `analysis-adopt-row-${KEY_0820}-0`);
    expect(rows[0]).toHaveTextContent("1");
    // 摘要里的引用渲成 chip（不是裸 [case:…]）
    expect(rows[0].textContent).not.toContain("[case:");
    expect(within(rows[0]).getAllByTestId("syn-case-ref")).toHaveLength(2);
    expect(rows[1]).toHaveAttribute("data-testid", `analysis-adopt-row-${RUN_KEY}-1`);
    expect(rows[2]).toHaveAttribute("data-testid", `analysis-adopt-row-${PREV_RUN_KEY}-1`);
  });

  it("每行：摘要 / 生成于（#N + 时间）/ 采纳态 / 采纳后效果 / 未采纳才有「采纳」链", async () => {
    const block = await openAnalysis();
    const card = within(block).getByTestId("analysis-adoption");
    const pending = within(card).getByTestId(`analysis-adopt-row-${RUN_KEY}-1`);
    expect(pending).toHaveTextContent("改写 rebook_flight 工具描述");
    expect(within(pending).getByTestId(`analysis-adopt-row-${RUN_KEY}-1-gen`))
      .toHaveTextContent(`#${seqOf(RUN_KEY)}`);
    expect(pending).toHaveTextContent("2026-08-11 09:22 UTC");
    expect(within(pending).getByTestId(`analysis-adopt-row-${RUN_KEY}-1-state`))
      .toHaveTextContent("未采纳");
    expect(within(pending).getByTestId(`analysis-adopt-row-${RUN_KEY}-1-adopt`))
      .toHaveTextContent("采纳");
    // 已采纳的：badge 带采纳时间，**没有**采纳链（量词钉）
    const done = within(card).getByTestId(`analysis-adopt-row-${PREV_RUN_KEY}-0`);
    expect(within(done).getByTestId(`analysis-adopt-row-${PREV_RUN_KEY}-0-state`))
      .toHaveTextContent("已采纳 · 2026-08-10 02:05 UTC");
    expect(within(done).queryAllByTestId(/-adopt$/)).toHaveLength(0);
    // 效果 = 下一次 run 的 overview.adoption_note.score_changes（08-11 写的那份）
    expect(within(done).getByTestId(`analysis-adopt-row-${PREV_RUN_KEY}-0-effect`))
      .toHaveTextContent("线上评估均分 0.79 → 0.86");
    expect(within(done).getByTestId(`analysis-adopt-row-${PREV_RUN_KEY}-0-effect`))
      .toHaveTextContent("回归通过率 50% → 75%");
    // 08-11 上那条已采纳的：之后的 run 没写采纳记录 ⇒ 效果列空位显示长破折号
    expect(within(card).getByTestId(`analysis-adopt-row-${RUN_KEY}-0-effect`)).toHaveTextContent("—");
    // 未采纳行的效果列不编「预计」：契约里没有预计影响字段
    expect(within(pending).getByTestId(`analysis-adopt-row-${RUN_KEY}-1-effect`)).toHaveTextContent("—");
    expect(card.textContent).not.toContain("预计");
  });

  it("点「采纳」：带 run_key + 数组下标调 set_proposal_adopted；成功就地翻转，失效运行历史", async () => {
    overrides.set_proposal_adopted = (p) => [{
      event: "proposal_adopted", run_key: p.run_key,
      proposal: { summary: "x", generated_at: "2026-08-11 09:22 UTC", adopted_at: "2026-09-03 08:00 UTC" },
    }];
    installFetch();
    const block = await openAnalysis();
    const row = within(block).getByTestId(`analysis-adopt-row-${RUN_KEY}-1`);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    fireEvent.click(within(row).getByTestId(`analysis-adopt-row-${RUN_KEY}-1-adopt`));
    await waitFor(() => expect(within(row).getByTestId(`analysis-adopt-row-${RUN_KEY}-1-state`))
      .toHaveTextContent("已采纳 · 2026-09-03 08:00 UTC"));
    const sent = calls.filter((c) => c.action === "set_proposal_adopted");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ run_key: RUN_KEY, index: 1, adopted: true });
    expect(within(row).queryAllByTestId(/-adopt$/)).toHaveLength(0);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["plan_runs", PLAN_ID] });
    // 别的行不连坐
    expect(within(block).getByTestId(`analysis-adopt-row-${KEY_0820}-0-adopt`)).toBeEnabled();
  });

  it("采纳失败：后端原话钉在这一行，链回到可点，别的行不连坐", async () => {
    overrides.set_proposal_adopted = () => [{
      event: "error", error: "处方序号 9 不存在（该 run 有 1 份处方）",
    }];
    installFetch();
    const block = await openAnalysis();
    const row = within(block).getByTestId(`analysis-adopt-row-${KEY_0820}-0`);
    fireEvent.click(within(row).getByTestId(`analysis-adopt-row-${KEY_0820}-0-adopt`));
    await waitFor(() => expect(screen.getByTestId(`analysis-adopt-row-${KEY_0820}-0-error`))
      .toHaveTextContent("处方序号 9 不存在（该 run 有 1 份处方）"));
    expect(within(row).getByTestId(`analysis-adopt-row-${KEY_0820}-0-adopt`)).toBeEnabled();
    expect(within(row).getByTestId(`analysis-adopt-row-${KEY_0820}-0-state`)).toHaveTextContent("未采纳");
    expect(screen.queryByTestId(`analysis-adopt-row-${RUN_KEY}-1-error`)).toBeNull();
  });

  it("该计划一条处方都没有、这一次能生成：卡只剩卡头 + 生成入口（表与「N 条建议」不画）", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: PLAN_RUNS.map((r) => ({ ...r, proposals: [] })),
    }];
    installFetch();
    renderCompare();
    await screen.findByTestId("analysis-section-recurring");
    const card = await screen.findByTestId("analysis-adoption");
    expect(within(card).getByTestId("analysis-generate")).toHaveTextContent("生成改进稿");
    expect(within(card).queryAllByTestId(/^analysis-adopt-row-/)).toHaveLength(0);
    expect(card.querySelector("table")).toBeNull();
    expect(card.textContent).not.toContain("条建议");
  });

  it("该计划一条处方都没有、这一次也生成不了（无 observe 明细）：采纳表整块缺席", async () => {
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: PLAN_RUNS.map((r) => ({ ...r, proposals: [] })),
    }];
    overrides.get_plan_run = (p) => [{
      event: "plan_run",
      ...(String(p.run_key) === PREV_RUN_KEY ? MOCK_PLAN_RUN_PREV : MOCK_PLAN_RUN),
      run_key: p.run_key,
      report: { ...MOCK_PLAN_RUN.report, stages: MOCK_PLAN_RUN.report.stages.filter((s) => s.type !== "observe") },
    }];
    installFetch();
    renderCompare();
    // 锚点挑趋势卡：这份 override 走的是 MOCK_PLAN_RUN 常量（无 synthesis_sections，
    // 桩里那层合并没经过）⇒ 两段卡也缺席，拿它当锚会等到超时
    await screen.findByTestId("analysis-trend");
    await waitFor(() => expect(screen.queryByTestId("plan-compare-loading")).toBeNull());
    expect(screen.queryByTestId("analysis-adoption")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ④ 「生成改进稿」入口（优化闭环里唯一会产生新建议的付费动作，随 ImprovementBlock
//    删除后加回到采纳卡头右侧；复用 derive.improvementPayload + propose_improvements）
// ---------------------------------------------------------------------------
describe("生成改进稿：采纳卡头右侧的入口", () => {
  const observeSessions = (MOCK_PLAN_RUN.report.stages as { type: string; session_details?: unknown[] }[])
    .find((s) => s.type === "observe")!.session_details!;
  const usable = improvementPayload(MOCK_PLAN_RUN as unknown as PlanRunDetail, "support-bot").usable;

  it("入口是文字链；点了弹确认卡带成本披露（评估模型 / 本次 N 个会话 / 不重跑），取消不发请求", async () => {
    expect(usable, "夹具自检：08-11 得有够格的会话，否则测的是缺席路径").toBeGreaterThan(0);
    const block = await openAnalysis();
    const card = within(block).getByTestId("analysis-adoption");
    const gen = within(card).getByTestId("analysis-generate");
    expect(gen.tagName).toBe("BUTTON");
    expect(gen).toHaveTextContent("生成改进稿");
    fireEvent.click(gen);
    const confirm = await screen.findByTestId("confirm-card");
    expect(confirm).toHaveTextContent("评估模型");
    expect(confirm).toHaveTextContent("产生真实费用");
    expect(confirm).toHaveTextContent(`${usable} 个会话`);
    expect(confirm).toHaveTextContent("不重跑评估");
    expect(calls.some((c) => c.action === "propose_improvements")).toBe(false);
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(screen.queryByTestId("confirm-card")).toBeNull();
    expect(calls.some((c) => c.action === "propose_improvements")).toBe(false);
  });

  it("确认：请求带 agent_name / 全部会话（剥 transcript）/ run_key；成功后新建议落进未采纳组，失效运行历史", async () => {
    const before = (await framesOf({ action: "list_plan_runs", plan_id: PLAN_ID }))[0].runs as
      { run_key: string; proposals: unknown[] }[];
    const prevLen = before.find((r) => r.run_key === RUN_KEY)!.proposals.length;
    const block = await openAnalysis();
    const card = within(block).getByTestId("analysis-adoption");
    expect(card).toHaveTextContent("未采纳 3");
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    fireEvent.click(within(card).getByTestId("analysis-generate"));
    fireEvent.click(await screen.findByTestId("confirm-card-ok"));
    // 新行 = 该 run proposals 数组的下一个下标（attach_proposal 只追加）
    const row = await screen.findByTestId(`analysis-adopt-row-${RUN_KEY}-${prevLen}`);
    expect(within(row).getByTestId(`analysis-adopt-row-${RUN_KEY}-${prevLen}-state`))
      .toHaveTextContent("未采纳");
    expect(row.textContent).not.toContain("[object");
    expect(card).toHaveTextContent("未采纳 4");
    const sent = calls.filter((c) => c.action === "propose_improvements");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ agent_name: "support-bot", run_key: RUN_KEY });
    expect(sent[0].sessions).toHaveLength(observeSessions.length);
    for (const s of sent[0].sessions as Record<string, unknown>[]) {
      expect(s).not.toHaveProperty("transcript");
    }
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["plan_runs", PLAN_ID] });
    // 入口回到可点（可再生成）
    expect(within(card).getByTestId("analysis-generate")).toBeEnabled();
    expect(within(card).getByTestId("analysis-generate")).toHaveTextContent("生成改进稿");
  });

  it("失败：后端原话钉在卡头下一行，入口回到可点，表不多一行", async () => {
    overrides.propose_improvements = () => [{
      event: "error", error: "改进稿生成失败：改进稿生成未返回结构化结果（stopReason=max_tokens），疑似 maxTokens 被推理占满，可重试。",
    }];
    installFetch();
    const block = await openAnalysis();
    const card = within(block).getByTestId("analysis-adoption");
    const rowsBefore = within(card).getAllByTestId(/^analysis-adopt-row-.+-\d+$/).length;
    fireEvent.click(within(card).getByTestId("analysis-generate"));
    fireEvent.click(await screen.findByTestId("confirm-card-ok"));
    await waitFor(() => expect(within(card).getByTestId("analysis-generate-error"))
      .toHaveTextContent("疑似 maxTokens 被推理占满"));
    expect(within(card).getByTestId("analysis-generate")).toBeEnabled();
    expect(within(card).getAllByTestId(/^analysis-adopt-row-.+-\d+$/)).toHaveLength(rowsBefore);
  });

  it("缺席：这一次 run 没有线上评估会话明细 / 没记 Agent 名 ⇒ 入口整块不在（不留禁用态）", async () => {
    // 旧形状：归档里没有 observe 会话明细（证据判据 usable = 0）
    overrides.get_plan_run = (p) => [{
      event: "plan_run",
      ...(String(p.run_key) === PREV_RUN_KEY ? MOCK_PLAN_RUN_PREV : MOCK_PLAN_RUN),
      run_key: p.run_key,
      report: { ...MOCK_PLAN_RUN.report, stages: MOCK_PLAN_RUN.report.stages.filter((s) => s.type !== "observe") },
    }];
    installFetch();
    renderCompare();
    await screen.findByTestId(`analysis-adopt-row-${KEY_0820}-0`);
    await waitFor(() => expect(screen.queryByTestId("plan-compare-loading")).toBeNull());
    // 阳性对照：这份归档确实没有 observe 明细（否则测的是别的原因）
    const cached = qc.getQueryData(["plan_run", RUN_KEY]) as PlanRunDetail;
    expect((cached.report?.stages ?? []).some((s) => s.type === "observe")).toBe(false);
    expect(screen.queryByTestId("analysis-generate")).toBeNull();
    expect(screen.queryByText("生成改进稿")).toBeNull();
    cleanup();

    // 没记被测 Agent 名（后端 propose_improvements 的必填入参）
    overrides.get_plan_run = (p) => [{
      event: "plan_run",
      ...(String(p.run_key) === PREV_RUN_KEY ? MOCK_PLAN_RUN_PREV : MOCK_PLAN_RUN),
      run_key: p.run_key, agent_name: "",
    }];
    installFetch();
    renderCompare(PREV_RUN_KEY, RUN_KEY);
    await screen.findByTestId(`analysis-adopt-row-${KEY_0820}-0`);
    await waitFor(() => expect(screen.queryByTestId("plan-compare-loading")).toBeNull());
    expect(screen.queryByTestId("analysis-generate")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mock 与后端同刑（三角钉）
// ---------------------------------------------------------------------------
describe("mock 同刑：列表行带 proposals / overview 是后端真形态", () => {
  it("权威：list_plan_runs 走 _run_from_item，它无条件写 proposals 与 overview 两键", () => {
    const at = planrunPy.indexOf("def list_plan_runs(");
    const body = planrunPy.slice(at, planrunPy.indexOf("\ndef ", at + 10));
    expect(body.length).toBeGreaterThan(50);
    expect(body).toContain("_run_from_item(i)");
    const rfi = planrunPy.slice(planrunPy.indexOf("def _run_from_item("),
                               planrunPy.indexOf("\ndef ", planrunPy.indexOf("def _run_from_item(") + 10));
    expect(rfi).toContain('"proposals": json.loads(item.get("proposals") or "[]")');
    expect(rfi).toContain('"overview": json.loads(item.get("overview") or "{}")');
    // adoption_note 的两个子键（_build_overview 写的）
    expect(planrunPy).toContain('overview["adoption_note"] = {');
    expect(planrunPy).toContain('"score_changes": notes');
  });

  it("桩：list_plan_runs 每行都有 proposals 数组（无处方的行是 []，不是缺键）；三行有种子", async () => {
    const frames = await framesOf({ action: "list_plan_runs", plan_id: PLAN_ID });
    const runs = frames[0].runs as { run_key: string; proposals?: unknown }[];
    expect(runs.length).toBe(PLAN_RUNS.length);
    for (const r of runs) expect(Array.isArray(r.proposals), `${r.run_key} 应带 proposals 数组`).toBe(true);
    const seeded = runs.filter((r) => (r.proposals as unknown[]).length > 0).map((r) => r.run_key).sort();
    expect(seeded).toEqual([PREV_RUN_KEY, RUN_KEY, KEY_0820].sort());
    // 键集就是 attach_proposal 的三键
    for (const p of runs.find((r) => r.run_key === RUN_KEY)!.proposals as Record<string, unknown>[]) {
      expect(Object.keys(p).sort()).toEqual(["adopted_at", "generated_at", "summary"]);
    }
  });

  it("桩：列表行与 detail 读同一个数组 —— 桩里采纳后 list_plan_runs 也是采纳态", async () => {
    const ok = await framesOf({ action: "set_proposal_adopted", run_key: PREV_RUN_KEY, index: 1, adopted: true });
    expect(ok[0].event).toBe("proposal_adopted");
    const runs = (await framesOf({ action: "list_plan_runs", plan_id: PLAN_ID }))[0].runs as
      { run_key: string; proposals: { adopted_at: string | null }[] }[];
    expect(runs.find((r) => r.run_key === PREV_RUN_KEY)!.proposals[1].adopted_at).toBeTruthy();
    const detail = (await framesOf({ action: "get_plan_run", run_key: PREV_RUN_KEY }))[0];
    expect((detail.proposals as { adopted_at: string | null }[])[1].adopted_at).toBeTruthy();
    // 复原（别的用例还要读未采纳态）
    await framesOf({ action: "set_proposal_adopted", run_key: PREV_RUN_KEY, index: 1, adopted: false });
  });

  it("夹具自洽：08-11 的 adoption_note 说的就是 08-09 那条已采纳处方", () => {
    const note = (MOCK_PLAN_RUN.overview as { adoption_note: { proposals: { summary: string }[] } }).adoption_note;
    expect(note.proposals[0].summary).toBe(MOCK_PLAN_RUN_PREV.proposals[0].summary);
    expect(MOCK_PLAN_RUN_PREV.proposals[0].adopted_at).toBeTruthy();
    // 综合报告分节夹具仍是后端四节标题
    expect(PLAN_RUN_DETAIL.synthesis_sections.map((s) => s.title))
      .toEqual(["整体趋势", "反复出现的问题", "改进采纳效果", "当前优先建议"]);
  });
});
