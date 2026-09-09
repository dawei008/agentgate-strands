// 运行详情（trace 三栏视图）类型。
//
// 形状照 **app/planrun.py**（`get_plan_run` / `_run_from_item`），mock 只是它的
// 一个子集——不是反过来。此前这里写的是「形状即契约（与 MOCK_PLAN_RUN 一致）」，
// 那句话让类型照 mock 长，真后端一来 `overview.cost_usd.toFixed()` 直接白屏。
//
// `get_plan_run` 有**两条数据通路**，字段名不同，必须都兜：
//   1. DDB 摘要（总是有）：`stage_summaries` —— 每环节只有聚合数字，无逐会话/逐用例明细
//   2. S3 全量（有 s3_key 时才有）：`report.stages` —— 含 observe 的 `session_details`、
//      dataset/redteam 的 `report.results`
// 明细只在通路 2 里，所以读顺序是 report.stages → stage_summaries。
// 同一坑的另一处消费方见 `pages/plan/ReportDrawer.tsx`（三重兜底 + countOf）。

/** 后端「说是字符串」的文本位。实测真后端在若干处给的是 dict / list
 *  （见下方各字段注释），裸渲对象会抛 React error #31 并卸掉整棵子树。
 *  统一用 `renderText.ts` 的 textOf/displayText 归一，不许裸渲。 */
export type BackendText = string | number | boolean | unknown[] | Record<string, unknown> | null;

/** 单评估器结果。errored=true 时 score/passed 为 null——不是 0 分。 */
export interface EvaluatorResult {
  score: number | null;
  passed: boolean | null;
  errored: boolean;
  /** app/main.py:151 是全仓库**唯一**没有 str() 兜的 reason 赋值（observe 通路
   *  原样透传 SDK 的 report.reasons[i]）；testrun/redteam/improve 都 str() 过。
   *  实测 28 份线上报告 190 条 reason 全是字符串，但契约上兜不住，故放宽。 */
  reason: BackendText;
  /** app/main.py:1708 会把人工复核 {verdict,note,updated_at} 塞进这个结果对象 */
  review?: { verdict?: string; note?: string; updated_at?: string };
}

export interface TranscriptEvent {
  n: number;
  type: "user" | "assistant" | "tool";
  /** transcript.py: 无时间戳的 span 给 null */
  t_offset_s: number | null;
  /** telemetry 缺 span id 时为 null */
  span_id: string | null;
  parent_span_id: string | null;
  /** user / assistant 行 */
  text?: BackendText;
  /** tool 行 */
  name?: BackendText;
  /** **对象**，不是字符串。app/transcript.py:64 原样透传 SDK 的
   *  `ToolCall.arguments: dict`（strands_evals/types/trace.py:41），后端没有
   *  str() 兜。实测 28 份线上报告 428/428 次全是 dict —— UI-026 白屏就在这：
   *  本页两处把它当 React child 直渲，遇到 `{"summary": "..."}` 这种入参
   *  就抛 React error #31（object with keys {summary}）卸掉整个应用。
   *  旧版 ui/app.js:2504 用 JSON.stringify 兜住了，React 重写丢了这层。 */
  arguments?: BackendText;
  result?: BackendText;
  error?: BackendText;
  duration_s?: number | null;
  slow?: boolean;
}

export interface SessionDiagnosisFailure {
  span_id: string;
  /** SDK `FailureItem.category` 是 **list[str]**（types/detector.py:55），
   *  而 app/diagnosis.py:33 只对 confidence/evidence 做了 str()，category
   *  原样透传 → 实测线上 17/17 条都是数组。数组直渲会粘连成 "abc"。 */
  category: BackendText;
  /** 后端 diagnosis.py 里是 `str(f.confidence)` —— **字符串**，不是数字
   *  （原文是 list[float] 的 str()，形如 "[0.75]"） */
  confidence: BackendText;
  /** 后端已 str() 过，但原文是 list[str]，故内容形如 '["...", "..."]' */
  evidence: BackendText;
}

/** metrics.py compute_session_metrics：每组都是**对象**，不是标量。
 *  且 filter_metrics 只保留用户选的组 → 每组都可能整体缺失。 */
export interface SessionMetrics {
  tokens?: { input: number; output: number; total: number; by_model?: Record<string, unknown> };
  cost?: { usd: number; by_model?: Record<string, number>; unpriced_models?: string[] };
  latency?: { turns: number; avg_s: number | null; max_s: number | null };
  llm_calls?: { count: number; avg_s?: number | null; max_s?: number | null };
  tool_calls?: { count: number; total_s?: number };
}

/** report.stages[observe].session_details[] 的元素（planrun.py:_run_observe_stage）。
 *  失败会话只有 {agent, session_id, error} —— results/transcript/metrics 全缺。 */
export interface RunSession {
  session_id: string;
  agent?: string;
  /** metrics 未选任何 metric key 时为 null */
  metrics?: SessionMetrics | null;
  results?: Record<string, EvaluatorResult>;
  /** diagnose 未触发时为 null；clean 只在「跑了但没发现」时出现 */
  diagnosis?: { clean?: boolean; failures?: SessionDiagnosisFailure[] } | null;
  /** build_transcript 抛错时为 null */
  transcript?: { events?: TranscriptEvent[] } | null;
  output_preview?: BackendText;
  no_content?: boolean;
  warning?: BackendText;
  /** session_error 分支 */
  error?: BackendText;
}

/** report.stages[dataset|redteam].report.results[] 的元素。
 *  用例名在 dataset 侧是 `case`（testrun.py:614）、redteam 侧是 `case_name`
 *  （redteam.py:565）—— **都不是 `name`**。`name` 只存在于旧 mock 里。 */
export interface RunEntry {
  /** dataset 侧 */
  case?: BackendText;
  /** redteam 侧 */
  case_name?: BackendText;
  /** 旧归档/mock 形态 */
  name?: BackendText;
  input?: BackendText;
  output?: BackendText;
  duration_s?: number;
  blank_output?: boolean;
  /** 真后端给的是**说明字符串**（testrun.py），不是 boolean；只当真假用 */
  eval_skipped?: boolean | string;
  category?: BackendText;
  n_turns?: number;
  /** redteam */
  base_case?: BackendText;
  risk_category?: BackendText;
  strategy?: BackendText;
  severity?: BackendText;
  breached?: boolean;
  errored?: boolean;
  silenced?: boolean;
  turns_used?: number;
  /** redteam 顶层 judge 原文。redteam.py:591 经 SDK 的 AttackResult.reason
   *  property 拼成字符串，但同族字段已被证实会给对象，故一并放宽。 */
  reason?: BackendText;
  results?: Record<string, EvaluatorResult>;
}

/** 一个环节。三种通路的并集：
 *  - DDB `stage_summaries` 元素（planrun.py:_stage_summary）：聚合数字，无明细
 *  - S3 `report.stages` 元素（各 _run_*_stage 的返回）：含明细
 *  - 旧 mock 形态：`score`/`sessions[]`/`entries[]` */
export interface RunStage {
  type: "observe" | "dataset" | "redteam" | string;
  status?: string;
  error?: string;
  /** observe 聚合分（真后端字段名）；旧形态叫 score */
  overall_mean?: number | null;
  score?: number | null;
  /** dataset 聚合 */
  pass_rate?: number | null;
  blank_cases?: number;
  judged_cases?: number;
  dataset?: string;
  cases_dataset?: string;
  /** redteam 聚合 */
  breached?: number;
  attacks?: number;
  verdict?: string;
  /** observe：DDB 摘要里是**会话数（number）**，明细通路里没有这个键 */
  sessions?: number | RunSession[];
  /** dataset：DDB 摘要里是**用例数（number）** */
  cases?: number | RunEntry[];
  /** S3 全量：observe 逐会话明细（真后端字段名） */
  session_details?: RunSession[];
  /** S3 全量：dataset/redteam 整个子 run 对象，用例在 report.results */
  report?: { results?: RunEntry[]; [k: string]: unknown };
  /** 旧 mock/归档形态的逐用例明细 */
  entries?: RunEntry[];
  actual_cost_usd?: number;
  summary?: Record<string, unknown>;
}

/** overview 真形态（planrun.py:_build_overview）：**只有** stage_lines /
 *  previous_run / adoption_note。没有 score/cases/passed/cost_usd —— 那四个
 *  是 mock 幻觉，`overview.cost_usd.toFixed()` 曾是本页白屏点。 */
export interface RunOverviewStageLine {
  type: string;
  status?: string;
  text: string;
  delta?: number;
  delta_inverted?: boolean;
}

export interface RunOverview {
  stage_lines?: RunOverviewStageLine[];
  previous_run?: string | null;
  adoption_note?: {
    proposals?: { summary: string; adopted_at: string }[];
    score_changes?: string[];
  };
  /** 旧归档形态可能有；真后端不给 —— 消费方必须当可选读 */
  score?: number;
  cases?: number;
  passed?: number;
  cost_usd?: number;
}

export interface SynthesisSection {
  title: string;
  body: string;
}

// 事件类型用 type 而非 interface：apiOne<T extends ApiEvent> 需要隐式索引签名
export type PlanRunDetailEvent = {
  event: "plan_run";
  run_key: string;
  /** DDB 摘要通路**没有** plan 键（只有扁平 plan_id/plan_name/agent_name）；
   *  S3 全量里才有 {plan_id,name,agent_name,stages} */
  plan?: { plan_id: string; name: string; agent_name: string };
  plan_id?: string;
  plan_name?: string;
  agent_name?: string;
  status?: string;
  score?: number | null;
  triggered_by?: string;
  /** 带 " UTC" 后缀：`"2026-08-11 09:00 UTC"`（time.strftime("%Y-%m-%d %H:%M UTC")） */
  started_at?: string;
  finished_at?: string;
  started_epoch?: number | null;
  finished_epoch?: number | null;
  /** 历史 item 无 epoch → null，绝不伪造耗时 */
  duration_s?: number | null;
  total_cost_usd?: number | null;
  overview?: RunOverview;
  /** DDB 摘要通路的环节数组（聚合，无明细） */
  stage_summaries?: RunStage[];
  /** S3 全量报告（有 s3_key 时）；明细只在这里 */
  report?: { stages?: RunStage[]; [k: string]: unknown };
  report_error?: string;
  s3_key?: string | null;
  plan_synthesis?: string | null;
  synthesis_error?: string | null;
  synthesis_sections?: SynthesisSection[] | null;
  skip_reason?: string | null;
  proposals?: unknown[];
  /** 旧归档/mock 形态的顶层环节数组 */
  stages?: RunStage[];
};

// ==================== 本页视图形态（归一化入层的产物） ====================
//
// 上面全是**真后端形态**（文本位一律 BackendText，因为实测会给 dict / list）。
// 下面是 RunDetailPage 的归一化层（`stagesOf` / `sessionsOf` / `entriesOf`）
// 产出的**视图形态**：进 JSX 文本位的字段在那一层就已经收成 string，所以
// 渲染点直接渲染，不用（也不该）再逐个调 textOf —— 那层头注释承诺的
// 「让下面的 JSX 只读一套字段」，从 R2-E 起是字面意义上的真。
//
// 收窄四条规则（与 RunDetailPage 归一化段同源，改这边先读那边）：
//   1. 文本位 → `string`：null/undefined → ""（要占位的地方由渲染点用
//      displayText/"—" 表达，那是排版决定，不是形态问题）
//   2. 原本靠 `!= null` 区分「缺键」与「空值」的位 → `string | null`：
//      这个区分**不许**被归一化抹掉。三处真在用：`entry.input/output`
//      决定用例行能不能展开、`failure.span_id` 决定 testid 退不退回序号、
//      `event.error` 决定 ATTRIBUTES 那格显 "null" 还是空
//   3. 数值位 / 布尔位原样透传：`.toFixed()` 这类形态错留给渲染点抛、由就近
//      ErrorBoundary 兜。**归一化层本身必须不抛**——它跑在 useMemo 里，也就是
//      围栏外面，在那儿抛就是整页白屏（预防与软化是两层，都要）
//   4. JSON 位（`arguments` / `result`）保持 BackendText：它们不是文本位，
//      由 prettyJson/inlineJson 在渲染点成文——那两个函数吃任意形态、恒返
//      string，签名本身就拦得住裸渲
/** 归一化后的单评估器结果：只有 reason 收窄（其余本来就是数值/布尔位）。 */
export interface ViewEvaluatorResult {
  score: number | null;
  passed: boolean | null;
  errored: boolean;
  reason: string;
  review?: { verdict?: string; note?: string; updated_at?: string };
}

export interface ViewTranscriptEvent {
  n: number;
  type: "user" | "assistant" | "tool";
  t_offset_s: number | null;
  /** null 时渲染点用 `?? n{n}` 兜 spanKey —— 规则 2，别收成 "" */
  span_id: string | null;
  parent_span_id: string | null;
  /** user / assistant 行文本（缺 → ""） */
  text: string;
  /** tool 名（缺 → ""） */
  name: string;
  /** 规则 2：null=没这个键（ATTRIBUTES 显 "null"），""=有键但空 */
  error: string | null;
  /** 规则 4：JSON 位，原样透传 */
  arguments?: BackendText;
  result?: BackendText;
  duration_s?: number | null;
  slow?: boolean;
}

export interface ViewDiagnosisFailure {
  /** 规则 2：null → 渲染点 testid 退回数组序号 */
  span_id: string | null;
  category: string;
  confidence: string;
  evidence: string;
}

/** observe 逐会话明细的视图形态。transcript 包装层在归一化时摊平成 events，
 *  diagnosis 补齐成必有字段（缺 → clean:false + 空 failures）。 */
export interface ViewSession {
  session_id: string;
  /** 规则 3：数值位对象原样透传（cost/latency 各有两种真形态，渲染点双读） */
  metrics?: SessionMetrics | null;
  results: Record<string, ViewEvaluatorResult>;
  diagnosis: { clean: boolean; failures: ViewDiagnosisFailure[] };
  events: ViewTranscriptEvent[];
  no_content?: boolean;
  /** 规则 2 */
  error: string | null;
}

/** dataset / redteam 逐用例明细的视图形态。三套键名（case / case_name /
 *  name、category / risk_category、n_turns / turns_used）在归一化层合完，
 *  渲染点只读一套。 */
export interface ViewEntry {
  /** 兼作 data-testid 与选中态 key —— 所以必须先归一化再当键用；三个键全缺落 "—" */
  name: string;
  /** 规则 2：`!= null` 决定这一行能不能展开（"" 是「有输出但空」，要展开） */
  input: string | null;
  output: string | null;
  category: string;
  strategy: string;
  severity: string;
  reason: string;
  turns: number | null;
  duration_s?: number;
  blank_output?: boolean;
  breached?: boolean;
  errored?: boolean;
  /** 真后端给的是说明字符串，不是 boolean —— 归一化层只取真假 */
  evalSkipped: boolean;
  results: Record<string, ViewEvaluatorResult>;
}

/** 一个环节的视图形态：三条通路（S3 全量 / DDB 摘要 / 旧归档）的差异
 *  在归一化层吃掉，只留渲染点真读的这几样。 */
export interface ViewStage {
  type: string;
  /** 规则 2（"" 与 null 在这里同义：都不画那行错误备注） */
  error: string | null;
  /** dataset ?? cases_dataset，归一化后（"" = 没有数据集来源） */
  source: string;
  /** stageScore：observe overall_mean / dataset pass_rate / 旧 score */
  score: number | null;
  /** 明细条数优先，退回 DDB 摘要的聚合数字 */
  count: number;
  /** 红队口径是攻破数不是分（规则 3：数值位透传） */
  breached?: number;
  attacks?: number;
  sessions: ViewSession[];
  entries: ViewEntry[];
}

/** metabar 那一条的视图形态：文本位归一化 + 数值位双读，每个值算一次。
 *  综合报告正文不在这里 —— 它是独立折叠块，分节归一化走 synthSectionsOf
 *  （synthesis_sections 优先，缺则按 `## ` 切 plan_synthesis）。 */
export interface ViewRunMeta {
  score: number | null;
  cost: number | null;
  triggeredBy: string;
  synthesisError: string;
}

/** 一行运行历史（`_run_from_item` 的产物）。
 *
 *  ⚠️ **「空值」不等于「没取」**（R2-E 附议题，v61 验收发现）：
 *  `_run_from_item`（planrun.py:1395）是**所有** run 列表通路共用的读取函数，
 *  它无条件产出 `overview` / `plan_synthesis` / `proposals` 三个键，缺属性时
 *  给的是**静态空值**——`json.loads(None or "{}")` → `{}`、`"[]"` → `[]`、
 *  `item.get("plan_synthesis") or None` → None。而 `list_recent_runs`
 *  （planrun.py:1249 的 ProjectionExpression，工作台/Agent 详情/大屏那条 feed）
 *  **刻意不投影这三块**（摘要项里 plan_synthesis 是 2-4KB 综合报告全文）。
 *  两件事叠起来的后果：那条 feed 上这三个键恒为空值，而空值与「这个 run 真的
 *  没有 overview」在形状上**无法区分**。
 *
 *  对本页零影响：左栏走 `list_plan_runs`，那条**不投影**（方案页要
 *  plan_synthesis 免拉 S3，planrun.py:1135 注释自证），三个键都是真值。
 *  记在这里是给下一个消费方的警告：**别拿这三个键的空值下结论**（「这个 run
 *  没跑出结论」「没有改进建议」都推不出来），要么改读不投影的通路，要么让后端
 *  在那条 feed 上真把键去掉。
 *
 *  为什么这批不「真砍键」（保留静默空值 + 文档语义，零行为变化）：
 *    1. 后端已有守卫钉的正是**键集合一致**：
 *       tests/test_r2_core_projection.py::test_every_other_field_is_byte_
 *       identical_to_a_full_read 断言 `set(投影读) == set(整项读)`，注释写着
 *       「键集合必须一模一样」——它存在的目的是「新字段不许在这条 feed 里悄悄
 *       变成缺省值」。真砍键会把这条守卫反过来
 *    2. `_run_from_item` **区分不出**「被投影掉」与「老 item 压根没这个属性」
 *       （DDB 两种情况都只是属性不在）。按缺失砍键会连**整项读**老归档一起砍，
 *       动到真在读这三个键的通路（方案页/综合报告）
 *    3. 同一模块的写侧契约就是「键恒在」：`_ITEM_EMPTY_BLOBS`（planrun.py:720）
 *       明说「空 blob 四件是读取契约的一部分，任何一路都得带」，读侧砍键与它矛盾
 *    4. 眼下零消费方：那条 feed 的三个前端类型（workbench/agents/bigscreen 的
 *       types.ts）根本没声明这三个键 —— 两义是潜在的，不是活的
 *  真要修，是后端改动（不在本批白名单），留账建议：让投影通路走**另一个**
 *  构造出口（或把投影键集合传进 `_run_from_item`），用「不产出键」表达「没取」，
 *  并在同一 commit 里改上面那条键集合守卫。 */
export interface PlanRunListItem {
  run_key: string;
  status: string;
  /** 顶层分 = observe 环节均分（planrun.py:_persist 只在有 observe
   *  overall_mean 时写）；纯回归/纯红队 run 恒 null。判「完成/失败」看
   *  stage_summaries，见 lib/scoring.ts runOutcome。 */
  score: number | null;
  /** 带 " UTC" 后缀；历史 item 可能为 "" */
  started_at?: string;
  /** 历史 item 无 epoch → null */
  duration_s?: number | null;
  triggered_by?: string;
  skip_reason?: string | null;
  /** list_plan_runs 走 _run_from_item，**每行都带**环节摘要（老归档为 []）。
   *  此前本页类型漏声明了它，于是左栏 run 列表只能按顶层 status 画 badge。 */
  stage_summaries?: RunStage[];
  /**
   * 这条 running 的执行进程是否已可判定停止（UI-029 批 2/3 的读侧字段）。
   *
   * **判定只在后端一份**：`app/stalecheck.py:is_stale` 的三级判据（心跳 → 预估时长
   * → 8h 天花板），`planrun.py:_run_from_item` 读时算好附上来。本页**零判定逻辑、
   * 只消费这个布尔** —— 自己再按心跳算一遍就等于把判据抄成第二份（reaper、读侧、
   * 将来的并发闸门共用的正是那一份）。
   *
   * 此前本页漏声明它，于是同一条陈旧 run 在方案详情页显示「疑似中断」、在这里仍
   * 显示「运行中」——同一个事实两处两句话。展示投影是
   * `lib/scoring.STALE_RUNNING_BADGE`（不进 STATUS_LABEL：它不是后端的 run
   * status，塞进去会把 ADR-0003 定型的五态变成六态）。**改判落库归 reaper**，
   * 前端只显示。终态 run 恒 false；缺键（更老的响应）按 false 处理，绝不自己补判。
   */
  stale?: boolean;
}

export type PlanRunsEvent = {
  event: "plan_runs";
  plan_id: string;
  runs: PlanRunListItem[];
};
