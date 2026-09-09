"""批 ledger-id-merge：整理步 submit_issues 的 id 对账（.scratch/triage-r1/issues/narration-batch1-zero-rows.md）。

现场（run plan-69e514cf625f#20260904032816）：第 2 批（batch=1，0 起数）stop=tool_use 却 got=0，
二分重试 3 条仍 0 行。got 只数「回行且 id 在 known 里」⇒ 要么 issues 空数组，要么 id 被改写。
本机用同一批 6 条 / 3 条对真模型复现两次都 6/6、3/3 全回（见批报告），所以两种成因都要堵：
  · 提示词与 schema：每条 id 必回、已是中文也原样回填；schema 里 id 给 enum（只许本批的 id）、
    行数 minItems=maxItems=本批条数；
  · 回填：整批 id 都不认识且行数与送出条数相同 ⇒ 按 batch 内行序兜底对回 + warning（行序稳定：
    payload 就是按这个顺序送的）；有任何一条 id 对得上 ⇒ 不认识的仍按幻觉丢弃（既有守卫）；
    行数不等 ⇒ 不猜，全丢 + warning。
Run: python3 -m pytest tests/test_ledger_narrate_ids.py -q
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_ledger_issues import PLAN, PLAN_ID, case, dataset_stage, rc  # noqa: E402

RUN1 = f"{PLAN_ID}#20260904032816"
N = 3


class NarrateIds(unittest.TestCase):
    def setUp(self):
        import planrun
        self.planrun = planrun
        seeds = planrun._collect_issue_seeds([dataset_stage([
            case(f"case-{i}", False, {"root_causes": [rc(f"Fix {i}.", f"Why {i}.")]}) for i in range(N)])])
        self.issues = planrun.aggregate_issues(RUN1, seeds, [], [])
        self.ids = [it["id"] for it in self.issues]
        self.known = set(self.ids)

    def _batch(self, rows, stop="tool_use"):
        import judgellm
        judge = mock.MagicMock(return_value={"text": "", "stop_reason": stop, "tool_input": {"issues": rows}})
        with mock.patch.object(judgellm, "converse", judge), \
                self.assertLogs("eval-anything", level="WARNING") as logs:
            self.planrun.logger.warning("sentinel")
            got, stop_out = self.planrun._narrate_batch(self.issues, PLAN, "judge-model", self.known)
        return got, judge, [m for m in logs.output if "sentinel" not in m]

    @staticmethod
    def _row(i, sid):
        return {"id": sid, "problem": f"P{i}", "root_cause": f"R{i}", "depends_on": [],
                "recommendation": f"修法 {i}"}

    def test_prompt_demands_every_id_back_even_when_already_chinese(self):
        system = self.planrun.ISSUES_SYSTEM_PROMPT
        self.assertIn("每条 id 都必须回", system)
        self.assertIn("已经是中文", system)

    def test_tool_schema_enumerates_exactly_this_batch_of_ids(self):
        got, judge, _ = self._batch([self._row(i, sid) for i, sid in enumerate(self.ids)])
        self.assertEqual(got, N)
        tool_spec = judge.call_args.args[4]
        schema = tool_spec["toolSpec"]["inputSchema"]["json"]["properties"]["issues"]
        self.assertEqual(schema["items"]["properties"]["id"]["enum"], self.ids)
        self.assertEqual((schema["minItems"], schema["maxItems"]), (N, N))
        # 模块常量不被就地改写（下一批不能带上这一批的 enum）
        base = self.planrun._ISSUES_TOOL["toolSpec"]["inputSchema"]["json"]["properties"]["issues"]
        self.assertNotIn("enum", base["items"]["properties"]["id"])
        self.assertNotIn("minItems", base)

    def test_all_ids_rewritten_with_matching_row_count_fall_back_to_row_order_with_a_warning(self):
        got, _, warnings = self._batch([self._row(i, str(i + 1)) for i in range(N)])
        self.assertEqual(got, N)
        self.assertEqual([it["problem"] for it in self.issues], ["P0", "P1", "P2"])
        self.assertEqual([it["recommendation"] for it in self.issues], ["修法 0", "修法 1", "修法 2"])
        self.assertEqual(len(warnings), 1)
        self.assertIn("ids rewritten", warnings[0])
        self.assertIn("['1', '2', '3']", warnings[0])

    def test_rewritten_ids_with_a_different_row_count_are_dropped_not_guessed(self):
        before = [dict(it) for it in self.issues]
        got, _, warnings = self._batch([self._row(i, str(i + 1)) for i in range(N - 1)])
        self.assertEqual(got, 0)
        self.assertEqual([it["problem"] for it in self.issues], [b["problem"] for b in before])
        self.assertEqual(len(warnings), 1)
        self.assertIn("unknown ids", warnings[0])

    def test_a_hallucinated_id_next_to_valid_ones_is_still_dropped(self):
        rows = [self._row(0, self.ids[0]), self._row(1, "deadbeef"), self._row(2, self.ids[2])]
        before_1 = self.issues[1]["problem"]
        got, _, warnings = self._batch(rows)
        self.assertEqual(got, 2)
        self.assertEqual(self.issues[1]["problem"], before_1)
        self.assertEqual([self.issues[0]["problem"], self.issues[2]["problem"]], ["P0", "P2"])
        self.assertEqual(len(warnings), 1)
        self.assertIn("unknown ids", warnings[0])
        self.assertIn("deadbeef", warnings[0])

    def test_empty_rows_do_not_add_a_second_warning_the_caller_owns_that_line(self):
        got, _, warnings = self._batch([])
        self.assertEqual(got, 0)
        self.assertEqual(warnings, [])

    def test_row_order_fallback_only_touches_issues_not_yet_narrated(self):
        # 第一次正常回 2 条；重试只送第 3 条却把 id 写错 ⇒ 按行序对回那一条
        import judgellm
        self._batch([self._row(0, self.ids[0]), self._row(1, self.ids[1])])
        judge = mock.MagicMock(return_value={"text": "", "stop_reason": "tool_use",
                                             "tool_input": {"issues": [self._row(2, "x")]}})
        with mock.patch.object(judgellm, "converse", judge):
            got, _ = self.planrun._narrate_batch(self.issues[2:], PLAN, "judge-model", self.known)
        self.assertEqual(got, 1)
        self.assertEqual([it["problem"] for it in self.issues], ["P0", "P1", "P2"])
        for it in self.issues:
            it.pop("_narrated", None)
        payload = json.loads(judge.call_args.args[2])
        self.assertEqual([r["id"] for r in payload["issues"]], self.ids[2:])


if __name__ == "__main__":
    unittest.main()
