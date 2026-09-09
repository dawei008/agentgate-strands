"""问题台账 A：综合报告结构化输出 synthesis_issues（ADR-0016 ③，ledger-data 批）。

契约：docs/payload-contract.md「问题台账」小节。本文件钉住：

  · 聚合键 = fix_recommendation strip 后；无建议时退到 root_cause_explanation
    strip 后；id = 该键 sha1 前 8 位（跨 run 稳定）。
  · 跨 run 合并：上一次 completed run 的 synthesis_issues 是「台账」，本次诊断
    产物并入 —— 再次出现 occurrences+1、first_seen_run 不动；没再出现的条目原样
    带着（status 仍要按 proposals 对回）。
  · status 由 proposals 对回：匹配键 = 建议文本 strip 后截到 300 与
    proposals[].summary 全等（与 adopt_run_advice / 前端 persistedAdoptedAt 同一
    规则）；有 adopted_at ⇒ adopted；adoption_effect.verdict == improved ⇒ resolved。
  · LLM 只写 problem / root_cause / depends_on，且走 toolUse 强制 schema
    （submit_issues）；LLM 失败 ⇒ 确定性回落文本，条目一条不少；没有任何条目
    ⇒ 一次 judge 调用都不发。
  · 老数据：没有诊断产物的 run 落库**不写**该键，读出为 []（不是 null）。

moto 的真 DynamoDB + 打桩 S3；judge 断到 judgellm.converse。
运行：python3 -m pytest tests/test_ledger_issues.py -q
"""

import asyncio
import hashlib
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

TABLE = "eval-catalog-test"
BUCKET = "eval-artifacts-test"
REGION = "us-west-2"
PLAN_ID = "plan-1ed9e7a1c0de"
PLAN = {"plan_id": PLAN_ID, "name": "客服 Agent 周巡检", "agent_name": "support-bot",
        "stages": [{"type": "observe", "evaluators": ["helpfulness"], "metrics": []},
                   {"type": "dataset", "dataset": "faq", "evaluators": ["correctness"]}]}
AGENT = {"agent_name": "support-bot", "agent_arn": "arn:aws:bedrock:x:y:runtime/z"}

FIX_A = "在系统提示词中加入：工具返回空结果时明确告知用户「未查到」，不得编造具体数据。"
FIX_B = "改写 rebook_flight 工具描述：注明仅支持 72 小时内的航班改签。"
EXPLAIN_A = "Agent 在 search_orders 返回空数组后仍然报出了具体订单号。"
EXPLAIN_B = "工具描述未说明时间限制，模型对超期航班也调用了 rebook_flight。"
EXPLAIN_C = "回复里没有任何工具调用，直接给出了猜测的余额。"


def rc(fix, explain, fix_type="SYSTEM_PROMPT_FIX"):
    """app/diagnosis.py:diagnose 的 root_causes[] 真形态（键名逐字）。"""
    return {"location": "span-1", "root_cause_explanation": explain,
            "causality": "PRIMARY_FAILURE", "impact": "x",
            "fix_type": fix_type, "fix_recommendation": fix}


def observe_stage(details):
    return {"type": "observe", "status": "completed", "sessions": len(details),
            "summary": {"helpfulness": {"mean_score": 0.62, "pass_rate": 0.5}},
            "overall_mean": 0.62, "metrics": None, "session_details": details,
            "analysis": None, "actual_cost_usd": 0.1,
            "evaluators": ["helpfulness"], "metric_keys": []}


def dataset_stage(results):
    judged = [r for r in results if r.get("results")]
    passed = sum(1 for r in judged if all(v.get("passed") for v in r["results"].values()))
    return {"type": "dataset", "status": "completed", "error": None, "run_id": "run-1",
            "dataset": "faq", "evaluators": ["correctness"], "cases": len(results),
            "judged_cases": len(judged), "blank_cases": 0, "actual_cost_usd": 0.05,
            "pass_rate": round(passed / len(judged), 4) if judged else None,
            "report": {"results": results}}


def case(name, passed, diagnosis=None):
    row = {"case": name, "results": {"correctness": {"score": 1.0 if passed else 0.2,
                                                     "passed": passed, "errored": False}}}
    if diagnosis is not None:
        row["diagnosis"] = diagnosis
    return row


def session(sid, diagnosis=None):
    row = {"agent": "support-bot", "session_id": sid,
           "results": {"helpfulness": {"score": 0.4, "passed": False, "errored": False}}}
    if diagnosis is not None:
        row["diagnosis"] = diagnosis
    return row


def sha8(text: str) -> str:
    """批 ledger-id-merge 之前的 id 算法（sha1(建议)）：只用来造老形状 carried 夹具。"""
    return hashlib.sha1(text.strip().encode("utf-8")).hexdigest()[:8]


def iid(fix_type, rows, anchors=()) -> str:
    """ADR-0018 的 id：sha1("<fix_type>|<sorted kind:ref>|<sorted 会话 span>") 前 8 位，测试侧独立实现。"""
    key = f"{fix_type or ''}|{','.join(sorted(rows))}|{','.join(sorted(anchors))}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]


# ------------------------------------------------ 纯函数：种子与聚合

class CollectSeeds(unittest.TestCase):
    def setUp(self):
        import planrun
        self.planrun = planrun

    def test_case_and_session_evidence_kinds_follow_the_stage_type(self):
        stages = [
            observe_stage([session("sess-a1", {"failures": [], "root_causes": [rc(FIX_A, EXPLAIN_A)]}),
                           session("sess-b2")]),
            dataset_stage([case("case-9", False, {"failures": [], "root_causes": [rc(FIX_A, EXPLAIN_A)]}),
                           case("case-3", True)]),
        ]
        seeds = self.planrun._collect_issue_seeds(stages)
        self.assertEqual(len(seeds), 1)
        s = seeds[0]
        # 身份 = fix_type × 证据行 × 会话行的 span（rc() 的 location=span-1）；用例行不带 span
        self.assertEqual(s["identity_key"], "SYSTEM_PROMPT_FIX|case:case-9,session:sess-a1|span-1")
        self.assertEqual(s["id"], iid("SYSTEM_PROMPT_FIX", ["session:sess-a1", "case:case-9"], ["span-1"]))
        self.assertEqual(s["recommendation"], FIX_A)
        self.assertEqual(s["fix_type"], "SYSTEM_PROMPT_FIX")
        self.assertEqual(s["evidence"], [{"kind": "session", "ref": "sess-a1"},
                                         {"kind": "case", "ref": "case-9"}])
        self.assertEqual(s["explanations"], [EXPLAIN_A])

    def test_without_a_recommendation_the_key_falls_back_to_the_explanation(self):
        stages = [dataset_stage([case("case-1", False, {"failures": [], "root_causes": [
            rc("", EXPLAIN_C, fix_type="OTHERS")]})])]
        seeds = self.planrun._collect_issue_seeds(stages)
        self.assertEqual(len(seeds), 1)
        self.assertEqual(seeds[0]["id"], iid("OTHERS", ["case:case-1"]))
        self.assertIsNone(seeds[0]["recommendation"])
        self.assertEqual(seeds[0]["fix_type"], "OTHERS")

    def test_blank_root_causes_redteam_and_clean_diagnoses_produce_nothing(self):
        stages = [
            observe_stage([session("s", {"failures": [], "root_causes": [], "clean": True}),
                           session("t", {"failures": [], "root_causes": [rc("  ", "   ")]})]),
            {"type": "redteam", "status": "completed", "attacks": 3, "breached": 1,
             "report": {"results": [{"case_name": "rt-1", "breached": True, "errored": False,
                                     "diagnosis": {"root_causes": [rc(FIX_B, EXPLAIN_B)]}}]}},
        ]
        self.assertEqual(self.planrun._collect_issue_seeds(stages), [])

    def test_unknown_fix_type_is_bucketed_as_others_and_missing_stays_null(self):
        stages = [dataset_stage([
            case("c1", False, {"root_causes": [rc(FIX_A, EXPLAIN_A, fix_type="WEIRD")]}),
            case("c2", False, {"root_causes": [rc(FIX_B, EXPLAIN_B, fix_type=None)]}),
        ])]
        by_id = {s["id"]: s for s in self.planrun._collect_issue_seeds(stages)}
        self.assertEqual(by_id[iid("OTHERS", ["case:c1"])]["fix_type"], "OTHERS")
        self.assertIsNone(by_id[iid(None, ["case:c2"])]["fix_type"])

    def test_same_fix_in_one_row_is_one_evidence_and_explanations_are_capped_at_three(self):
        rcs = [rc(FIX_A, f"解释 {i}") for i in range(5)]
        stages = [dataset_stage([case("c1", False, {"root_causes": rcs})])]
        seeds = self.planrun._collect_issue_seeds(stages)
        self.assertEqual(seeds[0]["evidence"], [{"kind": "case", "ref": "c1"}])
        self.assertEqual(len(seeds[0]["explanations"]), 3)


class Aggregate(unittest.TestCase):
    RUN1 = f"{PLAN_ID}#20260901090000"
    RUN2 = f"{PLAN_ID}#20260902090000"

    def setUp(self):
        import planrun
        self.planrun = planrun
        self.seed_a = self.planrun._collect_issue_seeds([dataset_stage([
            case("case-9", False, {"root_causes": [rc(FIX_A, EXPLAIN_A)]}),
            case("case-4", False, {"root_causes": [rc(FIX_A, EXPLAIN_A)]}),
        ])])[0]

    def test_new_issue_has_the_contract_shape(self):
        issues = self.planrun.aggregate_issues(self.RUN1, [self.seed_a], [], [])
        self.assertEqual(len(issues), 1)
        it = issues[0]
        self.assertEqual(set(it), {"id", "identity_key", "problem", "evidence", "root_cause",
                                   "recommendation", "recommendation_source", "fix_type",
                                   "first_seen_run", "last_seen_run", "occurrences", "depends_on",
                                   "status", "evaluators"})
        self.assertEqual(it["id"], iid("SYSTEM_PROMPT_FIX", ["case:case-4", "case:case-9"]))
        self.assertEqual(it["identity_key"], "SYSTEM_PROMPT_FIX|case:case-4,case:case-9|")
        self.assertEqual(it["first_seen_run"], self.RUN1)
        self.assertEqual(it["last_seen_run"], self.RUN1)
        self.assertEqual(it["occurrences"], 1)
        self.assertEqual(it["status"], "open")
        self.assertEqual(it["depends_on"], [])
        self.assertEqual(it["recommendation"], FIX_A)
        # 确定性回落文本：带数字与用例名，等 LLM 改写；根因取诊断原话
        self.assertIn("2", it["problem"])
        self.assertIn("case-9", it["problem"])
        self.assertEqual(it["root_cause"], EXPLAIN_A)

    def test_recurrence_bumps_occurrences_and_keeps_first_seen(self):
        carried = self.planrun.aggregate_issues(self.RUN1, [self.seed_a], [], [])
        issues = self.planrun.aggregate_issues(self.RUN2, [self.seed_a], carried, [])
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["occurrences"], 2)
        self.assertEqual(issues[0]["first_seen_run"], self.RUN1)
        self.assertEqual(issues[0]["last_seen_run"], self.RUN2)

    def test_carried_issue_not_seen_this_run_is_kept_with_its_history(self):
        carried = self.planrun.aggregate_issues(self.RUN1, [self.seed_a], [], [])
        carried[0]["problem"] = "LLM 写的问题句"
        issues = self.planrun.aggregate_issues(self.RUN2, [], carried, [])
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["occurrences"], 1)
        self.assertEqual(issues[0]["last_seen_run"], self.RUN1)
        self.assertEqual(issues[0]["problem"], "LLM 写的问题句")  # 没新证据不改写

    def test_status_follows_proposals_by_the_strip_equal_rule(self):
        base = {"generated_at": "t", "source": "run_advice", "refs": []}
        adopted = [{**base, "summary": f"  {FIX_A}\n"[:300].strip(), "adopted_at": "2026-09-01 10:00 UTC"}]
        self.assertEqual(self.planrun.aggregate_issues(self.RUN1, [self.seed_a], [], adopted)[0]["status"],
                         "adopted")
        resolved = [{**adopted[0], "adoption_effect": {"verdict": "improved"}}]
        self.assertEqual(self.planrun.aggregate_issues(self.RUN1, [self.seed_a], [], resolved)[0]["status"],
                         "resolved")
        not_adopted = [{**adopted[0], "adopted_at": None}]
        self.assertEqual(self.planrun.aggregate_issues(self.RUN1, [self.seed_a], [], not_adopted)[0]["status"],
                         "open")
        regressed = [{**adopted[0], "adoption_effect": {"verdict": "regressed"}}]
        self.assertEqual(self.planrun.aggregate_issues(self.RUN1, [self.seed_a], [], regressed)[0]["status"],
                         "adopted")

    def test_long_recommendation_matches_the_300_char_clipped_summary(self):
        long_fix = "改" * 350
        seed = self.planrun._collect_issue_seeds([dataset_stage([
            case("c", False, {"root_causes": [rc(long_fix, EXPLAIN_A)]})])])[0]
        props = [{"summary": long_fix[:300], "generated_at": "t", "adopted_at": "2026-09-01 10:00 UTC"}]
        self.assertEqual(self.planrun.aggregate_issues(self.RUN1, [seed], [], props)[0]["status"],
                         "adopted")

    def test_seen_this_run_sorts_first_then_by_occurrences_and_the_list_is_capped(self):
        many = []
        for i in range(30):
            many += self.planrun._collect_issue_seeds([dataset_stage([
                case(f"c{i}", False, {"root_causes": [rc(f"修法 {i}", f"解释 {i}")]})])])
        carried = self.planrun.aggregate_issues(self.RUN1, many, [], [])
        self.assertEqual(len(carried), self.planrun._ISSUES_MAX)
        # 第二次只有 c3 再出问题（措辞换了也不算新条目）：它排第一，且 occurrences=2
        again = self.planrun._collect_issue_seeds([dataset_stage([
            case("c3", False, {"root_causes": [rc("修法 3 换个说法", "解释 3 换个说法")]})])])
        issues = self.planrun.aggregate_issues(self.RUN2, again, carried, [])
        self.assertEqual(issues[0]["id"], iid("SYSTEM_PROMPT_FIX", ["case:c3"]))
        self.assertEqual(issues[0]["occurrences"], 2)
        self.assertLessEqual(len(issues), self.planrun._ISSUES_MAX)


# ------------------------------------------------ 端到端：落库 / 读回 / LLM 口子

class DdbFixture(unittest.TestCase):
    def setUp(self):
        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)
        self.table = boto3.resource("dynamodb", region_name=REGION).create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST")
        import catalog
        import planrun
        self.planrun = planrun
        for patcher in (mock.patch.object(catalog, "get_table", return_value=self.table),
                        mock.patch.object(catalog, "TABLE_NAME", TABLE),
                        mock.patch.dict(os.environ, {"ARTIFACTS_BUCKET": BUCKET})):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.s3 = mock.MagicMock()
        self.s3.get_object.side_effect = self._get_object
        self.s3_objects: dict[str, bytes] = {}
        s = mock.patch.object(planrun.runstore, "_s3", return_value=self.s3)
        s.start()
        self.addCleanup(s.stop)
        planrun._stop_polls.clear()
        self.addCleanup(planrun._stop_polls.clear)
        real_archive = planrun.runstore.archive_run

        def archive(report, prefix, ts, noun="结果"):
            key, err = real_archive(report, prefix, ts, noun=noun)
            if key:
                self.s3_objects[key] = json.dumps(report, ensure_ascii=False, default=str).encode()
            return key, err
        a = mock.patch.object(planrun.runstore, "archive_run", archive)
        a.start()
        self.addCleanup(a.stop)

    def _get_object(self, Bucket, Key):
        if Key not in self.s3_objects:
            raise KeyError(Key)
        return {"Body": mock.MagicMock(read=lambda: self.s3_objects[Key])}

    def seed_prior(self, run_key, *, issues=None, proposals=None, stage_summaries=None,
                   started_epoch=None):
        item = {"pk": "PLANRUN", "sk": run_key, "plan_id": PLAN_ID, "plan_name": PLAN["name"],
                "agent_name": "support-bot", "status": "completed", "triggered_by": "manual",
                "started_at": "2026-09-01 09:00 UTC", "finished_at": "2026-09-01 09:10 UTC",
                "stage_summaries": json.dumps(stage_summaries or [], ensure_ascii=False),
                "overview": "{}", "s3_key": "",
                "proposals": json.dumps(proposals or [], ensure_ascii=False)}
        if started_epoch is not None:
            item["started_epoch"] = started_epoch
        if issues is not None:
            item["synthesis_issues"] = json.dumps(issues, ensure_ascii=False)
        self.table.put_item(Item=item)

    def run_plan(self, stage_results, judge=None):
        import judgellm
        plan = {**PLAN, "stages": [{"type": r["type"]} for r in stage_results]}
        results = list(stage_results)
        self.events: list[dict] = []

        async def emit(ev):
            self.events.append(ev)

        async def pop_stage(*_a, **_k):
            return results.pop(0)

        self.judge = judge or mock.MagicMock(return_value={
            "text": "## 整体趋势\n首个数据点。", "tool_input": None, "stop_reason": "end_turn"})
        with mock.patch.object(self.planrun, "_run_observe_stage", pop_stage), \
                mock.patch.object(self.planrun, "_run_dataset_stage", pop_stage), \
                mock.patch.object(self.planrun, "_run_redteam_stage", pop_stage), \
                mock.patch.object(judgellm, "converse", self.judge):
            return asyncio.run(self.planrun.execute_plan_run(
                plan, AGENT, "judge-model", "manual", emit))

    def item(self, run_key):
        return self.table.get_item(Key={"pk": "PLANRUN", "sk": run_key}).get("Item") or {}


def judge_with_issues(tool_payload):
    """散文调用回文本；submit_issues 调用回 tool_input。"""
    def call(model, system, user_text, max_tokens, tool_spec=None, force_tool=None):
        if force_tool == "submit_issues":
            return {"text": "", "tool_input": tool_payload, "stop_reason": "tool_use"}
        return {"text": "## 整体趋势\n首个数据点。", "tool_input": None, "stop_reason": "end_turn"}
    return mock.MagicMock(side_effect=call)


class LedgerEndToEnd(DdbFixture):
    def test_run_without_diagnoses_writes_no_key_and_reads_back_an_empty_list(self):
        report = self.run_plan([observe_stage([session("s1")]), dataset_stage([case("c1", True)])])
        item = self.item(report["run_key"])
        self.assertNotIn("synthesis_issues", item)
        self.assertEqual(report["synthesis_issues"], [])
        self.assertEqual(self.planrun.get_plan_run(report["run_key"])["synthesis_issues"], [])
        # 只有散文那一次 judge 调用（零条目 ⇒ 不发 submit_issues）
        self.assertEqual(self.judge.call_count, 1)

    def test_old_item_without_the_key_reads_as_empty_list_not_null(self):
        self.seed_prior(f"{PLAN_ID}#20260830090000")
        run = self.planrun.get_plan_run(f"{PLAN_ID}#20260830090000")
        self.assertEqual(run["synthesis_issues"], [])
        self.assertIsInstance(run["synthesis_issues"], list)

    def test_run_with_diagnoses_persists_issues_written_by_the_forced_tool(self):
        judge = judge_with_issues({"issues": [
            {"id": sha8(FIX_A), "problem": "2 个用例（case-9、case-4）在工具空结果后编造订单号",
             "root_cause": "提示词未规定空结果时的话术", "depends_on": []},
        ]})
        report = self.run_plan([dataset_stage([
            case("case-9", False, {"root_causes": [rc(FIX_A, EXPLAIN_A)]}),
            case("case-4", False, {"root_causes": [rc(FIX_A, EXPLAIN_A)]}),
            case("case-1", True)])], judge=judge)
        issues = report["synthesis_issues"]
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["problem"], "2 个用例（case-9、case-4）在工具空结果后编造订单号")
        self.assertEqual(issues[0]["root_cause"], "提示词未规定空结果时的话术")
        self.assertEqual(issues[0]["first_seen_run"], report["run_key"])
        stored = json.loads(self.item(report["run_key"])["synthesis_issues"])
        self.assertEqual(stored, issues)
        self.assertEqual(self.planrun.get_plan_run(report["run_key"])["synthesis_issues"], issues)
        # 完整报告里也有一份（S3 归档体）
        archived = json.loads(self.s3_objects[report["s3_key"]])
        self.assertEqual(archived["synthesis_issues"], issues)
        # toolUse 强制：第二次 judge 调用带 force_tool=submit_issues
        calls = [c for c in self.judge.call_args_list if c.kwargs.get("force_tool") == "submit_issues"
                 or (len(c.args) >= 6 and c.args[5] == "submit_issues")]
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.judge.call_count, 2)

    def test_llm_failure_keeps_the_deterministic_ledger(self):
        def call(model, system, user_text, max_tokens, tool_spec=None, force_tool=None):
            if force_tool == "submit_issues":
                raise RuntimeError("503")
            return {"text": "## 整体趋势\nx", "tool_input": None, "stop_reason": "end_turn"}
        report = self.run_plan([dataset_stage([
            case("case-9", False, {"root_causes": [rc(FIX_A, EXPLAIN_A)]})])],
            judge=mock.MagicMock(side_effect=call))
        issues = report["synthesis_issues"]
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["id"], iid("SYSTEM_PROMPT_FIX", ["case:case-9"]))
        self.assertIn("case-9", issues[0]["problem"])
        self.assertEqual(issues[0]["root_cause"], EXPLAIN_A)
        self.assertEqual(report["status"], "completed")

    def test_llm_output_is_validated_against_known_ids(self):
        id_a, id_b = iid("SYSTEM_PROMPT_FIX", ["case:c1"]), iid("TOOL_DESCRIPTION_FIX", ["case:c2"])
        judge = judge_with_issues({"issues": [
            {"id": id_a, "problem": "P-A", "root_cause": "R-A",
             "depends_on": [id_b, id_a, "deadbeef"]},
            {"id": "deadbeef", "problem": "幻觉条目", "root_cause": "x", "depends_on": []},
        ]})
        report = self.run_plan([dataset_stage([
            case("c1", False, {"root_causes": [rc(FIX_A, EXPLAIN_A)]}),
            case("c2", False, {"root_causes": [rc(FIX_B, EXPLAIN_B, "TOOL_DESCRIPTION_FIX")]})])],
            judge=judge)
        by_id = {i["id"]: i for i in report["synthesis_issues"]}
        self.assertEqual(set(by_id), {id_a, id_b})
        # depends_on 只留已知 id、去掉自指与幻觉 id
        self.assertEqual(by_id[id_a]["depends_on"], [id_b])
        # LLM 没写到的条目保留回落文本
        self.assertIn("c2", by_id[id_b]["problem"])

    def test_previous_run_ledger_is_carried_and_status_read_from_its_proposals(self):
        prev_key = f"{PLAN_ID}#20260901090000"
        carried = self.planrun.aggregate_issues(prev_key, self.planrun._collect_issue_seeds([
            dataset_stage([case("case-9", False, {"root_causes": [rc(FIX_A, EXPLAIN_A)]}),
                           case("case-2", False, {"root_causes": [rc(FIX_B, EXPLAIN_B)]})])]), [], [])
        self.seed_prior(prev_key, issues=carried, proposals=[
            {"summary": FIX_B[:300], "generated_at": "2026-09-01 09:20 UTC",
             "adopted_at": "2026-09-01 09:20 UTC", "source": "run_advice", "refs": ["回归测试 · case-2"]}],
            stage_summaries=[{"type": "dataset", "status": "completed", "pass_rate": 0.5, "cases": 2,
                              "evaluators": ["correctness"]}],
            started_epoch=1788253200)
        report = self.run_plan([dataset_stage([
            case("case-9", False, {"root_causes": [rc(FIX_A, EXPLAIN_A)]}),
            case("case-2", True)])], judge=judge_with_issues({"issues": []}))
        id_a, id_b = iid("SYSTEM_PROMPT_FIX", ["case:case-9"]), iid("SYSTEM_PROMPT_FIX", ["case:case-2"])
        by_id = {i["id"]: i for i in report["synthesis_issues"]}
        self.assertEqual(set(by_id), {id_a, id_b})
        a, b = by_id[id_a], by_id[id_b]
        self.assertEqual(a["occurrences"], 2)
        self.assertEqual(a["first_seen_run"], prev_key)
        self.assertEqual(a["last_seen_run"], report["run_key"])
        self.assertEqual(a["status"], "open")
        self.assertEqual(b["occurrences"], 1)
        self.assertEqual(b["last_seen_run"], prev_key)
        self.assertIn(b["status"], ("adopted", "resolved"))

    def test_stopped_and_zero_data_runs_produce_no_ledger_and_no_extra_call(self):
        self.run_plan([{"type": "observe", "status": "empty",
                        "error": "最近 30 天没有可评估的会话", "sessions": 0}])
        self.assertEqual(self.judge.call_count, 0)
        row = self.planrun.list_plan_runs(PLAN_ID)[0]
        self.assertEqual(row["synthesis_issues"], [])


class ActionLayer(unittest.TestCase):
    def test_plan_run_report_frame_forwards_synthesis_issues_with_empty_list_default(self):
        """main.py 的终帧组装是纯字典映射，没有可注入的缝：钉源码（与
        synthesis_sections 那一行同一形态；缺字段回落 []，不是 null）。"""
        text = (Path(__file__).resolve().parent.parent / "app" / "main.py").read_text()
        self.assertIn('"synthesis_issues": final.get("synthesis_issues") or []', text)


# ------------------------------------------------ evaluators：问题按评估器归属（ADR-0016 分数口径修订）

def row_with_scores(name, scores: dict, diagnosis=None, kind="case"):
    """一行（回归用例 / 线上会话）带显式逐评估器分。score=None 模拟 errored（无分）。

    落点与真形态同刑：dataset 行 = testrun._collect_results（report.results[].results[评估器]），
    observe 行 = observe.evaluate_session（session_details[].results[评估器]）。
    """
    results = {ev: {"score": s, "passed": (s is not None and s >= 0.7), "errored": s is None}
               for ev, s in scores.items()}
    row = {"case": name, "results": results} if kind == "case" \
        else {"agent": "support-bot", "session_id": name, "results": results}
    if diagnosis is not None:
        row["diagnosis"] = diagnosis
    return row


class IssueEvaluators(unittest.TestCase):
    RUN1 = f"{PLAN_ID}#20260901090000"
    RUN2 = f"{PLAN_ID}#20260902090000"
    DIAG_A = {"failures": [], "root_causes": [rc(FIX_A, EXPLAIN_A)]}

    def setUp(self):
        import planrun
        self.planrun = planrun

    def test_seed_collects_evaluators_below_the_line_per_evidence_row_sorted_by_count(self):
        stages = [
            dataset_stage([
                row_with_scores("case-9", {"correctness": 0.2, "tone": 0.9, "faithfulness": 0.5}, self.DIAG_A),
                row_with_scores("case-4", {"correctness": 0.1, "tone": 0.3, "faithfulness": 0.8}, self.DIAG_A),
                row_with_scores("case-2", {"correctness": 0.95, "tone": 0.4, "faithfulness": 0.9}, self.DIAG_A),
            ]),
            observe_stage([
                row_with_scores("sess-a1", {"helpfulness": 0.4}, self.DIAG_A, kind="session"),
                row_with_scores("sess-b2", {"helpfulness": 0.1}, kind="session"),   # 无诊断 ⇒ 不是证据，不计
            ]),
        ]
        seeds = self.planrun._collect_issue_seeds(stages)
        self.assertEqual(len(seeds), 1)
        # correctness 2 次、tone 2 次（同次数按首见序）、faithfulness 1、helpfulness 1
        self.assertEqual(seeds[0]["evaluators"], ["correctness", "tone", "faithfulness", "helpfulness"])
        # 恰在目标线上（0.7）不算低于
        on_line = self.planrun._collect_issue_seeds([dataset_stage([
            row_with_scores("c", {"correctness": 0.7}, self.DIAG_A)])])
        self.assertEqual(on_line[0]["evaluators"], [])

    def test_rows_without_per_evaluator_scores_give_an_empty_list_not_null(self):
        stages = [dataset_stage([
            row_with_scores("c1", {"correctness": None}, self.DIAG_A),            # errored：score=None
            {"case": "c2", "diagnosis": self.DIAG_A},                             # 老形状：没有 results
            {"case": "c3", "results": {"correctness": {"score": "0.2"}}, "diagnosis": self.DIAG_A},  # 非数值
            {"case": "c4", "results": {"correctness": {"score": True}}, "diagnosis": self.DIAG_A},   # bool 不算分
        ])]
        seeds = self.planrun._collect_issue_seeds(stages)
        self.assertEqual(len(seeds), 1)
        self.assertEqual(seeds[0]["evaluators"], [])
        self.assertEqual(len(seeds[0]["evidence"]), 4)

    def test_evaluators_are_capped_at_six_by_count(self):
        many = {f"ev{i}": 0.1 for i in range(8)}
        rows = [row_with_scores("c1", many, self.DIAG_A),
                row_with_scores("c2", {"ev7": 0.2, "ev6": 0.2}, self.DIAG_A)]
        seeds = self.planrun._collect_issue_seeds([dataset_stage(rows)])
        evs = seeds[0]["evaluators"]
        self.assertEqual(len(evs), 6)
        self.assertEqual(evs[:2], ["ev6", "ev7"])   # 2 次的排前，同次数按首见序

    def test_new_issue_carries_evaluators_and_union_keeps_first_seen_order(self):
        seed1 = self.planrun._collect_issue_seeds([dataset_stage([
            row_with_scores("case-9", {"correctness": 0.2, "tone": 0.9}, self.DIAG_A)])])
        carried = self.planrun.aggregate_issues(self.RUN1, seed1, [], [])
        self.assertEqual(carried[0]["evaluators"], ["correctness"])
        # 同一用例再见（身份 = fix_type × 用例，措辞无关）；本次 tone 先见、两者同次数 ⇒ tone 排前
        seed2 = self.planrun._collect_issue_seeds([dataset_stage([
            row_with_scores("case-9", {"tone": 0.1, "correctness": 0.3}, self.DIAG_A)])])
        self.assertEqual(seed2[0]["evaluators"], ["tone", "correctness"])
        issues = self.planrun.aggregate_issues(self.RUN2, seed2, carried, [])
        # 并集保持首见序：台账里先有 correctness，再并入 tone
        self.assertEqual(issues[0]["evaluators"], ["correctness", "tone"])

    def test_carried_old_shape_without_evaluators_reads_as_empty_list(self):
        old = {"id": sha8(FIX_A), "problem": "旧句", "evidence": [{"kind": "case", "ref": "c"}],
               "root_cause": EXPLAIN_A, "recommendation": FIX_A, "fix_type": "SYSTEM_PROMPT_FIX",
               "first_seen_run": self.RUN1, "last_seen_run": self.RUN1, "occurrences": 1,
               "depends_on": [], "status": "open"}
        issues = self.planrun.aggregate_issues(self.RUN2, [], [old], [])
        self.assertEqual(issues[0]["evaluators"], [])
        # 读侧：老 run 落库的 JSON 里没有该键 ⇒ 读出 []（不是 null、不缺键）
        item = {"sk": self.RUN1, "synthesis_issues": json.dumps([old], ensure_ascii=False)}
        read = self.planrun._issues_from_item(item)
        self.assertEqual(read[0]["evaluators"], [])
        self.assertEqual(read[0]["problem"], "旧句")


if __name__ == "__main__":
    unittest.main()
