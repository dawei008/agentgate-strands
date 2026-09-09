import type { InvokeProbedEvent } from "../../types";
import LivenessLine from "../LivenessLine";
import { ProbeMeta, ExtractedText } from "./ProbeMeta";
import PathList from "./PathList";

export type ProbeState =
  | { phase: "idle" }
  // probing 期间带时间戳养活性行：任意流式事件（含 heartbeat）刷 lastEventAt
  | { phase: "probing"; startedAt: number; lastEventAt: number }
  | { phase: "done"; result: InvokeProbedEvent }
  | { phase: "failed"; error: string };

/**
 * 探测结果三态（第 8 项：颜色必须与语义一致）。
 *
 *   1) 纯文本成功  plain_text=true  → --good 绿：整段文本即输出，留空 response_path
 *   2) JSON 成功    ok=true         → --good 绿：给出可选路径列表
 *   3) 真实失败     ok=false        → --bad 红：超时 / 异常 / 路径取不到值
 *
 * 历史 bug：后端把「纯文本」判成 ok=false + error 文案，前端照 ok 判色渲染成
 * 红字报错，用户连问两次「是不是要改成 JSON」、又问「不用改为什么标红」。
 * 根因已修在 app/probe.py（回 ok=true + plain_text=true），这里按三态呈现。
 */
export default function ProbeResult({ state }: { state: ProbeState }) {
  if (state.phase === "idle") return null;
  if (state.phase === "probing") {
    return (
      <div className="agent-probe-result probing" data-testid="agent-probe-status">
        探测中…
        <LivenessLine
          startedAt={state.startedAt}
          lastEventAt={state.lastEventAt}
          testid="agent-probe-liveness"
        />
      </div>
    );
  }
  // 态 3a：调用层就失败了（超时 / 异常 / 非 2xx）
  if (state.phase === "failed") {
    return (
      <div className="agent-probe-result is-bad" data-testid="agent-probe-status">
        <span className="probe-err" data-testid="agent-probe-fail">✗ 探测失败 · {state.error}</span>
      </div>
    );
  }

  const r = state.result;
  // 态 3b：连通了但后端判定失败（如 response_path 取不到值）
  if (!r.ok) {
    return (
      <div className="agent-probe-result is-bad" data-testid="agent-probe-status">
        <span className="probe-err" data-testid="agent-probe-fail">
          ✗ 探测失败 · {r.error ?? "未知原因"}
        </span>
        <ProbeMeta r={r} />
        {r.response_paths && r.response_paths.length > 0 && (
          <>
            <PathList paths={r.response_paths} />
          </>
        )}
      </div>
    );
  }

  // 态 1：纯文本成功
  if (r.plain_text) {
    return (
      <div className="agent-probe-result is-good" data-testid="agent-probe-status">
        <span className="probe-ok" data-testid="agent-probe-ok">
          ✓ 探测成功 · 该 Agent 返回纯文本
        </span>
        <ProbeMeta r={r} />
        <ExtractedText r={r} />
      </div>
    );
  }

  // 态 2：JSON 成功
  return (
    <div className="agent-probe-result is-good" data-testid="agent-probe-status">
      <span className="probe-ok" data-testid="agent-probe-ok">✓ 探测成功</span>
      <ProbeMeta r={r} />
      <ExtractedText r={r} />
      {r.response_paths && r.response_paths.length > 0 && (
        <>
          <div className="agent-probe-note">可选取值路径</div>
          <PathList paths={r.response_paths} />
        </>
      )}
    </div>
  );
}
