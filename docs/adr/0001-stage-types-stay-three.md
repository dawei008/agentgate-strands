# 0001 环节 type 保持三类，不新增 simulation 类型

Status: accepted（2026-08）

## Context

产品拆分「回归测试」为数据集/模拟测试两个入口后（原型定案见
`/home/ubuntu/workspace/ui-prototypes/regression-split/README.md`，仓库外），
一个自然的做法是给环节（stage）加第四个 type `simulation`。但：

- 后端 per-case 分派早已工作：`app/testrun.py:621` 按用例是否带
  `task_description` 逐条切换单轮/多轮（`is_multi = bool(case.get("task_description"))`），
  多轮由 ActorSimulator 驱动（`app/testrun.py:658`），与环节 type 无关。
- 新 type 会产生历史数据双读问题：存量方案的环节全是三类，读取路径全部要兼容。
- 混合集（同一数据集内多轮/单轮用例并存）与「环节持有单值 type」的基数不符：
  一个 dataset 环节指向的集合可以同时含两种形态用例。

## Decision

环节 type 固定三类：`observe | dataset | redteam`（`app/plan.py:36`
`STAGE_TYPES`，校验在 `app/plan.py:86`）。模拟测试是**表现层第四类**：
`web/src/pages/plan/PlanEditor.tsx:25` 定义
`StageUiKind = StageType | "simulation"`，添加按钮四个
（`PlanEditor.tsx:269`），但落库时模拟卡产出 `type:"dataset"`
（`PlanEditor.tsx:34-36` `stageStorageType`，卡渲染分支
`PlanEditor.tsx:498` 以 `type === "dataset" && uiKind === "simulation"`
判定）。显示侧靠数据集归类双读（见 ADR-0002）还原成模拟卡。

## Consequences

- 后端零改动、历史 run 与方案零迁移。
- UI 需要一个瞬态标记（`PlanEditor.tsx:92` `_ui`）区分「刚添加还没选集合」
  的模拟卡；保存前剥除。
- 未来若模拟测试需要环节级独有配置（如轮次上限落在环节而非用例上），
  需重新审视本决策。
