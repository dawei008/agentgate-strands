// 评估器页 + 数据集页测试（2026-08-29 资源库拆页，用例原样保留、按块分头渲染）：
// 评估器筛选/排序/分块表单拼 prompt/请求体形状、四 tab 切换、kind 过滤、
// 红队生成流式+保存、线上 tab 一句话、B 案形态护栏。
// fetch 打桩方式与 settings.test.tsx 一致（stubGlobal + SSE Response）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { expectProseGone } from "./prose";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import EvaluatorsPage from "../src/pages/resources/EvaluatorsPage";
import DatasetsPage from "../src/pages/resources/DatasetsPage";
import { buildRubric } from "../src/pages/resources/rubric";
import { resetConfigForTest } from "../src/lib/config";
import { useSession } from "../src/stores/session";
import { sseFrames } from "../src/mocks/handlers";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;

let calls: Payload[] = [];
let overrides: Record<string, (p: Payload) => unknown[] | Promise<unknown[]>> = {};

const EVALUATORS_EVENT = {
  event: "evaluators",
  available: ["coherence", "helpfulness", "refusal"],
  dataset_only: ["correctness"],
  multimodal: ["mm_correctness"],
  scopes: {
    coherence: ["observe", "dataset"],
    helpfulness: ["observe", "dataset"],
    refusal: ["observe", "dataset"],
    correctness: ["dataset"],
    mm_correctness: ["dataset"],
  },
  // 与真后端同刑（app/registry.py evaluator_descriptions()）：没有这个键，
  // 描述列会整列「—」，下面「内置更新时间显示 —」的单数断言就会撞上两个 —
  descriptions: {
    coherence: "判回答自身的逻辑连贯与前后一致",
    helpfulness: "从用户视角判回答对解决问题有多大帮助",
    refusal: "判回答是否拒绝了本次请求（拒绝记 1 分）",
    correctness: "对照用例期望输出判回答的正确性",
    mm_correctness: "对照用例图片判回答的事实准确与完整",
  },
  custom: [
    {
      // updated_at 较旧 → 排在 brand_tone 后面
      name: "citation_quality",
      rubric: "1.0 每个论断有出处。\n0.0 无出处。",
      scope: "dataset",
      created_at: 1754000000,
      updated_at: 1754000000,
      blocks: {
        goal: "回答中的事实性论断必须可溯源",
        checks: ["论断均有出处", "出处真实可访问"],
        bands: [{ score: 1, desc: "全部可溯源" }, { score: 0, desc: "无出处或编造" }],
      },
    },
    {
      name: "brand_tone",
      rubric: "1.0 完全符合品牌语气。\n0.0 语气随意。",
      scope: "all",
      created_at: 1755000000,
      updated_at: 1755600000,
      blocks: null,
    },
  ],
  default: ["helpfulness"],
};

const DATASETS_EVENT = {
  event: "datasets",
  datasets: [
    {
      name: "faq-v3",
      case_count: 2,
      cases: [
        { name: "c1", input: "退货政策？", expected_output: "30 天。" },
        { name: "c2", input: "改手机号？", expected_output: "账户安全页。" },
      ],
      kind: "regression",
      target_agent: "",
      risk_categories: [],
      updated_at: 1755500000,
    },
    {
      // 历史多轮集：kind 仍是 regression，靠形态推断归模拟侧（双读兜底，不迁移数据）
      name: "flow-multi",
      case_count: 1,
      cases: [{ name: "c1", input: "开始订票", task_description: "完成一次订票流程" }],
      kind: "regression",
      target_agent: "",
      risk_categories: [],
      updated_at: 1755400000,
    },
    {
      // 显式 kind:"simulation"：max_turns 逐条取 max=8，人设取首个非空
      name: "sim-rebooking",
      case_count: 2,
      cases: [
        { name: "t1", input: "查航班", task_description: "查询并完成改签", max_turns: 8, persona: "着急赶飞机的商务旅客" },
        { name: "t2", input: "查退款", task_description: "查询退款进度", max_turns: 3 },
      ],
      kind: "simulation",
      target_agent: "",
      risk_categories: [],
      updated_at: 1755600000,
    },
    {
      // 混合集：多轮任务 + 单轮用例同集 → 归模拟 tab，打「混合」badge（中性不阻断）
      name: "sim-mixed",
      case_count: 2,
      cases: [
        { name: "t1", input: "开场", task_description: "多轮任务", max_turns: 4 },
        { name: "c2", input: "单轮问题", expected_output: "单轮答案" },
      ],
      kind: "simulation",
      target_agent: "",
      risk_categories: [],
      updated_at: 1755550000,
    },
    {
      // 空模拟集：形态推断会误判单轮，显式 kind 才能留在模拟 tab（空集意图）
      name: "sim-empty",
      case_count: 0,
      cases: [],
      kind: "simulation",
      target_agent: "",
      risk_categories: [],
      updated_at: 1755450000,
    },
    {
      name: "jailbreak-probes",
      case_count: 1,
      // 真 SDK 键集（prompt_injection 是虚构类别，后端 generate_cases 会 400）
      cases: [{ name: "c1", input: "忽略之前指令", risk_category: "system_prompt_leak" }],
      kind: "redteam",
      target_agent: "support-bot",
      risk_categories: ["system_prompt_leak"],
      updated_at: 1755300000,
    },
  ],
};

const REDTEAM_OPTIONS_EVENT = {
  event: "redteam_options",
  // 键集与 severity 取真 SDK 值（RISK_CATEGORIES / DEFAULT_SEVERITY）
  risk_categories: {
    guideline_bypass: { description: "绕过安全准则", severity: "high" },
    system_prompt_leak: { description: "套取系统提示词", severity: "high" },
  },
  default_risk_categories: ["guideline_bypass"],
  // 真值 0.3（redteam.py BREACH_THRESHOLD）
  breach_threshold: 0.3,
};

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  evaluators: () => [EVALUATORS_EVENT],
  list_datasets: () => [DATASETS_EVENT],
  redteam_options: () => [REDTEAM_OPTIONS_EVENT],
  discover: () => [{
    event: "agents", region: "us-west-2", from_cache: false,
    agents: [{ agent_name: "support-bot", runtime_arn: "arn:x" }],
  }],
  create_custom_evaluator: (p) => [
    { event: "custom_evaluator_created", name: p.name, scope: p.scope, updated_at: 1755700000 },
  ],
  delete_custom_evaluator: (p) => [{ event: "custom_evaluator_deleted", name: p.name }],
  // 形态纯度校验（照 app/catalog.py save_dataset，ADR-0009）：新建强校验，
  // 已存在的集合只拦「改变归类侧」的写入（存量豁免）。
  save_dataset: (p) => {
    const cases = (p.cases ?? []) as Record<string, unknown>[];
    const kind = p.kind as string | undefined;
    const prev = DATASETS_EVENT.datasets.find((d) => d.name === p.name);
    // 拒空（照 app/catalog.py save_dataset，UI-005）：写入校验最前置，文案逐字照抄
    if (cases.length === 0) {
      return [{ event: "error", error: "数据集至少需要一条用例" }];
    }
    // 同名冲突（照 app/catalog.py save_dataset create_only，UI-003）：带
    // create_only 的调用（新建入口）在同名集合已存在时拒；不带的（编辑/AI
    // 追加/旧客户端）行为完全不变。
    if (p.create_only && prev) {
      return [{
        event: "error",
        error: `数据集 '${String(p.name)}' 已存在——请更换名称，或在列表中打开原集合编辑`,
      }];
    }
    const effKind = kind ?? prev?.kind ?? "regression";
    const side = (k: string, cs: Record<string, unknown>[]) =>
      k === "simulation" || k === "redteam" ? k
        : cs.some((c) => c.task_description) ? "simulation" : "regression";
    let violation: string | null = null;
    if (effKind === "regression") {
      const i = cases.findIndex((c) => c.task_description || c.max_turns || c.persona);
      if (i >= 0) violation = `回归数据集不能包含多轮用例（第 ${i + 1} 条 '${String(cases[i].name ?? "")}' 带 task_description）——请存为模拟集，或去掉多轮字段`;
    } else if (effKind === "simulation") {
      const i = cases.findIndex((c) => !String(c.task_description ?? "").trim());
      if (i >= 0) violation = `模拟集的每个任务都必须有 task_description（第 ${i + 1} 条 '${String(cases[i].name ?? "")}' 缺失）——请补全任务描述，或存为回归数据集`;
    }
    if (violation && (!prev || side(effKind, cases) !== side(prev.kind, prev.cases as Record<string, unknown>[]))) {
      return [{ event: "error", error: violation }];
    }
    return [{ event: "dataset_saved", name: p.name }];
  },
  delete_dataset: (p) => [{ event: "dataset_deleted", name: p.name }],
  // 形态锁（ADR-0009）：按请求的 case_shape 回对应形态；extend 时按被追加集合形态；
  // 都缺（老调用/手控流测试）保持原混合形态。
  generate_dataset: (p) => {
    const existing = p.extend_dataset
      ? DATASETS_EVENT.datasets.find((d) => d.name === p.extend_dataset)!.cases
      : null;
    let shape = p.case_shape as string | undefined;
    if (existing) {
      shape = existing.some((c) => (c as { task_description?: unknown }).task_description)
        ? "multi" : "single";
    }
    const cases = shape === "single"
      ? [
          { name: "gen-1", input: "生成问题一", expected_output: "要点一", category: "正常" },
          { name: "gen-2", input: "生成问题二", expected_output: "要点二", category: "正常" },
        ]
      : shape === "multi"
        ? [
            { name: "gen-1", input: "模拟开场一", expected_output: "完成目标", category: "多轮", task_description: "完成流程一", max_turns: 5, persona: "急躁" },
            { name: "gen-2", input: "模拟开场二", expected_output: "完成目标", category: "多轮", task_description: "完成流程二", max_turns: 4 },
          ]
        : [
            { name: "gen-1", input: "生成问题一", expected_output: "要点一", category: "正常" },
            { name: "gen-2", input: "模拟开场", expected_output: "完成目标", category: "多轮", task_description: "完成流程", max_turns: 5, persona: "急躁" },
          ];
    return [
      { event: "heartbeat", phase: "generate_dataset" },
      {
        event: "dataset_generated",
        cases,
        agent_context_used: Boolean(p.agent_name),
        attachments: (p.attachments as { name: string }[] | undefined)?.map((a) => `${a.name}: 已解析 5 字符`) ?? [],
        source_keys: [],
        case_shape: shape ?? null,
        stripped_fields: 0,
        extend_dataset: p.extend_dataset ?? null,
        existing_cases: existing,
      },
    ];
  },
  generate_redteam_cases: (p) => [
    { event: "heartbeat", phase: "generate_redteam_cases" },
    {
      event: "redteam_gen_progress",
      risk_category: (p.risk_categories as string[])[0],
      cases: 2, error: null, done: 1, total: (p.risk_categories as string[]).length,
    },
    {
      event: "redteam_cases_generated",
      cases: [
        { name: "guideline_bypass_0", input: "攻击话术一", risk_category: "guideline_bypass" },
        { name: "guideline_bypass_1", input: "攻击话术二", risk_category: "guideline_bypass" },
      ],
      risk_categories: p.risk_categories,
      failed_categories: [],
    },
  ],
};

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    calls.push(payload);
    const handler = overrides[payload.action] ?? DEFAULTS[payload.action];
    if (!handler) return sseResponse([{ event: "error", error: `未打桩 action '${payload.action}'` }]);
    return sseResponse(await handler(payload));
  }));
}

function renderWith(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
// 拆页后各块自己的页面壳：评估器块在 #/evaluators，数据集四 tab 在 #/datasets
const renderEvaluators = () => renderWith(<EvaluatorsPage />);
const renderDatasets = () => renderWith(<DatasetsPage />);

beforeEach(() => {
  calls = [];
  overrides = {};
  resetConfigForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==================== 上块：评估器 ====================
describe("评估器表格", () => {
  it("排序：自定义在前（updated_at 倒序），内置在后；≤100 条默认全列不分页", async () => {
    renderEvaluators();
    const table = await screen.findByTestId("evaluators-table");
    await screen.findByTestId("evaluator-row-brand_tone");
    const names = within(table).getAllByTestId(/^evaluator-row-[^-]+$/, { exact: false })
      .filter((el) => el.tagName === "TR" && !el.dataset.testid!.match(/-(view|edit|delete|detail|form)$/))
      .map((el) => el.dataset.testid!.replace("evaluator-row-", ""));
    // 自定义两个在前：brand_tone(1755600000) > citation_quality(1754000000)
    expect(names[0]).toBe("brand_tone");
    expect(names[1]).toBe("citation_quality");
    // 用户裁定（2026-08-31）：默认全列（7 条 < 100），不出现「加载更多」
    expect(names).toHaveLength(7);
    expect(screen.getByTestId("evaluator-row-mm_correctness")).toBeInTheDocument();
    expect(screen.queryByTestId("evaluators-load-more")).not.toBeInTheDocument();
    // 内置更新时间显示 —
    expect(within(screen.getByTestId("evaluator-row-coherence")).getByText("—")).toBeInTheDocument();
  });

  // 用户裁定（2026-08-31）：「两者皆可」这类间接说法废除，适用环节直接列环节类型名
  // （术语表七词）；dataset 侧去掉「仅」字——列类型不是打标
  it("适用环节直接列环节类型名：all → 线上评估 · 回归测试，dataset → 回归测试", async () => {
    renderEvaluators();
    const allRow = await screen.findByTestId("evaluator-row-brand_tone");
    expect(allRow).toHaveTextContent("线上评估 · 回归测试");
    const dsRow = screen.getByTestId("evaluator-row-citation_quality");
    expect(dsRow).toHaveTextContent("回归测试");
    expect(dsRow).not.toHaveTextContent("仅回归测试");
    // 旧串全灭：间接说法在版面上一处都不许剩
    expect(screen.queryByText(/两者皆可|仅线上评估|仅回归测试/)).not.toBeInTheDocument();
  });

  it("筛选胶囊按类型过滤，搜索全量过滤", async () => {
    renderEvaluators();
    await screen.findByTestId("evaluator-row-brand_tone");
    // 自定义 chip：只剩 2 行
    fireEvent.click(screen.getByTestId("evaluators-filter-custom"));
    expect(screen.getByTestId("evaluators-filter-custom")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("evaluator-row-brand_tone")).toBeInTheDocument();
    expect(screen.queryByTestId("evaluator-row-coherence")).not.toBeInTheDocument();
    // 搜索全量过滤（默认全列后 mm_correctness 本就可见，钉的是过滤掉其余行）
    fireEvent.click(screen.getByTestId("evaluators-filter-all"));
    fireEvent.change(screen.getByTestId("evaluators-search"), { target: { value: "mm_" } });
    expect(screen.getByTestId("evaluator-row-mm_correctness")).toBeInTheDocument();
    expect(screen.queryByTestId("evaluator-row-brand_tone")).not.toBeInTheDocument();
  });

  it("内置行「查看」展开只读详情行", async () => {
    renderEvaluators();
    await screen.findByTestId("evaluator-row-coherence");
    fireEvent.click(screen.getByTestId("evaluator-row-coherence-view"));
    const detail = screen.getByTestId("evaluator-row-coherence-detail");
    expect(detail).toBeInTheDocument();
    // 改判重钉（2026-08-30 无废话终裁）：原句「内置评分标准由系统维护，只读。」
    // 对任何内置评估器一字不差成立 = 使用文档，整句删（行内只有「查看」没有
    // 「编辑」已表达只读）。详情行只留这一行自己的数据（适用环节）。
    expect(detail).toHaveTextContent(/内置评估器 · 适用环节/);
    expect(screen.queryByText(/内置评分标准由系统维护/)).toBeNull();
  });

  // UI-004 同款纪律：删除过确认卡（居中卡，不是抽屉），默认焦点在取消
  it("删除自定义评估器：先弹确认卡，确认后才发 delete_custom_evaluator", async () => {
    renderEvaluators();
    await screen.findByTestId("evaluator-row-brand_tone");
    fireEvent.click(screen.getByTestId("evaluator-row-brand_tone-delete"));
    const card = screen.getByTestId("confirm-card");
    expect(card).toHaveTextContent("删除评估器");
    expect(card).toHaveTextContent("brand_tone");
    // 危险动作默认焦点落在「取消」：回车误触不会执行删除
    expect(document.activeElement).toBe(screen.getByTestId("confirm-card-cancel"));
    expect(calls.some((c) => c.action === "delete_custom_evaluator")).toBe(false);
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await waitFor(() => {
      expect(calls.some((c) => c.action === "delete_custom_evaluator" && c.name === "brand_tone")).toBe(true);
    });
  });

  it("删除确认取消：卡关闭且不发请求", async () => {
    renderEvaluators();
    await screen.findByTestId("evaluator-row-brand_tone");
    fireEvent.click(screen.getByTestId("evaluator-row-brand_tone-delete"));
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    expect(calls.some((c) => c.action === "delete_custom_evaluator")).toBe(false);
  });
});

// ==================== 分块表单 ====================
describe("评估器分块表单", () => {
  it("buildRubric 拼 prompt：含【关注点】编号与【评分标准】分值降序", () => {
    const text = buildRubric({
      goal: "评估客服回复是否符合退改政策",
      checks: ["引用正确舱位规则", "告知手续费"],
      bands: [
        { score: 0, criteria: "引用错误政策" },
        { score: 1, criteria: "引用准确且完整" },
        { score: 0.5, criteria: "正确但遗漏费用" },
      ],
    });
    expect(text).toBe(
      "评估客服回复是否符合退改政策\n" +
      "【关注点】\n1. 引用正确舱位规则\n2. 告知手续费\n" +
      "【评分标准】\n1.0 = 引用准确且完整\n0.5 = 正确但遗漏费用\n0.0 = 引用错误政策",
    );
  });

  it("新建：分块模式保存请求体带 blocks 与拼好的 rubric", async () => {
    renderEvaluators();
    await screen.findByTestId("evaluator-row-brand_tone");
    fireEvent.click(screen.getByTestId("evaluators-new"));
    fireEvent.change(screen.getByTestId("evaluator-form-name"), { target: { value: "my_eval" } });
    fireEvent.change(screen.getByTestId("evaluator-form-scope"), { target: { value: "observe" } });
    fireEvent.change(screen.getByTestId("evaluator-form-goal"), { target: { value: "目标一句话" } });
    fireEvent.change(screen.getByTestId("evaluator-form-check-0"), { target: { value: "关注点A" } });
    fireEvent.change(screen.getByTestId("evaluator-form-band-0-score"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("evaluator-form-band-0-criteria"), { target: { value: "满分条件" } });
    fireEvent.change(screen.getByTestId("evaluator-form-band-1-score"), { target: { value: "0" } });
    fireEvent.change(screen.getByTestId("evaluator-form-band-1-criteria"), { target: { value: "零分条件" } });
    fireEvent.click(screen.getByTestId("evaluator-form-save"));
    await waitFor(() => {
      const call = calls.find((c) => c.action === "create_custom_evaluator");
      expect(call).toBeTruthy();
      expect(call!.name).toBe("my_eval");
      expect(call!.scope).toBe("observe");
      expect(call!.blocks).toEqual({
        goal: "目标一句话",
        checks: ["关注点A"],
        bands: [{ score: 1, criteria: "满分条件" }, { score: 0, criteria: "零分条件" }],
      });
      expect(call!.rubric).toBe(
        "目标一句话\n【关注点】\n1. 关注点A\n【评分标准】\n1.0 = 满分条件\n0.0 = 零分条件",
      );
    });
  });

  it("原始文本模式保存 blocks=null", async () => {
    renderEvaluators();
    await screen.findByTestId("evaluator-row-brand_tone");
    fireEvent.click(screen.getByTestId("evaluators-new"));
    fireEvent.change(screen.getByTestId("evaluator-form-name"), { target: { value: "raw_eval" } });
    fireEvent.click(screen.getByTestId("evaluator-form-toggle-raw"));
    fireEvent.change(screen.getByTestId("evaluator-form-raw"), {
      target: { value: "1.0 好\n0.0 差" },
    });
    fireEvent.click(screen.getByTestId("evaluator-form-save"));
    await waitFor(() => {
      const call = calls.find((c) => c.action === "create_custom_evaluator");
      expect(call).toBeTruthy();
      expect(call!.blocks).toBeNull();
      expect(call!.rubric).toBe("1.0 好\n0.0 差");
    });
  });

  it("编辑回填：有 blocks 走分块模式并填回三段", async () => {
    renderEvaluators();
    fireEvent.click(await screen.findByTestId("evaluator-row-citation_quality-edit"));
    // 分块模式：目标/关注点/档位齐活（bands 的 desc 字段兜为 criteria）
    expect((screen.getByTestId("evaluator-form-goal") as HTMLInputElement).value)
      .toBe("回答中的事实性论断必须可溯源");
    expect((screen.getByTestId("evaluator-form-check-0") as HTMLInputElement).value).toBe("论断均有出处");
    expect((screen.getByTestId("evaluator-form-check-1") as HTMLInputElement).value).toBe("出处真实可访问");
    expect((screen.getByTestId("evaluator-form-band-0-score") as HTMLInputElement).value).toBe("1.0");
    expect((screen.getByTestId("evaluator-form-band-0-criteria") as HTMLInputElement).value).toBe("全部可溯源");
    expect(screen.queryByTestId("evaluator-form-raw")).not.toBeInTheDocument();
  });

  it("编辑回填：无 blocks 走原始文本模式并填回 rubric", async () => {
    renderEvaluators();
    fireEvent.click(await screen.findByTestId("evaluator-row-brand_tone-edit"));
    const raw = screen.getByTestId("evaluator-form-raw") as HTMLTextAreaElement;
    expect(raw.value).toBe("1.0 完全符合品牌语气。\n0.0 语气随意。");
    expect(screen.queryByTestId("evaluator-form-goal")).not.toBeInTheDocument();
  });

  // 用户 2026-08-29 实测路径（编辑老评估器 → 点「切换到分块模式」→ 三段全空）。
  // 搬运本身的用例在 evaluator-form-toggle.test.tsx，这条只钉整页那条路：
  // 页面把 blocks=null 的评估器交给表单后，切换按钮真能拿到 rubric 文本。
  it("编辑无 blocks 的老评估器：切到分块模式带着 rubric 内容过去，不是空表单", async () => {
    renderEvaluators();
    fireEvent.click(await screen.findByTestId("evaluator-row-brand_tone-edit"));
    fireEvent.click(screen.getByTestId("evaluator-form-toggle-raw"));
    // 松散形态（无小节标题）：两行行首分值 = 两个档位
    expect((screen.getByTestId("evaluator-form-band-0-criteria") as HTMLInputElement).value)
      .toBe("完全符合品牌语气。");
    expect((screen.getByTestId("evaluator-form-band-1-criteria") as HTMLInputElement).value)
      .toBe("语气随意。");
    // 切回去原文逐字节还在（rawText 是原文的唯一权威，不许被吃掉）
    fireEvent.click(screen.getByTestId("evaluator-form-toggle-raw"));
    expect((screen.getByTestId("evaluator-form-raw") as HTMLTextAreaElement).value)
      .toBe("1.0 完全符合品牌语气。\n0.0 语气随意。");
  });

  it("校验：名称/目标必填、分值越界就地报错且不发请求", async () => {
    renderEvaluators();
    await screen.findByTestId("evaluator-row-brand_tone");
    fireEvent.click(screen.getByTestId("evaluators-new"));
    fireEvent.click(screen.getByTestId("evaluator-form-save"));
    expect(screen.getByTestId("evaluator-form-name-error")).toHaveTextContent("名称必填");
    expect(screen.getByTestId("evaluator-form-goal-error")).toHaveTextContent("评估目标必填");
    // UI-006：焦点落到首个错误字段，错误容器 role=alert 且与输入 ARIA 关联
    expect(document.activeElement).toBe(screen.getByTestId("evaluator-form-name"));
    expect(screen.getByTestId("evaluator-form-name-error")).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("evaluator-form-name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("evaluator-form-name"))
      .toHaveAttribute("aria-describedby", "evaluator-form-name-error");
    // 分值越界
    fireEvent.change(screen.getByTestId("evaluator-form-name"), { target: { value: "x" } });
    fireEvent.change(screen.getByTestId("evaluator-form-goal"), { target: { value: "g" } });
    fireEvent.change(screen.getByTestId("evaluator-form-band-0-score"), { target: { value: "1.5" } });
    fireEvent.change(screen.getByTestId("evaluator-form-band-0-criteria"), { target: { value: "c" } });
    fireEvent.click(screen.getByTestId("evaluator-form-save"));
    expect(screen.getByTestId("evaluator-form-bands-error")).toHaveTextContent("分值须在 0–1 之间");
    expect(calls.some((c) => c.action === "create_custom_evaluator")).toBe(false);
  });
});

// ==================== 抽屉化（ADR-0011 浮层三分法） ====================
describe("评估器表单抽屉", () => {
  it("新建走右侧抽屉（普通档 600），关抽屉后表单卸载", async () => {
    renderEvaluators();
    await screen.findByTestId("evaluator-row-brand_tone");
    expect(screen.queryByTestId("evaluator-form")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("evaluators-new"));
    // 终态锚点：抽屉内的表单本体（只有壳开 + children 挂载才成立）
    const form = await screen.findByTestId("evaluator-form");
    // 分块表单的引导句（「分块填写，无需手写 prompt」「一句话说清判断什么」「模型逐条检查，
    // 建议 2–5 条」「给每个分值写清判定条件，模型据此打分」「保存时提交给评估模型的完整
    // 内容（含系统自动追加部分）」「输出格式与 0.0–1.0 分数范围由系统保证，无需填写」）
    // 对任何评估器恒成立 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(form, "无需手写 prompt", "一句话说清", "建议 2–5 条", "据此打分",
      "含系统自动追加", "由系统保证");
    const drawer = screen.getByTestId("evaluator-form-drawer");
    expect(drawer).toHaveClass("drawer-panel", "open");
    expect(drawer).toHaveAttribute("role", "dialog");
    expect(drawer).toHaveAttribute("aria-label", "新建评估器");
    expect(drawer).toHaveStyle({ width: "600px" });
    expect(drawer).toContainElement(form);
    // 未改动 → 直接关，不弹脏确认
    fireEvent.click(screen.getByTestId("evaluator-form-drawer-close"));
    await waitFor(() => expect(screen.queryByTestId("evaluator-form")).not.toBeInTheDocument());
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
  });

  it("编辑：抽屉头带身份行（评估器名）+ 来源行高亮，关抽屉后高亮消失且焦点还原", async () => {
    renderEvaluators();
    const editBtn = await screen.findByTestId("evaluator-row-citation_quality-edit");
    editBtn.focus();
    fireEvent.click(editBtn);
    // 终态锚点：编辑回填完成（goal 有值只在目标评估器数据到齐时成立）
    await waitFor(() => {
      expect((screen.getByTestId("evaluator-form-goal") as HTMLInputElement).value)
        .toBe("回答中的事实性论断必须可溯源");
    });
    expect(screen.getByTestId("evaluator-form-drawer-identity")).toHaveTextContent("citation_quality");
    // 双向锚定：来源行高亮，其他行不高亮
    expect(screen.getByTestId("evaluator-row-citation_quality")).toHaveClass("row-anchored");
    expect(screen.getByTestId("evaluator-row-brand_tone")).not.toHaveClass("row-anchored");
    // 关闭 → 高亮消失 + 焦点还原到触发按钮（Drawer 内建）
    fireEvent.click(screen.getByTestId("evaluator-form-drawer-close"));
    await waitFor(() => expect(screen.queryByTestId("evaluator-form")).not.toBeInTheDocument());
    expect(screen.getByTestId("evaluator-row-citation_quality")).not.toHaveClass("row-anchored");
    expect(document.activeElement).toBe(screen.getByTestId("evaluator-row-citation_quality-edit"));
  });

  it("脏状态确认三态：改过后 Esc 弹卡 → 取消留在抽屉 / 确认才关", async () => {
    renderEvaluators();
    await screen.findByTestId("evaluator-row-brand_tone");
    fireEvent.click(screen.getByTestId("evaluators-new"));
    await screen.findByTestId("evaluator-form");
    fireEvent.change(screen.getByTestId("evaluator-form-name"), { target: { value: "dirty_eval" } });

    // ❶ Esc → 弹丢弃确认（danger 态，默认焦点在取消）
    fireEvent.keyDown(document, { key: "Escape" });
    const card = screen.getByTestId("confirm-card");
    expect(card).toHaveTextContent("有未保存的修改，确定丢弃？");
    expect(screen.getByTestId("confirm-card-ok")).toHaveClass("confirm-danger");
    expect(document.activeElement).toBe(screen.getByTestId("confirm-card-cancel"));

    // ❷ 取消 → 卡关、抽屉仍在、已输入的值没丢
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("evaluator-form")).toBeInTheDocument();
    expect((screen.getByTestId("evaluator-form-name") as HTMLInputElement).value).toBe("dirty_eval");

    // ❸ 再 Esc → 确认丢弃 → 抽屉关
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await waitFor(() => expect(screen.queryByTestId("evaluator-form")).not.toBeInTheDocument());
  });

  it("脏状态下 mask 点击与表单「取消」同刑（都过丢弃确认）", async () => {
    renderEvaluators();
    await screen.findByTestId("evaluator-row-brand_tone");
    fireEvent.click(screen.getByTestId("evaluators-new"));
    await screen.findByTestId("evaluator-form");
    fireEvent.change(screen.getByTestId("evaluator-form-goal"), { target: { value: "改了目标" } });
    // mask
    fireEvent.click(screen.getByTestId("evaluator-form-drawer-mask"));
    expect(screen.getByTestId("confirm-card")).toHaveTextContent("确定丢弃");
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    // 表单自己的「取消」按钮
    fireEvent.click(screen.getByTestId("evaluator-form-cancel"));
    expect(screen.getByTestId("confirm-card")).toHaveTextContent("确定丢弃");
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await waitFor(() => expect(screen.queryByTestId("evaluator-form")).not.toBeInTheDocument());
  });

  it("保存成功直接关抽屉，不问脏状态", async () => {
    renderEvaluators();
    await screen.findByTestId("evaluator-row-brand_tone");
    fireEvent.click(screen.getByTestId("evaluators-new"));
    await screen.findByTestId("evaluator-form");
    fireEvent.change(screen.getByTestId("evaluator-form-name"), { target: { value: "saved_eval" } });
    fireEvent.change(screen.getByTestId("evaluator-form-goal"), { target: { value: "目标" } });
    fireEvent.change(screen.getByTestId("evaluator-form-band-0-criteria"), { target: { value: "满分" } });
    fireEvent.click(screen.getByTestId("evaluator-form-save"));
    // 终态锚点：抽屉里的表单卸载（保存成功专属状态）
    await waitFor(() => expect(screen.queryByTestId("evaluator-form")).not.toBeInTheDocument());
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
  });
});

describe("数据集表单抽屉", () => {
  it("新建走宽档抽屉（760，含 JSON 编辑区），关抽屉后表单卸载", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    expect(screen.queryByTestId("dataset-form")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("datasets-new"));
    // 终态锚点：抽屉内的表单本体（壳开 + children 挂载才成立）
    const form = await screen.findByTestId("dataset-form");
    // 「用例以 JSON 数组直编；表单化逐条编辑器后续提供」是路线图 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(form, "后续提供", "以 JSON 数组直编");
    const drawer = screen.getByTestId("dataset-form-drawer");
    expect(drawer).toHaveClass("drawer-panel", "open");
    expect(drawer).toHaveAttribute("role", "dialog");
    expect(drawer).toHaveAttribute("aria-label", "新建数据集");
    // 宽档：含 JSON 编辑区的表单用 760（普通档 600 见评估器抽屉）
    expect(drawer).toHaveStyle({ width: "760px" });
    expect(drawer).toContainElement(form);
    // 未改动 → 直接关，不弹脏确认
    fireEvent.click(screen.getByTestId("dataset-form-drawer-close"));
    await waitFor(() => expect(screen.queryByTestId("dataset-form")).not.toBeInTheDocument());
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
  });

  it("编辑：抽屉头带身份行（数据集名）+ 来源行高亮，关抽屉后高亮消失且焦点还原", async () => {
    renderDatasets();
    const editBtn = await screen.findByTestId("dataset-row-faq-v3-edit");
    editBtn.focus();
    fireEvent.click(editBtn);
    // 终态锚点：回填完成（JSON 里含 faq-v3 的第二条用例才算数据到齐）
    await waitFor(() => {
      expect((screen.getByTestId("dataset-form-cases") as HTMLTextAreaElement).value)
        .toContain("账户安全页");
    });
    expect(screen.getByTestId("dataset-form-drawer-identity")).toHaveTextContent("faq-v3");
    expect(screen.getByTestId("dataset-row-faq-v3")).toHaveClass("row-anchored");
    // 名称在编辑模式锁定（同名保存是正常路径，不给改名）
    expect(screen.getByTestId("dataset-form-name")).toBeDisabled();
    fireEvent.click(screen.getByTestId("dataset-form-drawer-close"));
    await waitFor(() => expect(screen.queryByTestId("dataset-form")).not.toBeInTheDocument());
    expect(screen.getByTestId("dataset-row-faq-v3")).not.toHaveClass("row-anchored");
    expect(document.activeElement).toBe(screen.getByTestId("dataset-row-faq-v3-edit"));
  });

  it("模拟集编辑也走同一个宽档抽屉，来源行高亮在模拟表", async () => {
    renderDatasets();
    await screen.findByTestId("testdata-pane-dataset");
    fireEvent.click(screen.getByTestId("testdata-tab-simulation"));
    fireEvent.click(screen.getByTestId("simset-row-sim-rebooking-edit"));
    // 终态锚点：sim-rebooking 专属人设串回填完成
    await waitFor(() => {
      expect((screen.getByTestId("dataset-form-cases") as HTMLTextAreaElement).value)
        .toContain("着急赶飞机的商务旅客");
    });
    const drawer = screen.getByTestId("dataset-form-drawer");
    expect(drawer).toHaveAttribute("aria-label", "编辑模拟集");
    expect(drawer).toHaveStyle({ width: "760px" });
    expect(screen.getByTestId("simset-row-sim-rebooking")).toHaveClass("row-anchored");
    expect(screen.getByTestId("simset-row-sim-mixed")).not.toHaveClass("row-anchored");
  });

  it("脏状态确认三态：改过 JSON 后 Esc 弹卡 → 取消留在抽屉 / 确认才关", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    fireEvent.click(screen.getByTestId("datasets-new"));
    await screen.findByTestId("dataset-form");
    fireEvent.change(screen.getByTestId("dataset-form-name"), { target: { value: "dirty-ds" } });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("confirm-card")).toHaveTextContent("有未保存的修改，确定丢弃？");
    expect(document.activeElement).toBe(screen.getByTestId("confirm-card-cancel"));

    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    expect((screen.getByTestId("dataset-form-name") as HTMLInputElement).value).toBe("dirty-ds");

    // 表单自己的「取消」与 Esc/mask 同刑
    fireEvent.click(screen.getByTestId("dataset-form-cancel"));
    expect(screen.getByTestId("confirm-card")).toHaveTextContent("确定丢弃");
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await waitFor(() => expect(screen.queryByTestId("dataset-form")).not.toBeInTheDocument());
  });

  // ---------- UI-003 同名新建 / UI-005 空数组 / UI-006 焦点+ARIA ----------

  it("UI-003：新建同名集合就地拦住，不发 save_dataset；改名后放行", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    fireEvent.click(screen.getByTestId("datasets-new"));
    await screen.findByTestId("dataset-form");
    fireEvent.change(screen.getByTestId("dataset-form-name"), { target: { value: "faq-v3" } });
    fireEvent.change(screen.getByTestId("dataset-form-cases"), {
      target: { value: '[{"name":"c1","input":"新内容"}]' },
    });
    fireEvent.click(screen.getByTestId("dataset-form-save"));
    expect(screen.getByTestId("dataset-form-name-error")).toHaveTextContent("名称已存在");
    // 关键：一个字节都没发出去，原集合 2 条用例不可能被覆盖
    expect(calls.some((c) => c.action === "save_dataset")).toBe(false);
    // 改成没占用的名字 → 放行
    fireEvent.change(screen.getByTestId("dataset-form-name"), { target: { value: "faq-v4" } });
    expect(screen.queryByTestId("dataset-form-name-error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("dataset-form-save"));
    await waitFor(() => {
      expect(calls.find((c) => c.action === "save_dataset")!.name).toBe("faq-v4");
    });
  });

  it("UI-003：跨 tab 同名也拦（回归 tab 新建撞模拟集名）", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    fireEvent.click(screen.getByTestId("datasets-new"));
    await screen.findByTestId("dataset-form");
    // sim-rebooking 在模拟 tab，但名字空间是全局的（后端一张表一个 sk）
    fireEvent.change(screen.getByTestId("dataset-form-name"), { target: { value: "sim-rebooking" } });
    fireEvent.click(screen.getByTestId("dataset-form-save"));
    expect(screen.getByTestId("dataset-form-name-error")).toHaveTextContent("名称已存在");
    expect(calls.some((c) => c.action === "save_dataset")).toBe(false);
  });

  it("UI-003：编辑模式保留原名保存（不误伤正常编辑路径），且不带 create_only", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    fireEvent.click(screen.getByTestId("dataset-row-faq-v3-edit"));
    await waitFor(() => {
      expect((screen.getByTestId("dataset-form-cases") as HTMLTextAreaElement).value)
        .toContain("账户安全页");
    });
    fireEvent.change(screen.getByTestId("dataset-form-cases"), {
      target: { value: '[{"name":"c1","input":"改过的问题","expected_output":"改过的答案"}]' },
    });
    fireEvent.click(screen.getByTestId("dataset-form-save"));
    await waitFor(() => {
      const call = calls.find((c) => c.action === "save_dataset");
      expect(call).toBeTruthy();
      expect(call!.name).toBe("faq-v3");
      expect(call!.create_only).toBeUndefined();
    });
  });

  it("UI-005：空数组/非数组/非法 JSON 都拦在前端；合法非空数组放行", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    fireEvent.click(screen.getByTestId("datasets-new"));
    await screen.findByTestId("dataset-form");
    fireEvent.change(screen.getByTestId("dataset-form-name"), { target: { value: "empty-ds" } });
    // ❶ 空数组
    fireEvent.change(screen.getByTestId("dataset-form-cases"), { target: { value: "[]" } });
    fireEvent.click(screen.getByTestId("dataset-form-save"));
    expect(screen.getByTestId("dataset-form-cases-error"))
      .toHaveTextContent("数据集至少需要一条用例");
    // ❷ 非数组
    fireEvent.change(screen.getByTestId("dataset-form-cases"), { target: { value: '{"a":1}' } });
    fireEvent.click(screen.getByTestId("dataset-form-save"));
    expect(screen.getByTestId("dataset-form-cases-error")).toHaveTextContent("必须是数组");
    // ❸ 非法 JSON
    fireEvent.change(screen.getByTestId("dataset-form-cases"), { target: { value: "[" } });
    fireEvent.click(screen.getByTestId("dataset-form-save"));
    expect(screen.getByTestId("dataset-form-cases-error")).toHaveTextContent("JSON 解析失败");
    expect(calls.some((c) => c.action === "save_dataset")).toBe(false);
    // ❹ 合法非空
    fireEvent.change(screen.getByTestId("dataset-form-cases"), {
      target: { value: '[{"name":"c1","input":"问"}]' },
    });
    fireEvent.click(screen.getByTestId("dataset-form-save"));
    await waitFor(() => {
      expect(calls.find((c) => c.action === "save_dataset")!.name).toBe("empty-ds");
    });
  });

  it("UI-005 后端同刑：绕过 UI 的空数组由后端拒（文案逐字一致）", async () => {
    // 前端已拦空数组，这条守的是 mock/后端契约不漂移——文案变了这里先红
    installFetch();
    const res = await fetch("/api/invoke", {
      method: "POST",
      body: JSON.stringify({ action: "save_dataset", name: "x", cases: [], kind: "regression" }),
    });
    expect(await res.text()).toContain("数据集至少需要一条用例");
  });

  it("UI-006：校验失败聚焦首个错误字段，错误 role=alert 且 ARIA 关联输入", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    fireEvent.click(screen.getByTestId("datasets-new"));
    await screen.findByTestId("dataset-form");
    // 名称空 + JSON 也坏：焦点按视觉顺序落在名称
    fireEvent.change(screen.getByTestId("dataset-form-cases"), { target: { value: "{bad" } });
    fireEvent.click(screen.getByTestId("dataset-form-save"));
    expect(document.activeElement).toBe(screen.getByTestId("dataset-form-name"));
    expect(screen.getByTestId("dataset-form-name-error")).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("dataset-form-name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("dataset-form-name"))
      .toHaveAttribute("aria-describedby", "dataset-form-name-error");
    expect(screen.getByTestId("dataset-form-cases"))
      .toHaveAttribute("aria-describedby", "dataset-form-cases-error");
    // 名称补好 → 焦点落到 JSON 编辑器；名称的无效 ARIA 不残留
    fireEvent.change(screen.getByTestId("dataset-form-name"), { target: { value: "focus-ds" } });
    expect(screen.getByTestId("dataset-form-name")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByTestId("dataset-form-name")).not.toHaveAttribute("aria-describedby");
    fireEvent.click(screen.getByTestId("dataset-form-save"));
    expect(document.activeElement).toBe(screen.getByTestId("dataset-form-cases"));
    expect(screen.getByTestId("dataset-form-cases-error")).toHaveAttribute("role", "alert");
    // 修正后错误清除
    fireEvent.change(screen.getByTestId("dataset-form-cases"), {
      target: { value: '[{"name":"c1","input":"问"}]' },
    });
    expect(screen.queryByTestId("dataset-form-cases-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("dataset-form-cases")).not.toHaveAttribute("aria-invalid");
  });
});

// ==================== 下块：测试数据 ====================
describe("测试数据四 tab", () => {
  it("四 tab 切换：回归/模拟/红队/线上各自面板互斥显示，计数正确", async () => {
    renderDatasets();
    expect(await screen.findByTestId("testdata-pane-dataset")).toBeInTheDocument();
    // tab 计数：回归 1（faq-v3）、模拟 3（sim-rebooking/sim-mixed/sim-empty + 推断的 flow-multi = 4）、红队 1
    expect(screen.getByTestId("testdata-tab-dataset")).toHaveTextContent("回归数据集 1");
    expect(screen.getByTestId("testdata-tab-simulation")).toHaveTextContent("模拟测试 4");
    expect(screen.getByTestId("testdata-tab-redteam")).toHaveTextContent("红队用例集 1");
    fireEvent.click(screen.getByTestId("testdata-tab-simulation"));
    expect(screen.getByTestId("testdata-pane-simulation")).toBeInTheDocument();
    expect(screen.queryByTestId("testdata-pane-dataset")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("testdata-tab-redteam"));
    expect(screen.getByTestId("testdata-pane-redteam")).toBeInTheDocument();
    expect(screen.queryByTestId("testdata-pane-simulation")).not.toBeInTheDocument();
    // 红队页脚注「方案里引用用例集时，Agent 与目标不一致会提示」恒成立 ⇒ 删
    expect(screen.queryByTestId("redteam-footnote")).toBeNull();
    expectProseGone(screen.getByTestId("testdata-card"), "不一致会提示");
    fireEvent.click(screen.getByTestId("testdata-tab-observe"));
    expect(screen.queryByTestId("testdata-pane-redteam")).not.toBeInTheDocument();
    expect(screen.getByTestId("testdata-observe-note")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("testdata-tab-dataset"));
    expect(screen.getByTestId("testdata-pane-dataset")).toBeInTheDocument();
  });

  it("kind 过滤：回归 tab 只剩固定侧，红队 tab 只有 redteam", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    // 回归 tab：redteam 与模拟侧（含形态推断的 flow-multi）都不出现
    expect(screen.queryByTestId("dataset-row-jailbreak-probes")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dataset-row-flow-multi")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dataset-row-sim-rebooking")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("dataset-row-faq-v3")).getByText("单轮")).toBeInTheDocument();
    // 红队 tab：只有 redteam
    fireEvent.click(screen.getByTestId("testdata-tab-redteam"));
    expect(screen.getByTestId("redteam-row-jailbreak-probes")).toBeInTheDocument();
    expect(screen.queryByTestId("redteam-row-faq-v3")).not.toBeInTheDocument();
    // 目标 Agent 与风险类别列
    const row = screen.getByTestId("redteam-row-jailbreak-probes");
    expect(within(row).getByText("support-bot")).toBeInTheDocument();
    // 真 SDK 类别键（此前断言的 prompt_injection 是虚构类别）
    expect(within(row).getByText("system_prompt_leak")).toBeInTheDocument();
  });

  it("双读归类：显式 kind:simulation、形态推断的历史多轮集、空模拟集都在模拟 tab", async () => {
    renderDatasets();
    await screen.findByTestId("testdata-pane-dataset");
    fireEvent.click(screen.getByTestId("testdata-tab-simulation"));
    // 显式 kind
    expect(screen.getByTestId("simset-row-sim-rebooking")).toBeInTheDocument();
    // 形态推断兜底：kind=regression 但含 task_description
    expect(screen.getByTestId("simset-row-flow-multi")).toBeInTheDocument();
    // 空集意图：cases 为空但 kind=simulation，不掉回回归 tab
    expect(screen.getByTestId("simset-row-sim-empty")).toBeInTheDocument();
    // 纯单轮 regression 不进来
    expect(screen.queryByTestId("simset-row-faq-v3")).not.toBeInTheDocument();
  });

  it("混合集归模拟 tab 打「混合」badge；纯多轮集不打", async () => {
    renderDatasets();
    await screen.findByTestId("testdata-pane-dataset");
    fireEvent.click(screen.getByTestId("testdata-tab-simulation"));
    expect(screen.getByTestId("simset-row-sim-mixed-mixed")).toHaveTextContent("混合");
    expect(screen.queryByTestId("simset-row-sim-rebooking-mixed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("simset-row-flow-multi-mixed")).not.toBeInTheDocument();
  });

  it("模拟表列：任务数只算多轮用例、最大轮次取 max（缺省 5）、人设三态（✓摘要/—）", async () => {
    renderDatasets();
    await screen.findByTestId("testdata-pane-dataset");
    fireEvent.click(screen.getByTestId("testdata-tab-simulation"));
    // sim-rebooking：2 任务，max_turns max(8,3)=8，人设取首个非空
    const rebooking = screen.getByTestId("simset-row-sim-rebooking");
    const rbCells = within(rebooking).getAllByRole("cell");
    expect(rbCells[1]).toHaveTextContent("2");
    expect(rbCells[2]).toHaveTextContent("8");
    expect(within(rebooking).getByText("✓")).toBeInTheDocument();
    expect(within(rebooking).getByText("着急赶飞机的商务旅客")).toBeInTheDocument();
    // flow-multi：无 max_turns → 缺省 5；无人设 → —
    const flow = screen.getByTestId("simset-row-flow-multi");
    const flowCells = within(flow).getAllByRole("cell");
    expect(flowCells[1]).toHaveTextContent("1");
    expect(flowCells[2]).toHaveTextContent("5");
    expect(within(flow).getByText("—")).toBeInTheDocument();
    // sim-mixed：任务数只算带 task_description 的（1，不是 2）
    const mixed = screen.getByTestId("simset-row-sim-mixed");
    expect(within(mixed).getAllByRole("cell")[1]).toHaveTextContent("1");
    // 表底汇总：4 个模拟集 · 任务数 2+1+1+0=4
    expect(screen.getByTestId("simsets-foot-note")).toHaveTextContent("共 4 个模拟集 · 4 个任务");
    // 此前钉的是底部 ⓘ 说明条**在**（「模拟测试由平台扮演用户与 Agent 多轮对话…评分看
    // 整段对话是否完成目标」）—— 对任何模拟集恒成立 ⇒ 删；卡标题只留「测试数据」
    // （prose-sweep 2026-09-03）
    expect(screen.queryByTestId("simsets-note")).toBeNull();
    expectProseGone(screen.getByTestId("testdata-card"), "由平台扮演用户", "评分看整段对话", "拿什么测");
  });

  it("新建模拟集：保存请求体带 kind:simulation", async () => {
    renderDatasets();
    await screen.findByTestId("testdata-pane-dataset");
    fireEvent.click(screen.getByTestId("testdata-tab-simulation"));
    fireEvent.click(screen.getByTestId("simsets-new"));
    // 新建模板已带模拟 per-case 字段
    const box = screen.getByTestId("dataset-form-cases") as HTMLTextAreaElement;
    expect(box.value).toContain("task_description");
    expect(box.value).toContain("max_turns");
    fireEvent.change(screen.getByTestId("dataset-form-name"), { target: { value: "new-sim" } });
    fireEvent.change(box, {
      target: { value: '[{"name":"t1","input":"开场","task_description":"完成任务","max_turns":6}]' },
    });
    fireEvent.click(screen.getByTestId("dataset-form-save"));
    await waitFor(() => {
      const call = calls.find((c) => c.action === "save_dataset");
      expect(call).toBeTruthy();
      expect(call!.name).toBe("new-sim");
      expect(call!.kind).toBe("simulation");
    });
  });

  it("线上评估 tab 只有一句话，无列表", async () => {
    renderDatasets();
    await screen.findByTestId("testdata-pane-dataset");
    fireEvent.click(screen.getByTestId("testdata-tab-observe"));
    expect(screen.getByTestId("testdata-observe-note"))
      .toHaveTextContent("线上评估直接分析真实会话，无需准备用例。");
    // 测试数据卡片里不加任何列表/表格（用户定案；上块评估器表格不算）
    const card = within(screen.getByTestId("testdata-card"));
    expect(card.queryByRole("table")).not.toBeInTheDocument();
    expect(card.queryByRole("list")).not.toBeInTheDocument();
  });

  it("回归数据集简化编辑器：保存请求体带 kind:regression；JSON 坏格式就地报错", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    fireEvent.click(screen.getByTestId("datasets-new"));
    fireEvent.change(screen.getByTestId("dataset-form-name"), { target: { value: "new-ds" } });
    // 坏 JSON 先报错（抽屉化后错误挂到字段上，UI-006）
    fireEvent.change(screen.getByTestId("dataset-form-cases"), { target: { value: "{bad" } });
    fireEvent.click(screen.getByTestId("dataset-form-save"));
    expect(screen.getByTestId("dataset-form-cases-error")).toHaveTextContent("JSON 解析失败");
    expect(calls.some((c) => c.action === "save_dataset")).toBe(false);
    // 好 JSON 保存
    fireEvent.change(screen.getByTestId("dataset-form-cases"), {
      target: { value: '[{"name":"c1","input":"问","expected_output":"答"}]' },
    });
    fireEvent.click(screen.getByTestId("dataset-form-save"));
    await waitFor(() => {
      const call = calls.find((c) => c.action === "save_dataset");
      expect(call).toBeTruthy();
      expect(call!.name).toBe("new-ds");
      expect(call!.kind).toBe("regression");
      expect(call!.cases).toEqual([{ name: "c1", input: "问", expected_output: "答" }]);
      // UI-003 第二道闸：新建入口声明 create_only，后端同名即拒
      expect(call!.create_only).toBe(true);
    });
  });

  it("数据集删除：先弹确认卡（名称+用例数+不可恢复），确认后才发 delete_dataset", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    fireEvent.click(screen.getByTestId("dataset-row-faq-v3-delete"));
    // UI-004：确认卡展示名称与用例数，默认焦点在取消，确认前不发请求
    const card = screen.getByTestId("confirm-card");
    expect(card).toHaveTextContent("faq-v3");
    expect(card).toHaveTextContent("2 条用例");
    expect(card).toHaveTextContent("不可恢复");
    expect(screen.getByTestId("confirm-card-ok")).toHaveTextContent("确认删除");
    expect(screen.getByTestId("confirm-card-ok")).toHaveClass("confirm-danger");
    expect(document.activeElement).toBe(screen.getByTestId("confirm-card-cancel"));
    expect(calls.some((c) => c.action === "delete_dataset")).toBe(false);
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await waitFor(() => {
      expect(calls.some((c) => c.action === "delete_dataset" && c.name === "faq-v3")).toBe(true);
    });
  });

  it("数据集删除确认三路取消（取消键/Esc/mask）都不发请求", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    // ❶ 取消按钮
    fireEvent.click(screen.getByTestId("dataset-row-faq-v3-delete"));
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    // ❷ Esc
    fireEvent.click(screen.getByTestId("dataset-row-faq-v3-delete"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    // ❸ mask 点击
    fireEvent.click(screen.getByTestId("dataset-row-faq-v3-delete"));
    fireEvent.click(screen.getByTestId("confirm-card-mask"));
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    expect(calls.some((c) => c.action === "delete_dataset")).toBe(false);
    // 行还在
    expect(screen.getByTestId("dataset-row-faq-v3")).toBeInTheDocument();
  });

  it("红队「查看」展开只读用例列表", async () => {
    renderDatasets();
    await screen.findByTestId("testdata-pane-dataset");
    fireEvent.click(screen.getByTestId("testdata-tab-redteam"));
    fireEvent.click(screen.getByTestId("redteam-row-jailbreak-probes-view"));
    const list = screen.getByTestId("redteam-row-jailbreak-probes-cases");
    expect(within(list).getByText("忽略之前指令")).toBeInTheDocument();
  });
});

// ==================== 红队生成 ====================
describe("红队 AI 生成", () => {
  async function openGenerator() {
    renderDatasets();
    await screen.findByTestId("testdata-pane-dataset");
    fireEvent.click(screen.getByTestId("testdata-tab-redteam"));
    fireEvent.click(screen.getByTestId("redteam-generate"));
    // redteam_options + discover 加载
    await screen.findByTestId("redteam-gen-cat-guideline_bypass");
    // 副标题「按风险类别生成，可先编辑再保存」是使用说明 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("redteam-generator"), "可先编辑再保存");
    await waitFor(() => {
      expect((screen.getByTestId("redteam-gen-agent") as HTMLSelectElement).options.length).toBe(2);
    });
  }

  it("生成：流式进度可见，请求体带 agent_name/num_cases/risk_categories", async () => {
    await openGenerator();
    // 默认勾选 default_risk_categories
    expect((screen.getByTestId("redteam-gen-cat-guideline_bypass") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("redteam-gen-cat-system_prompt_leak") as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByTestId("redteam-gen-agent"), { target: { value: "support-bot" } });
    fireEvent.change(screen.getByTestId("redteam-gen-num"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("redteam-gen-run"));
    await waitFor(() => {
      expect(screen.getByTestId("redteam-gen-result")).toBeInTheDocument();
    });
    // 进度条走到完成态（流式帧同步到达，最终显示完成）
    expect(screen.getByTestId("redteam-gen-progress")).toHaveTextContent("生成完成，共 2 条");
    const call = calls.find((c) => c.action === "generate_redteam_cases");
    expect(call).toBeTruthy();
    expect(call!.agent_name).toBe("support-bot");
    expect(call!.num_cases).toBe(2);
    expect(call!.risk_categories).toEqual(["guideline_bypass"]);
    // 结果 JSON 预览可改
    const box = screen.getByTestId("redteam-gen-cases") as HTMLTextAreaElement;
    expect(box.value).toContain("攻击话术一");
  });

  it("心跳活性行在逐类进度行下方：heartbeat 养活性，redteam_gen_progress 照旧显示", async () => {
    await openGenerator();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    const enc = new TextEncoder();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("config.json")) return Response.json(CFG);
      const payload = JSON.parse(String(init?.body)) as Payload;
      calls.push(payload);
      if (payload.action === "generate_redteam_cases") {
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return sseResponse(await DEFAULTS[payload.action]!(payload));
    }));
    fireEvent.change(screen.getByTestId("redteam-gen-agent"), { target: { value: "support-bot" } });
    fireEvent.click(screen.getByTestId("redteam-gen-run"));
    ctrl.enqueue(enc.encode(sseFrames([{ event: "heartbeat", phase: "generate_redteam_cases" }])));
    await waitFor(() => {
      expect(screen.getByTestId("redteam-gen-progress")).toHaveTextContent(/生成中 · 已 00:0\d/);
    });
    expect(screen.getByTestId("redteam-gen-liveness")).toHaveClass("ok");
    expect(screen.getByTestId("redteam-gen-liveness")).toHaveTextContent("链路正常");
    // 逐类进度事件：进度行更新，活性行仍在
    ctrl.enqueue(enc.encode(sseFrames([{
      event: "redteam_gen_progress", risk_category: "guideline_bypass",
      cases: 2, error: null, done: 1, total: 1,
    }])));
    await waitFor(() => {
      expect(screen.getByTestId("redteam-gen-progress"))
        .toHaveTextContent("已完成 1/1 类（guideline_bypass）");
    });
    expect(screen.getByTestId("redteam-gen-liveness")).toBeInTheDocument();
    // 断流兜底：诚实文案
    ctrl.error(new Error("network error"));
    await waitFor(() => {
      expect(screen.getByTestId("redteam-gen-error"))
        .toHaveTextContent("连接中断，这不代表生成失败，但结果未能送达，请重试");
    });
    expect(screen.queryByTestId("redteam-gen-liveness")).not.toBeInTheDocument();
  });

  it("保存为用例集：请求体带 kind:redteam / target_agent / risk_categories", async () => {
    await openGenerator();
    fireEvent.change(screen.getByTestId("redteam-gen-agent"), { target: { value: "support-bot" } });
    fireEvent.click(screen.getByTestId("redteam-gen-run"));
    await waitFor(() => {
      expect(screen.getByTestId("redteam-gen-result")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("redteam-gen-save-name"), { target: { value: "rt-support" } });
    fireEvent.click(screen.getByTestId("redteam-gen-save"));
    await waitFor(() => {
      const call = calls.find((c) => c.action === "save_dataset");
      expect(call).toBeTruthy();
      expect(call!.name).toBe("rt-support");
      expect(call!.kind).toBe("redteam");
      expect(call!.target_agent).toBe("support-bot");
      expect(call!.risk_categories).toEqual(["guideline_bypass"]);
      expect(Array.isArray(call!.cases)).toBe(true);
      expect((call!.cases as unknown[]).length).toBe(2);
    });
  });
});

// ==================== AI 生成用例/任务（generate_dataset） ====================
describe("AI 生成用例/任务", () => {
  const GEN_EVENTS = DEFAULTS.generate_dataset;

  async function openRegressionGen() {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    fireEvent.click(screen.getByTestId("datasets-ai-generate"));
    await screen.findByTestId("dsgen-form");
  }

  async function openSimulationGen() {
    renderDatasets();
    await screen.findByTestId("testdata-pane-dataset");
    fireEvent.click(screen.getByTestId("testdata-tab-simulation"));
    fireEvent.click(screen.getByTestId("simsets-ai-generate"));
    await screen.findByTestId("dsgen-form");
  }

  async function generateOk() {
    fireEvent.change(screen.getByTestId("dsgen-context"), { target: { value: "客服业务背景" } });
    fireEvent.click(screen.getByTestId("dsgen-run"));
    await waitFor(() => {
      expect(screen.getByTestId("dsgen-result")).toBeInTheDocument();
    });
  }

  it("两 tab 变体：回归 tab 是「AI 生成用例」，模拟 tab 是「AI 生成任务」且 placeholder 引导多轮；占位提示已删", async () => {
    await openRegressionGen();
    expect(screen.getByTestId("dsgen-form")).toHaveTextContent("AI 生成用例");
    // 副标题「根据业务背景生成测试用例，可先编辑再保存」与标签括号「使用其提示词增强生成」
    // 是使用说明 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("dsgen-form"), "可先编辑再保存", "使用其提示词增强生成");
    expect(screen.queryByTestId("datasets-ai-hint")).not.toBeInTheDocument();
    const regCtx = screen.getByTestId("dsgen-context") as HTMLTextAreaElement;
    expect(regCtx.placeholder).not.toContain("task_description");
    // 切模拟 tab（回归表单随 tab 卸载）
    fireEvent.click(screen.getByTestId("testdata-tab-simulation"));
    fireEvent.click(screen.getByTestId("simsets-ai-generate"));
    expect(screen.getByTestId("dsgen-form")).toHaveTextContent("AI 生成任务");
    expect(screen.queryByTestId("simsets-ai-hint")).not.toBeInTheDocument();
    const simCtx = screen.getByTestId("dsgen-context") as HTMLTextAreaElement;
    expect(simCtx.placeholder).toContain("task_description");
    expect(simCtx.placeholder).toContain("多轮");
  });

  it("context 必填：为空时生成按钮禁用，填了才可点", async () => {
    await openRegressionGen();
    expect(screen.getByTestId("dsgen-run")).toBeDisabled();
    fireEvent.change(screen.getByTestId("dsgen-context"), { target: { value: "  " } });
    expect(screen.getByTestId("dsgen-run")).toBeDisabled();
    fireEvent.change(screen.getByTestId("dsgen-context"), { target: { value: "背景" } });
    expect(screen.getByTestId("dsgen-run")).not.toBeDisabled();
    expect(calls.some((c) => c.action === "generate_dataset")).toBe(false);
  });

  it("生成请求体形状：context/num_cases（夹到 1–50）/agent_name 可选", async () => {
    await openRegressionGen();
    await waitFor(() => {
      expect((screen.getByTestId("dsgen-agent") as HTMLSelectElement).options.length).toBe(2);
    });
    fireEvent.change(screen.getByTestId("dsgen-agent"), { target: { value: "support-bot" } });
    fireEvent.change(screen.getByTestId("dsgen-num"), { target: { value: "100" } });
    fireEvent.change(screen.getByTestId("dsgen-context"), { target: { value: " 客服业务背景 " } });
    fireEvent.click(screen.getByTestId("dsgen-run"));
    await waitFor(() => {
      const call = calls.find((c) => c.action === "generate_dataset");
      expect(call).toBeTruthy();
      expect(call!.context).toBe("客服业务背景");
      expect(call!.num_cases).toBe(50);
      expect(call!.agent_name).toBe("support-bot");
      expect(call!.extend_dataset).toBeUndefined();
      expect(call!.attachments).toBeUndefined();
    });
    // agent 增强在完成态可见
    expect(screen.getByTestId("dsgen-progress")).toHaveTextContent("已使用目标 Agent 提示词增强");
  });

  it("流式：heartbeat 帧先显示「生成中」，最终 dataset_generated 渲染结果", async () => {
    await openRegressionGen();
    // 手控流：分块投递 SSE 帧，验证中间态（同步整包会跳过 heartbeat 呈现）
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    const enc = new TextEncoder();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("config.json")) return Response.json(CFG);
      const payload = JSON.parse(String(init?.body)) as Payload;
      calls.push(payload);
      if (payload.action === "generate_dataset") {
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return sseResponse(await DEFAULTS[payload.action]!(payload));
    }));
    fireEvent.change(screen.getByTestId("dsgen-context"), { target: { value: "背景" } });
    fireEvent.click(screen.getByTestId("dsgen-run"));
    ctrl.enqueue(enc.encode(sseFrames([{ event: "heartbeat", phase: "generate_dataset" }])));
    await waitFor(() => {
      expect(screen.getByTestId("dsgen-progress")).toHaveTextContent(/生成中 · 已 00:0\d/);
    });
    expect(screen.getByTestId("dsgen-run")).toHaveTextContent("生成中…");
    // 心跳活性行：刚收到 heartbeat → 链路正常
    expect(screen.getByTestId("dsgen-liveness")).toHaveClass("ok");
    expect(screen.getByTestId("dsgen-liveness")).toHaveTextContent(/链路正常 · \ds 前有心跳/);
    ctrl.enqueue(enc.encode(sseFrames(GEN_EVENTS({ action: "generate_dataset" }).slice(1))));
    ctrl.close();
    await waitFor(() => {
      expect(screen.getByTestId("dsgen-result")).toBeInTheDocument();
    });
    expect(screen.getByTestId("dsgen-progress")).toHaveTextContent("生成完成，共 2 条");
    // 结束后活性行退场（generating=false）
    expect(screen.queryByTestId("dsgen-liveness")).not.toBeInTheDocument();
    const box = screen.getByTestId("dsgen-cases") as HTMLTextAreaElement;
    expect(box.value).toContain("生成问题一");
    expect(box.value).toContain("task_description");
  });

  it("断流兜底：流异常断开 ≠ 生成失败——诚实提示结果未送达需重试", async () => {
    await openRegressionGen();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("config.json")) return Response.json(CFG);
      const payload = JSON.parse(String(init?.body)) as Payload;
      calls.push(payload);
      if (payload.action === "generate_dataset") {
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return sseResponse(await DEFAULTS[payload.action]!(payload));
    }));
    fireEvent.change(screen.getByTestId("dsgen-context"), { target: { value: "背景" } });
    fireEvent.click(screen.getByTestId("dsgen-run"));
    await screen.findByTestId("dsgen-liveness");
    ctrl.error(new Error("network error"));
    await waitFor(() => {
      expect(screen.getByTestId("dsgen-error"))
        .toHaveTextContent("连接中断，这不代表生成失败，但结果未能送达，请重试");
    });
    expect(screen.getByTestId("dsgen-run")).toBeEnabled();
    expect(screen.queryByTestId("dsgen-liveness")).not.toBeInTheDocument();
  });

  it("后端 error 事件：原文展示，不带断流兜底文案", async () => {
    await openRegressionGen();
    overrides.generate_dataset = () => [{ event: "error", error: "judge 配置缺失" }];
    fireEvent.change(screen.getByTestId("dsgen-context"), { target: { value: "背景" } });
    fireEvent.click(screen.getByTestId("dsgen-run"));
    await waitFor(() => {
      expect(screen.getByTestId("dsgen-error")).toHaveTextContent("judge 配置缺失");
    });
    expect(screen.getByTestId("dsgen-error")).not.toHaveTextContent("连接中断");
  });

  it("结果可编辑；非法 JSON 时保存禁用并就地提示", async () => {
    await openRegressionGen();
    await generateOk();
    const box = screen.getByTestId("dsgen-cases") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "{bad json" } });
    expect(screen.getByTestId("dsgen-invalid")).toHaveTextContent("非法");
    expect(screen.getByTestId("dsgen-save")).toBeDisabled();
    // 空数组同样禁存
    fireEvent.change(box, { target: { value: "[]" } });
    expect(screen.getByTestId("dsgen-save")).toBeDisabled();
    // 修好后可存，保存的是编辑后的内容
    fireEvent.change(box, { target: { value: '[{"name":"edited","input":"改过的问题"}]' } });
    expect(screen.queryByTestId("dsgen-invalid")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("dsgen-save-name"), { target: { value: "edited-ds" } });
    fireEvent.click(screen.getByTestId("dsgen-save"));
    await waitFor(() => {
      const call = calls.find((c) => c.action === "save_dataset");
      expect(call).toBeTruthy();
      expect(call!.cases).toEqual([{ name: "edited", input: "改过的问题" }]);
    });
  });

  it("保存：回归 tab 分支带 kind:regression", async () => {
    await openRegressionGen();
    await generateOk();
    fireEvent.change(screen.getByTestId("dsgen-save-name"), { target: { value: "gen-reg" } });
    fireEvent.click(screen.getByTestId("dsgen-save"));
    await waitFor(() => {
      const call = calls.find((c) => c.action === "save_dataset");
      expect(call).toBeTruthy();
      expect(call!.name).toBe("gen-reg");
      expect(call!.kind).toBe("regression");
      expect((call!.cases as unknown[]).length).toBe(2);
    });
  });

  it("保存：模拟 tab 分支带 kind:simulation", async () => {
    await openSimulationGen();
    await generateOk();
    fireEvent.change(screen.getByTestId("dsgen-save-name"), { target: { value: "gen-sim" } });
    fireEvent.click(screen.getByTestId("dsgen-save"));
    await waitFor(() => {
      const call = calls.find((c) => c.action === "save_dataset");
      expect(call).toBeTruthy();
      expect(call!.name).toBe("gen-sim");
      expect(call!.kind).toBe("simulation");
    });
  });

  it("追加模式：目标在抽屉内选（不依赖表格），请求带 extend_dataset，保存合并 existing、沿用原名与原 kind", async () => {
    await openRegressionGen();
    // 追加目标下拉只在勾选后出现，候选来自当前侧集合（回归侧只有 faq-v3）
    expect(screen.queryByTestId("dsgen-append-target")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("dsgen-append"));
    const target = screen.getByTestId("dsgen-append-target") as HTMLSelectElement;
    // 缺省预选第一个候选，且带用例数（终态锚点：列表数据到齐才有条数）
    expect(target.value).toBe("faq-v3");
    expect(target).toHaveTextContent("faq-v3（2 条）");
    await generateOk();
    const genCall = calls.find((c) => c.action === "generate_dataset");
    expect(genCall!.extend_dataset).toBe("faq-v3");
    // 名称锁定为当前集合名
    expect((screen.getByTestId("dsgen-save-name") as HTMLInputElement).value).toBe("faq-v3");
    expect(screen.getByTestId("dsgen-save-name")).toBeDisabled();
    fireEvent.click(screen.getByTestId("dsgen-save"));
    await waitFor(() => {
      const call = calls.find((c) => c.action === "save_dataset");
      expect(call).toBeTruthy();
      expect(call!.name).toBe("faq-v3");
      expect(call!.kind).toBe("regression");
      const cases = call!.cases as { name?: string }[];
      // 现有 2 条（c1/c2）+ 新生成 2 条
      expect(cases.map((c) => c.name)).toEqual(["c1", "c2", "gen-1", "gen-2"]);
    });
  });

  it("空结果：cases 为空显示错误，不渲染结果区", async () => {
    overrides.generate_dataset = () => [
      { event: "heartbeat", phase: "generate_dataset" },
      {
        event: "dataset_generated", cases: [], agent_context_used: false,
        attachments: [], source_keys: [], extend_dataset: null, existing_cases: null,
      },
    ];
    await openRegressionGen();
    fireEvent.change(screen.getByTestId("dsgen-context"), { target: { value: "背景" } });
    fireEvent.click(screen.getByTestId("dsgen-run"));
    await waitFor(() => {
      expect(screen.getByTestId("dsgen-error")).toHaveTextContent("生成结果为空");
    });
    expect(screen.queryByTestId("dsgen-result")).not.toBeInTheDocument();
  });

  it("附件：转 base64 进请求体 attachments，结果区显示解析说明", async () => {
    await openRegressionGen();
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("dsgen-files"), { target: { files: [file] } });
    await screen.findByTestId("dsgen-att-list");
    expect(screen.getByTestId("dsgen-att-list")).toHaveTextContent("notes.txt");
    await generateOk();
    const call = calls.find((c) => c.action === "generate_dataset");
    expect(call!.attachments).toEqual([{ name: "notes.txt", content_base64: btoa("hello") }]);
    expect(screen.getByTestId("dsgen-att-notes")).toHaveTextContent("notes.txt: 已解析 5 字符");
  });

  it("附件可移除：移除后生成请求不带 attachments", async () => {
    await openRegressionGen();
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("dsgen-files"), { target: { files: [file] } });
    await screen.findByTestId("dsgen-att-list");
    fireEvent.click(screen.getByTestId("dsgen-att-remove-0"));
    expect(screen.queryByTestId("dsgen-att-list")).not.toBeInTheDocument();
    await generateOk();
    const call = calls.find((c) => c.action === "generate_dataset");
    expect(call!.attachments).toBeUndefined();
  });

  it("后端 error 事件：显示错误并复位生成按钮", async () => {
    overrides.generate_dataset = () => [
      { event: "error", error: "请提供文档/描述，或指定一个可提取上下文的 Agent。" },
    ];
    await openRegressionGen();
    fireEvent.change(screen.getByTestId("dsgen-context"), { target: { value: "背景" } });
    fireEvent.click(screen.getByTestId("dsgen-run"));
    await waitFor(() => {
      expect(screen.getByTestId("dsgen-error")).toHaveTextContent("请提供文档/描述");
    });
    expect(screen.getByTestId("dsgen-run")).toHaveTextContent("生成");
    expect(screen.getByTestId("dsgen-run")).not.toBeDisabled();
  });

  // ---------- 形态锁 + 归类搬家提示（ADR-0009） ----------

  it("回归 tab 生成：请求带 case_shape:single，返回纯单轮，保存成功无搬家提示", async () => {
    await openRegressionGen();
    await generateOk();
    const genCall = calls.find((c) => c.action === "generate_dataset");
    expect(genCall!.case_shape).toBe("single");
    // mock 按 single 返回：结果里绝不带多轮字段
    const box = screen.getByTestId("dsgen-cases") as HTMLTextAreaElement;
    expect(box.value).not.toContain("task_description");
    fireEvent.change(screen.getByTestId("dsgen-save-name"), { target: { value: "gen-pure-reg" } });
    fireEvent.click(screen.getByTestId("dsgen-save"));
    // 终态锚点：保存成功后表单卸载（成功专属状态，不与中间态共用）
    await waitFor(() => {
      expect(screen.queryByTestId("dsgen-form")).not.toBeInTheDocument();
    });
    const saveCall = calls.find((c) => c.action === "save_dataset");
    expect(saveCall!.kind).toBe("regression");
    expect((saveCall!.cases as { task_description?: unknown }[]).every((c) => !c.task_description)).toBe(true);
    // 归类侧与当前 tab 一致 → 无搬家提示
    expect(screen.queryByTestId("datasets-side-notice")).not.toBeInTheDocument();
  });

  it("模拟 tab 生成：请求带 case_shape:multi，返回条条带 task_description", async () => {
    await openSimulationGen();
    await generateOk();
    const genCall = calls.find((c) => c.action === "generate_dataset");
    expect(genCall!.case_shape).toBe("multi");
    const cases = JSON.parse((screen.getByTestId("dsgen-cases") as HTMLTextAreaElement).value) as
      { task_description?: string }[];
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => Boolean(c.task_description))).toBe(true);
  });

  it("纯度校验：带 task_description 的 cases 存成 regression 新集 → error 就地显示", async () => {
    await openRegressionGen();
    await generateOk();
    // 手工把生成结果改出多轮字段（模拟越过生成端锁的旁路）
    fireEvent.change(screen.getByTestId("dsgen-cases"), {
      target: { value: '[{"name":"smuggled","input":"开场","task_description":"多轮任务"}]' },
    });
    fireEvent.change(screen.getByTestId("dsgen-save-name"), { target: { value: "gen-smuggle" } });
    fireEvent.click(screen.getByTestId("dsgen-save"));
    await waitFor(() => {
      expect(screen.getByTestId("dsgen-error")).toHaveTextContent("回归数据集不能包含多轮用例");
    });
    // 报错即未保存成功：表单仍在
    expect(screen.getByTestId("dsgen-form")).toBeInTheDocument();
  });

  it("存量豁免 + 搬家提示：覆盖保存已在模拟侧的历史集（同侧）放行，并明说归属 tab", async () => {
    await openRegressionGen();
    await generateOk();
    // flow-multi 是历史多轮集（kind:regression 但形态归模拟侧）：覆盖保存同侧内容
    // 不改变归类侧 → 纯度校验豁免放行；但集合不在当前（回归）tab → 搬家提示
    fireEvent.change(screen.getByTestId("dsgen-cases"), {
      target: { value: '[{"name":"c1","input":"开始订票","task_description":"完成一次订票流程"}]' },
    });
    fireEvent.change(screen.getByTestId("dsgen-save-name"), { target: { value: "flow-multi" } });
    fireEvent.click(screen.getByTestId("dsgen-save"));
    // 终态锚点：搬家提示本体（只有保存成功且判定跨侧才渲染）
    await waitFor(() => {
      expect(screen.getByTestId("datasets-side-notice")).toHaveTextContent("已保存到『模拟测试』tab");
    });
    expect(screen.queryByTestId("dsgen-form")).not.toBeInTheDocument();
  });
});

// ==================== 生成抽屉 + 进行中锁（ADR-0011） ====================
describe("生成抽屉与进行中锁", () => {
  /** 手控流：把生成请求挂在一个不结束的流上，制造「生成中」中间态 */
  function stubHeldStream(action: string) {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("config.json")) return Response.json(CFG);
      const payload = JSON.parse(String(init?.body)) as Payload;
      calls.push(payload);
      if (payload.action === action) {
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return sseResponse(await DEFAULTS[payload.action]!(payload));
    }));
    return {
      heartbeat: () => ctrl.enqueue(
        new TextEncoder().encode(sseFrames([{ event: "heartbeat", phase: action }])),
      ),
    };
  }

  it("三个生成器都在宽档 760 抽屉里，标题各自成立，关闭后表单卸载", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    // ❶ 回归侧
    fireEvent.click(screen.getByTestId("datasets-ai-generate"));
    await screen.findByTestId("dsgen-form");
    let drawer = screen.getByTestId("dsgen-drawer");
    expect(drawer).toHaveClass("drawer-panel", "open");
    expect(drawer).toHaveAttribute("role", "dialog");
    expect(drawer).toHaveAttribute("aria-label", "AI 生成用例");
    expect(drawer).toHaveStyle({ width: "760px" });
    // 未生成、未改动 → 直接关，不问
    fireEvent.click(screen.getByTestId("dsgen-drawer-close"));
    await waitFor(() => expect(screen.queryByTestId("dsgen-form")).not.toBeInTheDocument());
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    // ❷ 模拟侧同壳，标题换成「AI 生成任务」
    fireEvent.click(screen.getByTestId("testdata-tab-simulation"));
    fireEvent.click(screen.getByTestId("simsets-ai-generate"));
    await screen.findByTestId("dsgen-form");
    drawer = screen.getByTestId("dsgen-drawer");
    expect(drawer).toHaveAttribute("aria-label", "AI 生成任务");
    expect(drawer).toHaveStyle({ width: "760px" });
    // ❸ 红队侧独立壳
    fireEvent.click(screen.getByTestId("testdata-tab-redteam"));
    fireEvent.click(screen.getByTestId("redteam-generate"));
    await screen.findByTestId("redteam-generator");
    drawer = screen.getByTestId("redteam-gen-drawer");
    expect(drawer).toHaveAttribute("aria-label", "AI 生成攻击用例");
    expect(drawer).toHaveStyle({ width: "760px" });
  });

  it("进行中锁：生成流式期间 Esc 弹「确定中断？」——取消留在抽屉，确认才关", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    fireEvent.click(screen.getByTestId("datasets-ai-generate"));
    await screen.findByTestId("dsgen-form");
    const held = stubHeldStream("generate_dataset");
    fireEvent.change(screen.getByTestId("dsgen-context"), { target: { value: "背景" } });
    fireEvent.click(screen.getByTestId("dsgen-run"));
    held.heartbeat();
    // 终态锚点：活性行只在 generating 且收到过事件时成立（= 进行中锁已生效）
    await screen.findByTestId("dsgen-liveness");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("confirm-card")).toHaveTextContent("生成中，确定中断？");
    expect(screen.getByTestId("confirm-card-ok")).toHaveTextContent("中断");
    // 默认焦点在取消（危险操作不给回车顺手确认）
    expect(document.activeElement).toBe(screen.getByTestId("confirm-card-cancel"));

    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    // 抽屉还在，生成还在跑
    expect(screen.getByTestId("dsgen-form")).toBeInTheDocument();
    expect(screen.getByTestId("dsgen-liveness")).toBeInTheDocument();

    // mask 与 Esc 同刑；抽屉内的「中断并关闭」也走同一道确认
    fireEvent.click(screen.getByTestId("dsgen-drawer-mask"));
    expect(screen.getByTestId("confirm-card")).toHaveTextContent("生成中，确定中断？");
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(screen.getByTestId("dsgen-close")).toHaveTextContent("中断并关闭");
    fireEvent.click(screen.getByTestId("dsgen-close"));
    expect(screen.getByTestId("confirm-card")).toHaveTextContent("生成中，确定中断？");
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await waitFor(() => expect(screen.queryByTestId("dsgen-form")).not.toBeInTheDocument());
  });

  it("生成完成（review 态）：中断卡换成丢弃卡（结果不落库，丢了要重跑）", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    fireEvent.click(screen.getByTestId("datasets-ai-generate"));
    await screen.findByTestId("dsgen-form");
    fireEvent.change(screen.getByTestId("dsgen-context"), { target: { value: "客服业务背景" } });
    fireEvent.click(screen.getByTestId("dsgen-run"));
    // 终态锚点：结果 JSON 里含第二条生成用例才算 review 态到齐
    await waitFor(() => {
      expect((screen.getByTestId("dsgen-cases") as HTMLTextAreaElement).value)
        .toContain("生成问题二");
    });
    // 生成已结束 → 关闭按钮不再是「中断并关闭」
    expect(screen.getByTestId("dsgen-close")).toHaveTextContent("关闭");
    fireEvent.keyDown(document, { key: "Escape" });
    const card = screen.getByTestId("confirm-card");
    expect(card).not.toHaveTextContent("生成中");
    expect(card).toHaveTextContent("生成结果还没保存，关闭就会丢失（需重新生成）");
    // 取消 → 结果还在，可以继续改/保存
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect((screen.getByTestId("dsgen-cases") as HTMLTextAreaElement).value).toContain("生成问题二");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await waitFor(() => expect(screen.queryByTestId("dsgen-form")).not.toBeInTheDocument());
  });

  it("生成前（空表单）关闭不问：没有结果可丢", async () => {
    renderDatasets();
    await screen.findByTestId("dataset-row-faq-v3");
    fireEvent.click(screen.getByTestId("datasets-ai-generate"));
    await screen.findByTestId("dsgen-form");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("dsgen-form")).not.toBeInTheDocument());
  });

  it("红队生成同样受进行中锁保护", async () => {
    renderDatasets();
    await screen.findByTestId("testdata-pane-dataset");
    fireEvent.click(screen.getByTestId("testdata-tab-redteam"));
    fireEvent.click(screen.getByTestId("redteam-generate"));
    await screen.findByTestId("redteam-gen-cat-guideline_bypass");
    const held = stubHeldStream("generate_redteam_cases");
    fireEvent.change(screen.getByTestId("redteam-gen-agent"), { target: { value: "support-bot" } });
    fireEvent.click(screen.getByTestId("redteam-gen-run"));
    held.heartbeat();
    await screen.findByTestId("redteam-gen-liveness");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("confirm-card")).toHaveTextContent("生成中，确定中断？");
    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(screen.getByTestId("redteam-generator")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await waitFor(() => expect(screen.queryByTestId("redteam-generator")).not.toBeInTheDocument());
  });

  // ---------- UI-008：红队非法 JSON 保存仍可点 ----------

  it("UI-008：红队结果非法/空数组时保存禁用并就地提示，修回合法才放行", async () => {
    renderDatasets();
    await screen.findByTestId("testdata-pane-dataset");
    fireEvent.click(screen.getByTestId("testdata-tab-redteam"));
    fireEvent.click(screen.getByTestId("redteam-generate"));
    await screen.findByTestId("redteam-gen-cat-guideline_bypass");
    fireEvent.change(screen.getByTestId("redteam-gen-agent"), { target: { value: "support-bot" } });
    fireEvent.click(screen.getByTestId("redteam-gen-run"));
    // 终态锚点：结果区里含第二条攻击话术才算生成到齐
    await waitFor(() => {
      expect((screen.getByTestId("redteam-gen-cases") as HTMLTextAreaElement).value)
        .toContain("攻击话术二");
    });
    const box = screen.getByTestId("redteam-gen-cases");
    fireEvent.change(screen.getByTestId("redteam-gen-save-name"), { target: { value: "rt-x" } });
    // ❶ 非法 JSON
    fireEvent.change(box, { target: { value: "[{bad" } });
    expect(screen.getByTestId("redteam-gen-invalid")).toHaveTextContent("非法或为空");
    expect(screen.getByTestId("redteam-gen-save")).toBeDisabled();
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box).toHaveAttribute("aria-describedby", "redteam-gen-invalid");
    // ❷ 空数组（合法 JSON 但存进去就是空集）
    fireEvent.change(box, { target: { value: "[]" } });
    expect(screen.getByTestId("redteam-gen-save")).toBeDisabled();
    // 全程一个 save_dataset 都不该发出
    expect(calls.some((c) => c.action === "save_dataset")).toBe(false);
    // ❸ 修回合法 → 提示消失、按钮解禁、保存成功
    fireEvent.change(box, {
      target: { value: '[{"name":"c1","input":"话术","risk_category":"guideline_bypass"}]' },
    });
    expect(screen.queryByTestId("redteam-gen-invalid")).not.toBeInTheDocument();
    expect(box).not.toHaveAttribute("aria-invalid");
    fireEvent.click(screen.getByTestId("redteam-gen-save"));
    await waitFor(() => {
      const call = calls.find((c) => c.action === "save_dataset");
      expect(call).toBeTruthy();
      expect(call!.name).toBe("rt-x");
      expect(call!.kind).toBe("redteam");
    });
  });
});

// ==================== B 案形态护栏 ====================
describe("B 案形态护栏", () => {
  it("评估器页：表格用 .u-table、操作是文字链、筛选是 .chip、名称挂 .lat", async () => {
    renderEvaluators();
    const table = await screen.findByTestId("evaluators-table");
    expect(table).toHaveClass("u-table");
    const edit = await screen.findByTestId("evaluator-row-brand_tone-edit");
    expect(edit).toHaveClass("btn-link");
    expect(edit).not.toHaveClass("btn");
    const del = screen.getByTestId("evaluator-row-brand_tone-delete");
    expect(del).toHaveClass("btn-link", "danger");
    expect(screen.getByTestId("evaluators-filter-all")).toHaveClass("chip");
    // 名称列 mono（.lat）
    const row = screen.getByTestId("evaluator-row-brand_tone");
    expect(within(row).getByText("brand_tone")).toHaveClass("lat");
    expect(screen.getByTestId("evaluators-card")).toHaveClass("card");
    // 卡标题只留「评估器」；「── 怎么评」是解释（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("evaluators-card"), "怎么评");
  });

  // 拆页后测试数据卡在数据集页，单独 render（两页不再同屏）
  it("数据集页：卡片族 .card、表格 .u-table、用例数列挂 .num", async () => {
    renderDatasets();
    const dsTable = await screen.findByTestId("datasets-table");
    expect(dsTable).toHaveClass("u-table");
    expect(screen.getByTestId("testdata-card")).toHaveClass("card");
    const dsRow = screen.getByTestId("dataset-row-faq-v3");
    expect(within(dsRow).getByText("2")).toHaveClass("num");
  });
});
