// 首页 = Agent 总览（观测视角，ADR-0016 舰队级 · B3 契约）的内容钉子。
// 夹具 = mocks/handlers 的 fleet_status 桩按 5 台 Agent 现算（与 ?mock=fleet 同一份），
// 期望值逐条手算写在断言旁；锚点一律挑目标卡专属 testid。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AGENTS, AGENT_RUNS, FLEET_AGENTS, FLEET_RUNS, applyAgentMeta, fleetStatus,
} from "../../src/mocks/handlers";
import AgentsPage from "../../src/pages/AgentsPage";
import {
  evaluatorGate, fmtDeltaPct, fmtDeltaPp, fmtInt, fmtPct, fmtSec, isUnobserved, proposalCounts,
  reasonOf, sortRows,
} from "../../src/pages/agents/home/derive";
import { reasonOf as hubReasonOf } from "../../src/pages/agents/detail/hub/derive";
import { renderPage, setupAgentsPageHooks, sseResponse, stubFetch, type Payload } from "./harness";

setupAgentsPageHooks();

const FIVE = [...AGENTS, ...FLEET_AGENTS];
const NAMES = FIVE.map((a) => a.agent_name);

/** 五台 Agent 的首页：discover / fleet_status / list_recent_runs 三路同源 */
function stubFleet(extra: Record<string, (p: Payload) => Response> = {}) {
  return stubFetch({
    discover: () => sseResponse([{
      event: "agents", region: "us-west-2", from_cache: false, refreshed_at: 1786780500,
      agents: applyAgentMeta(FIVE),
    }]),
    fleet_status: () => sseResponse([fleetStatus(Date.now(), NAMES)]),
    list_recent_runs: () => sseResponse([{ event: "recent_runs", runs: [...AGENT_RUNS, ...FLEET_RUNS] }]),
    // support-bot 最近一次 run 所属 plan-ddd444：两次 completed，处方 1 已采纳且验证 improved、1 未采纳
    list_plan_runs: (p) => sseResponse([{
      event: "plan_runs", plan_id: p.plan_id,
      runs: p.plan_id === "plan-ddd444" ? [
        { run_key: "plan-ddd444#2026-08-21T05:00:00Z", status: "completed",
          proposals: [
            { summary: "a", generated_at: "x", adopted_at: "2026-08-22 01:00 UTC",
              adoption_effect: { verdict: "improved" } },
            { summary: "b", generated_at: "x", adopted_at: null },
          ] },
        { run_key: "plan-ddd444#2026-08-14T05:00:00Z", status: "completed", proposals: [] },
      ] : [],
    }]),
    ...extra,
  });
}

// ---------- 纯派生 ----------
describe("home/derive 口径", () => {
  it("evaluatorGate：observe 取 summary.mean_score、dataset 取 evaluator_stats.mean，≥0.70 过线；红队不进分母", () => {
    expect(evaluatorGate({
      run_key: "k", plan_id: "p", plan_name: "P", agent_name: "a", status: "completed",
      stage_summaries: [
        { type: "observe", status: "completed", overall_mean: 0.8,
          summary: { helpfulness: { mean_score: 0.88 }, coherence: { mean_score: 0.69 } } } as never,
        { type: "dataset", status: "completed", pass_rate: 0.9,
          evaluators: ["correctness", "refusal"],
          evaluator_stats: { correctness: { mean: 0.94 }, refusal: { mean: 0.55 } } } as never,
        { type: "redteam", status: "completed", breached: 0, attacks: 6 } as never,
      ],
    })).toEqual({ passed: 2, total: 4 });
    // 失败环节不计；一个可数的都没有 → null（画「—」）
    expect(evaluatorGate({
      run_key: "k", plan_id: "p", plan_name: "P", agent_name: "a", status: "completed",
      stage_summaries: [{ type: "dataset", status: "error", error: "x" } as never],
    })).toBeNull();
    expect(evaluatorGate(undefined)).toBeNull();
  });

  it("排版：null 一律「—」；差值上升 ▲、下降 ▼、0 「—」", () => {
    expect(fmtInt(18420)).toBe("18,420");
    expect(fmtInt(null)).toBe("—");
    expect(fmtPct(0.018)).toBe("1.8%");
    expect(fmtSec(3400)).toBe("3.4s");
    expect(fmtDeltaPp(0.004)).toBe("▲ 0.4pp");
    expect(fmtDeltaPp(-0.009)).toBe("▼ 0.9pp");
    expect(fmtDeltaPp(0)).toBe("—");
    expect(fmtDeltaPct({ value: 4812, prev: 4530, delta: 282 })).toBe("▲ 6.2%");
    expect(fmtDeltaPct({ value: 10, prev: null, delta: null })).toBe("—");
  });

  it("proposalCounts：未采纳 = adopted_at 空；已验证 = adoption_effect.verdict improved", () => {
    expect(proposalCounts([
      { proposals: [{ adopted_at: null }, { adopted_at: "t" }, { adopted_at: "t", adoption_effect: { verdict: "improved" } }] },
      { proposals: [] },
      {},
    ])).toEqual({ pending: 1, verified: 1 });
  });

  it("sortRows：最需要动手 = bad > warn > ok > none，再按告警数、会话量；null 数值沉底", () => {
    const rows = [
      { name: "d", severity: "none" as const, alerts: 0, sessions: 900, cost: 1 },
      { name: "b", severity: "warn" as const, alerts: 1, sessions: 100, cost: 5 },
      { name: "a", severity: "bad" as const, alerts: 0, sessions: null, cost: null },
      { name: "c", severity: "ok" as const, alerts: 0, sessions: 50, cost: 9 },
    ];
    expect(sortRows(rows, "priority").map((r) => r.name)).toEqual(["a", "b", "c", "d"]);
    expect(sortRows(rows, "volume").map((r) => r.name)).toEqual(["d", "b", "c", "a"]);
    expect(sortRows(rows, "cost").map((r) => r.name)).toEqual(["c", "b", "d", "a"]);
    expect(sortRows(rows, "name").map((r) => r.name)).toEqual(["a", "b", "c", "d"]);
  });
});

// ---------- unavailable_reason 的读法（首页卡 / hero / ① 现状同一份） ----------
describe("unavailable_reason 的唯一读法", () => {
  it("reasonOf：先取这一项自己的原因，缺则退到整体 agent_status；两者都无 → undefined", () => {
    const own = { unavailable_reason: { "metrics.sessions": "没有 span 组", agent_status: "整块炸了" } };
    expect(reasonOf(own, "metrics.sessions")).toBe("没有 span 组");
    expect(reasonOf(own, "metrics.blank_rate")).toBe("整块炸了");
    expect(reasonOf({ unavailable_reason: { "metrics.sessions": "x" } }, "next_run.at")).toBeUndefined();
    expect(reasonOf({ unavailable_reason: {} }, "metrics.sessions")).toBeUndefined();
    expect(reasonOf(undefined, "metrics.sessions")).toBeUndefined();
  });

  it("① 现状与首页调的是同一个函数（hub/derive 只再导出，不再抄一份实现）", () => {
    expect(hubReasonOf).toBe(reasonOf);
  });

  it("isUnobserved：metrics.* 或 agent_status 才算无观测；last_run.* / next_run.* / cloudwatch_url 不算", () => {
    expect(isUnobserved({ "metrics.sessions": "x" })).toBe(true);
    expect(isUnobserved({ agent_status: "x" })).toBe(true);
    expect(isUnobserved({ "last_run.dataset_pass_rate": "x" })).toBe(false);
    expect(isUnobserved({ "next_run.at": "x", cloudwatch_url: "y" })).toBe(false);
    expect(isUnobserved({})).toBe(false);
    expect(isUnobserved(undefined)).toBe(false);
  });
});

// ---------- hero ----------
describe("舰队一眼 hero", () => {
  it("总会话 12,200（4812+6105+393+890，research 无数）▲ 3.8% 较前一日（prev 11,756）；1 台无观测数据", async () => {
    stubFleet();
    renderPage(<AgentsPage />);
    const cell = await screen.findByTestId("fleet-sessions");
    expect(cell).toHaveTextContent("近 24h 会话 · 5 个 Agent");
    expect(cell).toHaveTextContent("12,200");
    expect(screen.getByTestId("fleet-sessions-delta")).toHaveTextContent("▲ 3.8% 较前一日");
    // 24 桶曲线画在 hero 上（fleet.hourly）
    expect(screen.getByTestId("fleet-spark").querySelector("svg path.sp-line")).not.toBeNull();
    expect(screen.getByTestId("fleet-unavailable")).toHaveTextContent("1 个 Agent 无观测数据");
  });

  it("总成本 $95.10（41.6+46+2.4+5.1）；P95 最差 5.2s = billing-bot；异常率 5.1%（会话量加权）", async () => {
    stubFleet();
    renderPage(<AgentsPage />);
    await screen.findByTestId("fleet-hero");
    expect(screen.getByTestId("fleet-cost")).toHaveTextContent("$95.10");
    const p95 = screen.getByTestId("fleet-p95");
    expect(p95).toHaveTextContent("5.2s");
    expect(p95).toHaveTextContent("billing-bot");
    // (4812·0.044 + 6105·0.063 + 393·0.042 + 890·0.012) / 12200 = 623.529/12200 = 0.0511
    expect(screen.getByTestId("fleet-anomaly")).toHaveTextContent("5.1%");
  });

  it("需动手 3：观测两条在前（billing-bot 工具失败率飙升 / run 失败），评估一条在后（support-bot refusal）", async () => {
    stubFleet();
    renderPage(<AgentsPage />);
    await screen.findByTestId("fleet-hero");
    expect(screen.getByTestId("fleet-todo-count")).toHaveTextContent("3");
    const lines = within(screen.getByTestId("fleet-todo")).getAllByRole("button");
    expect(lines.map((l) => l.querySelector(".now-src")?.textContent)).toEqual(["观测", "观测", "评估"]);
    // fact 是后端一句带数字（契约格式），前端原样摆
    expect(lines[0]).toHaveTextContent("billing-bot 工具失败率 5.1%（前一日 2.4%）");
    expect(lines[1]).toHaveTextContent("billing-bot 「账单核对回归」最近一次运行失败（2026-09-03 02:01 UTC）：评估 Runtime 超时（60s 无响应）");
    expect(lines[2]).toHaveTextContent("support-bot 「下单意图回归」refusal 连续 3 次低于 0.7（最近 0.55）");
    // 观测告警 → 该 Agent 详情
    fireEvent.click(lines[0]);
    expect(location.hash).toBe("#/agent/billing-bot");
  });

  it("fleet_status 回 error → hero 位显示原话，卡片逐张显示原话（不吞）", async () => {
    stubFleet({ fleet_status: () => sseResponse([{ event: "error", error: "Logs Insights 限流" }]) });
    renderPage(<AgentsPage />);
    expect(await screen.findByTestId("fleet-error")).toHaveTextContent("Logs Insights 限流");
    expect(screen.getByTestId("agent-card-support-bot-error")).toHaveTextContent("Logs Insights 限流");
  });
});

// ---------- 待处理 ----------
describe("待处理动作卡", () => {
  it("每条 = kicker + Agent 名 + 事实 + 一个动作；本版后端只产 view ⇒ 全部「去看」→ Agent 详情", async () => {
    stubFleet();
    renderPage(<AgentsPage />);
    await screen.findByTestId("todo-grid");
    expect(screen.getByTestId("todo-count")).toHaveTextContent("3");
    const spike = screen.getByTestId("todo-billing-bot-tool_failure_spike");
    expect(spike).toHaveTextContent("观测 · 告警");
    expect(spike).toHaveAttribute("data-severity", "warn");
    const failed = screen.getByTestId("todo-billing-bot-run_failed");
    expect(failed).toHaveTextContent("观测 · run 失败");
    expect(failed).toHaveAttribute("data-severity", "bad");
    const below = screen.getByTestId("todo-support-bot-evaluator_below_target");
    expect(below).toHaveTextContent("评估 · 未过线");
    expect(within(failed).getByTestId("todo-billing-bot-run_failed-action")).toHaveTextContent("去看");
    fireEvent.click(within(failed).getByTestId("todo-billing-bot-run_failed-action"));
    expect(location.hash).toBe("#/agent/billing-bot");
    expect(within(below).getByTestId("todo-support-bot-evaluator_below_target-action")).toHaveTextContent("去看");
    fireEvent.click(within(below).getByTestId("todo-support-bot-evaluator_below_target-action"));
    expect(location.hash).toBe("#/agent/support-bot");
    expect(within(spike).getByTestId("todo-billing-bot-tool_failure_spike-action")).toHaveTextContent("去看");
  });

  it("零待处理时整节缺席（不写「暂无」）", async () => {
    stubFleet({
      fleet_status: () => sseResponse([{ ...fleetStatus(Date.now(), NAMES), todo: [] }]),
    });
    renderPage(<AgentsPage />);
    await screen.findByTestId("fleet-hero");
    expect(screen.queryByTestId("todo-grid")).toBeNull();
    expect(screen.getByTestId("fleet-todo-count")).toHaveTextContent("0");
    expect(document.body.textContent).not.toContain("暂无");
  });
});

// ---------- Agent 卡 ----------
describe("Agent 卡：观测主体", () => {
  it("support-bot：4,812 会话 ▲ 6.2%、24 点曲线、四小数 3.4s / $41.60 / 1.8% / 2.6% 各带 ▲▼；上升染 warn", async () => {
    stubFleet();
    renderPage(<AgentsPage />);
    const card = await screen.findByTestId("agent-card-support-bot");
    await waitFor(() => expect(within(card).getByTestId("agent-card-support-bot-sessions")).toHaveTextContent("4,812"));
    expect(within(card).getByTestId("agent-card-support-bot-sessions-delta")).toHaveTextContent("▲ 6.2%");
    expect(within(card).getByTestId("agent-card-support-bot-spark").querySelector("svg")).not.toBeNull();
    const p95 = within(card).getByTestId("agent-card-support-bot-p95");
    expect(p95).toHaveTextContent("3.4s");
    expect(p95).toHaveTextContent("▼ 0.3s");
    expect(p95.querySelector(".delta")).not.toHaveClass("warn");
    const cost = within(card).getByTestId("agent-card-support-bot-cost");
    expect(cost).toHaveTextContent("$41.60");
    expect(cost).toHaveTextContent("▲ $3.10");
    expect(cost.querySelector(".delta")).toHaveClass("warn");
    const blank = within(card).getByTestId("agent-card-support-bot-blank");
    expect(blank).toHaveTextContent("1.8%");
    expect(blank).toHaveTextContent("▲ 0.4pp");
    expect(within(card).getByTestId("agent-card-support-bot-toolfail")).toHaveTextContent("2.6%");
    expect(within(card).getByTestId("agent-card-support-bot-toolfail")).toHaveTextContent("▼ 0.9pp");
  });

  it("research-agent：五个数全 null → 「—」（title 带这一次算不出的原因），hourly 为 [] → 不画曲线", async () => {
    stubFleet();
    renderPage(<AgentsPage />);
    const card = await screen.findByTestId("agent-card-research-agent");
    await waitFor(() => expect(within(card).getByTestId("agent-card-research-agent-badge")).toBeInTheDocument());
    const sessions = within(card).getByTestId("agent-card-research-agent-sessions");
    expect(sessions).toHaveTextContent("—");
    expect(sessions.getAttribute("title")).toContain("没有 span 组");
    expect(within(card).queryByTestId("agent-card-research-agent-spark")).toBeNull();
    for (const k of ["p95", "cost", "blank", "toolfail"]) {
      const cell = within(card).getByTestId(`agent-card-research-agent-${k}`);
      expect(cell.querySelector(".obs-v")).toHaveTextContent("—");
      expect(cell.querySelector(".delta")).toHaveTextContent("—");
    }
    // 不编数：卡上没有任何数字冒充观测值
    expect(within(card).getByTestId("agent-card-research-agent-obs").textContent).not.toMatch(/\d\.\d%|\$\d|\d\.\ds/);
  });
});

describe("Agent 卡：评估 / 优化两行", () => {
  it("完成态：support-bot「下单意图回归 · 评估器 1/2 过线 · refusal 连续 3 次未过线」+ 下次 …03:00；badge 告警", async () => {
    stubFleet();
    renderPage(<AgentsPage />);
    const card = await screen.findByTestId("agent-card-support-bot");
    const evalRow = await within(card).findByTestId("agent-card-support-bot-eval");
    expect(evalRow).toHaveTextContent("下单意图回归");
    // correctness 0.94 过、refusal 0.55 不过 ⇒ 1/2；**不显示合成均分**
    expect(within(evalRow).getByTestId("agent-card-support-bot-gate")).toHaveTextContent("评估器 1/2 过线");
    expect(evalRow.textContent).not.toMatch(/0\.9|均分/);
    expect(within(evalRow).getByTestId("agent-card-support-bot-alert")).toHaveTextContent("refusal 连续 3 次未过线");
    expect(within(evalRow).getByTestId("agent-card-support-bot-next").textContent).toMatch(/^下次 \d{2}-\d{2} 03:00$/);
    expect(within(card).getByTestId("agent-card-support-bot-badge")).toHaveTextContent("告警");
    expect(card).toHaveAttribute("data-severity", "warn");
    expect(card).toHaveClass("hot");
    // 优化行：plan-ddd444 两次 run 上 1 未采纳 · 1 已验证
    await waitFor(() =>
      expect(within(card).getByTestId("agent-card-support-bot-opt")).toHaveTextContent("未采纳 1 · 已验证 1"));
    fireEvent.click(within(card).getByTestId("agent-card-support-bot-opt"));
    // 改钉（agent-hub 批）：优化格 → 该 Agent 详情 ③（③ 内默认口径 = 最近一次 vs 上一次），
    // 不再直跳评估分析页
    expect(location.hash).toBe("#/agent/support-bot/optimize");
  });

  it("失败态：billing-bot 评估行只留「账单核对回归 失败 · 原因」+ 下次；badge run 失败；卡置顶略大", async () => {
    stubFleet();
    renderPage(<AgentsPage />);
    const card = await screen.findByTestId("agent-card-billing-bot");
    const evalRow = await within(card).findByTestId("agent-card-billing-bot-eval");
    expect(evalRow).toHaveTextContent("账单核对回归 失败 · 评估 Runtime 超时（60s 无响应）");
    expect(evalRow.textContent).not.toContain("评估器");
    expect(evalRow.textContent).not.toContain("过线");
    expect(within(evalRow).getByTestId("agent-card-billing-bot-next").textContent).toMatch(/^下次 \d{2}-\d{2} 04:00$/);
    expect(within(card).getByTestId("agent-card-billing-bot-badge")).toHaveTextContent("run 失败");
    expect(card).toHaveAttribute("data-severity", "bad");
    expect(card).toHaveClass("hot");
    // 默认「最需要动手」排序：bad 在最前
    const grid = screen.getByTestId("agents-grid");
    expect(grid.firstElementChild).toBe(card);
  });

  it("从未评估：legal-qa 评估行 = 「未评估 · 新建评估计划」一个动作；无优化行；badge 未评估", async () => {
    stubFleet();
    renderPage(<AgentsPage />);
    const card = await screen.findByTestId("agent-card-legal-qa");
    const evalRow = await within(card).findByTestId("agent-card-legal-qa-eval");
    expect(evalRow).toHaveTextContent("未评估");
    expect(within(card).queryByTestId("agent-card-legal-qa-opt")).toBeNull();
    expect(within(card).getByTestId("agent-card-legal-qa-badge")).toHaveTextContent("未评估");
    expect(card).toHaveAttribute("data-severity", "none");
    expect(card).not.toHaveClass("hot");
    // 观测数据照样在（没被评估过的 Agent 在首页仍是一张完整的卡）
    expect(within(card).getByTestId("agent-card-legal-qa-sessions")).toHaveTextContent("393");
    fireEvent.click(within(evalRow).getByTestId("agent-card-legal-qa-new-plan"));
    expect(location.hash).toBe("#/plan/new");
  });

  it("无定时：hr-assistant 右侧「无定时」；评估器 2/2 过线（helpfulness 0.88 / coherence 0.78）；badge 正常", async () => {
    stubFleet();
    renderPage(<AgentsPage />);
    const card = await screen.findByTestId("agent-card-hr-assistant");
    const evalRow = await within(card).findByTestId("agent-card-hr-assistant-eval");
    expect(within(evalRow).getByTestId("agent-card-hr-assistant-gate")).toHaveTextContent("评估器 2/2 过线");
    expect(within(evalRow).getByTestId("agent-card-hr-assistant-next")).toHaveTextContent("无定时");
    expect(within(card).getByTestId("agent-card-hr-assistant-badge")).toHaveTextContent("正常");
    expect(card).toHaveAttribute("data-severity", "ok");
  });

  it("进行中：research-agent 有 running 行 → 评估行「进行中 · 调研全链路验收」；rate() 定时推不出 → 「下次 —」带原因", async () => {
    stubFleet();
    renderPage(<AgentsPage />);
    const card = await screen.findByTestId("agent-card-research-agent");
    const evalRow = await within(card).findByTestId("agent-card-research-agent-eval");
    expect(evalRow.querySelector(".badge.run")).toHaveTextContent("进行中");
    expect(evalRow).toHaveTextContent("调研全链路验收");
    const next = within(evalRow).getByTestId("agent-card-research-agent-next");
    expect(next).toHaveTextContent("下次 —");
    expect(next.getAttribute("title")).toContain("rate(1 day)");
  });
});

describe("排序切换", () => {
  it("最需要动手（默认）→ 会话量 → 成本 → 名称，卡序随之变", async () => {
    stubFleet();
    renderPage(<AgentsPage />);
    await screen.findByTestId("fleet-hero");
    const order = () => [...screen.getByTestId("agents-grid").children]
      .map((c) => c.getAttribute("data-testid")!.replace("agent-card-", ""));
    await waitFor(() => expect(order()).toEqual(
      // bad(billing) > warn(support) > ok(hr 890 会话, research 无数沉底) > none(legal)
      ["billing-bot", "support-bot", "hr-assistant", "research-agent", "legal-qa"]));
    expect(screen.getByTestId("agents-sort-priority")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("agents-sort-volume"));
    expect(order()).toEqual(["billing-bot", "support-bot", "hr-assistant", "legal-qa", "research-agent"]);
    fireEvent.click(screen.getByTestId("agents-sort-cost"));
    // 46.0 / 41.6 / 5.1 / 2.4 / null
    expect(order()).toEqual(["billing-bot", "support-bot", "hr-assistant", "legal-qa", "research-agent"]);
    fireEvent.click(screen.getByTestId("agents-sort-name"));
    expect(order()).toEqual(["billing-bot", "hr-assistant", "legal-qa", "research-agent", "support-bot"]);
    expect(screen.getByTestId("agents-sort-name")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("agents-sort-priority")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("页头时间窗", () => {
  it("近 24h · <start> → <end>，cached:true 时带「缓存」", async () => {
    const at = "2026-09-03T14:00:00Z";
    stubFleet({
      fleet_status: () => sseResponse([{ ...fleetStatus(Date.parse(at), NAMES), cached: true }]),
    });
    renderPage(<AgentsPage />);
    expect(await screen.findByTestId("home-window")).toHaveTextContent("近 24h · 09-02 14:00 → 09-03 14:00 · 缓存");
    // 「跨 Agent 共性问题」本批不做：不许放假占位
    expect(document.body.textContent).not.toContain("跨 Agent 共性问题");
  });
});
