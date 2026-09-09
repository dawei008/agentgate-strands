// 共享心跳活性机制（lib/useLiveness）：三档判定 / 计时格式 / 文案。
// 纯函数直测（livenessOf），不摆假时钟；hook 的接线行为由 plan/resources 页测试覆盖。
import { describe, expect, it } from "vitest";
import {
  livenessOf, fmtClock, heartbeatLabel,
  WAITING_AFTER_S, STALE_AFTER_S,
} from "../src/lib/useLiveness";

const T0 = 1_755_500_000_000; // 任意基准毫秒

describe("livenessOf 三档判定", () => {
  it("<10s 无事件 → ok；elapsed/sinceLast 都取整秒", () => {
    const l = livenessOf(T0 + 65_400, T0, T0 + 62_000);
    expect(l.level).toBe("ok");
    expect(l.elapsedS).toBe(65);
    expect(l.sinceLastS).toBe(3);
  });

  it("≥10s 无事件 → waiting；≥60s → stale（边界值恰好在档位切换点）", () => {
    expect(livenessOf(T0 + 9_999, T0, T0).level).toBe("ok");
    expect(livenessOf(T0 + WAITING_AFTER_S * 1000, T0, T0).level).toBe("waiting");
    expect(livenessOf(T0 + 59_999, T0, T0).level).toBe("waiting");
    expect(livenessOf(T0 + STALE_AFTER_S * 1000, T0, T0).level).toBe("stale");
    expect(livenessOf(T0 + 300_000, T0, T0).level).toBe("stale");
  });

  it("事件到达把档位拉回 ok：sinceLast 从新事件重新起算，elapsed 不受影响", () => {
    // 跑了 2 分钟，但 1s 前刚有事件 → ok
    const l = livenessOf(T0 + 120_000, T0, T0 + 119_000);
    expect(l.level).toBe("ok");
    expect(l.elapsedS).toBe(120);
    expect(l.sinceLastS).toBe(1);
  });

  it("时钟漂移防御：now 早于时间戳时夹到 0，不出负数", () => {
    const l = livenessOf(T0, T0 + 5_000, T0 + 5_000);
    expect(l.elapsedS).toBe(0);
    expect(l.sinceLastS).toBe(0);
    expect(l.level).toBe("ok");
  });
});

describe("fmtClock", () => {
  it("mm:ss 补零；超一小时进位 h:mm:ss", () => {
    expect(fmtClock(0)).toBe("00:00");
    expect(fmtClock(5)).toBe("00:05");
    expect(fmtClock(74)).toBe("01:14");
    expect(fmtClock(600)).toBe("10:00");
    expect(fmtClock(3_599)).toBe("59:59");
    expect(fmtClock(3_600)).toBe("1:00:00");
    expect(fmtClock(3_725)).toBe("1:02:05");
    expect(fmtClock(-3)).toBe("00:00"); // 负数夹 0
  });
});

describe("heartbeatLabel", () => {
  it("三档文案：ok 报秒数，waiting/stale 各自固定话术", () => {
    expect(heartbeatLabel(livenessOf(T0 + 3_000, T0, T0))).toBe("3s 前有心跳");
    expect(heartbeatLabel(livenessOf(T0 + 15_000, T0, T0))).toBe("等待响应…");
    expect(heartbeatLabel(livenessOf(T0 + 61_000, T0, T0))).toBe("可能已断开");
  });
});
