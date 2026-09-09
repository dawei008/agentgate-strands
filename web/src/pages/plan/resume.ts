// 从检查点续跑的展示侧判据与计费上界（UI-029 批 4，SPEC §4）。
//
// 为什么这三个函数是纯函数、且住在这里：入口可见性与卡上那个金额是**用户点之前
// 唯一的信息**，必须能单独钉住（不经过渲染就能断言全部边界形态）。判定口径一律
// 只看**后端字段**，前端零推断 —— 与 `stale` 那一族同一条纪律。
import type { PlanRunSummary } from "./types";

/** 检查点对象键里的 `stage-<i>`：写侧 `_write_stage_checkpoint` 归档到
 *  `checkpoints/<plan_id>/<ts>/stage-<i>.json`，且那一份 payload 的
 *  `stage_results` 恰好是**累计 i 个环节**（`stages_done: stage_no`）。
 *  所以 key 里的 i 就是这份检查点的已完成环节数 —— 它比 run 行上的 `progress`
 *  更可靠：progress 每个环节边界都写，而指针只在 S3 归档成功时才写，两者可能
 *  差一格（那一格差会让卡上的金额少报）。
 *  认不出来 → **null，不猜**（调用方按「一个环节都没完成」保守处理）。 */
export function checkpointStagesDone(key?: string | null): number | null {
  const m = /\/stage-(\d+)\.json$/.exec(String(key ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 这条 run 能不能「从检查点重试」——判据 = 后端给的两个字段，别的都不看。
 *
 *  · 终态 error/failed/stopped：`RESUMABLE_STATUSES`（app/planrun.py）的镜像；
 *  · 有 `checkpoint_s3_key`：现实里只有 reaper 改判的那一族有（改判走 update
 *    只补字段，指针留着）；走整条 put_item 的终态路径覆盖即清场 —— 所以
 *    completed 与老 run 天然没有指针，入口自然不出现（旧数据不修的展示侧降级）。
 *  · running 不给：那是「停止」的位置，且后端也会拒绝（幂等闸门，不许并发烧两份钱）。
 */
export function isResumable(
  run: Pick<PlanRunSummary, "status"> & { checkpoint_s3_key?: string | null },
): boolean {
  const status = String(run.status ?? "");
  if (!(status === "error" || status === "failed" || status === "stopped")) return false;
  return Boolean(String(run.checkpoint_s3_key ?? "").trim());
}

/** 逐环节预估的最小形状（estimate_plan_run 的 `stages` 每项：type + 该环节自己的
 *  估算键；数据集缺失那一项只有 {error}，**没有** estimated_cost_usd）。 */
export type EstimateStageLike = {
  type?: string;
  error?: string;
  estimated_cost_usd?: number;
};

export type ResumeCeiling = {
  /** 从第几个环节继续（1 基，= 已完成数 + 1） */
  fromStage: number;
  stagesTotal: number;
  /** 新增花费上界 = 剩余环节（含被重跑那一个）预估合计；算不出 = null */
  addedMaxUsd: number | null;
  /** 重计费上界 = **被重跑那一个环节**的预估（SPEC §4 原话）；算不出 = null */
  rebillMaxUsd: number | null;
};

/**
 * 续跑的计费上界 —— 与后端 `planrun.resume_cost_ceiling` **同一句话**
 * （那边给正在跑的 run 用，这边给点之前的确认卡用；两处数字必须对得上）。
 *
 * 算不出一律 **null，不是 0**：$0.00 会被读成「续跑不要钱」，而这是一个真花钱的
 * 动作。认不出检查点时按「从第 1 环节起」算 —— 方向是**宁可多报**：少报会让用户
 * 以为花得比实际少。
 */
export function resumeCeiling(
  checkpointKey: string | null | undefined,
  stagesTotal: number,
  stages: readonly EstimateStageLike[] | undefined,
): ResumeCeiling {
  const done = Math.max(0, Math.min(checkpointStagesDone(checkpointKey) ?? 0, stagesTotal));
  const out: ResumeCeiling = {
    fromStage: done + 1, stagesTotal, addedMaxUsd: null, rebillMaxUsd: null,
  };
  // 逐项对位是前提：预估条数与方案环节数不等就无从切片（方案刚改过 / 后端降级）
  if (!Array.isArray(stages) || stages.length !== stagesTotal) return out;
  const rest = stages.slice(done).map((s) => s?.estimated_cost_usd);
  if (rest.length === 0 || rest.some((c) => typeof c !== "number" || !Number.isFinite(c))) {
    return out;
  }
  const costs = rest as number[];
  out.addedMaxUsd = Math.round(costs.reduce((a, b) => a + b, 0) * 10000) / 10000;
  out.rebillMaxUsd = costs[0];
  return out;
}
