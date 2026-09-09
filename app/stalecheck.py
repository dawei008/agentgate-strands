"""单一陈旧判定：一条 running 的 PLANRUN 记录，执行进程还活着吗？

全站唯一住所（UI-029 SPEC §6「单一才真正单一」）。三个消费方 import 同一个
函数，判据绝不分叉：
  · reaper（planrun.reap_stale_runs）—— 把上线后新产生的陈旧 running 改判成
    error 终态（写库，带上线时间戳下界）；
  · 读侧（planrun._run_from_item）—— 给每条 run 附 `stale: bool`，前端零判定
    逻辑、只消费（读时判、不写库，所以不受「旧数据不修」约束）；
  · 将来的 per-plan 并发闸门 —— 读时把陈旧 running 视作不占位（不写库），
    存量僵尸才锁不死方案（stale-running-run-reaper.md 的互锁与设计出路段）。

三级判据，缺哪个字段退化到哪级 —— 方向永远是**宁可漏判，绝不误判**：误判改判
是不可逆的展示错误（那是真花过钱的运行），漏判最多让收敛晚到天花板那一级。

  1. 心跳（heartbeat_epoch，批 1 执行侧每 HEARTBEAT_INTERVAL_S 秒 update 一次）：
     连丢 HEARTBEAT_MISS_BEATS 拍再加裕量还没有新心跳 → 执行进程已死。
     心跳存在时它是唯一话语权 —— 预估时长不再参与（心跳新鲜就是活着，
     跑多久都不算陈旧，天花板除外）。
  2. 预估时长（estimated_duration_s，批 1 write-at-start 一次写入；无心跳字段
     的记录退化到这级）：started_epoch + max(预估 × 系数, 下限) 超时 → 陈旧。
     重型方案（预估长）窗口自然长，不被误判；轻量方案不用等到天花板。
  3. 天花板（无论有无以上字段）：started_epoch + AgentCore maxLifetime(8h) +
     裕量 必 stale —— 没有任何执行能活过 microVM 的硬上限（SPEC §1.1 E2）。

  连 started_epoch 都没有（极老的记录）→ 无从判定 → False（保守）。
  终态记录（status != running）恒 False。

纯函数：`now` 由调用方传入，本模块不取墙钟（可测性；读侧/reaper/闸门各自决定
自己的「现在」）。DynamoDB resource API 读出的数值是 Decimal，一并容纳。
"""

from __future__ import annotations

from typing import Any, Mapping

# ---- 一级：心跳 ----
# 批 1 的执行侧心跳写入节奏（SPEC §2 字段表：heartbeat_epoch 每 60s update）。
HEARTBEAT_INTERVAL_S = 60
# 允许连丢 3 拍：单次 update 失败/限流/事件循环忙都不该判死一个活着的 run。
HEARTBEAT_MISS_BEATS = 3
# 写抖动 + 读写两侧时钟偏差的裕量。
HEARTBEAT_MARGIN_S = 30
HEARTBEAT_STALE_AFTER_S = (HEARTBEAT_INTERVAL_S * HEARTBEAT_MISS_BEATS
                           + HEARTBEAT_MARGIN_S)  # 210s

# ---- 二级：预估时长 ----
# 预估是静态定义计算（planrun.estimate_plan_run 不探测现网），judge 限流/重试
# （重试预算刚从 2 提到 4）能把真实时长抬到预估的数倍 —— 系数取 3。
ESTIMATE_MARGIN_FACTOR = 3.0
# 下限 30 分钟：轻量方案的预估可能只有几十秒，限流风暴下 3 倍窗口仍会误判；
# 30 分钟盖得住任何「预估 1 分钟实际 20 分钟」的极端拖延，又远小于天花板。
ESTIMATE_FLOOR_S = 30 * 60

# ---- 天花板 ----
# AgentCore Runtime microVM 的 maxLifetime（SPEC §1.1 E2）：执行的物理硬上限。
MAX_LIFETIME_S = 8 * 3600
CEILING_MARGIN_S = 30 * 60
CEILING_S = MAX_LIFETIME_S + CEILING_MARGIN_S  # 30600s


def _epoch(value: Any) -> float | None:
    """epoch 字段的宽容读取：int/float/Decimal/数字字符串 → float，其余 None。

    DDB resource API 给 Decimal；缺键/空串/坏数据一律当「没有这级判据」——
    退化到下一级，绝不因为一个坏字段把活着的 run 判死。
    """
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out > 0 else None


def is_stale(run: Mapping[str, Any], now: float) -> bool:
    """True ⇔ 这条 running 记录的执行进程可判定为已死（见模块 docstring）。

    入参是 PLANRUN 摘要项（DDB 原始 item 或同键 dict 都行）；边界取严格大于：
    恰好压线不算陈旧。
    """
    if str(run.get("status") or "") != "running":
        return False
    started = _epoch(run.get("started_epoch"))
    # 天花板先判：字段再缺、心跳字段再怎么被写坏，8h+裕量之外必是死的。
    if started is not None and now - started > CEILING_S:
        return True
    heartbeat = _epoch(run.get("heartbeat_epoch"))
    if heartbeat is not None:
        return now - heartbeat > HEARTBEAT_STALE_AFTER_S
    estimated = _epoch(run.get("estimated_duration_s"))
    if started is not None and estimated is not None:
        window = max(estimated * ESTIMATE_MARGIN_FACTOR, ESTIMATE_FLOOR_S)
        return now - started > window
    # 只剩 started（老 run）→ 天花板已在上面判过；连 started 都没有 → 保守 False。
    return False
