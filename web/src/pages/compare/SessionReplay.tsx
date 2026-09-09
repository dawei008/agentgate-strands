// 单栏会话回放（ADR-0017 F8）= 双栏 diff 的单栏版：一条时间线 + 属性表（无 diff）
// + 该侧评估器表。两处入口共用：
//   · 报告页格详情「回放」（StageMatrix）—— 料来自页面已有的 S3 明细环节
//   · 评估分析页同题配对里未对齐的行 —— 料来自缓存里的 get_plan_run 归档
// `missing` 给了就在另一侧位置放一枚「X run 无同题会话」chip（配对页用；报告页不传）。
import type { SessionSide } from "../../lib/apiTypes";
import Timeline from "./Timeline";
import { AttrTable, EvalTable, MissingStrip, RunStrip, type Side } from "./SessionPanels";
import "./pairs.css";

export default function SessionReplay({ side, which = "a", missing = null, testid }: {
  side: SessionSide;
  /** 这一侧是左还是右（决定身份色与「左 run / 右 run」字样）；报告页缺省左 */
  which?: Side;
  /** 对面那侧没有同题 ⇒ 在那个位置放 chip；null = 不画对面（报告页） */
  missing?: Side | null;
  testid: string;
}) {
  const strips = missing == null
    ? <RunStrip side={side} which={which} testid={`${testid}-run`} />
    : which === "a"
      ? <><RunStrip side={side} which="a" testid={`${testid}-run`} /><MissingStrip which="b" testid={`${testid}-missing`} /></>
      : <><MissingStrip which="a" testid={`${testid}-missing`} /><RunStrip side={side} which="b" testid={`${testid}-run`} /></>;
  return (
    <div className="pr-panel is-single" data-testid={testid}>
      <div className={`pr-runs${missing == null ? " is-one" : ""}`}>{strips}</div>
      <section className="pr-sec">
        <div className="pr-sec-h">
          <h3>回放</h3>
          <span className="pr-sec-r num">{side.events.length} 事件</span>
        </div>
        <div className="pr-sec-b">
          <Timeline left={which === "a" ? side : null} right={which === "b" ? side : null} testid={`${testid}-tl`} />
        </div>
      </section>
      <AttrTable side={side} which={which} testid={`${testid}-attrs`} />
      <EvalTable side={side} which={which} testid={`${testid}-evals`} />
    </div>
  );
}
