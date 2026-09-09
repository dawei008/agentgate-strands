// 文本短显（截断 / 会话 id 短形式）。零依赖纯函数。
//
// 为什么住 lib/ 而不是就近某个页面模块：这两条口径的消费方跨 components/ 与
// pages/ 两层，而 **components/ 不许 import pages/**（现网这条约束成立：
// `grep -rn 'from "../pages' src/components/` 零命中）。会话短 id 原住
// pages/plan/reportRows.ts，SynthesisText.tsx 因此另写了一份 18 字截尾版 ——
// 同一屏上问题条目印 `dsh-trace-e5d8fb96…` 而矩阵行印 `e5d8fb96`，两个短形式
// 对不上。搬到这里是让两层共用同一份，**口径本身没变**（仍是 reportRows 那份）。

/**
 * 截断到 cap 字并加省略号；不超长原样返回。
 *
 * cap 由调用方给：导出报告首句 120、台账问题格 18、行内 JSON 预览 120 —— 长度是
 * 版面决定的，这里统一的是「怎么截」（**必须留「…」**：不加省略号等于假装说完了）。
 */
export function clipText(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

/**
 * 会话 id 的**界面短显**：第一段 8 位 hex。
 *
 * 现网 `dsh-trace-e5d8fb96-…` → `e5d8fb96`；mock `sess-7f3a9c21b8d4e6f0` →
 * `7f3a9c21`；一段 8 位 hex 都没有（`sess-abc`）→ 原样。
 *
 * 只作**展示**：深链、去重键、data-full 一律用完整 id（短形式会撞）。
 * 需要更长形态的位置不要在这里加参数 —— 同一个 id 在同一屏上只能有一种短样子，
 * 那正是本函数存在的原因。
 */
export function shortSessionId(id: unknown): string {
  const s = String(id ?? "");
  const m = /[0-9a-f]{8}/i.exec(s);
  return m ? m[0] : s;
}
