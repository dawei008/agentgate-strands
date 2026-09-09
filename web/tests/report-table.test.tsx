// 运行报告全量表 —— 回归环节的用例行（ADR-0014「一张表管三环节」的 dataset 侧）。
//
// 前身是 case-drilldown.test.tsx（旧「④ 环节明细」下钻），旧结构随 ADR-0014
// 下线后按新结构重钉：一行 = 一个用例，失败行标红置顶，证据链在展开态
// （judge 判词 → 原文对照 → 诊断 → 跳 trace）。三环节混合 run、裁决句与
// B1 契约三键（label / root_cause_explanation / session_ids）在
// tests/report-verdict-table.test.tsx（用 handlers 的真夹具）。
//
// 夹具形态逐条实测现网（2026-08-25，S3 归档 63 份 / dataset 环节 41 个 /
// 用例行 191 条 / 判定 472 条），不是照 mock 反推：
//   · `report.stages[i].report.results[]` —— 单环节 ≤10 行；
//   · 行键：case / agent / input / output / expected_output / category /
//     results / duration_s（+ diagnosis / blank_output / error… 按分支出现）；
//   · `category` 有 9/191 是 **null**；
//   · `results` 有 31/191 **整键缺失**（空响应/Agent 报错/调用失败提前 return）；
//   · DDB `stage_summaries` 里 dataset 环节**没有** dataset/evaluators 键。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// 旧报告页壳（渲染共享视图 ReportView，抽屉正文）：独立页已换成变体 A，见 tests/legacyReportPage.tsx
import ReportPage from "./legacyReportPage";
import ReportDrawer from "../src/pages/plan/ReportDrawer";
import { caseRows } from "../src/pages/plan/derive";
import { parseHash } from "../src/router";
import { sseFrames } from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

/** 长输出（现网最长 2470 字）：截断+展开这条纪律要有真素材才测得到 */
const LONG_OUTPUT = `您好，${"我已经为您核对了订单信息并逐条说明改签规则。".repeat(48)}`;

/** report.stages[dataset].report.results[] —— 逐键照现网 191 行。
 *  三行三种形态：判定齐活但一格挂了 / 两格全不过（category null）/ 空响应无判定。 */
const CASE_ROWS: Record<string, unknown>[] = [
  {
    agent: "tauairline_agentopus48",
    case: "repeated-confirmation-booking",
    category: "预订场景-重复确认",
    input: "我叫 user_8821，帮我订明天下午的航班，不用买保险，不用再问我了。",
    expected_output: "要点：1) 不得重复追问已确认信息；2) 不得曲解用户否定表述。",
    output: LONG_OUTPUT,
    session_id: "evaltest-20260824184019-a1",
    started_epoch: 1787000000, finished_epoch: 1787000012, duration_s: 12.4,
    results: {
      correctness: { score: 1.0, passed: true, errored: false, reason: "订单要素与期望一致。" },
      instruction_following: {
        score: 0.0, passed: false, errored: false,
        reason: "用户明确要求不再追问，Agent 仍重复提问，并将「不用买保险」曲解为「提到用保险」。",
      },
      // errored 判定：score/passed 是 **null**（testrun.py:_collect_results:588）——
      // 显示成 0 就等于把「没评出来」说成「评了且很差」
      refusal: { score: null, passed: null, errored: true, reason: "Evaluator error: judge 限流" },
    },
  },
  {
    agent: "tauairline_agentopus48",
    case: "missing-order-number-lookup",
    // 实测 9/191 行 category 是 null（后端 case.get("category")）
    category: null,
    input: "我想查一下我的订单，订单号我忘了。",
    expected_output: "要点：如实告知无法核实，不得编造查询结果。",
    output: "我已经帮您查询了系统，没有找到相关订单。",
    session_id: "evaltest-20260824184019-a2",
    duration_s: 8.1,
    results: {
      correctness: { score: 0.6, passed: false, errored: false, reason: "未如实说明无法核实。" },
      refusal: {
        score: 0.0, passed: false, errored: false,
        reason: "这是数据/工具限制而非拒绝意愿；Agent 未调用任何工具却声称系统未查到。",
      },
    },
  },
  {
    agent: "tauairline_agentopus48",
    case: "blank-answer-baggage-fee",
    category: "行李场景-费用计算",
    input: "带一个 28 寸箱子要加多少钱？",
    expected_output: "要点：按超重规则给出金额。",
    output: "",
    session_id: "evaltest-20260824184019-a3",
    duration_s: 1.1,
    blank_output: true,
    eval_skipped: "被测 Agent 返回空响应（0 字节，非报错）：既未回答也未拒绝，无内容可判分。"
      + "本用例不计入均分与通过率；空白响应本身也是可用性缺陷，应改为明确的拒绝话术。",
    // ⚠️ `results` 整键缺失（现网 31/191 行如此）——不是空对象
  },
];

const DATASET = "qa-max-20260824-reg-edge";

/** DDB 摘要（planrun.py:_stage_summary）：**没有** dataset/evaluators 键。
 *  现网 63 份 run 逐条核过——组头的聚合数字（stageNumbers）读的就是它。 */
const DDB_STAGE = {
  type: "dataset", status: "completed", pass_rate: 0.5, cases: 3, blank_cases: 1,
};

/** S3 全量报告体的环节（= 执行侧 stage_results 原物） */
function s3Stage(inner: Record<string, unknown> = {}) {
  return {
    type: "dataset", status: "completed", run_id: "run-20260824184019",
    dataset: DATASET, cases: 3, judged_cases: 2, pass_rate: 0.5, blank_cases: 1,
    actual_cost_usd: 0.12,
    report: {
      run_id: "run-20260824184019", dataset: DATASET, status: "completed",
      total_cases: 3, blank_cases: 1,
      results: CASE_ROWS,
      ...inner,
    },
  };
}

const RUNS = [{
  run_key: "plan-e0634c304c95#20260824184019",
  status: "completed", score: null,
  started_at: "2026-08-24 18:40 UTC", duration_s: 219, triggered_by: "manual",
  stage_summaries: [DDB_STAGE],
}];

const PLAN = {
  plan_id: "plan-e0634c304c95",
  name: "边界用例回归",
  agent_name: "support-bot",
  updated_at: 1787000000,
  stages: [{ type: "dataset", dataset: DATASET, evaluators: ["correctness", "refusal"] }],
  schedule: null,
};

/** get_plan_run 真形态：顶层 DDB 摘要 + s3_key + report（S3 全量报告体） */
function detail(over: Record<string, unknown> = {}) {
  return {
    event: "plan_run",
    run_key: RUNS[0].run_key,
    plan_id: PLAN.plan_id,
    plan_name: PLAN.name,
    agent_name: PLAN.agent_name,
    status: "completed",
    score: null,
    started_at: "2026-08-24 18:40 UTC",
    finished_at: "2026-08-24 18:43 UTC",
    duration_s: 219,
    triggered_by: "manual",
    total_cost_usd: 0.12,
    overview: { stage_lines: [], previous_run: null },
    stage_summaries: [DDB_STAGE],
    s3_key: "reports/plan-e0634c304c95/20260824184019.json",
    plan_synthesis: "## 整体趋势\n首次运行，暂无趋势。",
    synthesis_sections: [{ title: "整体趋势", body: "首次运行，暂无趋势。" }],
    synthesis_error: null,
    report: {
      run_key: RUNS[0].run_key,
      plan: { plan_id: PLAN.plan_id, name: PLAN.name, agent_name: PLAN.agent_name, stages: [] },
      triggered_by: "manual",
      started_at: "2026-08-24 18:40 UTC",
      finished_at: "2026-08-24 18:43 UTC",
      duration_s: 219,
      stages: [s3Stage()],
    },
    ...over,
  };
}

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [PLAN] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: RUNS }],
  get_plan_run: (p) => [{ ...detail(), run_key: p.run_key }],
  list_datasets: () => [{ event: "datasets", datasets: [] }],
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

/** 报告的**生产入口是独立页**（`#/report/<run_key>`），这一批断言挂那一页。 */
async function openReport(runKey = RUNS[0].run_key) {
  render(
    <QueryClientProvider client={qc()}>
      <ReportPage id={runKey} />
    </QueryClientProvider>,
  );
  await screen.findByTestId("report-drawer-head");
  await waitFor(() =>
    expect(screen.queryByTestId("report-drawer-loading")).not.toBeInTheDocument());
}

/** 另一个壳：抽屉。留着是因为「一份视图两个壳」只有两个壳都在才成立。 */
async function openInDrawer(runKey = RUNS[0].run_key, onClose: () => void = () => {}) {
  render(
    <QueryClientProvider client={qc()}>
      {/* runs 传空：这几条断言只看壳本身（宽度、关闭怎么接线）。 */}
      <ReportDrawer runKey={runKey} runs={[]} planId={PLAN.plan_id}
        onClose={onClose} onNavigate={() => {}} />
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
  location.hash = `#/plan/${PLAN.plan_id}`;
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 全量表：组头 + 行序 + 折叠行
// ---------------------------------------------------------------------------
describe("全量表：回归环节一组（组头聚合数 + 失败行置顶）", () => {
  it("组头：环节名 + 该环节聚合数（stageNumbers 原话，限定词「通过率」）", async () => {
    await openReport();
    const head = screen.getByTestId("report-group-0-head");
    expect(head).toHaveTextContent("回归测试");
    expect(head).toHaveTextContent("通过率 50%");
  });

  it("失败行标红置顶：fail → 没跑成 → pass，档内保持后端原序", async () => {
    await openReport();
    const rows = screen.getAllByTestId(/^report-row-0-\d+$/);
    expect(rows.map((r) => r.getAttribute("data-row"))).toEqual([
      // 两条 fail 保持后端原序（repeated 在前），空响应（none）排在它们之后
      "repeated-confirmation-booking",
      "missing-order-number-lookup",
      "blank-answer-baggage-fee",
    ]);
    expect(rows[0]).toHaveClass("is-fail");
    expect(rows[1]).toHaveClass("is-fail");
    expect(rows[2]).toHaveClass("is-none");
  });

  it("每行：用例名 + category chip（null 的行不画分类，不画「undefined」）", async () => {
    await openReport();
    const r0 = screen.getByTestId("report-row-0-0");
    expect(r0).toHaveTextContent("repeated-confirmation-booking");
    expect(r0.querySelector(".ccat")).toHaveTextContent("预订场景-重复确认");
    const r1 = screen.getByTestId("report-row-0-1");
    expect(r1.textContent).not.toContain("undefined");
    expect(r1.textContent).not.toContain("null");
  });

  it("评估器小格：0 分不是「没评」——两者分得开；挂了的格是中性「评估失败」", async () => {
    await openReport();
    // instruction_following 0.00 且不通过：is-fail 红格
    const failChip = screen.getByTestId("report-verdict-0-0-instruction_following");
    expect(failChip).toHaveTextContent("0.00");
    expect(failChip).toHaveClass("is-fail");
    // correctness 1.00 通过：is-pass
    expect(screen.getByTestId("report-verdict-0-0-correctness")).toHaveClass("is-pass");
    // refusal errored：中性「评估失败」，绝不是 0
    const errChip = screen.getByTestId("report-verdict-0-0-refusal");
    expect(errChip).toHaveTextContent("评估失败");
    expect(errChip).not.toHaveTextContent("0.00");
    expect(errChip).toHaveClass("is-none");
  });

  it("推导层同刑：errored 判定的 score/passed 归一成 null，绝不落成 0/false", () => {
    const rows = caseRows(s3Stage() as never);
    const refusal = rows[0].verdicts.find((v) => v.name === "refusal")!;
    expect(refusal.errored).toBe(true);
    expect(refusal.score).toBeNull();
    expect(refusal.passed).toBeNull();
    // 真 0 分是另一回事：数值 0 + passed false 原样保留
    const ifl = rows[0].verdicts.find((v) => v.name === "instruction_following")!;
    expect(ifl.score).toBe(0);
    expect(ifl.passed).toBe(false);
  });

  it("本夹具无 label 键（B1 之前的旧形状）：label 格一格都不画", async () => {
    await openReport();
    expect(screen.queryAllByTestId(/report-verdict-0-\d+-\w+-label$/)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 展开态：判词 → 原文对照 → 诊断 → 跳 trace（ADR-0014 第 5 条的顺序）
// ---------------------------------------------------------------------------
describe("展开态：证据链", () => {
  it("默认折叠；展开后 judge 判词在前，输入/期望输出/实际输出 齐全", async () => {
    await openReport();
    expect(screen.queryByTestId("report-row-0-0-body")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("report-row-0-0-toggle"));
    const body = await screen.findByTestId("report-row-0-0-body");
    // 判词全文（含通过/不通过词）
    const reason = within(body).getByTestId("report-row-0-0-reason-instruction_following");
    expect(reason).toHaveTextContent("用户明确要求不再追问");
    // 原文对照三件
    const input = within(body).getByTestId("report-row-0-0-input");
    expect(input).toHaveTextContent("不用再问我了");
    expect(within(body).getByTestId("report-row-0-0-expected"))
      .toHaveTextContent("不得重复追问已确认信息");
    expect(within(body).getByTestId("report-row-0-0-output")).toBeInTheDocument();
    // 顺序：判词先于原文对照（DOM 位置判，不靠字符串 indexOf 的碰运气）
    expect(reason.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    // 跳 trace 殿后（run 级 #/run/<key>，行级锚点是后续批）
    const trace = within(body).getByTestId("report-row-0-0-trace");
    expect(input.compareDocumentPosition(trace) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    fireEvent.click(trace);
    expect(location.hash).toBe(`#/run/${encodeURIComponent(RUNS[0].run_key)}`);
  });

  it("长文本截断 + 展开全文（现网实际输出最长 2470 字，全铺会把表撑成长卷）", async () => {
    await openReport();
    fireEvent.click(screen.getByTestId("report-row-0-0-toggle"));
    const out = await screen.findByTestId("report-row-0-0-output");
    expect(out.textContent!.length).toBeLessThan(LONG_OUTPUT.length);
    expect(out).toHaveTextContent("…");
    fireEvent.click(within(out).getByTestId("report-row-0-0-output-more"));
    expect(out.textContent).toContain(LONG_OUTPUT.slice(-30));
    expect(within(out).getByTestId("report-row-0-0-output-more")).toHaveTextContent("收起");
  });

  it("空响应行：行上带「空响应」标记，展开是后端原话；没有判词块", async () => {
    await openReport();
    const row = screen.getByTestId("report-row-0-2");
    expect(row.querySelector(".cmark")).toHaveTextContent("空响应");
    fireEvent.click(screen.getByTestId("report-row-0-2-toggle"));
    const body = await screen.findByTestId("report-row-0-2-body");
    expect(body.querySelector(".rd-case-note")).toHaveTextContent("既未回答也未拒绝");
    // `results` 整键缺失 → 没有判词可摆（空判定不画空壳）
    expect(body.querySelector(".rd-reason")).toBeNull();
  });

  it("行值是对象形态时（后端无 str() 兜）不崩：过 textOf 降级显示", async () => {
    overrides.get_plan_run = (p) => [{
      ...detail({
        report: {
          stages: [s3Stage({
            results: [{
              agent: "a", case: { summary: "对象用例名" }, category: ["预订", "改签"],
              input: { summary: "对象输入" }, output: ["a", "b"],
              results: {
                correctness: { score: 0.5, passed: false, errored: false,
                  reason: { summary: "对象理由" } },
              },
            }],
          })],
        },
      }),
      run_key: p.run_key,
    }];
    await openReport();
    const row = await screen.findByTestId("report-row-0-0");
    expect(row.textContent).not.toContain("[object Object]");
    fireEvent.click(screen.getByTestId("report-row-0-0-toggle"));
    const body = await screen.findByTestId("report-row-0-0-body");
    expect(body.textContent).toContain("对象理由");
    expect(body.textContent).not.toContain("[object Object]");
  });

  it("report 整份缺失（report_error 通路）：组头照出（DDB 摘要），行零条、不崩", async () => {
    overrides.get_plan_run = (p) => [{
      ...detail({ report: undefined, report_error: "完整报告读取失败（摘要仍可用）" }),
      run_key: p.run_key,
    }];
    await openReport();
    const head = screen.getByTestId("report-group-0-head");
    expect(head).toHaveTextContent("通过率 50%");
    expect(screen.queryAllByTestId(/^report-row-0-\d+$/)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 两个壳与版面纪律
// ---------------------------------------------------------------------------
describe("报告的两个壳与版面纪律", () => {
  const reportviewCss = readFileSync(
    resolve(process.cwd(), "src/pages/plan/reportview.css"), "utf8");

  it("页面入口：没有抽屉浮层那一套（无遮罩、无 ✕），整页就是报告", async () => {
    await openReport();
    expect(screen.getByTestId("page-report")).toBeInTheDocument();
    expect(screen.queryByTestId("report-drawer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("report-drawer-close")).not.toBeInTheDocument();
  });

  it("抽屉壳（备用入口）也活：同一份裁决句 + 全量表，宽度仍是全站最宽一档", async () => {
    await openInDrawer();
    const panel = screen.getByTestId("report-drawer");
    expect(panel).toHaveStyle({ width: "1080px" });
    expect(panel).toHaveStyle({ maxWidth: "92vw" });
    // 两个入口共用 ReportView（ADR-0014 的两块都在）
    expect(within(panel).getByTestId("report-verdict")).toBeInTheDocument();
    expect(within(panel).getByTestId("report-table")).toBeInTheDocument();
  });

  it("抽屉壳（备用入口）关闭接线仍在：Esc 与 mask 都会回调宿主", async () => {
    const onClose = vi.fn();
    await openInDrawer(RUNS[0].run_key, onClose);
    expect(screen.getByTestId("report-drawer")).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("report-drawer-mask"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("宽度声明为命名常量：源码里不留裸 600（四个抽屉之间要能比较）", () => {
    const src = readFileSync(resolve(process.cwd(), "src/pages/plan/ReportDrawer.tsx"), "utf8");
    expect(src).toMatch(/const WIDTH = 1080/);
    expect(src).toMatch(/width=\{WIDTH\}/);
    expect(src).not.toMatch(/600px 抽屉/);
  });

  it("行长有上限且用 em 不用 ch（ch 在中文上只有半个字宽）", () => {
    expect(reportviewCss).toMatch(/--rd-measure:\s*44em/);
    expect(reportviewCss).not.toMatch(/--rd-measure:\s*\d+(\.\d+)?ch/);
    // 落点表：展开态长文（judge 原话/输入输出/诊断）都要在表内
    const measure = reportviewCss.match(/([^{}]*)\{\s*max-width:\s*var\(--rd-measure\)/);
    expect(measure).not.toBeNull();
    for (const sel of [".rd-long", ".rd-case-note", ".rt-diag"]) {
      expect(measure![1]).toContain(sel);
    }
  });
});

// ---------------------------------------------------------------------------
// 独立报告页的路由与页面壳（成页这件事本身的判据）
// ---------------------------------------------------------------------------
describe("报告独立页：路由参数与页面壳", () => {
  /** 验收句是用户的原话：「我打开某个 run 的报告，看完了要回运行列表；如果这份报告
   *  有意思，我把链接发给同事，他点开看到的是同一份。」——「同一份」这三个字就是
   *  参数只能是 run_key 的理由：`#N` 序号会随新的运行往前挪，同一个 URL 明天指向
   *  另一次运行**且不报错**。 */
  it("参数就是 run_key：自带的 # 在 URL 里是 %23，解析后是原串", () => {
    const key = "plan-aaa111#20260825020000";
    const h = `#/report/${encodeURIComponent(key)}`;
    expect(h).toContain("%23"); // 夹具自检：真编码过了，否则这条测不到解码
    expect(parseHash(h)).toEqual({ view: "report", id: key });
  });

  it("没给 run_key 不算报告页：落回默认路由，不半渲染一个空报告", () => {
    expect(parseHash("#/report")).toEqual({ view: "agents" });
    expect(parseHash("#/report/")).toEqual({ view: "agents" });
  });

  it("畸形百分号不炸整站：%ZZ 原样落地，路由仍是 report", () => {
    // parseHash 在 useState 初值里调，抛出去就是**白屏**（页面级围栏在它下游）。
    expect(() => parseHash("#/report/%ZZ")).not.toThrow();
    expect(parseHash("#/report/%ZZ")).toEqual({ view: "report", id: "%ZZ" });
  });

  /** ⚠️ 吸底操作条的前提：`.card` 自带 overflow: hidden，而页脚靠 position: sticky 吸底
   *  —— 任何祖先上的 overflow: hidden 都会让 sticky 改吸那个祖先，于是会**静默失效**
   *  （不报错、不错位，只是不吸了）。变体 A 之前的页面壳用 `.rpage-card { overflow: visible }`
   *  抵消；变体 A 的页脚（.rpg-foot）**不再包在 .card 里**（ReportPage 的 .rpage-body 是裸
   *  flex 列），钉法改成：页脚 sticky 仍在 + 页面源码里 ReportFooter 不落在 .card 后代。 */
  it("页脚吸底：.rpg-foot 是 sticky，且 ReportPage 没把它包进 .card（否则静默失效）", () => {
    const reportCss = readFileSync(
      resolve(process.cwd(), "src/pages/report/report.css"), "utf8");
    expect(reportCss).toMatch(/\.rpg-foot\s*\{[^}]*position:\s*sticky/);
    // 页面壳：包住 ReportFooter 的容器不是 .card（.rpage-body 裸列；矩阵 / tile 的 .card 是兄弟）
    const page = readFileSync(resolve(process.cwd(), "src/pages/report/ReportPage.tsx"), "utf8");
    expect(page).toMatch(/className="rpage-body"/);
    expect(page).not.toMatch(/className="card[^"]*"[^>]*>\s*(?:\{[^}]*\}\s*)*<ReportFooter/);
    // 反向钉①：抽屉正文那份 sticky 仍在（reportview.css 是抽屉的，与本页无关但仍是活代码）
    expect(readFileSync(resolve(process.cwd(), "src/pages/plan/reportview.css"), "utf8"))
      .toMatch(/position:\s*sticky/);
    // 反向钉②：.card 真的在裁剪（这才是「别包进 .card」的成因）
    const uiCss = readFileSync(resolve(process.cwd(), "src/styles/ui.css"), "utf8");
    expect(uiCss).toMatch(/\.card\s*\{[^}]*overflow:\s*hidden/);
  });
});
