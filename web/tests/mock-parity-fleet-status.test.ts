// 首页数据源 agent_status / fleet_status 的 mock 同刑三角钉（照 run-advice.test.tsx 的写法）：
//   ① 后端源码里存在该 action 的分派 + 错误原话「Agent '<name>' 不存在」；
//   ② mock 桩真跑（callMock）：未知名字回同一句错误；已知名字回 agent_status 事件，
//      顶层键集 ⊆ 后端 agentstatus.agent_status 的 return 字典键集（解析源码，不抄名单）；
//   ③ fleet_status：形状按主会话 2026-09-03 增补契约（含 cached:true 的例子、一个 Agent 落进
//      unavailable 的例子、agents[] 每份与 agent_status 同形 + metrics.sessions.hourly 24 桶）。
//      后端分支 `if action == "fleet_status":` 由并行批 fleet-status 落地 —— 未合流前那一条钉红，
//      **允许标「待后端合流转绿」，不为了绿去删钉**。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MOCK_ACCESS_TOKEN } from "../src/mocks/handlers";

const mainPy = readFileSync(resolve(process.cwd(), "../app/main.py"), "utf8");
const agentstatusPy = readFileSync(resolve(process.cwd(), "../app/agentstatus.py"), "utf8");

/** 走 mock handler 本身发一次请求，返回首帧事件对象（与 contract-guard 同手法，不复制常量） */
async function callMock(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { handlers } = await import("../src/mocks/handlers");
  const apiHandler = handlers.find((h) =>
    String((h as { info?: { path?: unknown } }).info?.path ?? "").includes("/api/invoke"));
  expect(apiHandler, "mocks/handlers.ts 应有 /api/invoke 的 handler").toBeTruthy();
  const res = await (apiHandler as unknown as {
    run: (a: { request: Request }) => Promise<{ response?: Response }>;
  }).run({
    request: new Request("http://localhost/api/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-authorization": `Bearer ${MOCK_ACCESS_TOKEN}` },
      body: JSON.stringify(payload),
    }),
  });
  const text = await res.response!.text();
  const frame = text.split("\n\n").filter(Boolean)[0].replace(/^data: /, "");
  return JSON.parse(frame);
}

/** 从 `start` 处起，按 {} 深度切出一个平衡的字典字面量 */
function braceBlock(py: string, start: number): string {
  const open = py.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < py.length; i += 1) {
    if (py[i] === "{") depth += 1;
    else if (py[i] === "}") { depth -= 1; if (depth === 0) return py.slice(open, i + 1); }
  }
  throw new Error(`未闭合的字典字面量 @${start}`);
}
/** 字典字面量里**顶层**的键名 */
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

/** 事件字面量所在的那个字典字面量的起点。
 *  **不能**按「往前找最近的 `return {`」锚定：那条锚点假设「事件字典一定直接 return」，
 *  2026-09-08 批 simp-A2 给 agent_status 加缓存时把它改成 `status = { … }` 再 return，
 *  锚点就静默滑到上一个 `return {`（`last_run` 那个），量出别人的键集。
 *  改成按结构锚定：往前找**包住** `at` 的那个 `{`（第一个满足「它的平衡块覆盖 at」的候选）。 */
function enclosingDictStart(py: string, at: number): number {
  for (let i = at; i >= 0; i -= 1) {
    if (py[i] !== "{") continue;
    const block = braceBlock(py, i);
    if (i + block.length > at) return i;
  }
  throw new Error(`找不到包住 @${at} 的字典字面量`);
}

/** 后端 agent_status 事件字典的键集（源码解析；恒真防护：必须含已知键） */
function backendAgentStatusKeys(): Set<string> {
  const at = agentstatusPy.indexOf('"event": "agent_status"');
  expect(at, "agentstatus.py 应有 agent_status 事件字典").toBeGreaterThan(0);
  const keys = topLevelKeys(braceBlock(agentstatusPy, enclosingDictStart(agentstatusPy, at)));
  expect(keys).toContain("metrics");
  expect(keys).toContain("unavailable_reason");
  return new Set(keys);
}

describe("① 后端三角钉：分派 + 错误原话", () => {
  it("app/main.py 分派 agent_status；agentstatus.agent_status 抛的原话是「Agent '<name>' 不存在」", () => {
    expect(mainPy).toContain('if action == "agent_status":');
    expect(agentstatusPy).toContain("def agent_status(");
    expect(agentstatusPy).toContain("raise ValueError(f\"Agent '{agent_name}' 不存在\")");
  });

  // 后端批 fleet-status 已合流到 react-rewrite（cd6a2ec）；本 worktree 基线 47326a4 还没有那段源码
  // ⇒ 在本树上这一条红是预期，合流后同一把尺子转绿（主会话 2026-09-03 授权：不为绿删钉）
  it("app/main.py 分派 fleet_status（本树基线早于后端合流 ⇒ 合流后转绿）", () => {
    expect(mainPy).toContain('if action == "fleet_status":');
  });
});

describe("② agent_status 桩与后端同刑", () => {
  it("未知名字 → 与后端同一句错误原话", async () => {
    const ev = await callMock({ action: "agent_status", agent_name: "nope" });
    expect(ev.event).toBe("error");
    expect(ev.error).toBe("Agent 'nope' 不存在");
  });

  it("已知名字 → agent_status 事件，顶层键 ⊆ 后端 return 字典键集；null 项都有 unavailable_reason", async () => {
    const backend = backendAgentStatusKeys();
    for (const name of ["support-bot", "research-agent"]) {
      const ev = await callMock({ action: "agent_status", agent_name: name });
      expect(ev.event).toBe("agent_status");
      const extra = Object.keys(ev).filter((k) => !backend.has(k));
      expect(extra, `${name} 的 mock 多出后端没有的键`).toEqual([]);
      // 五个数每个都是 {value, prev, delta}
      const metrics = ev.metrics as Record<string, { value: unknown; prev: unknown; delta: unknown }>;
      expect(Object.keys(metrics).sort()).toEqual(
        ["agent_cost_usd", "blank_rate", "p95_latency_ms", "sessions", "tool_failure_rate"]);
      const reasons = ev.unavailable_reason as Record<string, string>;
      for (const [k, m] of Object.entries(metrics)) {
        if (m.value === null) expect(reasons[`metrics.${k}`], `${name}.${k} 为 null 却没写原因`).toBeTruthy();
      }
    }
    // research-agent：五数全 null + 原因齐全（「不编数」的形态例子）
    const r = await callMock({ action: "agent_status", agent_name: "research-agent" });
    expect(Object.values(r.metrics as Record<string, { value: unknown }>).every((m) => m.value === null)).toBe(true);
    expect((r.next_run as { at: unknown }).at).toBeNull();
    expect((r.unavailable_reason as Record<string, string>)["next_run.at"]).toContain("rate(1 day)");
  });
});

describe("③ fleet_status 桩形状", () => {
  it("顶层十键（= 后端 fleetstatus._compute 的 return 键集）；agents[] 每份与 agent_status 同形且 metrics.sessions.hourly 是 24 桶或 []", async () => {
    const ev = await callMock({ action: "fleet_status" });
    // 键集从后端源码现取（fleetstatus._compute 的 return 字典），不抄名单
    const fleetstatusPy = readFileSync(resolve(process.cwd(), "../app/fleetstatus.py"), "utf8");
    const ret = fleetstatusPy.indexOf("return {", fleetstatusPy.indexOf("def _compute("));
    const backendKeys = topLevelKeys(braceBlock(fleetstatusPy, ret)).sort();
    expect(backendKeys).toEqual(
      ["agents", "cache_age_s", "cached", "computed_at", "event", "fleet", "generated_at", "todo",
       "unavailable", "window_hours"]);
    expect(Object.keys(ev).sort()).toEqual(backendKeys);
    expect(ev.event).toBe("fleet_status");
    // 默认（非 ?mock=fleet）给 cached:true 的例子；命中态 computed_at 不变、cache_age_s 落在 (0, 300]
    expect(ev.cached).toBe(true);
    expect(ev.computed_at).toBe(ev.generated_at);
    expect(ev.cache_age_s).toBeGreaterThan(0);
    expect(ev.cache_age_s).toBeLessThanOrEqual(300);
    const backend = backendAgentStatusKeys();
    const agents = ev.agents as Record<string, unknown>[];
    expect(agents.length).toBeGreaterThan(0);
    for (const a of agents) {
      expect(Object.keys(a).filter((k) => !backend.has(k))).toEqual([]);
      const hourly = (a.metrics as { sessions: { hourly: unknown[] } }).sessions.hourly;
      expect(Array.isArray(hourly)).toBe(true);
      expect([0, 24]).toContain(hourly.length);
    }
    // 舰队聚合六键
    expect(Object.keys(ev.fleet as object).sort()).toEqual(
      ["agents", "anomaly_rate", "cost_usd", "hourly", "sessions", "worst_p95"]);
    // 一个 Agent 落进 unavailable 的例子（research-agent 没有 span 组）；键与 unavailable_reason 一致
    const unavailable = ev.unavailable as Record<string, Record<string, string>>;
    expect(Object.keys(unavailable)).toContain("research-agent");
    expect(unavailable["research-agent"]["metrics.sessions"]).toContain("没有 span 组");
    for (const [name, reasons] of Object.entries(unavailable)) {
      const own = agents.find((a) => a.agent_name === name)!.unavailable_reason;
      expect(reasons, `${name} 的 unavailable 与自身 unavailable_reason 不一致`).toEqual(own);
    }
    // todo 每条五键 + observe 在 evaluate 前
    const todo = ev.todo as { layer: string; kind: string; action: string; fact: string; target: unknown }[];
    for (const t of todo) {
      expect(Object.keys(t).sort()).toEqual(["action", "agent_name", "fact", "kind", "layer", "target"]);
    }
    const firstEval = todo.findIndex((t) => t.layer === "evaluate");
    const lastObs = todo.map((t) => t.layer).lastIndexOf("observe");
    if (firstEval >= 0 && lastObs >= 0) expect(lastObs).toBeLessThan(firstEval);
  });
});
