"""批 judge-zh-fix2：问题台账整理步分批 + stop_reason 守卫。

现场（2026-09-04 本机实测，真模型 sonnet-5）：run plan-69e514cf625f#20260904031057 台账 16 条、
payload 12.7K 字符，一次 converse(max_tokens=4000) ⇒ stop_reason=max_tokens、tool_input.issues
0 行——函数不抛（tool_input 是 dict）静默返回原值 ⇒ recommendation 留英文。max_tokens=12000
时 16 行全回。修法：≤ _NARRATE_BATCH 条一批、max_tokens 8000、某批截断或少行 ⇒ warning +
二分重试一次、仍缺的条目保留原值。
Run: python3 -m pytest tests/test_ledger_narrate_batches.py -q
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_ledger_issues import PLAN, PLAN_ID, case, dataset_stage, iid, rc  # noqa: E402

N = 16
# 身份 = fix_type × 用例（ADR-0018）：与建议文本无关
IDS = [iid("SYSTEM_PROMPT_FIX", [f"case:case-{i}"]) for i in range(N)]
FIX = [f"Fix number {i}: tell the user nothing was found instead of inventing data." for i in range(N)]
ZH = [f"修法 {i}：告知用户未查到，而不是编造数据。" for i in range(N)]
EXPLAIN = "The agent invented an order id after an empty tool result."
RUN1 = f"{PLAN_ID}#20260904031057"


def row(i, **over):
    r = {"id": IDS[i], "problem": f"问题 {i}", "root_cause": f"根因 {i}",
         "depends_on": [], "recommendation": ZH[i]}
    r.update(over)
    return r


class ScriptedJudge:
    """按调用序号回放脚本的 fake converse。每次调用记录 payload 里的 id 列表与 max_tokens。

    script[k] 是一个 callable(ids) -> resp dict，或 None（= 全部按 id 回译文、stop=tool_use）。
    """

    def __init__(self, script=None):
        self.script = list(script or [])
        self.calls: list[dict] = []
        self.by_id = {IDS[i]: i for i in range(N)}

    def full(self, ids):
        return {"text": "", "stop_reason": "tool_use",
                "tool_input": {"issues": [row(self.by_id[s]) for s in ids]}}

    def __call__(self, model, system, user_text, max_tokens, tool_spec=None, force_tool=None):
        assert force_tool == "submit_issues"
        payload = json.loads(user_text)
        ids = [it["id"] for it in payload["issues"]]
        k = len(self.calls)
        self.calls.append({"ids": ids, "max_tokens": max_tokens, "payload": payload})
        fn = self.script[k] if k < len(self.script) else None
        return self.full(ids) if fn is None else fn(ids)


def truncated(ids):
    return {"text": "", "stop_reason": "max_tokens", "tool_input": {"issues": []}}


class NarrateBatches(unittest.TestCase):
    def setUp(self):
        import planrun
        self.planrun = planrun
        seeds = planrun._collect_issue_seeds([dataset_stage([
            case(f"case-{i}", False, {"root_causes": [rc(FIX[i], EXPLAIN)]}) for i in range(N)])])
        self.issues = planrun.aggregate_issues(RUN1, seeds, [], [])
        self.assertEqual(len(self.issues), N)
        self.ids = [it["id"] for it in self.issues]
        self.original_problem = {it["id"]: it["problem"] for it in self.issues}

    def _run(self, judge):
        import judgellm
        with mock.patch.object(judgellm, "converse", judge), \
                self.assertLogs("eval-anything", level="WARNING") as logs:
            self.planrun.logger.warning("sentinel")  # assertLogs 要至少一条；真 warning 另行断言
            out = self.planrun._narrate_issues(self.issues, PLAN, "judge-model")
        warnings = [m for m in logs.output if "sentinel" not in m]
        return out, warnings

    def test_batch_constant_is_six_with_reason(self):
        self.assertEqual(self.planrun._NARRATE_BATCH, 6)

    def test_sixteen_issues_go_out_as_6_6_4_each_payload_only_its_own_ids_max_tokens_8000(self):
        judge = ScriptedJudge()
        out, warnings = self._run(judge)
        self.assertEqual([len(c["ids"]) for c in judge.calls], [6, 6, 4])
        self.assertEqual([i for c in judge.calls for i in c["ids"]], self.ids)
        self.assertEqual({c["max_tokens"] for c in judge.calls}, {8000})
        for c in judge.calls:
            self.assertEqual(c["payload"]["plan"]["name"], PLAN["name"])
        self.assertEqual([it["recommendation"] for it in out], ZH)
        self.assertEqual(warnings, [])

    def test_truncated_batch_logs_warning_and_is_bisected_once_then_all_sixteen_land(self):
        # 第 2 批（6 条）截断 0 行 ⇒ 拆 3+3 各再调一次 ⇒ 全回
        judge = ScriptedJudge([None, truncated, None, None, None])
        out, warnings = self._run(judge)
        self.assertEqual([len(c["ids"]) for c in judge.calls], [6, 6, 3, 3, 4])
        self.assertEqual(judge.calls[2]["ids"] + judge.calls[3]["ids"], judge.calls[1]["ids"])
        self.assertEqual([it["recommendation"] for it in out], ZH)
        self.assertEqual(len(warnings), 1)
        self.assertIn("issue ledger narration truncated", warnings[0])
        self.assertIn("batch=1 sent=6 got=0 stop=max_tokens", warnings[0])

    def test_fewer_rows_than_sent_with_tool_use_stop_also_counts_as_truncated(self):
        def drop_last(ids):
            r = ScriptedJudge().full(ids)
            r["tool_input"]["issues"].pop()
            return r
        judge = ScriptedJudge([None, None, drop_last, None])
        out, warnings = self._run(judge)
        # 重试只送没回来的那些（已落地的 3 条不重送、不被二次改写）⇒ 缺 1 条就补 1 条
        self.assertEqual([len(c["ids"]) for c in judge.calls], [6, 6, 4, 1])
        self.assertEqual(judge.calls[3]["ids"], judge.calls[2]["ids"][-1:])
        self.assertEqual([it["recommendation"] for it in out], ZH)
        self.assertEqual(len(warnings), 1)
        self.assertIn("batch=2 sent=4 got=3 stop=tool_use", warnings[0])

    def test_half_returned_batch_resends_only_the_missing_half_split_in_two(self):
        def keep_first_three(ids):
            r = ScriptedJudge().full(ids)
            r["tool_input"]["issues"] = r["tool_input"]["issues"][:3]
            r["stop_reason"] = "max_tokens"
            return r
        judge = ScriptedJudge([keep_first_three, None, None, None, None])
        out, warnings = self._run(judge)
        self.assertEqual([len(c["ids"]) for c in judge.calls], [6, 2, 1, 6, 4])
        self.assertEqual(judge.calls[1]["ids"] + judge.calls[2]["ids"], judge.calls[0]["ids"][3:])
        self.assertEqual([it["recommendation"] for it in out], ZH)
        self.assertEqual(len(warnings), 1)
        self.assertIn("batch=0 sent=6 got=3 stop=max_tokens", warnings[0])

    def test_retry_still_missing_keeps_that_issue_untouched_and_others_translated(self):
        def drop_last(ids):
            r = ScriptedJudge().full(ids)
            r["tool_input"]["issues"].pop()
            return r
        # 第 2 批截断 ⇒ 二分；后半仍少 1 行 ⇒ 记 warning、不再拆、那条保留原值
        judge = ScriptedJudge([None, truncated, None, drop_last, None])
        out, warnings = self._run(judge)
        self.assertEqual([len(c["ids"]) for c in judge.calls], [6, 6, 3, 3, 4])
        missing = judge.calls[3]["ids"][-1]
        for it in out:
            i = judge.by_id[it["id"]]
            if it["id"] == missing:
                self.assertEqual(it["recommendation"], FIX[i])
                self.assertEqual(it["problem"], self.original_problem[it["id"]])
            else:
                self.assertEqual(it["recommendation"], ZH[i])
        self.assertEqual(len(warnings), 2)
        self.assertIn("batch=1 sent=6 got=0 stop=max_tokens", warnings[0])
        self.assertIn("sent=3 got=2 stop=tool_use", warnings[1])

    def test_single_issue_batch_truncated_is_not_bisected_further(self):
        one = self.issues[:1]
        judge = ScriptedJudge([truncated, truncated])
        import judgellm
        with mock.patch.object(judgellm, "converse", judge), \
                self.assertLogs("eval-anything", level="WARNING"):
            out = self.planrun._narrate_issues(one, PLAN, "judge-model")
        # 1 条拆不出两半 ⇒ 原样重试一次即止
        self.assertEqual([len(c["ids"]) for c in judge.calls], [1, 1])
        self.assertEqual(out[0]["recommendation"], FIX[0])

    def test_non_dict_tool_input_still_raises_runtime_error(self):
        # 第 2 批才抛：第 1 批已合并的译文留在条目上，且内部标记不能漏到要落库的 dict 里
        judge = ScriptedJudge([None, lambda ids: {"text": "", "stop_reason": "end_turn", "tool_input": None}])
        import judgellm
        with mock.patch.object(judgellm, "converse", judge):
            with self.assertRaises(RuntimeError):
                self.planrun._narrate_issues(self.issues, PLAN, "judge-model")
        self.assertEqual([it["recommendation"] for it in self.issues[:6]], ZH[:6])
        self.assertEqual([it["recommendation"] for it in self.issues[6:]], FIX[6:])
        self.assertFalse(any("_narrated" in it for it in self.issues))


if __name__ == "__main__":
    unittest.main()
