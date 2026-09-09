// Agent 目录/详情页共享类型 —— 形状与后端契约（app/main.py）一一对应。
//
// discover 一族（AgentSummary / AgentsEvent）已搬到 lib/apiTypes.ts：资源库的
// 两个生成表单也消费它，跨族契约不该住在某一页目录下（simplify-r2 L6）。

// ---------- Agent 身份：显示名 + 版本标签（discover 出口的 overlay 字段） ----------
//
// 后端 catalog.apply_agent_meta 给 discover 的**每一行**都叠这两个键（没标注过 =
// 空串，所以消费方不必判 undefined；这里仍写成可选，是为了容纳本批之前发布的
// 后端 —— 前端可能比后端先上）。
//
// 为什么住在这里而不是 lib/apiTypes.ts：只有 Agent 这一族消费它们（方案页的版本
// 来自 run **快照** agent_version_label，是另一个字段），按 apiTypes.ts 头部的收录
// 标准「只有一族消费的视图类型留在该页 types.ts」。哪天工作台/大屏也要显示名，
// 再连同 AgentSummary 一起搬过去。
export interface AgentIdentity {
  /** 用户标注的显示名；空串 = 没标注 → 显示原名（取名一律走 lib/agentName） */
  display_name?: string;
  /** 用户标注的版本标签（默认取 discovery 的 runtime 版本，读得到就填）；
   *  空串 = 没标注 → 不画版本 chip。**不是** run 快照里的那一个：
   *  这是 Agent 的**当前**标签，历史 run 的归属看 run.agent_version_label。 */
  version_label?: string;
}

/** discover 一行的完整消费形态（discovery 字段 + 身份 overlay）。
 *  名字刻意不叫 AgentRow —— 列表页那个 `<AgentRow>` 是渲染组件，同名会读串。 */
export type AgentItem = import("../../lib/apiTypes").AgentSummary & AgentIdentity;

/** discover 事件的 Agent 族形态（agents 元素带身份 overlay） */
export type AgentsRowsEvent =
  Omit<import("../../lib/apiTypes").AgentsEvent, "agents"> & { agents: AgentItem[] };

/** set_agent_meta 回执（app/main.py 的 agent_meta_set 分支）。
 *  agent_name 原样回来 —— 关联键从不因为改显示名而变（护栏 2）。 */
export type AgentMetaSetEvent = {
  event: "agent_meta_set";
  agent_name: string;
  display_name: string;
  version_label: string;
  updated_at: number;
};

export interface PlanSummary {
  plan_id: string;
  name: string;
  agent_name: string;
  updated_at: number;
  stages?: { type: string }[];
  schedule?: unknown;
}

export type PlansEvent = {
  event: "plans";
  plans: PlanSummary[];
}

export interface RunSummary {
  run_key: string;
  plan_id: string;
  plan_name: string;
  agent_name: string;
  status: string; // completed | error | skipped
  /** 顶层分 = observe 环节均分；纯回归/纯红队 run 恒 null（见 lib/scoring.ts） */
  score?: number | null;
  started_at?: string;
  duration_s?: number | null;
  /**
   * **这一次运行时**该 Agent 的版本标签（run 快照，落库那一刻由
   * app/planrun.py:_planrun_item 冻结，`list_recent_runs` 的 ProjectionExpression
   * 带着它 —— 漏投影不会报错，只会让这个 feed 里的版本悄悄恒为空）。
   *
   * ⚠️ 与上面 AgentIdentity.version_label（Agent 的**当前**标签）是两个字段，绝不
   * 混用：事后改标签不许改动历史 run 的归属（护栏 1）。run 行的版本 chip 一律只读
   * 这里。本功能之前落库的 run 没有这个字段（旧数据不修）→ null，展示侧不画 chip。
   */
  agent_version_label?: string | null;
  /** 环节摘要（list_recent_runs 的 _run_from_item 总是带）——run 终态按环节
   *  判定的原料，形状见 lib/scoring.ts StageLike。 */
  stage_summaries?: {
    type?: string;
    status?: string;
    error?: string | null;
    overall_mean?: number | null;
    pass_rate?: number | null;
    attacks?: number;
    breached?: number;
  }[];
}

export type RecentRunsEvent = {
  event: "recent_runs";
  runs: RunSummary[];
}

export type AgentConfigEvent = {
  event: "agent_config";
  agent_name: string;
  payload_template: string;
  response_path: string;
  /** epoch 秒——配置最后更新时间（v47 起后端携带） */
  updated_at?: number | null;
  /** 配置来源："auto" 自动推断落库 | "manual" 手动保存 | null 未配置过 */
  configured_by?: "auto" | "manual" | null;
}

export type AgentConfigSetEvent = {
  event: "agent_config_set";
  agent_name: string;
}

/** flatten_response 的可选路径条目（app/probe.py） */
export interface ProbePathEntry {
  path: string;
  response_path: string | null;
  type: string;
  preview?: string;
  is_whole_response?: boolean;
}

export type InvokeProbedEvent = {
  event: "invoke_probed";
  agent_name: string;
  ok: boolean;
  error?: string | null;
  request_payload?: unknown;
  response_raw?: string | null;
  response_bytes?: number;
  response_raw_truncated?: boolean;
  response_paths?: ProbePathEntry[];
  response_paths_truncated?: boolean;
  response_path_used?: string | null;
  response_path_from?: string | null;
  extracted_text?: string | null;
  latency_ms?: number;
  /**
   * True = 响应是纯文本（非 JSON）。这是**成功**形态，不是失败：
   * 正式运行把整段文本当输出，response_path 留空即可。
   * 后端此时给 ok=true / error=null / response_paths 为空（见 app/probe.py）。
   */
  plain_text?: boolean;
}

// ---------- 自动推断（action: auto_configure_agent，v47 后端契约） ----------

/** 每试完模板池里一个模板发一条（流式进度帧） */
export type AutoconfProgressEvent = {
  event: "autoconf_progress";
  agent_name: string;
  template: string;
  ok: boolean;
  error?: string | null;
  latency_ms?: number;
};

/** failed 态的尝试明细条目（终态事件里的 attempts[]） */
export interface AutoconfAttempt {
  template: string;
  ok: boolean;
  error?: string | null;
  latency_ms?: number;
}

/** candidates 态的候选条目（≤4 条） */
export interface AutoconfCandidate {
  response_path: string;
  preview?: string;
  length?: number;
  reason?: string;
}

/** confirm_overwrite 态里的现有/建议配置 */
export interface AutoconfCurrentConfig {
  payload_template: string;
  response_path: string;
  updated_at?: number | null;
  configured_by?: "auto" | "manual" | null;
}
export interface AutoconfProposedConfig {
  payload_template: string;
  response_path: string;
  plaintext?: boolean;
}

/**
 * 终态事件（agent_autoconfigured），outcome 五分派：
 *   saved             已自动落库（首次配置，高置信）
 *   unchanged         推断与现有一致，未动
 *   confirm_overwrite 与现有不同，不落库，等用户确认后前端调 set_agent_config
 *   candidates        低置信多候选，等用户单选后调 set_agent_config
 *   failed            全部模板失败
 */
export type AgentAutoconfiguredEvent = {
  event: "agent_autoconfigured";
  agent_name: string;
  outcome: "saved" | "unchanged" | "confirm_overwrite" | "candidates" | "failed";
  attempts_total?: number;
  // saved / unchanged
  confidence?: "high" | "low";
  response_path?: string;
  template?: string;
  latency_ms?: number;
  response_bytes?: number;
  /** True = 目标返回纯文本，response_path 为空、整段作为输出 */
  plaintext?: boolean;
  // confirm_overwrite
  current?: AutoconfCurrentConfig;
  proposed?: AutoconfProposedConfig;
  // candidates / failed
  candidates?: AutoconfCandidate[];
  attempts?: AutoconfAttempt[];
  error?: string | null;
};
