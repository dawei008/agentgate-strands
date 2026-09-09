// 分块表单 → rubric 文本的拼接规则（唯一实现，页面与测试共用）。
import type { EvaluatorBlocks } from "./types";

/** 适用环节 payload 值 → 中文标签。用户裁定（2026-08-31）：「两者皆可」这类
 *  间接说法废除，直接列适用的环节类型名（术语表七词）；红队测试自带 judge、
 *  不用这些评估器，永远不出现在这一列 —— 缺席即答案，不加说明文字。 */
export const SCOPE_LABELS: Record<string, string> = {
  all: "线上评估 · 回归测试",
  observe: "线上评估",
  dataset: "回归测试",
};

export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

/** 内置评估器的 scopes 数组（["observe","dataset"] | ["dataset"]）→ 中文标签 */
export function scopesToLabel(scopes: string[] | undefined): string {
  if (!scopes || scopes.length === 0) return "—";
  const hasObserve = scopes.includes("observe");
  const hasDataset = scopes.includes("dataset");
  if (hasObserve && hasDataset) return "线上评估 · 回归测试";
  if (hasObserve) return "线上评估";
  return "回归测试";
}

/** 后端 blocks.bands 字段名兜底：产品用 criteria，旧 mock 数据用 desc */
export function bandCriteria(band: { criteria?: string; desc?: string }): string {
  return band.criteria ?? band.desc ?? "";
}

/**
 * 拼 prompt 规则（任务书定案）：
 *   {goal}\n【关注点】\n1. {check}\n...\n【评分标准】\n{score} = {criteria}（按分值降序）
 * 空行分节；关注点为空时省略该节。
 */
export function buildRubric(blocks: EvaluatorBlocks): string {
  const parts: string[] = [];
  const goal = blocks.goal.trim();
  if (goal) parts.push(goal);
  const checks = blocks.checks.map((c) => c.trim()).filter(Boolean);
  if (checks.length > 0) {
    parts.push("【关注点】\n" + checks.map((c, i) => `${i + 1}. ${c}`).join("\n"));
  }
  const bands = blocks.bands
    .filter((b) => bandCriteria(b).trim() !== "")
    .slice()
    .sort((a, b) => b.score - a.score);
  if (bands.length > 0) {
    parts.push(
      "【评分标准】\n" + bands.map((b) => `${fmtScore(b.score)} = ${bandCriteria(b).trim()}`).join("\n"),
    );
  }
  return parts.join("\n");
}

const CHECKS_HEAD = "【关注点】";
const BANDS_HEAD = "【评分标准】";
/** `N. 文本` 的序号（buildRubric 产出用 `. `；手写的老 rubric 也见过 `、` 和 `)`） */
const CHECK_LINE = /^\d+\s*[.、)]\s*(.*)$/;
/** 档位行可选的标签前缀：`Score 1.0：三条全中。` —— 现网 policy_compliance 的真实形态
 *  （用户 2026-08-29 报的就是它）。**只认 `Score` 这一个词**（大小写不论）：放开成
 *  「分数 / 得分 / 分值」之类，`分数 0.5 以下算不合格` 这种散文行会被剥成一个 0.5 档，
 *  把说明文字当判定条件填进评分标准表。 */
const BAND_LABEL = /^score\s*[:：]?\s*/i;
/** 行首分值 + 分隔符（` = ` / `：` / `:` / 空白）。分值必须落在 0–1：否则
 *  「2024 年起…」这类散文行会被当档位。
 *  ⚠️ `：` 带来一处已知歧义：用冒号编号的 `1：政策结论正确` 会被认成 1.0 档而不是
 *  关注点（CHECK_LINE 只认 `.、)`）。两种误判里这个方向更轻 —— 档位进了评分标准表
 *  是看得见、改得动的；反过来认不出档位就是 null ⇒ 空白表单，正是本次的缺陷形态。 */
const LOOSE_BAND = /^(\d+(?:\.\d+)?)(?:\s*[=：:]\s*|\s+)(.*)$/;
/** 行首有空白 = 上一块的续行（原文折行或缩进的子条目），不是新块也不是垃圾。
 *  全角空格也算：中文 rubric 里缩进用它的不少。 */
const CONT_LINE = /^[ \t　]/;

type ParsedBand = { score: number; criteria: string };

/**
 * 续行拼接：**只动排版不动字**。
 * 中日韩之间直接相接（原文那个换行本来就只是折行）；接缝任一侧是 ASCII 单词字符或
 * 成对标点时补一个空格 —— 英文 rubric 直接相接会把两个词粘成一个（`must` + `return`
 * ⇒ `mustreturn`），那是改字不是改排版。
 */
function joinCont(head: string, tail: string): string {
  if (head === "") return tail;
  if (tail === "") return head;
  const glue = /[A-Za-z0-9)\]}.,;:!?'"]$/.test(head) || /^[A-Za-z0-9([{]/.test(tail) ? " " : "";
  return head + glue + tail;
}

/**
 * 多行散文压成单行：分块表单的三个字段都是单行 `<input>`，值里带 `\n` 时 DOM 会把
 * 换行**显示成没有**，而 state 里还留着 —— 用户一敲键盘，被 sanitize 过的值回流进
 * state，那些换行连带看不见的差异一起消失。所见即所存比多留几个换行重要。
 * 空行按段落边界处理（补一个空格），段内按 joinCont 拼。
 */
function foldToLine(lines: string[]): string {
  let out = "";
  let gap = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (t === "") { if (out !== "") gap = true; continue; }
    out = out === "" ? t : gap ? `${out} ${t}` : joinCont(out, t);
    gap = false;
  }
  return out;
}

/** 松散形态的档位行（也给结构形态当兜底：小节里混进没有 ` = ` 的旧行） */
function looseBand(line: string): ParsedBand | null {
  const m = LOOSE_BAND.exec(line.replace(BAND_LABEL, ""));
  if (!m) return null;
  const score = Number(m[1]);
  if (!Number.isFinite(score) || score < 0 || score > 1) return null;
  const criteria = m[2].trim();
  // 光一个分值不算档位：判定条件为空时 buildRubric 也不会产出这一行
  return criteria ? { score, criteria } : null;
}

/** 结构形态的档位行：按**第一个** ` = ` 切（判定条件本身可能还含 ` = `） */
function structuredBand(line: string): ParsedBand | null {
  const at = line.indexOf(" = ");
  if (at >= 0) {
    const left = line.slice(0, at).trim();
    const criteria = line.slice(at + 3).trim();
    const score = Number(left);
    // 分值不限 0–1：越界值原样填回表单交给 validate 报错，比静默吞掉这一档好查
    if (left !== "" && Number.isFinite(score) && criteria !== "") return { score, criteria };
  }
  return looseBand(line);
}

/**
 * buildRubric 的逆：rubric 文本 → 分块；**一个档位都认不出就返回 null**。
 *
 * 为什么需要它：两个模式之间过去不搬运内容 —— 老评估器只有 rubric（blocks=null）
 * 打开即原始文本模式，点「切换到分块模式」得到的是空白表单，用户原文在界面上
 * 没有任何地方显示（用户 2026-08-29 实测 policy_compliance：「切换到分块模式没有内容」）。
 *
 * 认两种形态：
 *   (a) 结构形态 = buildRubric 的产出，有【关注点】/【评分标准】小节标题；
 *       对 buildRubric 的任何产出往返无损（tests/evaluator-rubric-parse.test.ts 钉住）——
 *       前提是三段文本都不含换行，而它们来自单行 input，形状上就成立。
 *   (b) 松散形态 = 人手写的老 rubric（无小节标题，靠行首分值认档位）。
 *
 * 失败一律返回 null 而**不是**空 blocks：空 blocks 会让调用方以为拆解成功，
 * 正是本次缺陷「三段全空」的形态。
 *
 * ⚠️ **认出来的行一个都不许丢**（除了纯空行）。分块模式保存写的是
 * `buildRubric(currentBlocks())` —— 拆解时丢掉的行，保存时就从用户的评估器里删掉了。
 * 少半份评分标准比切过去一片空白更坏（后者至少切回原始文本模式还在）。所以：
 *   · 缩进行并进上一块（真实 rubric 里「(a)/(b) 两种情形」「压力清单第二行」都是缩进子句）；
 *   · 已经开始分块之后出现的顶格散文并进评估目标 —— 位置从末尾挪到开头，但那类文字
 *     （「⚠️ 特别注意…」）是对整份 rubric 的全局说明，放开头照样成立。
 * 拆解结果因此**不保证与原文逐字节可复原**；调用方拿 `buildRubric(parsed) === text`
 * 判断这一点，不等时要向用户明说保存会重排原文（EvaluatorForm 的 lossy 提示条）。
 */
export function parseRubric(text: string): EvaluatorBlocks | null {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const isHead = (l: string) => l.trim() === CHECKS_HEAD || l.trim() === BANDS_HEAD;
  const headAt = lines.findIndex(isHead);
  const goalLines: string[] = [];
  const checks: string[] = [];
  const bands: ParsedBand[] = [];

  if (headAt >= 0) {
    // 结构形态：第一个小节标题之前的全部文本 = 评估目标
    goalLines.push(...lines.slice(0, headAt));
    let section: "checks" | "bands" | null = null;
    for (const line of lines.slice(headAt)) {
      const t = line.trim();
      if (t === CHECKS_HEAD) { section = "checks"; continue; }
      if (t === BANDS_HEAD) { section = "bands"; continue; }
      if (t === "") continue;
      if (section === "checks") {
        // 认不出序号的行接到上一条（手写 rubric 里一条关注点常折成两行，各自成条
        // 会把半句话变成一个独立的检查项）；还没有上一条时才原样新起一条
        if (checks.length > 0 && !CHECK_LINE.test(t)) {
          checks[checks.length - 1] = joinCont(checks[checks.length - 1], t);
          continue;
        }
        checks.push((CHECK_LINE.exec(t)?.[1] ?? t).trim());
      } else if (section === "bands") {
        const b = structuredBand(t);
        if (b) { bands.push(b); continue; }
        // 小节标题下的行认不出档位就是上一档的续行：这一节里没有别的东西可当
        if (bands.length > 0) bands[bands.length - 1].criteria = joinCont(bands[bands.length - 1].criteria, t);
      }
    }
  } else {
    // 松散形态：第一个档位行之前的散文 = 目标，`N. 文本` 行 = 关注点，
    // 缩进行 = 上一块的续行，其余顶格散文一律并进目标（见函数头「一个都不许丢」）
    let last: "check" | "band" | null = null;
    for (const line of lines) {
      const t = line.trim();
      if (t === "") { goalLines.push(""); continue; }
      if (CONT_LINE.test(line) && last === "check") {
        checks[checks.length - 1] = joinCont(checks[checks.length - 1], t);
        continue;
      }
      if (CONT_LINE.test(line) && last === "band") {
        bands[bands.length - 1].criteria = joinCont(bands[bands.length - 1].criteria, t);
        continue;
      }
      const b = looseBand(t);
      if (b) { bands.push(b); last = "band"; continue; }
      const c = CHECK_LINE.exec(t);
      if (c) { checks.push(c[1].trim()); last = "check"; continue; }
      goalLines.push(t);
      last = null;
    }
  }

  if (bands.length === 0) return null;
  return { goal: foldToLine(goalLines), checks: checks.filter(Boolean), bands };
}

/** 分值显示：1 → "1.0"，0.5 → "0.5"（一位小数，读起来像评分档） */
export function fmtScore(score: number): string {
  return Number.isInteger(score) ? score.toFixed(1) : String(score);
}

/** 系统自动追加部分（预览展示用；后端 judge 侧保证，不随 rubric 提交） */
export const SYSTEM_APPENDIX =
  "--- 以下由系统自动追加 ---\n" +
  "分数范围固定为 0.0–1.0，允许取中间值。\n" +
  '只输出 JSON，不要输出其他文字：\n{"score": <数字>, "reason": "<60 字内理由>"}';
