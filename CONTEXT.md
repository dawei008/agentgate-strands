# AgentGate（仓库 agentgate）

Agent 评估平台的统一语言。单上下文布局：本文件是全仓唯一术语表，前端文案、
后端字段命名、测试命名都以此为准。架构决策见 `docs/adr/`。

每条词条给三样东西：**它精确指什么**、**它不指什么**（`_不指_`）、以及**物理住所**
（`_住所_`，唯一真相所在的**文件 + 符号名**；不写行号——搬一次就过期）。写文案、起字段名、写断言前先查这里；
与本文件冲突的说法一律以本文件为准，本文件与代码冲突时按 `_住所_` 现场为准并立刻回改本文件。

## 不可变术语（全站文案强约束）

> 2026-08-29 用户改版：工作台→评估计划、对比→评估分析、资源库拆为评估器+数据集。

以下七个词是产品的一级功能命名，**不得改写、不得使用同义词**：

**评估计划**:
全局总览页，聚合各方案的运行状态与趋势（原「工作台」；hash 仍是 `#/workbench`）。
_Avoid_: 工作台、仪表盘、Dashboard、首页

**评估器**:
定义「怎么评」——内置与自定义评分标准的集中管理页（原资源库上块）。
_Avoid_: 评分器、打分器、judge（文案中）

**数据集**:
决定「拿什么测」——回归数据集 / 模拟测试 / 红队用例集 / 线上评估数据的
集中管理页（原资源库下块）。
_Avoid_: 资源库、素材库、Library

**评估分析**:
跨方案、跨版本对比两次运行的分析页（原「对比」页；hash 仍是 `#/compare`）。
仅约束页面/导航命名——「与上次对比」这类**动作动词**不受此限。
_Avoid_: 对比（作页面名时）、分析台

**线上评估**:
对 Agent 线上真实流量（trace/span）进行的持续评估。
_Avoid_: 在线评估、生产评估、observe（文案中）

**回归测试**:
用固定数据集对 Agent 重复执行的对比评估，验证行为未劣化。
_Avoid_: 离线评估、批量测试

**红队测试**:
用对抗性用例主动攻击 Agent 以暴露安全与合规弱点的评估。
_Avoid_: 安全测试、攻击测试、red team（文案中）

## 核心概念

**Agent**:
被评估对象，指向一个 AgentCore Runtime。
_Avoid_: 智能体、应用、bot

**方案**:
评估配置单元（plan），由 1..n 个环节组成；是调度与运行的基本单位。
_Avoid_: 计划、任务、评估任务

**环节**:
方案内的一个评估步骤（stage），存储层 type 只有三类：observe / dataset /
redteam。不存在 simulation 类型的环节（见 ADR-0001）。三套命名的映射见
「命名映射」一节。
_Avoid_: 阶段、步骤、step

**run**:
一次方案的完整执行，以 run_key = plan_id#时间戳 唯一标识。run 有两个正交
的终态维度：**有没有分**（是否进均分/趋势）与**跑成功没有**（是否产出有效
结果），两者可以合法地不一致，见「度量口径」一节。
_不指_: 「有分」等于「成功」——这是 2026-08-24 修订前的旧口径（ADR-0003
Amendment 已作废该等式）。
_住所_: `app/planrun.py` 的 `_persist`（写入）、`web/src/lib/scoring.ts`（展示口径）
_Avoid_: 执行、job、任务实例

**数据集**:
一组测试用例，存储 kind 三类：regression（回归）、simulation（模拟）、
redteam（红队）。kind 显式落库，缺失时按内容形态推断（见 ADR-0002）。
_住所_: `app/catalog.py` 的 `DATASET_KINDS`、`lib/datasetSide.ts` 的 `isSimulationSide`
_Avoid_: 测试集、用例集、语料

**评估器**:
给输出打分的规则，分内置（SDK 评估器类）与自定义（rubric 评分标准）
两种。自定义评估器的 rubric 字符串是 judge 消费的唯一真相（见 ADR-0004）。
_Avoid_: 评分器、judge（文案中）、metric

**模拟测试**:
由 ActorSimulator 驱动的多轮对话式测试。是 UI/产品概念：入口与文案
独立呈现，但存储上仍是 kind=simulation 的数据集 + type=dataset 的环节，
不是独立的环节类型。
_住所_: `web/src/pages/plan/PlanEditor.tsx` 的 `STAGE_UI_LABEL`（UI 四类）
_Avoid_: 仿真测试、多轮测试

## 度量口径（一词多义治理区）

这一节是「已经跑了两次，为什么趋势和分数还没出来」这类困惑的词汇根因。
两条正交口径**永不合并**：口径 1 回答「这个 run 能不能进均分与趋势」，
口径 2 回答「这个 run 跑成功了没有」。

### 分数家族

**分数（score）**:
仅指 run 顶层 `score` = 该 run 内各 observe 环节 `overall_mean` 的均值。
纯回归 / 纯红队方案的 run 顶层 score **必然为空**，这是设计而非缺陷。
_不指_: 回归通过率、红队攻破数、评估器单项分、rubric 的 1~5 档位分。
_住所_: `app/planrun.py` 的 `_persist`（顶层 score 唯一写入）、`lib/scoring.ts` 的 `isScored`
_Avoid_: 总分、综合分（这两个词会被读成「把三类环节合成一个数」——本产品
绝不合成，见 ADR-0003 Amendment）

**线上评估均分**:
一组 run 的顶层 score 的算术平均。**「均分」不得单独出现**：裸词「均分」
在同屏可能被读成回归通过率或环节分，一律带限定词（「线上评估均分」
「本环节均分」）。
_不指_: 所有成功运行的平均成绩——它的样本只有「有分运行」。
**决策位不用它**（ADR-0016 分数口径修订，2026-09-03）：Agent 详情 ③ 优化的头部
一句话与评估器面板只列逐评估器分与「未过项」，多个评估器的分**不合成均值**——
一个评估器 0.94、另一个 0.55 的均值 0.75 会把一条未过线的告警读成「过线」。
均分只留在 ① 现状的趋势与评估计划页的 KPI 里作观测量。
_住所_: `web/src/pages/workbench/kpi.ts` 的 `deriveKpi`（`isScored` 样本闸门）、
`web/src/pages/plan/derive.ts` 的 `deriveKpis`；③ 的逐评估器口径在
`web/src/pages/agents/detail/hub/optimizeDerive.ts`

**通过率（pass_rate）**:
dataset 环节内判定通过的用例占比。0% 是结论不是空值。
_不指_: 「跑成功的 run 占比」。工作台「回归通过率」KPI 的分母是按环节判定
跑成功的 run 数（口径 2），与本词的环节内含义不同层。
_住所_: `app/planrun.py` 的 `_run_dataset_stage`（`pass_rate` 计算）、
`web/src/pages/workbench/kpi.ts` 的 `deriveKpi`（`regressPlanIds` 分支）

**攻破数（breached）/ 攻击数（attacks）**:
redteam 环节内被攻破的次数 / 实际发起的攻击次数。`breached = 0` 是
「全部抵御」这一合法结果；**「没测过红队」返回 null 而不是 0**。
_住所_: `web/src/lib/scoring.ts` 的 `breachOf`

**rubric 档位分**:
自定义评估器评分标准里的 1~5 整数刻度。与 0~1 的连续分完全不同量纲，
格式化函数刻意不共用。
_住所_: `web/src/pages/resources/rubric.ts` 的 `fmtScore`

**目标线**:
趋势图与告警用的分数阈值（当前 0.70）。
_不指_: 被测 Agent。红队用例集上的 `target_agent` 字段读作「被测 Agent」，
文案里不得简写成「目标」。
_住所_: `web/src/pages/plan/TrendCard.tsx`（TREND_TARGET）、
`web/src/pages/resources/types.ts` 的 `target_agent` 字段

### 成功家族

**有分运行**:
口径 1。completed 且顶层 score 非空的 run。**均分与分数趋势的唯一样本闸门**。
_不指_: 成功运行。纯回归 / 纯红队 run 恒不是「有分运行」，但可以是「成功运行」。
_住所_: `web/src/lib/scoring.ts` 的 `isScored`

**成功运行**:
口径 2。按环节判定产出了**有效结果**的 run（含「部分失败」——它确实产出了
可用结果，只是不完整）。
_不指_: 有分运行；也不指 `status === "completed"`（环节全炸的 run 顶层仍是
completed，但不是成功运行）。
_住所_: `web/src/lib/scoring.ts` 的 `isRunSuccess` / `runOutcome`

**有效结果**:
一个环节真评到了东西：observe = completed 且 `overall_mean` 非空；
dataset = completed 且 `pass_rate` 非空；redteam = completed 且 `attacks > 0`。
_不指_: 结果好。攻破 12/12 也是有效结果。
_住所_: `web/src/lib/scoring.ts` 的 `isStageEffective`

**「成功运行数」与「趋势样本数」合法地不相等**:
前者走口径 2，后者走口径 1。同屏出现两个数不等**不是 bug**，界面必须
自己解释（各自带 scope 文案），不得靠用户推理。
_住所_: `web/src/pages/plan/PlanDetailPage.tsx` 的决策 KPI 行（`kpi-scope`
「线上评估有分运行」/「成功运行」两块）、`web/src/pages/plan/TrendCard.tsx`
（「最近 N 次有分运行」scope 文案）

### 完成家族

**完成（环节级）**:
一个环节执行到底且没报错（`stage.status === "completed"`）。
_住所_: `app/planrun.py` 的 `_stage_summary`

**完成（run 级 badge）**:
run 的所有环节都没失败，且至少一个环节产出有效结果。
_不指_: `run.status === "completed"`。后者只说明后端流程走完了，环节可能
全炸（那时 badge 是「失败 · <环节>」）。
_住所_: `web/src/lib/scoring.ts` 的 `runOutcome`（`kind:"ok"` 分支）/ `runBadge`

**部分失败 · <环节>**:
有环节执行失败，但也有环节产出了有效结果。仍计入「成功运行数」，badge
必须列出失败环节名。
_住所_: `web/src/lib/scoring.ts` 的 `runOutcome`（`kind:"partial"` 分支）

**失败 · <环节>**:
run 的所有环节都失败（或后端顶层 status=error）。
_住所_: `web/src/lib/scoring.ts` 的 `runOutcome`（`kind:"failed"` 分支）

### 空家族（三个层级，绝不混用）

**无数据（环节级）**:
`stage.status === "empty"` —— 环节**执行成功但没东西可评**（如 observe 回溯
窗口内没有会话）。不是失败：判失败时必须先把 empty 排除，因为 empty 环节
也带 error 文本。
_住所_: `app/planrun.py` 的 `_run_observe_stage` / `_run_dataset_stage`
（两处 `"status": "empty"` 分支）、`web/src/lib/scoring.ts` 的 `isStageFailed`、
`web/src/pages/plan/useRunPlan.ts`（「环节 N/M · …」流式文案）

**完成 · 无可评估数据（run 级）**:
run 执行没出错，但一个环节都没产出有效结果（环节全 empty / 无环节）。
中性 badge，不算成功、不算失败、不入均分与趋势。
_不指_: 「跑失败了」，也**不指**「纯回归/纯红队 run」——后者是「完成」
（UI-013 的错就是把这两件事混成一件）。
_住所_: `web/src/lib/scoring.ts` 的 `RunOutcomeKind`（nodata 口径注释）与
`runOutcome` 落 nodata 的**两处**分支（无环节且无顶层 score / 有环节但零有效
结果）、`web/src/pages/plan/ReportDrawer.tsx`（`outcome.kind === "nodata"` →
空转提示条）

**空转**:
「本次评估管道空转」提示条的触发条件，**只**在 run 级 nodata 出现。
_不指_: 有环节失败的 run（那要说失败，绝不能拿「空转」盖掉 `stage.error`）。
_住所_: `web/src/pages/plan/ReportDrawer.tsx` 的 `noData`（→「本次评估管道空转」提示条）

**空响应（用例/会话级）**:
被测 Agent 返回 0 字节（HTTP 200，多为其自身 content_filtered）。既未回答
也未拒绝，**绝不按 0 分计**，也不入缓存。
_不指_: 环节无数据、run 无可评估数据。
_住所_: `app/testrun.py` 的 `_is_blank_output`、`app/probe.py` 的 `probe_invoke`（0 字节判定）、
`web/src/pages/plan/liveTurns.ts` 的 `blankKindOf`

**未计分**:
大屏对 run 级 nodata 的另一套说法（同一判定 `kind === "nodata"`）。
_Avoid_: 新文案里沿用——同一判定应只有一种说法，统一到「无可评估数据」
待拍板（见 `.scratch/domain-r1/decisions-needed.md` D-3）。
_住所_: `web/src/pages/bigscreen/derive.ts` 的 `isNoScore` / 待处理事项里的
「未计分（无有效输出）」事件文案

**运行报告**:
单次 run 的结果页。**只讲本次**：一句现算裁决句（列本次没过的东西，用
SDK `test_pass` 数出来，不分档、不比上次）+ 全量表（一行=一个用例/会话/
攻击，失败行标红置顶，证据链在展开态）+ 本次建议区（按 fix_type 聚合，
每条必须引用支持它的评估结果，无引用不上屏）。任何跨 run 内容（趋势、
反复问题、采纳效果）归评估分析页。见 ADR-0014。
_Avoid_: 在报告里出现「较上次」「趋势」——那是评估分析的词。

## 命名映射

环节有三套名字：**存储 type**（后端契约 / DDB / 事件流）、**中文展示名**
（用户看到的，取自不可变术语）、**用户口语**（工单与对话里出现的说法）。

| 存储 type | 中文展示名 | 用户口语 | 产出的指标 |
|---|---|---|---|
| `observe` | 线上评估 | 线上、真实流量、observe | `overall_mean`（→ run 顶层 score） |
| `dataset` | 回归测试 | 回归、跑数据集、离线跑 | `pass_rate` |
| `dataset` + kind=simulation 集 | 模拟测试（仅方案编辑器） | 模拟、多轮、扮演 | `pass_rate` |
| `redteam` | 红队测试 | 红队、攻防、越狱 | `breached` / `attacks` |

导航层级（ADR-0016，2026-09-03）：顶栏四项 = **Agent / 评估计划 / 评估器 / 数据集**
（Agent 是主语，其余三项是它的资源）；Agent 详情四区 = **① 现状 / ② 评估 / ③ 优化 /
④ 配置**，对应观测→评估→优化闭环，环节三类只出现在 ② 与 ③ 的行内。

映射的**唯一权威**是 `web/src/lib/scoring.ts` 的 `STAGE_LABEL` / `stageLabel()`
——存储三类 → 中文展示名只有这一份，消费方一律 import，不得再抄。散在
`pages/plan/derive.ts`、`pages/plan/useRunPlan.ts`、`pages/plan/PlanEditor.tsx`、
`pages/run/RunDetailPage.tsx`、`pages/workbench/WorkbenchPage.tsx` 的五份拷贝已于
2026-08-25（simplify-r2 Track D）清零。

`PlanEditor.tsx` 的 `STAGE_UI_LABEL` **不是**拷贝而是另一维度：那是 UI 四类
（含「模拟测试」）→ 存储三类的映射，合法保留。所以仍然只有方案编辑器认识
「模拟测试」——其余界面把模拟环节一律显示成「回归测试」
（见 `.scratch/domain-r1/decisions-needed.md` D-5、D-6）。
