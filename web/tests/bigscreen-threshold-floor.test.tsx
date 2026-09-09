// threshold-adjacent-precision（口径改裁 · 方案 c）：
// 大屏三处「数值与阈值结论并排」的位置，此前用 fmtScore（toFixed(2) 四舍五入）
// 显示、按四位判定 ⇒ s ∈ [0.695, 0.70) 显示「0.70」而同屏结论说低于 0.70。
// 修法 = 并置处显示端向下取整（fmtScoreFloor）：低于 0.70 的值在数学上
// **永远显示不出 0.70**，矛盾不可能形态直接消失。
//   · fmtScore 本体与全站其余消费点零改动；
//   · 事件说明行的 toFixed(4)（threshold-fix 已合流）保留不回改 ——
//     精确显示与 floor 两种手段并存各有其位；
//   · ⚠️ 方案 c 的前提 = **阈值本身能用显示精度表达**（0.70 恰是两位，所以
//     两位 floor 永不虚报达标）。将来若出现 0.705 类三位阈值，两位显示
//     表达不了与它的比较关系，此处必须随判定精度加位 —— 这行注释就是刹车。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTest } from "../src/lib/config";
import { fmtScore, fmtScoreFloor } from "../src/lib/scoring";
import { sseFrames } from "../src/mocks/handlers";
import BigscreenPage from "../src/pages/bigscreen/BigscreenPage";
import type { BigscreenRun } from "../src/pages/bigscreen/types";
import { useSession } from "../src/stores/session";

// ============================================================
// 纯函数：fmtScoreFloor（scoring.ts 只加导出，fmtScore 一字不动）
// ============================================================

describe("fmtScoreFloor：两位向下取整（并置处专用）", () => {
  it("矛盾带 s=0.6980 / 0.6900 边内值 → 0.69（fmtScore 会印 0.70）", () => {
    expect(fmtScoreFloor(0.698)).toBe("0.69");
    // 对照：这正是 fmtScore 印出矛盾的那一格（保证本测试测的是差异本身）
    expect(fmtScore(0.698)).toBe("0.70");
  });

  it("浮点整值边界：0.70 的整值不许被 floor 出 0.69", () => {
    // 二进制边界实测（node 现算）：0.29 * 100 === 28.999999999999996 ——
    // 裸 Math.floor(x*100)/100 会把 0.29 印成 0.28。0.70 恰好 *100 === 70，
    // 但实现不许赌乘法巧合，两个方向都钉死。
    expect(fmtScoreFloor(0.7)).toBe("0.70");
    expect(fmtScoreFloor(0.29)).toBe("0.29");
    expect(fmtScoreFloor(1)).toBe("1.00");
    expect(fmtScoreFloor(0)).toBe("0.00");
  });

  it("夹具刹车：0.825 → 0.82（floor 与 round 在此原理分家，现状一致纯因二进制）", () => {
    // double(0.825) === 0.82499999999999995…（略**小于**十进制 0.825）：
    //   · fmtScore 的 toFixed(2) 按精确 double 就近舍入 → "0.82"（不是学校
    //     口径的 0.83）；
    //   · fmtScoreFloor 也 → "0.82"。
    // 两法此格相同是二进制巧合不是原理。大屏两套 mock 夹具的分数目前逐处
    // floor === round（visual 基线因此 0 px 位移）；将来动夹具分数时先看这条
    // —— 换成 double 略大于 x.xx5 的值，两法就会分家，基线会位移。
    expect(fmtScoreFloor(0.825)).toBe("0.82");
    expect(fmtScore(0.825)).toBe("0.82");
  });

  it("副作用方向（裁定接受，防回修）：0.6999 → 0.69", () => {
    // 这是口径改裁**刻意选择**的诚实方向副作用：floor 恒不高估，0.6999 显示
    // 0.69 与「低于 0.70」的判定一致。将来谁想把它「修」回四舍五入（0.70），
    // 请先读 .scratch/triage-r1/issues/threshold-adjacent-precision.md 的
    // 「口径改裁（方案 c）」节 —— 那会把矛盾带原样造回来。
    expect(fmtScoreFloor(0.6999)).toBe("0.69");
  });

  it("反向钉：0.7049 → 0.70（floor 不是 round，也不是截到更低）", () => {
    // 0.7049 判定达标（≥ 0.70），显示 0.70 与结论一致；floor 只砍第三位以后，
    // 不会把达标值砍穿阈值。前提见文件头注释：阈值 0.70 本身两位可表达。
    expect(fmtScoreFloor(0.7049)).toBe("0.70");
  });

  it("负数走向 -∞（恒不高估）；无分 → —", () => {
    expect(fmtScoreFloor(-0.005)).toBe("-0.01");
    expect(fmtScoreFloor(null)).toBe("—");
    expect(fmtScoreFloor(undefined)).toBe("—");
  });
});

// ============================================================
// 组件：三处并置点逐处验收（hero KPI / 矩阵卡 / 最近运行格）
// ============================================================

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action?: string } & Record<string, unknown>;

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// 夹具照后端真形态（planrun.py：started_at 带 " UTC" 后缀、score 顶层可 null）
const PLANS = [
  { plan_id: "plan_x", name: "客服主链路", agent_name: "支持助手",
    stages: [{ type: "observe" }] },
];

function obsRun(key: string, mean: number): BigscreenRun {
  return {
    run_key: key, plan_id: "plan_x", plan_name: "客服主链路", agent_name: "支持助手",
    status: "completed", score: null, started_at: "2026-08-22 03:00 UTC",
    duration_s: 60, skip_reason: null,
    stage_summaries: [
      { type: "observe", status: "completed", overall_mean: mean, sessions: 10 },
    ],
  } as BigscreenRun;
}

function stubFetch(runs: BigscreenRun[]) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    switch (payload.action) {
      case "list_plans":
        return sseResponse([{ event: "plans", plans: PLANS }]);
      case "list_recent_runs":
        return sseResponse([{ event: "recent_runs", runs }]);
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

beforeEach(() => {
  resetConfigForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  // ?mock=bigscreen-* 钉死页面时钟到 2026-08-22 04:12 UTC（夹具在 24h 窗内）
  window.history.replaceState(null, "", "/?mock=bigscreen-ok#/bigscreen");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("并置点显示 floor：s=0.6980 逐处 0.69（矛盾不可能形态）", () => {
  it("hero KPI / 矩阵卡 / 最近运行格 三处都不再印 0.70", async () => {
    stubFetch([obsRun("r_band", 0.698)]);
    renderPage(<BigscreenPage />);

    // 锚点挑目标数据专属：等 r_band 自己的运行格出分（三处同吃 runs query，
    // 该格出数即同一 commit 内三处都已用真数据渲染）
    const cell = await waitFor(() => {
      const c = screen.getByTestId("bs-rcell-r_band");
      expect(c.querySelector(".bs-r-score")!.textContent).toBe("0.69");
      return c;
    });
    // ① 最近运行格：同一行里 <0.70 判定给了 bad/warn，显示必须同向
    expect(cell.dataset.state).toBe("warn");

    // ② hero KPI：主数字与脚注「目标线 ≥ 0.70」同格并置。
    //    ⚠️ 只盯 .bs-kpi-n —— 脚注本身合法含「0.70」字样。
    const hero = screen.getByTestId("bs-kpi-avg");
    expect(hero.querySelector(".bs-kpi-n")!.textContent).toBe("0.69");
    expect(hero).toHaveTextContent("目标线");
    expect(hero).toHaveTextContent("≥ 0.70");

    // ③ 矩阵卡：主数字与「低于目标」标签同卡并置
    const card = screen.getByTestId("bs-acard-支持助手");
    expect(card.querySelector(".bs-a-score")!.textContent).toBe("0.69");
    expect(card).toHaveTextContent("低于目标");
  });
});

describe("并置点显示 floor：s=0.7001 → 0.70，与「≥ 0.70」结论一致", () => {
  it("三处都显示 0.70，矩阵卡「达标」、运行格不落警示档", async () => {
    stubFetch([obsRun("r_pass", 0.7001)]);
    renderPage(<BigscreenPage />);

    const cell = await waitFor(() => {
      const c = screen.getByTestId("bs-rcell-r_pass");
      expect(c.querySelector(".bs-r-score")!.textContent).toBe("0.70");
      return c;
    });
    expect(cell.dataset.state).toBe("ok");

    const hero = screen.getByTestId("bs-kpi-avg");
    expect(hero.querySelector(".bs-kpi-n")!.textContent).toBe("0.70");

    const card = screen.getByTestId("bs-acard-支持助手");
    expect(card.querySelector(".bs-a-score")!.textContent).toBe("0.70");
    expect(card).toHaveTextContent("达标");
    expect(card).not.toHaveTextContent("低于目标");
  });
});
