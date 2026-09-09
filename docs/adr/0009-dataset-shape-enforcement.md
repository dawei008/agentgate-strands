# 0009 数据集形态强制：生成端 schema 锁死 + 保存端纯度校验（存量豁免）

Status: accepted（2026-08）

## Context

ADR-0002 的双读兜底规则（含 `task_description` 用例即归模拟侧）对存量数据
是零迁移的正确解，但对**新生成的数据**变成了事故源：generate_dataset 的
prompt 硬编码「约 1/3 设为多轮用例」，回归 tab 生成的用例也混入
task_description/max_turns/persona，保存后双读规则把整个集合静默搬到模拟
tab（mm-probe 事故；用户在「测试一般常见的 coding agent 用例」场景再次撞上：
生成 1 条即带全套多轮字段）。prompt 叮嘱对模型不构成硬约束，事后归类兜底
又把形态错误放大成归类错误。

## Decision

三层闭环：**生成端 schema 锁死 → 保存端纯度校验 → 剩余场景明示不静默**。

1. **生成端 schema 锁**：generate_dataset 新增 `case_shape ∈ single|multi`
   （`app/main.py:752-769`；缺省按 kind 推，extend 模式按被追加集合的现有
   形态推断——追加不得改变集合归类侧，`app/main.py:763-769`）。按形态选
   Bedrock toolSpec 并 force_tool 强制工具调用：single 的 inputSchema 里
   **根本没有多轮字段**、multi 的 task_description/max_turns 必填，均
   `additionalProperties: false`（`app/main.py:780-806`），模型无处可放。
   tool_input 缺失时回退原文本 JSON 抽取（`app/main.py:875-889`）；兜底
   校验剥除越狱字段并计数 `stripped_fields`（`app/main.py:906-921`）。
   两参数都缺 = 老调用，保持原混合 prompt 不变（兼容）。
2. **保存端纯度校验**：`catalog.save_dataset` 在写库前校验
   （`app/catalog.py:254-264` `_shape_violation`，应用在
   `app/catalog.py:308-317`）——kind=regression 的 cases 不得带任一多轮
   字段（`app/catalog.py:244` `MULTITURN_FIELDS`），kind=simulation 的每条
   必须有 task_description，报错点名第 N 条与字段名。
   **存量豁免**：新建（名称不存在）强校验；已存在的集合只拦「本次保存会
   改变归类侧」的写入（`app/catalog.py:314-317` 双侧对比），纯编辑放行——
   存量混合集「只存不增」的既定原则。
3. **归类搬家提示**：前端生成请求按当前 tab 带 case_shape
   （`web/src/pages/resources/GenCasesForm.tsx:117`）；保存成功后按双读
   规则算集合实际归属侧，与当前 tab 不一致时渲染提示行「已保存到『模拟
   测试』tab（用例含多轮字段）」（`GenCasesForm.tsx:167-176`，展示在
   `web/src/pages/resources/DatasetsBlock.tsx:138-143/265-270`），不再
   静默搬家。新建路径已被第 2 层拦死，此提示实际只覆盖存量混合集的
   编辑/追加场景。

## Consequences

- **取代 ADR-0002 双读兜底中「混合集归模拟侧」对新数据的适用性**：新生成/
  新建的数据集不再可能是混合形态（生成端无处放、保存端拦截）。0002 的
  双读规则对**存量**数据继续有效——历史混合集仍归模拟侧、仍打「混合」
  badge、仍零迁移。
- 老调用（不带 case_shape/kind 的 generate_dataset）行为不变，混合 prompt
  保留；这是兼容窗口而非长期承诺。
- 非 Bedrock provider 经 `judgellm.converse` 的 OpenAI tool 分支同样强制
  （`app/judgellm.py:191-204`）；两侧都失败时文本兜底 + 逐条剥除仍兜住。
- mock 与真实后端同刑（`web/src/mocks/handlers.ts` 的 generate_dataset/
  save_dataset case），前端测试对三层各有断言
  （`web/tests/resources.test.tsx`「形态锁 + 归类搬家提示」组），后端
  纯度校验有独立 pytest（`tests/test_dataset_shape.py`）。

## Amendment 2026-09-07（批 badcase-backend，ADR-0017 D1）

- **校验住所搬家，口径不变**：第 2 层的纯度校验从 `catalog.save_dataset` 函数体
  抽成 `catalog._enforce_shape(name, cases, eff_kind, prev)`（存量豁免逻辑原样），
  与 `_validate_cases`（拒空 / 条数 / input）、`_build_dataset_item`（ADR-0012 体积
  预检）一起被 `save_dataset` 与新增的 `append_dataset_cases` 共用。上文引用的
  `app/catalog.py:308-317` 等行号已过期，以符号名为准。
- **实测结论：不需要放宽键集**。本 ADR 的形态校验是**多轮字段排除列表**
  （`MULTITURN_FIELDS = task_description / max_turns / persona`）加 simulation 的
  `task_description` 必填，不是键允许列表；坏例入集带的 `source` / `notes` 扩展键
  不在排除列表里，原样落库、原样读回（`tests/test_badcase_backend.py`
  `test_create_if_missing_builds_the_dataset_with_kind_and_target_agent` 钉住）。
  追加路径上多轮字段照旧被拦（同文件 `test_multiturn_field_in_regression_case_rejected_by_shape_guard`）。
- 追加只接 `regression` / `redteam`，`simulation` 拒绝——追加不得改变集合归类侧的
  原则在 append 路径上退化为「kind 必须与已存在集合一致」，由
  `append_dataset_cases` 先于形态校验拦截。
