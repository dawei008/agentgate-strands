"""问题台账 B：采纳效果自动判定 adoption_effect（ADR-0016 ③，ledger-data 批）。

契约：docs/payload-contract.md「问题台账」小节。本文件钉住：

  · 采纳即落 pending：set_proposal_adopted(True) / adopt_run_advice 都在那条
    proposal 上写 adoption_effect.verdict="pending"；取消采纳删掉它。
  · run 完成落库时，对此前任一 completed run 里 adopted_at 非空的每条建议算
    效果并回写到**那条 proposal 上**（同 attach_proposal 的存储位置，不新建表）。
  · 判据只有两条硬事实：目标线（SCORE_TARGET=0.70，与 CONTEXT.md「目标线」/
    diagnosis.LOW_SCORE_THRESHOLD 同一条）的穿越、用例 pass 的翻面；不用 ±0.0x。
    红队的硬事实 = 攻破数归零 / 从零变有。
  · refs 点名的用例/评估器优先算；refs 一个都对不上（线上会话 id 下次不再出现）
    就按环节的头部指标算。
  · 采纳时刻 ≥ 本次开跑 ⇒ pending；环节/评估器构成与采纳时不同 ⇒ inconclusive
    并写 reason；同时有改善与退步 ⇒ inconclusive。
  · 定稿（improved/unchanged/regressed）不被后来的 run 覆盖；pending/inconclusive
    每次 run 重判。

moto 的真 DynamoDB + 打桩 S3；judge 断到 judgellm.converse。
运行：python3 -m pytest tests/test_ledger_adoption_effect.py -q
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_ledger_issues import (  # noqa: E402
    DdbFixture, EXPLAIN_A, FIX_A, PLAN_ID, case, dataset_stage, judge_with_issues,
    iid, observe_stage, rc, session,
)

BASE_KEY = f"{PLAN_ID}#20260901090000"
CUR_KEY = f"{PLAN_ID}#20260903090000"
BASE_EPOCH = 1788253200            # 2026-09-01 09:00 UTC
CUR_EPOCH = 1788426000             # 2026-09-03 09:00 UTC
ADOPTED_BEFORE = "2026-09-01 10:00 UTC"


def proposal(refs=None, adopted_at=ADOPTED_BEFORE, effect=None):
    p = {"summary": FIX_A[:300], "generated_at": ADOPTED_BEFORE, "adopted_at": adopted_at,
         "source": "run_advice", "refs": refs or []}
    if effect is not None:
        p["adoption_effect"] = effect
    return p


def redteam_stage(rows):
    breached = sum(1 for r in rows if r.get("breached"))
    return {"type": "redteam", "status": "completed", "run_id": "rt-1",
            "attacks": len(rows), "breached": breached, "actual_cost_usd": 0.3,
            "verdict": "risky" if breached else "safe",
            "report": {"results": rows, "attacks": len(rows), "breached": breached}}


def attack(name, breached, errored=False):
    return {"case_name": name, "breached": breached and not errored, "errored": errored,
            "score": 0.9 if breached else 0.1, "reason": "r"}


def baseline_of(stage_results, run_key=BASE_KEY, started_epoch=BASE_EPOCH):
    """采纳时那次 run 的读侧形态（_run_from_item 的字段子集）+ 它的 S3 报告体。"""
    import planrun
    summary = {"run_key": run_key, "sk": run_key, "status": "completed",
               "started_epoch": started_epoch,
               "stage_summaries": [planrun._stage_summary(r) for r in stage_results],
               "proposals": [], "s3_key": f"reports/{PLAN_ID}/x.json"}
    report = {"run_key": run_key, "stages": stage_results}
    return summary, report


class Judge(unittest.TestCase):
    def setUp(self):
        import planrun
        self.planrun = planrun

    def judge(self, prop, base_stages, cur_stages, started=CUR_EPOCH, report=True):
        base, rep = baseline_of(base_stages)
        return self.planrun.judge_adoption_effect(
            prop, base, rep if report else None, CUR_KEY, started, cur_stages)

    def test_target_line_is_the_site_wide_one(self):
        import diagnosis
        self.assertEqual(self.planrun.SCORE_TARGET, diagnosis.LOW_SCORE_THRESHOLD)
        self.assertEqual(self.planrun.SCORE_TARGET, 0.7)

    def test_adopted_at_or_after_this_run_started_is_pending(self):
        base = [dataset_stage([case("c1", False)])]
        cur = [dataset_stage([case("c1", True)])]
        eff = self.judge(proposal(adopted_at="2026-09-03 09:00 UTC"), base, cur)
        self.assertEqual(eff["verdict"], "pending")
        self.assertIsNone(eff["measured_run"])
        self.assertEqual(eff["baseline_run"], BASE_KEY)
        eff = self.judge(proposal(adopted_at="2026-09-03 09:05 UTC"), base, cur)
        self.assertEqual(eff["verdict"], "pending")

    def test_named_case_flipping_fail_to_pass_is_improved(self):
        base = [dataset_stage([case("case-2", False), case("case-5", False)])]
        cur = [dataset_stage([case("case-2", True), case("case-5", False)])]
        eff = self.judge(proposal(refs=["回归测试 · case-2"]), base, cur)
        self.assertEqual(eff["verdict"], "improved")
        self.assertEqual(eff["cases"], [{"ref": "case-2", "before": "fail", "after": "pass"}])
        self.assertEqual(eff["measured_run"], CUR_KEY)
        self.assertEqual(eff["baseline_run"], BASE_KEY)
        self.assertIsNone(eff["reason"])
        self.assertEqual(set(eff), {"verdict", "metrics", "cases", "measured_run",
                                    "baseline_run", "reason"})

    def test_named_case_flipping_pass_to_fail_is_regressed(self):
        base = [dataset_stage([case("case-2", True)])]
        cur = [dataset_stage([case("case-2", False)])]
        eff = self.judge(proposal(refs=["回归测试 · case-2"]), base, cur)
        self.assertEqual(eff["verdict"], "regressed")
        self.assertEqual(eff["cases"][0]["after"], "fail")

    def test_named_case_still_failing_is_unchanged(self):
        base = [dataset_stage([case("case-9", False)])]
        cur = [dataset_stage([case("case-9", False)])]
        eff = self.judge(proposal(refs=["回归测试 · case-9"]), base, cur)
        self.assertEqual(eff["verdict"], "unchanged")
        self.assertEqual(eff["cases"], [{"ref": "case-9", "before": "fail", "after": "fail"}])

    def test_named_evaluator_crossing_the_target_line_is_improved(self):
        def obs(mean):
            st = observe_stage([session("s-old")])
            st["summary"] = {"helpfulness": {"mean_score": mean, "pass_rate": 0.5}}
            st["overall_mean"] = mean
            return st
        eff = self.judge(proposal(refs=["helpfulness"]), [obs(0.62)], [obs(0.74)])
        self.assertEqual(eff["verdict"], "improved")
        self.assertEqual(eff["metrics"], [{"name": "helpfulness", "before": 0.62, "after": 0.74}])
        # 没穿线的变化不是结论（0.74 → 0.78 仍在线上）
        eff = self.judge(proposal(refs=["helpfulness"]), [obs(0.74)], [obs(0.78)])
        self.assertEqual(eff["verdict"], "unchanged")
        # 跌破线才是退步
        eff = self.judge(proposal(refs=["helpfulness"]), [obs(0.74)], [obs(0.66)])
        self.assertEqual(eff["verdict"], "regressed")

    def test_without_refs_the_stage_headline_metrics_decide(self):
        base = [dataset_stage([case("a", False), case("b", False), case("c", True), case("d", True)])]
        cur = [dataset_stage([case("a", True), case("b", False), case("c", True), case("d", True)])]
        eff = self.judge(proposal(), base, cur)
        self.assertEqual(eff["verdict"], "improved")  # pass_rate 0.5 → 0.75 穿过 0.70
        names = {m["name"] for m in eff["metrics"]}
        self.assertIn("pass_rate", names)
        self.assertIn("correctness", names)  # 逐评估器均分也列出来
        self.assertEqual(eff["cases"], [])

    def test_redteam_hard_fact_is_breach_count_reaching_or_leaving_zero(self):
        base = [redteam_stage([attack("rt-1", True), attack("rt-2", True), attack("rt-3", False)])]
        cur = [redteam_stage([attack("rt-1", False), attack("rt-2", False), attack("rt-3", False)])]
        eff = self.judge(proposal(), base, cur)
        self.assertEqual(eff["verdict"], "improved")
        self.assertEqual(eff["metrics"], [{"name": "breached", "before": 2, "after": 0}])
        # 2 → 1 不是硬事实
        cur2 = [redteam_stage([attack("rt-1", True), attack("rt-2", False), attack("rt-3", False)])]
        self.assertEqual(self.judge(proposal(), base, cur2)["verdict"], "unchanged")
        # 0 → 1 是退步
        safe = [redteam_stage([attack("rt-1", False)])]
        hit = [redteam_stage([attack("rt-1", True)])]
        self.assertEqual(self.judge(proposal(), safe, hit)["verdict"], "regressed")
        # 点名攻击行的翻面
        eff = self.judge(proposal(refs=["红队测试 · rt-1"]), base, cur)
        self.assertEqual(eff["cases"], [{"ref": "rt-1", "before": "fail", "after": "pass"}])

    def test_refs_that_match_nothing_fall_back_to_headline_metrics(self):
        base = [dataset_stage([case("a", False), case("b", True)])]
        cur = [dataset_stage([case("a", True), case("b", True)])]
        eff = self.judge(proposal(refs=["线上评估 · sess-gone-forever"]), base, cur)
        self.assertEqual(eff["verdict"], "improved")
        self.assertTrue(eff["metrics"])

    def test_mixed_signals_are_inconclusive_with_a_reason(self):
        base = [dataset_stage([case("a", False), case("b", True)])]
        cur = [dataset_stage([case("a", True), case("b", False)])]
        eff = self.judge(proposal(refs=["回归测试 · a", "回归测试 · b"]), base, cur)
        self.assertEqual(eff["verdict"], "inconclusive")
        self.assertTrue(eff["reason"])

    def test_changed_stage_or_evaluator_composition_is_inconclusive(self):
        base = [dataset_stage([case("a", False)])]
        cur = [observe_stage([session("s")])]
        eff = self.judge(proposal(), base, cur)
        self.assertEqual(eff["verdict"], "inconclusive")
        self.assertIn("环节", eff["reason"])
        cur2 = [dataset_stage([case("a", True)])]
        cur2[0]["evaluators"] = ["correctness", "helpfulness"]
        eff = self.judge(proposal(), base, cur2)
        self.assertEqual(eff["verdict"], "inconclusive")
        self.assertIn("评估器", eff["reason"])

    def test_nothing_comparable_is_inconclusive(self):
        base = [{"type": "dataset", "status": "error", "error": "boom"}]
        cur = [{"type": "dataset", "status": "error", "error": "boom"}]
        eff = self.judge(proposal(), base, cur)
        self.assertEqual(eff["verdict"], "inconclusive")
        self.assertTrue(eff["reason"])

    def test_missing_baseline_report_still_judges_by_metrics(self):
        base = [dataset_stage([case("a", False), case("b", False)])]
        cur = [dataset_stage([case("a", True), case("b", True)])]
        eff = self.judge(proposal(refs=["回归测试 · a"]), base, cur, report=False)
        self.assertEqual(eff["verdict"], "improved")
        self.assertEqual(eff["cases"], [])


class AdoptionWritesPending(DdbFixture):
    def test_set_proposal_adopted_writes_pending_and_unadopt_removes_it(self):
        self.seed_prior(BASE_KEY, proposals=[{"summary": "x", "generated_at": "t", "adopted_at": None}])
        p = self.planrun.set_proposal_adopted(BASE_KEY, 0, True)
        self.assertEqual(p["adoption_effect"], {
            "verdict": "pending", "metrics": [], "cases": [],
            "measured_run": None, "baseline_run": BASE_KEY, "reason": None})
        stored = json.loads(self.item(BASE_KEY)["proposals"])
        self.assertEqual(stored[0]["adoption_effect"]["verdict"], "pending")
        p = self.planrun.set_proposal_adopted(BASE_KEY, 0, False)
        self.assertNotIn("adoption_effect", p)
        self.assertNotIn("adoption_effect", json.loads(self.item(BASE_KEY)["proposals"])[0])

    def test_adopt_run_advice_writes_pending(self):
        self.seed_prior(BASE_KEY)
        _, entry = self.planrun.adopt_run_advice(BASE_KEY, FIX_A, ["回归测试 · case-2"])
        self.assertEqual(entry["adoption_effect"]["verdict"], "pending")
        self.assertEqual(entry["adoption_effect"]["baseline_run"], BASE_KEY)


class EffectWrittenBackOnRunCompletion(DdbFixture):
    def seed_baseline(self, stage_results, refs, effect=None, adopted_at=ADOPTED_BEFORE):
        base, report = baseline_of(stage_results)
        self.s3_objects[base["s3_key"]] = json.dumps(report, ensure_ascii=False).encode()
        self.seed_prior(BASE_KEY, proposals=[proposal(refs=refs, effect=effect, adopted_at=adopted_at)],
                        stage_summaries=base["stage_summaries"], started_epoch=BASE_EPOCH)
        self.table.update_item(Key={"pk": "PLANRUN", "sk": BASE_KEY},
                               UpdateExpression="SET s3_key = :k",
                               ExpressionAttributeValues={":k": base["s3_key"]})

    def baseline_proposals(self):
        return json.loads(self.item(BASE_KEY)["proposals"])

    def test_effect_lands_on_the_baseline_proposal_and_resolves_the_issue(self):
        self.seed_baseline([dataset_stage([
            case("case-2", False, {"root_causes": [rc(FIX_A, EXPLAIN_A)]}), case("case-7", True)])],
            refs=["回归测试 · case-2"],
            effect={"verdict": "pending", "metrics": [], "cases": [],
                    "measured_run": None, "baseline_run": BASE_KEY, "reason": None})
        report = self.run_plan([dataset_stage([case("case-2", True), case("case-7", True)])],
                               judge=judge_with_issues({"issues": []}))
        eff = self.baseline_proposals()[0]["adoption_effect"]
        self.assertEqual(eff["verdict"], "improved")
        self.assertEqual(eff["measured_run"], report["run_key"])
        self.assertEqual(eff["baseline_run"], BASE_KEY)
        self.assertEqual(eff["cases"], [{"ref": "case-2", "before": "fail", "after": "pass"}])
        # 台账里那条建议的 status 随之 resolved（本次没再见到，仍带着）
        self.assertEqual(report["synthesis_issues"], [])  # 上一次没有台账底稿 ⇒ 无可带
        # 同一 run 再读：效果就在 proposals 上，get_plan_run 零改动带出
        got = self.planrun.get_plan_run(BASE_KEY)["proposals"][0]["adoption_effect"]
        self.assertEqual(got["verdict"], "improved")

    def test_resolved_status_flows_into_the_ledger(self):
        base_stage = dataset_stage([case("case-2", False, {"root_causes": [rc(FIX_A, EXPLAIN_A)]})])
        self.seed_baseline([base_stage], refs=["回归测试 · case-2"])
        ledger = self.planrun.aggregate_issues(BASE_KEY, self.planrun._collect_issue_seeds([base_stage]), [], [])
        self.table.update_item(Key={"pk": "PLANRUN", "sk": BASE_KEY},
                               UpdateExpression="SET synthesis_issues = :i",
                               ExpressionAttributeValues={":i": json.dumps(ledger)})
        report = self.run_plan([dataset_stage([case("case-2", True)])],
                               judge=judge_with_issues({"issues": []}))
        issues = report["synthesis_issues"]
        self.assertEqual([i["id"] for i in issues], [iid("SYSTEM_PROMPT_FIX", ["case:case-2"])])
        self.assertEqual(issues[0]["status"], "resolved")

    def test_a_final_verdict_is_not_overwritten_by_a_later_run(self):
        final = {"verdict": "regressed", "metrics": [], "cases": [{"ref": "case-2", "before": "pass", "after": "fail"}],
                 "measured_run": f"{PLAN_ID}#20260902090000", "baseline_run": BASE_KEY, "reason": None}
        self.seed_baseline([dataset_stage([case("case-2", False)])], refs=["回归测试 · case-2"], effect=final)
        self.run_plan([dataset_stage([case("case-2", True)])], judge=judge_with_issues({"issues": []}))
        self.assertEqual(self.baseline_proposals()[0]["adoption_effect"], final)

    def test_pending_and_inconclusive_are_rejudged(self):
        incon = {"verdict": "inconclusive", "metrics": [], "cases": [], "measured_run": f"{PLAN_ID}#20260902090000",
                 "baseline_run": BASE_KEY, "reason": "环节构成与采纳时不同"}
        self.seed_baseline([dataset_stage([case("case-2", False)])], refs=["回归测试 · case-2"], effect=incon)
        report = self.run_plan([dataset_stage([case("case-2", True)])], judge=judge_with_issues({"issues": []}))
        eff = self.baseline_proposals()[0]["adoption_effect"]
        self.assertEqual(eff["verdict"], "improved")
        self.assertEqual(eff["measured_run"], report["run_key"])

    def test_adoption_after_this_run_started_stays_pending(self):
        self.seed_baseline([dataset_stage([case("case-2", False)])], refs=["回归测试 · case-2"],
                           adopted_at="2099-01-01 00:00 UTC")
        self.run_plan([dataset_stage([case("case-2", True)])], judge=judge_with_issues({"issues": []}))
        self.assertEqual(self.baseline_proposals()[0]["adoption_effect"]["verdict"], "pending")

    def test_unadopted_proposals_get_no_effect(self):
        self.seed_baseline([dataset_stage([case("case-2", False)])], refs=[], adopted_at=None)
        self.run_plan([dataset_stage([case("case-2", True)])], judge=judge_with_issues({"issues": []}))
        self.assertNotIn("adoption_effect", self.baseline_proposals()[0])

    def test_stopped_or_zero_data_runs_do_not_judge(self):
        self.seed_baseline([dataset_stage([case("case-2", False)])], refs=["回归测试 · case-2"])
        self.run_plan([{"type": "dataset", "status": "error", "error": "数据集 'faq' 不存在"}])
        self.assertNotIn("adoption_effect", self.baseline_proposals()[0])


if __name__ == "__main__":
    unittest.main()
