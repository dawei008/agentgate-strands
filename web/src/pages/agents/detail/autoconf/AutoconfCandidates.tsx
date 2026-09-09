import { useState } from "react";
import type { AgentAutoconfiguredEvent, AutoconfProgressEvent } from "../../types";
import AutoconfMeta from "./AutoconfMeta";
import DetailsFold from "./DetailsFold";

/** 态 candidates：琥珀，单选卡列表（预选第一个 + 推荐标注） */
export default function AutoconfCandidates({
  r,
  progress,
  applying,
  applyError,
  onApply,
  onManual,
  fallbackTemplate,
}: {
  r: AgentAutoconfiguredEvent;
  progress: AutoconfProgressEvent[];
  applying: boolean;
  applyError: string | null;
  onApply: (payloadTemplate: string, responsePath: string) => void;
  onManual: (prefill?: { template?: string; responsePath?: string }) => void;
  fallbackTemplate: string;
}) {
  const [sel, setSel] = useState(0); // 预选第一个（后端已按可能性排序）
  const cands = r.candidates ?? [];
  // 落库用的 payload 模板：终态 template 字段 → 命中的那次尝试 → 当前表单值
  const tpl =
    r.template ?? r.attempts?.filter((a) => a.ok).at(-1)?.template ?? fallbackTemplate;
  return (
    <div className="autoconf-result" data-testid="autoconf-candidates">
      <div className="verdict">
        <span className="vmark warn" aria-hidden="true">!</span>
        <span className="vtext">
          <span className="vtitle">
            检测到 <b>{cands.length} 个候选回答字段</b>，请选择正确的一个
          </span>
          <AutoconfMeta r={r} />
        </span>
      </div>
      <div className="verdict-body">
        <div className="cands">
          {cands.map((c, i) => (
            <label
              key={c.response_path}
              className={`cand${sel === i ? " on" : ""}`}
              data-testid={`autoconf-cand-${i}`}
            >
              <input
                type="radio"
                name="autoconf-cand"
                checked={sel === i}
                onChange={() => setSel(i)}
              />
              <span className="radio" aria-hidden="true" />
              <span style={{ minWidth: 0 }}>
                <span className="cpath">{c.response_path}</span>
                {i === 0 && (
                  <span className="rec" style={{ marginLeft: 6 }}>
                    推荐{c.reason ? ` · ${c.reason}` : ""}
                  </span>
                )}
                {c.preview != null && <span className="cprev">{c.preview}</span>}
              </span>
              <span className="cmeta">
                <span>string</span>
                {typeof c.length === "number" && <span>{c.length} 字</span>}
              </span>
            </label>
          ))}
        </div>
        <div className="cand-actions">
          <button
            className="btn"
            data-testid="autoconf-cand-confirm"
            disabled={applying || cands.length === 0}
            onClick={() => onApply(tpl, cands[sel]?.response_path ?? "")}
          >
            {applying ? "保存中…" : "确认选择"}
          </button>
          <button
            className="btn-link"
            data-testid="autoconf-cand-manual"
            onClick={() => onManual({ template: tpl })}
          >
            都不对，手动填路径
          </button>
          <span className="spacer" />
          <span className="subtle" style={{ fontSize: "var(--fs-nano)" }}>
            未确认前该 Agent 的评估计划不会运行
          </span>
        </div>
        {applyError && (
          <p className="autoconf-apply-error" data-testid="autoconf-apply-error">
            ✗ 保存失败 · {applyError}
          </p>
        )}
      </div>
      <DetailsFold progress={progress} />
    </div>
  );
}
