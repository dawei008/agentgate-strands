// 运行时配置：与旧版一致，从站点根部的 config.json 读取（部署时由 infra 写入）。
// dev 模式下由 MSW 提供假 cfg（见 src/mocks/handlers.ts）。
export interface AppConfig {
  /** API 入口（CloudFront 反代到 Lambda Function URL），如 "/api/invoke" */
  apiPath: string;
  /** Cognito Hosted UI 域名（含协议，无尾斜杠） */
  cognitoDomain: string;
  /** Cognito App Client ID（授权码模式，无 client secret） */
  clientId: string;
  /** 部署区域（顶栏环境 chip `prod · <region>`）。今天 infra 写的 config.json 还没有
   *  这个键 ⇒ 可选；缺席时顶栏退到 discover 响应里的 region（见 TopNav.useRegion）。 */
  region?: string;
}

let cached: AppConfig | null = null;
let inflight: Promise<AppConfig> | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cached) return cached;
  // 并发调用只发一次请求
  inflight ??= (async () => {
    const resp = await fetch("./config.json");
    if (!resp.ok) throw new Error(`config.json ${resp.status}`);
    cached = (await resp.json()) as AppConfig;
    return cached;
  })();
  return inflight;
}

/** 仅供测试重置模块级缓存 */
export function resetConfigForTest(): void {
  cached = null;
  inflight = null;
}
