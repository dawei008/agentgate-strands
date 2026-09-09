// 会话 id 短形式的**唯一实现**钉（批 fmt-converge 第 2 条）。
//
// 缺陷形态：三份实现，同一屏两种写法。报告页一屏上 IssueLedger 的正文引用 chip 走
// SynthesisText 私写的「截前 18 字 + …」（`dsh-trace-e5d8fb96…`），而 StageMatrix /
// VerdictLine / EvaluatorTiles / ReportHero 走 reportRows 的首段 8 位 hex
// （`e5d8fb96`）—— 读者对不上是哪一条会话；实时会话清单（observeSessions）又是第三份
// 「截前 12 字 + …」，同一条会话跑完前后印出两个样子。
//
// 判据不是「某一处等于某个字面串」（那只钉住一处），而是**三个入口互相逐字相等**：
// 任何一处漂回私写实现，这里立刻红。
import { describe, expect, it } from "vitest";
import { shortSessionId as fromLib } from "../src/lib/text";
import { shortSessionId as fromReportRows } from "../src/pages/plan/reportRows";
import { shortSessionId as fromObserveSessions } from "../src/pages/plan/observeSessions";
import { synthRefLabel } from "../src/components/SynthesisText";

/** 现网真形态（AgentCore trace 会话 id） */
const LIVE = "dsh-trace-e5d8fb96-7c21-4a19-9b3e-0f1a2b3c4d5e";
/** mock 形态 */
const MOCK = "sess-7f3a9c21b8d4e6f0";
/** 8 位 hex 段都没有的退化形态 */
const PLAIN = "sess-abc";

describe("三个入口 = 同一份实现", () => {
  it("报告行层 / 实时会话清单 / 综合报告正文 chip 对同一个 id 逐字相同", () => {
    for (const id of [LIVE, MOCK, PLAIN, ""]) {
      const want = fromLib(id);
      expect(fromReportRows(id), `reportRows ${id}`).toBe(want);
      expect(fromObserveSessions(id), `observeSessions ${id}`).toBe(want);
      // 正文 chip 的标签（无消息编号时就是短 id 本身）
      expect(synthRefLabel({ kind: "session", id, msgNo: null }), `synthRefLabel ${id}`).toBe(want);
    }
  });

  it("口径 = 首段 8 位 hex（现网 id 上 chip 与矩阵行都印 e5d8fb96）", () => {
    expect(fromLib(LIVE)).toBe("e5d8fb96");
    expect(synthRefLabel({ kind: "session", id: LIVE, msgNo: null })).toBe("e5d8fb96");
    expect(fromReportRows(LIVE)).toBe("e5d8fb96");
  });

  it("带消息编号的 chip 在短 id 后接 #N（编号不是 id 的一部分，短形式仍是那 8 位）", () => {
    expect(synthRefLabel({ kind: "session", id: LIVE, msgNo: 7 })).toBe("e5d8fb96 #7");
  });

  it("完整 id 仍拿得到（chip 的 data-full / 深链 / 去重键都用它，短形式会撞）", () => {
    // synthRefFull 与 label 分开正是为此；这里钉「短 ≠ 全」且全值一字不改
    expect(fromLib(LIVE)).not.toBe(LIVE);
  });
});
