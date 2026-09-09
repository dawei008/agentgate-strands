// 跨版本对比**独立页**（#/compare）：候选池跨方案、选两条、URL 可分享。
//
// 用户原话：「评估方案对比只能在一个评估方案，不同 run 里对比，但航空那个暴露一个
// 问题，不同版本 agent 有不同评估方案，无法对比」+「你最好把对比作为单独出来，
// 通过选择不同的 run，做对比」。抽屉那条路在**结构上**到不了这一对：它的候选池
// 就是本方案的运行历史。
//
// 本文件只钉「页面壳」独有的那几道，三桶/量纲/judge 理由的判据在
// tests/run-compare.test.tsx（同一个 CompareView，判据不许有第二份）：
//   1. **跨方案定序**：谁在左只看时刻，与两个 key 在候选池数组里的位置无关。
//      老写法（sortRunsDesc + findIndex，2026-08-26 前）对跨方案的一对稳定返回
//      null，表现成「选了两个 run 但页面空着」—— 与「这一对不可比」同形。
//   2. **先切段再逐段 decode**：run_key 自带 `#`（`<plan_id>#<ts>`）⇒ 入 URL 必是
//      `%23`；先解后切会把含 `%2F` 的 key 劈成两半，给出**另一对 run** 而不是报错。
//   3. **URL 镜像走 replaceState**：改 hash 会触发 hashchange ⇒ 路由重挂 ⇒ 每点一条
//      就把筛选条件和另一条选择清空。
//   4. **缺条目要明说**：深链里的 key 不在候选池（更早 / 已删）≠「这一对不可比」，
//      两者下一步动作不同，不许都表现成空白。
//   5. **口径披露**：两个方案跑的不是同一批题 → blocking；判分模型恒「未记录」。
//
// 夹具形态照 app/planrun.py：候选池行是 `_run_from_item` 的投影口径
// （`agent_version_label` 在 list_recent_runs 的 ProjectionExpression 里，
// planrun.py:1781 —— 所以跨方案池里版本 chip 是真读得到的，不是摆设），
// 明细是 get_plan_run 的 `{DDB 摘要 + report(S3 全量)}` 双层形态。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHash, RouteView, useRoute } from "../src/router";
import { orderComparePair } from "../src/pages/plan/compare/derive";
import { expectProseGone } from "./prose";
import { sseFrames } from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

const AGENT = "airline-agent";
/** 航空案例的两个方案：v1 只有线上评估，v3 加了回归 + 红队 ⇒ 两个方案、两批题。 */
const V1_PLAN = "plan-air-v1";
const V3_PLAN = "plan-air-v3";
const V1_KEY = `${V1_PLAN}#2026-08-22T03:00:00Z`;
const V3_KEY = `${V3_PLAN}#2026-08-23T08:00:00Z`;
/** 第三个方案的一次运行：用来验「筛选/挤掉」，也保证候选池不是刚好两条。 */
const OTHER_KEY = "plan-faq-001#2026-08-21T09:00:00Z";

const V1_DATASET = "tau-airline-baseline-20";
const V3_DATASET = "tau-airline-full-40";

const V1_SUMMARIES = [
  { type: "observe", status: "completed", overall_mean: 0.65, sessions: 20, summary: {} },
  {
    type: "dataset", status: "completed", pass_rate: 0.55, cases: 20, judged_cases: 20, blank_cases: 0,
    evaluators: ["correctness"],
    evaluator_stats: { correctness: { mean: 0.61, passed: 11, judged: 20 } },
  },
];

const V3_SUMMARIES = [
  { type: "observe", status: "completed", overall_mean: 0.71, sessions: 20, summary: {} },
  {
    type: "dataset", status: "completed", pass_rate: 0.72, cases: 40, judged_cases: 40, blank_cases: 0,
    // v3 加了两个评估器 ⇒ 口径披露里 evaluators 应是 diff（非交集那两个没有环比）
    evaluators: ["correctness", "refusal", "policy_compliance"],
    evaluator_stats: {
      correctness: { mean: 0.78, passed: 31, judged: 40 },
      refusal: { mean: 0.66, passed: 26, judged: 40 },
      policy_compliance: { mean: 0.7, passed: 28, judged: 40 },
    },
  },
];

/** 候选池的一行（list_recent_runs 口径：带 plan_id/plan_name/agent_name）。
 *  `run_key` / `started_at` 声明成必填：定序判据直接吃这两个字段，缺了就不是
 *  「夹具随意」而是把被测的那件事测空了。 */
type PoolRow = { run_key: string; started_at: string; [k: string]: unknown };

function poolRow(over: PoolRow): PoolRow {
  return {
    sk: "", plan_id: "", plan_name: "", agent_name: AGENT,
    status: "completed", score: null, triggered_by: "manual",
    finished_at: "", started_epoch: null, finished_epoch: null,
    duration_s: null, total_cost_usd: null, stage_summaries: [], s3_key: null,
    agent_version_label: null, agent_runtime_arn: null, stale: false,
    heartbeat_epoch: null, progress: null, checkpoint_s3_key: null,
    ...over,
  };
}

/** 池子按后端返回序（(started_at, started_epoch) 倒序，planrun.py:1802）。 */
const POOL = [
  poolRow({
    run_key: V3_KEY, sk: V3_KEY, plan_id: V3_PLAN, plan_name: "航空客服 · 全链路评估",
    score: 0.71, started_at: "2026-08-23 08:00 UTC", duration_s: 402,
    stage_summaries: V3_SUMMARIES, agent_version_label: "v3",
  }),
  poolRow({
    run_key: V1_KEY, sk: V1_KEY, plan_id: V1_PLAN, plan_name: "航空客服 · 线上评估基线",
    score: 0.65, started_at: "2026-08-22 03:00 UTC", duration_s: 288,
    stage_summaries: V1_SUMMARIES, agent_version_label: "v1",
  }),
  poolRow({
    run_key: OTHER_KEY, sk: OTHER_KEY, plan_id: "plan-faq-001", plan_name: "FAQ 周回归",
    agent_name: "support-bot", score: 0.9, started_at: "2026-08-21 09:00 UTC", duration_s: 74,
    stage_summaries: [
      { type: "observe", status: "completed", overall_mean: 0.9, sessions: 2, summary: {} },
    ],
    agent_version_label: "v2.0",
  }),
];

function caseRow(name: string, score: number, passed: boolean) {
  return {
    agent: AGENT, case: name, category: "改签",
    input: `${name} 的问题`, expected_output: "要点：给出可执行路径。",
    output: passed ? "已为您改签。" : "请联系客服。", duration_s: 2.4,
    results: {
      correctness: { score, passed, errored: false, reason: passed ? "与期望一致。" : "答非所问。" },
    },
  };
}

function detailFor(runKey: string): Record<string, unknown> {
  const isV3 = runKey.startsWith(V3_PLAN);
  const row = POOL.find((r) => r.run_key === runKey)!;
  const dataset = isV3 ? V3_DATASET : V1_DATASET;
  const cases = isV3
    ? [caseRow("rebook-same-day", 0.9, true), caseRow("transfer-to-human", 0.4, false)]
    : [caseRow("rebook-same-day", 0.5, false), caseRow("transfer-to-human", 0.3, false)];
  return {
    event: "plan_run",
    run_key: runKey,
    plan_id: row.plan_id, plan_name: row.plan_name, agent_name: row.agent_name,
    status: row.status, score: row.score,
    started_at: row.started_at, finished_at: "", duration_s: row.duration_s,
    triggered_by: "manual", total_cost_usd: 0.31,
    overview: { stage_lines: [], previous_run: null },
    stage_summaries: row.stage_summaries,
    agent_version_label: row.agent_version_label,
    agent_runtime_arn: null,
    s3_key: `planruns/${row.plan_id}/${runKey}.json`,
    proposals: [], plan_synthesis: null, synthesis_error: null,
    report: {
      run_key: runKey,
      plan: { plan_id: row.plan_id, name: row.plan_name, agent_name: row.agent_name, stages: [] },
      triggered_by: "manual", started_at: row.started_at, duration_s: row.duration_s,
      stages: [
        {
          type: "observe", status: "completed", sessions: 20,
          overall_mean: isV3 ? 0.71 : 0.65, evaluators: ["helpfulness"],
          analysis: "", session_details: [],
        },
        {
          type: "dataset", status: "completed", run_id: "ds-1", dataset,
          cases: cases.length, pass_rate: isV3 ? 0.72 : 0.55, blank_cases: 0,
          report: {
            run_id: "ds-1", dataset, status: "completed",
            total_cases: cases.length, analysis: "", results: cases,
          },
        },
      ],
    },
  };
}

type Payload = { action?: string } & Record<string, unknown>;

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
}

function stubFetch(over: Record<string, (p: Payload) => Response> = {}) {
  const calls: Payload[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    calls.push(payload);
    const h = over[payload.action ?? ""];
    if (h) return h(payload);
    switch (payload.action) {
      case "list_recent_runs":
        return sseResponse([{ event: "recent_runs", runs: POOL }]);
      case "get_plan_run":
        return sseResponse([detailFor(String(payload.run_key))]);
      // 数据集名单只为读 updated_at（判「题面改过没有」），拉不到也不当渲染闸门
      case "list_datasets":
        return sseResponse([{ event: "datasets", datasets: [] }]);
      default:
        return sseResponse([{ event: "error", error: `未实现 ${payload.action}` }]);
    }
  }));
  return calls;
}

/** 走真路由渲染：本页的 aKey/bKey 来自 hash，而「replaceState 不重挂」这一条
 *  只有在 useRoute 的 hashchange 监听在场时才测得到（直接渲染 ComparePage
 *  的话，改 hash 也不会重挂 —— 那种写法测不出 navigate 与 replaceState 的差别）。 */
function Harness() {
  return <RouteView route={useRoute()} />;
}

function renderApp() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>);
}

/** 让 jsdom 的事件队列跑干（hashchange 是异步派发的）：
 *  「点完立刻断言」在两种实现下都会通过 —— 重挂发生在下一个 tick。 */
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  resetConfigForTest();
  resetRunFlightForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  location.hash = "#/compare";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 纯函数：跨方案定序
// ---------------------------------------------------------------------------
describe("跨方案定序：谁在左只看时刻", () => {
  // 候选池刻意排成**与时间序相反**的顺序（后端真返回的是时间倒序，这里反着
  // 摆是为了让「按下标定序」的实现给出可辨认的错答案：位置在前 = 更新）。
  const REVERSED = [...POOL].reverse();

  it("较早的恒在左，且与两个 key 在数组里的位置无关", () => {
    const want = { aKey: V1_KEY, bKey: V3_KEY };
    expect(orderComparePair(POOL, V1_KEY, V3_KEY)).toEqual(want);
    expect(orderComparePair(POOL, V3_KEY, V1_KEY)).toEqual(want);
    // 同一对、同一个答案 —— 数组顺序换了也不许变
    expect(orderComparePair(REVERSED, V1_KEY, V3_KEY)).toEqual(want);
    expect(orderComparePair(REVERSED, V3_KEY, V1_KEY)).toEqual(want);
  });

  it("时刻并列（started_at 只到分钟）→ 退 run_key 秒级尾段，换序仍同一答案", () => {
    // 同一分钟内的两次运行是可能的：分钟级字符串分不出先后，秒级尾段能
    const early = "plan-air-v3#2026-08-23T08:00:11Z";
    const late = "plan-air-v3#2026-08-23T08:00:47Z";
    const runs = [
      { run_key: late, started_at: "2026-08-23 08:00 UTC" },
      { run_key: early, started_at: "2026-08-23 08:00 UTC" },
    ];
    const want = { aKey: early, bKey: late };
    expect(orderComparePair(runs, early, late)).toEqual(want);
    expect(orderComparePair(runs, late, early)).toEqual(want);
  });

  it("尾段也并列（跨方案同一时刻）→ 整串字典序；必须有终局", () => {
    // 两个方案同时被定时器拉起来跑 —— 时刻与秒级尾段都一样，只剩 plan_id 不同。
    // 「谁在左」在这里没有语义上的正确答案，但**必须确定**：非确定性等于同一对
    // run 两次打开给出相反结论（「修好了」与「改坏了」互换）。
    const k1 = "plan-air-v1#2026-08-23T08:00:00Z";
    const k2 = "plan-air-v3#2026-08-23T08:00:00Z";
    const runs = [
      { run_key: k2, started_at: "2026-08-23 08:00 UTC" },
      { run_key: k1, started_at: "2026-08-23 08:00 UTC" },
    ];
    expect(orderComparePair(runs, k1, k2)).toEqual({ aKey: k1, bKey: k2 });
    expect(orderComparePair(runs, k2, k1)).toEqual({ aKey: k1, bKey: k2 });
  });

  it("同一个 key / 有一个不在候选池里 → null（调用方各走各的空态）", () => {
    expect(orderComparePair(POOL, V1_KEY, V1_KEY)).toBeNull();
    expect(orderComparePair(POOL, V1_KEY, "plan-air-v9#2026-01-01T00:00:00Z")).toBeNull();
    expect(orderComparePair(POOL, "", V3_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 路由：两个 run_key 进 URL
// ---------------------------------------------------------------------------
describe("hash 路由 #/compare[/:aKey/:bKey]", () => {
  it("无参 → 两个空串（页面走「选两次运行」空态，不是错误态）", () => {
    expect(parseHash("#/compare")).toEqual({ view: "compare", aKey: "", bKey: "" });
    expect(parseHash("#/compare/")).toEqual({ view: "compare", aKey: "", bKey: "" });
    // 只给一个 key 也是「还没选够」，不许拿它当 aKey 半渲染
    expect(parseHash(`#/compare/${encodeURIComponent(V1_KEY)}`))
      .toEqual({ view: "compare", aKey: "", bKey: "" });
  });

  it("run_key 自带 # ⇒ URL 里是 %23，逐段 decode 后是原串", () => {
    const h = `#/compare/${encodeURIComponent(V1_KEY)}/${encodeURIComponent(V3_KEY)}`;
    expect(h).toContain("%23"); // 夹具自检：真编码过了，否则这条测不到解码
    expect(parseHash(h)).toEqual({ view: "compare", aKey: V1_KEY, bKey: V3_KEY });
  });

  it("先切段再逐段 decode：含 %2F 的 key 不许被劈成两半", () => {
    // 先解后切（单参数路由那条 `dec(rest.join("/"))` 的写法）会把 %2F 解成 "/"
    // 再按 "/" 切 ⇒ 切出三段、取前两段 ⇒ 返回的是**另一对 run**，而不是报错。
    // 这条不依赖「plan_id 会不会真带斜杠」：解析器不该把这件事当前提。
    const weird = "plan/air#2026-08-23T08:00:00Z";
    const h = `#/compare/${encodeURIComponent(weird)}/${encodeURIComponent(V3_KEY)}`;
    expect(parseHash(h)).toEqual({ view: "compare", aKey: weird, bKey: V3_KEY });
  });

  it("畸形百分号不炸整站：%ZZ 原样落地，路由仍是 compare", () => {
    // parseHash 在 useState 初值里调，抛出去就是**白屏**（页面级围栏在它下游）。
    // 粘错一个 URL 不该等于应用挂掉 —— 解不开就原样用，后面按「找不到这个 run」降级。
    expect(() => parseHash("#/compare/%ZZ/%E4%B8%AD")).not.toThrow();
    expect(parseHash("#/compare/%ZZ/%E4%B8%AD")).toEqual({
      view: "compare", aKey: "%ZZ", bKey: "中",
    });
    // 落单的 % 同刑
    expect(parseHash("#/compare/a%/b")).toEqual({ view: "compare", aKey: "a%", bKey: "b" });
  });
});

// ---------------------------------------------------------------------------
// 页面：候选池 → 选两条 → 结果
// ---------------------------------------------------------------------------
describe("对比页：跨方案选两条", () => {
  it("候选池混排多个方案；没选够两条时说清下一步动作", async () => {
    stubFetch();
    renderApp();
    await screen.findByTestId("compare-list");
    // 三个方案的行都在同一个池子里 —— 这正是抽屉做不到的那件事
    expect(screen.getByTestId(`compare-row-${V1_KEY}`)).toHaveTextContent("航空客服 · 线上评估基线");
    expect(screen.getByTestId(`compare-row-${V3_KEY}`)).toHaveTextContent("航空客服 · 全链路评估");
    expect(screen.getByTestId(`compare-row-${OTHER_KEY}`)).toHaveTextContent("FAQ 周回归");
    expect(screen.getByTestId("compare-selcount")).toHaveTextContent("已选 0 / 2");
    expect(screen.getByTestId("compare-empty")).toHaveTextContent("勾选两次运行开始对比");
    // 空态副句「两次可以来自不同方案、不同版本…勾错了去掉勾重选就行」与页头副标题
    // 「勾选两次运行 · 跨方案、跨版本都能比」对任何一对恒成立 ⇒ 版面与 title 双无
    // （prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("compare-empty"), "不同方案、不同版本", "勾错了去掉勾重选", "谁在左由时间决定");
    expectProseGone(screen.getByTestId("compare-head"), "跨方案、跨版本", "勾选两次运行 ·");
    expect(screen.queryByTestId("compare-result")).toBeNull();
    // 一条没选时不许出现「已选满」那句 —— 它是禁用态的解释，没禁用就没有它
    expect(screen.queryByTestId("compare-selfull")).toBeNull();
  });

  it("选择走真的勾选框：勾上=选中、去掉勾=取消（不是 aria-pressed 的按钮）", async () => {
    // 用户原话：「一般情况下不都是通过打勾的方式去选吗？选错了去掉勾再重新选就行」。
    // 这条钉的是**控件类型**：`toBeChecked()` 只对真 checkbox/radio 成立，
    // 换回 `<button aria-pressed>` 会红 —— 而那两种在「看起来选中了」上是同形的。
    stubFetch();
    renderApp();
    await screen.findByTestId("compare-list");
    const box = screen.getByTestId(`compare-check-${V1_KEY}`);
    expect(box).not.toBeChecked();
    // 点整行（label）也要能切：勾选框只有 15px，整行可点是原来就有的手感
    fireEvent.click(screen.getByTestId(`compare-row-${V1_KEY}`));
    expect(box).toBeChecked();
    expect(screen.getByTestId("compare-selcount")).toHaveTextContent("已选 1 / 2");
    // 去掉勾 → 回到未选
    fireEvent.click(box);
    expect(box).not.toBeChecked();
    expect(screen.getByTestId("compare-selcount")).toHaveTextContent("已选 0 / 2");
  });

  it("选两条不同方案的运行 → 出结果；两栏各带自己的方案名与版本快照", async () => {
    stubFetch();
    renderApp();
    await screen.findByTestId("compare-list");
    // 刻意**先点较新那次**：谁在左由时刻定，不由点选顺序定
    fireEvent.click(screen.getByTestId(`compare-row-${V3_KEY}`));
    fireEvent.click(screen.getByTestId(`compare-row-${V1_KEY}`));
    await screen.findByTestId("compare-result");

    const colA = await screen.findByTestId("plan-compare-col-a");
    const colB = screen.getByTestId("plan-compare-col-b");
    // 左 = 较早 = v1 基线；右 = 较新 = v3
    expect(within(colA).getByTestId("plan-compare-origin-a")).toHaveTextContent("线上评估基线");
    expect(within(colB).getByTestId("plan-compare-origin-b")).toHaveTextContent("全链路评估");
    await waitFor(() =>
      expect(screen.getByTestId("plan-compare-version-a")).toHaveTextContent("v1"));
    expect(screen.getByTestId("plan-compare-version-b")).toHaveTextContent("v3");
    expect(screen.getByTestId("compare-selcount")).toHaveTextContent("已选 2 / 2");
  });

  it("口径披露：两个方案跑的不是同一批题 → blocking；判分模型恒「未记录」", async () => {
    stubFetch();
    renderApp();
    await screen.findByTestId("compare-list");
    fireEvent.click(screen.getByTestId(`compare-row-${V1_KEY}`));
    fireEvent.click(screen.getByTestId(`compare-row-${V3_KEY}`));
    // 口径条要等两侧报告都到（加载中两侧都读不到数据集名，与「老 run 不带这个
    // 字段」同形 —— 那会让一个正常的对比在头两秒挂上一条假警示）
    const ds = await screen.findByTestId("plan-compare-cal-dataset");
    expect(ds).toHaveAttribute("data-level", "blocking");
    expect(within(ds).getByTestId("plan-compare-cal-dataset-a")).toHaveTextContent(V1_DATASET);
    expect(within(ds).getByTestId("plan-compare-cal-dataset-b")).toHaveTextContent(V3_DATASET);
    expect(ds).toHaveTextContent("两次跑的不是同一批题");
    // 口径条各行只留「这一对差在哪 + 直接后果」，机制讲解与操作建议对任何一对恒成立
    // ⇒ 删（prose-sweep 2026-09-03）
    const cal = screen.getByTestId("plan-compare-calibration");
    expectProseGone(cal, "配到一起的两条本来就是两道题", "要记住分母不同",
      "没有环比可言", "判定的条数本身就不一样", "哪把尺子", "读之前看清这一条说的后果",
      "结论要限定范围", "自己留一分");

    // v3 多了两个评估器 → diff（交集仍可读，非交集各处单独标注）
    const ev = screen.getByTestId("plan-compare-cal-evaluators");
    expect(ev).toHaveAttribute("data-level", "diff");
    expect(ev).toHaveTextContent("只有这一次有 refusal、policy_compliance");

    // 判分模型是全局配置、从不落 run 记录 ⇒ 恒 unknown。
    // ⚠️ 这一条**必须出现**：不说，读者会默认两次是同一把尺子量的；
    // 而 unknown 也绝不许被读成「相同」（「两次都没记」与「两次记的一样」同形）。
    const judge = screen.getByTestId("plan-compare-cal-judge");
    expect(judge).toHaveAttribute("data-level", "unknown");
    expect(within(judge).getByTestId("plan-compare-cal-judge-a")).toHaveTextContent("未记录");
    expect(within(judge).getByTestId("plan-compare-cal-judge-b")).toHaveTextContent("未记录");
  });

  it("口径是表格：列头带 run 身份（#N · 时间），行里不再逐行重复侧别词；三区编号在场", async () => {
    // 用户 2026-08-30：「上一次：bi-metrics-12 这一次：bi-metrics-12」七行读下来
    // 仍分不清列指的是哪次运行 —— 列头直接写 #N · 时间。#N 按 plan 内序（两个
    // run 各自是自己方案的第 1 次 ⇒ 都是 #1，正好钉住「不是全局下标」）。
    stubFetch();
    renderApp();
    await screen.findByTestId("compare-list");
    fireEvent.click(screen.getByTestId(`compare-row-${V1_KEY}`));
    fireEvent.click(screen.getByTestId(`compare-row-${V3_KEY}`));
    await screen.findByTestId("plan-compare-cal-head");

    // 列头：侧别词 + run 身份（时间来自夹具 started_at，fmtRunTime 形态）
    const ha = screen.getByTestId("plan-compare-cal-head-a");
    expect(ha).toHaveTextContent("上一次");
    expect(ha).toHaveTextContent("#1 · 2026-08-22 03:00");
    const hb = screen.getByTestId("plan-compare-cal-head-b");
    expect(hb).toHaveTextContent("这一次");
    expect(hb).toHaveTextContent("#1 · 2026-08-23 08:00");

    // 行内不再有「上一次：」前缀 —— 侧别只在表头说一次（表格化的实质）
    const ds = screen.getByTestId("plan-compare-cal-dataset");
    expect(within(ds).getByTestId("plan-compare-cal-dataset-a").textContent)
      .not.toContain("上一次");

    // 警示留版面、解释整句删（用户 2026-08-30 终裁：也不进悬停）：
    // blocking 行（数据集不同）说明可见 —— 它改变下面的数怎么读；
    // unknown 行（判分模型未记录）说明彻底不渲染（title 也没有）
    const dsRow = screen.getByTestId("plan-compare-cal-dataset");
    expect(dsRow.querySelector(".ct")).not.toBeNull();
    const judgeRow = screen.getByTestId("plan-compare-cal-judge");
    expect(judgeRow.querySelector(".ct")).toBeNull();
    expect(judgeRow.getAttribute("title")).toBeNull();
    // 本对 worst = blocking ⇒ 总结论横幅在场（警示档才占行）
    expect(screen.getByTestId("plan-compare-cal-verdict"))
      .toHaveAttribute("data-level", "blocking");

    // 逐环节对比表头也带 #N（84px 装不下全串，时间进 title）
    const kpis = screen.getByTestId("plan-compare-kpis");
    const ka = kpis.querySelector(".cmp-kpi.is-head .ka")!;
    expect(ka.textContent).toBe("上一次 #1");
    expect(ka.getAttribute("title")).toBe("#1 · 2026-08-22 03:00");

    // 三区编号（结构写在脸上）：① 口径 ② 逐环节对比 ③ 逐用例对照
    expect(screen.getByTestId("plan-compare-calibration")).toHaveTextContent("① 口径");
    expect(kpis).toHaveTextContent("② 逐环节对比");
    expect(screen.getByTestId("plan-compare-body-cap")).toHaveTextContent("③ 逐用例对照");
  });

  it("URL 镜像走 replaceState：不重挂路由 ⇒ 筛选条件与选择都活着", async () => {
    stubFetch();
    renderApp();
    await screen.findByTestId("compare-list");
    // 先打字：navigate/改 hash 的实现会在第二次点击后把它清空（route key 含两个 key）
    fireEvent.change(screen.getByTestId("compare-filter-q"), { target: { value: "航空" } });
    fireEvent.click(screen.getByTestId(`compare-row-${V1_KEY}`));
    fireEvent.click(screen.getByTestId(`compare-row-${V3_KEY}`));
    await screen.findByTestId("compare-result");
    // hashchange 是异步派发的：不跑干事件队列，两种实现都会「通过」
    await flush();

    expect(location.hash).toBe(
      `#/compare/${encodeURIComponent(V1_KEY)}/${encodeURIComponent(V3_KEY)}`,
    );
    expect(screen.getByTestId("compare-filter-q")).toHaveValue("航空");
    expect(screen.getByTestId("compare-selcount")).toHaveTextContent("已选 2 / 2");
    expect(screen.getByTestId("compare-result")).toBeInTheDocument();
  });

  it("选满两条 → 第三条的勾选框 disabled + 卡头说出为什么；去掉一个勾就又能选", async () => {
    stubFetch();
    renderApp();
    await screen.findByTestId("compare-list");
    fireEvent.click(screen.getByTestId(`compare-row-${V1_KEY}`));
    fireEvent.click(screen.getByTestId(`compare-row-${V3_KEY}`));
    await flush();

    // 旧实现在这里挤掉最早选的那条，理由是「点了没反应」与「这行不能选」同形。
    // 现在改成**真的 disabled**：那个同形消失了（灰底 + not-allowed 指针），
    // 而且已选的两条一条都不会被静默换掉 —— 用户没取消过它们。
    const third = screen.getByTestId(`compare-check-${OTHER_KEY}`);
    expect(third).toBeDisabled();
    expect(third).not.toBeChecked();
    // 卡头只说状态「已选满」；「去掉一个勾再选别的」与行 title「先去掉一个勾，再选
    // 这一条」是操作说明，对任何用户恒成立 ⇒ 版面与 title 双无（prose-sweep 2026-09-03；
    // 此前这里钉的是 title 里**有**「先去掉一个勾」）
    expect(screen.getByTestId("compare-selfull")).toHaveTextContent("已选满");
    expectProseGone(screen.getByTestId("page-compare"), "去掉一个勾");
    // 点它不改变任何东西（disabled 的 input 不派发 change）
    fireEvent.click(screen.getByTestId(`compare-row-${OTHER_KEY}`));
    await flush();
    expect(screen.getByTestId(`compare-check-${V1_KEY}`)).toBeChecked();
    expect(screen.getByTestId(`compare-check-${V3_KEY}`)).toBeChecked();
    expect(screen.getByTestId("compare-selcount")).toHaveTextContent("已选 2 / 2");

    // 用户说的改法：去掉一个勾 → 第三条立刻可选，选上就成新的一对
    fireEvent.click(screen.getByTestId(`compare-check-${V1_KEY}`));
    await flush();
    expect(screen.getByTestId(`compare-check-${OTHER_KEY}`)).toBeEnabled();
    expect(screen.queryByTestId("compare-selfull")).toBeNull();
    fireEvent.click(screen.getByTestId(`compare-check-${OTHER_KEY}`));
    await flush();
    expect(screen.getByTestId("compare-selcount")).toHaveTextContent("已选 2 / 2");
    expect(screen.getByTestId(`compare-check-${V1_KEY}`)).not.toBeChecked();

    // 清空回到「一条没选」，URL 跟着退回无参
    fireEvent.click(screen.getByTestId("compare-clear"));
    await flush();
    expect(screen.getByTestId("compare-selcount")).toHaveTextContent("已选 0 / 2");
    expect(location.hash).toBe("#/compare");
  });

  it("两栏身份色：选满才上色，且色只落在壳上 —— 分数列一格都不许染", async () => {
    // 用户原话：「对比的结果也看不太清，其实可以用不同的颜色标示哪些是第一轮、
    // 哪些是第二轮」。这条钉三件事：① 只选一条时**没有**身份（方向还没定，
    // 提前上色等于替时间做决定）② 选满后两条各自拿到 is-side-a / is-side-b
    // ③ 颜色的文字等价读数在 chip 上（认色有困难时照样读得出是哪一次）。
    stubFetch();
    renderApp();
    await screen.findByTestId("compare-list");

    fireEvent.click(screen.getByTestId(`compare-row-${V3_KEY}`));
    await flush();
    // 一条的时候：行上没有身份类，也没有那句方向说明
    expect(screen.getByTestId(`compare-row-${V3_KEY}`).className).not.toMatch(/is-side-/);
    expect(screen.queryByTestId("compare-order-note")).toBeNull();

    // 刻意先点较新那次、后点较早那次：身份按**时刻**发，不按勾选先后
    fireEvent.click(screen.getByTestId(`compare-row-${V1_KEY}`));
    await screen.findByTestId("compare-result");
    expect(screen.getByTestId(`compare-row-${V1_KEY}`).className).toContain("is-side-a");
    expect(screen.getByTestId(`compare-row-${V3_KEY}`).className).toContain("is-side-b");
    // 「较早的那次恒为上一次，勾选先后不影响结论」那句已删（对任何一对恒成立 ⇒
    // 文档不是界面，prose-sweep 2026-09-03；此前这里钉的是它**在**）——方向由两枚
    // chip 上的「上一次 / 这一次」自身承担
    expect(screen.queryByTestId("compare-order-note")).toBeNull();
    expectProseGone(screen.getByTestId("page-compare"), "勾选先后不影响结论", "较早的那次恒为");
    // 文字等价读数：两枚 chip 上写着「上一次 / 这一次」
    const picked = screen.getByTestId("compare-picked");
    expect(picked).toHaveTextContent("上一次");
    expect(picked).toHaveTextContent("这一次");

    // 图例把映射写成话，并划清与分数色的界 —— 同屏两个绿是两种意思
    const legend = await screen.findByTestId("plan-compare-legend");
    expect(legend).toHaveTextContent("上一次（较早）");
    expect(legend).toHaveTextContent("这一次（较新）");
    // 「分数的绿/红仍是达标/未达标」对任何 run 恒成立 ⇒ 整句删除
    // （用户 2026-08-30 终裁：通用说明是文档不是界面，悬停也不留）
    expect(legend).not.toHaveTextContent("达标/未达标");
    expect(legend.getAttribute("title")).toBeNull();
  });

  it("深链里的 run 不在候选池 → 明说「没取到这条」，不是空白", async () => {
    // 「更早的运行 / 已被删」与「这一对不可比」的下一步动作完全不同
    // （放宽范围 vs 换一对）—— 都表现成空白就分不出来了。
    const gone = "plan-air-v0#2025-12-01T00:00:00Z";
    location.hash = `#/compare/${encodeURIComponent(gone)}/${encodeURIComponent(V3_KEY)}`;
    stubFetch();
    renderApp();
    const miss = await screen.findByTestId("compare-missing");
    // 计数必须只算真缺的那一条：说「有 2 条」就把好的那条也判了死刑
    expect(miss).toHaveTextContent("有 1 条运行不在候选池里");
    expect(miss).toHaveTextContent(gone);
    expect(miss).not.toHaveTextContent(V3_KEY);
    // 成因枚举「候选池只取最近 N 次；这些 run 更早，或者已经被删除」对任何缺失恒成立
    // ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(miss, "已经被删除", "候选池只取最近");
    expect(screen.queryByTestId("compare-result")).toBeNull();
    // 池子本身是好的：另一条仍是勾着的，改一条就能成对
    expect(screen.getByTestId(`compare-check-${V3_KEY}`)).toBeChecked();
  });

  it("池子还在飞的时候，不许对着请求下「已经被删除」的判决", async () => {
    // 「池子还没到」与「这个 key 真不在池子里」在数据上同形（两种情况下
    // pool.find 都是 undefined）—— 这条测的就是那道闸。实测过：不加闸时深链
    // 进来的头一帧写的是「有 2 条运行不在候选池里…或者已经被删除」，而两条
    // 其实都健在，只是请求还在飞。
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("config.json")) return Response.json(CFG);
      const payload = JSON.parse(String(init?.body)) as Payload;
      if (payload.action === "list_recent_runs") {
        await gate;
        return sseResponse([{ event: "recent_runs", runs: POOL }]);
      }
      if (payload.action === "get_plan_run") {
        return sseResponse([detailFor(String(payload.run_key))]);
      }
      return sseResponse([{ event: "datasets", datasets: [] }]);
    }));
    location.hash = `#/compare/${encodeURIComponent(V1_KEY)}/${encodeURIComponent(V3_KEY)}`;
    renderApp();

    await screen.findByTestId("compare-pending");
    expectProseGone(screen.getByTestId("compare-pending"), "要等候选池到齐");
    expect(screen.queryByTestId("compare-missing")).toBeNull();
    // 文案级反证：整页不许出现那句结论（换个 testid 也逃不掉）
    expect(document.body.textContent).not.toContain("已经被删除");

    release();
    await screen.findByTestId("compare-result");
    expect(screen.queryByTestId("compare-pending")).toBeNull();
    expect(screen.queryByTestId("compare-missing")).toBeNull();
  });

  it("深链带完整一对 → 直接出结果（可分享、可刷新）", async () => {
    location.hash = `#/compare/${encodeURIComponent(V1_KEY)}/${encodeURIComponent(V3_KEY)}`;
    stubFetch();
    renderApp();
    await screen.findByTestId("compare-result");
    expect(screen.queryByTestId("compare-missing")).toBeNull();
    expect(screen.getByTestId("compare-selcount")).toHaveTextContent("已选 2 / 2");
  });

  it("候选池为空 → 说清先跑一次评估，不画选择器空表", async () => {
    stubFetch({
      list_recent_runs: () => sseResponse([{ event: "recent_runs", runs: [] }]),
    });
    renderApp();
    const empty = await screen.findByTestId("compare-pool-empty");
    expect(empty).toHaveTextContent("还没有运行记录");
    // 「先跑一次评估，这里才有可对比的两次运行」= 操作说明 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(empty, "先跑一次评估");
    expect(screen.queryByTestId("compare-list")).toBeNull();
  });

  it("池子取数失败 → 报原话，不装成「还没有运行记录」", async () => {
    stubFetch({
      list_recent_runs: () => sseResponse([{ event: "error", error: "DynamoDB 限流" }]),
    });
    renderApp();
    const err = await screen.findByTestId("compare-load-error");
    expect(err).toHaveTextContent("DynamoDB 限流");
    expect(screen.queryByTestId("compare-pool-empty")).toBeNull();
    expect(screen.queryByTestId("compare-list")).toBeNull();
  });

  it("候选池按 Agent 过滤后仍是跨方案的（同一个 Agent 的两个方案都留下）", async () => {
    stubFetch();
    renderApp();
    await screen.findByTestId("compare-list");
    fireEvent.change(screen.getByTestId("compare-filter-agent"), { target: { value: AGENT } });
    await flush();
    expect(screen.getByTestId(`compare-row-${V1_KEY}`)).toBeInTheDocument();
    expect(screen.getByTestId(`compare-row-${V3_KEY}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`compare-row-${OTHER_KEY}`)).toBeNull();
  });

  it("候选池不为工作台的 limit=20 那份缓存所限（两页各查各的）", async () => {
    const calls = stubFetch();
    renderApp();
    await screen.findByTestId("compare-list");
    const recent = calls.filter((c) => c.action === "list_recent_runs");
    expect(recent).toHaveLength(1);
    // 对比要往回翻好几个版本 ⇒ 明显更大的池子；工作台那份是 20
    expect(recent[0].limit).toBe(200);
  });
});
