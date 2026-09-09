// 运行中实时对话：分桶 / 尾窗 / 空响应识别的纯逻辑测试 + 两侧后端契约护栏。
//
// 覆盖两种事件（三类环节）：
//   · attack_turn（红队，app/redteam.py:685）
//   · turn       （回归/模拟，app/testrun.py:601）
//
// 为什么要读 app/redteam.py 源码：实时期的 attack_turn 事件里**没有**
// silenced/errored 标志（emit_turn 只发 case/role/message/turn_no），
// 空响应只能靠 message 前缀识别 —— 而前缀是后端文案。文案一改，前端会静默
// 把空响应当成「靶侧真的回复了」渲染，用户读成「Agent 拒绝了攻击」，语义反转。
// 靠 review 记不住，就把它钉在 CI 里（同 contract-guard.test.ts 的思路）。
//
// 为什么还要读 app/testrun.py 源码：turn 侧的三处**真差异**（有 agent 字段 /
// case 是真用例名 / turn_no 计数域是 case@agent）全都只存在于后端源码里。
// 后端把 turn_counters 的 key 改回 case_name 的那天，前端分栏键就该跟着改 ——
// 不钉在 CI 里，同一用例多 agent 会静默串栏（两个 agent 的对话混进一栏，
// 用户读到的是一段拼接出来的假对话）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BLANK_TARGET_PREFIX, INVOKE_FAILED_PREFIX, EMPTY_LIVE_TURNS,
  LANE_CAP, LANE_CAP_DATASET, LANE_KEEP, LANE_TAIL,
  laneKeyOf, laneCapOf, sideOf,
  liveTurnOf, blankKindOf, pushLiveTurn, type LiveTurnsState,
} from "../src/pages/plan/liveTurns";
import {
  REDTEAM_LIVE_TURNS, MOCK_REDTEAM_RUN_ID,
  DATASET_LIVE_TURNS, MOCK_DATASET_RUN_ID,
  BLANK_TARGET_MARKER as BLANK_MARKER,
  INVOKE_FAILED_MARKER as FAILED_MARKER,
} from "../src/mocks/handlers";

const redteamPy = readFileSync(resolve(process.cwd(), "../app/redteam.py"), "utf8");
const testrunPy = readFileSync(resolve(process.cwd(), "../app/testrun.py"), "utf8");

// marker 全文不再在本文件手抄（simplify-r2 C4）：直接用 mocks/handlers.ts 导出的
// 那一份。下面「拼接后逐字对上」那条测试因此从「后端源码 ↔ 本文件抄本」变成
// 「后端源码 ↔ mock 真正流出的那个常量」—— 桩漂了这里就红，而此前桩可以自己漂
// 走（三份抄本只有两份被钉住）。liveTurns.ts 的 *_PREFIX 是**运行时**识别契约，
// 独立合法，仍由下面两条「是真前缀」的测试各自钉住。

/** 造一条契约形态的 attack_turn 事件（四个键，一个不多一个不少 + run_id） */
const turnEv = (
  caseKey: string, role: "attacker" | "target", turn_no: number, message: string,
) => ({ event: "attack_turn", run_id: "rt-20260824175230", case: caseKey, role, message, turn_no });

/** 按顺序灌一串事件 */
function feed(evs: Parameters<typeof pushLiveTurn>[1][], t0 = 1_000): LiveTurnsState {
  return evs.reduce<LiveTurnsState>(
    (st, ev, i) => pushLiveTurn(st, ev, t0 + i * 1_000), EMPTY_LIVE_TURNS);
}

const laneOf = (st: LiveTurnsState, key: string) =>
  st.lanes.find((l) => l.key === key)!;

/**
 * 从 app/testrun.py 抠出每个 emit_turn(...) 调用点的**第 3 个实参**（= role）。
 *
 * 为什么不能简单 split(",")：实参里有 `case["name"]` / `t["message"]` 这种带下标
 * 的表达式，逗号不在括号里但方括号里可能有别的逗号；且 def 行的形参要跳过。
 * 这里按括号/方括号深度切顶层逗号，深度为 0 的逗号才算分隔符。
 */
function emitTurnRoleArgs(py: string): string[] {
  const out: string[] = [];
  for (const m of py.matchAll(/emit_turn\(/g)) {
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    const parts: string[] = [];
    let cur = "";
    for (; i < py.length && depth > 0; i += 1) {
      const c = py[i];
      if (c === "(" || c === "[") depth += 1;
      else if (c === ")" || c === "]") depth -= 1;
      if (depth === 0) break;
      if (c === "," && depth === 1) { parts.push(cur); cur = ""; continue; }
      cur += c;
    }
    parts.push(cur);
    // def 行（形参带类型标注）不是调用点
    if (parts[0].trim().startsWith("case_name: str")) continue;
    out.push((parts[2] ?? "").trim());
  }
  return out;
}

// ==================== marker 契约护栏 ====================
describe("marker 契约：前端识别前缀与 app/redteam.py 文案对刑", () => {
  it("后端两个 marker 常量仍在原处（改名/删除即红）", () => {
    expect(redteamPy).toMatch(/^BLANK_TARGET_MARKER = \($/m);
    expect(redteamPy).toMatch(/^INVOKE_FAILED_MARKER = "/m);
  });

  it("BLANK_TARGET_PREFIX 是后端 BLANK_TARGET_MARKER 的真前缀", () => {
    // 后端文案本体确实出现在源码里（拼接式常量的首段）
    expect(redteamPy).toContain(BLANK_TARGET_PREFIX);
    expect(BLANK_MARKER.startsWith(BLANK_TARGET_PREFIX)).toBe(true);
  });

  it("INVOKE_FAILED_PREFIX 是后端 INVOKE_FAILED_MARKER 的真前缀", () => {
    expect(redteamPy).toContain(INVOKE_FAILED_PREFIX);
    expect(FAILED_MARKER.startsWith(INVOKE_FAILED_PREFIX)).toBe(true);
  });

  it("后端 marker 全文与本测试抄的一致（拼接后逐字对上）", () => {
    // 从源码把 BLANK_TARGET_MARKER 的四段字符串literal 抠出来重拼
    const block = /BLANK_TARGET_MARKER = \(([\s\S]*?)\)\n/.exec(redteamPy)![1];
    const joined = [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
    expect(joined, [
      "app/redteam.py 的 BLANK_TARGET_MARKER 文案变了。",
      "liveTurns.ts 的 BLANK_TARGET_PREFIX 与 mocks/handlers.ts 的副本必须同步，",
      "否则空响应会被当成靶侧真回复渲染（用户读成「Agent 拒绝了」，语义反转）。",
    ].join("")).toBe(BLANK_MARKER);
    const failed = /INVOKE_FAILED_MARKER = "([^"]*)"/.exec(redteamPy)![1];
    expect(failed).toBe(FAILED_MARKER);
  });

  it("两个 marker 都以 [ 开头 ] 结尾（识别靠前缀，与正常回复不可能撞）", () => {
    expect(BLANK_MARKER.startsWith("[")).toBe(true);
    expect(BLANK_MARKER.endsWith("]")).toBe(true);
    expect(FAILED_MARKER.startsWith("[")).toBe(true);
    // 调用失败的 marker 由后端拼 `…错误：{e}]`，闭合括号在拼接后
    expect(`${FAILED_MARKER}boom]`.endsWith("]")).toBe(true);
  });

  it("并发上限与后端 MAX_CONCURRENT_ATTACKS 一致（分栏列数由它定）", () => {
    const m = /^MAX_CONCURRENT_ATTACKS = (\d+)/m.exec(redteamPy)!;
    expect(LANE_CAP).toBe(Number(m[1]));
  });
});

// ==================== 空响应识别 ====================
describe("空响应识别（blankKindOf）", () => {
  it("靶侧 BLANK marker → silenced；INVOKE_FAILED marker → errored", () => {
    expect(blankKindOf("target", BLANK_MARKER)).toBe("silenced");
    expect(blankKindOf("target", `${FAILED_MARKER}ReadTimeout]`)).toBe("errored");
  });

  it("靶侧真回复 → null（不误伤）", () => {
    expect(blankKindOf("target", "抱歉，我不能列出其他旅客的候补名单。")).toBeNull();
    // 只是普通地以中括号开头也不算
    expect(blankKindOf("target", "[系统提示] 我可以协助您本人名下的订单改签。")).toBeNull();
  });

  it("攻击方消息永不判空——marker 只由靶侧产生，攻击方复述 marker 也不算", () => {
    expect(blankKindOf("attacker", BLANK_MARKER)).toBeNull();
  });
});

// ==================== 事件解析 ====================
describe("attack_turn 解析（liveTurnOf）", () => {
  it("契约形态四键 → 规范化轮次（kind=redteam，分栏键带来源前缀且**不含 agent**）", () => {
    const t = liveTurnOf(turnEv("attack#2", "target", 3, "好的"))!;
    expect(t).toEqual({
      key: "redteam:attack#2",
      kind: "redteam",
      caseKey: "attack#2",
      // attack_turn 没有 agent 字段 —— 这里恒 null 是差异 1 的类型级体现
      agentName: null,
      role: "target",
      roleRaw: null,
      turnNo: 3,
      message: "好的",
      blank: null,
    });
  });

  it("非 attack_turn 事件 → null（heartbeat/turn/终帧都不进对话桶）", () => {
    expect(liveTurnOf({ event: "heartbeat", plan_id: "p" })).toBeNull();
    expect(liveTurnOf({ event: "turn", run_id: "r" })).toBeNull();
    expect(liveTurnOf({ event: "plan_run_report" })).toBeNull();
  });

  it("role 只认 attacker/target：第三种值一律丢弃，不瞎归类", () => {
    expect(liveTurnOf({ ...turnEv("attack#1", "attacker", 1, "x"), role: "judge" })).toBeNull();
    expect(liveTurnOf({ ...turnEv("attack#1", "attacker", 1, "x"), role: undefined })).toBeNull();
  });

  it("缺 case → 丢弃（无法分桶，不编一个默认桶）", () => {
    expect(liveTurnOf({ ...turnEv("attack#1", "attacker", 1, "x"), case: "" })).toBeNull();
    expect(liveTurnOf({ ...turnEv("attack#1", "attacker", 1, "x"), case: 7 })).toBeNull();
  });

  it("turn_no 缺失/非数字 → null（界面显示「—」，绝不当数组索引）", () => {
    expect(liveTurnOf({ ...turnEv("attack#1", "attacker", 1, "x"), turn_no: undefined })!.turnNo)
      .toBeNull();
    expect(liveTurnOf({ ...turnEv("attack#1", "attacker", 1, "x"), turn_no: "3" })!.turnNo)
      .toBeNull();
  });
});

// ==================== 分桶 ====================
describe("按 case 分桶（pushLiveTurn）", () => {
  it("三路并发交错到达 → 三桶各自成序，栏序按首次出现（列位置不跳动）", () => {
    const st = feed([
      turnEv("attack#1", "attacker", 1, "a1-1"),
      turnEv("attack#2", "attacker", 1, "a2-1"),
      turnEv("attack#1", "target", 2, "a1-2"),
      turnEv("attack#3", "attacker", 1, "a3-1"),
      turnEv("attack#2", "target", 2, "a2-2"),
    ]);
    expect(st.lanes.map((l) => l.caseKey)).toEqual(["attack#1", "attack#2", "attack#3"]);
    expect(laneOf(st, "redteam:attack#1").turns.map((t) => t.message)).toEqual(["a1-1", "a1-2"]);
    expect(laneOf(st, "redteam:attack#3").total).toBe(1);
    expect(st.total).toBe(5);
    expect(st.attacker).toBe(3);
    expect(st.target).toBe(2);
  });

  it("不合契约的事件返回**原引用**（不触发无谓重渲）", () => {
    const st = feed([turnEv("attack#1", "attacker", 1, "x")]);
    expect(pushLiveTurn(st, { event: "heartbeat" }, 9_999)).toBe(st);
  });

  it("turn_no 空洞容忍：4 → 7 不补齐、不排序、不当索引", () => {
    const st = feed([
      turnEv("attack#1", "attacker", 4, "第四轮"),
      turnEv("attack#1", "attacker", 7, "第七轮"),
    ]);
    const lane = laneOf(st, "redteam:attack#1");
    expect(lane.turns.map((t) => t.turnNo)).toEqual([4, 7]);
    // total 是**实际收到**的条数，不是 turn_no 最大值
    expect(lane.total).toBe(2);
  });

  it("空响应计数按路与全局各记一份（含已丢弃的轮次）", () => {
    const st = feed([
      turnEv("attack#1", "target", 2, BLANK_MARKER),
      turnEv("attack#1", "target", 4, `${FAILED_MARKER}boom]`),
      turnEv("attack#2", "target", 2, "真回复"),
    ]);
    expect(laneOf(st, "redteam:attack#1").blank).toBe(2);
    expect(laneOf(st, "redteam:attack#2").blank).toBe(0);
    expect(st.blank).toBe(2);
  });

  it("seq 全局唯一递增：turn_no 有空洞、跨 case 会重复，React key 必须用 seq", () => {
    const st = feed([
      turnEv("attack#1", "attacker", 1, "x"),
      turnEv("attack#2", "attacker", 1, "y"), // 与上一条 turn_no 相同
    ]);
    const seqs = st.lanes.flatMap((l) => l.turns.map((t) => t.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

// ==================== 尾窗：真丢弃老轮次 ====================
describe("尾窗（内存/DOM 上界，硬要求不是优化）", () => {
  it(`单路超 LANE_KEEP=${LANE_KEEP} 条 → 老轮次从数组里**删掉**，只留 dropped 计数`, () => {
    const evs = Array.from({ length: 40 }, (_, i) =>
      turnEv("attack#1", i % 2 === 0 ? "attacker" : "target", i + 1, `m${i}`));
    const lane = laneOf(feed(evs), "redteam:attack#1");
    expect(lane.turns).toHaveLength(LANE_KEEP);
    expect(lane.dropped).toBe(40 - LANE_KEEP);
    expect(lane.total).toBe(40);
    // 被丢弃的全文真的不在内存里了（不是 CSS 隐藏）
    const kept = lane.turns.map((t) => t.message);
    expect(kept).not.toContain("m0");
    expect(kept[0]).toBe(`m${40 - LANE_KEEP}`);
    expect(kept.at(-1)).toBe("m39");
  });

  it("线上实证规模（216 条 / 18 路 / turn_no 到 10）：DOM 与内存都恒定", () => {
    // 线上一次崩掉的 run：live_turns 216 条、case 到 attack#18、turn_no 到 10
    const evs: ReturnType<typeof turnEv>[] = [];
    for (let atk = 1; atk <= 18; atk += 1) {
      for (let n = 1; n <= 12; n += 1) {
        evs.push(turnEv(`attack#${atk}`, n % 2 === 1 ? "attacker" : "target", n, "x".repeat(1500)));
      }
    }
    expect(evs).toHaveLength(216);
    const st = feed(evs);
    // 路数封顶（超出的整路淘汰），每路条数封顶
    expect(st.lanes.length).toBeLessThanOrEqual(LANE_CAP);
    for (const l of st.lanes) expect(l.turns.length).toBeLessThanOrEqual(LANE_KEEP);
    // 内存上界：LANE_CAP × LANE_KEEP × 1500 字符
    const chars = st.lanes.reduce(
      (n, l) => n + l.turns.reduce((m, t) => m + t.message.length, 0), 0);
    expect(chars).toBeLessThanOrEqual(LANE_CAP * LANE_KEEP * 1500);
    // 累计计数仍然诚实（不因丢弃而少算）
    expect(st.total).toBe(216);
    expect(st.retiredTurns + st.lanes.reduce((n, l) => n + l.total, 0)).toBe(216);
  });

  it(`超 LANE_CAP=${LANE_CAP} 路时淘汰**最久没动静**的那路（活跃路不丢）`, () => {
    let st = EMPTY_LIVE_TURNS;
    st = pushLiveTurn(st, turnEv("attack#1", "attacker", 1, "老路"), 1_000);
    st = pushLiveTurn(st, turnEv("attack#2", "attacker", 1, "b"), 2_000);
    st = pushLiveTurn(st, turnEv("attack#3", "attacker", 1, "c"), 3_000);
    // attack#2 又动了一下 → 此时最久没动静的是 attack#1
    st = pushLiveTurn(st, turnEv("attack#2", "target", 2, "b2"), 4_000);
    st = pushLiveTurn(st, turnEv("attack#4", "attacker", 1, "新路"), 5_000);
    expect(st.lanes.map((l) => l.caseKey)).toEqual(["attack#2", "attack#3", "attack#4"]);
    expect(st.retiredLanes).toBe(1);
    expect(st.retiredTurns).toBe(1);
  });

  it("尾窗默认露出的是最近 LANE_TAIL 轮（界面切片口径）", () => {
    const evs = Array.from({ length: 8 }, (_, i) =>
      turnEv("attack#1", "attacker", i + 1, `m${i}`));
    const lane = laneOf(feed(evs), "redteam:attack#1");
    expect(lane.turns.slice(-LANE_TAIL).map((t) => t.message)).toEqual(["m5", "m6", "m7"]);
  });
});

// ==================== mock 与真后端同刑 ====================
describe("mock 契约：REDTEAM_LIVE_TURNS 与真后端 yield 形态逐字一致", () => {
  it("每条只有 case/role/message/turn_no 四个键", () => {
    for (const [, t] of REDTEAM_LIVE_TURNS) {
      expect(Object.keys(t).sort()).toEqual(["case", "message", "role", "turn_no"]);
    }
  });

  it("case 一律 attack#N；role 只有 attacker/target；turn_no 是正整数", () => {
    for (const [, t] of REDTEAM_LIVE_TURNS) {
      expect(t.case).toMatch(/^attack#\d+$/);
      expect(["attacker", "target"]).toContain(t.role);
      expect(Number.isInteger(t.turn_no) && t.turn_no > 0).toBe(true);
    }
  });

  it("message 不超后端截断上限 1500 字符", () => {
    for (const [, t] of REDTEAM_LIVE_TURNS) {
      expect(t.message.length).toBeLessThanOrEqual(1500);
    }
  });

  it("桩里含两种 marker 与一处 turn_no 空洞（三种真实形态都能被手验到）", () => {
    const msgs = REDTEAM_LIVE_TURNS.map(([, t]) => t.message);
    expect(msgs.some((m) => m === BLANK_MARKER)).toBe(true);
    expect(msgs.some((m) => m.startsWith(FAILED_MARKER))).toBe(true);
    const nos = REDTEAM_LIVE_TURNS.filter(([, t]) => t.case === "attack#1").map(([, t]) => t.turn_no);
    expect(nos.some((n, i) => i > 0 && n - nos[i - 1] > 1)).toBe(true);
  });

  it("run_id 形态照后端（rt-YYYYmmddHHMMSS）", () => {
    expect(MOCK_REDTEAM_RUN_ID).toMatch(/^rt-\d{14}$/);
  });

  it("桩灌进真逻辑后分出 3 路（= 并发上限），且识别出两种空响应", () => {
    const st = feed(REDTEAM_LIVE_TURNS.map(([, t]) => ({ event: "attack_turn", ...t })));
    expect(st.lanes).toHaveLength(3);
    expect(st.blank).toBe(3);
    const kinds = st.lanes.flatMap((l) => l.turns.map((t) => t.blank)).filter(Boolean);
    expect(new Set(kinds)).toEqual(new Set(["silenced", "errored"]));
  });
});

// ============================================================================
//                      turn 事件（回归 / 模拟）
// ============================================================================
//
// 造一条契约形态的 turn 事件。**五个键**（比 attack_turn 多一个 agent）+ run_id，
// 形态照 app/testrun.py:605-606。
const dsEv = (
  caseKey: string, agent: string, role: string, turn_no: number, message: string,
) => ({
  event: "turn", run_id: MOCK_DATASET_RUN_ID,
  case: caseKey, agent, role, message, turn_no,
});

// ==================== 后端契约护栏（testrun.py 对刑）====================
describe("turn 契约：与 app/testrun.py 源码对刑", () => {
  it("emit_turn 仍发 case/agent/role/message/turn_no 五个键（少一个即红）", () => {
    // app/testrun.py:605-606 的字面 dict
    const block = /ev = \{"case": case_name, "agent": agent_name, "role": role,\s*\n\s*"message": message\[:1500\], "turn_no": turn_counters\[key\]\}/
      .exec(testrunPy);
    expect(block, [
      "app/testrun.py 的 emit_turn 事件形态变了。",
      "liveTurns.ts 的 liveTurnOf 与 mocks/handlers.ts 的 DATASET_LIVE_TURNS 必须同步。",
    ].join("")).not.toBeNull();
  });

  it("turn_no 的计数域仍是 case@agent —— 分栏键含 agent 的**唯一理由**", () => {
    // app/testrun.py:603。后端改回按 case 计数的那天这里就该红：
    // 计数域一变，同一 case 多 agent 的 turn_no 就不再重复，分栏键可以简化。
    expect(/key = f"\{case_name\}@\{agent_name\}"/.test(testrunPy), [
      "app/testrun.py 的 turn_counters key 变了。",
      "turn_no 的计数域决定分栏键必须含 agent（否则同一用例多 agent 会串栏）。",
    ].join("")).toBe(true);
  });

  it("emit_turn 的 role 实参只有 user/agent 两种字面量（+ 缓存回放的 t[\"role\"]）", () => {
    // 抠出所有 emit_turn(...) 调用点的**第 3 个实参**（= role）。
    // 不能用 /"([^"]*)"/ 扫整段实参：case["name"] / case["input"] 里的下标也是
    // 字符串字面量，会把 name/input 一起扫进来（这条测试第一版就是这么错的）。
    const args = emitTurnRoleArgs(testrunPy);
    expect(args.length, "app/testrun.py 的 emit_turn 调用点少了（原有 4 处）").toBe(4);
    // 逐字对刑：两处字面量 + 多轮模拟的 on_turn 转发 + 缓存回放的历史 conversation
    expect([...args].sort()).toEqual(['"agent"', '"user"', 'role', 't["role"]']);
    // 兜底档存在的**唯一理由**就是 t["role"]（读历史落盘数据，值不受当前代码约束）
    expect(args).toContain('t["role"]');
  });

  it("on_turn 回调（多轮模拟）也只传 user/agent", () => {
    // app/testrun.py:284/:287
    expect(testrunPy).toContain('on_turn("user", user_message)');
    expect(/on_turn\("agent", agent_message\[:2000\]\)/.test(testrunPy)).toBe(true);
  });

  it("回归/模拟侧**没有** marker：0 字节就是空 message（空响应靠空串识别）", () => {
    // testrun.py 只在注释里提过 redteam.BLANK_TARGET_MARKER，不定义/不塞自己的
    expect(/^BLANK_TARGET_MARKER\s*=/m.test(testrunPy)).toBe(false);
    expect(/^INVOKE_FAILED_MARKER\s*=/m.test(testrunPy)).toBe(false);
    // 被测侧那条 turn 直接发真 output（app/testrun.py:682）
    expect(testrunPy).toContain('emit_turn(case["name"], agent_name, "agent", output[:1500])');
  });

  it("回归/模拟同屏路数上限与后端 RUN_TTL_BATCH 一致", () => {
    const m = /^RUN_TTL_BATCH = (\d+)/m.exec(testrunPy)!;
    expect(LANE_CAP_DATASET).toBe(Number(m[1]));
  });
});

// ==================== 三处真差异 ====================
describe("差异 1：agent 字段 turn 有 / attack_turn 没有", () => {
  it("turn 事件的 agent 落进 lane.agentName", () => {
    const t = liveTurnOf(dsEv("faq-baggage-allowance", "support-bot", "user", 1, "问"))!;
    expect(t.agentName).toBe("support-bot");
    expect(t.kind).toBe("dataset");
  });

  it("attack_turn 没有 agent 字段 → agentName 恒 null（不许假设存在）", () => {
    const t = liveTurnOf(turnEv("attack#1", "attacker", 1, "开场"))!;
    expect(t.agentName).toBeNull();
    expect(t.kind).toBe("redteam");
  });

  it("turn 的 agent 缺失/空串 → null，不崩、不编一个名字", () => {
    const noAgent = { event: "turn", run_id: "r", case: "c", role: "user", turn_no: 1, message: "x" };
    const t = liveTurnOf(noAgent)!;
    expect(t).not.toBeNull();
    expect(t.agentName).toBeNull();
    // 仍然能分桶（用例名还在），只是栏头没有 agent 名可显示
    expect(t.key).toBe("dataset:c@");
  });
});

describe("差异 2：case 语义 —— turn 是真用例名，attack_turn 是构造序号", () => {
  it("turn 的 caseKey 原样保留真用例名（不解析、不改写）", () => {
    const st = feed([dsEv("airline-rebooking-dialog", "support-bot", "user", 1, "问")]);
    expect(st.lanes[0].caseKey).toBe("airline-rebooking-dialog");
    expect(st.lanes[0].kind).toBe("dataset");
  });

  it("attack_turn 的 caseKey 仍是 attack#N，语义**不变**（不做猜用例名的映射）", () => {
    const st = feed([turnEv("attack#7", "attacker", 1, "开场")]);
    expect(st.lanes[0].caseKey).toBe("attack#7");
    expect(st.lanes[0].kind).toBe("redteam");
    expect(st.lanes[0].agentName).toBeNull();
  });

  it("分栏键带来源前缀：用例名恰好叫 attack#1 也不会与红队那路撞", () => {
    const st = feed([
      turnEv("attack#1", "attacker", 1, "红队那路"),
      dsEv("attack#1", "support-bot", "user", 1, "一个刚好同名的用例"),
    ]);
    expect(st.lanes).toHaveLength(2);
    expect(st.lanes.map((l) => l.kind)).toEqual(["redteam", "dataset"]);
    expect(laneOf(st, "redteam:attack#1").turns[0].message).toBe("红队那路");
    expect(laneOf(st, "dataset:attack#1@support-bot").turns[0].message)
      .toBe("一个刚好同名的用例");
  });
});

describe("差异 3：turn_no 计数域 = case@agent → 分栏键必须含 agent", () => {
  it("同一用例两个 agent：turn_no 重复也**分成两栏**，内容不串", () => {
    const st = feed([
      dsEv("airline-rebooking-dialog", "support-bot", "user", 1, "A 的第一轮"),
      dsEv("airline-rebooking-dialog", "research-agent", "user", 1, "B 的第一轮"),
      dsEv("airline-rebooking-dialog", "support-bot", "agent", 2, "A 的第二轮"),
      dsEv("airline-rebooking-dialog", "research-agent", "agent", 2, "B 的第二轮"),
    ]);
    expect(st.lanes).toHaveLength(2);
    const a = laneOf(st, "dataset:airline-rebooking-dialog@support-bot");
    const b = laneOf(st, "dataset:airline-rebooking-dialog@research-agent");
    expect(a.turns.map((t) => t.message)).toEqual(["A 的第一轮", "A 的第二轮"]);
    expect(b.turns.map((t) => t.message)).toEqual(["B 的第一轮", "B 的第二轮"]);
    // 两栏的 turn_no 各自从 1 起（这正是必须分栏的原因）
    expect(a.turns.map((t) => t.turnNo)).toEqual([1, 2]);
    expect(b.turns.map((t) => t.turnNo)).toEqual([1, 2]);
    // agent 名是两栏唯一的区分信息，必须留住
    expect(a.agentName).toBe("support-bot");
    expect(b.agentName).toBe("research-agent");
  });

  it("laneKeyOf：红队不带 agent，回归/模拟带（键形态本身就是这条纪律）", () => {
    expect(laneKeyOf("redteam", "attack#2", null)).toBe("redteam:attack#2");
    expect(laneKeyOf("dataset", "case-a", "bot")).toBe("dataset:case-a@bot");
  });

  it("seq 全局唯一：两栏 turn_no 都是 1，React key 用 seq 才不撞", () => {
    const st = feed([
      dsEv("c", "bot-a", "user", 1, "x"),
      dsEv("c", "bot-b", "user", 1, "y"),
    ]);
    const seqs = st.lanes.flatMap((l) => l.turns.map((t) => t.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

// ==================== role 取值与兜底 ====================
describe("turn 的 role：user/agent 两值 + 未知值兜底（不丢内容、不瞎归类）", () => {
  it("user → probe 侧；agent → subject 侧", () => {
    expect(liveTurnOf(dsEv("c", "b", "user", 1, "问"))!.role).toBe("user");
    expect(liveTurnOf(dsEv("c", "b", "agent", 2, "答"))!.role).toBe("agent");
    expect(sideOf("user")).toBe("probe");
    expect(sideOf("agent")).toBe("subject");
    expect(sideOf("attacker")).toBe("probe");
    expect(sideOf("target")).toBe("subject");
  });

  it("未知 role（缓存回放的历史 conversation）→ other + 保留原文，**不丢这一条**", () => {
    const t = liveTurnOf(dsEv("c", "b", "system", 1, "历史落盘数据里的第三种角色"))!;
    expect(t.role).toBe("other");
    expect(t.roleRaw).toBe("system");
    expect(t.message).toBe("历史落盘数据里的第三种角色");
    // 未知侧不判空（不知道是不是被测侧说的，就不给空响应结论）
    expect(blankKindOf("other", "")).toBeNull();
  });

  it("role 缺失 → other，roleRaw 给「(未知)」占位而不是空白", () => {
    const t = liveTurnOf({
      event: "turn", run_id: "r", case: "c", agent: "b", turn_no: 1, message: "x",
    })!;
    expect(t.role).toBe("other");
    expect(t.roleRaw).toBe("(未知)");
  });

  it("红队侧**不**兜底：role 第三值整条丢弃（把 judge 旁白画成靶侧回复是安全级误导）", () => {
    expect(liveTurnOf({ ...turnEv("attack#1", "attacker", 1, "x"), role: "judge" })).toBeNull();
    expect(liveTurnOf({ ...turnEv("attack#1", "attacker", 1, "x"), role: "user" })).toBeNull();
  });

  it("other 计数单列，不混进 user/agent（正常运行里它应恒为 0）", () => {
    const st = feed([
      dsEv("c", "b", "user", 1, "问"),
      dsEv("c", "b", "agent", 2, "答"),
      dsEv("c", "b", "tool", 3, "工具调用"),
    ]);
    expect([st.user, st.agent, st.other]).toEqual([1, 1, 1]);
    expect([st.attacker, st.target]).toEqual([0, 0]);
  });
});

// ==================== 回归/模拟侧的空响应（无 marker）====================
describe("回归/模拟的空响应：0 字节就是空 message（后端不塞 marker）", () => {
  it("agent 侧空串/纯空白 → silenced", () => {
    expect(blankKindOf("agent", "")).toBe("silenced");
    expect(blankKindOf("agent", "   \n ")).toBe("silenced");
  });

  it("user 侧空串**不**判空 —— 空响应是被测侧的结论，不是输入侧的", () => {
    expect(blankKindOf("user", "")).toBeNull();
  });

  it("agent 侧真回复不误伤（含以中括号开头的正常回复）", () => {
    expect(blankKindOf("agent", "国内经济舱免费托运 20kg。")).toBeNull();
    expect(blankKindOf("agent", "[系统提示] 已为您查询。")).toBeNull();
  });

  it("栏内空响应计数与全局各记一份", () => {
    const st = feed([
      dsEv("c1", "bot", "user", 1, "问"),
      dsEv("c1", "bot", "agent", 2, ""),
      dsEv("c2", "bot", "agent", 2, "真回复"),
    ]);
    expect(laneOf(st, "dataset:c1@bot").blank).toBe(1);
    expect(laneOf(st, "dataset:c2@bot").blank).toBe(0);
    expect(st.blank).toBe(1);
  });
});

// ==================== 混跑：两类互不淘汰 ====================
describe("三环节混跑（用户当下真跑的形态）：turn 与 attack_turn 各自封顶", () => {
  it("路数上限按来源各自计：红队 3 / 回归模拟 5，混跑同屏最多 8 路", () => {
    expect(laneCapOf("redteam")).toBe(LANE_CAP);
    expect(laneCapOf("dataset")).toBe(LANE_CAP_DATASET);
    const evs = [
      ...Array.from({ length: 6 }, (_, i) => dsEv(`case-${i}`, "bot", "user", 1, `d${i}`)),
      ...Array.from({ length: 5 }, (_, i) => turnEv(`attack#${i}`, "attacker", 1, `a${i}`)),
    ];
    const st = feed(evs);
    expect(st.lanes.filter((l) => l.kind === "dataset")).toHaveLength(LANE_CAP_DATASET);
    expect(st.lanes.filter((l) => l.kind === "redteam")).toHaveLength(LANE_CAP);
  });

  it("红队路超限时淘汰的是**红队**里最久没动静那路，不动用例路", () => {
    let st = EMPTY_LIVE_TURNS;
    // 用例路最早出现且之后再没动静——但它不该被红队的溢出淘汰
    st = pushLiveTurn(st, dsEv("老用例", "bot", "user", 1, "很早的一轮"), 1_000);
    st = pushLiveTurn(st, turnEv("attack#1", "attacker", 1, "a1"), 2_000);
    st = pushLiveTurn(st, turnEv("attack#2", "attacker", 1, "a2"), 3_000);
    st = pushLiveTurn(st, turnEv("attack#3", "attacker", 1, "a3"), 4_000);
    st = pushLiveTurn(st, turnEv("attack#4", "attacker", 1, "a4"), 5_000);
    expect(st.lanes.map((l) => l.key)).toEqual([
      "dataset:老用例@bot", "redteam:attack#2", "redteam:attack#3", "redteam:attack#4",
    ]);
    expect(st.retiredLanes).toBe(1);
  });

  it("用例路超限时淘汰的是**用例**里最久没动静那路，不动红队路", () => {
    let st = EMPTY_LIVE_TURNS;
    st = pushLiveTurn(st, turnEv("attack#1", "attacker", 1, "很早的攻击"), 1_000);
    for (let i = 1; i <= 6; i += 1) {
      st = pushLiveTurn(st, dsEv(`case-${i}`, "bot", "user", 1, `d${i}`), 1_000 + i * 1_000);
    }
    expect(st.lanes.filter((l) => l.kind === "redteam").map((l) => l.caseKey))
      .toEqual(["attack#1"]);
    expect(st.lanes.filter((l) => l.kind === "dataset").map((l) => l.caseKey))
      .toEqual(["case-2", "case-3", "case-4", "case-5", "case-6"]);
    expect(st.retiredLanes).toBe(1);
  });

  it("交错到达不串栏：同一时刻两类事件各进自己的桶", () => {
    const st = feed([
      dsEv("faq-baggage-allowance", "support-bot", "user", 1, "托运额度？"),
      turnEv("attack#1", "attacker", 1, "值班经理话术"),
      dsEv("faq-baggage-allowance", "support-bot", "agent", 2, "20kg。"),
      turnEv("attack#1", "target", 2, "需要订单号"),
    ]);
    expect(st.lanes).toHaveLength(2);
    expect(laneOf(st, "dataset:faq-baggage-allowance@support-bot").turns.map((t) => t.message))
      .toEqual(["托运额度？", "20kg。"]);
    expect(laneOf(st, "redteam:attack#1").turns.map((t) => t.message))
      .toEqual(["值班经理话术", "需要订单号"]);
    // 两组角色计数互不污染
    expect([st.user, st.agent, st.attacker, st.target]).toEqual([1, 1, 1, 1]);
  });

  it("尾窗对 turn 同样生效（长跑用例的内存/DOM 也恒定）", () => {
    const evs = Array.from({ length: 40 }, (_, i) =>
      dsEv("long-case", "bot", i % 2 === 0 ? "user" : "agent", i + 1, `m${i}`));
    const lane = laneOf(feed(evs), "dataset:long-case@bot");
    expect(lane.turns).toHaveLength(LANE_KEEP);
    expect(lane.dropped).toBe(40 - LANE_KEEP);
    expect(lane.total).toBe(40);
    expect(lane.turns.map((t) => t.message)).not.toContain("m0");
  });
});

// ==================== mock 与真后端同刑（turn 侧）====================
describe("mock 契约：DATASET_LIVE_TURNS 与真后端 yield 形态逐字一致", () => {
  it("每条**五个键**：case/agent/role/message/turn_no（比 attack_turn 多 agent）", () => {
    for (const [, t] of DATASET_LIVE_TURNS) {
      expect(Object.keys(t).sort())
        .toEqual(["agent", "case", "message", "role", "turn_no"]);
    }
  });

  it("case 是**真用例名**（不是 attack#N），role 只有 user/agent，turn_no 正整数", () => {
    for (const [, t] of DATASET_LIVE_TURNS) {
      expect(t.case).not.toMatch(/^attack#\d+$/);
      expect(t.case).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(["user", "agent"]).toContain(t.role);
      expect(Number.isInteger(t.turn_no) && t.turn_no > 0).toBe(true);
    }
  });

  it("message 不超后端截断上限 1500，且有一条**贴着上限**（测截断/换行表现）", () => {
    const lens = DATASET_LIVE_TURNS.map(([, t]) => t.message.length);
    for (const n of lens) expect(n).toBeLessThanOrEqual(1500);
    expect(Math.max(...lens)).toBeGreaterThan(1400);
  });

  it("桩里有**同一 case 多 agent** 且 turn_no 重复（分栏键正确性的素材）", () => {
    const byCase = new Map<string, Set<string>>();
    for (const [, t] of DATASET_LIVE_TURNS) {
      if (!byCase.has(t.case)) byCase.set(t.case, new Set());
      byCase.get(t.case)!.add(t.agent);
    }
    const multi = [...byCase.entries()].filter(([, agents]) => agents.size > 1);
    expect(multi.length).toBeGreaterThanOrEqual(1);
    // 且这些 agent 的 turn_no 真的重复了（否则测不出串栏）
    const [caseName, agents] = multi[0];
    const firstNos = [...agents].map((a) =>
      DATASET_LIVE_TURNS.find(([, t]) => t.case === caseName && t.agent === a)![1].turn_no);
    expect(new Set(firstNos).size).toBe(1);
  });

  it("桩里有空 message（被测侧 0 字节）与一处 turn_no 空洞", () => {
    expect(DATASET_LIVE_TURNS.some(([, t]) => t.role === "agent" && t.message === "")).toBe(true);
    const nos = DATASET_LIVE_TURNS
      .filter(([, t]) => t.case === "airline-rebooking-dialog" && t.agent === "support-bot")
      .map(([, t]) => t.turn_no);
    expect(nos.some((n, i) => i > 0 && n - nos[i - 1] > 1)).toBe(true);
  });

  it("run_id 形态照后端（run-YYYYmmddHHMMSS，与红队的 rt- 前缀不同）", () => {
    expect(MOCK_DATASET_RUN_ID).toMatch(/^run-\d{14}$/);
    expect(MOCK_DATASET_RUN_ID).not.toMatch(/^rt-/);
  });

  it("桩灌进真逻辑后：多路分栏、同名用例双 agent 分开、识别出空响应", () => {
    const st = feed(DATASET_LIVE_TURNS.map(([, t]) => ({ event: "turn", ...t })));
    // 同一用例两个 agent 各成一栏
    expect(st.lanes.filter((l) => l.caseKey === "airline-rebooking-dialog")).toHaveLength(2);
    expect(st.blank).toBe(1);
    expect(st.lanes.every((l) => l.kind === "dataset")).toBe(true);
    // 每栏都带得动 agent 名（栏头要用它区分同名用例）
    expect(st.lanes.every((l) => Boolean(l.agentName))).toBe(true);
  });

  it("两桩混灌（三环节混跑）：两类各自分栏，谁都没被谁挤掉", () => {
    const st = feed([
      ...DATASET_LIVE_TURNS.map(([, t]) => ({ event: "turn", ...t })),
      ...REDTEAM_LIVE_TURNS.map(([, t]) => ({ event: "attack_turn", ...t })),
    ]);
    expect(st.lanes.filter((l) => l.kind === "redteam")).toHaveLength(3);
    expect(st.lanes.filter((l) => l.kind === "dataset").length)
      .toBeLessThanOrEqual(LANE_CAP_DATASET);
    expect(st.lanes.filter((l) => l.kind === "dataset").length).toBeGreaterThan(0);
    // 两侧空响应各自算对：红队 3（两种 marker）+ 回归 1（空串）
    expect(st.blank).toBe(4);
  });
});
