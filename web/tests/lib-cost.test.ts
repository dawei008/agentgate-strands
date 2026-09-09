// lib/cost.fmtCost：成本三态（真 0 / 部分 / 全缺）+ 反向钉（agent_usd=null 不是 0）。
// 夹具形态逐字照 testrun.py execute_test_run 的 run 对象与 2026-09-08 现网实测：
//   actual_cost_usd=0.21, cost_breakdown={judge_usd:0.21, agent_usd:null,
//   unpriced:["tauairline_agentfable5"]}, cost_is_partial=true
import { describe, expect, it } from "vitest";
import { fmtCost, unpricedNames } from "../src/lib/cost";

const LIVE = {
  actual_cost_usd: 0.21,
  cost_breakdown: { judge_usd: 0.21, agent_usd: null, unpriced: ["tauairline_agentfable5"] },
  cost_is_partial: true,
};

describe("fmtCost 三态", () => {
  it("真 0：cost_is_partial=false 且 agent_usd 是数 ⇒ $0.00，不标", () => {
    const r = fmtCost(0, { judge_usd: 0, agent_usd: 0, unpriced: [] }, false);
    expect(r).toEqual({ text: "$0.00", badge: null, title: undefined, partial: false });
  });

  it("部分：现网 run ⇒ 数字 + 「部分」 + title 列未定价名单", () => {
    const r = fmtCost(LIVE.actual_cost_usd, LIVE.cost_breakdown, LIVE.cost_is_partial);
    expect(r.text).toBe("$0.21");
    expect(r.badge).toBe("部分");
    expect(r.title).toBe("未定价：tauairline_agentfable5");
    expect(r.partial).toBe(true);
  });

  it("全缺（旧 run 没有 cost_breakdown / cost_is_partial）：0 ⇒ —，非 0 照印不标", () => {
    expect(fmtCost(0)).toEqual({ text: "—", badge: null, title: undefined, partial: false });
    expect(fmtCost(0, null, undefined)).toMatchObject({ text: "—", badge: null });
    expect(fmtCost(0.31)).toEqual({ text: "$0.31", badge: null, title: undefined, partial: false });
    expect(fmtCost(null)).toMatchObject({ text: "—", badge: null });
    expect(fmtCost(undefined)).toMatchObject({ text: "—", badge: null });
    expect(fmtCost(Number.NaN)).toMatchObject({ text: "—" });
  });

  it("有价那半是 0 且部分 ⇒ 「—」+「部分」（0 不是实测值）", () => {
    const r = fmtCost(0, { judge_usd: 0, agent_usd: null, unpriced: ["x"] }, true);
    expect(r.text).toBe("—");
    expect(r.badge).toBe("部分");
    expect(r.title).toBe("未定价：x");
  });

  it("只有 cost_is_partial=false 而无拆分 ⇒ 0 是真 0", () => {
    expect(fmtCost(0, null, false).text).toBe("$0.00");
  });
});

describe("反向钉：agent_usd=null 不并进总额当 0", () => {
  it("没有 actual 时金额只从是数的项加：judge 0.21 + agent null ⇒ 0.21（不是 NaN / 不是 0）", () => {
    const r = fmtCost(undefined, { judge_usd: 0.21, agent_usd: null, unpriced: ["a"] });
    expect(r.text).toBe("$0.21");
    expect(r.badge).toBe("部分");
  });

  it("agent_usd=null 与 agent_usd=0 渲染**必须不同**：同一 judge 数，一边标部分一边不标", () => {
    const asNull = fmtCost(0.21, { judge_usd: 0.21, agent_usd: null, unpriced: ["a"] }, true);
    const asZero = fmtCost(0.21, { judge_usd: 0.21, agent_usd: 0, unpriced: [] }, false);
    expect(asZero).toEqual({ text: "$0.21", badge: null, title: undefined, partial: false });
    expect(asNull).not.toEqual(asZero);
    expect(asNull.badge).toBe("部分");
    // 把 null 当 0 加出来的数 = judge + 0 = 0.21 —— 文本可能同为 $0.21，但**整体渲染**不许同形
    const naive = `$${(0.21 + Number(null)).toFixed(2)}`;
    expect(`${asNull.text} ${asNull.badge}`).not.toBe(`${naive} ${null}`);
  });

  it("拆分里只写了 agent_usd:null（无 cost_is_partial 键）也算部分", () => {
    expect(fmtCost(0.5, { judge_usd: 0.5, agent_usd: null }).badge).toBe("部分");
  });

  it("小数位：会话级 4 位", () => {
    expect(fmtCost(0.021, null, false, { digits: 4 }).text).toBe("$0.0210");
  });

  it("额外未定价名单（观测 metrics.cost.unpriced_models）并进 title 并触发部分", () => {
    const r = fmtCost(0, null, undefined, { unpriced: ["us.anthropic.claude-sonnet-4-5"] });
    expect(r).toMatchObject({ text: "—", badge: "部分", title: "未定价：us.anthropic.claude-sonnet-4-5" });
  });

  it("unpricedNames 去重、去空、保序", () => {
    expect(unpricedNames({ unpriced: ["b", "a", "b", ""] }, ["a", "c"])).toEqual(["b", "a", "c"]);
  });
});
