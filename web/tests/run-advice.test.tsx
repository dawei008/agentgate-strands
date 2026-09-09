// 「本次建议」区（ADR-0014 §6，F2）：本次诊断根因的纯前端聚合 + 采纳。
//
// 三层钉：
//   ① 聚合纯函数（reportRows.adviceGroups）：按修法 strip 后全等去重合并、
//      引用数 = 覆盖的行数、组内引用数降序、空修法/无根因解释不产条目、
//      未知 fix_type 进「其他」、空组整组缺席；
//   ② 渲染（真夹具 MOCK_PLAN_RUN / MOCK_PLAN_RUN_PREV，与 report-verdict 同一
//      纪律 —— 内联夹具能全绿而界面从没显影过）：三组齐、引用 chip 点击展开
//      目标行、旧形状 run 整块缺席（含标题）、报告里不再挂 ImprovementBlock；
//   ③ 采纳（adopt_run_advice，本批新增的最小 additive action）：请求形状、
//      就地转「已采纳 · 时间」、失败原话钉在条目上、已落库的采纳跨会话对回、
//      mock 与后端同刑（三角钉 + callMock 真跑）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// 旧报告页壳（渲染共享视图 ReportView，抽屉正文）：独立页已换成变体 A，见 tests/legacyReportPage.tsx
import ReportPage from "./legacyReportPage";
import {
  adviceGroups, reportGroups, type ReportGroup, type ReportRow, type RowDiagnosis,
} from "../src/pages/plan/reportRows";
import {
  sseFrames, MOCK_ACCESS_TOKEN, MOCK_PLAN_RUN, MOCK_PLAN_RUN_PREV, PLAN_RUNS, PREV_RUN_KEY,
} from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import type { PlanRunDetail } from "../src/pages/plan/types";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

const planrunPy = readFileSync(resolve(process.cwd(), "../app/planrun.py"), "utf8");
const mainPy = readFileSync(resolve(process.cwd(), "../app/main.py"), "utf8");

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};
let calls: Payload[] = [];

const RUN_KEY = MOCK_PLAN_RUN.run_key;
// 夹具三条修法（handlers.ts 的诊断根因原话；改了夹具这里会红——刻意逐字）
const FIX_PROMPT =
  "在系统提示词中加入：改签工具超时后先做一次带退避的重试，"
  + "仍失败时给出改签工单入口而不是让用户「稍后再试」。";
const FIX_TOOL =
  "改写 rebook_flight 工具描述：仅在返回 success 时视为改签成功；"
  + "超时或报错时不得向用户宣称已改签。";
const FIX_KB = "在知识库补充「我的账户 → 安全设置 → 更换手机号」自助路径条目。";

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: PLAN_RUNS }],
  get_plan_run: (p) => [{
    event: "plan_run",
    ...(String(p.run_key) === PREV_RUN_KEY ? MOCK_PLAN_RUN_PREV : MOCK_PLAN_RUN),
    run_key: p.run_key,
  }],
  list_datasets: () => [{ event: "datasets", datasets: [] }],
  adopt_run_advice: (p) => [{
    event: "advice_adopted", run_key: p.run_key, index: 2,
    proposal: { summary: String(p.fix).slice(0, 300),
                generated_at: "2026-08-31 09:12 UTC",
                adopted_at: "2026-08-31 09:12 UTC",
                source: "run_advice", refs: p.refs },
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

let client: QueryClient;

async function openReport(runKey: string = RUN_KEY) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ReportPage id={runKey} />
    </QueryClientProvider>,
  );
  await screen.findByTestId("report-drawer-head");
  await waitFor(() =>
    expect(screen.queryByTestId("report-drawer-loading")).not.toBeInTheDocument());
}

/** 组内行下标按 data-row 现找（排序口径不抄第二份，与 report-verdict 同款） */
function rowIndexOf(gi: number, name: string): number {
  const rows = screen.getAllByTestId(new RegExp(`^report-row-${gi}-\\d+$`));
  const n = rows.findIndex((r) => r.getAttribute("data-row") === name);
  expect(n, `第 ${gi} 组里应有 ${name}`).toBeGreaterThanOrEqual(0);
  return n;
}

/** 走 mock handler 本身发一次请求（不复制常量——复制就会再漂移）。 */
async function callMock(payload: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const { handlers } = await import("../src/mocks/handlers");
  const apiHandler = handlers.find((h) =>
    String((h as { info?: { path?: unknown } }).info?.path ?? "").includes("/api/invoke"));
  expect(apiHandler, "mocks/handlers.ts 应有 /api/invoke 的 handler").toBeTruthy();
  const res = await (apiHandler as unknown as {
    run: (a: { request: Request }) => Promise<{ response?: Response }>;
  }).run({
    request: new Request("http://localhost/api/invoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-authorization": `Bearer ${MOCK_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    }),
  });
  const text = await res.response!.text();
  return text.split("\n\n").filter(Boolean)
    .map((f) => JSON.parse(f.replace(/^data: /, "")) as Record<string, unknown>);
}

beforeEach(() => {
  overrides = {};
  calls = [];
  resetConfigForTest();
  resetRunFlightForTest();
  location.hash = `#/report/${encodeURIComponent(RUN_KEY)}`;
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ① 聚合纯函数
// ---------------------------------------------------------------------------

/** 手造最小行/组（adviceGroups 的声明输入就是 ReportGroup[]）。 */
function rowOf(key: string, diagnosis: RowDiagnosis | null, name = key): ReportRow {
  return {
    key, kind: "case", name, sub: "", outcome: "fail", verdicts: [], breached: null,
    note: null, input: "", expected: "", output: "", conversation: "", reason: "",
    sessionIds: [], diagnosis,
  };
}
function groupOf(index: number, rows: ReportRow[], type = "dataset"): ReportGroup {
  return { index, type, stage: { type }, rows, failed: 0 };
}
function rc(fix: string, fixType = "SYSTEM_PROMPT_FIX", explanation = "根因说明。") {
  return { fix, fixType, explanation };
}

describe("adviceGroups：按修法去重合并 + fix_type 三组 + 引用数降序", () => {
  it("同一修法覆盖多行：合并成一条，引用数 = 行数，根因解释去重罗列（≤3）", () => {
    const g = adviceGroups([
      groupOf(0, [
        rowOf("a", { failures: [], rootCauses: [rc("修法一", "SYSTEM_PROMPT_FIX", "解释甲")] }),
        rowOf("b", { failures: [], rootCauses: [rc("修法一", "SYSTEM_PROMPT_FIX", "解释甲")] }),
      ]),
      groupOf(1, [
        rowOf("c", { failures: [], rootCauses: [
          rc("修法一", "SYSTEM_PROMPT_FIX", "解释乙"),
          rc("修法一", "SYSTEM_PROMPT_FIX", "解释丙"),
          rc("修法一", "SYSTEM_PROMPT_FIX", "解释丁"), // 第 4 条解释：封顶 3 被丢
        ] }),
      ]),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].fixType).toBe("SYSTEM_PROMPT_FIX");
    expect(g[0].entries).toHaveLength(1);
    const e = g[0].entries[0];
    // 同一行的多条同修法根因只记一次引用（引用数 = 行数 = 3，不是根因数 5）
    expect(e.refs.map((r) => `${r.groupIndex}:${r.rowKey}`)).toEqual(["0:a", "0:b", "1:c"]);
    expect(e.explanations).toEqual(["解释甲", "解释乙", "解释丙"]);
  });

  it("空修法 / 无根因解释（旧形状）的根因不产条目；全空 → 空数组（区整块缺席的根）", () => {
    const g = adviceGroups([groupOf(0, [
      rowOf("a", { failures: [], rootCauses: [
        rc("", "SYSTEM_PROMPT_FIX"),          // 空修法：无可采纳动作
        rc("修法一", "SYSTEM_PROMPT_FIX", ""), // 旧形状：无 root_cause_explanation
      ] }),
      rowOf("b", null), // 红队行 / 无诊断
    ])]);
    expect(g).toEqual([]);
  });

  it("fix_type 未知值与空串进「其他」组，badge 原词保留；组序固定、空组缺席", () => {
    const g = adviceGroups([groupOf(0, [
      rowOf("a", { failures: [], rootCauses: [rc("修工具", "TOOL_DESCRIPTION_FIX")] }),
      rowOf("b", { failures: [], rootCauses: [rc("怪修法", "SOMETHING_NEW")] }),
    ])]);
    // 没有 SYSTEM_PROMPT_FIX 条目 → 那一组整组缺席，不是空组占位
    expect(g.map((x) => x.fixType)).toEqual(["TOOL_DESCRIPTION_FIX", "OTHERS"]);
    expect(g[0].label).toBe("改工具描述");
    expect(g[1].label).toBe("其他");
    expect(g[1].entries[0].fixType).toBe("SOMETHING_NEW"); // 原词不改写
  });

  it("组内按引用行数降序，平局保持首见序", () => {
    const g = adviceGroups([groupOf(0, [
      rowOf("a", { failures: [], rootCauses: [rc("先见但只一行")] }),
      rowOf("b", { failures: [], rootCauses: [rc("覆盖两行"), rc("平局同一行数")] }),
      rowOf("c", { failures: [], rootCauses: [rc("覆盖两行")] }),
    ])]);
    expect(g[0].entries.map((e) => e.fix))
      .toEqual(["覆盖两行", "先见但只一行", "平局同一行数"]);
  });

  it("strip 后全等去重（规则照 SDK recommendations）：真夹具管线里 fix 已 trim", () => {
    // 组装路径走 reportGroups（diagnosisOf 负责 trim）——聚合端不再各 trim 一遍
    const detail = {
      run_key: "k", status: "completed",
      stage_summaries: [{ type: "dataset", status: "completed", cases: 2 }],
      report: { stages: [{ type: "dataset", status: "completed", report: { results: [
        { case: "c1", results: { x: { score: 0.1, passed: false, errored: false } } ,
          diagnosis: { failures: [], root_causes: [{
            fix_type: "OTHERS", root_cause_explanation: "解释",
            fix_recommendation: "  补条目。\n" }] } },
        { case: "c2", results: { x: { score: 0.2, passed: false, errored: false } },
          diagnosis: { failures: [], root_causes: [{
            fix_type: "OTHERS", root_cause_explanation: "解释",
            fix_recommendation: "补条目。" }] } },
      ] } }] },
    } as unknown as PlanRunDetail;
    const g = adviceGroups(reportGroups(detail));
    expect(g).toHaveLength(1);
    expect(g[0].entries).toHaveLength(1);
    expect(g[0].entries[0].fix).toBe("补条目。");
    expect(g[0].entries[0].refs).toHaveLength(2);
  });

  it("真夹具（MOCK_PLAN_RUN）：三种 fix_type 各一条，引用落在产它的那一行", () => {
    const g = adviceGroups(reportGroups(MOCK_PLAN_RUN as unknown as PlanRunDetail));
    expect(g.map((x) => x.fixType))
      .toEqual(["SYSTEM_PROMPT_FIX", "TOOL_DESCRIPTION_FIX", "OTHERS"]);
    expect(g[0].entries.map((e) => e.fix)).toEqual([FIX_PROMPT]);
    expect(g[1].entries.map((e) => e.fix)).toEqual([FIX_TOOL]);
    expect(g[2].entries.map((e) => e.fix)).toEqual([FIX_KB]);
    expect(g[0].entries[0].refs).toEqual([
      { groupIndex: 0, rowKey: expect.stringContaining("sess-a41f9c2b"), rowName: "sess-a41f9c2b" },
    ]);
    expect(g[2].entries[0].refs[0].rowName).toBe("case-2");
  });

  it("旧形状真夹具（MOCK_PLAN_RUN_PREV）：无 root_cause_explanation → 零条目", () => {
    // 夹具锚点：旧形状的根因**有**修法、没有解释（三键剥离只剥 explanation）——
    // 缺席的成因是「无根因理由」，不是「没有根因」
    const prevObserve = MOCK_PLAN_RUN_PREV.report.stages.find((s) => s.type === "observe")!;
    const sd = (prevObserve as { session_details?: Record<string, unknown>[] }).session_details!;
    const rcs = (sd[0].diagnosis as { root_causes: Record<string, unknown>[] }).root_causes;
    expect(rcs.length).toBeGreaterThan(0);
    expect(String(rcs[0].fix_recommendation ?? "")).not.toBe("");
    expect(Object.keys(rcs[0])).not.toContain("root_cause_explanation");
    expect(adviceGroups(reportGroups(MOCK_PLAN_RUN_PREV as unknown as PlanRunDetail)))
      .toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ② 渲染：三组 + 引用跳转 + 旧形状缺席 + 旧改进处方区不再挂
// ---------------------------------------------------------------------------
describe("本次建议区渲染（真夹具）", () => {
  it("三组齐：每条 = 修法主体 + fix_type badge 原词 + 根因小字 + 引用 chip", async () => {
    await openReport();
    const sec = screen.getByTestId("run-advice");
    expect(sec).toHaveTextContent("本次建议");
    expect(within(sec).getByTestId("run-advice-group-SYSTEM_PROMPT_FIX"))
      .toHaveTextContent("改系统提示词");
    expect(within(sec).getByTestId("run-advice-group-TOOL_DESCRIPTION_FIX"))
      .toHaveTextContent("改工具描述");
    expect(within(sec).getByTestId("run-advice-group-OTHERS")).toHaveTextContent("其他");
    const e0 = within(sec).getByTestId("run-advice-SYSTEM_PROMPT_FIX-0");
    expect(within(e0).getByTestId("run-advice-SYSTEM_PROMPT_FIX-0-fix"))
      .toHaveTextContent("改签工具超时后先做一次带退避的重试");
    expect(e0).toHaveTextContent("SYSTEM_PROMPT_FIX");
    expect(within(e0).getByTestId("run-advice-SYSTEM_PROMPT_FIX-0-why-0"))
      .toHaveTextContent("没有重试也没有给出替代路径");
    // 引用 chip：环节展示名 + 行名（这一条来自线上评估的 sess-a41f9c2b）
    expect(within(e0).getByTestId("run-advice-SYSTEM_PROMPT_FIX-0-ref-0"))
      .toHaveTextContent("线上评估 · sess-a41f9c2b");
    expect(within(sec).getByTestId("run-advice-OTHERS-0-ref-0"))
      .toHaveTextContent("回归测试 · case-2");
    // 零通用散文：区内不挂任何 title（悬停解释也是散文的藏身处）
    expect(sec.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("引用 chip 点击：目标行展开（证据链显影），锚点挑目标行专属内容", async () => {
    await openReport();
    const n = rowIndexOf(1, "case-2");
    // 前置：目标行此刻是折叠的
    expect(screen.queryAllByTestId(`report-row-1-${n}-body`)).toHaveLength(0);
    fireEvent.click(screen.getByTestId("run-advice-OTHERS-0-ref-0"));
    const body = await screen.findByTestId(`report-row-1-${n}-body`);
    // 展开的确实是 case-2：它的判词原话（不是别的行也有的话）
    expect(body).toHaveTextContent("答非所问：未给出自助路径。");
    expect(screen.getByTestId(`report-row-1-${n}`)).toHaveClass("is-open");
  });

  it("旧形状 run：建议区整块缺席（含「本次建议」标题——空区块 = 废话）", async () => {
    await openReport(PREV_RUN_KEY);
    expect(screen.queryAllByTestId("run-advice")).toHaveLength(0);
    expect(screen.getByTestId("report-page-card").textContent).not.toContain("本次建议");
  });

  it("旧改进处方区不再挂在报告里（量词钉；组件保留待迁评估分析页）", async () => {
    await openReport();
    // 本夹具有已落库处方（MOCK_RUN_PROPOSALS）+ observe 环节 —— 旧挂载条件全满足，
    // 它仍不出现，钉的才是「挂载被替换」而不是「恰好没数据」
    expect(MOCK_PLAN_RUN.proposals.length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId("report-drawer-improve")).toHaveLength(0);
    expect(screen.queryAllByTestId(/^report-drawer-improve-history-\d+$/)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ③ 采纳（adopt_run_advice）
// ---------------------------------------------------------------------------
describe("采纳：修法原文 + 引用落成已采纳 proposal", () => {
  it("点采纳：请求带 run_key/fix/refs，就地转「已采纳 · 时间」，失效运行历史", async () => {
    await openReport();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(screen.getByTestId("run-advice-OTHERS-0-adopt"));
    await screen.findByTestId("run-advice-OTHERS-0-adopted");
    const sent = calls.find((c) => c.action === "adopt_run_advice")!;
    expect(sent).toMatchObject({ run_key: RUN_KEY, fix: FIX_KB });
    expect(sent.refs).toEqual(["回归测试 · case-2"]);
    expect(screen.getByTestId("run-advice-OTHERS-0-adopted"))
      .toHaveTextContent("已采纳 · 2026-08-31 09:12 UTC");
    // 采纳按钮换成状态（量词钉：这一条上不再有按钮），别的条目不连坐
    expect(screen.queryAllByTestId("run-advice-OTHERS-0-adopt")).toHaveLength(0);
    // 「别的条目不连坐」只在 onAdopt 走完才成立：RunAdvice.tsx:81 先把「已采纳」上屏
    // （上面 337 行的锚点），:85 才 await invalidateQueries，:89 的 finally 才清
    // adopting——窗口内 :119 的 disabled={adopting != null} 让**所有**采纳按钮都是
    // 禁用的，那是「一次只转一颗圈」的预期行为。锚点数据≠断言数据，所以这一条得
    // 自己等：waitFor 仍会因「永久禁用」超时转红，钉子没松。
    await waitFor(() =>
      expect(screen.getByTestId("run-advice-SYSTEM_PROMPT_FIX-0-adopt")).toBeEnabled());
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["plan_runs", MOCK_PLAN_RUN.plan_id],
    });
  });

  it("采纳失败：后端原话钉在这一条上，按钮回到可点", async () => {
    overrides.adopt_run_advice = () => [{ event: "error", error: "run 'x' 不存在" }];
    await openReport();
    fireEvent.click(screen.getByTestId("run-advice-OTHERS-0-adopt"));
    await waitFor(() => expect(screen.getByTestId("run-advice-OTHERS-0-adopt-error"))
      .toHaveTextContent("run 'x' 不存在"));
    expect(screen.getByTestId("run-advice-OTHERS-0-adopt")).toBeEnabled();
    expect(screen.queryAllByTestId("run-advice-OTHERS-0-adopted")).toHaveLength(0);
  });

  it("已落库的采纳跨会话对回：detail.proposals 里的 run_advice 条目直接显示已采纳", async () => {
    overrides.get_plan_run = (p) => [{
      event: "plan_run", ...MOCK_PLAN_RUN, run_key: p.run_key,
      proposals: [
        ...MOCK_PLAN_RUN.proposals,
        { summary: FIX_KB.slice(0, 300), generated_at: "2026-08-30 10:00 UTC",
          adopted_at: "2026-08-30 10:00 UTC", source: "run_advice",
          refs: ["回归测试 · case-2"] },
      ],
    }];
    await openReport();
    expect(screen.getByTestId("run-advice-OTHERS-0-adopted"))
      .toHaveTextContent("已采纳 · 2026-08-30 10:00 UTC");
    expect(screen.queryAllByTestId("run-advice-OTHERS-0-adopt")).toHaveLength(0);
    // 幂等键是 source+summary 双键：LLM 改进稿撞同名摘要不算（无 source）——
    // 别的条目照旧给按钮
    expect(screen.getByTestId("run-advice-SYSTEM_PROMPT_FIX-0-adopt")).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// mock 同刑（mock-parity 射不到新桩，自己补）+ 后端三角钉
// ---------------------------------------------------------------------------
describe("adopt_run_advice：mock 与后端同刑", () => {
  it("三角钉：后端分支/函数/错误原话都在源码里（行号会失指，钉符号）", () => {
    expect(mainPy).toContain('if action == "adopt_run_advice":');
    expect(mainPy).toContain('"event": "advice_adopted"');
    expect(planrunPy).toContain("def adopt_run_advice(");
    expect(planrunPy).toContain("采纳需要修法文本（fix 不能为空）");
    // 落库形状：summary 与 attach_proposal 同一套 300 字截断 + source/refs 两键
    expect(planrunPy).toContain('"source": "run_advice"');
    expect(planrunPy).toContain("summary = fix[:300]");
  });

  it("桩真跑：追加即已采纳、幂等（同修法二采返回同下标）、下标接在既有处方后", async () => {
    // 刻意用没被别的用例动过的 run（桩的 RUN_PROPOSALS 状态跨 callMock 保留；
    // improvement-proposals 的同刑用例占了 08-11 与 08-09，这里取 08-07）
    const row = PLAN_RUNS.find((r) => r.run_key.includes("2026-08-07"));
    expect(row, "夹具应有 08-07 那一行").toBeTruthy();
    const runKey = row!.run_key;
    // 播种数按桩自己的 list_plan_runs 现读（adr0014-migrate 批起，桩按运行历史那一
    // 行自带的处方播种：08-07 是跳过的 run，没有处方 ⇒ 0；此前对任意 key 都播
    // MOCK_PLAN_RUN 那两条，这里曾拿它的长度当期望）
    const listed = await callMock({ action: "list_plan_runs", plan_id: "plan-aaa111" });
    const seeded = (listed[0].runs as { run_key: string; proposals: unknown[] }[])
      .find((r) => r.run_key === runKey)!.proposals.length;
    const first = await callMock({ action: "adopt_run_advice", run_key: runKey,
                                   fix: `  ${FIX_KB}  `, refs: ["回归测试 · case-2"] });
    expect(first[0].event).toBe("advice_adopted");
    // 下标 = 播种的已落库处方数（追加在尾巴上，与真后端 attach 语义一致）
    expect(first[0].index).toBe(seeded);
    const p = first[0].proposal as Record<string, unknown>;
    expect(p.summary).toBe(FIX_KB.slice(0, 300)); // strip 后才截断
    expect(p.adopted_at).toBeTruthy();
    expect(p.source).toBe("run_advice");
    const again = await callMock({ action: "adopt_run_advice", run_key: runKey,
                                   fix: FIX_KB, refs: [] });
    expect(again[0].index).toBe(first[0].index); // 幂等：不追加第二条
  });

  it("空修法 / run 不存在：与后端同一句（空修法先于 run 校验）", async () => {
    const blank = await callMock({ action: "adopt_run_advice", run_key: "nope#1", fix: " " });
    expect(blank[0]).toEqual({ event: "error", error: "采纳需要修法文本（fix 不能为空）" });
    const missing = await callMock({ action: "adopt_run_advice", run_key: "nope#1", fix: FIX_KB });
    expect(String(missing[0].error)).toContain("不存在");
  });
});
