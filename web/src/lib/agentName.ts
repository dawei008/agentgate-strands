// Agent 显示名的**唯一**取名入口（type-only 依赖，零运行时体积）。
//
// 数据模型（用户拍板）：Agent = 显示名 + 版本标签 + runtime。显示名默认 =
// AgentCore discovery 的名字，用户可在 Agent 详情页改（后端 catalog.set_agent_meta
// 存在 AGENTMETA 行上，见 app/catalog.py 的「per-agent 显示元数据」一节）。
//
// ⚠️ 护栏 2（关联键不动）：改的是**显示名**，`agent_name` 是关联键 —— 方案绑定、
// run 归属、evaltest 会话前缀全靠它，直接改键会让历史数据全部失联。所以：
//   · 显示处一律走 displayName()；
//   · 键处（testid / 路由 hash / 请求参数 / 各类 map 的 key）一律用 agent_name。
//
// 为什么必须收敛成一个函数：`a.display_name || a.agent_name` 这个三元散到列表、
// 详情、下拉、工作台之后，只要有一处漏写 trim 或漏了 null 分支，同一个 agent 在
// 两页上就是两个名字（本仓「同数据两页互相矛盾」的老账，见 AgentsPage 的 RunBadge
// 注释）。新的显示点接这里，不许再写第二份三元。

/** 取名只需要这两个字段：后端 discover 的每一行都带（没标注过 = 空串，
 *  catalog.apply_agent_meta 保证键恒存在），历史/局部形态可能整个缺。 */
export interface NamedAgent {
  agent_name: string;
  display_name?: string | null;
}

/** 界面上该显示的名字：有显示名用显示名，否则用原名（agent 缺失 → 空串，不抛）。 */
export function displayName(agent: NamedAgent | null | undefined): string {
  if (!agent) return "";
  const shown = (agent.display_name ?? "").trim();
  return shown || (agent.agent_name ?? "").trim();
}

/** 显示名与原名**不同** —— 为真时界面要把原名（关联键）一并显示出来：
 *  用户改完名字仍得对照得上「我的方案挂在哪个 agent 上」。 */
export function isRenamed(agent: NamedAgent | null | undefined): boolean {
  if (!agent) return false;
  const shown = (agent.display_name ?? "").trim();
  return shown !== "" && shown !== (agent.agent_name ?? "").trim();
}
