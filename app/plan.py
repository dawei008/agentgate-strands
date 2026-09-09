"""评估方案（Plan）：可保存、可反复跑、含改进闭环的评估定义。

A plan binds ONE agent to an ordered list of stages and is the unit users
run, schedule, and track trends against. Runs of a plan land in planrun.py.

Storage (catalog table):
  pk="PLAN", sk=<plan_id> -> one item per plan

Stage shapes (validated by validate_plan):
  {"type": "observe", "lookback_days": 30, "max_sessions": 10,
   "evaluators": [...], "metrics": [...]}          # evaluators may be custom names
  {"type": "dataset", "dataset": "<global dataset name>", "evaluators": [...]}
  {"type": "redteam", "cases_dataset": "<global redteam case set name>",
   "strategies": [...]}
Datasets / custom evaluators / redteam case sets stay global resources; stages
reference them by name so several plans can share one dataset.

Plans are ALWAYS explicit user objects — there is no lazily materialized,
non-deletable per-agent default (that was tried and it flooded the plan list
with one template row per discovered agent). The UI's new-plan editor
pre-fills an observe-stage template instead, so "开箱即评" costs one save.

schedule: {"cron": "...", "budget_usd": 1.0} — persisted here; the scheduler
wiring lives in plansched.py. budget_usd is mandatory when a cron is set
because scheduled runs execute with nobody present to confirm cost.
"""

import re
import time
import uuid

from boto3.dynamodb.conditions import Key

import catalog

STAGE_TYPES = ("observe", "dataset", "redteam")

# 「只用上报数据评估」开关（ADR-0019）的默认值。2026-09-08 用户决定：默认开——新建方案默认
# 勾选，**旧方案 data 里没有这个键的也按开处理**（全平台默认走上报数据评估）；只有显式
# False 才关。批 1 时曾是「缺键 = 关」，那条口径已废。
TRACE_REQUIRED_DEFAULT = True


def trace_required(plan: dict | None) -> bool:
    """开关的**唯一**读法：缺键 / None ⇒ TRACE_REQUIRED_DEFAULT（开）；只有显式 False 才关。

    save_plan / _from_item / planrun 的四处读开关都走这里——默认值只写一次，别在别处
    再写一个 `plan.get("trace_required")`（缺键在那种写法下会被读成关）。
    """
    value = (plan or {}).get("trace_required")
    return TRACE_REQUIRED_DEFAULT if value is None else bool(value)


def _table():
    return catalog.get_table()


def _check_evaluator_scopes(i: int, stage_kind: str, names: list[str],
                            custom_scopes: dict[str, str]) -> None:
    """Reject evaluators that don't apply to this stage kind.

    分类来自 registry（内置）与 catalog 的 custom scope 字段，不在这里硬编码
    评估器名单。观测环节的 trace 没有 expected_output 也没有用例图片，所以
    dataset-only 的内置（correctness/mm_*）和 scope="dataset" 的自定义都进不去；
    反向地，scope="observe" 的自定义进不了回归环节。未知名不在这里管——
    build_evaluators 会报，且遗漏拦截不会造成错配执行。
    """
    from registry import dataset_only_evaluators
    dataset_only = dataset_only_evaluators()
    for n in names:
        cscope = custom_scopes.get(n)
        if stage_kind == "observe" and (n in dataset_only or cscope == "dataset"):
            raise ValueError(
                f"环节 {i}：评估器 '{n}' 只适用于数据集回归环节"
                "（它需要期望输出/用例图片等观测 trace 不具备的信息），"
                "不能用于观测环节")
        if stage_kind == "dataset" and cscope == "observe":
            raise ValueError(
                f"环节 {i}：自定义评估器 '{n}' 标记为只适用于观测环节，"
                "不能用于数据集回归环节")


def validate_plan(plan: dict, agent: dict) -> None:
    """Raise ValueError with a user-facing message on any structural problem.

    agent is the catalog entry the plan binds to.
    """
    if not plan.get("name", "").strip():
        raise ValueError("方案需要一个名字")
    stages = plan.get("stages") or []
    if not stages:
        raise ValueError("方案至少要有一个环节")
    dataset_names = None  # fetched lazily; only when a stage needs checking
    custom_scopes = None  # same: one catalog read even for multi-stage plans
    for i, st in enumerate(stages, 1):
        kind = st.get("type")
        if kind not in STAGE_TYPES:
            raise ValueError(f"环节 {i}：未知类型 '{kind}'（可选 observe/dataset/redteam）")
        if kind in ("observe", "dataset") and st.get("evaluators"):
            if custom_scopes is None:
                custom_scopes = {e["name"]: e["scope"]
                                 for e in catalog.list_custom_evaluators()}
            _check_evaluator_scopes(i, kind, st["evaluators"], custom_scopes)
        if kind == "observe":
            if not (st.get("evaluators") or st.get("metrics")):
                raise ValueError(f"环节 {i}：观测环节需要至少一个评估器或指标")
        elif kind == "dataset":
            name = st.get("dataset", "")
            if dataset_names is None:
                dataset_names = {d["name"] for d in catalog.list_datasets()}
            if name not in dataset_names:
                raise ValueError(f"环节 {i}：数据集 '{name}' 不存在")
            # 零评估器的回归环节此前存得下去、也照跑：真调被测 Agent 打完全部
            # 用例（现场 10 次 × 10.3s），judged=0，最后只显示一句「无可评估
            # 数据」——钱与时间全花在一次注定没有产出的运行上（P1，2026-08-24）。
            # 观测环节早有同族的这一句（评估器**或**指标，因为指标可以独立成立）；
            # 回归环节没有指标这一维：没有评估器就没有任何判定来源。
            if not (st.get("evaluators") or []):
                raise ValueError(f"环节 {i}：回归环节需要至少一个评估器"
                                 "（没有评估器就没有判定来源，运行只会白花钱）")
        elif kind == "redteam":
            if not st.get("cases_dataset") and not st.get("cases"):
                raise ValueError(f"环节 {i}：红队环节需要用例集（cases_dataset 或内嵌 cases）")
    sched = plan.get("schedule")
    if sched:
        cron = (sched.get("cron") or "").strip()
        if not re.fullmatch(r"cron\([^)]+\)|rate\([^)]+\)", cron):
            raise ValueError("定时表达式需形如 cron(0 0 ? * MON *) 或 rate(7 days)")
        budget = sched.get("budget_usd")
        if not isinstance(budget, (int, float)) or budget <= 0:
            raise ValueError("启用定时必须设置单次预算上限（USD，>0）——定时触发时无人在场确认成本")


def list_plans(agent_name: str | None = None) -> list[dict]:
    """All saved plans, optionally filtered to one agent's."""
    items = _table().query(KeyConditionExpression=Key("pk").eq("PLAN")).get("Items", [])
    plans = [_from_item(i) for i in items]
    if agent_name:
        plans = [p for p in plans if p["agent_name"] == agent_name]
    return sorted(plans, key=lambda p: -p["updated_at"])


def get_plan(plan_id: str) -> dict | None:
    item = _table().get_item(Key={"pk": "PLAN", "sk": plan_id}).get("Item")
    return _from_item(item) if item else None


def save_plan(plan: dict, agent: dict) -> dict:
    """Create or update a plan."""
    validate_plan(plan, agent)
    plan_id = plan.get("plan_id") or f"plan-{uuid.uuid4().hex[:12]}"
    import json as _json
    _table().put_item(Item={
        "pk": "PLAN", "sk": plan_id,
        "name": plan["name"].strip(),
        "agent_name": plan["agent_name"],
        "data": _json.dumps({"stages": plan["stages"],
                             "schedule": plan.get("schedule"),
                             "trace_required": trace_required(plan)},
                            ensure_ascii=False),
        "updated_at": int(time.time()),
    })
    return {**plan, "plan_id": plan_id}


def delete_plan(plan_id: str) -> None:
    _table().delete_item(Key={"pk": "PLAN", "sk": plan_id})


def _from_item(item: dict) -> dict:
    import json as _json
    data = _json.loads(item.get("data") or "{}")
    return {
        "plan_id": item["sk"],
        "name": item.get("name", ""),
        "agent_name": item.get("agent_name", ""),
        "stages": data.get("stages") or [],
        "schedule": data.get("schedule"),
        # ADR-0019：只用上报数据评估。老方案查无此键 → 开（2026-09-08 默认开；见 trace_required）。
        "trace_required": trace_required(data),
        "updated_at": int(item.get("updated_at", 0)),
    }
