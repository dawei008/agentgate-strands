// M3：run_plan 流式运行——逐事件累积进度日志，完成后刷新历史+KPI。
// 进度可视化增强：单行覆盖 → entries 累积日志 + startedAt/lastEventAt 时间戳
//（heartbeat 不进日志，只刷新 lastEventAt——活性判定交给 lib/useLiveness）。
//
// UI-029 批 3：**断流 ≠ 失败**。run_plan 的执行体是 AgentCore Runtime microVM
// （8h 上限），900s 超时的是 UiProxy 中继 —— 它死了只断「看」不断「跑」（SPEC
// §1.1/§1.2：74m16s 那次 run 断流后独活 59 分钟跑完并完整落库）。所以流断掉之后
// 这里**留在进行中面板**，转 get_plan_run(run_key) 每 10s 轮询到终态。
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiOne, callApi } from "../../lib/api";
import type { ApiEvent } from "../../lib/api";
import { clearRunFlight, noteRunSettled, frameworkErrorText } from "../../lib/runFlight";
// 环节展示名的唯一权威（术语五词，ADR-0003）——本文件不再养本地副本
import { STAGE_LABEL } from "../../lib/scoring";
// 环节数字的**唯一**格式化（方案详情环节行 / 报告抽屉 / 导出共用同一句话）：
// 流式行此前自己 toFixed(2)，把回归通过率印成与均分同形的「0.00」
import { stageNumbers } from "./derive";
// 「没有」的统一记号：stageNumbers 无数字时返回它，流式行据此整段不出括号
import { EMPTY_MARK } from "../../lib/renderText";
import type { PlanRunDetail, PlanRunProgress, StageSummary } from "./types";
import {
  EMPTY_LIVE_TURNS, pushLiveTurn, type LiveTurnsState,
} from "./liveTurns";
import {
  EMPTY_OBSERVE_SESSIONS, pushObserveSession, shortSessionId,
  type ObserveSessionsState,
} from "./observeSessions";

export type RunLogKind = "info" | "good" | "bad";
export interface RunLogEntry {
  /** Date.now() 毫秒 */
  ts: number;
  kind: RunLogKind;
  text: string;
}

// turns / sessions 独立于 entries：逐条事件不进滚动日志（会把关键行冲出 5 行
// 窗口），各自单独存 ——
//   · turns    逐轮对话（红队 attack_turn + 回归/模拟 turn），见 liveTurns.ts
//   · sessions 线上评估的逐会话结果（session_result / session_error + 分母
//              observe_sessions），见 observeSessions.ts
// 两者互斥出现：observe 环节不发逐轮事件，另两类不发会话事件；混跑方案里
// 两格会同时在场（各自「没数据就不画」）。
// 可选是给「手搓 state 直渲 RunProgress」留的口子；useRunPlan 自己**恒**填这两个
// 字段，undefined 与空桶在界面上同样是「不画」。
// stopRequested 是「running → 已请求停止 → 终态」这个中间态在状态机里的落点
//（P0 停止控件）。**它不是「已停止」**：后端 stop_plan_run 只把意图写进 run 记录，
// 执行侧在下一个检查点才收敛（app/planrun.py:584-644），流照常继续往下推事件。
// 后端刻意**没有**为此新增 SSE 事件，所以这个位只能由前端在拿到 action 回执时置上，
// 并一路带到终态那一帧 —— 终帧 plan_run_report 不带 run 状态
//（app/main.py:1498-1509），拿它当「运行完成」讲会把一次被停掉的运行说成跑完了。
export type RunPlanState =
  | { phase: "idle" }
  | { phase: "running"; entries: RunLogEntry[]; startedAt: number; lastEventAt: number;
      stopRequested?: boolean;
      turns?: LiveTurnsState; sessions?: ObserveSessionsState;
      /** 本次运行的 run_key —— **来自 plan_run_started**（后端 UI-029 批 1 起在
       *  write-at-start 之后经 emit 通道发出）。断流转轮询的唯一钥匙；
       *  null = 首帧还没到（那时断流只能走既有兜底，没有可查的对象） */
      runKey?: string | null;
      /** true = 实时流已断，改为每 REATTACH_POLL_MS 查一次 get_plan_run。
       *  **run 仍在后端跑**，面板留在原地（不是失败态） */
      reattached?: boolean;
      /** 轮询读到的存活/进度（后端读侧字段；老 run 缺字段 → null，展示侧不画） */
      heartbeatEpoch?: number | null;
      progress?: PlanRunProgress | null;
      /** 后端读侧判定这条 run 疑似中断（stale）→ 停止轮询、中性展示。
       *  判据只有后端一份（stalecheck.is_stale），前端不自造 */
      suspectedStale?: boolean;
      /** 最近一次查询失败的原因（还在重试；连续到上限才收手） */
      pollError?: string | null }
  | { phase: "done"; report: PlanRunDetail; entries: RunLogEntry[];
      startedAt: number; durationS: number; stopRequested?: boolean;
      turns?: LiveTurnsState; sessions?: ObserveSessionsState;
      /** 轮询拿到的**后端 run 状态**（completed/error/stopped/halted_cost…）。
       *  流式终帧 plan_run_report 不带状态，所以只有轮询这条路能填 —— 有它就
       *  不许把一条 error/stopped 的 run 说成「运行完成」 */
      settledStatus?: string }
  | { phase: "failed"; error: string; entries: RunLogEntry[];
      startedAt: number; durationS: number; stopRequested?: boolean;
      /** true = 前端断流（fetch 异常/流早断）——后端 run 可能还在跑，≠ run 失败 */
      disconnected: boolean;
      turns?: LiveTurnsState; sessions?: ObserveSessionsState };

/** 后端 error 事件 = run 真失败；与前端断流（fetch 异常）区分开 */
class RunFailedError extends Error {}

/** 短会话 id 与实时会话清单**同一个实现**（observeSessions.shortSessionId）：
 *  同一条会话在日志行与清单行里必须显示成同一个短 id，否则用户对不上。 */
const shortId = shortSessionId;

/** session_result.results（evaluator → {score,…}）→ 均分；无可评分项返回 null */
function sessionMean(results: unknown): number | null {
  if (!results || typeof results !== "object") return null;
  const scores = Object.values(results as Record<string, { score?: unknown }>)
    .map((r) => r?.score)
    .filter((v): v is number => typeof v === "number");
  if (scores.length === 0) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * 环节完成行括号里的数字 —— **按环节类型选量纲**（档
 * stage-line-shows-pass-rate-as-score）。
 *
 * 此前一个 `score.toFixed(2)` 管三类：回归环节给的是 0-1 的**通过率**，被印成
 * 「完成（0.00）」，与线上评估均分外观完全一致 —— 用户把它读成「Agent 全答错」
 * （真实事故语境：那次其实是 goal_success_rate 与拒绝场景用例口径不匹配）。
 *
 * 文案来源是**方案详情/报告抽屉的同一个函数**（derive.stageNumbers），不新写
 * 格式化：dataset →「通过率 X%」/「通过 a/b」，redteam →「攻破 x/y」。
 * observe 保持两位小数（那一格本来就是分数量纲，呈现不变）。
 *
 * 只在**有结果指标**时出括号：用例数不是结果（「4 用例」不回答跑得怎么样），
 * 缺数字也绝不用 0 顶 —— 通过率 0% 是结论，「没给」不是 0。
 */
function stageDoneTail(
  stageType: string,
  rec: Record<string, unknown>,
  summary: Record<string, unknown>,
): string {
  const numbers = (): string => {
    const s = stageNumbers({ ...summary, type: stageType } as unknown as StageSummary);
    return s === EMPTY_MARK ? "" : s;
  };
  if (stageType === "dataset") {
    const has = typeof summary.pass_rate === "number" || summary.passed != null;
    return has ? numbers() : "";
  }
  if (stageType === "redteam") {
    const has = summary.breached != null || summary.attacks != null;
    return has ? numbers() : "";
  }
  // observe（及未知类型）：均分两位小数。rec.score 优先照旧（老形态把分数放顶层）
  const mean = typeof rec.score === "number" ? rec.score
    : typeof summary.overall_mean === "number" ? summary.overall_mean
    : null;
  return mean != null ? mean.toFixed(2) : "";
}

/** 单条流式事件 → 日志条目；null = 不进日志（heartbeat/终帧/逐 turn 噪音） */
export function logEntryOf(ev: ApiEvent): { kind: RunLogKind; text: string } | null {
  const rec = ev as { event: string } & Record<string, unknown>;
  // heartbeat 只养活性时间戳；turn/attack_turn 逐轮事件会刷屏，不进日志
  // ——它们走 liveTurns 的独立桶（本函数返回 null 是有意为之，别改成进日志：
  // 线上一次 run 有 216 条逐轮事件，会把「环节完成/失败」冲出 5 行窗口）
  if (rec.event === "heartbeat" || rec.event === "turn" || rec.event === "attack_turn") {
    return null;
  }
  // observe_sessions 只是会话清单的分母，本身不是进度事实 → 不进日志。
  // 必须显式挡掉：本函数末尾的兜底是 `text: rec.event`，漏挡会在用户可见的
  // 日志里印出一行光秃秃的「observe_sessions」。
  if (rec.event === "observe_sessions") return null;
  if (rec.event === "run_started" || rec.event === "plan_run_started") {
    const stages = Array.isArray(rec.stages) ? `（${rec.stages.length} 个环节）` : "";
    // 续跑首帧（UI-029 批 4）：后端在同名事件上多挂一个 resume 段
    // （app/planrun.py:execute_plan_run 的 started_event["resume"]）。这一行要
    // 说清「哪些环节没有重跑」—— 否则用户看不出自己省下的那笔钱到底省了没有。
    const resume = rec.resume as { from_stage?: unknown; stages_done?: unknown } | undefined;
    if (resume && typeof resume.from_stage === "number") {
      const done = typeof resume.stages_done === "number" ? resume.stages_done : 0;
      return {
        kind: "info",
        text: `续跑开始：从第 ${resume.from_stage} 个环节继续`
          + `（已沿用 ${done} 个环节的结果）`,
      };
    }
    return { kind: "info", text: `运行开始${stages}` };
  }
  // observe 环节逐会话事件（planrun.py:155）
  if (rec.event === "session_result") {
    const mean = sessionMean(rec.results);
    // 限定词照 CONTEXT.md「线上评估均分」词条（裸「均分」不得单独出现）：这一格是
    // **一条会话**内各评估器分数的均值 —— 运行中的同一屏还会滚过环节完成行的
    // 「本环节均分」，结束后的报告写「线上评估均分」。三个数量纲不同、外观全是
    // 两位小数，前缀「会话 X」离得远又不点名量纲，光写「均分」分不出是哪一个。
    // 用词与实时会话清单（ObserveSessionsPanel 的同一个数）保持一致。
    const tail = mean != null ? `本会话均分 ${mean.toFixed(2)}` : "无可评分项";
    return { kind: "good", text: `会话 ${shortId(rec.session_id)} 评分完成 · ${tail}` };
  }
  if (rec.event === "session_error") {
    return { kind: "bad", text: `会话 ${shortId(rec.session_id)} 评分失败：${String(rec.error ?? "未知错误")}` };
  }
  if (rec.event === "synthesis_start") return { kind: "info", text: "生成综合报告…" };
  if (rec.event === "synthesis_done") {
    return rec.ok
      ? { kind: "good", text: "综合报告已生成" }
      : { kind: "bad", text: `综合报告生成失败：${String(rec.error ?? "")}` };
  }
  // 环节事件：后端 stage_start 带顶层 type、stage_done 的 type 在 summary 里
  //（stage 是序号，planrun.py:470,483）；mock/旧形态 stage_started/stage_completed
  // 的 stage 是类型字符串——三种形态都接
  const summary = (rec.summary ?? {}) as Record<string, unknown>;
  const stageType = typeof rec.type === "string" ? rec.type
    : typeof summary.type === "string" ? summary.type
    : typeof rec.stage === "string" ? rec.stage : null;
  if (stageType) {
    const name = STAGE_LABEL[stageType] ?? stageType;
    const seq = typeof rec.stage === "number"
      ? `环节 ${rec.stage}${typeof rec.total_stages === "number" ? `/${rec.total_stages}` : ""} · `
      : "";
    if (rec.event.includes("start")) return { kind: "info", text: `${seq}${name}：执行中` };
    if (rec.event.includes("complet") || rec.event.includes("finish") || rec.event.includes("done")) {
      if (summary.status === "error") {
        return { kind: "bad", text: `${seq}${name}：失败${summary.error ? `：${String(summary.error)}` : ""}` };
      }
      if (summary.status === "empty") {
        return { kind: "info", text: `${seq}${name}：无数据${summary.error ? `（${String(summary.error)}）` : ""}` };
      }
      const tail = stageDoneTail(stageType, rec, summary);
      // D-4：环节级「完成」必须带限定 —— 裸词「完成」只归 run 级 badge
      // （lib/scoring.runOutcome 的 ok 分支，ADR-0003 Amendment 定型的五态）。
      // 带「环节 N/M · 」前缀的行**已经**限定了层级（前缀就是限定词），原文
      // 不动；没有序号的旧形态（stage 给的是类型字符串）此前是一行光秃秃的
      // 「回归测试：完成」，与 run badge 同词不同层 —— UI-013 的用户画面正是
      // 「环节说完成、run 说无可评估数据」。
      const doneWord = seq ? "完成" : "本环节完成";
      return { kind: "good", text: `${seq}${name}：${doneWord}${tail ? `（${tail}）` : ""}` };
    }
    return { kind: "info", text: `${seq}${name}：${rec.event}` };
  }
  if (rec.event === "plan_run_report") return null;
  return { kind: "info", text: rec.event };
}

/** 断流后的轮询间隔（SPEC §6 定的 10s）。后端心跳每 60s 落一次、进度只在环节
 *  边界更新，更密的轮询换不来更早的终态，只是白打 get_plan_run。 */
export const REATTACH_POLL_MS = 10_000;
/** 连续查询失败几次就收手。没有这个上限，一条查不到的 run（被删/权限炸/后端持续
 *  报错）会让页面开着就每 10s 空打一次，开一夜上万次。 */
export const REATTACH_MAX_FAILS = 3;

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

export function useRunPlan(planId: string) {
  const qc = useQueryClient();
  const [state, setState] = useState<RunPlanState>({ phase: "idle" });
  // 「已请求停止」发生在**流之外**（用户点停止 → 另一次 Lambda 调用写标志），
  // 而 run() 里每条事件都整体重写 state（sync）。所以中间态存在 ref 里，让 sync
  // 与终态那两次 setState 都读得到——否则下一条 heartbeat 就把它冲掉了。
  const stopRequested = useRef(false);
  // 轮询的生存判据（**不许泄漏**）：卸载或用户关掉面板都让在跑的那圈轮询立刻收手。
  // 计数器而不是布尔：dismiss 之后再发起一次运行，新一圈要能独立存活，老一圈
  // 必须认出「我这一代已经作废」——布尔做不到这件事。
  const pollGen = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
    pollGen.current += 1;
  }, []);

  /**
   * 发起一次运行；`resumeRunKey` 非空 = **从检查点续跑**（UI-029 批 4）。
   *
   * 续跑刻意走**同一台状态机、同一张进度卡**：后端那边它就是同一次运行
   * （同 run_key、attempt+1，状态仍是 running，规格 §2 不新增状态），逐事件进度 /
   * 停止入口 / 断流转轮询 / 终帧渲染一件都不用另写。这里的差别只有两处：
   * 发出去的 action 与首行日志的措辞。
   */
  async function run(resumeRunKey?: string) {
    stopRequested.current = false;
    const startedAt = Date.now();
    const entries: RunLogEntry[] = [
      { ts: startedAt, kind: "info",
        text: resumeRunKey
          ? "已发起从检查点续跑，等待后端响应…"
          : "已发起运行，等待后端响应…" },
    ];
    // 逐轮事件的独立桶（尾窗在 pushLiveTurn 里真丢弃老轮次）
    let turns = EMPTY_LIVE_TURNS;
    // 线上评估逐会话结果的独立桶（同样有上限，见 observeSessions.ROW_KEEP）
    let sessions = EMPTY_OBSERVE_SESSIONS;
    // run_key 只有流里的 plan_run_started 带（批 1 起）；拿不到就没有轮询这条路
    let runKey: string | null = null;
    let reattached = false;
    // 轮询读回来的存活事实（后端读侧字段，前端不加工）
    let facts: {
      heartbeatEpoch?: number | null; progress?: PlanRunProgress | null;
      suspectedStale?: boolean; pollError?: string | null;
    } = {};
    const sync = () =>
      setState({
        phase: "running", entries: [...entries], startedAt, lastEventAt: Date.now(),
        stopRequested: stopRequested.current, turns, sessions,
        runKey, reattached, ...facts,
      });

    /**
     * 断流后的接管：每 REATTACH_POLL_MS 查一次 get_plan_run(run_key)，
     * 终态到达即渲染报告（那一份带 S3 全量归档，正是报告要的东西）。
     *
     * 三个收手条件（缺一个就是泄漏或空转）：
     *   · 组件卸载 / 用户关掉面板（pollGen 代际作废）；
     *   · 后端说这条 run 陈旧（stale）—— 执行进程已判定停止，再查也不会变；
     *   · 连续失败到 REATTACH_MAX_FAILS。
     */
    async function pollUntilSettled(key: string): Promise<void> {
      pollGen.current += 1;
      const gen = pollGen.current;
      const mine = () => mounted.current && pollGen.current === gen;
      let fails = 0;
      while (mine()) {
        await sleep(REATTACH_POLL_MS);
        if (!mine()) return;
        let run: PlanRunDetail;
        try {
          run = await apiOne<PlanRunDetail & ApiEvent>(
            { action: "get_plan_run", run_key: key }, "plan_run");
        } catch (e) {
          if (!mine()) return;
          fails += 1;
          const why = e instanceof Error ? e.message : String(e);
          if (fails >= REATTACH_MAX_FAILS) {
            entries.push({ ts: Date.now(), kind: "bad", text: `查询运行状态失败：${why}` });
            setState({
              phase: "failed",
              error: `连续 ${fails} 次查不到这次运行的状态：${why}`,
              entries: [...entries], startedAt,
              durationS: Math.round((Date.now() - startedAt) / 1000),
              disconnected: true, stopRequested: stopRequested.current, turns, sessions,
            });
            return;
          }
          facts = { ...facts, pollError: why };
          sync();
          continue;
        }
        if (!mine()) return;
        fails = 0;
        if ((run.status ?? "") === "running") {
          facts = {
            heartbeatEpoch: run.heartbeat_epoch ?? null,
            progress: run.progress ?? null,
            // 陈旧判定只消费后端布尔（判据在 app/stalecheck.py 那一份）
            suspectedStale: run.stale === true,
            pollError: null,
          };
          sync();
          if (run.stale === true) return;
          continue;
        }
        // 终态到达 → 渲染报告。**后端状态如实带上**（settledStatus）：
        // 一条 error/stopped 的 run 不许显示成「运行完成」。
        setState({
          phase: "done", report: run, entries: [...entries], startedAt, turns, sessions,
          stopRequested: stopRequested.current,
          settledStatus: run.status ?? "",
          durationS: typeof run.duration_s === "number"
            ? run.duration_s
            : Math.round((Date.now() - startedAt) / 1000),
        });
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["plan_runs", planId] }),
          qc.invalidateQueries({ queryKey: ["plan_estimate", planId] }),
        ]);
        return;
      }
    }

    sync();
    try {
      let report: PlanRunDetail | null = null;
      // 后端在开跑时就落了一条 status="running" 的 PLANRUN 记录
      //（planrun.py execute_plan_run 开头），所以首个事件一到就该刷一次运行历史
      // ——否则「运行进行中打开运行历史是空的」（P1，2026-08-24 用户实测）。
      // **只刷一次**：一次 run 有几百条流式事件，逐条 invalidate 会把 list_plan_runs
      // 打成连环请求。
      let historyPoked = false;
      // 续跑只带 run_key（plan_id 是它的前缀，后端自己推 —— 两个入口各传一份
      // 身份就会有「两处不一致」这种缺陷形态）。
      const payload = resumeRunKey
        ? { action: "resume_plan_run", run_key: resumeRunKey }
        : { action: "run_plan", plan_id: planId };
      await callApi(payload, (ev) => {
        if (!historyPoked) {
          historyPoked = true;
          void qc.invalidateQueries({ queryKey: ["plan_runs", planId] });
        }
        if (ev.event === "error") throw new RunFailedError(String(ev.error));
        // 框架层遗言帧（无 event 字段的 {error, error_type, message}）= 后端异常
        // 穿出 entrypoint，run 已经死了。算 RunFailedError（「运行失败 + 真因」）
        // 而不是断流：不认这帧的话它会掉进 logEntryOf 的兜底（日志里印一行空事件
        // 名），最后以「流已结束但未收到 plan_run_report」报成「连接中断，运行可能
        // 仍在后台进行」—— 真因全被盖掉，用户还白等一个已经死掉的 run。
        // 识别逻辑复用 lib/runFlight 导出的那份（见该函数注释：为什么不再抄第三份）。
        const framework = frameworkErrorText(ev);
        if (framework) throw new RunFailedError(framework);
        if (ev.event === "plan_run_skipped") {
          throw new RunFailedError(String((ev as Record<string, unknown>).reason ?? "本次运行已跳过"));
        }
        if (ev.event === "plan_run_report") {
          report = ev as unknown as PlanRunDetail;
          return;
        }
        // 断流轮询的钥匙（后端批 1 起 plan_run_started 带 run_key）。放在
        // logEntryOf 之前赋值即可 —— 这一帧照旧进日志（「运行开始（N 个环节）」）。
        if (ev.event === "plan_run_started") {
          const key = (ev as Record<string, unknown>).run_key;
          if (typeof key === "string" && key) runKey = key;
        }
        // turn / attack_turn 不进日志（logEntryOf 返回 null）但要进对话桶
        turns = pushLiveTurn(turns, ev, Date.now());
        // observe 的逐会话事件进清单桶。session_result/session_error **仍然**
        // 进日志（既有行为，不动）——清单是耐久视图，日志只留最近 5 行。
        sessions = pushObserveSession(sessions, ev, Date.now());
        const entry = logEntryOf(ev);
        if (entry) entries.push({ ts: Date.now(), ...entry });
        sync(); // heartbeat 也走这里：不进日志但刷新 lastEventAt
      });
      if (!report) {
        // 流正常关闭却没有终帧 = 链路被掐（CloudFront/网络），不是 run 失败
        throw new Error("流已结束但未收到 plan_run_report");
      }
      const rep: PlanRunDetail = report;
      setState({
        phase: "done", report: rep, entries: [...entries], startedAt, turns, sessions,
        stopRequested: stopRequested.current,
        durationS: typeof rep.duration_s === "number"
          ? rep.duration_s
          : Math.round((Date.now() - startedAt) / 1000),
      });
      // 完成后刷新历史 + KPI（预估随方案定义走，也一并失效）
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["plan_runs", planId] }),
        qc.invalidateQueries({ queryKey: ["plan_estimate", planId] }),
      ]);
    } catch (e) {
      const disconnected = !(e instanceof RunFailedError);
      // 断流 ≠ 失败（UI-029 批 3 交付 1）：拿到过 run_key 就**留在进行中面板**转
      // 轮询 —— 执行在 AgentCore 里继续跑，中继断掉只断「看」。以前这里直落 failed
      // 并让用户「稍后刷新运行历史」，那正是被点名的死胡同。
      // 后端明说的失败（RunFailedError：{event:"error"} / 遗言帧 / plan_run_skipped）
      // 不走这条 —— 那些是 run 真死了，轮询只会看到同一个终态。
      if (disconnected && runKey) {
        reattached = true;
        facts = {};
        entries.push({
          ts: Date.now(), kind: "info",
          text: `实时连接已断开，改为每 ${REATTACH_POLL_MS / 1000} 秒查询运行状态`
            + "（运行仍在后端继续）",
        });
        sync();
        await pollUntilSettled(runKey);
        return;
      }
      setState({
        phase: "failed",
        error: e instanceof Error ? e.message : String(e),
        entries: [...entries],
        startedAt,
        durationS: Math.round((Date.now() - startedAt) / 1000),
        disconnected,
        stopRequested: stopRequested.current,
        // 断流前收到的对话/会话行保留：帮用户判断断在哪一路第几轮、评到第几条
        turns,
        sessions,
      });
    }
  }

  /** 停止回执（requested=true）到手：把中间态记进状态机。
   *  只改「是否已请求停止」这一位，**不动 phase** —— 运行确实还在跑，
   *  流还会继续推事件，直到执行侧在下一个检查点收敛。 */
  function noteStopRequested() {
    stopRequested.current = true;
    setState((prev) => (prev.phase === "running" ? { ...prev, stopRequested: true } : prev));
  }

  return {
    state,
    run,
    noteStopRequested,
    dismiss: () => {
      stopRequested.current = false;
      // 关掉面板 = 不再盯这条 run（在跑的那圈轮询代际作废，立刻收手）。
      // 运行历史那一行仍会由页面的 10s 轮询刷新，用户不会因此失去可见性。
      pollGen.current += 1;
      setState({ phase: "idle" });
    },
  };
}

// ---------------------------------------------------------------- 停止运行
// 后端 action：`stop_plan_run`（app/main.py:1402-1418 → app/planrun.py:584-644）。
// 语义是**「请求停止」不是「同步停止」**：条件写 stop_requested 标志（只对 running
// 生效），执行侧在下一个检查点收敛（红队每 4 轮/5 秒、回归每 2 轮/每用例、方案在
// 环节边界）。所以这里一个字都不许说「已停止」——一律用后端回执的 message 原话，
// 那几句是后端专门为「可核验」写的（tests/test_stop_plan_run.py:150-156 钉死
// 「已请求停止」「检查点」在、「已停止」不在）。

/** stop_plan_run 的回执形态。三种真实形态逐字钉在 tests/test_stop_plan_run.py：
 *   · :129-138 running 首次    requested=true  / already=false（+ stop_requested_at）
 *   · :188-197 running 再次    requested=true  / already=true（幂等，不重写时间）
 *   · :171-186 已终态无操作    requested=false / already=false（message 带中文状态，
 *                              绝不把 halted_cost 这种英文枚举印给用户）
 *  run_key 缺失（:158-161）与不存在（:163-169）走 {event:"error"}，由 apiOne 抛出。 */
// 刻意用 type 而不是 interface：apiOne<T> 的 T 要满足 ApiEvent
//（{event:string} & Record<string, unknown>），只有类型别名才有隐式索引签名。
export type PlanRunStopRequestedEvent = {
  event: "plan_run_stop_requested";
  run_key: string;
  /** 后端读到的 run 状态（running 或它已经收敛到的终态） */
  status: string;
  requested: boolean;
  already: boolean;
  stop_requested_at?: string;
  message: string;
};

/** 一个 run_key 的停止态。**没有「已停止」这一档**——那是 run 自己的终态，
 *  由运行历史里后端给的 status 决定（lib/scoring.ts 的 STATUS_LABEL.stopped）。 */
export type StopRunState =
  | { phase: "idle" }
  | { phase: "requesting" }
  /** 意图已落库，等下一个检查点；message = 后端原话，at = 请求时刻（Date.now()，
   *  轮询闸门的封顶计时用它） */
  | { phase: "requested"; message: string; already: boolean; at: number }
  /** 无操作：run 已经是终态（message 里有中文状态说明） */
  | { phase: "noop"; message: string; status: string }
  | { phase: "error"; error: string };

const STOP_IDLE: StopRunState = { phase: "idle" };

/** 「等收敛」的封顶时长：超过这个还停在 running 就不再轮询运行历史了。
 *  没有它的话，一条**永不收敛**的 running 记录（Lambda 被硬杀 → finally 都没跑，
 *  收尾归 stale-running-run-reaper 那条 issue）会让页面开着就每 5s 打一次
 *  list_plan_runs，开一夜上万次。封顶后照样看得到终态 —— 只是要用户自己刷新，
 *  界面也不会谎称还在等（中间态文案说的是「将在下一个检查点生效」，不是「马上」）。 */
export const STOP_WATCH_MAX_MS = 10 * 60 * 1000;

/** 「这条 run 的停止还值得盯着吗」——运行历史轮询闸门的判据（纯函数，好测）。
 *  requesting = 请求还在途；requested = 意图落库了，在封顶时长内等收敛；
 *  其余（idle / noop / error）都不该轮询。 */
export function stopWatchActive(st: StopRunState, now: number): boolean {
  if (st.phase === "requesting") return true;
  return st.phase === "requested" && now - st.at < STOP_WATCH_MAX_MS;
}

export type StopRunApi = {
  stateOf: (runKey: string | null) => StopRunState;
  /** 已请求停止、还在封顶时长内等收敛（运行历史的轮询闸门用它） */
  isPending: (runKey: string) => boolean;
  request: (runKey: string) => Promise<StopRunState>;
};

/**
 * 「请求停止一次运行」的状态机，**按 run_key 存**：同一次运行可能有两个入口
 * （运行进度卡 + 运行历史那一行），点哪个都必须是同一台状态机，否则一个说
 * 「已请求停止」另一个还是「停止」。
 *
 * 请求失败**不改写 run 的状态**（验收 5）：只落一条 error，run 该显示什么还显示
 * 什么，入口恢复可点。
 */
export function useStopRun(planId: string): StopRunApi {
  const qc = useQueryClient();
  const [states, setStates] = useState<Record<string, StopRunState>>({});

  function put(runKey: string, next: StopRunState) {
    setStates((prev) => ({ ...prev, [runKey]: next }));
  }

  async function request(runKey: string): Promise<StopRunState> {
    put(runKey, { phase: "requesting" });
    let next: StopRunState;
    try {
      // apiOne 已经认 {event:"error"} 与框架层遗言帧（lib/api.ts:96-123），
      // run_key 缺失/不存在/DDB 写失败都会在这里变成可见错误。
      const ev = await apiOne<PlanRunStopRequestedEvent>(
        { action: "stop_plan_run", run_key: runKey }, "plan_run_stop_requested");
      next = ev.requested
        ? {
            phase: "requested", message: ev.message,
            already: Boolean(ev.already), at: Date.now(),
          }
        : { phase: "noop", message: ev.message, status: ev.status };
    } catch (e) {
      next = { phase: "error", error: e instanceof Error ? e.message : String(e) };
    }
    put(runKey, next);
    if (next.phase !== "error") {
      // 意图落库了（或后端说这条 run 已终态）→ 立刻拉一次运行历史。
      // 真收敛通常晚于这一拉，后续由 PlanDetailPage 的轮询闸门接手。
      void qc.invalidateQueries({ queryKey: ["plan_runs", planId] });
    }
    if (next.phase === "noop") {
      // 权威读说这条 run 已经是终态 → 在飞标记跟着清，别让页面继续假装在跑。
      // 同时把 run_key 记进「已知终态」登记（UI-029 批 3）：否则方案详情页的权威读
      // 认领会在下一次渲染里按**还没刷新的**运行历史把标记复活，页面永远「运行中…」。
      // 登记在列表读回终态（或那条记录消失）后自动退休，不靠「哪一拉先到」。
      noteRunSettled(runKey);
      clearRunFlight(planId);
    }
    return next;
  }

  return {
    stateOf: (runKey) => (runKey == null ? STOP_IDLE : states[runKey] ?? STOP_IDLE),
    isPending: (runKey) => stopWatchActive(states[runKey] ?? STOP_IDLE, Date.now()),
    request,
  };
}
