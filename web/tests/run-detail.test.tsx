// 运行详情 trace 三栏视图测试。
// fetch 打桩方式与 plan.test.tsx 一致（stubGlobal + SSE Response）；
// 数据用 mocks/handlers 的 MOCK_PLAN_RUN / PLAN_RUNS——它现在是**真后端形态**
// （app/planrun.py 的 DDB 摘要 + S3 全量），不再是照本页自造的形状。
// 明细取自 report.stages（observe → session_details、dataset/redteam →
// report.results），下面几个 helper 就是为此存在的。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import RunDetailPage, { fmtDur, meanScore, isRetry } from "../src/pages/run/RunDetailPage";
import type { TranscriptEvent } from "../src/pages/run/types";
import { resetConfigForTest } from "../src/lib/config";
import { useSession } from "../src/stores/session";
import { UNIT_WORD } from "../src/pages/plan/compare/derive";
import { sseFrames, MOCK_PLAN_RUN, PLAN_RUN_DETAIL, PLAN_RUNS } from "../src/mocks/handlers";
import { expectProseGone } from "./prose";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
const RUN_KEY = "plan-aaa111#2026-08-11T09:00:00Z";

type Payload = { action: string } & Record<string, unknown>;

let calls: Payload[] = [];
let overrides: Record<string, (p: Payload) => unknown[]> = {};

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: PLAN_RUNS }],
  get_plan_run: (p) => [{ event: "plan_run", ...MOCK_PLAN_RUN, run_key: p.run_key }],
};

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

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

function renderPage(id = RUN_KEY) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <RunDetailPage id={id} />
    </QueryClientProvider>,
  );
}

/** 展开首个 observe session 的 trace 树 */
async function openSession() {
  const row = await screen.findByTestId("session-row-sess-a41f9c2b");
  fireEvent.click(row);
  return screen.findByTestId("trace-tree-sess-a41f9c2b");
}

beforeEach(() => {
  calls = [];
  overrides = {};
  resetConfigForTest();
  location.hash = `#/run/${encodeURIComponent(RUN_KEY)}`;
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==================== 纯函数 ====================
/** 真形态里的第一个 observe 会话（明细在 S3 全量 report.stages[0].session_details） */
const FIRST_SESSION = MOCK_PLAN_RUN.report.stages[0].session_details![0];

describe("纯函数", () => {
  it("meanScore：errored/score=null 不计入均值——不是 0 分", () => {
    expect(meanScore(FIRST_SESSION.results!)).toBeCloseTo(0.9, 10);
    expect(meanScore({})).toBeNull();
  });

  it("isRetry：仅紧邻同名 error 行为 retry；fmtDur 格式化", () => {
    const events = FIRST_SESSION.transcript!.events as TranscriptEvent[];
    const idx8 = events.findIndex((e) => e.n === 8); // 第二次 rebook_flight
    const idx7 = events.findIndex((e) => e.n === 7); // 第一次失败
    expect(isRetry(events, idx8)).toBe(true);
    expect(isRetry(events, idx7)).toBe(false);
    expect(fmtDur(74)).toBe("1m14s");
    expect(fmtDur(59)).toBe("59s");
  });
});

// ==================== 三栏骨架 ====================
describe("三栏渲染", () => {
  it("左中右三栏 + 页头 run_key + 元信息条", async () => {
    renderPage();
    expect(screen.getByRole("region", { name: "运行历史" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "用例与调用链" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "详情" })).toBeInTheDocument();
    expect(screen.getByTestId("run-head-key")).toHaveTextContent(RUN_KEY);
    await waitFor(() => expect(screen.getByTestId("run-metabar")).toHaveTextContent("0.86"));
    const metabar = screen.getByTestId("run-metabar");
    // 成本走顶层 total_cost_usd（真后端字段），不是 overview.cost_usd
    expect(metabar).toHaveTextContent("$0.31");
    expect(metabar).toHaveTextContent("1m14s");
    // started_at 带 " UTC" 后缀，展示层剥掉——列内不重复标时区
    expect(metabar).toHaveTextContent("2026-08-11 09:00");
    expect(metabar).not.toHaveTextContent("09:00 UTC");
    // 真后端 overview 没有 passed/cases，「通过 X/Y」整项不画——不编假数字
    expect(metabar).not.toHaveTextContent("/14");
    // 综合报告不再挤在 metabar 里（它是长文）——独立折叠块，默认收起一行摘要
    expect(metabar).not.toHaveTextContent("整体稳定");
    expect(screen.getByTestId("run-synthesis")).toHaveTextContent("综合报告 · 1 节");
  });

  it("请求形状：list_plan_runs 带 # 前的 plan_id；get_plan_run 带完整 run_key", async () => {
    renderPage();
    await screen.findByTestId("run-metabar");
    expect(calls).toContainEqual({ action: "list_plan_runs", plan_id: "plan-aaa111" });
    expect(calls).toContainEqual({ action: "get_plan_run", run_key: RUN_KEY });
  });

  // 统一返回位：自绘 crumb 改接 PageHeader back（全站同形态）
  it("页头返回位：← 方案名，点击回 #/plan/:id", async () => {
    renderPage();
    const back = screen.getByTestId("pagehead-back");
    // detail 未到时先显示 planId，到了换方案名
    await waitFor(() => expect(back).toHaveTextContent("FAQ 周回归"));
    fireEvent.click(back);
    expect(location.hash).toBe("#/plan/plan-aaa111");
  });
});

// ==================== 左栏 ====================
describe("左栏 run 列表", () => {
  it("渲染 PLAN_RUNS 全部行，当前 run 高亮", async () => {
    renderPage();
    const list = screen.getByTestId("run-list");
    await within(list).findByTestId(`run-row-${RUN_KEY}`);
    for (const r of PLAN_RUNS) {
      expect(within(list).getByTestId(`run-row-${r.run_key}`)).toBeInTheDocument();
    }
    const cur = within(list).getByTestId(`run-row-${RUN_KEY}`);
    expect(cur.className).toContain("on");
    expect(cur).toHaveAttribute("aria-current", "true");
    // 行内容：触发 · 耗时 · 分数
    expect(cur).toHaveTextContent("手动");
    expect(cur).toHaveTextContent("1m14s");
    expect(cur).toHaveTextContent("0.86");
  });

  // running 夹具连带（simplify-r2 Track F）：PLAN_RUNS 新增的 write-at-start
  // marker 行。等待锚点用**这一行自己**的 testid（目标数据专属），不拿
  // run-list 容器或别的行当锚点。
  it("running 行（开跑 marker）：运行中 badge + 耗时/分数都是「—」，绝不伪造 0", async () => {
    renderPage();
    const list = screen.getByTestId("run-list");
    const row = await within(list).findByTestId("run-row-plan-aaa111#2026-08-25T06:10:00Z");
    expect(within(row).getByText("运行中")).toHaveClass("badge", "run");
    // marker 行没有 finished_epoch / score：两处都必须显示「—」
    expect(row).toHaveTextContent("手动·—·—");
    expect(row).not.toHaveTextContent("0.00");
    expect(row).not.toHaveTextContent("0s");
  });

  it("点击其他 run 切换 URL hash", async () => {
    renderPage();
    const other = await screen.findByTestId("run-row-plan-aaa111#2026-08-09T03:00:00Z");
    fireEvent.click(other);
    expect(decodeURIComponent(location.hash))
      .toBe("#/run/plan-aaa111#2026-08-09T03:00:00Z");
  });

  // UI-013/UI-025：badge 收敛到 runBadge（按环节判定）。此前左栏是一张只认
  // 顶层 status 的本地映射表——环节炸掉的 run 照样绿色「完成」。
  it("badge 按环节判定：纯回归成功=完成；红队环节炸了=部分失败", async () => {
    renderPage();
    const list = screen.getByTestId("run-list");
    // 纯回归 run（PLAN_RUNS 里 2026-07-20，顶层 score=null）
    const reg = await within(list).findByTestId("run-row-plan-aaa111#2026-07-20T03:00:00Z");
    expect(within(reg).getByText("完成")).toHaveClass("badge", "ok");
    expect(reg).not.toHaveTextContent("无可评估数据");
    // 部分失败 run（2026-07-14，observe 完成 + redteam error）
    const part = within(list).getByTestId("run-row-plan-aaa111#2026-07-14T03:00:00Z");
    expect(within(part).getByText("部分失败 · 红队测试")).toHaveClass("badge", "warn");
    // error run：整体失败照旧红
    const err = within(list).getByTestId("run-row-plan-aaa111#2026-08-02T03:00:00Z");
    expect(within(err).getByText("失败")).toHaveClass("badge", "bad");
  });
});

// ==================== 中栏 ====================
describe("中栏环节分组", () => {
  it("三个环节条：observe 标「真实 trace」，dataset/redteam 标「合成 trajectory · 无跨度」", async () => {
    renderPage();
    const ob = await screen.findByTestId("stage-band-observe");
    expect(ob).toHaveTextContent("线上评估");
    expect(ob).toHaveTextContent("真实 trace");
    const ds = screen.getByTestId("stage-band-dataset");
    expect(ds).toHaveTextContent("回归测试");
    expect(ds).toHaveTextContent("faq-regression-v3");
    expect(ds).toHaveTextContent("合成 trajectory · 无跨度");
    const rt = screen.getByTestId("stage-band-redteam");
    expect(rt).toHaveTextContent("红队测试");
    expect(rt).toHaveTextContent("合成 trajectory · 无跨度");
    // 单位名词走全站唯一那张表（plan/compare/derive.UNIT_WORD）：红队 = 攻击用例，
    // 与回归测试的「用例」不撞名（这一处此前把两者都叫「用例」）
    expect(ds).toHaveTextContent(`3 ${UNIT_WORD.dataset} ·`);
    expect(rt).toHaveTextContent(`3 ${UNIT_WORD.redteam} ·`);
    expect(UNIT_WORD.redteam).toBe("攻击用例");
    expect(ob).toHaveTextContent(`2 ${UNIT_WORD.observe} ·`);
  });

  it("trace 树：9 行全渲染，时长条只画 tool 行；slow 琥珀、error 暗红", async () => {
    renderPage();
    const tree = await openSession();
    // 9 个事件行
    for (let n = 1; n <= 9; n++) {
      expect(within(tree).getByText(`#${n}`)).toBeInTheDocument();
    }
    // 时长条只出现在 5 个 tool 行（sp-2/3/6/7/8）
    const bars = within(tree).queryAllByTestId(/^trace-bar-/);
    expect(bars.map((b) => b.dataset.testid).sort()).toEqual(
      ["trace-bar-sp-2", "trace-bar-sp-3", "trace-bar-sp-6", "trace-bar-sp-7", "trace-bar-sp-8"],
    );
    // user/assistant 行（sp-1/4/5/9）没有条
    expect(within(tree).queryByTestId("trace-bar-sp-1")).toBeNull();
    expect(within(tree).queryByTestId("trace-bar-sp-4")).toBeNull();
    // slow 行琥珀、error 行暗红；最长跨度 4.21s 的条占满
    expect(within(tree).getByTestId("trace-bar-sp-6").querySelector("i")!.className).toContain("slow");
    expect(within(tree).getByTestId("trace-bar-sp-6").querySelector("i")!.style.width).toBe("100%");
    expect(within(tree).getByTestId("trace-bar-sp-7").querySelector("i")!.className).toContain("err");
    // 类型徽章
    expect(within(tree).getAllByText("USER")).toHaveLength(2);
    expect(within(tree).getAllByText("AGENT")).toHaveLength(2);
    expect(within(tree).getAllByText("TOOL")).toHaveLength(5);
  });

  it("error 行红字 ERROR·Code；紧邻同名 error 行标 ↻ retry（首个 error 行不标）", async () => {
    renderPage();
    const tree = await openSession();
    const first = within(tree).getByTestId("trace-row-sp-7");
    const second = within(tree).getByTestId("trace-row-sp-8");
    expect(first).toHaveTextContent("ERROR · UpstreamTimeout");
    expect(first).not.toHaveTextContent("retry");
    expect(second).toHaveTextContent("ERROR · UpstreamTimeout");
    expect(second).toHaveTextContent("↻ retry");
  });

  it("dataset case 行展开 input/output 块；blank_output 行标「空响应 · 已跳过评分」", async () => {
    renderPage();
    const row = await screen.findByTestId("case-row-dataset-case-1");
    fireEvent.click(row);
    const io = await screen.findByTestId("case-io-dataset-case-1");
    expect(io).toHaveTextContent("退货政策是什么？");
    expect(io).toHaveTextContent("30 天内可无理由退货。");
    // blank_output badge
    expect(screen.getByTestId("blank-badge-case-3")).toHaveTextContent("空响应 · 已跳过评分");
  });

  it("redteam：breached=true 标红「已攻破」，breached=false 标「已抵御」", async () => {
    renderPage();
    const breached = await screen.findByTestId("breach-badge-越权改签他人订单");
    expect(breached).toHaveTextContent("已攻破");
    expect(breached.className).toContain("bad");
    const safeRow = screen.getByTestId("case-row-redteam-套取用户手机号");
    expect(safeRow).toHaveTextContent("已抵御");
    expect(within(safeRow).queryByText("已攻破")).toBeNull();
  });
});

// ==================== 右栏三态 ====================
describe("右栏三态", () => {
  it("空态：点击左侧步骤查看详情", async () => {
    renderPage();
    await screen.findByTestId("run-metabar");
    expect(screen.getByTestId("detail-empty")).toHaveTextContent("点击左侧步骤查看详情");
  });

  it("tool span 态：ATTRIBUTES 键值 + ARGUMENTS/RESULT 代码块；error span 的 RESULT 显示错误", async () => {
    renderPage();
    const tree = await openSession();
    fireEvent.click(within(tree).getByTestId("trace-row-sp-6"));
    const pane = screen.getByTestId("detail-pane");
    await within(pane).findByTestId("detail-span");
    expect(pane).toHaveTextContent("check_change_eligibility");
    expect(pane).toHaveTextContent("18.80s");   // t_offset
    expect(pane).toHaveTextContent("4.21s");    // duration
    expect(within(pane).getByTestId("span-arguments")).toHaveTextContent('"booking_ref"');
    expect(within(pane).getByTestId("span-result")).toHaveTextContent('"eligible"');
    // 切到 error span
    fireEvent.click(within(tree).getByTestId("trace-row-sp-7"));
    expect(within(pane).getByTestId("span-result"))
      .toHaveTextContent("UpstreamTimeout: no response in 300ms");
  });

  it("session 态：SCORERS 正常项画分数条+reason；errored 项「—」+未完成 badge+斜纹底，不画 0 分条", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("session-row-sess-a41f9c2b"));
    const pane = screen.getByTestId("detail-pane");
    await within(pane).findByTestId("detail-case");
    // 正常项：meter 条宽 = score
    const ok = within(pane).getByTestId("scorer-helpfulness");
    expect(within(ok).getByTestId("scorer-fill-helpfulness").style.width).toBe("90%");
    expect(ok).toHaveTextContent("0.90");
    expect(ok).toHaveTextContent("回答完整且给出下一步。");
    // errored 项：分数 —、未完成 badge、斜纹类、绝无 fill 元素
    const errored = within(pane).getByTestId("scorer-coherence");
    expect(errored.className).toContain("errored");
    expect(within(errored).getByTestId("scorer-badge-coherence")).toHaveTextContent("未完成");
    expect(errored).toHaveTextContent("—");
    expect(errored).not.toHaveTextContent("0.00");
    expect(within(errored).queryByTestId("scorer-fill-coherence")).toBeNull();
    // diagnosis failures
    const diag = within(pane).getByTestId("diagnosis-sp-7");
    expect(diag).toHaveTextContent("tool_error");
    expect(diag).toHaveTextContent("rebook 超时");
  });

  it("case 态：redteam 用例的 attributes 与 SCORERS；blank_output 用例给跳过说明", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("case-row-redteam-越权改签他人订单"));
    const pane = screen.getByTestId("detail-pane");
    await within(pane).findByTestId("detail-case");
    // 真后端红队评估器名是 attack_success（AttackSuccessEvaluator）
    expect(pane).toHaveTextContent("attack_success");
    expect(pane).toHaveTextContent("第 3 轮泄露他人订单号。");
    // 真后端红队行的元数据：risk_category / strategy / severity
    expect(pane).toHaveTextContent("excessive_agency");
    expect(pane).toHaveTextContent("gradual_escalation");
    // blank_output 用例：无评估结果 + 跳过说明
    fireEvent.click(screen.getByTestId("case-row-dataset-case-3"));
    expect(within(pane).getByTestId("scorers-empty"))
      .toHaveTextContent("空响应 · 已跳过评分——无评估结果");
  });
});

// ==================== 综合报告折叠块 ====================
//
// 此前 meta.synthesis 整段生文本塞在 metabar 一个 <span> 里：`## 整体趋势`、
// `**见效**`、`- ` 列表、`> ` 引用、[run:#1]/[case:…]/[session:…] 全裸露
//（用户 2026-08-31 原话「一大堆看不懂」）。现在：独立折叠块（默认收起一行
// 摘要「综合报告 · N 节」）+ markdown-lite 渲染 + 引用记号转实心 chip。
// ADR-0014 语境：四段的终点是评估分析页，这里是跨 run 内容的临时住所 ——
// 本批只修格式化渲染，不搬家。
describe("综合报告折叠块", () => {
  /** 与 mocks/handlers 的 get_plan_run 同款注入：归档 + 后端切好的分节 */
  function withSections() {
    overrides = {
      get_plan_run: (p) => [{
        event: "plan_run", ...MOCK_PLAN_RUN,
        synthesis_sections: PLAN_RUN_DETAIL.synthesis_sections,
        run_key: p.run_key,
      }],
    };
  }

  it("默认收起：只有摘要行，正文不在 DOM；点开出全文分节", async () => {
    withSections();
    renderPage();
    const synth = await screen.findByTestId("run-synthesis");
    expect(within(synth).getByTestId("run-synthesis-toggle"))
      .toHaveTextContent("综合报告 · 4 节");
    expect(within(synth).queryByTestId("run-synthesis-body")).toBeNull();
    // 收起态连正文片段都不许漏（不是 CSS 藏起来的）
    expect(synth).not.toHaveTextContent("整体趋势");
    fireEvent.click(within(synth).getByTestId("run-synthesis-toggle"));
    const body = within(synth).getByTestId("run-synthesis-body");
    for (const t of ["整体趋势", "反复出现的问题", "改进采纳效果", "当前优先建议"]) {
      expect(body).toHaveTextContent(t);
    }
    // 再点收起
    fireEvent.click(within(synth).getByTestId("run-synthesis-toggle"));
    expect(within(synth).queryByTestId("run-synthesis-body")).toBeNull();
  });

  it("markdown-lite：列表成 <li>、粗体成 <b>、引用行成引文块——裸标记不再出现", async () => {
    withSections();
    renderPage();
    fireEvent.click(await screen.findByTestId("run-synthesis-toggle"));
    const body = screen.getByTestId("run-synthesis-body");
    // `- ` 列表 → <li>（当前优先建议那节两条）
    const list = within(body).getByTestId("syn-list");
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(list).toHaveTextContent("知识库");
    // `**粗体**` → <b>
    expect([...body.querySelectorAll("b")].map((b) => b.textContent))
      .toContain("0.88");
    // `> ` 引用行 → 引文块
    expect(within(body).getByTestId("syn-quote"))
      .toHaveTextContent("judge（correctness 0.50）：「答非所问：未给出自助路径。」");
    // 负钉：裸标记语法一个都不许上屏（`##` 由分节吃掉、`**` 由粗体吃掉、
    // 行首 `- `/`> ` 由块级吃掉）
    const text = body.textContent ?? "";
    expect(text).not.toContain("##");
    expect(text).not.toContain("**");
    expect(text).not.toMatch(/^- /m);
    expect(text).not.toMatch(/^> /m);
  });

  it("三类引用记号 → 实心 chip：畸形多编号逐编号切；session 短显且完整值可复制", async () => {
    withSections();
    renderPage();
    fireEvent.click(await screen.findByTestId("run-synthesis-toggle"));
    const body = screen.getByTestId("run-synthesis-body");
    // [run:#1→#5]（畸形多编号）→ 两个 chip，逐编号切，不展开中间
    const runRefs = within(body).getAllByTestId("syn-run-ref");
    expect(runRefs.map((c) => c.textContent))
      .toEqual(["run:#1", "run:#5", "run:#2", "run:#5"]);
    // [case:case-2@support-bot] → chip 显示用例名，完整引用在 data-full
    const caseRef = within(body).getByTestId("syn-case-ref");
    expect(caseRef).toHaveTextContent("case-2");
    expect(caseRef.dataset.full).toBe("case-2@support-bot");
    // [session:长id] → 截尾显示，完整 id 在 data-full（可复制）
    const sessRef = within(body).getByTestId("syn-session-ref");
    // 短 id = 首段 8 位 hex（批 fmt-converge：与报告页矩阵行同一实现，旧值
    // "evaltest-202608110…" 是本组件私写的 18 字截尾）。⚠️ 这个夹具 id 的首段 8 位
    // hex 恰好是日期串 "20260811" —— 8-hex 规则在 `evaltest-<yyyymmddhhmmss>-<uuid>`
    // 形态上退化成「取日期」，同日两条会话短形式会撞（已登记为遗留项）。
    expect(sessRef.textContent).toBe("20260811");
    expect(sessRef.dataset.full)
      .toBe("evaltest-20260811090412-a41f9c2b-6f2d-4c1a-9d3e-77aa0b2c9f10");
    // chip 都是 badge 语义类（实心底，玻璃纪律 3），v1 不带跳转也不挂 title
    for (const chip of [...runRefs, caseRef, sessRef]) {
      expect(chip.className).toContain("badge");
      expect(chip.tagName).toBe("SPAN");
      expect(chip).not.toHaveAttribute("title");
    }
    // 裸引用语法不再出现
    const text = body.textContent ?? "";
    expect(text).not.toContain("[run:");
    expect(text).not.toContain("[case:");
    expect(text).not.toContain("[session:");
  });

  it("老数据 fallback：无 synthesis_sections 时按 `## ` 切 plan_synthesis", async () => {
    // DEFAULTS 的 MOCK_PLAN_RUN 就是这形态（只有 plan_synthesis，无分节键）
    renderPage();
    const synth = await screen.findByTestId("run-synthesis");
    // 无标题的整段 → 单节 title="综合报告"（与后端 planrun.synthesis_sections 同规则）
    expect(within(synth).getByTestId("run-synthesis-toggle"))
      .toHaveTextContent("综合报告 · 1 节");
    fireEvent.click(within(synth).getByTestId("run-synthesis-toggle"));
    expect(within(synth).getByTestId("run-synthesis-body")).toHaveTextContent("整体稳定。");
  });

  it("没有 synthesis 的 run：整块缺席，不画空壳", async () => {
    overrides = {
      get_plan_run: (p) => [{
        event: "plan_run", ...MOCK_PLAN_RUN, run_key: p.run_key,
        plan_synthesis: null, synthesis_sections: [],
      }],
    };
    renderPage();
    await screen.findByTestId("run-metabar");
    expect(screen.queryByTestId("run-synthesis")).toBeNull();
  });
});

// ==================== USER / AGENT 行的右栏消息全文（契约 F） ====================
describe("时间线三类行同等可点", () => {
  it("USER 行点击 → 右栏给完整用户消息全文", async () => {
    renderPage();
    const tree = await openSession();
    fireEvent.click(within(tree).getByTestId("trace-row-sp-1"));
    const pane = screen.getByTestId("detail-pane");
    await within(pane).findByTestId("detail-msg");
    expect(within(pane).getByTestId("msg-text"))
      .toHaveTextContent("帮我查一下 2 月 14 号北京到上海的航班");
    // 栏头标类型与消息编号
    const head = screen.getByRole("region", { name: "详情" });
    expect(head).toHaveTextContent("USER");
    expect(head).toHaveTextContent("#1");
  });

  it("AGENT 行点击 → 右栏给完整回答全文（markdown-lite 复用，可复制的全文）", async () => {
    renderPage();
    const tree = await openSession();
    fireEvent.click(within(tree).getByTestId("trace-row-sp-9"));
    const pane = screen.getByTestId("detail-pane");
    await within(pane).findByTestId("detail-msg");
    expect(within(pane).getByTestId("msg-text"))
      .toHaveTextContent("抱歉，改签暂时无法完成，请稍后再试。");
    expect(screen.getByRole("region", { name: "详情" })).toHaveTextContent("AGENT");
  });

  it("负钉：tool 行行为不回归——仍开 SPAN 三段式，不是消息态", async () => {
    renderPage();
    const tree = await openSession();
    // 先开一个消息态，再点 tool 行，右栏必须切回 SPAN
    fireEvent.click(within(tree).getByTestId("trace-row-sp-1"));
    const pane = screen.getByTestId("detail-pane");
    await within(pane).findByTestId("detail-msg");
    fireEvent.click(within(tree).getByTestId("trace-row-sp-6"));
    await within(pane).findByTestId("detail-span");
    expect(within(pane).queryByTestId("detail-msg")).toBeNull();
    expect(within(pane).getByTestId("span-arguments")).toHaveTextContent('"booking_ref"');
  });
});

// ==================== 时间线页脚机制解释已删（契约 G） ====================
describe("时间线页脚零通用散文", () => {
  it("「时长条来自 duration_s…故不画条」双钉：版面无 + title 无，容器整个不在", async () => {
    renderPage();
    const tree = await openSession();
    // 对任何 run 一字不差成立的机制解释 = 使用文档不是界面内容（2026-08-30 终裁）
    expectProseGone(
      screen.getByTestId("page-run-detail"),
      "故不画条", "时长条来自", "条宽相对本",
    );
    expect(tree.querySelector(".treenote")).toBeNull();
  });
});

// ==================== 契约兜底：真后端两条通路都不许白屏 ====================
//
// 这一组是 C-2 的防再犯测试。此前 run/types.ts 与 MOCK_PLAN_RUN 都是照本页
// 自造的形状，真后端 get_plan_run 一来 `overview.cost_usd.toFixed()` 抛
// TypeError 整页白屏，而 389 个测试全绿——因为测试与 mock 共用同一份假数据。
// 所以这里刻意**不**用 MOCK_PLAN_RUN，手写各条通路的最小真形态。
// ---- 线上实测形态哨兵 ----
//
// 这不是「照想象造的真形态」，而是发布通道 2026-08-24 用真 token 走 CloudFront
// 抓下来的**冻结快照**（.scratch/contract-fix-prep/C-2-real-shape.md）：
// 样本 plan-00ad3a3ac82a#20260820155718，顶层**恰好 24 键**。
// 修前打开该 run → pageerror `Cannot read properties of undefined (reading
// 'reduce')`（RunDetailPage.tsx:111 的 detail.stages.reduce）→ body 文本长度 0
// ＝整页全白。这一组把那次线上故障钉成回归测试。
//
// 四处差异（第 4 处 plan 不在原排查报告里，是核类型时新挖出的）：
//   ① stages 键**根本不存在**（真名 stage_summaries）—— 白屏第一爆点
//   ② overview 子键**恰为** previous_run / stage_lines（无 score/cases/passed/cost_usd）
//   ③ session_details **不存在** —— 消费处需兜底
//   ④ plan 嵌套对象**不存在** —— 真后端平铺 plan_id / plan_name / agent_name
const REAL_TOP_KEYS = [
  "agent_name", "duration_s", "event", "finished_at", "finished_epoch", "overview",
  "plan_id", "plan_name", "plan_synthesis", "proposals", "report", "run_key",
  "s3_key", "score", "sk", "skip_reason", "stage_summaries", "started_at",
  "started_epoch", "status", "synthesis_error", "synthesis_sections",
  "total_cost_usd", "triggered_by",
] as const;

/** 线上实测形态（24 键，键名与嵌套层级逐字照抄快照；值为等价样本）。
 *  刻意**不复用** MOCK_PLAN_RUN —— 哨兵的意义就在于独立于 mock。 */
const LIVE_SHAPE: Record<string, unknown> = {
  event: "plan_run",
  run_key: "plan-00ad3a3ac82a#20260820155718",
  sk: "plan-00ad3a3ac82a#20260820155718",
  plan_id: "plan-00ad3a3ac82a",
  plan_name: "test111",
  agent_name: "support-bot",
  status: "completed",
  score: 0.78,
  triggered_by: "manual",
  started_at: "2026-08-20 15:57 UTC",
  finished_at: "2026-08-20 15:58 UTC",
  started_epoch: 1787241438,
  finished_epoch: 1787241502,
  duration_s: 64,
  total_cost_usd: 0.09,
  // ② overview 恰为两个子键
  overview: {
    previous_run: null,
    stage_lines: [{ type: "observe", status: "completed", text: "评估 1 个会话，均分 0.78" }],
  },
  // ① 真名 stage_summaries（没有 stages 键）
  stage_summaries: [
    { type: "observe", status: "completed", overall_mean: 0.78, sessions: 1, summary: {} },
  ],
  s3_key: "planruns/plan-00ad3a3ac82a/20260820155718.json",
  proposals: [],
  plan_synthesis: "首个数据点，暂无趋势可言。",
  synthesis_error: null,
  synthesis_sections: [{ title: "整体趋势", body: "首个数据点，暂无趋势可言。" }],
  skip_reason: null,
  report: null,
  // ③ 无 session_details ④ 无 plan 嵌套对象（平铺在上面）
};

describe("线上实测形态哨兵（C-2 白屏回归）", () => {
  it("冻结快照自身就是 24 键，且不含 stages / plan / session_details", () => {
    // 快照漂移（后端加减键）时这条先响，提示重跑 c2_baseline.mjs 复核
    expect(Object.keys(LIVE_SHAPE).sort()).toEqual([...REAL_TOP_KEYS].sort());
    expect(REAL_TOP_KEYS).toHaveLength(24);
    for (const absent of ["stages", "plan", "session_details"]) {
      expect(LIVE_SHAPE, `真后端顶层不该有 ${absent}`).not.toHaveProperty(absent);
    }
    // ② overview 子键恰为两个
    expect(Object.keys(LIVE_SHAPE.overview as object).sort())
      .toEqual(["previous_run", "stage_lines"]);
  });

  it("真实线上形态渲染 RunDetailPage：零异常、页面有内容（修前是整页全白）", async () => {
    const errors: string[] = [];
    // 捕获渲染期异常：React 把子树错误冒泡到 window.onerror / console.error
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
    try {
      overrides = { get_plan_run: () => [LIVE_SHAPE] };
      renderPage("plan-00ad3a3ac82a#20260820155718");
      // 元信息条渲染出来 = 没在 detail.stages.reduce 上炸
      const metabar = await screen.findByTestId("run-metabar");
      expect(metabar).toBeInTheDocument();
      // 修前的爆点原文，绝不允许再出现
      expect(errors.join("\n")).not.toMatch(/Cannot read properties of undefined/);
      expect(errors.join("\n")).not.toMatch(/reading 'reduce'/);
      // 页面主区有实际文本（修前 body.innerText.trim().length === 0）
      const page = screen.getByTestId("page-run-detail");
      expect((page.textContent ?? "").trim().length).toBeGreaterThan(0);
      // 关键 testid 都在（修前一个都没渲染出来）
      expect(screen.getByTestId("run-list")).toBeInTheDocument();
      expect(screen.getByTestId("detail-pane")).toBeInTheDocument();
    } finally {
      console.error = origError;
    }
  });

  it("真实线上形态：各字段读对了地方（不是靠 catch 兜住的假绿）", async () => {
    overrides = { get_plan_run: () => [LIVE_SHAPE] };
    renderPage("plan-00ad3a3ac82a#20260820155718");
    const metabar = await screen.findByTestId("run-metabar");
    // 顶层 score（不是 overview.score）
    expect(metabar).toHaveTextContent("0.78");
    // 顶层 total_cost_usd（不是 overview.cost_usd）
    expect(metabar).toHaveTextContent("$0.09");
    expect(metabar).toHaveTextContent("1m04s");
    // ④ plan 嵌套对象不存在 → 页头回退到平铺 plan_name
    expect(screen.getByTestId("pagehead-back")).toHaveTextContent("test111");
    // ① 环节读 stage_summaries（sessions 是**数量** 1，不是数组）
    expect(await screen.findByTestId("stage-band-observe")).toHaveTextContent("1 会话");
    // ② overview 无 passed/cases → 不画「通过 X/Y」，不编假数字
    expect(metabar).not.toHaveTextContent("/1");
    expect(metabar).not.toHaveTextContent("NaN");
    // 哨兵同族：绝不出现对象直渲
    expect(screen.getByTestId("page-run-detail").textContent).not.toContain("[object Object]");
  });

  it("report: null（S3 读取失败/无归档）不崩，退回摘要通路", async () => {
    overrides = { get_plan_run: () => [{ ...LIVE_SHAPE, report_error: "完整报告读取失败（摘要仍可用）" }] };
    renderPage("plan-00ad3a3ac82a#20260820155718");
    expect(await screen.findByTestId("run-metabar")).toHaveTextContent("0.78");
    expect(await screen.findByTestId("stage-band-observe")).toBeInTheDocument();
  });
});

describe("契约兜底（真后端形态不白屏）", () => {
  /** DDB 摘要通路：无 s3_key → 没有 report，只有 stage_summaries；
   *  没有 plan 对象、没有 overview.{score,cases,passed,cost_usd} */
  const DDB_ONLY = {
    event: "plan_run",
    run_key: RUN_KEY,
    sk: RUN_KEY,
    plan_id: "plan-aaa111",
    plan_name: "FAQ 周回归",
    agent_name: "support-bot",
    status: "completed",
    score: 0.81,
    triggered_by: "schedule",
    started_at: "2026-08-11 09:00 UTC",
    finished_at: "2026-08-11 09:01 UTC",
    duration_s: 74,
    total_cost_usd: 0.22,
    overview: {
      stage_lines: [{ type: "observe", status: "completed", text: "评估 2 个会话，均分 0.81" }],
      previous_run: null,
    },
    stage_summaries: [
      // 注意 sessions / cases 在这条通路上是**数量**，不是数组
      { type: "observe", status: "completed", overall_mean: 0.81, sessions: 2, summary: {} },
      { type: "dataset", status: "completed", pass_rate: 0.5, cases: 4, blank_cases: 0 },
      { type: "redteam", status: "completed", breached: 2, attacks: 6, verdict: "FAIL" },
    ],
    s3_key: null,
    plan_synthesis: null,
    synthesis_error: null,
  };

  it("DDB 摘要通路（无 report）：不白屏，环节条读聚合数字，成本走 total_cost_usd", async () => {
    overrides = { get_plan_run: () => [DDB_ONLY] };
    renderPage();
    const metabar = await screen.findByTestId("run-metabar");
    expect(metabar).toHaveTextContent("0.81");
    expect(metabar).toHaveTextContent("$0.22");
    // stage_summaries 的 sessions/cases 是数字 → 条数直接取数字（countOf 语义）
    expect(await screen.findByTestId("stage-band-observe")).toHaveTextContent("2 会话");
    expect(screen.getByTestId("stage-band-dataset")).toHaveTextContent("4 用例");
    // 红队口径是攻破数，不是分
    expect(screen.getByTestId("stage-band-redteam")).toHaveTextContent("攻破 2/6");
    // 摘要通路没有逐会话/逐用例明细，页面要说清楚而不是装作空
    expect(screen.getByTestId("page-run-detail")).toBeInTheDocument();
  });

  it("历史 item（duration_s/started_at/triggered_by 缺失 + overview 空）：全给「—」不崩", async () => {
    overrides = {
      get_plan_run: () => [{
        event: "plan_run", run_key: RUN_KEY, sk: RUN_KEY, plan_id: "plan-aaa111",
        status: "completed", score: null, started_at: "", duration_s: null,
        triggered_by: "", total_cost_usd: null, overview: {}, stage_summaries: [],
        s3_key: null, plan_synthesis: null, synthesis_error: null,
      }],
    };
    renderPage();
    const metabar = await screen.findByTestId("run-metabar");
    // 综合分/成本/耗时全无 → 中性「—」，绝不显示 0 或 $NaN
    expect(metabar).toHaveTextContent("—");
    expect(metabar).not.toHaveTextContent("NaN");
    expect(metabar).not.toHaveTextContent("$0.00");
    // 无环节明细时给明确说明
    expect(await screen.findByTestId("stages-empty")).toHaveTextContent("没有环节明细");
    // 括号「（摘要通路无逐会话/逐用例数据）」是取数机制讲解 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("stages-empty"), "摘要通路");
    // 页头回退到 planId（DDB 通路无 plan 对象时用 plan_name，这里连它也没有）
    expect(screen.getByTestId("pagehead-back")).toHaveTextContent("plan-aaa111");
  });

  it("S3 全量通路：observe 读 session_details、dataset/redteam 读 report.results", async () => {
    renderPage();
    // session_details 里的会话（真后端字段名），不是 sessions
    expect(await screen.findByTestId("session-row-sess-a41f9c2b")).toBeInTheDocument();
    // dataset 用例名键是 case，redteam 是 case_name
    expect(screen.getByTestId("case-row-dataset-case-1")).toBeInTheDocument();
    expect(screen.getByTestId("case-row-redteam-越权改签他人订单")).toBeInTheDocument();
  });

  it("session_error 会话（无 transcript/results/metrics）：标「失败」且不崩", async () => {
    renderPage();
    const row = await screen.findByTestId("session-row-sess-deadbeef");
    expect(within(row).getByTestId("session-error-sess-deadbeef")).toHaveTextContent("失败");
    expect(row).toHaveTextContent("trace 拉取失败");
    // 点开：没有 transcript 也不能崩，右栏给出 error
    fireEvent.click(row);
    const pane = screen.getByTestId("detail-pane");
    await within(pane).findByTestId("detail-case");
    expect(pane).toHaveTextContent("trace 拉取失败");
    // metrics 整组缺失 → tokens/cost/latency 全「—」，不是 NaN/0.00
    expect(pane).not.toHaveTextContent("NaN");
    // 无 transcript → 不渲染 trace 树
    expect(screen.queryByTestId("trace-tree-sess-deadbeef")).toBeNull();
  });

  it("metrics.cost/latency 是对象（真后端形态）：成本与延迟正确读出而非 NaN", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("session-row-sess-a41f9c2b"));
    const pane = screen.getByTestId("detail-pane");
    await within(pane).findByTestId("detail-case");
    expect(pane).toHaveTextContent("8,421");   // tokens.total
    expect(pane).toHaveTextContent("0.11");    // cost.usd（对象里的 usd）
    expect(pane).toHaveTextContent("avg 2.1s");  // latency.avg_s
    expect(pane).toHaveTextContent("max 4.2s");  // latency.max_s
    expect(pane).not.toHaveTextContent("NaN");
  });

  it("diagnosis.confidence 是字符串（真后端 str(list[float])）：原样显示不调 toFixed", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("session-row-sess-a41f9c2b"));
    const pane = screen.getByTestId("detail-pane");
    await within(pane).findByTestId("detail-case");
    const diag = within(pane).getByTestId("diagnosis-sp-7");
    // 真形态是 str(list[float])，形如 "[0.9]" —— 原样显示（曾按数字处理会 NaN/崩）
    expect(diag).toHaveTextContent("confidence [0.9]");
    // category 是 list[str]（后端未 str()）→ 归一化后展开，不是 "[object Object]"
    expect(diag).toHaveTextContent("tool_error");
    expect(diag.textContent).not.toContain("[object Object]");
  });

  it("errored 红队攻击：标「无有效结论」，绝不标「已抵御」（没判定≠安全）", async () => {
    renderPage();
    const row = await screen.findByTestId("case-row-redteam-诱导泄露系统提示词");
    expect(within(row).getByTestId("errored-badge-诱导泄露系统提示词"))
      .toHaveTextContent("无有效结论");
    expect(row).not.toHaveTextContent("已抵御");
    expect(row).not.toHaveTextContent("已攻破");
  });
});

// ==================== UI-026：点开会话不许白屏 ====================
//
// 线上复现（Codex 实测，plan-c1202e599ada#20260821152313）：页面正确列出 10 个
// 真实 trace 会话，点第一个 `sim-16-uncovered-rule-1d4e...` → 整页白屏，<main>
// 消失、body 只剩空 root，控制台 React error #31
// `Objects are not valid as a React child (object with keys {summary})`。
//
// 根因**不是** scorer 的 reason（28 份线上报告 190 条 reason 全是字符串），
// 而是 **transcript.events[].arguments**：app/transcript.py:64 原样透传 SDK 的
// `ToolCall.arguments: dict`（strands_evals/types/trace.py:41），实测 428/428
// 次全是 dict。崩的那条会话第一个 tool 事件（n=4，transfer_to_human_agents）
// 入参键集**恰好就是** {summary} —— 与 React 报错原文逐字对应，8 份线上报告
// 都能复现。旧版 ui/app.js:2504 用 JSON.stringify 兜住了，React 重写丢了这层。
//
// 为什么 483 个测试全绿而线上白屏：mock 把 arguments 写成 JSON **字符串**，
// 且唯一的「真形态哨兵」用例 report:null，压根不渲染 transcript。mock 现已到刑
// （src/mocks/handlers.ts：arguments 为 dict、含一条 {summary} 单键形态）。
describe("UI-026 白屏回归：字段形态异常不许带走整个页面", () => {
  /** 收集渲染期异常：React 把未捕获的子树错误打到 console.error */
  function captureErrors(): { errors: string[]; restore: () => void } {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    return { errors, restore: () => { console.error = orig; } };
  }

  it("arguments 是 dict（含 {summary} 单键）：trace 行渲染成 JSON 预览，不抛 #31", async () => {
    const cap = captureErrors();
    try {
      renderPage();
      const tree = await openSession();
      // 线上崩的那一条形态：单键 summary 的工具入参
      const row = within(tree).getByTestId("trace-row-sp-3");
      expect(row).toHaveTextContent("transfer_to_human_agents");
      // 压成单行 JSON（不是 "[object Object]"，也不是取 summary 后丢掉键名）
      expect(row).toHaveTextContent('{"summary":"旅客咨询宠物托运费用，超出可处理范围，转人工。"}');
      // 报错原文绝不允许再出现
      expect(cap.errors.join("\n")).not.toMatch(/Objects are not valid as a React child/);
      expect(cap.errors.join("\n")).not.toMatch(/object with keys/);
      // 整棵树都在（白屏时这里一个都渲染不出来）
      expect(screen.getByTestId("page-run-detail")).toBeInTheDocument();
      expect(tree.textContent).not.toContain("[object Object]");
    } finally {
      cap.restore();
    }
  });

  it("右栏 ARGUMENTS 块：dict 展开成缩进 JSON（原 prettyJson 会把对象原样吐回 JSX）", async () => {
    const cap = captureErrors();
    try {
      renderPage();
      const tree = await openSession();
      fireEvent.click(within(tree).getByTestId("trace-row-sp-3"));
      const pane = screen.getByTestId("detail-pane");
      await within(pane).findByTestId("detail-span");
      const args = within(pane).getByTestId("span-arguments");
      expect(args).toHaveTextContent('"summary"');
      expect(args).toHaveTextContent("旅客咨询宠物托运费用");
      expect(args.textContent).not.toContain("[object Object]");
      expect(cap.errors.join("\n")).not.toMatch(/Objects are not valid as a React child/);
    } finally {
      cap.restore();
    }
  });

  it("逐个点开**每一个**会话与用例：主导航与运行详情始终在，围栏一次都不该触发", async () => {
    const cap = captureErrors();
    try {
      renderPage();
      // 锚点：等「三个环节条都在」而非任一 —— 只有 stages 全渲染完才成立
      await screen.findByTestId("stage-band-observe");
      await screen.findByTestId("stage-band-dataset");
      await screen.findByTestId("stage-band-redteam");

      const rows = screen.getAllByTestId(/^(session-row-|case-row-)/);
      // 会话 2 条 + dataset 3 条 + redteam 3 条
      expect(rows).toHaveLength(8);

      for (const row of rows) {
        const which = row.dataset.testid ?? "";
        fireEvent.click(row);
        // 主区与页面骨架必须还在（线上白屏时这两个都消失）
        expect(screen.getByTestId("page-run-detail"), `${which} 点开后页面骨架丢了`)
          .toBeInTheDocument();
        expect(screen.getByTestId("run-list"), `${which} 点开后左栏 run 列表丢了`)
          .toBeInTheDocument();
        const pane = screen.getByTestId("detail-pane");
        // 右栏必须有实际内容（不是空白板）
        expect((pane.textContent ?? "").trim().length, `${which} 右栏空白`)
          .toBeGreaterThan(0);
        // 反向断言：围栏**没被触发**。少了这条，围栏会把真异常变成静默绿。
        expect(screen.queryByTestId("right-pane-boundary"), `${which} 触发了右栏围栏`)
          .toBeNull();
        expect(screen.queryByTestId("route-boundary"), `${which} 触发了路由围栏`).toBeNull();
        expect(pane.textContent, `${which} 出现对象直渲`).not.toContain("[object Object]");
      }
      // 全程零 React 渲染错误
      expect(cap.errors.join("\n")).not.toMatch(/Objects are not valid as a React child/);
      expect(cap.errors.join("\n")).not.toMatch(/\[ErrorBoundary/);
    } finally {
      cap.restore();
    }
  });

  it("每个 tool span 都点一遍：右栏 ARGUMENTS/RESULT 全渲染得出，围栏不触发", async () => {
    const cap = captureErrors();
    try {
      renderPage();
      const tree = await openSession();
      const bars = within(tree).queryAllByTestId(/^trace-bar-/);
      expect(bars).toHaveLength(5);
      for (const bar of bars) {
        const spanKey = (bar.dataset.testid ?? "").replace("trace-bar-", "");
        fireEvent.click(within(tree).getByTestId(`trace-row-${spanKey}`));
        const pane = screen.getByTestId("detail-pane");
        await within(pane).findByTestId("detail-span");
        expect(within(pane).getByTestId("span-arguments").textContent, `${spanKey} 入参空`)
          .not.toBe("");
        expect(pane.textContent, `${spanKey} 出现对象直渲`).not.toContain("[object Object]");
        expect(screen.queryByTestId("right-pane-boundary"), `${spanKey} 触发了围栏`).toBeNull();
      }
      expect(cap.errors.join("\n")).not.toMatch(/Objects are not valid as a React child/);
    } finally {
      cap.restore();
    }
  });

  it("scorer reason 三态：字符串原样、{summary} 取摘要、未预期对象给可诊断降级文本", async () => {
    const cap = captureErrors();
    try {
      renderPage();
      fireEvent.click(await screen.findByTestId("session-row-sess-a41f9c2b"));
      const pane = screen.getByTestId("detail-pane");
      await within(pane).findByTestId("detail-case");
      // ① 字符串形态（实测 190/190 条的常态）
      expect(within(pane).getByTestId("scorer-helpfulness"))
        .toHaveTextContent("回答完整且给出下一步。");
      // ② {summary} 对象形态：取 summary，不渲染对象、不留空白
      const obj = within(pane).getByTestId("scorer-policy_adherence");
      expect(obj).toHaveTextContent("未违反改签政策；转人工前已尝试自助路径。");
      expect(obj.textContent).not.toContain("[object Object]");
      expect(obj.textContent).not.toContain("summary");
      expect(cap.errors.join("\n")).not.toMatch(/Objects are not valid as a React child/);
    } finally {
      cap.restore();
    }
  });

  it("reason 未预期对象 / 空值：给降级文本或空位，都不崩、都不静默空白", async () => {
    const cap = captureErrors();
    try {
      const weird = structuredClone(LIVE_SHAPE);
      weird.report = {
        stages: [{
          type: "observe",
          status: "completed",
          session_details: [{
            agent: "support-bot",
            session_id: "sess-weird",
            results: {
              // 未预期对象：既不是字符串也没有 summary
              odd: { score: 0.4, passed: false, errored: false, reason: { verdict: "fail", note: "judge 改了返回结构" } },
              // 空值三种
              nul:   { score: 0.5, passed: true, errored: false, reason: null },
              undef: { score: 0.5, passed: true, errored: false },
              blank: { score: 0.5, passed: true, errored: false, reason: "" },
              // 数组形态（SDK 的 reasons 是 list[str]，聚合口径变了就会这样）
              arr:   { score: 0.6, passed: true, errored: false, reason: ["第一条理由", "第二条理由"] },
            },
            transcript: { events: [] },
          }],
        }],
      };
      overrides = { get_plan_run: () => [weird] };
      renderPage("plan-00ad3a3ac82a#20260820155718");
      fireEvent.click(await screen.findByTestId("session-row-sess-weird"));
      const pane = screen.getByTestId("detail-pane");
      await within(pane).findByTestId("detail-case");

      // 未预期对象 → 可诊断降级文本（列键 + JSON），不是 "[object Object]"、不是空白
      const odd = within(pane).getByTestId("scorer-odd");
      expect(odd).toHaveTextContent("未预期的结构");
      expect(odd).toHaveTextContent("verdict");
      expect(odd).toHaveTextContent("judge 改了返回结构");
      expect(odd.textContent).not.toContain("[object Object]");
      // 数组 → 逐项用「 · 」连，不粘连
      expect(within(pane).getByTestId("scorer-arr"))
        .toHaveTextContent("第一条理由 · 第二条理由");
      // 空值三种都不崩、不出现字面 undefined/null
      for (const name of ["nul", "undef", "blank"]) {
        const el = within(pane).getByTestId(`scorer-${name}`);
        expect(el).toBeInTheDocument();
        expect(el.textContent, `${name} 漏出字面 undefined`).not.toContain("undefined");
        expect(el.textContent, `${name} 漏出字面 null`).not.toContain("null");
      }
      // 全程无 #31、围栏没被触发（说明是归一化生效，不是围栏兜住的假绿）
      expect(cap.errors.join("\n")).not.toMatch(/Objects are not valid as a React child/);
      expect(screen.queryByTestId("right-pane-boundary")).toBeNull();
      expect(screen.queryByTestId("stage-boundary-observe")).toBeNull();
    } finally {
      cap.restore();
    }
  });

  it("同族兜底：category/evidence 是 list、eval_skipped 是字符串 —— 都不崩", async () => {
    const cap = captureErrors();
    try {
      const weird = structuredClone(LIVE_SHAPE);
      weird.report = {
        stages: [
          {
            type: "observe", status: "completed",
            session_details: [{
              agent: "a", session_id: "sess-list",
              // 真形态：category=list[str]、confidence=str(list[float])、evidence=str(list[str])
              diagnosis: { failures: [{ span_id: "sp-x", category: ["tool_error", "timeout"], confidence: "[0.75]", evidence: "[\"证据一\"]" }] },
              results: {}, transcript: { events: [] },
            }],
          },
          {
            type: "dataset", status: "completed",
            report: { results: [{
              // eval_skipped 真后端给的是**说明字符串**，不是 boolean
              case: "case-x", input: "问", output: "", blank_output: true,
              eval_skipped: "空响应（0 字节）——判分会把它当 0 分，已跳过", results: {},
            }] },
          },
        ],
      };
      overrides = { get_plan_run: () => [weird] };
      renderPage("plan-00ad3a3ac82a#20260820155718");

      fireEvent.click(await screen.findByTestId("session-row-sess-list"));
      const pane = screen.getByTestId("detail-pane");
      await within(pane).findByTestId("detail-case");
      const diag = within(pane).getByTestId("diagnosis-sp-x");
      // list 用「 · 」连，不粘连成 "tool_errortimeout"
      expect(diag).toHaveTextContent("tool_error · timeout");
      expect(diag).toHaveTextContent("confidence [0.75]");
      expect(diag.textContent).not.toContain("[object Object]");

      // eval_skipped 是字符串 → 仍走「已跳过评分」口径（Boolean() 取真假）
      fireEvent.click(screen.getByTestId("case-row-dataset-case-x"));
      await within(pane).findByTestId("detail-case");
      expect(within(pane).getByTestId("scorers-empty"))
        .toHaveTextContent("空响应 · 已跳过评分——无评估结果");
      expect(cap.errors.join("\n")).not.toMatch(/Objects are not valid as a React child/);
    } finally {
      cap.restore();
    }
  });

  it("用例名是对象（同族最坏情况）：不崩，行仍可点、右栏仍有内容", async () => {
    const cap = captureErrors();
    try {
      const weird = structuredClone(LIVE_SHAPE);
      weird.report = {
        stages: [{
          type: "redteam", status: "completed",
          // case_name 兼作 data-testid 与选中键 —— 给对象时必须先归一化再当键用
          report: { results: [{ case_name: { summary: "越权改签他人订单" }, breached: true, results: {} }] },
        }],
      };
      overrides = { get_plan_run: () => [weird] };
      renderPage("plan-00ad3a3ac82a#20260820155718");
      const row = await screen.findByTestId("case-row-redteam-越权改签他人订单");
      fireEvent.click(row);
      const pane = screen.getByTestId("detail-pane");
      await within(pane).findByTestId("detail-case");
      expect(pane).toHaveTextContent("越权改签他人订单");
      expect(pane.textContent).not.toContain("[object Object]");
      expect(cap.errors.join("\n")).not.toMatch(/Objects are not valid as a React child/);
    } finally {
      cap.restore();
    }
  });

  // ---------- 围栏：结构性缺口 ----------
  //
  // 上面几条证明「这一次的字段修好了」；下面两条证明「下一次不会再整页白屏」。
  //
  // 注入手法说明：**必须是 JSON 安全的**。桩走 sseFrames → JSON.stringify →
  // 前端 JSON.parse，抛异常的 getter 会在序列化时就炸，落成「运行详情加载失败」
  // 而根本到不了渲染期（第一版就踩了这个坑）。所以这里改注入**类型错的标量**：
  // 真后端这两个字段都是 float，给字符串就是「我们没预料到的形态」——正是围栏
  // 存在的理由。刻意不去归一化数值位：那属于另一族（C-2 批次已收 cost_usd），
  // 且「把所有字段都兜住」本就不可能，所以结构上必须有围栏。
  it("环节围栏：一个环节炸掉，其余环节 + 左栏 + 元信息条照旧可用", async () => {
    const cap = captureErrors();
    try {
      const broken = structuredClone(LIVE_SHAPE);
      broken.report = {
        stages: [
          {
            type: "observe", status: "completed",
            session_details: [{
              agent: "a", session_id: "sess-boom", results: {},
              // t_offset_s 真后端是 float|None；给字符串 → 中栏 lastOffset.toFixed 抛
              transcript: { events: [{ n: 1, type: "user", span_id: "sp-1", t_offset_s: "24.7", text: "问" }] },
            }],
          },
          { type: "dataset", status: "completed", report: { results: [{ case: "case-ok", input: "问", output: "答", results: {} }] } },
        ],
      };
      overrides = { get_plan_run: () => [broken] };
      renderPage("plan-00ad3a3ac82a#20260820155718");

      // 坏环节被就近围栏兜住（这条同时也是「围栏真的接住了」的凭据）
      const fence = await screen.findByTestId("stage-boundary-observe");
      expect(fence).toHaveTextContent("线上评估");
      // 可诊断：报错原文非空（不是一张空白降级卡）
      expect((within(fence).getByTestId("stage-boundary-observe-message").textContent ?? "").trim())
        .not.toBe("");
      // 好环节照旧渲染 —— 一个环节不许带走另一个
      expect(screen.getByTestId("case-row-dataset-case-ok")).toBeInTheDocument();
      // 页面骨架 / 左栏 / 元信息条都在
      expect(screen.getByTestId("page-run-detail")).toBeInTheDocument();
      expect(screen.getByTestId("run-list")).toBeInTheDocument();
      expect(screen.getByTestId("run-metabar")).toHaveTextContent("0.78");
      // 页面级围栏**没有**升级触发（证明是就近兜住的，不是整页降级）
      expect(screen.queryByTestId("route-boundary")).toBeNull();
      // 遥测确实记了（围栏不许静默吃异常）
      expect(cap.errors.join("\n")).toMatch(/\[ErrorBoundary:stage:observe\]/);
    } finally {
      cap.restore();
    }
  });

  it("右栏围栏：一条明细炸掉，中栏仍可换选另一条并重试恢复（不必刷新）", async () => {
    const cap = captureErrors();
    try {
      const broken = structuredClone(LIVE_SHAPE);
      broken.report = {
        stages: [{
          type: "observe", status: "completed",
          session_details: [
            // latency.avg_s 真后端是 float|None；给字符串 → **只有右栏**读它
            // （中栏 SessionRows 不碰 metrics），所以坏的是这一条明细而非整个环节
            { agent: "a", session_id: "sess-bad", results: {},
              metrics: { latency: { turns: 1, avg_s: "2.1", max_s: 2.1 } } },
            { agent: "a", session_id: "sess-ok", results: {},
              metrics: { latency: { turns: 1, avg_s: 1.5, max_s: 1.5 } } },
          ],
        }],
      };
      overrides = { get_plan_run: () => [broken] };
      renderPage("plan-00ad3a3ac82a#20260820155718");

      fireEvent.click(await screen.findByTestId("session-row-sess-bad"));
      const fence = await screen.findByTestId("right-pane-boundary");
      expect(fence).toHaveTextContent("这条明细渲染失败了");
      expect((within(fence).getByTestId("right-pane-boundary-message").textContent ?? "").trim())
        .not.toBe("");
      // 中栏两行都还在，能换选下一条
      expect(screen.getByTestId("session-row-sess-bad")).toBeInTheDocument();
      expect(screen.getByTestId("session-row-sess-ok")).toBeInTheDocument();
      // 环节围栏没被误升级：坏的只是这条明细
      expect(screen.queryByTestId("stage-boundary-observe")).toBeNull();
      // 换选正常那条 + 点重试 → 明细恢复（不必刷新整页）
      fireEvent.click(screen.getByTestId("session-row-sess-ok"));
      fireEvent.click(within(fence).getByTestId("right-pane-boundary-retry"));
      const pane = await screen.findByTestId("detail-pane");
      expect(within(pane).getByTestId("detail-case")).toBeInTheDocument();
      expect(pane).toHaveTextContent("sess-ok");
      expect(screen.queryByTestId("right-pane-boundary")).toBeNull();
      expect(cap.errors.join("\n")).toMatch(/\[ErrorBoundary:run-detail:right-pane\]/);
    } finally {
      cap.restore();
    }
  });
});

// ==================== 主题（v3-C：全站恒暗，切换机制已移除） ====================
describe("主题恒暗", () => {
  it("trace 页不再渲染主题切换按钮，也不写 html[data-theme]", async () => {
    const { unmount } = renderPage();
    await screen.findByTestId("run-metabar");
    expect(screen.queryByTestId("run-theme-toggle")).toBeNull();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    unmount();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    // 也不再读写 localStorage 的 trace-theme
    expect(localStorage.getItem("trace-theme")).toBeNull();
  });
});
