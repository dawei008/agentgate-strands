import type { InvokeProbedEvent } from "../../types";

export function ProbeMeta({ r }: { r: InvokeProbedEvent }) {
  if (typeof r.latency_ms !== "number" && typeof r.response_bytes !== "number") return null;
  return (
    <div className="agent-probe-meta">
      {typeof r.latency_ms === "number" && <>耗时 {r.latency_ms} ms</>}
      {typeof r.response_bytes === "number" && <> · 响应 {r.response_bytes} 字节</>}
    </div>
  );
}

export function ExtractedText({ r }: { r: InvokeProbedEvent }) {
  if (r.extracted_text == null || r.extracted_text === "") return null;
  return (
    <pre className="agent-probe-extracted" data-testid="agent-probe-extracted">{r.extracted_text}</pre>
  );
}
