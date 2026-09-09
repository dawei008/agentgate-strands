"""eval-anything: observability-based evaluation service hosted on AgentCore Runtime.

Actions (JSON payload):
  {"action": "discover", "refresh": false}
      -> single event listing READY agents and whether they have runtime logs.
         Served from the DynamoDB catalog; refresh=true re-scans AgentCore
         and CloudWatch, then rewrites the catalog.
  {"action": "evaluators"}
      -> single event listing selectable evaluator names.
  {"action": "sessions", "agent_names": [...], "max_sessions": 10,
   "lookback_days": 30, "refresh": false}
      -> one sessions event per agent listing recent session ids.
         Cached per agent+params in DynamoDB; refresh=true re-runs the
         Logs Insights enumeration.
  {"action": "evaluate", "agent_names": [...], "max_sessions": 5,
   "lookback_days": 30, "evaluators": [...], "judge_model": "...",
   "sessions": {"agent": ["session-id", ...]}}
      -> stream of progress events, ending with a full report event.
         When "sessions" is given, exactly those sessions are evaluated;
         otherwise the most recent max_sessions per agent are used.

Every yielded event is a JSON-serializable dict with an "event" field.
"""

import asyncio
import json
import logging
import os
import queue
import threading
from datetime import datetime, timezone

import patches

patches.apply()

from bedrock_agentcore.runtime import BedrockAgentCoreApp

import agentstatus
import catalog
import diagnosis as diagnosis_mod
import evalcache
import fleetstatus
import improve
import judgellm
import plan as plan_mod
import planrun
import plansched
import metrics as metrics_mod
import observe
import pricing
import probe
import redteam as redteam_mod
import runstore
import sessioncompare
import testrun
import topology
import tracesource
import transcript as transcript_mod
from discovery import REGION, list_agents
from registry import (
    DEFAULT_EVALUATORS,
    available_evaluators,
    build_evaluators,
    dataset_evaluator_names,
    evaluator_descriptions,
    evaluator_scopes,
    multimodal_evaluator_names,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("eval-anything")

DEFAULT_MAX_SESSIONS = 5
DEFAULT_LOOKBACK_DAYS = 30
# CloudFront's origin read timeout (60s) counts silence between bytes, and a
# single session's judge calls can exceed it — heartbeats keep the pipe warm.
HEARTBEAT_SECONDS = 15
# generate_dataset blocks in ONE converse call (~90s observed) with no other
# frames in between, and the web UI flags "waiting" after 10s of stream
# silence (useLiveness.WAITING_AFTER_S) — so its heartbeat must beat faster
# than that, not just faster than CloudFront's 60s.
GEN_HEARTBEAT_SECONDS = 5

app = BedrockAgentCoreApp()


def _auto_configure_agent_events(payload: dict):
    """auto_configure_agent 的同步事件生成器（供 invoke 里的异步泵驱动）。

    产出事件序列：
      autoconf_progress    每试完一个模板一条 {template, ok, error, latency_ms}
      heartbeat            探测静默期间（间隔严格小于 probe.POOL_TIMEOUT_S）
      agent_autoconfigured 终态，outcome 五分派：
        saved              首次配置（现有配置==默认值）且推断 high → 已落库
        unchanged          推断结果与现有配置一致 → 无需改动
        confirm_overwrite  已有非默认配置且推断值不同 → 不落库，附 current/proposed
        candidates         推断 low → 不落库，附候选列表（前端选择后走 set_agent_config）
        failed             模板全失败，或调用成功但响应里没有字符串字段可推断
    """
    name = (payload.get("agent_name") or "").strip()
    if not name:
        yield {"event": "error", "error": "agent_name is required."}
        return
    cached = catalog.cached_agents()
    agents = {a["agent_name"]: a for a in (cached["agents"] if cached else list_agents())}
    agent = agents.get(name)
    if not agent:
        yield {"event": "error", "error": f"unknown agent: {name}"}
        return

    current = catalog.get_agent_config(name)

    # 模板池探测跑在工作线程里；attempt 经队列流回本生成器，逐条转成
    # autoconf_progress —— 前端能看着模板一个个被试，而不是黑盒 80s。
    q: queue.Queue = queue.Queue()
    box: dict = {}

    def _worker():
        try:
            box["pool"] = probe.probe_with_template_pool(
                agent, payload.get("sample_input"),
                on_attempt=lambda a: q.put(("attempt", a)))
        except Exception as e:  # probe_with_template_pool 自身不抛；兜底配置类故障
            logger.exception("auto configure probe failed for %s", name)
            box["error"] = f"{type(e).__name__}: {e}"
        finally:
            q.put(("done", None))

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    # 心跳间隔必须严格小于单次探测超时（POOL_TIMEOUT_S），理由同 probe_agent_invoke。
    hb = min(HEARTBEAT_SECONDS, probe.POOL_TIMEOUT_S // 3)
    while True:
        try:
            kind, item = q.get(timeout=hb)
        except queue.Empty:
            yield {"event": "heartbeat", "phase": "auto_configure_agent", "agent": name}
            continue
        if kind == "done":
            break
        yield {"event": "autoconf_progress", "agent_name": name,
               "template": item["template"], "ok": item["ok"],
               "error": item.get("error"), "latency_ms": item.get("latency_ms")}
    t.join()

    pool = box.get("pool")
    attempts = (pool or {}).get("attempts", [])
    base = {"event": "agent_autoconfigured", "agent_name": name,
            "attempts_total": len(attempts)}

    # 全失败：attempts 完整保留（前端展示已试模板表）
    if not pool or not pool.get("ok"):
        yield {**base, "outcome": "failed", "attempts": attempts,
               "error": (pool or {}).get("error") or box.get("error")
               or "所有模板均探测失败。"}
        return

    inferred = probe.infer_response_path(pool.get("response_paths") or [],
                                         pool.get("extracted_text"))
    winner = pool.get("winner_template")
    stats = {"template": winner, "latency_ms": pool.get("latency_ms"),
             "response_bytes": pool.get("response_bytes")}

    if inferred["confidence"] == "none":
        # 模板通了但响应里没有任何字符串字段——没有候选可给，按失败处理并说明。
        yield {**base, "outcome": "failed", "attempts": attempts, **stats,
               "error": "调用成功，但响应里没有任何字符串字段，无法推断输出路径；"
                        "请手动探测并检查响应结构。"}
        return

    if inferred["confidence"] == "low":
        yield {**base, "outcome": "candidates", **stats,
               "confidence": "low", "candidates": inferred["candidates"],
               "attempts": attempts}
        return

    # high（含 plaintext：best=""）
    proposed_path = inferred["best"] or ""
    same = (probe.normalize_template(winner or "")
            == probe.normalize_template(current.get("payload_template") or "")
            and proposed_path == (current.get("response_path") or ""))
    # "首次配置"的判据按值而非按有无记录：现有配置等于出厂默认（模板==DEFAULT
    # 且 path==""）就视为从未被有意配置过，直接落库不打扰用户。
    is_default = (probe.normalize_template(current.get("payload_template") or "")
                  == probe.normalize_template(catalog.DEFAULT_AGENT_CONFIG["payload_template"])
                  and not (current.get("response_path") or ""))

    if is_default:
        # 首次配置：直接落库，标 configured_by=auto（即使推断值恰好等于默认值，
        # 也落一条——记录"自动推断确认过这套配置"）
        catalog.set_agent_config(name, winner, proposed_path, configured_by="auto")
        yield {**base, "outcome": "saved", **stats,
               "confidence": "high", "response_path": proposed_path,
               "plaintext": inferred["plaintext"]}
        return
    if same:
        yield {**base, "outcome": "unchanged", **stats,
               "confidence": "high", "response_path": proposed_path,
               "plaintext": inferred["plaintext"]}
        return
    # 已有非默认配置且推断值不同：不落库，交前端弹确认（确认后走既有
    # set_agent_config action 落库）。
    yield {**base, "outcome": "confirm_overwrite", **stats,
           "confidence": "high",
           "current": {"payload_template": current.get("payload_template"),
                       "response_path": current.get("response_path", ""),
                       "updated_at": current.get("updated_at"),
                       "configured_by": current.get("configured_by")},
           "proposed": {"payload_template": winner,
                        "response_path": proposed_path,
                        "plaintext": inferred["plaintext"]},
           "attempts": attempts}


@app.entrypoint
async def invoke(payload, context=None):
    action = (payload or {}).get("action", "discover")

    if action == "discover":
        refresh = bool(payload.get("refresh"))
        result = None if refresh else catalog.cached_agents()
        from_cache = result is not None
        catalog_refresh = None
        if result is None:
            result = catalog.refresh_agents()
        else:
            # 目录超过 24h 窗口 ⇒ 首页打开就自动重扫一次（不等人点「重新扫描」）；失败照旧回
            # 旧目录，但失败写进 catalog_refresh 让页面看得见（契约见 payload-contract discover 节）。
            result, from_cache, catalog_refresh = catalog.refresh_if_stale(result)
        yield {
            "event": "agents",
            "region": REGION,
            "agents": result["agents"],
            "from_cache": from_cache,
            "refreshed_at": result["refreshed_at"],
            "catalog_refresh": catalog_refresh,
        }
        return

    if action == "evaluators":
        yield {
            "event": "evaluators",
            "available": available_evaluators(),
            "dataset_only": dataset_evaluator_names(),
            # dataset-only as well, and additionally require a case image_key
            "multimodal": multimodal_evaluator_names(),
            # 内置评估器 -> 适用环节（["observe","dataset"] 或 ["dataset"]）；
            # custom 各项自带 "scope"（"all"|"observe"|"dataset"）。
            "scopes": evaluator_scopes(),
            # 内置评估器 -> 一句中文描述（additive，老前端不读不炸）；
            # custom 的描述前端取各项 blocks.goal，不进这个 map。
            "descriptions": evaluator_descriptions(),
            "custom": catalog.list_custom_evaluators(),
            "metrics": metrics_mod.METRIC_KEYS,
            "default": DEFAULT_EVALUATORS,
            "default_metrics": metrics_mod.METRIC_KEYS,
            "default_judge_model": judgellm.default_model(),
        }
        return

    # ---------- judge 模型配置（Bedrock / OpenAI 兼容端点） ----------
    if action == "get_judge_config":
        cfg = judgellm.get_config()
        yield {"event": "judge_config", **cfg}
        return

    if action == "set_judge_config":
        try:
            saved = await asyncio.to_thread(judgellm.set_config, payload.get("config") or {})
        except ValueError as e:
            yield {"event": "error", "error": str(e)}
            return
        except Exception as e:
            logger.exception("set_judge_config failed")
            yield {"event": "error", "error": f"保存失败：{e}"}
            return
        yield {"event": "judge_config_saved", **saved}
        return

    if action == "create_custom_evaluator":
        name = (payload.get("name") or "").strip()
        rubric = (payload.get("rubric") or "").strip()
        scope = (payload.get("scope") or "all").strip()
        if not name or not rubric:
            yield {"event": "error", "error": "name and rubric are required."}
            return
        # evaluator_scopes() 覆盖全部内置名（含 dataset-only 与 mm_*），
        # 比 available_evaluators() 更全 —— 防止自定义名遮蔽内置评估器。
        if name in evaluator_scopes() or name in metrics_mod.METRIC_KEYS:
            yield {"event": "error", "error": f"'{name}' collides with a builtin name."}
            return
        blocks = payload.get("blocks")
        try:
            saved = catalog.create_custom_evaluator(name, rubric, scope, blocks=blocks)
        except ValueError as e:
            yield {"event": "error", "error": str(e)}
            return
        yield {"event": "custom_evaluator_created", "name": name, "scope": scope,
               "updated_at": saved["updated_at"]}
        return

    if action == "delete_custom_evaluator":
        name = (payload.get("name") or "").strip()
        catalog.delete_custom_evaluator(name)
        yield {"event": "custom_evaluator_deleted", "name": name}
        return

    # ---------- dataset management ----------
    if action == "list_datasets":
        yield {"event": "datasets", "datasets": catalog.list_datasets()}
        return

    if action == "save_dataset":
        try:
            catalog.save_dataset(payload["name"], payload["cases"],
                                 payload.get("source_keys"),
                                 kind=payload.get("kind"),
                                 target_agent=payload.get("target_agent"),
                                 risk_categories=payload.get("risk_categories"),
                                 create_only=bool(payload.get("create_only")))
        except (KeyError, ValueError) as e:
            yield {"event": "error", "error": str(e)}
            return
        except Exception as e:
            # 兜底（P1 数据丢失同族）：catalog 的体积预检拦掉了已知的 400KB
            # 超限，但 DynamoDB 还能因限流/凭证/传输拒绝写入，那些都不是
            # ValueError。任何异常穿出这个 async generator，流上就只剩框架层
            # 一帧无 `event` 字段的遗言（bedrock_agentcore/runtime/app.py:
            # 887-891），前端只能报「未收到 dataset_saved」把真因盖掉。写库失败
            # 必须有应用层遗言；traceback 照旧进 CloudWatch。
            logger.exception("save_dataset failed: %s", payload.get("name"))
            yield {"event": "error",
                   "error": f"保存数据集失败：{type(e).__name__}: {str(e)[:300]}"}
            return
        yield {"event": "dataset_saved", "name": payload["name"]}
        return

    # 坏例入数据集（ADR-0017 D1）：服务端读 → 校验 → 去重 → 追加 → 条件写，
    # 前端不做读改写。契约见 docs/payload-contract.md「append_dataset_cases」。
    if action == "append_dataset_cases":
        try:
            result = catalog.append_dataset_cases(
                payload.get("dataset"), payload.get("cases"), payload.get("kind"),
                create_if_missing=bool(payload.get("create_if_missing")),
                target_agent=payload.get("target_agent"),
                on_duplicate=payload.get("on_duplicate") or "skip")
        except (KeyError, ValueError, TypeError) as e:
            yield {"event": "error", "error": str(e)}
            return
        except Exception as e:
            # 与 save_dataset 同一条理由：写库失败必须有应用层遗言，不许只剩框架层一帧。
            logger.exception("append_dataset_cases failed: %s", payload.get("dataset"))
            yield {"event": "error",
                   "error": f"追加用例失败：{type(e).__name__}: {str(e)[:300]}"}
            return
        yield {"event": "dataset_cases_appended", **result}
        return

    if action == "delete_dataset":
        catalog.delete_dataset(payload.get("name", ""))
        yield {"event": "dataset_deleted", "name": payload.get("name", "")}
        return

    if action == "set_agent_config":
        try:
            catalog.set_agent_config(payload["agent_name"], payload["payload_template"],
                                     payload.get("response_path", ""))
        except (KeyError, ValueError, json.JSONDecodeError) as e:
            yield {"event": "error", "error": f"invalid template: {e}"}
            return
        yield {"event": "agent_config_set", "agent_name": payload["agent_name"]}
        return

    if action == "get_agent_config":
        name = payload.get("agent_name", "")
        yield {"event": "agent_config", "agent_name": name, **catalog.get_agent_config(name)}
        return

    # ---------- Agent 显示元数据（显示名 + 版本标签，见 catalog.set_agent_meta） ----------
    # 读路径不另开 action：discover 的每行已带 display_name / version_label
    # （catalog.apply_agent_meta 叠加）。写的是**展示层**元数据，agent_name
    # 关联键一律不动（护栏 2）。
    if action == "set_agent_meta":
        name = (payload.get("agent_name") or "").strip()
        if not name:
            yield {"event": "error", "error": "agent_name is required."}
            return
        try:
            saved = catalog.set_agent_meta(
                name,
                display_name=payload.get("display_name"),
                version_label=payload.get("version_label"))
        except ValueError as e:
            yield {"event": "error", "error": str(e)}
            return
        yield {"event": "agent_meta_set", "agent_name": name, **saved}
        return

    # ---------- per-agent span (trace) source: centralized aws/spans etc. ----------
    if action == "get_span_source":
        name = (payload.get("agent_name") or "").strip()
        if not name:
            yield {"event": "error", "error": "agent_name is required."}
            return
        yield {"event": "span_source", "agent_name": name,
               "span_source": catalog.get_span_source(name)}
        return

    if action == "set_span_source":
        name = (payload.get("agent_name") or "").strip()
        if not name:
            yield {"event": "error", "error": "agent_name is required."}
            return
        src = payload.get("span_source") or {}
        try:
            if not (src.get("log_group") or src.get("scope_filter")
                    or src.get("service_filter")):
                # all-empty = clear the override, back to the runtime log group
                catalog.delete_span_source(name)
                yield {"event": "span_source_set", "agent_name": name, "span_source": None}
                return
            catalog.set_span_source(name, src.get("log_group", ""),
                                    src.get("scope_filter", ""),
                                    src.get("service_filter", ""))
        except ValueError as e:
            yield {"event": "error", "error": str(e)}
            return
        yield {"event": "span_source_set", "agent_name": name,
               "span_source": catalog.get_span_source(name)}
        return

    if action == "probe_agent_invoke":
        # 调用模板连通性探测：按模板发一次真实调用，把原始响应结构回给前端，
        # 让用户在保存模板前确认 payload 形状与 response_path。只调一次、
        # 不写任何评估结果/缓存/run 记录（见 probe.py）。
        name = (payload.get("agent_name") or "").strip()
        if not name:
            yield {"event": "error", "error": "agent_name is required."}
            return
        cached = catalog.cached_agents()
        agents = {a["agent_name"]: a for a in (cached["agents"] if cached else list_agents())}
        agent = agents.get(name)
        if not agent:
            yield {"event": "error", "error": f"unknown agent: {name}"}
            return
        import probe as probe_mod
        # response_path 走 payload.get()：缺键得到 None（=用已保存规则），
        # 传 "" 表示"不提取、整段文本即输出"。三态语义见 probe.py 顶部注释 ——
        # 这里不要加 `or ""` 之类的默认值，会吃掉其中一种语义。
        probe_task = asyncio.ensure_future(asyncio.to_thread(
            probe_mod.probe_invoke, agent,
            payload.get("payload_template"), payload.get("sample_input"),
            payload.get("response_path")))
        # 探测最长 probe.DEFAULT_TIMEOUT_S(45s)。约束：心跳间隔必须**严格小于**
        # 探测超时，否则 boto 抛 ReadTimeout 前的最后一段静默会贴上 CloudFront
        # 的 60s 源静默墙，用户看到 504 而不是我们的超时文案。这里用 min() 把
        # 约束写死，改 HEARTBEAT_SECONDS 或探测超时都不会破坏它。
        probe_hb = min(HEARTBEAT_SECONDS, probe_mod.DEFAULT_TIMEOUT_S // 3)
        while True:
            done, _ = await asyncio.wait({probe_task}, timeout=probe_hb)
            if done:
                break
            yield {"event": "heartbeat", "phase": "probe_agent_invoke", "agent": name}
        try:
            out = probe_task.result()
        except Exception as e:  # probe_invoke 自身不抛；这里兜底配置类故障
            logger.exception("invoke probe failed for %s", name)
            yield {"event": "error", "error": f"探测失败：{e}"}
            return
        yield {"event": "invoke_probed", "agent_name": name, **out}
        return

    if action == "auto_configure_agent":
        # 调用配置一键推断：模板池逐个真实探测（每模板 20s、最多 4 个），推断
        # 输出路径，按置信度与现有配置决定 saved/unchanged/confirm_overwrite/
        # candidates/failed（见 _auto_configure_agent_events）。生成器内部自带
        # 心跳（等待间隔严格小于单模板超时），这里只需逐个事件泵出。
        gen = _auto_configure_agent_events(payload)
        _END = object()
        while True:
            ev = await asyncio.to_thread(next, gen, _END)
            if ev is _END:
                break
            yield ev
        return

    if action == "generate_dataset":
        context = (payload.get("context") or "").strip()
        num_cases = min(int(payload.get("num_cases", 10)), 50)
        agent_name = (payload.get("agent_name") or "").strip()

        # archive source material (attachments + pasted context) to S3
        import base64
        artifacts_bucket = os.environ.get("ARTIFACTS_BUCKET", "")
        archive_prefix = f"sources/{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
        source_keys = []
        # 同一个缓存单例（runstore._s3）：同区同桶，省掉每次上传新建连接池 + TLS
        s3c = runstore._s3() if artifacts_bucket else None
        if s3c and context:
            key = f"{archive_prefix}/pasted-context.txt"
            try:
                s3c.put_object(Bucket=artifacts_bucket, Key=key,
                               Body=context.encode(), ContentType="text/plain; charset=utf-8")
                source_keys.append(key)
            except Exception:
                logger.exception("context archive failed")

        # attachments: [{name, content_base64}] — parsed to text by extension
        attachment_notes = []
        for att in (payload.get("attachments") or [])[:5]:
            name = att.get("name", "attachment")
            try:
                raw = base64.b64decode(att.get("content_base64", ""))
                if s3c:
                    key = f"{archive_prefix}/{name}"
                    try:
                        s3c.put_object(Bucket=artifacts_bucket, Key=key, Body=raw)
                        source_keys.append(key)
                    except Exception:
                        logger.exception("attachment archive failed: %s", name)
                if len(raw) > 5 * 1024 * 1024:
                    attachment_notes.append(f"（{name} 超过 5MB，已跳过）")
                    continue
                if name.lower().endswith(".pdf"):
                    import io
                    from pypdf import PdfReader
                    reader = PdfReader(io.BytesIO(raw))
                    text = "\n".join((p.extract_text() or "") for p in reader.pages[:50])
                else:  # txt/md/json/csv and other text-like formats
                    text = raw.decode("utf-8", errors="replace")
                text = text.strip()
                if not text:
                    attachment_notes.append(f"（{name} 未解析出文本，已跳过）")
                    continue
                context += f"\n\n【附件: {name}】\n{text[:20000]}"
                attachment_notes.append(f"{name}: 已解析 {len(text)} 字符" +
                                        ("（截取前 2 万字）" if len(text) > 20000 else ""))
            except Exception as e:
                logger.exception("attachment parse failed: %s", name)
                attachment_notes.append(f"（{name} 解析失败: {str(e)[:80]}）")

        # optionally enrich context with the target agent's system prompt
        agent_context = ""
        if agent_name:
            try:
                cached = catalog.cached_agents()
                agents = {a["agent_name"]: a for a in (cached["agents"] if cached else list_agents())}
                agent = agents.get(agent_name)
                if agent and agent.get("has_logs"):
                    sess = catalog.cached_sessions(agent_name, 30, 1, True) \
                        or catalog.refresh_sessions(agent_name, agent.get("log_group"), 30, 1,
                                                    True, agent=agent)
                    if sess["sessions"]:
                        data, _ = tracesource.get_evaluation_data(
                            agent, sess["sessions"][0]["session_id"], 30)
                        tr = transcript_mod.build_transcript(data["trajectory"])
                        if tr.get("system_prompt"):
                            agent_context = f"\n\n【被测 Agent 的系统提示词（真实提取）】\n{tr['system_prompt'][:4000]}"
            except Exception:
                logger.exception("agent context extraction failed")

        # extend mode: append coverage-gap cases to an existing dataset instead
        # of generating from scratch. Existing cases are shown to the model as
        # reference so new ones don't duplicate them (the priming pattern
        # ExperimentGenerator.update_current_experiment_async uses).
        extend_from = (payload.get("extend_dataset") or "").strip()
        existing_cases = []
        if extend_from:
            ds = catalog.get_dataset(extend_from)
            if not ds:
                yield {"event": "error", "error": f"dataset '{extend_from}' not found"}
                return
            existing_cases = ds["cases"]

        if not context and not agent_context and not existing_cases:
            yield {"event": "error", "error": "请提供文档/描述，或指定一个可提取上下文的 Agent。"}
            return

        # 形态锁（ADR-0009）：case_shape=single 纯单轮 / multi 纯多轮任务。
        # 缺省按 kind 推（regression→single, simulation→multi）；extend 模式按被
        # 追加集合的现有形态推断——追加不得改变集合归类侧（mm-probe 搬家事故的
        # 直接堵点）。两者都缺 = 老调用，保持原混合 prompt 不变。
        case_shape = (payload.get("case_shape") or "").strip()
        req_kind = (payload.get("kind") or "").strip()
        if case_shape not in ("", "single", "multi"):
            yield {"event": "error", "error": f"case_shape 必须是 single/multi，收到 '{case_shape}'"}
            return
        if not case_shape and req_kind:
            case_shape = {"regression": "single", "simulation": "multi"}.get(req_kind, "")
        if extend_from:
            if existing_cases:
                case_shape = "multi" if any(
                    str(c.get("task_description") or "").strip() for c in existing_cases
                ) else "single"
            elif ds.get("kind") in ("regression", "simulation"):
                case_shape = "single" if ds["kind"] == "regression" else "multi"

        # Bedrock toolSpec：schema 里根本没有多轮字段（single）/ task_description
        # 必填（multi），additionalProperties=false —— 模型无处可放，比 prompt 叮嘱硬。
        _case_base = {
            "name": {"type": "string"},
            "input": {"type": "string"},
            "expected_output": {"type": "string"},
            "category": {"type": "string"},
            "gap_reason": {"type": "string"},
        }
        single_tool = {"toolSpec": {
            "name": "emit_cases",
            "description": "提交生成的单轮测试用例列表。",
            "inputSchema": {"json": {
                "type": "object",
                "properties": {"cases": {"type": "array", "items": {
                    "type": "object", "properties": dict(_case_base),
                    "required": ["name", "input", "expected_output", "category"],
                    "additionalProperties": False}}},
                "required": ["cases"], "additionalProperties": False}}}}
        multi_tool = {"toolSpec": {
            "name": "emit_cases",
            "description": "提交生成的多轮模拟任务列表。",
            "inputSchema": {"json": {
                "type": "object",
                "properties": {"cases": {"type": "array", "items": {
                    "type": "object",
                    "properties": {**_case_base,
                                   "task_description": {"type": "string"},
                                   "max_turns": {"type": "integer",
                                                 "minimum": 2, "maximum": 8},
                                   "persona": {"type": "string"}},
                    "required": ["name", "input", "expected_output", "category",
                                 "task_description", "max_turns"],
                    "additionalProperties": False}}},
                "required": ["cases"], "additionalProperties": False}}}}
        tool_spec = force_tool = None
        if case_shape == "single":
            tool_spec, force_tool = single_tool, "emit_cases"
            shape_rule = ("全部为**单轮**用例：不要生成 task_description / max_turns / "
                          "persona 字段，多轮追问场景改写成一条信息完整的单轮输入。")
            fmt_hint = '[{"name":"...","input":"...","expected_output":"...","category":"..."}]'
        elif case_shape == "multi":
            tool_spec, force_tool = multi_tool, "emit_cases"
            shape_rule = ("每条都是**多轮对话任务**：必须有 task_description（模拟用户的完整目标，"
                          "如\"完成改签并确认新航班时间\"）和 max_turns（2-8 的整数）；persona 可选"
                          "（有挑战性的用户人设，如\"不耐烦，一次只透露一点信息\"）。"
                          "input 是用户第一句话，往往信息不完整，需要 Agent 多轮追问。")
            fmt_hint = ('[{"name":"...","input":"...","expected_output":"...","category":"...",'
                        '"task_description":"...","max_turns":5,"persona":"（可选）"}]')
        else:
            shape_rule = fmt_hint = None

        if existing_cases:
            coverage = {}
            for c in existing_cases:
                coverage[c.get("category") or "未分类"] = coverage.get(c.get("category") or "未分类", 0) + 1
            rule = shape_rule or "约 1/3 设为多轮用例：加 task_description、max_turns（3-6）、persona。"
            fmt = fmt_hint or ('[{"name":"...","input":"...","expected_output":"...","category":"...",'
                               '"gap_reason":"...","task_description":"（仅多轮）","max_turns":5,'
                               '"persona":"（仅多轮，可选）"}]')
            gen_prompt = f"""你要为一个**已有的测试集补充覆盖缺口**。现有 {len(existing_cases)} 条用例，
按 category 分布：{json.dumps(coverage, ensure_ascii=False)}

【现有用例（不要重复，也不要只做同义改写）】
{json.dumps([{k: v for k, v in c.items() if k in ('name', 'input', 'category', 'task_description')}
             for c in existing_cases[:60]], ensure_ascii=False)}

【任务】生成 {num_cases} 条**新增**用例，要求：
1. 优先补齐现有用例没覆盖到的场景：分布稀疏或缺失的 category、缺失的边界条件、
   缺失的失败/拒绝路径、缺失的模糊/对抗输入；
2. 每条用例加 `gap_reason` 字段，一句话说明它补的是哪个缺口（供人工审阅判断）；
3. name 不得与现有用例重名（用简短英文 kebab-case）；
4. input 是用户会真实说出的话；expected_output 写"期望要点"（判分依据，不是逐字答案）；
5. 难度有梯度；{rule}

【补充资料（可能为空）】
{context}{agent_context}

只输出 JSON 数组，不要任何其他文字，格式：
{fmt}"""
        else:
            rule = shape_rule or ('约 1/3 的用例设为**多轮对话**用例：加 task_description（模拟用户的完整目标，'
                                  '如"完成改签并确认新航班时间"）、max_turns（3-6）、persona（有挑战性的用户人设，'
                                  '如"不耐烦，一次只透露一点信息"或"中途改主意"）。多轮用例的 input 是用户第一句话，'
                                  '往往信息不完整，需要 Agent 多轮追问。单轮用例不加这三个字段。')
            fmt = fmt_hint or ('[{"name":"...","input":"...","expected_output":"...","category":"...",'
                               '"task_description":"（仅多轮）","max_turns":5,"persona":"（仅多轮，可选）"}]')
            gen_prompt = f"""基于以下资料，为 AI Agent 生成 {num_cases} 条高质量测试用例。

【要求】
1. 覆盖：正常场景、边界条件、失败/拒绝场景、模糊输入，难度有梯度；
2. input 是用户会真实说出的话（与资料语言一致）；
3. expected_output 写"期望要点"（判分依据，不是逐字答案）；
4. category 用简短中文标签分类；
5. name 用简短英文 kebab-case；
6. {rule}

【资料】
{context}{agent_context}

只输出 JSON 数组，不要任何其他文字，格式：
{fmt}"""

        try:
            # Generous cap: on longer prompts (extend mode ships the agent's
            # system prompt plus every existing case) Sonnet 5 emits a
            # reasoningContent block before the JSON. At 4000 the reasoning
            # ate the whole budget and the reply came back with NO text
            # block at all, so the JSON was simply missing.
            # converse 同步阻塞可达 ~90s（single 8 条实测），期间一帧不发的话
            # 前端 liveness 会依次滑到「可能已断开」（其实生成正常在跑），且
            # CloudFront 源读超时按字节间静默计。照 generate_redteam_cases 的
            # 心跳先例起任务 + 定期心跳，全程停在「链路正常」档。
            conv_task = asyncio.ensure_future(asyncio.to_thread(
                judgellm.converse, payload.get("judge_model"), None, gen_prompt, 16000,
                tool_spec=tool_spec, force_tool=force_tool))
            while True:
                done, _ = await asyncio.wait({conv_task},
                                             timeout=GEN_HEARTBEAT_SECONDS)
                if done:
                    break
                yield {"event": "heartbeat", "phase": "generate_dataset"}
            resp = conv_task.result()
            tool_input = resp.get("tool_input")
            if isinstance(tool_input, dict) and isinstance(tool_input.get("cases"), list):
                cases = tool_input["cases"]
            else:
                # 兜底：强制工具没生效（provider 不支持/模型越狱），沿用文本 JSON 抽取
                text = resp["text"]
                if not text:
                    raise RuntimeError(
                        f"模型未返回文本（stopReason={resp['stop_reason']}）。"
                        "通常是 maxTokens 被推理占满，请减少用例数或缩短资料后重试。")
                start, end = text.find("["), text.rfind("]")
                if start < 0 or end <= start:
                    raise RuntimeError(f"模型输出中找不到 JSON 数组：{text[:200]}")
                cases = json.loads(text[start:end + 1])
            if not isinstance(cases, list) or not cases:
                raise RuntimeError("模型输出的 JSON 不是非空数组。")
            if not all(isinstance(c, dict) and c.get("input") for c in cases):
                raise RuntimeError("模型输出的用例缺少 input 字段。")
        except Exception as e:
            logger.exception("dataset generation failed")
            yield {"event": "error", "error": f"生成失败：{e or type(e).__name__}"}
            return

        # 兜底校验（防模型越狱 schema / 文本兜底路径）：single 剥多轮字段并计数，
        # multi 剔除缺 task_description 的条目。
        stripped_fields = 0
        if case_shape == "single":
            for c in cases:
                for k in ("task_description", "max_turns", "persona"):
                    if k in c:
                        c.pop(k, None)
                        stripped_fields += 1
        elif case_shape == "multi":
            kept = [c for c in cases if str(c.get("task_description") or "").strip()]
            if not kept:
                yield {"event": "error",
                       "error": "生成失败：多轮任务全部缺少 task_description，请重试。"}
                return
            cases = kept

        if existing_cases:
            # de-dup by name so an append can't silently shadow an existing case
            taken = {c.get("name") for c in existing_cases}
            for c in cases:
                base = c.get("name") or "new-case"
                n, name = 2, base
                while name in taken:
                    name, n = f"{base}-{n}", n + 1
                c["name"] = name
                taken.add(name)

        yield {"event": "dataset_generated", "cases": cases,
               "agent_context_used": bool(agent_context),
               "attachments": attachment_notes,
               "source_keys": source_keys,
               "case_shape": case_shape or None,
               "stripped_fields": stripped_fields,
               "extend_dataset": extend_from or None,
               "existing_cases": existing_cases if extend_from else None}
        return

    if action == "upload_case_image":
        # Upload one case image and return its S3 key, which the caller writes
        # onto a case as image_key. Images are never inlined into the dataset:
        # a dataset is one DynamoDB item, and base64 images would blow the 400KB
        # limit for the whole case list. The key is all that is stored.
        import base64

        bucket = os.environ.get("ARTIFACTS_BUCKET", "")
        if not bucket:
            yield {"event": "error", "error": "ARTIFACTS_BUCKET 未配置，无法上传图片"}
            return
        name = (payload.get("name") or "image.png").strip().replace("/", "_")
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        fmt = "jpeg" if ext == "jpg" else ext
        # The SDK's ImageData only accepts these four (types/multimodal.py).
        if fmt not in ("jpeg", "png", "gif", "webp"):
            yield {"event": "error",
                   "error": f"不支持的图片格式 '{ext}'：仅支持 jpg/jpeg/png/gif/webp"}
            return
        try:
            raw = base64.b64decode(payload.get("content_base64", ""))
        except Exception as e:
            yield {"event": "error", "error": f"图片解码失败: {str(e)[:120]}"}
            return
        # 5MB is Bedrock's per-image ceiling for the judge call; a bigger file
        # would upload fine and then fail at judging time.
        if not raw or len(raw) > 5 * 1024 * 1024:
            yield {"event": "error",
                   "error": f"图片大小 {len(raw)} 字节无效（须 >0 且 ≤5MB）"}
            return
        key = (f"sources/{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
               f"/images/{name}")
        try:
            runstore._s3().put_object(
                Bucket=bucket, Key=key, Body=raw, ContentType=f"image/{fmt}")
        except Exception as e:
            logger.exception("case image upload failed: %s", name)
            yield {"event": "error", "error": f"上传失败: {str(e)[:200]}"}
            return
        yield {"event": "case_image_uploaded", "name": name, "image_key": key,
               "bytes": len(raw)}
        return

    if action == "get_source_url":
        # presigned download link for an archived source document
        bucket = os.environ.get("ARTIFACTS_BUCKET", "")
        key = payload.get("key", "")
        if not bucket or not key or not key.startswith("sources/"):
            yield {"event": "error", "error": "invalid source key"}
            return
        url = runstore._s3().generate_presigned_url(
            "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=600)
        yield {"event": "source_url", "key": key, "url": url}
        return

    # ---------- dataset test runs ----------
    if action in ("estimate_test_run", "start_test_run"):
        ds_name = payload.get("dataset", "")
        dataset = catalog.get_dataset(ds_name)
        if not dataset:
            yield {"event": "error", "error": f"dataset '{ds_name}' not found"}
            return
        agent_names = payload.get("agent_names") or []
        # Dataset runs *invoke* the target, which needs a Runtime ARN — so this
        # deliberately consults live AgentCore rather than the merged catalog.
        agents = {a["agent_name"]: a for a in list_agents()}
        unknown = [n for n in agent_names if n not in agents]
        if not agent_names or unknown:
            yield {"event": "error", "error": f"agent_names invalid: {unknown or 'empty'}"}
            return
        evaluator_names = payload.get("evaluators") or []
        # infer each agent's model from its recent traces for costing
        agents_meta = {}
        for n in agent_names:
            agents_meta[n] = {"runtime_arn": agents[n]["runtime_arn"],
                              "model": payload.get("agent_models", {}).get(n, ""),
                              # 判官要看被测 Agent 这一次真调了哪些工具，证据在它
                              # 自己的 runtime 日志组里（toolevidence）。不传下去，
                              # dataset 环节就只能按「我没看到」判分。
                              "log_group": agents[n].get("log_group") or ""}
        estimate = testrun.estimate_test_run(dataset, agent_names, evaluator_names, agents_meta)

        if action == "estimate_test_run":
            yield {"event": "test_run_estimate", **estimate}
            return

        custom_defs = {e["name"]: e["rubric"] for e in catalog.list_custom_evaluators()}
        custom_rubrics = {n: custom_defs[n] for n in evaluator_names if n in custom_defs}
        judge_model = payload.get("judge_model") or judgellm.default_model()
        run_id = f"run-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
        yield {"event": "test_run_started", "run_id": run_id, "estimate": estimate}

        turn_queue: asyncio.Queue = asyncio.Queue()
        loop_task = asyncio.ensure_future(testrun.execute_test_run(
            run_id, dataset, agent_names, evaluator_names, judge_model,
            custom_rubrics, agents_meta, estimate, turn_queue=turn_queue,
            cache_mode=payload.get("cache_mode", "off")))
        last_done = -1
        idle = 0.0
        while True:
            # drain live turns with a short poll so conversations stream out
            try:
                ev = await asyncio.wait_for(turn_queue.get(), timeout=1.0)
                idle = 0.0
                yield {"event": "turn", "run_id": run_id, **ev}
                continue
            except asyncio.TimeoutError:
                idle += 1.0
            if loop_task.done() and turn_queue.empty():
                break
            run_state = testrun.get_test_run(run_id, detail=False) or {}
            completed = run_state.get("completed_cases", 0)
            if completed != last_done:
                last_done = completed
                yield {"event": "test_run_progress", "run_id": run_id,
                       "completed": completed, "total": run_state.get("total_cases", 0),
                       "actual_cost_usd": run_state.get("actual_cost_usd", 0)}
                idle = 0.0
            elif idle >= HEARTBEAT_SECONDS:
                yield {"event": "heartbeat", "run_id": run_id}
                idle = 0.0
        try:
            final = loop_task.result()
        except Exception as e:
            logger.exception("test run failed")
            yield {"event": "error", "error": f"test run failed: {e}"}
            return
        yield {"event": "test_run_report", **final}
        return

    # ---------- red teaming ----------
    if action == "redteam_options":
        yield {"event": "redteam_options",
               "strategies": redteam_mod.strategy_menu(),
               "risk_categories": redteam_mod.risk_categories(),
               "default_strategies": redteam_mod.DEFAULT_STRATEGIES,
               "default_risk_categories": redteam_mod.DEFAULT_RISK_CATEGORIES,
               "breach_threshold": redteam_mod.BREACH_THRESHOLD}
        return

    if action == "redteam_target_spec":
        agent_name = (payload.get("agent_name") or "").strip()
        cached = catalog.cached_agents()
        agents = {a["agent_name"]: a for a in (cached["agents"] if cached else list_agents())}
        agent = agents.get(agent_name)
        if not agent:
            yield {"event": "error", "error": f"unknown agent: {agent_name}"}
            return
        try:
            spec = await asyncio.to_thread(redteam_mod.build_target_spec, agent,
                                           int(payload.get("lookback_days", 30)))
        except Exception as e:
            logger.exception("target spec extraction failed")
            yield {"event": "error", "error": f"提取被测 Agent 上下文失败：{e}"}
            return
        yield {"event": "redteam_target_spec", "agent_name": agent_name,
               "system_prompt": spec["system_prompt"], "tools": spec["tools"],
               "model": spec.get("model", ""),
               "warning": None if spec["system_prompt"] else
               "未能从 trace 提取到系统提示词，生成的攻击用例会偏通用；"
               "可手工补充系统提示词后再生成"}
        return

    if action == "generate_redteam_cases":
        agent_name = (payload.get("agent_name") or "").strip()
        spec = {"system_prompt": (payload.get("system_prompt") or "").strip(),
                "tools": payload.get("tools") or []}
        if not spec["system_prompt"] and agent_name:
            cached = catalog.cached_agents()
            agents = {a["agent_name"]: a for a in (cached["agents"] if cached else list_agents())}
            if agents.get(agent_name):
                try:
                    spec = await asyncio.to_thread(
                        redteam_mod.build_target_spec, agents[agent_name])
                except Exception:
                    logger.exception("target spec extraction failed")
        risk_cats = payload.get("risk_categories") or redteam_mod.DEFAULT_RISK_CATEGORIES
        num = max(1, min(int(payload.get("num_cases", 2)), 5))
        judge_model = payload.get("judge_model") or judgellm.default_model()

        # Generation is one judge call per risk category. Even fanned out it can
        # exceed CloudFront's 60s origin read timeout (5 categories of Sonnet 5
        # with reasoning), and a 504 there discards work already paid for. Stream
        # per-category progress + heartbeats the way evaluate/start_test_run do,
        # so the pipe stays warm and the user sees which category landed.
        progress: list[dict] = []
        gen_task = asyncio.ensure_future(redteam_mod.generate_cases(
            spec, risk_cats, num, judge_model,
            on_category=lambda cat, n, err: progress.append(
                {"event": "redteam_gen_progress", "risk_category": cat,
                 "cases": n, "error": err, "done": len(progress) + 1,
                 "total": len(risk_cats)})))
        sent, idle = 0, 0.0
        while True:
            done, _ = await asyncio.wait({gen_task}, timeout=1.0)
            while sent < len(progress):
                yield progress[sent]
                sent += 1
                idle = 0.0
            if done:
                break
            idle += 1.0
            # GEN_ not HEARTBEAT_SECONDS: between per-category progress events
            # this stream can sit silent for a whole LLM call, and 15s beats
            # would let RedteamGenerator's liveness slide to amber "等待响应"
            # (WAITING_AFTER_S=10) — same disease generate_dataset had.
            if idle >= GEN_HEARTBEAT_SECONDS:
                yield {"event": "heartbeat", "phase": "generate_redteam_cases"}
                idle = 0.0
        try:
            cases = gen_task.result()
        except Exception as e:
            logger.exception("redteam case generation failed")
            yield {"event": "error", "error": f"攻击用例生成失败：{e}"}
            return
        # Partial success is still usable: the user reviews cases by hand anyway.
        failed = [p["risk_category"] for p in progress if p.get("error")]
        yield {"event": "redteam_cases_generated", "cases": cases,
               "risk_categories": risk_cats,
               "failed_categories": failed,
               "target_context_used": bool(spec["system_prompt"]),
               "tools_found": len(spec["tools"])}
        return

    if action in ("estimate_redteam_run", "start_redteam_run"):
        agent_name = (payload.get("agent_name") or "").strip()
        cases = payload.get("cases") or []
        strategy_names = payload.get("strategies") or redteam_mod.DEFAULT_STRATEGIES
        # Red teaming drives a live conversation, so like dataset runs it needs a
        # Runtime ARN.
        agents = {a["agent_name"]: a for a in list_agents()}
        if agent_name not in agents:
            yield {"event": "error", "error": f"unknown agent: {agent_name}"}
            return
        if not cases:
            yield {"event": "error", "error": "cases is required (先生成或编辑攻击用例)"}
            return
        bad = [s for s in strategy_names if s not in redteam_mod.STRATEGY_SPECS]
        if bad:
            yield {"event": "error", "error": f"unknown strategies: {bad}"}
            return
        agent_model = payload.get("agent_model", "")
        estimate = redteam_mod.estimate_redteam_run(cases, strategy_names, agent_model)

        if action == "estimate_redteam_run":
            yield {"event": "redteam_estimate", **estimate}
            return

        judge_model = payload.get("judge_model") or judgellm.default_model()
        run_id = f"rt-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
        yield {"event": "redteam_run_started", "run_id": run_id, "estimate": estimate,
               "attacks": estimate["attacks"]}

        rt_queue: asyncio.Queue = asyncio.Queue()
        rt_task = asyncio.ensure_future(redteam_mod.execute_redteam_run(
            run_id, agent_name, agents[agent_name]["runtime_arn"], cases,
            strategy_names, judge_model, agent_model, estimate,
            payload.get("cache_mode", "off"), rt_queue))
        idle = 0.0
        while True:
            try:
                ev = await asyncio.wait_for(rt_queue.get(), timeout=1.0)
                idle = 0.0
                yield {"event": "attack_turn", "run_id": run_id, **ev}
                continue
            except asyncio.TimeoutError:
                idle += 1.0
            if rt_task.done() and rt_queue.empty():
                break
            if idle >= HEARTBEAT_SECONDS:
                state = redteam_mod.get_redteam_run(run_id, detail=False) or {}
                yield {"event": "redteam_progress", "run_id": run_id,
                       "completed": state.get("completed", 0),
                       "total": state.get("attacks", 0),
                       "target_turns": state.get("target_turns", 0),
                       "actual_cost_usd": state.get("actual_cost_usd", 0)}
                idle = 0.0
        try:
            final = rt_task.result()
        except Exception as e:
            logger.exception("redteam run failed")
            yield {"event": "error", "error": f"红队测试失败：{e}"}
            return
        yield {"event": "redteam_report", **final}
        return

    if action == "get_redteam_run":
        run = redteam_mod.get_redteam_run(payload.get("run_id", ""))
        if run:
            yield {"event": "redteam_report", **run}
        else:
            yield {"event": "error", "error": "run not found"}
        return

    if action == "list_redteam_runs":
        yield {"event": "redteam_runs", "runs": redteam_mod.list_redteam_runs()}
        return

    # ---------- evaluation result cache ----------
    if action == "list_cache":
        yield {"event": "cache_scopes", "scopes": evalcache.list_scopes(),
               "ttl_days": evalcache.TTL_DAYS}
        return

    if action == "clear_cache":
        scope = (payload.get("scope") or "").strip()
        if not scope:
            yield {"event": "error", "error": "scope is required"}
            return
        removed = evalcache.clear_scope(scope)
        yield {"event": "cache_cleared", "scope": scope, "removed": removed}
        return

    if action == "get_test_run":
        run = testrun.get_test_run(payload.get("run_id", ""))
        if run:
            yield {"event": "test_run_report", **run}
        else:
            yield {"event": "error", "error": "run not found"}
        return

    if action == "list_test_runs":
        yield {"event": "test_runs", "runs": testrun.list_test_runs()}
        return

    # ---------- evaluation plans (方案) ----------
    if action == "list_plans":
        plans = plan_mod.list_plans(payload.get("agent_name"))
        # 工作台方案表的「上次结果」「单次预估 $」两列：join 的实现住在
        # planrun（PLANRUN 分区的投影/sk 模式知识与 estimate 都在那边），
        # 这里只是 action 出口的一次调用。
        planrun.attach_plan_extras(plans)
        yield {"event": "plans", "plans": plans}
        return

    if action == "save_plan":
        p = payload.get("plan") or {}
        cached = catalog.cached_agents()
        agents = {a["agent_name"]: a for a in (cached["agents"] if cached else list_agents())}
        agent = agents.get(p.get("agent_name", ""))
        if not agent:
            yield {"event": "error", "error": f"unknown agent: {p.get('agent_name')}"}
            return
        try:
            saved = plan_mod.save_plan(p, agent)
        except ValueError as e:
            yield {"event": "error", "error": str(e)}
            return
        # The plan is persisted at this point; a schedule-sync failure must
        # not read as "save failed" or the user re-saves in a loop.
        try:
            sched_state = plansched.sync_schedule(saved)
        except Exception as e:
            logger.exception("schedule sync failed for %s", saved["plan_id"])
            sched_state = {"scheduled": False, "schedule_error": str(e)}
        yield {"event": "plan_saved", "plan": saved, **sched_state}
        return

    if action == "delete_plan":
        try:
            plan_mod.delete_plan(payload.get("plan_id", ""))
            plansched.delete_schedule(payload.get("plan_id", ""))
        except ValueError as e:
            yield {"event": "error", "error": str(e)}
            return
        yield {"event": "plan_deleted", "plan_id": payload.get("plan_id")}
        return

    if action == "list_plan_runs":
        plan_id = payload.get("plan_id", "")
        if not plan_id:
            yield {"event": "error", "error": "plan_id is required"}
            return
        yield {"event": "plan_runs", "plan_id": plan_id,
               "runs": planrun.list_plan_runs(plan_id)}
        return

    if action == "list_recent_runs":
        # 跨方案 run 流：评估台首页（无 agent_name）与 Agent 详情（带过滤）共用。
        yield {"event": "recent_runs",
               "runs": planrun.list_recent_runs(
                   limit=int(payload.get("limit", 20)),
                   agent_name=payload.get("agent_name"))}
        return

    if action == "agent_status":
        # ADR-0016 ① 现状（观测）区：五个数 + 最近一次 + 告警 + 下次运行 + CloudWatch
        # 深链，一次 Logs Insights 查询本地聚合。**只读**（tests/test_agent_status.py
        # 钉「不写库」）；算不出的项 null + unavailable_reason，不编数。
        name = (payload.get("agent_name") or "").strip()
        if not name:
            yield {"event": "error", "error": "agent_name is required."}
            return
        try:
            yield agentstatus.agent_status(
                name, window_hours=int(payload.get("window_hours") or agentstatus.WINDOW_HOURS),
                refresh=bool(payload.get("refresh")))
        except ValueError as e:  # Agent '<name>' 不存在
            yield {"event": "error", "error": str(e)}
        return

    if action == "fleet_status":
        # ADR-0016 舰队级首页：所有 Agent 的 agent_status 同形对象 + 舰队汇总 + 待处理条，
        # 各 Agent 的 Logs Insights 查询并发（≤8）、5 分钟进程内缓存。**只读**
        # （tests/test_fleet_status.py 钉「业务表零写」）。
        yield await asyncio.to_thread(
            fleetstatus.fleet_status,
            window_hours=int(payload.get("window_hours") or agentstatus.WINDOW_HOURS),
            refresh=bool(payload.get("refresh")))
        return

    if action == "agent_topology":
        # ADR-0017 D4 Agent 详情「路径」卡：近 N 天会话的 span 聚合成节点/边/最常路径，
        # 与 agent_status **同一条** Insights 查询换 lookback（start.count == sessions 同源判据），
        # 5 分钟进程内缓存。**只读**（tests/test_agent_topology.py 钉「不写库」）。
        name = (payload.get("agent_name") or "").strip()
        if not name:
            yield {"event": "error", "error": "agent_name is required."}
            return
        try:
            yield await asyncio.to_thread(
                topology.agent_topology, name,
                lookback_days=payload.get("lookback_days"),
                refresh=bool(payload.get("refresh")),
                include_eval=(None if payload.get("include_eval") is None
                              else bool(payload.get("include_eval"))))
        except ValueError as e:  # Agent '<name>' 不存在 / lookback_days 须为 1–30 的整数
            yield {"event": "error", "error": str(e)}
        return

    if action == "get_plan_run":
        run = planrun.get_plan_run(payload.get("run_key", ""))
        if not run:
            yield {"event": "error", "error": f"run '{payload.get('run_key')}' 不存在"}
            return
        yield {"event": "plan_run", **run}
        return

    if action in ("compare_sessions", "pair_rows"):
        # ADR-0017 D3：两份 run 里两行并排 / 两份 run 全部行按题面配对。明细与
        # get_plan_run 同源（sessioncompare 只读 planrun.get_plan_run），diff 在服务端算。
        try:
            if action == "compare_sessions":
                out = sessioncompare.compare_sessions(payload.get("left"), payload.get("right"))
                yield {"event": "session_compare", **out}
            else:
                out = sessioncompare.pair_rows(payload.get("left_run_key"),
                                               payload.get("right_run_key"))
                yield {"event": "row_pairs", **out}
        except sessioncompare.CompareError as e:
            yield {"event": "error", "error": str(e)}
        return

    if action == "stop_plan_run":
        # 「请求停止一次正在花钱的运行」。这里只把意图落到 run 记录上 ——
        # 真正的收敛发生在执行侧（另一次 Lambda 调用）的下一个检查点，所以返回
        # 文案说的是「已请求停止，将在下一个检查点生效」而不是「已停止」。
        run_key = str(payload.get("run_key") or "").strip()
        if not run_key:
            yield {"event": "error", "error": "run_key is required"}
            return
        try:
            result = planrun.request_stop(run_key, payload.get("requested_by") or "")
        except ValueError as e:
            # run 不存在 / run_key 为空：明确的应用错误帧，不留裸异常穿出
            # 生成器（那只会剩框架的 last-words 帧，前端认不出是应用错误）。
            yield {"event": "error", "error": str(e)}
            return
        yield {"event": "plan_run_stop_requested", **result}
        return

    if action == "reap_stale_runs":
        # 陈旧 running 收敛器（UI-029 批 2）：执行进程已死（Lambda/microVM 被
        # 硬杀，finally 未执行）的 running 记录改判成 error 终态。判据与读侧
        # stale 共用 stalecheck.is_stale；只碰上线后的新记录（旧数据不修，见
        # planrun.REAPER_EPOCH_FLOOR）。触发形态照 plansched 的 EventBridge
        # Scheduler 直调先例（Scheduler → invokeAgentRuntime，IAM 内部调用，
        # 零新公网入口）；真建 schedule 的 CDK/CLI 动作在部署侧，不在本批。
        # 手动调用同样安全：改判走条件写，重复扫描幂等。
        yield {"event": "stale_runs_reaped", **planrun.reap_stale_runs()}
        return

    if action == "set_proposal_adopted":
        try:
            p = planrun.set_proposal_adopted(
                payload.get("run_key", ""), int(payload.get("index", 0)),
                bool(payload.get("adopted", True)))
        except ValueError as e:
            yield {"event": "error", "error": str(e)}
            return
        yield {"event": "proposal_adopted", "run_key": payload.get("run_key"),
               "proposal": p}
        return

    if action == "adopt_run_advice":
        # 报告「本次建议」条目的采纳（ADR-0014 §6）。条目由前端自本次诊断根因
        # 聚合而来、不在 proposals 里 —— 现有契约装不下「先有可采纳对象」这一步
        # （唯一的条目创建入口 propose_improvements 要花一次 judge 钱），故加
        # 这个最小 additive 口子：落一条已采纳的 proposal（形状见
        # planrun.adopt_run_advice），既有消费端零改动。
        refs = payload.get("refs")
        try:
            index, p = planrun.adopt_run_advice(
                payload.get("run_key", ""), str(payload.get("fix") or ""),
                refs if isinstance(refs, list) else [])
        except ValueError as e:
            yield {"event": "error", "error": str(e)}
            return
        yield {"event": "advice_adopted", "run_key": payload.get("run_key"),
               "index": index, "proposal": p}
        return

    # resume_plan_run（UI-029 批 4）与 run_plan 走**同一段**前置校验、同一层存活
    # 契约、同一台事件泵、同一条终帧 —— 续跑不是另一种运行，只是「已完成环节直接
    # 注入、只跑剩余环节」的同一次运行（同 run_key、attempt+1，状态仍是 running）。
    # 所以这里只加分发，不另养第二套编排（planrun.execute_plan_run(resume=…)）。
    if action in ("estimate_plan_run", "run_plan", "resume_plan_run"):
        # 续跑只需要 run_key（plan_id 是它的前缀：run_key = <plan_id>#<ts>）；
        # 另两个 action 的取值逐字不变。
        plan_id = str(payload.get("plan_id") or "")
        if not plan_id and action == "resume_plan_run":
            plan_id = str(payload.get("run_key") or "").split("#")[0]
        plan = plan_mod.get_plan(plan_id)
        if not plan:
            yield {"event": "error", "error": f"评估计划 '{payload.get('plan_id')}' 不存在"}
            return
        cached = catalog.cached_agents()
        agents = {a["agent_name"]: a for a in (cached["agents"] if cached else list_agents())}
        agent = agents.get(plan["agent_name"])
        if not agent or not agent.get("has_logs"):
            yield {"event": "error",
                   "error": f"unknown agent or no logs: {plan['agent_name']}"}
            return
        estimate = planrun.estimate_plan_run(plan, agent)
        if action == "estimate_plan_run":
            yield {"event": "plan_run_estimate", "plan_id": plan["plan_id"], **estimate}
            return

        triggered_by = payload.get("triggered_by", "manual")
        if triggered_by == "schedule":
            # Nobody is present to confirm cost on a scheduled trigger; the
            # plan's budget is the gate. A skipped run is still recorded so
            # "the run didn't happen" is visible, not silent.
            budget = (plan.get("schedule") or {}).get("budget_usd")
            if budget and estimate["estimated_cost_usd"] > float(budget):
                reason = (f"预估成本 ${estimate['estimated_cost_usd']} 超过单次预算上限 "
                          f"${budget}，本次定时评估已跳过")
                run_key = planrun.record_skipped_run(plan, reason, estimate)
                yield {"event": "plan_run_skipped", "run_key": run_key,
                       "reason": reason}
                return

        # 续跑上下文（UI-029 批 4）：**纯读 + 校验**（检查点读回、状态/归属/方案
        # 定义对位），任何不满足都在这里变成 error 帧 —— 一个环节都没开跑、一分钱
        # 没花、库里一个字未改（planrun.resume_context 里没有任何写）。
        resume = None
        if action == "resume_plan_run":
            try:
                resume = planrun.resume_context(payload.get("run_key", ""), plan)
            except ValueError as e:
                yield {"event": "error", "error": str(e)}
                return

        judge_model = payload.get("judge_model") or judgellm.default_model()
        # plan_run_started 不再在这里直发（UI-029 批 1）：run_key 生成在
        # execute_plan_run 里，事件改由执行侧在 write-at-start 落库后经 emit 通道
        # 发出 —— 同名同形，多带 run_key/started_epoch（断流转轮询/刷新恢复的
        # 钥匙），estimate 经参数原样透传进事件。

        queue: asyncio.Queue = asyncio.Queue()

        async def _emit(ev):
            await queue.put(ev)

        # 存活契约（UI-029 批 1）：SDK 的 /ping 只在注册过 async task 时报
        # HealthyBusy（bedrock_agentcore/runtime/app.py:314），而执行体此前从不
        # 注册 —— 断流后「执行独活」只是观测运气（平台按 idle 900s 理论可回收）。
        # add/complete 必须严格配平：complete 在 finally，异常/取消路径也归还，
        # 否则容器永远 HealthyBusy，再也不被平台视作空闲。客户端断开只取消 SSE
        # 生成器，run_task（连同这层契约）照跑到完 —— 这正是要的语义。
        # 任务名用 action：续跑在 /ping 语义上与首跑完全同刑（都是「这个容器正忙」），
        # 但日志/追踪里要分得出是哪一种。
        contract_id = app.add_async_task(action, {"plan_id": plan["plan_id"]})

        async def _run_under_contract():
            try:
                return await planrun.execute_plan_run(
                    plan, agent, judge_model, triggered_by, _emit,
                    estimate=estimate, resume=resume)
            finally:
                app.complete_async_task(contract_id)

        run_task = asyncio.ensure_future(_run_under_contract())
        idle = 0.0
        while True:
            try:
                ev = await asyncio.wait_for(queue.get(), timeout=1.0)
                idle = 0.0
                yield ev
                continue
            except asyncio.TimeoutError:
                idle += 1.0
            if run_task.done() and queue.empty():
                break
            if idle >= HEARTBEAT_SECONDS:
                yield {"event": "heartbeat", "plan_id": plan["plan_id"]}
                idle = 0.0
        try:
            final = run_task.result()
        except Exception as e:
            logger.exception("plan run failed")
            yield {"event": "error", "error": f"评估计划运行失败：{e}"}
            return
        # The full report streams back minus per-stage bulk (already streamed
        # live); the UI fetches the complete archive via get_plan_run.
        yield {"event": "plan_run_report",
               "run_key": final["run_key"], "s3_key": final.get("s3_key"),
               "plan": final["plan"], "triggered_by": final["triggered_by"],
               "started_at": final["started_at"], "finished_at": final["finished_at"],
               "started_epoch": final.get("started_epoch"),
               "finished_epoch": final.get("finished_epoch"),
               "duration_s": final.get("duration_s"),
               "overview": final["overview"],
               "plan_synthesis": final.get("plan_synthesis"),
               "synthesis_sections": planrun.synthesis_sections(final.get("plan_synthesis")),
               "synthesis_error": final.get("synthesis_error"),
               # 问题台账（ADR-0016 ③）：与 synthesis_sections 并存的结构化条目；
               # 没有诊断产物 / 老形态 ⇒ []（不是 null）
               "synthesis_issues": final.get("synthesis_issues") or [],
               "stages": [planrun._stage_summary(s) for s in final["stages"]]}
        return

    if action == "propose_improvements":
        # diagnosis/low scores from an existing report -> adoptable draft
        # (revised system prompt + tool description rewrites). The UI posts
        # the report's own session details back, so no re-evaluation happens.
        agent_name = (payload.get("agent_name") or "").strip()
        sessions = payload.get("sessions") or []
        if not agent_name or not sessions:
            yield {"event": "error", "error": "agent_name and sessions are required."}
            return
        cached = catalog.cached_agents()
        agents = {a["agent_name"]: a for a in (cached["agents"] if cached else list_agents())}
        agent = agents.get(agent_name)
        if not agent or not agent.get("has_logs"):
            yield {"event": "error", "error": f"unknown agent or no logs: {agent_name}"}
            return
        judge_model = payload.get("judge_model") or judgellm.default_model()
        lookback_days = int(payload.get("lookback_days", DEFAULT_LOOKBACK_DAYS))
        yield {"event": "improve_start", "agent": agent_name}
        try:
            out = await improve.propose(agent, sessions, judge_model, lookback_days)
        except ValueError as e:
            yield {"event": "error", "error": str(e)}
            return
        except Exception as e:
            logger.exception("improvement proposal failed")
            yield {"event": "error", "error": f"改进稿生成失败：{e}"}
            return
        # When the evidence came from a plan run, attach the proposal to that
        # run so adoption tracking and next-run comparison have an anchor.
        run_key = (payload.get("run_key") or "").strip()
        if run_key:
            try:
                planrun.attach_proposal(
                    run_key, (out.get("proposal") or {}).get("summary", ""))
                out["attached_to_run"] = run_key
            except Exception:
                logger.exception("proposal attach failed for %s", run_key)
        yield {"event": "improvement", "agent": agent_name, **out}
        return

    if action == "diagnose_session":
        # manual diagnosis for one observed session
        agent_name = (payload.get("agent_name") or "").strip()
        sid = (payload.get("session_id") or "").strip()
        lookback_days = int(payload.get("lookback_days", DEFAULT_LOOKBACK_DAYS))
        if not agent_name or not sid:
            yield {"event": "error", "error": "agent_name and session_id are required."}
            return
        cached = catalog.cached_agents()
        agents = {a["agent_name"]: a for a in (cached["agents"] if cached else list_agents())}
        agent = agents.get(agent_name)
        if not agent or not agent.get("has_logs"):
            yield {"event": "error", "error": f"unknown agent or no logs: {agent_name}"}
            return
        judge_model = payload.get("judge_model") or judgellm.default_model()
        try:
            data, _ = tracesource.get_evaluation_data(agent, sid, lookback_days)
            diag = await asyncio.to_thread(diagnosis_mod.diagnose, data["trajectory"], judge_model)
        except Exception as e:
            logger.exception("manual diagnosis failed")
            yield {"event": "error", "error": f"诊断失败：{e}"}
            return
        yield {"event": "diagnosis", "session_id": sid, "agent": agent_name,
               "diagnosis": diag or {"failures": [], "root_causes": []},
               "clean": diag is None}
        return

    if action == "set_review":
        sid = (payload.get("session_id") or "").strip()
        evaluator = (payload.get("evaluator") or "").strip()
        verdict = (payload.get("verdict") or "").strip()
        if not sid or not evaluator:
            yield {"event": "error", "error": "session_id and evaluator are required."}
            return
        if verdict == "clear":
            catalog.delete_review(sid, evaluator)
        elif verdict in ("accurate", "inaccurate"):
            catalog.set_review(sid, evaluator, verdict, payload.get("note", ""))
        else:
            yield {"event": "error", "error": "verdict must be accurate|inaccurate|clear."}
            return
        yield {"event": "review_set", "session_id": sid, "evaluator": evaluator, "verdict": verdict}
        return

    if action == "get_reviews":
        sids = payload.get("session_ids") or []
        yield {"event": "reviews", "reviews": catalog.list_reviews(sids)}
        return

    # 人工标注（ADR-0017 D2）：只写 ANNOT item，不改 run 的任何分数字段、不回填 pass_rate。
    if action == "annotate_case":
        try:
            ann = catalog.annotate_case(
                payload.get("run_key"), payload.get("row_key"), payload.get("evaluator"),
                payload.get("human_score"),
                label=payload.get("label") or "", comment=payload.get("comment") or "")
        except (KeyError, ValueError, TypeError) as e:
            yield {"event": "error", "error": str(e)}
            return
        yield {"event": "case_annotated", "annotation": ann}
        return

    if action == "list_annotations":
        run_key = str(payload.get("run_key") or "").strip()
        yield {"event": "annotations", "run_key": run_key,
               "items": catalog.list_annotations(run_key)}
        return

    if action == "prices":
        yield {"event": "prices", **pricing.get_prices()}
        return

    if action == "set_price":
        try:
            pricing.set_price(payload["model"], float(payload["input"]), float(payload["output"]))
        except (KeyError, ValueError) as e:
            yield {"event": "error", "error": f"model/input/output required: {e}"}
            return
        yield {"event": "price_set", "model": payload["model"]}
        return

    if action == "delete_price":
        pricing.delete_price(payload.get("model", ""))
        yield {"event": "price_deleted", "model": payload.get("model", "")}
        return

    if action == "refresh_prices":
        result = pricing.refresh_from_pricing_api()
        yield {"event": "prices_refreshed", **result}
        return

    if action == "sessions":
        agent_names = payload.get("agent_names") or []
        if not agent_names:
            yield {"event": "error", "error": "agent_names is required for action=sessions."}
            return
        max_sessions = int(payload.get("max_sessions", 10))
        lookback_days = int(payload.get("lookback_days", DEFAULT_LOOKBACK_DAYS))
        refresh = bool(payload.get("refresh"))
        include_test = bool(payload.get("include_test"))
        cached = catalog.cached_agents()
        agents = {a["agent_name"]: a for a in (cached["agents"] if cached else list_agents())}
        for name in agent_names:
            agent = agents.get(name)
            # A configured span source overrides the has_logs gate: it points
            # at a different (shared) log group, so an empty/missing runtime
            # group says nothing about whether traces exist.
            span_src = catalog.get_span_source(name) if agent else None
            if not agent or (not agent["has_logs"] and span_src is None):
                yield {"event": "sessions", "agent": name, "sessions": [],
                       "error": None if agent else "unknown agent"}
                continue
            try:
                result = None if refresh else catalog.cached_sessions(
                    name, lookback_days, max_sessions, include_test)
                from_cache = result is not None
                if result is None:
                    result = catalog.refresh_sessions(
                        name, agent.get("log_group"), lookback_days, max_sessions,
                        include_test, agent=agent
                    )
                event = {"event": "sessions", "agent": name, "lookback_days": lookback_days,
                         "sessions": result["sessions"], "from_cache": from_cache,
                         "refreshed_at": result["refreshed_at"]}
                if not result["sessions"] and span_src is None:
                    # Runtime group came back empty and no span source is
                    # configured — the spans may be in the centralized
                    # aws/spans group (Transaction Search/ADOT setups write
                    # there and leave the runtime group at 0 bytes). Probe it
                    # and surface a hint; never auto-persist (probe != confirm).
                    hint = await asyncio.to_thread(
                        tracesource.probe_central_spans, agent, lookback_days)
                    if hint:
                        event["hint"] = hint
                yield event
            except Exception as e:
                yield {"event": "sessions", "agent": name, "sessions": [], "error": str(e)}
        return

    if action != "evaluate":
        yield {"event": "error", "error": f"Unknown action '{action}'. Use discover|evaluators|sessions|evaluate."}
        return

    agent_names = payload.get("agent_names") or []
    if not agent_names:
        yield {"event": "error", "error": "agent_names is required for action=evaluate."}
        return
    max_sessions = int(payload.get("max_sessions", DEFAULT_MAX_SESSIONS))
    lookback_days = int(payload.get("lookback_days", DEFAULT_LOOKBACK_DAYS))
    chosen_sessions = payload.get("sessions") or {}
    judge_model = payload.get("judge_model") or judgellm.default_model()

    # split requested checks into judge evaluators vs trace metrics
    requested = payload.get("evaluators")
    metric_keys = payload.get("metrics")
    if requested is None and metric_keys is None:
        requested = DEFAULT_EVALUATORS
        metric_keys = list(metrics_mod.METRIC_KEYS)
    requested = requested or []
    metric_keys = [m for m in (metric_keys or []) if m in metrics_mod.METRIC_KEYS]

    custom_defs = {e["name"]: e["rubric"] for e in catalog.list_custom_evaluators()}
    evaluator_names = [n for n in requested if n not in metrics_mod.METRIC_KEYS]
    custom_rubrics = {n: custom_defs[n] for n in evaluator_names if n in custom_defs}

    if not evaluator_names and not metric_keys:
        yield {"event": "error", "error": "Nothing selected: pass evaluators and/or metrics."}
        return

    try:
        build_evaluators(evaluator_names or None, judge_model, custom_rubrics) \
            if evaluator_names else None  # fail fast on bad names
    except ValueError as e:
        yield {"event": "error", "error": str(e)}
        return

    prices = pricing.get_prices()["prices"] if "cost" in metric_keys else {}
    cache_mode = payload.get("cache_mode", "off")

    agents = {a["agent_name"]: a for a in list_agents()}
    unknown = [n for n in agent_names if n not in agents]
    if unknown:
        yield {"event": "error", "error": f"Unknown agents: {unknown}", "available": sorted(agents)}
        return

    yield {
        "event": "start",
        "agents": agent_names,
        "evaluators": evaluator_names,
        "metrics": metric_keys,
        "judge_model": judge_model,
        "max_sessions": max_sessions,
        "lookback_days": lookback_days,
        "cache_mode": cache_mode,
    }

    report_agents = {}
    all_session_details = []
    cache_stores = {}
    for name in agent_names:
        agent = agents[name]
        # A span-source override reads from a shared span group (aws/spans),
        # so a missing runtime log group doesn't mean "no traces".
        if not agent["has_logs"] and catalog.get_span_source(name) is None:
            yield {"event": "agent_skipped", "agent": name, "reason": "no runtime log group (no traffic yet)"}
            continue

        if name in chosen_sessions:
            # span_count unknown for hand-picked ids; the provider re-queries by
            # id anyway.
            sessions = [{"session_id": sid, "last_ts": 0, "span_count": 0}
                        for sid in chosen_sessions[name]]
        else:
            try:
                sessions = tracesource.list_sessions(agent, lookback_days, max_sessions)
            except Exception as e:
                yield {"event": "agent_error", "agent": name, "error": str(e)}
                continue

        yield {"event": "agent_start", "agent": name, "sessions_found": len(sessions)}
        if not sessions:
            report_agents[name] = {"sessions_evaluated": 0, "summary": {}}
            continue

        # one cache scope per agent: session ids are globally unique case names
        store = evalcache.make_store(name, cache_mode)
        if store is not None:
            cache_stores[name] = store
        session_events = []
        for i, session in enumerate(sessions):
            yield {
                "event": "session_start",
                "agent": name,
                "session_id": session["session_id"],
                "progress": f"{i + 1}/{len(sessions)}",
            }
            task = asyncio.ensure_future(
                observe.evaluate_session(agent, session, evaluator_names, judge_model,
                                         lookback_days, custom_rubrics, metric_keys,
                                         prices, cache_stores.get(name))
            )
            while True:
                done, _ = await asyncio.wait({task}, timeout=HEARTBEAT_SECONDS)
                if done:
                    break
                yield {"event": "heartbeat", "agent": name, "session_id": session["session_id"]}
            try:
                result = task.result()
            except Exception as e:
                logger.exception("evaluation failed for %s/%s", name, session["session_id"])
                result = {
                    "event": "session_error",
                    "agent": name,
                    "session_id": session["session_id"],
                    "error": str(e),
                }
            if result["event"] == "session_result":
                session_events.append(result)
                all_session_details.append(
                    {
                        "agent": name,
                        "session_id": result["session_id"],
                        "results": result["results"],
                        "metrics": result.get("metrics"),
                        "warning": result.get("warning"),
                        # so the analysis prompt can tell "no content to judge"
                        # apart from a genuine low score
                        # (see observe.ANALYSIS_SYSTEM_PROMPT)
                        "no_content": result.get("no_content"),
                        "output_preview": result.get("output_preview", "")[:200],
                        "transcript": result.get("transcript"),
                        "diagnosis": result.get("diagnosis"),
                    }
                )
            else:
                all_session_details.append(
                    {"agent": name, "session_id": result.get("session_id"),
                     "error": result.get("error")}
                )
            yield result

        summary = observe.summarize(session_events)
        agent_metrics = metrics_mod.aggregate_agent_metrics(
            [e["metrics"] for e in session_events if e.get("metrics")]
        ) if metric_keys else None
        report_agents[name] = {"sessions_evaluated": len(session_events),
                               "summary": summary, "metrics": agent_metrics}
        yield {"event": "agent_summary", "agent": name, **report_agents[name]}

    # attach any existing human review verdicts for these sessions
    try:
        reviews = catalog.list_reviews([s["session_id"] for s in all_session_details if s.get("session_id")])
    except Exception:
        logger.exception("review lookup failed")
        reviews = {}
    for s in all_session_details:
        for ev_name in (s.get("results") or {}):
            r = reviews.get(f"{s['session_id']}#{ev_name}")
            if r:
                s["results"][ev_name]["review"] = r

    analysis = None
    if all_session_details:
        yield {"event": "analysis_start"}
        try:
            analysis = await observe.generate_analysis(
                judge_model, evaluator_names, report_agents, all_session_details
            )
        except Exception as e:
            logger.exception("analysis generation failed")
            analysis = f"（解析生成失败：{e}）"

    # Report template (fixed section order, rendered by UI/CLI):
    # 1 概要 (meta) → 2 汇总表 (agents) → 3 执行明细 (sessions, collapsed)
    # → 4 智能解析 (analysis) → 5 原始 JSON (this whole event, collapsed)
    total_cost = round(sum(
        (a.get("metrics") or {}).get("cost", {}).get("usd", 0) for a in report_agents.values()
    ), 4)
    total_tokens = sum(
        (a.get("metrics") or {}).get("tokens", {}).get("total", 0) for a in report_agents.values()
    )
    yield {
        "event": "report",
        "meta": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            "agents": agent_names,
            "evaluators": evaluator_names,
            "metrics": metric_keys,
            "judge_model": judge_model,
            "lookback_days": lookback_days,
            "sessions_evaluated": sum(a.get("sessions_evaluated", 0) for a in report_agents.values()),
            "sessions_attempted": len(all_session_details),
            "total_tokens": total_tokens or None,
            "total_cost_usd": total_cost or None,
            "cache_mode": cache_mode,
            "cache": ({"hits": sum(len(s.hits) for s in cache_stores.values()),
                       "misses": sum(len(s.misses) for s in cache_stores.values())}
                      if cache_stores else None),
        },
        "judge_model": judge_model,
        "evaluators": evaluator_names,
        "metrics_selected": metric_keys,
        "agents": report_agents,
        "sessions": all_session_details,
        "analysis": analysis,
    }


if __name__ == "__main__":
    app.run()
