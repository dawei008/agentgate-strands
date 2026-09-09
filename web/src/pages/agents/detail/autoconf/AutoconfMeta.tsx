import type { AgentAutoconfiguredEvent } from "../../types";

/** 终态元信息 mono 行：耗时 · 字节 · 尝试模板数 · 命中模板 */
export default function AutoconfMeta({ r }: { r: AgentAutoconfiguredEvent }) {
  const items: string[] = [];
  if (typeof r.latency_ms === "number") items.push(`${r.latency_ms} ms`);
  if (typeof r.response_bytes === "number") items.push(`${r.response_bytes.toLocaleString("en-US")} B`);
  if (typeof r.attempts_total === "number") items.push(`尝试 ${r.attempts_total} 个模板`);
  if (r.template) items.push(`命中 ${r.template}`);
  if (items.length === 0) return null;
  return (
    <span className="vmeta" data-testid="autoconf-vmeta">
      {items.map((it, i) => (
        <span key={i} style={{ display: "contents" }}>
          {i > 0 && <span className="sep" />}
          <span>{it}</span>
        </span>
      ))}
    </span>
  );
}
