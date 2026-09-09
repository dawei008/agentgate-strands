# 0018 问题台账条目身份：fix_type × 证据行 × 会话 span，不含任何 LLM 文本

Status: **accepted**（2026-09-07；批 ledger-id-merge。修订 ADR-0016 ③ 台账的 `id` 口径，契约见 `docs/payload-contract.md`「问题台账」）

## Context

台账（`synthesis_issues`）的条目 `id` 原来是 `sha1(fix_recommendation)` 前 8 位（无建议时退到
`root_cause_explanation`），跨 run 合并只认这个 id。诊断管线（strands `diagnose_session`）是 LLM，
**同一根因每轮换一种英文措辞**，于是每轮都是新条目：现网 plan-69e514cf625f 七次 run 的台账
5 → 10 → 16 → 20 → 20 → 20 → 20（顶到 `_ISSUES_MAX`），「持续 N 次」永远 1，整理步 payload 随之撑爆
（批 judge-zh-fix2 的分批就是给它兜的）。

2026-09-07 把七次 run 的原始 `root_causes[]` 拉下来逐字段比对（`.scratch` 不留、本 ADR 记结论）：

| 字段 | 七轮表现 | 能当身份？ |
|---|---|---|
| `fix_recommendation` | 每轮改写（"Add an instruction requiring…" / "Add explicit instruction to the system prompt…" / "Provision the execution environment…"） | 否 |
| `root_cause_explanation` | 同样每轮改写（"Agent produced a four-sentence response…" / "The LLM generated a response with an introductory sentence…"） | 否 |
| `fix_type` | 同一根因七轮同值 | 是 |
| 证据行（会话 id / 用例名） | 同一会话七轮同 id | 是 |
| `location`（根因所在 span） | 线上会话：七轮同一批 span（959e…、9d33…、f6c5…、f2d0…、e9a2…）；**回归用例**：每轮重放、span 每轮新生（tau-airline-16 三轮三个 location） | 会话行是，用例行否 |

派工单原拟的键 `sha1(fix_type | 证据 id | normalize(root_cause_explanation 前 120 字))` 里的第三段
按实测每轮都不同，等于没改；用上表里真正稳定的三样代替。

## Decision

1. **身份键** `identity_key = "<fix_type>|<sorted kind:ref>|<sorted 会话 span>"`，`id = sha1(identity_key)[:8]`。
   - `fix_type` 归一化后的值（`SYSTEM_PROMPT_FIX` / `TOOL_DESCRIPTION_FIX` / `OTHERS`），`None` ⇒ 空段；
   - 证据行 `kind:ref`，按字典序；
   - 第三段只收**会话行**上根因的 `location`（trace 已落库，重评同一会话给同一批 span，同会话上不同 span
     的根因——沙箱缺后端 / 权限升级无审批——仍分条）；**用例行不进 span**（每轮重放），身份 = fix_type × 用例，
     同用例上同 fix_type 的两条不同措辞并成一条（建议取首见、解释最多留 3 条）；
   - 没有证据行的退化根因（行料缺 session_id / case 名）退到归一化文本，只为不互相撞键。
   - 身份里**没有任何 LLM 文本**：措辞漂了 id 不变。条目新增 `identity_key` 字段留证（可人工复算）。
2. **run 内合并不变、身份合并叠在上面**：`_collect_issue_seeds` 先按建议文本把同一 run 里逐字相同的根因
   跨行合并（证据数 = 覆盖的行数、评估器按行计数——既有口径），再按 `identity_key` 并组。
3. **再见即累计**：同 id 再现 ⇒ `occurrences+1`、`last_seen_run` 更新、证据本次的在前；建议（`recommendation`
   译文）与原话（`recommendation_source`）**若旧有则成对保留**——两把钥匙对回 proposals 的链不断
   （派工单写「source 取最新」：source 每轮都会漂，取最新反而让报告页上一轮采纳的英文原话永远对不上；
   本次的新措辞在该 run 的报告页可见，不丢）。
4. **老形状过渡**：批 ledger-id-merge 之前落库的条目没有 `identity_key`、id = sha1(建议)。合并时按过渡签名
   `(fix_type, 证据行)`（身份键去掉 span 段）折进本次**第一条**同签名的种子：`occurrences = max(老 occurrences
   最大值, 老 last_seen_run 去重数) + 1`（两者都是「出现过的 run 数」的下界，不求和不虚高）、`first_seen_run`
   取最早、译文/原话/`root_cause` 取最近见到的那条、评估器并集；没对上的老条目原样带着（仍是老形状，
   等下次对上）。**老 run 落库数据不回填**。过渡是有损的：同会话同 fix_type 不同 span 的老条目会被折进
   第一条同签名的新条目（现网复算：20 条老形状 + 5 条种子 ⇒ 5 条），这是一次性的代价，新形状之后按 span 分条。
5. **`depends_on` 只留最终台账里的 id**（被折掉的老 id 不悬空）。`_ISSUES_MAX=20` 保留；现网七轮按新身份复算
   台账 5 → 6 → 7 → 7 → 7 → 7 → 7，`occurrences` 最高 7。

## Consequences

- 「持续 N 次」有了真值；同一根因反复出现的条目排在前面（本次见到 > occurrences 降序 不变）。
- 线上评估在正常日频下每天是**新会话**：跨天同一根因仍分条（证据行不同）——身份键管的是「同一条证据再被诊断
  一次」的重复，不是跨会话的语义归并。跨会话归并要 LLM（整理步回填 `same_as`），另立 ADR 再做。
- 回归用例上同 fix_type 的多条根因并成一条：ledger 少一层细分，报告页仍逐条可见。
- 契约字段 `id` 的算法变了；老 run 的 id 不重算，前端只当 id 用不解析。
