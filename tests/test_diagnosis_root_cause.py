"""诊断只抄了「怎么修」，没抄「为什么是它」。

`RCAItem.root_cause_explanation`（types/detector.py:78）是 SDK 对根因本身的那句
说明，`diagnosis.diagnose` 的 condense 一直没抄它 —— 于是报告能说出修法
（fix_recommendation），说不出这条修法凭什么成立。ADR-0014 的展开态第三格
（诊断 = 失败分类 + 根因 + 修法）少的正是中间那格。

本批**只**加这一个键。所以判据是「键集合逐字相等」而不是「新键在里面」：
  · 少一个键 -> 红（回归）；
  · 多一个键 -> 也红（比如顺手把 failure_span_id 加进来 —— 那是另一批的事，
    前端契约会跟着漂）。
`evidence` / `confidence` 的 `str()` 拍平**保持现状**（前端已按字符串形态渲染），
本文件给它们留了阴性对照，改形状会红。

不碰真 LLM：`diagnose_session` 与 `judgellm.strands_model` 打桩，喂真的
DiagnosisResult / RCAItem / FailureItem（SDK pydantic 模型）。
运行：python3 -m pytest tests/test_diagnosis_root_cause.py -q
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

from strands_evals.types.detector import DiagnosisResult, FailureItem, RCAItem

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import diagnosis  # noqa: E402
import judgellm  # noqa: E402

EXPLANATION_MAX_CHARS = 500     # 契约里的绝对数字，不从被测代码反算

# 本批之后 root_cause 一行的**全部**键，逐字。
ROOT_CAUSE_KEYS = ["causality", "fix_recommendation", "fix_type", "impact",
                   "location", "root_cause_explanation"]
FAILURE_KEYS = ["category", "confidence", "evidence", "span_id"]


def rca(explanation="rebook 工具超时后没有重试，也没有告知旅客", **kw) -> RCAItem:
    return RCAItem(
        failure_span_id="sp-7",
        location="span sp-7 (rebook)",
        causality="PRIMARY_FAILURE",
        propagation_impact=["旅客拿不到改签结果", "会话以沉默结束"],
        failure_detection_timing="ONLY_AT_TASK_END",
        completion_status="COMPLETE_FAILURE",
        root_cause_explanation=explanation,
        fix_type="SYSTEM_PROMPT_FIX",
        fix_recommendation="在系统提示词里写明工具超时后的重试与告知话术",
        **kw)


def failure() -> FailureItem:
    return FailureItem(span_id="sp-7", category=["tool_error"], confidence=[0.9],
                       evidence=["rebook 超时：UpstreamTimeout no response in 300ms"])


def condense(result: DiagnosisResult) -> dict:
    """跑真的 diagnose()（condense 就住在它里面），只把 detector 与模型打桩。"""
    with mock.patch.object(diagnosis, "diagnose_session", return_value=result), \
         mock.patch.object(judgellm, "strands_model", return_value=object()):
        return diagnosis.diagnose(object(), "global.anthropic.claude-sonnet-5")


def one_root_cause(**kw) -> dict:
    out = condense(DiagnosisResult(session_id="sess-a41f9c2b", failures=[failure()],
                                   root_causes=[rca(**kw)]))
    return out["root_causes"][0]


class TheExplanationIsOnThePlate(unittest.TestCase):
    def test_the_explanation_is_carried_verbatim(self):
        text = "rebook 工具超时后没有重试，也没有告知旅客"
        self.assertEqual(one_root_cause(explanation=text)["root_cause_explanation"],
                         text)

    def test_the_root_cause_row_has_exactly_these_keys(self):
        """只增一个键：少了是回归，多了是越界（前端契约按这份键集合抄）。"""
        self.assertEqual(sorted(one_root_cause()), ROOT_CAUSE_KEYS)

    def test_the_neighbouring_fields_keep_their_current_shape(self):
        """阴性对照：本批不动 causality/impact/fix_* 的拍平方式。"""
        row = one_root_cause()
        self.assertEqual(row["location"], "span sp-7 (rebook)")
        self.assertEqual(row["causality"], "PRIMARY_FAILURE")
        self.assertEqual(row["impact"],
                         str(["旅客拿不到改签结果", "会话以沉默结束"])[:200])
        self.assertEqual(row["fix_type"], "SYSTEM_PROMPT_FIX")
        self.assertIn("重试与告知话术", row["fix_recommendation"])

    def test_the_failure_row_keeps_its_stringified_shape(self):
        """同一档阴性对照：evidence/confidence 仍是 str() 拍平的字符串。"""
        out = condense(DiagnosisResult(session_id="s", failures=[failure()],
                                       root_causes=[]))
        row = out["failures"][0]
        self.assertEqual(sorted(row), FAILURE_KEYS)
        self.assertEqual(row["confidence"], str([0.9]))
        self.assertEqual(row["evidence"], str(
            ["rebook 超时：UpstreamTimeout no response in 300ms"])[:300])

    def test_a_clean_diagnosis_still_says_clean(self):
        """既有口径不动：跑过但没找到 != 没诊断过。"""
        out = condense(DiagnosisResult(session_id="s", failures=[], root_causes=[]))
        self.assertEqual(out, {"failures": [], "root_causes": [], "clean": True})


class TheExplanationIsCapped(unittest.TestCase):
    """500 字符：三点钉（上限下一格、上限、上限上一格）。"""

    def test_at_the_cap_it_survives_whole(self):
        text = "因" * EXPLANATION_MAX_CHARS
        self.assertEqual(one_root_cause(explanation=text)["root_cause_explanation"],
                         text)

    def test_one_char_under_the_cap_survives_whole(self):
        text = "因" * (EXPLANATION_MAX_CHARS - 1)
        self.assertEqual(one_root_cause(explanation=text)["root_cause_explanation"],
                         text)

    def test_one_char_over_the_cap_is_cut_to_the_cap(self):
        text = "因" * (EXPLANATION_MAX_CHARS + 1)
        got = one_root_cause(explanation=text)["root_cause_explanation"]
        self.assertEqual(len(got), EXPLANATION_MAX_CHARS)
        self.assertEqual(got, text[:EXPLANATION_MAX_CHARS])


if __name__ == "__main__":
    unittest.main()
