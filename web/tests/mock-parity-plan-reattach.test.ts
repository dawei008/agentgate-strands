// mock 同刑（UI-029 批 3：断流转轮询 / 刷新恢复 / 心跳与进度 / stale 展示）。
//
// 与 tests/mock-parity.test.ts 同一条纪律、同一套办法：**后端真形态的唯一依据是
// 后端源码本身**（readFileSync + 解析出键名），不是本文件抄的名单。本仓五次白屏
// 事故都是同一个形状 —— mock 造了后端产不出的东西，前端照 mock 写，测试全绿而
// 线上一到真数据就崩或恒空。本批四个新字段全部经过这条守卫：
//
//   ① run 项的 stale / heartbeat_epoch / progress / checkpoint_s3_key
//      ← app/planrun.py:_run_from_item 的 return 键（读侧唯一出口）
//   ② progress 对象内部的四个键
//      ← app/planrun.py:_write_stage_checkpoint 里 `progress = {…}` 的字面量
//   ③ plan_run_started 帧的 run_key（断流轮询/刷新恢复的钥匙）
//      ← app/planrun.py:execute_plan_run 里 `started_event = {…}`
//   ④ 三形态齐（本批展示侧的三条真实分支，缺一条就有一条降级路径没显影过）：
//      有心跳的新 running / 无字段的老 running（降级不显示）/ stale=true 疑似中断
//
// 方向仍**只查一个方向**（mock ⊆ 后端）：反向缺口只让前端走降级路径（老 run
// 天然缺字段，那是真行为），而多一个键会让前端长出线上不存在的读法。
//
// 恒真陷阱防护：每组先钉「源码里确实解析出了非空键集且含招牌字段」——正则一失配
// 就得到空集，`⊆ 空集` 反而处处绿，守卫被悄悄拆掉。
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MOCK_ACCESS_TOKEN, PLAN_RUNS, REGRESSION_PLAN_RUNS, REATTACH_PLAN_RUNS,
} from "../src/mocks/handlers";

const planrunPy = readFileSync(resolve(process.cwd(), "../app/planrun.py"), "utf8");

// ==================== 源码解析（同族既有两份的朴素解析，逐条注释见 mock-parity） ====================

/** 从 `start` 处起按 {} 深度切出一个平衡的字典字面量。 */
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

/** 字典字面量里**顶层**的键名（嵌套字典的键属于别的一层的契约）。 */
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

/** mock 里有、后端没有的那些键。 */
function extraKeys(obj: object, allowed: Set<string>): string[] {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

/** 走 mock handler 本身发一次请求，返回全部帧（同 mock-parity 的 callMock）。 */
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

/** ?mock=<mode> 切换（handlers 的 mockMode 读 location.search）。 */
function setMockMode(mode: string | null): void {
  history.replaceState({}, "", mode ? `/?mock=${mode}` : "/");
}

// 后端读侧的唯一出口：run 项到前端的全部键
const RUN_ITEM_KEYS = new Set(topLevelKeys(
  braceBlock(funcBody(planrunPy, "_run_from_item"),
             funcBody(planrunPy, "_run_from_item").indexOf("return {"))));

type MockRun = Record<string, unknown> & { run_key: string; status: string };

const runningRows = (rows: readonly unknown[]): MockRun[] =>
  (rows as MockRun[]).filter((r) => r.status === "running");

// ==================== ① run 项键集 ⊆ _run_from_item ====================
describe("① run 项：键集 ⊆ app/planrun.py:_run_from_item 的 return", () => {
  it("防恒真：后端键集非空，含本批四件，且不含 get_plan_run 才附的 report", () => {
    expect(RUN_ITEM_KEYS.size).toBeGreaterThan(15);
    for (const k of ["run_key", "status", "stage_summaries",
                     "stale", "heartbeat_epoch", "progress", "checkpoint_s3_key"]) {
      expect(RUN_ITEM_KEYS, `_run_from_item 应产出 ${k}`).toContain(k);
    }
    // report / synthesis_sections 是 get_plan_run 在摘要之外**另附**的，
    // 不属于列表行的键 —— 混进来就会让 run 行长出「摘要里有全量报告」的读法
    expect(RUN_ITEM_KEYS).not.toContain("report");
    expect(RUN_ITEM_KEYS).not.toContain("synthesis_sections");
  });

  const groups: [string, readonly unknown[]][] = [
    ["PLAN_RUNS", PLAN_RUNS],
    ["REGRESSION_PLAN_RUNS", REGRESSION_PLAN_RUNS],
    ["REATTACH_PLAN_RUNS", REATTACH_PLAN_RUNS],
  ];
  for (const [name, rows] of groups) {
    it(`${name} 的每一行都不带后端产不出的键`, () => {
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows as MockRun[]) {
        expect(extraKeys(r, RUN_ITEM_KEYS), `${name} 的 ${r.run_key}`).toEqual([]);
      }
    });
  }
});

// ==================== ② progress 内部键集 ⊆ 写侧字面量 ====================
describe("② progress 对象：键集 ⊆ _write_stage_checkpoint 的 progress 字面量", () => {
  const body = funcBody(planrunPy, "_write_stage_checkpoint");
  const PROGRESS_KEYS = new Set(topLevelKeys(braceBlock(body, body.indexOf("progress = {"))));

  it("防恒真：写侧四个键都在（stages_done/stages_total/stage/…partial）", () => {
    for (const k of ["stages_done", "stages_total", "stage", "stage_summaries_partial"]) {
      expect(PROGRESS_KEYS, `写侧 progress 应有 ${k}`).toContain(k);
    }
    expect(PROGRESS_KEYS.size).toBe(4);
  });

  it("桩里每个 progress 都不带写侧产不出的键，且数字自洽", () => {
    const seen = [...PLAN_RUNS, ...REATTACH_PLAN_RUNS]
      .map((r) => (r as MockRun).progress)
      .filter((p): p is Record<string, unknown> => p != null && typeof p === "object");
    expect(seen.length, "桩里应至少有一份 progress（有心跳的新 running）")
      .toBeGreaterThan(0);
    for (const p of seen) {
      expect(extraKeys(p, PROGRESS_KEYS)).toEqual([]);
      // 「已完成 X/N 环节」：X ≤ N 且 stage 是**刚结束**那个环节的类型
      expect(Number(p.stages_done)).toBeLessThanOrEqual(Number(p.stages_total));
      expect(["observe", "dataset", "redteam"]).toContain(String(p.stage));
    }
  });
});

// ==================== ③ plan_run_started 带 run_key ====================
describe("③ plan_run_started：键集 ⊆ 后端 started_event，且必须带 run_key", () => {
  // 字面量的键 + 事后条件赋值的键（`started_event["estimate"] = estimate`
  // —— 后端只在有预估时挂上去，漏了这一半会把桩里合法的 estimate 判成漂移）
  const STARTED_KEYS = new Set([
    ...topLevelKeys(braceBlock(
      planrunPy, planrunPy.indexOf('started_event = {"event": "plan_run_started"'))),
    ...[...planrunPy.matchAll(/started_event\["([a-z_]+)"\]\s*=/g)].map((m) => m[1]),
  ]);

  afterEach(() => setMockMode(null));

  it("防恒真：后端 started_event 含 run_key/started_epoch 与既有五件", () => {
    for (const k of ["event", "plan_id", "plan_name", "agent", "stages", "triggered_by",
                     "run_key", "started_epoch"]) {
      expect(STARTED_KEYS, `started_event 应有 ${k}`).toContain(k);
    }
  });

  it("快速流与断流模式的首帧都带 run_key，且不带后端产不出的键", async () => {
    for (const mode of [null, "reattach"]) {
      setMockMode(mode);
      const frames = await callMock({ action: "run_plan", plan_id: "plan-aaa111" });
      const started = frames.find((f) => f.event === "plan_run_started")!;
      expect(started, `${mode ?? "默认"}流应有 plan_run_started`).toBeTruthy();
      expect(extraKeys(started, STARTED_KEYS), JSON.stringify(started)).toEqual([]);
      expect(typeof started.run_key, `${mode ?? "默认"}流的 run_key`).toBe("string");
      expect(String(started.run_key)).toContain("plan-aaa111#");
    }
  });
});

// ==================== ④ 三形态齐 + 断流可测路径 ====================
describe("④ 三形态齐：新 running 带心跳 / 老 running 缺字段 / stale=true", () => {
  afterEach(() => setMockMode(null));

  it("默认模式的 running 行 = 老 running 降级形态（三件全无、stale 为 false）", () => {
    const rows = runningRows(PLAN_RUNS);
    expect(rows.length).toBe(1);
    const [row] = rows;
    // 这一行的 item 连 started_epoch 都没有（夹具本来就不带）→ 后端三级判据
    // 无从判定，`stalecheck.is_stale` 保守回 False。所以 false 是这一行的**真值**，
    // 不是随手填的默认值。
    expect(row.stale).toBe(false);
    for (const k of ["heartbeat_epoch", "progress", "checkpoint_s3_key"]) {
      expect(row, `老 running 不该有 ${k}（展示侧降级：不显示、不伪造）`)
        .not.toHaveProperty(k);
    }
  });

  it("reattach 模式：一行新 running（心跳+进度）+ 一行 stale=true 疑似中断", () => {
    const rows = runningRows(REATTACH_PLAN_RUNS);
    const fresh = rows.filter((r) => typeof r.heartbeat_epoch === "number");
    const stale = rows.filter((r) => r.stale === true);
    expect(fresh.length, "应有一行带心跳的新 running").toBe(1);
    expect(stale.length, "应有一行 stale=true 的疑似中断").toBe(1);
    // 心跳是**新鲜**的（相对导入时刻的秒级 epoch）：写死一个历史 epoch 会让界面
    // 显示「最后心跳 56 年前」，也和 stale=false 自相矛盾
    const age = Math.floor(Date.now() / 1000) - Number(fresh[0].heartbeat_epoch);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age, "新 running 的心跳应在陈旧阈值（210s）之内").toBeLessThan(210);
    expect(fresh[0].stale).toBe(false);
    expect(fresh[0].progress).toBeTruthy();
    // 陈旧那一行**不带**心跳：心跳新鲜就不可能陈旧（一级判据），两者同时出现
    // 就是后端产不出的形态
    expect(stale[0]).not.toHaveProperty("heartbeat_epoch");
  });

  it("list_plan_runs 按模式给出对应形态（前端从这里恢复「进行中」面板）", async () => {
    const def = (await callMock({ action: "list_plan_runs", plan_id: "plan-aaa111" }))[0];
    expect((def.runs as MockRun[]).filter((r) => r.status === "running")).toHaveLength(1);
    setMockMode("reattach");
    const re = (await callMock({ action: "list_plan_runs", plan_id: "plan-aaa111" }))[0];
    const running = (re.runs as MockRun[]).filter((r) => r.status === "running");
    expect(running).toHaveLength(2);
    expect(running.some((r) => r.stale === true)).toBe(true);
  });

  it("断流可测路径：reattach 模式的流中途结束、**没有**终帧", async () => {
    setMockMode("reattach");
    const frames = await callMock({ action: "run_plan", plan_id: "plan-aaa111" });
    expect(frames.some((f) => f.event === "plan_run_started")).toBe(true);
    expect(frames.some((f) => f.event === "plan_run_report"),
           "断流路径不许发终帧 —— 否则前端根本不会转轮询").toBe(false);
  });

  it("轮询钥匙可用：get_plan_run 对 running run_key 回 running 形态（键集同刑）", async () => {
    setMockMode("reattach");
    const key = runningRows(REATTACH_PLAN_RUNS)
      .find((r) => typeof r.heartbeat_epoch === "number")!.run_key;
    const [run] = await callMock({ action: "get_plan_run", run_key: key });
    expect(run.event).toBe("plan_run");
    expect(run.status).toBe("running");
    expect(typeof run.heartbeat_epoch).toBe("number");
    expect(run.progress).toBeTruthy();
    expect(run.stale).toBe(false);
    // 运行中的 run 还没有归档：s3_key 空、没有 report（真后端 get_plan_run 只有
    // item.s3_key 非空才去 S3 拉）
    expect(run.report ?? null).toBeNull();
    // 键集 ⊆ 读侧 + get_plan_run 另附的两个
    expect(extraKeys(run, new Set([...RUN_ITEM_KEYS, "event", "synthesis_sections",
                                   "report", "report_error"]))).toEqual([]);
  });
});
