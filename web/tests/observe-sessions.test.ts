// 线上评估实时会话清单：状态层纯逻辑 + 两侧后端契约护栏。
//
// 为什么要读 app/observe.py 与 app/planrun.py 源码：这一格的四个数据坑全都只存在
// 于后端源码里，靠 review 记不住：
//   · score 可以是 null（observe.py `None if errored else …`）—— 当 0 用就是
//     「空响应被判 0 分」那类事故的同一个形状
//   · reason **可能不是字符串**：dataset 侧后端做了 str()（testrun.py:527），
//     observe 侧**没有**（observe.py 直接透传）→ 结构化 judge 的 reason 以对象上线，
//     直接渲染 React 抛 "Objects are not valid as a React child" → 白屏
//   · no_content:true 时后端把所有分数强制置 null（不是 0 分）
//   · observe_sessions（本批新增）必须在空会话分支**之后**才发
//
// 把这些钉在 CI 里：后端哪天把 str() 加上 / 把 null 改成 0 / 把分母事件挪到
// empty 分支之前，这里立刻红。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EMPTY_OBSERVE_SESSIONS, ROW_KEEP,
  doneCount, meanOf, observeRowOf, pushObserveSession, reasonText, scoresOf,
  shortSessionId, type ObserveSessionsState,
} from "../src/pages/plan/observeSessions";
import { OBSERVE_LIVE_SESSIONS, MOCK_OBSERVE_TOTAL } from "../src/mocks/handlers";

// 评估核心（evaluate_session / summarize / generate_analysis）住 observe.py：
// simplify-r2 L1 把它从 action 派发层（main.py）搬进领域层，消掉 main⇄planrun 的
// import 环。函数体逐字节未变，所以下面的断言字面量一个字都没改。
const observePy = readFileSync(resolve(process.cwd(), "../app/observe.py"), "utf8");
const testrunPy = readFileSync(resolve(process.cwd(), "../app/testrun.py"), "utf8");
const planrunPy = readFileSync(resolve(process.cwd(), "../app/planrun.py"), "utf8");
// 只为「口径只有一个住所」的反向断言而读（见下方第一个 it）：搬走之后 main.py 里
// 不许再有一份评估核心，否则否定式源码断言就会对着一个错文件永过。
const mainPy = readFileSync(resolve(process.cwd(), "../app/main.py"), "utf8");

/** 一条契约形态的 session_result */
const res = (id: string, results: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  event: "session_result", agent: "support-bot", session_id: id, span_count: 9,
  output_preview: "回复正文", results,
  metrics: null, transcript: null, diagnosis: null, ...extra,
});

const err = (id: string, error?: string) => ({
  event: "session_error", agent: "support-bot", session_id: id, span_count: 0,
  ...(error === undefined ? {} : { error }),
});

const ok = (score: number, reason: unknown = "理由") =>
  ({ score, passed: score >= 0.6, errored: false, reason });
const throttled = (reason = "An error occurred: ThrottlingException") =>
  ({ score: null, passed: null, errored: true, reason });

function feed(evs: Parameters<typeof pushObserveSession>[1][], t0 = 1_000): ObserveSessionsState {
  return evs.reduce<ObserveSessionsState>(
    (st, ev, i) => pushObserveSession(st, ev, t0 + i * 1_000), EMPTY_OBSERVE_SESSIONS);
}

const rowOf = (st: ObserveSessionsState, id: string) =>
  st.rows.find((r) => r.sessionId === id)!;

// ==================== 后端契约护栏 ====================
describe("后端契约：与 app/observe.py / app/planrun.py 源码对刑", () => {
  it("读取目标自证：否定式源码断言不许对着**不含该代码的文件**永过", () => {
    // 恒真陷阱：`not.toContain` 只要读错文件就永远绿，守卫被悄悄拆掉而 CI 无感。
    // 本块每条否定式都与它的正面对照同一个读取目标（:79/:80 正反同址，
    // observeBody 的三条同址），这里再加两道锚：
    //   ① 目标文件里确实住着评估核心的函数体；
    //   ② 搬走之后 main.py 里**不再有**同一份代码 —— 口径只有一个住所（L1）。
    expect(observePy).toContain("async def evaluate_session(");
    expect(observePy).toContain("report.reasons[i]");
    expect(mainPy).not.toContain("report.reasons[i]");
    expect(mainPy).not.toContain("no_content = not output_preview.strip()");
  });

  it("score 可以是 null —— 后端在 errored 时**主动置空**（不是 0 分）", () => {
    // app/observe.py:evaluate_session。这行改成 0 的那天，均分就会被伪造的 0 拉低
    expect(observePy).toContain('"score": None if errored else report.scores[i]');
    expect(observePy).toContain('"errored": errored');
  });

  it("errored 的判定是 SDK 两种伪造话术的前缀（前端不许自己再判一套）", () => {
    expect(observePy).toContain('("An error occurred:", "Evaluator error:")');
  });

  it("no_content 时后端把所有分数置 null + 标 no_content/warning", () => {
    expect(observePy).toMatch(/no_content = not output_preview\.strip\(\)/);
    expect(observePy).toContain('r["score"] = None');
    expect(observePy).toContain('result["no_content"] = True');
  });

  it("**reason 在 observe 侧不做 str 强转** —— 这就是它可能是对象的原因", () => {
    // dataset 侧有 str()：app/testrun.py:527
    expect(testrunPy).toContain("reason = str(report.reasons[i])");
    // observe 侧没有：app/observe.py 直接把 reasons[i] 塞进 dict
    expect(observePy).toContain('"reason": reason,');
    expect(observePy).not.toContain('"reason": str(reason)');
  });

  it("observe 环节只发 session_result / session_error（没有逐轮事件）", () => {
    // 分栏对话在这一格是错的抽象，源码层面确认「压根没有 turn 可分」
    const observeBody = planrunPy.slice(
      planrunPy.indexOf("async def _run_observe_stage"),
      planrunPy.indexOf("async def _run_dataset_stage"));
    // 切片边界都还在（indexOf 失手会切出一段无关正文，让下面两条否定式永过）
    expect(observeBody).toContain("async def _run_observe_stage");
    expect(observeBody).toContain("observe.evaluate_session(");
    expect(observeBody).toContain('"session_result" if result["event"] == "session_result"');
    expect(observeBody).not.toContain('"event": "turn"');
    expect(observeBody).not.toContain('"event": "attack_turn"');
  });

  it("会话是**并发乱序**评的：完成顺序 ≠ 会话顺序（清单必须写明按评完顺序）", () => {
    expect(planrunPy).toContain("asyncio.Semaphore(STAGE_CONCURRENCY)");
    expect(planrunPy).toContain("asyncio.as_completed");
  });

  it("分母事件 observe_sessions 三个键，且在空会话 return **之后**才发", () => {
    expect(planrunPy).toContain('"event": "observe_sessions", "stage": stage_no');
    expect(planrunPy).toContain('"total": len(sessions)');
    // 顺序反了：空会话 run 会先承诺一个分母再什么都不送
    expect(planrunPy.indexOf('"status": "empty"'))
      .toBeLessThan(planrunPy.indexOf('"event": "observe_sessions"'));
  });

  it("分母用 total 不用 sessions —— 后者在本环节已表示「评完了几条」", () => {
    // 同名会让「3/10」变成「10/10」
    expect(planrunPy).toContain('"sessions": len(session_events)');
    expect(planrunPy).not.toContain('"event": "observe_sessions", "stage": stage_no, "sessions"');
  });
});

// ==================== reason 规范化（白屏入口） ====================
describe("reasonText：reason 可能不是字符串（第二个白屏入口）", () => {
  it("字符串原样（两端空白 trim）", () => {
    expect(reasonText("  回答完整  ")).toBe("回答完整");
  });

  it("{summary:'…'} 对象 → 取 summary（实测形态）", () => {
    expect(reasonText({ summary: "结论正确但未说明到账周期。", score_rationale: "0.66" }))
      .toBe("结论正确但未说明到账周期。");
  });

  it("summary 再套一层对象 → 递归取到字符串", () => {
    expect(reasonText({ summary: { summary: "深一层" } })).toBe("深一层");
  });

  it("{reason:'…'} 也认（另一种包装）", () => {
    expect(reasonText({ reason: "包了一层" })).toBe("包了一层");
  });

  it("认不出的对象 → JSON 序列化（读得懂总比白屏好，也便于排查真形态）", () => {
    expect(reasonText({ verdict: "pass", notes: ["a"] }))
      .toBe('{"verdict":"pass","notes":["a"]}');
  });

  it("null / undefined → 空串（不渲染任何东西，不写 'null'）", () => {
    expect(reasonText(null)).toBe("");
    expect(reasonText(undefined)).toBe("");
  });

  it("数字/布尔 → 字符串（不崩）", () => {
    expect(reasonText(0)).toBe("0");
    expect(reasonText(false)).toBe("false");
  });

  it("**返回值永远是 string** —— 组件拿到的一定能直接渲染", () => {
    const weird: unknown[] = [
      "s", 1, true, null, undefined, {}, [], { summary: null }, { summary: 1 },
      { a: { b: { c: 1 } } },
    ];
    for (const v of weird) expect(typeof reasonText(v)).toBe("string");
  });
});

// ==================== 分数与均分（null ≠ 0） ====================
describe("scoresOf / meanOf：null 分数绝不当 0", () => {
  it("results → 数组，顺序照后端 key 顺序（不排序，多行肉眼对得齐）", () => {
    const s = scoresOf({ helpfulness: ok(0.9), coherence: ok(0.8) });
    expect(s.map((x) => x.name)).toEqual(["helpfulness", "coherence"]);
  });

  it("errored 的评估器 score 为 null，且**不进均分**", () => {
    const s = scoresOf({ helpfulness: ok(0.8), coherence: throttled() });
    expect(s[1]).toMatchObject({ score: null, errored: true });
    // 均分 = 0.8，不是 (0.8+0)/2 = 0.4
    expect(meanOf(s)).toBeCloseTo(0.8, 10);
  });

  it("errored 却带着数字（后端漏置 null）→ 前端仍然剔掉", () => {
    // SDK 伪造的 0 分绝不能因为后端某天漏置 null 就漏进均分
    const s = scoresOf({ helpfulness: { score: 0, passed: false, errored: true, reason: "x" } });
    expect(s[0].score).toBeNull();
    expect(meanOf(s)).toBeNull();
  });

  it("全部 errored → 均分 null（**不是 0**）", () => {
    expect(meanOf(scoresOf({ a: throttled(), b: throttled() }))).toBeNull();
  });

  it("results 为空对象（纯 metrics 运行，无评估器）→ 无可评分项", () => {
    expect(scoresOf({})).toEqual([]);
    expect(meanOf([])).toBeNull();
  });

  it("results 不是对象 / 是数组 → 空数组，不崩", () => {
    expect(scoresOf(null)).toEqual([]);
    expect(scoresOf("x")).toEqual([]);
    expect(scoresOf([1, 2])).toEqual([]);
  });

  it("非有限数（NaN/Infinity）不算分数", () => {
    expect(scoresOf({ a: { score: NaN, errored: false } })[0].score).toBeNull();
    expect(scoresOf({ a: { score: Infinity, errored: false } })[0].score).toBeNull();
  });

  it("0 分是**真分数**，要照算（别把 0 当空）", () => {
    const s = scoresOf({ a: { score: 0, passed: false, errored: false, reason: "答错了" } });
    expect(s[0].score).toBe(0);
    expect(meanOf(s)).toBe(0);
  });
});

// ==================== 一行的解析 ====================
describe("observeRowOf：四档结论", () => {
  it("有分数 → scored + 均分", () => {
    const r = observeRowOf(res("s1", { a: ok(0.9), b: ok(0.7) }), 1, 5_000)!;
    expect(r.status).toBe("scored");
    expect(r.mean).toBeCloseTo(0.8, 10);
    expect(r).toMatchObject({
      key: "s1", sessionId: "s1", agent: "support-bot", spanCount: 9,
      error: null, warning: null, seq: 1, ts: 5_000,
    });
  });

  it("评估器全挂 → no-score（中性档，不是失败也不是 0 分）", () => {
    const r = observeRowOf(res("s2", { a: throttled(), b: throttled() }), 2, 0)!;
    expect(r.status).toBe("no-score");
    expect(r.mean).toBeNull();
  });

  it("no_content:true → no-content，且 warning 原样带上（比一个 0 分有用）", () => {
    const r = observeRowOf(
      res("s3", { a: throttled("the output is empty") },
        { no_content: true, warning: "trace has no captured message content" }), 3, 0)!;
    expect(r.status).toBe("no-content");
    expect(r.mean).toBeNull();
    expect(r.warning).toBe("trace has no captured message content");
  });

  it("no_content 优先于「有分数」判定（后端置空后不该再出现分数，但形态上兜住）", () => {
    const r = observeRowOf(res("s4", { a: ok(0.9) }, { no_content: true }), 4, 0)!;
    expect(r.status).toBe("no-content");
  });

  it("session_error → errored + 原因", () => {
    const r = observeRowOf(err("s5", "TraceProviderError: no spans"), 5, 0)!;
    expect(r).toMatchObject({
      status: "errored", mean: null, scores: [],
      error: "TraceProviderError: no spans", outputPreview: "",
    });
  });

  it("session_error **缺 error** → 中性兜底文案，不留空白", () => {
    expect(observeRowOf(err("s6"), 6, 0)!.error).toBe("评分失败（后端未给原因）");
    expect(observeRowOf({ ...err("s6"), error: "   " }, 6, 0)!.error)
      .toBe("评分失败（后端未给原因）");
  });

  it("缺 session_id → **仍然落这一行**，用到达序造唯一键", () => {
    const r = observeRowOf({ event: "session_error", agent: "a" }, 7, 0)!;
    expect(r.sessionId).toBeNull();
    expect(r.key).toBe("(未知会话)#7");
    expect(r.status).toBe("errored");
  });

  it("缺 span_count / 非数字 → null（不伪造 0 个 span）", () => {
    expect(observeRowOf({ ...res("s8", {}), span_count: undefined }, 8, 0)!.spanCount).toBeNull();
    expect(observeRowOf({ ...res("s8", {}), span_count: "9" }, 8, 0)!.spanCount).toBeNull();
  });

  it("非本层事件 → null（heartbeat / 逐轮事件 / 终帧都不进清单）", () => {
    expect(observeRowOf({ event: "heartbeat" }, 1, 0)).toBeNull();
    expect(observeRowOf({ event: "turn", case: "c" }, 1, 0)).toBeNull();
    expect(observeRowOf({ event: "attack_turn", case: "attack#1" }, 1, 0)).toBeNull();
    expect(observeRowOf({ event: "observe_sessions", total: 3 }, 1, 0)).toBeNull();
    expect(observeRowOf({ event: "plan_run_report" }, 1, 0)).toBeNull();
  });

  it("reason 对象在**状态层**就被规范化 —— 组件永远只拿到 string", () => {
    const r = observeRowOf(
      res("s9", { a: { score: 0.66, errored: false, reason: { summary: "对象 reason" } } }),
      9, 0)!;
    expect(r.scores[0].reason).toBe("对象 reason");
    expect(typeof r.scores[0].reason).toBe("string");
  });
});

// ==================== 累积 ====================
describe("pushObserveSession：评完一条落一行", () => {
  it("分母事件只记 total，不落行", () => {
    const st = feed([{ event: "observe_sessions", stage: 1, total: 10 }]);
    expect(st.total).toBe(10);
    expect(st.totalStage).toBe(1);
    expect(st.rows).toEqual([]);
    expect(doneCount(st)).toBe(0);
  });

  it("非法分母（0 / 负 / 非数字 / 缺）→ 当没收到，**绝不编一个分母**", () => {
    for (const total of [0, -1, "10", null, undefined, NaN]) {
      const st = feed([{ event: "observe_sessions", stage: 1, total }]);
      expect(st.total, `total=${String(total)}`).toBeNull();
    }
  });

  it("换环节号 → 换分母（一个方案可以有两个 observe 环节）", () => {
    const st = feed([
      { event: "observe_sessions", stage: 1, total: 3 },
      { event: "observe_sessions", stage: 4, total: 8 },
    ]);
    expect(st).toMatchObject({ total: 8, totalStage: 4 });
  });

  it("重复同一个分母事件 → 返回**原引用**（不触发无谓重渲）", () => {
    const a = feed([{ event: "observe_sessions", stage: 1, total: 3 }]);
    const b = pushObserveSession(a, { event: "observe_sessions", stage: 1, total: 3 }, 2_000);
    expect(b).toBe(a);
  });

  it("非本层事件返回**原引用**", () => {
    const a = feed([res("s1", { x: ok(0.9) })]);
    expect(pushObserveSession(a, { event: "heartbeat" }, 2_000)).toBe(a);
    expect(pushObserveSession(a, { event: "turn", case: "c", role: "user" }, 2_000)).toBe(a);
  });

  it("按到达顺序追加：行序 = **评完顺序**（不是会话顺序）", () => {
    const st = feed([
      res("sess-c", { x: ok(0.9) }),
      res("sess-a", { x: ok(0.5) }),
      res("sess-b", { x: ok(0.7) }),
    ]);
    expect(st.rows.map((r) => r.sessionId)).toEqual(["sess-c", "sess-a", "sess-b"]);
    expect(st.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("四档各自计数；doneCount = 分子", () => {
    const st = feed([
      { event: "observe_sessions", stage: 1, total: 7 },
      res("s1", { x: ok(0.9) }),
      res("s2", { x: throttled() }),
      res("s3", { x: throttled() }, { no_content: true }),
      err("s4", "boom"),
    ]);
    expect(st).toMatchObject({ scored: 1, noScore: 1, noContent: 1, errored: 1, total: 7 });
    expect(doneCount(st)).toBe(4);
  });

  it("同一 session_id 重发 → **原位替换**，不新增行、不重复计数、seq 不变", () => {
    const st = feed([
      err("sess-x", "拉 trace 超时"),
      res("sess-y", { x: ok(0.8) }),
      // 重试成功：同一条会话又来一次
      res("sess-x", { x: ok(0.81) }),
    ]);
    expect(st.rows).toHaveLength(2);
    // 位置不跳动：仍在第一行
    expect(st.rows[0].sessionId).toBe("sess-x");
    expect(st.rows[0].seq).toBe(1);
    expect(st.rows[0].status).toBe("scored");
    // 档位计数一减一加，不是两条都算
    expect(st).toMatchObject({ scored: 2, errored: 0 });
    expect(doneCount(st)).toBe(2);
  });

  it("缺 session_id 的多条**不会互相覆盖**（到达序造的键各不相同）", () => {
    const st = feed([
      { event: "session_error", agent: "a", error: "第一条" },
      { event: "session_error", agent: "a", error: "第二条" },
    ]);
    expect(st.rows).toHaveLength(2);
    expect(st.rows.map((r) => r.error)).toEqual(["第一条", "第二条"]);
  });

  it("React key 用 session_id：乱序 + 重发下键仍稳定唯一", () => {
    const st = feed([
      res("sess-b", { x: ok(0.7) }),
      res("sess-a", { x: ok(0.9) }),
      res("sess-b", { x: ok(0.75) }),
    ]);
    const keys = st.rows.map((r) => r.key);
    expect(keys).toEqual(["sess-b", "sess-a"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("超 ROW_KEEP=50 行 → 老行真丢弃，但**分子不回缩**", () => {
    const evs = Array.from({ length: 60 }, (_, i) => res(`sess-${i}`, { x: ok(0.5) }));
    const st = feed(evs);
    expect(st.rows).toHaveLength(ROW_KEEP);
    expect(st.dropped).toBe(10);
    // 最老的 10 行已不在数组里
    expect(st.rows[0].sessionId).toBe("sess-10");
    // 已评数仍是 60（按 rows 重算会缩回 50，那是骗人）
    expect(doneCount(st)).toBe(60);
    expect(st.scored).toBe(60);
  });

  it("手挑 session_ids 的无上限路径下内存仍恒定（500 条只留 50 行）", () => {
    const evs = Array.from({ length: 500 }, (_, i) => res(`sess-${i}`, { x: ok(0.5) }));
    const st = feed(evs);
    expect(st.rows).toHaveLength(ROW_KEEP);
    expect(doneCount(st)).toBe(500);
  });

  it("空响应/无内容的会话不进均分口径 —— 每行的 mean 独立为 null", () => {
    const st = feed([res("s1", { x: throttled() }, { no_content: true })]);
    expect(rowOf(st, "s1").mean).toBeNull();
    // 也没有把 0 塞进任何计数
    expect(st.scored).toBe(0);
  });
});

// ==================== 短 id 口径 ====================
// 批 fmt-converge：本模块此前私写「截前 12 字 + …」，与报告页矩阵行 / 裁决句 /
// tile 用的**首段 8 位 hex**（lib/text.shortSessionId）是两个短形式 —— 同一条会话
// 跑完前后印出两个样子，对不上。收敛到 lib 那一份，本页显示随之变（是本条的目的）。
describe("shortSessionId：与滚动日志、报告页同一口径（首段 8 位 hex）", () => {
  it("取首段 8 位 hex（旧口径给 'sess-abcdef1…'）", () => {
    expect(shortSessionId("sess-abcdef123456789")).toBe("abcdef12");
    expect(shortSessionId("dsh-trace-e5d8fb96-7c21-4a19-9b3e-0f1a2b3c4d5e")).toBe("e5d8fb96");
  });

  it("没有 8 位 hex 段 → 原样（这一档与旧口径同值）", () => {
    expect(shortSessionId("sess-abc")).toBe("sess-abc");
  });

  it("null/undefined → 空串（不渲染 'null'）", () => {
    expect(shortSessionId(null)).toBe("");
    expect(shortSessionId(undefined)).toBe("");
  });
});

// ==================== mock 契约 ====================
describe("mock 契约：OBSERVE_LIVE_SESSIONS 与真后端形态逐字一致", () => {
  const evs = OBSERVE_LIVE_SESSIONS.map(([, e]) => e);

  it("session_result 的键集合与 app/observe.py 的返回一致（九个键 + 可选两个）", () => {
    const required = ["event", "agent", "session_id", "span_count", "output_preview",
      "results", "metrics", "transcript", "diagnosis"];
    for (const e of evs.filter((x) => x.event === "session_result")) {
      for (const k of required) expect(Object.keys(e), String(e.session_id)).toContain(k);
      const extra = Object.keys(e).filter((k) => !required.includes(k));
      expect(extra.every((k) => k === "no_content" || k === "warning"), extra.join(",")).toBe(true);
    }
  });

  it("每个评估器结果都有 score/passed/errored/reason 四个键", () => {
    for (const e of evs.filter((x) => x.event === "session_result")) {
      for (const r of Object.values(e.results as Record<string, unknown>)) {
        expect(Object.keys(r as object).sort())
          .toEqual(["errored", "passed", "reason", "score"]);
      }
    }
  });

  it("桩里有 score:null 的 errored 评估器（SDK 伪造 0 分的真形态）", () => {
    const hasNull = evs.some((e) => e.event === "session_result"
      && Object.values(e.results as Record<string, { score: unknown; errored: unknown }>)
        .some((r) => r.score === null && r.errored === true));
    expect(hasNull).toBe(true);
  });

  it("桩里有 **reason 是对象** 的一条（白屏入口的素材）", () => {
    const objReason = evs.some((e) => e.event === "session_result"
      && Object.values(e.results as Record<string, { reason: unknown }>)
        .some((r) => r.reason !== null && typeof r.reason === "object"));
    expect(objReason, "少了这条，白屏入口就没有回归素材").toBe(true);
  });

  it("桩里有 no_content:true + warning 的一条", () => {
    const nc = evs.find((e) => e.no_content === true)!;
    expect(nc).toBeTruthy();
    expect(typeof nc.warning).toBe("string");
    // 后端此时把所有分数置 null
    expect(Object.values(nc.results as Record<string, { score: unknown }>)
      .every((r) => r.score === null)).toBe(true);
  });

  it("桩里有 session_error **缺 error/缺 span_count** 的一条", () => {
    const bare = evs.find((e) => e.event === "session_error" && !("error" in e));
    expect(bare, "少了这条，缺字段兜底就没有回归素材").toBeTruthy();
    expect("span_count" in bare!).toBe(false);
  });

  it("桩里有**同一 session_id 重发**（先 error 后 result）", () => {
    const ids = evs.map((e) => e.session_id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dup).toHaveLength(1);
    const both = evs.filter((e) => e.session_id === dup[0]).map((e) => e.event);
    expect(both).toEqual(["session_error", "session_result"]);
  });

  it("到达顺序**乱序**：不是按 session_id 排的（真后端并发完成）", () => {
    const ids = evs.map((e) => String(e.session_id));
    expect(ids).not.toEqual([...ids].sort());
  });

  it("延迟单调递增（桩本身别乱序，乱的是会话不是时间）", () => {
    const ms = OBSERVE_LIVE_SESSIONS.map(([m]) => m);
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
  });

  it("分母 = 去重后的会话数（桩自洽：MOCK_OBSERVE_TOTAL 对得上）", () => {
    expect(new Set(evs.map((e) => e.session_id)).size).toBe(MOCK_OBSERVE_TOTAL);
  });

  it("桩灌进真逻辑后：四档都出现，分子 = 分母，且没有一个 0 分是伪造的", () => {
    const st = feed([
      { event: "observe_sessions", stage: 1, total: MOCK_OBSERVE_TOTAL },
      // 桩是 Record<string, unknown>（就是为了能少字段、给对象 reason）——
      // 真流走 SSE 解析出来也正是任意形状的对象，这里是它进真逻辑的入口
      ...(evs as Parameters<typeof pushObserveSession>[1][]),
    ]);
    expect(st.rows).toHaveLength(MOCK_OBSERVE_TOTAL);
    expect(doneCount(st)).toBe(MOCK_OBSERVE_TOTAL);
    expect(st.total).toBe(MOCK_OBSERVE_TOTAL);
    expect(st.scored).toBeGreaterThan(0);
    expect(st.noScore).toBeGreaterThan(0);
    expect(st.noContent).toBe(1);
    expect(st.errored).toBe(1);
    // 所有 mean 要么是 null，要么是真算出来的正数——没有一处把 null 当 0
    for (const r of st.rows) {
      expect(r.mean === null || r.mean > 0, `${r.sessionId} mean=${r.mean}`).toBe(true);
    }
    // 每一条 reason 都已是字符串（组件不会白屏）
    for (const r of st.rows) {
      for (const s of r.scores) expect(typeof s.reason).toBe("string");
    }
  });
});
