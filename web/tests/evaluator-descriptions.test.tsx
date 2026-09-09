// 评估器表「描述」列（2026-08-31 用户：内置评估器只有名字，看不出每个判什么；
// 同日追加：描述看不全 → 全文上屏；默认全列，>100 才分页）。
//
// 契约（app/main.py evaluators 事件，additive）：
//   descriptions?: Record<string, string>   —— 内置名 -> 一句中文描述
// 渲染规则（EvaluatorsPage.tsx）：
//   内置行读 descriptions[name]，缺键显示「—」不编；
//   自定义行读 blocks.goal；无 blocks 的老评估器过 parseRubric 分三档 ——
//   拆得出且有目标 → 用目标；拆得出但目标空（纯档位）→ 「—」不拿档位行冒充
//   （现网 brand_tone 实拍踩到）；拆不出（纯散文零档位）→ 退首行。
//   全文上屏不截断、列内自然折行；文字已全量可见 ⇒ 单元格一律不挂 title；
//   内置行「查看」展开的详情行有完整描述（缺键不渲染该行）；
//   老后端整个 descriptions 键都没有 ⇒ 整列「—」优雅降级，不崩。
// 分页（用户 2026-08-31 裁定）：默认全列，超过 100 个才出现「加载更多」。
// fetch 打桩方式与 resources.test.tsx 一致（stubGlobal + SSE Response）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import EvaluatorsPage from "../src/pages/resources/EvaluatorsPage";
import { resetConfigForTest } from "../src/lib/config";
import { useSession } from "../src/stores/session";
import { sseFrames } from "../src/mocks/handlers";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

// rubric 首行 45 字 —— 旧实现在 40 字截断的长度，钉「长目标也全文上屏」
const LONG_FIRST_LINE =
  "评估回答是否在每个事实性论断处都给出了可以点开验证的出处链接并且出处必须真实可访问";
const EVALUATORS_EVENT = {
  event: "evaluators",
  available: ["coherence", "helpfulness", "refusal"],
  dataset_only: [],
  multimodal: [],
  scopes: {
    coherence: ["observe", "dataset"],
    helpfulness: ["observe", "dataset"],
    refusal: ["observe", "dataset"],
  },
  // 夹具只给 2 条：refusal 刻意缺键 → 该行「—」
  descriptions: {
    coherence: "判回答自身的逻辑连贯与前后一致",
    helpfulness: "从用户视角判回答对解决问题有多大帮助",
  },
  custom: [
    {
      name: "citation_quality",
      rubric: "1.0 每个论断有出处。\n0.0 无出处。",
      scope: "dataset",
      created_at: 1754000000,
      updated_at: 1754000000,
      blocks: {
        goal: "回答中的事实性论断必须可溯源",
        checks: ["论断均有出处"],
        bands: [{ score: 1, desc: "全部可溯源" }],
      },
    },
    {
      // 无 blocks 的老评估器（散文开头 + 档位）：parseRubric 拆出评估目标 = 首行散文
      name: "legacy_no_blocks",
      rubric: `${LONG_FIRST_LINE}\n0.0 无出处。`,
      scope: "all",
      created_at: 1755000000,
      updated_at: 1755600000,
      blocks: null,
    },
    {
      // 无 blocks + **纯档位** rubric（现网 brand_tone 形态）：拆得出但目标空 ⇒ 「—」
      name: "legacy_band_led",
      rubric: "1.0 完全符合品牌语气：专业、克制、不用感叹号。\n0.0 语气随意。",
      scope: "all",
      created_at: 1755100000,
      updated_at: 1755500000,
      blocks: null,
    },
    {
      // 无 blocks + **纯散文** rubric（一个档位都没有，parseRubric 返 null）⇒ 退首行
      name: "legacy_prose_only",
      rubric: "回答必须先复述用户问题再作答。\n复述不完整算部分符合。",
      scope: "all",
      created_at: 1755200000,
      updated_at: 1755400000,
      blocks: null,
    },
  ],
  default: ["helpfulness"],
};

/** >100 才分页的合成夹具：120 个合成内置名（synthetic_001…synthetic_120），零自定义 */
function bigEvaluatorsEvent(n: number): Record<string, unknown> {
  const names = Array.from({ length: n }, (_, i) => `synthetic_${String(i + 1).padStart(3, "0")}`);
  return {
    event: "evaluators",
    available: names,
    dataset_only: [],
    multimodal: [],
    scopes: Object.fromEntries(names.map((name) => [name, ["observe", "dataset"]])),
    descriptions: {},
    custom: [],
    default: [],
  };
}

let evaluatorsEvent: Record<string, unknown> = EVALUATORS_EVENT;

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as { action: string };
    const events = payload.action === "evaluators"
      ? [evaluatorsEvent]
      : [{ event: "error", error: `未打桩 action '${payload.action}'` }];
    return new Response(sseFrames(events), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }));
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}><EvaluatorsPage /></QueryClientProvider>);
}

beforeEach(() => {
  evaluatorsEvent = EVALUATORS_EVENT;
  resetConfigForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("评估器表描述列", () => {
  it("内置行读 descriptions[name] 全文上屏，不挂 title", async () => {
    renderPage();
    // 锚点挑目标数据专属：等 coherence 自己的描述单元格出现（7 行 < 100，全部直接可见）
    const cell = await screen.findByTestId("evaluator-row-coherence-desc");
    expect(cell).toHaveTextContent("判回答自身的逻辑连贯与前后一致");
    // 文字已全量可见 ⇒ title 冗余，整个不挂
    expect(cell).not.toHaveAttribute("title");
    expect(screen.getByTestId("evaluator-row-helpfulness-desc"))
      .toHaveTextContent("从用户视角判回答对解决问题有多大帮助");
  });

  it("缺键的内置行显示「—」且不挂 title（不编内容）", async () => {
    renderPage();
    await screen.findByTestId("evaluator-row-coherence-desc");
    const cell = screen.getByTestId("evaluator-row-refusal-desc");
    expect(cell).toHaveTextContent("—");
    expect(cell).not.toHaveAttribute("title");
  });

  it("自定义行用 blocks.goal 当描述，不挂 title", async () => {
    renderPage();
    const cell = await screen.findByTestId("evaluator-row-citation_quality-desc");
    expect(cell).toHaveTextContent("回答中的事实性论断必须可溯源");
    expect(cell).not.toHaveAttribute("title");
  });

  it("无 blocks 的老自定义评估器：parseRubric 拆出的长目标全文上屏，不截断不挂 title", async () => {
    renderPage();
    const cell = await screen.findByTestId("evaluator-row-legacy_no_blocks-desc");
    // 45 字全文在场（旧实现 40 字截断 + …，截断串装不下全文）
    expect(cell).toHaveTextContent(LONG_FIRST_LINE);
    expect(cell.textContent).not.toContain("…");
    expect(cell).not.toHaveAttribute("title");
  });

  it("纯档位 rubric（brand_tone 形态）：档位行不冒充描述 ⇒ 「—」且不挂 title", async () => {
    renderPage();
    const cell = await screen.findByTestId("evaluator-row-legacy_band_led-desc");
    expect(cell).toHaveTextContent("—");
    // 双钉：版面无档位字样 + title 整个不挂（拿档位专属字样当锚，别用两态都有的词）
    expect(cell).not.toHaveTextContent("完全符合品牌语气");
    expect(cell).not.toHaveAttribute("title");
  });

  it("纯散文 rubric（零档位，parseRubric 返 null）：退首行，不挂 title", async () => {
    renderPage();
    const cell = await screen.findByTestId("evaluator-row-legacy_prose_only-desc");
    expect(cell).toHaveTextContent("回答必须先复述用户问题再作答。");
    expect(cell).not.toHaveAttribute("title");
  });

  it("老后端没有 descriptions 键：内置列整列「—」，页面不崩", async () => {
    const { descriptions: _dropped, ...legacy } = EVALUATORS_EVENT;
    evaluatorsEvent = legacy;
    renderPage();
    const cell = await screen.findByTestId("evaluator-row-coherence-desc");
    expect(cell).toHaveTextContent("—");
    expect(screen.getByTestId("evaluator-row-helpfulness-desc")).toHaveTextContent("—");
    expect(screen.getByTestId("evaluator-row-refusal-desc")).toHaveTextContent("—");
    // 自定义行不受影响：描述仍来自它自己的 blocks.goal
    expect(screen.getByTestId("evaluator-row-citation_quality-desc"))
      .toHaveTextContent("回答中的事实性论断必须可溯源");
  });

  it("内置行「查看」展开的详情行有完整描述；缺键的行不渲染描述（不编内容）", async () => {
    renderPage();
    await screen.findByTestId("evaluator-row-coherence-desc");
    fireEvent.click(screen.getByTestId("evaluator-row-coherence-view"));
    expect(screen.getByTestId("evaluator-row-coherence-detail-desc"))
      .toHaveTextContent("判回答自身的逻辑连贯与前后一致");
    // refusal 缺 descriptions 键：详情行照常展开，但没有描述那一行
    fireEvent.click(screen.getByTestId("evaluator-row-refusal-view"));
    expect(screen.getByTestId("evaluator-row-refusal-detail")).toBeInTheDocument();
    expect(screen.queryByTestId("evaluator-row-refusal-detail-desc")).not.toBeInTheDocument();
  });
});

describe("评估器分页（用户 2026-08-31：默认全列，>100 才分页）", () => {
  it("超过 100 条：首屏 100 行 + 「加载更多」在场，点开后全量", async () => {
    evaluatorsEvent = bigEvaluatorsEvent(120);
    renderPage();
    // 第 100 行在场、第 101 行不在场（首屏恰好 100 行）
    await screen.findByTestId("evaluator-row-synthetic_100");
    expect(screen.queryByTestId("evaluator-row-synthetic_101")).not.toBeInTheDocument();
    expect(screen.getByTestId("evaluators-foot-note"))
      .toHaveTextContent("显示 1–100，共 120 个评估器");
    fireEvent.click(screen.getByTestId("evaluators-load-more"));
    expect(screen.getByTestId("evaluator-row-synthetic_120")).toBeInTheDocument();
    expect(screen.queryByTestId("evaluators-load-more")).not.toBeInTheDocument();
  });

  it("不超过 100 条：全部直接可见，「加载更多」不在场", async () => {
    renderPage();
    // 默认夹具 7 条（自定义 4 + 内置 3）：末尾的内置行不用翻页就在
    await screen.findByTestId("evaluator-row-refusal");
    expect(screen.getByTestId("evaluators-foot-note"))
      .toHaveTextContent("显示 1–7，共 7 个评估器");
    expect(screen.queryByTestId("evaluators-load-more")).not.toBeInTheDocument();
  });
});
