import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

// 公共右侧抽屉壳（全部抽屉的唯一实现：SettingsDrawer / ReportDrawer / FormDrawer）：
// - mask 点击关闭 / Esc 关闭 / 焦点圈禁（Tab 只在抽屉内循环）/ 关闭后焦点还原
// - 180ms 滑入动画（CSS .drawer-panel），宽度由 width prop 控制
// - mask+panel 经 createPortal 挂到 document.body（ADR-0011）：panel 是
//   position: fixed，若留在调用处、祖先又带 backdrop-filter/filter/transform，
//   按 CSS 规范该祖先会劫持 fixed 的 containing block——线上实测 ReportDrawer
//   被 .card（玻璃卡，backdrop-filter）夹扁并被 overflow: hidden 裁剪。
//   React 合成事件在 portal 里仍沿 React 树冒泡，焦点陷阱/Esc 走 document
//   监听，均不受迁出影响。
// focusables 选择器用 button:not([disabled])——disabled 按钮不可聚焦，
// 圈禁把它当端点会让 Tab 卡死在不可达元素上。
export default function Drawer({
  open,
  onClose,
  width = 600,
  label,
  className = "",
  children,
  testId = "drawer",
  onKeyDown,
}: {
  open: boolean;
  onClose: () => void;
  width?: number;
  label: string;
  className?: string;
  children: ReactNode;
  testId?: string;
  /** 额外按键处理（如 ← → 切换），在 Esc/Tab 处理之外调用 */
  onKeyDown?: (e: KeyboardEvent) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<Element | null>(null);
  // onClose/onKeyDown 走 ref：effect 只依赖 open，父组件重渲染（查询刷新等）
  // 不会重跑 effect（重跑会把 lastFocus 覆盖成抽屉内元素，破坏焦点还原）。
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const extraKeyDown = useRef(onKeyDown);
  extraKeyDown.current = onKeyDown;

  useEffect(() => {
    if (!open) return;
    lastFocus.current = document.activeElement;
    panelRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { closeRef.current(); return; }
      extraKeyDown.current?.(e);
      // 焦点圈禁：Tab 只在抽屉内循环
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) { e.preventDefault(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      (lastFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  return createPortal(
    <>
      <div
        className={`drawer-mask${open ? " open" : ""}`}
        onClick={onClose}
        data-testid={`${testId}-mask`}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className={`drawer-panel${open ? " open" : ""}${className ? ` ${className}` : ""}`}
        style={{ width, maxWidth: "92vw" }}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-hidden={!open}
        tabIndex={-1}
        data-testid={testId}
      >
        {open && children}
      </div>
    </>,
    document.body,
  );
}
