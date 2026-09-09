"""线上评估「建议（行动清单）」节的四要素形状 + 落点枚举（文本级钉）。

用户原话：「针对评估的建议优化加强，明确指出用户应在哪里怎么优化」。

⚠️ 最重要的一条护栏：**平台看不见被测 Agent 的源码**。它只看得见 trace、
数据集、评估器与方案配置。judge 一旦写出「在 src/agent.py:42 改」这类落点，
用户会去找一个不存在的地方 —— 那比不给建议更坏。所以提示词必须**枚举**允许的
落点，并要求证据不足时明说「证据不足以定位到具体落点」。

为什么只能文本级钉：提示词的实际产出要发起真 run 才看得到，而发起 run 是硬禁止
（真花钱、动线上数据）。所以这里钉的是**提示词自己的形态**——枚举在不在、禁令在
不在、四要素的粗体标签在不在。产出侧靠渲染测试用手写的新结构样本覆盖。

运行：python3 -m pytest tests/test_observe_prompt_actions.py -q
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import observe  # noqa: E402


def section(prompt: str, title: str) -> str:
    """取出 `## <title>` 那一节的正文（到下一个 `## ` 或全文末）。"""
    marker = f"\n## {title}\n"
    assert marker in prompt, f"提示词里没有 `## {title}` 这一节"
    rest = prompt.split(marker, 1)[1]
    return rest.split("\n## ", 1)[0]


class ActionListShape(unittest.TestCase):
    """建议节必须携带可解析的四要素形状（前端渲染成建议卡就认这个形状）。"""

    def setUp(self):
        self.prompt = observe.ANALYSIS_SYSTEM_PROMPT
        self.spec = observe.ACTION_ITEM_SPEC

    def test_the_action_item_spec_is_embedded_in_the_suggestion_section(self):
        # 规格块必须落在「建议（行动清单）」那一节里，不能飘到别的节去
        sec = section(self.prompt, "建议（行动清单）")
        self.assertIn(self.spec, sec)

    def test_the_four_element_labels_appear_verbatim_as_a_list_item(self):
        # 前端按这三个粗体标签认卡（web/src/pages/plan/ReportDrawer.tsx 的
        # ADVICE_TARGET/ADVICE_HOW/ADVICE_IMPACT）；改名即等于把渲染打没。
        self.assertIn("- **落点**：", self.spec)
        self.assertIn("**改法**：", self.spec)
        self.assertIn("**影响**：", self.spec)
        # 顺序固定：落点 → 改法 → 影响
        self.assertLess(self.spec.index("**落点**"), self.spec.index("**改法**"))
        self.assertLess(self.spec.index("**改法**"), self.spec.index("**影响**"))

    def test_impact_asks_for_a_count_and_one_or_two_citations(self):
        self.assertIn("N 个会话/用例", self.spec)
        self.assertIn("证据引用", self.spec)

    def test_ranking_merging_and_the_five_item_cap(self):
        self.assertIn("按影响面", self.spec)
        self.assertIn("从大到小", self.spec)
        self.assertIn("合并成一条", self.spec)
        self.assertIn("最多 5 条", self.spec)

    def test_pasteable_text_goes_into_a_quote_block(self):
        # 「改法」里的可粘文本用 `> ` 引文块 —— 前端把引文块渲染成带复制按钮的块
        self.assertIn("`> `", self.spec)
        self.assertIn("引文块", self.spec)


class LandingSpotEnumeration(unittest.TestCase):
    """落点只能从五类里选，且严禁编造代码位置。"""

    def setUp(self):
        self.spec = observe.ACTION_ITEM_SPEC

    def test_the_five_allowed_landing_spots_are_enumerated(self):
        for kind in ("系统提示词", "description", "[case:用例名@Agent名]",
                     "评估器配置", "行为面"):
            self.assertIn(kind, self.spec, f"落点枚举缺了「{kind}」这一类")

    def test_code_locations_are_banned_outright(self):
        self.assertIn("看不见被测 Agent 的源码", self.spec)
        for banned in ("代码路径", "文件名", "行号", "函数名"):
            self.assertIn(banned, self.spec, f"禁令里没点名「{banned}」")
        # 反例必须原样出现在**禁令**里（让 judge 认得出这是被禁的长相），
        # 且必须紧跟「幻觉」二字 —— 否则它会被读成一个可以照抄的示范。
        self.assertIn("src/agent.py:42", self.spec)
        head = self.spec.index("src/agent.py:42")
        self.assertIn("幻觉", self.spec[head:head + 60])

    def test_system_prompt_spot_requires_the_prompt_to_be_captured(self):
        # 没捕获到 system prompt 就不许说「你的系统提示词第 3 段」
        self.assertIn("真的捕获到了系统提示词", self.spec)
        self.assertIn("你的系统提示词第 3 段", self.spec)

    def test_tool_names_must_be_real_names_from_the_material(self):
        self.assertIn("工具名必须是材料里出现过的真名", self.spec)
        self.assertIn("不许自造工具", self.spec)

    def test_insufficient_evidence_must_say_so_instead_of_guessing(self):
        # 这句话是整段护栏的兜底：不许猜
        self.assertIn("证据不足以定位到具体落点", self.spec)
        self.assertIn("不许猜", self.spec)


class SectionKeepsItsExistingCalibration(unittest.TestCase):
    """改结构不改口径：建议节原有的三条判据一个不少。"""

    def setUp(self):
        self.sec = section(observe.ANALYSIS_SYSTEM_PROMPT, "建议（行动清单）")

    def test_diagnosis_grouping_and_clean_branch_survive(self):
        self.assertIn("fix_type", self.sec)
        self.assertIn("clean:true", self.sec)
        self.assertIn("风格/表达而非执行故障", self.sec)
        self.assertIn("完全无 diagnosis", self.sec)

    def test_session_citation_format_stays_observe_side(self):
        # 线上评估侧的证据是会话引用，不是用例引用
        self.assertIn("[session:完整会话ID]", self.sec)

    def test_no_fabrication_requirement_still_closes_the_prompt(self):
        self.assertIn("不要编造", observe.ANALYSIS_SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
