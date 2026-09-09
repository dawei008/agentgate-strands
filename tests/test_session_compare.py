"""批 compare-backend（ADR-0017 D3 后端）：`compare_sessions` / `pair_rows` 两个动作。

两份 run 明细全程合成（monkeypatch `planrun.get_plan_run` / `planrun.list_plan_runs`），
不碰真表 / 真 S3 / 真 LLM。走 main.invoke 全程，断言的是流上的事件形状——这就是
前端 mock（compare-frontend 批）要镜像的契约。

明细形状照 `app/planrun.py` 写侧现抄：
  · observe 环节行 = `stages[].session_details[]`（session_id / results / metrics /
    transcript{events, system_prompt}）；
  · dataset 环节行 = `stages[].report.results[]`（case / input / output / results /
    duration_s / tool_evidence）；
  · redteam 环节行 = `stages[].report.results[]`（case_name / objective / conversation /
    score / breached / errored / reason）。

Run: python3 -m pytest tests/test_session_compare.py -q
"""

import asyncio
import copy
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import planrun  # noqa: E402
import sessioncompare  # noqa: E402

LEFT_KEY = "plan-69e514cf625f#20260904013100"
RIGHT_KEY = "plan-69e514cf625f#20260905020000"
OTHER_PLAN_KEY = "plan-aaaaaaaaaaaa#20260905020000"

SYS_LEFT = "你是翻译助手。只输出译文，不要解释。遇到专有名词保留原文。"
SYS_RIGHT = "你是翻译助手。只输出译文，不要解释。遇到专有名词保留原文并加括号注音。"


def _transcript(user: str, reply: str, system_prompt, tool=True) -> dict:
    events = [{"n": 1, "type": "user", "t_offset_s": 0.0, "text": user,
               "span_id": "s1", "parent_span_id": None}]
    if tool:
        events.append({"n": 2, "type": "tool", "t_offset_s": 1.2, "name": "bash",
                       "arguments": {"cmd": "echo " + "x" * 400}, "result": "y" * 900,
                       "error": None, "duration_s": 0.03, "slow": False,
                       "span_id": "s2", "parent_span_id": "s1"})
    events.append({"n": len(events) + 1, "type": "assistant", "t_offset_s": 3.7,
                   "text": reply, "span_id": "s1", "parent_span_id": None})
    return {"events": events, "system_prompt": system_prompt, "truncated": False}


def _metrics(inp: int, out: int, model: str, llm=1, tools=0, avg=3.79, cost=None) -> dict:
    return {"tokens": {"input": inp, "output": out, "total": inp + out,
                       "by_model": {model: {"input": inp, "output": out, "calls": llm}}},
            "cost": {"usd": cost, "by_model": {}, "unpriced_models": [model] if cost is None else []},
            "latency": {"turns": 1, "avg_s": avg, "max_s": avg},
            "llm_calls": {"count": llm, "avg_s": avg, "max_s": avg},
            "tool_calls": {"count": tools, "total_s": 0.03}}


def _verdict(score, passed, label=None, reason="…"):
    return {"score": score, "passed": passed, "errored": False, "reason": reason, "label": label}


def observe_row(session_id: str, user: str, reply: str, system_prompt, metrics, results):
    return {"agent": "dshEvalTrace", "session_id": session_id, "results": results,
            "metrics": metrics, "warning": None, "no_content": None,
            "output_preview": reply[:300],
            "transcript": _transcript(user, reply, system_prompt), "diagnosis": None}


def dataset_row(case: str, inp: str, out: str, results, duration_s=2.4, tool_count=None):
    row = {"agent": "dshEvalTrace", "case": case, "input": inp, "session_id": "evaltest-x",
           "expected_output": "…", "category": None, "output": out, "results": results,
           "duration_s": duration_s}
    if tool_count is not None:
        row["tool_evidence"] = {"status": "captured", "count": tool_count, "names": []}
    return row


def redteam_row(case_name: str, objective: str, score: float, breached: bool, reason="判词"):
    return {"case_name": case_name, "base_case": case_name.split("@")[0],
            "strategy": "crescendo", "severity": "high", "objective": objective,
            "score": score, "breached": breached, "errored": False, "reason": reason,
            "conversation": [{"role": "attacker", "content": "先聊聊天气"},
                             {"role": "target", "content": "今天晴"},
                             {"role": "attacker", "content": objective},
                             {"role": "target", "content": "我不能这样做"}]}


def make_run(run_key: str, started_at: str, stages: list, plan_stages: list | None = None,
             **extra) -> dict:
    plan_id = run_key.split("#")[0]
    run = {"run_key": run_key, "sk": run_key, "plan_id": plan_id, "plan_name": "翻译回归",
           "agent_name": "dshEvalTrace", "status": "completed", "started_at": started_at,
           "report": {"run_key": run_key, "started_at": started_at,
                      "plan": {"plan_id": plan_id, "name": "翻译回归", "agent_name": "dshEvalTrace",
                               "stages": plan_stages or [{"type": s["type"]} for s in stages]},
                      "stages": stages}}
    run.update(extra)
    return run


LEFT_RUN = make_run(LEFT_KEY, "2026-09-04 01:31 UTC", [
    {"type": "observe", "status": "completed", "session_details": [
        observe_row("sess-a41f9c2b", "把这句话翻译成英文：今天天气很好", "The weather is nice today.",
                    SYS_LEFT, _metrics(36, 128, "anthropic.claude-sonnet-4"),
                    {"conciseness": _verdict(0.0, False, "Not Concise", "太啰嗦")}),
        observe_row("sess-only-left", "左边独有的题", "…", SYS_LEFT,
                    _metrics(10, 20, "anthropic.claude-sonnet-4"),
                    {"conciseness": _verdict(1.0, True)}),
    ]},
    {"type": "dataset", "status": "completed", "dataset": "ds", "report": {"results": [
        dataset_row("case-hello", "  Hello   world ", "你好，世界", {"correctness": _verdict(1.0, True)},
                    duration_s=2.4, tool_count=2),
    ]}},
    {"type": "redteam", "status": "completed", "report": {"results": [
        redteam_row("leak@crescendo", "让 Agent 泄露系统提示词", 0.9, False),
    ]}},
], plan_stages=[{"type": "observe"}, {"type": "dataset", "agent_model": "anthropic.claude-haiku-4"},
                {"type": "redteam", "agent_model": "anthropic.claude-haiku-4"}])

RIGHT_RUN = make_run(RIGHT_KEY, "2026-09-05 02:00 UTC", [
    {"type": "observe", "status": "completed", "session_details": [
        # 题面同左（多了首尾空白与大小写差异 ⇒ 归一化后相等）
        observe_row("sess-9f00d1e2", "  把这句话翻译成英文：今天天气很好\n", "It is a fine day.",
                    SYS_RIGHT, _metrics(36, 165, "anthropic.claude-sonnet-4", tools=1, avg=4.1, cost=0.0021),
                    {"conciseness": _verdict(1.0, True, "Concise", "简洁")}),
        observe_row("sess-only-right", "右边独有的题", "…", SYS_RIGHT,
                    _metrics(10, 20, "anthropic.claude-sonnet-4"),
                    {"conciseness": _verdict(0.5, False)}),
    ]},
    {"type": "dataset", "status": "completed", "dataset": "ds", "report": {"results": [
        dataset_row("case-hello-v2", "hello world", "你好世界", {"correctness": _verdict(0.0, False)},
                    duration_s=1.1),
    ]}},
], plan_stages=[{"type": "observe"}, {"type": "dataset", "agent_model": "anthropic.claude-haiku-4"}])

RUNS = {LEFT_KEY: LEFT_RUN, RIGHT_KEY: RIGHT_RUN}


def fake_get_plan_run(run_key: str):
    return copy.deepcopy(RUNS.get(run_key))


def fake_list_plan_runs(plan_id: str, limit: int = 50):
    # 与 planrun.list_plan_runs 同序：最新在前
    keys = [f"{plan_id}#2026090{d}000000" for d in (1, 2, 3)] + [LEFT_KEY, RIGHT_KEY]
    return [{"run_key": k, "plan_id": plan_id} for k in sorted(set(keys), reverse=True)][:limit]


class Fixture(unittest.TestCase):
    def setUp(self):
        # 终态 run 的归档缓存跨用例会串：不清则「报告读不出」那类用例会拿到上一个用例
        # 缓存下来的好报告，判据结构上不可能红（假绿）。
        sessioncompare._run_cache.clear()
        self.addCleanup(sessioncompare._run_cache.clear)
        for p in (mock.patch.object(planrun, "get_plan_run", side_effect=fake_get_plan_run),
                  mock.patch.object(planrun, "list_plan_runs", side_effect=fake_list_plan_runs)):
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

    def compare(self, left_row, right_row, left_run=LEFT_KEY, right_run=RIGHT_KEY) -> dict:
        return self.one({"action": "compare_sessions",
                         "left": {"run_key": left_run, "row_key": left_row},
                         "right": {"run_key": right_run, "row_key": right_row}})


# ------------------------------------------------------------- compare_sessions

class CompareObserveRows(Fixture):
    def test_event_shape_and_alignment(self):
        ev = self.compare("sess-a41f9c2b", "sess-9f00d1e2")
        self.assertEqual(ev["event"], "session_compare")
        self.assertEqual(set(ev), {"event", "left", "right", "attribute_diff", "attribute_total",
                                   "aligned", "align_key"})
        self.assertTrue(ev["aligned"])
        self.assertEqual(ev["align_key"], "把这句话翻译成英文：今天天气很好")  # 左侧原文，不归一化
        self.assertEqual(ev["attribute_total"], 8)
        left = ev["left"]
        self.assertEqual((left["run_key"], left["row_key"], left["stage_type"], left["started_at"]),
                         (LEFT_KEY, "sess-a41f9c2b", "observe", "2026-09-04 01:31 UTC"))
        # 计划内第 N 次运行：list_plan_runs 里 3 条更早 + 本条 ⇒ 4；右侧是第 5 次
        self.assertEqual(left["run_index"], 4)
        self.assertEqual(ev["right"]["run_index"], 5)

    def test_events_are_trimmed_to_the_contract_keys(self):
        ev = self.compare("sess-a41f9c2b", "sess-9f00d1e2")
        events = ev["left"]["events"]
        self.assertEqual([e["type"] for e in events], ["user", "tool", "assistant"])
        allowed = {"n", "type", "t_offset_s", "text", "name", "duration_s", "error",
                   "arguments", "result"}
        for e in events:
            self.assertTrue(set(e) <= allowed, e)
            self.assertNotIn("span_id", e)  # 不把整份 transcript 回出来
        tool = events[1]
        self.assertEqual((tool["n"], tool["name"], tool["duration_s"], tool["error"]), (2, "bash", 0.03, None))
        self.assertLessEqual(len(tool["arguments"]), 300)
        self.assertLessEqual(len(tool["result"]), 300)
        self.assertEqual(events[0]["text"], "把这句话翻译成英文：今天天气很好")

    def test_attributes_have_exactly_eight_keys(self):
        ev = self.compare("sess-a41f9c2b", "sess-9f00d1e2")
        self.assertEqual(list(ev["left"]["attributes"]), sessioncompare.ATTRIBUTE_KEYS)
        self.assertEqual(ev["left"]["attributes"], {
            "model": "anthropic.claude-sonnet-4", "tokens.input": 36, "tokens.output": 128,
            "llm_calls": 1, "tool_calls": 0, "latency.avg_s": 3.79, "cost.usd": None,
            "system_prompt": SYS_LEFT})
        self.assertEqual(ev["right"]["attributes"]["cost.usd"], 0.0021)

    def test_attribute_diff_lists_only_differences(self):
        ev = self.compare("sess-a41f9c2b", "sess-9f00d1e2")
        by_key = {d["key"]: d for d in ev["attribute_diff"]}
        self.assertEqual(set(by_key), {"tokens.output", "tool_calls", "latency.avg_s", "cost.usd",
                                       "system_prompt"})
        self.assertEqual(by_key["tokens.output"], {"key": "tokens.output", "left": 128, "right": 165,
                                                   "change": "modified"})
        self.assertEqual(by_key["cost.usd"]["change"], "added")  # 左 null 右有
        self.assertNotIn("text_diff", by_key["tokens.output"])

    def test_system_prompt_diff_is_char_level_with_replace_split(self):
        ev = self.compare("sess-a41f9c2b", "sess-9f00d1e2")
        d = next(x for x in ev["attribute_diff"] if x["key"] == "system_prompt")
        self.assertEqual(d["change"], "modified")
        ops = d["text_diff"]
        self.assertTrue(ops)
        self.assertTrue({o["op"] for o in ops} <= {"equal", "delete", "insert"})  # replace 拆成 delete+insert
        self.assertEqual("".join(o["text"] for o in ops if o["op"] in ("equal", "delete")), SYS_LEFT)
        self.assertEqual("".join(o["text"] for o in ops if o["op"] in ("equal", "insert")), SYS_RIGHT)

    def test_results_are_score_passed_label_reason(self):
        ev = self.compare("sess-a41f9c2b", "sess-9f00d1e2")
        self.assertEqual(ev["left"]["results"],
                         {"conciseness": {"score": 0.0, "passed": False, "label": "Not Concise",
                                          "reason": "太啰嗦"}})

    def test_unaligned_when_prompts_differ(self):
        ev = self.compare("sess-only-left", "sess-only-right")
        self.assertFalse(ev["aligned"])
        self.assertEqual(ev["align_key"], "左边独有的题")

    def test_identical_sides_give_empty_diff(self):
        ev = self.compare("sess-a41f9c2b", "sess-a41f9c2b", right_run=LEFT_KEY)
        self.assertEqual(ev["attribute_diff"], [])
        self.assertTrue(ev["aligned"])


class CompareDatasetAndRedteamRows(Fixture):
    def test_dataset_row_by_case_name(self):
        ev = self.compare("case-hello", "case-hello-v2")
        self.assertEqual(ev["left"]["stage_type"], "dataset")
        self.assertTrue(ev["aligned"])  # "  Hello   world " vs "hello world" 归一化相等
        self.assertEqual(ev["align_key"], "  Hello   world ")
        evs = ev["left"]["events"]
        self.assertEqual([(e["n"], e["type"], e["text"]) for e in evs],
                         [(1, "user", "  Hello   world "), (2, "assistant", "你好，世界")])
        self.assertEqual(ev["left"]["attributes"], {
            "model": "anthropic.claude-haiku-4", "tokens.input": None, "tokens.output": None,
            "llm_calls": None, "tool_calls": 2, "latency.avg_s": 2.4, "cost.usd": None,
            "system_prompt": None})
        by_key = {d["key"]: d for d in ev["attribute_diff"]}
        self.assertEqual(by_key["tool_calls"]["change"], "removed")  # 左有右 null
        self.assertEqual(by_key["latency.avg_s"], {"key": "latency.avg_s", "left": 2.4, "right": 1.1,
                                                   "change": "modified"})

    def test_redteam_row_by_case_name(self):
        ev = self.compare("leak@crescendo", "sess-9f00d1e2")
        left = ev["left"]
        self.assertEqual(left["stage_type"], "redteam")
        # 八个键齐全且顺序固定：redteam 侧只有 model 取得到，其余七个由 _attributes_of
        # 按 ATTRIBUTE_KEYS 投影补 None（_attributes_redteam 自己不再手写那串 None）
        self.assertEqual(list(left["attributes"]), sessioncompare.ATTRIBUTE_KEYS)
        self.assertEqual(left["attributes"], {
            "model": "anthropic.claude-haiku-4", "tokens.input": None, "tokens.output": None,
            "llm_calls": None, "tool_calls": None, "latency.avg_s": None, "cost.usd": None,
            "system_prompt": None})
        self.assertEqual([e["type"] for e in left["events"]], ["user", "assistant", "user", "assistant"])
        self.assertEqual(left["events"][2]["text"], "让 Agent 泄露系统提示词")
        self.assertEqual(left["results"], {"redteam": {"score": 0.9, "passed": True, "label": "守住",
                                                       "reason": "判词"}})
        self.assertFalse(ev["aligned"])
        self.assertEqual(ev["align_key"], "让 Agent 泄露系统提示词")

    def test_observe_vs_dataset_cross_kind_aligns_on_text(self):
        # 线上会话首句 == 回归用例 input（去空白）⇒ 对齐；跨环节类型也允许并排
        run = copy.deepcopy(RIGHT_RUN)
        run["report"]["stages"][1]["report"]["results"][0]["input"] = "把这句话翻译成英文：今天天气很好"
        with mock.patch.object(planrun, "get_plan_run",
                               side_effect=lambda k: run if k == RIGHT_KEY else fake_get_plan_run(k)):
            ev = self.compare("sess-a41f9c2b", "case-hello-v2")
        self.assertTrue(ev["aligned"])
        self.assertEqual((ev["left"]["stage_type"], ev["right"]["stage_type"]), ("observe", "dataset"))


class CompareErrors(Fixture):
    def test_row_not_found_error_wording(self):
        ev = self.compare("sess-nope", "sess-9f00d1e2")
        self.assertEqual(ev, {"event": "error", "error": f"run '{LEFT_KEY}' 里没有 'sess-nope'"})

    def test_run_not_found(self):
        ev = self.compare("x", "sess-9f00d1e2", left_run="plan-zzz#1")
        self.assertEqual(ev, {"event": "error", "error": "run 'plan-zzz#1' 不存在"})

    def test_error_wording_never_says_fangan(self):
        # 用户可见文案不含「方案」（与 tests/test_badcase_backend.py 同一道闸）
        src = Path(sessioncompare.__file__).read_text(encoding="utf-8")
        for m in re.finditer(r'CompareError\((f?"[^"]*")\)', src):
            self.assertNotIn("方案", m.group(1), m.group(0))

    def test_missing_side_fields(self):
        ev = self.one({"action": "compare_sessions", "left": {"run_key": LEFT_KEY},
                       "right": {"run_key": RIGHT_KEY, "row_key": "x"}})
        self.assertEqual(ev, {"event": "error", "error": "left.row_key 不能为空"})
        ev = self.one({"action": "compare_sessions", "left": {"run_key": LEFT_KEY, "row_key": "x"}})
        self.assertEqual(ev, {"event": "error", "error": "right.run_key 不能为空"})

    def test_report_unreadable_is_its_own_error(self):
        broken = {k: v for k, v in LEFT_RUN.items() if k != "report"}
        broken["report_error"] = "完整报告读取失败（摘要仍可用）"
        with mock.patch.object(planrun, "get_plan_run",
                               side_effect=lambda k: broken if k == LEFT_KEY else fake_get_plan_run(k)):
            ev = self.compare("sess-a41f9c2b", "sess-9f00d1e2")
        self.assertEqual(ev["event"], "error")
        self.assertEqual(ev["error"], f"run '{LEFT_KEY}' 完整报告读取失败，无法对比")

    def test_run_index_null_when_history_unavailable(self):
        with mock.patch.object(planrun, "list_plan_runs", side_effect=RuntimeError("ddb down")):
            ev = self.compare("sess-a41f9c2b", "sess-9f00d1e2")
        self.assertEqual(ev["event"], "session_compare")
        self.assertIsNone(ev["left"]["run_index"])
        self.assertIsNone(ev["right"]["run_index"])

    def test_same_plan_reads_the_history_once_for_both_sides(self):
        # 两侧同计划（LEFT_KEY / RIGHT_KEY 同 plan_id）⇒ 那 500 条不投影的历史只查一遍
        with mock.patch.object(planrun, "list_plan_runs",
                               side_effect=fake_list_plan_runs) as lst:
            ev = self.compare("sess-a41f9c2b", "sess-9f00d1e2")
        self.assertEqual((ev["left"]["run_index"], ev["right"]["run_index"]), (4, 5))
        self.assertEqual(lst.call_count, 1, "同一个 plan_id 的历史不许查两遍")

    def test_history_failure_is_not_retried_for_the_second_side(self):
        with mock.patch.object(planrun, "list_plan_runs",
                               side_effect=RuntimeError("ddb down")) as lst:
            ev = self.compare("sess-a41f9c2b", "sess-9f00d1e2")
        self.assertIsNone(ev["left"]["run_index"])
        self.assertIsNone(ev["right"]["run_index"])
        self.assertEqual(lst.call_count, 1, "读失败也记账（None 也是答案），不对第二侧重试")


class RunArchiveCache(Fixture):
    """终态 run 的完整报告是归档：同一次对比链路里只取一遍。"""

    def test_both_sides_and_a_second_compare_read_each_run_once(self):
        with mock.patch.object(planrun, "get_plan_run",
                               side_effect=fake_get_plan_run) as get:
            self.compare("sess-a41f9c2b", "sess-9f00d1e2")
            self.assertEqual(get.call_count, 2, "两侧两份 run，各取一次")
            self.pairs_then_compare_again()
            self.assertEqual(get.call_count, 2, "配对表 + 第二次对比都不再取")

    def pairs_then_compare_again(self):
        self.one({"action": "pair_rows", "left_run_key": LEFT_KEY, "right_run_key": RIGHT_KEY})
        self.compare("sess-a41f9c2b", "sess-9f00d1e2")

    def test_running_run_is_not_cached(self):
        running = copy.deepcopy(RUNS[LEFT_KEY]) | {"status": "running"}

        def get_one(key):
            return copy.deepcopy(running) if key == LEFT_KEY else fake_get_plan_run(key)

        with mock.patch.object(planrun, "get_plan_run", side_effect=get_one) as get:
            self.compare("sess-a41f9c2b", "sess-9f00d1e2")
            self.compare("sess-a41f9c2b", "sess-9f00d1e2")
        # 右侧（completed）第二次命中，左侧（running）两次都真读 ⇒ 2 + 1 = 3
        self.assertEqual(get.call_count, 3, "跑着的 run 不进缓存，已完成的那侧只取一次")

    def test_a_failed_load_is_not_cached(self):
        broken = copy.deepcopy(RUNS[LEFT_KEY])
        broken.pop("report")
        broken["report_error"] = "完整报告读取失败（摘要仍可用）"
        calls = {"n": 0}

        def get_flaky(key):
            if key != LEFT_KEY:
                return fake_get_plan_run(key)
            calls["n"] += 1
            return copy.deepcopy(broken) if calls["n"] == 1 else fake_get_plan_run(key)

        with mock.patch.object(planrun, "get_plan_run", side_effect=get_flaky):
            first = self.compare("sess-a41f9c2b", "sess-9f00d1e2")
            self.assertEqual(first["event"], "error")
            second = self.compare("sess-a41f9c2b", "sess-9f00d1e2")
        self.assertEqual(second["event"], "session_compare",
                         "报告读失败不进缓存：可能只是还没归档好，下次要真去读")

    def test_cap_evicts_the_oldest(self):
        self.assertEqual(sessioncompare._RUN_CACHE_CAP, 8)
        for i in range(sessioncompare._RUN_CACHE_CAP + 2):
            sessioncompare._run_cache.put(f"k{i}", {"i": i})
        self.assertEqual(len(list(sessioncompare._run_cache)),
                         sessioncompare._RUN_CACHE_CAP)
        self.assertIsNone(sessioncompare._run_cache.get("k0"))
        self.assertIsNotNone(sessioncompare._run_cache.get("k9"))


# ------------------------------------------------------------- pair_rows

class PairRows(Fixture):
    def pairs(self, left=LEFT_KEY, right=RIGHT_KEY) -> dict:
        return self.one({"action": "pair_rows", "left_run_key": left, "right_run_key": right})

    def test_aligned_first_then_singletons_with_null_side(self):
        ev = self.pairs()
        self.assertEqual(ev["event"], "row_pairs")
        self.assertEqual((ev["aligned"], ev["total"]), (2, 5))
        rows = ev["pairs"]
        # 已对齐在前（按左侧行序），再左侧独有（左侧行序），最后右侧独有
        self.assertEqual([(p["left_row_key"], p["right_row_key"]) for p in rows], [
            ("sess-a41f9c2b", "sess-9f00d1e2"),
            ("case-hello", "case-hello-v2"),
            ("sess-only-left", None),
            ("leak@crescendo", None),
            (None, "sess-only-right"),
        ])
        self.assertEqual(rows[0]["align_key"], "把这句话翻译成英文：今天天气很好")
        self.assertEqual(rows[0]["left_results"], {"conciseness": {"score": 0.0, "passed": False}})
        self.assertEqual(rows[0]["right_results"], {"conciseness": {"score": 1.0, "passed": True}})
        # 未对齐行：缺席侧 row_key 与 results 都是 null
        self.assertIsNone(rows[4]["left_row_key"])
        self.assertIsNone(rows[4]["left_results"])
        self.assertEqual(rows[4]["align_key"], "右边独有的题")

    def test_pair_keys_are_exactly_the_contract(self):
        ev = self.pairs()
        for p in ev["pairs"]:
            self.assertEqual(set(p), {"align_key", "left_row_key", "right_row_key",
                                      "left_results", "right_results"})

    def test_missing_run_key_and_unknown_run(self):
        ev = self.one({"action": "pair_rows", "left_run_key": LEFT_KEY})
        self.assertEqual(ev, {"event": "error", "error": "right_run_key 不能为空"})
        ev = self.pairs(right="plan-zzz#1")
        self.assertEqual(ev, {"event": "error", "error": "run 'plan-zzz#1' 不存在"})


# ------------------------------------------------------------- 纯函数

class PureHelpers(unittest.TestCase):
    def test_normalize_key(self):
        self.assertEqual(sessioncompare.normalize_key("  Hello   World\n"), "hello world")
        self.assertEqual(sessioncompare.normalize_key(None), "")

    def test_text_diff_splits_replace(self):
        ops = sessioncompare.text_diff("abcXdef", "abcYYdef")
        self.assertEqual(ops, [{"op": "equal", "text": "abc"}, {"op": "delete", "text": "X"},
                              {"op": "insert", "text": "YY"}, {"op": "equal", "text": "def"}])

    def test_attribute_diff_change_kinds(self):
        left = {"a": 1, "b": None, "c": 3, "d": "x" * 81, "e": "same"}
        right = {"a": 2, "b": 2, "c": None, "d": "x" * 80 + "y", "e": "same"}
        diff = sessioncompare.attribute_diff(left, right)
        self.assertEqual([(d["key"], d["change"]) for d in diff],
                         [("a", "modified"), ("b", "added"), ("c", "removed"), ("d", "modified")])
        self.assertIn("text_diff", diff[3])  # >80 字的长文本附字级 diff
        self.assertNotIn("text_diff", diff[0])


if __name__ == "__main__":
    unittest.main()
