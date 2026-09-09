# 0008 定时表达式：双方言解析、单方言（EventBridge）落库

Status: accepted（2026-08，sched-impl 已合流）

## Context

方案定时用 EventBridge Scheduler 实现（`app/plansched.py:98` 把表达式
**原样**传 `ScheduleExpression`，无包裹转换）。EventBridge 只接受
`cron(分 时 日 月 周 年)` 六段包裹语法，且 dow 数字基准是 1=周日；而
用户熟悉的标准五段 cron 是 dow 0=周日。存量方案数据里还有
`rate(1 day)`。裸五段直传会被 Scheduler 拒收。

## Decision

前端 cron 引擎（`web/src/pages/plan/cronEngine.ts`）**解析双方言、
生成单方言**：

- 解析兼容两种输入（`cronEngine.ts:156` 起）：`cron(...)` 六段
  （? 视作 *，数字 dow 按 1=周日平移）与标准五段（dow 0=周日），
  内部统一为标准语义。
- 保存前归一（`normalizeSchedule`，`cronEngine.ts:438`；调用点
  `PlanEditor.tsx:191`）：空串直通（仅手动）、`rate(...)` 直通不解析
  （`cronEngine.ts` isRate，引擎无 cron 语义可推算）、合法 cron 一律
  归一成 EventBridge `cron(...)` 形态；非法表达式在前端拦下不发请求。
- 归一输出的 dow 用 SUN–SAT 英文名（`toEventBridge`，
  `cronEngine.ts:377-390`）——名字在两方言里无歧义，回避数字基准差异。
  dom/dow 同时限定被拒绝（EventBridge 不支持标准 cron 的「或」语义）。
- 编辑回填分档（SchedulePicker 三档：仅手动/简单/高级）：能无损解析进
  简单档的形态白名单见 `cronToSimple`（`cronEngine.ts:400` 起），
  其余（步长/限月/日>28/rate 等）进高级档原样保留。
- 后端不做方言转换，只做形状校验：`app/plan.py:112` 要求
  `cron(...)` 或 `rate(...)` 形态，并强制 `budget_usd > 0`
  （`app/plan.py:114-117`，定时触发无人在场确认成本）。

## Consequences

- 方言知识集中在前端一处；后端与 Scheduler 之间零翻译，出错面小。
- 历史裸五段数据在下次编辑保存时被自动归一（双读的写侧收敛）。
- 现状注记（2026-08-24）：前端保存发送的 `schedule` 是字符串
  （`PlanEditor.tsx:202`），而后端校验按对象
  `{"cron": ..., "budget_usd": ...}` 读取（`app/plan.py:111`）——
  两侧契约尚未接平，预算字段的前端录入是已知缺口，不属于本决策内容。
