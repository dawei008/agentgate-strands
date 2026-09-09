"""批 judge-zh：问题台账的 recommendation 中文译文 + 已采纳匹配不断链。

诊断管线（strands detectors `diagnose_session`）没有语言参数 ⇒ fix_recommendation
英文；台账的 recommendation 由 submit_issues 译成中文（方案 B）。已采纳判定
`_issue_status` 原先按 recommendation 文本全等对回 proposals[].summary，翻译后会断链
——所以译前原话留在 recommendation_source，_issue_status 两把钥匙都试：
  · 报告页从 fix_recommendation 原话采纳 ⇒ summary 英文 ⇒ 靠 source 对上；
  · 台账页用条目的 recommendation（译文）采纳 ⇒ summary 中文 ⇒ 靠 recommendation 对上。
夹具与 test_ledger_issues 同源（复用其 helpers）。
Run: python3 -m pytest tests/test_ledger_recommendation_zh.py -q
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_ledger_issues import (  # noqa: E402
    PLAN, PLAN_ID, DdbFixture, case, dataset_stage, iid, judge_with_issues, rc,
)

FIX_EN = ("Add to the system prompt: when a tool returns an empty result, "
          "tell the user nothing was found instead of inventing data.")
FIX_EN_ZH = "在系统提示词中加入：工具返回空结果时告知用户未查到，而不是编造数据。"
EXPLAIN_EN = "The agent reported a concrete order id after search_orders returned an empty array."
IID = iid("SYSTEM_PROMPT_FIX", ["case:case-9"])   # 身份 = fix_type × 用例，与建议文本无关（ADR-0018）


class RecommendationZh(unittest.TestCase):
    RUN1 = f"{PLAN_ID}#20260901090000"
    RUN2 = f"{PLAN_ID}#20260902090000"
    ADOPTED_EN = [{"summary": FIX_EN[:300], "generated_at": "t", "adopted_at": "2026-09-01 10:00 UTC",
                   "source": "run_advice", "refs": ["回归测试 · case-9"]}]
    ADOPTED_ZH = [{"summary": FIX_EN_ZH[:300], "generated_at": "t", "adopted_at": "2026-09-02 10:00 UTC",
                   "source": "run_advice", "refs": []}]

    def setUp(self):
        import planrun
        self.planrun = planrun
        self.seed = planrun._collect_issue_seeds([dataset_stage([
            case("case-9", False, {"root_causes": [rc(FIX_EN, EXPLAIN_EN)]})])])[0]

    # --- _issue_status：两把钥匙 ---
    def test_status_matches_english_summary_through_recommendation_source(self):
        self.assertEqual(self.planrun._issue_status(FIX_EN_ZH, self.ADOPTED_EN, FIX_EN), "adopted")
        # 只给译文、不给原话（老调用形态）⇒ 对不上：钉住「为什么必须带 source」
        self.assertEqual(self.planrun._issue_status(FIX_EN_ZH, self.ADOPTED_EN), "open")

    def test_status_matches_chinese_summary_adopted_from_the_ledger_itself(self):
        self.assertEqual(self.planrun._issue_status(FIX_EN_ZH, self.ADOPTED_ZH, FIX_EN), "adopted")
        resolved = [{**self.ADOPTED_ZH[0], "adoption_effect": {"verdict": "improved"}}]
        self.assertEqual(self.planrun._issue_status(FIX_EN_ZH, resolved, FIX_EN), "resolved")

    def test_status_with_neither_key_is_open(self):
        self.assertEqual(self.planrun._issue_status(None, self.ADOPTED_EN, None), "open")
        self.assertEqual(self.planrun._issue_status("", self.ADOPTED_EN, "  "), "open")

    # --- aggregate_issues：source 的来龙去脉 ---
    def test_new_issue_source_equals_the_untranslated_seed_and_id_is_the_identity_hash(self):
        it = self.planrun.aggregate_issues(self.RUN1, [self.seed], [], [])[0]
        self.assertEqual(it["recommendation"], FIX_EN)
        self.assertEqual(it["recommendation_source"], FIX_EN)
        self.assertEqual(it["id"], IID)

    def test_carried_pre_batch_ledger_without_source_reads_source_from_its_recommendation(self):
        old = self.planrun.aggregate_issues(self.RUN1, [self.seed], [], [])[0]
        del old["recommendation_source"]  # 批 judge-zh 之前落库的形状
        it = self.planrun.aggregate_issues(self.RUN2, [], [old], self.ADOPTED_EN)[0]
        self.assertEqual(it["recommendation_source"], FIX_EN)
        self.assertEqual(it["status"], "adopted")
        # 没有建议的老条目：source 也是 None，不是 ""
        pending = {**old, "recommendation": None}  # old 已无 recommendation_source 键
        self.assertIsNone(
            self.planrun.aggregate_issues(self.RUN2, [], [pending], [])[0]["recommendation_source"])

    def test_translated_carried_issue_keeps_translation_and_still_matches_english_adoption(self):
        carried = self.planrun.aggregate_issues(self.RUN1, [self.seed], [], [])
        carried[0]["recommendation"] = FIX_EN_ZH  # 上一次 run 已被 LLM 译成中文
        # 再见到同一修法：译文不被英文种子覆盖，source 不动，id 不变
        it = self.planrun.aggregate_issues(self.RUN2, [self.seed], carried, self.ADOPTED_EN)[0]
        self.assertEqual(it["recommendation"], FIX_EN_ZH)
        self.assertEqual(it["recommendation_source"], FIX_EN)
        self.assertEqual(it["id"], IID)
        self.assertEqual(it["status"], "adopted")
        # 只在历史里（本次没再见到）也一样
        it2 = self.planrun.aggregate_issues(self.RUN2, [], carried, self.ADOPTED_EN)[0]
        self.assertEqual((it2["recommendation"], it2["status"]), (FIX_EN_ZH, "adopted"))

    # --- _narrate_issues：译文回填规则 ---
    def _narrate(self, issues, rows):
        import judgellm
        judge = judge_with_issues({"issues": rows})
        with mock.patch.object(judgellm, "converse", judge):
            out = self.planrun._narrate_issues(issues, PLAN, "judge-model")
        return out, judge

    def test_translation_overwrites_recommendation_but_not_source(self):
        issues = self.planrun.aggregate_issues(self.RUN1, [self.seed], [], [])
        out, judge = self._narrate(issues, [{"id": IID, "problem": "P", "root_cause": "R",
                                             "depends_on": [], "recommendation": f"  {FIX_EN_ZH}\n"}])
        self.assertEqual(out[0]["recommendation"], FIX_EN_ZH)
        self.assertEqual(out[0]["recommendation_source"], FIX_EN)
        # 送给 LLM 的材料带 recommendation 原话；提示词与 schema 都要求译文，不再说「不要改写」
        system = judge.call_args.args[1]
        payload = json.loads(judge.call_args.args[2])
        self.assertEqual(payload["issues"][0]["recommendation"], FIX_EN)
        self.assertIn("译成简体中文", system)
        self.assertNotIn("不要改写 recommendation", system)
        items = self.planrun._ISSUES_TOOL["toolSpec"]["inputSchema"]["json"]["properties"]["issues"]["items"]
        self.assertIn("recommendation", items["properties"])
        self.assertIn("recommendation", items["required"])  # 批 judge-zh-fix：可选 ⇒ 模型习惯性省略

    # --- 批 judge-zh-fix：v81 实测 5 条 recommendation 逐字 == source，模型没回可选字段 ---
    def test_schema_requires_recommendation_and_tells_model_to_return_empty_string_when_null(self):
        items = self.planrun._ISSUES_TOOL["toolSpec"]["inputSchema"]["json"]["properties"]["issues"]["items"]
        self.assertIn("recommendation", items["required"])
        desc = items["properties"]["recommendation"]["description"]
        self.assertIn("必填", desc)
        self.assertIn("空字符串", desc)
        self.assertNotIn("省略", desc)  # 旧措辞「材料里为空则省略此字段」给了模型省略的口子

    def test_prompt_lists_recommendation_as_a_task_item_with_must_fill_wording(self):
        system = self.planrun.ISSUES_SYSTEM_PROMPT
        self.assertIn("必须回填", system)
        self.assertIn("原文为空则回空字符串", system)
        # 翻译要求放在任务列表里（recommendation 条目在 depends_on 之前、「规则：」段之后不算）
        task_block = system.split("规则：")[0]
        self.assertIn("- recommendation：", task_block)
        self.assertLess(task_block.index("- recommendation："), task_block.index("- depends_on："))
        self.assertNotIn("材料里为空则不填", system)

    def test_payload_carries_recommendation_key_even_when_null(self):
        seed = self.planrun._collect_issue_seeds([dataset_stage([
            case("c", False, {"root_causes": [rc("", EXPLAIN_EN)]})])])[0]
        issues = self.planrun.aggregate_issues(self.RUN1, [seed], [], [])
        issues[0].pop("recommendation", None)  # 老形状：键缺失也要送 null 给模型
        _, judge = self._narrate(issues, [{"id": issues[0]["id"], "problem": "P", "root_cause": "R",
                                           "depends_on": [], "recommendation": ""}])
        payload = json.loads(judge.call_args.args[2])
        self.assertIn("recommendation", payload["issues"][0])
        self.assertIsNone(payload["issues"][0]["recommendation"])

    def test_empty_string_translation_keeps_original_or_null(self):
        issues = self.planrun.aggregate_issues(self.RUN1, [self.seed], [], [])
        out, _ = self._narrate(issues, [{"id": IID, "problem": "P", "root_cause": "R",
                                         "depends_on": [], "recommendation": ""}])
        self.assertEqual(out[0]["recommendation"], FIX_EN)
        seed = self.planrun._collect_issue_seeds([dataset_stage([
            case("c", False, {"root_causes": [rc("", EXPLAIN_EN)]})])])[0]
        pending = self.planrun.aggregate_issues(self.RUN1, [seed], [], [])
        out, _ = self._narrate(pending, [{"id": pending[0]["id"], "problem": "P", "root_cause": "R",
                                          "depends_on": [], "recommendation": ""}])
        self.assertIsNone(out[0]["recommendation"])

    def test_missing_or_blank_translation_keeps_the_original_text(self):
        issues = self.planrun.aggregate_issues(self.RUN1, [self.seed], [], [])
        out, _ = self._narrate(issues, [{"id": IID, "problem": "P", "root_cause": "R",
                                         "depends_on": [], "recommendation": "   "}])
        self.assertEqual(out[0]["recommendation"], FIX_EN)
        out, _ = self._narrate(issues, [{"id": IID, "problem": "P", "root_cause": "R",
                                         "depends_on": []}])
        self.assertEqual(out[0]["recommendation"], FIX_EN)

    def test_llm_cannot_invent_a_recommendation_for_a_pending_issue(self):
        seed = self.planrun._collect_issue_seeds([dataset_stage([
            case("c", False, {"root_causes": [rc("", EXPLAIN_EN)]})])])[0]
        issues = self.planrun.aggregate_issues(self.RUN1, [seed], [], [])
        self.assertIsNone(issues[0]["recommendation"])
        out, _ = self._narrate(issues, [{"id": issues[0]["id"], "problem": "P", "root_cause": "R",
                                         "depends_on": [], "recommendation": "编出来的建议"}])
        self.assertIsNone(out[0]["recommendation"])
        self.assertIsNone(out[0]["recommendation_source"])

    def test_translation_is_clipped_to_the_text_cap(self):
        issues = self.planrun.aggregate_issues(self.RUN1, [self.seed], [], [])
        out, _ = self._narrate(issues, [{"id": IID, "problem": "P", "root_cause": "R",
                                         "depends_on": [], "recommendation": "译" * 400}])
        self.assertEqual(out[0]["recommendation"], "译" * self.planrun._ISSUE_TEXT_MAX)


class RecommendationZhEndToEnd(DdbFixture):
    def test_english_adoption_survives_translation_and_both_texts_persist(self):
        prev_key = f"{PLAN_ID}#20260901090000"
        carried = self.planrun.aggregate_issues(prev_key, self.planrun._collect_issue_seeds([
            dataset_stage([case("case-9", False, {"root_causes": [rc(FIX_EN, EXPLAIN_EN)]})])]), [], [])
        for it in carried:
            del it["recommendation_source"]  # 上一版落库的老形状
        self.seed_prior(prev_key, issues=carried, proposals=[
            {"summary": FIX_EN[:300], "generated_at": "2026-09-01 09:20 UTC",
             "adopted_at": "2026-09-01 09:20 UTC", "source": "run_advice", "refs": ["回归测试 · case-9"]}],
            stage_summaries=[{"type": "dataset", "status": "completed", "pass_rate": 0.0, "cases": 1,
                              "evaluators": ["correctness"]}],
            started_epoch=1788253200)
        report = self.run_plan([dataset_stage([
            case("case-9", False, {"root_causes": [rc(FIX_EN, EXPLAIN_EN)]})])],
            judge=judge_with_issues({"issues": [
                {"id": IID, "problem": "1 个用例（case-9）在空结果后编造订单号",
                 "root_cause": "提示词未规定空结果话术", "depends_on": [],
                 "recommendation": FIX_EN_ZH}]}))
        (it,) = report["synthesis_issues"]
        self.assertEqual(it["recommendation"], FIX_EN_ZH)
        self.assertEqual(it["recommendation_source"], FIX_EN)
        self.assertIn(it["status"], ("adopted", "resolved"))
        self.assertEqual(it["occurrences"], 2)
        stored = json.loads(self.item(report["run_key"])["synthesis_issues"])
        self.assertEqual(stored, report["synthesis_issues"])
        self.assertEqual(self.planrun.get_plan_run(report["run_key"])["synthesis_issues"],
                         report["synthesis_issues"])


if __name__ == "__main__":
    unittest.main()
