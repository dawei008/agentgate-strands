import type { AutoconfProgressEvent } from "../../types";

/** 进度区：每试完一个模板一行（模板 mono + ✓/✗ + 耗时） */
export default function ProgressRows({ progress }: { progress: AutoconfProgressEvent[] }) {
  if (progress.length === 0) return null;
  return (
    <div className="autoconf-progress" data-testid="autoconf-progress">
      {progress.map((p, i) => (
        <div className="autoconf-progress-row" key={i} data-testid={`autoconf-progress-${i}`}>
          <span className={p.ok ? "mark-ok" : "mark-fail"} aria-hidden="true">
            {p.ok ? "✓" : "✗"}
          </span>
          <span className="tpl">{p.template}</span>
          {typeof p.latency_ms === "number" && <span className="lat">{p.latency_ms} ms</span>}
        </div>
      ))}
    </div>
  );
}
