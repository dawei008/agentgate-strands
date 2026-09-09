import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeCode, onAuthExpired, initAuth, loginUrl, logoutUrl, logout,
  refreshTokens, stashReturnHash, wasSignedOut, resetAuthForTest,
} from "../src/lib/auth";
import AuthGate from "../src/components/layout/AuthGate";
import { resetConfigForTest } from "../src/lib/config";
import { queryClient } from "../src/lib/queryClient";
import { useSession } from "../src/stores/session";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "https://auth.example.com", clientId: "client-1" };

function mockFetch(tokenHandler: (input: RequestInfo | URL, init?: RequestInit) => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    return tokenHandler(input, init);
  });
}

beforeEach(() => {
  resetConfigForTest();
  resetAuthForTest();
  sessionStorage.clear();
  localStorage.removeItem("agentgate_refresh");
  history.replaceState({}, "", "/");
  useSession.setState({ token: null, authed: false, everAuthed: false, authExpired: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("exchangeCode", () => {
  it("成功路径：POST token 端点，表单参数齐全，返回 access_token", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal("fetch", mockFetch((input, init) => {
      captured = { url: String(input), init };
      return Response.json({ access_token: "at-1", token_type: "Bearer" });
    }));

    const t = await exchangeCode("code-abc");
    expect(t.access_token).toBe("at-1");
    expect(captured!.url).toBe("https://auth.example.com/oauth2/token");
    expect(captured!.init?.method).toBe("POST");
    const body = new URLSearchParams(String(captured!.init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("code")).toBe("code-abc");
    expect(body.get("redirect_uri")).toBe(location.origin);
  });

  it("失败路径：非 2xx 抛 token exchange failed", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response("bad", { status: 400 })));
    await expect(exchangeCode("bad-code")).rejects.toThrow("token exchange failed");
  });
});

describe("onAuthExpired", () => {
  it("幂等：并发 401 只收口一次（clear 只调一次）", () => {
    useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
    sessionStorage.setItem("access_token", "t");
    const clearSpy = vi.spyOn(queryClient, "clear");

    onAuthExpired();
    onAuthExpired();
    onAuthExpired();

    const s = useSession.getState();
    expect(s.authExpired).toBe(true);
    expect(s.token).toBeNull();
    expect(s.authed).toBe(false);
    expect(sessionStorage.getItem("access_token")).toBeNull();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

describe("initAuth", () => {
  it("从 sessionStorage 恢复登录态并解除失效锁", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response(null, { status: 404 })));
    sessionStorage.setItem("access_token", "restored");
    useSession.setState({ authExpired: true }); // 上一会话留下的锁

    await initAuth();
    const s = useSession.getState();
    expect(s.token).toBe("restored");
    expect(s.authed).toBe(true);
    expect(s.everAuthed).toBe(true);
    expect(s.authExpired).toBe(false);
  });
});

describe("loginUrl / logoutUrl", () => {
  it("授权码模式参数齐全，且带 lang=zh-CN（Cognito 页中文）", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response(null, { status: 404 })));
    const url = new URL(await loginUrl());
    expect(url.origin + url.pathname).toBe("https://auth.example.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("redirect_uri")).toBe(location.origin);
    expect(url.searchParams.get("lang")).toBe("zh-CN");
  });

  it("logout URL 同样带 lang=zh-CN", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response(null, { status: 404 })));
    const url = new URL(await logoutUrl());
    expect(url.origin + url.pathname).toBe("https://auth.example.com/logout");
    expect(url.searchParams.get("logout_uri")).toBe(location.origin);
    expect(url.searchParams.get("lang")).toBe("zh-CN");
  });
});

// ---------- 登录持久化（refresh_token 静默续期） ----------

/** token 端点 mock：authorization_code → at+rt；refresh_token=rt-ok → 新 at；其余 400 */
function grantAwareFetch(counters?: { refresh?: number; code?: number }) {
  return mockFetch((_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    if (body.get("grant_type") === "refresh_token") {
      if (counters) counters.refresh = (counters.refresh ?? 0) + 1;
      if (body.get("refresh_token") !== "rt-ok") return new Response("invalid_grant", { status: 400 });
      return Response.json({ access_token: "at-refreshed", id_token: "id-1", expires_in: 3600 });
    }
    if (counters) counters.code = (counters.code ?? 0) + 1;
    return Response.json({ access_token: "at-1", refresh_token: "rt-ok", token_type: "Bearer" });
  });
}

describe("initAuth：登录持久化（保持登录恒开启）", () => {
  it("?code= 交换后 refresh_token 恒落 localStorage（无 remember 开关）", async () => {
    vi.stubGlobal("fetch", grantAwareFetch());
    history.replaceState({}, "", "/?code=abc");

    await initAuth();
    expect(sessionStorage.getItem("access_token")).toBe("at-1");
    expect(localStorage.getItem("agentgate_refresh")).toBe("rt-ok");
    expect(useSession.getState().authed).toBe(true);
  });

  it("静默续期成功：无会话 token + 有 refresh_token → 直接进已登录态", async () => {
    const counters = { refresh: 0, code: 0 };
    vi.stubGlobal("fetch", grantAwareFetch(counters));
    localStorage.setItem("agentgate_refresh", "rt-ok");

    await initAuth();
    const s = useSession.getState();
    expect(counters.refresh).toBe(1);
    expect(counters.code).toBe(0);
    expect(s.authed).toBe(true);
    expect(s.token).toBe("at-refreshed");
    expect(s.authExpired).toBe(false);
    expect(sessionStorage.getItem("access_token")).toBe("at-refreshed");
    // 标准 OAuth2：响应不含新 refresh_token，旧的继续用
    expect(localStorage.getItem("agentgate_refresh")).toBe("rt-ok");
  });

  it("静默续期失败：清 refresh_token，正常显示登录门（未登录态）", async () => {
    vi.stubGlobal("fetch", grantAwareFetch());
    localStorage.setItem("agentgate_refresh", "rt-revoked");

    await initAuth();
    const s = useSession.getState();
    expect(s.authed).toBe(false);
    expect(s.everAuthed).toBe(false); // 门照常显示，不是「过期」文案
    expect(s.authExpired).toBe(false);
    expect(localStorage.getItem("agentgate_refresh")).toBeNull();
    expect(sessionStorage.getItem("access_token")).toBeNull();
  });
});

describe("onAuthExpired：401 单次静默刷新", () => {
  it("刷新成功：并发 401 只刷一次，更新 token + 清缓存，不亮过期警告条", async () => {
    const counters = { refresh: 0 };
    vi.stubGlobal("fetch", grantAwareFetch(counters));
    useSession.setState({ token: "old-at", authed: true, everAuthed: true, authExpired: false });
    sessionStorage.setItem("access_token", "old-at");
    localStorage.setItem("agentgate_refresh", "rt-ok");
    const clearSpy = vi.spyOn(queryClient, "clear");

    onAuthExpired();
    onAuthExpired();
    onAuthExpired();
    await vi.waitFor(() => expect(useSession.getState().token).toBe("at-refreshed"));

    const s = useSession.getState();
    expect(counters.refresh).toBe(1); // 幂等锁：并发只刷一次
    expect(s.authed).toBe(true);
    expect(s.authExpired).toBe(false); // 不显示过期警告条
    expect(sessionStorage.getItem("access_token")).toBe("at-refreshed");
    expect(clearSpy).toHaveBeenCalledTimes(1); // 在途查询作废重跑
  });

  it("刷新失败：清 refresh_token，走既有过期警告条流程", async () => {
    vi.stubGlobal("fetch", grantAwareFetch());
    useSession.setState({ token: "old-at", authed: true, everAuthed: true, authExpired: false });
    sessionStorage.setItem("access_token", "old-at");
    localStorage.setItem("agentgate_refresh", "rt-revoked");
    const clearSpy = vi.spyOn(queryClient, "clear");

    onAuthExpired();
    await vi.waitFor(() => expect(useSession.getState().authExpired).toBe(true));

    const s = useSession.getState();
    expect(s.token).toBeNull();
    expect(s.authed).toBe(false);
    expect(s.everAuthed).toBe(true); // 「过期」文案成立
    expect(localStorage.getItem("agentgate_refresh")).toBeNull();
    expect(sessionStorage.getItem("access_token")).toBeNull();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it("无 refresh_token：直接走原过期流程（同步幂等）", () => {
    useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
    sessionStorage.setItem("access_token", "t");

    onAuthExpired();
    expect(useSession.getState().authExpired).toBe(true);
    expect(sessionStorage.getItem("access_token")).toBeNull();
  });
});

describe("refreshTokens", () => {
  it("POST token 端点：grant_type=refresh_token 表单参数齐全", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal("fetch", mockFetch((input, init) => {
      captured = { url: String(input), init };
      return Response.json({ access_token: "at-2", id_token: "id-2", expires_in: 3600 });
    }));

    const t = await refreshTokens("rt-1");
    expect(t.access_token).toBe("at-2");
    expect(captured!.url).toBe("https://auth.example.com/oauth2/token");
    expect(captured!.init?.method).toBe("POST");
    const body = new URLSearchParams(String(captured!.init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("refresh_token")).toBe("rt-1");
  });

  it("非 2xx 抛 token refresh failed", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response("invalid_grant", { status: 400 })));
    await expect(refreshTokens("rt-x")).rejects.toThrow("token refresh failed");
  });
});

describe("logout", () => {
  it("清 sessionStorage + localStorage 两处 token，并设 signed_out 防循环标记", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response(null, { status: 404 })));
    // jsdom 不实现真实导航：换成可写的 location 桩，静音 not-implemented 报错
    const assign = vi.fn();
    vi.stubGlobal("location", { origin: location.origin, search: "", assign });
    sessionStorage.setItem("access_token", "at-1");
    localStorage.setItem("agentgate_refresh", "rt-ok");

    await logout();
    expect(sessionStorage.getItem("access_token")).toBeNull();
    expect(localStorage.getItem("agentgate_refresh")).toBeNull();
    expect(wasSignedOut()).toBe(true); // AuthGate 据此不自动回跳
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0][0])).toContain("/logout?");
  });
});

// ---------- 深链跨登录往返（stashReturnHash → Cognito → initAuth 接回） ----------
//
// 缺陷形态（用户实报「报告打不开」的一支）：把 #/report/<run_key> 发给未登录的
// 同事，AuthGate 自动跳 Cognito —— 回跳地址是裸 origin（池中注册值，hash 进不去），
// 于是登录成功后落在默认页，深链像「打不开」。修法 = 出发前存、交换成功后接回。

describe("深链跨登录往返", () => {
  const DEEP = "#/report/plan-x%2320260829T0200";

  it("出发前存 hash → 回跳（hash 已丢）→ 交换成功后接回，且 stash 一次性", async () => {
    vi.stubGlobal("fetch", mockFetch(() =>
      Response.json({ access_token: "at-1" })));
    history.replaceState({}, "", `/${DEEP}`); // 用户停在深链上
    stashReturnHash();                        // 跳 Cognito 前（两个跳转点都调它）
    history.replaceState({}, "", "/?code=abc"); // Cognito 回跳：hash 结构性缺席

    await initAuth();
    expect(location.hash).toBe(DEEP);           // 接回
    expect(location.search).toBe("");           // ?code= 照旧清掉
    expect(sessionStorage.getItem("agentgate_return_hash")).toBeNull(); // 接回即焚
    expect(useSession.getState().authed).toBe(true);
  });

  it("交换失败：不接回（仍落 '/'），stash 保留给门面页重试", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response("bad", { status: 400 })));
    history.replaceState({}, "", `/${DEEP}`);
    stashReturnHash();
    history.replaceState({}, "", "/?code=bad");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await initAuth();
    errSpy.mockRestore();
    expect(location.hash).toBe("");             // 失败不装成功
    expect(location.search).toBe("");
    expect(sessionStorage.getItem("agentgate_return_hash")).toBe(DEEP); // 留给重试
  });

  it("没有 stash：与旧行为逐字同（落 '/'）——老路径的阴性对照", async () => {
    vi.stubGlobal("fetch", mockFetch(() => Response.json({ access_token: "at-1" })));
    history.replaceState({}, "", "/?code=abc");
    await initAuth();
    expect(location.pathname + location.search + location.hash).toBe("/");
  });

  it("空/默认 hash 不入栈：''、'#'、'#/' 都是默认页，存了只会遮住真 stash", () => {
    for (const h of ["", "#", "#/"]) {
      history.replaceState({}, "", `/${h}`);
      stashReturnHash();
      expect(sessionStorage.getItem("agentgate_return_hash")).toBeNull();
    }
    history.replaceState({}, "", `/${DEEP}`);
    stashReturnHash(); // 阳性对照：同一个函数对真路由确实会存
    expect(sessionStorage.getItem("agentgate_return_hash")).toBe(DEEP);
  });

  it("logout 清 stash：登出是会话边界，下一个登录不被上一段会话的落点遥控", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response(null, { status: 404 })));
    sessionStorage.setItem("agentgate_return_hash", DEEP);
    const assign = vi.fn();
    vi.stubGlobal("location", { origin: "http://localhost:3000", assign, hash: "" });
    await logout();
    expect(sessionStorage.getItem("agentgate_return_hash")).toBeNull();
  });

  it("login() 出发前自动 stash（过期警告条「重新登录」走的就是它）", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response(null, { status: 404 })));
    const assign = vi.fn();
    vi.stubGlobal("location", {
      origin: "http://localhost:3000", assign, hash: DEEP, search: "",
    });
    const { login } = await import("../src/lib/auth");
    await login();
    expect(sessionStorage.getItem("agentgate_return_hash")).toBe(DEEP);
    expect(assign).toHaveBeenCalledTimes(1);
  });
});

// ---------- 登录门一步化（AuthGate 自动跳转 + 防循环护栏） ----------

describe("AuthGate：一步化自动跳转", () => {
  function stubLocation(search = "", hash = "") {
    const assign = vi.fn();
    vi.stubGlobal("location", { origin: "http://localhost:3000", search, assign, hash });
    return assign;
  }

  it("未登录：自动 location.assign 跳 Cognito，URL 带 lang=zh-CN", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response(null, { status: 404 })));
    const assign = stubLocation();

    render(<AuthGate />);
    // 跳转中显示安静过渡态，而不是登录按钮
    expect(screen.getByTestId("auth-redirecting")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-login")).not.toBeInTheDocument();

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const url = new URL(String(assign.mock.calls[0][0]));
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("lang")).toBe("zh-CN");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("自动跳转出发前 stash 深链（这条路不走 login()，得自己存）", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response(null, { status: 404 })));
    const assign = stubLocation("", "#/report/plan-x%2320260829T0200");

    render(<AuthGate />);
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    // stash 必须发生在 assign **之前**（跳走之后没有「之后」）——assign 已被调，
    // stash 在场即证明顺序成立（同一个 then 回调里 stash 排前）
    expect(sessionStorage.getItem("agentgate_return_hash"))
      .toBe("#/report/plan-x%2320260829T0200");
  });

  it("signed_out 标记：不自动跳，显示「已退出登录」门面页", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response(null, { status: 404 })));
    const assign = stubLocation();
    sessionStorage.setItem("agentgate_signed_out", "1");

    render(<AuthGate />);
    expect(screen.getByTestId("auth-gate")).toHaveTextContent("已退出登录");
    expect(screen.getByTestId("auth-login")).toHaveTextContent("重新登录");
    // 给潜在的异步跳转留一拍，确认确实没跳
    await new Promise((r) => setTimeout(r, 20));
    expect(assign).not.toHaveBeenCalled();
  });

  it("signed_out 门面：点登录按钮清标记并跳 Cognito", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response(null, { status: 404 })));
    const assign = stubLocation();
    sessionStorage.setItem("agentgate_signed_out", "1");

    render(<AuthGate />);
    screen.getByTestId("auth-login").click();
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(wasSignedOut()).toBe(false); // 用户主动登录，护栏解除
    expect(String(assign.mock.calls[0][0])).toContain("/oauth2/authorize");
  });

  it("?code= 交换流程中：不自动跳（跳走会作废授权码）", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response(null, { status: 404 })));
    const assign = stubLocation("?code=mock-auth-code");

    render(<AuthGate />);
    expect(screen.getByTestId("auth-login")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(assign).not.toHaveBeenCalled();
  });

  it("exchangeCode 失败：显示门面页而非死循环重跳", async () => {
    // 先让 initAuth 吃一个坏 code（token 端点 400）
    vi.stubGlobal("fetch", mockFetch(() => new Response("bad", { status: 400 })));
    history.replaceState({}, "", "/?code=bad-code");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await initAuth();
    errSpy.mockRestore();

    const assign = stubLocation();
    render(<AuthGate />);
    expect(screen.getByTestId("auth-gate")).toHaveTextContent("登录未完成，请重试");
    expect(screen.getByTestId("auth-login")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(assign).not.toHaveBeenCalled();
  });
});
