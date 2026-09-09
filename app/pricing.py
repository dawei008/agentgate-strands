"""Model price table: builtin defaults + DynamoDB overrides + Pricing API sync.

Price entries live in the catalog table as pk="PRICE", sk=<model_key> with
per-1K-token USD rates and a source marker:
  - "manual":  set via UI; never touched by auto refresh
  - "auto":    written by refresh_from_pricing_api
Builtin defaults (below) fill any model with no DB entry. All costs downstream
are estimates and labeled as such.

Model keys are normalized: region prefixes (us./global./eu./apac.) stripped,
version suffixes kept. Lookup tries exact key then prefix match.
"""

import json
import logging
import time

import boto3
from boto3.dynamodb.conditions import Key

import catalog
from discovery import REGION

logger = logging.getLogger("eval-anything")

# 表与句柄都复用 catalog（R4）：价目行（pk="PRICE"）住在**同一张**目录表里，而
# 这里此前养着 REGION / TABLE_NAME / _get_table 三件与 catalog 逐字同形的拷贝 ——
# 同一个 env（AWS_REGION / CATALOG_TABLE）读两遍、同一张表建两个句柄，换表名或改
# 缓存策略得记住两处。evalcache 早就是直接用 catalog 的先例。
# REGION 仍是本模块属性（Pricing API 的 regionCode 过滤在用），只是不再自己定义。

# $/1K tokens (input, output). Estimates seeded from public Bedrock pricing;
# correct via UI where they drift.
BUILTIN_PRICES = {
    "anthropic.claude-opus-5": {"input": 0.015, "output": 0.075},
    "anthropic.claude-opus-4-8": {"input": 0.015, "output": 0.075},
    "anthropic.claude-fable-5": {"input": 0.020, "output": 0.100},
    "anthropic.claude-sonnet-5": {"input": 0.003, "output": 0.015},
    "anthropic.claude-sonnet-4-6": {"input": 0.003, "output": 0.015},
    # Sonnet 4.5（Bedrock id `anthropic.claude-sonnet-4-5-20250929-v1:0`，`us.` /
    # `global.` 前缀由 normalize_model_key 剥掉后按前缀命中这一行）。$3 / $15 per MTok，
    # 与 Sonnet 4.6 同价 —— platform.claude.com/docs/en/about-claude/pricing 2026-09-07
    # 核对；Bedrock 公开价目页 Anthropic 表是 JS 渲染、脚本抓不到，第三方价目追踪站
    # 报 us-west-2 挂牌 $3.30 / $16.50。若现网账单对不上，走 UI 单价配置覆盖（manual 优先）。
    # 缺这一行时 dshEvalTrace 的线上评估报告成本整列「模型未定价」（P1，2026-09-04 评审）。
    "anthropic.claude-sonnet-4-5": {"input": 0.003, "output": 0.015},
    "anthropic.claude-haiku-4-5": {"input": 0.001, "output": 0.005},
    "amazon.nova-pro": {"input": 0.0008, "output": 0.0032},
    "amazon.nova-lite": {"input": 0.00006, "output": 0.00024},
}


def normalize_model_key(model_id: str) -> str:
    key = model_id.strip()
    for prefix in ("us.", "global.", "eu.", "apac.", "jp."):
        if key.startswith(prefix):
            key = key[len(prefix):]
            break
    return key


def get_prices() -> dict:
    """Merged table {model_key: {input, output, source, updated_at}} + last_sync info."""
    merged = {
        k: {**v, "source": "builtin", "updated_at": None} for k, v in BUILTIN_PRICES.items()
    }
    last_sync = None
    if catalog.TABLE_NAME:
        items = catalog.get_table().query(
            KeyConditionExpression=Key("pk").eq("PRICE")
        ).get("Items", [])
        for item in items:
            if item["sk"] == "_last_sync":
                last_sync = {
                    "at": int(item.get("refreshed_at", 0)),
                    "updated_models": int(item.get("updated_models", 0)),
                }
                continue
            merged[item["sk"]] = {
                "input": float(item["input"]),
                "output": float(item["output"]),
                "source": item.get("source", "manual"),
                "updated_at": int(item.get("refreshed_at", 0)),
            }
    return {"prices": merged, "last_sync": last_sync}


# Prompt-cache token multipliers relative to the base input rate (Anthropic
# pricing doc, 2026-09-07: 5-minute cache write 1.25x, cache read 0.1x; Bedrock
# Claude follows the same ratios, e.g. Sonnet 4.5 $3 -> $3.75 write / $0.30 read).
# Without these, cached prompt tokens were not counted at all: the dsh harness
# spans carry gen_ai.usage.input_tokens=3 next to cache_read.input_tokens=7932,
# so 8 calls summed to "输入 36" (P1, 2026-09-04 review). 1-hour writes (2x) are
# not distinguishable on the span, so they are billed at the 5-minute rate.
CACHE_WRITE_INPUT_MULTIPLIER = 1.25
CACHE_READ_INPUT_MULTIPLIER = 0.1


def usage_cost_usd(price: dict, input_tokens: int = 0, output_tokens: int = 0,
                   cache_read_tokens: int = 0, cache_write_tokens: int = 0) -> float:
    """USD for one usage record at a $/1K price row, cache tokens at their multipliers.

    `input_tokens` is the *uncached* prompt share (what gen_ai.usage.input_tokens
    reports on Anthropic-style spans); cache read/write tokens are priced off the
    same input rate times CACHE_*_INPUT_MULTIPLIER.
    """
    inp = price["input"]
    return ((input_tokens / 1000) * inp
            + (cache_read_tokens / 1000) * inp * CACHE_READ_INPUT_MULTIPLIER
            + (cache_write_tokens / 1000) * inp * CACHE_WRITE_INPUT_MULTIPLIER
            + (output_tokens / 1000) * price["output"])


# $/1K tokens used for the JUDGE side when its model has no price row.
# The judge is *our* configured model (judgellm), not the user's agent: every
# run makes judge calls, so a missing row must never silence that spend.
# This literal used to be inlined at four estimate sites while the **actual**
# accrual had no fallback at all — that asymmetry is how a run with 40 judge
# calls kept actual_cost_usd=0.0 and the cost circuit (actual > 3x estimate)
# never fired (P1, 2026-08-24). One constant, both sides.
JUDGE_PRICE_FALLBACK = {"input": 0.003, "output": 0.015}


# Vendor prefixes on our price keys. Non-Bedrock telemetry (e.g. a bare
# "claude-sonnet-5" reported straight from the Anthropic API) carries no vendor
# prefix, so a prefix-only match would miss and the model would land in
# unpriced_models with cost 0.
_VENDOR_PREFIXES = ("anthropic.", "amazon.", "meta.", "mistral.", "cohere.", "ai21.", "deepseek.")


def lookup_price(model_id: str, prices: dict) -> dict | None:
    """Find a price for a raw model id: exact normalized key, then prefix match.

    Matching is also tried against vendor-stripped keys so bare model names from
    non-Bedrock sources price correctly.
    """
    key = normalize_model_key(model_id)
    if key in prices:
        return prices[key]
    for k, v in prices.items():
        if key.startswith(k) or k.startswith(key):
            return v
    # Bare name (no vendor prefix) vs vendor-prefixed price keys, and the reverse.
    bare = key
    for p in _VENDOR_PREFIXES:
        if bare.startswith(p):
            bare = bare[len(p):]
            break
    for k, v in prices.items():
        k_bare = k
        for p in _VENDOR_PREFIXES:
            if k_bare.startswith(p):
                k_bare = k_bare[len(p):]
                break
        if bare and k_bare and (bare == k_bare or bare.startswith(k_bare) or k_bare.startswith(bare)):
            return v
    return None


def judge_price(model_id: str, prices: dict) -> tuple[dict, bool]:
    """(rate, unpriced) for a judge model: its own row, else the fallback rate.

    Never returns None: a judge call that happened is money spent, and a caller
    that "skips the accrual because there is no price" turns cost tracking AND
    the cost circuit into no-ops (see JUDGE_PRICE_FALLBACK).

    unpriced=True means the rate is a guess, and the caller must say so on the
    run (`unpriced_judge`) — a cost computed from a guessed rate may not be
    presented as a measured one.
    """
    p = lookup_price(model_id, prices) if model_id else None
    return (p, False) if p else (JUDGE_PRICE_FALLBACK, True)


def set_price(model_key: str, input_per_1k: float, output_per_1k: float) -> None:
    catalog.get_table().put_item(
        Item={
            "pk": "PRICE", "sk": normalize_model_key(model_key),
            "input": str(input_per_1k), "output": str(output_per_1k),
            "source": "manual", "refreshed_at": int(time.time()),
        }
    )


def delete_price(model_key: str) -> None:
    catalog.get_table().delete_item(Key={"pk": "PRICE", "sk": normalize_model_key(model_key)})


# name fragments in Pricing API product attributes -> our model keys
_PRICING_NAME_MAP = {
    "claude opus 5": "anthropic.claude-opus-5",
    "claude sonnet 5": "anthropic.claude-sonnet-5",
    "claude fable 5": "anthropic.claude-fable-5",
    "claude opus 4.8": "anthropic.claude-opus-4-8",
    "claude sonnet 4.6": "anthropic.claude-sonnet-4-6",
    "claude sonnet 4.5": "anthropic.claude-sonnet-4-5",
    "claude haiku 4.5": "anthropic.claude-haiku-4-5",
    "nova pro": "amazon.nova-pro",
    "nova lite": "amazon.nova-lite",
}


def refresh_from_pricing_api() -> dict:
    """Best-effort sync from AWS Pricing API. Only touches source=auto entries.

    Bedrock pricing entries are keyed by human model names and usagetype
    suffixes (…InputTokenCount / …OutputTokenCount); anything we cannot map
    confidently is skipped. Third-party models never appear here — those stay
    manual. On any failure the previous table is kept.
    """
    client = boto3.client("pricing", region_name="us-east-1")
    collected: dict[str, dict] = {}
    try:
        paginator = client.get_paginator("get_products")
        for page in paginator.paginate(
            ServiceCode="AmazonBedrock",
            Filters=[
                {"Type": "TERM_MATCH", "Field": "regionCode", "Value": REGION},
                {"Type": "TERM_MATCH", "Field": "feature", "Value": "On-demand Inference"},
            ],
        ):
            for raw in page["PriceList"]:
                product = json.loads(raw)
                attrs = product.get("product", {}).get("attributes", {})
                name = (attrs.get("model") or attrs.get("titanModel") or "").lower()
                usagetype = attrs.get("usagetype", "")
                model_key = next(
                    (v for frag, v in _PRICING_NAME_MAP.items() if frag in name), None
                )
                if not model_key:
                    continue
                direction = (
                    "input" if "InputTokenCount" in usagetype
                    else "output" if "OutputTokenCount" in usagetype
                    else None
                )
                if not direction:
                    continue
                terms = product.get("terms", {}).get("OnDemand", {})
                for term in terms.values():
                    for dim in term.get("priceDimensions", {}).values():
                        usd = float(dim.get("pricePerUnit", {}).get("USD", 0))
                        if usd > 0:
                            # Pricing API unit is per 1K tokens for Bedrock
                            collected.setdefault(model_key, {})[direction] = usd
    except Exception as e:
        logger.exception("pricing api sync failed")
        return {"updated_models": 0, "error": str(e)}

    updated = 0
    now = int(time.time())
    if catalog.TABLE_NAME:
        table = catalog.get_table()
        existing = {
            i["sk"]: i for i in table.query(
                KeyConditionExpression=Key("pk").eq("PRICE")
            ).get("Items", [])
        }
        for model_key, rates in collected.items():
            if "input" not in rates or "output" not in rates:
                continue
            if existing.get(model_key, {}).get("source") == "manual":
                continue  # manual always wins
            table.put_item(
                Item={"pk": "PRICE", "sk": model_key,
                      "input": str(rates["input"]), "output": str(rates["output"]),
                      "source": "auto", "refreshed_at": now}
            )
            updated += 1
        table.put_item(
            Item={"pk": "PRICE", "sk": "_last_sync",
                  "refreshed_at": now, "updated_models": updated}
        )
    return {"updated_models": updated, "at": now}
