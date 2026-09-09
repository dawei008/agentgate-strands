"""内置评估器判定理由中文化（批 judge-zh）的静态钉。

现场：strands_evals 内置评估器 `system_prompt=None` 时取 SDK 英文模板
（`get_template(version).SYSTEM_PROMPT` / 字面默认值 / MLLM_JUDGE_SYSTEM_PROMPT），
于是会话判定的 reason 全是英文。修法：registry 构造时传
`system_prompt = SDK 原模板 + 中文附加段`，只改理由的语言，label / score 等枚举
不动（前端与统计按英文枚举匹配）。

两条硬约束（对全部 18 个内置名逐个钉，不抽样）：
  1. 实例的每个 judge 提示词以附加段结尾；
  2. 去掉附加段后的前缀 == SDK 模板原文——模板在本测试里按类**独立**解析
     （显式表，不复用 registry 的解析器），registry 解析错了这里会红。
不触网：model 传占位字符串，strands Agent 到 evaluate 时才建。
Run: python3 -m pytest tests/test_registry_zh.py -q
"""

import importlib
import inspect
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import registry  # noqa: E402

_TPL = "strands_evals.evaluators.prompt_templates"

# 名字 -> (模板包, 取模板的函数名)。版本用各类构造函数 `version` 参数的默认值。
_VERSIONED = {
    "helpfulness": "helpfulness", "coherence": "coherence", "conciseness": "conciseness",
    "faithfulness": "faithfulness", "goal_success_rate": "goal_success_rate",
    "harmfulness": "harmfulness", "instruction_following": "instruction_following",
    "refusal": "refusal", "response_relevance": "response_relevance",
    "stereotyping": "stereotyping", "tool_parameter_accuracy": "tool_parameter_accuracy",
    "tool_selection_accuracy": "tool_selection_accuracy", "correctness": "correctness",
}
_MULTIMODAL = ("mm_correctness", "mm_faithfulness", "mm_instruction_following", "mm_overall_quality")


def _all_classes():
    return {**registry.EVALUATOR_CLASSES, **registry.DATASET_EVALUATORS,
            **registry.MULTIMODAL_EVALUATORS}


def _expected_sdk_prompt(name: str, cls, param: str = "system_prompt") -> str:
    """测试侧独立解析 SDK 英文模板（不走 registry）。"""
    if name in _VERSIONED:
        version = inspect.signature(cls.__init__).parameters["version"].default
        pkg = importlib.import_module(f"{_TPL}.{_VERSIONED[name]}")
        getter = {"system_prompt": "get_template",
                  "reference_system_prompt": "get_reference_template",
                  "assertion_system_prompt": "get_assertion_template"}[param]
        return getattr(pkg, getter)(version).SYSTEM_PROMPT
    if name in _MULTIMODAL:
        return importlib.import_module(f"{_TPL}.multimodal_judge_system_prompt").MLLM_JUDGE_SYSTEM_PROMPT
    if name == "interactions":
        return importlib.import_module(f"{_TPL}.prompt_templates").judge_interactions_template
    raise AssertionError(f"测试表漏了 {name}")


def _build(names, rubrics=None):
    import judgellm
    with mock.patch.object(judgellm, "strands_model", return_value="placeholder-model"):
        return registry.build_evaluators(names, "judge-model", rubrics)


class TestBuiltinReasonZh(unittest.TestCase):
    def test_addendum_asks_for_chinese_reason_and_keeps_enums(self):
        add = registry.JUDGE_ZH_ADDENDUM
        self.assertIn("简体中文", add)
        self.assertIn("reason", add)
        for keep in ("label", "score", "test_pass"):
            self.assertIn(keep, add)
        self.assertIn("不得翻译", add)

    def test_every_builtin_prompt_is_sdk_template_plus_addendum(self):
        classes = _all_classes()
        self.assertEqual(len(classes), 18)
        instances = dict(zip(sorted(classes), _build(sorted(classes))))
        for name, inst in instances.items():
            with self.subTest(evaluator=name):
                self.assertIsInstance(inst, classes[name])
                got = inst.system_prompt
                self.assertTrue(got.endswith(registry.JUDGE_ZH_ADDENDUM), name)
                self.assertEqual(got[: -len(registry.JUDGE_ZH_ADDENDUM)],
                                 _expected_sdk_prompt(name, classes[name]))
                # 前缀确实是英文模板，附加段才是中文
                self.assertNotIn("简体中文", got[: -len(registry.JUDGE_ZH_ADDENDUM)])

    def test_secondary_prompts_of_correctness_and_goal_success_rate_also_carry_it(self):
        # 数据集模式恒带 expected_output ⇒ correctness 实际走 reference_system_prompt；
        # goal_success_rate 带断言时走 assertion_system_prompt。两者的 reasoning 一样进 reason。
        corr, gsr = _build(["correctness", "goal_success_rate"])
        add = registry.JUDGE_ZH_ADDENDUM
        self.assertTrue(corr.reference_system_prompt.endswith(add))
        self.assertEqual(corr.reference_system_prompt[: -len(add)],
                         _expected_sdk_prompt("correctness", type(corr), "reference_system_prompt"))
        self.assertTrue(gsr.assertion_system_prompt.endswith(add))
        self.assertEqual(gsr.assertion_system_prompt[: -len(add)],
                         _expected_sdk_prompt("goal_success_rate", type(gsr), "assertion_system_prompt"))

    def test_custom_rubric_evaluator_uses_output_evaluator_default_plus_addendum(self):
        from strands_evals.evaluators import OutputEvaluator
        (inst,) = _build(["my_rubric"], {"my_rubric": "满分条件：回答提到退款期限。"})
        self.assertIsInstance(inst, OutputEvaluator)
        default = inspect.signature(OutputEvaluator.__init__).parameters["system_prompt"].default
        self.assertEqual(inst.system_prompt, default + registry.JUDGE_ZH_ADDENDUM)
        # 自写 rubric 原样，不被附加段污染
        self.assertEqual(inst.rubric, "满分条件：回答提到退款期限。")

    def test_interactions_rubric_is_untouched(self):
        (inst,) = _build(["interactions"])
        self.assertEqual(inst.rubric, registry.INTERACTIONS_RUBRIC)
        self.assertNotIn(registry.JUDGE_ZH_ADDENDUM, inst.rubric)


if __name__ == "__main__":
    unittest.main()
