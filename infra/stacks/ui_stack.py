"""Stack B: public UI for eval-anything.

Security posture (account hard constraints):
  - S3 bucket: all four public-access blocks on, reachable only via CloudFront OAC.
  - Lambda Function URL: AuthType=AWS_IAM, invocable only by cloudfront.amazonaws.com
    scoped to this distribution (Lambda OAC, SigV4). Never NONE.
  - Browser must send x-amz-content-sha256 (SHA-256 of POST body) for OAC signing.
  - Teardown: destroying this stack removes the distribution together with its
    origins (no dangling-origin state); bucket auto-deletes objects.

Front-end layout (React migration, T1b):
  Both front-ends live in ONE bucket under disjoint key spaces, so rollback never
  needs a redeploy of the other one:
    /                 legacy ui/ (index.html + app.js + config.json)
    /react/           Vite build output (web/dist: hashed assets/ + index.html)
  Which one the public sees is decided ONLY by the CloudFront S3 origin path,
  flipped via the `reactLive` CDK context flag (see REACT_PREFIX below).

  ⚠️ Pruning hazard (measured 2026-08-21, not theoretical): BucketDeployment
  defaults to prune=true, and a deployment WITHOUT destination_key_prefix is
  scoped to the bucket ROOT — an `aws s3 sync --delete` at root deletes
  react/** wholesale. Verified on a scratch bucket: syncing the legacy two
  files at root removed both react/index.html and react/assets/*. Hence the
  legacy deployment MUST carry exclude=["react/*"], and the React deployment
  MUST set destination_key_prefix (which confines its own prune to that
  prefix). Removing either guard makes the two deployments delete each other.
"""

import base64
from pathlib import Path

from aws_cdk import CfnOutput, Duration, RemovalPolicy, Stack
from aws_cdk import aws_cloudfront as cloudfront
from aws_cdk import aws_cloudfront_origins as origins
from aws_cdk import aws_cognito as cognito
from aws_cdk import aws_iam as iam
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_s3_deployment as s3deploy
from constructs import Construct

# S3 key prefix holding the Vite build output. Also the CloudFront origin path
# when the React front-end is live. Kept as one constant so the cutover and the
# rollback touch exactly one thing.
REACT_PREFIX = "react"


class UiStack(Stack):
    def __init__(
        self, scope: Construct, construct_id: str, *, eval_runtime_arn: str, **kwargs
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # Cutover switch. Default False = public traffic still served from the
        # legacy root prefix; the React bundle is uploaded but dark.
        #   go live : cdk deploy EvalAnythingUi -c reactLive=true
        #   roll back: cdk deploy EvalAnythingUi          (flag absent => False)
        # Only the CloudFront origin path changes; no S3 content moves, so
        # rollback cannot lose the other front-end's files.
        react_live = self.node.try_get_context("reactLive") in (True, "true", "1")

        # Build output is optional on disk: this stack must still synth before
        # web/ exists (react-core is scaffolding it in parallel) and for the
        # legacy-only path. When missing, the React deployment is skipped
        # entirely rather than synthesizing a broken asset reference.
        react_dist = Path(__file__).resolve().parents[2] / "web" / "dist"
        react_dist_present = (react_dist / "index.html").is_file()
        if react_live and not react_dist_present:
            raise ValueError(
                "reactLive=true but web/dist/index.html is missing — run "
                "`cd web && npm ci && npm run build` before the cutover deploy."
            )

        site_bucket = s3.Bucket(
            self,
            "SiteBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            enforce_ssl=True,
            encryption=s3.BucketEncryption.S3_MANAGED,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
        )

        user_pool = cognito.UserPool(
            self,
            "UserPool",
            self_sign_up_enabled=False,
            sign_in_aliases=cognito.SignInAliases(email=True, username=True),
            password_policy=cognito.PasswordPolicy(min_length=12),
            removal_policy=RemovalPolicy.DESTROY,
        )
        # Managed Login v2（新版品牌编辑器）。CFN 属性 ManagedLoginVersion 为
        # "Update requires: No interruption"：同一 CfnUserPoolDomain 原地更新，
        # domain 前缀不变，OAuth 回调 URL 不受影响。
        domain = user_pool.add_domain(
            "HostedUi",
            cognito_domain=cognito.CognitoDomainOptions(
                domain_prefix=f"eval-anything-{self.account}"
            ),
            managed_login_version=cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
        )

        proxy_fn = lambda_.Function(
            self,
            "UiProxy",
            runtime=lambda_.Runtime.NODEJS_22_X,
            architecture=lambda_.Architecture.ARM_64,
            handler="index.handler",
            code=lambda_.Code.from_asset("../ui-proxy"),
            timeout=Duration.minutes(15),
            memory_size=256,
        )
        proxy_fn.add_to_role_policy(
            iam.PolicyStatement(
                actions=["bedrock-agentcore:InvokeAgentRuntime"],
                resources=[eval_runtime_arn, f"{eval_runtime_arn}/*"],
            )
        )

        fn_url = proxy_fn.add_function_url(
            auth_type=lambda_.FunctionUrlAuthType.AWS_IAM,
            invoke_mode=lambda_.InvokeMode.RESPONSE_STREAM,
        )

        distribution = cloudfront.Distribution(
            self,
            "Distribution",
            default_root_object="index.html",
            default_behavior=cloudfront.BehaviorOptions(
                # The ONLY thing the cutover changes. origin_path is prepended
                # to every request path before it reaches S3, so "/react" makes
                # GET / resolve to react/index.html and GET /assets/x.js to
                # react/assets/x.js — no S3 content moves, no key rewrites.
                # Changing origin_path replaces the origin in-place (CloudFront
                # config update, ~3-5 min propagation); it does NOT recreate the
                # distribution, so the domain and OAC grant are preserved.
                origin=origins.S3BucketOrigin.with_origin_access_control(
                    site_bucket,
                    origin_path=f"/{REACT_PREFIX}" if react_live else None,
                ),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            ),
            additional_behaviors={
                "/api/*": cloudfront.BehaviorOptions(
                    origin=origins.FunctionUrlOrigin.with_origin_access_control(
                        fn_url,
                        read_timeout=Duration.seconds(60),
                    ),
                    allowed_methods=cloudfront.AllowedMethods.ALLOW_ALL,
                    cache_policy=cloudfront.CachePolicy.CACHING_DISABLED,
                    # The viewer must not send Authorization (OAC owns it for
                    # SigV4; JWT rides x-authorization). This managed policy
                    # forwards everything else, incl. x-amz-content-sha256,
                    # which Lambda OAC requires on POST bodies.
                    origin_request_policy=cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                    viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
                ),
            },
            comment="eval-anything UI",
        )

        # FunctionUrlOrigin's OAC grant only covers lambda:InvokeFunctionUrl;
        # streaming invocations also need lambda:InvokeFunction (observed 403
        # from the URL edge without it).
        proxy_fn.add_permission(
            "CloudFrontInvokeFunction",
            principal=iam.ServicePrincipal("cloudfront.amazonaws.com"),
            action="lambda:InvokeFunction",
            source_arn=self.format_arn(
                service="cloudfront",
                region="",
                resource="distribution",
                resource_name=distribution.distribution_id,
            ),
        )

        site_url = f"https://{distribution.distribution_domain_name}"

        client = user_pool.add_client(
            "SpaClient",
            generate_secret=False,
            auth_flows=cognito.AuthFlow(user_srp=True, user_password=True),
            o_auth=cognito.OAuthSettings(
                flows=cognito.OAuthFlows(authorization_code_grant=True),
                scopes=[cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
                callback_urls=[site_url, f"{site_url}/index.html"],
                logout_urls=[site_url],
            ),
            access_token_validity=Duration.hours(8),
        )

        # ---- Managed Login 品牌（新版编辑器，Cognito 托管页仍走授权码模式）----
        # 目标：消掉旧托管 UI 的三痛点——满屏中灰遮罩、空灰 banner、零品牌。
        # 颜色与 ui/index.html 的 design tokens 逐一对应（格式为 rrggbbaa）：
        #   accent #2456e6 / accent-dim #1947c9 / bg #f6f8fb / line #e4e7ec
        #   text #172033 / muted #475467；圆角统一 8px 档（--r-card）。
        logo_svg = Path(__file__).resolve().parents[1] / "assets" / "logo.svg"
        branding = cognito.CfnManagedLoginBranding(
            self,
            "ManagedLoginBranding",
            user_pool_id=user_pool.user_pool_id,
            client_id=client.user_pool_client_id,
            # False = 应用下方自定义值；True 会要求省略 settings/assets。
            use_cognito_provided_values=False,
            assets=[
                cognito.CfnManagedLoginBranding.AssetTypeProperty(
                    category="FORM_LOGO",
                    color_mode="LIGHT",
                    extension="SVG",
                    bytes=base64.b64encode(logo_svg.read_bytes()).decode("ascii"),
                )
            ],
            settings={
                "categories": {
                    "form": {
                        "displayGraphics": True,
                        "location": {"horizontal": "CENTER", "vertical": "CENTER"},
                    },
                    "global": {
                        "colorSchemeMode": "LIGHT",
                        # 痛点 2：顶部/底部空灰 banner 条直接关掉。
                        "pageHeader": {"enabled": False},
                        "pageFooter": {"enabled": False},
                        "spacingDensity": "REGULAR",
                    },
                },
                "componentClasses": {
                    "buttons": {"borderRadius": 8.0},
                    "input": {
                        "borderRadius": 8.0,
                        "lightMode": {
                            "defaults": {
                                "backgroundColor": "ffffffff",
                                "borderColor": "cfd6e0ff",
                            },
                            "placeholderColor": "667085ff",
                        },
                    },
                    "inputLabel": {"lightMode": {"textColor": "172033ff"}},
                    "inputDescription": {"lightMode": {"textColor": "475467ff"}},
                    "link": {
                        "lightMode": {
                            "defaults": {"textColor": "2456e6ff"},
                            "hover": {"textColor": "1947c9ff"},
                        }
                    },
                    "focusState": {"lightMode": {"borderColor": "2456e6ff"}},
                    "divider": {"lightMode": {"borderColor": "e4e7ecff"}},
                },
                "components": {
                    # 痛点 1：满屏中灰遮罩 → 与应用同款浅色画布。
                    "pageBackground": {"lightMode": {"color": "f6f8fbff"}},
                    "form": {
                        "borderRadius": 8.0,
                        "lightMode": {
                            "backgroundColor": "ffffffff",
                            "borderColor": "e4e7ecff",
                        },
                        # 痛点 3：零品牌 → AND 门 logo 置于表单顶部居中。
                        "logo": {
                            "enabled": True,
                            "formInclusion": "IN",
                            "location": "CENTER",
                            "position": "TOP",
                        },
                        "backgroundImage": {"enabled": False},
                    },
                    "pageText": {
                        "lightMode": {
                            "headingColor": "172033ff",
                            "bodyColor": "475467ff",
                            "descriptionColor": "475467ff",
                        }
                    },
                    "primaryButton": {
                        "lightMode": {
                            "defaults": {
                                "backgroundColor": "2456e6ff",
                                "textColor": "ffffffff",
                            },
                            "hover": {
                                "backgroundColor": "1947c9ff",
                                "textColor": "ffffffff",
                            },
                            "active": {
                                "backgroundColor": "1947c9ff",
                                "textColor": "ffffffff",
                            },
                        }
                    },
                    "secondaryButton": {
                        "lightMode": {
                            "defaults": {
                                "backgroundColor": "ffffffff",
                                "borderColor": "2456e6ff",
                                "textColor": "2456e6ff",
                            },
                            "hover": {
                                "backgroundColor": "eaf0ffff",
                                "borderColor": "1947c9ff",
                                "textColor": "1947c9ff",
                            },
                        }
                    },
                },
            },
        )
        # 部署顺序（事故复盘后反转，2026-08-21）：branding 必须先建成，domain 才升 v2。
        #
        # 背景：旧写法 branding.node.add_dependency(domain) 让 domain 先升 v2、
        # branding 后创建。branding 一旦 CREATE_FAILED（如 SVG 资产被白名单拒收），
        # CFN 回滚会删掉 branding 却不把 domain 退回 v1（回滚模板不声明
        # ManagedLoginVersion，CFN 不主动"unset"），生产停在「v2 + 无 branding」
        # —— Managed Login v2 没有样式可渲染，登录页整条链路 403，P0。
        #
        # 依赖方向可以反转的依据（2026-08-21 临时 pool 实测，非推断）：
        # 在一个完全没有 domain 的临时 user pool 上，CreateManagedLoginBranding
        # 用与此处相同的 settings + FORM_LOGO/LIGHT/SVG 资产创建成功
        # —— 即 branding 创建不要求 domain 已是 v2；只有"v2 渲染"要求 branding
        # 存在，方向是单向的。因此让 domain 依赖 branding：
        #   - branding 失败 → domain 的 v2 更新根本不开始 → 登录页始终是 v1，可用；
        #   - branding 成功 → domain 原地升 v2，样式立即有对象可渲染，无坏中间态。
        # （branding 引用 pool/client，domain 只引用 pool，无循环依赖。）
        domain.node.add_dependency(branding)

        proxy_fn.add_environment("EVAL_RUNTIME_ARN", eval_runtime_arn)
        proxy_fn.add_environment("EVAL_REGION", self.region)
        proxy_fn.add_environment("USER_POOL_ID", user_pool.user_pool_id)

        site_config = s3deploy.Source.json_data(
            "config.json",
            {
                "region": self.region,
                "userPoolId": user_pool.user_pool_id,
                "clientId": client.user_pool_client_id,
                "cognitoDomain": domain.base_url(),
                "apiPath": "/api/invoke",
            },
        )

        s3deploy.BucketDeployment(
            self,
            "SiteDeploy",
            destination_bucket=site_bucket,
            distribution=distribution,
            # Tiny site: make browsers revalidate so UI fixes land immediately.
            cache_control=[s3deploy.CacheControl.from_string("no-cache")],
            # MUST stay: this deployment is root-scoped, and prune defaults to
            # true, so without the exclude its sync --delete wipes react/**.
            # Measured on a scratch bucket 2026-08-21 (see module docstring).
            exclude=[f"{REACT_PREFIX}/*"],
            sources=[s3deploy.Source.asset("../ui"), site_config],
        )

        # ---- React build output (dark until reactLive=true) ----
        # Two deployments, not one, because cache_control in BucketDeployment
        # applies to EVERY object in that deployment — a single deployment
        # cannot give assets/ immutable and index.html no-cache. Splitting by
        # include/exclude is the only way to get per-file cache headers.
        if react_dist_present:
            react_asset = s3deploy.Source.asset(str(react_dist))

            # 1) Hashed assets: filename changes on every content change, so
            #    they are safe to cache for a year and never revalidate.
            s3deploy.BucketDeployment(
                self,
                "ReactAssetsDeploy",
                destination_bucket=site_bucket,
                # NOTE: prefix is "react", NOT "react/assets". The source tree
                # already contains the assets/ folder, so prefixing with
                # react/assets would land keys at react/assets/assets/… and
                # every asset would 404 (index.html references /assets/x.js,
                # which under origin_path=/react resolves to react/assets/x.js).
                # Verified on a scratch bucket 2026-08-21 — this exact mistake
                # was made and caught before shipping.
                destination_key_prefix=REACT_PREFIX,
                sources=[react_asset],
                include=["assets/*"],
                exclude=["*"],
                cache_control=[
                    s3deploy.CacheControl.from_string(
                        "public,max-age=31536000,immutable"
                    )
                ],
                # No distribution/invalidation: hashed names never collide, so
                # there is nothing stale to invalidate. Avoids burning
                # invalidation quota on every build.
                prune=False,
            )

            # 2) index.html (+ any root-level extras): the mutable entrypoint
            #    that must be revalidated or users keep booting the old bundle
            #    and requesting deleted asset hashes.
            s3deploy.BucketDeployment(
                self,
                "ReactIndexDeploy",
                destination_bucket=site_bucket,
                destination_key_prefix=REACT_PREFIX,
                # config.json rides along so the React app reads the same
                # runtime config contract as the legacy UI.
                sources=[react_asset, site_config],
                exclude=["assets/*"],
                cache_control=[s3deploy.CacheControl.from_string("no-cache")],
                distribution=distribution,
                # Invalidate only the entrypoint; hashed assets need none.
                distribution_paths=["/index.html", "/config.json"],
                prune=False,
            )

        CfnOutput(
            self,
            "FrontendLive",
            value=f"{REACT_PREFIX} (React)" if react_live else "root (legacy ui/)",
        )
        CfnOutput(
            self,
            "ReactBundleUploaded",
            value=str(react_dist_present).lower(),
        )

        CfnOutput(self, "SiteUrl", value=site_url)
        CfnOutput(self, "UserPoolIdOut", value=user_pool.user_pool_id)
        CfnOutput(self, "CognitoDomain", value=domain.base_url())
