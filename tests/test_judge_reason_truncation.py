"""judge 理由被静默砍断：600 字符上限，无标记，全文不留。

现场（2026-08-26，航空 15 用例 baseline/v3 两轮真报告现算）：90 条 reason 里
**26 条正好 600 字符**。600 不是 judge 说完了，是 `reason[:600]` 砍的 —— 而且砍在
judge 说出扣分点**之前**：13/15 条 helpfulness 判 0.833 的理由通篇是好话，扣的那
0.167 一个字都没有。于是「照 judge 的理由改 prompt」这条路断在这里，
读的人还以为 judge 认为一切都好。

要害是**同形**：被砍过的理由与「judge 本来就只说了这么多」在字节上完全一样。
所以本批两件事一起做，缺一不可：
  · 上限 600 → `REASON_MAX_CHARS`（现算的中位数 370、未截断最长 518，1800 够用
    且那轮 results 行 65.7KB → 最坏 111KB，仍在 runstore 的 360KB 之内）；
  · 截断留痕：尾部标记给人看，`reason_truncated` / `reason_chars` 给程序看。

**只提上限不留痕等于没修**：下一条 1801 字符的理由照样被读成完整结论。
本文件的阴性对照（`REASON_MAX_CHARS` 上一个字符不许标记）与阳性对照
（下一个字符必须标记）成对存在 —— 只有正例时，「恒不截断」与「上限失效」同形。

不碰真 agent / 真 LLM / 真 AWS：`_collect_results` 的入参是 SDK 的
EvaluationReport，本文件按它的读法（`.cases` / `.reasons` / `.scores` /
`.test_passes` 逐下标取）造一个同形对象。
运行：python3 -m pytest tests/test_judge_reason_truncation.py -q
"""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import testrun  # noqa: E402

CAP = testrun.REASON_MAX_CHARS
MARK = testrun.REASON_TRUNCATED_MARK
# 缺陷现场的那个数：修好之后，600 字符必须原样通过、且报「没截断」
OLD_CAP = 600


def report(*reasons, scores=None, passes=None, evaluators=None):
    """SDK EvaluationReport 的同形替身（_collect_results 只按下标读这四项）。"""
    n = len(reasons)
    names = evaluators or [f"ev{i}" for i in range(n)]
    return SimpleNamespace(
        cases=[{"evaluator": names[i]} for i in range(n)],
        reasons=list(reasons),
        scores=list(scores or [1.0] * n),
        test_passes=list(passes or [True] * n),
    )


def collect(*reasons, **kw) -> dict:
    into: dict = {}
    testrun._collect_results(into, report(*reasons, **kw))
    return into


class ConstantsContract(unittest.TestCase):
    """判据必须能红。本文件其余断言大多**相对**上限取期望值（CAP±1），
    于是把 `REASON_MAX_CHARS` 改回 600、或把标记改成空串，都不会让它们变红
    —— 相对判据对常量的变动结构上不敏感。这一档专门放**绝对**数字。
    """

    # 政策下界，不是对被砍那 26 条真实长度的测量（原文已丢，测不出来）：
    # 同批现算未被砍的最长 518、中位 370 ⇒ 1200 给到 2.3 倍余量，
    # 也把「600 那一档」结结实实关在门外。
    FLOOR = 1200

    def test_the_cap_is_far_above_the_observed_truncation_floor(self):
        self.assertGreaterEqual(
            CAP, self.FLOOR,
            f"上限 {CAP} 太低：600 那族残句会重现（下界 {self.FLOOR}）")

    def test_a_reason_at_the_policy_floor_survives_whole(self):
        """功能形态的同一条：1200 字符的理由必须一字不少地到达读者。
        上限退回 600 时，这条红。"""
        r = "判" * self.FLOOR
        got = testrun._reason_fields(r)
        self.assertEqual(got["reason"], r)
        self.assertFalse(got["reason_truncated"])

    def test_the_mark_is_visible_and_says_it_was_cut(self):
        """标记不许是空串或空白：空标记 == 静默截断，正是本批要修的东西。
        （`endswith(MARK)` 那条在 MARK="" 时恒真 —— 所以要有这一条。）"""
        self.assertTrue(MARK.strip(), "截断标记是空的：又变回静默截断")
        self.assertIn("截断", MARK, "标记里得有「截断」二字，读者才知道发生了什么")

    def test_truncation_actually_appends_something(self):
        """长度判据：截断后的文本必须比留下的前缀更长（有东西被加上去了）。"""
        got = testrun._reason_fields("判" * (CAP + 10))
        self.assertGreater(len(got["reason"]), CAP)


class ReasonFields(unittest.TestCase):
    """三个字段的契约（`_reason_fields` 是唯一出口，_collect_results 展开它）。"""

    def test_a_short_reason_passes_through_byte_identical(self):
        r = "答案与参考一致，覆盖了改签费用与生效时间。"
        got = testrun._reason_fields(r)
        self.assertEqual(got, {"reason": r, "reason_truncated": False,
                               "reason_chars": len(r)})

    def test_the_old_600_char_wall_is_gone(self):
        """缺陷本体：正好 600 字符的理由此前**必然**是残句，现在必须完整通过。"""
        r = "判" * OLD_CAP
        got = testrun._reason_fields(r)
        self.assertEqual(got["reason"], r)
        self.assertFalse(got["reason_truncated"])
        self.assertEqual(got["reason_chars"], OLD_CAP)

    def test_exactly_at_the_cap_is_not_marked(self):
        """阴性对照：不许把一条完整理由标成截断（差一位就是假警报）。"""
        got = testrun._reason_fields("判" * CAP)
        self.assertFalse(got["reason_truncated"])
        self.assertNotIn(MARK, got["reason"])
        self.assertEqual(got["reason_chars"], CAP)

    def test_one_char_over_the_cap_is_marked(self):
        """阳性对照：上限必须**真能**触发 —— 没有这条，「恒不截断」与
        「上限写坏了」在测试上同形。"""
        got = testrun._reason_fields("判" * (CAP + 1))
        self.assertTrue(got["reason_truncated"])
        self.assertTrue(got["reason"].endswith(MARK))
        self.assertEqual(got["reason_chars"], CAP + 1)

    def test_the_kept_text_is_the_cap_worth_of_prefix_plus_the_mark(self):
        """砍的是尾巴：留下的必须是原文前 CAP 字符，一字不差。"""
        r = "".join(chr(0x4E00 + i % 500) for i in range(CAP + 400))
        got = testrun._reason_fields(r)
        self.assertEqual(got["reason"], r[:CAP] + MARK)

    def test_reason_chars_is_the_original_length_not_the_kept_length(self):
        """这个数要回答的是「丢了多少」；写成截断后的长度就等于没记。"""
        got = testrun._reason_fields("判" * (CAP * 3))
        self.assertEqual(got["reason_chars"], CAP * 3)
        self.assertEqual(got["reason_chars"] - CAP, CAP * 2, "丢了 2 倍上限的字")

    def test_the_flag_is_the_judge_not_the_mark_text(self):
        """判「有没有被截断」读 reason_truncated，不许去 reason 里搜标记：
        judge 自己写出这句话时，搜字符串会给出假的「被截断」。"""
        r = "本条理由到此为止。" + MARK
        self.assertLess(len(r), CAP)
        got = testrun._reason_fields(r)
        self.assertFalse(got["reason_truncated"])
        self.assertEqual(got["reason"], r)


class CollectResults(unittest.TestCase):
    """真正的落点：verdict 字典里三个字段都要在。"""

    def test_every_verdict_carries_the_three_fields(self):
        # `label` 是后来加的一等字段（judge 的分档词，见 tests/test_verdict_label.py）：
        # 这个替身 report 的 detailed_results 是空的，所以它如实是 None。整字典对拍
        # 保留 —— 它同时钉住「不许再多长出字段」。
        got = collect("很好", evaluators=["helpfulness"])
        self.assertEqual(got["helpfulness"], {
            "score": 1.0, "passed": True, "errored": False, "label": None,
            "reason": "很好", "reason_truncated": False, "reason_chars": 2})

    def test_a_long_verdict_says_so_in_the_row(self):
        got = collect("判" * (CAP + 50), evaluators=["policy_compliance"])
        v = got["policy_compliance"]
        self.assertTrue(v["reason_truncated"])
        self.assertEqual(v["reason_chars"], CAP + 50)
        self.assertEqual(len(v["reason"]), CAP + len(MARK))

    def test_errored_is_read_from_the_original_head_not_the_clipped_tail(self):
        """errored 认的是开头，截断只动尾巴 —— 一条超长的评估器异常既要
        判成 errored（score/passed 留 None，不是 0 分），也要标出被截断。"""
        got = collect("An error occurred: ThrottlingException " + "细节" * CAP,
                      scores=[0.0], passes=[False], evaluators=["correctness"])
        v = got["correctness"]
        self.assertTrue(v["errored"])
        self.assertIsNone(v["score"])
        self.assertIsNone(v["passed"])
        self.assertTrue(v["reason_truncated"])

    def test_multiple_evaluators_are_clipped_independently(self):
        got = collect("短", "判" * (CAP + 1), "也短",
                      evaluators=["correctness", "helpfulness", "policy_compliance"])
        self.assertFalse(got["correctness"]["reason_truncated"])
        self.assertTrue(got["helpfulness"]["reason_truncated"])
        self.assertFalse(got["policy_compliance"]["reason_truncated"])

    def test_an_empty_reason_is_not_a_truncated_one(self):
        """judge 没给理由（或 SDK 少一条）时报 0 字符、未截断，别报缺失。"""
        got = collect("", evaluators=["correctness"])
        self.assertEqual(got["correctness"]["reason_chars"], 0)
        self.assertFalse(got["correctness"]["reason_truncated"])


class SizeBudget(unittest.TestCase):
    """上限不是随便挑的：整批 verdict 必须仍装得进 runstore 的安全阈值。"""

    def test_a_fifteen_case_three_evaluator_run_stays_under_the_blob_limit(self):
        """现场那轮的形状（15 用例 × 3 评估器 = 45 条），全部按上限到顶算
        —— 中文 3 字节/字符，这是最坏情形，不是均值。"""
        import json

        import runstore
        rows = [{"case": f"c{i}", "input": "问", "output": "答",
                 "results": {ev: {"score": 1.0, "passed": True, "errored": False,
                                  **testrun._reason_fields("判" * (CAP + 1))}
                             for ev in ("correctness", "helpfulness",
                                        "policy_compliance")}}
                for i in range(15)]
        size = len(json.dumps(rows, ensure_ascii=False).encode())
        self.assertLess(size, runstore.SAFE_BLOB_BYTES,
                        f"45 条到顶的理由 {size} 字节，已超 runstore 安全阈值")


if __name__ == "__main__":
    unittest.main()
