// 运行报告页「坏例入数据集 + 人工标注」抽屉（ADR-0017 D1 + D2；批 badcase-frontend）。
//
// 夹具 = 桩里的纯线上评估 run（handlers.ts MOCK_PLAN_RUN_OBSERVE：4 会话 × 4 评估器，
// 会话 #2 只有 conciseness 未过、#3 四项全未过、#4 conciseness 未过 ⇒ 3 个未过会话）+
// 三环节同场的 MOCK_PLAN_RUN（dataset 行 case-2 correctness 未过 = **不给入口**的阳性对照；
// redteam 行「越权改签他人订单」攻破 = 有入口）。期望值一律从夹具现算，锚点挑目标数据专属文本
//（test-waitfor-anchor-discipline：门槛数据 ≠ 断言数据）。
//
// 契约（与批 badcase-backend 同一份，docs/payload-contract.md「坏例入数据集与人工标注」节）：
//   append_dataset_cases → dataset_cases_appended {dataset, kind, added, updated, skipped_duplicates, case_count, created}
//   annotate_case → case_annotated {annotation:{run_key,row_key,evaluator,human_score,label,comment,by,at}}
//   list_annotations → annotations {run_key, items}
// 最后一组 describe 直接打 mock handler，钉 mock 形状与契约逐字同形（键集全等 + 错误原话）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReportPage, { splitReportId } from "../src/pages/report/ReportPage";
import DatasetsPage from "../src/pages/resources/DatasetsPage";
import { parseHash } from "../src/router";
import {
  ANNOTATIONS, DATASETS, MOCK_ACCESS_TOKEN, MOCK_PLAN_RUN, MOCK_PLAN_RUN_OBSERVE, OBSERVE_PLAN_RUNS,
  OBSERVE_RUN_KEY, PLAN_RUNS, sseFrames,
} from "../src/mocks/handlers";
import { matrixRowAnchor, shortSessionId } from "../src/pages/plan/reportRows";
import {
  buildCase, caseNameOf, defaultDatasetName, expectedBlockReason, normalizeInput, type IntakeItem,
} from "../src/pages/report/badcase";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import { expectProseGone } from "./prose";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
const MIXED_RUN_KEY = "plan-aaa111#2026-08-11T09:00:00Z";

type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};
let calls: Payload[] = [];

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** 默认桩：读的照 report-page-a；三个新 action 回契约形状（形状本身另在最后一组 describe 用真 mock 钉） */
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
  list_annotations: (p) => [{
    event: "annotations", run_key: p.run_key,
    items: ANNOTATIONS.filter((a) => a.run_key === p.run_key),
  }],
  annotate_case: (p) => [{
    event: "case_annotated",
    annotation: {
      run_key: p.run_key, row_key: p.row_key, evaluator: p.evaluator, human_score: p.human_score,
      label: p.label ?? null, comment: p.comment ?? null, by: "manual", at: "2026-09-07T09:30:00Z",
    },
  }],
  append_dataset_cases: (p) => {
    const cases = p.cases as unknown[];
    return [{
      event: "dataset_cases_appended", dataset: p.dataset, kind: p.kind,
      added: cases.length, updated: 0, skipped_duplicates: 0, case_count: cases.length, created: true,
    }];
  },
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

function renderReport(id: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ReportPage id={id} /></QueryClientProvider>);
}
function renderDatasets() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><DatasetsPage /></QueryClientProvider>);
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
type Results = Record<string, { score: number; passed: boolean; errored: boolean; label: string; reason: string }>;
const resultsOf = (i: number) => SESSIONS[i].results as unknown as Results;
const failedOf = (i: number) => Object.keys(resultsOf(i)).filter((ev) => resultsOf(i)[ev].passed === false && !resultsOf(i)[ev].errored);
/** 矩阵行序 = 后端原序（会话 #n = session_details[n-1]） */
const FAIL_ROWS = SESSIONS.map((_, i) => i).filter((i) => failedOf(i).length > 0);
/** 只有一项未过的会话（抽屉「为何是坏例」没有「另 N 项」）——挑它当主锚点 */
const ONE = FAIL_ROWS.find((i) => failedOf(i).length === 1)!;
const ONE_EV = failedOf(ONE)[0];
const ONE_SID = SESSIONS[ONE].session_id;
const ONE_SHORT = shortSessionId(ONE_SID);
const transcriptOf = (i: number) => (SESSIONS[i].transcript as { events: { type: string; text: string }[] }).events;
const ONE_INPUT = transcriptOf(ONE).find((e) => e.type === "user")!.text;
const ONE_REPLY = transcriptOf(ONE).filter((e) => e.type === "assistant").at(-1)!.text;
/** 全部未过的会话（预置人工标注挂在它的 conciseness 上） */
const ALL = FAIL_ROWS.find((i) => failedOf(i).length === Object.keys(resultsOf(i)).length)!;
const ALL_SID = SESSIONS[ALL].session_id;
const PRESET = ANNOTATIONS.find((a) => a.run_key === OBSERVE_RUN_KEY)!;
/** 通过的格（阴性对照：不给入口） */
const PASS_ROW = SESSIONS.findIndex((_, i) => failedOf(i).length === 0);
const PASS_EV = Object.keys(resultsOf(PASS_ROW))[0];
const AGENT = MOCK_PLAN_RUN_OBSERVE.agent_name;
const DEFAULT_DS = defaultDatasetName(AGENT, "regression");

const cellId = (n: number, ev: string) => `report-cell-0-${n}-${ev}`;

async function openReport() {
  renderReport(OBSERVE_RUN_KEY);
  // 锚点：目标行专属的格（不是页面壳）
  await screen.findByTestId(cellId(ONE, ONE_EV));
}

async function openDrawerOn(n: number, ev: string, via: "intake" | "annotate" = "intake") {
  fireEvent.click(screen.getByTestId(cellId(n, ev)));
  fireEvent.click(await screen.findByTestId(`${cellId(n, ev)}-detail-${via}`));
  const drawer = await screen.findByTestId("badcase-drawer");
  await within(drawer).findByTestId("badcase-expected");
  return drawer;
}

/** 已在集内的夹具：input 与会话 #ONE 的用户输入只差空白/大小写（去重键归一化后全等） */
function insetDataset(rowSid = ONE_SID, input = ONE_INPUT) {
  return {
    name: DEFAULT_DS, kind: "regression", case_count: 1, target_agent: AGENT, updated_at: 1757000000,
    cases: [{
      name: "old-1", input: `  ${input.toUpperCase()}  `, expected_output: "集内旧期望",
      source: { run_key: "plan-ddd666#20260820000000", row_key: rowSid, kind: "session", evaluators_failed: ["conciseness"], score: 0, added_at: "2026-08-20T00:00:00Z" },
    }],
  };
}

describe("入口：只在「判未过且非 errored」的格上；dataset 行没有（ADR-0017 D1）", () => {
  it("observe 未过格详情有「加入数据集」「标注」两个按钮；通过格没有", async () => {
    await openReport();
    fireEvent.click(screen.getByTestId(cellId(ONE, ONE_EV)));
    const detail = await screen.findByTestId(`${cellId(ONE, ONE_EV)}-detail`);
    expect(within(detail).getByTestId(`${cellId(ONE, ONE_EV)}-detail-intake`)).toHaveTextContent("加入数据集");
    expect(within(detail).getByTestId(`${cellId(ONE, ONE_EV)}-detail-annotate`)).toHaveTextContent("标注");
    fireEvent.click(screen.getByTestId(cellId(PASS_ROW, PASS_EV)));
    const pass = await screen.findByTestId(`${cellId(PASS_ROW, PASS_EV)}-detail`);
    expect(within(pass).queryByTestId(`${cellId(PASS_ROW, PASS_EV)}-detail-intake`)).toBeNull();
    expect(within(pass).queryByTestId(`${cellId(PASS_ROW, PASS_EV)}-detail-annotate`)).toBeNull();
  });

  it("dataset 行的未过格没有入口；redteam 攻破行有入口；页脚只数会话", async () => {
    const stages = MOCK_PLAN_RUN.report.stages as { type: string; report?: { results?: unknown[] } }[];
    const dsGi = stages.findIndex((s) => s.type === "dataset");
    const rtGi = stages.findIndex((s) => s.type === "redteam");
    const dsCases = stages[dsGi].report!.results as { results: Results }[];
    const dsN = dsCases.findIndex((c) => Object.values(c.results).some((v) => v.passed === false && !v.errored));
    const dsEv = Object.keys(dsCases[dsN].results).find((ev) => dsCases[dsN].results[ev].passed === false)!;
    const rtCases = stages[rtGi].report!.results as { breached: boolean; case_name: string }[];
    const rtN = rtCases.findIndex((c) => c.breached === true);
    expect(dsN).toBeGreaterThanOrEqual(0);
    expect(rtN).toBeGreaterThanOrEqual(0);

    location.hash = `#/report/${encodeURIComponent(MIXED_RUN_KEY)}`;
    renderReport(MIXED_RUN_KEY);
    const dsCell = await screen.findByTestId(`report-cell-${dsGi}-${dsN}-${dsEv}`);
    fireEvent.click(dsCell);
    const dsDetail = await screen.findByTestId(`report-cell-${dsGi}-${dsN}-${dsEv}-detail`);
    expect(within(dsDetail).queryByTestId(`report-cell-${dsGi}-${dsN}-${dsEv}-detail-intake`)).toBeNull();

    fireEvent.click(screen.getByTestId(`report-cell-${rtGi}-${rtN}-result`));
    const rtDetail = await screen.findByTestId(`report-cell-${rtGi}-${rtN}-result-detail`);
    expect(within(rtDetail).getByTestId(`report-cell-${rtGi}-${rtN}-result-detail-intake`)).toBeInTheDocument();
    // 页脚：本 run 的 observe 明细未过会话 + 攻破攻击一起数，文案分开报
    // session_error 支只有 {agent, session_id, error}（results 整键缺）⇒ 兜成空对象
    const observeFails = (stages[0] as { session_details?: { results?: Results }[] }).session_details!
      .filter((s) => Object.values(s.results ?? {}).some((v) => v.passed === false && !v.errored)).length;
    const breached = rtCases.filter((c) => c.breached === true).length;
    expect(breached).toBeGreaterThan(0);
    // 文案三分：只有会话 / 只有攻击 / 两者都有（夹具现算走哪一支就钉哪一句）
    // 文案改「从 … 中选择加入数据集…」（用户 2026-09-07 反馈：「把本次 N 个…加入数据集」读成一键全加）
    const label = observeFails === 0
      ? `从 ${breached} 个被攻破攻击中选择加入数据集…`
      : `从 ${observeFails} 个未过会话 · ${breached} 个被攻破攻击中选择加入数据集…`;
    expect(screen.getByTestId("report-intake-all")).toHaveTextContent(label);
  });
});

describe("单格态：预填错答草稿 + 门（相同 ⇒ 禁用，改一字 ⇒ 可用）", () => {
  it("期望输出预填 Agent 回复并带警示条；未改 ⇒ 「加入数据集」禁用并写原因；改一字 ⇒ 可用、警示消失", async () => {
    await openReport();
    const drawer = await openDrawerOn(ONE, ONE_EV);
    expect(within(drawer).getByTestId("badcase-title")).toHaveTextContent(ONE_INPUT);
    const ta = within(drawer).getByTestId("badcase-expected") as HTMLTextAreaElement;
    expect(ta.value).toBe(ONE_REPLY);
    expect(within(drawer).getByTestId("badcase-expected-warn")).toHaveTextContent("这是错答，请改成正确答案");
    const add = within(drawer).getByTestId("badcase-add") as HTMLButtonElement;
    expect(add).toBeDisabled();
    expect(add).toHaveTextContent("加入数据集");
    expect(within(drawer).getByTestId("badcase-add-reason")).toHaveTextContent("未改动");
    // 数据集下拉默认 <agent>-badcases，桩里不存在 ⇒ 「将自动创建」
    expect((within(drawer).getByTestId("badcase-ds") as HTMLSelectElement).value).toBe(DEFAULT_DS);
    expect(within(drawer).getByTestId("badcase-ds-create")).toHaveTextContent("将自动创建");
    // 为何是坏例：评估器 · 分 · 标签（judge 原话）；只有一项未过 ⇒ 没有「另 N 项」
    const why = within(drawer).getByTestId("badcase-why");
    expect(why).toHaveTextContent(ONE_EV);
    expect(why).toHaveTextContent(resultsOf(ONE)[ONE_EV].score.toFixed(3));
    expect(why).toHaveTextContent(resultsOf(ONE)[ONE_EV].label);
    expect(within(drawer).queryByTestId("badcase-also")).toBeNull();

    fireEvent.change(ta, { target: { value: `${ONE_REPLY}!` } });
    expect(add).not.toBeDisabled();
    expect(within(drawer).queryByTestId("badcase-add-reason")).toBeNull();
    expect(within(drawer).queryByTestId("badcase-expected-warn")).toBeNull();
    // 清空 ⇒ 又禁用（regression 集 expected_output 必填）
    fireEvent.change(ta, { target: { value: "   " } });
    expect(add).toBeDisabled();
    expect(within(drawer).getByTestId("badcase-add-reason")).toHaveTextContent("为空");
  });

  it("四项全未过的会话：「同会话另 N 项未过」chip 数 = 未过数 - 1", async () => {
    await openReport();
    const ev = failedOf(ALL)[0];
    const drawer = await openDrawerOn(ALL, ev);
    const also = within(drawer).getByTestId("badcase-also");
    expect(also).toHaveTextContent(`同会话另 ${failedOf(ALL).length - 1} 项未过`);
    for (const other of failedOf(ALL).filter((x) => x !== ev)) expect(also).toHaveTextContent(other);
  });

  it("抽屉里没有通用散文与禁词", async () => {
    await openReport();
    const drawer = await openDrawerOn(ONE, ONE_EV);
    expectProseGone(drawer, "这些用例会进入回归", "黄金", "方案", "工作台");
  });
});

describe("去重预判：同题面已在集内 ⇒「已在集内」+ 主按钮变「更新期望」", () => {
  it("归一化后全等（首尾空白 / 折叠空白 / 大小写）即命中；期望预填集内现值", async () => {
    overrides.list_datasets = () => [{ event: "datasets", datasets: [insetDataset()] }];
    await openReport();
    const drawer = await openDrawerOn(ONE, ONE_EV);
    expect(within(drawer).getByTestId("badcase-inset")).toHaveTextContent("已在集内");
    const add = within(drawer).getByTestId("badcase-add");
    expect(add).toHaveTextContent("更新期望");
    expect((within(drawer).getByTestId("badcase-expected") as HTMLTextAreaElement).value).toBe("集内旧期望");
    expect(add).not.toBeDisabled();
    fireEvent.click(add);
    await waitFor(() => expect(calls.some((c) => c.action === "append_dataset_cases")).toBe(true));
    const req = calls.find((c) => c.action === "append_dataset_cases")!;
    expect(req.on_duplicate).toBe("update");
    expect(req.dataset).toBe(DEFAULT_DS);
  });

  it("normalizeInput：strip → 连续空白折一个空格 → casefold", () => {
    expect(normalizeInput("  A  b\t\nC ")).toBe("a b c");
    expect(normalizeInput("解释 TCP")).toBe(normalizeInput("解释  tcp"));
    expect(normalizeInput("a b")).not.toBe(normalizeInput("ab"));
  });
});

describe("成功态 + 矩阵「已入集」（本会话态 + reload 后靠 source 反查）", () => {
  it("加入后：抽屉顶部成功行 · 打开数据集深链 · 首次创建多一句建计划 · 矩阵未过格打「已入集」", async () => {
    await openReport();
    const drawer = await openDrawerOn(ONE, ONE_EV);
    fireEvent.change(within(drawer).getByTestId("badcase-expected"), { target: { value: "正确答案" } });
    fireEvent.click(within(drawer).getByTestId("badcase-add"));
    const ok = await within(drawer).findByTestId("badcase-success");
    expect(ok).toHaveTextContent(`已加入 ${DEFAULT_DS} · 共 1 条`);
    expect(within(ok).getByTestId("badcase-open-dataset")).toHaveAttribute("href", "#/datasets");
    // 建计划链接带 ?dataset=<入集的那个集合>（编辑器据此预填数据集环节；反解回路由 = plan-new + dataset）
    const newPlan = within(ok).getByTestId("badcase-new-plan");
    expect(newPlan).toHaveAttribute("href", `#/plan/new?dataset=${encodeURIComponent(DEFAULT_DS)}`);
    expect(parseHash(newPlan.getAttribute("href")!)).toEqual({ view: "plan-new", dataset: DEFAULT_DS });
    // 矩阵：未过格出现「已入集」，同行通过格不出现
    expect(await screen.findByTestId(`${cellId(ONE, ONE_EV)}-added`)).toHaveTextContent("已入集");
    const passEv = Object.keys(resultsOf(ONE)).find((ev) => resultsOf(ONE)[ev].passed === true)!;
    expect(screen.queryByTestId(`${cellId(ONE, passEv)}-added`)).toBeNull();
    // 请求体形状（与契约同形）
    const req = calls.find((c) => c.action === "append_dataset_cases")!;
    expect(req).toMatchObject({
      dataset: DEFAULT_DS, kind: "regression", create_if_missing: true, target_agent: AGENT, on_duplicate: "skip",
    });
    const c = (req.cases as Record<string, unknown>[])[0];
    expect(Object.keys(c).sort()).toEqual(["expected_output", "input", "name", "source"]);
    expect(c.input).toBe(ONE_INPUT);
    expect(c.expected_output).toBe("正确答案");
    expect(c.source).toMatchObject({
      run_key: OBSERVE_RUN_KEY, row_key: ONE_SID, kind: "session", evaluators_failed: [ONE_EV],
      score: resultsOf(ONE)[ONE_EV].score,
    });
    expect(String((c.source as { added_at: string }).added_at)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(c.name).toBe(`${OBSERVE_RUN_KEY.split("#")[1]}-${ONE_SHORT}`);
  });

  it("reload：list_datasets 里某用例 source.run_key = 本 run ⇒ 对应行未过格直接显示「已入集」", async () => {
    overrides.list_datasets = () => [{
      event: "datasets",
      datasets: [{
        name: DEFAULT_DS, kind: "regression", case_count: 1, target_agent: AGENT, updated_at: 1757000000,
        cases: [{
          name: "x", input: "别的题面", expected_output: "y",
          source: { run_key: OBSERVE_RUN_KEY, row_key: ONE_SID, kind: "session", evaluators_failed: [ONE_EV], score: 0, added_at: "2026-09-07T00:00:00Z" },
        }],
      }],
    }];
    await openReport();
    expect(await screen.findByTestId(`${cellId(ONE, ONE_EV)}-added`)).toHaveTextContent("已入集");
    // 别的未过会话没有
    expect(screen.queryByTestId(`${cellId(ALL, failedOf(ALL)[0])}-added`)).toBeNull();
  });
});

describe("批量态（页脚入口）：默认不勾；复选框永远可勾；勾了未改期望 ⇒ 不计入「加入 N 条」并给行内提示", () => {
  it("页脚「从 N 个未过会话中选择加入数据集…」N = 未过会话数；N=0 隐藏", async () => {
    await openReport();
    expect(screen.getByTestId("report-intake-all")).toHaveTextContent(`从 ${FAIL_ROWS.length} 个未过会话中选择加入数据集…`);
    cleanup();
    // 全过的 run：把每个判定都改成 passed ⇒ 页脚没有入口
    overrides.get_plan_run = (p) => [{
      event: "plan_run", ...MOCK_PLAN_RUN_OBSERVE, run_key: p.run_key,
      report: {
        ...MOCK_PLAN_RUN_OBSERVE.report,
        stages: [{
          ...OBS_STAGE,
          session_details: SESSIONS.map((s) => ({
            ...s,
            results: Object.fromEntries(Object.entries(s.results as Results).map(([k, v]) => [k, { ...v, passed: true, score: 1 }])),
          })),
        }],
      },
    }];
    renderReport(OBSERVE_RUN_KEY);
    await screen.findByTestId(cellId(ONE, ONE_EV));
    expect(screen.queryByTestId("report-intake-all")).toBeNull();
  });

  it("抽屉标题「选择要加入数据集的会话」；默认 0 勾选；复选框都可勾；勾了未改 ⇒ 加入 0 条 + 行内「期望输出未改」提示 + 底部「M 条已勾但期望未改」", async () => {
    await openReport();
    fireEvent.click(screen.getByTestId("report-intake-all"));
    const drawer = await screen.findByTestId("badcase-drawer");
    await within(drawer).findByTestId("badcase-batch-list");
    expect(within(drawer).getByTestId("badcase-title")).toHaveTextContent("选择要加入数据集的会话");
    expect(within(drawer).getByTestId("badcase-title")).not.toHaveTextContent("把本次");
    const list = within(drawer).getByTestId("badcase-batch-list");
    expect(list.querySelectorAll("li").length).toBe(FAIL_ROWS.length);
    for (const i of FAIL_ROWS) {
      const cb = within(drawer).getByTestId(`badcase-batch-check-${shortSessionId(SESSIONS[i].session_id)}`) as HTMLInputElement;
      expect(cb).not.toBeDisabled();
      expect(cb.checked).toBe(false);
    }
    expect(within(drawer).getByTestId("badcase-batch-selected")).toHaveTextContent(`0 / ${FAIL_ROWS.length}`);
    const submit = within(drawer).getByTestId("badcase-batch-submit") as HTMLButtonElement;
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent("加入 0 条");
    expect(within(drawer).queryByTestId("badcase-batch-unedited")).toBeNull();

    // 勾第一行（期望未改）⇒ 勾得上；已选 1；加入仍 0；行内琥珀提示；底部小字 1 条已勾但期望未改
    const first = FAIL_ROWS[0];
    const short1 = shortSessionId(SESSIONS[first].session_id);
    const cb1 = within(drawer).getByTestId(`badcase-batch-check-${short1}`) as HTMLInputElement;
    fireEvent.click(cb1);
    expect(cb1.checked).toBe(true);
    expect(within(drawer).getByTestId("badcase-batch-selected")).toHaveTextContent(`1 / ${FAIL_ROWS.length}`);
    expect(submit).toHaveTextContent("加入 0 条");
    expect(submit).toBeDisabled();
    expect(within(drawer).getByTestId(`badcase-batch-state-${short1}`)).toHaveTextContent("期望输出未改 · 点行编辑");
    expect(within(drawer).getByTestId("badcase-batch-unedited")).toHaveTextContent("1 条已勾但期望未改");
    // 未勾的行不提示（提示只对「勾了却没改」的行说）
    const other = FAIL_ROWS.find((i) => i !== first)!;
    expect(within(drawer).getByTestId(`badcase-batch-state-${shortSessionId(SESSIONS[other].session_id)}`)).not.toHaveTextContent("点行编辑");

    // 改一字 ⇒ 加入 1 条、提示消失、可提交
    const ta = within(drawer).getByTestId("badcase-batch-expected") as HTMLTextAreaElement;
    expect(ta.value).toBe(transcriptOf(first).filter((e) => e.type === "assistant").at(-1)!.text);
    fireEvent.change(ta, { target: { value: `${ta.value}!` } });
    expect(submit).toHaveTextContent("加入 1 条");
    expect(submit).not.toBeDisabled();
    expect(within(drawer).queryByTestId("badcase-batch-unedited")).toBeNull();
    expect(within(drawer).getByTestId(`badcase-batch-state-${short1}`)).toHaveTextContent("✓ 期望输出");
    // 取消勾选 ⇒ 加入 0 条（改过但没勾也不加）
    fireEvent.click(cb1);
    expect(submit).toHaveTextContent("加入 0 条");
    expect(within(drawer).getByTestId("badcase-batch-selected")).toHaveTextContent(`0 / ${FAIL_ROWS.length}`);
  });

  it("全选：勾上全部行，「加入 N 条」只算已改；点行 ⇒ 右侧期望输出文本域聚焦", async () => {
    await openReport();
    fireEvent.click(screen.getByTestId("report-intake-all"));
    const drawer = await screen.findByTestId("badcase-drawer");
    await within(drawer).findByTestId("badcase-batch-list");
    const selall = within(drawer).getByTestId("badcase-batch-selall") as HTMLInputElement;
    const submit = within(drawer).getByTestId("badcase-batch-submit") as HTMLButtonElement;
    fireEvent.click(selall);
    expect(selall.checked).toBe(true);
    for (const i of FAIL_ROWS) {
      expect((within(drawer).getByTestId(`badcase-batch-check-${shortSessionId(SESSIONS[i].session_id)}`) as HTMLInputElement).checked).toBe(true);
    }
    expect(within(drawer).getByTestId("badcase-batch-selected")).toHaveTextContent(`${FAIL_ROWS.length} / ${FAIL_ROWS.length}`);
    expect(submit).toHaveTextContent("加入 0 条");
    expect(within(drawer).getByTestId("badcase-batch-unedited")).toHaveTextContent(`${FAIL_ROWS.length} 条已勾但期望未改`);
    // 点第二行 ⇒ 当前行切换、文本域聚焦、预填该行的错答草稿
    const second = FAIL_ROWS[1];
    fireEvent.click(within(within(drawer).getByTestId("badcase-batch-list")).getByText(transcriptOf(second).find((e) => e.type === "user")!.text));
    const ta = within(drawer).getByTestId("badcase-batch-expected") as HTMLTextAreaElement;
    expect(ta.value).toBe(transcriptOf(second).filter((e) => e.type === "assistant").at(-1)!.text);
    expect(document.activeElement).toBe(ta);
    fireEvent.change(ta, { target: { value: "改好的期望" } });
    expect(submit).toHaveTextContent("加入 1 条");
    expect(within(drawer).getByTestId("badcase-batch-unedited")).toHaveTextContent(`${FAIL_ROWS.length - 1} 条已勾但期望未改`);
    // 提交只带那 1 条
    fireEvent.click(submit);
    await within(drawer).findByTestId("badcase-success");
    const req = calls.find((c) => c.action === "append_dataset_cases")!;
    expect((req.cases as { source: { row_key: string } }[]).map((c) => c.source.row_key)).toEqual([SESSIONS[second].session_id]);
    expect(req.on_duplicate).toBe("skip");
  });

  it("已在集内的行：预填集内现值（≠ 草稿 ⇒ 有效）、默认不勾、勾上计为「更新」；提交 on_duplicate=update", async () => {
    overrides.list_datasets = () => [{ event: "datasets", datasets: [insetDataset(ALL_SID, transcriptOf(ALL).find((e) => e.type === "user")!.text)] }];
    await openReport();
    fireEvent.click(screen.getByTestId("report-intake-all"));
    const drawer = await screen.findByTestId("badcase-drawer");
    const list = await within(drawer).findByTestId("badcase-batch-list");
    // 进度 = 已填好期望的行：未改的草稿不算；已在集内那行预填集内现值算 1
    expect(within(drawer).getByTestId("badcase-progress")).toHaveTextContent(`1 / ${FAIL_ROWS.length}`);
    expect(within(drawer).getByTestId(`badcase-batch-inset-${shortSessionId(ALL_SID)}`)).toHaveTextContent("已在集内");
    const submit = within(drawer).getByTestId("badcase-batch-submit") as HTMLButtonElement;
    expect(submit).toBeDisabled();
    // 改第一行 ⇒ 勾上它 ⇒ 加入 1
    const first = FAIL_ROWS[0];
    const ta = within(drawer).getByTestId("badcase-batch-expected") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "改好的期望" } });
    fireEvent.click(within(drawer).getByTestId(`badcase-batch-check-${shortSessionId(SESSIONS[first].session_id)}`));
    expect(within(drawer).getByTestId("badcase-progress")).toHaveTextContent(`2 / ${FAIL_ROWS.length}`);
    expect(submit).toHaveTextContent("加入 1 条");
    expect(submit).not.toHaveTextContent("更新");
    // 切到已在集内那一行：期望预填集内现值，默认不勾；勾上 ⇒ 「加入 1 条 · 更新 1 条」
    fireEvent.click(within(list).getByText(transcriptOf(ALL).find((e) => e.type === "user")!.text));
    const ta2 = within(drawer).getByTestId("badcase-batch-expected") as HTMLTextAreaElement;
    expect(ta2.value).toBe("集内旧期望");
    const cb2 = within(drawer).getByTestId(`badcase-batch-check-${shortSessionId(ALL_SID)}`) as HTMLInputElement;
    expect(cb2.checked).toBe(false);
    fireEvent.click(cb2);
    expect(submit).toHaveTextContent("加入 1 条 · 更新 1 条");
    expect(within(drawer).getByTestId("badcase-batch-selected")).toHaveTextContent(`2 / ${FAIL_ROWS.length}`);

    fireEvent.click(submit);
    await within(drawer).findByTestId("badcase-success");
    const req = calls.find((c) => c.action === "append_dataset_cases")!;
    expect(req.on_duplicate).toBe("update");
    expect((req.cases as unknown[]).length).toBe(2);
    // 两行都打「已入集」
    for (const sid of [SESSIONS[first].session_id, ALL_SID]) {
      const n = SESSIONS.findIndex((s) => s.session_id === sid);
      expect(await screen.findByTestId(`${cellId(n, failedOf(n)[0])}-added`)).toBeInTheDocument();
    }
  });

  it("批量抽屉里没有「把本次」一键全加的措辞、没有禁用的复选框", async () => {
    await openReport();
    fireEvent.click(screen.getByTestId("report-intake-all"));
    const drawer = await screen.findByTestId("badcase-drawer");
    await within(drawer).findByTestId("badcase-batch-list");
    expectProseGone(drawer, "把本次", "不能入选");
    expect(drawer.querySelectorAll("input[type=checkbox][disabled]").length).toBe(0);
  });
});

describe("人工标注（ADR-0017 D2）：机器分不变，人工分并列小胶囊", () => {
  it("页面加载拉一次 list_annotations；预置标注在对应格显示「人工 0.5」，机器分原样", async () => {
    await openReport();
    await waitFor(() => expect(calls.filter((c) => c.action === "list_annotations").length).toBe(1));
    expect(calls.find((c) => c.action === "list_annotations")!.run_key).toBe(OBSERVE_RUN_KEY);
    const n = SESSIONS.findIndex((s) => s.session_id === PRESET.row_key);
    const cell = await screen.findByTestId(cellId(n, PRESET.evaluator));
    const pill = within(cell).getByTestId(`${cellId(n, PRESET.evaluator)}-human`);
    expect(pill).toHaveTextContent("人工");
    expect(pill).toHaveTextContent(String(PRESET.human_score));
    // 机器分那一行不动
    expect(cell).toHaveTextContent(resultsOf(n)[PRESET.evaluator].score.toFixed(3));
    // 没标注的格没有胶囊
    expect(screen.queryByTestId(`${cellId(ONE, ONE_EV)}-human`)).toBeNull();
  });

  it("抽屉：选 0.5 → 仅保存标注 → annotate_case 请求体（human_score 是数字）→「已标注 · 0.5 · 时间」+ 矩阵胶囊", async () => {
    await openReport();
    const drawer = await openDrawerOn(ONE, ONE_EV, "annotate");
    const save = within(drawer).getByTestId("badcase-save-annot") as HTMLButtonElement;
    expect(save).toBeDisabled();
    expect((within(drawer).getByTestId("badcase-annot-type") as HTMLSelectElement).value).toBe(ONE_EV);
    fireEvent.click(within(drawer).getByTestId("badcase-score-0.5"));
    expect(within(drawer).getByTestId("badcase-score-0.5")).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(within(drawer).getByTestId("badcase-annot-comment"), { target: { value: "多了三条备选" } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    const state = await within(drawer).findByTestId("badcase-annot-state");
    expect(state).toHaveTextContent("已标注");
    expect(state).toHaveTextContent("0.5");
    expect(state).toHaveTextContent("2026-09-07 09:30");
    const req = calls.find((c) => c.action === "annotate_case")!;
    expect(req).toMatchObject({ run_key: OBSERVE_RUN_KEY, row_key: ONE_SID, evaluator: ONE_EV, human_score: 0.5, comment: "多了三条备选" });
    expect(typeof req.human_score).toBe("number");
    // 矩阵格立刻并列显示人工分（机器分不动）
    const pill = await screen.findByTestId(`${cellId(ONE, ONE_EV)}-human`);
    expect(pill).toHaveTextContent("人工");
    expect(pill).toHaveTextContent("0.5");
    expect(screen.getByTestId(cellId(ONE, ONE_EV))).toHaveTextContent(resultsOf(ONE)[ONE_EV].score.toFixed(3));
    // 没有再拉 list_annotations（就地写回缓存）
    expect(calls.filter((c) => c.action === "list_annotations").length).toBe(1);
  });

  it("预置标注的格打开抽屉：三键预选 0.5、显示「已标注」；「加入数据集」把人工分带进 source.human_score", async () => {
    await openReport();
    const n = SESSIONS.findIndex((s) => s.session_id === PRESET.row_key);
    const drawer = await openDrawerOn(n, PRESET.evaluator);
    expect(within(drawer).getByTestId("badcase-score-0.5")).toHaveAttribute("aria-pressed", "true");
    expect(within(drawer).getByTestId("badcase-annot-state")).toHaveTextContent("2026-09-04 07:12");
    fireEvent.change(within(drawer).getByTestId("badcase-expected"), { target: { value: "客户端 SYN → 服务器 SYN-ACK → 客户端 ACK。" } });
    fireEvent.click(within(drawer).getByTestId("badcase-add"));
    await within(drawer).findByTestId("badcase-success");
    const req = calls.find((c) => c.action === "append_dataset_cases")!;
    const c = (req.cases as Record<string, unknown>[])[0];
    expect((c.source as { human_score: number }).human_score).toBe(0.5);
    expect(c.notes).toBe(PRESET.comment);
  });

  it("三档按钮各挂一句逐档 title（现网反馈：只见 0 / 0.5 / 1 不知何意）；按钮组与说明 chip 挂同一句组 title", async () => {
    await openReport();
    const drawer = await openDrawerOn(ONE, ONE_EV, "annotate");
    // 逐字钉：三句必须各不相同（同一句复制三遍 = 没回答「这个分数是什么」）
    expect(within(drawer).getByTestId("badcase-score-0")).toHaveAttribute("title", "不合格：Agent 这一格的回答你判为错 / 未达标");
    expect(within(drawer).getByTestId("badcase-score-0.5")).toHaveAttribute("title", "部分合格：答对一部分或方向对但有明显缺陷");
    expect(within(drawer).getByTestId("badcase-score-1")).toHaveAttribute("title", "合格：你判这一格的回答达标");
    // 显示文字不变（fmtHuman）
    expect(within(drawer).getByTestId("badcase-score-0")).toHaveTextContent(/^0$/);
    expect(within(drawer).getByTestId("badcase-score-0.5")).toHaveTextContent(/^0\.5$/);
    expect(within(drawer).getByTestId("badcase-score-1")).toHaveTextContent(/^1$/);
    const group = within(drawer).getByRole("group", { name: "人工分" });
    const groupTitle = group.getAttribute("title") ?? "";
    expect(groupTitle).toContain("不改机器分");
    expect(groupTitle).toContain("一致率");
    expect(groupTitle).toContain("source.human_score");
    // 段标题旁的三档说明 chip：只在本节出现一次，title 与组同句
    const legend = within(drawer).getByTestId("badcase-score-legend");
    expect(legend).toHaveTextContent("0 · 0.5 · 1 三档，与评委分并列");
    expect(legend.getAttribute("title")).toBe(groupTitle);
    expect(drawer.querySelectorAll('[data-testid="badcase-score-legend"]').length).toBe(1);
  });
});

describe("深链 `?row=<行名>`：数据集页来源 chip 落到报告页该行", () => {
  it("splitReportId 切查询串；带 row 渲染 ⇒ 该行高亮 is-target", async () => {
    expect(splitReportId(OBSERVE_RUN_KEY)).toEqual({ runKey: OBSERVE_RUN_KEY, row: null });
    expect(splitReportId(`${OBSERVE_RUN_KEY}?row=${encodeURIComponent(ONE_SID)}`)).toEqual({ runKey: OBSERVE_RUN_KEY, row: ONE_SID });
    renderReport(`${OBSERVE_RUN_KEY}?row=${encodeURIComponent(ONE_SID)}`);
    await screen.findByTestId(cellId(ONE, ONE_EV));
    await waitFor(() => expect(document.getElementById(matrixRowAnchor(0, ONE_SID))!.className).toContain("is-target"));
    expect(screen.getByTestId("report-head-key")).toHaveTextContent(OBSERVE_RUN_KEY);
  });
});

describe("数据集页：带 source 的用例显示「来自 线上评估 run」chip 并深链；编辑器不丢 source / notes", () => {
  it("chip 文案 + href；无 source 的用例没有 chip；编辑 JSON 里两个键原样在", async () => {
    const ds = {
      name: DEFAULT_DS, kind: "regression", case_count: 2, target_agent: AGENT, risk_categories: [], updated_at: 1757000000,
      cases: [
        {
          name: "20260904013117-0e794382", input: ONE_INPUT, expected_output: "正确答案", notes: "评委理由摘要",
          source: { run_key: OBSERVE_RUN_KEY, row_key: ONE_SID, kind: "session", evaluators_failed: [ONE_EV], score: 0, human_score: 0.5, added_at: "2026-09-07T00:00:00Z" },
        },
        { name: "manual-1", input: "手工加的题", expected_output: "手工答案" },
      ],
    };
    overrides.list_datasets = () => [{ event: "datasets", datasets: [ds] }];
    location.hash = "#/datasets";
    renderDatasets();
    const row = await screen.findByTestId(`dataset-row-${DEFAULT_DS}`);
    expect(within(row).getByTestId(`dataset-row-${DEFAULT_DS}-sourced`)).toHaveTextContent("1 条坏例");
    fireEvent.click(within(row).getByTestId(`dataset-row-${DEFAULT_DS}-view`));
    const chip = await screen.findByTestId(`dataset-case-${DEFAULT_DS}-20260904013117-0e794382-source`);
    expect(chip).toHaveTextContent("来自 线上评估 run");
    expect(chip).toHaveAttribute("href", `#/report/${encodeURIComponent(OBSERVE_RUN_KEY)}?row=${encodeURIComponent(ONE_SID)}`);
    expect(screen.queryByTestId(`dataset-case-${DEFAULT_DS}-manual-1-source`)).toBeNull();
    // 编辑器：JSON 直编 ⇒ source / notes 原样在文本里（保存时 JSON.parse 回去也不会丢）
    fireEvent.click(within(row).getByTestId(`dataset-row-${DEFAULT_DS}-edit`));
    const ta = await screen.findByTestId("dataset-form-cases") as HTMLTextAreaElement;
    const parsed = JSON.parse(ta.value) as Record<string, unknown>[];
    expect(parsed[0].notes).toBe("评委理由摘要");
    expect(parsed[0].source).toEqual(ds.cases[0].source);
  });
});

// ---------------------------------------------------------------------------
// mock 形状 == 契约（直接打 mock handler，键集全等 + 错误原话逐字）
// ---------------------------------------------------------------------------
async function callMock(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { handlers } = await import("../src/mocks/handlers");
  const apiHandler = handlers.find((h) =>
    String((h as { info?: { path?: unknown } }).info?.path ?? "").includes("/api/invoke"))!;
  const res = await (apiHandler as unknown as {
    run: (a: { request: Request }) => Promise<{ response?: Response }>;
  }).run({
    request: new Request("http://localhost/api/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-authorization": `Bearer ${MOCK_ACCESS_TOKEN}` },
      body: JSON.stringify(payload),
    }),
  });
  const text = await res.response!.text();
  return JSON.parse(text.split("\n\n").filter(Boolean)[0].replace(/^data: /, ""));
}

const fakeItem = (): IntakeItem => ({
  gi: 0, kind: "regression", sourceKind: "session", input: "题面 X", reply: "错答",
  failed: [{ name: "conciseness", score: 0, passed: false, errored: false, reason: "r", label: "Not Concise" }],
  row: {
    key: "s#0", kind: "session", name: "sess-deadbeef01", sub: "", outcome: "fail", breached: null, note: null,
    input: "", expected: "", output: "错答", conversation: "", reason: "", sessionIds: [], diagnosis: null,
    verdicts: [{ name: "conciseness", score: 0, passed: false, errored: false, reason: "r", label: "Not Concise" }],
  },
});

describe("mock 形状与契约逐字同形（append_dataset_cases / annotate_case / list_annotations）", () => {
  it("append_dataset_cases：默认集不存在 ⇒ create_if_missing 自动创建；事件键集全等；skip 去重；update 只改三键", async () => {
    const name = `${DEFAULT_DS}-shape-${Date.now()}`;
    expect(DATASETS.some((d) => d.name === DEFAULT_DS)).toBe(false); // 桩里 support-bot-badcases 初始不存在
    const c = buildCase({ runKey: OBSERVE_RUN_KEY, item: fakeItem(), expected: "对答", humanScore: 0.5, notes: "n", now: new Date("2026-09-07T09:00:00Z") });
    const ev = await callMock({
      action: "append_dataset_cases", dataset: name, kind: "regression", create_if_missing: true,
      target_agent: AGENT, on_duplicate: "skip", cases: [c],
    });
    expect(Object.keys(ev).sort()).toEqual(["added", "case_count", "created", "dataset", "event", "kind", "skipped_duplicates", "updated"]);
    expect(ev).toMatchObject({ event: "dataset_cases_appended", dataset: name, kind: "regression", added: 1, updated: 0, skipped_duplicates: 0, case_count: 1, created: true });
    expect(c.name).toBe(caseNameOf(OBSERVE_RUN_KEY, fakeItem()));
    // 同题面（空白/大小写不同）再来 ⇒ skip 不写；update ⇒ updated 1，name/input 不动
    const dup = { ...c, input: "  题面  x ", expected_output: "更对的答", name: "another-name" };
    const skip = await callMock({ action: "append_dataset_cases", dataset: name, kind: "regression", cases: [dup] });
    expect(skip).toMatchObject({ added: 0, updated: 0, skipped_duplicates: 1, case_count: 1, created: false });
    const upd = await callMock({ action: "append_dataset_cases", dataset: name, kind: "regression", on_duplicate: "update", cases: [dup] });
    expect(upd).toMatchObject({ added: 0, updated: 1, skipped_duplicates: 0, case_count: 1, created: false });
    const list = await callMock({ action: "list_datasets" });
    const saved = (list.datasets as { name: string; cases: Record<string, unknown>[] }[]).find((d) => d.name === name)!;
    expect(saved.cases[0].name).toBe(c.name);
    expect(saved.cases[0].input).toBe("题面 X");
    expect(saved.cases[0].expected_output).toBe("更对的答");
    // 收尾：删掉临时集，别污染别的测试
    await callMock({ action: "delete_dataset", name });
  });

  it("append_dataset_cases 错误原话逐字照契约", async () => {
    const c = buildCase({ runKey: OBSERVE_RUN_KEY, item: fakeItem(), expected: "对答" });
    expect((await callMock({ action: "append_dataset_cases", dataset: "no-such-ds", kind: "regression", cases: [c] })).error)
      .toBe("数据集 'no-such-ds' 不存在");
    expect((await callMock({ action: "append_dataset_cases", dataset: "x", kind: "simulation", cases: [c] })).error)
      .toBe("kind 必须是 regression / redteam 之一（simulation 不接受追加），收到 'simulation'");
    expect((await callMock({ action: "append_dataset_cases", dataset: "x", kind: "regression", on_duplicate: "merge", cases: [c] })).error)
      .toBe("on_duplicate 必须是 skip / update 之一，收到 'merge'");
    expect((await callMock({ action: "append_dataset_cases", dataset: "x", kind: "regression", create_if_missing: true, cases: [{ ...c, expected_output: "" }] })).error)
      .toBe("第 1 条 expected_output 为空");
    expect((await callMock({ action: "append_dataset_cases", dataset: "x", kind: "regression", create_if_missing: true, cases: [c, { ...c, input: " " }] })).error)
      .toBe("第 2 条 input 为空");
    // 已存在的红队集不能追加 regression 用例
    const rt = DATASETS.find((d) => d.kind === "redteam")!;
    expect((await callMock({ action: "append_dataset_cases", dataset: rt.name, kind: "regression", cases: [c] })).error)
      .toBe(`数据集 '${rt.name}' 是 redteam 集，不能追加 regression 用例`);
  });

  it("annotate_case / list_annotations：键集全等、human_score 只认数字、覆盖同键、items 按 row_key#evaluator 升序", async () => {
    const ev = await callMock({ action: "annotate_case", run_key: "run-shape", row_key: "b-row", evaluator: "overall", human_score: 1, label: "overall", comment: "c" });
    expect(Object.keys(ev).sort()).toEqual(["annotation", "event"]);
    const a = ev.annotation as Record<string, unknown>;
    expect(Object.keys(a).sort()).toEqual(["at", "by", "comment", "evaluator", "human_score", "label", "row_key", "run_key"]);
    expect(a).toMatchObject({ run_key: "run-shape", row_key: "b-row", evaluator: "overall", human_score: 1, label: "overall", comment: "c", by: "manual" });
    expect(String(a.at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    await callMock({ action: "annotate_case", run_key: "run-shape", row_key: "a-row", evaluator: "conciseness", human_score: 0.5 });
    // 同键重标覆盖
    await callMock({ action: "annotate_case", run_key: "run-shape", row_key: "b-row", evaluator: "overall", human_score: 0 });
    const list = await callMock({ action: "list_annotations", run_key: "run-shape" });
    expect(Object.keys(list).sort()).toEqual(["event", "items", "run_key"]);
    const items = list.items as Record<string, unknown>[];
    expect(items.map((x) => `${x.row_key}#${x.evaluator}`)).toEqual(["a-row#conciseness", "b-row#overall"]);
    expect(items[1].human_score).toBe(0);
    expect((items[1] as { label: unknown }).label).toBeNull();
    // 错误原话
    expect((await callMock({ action: "annotate_case", run_key: "r", row_key: "x", evaluator: "e", human_score: "0.5" })).error)
      .toBe('human_score 必须是 0 / 0.5 / 1 之一，收到 "0.5"');
    expect((await callMock({ action: "annotate_case", run_key: "r", row_key: "x", evaluator: "e", human_score: true })).error)
      .toBe("human_score 必须是 0 / 0.5 / 1 之一，收到 true");
    expect((await callMock({ action: "annotate_case", row_key: "x", evaluator: "e", human_score: 1 })).error).toBe("run_key 不能为空");
    expect((await callMock({ action: "list_annotations" })).error).toBe("run_key 不能为空");
    // 未知 run_key ⇒ items: []，不是 error
    expect(await callMock({ action: "list_annotations", run_key: "never" })).toEqual({ event: "annotations", run_key: "never", items: [] });
  });

  it("expectedBlockReason：regression 空 / 同草稿都禁；redteam 空放行、同草稿仍禁", () => {
    expect(expectedBlockReason("", "d")).toContain("为空");
    expect(expectedBlockReason("d", "d")).toContain("未改动");
    expect(expectedBlockReason("x", "d")).toBeNull();
    expect(expectedBlockReason("", "d", "redteam")).toBeNull();
    expect(expectedBlockReason("d", "d", "redteam")).toContain("未改动");
  });
});
