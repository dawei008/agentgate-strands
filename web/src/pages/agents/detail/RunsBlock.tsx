// ② 运行历史区块：该 Agent 最近 RUNS_LIMIT 次 run（跨全部评估计划），每条 → 运行报告。
export const RUNS_LIMIT = 20;
import { useQuery } from "@tanstack/react-query";
import { apiOne } from "../../../lib/api";
import { effectiveScore, fmtDuration, fmtScore, runBadge } from "../../../lib/scoring";
import { navigate } from "../../../router";
import { fmtRunTime } from "../../../lib/time";
import type { RecentRunsEvent, RunSummary } from "../types";

/** 结果 badge 单元格：口径全部来自 lib/scoring.ts runBadge（run 摘要含
 *  stage_summaries 时按环节判定，缺失时退回顶层 score 的旧行为）。 */
function RunBadgeCell({ run }: { run: RunSummary }) {
  const badge = runBadge({
    status: run.status,
    score: run.score ?? null,
    stage_summaries: run.stage_summaries,
  });
  return (
    <span className={badge.cls} data-testid={`agent-run-row-${run.run_key}-badge`}>
      <span className="dot" aria-hidden="true" />
      {badge.label}
    </span>
  );
}

/** 版本 chip：**这一次运行时**的版本标签（run 自己的快照，落库那一刻由
 *  planrun.py:_planrun_item 冻结；list_recent_runs 的 ProjectionExpression 带着它）。
 *
 *  绝不读 Agent 的**当前**标签（discover 的 version_label）—— 事后改标签不许改动
 *  历史 run 的归属（护栏 1，与趋势竖线、方案详情 run 行同一条）。老 run 没有这个
 *  快照（旧数据不修、不回填）→ 整个 chip 不画，绝不画一个空 chip。
 *
 *  摆在结果 badge **外面**，与方案详情页 run 行逐字同形：badge 里装的是指标 chip
 *  （均分/通过率/攻破数），版本不是指标 —— 混进去会被读成又一个数字。 */
function RunVersionChip({ run }: { run: RunSummary }) {
  const version = (run.agent_version_label ?? "").trim();
  if (!version) return null;
  return (
    <span
      className="badge badge-mono plan-run-version"
      data-testid={`agent-run-row-${run.run_key}-version`}
    >
      {version}
    </span>
  );
}

export default function RunsBlock({ name }: { name: string }) {
  const query = useQuery({
    queryKey: ["recent_runs", name],
    queryFn: () =>
      apiOne<RecentRunsEvent>(
        { action: "list_recent_runs", agent_name: name, limit: RUNS_LIMIT },
        "recent_runs",
      ),
  });
  return (
    <div className="agent-detail-block" data-testid="agent-runs-block">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
        <h3 style={{ flex: 1 }}>运行历史</h3>
        <button
          className="btn-link"
          data-testid="agent-runs-all"
          onClick={() => navigate("#/workbench")}
        >
          查看全部 →
        </button>
      </div>
      {query.isLoading ? (
        <p className="agent-detail-empty">加载中…</p>
      ) : query.isError ? (
        <p className="agents-error">
          {query.error instanceof Error ? query.error.message : String(query.error)}
        </p>
      ) : !query.data || query.data.runs.length === 0 ? (
        <p className="agent-detail-empty" data-testid="agent-runs-empty">还没有运行记录。</p>
      ) : (
        <table className="u-table" data-testid="agent-runs-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>计划</th>
              <th>开始时间</th>
              <th className="num-cell">分数</th>
              <th className="num-cell">耗时</th>
            </tr>
          </thead>
          <tbody>
            {query.data.runs.map((r) => (
              <tr
                key={r.run_key}
                className="plan-row-link"
                data-testid={`agent-run-row-${r.run_key}`}
                onClick={() => navigate(`#/report/${encodeURIComponent(r.run_key)}`)}
              >
                <td>
                  {/* 口径统一（lib/scoring.ts runOutcome，ADR-0003 修订）：按环节
                      判定——纯回归/纯红队跑成功也是「完成」，有环节炸了走
                      「部分失败」/「失败」，与计划详情页/工作台一致 */}
                  <RunBadgeCell run={r} />
                  <RunVersionChip run={r} />
                </td>
                <td>
                  {/* a11y：行点击对键盘不可达——计划名升为 btn-link（Tab 可达，行为同行点击） */}
                  <button
                    className="btn-link"
                    data-testid={`agent-run-row-${r.run_key}-open`}
                    onClick={() => navigate(`#/report/${encodeURIComponent(r.run_key)}`)}
                  >
                    {r.plan_name}
                  </button>
                </td>
                <td className="agents-name">{fmtRunTime(r.started_at)}</td>
                {/* 取值走 effectiveScore（不是 r.score）：8/21 之前落库的 run 顶层
                    score 为 null、分在 observe 环节 overall_mean 里 —— 直读会让这一列
                    显示「—」，而同页 KPI 已经把它计入了（同一页两个数打架）。
                    真没有分（纯回归/纯红队/空转）仍是「—」，不伪造 0。 */}
                <td className="num-cell">{fmtScore(effectiveScore(r))}</td>
                <td className="num-cell">{fmtDuration(r.duration_s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
