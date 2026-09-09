// 方案域类型：形状照后端契约（app/main.py，实测可信）。
// 编辑器数据源（evaluators/datasets/agents）独立声明轻量形状，避免跨页耦合。

export type StageType = "observe" | "dataset" | "redteam";

export interface PlanStage {
  type: StageType;
  evaluators: string[];
  /** dataset 环节：回归数据集名或模拟集名（UI 四类/存储三类，靠集合归类区分卡片） */
  dataset?: string;
  /** redteam 环节：kind=redteam 用例集名 */
  cases_dataset?: string;
  /** observe 环节：从最近 N 天的线上会话中抽样（后端默认 30，1-120） */
  lookback_days?: number;
  /** observe 环节：单次运行最多评估的会话数——按会话计费的成本闸门（后端默认 10，1-50） */
  max_sessions?: number;
  /** observe 环节：是否包含 evaltest- 前缀的平台回归测试会话（后端默认 false） */
  include_test?: boolean;
  /** observe 环节：零成本 trace 指标（tokens/cost/latency/…），与 evaluators 并列 */
  metrics?: string[];
  /** redteam 环节：攻击策略名单（planrun.py:93/251 直接读 PlanStage 上的该字段）。
      缺失/空数组 = 跟随后端默认名单（DEFAULT_STRATEGIES），不要预填显式选中 */
  strategies?: string[];
  /** 仅表现层：[+ 模拟测试] 加的空卡在选集合前显示为模拟卡；保存前剥掉，不进存储 */
  _ui?: "simulation";
  [k: string]: unknown;
}

/** 定时契约（app/plan.py:109-117）：启用定时必须带单次预算上限——
    定时触发时无人在场确认成本，budget_usd 是成本闸门，后端强制 >0。 */
export interface PlanSchedule {
  /** EventBridge cron(...)/rate(...) 形态（保存前由 normalizeSchedule 归一） */
  cron: string;
  /** 单次预算上限（USD，>0）；存量字符串数据回填时暂置 0，保存前必须补 */
  budget_usd: number;
}

export interface Plan {
  plan_id: string;
  name: string;
  agent_name: string;
  stages?: PlanStage[];
  /** null/缺省 = 仅手动。历史 DDB 可能残留旧字符串形态，读侧需兼容回填 */
  schedule?: PlanSchedule | string | null;
  /** 只用上报数据评估（ADR-0019，app/plan.py trace_required()）：2026-09-08 起默认开——后端读侧
   *  恒给 bool；前端若遇缺键（旧缓存）也按开渲染；只有显式 false 才关 */
  trace_required?: boolean;
  updated_at?: number;
}

/** 只用上报数据评估的环节汇总（planrun.py:_stage_summary，**只有开了 trace_required 的
 *  回归 / 红队环节有**；老 run 与关着开关的 run 缺键——形状不变）。 */
export interface TraceSummary {
  required: boolean;
  ok: number;
  no_trace: number;
}

/** 消费点统一读法：对象读 .cron，旧字符串原样，null/缺省返回空串（显示层判空回退） */
export function scheduleCron(raw: Plan["schedule"]): string {
  if (!raw) return "";
  return typeof raw === "string" ? raw : (raw.cron ?? "");
}

export type PlansEvent = {
  event: "plans";
  plans: Plan[];
}

export type PlanSavedEvent = {
  event: "plan_saved";
  plan: Plan;
  scheduled?: boolean;
  schedule_error?: string | null;
}

export type PlanDeletedEvent = {
  event: "plan_deleted";
  plan_id: string;
}

// ---------- 运行历史 ----------
export interface PlanRunSummary {
  run_key: string;
  /** completed | error | skipped | running */
  status: string;
  /** 顶层综合分 = **observe 环节均分**（planrun.py:_persist 只在有 observe
   *  overall_mean 时写）。纯回归/纯红队 run 恒为 null —— 判「成功」要看
   *  stage_summaries，不是这个字段（ADR-0003 修订 / UI-013）。 */
  score: number | null;
  started_at: string | number | null;
  duration_s: number | null;
  triggered_by?: string | null;
  skip_reason?: string | null;
  /** 环节摘要（list_plan_runs 的 _run_from_item 总是带，老归档可能是空数组）。
   *  run 终态按环节判定的原料，形状见 lib/scoring.ts StageLike。 */
  stage_summaries?: StageSummary[];
  /**
   * **这一次运行时**该 Agent 的版本标签（快照，落库那一刻由
   * app/planrun.py:_planrun_item 冻进 run 记录）。
   *
   * ⚠️ 与 Agent 的**当前**标签（discover 的 version_label）是两个字段，绝不混用：
   * 事后改标签不许改动历史 run 的归属 —— 趋势的版本变更竖线、run 行与抽屉头的
   * 版本 chip 一律只读这里（护栏 1）。
   * 本功能之前落库的 run **没有**这个字段（旧数据不修）→ null，显示侧不画 chip。
   */
  agent_version_label?: string | null;
  /** 同上快照的另一半：这一次运行时的 runtime ARN（老 run 为 null）。 */
  agent_runtime_arn?: string | null;
  /**
   * 这条 running 的执行进程是否已可判定停止（UI-029 批 2/3）。
   *
   * **判定只在后端一份**：`app/stalecheck.py:is_stale` 的三级判据（心跳 →
   * 预估时长 → 8h 天花板），读侧 `_run_from_item` 读时算好附上来。前端**零判定
   * 逻辑、只消费这个布尔** —— 自己再算一遍就等于把判据抄成第二份（reaper、
   * 读侧、将来的并发闸门共用的正是那一份）。
   * 终态 run 恒 false（is_stale 自己看 status）。展示：陈旧 running 显示中性
   * 「疑似中断」（lib/scoring.STALE_RUNNING_BADGE）；**改判落库归 reaper**，
   * 前端只显示。缺键（更老的响应）按 false 处理，绝不自己补判。
   */
  stale?: boolean;
  /**
   * 执行侧最近一次心跳的秒级 epoch（批 1：每 60s 条件写在 run 记录上）。
   * 只有**新** running 有；老 run / 终态 run 一律 null（终态整条 put_item 不携带
   * 中途字段）→ 展示侧整段不画（旧数据不修：不显示、不伪造 —— 补 0 会印出
   * 「最后心跳 56 年前」）。
   */
  heartbeat_epoch?: number | null;
  /** 环节进度（批 1 在每个环节边界写）；缺失 = 老 run 或还没跑完第一个环节。 */
  progress?: PlanRunProgress | null;
  /**
   * 最近一个环节检查点的 S3 对象键 —— 「从检查点重试」入口的**唯一判据**
   * （批 4，与终态 status 一起看：pages/plan/resume.isResumable）。
   *
   * 现实里终态记录上还有这个键 = reaper 改判那一族（`_reap_write` 是 update 只补
   * 终态与原因，指针原样留着）；走整条 put_item 的终态路径覆盖即清场 —— 所以
   * completed 与老 run 天然没有它，入口自然不出现（旧数据不修的展示侧降级）。
   * 键里的 `stage-<i>` 就是这份检查点的已完成环节数（确认卡上「从第 N 个环节
   * 继续」与金额切片都读它，见 resume.checkpointStagesDone）。
   */
  checkpoint_s3_key?: string | null;
  /** 挂在这条 run 上的处方（list_plan_runs 的 _run_from_item 无条件带；
   *  list_recent_runs 投影刻意不带）。采纳追踪 / 台账采纳格读它。 */
  proposals?: RunProposal[] | null;
  /**
   * 问题台账（ADR-0016 ③）。list_plan_runs 每行都带；老 run / 无诊断产物的 run
   * 为 `[]`（不是 null）⇒ 前端回落到两段散文卡。list_recent_runs 投影里恒为 []。
   */
  synthesis_issues?: SynthesisIssue[] | null;
}

/**
 * 运行中 run 的环节进度（后端 `app/planrun.py:_write_stage_checkpoint` 的
 * `progress` 字面量，以 JSON 串存库、读侧解析成对象）。
 *
 * ⚠️ `stage` 是**刚结束**那个环节的类型，不是「正在跑的环节」——进度只在环节
 * 边界写，写的那一刻下一环还没开始。所以文案只说「已完成 X/N 环节 · 最近完成
 * <名>」（derive.stageProgressText），说成「正在跑 X」就是编。
 */
export interface PlanRunProgress {
  stages_done?: number;
  stages_total?: number;
  stage?: string | null;
  /** 已完成环节的摘要（形状同 stage_summaries；运行中的 stage_summaries 是 []） */
  stage_summaries_partial?: StageSummary[];
}

export type PlanRunsEvent = {
  event: "plan_runs";
  plan_id: string;
  runs: PlanRunSummary[];
}

// ---------- 单次报告（get_plan_run 完整归档 / run_plan 最终帧） ----------
export interface StageSummary {
  type?: string;
  /** completed | error | empty（如线上评估环节没有可评估会话） */
  status?: string;
  dataset?: string;
  cases_dataset?: string;
  evaluators?: string[];
  score?: number | null;
  cases?: number;
  passed?: number;
  /** observe 环节（后端 _stage_summary 形状） */
  sessions?: number;
  overall_mean?: number | null;
  /** dataset 环节 */
  pass_rate?: number | null;
  /** dataset 环节的逐评估器聚合（后端 planrun.py:973-975，**只有 dataset 分支有**
   *  ——observe/redteam 的摘要形状未动）。
   *  2026-08 additive：**老 run 没有这个键**，消费方缺字段一律不画（derive.
   *  evaluatorRows 统一降级），绝不显示 NaN/undefined。 */
  evaluator_stats?: Record<string, EvaluatorStat> | null;
  /** observe 环节的逐评估器聚合（后端 observe.py:summarize 的 `summary`）。
   *  ⚠️ 两条取数路的形状**不同**：DDB `stage_summaries` 只留
   *  `{mean_score, pass_rate}`，S3 `report.stages[i]` 那一份还带
   *  `{sessions, errored}`（= 判定数与未评出数，也就是分母）。所以
   *  「9 判定 / 3 未评出」只有走明细那一路才说得出来 —— 消费方读的是
   *  compare/derive.summaryLike 合并后的环节（`{...DDB, ...S3}`）。 */
  summary?: Record<string, ObserveEvaluatorStat> | null;
  /** dataset 环节**入分母的用例数**（S3 报告体那一份才有；DDB 摘要剥掉了它）。
   *  与 `cases`（枚举到的用例数）不是一个数：空响应/调用失败不入分母。 */
  judged_cases?: number;
  /** 只用上报数据评估（ADR-0019 批 1）：开了开关的回归 / 红队环节才有这两键 */
  trace_summary?: TraceSummary | null;
  /** ok | degraded_no_trace | no_trace（全缺时环节 status 也是 no_trace） */
  trace_status?: string | null;
  /** redteam 环节 */
  breached?: number;
  attacks?: number;
  error?: string | null;
  skip_reason?: string | null;
  [k: string]: unknown;
}

/**
 * 单个评估器在一个回归环节里的聚合（后端 planrun.py:910-939 `_evaluator_stats`，
 * 形态钉在 tests/test_evaluator_stats_field.py）。
 *
 * ⚠️ `mean` 在零有效判定时是 **null，不是 0** —— 0 是「评了且很差」，null 是
 * 「一条判定都没有」（全被 judge 限流 / 用例全空响应），两者语义完全不同，
 * 显示侧必须分开（消费点见 derive.evaluatorRows）。
 * 口径与同一环节的 pass_rate 同源：**先剔 errored 再算**（评估器执行失败不是
 * 0 分）；mean 已 round 4；`judged` 是分母（判定数，不是用例数）。
 */
export interface EvaluatorStat {
  mean: number | null;
  passed: number;
  judged: number;
}

/**
 * 单个评估器在一次**线上评估**环节里的聚合（后端 observe.py:summarize）。
 *
 * 与 EvaluatorStat 同族但**不同键名、不同分母单位**，所以不合并成一个类型：
 *   mean_score —— 均分（口径同源：先剔 errored 再算）
 *   pass_rate  —— 通过率（分母是 sessions，不是枚举到的会话数）
 *   sessions   —— **判定数**（= 评出了结论的会话数，现网两轮都是 9）
 *   errored    —— 未评出数（无内容会话 / 判分失败，现网两轮都是 3）
 * 后两个键只在 S3 报告体那一份里（DDB 摘要剥掉了）⇒ 缺就是缺，显示侧写
 * 「分母未记录」，绝不拿 stage.sessions（枚举数 12）顶替 —— 那会把 9 说成 12。
 */
export interface ObserveEvaluatorStat {
  mean_score?: number | null;
  pass_rate?: number | null;
  sessions?: number;
  errored?: number;
}

// ---------- 环节明细（S3 全量报告体，DDB 摘要里**没有**这些） ----------
//
// 两套形状必须分清，混读是白屏/空白区的老根源：
//   · StageSummary  = DDB `stage_summaries`（planrun.py:_stage_summary）——只有
//     聚合数字。实测现网 63 份 run：dataset 环节摘要里**没有** dataset/evaluators
//     （2026-08-25 逐条核过），所以「哪个数据集」不能从摘要取。
//   · StageDetail   = S3 全量 `report.stages[i]`（= 执行侧 stage_results 原物）
//     / run_plan 终帧 `stages[i]`——带 analysis、带被嵌套的 run 记录。
// 消费入口统一走 derive.reportStageDetails，不许各处自己挑键。
export interface StageDetail extends StageSummary {
  /** observe 环节的环节分析直挂在这里（planrun.py:207）。
   *  ⚠️ 类型是 unknown 而不是 string：后端 `_generate_analysis` 的返回值没有
   *  统一 str() 兜（失败分支写的是中文串，正常分支是 judge 文本），进 JSX 前
   *  必须过 renderText.textOf。 */
  analysis?: unknown;
  /** dataset/redteam 环节把整份子 run 记录嵌在这里（planrun.py:326 `"report": run`）——
   *  环节分析与逐用例明细都在里面。 */
  report?: StageInnerReport | null;
  /** observe 环节的逐会话明细（planrun.py:_run_observe_stage 的 `details`）。
   *  **只有 S3 全量报告体有**，DDB 摘要一条都没有 —— 改进处方的证据来源。 */
  session_details?: ObserveSessionDetail[] | null;
}

/** 被嵌套的子 run 记录（dataset 侧 = testrun.execute_test_run 的 run 字典）。 */
export interface StageInnerReport {
  run_id?: string;
  status?: string;
  /** 回归环节的环节分析（testrun.py:951-957；实测现网 41/41 个 dataset 环节都有）。
   *  失败分支写「（解析生成失败：…）」，停止分支写「（已按用户请求停止…）」——
   *  都是字符串，但同样不裸渲。 */
  analysis?: unknown;
  /** 数据集名。**这里**是可信来源（S3 报告体），不是 DDB 摘要。 */
  dataset?: unknown;
  total_cases?: number;
  blank_cases?: number;
  /** 逐用例明细（testrun.py:869 run["results"].append(entry)） */
  results?: CaseResult[] | null;
  [k: string]: unknown;
}

/**
 * 一个用例 × 一个 Agent 的执行+判定记录（testrun.py:694 entry 构造，
 * 实测现网 191 行逐键核对，2026-08-25）。
 *
 * ⚠️ 值类型刻意留宽（unknown / 可空）：后端多处没有 str() 兜，且实测
 *   · `category` 有 9/191 是 **null**；
 *   · `results` 有 31/191 **整键缺失**（空响应/Agent 报错/调用失败的行提前 return）；
 *   · `output` 有 4/191 缺失（调用就失败了，只有 error）。
 * 任何一项进 JSX 前都要过 renderText.textOf（UI-026 白屏家族）。
 */
export interface CaseResult {
  /** 用例名——dataset 侧键名是 `case`（**不是** name；红队侧才是 case_name） */
  case?: unknown;
  agent?: unknown;
  input?: unknown;
  output?: unknown;
  expected_output?: unknown;
  category?: unknown;
  /** {评估器名: 判定}；errored 判定也在里面（score/passed 为 null） */
  results?: Record<string, CaseVerdictRaw> | null;
  /** 被测 Agent 返回 0 字节空响应：无内容可判分，已跳过评估 */
  blank_output?: boolean;
  /** 被测 Agent 返回的是它自己的内部错误对象而非回答 */
  error_output?: boolean;
  error_summary?: unknown;
  /** 跳过评估的原因原文（后端中文长句，blank/error_output 两支都写） */
  eval_skipped?: unknown;
  /** 调用被测 Agent 就失败了（testrun.py:754） */
  error?: unknown;
  /** 判定阶段整批抛异常（testrun.py:860） */
  eval_error?: unknown;
  /** 低分用例的诊断（testrun.py:1061 `entry["diagnosis"]`，形状同 observe 侧） */
  diagnosis?: SessionDiagnosis | null;
  /** 红队行（B1 契约新增）：这次攻击落在哪些 target 会话上（可空数组）。
   *  旧形状 run 整键缺失 → 显示侧不渲染。 */
  session_ids?: unknown;
  duration_s?: number | null;
  [k: string]: unknown;
}

/** 单个评估器对单个用例的判定（testrun.py:_collect_results:576-594）。
 *  errored=true 时 score/passed 是 **null**——那是「没评出来」，不是 0 分。 */
export interface CaseVerdictRaw {
  score?: number | null;
  passed?: boolean | null;
  errored?: boolean;
  /** 实测 472/472 是字符串（后端 str() 过），但 observe 侧同名字段没兜过 ——
   *  显示侧一律过 textOf，不赌形态。 */
  reason?: unknown;
  /** 档位名（SDK EvaluationOutput.label，B1 契约新增）：`string | null`。
   *  缺/多条/errored = null。留 unknown 由 derive.verdictsOf 收窄，不赌形态。 */
  label?: unknown;
}

/** 综合报告分节（后端 planrun.synthesis_sections / 前端 fallback 同形状） */
export interface SynthesisSection {
  title: string;
  body: string;
}

// ---------- 问题台账（ADR-0016 ③；契约 docs/payload-contract.md「问题台账」） ----------
//
// 权威：app/planrun.py:aggregate_issues / _build_ledger（synthesis_issues）与
// judge_adoption_effect（proposals[].adoption_effect）。两个字段都是 additive：
// 老 run 与没有诊断产物的 run 查无此键 → 读侧回落 `[]` / 不写，不回填历史。

/** 一条证据引用。`kind` 现产两值（case = 回归用例名 / session = 线上会话 id）；
 *  `redteam` / `run` 契约预留、当前不产。 */
export interface IssueEvidence {
  kind: "case" | "session" | "redteam" | "run" | string;
  ref: string;
}

/** 建议的修法分类（`fix_type`）：两个具名值之外一律 OTHERS；空 ⇒ null。 */
export type IssueFixType = "SYSTEM_PROMPT_FIX" | "TOOL_DESCRIPTION_FIX" | "OTHERS";

/**
 * 结构化问题条目（`synthesis_issues[]`）。字段口径逐条见契约表：
 *  · `id` = 聚合键 strip 后 sha1 前 8 位，同一修法跨 run 同 id；
 *  · `recommendation` 为 null = 还没有建议（台账「待建议」组）；
 *  · `status` 按 proposals 对回：匹配键 = 建议文本 strip 后截到 300 与
 *    `proposals[].summary` 全等（与 adopt_run_advice / persistedAdoptedAt 同规则）；
 *  · `evaluators` 恒为数组（老形状读成 []，不是 null）。
 */
export interface SynthesisIssue {
  id: string;
  problem: string;
  evidence: IssueEvidence[];
  root_cause: string;
  /** 建议：批 judge-zh（v0.34.1 后）起是 `fix_recommendation` 的简体中文译文 */
  recommendation: string | null;
  /** 译前英文原话（≤300）。**只用于对回 proposals[].summary，不作展示**；判 status /
   *  匹配采纳记录时与 `recommendation` 两把钥匙任一全等即命中（契约「问题台账」）。
   *  批 judge-zh 之前落库的台账没有这个键 → 缺省 undefined。 */
  recommendation_source?: string | null;
  fix_type: IssueFixType | null;
  first_seen_run: string;
  last_seen_run: string;
  occurrences: number;
  depends_on: string[];
  status: "open" | "adopted" | "resolved" | string;
  evaluators: string[];
}

/** 采纳效果判定（挂在建议所在那条 proposal 上：`proposals[].adoption_effect`）。
 *  `adopted_at` 为空的条目没有这个键；`reason` 只在 inconclusive 时非空。 */
export interface AdoptionEffect {
  verdict: "improved" | "unchanged" | "regressed" | "pending" | "inconclusive" | string;
  /** name = 评估器名 / pass_rate / breached；数值四舍五入到 4 位 */
  metrics: { name: string; before: number | null; after: number | null }[];
  cases: { ref: string; before: "pass" | "fail" | "none" | string; after: "pass" | "fail" | "none" | string }[];
  /** 判定用的那次 run；pending 时 null */
  measured_run: string | null;
  /** 建议挂着的那次 run（采纳时的基线） */
  baseline_run: string;
  reason: string | null;
}

// ---------- 改进处方（闭环：报告证据 → 修改稿 → 采纳 → 下次 run 对比） ----------
//
// 两个 action 的权威分支：app/main.py 的 `propose_improvements` /
// `set_proposal_adopted`；生成端 app/improve.py:propose（强制 toolUse，schema 见
// 同文件 `_PROPOSAL_TOOL`）；挂载与采纳标记 app/planrun.py:attach_proposal /
// set_proposal_adopted；采纳追踪 app/planrun.py:_build_overview 的 adoption_note。
//
// ⚠️ 值类型刻意留宽（unknown）：proposal 整棵树是 **LLM 产物**（Bedrock 的
// tool_input 原样透传，后端没有逐叶 str() 兜；app/improve.py 自己就记着
// 「observed the model returning system_prompt as a bare string」——嵌套形状
// Bedrock 不严格校验）。进 JSX 前一律过 renderText.textOf（UI-026 白屏家族）。

/** observe 环节的逐会话明细（app/planrun.py:_run_observe_stage 的 `details`）。
 *  正常支九键原样透传 observe.evaluate_session 的结果；session_error 支**只有**
 *  {agent, session_id, error} —— results/diagnosis/transcript 全缺。 */
export interface ObserveSessionDetail {
  agent?: unknown;
  session_id?: unknown;
  /** {评估器名: 判定}；errored 判定也在里面（score/passed 为 null） */
  results?: Record<string, CaseVerdictRaw> | null;
  /** 会话没有可评估内容（后端据此不产判定）——不构成改进证据 */
  no_content?: boolean;
  /** trace 拉取失败（session_error 支）——同样不构成证据 */
  error?: unknown;
  diagnosis?: SessionDiagnosis | null;
  /** 完整对话（几十 KB 到几 MB）。送 propose_improvements 前必须剥掉：
   *  后端 collect_evidence 一个字都不读。 */
  transcript?: unknown;
  [k: string]: unknown;
}

/** 会话诊断（app/diagnosis.py）。两个数组的元素形状由 SDK 决定，本处留
 *  unknown[]、由消费方逐叶收窄（reportRows.diagnosisOf）：
 *    failures[]    → {span_id, category(list[str]), confidence(str), evidence(str)}
 *    root_causes[] → {location, causality, impact, fix_type, fix_recommendation,
 *                     root_cause_explanation(≤500, B1 契约新增；旧形状 run 缺键)}
 *  ⚠️ category 是 **list[str]**（后端没 str()），进 JSX 前必须过 textOf
 *  （RunDetailPage 的 DIAGNOSIS 块踩过的同一个坑）。 */
export interface SessionDiagnosis {
  failures?: unknown[];
  root_causes?: unknown[];
  [k: string]: unknown;
}

/** 一处提示词改动（`_PROPOSAL_TOOL` 的 changes 元素）。kind ∈ 新增/修改/删除。 */
export interface ProposalChange {
  kind?: unknown;
  what?: unknown;
  why?: unknown;
}

/** 可粘贴片段（原提示词未复原时的唯一输出形态）。 */
export interface ProposalSnippet {
  placement?: unknown;
  text?: unknown;
}

/** 系统提示词修改稿。mode 由**后端**按「原文有没有复原」定死
 *  （app/improve.py:propose 会把没有原文的 "full" 降级成 "snippets"）——
 *  显示侧按 mode 分派，不自己猜。 */
export interface ProposalSystemPrompt {
  mode?: unknown;
  /** mode=full 时的修订版全文；否则空串 */
  revised?: unknown;
  snippets?: ProposalSnippet[] | null;
  changes?: ProposalChange[] | null;
}

/** 工具描述改写（后端已剔掉不在真实工具清单里的行，防幻觉工具名）。 */
export interface ProposalToolDescription {
  name?: unknown;
  /** 现有描述（schema 里非必填，可能整键缺失） */
  current?: unknown;
  revised?: unknown;
  why?: unknown;
}

/** 提示词/工具描述修不了的事（代码逻辑、超时、权限等）。 */
export interface ProposalOtherAction {
  title?: unknown;
  detail?: unknown;
}

export interface ImprovementProposal {
  summary?: unknown;
  system_prompt?: ProposalSystemPrompt | string | null;
  tool_descriptions?: ProposalToolDescription[] | null;
  other_actions?: ProposalOtherAction[] | null;
}

/** propose_improvements 的成功回执（app/main.py 该分支的 improvement 帧 =
 *  `{event, agent, **improve.propose 的返回}`）。 */
export type ImprovementEvent = {
  event: "improvement";
  agent?: string;
  proposal?: ImprovementProposal | null;
  /** 系统提示词是否从 trace 复原（false ⇒ 只给片段，不给全文） */
  prompt_recovered?: boolean;
  /** 修订前的原文（复原成功时才有） */
  current_prompt?: unknown;
  based_on?: {
    sessions?: number;
    failures?: number;
    root_causes?: number;
    /** {fix_type: 条数} */
    fix_types?: Record<string, number> | null;
  } | null;
  /** 带 run_key 生成时，后端把处方挂到该 run 上并回填这个键 */
  attached_to_run?: string | null;
};

/** 一份挂在 run 上的处方（app/planrun.py:attach_proposal 写入的三键）。
 *  summary 来自 LLM（`proposal["summary"]` 原样切 300 字），故 unknown。 */
export interface RunProposal {
  summary?: unknown;
  generated_at?: unknown;
  /** 未采纳时是 **null**（set_proposal_adopted 用 null 表示取消采纳） */
  adopted_at?: unknown;
  /** 采纳效果（契约「proposals[].adoption_effect」）：只有 adopted_at 非空的条目
   *  才有；取消采纳时一起删掉。缺键 = 老数据 / 未采纳，显示侧不写效果。 */
  adoption_effect?: AdoptionEffect | null;
}

/** set_proposal_adopted 的回执（app/main.py 该分支）。 */
export type ProposalAdoptedEvent = {
  event: "proposal_adopted";
  run_key?: string;
  proposal?: RunProposal | null;
};

/** 采纳追踪（app/planrun.py:_build_overview 写的 `overview["adoption_note"]`）：
 *  **上一次** run 的已采纳处方 + 本次与上次的分数变化。只有上次 run 真有
 *  已采纳处方时后端才写这个键 —— 缺键是常态，不是异常。 */
export interface AdoptionNote {
  proposals?: RunProposal[] | null;
  /** 后端现成的中文句子数组（「线上评估均分 0.66 → 0.88」） */
  score_changes?: unknown[] | null;
}

export interface PlanRunDetail {
  event?: string;
  run_key: string;
  plan_id?: string;
  /** 方案名 / Agent 名（_run_from_item 顶层带；导出文件名与正文用） */
  plan_name?: string;
  agent_name?: string;
  status?: string;
  /** 综合分在**顶层**（planrun.py:_run_from_item，由 observe 环节均分算出）。
   *  `overview.score` 是 mock 幻觉——真后端 overview 只有 stage_lines /
   *  previous_run / adoption_note。 */
  score?: number | null;
  overview?: Record<string, unknown>;
  /** run_plan 终帧的环节数组 = 执行侧 stage_results 原物（**带明细**） */
  stages?: StageDetail[];
  /** 真后端 get_plan_run 的 DDB 摘要字段名（mock/终帧用 stages）。
   *  只有聚合数字，**没有** analysis/results —— 明细看 report.stages。 */
  stage_summaries?: StageSummary[];
  plan_synthesis?: string | null;
  /** 结构化分节（2026-08 additive）；老数据缺失时前端自行切分 */
  synthesis_sections?: SynthesisSection[] | null;
  synthesis_error?: string | null;
  /** 问题台账（get_plan_run 的 plan_run 事件同样带；口径同 PlanRunSummary） */
  synthesis_issues?: SynthesisIssue[] | null;
  started_at?: string | number | null;
  finished_at?: string | number | null;
  duration_s?: number | null;
  triggered_by?: string | null;
  total_cost_usd?: number | null;
  skip_reason?: string | null;
  /** 挂在这个 run 上的处方（_run_from_item 无条件带；老 item 缺键时是空数组）。
   *  数组下标 = set_proposal_adopted 的 `index`（attach_proposal 只追加）。 */
  proposals?: RunProposal[] | null;
  /** S3 归档对象键；有 s3_key 但没有 report 即读取失败（planrun.py:755-761） */
  s3_key?: string | null;
  /** S3 完整归档（get_plan_run 带 s3_key 时附）；环节详情在 report.stages。
   *  实测 2026-08-25：现网 63 份归档里 dataset 环节 41/41 都带
   *  `stages[i].report.analysis`（1000-1500 字）与 `report.results[]`（≤10 行）
   *  —— 环节分析与用例明细的唯一数据源。 */
  report?: { stages?: StageDetail[] } & Record<string, unknown>;
  /** S3 读失败时后端附的中文提示（「完整报告读取失败（摘要仍可用）」） */
  report_error?: string | null;
  /** 版本快照（同 PlanRunSummary 的两个字段，_run_from_item 两条读路径同款）：
   *  这一次运行时的版本标签 / runtime ARN。老 run 为 null → 抽屉头不画 chip。 */
  agent_version_label?: string | null;
  agent_runtime_arn?: string | null;
  /** 存活/进度四件（同 PlanRunSummary 的同名字段，_run_from_item 两条读路径同款）：
   *  断流后前端轮询 `get_plan_run` 就是靠这几个字段说「还在跑 / 跑到哪了 /
   *  是不是疑似中断」。语义与降级规则逐条见 PlanRunSummary。 */
  stale?: boolean;
  heartbeat_epoch?: number | null;
  progress?: PlanRunProgress | null;
  checkpoint_s3_key?: string | null;
}

// ---------- 编辑器数据源 ----------
export interface CustomEvaluatorLite {
  name: string;
  scope: string; // "observe" | "dataset" | "redteam" | "all"
}

export type EvaluatorsEvent = {
  event: "evaluators";
  available: string[];
  dataset_only: string[];
  multimodal: string[];
  scopes: Record<string, string[]>;
  custom: CustomEvaluatorLite[];
  /** 零成本 trace 指标 key 列表（observe 环节 metrics 多选的选项来源） */
  metrics?: string[];
  /** 新建 observe 环节的默认评估器（旧版 state.defaults） */
  default?: string[];
  /** 新建 observe 环节的默认指标（旧版全选 metricKeys） */
  default_metrics?: string[];
}

export interface DatasetLite {
  name: string;
  kind: string; // "regression" | "redteam" | "simulation"
  target_agent?: string;
  case_count?: number;
  /**
   * 最后一次修改时间（**epoch 秒**）。后端 list_datasets 原样带出
   * （app/catalog.py:_dataset_from_item 的 `int(i.get("updated_at", 0))`；
   * 老 item 缺这个属性时读出 0）。
   *
   * 唯一消费点是 run 对比的对齐判定：数据集**没有内容指纹**，用例名又是按位置
   * 派生的（catalog.save_dataset 的 `case-{i+1}`），所以「这个集合在两次运行
   * 之间改过没有」只能靠这一个时间戳判 —— 改过就得警示逐用例对齐可能失真
   * （compare/derive.staleDatasetText）。缺失/为 0 = 不判，不猜。
   */
  updated_at?: number;
  /** 双读归类兜底：历史多轮集 kind 仍是 regression，按 cases 形态推断（lib/datasetSide） */
  cases?: { task_description?: unknown; [k: string]: unknown }[];
}

export type DatasetsEvent = {
  event: "datasets";
  datasets: DatasetLite[];
}

export interface AgentLite {
  agent_name: string;
  description?: string;
}

export type AgentsEvent = {
  event: "agents";
  agents: AgentLite[];
}

/** 红队攻击策略菜单（app/main.py:981-987 redteam_options action）。
    编辑器只消费 strategies/default_strategies；risk_categories 形状留宽
    （红队生成 UI 用 dict 形态），不在此约束。

    ⚠️ strategies 是**对象数组**，不是字符串数组：后端 redteam.strategy_menu()
    返回 `[{name, label, desc, turns, snapshot_safe}, ...]`（app/redteam.py:129）。
    直渲元素会触发 React error #31（对象当子节点）并白屏整页——线上实测过。
    default_strategies 才是纯字符串数组（app/redteam.py:112）。 */
export type RedteamStrategySpec = {
  name: string;
  label?: string;
  desc?: string;
  turns?: number;
  snapshot_safe?: boolean;
};

export type RedteamOptionsEvent = {
  event: "redteam_options";
  strategies: RedteamStrategySpec[];
  default_strategies: string[];
  risk_categories?: unknown;
  default_risk_categories?: string[];
  breach_threshold?: number;
}
