// 自动推断五态呈现（照 ui-prototypes/auto-config 原型）。
import type { AgentAutoconfiguredEvent, AutoconfProgressEvent } from "../../types";
import LivenessLine from "../LivenessLine";
import ProgressRows from "./ProgressRows";
import AutoconfSaved from "./AutoconfSaved";
import AutoconfCandidates from "./AutoconfCandidates";
import AutoconfOverwrite from "./AutoconfOverwrite";
import AutoconfFailed from "./AutoconfFailed";

/** 自动推断状态机：running 期间累积 autoconf_progress 帧；done 按 outcome 五分派 */
export type AutoconfState =
  | { phase: "idle" }
  // running 期间带时间戳养活性行：任意流式事件（含 heartbeat）刷 lastEventAt
  | { phase: "running"; progress: AutoconfProgressEvent[]; startedAt: number; lastEventAt: number }
  | { phase: "done"; result: AgentAutoconfiguredEvent; progress: AutoconfProgressEvent[] }
  // 传输层失败（error 事件 / 网络异常）——与 outcome:"failed"（模板全试完）分开
  | { phase: "transport_failed"; error: string; progress: AutoconfProgressEvent[] }
  // candidates/confirm_overwrite 经用户确认后已调 set_agent_config 落库
  | { phase: "applied"; responsePath: string };

export default function AutoconfArea({
  state,
  applying,
  applyError,
  onApply,
  onRetry,
  onDismiss,
  onManual,
  fallbackTemplate,
}: {
  state: AutoconfState;
  applying: boolean;
  applyError: string | null;
  onApply: (payloadTemplate: string, responsePath: string) => void;
  onRetry: () => void;
  onDismiss: () => void;
  onManual: (prefill?: { template?: string; responsePath?: string }) => void;
  fallbackTemplate: string;
}) {
  if (state.phase === "idle") return null;

  if (state.phase === "running") {
    return (
      <div data-testid="autoconf-running">
        <div className="autoconf-probing" data-testid="autoconf-probing">
          探测中…
        </div>
        <ProgressRows progress={state.progress} />
        {/* 活性行在进度区下方，不打散逐步进度展示 */}
        <LivenessLine
          startedAt={state.startedAt}
          lastEventAt={state.lastEventAt}
          testid="autoconf-liveness"
        />
      </div>
    );
  }

  if (state.phase === "transport_failed") {
    return (
      <div className="autoconf-result" data-testid="autoconf-transport-failed">
        <div className="verdict">
          <span className="vmark bad" aria-hidden="true">✗</span>
          <span className="vtext">
            <span className="vtitle">
              <span className="badk">探测失败</span> · {state.error}
            </span>
          </span>
          <span className="vact">
            <button className="btn-link" data-testid="autoconf-retry" onClick={onRetry}>↺ 重试</button>
          </span>
        </div>
        {state.progress.length > 0 && (
          <div className="verdict-body">
            <ProgressRows progress={state.progress} />
          </div>
        )}
      </div>
    );
  }

  if (state.phase === "applied") {
    return (
      <div className="autoconf-result" data-testid="autoconf-applied">
        <div className="verdict">
          <span className="vmark ok" aria-hidden="true">✓</span>
          <span className="vtext">
            <span className="vtitle">
              <span className="ok">已保存</span> · 响应路径{" "}
              <span className="pathchip">{state.responsePath || "（整段文本）"}</span>
            </span>
          </span>
        </div>
      </div>
    );
  }

  const r = state.result;
  switch (r.outcome) {
    case "saved":
    case "unchanged":
      return <AutoconfSaved r={r} progress={state.progress} onManual={onManual} />;
    case "candidates":
      return (
        <AutoconfCandidates
          r={r}
          progress={state.progress}
          applying={applying}
          applyError={applyError}
          onApply={onApply}
          onManual={onManual}
          fallbackTemplate={fallbackTemplate}
        />
      );
    case "confirm_overwrite":
      return (
        <AutoconfOverwrite
          r={r}
          applying={applying}
          applyError={applyError}
          onApply={onApply}
          onDismiss={onDismiss}
        />
      );
    case "failed":
    default:
      return <AutoconfFailed r={r} onRetry={onRetry} onManual={onManual} />;
  }
}
