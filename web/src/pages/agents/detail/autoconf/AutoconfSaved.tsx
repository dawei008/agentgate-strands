import type { AgentAutoconfiguredEvent, AutoconfProgressEvent } from "../../types";
import AutoconfMeta from "./AutoconfMeta";
import DetailsFold from "./DetailsFold";

/** 态 saved / unchanged：绿 ✓ 已自动配置（含纯文本变体） */
export default function AutoconfSaved({
  r,
  progress,
  onManual,
}: {
  r: AgentAutoconfiguredEvent;
  progress: AutoconfProgressEvent[];
  onManual: (prefill?: { template?: string; responsePath?: string }) => void;
}) {
  return (
    <div className="autoconf-result" data-testid={`autoconf-${r.outcome}`}>
      <div className="verdict">
        <span className="vmark ok" aria-hidden="true">✓</span>
        <span className="vtext">
          {r.plaintext ? (
            <span className="vtitle">
              <span className="ok">已自动配置</span> · 该 Agent 返回纯文本，<b>整段作为输出</b>
              <span className="badge" style={{ marginLeft: 4 }}>
                <span className="dot" />无需路径
              </span>
            </span>
          ) : (
            <span className="vtitle">
              <span className="ok">已自动配置</span> · 响应路径{" "}
              <span className="pathchip" data-testid="autoconf-path">{r.response_path}</span>
              {r.confidence === "high" && (
                <span className="badge ok" style={{ marginLeft: 4 }}>
                  <span className="dot" />置信度高
                </span>
              )}
            </span>
          )}
          <span className="vsub">
            {/* 尾巴「配置已保存，可直接运行测试」「正式运行会把整段响应文本作为…」对任何
                结果恒成立 ⇒ 删，只留这一次推断的依据（prose-sweep 2026-09-03） */}
            {r.outcome === "unchanged"
              ? "本次推断与现有配置一致，未做修改"
              : r.plaintext
                ? "返回体不是 JSON，没有可提取的字段结构"
                : "在返回结构里找到唯一的长文本字段，且位于常见回答位置"}
          </span>
          <AutoconfMeta r={r} />
        </span>
        <span className="vact">
          <button
            className="btn-link"
            data-testid="autoconf-to-manual"
            onClick={() =>
              onManual({
                template: r.template,
                responsePath: r.plaintext ? "" : r.response_path ?? "",
              })
            }
          >
            ↺ 改为手动
          </button>
        </span>
      </div>
      <DetailsFold progress={progress} />
    </div>
  );
}
