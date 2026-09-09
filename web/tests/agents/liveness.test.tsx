// Agent 详情页 probe/autoconf 流式活性行测试（useLiveness 接入，#72）。
// waitFor 锚点纪律：agent-probe-status 同时挂中间态与终态（历史坑）——这里断言
// 的 agent-probe-liveness / autoconf-liveness 只在进行中态渲染，锚它不锚 status。
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sseFrames } from "../../src/mocks/handlers";
import AgentDetailPage from "../../src/pages/AgentDetailPage";
import { renderPage, setupAgentsPageHooks, stubFetch } from "./harness";

setupAgentsPageHooks();

afterEach(() => {
  vi.useRealTimers();
});

/** 只发指定帧、不 close 的挂起流（模拟探测/推断进行中） */
function hangingStream(events: unknown[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseFrames(events)));
        // 不 close：保持流式进行中
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

/** 排干微任务链：流帧经 reader.read() 微任务派发，与假时钟无关。
 *
 * 固定轮数（曾写死 3 轮）在满载下不够——reader.read() 的微任务链长度受调度影响，
 * 空载 3 轮就到、并发 19 个测试文件时可能要更多轮，于是 autoconf-progress-0
 * 偶发抓不到（约 3/15）。改成「排到条件成立为止」，有界防死循环。
 * 注意不能用 waitFor：本测试已切假时钟，条件依赖的是微任务而非时间推进。 */
async function flushStream(until?: () => boolean, maxTurns = 50) {
  for (let i = 0; i < maxTurns; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    if (until?.()) return;
  }
  if (until && !until()) {
    throw new Error(`flushStream: 条件在 ${maxTurns} 轮微任务后仍不成立`);
  }
}

/** 元素已出现即视为该帧已落地 */
const seen = (testId: string) => () => screen.queryByTestId(testId) !== null;

describe("探测/自动配置活性行（useLiveness）", () => {
  it("探测中渲染活性行（文案下方）；推进 11s 无事件 ok→waiting", async () => {
    stubFetch({
      probe_agent_invoke: () => hangingStream([{ event: "heartbeat", phase: "probe_agent_invoke" }]),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    await waitFor(() => expect(screen.getByTestId("agent-config-probe")).toBeEnabled());

    // 假时钟在发起前就位：startedAt / interval / Date.now 全走假钟，推进才确定
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId("agent-config-probe"));
    await flushStream(seen("agent-probe-liveness")); // heartbeat 帧刷 lastEventAt（不进 UI）

    // 「探测中…」文案仍在，活性行挂在同一容器内
    const status = screen.getByTestId("agent-probe-status");
    expect(status).toHaveTextContent("探测中…");
    const live = screen.getByTestId("agent-probe-liveness");
    expect(status.contains(live)).toBe(true);
    expect(live).toHaveClass("res-liveness", "ok");
    expect(live).toHaveTextContent("链路正常");

    // 推进 11s 无新事件：ok → waiting（计时同步走到 00:11）
    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    const after = screen.getByTestId("agent-probe-liveness");
    expect(after).toHaveClass("waiting");
    expect(after).not.toHaveClass("ok");
    expect(after).toHaveTextContent("等待响应…");
    expect(after).toHaveTextContent("已 00:11");
  });

  it("自动配置中渲染活性行（进度区下方，不打散进度）；推进 11s ok→waiting", async () => {
    stubFetch({
      auto_configure_agent: () =>
        hangingStream([
          { event: "heartbeat", phase: "auto_configure_agent" },
          { event: "autoconf_progress", agent_name: "support-bot",
            template: '{"prompt": "{input}"}', ok: false, error: "HTTP 400", latency_ms: 90 },
        ]),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    const btn = await screen.findByTestId("agent-autoconf-btn");
    await waitFor(() => expect(btn).toBeEnabled());

    vi.useFakeTimers();
    fireEvent.click(btn);
    await flushStream(seen("autoconf-progress-0")); // heartbeat + 一帧进度

    // 活性行在进度行之后（DOM 顺序），进度展示不被打散
    const row = screen.getByTestId("autoconf-progress-0");
    const live = screen.getByTestId("autoconf-liveness");
    expect(row.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(live).toHaveClass("res-liveness", "ok");
    expect(live).toHaveTextContent("链路正常");

    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    const after = screen.getByTestId("autoconf-liveness");
    expect(after).toHaveClass("waiting");
    expect(after).toHaveTextContent("等待响应…");
    // 进度行仍在：活性 tick 不清空已到的进度
    expect(screen.getByTestId("autoconf-progress-0")).toHaveTextContent('{"prompt": "{input}"}');
    expect(screen.getByTestId("agent-autoconf-btn")).toBeDisabled();
  });
});
