// 展示口径单一来源（ADR-0003 及其 2026-08 修订的物理住所）。
//
// 两条正交口径，别混：
//   1. **有没有分**（isScored）—— 只认顶层 score / observe 环节 overall_mean。
//      「线上评估均分」「分数趋势」的样本闸门。dataset/redteam 没有可比的
//      连续分数，永远不进这里（绝不编造一个分数塞进均分和趋势图）。
//   2. **跑成功没有**（runOutcome）—— 按**环节**判定：有失败环节就不是
//      「完成」，有有效结果就不是「无可评估数据」。「成功运行数」「结果
//      badge」走这条。
//
// 此前只有口径 1，且被当成口径 2 用：顶层 score 只在存在 observe 环节
// overall_mean 时才写（planrun.py:_persist），于是**纯回归/纯红队方案的
// 顶层 score 必然为空** → 跑出 0.833 分的回归 run 全站显示「完成 · 无可
// 评估数据」、综合报告还写「本次评估管道空转」（UI-013）；同时环节
// stage.error 完全不参与终态，DDB 写超限炸掉的红队环节被显示成绿色
// 「完成」（UI-025）。修订见 docs/adr/0003-score-required-for-success.md。
//
// 口径 1 的第三次事故是 **schema 演化**（2026-08-21）：顶层 score 这个字段本身
// 是 8/22 才补写的，在那之前落库的 run 只有 observe 环节的 overall_mean —— 同
// 一个量两个住址，读侧只认新址，于是运行历史挂着 0.74–0.78 的分数、同页 hero
// 却说「还没有一次运行跑出线上评估分」（现网实拍 plan-c1202e599ada）。修法是
// 读侧兜底 effectiveScore（不回填旧数据），isScored 改用它；硬线未动。
//
// 消费点必须全部走本文件：任何一处单独放宽都会造成数字对不上（ADR-0003
// Consequences）。bigscreen 的 isScored/scoreOf **已收敛至此**（2026-08-25，
// bigscreen 批）：derive.ts 只剩再导出别名，原三条实现差——读序相反、多一条环节
// status==="completed" 过滤、不 round 4——均以本文件 effectiveScore 为准，
// 对刑与毛刺夹具见 tests/bigscreen-scoring-convergence.test.tsx。

// ---------- 分数样本口径 ----------

/** 结构化最小依赖：任何带 status/score 的 run 摘要都可用（RunRow /
 *  PlanRunSummary / recent_runs 行）。 */
export interface ScorableRun {
  status: string;
  score?: number | null;
}

/**
 * run 的**线上评估分**（能进均分/趋势的那个数），没有则 null。
 *
 * 为什么不能只读顶层 `score`：这一个量有**两个住址**，而新址是后加的。
 * 顶层 score 是 2026-08-22 才补进 planrun.py:_persist 的（见该处注释），
 * 8/19–8/21 落库的 run item **没有这个属性**（读路径 _run_from_item 把缺失
 * 补成 `score: null`，所以到前端的真形态是 null 而非 undefined），但同一个
 * 量的旧住所 —— observe 环节的 overall_mean —— 一直都在 stage_summaries 里。
 * 读侧只认新址的后果是同一页两个数打架（现网实拍 plan-c1202e599ada：运行
 * 历史六行都挂 0.74–0.78 的分数 badge，hero 同时写「线上评估均分 ——、本方案
 * 还没有一次运行跑出线上评估分」、趋势写「已有 0 次有分运行」）。
 *
 * 兜底是**读侧**的：旧数据一个字都不回填，这个兼容形态常驻。
 *
 * 算法逐字对齐后端 planrun.py:_persist 写顶层 score 那段，保证新老两址算出的
 * 就是同一个数：
 *   · 样本 = 所有 `type === "observe"` 且 `overall_mean != null` 的环节；
 *     **刻意不按环节 status 过滤** —— 后端那段也没有（它只按 type + 非 None）。
 *     两者等价：observe 环节只有两条返回路径（planrun.py:146 的 empty 不写
 *     overall_mean、:200 的 completed 才写），所以带分的 observe 必然
 *     completed。加一条 status 过滤看着更「稳」，实则是让前端算法与后端悄悄
 *     分叉（bigscreen/derive.ts scoreOf 就多了这条，见该处）。
 *   · 等权均值 + round 4（后端 `round(sum/len, 4)`）。round 用
 *     `Number(x.toFixed(4))`：4 位小数的二分位（k+0.5）不是二进制可表示数，
 *     所以 Python 的 banker's rounding 与 toFixed 的 half-away 永不分叉；
 *     而 `Math.round(x*1e4)/1e4` 会 —— 0.55555 在 Python/toFixed 都是
 *     0.5555，Math.round 给 0.5556。round 本身也是必要的：三个环节的均值
 *     `(0.8+0.9+0.7)/3` 原值是 0.8000000000000002。
 *   · run 级 `status === "completed"` 才出数（后端 `if _obs_means and
 *     status == "completed"`）。**停止/熔断/失败的 run 连顶层 score 都不认**
 *     ——后端那种 run 压根没写 score，若某条老数据里带着（或 mock 造出），
 *     它也只是「跑了一半的均值」，不是这次 run 的结论（scoring-stopped 的
 *     STOPPED_RUN 就是这个形态）。
 *
 * ⚠️ ADR-0003 硬线不松一个字：只认 observe。dataset 的 pass_rate、redteam 的
 * breached/attacks 量纲不同，纯回归/纯红队 run 在这里恒 null（它们照样可以是
 * 成功的 —— 那是 runOutcome 的事）。
 */
export function effectiveScore(r: ScorableRun & StagedRunLike): number | null {
  if (r.status !== "completed") return null;
  if (typeof r.score === "number") return r.score;
  const means = (r.stage_summaries ?? [])
    .filter((s) => s.type === "observe" && s.overall_mean != null)
    .map((s) => s.overall_mean as number);
  if (!means.length) return null;
  return Number((means.reduce((a, b) => a + b, 0) / means.length).toFixed(4));
}

/** 「有分数」= completed 且能拿到线上评估分（effectiveScore 非空 —— 顶层
 *  score，或 8/21 之前那批老 run 的 observe 环节 overall_mean，见该函数）。
 *
 *  ⚠️ 这**不是**「成功」口径（那是 runOutcome / isRunSuccess）。分数语义是
 *  「observe 环节均分」（顶层 score 由 planrun.py 只在存在 observe
 *  overall_mean 时写入），所以它只回答「这个 run 能不能进线上评估均分/趋势」。
 *  纯回归、纯红队 run 在这里恒为 false，而它们可以是成功的。
 *
 *  收敛前两份实现的判空写法不同（kpi.ts `!= null` vs derive.ts
 *  `typeof === "number"`）；契约里 score 只会是 number 或 null/缺省，
 *  二者等价，统一取更严格的 typeof 判断（effectiveScore 内那一行）。 */
export function isScored(r: ScorableRun & StagedRunLike): boolean {
  return effectiveScore(r) != null;
}

// ---------- 环节口径（run 终态判定的原料） ----------

/**
 * stage_summaries 元素的最小形状 —— 逐字照后端 planrun.py:_stage_summary
 * （DDB 里的真形态，也是 list_plan_runs / list_recent_runs / get_plan_run
 * 三条读路径的共同形态）：
 *
 *     out = {"type": res["type"], "status": res.get("status")}
 *     if res.get("error"): out["error"] = str(res["error"])[:300]
 *     observe → overall_mean / sessions / summary
 *     dataset → pass_rate / cases / blank_cases
 *     redteam → breached / attacks / verdict
 *
 * status 取值：completed | error | empty | halted_cost | stopped。
 * **empty 是「执行成功但没东西可评」**（observe 环节回溯窗口内没有会话，
 * planrun.py:139），不是失败——它继续落在 no-data 侧。error 才是执行失败
 * （含 stage 级 except 兜底、DDB 写超限等）。
 * **halted_cost 是成本熔断**：实际成本超过预估的 COST_CIRCUIT_FACTOR 倍时后端
 * 主动掐掉这一环（testrun.py:810 / redteam.py:753,767）。它落**失败侧**——剩下
 * 的用例一个都没测，半截数字不是结论；但文案要与崩溃区分（见 runOutcome）。
 * **stopped 是用户主动停止**（testrun.py:48 STOP_STATUS，说明由 `_stop_note`
 * 写在 error 上）。run 级由 status 直接接管（runOutcome 对非 completed 走
 * status 分支 → 琥珀「已停止」），所以它不经过 isStageFailed；环节**行**的
 * 展示分档在 pages/plan/derive.ts 的 stageKind（stopped 与 failed 分开，
 * 免得 run 级琥珀、环节行猩红）。
 */
export interface StageLike {
  type?: string;
  /** completed | error | empty | halted_cost | stopped */
  status?: string;
  error?: string | null;
  /** observe */
  overall_mean?: number | null;
  /** dataset */
  pass_rate?: number | null;
  /** redteam：attacks 是「跑了几次攻击」，breached=0 是合法结果不是无数据 */
  attacks?: number;
  breached?: number;
  // ⚠️ 刻意**不加** `[k: string]: unknown` 索引签名：加了之后各页自己的
  // StageSummary/RunStage（都没有索引签名）就无法赋值给它，
  // isStageFailed(s) 之类调用会在编译期报 TS2345。判定只需上面这几个键，
  // 其余字段（summary/verdict/sessions…）由各页类型自己声明。
}

export interface StagedRunLike {
  stage_summaries?: StageLike[];
}

/** 环节展示名（术语五词不可变更）。
 *  **全站唯一权威**（ADR-0003 口径单一来源，domain-r1 D-6 定案）：此前七个页面
 *  各养一份同型副本，改一个术语要追七处。三类映射一律 import 这里，别再抄。
 *  例外只有 PlanEditor.STAGE_UI_LABEL —— 那是 UI 四类（含只存在于表现层的
 *  「模拟测试」），另一个维度，不是本表的副本。 */
export const STAGE_LABEL: Record<string, string> = {
  observe: "线上评估",
  dataset: "回归测试",
  redteam: "红队测试",
};

export function stageLabel(type: string | null | undefined): string {
  return STAGE_LABEL[type ?? ""] ?? type ?? "环节";
}

/** 环节是否执行失败：status=error / halted_cost，或带 error 文本。
 *  后端两条路径都要兜——stage 级 except 写 {status:"error", error:…}，
 *  而 empty 环节也带 error 文本（「最近 30 天没有可评估的会话」），
 *  所以 empty 必须先出局，否则会把「没数据」误判成「执行失败」。
 *
 *  halted_cost 必须**按 status 显式判**，不能指望它的 error 文本：熔断留痕是
 *  本批（2026-08-24）才补的，在那之前落库的熔断环节只有 status 没有 error，
 *  靠文案判会让那些 run 继续显示「完成 · 无可评估数据」——正是本缺陷的形态。 */
export function isStageFailed(s: StageLike): boolean {
  if (s.status === "empty") return false;
  return s.status === "error" || s.status === "halted_cost" || Boolean(s.error);
}

/**
 * 环节是否产出了**有效结果**（= 这一环真评到了东西）。
 *
 * 按 type 分叉，字段与后端 _stage_summary 一一对应：
 *   - observe：completed 且 overall_mean 非空
 *   - dataset：completed 且 pass_rate 非空（0 也算——0% 通过是结论不是空）
 *   - redteam：completed 且 attacks > 0（**不看 verdict**：真后端
 *     verdict 可能是 INCONCLUSIVE，甚至缺省/null；breached=0 是「全部
 *     抵御」这一合法结果，不是无数据）
 * 未知 type：保守认「无有效结果」，不替后端瞎猜。
 *
 * `status !== "completed"` 这一条同时管住熔断：halted_cost 环节的 pass_rate /
 * attacks 只覆盖被掐掉之前那一小截（8 个用例跑了 3 个），当成有效结果就会把
 * 「通过率 100%」印成一次完整成功的回归。这条**不许**为熔断放宽。
 */
export function isStageEffective(s: StageLike): boolean {
  if (s.status !== "completed") return false;
  switch (s.type) {
    case "observe": return s.overall_mean != null;
    case "dataset": return s.pass_rate != null;
    case "redteam": return (s.attacks ?? 0) > 0;
    default: return false;
  }
}

// ---------- run 终态口径（按环节判定） ----------

/** run 终态的四类语义（在 status 之上叠加环节信息） */
export type RunOutcomeKind =
  /** 非终态/无需环节判定：running / skipped，以及后端已判 error 的 run */
  | "status"
  /** 全部有效环节都成功，且至少有一个产出有效结果 */
  | "ok"
  /** 有环节失败，但也有环节产出了有效结果 */
  | "partial"
  /** 所有环节都失败（一个有效结果都没有） */
  | "failed"
  /** 执行没错但没评到东西（环节全 empty / 无环节，且**没有**环节失败——
   *  有失败会先落 partial/failed，见 runOutcome 的判定优先级）。
   *  报告抽屉的「本次评估管道空转」提示条只在这一类出现
   *  （ReportDrawer.tsx 直接判 `outcome.kind === "nodata"`）。 */
  | "nodata";

export interface RunOutcome {
  kind: RunOutcomeKind;
  /** badge class（既有语义类，不新造颜色令牌） */
  cls: string;
  /** badge 文案 */
  label: string;
  /** 失败环节的展示名（partial/failed 时非空，用于「部分失败 · 红队测试」） */
  failedStages: string[];
  /** 是否算「成功运行」（成功运行数 KPI 的闸门）：ok / partial 算，
   *  failed / nodata / 非 completed 不算。部分失败仍算成功运行——
   *  它确实产出了可用结果，只是不完整；badge 会明说哪一环炸了。 */
  success: boolean;
}

/**
 * run 终态判定。**判定优先级不可调换**：
 *
 *   1. 非 completed（running / skipped / error）→ 直接走 status
 *      （后端已经判了 error 的 run 不需要再看环节）
 *   2. 有 error 环节 → 「失败」或「部分失败」（UI-025）
 *   3. 有有效结果环节 → 「完成」（UI-013：纯回归/纯红队在这里被救回来）
 *   4. 都没有 → 「完成 · 无可评估数据」（环节全 empty / 无环节）
 *
 * 反过来先判 no-data 会让炸掉的 run 继续显示「完成 · 无可评估数据」，
 * 正是 UI-025 抱怨的形态。
 *
 * **退化路径**（必须保留）：老归档 run 的 DDB item 可能整个没有
 * stage_summaries（或读出空数组，如 record_skipped_run 写的 "[]"）。此时
 * 无从判环节，退回旧行为看顶层 score：有分 → 「完成」，无分 →
 * 「完成 · 无可评估数据」。绝不因为拿不到环节就把 run 判成 no-data 之外的
 * 新状态，也绝不把有分的老 run 判成失败。
 */
export function runOutcome(run: ScorableRun & StagedRunLike): RunOutcome {
  const statusOutcome = (): RunOutcome => ({
    kind: "status",
    cls: statusBadgeClass(run.status),
    label: STATUS_LABEL[run.status] ?? run.status,
    failedStages: [],
    success: false,
  });

  if (run.status !== "completed") return statusOutcome();

  const stages = run.stage_summaries ?? [];
  if (stages.length === 0) {
    // 退化：无环节信息 → 旧口径（顶层 score）
    if (typeof run.score === "number") {
      return { kind: "ok", cls: "badge ok", label: "完成", failedStages: [], success: true };
    }
    return { kind: "nodata", cls: "badge", label: "完成 · 无可评估数据", failedStages: [], success: false };
  }

  const failed = stages.filter(isStageFailed);
  const effective = stages.filter(isStageEffective);
  const failedStages = failed.map((s) => stageLabel(s.type));
  // badge 文案里给成本熔断加后缀：它是**刻意止损**（超预算，平台主动掐掉），
  // 不是 agent 崩了。折叠进普通「失败 · 回归测试」会把人送去查 agent，而真实
  // 动作是调预估/预算。failedStages 本身保持纯环节名——ReportDrawer.tsx:436 与
  // exportReport.ts:145 把它 join 进「<环节>环节执行失败。」这句话，加括号成病句。
  const badgeStages = failed
    .map((s) => stageLabel(s.type) + (s.status === "halted_cost" ? "（成本熔断）" : ""))
    .join(" · ");

  if (failed.length > 0) {
    if (effective.length > 0) {
      return {
        kind: "partial",
        cls: "badge warn",
        label: `部分失败 · ${badgeStages}`,
        failedStages,
        success: true,
      };
    }
    return {
      kind: "failed",
      cls: "badge bad",
      label: `失败 · ${badgeStages}`,
      failedStages,
      success: false,
    };
  }

  if (effective.length > 0) {
    return { kind: "ok", cls: "badge ok", label: "完成", failedStages: [], success: true };
  }
  return { kind: "nodata", cls: "badge", label: "完成 · 无可评估数据", failedStages: [], success: false };
}

/** 「成功运行」= 环节判定下产出了有效结果（含部分失败）。
 *  与 isScored 的区别见该函数注释：这条不要求有分数。 */
export function isRunSuccess(run: ScorableRun & StagedRunLike): boolean {
  return runOutcome(run).success;
}

/**
 * badge 旁的真实指标（mono chip 文案），按环节给**后端真给了的数字**：
 *   observe → "0.83"（overall_mean，退回顶层 score）
 *   dataset → "通过率 100%"（pass_rate）
 *   redteam → "攻破 0/12"（breached/attacks —— 同时表达攻破率与安全结果，
 *              与报告抽屉环节行 stageNumbers 同格式）
 *
 * 只列产出了有效结果的环节；一个都没有 → 空数组（调用方什么都不画）。
 * 非 completed 的 run（running / skipped / error）恒为空——跳过的 run 挂着
 * 指标 chip 会读成「跳过 · 0.86」这种自相矛盾的话。
 * **绝不为 dataset/redteam 合成一个「总分」**——那会污染均分与趋势
 * （UI-013 硬线：放宽的是「算不算成功」，不是「有没有分」）。
 */
export function runMetricChips(run: ScorableRun & StagedRunLike): string[] {
  if (run.status !== "completed") return [];
  const stages = run.stage_summaries ?? [];
  if (stages.length === 0) {
    return typeof run.score === "number" ? [fmtScore(run.score)] : [];
  }
  const out: string[] = [];
  for (const s of stages) {
    if (!isStageEffective(s)) continue;
    if (s.type === "observe") out.push(fmtScore(s.overall_mean));
    else if (s.type === "dataset") out.push(`通过率 ${fmtPctInt(s.pass_rate as number)}`);
    else if (s.type === "redteam") out.push(`攻破 ${s.breached ?? 0}/${s.attacks ?? 0}`);
  }
  return out;
}

// ---------- 红队攻破口径 ----------

/** 红队攻破数：run 内 completed redteam 环节 breached 求和；
 *  无（completed 的）红队环节 → null（「没测」≠「0 次攻破」）。
 *  口径与大屏一致（原 bigscreen/derive.ts breachOf，收敛至此）。 */
export function breachOf(r: StagedRunLike): number | null {
  const st = (r.stage_summaries ?? []).filter(
    (s) => s.type === "redteam" && s.status === "completed",
  );
  if (!st.length) return null;
  return st.reduce((a, s) => a + (s.breached ?? 0), 0);
}

// ---------- 时间解析 ----------

/**
 * started_at（epoch 秒或 UTC 时间字符串）→ 毫秒时间戳；解析失败返回 NaN。
 *
 * 收敛前有两套语义：
 *   - kpi.ts / bigscreen 的 parseUtc：失败回 NaN；
 *   - plan/derive.ts 的 toMillis：失败回 0（为了排序时「排最旧」）。
 * 统一选 NaN：0 是合法时间戳（1970-01-01T00:00Z），用它表示「解析失败」
 * 会把失败混进正常数据；NaN 在 Number.isFinite 过滤、isNaN 检查、
 * `!ms` 判断里都天然出局。需要「失败排最旧」语义的排序调用方自行
 * `toMillis(v) || 0`（见 plan/derive.ts sortRunsDesc）。
 *
 * 字符串形态兼容三种输入：
 *   - `"YYYY-MM-DD HH:mm[:ss] UTC"` —— **后端所有 run 时间戳的真形态**
 *     （planrun.py/testrun.py/redteam.py 一律 strftime("%Y-%m-%d %H:%M UTC")）；
 *   - `"YYYY-MM-DD HH:mm[:ss]"`（无后缀，旧归档/部分接口）；
 *   - 含 "T" 的 ISO 串（带不带时区照原样交给 Date.parse）。
 *
 * " UTC" 后缀必须**显式剥离**再拼 "T…Z"。此前这里只判 `v.includes("T")`，
 * 带后缀的真形态之所以解析正确纯属巧合——"UTC" 里恰好有个大写 T 让分支为
 * true，然后靠 V8 对 `"2026-08-11 09:00 UTC"` 的宽松解析兜住。一旦后端把
 * 后缀改成 "%Y-%m-%d %H:%M Z"（或去掉 UTC），includes("T") 转 false →
 * 拼成 `"2026-08-11T09:00 UTCZ"` → NaN → 趋势图恒空、24h 窗口恒空、
 * KPI 全 "—"。mock 此前全部不带后缀，这条巧合路径从未被测到。
 */
export function toMillis(v: string | number | null | undefined): number {
  if (v == null || v === "") return NaN;
  if (typeof v === "number") return v * 1000;
  const s = v.replace(/\s*UTC$/i, "").trim();
  if (!s) return NaN;
  return Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
}

/** UTC "YYYY-MM-DD HH:mm" → epoch ms；解析失败返回 NaN（toMillis 的字符串特例，
 *  保留独立名字给只处理该形态的调用方/测试用） */
export function parseUtc(s: string): number {
  return toMillis(s);
}

// ---------- 展示格式化 ----------

/** 0.8234 → "0.82"；无分 → "—"。（resources/rubric.ts 的 fmtScore 语义不同
 *  ——rubric 分数是 1~5 整数刻度——不收敛到这里。） */
export function fmtScore(score: number | null | undefined): string {
  return typeof score === "number" ? score.toFixed(2) : "—";
}

/** 0.8234 → "0.82"（两位**向下取整**）；无分 → "—"。
 *
 *  只供「数值与阈值结论并排显示」的位置使用（threshold-adjacent-precision
 *  口径改裁 · 方案 c，当前 = 大屏三处并置点）：判定精度是四位
 *  （effectiveScore round4），fmtScore 的 toFixed(2) 四舍五入会让
 *  s ∈ [0.695, 0.70) 显示「0.70」而同屏结论说低于 0.70。floor 让矛盾在数学上
 *  不可能（低于阈值的值永远显示不出阈值本身）；副作用（0.6999 → 0.69，恒不
 *  高估）方向诚实，是裁定接受的。**全站其余消费点仍用 fmtScore，别迁**。
 *
 *  前提刹车：阈值本身能用两位表达（0.70 恰是两位）。将来若出现 0.705 类
 *  三位阈值，两位显示表达不了与它的比较关系，此函数须随判定精度加位。
 *
 *  实现绕二进制边界（裸 Math.floor(x*100)/100 会踩）：0.29*100 ===
 *  28.999999999999996 会把 0.29 印成 0.28。floor 后用 (n±1)/100 与原值按
 *  double 本身回比校正 —— 阈值判定用的也是这个 double，显示与判定同源。
 *  负数走向 -∞（-0.005 → "-0.01"，仍是恒不高估方向）。 */
export function fmtScoreFloor(score: number | null | undefined): string {
  if (typeof score !== "number") return "—";
  let n = Math.floor(score * 100);
  if ((n + 1) / 100 <= score) n += 1; // 下漂校正：x*100 被压到整数下方（0.29 型）
  else if (n / 100 > score) n -= 1; // 上漂校正：floor 结果不许高于原值
  return (n / 100).toFixed(2);
}

/**
 * 0.9981 → "0.998"、1 → "1.00"、0.8222 → "0.82"；无分 → "—"。
 *
 * 两位四舍五入之外**只在端点加位**。理由与 fmtScoreFloor 同族（显示不许跨过一条
 * 结论线），只是这里的线是**满分与零分**：
 *   · fmtScore(0.9981) === "1.00" —— 读者读到的是「满分 / 一个都没扣」，而事实是
 *     有扣分（现网 run₂ 的线上评估均分正是 0.9981，对比页两栏因此都印 1.00，
 *     「涨了多少」与「到顶了没有」两个问题一起读错）；
 *   · fmtScore(0.0001) === "0.00" 同形反向 —— 「零分」是「评了且全错」的结论，
 *     不许由舍入产生（空响应那族本就有一条「0 字节不是 0 分」的硬线）。
 * 端点之外一律与 fmtScore 逐字相同（0.8222 → "0.82"），所以列宽只在真到端点边上
 * 才变长 —— 代价换的是那一格不说谎。
 *
 * 加位到**刚好脱离端点**为止（0.9981 → "0.998"，0.99995 → "0.9999"），上限六位
 * （判定精度是四位，六位是纯保险）。精确的 1 / 0 照旧印 "1.00" / "0.00"：它们
 * 就是满分与零分本身。
 *
 * **全站其余消费点仍用 fmtScore，别迁** —— 与 fmtScoreFloor 同一条裁定。
 */
export function fmtScoreExact(score: number | null | undefined): string {
  if (typeof score !== "number") return "—";
  for (let d = 2; d <= 6; d++) {
    const t = score.toFixed(d);
    const n = Number(t);
    // 端点是结论性读数：不精确等于 1 / 0 的值，显示上不许落到 1 / 0
    if ((n === 1 && score !== 1) || (n === 0 && score !== 0)) continue;
    return t;
  }
  return score.toFixed(6);
}

// ---------- 百分数排版（两档，按分母的量级选，全站唯一实现） ----------
//
// 收敛前有六份裸写 `${Math.round(v*100)}%` 与一份带守卫的一位小数版
// （pages/agents/home/derive.ts），互不知道对方存在。分档规则写在两个函数的注释里
// ——「哪一档」由**量的分母**决定，不由页面决定：同一个量在两个 tab 上印出不同
// 精度是缺陷（现网仍有两处，见下）。

/**
 * 比率 → 百分数**一位小数**（0.018 → "1.8%"）；null / 非有限数 → "—"。
 *
 * **分母是会话量级的观测比率**走这一档：空响应率 / 工具调用失败率 / 异常率 /
 * 拓扑主路占比。现网这些值落在 0.4%~2.3%（fleet_status 的真实量级），整数档会把
 * 0.4% 与 0.6% 一起压成 "0%"/"1%"，量级信息全丢 —— 这几个数正是「有没有变差」
 * 的唯一读数，压掉一位就读不出来了。
 *
 * **通过率 / 拦截率那族走 fmtPctInt**（分母是用例或攻击条数）。
 */
export function fmtPct(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * 比率 → 百分数**整数**（0.9 → "90%"）；null / 非有限数 → "—"。
 *
 * **分母是小整数计数的比率**走这一档：dataset 通过率（分母 = 用例数）、逐评估器
 * 通过率（分母 = 判定会话数）、红队拦截率（分母 = 攻击数）。现网这些分母是 10~50
 * 的量级 ⇒ 一位小数印的是**分辨率里不存在的位**（10 条用例的通过率只可能是 10%
 * 的倍数，印 "90.0%" 是假精度）。
 *
 * 舍入用 Math.round（与收敛前六处裸写逐字同），不做 floor：这一档不与阈值结论
 * 并排（那条裁定在 fmtScoreFloor，管的是 0-1 分不是百分数）。
 */
export function fmtPctInt(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${Math.round(rate * 100)}%`;
}

/** 秒 → "74" → "1m14s"、"59" → "59s"；无值 → "—"。
 *  先把总秒数取整再分支/拆位：分钟 floor、秒位 round 各自为政时，
 *  s%60 ∈ [59.5, 60) 会渲染出不存在的「1m60s」（119.6 → 1m60s，应为 2m0s），
 *  <60 分支的 59.6 也会取整成「60s」——同一条进位带（issue
 *  duration-format-minute-carry）。秒位是否补零与 RunDetailPage.fmtDur 的
 *  差异是刻意的（那边有注释），别互抄。 */
export function fmtDuration(s: number | null | undefined): string {
  if (typeof s !== "number") return "—";
  const t = Math.round(s);
  return t >= 60 ? `${Math.floor(t / 60)}m${t % 60}s` : `${t}s`;
}

// ---------- 运行结果 badge ----------

// 后端 run 级 status 的全集（缺一项就把英文枚举原样印给用户——runOutcome 的
// `?? run.status` 兜底不会报错，只会在界面上露出 "halted_cost"）：
//   completed / error / running / skipped（planrun.py）
//   halted_cost —— 成本熔断中止（testrun.py:810 / redteam.py:753,767）
//   failed      —— run 级执行失败（redteam.py:772，与 planrun 的 error 同义）
//   stopped     —— 用户主动请求停止（testrun.py STOP_STATUS，planrun/redteam 同取
//                  该常量）。run 上另有一句中文说明落在 error 字段
export const STATUS_LABEL: Record<string, string> = {
  completed: "完成",
  error: "失败",
  skipped: "跳过",
  running: "运行中",
  halted_cost: "成本熔断中止",
  failed: "失败",
  stopped: "已停止",
};

/** 结果 badge 的语义类：completed→ok / error+failed→bad /
 *  skipped+halted_cost+stopped→warn / 其它中性。
 *  熔断与「跳过」同刑（warn 而非 bad）：它是主动止损的结果，产出通常是半截而
 *  不是空，用红色会读成「跑挂了」。用户主动停止同刑，理由一样（而且那个动作
 *  是用户自己刚做的，红色会让他去查自己的 agent）。 */
export function statusBadgeClass(status: string): string {
  switch (status) {
    case "completed": return "badge ok";
    case "error": return "badge bad";
    case "failed": return "badge bad";
    case "skipped": return "badge warn";
    case "halted_cost": return "badge warn";
    case "stopped": return "badge warn";
    case "running": return "badge run";
    default: return "badge";
  }
}

/**
 * 运行结果 badge（class+label）—— runOutcome 的展示投影，全站唯一实现。
 *
 * 五态（ADR-0003 修订后口径）：
 *   完成                      环节全成功且有有效结果（含纯回归/纯红队）
 *   部分失败 · <失败环节>      有环节炸了，但也有环节评到了东西（warn）
 *   失败 · <失败环节>          所有环节都炸了（bad）
 *   完成 · 无可评估数据        执行没错但没东西评（环节全 empty）——中性
 *   失败/跳过/运行中           非 completed 的 run 走后端 status
 *
 * 成本熔断不新增第六态：熔断的**环节**落上面的 部分失败/失败 两态，只在环节名
 * 后带「（成本熔断）」；熔断的**整个 run**（单跑的回归/红队）是非 completed，
 * 走 status 那一行，文案见 STATUS_LABEL.halted_cost。
 */
export function runBadge(run: ScorableRun & StagedRunLike): { cls: string; label: string } {
  const o = runOutcome(run);
  return { cls: o.cls, label: o.label };
}

/**
 * 陈旧 running 的展示态（UI-029 批 3）：后端读侧判定这条 running 的执行进程已经
 * 停了（`app/stalecheck.py:is_stale` 三级判据，`_run_from_item` 附 `stale: true`），
 * 而 **status 仍是 running** —— 改判落库归 reaper（`reap_stale_runs` 定时扫描），
 * 前端只显示。判据前端零实现：只消费那个布尔。
 *
 * 为什么**不进** STATUS_LABEL / statusBadgeClass 那两张表：它不是后端的 run
 * status（全集见上面那份注释）。塞进去会把 ADR-0003 定型的五态变成六态，并让每个
 * 读 STATUS_LABEL 的地方多出一个后端永不发送的枚举。所以这里只加一条**展示投影**，
 * 既有两张映射一行不改（消费点自己在 status==="running" && stale 时选用它）。
 *
 * warn 而不是 bad：这次运行真花过钱、可能还留着半截成果，而且只是**疑似**
 * （后端判据宁可漏判不误判）—— 错误红会让用户先去查自己的 agent。与
 * stopped / skipped / halted_cost 同刑，理由同款。
 */
export const STALE_RUNNING_BADGE: { cls: string; label: string } =
  { cls: "badge warn", label: "疑似中断" };
