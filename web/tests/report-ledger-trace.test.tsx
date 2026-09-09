// 报告页 ⑦ 问题条目 → trace 的路（批 badcase-ux-fix；用户 2026-09-07 现网反馈「问题台账没有和
// trace 对应」）。四件事：
//   a) 证据 chip 点击 ⇒ 滚到矩阵行并高亮，且**不改路由**（此前 <a href="#rp-row-…"> 在真浏览器里
//      会把 location.hash 改成非路由串 ⇒ 路由器认不出 ⇒ 落回首页；jsdom 不跟随锚点导航所以老测试没红）；
//   b) 每条问题一个「查看 trace」链接 = 现有页脚同一构造（`#/run/<run_key>`，run 级）；
//   c) 问题文本里的 16 位十六进制 span id 识别成可点 chip：点了复制到剪贴板 + toast；
//   d) 「同会话 + 同 fix_type + 建议前 40 字相同」折成一组，默认收起。
// 夹具 = 桩 MOCK_PLAN_RUN_OBSERVE 的 DSH_ISSUES（问题文本里本来就带 `span 959e4e17ff051a5f` 这类 id）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReportPage from "../src/pages/report/ReportPage";
import {
  ANNOTATIONS, MOCK_PLAN_RUN_OBSERVE, OBSERVE_PLAN_RUNS, OBSERVE_RUN_KEY, sseFrames,
} from "../src/mocks/handlers";
import { matrixRowAnchor, shortSessionId } from "../src/pages/plan/reportRows";
import type { SynthesisIssue } from "../src/pages/plan/types";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";
import { spanIdsOf } from "../src/pages/agents/detail/hub/IssueLedger";
import { parseHash } from "../src/router";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
type Payload = { action: string } & Record<string, unknown>;
let overrides: Record<string, (p: Payload) => unknown[]> = {};

const ISSUES = MOCK_PLAN_RUN_OBSERVE.synthesis_issues as unknown as SynthesisIssue[];
/** 问题文本里带 `span <16 hex>` 的那一条（夹具专属锚点） */
const WITH_SPAN = ISSUES.find((it) => /span [0-9a-f]{16}/.test(it.problem))!;
const SPAN_ID = /span ([0-9a-f]{16})/.exec(WITH_SPAN.problem)![1];

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: OBSERVE_PLAN_RUNS }],
  get_plan_run: (p) => [{ event: "plan_run", ...MOCK_PLAN_RUN_OBSERVE, run_key: p.run_key }],
  list_datasets: () => [{ event: "datasets", datasets: [] }],
  list_annotations: (p) => [{ event: "annotations", run_key: p.run_key, items: ANNOTATIONS.filter((a) => a.run_key === p.run_key) }],
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
function renderReport() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ReportPage id={OBSERVE_RUN_KEY} /></QueryClientProvider>);
}
async function openReport() {
  renderReport();
  await screen.findByTestId(`agent-issue-${WITH_SPAN.id}`);
}

beforeEach(() => {
  overrides = {};
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
  document.querySelectorAll("[data-testid=toast]").forEach((el) => el.remove());
});

describe("a) 证据 chip → 矩阵行：高亮 + 不改路由", () => {
  it("根因钉：裸行锚点 #rp-row-… 不是路由 ⇒ parseHash 认成首页（真浏览器点旧 <a href=#rp-row-…> 就是这么被踢出报告页的）", () => {
    expect(parseHash(`#${matrixRowAnchor(0, WITH_SPAN.evidence[0].ref)}`)).toEqual({ view: "agents" });
    // 换成 ?row= 深链后是报告路由；页面自己切 ?row=（splitReportId）
    expect(parseHash(`#/report/${encodeURIComponent(OBSERVE_RUN_KEY)}?row=${encodeURIComponent(WITH_SPAN.evidence[0].ref)}`).view).toBe("report");
  });

  it("href 是本页 ?row= 深链（可复制 / 中键）；点击 preventDefault、行打 is-target、location.hash 仍是报告路由", async () => {
    await openReport();
    const row = screen.getByTestId(`agent-issue-${WITH_SPAN.id}`);
    const chip = within(row).getAllByTestId(`agent-issue-${WITH_SPAN.id}-evidence`)[0];
    const sid = WITH_SPAN.evidence[0].ref;
    expect(chip.tagName).toBe("A");
    expect(chip).toHaveAttribute("href", `#/report/${encodeURIComponent(OBSERVE_RUN_KEY)}?row=${encodeURIComponent(sid)}`);
    expect(chip).toHaveTextContent(shortSessionId(sid));
    // fireEvent 回 false = 事件被 preventDefault（浏览器默认的锚点导航被拦住 ⇒ 路由不会被改写成 #rp-row-… 落回首页）
    const notCancelled = fireEvent.click(chip);
    expect(notCancelled).toBe(false);
    expect(document.getElementById(matrixRowAnchor(0, sid))!.className).toContain("is-target");
    expect(location.hash).toBe(`#/report/${encodeURIComponent(OBSERVE_RUN_KEY)}`);
  });
});

describe("b) 每条问题「查看 trace」", () => {
  it("href = 页脚底座 #/run/<run_key> + ?session=<首条会话完整 id>（桩 5 条都带会话证据）；title 写会话短 id 与「按 span id 定位」", async () => {
    await openReport();
    const foot = screen.getByTestId("report-drawer-trace");
    expect(foot).toHaveTextContent("查看 trace");
    for (const it of ISSUES) {
      const link = screen.getByTestId(`agent-issue-${it.id}-trace`);
      expect(link.tagName).toBe("A");
      // 三态里的哪一态由 route-query.test.tsx 逐态钉；这里只钉「底座 = 页脚同一 run_key」与会话参数在；
      // 问题文本点名了 span 的那几条再多一段 &span=<第一个 id>（批 topology-sessions，span-deeplink.test.tsx 钉细节）
      const firstSpan = spanIdsOf(it.problem)[0];
      expect(link).toHaveAttribute("href",
        `#/run/${encodeURIComponent(OBSERVE_RUN_KEY)}?session=${encodeURIComponent(it.evidence[0].ref)}${firstSpan ? `&span=${firstSpan}` : ""}`);
      expect(link).toHaveTextContent("查看 trace");
      expect(link.getAttribute("title")).toContain(shortSessionId(it.evidence[0].ref));
      expect(link.getAttribute("title")).toContain("span id");
    }
  });
});

describe("c) span id chip：复制 + toast", () => {
  it("spanIdsOf 只认独立的 16 位十六进制（会话 id 里的 8/12 位段、sess-<16hex> 不算）", () => {
    expect(spanIdsOf("Agent在span 959e4e17ff051a5f给出了四句话")).toEqual(["959e4e17ff051a5f"]);
    expect(spanIdsOf("会话dsh-trace-e5d8fb96-5a9f-4d42-8d12-a742b7bd3fa5中")).toEqual([]);
    expect(spanIdsOf("会话 sess-7f3a9c21b8d4e6f0 里")).toEqual([]);
    expect(spanIdsOf("裸 0bba0638263aff91 与 e9a246b455fd2149")).toEqual(["0bba0638263aff91", "e9a246b455fd2149"]);
    expect(spanIdsOf("0bba0638263aff91 重复 0bba0638263aff91")).toEqual(["0bba0638263aff91"]);
  });

  it("问题文本里的 span id 渲染成 chip（<a> 指向 ?session=<sid>&span=<id>，批 topology-sessions 起是真深链）；shift+点击 ⇒ clipboard.writeText(id) + toast「已复制 span id」；title 写「在 trace 里定位到这个 span」", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await openReport();
    const row = screen.getByTestId(`agent-issue-${WITH_SPAN.id}`);
    const chip = within(row).getByTestId(`agent-issue-${WITH_SPAN.id}-span-${SPAN_ID}`);
    expect(chip).toHaveTextContent(SPAN_ID);
    expect(chip.getAttribute("title")).toContain("在 trace 里定位到这个 span");
    // 问题文本仍完整在版面上（chip 是就地替换，不是另起一行）
    expect(row).toHaveTextContent(WITH_SPAN.problem.replace(/\s+/g, " ").slice(0, 12));
    // 这条问题有会话证据 ⇒ chip 是 span 级深链
    expect(chip.tagName).toBe("A");
    expect(chip).toHaveAttribute("href",
      `#/run/${encodeURIComponent(OBSERVE_RUN_KEY)}?session=${encodeURIComponent(WITH_SPAN.evidence[0].ref)}&span=${SPAN_ID}`);
    fireEvent.click(chip, { shiftKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SPAN_ID));
    const toast = await screen.findByTestId("toast");
    expect(toast).toHaveTextContent("已复制 span id");
  });
});

describe("d) 同类折叠：同会话 + 同 fix_type + 建议前 40 字相同 ⇒ 折一组，默认收起", () => {
  it("注入 2 条与某条同类的条目 ⇒ 只显示 1 行 + 「另有 2 条同类」；展开后 3 行都在；不同类不折", async () => {
    const base = ISSUES[0];
    const clones: SynthesisIssue[] = [1, 2].map((k) => ({
      ...base,
      id: `c10ne00${k}`,
      problem: `${base.problem}（第 ${k} 次换措辞）`,
      recommendation: `${(base.recommendation ?? "").slice(0, 40)}……措辞第 ${k} 版`,
      recommendation_source: null,
    }));
    overrides.get_plan_run = (p) => [{
      event: "plan_run", ...MOCK_PLAN_RUN_OBSERVE, run_key: p.run_key,
      synthesis_issues: [...ISSUES, ...clones],
    }];
    await openReport();
    // 卡头计数仍按全部条目算（折叠只是展示）
    expect(screen.getByTestId("agent-ledger-sub")).toHaveTextContent(`${ISSUES.length + 2} 条`);
    expect(screen.getByTestId(`agent-issue-${base.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId("agent-issue-c10ne001")).toBeNull();
    expect(screen.queryByTestId("agent-issue-c10ne002")).toBeNull();
    const fold = screen.getByTestId(`agent-issue-${base.id}-fold`);
    expect(fold).toHaveTextContent("另有 2 条同类");
    // 其余条目（同会话但建议不同）不折：都各自成行、没有折叠钮
    for (const it of ISSUES.slice(1)) {
      expect(screen.getByTestId(`agent-issue-${it.id}`)).toBeInTheDocument();
      expect(screen.queryByTestId(`agent-issue-${it.id}-fold`)).toBeNull();
    }
    fireEvent.click(fold);
    expect(screen.getByTestId("agent-issue-c10ne001")).toBeInTheDocument();
    expect(screen.getByTestId("agent-issue-c10ne002")).toBeInTheDocument();
    expect(screen.getByTestId(`agent-issue-${base.id}-fold`)).toHaveTextContent("收起 2 条同类");
  });

  it("桩里的 5 条本来互不同类（建议各不同）⇒ 5 行全显示、无折叠钮", async () => {
    await openReport();
    for (const it of ISSUES) {
      expect(screen.getByTestId(`agent-issue-${it.id}`)).toBeInTheDocument();
      expect(screen.queryByTestId(`agent-issue-${it.id}-fold`)).toBeNull();
    }
  });
});
