// mock 同刑（UI-029 批 4：从检查点续跑）。
//
// 与 tests/mock-parity.test.ts / mock-parity-plan-reattach.test.ts 同一条纪律、
// 同一套办法：**后端真形态的唯一依据是后端源码本身**（readFileSync + 解析出键名/
// 字面量），不是本文件抄的名单。本仓五次白屏事故都是同一个形状 —— mock 造了后端
// 产不出的东西，前端照 mock 写，测试全绿而线上一到真数据就崩或恒空。
//
// 本批四组：
//   ① 续跑首帧的 `resume` 段：键集 ⊆ 后端 started_event["resume"] 的字面量
//      + resume_cost_ceiling 的返回键（app/planrun.py）；
//   ② 可续跑的状态集：mock 的判据 ⊆ 后端 RESUMABLE_STATUSES；
//   ③ 拒绝路径：mock 的四条错误帧与后端 resume_context 抛的 ValueError **同句**
//      （中文状态词那句尤其：绝不把英文枚举印给用户）；
//   ④ 「终态 + 检查点」这个入口素材本身是后端**产得出**的形态：只有 reaper 改判
//      那条路（update 只补字段）会留下指针，且它**不填** stage_summaries ——
//      夹具行必须与之逐条对齐，否则前端会长出线上不存在的读法。
//
// 恒真陷阱防护：每组先钉「源码里确实解析出了非空集合且含招牌字段」——正则一失配
// 就得到空集，`⊆ 空集` 反而处处绿，守卫被悄悄拆掉。
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MOCK_ACCESS_TOKEN, PLAN_RUNS, REATTACH_PLAN_RUNS } from "../src/mocks/handlers";
import { isResumable } from "../src/pages/plan/resume";

const planrunPy = readFileSync(resolve(process.cwd(), "../app/planrun.py"), "utf8");
const handlersTs = readFileSync(
  resolve(process.cwd(), "src/mocks/handlers.ts"), "utf8");

// ---------------- 源码解析（同族既有两份的朴素解析） ----------------

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

function funcBody(py: string, name: string): string {
  const m = new RegExp(`^(?:async )?def ${name}\\(`, "m").exec(py);
  if (!m) throw new Error(`找不到函数 ${name}`);
  const rest = py.slice(m.index);
  const next = /\n(?:async )?def /.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

const extraKeys = (obj: object, allowed: Set<string>) =>
  Object.keys(obj).filter((k) => !allowed.has(k));

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

function setMockMode(mode: string | null): void {
  history.replaceState({}, "", mode ? `/?mock=${mode}` : "/");
}

// 后端读侧的唯一出口（run 项到前端的全部键）
const RUN_ITEM_KEYS = new Set(topLevelKeys(
  braceBlock(funcBody(planrunPy, "_run_from_item"),
             funcBody(planrunPy, "_run_from_item").indexOf("return {"))));

// 续跑首帧那一段：字面量的三个键 + resume_cost_ceiling 返回的三个键
const RESUME_SEG_KEYS = new Set([
  ...topLevelKeys(braceBlock(planrunPy,
                             planrunPy.indexOf('started_event["resume"] = {'))),
  ...topLevelKeys(braceBlock(funcBody(planrunPy, "resume_cost_ceiling"),
                             funcBody(planrunPy, "resume_cost_ceiling")
                               .indexOf("out = {"))),
]);

/** 后端 RESUMABLE_STATUSES 的字面量。 */
const BACKEND_RESUMABLE = new Set(
  [...(/RESUMABLE_STATUSES = \(([^)]*)\)/.exec(planrunPy)?.[1] ?? "")
    .matchAll(/"([a-z_]+)"|(STOP_STATUS)/g)]
    .map((m) => (m[2] ? "stopped" : m[1])));   // STOP_STATUS = "stopped"（testrun.py）

const REAPED_ROW = REATTACH_PLAN_RUNS.find(
  (r) => (r as { checkpoint_s3_key?: string }).checkpoint_s3_key
    && (r as { status: string }).status !== "running") as Record<string, unknown> | undefined;

const RESUMABLE_RUN_KEY = String(REAPED_ROW?.run_key ?? "");

afterEach(() => setMockMode(null));

// ==================== ① resume 段键集 ====================
describe("① 续跑首帧的 resume 段：键集 ⊆ 后端 started_event['resume']", () => {
  it("防恒真：后端那一段确实解析出六个键（三个身份 + 三个上界）", () => {
    for (const k of ["attempt", "resumed_from", "stages_done",
                     "from_stage", "stages_total", "added_max_usd", "rebill_max_usd"]) {
      expect(RESUME_SEG_KEYS, `后端 resume 段应有 ${k}`).toContain(k);
    }
  });

  it("桩的首帧带 resume 段，键集不多一个，且数字自洽", async () => {
    setMockMode("reattach");
    const frames = await callMock({
      action: "resume_plan_run", run_key: RESUMABLE_RUN_KEY,
    });
    const started = frames.find((f) => f.event === "plan_run_started");
    expect(started, "续跑首帧仍叫 plan_run_started（同名同形）").toBeTruthy();
    // run_key **沿用原来那一次**：同 run_key 原地续（规格开放问题 2）
    expect(started!.run_key).toBe(RESUMABLE_RUN_KEY);
    const seg = started!.resume as Record<string, unknown>;
    expect(extraKeys(seg, RESUME_SEG_KEYS), JSON.stringify(seg)).toEqual([]);
    expect(Number(seg.attempt)).toBeGreaterThanOrEqual(2);   // attempt+1
    expect(Number(seg.from_stage)).toBe(Number(seg.stages_done) + 1);
    expect(Number(seg.stages_done)).toBeLessThan(Number(seg.stages_total));
    // 上界：新增 ≥ 重计费（后者只是被重跑那一个环节）
    expect(Number(seg.added_max_usd)).toBeGreaterThanOrEqual(Number(seg.rebill_max_usd));
    expect(Number(seg.rebill_max_usd)).toBeGreaterThan(0);
    expect(String(seg.resumed_from)).toMatch(/\/stage-\d+\.json$/);
  });

  it("注入的环节一个事件都不发（那一环这次并没有在跑）", async () => {
    setMockMode("reattach");
    const frames = await callMock({
      action: "resume_plan_run", run_key: RESUMABLE_RUN_KEY,
    });
    const seg = frames.find((f) => f.event === "plan_run_started")!.resume as
      Record<string, number>;
    const starts = frames.filter((f) => f.event === "stage_start")
      .map((f) => Number(f.stage));
    expect(starts.length).toBeGreaterThan(0);
    expect(Math.min(...starts), "第一个开跑的环节必须是 from_stage")
      .toBe(seg.from_stage);
    expect(frames.some((f) => f.event === "plan_run_report"),
           "续跑照旧走同一条终帧").toBe(true);
  });
});

// ==================== ② 可续跑状态集 ====================
describe("② 可续跑状态：mock 与前端判据 ⊆ 后端 RESUMABLE_STATUSES", () => {
  it("防恒真：后端集合非空且是 error/failed/stopped 三态", () => {
    expect(BACKEND_RESUMABLE.size).toBe(3);
    for (const s of ["error", "failed", "stopped"]) {
      expect(BACKEND_RESUMABLE).toContain(s);
    }
    // completed/running/skipped 一律不在（前者白花钱，中者并发烧两份钱）
    for (const s of ["completed", "running", "skipped", "halted_cost"]) {
      expect(BACKEND_RESUMABLE).not.toContain(s);
    }
  });

  it("前端 isResumable 与后端逐态一致（不多给一个能点的按钮）", () => {
    const ck = "checkpoints/p/ts/stage-1.json";
    for (const s of ["error", "failed", "stopped", "completed", "running",
                     "skipped", "halted_cost"]) {
      expect(isResumable({ status: s, checkpoint_s3_key: ck }), s)
        .toBe(BACKEND_RESUMABLE.has(s));
    }
  });

  it("mock 判据里那三个状态字面量与后端同集合", () => {
    const inMock = /\["error", "failed", "stopped"\]\.includes\(resumeStatus\)/
      .test(handlersTs);
    expect(inMock, "handlers.ts 的可续跑状态集应逐字镜像后端三态").toBe(true);
  });
});

// ==================== ③ 拒绝路径同句 ====================
describe("③ 拒绝路径：mock 的错误帧与后端 resume_context 同句", () => {
  const body = funcBody(planrunPy, "resume_context");

  it("防恒真：后端确实抛这四类 ValueError", () => {
    expect(body).toContain("不存在");
    expect(body).toContain("无法从检查点续跑");
    expect(body).toContain("没有检查点");
    expect(body).toContain("本次调用未改动任何记录");
  });

  it("run 不存在 → error 帧，且**不发任何 stage 事件**（一分钱没花）", async () => {
    const frames = await callMock({
      action: "resume_plan_run", run_key: "plan-aaa111#2099-01-01T00:00:00Z",
    });
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("error");
    expect(String(frames[0].error)).toContain("不存在");
  });

  it("completed → error 帧，且带**中文**状态词（英文枚举不许印给用户）", async () => {
    const done = PLAN_RUNS.find((r) => r.status === "completed")!;
    const frames = await callMock({
      action: "resume_plan_run", run_key: done.run_key,
    });
    expect(frames[0].event).toBe("error");
    expect(String(frames[0].error)).toContain("已完成");
    expect(String(frames[0].error)).toContain("无法从检查点续跑");
    expect(String(frames[0].error)).not.toMatch(/completed|error"/);
  });

  it("终态但没有检查点（老 run）→ 后端那句「没有检查点」", async () => {
    // 默认模式下 08-02 那行就是老形态（未被投影成 reaper 形态）
    const frames = await callMock({
      action: "resume_plan_run", run_key: "plan-aaa111#2026-08-02T03:00:00Z",
    });
    expect(frames[0].event).toBe("error");
    expect(String(frames[0].error)).toContain("没有检查点");
    expect(frames.some((f) => f.event === "stage_start")).toBe(false);
  });
});

// ==================== ④ 入口素材是后端产得出的形态 ====================
describe("④ 「终态 + 检查点」夹具：与 reaper 改判那条路逐条对齐", () => {
  it("防恒真：reattach 夹具里确实有这么一行（否则入口的四态测不全）", () => {
    expect(REAPED_ROW, "REATTACH_PLAN_RUNS 应有一行终态 + 检查点").toBeTruthy();
    expect(isResumable(REAPED_ROW as never)).toBe(true);
  });

  it("键集 ⊆ 读侧 _run_from_item，且逐条与 _reap_write 的写法一致", () => {
    const row = REAPED_ROW!;
    expect(extraKeys(row, RUN_ITEM_KEYS), JSON.stringify(row)).toEqual([]);
    expect(row.status).toBe("error");
    // 改判走 update 只补终态与原因 ⇒ 摘要仍是开跑 marker 的空数组
    expect(row.stage_summaries).toEqual([]);
    // 原因逐字照 _REAP_NOTE（用户要能区分「Agent 挂了」与「平台没收尾」）
    const note = /_REAP_NOTE = \(([\s\S]*?)\)\n/.exec(planrunPy)?.[1] ?? "";
    const wanted = [...note.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
    expect(wanted.length, "后端 _REAP_NOTE 应解析出非空文案").toBeGreaterThan(10);
    expect(row.error).toBe(wanted);
    // 指针指向写侧那条路径（checkpoints/<plan_id>/<ts>/stage-<i>.json）
    expect(String(row.checkpoint_s3_key)).toMatch(
      /^checkpoints\/plan-aaa111\/.+\/stage-\d+\.json$/);
    expect(planrunPy).toContain('f"checkpoints/{plan[\'plan_id\']}/{ts}"');
  });

  it("默认模式一行都没被改（视觉基线只截默认模式，08/14/17 不许被本批推翻）", () => {
    expect(PLAN_RUNS.length).toBe(REATTACH_PLAN_RUNS.length - 1);
    const plain = PLAN_RUNS.find((r) => r.run_key === RESUMABLE_RUN_KEY) as
      Record<string, unknown>;
    expect(plain, "默认夹具里那一行仍在").toBeTruthy();
    expect(plain).not.toHaveProperty("checkpoint_s3_key");
    expect(isResumable(plain as never), "默认模式不出现续跑入口").toBe(false);
  });
});
