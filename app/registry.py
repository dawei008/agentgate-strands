"""Evaluator registry: payload name -> evaluator factory.

Only no-required-arg, reference-free evaluators are exposed, since production
traces carry no expected output. All of them accept a judge model override.
"""

import importlib
import inspect

from strands_evals.evaluators import (
    CoherenceEvaluator,
    ConcisenessEvaluator,
    CorrectnessEvaluator,
    FaithfulnessEvaluator,
    GoalSuccessRateEvaluator,
    HarmfulnessEvaluator,
    HelpfulnessEvaluator,
    InstructionFollowingEvaluator,
    InteractionsEvaluator,
    MultimodalCorrectnessEvaluator,
    MultimodalFaithfulnessEvaluator,
    MultimodalInstructionFollowingEvaluator,
    MultimodalOverallQualityEvaluator,
    OutputEvaluator,
    RefusalEvaluator,
    ResponseRelevanceEvaluator,
    StereotypingEvaluator,
    ToolParameterAccuracyEvaluator,
    ToolSelectionAccuracyEvaluator,
)

INTERACTIONS_RUBRIC = """评估这段（可能含多智能体/多步骤协作的）执行过程：
1. 各步骤/组件的响应是否恰当地基于其前序依赖；
2. 组件之间传递的信息是否完整、无丢失无曲解；
3. 整体协作链路是否逻辑连贯并最终服务于用户目标。
Score 1.0 协作顺畅无信息损耗；0.5 有可察觉的衔接问题但结果尚可；
0.0 协作断裂或信息丢失导致结果错误。"""

EVALUATOR_CLASSES = {
    "helpfulness": HelpfulnessEvaluator,
    "coherence": CoherenceEvaluator,
    "conciseness": ConcisenessEvaluator,
    "faithfulness": FaithfulnessEvaluator,
    "goal_success_rate": GoalSuccessRateEvaluator,
    "harmfulness": HarmfulnessEvaluator,
    "instruction_following": InstructionFollowingEvaluator,
    "interactions": InteractionsEvaluator,
    "refusal": RefusalEvaluator,
    "response_relevance": ResponseRelevanceEvaluator,
    "stereotyping": StereotypingEvaluator,
    "tool_parameter_accuracy": ToolParameterAccuracyEvaluator,
    "tool_selection_accuracy": ToolSelectionAccuracyEvaluator,
}

# Constructors needing extra defaults beyond (model=, name=).
EVALUATOR_KWARGS = {
    "interactions": {"rubric": INTERACTIONS_RUBRIC},
}

# ---------- judge 语言跟提示词走（批 judge-zh） ----------
#
# 内置评估器 `system_prompt=None` 时取 SDK 的英文模板，于是判定理由（reason）
# 与问题条目的建议全是英文；我们自写的提示词（observe/planrun）早就写了「用中文」。
# 修法：构造时传 `SDK 原模板 + 下面这段`，只改理由的语言。label / score 等枚举
# （"Very helpful" / "Not Concise" / "Yes"…）必须留英文——前端与统计按它匹配。
# 模板按类现取（不同类模板不同，且 correctness / goal_success_rate 各有第二份
# 提示词），不手抄一份英文进仓库。覆盖完整性由 tests/test_registry_zh.py 逐个钉。
JUDGE_ZH_ADDENDUM = (
    "\n\n输出 JSON 时，reason / reasoning（判定理由）字段用简体中文书写；"
    "label / score / verdict / test_pass 等其它字段的取值保持模板规定的原样"
    "（英文枚举、数值），不得翻译。"
)

# 除 system_prompt 外还会送进 judge 的第二份提示词（SDK 按用例有无参考答案/断言分流）。
_EXTRA_PROMPT_PARAMS = {
    "correctness": ("reference_system_prompt",),      # 有 expected_output 时走它
    "goal_success_rate": ("assertion_system_prompt",),  # 有 success criteria 时走它
}
_TEMPLATE_GETTER = {
    "system_prompt": "get_template",
    "reference_system_prompt": "get_reference_template",
    "assertion_system_prompt": "get_assertion_template",
}


def sdk_default_prompt(cls, param: str = "system_prompt") -> str:
    """SDK 在 `param` 留空时实际使用的英文模板（与该类构造函数同一取法）。

    三种来源（2026-09-04 实测 strands_evals）：
      · 字面默认值（InteractionsEvaluator / OutputEvaluator）；
      · `get_template(version).SYSTEM_PROMPT`，version 取构造函数默认值（13 个分版本类，
        getter 从该类所在模块取——它就是模块顶部 import 进来的那个）；
      · MLLM_JUDGE_SYSTEM_PROMPT（4 个 Multimodal*：基类 MultimodalOutputEvaluator 兜底）。
    """
    sig = inspect.signature(cls.__init__)
    default = sig.parameters[param].default
    if isinstance(default, str):
        return default
    module = importlib.import_module(cls.__module__)
    getter = getattr(module, _TEMPLATE_GETTER[param], None)
    if getter is not None:
        return getter(sig.parameters["version"].default).SYSTEM_PROMPT
    from strands_evals.evaluators.multimodal_output_evaluator import MLLM_JUDGE_SYSTEM_PROMPT
    return MLLM_JUDGE_SYSTEM_PROMPT


def judge_prompt_kwargs(name: str, cls) -> dict[str, str]:
    """一个内置评估器的全部 judge 提示词 kwargs：{参数名: SDK 模板 + 中文附加段}。"""
    params = ("system_prompt", *_EXTRA_PROMPT_PARAMS.get(name, ()))
    return {p: sdk_default_prompt(cls, p) + JUDGE_ZH_ADDENDUM for p in params}

DEFAULT_EVALUATORS = ["helpfulness", "tool_selection_accuracy"]
DEFAULT_JUDGE_MODEL = "global.anthropic.claude-sonnet-5"

# Reference-based evaluators: meaningful only when cases carry expected_output
# (dataset test mode). Kept out of observability-mode defaults.
DATASET_EVALUATORS = {
    "correctness": CorrectnessEvaluator,
}

# MLLM-as-a-Judge evaluators: the judge sees the case's image alongside the
# agent's answer, so it can tell "the agent described this receipt correctly"
# from "the agent produced a plausible-sounding receipt". Only usable on cases
# whose input is a MultimodalInput (dataset mode); on a text-only case the SDK
# silently degrades to a text judge, which would just duplicate `correctness`.
#
# Scope, stated honestly: the SDK implements images only (types/multimodal.py
# AnyMediaData = ImageData), and the target is a text-returning Runtime blackbox.
# So this grades image-GROUNDED answers, never image outputs.
MULTIMODAL_EVALUATORS = {
    "mm_correctness": MultimodalCorrectnessEvaluator,
    "mm_faithfulness": MultimodalFaithfulnessEvaluator,
    "mm_instruction_following": MultimodalInstructionFollowingEvaluator,
    "mm_overall_quality": MultimodalOverallQualityEvaluator,
}


# 每个内置评估器一句话描述：说「判什么」——即它与其他评估器的差异点，
# 不写对任何评估器都成立的废话。文案依据 strands_evals 各评估器类的
# docstring / judge prompt 提炼（分向评估器把记分方向写明，如 refusal
# 拒绝记 1 分、harmfulness 无害记满分）。UI 评估器表「描述」列直接消费；
# 覆盖完整性由 tests/test_registry_descriptions.py 的集合等式钉死——
# 将来新增内置评估器忘写描述会红。
EVALUATOR_DESCRIPTIONS = {
    "helpfulness": "从用户视角判回答对解决问题有多大帮助",
    "coherence": "判回答自身的逻辑连贯与前后一致",
    "conciseness": "判回答是否简洁不冗余",
    "faithfulness": "判回答是否忠于对话上下文、无凭空捏造",
    "goal_success_rate": "判整段对话是否完成了用户的全部目标",
    "harmfulness": "判回答是否含有害内容（无害记满分）",
    "instruction_following": "判回答是否遵守提示里的每条明确指令",
    "interactions": "判多智能体/多步骤协作链路的衔接质量",
    "refusal": "判回答是否拒绝了本次请求（拒绝记 1 分）",
    "response_relevance": "判回答内容与用户提问的相关程度",
    "stereotyping": "判回答是否含偏见或刻板印象（无则满分）",
    "tool_parameter_accuracy": "判工具调用参数是否忠实取自上下文信息",
    "tool_selection_accuracy": "判每次工具调用在当下是否合理必要",
    "correctness": "对照用例期望输出判回答的正确性",
    "mm_correctness": "对照用例图片判回答的事实准确与完整",
    "mm_faithfulness": "判回答是否只基于图片内容、无幻觉",
    "mm_instruction_following": "判基于图片的回答是否满足指令要求与约束",
    "mm_overall_quality": "按视觉准确/守指令/完整/连贯四维综合打分",
}


def evaluator_descriptions() -> dict[str, str]:
    """内置评估器名 -> 一句中文描述，覆盖全部内置名（含 dataset/multimodal）。

    自定义评估器不在此列：前端拿它自己的 blocks.goal（评估目标）当描述。
    """
    return dict(EVALUATOR_DESCRIPTIONS)


def evaluator_scopes() -> dict[str, list[str]]:
    """适用环节映射，覆盖全部内置评估器：{名字: ["observe","dataset"] 或 ["dataset"]}。

    "observe" = 观测环节（生产 trace，无期望输出）；"dataset" = 数据集回归环节。
    Reference-free evaluators work in both; `correctness` needs expected_output
    and `mm_*` need a case image, so they are dataset-only. The UI consumes this
    verbatim from the `evaluators` action — keys are the payload names.
    """
    scopes = {name: ["observe", "dataset"] for name in EVALUATOR_CLASSES}
    for name in (*DATASET_EVALUATORS, *MULTIMODAL_EVALUATORS):
        scopes[name] = ["dataset"]
    return scopes


def dataset_only_evaluators() -> frozenset[str]:
    """Builtin names that must never appear in an observe stage."""
    return frozenset(DATASET_EVALUATORS) | frozenset(MULTIMODAL_EVALUATORS)


def dataset_evaluator_names() -> list[str]:
    return sorted(DATASET_EVALUATORS)


def multimodal_evaluator_names() -> list[str]:
    return sorted(MULTIMODAL_EVALUATORS)


def available_evaluators() -> list[str]:
    return sorted(EVALUATOR_CLASSES)


def build_evaluators(names: list[str] | None, judge_model: str | None,
                     custom_rubrics: dict[str, str] | None = None):
    """Instantiate evaluators by name with the given judge model.

    Custom evaluator names resolve through custom_rubrics ({name: rubric}) to
    OutputEvaluator instances. Raises ValueError on unknown names.
    """
    names = names or DEFAULT_EVALUATORS
    # judge 走可配置的 provider：Bedrock 传模型 id 字符串，OpenAI 兼容端点
    # 传 OpenAIModel 实例（strands 评估器两者都接受）。
    import judgellm
    model = judgellm.strands_model(judge_model)
    custom_rubrics = custom_rubrics or {}
    all_classes = {**EVALUATOR_CLASSES, **DATASET_EVALUATORS, **MULTIMODAL_EVALUATORS}
    unknown = [n for n in names if n not in all_classes and n not in custom_rubrics]
    if unknown:
        raise ValueError(
            f"Unknown evaluators: {unknown}. "
            f"Available: {available_evaluators()} + multimodal: {multimodal_evaluator_names()}"
            f" + custom: {sorted(custom_rubrics)}"
        )
    result = []
    for n in names:
        if n in all_classes:
            cls = all_classes[n]
            kwargs = {**EVALUATOR_KWARGS.get(n, {}), **judge_prompt_kwargs(n, cls)}
            result.append(cls(model=model, name=n, **kwargs))
        else:
            result.append(OutputEvaluator(
                rubric=custom_rubrics[n], model=model, name=n,
                system_prompt=sdk_default_prompt(OutputEvaluator) + JUDGE_ZH_ADDENDUM))
    return result
