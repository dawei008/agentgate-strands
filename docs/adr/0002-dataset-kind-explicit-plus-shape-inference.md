# 0002 数据集 kind 显式归类 + 形态推断双读（零迁移）

Status: accepted（2026-08）

## Context

数据集需要分三类展示（回归/模拟/红队），但存量数据没有分类字段：
历史上红队集靠 `rt-` 命名前缀区分，多轮（模拟）集和单轮回归集混在一起。
做一次性数据迁移风险高且不可回滚。

## Decision

双轨：**写入显式、读取兜底**。

- 落库：`kind ∈ regression | redteam | simulation`
  （`app/catalog.py:235` `DATASET_KINDS`，写入校验 `app/catalog.py:264-266`）。
  新写入一定带 kind：显式传入 > 旧值 > 按命名前缀推断
  （`app/catalog.py:285-291`）。
- 后端读取兜底：存量 item 无 kind 时按 `rt-` 命名前缀推断
  （`app/catalog.py:238-241` `_infer_kind`，应用在 `app/catalog.py:253`）。
- 前端侧别双读（`web/src/lib/datasetSide.ts:12-16` `isSimulationSide`）：
  `kind==="simulation"` 显式归模拟侧（空集意图成立）；`kind==="redteam"`
  显式排除；其余按 cases 形态推断——任一用例带 `task_description`
  即归模拟侧。混合集归模拟侧并打「混合」badge
  （`datasetSide.ts:19-24` `isMixedDataset`），中性、不阻断。

## Consequences

- 零迁移：老集合不会凭空消失，历史多轮集 kind 仍为 "regression"
  但显示在模拟 tab。
- 后端与前端的推断依据不同（命名前缀 vs 用例形态），是有意分工：
  后端只需兜出 redteam，前端负责模拟/回归的表现层拆分。
- kind 与形态可能矛盾（如 kind=regression 但含多轮用例），前端以形态优先；
  该「矛盾」正是零迁移的代价，不视为脏数据。
