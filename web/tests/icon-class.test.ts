// 图标基类选择器钉（icon-missing-ic-class 批，档案：.scratch/triage-r1/issues/icon-missing-ic-class.md）。
// 缺陷：stroke/fill 等图标画笔属性只定义在 `.ic`，而全仓 17 处调用点的 class 列表
// 只含 `ic-sm`（其中两处是 `ic-sm chev`）—— 纯线条图标（close/chev/warn 等）什么都渲染不出，
// 有面积的退化成近黑填充（报告抽屉关闭钮长期空框）。
// 修法：base.css 把那条画笔声明的选择器扩为 `.ic, .ic-sm`（一处声明两个选择器），
// `.ic-sm` 的尺寸覆盖行（13px，在后、同特异性）保持独立不动。
// jsdom 不算层叠样式，故走 CSS/TSX 原文静态断言（与 glass-guard 同款手法）。
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const baseCss = readFileSync(resolve(process.cwd(), "src/styles/base.css"), "utf8");

/** 朴素规则解析：去注释后拆 [selector, body]（与 glass-guard 同款，够用） */
function rules(css: string): Array<{ sel: string; body: string }> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ sel: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments))) {
    const sel = m[1].trim();
    if (sel.startsWith("@")) continue;
    out.push({ sel, body: m[2] });
  }
  return out;
}

const baseRules = rules(baseCss);
/** 选择器逗号拆分后精确匹配（防 `.ic` 误命中 `.ic-sm` / `.side nav button .ic` 等上下文规则） */
const selHas = (sel: string, cls: string) => sel.split(",").map((s) => s.trim()).includes(cls);

describe("图标基类选择器（.ic 画笔属性必须同时罩住 .ic-sm）", () => {
  it("stroke/fill 所在声明的选择器同时含 .ic 与 .ic-sm（三角钉：字面量硬编码）", () => {
    // 找「画笔声明」：带 stroke: currentColor 的顶层规则（全仓应恰好一条）。
    const brush = baseRules.filter((r) => /stroke:\s*currentColor/.test(r.body));
    expect(brush).toHaveLength(1);
    // 三角钉：对硬编码字面量断言（不 import 常量对 import 常量，防恒真）。
    expect(selHas(brush[0].sel, ".ic")).toBe(true);
    expect(selHas(brush[0].sel, ".ic-sm")).toBe(true);
    // 画笔属性齐全（fill:none 一起在这条声明里，缺了有面积图标会退化成填充）。
    expect(brush[0].body).toMatch(/fill:\s*none/);
    expect(brush[0].body).toMatch(/stroke-width:\s*1\.75/);
  });

  it("反向钉：.ic-sm 的尺寸覆盖声明仍独立存在（13px，在画笔声明之后）", () => {
    // 尺寸覆盖必须是独立的后置规则（同特异性靠顺序把 16px 覆盖回 13px）——
    // 若有人把它并进画笔声明或删掉，13px 小图标就回不去了。
    const sizeOnly = baseRules.filter(
      (r) => r.sel === ".ic-sm" && /width:\s*13px/.test(r.body) && /height:\s*13px/.test(r.body),
    );
    expect(sizeOnly).toHaveLength(1);
    // 顺序钉：画笔声明的源文本位置必须在尺寸覆盖之前（顺序反了 13px 会被 16px 压回去）。
    const brushIdx = baseCss.search(/stroke:\s*currentColor/);
    const sizeIdx = baseCss.indexOf(".ic-sm { width: 13px");
    expect(brushIdx).toBeGreaterThan(-1);
    expect(sizeIdx).toBeGreaterThan(brushIdx);
  });

  it("现算钉：全仓「class 列表含 ic-sm 且不含 ic」的调用点恰 16 处（计数变了先重读档案再动这行）", () => {
    // 16 = 15 + 1（2026-09-07 badcase-ux-fix：IssueLedger.tsx 每条问题的「查看 trace」链接带 ext
    // 一处 —— 只在报告页传 traceHref 时渲染（③ 优化页不传、不画），画笔属性由 .ic-sm 自带，合规）。
    // 15 = 11 + 4（2026-09-04 report-redesign-a：报告独立页换成变体 A，页脚 ReportFooter.tsx
    // 的 导出(download) / 查看 trace(ext) / 上一 run(chev-l) / 下一 run(chev-r) 四处 ——
    // 与 ReportView 页脚同款四枚，画笔属性由 .ic-sm 自带，合规；抽屉那四处仍在，不是搬家）。
    // 11 = 14 − 3（2026-09-03 adr0014-migrate：ImprovementBlock.tsx 随采纳追踪迁到
    // 评估分析页而删除，它的三处 `check` 采纳态图标一并下线；新采纳表用 badge
    // 文字态、不带图标 —— 净 −3）。
    // 14 = 13 + 1（2026-08-31 ADR-0014 §6 本次建议区：RunAdvice.tsx 的采纳态
    // check 一处 —— 画笔属性由 .ic-sm 自带（icon-missing-ic-class 修法 1），合规）。
    // 13 = 18 − 5（2026-08-31 ADR-0014 报告重构：旧 StageLine 的 circle/warn/check
    // 三处、正文两条警示条的 warn 两处随旧结构下线；新表 RowLine 的折叠箭头
    // `ic-sm chev` 顶替了 CaseLine/SessionLine 那两处中的一处，净 −5 ——
    // 画笔属性仍由 .ic 选择器罩住，合规）。
    // 新增调用点写 `className="ic-sm"` 即可（画笔属性由本选择器罩住，不必再带 `ic `）；
    // 但若某处要 16px 请写 `className="ic"`。计数变化 = 有人加/删了调用点，
    // 先读 .scratch/triage-r1/issues/icon-missing-ic-class.md 对齐口径再更新数字。
    //
    // 判据按**类名列表**算，不按属性值的字面串算：上一版写 `/className="ic-sm"/g` + 15，
    // 精确串匹配把 `className="ic-sm chev"` 两处（ReportDrawer.tsx、compare/CompareDrawer.tsx）
    // 整个漏掉 —— 守卫的匹配面窄于它自称的面，与「字面 NUL 让 grep 跳过整文件」同族。
    // 档案：.scratch/triage-r1/issues/icon-class-guard-blind-slots.md。
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(resolve(process.cwd(), "src"));

    let sites = 0; // class 列表含 ic-sm 且不含 ic
    let mentions = 0; // 全文出现的 ic-sm 词元（含静态属性之外的任何写法）
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      mentions += (src.match(/\bic-sm\b/g) ?? []).length;
      for (const m of src.matchAll(/className="([^"]*)"/g)) {
        const tokens = m[1].split(/\s+/).filter(Boolean);
        if (tokens.includes("ic-sm") && !tokens.includes("ic")) sites += 1;
      }
    }
    expect(sites).toBe(16);
    // 匹配面守卫：ic-sm 只许出现在静态 className 里。若将来有人动态拼类名
    // （模板串 / clsx / 变量），上面那条计数会悄悄漏掉它 —— 本条先红，逼人扩判据，
    // 而不是让「17 处」这个数字变成一个匹配面之外的空话。
    expect(mentions).toBe(sites);
  });
});
