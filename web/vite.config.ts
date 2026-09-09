import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 静默跑命令；失败（不在 git 里 / 命令缺失）→ 空串，由调用方回落 */
function quiet(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// ---- 版本戳（语义化为主 + 构建号为辅：`v0.9.0 · 2026.08.26-1`）----
// 语义化版本**唯一权威 = web/package.json 的 version**（发布通道按批次分类在
// 构建前 bump：功能批 minor / 修复·杂务批 patch）；构建号 = YYYY.MM.DD-N（UTC）。
// 双身份：编译期身份进 bundle，运行时系统身份在 dist/version.json。
// 构建号取值优先级：环境变量 RELEASE_ID > scripts/release-version.sh 现算 > dev。
//
// ⚠️ **只有 semver 与构建号进 bundle**（发布内稳定的两个）。`commit`/`built_at`
// 只进 version.json：前者每个 commit 变（含合流 commit 本身）、后者每次构建变，
// define 进 bundle 就让「零 src 改动 ⇒ 产物逐字节不变」这条在用判据对**所有会产生
// commit 的批次**结构性失效（build-hygiene-r1 批修回；立项见
// .scratch/triage-r1/issues/bundle-byte-stability-vs-version-stamp.md）。
// 代价已认：拉不到 version.json 时界面只降级显示 semver·构建号，不伪造那两项。
type Stamp = {
  version: string;
  build: string;
  commit: string;
  built_at: string;
  ui_build: string | null;
  runtime_version: string | null;
};

/**
 * 显式读 package.json 取语义化版本。
 * **刻意不用 `process.env.npm_package_version`** —— 它只在 `npm run` 下存在，
 * 直接 `vite build` 或从 bash 调时是静默 undefined，版本号会变成空串跟着发上线。
 * 读不到 / 形状不对 → **构建失败**（抛），绝不回落成空：没有版本号比错版本号好查。
 */
export function readPackageVersion(file: string = path.join(here, "package.json")): string {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`版本戳：读不到 ${file}（语义化版本唯一权威）：${String(e)}`);
  }
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version.trim())) {
    throw new Error(`版本戳：${file} 的 version 不是语义化版本（读到 ${JSON.stringify(version)}）`);
  }
  return version.trim();
}

function resolveStamp(): Stamp {
  const build = process.env.RELEASE_ID?.trim()
    || quiet("bash", [path.join(here, "scripts/release-version.sh")])
    || "dev";
  return {
    version: readPackageVersion(),
    build,
    commit: quiet("git", ["rev-parse", "--short", "HEAD"]) || "unknown",
    built_at: new Date().toISOString(),
    // web 构建时 ui_build == build；纯 Runtime 发布只跑 release-version.sh
    // --write-json，那条路径沿用旧 ui_build（dist 没重建 → UI 构建号合法落后）。
    ui_build: build,
    runtime_version: process.env.RUNTIME_VERSION?.trim() || null,
  };
}

/**
 * 版本戳插件（**只在 build 生效**）：
 *  · config 钩子注入编译期身份**两个**常量（semver + 构建号；commit/built_at 不注入，
 *    理由见上面的版本戳段落）。dev server / vitest 刻意**不注入**
 *    （插件被 apply:"build" 挡掉）→ src/lib/version.ts 走 dev 回落：视觉基线
 *    与单测断言就不会随日期漂（否则每天所有含侧栏的截图都变）。
 *  · generateBundle 往产物根 emit version.json —— 发布后
 *    `curl https://<edge>/version.json` 即可核现网版本。刻意不用构建后的外部
 *    拷贝脚本：发布流程只 sync dist/，后置拷贝漏调用就静默失效，而版本核验
 *    手段本身不能有静默失效模式；也刻意不放 public/（那是受版本控制的原样文件，
 *    等于把版本号写死进仓库，装不了构建期 id）。
 */
function versionStamp(): Plugin {
  let stamp: Stamp | null = null;
  return {
    name: "version-stamp",
    apply: "build",
    config() {
      stamp = resolveStamp();
      return {
        // 这里**只能**放每次发布内稳定的值：多注入一个每次都变的量，
        // 「src 不变 ⇒ 产物字节不变」就又废了（tests/version-stamp.test.ts 钉住）
        define: {
          __APP_VERSION__: JSON.stringify(stamp.version),
          __APP_BUILD__: JSON.stringify(stamp.build),
        },
      };
    },
    generateBundle() {
      const s = stamp ?? resolveStamp();
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify(s, null, 2)}\n`,
      });
    },
  };
}

/**
 * dev-only 的 public/ 资产不进产物（build-hygiene-r1 批；立项见
 * .scratch/triage-r1/issues/msw-worker-ships-to-prod.md）。
 *
 * `public/mockServiceWorker.js`（9666 B）此前被 vite 原样拷进 dist 随站点发到 CDN。
 * 没有功能/安全影响（worker 不含夹具数据，prod 分支不 `worker.start()`，main.tsx 的
 * `import.meta.env.DEV` 闸门拦住 handlers），但它是 dev 工具链的东西，发上线属构建
 * 卫生问题。**别再说「MSW 不进生产包」** —— 在这条修好之前它进包，只是没人注册。
 *
 * 形态选择：**文件留在 public/（dev server 照常原样服务 `/mockServiceWorker.js`），
 * 只在构建期从 outDir 剔掉**。`?mock=*` 那套（全仓测试与视觉基线的地基）零改动，
 * `msw.workerDirectory` 也不用改 —— 换成「移出 public/ 由 dev 注入」就得同时维护一条
 * 注入路径，风险不对等。
 *
 * 时机：vite 是在 `prepareOutDir`（rollup 写产物**之前**）就把 publicDir 整目录拷进
 * outDir 的，所以任何 emit 阶段的过滤都拦不住它 —— 只能在产物落盘后删。用
 * `closeBundle`（`writeBundle` 之后）+ `force:true`：顺带把上一次构建残留的那份也清掉。
 */
function stripDevOnlyPublicAssets(): Plugin {
  const DEV_ONLY = ["mockServiceWorker.js"];
  let outDir = path.join(here, "dist");
  return {
    name: "strip-dev-only-public-assets",
    apply: "build",
    configResolved(config) {
      // build.outDir 相对 root 解析；resolve 对已是绝对路径的值是恒等的，两种都兜住
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const name of DEV_ONLY) rmSync(path.join(outDir, name), { force: true });
    },
  };
}

// dev-only：模拟 Cognito Hosted UI 的「导航型」端点。
// MSW 的 service worker 拦不到顶层导航（authorize/logout 是整页跳转），
// 这两个端点必须由 dev server 用真 302 兜；token 交换是 fetch，仍走 MSW。
function mockCognitoNavigation(): Plugin {
  return {
    name: "mock-cognito-navigation",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/mock-cognito/oauth2/authorize") {
          const redirect = url.searchParams.get("redirect_uri") ?? "/";
          res.statusCode = 302;
          res.setHeader("Location", `${redirect}/?code=mock-auth-code`);
          res.end();
          return;
        }
        if (url.pathname === "/mock-cognito/logout") {
          res.statusCode = 302;
          res.setHeader("Location", url.searchParams.get("logout_uri") ?? "/");
          res.end();
          return;
        }
        next();
      });
    },
  };
}

// 旧版 ui/ 是单文件无构建；React 版用 Vite。产物仍是纯静态资源，
// 部署链路（CloudFront + S3 OAC）不变。
export default defineConfig({
  // agent worktree 的 web/node_modules 是指向主树的软链，vite/vitest 默认
  // cacheDir(node_modules/.vite) 会让所有树读写同一份缓存：依赖预打包互相
  // 覆盖、vitest 转译缓存跨树复用（A 树改动被 B 树缓存掩盖 → 假绿）。
  // import.meta.url 解析出的是配置文件真实所在树的 web/（不被软链带走），
  // 所以这个 cacheDir 天然每棵树一份。vitest 缓存放 <cacheDir>/vitest，同步隔离。
  cacheDir: path.resolve(here, ".vite-cache"),
  plugins: [react(), mockCognitoNavigation(), versionStamp(), stripDevOnlyPublicAssets()],
  build: {
    outDir: "dist",
    sourcemap: true,
    // recharts chunk 本身 ~512KB（已是独立缓存单元，不再拆），512 > 默认 500 警戒线
    chunkSizeWarningLimit: 550,
    rollupOptions: {
      output: {
        // recharts（含 d3 系依赖）~450KB，只有趋势卡用——拆独立 chunk，
        // 主包回到 500KB 警戒线内，且图表库缓存不随业务代码失效。
        manualChunks: { recharts: ["recharts"] },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    globals: true,
  },
});
