// 版本漂移提示（批 version-drift，2026-09-08 热修）。
//
// 现场：用户报「发布的拓扑没有了」。真因是他的标签页顶栏版本串是
// `v0.36.0 · 2026.09.07-1` —— 一天前打开、之后没刷新过的旧标签页（拓扑在 v0.39.0
// 才有，现网已是 v0.40.1 · 2026.09.08-2）。API 调用照旧走通（页面上的红队 32/32 是
// 当天的数据），所以旧标签页看起来完全正常，只是界面老。lib/version.ts 原来明写
// 「进程内只拉一次：版本号不需要轮询（发布后用户刷新页面即更新）」—— 这个假设让
// 界面永远不会告诉用户「你该刷新了」。
//
// 本文件钉五件事：
//   1) 漂移判定三态：构建号不同 ⇒ 漂移；相同 ⇒ 不漂移；任一侧读不出 ⇒ 不漂移（不伪造）；
//   2) 顶栏三态：漂移出 chip 且**两个构建号都说得出**（新的在版面、旧的在 title）；
//      不漂移 / 身份文件拉不到 ⇒ 零节点（顶栏零漂，不留空盒）；
//   3) 隐藏页不轮询，回到前台立刻补拉一次（久开的标签页真正的落点）；
//   4) 点击 chip 调 location.reload()；
//   5) 假时钟前进 5 分钟再拉一次 —— 且这一拉能把 chip 从「没有」变成「有」
//      （初次拉到的身份文件与本地同版，是**轮询**发现了新版本，正是现场那条路）。
//
// 手法：fetch 全部换成微任务级的假响应（真 Response 的 body 流会跟假时钟抢拍），
// 计数只数 version.json；假时钟一律 advanceTimersByTimeAsync + act，不用真 setTimeout 等。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import TopNav from "../src/components/layout/TopNav";
import { parseHash } from "../src/router";
import {
  VERSION_POLL_MS,
  resetVersionInfoForTest,
  setUiBuildForTest,
  versionDrift,
  type UiBuild,
  type VersionInfo,
} from "../src/lib/version";

/** 页面在跑的这堆字节（= 用户那个旧标签页） */
const UI: UiBuild = { version: "0.36.0", build: "2026.09.07-1" };
/** 现网身份文件（= 今天第二次发布） */
const LIVE: VersionInfo = {
  version: "0.40.1",
  build: "2026.09.08-2",
  commit: "d6162bc",
  built_at: "2026-09-08T06:00:00.000Z",
  ui_build: "2026.09.08-2",
  runtime_version: "rt-11",
};
/** 与本地同版的身份文件（刚发完那一刻的正常态） */
const SAME: VersionInfo = { ...LIVE, version: UI.version, build: UI.build, ui_build: UI.build };

/** 微任务级假响应：真 Response.json() 的 body 流会在假时钟下多占一拍 */
const res = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

// ---------- 1) 判定 ----------
describe("versionDrift()：构建号不同才算漂移，读不出就不算", () => {
  it("运行时构建号 ≠ 编译期构建号 → 漂移，from = 旧、to = 新", () => {
    expect(versionDrift(LIVE, UI)).toEqual({ from: "2026.09.07-1", to: "2026.09.08-2" });
  });

  it("构建号相同 → 不漂移（刚刷新过的标签页不该被打扰）", () => {
    expect(versionDrift(SAME, UI)).toBeNull();
  });

  it("身份文件拉不到（null）→ 不漂移（降级不伪造，不拿缺失当「有新版本」）", () => {
    expect(versionDrift(null, UI)).toBeNull();
  });

  it("身份文件形状不符（build 空串）→ 不漂移", () => {
    expect(versionDrift({ ...LIVE, build: "  " }, UI)).toBeNull();
  });

  it("编译期身份没注入（dev / 单测）→ 不漂移：没有「旧」可比", () => {
    expect(versionDrift(LIVE, { version: "", build: "" })).toBeNull();
    expect(versionDrift(LIVE)).toBeNull(); // 默认 ui = 单测未注入的 UI_BUILD
  });

  it("semver 变了但构建号没变 → 不漂移（判据只认构建号，它才是那堆字节的号）", () => {
    expect(versionDrift({ ...LIVE, build: UI.build }, UI)).toBeNull();
  });
});

// ---------- 顶栏 ----------
describe("顶栏版本漂移 chip", () => {
  /** 只数 version.json 的请求（config.json 也走同一个 fetch stub） */
  let versionHits = 0;

  const stubFetch = (body: (hit: number) => unknown, status = 200) => {
    versionHits = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.includes("version.json")) return res({}, 404);
        versionHits += 1;
        return res(body(versionHits), status);
      }),
    );
  };

  const setVisibility = (state: "visible" | "hidden") =>
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });

  function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(TopNav, { route: parseHash("#/workbench"), onOpenSettings: () => {} }),
      ),
    );
  }

  /** 冲干净挂载那一拍的 promise（假时钟下只有微任务，不需要推进时间） */
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

  beforeEach(() => {
    resetVersionInfoForTest();
    setUiBuildForTest(UI);
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setUiBuildForTest(null);
    resetVersionInfoForTest();
    Reflect.deleteProperty(document, "visibilityState"); // 还原原型上的 getter
  });

  it("构建号不同 → 出 chip，新构建号在版面、旧构建号在 title（两个都说得出）", async () => {
    stubFetch(() => LIVE);
    mount();
    await flush();
    const chip = screen.getByTestId("version-drift");
    expect(chip).toHaveTextContent("有新版本 2026.09.08-2 · 点此刷新");
    expect(chip.getAttribute("title")).toBe("当前页面是 2026.09.07-1，点击重新加载");
    // 主显仍是运行时身份（漂移提示不改版本串的口径）
    expect(screen.getByTestId("app-version")).toHaveTextContent("v0.40.1 · 2026.09.08-2");
  });

  it("构建号相同 → 顶栏零节点（不留空盒、不占位）", async () => {
    stubFetch(() => SAME);
    mount();
    await flush();
    expect(screen.queryByTestId("version-drift")).toBeNull();
    expect(screen.getByTestId("topnav-tools").textContent ?? "").not.toContain("有新版本");
  });

  it("version.json 拉不到（404）→ 顶栏零节点（降级不提示）", async () => {
    stubFetch(() => "nope", 404);
    mount();
    await flush();
    expect(versionHits).toBe(1); // 阳性对照：真的去拉了，「零节点」不是没走到
    expect(screen.queryByTestId("version-drift")).toBeNull();
  });

  it("点击 chip → location.reload()", async () => {
    stubFetch(() => LIVE);
    const reload = vi.fn();
    const { href, origin, pathname, search, hash } = window.location;
    vi.stubGlobal("location", { href, origin, pathname, search, hash, reload });
    mount();
    await flush();
    await act(async () => { screen.getByTestId("version-drift").click(); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("假时钟前进 5 分钟 → 再拉一次；轮询发现的新版本让 chip 从「没有」变「有」", async () => {
    // 第 1 拉与本地同版（刚打开时一切正常），第 2 拉是现网新发的那一版
    stubFetch((hit) => (hit === 1 ? SAME : LIVE));
    mount();
    await flush();
    expect(versionHits).toBe(1);
    expect(screen.queryByTestId("version-drift")).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(VERSION_POLL_MS); });
    expect(versionHits).toBe(2);
    expect(screen.getByTestId("version-drift")).toHaveTextContent("2026.09.08-2");
  });

  // 期望值手写（5 × 60 × 1000）。拿 VERSION_POLL_MS 推进时钟再断言「拉了」是同一个数
  // 自证：变异验证实测把常量改成 10 分钟，下面那两条时钟用例照样全绿，只有这条会红。
  it("间隔常量钉死 300000ms", () => {
    expect(VERSION_POLL_MS).toBe(300_000);
  });

  it("差一毫秒不拉：轮询间隔就是 5 分钟（量具自检，不是「反正会拉」）", async () => {
    stubFetch(() => SAME);
    mount();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(VERSION_POLL_MS - 1); });
    expect(versionHits).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(versionHits).toBe(2);
  });

  it("隐藏页不拉；回到前台立刻补拉一次", async () => {
    stubFetch((hit) => (hit >= 3 ? LIVE : SAME));
    mount();
    await flush();
    expect(versionHits).toBe(1);

    setVisibility("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(VERSION_POLL_MS * 3); });
    expect(versionHits, "隐藏的标签页轮询是纯浪费").toBe(1);

    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(versionHits, "回到前台立刻补拉一次").toBe(2);
    // 再回前台一次也照拉（事件不是一次性的）；第 3 拉给的是新版本 ⇒ chip 出来
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(versionHits).toBe(3);
    expect(screen.getByTestId("version-drift")).toHaveTextContent("2026.09.08-2");
  });

  it("切到隐藏时不误当成「回到前台」（同一个事件两个方向）", async () => {
    stubFetch(() => SAME);
    mount();
    await flush();
    setVisibility("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(versionHits).toBe(1);
  });

  it("轮询失败不抹掉已认定的漂移（一次网络抖动不该让提示消失）", async () => {
    stubFetch((hit) => (hit === 1 ? LIVE : "gone"), 200);
    mount();
    await flush();
    expect(screen.getByTestId("version-drift")).toBeInTheDocument();
    // 第 2 拉回一个形状不符的 body（形状不符 ⇒ fetchVersionInfo 收敛成 null）
    await act(async () => { await vi.advanceTimersByTimeAsync(VERSION_POLL_MS); });
    expect(versionHits).toBe(2);
    expect(screen.getByTestId("version-drift")).toBeInTheDocument();
    expect(screen.getByTestId("app-version")).toHaveTextContent("v0.40.1 · 2026.09.08-2");
  });

  it("卸载后不再轮询（定时器与事件监听都撤）", async () => {
    stubFetch(() => SAME);
    const { unmount } = mount();
    await flush();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(VERSION_POLL_MS * 2); });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(versionHits).toBe(1);
  });
});
