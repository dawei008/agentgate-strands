# Payload 契约（评估 Runtime）

**权威是 `app/main.py` 的 action 分派，本文是索引。**

实测说明（2026-09-07 按 `app/main.py` 现数）：后端显式分派 62 个 action
（`action == "…"` 57 个 + `action in (…)` 元组 9 个，其中 5 个与前者重叠；
批 badcase-backend 加了 `append_dataset_cases` / `annotate_case` / `list_annotations` 三个，
批 topology-backend 加了 `agent_topology` 一个，批 compare-backend 加了 `compare_sessions` / `pair_rows` 两个），
另有 `evaluate` 走末尾默认分支。本文只展开其中常用的一部分（下面三节 +
两张表 + 「坏例入数据集与人工标注」节 + 「会话并排对比」节）；下列 32 个 action 本文未展开（agent_status / fleet_status / agent_topology 已在本文单独成节），用法以 `app/main.py` 为准：
`adopt_run_advice`、`auto_configure_agent`、`delete_dataset`、`diagnose_session`、
`estimate_redteam_run`、`estimate_test_run`、`generate_dataset`、
`generate_redteam_cases`、`get_agent_config`、`get_redteam_run`、`get_reviews`、
`get_source_url`、`get_span_source`、`get_test_run`、`list_datasets`、
`list_redteam_runs`、`list_test_runs`、`probe_agent_invoke`、`reap_stale_runs`、
`redteam_options`、`redteam_target_spec`、`resume_plan_run`、`save_dataset`、
`sessions`、`set_agent_config`、`set_agent_meta`、`set_review`、`set_span_source`、
`start_redteam_run`、`start_test_run`、`stop_plan_run`、`upload_case_image`。

所有响应均为 SSE 事件流，每个事件是带 `event` 字段的 JSON。

## `{"action": "discover", "refresh": false}`
返回一个 `agents` 事件：READY 状态的 Agent 列表（名称、ARN、描述、
是否有运行日志 `has_logs`）。

```json
{"event": "agents", "region": "us-west-2", "agents": ["…"],
 "from_cache": true, "refreshed_at": 1788249600,
 "catalog_refresh": null}
```

**目录缓存**：Agent 目录持久在 catalog 表 AGENT 分区（DDB），`refreshed_at` = 上次扫描的
epoch 秒（**数字**），`from_cache: true` = 这次没扫、原样回的。`refresh: true` 强制重扫并
重写（页面「重新扫描」按钮）。

**超龄自动重扫**（`catalog.CATALOG_MAX_AGE_SECONDS` = 24 h，与首页观测窗口同数）：缓存年龄
超过它 ⇒ 本次 discover **同步**重扫一次再返回（refresh_agents = ListAgentRuntimes +
DescribeLogGroups 各一轮分页 + DDB 批写，无 Logs Insights；实测 32 个 Agent 0.2–0.5 s）。
结果写在 `catalog_refresh`：

| 情形 | `from_cache` | `refreshed_at` | `catalog_refresh` |
|---|---|---|---|
| 未超龄 / `refresh: true` / 分区为空首扫 | 照旧 | 照旧 | `null` |
| 超龄，重扫成功 | `false` | 本次时刻 | `{"attempted": true, "ok": true, "error": null}` |
| 超龄，重扫抛错 | `true`（**回旧目录，不报错**） | 旧时刻 | `{"attempted": true, "ok": false, "error": "<原话前 200 字>"}` |
| 超龄，上次失败后 300 s 防抖期内 | `true` | 旧时刻 | `{"attempted": false, "ok": false, "error": "<上次原话>"}` |

失败必须在响应里看得见：否则「四天不刷」（issue fleet-cache-never-expires，现网 2026-09-08
「缓存于 2026-09-04 08:52 UTC」）只会变成「四天自动重扫一直失败而没人知道」。前端按
`refreshed_at` 自算年龄，超过 24 h 才出「超窗」文案，`catalog_refresh.error` 非空时后接原话。
`fleet_status` / `agent_status` 的 Agent 集合读的是**同一份**目录缓存（不自己重扫、不回写）。

## `{"action": "evaluators"}`
返回可选评估器清单与默认值。

## `{"action": "evaluate", ...}`

```json
{
  "action": "evaluate",
  "agent_names": ["obsDemo_obs_demo"],
  "max_sessions": 5,
  "lookback_days": 7,
  "evaluators": ["helpfulness", "tool_selection_accuracy"],
  "judge_model": "global.anthropic.claude-sonnet-5"
}
```

除 `agent_names` 外均可省略（上面即默认值）。事件流：
`start` → 每 Agent `agent_start` → 每会话 `session_start` /
`heartbeat`(15s) / `session_result`|`session_error` → `agent_summary`
→ 最终 `report`（每评估器 mean_score / pass_rate）。

可选评估器：`coherence` `conciseness` `faithfulness` `goal_success_rate`
`harmfulness` `helpfulness` `instruction_following` `refusal`
`response_relevance` `stereotyping` `tool_parameter_accuracy`
`tool_selection_accuracy`，以及任意已创建的自定义评估器名。

可选指标（`metrics` 字段，从 trace 直接计算、零 judge 成本，默认全开）：
`tokens` `cost` `latency` `llm_calls` `tool_calls`。
`latency` 口径为按 trace（一次请求→响应）的端到端耗时，报平均/最大/轮数。

## 方案与运行（方案中心的核心动作）

| action | 说明 |
|---|---|
| `list_plans` | `{agent_name?}` 全部/某 Agent 的方案列表 |
| `save_plan` | `{plan}` 新建或更新（校验环节结构、定时必带 budget_usd）；返回 `plan_saved`，定时同步失败不算保存失败（带 `schedule_error`） |
| `delete_plan` | `{plan_id}` 删除方案 + 其定时任务；run 历史保留 |
| `estimate_plan_run` | `{plan_id}` 分环节成本预估（UI 内置在表格里，运行前不弹窗） |
| `run_plan` | `{plan_id, triggered_by?}` 顺序跑全部环节，流式事件：`plan_run_started` → 各环节 `stage_start/…/stage_done` → `plan_run_report`；环节失败不中断后续；定时触发超预算发 `plan_run_skipped` |
| `list_plan_runs` | `{plan_id}` 该方案的 run 历史（新→旧） |
| `list_recent_runs` | `{limit?, agent_name?}` 跨方案 run 流（评估台首页 / Agent 详情共用） |
| `get_plan_run` | `{run_key}` 摘要 + S3 全文报告 |
| `set_proposal_adopted` | `{run_key, index, adopted}` 标记改进稿已采纳，下次 run 总览自动对比分数 |
| `propose_improvements` | `{agent_name, sessions, run_key?}` 从报告证据生成提示词修改稿 |
| `get_judge_config` / `set_judge_config` | judge 模型配置：Bedrock 或 OpenAI 兼容端点（`app/judgellm.py`，API key 只存 Secrets Manager `eval-anything/` 前缀）；set 时先发 1-token 探测 |

## 只用上报数据评估（ADR-0019 批 1）

评估计划字段 `trace_required: bool`（界面文案「只用上报数据评估」）。**默认开**（2026-09-08 用户决定；此前批 1
是缺键 = 关）：唯一读法是 `app/plan.py:trace_required(plan)`——缺键 / `null` ⇒ `true`，**只有显式 `false` 才关**；
`save_plan` 落盘与 `list_plans` / `get_plan` 读回都经它归一，所以读侧恒给 bool，老方案 data 里没有这个键的也读回
`true`（旧数据本身不改，不回填）；`planrun` 四处读开关同走这一函数。前端请求体两态都**显式带键**（关着不带键会被读成开）。
后果：所有回归 / 红队 / 模拟环节默认多一次 ≤135 s 的 span 核对等待，未上报 span 的 Agent 用例全部记 `no_trace`
不入分母（Agent 未接观测 ⇒ run 状态 `no_trace`、不出分）；要按 SDK 返回评分必须在方案里显式关。开着时，回归 / 红队环节结束后
`planrun` 按会话 id 核对 **Agent 侧、带对话内容** 的 span（`tracesource.check_agent_traces`：主 span 组 →
`fallback_log_group`；Agent 侧 = `service.name` 等于配置的 `service_filter`，没配则 ≠ 平台自家
`<RUNTIME_NAME>.DEFAULT`；带内容 = **attributes 里有 `tracesource.CONTENT_ATTRS` 之一，或 inline events 里有 `tracesource.CONTENT_EVENT_NAMES` 之一** —— 两派埋点分别把对话放在属性和 span 事件里，判据 `tracesource.build_content_predicate()` 同时认这两处，差异见 ADR-0019「内容判据：attributes 或 inline events」）。**关着时下面所有键都不出现**，
形状与此前逐字节相同。

**每条结果行**（回归 `report.results[]` / 红队 `report.results[]`）多一个 `trace`：

```json
{"trace": {"status": "no_trace", "reason": "no_content", "spans": 2,
           "sources": ["aws/spans", "/aws/bedrock-agentcore/runtimes/x-DEFAULT"]}}
```

| 键 | 口径 |
|---|---|
| `status` | `ok` \| `no_trace`。`no_trace` 行**不打分、不算 0 分、不入 pass_rate / evaluator_stats 分母**（`testrun.is_no_trace` 是唯一判据），其判定仍留在 `results` 上但界面不显示；红队行按剔除后重算环节级 `breached` / `breach_rate` / `verdict` |
| `reason` | `ok` 时 `null`；否则五选一：`no_span`（查过的组里一条 Agent 侧 span 都没有）/ `no_content`（有 span 但 attributes 与 inline events 里都没有 gen_ai 对话内容）/ `no_span_source`（没有可读的 span 组）/ `fetch_error`（查询故障）/ `unsampled`（平台自己这次调用的 trace 未采样 ⇒ Agent 侧整条丢弃；**不并进** no_span） |
| `spans` | 各来源里该行会话的 Agent 侧 span 数之和（红队行 = 全部 `session_ids` 之和） |
| `sources` | 真去查过的日志组（主组 + 回退组）；`no_span_source` 时 `[]` |
| `sampled` | 可选：回归行在调用前读到的平台采样位（见下文「span 源与回退」的采样段；`testrun.current_trace_sampled()` 是唯一读数）。核对**不抹**这个键，且这一行的 `unsampled` 判定优先用它，没有（红队行 / 缓存命中）才用环节级读数；缺测（本地无 OTel）整键缺失 |

红队行多会话（`session_ids` 每次 backtrack 轮换一个）：全部会话都有内容 span 才 `ok`，`reason` 取第一个不 ok 的。

**run / 环节 / 摘要**（testrun 的 run 对象、`_run_*_stage` 返回值、`_stage_summary` 三处同键）：

```json
{"trace_summary": {"required": true, "ok": 2, "no_trace": 1}, "trace_status": "degraded_no_trace"}
```

| 键 | 口径 |
|---|---|
| `trace_summary.ok` / `no_trace` | 行数；`required` 恒 true（缺整个键 = 没开开关） |
| `trace_status` | `ok` \| `degraded_no_trace`（≥1 行缺）\| `no_trace`（全部缺） |
| `status` | 全部缺且原状态是 `completed` ⇒ 改成 `no_trace`（run 与环节同步；stopped / halted_cost / failed 优先不覆盖）。前端 `isStageEffective` 对它为 false ⇒ 落「无可评估数据」侧，头部 badge 说明原因 |

环节一行文案（overview.stage_lines）：降级尾巴「（N 例无 trace 未计）」；全缺「N 个用例 / 次攻击，CloudWatch 里没有 Agent 上报的 trace，未评分」。
等待预算 `planrun.TRACE_CHECK_BACKOFF = (0, 45, 45, 45)`（累计 135 s，依据 Insights 可见性 78~116 s），首查全到位只付一次查询。

**批 2（ADR-0019「批 2 口径」）：回归用例的评分输入切到 span 还原的对话。** 开着开关时，回归环节先把全部用例调用完、
一次核对、再只给 `trace.status == ok` 的行评分（`testrun.execute_test_run(trace_mark=…)`；no_trace 行**不判分、不花 judge 钱**，
行上没有 `results`）。判了分的回归用例条目多三键：

```json
{"scored_from": "trace", "output": "trace 还原的最终回复（截 4000 字）",
 "output_response": "InvokeAgentRuntime 返回的原文（截 4000 字）", "response_matches_trace": false,
 "trace": {"status": "ok", "reason": null, "spans": 10, "sources": ["aws/spans"],
           "span_ids": ["b49623aae3237a37", "6a98ebb65cf08367"]}}
```

| 键 | 口径 |
|---|---|
| `scored_from` | `trace` \| `response`（`testrun.SCORED_FROM_*`）。批 2 里开着开关且判了分的行恒 `trace`；`response` 是枚举保留值，批 2 不出现（没有回退到返回的路径）。**关着开关 / 老 run / 没判的 no_trace 行整键缺失** |
| `output` | 按 trace 评分的行：trace 还原的最终回复（结束最晚的 invoke_agent 的 agent_response，`tracesource.scoring_input_from_session`）；report 与 run 级解析读的就是它。没判的行仍是返回原文 |
| `output_response` | 原返回（供对照）；只在 `scored_from` 存在时出现 |
| `response_matches_trace` | 返回与 trace 还原的最终回复归一空白（连续空白折一、两端去）后是否逐字相等（`testrun.same_text`）；不一致**不改判**，以 trace 为准，前端只在格 title 上点明 |
| `trace.span_ids` | 批 2 新增的第五键，只在按 trace 判过分的行上：贡献了评分输入的 span id（去重、按时间线序、最多 `TRACE_SPAN_IDS_MAX = 40` 条） |
| `trace.reason = no_content` 的新成因 | 核对说有内容 span，但按会话取回的记录还原不出最终回复（只有工具 / chat span、invoke_agent 没露面）⇒ 评分阶段改标 `no_content`，run 的 `trace_summary` / `trace_status` 随之重算（`testrun.summarize_trace`）；取数查询出错 ⇒ `fetch_error` |

simulation 类多轮用例：judge 看的整段对话也从 span 还原（`[用户] … / [助手] …`）；`conversation` 仍是驾驭出来的记录
（模拟用户下一句按返回决定）；`output` / `output_response` 是最后一轮的 trace 回复 / 返回。多轮**顺序按调用配对**
（批 3 起，`tracesource.invocation_turns`）：每个 invoke_agent span 出一对「用户 → 助手」，按 span 起止时刻排序 ——
扁平时间线把助手锚在 span 结束，下一轮在上一轮回复结束前开始时会把对话穿插（现网实测有，见 ADR 批 3 第 8 条）。
`tool_evidence` 与评分出自同一次 fetch（`toolevidence.graft` 嫁接同一份 Session），不再走 14 s 退避那条路。
第一阶段被停止 / 熔断的 run 不核对不评分：行上无 `trace`，环节结束后 planrun 照批 1 补核对（只补 `trace_summary` 缺失的 run）。

**批 3（ADR-0019「批 3 口径」）：红队攻击行的评分输入切到 span 还原的整段对话。** 开着开关时，红队环节先把全部攻击
跑完（驾驭仍用调用返回）、一次核对、再只给 `trace.status == ok` 的攻击行判分
（`redteam.execute_redteam_run(trace_mark=…, trace_restore=…)`；no_trace 与三类无结论的行**不判分、不花 judge 钱**）。
判了分的攻击行多三键（键名与批 2 同名同义）：

```json
{"scored_from": "trace",
 "conversation": [{"role": "attacker", "content": "…"}, {"role": "target", "content": "trace 还原的这一轮回复"}],
 "conversation_response": [{"role": "attacker", "content": "…"}, {"role": "target", "content": "调用返回的这一轮回复"}],
 "response_matches_trace": false,
 "trace": {"status": "ok", "reason": null, "spans": 9, "sources": ["aws/spans"],
           "span_ids": ["b49623aae3237a37"]}}
```

| 键 | 口径 |
|---|---|
| `scored_from` | 同回归行的枚举（`testrun.SCORED_FROM_*`）。开着开关且判了分的攻击行恒 `trace`；**关着开关 / 老 run / 没判分的行整键缺失** |
| `conversation` | 按 trace 判过分的行：span 还原的整段对话（judge 看的就是它；每轮正文截 2000 字，形状不变）。没判分的行仍是驾驭出来那份 |
| `conversation_response` | 驾驭那份（调用返回）；只在 `scored_from` 存在时出现。**红队行没有 `output_response`** —— 它本来没有 `output`，返回侧的住所只能是这个键 |
| `response_matches_trace` | 两侧**逐轮**被测回复归一空白后是否逐字相等（`testrun.same_text`；轮数不同即不一致）。不一致**不改判**，以 trace 为准，前端只在格 title 上点明 |
| `trace.span_ids` | 同回归行：贡献了这段对话的 span id（去重、按会话序再按调用序，最多 `TRACE_SPAN_IDS_MAX = 40` 条） |
| `silenced` / `target_unreachable` / `attacker_declined` | **判据仍是返回侧**（`conversation_response`）：空响应标记与调用失败标记只存在于返回里，拿 trace 对话去判会把「全程没说话」读成有效结论。这三类行也不判分 |
| no_trace 攻击行的 `score` / `breached` | 未判的占位（`0.0` / `false`），`reason` 是中文一句「…未按 trace 判分…」。唯一判据是 `trace.status`（`testrun.is_no_trace`）；环节级 `breached` / `breach_rate` / `verdict` 按剔除后重算（批 1 口径） |

多轮拼接：一行攻击的多个会话（`session_ids`，每次 backtrack 轮换一个）按该列表顺序拼接；**任一会话取不到 / 还原不出**
⇒ 整行改标 `no_trace`（`no_content`，取数查询出错则 `fetch_error`）—— 半场对话不交给 judge。第三阶段判分本身失败
（judge 限流）⇒ 该行归 `errored`（既不是攻破也不是守住，口径同判官限流的老行为）。全部攻击 no_trace ⇒ run 与环节
`status = no_trace`、`verdict = INCONCLUSIVE`。

## `{"action": "agent_status", "agent_name": "..."}`

Agent 详情「现状（观测）」区的数据源（ADR-0016 ①）。**只读**（tests/test_agent_status.py
钉「不写库」）；单事件响应；`window_hours` 可选，默认 24，`refresh: true` 绕过缓存。算不出的项
一律 `null`，原因写在 `unavailable_reason[<字段路径>]`，不编数。`agent_name` 不存在 ⇒ 错误帧
`Agent '<name>' 不存在`（该判定在读缓存**之前**，错误帧不受缓存影响）。

```json
{"event": "agent_status", "agent_name": "support-bot", "window_hours": 24,
 "metrics": {
   "sessions":          {"value": 4812, "prev": 4530, "delta": 282},
   "p95_latency_ms":    {"value": 3400, "prev": 3700, "delta": -300},
   "agent_cost_usd":    {"value": 41.6,  "prev": 38.5,  "delta": 3.1},
   "blank_rate":        {"value": 0.018, "prev": 0.014, "delta": 0.004},
   "tool_failure_rate": {"value": 0.026, "prev": 0.035, "delta": -0.009}},
 "hourly": [{"hour": "2026-09-02T07:00Z", "sessions": 173}, {"hour": "2026-09-02T08:00Z", "sessions": 190}, "… 共 24 桶"],
 "span_origin": "central",
 "last_run": {"run_key": "plan-…#2026…", "plan_id": "plan-…", "plan_name": "…",
              "status": "completed", "observe_mean": 0.86, "dataset_pass_rate": 0.9444,
              "redteam_blocked": "10/12", "finished_at": "2026-09-02 07:12 UTC"},
 "alerts": [{"kind": "evaluator_below_target", "plan_id": "plan-…", "plan_name": "…",
             "evaluator": "回答完整性", "target": 0.7, "streak": 4,
             "values": [0.69, 0.68, 0.66, 0.67], "since_run": "plan-…#1", "until_run": "plan-…#4"}],
 "next_run": {"plan_id": "plan-…", "plan_name": "…", "at": "2026-09-08T07:00:00Z", "budget_usd": 6.0},
 "cloudwatch_url": "https://us-west-2.console.aws.amazon.com/cloudwatch/home?region=us-west-2#logsV2:log-groups/log-group/$252Faws$252Fbedrock-agentcore$252Fruntimes$252F…",
 "unavailable_reason": {"last_run.dataset_pass_rate": "多个回归环节，摘要项无 judged_cases 无法合并"},
 "cached": false, "cache_age_s": 0}
```

**`metrics`**：五个数各按「近 `window_hours` 小时」与「其前一个同长窗」算一次，
`delta = value - prev`（任一侧 null 则 delta null）。数据源 = 该 Agent span 组
（runtime 日志组，或 `set_span_source` 配的 aws/spans + 过滤）上的**一次** Logs Insights
查询（`agentstatus.build_status_query`，逐 span 一行、最多 10000 行，排除 `evaltest`
会话），本地聚合；窗口归属按 span 开始时间。行数达到 10000 / 查询超时或失败 / 没有
span 组 ⇒ 五个数全 null，原因各一句。主源是 `aws/spans` 且查到 0 行时会再查一次
**该 Agent 专属 runtime 组的 `spans` 流**（见下「span 源与回退」），读到哪个组由
`span_origin` 如实报出。

| 数 | 口径 | 现网实测（2026-09-03，tauairline_agentfable5 日志组 400 行） |
|---|---|---|
| `sessions` | 窗内出现过 span 的 `attributes.session.id` 去重数 | 能算 |
| `p95_latency_ms` | 每条 trace（一次请求→响应）min(start)→max(end) 的端到端耗时，nearest-rank P95；窗内无 trace ⇒ null | 能算（`startTimeUnixNano`/`endTimeUnixNano` 全行可读） |
| `agent_cost_usd` | 被测 Agent 自身模型花费（不含 judge）：与线上评估环节**同一份** `metrics.compute_session_metrics`（provider span → strands chat span 单层计数，不叠 invoke_agent 聚合；仅聚合层带 usage 时退到聚合层）× `pricing` 单价；prompt-cache 读/写 token 单独计（见「成本字段」节）；窗内有任何未定价模型 ⇒ null + 模型名 | 能算（`gen_ai.request.model` 231/400、usage 193/400，provider 与 chat 两层都在；dsh harness 的 chat span 另带 `gen_ai.usage.cache_read.input_tokens` / `cache_write.input_tokens`，2026-09-04 实拉） |
| `blank_rate` | 空响应会话占比（CONTEXT.md「空家族」）：会话最后一次 `invoke_agent` span 的 `gen_ai.usage.output_tokens == 0`，或 `finish_reasons` 含 content_filtered；分母 = 有 invoke_agent span 的会话数，为 0 ⇒ null | 能算，但生效判据只有 output_tokens==0：Strands tracer **不写** `gen_ai.response.finish_reasons`（0/400 行） |
| `tool_failure_rate` | `execute_tool` span 中 `status.code == ERROR` 或 `gen_ai.tool.status ∈ {error, failed, failure}` 的占比；窗内无工具调用 ⇒ null | 能算（`gen_ai.tool.status` 19/19 工具 span 有值，现网只见 `success`；失败值按 Strands 约定） |

**`hourly`**：近 `window_hours` 小时窗 `[now − 24h, now)` 等分成 24 个 1h 桶的会话量，
`hour` = 桶起点（UTC，分钟精度；窗起点非整点时标签也非整点，桶严格是窗的等分）。每个会话
只归**它在窗内最早一条 span 的开始时间**所在的桶（跨小时的会话不重复计）⇒
`sum(hourly[*].sessions) == metrics.sessions.value`；无数据桶 `sessions: 0`。与五个数**同一次**
Logs Insights 查询本地分桶，不多发查询；五个数全 null 的三种情形（截断 / 查询失败 / 无 span 组）
下 `hourly: []`，原因在 `unavailable_reason.sessions`。

**`last_run`**：该 Agent 最近一次**已结束**的 run（`list_recent_runs` 去掉 running），
没有 ⇒ null。`observe_mean` = run 顶层 score（各 observe 环节 overall_mean 的均值，
CONTEXT.md 分数家族）；`dataset_pass_rate` = 唯一一个已完成 dataset 环节的 pass_rate
（多个 ⇒ null + 原因；没跑回归 ⇒ null 无原因）。**没有 X/Y 这一栏**：摘要项只存
pass_rate/cases/blank_cases，分母 judged_cases 只在 S3 全文里，`cases` 含空响应与调用失败
用例不能冒充分母 ⇒ 只出 pass_rate。（2026-09-08 前这里还回一个恒 `null` 的 `dataset_pass`
字段 + 一条它专属的 `unavailable_reason["last_run.dataset_pass"]`，两者都已删：前端那条
reason 结构上取不到 —— `dataset_pass_rate` 非 null 时不看 title，为 null 时另一条 reason
先命中。）`redteam_blocked` = "(attacks−breached)/attacks"，没跑红队 ⇒ null。

**`alerts`**：只有一种 `evaluator_below_target`——同一计划最近**连续** ≥3 次
`status == completed` 的 run 里，某评估器（observe 环节 `summary[*].mean_score` /
dataset 环节 `evaluator_stats[*].mean`）都低于目标线；一次达标或该评估器缺席即断。
目标线 = `diagnosis.LOW_SCORE_THRESHOLD`（0.7，与 needs_diagnosis / 前端 TREND_TARGET
同一条线）——计划对象目前没有 threshold 字段。`values` 旧→新，`since_run`/`until_run`
为流的两端。没有 ⇒ `[]`。

**`next_run`**：该 Agent 带定时的计划里最早的一次。`cron(…)` 用与前端 cronEngine 同语义
的本地推算（日/周都非 `*` 取或；L/W/# 不支持；一年内无触发 ⇒ at null）；`rate(…)` 的
相位由 EventBridge 创建时刻决定 ⇒ `at: null` + `unavailable_reason["next_run.at"]`。
`at` 是 cron 时刻，实际触发落在其后 60 分钟弹性窗内（plansched FlexibleTimeWindow）。
没有定时计划 ⇒ null。

**`cloudwatch_url`**：CloudWatch 控制台该 span 组（日志组）页的深链；没有 span 组 ⇒ null + 原因。

**缓存**：与 `fleet_status` / `agent_topology` 同款（同一份 `app/ttlcache.py`）—— 5 分钟**进程内**
（Lambda 热实例），键 `(agent_name, window_hours)`；命中返回原结果 + `cached: true` +
`cache_age_s`（距原次计算的整秒数，未命中恒 0）；`refresh: true` 绕过并覆盖。
缓存由 `agentstatus.build_status` 写入，而 `fleet_status` 逐 Agent 调的就是 build_status ⇒
**舰队页算过的 Agent，紧接着点进详情页是命中**，不再重跑那条 Insights 查询（现网实测那次
查询 8.9 s）。反之不成立：`agent_status` 只填这个键，不产出舰队汇总。
`fleet_status` 里逐 Agent 的对象形状不变——`cached` / `cache_age_s` 只加在 `agent_status`
的顶层（`fleetstatus._degraded_status` 的占位对象不经 build_status，也就不会进缓存）。

成本：一次未命中 = 1 条 Logs Insights 查询（48h 扫描量按现网 30 天 6.3 MB 折算 ≈ 0.4 MB，
$0.005/GB ⇒ 远低于 0.001 USD）+ DynamoDB 读（PLANRUN 分区投影读 ≤500 条、PLAN 分区、
PRICE 分区、SPANSRC 单读）。零写。

## `{"action": "fleet_status"}`

首页（ADR-0016「舰队级」，观测视角）的数据源：一次调用拿全所有 Agent 的现状 + 舰队汇总
+ 待处理条。**只读**（tests/test_fleet_status.py 走 main.invoke 全程钉「DDB 写方法与 S3 put
零调用」）；单事件响应；`window_hours` 可选默认 24，`refresh: true` 绕过缓存。

```json
{"event": "fleet_status", "window_hours": 24,
 "computed_at": "2026-09-03T08:00:00Z", "generated_at": "2026-09-03T08:00:00Z",
 "cached": false, "cache_age_s": 0,
 "agents": [ "…每个 Agent 一份与 agent_status 完全同形的对象（含 hourly），按 discover 的顺序" ],
 "fleet": {"agents": 6,
           "sessions":     {"value": 18420, "prev": 17690, "delta": 730},
           "cost_usd":     {"value": 126.2, "prev": 118.9, "delta": 7.3},
           "worst_p95":    {"agent_name": "billing-bot", "value_ms": 5200},
           "anomaly_rate": {"value": 0.019, "prev": 0.012, "delta": 0.007},
           "hourly": [{"hour": "2026-09-02T08:00Z", "sessions": 812}, "… 共 24 桶"]},
 "todo": [{"kind": "tool_failure_spike", "layer": "observe", "agent_name": "billing-bot",
           "fact": "工具失败率 5.1%（前一日 1.9%）", "action": "view",
           "target": {"plan_id": null, "run_key": null}},
          {"kind": "run_failed", "layer": "observe", "agent_name": "support-bot",
           "fact": "「周一巡检」最近一次运行失败（2026-09-03 07:00 UTC）：Bedrock ThrottlingException",
           "action": "view", "target": {"plan_id": "plan-…", "run_key": "plan-…#2026…"}},
          {"kind": "evaluator_below_target", "layer": "evaluate", "agent_name": "support-bot",
           "fact": "「周一巡检」回答完整性 连续 4 次低于 0.7（最近 0.67）", "action": "view",
           "target": {"plan_id": "plan-…", "run_key": "plan-…#4"}}],
 "unavailable": {"ops-bot": {"sessions": "该 Agent 没有 runtime 日志组，也未配置 span 源", "…": "…"}}}
```

**`agents`**：Agent 集合 = `discover` 的口径（catalog 缓存优先，无缓存时现扫，不回写）。
每项由 `agentstatus.build_status` 产出，与单独调 `agent_status` 的返回**除 `cached` /
`cache_age_s` 两个缓存字段外逐字段相同**（tests 逐 Agent 断言相等，且断言那次 `agent_status`
命中缓存、不再发查询 —— 两者是同一个 build_status 缓存键）。某个 Agent 计算抛异常 ⇒ 该项仍在（metrics 全 null、
`hourly: []`、`alerts: []`、`unavailable_reason.agent_status` 写原因），条数恒等于 Agent 数。

**`fleet`**：只算得出数的 Agent（值为 null 的 Agent 不进分子也不进分母，可在 `unavailable`
里逐个看到）——
`sessions` / `cost_usd` = 各 Agent `metrics.sessions` / `metrics.agent_cost_usd` 的 value、prev
分别相加，`delta = value − prev`（任一侧无数 ⇒ null）；
`worst_p95` = `metrics.p95_latency_ms.value` 最大的 Agent 与其值（都 null ⇒ 两项 null）；
`anomaly_rate` = **(空响应会话数 + 工具失败 span 数) / 会话数**，三个计数先跨 Agent 相加再除
（比率不能相加）——空响应会话 = `blank_rate` 的分子（会话最后一次 invoke_agent 输出 0 token），
工具失败 span = `tool_failure_rate` 的分子（`execute_tool` 且 status ERROR / tool.status ∈
{error, failed, failure}），会话数 = `sessions` 的口径；prev 按前一窗同算；会话数 0 ⇒ null。
分子混了两种单位，是「每 100 个会话里有几件坏事」的粗读数，不是概率；
`hourly` = 各 Agent `hourly` 逐桶相加（所有 Agent 用同一个 now ⇒ 桶标签一致）；
全部 Agent 无 hourly ⇒ `[]`。

**`todo`**：产生规则写死，不含可调阈值——

| kind | layer | 产生条件 | fact | target |
|---|---|---|---|---|
| `tool_failure_spike` | observe | `metrics.tool_failure_rate`：value ≥ 2 × prev **且** value ≥ 0.02（prev 为 0 时只剩绝对门槛；prev 为 null 不产生） | `工具失败率 X%（前一日 Y%）` | 两项 null |
| `blank_spike` | observe | `metrics.blank_rate` 同上两条 | `空响应率 X%（前一日 Y%）` | 两项 null |
| `run_failed` | observe | `last_run.status ∈ {error, failed}`（最近一次已结束 run） | `「<计划名>」最近一次运行失败（<finished_at>）：<error 前 80 字>` | 该 run 的 plan_id / run_key |
| `evaluator_below_target` | evaluate | `alerts` 逐条映射（规则见 agent_status 小节） | `「<计划名>」<评估器> 连续 N 次低于 0.7（最近 v）` | plan_id / `until_run` |
| `budget` | observe | **本版不产生**：计划对象唯一的预算字段 `schedule.budget_usd` 是**单次运行**上限（定时触发前估算 > 它即跳过，`main.py` run_plan），没有月度预算字段，「月度花费 ≥ 上限 90%」无分母可比；kind 保留给有月度预算字段之后 | — | — |

`action` 本版全部为 `view`（`run` / `adopt` 是付费 / 落库动作，待处理条不替用户决定）。
排序：`layer` observe 在 evaluate 前；同层按上表 kind 顺序；再按 `agent_name`。

**`unavailable`**：`{<agent_name>: <该 Agent 的 unavailable_reason>}`，只列非空的 Agent；
键与 `agent_status` 的 `unavailable_reason` 完全一致（五个数 / cloudwatch_url / last_run.* /
next_run.at / 计算异常时的 `agent_status`）。

**取数与并发**：PLANRUN 分区（≤500 条投影读）与 PLAN 分区各**读一次**，按 Agent 分发
（每 Agent 取最近 100 条 run，与单独调 agent_status 同口径）；每 Agent **一次** Logs Insights
查询，线程池并发上限 **8**（`fleetstatus.MAX_CONCURRENCY`）。最坏延迟 ≈ ⌈Agent 数 / 8⌉ ×
单次查询超时 60 s（`discovery.QUERY_TIMEOUT_SECONDS`）+ DDB 读；现网 6 个 Agent 一波并发，
上限 ≈ 61 s。**CloudFront 到 Runtime 的源读超时也是 60 s**（`infra/stacks/ui_stack.py`），
全部查询同时打满超时的极端情形会在边缘 504 —— 正常情形 Insights 查询数秒内返回。

**缓存**：5 分钟**进程内**缓存（Lambda 热实例，实现 `app/ttlcache.py`，三处 action 同一份），
按 `window_hours` 分键；命中时返回原结果并
`cached: true`、`cache_age_s` = 距原次计算的整秒数（未命中恒 0）；`computed_at` 是五个数**真正算出来
的时刻**（命中时不变，前端「数据时刻」用它），`generated_at` 同值（老键名，保留给现有前端）；
`refresh: true` 绕过并覆盖。不写 DDB 缓存项：catalog 表是单表设计，缓存项与业务项同一张表，
写它就是对业务表的 put_item，与「零写」相冲。

⚠️ 首页「缓存于 …」那行文案**不是**本 action 的：它读的是 `discover` 的 Agent 目录缓存
（`from_cache` / `refreshed_at`，catalog 扫描时刻），与舰队五数的 `computed_at` 是两个来源、
两个时刻。2026-09-04 评审把「缓存于 01:27」读成舰队五数过期 6 小时，实际当次 fleet_status
是新算的（窗口末端 = 当时时刻、无 `cached`）。前端应把两处时间分开标：舰队数据时刻取
`computed_at`，Agent 目录时刻才取 `refreshed_at`。

成本：一次未命中 = Agent 数 × 1 条 Logs Insights 查询（各 ≈ 0.4 MB 扫描，$0.005/GB）+
DDB 读（PLANRUN ≤500 条投影读 1 次、PLAN 1 次、**PRICE 1 次**、SPANSRC 每 Agent 1 次）。零写。
（PRICE 原先是每 Agent 1 次 —— 价目表已进「读一次再分发」的队形，同 runs / plans；预读失败
时逐 Agent 退回自己读，不因此降级。）

## `{"action": "agent_topology", "agent_name": "...", "lookback_days": 7, "include_eval": null}`

Agent 详情「路径」卡的数据源（ADR-0017 D4）：近 N 天会话的 span 聚合成路径图。**只读**
（tests/test_agent_topology.py 钉「不写库」）；单事件响应；`lookback_days` 可选，默认 7，
收到 [1, 30]（越界取边界并在响应里回显实际取值；非整数 ⇒ 错误帧 `lookback_days 须为 1–30 的整数`）。
`agent_name` 不存在 ⇒ 错误帧 `Agent '<name>' 不存在`。`include_eval` 可选（省略 / null = 自动，
true / false 显式），语义见下「评估流量三档」。

```json
{"event": "agent_topology", "agent_name": "dshEvalTrace", "lookback_days": 7,
 "window": {"from": "2026-08-31T09:00:00Z", "to": "2026-09-07T09:00:00Z"},
 "sessions": 8, "sessions_source": "aws/spans · service=deepseek-harness",
 "cached": false, "cache_age_s": 0,
 "sessions_scope": "eval_only", "live_sessions": 0, "eval_sessions": 8, "agent_reports_spans": true,
 "span_origin": "central",
 "nodes": [{"id": "start", "kind": "start", "label": "start", "count": 8, "avg_s": null, "p95_s": null, "errors": 0,
            "recent_sessions": [{"session_id": "evaltest-rt-…-07", "at": "2026-09-07T08:12:03Z", "duration_s": null, "failed": false}, "…≤ 10 条"]},
           {"id": "agent", "kind": "agent", "label": "agent", "count": 8, "avg_s": 4.21, "p95_s": 9.8, "errors": 0,
            "recent_sessions": [{"session_id": "evaltest-rt-…-07", "at": "2026-09-07T08:12:03Z", "duration_s": 4.9, "failed": false}, "…"]},
           {"id": "tool:bash", "kind": "tool", "label": "bash", "count": 4, "avg_s": 0.03, "p95_s": 0.05, "errors": 2,
            "recent_sessions": [{"session_id": "evaltest-rt-…-07", "at": "2026-09-07T08:12:05Z", "duration_s": 0.06, "failed": true}, "…"]},
           {"id": "model:us.anthropic.claude-sonnet-4-5-20250929-v1:0", "kind": "model", "label": "claude-sonnet-4-5",
            "count": 12, "avg_s": 3.9, "p95_s": 8.1, "errors": 0, "recent_sessions": ["…"]}],
 "edges": [{"from": "start", "to": "agent", "count": 8},
           {"from": "agent", "to": "model:us.anthropic.claude-sonnet-4-5-20250929-v1:0", "count": 8},
           {"from": "model:us.anthropic.claude-sonnet-4-5-20250929-v1:0", "to": "tool:bash", "count": 4},
           {"from": "tool:bash", "to": "model:us.anthropic.claude-sonnet-4-5-20250929-v1:0", "count": 4}],
 "top_path": {"nodes": ["start", "agent", "model:us.anthropic.claude-sonnet-4-5-20250929-v1:0"], "count": 6, "share": 0.75},
 "slowest": {"id": "agent", "avg_s": 4.21},
 "session_paths": [{"session_id": "evaltest-rt-…-07", "at": "2026-09-07T08:12:03Z",
                    "path": ["start", "agent", "model:us.anthropic.claude-sonnet-4-5-20250929-v1:0", "tool:bash",
                             "model:us.anthropic.claude-sonnet-4-5-20250929-v1:0"], "failed_nodes": 1}, "…≤ 10 条"],
 "unavailable_reason": null}
```

**数据源（同源判据）**：与 `agent_status` **同一条** Logs Insights 查询
（`agentstatus.build_status_query`，逐 span 一行、最多 10000 行），只是 lookback 换成 N 天、并以
`include_test=True` 拉全 —— agent_status 那行 `filter attributes.session.id not like 'evaltest'` 在这里
不进 Insights，改在 Python 侧按会话 id 前缀 `evaltest` 分流（`topology.split_spans`），一次查询同时
得到真实 / 评估两类会话，不查两次；同一个取数函数（`agentstatus._run_insights_query`）、同一个行→span
转换（`agentstatus._rows_to_spans`）；窗口归属按 span 开始时间 ≥ `now − N 天`（`window.from`，不对齐
整点 / 整日）。`live_sessions` = 窗内真实流量出现过 span 的 `attributes.session.id` 去重数 —— 与
`agentstatus._window_metrics` 的 `sessions` 同式（同一批行、同一条排除规则）；`sessions` = 当前
`sessions_scope` 里的会话数，**`nodes[start].count == sessions`** 是构造上成立的，不是两处各算再对。
`sessions_source` = 日志组名，共享组再接 ` · service=<service_filter>` / ` · scope=<scope_filter>`。

**评估流量三档**（回归测试 / 红队测试 / 探针打出的会话 id 都以 `evaltest` 开头：testrun.py / redteam.py /
probe.py 同一个前缀）。响应四个字段恒在：

| 字段 | 含义 |
|---|---|
| `sessions_scope` | 图里画的是哪类会话：`"live"` 只真实流量 / `"eval_only"` 只评估流量（自动态退到的）/ `"live+eval"` 两类一起 |
| `live_sessions` | 窗内真实会话数（不看 scope） |
| `eval_sessions` | 窗内评估会话数（不看 scope；按会话 id 前缀 `evaltest` 判） |
| `agent_reports_spans` | 窗内该 Agent 有没有任何 span（含评估流量）；false ⇒ 这个 Agent 根本没上报 trace |

| 请求 `include_eval` | 行为 | `sessions_scope` |
|---|---|---|
| 省略 / null（自动） | 真实会话 > 0 ⇒ 只画真实；== 0 且评估会话 > 0 ⇒ 改画评估会话；两者都没有 ⇒ 空 | `live` / `eval_only` / 空态回 `live` |
| true | 两类会话一起画 | `live+eval` |
| false | 只画真实（等于改动前的行为） | `live` |

2026-09-07 实测：本账号 32 个 Agent 近 7 天真实流量全零，deepseek-harness 系只有 `evaltest-rt-…` 会话，
tauairline 系一条 span 都没有 —— 自动态就是让前者还能画出图、后者说清「没上报」。

**节点**（每会话一条按开始时间排序的节点序列；`count` = 访问次数）：

| id | 口径 | 时延 / errors |
|---|---|---|
| `start` | 每会话一次，序列首位 | avg/p95 恒 null，errors 恒 0 |
| `agent` | 一次 assistant 回合 = 一条 `invoke_agent*` span = 一次访问；所有回合归同一个节点（单回合会话下 count == sessions） | span 时长；`status.code == ERROR` |
| `tool:<name>` | 一条 `execute_tool <name>` span = 一次访问，`<name>` 取自 span 名 | span 时长；`agentstatus._tool_failed`（status ERROR 或 `gen_ai.tool.status ∈ {error, failed, failure}`）|
| `model:<id>` | 一条带 `gen_ai.request.model` 的 `chat*` span = 一次访问；invoke_agent 聚合层虽也带 model 属性但**不出**模型节点（同一次调用的叠层）；取不到 chat 段就没有模型节点 | span 时长；`status.code == ERROR` |

同一时刻并列按 agent → model → tool 排序。`avg_s` / `p95_s` 保留两位小数，p95 为 nearest-rank
（`agentstatus._p95`）；没有可用时长 ⇒ null。`label`：tool 为工具名；model 为短名 =
去掉 `<region>.<vendor>.` / `<vendor>.` 前缀（点后须紧跟字母，`gpt-4.1` 不动）→ 去掉 `-vN` / `-vN:0`
后缀 → 去掉 `-YYYYMMDD` 日期段（`us.anthropic.claude-sonnet-4-5-20250929-v1:0` → `claude-sonnet-4-5`）。
节点顺序：`start`、`agent`，其后按首次出现顺序（会话按首个 span 时间升序处理）。

**会话级两件**（ADR-0017 D4「点节点右侧列最近 10 个会话 → 报告页」+ 用户 2026-09-07「要能看单个会话走的那条路」；
批 topology-sessions）：

| 字段 | 含义 |
|---|---|
| `nodes[].recent_sessions[]` | 该节点出现过的会话，按 `at` 倒序 **≤ 10** 条。逐条 `session_id`（完整 id）/ `at`（该节点在该会话里**首次出现**的时刻，ISO UTC 秒级；`start` 节点 = 会话首个 span 时刻）/ `duration_s`（该节点在该会话里所有访问的**总耗时**，两位小数；`start` 恒 null、没有可用时长 ⇒ null）/ `failed`（该节点在该会话里至少一次访问报错，口径同 `errors`） |
| `session_paths[]` | 每会话一条：`session_id` / `at`（会话首个 span 时刻）/ `path`（完整节点 id 序列，`start` 起，与 `nodes[].id` 同一套；同一节点走几次出现几次）/ `failed_nodes`（该会话里报过错的**不同**节点数）。按 `at` 倒序 **≤ 10** 条。前端「按会话」高亮拿它把图里那条路点亮 |

同刻并列按 `session_id` 稳定排序。`top_path.count` == 走同一条 `path` 的会话数（会话 ≤ 10 时等于 `session_paths` 里同 path 的条数）。
不可用态两者都是 `[]`（与 `nodes` / `edges` 同一档）。不改缓存键与 TTL。

**边** = 序列内相邻两节点（`start → 第一个节点 … → 最后一个`），同一会话内同一条边走几次算几次。
**`top_path`** = 各会话完整节点序列里出现最多的一条（并列取最早出现的），`share` = 该路径会话数 /
`sessions`（四位小数）。**`slowest`** = `avg_s` 最大的非 start 节点；没有任何节点有时长 ⇒ null。

**不可用**（`nodes: []`、`edges: []`、`session_paths: []`、`sessions: 0`、`top_path` / `slowest` null，其余字段照常）：

| 情形 | `unavailable_reason` |
|---|---|
| 没有 runtime 日志组也没配 span 源（`sessions_source` 同时为 null） | `未配置 span 源` |
| 窗内一条 span 都没有（含评估流量；`agent_reports_spans: false`） | `近 N 天 Agent 未上报任何 span（含评估流量）` |
| 有 span 但当前 scope 里 0 会话（典型：`include_eval: false` 而窗内只有评估会话） | `近 N 天没有会话` |
| 查询超时 / 失败 | `Logs Insights 查询失败：<原话前 200 字>` |
| 行数达到 10000 上限（两类会话一起计行） | `近 N 天 span 行数达到 Logs Insights 单次查询上限 10000，聚合不完整` |

不可用时 `live_sessions` / `eval_sessions` 仍按窗内实况给（查询失败 / 截断 / 未配置 span 源时为 0、
`agent_reports_spans: false`——那几种情形下没有可信的行可数）。

**缓存**：与 `fleet_status` / `agent_status` 同款（同一份 `app/ttlcache.py`）—— 5 分钟**进程内**
（Lambda 热实例），键 `(agent_name, lookback_days, include_eval)`（三档各一个键）；命中返回原结果
+ `cached: true` + `cache_age_s`（距原次计算的整秒数，未命中恒 0）；`refresh: true` 绕过并覆盖。
不写 DDB 缓存项（理由同 fleet_status）。

成本：一次未命中 = 1 条 Logs Insights 查询（N 天扫描量按现网 30 天 6.3 MB 折算 ≈ 1.5 MB / 7 天，
$0.005/GB）+ catalog 读（Agent 列表缓存项、SPANSRC 单读）。零写。

## span 源与回退（`span_source` / `span_origin`）

一个 Agent 的 span 落在哪，取决于它的埋点方式，**现网实测分两派**（2026-09-07，us-west-2）：

| 派别 | 埋点 | span 去向 | 现网读数 |
|---|---|---|---|
| ⒜ AgentCore 统一目的地（默认） | CodeZip + `opentelemetry-instrument` + aws-opentelemetry-distro 0.19，执行角色带 `logs:PutResourcePolicy` | **自己的 runtime 日志组**，`@logStream="spans"` | `tauairline_agentfable5`：30 天 528 条 span / 52 会话在专属组，`aws/spans` 里 0 条 |
| ⒝ 镜像自带 ADOT collector | 容器内跑 collector 直接导出 | 共享 `aws/spans` | `dshEvalTrace`：`aws/spans` 里 50 会话（`service.name=deepseek-harness`），自己组的 spans 流为空 |

所以「专属日志组永远为空」只对 ⒝ 成立。`set_span_source` 把某个 Agent 指到
`aws/spans` 之后，如果它其实是 ⒜（或中途换过埋点方式），主源读到 0 条与「这个 Agent
没开观测」在数据面完全同形 —— 回退读法就是把这两件事分开的唯一办法。

**`resolve_span_config(agent)` 返回的 cfg**：

```json
{"log_group": "aws/spans", "scope_filter": "", "service_filter": "deepseek-harness",
 "fallback_log_group": "/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT"}
```

- `fallback_log_group` **只在主源正好是 `aws/spans` 时**出现，值 = 该 Agent 自己的
  runtime 日志组（`agent.log_group`，或按 `runtime_id` / `runtime_arn` 拼
  `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT`）。用户显式把 span 源指到
  别的组 ⇒ **不加**（他知道 span 在哪，替他猜 runtime 组 = 拿另一个组的 span 当证据）；
  主源本来就是专属组 ⇒ 不加（否则同一批字节查两遍）；推不出 runtime 身份 ⇒ 不加。
- 回退那一次读**不带** `scope_filter` / `service_filter`（那两个过滤器是给共享组挑一个
  service 用的；专属组里 `service.name` 是 `<agent>.DEFAULT`，带上去会把真数据全滤掉），
  但**必须限 `@logStream = "spans"`** —— 同一个组里还有 stdout / stderr / otel-rt-logs 流。
- 两处记录形状相同（都是 CloudWatch 结构化 span JSON：`attributes.session.id` /
  `resource.attributes.service.name` / `scope.name` / `traceId` / `*TimeUnixNano`），解析层
  一份，上层不分岔。

**读法顺序与成本**：主源先读，**只有它一条都没读到才读回退** —— 不双查。适用于
`fetch_session` / 列会话（`list_sessions`）/ `agent_status` 五个数 / `agent_topology`。
列会话时两处结果按 `session.id` 去重合并（同 id 保留主源那份；一个 Agent 换过埋点方式
就会在同一个窗口里两处都有 span，算两次 = 会话数虚高）。

**`span_origin`**（新增字段，三处都有）：

| 值 | 含义 |
|---|---|
| `"central"` | 这批数据读自配置的共享 span 组（`aws/spans`） |
| `"runtime_group"` | 读自该 Agent 专属 runtime 组（无 span 源配置时的常态；或主源为空后回退命中） |
| `null` | 一个组都没读到（没有 span 源 / 查询失败 / 行数截断）——**不是**「读了但是 0 条」 |

落点：`agent_status.span_origin`、`agent_topology.span_origin`、会话枚举里每条
`{session_id, last_ts, span_count, span_origin}`；取单个会话用
`tracesource.fetch_session_with_origin` 拿第三个返回值（`fetch_session` 是不关心来源的
两元组门面）。`agent_status.cloudwatch_url` 指向**这次真读到数的那个组**（回退命中时是
专属组，给 `aws/spans` 的链接会打开一个空查询）。

⚠️ 共享组不带 `service_filter` 的配置本身是歧义的：`aws/spans` 里的 span 不带 Agent
身份（`resource.attributes` 只有 service.name / version / environment / user.id），
不带过滤器读到的是**别的 service** 的会话（现网复现：无过滤器读 `aws/spans` 30 天拿到
200 个会话，全是本评估服务自己的）。回退不负责修这件事 —— 配共享组必须带 service 过滤。

**采样（跟回退是同一个缺陷的另一半）**：被测 Agent 的 ADOT 默认采样器是
`parentbased_always_on`，采不采样跟着**调用方**走。评估服务调它时 botocore 会注入
traceparent；本服务受账号 X-Ray 默认 5% 规则约束 ⇒ 约 85% 的调用带着 `sampled=0` 的父
到达，被测 Agent 丢掉整条 trace（现网 2026-09-07：fable5 当天 25 次调用日志全
`trace_sampled=False`、零 span；08-16 为 True 那批 span 齐全）。修法是运行时 env
`OTEL_TRACES_SAMPLER=always_on`（`infra/stacks/eval_runtime_stack.py`）；读数落在回归 run
每条用例结果的 `trace: {"sampled": true|false}`（`testrun.current_trace_sampled()`，
调用前读；本地无 OTel / 无活跃 span ⇒ 不写这个字段，**缺测不等于 false**；缓存命中的
用例没有本次调用，也不写）。

## 成本字段（回归 run / 观测 metrics）

所有成本都是**估算**（契约首段），且分三层口径，前端展示必须能分开读：

**回归 run（`testrun.execute_test_run` 的 run 对象，随 `get_plan_run` 的
`report.stages[i].report` 与 `list_plan_runs` 摘要一起出）**

```json
{"estimate": {"estimated_cost_usd": 0.4725, "unpriced_agents": ["tauairline_airlineagent"],
              "cost_is_partial": true, "judge_calls": 45, "…": "…"},
 "actual_cost_usd": 0.4725,
 "cost_breakdown": {"judge_usd": 0.4725, "agent_usd": null,
                    "unpriced": ["tauairline_airlineagent"]},
 "cost_is_partial": true,
 "unpriced_agents": ["tauairline_airlineagent"]}
```

| 键 | 口径 |
|---|---|
| `actual_cost_usd` | **恒等于「算得出的部分之和」** = `cost_breakdown.judge_usd` + 已定价被测 Agent 的费用。被测 Agent 无价时这个数只含 judge 侧，**不是**这次运行的全额，也**不是**回落成预估 |
| `cost_breakdown.judge_usd` | judge 调用（每个产出判定的评估器一次 + 多轮模拟用户每轮一次 + 带图 mm_* 的图片 token），按 `JUDGE_TOKENS_PER_EVAL` 常数 token × judge 费率建模——**与预估同一套系数**，所以 45 个判定一个不少时 judge 侧实际 ≡ 预估（2026-09-04 现网：四份不同模型的回归 run 成本都是 0.4725，正是这一项；不同模型同价的成因是 Agent 侧两边都是 0） |
| `cost_breakdown.agent_usd` | 被测 Agent 侧：环节配了 `agent_model` 且价表有价 ⇒ 按调用数 × 平均 token + 输出字数/4 估；任一被测 Agent 无价 ⇒ **null**（0 会被读成「没花钱」），名字进 `unpriced` |
| `cost_is_partial` | `agent_usd` 为 null 时 true。前端见 true 必须标「仅 judge 侧」或「≈ 含未定价部分」，本月花费合计同样要标 |
| `cost_breakdown.unpriced` | == `unpriced_agents`（留痕列表）。缓存命中的用例不进：那是刻意豁免，不是无价 |
| `estimate.cost_is_partial` | 预估侧同口径：`unpriced_agents` 非空 ⇒ true |

老 run 没有 `cost_breakdown` / `cost_is_partial`（不回填）；前端缺键时按「不可拆分」处理，别当 false。
plan-run 级 `total_cost_usd`（`planrun._finish` 各环节 `actual_cost_usd` 求和）目前**没有**随环节上浮
`cost_is_partial`——环节摘要（`planrun.py` `_run_dataset_stage` 返回值 / `_stage_summary`）需要把
`cost_breakdown` / `cost_is_partial` 一并带出，并令 plan-run 级 `cost_is_partial = any(stage)`；
这一步归 planrun 的批次（本批未动 planrun.py）。

**观测 metrics（`metrics.compute_session_metrics`，线上评估 `session_result.metrics` /
`agent_status.metrics.agent_cost_usd` 同源）**

```json
{"tokens": {"input": 8769, "output": 351, "total": 9120,
            "input_uncached": 3, "cache_read": 7932, "cache_write": 834,
            "by_model": {"us.anthropic.claude-sonnet-4-5-20250929-v1:0":
                         {"input": 8769, "output": 351, "calls": 1,
                          "input_uncached": 3, "cache_read": 7932, "cache_write": 834}}},
 "cost": {"usd": 0.010781, "by_model": {"…": 0.010781}, "unpriced_models": []}}
```

| 键 | 口径 |
|---|---|
| `tokens.input` | 模型**处理过的整段 prompt** = `input_uncached` + `cache_read` + `cache_write`。Anthropic 式 span 的 `gen_ai.usage.input_tokens` 只是未缓存份（dsh harness 现网：3 对 7932），只累加它就是「8 次调用输入 36」（P1，2026-09-04） |
| `tokens.cache_read` / `cache_write` | 从 `gen_ai.usage.cache_read.input_tokens` / `cache_write.input_tokens`（点号，OTel GenAI 语义约定）或 `cache_read_input_tokens` / `cache_write_input_tokens` / `cache_creation_input_tokens`（下划线，strands / botocore / Anthropic 原生）读，同一 span 取第一个有值的拼写 |
| `cost.usd` | `input_uncached` × 单价 + `cache_read` × 单价 × **0.1** + `cache_write` × 单价 × **1.25** + `output` × 输出单价（`pricing.CACHE_READ_INPUT_MULTIPLIER` / `CACHE_WRITE_INPUT_MULTIPLIER`，Anthropic 价目 2026-09-07；1 小时写 2× 在 span 上分不出，按 5 分钟价计） |
| `cost.unpriced_models` | 价表（内置 + DDB PRICE 行）查无的 `gen_ai.request.model`；内置表 2026-09-07 起含 `anthropic.claude-sonnet-4-5`（$3 / $15 per MTok，`us.` / `global.` 前缀与日期后缀按前缀命中） |

老报告的 `tokens` 没有三个拆分键；`aggregate_agent_metrics` 按 0 累加它们，`input` 照旧相加。

## 管理类动作（单事件响应）

| action | 说明 |
|---|---|
| `create_custom_evaluator` | `{name, rubric, scope, blocks?}` 新建/更新 rubric 评估器（存 DynamoDB，底层 OutputEvaluator）；`blocks` 为结构化源数据（goal/checks/bands，后端只存取不解释），省略则清除；响应带 `updated_at`，编辑不重置 `created_at` |
| `delete_custom_evaluator` | `{name}` 删除 |
| `list_cache` / `clear_cache` | 结果缓存作用域查看 / 按作用域清空 |
| `prices` | 返回合并单价表（内置+DB，含来源 builtin/auto/manual）与上次同步信息 |
| `set_price` | `{model, input, output}` 手工设价（$/1K token；manual 永不被自动同步覆盖） |
| `delete_price` | `{model}` 删除手工价，恢复自动/内置价 |
| `refresh_prices` | 从 AWS Pricing API 同步（EventBridge 每周一 UTC 自动跑；UI 可手动触发） |

成本说明：一律为**预估值**。第三方模型（PPIO 的 Kimi/GLM/DeepSeek 等）
Pricing API 不覆盖，需在 UI 单价配置里手工补价，否则报告只显示 token 并标注未定价。

## 坏例入数据集与人工标注（ADR-0017 D1 / D2）

权威：`app/catalog.py` 的 `append_dataset_cases` / `annotate_case` / `list_annotations`，
分派在 `app/main.py`。三个都是单事件响应；错误一律 `{"event": "error", "error": "…"}`。
pytest：`tests/test_badcase_backend.py`（moto 真 DynamoDB，走 `main.invoke` 全程）。

### `append_dataset_cases`

```json
{"action": "append_dataset_cases", "dataset": "dshEvalTrace-badcases", "kind": "regression",
 "create_if_missing": true, "target_agent": "dshEvalTrace", "on_duplicate": "skip",
 "cases": [{"name": "run0904-e5d8fb96", "input": "解释 TCP 三次握手，三句话以内。",
            "expected_output": "客户端先发 SYN…", "notes": "评委理由：…",
            "source": {"run_key": "plan-69e514cf625f#20260904025440", "row_key": "<ReportRow.key>",
                       "kind": "session", "evaluators_failed": ["conciseness", "instruction_following"],
                       "score": 0.0, "human_score": 0.5, "added_at": "2026-09-07T08:12:00Z"}}]}
→ {"event": "dataset_cases_appended", "dataset": "dshEvalTrace-badcases", "kind": "regression",
   "added": 1, "updated": 0, "skipped_duplicates": 0, "case_count": 8, "created": true}
```

| 字段 | 取值 | 口径 |
|---|---|---|
| `kind` | `regression` / `redteam` | `simulation` 不接受 ⇒ error（多轮回放二期）。已存在的集合 kind 不同 ⇒ error `数据集 '…' 是 <kind> 集，不能追加 <kind> 用例`；存量 item 无 kind 属性时按 `rt-` 前缀推断（`catalog._infer_kind`） |
| `create_if_missing` | bool，默认 false | 不存在且 true ⇒ 建（kind / target_agent 照传入）；不存在且 false ⇒ error `数据集 '…' 不存在`。已存在时 `target_agent` 不覆盖旧值 |
| `on_duplicate` | `skip`（默认）/ `update` | 去重键 = 归一化 `input`（strip、连续空白折成一个空格、casefold；`catalog.normalize_case_input`）。`update` 只覆盖同键条目的 `expected_output` / `notes` / `source`，`name` / `input` 与红队攻击字段不动。批内重复同规则 |
| `cases[]` | 非空 | 每条 `input` 非空必填；`kind=regression` 时 `expected_output` 非空必填，任一条为空 ⇒ **整批拒绝** `第 N 条 expected_output 为空`。`notes` / `source` 是可选扩展键，原样落库（ADR-0009 的纯度校验是多轮字段排除列表，不是键允许列表，见其 Amendment）。多轮字段仍被 ADR-0009 拦 |
| redteam 用例 | 照现有红队数据集形状 | 存量红队集 / `redteam._to_redteam_case` 读的是 `actor_goal`（不是 `objective`），`strategy` 是 run 结果字段不是用例字段。服务端把传入的 `objective` 同步到 `actor_goal`（两者都留），其余键原样；`expected_output` 不要求 |
| `added` / `updated` / `skipped_duplicates` | int | 三者之和 = 传入条数 |
| `case_count` | int | 写后集合总条数（全部命中且 skip 时不写库，仍返回该数） |
| `created` | bool | 本次是否新建了集合 |

服务端流程 = 读现有 cases → 校验（与 `save_dataset` **同一份**函数：`_validate_cases` 拒空 / 条数 /
input，`_enforce_shape` ADR-0009 形状，`_build_dataset_item` ADR-0012 体积预检）→ 去重 → 追加 →
整表写回 DDB 单 item。写是**条件写**：DATASET item 新增单调递增的 `version` 属性（`save_dataset` 也
盖戳），`ConditionExpression="version = :v"` 比对读到的值（新建 `attribute_not_exists(pk)`；存量无
version 的 item 用 `attribute_exists(pk) AND attribute_not_exists(version)`）；冲突重读重算，最多 3 次，
仍冲突 ⇒ error `数据集 '…' 正被其他写入修改，重试 3 次仍冲突，请稍后再试`。`save_dataset`（编辑器整表保存）
仍是无条件 put —— 它不在本批范围内。

### `annotate_case` / `list_annotations`

```json
{"action": "annotate_case", "run_key": "plan-…#…", "row_key": "<ReportRow.key>",
 "evaluator": "conciseness", "human_score": 0.5, "label": "conciseness", "comment": "可选"}
→ {"event": "case_annotated", "annotation": {"run_key": "…", "row_key": "…", "evaluator": "conciseness",
   "human_score": 0.5, "label": "conciseness", "comment": "可选", "by": "manual", "at": "2026-09-07T08:12:00Z"}}
{"action": "list_annotations", "run_key": "plan-…#…"}
→ {"event": "annotations", "run_key": "…", "items": [{…同上…}]}
```

- `evaluator` = 评估器名或 `"overall"`；`human_score` ∈ {0, 0.5, 1}（JSON 数；`true` / `"0.5"` / 0.7 都 ⇒ error
  `human_score 必须是 0 / 0.5 / 1 之一`）。返回时 0 / 1 是整数、0.5 是小数。`run_key` / `row_key` / `evaluator`
  任一为空 ⇒ error `<键> 不能为空`。`label` 截 120 字、`comment` 截 2000 字，可空。
- 同 (run_key, row_key, evaluator) 重标 = 同键 put，覆盖旧值。`by` 固定 `"manual"`（后端没有用户身份）；
  `at` ISO-8601 UTC 秒级 `Z`。
- **不改** run 的任何分数字段、不回填 pass_rate / evaluator_stats（tests 钉 PLANRUN item 逐字节不变）。
- `list_annotations` 未知 run_key ⇒ `items: []`，不是 error。

DDB 键设计（照 `app/catalog.py` 模块 docstring 的表）：

| pk | sk | 属性 |
|---|---|---|
| `ANNOT/<run_key>` | `<row_key>#<evaluator>` | `run_key` `row_key` `evaluator` `human_score`(Number) `label` `comment` `by` `at` |

`run_key` 自带 `#`（`plan-…#2026…`），所以它进 pk 不进 sk；`row_key` / `evaluator` 另存属性，读侧不拆 sk。
一次 run 的标注 = 一次 Query（pk 等值），与 `REVIEW`（`pk="REVIEW", sk="<session>#<evaluator>"`）互不干扰。

## 会话并排对比（ADR-0017 D3）

权威：`app/sessioncompare.py` 的 `compare_sessions` / `pair_rows`，分派在 `app/main.py`（`get_plan_run` 之后）。
两个都是单事件响应；错误一律 `{"event": "error", "error": "…"}`。明细与 `get_plan_run` **同源**
（只读 `planrun.get_plan_run` 拿到的 S3 归档 `report`，不另存任何东西）。
pytest：`tests/test_session_compare.py`（合成两份 run 明细，走 `main.invoke` 全程）。

### `compare_sessions`

```json
{"action": "compare_sessions",
 "left":  {"run_key": "plan-…#20260904013100", "row_key": "sess-a41f9c2b"},
 "right": {"run_key": "plan-…#20260905020000", "row_key": "sess-9f00d1e2"}}
→ {"event": "session_compare",
   "left": {"run_key": "…", "row_key": "sess-a41f9c2b", "stage_type": "observe",
            "started_at": "2026-09-04 01:31 UTC", "run_index": 6,
            "events": [{"n": 1, "type": "user", "t_offset_s": 0.0, "text": "…"},
                       {"n": 2, "type": "tool", "t_offset_s": 1.2, "name": "bash", "duration_s": 0.03,
                        "error": null, "arguments": "…(≤300)", "result": "…(≤300)"},
                       {"n": 3, "type": "assistant", "t_offset_s": 3.7, "text": "…"}],
            "attributes": {"model": "…", "tokens.input": 36, "tokens.output": 128, "llm_calls": 1,
                           "tool_calls": 0, "latency.avg_s": 3.79, "cost.usd": null, "system_prompt": "…"},
            "results": {"conciseness": {"score": 0.0, "passed": false, "label": "Not Concise", "reason": "…"}}},
   "right": {…同形…},
   "attribute_diff": [{"key": "tokens.output", "left": 128, "right": 165, "change": "modified"},
                      {"key": "system_prompt", "left": "…", "right": "…", "change": "modified",
                       "text_diff": [{"op": "equal", "text": "…"}, {"op": "delete", "text": "…"},
                                     {"op": "insert", "text": "…"}]}],
   "attribute_total": 8,
   "aligned": true, "align_key": "把这句话翻译成英文：…"}
```

| 字段 | 口径 |
|---|---|
| `row_key` | 行在归档里的键，按环节类型取：observe = `session_details[].session_id`；dataset = `report.results[].case`（testrun 写侧键名，**不是** name）；redteam = `report.results[].case_name`（也接受报告页红队行的 `<case_name>#<下标>` 键）。找不到 ⇒ error `run '…' 里没有 '…'`；run 不存在 ⇒ `run '…' 不存在`；S3 报告读失败 ⇒ `run '…' 完整报告读取失败，无法对比`；`left` / `right` 缺键 ⇒ `left.row_key 不能为空` 这种 |
| `stage_type` | `observe` / `dataset` / `redteam`；两侧允许不同类型（线上会话 vs 回归用例照样并排） |
| `started_at` / `run_index` | run 摘要的开跑时刻（分钟级 UTC 串）；`run_index` = 「这个计划的第 N 次运行」，按 `run_key` 升序数（与前端 CompareView.seqOf 同口径），历史读不到 ⇒ null |
| `events[]` | 只回 `n / type / t_offset_s / text / name / duration_s / error / arguments / result`（`arguments` / `result` 截 300 字），**不**回 span_id / slow / agent。observe 行 = transcript.events 原样裁键；dataset 行 = `input` → user（t=0）+ `output` → assistant（t=duration_s），多轮用例按 `conversation[].{role,message}` 逐轮（无时间戳 ⇒ t 为 null）；redteam 行 = `conversation[]`，attacker/user → user、其余 → assistant，t 为 null |
| `attributes` | **固定 8 键**、顺序固定：`model` `tokens.input` `tokens.output` `llm_calls` `tool_calls` `latency.avg_s` `cost.usd` `system_prompt`；取不到为 null。observe 行读 `metrics`（`model` = tokens.by_model 里调用最多的；`tool_calls` 没勾指标时数 transcript 的 tool 事件）+ `transcript.system_prompt`；dataset 行 `model` = 环节配置 `agent_model`、`tool_calls` = `tool_evidence.count`（unavailable ⇒ null）、`latency.avg_s` = 用例 `duration_s`，其余 null；redteam 行只有 `model`（环节 `agent_model`） |
| `results` | `{评估器: {score, passed, label, reason}}`；errored 判定的 score / passed 为 null（写侧已置）。redteam 行没有逐评估器判定，合成一个 `redteam` 键：`score` = 攻击分、`passed` = 未攻破（errored ⇒ null）、`label` ∈ `攻破` / `守住` / null |
| `attribute_diff` | **只列两侧不等的键**，`change` ∈ `added`（左 null 右有）/ `removed` / `modified`；两侧都是字符串且（键是 `system_prompt` 或任一侧 > 80 字）⇒ 附 `text_diff`（`difflib.SequenceMatcher` 字级，`op` ∈ equal / delete / insert，replace 拆成 delete+insert；拼接 equal+delete = 左文、equal+insert = 右文） |
| `aligned` / `align_key` | 两侧题面归一化（strip、连续空白折一个空格、casefold）后相等 ⇒ true；题面：observe = 第一条 user 事件文本、dataset = `input`、redteam = `objective`（缺则第一条攻方发言）。`align_key` = **左侧原文**（不归一化）；左侧题面为空 ⇒ `aligned` 恒 false |

### `pair_rows`

```json
{"action": "pair_rows", "left_run_key": "plan-…#…", "right_run_key": "plan-…#…"}
→ {"event": "row_pairs",
   "pairs": [{"align_key": "…", "left_row_key": "sess-a41f9c2b", "right_row_key": "sess-9f00d1e2",
              "left_results": {"conciseness": {"score": 0.0, "passed": false}},
              "right_results": {"conciseness": {"score": 1.0, "passed": true}}},
             {"align_key": "…", "left_row_key": "sess-only-left", "right_row_key": null,
              "left_results": {…}, "right_results": null}],
   "aligned": 2, "total": 3}
```

- 两份 run 的**全部**行（三种环节都算，`row_key` 口径同上）按题面归一化配对；同题多行按出现顺序一一配对。
- 顺序：已对齐（按左侧行序）→ 左侧独有（左侧行序）→ 右侧独有（右侧行序）；缺席侧 `*_row_key` / `*_results` 都是 null。
- `*_results` 只带 `{score, passed}`（配对表用；全量看 `compare_sessions`）。`aligned` = 配对数，`total` = 行数。
- `left_run_key` / `right_run_key` 任一为空 ⇒ error `<键> 不能为空`；run 不存在 / 报告读失败同 `compare_sessions` 的文案。

**取数与缓存（两个 action 共用）**：每份 run 一次 `planrun.get_plan_run` = 1 次 DDB
`get_item` + 1 次 S3 `get_object` + 整份报告 `json.loads`。一次对比链路要把同两份 run
反复取回来（`compare_sessions` 两侧 → `pair_rows` 两侧 → 配对表里每对再一次
`compare_sessions`），所以**已结束**的 run（`status != "running"`）在进程内缓存
`ttlcache.DEFAULT_TTL_SECONDS`（300s）、上限 8 条（键随 run_key 长，满了淘汰最早的）。
响应体不变：这里没有 `cached` / `cache_age_s` 字段——缓存的是取数中间件不是响应。
跑着的 run 与取数失败都不进缓存（报告可能只是还没归档好）。
⚠️ 「终态归档不可变」只对 **S3 那份报告**成立：摘要项在终态之后仍会被改
（`attach_proposal` / `set_proposal_adopted` / `adopt_run_advice` 对完成的 run
`SET proposals`）。本模块一个都不读，但 TTL 仍留着当正确性上界，不做「永不过期」。

## 问题台账（ADR-0016 ③ 的两个数据前提）

权威：`app/planrun.py` 的 `aggregate_issues` / `_build_ledger`。两个字段都是
additive：老 run 与没有诊断产物的 run 查无此键，读侧回落 `[]` / 不写，不回填历史。

### `synthesis_issues`：结构化问题条目

出处：`get_plan_run` 的 `plan_run` 事件、`list_plan_runs` 的每条 run、`run_plan`
终帧 `plan_run_report`、S3 完整报告根级。**与 `plan_synthesis` / `synthesis_sections`
并存**（散文不删）。`list_recent_runs` 刻意不投影它（与 `plan_synthesis` 同一理由），
那个 feed 里恒为 `[]`。值恒为数组：没有诊断产物 ⇒ `[]`（不是 `null`）。

```json
{
  "id": "3f9a1c2e",
  "identity_key": "SYSTEM_PROMPT_FIX|case:case-9,session:sess-a41f9c2b|959e4e17ff051a5f",
  "problem": "2 个用例（case-9、case-4）在工具返回空结果后仍报出具体订单号",
  "evidence": [{"kind": "case", "ref": "case-9"}, {"kind": "session", "ref": "sess-a41f9c2b"}],
  "root_cause": "系统提示词没有规定工具空结果时的话术",
  "recommendation": "在系统提示词中加入：工具返回空结果时明确告知用户「未查到」……",
  "recommendation_source": "Add to the system prompt: when a tool returns an empty result, tell the user ...",
  "fix_type": "SYSTEM_PROMPT_FIX",
  "first_seen_run": "plan-1ed9e7a1c0de#20260901090000",
  "last_seen_run": "plan-1ed9e7a1c0de#20260903090000",
  "occurrences": 2,
  "depends_on": ["7be04d11"],
  "status": "adopted",
  "evaluators": ["correctness", "helpfulness"]
}
```

| 字段 | 取值 | 口径 |
|---|---|---|
| `id` | 8 位 hex | `identity_key` 的 sha1 前 8 位（ADR-0018，批 ledger-id-merge）。**id 稳定性**：身份里没有任何 LLM 文本——诊断器每轮换措辞（`fix_recommendation` / `root_cause_explanation` 七轮七种说法，现网实测）不产新条目；同一条证据（同会话同 span / 同用例）再被诊断出同 fix_type 的根因 ⇒ 同 id、`occurrences+1`。批 ledger-id-merge 之前落库的条目 id = `sha1(fix_recommendation)`，读回不重算（见 `identity_key` 的过渡口径） |
| `identity_key` | 字符串 | `"<fix_type>|<sorted kind:ref>|<sorted 会话 span>"`：`fix_type` 为 `null` ⇒ 空段；证据行按字典序；第三段只收**会话行**上根因的 `location`（trace 已落库、重评同一会话给同一批 span），**用例行不进 span**（每轮重放、span 新生）⇒ 用例行的身份 = fix_type × 用例，同用例上同 fix_type 的多条根因并成一条。留证用、可人工复算。**老形状**（没有这个键）的 carried 条目在下一次合并时按 `(fix_type, 证据行)` 折进本次第一条同签名的新条目：`occurrences = max(老 occurrences 最大值, 老 last_seen_run 去重数)+1`、`first_seen_run` 取最早、译文/原话/`root_cause` 取最近见到的那条；没对上的原样带着（仍无此键）。老 run 落库数据不回填 |
| `problem` | 字符串 ≤300 | LLM 一句话（toolUse `submit_issues` 强制 schema）；LLM 失败/未回填 ⇒ 确定性文本「N 个用例（名…），累计 K 次运行出现」 |
| `evidence[]` | `{kind, ref}` ≤8 条 | `kind` ∈ `case`（回归用例名）/ `session`（线上会话 id）；`redteam` / `run` 两值预留，当前不产（红队环节没有诊断管线）。本次 run 的引用排前 |
| `root_cause` | 字符串 ≤300 | LLM 一句话；回落 = 首条 `root_cause_explanation` |
| `recommendation` | 字符串 ≤300 或 `null` | `fix_recommendation` strip 后的**简体中文译文**（v0.34.1 后，批 judge-zh）：诊断管线 `diagnose_session` 无语言参数、原话英文，由 `submit_issues` 译成中文、保持原意不增删；已是中文则原样。原英文不再作为 `recommendation` 返回；LLM 失败/未回填 ⇒ 保留原话（此时可能是英文）。`null` = 待建议，LLM 不得替它编一条 |
| `recommendation_source` | 字符串 ≤300 或 `null` | 译前原话（`fix_recommendation` strip 后，英文）。**只用于 `status` 对回 proposals，不作展示**；`recommendation` 为 `null` 时它也是 `null`。批 judge-zh 之前落库的台账没有这个键：读回时当 `recommendation` 就是原话补上，不回填历史。同身份再现（ADR-0018）时与 `recommendation` **成对保留**旧值、不换成本次的新措辞——原话每轮漂，换掉会让上一轮从报告页采纳的英文 summary 对不上；本次措辞在该 run 报告页可见 |
| `fix_type` | `SYSTEM_PROMPT_FIX` / `TOOL_DESCRIPTION_FIX` / `OTHERS` / `null` | 空 ⇒ `null`；两个具名值之外 ⇒ `OTHERS` |
| `first_seen_run` / `last_seen_run` | run_key | 首次 / 最近出现的 run |
| `occurrences` | int ≥1 | 出现过的 run 次数（台账链上累计：上一次 completed run 的 `synthesis_issues` 是底稿） |
| `depends_on[]` | id 列表 ≤5 | LLM 标注；只留本台账内的 id，去自指 |
| `status` | `open` / `adopted` / `resolved` | 按 proposals 对回：匹配键 = 建议文本 strip 后截到 300 与 `proposals[].summary` 全等（与 `adopt_run_advice` / 前端 `persistedAdoptedAt` 同一规则）；`recommendation`（译文）与 `recommendation_source`（原话）**两把钥匙任一对上即算**——报告页从 `fix_recommendation` 原话采纳的 summary 是英文、台账页从条目 `recommendation` 采纳的是中文；有 `adopted_at` ⇒ `adopted`；且 `adoption_effect.verdict == "improved"` ⇒ `resolved` |
| `evaluators[]` | 评估器名列表 ≤6 | 产出这条问题的诊断由哪些评估器的低分触发：对每条 `evidence` 行查本次 run 的逐评估器分（回归 `report.results[].results[评估器].score` / 线上 `session_details[].results[评估器].score`），收集 `< 0.70`（`diagnosis.LOW_SCORE_THRESHOLD`）的评估器名，去重、按出现次数降序（同次数按首见序）；跨 run 合并取并集保持首见序。老形状 / 无逐评估器分 ⇒ `[]`（不是 `null`），不回填历史 |

排序：本次见到的在前，其次 `occurrences` 降序、证据数降序；一条 run 最多 20 条（按身份合并后
现网七轮复算是 5 → 6 → 7 → 7…，远够不到上限）；`depends_on` 只留最终台账里的 id（被折掉的老 id 不悬空）。
生成门与散文相同：被停止 / 零可评估数据的 run 不生成（`[]`）。零条目时不发 LLM 调用。
整理步（`submit_issues`）分批 ≤6 条：schema 按批给 `id` 的 `enum` 与 `minItems=maxItems`；回来的行整批 id
都不认识且行数相同 ⇒ 按送出行序对回（warning）；有任一 id 对得上 ⇒ 不认识的按幻觉丢弃；行数不等 ⇒ 全丢（warning）。

### `proposals[].adoption_effect`：采纳效果判定

出处：挂在**建议所在那条 proposal 上**（与 `attach_proposal` / `adopt_run_advice`
同一存储位置，`proposals` JSON 数组），随 `get_plan_run` / `list_plan_runs` 的
`proposals` 一起带出，不新建表、不新增 action。`adopted_at` 为空的条目没有这个键；
取消采纳时一起删掉。

```json
{
  "verdict": "improved",
  "metrics": [{"name": "correctness", "before": 0.62, "after": 0.85},
              {"name": "pass_rate", "before": 0.5, "after": 0.75}],
  "cases": [{"ref": "case-9", "before": "fail", "after": "pass"}],
  "measured_run": "plan-1ed9e7a1c0de#20260903090000",
  "baseline_run": "plan-1ed9e7a1c0de#20260901090000",
  "reason": null
}
```

| 字段 | 取值 | 口径 |
|---|---|---|
| `verdict` | `improved` / `unchanged` / `regressed` / `pending` / `inconclusive` | 见下方规则 |
| `metrics[]` | `{name, before, after}` | `name` = 评估器名（线上：`summary[name].mean_score`；回归：`evaluator_stats[name].mean`）或 `pass_rate`（回归）/ `breached`（红队）；数值四舍五入到 4 位 |
| `cases[]` | `{ref, before, after}` | `ref` = 用例名 / 攻击名；`before`/`after` ∈ `pass` / `fail` / `none`（无有效判定）。行级口径与 `_stage_summary` 的 judged 闸门、前端 `rowOutcomeOf` 同源；红队 `breached` ⇒ `fail` |
| `measured_run` | run_key 或 `null` | 判定用的那次 run；`pending` 时 `null` |
| `baseline_run` | run_key | 建议挂着的那次 run（采纳时的基线） |
| `reason` | 字符串或 `null` | 只在 `inconclusive` 时非空 |

写入时机：`set_proposal_adopted(adopted=true)` / `adopt_run_advice` 立即写
`pending`；每次 run 正常完成落库前（被停止 / 零可评估数据的 run 不判），对此前所有
completed run 里 `adopted_at` 非空的条目判一次并回写。定稿
（`improved` / `unchanged` / `regressed`）不被后来的 run 覆盖 —— 效果 = 采纳后第一次
可判定的 run；`pending` / `inconclusive` 每次重判。

判定规则（只用两条硬事实，不用 ±0.0x）：

1. `adopted_at`（分钟级 UTC）≥ 本次开跑时刻 ⇒ `pending`。
2. 环节类型序列与基线不同，或同位环节的评估器集合不同（回归看 `evaluators`，线上看
   `summary` 的键）⇒ `inconclusive`，`reason` 写明前后构成。
3. `refs` 里点名的行（前端传的形态 `环节标签 · 行名`，取最后一段；无分隔符整串即名字）
   在两次 run 同位环节都能找到 ⇒ 进 `cases`：`fail→pass` 记改善、`pass→fail` 记退步。
4. `refs` 里点名的评估器 ⇒ 只算那些指标；`refs` 只点名了用例 ⇒ 指标不参与；`refs`
   为空或一个都对不上（线上会话 id 下次不再出现）⇒ 环节全部头部指标参与。
5. 指标的硬事实 = 穿越目标线 `SCORE_TARGET = 0.70`（与 CONTEXT.md「目标线」、
   `diagnosis.LOW_SCORE_THRESHOLD`、前端 `derive.SCORE_TARGET` 同一条；方案本身没有
   阈值字段）：`before < 0.70 <= after` 改善、`before >= 0.70 > after` 退步；
   `breached` 的硬事实 = `>0 → 0` 改善、`0 → >0` 退步。线内/线外的移动不是结论。
6. 有改善无退步 ⇒ `improved`；有退步无改善 ⇒ `regressed`；两者都有 ⇒ `inconclusive`
   （`reason` 写处数）；一个可比的数/行都没有 ⇒ `inconclusive`；其余 ⇒ `unchanged`。
