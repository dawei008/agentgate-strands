/// <reference types="vite/client" />

// 构建期注入的版本戳（vite.config.ts 的 version-stamp 插件，只在 build 生效）。
// **只允许 src/lib/version.ts 读这两个常量**（tests/version-stamp.test.ts 静态守）——
// 散装读魔法常量意味着每个调用点都要自己想回落，版本口径会分叉。
// 只有这两个：commit 与构建时刻**不进 bundle**（每个 commit / 每次构建都变，会废掉
// 「零 src 改动 ⇒ 产物逐字节不变」判据），它们只在运行时的 /version.json 里。
declare const __APP_VERSION__: string;   // 语义化版本（权威 = web/package.json），如 0.9.0
declare const __APP_BUILD__: string;     // 构建号 YYYY.MM.DD-N（UTC），如 2026.08.26-1
