import { fmtHour, fmtInt, peakBucket } from "./derive";
import type { HourlyBucket } from "./types";

/**
 * 24 点小时曲线（fleet_status 的 `hourly` 桶）。空数组 = 日志组不可用 ⇒ 不渲染
 * （调用方只留数字），**不为画图编数据**。纯 SVG，viewBox 定宽由 CSS 拉伸。
 * 轴行：左 = 第一桶时刻、中 = 峰值桶「峰 HH:mm · N」、右 = 最后一桶时刻。
 */
export default function Sparkline({
  hourly,
  label,
  testid,
}: {
  hourly: HourlyBucket[] | undefined | null;
  label: string;
  testid?: string;
}) {
  if (!hourly || hourly.length < 2) return null;
  const W = 240;
  const H = 40;
  const pad = 3;
  const max = Math.max(1, ...hourly.map((b) => b.sessions));
  const step = (W - pad * 2) / (hourly.length - 1);
  const x = (i: number) => pad + i * step;
  const y = (v: number) => pad + (1 - v / max) * (H - pad * 2);
  const line = hourly.map((b, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(b.sessions).toFixed(1)}`).join(" ");
  const area = `${line} L ${x(hourly.length - 1).toFixed(1)} ${H - pad} L ${x(0).toFixed(1)} ${H - pad} Z`;
  const last = hourly[hourly.length - 1];
  const peak = peakBucket(hourly)!;
  return (
    <>
      <div className="spark" data-testid={testid}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
          {hourly.map((_, i) => (i % 6 === 0 ? (
            <line key={i} className="sp-tick" x1={x(i)} x2={x(i)} y1={H - pad} y2={H - pad - 3} />
          ) : null))}
          <path className="sp-area" d={area} />
          <path className="sp-line" d={line} />
          <circle className="sp-dot" cx={x(hourly.length - 1)} cy={y(last.sessions)} r={2.5} />
        </svg>
      </div>
      <div className="spark-axis">
        <span>{fmtHour(hourly[0].hour)}</span>
        <span className="mid">峰 {fmtHour(peak.hour)} · {fmtInt(peak.sessions)}</span>
        <span>{fmtHour(last.hour)}</span>
      </div>
    </>
  );
}
