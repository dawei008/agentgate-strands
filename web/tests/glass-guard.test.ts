// 设计骨架 v2「实心分层观测台」形态护栏（ADR-0016，2026-09-03；施工单
// shared-tools/agentgate-design-system-v2/CHANGES.md §C）。
// v1 是 v3-C 暗色玻璃拟态（原型 ui-prototypes/design-v3/variant-c-glass/index.html）；
// v2 保留身份（色值 / 字体零变更）换骨架：卡片实心 + 发丝线阶梯，玻璃只剩 hero 与浮层。
// 这组测试把 v2 的克制纪律钉死在 CI 里：
//   1) 玻璃只上 hero 与浮层（白名单 4 条、上限 = 名单条数零余量）；卡片零玻璃零 sheen；
//   2) 表格零玻璃（thead/tbody/表内任何选择器不得出现 backdrop-filter）；
//   3) chip / badge / 输入面等小字底必须实心不透明（--bg2）；
//   4) 焦点环 outline 型（box-shadow 环会被 hero 玻璃 glow 吃掉——原型实测坑）；
//   5) 关键文字/底组合对比度 ≥ 4.5（对实心 --panel 实算：卡改实心后它比玻璃有效底更亮，是下界）；
//   6) 发丝线只走阶梯（ui/base/页面 css 不许再手写 rgba 白线，例外登记带理由）；
//   7) 表格密度令牌不动、数字三档钉值、--fs-display 只落在 hero、光效限量。
// jsdom 不渲染 backdrop-filter，故走 CSS 原文静态断言 + 对比度公式计算。
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const tokensCss = read("src/styles/tokens.css");
const uiCss = read("src/styles/ui.css");
const baseCss = read("src/styles/base.css");
const pageCss = [
  "src/pages/run/run.css",
  "src/pages/plan/plan.css",
  "src/pages/agents/agents.css",
  "src/pages/resources/resources.css",
  "src/pages/workbench/workbench.css",
  // 组件级样式表也扫：toast 的规则从 workbench.css 搬进 components/ 后，
  // 不加进来就等于把一段全局浮层样式移出了玻璃纪律的射程（simplify-r2 D-5）。
  "src/components/toast.css",
  // 设置三分节随抽屉搬进 components/settings/（L8），样式表跟着换路径
  "src/components/settings/settings.module.css",
  // 综合报告正文渲染件（运行详情页折叠块的正文；chip 走 .badge 语义类）
  "src/components/SynthesisText.css",
  // 下面三张是**棘轮上线时补登的历史漏登**（本批新加的棘轮一次抓出三个：
  // 它们此前从未受玻璃纪律约束，而全套测试一直全绿 —— 这正是静态白名单的失效
  // 形态「无信号 ≠ 没违规」）。补登后逐条实测：违规数 0，无需豁免。
  "src/components/ConfirmCard.css",
  "src/pages/agents/autoconf.css",
  "src/pages/bigscreen/bigscreen.css",
  // Run 对比的共享视图样式从 plan.css 搬出来（抽屉与独立对比页共吃一份）
  "src/pages/plan/compare/compareview.css",
  // 运行报告的共享视图样式同理（抽屉与独立报告页共吃一份）
  "src/pages/plan/reportview.css",
  // 独立报告页的页面壳
  "src/pages/report/report.css",
  // 跨版本对比独立页的页面壳
  "src/pages/compare/compare.css",
  // 评估分析页的跨 run 区块（趋势图 / 两段卡 / 采纳追踪表）的页面壳
  "src/pages/compare/analysis.css",
  // 同题配对 / 会话并排 diff / 单栏回放（ADR-0017 D3 / F8）
  "src/pages/compare/pairs.css",
  // Agent 详情 ③ 优化（评估器面板 + 问题台账）的页面壳
  "src/pages/agents/detail/hub/optimize.css",
  // Agent 详情 ① 现状「路径」卡（SVG 有向图 + 节点详情栏，ADR-0017 D4）
  "src/pages/agents/detail/hub/topology.css",
].map((p) => ({ path: p, css: read(p) }));
const allCss = [
  { path: "src/styles/tokens.css", css: tokensCss },
  { path: "src/styles/ui.css", css: uiCss },
  { path: "src/styles/base.css", css: baseCss },
  ...pageCss,
];

// ---------- 棘轮：这张名单必须是全仓样式表的全集 ----------
// 上面那张 pageCss 是**静态**白名单 —— 新加一个样式表却忘了登记，等于把那一整
// 页悄悄挪出玻璃纪律的射程，而全套测试照样全绿（「无信号」不是「没违规」）。
// 所以拿磁盘现算一遍：src 下每个 .css 都必须出现在扫描集里。
// ⚠️ 判据是「差集为空」而不是「计数相等」：计数相等在「漏登一个 + 多登一个
// 不存在的」时也成立，而后者 read() 会先抛错——两种失败长得不一样才好查。
describe("扫描面棘轮：src 下每个样式表都在玻璃纪律射程内", () => {
  it("磁盘上的 .css 全集 ⊆ 被扫描的路径集", () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const ent of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
        const p = `${dir}/${ent.name}`;
        if (ent.isDirectory()) out.push(...walk(p));
        else if (ent.name.endsWith(".css")) out.push(p);
      }
      return out;
    };
    const onDisk = walk("src").sort();
    const scanned = new Set(allCss.map((c) => c.path));
    const unregistered = onDisk.filter((p) => !scanned.has(p));
    expect(unregistered, "新样式表要加进 pageCss（或 allCss）才受玻璃纪律约束").toEqual([]);
    // 阳性对照：走查真的走到了文件（空数组 ⊆ 任何集合，恒绿）
    expect(onDisk.length).toBeGreaterThanOrEqual(allCss.length);
  });
});

/** 把 CSS 拆成 [selector, body] 规则对（够用的朴素解析：跳过注释与 @ 块头） */
function rules(css: string): Array<{ sel: string; body: string }> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ sel: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments))) {
    const sel = m[1].trim();
    if (sel.startsWith("@")) continue; // @keyframes/@media 头（内部规则会被上层 re 再吃到）
    out.push({ sel, body: m[2] });
  }
  return out;
}

// ---------- 纪律 1：blur 预算白名单（v2 = hero + 浮层） ----------
// 允许挂 backdrop-filter 的选择器。v1 名单 11 条（卡片族 + 浮层）；v2 移出 7 条：
// .card / .u-empty / .agents-empty / .agent-detail-block / .plan-stage-card / .run-cols .col
// 全部转实心（--card-bg + --card-border），以及 .settings-drawer（死条目：base.css 该规则
// 早已无 blur，「名单里有它」与「它在用玻璃」在读数上同形）。新增浮层必须先进名单。
const GLASS_BUDGET = [
  ".kpi-strip",         // ui.css hero KPI 条 —— 全站唯一玻璃卡
  ".drawer-panel",      // base.css 通用抽屉壳（浮层）
  ".auth-card",         // base.css 登录卡（浮层）
  // 待议：大屏（挂墙 1920×1080 独立页）的玻璃卡，一条规则被顶条/4 张 KPI/2 个面板/
  // 运行带共用。v2 本批不动（CHANGES.md R28）；若转实心则同 .card 配方且圆角走 --r-hero。
  ".bs-glass",
];

describe("玻璃纪律 1：blur 预算白名单 = hero + 浮层，恒 1 层", () => {
  it("所有 backdrop-filter 都落在白名单选择器上", () => {
    const offenders: string[] = [];
    for (const { path, css } of allCss) {
      for (const { sel, body } of rules(css)) {
        if (!/backdrop-filter\s*:/.test(body)) continue;
        const selectors = sel.split(",").map((s) => s.trim());
        for (const s of selectors) {
          if (!GLASS_BUDGET.some((ok) => s === ok || s.endsWith(ok))) {
            offenders.push(`${path} → ${s}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it(`玻璃预算 ≤ ${GLASS_BUDGET.length} 处（= 名单条数，零余量）`, () => {
    let n = 0;
    for (const { css } of allCss) {
      for (const { body } of rules(css)) {
        // -webkit- 与标准属性成对出现算 1 处
        if (/[^-]backdrop-filter\s*:/.test(body)) n += 1;
      }
    }
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(GLASS_BUDGET.length);
  });

  // v2 新钉：卡片零玻璃、零 sheen。选择器含 card / block / col / empty 的规则体不得出现
  // backdrop-filter 或 --glass-sheen。白名单里的浮层（.auth-card 含 "card" 字样但是登录
  // 浮层不是卡片）按名单放行 —— 放行的是「名单」不是「字样」，所以 .card 本身进不来。
  it("卡片族（card / block / col / empty）零 backdrop-filter、零 --glass-sheen", () => {
    const offenders: string[] = [];
    let heroSeen = false;
    for (const { path, css } of allCss) {
      for (const { sel, body } of rules(css)) {
        const glassy = /backdrop-filter\s*:/.test(body) || /--glass-sheen/.test(body);
        if (!glassy) continue;
        if (sel === ".kpi-strip") heroSeen = true;
        for (const s of sel.split(",").map((x) => x.trim())) {
          if (GLASS_BUDGET.some((ok) => s === ok || s.endsWith(ok))) continue;
          if (/card|block|\.col\b|empty/.test(s)) offenders.push(`${path} → ${s}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // 阳性对照：hero 规则体必须真的含玻璃 —— 否则上面的 glassy 判定从未走到分支，
    // 「offenders 为空」就是无信号而不是零违规。
    expect(heroSeen, ".kpi-strip 规则体应含 backdrop-filter（阳性对照）").toBe(true);
  });

  it("玻璃值只走 --glass-blur 令牌（不许手写 blur(...)）", () => {
    for (const { path, css } of allCss) {
      if (path.endsWith("tokens.css")) continue; // 令牌定义处
      for (const { sel, body } of rules(css)) {
        const m = body.match(/backdrop-filter\s*:\s*([^;]+);/);
        if (m) {
          expect(m[1].trim(), `${path} → ${sel}`).toBe("var(--glass-blur)");
        }
      }
    }
  });
});

// ---------- 纪律 2：表格零玻璃 ----------
describe("玻璃纪律 2：表格零玻璃", () => {
  it("含 table/thead/tbody/td/th 的选择器出现 backdrop-filter 的违规数 = 0", () => {
    const offenders: string[] = [];
    for (const { path, css } of allCss) {
      for (const { sel, body } of rules(css)) {
        if (!/backdrop-filter\s*:/.test(body)) continue;
        if (/\b(table|thead|tbody|td|th|tr)\b|u-table/i.test(sel)) {
          offenders.push(`${path} → ${sel}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("thead 底是纯 tint（--tint-1），行 hover 是纯 tint（--tint-2）", () => {
    expect(uiCss).toMatch(/\.u-table thead th\s*\{[^}]*background:\s*var\(--tint-1\)/);
    expect(uiCss).toMatch(/\.u-table tbody tr:hover td\s*\{\s*background:\s*var\(--tint-2\)/);
  });
});

// ---------- 纪律 3：chip / badge / 输入面实心 ----------
describe("玻璃纪律 3：小字底实心不透明", () => {
  it("chip 基底 = 实心 var(--bg2)", () => {
    const chip = rules(uiCss).find((r) => r.sel === ".chip");
    expect(chip).toBeDefined();
    expect(chip!.body).toMatch(/background:\s*var\(--bg2\)/);
  });
  it("badge 中性基底 = 实心 --neutral-bg（= #272F42）", () => {
    const badge = rules(uiCss).find((r) => r.sel === ".badge");
    expect(badge).toBeDefined();
    expect(badge!.body).toMatch(/background:\s*var\(--neutral-bg\)/);
    expect(tokensCss).toMatch(/--neutral-bg:\s*#272F42/);
  });
  it("输入面（.u-input 族）= 实心 var(--bg2)", () => {
    const input = rules(uiCss).find((r) => r.sel.includes(".u-input"));
    expect(input).toBeDefined();
    expect(input!.body).toMatch(/background:\s*var\(--bg2\)/);
  });
  // 原钉「侧栏实心 #131A2B」：侧栏随 ADR-0016 撤成单行顶栏（chrome，纪律 3 同样适用）。
  // 顶栏未滚动透明、吸顶后实心画布色 + 发丝线；两态都不许 backdrop-filter。
  it("顶栏是 chrome：吸顶态实心 var(--bg)，两态都不带 backdrop-filter", () => {
    const top = rules(baseCss).find((r) => r.sel === ".topnav");
    expect(top).toBeDefined();
    expect(top!.body).not.toMatch(/backdrop-filter/);
    const scrolled = rules(baseCss).find((r) => r.sel === ".topnav.scrolled");
    expect(scrolled).toBeDefined();
    expect(scrolled!.body).toMatch(/background:\s*var\(--bg\)/);
    expect(scrolled!.body).not.toMatch(/backdrop-filter/);
    // 反向钉：旧侧栏规则不许残留（残留 = 两套 chrome 同时在场）
    expect(rules(baseCss).find((r) => r.sel === ".side")).toBeUndefined();
  });
});

// ---------- 纪律 4：焦点环 outline 型 ----------
describe("玻璃纪律 4：焦点环 outline 型（box-shadow 环被 glow 吃掉）", () => {
  it("全站 :focus-visible 规则不再用 box-shadow 画环", () => {
    const offenders: string[] = [];
    for (const { path, css } of allCss) {
      if (path.endsWith("tokens.css")) continue;
      for (const { sel, body } of rules(css)) {
        if (!sel.includes(":focus-visible")) continue;
        if (/box-shadow\s*:\s*var\(--focus-ring\)/.test(body) ||
            /box-shadow\s*:\s*(inset\s+)?0 0 0/.test(body)) {
          offenders.push(`${path} → ${sel}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
  it("--focus-outline 令牌存在且为 2px 实线亮绿", () => {
    expect(tokensCss).toMatch(/--focus-outline:\s*2px solid #4ADE80/);
  });
});

// ---------- 对比度（C 案值实算） ----------
type RGB = [number, number, number];
function hex(s: string): RGB {
  const h = s.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
/** src(alpha) 叠在 dst 上的合成色 */
function over(src: RGB, alpha: number, dst: RGB): RGB {
  return [0, 1, 2].map((i) => Math.round(src[i] * alpha + dst[i] * (1 - alpha))) as RGB;
}
function lum([r, g, b]: RGB): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
describe("对比度断言（v2 实心 --panel 基底，WCAG 公式实算）", () => {
  const ratio = (fg: RGB, bg: RGB) => {
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  };
  const BG = hex("#0F172A");
  // v2 基底 = 实心卡面 --panel #1B2336。v1 量的是玻璃有效底 rgba(27,35,54,.6) over #0F172A
  // = #161E31，比 panel 更暗、比值更高；hero 仍是玻璃但同理更宽松 ⇒ panel 是全站下界。
  // 最紧一档：--faint on panel = 4.59（勿再压暗任何一侧）。
  const PANEL = hex("#1B2336");
  const BG2 = hex("#272F42");
  // 阳性对照：基底切换方向要对 —— panel 必须比 v1 玻璃有效底更亮（更紧），否则是把
  // 尺子放松了而不是收紧了（`over` 保留即为此处的对照用）。
  it("基底切换方向：实心 --panel 比 v1 玻璃有效底更亮（比值更紧）", () => {
    const GLASS_V1 = over(PANEL, 0.6, BG);
    expect(lum(PANEL)).toBeGreaterThan(lum(GLASS_V1));
  });

  it("主文字 --text on 实心卡/画布/实心 chip ≥ 7", () => {
    const TEXT = hex("#F8FAFC");
    expect(ratio(TEXT, PANEL)).toBeGreaterThanOrEqual(7);
    expect(ratio(TEXT, BG)).toBeGreaterThanOrEqual(7);
    expect(ratio(TEXT, BG2)).toBeGreaterThanOrEqual(7);
  });
  it("次要文字 --muted (#94A3B8) on 实心卡与实心 chip ≥ 4.5", () => {
    const MUTED = hex("#94A3B8");
    expect(ratio(MUTED, PANEL)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(MUTED, BG2)).toBeGreaterThanOrEqual(4.5);
  });
  it("最弱灰 --faint (#7D8CA3) on 实心卡 ≥ 4.5（不得放 --bg2 上——那是 --faint-on-sunken 的岗）", () => {
    const FAINT = hex("#7D8CA3");
    expect(ratio(FAINT, PANEL)).toBeGreaterThanOrEqual(4.5);
  });
  it("链接/达标分 --accent-fg (#4ADE80) on 实心卡 ≥ 4.5；主按钮深字 on 绿底 ≥ 4.5", () => {
    expect(ratio(hex("#4ADE80"), PANEL)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex("#0F172A"), hex("#22C55E"))).toBeGreaterThanOrEqual(4.5);
  });
  it("危险文字 --bad (#F87171) 与警示 #FBBF24 on 实心卡 ≥ 4.5", () => {
    expect(ratio(hex("#F87171"), PANEL)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex("#FBBF24"), PANEL)).toBeGreaterThanOrEqual(4.5);
  });
  it("凹陷面辅助字 --faint-on-sunken (#8B99B0) on --bg2 ≥ 4.5", () => {
    expect(ratio(hex("#8B99B0"), BG2)).toBeGreaterThanOrEqual(4.5);
  });
});

// ---------- 主题机制清除 ----------
describe("恒暗：data-theme 机制不复存在", () => {
  it("CSS 里没有 html[data-theme] 选择器（注释除外）", () => {
    for (const { path, css } of allCss) {
      for (const { sel } of rules(css)) {
        expect(sel, path).not.toContain("data-theme");
      }
    }
  });
  it("光斑与网格挂在 body 伪元素上，reduced-motion 停光斑动画", () => {
    expect(baseCss).toMatch(/body::before\s*\{[^}]*radial-gradient/);
    expect(baseCss).toMatch(/body::after\s*\{[^}]*56px 56px/);
    expect(baseCss).toMatch(/prefers-reduced-motion[\s\S]*body::before\s*\{\s*animation:\s*none/);
  });
});

// ---------- v2 纪律 6：发丝线只走阶梯 ----------
// 卡片改实心后边界只剩一条低 alpha 白线，层级由 alpha 阶梯给出
// （--hairline-soft .045 / --hairline .07 / --hairline-border .08 / --hairline-strong .12 /
// --hairline-hover .20；chip/kbd 描边沿用 --neutral-line .09）。选边框先问「它隔的是什么层」
// 再选档，不许再手写 rgba 白线 —— 否则阶梯会在半年内重新散成十几个 alpha。
// 射程：ui.css / base.css + pages/ 下全部样式表（不含 bigscreen.css —— 待议页，本批不动）。
// components/ 下的样式表（ConfirmCard / settings.module / toast …）本批不在白名单内，
// 登记为欠账：它们仍有 .045/.10/.12/.20 手写白线，收进阶梯时把路径从 EXEMPT_FILES 移出即红即改。
const HAIRLINE_EXEMPT_FILES = new Set<string>([
  "src/pages/bigscreen/bigscreen.css",              // 待议（CHANGES.md R28）
  "src/components/ConfirmCard.css",                 // 欠账：.12 → --hairline-strong
  "src/components/settings/settings.module.css",    // 欠账：.045/.10/.12/.20 → 阶梯
  "src/components/toast.css",                       // 欠账（未核）
  "src/components/SynthesisText.css",               // 欠账（未核）
]);
// 登记例外（带理由）：空态 / 分节的 1px dashed .16 —— v1 值，虚线不是层级边界，未入阶梯。
const HAIRLINE_EXEMPT_DECLS = [/1px dashed rgba\(255, 255, 255, \.16\)/];

describe("v2 纪律 6：发丝线只走阶梯（不许手写 rgba 白线）", () => {
  const HAIRLINE_SCOPE = allCss.filter(
    (c) => !c.path.endsWith("tokens.css") && !HAIRLINE_EXEMPT_FILES.has(c.path),
  );
  it("射程含 ui.css / base.css 与页面样式表（阳性对照：不是空集）", () => {
    const paths = HAIRLINE_SCOPE.map((c) => c.path);
    expect(paths).toContain("src/styles/ui.css");
    expect(paths).toContain("src/styles/base.css");
    expect(paths).toContain("src/pages/plan/plan.css");
    expect(paths.length).toBeGreaterThanOrEqual(10);
  });
  it("border* 声明里的 rgba(255,255,255,…) 违规数 = 0（dashed .16 登记例外）", () => {
    const offenders: string[] = [];
    const re = /border[^:;{}]*:\s*[^;{}]*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,[^)]*\)/g;
    for (const { path, css } of HAIRLINE_SCOPE) {
      for (const { sel, body } of rules(css)) {
        for (const m of body.matchAll(re)) {
          if (HAIRLINE_EXEMPT_DECLS.some((ex) => ex.test(m[0]))) continue;
          offenders.push(`${path} → ${sel} :: ${m[0].trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
  it("例外真的在用（否则登记项是死条目）：dashed .16 至少出现在 .u-empty 与 .agents-empty", () => {
    const empty = rules(uiCss).find((r) => r.sel === ".u-empty");
    expect(empty?.body).toMatch(/1px dashed rgba\(255, 255, 255, \.16\)/);
    const agentsCss = pageCss.find((c) => c.path === "src/pages/agents/agents.css")!.css;
    const agentsEmpty = rules(agentsCss).find((r) => r.sel === ".agents-empty");
    expect(agentsEmpty?.body).toMatch(/1px dashed rgba\(255, 255, 255, \.16\)/);
  });
  it("阶梯令牌值钉住（全部取自 v1 手写值，别调）", () => {
    expect(tokensCss).toMatch(/--hairline-soft:\s*rgba\(255, 255, 255, \.045\)/);
    expect(tokensCss).toMatch(/--hairline:\s*rgba\(255, 255, 255, \.07\)/);
    expect(tokensCss).toMatch(/--hairline-border:\s*rgba\(255, 255, 255, \.08\)/);
    expect(tokensCss).toMatch(/--hairline-strong:\s*rgba\(255, 255, 255, \.12\)/);
    expect(tokensCss).toMatch(/--hairline-hover:\s*rgba\(255, 255, 255, \.20\)/);
  });
});

// ---------- v2 纪律 7：卡片实心三件套 + 表格密度 + 数字阶梯 + 光效限量 ----------
describe("v2 纪律 7：实心卡三件套落地", () => {
  it(".card = --card-bg + --card-border + --sh-card，无 --glass-*", () => {
    const card = rules(uiCss).find((r) => r.sel === ".card");
    expect(card).toBeDefined();
    expect(card!.body).toMatch(/background:\s*var\(--card-bg\)/);
    expect(card!.body).toMatch(/border:\s*1px solid var\(--card-border\)/);
    expect(card!.body).toMatch(/box-shadow:\s*var\(--sh-card\)/);
    expect(card!.body).not.toMatch(/--glass-/);
  });
  it("三件套令牌：--card-bg 指向实心 --panel，--sh-card 为 none", () => {
    expect(tokensCss).toMatch(/--card-bg:\s*var\(--panel\)/);
    expect(tokensCss).toMatch(/--card-border:\s*var\(--hairline-border\)/);
    expect(tokensCss).toMatch(/--sh-card:\s*none/);
    expect(tokensCss).toMatch(/--panel:\s*#1B2336/);
  });
  it("页面卡片族同配方（agent-detail-block / plan-stage-card / run-cols .col）", () => {
    const want: Array<[string, string]> = [
      ["src/pages/agents/agents.css", ".agent-detail-block"],
      ["src/pages/plan/plan.css", ".plan-stage-card"],
      ["src/pages/run/run.css", ".run-cols .col"],
    ];
    for (const [path, sel] of want) {
      const css = pageCss.find((c) => c.path === path)!.css;
      const r = rules(css).find((x) => x.sel === sel);
      expect(r, `${path} → ${sel}`).toBeDefined();
      expect(r!.body, `${path} → ${sel}`).toMatch(/background:\s*var\(--card-bg\)/);
      expect(r!.body, `${path} → ${sel}`).not.toMatch(/--glass-|backdrop-filter/);
    }
  });
});

describe("v2 纪律 7：表格密度令牌不动（密度是观测台的命）", () => {
  it("--h-row 34 / --h-row-head 30 / --pad-cell-x 12 / --fs-sm 12.5", () => {
    expect(tokensCss).toMatch(/--h-row:\s*34px/);
    expect(tokensCss).toMatch(/--h-row-head:\s*30px/);
    expect(tokensCss).toMatch(/--pad-cell-x:\s*12px/);
    expect(tokensCss).toMatch(/--fs-sm:\s*12\.5px/);
    expect(tokensCss).toMatch(/--lh-body:\s*1\.55/);
  });
});

describe("v2 纪律 7：数字阶梯 48 / 24 / 18，--fs-display 只落在 hero", () => {
  it("令牌值钉住", () => {
    expect(tokensCss).toMatch(/--fs-display:\s*48px/);
    expect(tokensCss).toMatch(/--fs-metric:\s*24px/);
    expect(tokensCss).toMatch(/--fs-metric-sm:\s*18px/);
  });
  // 一页一个视觉锚点：评估计划页 hero（ui.css .kpi-hero-num）与 Agent 首页 fleet hero
  // （agents.css .kpi-hero .kpi-v）。CHANGES.md 写「出现次数 == 1」是按 06b8041 的树数的，
  // fleet hero（fe-home-nav 批）在其后落地 —— 两个都是 hero，别的选择器一律不许拿。
  const DISPLAY_ANCHORS = new Set([".kpi-hero-num", ".kpi-hero .kpi-v"]);
  it("var(--fs-display) 的消费者 == 两个 hero 锚点，不多不少", () => {
    const users: string[] = [];
    for (const { path, css } of allCss) {
      if (path.endsWith("tokens.css")) continue;
      for (const { sel, body } of rules(css)) {
        if (/var\(--fs-display\)/.test(body)) users.push(sel);
      }
    }
    expect(new Set(users)).toEqual(DISPLAY_ANCHORS);
    expect(users.length).toBe(DISPLAY_ANCHORS.size);
  });
  it("hero 数字配 --lh-display / --ls-display（不再手写 1 / -.02em）", () => {
    const hero = rules(uiCss).find((r) => r.sel === ".kpi-hero-num");
    expect(hero?.body).toMatch(/line-height:\s*var\(--lh-display\)/);
    expect(hero?.body).toMatch(/letter-spacing:\s*var\(--ls-display\)/);
  });
});

describe("v2 纪律 7：光效限量（hero 顶缘绿线唯一，--glow ≤ 3 处）", () => {
  const count = (re: RegExp) => {
    let n = 0;
    for (const { path, css } of allCss) {
      if (path.endsWith("tokens.css")) continue;
      for (const { body } of rules(css)) n += (body.match(re) ?? []).length;
    }
    return n;
  };
  it("var(--glow-line) 只出现 1 次，且在 .kpi-strip::after", () => {
    expect(count(/var\(--glow-line\)/g)).toBe(1);
    const after = rules(uiCss).find((r) => r.sel === ".kpi-strip::after");
    expect(after?.body).toMatch(/background:\s*var\(--glow-line\)/);
  });
  it("var(--glow) 出现 ≤ 3 次（hero 指标 / 品牌标 / 主 CTA）", () => {
    const n = count(/var\(--glow\)/g);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(3);
  });
});
