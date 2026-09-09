// 改进处方闭环（P0-4）的**非界面**守卫：判据同刑 + mock 对刑 + 后端文案三角钉。
//
// 界面部分的去向（adr0014-migrate 批，2026-09-03）：原 ImprovementBlock（报告里的
// 「改进处方」区，ADR-0014 §6 后已无挂载点）**已删除**；采纳动作与已落库处方的
// 采纳态迁到评估分析页的采纳追踪表（pages/compare/AnalysisSections.tsx），界面用例
// 在 tests/analysis-sections.test.tsx。「生成改进稿」（propose_improvements）的前端
// 入口随组件一并下线 —— 后端 action 与 mock 桩保留，本文件继续钉它们的形态。
//
// 本文件的守卫形制（三条，逐条对应本仓吃过的教训）：
//   ① **三角钉**：后端文案在「后端源码（权威）× mock 桩 × 前端派生」处对钉。
//   ② **新桩自带对刑守卫**：mock-parity.test.ts 是逐 action 点断言，这两个桩天生在
//      它射程之外 —— 这里自己补：mock 产出的 proposal 键必须在 app/improve.py 的
//      `_PROPOSAL_TOOL` schema 里真实存在（含恒真陷阱防护）。
//   ③ **判据同刑**：前端的「有没有证据可生成」判据（derive.improvementPayload）
//      与后端 app/improve.py:collect_evidence 必须给出同一个答案。
//
// 会话明细形态照 app/planrun.py:_run_observe_stage 的 `details`（九键原样透传
// observe.evaluate_session 的结果，session_error 支只有 {agent, session_id, error}）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { improvementPayload, PROPOSAL_LOW_SCORE, adoptionNoteOf } from "../src/pages/plan/derive";
import { MOCK_ACCESS_TOKEN, MOCK_PLAN_RUN, PLAN_RUNS } from "../src/mocks/handlers";
import { resetConfigForTest } from "../src/lib/config";
import { resetRunFlightForTest } from "../src/lib/runFlight";
import { useSession } from "../src/stores/session";

const improvePy = readFileSync(resolve(process.cwd(), "../app/improve.py"), "utf8");
const mainPy = readFileSync(resolve(process.cwd(), "../app/main.py"), "utf8");
const planrunPy = readFileSync(resolve(process.cwd(), "../app/planrun.py"), "utf8");

const AGENT = "support-bot";
const PLAN_ID = "plan-impv001";
const RUN_KEY = "plan-impv001#2026-08-25T09:00:00Z";

/** 「没有可用证据」这句话 —— **后端原话**（app/improve.py:propose 里 raise 的
 *  ValueError 文本）。前端此前留过一份副本（ImprovementBlock.NO_EVIDENCE_TEXT，
 *  随组件删除）；现在只剩后端权威 × mock 桩两处对钉。 */
const NO_EVIDENCE_TEXT =
  "这些会话里没有可用于生成改进稿的证据（需要低分评估结果或诊断出的故障/根因）。";

/** observe 环节的逐会话明细：入选两条（诊断档 + 低分档）、被剔三条。
 *  被剔的三档正是 collect_evidence 的三个 continue：error / no_content /
 *  既无低分又无诊断。 */
const OBSERVE_SESSIONS: Record<string, unknown>[] = [
  {
    agent: AGENT,
    session_id: "sess-a41f9c2b",
    output_preview: "抱歉，改签暂时无法完成，请稍后再试。",
    results: {
      helpfulness: { score: 0.9, passed: true, errored: false, reason: "回答完整且给出下一步。" },
      // errored 判定：score/passed 是 null —— 不是 0 分，不得当低分证据
      coherence: { score: null, passed: null, errored: true, reason: "Evaluator error: judge 限流" },
    },
    diagnosis: {
      failures: [{
        span_id: "sp-7", category: ["tool_error"], confidence: "[0.9]",
        evidence: "[\"rebook 超时：UpstreamTimeout no response in 300ms\"]",
      }],
      root_causes: [{
        fix_type: "SYSTEM_PROMPT_FIX",
        causality: "工具连续超时后仍按成功继续应答",
        fix_recommendation: "约束：工具未返回成功结果时不得陈述结论",
      }],
    },
    // 送后端时必须剥掉（几十 KB 到几 MB，后端 collect_evidence 一个字都不读）
    transcript: { events: [{ n: 1, type: "user", text: "帮我改签" }], truncated: false },
  },
  {
    agent: AGENT,
    session_id: "sess-lowscore",
    results: {
      helpfulness: { score: 0.4, passed: false, errored: false, reason: "答非所问：未给出自助路径。" },
    },
    diagnosis: null,
  },
  // session_error 支：只有三键，results/diagnosis/transcript 全缺
  { agent: AGENT, session_id: "sess-deadbeef", error: "trace 拉取失败：CloudWatch 查询超时" },
  { agent: AGENT, session_id: "sess-nocontent", no_content: true, results: {} },
  {
    agent: AGENT,
    session_id: "sess-clean",
    results: { helpfulness: { score: 1.0, passed: true, errored: false, reason: "完全正确。" } },
    diagnosis: { failures: [], root_causes: [] },
  },
];

const DDB_STAGES = [
  { type: "observe", status: "completed", overall_mean: 0.66, sessions: 4, summary: {} },
];

function s3Stages(): Record<string, unknown>[] {
  return [{
    type: "observe", status: "completed", sessions: 4, overall_mean: 0.66,
    evaluators: ["helpfulness", "coherence"],
    analysis: "工具链 rebook_flight 连续超时是本次主要失败面。",
    session_details: OBSERVE_SESSIONS,
  }];
}

const PLAN = {
  plan_id: PLAN_ID,
  name: "客服周巡检",
  agent_name: AGENT,
  updated_at: 1787000000,
  stages: [{ type: "observe", evaluators: ["helpfulness", "coherence"] }],
  schedule: null,
};

function detail(over: Record<string, unknown> = {}) {
  return {
    event: "plan_run",
    run_key: RUN_KEY,
    plan_id: PLAN_ID,
    plan_name: PLAN.name,
    agent_name: AGENT,
    status: "completed",
    score: 0.66,
    started_at: "2026-08-25 09:00 UTC",
    finished_at: "2026-08-25 09:02 UTC",
    duration_s: 121,
    triggered_by: "manual",
    total_cost_usd: 0.19,
    overview: { stage_lines: [], previous_run: null },
    stage_summaries: DDB_STAGES,
    // _run_from_item 无条件带 proposals（老 item 缺键时是空数组）
    proposals: [],
    s3_key: "reports/plan-impv001/20260825090000.json",
    plan_synthesis: "## 改进采纳效果\n暂无已采纳的改进记录。",
    synthesis_sections: [{ title: "改进采纳效果", body: "暂无已采纳的改进记录。" }],
    synthesis_error: null,
    report: {
      run_key: RUN_KEY,
      plan: { plan_id: PLAN_ID, name: PLAN.name, agent_name: AGENT, stages: [] },
      triggered_by: "manual",
      started_at: "2026-08-25 09:00 UTC",
      finished_at: "2026-08-25 09:02 UTC",
      duration_s: 121,
      stages: s3Stages(),
    },
    ...over,
  };
}

/** 走 mock handler 本身发一次请求，返回全部帧（不复制常量——复制就会再漂移）。 */
async function callMock(payload: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const { handlers } = await import("../src/mocks/handlers");
  const apiHandler = handlers.find((h) =>
    String((h as { info?: { path?: unknown } }).info?.path ?? "").includes("/api/invoke"));
  expect(apiHandler, "mocks/handlers.ts 应有 /api/invoke 的 handler").toBeTruthy();
  const res = await (apiHandler as unknown as {
    run: (a: { request: Request }) => Promise<{ response?: Response }>;
  }).run({
    request: new Request("http://localhost/api/invoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-authorization": `Bearer ${MOCK_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    }),
  });
  const text = await res.response!.text();
  return text.split("\n\n").filter(Boolean)
    .map((f) => JSON.parse(f.replace(/^data: /, "")) as Record<string, unknown>);
}

beforeEach(() => {
  resetConfigForTest();
  resetRunFlightForTest();
  location.hash = `#/plan/${PLAN_ID}`;
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==================== 三角钉：后端文案 ====================
describe("三角钉：无可用证据这句话与两个 action，后端权威 × mock 桩", () => {
  it("权威×字面量：app/improve.py:propose 抛的就是这句原话", () => {
    expect(improvePy).toContain(NO_EVIDENCE_TEXT);
  });

  it("低分阈值同权威：derive 的 0.7 = app/improve.py 的 LOW_SCORE", () => {
    const m = improvePy.match(/^LOW_SCORE\s*=\s*([\d.]+)/m);
    expect(m, "app/improve.py 应有 LOW_SCORE 常量").toBeTruthy();
    expect(PROPOSAL_LOW_SCORE).toBe(Number(m![1]));
  });

  it("后端两个 action 分支与三个错误形态都在源码里（行号会失指，钉符号）", () => {
    expect(mainPy).toContain('if action == "propose_improvements":');
    expect(mainPy).toContain('if action == "set_proposal_adopted":');
    expect(mainPy).toContain("agent_name and sessions are required.");
    expect(mainPy).toContain("改进稿生成失败：");
    expect(planrunPy).toContain("def attach_proposal(");
    expect(planrunPy).toContain("def set_proposal_adopted(");
    expect(planrunPy).toContain("处方序号 ");
  });

  it("两个 action 的前端调用方各只有一处 = 评估分析页（ImprovementBlock 删除后的唯一住所）", () => {
    // 量词钉：src 下（mocks 除外）恰一处发这两个 action。多出一处 = 有人另起一套
    // 生成/采纳入口，判据会分家；少了 = 付费的生成入口又消失了（协调方 2026-09-03
    // 明令加回：那是闭环里唯一会产生新建议的动作）。
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(p) && !p.includes("/mocks/")) out.push(p);
      }
      return out;
    };
    const files = walk(resolve(process.cwd(), "src"));
    const callersOf = (needle: string) => files
      .filter((f) => readFileSync(f, "utf8").includes(needle))
      .map((f) => f.split("/src/")[1]);
    expect(callersOf('action: "propose_improvements"')).toEqual(["pages/compare/AnalysisSections.tsx"]);
    expect(callersOf('action: "set_proposal_adopted"')).toEqual(["pages/compare/AnalysisSections.tsx"]);
    // 阴性对照：被删的组件文件确实不在
    expect(files.some((f) => f.endsWith("ImprovementBlock.tsx"))).toBe(false);
  });
});

// ==================== 判据同刑：前端 gate = 后端 collect_evidence ====================
describe("证据判据与 app/improve.py:collect_evidence 同刑", () => {
  it("入选两条（诊断档 + 低分档），三档被剔（error / no_content / 无低分无诊断）", () => {
    const p = improvementPayload(detail(), AGENT);
    expect(p.usable).toBe(2);
    // 送后端的 sessions 是**全部**明细（筛选权在后端）：数量与夹具一致
    expect(p.sessions).toHaveLength(OBSERVE_SESSIONS.length);
  });

  it("transcript 被剥掉（后端一个字都不读，几 MB 不该进请求体）", () => {
    const p = improvementPayload(detail(), AGENT);
    expect(OBSERVE_SESSIONS[0]).toHaveProperty("transcript");
    for (const s of p.sessions) expect(s).not.toHaveProperty("transcript");
    // 判据要用的键一个不少
    expect(p.sessions[0]).toHaveProperty("session_id", "sess-a41f9c2b");
    expect(p.sessions[0]).toHaveProperty("results");
    expect(p.sessions[0]).toHaveProperty("diagnosis");
  });

  it("agent 缺失的明细补盖 agent 名——否则后端首行 continue 全剔光", () => {
    const d = detail({
      report: {
        stages: [{ type: "observe", status: "completed",
                   session_details: [{ session_id: "sess-noagent",
                                       results: { helpfulness: { score: 0.2, errored: false } } }] }],
      },
    });
    const p = improvementPayload(d, AGENT);
    expect(p.sessions[0]).toHaveProperty("agent", AGENT);
    expect(p.usable).toBe(1);
  });

  it("errored 判定不算低分证据（score 为 null，不是 0 分）", () => {
    const d = detail({
      report: {
        stages: [{ type: "observe", status: "completed", session_details: [{
          agent: AGENT, session_id: "s1",
          results: { coherence: { score: null, passed: null, errored: true, reason: "judge 限流" } },
        }] }],
      },
    });
    expect(improvementPayload(d, AGENT).usable).toBe(0);
  });

  it("非 observe 环节不供证据（后端 sessions 只认线上评估会话明细）", () => {
    const d = detail({
      report: {
        stages: [{ type: "dataset", status: "completed",
                   report: { results: [{ agent: AGENT, case: "case-2",
                                         results: { correctness: { score: 0.5, errored: false } } }] } }],
      },
    });
    const p = improvementPayload(d, AGENT);
    expect(p.sessions).toHaveLength(0);
    expect(p.usable).toBe(0);
  });
});

// ==================== mock 对刑守卫（mock-parity 射不到新桩，自己补） ====================
describe("mock 同刑：两个新桩", () => {
  /** app/improve.py 的 `_PROPOSAL_TOOL` schema 原文（键存在性的权威） */
  const schema = improvePy.slice(improvePy.indexOf("_PROPOSAL_TOOL"));

  it("恒真陷阱防护：schema 段真被切出来了，且认得已知键、认不出瞎编的键", () => {
    expect(schema.length).toBeGreaterThan(500);
    expect(schema).toContain('"system_prompt"');
    expect(schema).not.toContain('"revised_prompt_text"');
  });

  it("mock 产出的 proposal 键逐层落在后端 schema 里（没有一个是幻觉）", async () => {
    const frames = await callMock({
      action: "propose_improvements", agent_name: "support-bot",
      sessions: OBSERVE_SESSIONS,
    });
    const ev = frames.find((f) => f.event === "improvement")!;
    expect(ev, "mock 应给出 improvement 帧").toBeTruthy();
    const p = ev.proposal as Record<string, unknown>;
    for (const k of Object.keys(p)) expect(schema, `proposal.${k}`).toContain(`"${k}"`);
    const sp = p.system_prompt as Record<string, unknown>;
    for (const k of Object.keys(sp)) expect(schema, `system_prompt.${k}`).toContain(`"${k}"`);
    for (const c of sp.changes as Record<string, unknown>[]) {
      for (const k of Object.keys(c)) expect(schema, `changes.${k}`).toContain(`"${k}"`);
    }
    for (const t of p.tool_descriptions as Record<string, unknown>[]) {
      for (const k of Object.keys(t)) expect(schema, `tool.${k}`).toContain(`"${k}"`);
    }
    for (const o of p.other_actions as Record<string, unknown>[]) {
      for (const k of Object.keys(o)) expect(schema, `other.${k}`).toContain(`"${k}"`);
    }
    // improvement 帧的顶层键：权威在 improve.propose 的 return + main.py 分支
    for (const k of ["proposal", "prompt_recovered", "current_prompt", "based_on"]) {
      expect(improvePy, `improvement.${k}`).toContain(`"${k}"`);
    }
    expect(mainPy).toContain('out["attached_to_run"] = run_key');
  });

  it("improve_start 先行（前端等的是 improvement，中间帧照后端一样发）", async () => {
    const frames = await callMock({
      action: "propose_improvements", agent_name: "support-bot", sessions: OBSERVE_SESSIONS,
    });
    expect(frames[0].event).toBe("improve_start");
    expect(frames[0].agent).toBe("support-bot");
  });

  it("based_on 按送进来的证据现算（不是写死的数），与前端 gate 同一个答案", async () => {
    const frames = await callMock({
      action: "propose_improvements", agent_name: AGENT, sessions: OBSERVE_SESSIONS,
    });
    const based = (frames.find((f) => f.event === "improvement")!.based_on) as Record<string, unknown>;
    expect(based.sessions).toBe(improvementPayload(detail(), AGENT).usable);
    expect(based.failures).toBe(1);
    expect(based.root_causes).toBe(1);
    expect(based.fix_types).toEqual({ SYSTEM_PROMPT_FIX: 1 });
  });

  it("缺 agent_name / sessions：后端原话（英文那句，别顺手翻译）", async () => {
    const a = await callMock({ action: "propose_improvements", sessions: OBSERVE_SESSIONS });
    expect(a[0]).toEqual({ event: "error", error: "agent_name and sessions are required." });
    const b = await callMock({ action: "propose_improvements", agent_name: AGENT, sessions: [] });
    expect(b[0]).toEqual({ event: "error", error: "agent_name and sessions are required." });
  });

  it("不在册 / 无日志的 agent：与后端同一句", async () => {
    const frames = await callMock({
      action: "propose_improvements", agent_name: "no-such-agent", sessions: OBSERVE_SESSIONS,
    });
    expect(frames[0].error).toBe("unknown agent or no logs: no-such-agent");
    expect(mainPy).toContain("unknown agent or no logs:");
  });

  it("送进来的会话没有一条够格：ValueError 那句原话（判据在 mock 里真跑一遍）", async () => {
    const frames = await callMock({
      action: "propose_improvements", agent_name: AGENT,
      sessions: [{ agent: AGENT, session_id: "s-clean",
                   results: { helpfulness: { score: 1, errored: false } } }],
    });
    expect(frames[0]).toEqual({ event: "error", error: NO_EVIDENCE_TEXT });
  });

  it("set_proposal_adopted：先 attach 才有序号，越界给后端原话", async () => {
    const runKey = "plan-aaa111#2026-08-11T09:00:00Z";
    const bad = await callMock({ action: "set_proposal_adopted", run_key: runKey, index: 7,
                                 adopted: true });
    expect(String(bad[0].error)).toContain("处方序号 7 不存在");
    await callMock({ action: "propose_improvements", agent_name: AGENT,
                     sessions: OBSERVE_SESSIONS, run_key: runKey });
    const ok = await callMock({ action: "set_proposal_adopted", run_key: runKey, index: 0,
                                adopted: true });
    expect(ok[0].event).toBe("proposal_adopted");
    expect(ok[0].run_key).toBe(runKey);
    const proposal = ok[0].proposal as Record<string, unknown>;
    expect(proposal.adopted_at).toBeTruthy();
    // 取消采纳把 adopted_at 置回 null（planrun.set_proposal_adopted 的三元）
    const off = await callMock({ action: "set_proposal_adopted", run_key: runKey, index: 0,
                                 adopted: false });
    expect((off[0].proposal as Record<string, unknown>).adopted_at).toBeNull();
  });

  it("run 不存在：与 planrun 同一句", async () => {
    const frames = await callMock({ action: "set_proposal_adopted", run_key: "nope#1",
                                    index: 0, adopted: true });
    expect(String(frames[0].error)).toContain("不存在");
    expect(planrunPy).toContain("' 不存在\"");
  });
});

// ==================== 已落库的处方（detail.proposals）：形态与桩 ====================
describe("已落库的处方（detail.proposals）：三键形态与桩的下标语义", () => {
  it("三角钉：落库三键的权威在 attach_proposal —— 正文一个字都不进 DDB", () => {
    const attachSrc = planrunPy.slice(
      planrunPy.indexOf("def attach_proposal("),
      planrunPy.indexOf("def set_proposal_adopted("));
    // 恒真陷阱防护：函数体真被切出来了（indexOf 落空会切出全文或空串）
    expect(attachSrc.length).toBeGreaterThan(200);
    expect(attachSrc).toContain("def attach_proposal(");
    expect(attachSrc).not.toContain("def set_proposal_adopted(");
    // 三键逐字（前端历史条目能显示的东西上限就是这三样）
    expect(attachSrc).toContain('proposals.append({"summary": summary[:300],');
    expect(attachSrc).toContain('"generated_at": time.strftime(');
    expect(attachSrc).toContain('"adopted_at": None');
    // 正文（提示词全文 / 片段 / 工具描述）根本不落库 → 历史条目不许装作有正文
    for (const k of ["system_prompt", "tool_descriptions", "other_actions", "snippets"]) {
      expect(attachSrc, `attach_proposal 不落 ${k}`).not.toContain(k);
    }
    // 采纳按**数组下标**改这一条（前端送的 index 就是这个下标）
    expect(planrunPy).toContain('proposals[index]["adopted_at"] = (');
  });

  it("mock 夹具：detail 层带已落库处方，键集就是 attach_proposal 那三键", () => {
    expect(MOCK_PLAN_RUN.proposals.length).toBeGreaterThan(0);
    for (const p of MOCK_PLAN_RUN.proposals) {
      expect(Object.keys(p).sort()).toEqual(["adopted_at", "generated_at", "summary"]);
    }
    // 夹具里至少各有一条已采纳 / 未采纳（两态在 dev 下都看得见）
    expect(MOCK_PLAN_RUN.proposals.some((p) => p.adopted_at == null)).toBe(true);
    expect(MOCK_PLAN_RUN.proposals.some((p) => p.adopted_at != null)).toBe(true);
  });

  it("mock 同刑：detail 带出的历史下标桩这边真能采纳（新处方下标接在其后）", async () => {
    // 刻意用另一条 run：前面的 mock 测试对 plan-aaa111#2026-08-11 追加过处方。
    // 按 run_key 取而不是按下标：PLAN_RUNS 的行序随夹具增删漂移（老形态 run 那行
    // 按时间插在了 08-11 之前），下标会**静默**换掉目标行。
    // 播种数按桩自己的 list_plan_runs 现读（adr0014-migrate 起桩按运行历史行播种）。
    const runKey = PLAN_RUNS.find((r) => r.run_key.includes("2026-08-09"))!.run_key;
    const listed = await callMock({ action: "list_plan_runs", plan_id: "plan-aaa111" });
    const seeded = (listed[0].runs as { run_key: string; proposals: unknown[] }[])
      .find((r) => r.run_key === runKey)!.proposals.length;
    expect(seeded, "08-09 那行应有已落库处方（采纳追踪表的素材）").toBeGreaterThan(0);
    const ok = await callMock({ action: "set_proposal_adopted", run_key: runKey,
                                index: seeded - 1, adopted: true });
    expect(ok[0].event, `夹具第 ${seeded - 1} 条应可采纳：${JSON.stringify(ok[0])}`)
      .toBe("proposal_adopted");
    // 前端算的新下标 = detail.proposals.length —— 桩必须收下它，否则
    // 「生成 → 采纳」在 dev 下一步踩空（mock 比真后端狭窄的老毛病）
    await callMock({ action: "propose_improvements", agent_name: AGENT,
                     sessions: OBSERVE_SESSIONS, run_key: runKey });
    const next = await callMock({ action: "set_proposal_adopted", run_key: runKey,
                                  index: seeded, adopted: true });
    expect(next[0].event, `新处方下标应可采纳：${JSON.stringify(next[0])}`)
      .toBe("proposal_adopted");
  });
});

// ==================== 闭环另一半：下次 run 的采纳追踪（纯函数） ====================
describe("采纳记录（overview.adoption_note）：闭环的另一半", () => {
  const NOTE = {
    proposals: [{ summary: "补充工具结果约束三条", adopted_at: "2026-08-25 09:12 UTC" }],
    score_changes: ["线上评估均分 0.66 → 0.88", "回归通过率 50% → 100%"],
  };

  it("纯函数：形态照 planrun._build_overview 写的那个 adoption_note", () => {
    expect(planrunPy).toContain('overview["adoption_note"] = {');
    const note = adoptionNoteOf(detail({ overview: { stage_lines: [], adoption_note: NOTE } }));
    expect(note!.proposals).toHaveLength(1);
    expect(note!.score_changes).toEqual(NOTE.score_changes);
    // 没有这个键的 run（后端只在上一次 run 有已采纳处方时才写）→ null
    expect(adoptionNoteOf(detail())).toBeNull();
  });
});
