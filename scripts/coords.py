"""Deployment coordinates for the ad-hoc probe scripts.

Why this module exists: the probes used to carry a hardcoded account id, runtime
id, DynamoDB physical table name and target log group. Those are (a) tied to one
specific AWS account, so they cannot live in a public/shared repo, and (b) they
go stale silently -- a transcribed physical resource name keeps working right up
to the next redeploy, and then fails in a way that reads like a bug in the probe.

So every coordinate resolves in the same two steps:

  1. an environment variable (see ``.env.example`` at the repo root -- copy it to
     ``.env.local``, which is gitignored, then ``set -a; . ./.env.local; set +a``);
  2. otherwise **compute it now** from CloudFormation / CloudWatch Logs.

Every fallback here is read-only (``describe-*``). Nothing in this module
creates, updates or deletes anything.

Resolution is lazy and cached: importing this module (or any probe) must not
require AWS credentials, so that ``python3 -c "import coords"`` stays a valid
smoke test.
"""
import os
from functools import lru_cache

# Region is not a secret -- the real value stays in the tracked default.
REGION = os.environ.get("AWS_REGION", "us-west-2")

# Stack names are logical identifiers declared in infra/app.py, also not secrets.
RUNTIME_STACK = os.environ.get("EVAL_RUNTIME_STACK", "EvalAnythingRuntime")
UI_STACK = os.environ.get("EVAL_UI_STACK", "EvalAnythingUi")

_HINT = ("配置见仓库根的 `.env.example`：`cp .env.example .env.local` 填真值，"
         "然后 `set -a; . ./.env.local; set +a`。")


def _missing(var: str, how: str) -> SystemExit:
    # 措辞刻意把两件事分开印。早先这里只说「{var} 未设置」，把**现算路径本身坏了**
    # 伪装成「你忘了设环境变量」—— 读者照提示设上环境变量就走了，永远发现不了
    # 回落一次都没通过过（正是「无信号被当好信号」那族）。
    return SystemExit(
        f"取不到 {var}。两条路都没走通：\n"
        f"  1. 环境变量 {var}：未设置。\n"
        f"  2. 只读现算：失败 —— {how}\n"
        f"如果第 2 条的报错看起来不像「权限/网络/栈不存在」，那它就是 coords.py 的\n"
        f"缺陷，别只顾去设环境变量把它盖过去。\n{_HINT}")


@lru_cache(maxsize=None)
def _stack_output(stack: str, key: str) -> str:
    """Read a stack Output by key.

    Unlike resource logical ids, **Output keys are NOT hash-suffixed**: a
    ``CfnOutput(self, "RuntimeArn", ...)`` declared directly on the Stack keeps
    that exact key (see infra/stacks/eval_runtime_stack.py:323 and
    infra/stacks/ui_stack.py:421-423). So the bare name is right here -- this
    family is deliberately *not* the same as ``_physical_id``.
    """
    import boto3
    cfn = boto3.client("cloudformation", region_name=REGION)
    outs = cfn.describe_stacks(StackName=stack)["Stacks"][0].get("Outputs") or []
    for o in outs:
        if o["OutputKey"] == key:
            return o["OutputValue"]
    # 把现有 key 一并印出来：改名/删 Output 时才能一眼归因，而不是只看到 "no output"。
    raise KeyError(f"stack {stack} 没有名为 {key} 的 Output。"
                   f"现有的：{sorted(o['OutputKey'] for o in outs)}")


@lru_cache(maxsize=None)
def _physical_id(stack: str, logical_prefix: str, resource_type: str) -> str:
    """Physical name of a CDK-created resource, found by logical-id prefix + type.

    Why not ``describe_stack_resource``: **CDK appends a hash to resource logical
    ids** (``s3.Bucket(self, "SiteBucket")`` becomes ``SiteBucket1A2B3C4D`` -- that
    suffix is illustrative on purpose, the real one is deliberately not written
    down anywhere in this repo), so asking for the bare construct id raises
    ``ValidationError`` every single time.
    The hash must not be hardcoded either -- it is derived from the construct path
    and changes when the stack is restructured, which is the exact staleness bug
    this module exists to remove.

    So: list the resources, filter by ``ResourceType`` **and** logical-id prefix,
    and require **exactly one** hit.

    Both halves of that filter are load-bearing. Type alone is not enough: plenty
    of types repeat inside one stack (measured 2026-08-26 -- EvalAnythingUi has 3
    ``AWS::Lambda::Function``, 3 ``AWS::IAM::Role``, 2 ``AWS::IAM::Policy``;
    EvalAnythingRuntime has 4 roles and 2 ``AWS::Scheduler::Schedule``). The two
    resources we look up today (``SiteBucket``, ``CatalogTable``) do each happen to
    be the only one of their type in their stack right now, but leaning on that
    would be a trap that springs the day someone adds a second bucket -- so the
    prefix is always required.

    Zero hits and several hits both raise: quietly taking ``hits[0]`` returns an
    arithmetically valid *wrong* answer, which is worse than an error.
    """
    import boto3
    cfn = boto3.client("cloudformation", region_name=REGION)
    hits = []
    for page in cfn.get_paginator("list_stack_resources").paginate(StackName=stack):
        for r in page["StackResourceSummaries"]:
            if (r["ResourceType"] == resource_type
                    and r["LogicalResourceId"].startswith(logical_prefix)):
                hits.append((r["LogicalResourceId"], r.get("PhysicalResourceId")))
    if len(hits) != 1:
        raise KeyError(
            f"stack {stack}: 逻辑 id 前缀 {logical_prefix!r} + 类型 {resource_type} "
            f"命中 {len(hits)} 个，要求恰好 1 个。命中的逻辑 id："
            f"{[h[0] for h in hits]}")
    return hits[0][1]


@lru_cache(maxsize=None)
def eval_runtime_arn() -> str:
    """ARN of this project's own eval Runtime (the thing the probes invoke)."""
    v = os.environ.get("EVAL_RUNTIME_ARN")
    if v:
        return v
    try:
        return _stack_output(RUNTIME_STACK, "RuntimeArn")
    except Exception as e:                                    # noqa: BLE001
        raise _missing("EVAL_RUNTIME_ARN",
                       f"describe-stacks {RUNTIME_STACK} → RuntimeArn: {e}") from e


@lru_cache(maxsize=None)
def catalog_table() -> str:
    """Physical name of the catalog DynamoDB table (carries a CFN random suffix)."""
    v = os.environ.get("CATALOG_TABLE")
    if v:
        return v
    try:
        return _physical_id(RUNTIME_STACK, "CatalogTable", "AWS::DynamoDB::Table")
    except Exception as e:                                    # noqa: BLE001
        raise _missing(
            "CATALOG_TABLE",
            f"list-stack-resources {RUNTIME_STACK} 里找逻辑 id 前缀 CatalogTable "
            f"且类型 AWS::DynamoDB::Table 的资源：{e}") from e


@lru_cache(maxsize=None)
def probe_target_agent() -> str:
    """Which deployed agent the probe should exercise. Environment-specific:
    there is no sane default, so this one has no fallback."""
    v = os.environ.get("PROBE_TARGET_AGENT")
    if not v:
        raise SystemExit("PROBE_TARGET_AGENT 未设置：探针要打哪个被测 Agent "
                         "只有你知道（每个环境不一样，没有合理默认值）。\n" + _HINT)
    return v


@lru_cache(maxsize=None)
def probe_target_log_group() -> str:
    """The TARGET agent's log group -- the only place that can tell "reused a
    recording" from "quietly called the agent again".

    The runtime-id suffix is not derivable from the agent name, so the fallback
    lists log groups under the agent's prefix and picks the DEFAULT endpoint.
    """
    v = os.environ.get("PROBE_TARGET_LOG_GROUP")
    if v:
        return v
    agent = probe_target_agent()
    prefix = f"/aws/bedrock-agentcore/runtimes/{agent}-"
    try:
        import boto3
        logs = boto3.client("logs", region_name=REGION)
        # 分页：describe_log_groups 单页默认最多 50 条。前缀很窄，实际远不到，
        # 但不分页的话「命中落在第二页」会被读成零命中 —— 那是 fail-safe（报错而不是
        # 给错值），仍然是个会误导归因的坑，所以直接用 paginator 消掉。
        names = []
        for page in logs.get_paginator("describe_log_groups").paginate(
                logGroupNamePrefix=prefix):
            names += [g["logGroupName"] for g in page["logGroups"]]
        default = [n for n in names if n.endswith("-DEFAULT")]
        if len(default) == 1:
            return default[0]
        # 与 _physical_id 同一条纪律：零命中和多命中都报错，不静默取第一个。
        raise KeyError(
            f"前缀 {prefix} 下以 -DEFAULT 结尾的日志组命中 {len(default)} 个，"
            f"要求恰好 1 个：{default}（该前缀下共 {len(names)} 个日志组）")
    except SystemExit:
        raise
    except Exception as e:                                    # noqa: BLE001
        raise _missing("PROBE_TARGET_LOG_GROUP",
                       f"describe-log-groups --log-group-name-prefix {prefix}: {e}") from e
