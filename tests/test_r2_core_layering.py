"""层次纪律：app/ 的 import 图无环，且 `main` 是谁都不许 import 的顶层。

为什么需要机器来钉（simplify-r2 L1）
  `main.py` 是 AgentCore 的 action 派发层：它 import 一切。所以任何模块反向
  import main 就必然成环，而 Python 允许**函数体内** import 把环藏起来 ——
  `planrun._run_observe_stage` 曾用 `import main as main_mod` 反手拿三个评估核心
  私有件（`_evaluate_session` / `_summarize` / `_generate_analysis`），于是
  「errored 不算 0 分」这条口径的定义点住在派发层，planrun 的单测还得连带加载
  BedrockAgentCoreApp + patches。修法是抽 `observe.py` 领域模块，两侧同向下依赖。

  函数内 import 是**合法**手段（catalog.refresh_sessions 里的 `import tracesource`
  就是有意的惰性），所以本文件分两条纪律：
    · 模块级 import 图必须无环（惰性 import 不算，它们本来就是解环工具）；
    · 但 `main` 例外 —— 任何嵌套层级都不许 import 它，否则「藏起来的环」会
      重新长出来，而模块级检查看不见。

纯静态分析：不 import 任何 app 模块，零 AWS、零网络。
Run: python3 -m pytest tests/test_r2_core_layering.py -q
"""

import ast
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
MODULES = {p.stem for p in APP.glob("*.py")} - {"__init__"}


def _local_targets(node: ast.AST) -> set[str]:
    """本包内被该 import 语句指向的模块名（相对/绝对都按顶层名归一）。"""
    out = set()
    if isinstance(node, ast.Import):
        for a in node.names:
            root = a.name.split(".")[0]
            if root in MODULES:
                out.add(root)
    elif isinstance(node, ast.ImportFrom):
        if node.module:
            root = node.module.split(".")[0]
            if root in MODULES:
                out.add(root)
    return out


def module_level_graph() -> dict[str, set[str]]:
    """{module: 它在**模块级**import 的本包模块}"""
    graph: dict[str, set[str]] = {}
    for path in sorted(APP.glob("*.py")):
        if path.stem == "__init__":
            continue
        deps: set[str] = set()
        for node in ast.parse(path.read_text()).body:  # 顶层语句 only
            deps |= _local_targets(node)
        graph[path.stem] = deps
    return graph


def all_imports(module: str) -> set[str]:
    """该模块在**任意**嵌套层级 import 的本包模块（含函数体内的惰性 import）。"""
    deps: set[str] = set()
    for node in ast.walk(ast.parse((APP / f"{module}.py").read_text())):
        deps |= _local_targets(node)
    return deps


def find_cycle(graph: dict[str, set[str]]) -> list[str] | None:
    state: dict[str, int] = {}
    path: list[str] = []

    def visit(node: str) -> list[str] | None:
        state[node] = 1
        path.append(node)
        for nxt in sorted(graph.get(node, ())):
            if state.get(nxt) == 1:
                return path[path.index(nxt):] + [nxt]
            if state.get(nxt, 0) == 0:
                found = visit(nxt)
                if found:
                    return found
        path.pop()
        state[node] = 2
        return None

    for node in sorted(graph):
        if state.get(node, 0) == 0:
            found = visit(node)
            if found:
                return found
    return None


class ModuleGraphIsAcyclic(unittest.TestCase):
    def test_no_module_level_cycle(self):
        cycle = find_cycle(module_level_graph())
        self.assertIsNone(cycle, f"模块级 import 成环：{' -> '.join(cycle or [])}")

    def test_nobody_imports_main_at_any_depth(self):
        """含函数体内的惰性 import —— 那正是环被藏起来的地方。"""
        offenders = sorted(m for m in MODULES
                           if m != "main" and "main" in all_imports(m))
        self.assertEqual(offenders, [], f"这些模块 import 了 main：{offenders}")


class ObserveIsADomainModule(unittest.TestCase):
    """评估核心（observe）在派发层**之下**，被两侧共同向下依赖。"""

    def test_observe_imports_nothing_from_the_layers_above(self):
        deps = all_imports("observe")
        self.assertNotIn("main", deps)
        self.assertNotIn("planrun", deps)
        self.assertNotIn("testrun", deps)

    def test_both_callers_import_it_at_module_level(self):
        graph = module_level_graph()
        self.assertIn("observe", graph["main"])
        self.assertIn("observe", graph["planrun"])

    def test_the_errored_rule_has_one_home(self):
        """「errored 不算 0 分」的判定只在 observe 里定义一次。"""
        src = (APP / "observe.py").read_text()
        self.assertIn('"An error occurred:", "Evaluator error:"', src)
        for other in ("main.py", "planrun.py"):
            self.assertNotIn('"An error occurred:"',
                             (APP / other).read_text(), other)


if __name__ == "__main__":
    unittest.main()
