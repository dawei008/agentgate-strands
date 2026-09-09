// API 层：POST + SSE 流式解析。语义与旧版 ui/app.js callApi/apiOne 逐行对齐，
// 仅做 TS 化与 AbortSignal 支持，不改任何行为。
import { useMutation } from "@tanstack/react-query";
import { loadConfig } from "./config";
import { onAuthExpired } from "./auth";
import { useSession } from "../stores/session";

// ---------- 事件类型（骨架：页面波按 action 细化具体事件成员） ----------
export interface ApiErrorEvent {
  event: "error";
  error: string;
}
export type ApiEvent = ApiErrorEvent | ({ event: string } & Record<string, unknown>);

/** 请求体：action + 任意参数（与后端 app/main.py 的 payload 约定一致） */
export type ApiPayload = { action: string } & Record<string, unknown>;

export interface CallApiOptions {
  signal?: AbortSignal;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 调后端并逐事件回调。事件流为 SSE 帧（data: 行，空行分帧），
 * 单个事件可能跨 chunk 断开，也可能是「JSON 字符串包 JSON」的双重编码——两者都要兜。
 */
export async function callApi(
  payload: ApiPayload,
  onEvent: (ev: ApiEvent) => void,
  { signal }: CallApiOptions = {},
): Promise<void> {
  const cfg = await loadConfig();
  const { token, everAuthed } = useSession.getState();
  const body = JSON.stringify(payload);
  const resp = await fetch(cfg.apiPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // JWT 走自定义头：Authorization 被 CloudFront OAC 的 SigV4 占用
      "x-authorization": `Bearer ${token}`,
      // Lambda-OAC 对 POST 要求 body 哈希
      "x-amz-content-sha256": await sha256Hex(body),
    },
    body,
    signal,
  });
  if (resp.status === 401) {
    if (!everAuthed) throw new Error("请先登录");
    onAuthExpired();
    throw new Error("登录已过期，请重新登录");
  }
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
  if (!resp.body) throw new Error("API 响应无 body");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split(/\r?\n\r?\n/);
    buf = frames.pop()!;
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      let ev: unknown;
      try { ev = JSON.parse(data); } catch { continue; }
      // 双重编码兜底：后端偶发把事件序列化成 JSON 字符串再包一层
      if (typeof ev === "string") {
        try { ev = JSON.parse(ev); } catch { continue; }
      }
      onEvent(ev as ApiEvent);
    }
  }
}

/**
 * 框架层遗言帧的文案，非该形态返回 null。
 *
 * 后端异常穿出 entrypoint（app/main.py 的 invoke 是 async generator）时，
 * bedrock_agentcore 不发应用协议的 {event:"error"}，而是发
 *   {error: str(e), error_type: type(e).__name__, message: "An error occurred…"}
 * ——**没有 `event` 字段**（bedrock_agentcore/runtime/app.py:887-891）。
 * 不认这帧，apiOne 就只会抛「未收到 X」，把真因（如 DynamoDB 的
 * ValidationException: Item size has exceeded…）盖得一点不剩，用户与 ops 各看
 * 到一半。message 恒是那句英文模板，不带信息，故不呈现。
 */
function frameworkErrorText(ev: ApiEvent): string | null {
  const raw = ev as { event?: unknown; error?: unknown; error_type?: unknown };
  if (raw.event !== undefined || typeof raw.error !== "string") return null;
  const kind = typeof raw.error_type === "string" ? raw.error_type : "";
  return kind ? `后端异常 ${kind}：${raw.error}` : `后端异常：${raw.error}`;
}

/**
 * 单事件动作：等待 wantEvent 事件并返回；收到 error 事件立即抛。
 * 框架层遗言帧（无 event 字段）与 {event:"error"} 同刑——已经拿到目标事件也照抛，
 * 半途死掉的操作不能报成功。
 * T 为期望事件的形状（页面波细化 ApiEvent 后可直接收窄）。
 */
export async function apiOne<T extends ApiEvent = ApiEvent>(
  payload: ApiPayload,
  wantEvent: string,
  options: CallApiOptions = {},
): Promise<T> {
  let out: T | null = null;
  await callApi(payload, (ev) => {
    if (ev.event === "error") throw new Error((ev as ApiErrorEvent).error);
    const framework = frameworkErrorText(ev);
    if (framework) throw new Error(framework);
    if (ev.event === wantEvent) out = ev as T;
  }, options);
  if (!out) throw new Error(`未收到 ${wantEvent}`);
  return out;
}

/**
 * TanStack Query 封装示例（供页面波参照）：
 *
 *   const save = useApiOne<{ event: "dataset_saved"; name: string }>("dataset_saved");
 *   save.mutate({ action: "save_dataset", name, cases });
 *
 * 读操作建议直接 useQuery({ queryKey, queryFn: () => apiOne(...) })；
 * 认证过期时 QueryClient 会被整体 clear()（见 lib/auth.ts），无需逐查询失效。
 */
export function useApiOne<T extends ApiEvent = ApiEvent>(wantEvent: string) {
  return useMutation<T, Error, ApiPayload>({
    mutationFn: (payload) => apiOne<T>(payload, wantEvent),
  });
}
