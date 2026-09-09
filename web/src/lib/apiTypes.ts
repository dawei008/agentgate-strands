// 跨页面族共用的后端契约类型（**type-only，零运行时**——编译后整个文件消失）。
//
// 为什么需要这一层（simplify-r2 L6）：同一个 action 的响应形状被两个以上页面族
// 消费时，类型不能住在其中一族的目录里——那会让另一族横向 import 一个「页面私有」
// 目录（bigscreen 引 workbench/types、resources 引 agents/types），目录含义与依赖
// 方向对不上，删/改那一页时先撞见外族的编译错误。
//
// 收录标准：**跨族消费**的后端事件形状。只有一族消费的视图类型留在该页 types.ts
//（如 list_recent_runs 的工作台视图 RunRow 仍在 pages/workbench/types.ts）。
// 同名不同形是刻意的：plan/types.ts 的 `Plan` 是编辑器侧的窄形态、agents/types.ts
// 的 `PlansEvent` 装的是 PlanSummary —— 各页只声明自己读的字段，不强行统一。
// 本文件里的是 **list_plans 出口的富形态**（app/main.py:_attach_plan_extras）与
// **discover 出口的全字段形态**。

// ---------- list_plans（工作台方案总表 + 大屏方案数/Agent 矩阵） ----------

export interface PlanStage {
  type: string; // observe | dataset | redteam
}
/** list_plans 出口 join 的「上次运行」（app/main.py:_attach_plan_extras）：
 *  该 plan 最新一条 PLANRUN 的摘要。带 stage_summaries 是硬要求——run 终态
 *  按环节判定（lib/scoring.ts runOutcome，UI-025），环节炸掉的 run 不能在
 *  方案表里显示成绿色「完成」。null = 从未运行。
 *  ⚠️ 后端只在 run 结束时落 PLANRUN item（planrun.py:_persist），进行中的
 *  run 不在该分区——所以线上 status 只会是 completed/error/skipped，
 *  「运行中」要等后端有 write-at-start 才可能出现（渲染路径已备好）。 */
export interface PlanLastRun {
  run_key: string;
  status: string;
  /** observe 综合分；纯回归/纯红队 run 恒 null（不代表失败，看环节） */
  score: number | null;
  finished_at: string | null;
  stage_summaries: RunStageSummary[];
}
/** 结果行的评分输入出身（testrun.SCORED_FROM_*；只用上报数据评估 ADR-0019 批 2 / 批 3）：
 *  "trace" = 按该会话 span 还原的对话判分；"response" 是枚举保留值（批 2 / 批 3 都不会出现，
 *  没有回退到返回的路径）。关着开关 / 老 run / 没判分的 no_trace 行整键缺失。
 *  · 回归用例行（批 2）：`output` 已是 trace 还原的最终回复，原返回在 `output_response`；
 *  · 红队攻击行（批 3）：`conversation` 已是 trace 还原的整段对话（judge 看的就是它），
 *    驾驭时的那份返回对话在 `conversation_response`；
 *  两者的 `response_matches_trace` 同义 = 返回与 trace 归一空白后是否逐字相等（红队按逐轮
 *  被测回复比，轮数不同即不一致），不一致**不改判**，界面只在格 title 上点明。 */
export type ScoredFrom = "trace" | "response";

export interface Plan {
  plan_id: string;
  name: string;
  agent_name: string;
  stages?: PlanStage[];
  /** 契约对象 {cron, budget_usd}（app/plan.py）；历史 DDB 可能残留旧字符串；null/缺省=仅手动 */
  schedule?: { cron: string; budget_usd: number } | string | null;
  /** 只用上报数据评估（ADR-0019 批 1，app/plan.py trace_required）：true = 回归 / 红队
   *  环节里 CloudWatch aws/spans 没有 Agent 上报 trace 的用例不评分。**默认开**（2026-09-08
   *  用户决定）：缺键 / null 都按 true，只有显式 false 才关（归一在 app/plan.py trace_required()）。
   *  批 2：开着时回归用例的评分输入是 span 还原的对话（行上 `scored_from` / `output_response` /
   *  `response_matches_trace`，见 ScoredFrom），不是 InvokeAgentRuntime 的返回。 */
  trace_required?: boolean;
  last_run?: PlanLastRun | null;
  /** list_plans 出口 join 的单次预估合计（planrun.estimate_plan_run，纯定义
   *  计算）；agent 不在册/估算失败 → null 显「—」。「超预算」由前端拿
   *  schedule.budget_usd 对比得出——后端没有 over_budget 键（旧 mock 幻觉）。 */
  estimated_cost_usd?: number | null;
}
export type PlansEvent = {
  event: "plans";
  plans: Plan[];
};

/** run 摘要里的环节汇总（list_recent_runs 契约，形状同 bigscreen/types.ts
 *  与 lib/scoring.ts StageLike，逐字照 planrun.py:_stage_summary）。
 *  工作台消费：红队字段（redteamHits KPI）+ 全部字段（run 终态按环节判定）。
 *  住这里是因为 PlanLastRun.stage_summaries 也要它（list_plans 通路）。 */
export interface RunStageSummary {
  type: string; // observe | dataset | redteam
  status?: string; // completed | error | empty
  /** empty 环节也带 error 文本（「最近 30 天没有可评估的会话」）——
   *  判失败必须先排除 empty，见 lib/scoring.ts isStageFailed */
  error?: string | null;
  /** observe */
  overall_mean?: number | null;
  /** dataset */
  pass_rate?: number | null;
  breached?: number;
  attacks?: number;
}

// ---------- discover（Agent 目录页 + 资源库两个生成表单的 Agent 下拉） ----------

export interface AgentSummary {
  agent_name: string;
  /** 后端字段名是 runtime_arn（discovery.py:61 / catalog.list_trace_sources）；
   *  全仓 `grep agent_arn app/` = 0 命中——agent_arn 是前端幻觉字段，已改正。
   *  可选：Langfuse 注册源给 ""（catalog.py），只有 AgentCore 源有真 ARN。 */
  runtime_arn?: string;
  description?: string;
  last_updated?: string;
  /** 接入来源：AgentCore Runtime 扫描（后端 discover 事件仍带此字段） */
  source?: "agentcore";
  /** 是否有运行时日志——无日志的 Agent 仅支持回归/红队（不能线上评估） */
  has_logs?: boolean;
}

export type AgentsEvent = {
  event: "agents";
  region: string;
  agents: AgentSummary[];
  from_cache: boolean;
  /** epoch 秒（真实后端）或已格式化字符串（部分接口）——渲染走 fmtTimeUtc */
  refreshed_at?: number | string;
}

// ---------- 坏例入数据集 + 人工标注（ADR-0017 D1 / D2，批 badcase-*） ----------
// 三个 action 由报告页（写）与数据集页（读 source）两族消费，故住这里。
// 形状与批 badcase-backend 内嵌的契约逐字同形；mock（handlers.ts）镜像它。

/** 数据集用例上的留痕（ADR-0017 D1）：这条用例来自哪一次 run 的哪一行 */
export interface CaseSource {
  run_key: string;
  /** 会话 = session_id；攻击 = 攻击名（与报告页矩阵行名同一个串） */
  row_key: string;
  kind: "session" | "attack";
  evaluators_failed: string[];
  score: number | null;
  human_score?: 0 | 0.5 | 1;
  /** ISO-8601 UTC */
  added_at: string;
}

/** append_dataset_cases 请求体里的一条用例 */
export interface IntakeCase {
  name: string;
  input: string;
  /** regression 集必填非空；redteam 集不要求（契约） */
  expected_output?: string;
  /** 仅红队：攻击目的。服务端同步写到 actor_goal（存量红队集读的是它），两键都存 */
  objective?: string;
  notes?: string;
  source: CaseSource;
}

export type DatasetCasesAppendedEvent = {
  event: "dataset_cases_appended";
  dataset: string;
  kind: "regression" | "redteam";
  added: number;
  updated: number;
  skipped_duplicates: number;
  case_count: number;
  /** 本次是否新建了数据集（create_if_missing 命中） */
  created: boolean;
};

/** 人工标注（ADR-0017 D2）：不改机器分，只并列显示 */
export interface CaseAnnotation {
  run_key: string;
  row_key: string;
  /** 评估器名，或 "overall" */
  evaluator: string;
  human_score: 0 | 0.5 | 1;
  label?: string | null;
  comment?: string | null;
  by: "manual";
  /** ISO-8601 UTC */
  at: string;
}

export type CaseAnnotatedEvent = {
  event: "case_annotated";
  annotation: CaseAnnotation;
};

export type AnnotationsEvent = {
  event: "annotations";
  run_key: string;
  items: CaseAnnotation[];
};

// ---------- agent_topology（ADR-0017 D4 · Agent 详情 ① 现状「路径」卡） ----------
// 与 topology-backend 同一份契约：近 lookback_days 天线上会话的 span 聚合成有向图。
// 节点命名与 transcript.py 一致：start / agent / tool:<name> / model:<id>。
// 0 会话 ⇒ nodes / edges 空 + unavailable_reason（前端不画空图）。

export type TopologyNodeKind = "start" | "agent" | "tool" | "model";

export interface TopologyNode {
  id: string;
  kind: TopologyNodeKind;
  /** 展示名（tool:bash ⇒ "bash"）；节点框仍写 id，label 只进 title */
  label: string;
  count: number;
  /** 平均时延（秒）；start / agent 这类无时长 span 为 null */
  avg_s: number | null;
  p95_s: number | null;
  errors: number;
  /** 该节点出现过的会话，按 at 倒序 ≤ 10（契约「会话级两件」）；不可用态 [] */
  recent_sessions: TopologyRecentSession[];
}

/** 节点详情「最近会话」一行：点开 = `#/run/<最近一次线上评估 run_key>?session=<session_id>` */
export interface TopologyRecentSession {
  /** 完整会话 id（深链用；界面显示短 id） */
  session_id: string;
  /** 该节点在该会话里首次出现的时刻，ISO UTC 秒级；start 节点 = 会话首个 span 时刻 */
  at: string | null;
  /** 该节点在该会话里所有访问的总耗时（秒，两位小数）；start 恒 null */
  duration_s: number | null;
  /** 该节点在该会话里至少一次访问报错 */
  failed: boolean;
}

/** 「按会话」高亮用：一条会话走过的完整节点序列 */
export interface TopologySessionPath {
  session_id: string;
  /** 会话首个 span 时刻 */
  at: string | null;
  /** 节点 id 序列（start 起，与 nodes[].id 同一套；同一节点走几次出现几次） */
  path: string[];
  /** 该会话里报过错的不同节点数 */
  failed_nodes: number;
}

export interface TopologyEdge {
  from: string;
  to: string;
  count: number;
}

export interface TopologyTopPath {
  /** 节点 id 序列（start 起） */
  nodes: string[];
  count: number;
  /** count / sessions，0..1 */
  share: number;
}

// type 而非 interface：apiOne<T extends ApiEvent> 要 Record<string, unknown> 的隐式索引签名
export type AgentTopologyEvent = {
  event: "agent_topology";
  agent_name: string;
  lookback_days: number;
  /** ISO-8601 UTC */
  window: { from: string; to: string };
  /** 与 ① 现状会话量同源（同一条 Logs Insights 查询）；nodes[start].count == sessions 构造上成立 */
  sessions: number;
  /** 取数的 span 源：日志组名（共享组再接 ` · service=…` / ` · scope=…`）；未配置 ⇒ null */
  sessions_source: string | null;
  /** 进程内 5 分钟缓存命中；请求带 refresh:true 绕过 */
  cached: boolean;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** 不可用时 null */
  top_path: TopologyTopPath | null;
  /** avg_s 最大的非 start 节点；没有任何节点有时长 ⇒ null */
  slowest: { id: string; avg_s: number } | null;
  /** 每会话一条完整路径，按 at 倒序 ≤ 10；不可用态 []（「按会话」高亮 = 单会话级拓扑） */
  session_paths: TopologySessionPath[];
  /** 非空即不可用态（nodes/edges 空、sessions 0）。五种原话：「未配置 span 源」/
   *  「近 N 天 Agent 未上报任何 span（含评估流量）」（窗内一条 span 都没有）/「近 N 天没有会话」（有 span 但
   *  当前 scope 里没会话）/「Logs Insights 查询失败：…」/「近 N 天 span 行数达到 Logs Insights 单次查询上限 10000，聚合不完整」 */
  unavailable_reason: string | null;
  /** 图里画的是哪类会话（请求 include_eval：省略 = 自动，真实 > 0 画真实、== 0 退到评估；true 两类一起；false 只真实）。
   *  评估流量 = 回归测试 / 红队测试 / 探针打出的会话（id 以 evaltest 开头） */
  sessions_scope: TopologySessionsScope;
  /** 窗内真实会话数（不看 scope；与 ① 现状会话量同式） */
  live_sessions: number;
  /** 窗内评估会话数（不看 scope） */
  eval_sessions: number;
  /** 窗内该 Agent 有没有任何 span（含评估流量）；false ⇒ 没接 OTel 上报 */
  agent_reports_spans: boolean;
  /** 这批 span 从哪个组读到的（app/tracesource.py 的 ORIGIN_CENTRAL / ORIGIN_RUNTIME_GROUP）：
   *  "central" = 配好的共享 span 组（aws/spans）· "runtime_group" = 退到 Agent 自己的 runtime 日志组 ·
   *  null = 这次一个组都没读到（无观测源 / 查询失败 / 截断）。后端 topology.py 恒带此键；
   *  `?` 是给旧后端留的余地（v0.40 前不发）。 */
  span_origin?: "central" | "runtime_group" | null;
};

export type TopologySessionsScope = "live" | "eval_only" | "live+eval";

// ---------- 同题配对 + 会话并排 diff（ADR-0017 D3 / F8，批 compare-frontend） ----------
// 两个 action 由评估分析页（配对表 + 双栏 diff）与报告页（单栏回放组件复用）两族消费，
// 故住这里。形状与批 compare-backend 内嵌的契约逐字同形；mock（handlers.ts）镜像它。

/** 一个评估器在一侧的判定（配对表格里的分 + 过/不过；理由只在 session_compare 里） */
export interface PairResult {
  score: number | null;
  passed: boolean | null;
}

/** pair_rows 的一行：两次 run 里同一道题（回归按 input、线上按用户首句对齐）。
 *  单侧无同题 ⇒ 那侧 row_key 与 results 都是 null。顺序：已对齐 → 左独有 → 右独有。 */
export interface RowPair {
  align_key: string;
  left_row_key: string | null;
  right_row_key: string | null;
  left_results: Record<string, PairResult> | null;
  right_results: Record<string, PairResult> | null;
}

export type RowPairsEvent = {
  event: "row_pairs";
  pairs: RowPair[];
  /** 两侧都有的行数 */
  aligned: number;
  total: number;
};

/** transcript.events 一条（app/transcript.py）：user / assistant / tool */
export interface SessionEvent {
  n: number;
  type: string;
  /** 归档无时间戳（多轮回归 / 红队对话）⇒ null：时间线按序号等距排、不画刻度 */
  t_offset_s: number | null;
  text?: string | null;
  /** 仅 tool */
  name?: string | null;
  duration_s?: number | null;
  error?: string | null;
  /** 后端截 300 字的字符串（sessioncompare.py）；归档原物是对象 —— 两种形态都要能渲 */
  arguments?: unknown;
  result?: unknown;
}

/** 属性表的八项键（attribute_total = 8）；值 null = 那侧没记 */
export interface SessionAttributes {
  model: string | null;
  "tokens.input": number | null;
  "tokens.output": number | null;
  llm_calls: number | null;
  tool_calls: number | null;
  "latency.avg_s": number | null;
  "cost.usd": number | null;
  system_prompt: string | null;
}

export interface SessionSideResult extends PairResult {
  label: string | null;
  reason: string | null;
}

/** session_compare 的一侧（单栏回放组件吃的也是这一份） */
export interface SessionSide {
  run_key: string;
  row_key: string;
  stage_type: string;
  started_at: string | null;
  /** 该 run 在计划运行历史里的序号（#N）；不知道时 null */
  run_index: number | null;
  events: SessionEvent[];
  attributes: SessionAttributes;
  results: Record<string, SessionSideResult>;
}

export type TextDiffOp = { op: "equal" | "delete" | "insert"; text: string };

export interface AttributeDiff {
  key: string;
  left: unknown;
  right: unknown;
  change: "added" | "removed" | "modified";
  /** 只有 system_prompt 这类长文本带：行内字级 diff */
  text_diff?: TextDiffOp[];
}

export type SessionCompareEvent = {
  event: "session_compare";
  left: SessionSide;
  right: SessionSide;
  /** 只列有差异的属性 */
  attribute_diff: AttributeDiff[];
  attribute_total: number;
  aligned: boolean;
  align_key: string;
};
