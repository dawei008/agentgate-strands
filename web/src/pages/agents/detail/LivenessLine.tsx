// 流式长任务活性行（probe / autoconf 共用）：计时 + 三档心跳。
// 接入模式照 run-progress 交付原文；.res-liveness 样式拷贝在 agents.css（不跨页 import）。
import { fmtClock, heartbeatLabel, useLiveness } from "../../../lib/useLiveness";

export default function LivenessLine({
  startedAt,
  lastEventAt,
  testid,
}: {
  startedAt: number;
  lastEventAt: number;
  testid: string;
}) {
  const live = useLiveness(true, startedAt, lastEventAt);
  if (!live) return null;
  return (
    <span className={`res-liveness ${live.level}`} data-testid={testid}>
      <span className="dot" />
      已 {fmtClock(live.elapsedS)} ·{" "}
      {live.level === "ok"
        ? `链路正常 · ${heartbeatLabel(live)}`
        : live.level === "waiting"
          ? "等待响应…"
          : "可能已断开…"}
    </span>
  );
}
