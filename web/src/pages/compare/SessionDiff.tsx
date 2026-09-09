// 双栏会话 diff（ADR-0017 D3）：session_compare 事件 → 两条 run 元信息条 →
// 时间线（同刻度、连线、差异块）→ 属性 diff 表 → 评估器并排表。
// 只排版；diff 是服务端算好的（attribute_diff / text_diff），这里一个字都不重算。
import type { SessionCompareEvent } from "../../lib/apiTypes";
import Timeline from "./Timeline";
import { AttrDiffTable, EvalDiffTable, RunStrip } from "./SessionPanels";
import "./pairs.css";

export default function SessionDiff({ data, testid }: { data: SessionCompareEvent; testid: string }) {
  const { left, right } = data;
  return (
    <div className="pr-panel" data-testid={testid} data-aligned={data.aligned}>
      <div className="pr-runs">
        <RunStrip side={left} which="a" testid={`${testid}-run-a`} />
        <RunStrip side={right} which="b" testid={`${testid}-run-b`} />
      </div>
      <section className="pr-sec">
        <div className="pr-sec-h">
          <h3>时间线</h3>
          <span className="pr-sec-r num">
            {new Set([...left.events.map((e) => e.n), ...right.events.map((e) => e.n)]).size} 轮
          </span>
        </div>
        <div className="pr-sec-b">
          <Timeline left={left} right={right} testid={`${testid}-tl`} />
        </div>
      </section>
      <AttrDiffTable
        diff={data.attribute_diff}
        total={data.attribute_total}
        left={left}
        right={right}
        testid={`${testid}-attrs`}
      />
      <EvalDiffTable left={left} right={right} testid={`${testid}-evals`} />
    </div>
  );
}
