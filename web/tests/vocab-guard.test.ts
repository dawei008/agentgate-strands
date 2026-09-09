// 词汇纪律护栏（domain-r1 D-8 拍板：「均分」「目标」进 CI）。
// 权威 = 根 `CONTEXT.md`「度量口径」一节；本文件只是那节文字的机器形式。
//
// 为什么需要 CI：玻璃形态有 glass-guard 看守，词汇没有。而词汇债已经直接变成
// 用户困惑（UI-013 / D-1：同屏三个「均分」量纲不同、「目标」既指 0.70 阈值又指
// 被测 Agent）。限定词靠人记 → 每个新页面都可能再引入一个裸词。
//
// 三条纪律：
//   1) 「均分」不得裸用 —— 必须带限定词（CONTEXT.md「线上评估均分」词条：
//      「『均分』不得单独出现 …… 一律带限定词」）；
//   2) 「总分」「综合分」禁用（CONTEXT.md「分数（score）」词条 _Avoid_：
//      这两个词会被读成「把三类环节合成一个数」，本产品绝不合成，ADR-0003
//      Amendment 硬线）；
//   3) 「目标」在**两个歧义语境**里必须写全 ——「目标线」（阈值 0.70）或
//      「被测 Agent」（红队用例集 target_agent）。CONTEXT.md「目标线」词条
//      _不指_：「文案里不得简写成『目标』」。
//
// 射程与手法：
//   · 只扫 `web/src/**/*.{ts,tsx}` 的**渲染文本**（字符串字面量 / 模板串 /
//     JSX 文本节点）。**注释一律不扫** —— 注释里引用旧词是合法引述（住所注释、
//     事故复盘、CONTEXT.md 摘抄都必须能写出裸词），把注释一起判死会逼人删掉
//     解释性文字，纪律反而更弱。手法照 glass-guard：不上 AST，扫源码原文，
//     先把注释按字符置空（保留换行 → 行号不漂）。
//   · 豁免照 glass-guard 的白名单制（`MEAN_QUALIFIERS` = 合法限定词表、`DEBTS`
//     = 已确认但归别批的违规登记）+ 行内注释标记 `vocab-guard-allow: <理由>`。
//     **每条豁免都要写理由**，且豁免受审：失效（已被修好）的登记会让最后一个
//     describe 变红，逼人删条目 —— 表只能变短，不许变成永久免罪符。
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * 把注释按字符置空（`//`、`/* *\/`、JSX 的 `{/* *\/}`），保留换行与长度 ——
 * 行号与列号都不漂，报错能直接点到源码位置。
 *
 * 手写小状态机而不是正则：字符串里的 `//`（URL）与正则字面量里的 `/` 都不能被
 * 当成注释开头，纯正则做不到这件事。
 */
export function blankComments(src: string): string {
  let out = "";
  let state: "code" | "sq" | "dq" | "tpl" | "re" | "line" | "block" = "code";
  let i = 0;
  /** 最近 8 个非空白字符（判 `/` 是除号还是正则字面量开头用） */
  let tail = "";
  /** 正则字面量里的字符类 `[...]`：类内的 `/` 不收口
   *  （exportReport.ts 的文件名清洗正则 `/[/\\:*?"<>|…]+/g` 真踩过：类内那个 `/`
   *  提前收口 → 后面的 `"` 开出一个假字符串 → 半个文件的注释不再被抹） */
  let inClass = false;
  /** `/` 处在「表达式开头」= 正则字面量；处在「值后面」= 除号 */
  // ⚠️ `<` `>` `}` **不能**进这张表，三个都被 JSX 踩过：
  //   · `</div>` 的 `/` 会被当正则开头，一路吃到下一个 `/`（实测把 mocks 的 4 处
  //     裸词吃没，同时放出 6 个注释假阳性）；
  //   · `<Icon name={x} />{label}` 的自闭合 `/` 紧跟在 `}` 后面（Sidebar.tsx:60
  //     实测），错认成正则后把下一行的 `{/*` 注释头吃掉 → 注释假阳性。
  const regexAhead = () =>
    tail === ""
    || /[(,=:[!&|?{;+\-*%~^]$/.test(tail)
    || /(return|typeof|case|=>)$/.test(tail);
  /** 模板串 `${ … }` 子表达式：进入时把当时的花括号深度压栈，深度回到栈顶那个
   *  `}` 就是子表达式的收口 → 回到 tpl。不追踪这层嵌套的话，子表达式里的 `//`
   *  注释会被当成模板串内容放出来（router.tsx:162 实测：ErrorBoundary 的 key
   *  模板串里那行「// 对比页有两个参数…」被纪律 4 判成渲染文本假阳性）。 */
  const tplStack: number[] = [];
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (state === "code") {
      if (c === "/" && d === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && d === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "{") depth += 1;
      else if (c === "}") {
        if (tplStack.length && depth === tplStack[tplStack.length - 1]) {
          tplStack.pop(); state = "tpl"; out += c; i += 1; continue;
        }
        depth -= 1;
      }
      // 正则字面量必须单独识别：`s.replace(/"/g, '""')`（导出 CSV 的引号转义，
      // exportReport.ts 真有）里那个 `"` 会让「字符串状态」错位，之后整个文件的
      // 注释都被当成字符串内容 —— 实测造出 3 个注释假阳性。
      if (c === "/" && regexAhead()) {
        state = "re"; inClass = false; out += c; i += 1; continue;
      }
      if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "`") state = "tpl";
      if (c.trim()) tail = (tail + c).slice(-8);
      out += c; i += 1; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; } else out += " ";
      i += 1; continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " ";
      i += 1; continue;
    }
    // 字符串 / 正则内：转义整对跳过，遇到同种收口符出场
    if (c === "\\") { out += c + (d ?? ""); i += 2; continue; }
    // 模板串里的 `${` → 进子表达式（code 态），`{` 已被消费，不计深度
    if (state === "tpl" && c === "$" && d === "{") {
      tplStack.push(depth); state = "code"; tail = (tail + "{").slice(-8);
      out += c + d; i += 2; continue;
    }
    if (state === "re" && c === "[") inClass = true;
    else if (state === "re" && c === "]") inClass = false;
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"')
        || (state === "tpl" && c === "`") || (state === "re" && c === "/" && !inClass)) {
      state = "code"; tail = (tail + c).slice(-8);
    }
    out += c; i += 1; continue;
  }
  return out;
}

/**
 * 把 JSX 标签按字符置空（同样保留长度与换行）。渲染出来的文本是**相邻节点拼接**
 * 的结果：`<b>线上评估</b>均分` 用户读到的是「线上评估均分」，
 * `<th>目标 <span>Agent</span></th>` 读到的是「目标 Agent」——不置空标签，
 * 限定词判定会两头都判错（合法的被判违规、违规的被漏掉）。
 *
 * 只吃「像标签」的片段（`<` 紧跟字母或 `/`，内部不跨行、不含 `<>`），所以
 * `a < b` 这类比较最多吃掉同一行里的一段代码，绝不会跨行吞掉真文案。
 */
export function blankTags(src: string): string {
  return src.replace(/<[A-Za-z/!][^<>\n]*>/g, (m) => " ".repeat(m.length));
}

interface Hit {
  /** `src/pages/...` 相对路径 */
  path: string;
  line: number;
  /** 命中词 */
  word: string;
  /** 该行去注释后的原文（trim），供人肉判断 */
  text: string;
}

interface Scanned {
  path: string;
  /** 渲染视图：注释与 JSX 标签都置空，长度/行号与源码一致 */
  view: string;
  /** 只去注释（保留标签）的视图，报错时给人看的原文 */
  display: string;
  /** 源码原文（行内豁免标记只在原文里找） */
  raw: string;
}

const FILES: Scanned[] = walk(SRC).sort().map((f) => {
  const raw = readFileSync(f, "utf8");
  const display = blankComments(raw);
  return { path: relative(process.cwd(), f), view: blankTags(display), display, raw };
});

const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;
const textOf = (src: string, idx: number) =>
  ((src.slice(0, idx).split("\n").pop() ?? "") + (src.slice(idx).split("\n")[0] ?? "")).trim();

/** 行内豁免标记：`// vocab-guard-allow: <理由>`（理由不可省，空理由不算豁免） */
const INLINE_MARK = /vocab-guard-allow:\s*\S/;
function inlineAllowed(raw: string, line: number): boolean {
  const lines = raw.split("\n");
  // 本行或上一行（多行 JSX 属性/长文案折行时标记只能写在上一行）。
  // ⚠️ 半径 2 行 = 一个标记会连带豁免紧邻的下一行，写标记时别顺手把邻行也放了。
  return INLINE_MARK.test(lines[line - 1] ?? "") || INLINE_MARK.test(lines[line - 2] ?? "");
}

/** 扫描器：对每个 `word` 出现处调用 judge，judge 返回 true = 违规。
 *  `on` 选扫哪份视图：`view`（标签置空，纪律 1–3 的相邻文本拼接判定要用）或
 *  `display`（标签保留 —— 纪律 4 要抓 `title=` / `placeholder=` 这类属性值里的旧词，
 *  单行标签整段被 blankTags 抹掉就漏了）。 */
function scan(
  word: string,
  judge: (view: string, idx: number) => boolean,
  on: "view" | "display" = "view",
): Hit[] {
  const hits: Hit[] = [];
  for (const file of FILES) {
    const { path, display, raw } = file;
    const view = file[on];
    let from = 0;
    for (;;) {
      const idx = view.indexOf(word, from);
      if (idx < 0) break;
      from = idx + word.length;
      if (!judge(view, idx)) continue;
      const line = lineOf(view, idx);
      if (inlineAllowed(raw, line)) continue;
      hits.push({ path, line, word, text: textOf(display, idx) });
    }
  }
  return hits;
}

const fmt = (h: Hit) => `${h.path}:${h.line} 「${h.word}」 → ${h.text}`;

// ---------------------------------------------------------------------------
// 纪律 1：「均分」必须带限定词
// ---------------------------------------------------------------------------
//
// 白名单形态（每条注明 CONTEXT.md 词条出处）：
const MEAN_QUALIFIERS = [
  // CONTEXT.md「线上评估均分」词条正文明列的两个限定词
  "线上评估均分",
  "本环节均分",
  // 同词条要求「一律带限定词」；这两个具体形态的实体依据：
  //  · 「评估器均分」= 逐评估器表头，对应「分数（score）」词条 _不指_ 的
  //    「评估器单项分」这一层（住所 web/src/pages/plan/ReportDrawer.tsx 的
  //    逐评估器表 / exportReport.ts 的同名表头）
  "评估器均分",
  //  · 「本会话均分」= observe 单条会话的分数均值这一层（住所
  //    web/src/pages/plan/observeSessions.ts 的 `meanOf` / 实时会话清单）
  "本会话均分",
];

/** 白名单形态去掉尾巴「均分」= 必须紧贴在「均分」前面的限定词 */
const MEAN_PREFIXES = MEAN_QUALIFIERS.map((q) => q.replace(/均分$/, ""));

/** 限定词判定：往前看 24 字符，剔除粘连字符（引号/反引号/加号/空白）后 endsWith。
 *  剔除粘连字符是为了让「跨字符串拼接」的合法形态（`"…线上评估" + "均分…"`、
 *  折行的长句）也能过 —— 这类拼接在本仓的长文案里很常见。 */
function meanQualified(blanked: string, idx: number): boolean {
  const before = blanked.slice(Math.max(0, idx - 24), idx).replace(/[\s"'`+]/g, "");
  return MEAN_PREFIXES.some((p) => before.endsWith(p));
}

/** 裸「均分」命中（模块级算一次，债项棘轮也要用同一份） */
const MEAN_HITS = scan("均分", (v, i) => !meanQualified(v, i));

describe("词汇纪律 1：「均分」不得单独出现（CONTEXT.md「线上评估均分」词条）", () => {
  it("渲染文本里的每个「均分」都带白名单限定词", () => {
    expect(MEAN_HITS.filter((h) => !debtOf(h)).map(fmt)).toEqual([]);
  });

  it("守卫自身有效：往文本里塞一个裸「均分」会被判违规", () => {
    const fake = 'const t = "本次均分 0.88";';
    const b = blankComments(fake);
    expect(meanQualified(b, b.indexOf("均分"))).toBe(false);
    const ok = blankComments('const t = "线上评估均分 0.88";');
    expect(meanQualified(ok, ok.indexOf("均分"))).toBe(true);
  });

  it("注释不入射程：注释里的裸「均分」是合法引述", () => {
    const b = blankComments('// 前端绝不能把 null 当 0 参与均分\nconst n = 1;');
    expect(b).not.toContain("均分");
  });
});

// ---------------------------------------------------------------------------
// 纪律 2：「总分」「综合分」禁用
// ---------------------------------------------------------------------------
const SYNTHESIS_HITS = [...scan("总分", () => true), ...scan("综合分", () => true)];

describe("词汇纪律 2：「总分」「综合分」禁用（CONTEXT.md「分数（score）」_Avoid_）", () => {
  it("渲染文本里零出现", () => {
    expect(SYNTHESIS_HITS.filter((h) => !debtOf(h)).map(fmt)).toEqual([]);
  });

  it("守卫自身有效：塞一个「总分」文案会被判违规", () => {
    const b = blankComments('const t = "运行完成 · 总分 0.88";');
    expect(b).toContain("总分");
  });
});

// ---------------------------------------------------------------------------
// 纪律 3：「目标」的两个歧义语境必须写全
// ---------------------------------------------------------------------------
//
// ⚠️ 刻意**不**禁全部「目标」：它是常用汉语词（「任务目标」「评估目标」
// 「攻击目标」「用户目标」都与本纪律无关），全禁只会把噪声堆到信号上。守卫只管
// CONTEXT.md 点名的两个歧义语境：
const TARGET_CONTEXTS: Array<{ re: RegExp; why: string }> = [
  // 阈值语境 → 必须写「目标线」（CONTEXT.md「目标线」词条）
  { re: /目标(?!线)\s*[≥≤<>=]*\s*[0-9]/, why: "阈值语境（目标 0.70）须写「目标线」" },
  { re: /目标(?!线)\s*\$\{/, why: "阈值/对象语境（目标 ${阈值常量}）须写全" },
  { re: /(跌破|低于|高于|达到|超过|未达|不足)目标(?!线)/, why: "阈值语境（跌破/低于目标）须写「目标线」" },
  { re: /目标(?!线)\s*(阈值|分数|分值)/, why: "阈值语境须写「目标线」" },
  // 被测对象语境 → 必须写「被测 Agent」（同词条 _不指_）
  { re: /目标\s*(Agent|agent|智能体)/, why: "被测对象语境须写「被测 Agent」" },
  { re: /目标(?!线)(不一致|一致)/, why: "被测对象语境须写「被测 Agent」" },
];

/** 语境窗口：往后开得大方（96 字符），因为**只有空白能桥接** ——
 *  标签被 blankTags 换成了等长空格，「目标 <span>≥ 0.70</span>」那种被元素切开的
 *  同一句话正好靠空白桥接命中；中间只要有任何真字符，`\s*` 就断掉，不会跨句误伤。 */
function targetViolation(view: string, idx: number): string | null {
  const around = view.slice(Math.max(0, idx - 8), idx + 96);
  for (const { re, why } of TARGET_CONTEXTS) if (re.test(around)) return why;
  return null;
}

const TARGET_HITS = scan("目标", (v, i) => targetViolation(v, i) != null);

describe("词汇纪律 3：「目标」在阈值/被测对象语境必须写全（CONTEXT.md「目标线」词条）", () => {
  it("渲染文本里没有歧义语境的裸「目标」", () => {
    expect(TARGET_HITS.filter((h) => !debtOf(h)).map(fmt)).toEqual([]);
  });

  it("守卫自身有效：阈值与被测对象两个语境都判违规，普通汉语用法放行", () => {
    const bad = ['目标 0.70', '目标 ≥ 0.70', '跌破目标 0.70', '目标 Agent', 'Agent 与目标不一致'];
    for (const s of bad) {
      const b = blankComments(`const t = "${s}";`);
      expect(targetViolation(b, b.indexOf("目标")), s).not.toBeNull();
    }
    const ok = ['目标线 0.70', '跌破目标线', '被测 Agent 不可达', '直到达成任务目标或用完轮次',
                '评估目标必填', '把攻击目标藏进问答题里', '描述要模拟的任务场景（用户目标）'];
    for (const s of ok) {
      const b = blankComments(`const t = "${s}";`);
      const i = b.indexOf("目标");
      if (i < 0) continue;
      expect(targetViolation(b, i), s).toBeNull();
    }
  });

  it("JSX 标签被切开的文案也算一句：`<th>目标 <span>Agent</span>` 判违规", () => {
    const v = blankTags(blankComments('<th>目标 <span className="lat">Agent</span></th>'));
    expect(targetViolation(v, v.indexOf("目标"))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 债项登记（= 白名单豁免的一种，受审 + 棘轮）
// ---------------------------------------------------------------------------
//
// 这张表登记的是**已确认的违规**，但改动落在别的批次 owns 的文件里
// （vocab-guard 批只改自己 owns 的那几处，不越界动别人在飞的文件）。
// 登记而不是静默放行，图三件事：
//   · 违规被机器点名过一次并留档，不再「靠人记」；
//   · 棘轮 —— 每条登记出现次数，只能变少不能变多（新引入的同类违规立刻红，
//     搭不了债项的便车）；
//   · 受审 —— 债项被修好后条目失效（命中数 0），最后一个 describe 变红，
//     逼人删条目，表不会变成永久免罪符。
// **不写行号**：行号会漂（别的批次在上方加几行不该让本表失效），按文本片段现查。
interface Debt {
  /** 相对 cwd 的路径 */
  path: string;
  /** 违规行里的文本片段（唯一定位用） */
  frag: string;
  /** 登记时的命中数（棘轮上限） */
  max: number;
  /** 谁的 owns + 应该改成什么（必写，空理由过不了审） */
  owner: string;
}

const DEBTS: Debt[] = [
  // ---- mock 文案（修 mock 归 mock 批；mock 与真后端同刑，所以登记而不排除目录）
  {
    path: "src/mocks/handlers.ts", frag: "评估 2 个会话，均分", max: 2,
    owner: "mock 批：observe 环节摘要行，应写「本环节均分」（这条 mock 对应真后端"
      + " stage_summaries 的环节级 overall_mean）",
  },
  {
    path: "src/mocks/handlers.ts", frag: "correctness 均分", max: 1,
    owner: "mock 批：逐评估器叙述，应写「评估器均分」（评估器名 + 裸词仍是裸词）",
  },
  {
    path: "src/mocks/handlers.ts", frag: "不计入均分与通过率", max: 1,
    owner: "mock 批：空响应用例说明，应写「不计入本环节均分与通过率」"
      + "（同族真实现已改好：web/src/pages/plan/derive.ts 的空响应说明行）",
  },
  // ---- 「综合分」（CONTEXT.md 分数词条 _Avoid_）
  {
    path: "src/pages/run/RunDetailPage.tsx", frag: "综合分", max: 1,
    owner: "run 详情页（非本批 owns）：该格标签应改「线上评估均分」—— 它读的就是"
      + "顶层 score = 各 observe 环节 overall_mean 的均值",
  },
  // ---- 「目标」阈值语境（应写「目标线」）
  {
    path: "src/pages/bigscreen/derive.ts", frag: "低于目标", max: 1,
    owner: "bigscreen Agent 卡标签：应改「低于目标线」。本批在该文件的 owns 只含"
      + "事件标题那一行（协调人 2026-08-25 划的界），故登记不改",
  },
  {
    path: "src/pages/plan/TrendCard.tsx", frag: "目标 ${TREND_TARGET}", max: 2,
    owner: "趋势图两条折线的目标线尾标注：应改「目标线 0.7」；TrendCard 非本批 owns",
  },
  {
    path: "src/pages/plan/TrendCard.tsx", frag: "跌破目标", max: 1,
    owner: "趋势图统计行标签：应改「跌破目标线」；TrendCard 非本批 owns",
  },
  // ---- 「目标 Agent」→「被测 Agent」（CONTEXT.md「目标线」词条 _不指_）
  // 这是一整族全站改名（11 处 / 7 个文件），归独立批；本批只登记 + 棘轮封顶，
  // 保证不会一边清残留一边又长出新的。
  // prose-sweep 2026-09-03：AutoconfArea / AutoconfFailed / ProbeResult 三条登记的
  // 载体文案（探测中括号、排障清单）已随「无废话」清理整句删除 ⇒ 命中归零，按棘轮
  // 要求删条目（不是改名批修好的，是句子没了）。
  {
    path: "src/pages/plan/PlanEditor.tsx", frag: "目标 Agent", max: 1,
    owner: "同上（改名批）：方案编辑器表单标签",
  },
  {
    path: "src/pages/resources/GenCasesForm.tsx", frag: "目标 Agent", max: 2,
    owner: "同上（改名批）：生成表单的可选增强 Agent 标签 + 结果提示",
  },
  {
    path: "src/pages/resources/RedteamGenerator.tsx", frag: "目标 Agent", max: 2,
    owner: "同上（改名批）：红队生成器下拉标签 + 校验错误文案",
  },
  // prose-sweep 2026-09-03：DatasetsBlock「与目标不一致」那条脚注整句删除 ⇒ 登记随之删
  {
    path: "src/pages/resources/DatasetsBlock.tsx", frag: "<th>目标", max: 1,
    owner: "同上（改名批）：红队用例表头「目标 Agent」（跨 JSX 元素拼出来的）",
  },
];

function debtOf(h: Hit): Debt | undefined {
  return DEBTS.find((d) => d.path === h.path && h.text.includes(d.frag));
}

const ALL_HITS = [...MEAN_HITS, ...SYNTHESIS_HITS, ...TARGET_HITS];

describe("豁免受审：债项表只能变短", () => {
  it("每条债项仍有命中，且命中数不超过登记值（棘轮）", () => {
    const problems: string[] = [];
    for (const d of DEBTS) {
      const n = ALL_HITS.filter((h) => debtOf(h) === d).length;
      if (n === 0) {
        problems.push(`${d.path}「${d.frag}」已无命中 → 债项已被修好，请删除本条登记`);
      } else if (n > d.max) {
        problems.push(`${d.path}「${d.frag}」命中 ${n} 处 > 登记 ${d.max} 处 →`
          + " 新增了同类违规，不许搭债项的便车");
      }
    }
    expect(problems).toEqual([]);
  });

  it("每条债项都写了 owner 与去向", () => {
    for (const d of DEBTS) expect(d.owner.length, `${d.path}「${d.frag}」`).toBeGreaterThan(10);
  });

  it("债项总量封顶（2026-08-25 登记 20 处；只允许往下走）", () => {
    expect(DEBTS.reduce((n, d) => n + d.max, 0)).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// 纪律 4：改名旧词禁止 ——「方案」「工作台」「资源库」「对比页」
// ---------------------------------------------------------------------------
//
// 2026-08-29 用户改版：工作台→评估计划、对比→评估分析、资源库→评估器+数据集，
// `CLAUDE.md` 术语七词不可变。前三条纪律都管「量纲词」，改名旧词根本不在射程，
// 所以旧词在没被重写的页面里一直活着（issue
// .scratch/triage-r1/issues/vocab-guard-misses-renamed-terms.md：v0.31.0 Agent
// 详情页截图仍有 6 处、v0.32.0 发布探针又找出 WorkbenchPage / RunConfirmCard /
// BigscreenPage / ComparePage / mocks 共 8 处）。这一条把「旧词禁止」做成机器纪律。
//
// 射程：`web/src/**/*.{ts,tsx}` 的渲染文本 —— 字串字面量 / 模板串 / JSX 文本 /
// 标签属性值（`title=` `placeholder=` `aria-label=`），`.ts` 里的文案常量
// （derive.ts 的 emptyText 族）同样算界面文案。**注释不扫**（注释里引述旧词是
// 合法的：住所注释、改名前后对照、事故复盘）。
// 与纪律 1–3 的一点差别：这里扫**保留标签**的视图（`display`），因为旧词经常
// 藏在单行标签的属性值里（ComparePage 的 placeholder「方案名 / …」实测），而
// blankTags 会把整个单行标签抹掉。
// 「计划」**允许**：它是「评估计划」在窄列/表头里的合法缩写（列名「计划」= 评估计划），
// 不是旧词；本条只禁列出的四个旧词，不碰「计划」。
const RENAMED_TERMS = ["方案", "工作台", "资源库", "对比页"] as const;

/** 旧词命中（模块级算一次，债项棘轮共用） */
const RENAMED_HITS: Hit[] = RENAMED_TERMS.flatMap((w) => scan(w, () => true, "display"));

/**
 * 旧词债项登记（带理由 + 棘轮）。与上面 `DEBTS` 同一套规矩、独立一张表：
 *   · `needle` 是违规行去注释后原文里的片段（不写行号，行号会漂）；
 *   · 登记项必须在当前树上**真命中**（0 命中 ⇒ 红，要求删登记：已清偿的债不许挂着）；
 *   · 命中数不得超过 `max`（新长出来的同类违规不许搭便车）；
 *   · 不许通配放行：needle 必须能定位到具体文案。
 */
interface RenamedDebt {
  file: string;
  needle: string;
  reason: string;
  /** 登记日期 YYYY-MM-DD */
  since: string;
  /** 登记时的命中数（棘轮上限） */
  max: number;
}

// 裁定 .scratch/lead-rulings.md R-2026-09-03-vg4：WorkbenchPage 与 EvaluatorsPage
// 两页正被别的批次改写（白名单互斥），本批只登记不改；合流时由协调人删登记。
const RENAMED_DEBTS: RenamedDebt[] = [
  // ---- WorkbenchPage：9 处登记已于 2026-09-03 随批 plans-board 合流清偿（登记删于合流 commit）
  // ---- EvaluatorsPage：删除确认卡正文
  {
    file: "src/pages/resources/EvaluatorsPage.tsx", needle: "引用它的方案在下次运行时会报缺失", max: 1,
    reason: "批 evaluators-cross-agent 在改此页，合流后删本项", since: "2026-09-03",
  },
];

function renamedDebtOf(h: Hit): RenamedDebt | undefined {
  return RENAMED_DEBTS.find((d) => d.file === h.path && h.text.includes(d.needle));
}

describe("词汇纪律 4：改名旧词禁止（方案 / 工作台 / 资源库 / 对比页）", () => {
  it("渲染文本里零出现（登记在 RENAMED_DEBTS 里的除外）", () => {
    expect(RENAMED_HITS.filter((h) => !renamedDebtOf(h)).map(fmt)).toEqual([]);
  });

  it("阳性对照：喂给同一份视图一段含「方案」的源码，必须红（JSX 文本 + title 属性各一）", () => {
    // 与 RENAMED_HITS 同一条路径：blankComments 后**不**抹标签
    const fake = 'const t = <button title="运行方案">确定运行方案「{name}」</button>;';
    const display = blankComments(fake);
    const first = display.indexOf("方案");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(display.indexOf("方案", first + 2)).toBeGreaterThanOrEqual(0);
    // 用 blankTags 视图会把 title 属性那处吃掉 —— 这正是纪律 4 改扫 display 的原因
    const tagless = blankTags(display);
    expect(tagless.indexOf("方案", tagless.indexOf("方案") + 2)).toBe(-1);
    for (const w of ["工作台", "资源库", "对比页"]) {
      const v = blankComments(`const s = \`回到${w}\`;`);
      expect(v, w).toContain(w);
    }
  });

  it("阴性对照：注释里的「方案」不入射程", () => {
    const fake = [
      "// 方案详情环节行 / 报告抽屉共用同一句话",
      "/* 工作台→评估计划、资源库→评估器+数据集 */",
      "const x = 1; {/* 对比页 */}",
      'const t = "评估计划";',
    ].join("\n");
    const view = blankComments(fake);
    for (const w of RENAMED_TERMS) expect(view, w).not.toContain(w);
    expect(view).toContain("评估计划");
  });

  it("阴性对照：模板串 `${ … }` 子表达式里的行注释也是注释（router.tsx:162 实测假阳性）", () => {
    const fake = [
      "const k = `${route.view}:${",
      '  "id" in route ? route.id',
      "    // 对比页有两个参数：只拿其中一个当 key",
      '    : "aKey" in route ? `${route.aKey}|${route.bKey}`',
      '    : ""}`;',
      'const after = "评估计划";  // 方案',
    ].join("\n");
    const view = blankComments(fake);
    expect(view).not.toContain("对比页");
    expect(view).not.toContain("方案");
    // 子表达式收口后模板串照常收口，后面的代码不会被吞进模板串
    expect(view).toContain('const after = "评估计划";');
    // 子表达式里嵌套的对象字面量 / 嵌套模板串不会提前收口
    const nested = "const s = `a ${ x ? { y: `${z}` }.y : 0 } b`; // 资源库";
    expect(blankComments(nested)).not.toContain("资源库");
  });

  it("「计划」作为「评估计划」的列名缩写不在禁词表里", () => {
    expect(RENAMED_TERMS as readonly string[]).not.toContain("计划");
    expect(RENAMED_TERMS as readonly string[]).not.toContain("评估计划");
  });
});

describe("旧词债项受审：登记表只能变短", () => {
  it("每条登记仍有真命中（0 命中 ⇒ 删登记），且命中数不超过登记值", () => {
    const problems: string[] = [];
    for (const d of RENAMED_DEBTS) {
      const n = RENAMED_HITS.filter((h) => renamedDebtOf(h) === d).length;
      if (n === 0) {
        problems.push(`${d.file}「${d.needle}」已无命中 → 债已清偿，请删除本条登记`);
      } else if (n > d.max) {
        problems.push(`${d.file}「${d.needle}」命中 ${n} 处 > 登记 ${d.max} 处 → 新增了同类违规`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("每条登记都带理由与日期，且 needle 不是通配", () => {
    for (const d of RENAMED_DEBTS) {
      expect(d.reason.length, `${d.file}「${d.needle}」`).toBeGreaterThan(6);
      expect(d.since, `${d.file}「${d.needle}」`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d.needle.length, `${d.file}「${d.needle}」`).toBeGreaterThanOrEqual(2);
    }
  });
});

