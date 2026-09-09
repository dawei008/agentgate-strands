"""L2：调用被测 Agent 的传输层是公开件，三个域同用（simplify-r2 Track B）。

「怎么调被测 Agent」是回归 / 红队 / 连通性探测共用的下层机制，此前以私有件
（`_render_payload` / `_invoke_agent_raw` / `_join_sse` / `_walk_response_path` /
`_invoke_agent`）形态住在回归域里，probe.py 四处、redteam.py 一处跨模块伸手拿
下划线名字 —— 名字是私有的、事实是公共的。本批只改名，不改规则。

这里钉两件事：
  1. **规则逐字节不变**：三条纯函数（渲染 / SSE 合并 / 路径提取）对同一批输入的
     输出与改名前完全一致（下面的期望值是照 52a5bcf 的行为写死的字面量）。
  2. **只有一个住址**：旧私有名不再存在（不留别名，否则「公名」等于多一个住址），
     且没有任何模块再伸手拿下划线传输件。

Run: python3 -m pytest tests/test_r2_infra_transport.py -q
"""

import json
import re
import sys
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(APP))

import probe  # noqa: E402
import testrun  # noqa: E402

# 公名 + 旧私有名，一一对应（旧名必须消失，新名必须可调用）
RENAMED = {
    "_render_payload": "render_payload",
    "_join_sse": "join_sse",
    "_walk_response_path": "walk_response_path",
    "_invoke_agent_raw": "invoke_agent_raw",
    "_invoke_agent": "invoke_agent",
}


class PublicNamesAreTheOnlyAddress(unittest.TestCase):
    def test_public_names_exist_and_are_callable(self):
        for public in RENAMED.values():
            with self.subTest(public):
                self.assertTrue(callable(getattr(testrun, public, None)),
                                f"testrun.{public} 不在（L2 要求的公名）")

    def test_private_aliases_are_gone(self):
        """不留 `_x = x` 别名：那会让「传输件住哪」重新有两个答案。"""
        for private in RENAMED:
            with self.subTest(private):
                self.assertFalse(hasattr(testrun, private),
                                 f"testrun.{private} 还在 —— 传输件又有两个住址")

    def test_no_module_reaches_for_a_private_transport_name(self):
        pattern = re.compile(r"testrun\._(?:render_payload|join_sse|walk_response_path"
                             r"|invoke_agent_raw|invoke_agent)\b")
        for path in sorted(APP.glob("*.py")):
            with self.subTest(path.name):
                hits = pattern.findall(path.read_text())
                self.assertEqual(hits, [], f"{path.name} 仍跨模块伸手拿私有传输件：{hits}")


class RenderPayloadRuleUnchanged(unittest.TestCase):
    """{input} 的 JSON 转义规则：模板是 JSON 文本，替换进去的必须是**已转义**的
    片段（去掉 json.dumps 的首尾引号），否则用户输入里的引号/换行会把模板打碎。"""

    CASES = [
        ('{"prompt": "{input}"}', "订单退款", '{"prompt": "订单退款"}'),
        ('{"prompt": "{input}"}', '他说"退款"', '{"prompt": "他说\\"退款\\""}'),
        ('{"prompt": "{input}"}', "第一行\n第二行", '{"prompt": "第一行\\n第二行"}'),
        ('{"prompt": "{input}"}', "反斜杠\\路径", '{"prompt": "反斜杠\\\\路径"}'),
        # 两个占位符都替换；无占位符原样返回
        ('{"a": "{input}", "b": "{input}"}', "x", '{"a": "x", "b": "x"}'),
        ('{"prompt": "固定"}', "忽略", '{"prompt": "固定"}'),
    ]

    def test_rendered_bytes_match_the_pre_rename_rule(self):
        for template, case_input, expected in self.CASES:
            with self.subTest(case_input):
                self.assertEqual(testrun.render_payload(template, case_input), expected)

    def test_rendered_template_still_parses_as_json(self):
        rendered = testrun.render_payload('{"prompt": "{input}"}', '引号"与\n换行')
        self.assertEqual(json.loads(rendered)["prompt"], '引号"与\n换行')


class JoinSseRuleUnchanged(unittest.TestCase):
    CASES = [
        # 非 SSE 原样透出（含空串）
        ("", ""),
        ("纯文本回答", "纯文本回答"),
        ('{"output": "x"}', '{"output": "x"}'),
        # data: 行的 JSON 字符串拼接（不加分隔符）
        ('data: "你好"\ndata: "世界"', "你好世界"),
        # 非字符串 JSON → 重新序列化（ensure_ascii=False）
        ('data: {"t": "中文"}', '{"t": "中文"}'),
        # 认不出的 chunk 原样拼
        ("data: 不是JSON\ndata: 也不是", "不是JSON也不是"),
        # 判据用 lstrip（整体算 SSE），逐行匹配却用 startswith：**带前导空格的
        # data: 行会被跳过**。这不是笔误，是改名前的真实行为（实测 52a5bcf 得
        # "乙"），钉在这里以免哪天「顺手修一下」变成静默丢一段回答。
        ('  data: "甲"\nevent: chunk\n\ndata: "乙"', "乙"),
        # 正文中出现 \ndata: 也算 SSE（既有判据）
        ('前言\ndata: "尾"', "尾"),
    ]

    def test_joined_text_matches_the_pre_rename_rule(self):
        for body, expected in self.CASES:
            with self.subTest(body[:24]):
                self.assertEqual(testrun.join_sse(body), expected)


class WalkResponsePathRuleUnchanged(unittest.TestCase):
    OBJ = {"output": {"message": {"content": [{"text": "最终回答"}, {"text": "第二块"}]}},
           "meta": {"0": "字符串键的零"}}

    def test_dot_and_index_path(self):
        self.assertEqual(
            testrun.walk_response_path(self.OBJ, "output.message.content.0.text"),
            "最终回答")
        self.assertEqual(
            testrun.walk_response_path(self.OBJ, "output.message.content.1.text"),
            "第二块")

    def test_digit_segment_is_a_list_index_not_a_dict_key(self):
        """既有规则：纯数字段一律 int() 当下标 —— 数字字符串键取不到（照旧抛）。"""
        with self.assertRaises(Exception):
            testrun.walk_response_path(self.OBJ, "meta.0")

    def test_miss_raises(self):
        for path in ("output.nope", "output.message.content.9.text"):
            with self.subTest(path):
                with self.assertRaises(Exception):
                    testrun.walk_response_path(self.OBJ, path)


class ProbeExtractsWhatARunWouldExtract(unittest.TestCase):
    """probe.py 报的「取到的最终文本」按构造 == 正式 run 会提取的那一段。

    这是 L2 改名后仍必须成立的跨模块契约（probe.py 头注释把它写成保证）：探测
    走的两步（join_sse → walk_response_path）与 run 的 _extract_response 同一套规则。
    """

    BODIES = [
        ('{"output": {"message": {"content": [{"text": "回答"}]}}}',
         "output.message.content.0.text"),
        ('data: "流式回答"\ndata: "的后半"', ""),
        ("纯文本，不是 JSON", "output.text"),          # 路径取不到 → 整段文本
        ('{"output": "有 JSON 但不取路径"}', ""),
    ]

    def test_run_extraction_is_the_probe_two_step(self):
        for body, path in self.BODIES:
            with self.subTest(body[:24]):
                run_side = testrun._extract_response(body, path)
                text = testrun.join_sse(body)
                if path:
                    try:
                        probe_side = str(testrun.walk_response_path(json.loads(text), path))
                    except Exception:
                        probe_side = text
                else:
                    probe_side = text
                self.assertEqual(run_side, probe_side)

    def test_probe_module_calls_the_public_transport(self):
        src = (APP / "probe.py").read_text()
        for call in ("testrun.render_payload(", "testrun.invoke_agent_raw(",
                     "testrun.join_sse(", "testrun.walk_response_path("):
            with self.subTest(call):
                self.assertIn(call, src)

    def test_probe_still_passes_its_own_hard_timeout_client(self):
        """`client=` 是探测的既有特权（一次调用、硬读超时），改名不许弄丢。"""
        self.assertIn("client=_probe_client(timeout)", (APP / "probe.py").read_text())
        self.assertIn("client=None", (APP / "testrun.py").read_text())


class RedteamRidesTheSameLine(unittest.TestCase):
    def test_target_session_invokes_via_the_public_name(self):
        self.assertIn("testrun.invoke_agent(", (APP / "redteam.py").read_text())


if __name__ == "__main__":
    unittest.main()
