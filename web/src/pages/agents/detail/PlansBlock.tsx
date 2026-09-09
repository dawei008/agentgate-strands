// ② 评估计划区块：该 Agent 的计划表 + 新建/运行入口。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiOne } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { navigate } from "../../../router";
import type { PlansEvent } from "../types";
import { gotoNewPlan, runPlanAndGo } from "./actions";
import RunConfirmCard, { type RunTarget } from "../../../components/RunConfirmCard";
import { useRunFlight } from "../../../lib/runFlight";

function NewPlanButton({ name, testid }: { name: string; testid: string }) {
  const { authed } = useAuth();
  return (
    <button
      className="btn btn-primary"
      data-testid={testid}
      disabled={!authed}
      title={!authed ? "请先登录" : undefined}
      onClick={() => gotoNewPlan(name)}
    >
      + 新建评估计划
    </button>
  );
}

/** 行内「运行」：单独成组件才能按计划 id 订阅在飞状态（hook 不能写在 map 回调里）。
 *  在飞期间 disabled + 「运行中…」，把「同一计划并发跑两次」堵在点击之前（缺陷 1）。 */
function RunRowButton({ planId, authed, onAsk }: {
  planId: string;
  authed: boolean;
  onAsk: () => void;
}) {
  const flight = useRunFlight(planId);
  return (
    <button
      className="btn-link"
      data-testid={`agent-plan-row-${planId}-run`}
      disabled={!authed || flight.running}
      title={!authed ? "请先登录" : flight.running ? "该评估计划正在运行中" : undefined}
      onClick={(e) => {
        e.stopPropagation(); // 别触发行点击（行点击是进详情）
        onAsk();
      }}
    >
      {flight.running ? "运行中…" : "运行"}
    </button>
  );
}

export default function PlansBlock({ name }: { name: string }) {
  const { authed } = useAuth();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["plans", name],
    queryFn: () => apiOne<PlansEvent>({ action: "list_plans", agent_name: name }, "plans"),
  });
  // 发起运行的二次确认（缺陷 2）：卡挂在区块层而**不是行内**——行有 onClick
  // （点行进详情），卡挂在 <td> 里点确认会冒泡触发行跳转。
  const [runTarget, setRunTarget] = useState<RunTarget>(null);
  return (
    <div className="agent-detail-block" data-testid="agent-plans-block">
      {/* 区块头：h3 + 右侧新建入口（形态照工作台 card-head 的 spacer 布局） */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
        <h3 style={{ flex: 1 }}>评估计划</h3>
        <NewPlanButton name={name} testid="agent-plans-new" />
      </div>
      {query.isLoading ? (
        <p className="agent-detail-empty">加载中…</p>
      ) : query.isError ? (
        <p className="agents-error">
          {query.error instanceof Error ? query.error.message : String(query.error)}
        </p>
      ) : !query.data || query.data.plans.length === 0 ? (
        <div className="u-empty" data-testid="agent-plans-empty">
          <p>还没有评估计划</p>
          <NewPlanButton name={name} testid="agent-plans-empty-new" />
        </div>
      ) : (
        <table className="u-table" data-testid="agent-plans-table">
          <thead>
            <tr>
              <th>计划名</th>
              <th>计划 <span className="lat">ID</span></th>
              <th className="num-cell">操作</th>
            </tr>
          </thead>
          <tbody>
            {query.data.plans.map((p) => (
              <tr
                key={p.plan_id}
                className="plan-row-link"
                data-testid={`agent-plan-row-${p.plan_id}`}
                onClick={() => navigate(`#/plan/${encodeURIComponent(p.plan_id)}`)}
              >
                <td>
                  {/* a11y：行点击对键盘不可达——名称升为 btn-link（Tab 可达，行为同行点击） */}
                  <button
                    className="btn-link"
                    data-testid={`agent-plan-row-${p.plan_id}-open`}
                    onClick={() => navigate(`#/plan/${encodeURIComponent(p.plan_id)}`)}
                  >
                    {p.name}
                  </button>
                </td>
                <td className="agents-name">{p.plan_id}</td>
                <td className="num-cell">
                  <RunRowButton planId={p.plan_id} authed={authed} onAsk={() => setRunTarget(p)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <RunConfirmCard
        target={runTarget}
        onCancel={() => setRunTarget(null)}
        onConfirm={() => {
          const planId = runTarget?.plan_id;
          setRunTarget(null);
          if (planId) runPlanAndGo(planId, qc);
        }}
      />
    </div>
  );
}
