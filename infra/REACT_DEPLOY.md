# T1b：React 构建产物部署管线（设计 + 实施说明）

> ⚠️ **本文是切换前的设计稿，下面「状态」一行已过期**：React 前端 2026-08-24
> 已上线（`EvalAnythingUi` 输出 `FrontendLive = react (React)`）。日常发布步骤和
> 三个实测踩过的坑看 [`../docs/runbook-deploy.md`](../docs/runbook-deploy.md)；
> 本文保留设计推导与桶布局说明。

状态：**infra 代码已改，未部署、未切换**。分支 `react-rewrite`，仅动
`infra/stacks/ui_stack.py`（+ 本文档）。

目标：前端从 `ui/` 两文件静态直传，改为 `web/` 目录 Vite 构建产物（`web/dist`：
带 hash 的 `assets/` + `index.html`），**旧版留守可回滚**。

---

## 1. 总体形态：一个桶、两套前端、互不干扰

```
s3://$SITE_BUCKET/          ← 站点桶（物理名现算，见 docs/runbook-deploy.md「坐标」）
├── index.html          ← 旧版 ui/（留守）
├── app.js              ← 旧版 ui/
├── config.json         ← 两套共用同一份运行时配置契约
└── react/              ← 新版 Vite 产物
    ├── index.html
    ├── config.json
    └── assets/
        ├── index-a1b2c3d4.js
        └── index-e5f6a7b8.css
```

**公网看到哪一套，只由 CloudFront S3 origin 的 `OriginPath` 决定**，
由 CDK context 开关 `reactLive` 控制。S3 内容永不搬动，所以回滚不可能丢文件。

`OriginPath=/react` 的语义：CloudFront 把它拼在每个请求路径前再回源。
`GET /` → `react/index.html`；`GET /assets/index-a1b2c3d4.js` →
`react/assets/index-a1b2c3d4.js`。**无需改 key、无需 Function 重写。**

---

## 2. 缓存分层

| 对象 | Cache-Control | 理由 |
|---|---|---|
| `react/assets/*` | `public,max-age=31536000,immutable` | 文件名带内容 hash，内容变则名变，永不需要重验 |
| `react/index.html` | `no-cache` | 可变入口。若被缓存，用户会一直启动旧 bundle 并去请求已删除的 hash 资产 |
| `react/config.json` | `no-cache` | 同上，运行时配置 |
| 旧版根路径全部 | `no-cache` | 沿用原有行为，不改 |

**为什么是三个 BucketDeployment 而不是一个**：CDK 的 `cache_control` 作用于
该 deployment 内**所有**对象（已查 API 文档：*"to be set on all objects in the
deployment"*）。一个 deployment 无法同时给 `assets/` immutable 和 `index.html`
no-cache。按 `include`/`exclude` 拆分是唯一拿到 per-file 缓存头的方式。

---

## 3. ⚠️ 两个已实测的坑（都在改代码前踩到并修掉）

### 坑 1：旧版 deployment 会把 `react/**` 删光

`BucketDeployment` 的 `prune` **默认 true**，且不设 `destination_key_prefix`
时作用域是**桶根**——等价于 `aws s3 sync --delete` 打在根上。

临时桶实测（非推理）：

```
before: app.js  index.html  react/assets/index-abc123.js  react/index.html
$ aws s3 sync ./ui s3://B/ --delete
  delete: s3://B/react/assets/index-abc123.js
  delete: s3://B/react/index.html
after:  app.js  index.html                    ← react/ 被清空
```

**修法**：旧版 deployment 加 `exclude=["react/*"]`。加上后实测两套共存：

```
after: app.js  index.html  react/assets/index-def456.js  react/index.html
```

React 侧的两个 deployment 都设了 `destination_key_prefix`（把各自的 prune 限制
在该前缀内）+ `prune=False`，双侧防御。

> **改动纪律**：`exclude=["react/*"]` 和两个 `destination_key_prefix`
> **任何一个被删掉，两套 deployment 就会互删**。已写进代码注释。

### 坑 2：`destination_key_prefix="react/assets"` 会造成 key 双层

我第一版把资产 deployment 写成 `prefix="react/assets"` + `include=["assets/*"]`。
源树里本来就有 `assets/` 目录，于是 key 落成：

```
react/assets/assets/index-a1b2c3d4.js     ← 双层，index.html 引用的 /assets/… 全 404
```

**修法**：资产 deployment 的 prefix 也用 `react`（不是 `react/assets`），
靠 `include=["assets/*"] exclude=["*"]` 筛文件。实测修正后：

```
react/assets/index-a1b2c3d4.js
react/assets/index-e5f6a7b8.css
react/index.html
```

与 `index.html` 里 `/assets/index-a1b2c3d4.js` 的引用在 `OriginPath=/react`
下正好对齐。

---

## 4. 切换与回滚（各一次 CDK 参数变更）

前提：已执行构建（第 5 节），`web/dist/index.html` 存在。

### 上线切换

```bash
cd infra
cdk deploy EvalAnythingUi -c reactLive=true
```

`cdk diff -c reactLive=true` 实测**只有一行实质变更**：

```
[~] AWS::CloudFront::Distribution Distribution
 └─ .Origins:
     [+] "OriginPath": "/react"
```

不是 replacement——CloudFront 配置原地更新，**分发域名、OAC 授权、
`/api/*` behavior 全部不变**（Lambda Function URL 与其 OAC 一行都没碰）。
边缘传播约 3–5 分钟。

### 回滚

```bash
cd infra
cdk deploy EvalAnythingUi          # 不带 -c，flag 缺省即 False
```

`OriginPath` 被移除，公网瞬时回到旧版根路径。**旧版文件一直在桶里、
一直是最新的**（每次部署都会同步 `ui/`），所以回滚**不需要重新构建、
不需要重新上传、不依赖任何备份**。这是选"同桶双前缀 + origin path"
而不是"两个桶"或"覆盖同一前缀"的核心原因。

> 回滚后 React 产物仍留在 `react/`（`prune=False`），可反复切换验证。

---

## 5. 构建步骤进发布流程

发布 React 前端时，`cdk deploy` **之前**必须先构建：

```bash
cd web
npm ci                 # lockfile 严格安装
npm run build          # 产出 web/dist（Vite）
cd ../infra
cdk deploy EvalAnythingUi -c reactLive=true
```

**在主机上直接构建，不要放进容器。** 本机 Docker bridge 网络存在 TLS 拦截
（已知问题：容器内 npm/pip 证书失败）。主机网络无此问题——现有
`EvalAnythingRuntime` 的镜像构建正是为此显式设了
`NetworkMode.HOST`。若将来确实要容器化前端构建，同样必须走 host 网络。

**护栏**：`reactLive=true` 但 `web/dist/index.html` 不存在时，synth 直接
`raise ValueError` 并提示先跑构建——避免把 origin path 切到一个空前缀
造成全站 404。已实测该分支生效。

**并行安全**：`web/` 还不存在时（react-core 正在搭），本 stack 照常 synth，
只是跳过两个 React deployment（实测：`BucketDeployments=1`，
输出 `ReactBundleUploaded=false`）。所以这套 infra 改动**现在就能合并**，
不必等 `web/` 就位。

---

## 6. 发布验证方案（旧的"边缘字节==仓库字节"失效）

**为什么失效**：构建产物 ≠ 源文件，`ui/app.js` 那种
`md5(edge) == md5(repo)` 的判据对 `web/src/*.tsx` 不成立。

替代为三层，逐层收紧：

### 第 1 层：产物 manifest 一致（构建产物 == 上线产物）

构建后、部署前记录本地产物指纹；部署后逐个拉边缘比对：

```bash
# 部署前：本地产物清单
cd web/dist && find . -type f | sort | while read f; do
  echo "$(md5sum "$f" | cut -d' ' -f1)  ${f#./}"
done > /tmp/dist_manifest.txt

# 部署后：逐文件拉边缘并比对（index.html 与 assets 都覆盖）
while read hash path; do
  edge=$(curl -fsS "$VE_EDGE_BASE/$path?cb=$(date +%s%N)" | md5sum | cut -d' ' -f1)
  [ "$edge" = "$hash" ] && echo "OK   $path" || echo "FAIL $path (edge=$edge want=$hash)"
done < /tmp/dist_manifest.txt
```

这保留了"字节级"强度，只是把基准从**源文件**换成**构建产物**。

### 第 2 层：入口引用的资产全部可达（防 hash 漂移/漏传）

```bash
curl -fsS "$VE_EDGE_BASE/index.html?cb=$(date +%s%N)" -o /tmp/idx.html
grep -oE '(src|href)="/[^"]+\.(js|css)"' /tmp/idx.html | grep -oE '/[^"]+' | sort -u |
while read a; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$VE_EDGE_BASE$a")
  echo "$code  $a"
done      # 每条必须 200
```

这一条专门抓"index.html 换了但 assets 没上传成功"——SPA 最典型的
半上线故障（白屏且控制台一片 404）。

### 第 3 层：特征断言 + 无 error（运行时真的活着）

Playwright 实测生产页：

- `PAGE_ERRORS: []`、`REQ_FAILED: []`
- `#root` 存在**且已被渲染填充**（`document.querySelector('#root').children.length > 0`）
  —— 只断言 `#root` 存在是不够的，React 挂载失败时 `#root` 依然在，页面全白。
- 关键路由/文案特征存在（按当批实际内容定，不断言业务数量）
- 缓存头抽查：`assets/*` 响应含 `max-age=31536000,immutable`；
  `index.html` 含 `no-cache`

### 附：仍然适用的旧检查

- 失效 `Completed`（本设计只失效 `/index.html` + `/config.json`；
  hashed 资产不需失效，省配额）
- Runtime 版本与冷启动日志（若同批动了 `app/`）
- 安全红线复查（见第 7 节）

---

## 7. 安全红线核对（本设计逐条保持）

| 项 | 结论 |
|---|---|
| Lambda Function URL | **一行未碰**。仍 `AWS_IAM` + OAC，`/api/*` behavior 不变 |
| 账号内既有的其他 CloudFront 分发（含那个已知的悬空分发） | 未触碰（本设计不涉任何其他分发）。具体分发 ID 属账号坐标，不写在仓库里 |
| S3 PAB | 桶不变，四项仍全 true（新前缀是同一个桶，自动继承） |
| 新前缀是否只经 OAC | **是**。`react/` 与根路径同桶同 origin，走同一个
  `S3BucketOrigin.with_origin_access_control`，无第二个 origin、无公开读策略 |
| 新增公开入口 | 无。切换只改 `OriginPath`，不新增 origin/behavior |
| 悬空源 | 无。不新建桶、不删源；分发与源仍同栈 |

---

## 8. 实施状态与残留

**已完成**：`infra/stacks/ui_stack.py` 改造 + 本文档 + `cdk synth`/`cdk diff`
三种组合验证（无 dist / 有 dist 暗置 / 有 dist 切换）。**未 deploy、未切换。**

`cdk diff`（暗置）对 `EvalAnythingUi` 的实际影响：

```
[+] ReactAssetsDeploy/AwsCliLayer + CustomResource
[+] ReactIndexDeploy/AwsCliLayer + CustomResource
[~] SiteDeploy  ← 仅加 Exclude=["react/*"]（may be replaced：自定义资源重建，
                   内容仍会完整重传，无中断风险）
[+] Outputs FrontendLive / ReactBundleUploaded
```

**与本任务无关的既有漂移**（他人已合并代码未部署所致，我未改这些文件，
也未部署）：

- `EvalAnythingRuntime` 镜像 hash 变更（`app/` 有已合并未发布的改动）
- `UiProxy` Lambda `S3Key` 变更（`ui-proxy/` 同理）

→ **提醒**：将来任何人执行 `cdk deploy EvalAnythingUi` 都会顺带把
`UiProxy` 的新代码带上线；`EvalAnythingRuntime` 亦会随依赖栈一起被
`cdk diff` 拉进来。发布前应确认这些附带变更是否被期望。

**残留待办（需 `web/` 就位后才能做）**：

1. 用**真实** Vite 产物跑一遍第 6 节三层验证（我用的是手工构造的 fake
   `dist/`：一个 `index.html` + 两个 hashed 资产，只验证了 key 布局与缓存头，
   **没有验证真实 Vite 输出的目录结构**。若 Vite 配置产出 `assets/` 之外的
   目录（如 `chunks/`、`media/`、`vite.svg` 等根级文件），
   `include=["assets/*"]` 的筛选需要相应扩展——**这是最可能需要微调的一点**）。
2. SPA 深链路由：本设计**未加** CloudFront custom error response
   （403/404 → `/index.html` 200）。当前旧版是 hash 路由（`#resources`）不需要;
   若 React 改用 history 路由（`/plans/123`），刷新会 404，**必须**补
   `error_responses`。已确认现网分发 `CustomErrorResponses.Quantity=0`。
   **需 react-core 明确路由模式后再定，我没有替它决定。**
3. 真实构建后确认 `npm ci` 在本机可用（未跑——`web/` 尚不存在）。
