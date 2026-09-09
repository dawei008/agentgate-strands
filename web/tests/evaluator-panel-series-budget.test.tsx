// 评估器面板小趋势的派生预算（批 fmt-converge 第 6 条）。
//
// 缺陷形态：`rowSeries(trendRuns, key)` 自己重跑 `evaluatorScores(r)`，而它是在
// `rows.map` 里被调用的 ⇒ 派生量 = 行数 × TREND_WINDOW（8 行的面板 = 64 次全量重算，
// 每次都要走 observeEvaluatorRows / evaluatorRows / runRedteamTally）。
// 修法：rowSeries 收**预算好的** Map[]，组件侧 useMemo 算一次给所有行共享 ⇒ 8 次。
//
// 判据不数「函数被调了几次」（模块级函数在组件里没法 spy），而是给夹具 run 的
// `stage_summaries` 装一个**计数 getter** —— evaluatorScores 每被调一次就读它固定几次，
// 于是「总读取次数 / 单次读取次数」就是 evaluatorScores 的调用次数。
// 关键不变式：**这个数与行数无关**（缺陷在时正比于行数）。
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import EvaluatorPanel from "../src/pages/agents/detail/hub/EvaluatorPanel";
import {
  TREND_WINDOW, evaluatorScores, rowSeries, type EvaluatorPanelRow,
} from "../src/pages/agents/detail/hub/optimizeDerive";
import type { PlanRunSummary, StageSummary } from "../src/pages/plan/types";

afterEach(cleanup);

/** 一条带 dataset 环节的 run；stage_summaries 每被读一次就记一笔 */
function countingRun(counter: { n: number }, means: Record<string, number>, i: number): PlanRunSummary {
  const stages: StageSummary[] = [{
    type: "dataset", status: "completed", pass_rate: 0.9,
    evaluators: Object.keys(means),
    evaluator_stats: Object.fromEntries(
      Object.entries(means).map(([k, mean]) => [k, { mean, passed: 9, judged: 10 }]),
    ),
  } as unknown as StageSummary];
  const run = {
    run_key: `plan-b#${i}`, status: "completed",
    started_at: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
  } as unknown as PlanRunSummary;
  Object.defineProperty(run, "stage_summaries", {
    get() { counter.n += 1; return stages; },
    enumerable: true,
  });
  return run;
}

const NAMES = ["refusal", "correctness", "coherence", "conciseness", "tone", "safety"];

function fixture(rowCount: number) {
  const counter = { n: 0 };
  const means = Object.fromEntries(NAMES.slice(0, rowCount).map((n, i) => [n, 0.5 + i * 0.05]));
  const trendRuns = Array.from({ length: TREND_WINDOW }, (_, i) => countingRun(counter, means, i));
  const rows: EvaluatorPanelRow[] = NAMES.slice(0, rowCount).map((name, i) => ({
    key: `dataset:${name}`, name, stage: "dataset",
    cur: 0.5 + i * 0.05, prev: null, redteam: null, prevRedteam: null,
    pass: 0.5 + i * 0.05 >= 0.7,
  }));
  return { counter, trendRuns, rows };
}

function renderPanel(rowCount: number) {
  const { counter, trendRuns, rows } = fixture(rowCount);
  render(
    <EvaluatorPanel
      rows={rows} headline={`${rowCount} 个评估器`}
      trendRuns={trendRuns} trendSeqs={{ first: 1, last: TREND_WINDOW }}
      thisSeq={TREND_WINDOW} prevSeq={TREND_WINDOW - 1} filter={null} onFilter={() => {}}
    />,
  );
  return counter.n;
}

describe("小趋势派生预算：与行数无关", () => {
  it("量具自检：一次 evaluatorScores 读 stage_summaries 的次数是常数", () => {
    const { counter, trendRuns } = fixture(3);
    evaluatorScores(trendRuns[0]);
    const perCall = counter.n;
    expect(perCall).toBeGreaterThan(0);
    evaluatorScores(trendRuns[0]);
    expect(counter.n).toBe(perCall * 2); // 每次调用读同样多次 ⇒ 可以当量具
  });

  it("3 行与 6 行渲染出的读取次数相同（缺陷在时是 3×8 vs 6×8）", () => {
    const three = renderPanel(3);
    cleanup();
    const six = renderPanel(6);
    expect(three).toBe(six);
  });

  it("次数 = 单次读取数 × TREND_WINDOW（每条 run 只算一遍）", () => {
    const { counter, trendRuns } = fixture(4);
    evaluatorScores(trendRuns[0]);
    const perCall = counter.n;
    const total = renderPanel(4);
    expect(total).toBe(perCall * TREND_WINDOW);
  });
});

describe("rowSeries：换签名后语义不变", () => {
  it("按同批同序出值；那次没有这个键 ⇒ null（线断开，不补 0）", () => {
    const maps = [
      new Map([["dataset:a", { cur: 0.5 } as EvaluatorPanelRow]]),
      new Map<string, EvaluatorPanelRow>(),
      new Map([["dataset:a", { cur: 0.8 } as EvaluatorPanelRow]]),
    ];
    expect(rowSeries(maps, "dataset:a")).toEqual([0.5, null, 0.8]);
    expect(rowSeries(maps, "dataset:missing")).toEqual([null, null, null]);
    expect(rowSeries([], "dataset:a")).toEqual([]);
  });

  it("与「逐 run 现算」逐字同值（换签名不是换口径）", () => {
    const { trendRuns } = fixture(3);
    const key = "dataset:refusal";
    const viaMaps = rowSeries(trendRuns.map(evaluatorScores), key);
    const viaRuns = trendRuns.map((r) => evaluatorScores(r).get(key)?.cur ?? null);
    expect(viaMaps).toEqual(viaRuns);
    expect(viaMaps).toHaveLength(TREND_WINDOW);
  });
});
