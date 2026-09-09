// KPI 推导（纯函数，测试直接盯这里）。批 plans-board 起 hero 从「线上评估均分」
// 换成「下次运行」：均分只作观测量，留在 Agent ① 现状（ADR-0016 分数口径修订），
// 这页回答的是排程问题 —— 什么时候跑、花多少、跑了多少。口径：
// - 下次运行：所有 cron 计划里最早的一次（board.deriveBoard 用 cronEngine 推算）；
//   rate(...) 相位由 EventBridge 创建时刻决定，推不出 → 不伪造时刻。
// - 带定时计划数：schedule 非空（cron 或 rate，含解析失败的存量串）的计划数。
// - 本月花费：list_recent_runs 里本月 UTC status=completed 的 total_cost_usd 之和；
//   样本 0 → null（显示 —）。
// - 近 24h 运行数：started_at（UTC "YYYY-MM-DD HH:mm"）落在 now-24h 内的 run 计数。
import type { Plan } from "../../lib/apiTypes";
import type { RunRow } from "./types";
import { deriveBoard, runs24hOf, type Board, type BoardRow } from "./board";

export interface WorkbenchKpi {
  /** 全表最早的下次运行；null = 没有可推算的 cron 计划 */
  next: BoardRow | null;
  /** 有 rate 计划（相位未知）——next 为 null 时说明「不是没定时，是推不出」 */
  hasRate: boolean;
  /** 带定时计划数 */
  scheduledCount: number;
  /** 本月花费合计（USD）；null = 本月无 completed 样本 */
  monthSpend: number | null;
  monthSpendN: number;
  /** 近 24h 运行数 */
  runs24h: number;
}

export function deriveKpi(
  runs: RunRow[] | undefined,
  plans: Plan[] | undefined,
  now: number = Date.now(),
  board: Board = deriveBoard(plans, runs, now),
): WorkbenchKpi {
  return {
    next: board.alert.next,
    hasRate: board.alert.hasRate,
    scheduledCount: board.alert.scheduledCount,
    monthSpend: board.alert.monthSpend,
    monthSpendN: board.alert.monthSpendN,
    runs24h: runs24hOf(runs, now),
  };
}
