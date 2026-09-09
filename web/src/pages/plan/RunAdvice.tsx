// 「本次建议」区（ADR-0014 §6，F2）：只聚合本次诊断产物，替换报告里
// ImprovementBlock 的原挂载（该组件已删：采纳追踪与「生成改进稿」入口在评估分析页
// pages/compare/AnalysisSections.tsx）。聚合是纯前端（reportRows.adviceGroups），
// 不发 LLM 调用；为什么自聚合见那边的注释（SDK 没有可用的 recommend 包）。
//
// 每条 = 修法文本（主体）+ fix_type badge（SDK 原词）+ 根因解释小字 +
// 引用 chips（点击 → 滚到全量表那一行并展开，行级跳转口子在 ReportView）。
// 没有条目就没有区（含「本次建议」标题）—— 空区块 = 废话。
//
// 采纳（后端 adopt_run_advice，本批新增的最小 additive action）：把这条修法
// 原文 + 引用落成该 run 的一条**已采纳** proposal（与改进稿同一持久化形状，
// 下次 run 的 adoption_note 零改动吃到）。采纳态就地显示「已采纳 · 时间」；
// 效果追踪不在这（评估分析页的辖区）。已落库的采纳跨会话可见：按
// source=run_advice + summary（同一套 300 字截断）在 proposals 里对回来。
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import type { ApiEvent } from "../../lib/api";
import { Icon } from "../../components/layout/Icons";
import { textOf } from "../../lib/renderText";
import type { AdviceEntry, AdviceGroup } from "./reportRows";
import type { RunProposal } from "./types";

/** adopt_run_advice 的回执（app/main.py 该分支）。 */
type AdviceAdoptedEvent = {
  event: "advice_adopted";
  run_key?: string;
  index?: number;
  proposal?: RunProposal | null;
};

/** summary 截断与后端同一上限（planrun.adopt_run_advice 照 attach_proposal 的
 *  `[:300]`）——跨会话对回已采纳条目时，比较的两边必须是同一套截断。 */
const SUMMARY_CLIP = 300;

/** 该修法已落库的采纳时间（空串 = 未采纳）。幂等键与后端同刑：
 *  source=run_advice 且 summary 全等。 */
function persistedAdoptedAt(proposals: RunProposal[], fix: string): string {
  for (const raw of proposals) {
    const p = (raw ?? {}) as Record<string, unknown>;
    if (p.source === "run_advice" && textOf(p.summary) === fix.slice(0, SUMMARY_CLIP)) {
      return textOf(p.adopted_at).trim();
    }
  }
  return "";
}

export default function RunAdvice({ advice, runKey, planId, proposals, stageLabelOf, onJumpToRow }: {
  advice: AdviceGroup[];
  runKey: string;
  /** 采纳成功后要失效的运行历史 queryKey 的第二段 */
  planId: string;
  /** 该 run 已落库的处方（detail.proposals）：跨会话对回已采纳的建议条目 */
  proposals: RunProposal[];
  /** 引用 chip 的环节名（ReportView 按 stageDisplayLabel 现算，含 D-5 侧别） */
  stageLabelOf: (groupIndex: number) => string;
  /** 引用 chip 点击 → 展开并滚到全量表那一行（行级跳转口子） */
  onJumpToRow: (groupIndex: number, rowKey: string) => void;
}) {
  const qc = useQueryClient();
  // 本会话采纳成功的（key = 修法文本）；历史采纳从 proposals 对回
  const [adoptedAt, setAdoptedAt] = useState<Record<string, string>>({});
  const [adopting, setAdopting] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (advice.length === 0) return null;

  async function onAdopt(entry: AdviceEntry, refLabels: string[]) {
    if (adopting != null) return; // 后端是读改写整个数组：一次只转一颗圈
    setAdopting(entry.fix);
    setErrors((m) => {
      const next = { ...m };
      delete next[entry.fix];
      return next;
    });
    try {
      const ev = await apiOne<AdviceAdoptedEvent & ApiEvent>({
        action: "adopt_run_advice", run_key: runKey, fix: entry.fix, refs: refLabels,
      }, "advice_adopted");
      const p = (ev.proposal ?? {}) as Record<string, unknown>;
      setAdoptedAt((m) => ({ ...m, [entry.fix]: textOf(p.adopted_at).trim() || "已采纳" }));
      // 运行历史里这条 run 的处方状态变了 → 失效列表查询。刻意**不**失效
      // ["plan_run", runKey]：采纳态本组件就地更新，重拉一次 get_plan_run
      // 等于为一个看不见的变化多读一趟 S3 归档（评估分析页的采纳追踪表同一取舍）。
      await qc.invalidateQueries({ queryKey: ["plan_runs", planId] });
    } catch (e) {
      setErrors((m) => ({ ...m, [entry.fix]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setAdopting(null);
    }
  }

  return (
    <section className="rt-advice" data-testid="run-advice">
      <h2 className="rd-part-h cjk">本次建议</h2>
      {advice.map((g) => (
        <div className="rt-advice-group" key={g.fixType} data-testid={`run-advice-group-${g.fixType}`}>
          <h3 className="rt-advice-gh cjk">{g.label}</h3>
          {g.entries.map((entry, i) => {
            const id = `run-advice-${g.fixType}-${i}`;
            const refLabels = entry.refs.map(
              (r) => `${stageLabelOf(r.groupIndex)} · ${r.rowName}`);
            const at = adoptedAt[entry.fix] ?? persistedAdoptedAt(proposals, entry.fix);
            return (
              <div className="rt-advice-item" key={entry.fix} data-testid={id}>
                <div className="head">
                  {/* fix_type badge：SDK RCAItem 原词（OTHERS 组里未知值原样可见） */}
                  <span className="badge badge-mono">{entry.fixType}</span>
                  <span className="spacer" />
                  {at ? (
                    <span className="rt-advice-adopted" data-testid={`${id}-adopted`}>
                      <Icon name="check" className="ic-sm" />
                      已采纳 · {at}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn ghost mini"
                      disabled={adopting != null}
                      data-testid={`${id}-adopt`}
                      onClick={() => void onAdopt(entry, refLabels)}
                    >
                      {adopting === entry.fix ? "标记中…" : "标记为已采纳"}
                    </button>
                  )}
                </div>
                <p className="fix" data-testid={`${id}-fix`}>{entry.fix}</p>
                {entry.explanations.map((why, wi) => (
                  <p className="why" key={wi} data-testid={`${id}-why-${wi}`}>{why}</p>
                ))}
                <div className="refs">
                  {entry.refs.map((r, ri) => (
                    <button
                      type="button"
                      className="rt-advice-ref"
                      key={`${r.groupIndex}:${r.rowKey}`}
                      data-testid={`${id}-ref-${ri}`}
                      onClick={() => onJumpToRow(r.groupIndex, r.rowKey)}
                    >
                      {refLabels[ri]}
                    </button>
                  ))}
                </div>
                {errors[entry.fix] && (
                  <p className="plan-editor-error" data-testid={`${id}-adopt-error`}>
                    {errors[entry.fix]}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
