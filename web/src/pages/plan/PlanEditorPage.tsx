// 编辑器路由入口：#/plan/new（新建）与 #/plan/:id/edit（编辑，先取 plan 再渲染表单）。
import { useQuery } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import { navigate } from "../../router";
import type { PlansEvent } from "./types";
import PlanEditor from "./PlanEditor";

/** `dataset` = `#/plan/new?dataset=<name>` 带来的预选数据集名（只对新建有意义；编辑态忽略） */
export default function PlanEditorPage({ id, dataset }: { id?: string; dataset?: string }) {
  const plansQuery = useQuery({
    queryKey: ["plans"],
    queryFn: () => apiOne<PlansEvent>({ action: "list_plans" }, "plans"),
    enabled: Boolean(id),
  });

  if (!id) return <PlanEditor presetDataset={dataset} />;

  if (plansQuery.isLoading) {
    return (
      <section data-testid="page-plan-editor">
        <p className="subtle">加载评估计划中…</p>
      </section>
    );
  }
  if (plansQuery.isError) {
    return (
      <section data-testid="page-plan-editor">
        <p className="plan-editor-error" data-testid="plan-editor-load-error">
          {plansQuery.error instanceof Error ? plansQuery.error.message : String(plansQuery.error)}
        </p>
      </section>
    );
  }
  const plan = plansQuery.data?.plans.find((p) => p.plan_id === id);
  if (!plan) {
    return (
      <section data-testid="page-plan-editor">
        <div className="u-empty" data-testid="plan-editor-not-found">
          <p>找不到评估计划 <span className="mono">{id}</span></p>
          <button type="button" className="btn ghost" onClick={() => navigate("#/workbench")}>
            返回评估计划
          </button>
        </div>
      </section>
    );
  }
  return <PlanEditor plan={plan} />;
}
