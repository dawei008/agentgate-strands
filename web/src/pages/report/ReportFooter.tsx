// ⑧ 页脚：导出报告 / 与上次对比 / 查看 trace（无数据时换成查看计划设置）/ 上一 run · 下一 run。
// 逻辑与 testid 沿用 ReportView 的底部操作条（report-drawer-*）：抽屉与本页是同一份报告
// 的两个入口，页脚动作在两处必须是同一个东西。
import { Icon } from "../../components/layout/Icons";
import { navigate } from "../../router";
import type { PlanRunSummary } from "../plan/types";

export default function ReportFooter({
  exporting, exportBlocked, exportError, onExport,
  compareBlocked, onCompare, noData, planId, runKey, older, newer, onNavigate,
  intakeLabel = null, onIntakeAll,
}: {
  exporting: boolean;
  exportBlocked: string | null;
  exportError: string | null;
  onExport: () => void;
  compareBlocked: string | null;
  onCompare?: () => void;
  noData: boolean;
  planId: string;
  runKey: string;
  older: PlanRunSummary | null;
  newer: PlanRunSummary | null;
  onNavigate: (runKey: string) => void;
  /** 批量入集入口文案（ADR-0017 D1；badcase.intakeEntryLabel）：「从 N 个未过会话中选择加入数据集…」
   *  —— 省略号表示点了会打开选择抽屉、默认不勾任何行；null = 本次没有坏例 ⇒ 不画 */
  intakeLabel?: string | null;
  onIntakeAll?: () => void;
}) {
  return (
    <div className="rpg-foot" data-testid="report-drawer-foot">
      <button
        type="button"
        className="btn"
        disabled={exporting || exportBlocked != null}
        title={exportBlocked ?? undefined}
        data-testid="report-drawer-export"
        onClick={onExport}
      >
        <Icon name="download" className="ic-sm" />{exporting ? "导出中…" : "导出报告"}
      </button>
      {exportError && (
        <span className="plan-editor-error" data-testid="report-drawer-export-error">
          导出失败：{exportError}
        </span>
      )}
      {onCompare && (
        <button
          type="button"
          className="btn ghost"
          disabled={compareBlocked != null}
          title={compareBlocked ?? undefined}
          data-testid="report-drawer-compare"
          onClick={onCompare}
        >
          与上次对比
        </button>
      )}
      {noData ? (
        <button
          type="button"
          className="btn ghost"
          data-testid="report-drawer-settings"
          onClick={() => navigate(`#/plan/${encodeURIComponent(planId)}/edit`)}
        >
          查看计划设置
        </button>
      ) : (
        <button
          type="button"
          className="btn ghost"
          data-testid="report-drawer-trace"
          onClick={() => navigate(`#/run/${encodeURIComponent(runKey)}`)}
        >
          <Icon name="ext" className="ic-sm" />查看 trace
        </button>
      )}
      {intakeLabel && onIntakeAll && (
        <button
          type="button"
          className="btn ghost"
          data-testid="report-intake-all"
          onClick={onIntakeAll}
        >
          {intakeLabel}
        </button>
      )}
      <span className="spacer" />
      <nav className="rpg-pager" aria-label="相邻 run">
        <button
          type="button"
          className="btn ghost"
          disabled={!older}
          title={older ? older.run_key : "没有更早的 run"}
          data-testid="report-drawer-prev"
          onClick={() => older && onNavigate(older.run_key)}
        >
          <Icon name="chev-l" className="ic-sm" />上一 run
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!newer}
          title={newer ? newer.run_key : "没有更新的 run"}
          data-testid="report-drawer-next"
          onClick={() => newer && onNavigate(newer.run_key)}
        >
          下一 run<Icon name="chev-r" className="ic-sm" />
        </button>
      </nav>
    </div>
  );
}
