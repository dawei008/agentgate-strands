# 0017 闭环补全：对齐 CloudWatch Omni 的「标注 · 入集 · 对比 · 拓扑 · 沙盒」

Status: **accepted**（2026-09-07；D1–D4 定案并派批，四个待定点全部定案；二期只留「改 Agent」三条路，见 `docs/roadmap-phase2.md`）

## Context

2026-09-07 读了 Amazon CloudWatch Omni for Agents (Beta) 的演示（`.scratch/competitive/cloudwatch-omni-2026-09-07/`，
功能列表见 `docs/roadmap-omni-parity.md`）。它的闭环与 ADR-0016 同构（观测 → 评估 → 优化），但有五件我们没有：
人工标注、trace 入数据集、trace 并排 diff、Agent 拓扑聚合、提示词变体对比与自动判赢。
同时用户在 2026-09-04 提出「测试里的 bad case 要能放进数据集，让用例越来越多」。

两条前提决定了不能照抄：
1. Omni 是编辑器扩展，**看得见并能改被测 Agent 源码**；我们只经 AgentCore Runtime 调用 Agent，看不见源码
   （问题台账提示词已明文「不得给出代码路径」）。
2. Omni 单项目单 Agent、trace 粒度；我们舰队级、run 粒度为主，span 已在拉（`transcript.events` 带
   `span_id` / `parent_span_id`，`t_offset_s`，tool 名与参数）。

## Decision

### D1 坏例入数据集（F1）
- 来源只有两类：**线上评估**判未过的会话 → regression 数据集；**红队测试**被攻破的攻击 → redteam 数据集。
  回归测试未过的用例本来就在集里，不复制。Agent 调用报错 / 空响应 / 评委失败不是坏例，不给入口。
- 「未过」口径 = 该行任一评估器 `passed === false` 且非 `errored`（与报告页 `model.ts` 同一判定）。
- `expected_output` **必填**。抽屉预填 Agent 实际回复作草稿并以警示色标「这是错答，请改成正确答案」；
  与草稿逐字相同或为空时禁止保存。理由：数据集是回归的标准答案，存错答等于把缺陷固化。
- 多轮会话取最后一轮用户输入，前文压成一句摘要前缀（与 `tau-airline-regression-15` 现有格式一致）；
  真正的多轮回放走 simulation 集，二期。
- 目标数据集默认 `<agent>-badcases`（regression）/ `<agent>-badcases-rt`（redteam），不存在则建；可改选任一同 kind 数据集。
- 去重按归一化 `input`（去首尾空白、折叠空白、小写）全等；命中时默认不勾并提示「已在集内」，可选「更新期望」。
  `name` 自动生成 `<run 短号>-<行名>`，不参与去重。
- 留痕字段 `source: {run_key, row_key, kind: "session"|"attack", evaluators_failed[], score, human_score?, added_at}`，
  `added_at` ISO-8601 UTC。数据集页显示「来自 线上评估 run #N」chip，可点回报告行。
- 后端新动作 `append_dataset_cases {dataset, kind, cases[], create_if_missing}`：**服务端**读 → ADR-0009 形状校验 →
  去重 → 追加 → 写，返回 `{added, skipped_duplicates, dataset}`。禁止前端读改写（两人同时加会丢条）。
- 首次为某 Agent 建坏例集时**提示**建评估计划「<agent> · 坏例回归」（一个 dataset 环节，评估器沿用来源 run），用户确认才建。

### D2 人工标注（F2）
- 形状 `{run_key, row_key, evaluator | "overall", human_score: 0 | 0.5 | 1, label?, comment?, by, at}`；DDB 新 item 类型 `ANNOT`。
- **人工分不改机器分**：不回填 pass_rate / evaluator_stats，只在报告页格详情、③ 台账证据处并列显示；
  同一格重标覆盖旧值。
- 人工分是评估器校准的输入：评估器页「跨 Agent 表现」增加「与人工一致率」（有标注才显示）。
- 入集（D1）时把人工分与备注一并带进 `source.human_score` / `notes`。

### D3 会话并排 diff（F3 / F8）
- 评估分析页新增「同题配对」：两次 run 按 `input`（回归）或用户首句（线上）对齐；每对一行两侧分与判定；点开双栏。
- 双栏 = 两条 transcript 时间线（`t_offset_s` · type · tool · 耗时）+ 属性 diff 表（模型 / token / 工具参数 / 系统提示词，
  Added / Removed / Modified 三色）+ 评估器分与理由并排。
- 后端 `compare_sessions {left:{run_key,row_key}, right:{...}}`，diff 在服务端算，只回有差异的属性。
- 会话回放（F8）= 同一时间线组件的单栏版，报告页格详情里加「回放」入口。
- **版面：用户 2026-09-07 选 OpenDesign 变体 B「表 + 页内展开」**（`agentgate-adr0017-compare`）：配对表留评估分析页，点行原位撑开双栏（像报告页矿阵点格），允许多行同时展开；未对齐行原位展开为单栏回放。主会话原推 C 独立页（ADR-0013 长文住页面），用户取 B，理由以用户为准；实现时给展开区「在新页打开」入口作为 ADR-0013 的兜底。

### D4 Agent 拓扑（F4）
- 节点 = `agent` / `tool:<name>` / `model:<id>`（与 `transcript.py` 现有命名一致）；边 = parent_span → child_span。
- 节点带次数、平均 / P95 时延、报错数；边带次数。数据源 = ① 现状同一批线上会话（同 span_source、同 lookback），
  **Start 节点次数必须等于 ① 的会话数**（同源判据）。
- 落点 = Agent 详情 ① 现状新增「路径」卡，默认折叠为一句（N 节点 · 最慢节点 · 最常路径占比），点开画层次图；
  点节点右侧列最近 10 个会话。后端 `agent_topology {agent_name, lookback_days}`，缓存 5 分钟。
- Flow 横向视图：**一期做**（用户 2026-09-07 定，原待定点 4），展开态加「层次 / 横向」切换。**版面：用户 2026-09-07 选 OpenDesign 变体 A「卡内展开」**（`agentgate-adr0017-topology`）：折叠一句 → 原位撑开，图 2/3 + 节点详情 1/3；「层次 / 横向」切换 chip 一期即出。

### D5 提示词沙盒与加权判赢（F5 / F6）—— **一期做（批 D）**：沙盒收窄为「改系统提示词类建议的措辞预检」（用户 2026-09-07：只有要改代码 / 要负责人动手的才二期；沙盒平台自己能跑）；模型只用已配 judge 模型，单次预算默认 $2 可改；F6 比真 run 版本 + 沙盒变体，默认权重 60/25/15 可改。「改 Agent」三条路（复制修改指令 / env 发版 / GitHub PR）进二期，见 `docs/roadmap-phase2.md`
用户质疑「代码拿不到，只有提示词」：沙盒只能验措辞方向，验不了 Agent；「改」那一步的三条路（复制修改指令 / env 发版 / GitHub PR）也一并进二期 P2-2~P2-4。下文保留为设计记录。

- 沙盒 = 用 judge 模型（或用户选的模型）带候选系统提示词对数据集每个 `input` **直答**（不经被测 Agent、无工具），
  再按所选评估器打分；与被测 Agent 上次 run 的分并排。界面 title 必须写明「模型直答、无工具，只比措辞方向」。
- 变体：A 当前提示词（transcript 抓到 `system_prompt` 则预填，否则要求粘贴）、B 台账建议合成、C 手改。
- 判赢加权默认 评估分 60% · 时延 25% · token 15%（待定点 3），存 CONFIG 可改；评估分项**逐评估器过线数**而非合成均分
  （CONTEXT.md「线上评估均分」词条：决策位不用均分）。
- 后端 `sandbox_run {dataset, evaluators, variants[], model, budget_usd}` 流式；先估成本再跑，超预算拒跑。
- 沙盒结果可「存为该 Agent 的提示词候选」写进台账条目 `proposals`，**不改 Agent**。
- F6 把评估分析页从两次 run 扩到 2–4 列（run 或沙盒变体），按 `agent_version_label` 选版本。

### D6 不做
VSIX 扩展本体；改用户源码的 Prompt Management；本地 dev server；全局合成均分仪表。

## 待定点（用户拍板后删本节转 accepted）
> 2 定为「只用已配 judge 模型，预算默认 $2 可改」；3 定为 60/25/15 可改；4 定为「做」。四个待定点全部定案。
1. ~~D1 expected 预填还是留空~~ —— 2026-09-07 用户选定批 A 变体 A（右侧抽屉，预填错答 + 警示条），D1 按本文取法定案。
2. D5 沙盒模型：只用已配 judge 模型，还是允许选别的；单次沙盒预算上限（建议 $2）。
3. D5 默认权重 60 / 25 / 15 是否照 Omni。
4. D4 Flow 横向视图是否进一期。

## Consequences
- 数据集会随线上坏例增长，回归越来越贴近真实流量；代价是每条都要人写 expected（D1 有意为之）。
- 人工分与机器分并列，评估器校准有了 ground truth，但页面上多一列要解释谁是谁（设计变体已要求形态可辨）。
- 沙盒结论只能说「措辞方向」，不能替代真 run；界面必须把这个边界写在 title 里，否则会被读成「改了就好」。
- 新增后端动作 4 个（append_dataset_cases / annotate_case / compare_sessions / agent_topology）+ 沙盒 1 个；
  契约进 `docs/payload-contract.md`，动作数 56 → 61。
- 批次：A = D1+D2；B = D4；C = D3；D = D5+F6；E = F7+F9。每批 minor。设计走 OpenDesign 三变体选型
  （批 A 项目 `agentgate-badcase-intake`，用户 2026-09-07 选 **A 右侧抽屉**，批量态借用 C 的清单 + 进度）。
