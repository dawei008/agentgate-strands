"""三处建议节的落点枚举**逐字同源** + 回归/综合两侧的四要素形状（文本级钉）。

建议节现在有三个生成端：
  · app/observe.py  ANALYSIS_SYSTEM_PROMPT   —— 线上评估
  · app/testrun.py  RUN_ANALYSIS_PROMPT      —— 回归/红队的用例侧
  · app/planrun.py  SYNTHESIS_SYSTEM_PROMPT  —— 跨 run 综合报告的「当前优先建议」

三处的落点枚举必须**逐字一致**：它是同一条护栏（平台看不见用户 Agent 的源码，
所以落点只能取平台真看得见的那几处）。三份文案一旦漂移，就会出现「同一个平台在
一份报告里禁止编造代码位置、在另一份里默许」——而用户读到的是同一个抽屉。
没有共享模块（提示词各自内嵌），所以同源性只能靠这条测试维持。

⚠️ 提示词的**实际产出**未经真 run 验证（发起 run 是硬禁止）：这里钉的是提示词
自身的形态，产出侧由 web/tests/report-actionable-*.test.tsx 用手写样本覆盖。

运行：python3 -m pytest tests/test_planrun_prompt_actions.py -q
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import observe  # noqa: E402
import planrun  # noqa: E402
import testrun  # noqa: E402


def section(prompt: str, title: str) -> str:
    marker = f"\n## {title}\n"
    assert marker in prompt, f"提示词里没有 `## {title}` 这一节"
    rest = prompt.split(marker, 1)[1]
    return rest.split("\n## ", 1)[0]


class SpecIsWordForWordIdenticalAcrossAllThree(unittest.TestCase):

    def test_the_three_modules_carry_byte_identical_action_item_specs(self):
        a, b, c = (observe.ACTION_ITEM_SPEC, testrun.ACTION_ITEM_SPEC,
                   planrun.ACTION_ITEM_SPEC)
        self.assertEqual(a, b, "observe 与 testrun 的建议节规格漂移了")
        self.assertEqual(b, c, "testrun 与 planrun 的建议节规格漂移了")
        # 非空且真是那一段（防「三处同时改成空串」这种同源假绿）
        self.assertIn("【落点只能从这五类里选（强制）】", a)
        self.assertGreater(len(a), 500)

    def test_each_prompt_actually_embeds_the_spec_in_its_suggestion_section(self):
        spec = planrun.ACTION_ITEM_SPEC
        self.assertIn(
            spec, section(observe.ANALYSIS_SYSTEM_PROMPT, "建议（行动清单）"))
        self.assertIn(
            spec, section(testrun.RUN_ANALYSIS_PROMPT, "建议（行动清单）"))
        self.assertIn(
            spec, section(planrun.SYNTHESIS_SYSTEM_PROMPT, "当前优先建议"))

    def test_the_five_landing_spots_are_each_numbered_once(self):
        spec = planrun.ACTION_ITEM_SPEC
        for n in ("1. ", "2. ", "3. ", "4. ", "5. "):
            self.assertEqual(spec.count(f"\n{n}"), 1,
                             f"落点枚举的第 {n.strip()} 项不是恰好一条")
        self.assertNotIn("\n6. ", spec, "落点枚举只有五类，不许加第六类")


class DatasetSideKeepsItsCalibration(unittest.TestCase):
    """testrun 的建议节：改结构不改口径。"""

    def setUp(self):
        self.sec = section(testrun.RUN_ANALYSIS_PROMPT, "建议（行动清单）")

    def test_diagnosis_grouping_and_clean_branch_survive(self):
        self.assertIn("fix_type", self.sec)
        self.assertIn("clean:true", self.sec)
        self.assertIn("风格/表达/测试设计而非执行故障", self.sec)
        self.assertIn("完全无 diagnosis", self.sec)

    def test_case_citation_format_is_still_the_dataset_one(self):
        self.assertIn("[case:用例名@Agent名]", testrun.RUN_ANALYSIS_PROMPT)

    def test_blank_and_error_output_calibration_untouched(self):
        # 建议节之外零改动的自证：空响应/错误对象两条口径原样在位
        for line in ("不得说成\"Agent 答错/答得差\"",
                     "尚未获得有效结论", "需先修复被测 Agent"):
            self.assertIn(line, testrun.RUN_ANALYSIS_PROMPT)


class SynthesisSideKeepsItsCalibration(unittest.TestCase):
    """planrun 的「当前优先建议」：跨运行视角与四要素形状并存。"""

    def setUp(self):
        self.sec = section(planrun.SYNTHESIS_SYSTEM_PROMPT, "当前优先建议")

    def test_recurring_unfixed_still_outranks_raw_impact(self):
        # 跨 run 报告的优先级判据不是纯影响面：老问题反复未修必须排在前
        self.assertIn("反复出现且未修复", self.sec)
        self.assertIn("本次新暴露", self.sec)

    def test_each_item_still_cites_runs_and_names_the_expected_metric(self):
        self.assertIn("[run:#N]", self.sec)
        self.assertIn("预期改善", self.sec)

    def test_the_other_three_sections_are_untouched(self):
        for title in ("整体趋势", "反复出现的问题", "改进采纳效果"):
            self.assertIn(f"\n## {title}\n", planrun.SYNTHESIS_SYSTEM_PROMPT)
        self.assertIn("首个数据点，暂无趋势可言",
                      section(planrun.SYNTHESIS_SYSTEM_PROMPT, "整体趋势"))
        self.assertIn("暂无已采纳的改进记录",
                      section(planrun.SYNTHESIS_SYSTEM_PROMPT, "改进采纳效果"))
        # 综合报告的固定四节标题是前端切节的依据（planrun.synthesis_sections）
        self.assertEqual(planrun.SYNTHESIS_SYSTEM_PROMPT.count("\n## "), 4)

    def test_no_fabricated_scores_and_noise_floor_survive(self):
        self.assertIn("不要编造分数或运行", planrun.SYNTHESIS_SYSTEM_PROMPT)
        self.assertIn("<0.05 视为噪声", planrun.SYNTHESIS_SYSTEM_PROMPT)


class CitationBracketsHoldOneRunEach(unittest.TestCase):
    """溯源引用的格式负例（P3，2026-08-31）：前端渲染层按**单编号**解析 [run:#N]，
    judge 写出 [run:#1→#2] / [run:#1,#2] 这类混排时整个引用退化成纯文本。
    前端已加畸形引用兜底，这里钉「源头教 judge 别这么写」—— 正例/负例两个字面
    形态都要在（措辞可润色，形态不许丢）。"""

    def test_positive_and_both_negative_literal_forms_are_present(self):
        p = planrun.SYNTHESIS_SYSTEM_PROMPT
        self.assertIn("一个方括号只写一个编号", p)
        self.assertIn("[run:#1] → [run:#2]", p, "正例形态丢了")
        self.assertIn("[run:#1→#2]", p, "负例形态（箭头混排）丢了")
        self.assertIn("[run:#1,#2]", p, "负例形态（逗号混排）丢了")

    def test_negative_forms_appear_as_negatives_inside_the_citation_rule(self):
        """负例必须以「不要写」的身份出现在【溯源引用】段里 —— 只出现字面形态
        而没有否定语，等于把错误写法当成了示范。"""
        seg = planrun.SYNTHESIS_SYSTEM_PROMPT.split("【溯源引用（强制）】", 1)[1]
        seg = seg.split("\n\n", 1)[0]
        self.assertIn("**不要**写 [run:#1→#2] 或 [run:#1,#2]", seg)
        self.assertIn("[run:#1] → [run:#2]", seg)


class SectionTitlesAreNotRenamed(unittest.TestCase):
    """节标题是前端切节/锚点条的依据，也是术语稳定面 —— 一个字不许动。"""

    def test_titles_stay(self):
        self.assertIn("\n## 建议（行动清单）\n", observe.ANALYSIS_SYSTEM_PROMPT)
        self.assertIn("\n## 建议（行动清单）\n", testrun.RUN_ANALYSIS_PROMPT)
        self.assertIn("\n## 当前优先建议\n", planrun.SYNTHESIS_SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
