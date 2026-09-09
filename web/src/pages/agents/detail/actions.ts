// Agent 详情页页级动作（页壳 / PlansBlock 共用）。
import type { QueryClient } from "@tanstack/react-query";
import { navigate } from "../../../router";
import { showToast } from "../../../components/toast";
import { presetPlanAgent } from "../../plan/PlanEditor";
import { startPlanRun } from "../../../lib/runFlight";

/**
 * 发起运行并跳计划详情看进度（与工作台 RunPlanButton 同一套路）。
 *
 * 旧写法 `void callApi(…, () => {}).catch(() => {}); showToast("已开始");`
 * 把后端 {event:"error"} 与 fetch 异常一起吞了，还在响应到达前就报喜（缺陷 1）。
 * 现在整条流交给 lib/runFlight 消费：真接单才 toast「已开始」，失败弹真因并在
 * 计划详情页留一条常驻错误；在飞期间挡住第二次发起。
 * qc 由调用方（组件）通过 useQueryClient 传入——运行结束要失效运行历史与预估，
 * 而单例 queryClient 在测试里不是页面用的那个实例。
 */
export function runPlanAndGo(planId: string, qc: QueryClient) {
  if (!startPlanRun(planId, { qc, notify: showToast })) {
    showToast("该评估计划已有一次运行在进行中");
  }
  navigate(`#/plan/${encodeURIComponent(planId)}`);
}

/** 新建评估计划并预选当前 Agent：路由不解析 query，预选值走 sessionStorage
    （PlanEditor 挂载时读取并清除，见 presetPlanAgent） */
export function gotoNewPlan(agentName: string) {
  presetPlanAgent(agentName);
  navigate("#/plan/new");
}

/** 「管理调用配置」锚点：滚动到调用配置区块（区块本体归 autoconf 线，
    这里只按稳定 testid 定位，不触碰其内部结构） */
export function scrollToConfig() {
  document
    .querySelector('[data-testid="agent-config-block"]')
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}
