// 「删句双钉」共享断言（/simplify 2026-08-30 收敛：同一形状此前在 5 个测试文件
// 手写了 15 遍、三种方言 —— querySelector('[title*=…]') / getAttribute 判 null /
// queryByTitle 各一派，短语逐处手拼，漏钉无提示）。
//
// 钉的是「无废话终裁」（CLAUDE.md 工作纪律）：被删的通用句必须**版面无 + title 无**
// —— 只钉 textContent 会与「整块没渲染」同形（title 里还挂着就没删干净）；
// 只钉 title 会漏掉句子回流进版面。两半都要，所以收成一个入口。
//
// ⚠️ 这是逐句的「复活钉」，只防已删句子在钉过的容器里回来；「新组件新写一句
// 通用散文」由机制性的 prose-guard 拦（已立档，vocab-guard 模板，未建）。
import { expect } from "vitest";

/**
 * 断言这些短语在 el 里彻底不存在：既不在渲染文本里，也不在任何后代的 title 上。
 * 短语用**片段**即可（contains 匹配），但要挑被删句子专属的字样 ——
 * 拿两态都有的词当锚 = 门槛数据（test-waitfor-anchor-discipline）。
 */
export function expectProseGone(el: HTMLElement, ...phrases: string[]): void {
  for (const p of phrases) {
    expect(el.textContent ?? "", `「${p}」仍在版面文本里`).not.toContain(p);
    expect(
      el.querySelector(`[title*="${p}"]`),
      `「${p}」仍挂在某个 title 上（删句要求版面与 title 双无）`,
    ).toBeNull();
    // 容器自己的 title 也算（querySelector 不含自身）
    expect(
      (el.getAttribute("title") ?? "").includes(p),
      `「${p}」仍在容器自身的 title 上`,
    ).toBe(false);
  }
}
