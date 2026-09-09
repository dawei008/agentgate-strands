// 监控大屏（#/bigscreen）测试：推导层纯函数 + 组件渲染。
// 口径权威 = ui-prototypes/dashboard-bigscreen/index.html；
// 均分口径与 workbench/kpi.ts 同宗（「有分数才算成功」）。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { expectProseGone } from "./prose";
import type { ReactElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTest } from "../src/lib/config";
import {
  sseFrames, BIGSCREEN_PLANS, BIGSCREEN_RUNS_ALERT, BIGSCREEN_RUNS_OK,
} from "../src/mocks/handlers";
import Shell from "../src/components/layout/Shell";
import { parseHash } from "../src/router";
import BigscreenPage, { EV_MAX, PAGE_SIZE } from "../src/pages/bigscreen/BigscreenPage";
import {
  breachOf, deriveAgents, deriveEvents, deriveKpi, deriveLamp, deriveStale,
  isNoScore, isScored, needsAttentionCount, scoreOf, REFRESH_MS, STALE_AFTER_MS,
  type BigscreenEvent,
} from "../src/pages/bigscreen/derive";
import type { BigscreenRun } from "../src/pages/bigscreen/types";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
/** 假数据基准时刻（与 handlers.ts 两态数据集一致） */
const PINNED = Date.UTC(2026, 7, 22, 4, 12, 0);

type Payload = { action?: string } & Record<string, unknown>;

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function stubFetch(overrides: Record<string, (payload: Payload) => Response> = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    const handler = overrides[payload.action ?? ""];
    if (handler) return handler(payload);
    switch (payload.action) {
      case "list_plans":
        return sseResponse([{ event: "plans", plans: BIGSCREEN_PLANS }]);
      case "list_recent_runs":
        return sseResponse([{ event: "recent_runs", runs: BIGSCREEN_RUNS_OK }]);
      default:
        return sseResponse([{ event: "error", error: `未实现 ${payload.action}` }]);
    }
  }));
}

function renderPage(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** ?mock=bigscreen-* 钉死页面时钟到 PINNED（截图/测试同一机制） */
function pinClock(state: "ok" | "alert" = "ok") {
  window.history.replaceState(null, "", `/?mock=bigscreen-${state}#/bigscreen`);
}

beforeEach(() => {
  resetConfigForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  pinClock("ok");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

// ============================================================
// 推导层（纯函数）
// ============================================================

describe("健康灯三态判定（deriveLamp）", () => {
  const bad: BigscreenEvent = { lv: "bad", t: "运行失败", d: "", at: "2026-08-22 04:00", ic: "x" };
  const warn: BigscreenEvent = { lv: "warn", t: "未计分", d: "", at: "2026-08-22 04:00", ic: "alert" };

  it("有 bad 级事件（breached / error run）→ 故障红「需要处理」", () => {
    const lamp = deriveLamp([bad, warn], 6);
    expect(lamp.state).toBe("bad");
    expect(lamp.txt).toBe("需要处理");
    expect(lamp.sub).toContain("1 项故障");
    expect(lamp.sub).toContain("1 项警告");
  });
  it("仅 warn 级 → 琥珀「有警告」", () => {
    const lamp = deriveLamp([warn, warn], 6);
    expect(lamp.state).toBe("warn");
    expect(lamp.txt).toBe("有警告");
    expect(lamp.sub).toBe("2 项待确认");
  });
  it("无事件 → 全绿「运行正常」", () => {
    const lamp = deriveLamp([], 6);
    expect(lamp.state).toBe("ok");
    expect(lamp.txt).toBe("运行正常");
    expect(lamp.sub).toBe("全部 6 个 Agent 健康");
  });
});

describe("KPI 推导口径（对照 kpi.ts「有分数才算成功」）", () => {
  it("均分只吃 completed 且推得出 observe 分的 run；empty observe 不计入", () => {
    const emptyObs: BigscreenRun = {
      run_key: "r-e", plan_id: "p", plan_name: "n", agent_name: "a",
      status: "completed", started_at: "2026-08-22 03:20", duration_s: 10,
      stage_summaries: [{ type: "observe", status: "empty", overall_mean: null, sessions: 36 }],
    };
    expect(isScored(emptyObs)).toBe(false);
    expect(isNoScore(emptyObs)).toBe(true);
    // OK 数据集：7 次有分运行（0.86/0.95/0.84/0.74/0.82/0.84/0.92）
    const k = deriveKpi(BIGSCREEN_RUNS_OK as BigscreenRun[], BIGSCREEN_PLANS, PINNED);
    expect(k.avgN).toBe(7);
    expect(k.avg).toBeCloseTo((0.86 + 0.95 + 0.84 + 0.74 + 0.82 + 0.84 + 0.92) / 7, 10);
  });

  it("scoreOf：多 observe 环节取均值；stage_summaries 缺失时兜底顶层 score", () => {
    const multi: BigscreenRun = {
      run_key: "r-m", plan_id: "p", plan_name: "n", agent_name: "a",
      status: "completed", started_at: "2026-08-22 03:00", duration_s: 10,
      stage_summaries: [
        { type: "observe", status: "completed", overall_mean: 0.8, sessions: 10 },
        { type: "observe", status: "completed", overall_mean: 0.9, sessions: 10 },
      ],
    };
    expect(scoreOf(multi)).toBeCloseTo(0.85, 10);
    const legacy: BigscreenRun = {
      run_key: "r-l", plan_id: "p", plan_name: "n", agent_name: "a",
      status: "completed", score: 0.77, started_at: "2026-08-22 03:00",
      duration_s: 10, stage_summaries: [],
    };
    expect(scoreOf(legacy)).toBe(0.77);
    expect(isScored(legacy)).toBe(true);
  });

  it("红队攻破从 stage_summaries[].breached 聚合：告警态 3、健康态 0（非 null）、无红队 run → null", () => {
    const alert = deriveKpi(BIGSCREEN_RUNS_ALERT as BigscreenRun[], BIGSCREEN_PLANS, PINNED);
    expect(alert.breach).toBe(3);
    const ok = deriveKpi(BIGSCREEN_RUNS_OK as BigscreenRun[], BIGSCREEN_PLANS, PINNED);
    expect(ok.breach).toBe(0); // 有红队 run，0 攻破 ≠ 无数据
    expect(ok.attacks).toBe(240);
    const none = deriveKpi([BIGSCREEN_RUNS_OK[1]] as BigscreenRun[], BIGSCREEN_PLANS, PINNED);
    expect(none.breach).toBeNull();
    expect(breachOf(BIGSCREEN_RUNS_OK[1] as BigscreenRun)).toBeNull();
  });

  it("近 24h 窗口计数 + 分段（有分数/失败/未计分/跳过/运行中）", () => {
    const k = deriveKpi(BIGSCREEN_RUNS_ALERT as BigscreenRun[], BIGSCREEN_PLANS, PINNED);
    expect(k.runs24).toBe(12);
    expect(k.err24).toBe(1);       // 运维助手 error
    expect(k.noscore24).toBe(1);   // 文档助手 empty observe
    expect(k.skip24).toBe(1);      // 支持助手 预算跳过
    expect(k.running24).toBe(1);   // 客服主链路 running
    // 窗口外的 run 不计
    const old = deriveKpi(BIGSCREEN_RUNS_OK as BigscreenRun[], BIGSCREEN_PLANS,
      PINNED + 3 * 24 * 3600_000);
    expect(old.runs24).toBe(0);
  });
});

describe("Agent 健康矩阵排序：bad→warn→idle→ok，异常恒在前", () => {
  it("告警态：两个 bad 排最前，warn 居中同级低分在前，ok 收尾", () => {
    const agents = deriveAgents(BIGSCREEN_RUNS_ALERT as BigscreenRun[], BIGSCREEN_PLANS);
    expect(agents.map((a) => a.level).slice(0, 2)).toEqual(["bad", "bad"]);
    // 风控（红队攻破 3）与运维（运行失败）在最前；同级内有分低者在前
    expect(agents[0].name).toBe("风控助手");
    expect(agents[0].tag?.t).toBe("红队攻破 3");
    expect(agents[1].name).toBe("运维助手");
    expect(agents[1].tag?.t).toBe("运行失败");
    // warn 段：检索问答 0.68（低于目标）分数最低排 warn 段第一
    const warnSeg = agents.filter((a) => a.level === "warn");
    expect(warnSeg[0].name).toBe("检索问答");
    // ok 收尾
    expect(agents[agents.length - 1].level).toBe("ok");
    // 全序不回头：rank 单调不减
    const rank = { bad: 0, warn: 1, idle: 2, ok: 3 } as const;
    const ranks = agents.map((a) => rank[a.level]);
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
  });

  it("无任何 run 的 agent → idle（无运行）", () => {
    const agents = deriveAgents([], BIGSCREEN_PLANS);
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every((a) => a.level === "idle")).toBe(true);
    expect(agents[0].tag?.t).toBe("无运行");
  });
});

describe("事件聚合（deriveEvents）", () => {
  it("三类必聚合：红队攻破 / error run / skip_reason 含预算；bad 排前且全量返回", () => {
    const ev = deriveEvents(BIGSCREEN_RUNS_ALERT as BigscreenRun[]);
    // 5 项：攻破 + 失败 + 无可评估数据 + 跳过 + 跌破目标（截断交给渲染层，这里不丢）
    expect(ev.length).toBe(5);
    expect(ev.some((e) => e.t === "红队攻破 3 次" && e.lv === "bad")).toBe(true);
    expect(ev.some((e) => e.t === "运行失败" && e.lv === "bad"
      && e.d.includes("上游 502"))).toBe(true);
    expect(ev.some((e) => e.t === "定时运行被跳过" && e.d.includes("预算超限"))).toBe(true);
    // D-3：与全站同词（旧词「未计分（无有效输出）」把纯回归 run 也罩进去了，
    // 那会把「为什么没有分」的困惑从方案详情搬到挂墙大屏上）。
    // 「无有效输出」这条事实挪进了说明行，标题只留权威那个词。
    expect(ev.some((e) => e.t === "无可评估数据")).toBe(true);
    expect(ev.some((e) => e.t.includes("未计分"))).toBe(false);
    expect(ev.find((e) => e.t === "无可评估数据")!.d).toContain("无有效输出");
    // vocab-guard（D-8）迁词：两个限定词都写全 —— 这个数与本屏 hero KPI 同源
    //（scoreOf = observe 环节均分的均值 →「线上评估均分」），阈值叫「目标线」。
    expect(ev.some((e) => e.t === "线上评估均分跌破目标线 0.70"
      && e.d.includes("0.68"))).toBe(true);
    // 量词钉：上面那条确实在（length 5 已钉），所以这条否定断言不会恒真 ——
    // 旧裸词形态「均分跌破目标 0.70」不许再出现在任何标题里
    expect(ev.filter((e) => /跌破目标线/.test(e.t))).toHaveLength(1);
    expect(ev.some((e) => /^均分跌破目标 0\.70$/.test(e.t))).toBe(false);
    // bad 全部在 warn 之前
    const lastBad = ev.map((e) => e.lv).lastIndexOf("bad");
    const firstWarn = ev.map((e) => e.lv).indexOf("warn");
    expect(lastBad).toBeLessThan(firstWarn);
  });

  it("健康态无事件", () => {
    expect(deriveEvents(BIGSCREEN_RUNS_OK as BigscreenRun[])).toEqual([]);
  });
});

// bigscreen-threshold-display-contradiction：跌破事件的判定量是 round4 后的分，
// 说明行此前是 toFixed(2) ⇒ s ∈ [0.695, 0.69995) 会渲染
// 「跌破目标线 0.70：本次 0.70」的自相矛盾文案 —— scoreof-converge 的 round4
// 只掐掉了 [0.69995, 0.70) 的毛刺半格，收窄未根除。修法 = 说明行改四位小数
// （与判定量纲一致）；标题含「线上评估均分」限定词，一字不动。
describe("跌破目标线事件：说明行与判定量纲一致（四位小数）", () => {
  const lowRun = (key: string, mean: number) => ({
    run_key: key, plan_id: "plan_x", plan_name: "客服主链路", agent_name: "支持助手",
    status: "completed", score: null, started_at: "2026-08-22 03:00 UTC",
    duration_s: 60, skip_reason: null,
    stage_summaries: [
      { type: "observe", status: "completed", overall_mean: mean, sessions: 10 },
    ],
  } as BigscreenRun);

  it("矛盾带 s=0.6980：事件真生成，且不再渲染「0.70：本次 0.70」形态", () => {
    const ev = deriveEvents([lowRun("r_band", 0.698)]);
    const hit = ev.find((e) => e.t.includes("跌破目标线"));
    // 事件确实生成（round4 后 0.698 < 0.70）—— 没这条，下面的否定断言会恒真
    expect(hit).toBeDefined();
    // 标题两个限定词一字不丢（vocab-guard / CONTEXT.md 口径）
    expect(hit!.t).toBe("线上评估均分跌破目标线 0.70");
    // 根除自相矛盾：说明行印判定量本身，不是二位四舍五入出来的 0.70
    expect(hit!.d).toContain("本次 0.6980");
    expect(hit!.d).not.toContain("本次 0.70");
  });

  it("正常跌破样本 s=0.62：事件文案仍对（同一量纲 0.6200）", () => {
    const ev = deriveEvents([lowRun("r_low", 0.62)]);
    const hit = ev.find((e) => e.t === "线上评估均分跌破目标线 0.70")!;
    expect(hit).toBeDefined();
    expect(hit.d).toContain("本次 0.6200");
  });
});

// UI-025：环节炸掉但顶层 status=completed 的 run，此前在大屏完全隐形
// （不进 err24、混进「未计分」）。夹具照线上实拍：红队环节 DDB 写超限。
describe("部分失败 run 在大屏显形（UI-025）", () => {
  const PARTIAL_RUN = {
    run_key: "r_partial01", plan_id: "plan_60df13", plan_name: "敏感信息泄露",
    agent_name: "交易助手", status: "completed", score: 0.81,
    started_at: "2026-08-22 03:30 UTC", duration_s: 96, total_cost_usd: 0.22,
    skip_reason: null,
    stage_summaries: [
      { type: "observe", status: "completed", overall_mean: 0.81, sessions: 8 },
      { type: "redteam", status: "error", breached: 0, attacks: 0, verdict: null,
        error: "ValidationException: Item size has exceeded the maximum allowed size" },
    ],
  } as BigscreenRun;

  it("deriveKpi：进 partial24 分段，不进 ok24 / err24 / noscore24", () => {
    const k = deriveKpi([PARTIAL_RUN], BIGSCREEN_PLANS, PINNED);
    expect(k.partial24).toBe(1);
    expect(k.ok24).toBe(0);
    expect(k.err24).toBe(0);
    expect(k.noscore24).toBe(0);
    // 分段互斥覆盖 runs24 全体（分段条按合计归一）
    expect(k.ok24 + k.partial24 + k.err24 + k.noscore24 + k.skip24 + k.running24)
      .toBe(k.runs24);
  });

  it("deriveEvents：自成 bad 级事件，带失败环节名与 stage.error 原文", () => {
    const ev = deriveEvents([PARTIAL_RUN]);
    const hit = ev.find((e) => e.t.startsWith("部分失败"));
    expect(hit).toBeDefined();
    expect(hit!.lv).toBe("bad");
    expect(hit!.t).toBe("部分失败 · 红队测试");
    expect(hit!.d).toContain("Item size has exceeded the maximum allowed size");
  });

  it("deriveAgents：warn 级「部分失败 <环节>」标签（重于未计分，轻于运行失败）", () => {
    const agents = deriveAgents([PARTIAL_RUN], BIGSCREEN_PLANS);
    const a = agents.find((x) => x.name === "交易助手")!;
    expect(a.level).toBe("warn");
    expect(a.tag?.t).toBe("部分失败 红队测试");
  });

  it("全环节炸掉的 completed run：算失败（err24 + 运行失败事件），不是部分失败", () => {
    const allFail = {
      ...PARTIAL_RUN, run_key: "r_allfail01", score: null,
      stage_summaries: [
        { type: "redteam", status: "error", breached: 0, attacks: 0, verdict: null,
          error: "上游 502 · 已重试 2 次" },
      ],
    } as BigscreenRun;
    const k = deriveKpi([allFail], BIGSCREEN_PLANS, PINNED);
    expect(k.err24).toBe(1);
    expect(k.partial24).toBe(0);
    const ev = deriveEvents([allFail]);
    expect(ev.some((e) => e.t === "运行失败" && e.d.includes("上游 502"))).toBe(true);
  });
});

describe("数据陈旧保护（deriveStale）", () => {
  it("分支一：拉取失败 → 立即陈旧", () => {
    const s = deriveStale(PINNED, null, true);
    expect(s.stale).toBe(true);
    expect(s.minutes).toBeGreaterThanOrEqual(1);
  });
  it("分支二：超 2 个轮询周期无更新 → 陈旧并给出分钟数", () => {
    expect(STALE_AFTER_MS).toBe(REFRESH_MS * 2);
    const s = deriveStale(PINNED, PINNED - 3 * 60_000, false);
    expect(s.stale).toBe(true);
    expect(s.minutes).toBe(3);
  });
  it("新鲜数据（1 个周期内）不陈旧；冷启动加载中（无更新且无错误）不误报", () => {
    expect(deriveStale(PINNED, PINNED - REFRESH_MS, false).stale).toBe(false);
    expect(deriveStale(PINNED, null, false).stale).toBe(false);
  });
});

describe("30s 轮询配置", () => {
  it("REFRESH_MS = 30s，两个查询都挂 refetchInterval（后台照刷）", () => {
    expect(REFRESH_MS).toBe(30_000);
    const src = readFileSync(
      resolve(process.cwd(), "src/pages/bigscreen/BigscreenPage.tsx"), "utf8");
    const occurrences = src.match(/refetchInterval: REFRESH_MS/g) ?? [];
    expect(occurrences.length).toBe(2); // list_plans + list_recent_runs
    expect(src.match(/refetchIntervalInBackground: true/g)?.length).toBe(2);
  });
});

describe("路由", () => {
  it("#/bigscreen 解析为 bigscreen 视图", () => {
    expect(parseHash("#/bigscreen")).toEqual({ view: "bigscreen" });
  });
});

// ============================================================
// 组件渲染
// ============================================================

describe("大屏组件：健康灯与告警气氛", () => {
  it("健康态：运行正常 + 无 bs-alert + 呼吸点在场；常量说明句全删", async () => {
    stubFetch();
    renderPage(<BigscreenPage />);
    await waitFor(() => expect(screen.getByTestId("bs-lamp")).toHaveTextContent("运行正常"));
    expect(screen.getByTestId("bigscreen-root")).not.toHaveClass("bs-alert");
    // 呼吸点仍在；「30s 自动刷新」「数据随 run 完成更新」「Agent 评估监控 · 线上评估 /
    // 回归测试 / 红队测试」对任何时刻恒成立 ⇒ 删（prose-sweep 2026-09-03；此前钉的是
    // bs-refresh 上有「30s 自动刷新」）
    expect(screen.getByTestId("bs-refresh")).toBeInTheDocument();
    expectProseGone(screen.getByTestId("bigscreen-root"), "自动刷新", "数据随 run", "评估监控 ·");
    expect(screen.getByTestId("bs-events")).toHaveTextContent("无待处理事项");
  });

  it("告警态：需要处理 + bs-alert 整屏气氛 + 红队攻破 KPI 红卡", async () => {
    pinClock("alert");
    stubFetch({
      list_recent_runs: () =>
        sseResponse([{ event: "recent_runs", runs: BIGSCREEN_RUNS_ALERT }]),
    });
    renderPage(<BigscreenPage />);
    await waitFor(() => expect(screen.getByTestId("bs-lamp")).toHaveTextContent("需要处理"));
    expect(screen.getByTestId("bigscreen-root")).toHaveClass("bs-alert");
    const breach = screen.getByTestId("bs-kpi-breach");
    expect(breach).toHaveClass("breach");
    expect(breach).toHaveTextContent("3");
    expect(breach).toHaveTextContent("需立即处理");
  });
});

// KPI 带第五格「评估监控 Agent」（2026-08-29 用户：大屏第一眼要看到「多少个
// agent 在评估监控」）。主数字 = deriveAgents 全集数 —— 组装层把**同一个数组**
// 传给 KpiBand 与 AgentMatrix，两处数字必须同源；副行「需关注」与矩阵头
// 同词同函数（derive.needsAttentionCount，判据单一住所）。
describe("KPI 带：评估监控 Agent 格（与矩阵同源）", () => {
  /** 现算夹具全集：plans ∪ runs 的 agent_name 去重（deriveAgents 同口径） */
  const agentSetOf = (runs: { agent_name: string }[]) =>
    new Set(
      [...BIGSCREEN_PLANS.map((p) => p.agent_name), ...runs.map((r) => r.agent_name)]
        .filter(Boolean),
    ).size;

  it("needsAttentionCount：bad/warn 计入、idle/ok 不计（矩阵头与 KPI 同一份判据）", () => {
    const alertAgents = deriveAgents(BIGSCREEN_RUNS_ALERT as BigscreenRun[], BIGSCREEN_PLANS);
    // 独立复算（不拿被测函数自证）：告警夹具 bad=2（风控攻破/运维失败）
    // + warn=3（文档 nodata / 支持 跳过 / 检索 <0.70）
    const expected = alertAgents
      .filter((a) => a.level === "bad" || a.level === "warn").length;
    expect(expected).toBe(5); // 夹具锚：不是恒真断言
    expect(needsAttentionCount(alertAgents)).toBe(expected);
    // idle（无运行）不算需关注
    const idleAgents = deriveAgents([], BIGSCREEN_PLANS);
    expect(idleAgents.length).toBeGreaterThan(0);
    expect(idleAgents.every((a) => a.level === "idle")).toBe(true);
    expect(needsAttentionCount(idleAgents)).toBe(0);
  });

  it("ok 场景：主数字 = 夹具全集数且与矩阵头 N 同值（两个 DOM 位取出来比）；副行「全部健康 + 1 个运行中」", async () => {
    stubFetch();
    renderPage(<BigscreenPage />);
    // 锚点挑 runs 派生物：「运行中」只能来自 list_recent_runs（客服主链路 running）。
    // testid / 「全部健康」在 agents=[] 的加载态就已存在，等它们 = 门槛数据。
    await waitFor(() =>
      expect(screen.getByTestId("bs-kpi-agents")).toHaveTextContent("1 个运行中"));
    const cell = screen.getByTestId("bs-kpi-agents");
    const n = cell.querySelector(".bs-kpi-n")!.textContent!;
    expect(Number(n)).toBe(agentSetOf(BIGSCREEN_RUNS_OK));
    // 同源钉：矩阵头「N 个 Agent」的 N 从 DOM 取出来比，不是各自跟夹具比
    const matrixN = screen.getByTestId("bs-matrix")
      .querySelector(".bs-note .num")!.textContent!;
    expect(n).toBe(matrixN);
    // 健康态副行：中性「全部健康」，无「需关注」
    expect(cell).toHaveTextContent("全部健康");
    expect(cell).not.toHaveTextContent("需关注");
  });

  it("alert 场景：副行「M 个需关注」与矩阵头同词同数（两个 DOM 位取出来比）", async () => {
    pinClock("alert");
    stubFetch({
      list_recent_runs: () =>
        sseResponse([{ event: "recent_runs", runs: BIGSCREEN_RUNS_ALERT }]),
    });
    renderPage(<BigscreenPage />);
    const m = needsAttentionCount(
      deriveAgents(BIGSCREEN_RUNS_ALERT as BigscreenRun[], BIGSCREEN_PLANS));
    // 锚点 = 目标数据本身（「M 个需关注」只在 runs 到位后出现；加载态是「全部健康」）
    await waitFor(() =>
      expect(screen.getByTestId("bs-kpi-agents")).toHaveTextContent(`${m} 个需关注`));
    const cell = screen.getByTestId("bs-kpi-agents");
    expect(Number(cell.querySelector(".bs-kpi-n")!.textContent))
      .toBe(agentSetOf(BIGSCREEN_RUNS_ALERT));
    expect(cell).not.toHaveTextContent("全部健康");
    // 同源钉（需关注档）：KPI 副行的 M 与矩阵头的 M 都从 DOM 正则取出来比
    const kpiM = /(\d+) 个需关注/.exec(cell.textContent ?? "")?.[1];
    const matrixM = /(\d+) 个需关注（已排前）/.exec(
      screen.getByTestId("bs-matrix").textContent ?? "")?.[1];
    expect(kpiM).toBeDefined();
    expect(kpiM).toBe(matrixM);
    // 主数字同源钉在告警态同样成立
    expect(cell.querySelector(".bs-kpi-n")!.textContent).toBe(
      screen.getByTestId("bs-matrix").querySelector(".bs-note .num")!.textContent);
  });
});

describe("大屏组件：矩阵翻页仅 >6 触发", () => {
  function agentsFixture(n: number) {
    const plans = Array.from({ length: n }, (_, i) => ({
      plan_id: `p${i}`, name: `方案${i}`, agent_name: `agent-${i}`,
      stages: [{ type: "observe" }],
    }));
    const runs = Array.from({ length: n }, (_, i) => ({
      run_key: `r${i}`, plan_id: `p${i}`, plan_name: `方案${i}`, agent_name: `agent-${i}`,
      status: "completed", score: null, started_at: "2026-08-22 03:00", duration_s: 60,
      stage_summaries: [
        { type: "observe", status: "completed", overall_mean: 0.8 + i / 100, sessions: 10 },
      ],
    }));
    return { plans, runs };
  }

  it("6 个 Agent（= PAGE_SIZE）：单页，无页码点", async () => {
    const { plans, runs } = agentsFixture(PAGE_SIZE);
    stubFetch({
      list_plans: () => sseResponse([{ event: "plans", plans }]),
      list_recent_runs: () => sseResponse([{ event: "recent_runs", runs }]),
    });
    renderPage(<BigscreenPage />);
    await waitFor(() =>
      expect(screen.getByTestId("bs-matrix")).toHaveTextContent(`${PAGE_SIZE} 个 Agent`));
    expect(screen.queryByTestId("bs-pager")).toBeNull();
  });

  it("7 个 Agent（> PAGE_SIZE）：页码点，首屏只有 6 卡；「15s 轮换」标注已删", async () => {
    const { plans, runs } = agentsFixture(PAGE_SIZE + 1);
    stubFetch({
      list_plans: () => sseResponse([{ event: "plans", plans }]),
      list_recent_runs: () => sseResponse([{ event: "recent_runs", runs }]),
    });
    renderPage(<BigscreenPage />);
    await waitFor(() => expect(screen.getByTestId("bs-pager")).toBeInTheDocument());
    expect(screen.getByTestId("bs-matrix")).toHaveTextContent("第 1 / 2 页");
    // 「· 15s 轮换」是常量说明 ⇒ 删（prose-sweep 2026-09-03；此前钉的是它**在**）
    expectProseGone(screen.getByTestId("bs-matrix"), "15s 轮换");
    expect(document.querySelectorAll(".bs-acard").length).toBe(PAGE_SIZE);
  });
});

describe("大屏组件：mini 趋势诚实规则", () => {
  it("有 observe 分 → 画趋势线；仅 dataset 通过率 → 「无线上评估分」不画线", async () => {
    const plans = [
      { plan_id: "p1", name: "观测", agent_name: "obs-agent", stages: [{ type: "observe" }] },
      { plan_id: "p2", name: "回归", agent_name: "ds-agent", stages: [{ type: "dataset" }] },
    ];
    const runs = [
      {
        run_key: "r1", plan_id: "p1", plan_name: "观测", agent_name: "obs-agent",
        status: "completed", score: null, started_at: "2026-08-22 03:00", duration_s: 60,
        stage_summaries: [{ type: "observe", status: "completed", overall_mean: 0.9, sessions: 10 }],
      },
      {
        run_key: "r2", plan_id: "p1", plan_name: "观测", agent_name: "obs-agent",
        status: "completed", score: null, started_at: "2026-08-22 02:00", duration_s: 60,
        stage_summaries: [{ type: "observe", status: "completed", overall_mean: 0.85, sessions: 10 }],
      },
      {
        run_key: "r3", plan_id: "p2", plan_name: "回归", agent_name: "ds-agent",
        status: "completed", score: null, started_at: "2026-08-22 03:30", duration_s: 60,
        stage_summaries: [{ type: "dataset", status: "completed", pass_rate: 0.95, cases: 100, blank_cases: 0 }],
      },
    ];
    stubFetch({
      list_plans: () => sseResponse([{ event: "plans", plans }]),
      list_recent_runs: () => sseResponse([{ event: "recent_runs", runs }]),
    });
    renderPage(<BigscreenPage />);
    // 卡片由 list_plans 渲染、趋势线由 list_recent_runs 渲染，是两个独立 query。
    // 只等卡片会在 runs 还没回来时就断言趋势线（曾偶发红），故等到 runs 派生物出现为止。
    await waitFor(() =>
      expect(screen.getByTestId("bs-spark-obs-agent").querySelector("polyline")).not.toBeNull());
    // 有 observe 分：spark svg 存在
    const spark = screen.getByTestId("bs-spark-obs-agent");
    expect(spark.querySelector("polyline")).not.toBeNull();
    // 仅 dataset：主数字退到通过率，明示「无线上评估分」，绝无趋势线
    const dsCard = await waitFor(() => {
      const c = screen.getByTestId("bs-acard-ds-agent");
      expect(c).toHaveTextContent("95.0%");
      return c;
    });
    expect(dsCard).toHaveTextContent("95.0%");
    expect(dsCard).toHaveTextContent("无线上评估分");
    expect(dsCard.querySelector("polyline")).toBeNull();
  });
});

describe("大屏组件：事件侧栏实测自适配溢出摘尾", () => {
  const shDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const chDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  afterEach(() => {
    if (shDesc) Object.defineProperty(HTMLElement.prototype, "scrollHeight", shDesc);
    else delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
    if (chDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", chDesc);
    else delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
  });

  it("溢出时逐条摘尾并计入「还有 N 项」，收敛到不溢出为止", async () => {
    // jsdom 无布局：模拟每条事件 120px、容器 300px → 3 条溢出，收敛到 2 条
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList?.contains("bs-events")) {
          return this.querySelectorAll(".bs-ev").length * 120;
        }
        return 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList?.contains("bs-events") ? 300 : 0;
      },
    });
    pinClock("alert");
    stubFetch({
      list_recent_runs: () =>
        sseResponse([{ event: "recent_runs", runs: BIGSCREEN_RUNS_ALERT }]),
    });
    renderPage(<BigscreenPage />);
    // 告警态 5 项事件：初始 EV_MAX=3 → 实测溢出 → 摘到 2 条 + 还有 3 项
    await waitFor(() =>
      expect(screen.getByTestId("bs-ev-more")).toHaveTextContent("还有 3 项待处理"));
    expect(document.querySelectorAll(".bs-ev").length).toBe(2);
    expect(EV_MAX).toBe(3);
    // 摘尾不丢 bad：显示的前 2 条正是 bad 级
    const shown = [...document.querySelectorAll(".bs-ev")];
    expect(shown.every((el) => el.classList.contains("bad"))).toBe(true);
  });
});

describe("大屏组件：空态与陈旧保护", () => {
  it("空数据：无待处理事项 ✓ + 暂无运行记录 + 矩阵空态", async () => {
    stubFetch({
      list_plans: () => sseResponse([{ event: "plans", plans: [] }]),
      list_recent_runs: () => sseResponse([{ event: "recent_runs", runs: [] }]),
    });
    renderPage(<BigscreenPage />);
    await waitFor(() =>
      expect(screen.getByTestId("bs-events-empty")).toHaveTextContent("无待处理事项"));
    // 空态副句「近 24h 所有运行均正常完成，红队测试全部抵御，无跌破目标线的方案」是对
    // 「无事项」的复述 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("bs-events-empty"), "全部抵御", "无跌破目标线");
    expect(screen.getByTestId("bs-strip-empty")).toHaveTextContent("暂无运行记录");
    expect(screen.getByTestId("bs-matrix-empty")).toHaveTextContent("暂无 Agent 数据");
    expect(screen.getByTestId("bs-kpi-avg")).toHaveTextContent("—");
  });

  it("拉取失败：顶条转灰「数据已停止更新 N 分钟」替代呼吸点", async () => {
    stubFetch({
      list_plans: () => new Response("boom", { status: 500 }),
      list_recent_runs: () => new Response("boom", { status: 500 }),
    });
    renderPage(<BigscreenPage />);
    await waitFor(() =>
      expect(screen.getByTestId("bs-stale")).toHaveTextContent(/数据已停止更新 \d+ 分钟/));
    expect(screen.queryByTestId("bs-refresh")).toBeNull();
    expect(screen.getByTestId("bs-top")).toHaveClass("is-stale");
    expect(document.querySelector(".bs-lamp")).toHaveClass("stale");
  });
});

describe("大屏纪律：零 hover 依赖 + 术语", () => {
  it("bigscreen.css 不含任何 :hover 规则（挂墙无鼠标）", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/pages/bigscreen/bigscreen.css"), "utf8");
    expect(css).not.toContain(":hover");
  });

  it("术语口径：线上评估/回归测试/红队测试/评估计划 原词呈现，无变体", async () => {
    pinClock("alert");
    stubFetch({
      list_recent_runs: () =>
        sseResponse([{ event: "recent_runs", runs: BIGSCREEN_RUNS_ALERT }]),
    });
    const { container } = renderPage(<BigscreenPage />);
    await waitFor(() => expect(screen.getByTestId("bs-lamp")).toHaveTextContent("需要处理"));
    const text = container.textContent ?? "";
    // 顶条副题「Agent 评估监控 · 线上评估 / 回归测试 / 红队测试」已删（对任何时刻恒成立的
    // 产品说明，prose-sweep 2026-09-03；此前钉的是它**在**）；术语原词由 KPI 标签承担
    expectProseGone(screen.getByTestId("bigscreen-root"), "评估监控 ·");
    // KPI 标签用原词
    expect(text).toContain("线上评估均分");
    expect(text).toContain("回归通过率");
    expect(text).toContain("红队攻破");
    // 溢出提示指回评估计划（2026-08-29 用户改版原词）
    expect(text).toContain("评估计划");
    // D-3：nodata 那一档在**整屏**上与方案详情/导出同词（分段图例 + run 格子 +
    // 事件侧栏三处）。量词钉：告警数据集里确有一个 nodata run（文档助手 empty
    // observe），所以下面那条否定断言不是恒真。
    expect(text).toContain("无可评估数据");
    expect(text).not.toContain("未计分");
    // 禁变体
    expect(text).not.toContain("在线评估");
    expect(text).not.toContain("回归验证");
  });
});

describe("无壳布局：Shell 对 bigscreen 分流", () => {
  it("#/bigscreen 不渲染顶栏/skip-link，直接出 1920×1080 舞台", async () => {
    stubFetch();
    renderPage(<Shell />);
    await waitFor(() => expect(screen.getByTestId("bigscreen-stage")).toBeInTheDocument());
    expect(screen.queryByTestId("topnav")).toBeNull();
    expect(screen.queryByTestId("skip-link")).toBeNull();
    expect(screen.queryByTestId("main")).toBeNull();
  });
});
