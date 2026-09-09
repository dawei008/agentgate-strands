import type { InvokeProbedEvent } from "../../types";

export default function PathList({ paths }: { paths: NonNullable<InvokeProbedEvent["response_paths"]> }) {
  return (
    <ul className="agent-probe-paths" data-testid="agent-probe-paths">
      {paths.map((p, i) => (
        <li key={i}>
          {p.path}
          {p.preview != null && <span className="path-preview"> = {p.preview}</span>}
        </li>
      ))}
    </ul>
  );
}
