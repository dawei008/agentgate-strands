# 功能列表 · 对齐 CloudWatch Omni for Agents「它有我们没有」的部分

> 2026-09-07 · 主会话起草，待用户定稿后拆批。决策记录在 `docs/adr/0017-close-the-loop-omni-parity.md`（accepted）。F5 / F6 及「改 Agent」三条路已转二期，登记在 `docs/roadmap-phase2.md`。来源：Storylane 演示 39 步字幕与截图
> （`.scratch/competitive/cloudwatch-omni-2026-09-07/`）。与 ADR-0016 的闭环「观测 → 评估 → 优化」对齐，
> 所有落点都写成现有页面的位置；术语七词不变（评估计划 / 评估器 / 数据集 / 评估分析 / 线上评估 / 回归测试 / 红队测试）。

## 0. 先说清两条边界（决定了怎么改造，不是照抄）

| Omni 的前提 | 我们的前提 | 影响 |
|---|---|---|
| 开发态：扩展装在编辑器里，**看得见并能改被测 Agent 的源码**（Prompt Management 抽提示词进 git；Onboard 让 coding agent 改 instrumentation） | 运行态评估平台：只通过 AgentCore Runtime 调用被测 Agent，**看不见源码**（ISSUES prompt 已明文：不得给代码路径） | 「改提示词 → 重跑」不能直接照抄；改成「提示词沙盒」（用 judge 模型代跑候选提示词）+「版本对比」（比 Agent 的 runtime 版本标签） |
| 单项目、单 Agent、trace 粒度 | 舰队、多 Agent、run 粒度为主，span 已在拉 | 拓扑图 / trace 并排 diff 的数据源我们已有（`transcript.events` 带 `span_id` / `parent_span_id`，gen_ai 属性），缺的是聚合与页面 |

## 1. 功能总表（按优先级）

| # | 功能 | Omni 对应 | 我们落点 | 后端新动作 | 前端新面 | 优先级 | 估算 |
|---|---|---|---|---|---|---|---|
| F1 | 坏例入数据集（人确认 expected） | Annotate + Add to Dataset | 报告页矩阵行 / 问题台账 → 抽屉 | `append_dataset_cases` | 入集抽屉、批量按钮、数据集页来源 chip | P0（用户已提） | 1 批 |
| F2 | 人工标注（会话 / 用例 0 · 0.5 · 1 + 类型） | Annotate | 报告页格详情、③ 台账 | `annotate_case` / `list_annotations` | 标注控件、标注列 | P0（与 F1 同批或紧随） | 1 批 |
| F3 | 两次会话 / 用例的并排 diff（逐 span 时延 · 输入输出 · 属性） | Compare + span diff | 评估分析页新增「会话对比」子模式；报告页格详情「与上次同题对比」 | `compare_sessions`（读两份 transcript） | 双栏时间线 + 属性 diff 表 | P1 | 1 批 |
| F4 | Agent 拓扑图（跨会话聚合路径，节点带次数与平均时延） | Agent Topology / Flow | Agent 详情 ① 现状新增「路径」卡；点节点列会话 | `agent_topology` | 有向图（层次布局）+ 节点详情侧栏 | P1 | 1–2 批 |
| F5 | 提示词沙盒（候选系统提示词 × 数据集 × 评估器，不碰被测 Agent） | Playground LLM 模式 + Try Suggested Prompt | ③ 优化 台账「建议」行 → 「沙盒试跑」；评估分析页新子模式 | `sandbox_run`（judge 模型代跑） | 变体列 × 用例行的分数矩阵，加权判赢 | P1 | 2 批 |
| F6 | 版本 / 变体并排比分（分数 · 时延 · token，加权自动判赢） | Playground A/B/C 比较 | 评估分析页（已有两次 run 对比）扩成 N 列 + 加权 | 无新动作（复用 run 数据）；加权配置存 CONFIG | 多列表 + 权重面板 | P2 | 1 批 |
| F7 | 逐评估器分数趋势 + 评估总量 / 通过率仪表 | Evaluation Dashboard | 评估器页「跨 Agent 表现」加趋势列；Agent ① 现状趋势卡已有 | 无 | sparkline 列 | P2 | 0.5 批 |
| F8 | 会话回放（逐轮时延 · token · 工具调用，定位尖峰） | Session Explorer | 报告页格详情 → 「回放」；③ 证据链接 | 无（transcript 已有 `t_offset_s`） | 时间轴视图 | P2 | 1 批 |
| F10 | 第三方评估器适配（DeepEval / Braintrust autoevals）——**二期**（用户 2026-09-07，见 roadmap-phase2 P2-4） | Omni「Run evaluations」里 AgentCore(18) · Braintrust(11) · DeepEval(3) 分组 | 评估器页多两组来源 chip；计划编辑器评估器多选里可见 | `registry.py` 加两类适配器（把第三方 metric 包成与 strands_evals 同形的 score/passed/label/reason，judge 走我们的模型配置） | 评估器列表分组 + 来源 chip | P1 | 1–2 批 |
| F9 | 一键接入（coding agent 装 skill 自动配 instrumentation） | Onboard | README / 新页「接入」 | 无 | 生成接入 prompt 的按钮 | P3 | 0.5 批 |

不做的：VSIX 扩展本体、Prompt Management 改用户源码、本地 dev server。理由见第 0 节。

## 2. 逐项详述

### F1 坏例入数据集（对应 Omni「Add to Dataset」）
- **用户故事**：报告里判未过的用例 / 会话，一键进该 Agent 的回归数据集，下次回归看修没修好。
- **来源与形状**：
  - 回归测试未过用例：已在集里，不复制；只在集内条目上追加「最近一次未过 run」标记（可选）。
  - 线上评估低分会话：`input` = 最后一轮用户输入（前文压成一句摘要前缀，与航空数据集格式一致）；`expected_output` **必填**，抽屉预填 Agent 实际回复作草稿并标红「这是错答，请改成正确答案」，不允许原样保存；`notes` 存评委理由。
  - 红队被攻破：进 redteam 数据集，字段 objective / success_criteria / risk_category / strategy 直接转。
  - Agent 调用报错、空响应、评委失败不算坏例，不给入口。
- **目标数据集**：默认 `<agent>-badcases`（regression）与 `<agent>-badcases-rt`（redteam），不存在则建；可选任一已有同 kind 数据集。
- **去重**：按归一化 `input`（去空白、小写）全等 ⇒ 默认不勾选并提示「已在集内」；按 `name` 不去重（name 自动生成 `<run短号>-<行名>`）。
- **留痕**：`source: {run_key, row_key, kind: "session"|"case"|"attack", evaluators_failed: [...], score, added_at}`（`added_at` ISO-8601 UTC）；数据集页每条显示「来自 线上评估 run #7」chip，可点回报告行。
- **后端**：`append_dataset_cases {dataset, kind, cases[], create_if_missing}`：服务端读 → 校验形状（ADR-0009）→ 去重 → 追加 → 写；返回 `{added, skipped_duplicates, dataset}`。不让前端读改写。
- **接计划**：首次为某 Agent 建坏例集时提示「建评估计划 <agent> · 坏例回归」（一个 dataset 环节、评估器沿用来源 run 的评估器），用户确认才建。
- **验收**：入集后数据集页多 N 条带来源 chip；重复入集 0 新增；expected 为空或等于错答时保存按钮禁用；新建计划一次 run 能在 ③ 看到这些用例。

### F2 人工标注（对应 Omni「Annotate」）
- **用户故事**：评委判错时人可以覆盖；人工分累计成 ground truth，用来校准评估器（F7 里显示「人工 vs 评委一致率」）。
- **形状**：`{run_key, row_key, evaluator|"overall", human_score: 0|0.5|1, label?, comment?, by, at}`；一行可多条（按评估器）。
- **落点**：报告页格详情底部「标注」三个按钮 + 备注；③ 台账条目证据处显示人工分；F1 入集时把人工分和备注一并带进 `notes`。
- **口径**：人工分**不改** run 的机器分（不回填 pass_rate），只并列显示；评估器页「跨 Agent 表现」多一列「与人工一致率」（有标注的评估器才显示）。
- **后端**：`annotate_case` / `list_annotations {run_key}`；DDB 新 item 类型 `ANNOT`。
- **验收**：标注后刷新仍在；同一格改分覆盖旧值；评估器页一致率 = 人工与机器 pass 判定一致的比例。

### F3 会话 / 用例并排 diff（对应 Omni「Compare」+ span diff）
- **用户故事**：同一题在两次 run 的两份回答为什么一个过一个不过；看逐 span 时延、工具调用、输入输出哪里变了。
- **选择方式**：评估分析页已有两次 run 对比 ⇒ 增加「同题配对」表：按 `input`（回归）或用户首句（线上）对齐两次 run 的行，每对一行显示两侧分与判定；点开 = 并排双栏。
- **并排内容**：左右两条 transcript 时间线（`t_offset_s`、type、tool name、耗时），中间对齐线；属性 diff 表（模型、token、工具参数、系统提示词）按 Added / Removed / Modified 着色；评估器分与理由并排。
- **后端**：`compare_sessions {left: {run_key,row_key}, right: {...}}` 返回两份 transcript + 属性差异清单（服务端算 diff，避免前端拉两份大 JSON）。
- **验收**：两份 run 的同题对齐率显示（N/M 对上）；diff 表只列有差异的属性。

### F4 Agent 拓扑图（对应 Omni「Agent Topology / Flow」）
- **用户故事**：这个 Agent 平时怎么走：先调哪个工具、哪条分支慢、哪个节点报错多。
- **数据**：聚合近 N 天线上评估会话（与 ① 现状同一批 span）：节点 = `agent` / `tool:<name>` / `model:<id>`（transcript 已按此命名），边 = parent_span → child_span 顺序；节点带 次数、平均 / P95 时延、报错数；边带次数。
- **落点**：Agent 详情 ① 现状新增「路径」卡（默认折叠为「N 个节点 · 最慢 tool:query_order 2.1s · 最常走 路径 A 63%」一句，点开画图）；节点点开右侧列该节点最近 10 个会话 → 报告页。
- **后端**：`agent_topology {agent_name, lookback_days}`，走 span_source 同源，缓存 5 分钟。
- **前端**：层次布局（dagre 或手写分层），零玻璃，颜色只给状态（报错节点 bad）。
- **不做**：Omni 的 Flow 横向架构图（对我们是同一份数据换布局，二期）。
- **验收**：与 ① 的会话数同源（节点 Start 的次数 == 会话数）；无 span 的 Agent 显示不可用原因而不是空图。

### F5 提示词沙盒（对应 Omni Playground LLM 模式 + Try Suggested Prompt，按第 0 节改造）
- **用户故事**：台账里「改系统提示词」的建议，采纳前想知道有没有用。
- **做法**：用 judge 模型（或用户选的模型）+ 候选系统提示词，对所选数据集的每个 `input` 直接出回答（**不经过被测 Agent、无工具**），再按所选评估器打分；与被测 Agent 上次 run 的分并排。页面上必须写清「沙盒是模型直答，不含工具调用，只用于比较提示词措辞方向」（进 title，不做恒成立散文）。
- **变体**：A = 当前提示词（若 transcript 抓到了 `system_prompt` 则预填，否则要求用户粘贴）、B = 台账建议合成后的提示词（把该条 recommendation 追加成一段）、C = 用户手改。
- **判赢**：F6 的加权（默认 评估分 60% · 时延 25% · token 15%，可改）。
- **后端**：`sandbox_run {dataset, evaluators, variants:[{label, system_prompt}], model}` 流式返回逐用例逐变体分；成本按 judge 定价预估并先显示。
- **验收**：三变体 × N 用例矩阵；赢家行高亮；可「把 B 存为该 Agent 的提示词候选」写进台账条目的 `proposals`（不改 Agent）。

### F6 版本 / 变体并排比分（对应 Omni A/B/C 比较）
- 评估分析页从「两次 run」扩到「2–4 次 run 或沙盒变体」并排：逐评估器分、通过率、平均时延、token；顶部加权公式可调；自动标「胜出」及原因一句（哪几项拉开）。
- 版本维度：按 `agent_version_label` 选 run（v1.2 vs v1.3），补上 ADR-0016 说的「版本变更竖线」的对照面。
- 无新后端动作。

### F7 逐评估器趋势与仪表（对应 Evaluation Dashboard）
- 评估器页「跨 Agent 表现」每行加近 8 次 sparkline（复用 `SparkTrend`）、评估总次数、通过率；有人工标注的加「与人工一致率」（依赖 F2）。
- 不做全局「平均分」大数字（分数口径修订：不合成均分）。

### F8 会话回放（对应 Session Explorer）
- 报告页格详情加「回放」：按 `t_offset_s` 画时间轴，每轮气泡带 token / 时延 / 工具名，尖峰标红；即 F3 单栏版，先做 F3 再复用。

### F9 一键接入（对应 Onboard）
- 新页或 README 段：选框架（Strands / LangGraph / OpenInference 家族 / ADK / 通用 gen_ai）生成一段给 coding agent 的接入提示词（装 OTel 插桩、指向 aws/spans、设 `session.id`、按契约设 payload 形状），复制即用。零后端。

## 3. 依赖与顺序
1. F1 → F2（同一个抽屉，F2 的人工分喂 F1 的 notes）
2. F3 → F8（F8 是 F3 单栏）
3. F4 独立
4. F5 → F6（F6 的加权判赢先在 F5 里用）
5. F7 依赖 F2 的一致率列，其余独立
6. F9 独立，文档批

建议批次：批 A = F1+F2；批 B = F4；批 C = F3(+F8)；批 D = F5+F6；批 E = F7+F9；F10 第三方评估器转二期（用户 2026-09-07）。每批 minor 版本。

## 4. 需要用户定的
- F1：expected 预填「Agent 实际回复」还是空白（本文按 Omni 取预填 + 标红）。
- F5：沙盒用哪个模型直答——judge 模型（已配）还是允许选别的；每次沙盒的预算上限。
- F6：默认权重 60 / 25 / 15 是否照 Omni。
- F4：是否需要 Flow 横向视图（本文列为二期）。
