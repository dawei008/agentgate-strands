// 命令面板的匹配 / 分组 / 排序（纯函数，零 DOM）。
//
// 口径（批 topnav-search 任务书）：
//   · 大小写不敏感的子串匹配；中文直接子串（不做拼音）；
//   · 前缀命中排在子串命中前面（同档保持索引原序 —— 原序 = 后端返回序）；
//   · 每组最多 MAX_PER_GROUP 条；组序固定 Agent → 评估计划 → 评估器 → 数据集；
//   · 空查询 = 不出结果（面板只显示 placeholder，不把四张表全倒出来）。

export type SearchGroup = "agent" | "plan" | "evaluator" | "dataset";

export interface SearchItem {
  group: SearchGroup;
  /** 关联键：agent_name / plan_id / 评估器名 / 数据集名（进路由的那个） */
  key: string;
  /** 主显 */
  label: string;
  /** 副标（改过显示名的 Agent 给原名；评估计划给 agent_name） */
  sub?: string;
  /** 参与匹配的全部字串（label 之外还有键、原名等） */
  terms: string[];
}

export const GROUP_ORDER: readonly SearchGroup[] = ["agent", "plan", "evaluator", "dataset"];
export const MAX_PER_GROUP = 5;

/** 0 = 不中；2 = 某个 term 前缀命中；1 = 仅子串命中 */
export function matchRank(item: SearchItem, needle: string): 0 | 1 | 2 {
  const n = needle.trim().toLowerCase();
  if (!n) return 0;
  let best: 0 | 1 | 2 = 0;
  for (const t of item.terms) {
    const s = (t ?? "").toLowerCase();
    if (!s) continue;
    if (s.startsWith(n)) return 2;
    if (s.includes(n)) best = 1;
  }
  return best;
}

export function searchGroups(
  index: readonly SearchItem[],
  query: string,
  limit: number = MAX_PER_GROUP,
): { group: SearchGroup; items: SearchItem[] }[] {
  if (!query.trim()) return [];
  const out: { group: SearchGroup; items: SearchItem[] }[] = [];
  for (const g of GROUP_ORDER) {
    const ranked = index
      .map((item, i) => ({ item, i, r: item.group === g ? matchRank(item, query) : 0 }))
      .filter((x) => x.r > 0)
      // 稳定排序：先按档（前缀 > 子串），同档按原序
      .sort((a, b) => b.r - a.r || a.i - b.i)
      .slice(0, limit)
      .map((x) => x.item);
    if (ranked.length) out.push({ group: g, items: ranked });
  }
  return out;
}
