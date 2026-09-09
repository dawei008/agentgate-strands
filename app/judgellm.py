"""Judge 模型抽象：Bedrock（默认）或任意 OpenAI 兼容端点。

配置存 catalog 表（pk="CONFIG", sk="judge_model"）：
  {"provider": "bedrock", "model": "global.anthropic.claude-sonnet-5"}
  {"provider": "openai", "model": "glm-4.7", "base_url": "https://api.example.com/v1",
   "secret_id": "eval-anything/judge-openai"}      # secret 内容 {"api_key": "sk-..."}

API key 只存 Secrets Manager（eval-anything/ 前缀，运行时 IAM 已限定该前缀），
不进 DynamoDB、不落盘。

Judge 一共有两类调用面，都在这里收口：
  1. strands 评估器 / 诊断器 —— 接受 Model 实例或 Bedrock 模型 id 字符串，
     用 strands_model() 取。
  2. 直接的解析类调用（智能解析/改进稿/数据集生成/红队解析）—— 原来是
     boto3 bedrock-runtime converse，用 converse() 取，OpenAI 分支翻译成
     chat.completions（含强制工具调用）。
"""

import json
import logging
import time

import boto3
from botocore.config import Config as BotoConfig

import catalog
from discovery import REGION  # AWS_REGION 兜底 us-west-2，与其余模块同源

logger = logging.getLogger("eval-anything")

_DEFAULT = {"provider": "bedrock", "model": "global.anthropic.claude-sonnet-5",
            "base_url": "", "secret_id": ""}

# converse 每个会话都要调，配置读缓存 60s 足够新鲜
CACHE_TTL_S = 60
_cache: dict = {"cfg": None, "at": 0.0}

# API key 与配置**同窗**（同一个 CACHE_TTL_S）：OpenAI provider 下取 key 是每会话
# 必经之路（strands_model 逐会话诊断 / 评估器构造、_openai_client 每次 converse），
# 每次都新建 secretsmanager client 打一发 get_secret_value = 每会话白付网络往返。
# 三条纪律：
#   · **只进内存**：这个 dict 是唯一住址 —— 不落盘、不进日志、不进 DynamoDB
#     （模块头注释的既有约束，set_config 存的配置项里从来没有 key）；
#   · **失败不缓存**：把「没有 api_key 字段」或一次限流缓存下来，就会让「修好
#     secret 再重跑」在 60 秒内继续报同一个错；
#   · **存配置即失效**：set_config 的存前探测必须打真的密钥，不许拿缓存值验过关。
_key_cache: dict[str, tuple[str, float]] = {}


def get_config() -> dict:
    if _cache["cfg"] and time.time() - _cache["at"] < CACHE_TTL_S:
        return dict(_cache["cfg"])
    cfg = dict(_DEFAULT)
    try:
        item = catalog.get_table().get_item(
            Key={"pk": "CONFIG", "sk": "judge_model"}).get("Item")
        if item:
            data = json.loads(item.get("data") or "{}")
            cfg.update({k: data.get(k, cfg[k]) for k in cfg})
    except Exception:
        logger.exception("judge config read failed; using default")
    _cache["cfg"] = dict(cfg)
    _cache["at"] = time.time()
    return cfg


def set_config(cfg: dict) -> dict:
    """Validate + live-probe + persist. Raises ValueError with 中文 message."""
    # 密钥缓存先作废：存前那一发探测要打**真的**密钥（用户可能刚轮换过），
    # 拿一个 ≤60s 的缓存值验过关就等于把探测的意义抹掉。
    _key_cache.clear()
    provider = cfg.get("provider", "bedrock")
    model = (cfg.get("model") or "").strip()
    if provider not in ("bedrock", "openai"):
        raise ValueError("provider 只支持 bedrock / openai")
    if not model:
        raise ValueError("模型名必填")
    out = {"provider": provider, "model": model,
           "base_url": (cfg.get("base_url") or "").strip(),
           "secret_id": (cfg.get("secret_id") or "").strip()}
    if provider == "openai":
        if not out["base_url"].startswith("http"):
            raise ValueError("OpenAI 兼容端点需要 base_url（如 https://api.example.com/v1）")
        if not out["secret_id"].startswith("eval-anything/"):
            raise ValueError("API key 的 Secret 名必须以 'eval-anything/' 开头"
                             "（内容为 {\"api_key\": \"sk-...\"}，密钥只存 Secrets Manager）")
    # 存之前打一发 1-token 探测：配置错了当场报，而不是下次运行才炸
    try:
        _probe(out)
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"模型探测失败：{e}") from e
    catalog.get_table().put_item(Item={
        "pk": "CONFIG", "sk": "judge_model",
        "data": json.dumps(out, ensure_ascii=False),
        "updated_at": int(time.time()),
    })
    _cache["cfg"] = dict(out)
    _cache["at"] = time.time()
    return out


def _probe(cfg: dict) -> None:
    if cfg["provider"] == "bedrock":
        client = boto3.client("bedrock-runtime", region_name=REGION,
                              config=BotoConfig(read_timeout=30, connect_timeout=10))
        client.converse(modelId=cfg["model"],
                        messages=[{"role": "user", "content": [{"text": "ping"}]}],
                        inferenceConfig={"maxTokens": 4})
    else:
        _openai_client(cfg).chat.completions.create(
            model=cfg["model"], max_tokens=4,
            messages=[{"role": "user", "content": "ping"}])


def _api_key(secret_id: str) -> str:
    hit = _key_cache.get(secret_id)
    if hit and time.time() - hit[1] < CACHE_TTL_S:
        return hit[0]
    raw = boto3.client("secretsmanager", region_name=REGION) \
        .get_secret_value(SecretId=secret_id)["SecretString"]
    key = (json.loads(raw) or {}).get("api_key", "")
    if not key:
        raise ValueError(f"Secret '{secret_id}' 里没有 api_key 字段")
    # 只有成功取到才写缓存（失败不缓存，见上）
    _key_cache[secret_id] = (key, time.time())
    return key


def _openai_client(cfg: dict):
    from openai import OpenAI
    # max_retries 2→4（2026-08-25，与 Bedrock 路同批加深，权衡见 converse 的
    # BotoConfig 注释）：timeout=900 下最坏挂墙时长上界翻倍，但触发重试的是
    # 快速失败的瞬时 5xx/限流，慢响应不重试 —— 上界翻倍换瞬时错不直穿。
    return OpenAI(base_url=cfg["base_url"], api_key=_api_key(cfg["secret_id"]),
                  timeout=900.0, max_retries=4)


def default_model() -> str:
    """The configured judge model name — replaces registry.DEFAULT_JUDGE_MODEL
    at call sites so estimates/labels follow the configuration."""
    return get_config()["model"]


def strands_model(model: str | None = None):
    """What strands evaluators / diagnosis get as their `model` argument.

    Bedrock: the model-id string (SDK builds BedrockModel itself).
    OpenAI: an OpenAIModel instance pointed at the configured endpoint.
    model= overrides the model NAME within the configured provider.
    """
    cfg = get_config()
    name = model or cfg["model"]
    if cfg["provider"] == "bedrock":
        return name
    from strands.models.openai import OpenAIModel
    return OpenAIModel(
        client_args={"base_url": cfg["base_url"], "api_key": _api_key(cfg["secret_id"])},
        model_id=name, params={"max_tokens": 8000})


def _tool_to_openai(tool_spec: dict) -> dict:
    """Bedrock toolSpec -> OpenAI function tool."""
    ts = tool_spec.get("toolSpec", tool_spec)
    return {"type": "function",
            "function": {"name": ts["name"],
                         "description": ts.get("description", ""),
                         "parameters": ts.get("inputSchema", {}).get("json", {})}}


def converse(model: str | None, system: str | None, user_text: str,
             max_tokens: int, tool_spec: dict | None = None,
             force_tool: str | None = None) -> dict:
    """Provider-routed single-turn call. Blocking（call sites wrap in to_thread）.

    Returns {"text": str, "tool_input": dict|None, "stop_reason": str}.
    """
    cfg = get_config()
    name = model or cfg["model"]
    if cfg["provider"] == "bedrock":
        client = boto3.client(
            "bedrock-runtime", region_name=REGION,
            # 8k-16k tokens with a reasoning block can outrun botocore's 60s default.
            # 重试预算 2→4（2026-08-25）：ServiceUnavailable 类瞬时 5xx 在 2 次
            # 预算下两发就把「reached max retries: 2」直穿到用户界面。权衡
            # （read_timeout=900 语境）：最坏挂墙时长上界随尝试次数翻倍
            # （~2×900s → ~4×900s），但吃满重试的是**秒级快速失败**的 5xx/限流
            # （退避只多几十秒）；慢响应是一次读到底，本就不触发重试 —— 上界
            # 翻倍在实践里几乎摸不到，换来瞬时 503 不再直穿。
            config=BotoConfig(read_timeout=900, connect_timeout=30,
                              retries={"max_attempts": 4}))
        kwargs: dict = {
            "modelId": name,
            "messages": [{"role": "user", "content": [{"text": user_text}]}],
            "inferenceConfig": {"maxTokens": max_tokens},
        }
        if system:
            kwargs["system"] = [{"text": system}]
        if tool_spec:
            tool_config: dict = {"tools": [tool_spec]}
            if force_tool:
                tool_config["toolChoice"] = {"tool": {"name": force_tool}}
            kwargs["toolConfig"] = tool_config
        resp = client.converse(**kwargs)
        blocks = resp["output"]["message"]["content"]
        return {
            "text": "\n".join(b["text"] for b in blocks if "text" in b),
            "tool_input": next((b["toolUse"]["input"] for b in blocks if "toolUse" in b), None),
            "stop_reason": resp.get("stopReason", ""),
        }

    client = _openai_client(cfg)
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user_text})
    kwargs = {"model": name, "messages": messages, "max_tokens": max_tokens}
    if tool_spec:
        kwargs["tools"] = [_tool_to_openai(tool_spec)]
        if force_tool:
            kwargs["tool_choice"] = {"type": "function", "function": {"name": force_tool}}
    resp = client.chat.completions.create(**kwargs)
    choice = resp.choices[0]
    tool_input = None
    for tc in (choice.message.tool_calls or []):
        if not force_tool or tc.function.name == force_tool:
            try:
                tool_input = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError:
                tool_input = None
            break
    return {"text": choice.message.content or "",
            "tool_input": tool_input,
            "stop_reason": choice.finish_reason or ""}
