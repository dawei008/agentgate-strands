// 评估计划页类型（形状照后端实测契约：list_recent_runs）。
//
// list_plans 一族（Plan / PlanStage / PlanLastRun / PlansEvent）与
// RunStageSummary 已搬到 lib/apiTypes.ts —— 大屏也消费它们，跨族契约不该住在
// 某一页目录下（simplify-r2 L6）。这里只留**评估计划页自己**读的 recent_runs 视图。
import type { RunStageSummary } from "../../lib/apiTypes";

export interface RunRow {
  run_key: string;
  plan_id: string;
  plan_name: string;
  agent_name: string;
  status: string; // completed | error | running | skipped
  score: number | null;
  started_at: string;
  duration_s: number | null;
  /** 后端键名是 total_cost_usd（planrun.py:_run_from_item）。此前本页侧
   *  声明为 cost_usd（大屏侧一直是对的），同一 action 两个页面两个键名——
   *  当时表格不渲染成本列所以不显形；批 plans-board 起「本月花费」列直接消费它。 */
  total_cost_usd?: number | null;
  stage_summaries?: RunStageSummary[];
}
export type RecentRunsEvent = {
  event: "recent_runs";
  runs: RunRow[];
};
