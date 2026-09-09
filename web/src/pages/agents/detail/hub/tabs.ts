// Agent 详情四 Tab 枢纽（ADR-0016 决定 1 · 版面变体 B 页内 Tab）。
// Tab 名只准「现状 / 评估 / 优化 / 配置」；hash 子路由段见 router.tsx。
export const AGENT_TABS = ["status", "evaluate", "optimize", "config"] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

export const TAB_LABEL: Record<AgentTab, string> = {
  status: "现状",
  evaluate: "评估",
  optimize: "优化",
  config: "配置",
};

export function isAgentTab(s: string | undefined): s is AgentTab {
  return (AGENT_TABS as readonly string[]).includes(s ?? "");
}

/** 子路由：① 现状无子段落，其余带段 */
export function agentTabHash(name: string, tab: AgentTab, thisKey?: string): string {
  const base = `#/agent/${encodeURIComponent(name)}`;
  const q = thisKey ? `?this=${encodeURIComponent(thisKey)}` : "";
  return tab === "status" ? base : `${base}/${tab}${q}`;
}
