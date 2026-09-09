# 部署 runbook（AgentGate）

两个栈，各管一半：

| 栈 | 内容 | 什么时候要发 |
| --- | --- | --- |
| `EvalAnythingUi` | ui-proxy Lambda + S3 站点桶 + CloudFront OAC + Cognito | `web/` 或 `infra/` 有改动 |
| `EvalAnythingRuntime` | `../app` 打成 DockerImageAsset → AgentCore Runtime | `app/` 有改动 |

## 坐标：**现算，不写死**

站点域名 / 分发 ID / 桶名 / Runtime ID 都是某个具体 AWS 账号的坐标，
**不进仓库**（本仓库同步到 GitHub）。下面所有命令都用变量，先取一次：

```bash
cp .env.example .env.local          # 首次；.env.local 在 .gitignore，真值不入库
set -a; . ./.env.local; set +a      # 之后每个新 shell 只要这一行

# 或者当场现算（全只读，无写操作）：
export EVAL_UI_STACK=EvalAnythingUi
export EVAL_RUNTIME_STACK=EvalAnythingRuntime

# Output 取值：key **没有** hash 后缀，裸名就对
out() { aws cloudformation describe-stacks --stack-name "$1" \
          --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

# 资源物理名取值：$1=栈 $2=资源类型 $3=逻辑 id 前缀
# ⚠️ 不能用 `describe-stack-resource --logical-resource-id SiteBucket`：CDK 给资源
#    逻辑 id 加了 hash 后缀（SiteBucket → SiteBucket<HASH>），裸名一律 ValidationError；
#    hash 又不许写死（重构栈就变）⇒ 只能按「类型 + 前缀」列举。
# ⚠️ 必须**断言恰好一条**：零命中和多命中都要报错。别静默取第一个 —— 那给的是
#    「格式正确的错值」。计数用 `wc -w` 而不是 `wc -l`：`--output text` 把多个结果
#    放在**同一行**用制表符分隔，按行数数永远得 1，是个会自证成功的假判据。
res() {
  local out n
  out="$(aws cloudformation list-stack-resources --stack-name "$1" \
    --query "StackResourceSummaries[?ResourceType=='$2' \
             && starts_with(LogicalResourceId,'$3')].PhysicalResourceId" \
    --output text)" || return 1
  n="$(printf '%s' "$out" | wc -w)"
  [ "$n" -eq 1 ] || { echo "res: $1 里 $3*($2) 命中 $n 条，要求恰好 1：$out" >&2; return 1; }
  printf '%s' "$out"
}

export VE_EDGE_BASE="$(out "$EVAL_UI_STACK" SiteUrl)"            # https://<域名>
export SITE_BUCKET="$(res "$EVAL_UI_STACK" AWS::S3::Bucket SiteBucket)"
export CF_DISTRIBUTION_ID="$(res "$EVAL_UI_STACK" AWS::CloudFront::Distribution Distribution)"
export CATALOG_TABLE="$(res "$EVAL_RUNTIME_STACK" AWS::DynamoDB::Table CatalogTable)"
export EVAL_RUNTIME_ARN="$(out "$EVAL_RUNTIME_STACK" RuntimeArn)"
export EVAL_RUNTIME_ID="${EVAL_RUNTIME_ARN##*/}"

# 核一遍：五个都得非空（现算失败时上面会往 stderr 报，但变量会是空串）
for v in VE_EDGE_BASE SITE_BUCKET CF_DISTRIBUTION_ID CATALOG_TABLE EVAL_RUNTIME_ARN; do
  [ -n "${!v}" ] || echo "⚠️ $v 现算为空，别继续发布" >&2
done
```

⚠️ 现算比转抄更**正确**，不只是更安全：物理资源名换栈就变，而写死的值会静默用旧的。
React 前端在站点桶的 `react/` 前缀下（这条是本仓库的约定，不是账号坐标）。

发布纪律见 `CLAUDE.md`：小批量、频繁发；纯前端增量只发 UI 栈。

## ⚠️ 坑一：手工 S3 sync 绕过 CloudFormation，下一次 `cdk deploy` 会把现网覆盖回去

**现象.** 纯前端增量发布的快路径是直接 `aws s3 sync` 到桶里 + 建失效，两分钟搞定，
不走 CDK。代价是 **S3 里的内容会领先于 `EvalAnythingUi` 栈记录的 BucketDeployment
asset**。2026-08-24 实测的错位（当天到现在仍是这个状态）：

```
EvalAnythingUi  LastUpdatedTime  2026-08-24T13:52 UTC  (UPDATE_COMPLETE)
s3://…/react/index.html          2026-08-24 16:39      ← 手工 sync
s3://…/react/config.json         2026-08-24 13:53      ← CDK 放的
s3://…/react/mockServiceWorker.js 2026-08-24 13:53     ← CDK 放的
```

**后果.** CFN 认为现网就该是它 13:52 那份 asset。所以**将来任何人、为任何理由跑
`cdk deploy EvalAnythingUi`（哪怕只是想改一个 Lambda 环境变量、只想调 CloudFront
行为），都会顺手用栈里的旧 bundle 把现网前端覆盖回去**——不是报错，是静默回滚三个
月的前端。表现为用户刷新后看到旧界面，而 git 上什么都没变，极难归因。

**正确做法.**

- 想用 CDK 发前端：**先 `cd web && npm run build`**，让 BucketDeployment 的 asset
  hash 跟上 HEAD，再 deploy。build 之后 asset 变了，CFN 才会把新 bundle 推上去。
- 只想改 CDK 里的别的东西（Lambda、CloudFront、Cognito）：**同样先 `npm run build`**。
  不 build 就 deploy = 覆盖现网。这条没有例外。
- 手工快路径（纯前端增量）：

  ```bash
  cd web && npm run build
  B=s3://${SITE_BUCKET}/react
  # ① immutable（文件名带 hash）：assets/ 与 fonts/ 各一次 sync
  aws s3 sync dist/assets/ "$B/assets/" --cache-control "public,max-age=31536000,immutable"
  aws s3 sync dist/fonts/  "$B/fonts/"  --cache-control "public,max-age=31536000,immutable"
  # ② no-cache（`dist/` 根产物）：逐个 cp，各自带对 content-type
  aws s3 cp dist/index.html "$B/index.html" \
    --cache-control "no-cache" --content-type "text/html"
  aws s3 cp dist/version.json "$B/version.json" \
    --cache-control "no-cache" --content-type "application/json"
  aws cloudfront create-invalidation --distribution-id "$CF_DISTRIBUTION_ID" \
    --paths "/index.html" "/" "/version.json"
  ```

  不带 `--delete`（缓存中的旧 index 还在引用旧 hash 资产）；不碰 `react/config.json`
  （运行时配置，不在 `dist/` 里）。发完的核对见下面**第 5 步**：跑
  `web/scripts/verify-edge.sh` 遍历 `dist/` 全部文件，不再手挑几件。
- **两种 cache-control 不能一把 `sync`**（正是这笔隐形债的成因）：`assets/*` 与
  `fonts/*.woff2` 是 immutable，`index.html` / `version.json` 是 no-cache
  （明细见下面「`dist/` 根产物的 cache-control 分两种」）。一条
  `aws s3 sync dist/ …` 只能带**一个** `--cache-control`：给根产物打上 immutable
  = 一年不回源 ⇒ 版本核验永远看到旧值；给 `assets/` 打上 no-cache = 每次都回源。
  所以只能分两类各自处理，别图省事合成一条。
- 历史上手工路径**只传了 `dist/assets/`**：`fonts/` 与 `mockServiceWorker.js`
  从来没走过标准发布流程（CDK 路径由 index deployment `exclude=["assets/*"]` 兜住，
  所以不会 404，只会静默用旧文件），只是恰好没变过才与本地一致 ——
  `version.json` 不显式 `cp` 就会掉进同一个洞。
- **`mockServiceWorker.js` 自 build-hygiene-r1 批起不再进 `dist`**（dev-only 资产，
  vite 构建期从 outDir 剔掉；`web/tests/version-stamp.test.ts` 钉住）⇒ 上传与失效
  路径里都不再有它。**但「不进 dist」≠「从 CDN 消失」**：边缘/桶里曾留着一份旧的
  （`react/mockServiceWorker.js`）。**这份残留已于 2026-08-26 07:21 UTC（v0.11.3 ·
  2026.08.26-6 发布之后）清理完毕**，下面留作**同类残留的配方**，不是待办：

  ```bash
  # ① 留证（只读）：确认在、记下 size/etag/content-type
  aws s3api head-object --bucket "$SITE_BUCKET" \
    --key react/mockServiceWorker.js
  # ② 删对象 ③ 失效那一条路径
  aws s3 rm s3://${SITE_BUCKET}/react/mockServiceWorker.js
  aws cloudfront create-invalidation --distribution-id "$CF_DISTRIBUTION_ID" \
    --paths "/mockServiceWorker.js"
  ```

  删掉不会影响任何用户（现网没人注册这个 worker）；真要回退，文件仍在
  `web/public/mockServiceWorker.js`（**批 6 没删它，只是构建期剔掉** ⇒ 不必翻 git 历史），
  重新 `cp` 上去即可 —— 实测那份边缘对象与工作树这份 **md5 逐字节相同**
  （`c8f0dfa140ec246071c4cc5a03df5c9d`，9666 B）。
  **删后判据要三读**（⚠️ 单看 403 不算删成功，它与「路径写错」同形）：
  `head-object` → **404**（S3 侧权威）＋ `list-objects-v2 --prefix react/` 里**无此键**
  ＋ 边缘 GET → **403**（OAC 缺 key 就是 403）。三读方向一致才算。
  ⚠️ **别把这里的日期写死**：残留的 `LastModified` 一度被记成「2026-08-24 13:53（CDK 放的）」，
  实测删除前是 **2026-08-26T06:23:05Z** —— 第 5 版按当时 runbook（根产物「三件」含它）
  合规重传过一次。**日期一律现算 `head-object`，转抄值会过期。**

## ⚠️ 坑二：`aws_cdk` 只装在 `/usr/bin/python3`

`cdk.json` 里 app 是 `python3 app.py`，而默认 `python3` 指向 `~/.venv`，那里**没有**
`aws_cdk` → 任何 cdk 子命令（连 `cdk diff`）都 `ModuleNotFoundError: No module named
'aws_cdk'`。所有 cdk 命令都要顶一个 PATH：

```bash
cd infra && PATH="/usr/bin:$PATH" npx cdk diff EvalAnythingRuntime -c dockerHostNetwork=true
cd infra && PATH="/usr/bin:$PATH" npx cdk deploy EvalAnythingRuntime -c dockerHostNetwork=true --require-approval never
```

不要为了绕开这条去 `pip install aws-cdk-lib` 到 venv —— 换个解释器就是换套依赖版本，
比顶 PATH 风险大得多。

⚠️ **本机部署 Runtime 栈必须带 `-c dockerHostNetwork=true`**（2026-09-03 portability 批起）：
开关默认关；本机 Docker bridge 网络的 TLS 被拦截，不带开关 pip 装不了依赖；即使碰巧能构建，
`networkMode` 参与 asset hash ⇒ 会产出**另一个** asset、多发一个零代码改动的 Runtime 版本。
`cdk diff` 也要带同一开关，否则 diff 会报出假的镜像变更。

后端发完核版本号：

```bash
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$EVAL_RUNTIME_ID"
```

`cdk diff EvalAnythingRuntime` 输出「There were no differences」就代表现网后端已经
等于工作树的 `app/`，不需要重发。

## ⚠️ 坑三：`cdk deploy EvalAnythingUi` 必须带 `-c reactLive=true`

切换开关 `reactLive` 只控制 CloudFront 源的 `origin_path`
（`infra/stacks/ui_stack.py:60,139`）：

- `-c reactLive=true` → `origin_path=/react` → 公网访问 React 前端
- **flag 缺省 → `origin_path=None` → 回到旧版 `ui/` 的根前缀**

**`reactLive` 不在 `cdk.json` 的 context 里**，所以它不会被记住——每次 deploy 都得在
命令行显式带上。漏带一次不会报错、不会 diff 出可疑改动，就是把 React 前端瞬间下线
（S3 内容一个都没动，所以回滚只是再带 flag deploy 一次，不会丢文件）。

```bash
cd web && npm run build            # 坑一：必须先 build
cd ../infra && PATH="/usr/bin:$PATH" npx cdk deploy EvalAnythingUi \
  -c reactLive=true --require-approval never
```

`reactLive=true` 时栈会硬校验 `web/dist/index.html` 存在，缺了直接 synth 失败
（`ui_stack.py:69`）——这条唯一能拦住的是「忘了 build」，拦不住「build 过但是旧的」。

核对当前切换状态（不用 deploy）：

```bash
aws cloudformation describe-stacks --stack-name EvalAnythingUi \
  --query "Stacks[0].Outputs[?OutputKey=='FrontendLive'].OutputValue" --output text
# → "react (React)"
```

## 版本号（每次发布都要打版本戳）

形态 **语义化为主 + 构建号为辅**：`v0.9.0 · 2026.08.26-1`。

| 东西 | 权威 | 谁写 |
| --- | --- | --- |
| 语义化版本 `0.9.0` | `web/package.json` 的 `version` | 发布通道**构建前** bump（功能批 minor / 修复·杂务批 patch） |
| 构建号 `2026.08.26-1` | `git tag release/*`（UTC 日期 + 当天第几版） | `web/scripts/release-version.sh` 算号（**只算号不打 tag**） |
| 编译期身份 | bundle 里（vite `define`，只在 `vite build` 注入） | `web/vite.config.ts` 的 `version-stamp` 插件 |
| 运行时系统身份 | 边缘的 `/version.json` | 同一个插件 emit 到 `dist/version.json`；纯 Runtime 批用 `--write-json` |

`0.9.0` 是当前起点；`1.0.0` 的含义已被占用（UI-029 全套落地 + 旧 `ui/` 下线）。
侧栏底部显示系统身份，`/version.json` 拉不到就降级显示编译期身份（tooltip 写
「系统版本 未知」，不伪造）。

**插点（按现有发布步骤编号）**

- **1.4 bump `web/package.json`**：按批次分类改一行 `version`，直落一笔 commit
  （tag 打在这笔 bump commit 上 → `--current` 读到的 tag 指向的树里 package.json
  就是那一版，可拿来自检）。
- **1.5 算构建号**：

  ```bash
  cd web && BUILD_ID="$(bash scripts/release-version.sh)"   # → 2026.08.26-1
  bash scripts/release-version.sh --current                 # none / stale <号> / today <号>
  RELEASE_ID="$BUILD_ID" npm run build                      # 钉住，别让 build 再算一次
  ```

  构建号按后缀**数值**取最大：字典序会在发到第 10 版那天算出 `-3` 并**静默撞号**。
  日期一律 UTC（跨午夜各步各算会出两个号）。
- **上传身份文件**（跟在坑一的手工 sync 之后，`dist/` 根产物那一段）：

  ```bash
  aws s3 cp dist/version.json \
    s3://${SITE_BUCKET}/react/version.json \
    --cache-control "no-cache" --content-type "application/json"
  aws cloudfront create-invalidation --distribution-id "$CF_DISTRIBUTION_ID" \
    --paths "/index.html" "/" "/version.json"
  ```

  失效路径**必须含 `/version.json`**（no-cache 只管浏览器，边缘那份要显式失效）。
- **5 边缘逐对象核 md5** → 改指 `web/scripts/verify-edge.sh`（只读，只发 GET）：

  ```bash
  # 边缘基址**没有内置默认值**（脱敏批起）：要么上面那句 `set -a; . ./.env.local`
  # 已经导出 $VE_EDGE_BASE，要么显式 --edge；两者都没有 ⇒ 退 **2**，不会去比一个
  # 猜出来的域名。dist 仍默认 web/dist（相对脚本位置解析）。
  bash web/scripts/verify-edge.sh                       # 用 $VE_EDGE_BASE
  bash web/scripts/verify-edge.sh --edge "$VE_EDGE_BASE" --json   # 显式给；--edge 压环境变量
  #   --dist <dir> 可覆盖产物目录
  ```

  遍历**本地 `dist/` 全部文件**逐个比 md5 + 大小，**不认固定清单**。老写法只核
  `index.html` / `version.json` / `assets/`，**覆盖面恰好等于上传命令的覆盖面 ⇒
  漏传永远自证不出来**（`fonts/*` 与 `mockServiceWorker.js` 就这么躺过一个月）。
  判据是「**HTTP 200 且字节一致**」：边缘缺 key 返 **403 不是 404**，脚本会提示用
  只读的 `aws s3api head-object` 分辨「没上传」还是「策略/前缀错」。
  退出码分档：**0** 全等 / **3** 有不一致（逐个列出）/ **4** 一个都没比到（`dist/`
  不存在或为空、边缘一个响应都没给 —— **空集不算通过**）/ **2** 用法错（含
  **边缘基址既没给也没配**）；判决另印
  `VERDICT:` 与 `EXIT:` 两行 —— **别用 `… | tail` 读 `$?`**（读到的是管道末端的码）。
  no-cache 两件两种绕缓存写法都发（`?t=<纪元秒>` 与 `Cache-Control: no-cache` 头），
  要求两次都与本地一致（自相矛盾 = 边缘有陈旧副本）。实测这两种写法在本分发
  **都不真绕过** CloudFront（Managed-CachingOptimized：查询串与请求头都不进缓存键），
  真正让那三件新鲜的是**源端对象自带的** `cache-control: no-cache`（边缘每次回源
  revalidate，`x-cache: RefreshHit from cloudfront`）⇒ 上传时打错 cache-control
  在客户端补救不了，只能重传 + 失效。
- **5.5 发布后核现网版本**（第 5 步核字节，这一步核**语义**：版本值是不是本次的）：

  ```bash
  curl -s -o /tmp/v.json -w "%{http_code}\n" "$VE_EDGE_BASE/version.json"
  cat /tmp/v.json    # version / build / commit 必须 == 本次发布的值
  ```

  要求：HTTP **200**、JSON 可解析、`build` 与 `commit` 等于本次值。
  **边缘缺 key 返 403 不是 404**（OAC + 私有源的 S3 不给列桶权限），所以判不清时
  用 `aws s3api head-object --bucket … --key react/version.json` 确认对象在不在。
- **7.5 打两条本地 tag**（打在 1.4 的 bump commit 上，不是合流 commit）：

  ```bash
  git tag "release/$BUILD_ID"          # 构建号
  git tag "v$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' web/package.json | head -1)"
  bash web/scripts/release-version.sh --latest-semver   # 核最新 semver tag
  ```

  取「最新 semver」只能用 `git tag -l 'v*' --sort=v:refname`：字典序里
  `v0.10.0` 排在 `v0.9.0` **前面**，`sort | tail -1` 会指错版本。

**纯 Runtime 批（`app/` 改动、`web/` 零改动）**：不重建 bundle
（「零 web 改动 ⇒ dist 逐字节不变」是在用判据），只更新身份文件：

```bash
cd web && aws s3 cp s3://…/react/version.json dist/version.json   # 取回旧的，保住 ui_build
RUNTIME_VERSION=v55 bash scripts/release-version.sh --write-json dist
aws s3 cp dist/version.json s3://…/react/version.json \
  --cache-control "no-cache" --content-type "application/json"
aws cloudfront create-invalidation --distribution-id "$CF_DISTRIBUTION_ID" --paths "/version.json"
```

`--write-json` 沿用旧文件的 `ui_build`（前端字节没重建 → 编译期身份合法落后于
系统身份），`runtime_version` 由这里的环境变量填（构建期不可知，默认 `null`）。

**`dist/` 根产物的 cache-control 分两种，不能一把 `sync`**：

| 产物 | cache-control | 说明 |
| --- | --- | --- |
| `assets/*` | `public,max-age=31536000,immutable` | 文件名带 hash |
| `fonts/*.woff2` | `public,max-age=31536000,immutable` | 同上，内容不变 |
| `index.html` | `no-cache` | 引用 hash 资产的入口 |
| `version.json` | `no-cache` | 版本核验的权威，必须每次拿到最新 |

`mockServiceWorker.js` 从这张表里**去掉了**：它不再产出到 `dist`（dev-only 资产，
构建期剔掉）。边缘残留那份的清理见坑一末尾那一步（`head-object` 留证 → `s3 rm` →
失效），content-type 现网是 `application/javascript`（`head-object` 实测 2026-08-26），
真要补传回去照抄别改。

实测背景：`fonts/*` 与 `mockServiceWorker.js` 从来没走过标准发布流程（S3
LastModified 是某次一次性上传），只是恰好没变过才与本地一致 —— `version.json`
若不显式 `cp` 就会同样落空（不报错，边缘一直是旧的或直接 403）。
上传写法见坑一的手工快路径（两类分开处理）；核对写法见第 5 步
（`web/scripts/verify-edge.sh` 遍历 `dist/` 全部文件 vs 边缘）。

## 上线红线

部署所用的 AWS 账号受自动安全监控（Palisade/Epoxy），**禁止任何 world-accessible
后端入口**：不许 Lambda Function URL `AuthType=NONE`，不许对 0.0.0.0/0 开放的
API Gateway / ALB。公网访问后端只走 CloudFront + OAC + 私有源。
删源之前必须先删/禁用分发（悬空源红线），且不要触碰本项目之外的既有分发。
（账号级细则不在本仓库，见部署机上级目录的 `CLAUDE.md`。）
