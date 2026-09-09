# 0005 调用配置自动推断：静默落库的前提是无损

Status: accepted（2026-08）

## Context

自动配置（探测 payload 模板 + 推断 response_path）可以一键完成 Agent
接入，但「自动」有两个风险：覆盖用户手工调好的配置、或在推断不确定时
写入错误配置。全自动落库和全人工确认都不理想。

## Decision

按「是否可能造成损失」分三档（`app/main.py:289-410`
`_auto_configure_agent_events`，推断在 `app/probe.py:142-212`
`infer_response_path`）：

1. **高置信 + 首次配置 → 静默落库**（outcome=saved）。
   「首次」按值判定而非按有无记录：现有配置等于出厂默认
   （模板==DEFAULT 且 path==""）即视为从未被有意配置
   （`app/main.py:385-397`）。覆盖出厂默认无损，不打扰用户。
2. **高置信 + 已有非默认配置且推断值不同 → confirm_overwrite，不落库**
   （`app/main.py:405-406`），事件附 current/proposed 供前端弹确认，
   确认后走既有 `set_agent_config` 落库。推断值与现有一致则
   outcome=unchanged（`app/main.py:399-402`），同样不写。
3. **低置信 → candidates，不落库**（`app/main.py:373-376`），
   附候选列表（`app/probe.py:211-212`，按启发式得分排序、带 preview
   与理由）人工选择。confidence=none（响应无字符串字段）按失败处理
   （`app/main.py:366-371`）。

## Consequences

- 用户手工配置永远不会被自动流程覆盖——代价是二次交互。
- 「首次」按值判定意味着：用户手工把配置改回出厂默认后，下次自动配置
  会再次静默写入（configured_by=auto）。可接受：写入值无损。
- 推断启发式（唯一字符串字段/已知响应形状/得分领先）改动会直接改变
  静默落库的边界，改 `infer_response_path` 时须连同本 ADR 复审。
