// 大屏推导层（纯函数，测试直接盯这里）。
// 口径权威 = ui-prototypes/dashboard-bigscreen/index.html 的推导层，与
// web/src/pages/workbench/kpi.ts 同宗，且**终态判定与全站共用**
// lib/scoring.ts 的 runOutcome（ADR-0003 及其 2026-08 修订）：
//   - 「有没有分」（isScored / scoreOf）：只认 observe，喂均分与趋势；
//   - 「跑成功没有」（outcomeOf / isRunSuccess）：按环节判定，喂计数、
//     run 格子、Agent 标签、事件侧栏。
// 分数已收敛到 lib/scoring 的 effectiveScore/isScored（2026-08-25，单一住所，
// 与后端 planrun.py:_persist 逐字同刑）：本地 scoreOf 三条实现差——读序相反 /
// 多一条环节 status 过滤 / 不 round4——均为有意收敛，行为以 effectiveScore 为准
// （对刑与毛刺夹具在 tests/bigscreen-scoring-convergence.test.tsx）。
// isNoScore 与失败判定同样委托 runOutcome。
// 当前行为（UI-025 修复 + D-3 统一措辞之后）：环节 error（如 DDB 写超限）的
// completed run 走 runOutcome 判 failed / partial —— Agent 卡转红、事件侧栏出
// 「运行失败」或「部分失败 · <环节>」并带上 stage.error 原文；只有**真的一个
// 有效结果都没有**的 run 才落中性态，且措辞全站统一成「无可评估数据」
// （NO_SCORE_TEXT，不再叫「未计分」）。UI-025 当时的错法是 isNoScore 只看
// 「推不出任何指标」，环节炸掉的 run 因此在大屏上显示成绿色/中性态。
import {
  breachOf, effectiveScore, isRunSuccess, isScored, isStageFailed, parseUtc,
  runOutcome, type RunOutcome,
} from "../../lib/scoring";
import type { Plan } from "../../lib/apiTypes";
import type { BigscreenRun, StageSummary } from "./types";

// breachOf 已收敛到 lib/scoring.ts（工作台红队 KPI 同口径）；再导出保住既有消费点
export { breachOf };

/** 30s 轮询周期（TanStack refetchInterval） */
export const REFRESH_MS = 30_000;
/** 陈旧判定：超 2 个周期无成功更新 → 数据已停止 */
export const STALE_AFTER_MS = REFRESH_MS * 2;

export interface StaleInfo {
  stale: boolean;
  /** 停止更新的分钟数（stale 时 ≥ 1） */
  minutes: number;
}

/** 数据陈旧保护：拉取失败或超 2 个周期无更新 → 顶条转灰 + 停止更新提示。
    lastUpdated=null（从未成功）只在出错时算陈旧——冷启动的加载中不该报警。 */
export function deriveStale(
  now: number,
  lastUpdated: number | null,
  isError: boolean,
): StaleInfo {
  const sinceMs = lastUpdated != null ? now - lastUpdated : null;
  const stale = isError
    ? true
    : sinceMs != null && sinceMs > STALE_AFTER_MS;
  if (!stale) return { stale: false, minutes: 0 };
  const minutes = sinceMs != null ? Math.max(1, Math.floor(sinceMs / 60_000)) : 1;
  return { stale: true, minutes };
}

function stagesOf(r: BigscreenRun): StageSummary[] {
  return r.stage_summaries ?? [];
}

/** 失败环节的错误文本。取**第一个失败环节**的 error，而不是 stages[0]
 *  ——三环节方案里炸的常常是最后一环（红队），读 stages[0] 会显示成
 *  「未知错误」。empty 环节的 error 文本（「没有可评估的会话」）不算失败，
 *  由 isStageFailed 排除。 */
function firstStageError(r: BigscreenRun): string | null {
  const s = stagesOf(r).find(isStageFailed);
  return s?.error ?? null;
}

/** observe 综合分 —— lib/scoring.effectiveScore 的再导出别名（既有消费点保留
 *  scoreOf 这个名字，实现单一住所）：顶层 score 优先，缺失时兜底 observe 环节
 *  overall_mean 均值 round4，与后端 _persist 逐字同刑；无有效值 → null。 */
export { effectiveScore as scoreOf };

/** dataset 通过率：run 内所有 completed dataset 环节 pass_rate 的均值 */
export function passRateOf(r: BigscreenRun): number | null {
  const v = stagesOf(r)
    .filter((s) => s.type === "dataset" && s.status === "completed" && s.pass_rate != null)
    .map((s) => s.pass_rate as number);
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export function attacksOf(r: BigscreenRun): number {
  return stagesOf(r)
    .filter((s) => s.type === "redteam" && s.status === "completed")
    .reduce((a, s) => a + (s.attacks ?? 0), 0);
}

/** 「有分数」= completed 且能推出 observe 分（lib/scoring.isScored 再导出，
 *  与工作台同口径）。
 *  ⚠️ 不是「成功」口径：纯回归/纯红队 run 在这里恒 false（见 isRunSuccess）。 */
export { isScored };

/** run 终态（全站唯一实现）。大屏的 run 摘要形状与 planrun.py 的
 *  stage_summaries 一致，可直接喂 runOutcome。 */
export function outcomeOf(r: BigscreenRun): RunOutcome {
  return runOutcome(r);
}

/** 「跑成功没有」= 按环节判定产出了有效结果（含部分失败）。 */
export { isRunSuccess };

/** completed 但一个环节都没产出有效指标 → 无可评估数据（空响应/内容过滤）。
 *  委托 runOutcome：环节 error 的 run 落 partial/failed，**不再**被算成
 *  这一档（UI-025：那会让炸掉的 run 混进琥珀色的良性分段里）。 */
export function isNoScore(r: BigscreenRun): boolean {
  return runOutcome(r).kind === "nodata";
}

/**
 * 这一档的**大屏措辞**（D-3）：与全站同词。
 *
 * 权威是 lib/scoring.runOutcome 的 nodata label「完成 · 无可评估数据」——
 * 大屏字号紧、位置窄，只取词，不带「完成 · 」前缀，所以这里是一份**手写副本**。
 * 对刑断言在 tests/d-display-terms.test.tsx：权威 label 必须**含**这个词
 * （权威哪天改词，那条测试会点名这份副本）。
 *
 * 改词而不是改判定：判定早就是同一个 runOutcome。旧词「未计分」的字面含义
 * 覆盖了纯回归 run（它们也没分，却不是 nodata），会把「为什么没有分」的困惑
 * 从方案详情搬到挂墙的大屏上 —— 同一批人同一天会看到这两块屏。
 */
export const NO_SCORE_TEXT = "无可评估数据";

// ---------- KPI 带 ----------
export interface BigscreenKpi {
  avg: number | null;
  avgN: number;
  /** 环比：近 24h 均分 vs 前 24h 均分（同期均值对同期均值）；任一窗口无样本 → null */
  delta: number | null;
  runs24: number;
  /** 完成（按环节判定全部环节都好且有有效结果）——**不再是「有分数」**：
   *  纯回归/纯红队 run 此前既不在 ok24 也不在 noscore24，分段条恒少几段
   *  （12 次运行只画出 8 段），正是 UI-013 的数字表现。 */
  ok24: number;
  /** 失败：顶层 status=error **或** 所有环节都炸了（UI-025） */
  err24: number;
  /** 部分失败：有环节炸了但也有环节评到了东西（UI-025 新增分段） */
  partial24: number;
  noscore24: number;
  running24: number;
  skip24: number;
  passRate: number | null;
  passN: number;
  dsErr: number;
  /** 近 24h 红队攻破合计；24h 内无红队 run → null */
  breach: number | null;
  attacks: number;
}

export function deriveKpi(
  runs: BigscreenRun[] | undefined,
  plans: Plan[] | undefined,
  now: number = Date.now(),
): BigscreenKpi {
  const rs = runs ?? [];
  const dayAgo = now - 24 * 3600_000;
  const in24 = rs.filter((r) => {
    const t = parseUtc(r.started_at);
    return Number.isFinite(t) && t >= dayAgo && t <= now;
  });
  const scored = rs.filter(isScored);
  const avg = scored.length
    ? scored.reduce((a, r) => a + (effectiveScore(r) as number), 0) / scored.length
    : null;

  // 环比：近 24h vs 前 24h 的同期均值。绝不用「最近一次 vs 上一次」——
  // 跨方案比毫无意义（见原型推导层注释）。
  const w1 = now - 48 * 3600_000;
  const mean = (a: BigscreenRun[]): number | null =>
    a.length ? a.reduce((s, r) => s + (effectiveScore(r) as number), 0) / a.length : null;
  const mc = mean(scored.filter((r) => parseUtc(r.started_at) >= dayAgo));
  const mp = mean(scored.filter((r) => {
    const t = parseUtc(r.started_at);
    return t >= w1 && t < dayAgo;
  }));
  const delta = mc != null && mp != null ? mc - mp : null;

  // 回归通过率：有 dataset 指标的 run 的 pass_rate 均值；
  // 失败数 = error 且方案含 dataset 环节的 run（plans 提供环节信息）
  const dsRuns = rs.filter((r) => passRateOf(r) != null);
  const dsPlanIds = new Set(
    (plans ?? [])
      .filter((p) => (p.stages ?? []).some((s) => s.type === "dataset"))
      .map((p) => p.plan_id),
  );
  const dsErr = rs.filter((r) => r.status === "error"
    && (dsPlanIds.has(r.plan_id)
      || stagesOf(r).some((s) => s.type === "dataset"))).length;
  const passRate = dsRuns.length
    ? dsRuns.reduce((a, r) => a + (passRateOf(r) as number), 0) / dsRuns.length
    : null;

  // 红队攻破合计（24h 内）
  let breach = 0;
  let attacks = 0;
  let hasRt = false;
  for (const r of in24) {
    const b = breachOf(r);
    if (b != null) {
      hasRt = true;
      breach += b;
      attacks += attacksOf(r);
    }
  }

  return {
    avg,
    avgN: scored.length,
    delta,
    runs24: in24.length,
    // 分段互斥且**必须覆盖 in24 全体**（分段条按 tot 归一，漏一类就画歪）：
    // ok（环节全好）/ partial（部分失败）/ err（status=error 或全环节失败）/
    // noscore（环节全 empty）/ skip / running。
    ok24: in24.filter((r) => outcomeOf(r).kind === "ok").length,
    err24: in24.filter(
      (r) => r.status === "error" || outcomeOf(r).kind === "failed",
    ).length,
    partial24: in24.filter((r) => outcomeOf(r).kind === "partial").length,
    noscore24: in24.filter(isNoScore).length,
    running24: in24.filter((r) => r.status === "running").length,
    skip24: in24.filter((r) => r.status === "skipped").length,
    passRate,
    passN: dsRuns.length,
    dsErr,
    breach: hasRt ? breach : null,
    attacks,
  };
}

// ---------- Agent 健康矩阵 ----------
export type AgentLevel = "bad" | "warn" | "idle" | "ok";

export interface AgentHealth {
  name: string;
  level: AgentLevel;
  tag: { c: "bad" | "warn" | "ok"; t: string } | null;
  /** 最近一次有分 run 的 observe 分 */
  score: number | null;
  /** 最近一次有 dataset 指标 run 的通过率（score 为 null 时的次级口径） */
  pass: number | null;
  latest: BigscreenRun | null;
  /** mini 趋势：该 agent 各 run 的 observe 分（时间升序）；有 observe 分才画线 */
  hist: number[];
  running: boolean;
  plans: number;
}

/** Agent 全集 = plans ∪ runs 出现过的 agent_name（大屏没有独立 agent 目录调用） */
export function deriveAgents(
  runs: BigscreenRun[] | undefined,
  plans: Plan[] | undefined,
): AgentHealth[] {
  const rs = runs ?? [];
  const ps = plans ?? [];
  const names = [...new Set([...ps.map((p) => p.agent_name), ...rs.map((r) => r.agent_name)])]
    .filter(Boolean);

  const out = names.map((name): AgentHealth => {
    const mine = rs
      .filter((r) => r.agent_name === name)
      .sort((x, y) => parseUtc(y.started_at) - parseUtc(x.started_at));
    const latest = mine[0] ?? null;
    const lastScored = mine.find(isScored) ?? null;
    let breach = 0;
    let hasRt = false;
    for (const r of mine) {
      const b = breachOf(r);
      if (b != null) {
        hasRt = true;
        breach += b;
      }
    }
    // 失败 = 顶层 error 或环节全炸；部分失败单独一档（比「无可评估数据」重，
    // 比「运行失败」轻）——此前环节炸掉的 run 在这里完全隐形（UI-025）。
    const err = mine.find((r) => r.status === "error"
      || outcomeOf(r).kind === "failed") ?? null;
    const part = mine.find((r) => outcomeOf(r).kind === "partial") ?? null;
    const nos = mine.find(isNoScore) ?? null;
    const skip = mine.find((r) => r.status === "skipped") ?? null;
    const score = lastScored ? effectiveScore(lastScored) : null;
    const prRun = mine.find((r) => passRateOf(r) != null);
    const pass = prRun ? passRateOf(prRun) : null;
    // 趋势 = 各有分 run 的 observe 分按时间升序（原型用固定 HIST，真实实现按 run 序列）
    const hist = mine
      .filter(isScored)
      .map((r) => effectiveScore(r) as number)
      .reverse();

    let level: AgentLevel = "ok";
    let tag: AgentHealth["tag"] = null;
    if (hasRt && breach > 0) { level = "bad"; tag = { c: "bad", t: `红队攻破 ${breach}` }; }
    else if (err) { level = "bad"; tag = { c: "bad", t: "运行失败" }; }
    else if (part) {
      const names = outcomeOf(part).failedStages.join("·");
      level = "warn"; tag = { c: "warn", t: names ? `部分失败 ${names}` : "部分失败" };
    }
    else if (nos) { level = "warn"; tag = { c: "warn", t: NO_SCORE_TEXT }; }
    else if (skip) { level = "warn"; tag = { c: "warn", t: "已跳过" }; }
    else if (score != null && score < 0.70) { level = "warn"; tag = { c: "warn", t: "低于目标" }; }
    else if (!latest) { level = "idle"; tag = { c: "warn", t: "无运行" }; }
    else { tag = { c: "ok", t: "达标" }; }

    return {
      name,
      level,
      tag,
      score,
      pass,
      latest,
      hist,
      running: mine.some((r) => r.status === "running"),
      plans: ps.filter((p) => p.agent_name === name).length,
    };
  });

  // bad → warn → idle → ok；同级内低分排前。异常恒在最前（第一页）。
  const rank: Record<AgentLevel, number> = { bad: 0, warn: 1, idle: 2, ok: 3 };
  return out.sort((x, y) => {
    if (rank[x.level] !== rank[y.level]) return rank[x.level] - rank[y.level];
    return (x.score ?? 9) - (y.score ?? 9);
  });
}

/** 「需关注」口径（单一住所）：bad / warn 两级的个数。
 *  矩阵头「M 个需关注（已排前）」与 KPI 带「评估监控 Agent」副行共用 ——
 *  判据只写这一份，两处数字结构上不可能岔开。idle（无运行）不算需关注。 */
export function needsAttentionCount(agents: AgentHealth[]): number {
  return agents.filter((a) => a.level === "bad" || a.level === "warn").length;
}

// ---------- 事件侧栏 ----------
export interface BigscreenEvent {
  lv: "bad" | "warn";
  t: string;
  d: string;
  /** 事件时间（原始 started_at，渲染层格式化相对时间） */
  at: string;
  ic: "shield" | "x" | "alert" | "skip" | "trend";
}

/** 待处理事项：红队攻破 / error run / 无可评估数据 / 跳过（含预算字样）/ 跌破目标。
    排序后全量返回；截断交给渲染层（要显示「还有 N 项」，不能在这里悄悄丢）。 */
export function deriveEvents(runs: BigscreenRun[] | undefined): BigscreenEvent[] {
  const ev: BigscreenEvent[] = [];
  for (const r of runs ?? []) {
    const b = breachOf(r);
    if (b != null && b > 0) {
      ev.push({
        lv: "bad", t: `红队攻破 ${b} 次`,
        d: `${r.agent_name} · ${r.plan_name}（${attacksOf(r)} 次攻击）`,
        at: r.started_at, ic: "shield",
      });
    }
    const oc = outcomeOf(r);
    if (r.status === "error" || oc.kind === "failed") {
      ev.push({
        lv: "bad", t: "运行失败",
        d: `${r.agent_name} · ${r.plan_name}：${firstStageError(r) ?? "未知错误"}`,
        at: r.started_at, ic: "x",
      });
    }
    // 环节级失败必须自成事件：顶层 status 是 completed，不会进上面那条，
    // 而它绝不该被「无可评估数据」或静默吞掉（UI-025）。
    if (oc.kind === "partial") {
      ev.push({
        lv: "bad", t: `部分失败 · ${oc.failedStages.join(" · ")}`,
        d: `${r.agent_name} · ${r.plan_name}：${firstStageError(r) ?? "环节未产出结果"}`,
        at: r.started_at, ic: "x",
      });
    }
    if (isNoScore(r)) {
      ev.push({
        // D-3：与全站同词（权威 = scoring.runOutcome 的 nodata label）。
        // 「无有效输出」这条事实挪进说明行 —— 标题必须是权威那句的子串，
        // 括号后缀会让对刑断言失效，也让同一状态在两块屏上叫两个名字。
        lv: "warn", t: NO_SCORE_TEXT,
        // 限定词照 CONTEXT.md:93-96：裸「均分」在大屏上会被读成回归通过率
        d: `${r.agent_name} · ${r.plan_name}：${stagesOf(r)[0]?.sessions ?? 0} `
          + "个会话均无可评内容（无有效输出），不计入线上评估均分与趋势",
        at: r.started_at, ic: "alert",
      });
    }
    if (r.status === "skipped") {
      ev.push({
        lv: "warn", t: "定时运行被跳过",
        d: `${r.agent_name} · ${r.plan_name}：${r.skip_reason ?? "未说明原因"}`,
        at: r.started_at, ic: "skip",
      });
    }
    const s = effectiveScore(r);
    if (r.status === "completed" && s != null && s < 0.70) {
      ev.push({
        // 两个限定词都照 CONTEXT.md：这个数是 effectiveScore(run) = 各 observe 环节
        // overall_mean 的均值 →「线上评估均分」（与本屏 hero KPI 同一个词、同一个
        // 数）；0.70 是「目标线」词条那条阈值，裸「目标」在同屏会被读成
        // 红队用例集的被测 Agent。
        lv: "warn", t: "线上评估均分跌破目标线 0.70",
        // 说明行量纲 = 判定量纲（effectiveScore 已 round4 → 四位）：此前
        // toFixed(2) 在 s ∈ [0.695, 0.69995) 会印「跌破目标线 0.70：本次 0.70」
        // 的自相矛盾文案 —— scoreof-converge 的 round4 只掐掉 [0.69995, 0.70)
        // 的毛刺半格，这里补掉其余矛盾带（钉在 tests/bigscreen.test.tsx）。
        d: `${r.agent_name} · ${r.plan_name}：本次 ${s.toFixed(4)}`,
        at: r.started_at, ic: "trend",
      });
    }
  }
  const rank = { bad: 0, warn: 1 };
  return ev.sort((a, b) => rank[a.lv] - rank[b.lv]);
}

// ---------- 顶条健康灯 ----------
export type LampState = "ok" | "warn" | "bad";

export interface LampInfo {
  state: LampState;
  txt: string;
  sub: string;
}

/** 三态：有 bad 级事件（breached / error run）→ 故障红；
    仅 warn 级 → 琥珀；全空 → 全绿 */
export function deriveLamp(events: BigscreenEvent[], agentCount: number): LampInfo {
  const bad = events.filter((e) => e.lv === "bad").length;
  const warn = events.filter((e) => e.lv === "warn").length;
  if (bad > 0) {
    return {
      state: "bad", txt: "需要处理",
      sub: `${bad} 项故障${warn ? ` · ${warn} 项警告` : ""}`,
    };
  }
  if (warn > 0) return { state: "warn", txt: "有警告", sub: `${warn} 项待确认` };
  return { state: "ok", txt: "运行正常", sub: `全部 ${agentCount} 个 Agent 健康` };
}

// ---------- 时间格式化 ----------
export function ago(startedAt: string, now: number = Date.now()): string {
  const ms = parseUtc(startedAt);
  // 后端对缺 started_at 的历史 item 回退空串 → parseUtc NaN。无这道闸时 NaN
  // 穿过所有分支渲染成字面「NaN 天前」（issue bigscreen-ago-nan）。未知态文案
  // 与同文件 fmtHM 一致。
  if (Number.isNaN(ms)) return "—";
  const m = Math.round((now - ms) / 60_000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function fmtHM(startedAt: string): string {
  const d = new Date(parseUtc(startedAt));
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
