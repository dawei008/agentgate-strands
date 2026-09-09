// ADR-0014 的两颗核心钉：**裁决句**（第一屏就是一句现算事实句）+ B1 契约三键的
// 渲染与降级。
//
// 为什么用 handlers.ts 的**真夹具**（MOCK_PLAN_RUN / MOCK_PLAN_RUN_PREV）而不是
// 内联造：这一批的判据是「mock 与真后端同刑」——三键的形态、旧形状 run 的三键
// 整键缺失，都必须落在 dev 与视觉基线都会走的那份夹具上。内联夹具能让断言全绿而
// 界面从没显影过（mock-legacy-shape 那一族的教训）。
//
// 裁决句口径（ADR-0014 第 2/3 条）：只列本次没过的东西，数字现算自行级
// passed/breached/errored，不比上次、不分档。三形态：有失败列失败 / 全过「全部
// 过线」/ 无可评估数据走中性口径。负钉：「较上次」「趋势」不在报告 DOM
// （CONTEXT.md「运行报告」词条 _Avoid_）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// 旧报告页壳（渲染共享视图 ReportView，抽屉正文）：独立页已换成变体 A，见 tests/legacyReportPage.tsx
import ReportPage from "./legacyReportPage";
import {
  conversationText, diagnosisOf, reportGroups, rowOutcomeOf, runVerdict,
} from "../src/pages/plan/reportRows";
import { runOutcome } from "../src/lib/scoring";
import {
  sseFrames, MOCK_PLAN_RUN, MOCK_PLAN_RUN_PREV, PLAN_RUNS, PREV_RUN_KEY,
} from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import type { PlanRunDetail } from "../src/pages/plan/types";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

const RUN_KEY = MOCK_PLAN_RUN.run_key;

/** run 详情 → runVerdict 的入参（与 ReportView 同一条组装路径） */
function verdictOf(d: unknown) {
  const detail = d as PlanRunDetail;
  const stages = detail.stages ?? detail.stage_summaries ?? detail.report?.stages ?? [];
  return runVerdict({
    outcome: runOutcome({
      status: detail.status ?? "", score: detail.score ?? null, stage_summaries: stages,
    }),
    groups: reportGroups(detail),
    skipReason: detail.skip_reason ?? null,
  });
}

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: PLAN_RUNS }],
  // `event` 由 handler 层加（真夹具常量里没有这个键，同 handlers.ts 的
  // get_plan_run 分支）——漏了它前端读成「未收到 plan_run」
  get_plan_run: (p) => [{
    event: "plan_run",
    ...(String(p.run_key) === PREV_RUN_KEY ? MOCK_PLAN_RUN_PREV : MOCK_PLAN_RUN),
    run_key: p.run_key,
  }],
  list_datasets: () => [{ event: "datasets", datasets: [] }],
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

function qc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

async function openReport(runKey = RUN_KEY) {
  render(
    <QueryClientProvider client={qc()}>
      <ReportPage id={runKey} />
    </QueryClientProvider>,
  );
  await screen.findByTestId("report-drawer-head");
  await waitFor(() =>
    expect(screen.queryByTestId("report-drawer-loading")).not.toBeInTheDocument());
}

/** 组内行下标按 data-row 现找（排序口径不抄第二份） */
function rowIndexOf(gi: number, name: string): number {
  const rows = screen.getAllByTestId(new RegExp(`^report-row-${gi}-\\d+$`));
  const n = rows.findIndex((r) => r.getAttribute("data-row") === name);
  expect(n, `第 ${gi} 组里应有 ${name}`).toBeGreaterThanOrEqual(0);
  return n;
}

beforeEach(() => {
  overrides = {};
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
// 裁决句（纯函数层：数字全部现算自行级判定）
// ---------------------------------------------------------------------------
describe("裁决句：只列本次没过的东西（数字现算，不比上次）", () => {
  it("真夹具（三环节混跑）：红队攻破 1/3 · 回归 1/2 没过 · 3 条没跑成", () => {
    // 逐条自证（夹具三环节的行级事实）：
    //   红队 3 攻击 = 1 攻破 + 1 守住 + 1 无有效结论；
    //   回归 3 用例 = case-1 通过 / case-2 不通过 / case-3 空响应无判定 ⇒ 分母 2；
    //   线上 2 会话 = 1 全过 + 1 拉取失败（无判定）。
    // ⇒ 「没跑成」= 红队 errored 1 + 回归空响应 1 + 线上拉取失败 1 = 3
    const v = verdictOf(MOCK_PLAN_RUN);
    expect(v.tone).toBe("bad");
    expect(v.text).toBe("红队被攻破 1/3 · 回归 1/2 没过 · 3 条没跑成");
    // 负钉：裁决句里没有任何跨 run 的词
    expect(v.text).not.toContain("较上次");
    expect(v.text).not.toContain("趋势");
  });

  it("全过 = 「全部过线」（绿），一个失败数字都不列", () => {
    const v = runVerdict({
      // runOutcome 的入参类型是 StageLike（只认它判终态要的那几个键）
      outcome: runOutcome({
        status: "completed", score: 0.9,
        stage_summaries: [{ type: "dataset", status: "completed", pass_rate: 1 }],
      }),
      groups: reportGroups({
        stage_summaries: [{ type: "dataset", status: "completed", pass_rate: 1, cases: 1 }],
        report: {
          stages: [{
            type: "dataset", status: "completed",
            report: { results: [{ case: "c1", input: "i", output: "o",
              results: { correctness: { score: 1, passed: true, errored: false, reason: "ok" } } }] },
          }],
        },
      } as never),
    });
    expect(v).toEqual({ text: "全部过线", tone: "ok" });
  });

  it("空 run：沿用中性「完成 · 无可评估数据」（不给绿，也不列失败）", () => {
    const empty = {
      status: "completed", score: null,
      stage_summaries: [{ type: "observe", status: "empty", error: "最近 30 天没有可评估的会话" }],
    };
    const v = verdictOf(empty);
    expect(v).toEqual({ text: "完成 · 无可评估数据", tone: "neutral" });
  });

  it("环节执行失败排在最前（它比任何行级数字都先说）", () => {
    const failed = {
      status: "completed", score: 0.86,
      stage_summaries: [
        { type: "observe", status: "completed", overall_mean: 0.86, sessions: 12 },
        { type: "redteam", status: "error", breached: 0, attacks: 0,
          error: "ValidationException: Item size has exceeded the maximum allowed size" },
      ],
    };
    const v = verdictOf(failed);
    expect(v.tone).toBe("bad");
    expect(v.text.startsWith("红队测试环节执行失败")).toBe(true);
  });

  it("非终态/跳过走 run 级状态词（skipped 带后端原话）", () => {
    expect(verdictOf({ status: "running", score: null, stage_summaries: [] }))
      .toEqual({ text: "运行中", tone: "neutral" });
    expect(verdictOf({
      status: "skipped", score: null, stage_summaries: [], skip_reason: "无新增线上会话",
    })).toEqual({ text: "跳过 · 无新增线上会话", tone: "neutral" });
  });

  it("只有 DDB 摘要的 run（明细缺失）：改用摘要聚合数说，不装作零失败", () => {
    // report 整份读不到（report_error 通路）⇒ 行为零；此时若只看行级，
    // 裁决句会说「全部过线」——那是把「读不到」说成「没问题」。
    const summaryOnly = {
      status: "completed", score: 0.5,
      stage_summaries: [
        { type: "redteam", status: "completed", breached: 2, attacks: 5 },
        { type: "dataset", status: "completed", pass_rate: 0.5, cases: 4 },
      ],
      report_error: "完整报告读取失败（摘要仍可用）",
    };
    const v = verdictOf(summaryOnly);
    expect(v.tone).toBe("bad");
    expect(v.text).toContain("红队被攻破 2/5");
    expect(v.text).toContain("回归通过率 50%");
  });

  it("行级过/挂口径 = per-case AND（先剔 errored；一条有效判定都没有 = 没跑成）", () => {
    const v = (passed: (boolean | null)[], errored: boolean[] = []) =>
      passed.map((p, i) => ({
        name: `e${i}`, score: p == null ? null : 1, passed: p,
        errored: errored[i] === true, reason: "",
      }));
    expect(rowOutcomeOf(v([true, true]), false)).toBe("pass");
    expect(rowOutcomeOf(v([true, false]), false)).toBe("fail");
    // errored 判定先被剔掉：剩下的全过就是过（评估器挂了不等于 Agent 挂了）
    expect(rowOutcomeOf(v([true, null], [false, true]), false)).toBe("pass");
    // 一条有效判定都不剩 → none（不是 fail，也不是 pass）
    expect(rowOutcomeOf(v([null], [true]), false)).toBe("none");
    expect(rowOutcomeOf([], false)).toBe("none");
    // 空响应 / 调用失败：后端 judged 闸门直接排除
    expect(rowOutcomeOf(v([true]), true)).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// 裁决句（界面层）+ 负钉
// ---------------------------------------------------------------------------
describe("裁决句即头部：第一屏就是它，且报告里没有跨 run 的词", () => {
  it("真夹具：裁决句上屏，徽章排/Δ 较上次都不在了", async () => {
    await openReport();
    const v = screen.getByTestId("report-verdict");
    expect(v).toHaveTextContent("红队被攻破 1/3");
    expect(v).toHaveClass("is-bad");
    // 徽章排与 Δ 已废除（ADR-0014 第 2 条）
    expect(screen.queryAllByTestId("report-drawer-badge")).toHaveLength(0);
    expect(screen.queryAllByTestId("report-drawer-delta")).toHaveLength(0);
    expect(screen.queryAllByTestId("report-drawer-nodata-meta")).toHaveLength(0);
    // 元信息小字仍在（时长/触发/成本）
    const meta = screen.getByTestId("report-drawer-meta");
    expect(meta).toHaveTextContent("1m14s");
    expect(meta).toHaveTextContent("手动触发");
    expect(meta).toHaveTextContent("$0.31");
  });

  it("负钉：「较上次」「趋势」一个字都不在报告 DOM（CONTEXT.md Avoid）", async () => {
    await openReport();
    const card = screen.getByTestId("report-page-card");
    for (const word of ["较上次", "趋势", "反复出现的问题", "改进采纳效果"]) {
      expect(card.textContent, word).not.toContain(word);
      expect(card.querySelector(`[title*="${word}"]`), `${word} 仍挂在某个 title 上`)
        .toBeNull();
    }
  });

  it("空 run：中性裁决句 + 底部换「查看方案设置」", async () => {
    overrides.get_plan_run = (p) => [{
      event: "plan_run", ...MOCK_PLAN_RUN, run_key: p.run_key, score: null,
      stage_summaries: [{ type: "observe", status: "empty", error: "最近 30 天没有可评估的会话" }],
      report: { stages: [{ type: "observe", status: "empty" }] },
    }];
    await openReport();
    const v = screen.getByTestId("report-verdict");
    expect(v).toHaveTextContent("完成 · 无可评估数据");
    expect(v).not.toHaveClass("is-ok");
    // 组头仍如实写「无数据」+ 后端原话（半截数字不是结论）
    const head = screen.getByTestId("report-group-0-head");
    expect(head).toHaveTextContent("无数据");
    expect(head).toHaveTextContent("最近 30 天没有可评估的会话");
    expect(screen.getByTestId("report-drawer-settings")).toBeInTheDocument();
    expect(screen.queryAllByTestId("report-drawer-trace")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 全量表：三环节同场（红队行是本批新增的那一类）
// ---------------------------------------------------------------------------
describe("全量表：真夹具三环节同场，红队行判定只有 攻破/守住", () => {
  it("三组三环节，组头各带自己的聚合数", async () => {
    await openReport();
    expect(screen.getByTestId("report-group-0-head")).toHaveTextContent("线上评估");
    expect(screen.getByTestId("report-group-1-head")).toHaveTextContent("回归测试");
    const rt = screen.getByTestId("report-group-2-head");
    expect(rt).toHaveTextContent("红队测试");
    expect(rt).toHaveTextContent("攻破 1/3");
  });

  it("红队行：攻破行标红置顶，判定列只有 攻破/守住（没有分数格）", async () => {
    await openReport();
    const rows = screen.getAllByTestId(/^report-row-2-\d+$/);
    expect(rows[0]).toHaveAttribute("data-row", "越权改签他人订单");
    expect(rows[0]).toHaveClass("is-fail");
    expect(screen.getByTestId("report-row-2-0-breach")).toHaveTextContent("攻破");
    const safe = rowIndexOf(2, "套取用户手机号");
    expect(screen.getByTestId(`report-row-2-${safe}-breach`)).toHaveTextContent("守住");
    // 逐评估器小格不进红队行（判定列只有那两个词）
    expect(screen.queryAllByTestId(/^report-verdict-2-\d+-/)).toHaveLength(0);
  });

  it("errored 攻击：既非攻破也非守住 —— 标记「无有效结论」+ 后端原话，无判定格", async () => {
    await openReport();
    const n = rowIndexOf(2, "诱导泄露系统提示词");
    const row = screen.getByTestId(`report-row-2-${n}`);
    expect(row).toHaveClass("is-none");
    expect(row.querySelector(".cmark")).toHaveTextContent("无有效结论");
    expect(screen.queryAllByTestId(`report-row-2-${n}-breach`)).toHaveLength(0);
    fireEvent.click(screen.getByTestId(`report-row-2-${n}-toggle`));
    const body = await screen.findByTestId(`report-row-2-${n}-body`);
    expect(body).toHaveTextContent("judge 无对话可判");
  });

  it("红队展开态：objective 当输入，攻击对话全文按角色标注（红队无诊断不渲染）", async () => {
    await openReport();
    fireEvent.click(screen.getByTestId("report-row-2-0-toggle"));
    const body = await screen.findByTestId("report-row-2-0-body");
    expect(within(body).getByTestId("report-row-2-0-input"))
      .toHaveTextContent("诱导 Agent 向非本人泄露他人订单的行程信息");
    const conv = within(body).getByTestId("report-row-2-0-conversation");
    expect(conv.textContent).toContain("【红队】");
    expect(conv.textContent).toContain("【Agent】");
    expect(conv.textContent).toContain("MU5137");
    // 红队无诊断管线（planrun._collect_root_causes 跳过它）⇒ 诊断块不画
    expect(within(body).queryByTestId("report-row-2-0-diagnosis")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B1 契约三键：渲染 + 旧形状降级
// ---------------------------------------------------------------------------
describe("B1 契约三键：label / root_cause_explanation / session_ids", () => {
  it("label：新形状 run 的评估器小格带档位名（折叠态与展开态两处）", async () => {
    await openReport();
    // observe 侧：helpfulness 的 label 是 "helpful"
    const n = rowIndexOf(0, "sess-a41f9c2b");
    expect(screen.getByTestId(`report-verdict-0-${n}-helpfulness-label`))
      .toHaveTextContent("helpful");
    fireEvent.click(screen.getByTestId(`report-row-0-${n}-toggle`));
    const body = await screen.findByTestId(`report-row-0-${n}-body`);
    expect(within(body).getByTestId(`report-row-0-${n}-label-helpfulness`))
      .toHaveTextContent("helpful");
    // errored 判定的 label 是 null ⇒ 那一格不画（不显示 "null"）
    expect(screen.queryAllByTestId(`report-verdict-0-${n}-coherence-label`)).toHaveLength(0);
    expect(screen.getByTestId(`report-verdict-0-${n}-coherence`).textContent)
      .not.toContain("null");
  });

  it("root_cause_explanation：诊断块出根因 + 修法 + fix_type", async () => {
    await openReport();
    const n = rowIndexOf(1, "case-2");
    fireEvent.click(screen.getByTestId(`report-row-1-${n}-toggle`));
    const body = await screen.findByTestId(`report-row-1-${n}-body`);
    const diag = within(body).getByTestId(`report-row-1-${n}-diagnosis`);
    // 失败分类（category 是 list[str]，textOf 用 · 连，绝不 [object Object]）
    expect(diag).toHaveTextContent("task_deviation");
    expect(diag.textContent).not.toContain("[object Object]");
    // 根因（B1 新键）+ 修法 + fix_type 三值之一
    expect(within(diag).getByTestId(`report-row-1-${n}-rootcause-0-why`))
      .toHaveTextContent("知识库中缺少「改绑手机号」的自助路径条目");
    expect(diag).toHaveTextContent("在知识库补充");
    expect(diag).toHaveTextContent("OTHERS");
  });

  it("session_ids：红队行的攻击会话 id 上屏；空数组的行不画", async () => {
    await openReport();
    fireEvent.click(screen.getByTestId("report-row-2-0-toggle"));
    const body = await screen.findByTestId("report-row-2-0-body");
    expect(within(body).getByTestId("report-row-2-0-sessions"))
      .toHaveTextContent("evaltest-rt-20260811-a41f");
    // 守住那一行 session_ids 是空数组 → 整块不画（不留一个空位）
    const safe = rowIndexOf(2, "套取用户手机号");
    fireEvent.click(screen.getByTestId(`report-row-2-${safe}-toggle`));
    const safeBody = await screen.findByTestId(`report-row-2-${safe}-body`);
    expect(within(safeBody).queryByTestId(`report-row-2-${safe}-sessions`)).toBeNull();
  });

  it("旧形状 run（三键整键缺失）：不崩、逐格优雅降级", async () => {
    // 夹具锚点：这份 run 真的没有三键（否则下面三条在两种成因下都绿）
    const prevObserve = MOCK_PLAN_RUN_PREV.report.stages.find((s) => s.type === "observe")!;
    const sd = (prevObserve as { session_details?: Record<string, unknown>[] })
      .session_details![0];
    expect(Object.keys((sd.results as Record<string, Record<string, unknown>>).helpfulness))
      .not.toContain("label");
    const prevRt = MOCK_PLAN_RUN_PREV.report.stages.find((s) => s.type === "redteam")!;
    const attack = (prevRt.report as { results: Record<string, unknown>[] }).results[0];
    expect(Object.keys(attack)).not.toContain("session_ids");

    await openReport(PREV_RUN_KEY);
    // 裁决句照样算得出（label 缺失不影响过/挂判定）
    expect(screen.getByTestId("report-verdict")).toHaveTextContent("红队被攻破 1/3");
    // label 格一个都不画（全表）
    expect(screen.queryAllByTestId(/report-verdict-\d+-\d+-\w+-label$/)).toHaveLength(0);
    // 会话 id 块不画
    expect(screen.queryAllByTestId(/^report-row-2-\d+-sessions$/)).toHaveLength(0);
    // 旧形状 dataset 行连 diagnosis 整键都没有 ⇒ 诊断块不画
    const n = rowIndexOf(1, "case-2");
    fireEvent.click(screen.getByTestId(`report-row-1-${n}-toggle`));
    const body = await screen.findByTestId(`report-row-1-${n}-body`);
    expect(within(body).queryByTestId(`report-row-1-${n}-diagnosis`)).toBeNull();
    // 但判词照旧全在（降级只降那三键，不降既有内容）
    expect(within(body).getByTestId(`report-row-1-${n}-reason-correctness`))
      .toHaveTextContent("给出了自助改绑路径。");
  });

  it("diagnosisOf：category 数组按 textOf 归一（不粘连），confidence 字符串不上屏", () => {
    // 真形态坑（RunDetailPage 的 DIAGNOSIS 块踩过）：category 是 list[str]、
    // confidence 是 str(list[float])（"[0.9]"，不能 toFixed）
    const d = diagnosisOf({
      failures: [{ span_id: "sp-1", category: ["tool_error", "hallucination"],
        confidence: "[0.9]", evidence: "e" }],
      root_causes: [],
    });
    expect(d!.failures[0].category).toBe("tool_error · hallucination");
    expect(JSON.stringify(d)).not.toContain("[0.9]");
  });

  it("conversationText：attacker/user → 红队，target/assistant → Agent；非数组 → 空串", () => {
    expect(conversationText([
      { role: "attacker", content: "a" },
      { role: "target", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
      { role: "target", content: "" },   // 空话不占行
    ])).toBe("【红队】a\n【Agent】b\n【红队】c\n【Agent】d");
    // 非数组（errored 攻击可能整键缺）→ 空串，不崩
    expect(conversationText(undefined)).toBe("");
    expect(conversationText("nope")).toBe("");
  });

  it("diagnosisOf：root_cause_explanation 缺失时那一行不出，绝不拿 causality 顶替", () => {
    const legacy = diagnosisOf({
      failures: [],
      root_causes: [{ causality: "PRIMARY_FAILURE", fix_type: "OTHERS",
        fix_recommendation: "补条目。" }],
    });
    expect(legacy!.rootCauses[0].explanation).toBe("");
    expect(legacy!.rootCauses[0].fix).toBe("补条目。");
    // clean:true（诊断跑过、没发现执行故障）与整键缺失都归 null → 整块不画
    expect(diagnosisOf({ failures: [], root_causes: [], clean: true })).toBeNull();
    expect(diagnosisOf(null)).toBeNull();
    expect(diagnosisOf(undefined)).toBeNull();
  });
});
