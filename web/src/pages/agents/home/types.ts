// 首页（Agent 总览 · 观测视角）的数据契约 —— 形状与后端 `fleet_status` / `agent_status`
// 同刑（docs/payload-contract.md「agent_status」小节 + 主会话 2026-09-03 增补的
// fleet_status 形状）。算不出的项一律 null，原因在 unavailable_reason，前端显示「—」不编数。

/** 一个数 + 前一个同长窗 + 差值（任一侧 null 则 delta null） */
export interface MetricPair {
  value: number | null;
  prev: number | null;
  delta: number | null;
}

/** 24 桶逐小时会话量（无数据的桶为 0；日志组不可用时整个数组为 `[]` ⇒ 不画曲线） */
export interface HourlyBucket {
  hour: string;
  sessions: number;
}

export interface AgentStatusMetrics {
  sessions: MetricPair & { hourly?: HourlyBucket[] };
  p95_latency_ms: MetricPair;
  agent_cost_usd: MetricPair;
  blank_rate: MetricPair;
  tool_failure_rate: MetricPair;
}

/** 最近一次**已结束**的 run（running 不算）；没有 ⇒ null */
export interface AgentLastRun {
  run_key: string;
  plan_id: string;
  plan_name: string;
  status: string;
  observe_mean: number | null;
  dataset_pass: string | null;
  dataset_pass_rate: number | null;
  redteam_blocked: string | null;
  finished_at: string | null;
}

/** 唯一一种告警：同一计划最近连续 ≥3 次 completed run 里某评估器都低于目标线 */
export interface EvaluatorAlert {
  kind: "evaluator_below_target";
  plan_id: string;
  plan_name: string;
  evaluator: string;
  target: number;
  streak: number;
  values: number[];
  since_run: string;
  until_run: string;
}

/** 带定时的计划里最早的一次；`at` null = 推不出（rate(...) 相位由 EventBridge 定） */
export interface NextRun {
  plan_id: string;
  plan_name: string;
  at: string | null;
  budget_usd: number | null;
}

export interface AgentStatus {
  event?: string;
  agent_name: string;
  window_hours: number;
  metrics: AgentStatusMetrics;
  last_run: AgentLastRun | null;
  alerts: EvaluatorAlert[];
  next_run: NextRun | null;
  cloudwatch_url: string | null;
  unavailable_reason: Record<string, string>;
}

export type AgentStatusEvent = AgentStatus & { event: "agent_status" };

/** 舰队级聚合（hero 带的数据源） */
export interface FleetSummary {
  agents: number;
  sessions: MetricPair;
  cost_usd: MetricPair;
  worst_p95: { agent_name: string; value_ms: number } | null;
  anomaly_rate: MetricPair;
  hourly: HourlyBucket[];
}

export type TodoKind =
  | "tool_failure_spike" | "blank_spike" | "budget" | "run_failed" | "evaluator_below_target";

/** 待处理一条：后端已按 observe 在前、evaluate 在后排好，前端不重排 */
export interface TodoItem {
  kind: TodoKind;
  layer: "observe" | "evaluate";
  agent_name: string;
  /** 一句带数字的事实（后端写，只说这一次） */
  fact: string;
  action: "view" | "run" | "adopt";
  target: { plan_id?: string | null; run_key?: string | null };
}

export type FleetStatusEvent = {
  event: "fleet_status";
  window_hours: number;
  /** 五个数真正算出来的时刻（缓存命中时不变）——「数据时刻」用它 */
  computed_at: string;
  /** 老键名，与 computed_at 同值（页头时间窗仍读它） */
  generated_at: string;
  cached: boolean;
  /** 距 computed_at 的整秒数；未命中恒 0。进程内缓存 TTL 300s ⇒ 结构上 ≤ 300 */
  cache_age_s: number;
  agents: AgentStatus[];
  fleet: FleetSummary;
  todo: TodoItem[];
  /** 落进这里的 Agent：哪个数算不出、为什么（与 agents[].unavailable_reason 同源） */
  unavailable: Record<string, Record<string, string>>;
};

/** discover 超龄自动重扫的结果（契约 payload-contract discover 节）：
 *  null = 没触发（目录未超 24h / refresh:true / 首扫）；attempted:false = 上次失败后 300s 防抖期内 */
export type CatalogRefresh = { attempted: boolean; ok: boolean; error: string | null };

/** Freshness 只读 discover 响应里的这三个键（旧后端没有 catalog_refresh ⇒ 可选） */
export type CatalogFreshnessInput = {
  from_cache: boolean;
  refreshed_at?: number | string;
  catalog_refresh?: CatalogRefresh | null;
};
