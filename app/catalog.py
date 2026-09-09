"""DynamoDB-backed catalog of agents and their recent sessions.

Single table, key schema:
  pk="AGENT",              sk=<agent_name>   -> one item per agent
  pk="SESSCACHE/<agent>",  sk="v1"           -> cached session list + query params
  pk="DATASET",            sk=<name>         -> whole dataset (cases inline, ADR-0012) + version
  pk="ANNOT/<run_key>",    sk="<row_key>#<evaluator>" -> one human annotation per cell (ADR-0017 D2)

Reads serve the UI instantly; a manual refresh action re-scans the live
sources (ListAgentRuntimes / Logs Insights) and rewrites the cache.
"""

import json
import logging
import os
import time
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

import ttlcache
from discovery import REGION, list_agents, list_recent_sessions

logger = logging.getLogger("eval-anything")

TABLE_NAME = os.environ.get("CATALOG_TABLE", "")

# Agent 目录（AGENT 分区）的最大年龄 = 首页观测窗口 24h（agentstatus.WINDOW_HOURS 同数；
# 不 import 它：agentstatus 依赖本模块，反向引会成环）。目录持久在 DDB，此前没有任何
# 自动触发点（无定时器、run 结束不回写、页面打开不检查），唯一写点是手点「重新扫描」，
# 于是「四天前扫的四天不动」（issue fleet-cache-never-expires，现网 2026-09-08 实拍：
# 「缓存于 2026-09-04 08:52 UTC」）。超过这条上限 ⇒ discover 自动重扫一次（见 refresh_if_stale）。
CATALOG_MAX_AGE_SECONDS = 24 * 3600
# 自动重扫失败后的防抖：同一进程 300s 内不再重试（与全站进程内缓存同一个 TTL）。
_auto_refresh_failed = ttlcache.TtlCache(ttlcache.DEFAULT_TTL_SECONDS)

_table = None


def get_table():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb", region_name=REGION).Table(TABLE_NAME)
    return _table


def cached_agents() -> dict | None:
    """Return {"agents": [...], "refreshed_at": epoch} or None when cache is empty."""
    if not TABLE_NAME:
        return None
    resp = get_table().query(KeyConditionExpression=Key("pk").eq("AGENT"))
    items = resp.get("Items", [])
    if not items:
        return None
    agents = [json.loads(i["data"]) for i in items]
    for a in agents:
        a.setdefault("source", "agentcore")
    refreshed_at = max((int(i.get("refreshed_at", 0)) for i in items), default=int(time.time()))
    agents.sort(key=lambda a: a["agent_name"])
    return {"agents": apply_agent_meta(agents), "refreshed_at": refreshed_at}


def catalog_age_s(cached: dict, now: int | None = None) -> int:
    """距上次扫描的整秒数。refreshed_at 缺失按 0（= 无限老）：老行没这个键就该重扫。"""
    now_s = int(time.time()) if now is None else int(now)
    return max(0, now_s - int(cached.get("refreshed_at") or 0))


def is_stale(cached: dict, now: int | None = None) -> bool:
    return catalog_age_s(cached, now) > CATALOG_MAX_AGE_SECONDS


def refresh_if_stale(cached: dict) -> tuple[dict, bool, dict | None]:
    """目录超过 24h 窗口 ⇒ 同步重扫一次；返回 (目录, from_cache, catalog_refresh 记录)。

    * 不超龄 ⇒ (原目录, True, None)。
    * 超龄且重扫成功 ⇒ (新目录, False, {"attempted": True, "ok": True, "error": None})。
    * 超龄且重扫抛错 ⇒ **照旧回旧目录**（refreshed_at 仍是旧时刻，前端据此标「超窗」），
      记录 {"attempted": True, "ok": False, "error": <原话前 200 字>}，并进 300s 防抖；
      防抖期内再来 ⇒ 不重试，回 {"attempted": False, "ok": False, "error": <上次原话>}。
      失败必须在响应里看得见 —— 否则「四天不刷」只会变成「四天自动重扫一直失败而没人知道」。

    同步做的依据：refresh_agents = ListAgentRuntimes + DescribeLogGroups 各一轮分页 + DDB 批写，
    **没有** Logs Insights 查询；实测（2026-09-09，us-west-2，32 个 Agent）list_agents 0.44 s 冷 /
    0.22 s 热。每 24h 只多付一次，不值得引入「响应返回后进程还在写 DDB」的 Runtime 回收风险。
    """
    if not is_stale(cached):
        return cached, True, None
    hit = _auto_refresh_failed.get("auto")
    if hit is not None:
        return cached, True, {"attempted": False, "ok": False, "error": hit[0]}
    try:
        fresh = refresh_agents()
    except Exception as e:
        err = str(e)[:200]
        _auto_refresh_failed.put("auto", err)
        logger.warning("discover: 目录已 %ss 未扫（上限 %ss），自动重扫失败，回旧目录：%s",
                       catalog_age_s(cached), CATALOG_MAX_AGE_SECONDS, err, exc_info=True)
        return cached, True, {"attempted": True, "ok": False, "error": err}
    return fresh, False, {"attempted": True, "ok": True, "error": None}


def get_cached_agent(agent_name: str) -> dict | None:
    """按名取**一条** discovery 缓存行（单 get_item），未缓存返回 None。

    形状与 cached_agents()["agents"] 的元素同形（同一个 apply_agent_meta 叠加），
    理由同 get_dataset：调用侧要的是「一个」，不该付「读整个分区」的放大 ——
    planrun 每次落 run 记录都要读它一次（版本快照）。
    """
    if not TABLE_NAME or not str(agent_name or "").strip():
        return None
    item = get_table().get_item(Key={"pk": "AGENT", "sk": agent_name}).get("Item")
    if not item:
        return None
    agent = json.loads(item["data"])
    agent.setdefault("source", "agentcore")
    return _overlay_agent_meta(agent, get_agent_meta(agent_name))


def refresh_agents() -> dict:
    """Scan live AgentCore + CloudWatch and rewrite the agent catalog."""
    agents = list_agents()
    for a in agents:
        a["source"] = "agentcore"
    now = int(time.time())
    if not TABLE_NAME:  # no table configured (local dev): live scan, no cache
        agents.sort(key=lambda a: a["agent_name"])
        return {"agents": agents, "refreshed_at": now}
    table = get_table()
    # replace-all: delete stale names, then write current
    existing = table.query(KeyConditionExpression=Key("pk").eq("AGENT")).get("Items", [])
    current_names = {a["agent_name"] for a in agents}
    with table.batch_writer() as batch:
        for item in existing:
            if item["sk"] not in current_names:
                batch.delete_item(Key={"pk": "AGENT", "sk": item["sk"]})
        for a in agents:
            batch.put_item(
                Item={"pk": "AGENT", "sk": a["agent_name"],
                      "data": json.dumps(a, ensure_ascii=False), "refreshed_at": now}
            )
    agents.sort(key=lambda a: a["agent_name"])
    # overlay 只发生在**返回时**：写进 DDB 的 data blob 保持纯 discovery 原物，
    # 所以这条 replace-all 路径不可能把用户的显示名/版本标签冲掉（它们在 AGENTMETA）。
    return {"agents": apply_agent_meta(agents), "refreshed_at": now}


# ---------- per-agent 显示元数据：显示名 + 版本标签 ----------
#
# Agent = 显示名 + 版本标签 + runtime（用户拍板的设计）。同一个 agent 改进后换了
# runtime 再评一次，要能在趋势与对比视图里分清是哪一版 —— 用**人工标签**替代自动
# 指纹，所以两者都可在 Agent 详情页编辑：
#   display_name   默认 = AgentCore discovery 的名字（空 = 用原名，不存冗余副本）
#   version_label  默认 = discovery 给的 runtime 版本（读得到就填，见下），用户可改
#
# ⚠️ 护栏 2（关联键不动）：这里存的两个字段是**展示层**元数据。`agent_name` 是
# 关联键（方案绑定 / run 归属 / evaltest 会话前缀），改显示名一律不碰它 ——
# 直接改键会让历史数据全部失联。全 UI 显示处走单一取名函数
# （web/src/lib/agentName.ts displayName），存储层这里只管存取。
#
# 为什么独立 pk（AGENTMETA）而不塞进 AGENT 行或 AGENTCFG：
#   · AGENT 行由 refresh_agents **replace-all** 重写（删除不在册的名字再整条覆盖），
#     元数据混进去就会被一次「重新扫描」抹掉；
#   · AGENTCFG 的 set_agent_config 是整条 put_item 覆盖写，混在一起互相 clobber
#     （同 SPANSRC 分居的理由）。
AGENT_META_FIELDS = ("display_name", "version_label")
# 两者都是行内 chip 文案（表格一列 / 趋势竖线标注），超长只会把版式挤烂。
AGENT_META_MAX_LEN = 60

_EMPTY_AGENT_META = {"display_name": "", "version_label": "", "updated_at": None}


def get_agent_meta(agent_name: str) -> dict:
    """{display_name, version_label, updated_at}；从未标注过 → 空串 + None。

    空串是「没标注」的正常形态（不是缺字段）：显示侧据此回落到 discovery 原名 /
    不画版本 chip。
    """
    if not TABLE_NAME or not str(agent_name or "").strip():
        return dict(_EMPTY_AGENT_META)
    item = get_table().get_item(Key={"pk": "AGENTMETA", "sk": agent_name}).get("Item")
    if not item:
        return dict(_EMPTY_AGENT_META)
    return {"display_name": item.get("display_name", ""),
            "version_label": item.get("version_label", ""),
            "updated_at": int(item["updated_at"]) if item.get("updated_at") else None}


def set_agent_meta(agent_name: str, display_name: str | None = None,
                   version_label: str | None = None) -> dict:
    """写显示名 / 版本标签，返回写入后的元数据。

    两个字段各自三态，别混：
      · 不传（None）  = 保留旧值（只改一个字段不该把另一个抹掉 —— 整条 put_item
                        的经典踩点，见 set_agent_config 的注释同族）；
      · 空串          = **清除**标注（回落到 discovery 原名 / 不画版本 chip）；
      · 非空          = 标注这个值（前后空白剔掉，长度截到 AGENT_META_MAX_LEN）。
    两个都不传 = 调用方在瞎写，拒绝（静默写一条空 item 更糟）。
    """
    name = str(agent_name or "").strip()
    if not name:
        raise ValueError("agent_name is required")
    if display_name is None and version_label is None:
        raise ValueError("至少需要 display_name / version_label 之一")
    prev = get_agent_meta(name)

    def _clean(v: str | None, fallback: str) -> str:
        return fallback if v is None else str(v).strip()[:AGENT_META_MAX_LEN]

    item = {"pk": "AGENTMETA", "sk": name,
            "display_name": _clean(display_name, prev["display_name"]),
            "version_label": _clean(version_label, prev["version_label"]),
            "updated_at": int(time.time())}
    get_table().put_item(Item=item)
    return {k: item[k] for k in (*AGENT_META_FIELDS, "updated_at")}


def _overlay_agent_meta(agent: dict, meta: dict) -> dict:
    """把元数据叠到一条 discovery 行上（就地改并返回同一个 dict）。

    两个键**恒存在**（没标注过就是空串）：前端契约稳定，取名函数不必判 undefined。
    version_label 的缺省来自 discovery 行自己的 `runtime_version`（「读得到就填」）
    —— 今天 discovery.list_agents 还不带这个键（它在本批白名单外，登记留档），
    缺键时缺省就是空串，用户填了什么就是什么。
    """
    agent["display_name"] = meta.get("display_name") or ""
    agent["version_label"] = (meta.get("version_label")
                              or str(agent.get("runtime_version") or ""))
    return agent


def apply_agent_meta(agents: list[dict]) -> list[dict]:
    """一批 discovery 行叠加显示元数据（一次 query 读全部 AGENTMETA 行）。

    **不动 agent_name**（护栏 2）：显示名叠在旁边，关联键原样。
    """
    if not agents or not TABLE_NAME:
        return [_overlay_agent_meta(a, {}) for a in agents]
    items = get_table().query(
        KeyConditionExpression=Key("pk").eq("AGENTMETA")).get("Items", [])
    by_name = {i["sk"]: i for i in items}
    return [_overlay_agent_meta(a, by_name.get(a.get("agent_name"), {})) for a in agents]


def cached_sessions(agent_name: str, lookback_days: int, max_sessions: int,
                    include_test: bool = False) -> dict | None:
    """Return cached session list if present and produced with the same params."""
    if not TABLE_NAME:
        return None
    sk = "v1-test" if include_test else "v1"
    resp = get_table().get_item(Key={"pk": f"SESSCACHE/{agent_name}", "sk": sk})
    item = resp.get("Item")
    if not item:
        return None
    if int(item.get("lookback_days", -1)) != lookback_days or int(item.get("max_sessions", -1)) != max_sessions:
        return None  # params changed -> treat as cache miss
    return {
        "sessions": json.loads(item["data"]),
        "refreshed_at": int(item.get("refreshed_at", 0)),
    }


# 自定义评估器的适用范围：all=观测+回归都可用；observe=仅观测；dataset=仅回归。
EVALUATOR_SCOPES = ("all", "observe", "dataset")


def list_custom_evaluators() -> list[dict]:
    """All user-defined rubric evaluators:
    [{name, rubric, scope, created_at, updated_at, blocks}].

    Records written before scope existed carry none — they default to "all",
    matching their historical behaviour (usable everywhere). Records written
    before updated_at existed fall back to created_at; blocks is None unless
    the evaluator was last saved in structured mode.
    """
    if not TABLE_NAME:
        return []
    items = get_table().query(
        KeyConditionExpression=Key("pk").eq("EVALUATOR")
    ).get("Items", [])
    return sorted(
        ({"name": i["sk"], "rubric": i["rubric"],
          "scope": i.get("scope") or "all",
          "created_at": int(i.get("created_at", 0)),
          "updated_at": int(i.get("updated_at", i.get("created_at", 0))),
          "blocks": json.loads(i["blocks"]) if i.get("blocks") else None}
         for i in items),
        key=lambda e: e["name"],
    )


def create_custom_evaluator(name: str, rubric: str, scope: str = "all",
                            blocks: dict | None = None) -> dict:
    """新建或覆盖 rubric 评估器，返回写入的 item。

    created_at 只在首次创建时写入，编辑保留旧值（修掉"编辑会重置创建时间"）；
    updated_at 每次都刷新。blocks 是前端的结构化源数据（goal/checks/bands），
    后端只存取不解释；传 None 表示用原始文本模式保存，此时**不保留**旧
    blocks——留着会和新 rubric 脱节。
    """
    if scope not in EVALUATOR_SCOPES:
        raise ValueError(
            f"scope 必须是 {'/'.join(EVALUATOR_SCOPES)} 之一，收到 '{scope}'")
    if blocks is not None and not isinstance(blocks, dict):
        raise ValueError(f"blocks 必须是对象（dict），收到 {type(blocks).__name__}")
    now = int(time.time())
    prev = get_table().get_item(Key={"pk": "EVALUATOR", "sk": name}).get("Item")
    created_at = int(prev["created_at"]) if prev and prev.get("created_at") else now
    item = {"pk": "EVALUATOR", "sk": name, "rubric": rubric, "scope": scope,
            "created_at": created_at, "updated_at": now}
    if blocks is not None:
        item["blocks"] = json.dumps(blocks, ensure_ascii=False)
    get_table().put_item(Item=item)
    return item


def delete_custom_evaluator(name: str) -> None:
    get_table().delete_item(Key={"pk": "EVALUATOR", "sk": name})


# ---------- datasets (test-case collections) ----------

MAX_CASES = 200

# 体积闸门（P1，2026-08-24 数据丢失同族）：MAX_CASES 只管条数，不管字节。
# AI 生成的红队/模拟用例字段全程不截断（redteam.py:326-331 的 opening message /
# target_context / success_criteria 都是模型自由文本），200 条中文用例能到
# ~1.2MB：条数闸门放行 → PutItem 抛 ValidationException「Item size has exceeded
# the maximum allowed size」。那是 botocore.ClientError，不是 ValueError，穿透
# main.py save_dataset 分支的 except (KeyError, ValueError)，穿出 async
# generator，只剩框架层一帧无 `event` 字段的遗言 —— 用户看到的是「保存失败但不
# 知为何」，而刚生成的用例只在前端组件态里，刷新即丢。
#
# 为什么这里是「拒绝」而不是 runstore 那样的 S3 外溢：run 明细可以按「最大块
# 优先」渐进裁剪（少一段对话记录不影响这次 run 的结论），而数据集的 cases 就是
# 载荷本身 —— 少一条用例就是少跑一条，没有可裁的东西。外溢会把 list_datasets
# （唯一读路径，一次调用要读全部数据集的全部 cases）变成 N 次 S3 GET，且让资源
# 库在 S3 抖动时整体不可用。故本层只做预检 + 可行动文案，外溢另议。
DDB_ITEM_LIMIT = 400 * 1024
# 留 4KB 余量：DDB 自己算的字节数与本地估算有细微差异（数字属性的编码等），且
# 卡在 399KB 通过的写入，下次编辑多带一个 risk_categories 就会失败。
SAFE_ITEM_BYTES = DDB_ITEM_LIMIT - 4 * 1024


def _item_bytes(item: dict) -> int:
    """DynamoDB 单条记录的估算字节数：属性名 + 属性值（同 runstore.item_bytes
    的口径，此处独立实现以免两个模块互相牵制）。字符串按 UTF-8 实际字节算，
    数字按十进制字面量算 —— 后者比 DDB 的紧凑编码偏大，即估算只会偏保守。"""
    total = 0
    for k, v in item.items():
        total += len(str(k).encode())
        total += len(v.encode()) if isinstance(v, str) else len(str(v).encode())
    return total


def _kb(n: int) -> str:
    return f"{round(n / 1024)} KB"


def _oversize_message(name: str, cases: list[dict], size: int) -> str:
    """告诉用户：多少条、多大、上限多少、怎么办（按当前平均值给可保存条数）。"""
    per_case = max(1, size // max(1, len(cases)))
    fits = max(1, SAFE_ITEM_BYTES // per_case)
    per_case_text = (f"{per_case / 1024:.1f} KB" if per_case >= 1024
                     else f"{per_case} 字节")
    return (
        f"数据集 '{name}' 共 {len(cases)} 条用例、写入体积约 {_kb(size)}，"
        f"超过单条记录上限 {_kb(DDB_ITEM_LIMIT)}（留出余量后可用 {_kb(SAFE_ITEM_BYTES)}）。"
        f"当前平均每条约 {per_case_text}，请拆成多个数据集（每个不超过 {fits} 条），"
        f"或精简用例里的长文本（context / success_criteria 等）后重试。"
    )

# 数据集类型：regression=回归测试用例集；redteam=红队用例集；simulation=模拟任务集（多轮）。
# 历史数据靠 "rt-" 命名前缀区分，新写入一律落 kind 属性。
DATASET_KINDS = ("regression", "redteam", "simulation")


def _infer_kind(name: str) -> str:
    """存量 item 无 kind 属性时按命名前缀兜底推断（不迁移数据也能正确归类）。"""
    return "redteam" if name.startswith("rt-") else "regression"


# 多轮形态字段（与 web/src/lib/datasetSide.ts 的双读规则对齐）
MULTITURN_FIELDS = ("task_description", "max_turns", "persona")


def _dataset_side(kind: str, cases: list[dict]) -> str:
    """双读归类：显式 simulation/redteam 定侧，否则按 cases 形态推断。"""
    if kind in ("simulation", "redteam"):
        return kind
    return "simulation" if any(c.get("task_description") for c in cases) else "regression"


def _shape_violation(cases: list[dict], kind: str) -> str | None:
    """形态纯度（ADR-0009）：回归集不得混入多轮字段；模拟集每条必须有 task_description。"""
    if kind == "regression":
        for i, c in enumerate(cases):
            field = next((f for f in MULTITURN_FIELDS if c.get(f)), None)
            if field:
                return (f"回归数据集不能包含多轮用例（第 {i + 1} 条 '{c.get('name', '')}' "
                        f"带 {field}）——请存为模拟集，或去掉多轮字段")
    elif kind == "simulation":
        for i, c in enumerate(cases):
            if not str(c.get("task_description") or "").strip():
                return (f"模拟集的每个任务都必须有 task_description（第 {i + 1} 条 "
                        f"'{c.get('name', '')}' 缺失）——请补全任务描述，或存为回归数据集")
    return None


def _dataset_from_item(i: dict) -> dict:
    """DDB item -> 数据集形状。list_datasets 的元素与 get_dataset 的返回**同一个
    映射**：两处各写一遍就会漂（少一个 kind 兜底、少一个 updated_at 都够让资源库
    与回归执行侧对同一个集合给出两种归类）。"""
    cases = json.loads(i["cases"])
    return {"name": i["sk"], "case_count": len(cases), "cases": cases,
            "kind": i.get("kind") or _infer_kind(i["sk"]),
            "target_agent": i.get("target_agent", ""),
            "risk_categories": json.loads(i["risk_categories"]) if i.get("risk_categories") else [],
            "source_keys": json.loads(i["source_keys"]) if i.get("source_keys") else [],
            "updated_at": int(i.get("updated_at", 0))}


def list_datasets() -> list[dict]:
    if not TABLE_NAME:
        return []
    items = get_table().query(
        KeyConditionExpression=Key("pk").eq("DATASET")
    ).get("Items", [])
    return sorted((_dataset_from_item(i) for i in items), key=lambda d: d["name"])


def get_dataset(name: str) -> dict | None:
    """按名取**一个**数据集（get_item 单读），找不到返回 None。

    为什么要有它（simplify-r2 E2）：五个调用点此前都写
    `next((d for d in list_datasets() if d["name"] == name), None)` —— 而
    list_datasets 是「读整个 DATASET 分区并 json.loads 每个集合的全部 cases」
    （单集上限约 396KB，见 SAFE_ITEM_BYTES 上方的说明）。「按名找一个」于是变成
    N 集 × 全部 cases 的读放大，且它还在工作台逐方案预估的乘法内层。

    返回形状与 list_datasets 的元素同形（同一个 _dataset_from_item）。

    空名字直接 None，不发请求：DynamoDB 的键属性不接受空串（会抛
    ValidationException），而调用侧的空名字是**正常**分支 —— 红队环节既没内嵌
    cases 也没配 cases_dataset 时就是空串，此前经 next(...) 天然得到 None。
    """
    if not TABLE_NAME or not str(name or "").strip():
        return None
    item = get_table().get_item(Key={"pk": "DATASET", "sk": name}).get("Item")
    return _dataset_from_item(item) if item else None


def _validate_cases(cases: list[dict], kind: str | None = None) -> None:
    """写库前的通用校验（save_dataset 与 append_dataset_cases 共用一份）：
    拒空 / kind 合法 / 条数上限 / 每条必有 input / 缺名补 `case-N`。"""
    # 拒空（UI-005）：空数组能存成 0 条用例的空集合——写入校验最前置拦截。
    # 只拦写入不拦读取：存量空集合仍可读可删，前端列表标异常是另一批的事。
    if not cases:
        raise ValueError("数据集至少需要一条用例")
    if kind is not None and kind not in DATASET_KINDS:
        raise ValueError(
            f"kind 必须是 {'/'.join(DATASET_KINDS)} 之一，收到 '{kind}'")
    if len(cases) > MAX_CASES:
        raise ValueError(f"dataset too large: {len(cases)} > {MAX_CASES} cases")
    for i, c in enumerate(cases):
        if not str(c.get("input", "")).strip():
            raise ValueError(f"case[{i}] missing 'input'")
        c.setdefault("name", f"case-{i + 1}")


def _enforce_shape(name: str, cases: list[dict], eff_kind: str, prev: dict | None) -> None:
    """形态纯度校验（ADR-0009）：新建强校验；已存在的集合只拦「本次保存会改变
    归类侧」的写入，纯编辑放行——存量混合集「只存不增」的既定原则。"""
    violation = _shape_violation(cases, eff_kind)
    if not violation:
        return
    if prev is None:
        raise ValueError(violation)
    prev_kind = prev.get("kind") or _infer_kind(name)
    prev_cases = json.loads(prev["cases"]) if prev.get("cases") else []
    if _dataset_side(eff_kind, cases) != _dataset_side(prev_kind, prev_cases):
        raise ValueError(violation)


def _build_dataset_item(name: str, cases: list[dict], prev: dict | None,
                        kind: str | None, target_agent: str | None,
                        source_keys: list[str] | None, risk_categories: list | None) -> dict:
    """组装整条 DATASET item（ADR-0012：cases 不外溢，单 item），并做体积预检。

    元数据保留惯例：未显式传入的字段沿用旧 item 的值。`version` 单调递增（旧 item
    没有则从 1 起），供 append_dataset_cases 的条件写做栅栏。"""
    item = {"pk": "DATASET", "sk": name,
            "cases": json.dumps(cases, ensure_ascii=False),
            "updated_at": int(time.time()),
            "version": int(prev.get("version", 0)) + 1 if prev else 1}
    if source_keys is None:  # keep existing provenance on plain edits
        if prev and prev.get("source_keys"):
            item["source_keys"] = prev["source_keys"]
    elif source_keys:
        item["source_keys"] = json.dumps(source_keys)
    # kind：显式传入 > 旧值 > 按命名前缀推断——保证新写入的 item 一定带 kind。
    if kind is not None:
        item["kind"] = kind
    elif prev and prev.get("kind"):
        item["kind"] = prev["kind"]
    else:
        item["kind"] = _infer_kind(name)
    if target_agent is not None:
        item["target_agent"] = target_agent
    elif prev and prev.get("target_agent"):
        item["target_agent"] = prev["target_agent"]
    if risk_categories is not None:
        item["risk_categories"] = json.dumps(risk_categories, ensure_ascii=False)
    elif prev and prev.get("risk_categories"):
        item["risk_categories"] = prev["risk_categories"]
    # 体积预检（见 SAFE_ITEM_BYTES 上的说明）：在 put 之前量整条 item —— 继承来的
    # source_keys / risk_categories 也占同一份预算。抛 ValueError 而不是让
    # PutItem 抛 ClientError，才能被 main.py 的 except (KeyError, ValueError)
    # 接住并变成流上的 {"event": "error"}，用户拿到「怎么办」而不是断流。
    size = _item_bytes(item)
    if size > SAFE_ITEM_BYTES:
        raise ValueError(_oversize_message(name, cases, size))
    return item


# _put_dataset_item 的 expected_version 取值：None = 无条件整表写（save_dataset 的
# 编辑语义不变）；0 = 该集合必须尚不存在（新建）；>0 = 库里 version 必须等于它；
# UNVERSIONED = 存量 item（有 pk、无 version 属性）——只要有人在本次读写之间用新代码
# 写过一次，version 就会出现，条件即失败。
UNVERSIONED = -1


def _fence_of(prev: dict | None) -> int:
    if prev is None:
        return 0
    return int(prev["version"]) if prev.get("version") is not None else UNVERSIONED


def _put_dataset_item(item: dict, expected_version: int | None = None) -> None:
    if expected_version is None:
        get_table().put_item(Item=item)
    elif expected_version == 0:
        get_table().put_item(Item=item, ConditionExpression="attribute_not_exists(pk)")
    elif expected_version == UNVERSIONED:
        get_table().put_item(
            Item=item, ConditionExpression="attribute_exists(pk) AND attribute_not_exists(version)")
    else:
        get_table().put_item(
            Item=item, ConditionExpression="version = :v",
            ExpressionAttributeValues={":v": int(expected_version)})


def save_dataset(name: str, cases: list[dict], source_keys: list[str] | None = None,
                 kind: str | None = None, target_agent: str | None = None,
                 risk_categories: list | None = None, create_only: bool = False) -> None:
    _validate_cases(cases, kind)
    # 元数据保留惯例：未显式传入的字段沿用旧 item 的值（统一只 get 一次；
    # 形态校验也需要 prev 判「新建 vs 编辑」，故总是取）。
    prev = get_table().get_item(Key={"pk": "DATASET", "sk": name}).get("Item")

    # 同名冲突（UI-003）：save_dataset 本质是 upsert，「新建」同名集合会静默
    # 覆盖原数据。带 create_only 的调用（新建入口）在 prev 存在时拒绝；
    # 不带的调用（编辑/AI 追加/旧客户端）行为完全不变。
    if create_only and prev is not None:
        raise ValueError(
            f"数据集 '{name}' 已存在——请更换名称，或在列表中打开原集合编辑")

    eff_kind = kind or (prev.get("kind") if prev else None) or _infer_kind(name)
    _enforce_shape(name, cases, eff_kind, prev)
    item = _build_dataset_item(name, cases, prev, kind, target_agent, source_keys, risk_categories)
    _put_dataset_item(item)


# ---------- 坏例入数据集（ADR-0017 D1）：服务端读 → 校验 → 去重 → 追加 → 条件写 ----------

# 只接 regression / redteam：回归测试未过的用例本来就在集里，simulation 的多轮回放二期。
APPENDABLE_KINDS = ("regression", "redteam")
ON_DUPLICATE = ("skip", "update")
APPEND_RETRIES = 3
# on_duplicate=update 只覆盖这三个键：name / input 是身份，攻击字段是红队生成器的产物。
_CASE_OVERWRITE_FIELDS = ("expected_output", "notes", "source")


def normalize_case_input(text) -> str:
    """去重键：strip、连续空白折成一个空格、casefold（与 ADR-0017 D1 同口径）。"""
    return " ".join(str(text or "").split()).casefold()


def _prepare_appended_cases(cases: list[dict], kind: str) -> list[dict]:
    """逐条校验并复制传入用例（复制：条件写冲突重试会重跑合并，不能改动调用方的 payload）。

    regression：expected_output 非空必填——数据集是回归的标准答案，存错答等于把缺陷
    固化（ADR-0017 D1）。redteam：形状照现有红队数据集；`input` 必填；前端按 D1 传的
    `objective` 同步到 `actor_goal`（redteam._to_redteam_case 读的是后者）。"""
    if not isinstance(cases, list) or not cases:
        raise ValueError("cases 至少需要一条用例")
    out = []
    for i, c in enumerate(cases):
        if not isinstance(c, dict):
            raise ValueError(f"第 {i + 1} 条用例不是对象")
        c = dict(c)
        if not str(c.get("input", "")).strip():
            raise ValueError(f"第 {i + 1} 条 input 为空")
        if kind == "regression" and not str(c.get("expected_output") or "").strip():
            raise ValueError(f"第 {i + 1} 条 expected_output 为空")
        if kind == "redteam" and c.get("objective") and not c.get("actor_goal"):
            c["actor_goal"] = c["objective"]
        out.append(c)
    return out


def _merge_cases(existing: list[dict], incoming: list[dict], on_duplicate: str):
    """按归一化 input 去重后合并。返回 (merged, added, updated, skipped)。
    批内重复同样按 on_duplicate 处理（第二条对第一条）。"""
    merged = [dict(c) for c in existing]
    index = {}
    for pos, c in enumerate(merged):
        index.setdefault(normalize_case_input(c.get("input")), pos)
    added = updated = skipped = 0
    for c in incoming:
        key = normalize_case_input(c.get("input"))
        pos = index.get(key)
        if pos is None:
            merged.append(c)
            index[key] = len(merged) - 1
            added += 1
        elif on_duplicate == "update":
            for f in _CASE_OVERWRITE_FIELDS:
                if f in c:
                    merged[pos][f] = c[f]
            updated += 1
        else:
            skipped += 1
    return merged, added, updated, skipped


def append_dataset_cases(name: str, cases: list[dict], kind: str,
                         create_if_missing: bool = False, target_agent: str | None = None,
                         on_duplicate: str = "skip") -> dict:
    """把坏例追加进数据集（ADR-0017 D1）。整表读改写，但用 version 条件写做栅栏：
    两人同时追加时后写的一方条件失败 → 重读重算再写，最多 APPEND_RETRIES 次，
    不会丢条（禁止前端读改写的理由就在这）。"""
    name = str(name or "").strip()
    if not name:
        raise ValueError("dataset 不能为空")
    if kind not in APPENDABLE_KINDS:
        raise ValueError(
            f"kind 必须是 {' / '.join(APPENDABLE_KINDS)} 之一（simulation 不接受追加），收到 '{kind}'")
    if on_duplicate not in ON_DUPLICATE:
        raise ValueError(f"on_duplicate 必须是 {' / '.join(ON_DUPLICATE)} 之一，收到 '{on_duplicate}'")
    incoming = _prepare_appended_cases(cases, kind)

    for _attempt in range(APPEND_RETRIES):
        prev = get_table().get_item(Key={"pk": "DATASET", "sk": name}).get("Item")
        if prev is None:
            if not create_if_missing:
                raise ValueError(f"数据集 '{name}' 不存在")
            existing = []
        else:
            prev_kind = prev.get("kind") or _infer_kind(name)
            if prev_kind != kind:
                raise ValueError(f"数据集 '{name}' 是 {prev_kind} 集，不能追加 {kind} 用例")
            existing = json.loads(prev["cases"]) if prev.get("cases") else []
        merged, added, updated, skipped = _merge_cases(existing, incoming, on_duplicate)
        result = {"dataset": name, "kind": kind, "added": added, "updated": updated,
                  "skipped_duplicates": skipped, "case_count": len(merged),
                  "created": prev is None}
        if not added and not updated:
            return result  # 全部命中且 skip：不写库
        _validate_cases(merged, kind)
        _enforce_shape(name, merged, kind, prev)
        # target_agent 只在新建时照传入落；已存在的集合沿用旧值（元数据保留惯例）
        item = _build_dataset_item(name, merged, prev, kind,
                                   target_agent if prev is None else None, None, None)
        try:
            _put_dataset_item(item, expected_version=_fence_of(prev))
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
            continue
        return result
    raise ValueError(
        f"数据集 '{name}' 正被其他写入修改，重试 {APPEND_RETRIES} 次仍冲突，请稍后再试")


def delete_dataset(name: str) -> None:
    get_table().delete_item(Key={"pk": "DATASET", "sk": name})


# ---------- per-agent span (trace) source overrides ----------

# Where an agent's OTel spans actually live when they are NOT in its dedicated
# runtime log group. CloudWatch Transaction Search / ADOT setups write every
# service's spans into the centralized `aws/spans` group, leaving the runtime
# group empty (storedBytes=0) — list_sessions against the runtime group then
# finds nothing forever. Spans in aws/spans carry no runtime ARN or agent-name
# attribute (verified against live data), so the agent→span mapping cannot be
# derived and must be configured per agent:
#   log_group      -> the span-bearing group ("" = keep using the runtime group)
#   scope_filter   -> instrumentationScope name (scope.name), optional
#   service_filter -> resource.attributes.service.name, optional
# Stored under its own pk so AGENTCFG's put_item (whole-item replace) can never
# clobber it and vice versa.


def get_span_source(agent_name: str) -> dict | None:
    """Configured span-source override for an agent, or None when unset."""
    if not TABLE_NAME:
        return None
    item = get_table().get_item(Key={"pk": "SPANSRC", "sk": agent_name}).get("Item")
    if not item:
        return None
    return {"log_group": item.get("log_group", ""),
            "scope_filter": item.get("scope_filter", ""),
            "service_filter": item.get("service_filter", ""),
            "updated_at": int(item["updated_at"]) if item.get("updated_at") else None}


def _drop_session_caches(agent_name: str) -> None:
    """Session lists were enumerated against the previous source — invalidate."""
    for sk in ("v1", "v1-test"):
        get_table().delete_item(Key={"pk": f"SESSCACHE/{agent_name}", "sk": sk})


def set_span_source(agent_name: str, log_group: str = "", scope_filter: str = "",
                    service_filter: str = "") -> None:
    """Persist a span-source override. At least one field must be non-empty
    (an all-empty override is indistinguishable from "not configured" — use
    delete_span_source for that)."""
    if not agent_name:
        raise ValueError("agent_name is required")
    log_group = (log_group or "").strip()
    scope_filter = (scope_filter or "").strip()
    service_filter = (service_filter or "").strip()
    if not (log_group or scope_filter or service_filter):
        raise ValueError(
            "span_source 至少需要 log_group / scope_filter / service_filter 之一；"
            "要清除配置请用 delete_span_source。")
    get_table().put_item(
        Item={"pk": "SPANSRC", "sk": agent_name, "log_group": log_group,
              "scope_filter": scope_filter, "service_filter": service_filter,
              "updated_at": int(time.time())}
    )
    _drop_session_caches(agent_name)


def delete_span_source(agent_name: str) -> None:
    get_table().delete_item(Key={"pk": "SPANSRC", "sk": agent_name})
    _drop_session_caches(agent_name)


# ---------- per-agent invocation templates ----------

DEFAULT_AGENT_CONFIG = {"payload_template": '{"prompt": "{input}"}', "response_path": ""}


def get_agent_config(agent_name: str) -> dict:
    if TABLE_NAME:
        item = get_table().get_item(Key={"pk": "AGENTCFG", "sk": agent_name}).get("Item")
        if item:
            return {"payload_template": item["payload_template"],
                    "response_path": item.get("response_path", ""),
                    # 轻量历史：谁在什么时候写的（auto=自动推断落库，manual=用户
                    # 手动保存）。完整 config_history 列表是后续项。
                    "updated_at": int(item["updated_at"]) if item.get("updated_at") else None,
                    "configured_by": item.get("configured_by", "manual")}
    # 未配置过：默认值 + 空历史（前端据 updated_at=None 判定"从未保存"）
    return {**DEFAULT_AGENT_CONFIG, "updated_at": None, "configured_by": None}


def set_agent_config(agent_name: str, payload_template: str, response_path: str = "",
                     configured_by: str = "manual") -> None:
    json.loads(payload_template.replace("{input}", "x"))  # must be valid JSON after substitution
    get_table().put_item(
        Item={"pk": "AGENTCFG", "sk": agent_name,
              "payload_template": payload_template, "response_path": response_path,
              "updated_at": int(time.time()),
              "configured_by": configured_by if configured_by in ("auto", "manual") else "manual"}
    )


def set_review(session_id: str, evaluator: str, verdict: str, note: str = "") -> None:
    """Persist a human verdict on one judge result. verdict: accurate|inaccurate."""
    get_table().put_item(
        Item={"pk": "REVIEW", "sk": f"{session_id}#{evaluator}",
              "verdict": verdict, "note": note[:1000], "updated_at": int(time.time())}
    )


def delete_review(session_id: str, evaluator: str) -> None:
    get_table().delete_item(Key={"pk": "REVIEW", "sk": f"{session_id}#{evaluator}"})


def list_reviews(session_ids: list[str]) -> dict:
    """{'<session>#<evaluator>': {verdict, note, updated_at}} for given sessions."""
    if not TABLE_NAME:
        return {}
    out = {}
    for sid in session_ids:
        items = get_table().query(
            KeyConditionExpression=Key("pk").eq("REVIEW") & Key("sk").begins_with(f"{sid}#")
        ).get("Items", [])
        for i in items:
            out[i["sk"]] = {"verdict": i.get("verdict"), "note": i.get("note", ""),
                            "updated_at": int(i.get("updated_at", 0))}
    return out


# ---------- 人工标注（ADR-0017 D2）：pk="ANNOT/<run_key>", sk="<row_key>#<evaluator>" ----------
#
# 人工分不改机器分：这里只写 ANNOT item，不碰 PLANRUN 的任何分数字段、不回填 pass_rate。
# run_key 自带 '#'（plan-…#2026…），所以它进 pk 而不进 sk；row_key / evaluator 另存为
# 属性，读侧不拆 sk。同一格（run_key, row_key, evaluator）重标 = 同键 put，覆盖旧值。

HUMAN_SCORES = (0, 0.5, 1)
ANNOTATION_BY = "manual"  # 后端没有用户身份，固定值
_LABEL_MAX_LEN = 120
_COMMENT_MAX_LEN = 2000


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _score_out(v) -> int | float:
    """DDB Decimal → JSON 数：整数值给 int（0 / 1），其余 float（0.5）。"""
    f = float(v)
    return int(f) if f.is_integer() else f


def _annotation_from_item(i: dict) -> dict:
    return {"run_key": i.get("run_key", ""), "row_key": i.get("row_key", ""),
            "evaluator": i.get("evaluator", ""), "human_score": _score_out(i.get("human_score", 0)),
            "label": i.get("label", ""), "comment": i.get("comment", ""),
            "by": i.get("by", ANNOTATION_BY), "at": i.get("at", "")}


def annotate_case(run_key: str, row_key: str, evaluator: str, human_score,
                  label: str = "", comment: str = "") -> dict:
    """写一格人工标注并返回落库形状。evaluator 为评估器名或 "overall"；
    human_score ∈ {0, 0.5, 1}（bool 不算数，"0.5" 字串也不算）。"""
    fields = {"run_key": str(run_key or "").strip(), "row_key": str(row_key or "").strip(),
              "evaluator": str(evaluator or "").strip()}
    for k, v in fields.items():
        if not v:
            raise ValueError(f"{k} 不能为空")
    if (isinstance(human_score, bool) or not isinstance(human_score, (int, float))
            or human_score not in HUMAN_SCORES):
        raise ValueError(f"human_score 必须是 0 / 0.5 / 1 之一，收到 {human_score!r}")
    score = _score_out(human_score)
    ann = {**fields, "human_score": score,
           "label": str(label or "")[:_LABEL_MAX_LEN],
           "comment": str(comment or "")[:_COMMENT_MAX_LEN],
           "by": ANNOTATION_BY, "at": _utc_now_iso()}
    get_table().put_item(Item={
        "pk": f"ANNOT/{fields['run_key']}", "sk": f"{fields['row_key']}#{fields['evaluator']}",
        **ann, "human_score": Decimal(str(score))})
    return ann


def list_annotations(run_key: str) -> list[dict]:
    """一次 run 的全部人工标注（按 sk 即 row_key#evaluator 升序）；没有 ⇒ []。"""
    run_key = str(run_key or "").strip()
    if not TABLE_NAME or not run_key:
        return []
    items = get_table().query(
        KeyConditionExpression=Key("pk").eq(f"ANNOT/{run_key}")).get("Items", [])
    return [_annotation_from_item(i) for i in items]


def refresh_sessions(agent_name: str, log_group: str, lookback_days: int, max_sessions: int,
                     include_test: bool = False, agent: dict | None = None) -> dict:
    """Run the live session enumeration and cache the result.

    Pass `agent` to route through tracesource.list_sessions (which honours a
    configured span_source override). Without it the plain CloudWatch path is
    used, which is what every AgentCore-only caller already relies on.
    """
    if agent is not None:
        import tracesource
        sessions = tracesource.list_sessions(agent, lookback_days, max_sessions, include_test)
    else:
        sessions = list_recent_sessions(log_group, lookback_days, max_sessions, include_test)
    now = int(time.time())
    if not TABLE_NAME:
        return {"sessions": sessions, "refreshed_at": now}
    get_table().put_item(
        Item={
            "pk": f"SESSCACHE/{agent_name}", "sk": "v1-test" if include_test else "v1",
            "data": json.dumps(sessions, ensure_ascii=False),
            "lookback_days": lookback_days, "max_sessions": max_sessions,
            "refreshed_at": now,
        }
    )
    return {"sessions": sessions, "refreshed_at": now}
