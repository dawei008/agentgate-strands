"""Stack A: eval-anything evaluation service on AgentCore Runtime."""

import json

from aws_cdk import CfnOutput, Duration, RemovalPolicy, Stack
from aws_cdk import aws_bedrockagentcore as agentcore
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_ecr_assets as ecr_assets
from aws_cdk import aws_iam as iam
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_scheduler as scheduler
from constructs import Construct

RUNTIME_NAME = "evalanything"


class EvalRuntimeStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # Build-time only switch. networkMode participates in the CDK asset hash, so the
        # two states produce different image tags (and a new Runtime version): the ON
        # state is byte-identical to the pre-switch code, OFF is a different asset.
        # Default off = Docker's normal bridge network. The original dev box
        # intercepts TLS on the bridge network (pip cannot reach PyPI during the
        # image build), so it needs `-c dockerHostNetwork=true`; Docker Desktop on
        # Mac/Windows gives `--network=host` different semantics, so it must not
        # be baked in for everyone.
        docker_host_network = self.node.try_get_context("dockerHostNetwork") in (True, "true", "1")
        image_kwargs: dict = {}
        if docker_host_network:
            image_kwargs["network_mode"] = ecr_assets.NetworkMode.HOST

        image = ecr_assets.DockerImageAsset(
            self,
            "EvalServiceImage",
            directory="../app",
            platform=ecr_assets.Platform.LINUX_ARM64,
            **image_kwargs,
        )

        role = iam.Role(
            self,
            "EvalRuntimeRole",
            assumed_by=iam.ServicePrincipal(
                "bedrock-agentcore.amazonaws.com",
                conditions={
                    "StringEquals": {"aws:SourceAccount": self.account},
                    "ArnLike": {
                        "aws:SourceArn": f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:*"
                    },
                },
            ),
        )

        image.repository.grant_pull(role)
        # grant_pull covers repo-scoped actions; the auth token is account-wide.
        role.add_to_policy(
            iam.PolicyStatement(
                sid="EcrAuthToken",
                actions=["ecr:GetAuthorizationToken"],
                resources=["*"],
            )
        )

        # Discover agents; enumerate sessions and pull traces via Logs Insights.
        role.add_to_policy(
            iam.PolicyStatement(
                sid="DiscoverAgents",
                actions=["bedrock-agentcore:ListAgentRuntimes"],
                resources=["*"],
            )
        )
        # Dataset test mode invokes the agents under test.
        role.add_to_policy(
            iam.PolicyStatement(
                sid="InvokeAgentsUnderTest",
                actions=["bedrock-agentcore:InvokeAgentRuntime"],
                resources=[f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:runtime/*"],
            )
        )
        # ⚠️ 这份 action 清单必须覆盖 app/ 里**每一个**对 logs 客户端的调用，
        # 由 tests/test_r2_infra_logs_actions.py 逐调用点钉住。漏一个的现场
        # （实测 2026-08-27，v71 首轮 A/B）：低延迟读法换成 filter_log_events 之后
        # 角色只有 Insights 三件套 ⇒ 每侧首个用例 AccessDeniedException ⇒
        # `_span_degrade` 的 not-missing 分支立刻熔断，其余 14 例全 SKIPPED，
        # 两侧 30 个用例的 tool_evidence 全是 unavailable。本地探针照不出它：
        # 那把尺子用的是管理员凭证，跟运行时角色不是同一把。
        role.add_to_policy(
            iam.PolicyStatement(
                sid="ReadRuntimeTraces",
                actions=[
                    "logs:DescribeLogGroups",
                    "logs:StartQuery",
                    "logs:GetQueryResults",
                    "logs:FilterLogEvents",
                ],
                resources=["*"],
            )
        )

        # Weekly price sync reads the AWS Pricing API (us-east-1 only endpoint).
        role.add_to_policy(
            iam.PolicyStatement(
                sid="ReadPricing",
                actions=["pricing:GetProducts"],
                resources=["*"],
            )
        )

        # Judge API keys (judgellm.py, OpenAI-compatible endpoints) are fetched
        # at run time, never stored in the catalog or the image. Scoped to an
        # "eval-anything/" name prefix so this role cannot read unrelated
        # secrets in the account; store keys under that prefix.
        role.add_to_policy(
            iam.PolicyStatement(
                sid="ReadTraceSourceCredentials",
                actions=["secretsmanager:GetSecretValue"],
                resources=[
                    f"arn:aws:secretsmanager:{self.region}:{self.account}:secret:eval-anything/*"
                ],
            )
        )

        # LLM judge (Sonnet 5 default, payload may override to other Anthropic models).
        role.add_to_policy(
            iam.PolicyStatement(
                sid="InvokeJudgeModel",
                actions=["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                resources=[
                    f"arn:aws:bedrock:*:{self.account}:inference-profile/*.anthropic.*",
                    "arn:aws:bedrock:*::foundation-model/anthropic.*",
                ],
            )
        )

        # Own observability: runtime log group + ADOT (X-Ray traces, EMF metrics).
        role.add_to_policy(
            iam.PolicyStatement(
                sid="WriteOwnTelemetry",
                actions=[
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                    "logs:DescribeLogStreams",
                    "xray:PutTraceSegments",
                    "xray:PutTelemetryRecords",
                    "cloudwatch:PutMetricData",
                ],
                resources=["*"],
            )
        )

        # Source-material archive: attachments/context used to generate datasets.
        artifacts_bucket = s3.Bucket(
            self,
            "ArtifactsBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            enforce_ssl=True,
            encryption=s3.BucketEncryption.S3_MANAGED,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
            lifecycle_rules=[
                s3.LifecycleRule(
                    id="archive-then-keep",
                    transitions=[
                        s3.Transition(
                            storage_class=s3.StorageClass.INFREQUENT_ACCESS,
                            transition_after=Duration.days(90),
                        )
                    ],
                )
            ],
        )
        artifacts_bucket.grant_read_write(role)

        catalog_table = dynamodb.Table(
            self,
            "CatalogTable",
            partition_key=dynamodb.Attribute(name="pk", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="sk", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            removal_policy=RemovalPolicy.DESTROY,
            # evaluation-result cache rows (pk=EVALCACHE/*) carry expires_at;
            # other item kinds simply omit it and are never expired.
            time_to_live_attribute="expires_at",
        )
        catalog_table.grant_read_write_data(role)

        # Scheduled plan runs: the service creates one EventBridge schedule per
        # plan at save time; each schedule invokes this runtime with
        # {"action": "run_plan", ...} using this role. Created before the
        # runtime so its ARN can ride in as an env var.
        plan_scheduler_role = iam.Role(
            self,
            "PlanSchedulerRole",
            assumed_by=iam.ServicePrincipal("scheduler.amazonaws.com"),
        )
        plan_scheduler_role.add_to_policy(
            iam.PolicyStatement(
                actions=["bedrock-agentcore:InvokeAgentRuntime"],
                resources=[
                    f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:runtime/*"
                ],
            )
        )

        runtime = agentcore.CfnRuntime(
            self,
            "EvalRuntime",
            agent_runtime_name=RUNTIME_NAME,
            description="eval-anything: evaluates deployed AgentCore agents from their CloudWatch traces",
            role_arn=role.role_arn,
            agent_runtime_artifact=agentcore.CfnRuntime.AgentRuntimeArtifactProperty(
                container_configuration=agentcore.CfnRuntime.ContainerConfigurationProperty(
                    container_uri=image.image_uri
                )
            ),
            network_configuration=agentcore.CfnRuntime.NetworkConfigurationProperty(
                network_mode="PUBLIC"
            ),
            environment_variables={
                "CATALOG_TABLE": catalog_table.table_name,
                "ARTIFACTS_BUCKET": artifacts_bucket.bucket_name,
                "PLAN_SCHEDULER_ROLE_ARN": plan_scheduler_role.role_arn,
                # The runtime ARN is self-referential (CloudFormation cannot
                # inject an attribute of a resource into that same resource's
                # env), so it is derived from the fixed runtime name instead —
                # bedrock-agentcore runtime ARNs embed a generated id, hence
                # the service resolves it at startup via ListAgentRuntimes and
                # this name is the lookup key.
                "RUNTIME_NAME": RUNTIME_NAME,
                # 被测 Agent 的 ADOT 采样器是 parentbased_always_on ⇒ 它采不采样
                # 跟着**我们**走：本服务被账号的 X-Ray 默认 5% 规则采样，剩下 ~85%
                # 的调用带着 sampled=0 的父过去，被测 Agent 就把整条 trace 丢了
                # （现网 2026-09-07：fable5 当天 25 次调用全 trace_sampled=False、
                # 零 span；08-16 那批 True 时 span 齐全）。评估服务的每一次调用都
                # 必须留下 trace，否则「Agent 没开观测」与「这次没被采样」同形。
                "OTEL_TRACES_SAMPLER": "always_on",
            },
        )

        # The service manages plan schedules (create/update/delete) at plan
        # save time, and must be able to hand the scheduler role to them.
        role.add_to_policy(
            iam.PolicyStatement(
                sid="ManagePlanSchedules",
                actions=[
                    "scheduler:CreateSchedule",
                    "scheduler:UpdateSchedule",
                    "scheduler:DeleteSchedule",
                    "scheduler:GetSchedule",
                ],
                resources=[
                    f"arn:aws:scheduler:{self.region}:{self.account}:schedule/default/eval-plan-*"
                ],
            )
        )
        role.add_to_policy(
            iam.PolicyStatement(
                sid="PassPlanSchedulerRole",
                actions=["iam:PassRole"],
                resources=[plan_scheduler_role.role_arn],
                conditions={
                    "StringEquals": {"iam:PassedToService": "scheduler.amazonaws.com"}
                },
            )
        )

        # AgentCore validates ECR pull permissions at create time; make sure the
        # role's inline policy is attached before the runtime is created.
        default_policy = role.node.try_find_child("DefaultPolicy")
        if default_policy is not None:
            runtime.node.add_dependency(default_policy)

        self.runtime_arn = runtime.attr_agent_runtime_arn

        # Weekly price sync: EventBridge Scheduler invokes the runtime directly.
        scheduler_role = iam.Role(
            self,
            "PriceSyncSchedulerRole",
            assumed_by=iam.ServicePrincipal("scheduler.amazonaws.com"),
        )
        scheduler_role.add_to_policy(
            iam.PolicyStatement(
                actions=["bedrock-agentcore:InvokeAgentRuntime"],
                resources=[self.runtime_arn, f"{self.runtime_arn}/*"],
            )
        )
        scheduler.CfnSchedule(
            self,
            "WeeklyPriceSync",
            schedule_expression="cron(0 0 ? * MON *)",  # Mondays 00:00 UTC
            flexible_time_window=scheduler.CfnSchedule.FlexibleTimeWindowProperty(
                mode="FLEXIBLE", maximum_window_in_minutes=60
            ),
            target=scheduler.CfnSchedule.TargetProperty(
                arn="arn:aws:scheduler:::aws-sdk:bedrockagentcore:invokeAgentRuntime",
                role_arn=scheduler_role.role_arn,
                input=json.dumps(
                    {
                        "AgentRuntimeArn": self.runtime_arn,
                        "RuntimeSessionId": "price-sync-0000000000000000000000000",
                        "ContentType": "application/json",
                        "Payload": json.dumps({"action": "refresh_prices"}),
                    }
                ),
            ),
        )

        # Stale-run reaper (UI-029): same Scheduler -> runtime sdk target, so it
        # stays entirely on the internal IAM plane -- no new public entry point.
        # The role above is reused: both schedules need the exact same single
        # action on the same runtime ARN, and its logical ID must keep the
        # PriceSync name (renaming = CFN resource replacement, which would point
        # the weekly schedule at a deleted role for a moment).
        scheduler.CfnSchedule(
            self,
            "StaleRunReaper",
            name="eval-reap-stale-runs",
            description="Converge stale running PLANRUN records (UI-029)",
            schedule_expression="rate(10 minutes)",
            # No flexible window at a 10-minute cadence: price sync's
            # FLEXIBLE/60 only makes sense for a weekly job.
            flexible_time_window=scheduler.CfnSchedule.FlexibleTimeWindowProperty(
                mode="OFF"
            ),
            target=scheduler.CfnSchedule.TargetProperty(
                arn="arn:aws:scheduler:::aws-sdk:bedrockagentcore:invokeAgentRuntime",
                role_arn=scheduler_role.role_arn,
                input=json.dumps(
                    {
                        "AgentRuntimeArn": self.runtime_arn,
                        # execution-id is unique per attempt, so 10-minute
                        # invocations don't pile onto one 8h AgentCore session.
                        # It is only 16 chars though, and runtimeSessionId has a
                        # 33-char floor -- hence the static prefix padding.
                        "RuntimeSessionId": (
                            "reap-stale-runs-0000000000000000"
                            "-<aws.scheduler.execution-id>"
                        ),
                        "ContentType": "application/json",
                        "Payload": json.dumps({"action": "reap_stale_runs"}),
                    }
                ),
            ),
        )

        CfnOutput(self, "RuntimeArn", value=self.runtime_arn)
        CfnOutput(self, "RuntimeRoleArn", value=role.role_arn)
