// 发起运行的二次确认卡（四处入口共用：工作台方案行 / 方案详情页头 /
// Agent 详情方案行 / Agent 详情页头「运行最新方案」）。
//
// 为什么必须有这一步：run_plan 一按下去就真调被测 Agent + judge，花的是真钱，
// 后端没有任何撤销口。此前四处入口都是「点一下直接跑」，误点即扣费。
// 卡上给 estimate_plan_run 的预估费用——后端对 estimate_plan_run 与 run_plan
// 用的是同一段前置校验（app/main.py:1402-1412），所以预估失败基本等价于
// 「这次运行也会失败」，照实透出比假装 $0.00 有用。
//
// 复用同目录 ConfirmCard（全站 confirm() 的玻璃替代），不新造卡：
// 危险动作纪律（UI-004）initialFocus="cancel"，回车误触落在「取消」。
// 住 components/ 是因为四个消费方跨三个页面族（workbench / plan / agents ×2）——
// 页面目录下应当只放该页私有件（issue runconfirmcard-component-location）。
// 别顺手与 ConfirmCard 合并：那是另一个判断，要看四处调用形态。
import { useQuery } from "@tanstack/react-query";
import { apiOne } from "../lib/api";
import ConfirmCard from "./ConfirmCard";
// 环节中文名：术语五词的唯一权威在 lib/scoring.STAGE_LABEL（ADR-0003）
import { STAGE_LABEL } from "../lib/scoring";

/** estimate_plan_run 的真后端形态（app/main.py:1414-1416 的
 *  `{"event":"plan_run_estimate","plan_id":…, **estimate}`
 *  + planrun.py:91-93 的 `{stages, estimated_cost_usd, note}`）。
 *  stages 每项只保证有 type，其余键各环节自己给（observe→judge_calls、
 *  dataset→cases/…、redteam→attacks/…），数据集缺失时给 {error}。 */
export type PlanRunEstimate = {
  event: "plan_run_estimate";
  plan_id: string;
  stages?: Array<{ type: string; error?: string }>;
  estimated_cost_usd: number;
  note?: string;
};

/** 确认对象：null = 卡关着（此时不发预估请求） */
export type RunTarget = { plan_id: string; name: string; agent_name?: string } | null;

/** 单次预估查询。queryKey 与方案详情页 KPI 的「单次预估」**完全同款**
 *  （["plan_estimate", planId]）：详情页开卡时直接命中缓存不重复打，
 *  运行结束后失效该 key 也一并把卡上的数字刷新。 */
export function usePlanEstimate(planId: string | null) {
  return useQuery({
    queryKey: ["plan_estimate", planId],
    queryFn: () =>
      apiOne<PlanRunEstimate>(
        { action: "estimate_plan_run", plan_id: planId as string },
        "plan_run_estimate",
      ),
    enabled: planId != null,
  });
}

export default function RunConfirmCard({ target, onCancel, onConfirm }: {
  target: RunTarget;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const estimate = usePlanEstimate(target?.plan_id ?? null);
  if (!target) return null;

  const stages = (estimate.data?.stages ?? [])
    .map((s) => STAGE_LABEL[s.type] ?? s.type)
    .join(" + ");

  return (
    <ConfirmCard
      open
      title="发起运行"
      body={
        <>
          <div>
            确定运行评估计划「<b>{target.name}</b>」？
            {target.agent_name
              ? <>会立即调用 <span className="lat">{target.agent_name}</span> 并产生真实费用。</>
              : "会立即调用被测 Agent 并产生真实费用。"}
          </div>
          <div data-testid="run-confirm-cost">
            预估费用{" "}
            {estimate.isError ? (
              // 预估失败不假装 $0.00：原样透出后端错误（方案不存在 / Agent 无日志）
              <b>
                预估失败：
                {estimate.error instanceof Error ? estimate.error.message : String(estimate.error)}
              </b>
            ) : estimate.data ? (
              <b>${estimate.data.estimated_cost_usd.toFixed(2)}</b>
            ) : (
              "预估中…"
            )}
          </div>
          {stages && <div data-testid="run-confirm-stages">环节：{stages}</div>}
        </>
      }
      confirmLabel="运行"
      initialFocus="cancel"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
