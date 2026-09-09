// 边缘逐对象对拍（edge-parity-verify 批）。
//
// 立项理由原文：发布第 5 步「边缘逐对象核 md5」的**覆盖面恰好等于上传命令的覆盖面**
// ⇒ **判据覆盖面 == 被检查面，缺口永远自证不出来**。实测：`dist/` 根有 7 个对象，
// 其中 `mockServiceWorker.js`（S3 LastModified 08-25 00:43）与 `fonts/*.woff2`
// （08-25 01:59）**从来没走过标准发布流程**，只是恰好没变过才与本地一致；
// `version.json` 若不显式处理会掉进同一个洞（它就是刚多出来的那个）。
//
// ⚠️ `mockServiceWorker.js` **自 build-hygiene-r1 批起不再进 dist**（dev-only 资产，
// 构建期从 outDir 剔掉；钉在 tests/version-stamp.test.ts）。所以本文件的夹具与
// no-cache 名单里都不再有它 —— 覆盖面跟着 dist 走，夹具里留着一个 dist 永远不会有的
// 文件，会让这些断言绿着断言一个已经不存在的世界。
//
// 本文件钉住四件事：
//   1) 覆盖面 = 本地 dist/ 全部文件（`fonts/*` 必须在内 —— 它就是那个躺了一个月的洞）；
//   2) 退出码分档 0/2/3/4 互不相同，且**每档都印一行人类可读判决**
//      （今天两方各踩一次 `cmd | tail; echo $?` 读到管道末端的码 —— 判据只能靠
//      那一行 VERDICT/EXIT 肉眼可读，不能靠调用方接对 `$?`）；
//      **空集不算通过**：dist 不存在/为空/边缘一个响应都取不到 ⇒ 4，不是 0；
//   3) no-cache 两件两种写法都发，且两次都要与本地一致 —— **「两次取样自相矛盾」这一档
//      要印出自己的档名**，正反两颗钉：正 = 矛盾时档名出现且两次 md5（含相符那次）都在；
//      反 = **两次都是旧字节**时档名不出现。缺反向那颗，判据就退化成「怎么都绿」；
//      反向钉必须建在 no-cache 名单里的文件上（名单外只取一次样，这一档结构上不可能出现）；
//   4) 只读纪律：脚本零 aws 写操作，排错提示给的是只读 `aws s3api head-object`，
//      且这段字在 **`--json` 档失败时也要进 stderr**（成功时不进）—— 它原先只挂在人眼分支上。
//
// 形态：起一个**本地假边缘**（node http）代替 CloudFront —— 假边缘缺 key 一律回
// **403**（S3+OAC 没给 ListBucket，真边缘就是 403 而不是 404）。子进程一律用
// 异步 execFile：execFileSync 会把事件循环堵死，进程内的假边缘就永远 accept 不到连接。
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const SCRIPT = resolve(process.cwd(), "scripts/verify-edge.sh");
const SCRIPT_SRC = (): string => readFileSync(SCRIPT, "utf8");
const execFileAsync = promisify(execFile);

type Run = { code: number; stdout: string; stderr: string; all: string };

/**
 * @param env 环境变量覆盖。`undefined` 值表示**删掉**该变量 —— 边缘基址现在从
 *   `$VE_EDGE_BASE` 取，而 execFile 默认继承调用者环境，所以「没配基址」这一档
 *   必须显式删掉它，否则开发者自己 shell 里配了就把这条判据变成绿噪声。
 */
function mergedEnv(over: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...over })) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function run(args: string[], env?: Record<string, string | undefined>): Promise<Run> {
  const opts = {
    encoding: "utf8" as const,
    maxBuffer: 64 * 1024 * 1024,
    ...(env ? { env: mergedEnv(env) } : {}),
  };
  try {
    const { stdout, stderr } = await execFileAsync("bash", [SCRIPT, ...args], opts);
    return { code: 0, stdout, stderr, all: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string };
    const stdout = err.stdout ?? "";
    const stderr = err.stderr ?? "";
    return {
      code: typeof err.code === "number" ? err.code : -1,
      stdout,
      stderr,
      all: stdout + stderr,
    };
  }
}

// ---------- 夹具：本地 dist/ 与假边缘 ----------

/** 真 dist/ 的形状（根对象的代表 + assets/ + fonts/）；值就是字节 */
const DIST_FILES: Record<string, string> = {
  "index.html": '<!doctype html><html><body><script src="/assets/index-DOIGCjQx.js"></script></body></html>\n',
  "version.json": '{"version":"0.10.0","build":"2026.08.26-2","commit":"a2f155b"}\n',
  // 从没走过标准发布流程的那个（本批立项的洞）：
  "fonts/firasans-400.woff2": "wOF2-firasans-400-bytes\n",
  "assets/index-DOIGCjQx.js": "console.log('agentgate');\n",
  "assets/index-DOIGCjQx.js.map": '{"version":3,"sources":[]}\n',
};

const md5 = (s: string): string => createHash("md5").update(s).digest("hex");

const tmps: string[] = [];
const servers: Server[] = [];

function makeDist(files: Record<string, string> = DIST_FILES): string {
  const dir = mkdtempSync(join(tmpdir(), "ve-dist-"));
  tmps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

type Recorded = { path: string; query: string; cacheControl?: string; pragma?: string };
type Edge = { base: string; requests: Recorded[]; close: () => Promise<void> };

/**
 * 假边缘。`files` 里没有的 key 一律 403（不是 404）。
 * 值是数组时按请求次序轮换 —— 用来演「边缘有陈旧副本，两次取到的字节自相矛盾」。
 */
async function startEdge(files: Record<string, string | string[]>): Promise<Edge> {
  const requests: Recorded[] = [];
  const hits: Record<string, number> = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://edge.invalid");
    const key = url.pathname.replace(/^\/+/, "");
    requests.push({
      path: key,
      query: url.search.replace(/^\?/, ""),
      cacheControl: req.headers["cache-control"] as string | undefined,
      pragma: req.headers["pragma"] as string | undefined,
    });
    const entry = files[key];
    if (entry === undefined) {
      // S3 + OAC：没有 ListBucket 权限 ⇒ 缺 key 是 AccessDenied/403
      res.writeHead(403, { "content-type": "application/xml" });
      res.end("<Error><Code>AccessDenied</Code></Error>");
      return;
    }
    const n = (hits[key] = (hits[key] ?? 0) + 1);
    const body = Array.isArray(entry) ? entry[Math.min(n - 1, entry.length - 1)] : entry;
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(Buffer.byteLength(body)),
      etag: `"${md5(body)}"`,
      "x-cache": key.startsWith("assets/") ? "Hit from cloudfront" : "RefreshHit from cloudfront",
    });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

/** 拿一个「确定没人听」的端口：起一个再关掉 */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((ok) => s.close(() => ok()));
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------- 1) 覆盖面 = dist/ 全部文件 ----------

describe("覆盖面：遍历本地 dist/ 全部文件，不是固定三件", () => {
  it("fonts/*.woff2 与 .map 也逐个对拍（判据覆盖面 ≠ 上传命令覆盖面）", async () => {
    const dist = makeDist();
    const edge = await startEdge(DIST_FILES);
    const r = await run(["--dist", dist, "--edge", edge.base]);
    expect(r.all).toContain("VERDICT");
    expect(r.code).toBe(0);
    const asked = new Set(edge.requests.map((q) => q.path));
    for (const rel of Object.keys(DIST_FILES)) expect(asked, rel).toContain(rel);
    expect(r.all).toContain(`${Object.keys(DIST_FILES).length}/${Object.keys(DIST_FILES).length} 一致`);
  });

  it("dist 里多一个文件（新增的 version.json 那类）就多比一个，覆盖面跟着 dist 走", async () => {
    const files = { ...DIST_FILES, "fonts/firacode-400.woff2": "wOF2-firacode\n" };
    const dist = makeDist(files);
    const edge = await startEdge(files);
    const r = await run(["--dist", dist, "--edge", edge.base]);
    expect(r.code).toBe(0);
    expect(new Set(edge.requests.map((q) => q.path))).toContain("fonts/firacode-400.woff2");
    expect(r.all).toContain(`${Object.keys(files).length}/${Object.keys(files).length} 一致`);
  });
});

// ---------- 2) 退出码分档 + 判决印在输出里 ----------

describe("退出码分档：0 全等 / 3 不一致 / 4 一个都没比到 / 2 用法错", () => {
  it("0：全等 —— 判决印出「N/N 一致」", async () => {
    const dist = makeDist();
    const edge = await startEdge(DIST_FILES);
    const r = await run(["--dist", dist, "--edge", edge.base]);
    expect(r.code).toBe(0);
    expect(r.all).toMatch(/VERDICT: 5\/5 一致/);
    expect(r.all).toContain("EXIT: 0");
  });

  it("3：单文件不一致 —— 逐个列出，且点名的就是那个文件", async () => {
    const dist = makeDist();
    const edge = await startEdge({
      ...DIST_FILES,
      "fonts/firasans-400.woff2": "wOF2-STALE-different-bytes\n",
    });
    const r = await run(["--dist", dist, "--edge", edge.base]);
    expect(r.code).toBe(3);
    expect(r.all).toContain("fonts/firasans-400.woff2");
    expect(r.all).toMatch(/VERDICT: 4\/5 一致，1 处不一致/);
    expect(r.all).toContain("EXIT: 3");
    // 只点名坏的那个，不把好的也算成坏的
    expect(r.all).toMatch(/不一致清单/);
    const list = r.all.slice(r.all.indexOf("不一致清单"));
    expect(list).toContain("fonts/firasans-400.woff2");
    expect(list).not.toContain("assets/index-DOIGCjQx.js.map");
  });

  it("3：边缘缺 key 返 403（不是 404）—— 判据是「HTTP 200 且字节一致」，并提示 head-object 分辨没上传 vs 策略错", async () => {
    // 缺的那件挑 fonts/*.woff2：它就是「本地有、边缘从来没走过发布流程」的原型
    const { "fonts/firasans-400.woff2": _font, ...withoutFont } = DIST_FILES;
    const dist = makeDist();
    const edge = await startEdge(withoutFont);
    const r = await run(["--dist", dist, "--edge", edge.base]);
    expect(r.code).toBe(3);
    expect(r.all).toContain("fonts/firasans-400.woff2");
    expect(r.all).toContain("403");
    expect(r.all).toMatch(/403 不是 404|不是 404/);
    expect(r.all).toContain("aws s3api head-object");
    expect(r.all).toMatch(/没上传|未上传/);
    expect(r.all).toMatch(/策略/);
  });

  it("4：dist 为空目录 ⇒ 4 而不是 0（空集不算通过）", async () => {
    const dist = makeDist({});
    const edge = await startEdge(DIST_FILES);
    const r = await run(["--dist", dist, "--edge", edge.base]);
    expect(r.code).toBe(4);
    expect(r.all).toContain("VERDICT: 未比对任何文件 ⇒ 这不是通过");
    expect(r.all).toContain("EXIT: 4");
    expect(edge.requests).toHaveLength(0);
  });

  it("4：dist 目录不存在 ⇒ 4（不是 2、不是 0）", async () => {
    const edge = await startEdge(DIST_FILES);
    const r = await run(["--dist", join(tmpdir(), "ve-nope-does-not-exist"), "--edge", edge.base]);
    expect(r.code).toBe(4);
    expect(r.all).toContain("VERDICT: 未比对任何文件 ⇒ 这不是通过");
  });

  it("4：边缘域名取不到（端口没人听）⇒ 4，一个响应都没有绝不报通过", async () => {
    const dist = makeDist();
    const port = await deadPort();
    const r = await run(["--dist", dist, "--edge", `http://127.0.0.1:${port}`]);
    expect(r.code).toBe(4);
    expect(r.all).toContain("VERDICT: 未比对任何文件 ⇒ 这不是通过");
  });

  it("2：用法错（未知参数 / 参数缺值）", async () => {
    const dist = makeDist();
    expect((await run(["--nope"])).code).toBe(2);
    expect((await run(["--dist"])).code).toBe(2);
    expect((await run(["--edge"])).code).toBe(2);
    expect((await run(["--dist", dist, "extra-positional"])).code).toBe(2);
    const r = await run(["--nope"]);
    expect(r.all).toMatch(/用法|usage/i);
  });

  it("四档退出码互不相同（0/2/3/4 各是各的）", async () => {
    const ok = makeDist();
    const edge = await startEdge(DIST_FILES);
    const c0 = (await run(["--dist", ok, "--edge", edge.base])).code;
    const c2 = (await run(["--nope"])).code;
    const c3 = (await run([
      "--dist",
      ok,
      "--edge",
      (await startEdge({ ...DIST_FILES, "index.html": "<html>stale</html>\n" })).base,
    ])).code;
    const c4 = (await run(["--dist", makeDist({}), "--edge", edge.base])).code;
    expect([c0, c2, c3, c4]).toEqual([0, 2, 3, 4]);
    expect(new Set([c0, c2, c3, c4]).size).toBe(4);
  });
});

// ---------- 3) no-cache 三件的取法 ----------

describe("no-cache 两件：两种绕缓存写法都试，两次都要与本地一致", () => {
  // msw worker 曾是第三件，已不进 dist（build-hygiene-r1）⇒ 名单只剩两件
  const NOCACHE = ["index.html", "version.json"];

  it("每件都发两次：一次带 ?t=<纪元秒>，一次带 Cache-Control: no-cache", async () => {
    const dist = makeDist();
    const edge = await startEdge(DIST_FILES);
    const r = await run(["--dist", dist, "--edge", edge.base]);
    expect(r.code).toBe(0);
    for (const rel of NOCACHE) {
      const qs = edge.requests.filter((q) => q.path === rel);
      expect(qs, rel).toHaveLength(2);
      expect(qs.filter((q) => /^t=\d+$/.test(q.query)), `${rel} 缺 ?t= 写法`).toHaveLength(1);
      expect(
        qs.filter((q) => (q.cacheControl ?? "").includes("no-cache")),
        `${rel} 缺 Cache-Control 写法`,
      ).toHaveLength(1);
    }
  });

  it("immutable 产物（assets/ 与 fonts/）只发一次普通请求（文件名带 hash，没有陈旧风险）", async () => {
    const dist = makeDist();
    const edge = await startEdge(DIST_FILES);
    await run(["--dist", dist, "--edge", edge.base]);
    for (const rel of ["assets/index-DOIGCjQx.js", "fonts/firasans-400.woff2"]) {
      const qs = edge.requests.filter((q) => q.path === rel);
      expect(qs, rel).toHaveLength(1);
      expect(qs[0].query).toBe("");
    }
  });

  // ⚠️ 这一对钉子必须**正反各一**。原来只有一颗，且只断 `code === 3` + 清单点名文件 ——
  // 那两条**普通旧字节**（本文件 185 行那例）同样满足 ⇒ 对「自相矛盾」这一档零判别力。
  // 判别力来自「只有这一档才印的东西」：字面档名、`＝本地`（相符那次的描述，只在这一档进
  // note）、以及 `--json` 的 `contradiction`/`contradictions`。
  const STALE_VERSION = '{"version":"0.9.0","build":"2026.08.25-1"}\n';

  // ⚠️ 轮换夹具的命中计数**跨调用累积**（`hits[key]` 活在 server 上）：同一个假边缘跑第二遍，
  // 第 3/4 次请求会双双被 clamp 到数组末尾 ⇒ 两次同为旧字节，这一档当场消失。所以每跑一遍
  // **各起一个新边缘**。（这条自己踩过：第二遍的「档名不出现」曾像是脚本没印。）
  const contradictingEdge = () =>
    startEdge({
      ...DIST_FILES,
      // 第一次给本地那份，第二次给旧的 —— 只有两种写法都取才抓得到
      "version.json": [DIST_FILES["version.json"], STALE_VERSION],
    });

  it("正：两次取到的字节自相矛盾 ⇒ 3、点名该文件、**印出档名**并列出两次各自的 md5（含相符那次）", async () => {
    const dist = makeDist();
    const edge = await contradictingEdge();
    const r = await run(["--dist", dist, "--edge", edge.base, "--json"]);
    expect(r.code).toBe(3);

    const body = JSON.parse(r.stdout) as {
      contradictions: number;
      files: { path: string; ok: boolean; contradiction: boolean; note: string }[];
    };
    expect(body.contradictions).toBe(1);
    const bad = body.files.filter((f) => !f.ok);
    expect(bad.map((f) => f.path)).toEqual(["version.json"]);
    expect(bad[0].contradiction).toBe(true);
    expect(body.files.every((f) => f.path === "version.json" || !f.contradiction)).toBe(true);

    // 档名要**字面出现**（将来被 grep 的就是这几个词，见 R49）
    expect(bad[0].note).toContain("两次取样自相矛盾");
    // **相符的那一次也要留在 note 里** —— 否则本档与「两次都是旧字节」逐字同形
    expect(bad[0].note).toContain("＝本地");
    expect(bad[0].note).toContain("≠本地");
    expect(bad[0].note).toContain(md5(DIST_FILES["version.json"]));   // 新鲜那次 = 本地
    expect(bad[0].note).toContain(md5(STALE_VERSION));                // 陈旧那次
    expect(bad[0].note).toMatch(/\[qs\]/);
    expect(bad[0].note).toMatch(/\[hdr\]/);
    // ⚠️ 不许据方向下诊断：「两种写法都不进缓存键」那条声明从没在本档被行使过 ⇒
    // note 只描述现象 + 指向排错段，不能给出「补失效」或「重传」这种单一处置
    expect(bad[0].note).toMatch(/不决定处置|见排错段/);

    // 命中时才印的专段（两个输出档都要有）
    expect(r.stderr).toContain("本次命中「两次取样自相矛盾」");

    // 人眼档同样要看得见档名（不是只有 --json 才有）；**换一个新边缘**，见上面那条注释
    const edge2 = await contradictingEdge();
    const human = await run(["--dist", dist, "--edge", edge2.base]);
    expect(human.code).toBe(3);
    expect(edge2.requests.filter((q) => q.path === "version.json")).toHaveLength(2);
    expect(human.all).toContain("两次取样自相矛盾");
    expect(human.all).toContain("本次命中「两次取样自相矛盾」");
    expect(human.all.slice(human.all.indexOf("不一致清单"))).toContain("version.json");
  });

  it("反：**两次都取到旧字节**（同一份陈旧副本）⇒ 仍 3、仍点名，但档名**不出现**", async () => {
    // 形态刻意选 no-cache 名单里的 `version.json`：名单外的文件只取一次样、这一档
    // **结构上不可能出现** ⇒ 拿 `assets/*.js` 写这颗反向钉是「文件形状保证的恒绿」。
    const dist = makeDist();
    const edge = await startEdge({ ...DIST_FILES, "version.json": STALE_VERSION });
    const r = await run(["--dist", dist, "--edge", edge.base, "--json"]);
    expect(r.code).toBe(3);

    const body = JSON.parse(r.stdout) as {
      contradictions: number;
      files: { path: string; ok: boolean; contradiction: boolean; note: string }[];
    };
    // 两次取样都发了（不是「少取一次所以矛盾不了」）
    expect(edge.requests.filter((q) => q.path === "version.json")).toHaveLength(2);
    expect(body.contradictions).toBe(0);
    const bad = body.files.filter((f) => !f.ok);
    expect(bad.map((f) => f.path)).toEqual(["version.json"]);
    expect(bad[0].contradiction).toBe(false);
    expect(bad[0].note).not.toContain("两次取样自相矛盾");
    expect(bad[0].note).not.toContain("＝本地");
    // 该说的还得说：这一档是普通旧字节，两次各自都要报「≠ 本地」
    expect(bad[0].note).toContain(md5(STALE_VERSION));
    expect(bad[0].note).toMatch(/\[qs\][^；]*≠/);
    expect(bad[0].note).toMatch(/\[hdr\][^；]*≠/);

    // 档名在**整个输出**里都不许出现：它原先写在通用排错段里 ⇒ 普通旧字节也带着这几个字，
    // 「档名出现」于是不等价于「这一档命中」。这颗钉就是那条等价性本身。
    expect(r.stderr).not.toContain("两次取样自相矛盾");
    const human = await run(["--dist", dist, "--edge", edge.base]);
    expect(human.code).toBe(3);
    expect(human.all).not.toContain("两次取样自相矛盾");
    expect(human.all).toContain("aws s3api head-object");   // 通用排错段照旧给（只是不带档名）
    expect(human.all.slice(human.all.indexOf("不一致清单"))).toContain("version.json");
  });

  it("注释写明实测结论：两种写法在本分发都不真绕过，新鲜靠源端 no-cache 回源 revalidate", () => {
    const src = SCRIPT_SRC();
    expect(src).toMatch(/QueryStringBehavior|查询串不进缓存键/);
    expect(src).toMatch(/RefreshHit/);
    expect(src).toMatch(/不绕过/);
    expect(src).toMatch(/create-invalidation/);   // 唯一真能强刷的手段（写操作，本脚本不做）
  });
});

// ---------- 4) 参数、机器可读输出、只读纪律 ----------

describe("参数与默认值", () => {
  it("--dist 默认 web/dist（相对脚本位置解析）", () => {
    const src = SCRIPT_SRC();
    expect(src).toMatch(/\.\.\/dist|web\/dist/);
    expect(src).toMatch(/SCRIPT_DIR/);
  });

  // 脱敏钉子（仓库要同步到 GitHub）：分发域名/分发 ID/账号 ID 都是某个具体 AWS
  // 账号的坐标，一个都不许回到脚本里。**这条是禁止型约束**，所以下面紧跟一条
  // 阳性对照——否则「没搜到」和「搜法写错」长得一模一样。
  it("脚本源码里没有任何真实部署坐标（分发域名 / 分发 ID / 12 位账号 ID）", () => {
    const src = SCRIPT_SRC();
    expect(src).not.toMatch(/[a-z0-9]+\.cloudfront\.net/);
    expect(src).not.toMatch(/\bE[A-Z0-9]{12,}\b/);
    expect(src).not.toMatch(/\b\d{12}\b/);
  });

  it("阳性对照：同样的三条正则在含真值的样本串上必须命中（证明搜法有效）", () => {
    const sample =
      "https://dabcdefg1234.cloudfront.net 分发 EABCDEFGH1234 账号 123456789012";
    expect(sample).toMatch(/[a-z0-9]+\.cloudfront\.net/);
    expect(sample).toMatch(/\bE[A-Z0-9]{12,}\b/);
    expect(sample).toMatch(/\b\d{12}\b/);
  });

  it("既没给 --edge 也没配 VE_EDGE_BASE ⇒ 2，且点名 VE_EDGE_BASE 与现算法", async () => {
    const r = await run(["--dist", makeDist()], { VE_EDGE_BASE: undefined });
    expect(r.code).toBe(2);
    expect(r.all).toContain("VE_EDGE_BASE");
    expect(r.all).toMatch(/describe-stacks/);
    expect(r.all).toMatch(/\.env\.example|\.env\.local/);
  });

  it("--help 在没配 VE_EDGE_BASE 时仍退 0（缺基址的检查必须在参数解析之后）", async () => {
    const r = await run(["--help"], { VE_EDGE_BASE: undefined });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/用法/);
  });

  it("VE_EDGE_BASE 真被用上：不给 --edge 也能比出 0（不只是「不报错」）", async () => {
    const dist = makeDist();
    const edge = await startEdge(DIST_FILES);
    const r = await run(["--dist", dist], { VE_EDGE_BASE: edge.base });
    expect(r.code).toBe(0);
    expect(r.all).toMatch(/VERDICT/);
  });

  it("--edge 优先于 VE_EDGE_BASE（显式参数压环境变量）", async () => {
    const dist = makeDist();
    const edge = await startEdge(DIST_FILES);
    // 环境变量指向一个不存在的端口：若它被采用，一个响应都取不到 ⇒ 4
    const r = await run(["--dist", dist, "--edge", edge.base], {
      VE_EDGE_BASE: "http://127.0.0.1:1",
    });
    expect(r.code).toBe(0);
  });

  it("--json：stdout 是可解析 JSON（人类判决走 stderr，不污染机器输出）", async () => {
    const dist = makeDist();
    const edge = await startEdge({ ...DIST_FILES, "index.html": "<html>stale</html>\n" });
    const r = await run(["--dist", dist, "--edge", edge.base, "--json"]);
    expect(r.code).toBe(3);
    const body = JSON.parse(r.stdout) as {
      exit: number;
      verdict: string;
      total: number;
      ok: number;
      failed: number;
      checked: number;
      dist: string;
      edge: string;
      files: { path: string; ok: boolean; probes: { http: string }[] }[];
    };
    expect(body.exit).toBe(3);
    expect(body.total).toBe(Object.keys(DIST_FILES).length);
    expect(body.ok).toBe(body.total - 1);
    expect(body.failed).toBe(1);
    expect(body.verdict).toMatch(/一致/);
    expect(body.files.filter((f) => !f.ok).map((f) => f.path)).toEqual(["index.html"]);
    expect(body.files).toHaveLength(body.total);
    expect(body.files[0].probes.length).toBeGreaterThan(0);
    expect(r.stderr).toContain("VERDICT");
  });

  // ⚠️ 这颗钉断的是 stderr 的**内容**，不是「有输出」：`--json` 是用法里写着的路径，
  // 排错段原先只挂在人眼分支上 ⇒ 走 `--json` 的人拿到 rc 和一句判决，那段字一次都没见过。
  // 成功那半也要断（不含），否则「成功时不污染 json 用法」这一半从没被行使。
  it("--json 失败 ⇒ stderr 带排错段（head-object）；--json 成功 ⇒ 不带（两半都钉）", async () => {
    const dist = makeDist();

    const stale = await startEdge({ ...DIST_FILES, "index.html": "<html>stale</html>\n" });
    const bad = await run(["--dist", dist, "--edge", stale.base, "--json"]);
    expect(bad.code).toBe(3);
    expect(bad.stderr).toContain("aws s3api head-object");
    expect(bad.stderr).toMatch(/403 不是 404|不是 404/);
    expect(bad.stderr).toContain("EXIT: 3");
    JSON.parse(bad.stdout);                      // 排错段进 stderr，不许污染 stdout
    expect(bad.stdout).not.toContain("head-object");

    // 4 档（空集）同样要给排错段 —— 它也是失败
    const empty = await run(["--dist", makeDist({}), "--edge", stale.base, "--json"]);
    expect(empty.code).toBe(4);
    expect(empty.stderr).toContain("aws s3api head-object");

    const good = await startEdge(DIST_FILES);
    const ok = await run(["--dist", dist, "--edge", good.base, "--json"]);
    expect(ok.code).toBe(0);
    expect(ok.stderr).toContain("VERDICT");      // 判决照旧印
    expect(ok.stderr).toContain("EXIT: 0");
    expect(ok.stderr).not.toContain("head-object");
  });

  it("--json 在 4 档也是合法 JSON（空集要能被机器读成不通过）", async () => {
    const edge = await startEdge(DIST_FILES);
    const r = await run(["--dist", makeDist({}), "--edge", edge.base, "--json"]);
    expect(r.code).toBe(4);
    const body = JSON.parse(r.stdout) as { exit: number; total: number; files: unknown[] };
    expect(body.exit).toBe(4);
    expect(body.total).toBe(0);
    expect(body.files).toEqual([]);
  });
});

describe("只读纪律：脚本一个写操作都没有", () => {
  it("零 aws 写操作 / 不 sync / 不 cp / 不建失效", () => {
    // 只看**可执行行**：整行注释里出现「本脚本刻意不做 create-invalidation」是说明，
    // 不是调用；真要偷偷写操作只能写在非注释行上（含字符串里的命令）。
    const src = SCRIPT_SRC()
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    const forbidden = [
      /aws\s+s3\s+sync/,
      /aws\s+s3\s+cp/,
      /aws\s+s3\s+rm/,
      /aws\s+s3\s+mv/,
      /aws\s+s3api\s+(put|delete|copy)-/,
      /aws\s+cloudfront\s+create-invalidation/,
      /aws\s+cloudformation\s+(deploy|update|create|delete)/,
      /cdk\s+deploy/,
    ];
    for (const re of forbidden) expect(src, String(re)).not.toMatch(re);
  });

  it("排错提示给的是只读的 aws s3api head-object", () => {
    expect(SCRIPT_SRC()).toMatch(/aws s3api head-object/);
  });

  it("脚本头注释写明只读 + 立项理由（判据覆盖面 == 被检查面）+ msw 已不进 dist", () => {
    const head = SCRIPT_SRC().split("\n").slice(0, 60).join("\n");
    expect(head).toMatch(/只读/);
    expect(head).toMatch(/覆盖面/);
    // msw worker 那段历史留着（它是立项证据之一），但必须同时写明「现在不进 dist」，
    // 否则读者会以为它还在覆盖面里；边缘残留清理归发布通道，这里只读
    expect(head).toMatch(/mockServiceWorker\.js/);
    expect(head).toMatch(/不再进 dist/);
    expect(head).toMatch(/残留/);
  });
});
