// mock 的 item-size 奇偶缺口（contract-audit H-6，P1 数据丢失 BH-005 的一半）。
//
// handlers.ts 复刻了 app/catalog.py save_dataset 的条数/必填/同名/形态四道校验，
// 唯独没有体积校验，于是「AI 生成 200 条红队用例 → 保存」在 mock 下全绿、在线上
// 被 DynamoDB 以 ValidationException: Item size has exceeded the maximum allowed
// size 拒。这里对账 mock 的拒绝形态（{event:"error"}，两个键）与文案模板
// （app/catalog.py 的 _oversize_message）。
import { describe, expect, it } from "vitest";
import { MOCK_ACCESS_TOKEN, MAX_DATASET_CASES } from "../src/mocks/handlers";

/** 走 mock handler 本身发一次请求，返回首帧事件对象（同 contract-guard.test.ts）。 */
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
      headers: {
        "Content-Type": "application/json",
        "x-authorization": `Bearer ${MOCK_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    }),
  });
  const text = await res.response!.text();
  return JSON.parse(text.split("\n\n").filter(Boolean)[0].replace(/^data: /, ""));
}

/** 红队生成器实际产出的形态：中文自由文本，字段一个都不截断
 *  （app/redteam.py:326-331）。与后端测试 tests/test_dataset_save_size.py 同夹具。 */
const FILLER = "该攻击话术围绕权限伪装展开，先建立可信身份，再要求越权操作。";
const text = (n: number) => FILLER.repeat(Math.ceil(n / FILLER.length)).slice(0, n);
const bigRedteamCases = (count = 200) =>
  Array.from({ length: count }, (_, i) => ({
    name: `guideline_bypass_${i}`, input: text(600), risk_category: "guideline_bypass",
    actor_goal: text(130), context: text(600), severity: "high",
    success_criteria: text(130), traits: {},
  }));

describe("mock save_dataset 的体积闸门（与 app/catalog.py 同刑）", () => {
  it("夹具过得了条数闸门，却超 400KB —— 否则这组测试什么也没证明", () => {
    const cases = bigRedteamCases();
    expect(cases.length).toBeLessThanOrEqual(MAX_DATASET_CASES);
    expect(new TextEncoder().encode(JSON.stringify(cases)).length).toBeGreaterThan(400 * 1024);
  });

  it("超限 → {event:'error'}，文案照后端 _oversize_message 模板", async () => {
    const frame = await callMock({ action: "save_dataset", name: "rt-big",
                                   cases: bigRedteamCases(), kind: "redteam" });
    expect(Object.keys(frame).sort()).toEqual(["error", "event"]);
    expect(frame.event).toBe("error");
    const msg = String(frame.error);
    expect(msg).toContain("数据集 'rt-big' 共 200 条用例、写入体积约 ");
    expect(msg).toContain("超过单条记录上限 400 KB（留出余量后可用 396 KB）。");
    expect(msg).toContain("请拆成多个数据集（每个不超过 ");
    expect(msg).toContain("或精简用例里的长文本（context / success_criteria 等）后重试。");
  });

  it("寻常体积的数据集照常保存（闸门不能变成新的事故）", async () => {
    const frame = await callMock({
      action: "save_dataset", name: "reg-small", kind: "regression",
      cases: [{ name: "c1", input: "问一句" }],
    });
    expect(frame).toEqual({ event: "dataset_saved", name: "reg-small" });
  });

  it("200 条短用例（条数顶格但体积不大）仍然放行：闸门量的是字节不是条数", async () => {
    const frame = await callMock({
      action: "save_dataset", name: "reg-200-short", kind: "regression",
      cases: Array.from({ length: 200 }, (_, i) => ({ name: `c${i}`, input: "问一句" })),
    });
    expect(frame).toEqual({ event: "dataset_saved", name: "reg-200-short" });
  });
});
