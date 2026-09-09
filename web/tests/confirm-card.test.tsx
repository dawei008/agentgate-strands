// ConfirmCard（玻璃风格确认卡，window.confirm 的全站替代）+
// PlanDetailPage 删除流程改走卡的断言。
// 删除流程用例原在 plan.test.tsx（window.confirm stub 版），随组件化搬入本文件改写。
// fetch 打桩方式与 plan.test.tsx 一致（stubGlobal + SSE Response）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import ConfirmCard from "../src/components/ConfirmCard";
import PlanDetailPage from "../src/pages/plan/PlanDetailPage";
import { resetConfigForTest } from "../src/lib/config";
import { useSession } from "../src/stores/session";
import { sseFrames } from "../src/mocks/handlers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==================== 组件本体 ====================
describe("ConfirmCard 组件", () => {
  function renderCard(over: Partial<React.ComponentProps<typeof ConfirmCard>> = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <ConfirmCard
        open
        title="删除评估计划"
        body={<>确定删除？</>}
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...over}
      />,
    );
    return { onConfirm, onCancel, view };
  }

  it("open=false 不渲染；open=true 渲染 dialog：标题/正文/两档按钮，confirmLabel 缺省「确认」", () => {
    const { view } = renderCard({ open: false });
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    view.unmount();

    renderCard();
    const card = screen.getByTestId("confirm-card");
    expect(card).toHaveAttribute("role", "dialog");
    expect(card).toHaveAttribute("aria-modal", "true");
    expect(card).toHaveAttribute("aria-label", "删除评估计划");
    expect(card).toHaveTextContent("删除评估计划");
    expect(card).toHaveTextContent("确定删除？");
    expect(screen.getByTestId("confirm-card-ok")).toHaveTextContent("确认");
    expect(screen.getByTestId("confirm-card-cancel")).toHaveTextContent("取消");
    // 打开后焦点进卡内（陷阱起点）
    expect(document.activeElement).toBe(card);
  });

  it("danger：确认按钮红色实心（confirm-danger），取消保持 ghost", () => {
    renderCard({ danger: true, confirmLabel: "删除" });
    const ok = screen.getByTestId("confirm-card-ok");
    expect(ok).toHaveTextContent("删除");
    expect(ok).toHaveClass("btn", "confirm-danger");
    expect(screen.getByTestId("confirm-card-cancel")).toHaveClass("btn", "ghost");
  });

  it("确认点击 → onConfirm；取消点击 / Esc / mask 点击 → onCancel", () => {
    const { onConfirm, onCancel } = renderCard();
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId("confirm-card-mask"));
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).toHaveBeenCalledOnce(); // 取消路径不误触确认
  });

  it("焦点陷阱：Tab 在卡内循环；关闭后焦点还原到触发按钮", async () => {
    // 受控宿主：模拟真实用法（外部按钮开卡 → Esc 关卡 → 焦点回按钮）
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>删</button>
          <ConfirmCard
            open={open}
            title="确认"
            body="确定？"
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }
    render(<Host />);
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    fireEvent.click(trigger);
    const card = screen.getByTestId("confirm-card");
    expect(document.activeElement).toBe(card);
    // 陷阱：卡自身持焦时 Shift+Tab 回卷到末端（确认钮）
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("confirm-card-ok"));
    // 末端再 Tab → 卷回首端（取消钮）
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByTestId("confirm-card-cancel"));
    // Esc 关闭 → 焦点还原到触发按钮
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });
});

// ==================== PlanDetailPage 删除流程（改走卡） ====================

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;

const PLAN = {
  plan_id: "plan-aaa111",
  name: "FAQ 周回归",
  agent_name: "support-bot",
  updated_at: 1755500000,
  stages: [{ type: "observe", evaluators: ["helpfulness"] }],
  schedule: null,
};

let calls: Payload[] = [];

const HANDLERS: Record<string, (p: Payload) => unknown[]> = {
  list_plans: () => [{ event: "plans", plans: [PLAN] }],
  list_plan_runs: (p) => [{ event: "plan_runs", plan_id: p.plan_id, runs: [] }],
  estimate_plan_run: (p) => [{
    event: "plan_run_estimate", plan_id: p.plan_id, estimated_cost_usd: 0.42, cases: 14,
  }],
  delete_plan: (p) => [{ event: "plan_deleted", plan_id: p.plan_id }],
};

function installFetch(over: Partial<typeof HANDLERS> = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    calls.push(payload);
    const handler = over[payload.action] ?? HANDLERS[payload.action];
    const events = handler
      ? handler(payload)
      : [{ event: "error", error: `未打桩 action '${payload.action}'` }];
    return new Response(sseFrames(events), {
      status: 200, headers: { "Content-Type": "text/event-stream" },
    });
  }));
}

function renderDetail() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PlanDetailPage id="plan-aaa111" />
    </QueryClientProvider>,
  );
}

describe("PlanDetailPage 删除流程（ConfirmCard 替代 window.confirm）", () => {
  beforeEach(() => {
    calls = [];
    resetConfigForTest();
    location.hash = "#/plan/plan-aaa111";
    useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
    installFetch();
  });

  it("点删除 → 卡出现（title=删除方案，body 含方案名与归档文案）；取消不发请求", async () => {
    renderDetail();
    await screen.findByTestId("plan-name");
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("plan-delete"));
    const card = screen.getByTestId("confirm-card");
    expect(card).toHaveAttribute("aria-label", "删除评估计划");
    expect(card).toHaveTextContent("删除评估计划");
    expect(card).toHaveTextContent("FAQ 周回归");
    expect(card).toHaveTextContent("运行历史会一并归档删除");
    // 危险动作：确认钮红色实心，文案「删除」
    expect(screen.getByTestId("confirm-card-ok")).toHaveClass("confirm-danger");
    expect(screen.getByTestId("confirm-card-ok")).toHaveTextContent("删除");

    fireEvent.click(screen.getByTestId("confirm-card-cancel"));
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.action === "delete_plan")).toHaveLength(0);
  });

  it("确认 → 发 delete_plan 并跳转工作台；卡随确认关闭", async () => {
    renderDetail();
    await screen.findByTestId("plan-name");
    fireEvent.click(screen.getByTestId("plan-delete"));
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(calls.filter((c) => c.action === "delete_plan")).toHaveLength(1));
    expect(calls.find((c) => c.action === "delete_plan")).toMatchObject({ plan_id: "plan-aaa111" });
    await waitFor(() => expect(location.hash).toBe("#/workbench"));
  });

  it("Esc 取消：卡关闭、不发请求、焦点还原到删除按钮", async () => {
    renderDetail();
    await screen.findByTestId("plan-name");
    const btn = screen.getByTestId("plan-delete");
    btn.focus();
    fireEvent.click(btn);
    // 删方案是危险动作 → 初始焦点落「取消」（口径同本文件 :108 的组件级用例）。
    // 此前这里断言焦点落卡本体，那是**删方案卡漏传 initialFocus 的旧行为**。
    expect(document.activeElement).toBe(screen.getByTestId("confirm-card-cancel"));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("confirm-card")).not.toBeInTheDocument());
    expect(calls.filter((c) => c.action === "delete_plan")).toHaveLength(0);
    expect(document.activeElement).toBe(btn);
  });

  it("删除失败：deleteError 照旧显示，按钮从「删除中…」恢复", async () => {
    installFetch({
      delete_plan: () => [{ event: "error", error: "后端拒绝：方案被引用" }],
    });
    renderDetail();
    await screen.findByTestId("plan-name");
    fireEvent.click(screen.getByTestId("plan-delete"));
    fireEvent.click(screen.getByTestId("confirm-card-ok"));
    await screen.findByTestId("plan-delete-error");
    expect(screen.getByTestId("plan-delete-error")).toHaveTextContent("后端拒绝：方案被引用");
    expect(screen.getByTestId("plan-delete")).toBeEnabled();
    expect(screen.getByTestId("plan-delete")).toHaveTextContent("删除");
  });
});
