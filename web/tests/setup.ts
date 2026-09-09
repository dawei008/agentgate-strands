import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";

// jsdom 不带 WebCrypto subtle：sha256Hex 依赖 crypto.subtle.digest
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

// jsdom 不实现滚动。⚠️ 两个 API 的缺失形态不同形：`Element.prototype.scrollTo`
// 压根不存在（typeof undefined，代码里 typeof 守卫挡得住），而 `window.scrollTo`
// **是存在的函数**，一调就往 virtualConsole 吐一整段 "Not implemented: window.scrollTo"
// —— typeof 守卫对它是空守卫。报告独立页的正常动线里就会滚（点用例引用、点分节
// 锚点、深链带高亮时自动定位），于是每个报告用例都要吐一段栈，把真错误淹掉。
// 换成 no-op：要断言落点的用例自己装 spy（tests/case-drilldown.test.tsx 的
// stubGeometry / stubScroll），这份全局的只负责闭嘴，不承担任何判据。
window.scrollTo = (() => {}) as typeof window.scrollTo;
