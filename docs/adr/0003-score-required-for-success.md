# 0003 展示口径：「有分数才算成功」

Status: amended（2026-08-24，见文末 Amendment；原 Decision 原文保留）

## Context

run 可以 `completed` 但什么都没评到（线上评估环节无新会话、环节全 empty）。
若把这类 run 计入成功/均分，「从未真正跑过回归」的方案会显示 100% 通过率，
趋势图也会被无意义样本稀释。

## Decision

全站统一口径：**completed 且 score 非空才计入均分/趋势/成功数**。

- 工作台 KPI：`web/src/pages/workbench/kpi.ts:36` 均分样本 =
  `status === "completed" && r.score != null`；回归通过率的可评估终态
  （`kpi.ts:52-57`）= error 或 completed 且有分，completed 无分
  不进分子也不进分母。
- 方案详情：`web/src/pages/plan/derive.ts:31` 同一过滤；
  `derive.ts:156-161` `runBadge` 给 completed 无分的 run 中性 badge
  「完成 · 无可评估数据」——不是成功也不是失败。
- 后端配合：`app/planrun.py:648-659` run 顶层 `score` 只在存在 observe
  环节 `overall_mean` 时写入（= 各 observe 均分的均值）；空转 run 不写
  该字段，读出为 None，天然落进「无分」侧。

## Consequences

- 三处（KPI/趋势/badge）必须同步维护同一口径，任何一处单独放宽都会
  造成数字对不上。
- run 顶层 score 语义被窄化为「observe 环节综合分」；dataset/redteam
  环节的通过情况不参与顶层 score（回归通过率另行推导）。

## Amendment（2026-08-24）：成功与分数拆成两条正交口径

### 触发（两起线上误判）

- **UI-013**：纯回归方案 `plan-ca6fc20fa2bc` 跑成功（流式显示「环节 1 ·
  回归测试：完成（1.00）」、环节摘要「通过率 100%」、综合报告「唯一用例
  helpfulness 得分 0.833」），全站却显示「完成 · 无可评估数据」，综合报告
  还写「本次评估管道空转」。
- **UI-025**：run `plan-8c7b6ad3cd5d#20260824090808` 的红队环节因 DynamoDB
  PutItem 超限执行失败（`stage.error` = `ValidationException: Item size has
  exceeded the maximum allowed size`），工作台、方案详情、运行详情却全部
  绿色「完成」。

### 定性

- UI-013 是**实现漏洞，不是本 ADR 的判据冲突**：本 ADR 的意图是「空转
  run 不冒充成功」，Consequences 也早已如实记录「顶层 score 被窄化为
  observe 综合分」——但实现把「没有 observe 分」直接当成了「没有数据」，
  于是纯回归/纯红队方案（顶层 score 必然为空）被连坐。防空转的意图保留，
  实现改为按环节判定。
- UI-025 是 `stage.error` 从未参与 run 终态：顶层 status 由后端整体流程
  决定（环节内 except 被捕获后 run 仍 completed），前端只看顶层 status
  与 score，环节失败在所有列表/badge 上不可见。

### 修订后的口径（物理住所 `web/src/lib/scoring.ts`）

两条**正交**口径，消费点各取所需，不许混用：

1. **有没有分（`isScored`）**——维持原 Decision 不变：completed 且顶层
   score 非空。「线上评估均分」「分数趋势」的样本闸门。dataset/redteam
   没有可比的连续分数，**绝不编造一个分数塞进均分与趋势**。
2. **跑成功没有（`runOutcome` / `isRunSuccess`）**——按环节判定，
   优先级**不可调换**：
   1. 非 completed（running/skipped/error）→ 直接走后端 status；
   2. 有 error 环节 → 「失败 · <环节>」（全炸）或「部分失败 · <环节>」
      （尚有环节产出有效结果；badge 用既有 `badge warn`）；
   3. 有环节产出有效结果 → 「完成」+ 该环节真实指标
      （observe→均分、dataset→通过率、redteam→攻破 x/y）；
   4. 都没有 → 「完成 · 无可评估数据」（中性）。

   有效结果按环节类型：observe = completed 且 `overall_mean` 非空；
   dataset = completed 且 `pass_rate` 非空（0 也是结论）；redteam =
   completed 且 `attacks > 0`（不依赖 `verdict`，`breached = 0` 是
   「全部抵御」不是无数据）。`status = "empty"` 的环节继续落 no-data 侧
   （empty 也带 error 文本，判失败必须先排除 empty）。
   `stage_summaries` 缺失/空数组（老归档、skipped）退回顶层 score 的
   旧行为。

### 接受的代价（用户已拍板）

历史纯回归/纯红队 run 从「无可评估数据」翻成「完成」，成功数/分段等
KPI 数字会变。不为保旧数字而妥协口径。

### 同步修订的文案

- 「本次评估管道空转」只在 `runOutcome = nodata` 出现；partial/failed
  换失败提示（列明失败环节），绝不拿「空转」盖掉 `stage.error`。
- 趋势卡空态与均分 KPI 的 scope 文案改说「有分运行」，与样本闸门
  （口径 1）一致；「成功运行数」走口径 2——两个数可以合法地不相等。
