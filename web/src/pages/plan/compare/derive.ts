// Run 对比的派生层（纯函数，零请求、零数据模型改动）。
//
// 回答的那**一个**问题：这次改进修好了什么、有没有副作用。
// 三层输出，各有各的口径，互不换算：
//   1. compareMetrics  —— 并排 KPI，**逐量纲各一行**（ADR-0003 硬线，见下）
//   2. compareStages   —— 中部用例三桶（修好的 / 改坏的 / 仍失败）+ 两个说明桶
//   3. UnitPair.a/b    —— 点开一个用例时左右并排的料（回答 + 逐评估器判分理由）
//
// ⚠️ ADR-0003 硬线在对比视图里最容易破：「一眼看出哪次更好」的诱惑就是合成的
// 入口。本文件**绝不**把线上评估均分、回归通过率、红队攻破数换算/相加成一个数
// —— 三者量纲不同（0-1 分 / 百分比 / 绝对计数），每个指标带着自己的 `unit`
// 出场，环比也各说各的单位（分用 ±0.02、通过率用「个百分点」、攻破用「次」）。
// 钉子在 tests/run-compare.test.tsx「ADR-0003 硬线」那条。
//
// 数据全部来自两次 `get_plan_run`：
//   · 摘要指标 → DDB `stage_summaries`（经 derive.reportStages 的三重兜底）
//   · 逐用例明细 → S3 `report.stages[i]`（经 derive.reportStageDetails，
//     它**刻意不读** stage_summaries —— 那一路明细恒为零）
// 老 run 缺 evaluator_stats / 缺 report 明细 / 缺版本快照都是常态：缺哪维不画
// 哪维（各处的 note/missingText 说清是哪一侧缺），绝不报错、绝不用 0 顶替。
import {
  adoptionNoteOf, caseRows, evaluatorRows, observeEvaluatorRows, ppText, reportStageDetails,
  reportStages, runPassRate, runRedteamTally, sortRunsDesc, stageDatasetName,
  type CaseRow, type CaseVerdict,
} from "../derive";
import { STAGE_LABEL, effectiveScore, fmtScoreExact, toMillis } from "../../../lib/scoring";
import { textOf } from "../../../lib/renderText";
import type {
  CaseResult, DatasetLite, ObserveSessionDetail, PlanRunDetail, PlanRunSummary,
  StageDetail, StageSummary,
} from "../types";

// versionSnapshot 住在 plan/derive.ts（报告抽屉头部的版本 chip 读同一个函数）：
// 「只读 run 快照、绝不读 Agent 当前标签」这条护栏只能有一个住所。
export { versionSnapshot } from "../derive";

/** 对比的一侧：run 摘要（运行历史那一行）+ get_plan_run 的完整归档。
 *  摘要可缺（直接从别处深链进来时列表还没到）—— 指标一律先读 detail。 */
export interface CompareSide {
  detail: PlanRunDetail | null | undefined;
  summary: PlanRunSummary | null;
}

/** 对齐判定需要的外部料。
 *  `datasets` 只为读 `updated_at`（判「数据集在两次运行之间改过没有」）——
 *  缺了就**不判**（不出警示横幅），绝不拿别的字段猜。 */
export interface CompareCtx {
  datasets?: DatasetLite[];
}

// ---------------------------------------------------------------------------
// 可对比闸门
// ---------------------------------------------------------------------------

/**
 * 这个 run 能不能当对比对象；null = 能。
 *
 * 两档不能：
 *   running —— 还在跑，报告压根还没落库（get_plan_run 拿不到 report）；
 *   skipped —— 后端 record_skipped_run 只落一条 marker（stage_summaries 是
 *              字符串 "[]"），没有任何可比的东西。
 * 其余（completed / error / stopped / halted_cost）**一律放行**：失败与被停止的
 * run 也可能带 salvage 出来的明细（planrun.py 的 error 分支会把 checkpoint 捞
 * 回来），那是用户已经付过钱的数据，不许因为 badge 是红的就藏起来 —— 真缺什么
 * 由各维度自己降级说明。
 */
export function comparableReason(run: { status?: string } | null | undefined): string | null {
  const st = run?.status ?? "";
  if (st === "running") return "运行中，还没有报告可对比";
  if (st === "skipped") return "这次运行被跳过，没有报告可对比";
  return null;
}

/** run_key 的构造是 `<plan_id>#<秒级时间戳>`（后端 planrun.py `_planrun_item`
 *  的 sk）⇒ 井号后那段比 `started_at` 更细（后者展示到分钟）。只在时刻并列时
 *  当次级键用。没有井号（理论上不该有）→ 整串，反正只求确定性。 */
function keyTail(runKey: string): string {
  const i = runKey.indexOf("#");
  return i >= 0 ? runKey.slice(i + 1) : runKey;
}

/**
 * 两个 run_key → {aKey（较早）, bKey（较新）}；同一个 key / 找不到 → null。
 *
 * 「较早在左」恒定：点选顺序不许影响哪一栏是 A —— 否则同样两次运行会读出两个
 * 相反的结论（「修好了」与「改坏了」互换）。
 *
 * ⚠️ 这里**不用** sortRunsDesc + findIndex（2026-08-26 前的写法）：那一路要求两个
 * key 都在同一个 `runs` 数组里、且该数组就是这一个方案的运行历史。跨方案对比页
 * 的候选池来自 list_recent_runs（多方案混排），下标语义随之失效 —— 老写法在跨
 * 方案对上会稳定返回 null，表现成「选了两个 run 但页面空着」，与「这一对不可比」
 * 同形。改成**直接比时刻**，与数组来自哪里无关。
 *
 * 时刻并列（started_at 只到分钟，同分钟两次运行是可能的）→ 退到 run_key 尾段
 * 的秒级时间戳；再并列 → 整串字典序。**必须有终局**：非确定性的定序等于让同一
 * 对 run 在两次打开时给出相反结论，比排错更坏。
 */
export function orderComparePair(
  runs: Array<{ run_key: string; started_at?: string | number | null }>,
  k1: string, k2: string,
): { aKey: string; bKey: string } | null {
  if (!k1 || !k2 || k1 === k2) return null;
  const r1 = runs.find((r) => r.run_key === k1);
  const r2 = runs.find((r) => r.run_key === k2);
  if (!r1 || !r2) return null;
  const t1 = toMillis(r1.started_at);
  const t2 = toMillis(r2.started_at);
  if (Number.isFinite(t1) && Number.isFinite(t2) && t1 !== t2) {
    return t1 < t2 ? { aKey: k1, bKey: k2 } : { aKey: k2, bKey: k1 };
  }
  const s1 = keyTail(k1);
  const s2 = keyTail(k2);
  const earlierFirst = s1 !== s2 ? s1 < s2 : k1 < k2;
  return earlierFirst ? { aKey: k1, bKey: k2 } : { aKey: k2, bKey: k1 };
}

// ---------------------------------------------------------------------------
// 口径披露（两次运行是不是同一把尺子量的）
// ---------------------------------------------------------------------------

/** 一条口径差异的严重度。四档**不是**颜色深浅，是四种不同的话：
 *    blocking —— 量的不是同一批题/不是同一把尺子，下方涨跌失去意义（红）
 *    diff     —— 口径有差异但仍可读，只是范围要限定（黄）
 *    same     —— **读到了两侧的真值且相同**（绿）—— 这一档是正面结论，
 *                只有真读出来才配用，绝不许由「两侧都读不到」冒充
 *    unknown  —— 平台没记这一项，**判不出来**（中性灰）
 *
 * ⚠️ `unknown` 绝不许并进 `diff`，更绝不许并进 `same`：「两次都没记」与
 * 「两次记的一样」在数据上同形（都读不出差异），但对读者的意思完全相反。 */
export type CalibrationLevel = "blocking" | "diff" | "same" | "unknown";

export interface CalibrationNote {
  /** 稳定 id，也是 testid 后缀 */
  id: "stages" | "window" | "dataset" | "evaluators-observe" | "evaluators" | "judge" | "cache";
  level: CalibrationLevel;
  /** 口径名（「环节构成」/「数据集」/「回归测试 · 评估器」/「判分模型」…）。
   *  逐环节的口径一律带环节限定词 —— 同一项（评估器）在两个环节里是两份名单，
   *  不写环节名就会被读成「整个 run 就这些评估器」。 */
  label: string;
  /** 两侧读到的值；未记录一律写「未记录」，不留空、不写 0、不写「相同」 */
  a: string;
  b: string;
  /** 后果一句话 —— 说的是「这会让下面哪块读数不能信」。**只有 blocking/diff
   *  携带**（消费方也只在这两档渲染）：same 的绿标签、unknown 的「未记录」格子
   *  自己会说话，给它们拼句子是造死数据（2026-08-30 /simplify 清理）。 */
  text: string;
}

const NOT_RECORDED = "未记录";

function joinNames(xs: string[]): string {
  return xs.length ? xs.join("、") : NOT_RECORDED;
}

/**
 * 一侧跑过的数据集名（去重保序）。
 *
 * 唯一可信来源是 S3 报告体，走 derive.stageDatasetName（那条护栏的住所：
 * DDB `_stage_summary` 从不写数据集名，现网 63 份 run 零命中）⇒ **读不到就是
 * 读不到**，不许回落到「方案当前配的数据集」——方案改过之后，那会把一次旧运行
 * 标上它根本没跑过的数据集名，比空着更坏。
 */
export function datasetNames(side: CompareSide): string[] {
  const out: string[] = [];
  for (const st of reportStageDetails(side.detail)) {
    if (st.type !== "dataset") continue;
    const name = stageDatasetName(st);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 这一侧有没有回归环节。
 *
 * ⚠️ 「没有回归环节」与「有回归环节但读不到数据集名」必须分开：前者根本没有数据集
 * 可言（纯线上评估 / 纯红队 run），对它说「没读到数据集名」是凭空造一条警示；后者
 * 才是真的读不出来。两者在 `datasetNames` 的返回值上同形（都是空数组）—— 同形的
 * 两件事必须由第二个读数分开，不能靠同一个空数组猜。
 *
 * 摘要与明细两路都算：明细可能整个缺（老 run / S3 读失败），而摘要还在。
 */
export function hasDatasetStage(side: CompareSide): boolean {
  return hasStageType(side, "dataset");
}

function hasStageType(side: CompareSide, type: string): boolean {
  const stages: StageSummary[] = [
    ...reportStages(side.detail),
    ...reportStageDetails(side.detail),
    ...(side.summary?.stage_summaries ?? []),
  ];
  return stages.some((st) => st.type === type);
}

/**
 * 一侧记下的判分模型（去重保序）。
 *
 * 住所是**回归环节的子 run 记录**：`report.stages[i].report.judge_model`
 * （现网两轮实测都在，值 = `global.anthropic.claude-sonnet-5`）。
 *
 * ⚠️ 边界必须说清：只有 dataset 环节写这个键，线上评估环节的 `report` 是 `{}`
 * （同两轮实测）。所以读到值时能回答的只是「**回归那半**是不是同一把尺子」——
 * 拿它冒充整个 run 就是用一个真读数去掩盖另一半的未知，比空着更坏。
 */
export function judgeModels(side: CompareSide): string[] {
  const out: string[] = [];
  for (const st of reportStageDetails(side.detail)) {
    const m = textOf(st.report?.judge_model).trim();
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * 一侧**某一个环节**配的评估器名（去重保序）。
 *
 * 三个来源都试：摘要的 `evaluators` 数组、`evaluator_stats` 的键（回归那半，
 * 2026-08 additive 字段）、`summary` 的键（线上评估那半，逐评估器统计的住所）。
 * 老 run 三个都没有 ⇒ 空数组 = 未记录。
 *
 * ⚠️ **按环节分开问，绝不合并成一份名单**：这里此前硬写 `if (st.type !== "dataset")
 * continue`，于是现网这两轮真正带着全部信号的三个评估器（`metric_discipline` /
 * `honest_gaps` / `instruction_following` 全在线上评估环节）整个落在口径检查之外
 * —— 界面把「同一把尺子吗」答成「是」，而它其实只核过 `correctness` 那一个。
 * 合并成一份名单同样不行：同名评估器在两个环节里是两个数、两种分母
 * （evaluatorMetrics 的同一条裁定），并成一份就分不出「这一次多了个评估器」
 * 是加在哪个环节上。
 */
export function evaluatorNames(side: CompareSide, type: "observe" | "dataset" = "dataset"): string[] {
  const out: string[] = [];
  const push = (s: string) => { if (s && !out.includes(s)) out.push(s); };
  const stages: StageSummary[] = [
    ...reportStages(side.detail),
    ...reportStageDetails(side.detail),
    ...(side.summary?.stage_summaries ?? []),
  ];
  for (const st of stages) {
    if (st.type !== type) continue;
    for (const n of st.evaluators ?? []) push(textOf(n).trim());
    for (const n of Object.keys(st.evaluator_stats ?? {})) push(n.trim());
    const sum = st.summary;
    if (sum && typeof sum === "object") for (const n of Object.keys(sum)) push(n.trim());
  }
  return out;
}

/**
 * 一侧跑了哪几个环节（照 STAGE_LABEL 的中文名，按 observe→dataset→redteam 定序）。
 *
 * 这是「评估方式是否相同」最外面那一层：两次跑的环节都不一样时，下方任何一个
 * 量纲的「持平/缺席」都得先按这个读 —— 一侧根本没跑红队，与「跑了红队零攻破」
 * 在攻破数那一格上同形（都读不出攻破），而两者的意思相反。
 */
export function stageComposition(side: CompareSide): string[] {
  const order: ("observe" | "dataset" | "redteam")[] = ["observe", "dataset", "redteam"];
  return order.filter((t) => hasStageType(side, t)).map((t) => STAGE_LABEL[t]);
}

/**
 * 一侧记下的缓存模式（去重保序）。住所与 judge_model 完全同形：
 * `report.stages[i].report.cache_mode`（现网两轮实测都是 `off`，只回归环节写）。
 *
 * 为什么它属于口径而不是细节：`reuse` 意味着这一次的判分**直接复用了上一次的
 * 结论**，那么两次之间的「持平」是量具复用出来的，不是 Agent 真没变。
 */
export function cacheModes(side: CompareSide): string[] {
  const out: string[] = [];
  for (const st of reportStageDetails(side.detail)) {
    const m = textOf(st.report?.cache_mode).trim();
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/** 一侧线上评估环节**枚举到**的会话数（多环节相加）；null = 读不到。
 *  ⚠️ 是枚举数（现网 12）不是判定数（现网 9）—— 后者住在
 *  `summary[评估器].sessions`，两个数差着「无内容 / 判分失败」那几条。
 *  这里要的正是枚举数：它回答「这次取样取到了多少」。 */
export function observeSessionCount(side: CompareSide): number | null {
  let n: number | null = null;
  for (const st of mergedStages(side.detail)) {
    if (st.type !== "observe") continue;
    const c = typeof st.sessions === "number" ? st.sessions
      : Array.isArray(st.session_details) ? st.session_details.length : null;
    if (c != null) n = (n ?? 0) + c;
  }
  return n;
}

/**
 * 「这两次是同一把尺子量的吗」——报表在数上面，一条都不许省。
 *
 * 各项的可知程度天差地别，所以各项的话也不同：
 *   环节构成 —— 摘要/明细任一路都读得到 ⇒ 不同就 diff（缺席的那一维没有环比）
 *   抽样窗口 —— **恒未记录**：枚举上限与回看时长（app/discovery.py:217，12 条 /
 *               1 天）是全局配置，不随 run 落库 ⇒ 判不出两次看的是不是同一段时间。
 *               只有枚举到的会话数读得出来，那只是结果不是窗口。
 *   数据集   —— 可从 S3 报告体读到真名 ⇒ 不同就 blocking（用例对齐键失效）
 *   评估器   —— **逐环节各问一次**（线上评估 / 回归测试），新 run 记了名单
 *   判分模型 —— 回归环节的报告体写了 ⇒ 读得出来；线上评估那半不写
 *   缓存模式 —— 同上，且 `reuse` 会让「持平」变成复用出来的假持平
 *
 * 2026-08-29 改（用户原话：「在对比里，是不是报告里先看评估期和评估方式，数据集等
 * 是否相同，再对比别的话」）—— 此前这里的规则是「相同 → 不出条目（横幅只在有话说
 * 时占地方）」，同时判分模型那一条**恒出现**（含 same 档）。一个横幅里两套标准的
 * 后果是：读者看到「口径」只有一条判分模型时，分不出「数据集核过且相同」与
 * 「数据集这一项根本没核」—— 而那正是他要先看的东西。既然「先核口径再看数」是
 * 版面的第一层，核过就得留痕：`same` 也出条目（绿、无后果句，一行即过）。
 *
 * ⚠️ 数据集/回归评估器都以「至少一侧真有回归环节」为前提，线上评估评估器以
 * 「至少一侧真有线上评估环节」为前提：纯线上评估 / 纯红队的两次运行没有数据集，
 * 对它们说「没读到数据集名」是凭空造警示 —— 凭空的警示会把真警示一起贬值。
 */
export function calibrationNotes(a: CompareSide, b: CompareSide): CalibrationNote[] {
  const out: CalibrationNote[] = [];
  const anyDatasetStage = hasDatasetStage(a) || hasDatasetStage(b);
  const anyObserveStage = hasStageType(a, "observe") || hasStageType(b, "observe");

  // ---- 环节构成：「评估方式是否相同」最外面那一层 ----
  const sa = stageComposition(a);
  const sb = stageComposition(b);
  if (sa.length > 0 || sb.length > 0) {
    const sameStages = sa.length === sb.length && sa.every((n) => sb.includes(n));
    out.push(sameStages
      ? {
        id: "stages", level: "same", label: "环节构成",
        a: joinNames(sa), b: joinNames(sb), text: "",
      }
      : {
        id: "stages", level: "diff", label: "环节构成",
        a: joinNames(sa), b: joinNames(sb),
        text: "两次跑的环节不一样",
      });
  }

  // ---- 抽样窗口：恒未记录，但正是「评估期是否相同」那一问 ----
  if (anyObserveStage) {
    const na = observeSessionCount(a);
    const nb = observeSessionCount(b);
    const txt = (n: number | null) => (n == null ? NOT_RECORDED : `枚举到 ${n} 个会话`);
    out.push({
      id: "window", level: "unknown", label: "线上评估抽样",
      a: txt(na), b: txt(nb),
      text: "",
    });
  }

  // ---- 数据集 ----
  const da = datasetNames(a);
  const db = datasetNames(b);
  const sameDs = da.length > 0 && db.length > 0
    && da.length === db.length && da.every((n) => db.includes(n));
  if (!anyDatasetStage) {
    // 两次都没有回归环节 ⇒ 数据集与回归评估器这两条无从谈起，一条都不出
  } else if (sameDs) {
    out.push({
      id: "dataset", level: "same", label: "数据集",
      a: joinNames(da), b: joinNames(db),
      text: "",
    });
  } else if (da.length > 0 && db.length > 0) {
    out.push({
      id: "dataset", level: "blocking", label: "数据集",
      a: joinNames(da), b: joinNames(db),
      text: "两次跑的不是同一批题 —— 下方逐用例三桶失去意义",
    });
  } else {
    out.push({
      id: "dataset", level: "unknown", label: "数据集",
      a: joinNames(da), b: joinNames(db),
      text: "",
    });
  }

  // ---- 评估器：逐环节各一条（同名评估器在两个环节里是两份名单） ----
  if (anyObserveStage) out.push(evaluatorNote(a, b, "observe"));
  if (anyDatasetStage) out.push(evaluatorNote(a, b, "dataset"));

  out.push(judgeNote(a, b));
  out.push(cacheNote(a, b));

  return out;
}

/** 一个环节的评估器名单那一条。四档齐全 —— `same` 也出，否则读者分不出
 *  「核过且相同」与「这一项根本没核」（calibrationNotes 头部那条裁定）。 */
function evaluatorNote(
  a: CompareSide, b: CompareSide, type: "observe" | "dataset",
): CalibrationNote {
  const ea = evaluatorNames(a, type);
  const eb = evaluatorNames(b, type);
  const base = {
    id: (type === "observe" ? "evaluators-observe" : "evaluators") as
      "evaluators-observe" | "evaluators",
    label: `${STAGE_LABEL[type]} · 评估器`,
    a: joinNames(ea), b: joinNames(eb),
  };
  if (ea.length > 0 && eb.length > 0) {
    const onlyA = ea.filter((n) => !eb.includes(n));
    const onlyB = eb.filter((n) => !ea.includes(n));
    if (!onlyA.length && !onlyB.length) {
      return {
        ...base, level: "same", text: "",
      };
    }
    const parts: string[] = [];
    if (onlyA.length) parts.push(`只有上一次有 ${onlyA.join("、")}`);
    if (onlyB.length) parts.push(`只有这一次有 ${onlyB.join("、")}`);
    return {
      ...base, level: "diff",
      text: parts.join("；"),
    };
  }
  return { ...base, level: "unknown", text: "" };
}

/** 缓存模式那一条。与 judgeNote 同形（同一个住所、同一条边界），但后果不同：
 *  `reuse` 意味着这一次直接复用了上一次的判分结论 ⇒「持平」是复用出来的。 */
function cacheNote(a: CompareSide, b: CompareSide): CalibrationNote {
  const ca = cacheModes(a);
  const cb = cacheModes(b);
  const label = (xs: string[]) => joinNames(xs.map((m) => (
    m === "off" ? "off（每次重判）" : m === "reuse" ? "reuse（复用已有判分）"
      : m === "record" ? "record（记录不复用）" : m)));
  const base = { id: "cache" as const, label: "判分缓存", a: label(ca), b: label(cb) };
  const anyReuse = ca.includes("reuse") || cb.includes("reuse");
  if (ca.length > 0 && cb.length > 0) {
    if (anyReuse) {
      return {
        ...base, level: "blocking",
        text: "有一侧复用了已有的判分结论 —— 「持平」可能只是复用的结果",
      };
    }
    const same = ca.length === cb.length && ca.every((m) => cb.includes(m));
    return same
      ? { ...base, level: "same", text: "" }
      : {
        ...base, level: "diff",
        text: "两次的缓存模式不同",
      };
  }
  return { ...base, level: "unknown", text: "" };
}

/** 口径条的一句总结论：**取最差那一档**，不做平均、不数条数。
 *  为什么取最差：一条 blocking 就足以让下面所有涨跌不能读，被五条 same 稀释成
 *  「大体没问题」正是这一条要防的事。 */
export function calibrationVerdict(notes: CalibrationNote[]): {
  level: CalibrationLevel; text: string;
} | null {
  if (notes.length === 0) return null;
  const rank: CalibrationLevel[] = ["blocking", "diff", "unknown", "same"];
  const worst = rank.find((lv) => notes.some((n) => n.level === lv)) ?? "same";
  const names = notes.filter((n) => n.level === worst).map((n) => n.label).join("、");
  const text = worst === "blocking"
    ? `${names}对不上 —— 下方的涨跌先别当成 Agent 变好/变坏`
    : worst === "diff"
      ? `${names}有差异，仍可读`
      : worst === "unknown"
        ? `${names}判不出来 —— 不是「相同」`
        : "这几项两次都一样 ⇒ 下方的涨跌可以读成 Agent 自己的变化";
  return { level: worst, text };
}

/**
 * 判分模型那一条。**恒出现** —— 「两次是不是同一把尺子量的」是读下面所有涨跌的
 * 前提，不说读者会默认相同。
 *
 * 四档各有各的话（2026-08-28 改：此前这一条硬写「未记录 / 答不了」，而
 * `report.stages[i].report.judge_model` 一直在落库 —— 界面把一个能答的问题
 * 说成答不了，等于把真读数当不存在）：
 *   same     —— 两次同一个模型 ⇒ 回归那半的涨跌不含量具自身那一份
 *   blocking —— 换过模型 ⇒ 涨跌里混进了量具的那一份，不能读成 Agent 变好/变坏
 *   unknown  —— 至少一侧没记（老 run / 报告读取失败）⇒ 判不出来，**不当成相同**
 *
 * 无论哪档，只要这一对里有线上评估环节就补一句边界：那一半不落这个字段。
 */
function judgeNote(a: CompareSide, b: CompareSide): CalibrationNote {
  const ja = judgeModels(a);
  const jb = judgeModels(b);
  // 「线上评估环节不记判分模型」那句边界说明已删：对任何带线上评估环节的一对
  // 恒成立 ⇒ 是文档不是界面（prose-sweep 2026-09-03）
  const base = { id: "judge" as const, label: "判分模型", a: joinNames(ja), b: joinNames(jb) };

  if (ja.length > 0 && jb.length > 0) {
    const same = ja.length === jb.length && ja.every((m) => jb.includes(m));
    if (same) {
      return { ...base, level: "same", text: "" };
    }
    return {
      ...base, level: "blocking",
      text: "两次不是同一个判分模型 —— 下方的涨跌里混进了量具本身的那一份，"
        + "不能读成 Agent 变好/变坏",
    };
  }
  return { ...base, level: "unknown", text: "" };
}

// ---------------------------------------------------------------------------
// 并排 KPI
// ---------------------------------------------------------------------------

/** 量纲类别。**三类永不互换、永不相加**（ADR-0003）：
 *    score —— 0-1 分（线上评估均分 / 评估器均分）
 *    rate  —— 百分比（回归通过率）
 *    count —— 绝对计数（红队攻破/攻击） */
export type CompareMetricKind = "score" | "rate" | "count";

export interface CompareMetric {
  /** 稳定 id（也是 testid 后缀）：observe / ev-<注册名> / passRate / breach */
  id: string;
  kind: CompareMetricKind;
  /** 展示名。「均分」一律带限定词（CONTEXT.md:93-96，vocab-guard 钉着）。
   *  这是**脱离上下文也读得懂**的全名（带环节限定词），给扁平消费者用。 */
  label: string;
  /**
   * 分组视图里的行名（不带环节限定词）。空/缺 ⇒ 退回 `label`。
   *
   * 为什么要两个名字而不是把 `label` 改短：`compareMetrics()` 返回的是一个**扁平**
   * 数组，同名评估器在两个环节里会给出两行（现网 `correctness` 就是），扁平消费者
   * 只有 `label` 可读 —— 短名一改，那两行在扁平视图里就同名不同数。分组视图另有
   * 组标题承担环节这一层，行里再重复一遍环节名反而把「哪行是哪个环节」这件事
   * 说两遍、把行名挤长。所以两个名字各有住所，不是冗余。
   */
  rowLabel?: string;
  /** 量纲说明 —— 「各比各的」这件事的物质形式，同屏三种量纲靠它区分。
   *  只挂在环节级那一行；同组评估器行为空串（同量纲不重复挂） */
  unit: string;
  /** 已格式化的两侧数值；null = 那一侧没有这一维（老 run / 没跑这一环） */
  a: string | null;
  b: string | null;
  /**
   * 两侧的**分母小字**（空串 = 这一维没有分母语义，或那一侧缺）。
   *
   * 为什么均分旁边必须写分母：这一页问的是「涨了还是跌了」，而一个均分可以因为
   * 两件完全不同的事变动 —— 真的评得更好，或者**分母换了**（现网线上评估环节
   * 枚举 12 个会话、只评出 9 个判定，另 3 个是无内容/判分失败）。只印
   * `0.90 → 1.00` 时这两种读法在界面上不可分，而它们的下一步动作相反（庆祝 vs
   * 去看那 3 条为什么没评出来）。
   * ⚠️ 分母缺失时写「分母未记录」而不是补数：DDB 摘要那一路剥掉了 `sessions`/
   * `errored`，拿环节的枚举会话数顶替会把 9 说成 12（types.ObserveEvaluatorStat
   * 的同一条裁定）。
   */
  subA: string;
  subB: string;
  /** 同量纲内的环比；null = 至少一侧缺，不编造 */
  deltaText: string | null;
  /** true = 变差（红）。攻破数是**反向**量纲：变多才是变差 */
  worse: boolean;
  /** 只有一侧有这一维时的说明；两侧都有 → 空串 */
  note: string;
}

const UNIT: Record<CompareMetricKind, string> = {
  score: "0-1 分",
  rate: "百分比（通过/判定）",
  count: "绝对计数（攻破/攻击）",
};

/** 环比文案：**按量纲分派**，一个都不许借用别人的写法。
 *  通过率说「个百分点」而不是「+0.10」—— 后者与线上评估分同形，正是
 *  「把通过率读成分数」那条现场（derive.ppText 的住所注释）。 */
function deltaTextOf(kind: CompareMetricKind, d: number): string {
  if (d === 0) return "持平";
  if (kind === "rate") return ppText(d);
  if (kind === "count") return `${d > 0 ? "+" : "−"}${Math.abs(d)} 次`;
  // 端点加位同族的第三条线：**0 就是「持平」这个结论**。两位四舍五入会把
  // 0.0019 的真变化印成「+0.00」——与上一行的「持平」同义，读者据此以为没动。
  // 所以非零差值一律加位到看得出来为止（与 fmtScoreExact 同一个上限六位）。
  const mag = Math.abs(d);
  let text = mag.toFixed(2);
  for (let p = 2; p <= 6 && Number(text) === 0; p++) text = mag.toFixed(p);
  return `${d > 0 ? "+" : "−"}${text}`;
}

/** 一侧缺这一维时的原话：只说**是哪一侧**缺。成因枚举与「只显示有数据的那一侧，
 *  不做环比」对任何 run 恒成立 ⇒ 已删（prose-sweep 2026-09-03）。 */
function missingSideNote(side: "a" | "b"): string {
  const which = side === "a" ? "上一次" : "这一次";
  return `${which}没有这一项数据`;
}

/** 一侧的取值：`v` 参与环比（同量纲内相减），`text` 是展示串。
 *  两者分开是因为红队那一维**数值位与展示位不同**（环比比的是攻破数，
 *  显示的是「攻破/攻击」）—— 合成一个就只能靠反推，一旦两侧攻破数相同就串栏。
 *  `sub` 是分母小字，跟着**值**走而不是跟着行走：同一行的两侧分母可以不同
 *  （一次评出 9 条、另一次 11 条），挂在行上就只放得下一个。 */
interface MetricValue { v: number; text: string; sub?: string }

function metricOf(
  id: string, kind: CompareMetricKind, label: string,
  a: MetricValue | null, b: MetricValue | null, rowLabel?: string,
): CompareMetric | null {
  if (a == null && b == null) return null;
  const both = a != null && b != null;
  const d = both ? b.v - a.v : 0;
  return {
    id, kind, label, rowLabel, unit: UNIT[kind],
    a: a?.text ?? null,
    b: b?.text ?? null,
    subA: a?.sub ?? "",
    subB: b?.sub ?? "",
    deltaText: both ? deltaTextOf(kind, d) : null,
    // 反向量纲只此一处（攻破数变多 = 变差）
    worse: both ? (kind === "count" ? d > 0 : d < 0) : false,
    note: both ? "" : missingSideNote(a == null ? "a" : "b"),
  };
}

/**
 * 0-1 分：展示走 lib/scoring.**fmtScoreExact**（两位，但端点上加位），不是全站
 * 那个 fmtScore。
 *
 * 对比页是「涨了多少」的住所，而 fmtScore 的两位四舍五入会在**满分/零分**这两条
 * 结论线上说谎：现网 run₂ 的线上评估均分是 `0.9981`，fmtScore 印 `1.00` ⇒ 两栏
 * 一齐读成「满分」，于是「涨了多少」与「到顶了没有」两个问题一起答错（`deltaText`
 * 那一格算的是真值差，与显示串对不上，看起来像 UI 自相矛盾）。端点之外与 fmtScore
 * 逐字相同，所以列宽只在真到端点边上才变长 —— 换的是那一格不说谎。
 * 迁移范围只到「对比里能直接读出涨跌」的那几处（本函数、CompareView 的判定分数、
 * ComparePage 候选列表），**其余消费点仍用 fmtScore**（fmtScoreFloor 同一条裁定）。
 */
const scoreValue = (v: number | null, sub = ""): MetricValue | null =>
  v == null ? null : { v, text: fmtScoreExact(v), sub };

const rateValue = (v: number | null): MetricValue | null =>
  v == null ? null : { v, text: `${Math.round(v * 100)}%` };

/** 红队：环比比攻破数，展示写「攻破/攻击」（与运行历史的指标 chip 同格式）。 */
const breachValue = (t: { breached: number; attacks: number } | null): MetricValue | null =>
  t == null ? null : { v: t.breached, text: `${t.breached}/${t.attacks}` };

/**
 * 两条取数路**合并**后的环节数组。
 *
 * 同一个环节的真相被劈成两半住着，各缺对方那一半（现网真字节逐键核过，2026-08-28）：
 *   · DDB `stage_summaries`（reportStages）—— dataset 环节独有 `evaluator_stats`
 *     （逐评估器均分/通过数/判定数）；
 *   · S3 `report.stages[i]`（reportStageDetails）—— observe 环节的 `summary` 在这一
 *     份里才带 `{sessions, errored}`（判定数与未评出数 = **分母**；DDB 那一份只留
 *     `{mean_score, pass_rate}`），dataset 环节则多出 `judged_cases` 等。
 * 于是「逐评估器均分 + 它的分母」这一行，无论只读哪一路都拼不出来。
 *
 * 合并方向 = **`{...S3, ...DDB}`，DDB 那一路恒赢**，S3 只补 DDB 压根没有的键。
 * 这不是随手定的方向，而是本函数唯一可辩护的方向：这一层此前**只读 DDB**
 * （`reportStages`），本次改动的目的只有「把读不到的分母补上」，任何一个两路都有的
 * 键换了出处就是在偷偷改数 —— 那种改动不会红，只会让某个指标悄悄换个来源。
 * 反方向（`{...DDB, ...S3}`）我先写过，被夹具当场抓住：红队 `breached` 两路都带，
 * S3 那份把它盖了回去，于是「攻破数变多」那一维读不出变化。
 *
 * `summary` 要**逐评估器**再合一次（同规则：DDB 的值赢，S3 只补缺键）——
 * 顶层整体替换会让 S3 那份独有的 `{sessions, errored}` 跟着整个对象一起被盖掉，
 * 而那两个键正是本次要补的分母。
 *
 * 按「同类型第几个」配对（两数组同序同长：planrun.py:1101
 * `[_stage_summary(r) for r in stage_results]`），任一路缺就原样用另一路。
 */
function mergedStages(d: PlanRunDetail | null | undefined): StageDetail[] {
  const ddb = groupByType(reportStages(d));
  const s3 = groupByType(reportStageDetails(d));
  const types: string[] = [...ddb.keys()];
  for (const t of s3.keys()) if (!types.includes(t)) types.push(t);
  const out: StageDetail[] = [];
  for (const t of types) {
    const n = Math.max(ddb.get(t)?.length ?? 0, s3.get(t)?.length ?? 0);
    for (let occ = 0; occ < n; occ++) {
      const x = ddb.get(t)?.[occ];
      const y = s3.get(t)?.[occ];
      out.push({ ...(y ?? {}), ...(x ?? {}), summary: mergedSummary(x, y) } as StageDetail);
    }
  }
  return out;
}

/** 两路的 observe `summary` 逐评估器合并（DDB 的值赢，S3 只补缺键 —— 分母就在
 *  S3 那一份里）。两路都没有这个键时返回 `undefined`，**不是** `{}`：
 *  空对象会让 `observeEvaluatorRows` 从「这个环节没有 summary」变成「有 summary
 *  但零个评估器」，而后者读出来是「配了评估器却一条都没评」。 */
function mergedSummary(x: StageDetail | undefined, y: StageDetail | undefined) {
  const a = x?.summary;
  const b = y?.summary;
  if (!a || typeof a !== "object") return b;
  if (!b || typeof b !== "object") return a;
  const names = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out: Record<string, unknown> = {};
  for (const n of names) {
    const av = (a as Record<string, unknown>)[n];
    const bv = (b as Record<string, unknown>)[n];
    out[n] = av && typeof av === "object" && bv && typeof bv === "object"
      ? { ...(bv as object), ...(av as object) }
      : av ?? bv;
  }
  return out as StageDetail["summary"];
}

/** 一侧的 run 摘要形态（指标全部从这里算）：摘要行 + **detail 侧的环节数组**。
 *  环节走 mergedStages（两条取数路各缺一半，见该函数）—— 只读一个键既是整页白屏
 *  的老根因，也是「逐评估器分母读不出来」的根因。 */
function summaryLike(side: CompareSide): PlanRunSummary {
  const stages = mergedStages(side.detail);
  const base = side.summary;
  return {
    run_key: base?.run_key ?? side.detail?.run_key ?? "",
    status: side.detail?.status ?? base?.status ?? "",
    score: side.detail?.score ?? base?.score ?? null,
    started_at: side.detail?.started_at ?? base?.started_at ?? null,
    duration_s: side.detail?.duration_s ?? base?.duration_s ?? null,
    stage_summaries: stages.length ? stages : (base?.stage_summaries ?? []),
  };
}

/**
 * 逐评估器行在一侧的取值表：键 = 评估器注册名，值 = 均分 + 分母小字。
 *
 * **键要留住，值可以是 null**：一个「配了但一条判定都没有」的评估器必须仍然出现
 * 在键里 —— 调用方拿两侧的键取并集来决定画几行，从表里消失会被读成「它评过且
 * 没问题」（evaluatorRows 硬语义 2 的同一条理由，只是搬到了对比这一层）。
 */
type EvalValues = Map<string, MetricValue | null>;

/** 多环节时均分**等权平均**、分母**相加**（同 derive.regressionTrend 的处理）。
 *  两者用不同的合并方式不是随意：均分是率、分母是量，把率相加或把量平均都会
 *  给出一个没有含义的数。 */
function meanOf(xs: number[]): number | null {
  return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null;
}

/** 回归环节的逐评估器取值。分母小字写「通过 x/y 判定」——
 *  `judged` 是**判定数**不是用例数（先剔 errored 再算，口径与 mean 同源）。 */
function datasetEvaluatorValues(run: PlanRunSummary): EvalValues {
  const means = new Map<string, number[]>();
  const den = new Map<string, { passed: number; judged: number }>();
  const names: string[] = [];
  for (const s of run.stage_summaries ?? []) {
    if (s.type !== "dataset") continue;
    for (const row of evaluatorRows(s)) {
      if (!names.includes(row.name)) names.push(row.name);
      if (row.mean != null) means.set(row.name, [...(means.get(row.name) ?? []), row.mean]);
      const cur = den.get(row.name) ?? { passed: 0, judged: 0 };
      den.set(row.name, { passed: cur.passed + row.passed, judged: cur.judged + row.judged });
    }
  }
  const out: EvalValues = new Map();
  for (const n of names) {
    const d = den.get(n);
    out.set(n, scoreValue(meanOf(means.get(n) ?? []),
      d && d.judged > 0 ? `通过 ${d.passed}/${d.judged} 判定` : ""));
  }
  return out;
}

/**
 * 线上评估环节的逐评估器取值 —— 用户原话「更重要的也要去看每个评估器它的分数」
 * 的另一半。此前对比页只画回归那一半，而现网这两轮**唯一有意义的三个评估器全在
 * 线上评估环节里**：首屏只印 dataset 的 `correctness`（两轮都 1.00「持平」），
 * 于是整页读出来是「什么都没变」。
 *
 * 分母走 `{sessions, errored}`（判定数 / 未评出数），只有 S3 那一路带 ⇒ 环节必须
 * 是 mergedStages 合并过的。任一环节没记分母就整行退到「分母未记录」：部分累加
 * 会给出一个比真值小的分母，那比不写更坏（读者会拿它当真分母去算）。
 */
function observeEvaluatorValues(run: PlanRunSummary): EvalValues {
  const means = new Map<string, number[]>();
  const den = new Map<string, { judged: number | null; errored: number | null }>();
  const names: string[] = [];
  for (const s of run.stage_summaries ?? []) {
    if (s.type !== "observe") continue;
    for (const row of observeEvaluatorRows(s)) {
      if (!names.includes(row.name)) names.push(row.name);
      if (row.mean != null) means.set(row.name, [...(means.get(row.name) ?? []), row.mean]);
      const cur = den.get(row.name) ?? { judged: 0, errored: 0 };
      den.set(row.name, {
        judged: cur.judged == null || row.judged == null ? null : cur.judged + row.judged,
        errored: cur.errored == null || row.errored == null ? null : cur.errored + row.errored,
      });
    }
  }
  const out: EvalValues = new Map();
  for (const n of names) {
    const d = den.get(n);
    const sub = !d || d.judged == null ? "分母未记录"
      : d.errored == null ? `${d.judged} 判定`
      : `${d.judged} 判定 · ${d.errored} 未评出`;
    out.set(n, scoreValue(meanOf(means.get(n) ?? []), sub));
  }
  return out;
}

/** 两侧取值表 → 逐评估器 KPI 行。名单取**并集且保序**（先 a 的原序，b 多出来的
 *  追加在后）—— 「这一次多了个评估器」本身就是要透出的信息。 */
function evaluatorMetrics(
  idPrefix: string, stageType: "observe" | "dataset", ea: EvalValues, eb: EvalValues,
): CompareMetric[] {
  const names: string[] = [...ea.keys()];
  for (const n of eb.keys()) if (!names.includes(n)) names.push(n);
  const out: CompareMetric[] = [];
  for (const n of names) {
    // 标签**带环节限定词**：同一个评估器名可以同时出现在两个环节里（现网
    // `correctness` 就是），只写「评估器均分 · correctness」会让同屏出现两行
    // 同名不同数的行 —— 而那两个数分母单位都不同（判定 vs 会话判定），
    // 「哪行是哪个环节」在界面上无处可读。
    const m = metricOf(`${idPrefix}${n}`, "score",
      `${STAGE_LABEL[stageType]} · 评估器均分 · ${n}`,
      ea.get(n) ?? null, eb.get(n) ?? null,
      // 分组视图里环节名由组标题承担，行名只留「评估器均分 · <名>」
      `评估器均分 · ${n}`);
    // 量纲角标只挂在环节级那一行：同组评估器行与它同量纲（都是 0-1 分），
    // 每行再挂一遍是同一句话读 N 次（prose-sweep 2026-09-03）
    if (m) out.push({ ...m, unit: "" });
  }
  return out;
}

/**
 * 并排 KPI 的**扁平**行集 = compareMetricGroups 按组序摊平。顺序因此固定：
 *   线上评估均分 → 线上评估逐评估器 → 回归通过率 → 回归逐评估器 → 红队攻破
 * 即「环节级那一行紧跟它自己的评估器级各行」。
 *
 * ⚠️ 顺序 2026-08-29 改过一次（`passRate` 从末尾挪到 `ev-*` 之前）：此前的注释
 * 自己写着「环节总分紧跟它自己的分解项」，而代码把回归通过率排在它的分解项**后面**
 * —— 于是屏幕上 `ev-correctness` 紧跟在线上评估的分解项后面，读起来像线上评估的
 * 第四个评估器。用户就是这么读的（原话：「回归测试分数指的是什么？为什么和
 * corecness 评估器分数放一起」）。钉子在 tests/run-compare.test.tsx 的 id 序那条。
 *
 * 保留这个扁平出口是因为它有真消费者（id 序钉、导出、以及不分组的窄屏退化），
 * 但**分层结论只在分组视图里说得清** —— 新消费点一律用 compareMetricGroups。
 */
export function compareMetrics(a: CompareSide, b: CompareSide): CompareMetric[] {
  return compareMetricGroups(a, b).flatMap((g) => [
    ...(g.headline ? [g.headline] : []), ...g.rows,
  ]);
}

/** 同一环节内「哪一侧缺数据」那句只说一次：同侧缺的原因是同一个，逐评估器行
 *  各重复一遍是同一句话读 N 次。保留组内**第一次出现**（环节级那一行算第一），
 *  之后同文的行清空 note。 */
function dedupeNotes(headline: CompareMetric | null, rows: CompareMetric[]): CompareMetric[] {
  const seen = new Set<string>(headline?.note ? [headline.note] : []);
  return rows.map((m) => {
    if (!m.note) return m;
    if (seen.has(m.note)) return { ...m, note: "" };
    seen.add(m.note);
    return m;
  });
}

/** 一个环节的对比块。**环节级读数与评估器级读数分层住**，不再同表并列。 */
export interface CompareMetricGroup {
  /** 环节类型，也是组 testid 后缀（plan-compare-mgroup-<stage>） */
  stage: "observe" | "dataset" | "redteam";
  /** 组标题 = 术语五词之一（lib/scoring.STAGE_LABEL，不在这里新造映射） */
  label: string;
  /** 环节级那一行；null = 这一环两侧都读不出环节级读数 */
  headline: CompareMetric | null;
  /** 评估器级各行（可能为空：老 run 不记 evaluator_stats） */
  rows: CompareMetric[];
  /** 组里一个数都没有时的一句说明；有数 → 空串 */
  empty: string;
}

/**
 * 并排 KPI 的**分组**行集。组序固定 observe → dataset → redteam（与 STAGE_LABEL
 * 的定序、与运行页各处一致）；组内固定「环节级那一行 → 它自己的评估器级各行」。
 *
 * 一个组只在「至少一侧真跑过这一环」时出现 —— 两次都没跑红队就不出红队组：
 * 对没跑过的环节说「0 次攻破」或「没测」都是凭空造读数，而「这两次各跑了哪几个
 * 环节」已由口径条的「环节构成」那一行负责（calibrationNotes）。
 *
 * 取值一律走既有权威函数，绝不在这里第二次实现口径：
 *   线上评估均分 → lib/scoring.effectiveScore（ADR-0003 的住所）
 *   线上评估逐评估器 → derive.observeEvaluatorRows（读 `summary`）
 *   回归逐评估器 → derive.evaluatorRows（老 run 缺 evaluator_stats 时它返回空）
 *   回归通过率   → derive.runPassRate（只认 completed 的回归环节）
 *   红队攻破     → derive.runRedteamTally（「没测」≠「0 次攻破」）
 *
 * ⚠️ 两组逐评估器行的 id 前缀不同（`evo-` / `ev-`）且**都不许合并**：同名评估器
 * 在两个环节里是两个数、两种分母，合成一个数就是 ADR-0003 那条硬线的反面。
 */
export function compareMetricGroups(a: CompareSide, b: CompareSide): CompareMetricGroup[] {
  const ra = summaryLike(a);
  const rb = summaryLike(b);
  const ran = (t: "observe" | "dataset" | "redteam") => hasStageType(a, t) || hasStageType(b, t);
  const out: CompareMetricGroup[] = [];

  const add = (
    stage: "observe" | "dataset" | "redteam",
    headline: CompareMetric | null, rows: CompareMetric[], empty: string,
  ) => {
    if (!headline && rows.length === 0 && !ran(stage)) return;
    out.push({
      stage, label: STAGE_LABEL[stage], headline, rows: dedupeNotes(headline, rows),
      empty: headline || rows.length ? "" : empty,
    });
  };

  // 量纲讲解句（「环节级读数 = …别横着比」三段）已整段删除：对任何 run 恒成立的
  // 话是使用文档不是界面（用户 2026-08-30 终裁，也不进悬停）。量纲由每行 unit
  // 角标承载。
  add("observe",
    metricOf("observe", "score", "线上评估均分",
      scoreValue(effectiveScore(ra)), scoreValue(effectiveScore(rb)), "线上评估均分"),
    evaluatorMetrics("evo-", "observe", observeEvaluatorValues(ra), observeEvaluatorValues(rb)),
    "两次都没读出线上评估的分数");

  add("dataset",
    metricOf("passRate", "rate", "回归通过率",
      rateValue(runPassRate(ra)), rateValue(runPassRate(rb))),
    evaluatorMetrics("ev-", "dataset", datasetEvaluatorValues(ra), datasetEvaluatorValues(rb)),
    "两次都没读出回归的通过率");

  add("redteam",
    metricOf("breach", "count", "红队攻破",
      breachValue(runRedteamTally(ra)), breachValue(runRedteamTally(rb))),
    [],
    "两次都没读出红队的攻破数");

  return out;
}

// ---------------------------------------------------------------------------
// 三桶：对齐单位与「过/挂」口径
// ---------------------------------------------------------------------------

/**
 * 一个对齐单位（用例 / 会话 / 攻击用例）的结论。
 *
 *   pass —— 过；fail —— 挂；none —— **没有判定**（不是 0 分，也不是「挂」）
 *
 * none 这一档是本视图最容易出错的地方：把「上一次没评出结论」算成「挂」，
 * 这一次一通过就会被写成「修好了」—— 而事实是上一次压根没测出结果。
 */
export type UnitOutcome = "pass" | "fail" | "none";

// ---------------------------------------------------------------------------
// 对齐键：为什么不能用用例名
// ---------------------------------------------------------------------------
//
// **同名用例 ≠ 同一道题。** 用例名是**按位置派生**的：
//   app/catalog.py:save_dataset → `c.setdefault("name", f"case-{i + 1}")`
// 也就是说用户没起名的用例一律叫 case-1、case-2…，而数据集只有 `updated_at`、
// 没有内容指纹。在两次运行之间插入/删除/重排一条用例，「case-3」指的就已经是另
// 一道题 —— 按名对齐的三桶会**静默撒谎**（把 A 的第 3 题与 B 的第 4 题配成一对，
// 然后宣布「修好了」）。
//
// 所以对齐键优先取**题面本身**，名字只作显示：
//   · 回归用例 → 明细行的 `input`。它一定在：执行侧构造行时就写了
//     （app/testrun.py:718 `entry = {"agent":…, "case": case["name"],
//     "input": case["input"], …}`），而 catalog.save_dataset 又强制每条用例
//     `input` 非空（同文件 `case[{i}] missing 'input'` 那条校验）。
//   · 红队攻击 → `objective` + `strategy`（app/redteam.py:590
//     `"objective": r.objective or src.get("actor_goal", "")`）。红队用例名同样
//     是派生的（redteam.py:334 `f"{cat}_{i}"`），更不能当身份。
//   · 线上评估会话 → `session_id`。这个是真身份（不是派生的），照用。
// 题面读不到时才退化按名对齐，并且此时若数据集在较早那次 run 之后被改过
// （`updated_at`，list_datasets 原样带出 —— app/catalog.py:_dataset_from_item）
// 就出警示横幅：宁可说「可能失真」，也不装作对齐是可靠的。

/** 对齐键的依据（展示层要说清按什么对齐的 —— 这是结论可信度的一部分）。 */
export type AlignBy = "input" | "name" | "session" | "case";

export const ALIGN_TEXT: Record<AlignBy, string> = {
  input: "按题面对齐",
  name: "按用例名对齐",
  session: "按会话对齐",
  case: "按用例对齐",
};

// ---------------------------------------------------------------------------
// 会话 → 用例：线上评估环节能按「同一道题」对齐的物质基础
// ---------------------------------------------------------------------------
//
// 用户原话：「整个评估方案应该都是一样的，也就是我们选的数据集合。评估期应该都是
// 一致的……所以评估对比里面应该是 11 对应的呀，它的分数是增了，减了，为什么增？
// 为什么减？」—— 说的正是线上评估那一块：两次跑的是同一个数据集，可界面上 24 行
// 全落「无法对齐」，一对都没有。
//
// 根因不是数据缺失，是**对齐键选错了层**：observe 环节的单位是会话，而会话 id 每
// 次都是新的（`evaltest-<跑批时刻>-<uuid>`，见现网真字节）—— 按 session_id 对齐，
// 两次必然零交集。但同一个 run 的**回归环节**每一行都落了它自己那次调用的
// `session_id`（app/testrun.py 的 entry 带 `session_id`），而线上评估环节评的正是
// 回溯窗口里的这些会话。所以「这个会话测的是哪道题」是**现成的映射**，一层索引就
// 能把会话身份换成用例身份，两次就比得起来了。
//
// 三条边界，一条都不许省：
//   1. 索引**按侧建**（每一侧用自己 run 的回归明细）—— 拿 A 的映射去解 B 的会话
//      会全部落空，而落空长得跟「这次没跑这道题」一模一样。
//   2. 回溯窗口里还有**别的 run 的**会话（枚举上限 12 条、回溯 1 天，
//      app/discovery.py:217）—— 那些回溯不到本次运行的任何用例，键退回 session_id，
//      落「无法对齐」并单独说明是哪一种。现网两轮各有 1 条这样的会话。
//   3. 同一个窗口也可能**漏掉自己 run 的某道题**（12 条上限正好切在这里）——
//      现网 A 少 bi-metrics-12、B 少 bi-metrics-10 ⇒ 12+12 对成 10 对 + 4 条落单，
//      不是 11 对 11。**不许为了凑对而放宽键**：少的那两条要以「另一次的抽样窗口里
//      没有这道题的会话」出现，那正是抽样口径本身该被看见的地方。
export interface SessionCaseRef {
  /** 用例名（展示用；键用题面） */
  name: string;
  /** 题面归一后的串；空 = 这一行没有题面（键只能退回用例名） */
  input: string;
  agent: string;
}

export type SessionCaseIndex = Map<string, SessionCaseRef>;

/**
 * 这一次运行里「session_id → 它测的那道题」的全量映射（取自**本 run 的**回归环节
 * 明细）。没有回归环节 / 明细缺失 / 行上没有 session_id → 那几条不进索引（空索引
 * 是合法结果：线上评估那一块自动退回按会话对齐，与本功能之前的行为逐字相同）。
 */
export function sessionCaseIndex(d: PlanRunDetail | null | undefined): SessionCaseIndex {
  const out: SessionCaseIndex = new Map();
  for (const st of reportStageDetails(d)) {
    if (st.type !== "dataset") continue;
    const rows = st.report?.results;
    if (!Array.isArray(rows)) continue;
    for (const raw of rows) {
      const r = (raw ?? {}) as CaseResult;
      const sid = textOf(r.session_id).trim();
      if (!sid || out.has(sid)) continue;
      out.set(sid, {
        name: textOf(r.case).trim(),
        input: alignText(textOf(r.input)),
        agent: textOf(r.agent).trim(),
      });
    }
  }
  return out;
}

/** 题面归一：只做 trim + 空白折叠。**不做**大小写/标点归一 —— 那些差异在
 *  评估语义里是真差异，抹掉它们就又变成一种「看起来对齐了」。 */
function alignText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 一个对齐单位在**一次运行**里的样子（点开后的左右并排读的就是它）。 */
export interface CompareUnit {
  outcome: UnitOutcome;
  /** 无判定时的短标记（空响应 / 调用失败 / 无内容可评 / 无有效结论…） */
  noteMark: string;
  /** 无判定的后端原话；没有原话就留空，绝不替后端编原因 */
  noteText: string;
  input: string;
  output: string;
  /** 逐评估器判定（含 errored 那些 —— 它们要以「评估失败」出现，不能消失） */
  verdicts: CaseVerdict[];
}

/**
 * 展示桶。「两次都通过**且分数持平**」不占桶（只计数）—— 那才是真的没什么可看。
 *
 * `scoreUp` / `scoreDown` 是后加的一档，补的是本视图最大的一个盲区：三桶只认
 * 「过/挂」翻面，于是一条 0.10 → 1.00、两次 `passed` 都是 true 的用例会被算进
 * 「两次都通过」那个**标题里的计数**，在界面上彻底消失 —— 用户原话「0.10→1.00
 * …首屏读出来是「持平」」。分数动了但结论没翻面，是「改进生效了但还不够/开始退化
 * 但还没破线」这两件事唯一的早期信号。
 */
export type BucketKind =
  "fixed" | "broken" | "scoreUp" | "scoreDown" | "still" | "noverdict" | "unaligned";
type PairBucket = BucketKind | "bothpass";

export interface UnitPair {
  /** 对齐键（同名单位在同一次运行里出现多次时带出现序） */
  key: string;
  /** 展示名：用例名 / session_id / 攻击用例名 */
  title: string;
  /** DOM 安全的稳定 id（testid 用） */
  slug: string;
  /** 次要标识：分类 / Agent / 策略 · 严重度 */
  sub: string;
  a: CompareUnit | null;
  b: CompareUnit | null;
  bucket: PairBucket;
  /** 只有 unaligned 桶里非空：为什么这一条对不上（**同名不同题面**要单独说 ——
   *  它长得最像「同一条」，也最容易被读成三桶里的某一桶）。 */
  why: string;
  /**
   * 只有 scoreUp / scoreDown 两桶里非空：`0.10 → 1.00` 这样的两侧均分。
   *
   * 为什么必须挂在**收起态**上：这两桶里的用例两次都通过，收起来那行印的两个结论
   * 词就都是「通过」—— 读出来是「通过 → 通过」，而它落在「分数涨了」桶里。桶名与
   * 行内容互相矛盾，用户得逐条点开才知道涨了多少，那就等于没有分桶。
   * 其余桶留空：那些桶的结论词本身已经翻了面（挂 → 通过），再塞一对数会跟结论抢。
   */
  scoreText: string;
}

export interface StageCompare {
  /** observe | dataset | redteam */
  type: string;
  /** 术语五词（lib/scoring.STAGE_LABEL，不在这里新造映射） */
  label: string;
  /** 对齐单位的量词：用例 / 会话 / 攻击用例 */
  unitWord: string;
  /** 数据集名（S3 报告体里的那份；没有就空串） */
  dataset: string;
  pairs: UnitPair[];
  counts: Record<BucketKind, number>;
  /** 两次都通过的单位数（桶外计数，给分母用） */
  bothPass: number;
  /** 哪一侧没有逐单位明细；null = 两侧都有 */
  missing: "a" | "b" | "both" | null;
  /** missing 非空时的原话（缺就说缺，不画空桶） */
  missingText: string;
  /** 这一块按什么对齐的（结论可信度的一部分，展示层要写出来） */
  alignBy: AlignBy;
  /** 退化按名对齐 **且** 数据集在较早那次 run 之后改过 → 警示原话；否则空串。
   *  用例名按位置派生（catalog.py `case-{i+1}`），此时逐用例对齐可能失真。 */
  staleText: string;
}

/**
 * 环节的单位名词 —— **全站唯一一张表**（对比页逐单位对齐 / 报告页矩阵与 tile /
 * 运行详情环节带都读它；此前三处各写一份，redteam 一处叫「攻击」、一处叫「用例」）。
 * redteam 取「攻击用例」：一个单位就是 **用例 × 策略**（见下方 stageCompareOf 的红队分支
 * 与 catalog 的攻击数口径），resources 的生成入口也叫「AI 生成攻击用例」；
 * 单叫「攻击」在「最差攻击」这种位置会被读成「最凶的那次攻击」而不是「分最差的那个单位」，
 * 单叫「用例」则与回归测试的用例撞名。表外的默认词由各调用方按自己的版面给。
 */
export const UNIT_WORD: Record<string, string> = {
  observe: "会话", dataset: "用例", redteam: "攻击用例",
};

// 桶级说明句（UNALIGNED_TEXT / NOVERDICT_TEXT）已随「通用说明整句删除」退役
// （用户 2026-08-30 终裁，也不进悬停）：行级 pair.why（这一条自己的事实）仍在。

/**
 * 逐评估器判定 → 一个单位的结论。**口径逐字照 app/planrun.py:_stage_summary 的
 * dataset 分支**（那三行 `_verdicts` / `judged` / `passed` 是通过率的定义点）：
 *   · 先剔 errored（评估器自身执行失败 ≠ 0 分，剔的是判定不是用例）；
 *   · 一条有效判定都不剩 → 不入分母 = 这里的 `none`；
 *   · per-case **AND**：所有有效判定都通过才算过（后端 `all(v.get("passed") …)`）。
 * `excluded` 对应后端 judged 闸门的前两条（`not blank_output and not error`）。
 */
function outcomeOf(verdicts: CaseVerdict[], excluded: boolean): UnitOutcome {
  if (excluded) return "none";
  const live = verdicts.filter((v) => !v.errored);
  if (live.length === 0) return "none";
  return live.every((v) => v.passed === true) ? "pass" : "fail";
}

/** 一个待对齐的单位：对齐键 + 展示名 + 这一次的样子。 */
interface KeyedUnit {
  key: string;
  title: string;
  sub: string;
  /** 这一条的键是按题面算的还是退化按名算的（整块的 alignBy 取所有条目的下界） */
  byInput: boolean;
  /** 这一条对不上时的**专属**原话，覆盖 stageCompareOf 的通用 whyOf。
   *  只有 observe 用得上：会话对不上有两种完全不同的成因（回溯不到本次运行的任何
   *  用例 / 回溯到了但另一次的抽样窗口里没有这道题），而通用那句
   *  「这一次已删除或换了题面」两种都说错 —— 它会把抽样口径说成数据集改动。 */
  whyUnaligned?: string;
  unit: CompareUnit;
}

/** 回归环节：一个用例一个单位。行料直接用 derive.caseRows —— 报告抽屉的钻取区
 *  读的是同一个函数，两处的「这一行是什么」不许各算一遍。 */
function datasetUnits(stage: StageDetail): KeyedUnit[] {
  return caseRows(stage).map((row: CaseRow) => {
    // caseRows 的 key 带数组下标（同一次运行内唯一），跨 run 会漂。对齐键优先
    // 取**题面**（同一个 Agent 上的同一道题才是同一条），题面缺失才退到用例名。
    const q = alignText(row.input);
    return {
    key: q ? `q\0${row.agent}\0${q}` : `n\0${row.agent}\0${row.name}`,
    byInput: q !== "",
    title: row.name,
    sub: [row.category, row.agent].filter(Boolean).join(" · "),
    unit: {
      // 后端 judged 闸门的前两条：空响应（blank_output）与调用失败（error）
      outcome: outcomeOf(row.verdicts,
        row.note?.kind === "blank" || row.note?.kind === "invoke_error"),
      noteMark: row.note?.mark ?? "",
      noteText: row.note?.text ?? "",
      input: row.input,
      output: row.output,
      verdicts: row.verdicts,
    },
    };
  });
}

/** 判定 dict（observe 的 results / redteam 的 results）→ CaseVerdict[]。
 *  与 derive.verdictsOf 同刑：errored 的 score/passed 是 null（**不是 0**）。 */
function verdictsOf(raw: unknown): CaseVerdict[] {
  if (!raw || typeof raw !== "object") return [];
  const dict = raw as Record<string, { score?: unknown; passed?: unknown; errored?: unknown; reason?: unknown }>;
  return Object.keys(dict).map((name) => {
    const v = dict[name] ?? {};
    const errored = v.errored === true;
    return {
      name,
      score: !errored && typeof v.score === "number" ? v.score : null,
      passed: !errored && typeof v.passed === "boolean" ? v.passed : null,
      errored,
      reason: textOf(v.reason),
    };
  });
}

/**
 * 线上评估环节：一个**会话**一个单位（session_result 维度）。
 *
 * 「过/挂」是 dataset 那条口径在会话行上的投影：app/observe.py:summarize 的
 * `judged = [r for r in rows if not r.get("errored")]` 与 dataset 侧同源（先剔
 * errored 再算），per-session 的 passed 标志就是 evaluate_session 写的那一份
 * （observe.py:96 `"passed": None if errored else bool(...)`）。
 * no_content 的会话后端已把所有判定置 errored（observe.py:111-113）→ 天然
 * 落 `none`；这里另外显式判 no_content/error，好把**原话**摆出来。
 *
 * **对齐键不是 session_id**（那是本视图最早的设计错，见 sessionCaseIndex 头部的
 * 长注释）：会话 id 每次运行都是新的，按它对齐两次必然零交集 —— 现网真字节里 24 行
 * 会话一对都没配上，而两次跑的是同一个数据集。所以键优先取**这个会话测的那道题**
 * （`idx` 把 session_id 换成题面），回溯不到才退回 session_id。
 */
function observeUnits(stage: StageDetail, idx: SessionCaseIndex): KeyedUnit[] | null {
  const raws = stage.session_details;
  if (!Array.isArray(raws)) return null;
  return raws.map((raw, i) => {
    const s = (raw ?? {}) as ObserveSessionDetail;
    const id = textOf(s.session_id).trim() || `(未知会话)#${i + 1}`;
    const err = textOf(s.error).trim();
    const noContent = s.no_content === true;
    const ref = idx.get(id) ?? null;
    // 键的三档，与回归侧同形（`q\0` = 按题面，`n\0` = 退化按名）：
    //   有题面 → 与回归环节**同一道题**共用一个键形（同一个 Agent 上的同一道题）
    //   回溯到了但那一行没题面 → 退到用例名
    //   回溯不到（窗口里别的 run 的会话）→ 退到 session_id，落「无法对齐」
    const key = ref?.input ? `q\0${ref.agent}\0${ref.input}`
      : ref?.name ? `n\0${ref.agent}\0${ref.name}`
      : `s\0${id}`;
    return {
      key,
      byInput: Boolean(ref?.input),
      // 展示名换成用例名（会话 id 是 60 字的乱码，读者从它读不出这是哪道题）；
      // 会话 id 降到副标 —— 它仍是这一行的唯一凭据，不许丢
      title: ref?.name || id,
      sub: [ref ? id : "", textOf(s.agent).trim()].filter(Boolean).join(" · "),
      whyUnaligned: ref
        ? "另一次的抽样窗口里没有这道题的会话"
        : "这个会话回溯不到本次运行的任何用例",
      unit: {
        outcome: outcomeOf(verdictsOf(s.results), noContent || err !== ""),
        // 「无内容可评」与实时会话清单同词（ObserveSessionsPanel 的档位文案），
        // 不新造第二个说法
        noteMark: err ? "拉取失败" : noContent ? "无内容可评" : "",
        // no_content 的原话是后端 warning（observe.py 按本次 span 分好的那一档）
        noteText: err || (noContent ? textOf(s.warning) : ""),
        input: "",
        output: textOf(s.output_preview),
        verdicts: verdictsOf(s.results),
      },
    };
  });
}

/**
 * 红队环节：一个**攻击用例**一个单位（= 用例 × 策略：后端的攻击数
 * `= len(cases) × len(strategies)`，而 case_name 就是 `base_case__strategy`
 * 形态，redteam.py:_shape_report 的 `base = r.case_name.split("__")[0]`）。
 *
 * 对齐键取 **攻击目的（objective）+ 策略**，不是 case_name：红队用例名同样是
 * 派生的（redteam.py:334 `f"{cat}_{i}"`），用例集编辑过一次同名就换了题。
 * objective 读不到时才退到 case_name。
 *
 * 「过/挂」照 redteam.py:_shape_report：
 *   `breached = (not r.passed) and not errored` —— breached 就是「挂」；
 *   errored 行「produced no verdict at all — neither breach nor safe」→ `none`
 *   （攻破率的分母 `n_judged = n - n_errored` 也是照这条算的）。
 */
function redteamUnits(stage: StageDetail): KeyedUnit[] | null {
  const raws = stage.report?.results;
  if (!Array.isArray(raws)) return null;
  return raws.map((raw, i) => {
    const r = (raw ?? {}) as CaseResult;
    const name = textOf(r.case_name).trim() || textOf(r.case).trim() || `攻击 ${i + 1}`;
    const errored = r.errored === true;
    const breached = r.breached === true;
    const reply = lastTargetReply(r.conversation);
    const strategy = textOf(r.strategy).trim();
    const goal = alignText(textOf(r.objective));
    return {
      key: goal ? `q ${strategy} ${goal}` : `n ${name}`,
      byInput: goal !== "",
      title: name,
      sub: [strategy, textOf(r.severity).trim()].filter(Boolean).join(" · "),
      unit: {
        outcome: errored ? "none" : breached ? "fail" : "pass",
        noteMark: errored ? "无有效结论" : "",
        // errored 攻击的原因后端写在 reason 里（三支各有各的原话，
        // redteam.py:_shape_report 的 declined/unreachable/silenced）
        noteText: errored ? textOf(r.reason) : "",
        input: textOf(r.objective),
        output: reply,
        // errored 攻击的 results 是 {} → 判定列表为空，理由走 noteText
        verdicts: verdictsOf(r.results),
      },
    };
  });
}

/** 攻击对话里被测 Agent 最后说的那句（红队没有「输出」字段，回答就在对话里）。 */
function lastTargetReply(conversation: unknown): string {
  if (!Array.isArray(conversation)) return "";
  for (let i = conversation.length - 1; i >= 0; i--) {
    const m = (conversation[i] ?? {}) as { role?: unknown; content?: unknown };
    const role = textOf(m.role).trim();
    if (role === "target" || role === "assistant") return textOf(m.content);
  }
  return "";
}

function unitsOf(stage: StageDetail | null | undefined, idx: SessionCaseIndex) {
  if (!stage) return null;
  if (stage.type === "observe") return observeUnits(stage, idx);
  if (stage.type === "dataset") {
    const rows = datasetUnits(stage);
    // caseRows 对「没有 results 数组」的环节返回空数组，分不出「明细缺失」与
    // 「真的零个用例」—— 这里按数组存在性判，缺失走降级说明
    return Array.isArray(stage.report?.results) ? rows : null;
  }
  if (stage.type === "redteam") return redteamUnits(stage);
  return null;
}

/** 同名单位在同一次运行里出现多次（后端不保证用例名唯一）→ 键补出现序，
 *  免得第二个同名单位被硬配到第一个上。 */
function dedupe<T extends { key: string }>(items: T[]): T[] {
  const seen = new Map<string, number>();
  return items.map((it) => {
    const n = (seen.get(it.key) ?? 0) + 1;
    seen.set(it.key, n);
    return n === 1 ? it : { ...it, key: `${it.key}#${n}` };
  });
}

/**
 * 一个单位这一次的均分（逐评估器判定的平均），一条有效判定都没有就是 null。
 *
 * 口径与 `outcomeOf` 同源，也就是与后端 `_stage_summary` 同源：**先剔 errored**
 * —— 评估器自身执行失败不是 0 分，把它当 0 参与平均会把一次「量具坏了」记成
 * 「Agent 变差了」（`errored: true` 不许显示成 0 分的同一条裁定，只是搬到了均分上）。
 * `score` 为 null 的判定同样不入平均（有 passed 没有数值分的评估器）。
 */
function unitScore(u: CompareUnit): number | null {
  const xs = u.verdicts
    .filter((v) => !v.errored && typeof v.score === "number")
    .map((v) => v.score as number);
  return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null;
}

/** 「分数变了」的门槛：0.005 = 两位小数的显示串开始不一样的那一点。
 *  比这更小的差在界面上印出来是两个**相同**的数，单列一档只会制造
 *  「桶名说涨了、两个数一模一样」的自相矛盾。 */
const SCORE_EPS = 0.005;

function bucketOf(a: CompareUnit | null, b: CompareUnit | null): PairBucket {
  if (!a || !b) return "unaligned";
  if (a.outcome === "none" || b.outcome === "none") return "noverdict";
  if (a.outcome === "fail" && b.outcome === "pass") return "fixed";
  if (a.outcome === "pass" && b.outcome === "fail") return "broken";
  if (a.outcome === "fail" && b.outcome === "fail") return "still";
  // 到这里两次都通过。**再看分数**：0.10 → 1.00 而两次 `passed` 都是 true 是真实
  // 发生的形态（阈值宽的评估器），此前它被算进「两次都通过」那个标题计数里，在界面
  // 上彻底消失 —— 首屏因此读出来是「持平」。
  // ⚠️ 任一侧算不出均分就仍归 bothpass：那时「涨了」这个结论没有依据，
  // 而空着一半的 `0.90 → —` 比不分这一档更容易被读成「掉到没有了」。
  const sa = unitScore(a);
  const sb = unitScore(b);
  if (sa == null || sb == null) return "bothpass";
  if (sb - sa >= SCORE_EPS) return "scoreUp";
  if (sa - sb >= SCORE_EPS) return "scoreDown";
  return "bothpass";
}

/** DOM 安全的 slug（testid 用）：非字母数字/汉字/下划线/连字符一律换成连字符。 */
function slugify(s: string): string {
  const t = s.replace(/[^\w一-龥-]+/g, "-").replace(/^-+|-+$/g, "");
  return t || "unit";
}

/** 按 type 分组（保序）：一个方案可以有两个同类型环节，配对要按「同类型第几个」。 */
function groupByType<T extends { type?: string }>(stages: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const s of stages) {
    const t = s.type ?? "";
    out.set(t, [...(out.get(t) ?? []), s]);
  }
  return out;
}

/**
 * 中部三桶的数据：**按环节**一块。
 *
 * 环节清单取自两侧的 `stage_summaries`（reportStages 的三重兜底），而不是明细
 * 数组 —— 明细可能整个缺（老 run / S3 读失败），而那种 run 照样要出现在对比里
 * 说清「这一块比不了，因为明细缺了」。明细按「同类型第几个」对上（两个数组同序
 * 同长，planrun.py:1101 `[_stage_summary(r) for r in stage_results]`）。
 */
export function compareStages(
  a: PlanRunDetail | null | undefined, b: PlanRunDetail | null | undefined,
  ctx: CompareCtx = {},
): StageCompare[] {
  const aSum = groupByType(reportStages(a));
  const bSum = groupByType(reportStages(b));
  const aDet = groupByType(reportStageDetails(a));
  const bDet = groupByType(reportStageDetails(b));

  const types: string[] = [...aSum.keys()];
  for (const t of bSum.keys()) if (!types.includes(t)) types.push(t);

  // 「数据集在较早那次 run 之后改过没有」只能用 A 的开跑时间比
  // （updated_at 是**最后一次**修改，早于 A 开跑就说明两次跑的是同一批用例）
  const aStartedMs = toMillis(a?.started_at);

  // 会话 → 用例的映射**按侧建**（各用自己 run 的回归明细）：拿一侧的索引去解另一
  // 侧的会话会全部落空，而落空长得跟「这次没跑这道题」一模一样。
  const idx = { a: sessionCaseIndex(a), b: sessionCaseIndex(b) };

  const out: StageCompare[] = [];
  for (const type of types) {
    const n = Math.max(aSum.get(type)?.length ?? 0, bSum.get(type)?.length ?? 0);
    for (let occ = 0; occ < n; occ++) {
      out.push(stageCompareOf(
        type,
        aDet.get(type)?.[occ] ?? null, bDet.get(type)?.[occ] ?? null,
        aSum.get(type)?.[occ] ?? null, bSum.get(type)?.[occ] ?? null,
        ctx, aStartedMs, idx,
      ));
    }
  }
  return out;
}

function stageCompareOf(
  type: string,
  aStage: StageDetail | null, bStage: StageDetail | null,
  aSummary: StageSummary | null, bSummary: StageSummary | null,
  ctx: CompareCtx, aStartedMs: number,
  idx: { a: SessionCaseIndex; b: SessionCaseIndex },
): StageCompare {
  const aUnits = unitsOf(aStage, idx.a);
  const bUnits = unitsOf(bStage, idx.b);
  const unitWord = UNIT_WORD[type] ?? "条目";
  const label = STAGE_LABEL[type] ?? type ?? "环节";
  const dataset = textOf(
    aStage?.report?.dataset ?? aStage?.dataset ?? aStage?.cases_dataset
    ?? bStage?.report?.dataset ?? bStage?.dataset ?? bStage?.cases_dataset
    ?? aSummary?.dataset ?? bSummary?.dataset ?? "",
  ).trim();

  const base = {
    type, label, unitWord, dataset,
  };

  const missing: StageCompare["missing"] = aUnits == null && bUnits == null ? "both"
    : aUnits == null ? "a" : bUnits == null ? "b" : null;
  if (missing) {
    const which = missing === "both" ? "两次运行都" : missing === "a" ? "上一次" : "这一次";
    return {
      ...base,
      pairs: [], counts: emptyCounts(), bothPass: 0, missing,
      missingText: `${which}没有可读的逐${unitWord}明细`,
      alignBy: type === "observe" ? "session" : "input",
      staleText: "",
    };
  }

  const av = dedupe(aUnits ?? []);
  const bv = dedupe(bUnits ?? []);
  // 整块的对齐依据取**下界**：只要有一条退化按名对齐，这一块的结论就带着那份
  // 不确定性，不许因为大多数条目有题面就宣称整块「按题面对齐」。
  const allByInput = [...av, ...bv].every((x) => x.byInput);
  // observe 的两档**不取下界**，取「有没有换到用例这一层」：混着落单是这一层的
  // 常态（窗口里必然有别的运行的会话），若按下界判就永远退回 session ——
  // 那正是本次要修的那个形态。ALIGN_TEXT.case 把退化那半写进了措辞里，
  // 落单的每一条另有自己的 whyUnaligned，不确定性没有被藏起来。
  const anyResolved = [...av, ...bv].some((x) => x.byInput);
  const alignBy: AlignBy = type === "observe" ? (anyResolved ? "case" : "session")
    : allByInput ? "input" : "name";

  const bByKey = new Map(bv.map((x) => [x.key, x]));
  const aKeys = new Set(av.map((x) => x.key));
  const aTitles = new Map<string, string[]>();
  for (const x of av) aTitles.set(x.title, [...(aTitles.get(x.title) ?? []), x.key]);
  const bTitles = new Map<string, string[]>();
  for (const x of bv) bTitles.set(x.title, [...(bTitles.get(x.title) ?? []), x.key]);

  const pairs: UnitPair[] = [];
  const slugs = new Map<string, number>();
  const withSlug = (title: string): string => {
    const s = slugify(title);
    const n = (slugs.get(s) ?? 0) + 1;
    slugs.set(s, n);
    return n === 1 ? s : `${s}-${n}`;
  };

  /**
   * 对不上时的原话。**同名不同题面**单独一句：那一条长得最像「同一条」
   * （名字一模一样），也最容易被读成三桶里的某一桶 —— 而事实是两次问的不是
   * 同一道题（用例名按位置派生，数据集改一次就错位）。
   */
  const whyOf = (side: "a" | "b", it: KeyedUnit): string => {
    // 这一条自己就知道为什么对不上（observe：抽样窗口 vs 别的运行的会话）——
    // 通用那两句都是「数据集改过」族的说法，套在会话上是编造成因
    if (it.whyUnaligned) return it.whyUnaligned;
    const other = side === "a" ? bTitles : aTitles;
    const sameName = (other.get(it.title) ?? []).filter((k) => k !== it.key);
    if (sameName.length > 0) {
      return `另一次也有叫「${it.title}」的${unitWord}，但${
        type === "redteam" ? "攻击目的" : "题面"}不同`;
    }
    return side === "a"
      ? `只有上一次有这个${unitWord}`
      : `只有这一次有这个${unitWord}`;
  };

  /** 收起态要印的那对数；只有分数桶用得上（见 UnitPair.scoreText）。
   *  两侧一律走 fmtScoreExact —— 0.9981 → 1.00 会让「涨了」那一桶里印出两个
   *  相同的数（现网就有这个形态），而这一行的全部作用就是给出差别。 */
  const scoreTextOf = (bucket: PairBucket, a: CompareUnit, b: CompareUnit): string => {
    if (bucket !== "scoreUp" && bucket !== "scoreDown") return "";
    const sa = unitScore(a);
    const sb = unitScore(b);
    return sa == null || sb == null ? "" : `${fmtScoreExact(sa)} → ${fmtScoreExact(sb)}`;
  };

  for (const it of av) {
    const mate = bByKey.get(it.key) ?? null;
    const bucket = bucketOf(it.unit, mate?.unit ?? null);
    pairs.push({
      key: it.key, title: it.title, slug: withSlug(it.title),
      sub: it.sub || mate?.sub || "",
      a: it.unit, b: mate?.unit ?? null,
      bucket,
      why: bucket === "unaligned" ? whyOf("a", it) : "",
      scoreText: mate ? scoreTextOf(bucket, it.unit, mate.unit) : "",
    });
  }
  for (const it of bv) {
    if (aKeys.has(it.key)) continue;
    pairs.push({
      key: it.key, title: it.title, slug: withSlug(it.title), sub: it.sub,
      a: null, b: it.unit, bucket: "unaligned", why: whyOf("b", it),
      scoreText: "",
    });
  }

  const counts = emptyCounts();
  let bothPass = 0;
  for (const p of pairs) {
    if (p.bucket === "bothpass") bothPass += 1;
    else counts[p.bucket] += 1;
  }
  return {
    ...base, pairs, counts, bothPass, missing: null, missingText: "", alignBy,
    staleText: staleDatasetText(alignBy, dataset, ctx, aStartedMs, unitWord),
  };
}

/**
 * 退化按名对齐时的警示横幅原话；不需要警示则空串。
 *
 * 条件三条**都要**满足：
 *   1. 这一块确实退化成了按名对齐（有题面就不必警示 —— 名字变了也照样对得上）；
 *   2. 拿到了这个数据集的 `updated_at`（list_datasets 原样带出，
 *      app/catalog.py:_dataset_from_item；拿不到 = 不判，绝不猜）；
 *   3. 最后一次修改**晚于较早那次运行的开跑时间** —— 早于它就说明两次跑的是
 *      同一批用例，按名对齐是可靠的。
 */
function staleDatasetText(
  alignBy: AlignBy, dataset: string, ctx: CompareCtx, aStartedMs: number, unitWord: string,
): string {
  if (alignBy !== "name" || !dataset) return "";
  const ds = (ctx.datasets ?? []).find((d) => d.name === dataset);
  const updated = typeof ds?.updated_at === "number" ? ds.updated_at * 1000 : null;
  if (updated == null || !Number.isFinite(aStartedMs) || updated <= aStartedMs) return "";
  return `数据集在两次运行之间有过修改，逐${unitWord}对齐可能失真`;
}

function emptyCounts(): Record<BucketKind, number> {
  return { fixed: 0, broken: 0, scoreUp: 0, scoreDown: 0, still: 0, noverdict: 0, unaligned: 0 };
}

/** 桶的展示名与说明（渲染层不再各写一份）。顺序即展示顺序：
 *  先答「修好了什么」（连同还没翻面但已经在涨的），再答「有没有副作用」（连同
 *  还没破线但已经在跌的），然后是老问题，最后两个说明桶。
 *  ⚠️ 好消息与坏消息各自挨着，而不是「三桶 + 两个新桶追加在后」：追加在后会让
 *  「分数跌了」出现在「仍失败」下面，读起来像是老问题的一个子类。 */
export const BUCKET_ORDER: BucketKind[] = [
  "fixed", "scoreUp", "broken", "scoreDown", "still", "noverdict", "unaligned",
];

export const BUCKET_LABEL: Record<BucketKind, string> = {
  // 「较上一次改进/退步」自带判据方向（用户 2026-08-30：桶名自解释；判据句
  // 连悬停都不留，整句删 —— 通用说明是文档不是界面）。原名「修好的/改坏的」
  // 得配一句解释才读得懂，等于名字没干活。
  fixed: "较上一次改进",
  scoreUp: "分数涨了",
  broken: "较上一次退步",
  scoreDown: "分数跌了",
  still: "仍失败",
  noverdict: "无判定",
  unaligned: "无法对齐",
};

/** 桶的语义色类（沿用既有 badge 语义类，不新造颜色令牌）。
 *  `scoreDown` 故意用 warn 而**不是** bad：这些用例两次都通过了，
 *  红要留给真的破了线的那一桶（改坏的）—— 同屏两种红会让「还得管」与
 *  「已经坏了」变成一个意思。 */
export const BUCKET_CLASS: Record<BucketKind, string> = {
  fixed: "ok", scoreUp: "ok", broken: "bad", scoreDown: "warn",
  still: "warn", noverdict: "", unaligned: "",
};

// ---------------------------------------------------------------------------
// 采纳追踪（评估分析页，ADR-0014 后果②：综合报告「当前优先建议」+ 采纳追踪迁到这里）
// ---------------------------------------------------------------------------
//
// 数据源 = 该计划各 run 的 `proposals`。**列表行上就带**：list_plan_runs 走
// planrun._run_from_item，它无条件写 `proposals` 与 `overview` 两键（只有
// list_recent_runs 的投影把这两块减掉了）—— 所以一张表看全计划的处方**不需要**
// 逐 run 拉 get_plan_run（那是逐条 S3 读）。
// ⚠️ 前端类型 PlanRunSummary（pages/plan/types.ts）没声明这两个键（本批白名单不含
// types.ts），这里用本地扩展类型读，进 JSX 前一律过 textOf。

/** 运行历史的一行，带 _run_from_item 那两个未在 PlanRunSummary 里声明的键。 */
export type RunWithProposals = PlanRunSummary & { proposals?: unknown; overview?: unknown };

export interface AdoptionRow {
  runKey: string;
  /** 该 run `proposals` 数组下标 = set_proposal_adopted 的 index */
  index: number;
  /** 这个计划的第 N 次运行（与运行历史表同一个排序函数产出；判不出为 null） */
  seq: number | null;
  summary: string;
  generatedAt: string;
  /** 空串 = 未采纳（后端未采纳时 adopted_at 是 null） */
  adoptedAt: string;
  /** 依据：adopt_run_advice 落库的引用行（「环节 · 行名」）；attach_proposal 的条目没有 */
  refs: string[];
  /** 排序键（未采纳组按它降序）：refs 条数 + 摘要里 LLM 点名的引用数。
   *  契约里没有「预计影响用例数」这个字段，用这个代，不新造后端字段。 */
  refCount: number;
  /** 采纳后效果：**之后**某次 run 的 overview.adoption_note.score_changes
   *  （后端只在上一次 run 有已采纳处方时写；按 summary 对回）。空数组 = 没有记录。 */
  effect: string[];
}

function proposalsOf(r: RunWithProposals): Record<string, unknown>[] {
  return Array.isArray(r.proposals)
    ? r.proposals.filter((p): p is Record<string, unknown> => p != null && typeof p === "object")
    : [];
}

/**
 * 全计划的处方 → 两组行：未采纳（按 refCount 降序，平局 run 新→旧、下标升）、
 * 已采纳（run 新→旧、下标升）。一条都没有 ⇒ 两组都空，调用方整块不画。
 *
 * `countRefs` 由调用方传（SynthesisText.synthesisRefs 的长度）：派生层不 import
 * 组件模块，引用正则只在渲染件那一份。
 */
export function adoptionRows(
  runs: RunWithProposals[],
  countRefs: (summary: string) => number,
): { pending: AdoptionRow[]; done: AdoptionRow[] } {
  const desc = sortRunsDesc(runs);
  const asc = [...desc].reverse();
  const seqOf = new Map(desc.map((r, i) => [r.run_key, desc.length - i] as const));

  /** 之后某次 run 写的采纳记录里对上这条摘要 ⇒ 那次的 score_changes */
  const effectOf = (fromIdx: number, summary: string): string[] => {
    for (let j = fromIdx + 1; j < asc.length; j++) {
      const note = adoptionNoteOf(asc[j] as unknown as PlanRunDetail);
      if (!note) continue;
      const hit = (note.proposals ?? []).some((p) => textOf(p?.summary).trim() === summary);
      if (hit) return (note.score_changes ?? []).map(textOf).filter((s) => s.trim() !== "");
    }
    return [];
  };

  const pending: AdoptionRow[] = [];
  const done: AdoptionRow[] = [];
  asc.forEach((r, i) => {
    proposalsOf(r).forEach((p, index) => {
      const summary = textOf(p.summary).trim();
      const refs = Array.isArray(p.refs) ? p.refs.map(textOf).filter((s) => s.trim() !== "") : [];
      const adoptedAt = textOf(p.adopted_at).trim();
      const row: AdoptionRow = {
        runKey: r.run_key, index, seq: seqOf.get(r.run_key) ?? null,
        summary, generatedAt: textOf(p.generated_at).trim(), adoptedAt, refs,
        refCount: refs.length + countRefs(summary),
        effect: adoptedAt ? effectOf(i, summary) : [],
      };
      (adoptedAt ? done : pending).push(row);
    });
  });
  const runOrder = new Map(desc.map((r, i) => [r.run_key, i] as const));
  const byRunDesc = (a: AdoptionRow, b: AdoptionRow) =>
    (runOrder.get(a.runKey) ?? 0) - (runOrder.get(b.runKey) ?? 0) || a.index - b.index;
  pending.sort((a, b) => b.refCount - a.refCount || byRunDesc(a, b));
  done.sort(byRunDesc);
  return { pending, done };
}

