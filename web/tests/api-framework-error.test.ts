// 后端异常穿出 entrypoint 时，apiOne 必须说出真因（P1 数据丢失，BH-005）。
//
// 后端异常穿出 async generator（app/main.py 的 invoke）时，bedrock_agentcore
// 发的最后一帧是 {error, error_type, message}——**没有 `event` 字段**
// （bedrock_agentcore/runtime/app.py:887-891）。apiOne 只认 ev.event，于是这帧
// 被静默丢掉，流结束时抛「未收到 dataset_saved」，把真因（DynamoDB 的 400KB
// 超限）盖得一点不剩：用户看到一句没有信息量的话，真因只留在 CloudWatch。
// 这是通用缺口——任何后端异常穿出 entrypoint 的动作都走到这里。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { apiOne } from "../src/lib/api";
import { resetConfigForTest } from "../src/lib/config";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

/** 框架层遗言帧的真实形态（runtime/app.py:887-891）：error=str(e)、
 *  error_type=type(e).__name__、message 恒为那句英文，无 event。这里的 error
 *  文本就是 moto/线上 DynamoDB 拒绝超限 item 时的原话。 */
const DDB_REJECT =
  "An error occurred (ValidationException) when calling the PutItem operation: " +
  "Item size has exceeded the maximum allowed size";
const FRAMEWORK_FRAME = {
  error: DDB_REJECT,
  error_type: "ClientError",
  message: "An error occurred during streaming",
};

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

function mockFetch(frames: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("config.json")) return Response.json(CFG);
    return sseResponse(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`));
  });
}

beforeEach(() => {
  resetConfigForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("apiOne 呈现框架层遗言帧", () => {
  it("无 event 的 {error, error_type, message} → 抛真因，不抛「未收到」", async () => {
    vi.stubGlobal("fetch", mockFetch([FRAMEWORK_FRAME]));
    const err = await apiOne({ action: "save_dataset" }, "dataset_saved").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("ValidationException");
    expect((err as Error).message).toContain("ClientError");
    expect((err as Error).message).not.toContain("未收到");
  });

  it("遗言帧缺 error_type 时也照样说出 error 原文", async () => {
    vi.stubGlobal("fetch", mockFetch([{ error: "boom", message: "x" }]));
    await expect(apiOne({ action: "t" }, "want")).rejects.toThrow("boom");
  });

  it("已收到目标事件后再来遗言帧 → 仍然抛（与 {event:'error'} 同刑，不报假成功）", async () => {
    vi.stubGlobal("fetch", mockFetch([{ event: "want", v: 1 }, FRAMEWORK_FRAME]));
    await expect(apiOne({ action: "t" }, "want")).rejects.toThrow("ValidationException");
  });

  it("无 event 但不是错误帧（error 不是字符串）仍被忽略 → 保留「未收到」语义", async () => {
    vi.stubGlobal("fetch", mockFetch([{ foo: 1 }, { error: 42 }]));
    await expect(apiOne({ action: "t" }, "want")).rejects.toThrow("未收到 want");
  });

  it("正常流不受影响：目标事件照常返回", async () => {
    vi.stubGlobal("fetch", mockFetch([{ event: "noise" }, { event: "want", v: 7 }]));
    const out = await apiOne<{ event: "want"; v: number }>({ action: "t" }, "want");
    expect(out.v).toBe(7);
  });
});
