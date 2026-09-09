# AgentGate Web（React 重构）

旧版 `ui/`（单文件无构建）的 React 重写。技术栈：Vite + React 18 + TypeScript +
TanStack Query + Zustand + CSS（沿用产品设计令牌）+ MSW。

```bash
npm install       # 若 TLS 证书报错：加 --registry https://registry.npmjs.org/
npm run dev       # dev 模式自动启用 MSW（假 config.json / Cognito / API）
npm run build     # tsc -b && vite build（recharts 拆独立 chunk，见 vite.config.ts manualChunks）
npm run test      # vitest（135 条）
npm run visual    # 视觉回归：起 dev server → 重截全站截图 → 与基线逐像素比对
```

## 脚本

### scripts/shots.py — 通用截图

```bash
# 单页（默认 1800x950、浅色、整页截图）
python3 scripts/shots.py --out /tmp/shots --shot 'agents:#/agents'

# 深色 + 空态 mock + 点击序列（先开抽屉再截）
python3 scripts/shots.py --out /tmp/shots --dark --mock empty \
  --shot 'drawer:#/workbench:click=[data-testid="settings-drawer-toggle"]'

# 批量：JSON 计划文件（全站 12 张的计划在 scripts/shots-plan.json）
python3 scripts/shots.py --out /tmp/shots --plan scripts/shots-plan.json
```

要点（实测坑）：
- access_token / 主题必须用 `add_init_script` 在首帧前注入（initAuth 在 render 前读
  sessionStorage；`body:not(.is-authed) .shell` 隐藏，事后 setItem 拍到空壳）。
- `?mock=empty` 必须在 `#` 之前（handlers.ts 读 `location.search` 不读 hash）。
- 深色要同时写两个键：应用级 `agentgate_theme` + 运行详情页页面级 `trace-theme`。

### 视觉基线（tests/visual/）

- `baseline/` 12 张基线图（验收即基线：T8 验收通过的截图直接入库）。
- `compare.py` PIL 逐像素比对：阈值 1% 像素差、每通道容差 8（吸收抗锯齿抖动）、
  尺寸不一致直接失败（不缩放）；超阈值输出红色高亮 diff 到 `/tmp/t8-visual-diff`。
- `npm run visual` = `scripts/visual.sh`：复用或起 dev server（:5183）→ 按
  shots-plan.json 重截 → 比对。有意的 UI 变更：确认 diff 后把 current 覆盖进 baseline/。

## 测试结构

```
tests/
  setup.ts                # jest-dom + WebCrypto polyfill
  api.test.ts             # callApi SSE 解析 / 认证分支 / 请求头 / apiOne
  auth.test.ts            # exchangeCode / onAuthExpired 幂等 / initAuth / loginUrl
  workbench-page.test.tsx # KPI 推导 + 方案表 + 最近运行表 + 空态/骨架
  agents-pages.test.tsx   # Agent 目录/详情 + 探测连通 + 模板保存
  resources.test.tsx      # 评估器表格/分块表单 + 数据集三 tab + 红队生成
  plan.test.tsx           # 方案详情 KPI/历史/报告/趋势 + 编辑器 + 运行流式
  run-detail.test.tsx     # 运行详情三栏 / trace 树 / 右栏三态 / 深色切换
  settings.test.tsx       # 设置抽屉四分节
  smoke-parity.test.tsx   # 旧版 ui_smoke.py 等价性补测（登录门/导航/术语/令牌计算值）
  visual/                 # 视觉基线（见上）
```

## 功能缺口清单（旧版有、React 版未实现——记录不实现）

旧版 `scripts/ui_smoke.py` 冒烟等价性审计（128 条断言）发现的差异：

1. **数据集表单化逐条编辑器**（旧 #9.7.5，约 12 条断言）：表单/JSON 双模式、单轮/多轮
   卡片、勾选多轮展开三字段、坏 JSON 切模式拦截、缺 name 指出第几条。React 版只有
   JSON textarea 简化编辑器（坏格式就地报错已有）。
2. **探测响应路径树可点选**（旧 #9.8 后半，约 8 条）：`response_paths` 多行可点、
   truncated/is_whole_response 不可选、点选写回 response_path 并复验、「不提取整段
   作为输出」。React 版渲染只读路径列表（`agent-probe-paths`），不可点选。
3. **payload 模板预置格式 chips**（旧 #9.8 前半，4 条）：prompt/messages/自定义单选、
   内容反推高亮。React 版是自由文本 textarea。
4. **综合报告版本切换与 [run:#N] 溯源**（旧 #3.2，4 条）：版本下拉、[run:#N] 点击
   高亮历史行。React 版只展示当前 run 的 synthesis 文本。
5. **改进稿 diff 视图**（旧 #3.5，2 条）：propose_improvements → 前后对比 diff、
   修订全文标签切换。React 版无该入口（AI 生成用例按钮同为占位提示）。
6. **运行中收起为底部状态条**（旧 #5.5，2 条）：编辑器打开时整版控制台收起、出细
   状态条。React 版运行进度为方案详情页内 role=status 进度条，无收起形态。
7. **760px 表格容器内滚动断言**（旧 #11）：React 版有 900px/560px 响应式规则，
   但无 `.tscroll` 容器内滚动的等价保证（未截图验证）。

以上均已在旧版冒烟中定义了期望行为，实现时照 `scripts/ui_smoke.py` 对应断言补齐即可。

## 目录

```
src/
  main.tsx              # 启动：dev 启 MSW → initAuth（首帧前）→ render
  App.tsx               # QueryClientProvider + 主题应用 + Shell
  styles/tokens.css     # 设计令牌：自旧版 :root 原样迁移 + html[data-theme="dark"] 覆盖
  styles/base.css       # 布局壳样式（侧栏/登录门/抽屉/警告条），值照旧版
  lib/config.ts         # config.json 加载（缓存 + 并发去重）
  lib/api.ts            # callApi（SSE 流）/ apiOne / useApiOne
  lib/auth.ts           # Cognito 授权码流程 + 401 过期收口
  lib/queryClient.ts    # QueryClient 单例（过期时整体 clear）
  stores/session.ts     # Zustand：token/authed/everAuthed/authExpired/theme
  router.tsx            # hash 路由
  components/layout/    # Shell/Sidebar/AuthGate/AuthExpiredBanner/SettingsDrawer/Icons
  pages/                # 7 页：workbench/agents/agent 详情/resources/plan 详情+编辑器/run 详情
  mocks/                # MSW handlers（config.json / Cognito / API action 分发）
tests/                  # Vitest 135 条 + tests/visual/ 视觉基线
scripts/                # shots.py 截图 / shots-plan.json 全站计划 / visual.sh 视觉回归
```

## 核心 API 用法（页面波必读）

```ts
// 读操作：apiOne + useQuery
const { data } = useQuery({
  queryKey: ["datasets"],
  queryFn: () => apiOne<{ event: "datasets"; datasets: Dataset[] }>(
    { action: "list_datasets" }, "datasets"),
});

// 写操作：useApiOne（useMutation 封装）
const save = useApiOne<{ event: "dataset_saved"; name: string }>("dataset_saved");
save.mutate({ action: "save_dataset", name, cases });

// 流式（evaluate 等多事件动作）：直接 callApi，支持 AbortSignal
await callApi({ action: "evaluate", ... }, (ev) => { ... }, { signal });

// 认证：useAuth() → { authed, everAuthed, authExpired, login, logout }
// 401 过期由 callApi 统一收口（onAuthExpired）：幂等、清 token、queryClient.clear()。
// 路由：useRoute() 读当前路由；navigate("#/plan/xxx") 跳转。
```

## data-testid 命名规范

所有可交互元素必须带 `data-testid`，kebab-case，`区域-对象[-动作]`：

| 前缀 | 示例 |
|---|---|
| 导航 | `nav-agents` `nav-workbench` `nav-resources` |
| 账户区 | `account-login` `account-logout` `account-who` |
| 登录门 | `auth-gate` `auth-login` |
| 过期警告 | `auth-expired-banner` `auth-relogin` |
| 设置抽屉 | `settings-drawer-toggle` `settings-drawer` `settings-drawer-close` `settings-drawer-mask` |
| 页面根 | `page-workbench` `page-agents` `page-resources` `page-plan-detail` `page-run-detail` `page-agent-detail` |
| 布局 | `sidebar` `main` `skip-link` |

页面波新增元素照此规则：列表行 `plan-row-<id>`，行内动作 `plan-row-<id>-run`，
表单字段 `dataset-form-name` 这类。

## 术语表（定案，五词精确）

工作台 / 线上评估 / 回归测试 / 红队测试 / 资源库。
底层 payload 值 `observe/dataset/redteam` 不变，只改显示文本。

## 路由表

`#/agents` `#/workbench`（默认）`#/resources` `#/plan/:id` `#/run/:id` `#/agent/:name`。
设置不是路由——右侧抽屉（180ms 滑入，Esc 关闭，焦点圈禁）。
