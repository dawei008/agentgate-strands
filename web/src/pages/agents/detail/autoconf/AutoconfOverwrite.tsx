import { fmtTimeUtc } from "../../../../lib/time";
import type { AgentAutoconfiguredEvent } from "../../types";

const CONFIGURED_BY_LABEL: Record<string, string> = { auto: "自动配置", manual: "手动配置" };

/** 态 confirm_overwrite：对话卡——原配置 vs 本次推断，用户拍板 */
export default function AutoconfOverwrite({
  r,
  applying,
  applyError,
  onApply,
  onDismiss,
}: {
  r: AgentAutoconfiguredEvent;
  applying: boolean;
  applyError: string | null;
  onApply: (payloadTemplate: string, responsePath: string) => void;
  onDismiss: () => void;
}) {
  const cur = r.current;
  const pro = r.proposed;
  return (
    <div className="autoconf-result" data-testid="autoconf-confirm_overwrite">
      <div className="verdict">
        <span className="vmark warn" aria-hidden="true">!</span>
        <span className="vtext">
          <span className="vtitle">
            原为 <span className="pathchip" data-testid="autoconf-ow-current">{cur?.response_path || "（整段文本）"}</span>
            ，本次推断为{" "}
            <span className="pathchip" data-testid="autoconf-ow-proposed">
              {pro?.plaintext ? "（整段文本）" : pro?.response_path || "（整段文本）"}
            </span>
            ，是否更新？
          </span>
          <span className="vsub" data-testid="autoconf-ow-meta">
            现有配置：{CONFIGURED_BY_LABEL[cur?.configured_by ?? ""] ?? "来源未知"}
            {cur?.updated_at != null && ` · ${fmtTimeUtc(cur.updated_at)}`}
          </span>
        </span>
      </div>
      <div className="verdict-body">
        <div className="cand-actions" style={{ marginTop: 0 }}>
          <button
            className="btn"
            data-testid="autoconf-ow-update"
            disabled={applying}
            onClick={() => onApply(pro?.payload_template ?? "", pro?.plaintext ? "" : pro?.response_path ?? "")}
          >
            {applying ? "更新中…" : "更新配置"}
          </button>
          <button
            className="btn-secondary btn"
            data-testid="autoconf-ow-keep"
            disabled={applying}
            onClick={onDismiss}
          >
            保留原配置
          </button>
        </div>
        {applyError && (
          <p className="autoconf-apply-error" data-testid="autoconf-apply-error">
            ✗ 更新失败 · {applyError}
          </p>
        )}
      </div>
    </div>
  );
}
