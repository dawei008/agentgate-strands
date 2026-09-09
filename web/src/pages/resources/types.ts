// 资源库页共享类型 —— 形状与后端契约（app/main.py + app/catalog.py）一一对应。

export interface EvaluatorBlocks {
  goal: string;
  checks: string[];
  /** 分块评分档位。档位描述**两个字段都要兜**：后端 mock 里叫 desc，
   *  产品前端统一用 criteria。 */
  bands: { score: number; criteria?: string; desc?: string }[];
}

export interface CustomEvaluator {
  name: string;
  rubric: string;
  scope: "all" | "observe" | "dataset";
  created_at: number;
  updated_at: number;
  blocks: EvaluatorBlocks | null;
}

export type EvaluatorsEvent = {
  event: "evaluators";
  available: string[];
  dataset_only: string[];
  multimodal: string[];
  scopes: Record<string, string[]>;
  /** 内置评估器 -> 一句中文描述（app/registry.py evaluator_descriptions()）。
   *  可选：老后端没这键 ⇒ 描述列整列「—」优雅降级，不崩。 */
  descriptions?: Record<string, string>;
  custom: CustomEvaluator[];
  default: string[];
};

// ---------- 数据集 ----------
export interface DatasetCase {
  name?: string;
  input?: string;
  expected_output?: string;
  task_description?: string;
  image_key?: string;
  /** 模拟任务：最大对话轮次（缺省按 5 处理，与 app/testrun.py 一致） */
  max_turns?: number;
  /** 模拟任务：模拟用户人设（可选） */
  persona?: string;
  [k: string]: unknown;
}

export interface Dataset {
  name: string;
  case_count: number;
  cases: DatasetCase[];
  kind: "regression" | "redteam" | "simulation";
  target_agent: string;
  risk_categories: string[];
  updated_at: number;
}

export type DatasetsEvent = {
  event: "datasets";
  datasets: Dataset[];
};

/** AI 生成用例/任务（generate_dataset）最终事件——形状实测自 app/main.py:835 */
export type DatasetGeneratedEvent = {
  event: "dataset_generated";
  cases: DatasetCase[];
  agent_context_used: boolean;
  /** 附件解析说明（"xx.pdf: 已解析 1234 字符" / "（yy 超过 5MB，已跳过）"） */
  attachments: string[];
  source_keys: string[];
  /** 请求侧形态锁的回执（app/main.py:889）：本次按哪种形态生成 */
  case_shape: "single" | "multi" | null;
  /** 兜底校验剥掉的字段计数（single 剥多轮字段时累加，app/main.py:859-865）。
      仅诊断用途，前端目前不展示——声明出来是为了让三方（后端/mock/TS）同刑，
      避免下一个消费者按「字段不存在」写代码。 */
  stripped_fields: number;
  extend_dataset: string | null;
  existing_cases: DatasetCase[] | null;
};

// ---------- 红队 ----------

/** 真 SDK DEFAULT_SEVERITY 的值域（strands_evals.experimental.redteam.types）：
 *  当前只有 high / critical 两种。"medium" 是 app/redteam.py 对未知类别的
 *  兜底缺省（`DEFAULT_SEVERITY.get(k, "medium")`），保留在联合里但真类别不会用到。 */
export type RedteamSeverity = "high" | "critical" | "medium";

export type RedteamOptionsEvent = {
  event: "redteam_options";
  risk_categories: Record<string, { description: string; severity: RedteamSeverity }>;
  default_risk_categories: string[];
  /** 真值 0.3（redteam.py BREACH_THRESHOLD）；与 plan/types.ts 的同名事件
   *  统一为可选——两处此前一处必填一处可选，形状对不上。 */
  breach_threshold?: number;
};

export interface RedteamCase {
  name: string;
  input: string;
  risk_category: string;
  actor_goal?: string;
  context?: string;
  severity?: RedteamSeverity;
  success_criteria?: string;
  [k: string]: unknown;
}

/** 实测事件名：redteam_cases_generated（app/main.py），非任务书的 redteam_cases */
export type RedteamCasesGeneratedEvent = {
  event: "redteam_cases_generated";
  cases: RedteamCase[];
  risk_categories: string[];
  failed_categories: string[];
};

export type RedteamGenProgressEvent = {
  event: "redteam_gen_progress";
  risk_category: string;
  cases: number;
  error: string | null;
  done: number;
  total: number;
};
