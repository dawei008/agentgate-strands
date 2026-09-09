// mock 同刑（Agent 显示元数据 + run 版本快照）：桩产出的字段名 ⊆ 后端真形态。
//
// 与 tests/mock-parity.test.ts 同一条纪律、同一套办法：**后端真形态的唯一依据是
// 后端源码本身**（readFileSync + 解析出键名），不是本文件抄的名单 —— 抄名单等于把
// 漂移换个地方存。本仓三次白屏事故都是「mock 造了后端产不出的东西」。
//
// 本批新增的四组字段，各自的后端住所：
//   ① discover 行的 overlay      ← app/catalog.py:_overlay_agent_meta 的赋值键
//   ② run 记录的版本快照（写）    ← app/planrun.py:_agent_snapshot 的赋值键
//      run 记录的版本快照（读）    ← app/planrun.py:_run_from_item 的 return 键
//   ③ set_agent_meta 回执        ← app/main.py 的 agent_meta_set yield + catalog
//                                  .set_agent_meta 的 return（**saved 展开）
//   ④ 反向防漂：Agent 侧字段名（version_label）与 run 快照字段名
//      （agent_version_label）**是两个键**，桩里不许互串 —— 串了就等于把
//      「Agent 当前标签」当成「这次运行的快照」，正是护栏 1 要防的那件事。
//
// 恒真陷阱防护：每组都先钉「源码里确实解析出了非空键集且含招牌字段」。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MOCK_ACCESS_TOKEN, PLAN_RUNS, AGENTS, applyAgentMeta } from "../src/mocks/handlers";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const catalogPy = read("../app/catalog.py");
const mainPy = read("../app/main.py");
const planrunPy = read("../app/planrun.py");

/** 函数体（def 到下一个顶层 def / 文件尾）——同 mock-parity 的 funcBody。 */
function funcBody(py: string, name: string): string {
  const m = new RegExp(`^(?:async )?def ${name}\\(`, "m").exec(py);
  if (!m) throw new Error(`找不到函数 ${name}`);
  const rest = py.slice(m.index);
  const next = /\n(?:async )?def /.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

/** 函数体里 `<var>["key"] = ...` 的赋值键（写入集）。 */
function assignedKeys(body: string, varName: string): string[] {
  return [...body.matchAll(new RegExp(`${varName}\\["([^"]+)"\\]\\s*=`, "g"))]
    .map((m) => m[1]);
}

/** 函数体里 `"key": ...` 的键（读出集，够用的朴素解析）。 */
function dictKeys(body: string): string[] {
  return [...body.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
}

const overlayKeys = assignedKeys(funcBody(catalogPy, "_overlay_agent_meta"), "agent");
const snapshotWritten = assignedKeys(funcBody(planrunPy, "_agent_snapshot"), "snap");
const runReadKeys = dictKeys(funcBody(planrunPy, "_run_from_item"))
  .filter((k) => k.startsWith("agent_"));
// AGENT_META_FIELDS = ("display_name", "version_label")（catalog 的单一来源）
const metaFields = [...(/AGENT_META_FIELDS = \(([^)]*)\)/.exec(catalogPy)?.[1] ?? "")
  .matchAll(/"([^"]+)"/g)].map((m) => m[1]);

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

describe("防恒真：后端源码里确实解析出了这几组键", () => {
  it("三处赋值/读出集非空且含招牌字段", () => {
    expect(overlayKeys).toEqual(["display_name", "version_label"]);
    expect(snapshotWritten).toEqual(["agent_version_label", "agent_runtime_arn"]);
    expect(runReadKeys.sort()).toEqual(["agent_name", "agent_runtime_arn", "agent_version_label"]);
    expect(metaFields).toEqual(["display_name", "version_label"]);
  });
});

describe("① discover overlay：桩叠的键 = 后端 _overlay_agent_meta 叠的键", () => {
  it("每行都恰好多出后端那两个键，agent_name 不变", () => {
    const before = AGENTS[0];
    const after = applyAgentMeta(AGENTS)[0];
    const added = Object.keys(after).filter((k) => !(k in before));
    expect(added.sort()).toEqual([...overlayKeys].sort());
    expect(after.agent_name).toBe(before.agent_name);
  });

  it("discover 帧的每一行都带这两个键（后端恒带，没标注过是空串）", async () => {
    const [frame] = await callMock({ action: "discover" });
    const agents = frame.agents as Record<string, unknown>[];
    expect(agents.length).toBeGreaterThan(0);
    for (const a of agents) {
      for (const k of overlayKeys) expect(a).toHaveProperty(k);
      expect(typeof a[overlayKeys[0]]).toBe("string");
    }
  });
});

describe("② run 版本快照：夹具的键名与后端逐字一致", () => {
  const snapshotKeysOf = (run: object) =>
    Object.keys(run).filter((k) => k.startsWith("agent_"));

  it("夹具里带快照的行只用后端写得出的那两个键", () => {
    const withSnapshot = PLAN_RUNS.filter((r) => snapshotKeysOf(r).length > 0);
    expect(withSnapshot.length).toBeGreaterThan(0);
    for (const run of withSnapshot) {
      expect(snapshotKeysOf(run).sort()).toEqual([...snapshotWritten].sort());
    }
  });

  it("写入集与读出集是同一批键（后端漏投影/漏读这里就红）", () => {
    expect([...snapshotWritten].sort())
      .toEqual(runReadKeys.filter((k) => k !== "agent_name").sort());
    // 常驻轮询 feed 的投影必须带上它们（planrun 那份清单的自述）
    for (const k of snapshotWritten) {
      expect(funcBody(planrunPy, "list_recent_runs")).toContain(k);
    }
  });

  it("降级路径有素材：夹具里既有带快照的行，也有一个字段都不带的老行", () => {
    const legacy = PLAN_RUNS.filter((r) => snapshotKeysOf(r).length === 0);
    expect(legacy.length).toBeGreaterThan(0);
  });
});

describe("③ set_agent_meta 回执：桩的键集 = 后端 yield 的键集", () => {
  it("回执键集逐字相等（键集从源码推，不抄名单）", async () => {
    const yieldBlock = /yield \{"event": "agent_meta_set"[^}]*\}/.exec(mainPy)?.[0] ?? "";
    expect(yieldBlock, "main.py 应有 agent_meta_set 的 yield").not.toBe("");
    expect(yieldBlock).toContain("**saved");   // saved = catalog.set_agent_meta 的返回
    const setBody = funcBody(catalogPy, "set_agent_meta");
    expect(setBody).toContain('(*AGENT_META_FIELDS, "updated_at")');
    const backendKeys = new Set([
      ...dictKeys(yieldBlock),           // event / agent_name
      ...metaFields, "updated_at",       // **saved
    ]);
    const [frame] = await callMock({
      action: "set_agent_meta", agent_name: "support-bot", version_label: "v9.9",
    });
    expect(frame.event).toBe("agent_meta_set");
    expect(Object.keys(frame).sort()).toEqual([...backendKeys].sort());
    // 关联键原样回来（护栏 2）
    expect(frame.agent_name).toBe("support-bot");
    // 桩把写入真的落在自己那张表上（dev 下改完名字列表要跟着变）
    const [agentsFrame] = await callMock({ action: "discover" });
    const row = (agentsFrame.agents as Record<string, unknown>[])
      .find((a) => a.agent_name === "support-bot");
    expect(row?.version_label).toBe("v9.9");
    // 复位，别把状态漏给同文件后面的用例
    await callMock({ action: "set_agent_meta", agent_name: "support-bot", version_label: "v1.3" });
  });

  it("空 agent_name / 两个字段都不传 → error 帧（与后端两条早退同刑）", async () => {
    const [noName] = await callMock({ action: "set_agent_meta", agent_name: " " });
    expect(noName.event).toBe("error");
    const [noField] = await callMock({ action: "set_agent_meta", agent_name: "support-bot" });
    expect(noField.event).toBe("error");
  });
});

describe("④ 反向防漂：Agent 侧字段与 run 快照字段不许互串", () => {
  it("run 行上没有 Agent 侧的键名（version_label / display_name）", () => {
    for (const run of PLAN_RUNS) {
      expect(run).not.toHaveProperty("version_label");
      expect(run).not.toHaveProperty("display_name");
      // runtime_arn 是 discovery 行的键；run 上那一半叫 agent_runtime_arn
      expect(run).not.toHaveProperty("runtime_arn");
    }
  });

  it("discover 行上没有 run 快照的键名", () => {
    for (const a of applyAgentMeta(AGENTS)) {
      expect(a).not.toHaveProperty("agent_version_label");
      expect(a).not.toHaveProperty("agent_runtime_arn");
    }
  });

  it("后端源码里也没有这些近义键（拼错就红）", () => {
    const backend = catalogPy + mainPy + planrunPy;
    for (const bogus of ['"agent_version"', '"version_snapshot"', '"agent_label"']) {
      expect(backend).not.toContain(bogus);
    }
  });
});
