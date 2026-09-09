# 0006 span 源人工配置——集中日志组无自动关联键

Status: accepted（2026-08）

## Context

CloudWatch Transaction Search / ADOT 会把所有服务的 span 集中写进
`aws/spans` 日志组，Agent 自己的 runtime 日志组可能是 0 字节。对真实
aws/spans 数据的侦察结论（`app/tracesource.py:110-115`，us-west-2,
2026-08-22）：span 上**没有** runtime ARN / agent 名属性，
resource.attributes 只有 service.name / service.version /
deployment.environment.name / user.id。service.name 与 AgentCore
runtime 名往往不等（如 runtime "deepseek_agent" vs
service.name "deepseek-harness"），无法程序化断言归属。

## Decision

Agent ↔ span 的映射**人工配置**，不做自动关联：

- 持久化为 DynamoDB `SPANSRC` item：{log_group, scope_filter,
  service_filter}（写入 `app/catalog.py:342-361` `set_span_source`，
  读取 `app/catalog.py:323-333`；至少一个字段非空，全空视为未配置）。
- 查询时以过滤器收窄共享日志组：`app/discovery.py:99`
  `build_span_filters` 把 scope/service 过滤拼进 Logs Insights 查询
  （`app/discovery.py:127`）。
- 自动探测只给提示、**从不落库**（probe != confirm）：runtime 组查空
  且未配置 span 源时才探测 aws/spans（`app/main.py:1477-1487`），
  `app/tracesource.py:140` `probe_central_spans` 返回 hint（候选
  service.name 列表，名字相近的打 matched 标记，
  `app/tracesource.py:173-198`），由用户在调用配置里确认保存。
- 改配置即失效会话缓存（`app/catalog.py:337-340`
  `_drop_session_caches`）——旧缓存是对旧源枚举的。

## Consequences

- 接入集中 span 架构的 Agent 多一步人工配置；作为交换，绝不会把别的
  服务的 span 算进某个 Agent 的评估。
- hint 的相近名匹配（`_normalize_name` 归一后互为子串）只影响提示排序，
  不影响任何持久化行为。
- 若 AWS 未来给 span 加上 runtime 标识属性，本决策应复审。
