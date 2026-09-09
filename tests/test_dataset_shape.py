"""Stub tests for dataset shape enforcement (ADR-0009), save_dataset side.

Covers the purity check in catalog.save_dataset (no AWS calls — the DynamoDB
table is mocked): regression sets must not contain multiturn fields, simulation
sets require task_description on every case, and pre-existing datasets are
exempt unless the save would flip their classification side.

Run: python3 -m pytest tests/test_dataset_shape.py -q
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import catalog


def _table_with(prev_item):
    t = mock.Mock()
    t.get_item.return_value = {"Item": prev_item} if prev_item else {}
    return t


class TestShapeViolation(unittest.TestCase):
    def test_regression_clean(self):
        self.assertIsNone(catalog._shape_violation(
            [{"name": "c1", "input": "q"}], "regression"))

    def test_regression_multiturn_field_named_in_error(self):
        msg = catalog._shape_violation(
            [{"name": "c1", "input": "q"},
             {"name": "c2", "input": "q", "task_description": "t"}], "regression")
        self.assertIn("第 2 条", msg)
        self.assertIn("c2", msg)
        self.assertIn("task_description", msg)
        self.assertIn("存为模拟集", msg)

    def test_regression_max_turns_alone_triggers(self):
        msg = catalog._shape_violation(
            [{"name": "c1", "input": "q", "max_turns": 5}], "regression")
        self.assertIn("max_turns", msg)

    def test_simulation_missing_task_description(self):
        msg = catalog._shape_violation(
            [{"name": "t1", "input": "q", "task_description": "goal"},
             {"name": "t2", "input": "q"}], "simulation")
        self.assertIn("第 2 条", msg)
        self.assertIn("task_description", msg)

    def test_simulation_clean(self):
        self.assertIsNone(catalog._shape_violation(
            [{"name": "t1", "input": "q", "task_description": "goal"}], "simulation"))

    def test_redteam_not_checked(self):
        self.assertIsNone(catalog._shape_violation(
            [{"name": "c1", "input": "q", "task_description": "t"}], "redteam"))


class TestSaveDatasetGuard(unittest.TestCase):
    MULTI = [{"name": "t1", "input": "q", "task_description": "goal"}]
    SINGLE = [{"name": "c1", "input": "q"}]

    def test_new_regression_with_multiturn_rejected(self):
        with mock.patch.object(catalog, "get_table", return_value=_table_with(None)):
            with self.assertRaises(ValueError) as ctx:
                catalog.save_dataset("new-reg", list(self.MULTI), kind="regression")
        self.assertIn("回归数据集不能包含多轮用例", str(ctx.exception))

    def test_new_simulation_missing_task_description_rejected(self):
        with mock.patch.object(catalog, "get_table", return_value=_table_with(None)):
            with self.assertRaises(ValueError) as ctx:
                catalog.save_dataset("new-sim", list(self.SINGLE), kind="simulation")
        self.assertIn("task_description", str(ctx.exception))

    def test_new_clean_regression_saved(self):
        t = _table_with(None)
        with mock.patch.object(catalog, "get_table", return_value=t):
            catalog.save_dataset("new-reg", list(self.SINGLE), kind="regression")
        t.put_item.assert_called_once()

    def test_existing_mixed_set_plain_edit_exempt(self):
        # 存量混合集（kind:regression 但含多轮 → 模拟侧）：编辑保存同侧内容
        # 不改变归类侧 → 豁免放行（只存不增的既定原则）。
        prev = {"pk": "DATASET", "sk": "legacy-mixed", "kind": "regression",
                "cases": json.dumps(self.MULTI + self.SINGLE)}
        t = _table_with(prev)
        with mock.patch.object(catalog, "get_table", return_value=t):
            catalog.save_dataset("legacy-mixed", self.MULTI + self.SINGLE,
                                 kind="regression")
        t.put_item.assert_called_once()

    def test_existing_set_side_flip_rejected(self):
        # 纯单轮回归集，这次保存混入多轮 → 归类侧翻面（regression→simulation），拦。
        prev = {"pk": "DATASET", "sk": "pure-reg", "kind": "regression",
                "cases": json.dumps(self.SINGLE)}
        with mock.patch.object(catalog, "get_table", return_value=_table_with(prev)):
            with self.assertRaises(ValueError):
                catalog.save_dataset("pure-reg", self.SINGLE + self.MULTI,
                                     kind="regression")


if __name__ == "__main__":
    unittest.main()
