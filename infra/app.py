#!/usr/bin/env python3
import os
import re

import aws_cdk as cdk

from stacks.eval_runtime_stack import RUNTIME_NAME, EvalRuntimeStack
from stacks.ui_stack import UiStack

env = cdk.Environment(
    account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
    region=os.environ.get("CDK_DEFAULT_REGION", "us-west-2"),
)

app = cdk.App()

# Isolated acceptance instance (main repo ADR-0020 D11): `cdk synth|deploy -c instance=strands`
# builds a SECOND Runtime+UI pair next to production, sharing nothing with it.
# No context => production, byte-for-byte the same template as before this switch
# existed (stack ids EvalAnythingRuntime / EvalAnythingUi, runtime "evalanything").
#
# Only physical names that CloudFormation does not generate get the instance
# woven in; everything else is auto-named by CFN and cannot collide:
#   stack id            EvalAnythingRuntime-<i> / EvalAnythingUi-<i>
#   runtime name        <i>_evalanything   (AgentCore name pattern [a-zA-Z][a-zA-Z0-9_]{0,47}
#                       forbids "-"; and it is a PREFIX, not a suffix, because
#                       app/plansched._own_runtime_arn matches its own runtime with
#                       runtime_id.startswith(RUNTIME_NAME) — "evalanything_<i>" would let
#                       PRODUCTION resolve to this instance's ARN)
#   reaper schedule     eval-reap-stale-runs-<i>
#   Cognito domain      eval-anything-<i>-<account>
instance = app.node.try_get_context("instance") or ""
if instance and not re.fullmatch(r"[a-z][a-z0-9]{0,15}", instance):
    raise ValueError(
        f"-c instance={instance!r}: lowercase letters/digits only (starts with a letter, "
        "<=16 chars) so it is legal in an AgentCore runtime name AND a Cognito domain prefix."
    )
suffix = f"-{instance}" if instance else ""
runtime_name = f"{instance}_{RUNTIME_NAME}" if instance else RUNTIME_NAME

runtime_stack = EvalRuntimeStack(
    app,
    f"EvalAnythingRuntime{suffix}",
    runtime_name=runtime_name,
    name_suffix=suffix,
    env=env,
)
UiStack(
    app,
    f"EvalAnythingUi{suffix}",
    eval_runtime_arn=runtime_stack.runtime_arn,
    name_suffix=suffix,
    env=env,
)
app.synth()
