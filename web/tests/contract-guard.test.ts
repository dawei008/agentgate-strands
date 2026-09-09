// 后端契约键集护栏（机制性防第四次）。
//
// 前情：红队的「虚构键名」事故发生过三次，都是同一形态——mock 里写了后端不存在
// 的策略名/风险类别，前端在 mock 下点得通、线上 `raise ValueError(unknown …)`
// 点不通，而单测全绿（因为测试和 mock 共用同一份假数据）。
// 靠 code review 记住五个键名不可靠；这里改用机制：
//
//   scripts/export-contract-fixtures.py  ——从**真 SDK**导出权威键集
//        ↓ checked-in
//   tests/fixtures/backend-contract.json
//        ↓ 本测试对账
//   src/mocks/handlers.ts 的 mock 键 ⊆ fixture 键
//
// 与 glass-guard.test.ts 同一思路（把纪律钉进 CI，而不是写在文档里）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REDTEAM_SEVERITY, DATASETS, sseFrames, MOCK_ACCESS_TOKEN } from "../src/mocks/handlers";

const REGEN = "python3 scripts/export-contract-fixtures.py";

const contract = JSON.parse(
  readFileSync(resolve(process.cwd(), "tests/fixtures/backend-contract.json"), "utf8"),
) as {
  risk_categories: string[];
  risk_category_severity: Record<string, string>;
  severity_values: string[];
  strategies: string[];
  strategy_turns: Record<string, number>;
  strategy_snapshot_safe: Record<string, boolean>;
  breach_threshold: number;
  default_strategies: string[];
  default_risk_categories: string[];
};

/** 走 mock handler 本身发一次请求，返回首帧事件对象。
 *  刻意不复制常量——复制就会再次漂移，这正是要防的事。 */
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
      // handler 校验的是 x-authorization（与前端 lib/api.ts 同头）
      headers: {
        "Content-Type": "application/json",
        "x-authorization": `Bearer ${MOCK_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    }),
  });
  const text = await res.response!.text();
  const frame = text.split("\n\n").filter(Boolean)[0].replace(/^data: /, "");
  return JSON.parse(frame);
}

async function redteamOptions(): Promise<{
  strategies: { name: string; turns: number; snapshot_safe: boolean }[];
  default_strategies: string[];
  risk_categories: Record<string, { description: string; severity: string }>;
  default_risk_categories: string[];
  breach_threshold: number;
}> {
  return await callMock({ action: "redteam_options" }) as never;
}

const okCase = (i: number) => ({ name: `c${i}`, input: `问题 ${i}` });

describe("契约护栏：红队键集 mock ⊆ 后端真实键集", () => {
  it(`fixture 自身完整（缺字段说明导出脚本没跑完 —— 重跑：${REGEN}）`, () => {
    expect(contract.risk_categories.length, `risk_categories 不该为空，重跑：${REGEN}`)
      .toBeGreaterThan(0);
    expect(contract.strategies.length, `strategies 不该为空，重跑：${REGEN}`)
      .toBeGreaterThan(0);
    expect(typeof contract.breach_threshold).toBe("number");
  });

  it(`mock 的 risk_categories 键 ⊆ 后端真实键集（虚构类别线上会 400 —— 重跑：${REGEN}）`, async () => {
    const opts = await redteamOptions();
    const mockKeys = Object.keys(opts.risk_categories).sort();
    const extra = mockKeys.filter((k) => !contract.risk_categories.includes(k));
    expect(extra, [
      `mock 里这些风险类别在后端不存在：${extra.join(", ")}。`,
      "后端 generate_cases 会 raise ValueError(unknown risk categories: …)，",
      `线上点不通。若后端确实新增了类别，重跑：${REGEN}`,
    ].join("")).toEqual([]);
  });

  it(`mock 的 severity 值 ⊆ 真 SDK DEFAULT_SEVERITY 值域 —— 重跑：${REGEN}`, async () => {
    const opts = await redteamOptions();
    for (const [cat, spec] of Object.entries(opts.risk_categories)) {
      expect(contract.severity_values, `类别 ${cat} 的 severity "${spec.severity}" 不在真值域`)
        .toContain(spec.severity);
      // 更严：每个类别的 severity 必须与后端逐个对上，不只是值域合法
      expect(spec.severity, `类别 ${cat} 的 severity 与后端不一致，重跑：${REGEN}`)
        .toBe(contract.risk_category_severity[cat]);
    }
  });

  it(`REDTEAM_SEVERITY 常量与后端逐键一致 —— 重跑：${REGEN}`, () => {
    expect(Object.keys(REDTEAM_SEVERITY).sort()).toEqual(contract.risk_categories);
    expect(REDTEAM_SEVERITY).toEqual(contract.risk_category_severity);
  });

  it(`mock 的 strategies 名 ⊆ 后端真实策略名，且 turns/snapshot_safe 一致 —— 重跑：${REGEN}`, async () => {
    const opts = await redteamOptions();
    const names = opts.strategies.map((s) => s.name);
    const extra = names.filter((n) => !contract.strategies.includes(n));
    expect(extra, `mock 里这些策略名后端不存在：${extra.join(", ")}，重跑：${REGEN}`).toEqual([]);
    for (const s of opts.strategies) {
      expect(s.turns, `策略 ${s.name} 的 turns 与后端不一致`).toBe(contract.strategy_turns[s.name]);
      expect(s.snapshot_safe, `策略 ${s.name} 的 snapshot_safe 与后端不一致`)
        .toBe(contract.strategy_snapshot_safe[s.name]);
    }
  });

  it("mock 覆盖全量策略菜单，且含唯一 snapshot_safe:false 的样本（crescendo）", async () => {
    const opts = await redteamOptions();
    // 缺项会让「该策略的提示/警告 UI」永远测不到
    expect(opts.strategies.map((s) => s.name).sort()).toEqual([...contract.strategies].sort());
    const unsafe = opts.strategies.filter((s) => !s.snapshot_safe);
    expect(unsafe.length, "至少要有一个 snapshot_safe:false 样本").toBeGreaterThan(0);
  });

  it(`breach_threshold 与后端一致（真值 ${0.3}，mock 曾写 0.5）—— 重跑：${REGEN}`, async () => {
    const opts = await redteamOptions();
    expect(opts.breach_threshold).toBe(contract.breach_threshold);
  });

  it(`默认名单与后端一致 —— 重跑：${REGEN}`, async () => {
    const opts = await redteamOptions();
    expect(opts.default_strategies).toEqual(contract.default_strategies);
    expect(opts.default_risk_categories).toEqual(contract.default_risk_categories);
  });

  it(`假数据集的 risk_categories 也必须用真键（会渲染成 badge）—— 重跑：${REGEN}`, () => {
    const bad: string[] = [];
    for (const ds of DATASETS) {
      for (const c of ds.risk_categories ?? []) {
        if (!contract.risk_categories.includes(c)) bad.push(`${ds.name}: ${c}`);
      }
    }
    expect(bad, `假数据集里的虚构风险类别：${bad.join("; ")}`).toEqual([]);
  });

  it("sseFrames 编码与后端 SSE 分帧同构（护栏自身依赖它解析）", () => {
    expect(sseFrames([{ a: 1 }])).toBe('data: {"a":1}\n\n');
  });

  // H-7：同一个 action 在两个页面用了两个键名，工作台侧（cost_usd）是错的。
  it("list_recent_runs 成本键是 total_cost_usd（后端 _run_from_item），不是 cost_usd", async () => {
    const ev = await callMock({ action: "list_recent_runs" });
    const runs = ev.runs as Record<string, unknown>[];
    expect(runs.length).toBeGreaterThan(0);
    const withCost = runs.filter((r) => r.total_cost_usd != null);
    expect(withCost.length, "至少一条 run 要带成本").toBeGreaterThan(0);
    for (const r of runs) {
      expect(r, `run ${r.run_key} 不该有 cost_usd 键`).not.toHaveProperty("cost_usd");
    }
  });

  it("prices.last_sync 是对象 {at, updated_models}，不是标量（否则渲染成 [object Object]）", async () => {
    const ev = await callMock({ action: "prices" });
    expect(typeof ev.last_sync).toBe("object");
    const ls = ev.last_sync as { at?: number; updated_models?: number };
    expect(typeof ls.at).toBe("number");
    expect(typeof ls.updated_models).toBe("number");
  });

  it("refresh_prices.updated_models 是 int（后端真形态），不是数组", async () => {
    const ev = await callMock({ action: "refresh_prices" });
    expect(typeof ev.updated_models).toBe("number");
  });
});

// ==================== save_dataset 写侧校验同刑（H-6） ====================
//
// 后端 catalog.save_dataset 有三道 raise，mock 此前一律放行 → 最容易在线上
// 炸、在本地全绿的路径：
//   - GenCasesForm 追加保存发 [...existingCases, ...parsedCases]，
//     原集 180 + 生成 30 = 210 条 → 真后端 400、mock 成功
//   - SIM_CASE_TEMPLATE 的 input 默认是 ""，用户不填直接保存 → 同上
// 文案逐字照抄后端（前端只透传 message，文案不同会掩盖真实错因）。
describe("契约护栏：save_dataset mock 与后端同刑", () => {
  it("kind 白名单：非法 kind → 与后端同文案的 error", async () => {
    const ev = await callMock({
      action: "save_dataset", name: "x-kind", kind: "sim", cases: [okCase(1)],
    });
    expect(ev.event).toBe("error");
    expect(ev.error).toBe("kind 必须是 regression/redteam/simulation 之一，收到 'sim'");
  });

  it("三个合法 kind 都放行（simulation 需带 task_description——ADR-0009 纯度校验）", async () => {
    // 合流 dsgen-fix2（merge dd7cb8f）后，save_dataset 还有一道**形态纯度校验**：
    // kind=simulation 的每条用例必须有非空 task_description（app/catalog.py:183-187，
    // mock handlers.ts 同刑）。所以「合法 kind 放行」必须给该 kind 的合法载荷，
    // 否则它会被纯度校验拦下——那不是 kind 白名单坏了，是这条断言的载荷不合法。
    const payloadFor = (kind: string) =>
      kind === "simulation"
        ? [{ ...okCase(1), task_description: "完成一次订单查询", max_turns: 5 }]
        : [okCase(1)];
    for (const kind of ["regression", "redteam", "simulation"]) {
      const ev = await callMock({
        action: "save_dataset", name: `ok-${kind}`, kind, cases: payloadFor(kind),
      });
      expect(ev.event, `kind=${kind} 应放行`).toBe("dataset_saved");
    }
  });

  it("超 200 条 → dataset too large（追加保存最容易撞的上限）", async () => {
    const cases = Array.from({ length: 210 }, (_, i) => okCase(i));
    const ev = await callMock({ action: "save_dataset", name: "x-big", cases });
    expect(ev.event).toBe("error");
    expect(ev.error).toBe("dataset too large: 210 > 200 cases");
  });

  it("正好 200 条 → 放行（边界不误伤）", async () => {
    const cases = Array.from({ length: 200 }, (_, i) => okCase(i));
    const ev = await callMock({ action: "save_dataset", name: "ok-200", cases });
    expect(ev.event).toBe("dataset_saved");
  });

  it("某条 input 空白 → case[i] missing 'input'（带正确下标）", async () => {
    const ev = await callMock({
      action: "save_dataset", name: "x-blank",
      // SIM_CASE_TEMPLATE 的 input 默认就是 ""
      cases: [okCase(0), okCase(1), { name: "c2", input: "   " }],
    });
    expect(ev.event).toBe("error");
    expect(ev.error).toBe("case[2] missing 'input'");
  });

  // ---- ds-backend-guard 的两道校验（app/catalog.py:212-215 / 232-237）----
  // 后端有 pytest 覆盖，但 mock 侧此前零覆盖：mock 与后端脱刑正是「单测绿而
  // 线上崩」的老病根（红队策略对象数组白屏 9acb634），故在此对刑。
  it("空 cases 数组 → 与后端同文案的 error（写入前置拦截，UI-005）", async () => {
    const ev = await callMock({ action: "save_dataset", name: "x-empty", cases: [] });
    expect(ev.event).toBe("error");
    expect(ev.error).toBe("数据集至少需要一条用例");
  });

  it("create_only + 同名已存在 → 拒绝覆盖（UI-003）", async () => {
    // faq-regression-v3 是 mock 里预置的既有集合
    const ev = await callMock({
      action: "save_dataset", name: "faq-regression-v3",
      cases: [okCase(1)], create_only: true,
    });
    expect(ev.event).toBe("error");
    expect(ev.error).toBe("数据集 'faq-regression-v3' 已存在——请更换名称，或在列表中打开原集合编辑");
  });

  it("不带 create_only → 同名仍 upsert 成功（既有编辑/AI 追加链路零回归）", async () => {
    const ev = await callMock({
      action: "save_dataset", name: "faq-regression-v3", cases: [okCase(1)],
    });
    expect(ev.event).toBe("dataset_saved");
  });

  it("create_only + 新名字 → 正常放行（不误伤新建）", async () => {
    const ev = await callMock({
      action: "save_dataset", name: `fresh-${Date.now()}`,
      cases: [okCase(1)], create_only: true,
    });
    expect(ev.event).toBe("dataset_saved");
  });

  it("upload_case_image：返 case_image_uploaded + image_key（此前 mock 完全空白）", async () => {
    // 1KB 的假 base64
    const ev = await callMock({
      action: "upload_case_image", name: "shot.png",
      content_base64: "A".repeat(1400),
    });
    expect(ev.event).toBe("case_image_uploaded");
    expect(ev.name).toBe("shot.png");
    expect(String(ev.image_key)).toMatch(/^sources\/\d{8}-\d{6}\/images\/shot\.png$/);
    expect(typeof ev.bytes).toBe("number");
  });

  it("upload_case_image：格式白名单与后端同刑（SDK ImageData 只认四种）", async () => {
    const ev = await callMock({
      action: "upload_case_image", name: "doc.bmp", content_base64: "A".repeat(1400),
    });
    expect(ev.event).toBe("error");
    expect(ev.error).toBe("不支持的图片格式 'bmp'：仅支持 jpg/jpeg/png/gif/webp");
    // jpg 会被规范化成 jpeg（后端同逻辑）
    const ok = await callMock({
      action: "upload_case_image", name: "photo.jpg", content_base64: "A".repeat(1400),
    });
    expect(ok.event).toBe("case_image_uploaded");
  });

  it("upload_case_image：空内容 → 与后端同文案的大小错误", async () => {
    const ev = await callMock({
      action: "upload_case_image", name: "empty.png", content_base64: "",
    });
    expect(ev.event).toBe("error");
    expect(String(ev.error)).toContain("字节无效（须 >0 且 ≤5MB）");
  });

  it("缺 name 的用例：后端会补 case-{i+1}，mock 同样补（否则两边用例名不同）", async () => {
    const ev = await callMock({
      action: "save_dataset", name: "ok-autoname",
      cases: [{ input: "第一问" }, { input: "第二问" }],
    });
    expect(ev.event).toBe("dataset_saved");
    const list = await callMock({ action: "list_datasets" });
    const ds = (list.datasets as { name: string; cases: { name?: string }[] }[])
      .find((d) => d.name === "ok-autoname");
    expect(ds?.cases.map((c) => c.name)).toEqual(["case-1", "case-2"]);
  });
});
