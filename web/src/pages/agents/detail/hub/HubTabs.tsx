// Tab 条（变体 B：四区页内 Tab，带序号与计数小字）。选中态走 aria-selected；
// 切换 = 改 hash（navigate），路由重解析后页壳按 tab prop 显示面板。
// 键盘 ←/→ 在 Tab 间循环（tablist 惯例）。
import { navigate } from "../../../../router";
import type { TabSums } from "./derive";
import { AGENT_TABS, TAB_LABEL, agentTabHash, type AgentTab } from "./tabs";

const ORDINAL: Record<AgentTab, string> = { status: "①", evaluate: "②", optimize: "③", config: "④" };

export function panelId(tab: AgentTab): string {
  return `agent-tab-panel-${tab}`;
}

export default function HubTabs({ name, active, sums }: {
  name: string;
  active: AgentTab;
  sums: TabSums;
}) {
  const go = (tab: AgentTab) => navigate(agentTabHash(name, tab));
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = AGENT_TABS.indexOf(active);
    const n = AGENT_TABS.length;
    const next = AGENT_TABS[(i + (e.key === "ArrowRight" ? 1 : n - 1)) % n];
    go(next);
    document.getElementById(`agent-tab-${next}`)?.focus();
  };
  return (
    <div className="hub-tabs" role="tablist" aria-label="Agent 详情分区" data-testid="agent-tabs" onKeyDown={onKey}>
      {AGENT_TABS.map((tab) => {
        const on = tab === active;
        const sum = sums[tab];
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`agent-tab-${tab}`}
            className="hub-tab"
            aria-selected={on}
            aria-controls={panelId(tab)}
            tabIndex={on ? 0 : -1}
            data-testid={`agent-tab-${tab}`}
            onClick={() => go(tab)}
          >
            <span className="t"><span className="n" aria-hidden="true">{ORDINAL[tab]}</span>{TAB_LABEL[tab]}</span>
            <span className="c" data-testid={`agent-tab-${tab}-sum`}>{sum ?? ""}</span>
          </button>
        );
      })}
    </div>
  );
}
