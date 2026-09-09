// 「与阈值结论并排的分不许四舍五入」这条既有裁定（tests/bigscreen-threshold-floor.test.tsx
// 立的，当时只落到大屏三处）在 ③ 优化面板 / 评估器页的补钉。
//
// 缺陷形态：这三处私写 `toFixed(2)`（optimizeDerive 的 headline、EvaluatorPanel 的本次分格、
// resources/evaluatorUsage 那份**同名遮蔽** lib 的 fmtScore），于是缺陷带里的分印成「0.70」
// 而**同一行/同一句**里的 badge 说「未过」。
//
// ⚠️ 量具自检（这条差点让整个判据结构上不可能红）：缺陷带的下界写作 0.695，但
// **字面量 `0.695` 不在带内** —— 它的 double 是 0.694999999999999951…，`toFixed(2)`
// 本来就给 "0.69"，拿它当判据在修复前也会绿。带内的真值要 > 0.695，例如 0.698、
// 0.6999、或 `0.995 - 0.3`（= 0.6950000000000001）。BAND_SELF_CHECK 把这件事钉住，
// 印在读数之前。
//
// 反向也钉：差值（rowDelta）与效果格前后值不与阈值结论并排 ⇒ 仍是四舍五入档（fmtScore），
// 否则「显示端一律 floor」会变成另一条无依据的规则。
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import EvaluatorPanel from "../src/pages/agents/detail/hub/EvaluatorPanel";
import {
  SCORE_TARGET, effectView, evaluatorHeadline, rowDelta,
  type EvaluatorPanelRow,
} from "../src/pages/agents/detail/hub/optimizeDerive";
import type { RunProposal } from "../src/pages/plan/types";

/** 缺陷带内的真值：低于目标线，但两位四舍五入印出目标线本身 */
const EDGE = 0.698;

const row = (over: Partial<EvaluatorPanelRow> = {}): EvaluatorPanelRow => ({
  key: "dataset:refusal", name: "refusal", stage: "dataset",
  cur: EDGE, prev: null, redteam: null, prevRedteam: null, pass: EDGE >= SCORE_TARGET,
  ...over,
});

describe("量具自检：缺陷带 (0.695, 0.70) 的边界", () => {
  it("字面量 0.695 的 double 落在带**外**（toFixed 已经给 0.69）——不能拿它当判据", () => {
    expect(0.695 < 0.695000000000000001).toBe(false); // 同一个 double
    expect((0.695).toFixed(2)).toBe("0.69");
  });

  it("EDGE 在带内：低于目标线，且四舍五入会印出目标线本身", () => {
    expect(EDGE < SCORE_TARGET).toBe(true);
    expect(EDGE.toFixed(2)).toBe("0.70");
    expect(row().pass).toBe(false);
  });
});

describe("缺陷带内的分：并排位向下取整", () => {
  it("头部一句话：「refusal 0.69 未过」——同一句里不许出现 0.70", () => {
    const line = evaluatorHeadline([row(), row({ key: "dataset:correctness", name: "correctness", cur: 0.9, pass: true })]);
    expect(line).toBe("2 个评估器 · 1 过线 · refusal 0.69 未过");
    expect(line).not.toContain("0.70");
  });

  it("面板本次分格 = 0.69，与同一行「未过 · 目标线 0.70」并排读得通", () => {
    render(
      <EvaluatorPanel
        rows={[row()]} headline="1 个评估器 · 0 过线 · refusal 0.69 未过"
        trendRuns={[]} trendSeqs={{ first: null, last: null }}
        thisSeq={7} prevSeq={6} filter={null} onFilter={() => {}}
      />,
    );
    const tr = screen.getByTestId("agent-evaluator-row-dataset:refusal");
    expect(within(tr).getByTestId("agent-evaluator-row-dataset:refusal-score")).toHaveTextContent("0.69");
    // 并排的结论格（这一格印的是阈值本身 0.70，不是分 —— 它不该被 floor）
    const goal = within(tr).getByTestId("agent-evaluator-row-dataset:refusal-goal");
    expect(goal).toHaveTextContent("未过");
    expect(goal).toHaveTextContent("目标线 0.70");
  });

  it("满分与整数值不受影响（floor 只在小数位上动手）", () => {
    render(
      <EvaluatorPanel
        rows={[row({ key: "dataset:correctness", name: "correctness", cur: 1, pass: true })]}
        headline="1 个评估器 · 全部过线"
        trendRuns={[]} trendSeqs={{ first: null, last: null }}
        thisSeq={7} prevSeq={6} filter={null} onFilter={() => {}}
      />,
    );
    expect(screen.getByTestId("agent-evaluator-row-dataset:correctness-score")).toHaveTextContent("1.00");
  });
});

describe("反向钉：不与阈值结论并排的位仍是四舍五入档", () => {
  it("「较上一次」差值落在带内时印 ▲0.70（差值旁边没有过/未过）", () => {
    const d = rowDelta(row({ cur: 0.995, prev: 0.3, pass: true })); // 差 = 0.6950000000000001
    expect(d).toEqual({ dir: "up", text: "▲0.70" });
  });

  it("效果格前后值落在带内时印 0.70（判定归后端 verdict，这里只投影数）", () => {
    const p = {
      adoption_effect: {
        verdict: "improved",
        metrics: [{ name: "refusal", before: 0.3, after: EDGE }],
      },
    } as unknown as RunProposal;
    expect(effectView(p).lines).toEqual(["refusal 0.30 → 0.70"]);
  });
});
