// 顶栏窄屏守卫（批 topnav-narrow，2026-09-03 热修）。
// 现场：base.css 的 `@media (max-width: 900px)` 曾把 `.nb-link.sub, .nb-sep { display: none }`
// —— 「评估计划 / 评估器 / 数据集」三项资产导航在 < 900px 整段消失，没有汉堡也没有溢出
// 菜单，用户找不到导航。这里把纪律钉进 CI：
//   **任何 @media 块内，选择器含 .nb-link / .nb-nav 的规则体里不许出现 display: none**。
// 分隔线 .nb-sep 不是入口，允许隐藏；.nb-group 只允许收窄 / 横向滚动，不许消失。
// jsdom 不算媒体查询，故走 CSS 原文静态断言（解析写法与 glass-guard.test.ts 的 rules() 同族，
// 但这里要**保留** @media 的归属：只查媒体块内的规则，桌面基线规则不在射程内）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const baseCss = readFileSync(resolve(process.cwd(), "src/styles/base.css"), "utf8");

/** 导航入口选择器：命中其一的规则体受「不许 display: none」约束 */
const NAV_ENTRY = [".nb-link", ".nb-nav"];
const DISPLAY_NONE = /display\s*:\s*none\b/;

/**
 * 从 CSS 原文里抠出所有 @media 块，返回每块内的 [selector, body] 规则对。
 * 朴素解析：去注释 → 逐个 `@media` 头 → 按花括号配对找块尾 → 块内用与 glass-guard 同款的
 * `sel { body }` 正则拆规则。嵌套 @ 块不在本仓库 CSS 里出现，故不处理。
 */
export function mediaRules(css: string): Array<{ media: string; sel: string; body: string }> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ media: string; sel: string; body: string }> = [];
  const head = /@media\s*([^{]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(noComments))) {
    // 从块头的 `{` 之后开始配对花括号，找到这个 @media 块的结束位置
    let depth = 1;
    let i = head.lastIndex;
    while (i < noComments.length && depth > 0) {
      const ch = noComments[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    const inner = noComments.slice(head.lastIndex, i - 1);
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let r: RegExpExecArray | null;
    while ((r = re.exec(inner))) {
      out.push({ media: m[1].trim(), sel: r[1].trim(), body: r[2] });
    }
    head.lastIndex = i;
  }
  return out;
}

/** 返回违规清单：媒体块内、选择器含导航入口、规则体含 display: none */
export function navHiddenInMedia(css: string): string[] {
  const offenders: string[] = [];
  for (const { media, sel, body } of mediaRules(css)) {
    if (!DISPLAY_NONE.test(body)) continue;
    for (const s of sel.split(",").map((x) => x.trim())) {
      if (NAV_ENTRY.some((k) => s.includes(k))) offenders.push(`@media ${media} → ${s}`);
    }
  }
  return offenders;
}

/** 阳性对照：现场那段旧 CSS（base.css 2026-09-03 v0.34.0 174-185 行原文） */
const OLD_BROKEN_CSS = `
@media (max-width: 900px) {
  .tb-inner { padding: 0 var(--sp-4); }
  .tb-row { display: flex; justify-content: space-between; }
  .nb-group { margin-right: auto; }
  .nb-link.sub, .nb-sep { display: none; }
  .tb-search { min-width: 0; padding: 0 var(--sp-2); }
  .tb-search-txt, .tb-search kbd, .tb-vsep, .tb-version { display: none; }
}
@media (max-width: 560px) {
  .brand .word, .tb-env, .tb-win { display: none; }
  .nb-link { padding: 0 var(--sp-3); }
}
`;

describe("顶栏窄屏守卫：导航项在任何宽度都不许 display: none", () => {
  it("base.css 的每个 @media 块里，.nb-link / .nb-nav 规则体都没有 display: none", () => {
    expect(navHiddenInMedia(baseCss)).toEqual([]);
  });

  it("量具自检：至少解析出一个 @media 块（否则「零违规」只是没扫到）", () => {
    const parsed = mediaRules(baseCss);
    expect(parsed.length).toBeGreaterThan(0);
    // 900px 收窄块在本仓库一直存在；解析不到它 = 解析器坏了，不是 CSS 干净
    expect(parsed.some((r) => /900px/.test(r.media))).toBe(true);
  });

  it("阳性对照：现场那段旧 CSS 喂同一函数必须红（且只红 .nb-link.sub 这一条）", () => {
    const hits = navHiddenInMedia(OLD_BROKEN_CSS);
    expect(hits).toEqual(["@media (max-width: 900px) → .nb-link.sub"]);
  });

  it("阳性对照 2：容忍空格与换行写法（display :none / display:\\n none）", () => {
    const sloppy = `@media (max-width: 700px) { .nb-nav { display :none } .nb-link{display:\n none;} }`;
    expect(navHiddenInMedia(sloppy)).toEqual([
      "@media (max-width: 700px) → .nb-nav",
      "@media (max-width: 700px) → .nb-link",
    ]);
  });

  it("阴性对照：桌面基线（非 @media）里的 display: none 不在射程；.nb-sep 隐藏允许", () => {
    const ok = `
      .nb-link.legacy { display: none; }
      @media (max-width: 900px) { .nb-sep { display: none; } .nb-link { padding: 0 var(--sp-2); } }
    `;
    expect(navHiddenInMedia(ok)).toEqual([]);
  });
});
