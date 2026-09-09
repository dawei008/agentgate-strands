// 方案编辑器（M4）：#/plan/new 新建与 #/plan/:id/edit 编辑复用同一表单。
// 名称 / Agent 下拉(discover) / 环节卡（UI 四类：线上评估|回归|模拟|红队，可增删）/ schedule cron。
// 保存 → save_plan → plan_saved → 跳详情页。
// UI 四类/存储三类（原型 regression-split README 问题4定案）：模拟环节产出的仍是
// {type:"dataset"}，靠 dataset 指向集合的归类（lib/datasetSide 双读）决定显示哪张卡。
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import { isSimulationSide } from "../../lib/datasetSide";
import { navigate } from "../../router";
import type {
  AgentsEvent, DatasetLite, DatasetsEvent, EvaluatorsEvent,
  Plan, PlansEvent, PlanSavedEvent, PlanSchedule, PlanStage, RedteamOptionsEvent, StageType,
} from "./types";
import "./plan.css";
import PageHeader from "../../components/layout/PageHeader";
import SchedulePicker from "./SchedulePicker";
import { normalizeSchedule } from "./cronEngine";

/** UI 四类：simulation 只存在于表现层，存储层仍是三类 StageType */
export type StageUiKind = StageType | "simulation";

export const STAGE_UI_LABEL: Record<StageUiKind, string> = {
  observe: "线上评估",
  dataset: "回归测试",
  simulation: "模拟测试",
  redteam: "红队测试",
};

/** UI 四类 → 存储三类：模拟环节落回 type:"dataset"（后端 per-case 分派，无需新环节类型） */
export function stageTypeForUiKind(kind: StageUiKind): StageType {
  return kind === "simulation" ? "dataset" : kind;
}

/** 环节显示为哪张卡：dataset 环节按其 dataset 指向集合的归类决定（双读）；
    找不到集合时用添加时的意图（simHint，[+ 模拟测试] 加的空卡），再兜底回归卡。 */
export function stageUiKind(stage: PlanStage, datasets: DatasetLite[], simHint = false): StageUiKind {
  if (stage.type !== "dataset") return stage.type;
  const ds = datasets.find((d) => d.name === stage.dataset);
  if (ds) return isSimulationSide(ds) ? "simulation" : "dataset";
  return simHint ? "simulation" : "dataset";
}

/**
 * 评估器 scope 过滤：环节类型 → 可选评估器名单。
 * 内置按 scopes[name] 数组 includes；自定义按 scope 字符串（"all" 通吃）；
 * dataset_only 名单只进 dataset 环节（其 scopes 本身就是 ["dataset"]，双保险）。
 */
export function evaluatorsForStage(data: EvaluatorsEvent, stageType: StageType): string[] {
  const builtin = [...data.available, ...data.dataset_only, ...data.multimodal]
    .filter((name) => {
      if (data.dataset_only.includes(name) && stageType !== "dataset") return false;
      const scopes = data.scopes[name];
      return Array.isArray(scopes) ? scopes.includes(stageType) : true;
    });
  const custom = data.custom
    .filter((c) => c.scope === "all" || c.scope === stageType)
    .map((c) => c.name);
  return [...custom, ...builtin];
}

/** 悬空数据集引用：环节引用的集合名非空且不在对应候选名单中（集合已被删除）。
    返回悬空的集合名；无悬空返回 null。redteam 看 cases_dataset，dataset 看 dataset。 */
export function missingDatasetName(stage: PlanStage, candidates: DatasetLite[]): string | null {
  const name = stage.type === "redteam" ? stage.cases_dataset : stage.dataset;
  if (!name) return null;
  return candidates.some((d) => d.name === name) ? null : name;
}

/** 指标 chip 中文标签（照旧版 app.js metricChipsHtml 的 labels；未知 key 显示原名） */
export const METRIC_LABELS: Record<string, string> = {
  tokens: "Token", cost: "预估成本", latency: "延迟", llm_calls: "LLM 调用", tool_calls: "工具调用",
};

/** 环节区 DOM id：保存被 0 环节拦下时把焦点送到这里的首个「+ 添加环节」按钮
    （用户点名「错误出现后焦点丢失」——报错不能只出文字不给去处）。 */
export const STAGES_AREA_ID = "plan-form-stages";

/** 缺项提示的 DOM id：保存按钮用 aria-describedby 指过来，读屏用户也知道为何禁用 */
export const STAGES_HINT_ID = "plan-form-stages-required";

/** 焦点送到环节区：优先首个添加按钮（能直接动手解决问题），退回区域容器本身。
    返回是否成功送出——供保存拦截路径判断，也让这段行为可被单测直接验证。 */
export function focusStagesArea(root: ParentNode = document): boolean {
  const area = root.querySelector(`#${STAGES_AREA_ID}`);
  const target = area?.querySelector<HTMLElement>("[data-stage-add]") ?? (area as HTMLElement | null);
  if (!target) return false;
  target.focus();
  return true;
}

/** 数字输入失焦收口到后端约束区间（min/max 属性挡不住手输超界值） */
export function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/** 空环节模板。模拟环节 type 仍是 "dataset"，用仅表现层的 _ui 标记记住添加意图
    （还没选集合时卡片显示为模拟卡）；保存前 stripUiMarker 剥掉，不进存储。 */
function emptyStage(kind: StageUiKind, ev?: EvaluatorsEvent): PlanStage {
  const type = stageTypeForUiKind(kind);
  const base: PlanStage = { type, evaluators: [] };
  if (type === "observe") {
    // 会话范围默认值照旧版 app.js:1335-1336：回看 30 天、最多 10 会话、
    // 评估器/指标取 evaluators 元数据里的默认名单。include_test 缺省不发 = 后端 .get 默认 false。
    base.lookback_days = 30;
    base.max_sessions = 10;
    base.evaluators = [...(ev?.default ?? [])];
    base.metrics = [...(ev?.default_metrics ?? ev?.metrics ?? [])];
  }
  if (type === "dataset") base.dataset = "";
  if (type === "redteam") base.cases_dataset = "";
  if (kind === "simulation") base._ui = "simulation";
  return base;
}

/** 保存前剥掉表现层标记：请求体里的环节仍是纯三类形状。
    同时剥掉空的 strategies——缺失字段 = 后端跟随默认名单（planrun.py:93
    `st.get("strategies") or DEFAULT_STRATEGIES`）；发空数组虽然语义等价，
    但缺失才是「跟随默认」的规范表达，也免得存量数据混两种形态。 */
export function stripUiMarker(stages: PlanStage[]): PlanStage[] {
  return stages.map((s) => {
    let out = s;
    if ("_ui" in out) {
      const { _ui, ...rest } = out;
      void _ui;
      out = rest as PlanStage;
    }
    if (Array.isArray(out.strategies) && out.strategies.length === 0) {
      const { strategies, ...rest } = out;
      void strategies;
      out = rest as PlanStage;
    }
    return out;
  });
}

// ---------- 新建预选 Agent（Agent 详情页「+ 新建方案」入口） ----------
// hash 路由的 parseHash 不解析 query，改造它波及全部路由测试；改用 sessionStorage
// 一次性传递：写入 → navigate("#/plan/new") → 编辑器挂载时取走并即刻清除
// （一次性消费，刷新/直进 #/plan/new 不会残留预选）。
const PRESET_AGENT_KEY = "plan_new_preset_agent";

/** 编辑回填兼容三种历史形态（存量 DDB 可能有旧字符串数据）：
    - 对象 {cron, budget_usd}：契约形态，原样用
    - 字符串：旧版前端存的裸 cron → 按 {cron, budget_usd: 0} 回填，
      预算置 0 触发 SchedulePicker 的补预算提示（保存会被就地拦截直到补上）
    - null/缺省/空串：仅手动 */
export function coerceSchedule(raw: Plan["schedule"]): PlanSchedule | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    return raw.trim() ? { cron: raw, budget_usd: 0 } : null;
  }
  const cron = typeof raw.cron === "string" ? raw.cron : "";
  if (!cron.trim()) return null;
  return { cron, budget_usd: Number(raw.budget_usd) || 0 };
}

/** 跳新建编辑器前调用：记下要预选的 agent_name */
export function presetPlanAgent(agentName: string): void {
  try { sessionStorage.setItem(PRESET_AGENT_KEY, agentName); } catch { /* ignore */ }
}

/** 编辑器初始化时读取预选值。不在这里删——StrictMode 会双调 useState 初始化器，
    读后即清会让第二次调用拿到空串；清除放挂载 effect（幂等）。 */
function peekPresetPlanAgent(): string {
  try {
    return sessionStorage.getItem(PRESET_AGENT_KEY) ?? "";
  } catch {
    return "";
  }
}

/** 把刚保存的方案并进 ["plans"] 缓存：同 plan_id 就地替换（编辑），否则追加（新建）。
    缓存还没建立时不凭空造——写个只含该方案的列表会让详情页拿到「只有一个方案」的
    假名单（工作台/导航计数跟着读同一份），交给详情页自己的 fetch 拿全量。 */
function mergePlanIntoCache(qc: ReturnType<typeof useQueryClient>, saved: Plan): void {
  qc.setQueryData<PlansEvent>(["plans"], (prev) => {
    if (!prev) return prev;
    const plans = prev.plans ?? [];
    const at = plans.findIndex((p) => p.plan_id === saved.plan_id);
    return {
      ...prev,
      plans: at >= 0
        ? plans.map((p, i) => (i === at ? saved : p))
        : [...plans, saved],
    };
  });
}

/** `presetDataset` = `#/plan/new?dataset=<name>`（入集抽屉「为它建评估计划」）；名单里有同名项才预填，没有 ⇒ 照旧空表单 */
export default function PlanEditor({ plan, presetDataset }: { plan?: Plan; presetDataset?: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState(plan?.name ?? "");
  // 新建时若从 Agent 详情页进来，预选该 Agent（下拉仍可改——预选不是锁定，
  // 用户仍可能想给别的 Agent 建方案）
  const [agentName, setAgentName] = useState(() => plan?.agent_name ?? peekPresetPlanAgent());
  // 一次性消费：挂载即清，刷新/下次直进 #/plan/new 不残留预选
  useEffect(() => {
    try { sessionStorage.removeItem(PRESET_AGENT_KEY); } catch { /* ignore */ }
  }, []);
  const [schedule, setSchedule] = useState<PlanSchedule | null>(() => coerceSchedule(plan?.schedule));
  // 只用上报数据评估（ADR-0019；2026-09-08 用户决定默认开）：新建默认勾选，旧方案缺键也按开
  // 回填（后端 plan.trace_required() 缺键 = 开）；只有显式 false 才是关。请求体两态都显式带键——
  // 关着不带键会被后端读成开。
  const [traceRequired, setTraceRequired] = useState<boolean>(plan?.trace_required !== false);
  const [stages, setStages] = useState<PlanStage[]>(plan?.stages ?? []);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // UI-010：0 环节时才需要的就地提示。不一进页面就红——新建页天然 0 环节，
  // 那是待办不是错误；只有用户试过保存（或曾有环节后删空）才升为红色缺项提示。
  const [stagesTouched, setStagesTouched] = useState(false);

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiOne<AgentsEvent>({ action: "discover" }, "agents"),
  });
  const evaluatorsQuery = useQuery({
    queryKey: ["evaluators"],
    queryFn: () => apiOne<EvaluatorsEvent>({ action: "evaluators" }, "evaluators"),
  });
  const datasetsQuery = useQuery({
    queryKey: ["datasets"],
    queryFn: () => apiOne<DatasetsEvent>({ action: "list_datasets" }, "datasets"),
  });
  // 红队攻击策略菜单（app/main.py:981-987）：strategies 是全量菜单，
  // default_strategies 仅用于提示文案——不预填成显式选中（否则语义从
  // 「跟随默认」变成「锁死当前默认」）
  const redteamOptionsQuery = useQuery({
    queryKey: ["redteam-options"],
    queryFn: () => apiOne<RedteamOptionsEvent>({ action: "redteam_options" }, "redteam_options"),
  });

  const allDatasets = useMemo(
    () => datasetsQuery.data?.datasets ?? [],
    [datasetsQuery.data],
  );
  // 两卡下拉互斥：回归卡只列固定侧集合，模拟卡只列模拟侧集合（双读归类）
  const regressionSets = useMemo(
    () => allDatasets.filter((d) => d.kind === "regression" && !isSimulationSide(d)),
    [allDatasets],
  );
  const simulationSets = useMemo(
    () => allDatasets.filter((d) => isSimulationSide(d)),
    [allDatasets],
  );
  const redteamSets = useMemo(
    () => allDatasets.filter((d) => d.kind === "redteam"),
    [allDatasets],
  );
  // 「已删除」判定的就绪闸门：必须**有数据且不在取新数据**。只判「有数据」时，
  // 陈旧 datasets 缓存会让 ready 立刻为 true，missingDatasetName 拿旧名单把
  // 实际存在的集合误判成「（已删除）」，新数据回来又自动消失——用户在新建方案时
  // 亲眼撞见的闪现。宁可暂不提示，也不能误报「已删除」（悬空提示是真能力，
  // 只是推迟到名单新鲜后再判）。
  const datasetsReady = Boolean(datasetsQuery.data) && !datasetsQuery.isFetching;

  // ---- `#/plan/new?dataset=<name>` 预填（入集抽屉「为它建评估计划」）----
  // 名单里有同名项 ⇒ 按它的归类加一个环节并选中它（回归 / 模拟 / 红队三卡各归其位）；
  // 计划名默认 `<agent> · 坏例回归`，agent 取集合的 target_agent，取不到再从默认集名
  // `<agent>-badcases[-rt]`（report/badcase.ts defaultDatasetName 的逆）推；都推不出就留空。
  // 没有同名项 ⇒ 不预填、不报错（表单与直进 #/plan/new 逐字相同）。只在还没有任何环节时加，
  // 且同一个名字只应用一次——用户已经动手的表单不许被覆盖。编辑态（有 plan）忽略。
  const presetAppliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (plan || !presetDataset || !datasetsQuery.data) return;
    if (presetAppliedFor.current === presetDataset) return;
    presetAppliedFor.current = presetDataset;
    const ds = allDatasets.find((d) => d.name === presetDataset);
    if (!ds) return;
    const kind: StageUiKind = ds.kind === "redteam" ? "redteam" : isSimulationSide(ds) ? "simulation" : "dataset";
    const stage = emptyStage(kind, evaluatorsQuery.data);
    if (kind === "redteam") stage.cases_dataset = ds.name; else stage.dataset = ds.name;
    setStages((prev) => (prev.length === 0 ? [stage] : prev));
    const agent = (ds.target_agent ?? "").trim() || (/^(.+)-badcases(?:-rt)?$/.exec(ds.name)?.[1] ?? "");
    if (agent) {
      setName((cur) => cur || `${agent} · 坏例回归`);
      setAgentName((cur) => cur || agent);
    }
  }, [plan, presetDataset, datasetsQuery.data, allDatasets, evaluatorsQuery.data]);

  function updateStage(index: number, patch: Partial<PlanStage>) {
    setStages((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }
  function removeStage(index: number) {
    setStages((prev) => prev.filter((_, i) => i !== index));
  }
  function addStage(kind: StageUiKind) {
    setStages((prev) => [...prev, emptyStage(kind, evaluatorsQuery.data)]);
  }

  async function onSave() {
    // UI-010：0 环节的保存必然被后端拒（「方案至少要有一个环节」）。按钮已按
    // canSave 禁用，这里是第二道闸——键盘/程序化触发也不发注定失败的请求，
    // 且就地提示 + 把焦点送到环节区（用户点名报错后焦点丢失，无处下手）。
    if (stages.length === 0) {
      setStagesTouched(true);
      focusStagesArea();
      return;
    }
    setSaving(true);
    setSaveError(null);
    // 定时归一/拦截：仅手动发 null；rate(...) 直通；合法 cron 归一为 EventBridge
    // cron(...) 形态（plansched.py 原样直传 ScheduleExpression，裸五段会被
    // Scheduler 拒收）；非法表达式在此拦下，不发请求。
    // 定时档预算 ≤0 同样拦截（后端契约 app/plan.py:114-117 强制 budget_usd>0，
    // 前端就地提示比 400 原文友好）。
    let schedBody: PlanSchedule | null = null;
    if (schedule) {
      const sched = normalizeSchedule(schedule.cron);
      if (!sched.ok) {
        setSaveError(`定时表达式非法：${sched.err}`);
        setSaving(false);
        return;
      }
      if (!(schedule.budget_usd > 0)) {
        setSaveError("启用定时必须设置单次预算上限（USD，>0）——请在定时卡里补上预算");
        setSaving(false);
        return;
      }
      // 归一后空串（用户在高级档清空文本再保存）视同仅手动
      schedBody = sched.value ? { cron: sched.value, budget_usd: schedule.budget_usd } : null;
    }
    // 悬空数据集预检：任一环节引用已删除的集合 → 就地拦截不发请求
    // （文案与后端 app/plan.py:105 同款，环节号 1 起）。闸门用 datasetsReady：
    // 名单没加载完（空名单会误杀合法引用）或正在取新数据（陈旧名单会把存在的
    // 集合误判成已删除、白拦一次合法保存）都不预检——交给后端校验兜底。
    for (let i = 0; datasetsReady && i < stages.length; i++) {
      const stage = stages[i];
      const candidates = stage.type === "redteam"
        ? redteamSets
        : stageUiKind(stage, allDatasets, stage._ui === "simulation") === "simulation"
          ? simulationSets
          : regressionSets;
      const missing = missingDatasetName(stage, candidates);
      if (missing) {
        setSaveError(`环节 ${i + 1}：数据集 '${missing}' 不存在——请先在数据集页重建，或移除此环节`);
        setSaving(false);
        return;
      }
    }
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        agent_name: agentName,
        stages: stripUiMarker(stages),
        schedule: schedBody,
      };
      body.trace_required = traceRequired;
      if (plan?.plan_id) body.plan_id = plan.plan_id;
      const saved = await apiOne<PlanSavedEvent>(
        { action: "save_plan", plan: body },
        "plan_saved",
      );
      // UI-009：跳详情页前把刚保存的方案写进缓存，保证详情页**首帧就有数据**。
      // 光 invalidateQueries 不够——["plans"] 在本页（新建时）没有活跃观察者，
      // 对无观察者的 query 不触发 refetch、立即 resolve，缓存里留着不含新方案的
      // 旧列表，详情页 isLoading=false 直落 !plan 闪现「找不到方案」。
      // 顺序是先 invalidate 再 setQueryData：list_plans 可能读到最终一致性尚未
      // 收敛的旧列表，把它盖回我们刚确知的事实上，否则刷回来的旧列表又会闪。
      await qc.invalidateQueries({ queryKey: ["plans"] });
      mergePlanIntoCache(qc, saved.plan);
      navigate(`#/plan/${encodeURIComponent(saved.plan.plan_id)}`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  // UI-010：环节数 0 时禁用保存。此前只算名称/Agent，用户点下去要等一趟后端
  // 往返才知道「方案至少要有一个环节」——注定失败的提交不该放行。
  const canSave = name.trim() !== "" && agentName !== "" && stages.length > 0 && !saving;
  /** 0 环节的缺项提示：仅在用户试过保存后升红（新建页初始 0 环节是待办不是错误） */
  const stagesMissing = stages.length === 0 && stagesTouched;

  return (
    <section data-testid="page-plan-editor">
      <PageHeader
        back={
          plan
            ? { label: "评估计划详情", to: `#/plan/${encodeURIComponent(plan.plan_id)}` }
            : { label: "评估计划", to: "#/workbench" }
        }
        title={plan ? "编辑评估计划" : "新建评估计划"}
        sub={plan ? <span className="mono">{plan.plan_id}</span> : undefined}
      />

      <div className="card">
        <div className="card-head"><span className="card-title">基本信息</span></div>
        <div className="card-body plan-editor-grid">
          <div>
            <label className="u-label" htmlFor="plan-form-name">评估计划名称</label>
            <input
              id="plan-form-name"
              className="u-input"
              data-testid="plan-form-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：FAQ 周回归"
            />
          </div>
          <div>
            <label className="u-label" htmlFor="plan-form-agent">目标 Agent</label>
            <select
              id="plan-form-agent"
              className="u-select mono"
              data-testid="plan-form-agent"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
            >
              <option value="">选择 Agent…</option>
              {(agentsQuery.data?.agents ?? []).map((a) => (
                <option key={a.agent_name} value={a.agent_name}>{a.agent_name}</option>
              ))}
            </select>
          </div>
          <label
            className="plan-editor-toggle"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, height: "var(--h-control)", alignSelf: "end" }}
            title="打开后，CloudWatch 里没有 Agent 上报 trace 的用例不评分"
            data-testid="plan-form-trace-required-label"
          >
            <input
              type="checkbox"
              data-testid="plan-form-trace-required"
              checked={traceRequired}
              onChange={(e) => setTraceRequired(e.target.checked)}
            />
            只用上报数据评估
          </label>
        </div>
      </div>

      {/* 定时选择器：三档（仅手动｜简单定时｜高级），替代原 cron 裸输入框 */}
      <SchedulePicker value={schedule} onChange={setSchedule} />

      <div className="card" id={STAGES_AREA_ID}>
        <div className="card-head">
          <span className="card-title">评估环节</span>
          <span className="card-count" data-testid="plan-form-stage-count">{stages.length}</span>
          <span className="spacer" />
          {(["observe", "dataset", "simulation", "redteam"] as StageUiKind[]).map((k) => (
            <button
              key={k}
              type="button"
              className="btn ghost mini"
              // data-stage-add 是 focusStagesArea 的落点选择器：保存被 0 环节拦下时
              // 焦点送到首个添加按钮，用户当场就能动手补环节
              data-stage-add=""
              data-testid={`plan-form-add-${k}`}
              onClick={() => addStage(k)}
            >
              + {STAGE_UI_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="card-body">
          {stages.length === 0 && (
            <>
              <p className="subtle" data-testid="plan-form-stages-empty">
                还没有环节
              </p>
              {/* UI-010 就地提示：恒显「为什么存不了」——保存按钮此刻是禁用的，
                  光禁用不说理由等于哑掉。试过保存后升为红色 alert。 */}
              <p
                id={STAGES_HINT_ID}
                className={stagesMissing ? "plan-editor-error" : "subtle"}
                data-testid="plan-form-stages-required"
                role={stagesMissing ? "alert" : undefined}
              >
                至少添加一个评估环节才能保存。
              </p>
            </>
          )}
          {stages.map((stage, i) => (
            <StageCard
              key={i}
              index={i}
              stage={stage}
              agentName={agentName}
              evaluators={evaluatorsQuery.data}
              redteamOptions={redteamOptionsQuery.data}
              datasetsReady={datasetsReady}
              allDatasets={allDatasets}
              regressionSets={regressionSets}
              simulationSets={simulationSets}
              redteamSets={redteamSets}
              onChange={(patch) => updateStage(i, patch)}
              onRemove={() => removeStage(i)}
            />
          ))}
        </div>
      </div>

      <div className="plan-editor-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="plan-form-save"
          disabled={!canSave}
          // 禁用原因可及：0 环节时把按钮指向环节区的缺项提示
          aria-describedby={stages.length === 0 ? STAGES_HINT_ID : undefined}
          onClick={onSave}
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          className="btn ghost"
          data-testid="plan-form-cancel"
          onClick={() =>
            navigate(plan ? `#/plan/${encodeURIComponent(plan.plan_id)}` : "#/workbench")}
        >
          取消
        </button>
        {saveError && (
          <span className="plan-editor-error" data-testid="plan-form-error">{saveError}</span>
        )}
      </div>
    </section>
  );
}

// ---------- 环节卡 ----------
function StageCard({
  index, stage, agentName, evaluators, redteamOptions, datasetsReady, allDatasets,
  regressionSets, simulationSets, redteamSets, onChange, onRemove,
}: {
  index: number;
  stage: PlanStage;
  agentName: string;
  evaluators: EvaluatorsEvent | undefined;
  redteamOptions: RedteamOptionsEvent | undefined;
  datasetsReady: boolean;
  allDatasets: DatasetLite[];
  regressionSets: DatasetLite[];
  simulationSets: DatasetLite[];
  redteamSets: DatasetLite[];
  onChange: (patch: Partial<PlanStage>) => void;
  onRemove: () => void;
}) {
  const type = stage.type;
  // UI 四类：dataset 环节按其集合归类显示为回归卡或模拟卡（编辑回填也走这里；
  // 集合还没选/找不到时按添加意图 _ui 兜底，再兜回归卡）
  const uiKind = stageUiKind(stage, allDatasets, stage._ui === "simulation");
  // 过滤名单 ∪ 已选：老方案里选过但被 scope 过滤掉的评估器仍要可见/可取消。
  // 评估器 scope 按存储 type 过滤——回归卡/模拟卡同为 dataset scope，名单一致（后端跑法相同）。
  const options = useMemo(() => {
    const filtered = evaluators ? evaluatorsForStage(evaluators, type) : [];
    return [...new Set([...filtered, ...stage.evaluators])];
  }, [evaluators, type, stage.evaluators]);
  // 指标选项 ∪ 已选：老方案里选过但元数据已下架的指标 key 仍要可见/可取消（与评估器同策略）
  const metricOptions = useMemo(() => {
    const fromMeta = evaluators?.metrics ?? [];
    return [...new Set([...fromMeta, ...(stage.metrics ?? [])])];
  }, [evaluators, stage.metrics]);
  // 攻击策略选项 ∪ 已选：老方案里选过但菜单已下架的策略名仍要可见/可取消（与评估器/指标同策略）
  // 菜单元素是 {name, label, desc, ...} 对象（app/redteam.py:129），此处统一压成
  // {name, label} —— 保存进方案的只有 name 字符串，label 仅供显示。
  const strategyOptions = useMemo(() => {
    const byName = new Map<string, { name: string; label: string }>();
    for (const s of redteamOptions?.strategies ?? []) {
      if (s?.name) byName.set(s.name, { name: s.name, label: s.label || s.name });
    }
    // 已选但菜单里没有的（后端下架）：仍列出，用 name 兜底显示，用户可取消
    for (const name of stage.strategies ?? []) {
      if (!byName.has(name)) byName.set(name, { name, label: name });
    }
    return [...byName.values()];
  }, [redteamOptions, stage.strategies]);

  /** 悬空引用：环节引用的集合已被删除（不在对应候选名单中）。下拉保留
      disabled 的「{原名}（已删除）」选项不静默丢值，卡内红行警示，保存被前端预检拦截。
      名单加载完之前不判——空名单会把合法引用误报成已删除。 */
  const missingName = datasetsReady
    ? missingDatasetName(
      stage,
      type === "redteam" ? redteamSets : uiKind === "simulation" ? simulationSets : regressionSets,
    )
    : null;

  /** 血统警示：红队用例集 target_agent 非空且 ≠ 当前 agent（就地提示，不阻断） */
  const selectedRedteam = type === "redteam"
    ? redteamSets.find((d) => d.name === stage.cases_dataset)
    : undefined;
  const lineageMismatch =
    selectedRedteam?.target_agent && agentName && selectedRedteam.target_agent !== agentName
      ? selectedRedteam.target_agent
      : null;

  function toggleEvaluator(name: string) {
    const has = stage.evaluators.includes(name);
    onChange({
      evaluators: has
        ? stage.evaluators.filter((e) => e !== name)
        : [...stage.evaluators, name],
    });
  }
  function toggleMetric(key: string) {
    const cur = stage.metrics ?? [];
    onChange({
      metrics: cur.includes(key) ? cur.filter((m) => m !== key) : [...cur, key],
    });
  }
  function toggleStrategy(name: string) {
    const cur = stage.strategies ?? [];
    onChange({
      strategies: cur.includes(name) ? cur.filter((s) => s !== name) : [...cur, name],
    });
  }

  return (
    <div className="plan-stage-card" data-testid={`plan-stage-card-${index}`}>
      <div className="plan-stage-card-head">
        <span
          className={`kind ${
            uiKind === "observe" ? "online"
              : uiKind === "dataset" ? "regress"
                : uiKind === "simulation" ? "sim"
                  : "red"
          }`}
          data-testid={`plan-stage-card-${index}-kind`}
        >
          {STAGE_UI_LABEL[uiKind]}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn-link danger"
          data-testid={`plan-stage-card-${index}-remove`}
          onClick={onRemove}
        >
          删除环节
        </button>
      </div>
      <div className="plan-stage-card-body">
        {type === "observe" && (
          <div
            style={{ display: "flex", alignItems: "flex-end", gap: "var(--sp-4)", flexWrap: "wrap" }}
            data-testid={`plan-stage-card-${index}-observe-cfg`}
          >
            <div>
              <label
                className="u-label"
                htmlFor={`plan-stage-${index}-lookback`}
              >
                回看天数
              </label>
              <input
                id={`plan-stage-${index}-lookback`}
                type="number"
                className="u-input num"
                style={{ width: 88 }}
                min={1}
                max={120}
                data-testid={`plan-stage-card-${index}-lookback`}
                value={stage.lookback_days ?? 30}
                onChange={(e) => onChange({ lookback_days: Number(e.target.value) })}
                onBlur={() =>
                  onChange({ lookback_days: clampInt(Number(stage.lookback_days ?? 30), 1, 120) })}
              />
            </div>
            <div>
              <label
                className="u-label"
                htmlFor={`plan-stage-${index}-max-sessions`}
              >
                最多会话
              </label>
              <input
                id={`plan-stage-${index}-max-sessions`}
                type="number"
                className="u-input num"
                style={{ width: 88 }}
                min={1}
                max={50}
                data-testid={`plan-stage-card-${index}-max-sessions`}
                value={stage.max_sessions ?? 10}
                onChange={(e) => onChange({ max_sessions: Number(e.target.value) })}
                onBlur={() =>
                  onChange({ max_sessions: clampInt(Number(stage.max_sessions ?? 10), 1, 50) })}
              />
            </div>
            <label
              style={{ display: "inline-flex", alignItems: "center", gap: 6, height: "var(--h-control)" }}
            >
              <input
                type="checkbox"
                data-testid={`plan-stage-card-${index}-include-test`}
                checked={Boolean(stage.include_test)}
                onChange={(e) => onChange({ include_test: e.target.checked })}
              />
              包含测试会话
            </label>
          </div>
        )}
        {type === "dataset" && uiKind === "dataset" && (
          <div>
            <label className="u-label" htmlFor={`plan-stage-${index}-dataset`}>回归数据集</label>
            <select
              id={`plan-stage-${index}-dataset`}
              className="u-select mono"
              data-testid={`plan-stage-card-${index}-dataset`}
              value={stage.dataset ?? ""}
              onChange={(e) => onChange({ dataset: e.target.value })}
            >
              <option value="">选择数据集…</option>
              {missingName && (
                <option value={missingName} disabled>{missingName}（已删除）</option>
              )}
              {regressionSets.map((d) => (
                <option key={d.name} value={d.name}>{d.name}</option>
              ))}
            </select>
            {missingName && (
              <p className="plan-editor-error" data-testid="stage-missing-dataset">
                引用的数据集「{missingName}」已被删除——请先在数据集页重建，或移除此环节
              </p>
            )}
          </div>
        )}
        {type === "dataset" && uiKind === "simulation" && (
          <div>
            <label className="u-label" htmlFor={`plan-stage-${index}-dataset`}>模拟任务集</label>
            <select
              id={`plan-stage-${index}-dataset`}
              className="u-select mono"
              data-testid={`plan-stage-card-${index}-dataset`}
              value={stage.dataset ?? ""}
              onChange={(e) => onChange({ dataset: e.target.value })}
            >
              <option value="">选择模拟集…</option>
              {missingName && (
                <option value={missingName} disabled>{missingName}（已删除）</option>
              )}
              {simulationSets.map((d) => (
                <option key={d.name} value={d.name}>{d.name}</option>
              ))}
            </select>
            {missingName && (
              <p className="plan-editor-error" data-testid="stage-missing-dataset">
                引用的数据集「{missingName}」已被删除——请先在数据集页重建，或移除此环节
              </p>
            )}
          </div>
        )}
        {type === "redteam" && (
          <div>
            <label className="u-label" htmlFor={`plan-stage-${index}-cases`}>红队用例集</label>
            <select
              id={`plan-stage-${index}-cases`}
              className="u-select mono"
              data-testid={`plan-stage-card-${index}-cases`}
              value={stage.cases_dataset ?? ""}
              onChange={(e) => onChange({ cases_dataset: e.target.value })}
            >
              <option value="">选择用例集…</option>
              {missingName && (
                <option value={missingName} disabled>{missingName}（已删除）</option>
              )}
              {redteamSets.map((d) => (
                <option key={d.name} value={d.name}>{d.name}</option>
              ))}
            </select>
            {missingName && (
              <p className="plan-editor-error" data-testid="stage-missing-dataset">
                引用的数据集「{missingName}」已被删除——请先在数据集页重建，或移除此环节
              </p>
            )}
            {lineageMismatch && (
              <p className="plan-lineage-warn" data-testid={`plan-stage-card-${index}-lineage-warn`}>
                ⚠ 该用例集针对 {lineageMismatch} 生成
              </p>
            )}
          </div>
        )}
        {type === "redteam" && (
          <div>
            <span className="u-label">攻击策略</span>
            <div
              className="plan-eval-picker"
              role="group"
              aria-label="攻击策略多选"
              data-testid={`plan-stage-card-${index}-strategies`}
            >
              {strategyOptions.map((opt) => (
                <button
                  key={opt.name}
                  type="button"
                  className="chip"
                  aria-pressed={(stage.strategies ?? []).includes(opt.name)}
                  data-testid={`plan-stage-card-${index}-strategy-${opt.name}`}
                  onClick={() => toggleStrategy(opt.name)}
                >
                  {opt.label}
                </button>
              ))}
              {redteamOptions && strategyOptions.length === 0 && (
                <span className="subtle">暂无可用策略</span>
              )}
            </div>
            <p className="stage-note" data-testid={`plan-stage-card-${index}-strategies-note`}>
              未选择时使用默认策略集
              {redteamOptions?.default_strategies?.length
                ? `（${redteamOptions.default_strategies.join("、")}）`
                : ""}
              。
            </p>
          </div>
        )}
        <div>
          <span className="u-label">
            评估器
          </span>
          <div
            className="plan-eval-picker"
            role="group"
            aria-label="评估器多选"
            data-testid={`plan-stage-card-${index}-evaluators`}
          >
            {options.map((name) => (
              <button
                key={name}
                type="button"
                className="chip"
                aria-pressed={stage.evaluators.includes(name)}
                data-testid={`plan-stage-card-${index}-eval-${name}`}
                onClick={() => toggleEvaluator(name)}
              >
                {name}
              </button>
            ))}
            {evaluators && options.length === 0 && (
              <span className="subtle">该环节暂无可用评估器</span>
            )}
          </div>
        </div>
        {type === "observe" && (
          <div>
            <span className="u-label">指标</span>
            <div
              className="plan-eval-picker"
              role="group"
              aria-label="指标多选"
              data-testid={`plan-stage-card-${index}-metrics`}
            >
              {metricOptions.map((key) => (
                <button
                  key={key}
                  type="button"
                  className="chip"
                  aria-pressed={(stage.metrics ?? []).includes(key)}
                  data-testid={`plan-stage-card-${index}-metric-${key}`}
                  onClick={() => toggleMetric(key)}
                >
                  {METRIC_LABELS[key] ?? key}
                </button>
              ))}
              {evaluators && metricOptions.length === 0 && (
                <span className="subtle">暂无可用指标</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
