"""批 ledger-id-merge：问题台账条目身份改「根因语义键」（ADR-0018）。

现场（2026-09-04，plan-69e514cf625f 七次 run）：同一根因每轮被诊断器换一种英文措辞，
`id = sha1(fix_recommendation)` 于是每轮都是新条目 ⇒ 台账 5 → 10 → 16 → 20（顶到
_ISSUES_MAX），「持续 N 次」永远 1。实测七轮里**稳定**的只有三样：fix_type、证据行
（会话 id / 用例名）、线上会话里根因所在的 span（location）；root_cause_explanation 与
fix_recommendation 一样每轮改写。回归用例每轮重放、span 每轮新生（tau-airline-16 三轮三个
location），所以用例行不吃 span。

本文件钉住：
  · identity_key = "<fix_type>|<sorted kind:ref>|<sorted session span>"，id = 其 sha1 前 8 位；
  · 三轮三种措辞、同会话同 span ⇒ 台账 1 条、occurrences=3；
  · 老形状（无 identity_key）的 carried 条目按 (fix_type, 证据行) 折进本次同签名的种子：
    occurrences 取 max(老 occurrences, 老 last_seen_run 去重数)+1、first_seen 取最早、
    译文若旧有则保留；没对上的老条目原样带着（仍是老形状）；
  · 现网七轮同刑的 (会话, fix_type, span) 序列 ⇒ 台账 7 条、远低于 _ISSUES_MAX=20。
Run: python3 -m pytest tests/test_ledger_identity.py -q
"""

import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_ledger_issues import PLAN_ID, case, dataset_stage, observe_stage, rc, session, sha8  # noqa: E402

RUNS = [f"{PLAN_ID}#2026090{d}090000" for d in range(1, 8)]
SESS_A = "dsh-trace-e5d8fb96-5a9f-4d42-8d12-a742b7bd3fa5"
SESS_B = "dsh-trace-97269327-990a-4beb-8b3f-fe5a5a40d762"
SPAN = "959e4e17ff051a5f"
# 同一根因三轮三种措辞（现网 2026-09-04 节录）
REC = [
    "Add an instruction requiring the agent to explicitly count sentences before finalizing a response.",
    "Add explicit instruction to the system prompt requiring the agent to count total sentences against "
    "user-specified limits.",
    "Add an explicit instruction requiring the model to count sentences before finalizing a response "
    "whenever the user specifies a sentence limit.",
]
EXP = [
    "Agent produced a four-sentence response despite the user explicitly asking for three.",
    "The LLM generated a response with an introductory sentence, three numbered points and a closing "
    "sentence (5 sentences total).",
    "The LLM generated a five-sentence explanation of TCP three-way handshake despite the limit.",
]
ZH = "增加一条指令，要求智能体在回复前显式统计句数。"


def rc_at(fix, explain, loc, fix_type="SYSTEM_PROMPT_FIX"):
    return {**rc(fix, explain, fix_type), "location": loc}


def iid(fix_type, rows, anchors=()) -> str:
    """契约里的 id 算法，测试侧独立实现（不借实现自己的函数背书）。"""
    key = f"{fix_type or ''}|{','.join(sorted(rows))}|{','.join(sorted(anchors))}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]


def observe_run(planrun, run_key, carried, *rcs_by_session):
    """一次 run：每个 (session_id, [root_causes]) 一行 ⇒ 种子 ⇒ 并入 carried。"""
    details = [session(sid, {"failures": [], "root_causes": rcs}) for sid, rcs in rcs_by_session]
    return planrun.aggregate_issues(run_key, planrun._collect_issue_seeds([observe_stage(details)]),
                                    carried, [])


class IdentityKey(unittest.TestCase):
    def setUp(self):
        import planrun
        self.planrun = planrun

    def test_three_rewordings_on_the_same_session_span_are_one_issue_seen_three_times(self):
        ledger = []
        for i in range(3):
            ledger = observe_run(self.planrun, RUNS[i], ledger, (SESS_A, [rc_at(REC[i], EXP[i], SPAN)]))
        self.assertEqual(len(ledger), 1)
        it = ledger[0]
        self.assertEqual(it["occurrences"], 3)
        self.assertEqual((it["first_seen_run"], it["last_seen_run"]), (RUNS[0], RUNS[2]))
        self.assertEqual(it["identity_key"], f"SYSTEM_PROMPT_FIX|session:{SESS_A}|{SPAN}")
        self.assertEqual(it["id"], iid("SYSTEM_PROMPT_FIX", [f"session:{SESS_A}"], [SPAN]))
        # 老算法的三个 id 一个都不在
        self.assertFalse({sha8(r) for r in REC} & {it["id"]})
        # 建议与原话是一对：首见的那对保留（译文由整理步再写），不随措辞漂
        self.assertEqual((it["recommendation"], it["recommendation_source"]), (REC[0], REC[0]))
        self.assertEqual(it["evidence"], [{"kind": "session", "ref": SESS_A}])

    def test_different_span_fix_type_or_row_are_separate_issues(self):
        base = rc_at(REC[0], EXP[0], SPAN)
        cases = {
            "span": (SESS_A, [base, rc_at(REC[1], EXP[1], "f6c58b41bb68d89e")]),
            "fix_type": (SESS_A, [base, rc_at(REC[1], EXP[1], SPAN, fix_type="OTHERS")]),
        }
        for name, row in cases.items():
            with self.subTest(name):
                ledger = observe_run(self.planrun, RUNS[0], [], row)
                self.assertEqual(len(ledger), 2)
                self.assertEqual(len({it["identity_key"] for it in ledger}), 2)
        ledger = observe_run(self.planrun, RUNS[0], [], (SESS_A, [base]), (SESS_B, [rc_at(REC[1], EXP[1], SPAN)]))
        self.assertEqual(len(ledger), 2)

    def test_case_rows_ignore_the_span_because_each_run_replays_the_trace(self):
        ledger = []
        for i, loc in enumerate(("aaa111", "bbb222", "ccc333")):
            seeds = self.planrun._collect_issue_seeds([dataset_stage([
                case("tau-airline-16-uncovered-rule", False, {"root_causes": [rc_at(REC[i], EXP[i], loc)]})])])
            ledger = self.planrun.aggregate_issues(RUNS[i], seeds, ledger, [])
        self.assertEqual(len(ledger), 1)
        self.assertEqual(ledger[0]["occurrences"], 3)
        self.assertEqual(ledger[0]["identity_key"], "SYSTEM_PROMPT_FIX|case:tau-airline-16-uncovered-rule|")
        self.assertEqual(ledger[0]["id"], iid("SYSTEM_PROMPT_FIX", ["case:tau-airline-16-uncovered-rule"]))

    def test_same_fix_type_root_causes_on_one_case_collapse_keeping_up_to_three_explanations(self):
        seeds = self.planrun._collect_issue_seeds([dataset_stage([case("c1", False, {"root_causes": [
            rc_at(REC[0], EXP[0], "s1"), rc_at(REC[1], EXP[1], "s1"), rc_at(REC[2], EXP[2], "s2")]})])])
        self.assertEqual(len(seeds), 1)
        self.assertEqual(seeds[0]["recommendation"], REC[0])
        self.assertEqual(seeds[0]["explanations"], EXP)
        self.assertEqual(seeds[0]["evidence"], [{"kind": "case", "ref": "c1"}])

    def test_identical_text_across_rows_still_pools_the_rows_before_identity(self):
        seeds = self.planrun._collect_issue_seeds([dataset_stage([
            case("case-9", False, {"root_causes": [rc(REC[0], EXP[0])]}),
            case("case-4", False, {"root_causes": [rc(REC[0], EXP[0])]})])])
        self.assertEqual(len(seeds), 1)
        self.assertEqual(seeds[0]["evidence"], [{"kind": "case", "ref": "case-9"}, {"kind": "case", "ref": "case-4"}])
        self.assertEqual(seeds[0]["id"], iid("SYSTEM_PROMPT_FIX", ["case:case-4", "case:case-9"]))
        self.assertEqual(seeds[0]["identity_key"], "SYSTEM_PROMPT_FIX|case:case-4,case:case-9|")

    def test_missing_fix_type_keys_as_empty_not_none_string(self):
        seeds = self.planrun._collect_issue_seeds([dataset_stage([
            case("c", False, {"root_causes": [rc(REC[0], EXP[0], fix_type=None)]})])])
        self.assertEqual(seeds[0]["identity_key"], "|case:c|")
        self.assertIsNone(seeds[0]["fix_type"])


def old_entry(text, run_key, sess=SESS_A, fix_type="SYSTEM_PROMPT_FIX", **over):
    """批 ledger-id-merge 之前落库的条目形状：id = sha1(建议)、没有 identity_key。"""
    it = {"id": sha8(text), "problem": f"1个会话（{sess}）", "evidence": [{"kind": "session", "ref": sess}],
          "root_cause": "老根因句", "recommendation": text, "recommendation_source": text,
          "fix_type": fix_type, "first_seen_run": run_key, "last_seen_run": run_key,
          "occurrences": 1, "depends_on": [], "status": "open", "evaluators": ["helpfulness"]}
    it.update(over)
    return it


class OldShapeTransition(unittest.TestCase):
    def setUp(self):
        import planrun
        self.planrun = planrun

    def test_old_shape_duplicates_fold_into_the_seed_with_the_same_fix_type_and_row(self):
        carried = [old_entry(REC[0], RUNS[0]), old_entry(REC[1], RUNS[1]),
                   old_entry(REC[2], RUNS[2], recommendation=ZH)]
        ledger = observe_run(self.planrun, RUNS[3], carried, (SESS_A, [rc_at("Reworded a 4th time.", EXP[0], SPAN)]))
        self.assertEqual(len(ledger), 1)
        it = ledger[0]
        # 三条老条目各自 last_seen 三个不同 run + 本次 = 4
        self.assertEqual(it["occurrences"], 4)
        self.assertEqual((it["first_seen_run"], it["last_seen_run"]), (RUNS[0], RUNS[3]))
        self.assertEqual(it["identity_key"], f"SYSTEM_PROMPT_FIX|session:{SESS_A}|{SPAN}")
        self.assertNotIn(it["id"], {sha8(r) for r in REC})
        # 译文若旧有则保留（取最近一次见到的那条），与它的原话成对
        self.assertEqual((it["recommendation"], it["recommendation_source"]), (ZH, REC[2]))
        self.assertEqual(it["evaluators"], ["helpfulness"])

    def test_fold_takes_max_of_old_occurrences_when_larger_than_distinct_runs(self):
        carried = [old_entry(REC[0], RUNS[2], occurrences=5, first_seen_run=RUNS[0])]
        ledger = observe_run(self.planrun, RUNS[3], carried, (SESS_A, [rc_at(REC[1], EXP[1], SPAN)]))
        self.assertEqual(ledger[0]["occurrences"], 6)
        self.assertEqual(ledger[0]["first_seen_run"], RUNS[0])

    def test_old_shape_not_matched_this_run_is_carried_unchanged_and_stays_old_shape(self):
        stale = old_entry(REC[0], RUNS[0], sess=SESS_B, fix_type="OTHERS")
        ledger = observe_run(self.planrun, RUNS[1], [stale], (SESS_A, [rc_at(REC[1], EXP[1], SPAN)]))
        self.assertEqual(len(ledger), 2)
        kept = next(it for it in ledger if it["id"] == sha8(REC[0]))
        self.assertNotIn("identity_key", kept)
        self.assertEqual((kept["occurrences"], kept["last_seen_run"]), (1, RUNS[0]))

    def test_old_shape_folds_into_the_first_seed_sharing_fix_type_and_row_only(self):
        # 同会话两条 OTHERS 种子（沙箱缺后端 / 权限升级无审批，span 不同）+ 一条老 OTHERS 条目
        stale = old_entry("Ensure the host has a sandbox backend.", RUNS[0], sess=SESS_B, fix_type="OTHERS")
        ledger = observe_run(self.planrun, RUNS[1], [stale], (SESS_B, [
            rc_at("Install bubblewrap.", "no sandbox", "f6c58b41bb68d89e", fix_type="OTHERS"),
            rc_at("Add an approval channel.", "escalation denied", "f2d03c8be5364c75", fix_type="OTHERS")]))
        self.assertEqual(len(ledger), 2)
        by_key = {it["identity_key"]: it for it in ledger}
        self.assertEqual(by_key[f"OTHERS|session:{SESS_B}|f6c58b41bb68d89e"]["occurrences"], 2)
        self.assertEqual(by_key[f"OTHERS|session:{SESS_B}|f2d03c8be5364c75"]["occurrences"], 1)

    def test_depends_on_pointing_at_folded_away_ids_is_pruned(self):
        a = old_entry(REC[0], RUNS[0])
        b = old_entry("Something else on B.", RUNS[0], sess=SESS_B, fix_type="OTHERS", depends_on=[a["id"]])
        ledger = observe_run(self.planrun, RUNS[1], [a, b], (SESS_A, [rc_at(REC[1], EXP[1], SPAN)]))
        kept_b = next(it for it in ledger if it["id"] == b["id"])
        self.assertEqual(kept_b["depends_on"], [])

    def test_seven_live_shaped_runs_stay_far_below_the_cap(self):
        """现网 plan-69e514cf625f 七次 run 的 (会话, fix_type, span) 序列（analyze 实测），措辞每轮不同。"""
        A, B = SESS_A, SESS_B
        S, O = "SYSTEM_PROMPT_FIX", "OTHERS"
        runs = [
            [(A, S, "959e"), (B, O, "f6c5"), (B, O, "f2d0"), (B, S, "0bba"), (B, S, "e9a2")],
            [(A, S, "9d33"), (A, S, "959e"), (B, O, "f6c5"), (B, O, "f2d0"), (B, S, "e9a2")],
            [(A, S, "9d33"), (A, S, "959e"), (B, O, "f6c5"), (B, O, "f2d0"), (B, S, "e9a2"), (B, S, "0e59")],
            [(A, S, "9d33"), (A, S, "959e"), (B, O, "f6c5"), (B, O, "f2d0"), (B, S, "e9a2")],
            [(A, S, "959e"), (B, O, "f6c5"), (B, O, "f2d0"), (B, S, "e9a2")],
            [(A, S, "9d33"), (B, O, "f6c5"), (B, O, "f2d0"), (B, S, "e9a2")],
            [(A, S, "9d33"), (A, S, "959e"), (B, O, "f6c5"), (B, O, "f2d0"), (B, S, "e9a2")],
        ]
        ledger = []
        for i, run in enumerate(runs):
            rows = {}
            for n, (sess, ft, span) in enumerate(run):
                rows.setdefault(sess, []).append(rc_at(f"run {i} wording {n}", f"run {i} why {n}", span, fix_type=ft))
            ledger = observe_run(self.planrun, RUNS[i], ledger, *rows.items())
        self.assertEqual(self.planrun._ISSUES_MAX, 20)
        self.assertEqual(len(ledger), 7)
        by_key = {it["identity_key"]: it["occurrences"] for it in ledger}
        self.assertEqual(by_key[f"{O}|session:{B}|f6c5"], 7)
        self.assertEqual(by_key[f"{S}|session:{A}|959e"], 6)
        self.assertEqual(by_key[f"{S}|session:{B}|0bba"], 1)
        # 本次见到的在前，其次 occurrences 降序
        self.assertEqual([it["occurrences"] for it in ledger][:5], [7, 7, 7, 6, 5])


if __name__ == "__main__":
    unittest.main()
