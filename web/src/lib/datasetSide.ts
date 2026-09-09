// 数据集侧别归类 —— UI 四类/存储三类的「双读」规则（原型 regression-split README 定案）。
// - kind==="simulation" 显式归模拟侧：空集意图也成立（新建还没加任务时不能掉回回归 tab）；
// - 历史多轮集 kind 仍是 "regression"，按 cases 形态推断兜底（用例带 task_description
//   即「多轮形态」——后端据此走多轮跑法——有这类用例即模拟侧），
//   不迁移数据、老集合不会凭空消失；
// - 混合集（多轮/单轮同集）归模拟侧（模拟列是回归列的超集，往信息更丰富的一侧归），
//   由调用方打「混合」badge，中性、不阻断。
export interface DatasetSideLike {
  kind?: string;
  cases?: { task_description?: unknown }[];
}

export function isSimulationSide(d: DatasetSideLike): boolean {
  if (d.kind === "simulation") return true;
  if (d.kind === "redteam") return false;
  return (d.cases ?? []).some((c) => Boolean(c.task_description));
}

/** 混合集：模拟侧 && 既有多轮任务又有非多轮用例。 */
export function isMixedDataset(d: DatasetSideLike): boolean {
  if (!isSimulationSide(d)) return false;
  const cases = d.cases ?? [];
  const multi = cases.filter((c) => Boolean(c.task_description)).length;
  return multi > 0 && multi < cases.length;
}
