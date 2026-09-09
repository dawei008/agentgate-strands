// mock 各桩的键集 ⊆ 后端真实键集 —— 机器化的「mock 同刑」纪律。
//
// 本仓三次白屏事故（UI-013 / UI-025 / UI-026）同一个形状：**mock 造了后端产不出
// 的东西**，前端照 mock 写，测试全绿而线上一到真数据就崩或恒空。此前这条纪律只
// 靠 review 与逐条注释维持，于是它照样漏（本文件首跑就抓出 4 个后端不存在的键，
// 见下面各 describe 的注释）。这里把它变成守卫：
//
//   后端真形态的**唯一**依据是后端源码本身（readFileSync + 解析出键名），
//   不是本文件抄的名单 —— 抄一份名单等于把漂移换个地方存。
//
// 覆盖四个面（任务书点名 + 三份 triage 档指向的位置）。每面的后端锚 = 源码 +
// 对应的后端测试（后者是形态的人类可读说明，行号供追溯，断言不依赖它）：
//   ① plan_run_report 终帧      ← app/main.py 的 yield 块
//   ② stage_summaries 元素      ← app/planrun.py:_stage_summary（分 type 三支）；
//                                 dataset 支的两个新字段形态钉在
//                                 tests/test_evaluator_stats_field.py:78-140
//   ③ estimate_plan_run 载荷    ← app/planrun.py:estimate_plan_run + 三个估算器
//                                 （testrun.estimate_test_run:142-152 /
//                                  redteam.estimate_redteam_run:430-439）
//   ④ stop_plan_run 回执        ← app/planrun.py:request_stop 的四个 return；
//                                 四种形态的后端测试：
//                                 tests/test_stop_plan_run.py:129（running 首次）
//                                 :188（幂等）/:171（已终态无操作）/:158+:163（错误）
//
// 方向说明（**只查一个方向**）：断言的是 mock ⊆ 后端。反向（后端有、mock 缺）
// 不在这里断 —— 那是「夹具缺口」，缺一个键只会让前端走降级路径（老 run 天然缺
// 字段，降级是真行为），而多一个键会让前端长出线上不存在的读法。反向缺口由夹具
// 类 issue 单独补（本批同时补了 halted_cost / running / 纯回归三个）。
//
// 恒真陷阱防护：每个 describe 都先钉「后端源码里确实解析出了非空键集，且含一个
// 已知键」—— 否则正则一失配就得到空集，`⊆ 空集` 反而处处绿，守卫被悄悄拆掉。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MOCK_ACCESS_TOKEN, PLAN_RUNS, REGRESSION_PLAN_RUNS, DDD_PLAN_RUNS, AGENT_RUNS, AGENT_PLANS,
  MOCK_PLAN_RUN, PLAN_RUN_DETAIL, BIGSCREEN_RUNS_OK, BIGSCREEN_RUNS_ALERT,
} from "../src/mocks/handlers";

const mainPy = readFileSync(resolve(process.cwd(), "../app/main.py"), "utf8");
const planrunPy = readFileSync(resolve(process.cwd(), "../app/planrun.py"), "utf8");
const testrunPy = readFileSync(resolve(process.cwd(), "../app/testrun.py"), "utf8");
const redteamPy = readFileSync(resolve(process.cwd(), "../app/redteam.py"), "utf8");

// ==================== 源码解析工具 ====================

/** 从 `start` 处起，按 {} 深度切出一个平衡的字典字面量（含首尾花括号）。 */
function braceBlock(py: string, start: number): string {
  const open = py.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < py.length; i += 1) {
    if (py[i] === "{") depth += 1;
    else if (py[i] === "}") {
      depth -= 1;
      if (depth === 0) return py.slice(open, i + 1);
    }
  }
  throw new Error(`未闭合的字典字面量 @${start}`);
}

/** 字典字面量里**顶层**的键名（嵌套字典的键不算 —— 它们是别的一层的契约）。 */
function topLevelKeys(block: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < block.length; i += 1) {
    const c = block[i];
    if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") depth -= 1;
    else if (c === '"' && depth === 1) {
      const end = block.indexOf('"', i + 1);
      if (end < 0) break;
      const name = block.slice(i + 1, end);
      // 键 = 紧跟冒号的那个字符串（值里的字符串不算）
      if (block.slice(end + 1).trimStart().startsWith(":")) out.push(name);
      i = end;
    }
  }
  return out;
}

/** 函数体（def 到下一个顶层 def / 文件尾）。 */
function funcBody(py: string, name: string): string {
  const m = new RegExp(`^(?:async )?def ${name}\\(`, "m").exec(py);
  if (!m) throw new Error(`找不到函数 ${name}`);
  const rest = py.slice(m.index);
  const next = /\n(?:async )?def /.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

/** 函数体里 `return {...}` 的顶层键（多个 return 取并集）。 */
function returnKeys(body: string): Set<string> {
  const keys = new Set<string>();
  for (const m of body.matchAll(/return \{/g)) {
    for (const k of topLevelKeys(braceBlock(body, m.index!))) keys.add(k);
  }
  return keys;
}

/** 键集差：mock 里有、后端没有的那些。 */
function extraKeys(obj: object, allowed: Set<string>): string[] {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

/** 走 mock handler 本身发一次请求，返回全部帧（同 api-dataset-size-parity.test.ts）。 */
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
    .map((f) => JSON.parse(f.replace(/^data: /, "")));
}

// ==================== ① plan_run_report 终帧 ====================
//
// 首跑抓到的漂移（mock-plan-run-report-status-drift 档 + 本守卫追加两个）：
//   status / plan_id / total_cost_usd —— 后端 main.py 的终帧 yield 里都没有。
// 档里只点了 status（stop-run-frontend 批发现），另两个是本守卫自己抓的。
describe("① plan_run_report 终帧：键集 ⊆ app/main.py 的 yield 块", () => {
  const backendKeys = (() => {
    const at = mainPy.indexOf('yield {"event": "plan_run_report"');
    expect(at, "app/main.py 里应有 plan_run_report 终帧的 yield").toBeGreaterThan(0);
    return new Set(topLevelKeys(braceBlock(mainPy, at)));
  })();

  it("防恒真：后端键集非空，含 run_key/overview/stages，且**不含** status", () => {
    expect(backendKeys.size).toBeGreaterThan(10);
    for (const k of ["event", "run_key", "s3_key", "overview", "stages",
                     "synthesis_sections"]) {
      expect(backendKeys, `后端终帧应有 ${k}`).toContain(k);
    }
    // 这条同时是 mock-plan-run-report-status-drift 的口径本身：
    // run 状态**不在**终帧里（前端 useRunPlan 的注释也这么写）
    expect(backendKeys).not.toContain("status");
  });

  it("mock 快速流终帧不带后端产不出的键", async () => {
    const frames = await callMock({ action: "run_plan", plan_id: "plan-aaa111" });
    const final = frames.find((f) => f.event === "plan_run_report")!;
    expect(final, "run_plan 快速流应有终帧").toBeTruthy();
    expect(extraKeys(final, backendKeys)).toEqual([]);
  });
});

// ==================== ② stage_summaries 元素 ====================
//
// 分 type 三支各自的键集：一刀切并集会放过「observe 环节带 pass_rate」这类
// 串型漂移，而那正是抽屉/大屏按 type 读数的地方。
// 这一面同时是 mock-plan-run-report-status-drift 档「dataset / cases_dataset 是
// stage_summaries 的死字段」那条的机器化：_stage_summary 从不写数据集名，
// 所以任何一层 stage_summaries 夹具带上它都会在这里红。
// （report 侧的 stage.report.dataset 是**活**的（planrun.py:308 / testrun.py:642），
//   不在本 describe 的管辖范围 —— 档里的落地口径就是分层：摘要层删、报告层留。）
describe("② stage_summaries 元素：键集 ⊆ app/planrun.py:_stage_summary 的写入集", () => {
  const body = funcBody(planrunPy, "_stage_summary");
  /** `out["x"] = …` 与 `out = {…}` 在指定片段里写出的键 */
  const written = (chunk: string) => {
    const keys = [...chunk.matchAll(/out\["([a-z_]+)"\]/g)].map((m) => m[1]);
    for (const m of chunk.matchAll(/out = \{/g)) {
      keys.push(...topLevelKeys(braceBlock(chunk, m.index!)));
    }
    return keys;
  };
  const iObs = body.indexOf('if res["type"] == "observe":');
  const iDs = body.indexOf('elif res["type"] == "dataset":');
  const iElse = body.indexOf("\n    else:", iDs);
  const common = written(body.slice(0, iObs));
  const byType: Record<string, Set<string>> = {
    observe: new Set([...common, ...written(body.slice(iObs, iDs))]),
    dataset: new Set([...common, ...written(body.slice(iDs, iElse))]),
    redteam: new Set([...common, ...written(body.slice(iElse))]),
  };

  it("防恒真：三支键集各自非空且带自己的招牌字段", () => {
    expect(iObs).toBeGreaterThan(0);
    expect(iDs).toBeGreaterThan(iObs);
    expect(iElse).toBeGreaterThan(iDs);
    expect(common).toContain("type");
    expect(common).toContain("status");
    expect(common).toContain("error");
    expect(byType.observe).toContain("overall_mean");
    expect(byType.dataset).toContain("evaluator_stats");
    expect(byType.redteam).toContain("verdict");
    // 招牌字段不许串型（读错文件/切错片段就会串）
    expect(byType.observe).not.toContain("pass_rate");
    expect(byType.dataset).not.toContain("verdict");
    // 死字段：数据集名从来不在摘要里
    for (const t of ["observe", "dataset", "redteam"]) {
      expect(byType[t], `${t} 摘要不该有 dataset`).not.toContain("dataset");
      expect(byType[t], `${t} 摘要不该有 cases_dataset`).not.toContain("cases_dataset");
    }
  });

  /** 全仓 mock 里所有 stage_summaries 数组（含各页面各自的那份夹具） */
  const groups: [string, { type: string }[][]][] = [
    ["PLAN_RUNS", PLAN_RUNS.map((r) => r.stage_summaries)],
    ["REGRESSION_PLAN_RUNS", REGRESSION_PLAN_RUNS.map((r) => r.stage_summaries)],
    ["DDD_PLAN_RUNS", DDD_PLAN_RUNS.map((r) => r.stage_summaries)],
    ["AGENT_RUNS", AGENT_RUNS.map((r) => r.stage_summaries)],
    ["AGENT_PLANS[].last_run", AGENT_PLANS
      .map((p) => p.last_run?.stage_summaries).filter(Boolean) as { type: string }[][]],
    ["MOCK_PLAN_RUN", [MOCK_PLAN_RUN.stage_summaries]],
    ["PLAN_RUN_DETAIL.stages", [PLAN_RUN_DETAIL.stages]],
    ["BIGSCREEN_RUNS_OK", BIGSCREEN_RUNS_OK.map((r) => r.stage_summaries)],
    ["BIGSCREEN_RUNS_ALERT", BIGSCREEN_RUNS_ALERT.map((r) => r.stage_summaries)],
  ];

  for (const [name, arrays] of groups) {
    it(`${name} 的每个环节摘要都不带该 type 产不出的键`, () => {
      const seen: string[] = [];
      for (const arr of arrays) {
        for (const s of arr) {
          const allowed = byType[s.type === "observe" ? "observe"
            : s.type === "dataset" ? "dataset" : "redteam"];
          expect(extraKeys(s, allowed), `${name} 的 ${s.type} 环节`).toEqual([]);
          seen.push(s.type);
        }
      }
      // 防空转：这份夹具确实有环节摘要可查
      expect(seen.length).toBeGreaterThan(0);
    });
  }

  it("run_plan 流里的 stage_done.summary 与终帧 stages 同刑", async () => {
    const frames = await callMock({ action: "run_plan", plan_id: "plan-aaa111" });
    const summaries = [
      ...frames.filter((f) => f.event === "stage_done")
        .map((f) => f.summary as { type: string }),
      ...((frames.find((f) => f.event === "plan_run_report")!
        .stages ?? []) as { type: string }[]),
    ];
    expect(summaries.length).toBeGreaterThan(2);
    for (const s of summaries) {
      const allowed = byType[s.type === "observe" ? "observe"
        : s.type === "dataset" ? "dataset" : "redteam"];
      expect(extraKeys(s, allowed), `stage_done/终帧的 ${s.type} 环节`).toEqual([]);
    }
  });
});

// ==================== ③ estimate_plan_run ====================
//
// 首跑抓到的漂移：dataset 环节估算里的 `agent_calls` —— 后端的名字是
// `agent_invocations`（testrun.estimate_test_run 的 return）。零消费者，
// 但它正是「发起运行确认卡想显示调用次数」时会被照着写的那个名字。
describe("③ estimate_plan_run：键集 ⊆ 后端估算器的 return", () => {
  const topKeys = new Set([
    ...returnKeys(funcBody(planrunPy, "estimate_plan_run")),
    // main.py 在外层包一层 {"event", "plan_id", **estimate}
    "event", "plan_id",
  ]);
  /** 环节估算键：observe 支内联在 estimate_plan_run 里，dataset / redteam 各自
   *  复用单跑模式的估算器（planrun.py 注释：数字要与那两个流程显示的一致）。 */
  const estBody = funcBody(planrunPy, "estimate_plan_run");
  const observeEst = (() => {
    const at = estBody.indexOf("est = {");
    return new Set(topLevelKeys(braceBlock(estBody, at)));
  })();
  const stageKeys: Record<string, Set<string>> = {
    // 每项都是 {"type": kind, **est}
    observe: new Set(["type", ...observeEst]),
    dataset: new Set(["type", ...returnKeys(funcBody(testrunPy, "estimate_test_run")),
                      // 数据集不存在那一支：{"error", "estimated_cost_usd"}
                      "error"]),
    redteam: new Set(["type", ...returnKeys(funcBody(redteamPy, "estimate_redteam_run"))]),
  };

  it("防恒真：三支估算键集各自非空且带自己的招牌字段", () => {
    expect(topKeys).toContain("stages");
    expect(topKeys).toContain("estimated_cost_usd");
    expect(stageKeys.observe).toContain("judge_calls");
    expect(stageKeys.dataset).toContain("agent_invocations");
    expect(stageKeys.dataset).toContain("cases");
    expect(stageKeys.redteam).toContain("attacks");
    // 招牌字段不许串型
    expect(stageKeys.observe).not.toContain("attacks");
    expect(stageKeys.redteam).not.toContain("judge_calls");
  });

  it("mock 载荷（顶层 + 逐环节）不带后端产不出的键", async () => {
    // 两个方案凑齐三支：plan-aaa111 = observe + dataset，plan-bbb222 = redteam。
    // （plan-ccc333 三环节齐全但它的 agent has_logs=false —— 那条 estimate 回的是
    //   {event:"error"}，是**刻意**的夹具，不是能用的估算样本。）
    const stages: { type: string }[] = [];
    for (const planId of ["plan-aaa111", "plan-bbb222"]) {
      const [frame] = await callMock({ action: "estimate_plan_run", plan_id: planId });
      expect(frame.event, JSON.stringify(frame)).toBe("plan_run_estimate");
      expect(extraKeys(frame, topKeys), `${planId} 顶层`).toEqual([]);
      stages.push(...(frame.stages as { type: string }[]));
    }
    expect([...new Set(stages.map((s) => s.type))].sort())
      .toEqual(["dataset", "observe", "redteam"]);
    for (const s of stages) {
      expect(extraKeys(s, stageKeys[s.type]), `${s.type} 环节估算`).toEqual([]);
    }
  });
});

// ==================== ④ stop_plan_run 回执 ====================
describe("④ stop_plan_run 回执：键集 ⊆ app/planrun.py:request_stop 的 return", () => {
  const backendKeys = new Set([
    ...returnKeys(funcBody(planrunPy, "request_stop")),
    // main.py: yield {"event": "plan_run_stop_requested", **result}
    "event",
  ]);

  it("防恒真：后端键集含四件套 + stop_requested_at", () => {
    for (const k of ["run_key", "status", "requested", "already", "message",
                     "stop_requested_at"]) {
      expect(backendKeys, `request_stop 应能回 ${k}`).toContain(k);
    }
    // 回执不带 run 明细（前端要终态得自己拉运行历史）
    expect(backendKeys).not.toContain("stage_summaries");
    expect(backendKeys).not.toContain("score");
  });

  it("三种回执形态（running 首次 / 再次 / 已终态）都不带后端产不出的键", async () => {
    const running = PLAN_RUNS.find((r) => r.status === "running")!;
    expect(running, "PLAN_RUNS 应有 running 行（停止成功路径的夹具）").toBeTruthy();
    const first = (await callMock({ action: "stop_plan_run", run_key: running.run_key }))[0];
    const again = (await callMock({ action: "stop_plan_run", run_key: running.run_key }))[0];
    const done = (await callMock({
      action: "stop_plan_run", run_key: PLAN_RUNS.find((r) => r.status === "completed")!.run_key,
    }))[0];
    expect(first.requested).toBe(true);
    expect(first.already).toBe(false);
    expect(again.already).toBe(true);
    expect(done.requested).toBe(false);
    for (const f of [first, again, done]) {
      expect(extraKeys(f, backendKeys), JSON.stringify(f)).toEqual([]);
    }
  });
});
