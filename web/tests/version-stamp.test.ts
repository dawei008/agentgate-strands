// 版本戳（release-version-stamp 批）。
//
// 用户诉求原文：「发布时加版本号」。此前前端零版本标识（package.json 停在
// 0.1.0、无构建期注入、仓库零 tag），现网跑的是哪一版只能靠比 chunk 哈希。
//
// 形态：**语义化为主 + 构建号为辅** —— `v0.9.0 · 2026.08.26-1`。
//   · 语义化版本唯一权威 = web/package.json 的 version（发布通道 bump，代码不硬编码）；
//   · 构建号 = YYYY.MM.DD-N（UTC 日期 + 当天第几版），release-version.sh 算号。
// **双身份**：编译期身份进 bundle（与那堆字节恒一致）；运行时 `/version.json` 是
// 「现网是什么」的权威（纯后端发布不重建前端，编译期身份会合法落后）。侧栏主显
// 运行时身份，拉不到降级成编译期身份。
//
// 编译期身份**只留稳定的两个**（build-hygiene-r1 批）：`commit`（每个 commit 变）与
// `built_at`（每次构建变）从 bundle 里移出，只进 `version.json`（运行时身份，本来就有
// 这两键）—— 否则「零 src 改动 ⇒ 产物逐字节不变」这条在用判据对**所有会产生 commit
// 的批次**结构性失效（见 .scratch/triage-r1/issues/bundle-byte-stability-vs-version-stamp.md）。
// 代价：拉不到 version.json 时 tooltip **只显示 semver·构建号**，不许伪造 commit/构建时刻。
//
// 本文件钉住七件事：
//   1) 标签/提示三形态（semver+构建号 / 只有 semver / dev 回落）与降级不伪造；
//   2) 拉取的降级路径（失败 / 404 / 403 / index.html / 形状不符）；
//   3) release-version.sh：构建号按后缀**数值**取最大（字典序会在第 10 版撞号）、
//      semver 取最新必须走 v:refname（`v0.10.0` 字典序在 `v0.9.0` 前）、
//      --current 三态、--write-json 六键；
//   4) vite 插件：build 才注入、显式读 package.json（读不到即失败）、产物根 version.json；
//   5) 唯一读取口纪律（禁散装读魔法常量）+ 移出的两个常量全站零残留；
//   6) 侧栏底部渲染 + title 全信息 + 降级形态；
//   7) 构建产物卫生（真 build 跑两遍）：bundle 无 commit/构建时刻、两次逐字节相同、
//      dist 根不含 dev-only 的 mockServiceWorker.js。
//
// 算号走真 git：在 /tmp 造临时仓打假 tag（**绝不在真仓打 tag**）。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import TopNav from "../src/components/layout/TopNav";
import { parseHash } from "../src/router";
import {
  APP_BUILD,
  APP_VERSION,
  fetchVersionInfo,
  resetVersionInfoForTest,
  versionLabel,
  versionTitle,
  type UiBuild,
  type VersionInfo,
} from "../src/lib/version";

const SCRIPT = resolve(process.cwd(), "scripts/release-version.sh");
const BUILD_RE = /^\d{4}\.\d{2}\.\d{2}-\d+$/;
/** 语义化版本权威：package.json（测试也从这里读 —— 断言里不硬编码版本串） */
const PKG_VERSION = (JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as { version: string }).version;

/**
 * 一份「已发布构建」的编译期身份（单测环境本身不注入，所以显式造）。
 * **只有两个键** —— commit / 构建时刻已从 bundle 移出（只在 version.json 里）。
 */
const UI: UiBuild = {
  version: "0.9.0",
  build: "2026.08.26-1",
};
const LIVE: VersionInfo = {
  version: "0.9.0",
  build: "2026.08.26-2",
  commit: "a1b2c3d",
  built_at: "2026-08-26T05:00:00.000Z",
  ui_build: "2026.08.26-1",
  runtime_version: "rt-7",
};

// ---------- 1) 标签与提示 ----------
describe("versionLabel()：语义化为主 + 构建号为辅", () => {
  it("正常：semver 与构建号都有 → `v0.9.0 · 2026.08.26-2`（主显运行时身份）", () => {
    expect(versionLabel(LIVE, UI)).toBe("v0.9.0 · 2026.08.26-2");
  });

  it("只有 semver（身份文件里没构建号）→ `v0.9.0`", () => {
    expect(versionLabel({ ...LIVE, build: "" }, UI)).toBe("v0.9.0");
    expect(versionLabel(null, { ...UI, build: "" })).toBe("v0.9.0");
  });

  it("dev 回落：编译期没注入、运行时也拉不到 → `dev`", () => {
    expect(versionLabel(null, { version: "", build: "" })).toBe("dev");
  });

  it("身份文件拉不到 → 降级成编译期身份（真值，不伪造）", () => {
    expect(versionLabel(null, UI)).toBe("v0.9.0 · 2026.08.26-1");
  });

  it("身份文件 version/build 都是空串 → 当作拉不到，降级", () => {
    expect(versionLabel({ ...LIVE, version: " ", build: " " }, UI)).toBe("v0.9.0 · 2026.08.26-1");
  });

  it("单测/dev 环境刻意不注入 → 常量空 + 标签 dev（断言不随日期漂）", () => {
    expect(APP_VERSION).toBe("");
    expect(APP_BUILD).toBe("");
    expect(versionLabel(null)).toBe("dev");
  });
});

describe("versionTitle()：commit / 构建时刻只来自运行时身份文件", () => {
  it("拉到身份文件：系统版本 / UI 构建 / 发布 commit / Runtime / 构建时刻齐全", () => {
    const t = versionTitle(LIVE, UI);
    expect(t).toContain("系统版本 v0.9.0 · 2026.08.26-2");
    expect(t).toContain("UI 构建 v0.9.0 · 2026.08.26-1");
    expect(t).toContain("发布 commit a1b2c3d");
    expect(t).toContain("Runtime rt-7");
    // 构建时刻取**身份文件那份**（编译期不再带时刻 → 只有一个可信来源）
    expect(t).toContain("构建于 2026-08-26T05:00:00.000Z");
    expect(t).not.toContain("UI commit");
  });

  it("身份文件里的 commit 就是唯一 commit（编译期身份不再带 commit，不存在两个）", () => {
    const t = versionTitle({ ...LIVE, commit: "e4f5a6b" }, UI);
    expect(t).toContain("发布 commit e4f5a6b");
    expect(t).not.toContain("a1b2c3d");
  });

  // 钉子 3：降级只显示 semver·构建号
  it("降级只显示 semver·构建号：拉不到身份文件 → 无 commit、无构建时刻、无占位伪造", () => {
    const t = versionTitle(null, UI);
    expect(t).toContain("系统版本 未知");
    expect(t).toContain("UI 构建 v0.9.0 · 2026.08.26-1");
    expect(t).not.toContain("系统版本 v0.9.0");
    // 这三条是本批的正身：commit 与构建时刻**一个字都不出现**（不许「未知」占位，
    // 更不许拿编译期值冒充 —— 编译期已经不知道这两件事了）
    expect(t).not.toMatch(/commit/i);
    expect(t).not.toContain("构建于");
    expect(t).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("Runtime 版本未填（构建期不可知）→ 「未知」", () => {
    expect(versionTitle({ ...LIVE, runtime_version: null }, UI)).toContain("Runtime 未知");
  });

  it("身份文件缺 commit / built_at（老文件）→ 那两项直接不出现，不伪造", () => {
    const t = versionTitle({ ...LIVE, commit: "", built_at: "" }, UI);
    expect(t).not.toMatch(/commit/i);
    expect(t).not.toContain("构建于");
  });
});

// ---------- 5) 唯一读取口纪律 ----------
describe("唯一读取口纪律：全站不许散装读 __APP_* 常量", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(p)) out.push(p);
    }
    return out;
  };
  it("src/ 下只有 lib/version.ts 与类型声明文件提到两个魔法常量", () => {
    const offenders = walk(resolve(process.cwd(), "src")).filter((p) => {
      if (/lib[/\\]version\.ts$/.test(p) || /\.d\.ts$/.test(p)) return false;
      return /__APP_(VERSION|BUILD)__/.test(readFileSync(p, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  // 移出的两个常量：src/ 与 vite.config.ts 里**零残留**（留着读就会在 bundle 里
  // 留下裸标识符，还会让人以为编译期还知道 commit/构建时刻）
  it("__APP_COMMIT__ / __APP_BUILT_AT__ 全站零残留（含 vite.config.ts 与 .d.ts）", () => {
    const files = [...walk(resolve(process.cwd(), "src")), resolve(process.cwd(), "vite.config.ts")];
    const offenders = files.filter((p) => /__APP_(COMMIT|BUILT_AT)__/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("版本串不许硬编码：src/ 里除 version.ts 注释外不出现 package.json 的版本值", () => {
    const offenders = walk(resolve(process.cwd(), "src")).filter((p) => {
      if (/lib[/\\]version\.ts$/.test(p)) return false;   // 注释里举例说明形态是合法的
      const code = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      return code.includes(PKG_VERSION);
    });
    expect(offenders).toEqual([]);
  });
});

// ---------- 2) 运行时拉取的降级路径 ----------
describe("fetchVersionInfo()：拉得到就用，拉不到一律 null（降级不半信半疑）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetVersionInfoForTest();
  });
  const stub = (impl: (url: string) => Promise<Response>) =>
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => impl(String(input))));

  it("200 + 完整 JSON → 解析成 VersionInfo", async () => {
    stub(async (url) => {
      expect(url).toContain("version.json");
      return Response.json(LIVE);
    });
    await expect(fetchVersionInfo()).resolves.toEqual(LIVE);
  });

  it("404 → null", async () => {
    stub(async () => new Response("nope", { status: 404 }));
    await expect(fetchVersionInfo()).resolves.toBeNull();
  });

  it("403（边缘缺 key 返的就是 403，不是 404）→ null", async () => {
    stub(async () => new Response("denied", { status: 403 }));
    await expect(fetchVersionInfo()).resolves.toBeNull();
  });

  it("网络失败 → null（不抛给调用方）", async () => {
    stub(async () => { throw new TypeError("network down"); });
    await expect(fetchVersionInfo()).resolves.toBeNull();
  });

  it("dev server 回 index.html（JSON 解析炸）→ null", async () => {
    stub(async () => new Response("<!doctype html><html></html>", {
      status: 200, headers: { "Content-Type": "text/html" },
    }));
    await expect(fetchVersionInfo()).resolves.toBeNull();
  });

  it("version 与 build 都缺（形状不符）→ null", async () => {
    stub(async () => Response.json({ commit: "a1b2c3d" }));
    await expect(fetchVersionInfo()).resolves.toBeNull();
  });

  it("ui_build / runtime_version 缺失 → null 而不是空串（口径不含糊）", async () => {
    stub(async () => Response.json({ version: "0.9.0", build: "2026.08.26-2", commit: "a1b2c3d", built_at: "t" }));
    await expect(fetchVersionInfo()).resolves.toEqual({
      version: "0.9.0", build: "2026.08.26-2", commit: "a1b2c3d", built_at: "t",
      ui_build: null, runtime_version: null,
    });
  });
});

// ---------- 3) scripts/release-version.sh ----------
describe("release-version.sh：算号 / 三态 / 写身份文件（只算号不打 tag）", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmpDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmps.push(dir);
    return dir;
  }
  /** 造一个带假 tag 的临时 git 仓（真仓零 tag，不许碰） */
  function repo(tags: string[]): string {
    const dir = tmpDir("relver-");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("commit", "-q", "--allow-empty", "-m", "root");
    for (const t of tags) git("tag", t);
    return dir;
  }
  const run = (dir: string, args: string[] = [], env: Record<string, string> = {}) =>
    execFileSync("bash", [SCRIPT, ...args], {
      cwd: dir, encoding: "utf8", env: { ...process.env, ...env },
    }).trim();

  /** 脚本的「今天」= UTC 日期，测试同源现算（不写死日期，明天照样绿） */
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10).replace(/-/g, ".");

  it("零 tag → 今天第一版 -1", () => {
    expect(run(repo([]))).toBe(`${today}-1`);
  });

  it("今天已有 1 版 → -2", () => {
    expect(run(repo([`release/${today}-1`]))).toBe(`${today}-2`);
  });

  it("构建号按后缀数值取最大（字典序会在第 10 版那天算出 -3 并静默撞号）", () => {
    const tags = [`release/${today}-1`, `release/${today}-2`, `release/${today}-10`];
    // 字典序陷阱先摆出来：排序后最后一个是 -2，不是 -10
    expect([...tags].sort().at(-1)).toBe(`release/${today}-2`);
    expect(run(repo(tags))).toBe(`${today}-11`);
  });

  it("只有昨天的 tag → 今天从 -1 重新起算", () => {
    expect(run(repo([`release/${yesterday}-3`]))).toBe(`${today}-1`);
  });

  it("非 release/ 前缀的 tag 不参与算号", () => {
    expect(run(repo(["v1.2.3", `${today}-9`]))).toBe(`${today}-1`);
  });

  it("--current 三态之一：从没发过 → none", () => {
    expect(run(repo([]), ["--current"])).toBe("none");
  });

  it("--current 三态之二：发过但今天没发 → stale <最新构建号>（跨日也按数值序）", () => {
    expect(run(repo([`release/${yesterday}-3`, `release/${yesterday}-10`]), ["--current"]))
      .toBe(`stale ${yesterday}-10`);
  });

  it("--current 三态之三：今天已发到 -N → today <构建号>（不递增）", () => {
    const dir = repo([`release/${yesterday}-3`, `release/${today}-2`, `release/${today}-10`]);
    expect(run(dir, ["--current"])).toBe(`today ${today}-10`);
    expect(run(dir)).toBe(`${today}-11`);   // 算号仍递增，两模式互不影响
  });

  it("--latest-semver：v0.10.0 排在 v0.9.0 之后（字典序会指错版本）", () => {
    const tags = ["v0.9.0", "v0.9.1", "v0.10.0"];
    // 字典序陷阱：排完最后一个是 v0.9.1，v0.10.0 被排到 v0.9.0 前面
    expect([...tags].sort()).toEqual(["v0.10.0", "v0.9.0", "v0.9.1"]);
    expect(run(repo(tags), ["--latest-semver"])).toBe("v0.10.0");
    expect(run(repo(["v0.9.0", "v0.10.0"]), ["--latest-semver"])).toBe("v0.10.0");
    expect(run(repo([]), ["--latest-semver"])).toBe("none");
  });

  it("--write-json：写出六键身份文件，version 取自 package.json，ui_build 未知为 null", () => {
    const dir = repo([`release/${today}-1`]);
    const out = tmpDir("dist-");
    expect(run(dir, ["--write-json", out])).toBe(`${today}-2`);
    const body = JSON.parse(readFileSync(join(out, "version.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(
      ["version", "build", "commit", "built_at", "ui_build", "runtime_version"]);
    expect(body.version).toBe(PKG_VERSION);
    expect(body.build).toBe(`${today}-2`);
    expect(body.ui_build).toBeNull();
    expect(body.runtime_version).toBeNull();
    expect(Date.parse(String(body.built_at))).not.toBeNaN();
    expect(String(body.commit)).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("--write-json：纯 Runtime 发布沿用旧 ui_build（前端字节没重建）", () => {
    const dir = repo([]);
    const out = tmpDir("dist-");
    writeFileSync(join(out, "version.json"), JSON.stringify({
      version: "0.8.0", build: `${yesterday}-1`, commit: "old1234", built_at: "x",
      ui_build: `${yesterday}-1`, runtime_version: null,
    }));
    run(dir, ["--write-json", out], { RELEASE_ID: `${today}-9`, RUNTIME_VERSION: "rt-42" });
    const body = JSON.parse(readFileSync(join(out, "version.json"), "utf8")) as Record<string, unknown>;
    expect(body.build).toBe(`${today}-9`);            // RELEASE_ID 优先级最高
    expect(body.version).toBe(PKG_VERSION);           // semver 权威永远是 package.json
    expect(body.ui_build).toBe(`${yesterday}-1`);     // UI 构建号合法落后
    expect(body.runtime_version).toBe("rt-42");       // 由发布脚本填
  });

  it("--write-json 目录不存在 → 退出码 2，不静默", () => {
    let code = 0;
    try {
      execFileSync("bash", [SCRIPT, "--write-json", join(tmpdir(), "nope-does-not-exist")],
        { cwd: repo([]), encoding: "utf8", stdio: "pipe" });
    } catch (e) { code = (e as { status?: number }).status ?? -1; }
    expect(code).toBe(2);
  });

  it("不在 git 工作树里 → 非零退出（调用方回落 dev，不许谎报 -1）", () => {
    let code = 0;
    try {
      execFileSync("bash", [SCRIPT], { cwd: tmpDir("relver-nogit-"), encoding: "utf8", stdio: "pipe" });
    } catch (e) { code = (e as { status?: number }).status ?? -1; }
    expect(code).not.toBe(0);
  });

  it("脚本头注释写明 UTC 与「tag 由发布通道打」（本脚本只算号）", () => {
    const head = readFileSync(SCRIPT, "utf8").split("\n").slice(0, 30).join("\n");
    expect(head).toMatch(/UTC/);
    expect(head).toMatch(/release\//);
    expect(head).toMatch(/不打 tag|只算号/);
    expect(head).toMatch(/package\.json/);   // semver 权威写在头上
  });
});

// ---------- 4) 构建期注入 + dist/version.json 插件 ----------
type Emitted = { type?: string; fileName?: string; source?: string };
type ConfigProbe = {
  define: Record<string, string> | null;
  apply: string | null;
  /** 全部插件的 name + apply（用来钉「剔 dev-only 资产」那个插件只在 build 生效） */
  plugins: { name: string; apply: string | null }[];
  emitted: Emitted[];
  pkgVersion: string | null;
  missingFileThrew: boolean;
  emptyVersionThrew: boolean;
  usesNpmEnvVar: boolean;
};

/**
 * 在**真 node 子进程**里加载 vite.config.ts 并探针化：
 *   · jsdom 的 realm 让 esbuild 的启动断言（TextEncoder→Uint8Array）为假，
 *     在测试进程内 import 配置必炸「environment is broken」；
 *   · node 进程才是 vite 自己跑配置的环境，探到的就是构建时的真值。
 * node 24 原生剥 TS 类型，不需要预编译。
 */
function probeViteConfig(env: Record<string, string> = {}): ConfigProbe {
  const configPath = resolve(process.cwd(), "vite.config.ts");
  const script = `
    import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const mod = await import(${JSON.stringify(configPath)});
    const cfg = mod.default;
    const flat = (cfg.plugins ?? []).flat(3);
    const p = flat.find((x) => x && x.name === "version-stamp");
    let define = null;
    const emitted = [];
    if (p) {
      // vite 的 config 钩子返回的局部配置会被合并进最终配置（define 就是这么进去的）
      define = (p.config ? p.config({}, { command: "build", mode: "production" }) : {}).define ?? null;
      if (p.generateBundle) p.generateBundle.call({ emitFile: (f) => emitted.push(f) });
    }
    // 「读不到 package.json 就构建失败」而不是回落成空串
    const threw = (fn) => { try { fn(); return false; } catch { return true; } };
    const dir = mkdtempSync(join(tmpdir(), "pkgprobe-"));
    const bad = join(dir, "package.json");
    writeFileSync(bad, JSON.stringify({ name: "x" }));
    console.log("PROBE " + JSON.stringify({
      define, apply: p ? (p.apply ?? null) : null, emitted,
      plugins: flat.filter((x) => x && x.name)
        .map((x) => ({ name: x.name, apply: typeof x.apply === "string" ? x.apply : null })),
      pkgVersion: mod.readPackageVersion ? mod.readPackageVersion() : null,
      missingFileThrew: threw(() => mod.readPackageVersion(join(dir, "nope.json"))),
      emptyVersionThrew: threw(() => mod.readPackageVersion(bad)),
      usesNpmEnvVar: readFileSync(${JSON.stringify(configPath)}, "utf8")
        .split("\\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
        .join("\\n").includes("npm_package_version"),
    }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = out.split("\n").find((l) => l.startsWith("PROBE "));
  if (!line) throw new Error(`探针没输出：${out}`);
  return JSON.parse(line.slice("PROBE ".length)) as ConfigProbe;
}

describe("vite 插件 version-stamp：build 才注入，产物根出 version.json", () => {
  let probe: ConfigProbe;
  beforeAll(() => { probe = probeViteConfig(); });

  it("只在 build 生效（dev/vitest 不注入 → 视觉基线与断言不随日期漂）", () => {
    expect(probe.apply, "vite.config.ts 缺 version-stamp 插件").toBe("build");
    expect(APP_VERSION).toBe("");   // 本测试进程就是 serve/test 侧的证据
  });

  it("只注入两个常量（发布内稳定的那两个）：semver 取 package.json、构建号现算", () => {
    const define = probe.define ?? {};
    for (const k of ["__APP_VERSION__", "__APP_BUILD__"]) {
      expect(define[k], k).toBeTypeOf("string");
      expect(JSON.parse(define[k]), k).toBeTypeOf("string");
    }
    expect(JSON.parse(define.__APP_VERSION__)).toBe(PKG_VERSION);
    expect(JSON.parse(define.__APP_BUILD__)).toMatch(BUILD_RE);
    // commit / built_at **不再 define**（它们每个 commit / 每次构建都变，编进 bundle
    // 就让「零 src 改动 ⇒ 产物逐字节不变」永久失效）；这两键只进 version.json
    expect(Object.keys(define).sort()).toEqual(["__APP_BUILD__", "__APP_VERSION__"]);
  });

  it("semver 显式读 package.json：读不到 / 没 version 就构建失败，不回落成空", () => {
    expect(probe.pkgVersion).toBe(PKG_VERSION);
    expect(probe.missingFileThrew).toBe(true);
    expect(probe.emptyVersionThrew).toBe(true);
    // npm_package_version 只在 `npm run` 下有值，直接 vite build 是静默 undefined
    expect(probe.usesNpmEnvVar).toBe(false);
  });

  it("取值优先级：环境变量 RELEASE_ID 压过脚本现算", () => {
    const p = probeViteConfig({ RELEASE_ID: "2099.12.31-7", RUNTIME_VERSION: "rt-99" });
    expect(JSON.parse((p.define ?? {}).__APP_BUILD__)).toBe("2099.12.31-7");
    const body = JSON.parse(p.emitted[0].source!) as Record<string, unknown>;
    expect(body.build).toBe("2099.12.31-7");
    expect(body.runtime_version).toBe("rt-99");
  });

  it("emit version.json 到产物根（六键齐 + 与注入的编译期身份一致）", () => {
    expect(probe.emitted).toHaveLength(1);
    expect(probe.emitted[0].type).toBe("asset");
    expect(probe.emitted[0].fileName).toBe("version.json");
    const body = JSON.parse(probe.emitted[0].source!) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(
      ["version", "build", "commit", "built_at", "ui_build", "runtime_version"]);
    expect(body.version).toBe(PKG_VERSION);
    expect(body.build).toMatch(BUILD_RE);
    expect(body.ui_build).toBe(JSON.parse((probe.define ?? {}).__APP_BUILD__));
    expect(body.runtime_version).toBeNull();   // 构建期不可知
    expect(Date.parse(String(body.built_at))).not.toBeNaN();
  });
});

// ---------- 6) 顶栏可见 ----------
// 原钉「侧栏底部」：侧栏随 ADR-0016 撤成单行顶栏，版本戳挪到顶栏工具区（头像左侧），
// testid app-version 不变；容器由 sidebar 改钉 topnav。
describe("顶栏工具区版本号", () => {
  beforeEach(() => resetVersionInfoForTest());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetVersionInfoForTest();
  });

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

  it("拉到身份文件 → 主显 `v<semver> · <构建号>`，title 带 commit 与 Runtime", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(LIVE)));
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("app-version")).toHaveTextContent("v0.9.0 · 2026.08.26-2"));
    const title = screen.getByTestId("app-version").getAttribute("title") ?? "";
    expect(title).toContain("系统版本 v0.9.0 · 2026.08.26-2");
    expect(title).toContain("UI 构建 dev");          // 单测未注入编译期身份
    expect(title).toContain("发布 commit a1b2c3d");  // UI commit 未知 → 只出发布 commit
    expect(title).toContain("Runtime rt-7");
  });

  it("拉不到 → 降级只显示编译期身份，title 写「系统版本 未知」且不出现 commit/构建时刻", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    mount();
    const el = screen.getByTestId("app-version");
    expect(el).toHaveTextContent(versionLabel(null));   // 单测环境 = dev
    expect(screen.getByTestId("topnav")).toContainElement(el);
    await waitFor(() => expect(el.getAttribute("title")).toContain("系统版本 未知"));
    const title = el.getAttribute("title") ?? "";
    expect(title).toContain("UI 构建 dev");
    // 钉子 3 的界面侧：降级态的 tooltip 里 commit 与构建时刻一个字都没有
    expect(title).not.toMatch(/commit/i);
    expect(title).not.toContain("构建于");
  });
});

// ---------- 7) 构建产物卫生：真 build 跑两遍 ----------
// 立项理由两份：
//   · .scratch/triage-r1/issues/bundle-byte-stability-vs-version-stamp.md ——
//     `commit`/`built_at` 编进 bundle ⇒ 「零 src 改动 ⇒ 产物逐字节不变」结构性失效；
//   · .scratch/triage-r1/issues/msw-worker-ships-to-prod.md ——
//     `public/mockServiceWorker.js`（9666 B）随站点发到 CDN（没人注册，但属 dev 工具链）。
//
// ⚠️ 判据必须搜**值**不搜宏名：`define` 是编译期替换，压缩后的产物里只剩值，
// 宏名（`__APP_COMMIT__`）**改动之前就已经 0 命中** —— 拿它当钉子等于「无信号当好信号」。
// 所以这里搜的是 version.json 里那个真 sha（== `git rev-parse --short HEAD`）与
// **ISO-8601 形状的正则**（构建时刻的形状，不依赖具体值）。
describe("构建产物卫生：bundle 只留 semver + 构建号，msw worker 不进 dist", () => {
  /** 两次构建钉同一构建号：本判据问的是「src 变没变」，不问算号（也免跨午夜假红） */
  const PINNED_BUILD = "2099.12.31-7";
  const VITE_BIN = resolve(process.cwd(), "node_modules/vite/bin/vite.js");
  /** 真发给浏览器执行/渲染的字节。**刻意排掉 .map**：sourcesContent 就是原始源码，
   *  注释与夹具里本来就有 ISO 串（实测 1970-01-01T00:00 / 2026-08-11T09:00），
   *  扫它只会扫出源码自己写的东西，不是注入进去的编译期身份。 */
  const SHIPPED = /\.(js|css|html)$/;
  const ISO_SHAPE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  const SIX_KEYS = ["version", "build", "commit", "built_at", "ui_build", "runtime_version"];

  type Built = {
    files: string[];
    md5: Record<string, string>;
    text: Record<string, string>;
    versionJson: Record<string, unknown>;
  };

  function walkRel(dir: string, base: string = dir, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walkRel(p, base, out);
      else out.push(relative(base, p).split("\\").join("/"));
    }
    return out.sort();
  }

  function buildInto(outDir: string): void {
    // ⚠️ 必须**抹掉继承来的 NODE_ENV**：vitest 把它设成 `test`，而 vite 只在
    // NODE_ENV 未设时才按 build 默认成 production ⇒ 直接继承会让
    // `import.meta.env.DEV` 为真，`main.tsx` 里 dev 分支的 `import("./mocks/browser")`
    // 不被摇掉，msw handlers 与整套夹具被打进产物（实测多出 `assets/browser-*.js`）。
    // 那就不是发布跑的那份字节了 —— 判据必须跑真发布形态。
    const env: NodeJS.ProcessEnv = { ...process.env, RELEASE_ID: PINNED_BUILD };
    delete env.NODE_ENV;
    execFileSync(process.execPath, [VITE_BIN, "build", "--outDir", outDir, "--emptyOutDir"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function snapshot(outDir: string): Built {
    const files = walkRel(outDir);
    const md5: Record<string, string> = {};
    const text: Record<string, string> = {};
    for (const rel of files) {
      const buf = readFileSync(join(outDir, rel));
      md5[rel] = createHash("md5").update(buf).digest("hex");
      if (SHIPPED.test(rel)) text[rel] = buf.toString("utf8");
    }
    return {
      files,
      md5,
      text,
      versionJson: JSON.parse(readFileSync(join(outDir, "version.json"), "utf8")) as Record<string, unknown>,
    };
  }

  let outDir = "";
  let first: Built;
  let second: Built;

  beforeAll(() => {
    // 两次构建**必须用同一个 outDir**：sourcemap 的 `sources` 是相对路径，换目录
    // （深度不同）会让 map 字节合法地不同 ⇒ 假红。
    outDir = mkdtempSync(join(tmpdir(), "dist-bytecheck-"));
    buildInto(outDir);
    first = snapshot(outDir);
    buildInto(outDir);
    second = snapshot(outDir);
  }, 300_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  /** 命中报告成「文件: 命中片段」，红的时候能直接看出是哪个文件哪一段 */
  const hits = (b: Built, probe: (body: string) => string | null): string[] =>
    b.files
      .filter((f) => SHIPPED.test(f))
      .map((f) => {
        const m = probe(b.text[f]);
        return m === null ? null : `${f}: ${m}`;
      })
      .filter((x): x is string => x !== null);

  // 钉子 1（承重）：搜值，不搜宏名
  it("bundle 不含构建 commit：那个真 sha 在 js/css/html 里零命中（commit 只在 version.json）", () => {
    const sha = String(first.versionJson.commit);
    expect(sha, "version.json 得有真 sha，否则这条恒真").toMatch(/^[0-9a-f]{7,}$/);
    // 同源核对：version.json 里的就是当前 HEAD 的短 sha（不是随便一个串）
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(), encoding: "utf8",
    }).trim();
    expect(sha).toBe(head);
    expect(hits(first, (body) => (body.includes(sha) ? sha : null))).toEqual([]);
  });

  it("bundle 不含构建时刻：js/css/html 里没有任何 ISO-8601 形状的时间戳", () => {
    expect(Date.parse(String(first.versionJson.built_at)), "version.json 得有真时刻").not.toBeNaN();
    expect(hits(first, (body) => body.match(ISO_SHAPE)?.[0] ?? null)).toEqual([]);
  });

  it("防恒真正控：稳定的两个（semver + 构建号）确实进了 bundle 字节", () => {
    const js = first.files.filter((f) => /^assets\/.*\.js$/.test(f));
    expect(js.length).toBeGreaterThan(0);
    expect(js.some((f) => first.text[f].includes(`"${PKG_VERSION}"`)), "semver 不在 bundle 里").toBe(true);
    expect(js.some((f) => first.text[f].includes(`"${PINNED_BUILD}"`)), "构建号不在 bundle 里").toBe(true);
  });

  // 钉子 2：正身判据
  it("src 不变 ⇒ 两次构建除 version.json 外逐字节相同（md5 全等）", () => {
    expect(second.files).toEqual(first.files);
    const drop = (m: Record<string, string>): Record<string, string> => {
      const { "version.json": _v, ...rest } = m;
      return rest;
    };
    expect(drop(second.md5)).toEqual(drop(first.md5));
    // 判据原话是「JS 逐字节相同」，单拎出来免得将来被别的产物噪声淹没
    const js = first.files.filter((f) => /\.js$/.test(f));
    expect(js.length).toBeGreaterThan(0);
    for (const f of js) expect(second.md5[f], f).toBe(first.md5[f]);
  });

  it("commit/built_at 只进 version.json：那里六键齐、两次的 built_at 不同（它本该变）", () => {
    expect(Object.keys(first.versionJson)).toEqual(SIX_KEYS);
    expect(String(first.versionJson.commit)).toMatch(/^[0-9a-f]{7,}$/);
    expect(first.versionJson.build).toBe(PINNED_BUILD);
    expect(first.versionJson.version).toBe(PKG_VERSION);
    expect(second.versionJson.built_at).not.toBe(first.versionJson.built_at);
    expect(second.md5["version.json"]).not.toBe(first.md5["version.json"]);
  });

  // 钉子 4：msw worker 不进 dist 根
  it("dist 根不含 mockServiceWorker.js，fonts/ 照常进（不是把整个 public 排掉）", () => {
    expect(first.files).not.toContain("mockServiceWorker.js");
    expect(first.files.some((f) => f.startsWith("fonts/") && f.endsWith(".woff2"))).toBe(true);
    expect(first.files).toContain("index.html");
    expect(first.files).toContain("version.json");
  });

  it("dev 侧照常有 worker：文件仍在 public/（dev server 原样服务），只是构建期剔掉", () => {
    // 选定的形态 = 「留在 public/ + 构建期从 outDir 剔掉」⇒ dev 的 `?mock=*` 零改动。
    // 若将来改成「移出 public/ 由 dev 注入」，这条要连同注入路径一起改（别只删断言）。
    expect(existsSync(resolve(process.cwd(), "public/mockServiceWorker.js"))).toBe(true);
    const probe = probeViteConfig();
    const stripper = probe.plugins.find((p) => /dev-only|msw|worker/i.test(p.name));
    expect(stripper, `剔 dev-only 资产的插件不在配置里：${JSON.stringify(probe.plugins)}`).toBeTruthy();
    expect(stripper?.apply, "必须 apply:build —— dev/serve 下绝不能动 public/").toBe("build");
  });
});
