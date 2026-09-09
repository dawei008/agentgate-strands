# 0010 run 明细只存 S3，DynamoDB 只存摘要

Status: accepted（2026-08-24）

## Context

2026-08-24 09:08 的 plan run `plan-8c7b6ad3cd5d#20260824090808`（方案
`dsh-eval-1式`，单个 redteam 环节，20 条攻击）整段明细丢失。用户实付约
1.81 USD，最终只拿到

```
{type: "redteam", status: "error",
 error: "An error occurred (ValidationException) when calling the PutItem
         operation: Item size has exceeded the maximum allowed size"}
```

没有 `report`、没有 `results`、没有任何对话。

### 实测体积账（按事故规模重建：20 攻击 × 13-16 轮 × 单条最长 1344 字符）

`redteam._save_run` 把整个 run 序列化进 DynamoDB item 的 `data` 属性：

| 字段 | 体积 | 占比 |
|---|---|---|
| `results[].conversation` | 1110 KB | 52% |
| `live_turns` | 964 KB | 45% |
| `cases` | 58 KB | 3% |
| `analysis` | 7 KB | 0.3% |
| 其余全部标量 | <1 KB | — |
| **合计** | **2141 KB** | **= 400KB 上限的 5.35 倍** |

两个大头都是纯明细。中文按 UTF-8 约 3 字节/字符，是真正撑爆按字节计的上限的
原因。反推：**8 条攻击（940KB）就已经超限** —— 这不是极端规模，是日常规模。

关键澄清：`planrun._persist` 从来不是元凶，它本来就只写摘要（实测 8 KB），
明细本来就走 S3。炸的是 redteam 子 run 自己的 RTRUN 落库，异常沿
`_run_redteam_stage` 冒泡，被 `execute_plan_run` 的环节级 catch 收敛成三个键。
`testrun._save_run`（pk=RUN）是同一份代码形状、同一个病：多轮 case 的
`conversation` 同样整份进 item。

## Decision

1. **明细只走 S3，DynamoDB item 只存能保证放得下的摘要。** 统一由
   `app/runstore.py` 实现，RTRUN 与 RUN 两条通路共用。
2. **写序：S3 先落定，`detail_s3_key` 只在上传返回后才写进 item。** item 永远
   不会指向不存在的对象。
3. **超限绝不降级为 error。** 逐级剥离（`live_turns` → `results[].conversation`
   → `cases` → `results`），按体积占比从大到小、损失从小到大。
4. **剥离必留痕，且必须先归档。** `detail_truncated` / `detail_dropped` /
   `detail_s3_key` / `conversation_turns` / `live_turns_total`。不变式：
   **凡剥离过，必已归档**，因此剥离会强制触发归档（哪怕是运行中的 checkpoint）。
5. **归档失败也不改 status。** 落 `detail_error` 说明明细去哪了，run 的真实
   终态（completed/failed）保持不变。
6. **环节失败要打捞 checkpoint。** 攻击已经跑完、钱已经花了、每条都 checkpoint
   过，`_run_redteam_stage` / `_run_dataset_stage` 出错时回读 checkpoint 挂进
   `report` 并标 `salvaged`，而不是塌成三个键。

`live_turns` 尾部按**字节**（48KB）而非条数截断：1500 字符/条 × 3 字节的 CJK
让「保留 60 条」实际吃掉 270KB，把 per-result 摘要挤没了。改字节预算后同样的
事故 run 落到 189KB（上限的 47%），留出真实余量。

## Consequences

- 新增 `app/runstore.py` 为 run 落库的唯一入口；`redteam._save_run` /
  `testrun._save_run` 都是它的薄封装。**新增任何 run 类落库都必须走它**，
  不要再写裸 `put_item(Item={... "data": json.dumps(run)})`。
- 读路径 `get_redteam_run` / `get_test_run` 默认回补 S3 明细；进度轮询传
  `detail=False` 走纯摘要，不为读一个计数器付一次 S3 往返。
  `list_*_runs` 只读 item，不回补。
- 前端契约新增可选字段：`detail_truncated` / `detail_note` / `detail_error` /
  `conversation_turns` / `salvaged`。口径照旧「后端不给的数据一律不画不编」——
  拿到 `detail_truncated` 就诚实显示「明细过大，已存 S3」，不要渲染空对话。
- 测试依赖新增 `moto`（见 `tests/requirements.txt`，仅测试用，不进 Lambda
  镜像 —— 镜像只 build `app/`）。moto 会真实施加 400KB 上限，事故因此可复现。
- ADR-0003 的 score 口径不受影响：剥离只动明细，`breached`/`attacks`/
  `verdict`/`score` 等聚合值永不剥离。
