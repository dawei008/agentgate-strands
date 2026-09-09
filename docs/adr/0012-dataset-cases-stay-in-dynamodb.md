# 0012 数据集 cases 留在 DDB 单条 item，保存走字节预检

Status: accepted（2026-08-24）

## Context

DynamoDB 单条记录 400KB 上限已经真丢过用户数据（BH-005）：AI 生成的红队/模拟
用例全程不截断（`redteam.py` 的 opening message / target_context /
success_criteria 都是模型自由文本），200 条中文用例能到 ~1.2MB。条数闸门放行 →
`PutItem` 抛 `ValidationException: Item size has exceeded the maximum allowed
size`。那是 `botocore.ClientError`，不是 `ValueError`，穿透 `main.py`
save_dataset 分支当时的 `except (KeyError, ValueError)`，穿出 async generator，
流上只剩框架层一帧无 `event` 字段的遗言 —— 用户看到「保存失败但不知为何」，而
刚生成的用例只在前端组件态里，刷新即丢。

同一个 400KB 上限，run 明细那边走的是**外溢 S3**（`023400e`，定型于
[ADR-0010](0010-run-detail-lives-in-s3-not-dynamodb.md)：DDB 只存摘要，明细在
S3）。所以「数据集为什么不照抄这个先例」必须写下来，否则将来必然有人对着
runstore 重提。

## Decision

**数据集的 `cases` 不外溢，继续存在 `pk="DATASET"` 的单条 item 里；`save_dataset`
在 `put_item` 之前做字节预检，超限则拒绝写入并抛可行动的 `ValueError`。**

- 预检口径：`DDB_ITEM_LIMIT = 400 * 1024`，`SAFE_ITEM_BYTES = DDB_ITEM_LIMIT -
  4 * 1024`（`catalog.py:168-171`）。留 4KB 余量的理由写在代码注释里：DDB 自己
  算的字节数与本地估算有差（数字属性编码等），且卡在 399KB 通过的写入，下次
  编辑多带一个 `risk_categories` 就会失败。
- 量的是**整条 item**（`catalog.py:318-325`），继承来的 `source_keys` /
  `risk_categories` 占同一份预算，不是只量 `cases`。
- 抛 `ValueError` 而不是让 `PutItem` 抛 `ClientError`：只有 `ValueError` 能被
  `main.py:595` 的 `except (KeyError, ValueError)` 接住变成流上的
  `{"event": "error"}`。文案给「怎么办」——多少条、多大、上限多少、按当前平均
  每条可存多少条、拆分或精简哪些长字段（`_oversize_message`）。
- 预检不是唯一防线：`main.py:597-608` 另有兜底 `except Exception`，限流/凭证/
  传输类失败也必须有应用层遗言，不许把真因交给框架层遗言帧。

## Rationale

**① run 明细可渐进 shed，数据集的 `cases` 无可裁项。** ADR-0010 的外溢之所以
成立，是因为 run 明细可以「最大块优先」渐进裁剪：少一段 transcript 不影响这次
run 的结论。数据集的 `cases` 就是载荷本身 —— 少一条用例就是少跑一条，评估口径
直接变了。没有可裁的东西，就没有「优雅降级」这个选项，只剩「拒绝并说清楚」。

**② 外溢会把唯一读路径放大成 N 次 S3 GET。** `list_datasets()` 是唯一读 `cases`
的口，且**内联返回全部数据集的全部 cases**。全仓 7 个调用点，彼此独立、没有
任何缓存层：

| 位置 | 用途 |
|---|---|
| `main.py:584` | `list_datasets` action 本体（前端资源库的读口） |
| `plan.py:95` | 保存方案时校验引用的数据集存在 |
| `planrun.py:82` / `:108` / `:213` | 方案执行时按名取数据集（三处独立 `next(...)`） |
| `main.py:801` | AI 生成「追加到现有数据集」时取 existing_cases |
| `main.py:1072` | 按名取数据集 |

外溢后每次调用都放大成 N 次 S3 GET（N = 数据集个数），资源库与方案执行会随 S3
抖动整体不可用 —— 把一个「保存超大数据集会失败」的局部问题，换成一个「读路径
依赖 S3 可用性」的全局问题。

**③ 若将来真要外溢，正确形态是先拆读路径，禁止半个外溢。** 正确形态 = 新增
`get_dataset(name)` 单条读 + `list_datasets()` 只返 `case_count` 不返 `cases`。
这要动上表里 6 个内部消费点（除 `main.py:584` 的 action 本体外全部）+ 前端资源库
的列表渲染，**必须整批改完再切**。只把写路径改成外溢、读路径仍走
`list_datasets()` 拿全量，等于每次读都下载所有数据集的全部用例 —— 比现在更差。
半个外溢比不外溢危险，这是这条 ADR 最实际的用途。
