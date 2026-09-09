"""Tests for the two save_dataset write guards (UI-003 / UI-005).

Covers catalog.save_dataset (no AWS calls — the DynamoDB table is mocked):
- create_only=True rejects when a same-named dataset already exists (UI-003:
  the "new dataset" flow silently overwrote existing data via plain upsert);
- calls without create_only keep the plain upsert behavior (edit / AI-append /
  legacy clients unchanged);
- empty cases lists are rejected outright (UI-005: [] used to persist a
  0-case dataset). Write-side only — pre-existing empty datasets stay readable.

Run: python3 -m pytest tests/test_dataset_save_guards.py -q
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


SINGLE = [{"name": "c1", "input": "q"}]


class TestCreateOnly(unittest.TestCase):
    PREV = {"pk": "DATASET", "sk": "existing", "kind": "regression",
            "cases": json.dumps(SINGLE + [{"name": "c2", "input": "q2"}])}

    def test_create_only_conflict_rejected(self):
        t = _table_with(self.PREV)
        with mock.patch.object(catalog, "get_table", return_value=t):
            with self.assertRaises(ValueError) as ctx:
                catalog.save_dataset("existing", list(SINGLE), create_only=True)
        self.assertIn("'existing' 已存在", str(ctx.exception))
        self.assertIn("更换名称", str(ctx.exception))
        t.put_item.assert_not_called()  # 原 2 条数据未被覆盖

    def test_create_only_fresh_name_saved(self):
        t = _table_with(None)
        with mock.patch.object(catalog, "get_table", return_value=t):
            catalog.save_dataset("brand-new", list(SINGLE), create_only=True)
        t.put_item.assert_called_once()

    def test_without_flag_upsert_unchanged(self):
        # 编辑/AI 追加/旧客户端不带 create_only：同名照常覆盖（既有行为）。
        t = _table_with(self.PREV)
        with mock.patch.object(catalog, "get_table", return_value=t):
            catalog.save_dataset("existing", list(SINGLE))
        t.put_item.assert_called_once()

    def test_create_only_false_upsert_unchanged(self):
        t = _table_with(self.PREV)
        with mock.patch.object(catalog, "get_table", return_value=t):
            catalog.save_dataset("existing", list(SINGLE), create_only=False)
        t.put_item.assert_called_once()


class TestRejectEmpty(unittest.TestCase):
    def test_empty_cases_rejected(self):
        t = _table_with(None)
        with mock.patch.object(catalog, "get_table", return_value=t):
            with self.assertRaises(ValueError) as ctx:
                catalog.save_dataset("empty-set", [])
        self.assertIn("至少需要一条用例", str(ctx.exception))
        t.get_item.assert_not_called()  # 最前置拦截，连表都不必查
        t.put_item.assert_not_called()

    def test_empty_cases_rejected_even_for_existing(self):
        # 把已有集合「存成空」同样拒绝——这是写入校验，不是新建专属。
        prev = {"pk": "DATASET", "sk": "was-full", "kind": "regression",
                "cases": json.dumps(SINGLE)}
        t = _table_with(prev)
        with mock.patch.object(catalog, "get_table", return_value=t):
            with self.assertRaises(ValueError):
                catalog.save_dataset("was-full", [])
        t.put_item.assert_not_called()

    def test_normal_save_passes(self):
        t = _table_with(None)
        with mock.patch.object(catalog, "get_table", return_value=t):
            catalog.save_dataset("ok-set", list(SINGLE), kind="regression")
        t.put_item.assert_called_once()


if __name__ == "__main__":
    unittest.main()
