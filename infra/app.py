#!/usr/bin/env python3
import os

import aws_cdk as cdk

from stacks.eval_runtime_stack import EvalRuntimeStack
from stacks.ui_stack import UiStack

env = cdk.Environment(
    account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
    region=os.environ.get("CDK_DEFAULT_REGION", "us-west-2"),
)

app = cdk.App()
runtime_stack = EvalRuntimeStack(app, "EvalAnythingRuntime", env=env)
UiStack(app, "EvalAnythingUi", eval_runtime_arn=runtime_stack.runtime_arn, env=env)
app.synth()
