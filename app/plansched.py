"""Scheduled plan runs via EventBridge Scheduler.

One schedule per plan, name "eval-plan-<plan_id>", same direct-invoke pattern
as the weekly price sync: Scheduler calls invokeAgentRuntime on THIS runtime
with {"action": "run_plan", "plan_id": ..., "triggered_by": "schedule"}.

The scheduler role and this runtime's ARN come in via environment variables
(set by the CDK stack); enabling a schedule fails with a clear message when
the stack predates them.

Cost gate: a scheduled trigger runs with nobody present, so plan.schedule
carries a mandatory budget_usd. main.py's run_plan handler estimates first and
records a skipped run instead of executing when the estimate exceeds it.
"""

import json
import logging
import os

import boto3

from discovery import REGION

logger = logging.getLogger("eval-anything")

SCHEDULE_PREFIX = "eval-plan-"

# Provided by the CDK stack.
SCHEDULER_ROLE_ARN = os.environ.get("PLAN_SCHEDULER_ROLE_ARN", "")
# The runtime's own ARN is self-referential (CloudFormation cannot inject a
# resource's attribute into that resource's env), so the stack passes the fixed
# runtime NAME and the ARN is resolved once via ListAgentRuntimes.
RUNTIME_NAME = os.environ.get("RUNTIME_NAME", "")
_runtime_arn_cache: str | None = None


def _own_runtime_arn() -> str:
    global _runtime_arn_cache
    if _runtime_arn_cache is None:
        from discovery import list_agents
        _runtime_arn_cache = next(
            (a["runtime_arn"] for a in list_agents()
             if a.get("runtime_id", "").startswith(RUNTIME_NAME)
             or a.get("agent_name") == RUNTIME_NAME), "") if RUNTIME_NAME else ""
    return _runtime_arn_cache


def _client():
    return boto3.client("scheduler", region_name=REGION)


def _schedule_name(plan_id: str) -> str:
    # plan ids are always "plan-<12hex>" (save_plan generates them), which is
    # already valid for Scheduler names ([0-9a-zA-Z-_.], <=64 chars). The
    # truncation guards the invariant if id formats ever change — applied to
    # the FULL name (prefix included), since that is what Scheduler limits.
    return (SCHEDULE_PREFIX + plan_id)[:64]


def sync_schedule(plan: dict) -> dict:
    """Create/update/delete the schedule to match plan['schedule'].

    Returns {"scheduled": bool} for the UI. Called from save_plan's handler —
    schedule state always follows the saved plan, never drifts separately.
    """
    name = _schedule_name(plan["plan_id"])
    sched = plan.get("schedule")
    if not sched or not sched.get("cron"):
        try:
            _client().delete_schedule(Name=name)
        except _client().exceptions.ResourceNotFoundException:
            pass
        return {"scheduled": False}

    runtime_arn = _own_runtime_arn()
    if not SCHEDULER_ROLE_ARN or not runtime_arn:
        raise ValueError(
            "定时功能需要栈更新：缺少 PLAN_SCHEDULER_ROLE_ARN / RUNTIME_NAME 环境变量"
            "（或无法解析本服务的 Runtime ARN），请先部署包含 PlanSchedulerRole 的版本。")

    payload = {"action": "run_plan", "plan_id": plan["plan_id"],
               "triggered_by": "schedule"}
    # Deterministic session id per plan: scheduled runs of one plan share a
    # session, which is fine — each invocation is independent.
    session_id = (f"plan-sched-{plan['plan_id']}"[:80]).ljust(33, "0")
    target = {
        "Arn": "arn:aws:scheduler:::aws-sdk:bedrockagentcore:invokeAgentRuntime",
        "RoleArn": SCHEDULER_ROLE_ARN,
        "Input": json.dumps({
            "AgentRuntimeArn": runtime_arn,
            "RuntimeSessionId": session_id,
            "ContentType": "application/json",
            "Payload": json.dumps(payload),
        }),
    }
    kwargs = dict(
        Name=name,
        ScheduleExpression=sched["cron"],
        FlexibleTimeWindow={"Mode": "FLEXIBLE", "MaximumWindowInMinutes": 60},
        Target=target,
        State="ENABLED",
        Description=f"eval-anything plan {plan['name']} ({plan['agent_name']})",
    )
    client = _client()
    try:
        client.update_schedule(**kwargs)
    except client.exceptions.ResourceNotFoundException:
        client.create_schedule(**kwargs)
    return {"scheduled": True, "schedule_name": name}


def delete_schedule(plan_id: str) -> None:
    client = _client()
    try:
        client.delete_schedule(Name=_schedule_name(plan_id))
    except client.exceptions.ResourceNotFoundException:
        pass
