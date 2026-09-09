"""诊断行料的唯一入口 `planrun._diag_rows`：两个收集器吃同一批行。

收口前 `_collect_root_causes` 与 `_collect_issue_seeds` 各带一份「observe →
session_details[].diagnosis / dataset → report.results[].diagnosis + no_trace 过滤」，
靠注释维持同源。同源靠注释维持 = 迟早在一处改漂，而漂的方向是「一个收集器把 no_trace
行算进材料、另一个不算」，两边都不会红。

钉两件：
  · 行料读数逐条钉住（observe / dataset / redteam × 有无诊断 × no_trace）；
  · 禁止型钉 + 反向钉：两个收集器的**代码**（剥掉 docstring）里不许再出现
    session_details / report / is_no_trace 这套分派，而 `_diag_rows` 里必须出现 ——
    只钉前半会因为「谁都没写」而假绿。
运行：python3 -m pytest tests/test_diag_rows_single_source.py -q
"""

import ast
import inspect
import sys
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import planrun  # noqa: E402
import testrun  # noqa: E402


def _code_without_docstring(fn) -> str:
    """函数体源码，去掉 docstring（否则「注释里提到 session_details」会被当成分派逻辑）。"""
    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    node = tree.body[0]
    if node.body and isinstance(node.body[0], ast.Expr) \
            and isinstance(node.body[0].value, ast.Constant) \
            and isinstance(node.body[0].value.value, str):
        node.body = node.body[1:]
    return ast.unparse(tree)


def _rc(rec: str, fix_type: str = "prompt") -> dict:
    return {"fix_type": fix_type, "fix_recommendation": rec,
            "root_cause_explanation": f"因为 {rec}", "causality": "…", "location": "span-1"}


OBSERVE = {
    "type": "observe",
    "session_details": [
        {"session_id": "sess-1", "diagnosis": {"root_causes": [_rc("加个例子")]},
         "results": {"correctness": {"score": 0.2, "passed": False, "errored": False}}},
        {"session_id": "sess-2", "diagnosis": None, "results": {}},
    ],
}
DATASET = {
    "type": "dataset",
    "report": {"results": [
        {"case": "c-ok", "diagnosis": {"root_causes": [_rc("改工具描述", "tool")]},
         "results": {"correctness": {"score": 0.1, "passed": False, "errored": False}}},
        # no_trace 行：判分本就不算 ⇒ 两个收集器都不许看到它
        {"case": "c-no-trace", "trace": {"status": testrun.TRACE_NO_TRACE, "reason": "no_span"},
         "diagnosis": {"root_causes": [_rc("这条不该出现")]}, "results": {}},
        {"case": "c-plain", "diagnosis": {}, "results": {}},
    ]},
}
REDTEAM = {"type": "redteam", "results": [{"case_name": "a__direct", "breached": True}]}
STAGES = [OBSERVE, DATASET, REDTEAM]


class DiagRows(unittest.TestCase):
    def test_rows_are_read_once_and_no_trace_is_dropped(self):
        rows = [(idx, stype, kind, ref, sorted(diag), results)
                for idx, stype, kind, ref, diag, results in planrun._diag_rows(STAGES)]
        low = {"correctness": {"score": 0.2, "passed": False, "errored": False}}
        self.assertEqual(rows, [
            (1, "observe", "session", "sess-1", ["root_causes"], low),
            (1, "observe", "session", "sess-2", [], {}),        # diagnosis None ⇒ {}；results 原样
            (2, "dataset", "case", "c-ok", ["root_causes"],
             {"correctness": {"score": 0.1, "passed": False, "errored": False}}),
            (2, "dataset", "case", "c-plain", [], {}),          # no_trace 那行不在里面
        ])

    def test_redteam_stage_yields_nothing(self):
        self.assertEqual(list(planrun._diag_rows([REDTEAM])), [])

    def test_empty_and_missing_containers_yield_nothing(self):
        self.assertEqual(list(planrun._diag_rows([{"type": "observe"},
                                                  {"type": "dataset"},
                                                  {"type": "dataset", "report": {}}])), [])


class BothCollectorsUseIt(unittest.TestCase):
    def test_root_causes_refs(self):
        got = planrun._collect_root_causes(STAGES)
        self.assertEqual([(r["stage"], r["stage_type"], r["ref"], r["fix_type"]) for r in got],
                         [(1, "observe", "sess-1", "prompt"), (2, "dataset", "c-ok", "tool")])

    def test_issue_seed_evidence_refs(self):
        seeds = planrun._collect_issue_seeds(STAGES)
        evidence = sorted((e["kind"], e["ref"]) for s in seeds for e in s["evidence"])
        self.assertEqual(evidence, [("case", "c-ok"), ("session", "sess-1")])
        self.assertNotIn("c-no-trace", str(seeds))

    def test_the_dispatch_lives_only_in_diag_rows(self):
        entry = _code_without_docstring(planrun._diag_rows)
        for token in ("session_details", "report", "is_no_trace"):
            with self.subTest(token=token):
                self.assertIn(token, entry, "反向钉：唯一入口里必须真有这套分派")
        for fn in (planrun._collect_root_causes, planrun._collect_issue_seeds):
            src = _code_without_docstring(fn)
            for token in ("session_details", "is_no_trace"):
                with self.subTest(fn=fn.__name__, token=token):
                    self.assertNotIn(token, src, "分派又抄回收集器里了")


if __name__ == "__main__":
    unittest.main()
