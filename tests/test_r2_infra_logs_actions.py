"""运行时角色的 logs action 清单必须覆盖 app/ 里每一个 logs 调用点。

**这条守卫是买来的。** 2026-08-27 v71 首轮 A/B：低延迟读法从 Insights 换成
`filter_log_events`，代码本身对的、镜像也确实是 v71，但角色里只有 Insights 三件套
（DescribeLogGroups / StartQuery / GetQueryResults）—— 每侧第一个用例就
`AccessDeniedException`，`_span_degrade` 的 not-missing 分支把熔断拉起来，其余 14 例
全 `REASON_SKIPPED`，两侧 30 个用例的 `tool_evidence` 全 `unavailable`。
本地读路径探针在 30 个历史 session 上全绿也照不出：**那把尺子用的是管理员凭证，
跟运行时角色不是同一把尺子。**

所以这里量的不是「代码能不能读」，而是「**声明的权限**能不能覆盖**代码实际调用的
API**」—— 两边都从源码 AST 取，不靠人转抄。

三段，缺一段这守卫就不成立：
  ⒈ `scan_logs_calls()` 的**自检**：它必须先抓到已知为真的调用点（尤其
     `filter_log_events`）。写这条的直接原因是第一版扫描器只认内联
     `boto3.client("logs")`，而本仓走 `_logs_client()` 工厂 ⇒ 它返回**空表**，
     而「一个 logs 调用都没有」与「扫描器坏了」在断言里完全同形，会静默放行。
  ⒉ 正判据：调用点 ⊆ 角色 action。
  ⒊ **反向钉**：拿一份故意缺项的 action 集合喂给同一个比对函数，它必须报出缺口。
     只有正判据的守卫，改坏了也是绿的。

Run: python3 -m pytest tests/test_r2_infra_logs_actions.py -q
"""

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
STACK = ROOT / "infra/stacks/eval_runtime_stack.py"
SID = "ReadRuntimeTraces"


def _iam_action(op: str) -> str:
    """boto3 的 snake_case 操作名 → IAM action（logs:FilterLogEvents）。"""
    return "logs:" + "".join(part.capitalize() for part in op.split("_"))


def scan_logs_calls() -> dict[str, list[str]]:
    """app/ 里每一个「对 CloudWatch Logs 客户端的方法调用」→ 调用点列表。

    两种造客户端的写法都要认，因为本仓两种都有过：
      · 内联 `logs = boto3.client("logs", ...)`；
      · 工厂 `def _logs_client(): return boto3.client("logs", ...)` + `logs = _logs_client()`。
    只认前一种的扫描器会返回空表 —— 见模块头注释⒈。
    """
    calls: dict[str, list[str]] = {}
    for path in sorted(APP.glob("*.py")):
        tree = ast.parse(path.read_text())

        def _is_logs_client_call(node: ast.AST) -> bool:
            return (isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "client"
                    and bool(node.args)
                    and isinstance(node.args[0], ast.Constant)
                    and node.args[0].value == "logs")

        # 先收工厂函数名：函数体里 return boto3.client("logs", …)
        factories = {
            fn.name for fn in ast.walk(tree)
            if isinstance(fn, ast.FunctionDef)
            and any(_is_logs_client_call(r.value)
                    for r in ast.walk(fn) if isinstance(r, ast.Return) and r.value)
        }
        # 再收持有客户端的变量名：内联 或 工厂调用
        holders: set[str] = set()
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)):
                continue
            f = node.value.func
            hit = _is_logs_client_call(node.value) or (
                isinstance(f, ast.Name) and f.id in factories)
            if hit:
                holders |= {t.id for t in node.targets if isinstance(t, ast.Name)}
        if not holders:
            continue
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id in holders):
                continue
            op = node.func.attr
            if op == "get_paginator":
                # 客户端本地方法，不是 IAM action（`logs:GetPaginator` 不存在）。
                # 归到它翻页的那个 op 上。解析不出常量就**炸**：静默丢弃等于
                # 把一个真调用点从清单里抹掉，而抹掉的方向正好是「守卫变绿」。
                arg = node.args[0] if node.args else None
                assert isinstance(arg, ast.Constant) and isinstance(arg.value, str), (
                    f"{path.relative_to(ROOT)}:{node.lineno} 的 get_paginator "
                    "参数不是字面量，无法判定它要哪个权限")
                op = arg.value
            calls.setdefault(op, []).append(f"{path.relative_to(ROOT)}:{node.lineno}")
    return calls


def declared_actions(sid: str = SID) -> set[str]:
    """CDK 栈里该 sid 的 actions 字面量 —— 从 AST 取，不 grep 字符串。"""
    tree = ast.parse(STACK.read_text())
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "PolicyStatement"):
            continue
        kw = {k.arg: k.value for k in node.keywords}
        s = kw.get("sid")
        if isinstance(s, ast.Constant) and s.value == sid:
            acts = kw.get("actions")
            assert isinstance(acts, ast.List), f"{sid}.actions 不是字面量列表"
            return {str(e.value) for e in acts.elts if isinstance(e, ast.Constant)}
    raise AssertionError(f"{STACK.name} 里找不到 sid={sid} 的 PolicyStatement")


def missing_actions(calls: dict[str, list[str]], actions: set[str]) -> dict[str, str]:
    """比对函数（正判据与反向钉共用同一个，跨尺子的红绿对作废）。"""
    return {op: _iam_action(op) for op in calls if _iam_action(op) not in actions}


class ScannerReadsWhatItClaims(unittest.TestCase):
    """量具自检印在读数之前：空表不许当绿。"""

    def test_it_finds_the_known_call_sites(self):
        calls = scan_logs_calls()
        self.assertTrue(calls, "扫描器返回空表 —— 这与「app 不调 logs」同形，"
                               "必是它认不出本仓的客户端造法")
        self.assertIn("filter_log_events", calls,
                      "抓不到 discovery.filter_span_records 里那一发 —— "
                      "正是 v71 事故的那个调用点")
        self.assertIn("start_query", calls, "Insights 读法那一发也该在")

    def test_call_sites_point_at_real_lines(self):
        for op, sites in scan_logs_calls().items():
            for site in sites:
                rel, lineno = site.rsplit(":", 1)
                src = (ROOT / rel).read_text().splitlines()
                with self.subTest(site=site):
                    self.assertIn(op, src[int(lineno) - 1],
                                  f"{site} 那一行里没有 {op}")

    def test_paginator_is_resolved_to_the_op_it_paginates(self):
        """`logs:GetPaginator` 不是 IAM action —— 它必须归到 describe_log_groups。

        第一版扫描器就报了这个假阳性，是**反向钉**先把它暴露出来的（正判据那边它
        表现为「多一条永远补不上的缺口」，很容易被误当成需要放宽门槛）。
        """
        calls = scan_logs_calls()
        self.assertNotIn("get_paginator", calls)
        self.assertIn("describe_log_groups", calls)
        # 期望的调用点从源码现算，不写死行号：写死的行号会被上下文里加一行注释碰红，
        # 而那种红与「翻页没归过来」同形（行号漂 ≠ 归类坏了）。
        src = (APP / "discovery.py").read_text().splitlines()
        want = [f"app/discovery.py:{i + 1}" for i, line in enumerate(src)
                if 'get_paginator("describe_log_groups")' in line]
        self.assertEqual(len(want), 1, f"源码里翻页调用点不是一处：{want}")
        self.assertIn(want[0], calls["describe_log_groups"],
                      f"翻页那一处没归过来：{calls['describe_log_groups']}")

    def test_snake_case_maps_to_iam_camel_case(self):
        self.assertEqual(_iam_action("filter_log_events"), "logs:FilterLogEvents")
        self.assertEqual(_iam_action("get_query_results"), "logs:GetQueryResults")


class DeclaredActionsCoverEveryCall(unittest.TestCase):
    def test_no_call_site_lacks_its_action(self):
        calls = scan_logs_calls()
        gaps = missing_actions(calls, declared_actions())
        self.assertEqual(gaps, {}, "app/ 调了角色没授权的 logs API：" + "; ".join(
            f"{action} ({', '.join(calls[op])})" for op, action in gaps.items()))

    def test_filter_log_events_is_declared(self):
        """事故那一条单独钉一次：整表通过时也要看得见它在。"""
        self.assertIn("logs:FilterLogEvents", declared_actions())

    def test_insights_pair_still_declared(self):
        """修 P1 时不许顺手把慢读法的权限撤掉 —— 观测页仍走 Insights。"""
        self.assertLessEqual({"logs:StartQuery", "logs:GetQueryResults"},
                             declared_actions())


class TheGuardCanGoRed(unittest.TestCase):
    """反向钉：同一个比对函数，喂缺项集合必须报缺口。"""

    def test_missing_action_is_reported(self):
        calls = scan_logs_calls()
        crippled = declared_actions() - {"logs:FilterLogEvents"}
        gaps = missing_actions(calls, crippled)
        self.assertEqual(gaps, {"filter_log_events": "logs:FilterLogEvents"},
                         "撤掉 FilterLogEvents 之后比对函数还说没问题 —— "
                         "那么它对真事故也不会红")

    def test_empty_action_set_reports_every_call(self):
        calls = scan_logs_calls()
        self.assertEqual(set(missing_actions(calls, set())),
                         set(calls), "空 action 集合下仍有调用点被判为已授权")

    def test_unknown_sid_raises_instead_of_returning_empty(self):
        """取不到 sid 时必须炸，不许回空集合 —— 空集合会让上面的判据反向变绿。"""
        with self.assertRaises(AssertionError):
            declared_actions("NoSuchSid")


if __name__ == "__main__":
    unittest.main()
