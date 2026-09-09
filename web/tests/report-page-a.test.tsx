// 运行报告独立页 · 变体 A「评估器优先」（批 report-redesign-a）。
//
// 夹具 = 桩里的纯线上评估 run（handlers.ts MOCK_PLAN_RUN_OBSERVE，形状照现网
// plan-69e514cf625f#20260904013117：4 会话 × 4 评估器 = 16 格，conciseness 0.125 唯一未过线，
// 会话 e5d8fb96 四项全部未过，5 条问题条目）；三环节同场的 MOCK_PLAN_RUN 钉 dataset / redteam
// 两种矩阵不崩。期望值一律从夹具现算（不手抄数字），锚点挑目标数据专属文本。
//
// 分数口径（CONTEXT.md「线上评估均分」词条 2026-09-03 修订）：决策看每个评估器过不过 0.70，
// hero 没有合成格；页面 DOM 里「均分」只以带限定词的形态出现（vocab-guard 同一条纪律的运行时钉）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReportPage from "../src/pages/report/ReportPage";
import {
  sseFrames, MOCK_PLAN_RUN, MOCK_PLAN_RUN_OBSERVE, OBSERVE_PLAN_RUNS, OBSERVE_RUN_KEY, PLAN_RUNS,
} from "../src/mocks/handlers";
import { SCORE_TARGET } from "../src/pages/plan/derive";
import { UNIT_WORD } from "../src/pages/plan/compare/derive";
import { unitOf } from "../src/pages/report/model";
import { matrixRowAnchor, shortSessionId } from "../src/pages/plan/reportRows";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import { expectProseGone } from "./prose";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};
let calls: Payload[] = [];

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [] }],
  list_plan_runs: (p) => [{
    event: "plan_runs", plan_id: p.plan_id,
    runs: p.plan_id === "plan-ddd666" ? OBSERVE_PLAN_RUNS : PLAN_RUNS,
  }],
  get_plan_run: (p) => [{
    event: "plan_run",
    ...(String(p.run_key) === OBSERVE_RUN_KEY ? MOCK_PLAN_RUN_OBSERVE : MOCK_PLAN_RUN),
    run_key: p.run_key,
  }],
  list_datasets: () => [{ event: "datasets", datasets: [] }],
  set_proposal_adopted: (p) => [{
    event: "proposal_adopted", run_key: p.run_key,
    proposal: { summary: "x", adopted_at: "2026-09-04 03:00 UTC" },
  }],
  adopt_run_advice: (p) => [{
    event: "advice_adopted", run_key: p.run_key, index: 0,
    proposal: { summary: String(p.fix).slice(0, 300), adopted_at: "2026-09-04 03:00 UTC" },
  }],
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

function renderPage(runKey: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReportPage id={runKey} />
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
  location.hash = `#/report/${encodeURIComponent(OBSERVE_RUN_KEY)}`;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- 夹具现算 ----
const OBS_STAGE = MOCK_PLAN_RUN_OBSERVE.report.stages[0];
const SESSIONS = OBS_STAGE.session_details;
const EVALUATORS = OBS_STAGE.evaluators;
const SUMMARY = OBS_STAGE.summary as Record<string, { mean_score: number; pass_rate: number }>;
const ISSUES = MOCK_PLAN_RUN_OBSERVE.synthesis_issues;
const f3 = (n: number) => n.toFixed(3);
/** 均分最低的评估器（结论一句的主语） */
const WORST = EVALUATORS.reduce((a, b) => (SUMMARY[a].mean_score <= SUMMARY[b].mean_score ? a : b));
/** 四项全部未过的会话 */
const ALL_FAIL = SESSIONS.find((s) => EVALUATORS.every((ev) => s.results[ev as keyof typeof s.results].passed === false))!;

/** 「均分」的运行时钉：DOM 文本里每个「均分」往前 8 字内必须贴着白名单限定词 */
function assertMeanQualified(text: string) {
  const prefixes = ["该评估器", "本环节", "线上评估", "评估器", "本会话"];
  let idx = text.indexOf("均分");
  let seen = 0;
  while (idx >= 0) {
    seen += 1;
    const before = text.slice(Math.max(0, idx - 8), idx).replace(/\s/g, "");
    expect(prefixes.some((p) => before.endsWith(p)), `裸「均分」：…${text.slice(Math.max(0, idx - 12), idx + 4)}…`).toBe(true);
    idx = text.indexOf("均分", idx + 2);
  }
  return seen;
}

async function openObserve() {
  renderPage(OBSERVE_RUN_KEY);
  // 锚点：目标数据专属（未过线评估器的 badge），不是「页面壳出现」那种门槛数据
  await screen.findByTestId(`report-tile-0-${WORST}-badge`);
  return screen.getByTestId("page-report");
}

describe("② 结论一句：最差评估器 + 该评估器均分 + 通过率 + 几个会话被判什么", () => {
  it("未过线 badge；主语是均分最低的评估器，数字与夹具摘要同数，标签是 judge 原话", async () => {
    await openObserve();
    const v = screen.getByTestId("report-verdict");
    expect(within(v).getByText("未过线")).toBeInTheDocument();
    const text = v.textContent ?? "";
    expect(text).toContain(`${WORST} 该评估器均分 ${f3(SUMMARY[WORST].mean_score)}`);
    expect(text).toContain(`通过 ${Math.round(SUMMARY[WORST].pass_rate * 100)}%`);
    const failing = SESSIONS.filter((s) => s.results[WORST as keyof typeof s.results].passed === false);
    expect(text).toContain(`${SESSIONS.length} 个会话里 ${failing.length} 个被判`);
    expect(text).toContain(failing[0].results[WORST as keyof typeof failing[0]["results"]].label);
    // 过线的三个报名字，区间是它们均分的 min–max
    const ok = EVALUATORS.filter((e) => e !== WORST).map((e) => SUMMARY[e].mean_score);
    expect(text).toContain(`${f3(Math.min(...ok))}–${f3(Math.max(...ok))} 过线`);
  });

  it("四项全部未过的会话：短 id 深链到矩阵行锚点（href 指向该行 id，点击高亮该行）", async () => {
    await openObserve();
    const a = screen.getByTestId("report-verdict-allfail");
    const anchor = matrixRowAnchor(0, ALL_FAIL.session_id);
    expect(a).toHaveAttribute("href", `#${anchor}`);
    expect(a).toHaveTextContent(shortSessionId(ALL_FAIL.session_id));
    expect(screen.getByTestId("report-verdict")).toHaveTextContent(`${EVALUATORS.length} 项全部未过`);
    fireEvent.click(a);
    const row = document.getElementById(anchor)!;
    expect(row).not.toBeNull();
    expect(row.className).toContain("is-target");
  });
});

describe("③ hero：四格、无合成格；「均分」只以带限定词形态出现", () => {
  it("四格 = 过线评估器 N/M · 会话 · 问题条目 · 成本（未定价 ⇒ — + tokens）；没有「合成」格", async () => {
    const page = await openObserve();
    const hero = screen.getByTestId("report-hero");
    expect(hero.textContent).not.toContain("合成");
    const under = EVALUATORS.filter((e) => SUMMARY[e].mean_score < SCORE_TARGET);
    expect(screen.getByTestId("report-hero-evaluators")).toHaveTextContent(`${EVALUATORS.length - under.length} / ${EVALUATORS.length}`);
    expect(screen.getByTestId("report-hero-evaluators-sub")).toHaveTextContent(`${under.join(" · ")} 未过线`);
    expect(screen.getByTestId("report-hero-rows")).toHaveTextContent(String(SESSIONS.length));
    expect(screen.getByTestId("report-hero-issues")).toHaveTextContent(String(ISSUES.length));
    const sp = ISSUES.filter((i) => i.fix_type === "SYSTEM_PROMPT_FIX").length;
    const ot = ISSUES.filter((i) => i.fix_type === "OTHERS").length;
    expect(screen.getByTestId("report-hero-issues-sub")).toHaveTextContent(`${sp} SYSTEM_PROMPT_FIX · ${ot} OTHERS`);
    // 成本：total_cost_usd 0 且模型未定价 ⇒ 「—」，副行 = 未定价 + 环节 tokens 合计
    expect(screen.getByTestId("report-hero-cost")).toHaveTextContent("—");
    expect(screen.getByTestId("report-hero-cost-sub")).toHaveTextContent(`模型未定价 · ${OBS_STAGE.metrics.tokens.total} tokens`);
    // 成本时延条：平均 / 最大时延 + 最大时延会话深链
    const perf = screen.getByTestId("report-perf");
    expect(perf).toHaveTextContent(`${OBS_STAGE.metrics.latency.max_s.toFixed(2)}s`);
    const slowest = SESSIONS.reduce((a, b) => (a.metrics.latency.max_s >= b.metrics.latency.max_s ? a : b));
    expect(screen.getByTestId("report-perf-slowest")).toHaveAttribute("href", `#${matrixRowAnchor(0, slowest.session_id)}`);
    // 「均分」运行时钉：整页 ≥ 5 处（4 tile + 环节均分小字），且全部带限定词
    const seen = assertMeanQualified(page.textContent ?? "");
    expect(seen).toBeGreaterThanOrEqual(5);
    // 合成均分只作次要小字，且带「本环节」限定词
    expect(screen.getByTestId("report-evaluators-0-stage-mean")).toHaveTextContent(`本环节均分 ${f3(OBS_STAGE.overall_mean)}`);
  });
});

describe("⑤ 评估器 tile：badge 与 0.70 口径一致", () => {
  it("每个评估器一张：均分 < 目标线 ⇒ 未过线，否则过线；通过率 · N/M；最差会话深链", async () => {
    await openObserve();
    for (const ev of EVALUATORS) {
      const s = SUMMARY[ev];
      expect(screen.getByTestId(`report-tile-0-${ev}-badge`)).toHaveTextContent(s.mean_score < SCORE_TARGET ? "未过线" : "过线");
      expect(screen.getByTestId(`report-tile-0-${ev}-mean`)).toHaveTextContent(`${f3(s.mean_score)}该评估器均分`);
      const passed = SESSIONS.filter((x) => x.results[ev as keyof typeof x.results].passed).length;
      expect(screen.getByTestId(`report-tile-0-${ev}-pass`)).toHaveTextContent(`${Math.round(s.pass_rate * 100)}% · ${passed}/${SESSIONS.length}`);
    }
    // helpfulness 的最差会话唯一（0.333）⇒ 短 id 深链；conciseness 三个并列 0.000 ⇒ 「3 个会话并列」
    const worstHelp = screen.getByTestId("report-tile-0-helpfulness-worst");
    expect(within(worstHelp).getByRole("link")).toHaveAttribute("href", `#${matrixRowAnchor(0, ALL_FAIL.session_id)}`);
    const zeros = SESSIONS.filter((x) => x.results.conciseness.score === 0).length;
    expect(screen.getByTestId("report-tile-0-conciseness-worst")).toHaveTextContent(`${zeros} 个会话并列 0.000`);
  });
});

describe("⑥ 会话 × 评估器 矩阵：16 格 + 点格展开", () => {
  it("行按后端原序（#1 = 第一条会话），格 = 分 + judge 标签，共 16 格", async () => {
    await openObserve();
    expect(screen.getByTestId("report-matrix-0-sub")).toHaveTextContent(`${SESSIONS.length} 个会话 · ${EVALUATORS.length} 个评估器 · ${SESSIONS.length * EVALUATORS.length} 格`);
    let cells = 0;
    SESSIONS.forEach((s, i) => {
      const row = screen.getByTestId(`report-row-0-${i}`);
      expect(row).toHaveAttribute("id", matrixRowAnchor(0, s.session_id));
      expect(row).toHaveTextContent(`#${i + 1}`);
      expect(screen.getByTestId(`report-row-0-${i}-sub`)).toHaveTextContent(`${shortSessionId(s.session_id)} · ${s.metrics.tokens.total} tokens · ${s.metrics.llm_calls.count} 次模型调用`);
      expect(screen.getByTestId(`report-row-0-${i}-lat`)).toHaveTextContent(`${s.metrics.latency.max_s.toFixed(2)}s`);
      for (const ev of EVALUATORS) {
        const r = s.results[ev as keyof typeof s.results];
        const cell = screen.getByTestId(`report-cell-0-${i}-${ev}`);
        expect(cell).toHaveTextContent(f3(r.score));
        expect(screen.getByTestId(`report-cell-0-${i}-${ev}-label`)).toHaveTextContent(r.label);
        expect(cell.querySelector(".dot")?.className).toContain(r.passed ? "good" : "warn");
        cells += 1;
      }
    });
    expect(cells).toBe(16);
    // 表头带该评估器均分，未过线列有 is-under 标
    expect(screen.getByTestId(`report-matrix-0-th-${WORST}`)).toHaveTextContent(f3(SUMMARY[WORST].mean_score));
    expect(screen.getByTestId(`report-matrix-0-th-${WORST}`).className).toContain("is-under");
  });

  it("点格：下方展开 reason 全文 + 用户输入 / 最终回复；再点收起；换格只开一格", async () => {
    await openObserve();
    const i = SESSIONS.indexOf(ALL_FAIL);
    const cell = screen.getByTestId(`report-cell-0-${i}-conciseness`);
    expect(screen.queryByTestId(`report-cell-0-${i}-conciseness-detail`)).toBeNull();
    fireEvent.click(cell);
    const detail = await screen.findByTestId(`report-cell-0-${i}-conciseness-detail`);
    expect(cell).toHaveAttribute("aria-expanded", "true");
    const reason = ALL_FAIL.results.conciseness.reason;
    expect(within(detail).getByTestId(`report-cell-0-${i}-conciseness-detail-reason`)).toHaveTextContent(reason.slice(0, 40));
    expect(within(detail).getByTestId(`report-cell-0-${i}-conciseness-detail-label`)).toHaveTextContent(ALL_FAIL.results.conciseness.label);
    // 右侧原文：transcript 的用户输入与最终回复
    const user = ALL_FAIL.transcript.events.find((e) => e.type === "user")!.text;
    const reply = ALL_FAIL.transcript.events.find((e) => e.type === "assistant")!.text;
    expect(within(detail).getByTestId(`report-cell-0-${i}-conciseness-detail-prompt`)).toHaveTextContent(user);
    expect(within(detail).getByTestId(`report-cell-0-${i}-conciseness-detail-reply`).textContent).toBe(reply);
    // 长 reason 默认钳 2 行，「展开」切成全文态
    const toggle = within(detail).getByTestId(`report-cell-0-${i}-conciseness-detail-reason-toggle`);
    expect(toggle).toHaveTextContent("展开");
    fireEvent.click(toggle);
    expect(within(detail).getByTestId(`report-cell-0-${i}-conciseness-detail-reason`).className).toContain("is-open");
    expect(toggle).toHaveTextContent("收起");
    // 再点同一格 ⇒ 收起
    fireEvent.click(cell);
    await waitFor(() => expect(screen.queryByTestId(`report-cell-0-${i}-conciseness-detail`)).toBeNull());
    expect(cell).toHaveAttribute("aria-expanded", "false");
    // 开 A 再开 B ⇒ 只剩 B（同一时刻只开一格）
    fireEvent.click(cell);
    await screen.findByTestId(`report-cell-0-${i}-conciseness-detail`);
    fireEvent.click(screen.getByTestId("report-cell-0-0-helpfulness"));
    await screen.findByTestId("report-cell-0-0-helpfulness-detail");
    expect(screen.queryByTestId(`report-cell-0-${i}-conciseness-detail`)).toBeNull();
    expect(document.querySelectorAll("tr.rpg-detail").length).toBe(1);
  });
});

describe("⑦ 问题条目：复用 IssueLedger；证据深链指向矩阵行锚点", () => {
  it("5 行、卡头「问题条目」、证据是 <a href=#行锚点>、来源评估器 chip；「其他建议」组不出", async () => {
    await openObserve();
    const ledger = screen.getByTestId("agent-issue-ledger");
    expect(within(ledger).getByText("问题条目")).toBeInTheDocument();
    for (const it of ISSUES) {
      const row = screen.getByTestId(`agent-issue-${it.id}`);
      expect(row).toHaveTextContent(it.problem.slice(0, 20));
      expect(within(row).getByTestId(`agent-issue-${it.id}-fix`)).toHaveTextContent(it.recommendation.slice(0, 16));
      const ev = within(row).getAllByTestId(`agent-issue-${it.id}-evidence`)[0];
      expect(ev.tagName).toBe("A");
      // href 是路由器认得的本页 ?row= 深链（裸行锚点 #rp-row-… 在真浏览器里会被 parseHash 认成首页）
      expect(ev).toHaveAttribute("href", `#/report/${encodeURIComponent(OBSERVE_RUN_KEY)}?row=${encodeURIComponent(it.evidence[0].ref)}`);
      expect(document.getElementById(matrixRowAnchor(0, it.evidence[0].ref))).not.toBeNull();
      expect(within(row).getAllByTestId(`agent-issue-${it.id}-evaluator`).map((c) => c.textContent)).toEqual(it.evaluators);
      expect(within(row).getByTestId(`agent-issue-${it.id}-adopt-btn`)).toHaveTextContent("采纳");
    }
    expect(screen.queryByTestId("agent-ledger-group-others")).toBeNull();
    // 点证据 ⇒ 矩阵行高亮（页内跳转，不改路由）
    const first = ISSUES[0];
    fireEvent.click(within(screen.getByTestId(`agent-issue-${first.id}`)).getAllByTestId(`agent-issue-${first.id}-evidence`)[0]);
    expect(document.getElementById(matrixRowAnchor(0, first.evidence[0].ref))!.className).toContain("is-target");
    expect(location.hash).toBe(`#/report/${encodeURIComponent(OBSERVE_RUN_KEY)}`);
  });

  it("采纳对回：proposals[].summary 等于 recommendation_source（英文原话）也算命中 ⇒ 走 set_proposal_adopted 不走 adopt_run_advice", async () => {
    const target = ISSUES[1];
    expect(target.recommendation_source).not.toBe(target.recommendation); // 两把钥匙确实不同
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: [{
        ...OBSERVE_PLAN_RUNS[0],
        proposals: [{ summary: target.recommendation_source, generated_at: "2026-09-04 02:00 UTC", adopted_at: null }],
      }],
    }];
    await openObserve();
    const row = await screen.findByTestId(`agent-issue-${target.id}`);
    fireEvent.click(within(row).getByTestId(`agent-issue-${target.id}-adopt-btn`));
    await waitFor(() => expect(calls.some((c) => c.action === "set_proposal_adopted")).toBe(true));
    const call = calls.find((c) => c.action === "set_proposal_adopted")!;
    expect(call.run_key).toBe(OBSERVE_RUN_KEY);
    expect(call.index).toBe(0);
    expect(calls.some((c) => c.action === "adopt_run_advice")).toBe(false);
    // 反向：没有对得上的 proposal 时走 adopt_run_advice（带 recommendation 译文）
    cleanup();
    calls = [];
    overrides = {};
    await openObserve();
    const other = ISSUES[0];
    fireEvent.click(within(screen.getByTestId(`agent-issue-${other.id}`)).getByTestId(`agent-issue-${other.id}-adopt-btn`));
    await waitFor(() => expect(calls.some((c) => c.action === "adopt_run_advice")).toBe(true));
    expect(calls.find((c) => c.action === "adopt_run_advice")!.fix).toBe(other.recommendation);
  });

  it("已采纳的历史英文记录（summary = recommendation_source，带 adopted_at）直接显示已采纳", async () => {
    const target = ISSUES[2];
    overrides.list_plan_runs = (p) => [{
      event: "plan_runs", plan_id: p.plan_id,
      runs: [{
        ...OBSERVE_PLAN_RUNS[0],
        proposals: [{ summary: target.recommendation_source, generated_at: "2026-09-04 02:00 UTC", adopted_at: "2026-09-04 02:30 UTC" }],
      }],
    }];
    await openObserve();
    const row = await screen.findByTestId(`agent-issue-${target.id}`);
    expect(within(row).getByTestId(`agent-issue-${target.id}-adopt`)).toHaveTextContent("已采纳");
    expect(within(row).getByTestId(`agent-issue-${target.id}-adopt`)).toHaveTextContent("2026-09-04 02:30 UTC");
  });
});

describe("三环节同场（MOCK_PLAN_RUN）：dataset / redteam 各一张矩阵，不崩", () => {
  it("三张矩阵卡；红队列 = 策略·严重度 / 结果（攻破/守住/无有效结论）；回归行 = 用例", async () => {
    location.hash = `#/report/${encodeURIComponent(MOCK_PLAN_RUN.run_key)}`;
    renderPage(MOCK_PLAN_RUN.run_key);
    // 锚点：红队矩阵专属表头
    const rt = await screen.findByTestId("report-matrix-2");
    expect(within(rt).getByText("策略 · 严重度")).toBeInTheDocument();
    expect(within(rt).getByText("结果")).toBeInTheDocument();
    expect(screen.getByTestId("report-cell-2-0-result")).toHaveTextContent("攻破");
    expect(screen.getByTestId("report-cell-2-1-result")).toHaveTextContent("守住");
    expect(screen.getByTestId("report-cell-2-2-result")).toHaveTextContent("无有效结论");
    // 三态的「色点 class · 状态 class · 词」同源（breachView 一处映射）：格与展开后的详情头
    // 必须给同一档；null 那档色点留空（`dot ` 后面什么都不加）。
    const BREACH = [["bad", "fail", "攻破"], ["good", "pass", "守住"], ["", "none", "无有效结论"]] as const;
    for (const [n, [dot, state, text]] of BREACH.entries()) {
      const cell = screen.getByTestId(`report-cell-2-${n}-result`);
      expect(cell.querySelector(".dot")!.className).toBe(`dot ${dot}`);
      const badge = cell.querySelector(".rpg-breach")!;
      expect(badge.className).toBe(`rpg-breach is-${state}`);
      expect(badge).toHaveTextContent(text);
      fireEvent.click(cell);
      const head = (await screen.findByTestId(`report-cell-2-${n}-result-detail`)).querySelector(".rpg-breach")!;
      expect(head.className).toBe(`rpg-breach is-${state}`);
      expect(head).toHaveTextContent(text);
      fireEvent.click(cell);
    }
    // 点红队结果格：判定原话 + 攻击对话
    fireEvent.click(screen.getByTestId("report-cell-2-0-result"));
    const d = await screen.findByTestId("report-cell-2-0-result-detail");
    expect(within(d).getByTestId("report-cell-2-0-result-detail-conversation")).toHaveTextContent("【红队】");
    // 回归矩阵：行头「用例」，correctness 列有 0.900 / 0.500，空响应行带标记
    const ds = screen.getByTestId("report-matrix-1");
    expect(within(ds).getByText("用例")).toBeInTheDocument();
    expect(screen.getByTestId("report-cell-1-0-correctness")).toHaveTextContent("0.900");
    expect(screen.getByTestId("report-cell-1-1-correctness")).toHaveTextContent("0.500");
    expect(screen.getByTestId("report-row-1-2-note")).toHaveTextContent("空响应");
    // 单位名词只此一张表（plan/compare/derive.UNIT_WORD）：红队一个单位 = 用例 × 策略 ⇒ 「攻击用例」。
    // 这一页此前叫「攻击」、运行详情叫「用例」、对比页叫「攻击用例」，三处各一份表。
    expect(unitOf("redteam")).toBe(UNIT_WORD.redteam);
    expect(unitOf("redteam")).toBe("攻击用例");
    expect(within(rt).getByTestId("report-matrix-2-sub")).toHaveTextContent("3 个攻击用例");
    // hero 第二格按单位名词分档：攻击用例与回归用例不许并成一档（rowTally 按 unit 合并）
    expect(screen.getByTestId("report-hero-rows").querySelector(".kpi-label"))
      .toHaveTextContent("会话 · 用例 · 攻击用例");
    // observe 矩阵也在；三张卡头带环节名
    expect(screen.getByTestId("report-matrix-0")).toHaveTextContent("线上评估");
    expect(screen.getByTestId("report-matrix-1")).toHaveTextContent("回归测试");
    expect(screen.getByTestId("report-matrix-2")).toHaveTextContent("红队测试");
    // 结论一句：评估器全过线但红队被攻破 ⇒ 不许说成过线
    const v = screen.getByTestId("report-verdict");
    expect(within(v).getByText("被攻破")).toBeInTheDocument();
    expect(screen.getByTestId("report-verdict-extras")).toHaveTextContent("红队被攻破 1/2");
    assertMeanQualified(screen.getByTestId("page-report").textContent ?? "");
  });
});

describe("旧结构不回流 + 页脚沿用", () => {
  it("「本次建议」段落标题不再出现（版面无 + title 无）；旧全量表 testid 不在", async () => {
    const page = await openObserve();
    expectProseGone(page, "本次建议");
    expect(screen.queryByTestId("report-table")).toBeNull();
    expect(screen.queryByTestId("report-drawer-head")).toBeNull();
    expect(screen.queryByTestId("report-drawer-close")).toBeNull();
  });

  it("页脚：导出可点、查看 trace 跳 #/run/<run_key>、单 run 时上一/下一 run 禁用", async () => {
    await openObserve();
    expect(screen.getByTestId("report-drawer-export")).not.toBeDisabled();
    expect(screen.getByTestId("report-drawer-prev")).toBeDisabled();
    expect(screen.getByTestId("report-drawer-next")).toBeDisabled();
    fireEvent.click(screen.getByTestId("report-drawer-trace"));
    expect(location.hash).toBe(`#/run/${encodeURIComponent(OBSERVE_RUN_KEY)}`);
  });
});
