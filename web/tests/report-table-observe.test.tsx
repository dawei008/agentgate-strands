// 运行报告全量表 —— 线上评估环节的会话行（ADR-0014「一张表管三环节」的 observe 侧）。
//
// 前身是 observe-drilldown.test.tsx（旧「④ 环节明细」下钻）；旧结构随 ADR-0014
// 下线后按新结构重钉：一行 = 一个会话，证据链在展开态。用户原话「更重要的也要去
// 看每个评估器它的分数。以及产生的原因。」的落点仍是这一层。
//
// 数据来源同旧批（**后端一直在给**）——
//   · 逐会话判定（score/passed/errored/reason）在 report.stages[observe]
//     .session_details[].results（planrun.py:_run_observe_stage 的 details）；
//   · 逐评估器聚合在环节 summary（observe.py:summarize）；
//   · 环节分析直挂 stage.analysis，溯源引用是 `[session:完整会话ID]` /
//     `[session:完整会话ID#N]`（observe.py ANALYSIS_SYSTEM_PROMPT 强制）。
// 此前报告页只画 dataset 钻取块，observe 的这些字段一个都不上屏。
//
// 夹具形态照后端分支（不是照 mock 反推）：
//   · 正常支九键（agent/session_id/results/metrics/warning/no_content/
//     output_preview/transcript/diagnosis，planrun.py details 构造）；
//   · session_error 支**只有** {agent, session_id, error}；
//   · no_content 支：results 全 errored + warning 带原因（observe.py:111-132）；
//   · reason 的对象形态（{summary}）契约上合法（types.ts CaseVerdictRaw 注释），
//     消费方必须归一不许裸渲。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// 旧报告页壳（渲染共享视图 ReportView，抽屉正文）：独立页已换成变体 A，见 tests/legacyReportPage.tsx
import ReportPage from "./legacyReportPage";
import { reportDrilldowns, sessionRows } from "../src/pages/plan/derive";
import { buildReportMarkdown } from "../src/pages/plan/exportReport";
import { runOutcome } from "../src/lib/scoring";
import { sseFrames } from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import type { StageDetail, StageSummary } from "../src/pages/plan/types";

const CFG = { apiPath: "/mock-api", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

/** 现网会话 id 是 60 字上下的 mono 串 —— 行内引用的截断路径要有真长度才测得到 */
const SID_OK = "evaltest-20260829021500-4f9a1c2b7d3e";
const SID_ERR = "evaltest-20260829021530-deadbeef0001";
const SID_NOCONTENT = "evaltest-20260829021600-77aa88bb99cc";

/** session_details：三个后端分支各一条 */
const SESSIONS: Record<string, unknown>[] = [
  {
    agent: "support-bot",
    session_id: SID_OK,
    output_preview: "抱歉，改签暂时无法完成，请稍后再试。",
    results: {
      helpfulness: { score: 0.9, passed: true, errored: false, reason: "回答完整且给出下一步。" },
      // errored 判定：score/passed 是 null（「没评出来」，不是 0 分）
      coherence: { score: null, passed: null, errored: true, reason: "Evaluator error: judge 限流" },
      // reason 的对象形态：全仓唯一没有 str() 兜的 reason 赋值（app/main.py:151
      // 原样透传 SDK），换 judge 实现就能给对象 —— 消费方必须走 textOf 归一
      policy_adherence: {
        score: 0.8, passed: true, errored: false,
        reason: { summary: "未违反改签政策；转人工前已尝试自助路径。" },
      },
    },
    metrics: { tokens: { total: 8421 } },
    transcript: { events: [], system_prompt: null, truncated: false },
    diagnosis: { failures: [], root_causes: [] },
  },
  // session_error 支：只有这三个键，results/transcript/metrics 全缺
  { agent: "support-bot", session_id: SID_ERR, error: "trace 拉取失败：CloudWatch 查询超时" },
  {
    agent: "support-bot",
    session_id: SID_NOCONTENT,
    no_content: true,
    warning: "trace contains no message content; capture flag likely off",
    output_preview: "",
    results: {
      helpfulness: { score: null, passed: null, errored: true, reason: "no content to evaluate" },
    },
  },
];

/** 环节分析：节标题 + 两种引用形态（带 #N / 不带）+ 一条幽灵引用（judge 写错 id
 *  是 prompt 拦不住的，死链档必须有真素材） */
const OBSERVE_ANALYSIS = [
  "## 总体结论",
  "3 个会话 1 个评估成功、1 个拉取失败、1 个无内容可评；helpfulness 评估器均分 0.90。",
  "",
  "## 异常与关注点",
  `会话 [session:${SID_OK}#3] 的工具调用连续超时，是本次主要失败面。`,
  `[session:${SID_ERR}] trace 拉取失败，评估结论不成立。`,
  "另有历史会话 [session:ghost-session-000] 本次未纳入评估窗口。",
].join("\n");

/** DDB 摘要（planrun.py:_stage_summary 的 observe 分支）：summary 只剩
 *  mean_score/pass_rate 两键，sessions/errored 分母被剪掉 */
const DDB_OBSERVE = {
  type: "observe", status: "completed", overall_mean: 0.9, sessions: 3,
  summary: {
    helpfulness: { mean_score: 0.9, pass_rate: 1.0 },
    coherence: { mean_score: null, pass_rate: null },
  },
};

/** S3 全量报告体的 observe 环节（执行侧原物：summary 带 sessions/errored 分母） */
function observeStage(over: Record<string, unknown> = {}) {
  return {
    type: "observe", status: "completed", sessions: 3, overall_mean: 0.9,
    evaluators: ["helpfulness", "coherence", "policy_adherence"],
    summary: {
      helpfulness: { mean_score: 0.9, pass_rate: 1.0, sessions: 2, errored: 1 },
      coherence: { mean_score: null, pass_rate: null, sessions: 0, errored: 1 },
      policy_adherence: { mean_score: 0.8, pass_rate: 1.0, sessions: 1, errored: 0 },
    },
    analysis: OBSERVE_ANALYSIS,
    session_details: SESSIONS,
    ...over,
  };
}

// 同 run 里再放一个 dataset 环节：⑴ 钻取块的环节顺序要有两类同场才测得到；
// ⑵ dataset 分析里出现 [session:…] 字面量 = 「会话引用只在 observe 分析里生效」
// 的阴性对照素材。
const DATASET = "faq-regression-v3";
const DATASET_STAGE = {
  type: "dataset", status: "completed", run_id: "run-x", dataset: DATASET,
  cases: 1, pass_rate: 1.0,
  report: {
    run_id: "run-x", dataset: DATASET, status: "completed", total_cases: 1,
    analysis: `回归侧提到 [session:${SID_OK}] 只是转述，这里没有会话明细可跳。`,
    results: [{
      agent: "support-bot", case: "case-1", input: "退货政策？", output: "30 天。",
      results: { correctness: { score: 1.0, passed: true, errored: false, reason: "一致。" } },
    }],
  },
};

const DDB_DATASET = {
  type: "dataset", status: "completed", pass_rate: 1.0, cases: 1, blank_cases: 0,
  evaluators: ["correctness"],
  evaluator_stats: { correctness: { mean: 1.0, passed: 1, judged: 1 } },
};

const RUN_KEY = "plan-obs001#2026-08-29T02:00:00Z";
const RUNS = [{
  run_key: RUN_KEY, status: "completed", score: 0.9,
  started_at: "2026-08-29 02:00 UTC", duration_s: 88, triggered_by: "manual",
  stage_summaries: [DDB_OBSERVE, DDB_DATASET],
}];

function detail(over: Record<string, unknown> = {}) {
  return {
    event: "plan_run",
    run_key: RUN_KEY,
    plan_id: "plan-obs001",
    plan_name: "线上巡检",
    agent_name: "support-bot",
    status: "completed",
    score: 0.9,
    started_at: "2026-08-29 02:00 UTC",
    finished_at: "2026-08-29 02:01 UTC",
    duration_s: 88,
    triggered_by: "manual",
    total_cost_usd: 0.2,
    overview: { stage_lines: [], previous_run: null },
    stage_summaries: [DDB_OBSERVE, DDB_DATASET],
    s3_key: "planruns/plan-obs001/2026-08-29T02:00:00Z.json",
    plan_synthesis: "## 整体趋势\n稳定。",
    synthesis_sections: [{ title: "整体趋势", body: "稳定。" }],
    synthesis_error: null,
    report: {
      run_key: RUN_KEY,
      plan: { plan_id: "plan-obs001", name: "线上巡检", agent_name: "support-bot", stages: [] },
      started_at: "2026-08-29 02:00 UTC",
      duration_s: 88,
      stages: [observeStage(), DATASET_STAGE],
    },
    ...over,
  };
}

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: RUNS }],
  get_plan_run: (p) => [{ ...detail(), run_key: p.run_key }],
};

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}

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

function qc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

async function openReport() {
  render(
    <QueryClientProvider client={qc()}>
      <ReportPage id={RUN_KEY} />
    </QueryClientProvider>,
  );
  await screen.findByTestId("report-drawer-head");
  await waitFor(() =>
    expect(screen.queryByTestId("report-drawer-loading")).not.toBeInTheDocument());
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

// ---------- 派生层（纯函数） ----------

describe("sessionRows：三个后端分支各有各的形态", () => {
  const rows = sessionRows(observeStage() as StageDetail);

  it("正常支：判定齐活，errored 的 score/passed 归 null，对象 reason 走 textOf 取 summary", () => {
    expect(rows).toHaveLength(3);
    const ok = rows[0];
    expect(ok.id).toBe(SID_OK);
    expect(ok.agent).toBe("support-bot");
    expect(ok.note).toBeNull();
    expect(ok.output).toBe("抱歉，改签暂时无法完成，请稍后再试。");
    const byName = Object.fromEntries(ok.verdicts.map((v) => [v.name, v]));
    expect(byName.helpfulness).toMatchObject({ score: 0.9, passed: true, errored: false });
    expect(byName.coherence).toMatchObject({ score: null, passed: null, errored: true });
    expect(byName.policy_adherence.reason).toBe("未违反改签政策；转人工前已尝试自助路径。");
    // 归一必须真的发生了：对象直渲的降级形态一个字都不许出现
    expect(byName.policy_adherence.reason).not.toContain("未预期的结构");
  });

  it("session_error 支：note=拉取失败 + 后端原话，判定为空", () => {
    const err = rows[1];
    expect(err.id).toBe(SID_ERR);
    expect(err.note).toEqual({
      kind: "error", mark: "拉取失败", text: "trace 拉取失败：CloudWatch 查询超时",
    });
    expect(err.verdicts).toEqual([]);
  });

  it("no_content 支：note=无内容可评 + warning 原话；warning 缺失时 text 空着不编", () => {
    expect(rows[2].note).toEqual({
      kind: "no_content", mark: "无内容可评",
      text: "trace contains no message content; capture flag likely off",
    });
    const bare = sessionRows(observeStage({
      session_details: [{ agent: "a", session_id: "s-1", no_content: true }],
    }) as StageDetail);
    expect(bare[0].note).toEqual({ kind: "no_content", mark: "无内容可评", text: "" });
  });

  it("session_details 缺失 / 非数组 → 空数组（report_error 通路不崩）", () => {
    expect(sessionRows(observeStage({ session_details: null }) as StageDetail)).toEqual([]);
    expect(sessionRows(undefined)).toEqual([]);
  });
});

// reportDrilldowns 已不喂界面（ADR-0014 下线环节明细区），但仍喂**导出**
// Markdown 的明细节 —— 派生层的这几条保留，钉的是导出那条路的输入。
describe("reportDrilldowns（导出侧输入）：observe 与 dataset 各一块，红队不揽", () => {
  it("类型、下标、明细行各归各位", () => {
    const drills = reportDrilldowns(detail() as never);
    expect(drills.map((d) => [d.index, d.type])).toEqual([[0, "observe"], [1, "dataset"]]);
    expect(drills[0].sessions).toHaveLength(3);
    expect(drills[0].cases).toEqual([]);
    expect(drills[0].dataset).toBe("");
    expect(drills[1].cases).toHaveLength(1);
    expect(drills[1].sessions).toEqual([]);
  });

  it("observe 环节既无分析也无会话 → 不出块；红队环节永远不出块", () => {
    const d = detail({
      report: {
        ...detail().report as Record<string, unknown>,
        stages: [
          observeStage({ analysis: "", session_details: [] }),
          { type: "redteam", status: "completed", attacks: 3,
            report: { analysis: "红队解析。", results: [{ case_name: "x", breached: true }] } },
        ],
      },
    });
    expect(reportDrilldowns(d as never)).toEqual([]);
  });
});

// ---------- 报告页（组件）：会话行 ----------

describe("全量表：线上评估环节的会话行", () => {
  /** 行下标按 **data-row（session_id）** 现找，不写死 —— 组内排序是「失败/没跑成
   *  在前」，把下标写死等于把排序口径抄成第二份（改排序时这里会静默指向别的会话）。 */
  function rowIndexOf(sid: string): number {
    const rows = screen.getAllByTestId(/^report-row-0-\d+$/);
    const n = rows.findIndex((r) => r.getAttribute("data-row") === sid);
    expect(n, `表里应有会话 ${sid}`).toBeGreaterThanOrEqual(0);
    return n;
  }

  it("组头：环节名 + 聚合数（限定词「本环节均分」，裸「均分」禁用）", async () => {
    await openReport();
    const head = screen.getByTestId("report-group-0-head");
    expect(head).toHaveTextContent("线上评估");
    expect(head).toHaveTextContent("3 会话");
    expect(head).toHaveTextContent("本环节均分 0.90");
  });

  it("三行会话：折叠态 chip 带分数；errored 判定是「评估失败」不是 0", async () => {
    await openReport();
    expect(screen.getAllByTestId(/^report-row-0-\d+$/)).toHaveLength(3);
    // 正常支：折叠态 chip 就要能看出谁在拖分（分数在 chip 上）
    const n = rowIndexOf(SID_OK);
    const okChip = screen.getByTestId(`report-verdict-0-${n}-helpfulness`);
    expect(okChip).toHaveTextContent("helpfulness");
    expect(okChip).toHaveTextContent("0.90");
    const errChip = screen.getByTestId(`report-verdict-0-${n}-coherence`);
    expect(errChip).toHaveTextContent("评估失败");
    expect(errChip).not.toHaveTextContent("0.00");
  });

  it("三个后端分支的标记各归各位（词与实时会话清单、run 对比同源）", async () => {
    await openReport();
    // 拉取失败与无内容可评都算「没跑成」（none）→ 排在通过行之后
    const rows = screen.getAllByTestId(/^report-row-0-\d+$/);
    const byId = Object.fromEntries(rows.map((r) => [r.getAttribute("data-row"), r]));
    expect(byId[SID_OK]).toHaveClass("is-pass");
    expect(byId[SID_ERR]).toHaveClass("is-none");
    expect(within(byId[SID_ERR]!).getByTitle("trace 拉取失败：CloudWatch 查询超时"))
      .toHaveTextContent("拉取失败");
    expect(byId[SID_NOCONTENT]).toHaveTextContent("无内容可评");
  });

  it("展开会话行：判分理由全文 + 输出预览；对象 reason 已归一", async () => {
    await openReport();
    const n = rowIndexOf(SID_OK);
    // 展开前理由全文不在文档流里（title 属性不算 textContent）——锚点挑的是
    // 只有展开态才有的数据，不是两态都在的门槛数据
    expect(screen.queryByTestId(`report-row-0-${n}-reason-helpfulness`)).toBeNull();
    fireEvent.click(screen.getByTestId(`report-row-0-${n}-toggle`));
    const body = await screen.findByTestId(`report-row-0-${n}-body`);
    expect(within(body).getByTestId(`report-row-0-${n}-reason-helpfulness`))
      .toHaveTextContent("回答完整且给出下一步。");
    expect(within(body).getByTestId(`report-row-0-${n}-reason-policy_adherence`))
      .toHaveTextContent("未违反改签政策；转人工前已尝试自助路径。");
    expect(body).not.toHaveTextContent("未预期的结构");
    // errored 判定的理由位：中性话术，不是分数
    expect(within(body).getByText("评估失败（未产出判定）")).toBeInTheDocument();
    // 会话行没有「输入/期望输出」（它不是数据集的题），只有后端截的输出预览
    expect(within(body).getByTestId(`report-row-0-${n}-output`))
      .toHaveTextContent("抱歉，改签暂时无法完成，请稍后再试。");
    expect(within(body).queryByTestId(`report-row-0-${n}-input`)).toBeNull();
    expect(within(body).queryByTestId(`report-row-0-${n}-expected`)).toBeNull();
  });

  it("拉取失败的会话：展开后是后端原话，输出预览位是 EMPTY_MARK 不是空白", async () => {
    await openReport();
    const n = rowIndexOf(SID_ERR);
    fireEvent.click(screen.getByTestId(`report-row-0-${n}-toggle`));
    const body = await screen.findByTestId(`report-row-0-${n}-body`);
    expect(body).toHaveTextContent("trace 拉取失败：CloudWatch 查询超时");
    expect(within(body).getByTestId(`report-row-0-${n}-output`)).toHaveTextContent("—");
  });

  it("两个环节两个 tbody 组（一张表管三环节）：observe 在前、dataset 在后，同序于摘要", async () => {
    await openReport();
    expect(screen.getByTestId("report-group-0-head")).toHaveTextContent("线上评估");
    expect(screen.getByTestId("report-group-1-head")).toHaveTextContent("回归测试");
    // dataset 组的用例行也在同一张表里
    expect(screen.getByTestId("report-row-1-0")).toHaveAttribute("data-row", "case-1");
    expect(screen.getAllByTestId("report-table")).toHaveLength(1);
  });

  it("旧结构全下线：环节分析块 / 综合报告分节 / 环节明细区一个都不在", async () => {
    await openReport();
    // 这些 testid 是旧四部件的招牌，任何一个回来都说明结构退回去了
    for (const id of [
      "report-drawer-stages", "report-part-synthesis", "report-part-drills",
      "report-drawer-analysis-0", "report-drawer-sessions-0", "report-drawer-nav",
      "report-drawer-sec-0", "report-drawer-stage-0-evals",
    ]) {
      expect(screen.queryAllByTestId(id), id).toHaveLength(0);
    }
    // 环节分析原文（judge 长文）不再上屏——它仍原样进导出（见下方导出用例）
    const card = screen.getByTestId("report-page-card");
    expect(card.textContent).not.toContain("是本次主要失败面");
  });
});

// ---------- 导出（与屏幕同一份钻取数据） ----------

describe("导出 Markdown：observe 明细节", () => {
  it("环节分析 + 逐评估器表 + 未通过/未获判定的会话，三段都在", () => {
    const det = detail();
    const stages = det.stage_summaries as StageSummary[];
    const md = buildReportMarkdown({
      runKey: RUN_KEY, seq: 1, planId: "plan-obs001",
      detail: det as never, status: "completed", score: 0.9,
      outcome: runOutcome({ status: "completed", score: 0.9, stage_summaries: stages }),
      cost: 0.2, startedAt: "2026-08-29 02:00 UTC", durationS: 88, triggeredBy: "manual",
      stages, sections: [],
      drills: reportDrilldowns(det as never),
      now: new Date("2026-08-29T03:00:00Z"),
    });
    expect(md).toContain("## 线上评估环节明细");
    expect(md).toContain("| 评估器 | 评估器均分 | 通过率 | 判定会话 |");
    // DDB 摘要通路：分母那格写「未记录」，不编数字
    expect(md).toContain("| helpfulness | 0.90 | 100% | 未记录 |");
    expect(md).toContain("**未通过 / 未获判定的会话**");
    expect(md).toContain(`- **${SID_ERR}**：拉取失败 · 未获判定 — trace 拉取失败：CloudWatch 查询超时`);
    expect(md).toContain(`- **${SID_NOCONTENT}**：无内容可评 · 未获判定`);
    // 正常支通过了 → 不进摘要（没有坏消息就别造行）
    expect(md).not.toContain(`- **${SID_OK}**`);
    // dataset 那块照旧（两类同场时互不吞并）
    expect(md).toContain(`## 回归测试环节明细 · ${DATASET}`);
  });
});
