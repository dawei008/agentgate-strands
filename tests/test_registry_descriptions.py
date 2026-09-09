"""内置评估器描述表（EVALUATOR_DESCRIPTIONS）的覆盖完整性钉。

UI 评估器表的「描述」列消费 evaluators 事件的 descriptions 键：内置评估器
只有名字（helpfulness/coherence…），用户看不出每个判什么，这个 map 是
唯一权威。两条硬约束：

  1. **集合等式**：set(descriptions) == 全部内置名（available ∪ dataset_only
     ∪ multimodal）。将来在 registry 新增评估器忘写描述、或删了评估器留下
     孤儿描述，这里都会红——用等式而不是单向包含，两个方向都钉。
  2. **evaluators 事件带 descriptions 键**（additive，老前端不读不炸）：
     值必须与 evaluator_descriptions() 相同，防止 main.py 手抄一份漂移。

不触任何真 AWS / 真 LLM：catalog.list_custom_evaluators 与
judgellm.default_model 打桩。
Run: python3 -m pytest tests/test_registry_descriptions.py -q
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import main  # noqa: E402
import registry  # noqa: E402


class TestDescriptionCoverage(unittest.TestCase):
    def test_every_builtin_has_a_description(self):
        expected = (set(registry.available_evaluators())
                    | set(registry.dataset_evaluator_names())
                    | set(registry.multimodal_evaluator_names()))
        got = set(registry.evaluator_descriptions())
        missing = expected - got
        orphaned = got - expected
        self.assertEqual(got, expected,
                         f"缺描述: {sorted(missing)}; 孤儿描述: {sorted(orphaned)}")

    def test_descriptions_are_nonempty_strings(self):
        for name, desc in registry.evaluator_descriptions().items():
            self.assertIsInstance(desc, str, name)
            self.assertTrue(desc.strip(), f"{name} 的描述是空串")


class TestEvaluatorsEventCarriesDescriptions(unittest.TestCase):
    def test_event_has_descriptions_key(self):
        async def collect():
            events = []
            async for ev in main.invoke({"action": "evaluators"}):
                events.append(ev)
            return events

        with mock.patch.object(main.catalog, "list_custom_evaluators",
                               return_value=[]), \
             mock.patch.object(main.judgellm, "default_model",
                               return_value="global.anthropic.claude-sonnet-5"):
            events = asyncio.run(collect())

        self.assertEqual(len(events), 1, events)
        ev = events[0]
        self.assertEqual(ev["event"], "evaluators")
        self.assertIn("descriptions", ev)
        self.assertEqual(ev["descriptions"], registry.evaluator_descriptions())


if __name__ == "__main__":
    unittest.main()
