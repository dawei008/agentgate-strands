// 大屏页类型（形状照后端实测契约 app/planrun.py：list_recent_runs 的
// run 摘要带 stage_summaries——大屏的分数/通过率/攻破全部由此推导）。
export interface StageSummary {
  type: string; // observe | dataset | redteam
  status?: string; // completed | error | empty
  error?: string;
  // observe
  overall_mean?: number | null;
  sessions?: number;
  // dataset
  pass_rate?: number | null;
  cases?: number;
  blank_cases?: number;
  // redteam：verdict 可为 null（后端 _stage_summary 直取 res.get("verdict")，
  // n_judged=0 时是 INCONCLUSIVE、老数据/抢救路径是 None）——判定不许依赖它
  breached?: number;
  attacks?: number;
  verdict?: string | null;
}

export interface BigscreenRun {
  run_key: string;
  plan_id: string;
  plan_name: string;
  agent_name: string;
  status: string; // completed | error | running | skipped
  /** 顶层分（后端 _run_from_item 提供）；stage_summaries 缺失时的兜底口径 */
  score?: number | null;
  started_at: string;
  duration_s: number | null;
  total_cost_usd?: number | null;
  skip_reason?: string | null;
  stage_summaries?: StageSummary[];
}

export type BigscreenRunsEvent = {
  event: "recent_runs";
  runs: BigscreenRun[];
};
