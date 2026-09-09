// 运行中实时对话：`turn` / `attack_turn` 两种流式事件 → 按「路」分桶 + 每桶尾窗
// 的纯状态层。三类环节（回归 / 模拟 / 红队）共用这一层与同一个面板。
//
// ── 两个数据源的真形态（只读核实，不猜）────────────────────────────────────
//
// A) attack_turn —— app/redteam.py:685 emit_turn → app/planrun.py:264 emit
//    {"event":"attack_turn","run_id":…,"case":"attack#N",
//     "role":"attacker"|"target","message":"…","turn_no":N}
//
// B) turn —— app/testrun.py:601 emit_turn → app/planrun.py:218 emit
//    {"event":"turn","run_id":…,"case":"<用例名>","agent":"<agent 名>",
//     "role":"user"|"agent","message":"…","turn_no":N}
//    role 三个调用点（app/testrun.py）：
//      · :663 缓存命中回放 —— t["role"]，来自 conversation 记录（"user"/"agent"）
//      · :667 → :284/:287 多轮模拟 —— on_turn("user") / on_turn("agent")
//      · :679 / :682 单轮 —— 字面量 "user" / "agent"
//
// ── 三处**真差异**（本层的全部难点都在这三行）──────────────────────────────
//
//  1. `agent` 字段：turn **有**，attack_turn **没有** → 类型上必须可选，渲染
//     时不许假设存在。
//
//  2. `case` 语义：turn 的 case 是**真用例名**（如 airline-rebooking-dialog）；
//     attack_turn 的 case 是 `attack#N`，是**被测会话的构造顺序编号**，不是
//     用例名（app/redteam.py:703 target_factory 按构造顺序编号，
//     MAX_CONCURRENT_ATTACKS=3 并发下构造顺序 ≠ 用例顺序，攻击方工厂看不到
//     自己在为哪条用例构造会话）。→ 栏头文案按来源分开，红队那侧**继续**只显示
//     攻击编号，绝不做「猜用例名」的映射。
//
//  3. `turn_no` 计数域：turn 是**每 `case@agent`** 自增（app/testrun.py:603
//     `key = f"{case_name}@{agent_name}"`）；attack_turn 是**每 case** 自增。
//     → 同一用例跑多个 agent 时 turn_no 会重复，**分栏键必须含 agent**，否则
//     两个 agent 的对话会串进同一栏。
//
// 两种事件共有的坑：
//   · turn_no 断流重连后有空洞（live_turns 每 2 轮 / 每 4 轮才落盘）
//     → **绝不能当数组索引**，界面必须容忍不连续编号
//   · message 后端已截断到 1500 字符
//
// 为什么另开一桶而不进滚动日志：逐轮事件会把「环节完成/失败」等关键行冲出日志的
// 5 行窗口（useRunPlan.logEntryOf 对两种事件都返回 null 是有意为之）。线上实测
// 单次红队 run 有 216 条 live_turns、另一个 155 条且在涨 —— 刷屏是真问题。
import type { ApiEvent } from "../../lib/api";

/** ⚠️ 与 app/redteam.py 的 marker 文案**强耦合**：
 *    BLANK_TARGET_MARKER  (app/redteam.py:138) —— 靶侧返回 0 字节时后端塞的占位
 *    INVOKE_FAILED_MARKER (app/redteam.py:149) —— invoke 抛异常时的占位
 *
 *  终态报告里有 silenced/errored 字段可用，但**实时期的事件里没有**
 *  （见 emit_turn 只发 case/role/message/turn_no），所以实时层只能靠 message 前缀识别。
 *  改后端 marker 文案必须同步改这两个常量，否则空响应会被当成「靶侧真的回复了」
 *  渲染 —— 用户会读成「Agent 拒绝了攻击」，语义正好反过来。
 *  tests/live-turns.test.ts 直接读 app/redteam.py 对刑，改了文案会立刻红。
 *
 *  注意：**回归/模拟侧没有 marker**。app/testrun.py 的 emit_turn 直接发真 output，
 *  0 字节就是空串（invoke 抛异常那条路直接 return，连 agent 侧那条 turn 都不发）
 *  —— 故被测侧空响应在这两类环节里表现为**空 message**，另判（见 blankKindOf）。 */
export const BLANK_TARGET_PREFIX = "[被测 Agent 返回空响应";
export const INVOKE_FAILED_PREFIX = "[被测 Agent 调用失败";

/** 每栏默认渲染的最近轮数（屏占恒定，不随轮数增长） */
export const LANE_TAIL = 3;
/** 每栏**内存上限**：超出的老轮次真丢弃（不是隐藏）。
 *  上界推导：单次攻击最多 10 轮 × 每轮 2 条（攻+靶）= 20 条事件，24 留了余量，
 *  故「展开本路」在正常长度的攻击/用例里就是全文；再早的只剩计数。 */
export const LANE_KEEP = 24;
/** 红队同屏保留的路数 = 后端 MAX_CONCURRENT_ATTACKS（app/redteam.py:119）。
 *  超出时按「最久没动静」淘汰：并发上限内被淘汰的必然是已结束的那路。 */
export const LANE_CAP = 3;
/** 回归/模拟同屏保留的路数 = 后端 RUN_TTL_BATCH（app/testrun.py:34 的并发 agent
 *  调用数）。两类环节并发上限不同，故**按来源各自封顶** —— 用一个共同上限会让
 *  红队那 3 路把正在跑的用例路挤掉（或反之）。 */
export const LANE_CAP_DATASET = 5;

/** 事件来源。dataset = 回归/模拟（后端两者同走 dataset runner，见 kindLabel 注释） */
export type TurnKind = "redteam" | "dataset";

/** 后端已知的 role 全集：
 *    attacker / target —— app/redteam.py（闭集，后端只可能发这两个）
 *    user / agent      —— app/testrun.py（三个调用点全是这两个字面量）
 *  `other` 不是后端值，是**兜底档**：turn 的 role 有一条来自历史落盘数据的通路
 *  （app/testrun.py:663 缓存命中回放读 conversation 里的 t["role"]），出现第三种
 *  值时原样显示，不丢、不瞎归类、不崩。 */
export type TurnRole = "attacker" | "target" | "user" | "agent" | "other";
/** 会话里的两侧：probe = 发起方（攻击方 / 模拟用户），subject = 被测 Agent。
 *  空响应判定只对 subject 侧生效。 */
export type TurnSide = "probe" | "subject" | "other";
/** silenced = 被测侧 0 字节（多为其自身内容过滤）；errored = 调用失败，本轮未送达 */
export type BlankKind = "silenced" | "errored";

const SIDE_OF: Record<TurnRole, TurnSide> = {
  attacker: "probe", user: "probe",
  target: "subject", agent: "subject",
  other: "other",
};

export function sideOf(role: TurnRole): TurnSide {
  return SIDE_OF[role] ?? "other";
}

export interface LiveTurn {
  /** 全局递增序号：turn_no 有空洞、跨路不唯一，React key 用这个 */
  seq: number;
  role: TurnRole;
  /** 未在已知集合里的 role 原文（role === "other" 时才有），用于兜底显示 */
  roleRaw: string | null;
  /** 后端 turn_no；缺失时为 null（界面显示「—」，不参与任何索引） */
  turnNo: number | null;
  message: string;
  /** 前端接收时刻（后端逐轮事件不带时间戳） */
  ts: number;
  blank: BlankKind | null;
}

export interface LiveLane {
  /** 分栏键：红队 = `redteam:attack#N`；回归/模拟 = `dataset:<case>@<agent>`
   *  （含 agent 是硬要求 —— turn_no 的计数域就是 case@agent，见顶部差异 3） */
  key: string;
  kind: TurnKind;
  /** 后端 case 字段原文。红队侧是 attack#N（构造序号），另两类是真用例名 */
  caseKey: string;
  /** 后端 agent 字段；attack_turn 没有这个字段 → null */
  agentName: string | null;
  /** 尾窗内保留的轮次（≤ LANE_KEEP，老的已真丢弃） */
  turns: LiveTurn[];
  /** 本路已丢弃的老轮次数（只留计数，不留全文） */
  dropped: number;
  /** 本路累计轮次 = dropped + turns.length */
  total: number;
  /** 本路被测侧空响应/调用失败的轮次数（含已丢弃的） */
  blank: number;
  /** 最近一轮的接收时刻 */
  lastTs: number;
}

export interface LiveTurnsState {
  /** 按**首次出现顺序**排列（列位置稳定，不随活跃度跳动） */
  lanes: LiveLane[];
  total: number;
  attacker: number;
  target: number;
  /** role === "user" 的轮数（回归/模拟的发起侧） */
  user: number;
  /** role === "agent" 的轮数（回归/模拟的被测侧） */
  agent: number;
  /** 未知 role 的轮数（兜底档，正常应恒为 0） */
  other: number;
  blank: number;
  /** 因超过路数上限被整路淘汰的路数 / 轮次数（诚实交代，不假装没发生过） */
  retiredLanes: number;
  retiredTurns: number;
}

export const EMPTY_LIVE_TURNS: LiveTurnsState = {
  lanes: [], total: 0, attacker: 0, target: 0, user: 0, agent: 0, other: 0,
  blank: 0, retiredLanes: 0, retiredTurns: 0,
};

/** 该来源的同屏路数上限 */
export function laneCapOf(kind: TurnKind): number {
  return kind === "redteam" ? LANE_CAP : LANE_CAP_DATASET;
}

/**
 * 被测侧空响应识别。probe 侧永不判空（marker 只由被测侧产生）。
 *
 * 两类来源的空响应形态**不同**：
 *   · 红队：后端塞 marker 占位（AgentCoreTargetSession 把 0 字节替换成
 *     BLANK_TARGET_MARKER / INVOKE_FAILED_MARKER）→ 靠前缀识别
 *   · 回归/模拟：后端**不塞 marker**，emit_turn 发的就是真 output，0 字节就是
 *     空串（app/testrun.py:682）→ 靠 message 为空识别。口径与后端
 *     `_is_blank_output`（app/testrun.py:412，用 .strip()）一致。
 */
export function blankKindOf(role: TurnRole, message: string): BlankKind | null {
  if (sideOf(role) !== "subject") return null;
  if (message.startsWith(BLANK_TARGET_PREFIX)) return "silenced";
  if (message.startsWith(INVOKE_FAILED_PREFIX)) return "errored";
  // 回归/模拟侧的 0 字节：既未回答也未拒绝，与「真的回了一句空话」不可能混淆
  if (message.trim() === "") return "silenced";
  return null;
}

export interface ParsedLiveTurn {
  key: string;
  kind: TurnKind;
  caseKey: string;
  agentName: string | null;
  role: TurnRole;
  roleRaw: string | null;
  turnNo: number | null;
  message: string;
  blank: BlankKind | null;
}

/** 分栏键。回归/模拟必须带 agent（turn_no 的计数域就是 case@agent） */
export function laneKeyOf(kind: TurnKind, caseKey: string, agentName: string | null): string {
  return kind === "redteam" ? `redteam:${caseKey}`
    : `dataset:${caseKey}@${agentName ?? ""}`;
}

/**
 * turn / attack_turn 事件 → 规范化轮次；其它事件或缺 case 返回 null。
 *
 * role 的容忍度**按来源分开**，这是有意为之：
 *   · attack_turn 的 role 是后端闭集（只可能 attacker/target），出现第三种说明
 *     契约变了 —— 宁可整条丢弃也不瞎归类（把 judge 旁白画成靶侧回复，会被读成
 *     「Agent 说了这句」，是安全结论级别的误导）。
 *   · turn 的 role 有一条来自**历史落盘数据**的通路（app/testrun.py:663 缓存
 *     命中回放读 conversation 记录里的 t["role"]），旧数据可能有别的值 →
 *     兜底成 other 原样显示，不丢内容。
 */
export function liveTurnOf(ev: ApiEvent): ParsedLiveTurn | null {
  const rec = ev as { event: string } & Record<string, unknown>;
  const kind: TurnKind | null = rec.event === "attack_turn" ? "redteam"
    : rec.event === "turn" ? "dataset" : null;
  if (!kind) return null;

  const caseKey = typeof rec.case === "string" ? rec.case.trim() : "";
  if (!caseKey) return null; // 无法分桶，不编一个默认桶

  // attack_turn 没有 agent 字段 —— 不许假设存在
  const agentRaw = typeof rec.agent === "string" ? rec.agent.trim() : "";
  const agentName = kind === "dataset" && agentRaw ? agentRaw : null;

  const roleRawStr = typeof rec.role === "string" ? rec.role.trim() : "";
  let role: TurnRole;
  if (kind === "redteam") {
    if (roleRawStr !== "attacker" && roleRawStr !== "target") return null;
    role = roleRawStr;
  } else if (roleRawStr === "user" || roleRawStr === "agent") {
    role = roleRawStr;
  } else {
    role = "other";
  }
  const roleRaw = role === "other" ? (roleRawStr || "(未知)") : null;

  const message = typeof rec.message === "string" ? rec.message : "";
  const turnNo =
    typeof rec.turn_no === "number" && Number.isFinite(rec.turn_no) ? rec.turn_no : null;
  return {
    key: laneKeyOf(kind, caseKey, agentName),
    kind, caseKey, agentName, role, roleRaw, turnNo, message,
    blank: blankKindOf(role, message),
  };
}

/**
 * 累积一条 turn / attack_turn。返回新对象（不合契约的事件返回**原引用**，不触发重渲）。
 *
 * 尾窗语义：每路只保留最近 LANE_KEEP 条，超出的**从数组里删掉**并记进 dropped
 * ——长跑 12 攻击 × 10 轮 × 1500 字符会撑爆内存与 DOM，这是硬要求不是优化。
 *
 * 路数封顶**按来源各自计**：红队 3（= MAX_CONCURRENT_ATTACKS）、回归/模拟 5
 * （= RUN_TTL_BATCH）。混跑时两类互不淘汰 —— 用一个共同上限会让后到的红队路把
 * 正在跑的用例路挤掉。
 */
export function pushLiveTurn(
  state: LiveTurnsState,
  ev: ApiEvent,
  now: number,
): LiveTurnsState {
  const parsed = liveTurnOf(ev);
  if (!parsed) return state;

  const seq = state.total + 1;
  const turn: LiveTurn = {
    seq, role: parsed.role, roleRaw: parsed.roleRaw, turnNo: parsed.turnNo,
    message: parsed.message, ts: now, blank: parsed.blank,
  };

  const idx = state.lanes.findIndex((l) => l.key === parsed.key);
  const prev: LiveLane = idx >= 0 ? state.lanes[idx] : {
    key: parsed.key, kind: parsed.kind, caseKey: parsed.caseKey,
    agentName: parsed.agentName,
    turns: [], dropped: 0, total: 0, blank: 0, lastTs: now,
  };
  const kept = [...prev.turns, turn];
  const overflow = Math.max(0, kept.length - LANE_KEEP);
  const lane: LiveLane = {
    ...prev,
    turns: overflow > 0 ? kept.slice(overflow) : kept,
    dropped: prev.dropped + overflow,
    total: prev.total + 1,
    blank: prev.blank + (turn.blank ? 1 : 0),
    lastTs: now,
  };

  let lanes = idx >= 0
    ? state.lanes.map((l, i) => (i === idx ? lane : l))
    : [...state.lanes, lane];

  // 超过本来源的并发上限：淘汰**同来源**里最久没动静的那路
  //（并发窗口内它必然已结束）
  let retiredLanes = state.retiredLanes;
  let retiredTurns = state.retiredTurns;
  const cap = laneCapOf(parsed.kind);
  for (;;) {
    const same = lanes.filter((l) => l.kind === parsed.kind);
    if (same.length <= cap) break;
    let oldest = same[0];
    for (const l of same) if (l.lastTs < oldest.lastTs) oldest = l;
    retiredLanes += 1;
    retiredTurns += oldest.total;
    lanes = lanes.filter((l) => l !== oldest);
  }

  return {
    lanes,
    total: seq,
    attacker: state.attacker + (turn.role === "attacker" ? 1 : 0),
    target: state.target + (turn.role === "target" ? 1 : 0),
    user: state.user + (turn.role === "user" ? 1 : 0),
    agent: state.agent + (turn.role === "agent" ? 1 : 0),
    other: state.other + (turn.role === "other" ? 1 : 0),
    blank: state.blank + (turn.blank ? 1 : 0),
    retiredLanes,
    retiredTurns,
  };
}
