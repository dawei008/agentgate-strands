import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callApi, apiOne, sha256Hex, type ApiEvent } from "../src/lib/api";
import { resetConfigForTest } from "../src/lib/config";
import { queryClient } from "../src/lib/queryClient";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

/** 把若干文本 chunk 组装成流式 SSE Response */
function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** fetch mock：config.json 返回假 cfg，apiPath 交给 handler */
function mockFetch(apiHandler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    return apiHandler(input, init);
  });
}

function resetSession(patch: Partial<ReturnType<typeof useSession.getState>> = {}) {
  useSession.setState({ token: null, authed: false, everAuthed: false, authExpired: false, ...patch });
}

beforeEach(() => {
  resetConfigForTest();
  resetSession();
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("callApi SSE 解析", () => {
  it("跨 chunk 断帧仍完整解析（帧在 data 行中间被切开）", async () => {
    const frames = 'data: {"event":"one","x":1}\n\ndata: {"event":"two"' + ',"y":2}\n\n';
    // 故意在第二帧 JSON 中间切 chunk
    const cut = frames.indexOf('"two"') + 3;
    vi.stubGlobal("fetch", mockFetch(() => sseResponse([frames.slice(0, cut), frames.slice(cut)])));

    const events: ApiEvent[] = [];
    await callApi({ action: "t" }, (ev) => events.push(ev));
    expect(events).toEqual([
      { event: "one", x: 1 },
      { event: "two", y: 2 },
    ]);
  });

  it("双重 JSON 字符串编码兜底（事件被序列化成 JSON 字符串再包一层）", async () => {
    const inner = JSON.stringify({ event: "wrapped", ok: true });
    const frame = `data: ${JSON.stringify(inner)}\n\n`;
    vi.stubGlobal("fetch", mockFetch(() => sseResponse([frame])));

    const events: ApiEvent[] = [];
    await callApi({ action: "t" }, (ev) => events.push(ev));
    expect(events).toEqual([{ event: "wrapped", ok: true }]);
  });

  it("空 data、无效 JSON、非 data 行都被静默跳过", async () => {
    const body = 'data:\n\n' + 'data: not-json{\n\n' + ': comment\nretry: 100\n\n' + 'data: {"event":"ok"}\n\n';
    vi.stubGlobal("fetch", mockFetch(() => sseResponse([body])));

    const events: ApiEvent[] = [];
    await callApi({ action: "t" }, (ev) => events.push(ev));
    expect(events).toEqual([{ event: "ok" }]);
  });
});

describe("callApi 认证分支", () => {
  it("401 且从未登录 → 抛「请先登录」，不进过期态", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response("Unauthorized", { status: 401 })));
    resetSession({ everAuthed: false });

    await expect(callApi({ action: "t" }, () => {})).rejects.toThrow("请先登录");
    expect(useSession.getState().authExpired).toBe(false);
  });

  it("401 且登录过 → 过期收口（authExpired + 清缓存）并抛「登录已过期」", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response("Unauthorized", { status: 401 })));
    resetSession({ everAuthed: true, authed: true, token: "old" });
    const clearSpy = vi.spyOn(queryClient, "clear");

    await expect(callApi({ action: "t" }, () => {})).rejects.toThrow("登录已过期，请重新登录");
    const s = useSession.getState();
    expect(s.authExpired).toBe(true);
    expect(s.token).toBeNull();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

describe("callApi 请求头", () => {
  it("带 x-amz-content-sha256（= body 的 SHA256）与 x-authorization", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", mockFetch((_input, init) => {
      captured = init;
      return sseResponse(['data: {"event":"done"}\n\n']);
    }));
    resetSession({ token: "tok-123", authed: true, everAuthed: true });

    await callApi({ action: "t" }, () => {});
    const headers = captured!.headers as Record<string, string>;
    expect(headers["x-authorization"]).toBe("Bearer tok-123");
    expect(headers["x-amz-content-sha256"])
      .toBe(await sha256Hex(JSON.stringify({ action: "t" })));
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("apiOne", () => {
  it("返回目标事件；error 事件立即抛", async () => {
    vi.stubGlobal("fetch", mockFetch(() =>
      sseResponse(['data: {"event":"noise"}\n\n', 'data: {"event":"want","v":7}\n\n'])));
    const out = await apiOne<{ event: "want"; v: number }>({ action: "t" }, "want");
    expect(out.v).toBe(7);

    vi.stubGlobal("fetch", mockFetch(() => sseResponse(['data: {"event":"error","error":"炸了"}\n\n'])));
    await expect(apiOne({ action: "t" }, "want")).rejects.toThrow("炸了");
  });

  it("流结束仍未见目标事件 → 抛「未收到 <event>」", async () => {
    vi.stubGlobal("fetch", mockFetch(() => sseResponse(['data: {"event":"other"}\n\n'])));
    await expect(apiOne({ action: "t" }, "want")).rejects.toThrow("未收到 want");
  });
});
