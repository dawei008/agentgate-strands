// Agent 详情 ③ 优化 = 评估器面板 + 问题台账（ADR-0016 分数口径修订 / 决定 1 ③，批 optimize-ledger，
// 版面契约 .scratch/adr0016-optimize/variant-a-rows.html）。
//
// 真夹具：src/mocks/handlers 的 DDD_PLAN_RUNS（plan-ddd444 三次 completed，最近一次 = AGENT_RUNS 里
// support-bot 最近一次 completed 的另一投影）+ 它上面的 synthesis_issues / proposals[].adoption_effect。
// list_plan_runs 走 harness 覆写直接回这份数组（不经 msw 桩的 runProposals 包装 —— 行上自带 proposals）。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DDD_PLAN_RUNS, MOCK_ACCESS_TOKEN, MOCK_PLAN_RUN, PLAN_RUN_DETAIL, PLAN_RUNS, handlers,
} from "../../src/mocks/handlers";
import AgentDetailPage from "../../src/pages/agents/AgentDetailPage";
import {
  evaluatorHeadline, evaluatorPanelRows, ledgerGroups, rowDelta, trendRunsAsc, versionChangeIndices,
} from "../../src/pages/agents/detail/hub/optimizeDerive";
import type { PlanRunSummary, SynthesisIssue } from "../../src/pages/plan/types";
import { renderPage, setupAgentsPageHooks, sseResponse, stubFetch, type Payload } from "./harness";

setupAgentsPageHooks();

const KEY_3 = "plan-ddd444#2026-08-21T05:00:00Z";
const KEY_2 = "plan-ddd444#2026-08-14T05:00:00Z";
const RUNS = DDD_PLAN_RUNS as unknown as PlanRunSummary[];
const ISSUES = RUNS[0].synthesis_issues as SynthesisIssue[];
const dddRuns = (rows: unknown[] = DDD_PLAN_RUNS) => (p: Payload) => sseResponse([{
  event: "plan_runs", plan_id: p.plan_id, runs: p.plan_id === "plan-ddd444" ? rows : [],
}]);
const ESTIMATE = (p: Payload) => sseResponse([{
  event: "plan_run_estimate", plan_id: p.plan_id, stages: [{ type: "dataset" }], estimated_cost_usd: 2.0,
}]);
const issueId = (id: string) => `agent-issue-${id}`;

async function openOptimize(overrides: Record<string, (p: Payload) => Response> = {}) {
  const calls = stubFetch({ list_plan_runs: dddRuns(), estimate_plan_run: ESTIMATE, ...overrides });
  renderPage(<AgentDetailPage name="support-bot" tab="optimize" />);
  // 锚点挑台账（它要 list_plan_runs 到；面板的本次分不等历史也能画 ⇒ 不能当门槛）
  const ledger = await screen.findByTestId("agent-issue-ledger");
  return { calls, ledger, panel: screen.getByTestId("agent-evaluator-panel") };
}

describe("夹具自洽：DDD_PLAN_RUNS 与契约 / 告警 / 另一投影对得上", () => {
  it("最近一次 = AGENT_RUNS 里 support-bot 最近一次 completed 的另一投影；三次 refusal = 告警的 0.61 / 0.58 / 0.55", () => {
    expect(RUNS.map((r) => r.run_key)).toEqual([KEY_3, KEY_2, "plan-ddd444#2026-08-07T05:00:00Z"]);
    const refusal = [...RUNS].reverse().map((r) => r.stage_summaries?.[0].evaluator_stats?.refusal.mean);
    expect(refusal).toEqual([0.61, 0.58, 0.55]);
  });

  it("台账 6 条覆盖四组；已采纳的 proposals 都带 adoption_effect、未采纳的没有；status 与 proposals 对回", () => {
    expect(ISSUES).toHaveLength(6);
    const g = ledgerGroups(ISSUES, KEY_3);
    expect(g.pending.map((i) => i.id)).toEqual(["a1f3c9d2"]);
    expect(g.open.map((i) => i.id)).toEqual(["7be04d11", "3f9a1c2e"]);
    expect(g.adopted.map((i) => i.id)).toEqual(["c0ffee42", "5e6f7a80"]);
    expect(g.resolved.map((i) => i.id)).toEqual(["9d2e4b77"]);
    for (const r of RUNS) {
      for (const p of r.proposals ?? []) {
        if (p.adopted_at) expect(p.adoption_effect?.verdict, String(p.summary)).toBeTruthy();
        else expect(p.adoption_effect).toBeUndefined();
      }
    }
    // resolved ⇔ 对回的 proposal verdict == improved
    const resolved = ISSUES.find((i) => i.id === "9d2e4b77")!;
    const hit = RUNS.flatMap((r) => r.proposals ?? []).find((p) => p.summary === resolved.recommendation)!;
    expect(hit.adoption_effect?.verdict).toBe("improved");
    // 每条 evaluators 都是数组（老形状读成 []，契约恒为数组）
    for (const it of ISSUES) expect(Array.isArray(it.evaluators)).toBe(true);
  });

  it("三角钉：后端有 _ISSUES_TOOL / synthesis_issues / adoption_effect；msw 桩 list_plan_runs 每行带 synthesis_issues（老计划是 []）", async () => {
    const py = readFileSync(resolve(process.cwd(), "../app/planrun.py"), "utf8");
    for (const w of ["_ISSUES_TOOL", "synthesis_issues", "adoption_effect"]) expect(py).toContain(w);
    const apiHandler = handlers.find((h) =>
      String((h as { info?: { path?: unknown } }).info?.path ?? "").includes("/api/invoke"))!;
    const call = async (plan_id: string) => {
      const res = await (apiHandler as unknown as {
        run: (a: { request: Request }) => Promise<{ response?: Response }>;
      }).run({
        request: new Request("http://localhost/api/invoke", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-authorization": `Bearer ${MOCK_ACCESS_TOKEN}` },
          body: JSON.stringify({ action: "list_plan_runs", plan_id }),
        }),
      });
      const text = await res.response!.text();
      return JSON.parse(text.split("\n\n").filter(Boolean)[0].replace(/^data: /, "")) as { runs: PlanRunSummary[] };
    };
    const ddd = await call("plan-ddd444");
    expect(ddd.runs.map((r) => r.run_key)).toEqual(RUNS.map((r) => r.run_key));
    expect(ddd.runs[0].synthesis_issues).toHaveLength(6);
    const aaa = await call("plan-aaa111");
    expect(aaa.runs.length).toBe(PLAN_RUNS.length);
    for (const r of aaa.runs) expect(r.synthesis_issues, r.run_key).toEqual([]);
  });
});

describe("派生：评估器行 / 头部一句话 / 较上一次 / 趋势取样", () => {
  it("未过置顶；头部只列未过项，不出现合成分；上一次缺同键 ⇒ 较上一次 null", () => {
    const rows = evaluatorPanelRows(RUNS[0], RUNS[1]);
    expect(rows.map((r) => [r.name, r.pass])).toEqual([["refusal", false], ["correctness", true]]);
    expect(evaluatorHeadline(rows)).toBe("2 个评估器 · 1 过线 · refusal 0.55 未过");
    expect(rowDelta(rows[0])).toEqual({ dir: "down", text: "▼0.03" });
    expect(rowDelta(rows[1])).toEqual({ dir: "up", text: "▲0.02" });
    expect(rowDelta(evaluatorPanelRows(RUNS[0], null)[0])).toBeNull();
  });

  it("线上评估 summary + 红队一行：红队「拦截 a/b 未达」；全过写「全部过线」；一行都没有 ⇒ null", () => {
    const mixed = { stage_summaries: [
      { type: "observe", status: "completed", overall_mean: 0.8, sessions: 9,
        summary: { helpfulness: { mean_score: 0.81, pass_rate: 0.9 }, tone: { mean_score: 0.9, pass_rate: 1 } } },
      { type: "redteam", status: "completed", breached: 2, attacks: 12 },
    ] };
    const rows = evaluatorPanelRows(mixed, { stage_summaries: [
      { type: "redteam", status: "completed", breached: 3, attacks: 12 },
    ] });
    expect(rows.map((r) => r.key)).toEqual(["redteam:红队拦截", "observe:helpfulness", "observe:tone"]);
    expect(rows[0].redteam).toEqual({ blocked: 10, attacks: 12 });
    expect(rowDelta(rows[0])).toEqual({ dir: "up", text: "▲1" });
    expect(evaluatorHeadline(rows)).toBe("3 个评估器 · 2 过线 · 红队拦截 10/12 未达");
    const allPass = evaluatorPanelRows({ stage_summaries: [mixed.stage_summaries[0]] }, null);
    expect(evaluatorHeadline(allPass)).toBe("2 个评估器 · 全部过线");
    expect(evaluatorHeadline([])).toBeNull();
    // 半截环节（halted_cost）不出行
    expect(evaluatorPanelRows({ stage_summaries: [{ type: "dataset", status: "halted_cost",
      evaluators: ["a"], evaluator_stats: { a: { mean: 0.9, passed: 1, judged: 1 } } }] }, null)).toEqual([]);
  });

  it("趋势取到「这一次」为止的最近 8 次 completed（时间升序）；版本竖线落在 v1.2→v1.3 那一点", () => {
    const asc = trendRunsAsc(RUNS, KEY_3);
    expect(asc.map((r) => r.run_key)).toEqual([...RUNS].reverse().map((r) => r.run_key));
    expect(versionChangeIndices(asc)).toEqual([{ at: 2, label: "v1.3" }]);
    // 预选更早的一次：取样到它为止
    expect(trendRunsAsc(RUNS, KEY_2).map((r) => r.run_key)).toEqual([RUNS[2].run_key, KEY_2]);
  });
});

describe("评估器面板（行表）", () => {
  it("头部一句话 + 列头带 #N；refusal 未过置顶高亮，分 / ▲▼ / 目标线 badge / 小趋势齐；整卡无「均分」", async () => {
    const { panel } = await openOptimize();
    expect(within(panel).getByTestId("agent-evaluator-headline")).toHaveTextContent("2 个评估器 · 1 过线 · refusal 0.55 未过");
    const heads = within(panel).getAllByRole("columnheader").map((th) => th.textContent);
    expect(heads).toEqual(["评估器", "环节", "本次 #3", "较上一次 #2", "目标线", "趋势"]);
    const rows = within(panel).getAllByRole("button").filter((el) => el.tagName === "TR");
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "agent-evaluator-row-dataset:refusal", "agent-evaluator-row-dataset:correctness",
    ]);
    const refusal = rows[0];
    expect(refusal).toHaveClass("is-miss");
    expect(within(refusal).getByText("回归测试")).toHaveClass("kind", "regress");
    expect(within(refusal).getByTestId("agent-evaluator-row-dataset:refusal-score")).toHaveTextContent("0.55");
    expect(within(refusal).getByTestId("agent-evaluator-row-dataset:refusal-delta")).toHaveTextContent("▼0.03");
    expect(within(refusal).getByTestId("agent-evaluator-row-dataset:refusal-goal")).toHaveTextContent("未过目标线 0.70");
    expect(within(refusal).getByTestId("spark-trend")).toBeInTheDocument();
    expect(within(refusal).getByTestId("spark-trend-target")).toBeInTheDocument();
    expect(within(refusal).getAllByTestId("spark-trend-version")).toHaveLength(1);
    const correctness = rows[1];
    expect(correctness).not.toHaveClass("is-miss");
    expect(within(correctness).getByTestId("agent-evaluator-row-dataset:correctness-delta")).toHaveTextContent("▲0.02");
    expect(within(correctness).getByTestId("agent-evaluator-row-dataset:correctness-goal")).toHaveTextContent("过目标线 0.70");
    expect(within(panel).getByTestId("agent-evaluator-legend")).toHaveTextContent("近 3 次 #1–#3 · 版本 v1.3 起于 #3");
    expect(panel.textContent).not.toContain("均分");
  });

  it("只有一次 completed run：上一次「—」、较上一次「—」、趋势格「—」、无取样说明", async () => {
    stubFetch({ list_plan_runs: dddRuns([DDD_PLAN_RUNS[0]]), estimate_plan_run: ESTIMATE });
    renderPage(<AgentDetailPage name="support-bot" tab="optimize" />);
    const ledger = await screen.findByTestId("agent-issue-ledger");
    expect(ledger).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("agent-optimize-prev")).toHaveTextContent("上一次—"));
    const panel = screen.getByTestId("agent-evaluator-panel");
    expect(within(panel).getByTestId("agent-evaluator-row-dataset:refusal-delta")).toHaveTextContent("—");
    expect(within(panel).queryByTestId("spark-trend")).toBeNull();
    expect(within(panel).queryByTestId("agent-evaluator-legend")).toBeNull();
    // 列头不编号（这一次在只有一条的历史里是 #1；上一次没有）
    expect(within(panel).getAllByRole("columnheader").map((th) => th.textContent)).toContain("本次 #1");
    expect(within(panel).getAllByRole("columnheader").map((th) => th.textContent)).toContain("较上一次");
  });
});

describe("问题台账（五列表）", () => {
  it("卡头 6 条 · 3 条待处理；四组按序，已解决折叠可展开；表头五列", async () => {
    const { ledger } = await openOptimize();
    expect(within(ledger).getByTestId("agent-ledger-sub")).toHaveTextContent("6 条 · 3 条待处理");
    expect(within(ledger).getAllByRole("columnheader").map((th) => th.textContent))
      .toEqual(["问题", "根因", "建议", "采纳", "效果"]);
    const groups = ["pending", "open", "adopted", "resolved"].map((g) => within(ledger).getByTestId(`agent-ledger-group-${g}`));
    expect(groups.map((g) => g.textContent)).toEqual(["待建议1", "未采纳2", "已采纳待验证2", "已解决1展开 1 条"]);
    // 行顺序：a1f3c9d2 → 7be04d11（本次新增排前）→ 3f9a1c2e → c0ffee42 → 5e6f7a80；已解决折叠中
    const ids = within(ledger).getAllByTestId(/^agent-issue-[0-9a-f]{8}$/).map((tr) => tr.getAttribute("data-testid"));
    expect(ids).toEqual(["a1f3c9d2", "7be04d11", "3f9a1c2e", "c0ffee42", "5e6f7a80"].map(issueId));
    fireEvent.click(within(ledger).getByTestId("agent-ledger-toggle-resolved"));
    expect(within(ledger).getByTestId(issueId("9d2e4b77"))).toBeInTheDocument();
    expect(within(ledger).getByTestId("agent-ledger-toggle-resolved")).toHaveTextContent("收起");
    // 「其他建议」组：这份夹具的处方都对回了台账 ⇒ 不出现
    expect(within(ledger).queryByTestId("agent-ledger-group-others")).toBeNull();
    // Tab ③ 小字与卡头同一个数（有台账时数待处理，不再数 proposals 未采纳 —— 那会印成「0 未采纳」）
    await waitFor(() => expect(screen.getByTestId("agent-tab-optimize-sum")).toHaveTextContent("3 待处理"));
  });

  it("待建议行：轮次「自 #1 持续 · 3 次」、证据 chip、来源 chip、根因；建议 / 采纳 / 效果格「—」（这一次没有可依据的会话 ⇒ 无生成入口）", async () => {
    const { ledger } = await openOptimize();
    const row = within(ledger).getByTestId(issueId("a1f3c9d2"));
    expect(within(row).getByTestId(`${issueId("a1f3c9d2")}-round`)).toHaveTextContent("自 #1 持续 · 3 次");
    expect(within(row).getAllByTestId(`${issueId("a1f3c9d2")}-evidence`).map((b) => b.textContent)).toEqual(["case-4", "case-7", "case-9"]);
    expect(within(row).getAllByTestId(`${issueId("a1f3c9d2")}-evaluator`).map((b) => b.textContent)).toEqual(["refusal"]);
    expect(row).toHaveTextContent("拒答分支只覆盖了显式违规请求");
    expect(within(row).getByTestId(`${issueId("a1f3c9d2")}-fix`)).toHaveTextContent("—");
    expect(within(row).queryByTestId(`${issueId("a1f3c9d2")}-generate`)).toBeNull();
    expect(within(row).getByTestId(`${issueId("a1f3c9d2")}-adopt`)).toHaveTextContent("—");
    expect(within(row).getByTestId(`${issueId("a1f3c9d2")}-effect`)).toHaveTextContent("—");
  });

  it("待建议行有可依据的会话 ⇒ 建议格「生成改进稿」，点了弹确认卡（依据本次 N 个会话）", async () => {
    const { ledger } = await openOptimize({
      get_plan_run: (p) => sseResponse([{ event: "plan_run", ...MOCK_PLAN_RUN, run_key: p.run_key, agent_name: "support-bot" }]),
    });
    const btn = await within(ledger).findByTestId(`${issueId("a1f3c9d2")}-generate`);
    expect(btn).toHaveTextContent("生成改进稿");
    // 卡头入口同在
    expect(within(ledger).getByTestId("agent-ledger-generate")).toBeInTheDocument();
    fireEvent.click(btn);
    const card = await screen.findByRole("dialog");
    expect(card).toHaveTextContent(/依据本次 run 的 \d+ 个会话，不重跑评估/);
  });

  it("未采纳行：本次新增 badge；建议带 fix_type 小标签；依赖 chip 指向那一行；采纳格「采纳」链", async () => {
    const { ledger } = await openOptimize();
    const fresh = within(ledger).getByTestId(issueId("7be04d11"));
    expect(within(fresh).getByTestId(`${issueId("7be04d11")}-round`)).toHaveTextContent("本次新增");
    expect(within(fresh).getByTestId(`${issueId("7be04d11")}-fix`)).toHaveTextContent("其他在知识库补充");
    expect(within(fresh).getByTestId(`${issueId("7be04d11")}-adopt-btn`)).toHaveTextContent("采纳");
    const dep = within(ledger).getByTestId(issueId("3f9a1c2e"));
    expect(within(dep).getByTestId(`${issueId("3f9a1c2e")}-round`)).toHaveTextContent("自 #2 持续 · 2 次");
    expect(within(dep).getByTestId(`${issueId("3f9a1c2e")}-fix`)).toHaveTextContent("改系统提示词在系统提示词中加入");
    const chip = within(dep).getByTestId(`${issueId("3f9a1c2e")}-dep-c0ffee42`);
    expect(chip.getAttribute("title")).toContain("query_order 缺 order_id");
    const target = within(ledger).getByTestId(issueId("c0ffee42"));
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    fireEvent.click(chip);
    expect(scrolled).toEqual([target]);
  });

  it("已采纳待验证：unchanged ⇒ 采纳格「已采纳 · 时刻 · v1.3 · run #3」、效果格「无效」+ 前后值 + 依赖 chip；pending ⇒ 「待 run #4 验证」", async () => {
    const { ledger } = await openOptimize();
    const un = within(ledger).getByTestId(issueId("c0ffee42"));
    const adopt = within(un).getByTestId(`${issueId("c0ffee42")}-adopt`);
    expect(adopt).toHaveTextContent("已采纳");
    expect(adopt).toHaveTextContent("2026-08-15 02:10 UTC");
    expect(within(un).getByTestId(`${issueId("c0ffee42")}-measured`)).toHaveTextContent("v1.3 · run #3");
    const eff = within(un).getByTestId(`${issueId("c0ffee42")}-effect`);
    expect(eff).toHaveTextContent("无效");
    expect(eff).toHaveTextContent("correctness 0.92 → 0.94");
    expect(eff).toHaveTextContent("case-1 fail → fail");
    expect(within(eff).getByTestId(`${issueId("c0ffee42")}-dep-3f9a1c2e`)).toBeInTheDocument();
    const pend = within(ledger).getByTestId(issueId("5e6f7a80"));
    expect(within(pend).getByTestId(`${issueId("5e6f7a80")}-effect`)).toHaveTextContent("待 run #4 验证");
    expect(within(pend).getByTestId(`${issueId("5e6f7a80")}-adopt`)).toHaveTextContent("2026-08-22 03:00 UTC");
    expect(within(pend).queryByTestId(`${issueId("5e6f7a80")}-measured`)).toBeNull();
  });

  // 「其他建议」行（计划各 run 里对不上台账的 proposals）此前零覆盖，而它的效果格与台账行
  // 是同一段四分支（现已收成 EffectCell 一个组件）。这条钉住两行的同源：improved 那格逐字同文。
  it("「其他建议」行的效果格 = 台账行同一个组件：improved 逐字同文 / inconclusive 带原话 / 未采纳「—」/ 无 adoption_effect 回落老形态效果句", async () => {
    const improved = RUNS.flatMap((r) => r.proposals ?? []).find((p) => p.adoption_effect?.verdict === "improved")!;
    const rows = structuredClone(DDD_PLAN_RUNS) as unknown as PlanRunSummary[];
    const SAME = "另册：与台账同效果的处方";
    const NOJUDGE = "另册：判不出的处方";
    const OPEN = "另册：还没采纳的处方";
    const LEGACY = "另册：老形态处方";
    rows[0].proposals = [...(rows[0].proposals ?? []), structuredClone(improved), {
      summary: NOJUDGE, generated_at: "2026-08-21 05:10 UTC", adopted_at: "2026-08-22 06:00 UTC",
      adoption_effect: { verdict: "inconclusive", reason: "上一次没有同名用例，无从对照" },
    }, {
      summary: OPEN, generated_at: "2026-08-21 05:10 UTC", adopted_at: "",
    }] as typeof rows[0]["proposals"];
    rows[0].proposals![rows[0].proposals!.length - 3].summary = SAME;
    // 老形态：#2 采纳的一条没有 adoption_effect，效果句住在 #3 的 overview.adoption_note
    rows[1].proposals = [...(rows[1].proposals ?? []), {
      summary: LEGACY, generated_at: "2026-08-14 05:10 UTC", adopted_at: "2026-08-15 01:00 UTC",
    }] as typeof rows[1]["proposals"];
    // overview 不在 PlanRunSummary 的类型面上（adoptionNoteOf 按 PlanRunDetail 读），照真形态挂上去
    (rows[0] as unknown as Record<string, unknown>).overview = {
      adoption_note: { proposals: [{ summary: LEGACY }], score_changes: ["correctness 0.80 → 0.90"] },
    };

    const otherId = (runIdx: number, summary: string) => {
      const i = rows[runIdx].proposals!.findIndex((p) => p.summary === summary);
      expect(i, summary).toBeGreaterThanOrEqual(0);
      return `agent-other-${rows[runIdx].run_key}-${i}`;
    };

    const { ledger } = await openOptimize({ list_plan_runs: dddRuns(rows) });
    const others = await within(ledger).findByTestId("agent-ledger-group-others");
    expect(others).toHaveTextContent("其他建议4");

    // improved：与台账「已解决」那行的效果格逐字同文（同一个 EffectCell 出来的）
    fireEvent.click(within(ledger).getByTestId("agent-ledger-toggle-resolved"));
    const ledgerEff = within(ledger).getByTestId(`${issueId("9d2e4b77")}-effect`);
    const sameEff = within(ledger).getByTestId(`${otherId(0, SAME)}-effect`);
    expect(sameEff.textContent).toBe(ledgerEff.textContent);
    expect(sameEff).toHaveTextContent("case-3 fail → pass");

    // inconclusive：「无法判定」+ 后端原话
    const noJudge = within(ledger).getByTestId(`${otherId(0, NOJUDGE)}-effect`);
    expect(noJudge).toHaveTextContent("无法判定");
    expect(noJudge).toHaveTextContent("上一次没有同名用例，无从对照");

    // 未采纳 ⇒ 没有效果可言：「—」，且采纳格是可点的「采纳」
    const open = within(ledger).getByTestId(`${otherId(0, OPEN)}-effect`);
    expect(open).toHaveTextContent("—");
    expect(within(ledger).getByTestId(`${otherId(0, OPEN)}-adopt-btn`)).toHaveTextContent("采纳");

    // 老形态（没有 adoption_effect）：回落到后一次 run 的 score_changes
    const legacy = within(ledger).getByTestId(`${otherId(1, LEGACY)}-effect`);
    expect(legacy).toHaveTextContent("correctness 0.80 → 0.90");
    expect(legacy.textContent).not.toContain("—");
  });

  it("已解决（展开后）：效果格写用例翻面 case-3 / case-6 fail → pass；采纳格带验证于 run #2", async () => {
    const { ledger } = await openOptimize();
    fireEvent.click(within(ledger).getByTestId("agent-ledger-toggle-resolved"));
    const row = within(ledger).getByTestId(issueId("9d2e4b77"));
    const eff = within(row).getByTestId(`${issueId("9d2e4b77")}-effect`);
    expect(eff).toHaveTextContent("case-3 fail → pass");
    expect(eff).toHaveTextContent("case-6 fail → pass");
    expect(within(row).getByTestId(`${issueId("9d2e4b77")}-measured`)).toHaveTextContent("v1.2 · run #2");
  });

  it("证据 chip → 这一次的运行报告", async () => {
    const { ledger } = await openOptimize();
    fireEvent.click(within(ledger).getAllByTestId(`${issueId("7be04d11")}-evidence`)[0]);
    expect(location.hash).toBe(`#/report/${encodeURIComponent(KEY_3)}`);
  });
});

describe("过滤：点面板行 / 来源 chip ⇒ 台账按评估器过滤", () => {
  it("点 refusal 行：行 aria-pressed、台账只剩 2 条、卡头过滤 chip + 清除；再点同一行 = 清除", async () => {
    const { ledger, panel } = await openOptimize();
    const row = within(panel).getByTestId("agent-evaluator-row-dataset:refusal");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-pressed", "true");
    expect(within(ledger).getByTestId("agent-ledger-filter")).toHaveTextContent("来源：refusal");
    expect(within(ledger).getByTestId("agent-ledger-sub")).toHaveTextContent("2 条");
    const ids = within(ledger).getAllByTestId(/^agent-issue-[0-9a-f]{8}$/).map((tr) => tr.getAttribute("data-testid"));
    expect(ids).toEqual([issueId("a1f3c9d2"), issueId("3f9a1c2e")]);
    // 过滤态下「其他建议」不出现；行内 refusal chip 也是按下态
    expect(within(ledger).getAllByTestId(`${issueId("a1f3c9d2")}-evaluator`)[0]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(ledger).getByTestId("agent-ledger-clear"));
    expect(within(ledger).getByTestId("agent-ledger-sub")).toHaveTextContent("6 条 · 3 条待处理");
    expect(row).toHaveAttribute("aria-pressed", "false");
    // 键盘：Enter 同点击
    fireEvent.keyDown(row, { key: "Enter" });
    expect(row).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-pressed", "false");
  });

  it("过滤到无关联问题的评估器：一行空态「<名> · run #3 无关联问题」", async () => {
    // 把 a1f3c9d2 / 3f9a1c2e 的 refusal 拿掉 ⇒ refusal 没有任何关联问题
    const rows = DDD_PLAN_RUNS.map((r, i) => (i === 0 ? {
      ...r, synthesis_issues: ISSUES.map((it) => ({ ...it, evaluators: it.evaluators.filter((e) => e !== "refusal") })),
    } : r));
    stubFetch({ list_plan_runs: dddRuns(rows), estimate_plan_run: ESTIMATE });
    renderPage(<AgentDetailPage name="support-bot" tab="optimize" />);
    const ledger = await screen.findByTestId("agent-issue-ledger");
    fireEvent.click(screen.getByTestId("agent-evaluator-row-dataset:refusal"));
    expect(within(ledger).getByTestId("agent-ledger-empty")).toHaveTextContent("refusal · run #3 无关联问题");
  });
});

describe("采纳：建议对回 proposals 走 set_proposal_adopted，没对上走 adopt_run_advice", () => {
  it("7be04d11 的建议没有 proposals 条目 ⇒ adopt_run_advice {run_key=这一次, fix, refs=环节 · 用例}；成功后行进已采纳组、效果「待 run #4 验证」", async () => {
    const { calls, ledger } = await openOptimize({
      adopt_run_advice: (p) => sseResponse([{
        event: "advice_adopted", run_key: p.run_key, index: 1,
        proposal: { summary: p.fix, generated_at: "2026-09-03 10:00 UTC", adopted_at: "2026-09-03 10:00 UTC", source: "run_advice", refs: p.refs },
      }]),
    });
    const row = within(ledger).getByTestId(issueId("7be04d11"));
    fireEvent.click(within(row).getByTestId(`${issueId("7be04d11")}-adopt-btn`));
    await waitFor(() => expect(within(ledger).getByTestId(`${issueId("7be04d11")}-adopt`)).toHaveTextContent("已采纳"));
    const sent = calls.filter((c) => c.action === "adopt_run_advice");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      run_key: KEY_3,
      fix: "在知识库补充「我的账户 → 安全设置 → 更换手机号」自助路径条目。",
      refs: ["回归测试 · case-2"],
    });
    expect(calls.filter((c) => c.action === "set_proposal_adopted")).toHaveLength(0);
    expect(within(ledger).getByTestId(`${issueId("7be04d11")}-adopt`)).toHaveTextContent("2026-09-03 10:00 UTC");
    expect(within(ledger).getByTestId(`${issueId("7be04d11")}-effect`)).toHaveTextContent("待 run #4 验证");
    expect(within(ledger).getByTestId(issueId("7be04d11"))).toHaveAttribute("data-group", "adopted");
    expect(within(ledger).getByTestId("agent-ledger-group-adopted")).toHaveTextContent("已采纳待验证3");
  });

  it("建议对回了一条未采纳的 proposal ⇒ set_proposal_adopted {run_key, index}（匹配键 = 建议文本 strip 全等）", async () => {
    const fix = ISSUES.find((i) => i.id === "7be04d11")!.recommendation!;
    const rows = DDD_PLAN_RUNS.map((r, i) => (i === 0 ? {
      ...r, proposals: [...r.proposals, { summary: fix, generated_at: "2026-08-21 06:00 UTC", adopted_at: null }],
    } : r));
    const calls = stubFetch({
      list_plan_runs: dddRuns(rows), estimate_plan_run: ESTIMATE,
      set_proposal_adopted: (p) => sseResponse([{
        event: "proposal_adopted", run_key: p.run_key,
        proposal: { summary: fix, generated_at: "2026-08-21 06:00 UTC", adopted_at: "2026-09-03 11:00 UTC" },
      }]),
    });
    renderPage(<AgentDetailPage name="support-bot" tab="optimize" />);
    const ledger = await screen.findByTestId("agent-issue-ledger");
    fireEvent.click(within(ledger).getByTestId(`${issueId("7be04d11")}-adopt-btn`));
    await waitFor(() => expect(within(ledger).getByTestId(`${issueId("7be04d11")}-adopt`)).toHaveTextContent("2026-09-03 11:00 UTC"));
    const sent = calls.filter((c) => c.action === "set_proposal_adopted");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ run_key: KEY_3, index: 1, adopted: true });
    expect(calls.filter((c) => c.action === "adopt_run_advice")).toHaveLength(0);
  });

  it("采纳失败：后端原话钉在该行下，链回到可点，别的行不连坐", async () => {
    const { ledger } = await openOptimize({
      adopt_run_advice: () => sseResponse([{ event: "error", error: "run 'x' 不存在" }]),
    });
    fireEvent.click(within(ledger).getByTestId(`${issueId("7be04d11")}-adopt-btn`));
    expect(await within(ledger).findByTestId(`${issueId("7be04d11")}-error`)).toHaveTextContent("run 'x' 不存在");
    expect(within(ledger).getByTestId(`${issueId("7be04d11")}-adopt-btn`)).toBeEnabled();
    expect(within(ledger).getByTestId(`${issueId("3f9a1c2e")}-adopt-btn`)).toBeEnabled();
  });
});

describe("回落：这一次 run 没有 synthesis_issues（老形状）", () => {
  it("台账不画；挂两段散文卡 + 采纳追踪，趋势卡不挂；面板照画；③ 里无「均分」", async () => {
    const rows = DDD_PLAN_RUNS.map((r) => ({ ...r, synthesis_issues: [] }));
    stubFetch({
      list_plan_runs: dddRuns(rows), estimate_plan_run: ESTIMATE,
      // 归档形态照 msw 桩的 get_plan_run：MOCK_PLAN_RUN + PLAN_RUN_DETAIL 的四节分节
      get_plan_run: (p) => sseResponse([{
        event: "plan_run", ...MOCK_PLAN_RUN, synthesis_sections: PLAN_RUN_DETAIL.synthesis_sections, run_key: p.run_key,
      }]),
    });
    renderPage(<AgentDetailPage name="support-bot" tab="optimize" />);
    const adoption = await screen.findByTestId("analysis-adoption");
    expect(adoption).toHaveTextContent("改写 query_order 工具描述");
    await screen.findByTestId("analysis-section-recurring");
    expect(screen.queryByTestId("agent-issue-ledger")).toBeNull();
    expect(screen.queryByTestId("analysis-trend")).toBeNull();
    expect(screen.getByTestId("agent-evaluator-panel")).toBeInTheDocument();
    expect(screen.getByTestId("agent-optimize").textContent).not.toContain("均分");
  });
});
