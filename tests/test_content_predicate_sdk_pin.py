"""CI 钉：内容判据的 events 那半必须 ⊇ SDK 还原时真读的事件名。

为什么要钉：`tracesource.CONTENT_SOURCES["events"]` 是「这条 span 带对话内容」的判据，
而真正把 span 还原成对话的是 SDK（strands_evals 的 GenericGenAISessionMapper）。两边各
自维护名字列表时，2026-09-08 实测已经漂成**互不包含**：我们有 gen_ai.assistant.message
而 SDK 的 invoke_agent 分支不读它，SDK 读 gen_ai.tool.message /
gen_ai.client.inference.operation.details 而我们没有。方向不对称 —— 判据比还原窄，会把
「SDK 还原得出内容」的会话标成 no_content（丢分）；判据比还原宽只是多等一轮 span。
所以断言是 **⊇ 而不是 ==**。

钉自身的纪律（本文件按这几条写）：
  · 抽出的集合先断言**非空**，抽不到必须红（不能因为「SDK 里一个都没找到」而静默放行）；
  · 抽到的集合印在比较**之前**（失败时读数在断言消息上方，pytest 也会把 stdout 一起打）；
  · 阴性对照要能分开「解析失败」与「符号不存在」两种成因：前者降级到 grep 并在 mode 上
    显形，后者一律抛 LookupError 并点名缺哪个函数；两者同时发生时报「符号不存在」；
  · 阳性对照：SDK 里出现一个我们没有的名字时，钉必须红（判据能红也能回绿）。

运行：python3 -m pytest tests/test_content_predicate_sdk_pin.py -q
"""

import ast
import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import strands_evals  # noqa: E402

import tracesource  # noqa: E402

SDK_MAPPER = (Path(strands_evals.__file__).resolve().parent
              / "mappers" / "generic_gen_ai_session_mapper.py")
# 三个 converter：invoke_agent / chat / execute_tool 各一份 span_events 循环，都从
# `event_name == "<字面量>"` 分支取对话内容。少写一个 = 那条分支上的新事件名永远抽不到。
SDK_CONVERTERS = ("_convert_agent_invocation_span", "_convert_inference_span",
                  "_convert_tool_execution_span")
_EVENT_CMP = re.compile(r'event_name\s*==\s*"([^"]+)"')
_NEXT_DEF = re.compile(r"\n    (?:async +)?def ")


def _missing(source: str, funcs) -> list[str]:
    return [f for f in funcs if f"def {f}(" not in source]


def _grep_event_names(source: str, funcs) -> set[str]:
    """ast 抽不动时的兜底：按 `def <名>(` 切出函数体，正则抓比较字面量。"""
    names: set[str] = set()
    for f in funcs:
        rest = source[source.index(f"def {f}("):]
        nxt = _NEXT_DEF.search(rest)
        names |= set(_EVENT_CMP.findall(rest[:nxt.start()] if nxt else rest))
    return names


def sdk_event_names(source: str, funcs=SDK_CONVERTERS) -> tuple[set[str], str]:
    """SDK 源码 → (那几个 converter 分支上的事件名字面量, 抽取方式 "ast"/"grep")。

    符号不存在 ⇒ LookupError（点名缺哪个），**优先于**解析失败判定：源码坏了但函数还在
    是一种成因（降级读数仍可信），函数被改名 / 删了是另一种（读数根本不该用）。
    """
    miss = _missing(source, funcs)
    if miss:
        raise LookupError(f"SDK 源码里找不到这些函数（符号不存在，不是解析失败）：{miss}")
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return _grep_event_names(source, funcs), f"grep（ast 解析失败：{e.msg}）"
    bodies = {n.name: n for n in ast.walk(tree)
              if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    miss = [f for f in funcs if f not in bodies]
    if miss:
        raise LookupError(f"SDK 源码里找不到这些函数（符号不存在，不是解析失败）：{miss}")
    names: set[str] = set()
    for f in funcs:
        for node in ast.walk(bodies[f]):
            if not (isinstance(node, ast.Compare) and isinstance(node.left, ast.Name)
                    and node.left.id == "event_name"):
                continue
            for op, comp in zip(node.ops, node.comparators):
                if isinstance(op, ast.Eq) and isinstance(comp, ast.Constant) \
                        and isinstance(comp.value, str):
                    names.add(comp.value)
    return names, "ast"


FIXDIR = Path(__file__).resolve().parent / "fixtures"
# 补齐前的三个名字（2026-09-08 收口前的 CONTENT_EVENT_NAMES），当同一批字节上的阴性对照。
EVENTS_BEFORE = ("gen_ai.user.message", "gen_ai.assistant.message", "gen_ai.choice")


def _records(name: str) -> list[dict]:
    data = json.loads((FIXDIR / name).read_text())
    return [r for r in (data if isinstance(data, list) else []) if isinstance(r, dict)]


def _has_content(record: dict, events) -> bool:
    """按判据逐项判这一条记录（属性侧 + inline events 侧，events 那半可换以做对照）。

    `@message` = 现网那条**紧凑** JSON（键值之间无空格），与 content_event_predicate
    锚的字节同一种写法。
    """
    if set(record.get("attributes") or {}) & set(tracesource.CONTENT_SOURCES["attrs"]):
        return True
    msg = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    for name in events:
        rx = re.fullmatch(r"@message like /(.*)/", tracesource.content_event_predicate(name))
        if re.search(rx.group(1), msg):
            return True
    return False


class WideningIsAReadingNotAGuess(unittest.TestCase):
    """补两个事件名对现网两派夹具的读数：逐条 has_content **不变**（含平台阴性对照）。"""

    FIXTURES = ("agentcore_spans_fable5_inline_events.json",   # fable5 派：对话在 inline events
                "aws_spans_dsh_attributes.json",               # dsh 派：对话在 attributes
                "agentcore_spans_tau_airline_16.json",         # 里面确实有 gen_ai.tool.message
                "aws_spans_platform_invoke.json")              # 平台自家 span：必须恒 0

    def test_per_record_verdicts_are_unchanged(self):
        now = set(tracesource.CONTENT_SOURCES["events"])
        self.assertTrue(set(EVENTS_BEFORE) < now, "对照集合应是补齐前的真子集")
        for name in self.FIXTURES:
            recs = _records(name)
            with self.subTest(fixture=name):
                self.assertTrue(recs, f"夹具读不出记录：{name}")
                before = [_has_content(r, EVENTS_BEFORE) for r in recs]
                after = [_has_content(r, sorted(now)) for r in recs]
                print(f"[widening] {name}: recs={len(recs)} 旧={sum(before)} 新={sum(after)}")
                self.assertEqual(after, before, "补名字改了这批字节的判定 ⇒ 不是等价加宽")

    def test_platform_span_still_has_no_content(self):
        """三重防误收里的第②条（平台自家 span 没有 events 字段）在加宽后仍成立。"""
        recs = _records("aws_spans_platform_invoke.json")
        self.assertEqual([_has_content(r, tracesource.CONTENT_SOURCES["events"]) for r in recs],
                         [False] * len(recs))


class ContentEventsSupersetOfSdk(unittest.TestCase):
    def _assert_pin(self, source: str) -> tuple[set[str], str]:
        names, mode = sdk_event_names(source)
        ours = set(tracesource.CONTENT_SOURCES["events"])
        # 读数印在比较之前（顺序是判据的一部分：坏解析别拿失败当绿）
        print(f"[content-pin] 抽取方式={mode}\n"
              f"[content-pin] SDK 会读的事件名={sorted(names)}\n"
              f"[content-pin] 我们的判据集合={sorted(ours)}")
        self.assertTrue(names, "从 SDK 源码里抽不到任何事件名 ⇒ 抽取器失效，这条必须红")
        self.assertTrue(names <= ours,
                        f"SDK 还原会读、我们的内容判据里没有：{sorted(names - ours)}"
                        f"（补进 tracesource.CONTENT_SOURCES['events']）")
        return names, mode

    def test_sdk_mapper_source_is_where_we_think_it_is(self):
        self.assertTrue(SDK_MAPPER.is_file(), f"SDK mapper 源码不在：{SDK_MAPPER}")

    def test_our_events_are_a_superset_of_what_the_sdk_reads(self):
        names, mode = self._assert_pin(SDK_MAPPER.read_text())
        self.assertEqual(mode, "ast", "读数走了 grep 兜底 ⇒ ast 抽不动了，先修抽取器再看结论")
        # 2026-09-08 实测这一版 SDK 读五个；数量变了要来看一眼是新增还是抽漏
        self.assertGreaterEqual(len(names), 5, f"抽到的名字比已知的少：{sorted(names)}")

    def test_negative_control_missing_symbol(self):
        """成因①：函数被改名 / 删了 —— 抛 LookupError 并点名，不许当成「SDK 不读事件」。"""
        src = SDK_MAPPER.read_text().replace(
            "def _convert_inference_span(", "def _convert_inference_span_RENAMED(")
        with self.assertRaises(LookupError) as cm:
            sdk_event_names(src)
        self.assertIn("_convert_inference_span", str(cm.exception))
        self.assertIn("符号不存在", str(cm.exception))

    def test_negative_control_parse_failure_degrades_to_grep(self):
        """成因②：源码解析不了但函数都在 —— 降级 grep、读数与 ast 路径**相同**，
        且成因写在 mode 上（与成因①分得开）。"""
        good, _ = sdk_event_names(SDK_MAPPER.read_text())
        broken = SDK_MAPPER.read_text() + "\n\nclass 、、、:\n    pass\n"
        names, mode = sdk_event_names(broken)
        self.assertTrue(mode.startswith("grep"), mode)
        self.assertNotIn("符号不存在", mode)
        self.assertEqual(names, good, "兜底读数与 ast 读数不一致 ⇒ 兜底不能信")

    def test_negative_control_parse_failure_and_missing_symbol_reports_the_symbol(self):
        """两种成因同时发生：报「符号不存在」（那时降级读数本来也不该用）。"""
        broken = (SDK_MAPPER.read_text() + "\n\nclass 、、、:\n    pass\n").replace(
            "def _convert_tool_execution_span(", "def _gone(")
        with self.assertRaises(LookupError) as cm:
            sdk_event_names(broken)
        self.assertIn("_convert_tool_execution_span", str(cm.exception))

    def test_pin_reds_when_nothing_can_be_extracted(self):
        """抽到 0 个必须红（而不是「空集 ⊆ 任何集合」地绿过去）。

        变异保持**语法合法**（`==` 改 `!=`）：这样走的是 ast 正路、抽到空集，钉的是
        「量具没抽到东西」这一档，而不是顺带测了一遍解析失败的兜底。"""
        src = SDK_MAPPER.read_text().replace('event_name == "', 'event_name != "')
        self.assertEqual(sdk_event_names(src)[1], "ast", "变异后应仍走 ast 正路")
        with self.assertRaisesRegex(AssertionError, "抽不到任何事件名"):
            self._assert_pin(src)

    def test_pin_reds_when_the_sdk_reads_a_name_we_lack(self):
        """阳性对照：SDK 多读一个我们没有的名字 ⇒ 钉红，并把缺的那个印出来。"""
        src = SDK_MAPPER.read_text().replace('event_name == "gen_ai.choice"',
                                             'event_name == "gen_ai.brand.new"', 1)
        with self.assertRaisesRegex(AssertionError, "gen_ai.brand.new"):
            self._assert_pin(src)


if __name__ == "__main__":
    unittest.main()
