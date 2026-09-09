"""只用上报数据评估：内容判据与对话还原要覆盖 **inline events** 那一派（ADR-0019 后续修）。

两派埋点把对话放在不同地方，判据必须同时认这两处：
  · dsh 派（镜像内自带 ADOT collector，span 进 aws/spans）：对话在 span **attributes**
    （gen_ai.task.* / agentcore.invocation.*）；
  · fable5 派（CodeZip + opentelemetry-instrument + AgentCore 统一 span 目的地，span 进
    自己 runtime 组的 `spans` 流）：对话在 span 的 **inline events**（gen_ai.user.message
    的 content 是 JSON parts 列表、gen_ai.choice 的 message 是正文），attributes 里
    只有元数据 + system_prompt。

三个夹具都是**现网原样导出**（只把账号 ID 换成 111122223333、access key id 换成示例值）：
  · agentcore_spans_fable5_inline_events.json —— 2026-09-08 回归 run
    `plan-9d623c07ad4f#20260908022842` 的会话 evaltest-202609080228-88b1…（5 条 span，
    tauairline_agentfable5.DEFAULT）。修复前它被判 no_content，就是这批字节。
  · aws_spans_dsh_attributes.json —— 2026-09-04 红队 run 的 dsh 会话
    evaltest-rt-20260904025-007c…（3 条 span：invoke_agent / chat / execute_tool），
    **阴性对照**：内容在 attributes，它的 inline events 叫 dsh.input.message /
    gen_ai.response.first_chunk，一个都不在 CONTENT_EVENT_NAMES 里 ⇒ 逐条判定不变。
  · aws_spans_platform_invoke.json —— 平台自家那条 `Bedrock AgentCore.InvokeAgentRuntime`
    （service.name = evalanything.DEFAULT，与被测会话同一个 session.id），**没有 events
    字段** ⇒ 新判据不能把它判成有内容。

判据是发给 CloudWatch Insights 的字符串，CI 里不连 AWS，所以这里**逐项解释**
`build_content_predicate()`（见 `has_content`）：判据里出现本测试不认识的项就直接失败，
免得判据换了写法而这套断言悄悄变成空转。现网实测读数写在 docs/adr/0019-*.md。
运行：python3 -m pytest tests/test_trace_inline_events.py -q
"""

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import patches  # noqa: E402

patches.apply()

import tracesource  # noqa: E402

FIXDIR = Path(__file__).resolve().parent / "fixtures"
FABLE5 = json.loads((FIXDIR / "agentcore_spans_fable5_inline_events.json").read_text())
FABLE5_SID = "evaltest-202609080228-88b105e736d7409d8306f0aa93fe11bf"
DSH = json.loads((FIXDIR / "aws_spans_dsh_attributes.json").read_text())
DSH_SID = "evaltest-rt-20260904025-007cf788694648b099605dc7483726e9"
PLATFORM = json.loads((FIXDIR / "aws_spans_platform_invoke.json").read_text())


def insights_message(record: dict) -> str:
    """Insights 的 `@message` = 现网那条**紧凑** JSON（键与值之间无空格）。

    2026-09-08 对 fable5 那批 44 条记录实测：含 `"name":"gen_ai.choice"` 的 25 条、
    含带空格写法的 0 条 —— 判据锚的就是紧凑那一种。
    """
    return json.dumps(record, ensure_ascii=False, separators=(",", ":"))


def has_content(record: dict) -> bool:
    """按 `build_content_predicate()` 的每一项逐项判这条 span 有没有内容。

    项从判据字符串里现拆，不另抄一份：判据漏了 inline events 那几项，这里就跟着判假。
    """
    attrs = record.get("attributes") or {}
    msg = insights_message(record)
    for term in tracesource.build_content_predicate().split(" or "):
        m = re.fullmatch(r"ispresent\(attributes\.(.+)\)", term)
        if m:
            if m.group(1) in attrs:
                return True
            continue
        m = re.fullmatch(r"@message like /(.*)/", term)
        if m:
            if re.search(m.group(1), msg):
                return True
            continue
        raise AssertionError(f"判据里出现本测试不认识的项，断言已失效：{term!r}")
    return False


def attrs_only_has_content(record: dict) -> bool:
    """修复前的判据（只查 attributes），用来当同一批字节上的阴性对照。"""
    attrs = record.get("attributes") or {}
    return any(a in attrs for a in tracesource.CONTENT_ATTRS)


class Predicate(unittest.TestCase):
    def test_query_carries_both_halves(self):
        q = tracesource.build_trace_check_query(["evaltest-a"])
        for attr in tracesource.CONTENT_ATTRS:
            self.assertIn(f"ispresent(attributes.{attr})", q)
        for name in tracesource.CONTENT_EVENT_NAMES:
            self.assertIn(tracesource.content_event_predicate(name), q)
        self.assertIn("sum(has_content) as content_spans by sid, svc", q)

    def test_event_term_is_anchored_on_the_json_key_value_pair(self):
        """判据锚在 `"name":"<事件名>"` 上：正文里出现同一串字符时会被转义成别的字节，
        所以「对话正文提到 gen_ai.choice」伪造不出「有内容」。"""
        term = tracesource.content_event_predicate("gen_ai.choice")
        self.assertEqual(term, '@message like /"name":"gen_ai\\.choice"/')
        rx = re.fullmatch(r"@message like /(.*)/", term).group(1)
        forged = {"name": "chat", "attributes": {"session.id": "s1"},
                  "events": [{"name": "gen_ai.tool.message",
                              "attributes": {"content": '{"q": "\\"name\\":\\"gen_ai.choice\\""}'}}]}
        self.assertTrue(re.search(rx, insights_message({"events": [{"name": "gen_ai.choice"}]})))
        self.assertFalse(re.search(rx, insights_message(forged)),
                         "正文里的同名字符串是转义过的字节，不该命中")

    def test_system_prompt_event_is_not_content(self):
        """gen_ai.system.message 是 system_prompt，不是对话内容 —— 收了它，
        只有元数据 + 系统提示的 span 就会被判成有 trace。"""
        self.assertNotIn("gen_ai.system.message", tracesource.CONTENT_EVENT_NAMES)
        self.assertNotIn("gen_ai.system.message", tracesource.build_content_predicate())

    def test_fable5_session_has_content_only_through_inline_events(self):
        self.assertEqual(len(FABLE5), 5, "夹具是现网那 5 条 span")
        self.assertEqual(sum(attrs_only_has_content(r) for r in FABLE5), 0,
                         "修复前的判据在这批字节上一条都不中——现网 content_spans=0 的成因")
        hits = [r["name"] for r in FABLE5 if has_content(r)]
        self.assertEqual(len(hits), 3, f"新判据要选中 3 条：{hits}")
        self.assertIn("invoke_agent Strands Agents", hits, "最外层那条必须中，还原就靠它")

    def test_platform_span_is_not_content(self):
        record = PLATFORM[0]
        self.assertEqual(record["name"], "Bedrock AgentCore.InvokeAgentRuntime")
        self.assertEqual(record["resource"]["attributes"]["service.name"], "evalanything.DEFAULT")
        self.assertEqual(record["attributes"]["session.id"], FABLE5_SID,
                         "平台自家 span 与被测会话共用 session.id——所以才必须分得开")
        self.assertNotIn("events", record, "botocore 插桩不发 inline events")
        self.assertFalse(has_content(record), "平台自家 span 不能被判成有内容")
        self.assertIn('resource.attributes.service.name != "evalanything.DEFAULT"',
                      tracesource.build_trace_check_query(["evaltest-a"]),
                      "service.name 那道过滤必须还在")

    def test_dsh_verdicts_are_byte_for_byte_unchanged(self):
        """阴性对照：dsh 派逐条判定与修复前**同值** —— 它的 inline events 名字
        （dsh.input.message / gen_ai.response.first_chunk）一个都不在 CONTENT_EVENT_NAMES 里。"""
        self.assertEqual([has_content(r) for r in DSH], [attrs_only_has_content(r) for r in DSH])
        self.assertEqual(sum(has_content(r) for r in DSH), 2,
                         "invoke_agent（gen_ai.task.*）与 chat（gen_ai.output.messages）各一条")
        event_names = {e.get("name") for r in DSH for e in (r.get("events") or [])}
        self.assertTrue(event_names, "夹具里确实有 inline events，否则这条对照是空转")
        self.assertFalse(event_names & set(tracesource.CONTENT_EVENT_NAMES))


class Restore(unittest.TestCase):
    def test_fable5_fixture_restores_the_conversation_from_inline_events(self):
        invoke = next(r for r in FABLE5 if r["name"].startswith("invoke_agent"))
        self.assertFalse(set(invoke["attributes"]) & set(tracesource.CONTENT_ATTRS),
                         "这条 span 的 attributes 里没有任何内容键——还原只能来自 inline events")
        self.assertIn("system_prompt", invoke["attributes"], "attributes 里有的是 system_prompt")
        self.assertEqual([e["name"] for e in invoke["events"]],
                         ["gen_ai.user.message", "gen_ai.choice"])

        session, _spans = tracesource._session_from_records("lg", FABLE5_SID, FABLE5)
        si = tracesource.scoring_input_from_session(session)
        self.assertIsNotNone(si, "还原不出评分输入 = 现网那 5 例继续被判 no_content")
        self.assertIn("PEP4E0", si["output"], "最终回复是 gen_ai.choice 事件里的正文")
        self.assertFalse(si["output"].startswith("["), "回复必须是正文，不是 [{'text': …}]")
        self.assertEqual([t["role"] for t in si["turns"]], ["user", "assistant"])
        self.assertIn("用户（第 1 轮）", si["turns"][0]["message"],
                      "用户发言来自 gen_ai.user.message 的 content（JSON parts 列表）")
        self.assertTrue(si["span_ids"])

        turns = tracesource.invocation_turns(session)
        self.assertEqual([t["role"] for t in turns], ["user", "assistant"],
                         "批 3 的按调用配对也要还原出这一轮")
        self.assertEqual(turns[1]["message"], si["output"])

    def test_dsh_fixture_still_restores_from_attributes(self):
        """阴性对照：attributes 那条路一个字节都没动。"""
        invoke = next(r for r in DSH if r["name"] == "invoke_agent")
        self.assertFalse(invoke.get("events"), "dsh 的 invoke_agent 没有 inline events")
        self.assertTrue(set(invoke["attributes"]) & set(tracesource.CONTENT_ATTRS))

        session, _spans = tracesource._session_from_records("aws/spans", DSH_SID, DSH)
        si = tracesource.scoring_input_from_session(session)
        self.assertIsNotNone(si)
        self.assertTrue(si["output"].strip())
        self.assertEqual([t["role"] for t in si["turns"]][:2], ["user", "assistant"])


if __name__ == "__main__":
    unittest.main()
