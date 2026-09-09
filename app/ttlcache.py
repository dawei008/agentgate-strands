"""进程内小工具：TTL 缓存 + 数值守卫 —— 两个被逐字抄了三遍的三行件。

住这里的门槛有两条：**零领域知识**、且已经在三处以上逐字重复。所以本模块不 import
任何 app 内模块，谁都能安全引它（图上是叶子，不可能成环）。

TtlCache 原是三份复制：fleet_status（fleetstatus）、agent_topology（topology），
外加本次给 agent_status 新加的那份 —— 各一个 TTL=300 常量、各一份 time.monotonic、
各一套 (deadline, value) 塞 dict + refresh 绕过。第四个用途是会话对比里终态 run 的
归档缓存（sessioncompare，带 max_entries）。
三处原来只有 fleet_status 回 `cache_age_s`，收敛后 agent_status / agent_topology
也一起回（新增字段，见 docs/payload-contract.md）。

缓存一律只在进程内（Lambda 热实例），不落 DDB：catalog 是单表设计，写缓存项就是对
业务表 put_item，与那几个只读 action 钉的「零写业务表」相冲。
"""

import time

# 全站进程内缓存的默认 TTL：四个用途（fleet_status / agent_status / agent_topology /
# 会话对比的终态归档）同一个数，改这里就是全改。
DEFAULT_TTL_SECONDS = 300


def is_number(v) -> bool:
    """真数值（bool 不算）。JSON 里 True 会被 isinstance(v, int) 放过去，故单独排除。"""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _monotonic() -> float:
    """时钟走这一个门，测试才有唯一的可替换点（原先三个模块各有一个 _monotonic）。"""
    return time.monotonic()


class TtlCache:
    """键 → 值 的进程内 TTL 缓存。命中回 (value, age_s)，未命中/过期回 None。

    max_entries：给「键会长出来」的用途（如按 run_key 缓存整份报告）设上限，满了先淘汰
    最早写入的一条。省略 = 不设上限，适合键域固定的用途（三个 action 的窗口/参数组合）。
    """

    def __init__(self, ttl_seconds: float, max_entries: int | None = None):
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._entries: dict = {}

    def get(self, key) -> tuple[object, int] | None:
        hit = self._entries.get(key)
        if hit is None:
            return None
        deadline, value = hit
        now = _monotonic()
        if deadline <= now:
            return None
        # age = 距「原次算出来」的秒数；deadline - ttl 就是写入时刻。
        return value, int(max(0.0, now - (deadline - self.ttl_seconds)))

    def put(self, key, value) -> None:
        self._entries.pop(key, None)  # 重写也算最新（dict 保插入序）
        if self.max_entries is not None:
            while len(self._entries) >= self.max_entries:
                self._entries.pop(next(iter(self._entries)))
        self._entries[key] = (_monotonic() + self.ttl_seconds, value)

    def clear(self) -> None:
        self._entries.clear()

    def __iter__(self):
        """已写入的键（含过期但未被覆盖的）—— 测试拿 set(cache) 核键的构成。"""
        return iter(self._entries)
