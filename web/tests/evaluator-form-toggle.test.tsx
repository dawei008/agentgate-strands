// 评估器表单「分块 ⇄ 原始文本」切换时的内容搬运。
//
// 用户 2026-08-29 实测（编辑 policy_compliance → 点「切换到分块模式」）：
// 「切换到分块模式没有内容」—— 老评估器只有 rubric（blocks=null）打开就是原始
// 文本模式，切过去三段 state 从来没被填过 ⇒ 空白表单，而他的原文在界面上**没有
// 任何地方显示**（还在 rawText state 里，但看不见 = 等于丢了）。
//
// 为什么单开一个文件而不是塞进 resources.test.tsx：缺陷全在表单自己的 state
// 搬运上（不过页面/不过 API），直接挂 EvaluatorForm 就能复现，比走整页省一份
// 页面级打桩；而这些用例要的夹具是「blocks=null + 结构形态 rubric 的老评估器」，
// 它不能进页面级 mock —— 那会多一行评估器表格，视觉基线跟着腐烂。
// 页面路径（编辑按钮 → 抽屉 → 表单）另有一条钉子在 resources.test.tsx。
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import EvaluatorForm from "../src/pages/resources/EvaluatorForm";
import type { CustomEvaluator } from "../src/pages/resources/types";

/** 现网真有的老评估器形态：只有 rubric、blocks=null。文本逐字节 = buildRubric 的产出 */
const LEGACY_RUBRIC =
  "判断回复是否符合公司政策与合规口径\n" +
  "【关注点】\n1. 引用现行政策版本\n2. 不承诺无法兑现的赔付\n" +
  "【评分标准】\n1.0 = 完全符合且引用准确\n0.5 = 大体符合但引用陈旧\n0.0 = 与政策冲突";

/** 现网 policy_compliance 的真实形态节选：档位写成 `Score 1.0：`，且带缩进续行。
 *  拆得出内容，但**不逐字节可复原**（折行会被合并、小节标题会重排）—— lossy 那一支。
 *  逐字节全文另有一条钉子在 tests/evaluator-rubric-parse.test.ts。 */
const LOSSY_RUBRIC =
  "你在评判一个航空客服 Agent 的回答是否守住了公司政策。\n" +
  "1. 政策结论是否正确\n" +
  "2. 是否被施压带走 —— 用户声称「客服已批准」\n" +
  "   「我很生气」一类压力，都不构成政策例外；\n" +
  "Score 1.0：三条全中。\n" +
  "Score 0.0：政策结论错误。";

/** 拆不出任何档位的老文本（纯散文，没有行首分值）—— 拆解失败那一支 */
const PROSE_RUBRIC = "请综合判断回答质量，注意语气、准确性与合规性。\n遇到拿不准的场景以人工复核为准。";

function legacy(rubric: string, name = "policy_compliance"): CustomEvaluator {
  return { name, rubric, scope: "all", created_at: 1754000000, updated_at: 1755600000, blocks: null };
}

function renderEdit(evaluator: CustomEvaluator) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <EvaluatorForm mode="edit" evaluator={evaluator} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

function renderCreate() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <EvaluatorForm mode="create" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

const val = (testid: string) =>
  (screen.getByTestId(testid) as HTMLInputElement | HTMLTextAreaElement).value;

const toggle = () => fireEvent.click(screen.getByTestId("evaluator-form-toggle-raw"));

afterEach(() => cleanup());

describe("评估器表单：原始文本 → 分块", () => {
  it("可拆解的老 rubric 预填三段（用户实测那一幕：过去这里全空）", () => {
    renderEdit(legacy(LEGACY_RUBRIC));
    // 开局按既有纪律仍在原始文本模式（本次只修切换，不改打开时的落点）
    expect(val("evaluator-form-raw")).toBe(LEGACY_RUBRIC);
    toggle();
    expect(val("evaluator-form-goal")).toBe("判断回复是否符合公司政策与合规口径");
    expect(val("evaluator-form-check-0")).toBe("引用现行政策版本");
    expect(val("evaluator-form-check-1")).toBe("不承诺无法兑现的赔付");
    expect(val("evaluator-form-band-0-score")).toBe("1.0");
    expect(val("evaluator-form-band-0-criteria")).toBe("完全符合且引用准确");
    expect(val("evaluator-form-band-1-score")).toBe("0.5");
    expect(val("evaluator-form-band-1-criteria")).toBe("大体符合但引用陈旧");
    expect(val("evaluator-form-band-2-criteria")).toBe("与政策冲突");
    // 拆解成功不该有提示条
    expect(screen.queryByTestId("evaluator-form-parse-note")).not.toBeInTheDocument();
  });

  it("松散形态（无小节标题）也预填：行首分值就是档位", () => {
    renderEdit(legacy("1.0 完全符合品牌语气。\n0.0 语气随意。", "brand_tone"));
    toggle();
    expect(val("evaluator-form-band-0-criteria")).toBe("完全符合品牌语气。");
    expect(val("evaluator-form-band-1-criteria")).toBe("语气随意。");
  });

  it("拆不出档位：仍然切 + 出提示，切回原始文本模式原文逐字节还在", () => {
    renderEdit(legacy(PROSE_RUBRIC));
    toggle();
    // 用户点了就是要切：分块表单在，且明说原文去哪了
    expect(screen.getByTestId("evaluator-form-goal")).toBeInTheDocument();
    const note = screen.getByTestId("evaluator-form-parse-note");
    expect(note).toHaveTextContent("原始文本不是分块格式，拆不出档位");
    expect(note).toHaveTextContent("切回原始文本模式可以拿回原文");
    // 原文没被吃掉
    toggle();
    expect(val("evaluator-form-raw")).toBe(PROSE_RUBRIC);
  });

  it("提示条只描述刚刚那次切换：一改分块字段就消失", () => {
    renderEdit(legacy(PROSE_RUBRIC));
    toggle();
    expect(screen.getByTestId("evaluator-form-parse-note")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("evaluator-form-goal"), { target: { value: "新目标" } });
    expect(screen.queryByTestId("evaluator-form-parse-note")).not.toBeInTheDocument();
  });
});

describe("评估器表单：分块 → 原始文本", () => {
  it("播种拼好的 rubric（新建填完三段切过去，textarea 不再是空的）", () => {
    renderCreate();
    fireEvent.change(screen.getByTestId("evaluator-form-goal"), { target: { value: "目标一句话" } });
    fireEvent.change(screen.getByTestId("evaluator-form-check-0"), { target: { value: "关注点A" } });
    fireEvent.change(screen.getByTestId("evaluator-form-band-0-criteria"), { target: { value: "满分条件" } });
    fireEvent.change(screen.getByTestId("evaluator-form-band-1-criteria"), { target: { value: "零分条件" } });
    toggle();
    expect(val("evaluator-form-raw")).toBe(
      "目标一句话\n【关注点】\n1. 关注点A\n【评分标准】\n1.0 = 满分条件\n0.0 = 零分条件",
    );
  });

  it("手改过的原始文本不被播种覆盖", () => {
    renderCreate();
    fireEvent.change(screen.getByTestId("evaluator-form-goal"), { target: { value: "目标一句话" } });
    fireEvent.change(screen.getByTestId("evaluator-form-band-0-criteria"), { target: { value: "满分条件" } });
    toggle();
    // 先钉住播种真的发生过：否则「不被覆盖」在旧代码（从不播种）里也恒绿
    expect(val("evaluator-form-raw")).toBe("目标一句话\n【评分标准】\n1.0 = 满分条件");
    // 手写：故意写成拆不出档位的散文，播种值与它不同
    fireEvent.change(screen.getByTestId("evaluator-form-raw"), { target: { value: "我手写的评分说明" } });
    toggle();  // → 分块
    toggle();  // → 原始
    expect(val("evaluator-form-raw")).toBe("我手写的评分说明");
  });
});

describe("评估器表单：拆得出但与原文不逐字节一致（lossy）", () => {
  it("预填三段 + 明说保存会重排原文（`Score 1.0：` 形态，用户报的那一个）", () => {
    renderEdit(legacy(LOSSY_RUBRIC));
    toggle();
    expect(val("evaluator-form-goal")).toBe("你在评判一个航空客服 Agent 的回答是否守住了公司政策。");
    expect(val("evaluator-form-check-0")).toBe("政策结论是否正确");
    // 缩进续行并进上一条，不另起一条
    expect(val("evaluator-form-check-1")).toContain("「我很生气」一类压力");
    expect(screen.queryByTestId("evaluator-form-check-2")).not.toBeInTheDocument();
    expect(val("evaluator-form-band-0-score")).toBe("1.0");
    expect(val("evaluator-form-band-0-criteria")).toBe("三条全中。");
    expect(val("evaluator-form-band-1-criteria")).toBe("政策结论错误。");
    const note = screen.getByTestId("evaluator-form-parse-note");
    expect(note).toHaveTextContent("排版与原文不完全一致");
    expect(note).toHaveTextContent("切回原始文本模式可以拿回原文");
  });

  it("lossy 提示条**不**随编辑消失（它说的是保存会重排，编辑之后更成立）", () => {
    renderEdit(legacy(LOSSY_RUBRIC));
    toggle();
    fireEvent.change(screen.getByTestId("evaluator-form-goal"), { target: { value: "新目标" } });
    expect(screen.getByTestId("evaluator-form-parse-note")).toHaveTextContent("排版与原文不完全一致");
  });

  it("改过分块字段再切回去，原文仍逐字节在（有损拆解不许登记成播种值）", () => {
    renderEdit(legacy(LOSSY_RUBRIC));
    toggle();
    // 先钉住这一次拆解**成功**了：否则拆解失败那一支也不覆盖 rawText，
    // 这条断言在「一档都认不出」的世界里同样为真 —— 那就不是在钉 lossy 这条路径
    expect(val("evaluator-form-band-0-criteria")).toBe("三条全中。");
    fireEvent.change(screen.getByTestId("evaluator-form-goal"), { target: { value: "新目标" } });
    toggle();
    expect(val("evaluator-form-raw")).toBe(LOSSY_RUBRIC);
  });
});
