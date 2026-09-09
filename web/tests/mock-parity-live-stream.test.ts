// mock 保真之二：**慢速流**（?mock=*-live 五档手验/截图通路）的字节与时序。
//
// 同族于 mock-parity.test.ts（那边管键集，这边管帧的形态与到达节奏）。存在理由
// 有两条，都不是可选的：
//   1. 这五档是「运行中」态唯一的手验/截图入口。帧字节（`data: <json>\n\n`，
//      与后端流式输出同构）、逐帧独立 enqueue（不合帧，否则掩盖前端分帧解析）、
//      **流不 close**（close 掉就手验不到运行中）—— 三条都只活在 mock 里，
//      没有别的测试碰过它们。simplify-r2 C5 把四份重复脚手架收敛成
//      handlers.timedSseResponse，这是那次重构的保护网（本测试**后**补，
//      故同时充当「行为保持」的事后核对）。
//   2. cancel 后的残留定时器修复（切页/卸载/测试 cleanup 关流后，旧实现的
//      setTimeout 仍对已关闭的 controller enqueue → 抛 Invalid state，并把整份
//      排期钉在内存里到最后一帧到期）—— 这条**只有**这里钉得住。
import { describe, expect, it, vi } from "vitest";
import { MOCK_ACCESS_TOKEN } from "../src/mocks/handlers";

async function liveStream(mode: string) {
  window.history.replaceState({}, "", `/?mock=${mode}`);
  const { handlers } = await import("../src/mocks/handlers");
  const h = handlers.find((x) =>
    String((x as { info?: { path?: unknown } }).info?.path ?? "").includes("/api/invoke"))!;
  const res = await (h as unknown as {
    run: (a: { request: Request }) => Promise<{ response?: Response }>;
  }).run({
    request: new Request("http://localhost/api/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 "x-authorization": `Bearer ${MOCK_ACCESS_TOKEN}` },
      body: JSON.stringify({ action: "run_plan", plan_id: "plan-aaa111" }),
    }),
  });
  return res.response!;
}

describe("慢速流（timedSseResponse）：字节同构 + 时序照排期 + 不 close", () => {
  it("redteam-live：帧按排期到达、流不 close、cancel 后不再 enqueue", async () => {
    vi.useFakeTimers();
    const res = await liveStream("redteam-live");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    // 第 0ms 帧
    await vi.advanceTimersByTimeAsync(0);
    const f0 = dec.decode((await reader.read()).value!);
    expect(f0).toMatch(/^data: \{"event":"plan_run_started"/);
    expect(f0.endsWith("\n\n")).toBe(true);
    // 300ms 帧
    await vi.advanceTimersByTimeAsync(300);
    expect(dec.decode((await reader.read()).value!)).toContain('"event":"stage_start"');
    // 600ms 首条 attack_turn
    await vi.advanceTimersByTimeAsync(300);
    expect(dec.decode((await reader.read()).value!)).toContain('"event":"attack_turn"');
    // cancel → 余下 9 秒排期不许再 fire（旧实现会抛 Invalid state）
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
  });

  it("流不 close：排期跑完仍挂着（没有终帧 —— 前端才会停在「运行中」态）", async () => {
    vi.useFakeTimers();
    const res = await liveStream("runplan-live");
    const reader = res.body!.getReader();
    // runplan-live 的排期共 10 帧（started / stage_start / observe_sessions /
    // 3 条会话事件 / stage_done / stage_start / 2 次 heartbeat），最后一帧 6000ms
    await vi.advanceTimersByTimeAsync(10_000);
    for (let i = 0; i < 10; i += 1) {
      expect((await reader.read()).done, `第 ${i + 1} 帧`).toBe(false);
    }
    // 第 11 次读**永远挂着**：既没有第 11 帧，也没有 close
    let settled = false;
    void reader.read().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();
    expect(settled, "流被 close 了 —— 「运行中」态就手验不到了").toBe(false);
    await reader.cancel();
    vi.useRealTimers();
  });

  it("observe-live / dataset-live / runplan-live 三档首帧同样在 0ms 到", async () => {
    for (const mode of ["observe-live", "dataset-live", "runplan-live"]) {
      vi.useFakeTimers();
      const res = await liveStream(mode);
      const reader = res.body!.getReader();
      await vi.advanceTimersByTimeAsync(0);
      const f = new TextDecoder().decode((await reader.read()).value!);
      expect(f, mode).toContain('"event":"plan_run_started"');
      await reader.cancel();
      expect(vi.getTimerCount(), mode).toBe(0);
      vi.useRealTimers();
    }
  });
});
