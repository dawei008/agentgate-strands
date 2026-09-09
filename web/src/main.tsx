import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
// 组件样式层（B 案形态：按钮/徽章/表格/卡片/KPI）。必须在 base.css 之后引入——
// 二者都定义 .btn，同特异性下后者胜出，ui.css 才能接管按钮形态。
import "./styles/ui.css";
import App from "./App";
import { initAuth } from "./lib/auth";

async function bootstrap(): Promise<void> {
  // 「恢复会话中」中间态：initAuth 可能要走 refresh_token 静默续期（一次网络往返），
  // 期间不渲染 React——既不闪登录门也不闪壳，只显示一个安静的占位。
  const root = document.getElementById("root")!;
  root.innerHTML =
    '<div data-testid="auth-restoring" role="status" aria-label="恢复会话中"' +
    ' style="position:fixed;inset:0;display:grid;place-items:center;color:var(--faint,#7D8CA3);font-size:13px">' +
    "恢复会话中…</div>";
  // dev 模式：MSW 拦截 config.json / API / token 交换，前端可脱离后端联调
  if (import.meta.env.DEV) {
    const { worker } = await import("./mocks/browser");
    await worker.start({ onUnhandledRequest: "bypass" });
  }
  // 与旧版模块顶层 initAuth 等价：首帧渲染前完成 ?code= 交换与 token 恢复
  // （含静默续期），避免「先闪登录门再跳已登录」的双态闪烁。
  await initAuth();
  root.innerHTML = ""; // 移除恢复占位，交给 React
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
