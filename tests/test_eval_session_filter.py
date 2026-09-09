"""`evaltest` 过滤只留一处：`discovery.eval_session_filter`。

收口前三份：discovery.build_session_query 与 agentstatus.build_status_query 各逐字抄了
一句 `| filter attributes.session.id not like 'evaltest'`（agentstatus 的 docstring 却说
「按 discovery 的开关走」），topology 另立一个 EVAL_SESSION_PREFIX 常量。两种判法本就
不同集（Insights 侧子串 vs Python 侧前缀）。

本文件钉三件：
  · 子句**字节不变**（收口是等价重构，不是改查询语义）；
  · 源码里那句字面量在 app/*.py 里只出现一次，且就在 discovery.py（禁止型约束配反向钉：
    再抄一份就红；同时钉「两个 query builder 真的还带着这条子句」，否则没人用也会绿）；
  · 两种判法在现网 id 形态上同集（夹具里的真会话 id + 三处起名方式）——「当下同集」是
    读数，不是设计承诺，所以顺带钉出一个只在子串判法下才被排掉的反例。
运行：python3 -m pytest tests/test_eval_session_filter.py -q
"""

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import agentstatus  # noqa: E402
import discovery  # noqa: E402
import topology  # noqa: E402

APP = Path(__file__).resolve().parent.parent / "app"
FIXDIR = Path(__file__).resolve().parent / "fixtures"
# 收口前那句逐字（两处抄的都是它）
LEGACY_CLAUSE = " | filter attributes.session.id not like 'evaltest'"


def _fixture_session_ids() -> set[str]:
    out = set()
    for f in sorted(FIXDIR.glob("*.json")):
        for m in re.finditer(r'"session\.id":\s*"([^"]+)"', f.read_text()):
            out.add(m.group(1))
    return out


class OneClause(unittest.TestCase):
    def test_clause_is_byte_identical_to_the_pre_refactor_literal(self):
        self.assertEqual(discovery.eval_session_filter(), LEGACY_CLAUSE)
        self.assertEqual(discovery.eval_session_filter(include_test=True), "")

    def test_both_query_builders_carry_it(self):
        """反向钉：光「字面量只有一处」也可能是「没人用」，所以两个 builder 各钉一次。"""
        self.assertIn(LEGACY_CLAUSE, discovery.build_session_query(10))
        self.assertNotIn(LEGACY_CLAUSE, discovery.build_session_query(10, include_test=True))
        self.assertIn(LEGACY_CLAUSE, agentstatus.build_status_query())
        self.assertNotIn(LEGACY_CLAUSE, agentstatus.build_status_query(include_test=True))

    def test_the_literal_lives_in_exactly_one_place(self):
        hits = {}
        for f in sorted(APP.glob("*.py")):
            n = len(re.findall(r"attributes\.session\.id not like", f.read_text()))
            if n:
                hits[f.name] = n
        self.assertEqual(hits, {"discovery.py": 1},
                         f"这句只该出现在 discovery.eval_session_filter 里，实际：{hits}")

    def test_the_prefix_word_is_single_sourced(self):
        self.assertIs(topology.EVAL_SESSION_PREFIX, discovery.EVAL_SESSION_PREFIX)
        self.assertIn(discovery.EVAL_SESSION_PREFIX, LEGACY_CLAUSE)


class TwoJudgementsAgreeOnLiveShapes(unittest.TestCase):
    def test_fixture_session_ids_are_classified_the_same_way(self):
        sids = _fixture_session_ids()
        self.assertTrue(sids, "夹具里读不到会话 id，断言已失效")
        for sid in sorted(sids):
            with self.subTest(sid=sid):
                prefix = topology.is_eval_session(sid)
                substring = discovery.EVAL_SESSION_PREFIX in sid
                self.assertEqual(prefix, substring)
                self.assertTrue(prefix, "夹具里的会话都是评估流量（都带 evaltest- 前缀）")

    def test_substring_is_the_stricter_judgement(self):
        """两种判法只在这种 id 上分家：中间含 evaltest。子串把它当评估流量排掉（严），
        前缀把它算真实流量。所以 Insights 侧留子串 = 不放宽默认口径那一侧。"""
        sid = "prod-evaltest-lookalike-1"
        self.assertIn(discovery.EVAL_SESSION_PREFIX, sid)
        self.assertFalse(topology.is_eval_session(sid))

    def test_all_three_minting_sites_use_the_prefix(self):
        """testrun / redteam / probe 三处起名都是 f"evaltest-…"（现网 id 一律前缀的根据）。"""
        for name in ("testrun.py", "redteam.py", "probe.py"):
            src = (APP / name).read_text()
            with self.subTest(module=name):
                mints = re.findall(r'f"(evaltest-[^"]*)"', src)
                self.assertTrue(mints, f"{name} 里找不到 evaltest- 起名处")
                for m in mints:
                    self.assertTrue(m.startswith(discovery.EVAL_SESSION_PREFIX + "-"), m)


if __name__ == "__main__":
    unittest.main()
