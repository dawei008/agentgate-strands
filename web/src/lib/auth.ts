// Cognito 授权码模式（无 client secret）。语义与旧版 ui/app.js 222-330 对齐：
// - 回调 URL 必须与池中注册值逐字节一致（无尾斜杠）→ location.origin
// - everAuthed 区分「从未登录」vs「登录过期」
// - onAuthExpired 幂等（authExpired 锁）、清 token、清全部服务端状态缓存
import { loadConfig } from "./config";
import { queryClient } from "./queryClient";
import { useSession } from "../stores/session";

const TOKEN_KEY = "access_token";
const REFRESH_KEY = "agentgate_refresh";
const SIGNED_OUT_KEY = "agentgate_signed_out";
const RETURN_HASH_KEY = "agentgate_return_hash";

function redirectUri(): string {
  return location.origin;
}

/**
 * 登出标记：AuthGate 未登录时会自动跳 Cognito（一步化登录）。
 * 若登出回跳后立即自动跳登录页就成了无限循环——logout 设此标记，
 * AuthGate 见标记则停在门面页（「已退出登录」），用户点登录时清标记再跳。
 */
export function wasSignedOut(): boolean {
  return sessionStorage.getItem(SIGNED_OUT_KEY) === "1";
}

export function clearSignedOut(): void {
  sessionStorage.removeItem(SIGNED_OUT_KEY);
}

/**
 * 深链跨登录往返的存续（「报告链接发给同事，打开落在首页」的根因修复）。
 *
 * OAuth 回跳地址必须与池中注册值逐字节一致（redirectUri() = 裸 origin），
 * hash 不在其中——**去 Cognito 的那一步 hash 就已经丢了**，不是回来后谁清掉的
 * （initAuth 里那句 replaceState 只是第二只脚）。所以出发前存一份，回来接上。
 *
 * 两个跳转点都要调（login() 与 AuthGate 的自动跳转——后者不走 login()）。
 * 存 sessionStorage：同标签页往返存活；新标签/转发链接不带（那是别人的会话，
 * 不该被上一个人的落点遥控）。只存有内容的路由——""、"#"、"#/" 都是默认页，
 * 存了也只是回到本来就会去的地方。
 */
export function stashReturnHash(): void {
  const h = location.hash ?? "";
  if (h.length > 2) sessionStorage.setItem(RETURN_HASH_KEY, h);
}

export async function loginUrl(): Promise<string> {
  const cfg = await loadConfig();
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: "openid email",
    redirect_uri: redirectUri(),
    lang: "zh-CN", // Cognito Managed Login 本地化：登录页显示中文
  });
  return `${cfg.cognitoDomain}/oauth2/authorize?${p}`;
}

export async function logoutUrl(): Promise<string> {
  const cfg = await loadConfig();
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    logout_uri: redirectUri(),
    lang: "zh-CN", // 同 authorize：登出确认页也走中文
  });
  return `${cfg.cognitoDomain}/logout?${p}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  [k: string]: unknown;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const cfg = await loadConfig();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    code,
    redirect_uri: redirectUri(),
  });
  const resp = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) throw new Error("token exchange failed");
  return resp.json() as Promise<TokenResponse>;
}

/**
 * refresh_token 静默续期（标准 OAuth2：同 token 端点，grant_type=refresh_token）。
 * 响应不含新 refresh_token——旧的继续用。非 2xx = 刷新失败（过期/吊销）。
 */
export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const cfg = await loadConfig();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: cfg.clientId,
    refresh_token: refreshToken,
  });
  const resp = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) throw new Error("token refresh failed");
  return resp.json() as Promise<TokenResponse>;
}

/**
 * ?code= 交换失败态（模块级，随页面生命周期）。
 * AuthGate 的自动跳转见此标记必须刹车：交换失败若还自动跳登录，
 * 坏 code → 失败 → 再跳 → 再失败，就是死循环。
 */
let exchangeFailed = false;

export function didExchangeFail(): boolean {
  return exchangeFailed;
}

/** 仅测试用：复位模块级状态（exchangeFailed / refreshing 单飞锁），与 resetConfigForTest 同模式 */
export function resetAuthForTest(): void {
  exchangeFailed = false;
  refreshing = false;
}

/**
 * 启动时调用（首帧渲染前）：URL ?code= → 换 token → 存 sessionStorage → 清 query，
 * 再从 sessionStorage 恢复登录态。新会话解除上一次的失效锁。
 *
 * 登录持久化：sessionStorage 无 access_token 但 localStorage 有 refresh_token 时，
 * 静默续期——成功直接进已登录态（用户全程不见登录门），失败清掉 refresh_token 走登录门。
 * initAuth 是 async 的，壳在其 resolve 前应显示「恢复会话中」中间态，不闪登录门。
 */
export async function initAuth(): Promise<void> {
  exchangeFailed = false; // 新一轮启动：复位上次的交换失败态
  const code = new URLSearchParams(location.search).get("code");
  if (code) {
    try {
      const t = await exchangeCode(code);
      sessionStorage.setItem(TOKEN_KEY, t.access_token);
      // 保持登录默认永远开启：refresh_token 一律落 localStorage
      if (t.refresh_token) {
        localStorage.setItem(REFRESH_KEY, t.refresh_token);
      }
    } catch (e) {
      exchangeFailed = true; // AuthGate 据此停在门面页，而不是自动重跳死循环
      console.error(e);
    }
    // 成败都清 ?code=（与旧版一致）：授权码是一次性的，失败后留着只会刷新时反复重试。
    // 交换**成功**时把出发前存下的深链 hash 接回来（stashReturnHash 的另一半）；
    // 这发生在首帧渲染前（main.tsx 先 await initAuth 再 render），路由首读就是它。
    // 失败不接也不清：用户在门面页点「登录」重试，那一次 stash 存不进东西
    // （门面页 URL 没有 hash），旧 stash 保留 → 重试成功后仍回得去。
    const back = exchangeFailed ? null : sessionStorage.getItem(RETURN_HASH_KEY);
    if (back) sessionStorage.removeItem(RETURN_HASH_KEY); // 一次性：接回即焚
    history.replaceState({}, "", back ? `/${back}` : "/");
  }
  // 静默续期：无会话 token 但有持久 refresh_token
  if (!sessionStorage.getItem(TOKEN_KEY)) {
    const rt = localStorage.getItem(REFRESH_KEY);
    if (rt) {
      try {
        const t = await refreshTokens(rt);
        sessionStorage.setItem(TOKEN_KEY, t.access_token);
      } catch {
        localStorage.removeItem(REFRESH_KEY); // 过期/吊销：清掉，正常显示登录门
      }
    }
  }
  const token = sessionStorage.getItem(TOKEN_KEY);
  const authed = Boolean(token);
  useSession.getState().setSession({
    token,
    authed,
    // 「过期」只对登录过的会话成立
    everAuthed: authed || useSession.getState().everAuthed,
    authExpired: false, // 新会话：解除上一次的失效锁
  });
}

/** 刷新单飞锁：并发 401 只触发一次静默刷新（复用 authExpired 锁思路） */
let refreshing = false;

/** 走既有过期流程：清 token / 登录态、清缓存、亮警告条 */
function expireNow(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  useSession.getState().setSession({ token: null, authed: false, authExpired: true });
  queryClient.clear();
}

/**
 * 认证失效唯一收口（幂等）。旧版语义：
 * - 并发 401 只处理一次
 * - 清 token / 登录态
 * - 清全部服务端状态缓存——留着会让界面拿旧数据编造事实 → queryClient.clear()
 * - authExpired=true 驱动全局警告条（AuthExpiredBanner，role=alert）
 *
 * 登录持久化：有 refresh_token 时先尝试**一次**静默刷新——
 * 成功 → 更新 token + 清 QueryClient 让在途查询重跑，不显示过期警告条；
 * 失败 → 清 refresh_token，走既有过期流程。
 */
export function onAuthExpired(): void {
  const s = useSession.getState();
  if (s.authExpired || refreshing) return;
  const rt = localStorage.getItem(REFRESH_KEY);
  if (!rt) {
    expireNow();
    return;
  }
  refreshing = true;
  void refreshTokens(rt)
    .then((t) => {
      sessionStorage.setItem(TOKEN_KEY, t.access_token);
      useSession.getState().setSession({
        token: t.access_token,
        authed: true,
        everAuthed: true,
        authExpired: false,
      });
      queryClient.clear(); // 在途查询作废（带旧 token 的 401 结果），用新 token 重跑
    })
    .catch(() => {
      localStorage.removeItem(REFRESH_KEY);
      expireNow();
    })
    .finally(() => {
      refreshing = false;
    });
}

/** 跳转 Cognito Hosted UI 登录（先清登出标记——用户主动登录，护栏解除）。
 *  出发前存深链 hash：过期警告条上的「重新登录」也走这里，修完 401 续期失败
 *  再登录，得回到刚才看的那一页而不是首页。 */
export async function login(): Promise<void> {
  clearSignedOut();
  stashReturnHash();
  location.assign(await loginUrl());
}

/**
 * 退出：清本地 token（sessionStorage + localStorage 两处）并跳 Cognito logout（回跳 origin）。
 * 设 signed_out 标记：回跳后 AuthGate 停在门面页，不自动重跳登录（防循环）。
 */
export async function logout(): Promise<void> {
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  // 深链存续也一并清：登出是会话边界，下一个登进来的人（可能换了账号）
  // 不该被上一段会话的落点遥控
  sessionStorage.removeItem(RETURN_HASH_KEY);
  sessionStorage.setItem(SIGNED_OUT_KEY, "1");
  location.assign(await logoutUrl());
}

/** 组件用的便捷 hook：读登录态 + 拿动作函数 */
export function useAuth() {
  const token = useSession((s) => s.token);
  const authed = useSession((s) => s.authed);
  const everAuthed = useSession((s) => s.everAuthed);
  const authExpired = useSession((s) => s.authExpired);
  return { token, authed, everAuthed, authExpired, login, logout };
}
