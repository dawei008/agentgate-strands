// 导出与屏幕同刑（export parity）。
//
// 三件事钉在这里：
//
// 1) **环节分档收敛**（S5）：抽屉的环节分类行（StageLine）与导出的环节一行
//    此前各写一套「empty / failed / 正常」的 if——同一个判据两份实现，改一边
//    就漂移。现在两边只消费 derive 的 stageKind()/stageNote()，这里既测纯函数，
//    也测「屏幕上的原话与导出括号里的原话逐字相同」。
//
// 2) **stopped 环节不落红档**（code-review 必修）：用户主动停止的环节带
//    `status:"stopped"` + `error` = 停止说明原话（app/testrun.py:51 `_stop_note`
//    → planrun `_stage_summary` → DDB）。旧谓词 `status==="error" || error` 会把
//    它判进失败红档，而 lib/scoring.ts 对 stopped 是**刻意**的 warn 琥珀
//    （statusBadgeClass:383「已停止」）—— 同一次运行，run 级琥珀、环节行猩红。
//    ⚠️ 修在展示分档层：`isStageFailed` 服务 run 级口径（成功运行数 / badge），
//    一行未动。
//
// 3) **导出补齐屏幕已有的新内容**（UI-011 之后 case-drilldown / evaluator-metrics
//    两批只进了屏幕，导出还是三节）：每个回归环节的环节分析全文 + 逐评估器表 +
//    未通过用例摘要。降级硬要求：老 run 缺字段 → 对应节**不输出**（不留空标题、
//    不写 0、不写 NaN）。
//
// 契约来源（逐字对齐，防 mock 漂移）：
//   app/testrun.py:51-59  `_stop_note` —— 停止说明落在 run["error"] 上；
//   app/planrun.py:996-997 `_fmt_stage_line` 的 STOP_STATUS 分支 ——「半截数字
//     不是结论」，这一行只说清为什么没跑完（所以 .snum 走「已停止」不摆数字）；
//   app/planrun.py:942-975 `_stage_summary` —— error 只在有 error 时存在；
//     evaluator_stats 只有 dataset 分支有；
//   S3 报告体 report.stages[i].report.{analysis,results} —— 明细的唯一住所。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// 旧报告页壳（渲染共享视图 ReportView，抽屉正文）：独立页已换成变体 A，见 tests/legacyReportPage.tsx
import ReportPage from "./legacyReportPage";
import { buildReportMarkdown } from "../src/pages/plan/exportReport";
import { stageKind, stageNote, reportDrilldowns } from "../src/pages/plan/derive";
import { runOutcome } from "../src/lib/scoring";
import { sseFrames } from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import type { StageSummary } from "../src/pages/plan/types";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

// ==================== 夹具（逐字照后端形态） ====================

/** 用户主动停止的回归环节：`_stop_note` 原话落在 error 上，status=stopped。
 *  半截数字（3/8 个用例）照常在摘要里——所以这一行**能**印出数字，正是不许印的。 */
const STOP_NOTE = "已按用户请求停止：8 个用例中已完成 3 个，"
  + "其余未执行（已完成用例的结果与已花费用照常保留）";
const DATASET_STOPPED: StageSummary = {
  type: "dataset", status: "stopped", pass_rate: 1, cases: 3, error: STOP_NOTE,
};

/** 成本熔断：也带 error 文本，但它落**失败侧**（scoring.isStageFailed 的注释）
 *  —— stopped 那一档绝不能把熔断顺手带走。 */
const DATASET_HALTED: StageSummary = {
  type: "dataset", status: "halted_cost", pass_rate: 1, cases: 3,
  error: "实际成本 $1.20 超出预估 $0.30 的 4 倍，已自动熔断中止",
};

const OBSERVE_OK: StageSummary = {
  type: "observe", status: "completed", evaluators: ["helpfulness"],
  overall_mean: 0.86, sessions: 12,
};

const DATASET_ERR: StageSummary = {
  type: "dataset", status: "error", pass_rate: null, cases: 0,
  error: "ValidationException: Item size has exceeded the maximum allowed size",
};

const OBSERVE_EMPTY: StageSummary = {
  type: "observe", status: "empty", sessions: 0, overall_mean: null,
  error: "最近 30 天没有可评估的会话",
};

/** 逐评估器聚合（planrun.py:_evaluator_stats）：refusal 一条判定都没有
 *  （judged=0 / mean=null）——「无可评估数据」与 0 分是两件事。 */
const DDB_DATASET: StageSummary = {
  type: "dataset", status: "completed", pass_rate: 0.5, cases: 3, blank_cases: 1,
  evaluators: ["correctness", "instruction_following", "refusal"],
  evaluator_stats: {
    correctness: { mean: 0.8, passed: 1, judged: 2 },
    instruction_following: { mean: 0.0, passed: 0, judged: 1 },
    refusal: { mean: null, passed: 0, judged: 0 },
  },
};

const DATASET_NAME = "qa-edge-20260825";

const ANALYSIS = [
  "## 总体结论",
  "3 个用例中 1 个通过、1 个不通过、1 个空响应未获判定。",
  "",
  "## 建议（行动清单）",
  "**[SYSTEM_PROMPT_FIX]**（影响 1 个用例）：明确禁止重复追问已确认信息。",
].join("\n");

/** judge 理由（现网封顶 600 字）：导出只取**首句**，全文留在屏幕上 */
const LONG_REASON = "用户明确要求不再追问，Agent 仍重复提问。"
  + `此外${"该回答还把「不用买保险」曲解为「提到用保险」，属于对否定表述的系统性误读。".repeat(6)}`;

const CASE_ROWS: Record<string, unknown>[] = [
  {
    agent: "support-bot", case: "case-pass", input: "退货政策？", output: "30 天可退。",
    results: { correctness: { score: 0.9, passed: true, errored: false, reason: "与期望一致。" } },
  },
  {
    agent: "support-bot", case: "case-repeat-ask", input: "订明天航班，别再问我。",
    output: "请确认是否需要保险？",
    results: {
      correctness: { score: 0.9, passed: true, errored: false, reason: "订单要素一致。" },
      instruction_following: { score: 0, passed: false, errored: false, reason: LONG_REASON },
    },
  },
  {
    agent: "support-bot", case: "case-blank", input: "行李费多少？", output: "",
    blank_output: true,
    eval_skipped: "被测 Agent 返回空响应（0 字节，非报错）：无内容可判分。"
      + "本用例不计入本环节均分与通过率。",
    // ⚠️ results 整键缺失（现网 31/191 行如此）
  },
];

function s3DatasetStage(inner: Record<string, unknown> = {}) {
  return {
    type: "dataset", status: "completed", run_id: "run-20260825",
    dataset: DATASET_NAME, cases: 3, judged_cases: 2, pass_rate: 0.5,
    report: {
      run_id: "run-20260825", dataset: DATASET_NAME, status: "completed",
      total_cases: 3, blank_cases: 1, analysis: ANALYSIS, results: CASE_ROWS,
      ...inner,
    },
  };
}

const PLAN = {
  plan_id: "plan-parity01",
  name: "同刑巡检",
  agent_name: "support-bot",
  updated_at: 1787000000,
  stages: [{ type: "dataset", dataset: DATASET_NAME, evaluators: ["correctness"] }],
  schedule: null,
};

const RUN_KEY = "plan-parity01#20260825020000";

const RUNS = [{
  run_key: RUN_KEY, status: "completed", score: null,
  started_at: "2026-08-25 02:00 UTC", duration_s: 219, triggered_by: "manual",
  stage_summaries: [DDB_DATASET],
}];

/** get_plan_run 真形态：顶层 DDB 摘要（evaluator_stats 在这里）
 *  + report（S3 全量报告体，analysis/results 在这里）。两个数组同序同长。 */
function detail(over: Record<string, unknown> = {}) {
  return {
    event: "plan_run",
    run_key: RUN_KEY,
    plan_id: PLAN.plan_id,
    plan_name: PLAN.name,
    agent_name: PLAN.agent_name,
    status: "completed",
    score: null,
    started_at: "2026-08-25 02:00 UTC",
    finished_at: "2026-08-25 02:03 UTC",
    duration_s: 219,
    triggered_by: "manual",
    total_cost_usd: 0.12,
    overview: { stage_lines: [], previous_run: null },
    stage_summaries: [DDB_DATASET],
    s3_key: "reports/plan-parity01/20260825020000.json",
    plan_synthesis: null,
    synthesis_sections: [],
    synthesis_error: null,
    report: {
      run_key: RUN_KEY,
      plan: { plan_id: PLAN.plan_id, name: PLAN.name, agent_name: PLAN.agent_name, stages: [] },
      triggered_by: "manual",
      started_at: "2026-08-25 02:00 UTC",
      finished_at: "2026-08-25 02:03 UTC",
      duration_s: 219,
      stages: [s3DatasetStage()],
    },
    ...over,
  };
}

/** 导出入口的公共参数（抽屉已算好的展示值直接传进来，口径共用不重算） */
function exportBase(stages: StageSummary[], d: Record<string, unknown> | null = null) {
  const det = d ?? detail();
  return {
    runKey: RUN_KEY, seq: 1, planId: PLAN.plan_id,
    detail: det as never,
    status: String(det.status ?? "completed"),
    score: null,
    outcome: runOutcome({
      status: String(det.status ?? "completed"), score: null, stage_summaries: stages,
    }),
    cost: 0.12, startedAt: "2026-08-25 02:00 UTC", durationS: 219,
    triggeredBy: "manual", stages, sections: [],
    drills: reportDrilldowns(det as never),
    now: new Date("2026-08-25T03:00:00Z"),
  };
}

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [PLAN] }],
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

/** 报告的**生产入口是独立页** `#/report/<run_key>`（用户原话：抽屉「很多字但只有
 *  一半屏幕能看」），所以这一批断言直接挂那一页，不再走「方案页 → 点查看报告 →
 *  等抽屉」。少一跳，顺带把「run_key 自己就够定位一份报告」一起测了（页面只收
 *  run_key，plan_id 是它的前缀）。
 *  「运行历史那一行点了会去报告页」属于方案页的动线，由 tests/plan.test.tsx 钉；
 *  「抽屉壳还在、且滚动容器与页面不同源」由 tests/case-drilldown.test.tsx 钉。 */
async function openReport() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ReportPage id={RUN_KEY} />
    </QueryClientProvider>,
  );
  await screen.findByTestId("report-drawer-head");
  await waitFor(() =>
    expect(screen.queryByTestId("report-drawer-loading")).not.toBeInTheDocument());
}

/** 下载边界打桩（同 plan.test.tsx）：真实下载不可测，拦 createObjectURL + click */
function stubDownload() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn((b: Blob) => {
    blobs.push(b);
    return "blob:mock-url";
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
  return {
    restore() {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      clickSpy.mockRestore();
    },
    count: () => names.length,
    async grab() {
      expect(names).toHaveLength(1);
      return new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(fr.error ?? new Error("Blob 读取失败"));
        fr.readAsText(blobs[0]);
      });
    },
  };
}

beforeEach(() => {
  overrides = {};
  resetConfigForTest();
  resetRunFlightForTest();
  location.hash = `#/plan/${PLAN.plan_id}`;
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==================== ① 环节分档：一份判据，两处消费 ====================

describe("stageKind / stageNote：抽屉与导出的唯一判据", () => {
  it("四档判定顺序：empty → stopped → failed → normal", () => {
    expect(stageKind(OBSERVE_EMPTY)).toBe("empty");
    expect(stageKind(DATASET_STOPPED)).toBe("stopped");
    expect(stageKind(DATASET_ERR)).toBe("failed");
    // 成本熔断带 error 文本 → 仍落失败侧（stopped 不许把它顺手带走）
    expect(stageKind(DATASET_HALTED)).toBe("failed");
    expect(stageKind(OBSERVE_OK)).toBe("normal");
    // empty 环节也带 error 文本（「最近 30 天没有可评估的会话」）——必须先出局
    expect(stageKind({ type: "observe", status: "empty", error: "x" })).toBe("empty");
    // 没有 status、只有 error 文本的老形态：仍算失败
    expect(stageKind({ type: "dataset", error: "boom" })).toBe("failed");
  });

  it("注记按档取源：原话优先，失败无原话退配置元信息，停止有兜底句", () => {
    expect(stageNote(OBSERVE_EMPTY)).toBe("最近 30 天没有可评估的会话");
    expect(stageNote(DATASET_STOPPED)).toBe(STOP_NOTE);
    expect(stageNote(DATASET_ERR)).toBe(DATASET_ERR.error);
    // 正常环节：数据集 · 评估器
    expect(stageNote({
      type: "dataset", status: "completed", dataset: "faq-v3",
      evaluators: ["correctness", "refusal"],
    })).toBe("faq-v3 · correctness · refusal");
    // 失败但后端没给原话（UI-025 的空位形态）：退到配置元信息，不给空括号
    expect(stageNote({ type: "dataset", status: "error", dataset: "faq-v3" })).toBe("faq-v3");
    // 停止但没有原话（status 单独一个人说不了话）：兜底句与后端
    // planrun.py:996 `_fmt_stage_line` 的 STOP_STATUS 分支同款
    expect(stageNote({ type: "dataset", status: "stopped" }))
      .toBe("已按用户请求停止，本环节未跑完");
    // empty 且后端没给原因：留空，不拿 dataset 名冒充「为什么没有数据」
    expect(stageNote({ type: "dataset", status: "empty", dataset: "faq-v3" })).toBe("");
  });
});

// ==================== ② stopped 不落红档 ====================

describe("用户主动停止的环节：warn 琥珀，不是失败红", () => {
  it("表格组头：「已停止」+ 停止说明原话（不印半截数字，也不落红档）", async () => {
    overrides.get_plan_run = (p) => [{
      ...detail(), run_key: p.run_key, status: "stopped",
      stage_summaries: [DATASET_STOPPED],
      report: { ...detail().report, stages: [DATASET_STOPPED] },
    }];
    installFetch();
    await openReport();
    const head = await screen.findByTestId("report-group-0-head");
    // stopped 与 failed 是两档（stageKind 的判定顺序），组头 class 就是那个档位
    expect(head).toHaveClass("is-stopped");
    expect(head).not.toHaveClass("is-failed");
    expect(head).toHaveTextContent("已停止");
    expect(head).not.toHaveTextContent("执行失败");
    // 半截数字不是结论（planrun.py:_fmt_stage_line 的同一条纪律）
    expect(head).not.toHaveTextContent("通过率 100%");
    // 原话到得了这一行，且挂 title（组头刻意单行省略号）
    expect(head.querySelector(".gnote")).toHaveAttribute("title", STOP_NOTE);
  });

  it("导出同刑：「已停止（原话）」，一个「执行失败」都不许出现", () => {
    // run 级也是 stopped：后端一旦有环节在自己的检查点被停掉，这次 run 的状态
    // 就是 STOP_STATUS（planrun.py:801-841）——「completed 的 run 里有 stopped
    // 环节」不是真形态，别拿它测。run 级由 status 接管（runOutcome 非 completed
    // 走 status 分支 → 琥珀「已停止」），环节行由 stageKind 接管。
    const md = buildReportMarkdown(exportBase([DATASET_STOPPED], detail({ status: "stopped" })));
    expect(md).toContain(`- **回归测试**：已停止（${STOP_NOTE}）`);
    expect(md).not.toContain("执行失败");
    expect(md).not.toContain("通过率 100%");
  });

  it("成本熔断不受影响：仍写「执行失败（原话）」（主动止损≠用户停止）", () => {
    const md = buildReportMarkdown(exportBase([DATASET_HALTED]));
    expect(md).toContain(`- **回归测试**：执行失败（${DATASET_HALTED.error}）`);
    expect(md).not.toContain("已停止");
  });
});

// ==================== ①② parity：屏幕原话 == 导出原话 ====================

describe("同刑证明：屏幕上的原话与导出括号里的原话逐字相同", () => {
  it("四类环节各一行：注记文本一字不差", async () => {
    const stages = [OBSERVE_OK, OBSERVE_EMPTY, DATASET_STOPPED, DATASET_ERR];
    overrides.get_plan_run = (p) => [{
      ...detail(), run_key: p.run_key, stage_summaries: stages,
      report: { ...detail().report, stages },
    }];
    installFetch();
    const dl = stubDownload();
    try {
      await openReport();
      fireEvent.click(screen.getByTestId("report-drawer-export"));
      await waitFor(() => expect(dl.count()).toBe(1));
      const md = await dl.grab();
      for (const [i, s] of stages.entries()) {
        const row = screen.getByTestId(`report-group-${i}-head`);
        const note = row.querySelector(".gnote");
        const expected = stageNote(s);
        if (expected) {
          // 屏幕：注记全文在 title 上（正文单行省略号）
          expect(note).toHaveAttribute("title", expected);
          // 导出：同一份原话
          expect(md).toContain(expected);
        } else {
          expect(note).toBeNull();
        }
      }
    } finally {
      dl.restore();
    }
  });
});

// ==================== ④ 导出补齐屏幕新内容 ====================

describe("导出补齐：环节分析 / 逐评估器 / 未通过用例", () => {
  it("环节分析全文原样进导出（含 ## 小节与 **加粗**，不摘要不截断）", () => {
    const md = buildReportMarkdown(exportBase([DDB_DATASET]));
    expect(md).toContain(`## 回归测试环节明细 · ${DATASET_NAME}`);
    expect(md).toContain("**环节分析**");
    // 原样 = 逐字（含 judge 自己的 `## ` 标题与 `**[SYSTEM_PROMPT_FIX]**`）
    expect(md).toContain(ANALYSIS);
  });

  it("逐评估器 Markdown 表：表头带限定词「评估器均分」；零判定走「无可评估数据」不写 0", () => {
    const md = buildReportMarkdown(exportBase([DDB_DATASET]));
    expect(md).toContain("| 评估器 | 评估器均分 | 通过/判定 |");
    expect(md).toContain("| correctness | 0.80 | 1/2 |");
    // 0.00 是「评了且很差」，如实写
    expect(md).toContain("| instruction_following | 0.00 | 0/1 |");
    // judged=0 → 一条判定都没有：中性文案 + 分母「—」，绝不是 0
    expect(md).toContain("| refusal | 无可评估数据 | — |");
  });

  it("未通过用例摘要：用例名 + 不通过的评估器 + judge 理由**首句**（全文不进导出）", () => {
    const md = buildReportMarkdown(exportBase([DDB_DATASET]));
    expect(md).toContain("**未通过 / 未获判定的用例**");
    expect(md).toContain("- **case-repeat-ask**（support-bot）：instruction_following 不通过 — "
      + "用户明确要求不再追问，Agent 仍重复提问。");
    // 首句之后的长文留在屏幕上，导出不夹带（防爆）
    expect(md).not.toContain("曲解为「提到用保险」");
    // 空响应不是「不通过」：另有标记，理由走后端原话首句
    expect(md).toContain("- **case-blank**（support-bot）：空响应 · 未获判定 — "
      + "被测 Agent 返回空响应（0 字节，非报错）：无内容可判分。");
    // 通过的用例不进这一节（它没有可看的问题）
    expect(md).not.toContain("case-pass");
  });

  /** ADR-0014 之后屏幕与导出**刻意不再逐块同形**：环节分析全文与逐评估器聚合表
   *  只在导出里（导出是文档），屏幕上是全量表的行 + 行内评估器小格。所以这条
   *  端到端钉改成：屏幕上看得到那几条**失败行**，导出里就有对应的那几段。 */
  it("端到端：屏幕上的失败行 ↔ 导出里的分析/评估器/失败用例摘要", async () => {
    const dl = stubDownload();
    try {
      await openReport();
      // 屏幕锚点：拖分那一行与它的评估器小格真的渲染出来了（不是拿夹具自说自话）
      const row = await screen.findByTestId("report-row-0-0");
      expect(row).toHaveAttribute("data-row", "case-repeat-ask");
      expect(screen.getByTestId("report-verdict-0-0-instruction_following"))
        .toHaveTextContent("0.00");
      fireEvent.click(screen.getByTestId("report-drawer-export"));
      await waitFor(() => expect(dl.count()).toBe(1));
      const md = await dl.grab();
      expect(md).toContain("**环节分析**");
      expect(md).toContain("| instruction_following | 0.00 | 0/1 |");
      expect(md).toContain("case-repeat-ask");
      expect(md).toContain("case-blank");
    } finally {
      dl.restore();
    }
  });
});

// ==================== ④ 降级：老 run 缺字段就不出这一节 ====================

describe("降级：缺什么就不写什么（不留空标题、不写 0、不写 NaN）", () => {
  it("report 整份缺失（report_error 通路）：整块明细不输出，前三节照旧", () => {
    const d = detail({ report: undefined, report_error: "完整报告读取失败（摘要仍可用）" });
    const md = buildReportMarkdown(exportBase([DDB_DATASET], d));
    expect(md).not.toContain("环节明细");
    expect(md).not.toContain("**环节分析**");
    expect(md).not.toContain("| 评估器 |");
    // 前三节仍在
    expect(md).toContain("## 运行信息");
    expect(md).toContain("## 环节结果");
    expect(md).toContain("## 综合结论");
  });

  it("老 run 没有 evaluator_stats：不画表（其余节照出）", () => {
    const noStats: StageSummary = {
      type: "dataset", status: "completed", pass_rate: 0.5, cases: 3,
    };
    const md = buildReportMarkdown(exportBase([noStats]));
    expect(md).not.toContain("| 评估器 |");
    expect(md).toContain("**环节分析**");
    expect(md).toContain("**未通过 / 未获判定的用例**");
  });

  it("环节没有 analysis：不输出分析小节（其余节照出）", () => {
    const d = detail({
      report: { ...detail().report, stages: [s3DatasetStage({ analysis: undefined })] },
    });
    const md = buildReportMarkdown(exportBase([DDB_DATASET], d));
    expect(md).not.toContain("**环节分析**");
    expect(md).toContain("| 评估器 |");
  });

  it("全部用例都通过：不输出「未通过」小节（没有坏消息就别造一个空标题）", () => {
    const d = detail({
      report: {
        ...detail().report,
        stages: [s3DatasetStage({ results: [CASE_ROWS[0]] })],
      },
    });
    const md = buildReportMarkdown(exportBase([DDB_DATASET], d));
    expect(md).not.toContain("未通过 / 未获判定");
    expect(md).toContain("**环节分析**");
  });

  it("非回归环节（observe/redteam）不造明细节：那两类的明细形态不同，不硬套", () => {
    const md = buildReportMarkdown(exportBase([OBSERVE_OK], detail({
      report: { ...detail().report, stages: [OBSERVE_OK] },
    })));
    expect(md).not.toContain("环节明细");
  });
});
