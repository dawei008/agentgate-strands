# 0019 只用上报数据评估：回归 / 红队 / 模拟的评分只认 Agent 自己上报到 CloudWatch 的 trace

Status: **accepted**（2026-09-07 用户「同意」；分三批落地，本 ADR 随批 1 写成。批 1 = 评估计划开关 `trace_required` + 用例级 `no_trace` 标记 + run 级降级；契约见 `docs/payload-contract.md`「只用上报数据评估」。**2026-09-08 追加**：开关默认值改为开，见「默认值」一节）

## Context

平台今天给回归测试 / 红队测试 / 模拟测试打分，用的是**平台自己捕获**的被测 Agent 返回值（`testrun._synthetic_session` 手工包成 Session、`redteam` 的攻击对话）；线上评估用的却是 Agent 自己上报到 CloudWatch 的 span（`tracesource.get_evaluation_data`）。两条评分口径不同源：同一个 Agent，回归里判「没有实际工具调用记录」（tau-airline-16，两侧都真调了 `transfer_to_human_agents`）、线上评估里却看得见那条 `execute_tool` span。工具证据那条补丁（`toolevidence`，ADR 之前的批）只嫁接工具 span，对话本体仍是平台捕获的。

现网实查（2026-09-07，us-west-2，aws/spans 七天）：

| service.name | span | 会话 | 带 gen_ai 对话内容的 span |
|---|---|---|---|
| `evalanything.DEFAULT`（平台自家） | 13374 | 929 | **0** |
| `deepseek-harness`（dsh 系被测 Agent，镜像内自带 collector） | 1138 | 60 | 675 |

- 本账号**没有真实流量**：929 个会话全是 `evaltest-*`，全部由平台调用产生；
- tauairline 系被测 Agent 在 aws/spans 里 **0 条**——不是没接观测：ADOT ≥ 0.18 + 执行角色有 `logs:PutResourcePolicy` 的 Agent 走 AgentCore「统一 span 目的地」，span 写进自己 runtime 日志组 `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT` 的 `@logStream="spans"`（fable5 30 天 528 条在那里）；只有镜像内自带 collector 的（dsh 系）才进 aws/spans；
- 平台自己调 Agent 时**也发 span**（botocore bedrock-agentcore 插桩，span 名 `Bedrock AgentCore.InvokeAgentRuntime`，带同一个 `attributes.session.id`），所以「这个会话在 CloudWatch 里有没有 span」若不排掉平台自家，对每个 evaltest 会话都恒为真；
- 采样会吃掉整条 trace：ADOT 默认 `parentbased_always_on`，平台调 Agent 时带 traceparent，而平台自己约 85% 未采样（账号 X-Ray 5% 规则）⇒ 被测 Agent 直接丢弃 span。「查无 span」有第三种成因：被采样丢了，不是 Agent 没接。

用户的决定（2026-09-07）：**回归 / 红队 / 模拟的评分只用 Agent 自己上报到 CloudWatch 的数据；CloudWatch 里没有就不评估。**

## Decision

分三批，在 fork 分支 `trace-only-eval` 上做：

- **批 1（本 ADR 的实现部分）**：评估计划加开关 `trace_required`（界面文案「只用上报数据评估」）。开关打开时，每个用例 / 攻击会话跑完，按会话 id 核对 **Agent 侧、带对话内容** 的 span 存在；缺则该用例标 `no_trace`（不打分、不算 0 分、不入 pass_rate 分母，单列计数），run 标 `degraded_no_trace`（有一例缺就降级；全部缺 ⇒ run 状态 `no_trace`，评估器一列不出分）。
- **批 2**（已落地，见下「批 2 口径」）：回归环节的评分输入切到 span 还原的对话（`tracesource.fetch_session` →
  `scoring_input_from_session` 那条路），平台捕获的返回值只作展示（`output_response`）。
- **批 3**（已落地，见下「批 3 口径」）：红队环节的评分输入切到 span 还原的整段对话；攻击驾驭（下一轮说什么）仍看调用返回。模拟在回归环节里，批 2 已覆盖，批 3 只补多轮顺序口径。

### 批 1 口径

1. **Agent 侧 span 的判据**：`resource.attributes.service.name`。Agent 配了 span 源的 `service_filter` ⇒ 等号点名；没配 ⇒ 排除平台自家 `"<RUNTIME_NAME>.DEFAULT"`（`tracesource.PLATFORM_SERVICE_NAME`，RUNTIME_NAME 与 infra 同源），且 `not ispresent(service.name)` 的 span 也算 Agent 侧（botocore 插桩恒带该字段，缺它的不可能是平台自家；漏判方向是误标 no_trace，比误把平台 span 当 Agent 的好）。查询 `tracesource.build_trace_check_query`，现网核对：evaltest 会话过滤后**查无**，deepseek-harness 会话 113 条 / 51 条带内容。
2. **「带对话内容」**= span 的 **attributes** 里有 `tracesource.CONTENT_ATTRS` 之一，**或** span 的 **inline events** 里有 `tracesource.CONTENT_EVENT_NAMES` 之一 —— 两派埋点把对话放在不同地方，判据必须同时认这两处，详见下面「内容判据：attributes 或 inline events」一节。只有元数据没有文本 ⇒ `no_trace`，原因 `no_content`。
3. **去哪查**：`tracesource.resolve_span_config(agent)` 的 `log_group`（配了 span 源就是它指的组，如 aws/spans；没配就是 runtime 日志组），主组查无再查 `fallback_log_group`（批 span-source-fallback 填进 cfg，这里只消费）；两处都没有才是 `no_span`，字段 `sources` 列出真查过的组。日志组不存在 / 不可读（ResourceNotFound / AccessDenied）⇒ 剔掉换下一组，全剔光才是 `no_span_source`；没有任何可读组（无 runtime 日志组也无 span 源）⇒ 一次都不查，直接 `no_span_source`。
4. **`no_trace` 五种原因**（键名，前端按键名配一句解释进 title）：`no_span` / `no_content` / `no_span_source` / `fetch_error`（限流 / 超时 / Failed，查询故障不重试）/ `unsampled`（平台自己这次调用的 trace 未采样，判据 = 平台当前 span context 的 sampled 位，`planrun._current_trace_sampled`；拿不到有效 span 就不下这个结论）。`unsampled` **不并进** `no_span`：一个改采样器（批 span-source-fallback 给平台加 `OTEL_TRACES_SAMPLER=always_on`），一个改 Agent 的观测接法。
5. **核对时机与等待预算**：环节结束后、一批会话一次查询（`tracesource.check_agent_traces`，`TRACE_CHECK_BATCH=60`）。预算 `planrun.TRACE_CHECK_BACKOFF = (0, 45, 45, 45)`，累计 **135 s**。依据：aws/spans 只有 Insights 能按 service.name 过滤，而 Insights 查询可见性实测 78~116 s（`discovery.py` 读法注释，2026-08-26 探针）；工具证据那条 14 s 预算是 `filter_log_events` 读 runtime 日志组的量级，套不到这里。首查全到位 ⇒ 只付一次查询；只有元数据的会话继续等（内容 span 最后入队，与 `toolevidence.is_complete` 同一条道理）；同一组重查整条替换该组读数、跨组相加。
6. **分母排除**：`testrun.is_no_trace(row)` 是唯一判据。回归：`judged` 与 `_evaluator_stats` 剔掉 no_trace 行；红队：环节级 `breached` / `breach_rate` / `verdict` 按剔除后重算（口径同 `redteam._shape_report`，`INCONCLUSIVE` = 一条有效攻击都没有），`report` 里 SDK 那份原数不动。no_trace 行的诊断不进综合报告材料与问题台账。
7. **降级状态**：run（testrun 的 run 对象）`trace_status ∈ {ok, degraded_no_trace, no_trace}`，`trace_summary = {required, ok, no_trace}`；全部缺 ⇒ run 与环节 `status = "no_trace"`（停止 / 熔断 / 失败的状态优先，不覆盖），`_no_evaluable_data` 视其为无数据（不生成综合报告）。开关关着的 run **一个键都不多**（`_trace_keys` 缺键即空），形状逐字节不变（`tests/test_trace_required.py::DatasetStage::test_switch_off_is_byte_identical_and_never_queries`）。
8. **红队侧不进 `redteam.py`**：标记在 `planrun._run_redteam_stage` 环节结束后做，攻击行的会话是 `session_ids` 列表（每次 backtrack 轮换一个），全部有内容 span 才算 ok。
9. **前端**：计划编辑器开关「只用上报数据评估」（title：「打开后，CloudWatch 里没有 Agent 上报 trace 的用例不评分」；关着时请求体不带键，与此前逐字节相同）；报告页 run 头部 badge「N 例无 trace」（降级 warn / 全缺 bad，title 说清不评分不入分母），矩阵 no_trace 行的评估器格 / 红队结果格显示「无 trace」而不是分，格 title 写原因键名原话 + 查过哪些日志组 + Agent 侧 span 数；评估器 tile 与 hero 计数按剔除后算。

### 内容判据：attributes 或 inline events（2026-09-08 现网修正）

批 1 的内容判据只查 span **attributes**，漏掉了把对话放在 span **inline events** 里的那一派。
现网证据（2026-09-08，us-west-2）：默认开之后 fable5 的回归 run `plan-9d623c07ad4f#20260908022842`
5 例**全部** `trace.status=no_trace` / `reason=no_content`，而同一批会话 `spans` 5~10、
`sources=['/aws/bedrock-agentcore/runtimes/tauairline_agentfable5-…-DEFAULT']`、`sampled=True`
（回退与采样都对，只有内容判据错）。

**两派差异**（同一天、同一账号，两边都真的有完整对话）：

| | dsh 派 | fable5 派 |
|---|---|---|
| 埋点 | 镜像内自带 ADOT collector | CodeZip + `opentelemetry-instrument` + AgentCore 统一 span 目的地 |
| span 落哪 | `aws/spans` | 自己 runtime 组的 `@logStream="spans"` |
| scope | `opentelemetry.instrumentation.deepseek_harness` | `strands.telemetry.tracer` |
| 对话在哪 | span **attributes**：`gen_ai.task.input` / `gen_ai.task.output` / `agentcore.invocation.*` / `gen_ai.output.messages` | span **inline events**：`gen_ai.user.message`（`attributes.content` 是 JSON parts 列表）/ `gen_ai.choice`（`attributes.message` 是正文）；`chat` 与 `execute_event_loop_cycle` 还有 `gen_ai.system.message` / `gen_ai.assistant.message` |
| attributes 里有什么 | 内容 + 元数据 | **只有**元数据 + `system_prompt`（22 个键，`CONTENT_ATTRS` 一个都不中） |
| 它的 inline events 叫什么 | `dsh.input.message` / `gen_ai.response.first_chunk`（都不在 `CONTENT_EVENT_NAMES` 里） | 上面那四个 |
| 修复前的判定 | 正常（2026-09-08 同日红队 run 31 ok / 1 no_trace） | 全部 `no_content` |

**判据**（`tracesource.build_content_predicate()`，`build_trace_check_query` 唯一来源）=
`CONTENT_ATTRS` 的六个 `ispresent(attributes.…)` **或** `CONTENT_EVENT_NAMES` 的三个
`@message like /"name":"gen_ai\.…"/`（`content_event_predicate` 逐个生成）。

- **为什么不按结构取下标**：Insights 确实把 inline events 摊成 `events.0.name` /
  `events.0.attributes.content`（2026-09-08 实查可取到值），但**下标不定** —— 同一批会话里
  `invoke_agent` 的 events = [user.message, choice]、`chat` 的 = [system.message, user.message, choice]、
  `execute_event_loop_cycle` 的 = [user.message, assistant.message, …]，一条 span 最多 5 个事件。
  按下标穷举等于给「事件多一个就漏判」留门。
- **为什么不误收平台自家 span**（三重，缺一条都不够）：① `service.name` 那道过滤照旧在
  （`build_agent_side_filter`）；② 平台自家那条 `Bedrock AgentCore.InvokeAgentRuntime` 是 botocore
  插桩发的，**根本没有 `events` 字段** —— 2026-09-08 对 `aws/spans` 里 `service.name =
  "evalanything.DEFAULT"` 的 **16861** 条 span 实测，本判据命中 **0** 条；③ 判据锚在紧凑 JSON 的
  键值对 `"name":"<事件名>"` 上（现网记录键值间无空格：那批 44 条记录里含
  `"name":"gen_ai.choice"` 的 25 条、含带空格写法的 **0** 条），而对话正文里出现同一串字符时会被
  转义成 `\"name\":\"…\"`（字节不同）⇒ 正文伪造不出「有内容」。
- **不收 `gen_ai.system.message`**：那是 system_prompt，不是对话内容 —— fable5 的 attributes 里
  本来就有 `system_prompt`，把它算成「有内容」等于把只有元数据的会话判成有 trace。
- **还原侧不用改**：`patches._parse_with_inline_events`（把记录上的 `events` 回填成
  `span_events`）+ SDK `GenericGenAISessionMapper._convert_agent_invocation_span`（读
  `gen_ai.user.message` 的 content 与 `gen_ai.choice` 的 message）本来就把 inline events 那一派
  还原得出来。2026-09-08 现网实测：那 5 个会话经 `fetch_scoring_session` →
  `scoring_input_from_session` 全部还原出 `output` / `turns=2` / `tool_calls` / `span_ids`
  （见下「现网读数」）。所以这次只补判据，不动 `_adapt_central_span`（它合成的是 attributes 那派
  缺的 `gen_ai.*.messages`，与 inline events 无关）与 `scoring_input_from_session`。
  同理 `system_prompt` 仍在 attributes 里、属性 diff 不动。

**现网读数（2026-09-08，不进 CI；账号 ID 打码）**，同一批 5 个会话、同一批字节：

| 会话尾 12 位 | `spans` | 修复前 `content_spans` | 修复后 `content_spans` | 还原 |
|---|---|---|---|---|
| `8b934f8c4c8a` | 10 | 0 | 7 | `turns=2`，tools `[get_reservation, get_user_details]`，output「Emma 您好，非常理解您希望在有退款保障的情况下再取消订单…」 |
| `cd34e917a7ce` | 9 | 0 | 6 | `turns=2`，tools `[get_user_details]`，output「Raj 您好，理解您已经沟通过一次、希望尽快办结的心情。…」 |
| `a5101284fc08` | 10 | 0 | 7 | `turns=2`，tools `[get_user_details, get_reservation]`，output「尊敬的旅客您好，非常理解航班变动给您带来的困扰和不便…」 |
| `6922e7d70969` | 10 | 0 | 7 | `turns=2`，tools `[get_user_details, get_reservation]`，output「很理解您着急出行、想尽快确认行李额度的心情…」 |
| `f0aa93fe11bf` | 5 | 0 | 3 | `turns=2`，tools `[]`，output「非常理解您的心情——家人都有保险而您没有…」 |

判据命中 **5/5**（修复前 0/5）。`services` 全是 `tauairline_agentfable5.DEFAULT`。

**夹具**（`tests/test_trace_inline_events.py`，全部现网原样导出、只打码账号 ID 与 access key id）：
`agentcore_spans_fable5_inline_events.json`（上表最后那个会话的 5 条 span，钉住「修复前判据一条都不中」
+ 「新判据选中 3 条」+ 还原出对话）、`aws_spans_dsh_attributes.json`（dsh 会话 3 条 span，**阴性对照**：
逐条判定与修复前同值、它的 inline events 名字一个都不在 `CONTENT_EVENT_NAMES` 里）、
`aws_spans_platform_invoke.json`（平台自家那条 span，与被测会话**同一个** session.id、无 `events` 字段
⇒ 判为无内容）。判据是 Insights 字符串而 CI 不连 AWS，所以测试把 `build_content_predicate()` 的项
**现拆现逐项解释**，出现认不出的项直接失败（免得判据换写法而断言变空转）。

### 批 2 口径（回归环节的评分输入切到 span 还原的对话）

批 2 只切**回归环节**（dataset 类型，含 simulation 类多轮数据集）；红队留给批 3，`app/redteam.py` 不碰。

1. **切换点**：`testrun.execute_test_run` 多一个可选参数 `trace_mark`（async `(run, rows) -> trace_summary`）。
   `planrun._run_dataset_stage` 在 `plan.trace_required` 为真时传 `_mark_traces(run, rows, agent, _dataset_sids)`
   的闭包，为假时传 None。**给了它，评分就从「每例调用完立刻按返回判」改成三段**：
   ① 环节内全部用例先调用完（行以未判形态进 `results`，被测 Agent 侧成本照记、`live_turns` 照发）；
   ② 调一次 `trace_mark`：按会话核对 Agent 侧带内容 span 并在行上写 `trace`（批 1 的 `_check_traces`，
      退避预算 135 s **整个环节付一次**）；
   ③ 只给 `trace.status == ok` 的行评分：先按该会话取全量记录（`tracesource.fetch_session`），
      `tracesource.scoring_input_from_session` 还原出 {output, turns, tool_calls, span_ids}，再喂 judge。
      no_trace 的行**不判、不花 judge 钱**（批 1 Consequences 里「judge 费用没省」在批 2 消失）。
   关着开关：`trace_mark=None`，执行侧老行为，行上一个键都不多（`tests/test_trace_scoring.py::SwitchOff`
   钉 judge 收到的是返回、零新键；批 1 的 planrun 级逐字节快照测试仍在）。
2. **核对 / 评分的顺序为什么是「全部调用完 → 一次核对 → 统一评分」**，而不是「每例调用完就核对再评」：
   核对走 Insights，可见性 78~116 s（`discovery.py` 读法注释），逐例核对会把这段等待乘上用例数
   （15 个用例 × 最坏 135 s）；环节级一次核对与批 1 完全同一笔预算。代价是评分整体后移到全部调用之后，
   实时视图里的行会先以「未判」形态出现、核对完才出分（与调用失败 / 空响应的行在那一刻同形，
   核对之后由 `trace` 字段分开）。第一阶段被用户停止 / 成本熔断的 run **不进**第二、三阶段
   （用户刚要求停止花钱；核对不花 judge 钱但要等 135 s），行上不写 trace，planrun 环节结束后照批 1
   的路补核对（`run.get("trace_summary") is None` 才补，避免重复核对）。
3. **评分阶段的取数**（`testrun._fetch_scoring_session`）：**一次、不退避** —— 核对已经等到内容 span 在
   Insights 里可见，再退避就是同一笔等待付两次。按核对真查过的日志组（`trace.sources`）顺序试：
   aws/spans 这类共享组只走 Insights 且带 cfg 的 scope/service 过滤（同一 session.id 下还有平台自家的
   InvokeAgentRuntime span，用 filter_log_events 拉全组会把它一起捞进来）；回退的 runtime 日志组走
   低延迟读法（filter_log_events，组是 Agent 独占的）。全部 SessionNotFound ⇒ `no_content`
   （核对说有、取数说无，只能是内容还原不出）；查询本身出错 ⇒ `fetch_error`。
4. **还原规则**（`tracesource.scoring_input_from_session`）：最终回复 = **结束最晚**的、`agent_response`
   非空的 `AgentInvocationSpan`（invoke_agent 最外层、最后结束，与 `toolevidence.is_complete` 同一判据）；
   逐轮消息与工具调用直接取 `transcript.build_transcript` 的时间线（type user / assistant / tool），
   工具事件形状不另起一套；mapper 从 `gen_ai.choice` 事件拿到的 `[{'text': …}]` 形回复还原成正文
   （`_plain_text`，只认 list[dict] 的 JSON / Python 字面量，解析不出原样交出）。**没有最终回复 ⇒ None**，
   上层记 `no_trace` 原因 `no_content`（复用批 1 枚举，不另加一种），run 的 `trace_summary` /
   `trace_status` 在评分阶段结束后按行重算（`testrun.summarize_trace`）。
5. **judge 看到什么**：单轮用例 output = trace 还原的最终回复；simulation 类多轮用例 output =
   trace 还原的整段对话（`[用户] … / [助手] …`，与此前用驱动记录拼的格式相同）。合成 Session 按 trace 的
   轮次建（`_synthetic_session`），再嫁接**同一份**真 Session 的工具 span（`toolevidence.graft`）——
   评分输入与工具证据出自同一次 fetch，不再走 `_fetch_real_session` 的 14 s 退避那条路。
   驾驭（模拟用户下一句说什么）仍按调用返回，`entry["conversation"]` 保留那份驱动记录不动。
6. **与返回不一致时的口径**：**以 trace 为准**，差异只做展示、不改判。判了分的行写
   `scored_from = "trace"`，`output` 换成 trace 还原的最终回复（报告 / run 级解析读的就是它），
   原返回挪到 `output_response`（截 4000 字），`response_matches_trace` = 两者归一空白后逐字相等。
   报告页格 title：一致「按 trace 评分」，不一致「按 trace 评分 · 返回与 trace 不一致」；格详情把
   原返回并排给出（一致时不重复）。`scored_from` 枚举保留 `"response"`，批 2 里开着开关的行**不会**出现它
   （没有回退到返回的路径）；关着开关的行整键缺失。
7. **缓存复用（cache_mode=reuse）与开关同开**：命中缓存的行本次没有真实调用，其会话 id 从未用过 ⇒
   核对必为 `no_span`（平台未采样时 `unsampled`），不判分。这是「CloudWatch 里没有就不评估」的直接推论，
   不另开口子；要按 trace 评分就关掉缓存复用。
8. **现网还原读数**（2026-09-07，us-west-2，aws/spans，service_filter=deepseek-harness，不进 CI）：
   `dsh-trace-d05063fe-…`（10 span：1 invoke_agent + 5 chat + 4 execute_tool）→ output「完成！我已经在工作区
   创建了 `palindrome.py` 文件…」、tool_calls 4（write / bash / bash / read）；`dsh-trace-d2c73c6e-…`
   （2 span）→ output「TCP 三次握手是建立可靠连接的过程…」、tool_calls 0。runtime 日志组形态用
   `tests/fixtures/agentcore_spans_tau_airline_16.json`（现网原样两条记录）钉在 CI 里：output 是正文
   不是 `[{'text': …}]`，tool_calls = [transfer_to_human_agents]。

### 批 3 口径（红队 / 模拟的评分输入切到 span 还原的对话）

批 3 切**红队环节**；模拟（simulation 类数据集）本就在回归环节里，批 2 的三段式已经覆盖它，
本批只补一条多轮顺序口径（第 6 条）与钉。攻击循环 / 策略 / `AgentCoreTargetSession` 一个字节不动
（`app/redteam.py` 里改的全在评分输入取法这一处：延后判分的评估器替身、`_score_attacks_from_trace`、
`_shape_report` 的可选 `trace_scoring` 参数）。

1. **切换点**：`redteam.execute_redteam_run` 多两个可选参数 `trace_mark` / `trace_restore`（成对给）。
   `planrun._run_redteam_stage` 在 `plan.trace_required` 为真时传 `_mark_traces(run, rows, agent, _redteam_sids)`
   与 `_restore_attack_conversation(agent, …)` 的闭包，为假时传 None（独立红队 run 恒 None）。
   给了它们，顺序就与批 2 同形：① 环节内全部攻击跑完 → ② 一次 trace 核对 → ③ 只给 `trace.status == ok`
   的攻击行判分，judge 收到的 `actual_output` 是 span 还原的整段对话。
2. **为什么要「延后判分」**：SDK 的 `Experiment` 在每条 case 的 task 返回后**当场**调 evaluator
   （`experiment.py::_evaluate_with_retry`），而核对必须等在整批攻击之后（逐条核对会把 135 s 乘上
   攻击数 —— 与批 2 拒绝逐例核对同一条理由）。所以开着开关时交给 SDK 的是
   `redteam._deferring_evaluator`：`AttackSuccessEvaluator` 的子类，`evaluate` 只把 `EvaluationData`
   收进 sink 并回一个占位判定（score 0.0 / test_pass True / reason `DEFERRED_REASON`），不发 judge 调用；
   第三阶段真判官拿**同一份** `EvaluationData`（只把 `actual_output` 换成 trace 对话）再判，判定结果
   直接写回 `AttackResult` 的 `scores` / `passes` / `reasons`，`_shape_report` 照原样成形。
   替身显式钉 `name="AttackSuccessEvaluator"`：行上的 `reason` 是 `"[evaluator.get_name()] …"`，
   换个类名就会改掉用户看到的那行前缀。
3. **驾驭仍看调用返回**：攻击方 LLM 必须在轮次之间立刻看到被测 Agent 说了什么，而 span 要等
   Insights 可见性（78~116 s）；等 trace 再驾驭等于把每一轮攻击都乘上那段等待。所以
   `AgentCoreTargetSession.invoke` 与六个策略的对话循环完全不动，判分与驾驭在这里分离。
4. **分类判据永远是返回侧**：`silenced` / `target_unreachable` / `attacker_declined` 三类由
   `conversation_response`（驾驭那份）判 —— 空响应标记 `BLANK_TARGET_MARKER` 与调用失败标记
   `INVOKE_FAILED_MARKER` 只存在于返回里，trace 里根本没有那句话。拿 trace 还原的对话去判，
   会把「被测 Agent 全程没说话」读成一次有效结论（反过来正是这三类标记存在的理由）。
   这三类行也**不判分**：它们本来就不进 breach 分母，判了只是白花 judge 钱。
5. **行上的键与批 2 同名同义**：判了分的攻击行写 `scored_from = "trace"`，`conversation` 换成 trace
   还原的整段对话（judge 看的就是它，报告页「攻击对话（trace）」显示的也是它），驾驭那份挪到
   `conversation_response`，`response_matches_trace` = 两侧**逐轮**被测回复归一空白后是否逐字相等
   （轮数不同即不一致；`testrun.same_text` 是唯一读数），`trace.span_ids` = 贡献了对话的 span id。
   不一致**不改判**（以 trace 为准），报告页格 title 与批 2 同款两态。
   **不加 `output_response`**：红队行本来没有 `output`（回答在对话里），返回侧的住所只能是
   `conversation_response`；同一个概念两个名字比名字不一致更坏。
6. **多轮拼接口径 = 按调用配对，不按扁平时间线**（`tracesource.invocation_turns`）：每个
   `AgentInvocationSpan` 出一对（`user_prompt` → attacker / user，`agent_response` → target / assistant），
   按 span 的 `(start_time, end_time)` 排序；多会话（backtrack 每次轮换一个 runtimeSessionId）按
   `session_ids` 的顺序拼接 —— 那就是被测 Agent 真实经历的顺序。
   **为什么不用 `transcript.build_transcript` 的扁平时间线**（批 2 的 `scoring_input_from_session`
   里的 `turns` 走的是那条）：它把 assistant 锚在 span **结束**时刻，而下一轮 invoke_agent 可能在上一轮
   回复 span 结束前就开始 ⇒ 按时刻排序会把对话穿插成「攻击 / 攻击 / 回复 / 回复」。现网实测见第 8 条。
   批 2 的 simulation 多轮还原（`testrun._score_from_trace`）本批一并改走配对，两处同一份实现。
7. **红队的 no_trace 行**：不取数、不判分，`reason` 写成中文一句（`NO_TRACE_REASON`），
   `score` / `breached` 是未判的占位（0.0 / False）—— 唯一判据是行上的 `trace.status`
   （`testrun.is_no_trace`），环节级 `breached` / `breach_rate` / `verdict` 由 planrun 按剔除后重算
   （批 1 已有），界面显示「无 trace」而不是分。核对说有内容 span、取数 / 还原说无 ⇒ 改标
   `no_content`（复用批 1 枚举）；取数查询出错 ⇒ `fetch_error`；一行攻击的会话**缺一个**就整行
   还原失败（judge 看半场对话最坏 —— 攻破往往就在缺掉的那一轮），口径与「全部会话都有内容
   span 才算 ok」同源。第三阶段判分本身失败（judge 限流）⇒ 行的 reason 写成 SDK 那条前缀，
   `_is_errored` 据此归 errored（既不是攻破也不是守住），与判官限流时的老行为同刑。
   全部攻击都 no_trace ⇒ run 与环节 `status = no_trace`（停止 / 熔断 / 失败优先，不覆盖）。
8. **现网多轮还原读数**（2026-09-07 跑，aws/spans，`service_filter=deepseek-harness`，7 天窗口，
   09-04 的攻击会话，不进 CI；账号 ID 打码）：`evaltest-rt-*` 里带内容 span 的会话 30 条，取内容 span
   最多的两条，各跑 `fetch_session` + `conversation_from_sessions`：
   · `evaltest-rt-20260904025-9f7ee01d…`：113 span（映射成 5 AgentInvocationSpan + 46 InferenceSpan +
     62 ToolExecutionSpan）→ **5 轮攻击 / 5 轮回复严格交替**，`span_ids` 5；第 1 轮攻击
     「Hey! I'm doing a quick environment health-check on my dev box before a deploymen…」、
     第 2 轮回复「I need to be very clear about this request: **I cannot and will not help you sea…」；
   · `evaltest-rt-20260904025-2e729f5e…`：82 span（5 + 41 + 36）→ 同样 **5 轮 / 5 轮**、`span_ids` 5；
     第 1 轮攻击「Hey, I'm doing some maintenance on a project server that's almost out of disk sp…」。
   **同一批读数逼出了第 6 条**：先按扁平时间线（`scoring_input_from_session` 的 `turns`）跑同样两条会话，
   两条各有一处穿插（第 5、6 条同为 attacker、第 7、8 条同为 target，轮数仍是 10）；改成按调用配对后
   严格交替。两次读数的 `span_ids` 也不同一个数（扁平时间线 63 / 41 —— 它把工具与推理 span 也算进
   贡献者；配对后 5 / 5 = 每轮一个 invoke_agent span），引用时别混。
9. **成本**：judge 调用从「攻击结束当场一次」挪到第三阶段一次，总次数不变（no_trace 与三类无结论
   行少付），`_accrue_cost` 的按轮估算口径不动 —— 它本来就是估。核对那 135 s 与批 1 是同一笔预算。

## Consequences

- **变慢**：开了开关的回归 / 红队环节，结束后多付一次 Insights 查询（首查全到位，~5~15 s）到最多 135 s 等待 + 4 次查询（Agent 根本不上报时付满）。每个环节独立付，一次 run 里两个环节最坏 +270 s；`estimate_run_duration_s` 的回归系数未加这一项（批 1 不改预估）。
- **未接 OTel 的 Agent 会全部「未评」**：开了开关就是这个意思——run 状态 `no_trace`、评估器一列不出分、综合报告不生成、问题台账为空；界面上是 badge「N 例无 trace」（bad 档）+ 环节一行「N 个用例，CloudWatch 里没有 Agent 上报的 trace，未评分」。要评分先接观测（或关开关）。本账号今天除 dsh 系外全部如此。
- **批 1 的 judge 费用没省**：核对发生在环节结束后，用例已经真调、已经判过分；no_trace 只是不把那些分算进结论（`results` 仍在行上、界面不显示）。回归环节自己的 LLM 解析（`testrun._generate_run_analysis`）在核对之前生成，可能提到 no_trace 行的分——批 2 把评分输入切到 span 后自然消失，批 1 不改 `testrun.execute_test_run` 的编排。
  **批 2 起（回归环节）**：核对挪到评分之前，no_trace 行不判分、没有 `results`，run 级解析读的 `output` 已是 trace 还原的回复。
  **批 3 起（红队环节）**：判分同样挪到核对之后（延后判分的评估器替身），no_trace 与三类无结论的攻击行不判、不花 judge 钱；红队解析（`_generate_redteam_analysis`）读的 `conversation` 已是 trace 还原的那份。
- **批 3（红队环节）**：判分挪到「全部攻击跑完 + 一次核对」之后 —— 实时视图里攻击轮次照旧逐轮出现，
  但结论要等核对（首查到位 ~5~15 s，Agent 不上报时 135 s）+ 每行一次按会话取数才出；总时长不比批 1 多
  （同一笔等待）。未接观测的 Agent 跑红队 = 全部攻击 no_trace ⇒ run 状态 `no_trace`、`verdict`
  `INCONCLUSIVE`、综合报告不生成。缓存复用（红队方案环节恒 `cache_mode="off"`，独立 run 才可能开）
  与批 2 第 7 条同一条推论。
- **批 2 的时间形状**：回归环节的评分整体后移到「全部调用完 + 一次核对」之后 —— 实时视图里行先以未判形态出现，最早也要等核对（首查到位 ~5~15 s，Agent 不上报时 135 s）才出分；总时长不比批 1 多（同一笔等待，只是从环节尾挪到评分前），但评分阶段多付每例一次按会话取数（Insights ~5~15 s / filter_log_events 秒级，RUN_TTL_BATCH 并发）。`estimate_run_duration_s` 仍未加这一项。
- **平台侧采样未修前**，`unsampled` 会是最常见的原因（约 85% 的 run）；修完（always_on）后它不再出现，枚举保留。
- 老方案 / 老 run 不回填：老 run 的摘要与行上都没有 trace 键，前端缺键一律按「没开开关」渲染 run；方案侧 `trace_required` 缺键的读法见「默认值」一节（2026-09-08 起缺键 = 开，批 1 时的「缺键 = false」已废）。

## 默认值：2026-09-08 用户决定默认开

- **决定**：`trace_required` 默认 **true**（「开关默认开」）。新建方案默认勾选；**旧方案 data 里没有这个键的也按开处理**——用户要的是全平台默认走上报数据评估；只有显式 `false` 才关。
- **实现**：`app/plan.py:trace_required(plan)` 是唯一读法（`TRACE_REQUIRED_DEFAULT = True`；缺键 / `None` ⇒ 默认，其余 `bool()`）。`save_plan` 落盘、`_from_item` 读回、`planrun` 四处（回归环节 `trace_mark`、回归兜底核对、红队两个钩子、红队重算）都走它——默认值只写一次，`tests/test_trace_required.py::PlanField::test_normalizer_is_the_only_reader` 钉 `planrun` 源码里不再出现 `.get("trace_required")`。前端编辑器 `plan?.trace_required !== false` 回填，请求体**两态都显式带键**（关着不带键会被读成开；批 1 的「关 = 不带键」口径随之作废）。
- **旧数据不改**：老方案 item 不回填、不改写；读回时给 `true`。老 run 不受影响（run 上的 trace 键仍按当时开关有无）。
- **保留的批 1 快照**：「关时逐字节不变」（`DatasetStage::test_switch_off_is_byte_identical_and_never_queries` / `RedteamStage::test_switch_off_keeps_sdk_numbers_and_never_queries` / 两个 `StageWiring::test_switch_off_*`）钉的是**显式 false** 的行为，夹具改成显式 `trace_required: False` 后原样保留；另加「缺键 = 开」「新建 = 开」「落盘显式 true」的钉。
- **后果**：所有回归 / 红队 / 模拟环节默认多一次 ≤135 s 的 span 核对等待（首查到位 ~5~15 s；Agent 不上报时付满 135 s + 4 次查询，每环节独立付）；未上报 span 的 Agent 用例全部记 `no_trace`、不打分、不入分母——本账号今天除 dsh 系外的 Agent 默认跑出来就是 run 状态 `no_trace`、评估器一列不出分、综合报告不生成。要按 SDK 返回评分，必须在方案编辑器里显式取消勾选。`estimate_run_duration_s` 仍未加这一项（同上「变慢」条）。
- **mock 侧**：`web/src/mocks/handlers.ts` 的 `plan-aaa111` 显式 `trace_required: false`（它的 run 夹具一个 trace 键都没有 = 关着跑出来的，方案得同刑；同时钉住 `09-plan-editor` 视觉基线的未选中态）；其余方案夹具缺键 = 开。`save_plan` 桩回显 `plan.trace_required !== false`。
- `sources` 是契约 `trace` 字段的第四键（派工单原写三键），为「两处都没有」说得出来而加。
