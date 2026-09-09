"""judge 自己给的分档词 label：SDK 一直在给，两条评估路径一直没读。

ADR-0014 的展开态顺序是「judge 判词（label+分+reason）」——label 是 SDK
`EvaluationOutput` 的一等字段（types/evaluation.py:126 `label: str | None`），
`report.detailed_results[i][j].label` 拿得到，而 observe 与 testrun 组装
`results[evaluator]` 时从来没碰过它，于是界面上那一栏永远缺一个词。

**为什么只认「恰好一条」**：一行判定里可能挤着多条 EvaluationOutput（多模态/多轮
评估器各自产一条），那时 label 说不清在给谁分档。宁可如实缺数据（界面显「—」）
也不挑一条当代表 —— 挑错的那个词会被读成 judge 的结论。

正反成对（缺了反例，「恒 None」与「恒上盘」在正例上同形）：
  · 单条带 label -> 上盘；两条 / 空行 / 缺行 / label 为空 -> None；
  · errored 行恒 None（分都不算，给分起的名字更不算）；
  · observe 的 no_content 会话恒 None（judge 看的是空字符串，不是这个会话）；
  · 80 字符上限用 79/80/81 三点钉（只测短 label 时，截断失效读不出来）。

不碰真 agent / 真 LLM / 真 AWS：observe 侧走**真的** evaluate_session（字段接线
只有走那条路才验得到），只把 trace 拉取与 Experiment 换成同形替身；testrun 侧
直接调 `_collect_results`（它的入参就是 SDK 的 EvaluationReport）。
运行：python3 -m pytest tests/test_verdict_label.py -q
"""

import asyncio
import inspect
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from strands_evals.types import EvaluationOutput

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import observe  # noqa: E402
import testrun  # noqa: E402

LABEL_MAX_CHARS = 80          # 契约里的绝对数字，不从被测代码反算
ERRORED_REASON = "Evaluator error: judge 限流"


def out(label=None, score=0.9) -> EvaluationOutput:
    """真的 EvaluationOutput（SDK pydantic 模型），不是替身。"""
    return EvaluationOutput(score=score, test_pass=True, reason="判词正文", label=label)


def report(detailed, evaluators=("helpfulness",), reasons=None):
    """SDK EvaluationReport 的同形替身（两侧只按下标读这五项）。

    `detailed` 逐行给 EvaluationOutput 列表；故意允许它比 cases 短 —— SDK 自己就
    这么发生过（report.py:87 `if i < len(report.detailed_results) else []`）。
    """
    n = len(evaluators)
    return SimpleNamespace(
        cases=[{"evaluator": e} for e in evaluators],
        reasons=list(reasons or [""] * n),
        scores=[0.9] * n,
        test_passes=[True] * n,
        detailed_results=list(detailed),
    )


def dataset_results(rep) -> dict:
    """回归测试侧：_collect_results 的产物。"""
    into: dict = {}
    testrun._collect_results(into, rep)
    return into


def observe_results(rep, output="回答正文") -> dict:
    """线上评估侧：跑真的 evaluate_session，读它组装出来的 results。"""
    data = {"output": output, "trajectory": None}

    class FakeExperiment:
        def __init__(self, cases=None, evaluators=None):
            pass

        async def run_evaluations_async(self, task, evaluation_data_store=None):
            return rep

    with mock.patch.object(observe.tracesource, "get_evaluation_data",
                           return_value=(data, [])), \
         mock.patch.object(observe, "build_evaluators", return_value=[object()]), \
         mock.patch.object(observe, "Experiment", FakeExperiment), \
         mock.patch.object(observe.transcript_mod, "build_transcript", return_value=None), \
         mock.patch.object(observe.diagnosis_mod, "needs_diagnosis", return_value=False):
        event = asyncio.run(observe.evaluate_session(
            {"agent_name": "support-bot"},
            {"session_id": "sess-a41f9c2b", "span_count": 7},
            ["helpfulness"], "global.anthropic.claude-sonnet-5", 30))
    return event["results"]


class LabelReachesThePlate(unittest.TestCase):
    """一条判定带 label 时，两条路径都必须把它交出来。"""

    def test_dataset_row_carries_the_label(self):
        got = dataset_results(report([[out("部分正确")]]))
        self.assertEqual(got["helpfulness"]["label"], "部分正确")

    def test_observe_row_carries_the_label(self):
        got = observe_results(report([[out("部分正确")]]))
        self.assertEqual(got["helpfulness"]["label"], "部分正确")

    def test_the_label_does_not_displace_the_existing_fields(self):
        """只增不改：同一行原有的判定字段一个都不许变形。"""
        got = dataset_results(report([[out("部分正确")]]))["helpfulness"]
        self.assertEqual(got["score"], 0.9)
        self.assertTrue(got["passed"])
        self.assertFalse(got["errored"])
        self.assertEqual(got["reason"], "")

    def test_a_serialized_output_row_is_read_the_same_way(self):
        """detailed_results 走过序列化（dict 形态）时也要认 —— 不然缓存/回放
        路径上 label 会静默消失。"""
        for shape in ({"label": "部分正确"}, out("部分正确")):
            with self.subTest(shape=type(shape).__name__):
                self.assertEqual(
                    dataset_results(report([[shape]]))["helpfulness"]["label"],
                    "部分正确")


class NoLabelIsSaidHonestly(unittest.TestCase):
    """说不清就交 None（界面显「—」），不挑代表、不编。"""

    def test_two_outputs_in_one_row_yield_none(self):
        rep = report([[out("部分正确"), out("完全正确")]])
        self.assertIsNone(dataset_results(rep)["helpfulness"]["label"])
        self.assertIsNone(observe_results(rep)["helpfulness"]["label"])

    def test_an_empty_detailed_row_yields_none(self):
        self.assertIsNone(dataset_results(report([[]]))["helpfulness"]["label"])

    def test_a_missing_detailed_row_yields_none_without_blowing_up(self):
        """detailed_results 比 cases 短（SDK 允许）：越界不是异常，是缺数据。"""
        rep = report([], evaluators=("helpfulness", "coherence"))
        got = dataset_results(rep)
        self.assertEqual(sorted(got), ["coherence", "helpfulness"])
        self.assertIsNone(got["helpfulness"]["label"])
        self.assertIsNone(got["coherence"]["label"])

    def test_detailed_results_missing_entirely_yields_none(self):
        """连 detailed_results 这个属性都没有的 report（旧 SDK/替身）也不许炸。"""
        rep = report([])
        del rep.detailed_results
        self.assertIsNone(dataset_results(rep)["helpfulness"]["label"])

    def test_blank_labels_are_none_not_empty_strings(self):
        for label in (None, "", "   "):
            with self.subTest(label=repr(label)):
                self.assertIsNone(
                    dataset_results(report([[out(label)]]))["helpfulness"]["label"])

    def test_an_errored_row_never_carries_a_label(self):
        """评估器自己失败的行：分都不算，给分起的名字更不算。"""
        rep = report([[out("完全正确")]], reasons=[ERRORED_REASON])
        for name, got in (("dataset", dataset_results(rep)),
                          ("observe", observe_results(rep))):
            with self.subTest(path=name):
                self.assertTrue(got["helpfulness"]["errored"])
                self.assertIsNone(got["helpfulness"]["label"])

    def test_a_no_content_session_never_carries_a_label(self):
        """observe 专属：trace 没带内容时 judge 判的是空字符串。errored/score
        在那里被事后清掉，label 必须同批清 —— 漏清就会留下一个像结论的词。"""
        got = observe_results(report([[out("完全正确")]]), output="   ")
        self.assertTrue(got["helpfulness"]["errored"])
        self.assertIsNone(got["helpfulness"]["score"])
        self.assertIsNone(got["helpfulness"]["label"])


class TheLabelIsCapped(unittest.TestCase):
    """80 字符：三点钉（上限下一格、上限、上限上一格）。"""

    def test_a_label_at_the_cap_survives_whole(self):
        label = "档" * LABEL_MAX_CHARS
        self.assertEqual(dataset_results(report([[out(label)]]))["helpfulness"]["label"],
                         label)

    def test_one_char_under_the_cap_survives_whole(self):
        label = "档" * (LABEL_MAX_CHARS - 1)
        self.assertEqual(dataset_results(report([[out(label)]]))["helpfulness"]["label"],
                         label)

    def test_one_char_over_the_cap_is_cut_to_the_cap(self):
        label = "档" * (LABEL_MAX_CHARS + 1)
        got = dataset_results(report([[out(label)]]))["helpfulness"]["label"]
        self.assertEqual(len(got), LABEL_MAX_CHARS)
        self.assertEqual(got, label[:LABEL_MAX_CHARS])


class BothModulesReadTheLabelTheSameWay(unittest.TestCase):
    """observe 与 testrun 各存一份读法（两个模块不许互相 import，见 observe.py
    的层次纪律 docstring）。**逐字同源**由这一档维持：一份改了另一份没改，就是
    同一个词在两个环节上有两种含义 —— 用户无从分辨。
    """

    HELPERS = ("_one_label", "_detailed_row")

    def test_the_two_helpers_are_byte_for_byte_identical(self):
        for name in self.HELPERS:
            with self.subTest(helper=name):
                self.assertEqual(inspect.getsource(getattr(observe, name)),
                                 inspect.getsource(getattr(testrun, name)))

    def test_the_two_helpers_answer_a_shared_table_identically(self):
        """字节相同是形，行为相同是意 —— 两个都要（比如有人只改了调用侧）。"""
        table = [
            [out("部分正确")],
            [out("完全正确"), out("部分正确")],
            [out(None)],
            [out("   ")],
            [{"label": "字典形态"}],
            [],
            None,
        ]
        for row in table:
            with self.subTest(row=row):
                self.assertEqual(observe._one_label(row), testrun._one_label(row))

    def test_both_read_a_short_detailed_list_the_same_way(self):
        rep = report([[out("部分正确")]], evaluators=("helpfulness", "coherence"))
        for i in (0, 1, 7):
            with self.subTest(i=i):
                self.assertEqual(observe._detailed_row(rep, i),
                                 testrun._detailed_row(rep, i))


if __name__ == "__main__":
    unittest.main()
