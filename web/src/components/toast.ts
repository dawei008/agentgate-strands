// 极简 toast：直接挂 document.body，路由切换不丢（React 树外，navigate 后仍可见）。
//
// 全局机制，住 components/：消费方跨三个页面族（workbench 页、agents 详情动作），
// 另有 lib/runFlight 把它当 notify 通道注入（那里刻意不 import，见 runFlight:155）。
// 此前住 pages/workbench/ 是历史落点（第一个用它的页面）。
// 类名 .wb-toast 与 data-testid="toast" 是 DOM 契约（测试按它们捞元素），搬迁不改；
// 样式在同目录 toast.css（原 workbench.css:55-76 逐字节搬来）。
import "./toast.css";

const TOAST_MS = 2600;

export function showToast(text: string): void {
  const el = document.createElement("div");
  el.className = "wb-toast";
  el.setAttribute("role", "status");
  el.setAttribute("data-testid", "toast");
  el.textContent = text;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), TOAST_MS);
}
