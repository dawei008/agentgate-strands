/**
 * 版本戳的**唯一读取口**。
 *
 * 形态：**语义化为主 + 构建号为辅** —— `v0.9.0 · 2026.08.26-1`。
 *  · 语义化版本唯一权威 = `web/package.json` 的 `version`（发布通道按批次分类在
 *    构建前 bump：功能批 minor / 修复·杂务批 patch）。代码里不硬编码版本串。
 *  · 构建号 = `YYYY.MM.DD-N`（UTC 日期 + 当天第几版），由
 *    `web/scripts/release-version.sh` 算号，答「今天第几次发」。
 *
 * 双身份：
 *  1. **编译期身份**（`APP_VERSION` / `APP_BUILD`，**就这两个**）—— vite 在 build 时
 *     `define` 进 bundle，与这堆字节恒一致、离线可读。
 *     dev server 与单测**刻意不注入** → 回落 `dev`（否则视觉基线和断言会随日期漂）。
 *  2. **运行时系统身份**（`/version.json`）—— 「现网是什么」的权威。纯后端发布时
 *     前端字节不重建（「零 web 改动 ⇒ dist 逐字节不变」是在用判据），编译期身份会
 *     合法地落后于系统身份，所以界面主显必须是运行时那个。
 *
 * **commit 与构建时刻只在运行时身份里**（build-hygiene-r1 批移出 bundle）：这两个值
 * 每个 commit / 每次构建都变，编进 bundle 会让「零 src 改动 ⇒ 产物逐字节不变」那条
 * 判据对所有会产生 commit 的批次结构性失效。编译期只做降级兜底，本来就不需要它们。
 *
 * 降级纪律：`/version.json` 拉不到（失败 / 404 / 403 / 形状不符）就**只显示
 * semver·构建号**，**不伪造** —— tooltip 里系统版本写「未知」，commit 与构建时刻
 * 那两项**整项不出现**（没有真值可显示时连占位都不给，绝不拿别的值冒充）。
 *
 * 纪律：全站显示处只走本模块（`__APP_*__` 是编译期字面量替换，散装读会让每个
 * 调用点各自造回落，版本口径分叉；tests/version-stamp.test.ts 静态守）。
 */
import { useEffect, useState } from "react";

/** 未注入（dev/vitest/别的打包器）时 `__APP_*__` 是未声明标识符，typeof 兜住 ReferenceError */
function injected(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 语义化版本（如 `0.9.0`）；未注入 → 空串 */
export const APP_VERSION: string =
  injected(typeof __APP_VERSION__ === "undefined" ? undefined : __APP_VERSION__);

/** 构建号（如 `2026.08.26-1`）；未注入 → 空串 */
export const APP_BUILD: string =
  injected(typeof __APP_BUILD__ === "undefined" ? undefined : __APP_BUILD__);

/**
 * 编译期身份**只有这两件**（参数化是为了可测：单测环境本身没有注入值）。
 * 刻意没有 commit / builtAt：那两个值不进 bundle（见文件头），编译期无从得知。
 */
export type UiBuild = { version: string; build: string };
const UI_BUILD: UiBuild = {
  version: APP_VERSION,
  build: APP_BUILD,
};

/** `/version.json` 的形状（发布通道写、边缘可 curl 核验） */
export type VersionInfo = {
  /** 语义化版本（权威 = 发布时的 web/package.json） */
  version: string;
  /** 构建号 YYYY.MM.DD-N */
  build: string;
  /** 发布 commit 短 sha */
  commit: string;
  /** 身份文件产出时刻（ISO） */
  built_at: string;
  /** 现网 dist 里嵌的构建号；未知 → null（不拿 build 冒充） */
  ui_build: string | null;
  /** 后端 Runtime 版本：构建期不可知，由发布脚本填；未填 → null */
  runtime_version: string | null;
};

const UNKNOWN = "未知";
const DEV = "dev";

/** 跟随 base 的身份文件地址（部署在分发根 → `/version.json`） */
export const VERSION_URL = `${import.meta.env.BASE_URL}version.json`;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** `v0.9.0 · 2026.08.26-1`；缺构建号只出语义化版本；两者都缺 → `dev` */
function stampLabel(version: string, build: string): string {
  const v = str(version);
  const b = str(build);
  if (v && b) return `v${v} · ${b}`;
  if (v) return `v${v}`;
  if (b) return b;
  return DEV;
}

/**
 * 拉运行时身份文件。任何异常都收敛成 null（调用方降级到编译期身份）：
 * 网络失败、非 2xx（404/403）、dev server 回 index.html 导致 JSON 解析炸、
 * version 与 build 都缺 —— 都属于「拉不到」，绝不半信半疑地用残缺值。
 * `cache: no-store` 防浏览器缓存把旧身份文件留在本地（边缘 TTL 归发布通道管）。
 */
export async function fetchVersionInfo(): Promise<VersionInfo | null> {
  try {
    const res = await fetch(VERSION_URL, { cache: "no-store" });
    if (!res.ok) return null;
    const raw = (await res.json()) as Partial<VersionInfo> | null;
    const version = str(raw?.version);
    const build = str(raw?.build);
    if (!version && !build) return null;
    return {
      version,
      build,
      commit: str(raw?.commit),
      built_at: str(raw?.built_at),
      ui_build: str(raw?.ui_build) || null,
      runtime_version: str(raw?.runtime_version) || null,
    };
  } catch {
    return null;
  }
}

/**
 * 进程内缓存一份，但**可被轮询换掉**。
 *
 * 原来这里写的是「只拉一次：版本号不需要轮询（发布后用户刷新页面即更新）」——
 * 那个假设在久开的标签页上是错的：用户 2026-09-08 报「发布的拓扑没有了」，真因是
 * 他的标签页顶栏还是 `v0.36.0 · 2026.09.07-1`（一天前打开、之后没刷新），拓扑在
 * v0.39.0 才有。API 调用照旧走通（页面上的数据是当天的），所以旧标签页看起来完全
 * 正常，只是界面老 —— 界面自己不说，用户没有理由去刷新。
 */
let pending: Promise<VersionInfo | null> | null = null;

/** 拉一次；同一拍里的多个调用方共享同一个 in-flight promise（侧栏/顶栏不重复打网络） */
export function loadVersionInfo(): Promise<VersionInfo | null> {
  pending ??= fetchVersionInfo();
  return pending;
}

/** 重拉（轮询 / 回到前台用）：绕过缓存，拉完把缓存换成新结果 */
export function reloadVersionInfo(): Promise<VersionInfo | null> {
  const p = fetchVersionInfo();
  pending = p;
  return p;
}

/** 测试用：清掉进程内缓存（照 lib/config.ts 的 resetConfigForTest 惯例） */
export function resetVersionInfoForTest(): void {
  pending = null;
}

/**
 * 测试用：覆盖编译期身份。单测与 dev 刻意**不注入** `__APP_*__`（见文件头），
 * 所以「这堆字节的构建号」在单测里恒为空串 —— 漂移三态没法只靠 stub fetch 造出来。
 * 传 null 复原。参数化口径与 `versionLabel(live, ui)` 同源，只是 hook 里没有传参位。
 */
let uiBuildOverride: UiBuild | null = null;
export function setUiBuildForTest(ui: UiBuild | null): void {
  uiBuildOverride = ui;
}
const currentUiBuild = (): UiBuild => uiBuildOverride ?? UI_BUILD;

/**
 * 界面主显：系统身份 `v<semver> · <构建号>`；拉不到就降级成编译期身份
 * （dev 下就是 `dev`）。两者都是真值 —— 降级不伪造，只是口径退了一级。
 */
export function versionLabel(live?: VersionInfo | null, ui: UiBuild = UI_BUILD): string {
  if (live) {
    const label = stampLabel(live.version, live.build);
    if (label !== DEV) return label;
  }
  return stampLabel(ui.version, ui.build);
}

/**
 * hover 提示：系统版本 + UI 构建 + 发布 commit + Runtime 版本 + 构建时刻。
 * commit 与构建时刻**只有身份文件那一个来源**（bundle 里没有），所以拉不到身份文件
 * 时这两项**整项不出现** —— 降级只剩 semver·构建号，不伪造、不占位。
 */
export function versionTitle(live?: VersionInfo | null, ui: UiBuild = UI_BUILD): string {
  const liveLabel = live ? stampLabel(live.version, live.build) : DEV;
  const parts = [
    `系统版本 ${liveLabel === DEV ? UNKNOWN : liveLabel}`,
    `UI 构建 ${stampLabel(ui.version, ui.build)}`,
  ];
  const liveCommit = str(live?.commit);
  if (liveCommit) parts.push(`发布 commit ${liveCommit}`);
  parts.push(`Runtime ${str(live?.runtime_version) || UNKNOWN}`);
  const builtAt = str(live?.built_at);
  if (builtAt) parts.push(`构建于 ${builtAt}`);
  return parts.join(" · ");
}

/**
 * 版本漂移：运行时身份文件的构建号 **≠** 这堆字节的构建号 ⇒ 页面比现网旧。
 * `from` = 页面在跑的（旧），`to` = 现网的（新）。
 *
 * 任一侧读不出构建号就返回 null —— 「拉不到身份文件」「dev/单测没注入编译期身份」
 * 都不是漂移，沿用本文件的降级纪律：没有真值可比时不提示，绝不拿别的值凑一个判断。
 */
export type VersionDrift = { from: string; to: string };

export function versionDrift(
  live?: VersionInfo | null,
  ui: UiBuild = UI_BUILD,
): VersionDrift | null {
  const to = str(live?.build);
  const from = str(ui.build);
  if (!to || !from || to === from) return null;
  return { from, to };
}

/** 漂移轮询间隔：5 分钟（发布节奏是天级，这个粒度只为把久开的标签页拉回来） */
export const VERSION_POLL_MS = 5 * 60 * 1000;

/**
 * 顶栏用：挂载后拉一次身份文件，拉不到就保持编译期身份的降级态；此后每
 * `VERSION_POLL_MS` 重拉一次，**页面隐藏时不拉**（后台标签页轮询是纯浪费），
 * 回到前台立刻拉一次 —— 久开的标签页真正的落点就是「切回来的那一刻」。
 *
 * 重拉失败（null）不覆盖已有读数：一次网络抖动不该把已经认定的漂移抹掉，也不该
 * 让主显的系统身份退回编译期身份。
 */
export function useVersionStamp(): { label: string; title: string; drift: VersionDrift | null } {
  const [live, setLive] = useState<VersionInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const take = (info: VersionInfo | null) => {
      if (alive && info) setLive(info);
    };
    void loadVersionInfo().then(take);
    const poll = () => {
      if (document.visibilityState === "hidden") return;
      void reloadVersionInfo().then(take);
    };
    const timer = setInterval(poll, VERSION_POLL_MS);
    // 事件两个方向都进 poll，方向判定只留一处（在 poll 里）：再写一道
    // `if (visibilityState === "visible")` 是死分支 —— 变异验证实测它被 poll
    // 自己的守卫等价吞掉（改成无条件 poll 全测试照绿），两道守卫说的是同一句话。
    document.addEventListener("visibilitychange", poll);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, []);
  const ui = currentUiBuild();
  return { label: versionLabel(live, ui), title: versionTitle(live, ui), drift: versionDrift(live, ui) };
}
