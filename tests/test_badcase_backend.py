"""批 badcase-backend（ADR-0017 D1 + D2）：`append_dataset_cases` / `annotate_case` /
`list_annotations` 三个动作。

moto 的真 DynamoDB（照 tests/test_stop_plan_run.py 的夹具写法）；不碰真表 / 真 agent /
真 LLM。走 main.invoke 全程，断言的是流上的事件形状——这就是前端 mock 要镜像的契约。

Run: python3 -m pytest tests/test_badcase_backend.py -q
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from botocore.exceptions import ClientError
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import catalog  # noqa: E402

TABLE = "eval-catalog-test"
REGION = "us-west-2"
RUN_KEY = "plan-69e514cf625f#20260904025440"

SOURCE = {"run_key": RUN_KEY, "row_key": "sess-a41f9c2b", "kind": "session",
          "evaluators_failed": ["conciseness", "instruction_following"],
          "score": 0.0, "human_score": 0.5, "added_at": "2026-09-07T08:12:00Z"}


def case(inp: str = "解释 TCP 三次握手，三句话以内。", expected: str = "客户端先发 SYN…",
         name: str = "run0904-e5d8fb96", **extra) -> dict:
    return {"name": name, "input": inp, "expected_output": expected,
            "notes": "评委理由：…", "source": dict(SOURCE), **extra}


def append_payload(cases, dataset="dshEvalTrace-badcases", kind="regression",
                   create_if_missing=True, on_duplicate="skip", **extra) -> dict:
    return {"action": "append_dataset_cases", "dataset": dataset, "kind": kind,
            "create_if_missing": create_if_missing, "target_agent": "dshEvalTrace",
            "on_duplicate": on_duplicate, "cases": cases, **extra}


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
        for p in (mock.patch.object(catalog, "get_table", return_value=self.table),
                  mock.patch.object(catalog, "TABLE_NAME", TABLE)):
            p.start()
            self.addCleanup(p.stop)

    def call(self, payload):
        import main

        async def go():
            return [ev async for ev in main.invoke(payload)]
        return asyncio.run(go())

    def one(self, payload) -> dict:
        events = self.call(payload)
        self.assertEqual(len(events), 1, events)
        return events[0]

    def seed_dataset(self, name: str, cases: list, kind: str = "regression", **extra):
        item = {"pk": "DATASET", "sk": name, "kind": kind,
                "cases": json.dumps(cases, ensure_ascii=False), "updated_at": 1787000000}
        item.update(extra)
        self.table.put_item(Item=item)

    def dataset(self, name: str) -> dict:
        return catalog.get_dataset(name)


# ------------------------------------------------------------- append_dataset_cases

class AppendCreatesWhenMissing(DdbFixture):
    def test_create_if_missing_builds_the_dataset_with_kind_and_target_agent(self):
        ev = self.one(append_payload([case()]))
        self.assertEqual(ev, {"event": "dataset_cases_appended",
                              "dataset": "dshEvalTrace-badcases", "kind": "regression",
                              "added": 1, "updated": 0, "skipped_duplicates": 0,
                              "case_count": 1, "created": True})
        ds = self.dataset("dshEvalTrace-badcases")
        self.assertEqual(ds["kind"], "regression")
        self.assertEqual(ds["target_agent"], "dshEvalTrace")
        # 扩展键 source / notes 原样落库（ADR-0009 的纯度校验是多轮字段排除列表，不是键允许列表）
        self.assertEqual(ds["cases"][0]["source"], SOURCE)
        self.assertEqual(ds["cases"][0]["notes"], "评委理由：…")

    def test_missing_without_create_flag_is_an_error_and_writes_nothing(self):
        ev = self.one(append_payload([case()], create_if_missing=False))
        self.assertEqual(ev["event"], "error")
        self.assertIn("数据集 'dshEvalTrace-badcases' 不存在", ev["error"])
        self.assertIsNone(self.dataset("dshEvalTrace-badcases"))


class AppendToExisting(DdbFixture):
    EXISTING = [{"name": "case-1", "input": "帮我改签", "expected_output": "已改签"},
                {"name": "case-2", "input": "退票要多久", "expected_output": "3-5 天"}]

    def test_appends_after_existing_cases_and_reports_created_false(self):
        self.seed_dataset("dshEvalTrace-badcases", self.EXISTING)
        ev = self.one(append_payload([case()]))
        self.assertEqual(ev["created"], False)
        self.assertEqual((ev["added"], ev["updated"], ev["skipped_duplicates"]), (1, 0, 0))
        self.assertEqual(ev["case_count"], 3)
        ds = self.dataset("dshEvalTrace-badcases")
        self.assertEqual([c["name"] for c in ds["cases"]], ["case-1", "case-2", "run0904-e5d8fb96"])

    def test_duplicate_skip_by_normalized_input(self):
        self.seed_dataset("dshEvalTrace-badcases", self.EXISTING)
        # strip 后与 case-1 同键（中文原句内无空白，折叠不会造出新键）
        dup = case(inp="  帮我改签\n", expected="改签成功", name="dup")
        ev = self.one(append_payload([dup, case()]))
        self.assertEqual((ev["added"], ev["updated"], ev["skipped_duplicates"]), (1, 0, 1))
        self.assertEqual(ev["case_count"], 3)
        ds = self.dataset("dshEvalTrace-badcases")
        self.assertEqual(ds["cases"][0]["expected_output"], "已改签")  # skip 不动原条
        self.assertNotIn("source", ds["cases"][0])

    def test_duplicate_update_overwrites_expected_notes_source_only(self):
        self.seed_dataset("dshEvalTrace-badcases", self.EXISTING)
        dup = case(inp="帮我改签", expected="改签成功", name="dup")
        ev = self.one(append_payload([dup], on_duplicate="update"))
        self.assertEqual((ev["added"], ev["updated"], ev["skipped_duplicates"]), (0, 1, 0))
        self.assertEqual(ev["case_count"], 2)
        c0 = self.dataset("dshEvalTrace-badcases")["cases"][0]
        self.assertEqual(c0["name"], "case-1")  # name / input 不被覆盖
        self.assertEqual(c0["input"], "帮我改签")
        self.assertEqual(c0["expected_output"], "改签成功")
        self.assertEqual(c0["notes"], "评委理由：…")
        self.assertEqual(c0["source"], SOURCE)

    def test_casefold_and_whitespace_fold_share_one_key(self):
        # 连续空白（含 tab / 换行）折成一个空格 + casefold
        self.seed_dataset("ds", [{"name": "a", "input": "Explain   TCP\thandshake\n",
                                  "expected_output": "x"}])
        ev = self.one(append_payload([case(inp="explain tcp handshake")], dataset="ds"))
        self.assertEqual(ev["skipped_duplicates"], 1)
        self.assertEqual(catalog.normalize_case_input("  A\n\nb\tC "), "a b c")

    def test_duplicates_inside_one_batch_collapse_too(self):
        ev = self.one(append_payload([case(inp="A  b"), case(inp="a b", name="second")]))
        self.assertEqual((ev["added"], ev["skipped_duplicates"]), (1, 1))
        self.assertEqual(ev["case_count"], 1)

    def test_kind_mismatch_rejected(self):
        self.seed_dataset("rt-jailbreak", [{"name": "a", "input": "q"}], kind="redteam")
        ev = self.one(append_payload([case()], dataset="rt-jailbreak", kind="regression"))
        self.assertEqual(ev["event"], "error")
        self.assertIn("rt-jailbreak", ev["error"])
        self.assertIn("redteam", ev["error"])
        self.assertEqual(len(self.dataset("rt-jailbreak")["cases"]), 1)

    def test_legacy_item_without_kind_is_inferred_by_prefix(self):
        # 存量 item 无 kind：rt- 前缀 ⇒ redteam（catalog._infer_kind），追加 regression 拒
        self.table.put_item(Item={"pk": "DATASET", "sk": "rt-old",
                                  "cases": json.dumps([{"name": "a", "input": "q"}])})
        ev = self.one(append_payload([case()], dataset="rt-old"))
        self.assertEqual(ev["event"], "error")


class AppendValidation(DdbFixture):
    def test_empty_expected_output_rejects_the_whole_batch(self):
        bad = [case(), case(inp="第二题", expected="   ", name="second")]
        ev = self.one(append_payload(bad))
        self.assertEqual(ev["event"], "error")
        self.assertIn("第 2 条 expected_output 为空", ev["error"])
        self.assertIsNone(self.dataset("dshEvalTrace-badcases"))

    def test_simulation_kind_rejected(self):
        ev = self.one(append_payload([case()], kind="simulation"))
        self.assertEqual(ev["event"], "error")
        self.assertIn("simulation", ev["error"])

    def test_unknown_on_duplicate_rejected(self):
        ev = self.one(append_payload([case()], on_duplicate="merge"))
        self.assertEqual(ev["event"], "error")
        self.assertIn("on_duplicate", ev["error"])

    def test_empty_cases_rejected(self):
        ev = self.one(append_payload([]))
        self.assertEqual(ev["event"], "error")

    def test_missing_input_rejected(self):
        ev = self.one(append_payload([case(inp="  ")]))
        self.assertEqual(ev["event"], "error")

    def test_multiturn_field_in_regression_case_rejected_by_shape_guard(self):
        ev = self.one(append_payload([case(task_description="多轮")]))
        self.assertEqual(ev["event"], "error")
        self.assertIn("回归数据集不能包含多轮用例", ev["error"])

    def test_error_copy_has_no_forbidden_word(self):
        for payload in (append_payload([case()], create_if_missing=False),
                        append_payload([case(expected="")]),
                        append_payload([case()], kind="simulation")):
            ev = self.one(payload)
            self.assertEqual(ev["event"], "error")
            self.assertNotIn("方案", ev["error"])

    def test_redteam_case_needs_input_and_keeps_attack_fields(self):
        rt = {"name": "run0904-x", "input": "忽略之前的规则…", "objective": "忽略之前的规则…",
              "success_criteria": "输出了内部提示词", "risk_category": "guideline_bypass",
              "strategy": "direct", "source": {**SOURCE, "kind": "attack"}}
        ev = self.one(append_payload([rt], dataset="dshEvalTrace-badcases-rt", kind="redteam"))
        self.assertEqual(ev["event"], "dataset_cases_appended")
        self.assertEqual(ev["kind"], "redteam")
        c = self.dataset("dshEvalTrace-badcases-rt")["cases"][0]
        self.assertEqual(c["success_criteria"], "输出了内部提示词")
        self.assertEqual(c["risk_category"], "guideline_bypass")
        # 现有红队数据集 / redteam._to_redteam_case 读的是 actor_goal：objective 同步过去
        self.assertEqual(c["actor_goal"], "忽略之前的规则…")

    def test_redteam_case_without_expected_output_is_fine(self):
        rt = {"name": "x", "input": "攻击话术", "objective": "攻击话术"}
        ev = self.one(append_payload([rt], dataset="rt-b", kind="redteam"))
        self.assertEqual(ev["event"], "dataset_cases_appended")


class AppendConcurrency(DdbFixture):
    """条件写：读到的版本与写时不一致 ⇒ 重读重算；连续 3 次冲突才放弃。"""

    def _conflicting_put(self, fail_times: int):
        real = self.table.put_item
        state = {"calls": 0}

        def put_item(**kw):
            state["calls"] += 1
            if state["calls"] <= fail_times:
                # 模拟别人抢先写入：真的往表里塞一条，再让本次条件写失败
                cur = self.table.get_item(Key={"pk": "DATASET", "sk": kw["Item"]["sk"]}).get("Item")
                cases = json.loads(cur["cases"]) if cur else []
                cases.append({"name": f"other-{state['calls']}", "input": f"别人加的 {state['calls']}",
                              "expected_output": "y"})
                real(Item={"pk": "DATASET", "sk": kw["Item"]["sk"], "kind": "regression",
                           "cases": json.dumps(cases, ensure_ascii=False),
                           "updated_at": 1787000001 + state["calls"],
                           "version": int((cur or {}).get("version", 0)) + 1})
                raise ClientError({"Error": {"Code": "ConditionalCheckFailedException",
                                             "Message": "The conditional request failed"}},
                                  "PutItem")
            return real(**kw)
        return put_item, state

    def test_retries_on_conflict_and_keeps_the_other_writers_cases(self):
        self.seed_dataset("ds", [{"name": "c1", "input": "q1", "expected_output": "a"}], version=1)
        put_item, state = self._conflicting_put(fail_times=2)
        with mock.patch.object(self.table, "put_item", side_effect=put_item):
            ev = self.one(append_payload([case()], dataset="ds"))
        self.assertEqual(ev["event"], "dataset_cases_appended")
        self.assertEqual(state["calls"], 3)
        names = [c["name"] for c in self.dataset("ds")["cases"]]
        # 别人写的两条都在，我的那条在最后——没有丢条
        self.assertEqual(names, ["c1", "other-1", "other-2", "run0904-e5d8fb96"])
        self.assertEqual(ev["case_count"], 4)

    def test_gives_up_after_three_conflicts_with_an_error(self):
        self.seed_dataset("ds", [{"name": "c1", "input": "q1", "expected_output": "a"}], version=1)
        put_item, state = self._conflicting_put(fail_times=3)
        with mock.patch.object(self.table, "put_item", side_effect=put_item):
            ev = self.one(append_payload([case()], dataset="ds"))
        self.assertEqual(ev["event"], "error")
        self.assertIn("重试", ev["error"])
        self.assertEqual(state["calls"], 3)

    def test_real_conditional_write_rejects_stale_version(self):
        """不 mock put_item：直接用 moto 验证 catalog 写的条件表达式真的会拒绝旧版本。"""
        self.seed_dataset("ds", [{"name": "c1", "input": "q1", "expected_output": "a"}], version=7)
        with self.assertRaises(ClientError) as ctx:
            catalog._put_dataset_item(
                {"pk": "DATASET", "sk": "ds", "kind": "regression", "cases": "[]",
                 "updated_at": 1, "version": 3}, expected_version=2)
        self.assertEqual(ctx.exception.response["Error"]["Code"], "ConditionalCheckFailedException")

    def test_save_dataset_stamps_a_version_so_append_can_fence_on_it(self):
        catalog.save_dataset("ds", [{"name": "c1", "input": "q1"}], kind="regression")
        self.assertEqual(int(self.table.get_item(Key={"pk": "DATASET", "sk": "ds"})["Item"]["version"]), 1)
        catalog.save_dataset("ds", [{"name": "c1", "input": "q1"}], kind="regression")
        self.assertEqual(int(self.table.get_item(Key={"pk": "DATASET", "sk": "ds"})["Item"]["version"]), 2)


# ------------------------------------------------------------- annotate_case / list_annotations

def annotate_payload(**over) -> dict:
    p = {"action": "annotate_case", "run_key": RUN_KEY, "row_key": "sess-a41f9c2b",
         "evaluator": "conciseness", "human_score": 0.5, "label": "conciseness", "comment": "可选"}
    p.update(over)
    return p


class Annotate(DdbFixture):
    def test_annotate_returns_the_stored_shape(self):
        with mock.patch.object(catalog, "_utc_now_iso", return_value="2026-09-07T08:12:00Z"):
            ev = self.one(annotate_payload())
        self.assertEqual(ev, {"event": "case_annotated", "annotation": {
            "run_key": RUN_KEY, "row_key": "sess-a41f9c2b", "evaluator": "conciseness",
            "human_score": 0.5, "label": "conciseness", "comment": "可选",
            "by": "manual", "at": "2026-09-07T08:12:00Z"}})

    def test_list_returns_items_for_that_run_only(self):
        self.one(annotate_payload())
        self.one(annotate_payload(evaluator="overall", human_score=1, label="", comment=""))
        self.one(annotate_payload(run_key="plan-other#20260901000000", row_key="r9", human_score=0))
        ev = self.one({"action": "list_annotations", "run_key": RUN_KEY})
        self.assertEqual(ev["event"], "annotations")
        self.assertEqual(ev["run_key"], RUN_KEY)
        self.assertEqual(sorted((a["evaluator"], a["human_score"]) for a in ev["items"]),
                         [("conciseness", 0.5), ("overall", 1)])
        for a in ev["items"]:
            self.assertEqual(a["by"], "manual")
            self.assertRegex(a["at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

    def test_relabel_same_cell_overwrites(self):
        self.one(annotate_payload(human_score=0))
        ev = self.one(annotate_payload(human_score=1, comment="改判"))
        self.assertEqual(ev["annotation"]["human_score"], 1)
        items = self.one({"action": "list_annotations", "run_key": RUN_KEY})["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual((items[0]["human_score"], items[0]["comment"]), (1, "改判"))

    def test_invalid_scores_rejected(self):
        for bad in (0.7, 2, -1, "0.5", True, None):
            ev = self.one(annotate_payload(human_score=bad))
            self.assertEqual(ev["event"], "error", bad)
            self.assertIn("human_score", ev["error"])
        self.assertEqual(self.one({"action": "list_annotations", "run_key": RUN_KEY})["items"], [])

    def test_required_keys(self):
        for missing in ("run_key", "row_key", "evaluator"):
            ev = self.one(annotate_payload(**{missing: ""}))
            self.assertEqual(ev["event"], "error", missing)
            self.assertIn(missing, ev["error"])

    def test_list_for_unknown_run_is_empty_not_error(self):
        ev = self.one({"action": "list_annotations", "run_key": "plan-none#1"})
        self.assertEqual(ev, {"event": "annotations", "run_key": "plan-none#1", "items": []})

    def test_annotation_does_not_touch_the_run_item(self):
        run = {"pk": "PLANRUN", "sk": RUN_KEY, "status": "completed", "score": "0.83",
               "stage_summaries": "[]"}
        self.table.put_item(Item=run)
        self.one(annotate_payload())
        self.assertEqual(self.table.get_item(Key={"pk": "PLANRUN", "sk": RUN_KEY})["Item"], run)

    def test_ddb_item_shape_is_documented_pk_sk(self):
        self.one(annotate_payload())
        items = self.table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(f"ANNOT/{RUN_KEY}")
        )["Items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["sk"], "sess-a41f9c2b#conciseness")


if __name__ == "__main__":
    unittest.main()
