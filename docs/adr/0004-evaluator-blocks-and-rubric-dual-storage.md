# 0004 评估器 blocks 与 rubric 双存，rubric 是唯一真相

Status: accepted（2026-08）

## Context

自定义评估器的表单是结构化的（goal/checks/bands 分块），但 judge 消费的
是一个 rubric 字符串。只存 rubric 则编辑时无法回填表单；只存 blocks 则
后端要负责拼装模板，前端改版会牵连打分行为。

## Decision

两者都存，职责分明：

- `rubric` 字符串是 judge 消费的**唯一真相**：
  `app/registry.py:141` 自定义评估器解析为
  `OutputEvaluator(rubric=custom_rubrics[n], ...)`，后端从不读 blocks
  参与打分。
- `blocks` 是前端表单的结构化源数据，后端只存取不解释
  （`app/catalog.py:200-221` `create_custom_evaluator`，序列化存
  `app/catalog.py:219-220`）。
- 防脱节规则：原始文本模式保存时传 `blocks=None`，此时**不保留**旧
  blocks（`app/catalog.py:204-207` docstring 明确「留着会和新 rubric
  脱节」）。前端对应：`web/src/pages/resources/EvaluatorForm.tsx:80`
  原始模式下 `blocks = null`；回填分支 `EvaluatorForm.tsx:20-21`
  有 blocks 走分块模式、无 blocks 走原始文本模式。

## Consequences

- 用原始文本模式改过一次的评估器永久失去分块回填（除非重新用分块模式
  保存）——这是有意为之，宁可丢表单便利也不给用户看一份和实际 rubric
  不一致的结构化视图。
- 拼装逻辑（blocks → rubric 文本）只活在前端；后端打分与前端表单实现
  解耦。
