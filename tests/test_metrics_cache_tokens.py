"""metrics.compute_session_metrics：prompt-cache token 与 Sonnet 4.5 定价（P1-2，2026-09-04 评审）。

现场真值（aws/spans · service=deepseek-harness · 2026-09-04，Logs Insights 实拉）：
  chat us.anthropic.claude-sonnet-4-5-20250929-v1:0
    gen_ai.usage.input_tokens=3  gen_ai.usage.output_tokens=351
    gen_ai.usage.cache_read.input_tokens=7932  gen_ai.usage.cache_write.input_tokens=834
只累加 input_tokens ⇒ 8 次调用「输入 36」；模型 id 在价表里查无 ⇒ 「模型未定价」。

钉三件事：
  1. input = 未缓存 + cache read + cache write，且拆分字段可见；两种拼写（点号 / 下划线）都认；
  2. 成本按倍率计：read ×0.1、write ×1.25（pricing.CACHE_*_INPUT_MULTIPLIER）；
  3. `us.` / `global.` 前缀 + 日期后缀的 Sonnet 4.5 id 命中内置价目行。

Run: python3 -m pytest tests/test_metrics_cache_tokens.py -q
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import metrics  # noqa: E402
import pricing  # noqa: E402

SONNET45 = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
PRICES = {k: {**v, "source": "builtin", "updated_at": None}
          for k, v in pricing.BUILTIN_PRICES.items()}
_NS = 1_000_000_000


def span(name, scope, attrs, t0=1_788_493_000, dur=1.0, tid="t1"):
    return {"name": name, "trace_id": tid, "scope": {"name": scope},
            "start_time": int(t0 * _NS), "end_time": int((t0 + dur) * _NS),
            "attributes": {"session.id": "s1", **attrs}}


def dsh_chat(out, cr=7932, cw=834, uncached=3, with_model=True, **extra):
    """dsh harness 的 chat span 原样（点号拼写）。"""
    attrs = {"gen_ai.usage.input_tokens": uncached, "gen_ai.usage.output_tokens": out,
             "gen_ai.usage.cache_read.input_tokens": cr,
             "gen_ai.usage.cache_write.input_tokens": cw, **extra}
    if with_model:
        attrs["gen_ai.request.model"] = SONNET45
    return span(f"chat {SONNET45}" if with_model else "chat",
                "opentelemetry.instrumentation.deepseek_harness", attrs)


class Pricing(unittest.TestCase):
    def test_sonnet_45_bedrock_ids_hit_the_builtin_row(self):
        for mid in (SONNET45, "anthropic.claude-sonnet-4-5-20250929-v1:0",
                    "global.anthropic.claude-sonnet-4-5-20250929-v1:0"):
            p = pricing.lookup_price(mid, PRICES)
            self.assertIsNotNone(p, mid)
            self.assertEqual((p["input"], p["output"]), (0.003, 0.015), mid)

    def test_sonnet_45_does_not_shadow_other_sonnets(self):
        # 前缀匹配不能把 4.5 认成 5 / 4.6，反过来也不行
        self.assertIs(pricing.lookup_price("global.anthropic.claude-sonnet-5", PRICES),
                      PRICES["anthropic.claude-sonnet-5"])
        self.assertIs(pricing.lookup_price("us.anthropic.claude-sonnet-4-6", PRICES),
                      PRICES["anthropic.claude-sonnet-4-6"])
        self.assertIs(pricing.lookup_price(SONNET45, PRICES),
                      PRICES["anthropic.claude-sonnet-4-5"])

    def test_usage_cost_applies_cache_multipliers(self):
        price = {"input": 0.003, "output": 0.015}
        # 手算：3 未缓存 + 7932 读 ×0.1 + 834 写 ×1.25，全按 $0.003/1K；输出 351 按 $0.015/1K
        expect = (3 / 1000 * 0.003 + 7932 / 1000 * 0.003 * 0.1
                  + 834 / 1000 * 0.003 * 1.25 + 351 / 1000 * 0.015)
        self.assertAlmostEqual(pricing.usage_cost_usd(price, 3, 351, 7932, 834), expect, places=9)
        self.assertEqual(pricing.CACHE_READ_INPUT_MULTIPLIER, 0.1)
        self.assertEqual(pricing.CACHE_WRITE_INPUT_MULTIPLIER, 1.25)


class CacheTokens(unittest.TestCase):
    def test_eight_dsh_calls_count_the_whole_prompt_not_36(self):
        spans = [dsh_chat(out=o) for o in (351, 680, 406, 130, 83, 385, 128, 104)]
        m = metrics.compute_session_metrics(spans, PRICES)
        self.assertEqual(m["llm_calls"]["count"], 8)
        self.assertEqual(m["tokens"]["input_uncached"], 24, "修前只报这一份（现场 36）")
        self.assertEqual(m["tokens"]["cache_read"], 8 * 7932)
        self.assertEqual(m["tokens"]["cache_write"], 8 * 834)
        self.assertEqual(m["tokens"]["input"], 24 + 8 * 7932 + 8 * 834)
        self.assertEqual(m["tokens"]["output"], sum((351, 680, 406, 130, 83, 385, 128, 104)))
        self.assertEqual(m["tokens"]["total"], m["tokens"]["input"] + m["tokens"]["output"])
        bm = m["tokens"]["by_model"][SONNET45]
        self.assertEqual((bm["calls"], bm["cache_read"], bm["cache_write"], bm["input_uncached"]),
                         (8, 8 * 7932, 8 * 834, 24))

    def test_dsh_session_is_priced_not_unpriced(self):
        spans = [dsh_chat(out=351)]
        m = metrics.compute_session_metrics(spans, PRICES)
        self.assertEqual(m["cost"]["unpriced_models"], [])
        expect = pricing.usage_cost_usd({"input": 0.003, "output": 0.015}, 3, 351, 7932, 834)
        self.assertAlmostEqual(m["cost"]["usd"], expect, places=6)
        self.assertAlmostEqual(m["cost"]["by_model"][SONNET45], expect, places=6)

    def test_underscore_spelling_and_cache_creation_are_read_too(self):
        # strands / botocore 拼写（tests/fixtures/agentcore_spans_tau_airline_16.json）
        s1 = span("chat", "opentelemetry.instrumentation.botocore.bedrock-runtime",
                  {"gen_ai.request.model": "us.anthropic.claude-sonnet-5",
                   "gen_ai.usage.prompt_tokens": 100, "gen_ai.usage.output_tokens": 10,
                   "gen_ai.usage.cache_read_input_tokens": 2000,
                   "gen_ai.usage.cache_write_input_tokens": 300})
        # Anthropic 原生命名的写侧
        s2 = span("chat", "opentelemetry.instrumentation.botocore.bedrock-runtime",
                  {"gen_ai.request.model": "us.anthropic.claude-sonnet-5",
                   "gen_ai.usage.input_tokens": 50, "gen_ai.usage.output_tokens": 5,
                   "gen_ai.usage.cache_creation_input_tokens": 400}, tid="t2")
        m = metrics.compute_session_metrics([s1, s2], PRICES)
        self.assertEqual(m["tokens"]["input_uncached"], 150)
        self.assertEqual(m["tokens"]["cache_read"], 2000)
        self.assertEqual(m["tokens"]["cache_write"], 700)
        self.assertEqual(m["tokens"]["input"], 150 + 2000 + 700)

    def test_spans_without_cache_attrs_are_unchanged(self):
        s = span("chat", "opentelemetry.instrumentation.botocore.bedrock-runtime",
                 {"gen_ai.request.model": "us.anthropic.claude-sonnet-5",
                  "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 100})
        m = metrics.compute_session_metrics([s], PRICES)
        self.assertEqual(m["tokens"]["input"], 1000)
        self.assertEqual(m["tokens"]["input_uncached"], 1000)
        self.assertEqual((m["tokens"]["cache_read"], m["tokens"]["cache_write"]), (0, 0))
        self.assertAlmostEqual(m["cost"]["usd"], 1000 / 1000 * 0.003 + 100 / 1000 * 0.015, places=9)

    def test_invoke_agent_aggregate_is_still_not_double_counted(self):
        chat = dsh_chat(out=351)
        agg = span("invoke_agent", "opentelemetry.instrumentation.deepseek_harness",
                   {"gen_ai.usage.input_tokens": 3, "gen_ai.usage.output_tokens": 351,
                    "gen_ai.usage.cache_read.input_tokens": 7932})
        m = metrics.compute_session_metrics([chat, agg], PRICES)
        self.assertEqual(m["llm_calls"]["count"], 1)
        self.assertEqual(m["tokens"]["cache_read"], 7932)


class Aggregate(unittest.TestCase):
    def test_agent_rollup_sums_cache_fields_and_tolerates_old_shape(self):
        new = metrics.compute_session_metrics([dsh_chat(out=351)], PRICES)
        old = {"tokens": {"input": 500, "output": 20, "total": 520},   # 修前写下的报告
               "cost": {"usd": 0.001, "unpriced_models": []},
               "latency": {"turns": 1, "avg_s": 1.0, "max_s": 1.0},
               "llm_calls": {"count": 1}, "tool_calls": {"count": 0}}
        agg = metrics.aggregate_agent_metrics([new, old])
        self.assertEqual(agg["tokens"]["input"], new["tokens"]["input"] + 500)
        self.assertEqual(agg["tokens"]["cache_read"], 7932)
        self.assertEqual(agg["tokens"]["cache_write"], 834)
        self.assertEqual(agg["tokens"]["input_uncached"], 3)


if __name__ == "__main__":
    unittest.main()
