> **快照说明（2026-09-09）**：本仓库是 AgentGate 在 **v0.41.1 · 2026.09.09-1**（主仓 `dawei008/agentgate` 分支 `react-rewrite` 提交 `b26d56d`，Runtime v92）的**纯 Strands 版本**快照——评估器判分、红队、模拟、诊断全部基于 `strands-agents` / `strands-agents-evals`，不含 DeepEval。主仓自 v0.42.0 起判分层已改为 DeepEval，本仓库独立演进、不回合。
> 只带这一份树，不带历史（主仓历史里有不宜公开的坐标）；`tests/fixtures/` 里两个被测 Agent 的 Runtime ID 已打码为 `EXAMPLE0001/0002`，测试断言同步。其余文件与该标签逐字节相同。

# AgentGate（仓库 agentgate）

产品名 **AgentGate · Agent 质量门禁**（仓库 `agentgate`；云端栈/资源名沿用历史命名 `EvalAnything*` / `eval-anything-*`，不影响产品，重命名等于重建栈）：托管在
Amazon Bedrock AgentCore Runtime 上的 **Agent 评估平台**，配套 Cognito 登录的 Web
UI（`web/`）。评估器来自 [Strands Evals](https://strandsagents.com/docs/user-guide/evals-sdk/quickstart/)（LLM-as-a-Judge），流式返回进度。

## 它能回答什么

- **线上评估**——真实用户用得怎么样：从线上真实会话抽样、judge 打分，
  **不调用被测 Agent**。产出 `overall_mean`，均分与趋势只认这一项。
- **回归测试**——改了 prompt/换了模型后回归了吗：固定用例集**真实调用**被测
  Agent、对照期望输出判分；AI 生成/扩充用例与多轮模拟，运行前强制成本预估、
  超预估 3 倍自动熔断。产出 `pass_rate`。
- **红队测试**——能不能被说服着破坏自己的规则：攻击者 LLM 多轮对抗真实部署的
  Agent，judge 判越狱是否得手；攻击用例按被测 Agent 的真实 trace 生成，人工
  审阅后才能跑。产出 `breached/attacks`（反向指标，越少越好）。

三类分数刻意不合并，口径定义看 `CONTEXT.md`。配套：结果缓存（只存 Agent 输出、不含
评分——改评估器不重跑，改了 Agent 先清作用域）、低分自动诊断与按 fix_type 汇总的改进
建议、多模态判分（图给 judge、不给被测 Agent）、单 Runtime 内多智能体直接可评。

## 核心概念：评估计划

- 一个计划绑定**一个 Agent** + 有序环节列表（环节类型即上面三种模式）；计划
  全部由用户显式创建、都可删除；run 永远属于计划（摘要 + S3 全文报告）。
- 计划可挂定时（EventBridge Scheduler），**必须设单次预算上限**，超预算记一条可见的 skipped run。
- 环节评分刻意不合并，不产合成总分；运行报告只讲本次——形态见 `CONTEXT.md`「运行报告」条目与 ADR-0014。

## 架构

```
浏览器 ──▶ CloudFront ──▶ S3 静态页 (OAC, 全私有)
   │ Cognito Hosted UI 登录 → JWT
   ▼
CloudFront /api/* ──OAC(SigV4)──▶ Lambda ui-proxy (Function URL, AWS_IAM)
   │  校验 JWT                     POST 需 x-amz-content-sha256
   ▼
invoke_agent_runtime ──▶ 评估 Runtime (AgentCore, 本项目 app/)
                           ├─ discover: ListAgentRuntimes + 日志组匹配
                           ├─ evaluate: Logs Insights 枚举 session
                           │            → CloudWatchProvider 拉 trace
                           │            → Strands Evals 评估器打分 (流式)
                           └─ ADOT → GenAI Observability 仪表盘
```

安全：无任何 world-accessible 后端入口——Function URL 为 `AWS_IAM` 且仅授权本 CloudFront 分发经 OAC 调用；S3 public-access block 全开；仅 CloudFront 对外。

## 目录

| 路径 | 内容 |
|---|---|
| `web/` | React+Vite 前端，**现网就是它**（测试与视觉基线在 `web/tests/`） |
| `ui/` | 留守的旧版单页，现网不指向它（切换机制见 `infra/stacks/ui_stack.py`）。**不是可用的回退**：它还在调 `register_trace_source` / `delete_trace_source` 两个后端已删除的 action（现为 `get_span_source` / `set_span_source`） |
| `app/` | 评估服务（AgentCore Runtime 容器，Python） |
| `ui-proxy/` | Lambda：JWT 校验 + SSE 透传（Node 22） |
| `infra/` | CDK Python：`EvalAnythingRuntime` + `EvalAnythingUi` 两个栈 |
| `scripts/` | 本地调用/调试脚本 |
| `tests/` | 后端 pytest |
| `docs/` | 契约 / 踩坑 / runbook / ADR（见「深入阅读」） |

## 部署

前置：

- Docker；**x86 主机还要先注册 arm64 binfmt** —— AgentCore Runtime 只收
  `linux/arm64` 镜像（`app/Dockerfile:2`），x86 上不注册就构建失败：
  `docker run --privileged --rm tonistiigi/binfmt --install arm64`
- Node 18 / 20 / 22+（Vite 6 的 engines 排除 19 与 21）
- Python 3.10+
- CDK CLI（`npm i -g aws-cdk`）+ AWS CLI v2 与可用凭证 + 目标 region 已 bootstrap。
  ⚠️ **region 跟着本地 profile 走**：`infra/app.py` 读 `CDK_DEFAULT_REGION`，`us-west-2`
  只是兜底值。默认 region 不是 us-west-2 时，栈会建在别处，而下面
  `admin-create-user --region us-west-2` 会以 `User pool does not exist` 失败——
  那个报错不指向真因。要么把 profile 的 region 设成 us-west-2，要么把下面命令里的
  region 一起改。
- 账号已开通 Bedrock 的 Anthropic 模型访问（judge 默认
  `global.anthropic.claude-sonnet-5`，见 `app/registry.py`）

```bash
python3 -m pip install -r infra/requirements.txt   # CDK 的 Python 依赖
(cd ui-proxy && npm install)                 # Lambda 依赖要打进 asset，必须先装
(cd web && npm ci && npm run build)          # 产出 web/dist —— 必须在部署 UI 栈之前

cd infra
cdk deploy EvalAnythingRuntime               # 栈 A：arm64 镜像 + IAM + 评估 Runtime
cdk deploy EvalAnythingUi -c reactLive=true  # 栈 B：Cognito + ui-proxy + CloudFront + S3
```

⚠️ CDK 依赖要装进 `cdk.json` 里 `python3 app.py` 会用到的那个解释器；已有开发机上这套
依赖装在**别的**解释器里时，**别往 venv 里再装一套**（版本漂移），改给 cdk 命令顶
`PATH`——见 `docs/runbook-deploy.md` 坑二。

⚠️ `-c reactLive=true` **不能省**：它决定 CloudFront 的 `OriginPath` 指不指向
`react/` 前缀。**不带开关部署不会报任何错，React 产物也照样上传到 `react/`，只是
CloudFront 不指向它**——站点是留守的旧版 `ui/`，这个坑没有自曝形态（机制见
`infra/stacks/ui_stack.py`，设计见 `infra/REACT_DEPLOY.md`，权威表述见
`docs/runbook-deploy.md` 坑三）。护栏：`reactLive=true` 而 `web/dist/index.html`
缺失时，synth 直接报错而不是把 origin 切到空前缀造成全站 404。

创建登录用户（自注册已关闭，`self_sign_up_enabled=False`）：

```bash
aws cognito-idp admin-create-user --user-pool-id <UserPoolIdOut> \
  --username you@example.com --user-attributes Name=email,Value=you@example.com \
  --temporary-password "$TMP_PW" --region us-west-2
```

口令策略最短 12 位。**口令别写进任何文件**（仓库、`.env.local`、shell 历史都不行）
—— 用 `read -rs TMP_PW` 当场输入。

打开栈 B 输出的 `SiteUrl`，登录后按页面流程操作。

## 在自己的账号部署：换账号要核对的六项

1. **区域跟本地 profile 走**：`infra/app.py` 读 `CDK_DEFAULT_REGION`，运行时各模块从
   `AWS_REGION` 取区域（`app/discovery.py`）；所有 CLI 命令的 `--region` 要与之一致。
2. **judge 默认模型只在商业分区可用**：`global.anthropic.claude-sonnet-5` 是 global 推理
   配置（`app/judgellm.py` 的 `_DEFAULT`），中国区要在设置页「评估模型」里换成该区可用的
   模型 ID；Bedrock 的模型访问要先开通。
3. **被测 Agent 与本系统同账号同区域**，且已开启 AgentCore Observability：discovery 只列
   同账号的 Runtime（`app/discovery.py` 的 `list_agent_runtimes`），没有跨账号评估。
4. **同一账号同一区域只能部署一套**：栈名 `EvalAnythingUi` / `EvalAnythingRuntime`
   （`infra/app.py`）与 Cognito 域前缀 `eval-anything-<账号>`（`infra/stacks/ui_stack.py`）固定。
5. **Docker 构建网络默认 bridge**：只有构建机拦截了 bridge 网络的 TLS（镜像构建时 pip
   装不了依赖）才加 `cdk deploy EvalAnythingRuntime -c dockerHostNetwork=true`
   （`infra/stacks/eval_runtime_stack.py`），默认不需要。
6. **第三方 judge 的 API key 放 Secrets Manager**，名字必须以 `eval-anything/` 开头：
   Runtime 角色的 IAM 只放行这个前缀（`infra/stacks/eval_runtime_stack.py`；读取在
   `app/judgellm.py`）。

登录用户只能由管理员 `admin-create-user` 建（自注册已关），见上节。

## Teardown（顺序不可颠倒，防悬空源）

```bash
cd infra
cdk destroy EvalAnythingUi      # 先删分发+源（同栈原子删除，无悬空窗口）
cdk destroy EvalAnythingRuntime # 再删评估 Runtime
```

CloudFront 分发与其 S3/Lambda 源在同一栈内，`cdk destroy` 会一并删除。
**切勿手动先删 S3 桶或 Lambda**。

## 本地开发

```bash
cd web && npm run dev              # 前端开发服务器（走 mock，不需要 AWS）
cd web && npm test                 # 前端测试（vitest）
python3 -m pytest                  # 后端测试
python3 -m pip install -r app/requirements.txt   # 下面两个脚本直接 import app/，先装
python3 scripts/local_test.py                    # 不部署，本地直跑核心评估链路（带 Agent 名则评估它）
python3 scripts/invoke_runtime.py discover       # 调已部署的评估 Runtime（action 必填）
```

## 部署坐标从哪来

站点域名、账号 ID、Runtime ARN、桶名、User Pool 都是某个具体 AWS 账号的坐标，
**一律不进仓库**；本地真值放 `.env.local`（`cp .env.example .env.local`，已在
`.gitignore`）。刚部署完用 `aws cloudformation describe-stacks --stack-name <栈名>
--query 'Stacks[0].Outputs'` 一次拿全，栈输出实名：`EvalAnythingUi` → `SiteUrl` /
`UserPoolIdOut` / `CognitoDomain` / `FrontendLive` / `ReactBundleUploaded`；
`EvalAnythingRuntime` → `RuntimeArn` / `RuntimeRoleArn`。

## 架构上做不到的

被测对象是**已部署的 AgentCore Runtime 黑盒**（只能发消息、收文本），凡需介入其进程内部的能力做不到：

| 能力 | 状态 |
|---|---|
| Chaos Testing（工具层故障注入） | 不支持 |
| Tool Simulation（模拟器替换真实工具） | 不支持 |
| 工具调用真实性核验（红队 `excessive_agency`） | 降级：只能凭 Agent 自述判定 |
| 会话状态回退（红队 Crescendo） | 近似：轮换新 session，攻击强度被低估 |

## 已知边界

- 只评估**有运行日志**的 Agent；会话枚举仅覆盖启用了 AgentCore Observability 的 Runtime。
- trace 无消息内容、或被测 Agent 空响应（HTTP 200 + 0 字节）的会话/用例不按 0 分计、不进均分/通过率、不入缓存——判定细节见 `docs/pitfalls.md`。
- 成本一律为预估值；Pricing API 不覆盖的第三方模型需在 UI 手工补单价。

## 深入阅读

- `CONTEXT.md`——术语与度量口径的唯一权威
- `docs/adr/`——不可逆决策记录
- `docs/runbook-deploy.md`——日常发布 runbook（发布动作的权威）
- `docs/payload-contract.md`——评估 Runtime 的 SSE 契约与 action 索引
- `docs/pitfalls.md`——实测踩坑实录
- `docs/design-user-first-rules.md`——用户视角自查清单（界面文案纪律）
- `infra/REACT_DEPLOY.md`——S3 桶布局与新旧前端切换/回滚设计
