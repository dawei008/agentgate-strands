// 心跳活性机制（共享）：长任务流式界面统一的「还活着吗」判定。
// 输入「开始时间 + 最近事件时间」，输出计时与三档活性（ok/waiting/stale）。
// 用户点名的痛点：「不知道是死机还是在评估」——任何流式长任务界面都应接入。
//
// 接入三行（详见 PlanDetailPage / GenCasesForm / RedteamGenerator）：
//   const live = useLiveness(running, startedAt, lastEventAt);
//   每收到任意流式事件（含 heartbeat）：setLastEventAt(Date.now())
//   渲染：live && <span className={live.level}>已 {fmtClock(live.elapsedS)} · {heartbeatLabel(live)}</span>
import { useEffect, useState } from "react";

/** 超过 10s 无任何事件 → waiting（琥珀）；后端空闲心跳每秒一发，10s 已是异常。 */
export const WAITING_AFTER_S = 10;
/** 超过 60s 无任何事件 → stale（红，疑似断开）。 */
export const STALE_AFTER_S = 60;

export type LivenessLevel = "ok" | "waiting" | "stale";

export interface Liveness {
  /** 距任务开始的秒数（整数） */
  elapsedS: number;
  /** 距最近一次事件（含 heartbeat）的秒数（整数） */
  sinceLastS: number;
  level: LivenessLevel;
}

/** 纯函数核心：三档判定。测试直接打它，不用摆时钟。 */
export function livenessOf(now: number, startedAt: number, lastEventAt: number): Liveness {
  const elapsedS = Math.max(0, Math.floor((now - startedAt) / 1000));
  const sinceLastS = Math.max(0, Math.floor((now - lastEventAt) / 1000));
  const level: LivenessLevel =
    sinceLastS >= STALE_AFTER_S ? "stale"
    : sinceLastS >= WAITING_AFTER_S ? "waiting"
    : "ok";
  return { elapsedS, sinceLastS, level };
}

/** 秒 → mm:ss（超一小时进位到 h:mm:ss，长评估真的会跑到） */
export function fmtClock(s: number): string {
  const sec = Math.max(0, Math.floor(s));
  const mm = Math.floor(sec / 60) % 60;
  const ss = sec % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

/** 三档默认文案（各界面可自行组前缀；stale 的兜底语义由界面按任务性质补全） */
export function heartbeatLabel(live: Liveness): string {
  if (live.level === "ok") return `${live.sinceLastS}s 前有心跳`;
  if (live.level === "waiting") return "等待响应…";
  return "可能已断开";
}

/**
 * 活性 hook：active 期间每秒 tick 一次驱动重算。
 * startedAt/lastEventAt 为 Date.now() 毫秒时间戳；未激活或缺时间戳返回 null。
 */
export function useLiveness(
  active: boolean,
  startedAt: number | null,
  lastEventAt: number | null,
): Liveness | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!active || startedAt == null || lastEventAt == null) return null;
  return livenessOf(Date.now(), startedAt, lastEventAt);
}
