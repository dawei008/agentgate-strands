import { useEffect, useRef, type ReactNode } from "react";
import "./ConfirmCard.css";

// 玻璃风格确认卡：window.confirm 的全站替代（用户定案：confirm() 全部换玻璃风格确认卡）。
// 语义：居中卡（不是抽屉）；两档按钮（危险动作红色实心 + 取消 ghost）；
// Esc = 取消；mask 点击 = 取消；焦点陷阱进卡内，关闭后焦点还原到触发按钮。
// 焦点陷阱 / Esc / 焦点还原逻辑照抄 components/Drawer.tsx（同款纪律，含
// onCancel 走 ref 不进 effect 依赖——父组件重渲染不得重跑 effect 覆盖 lastFocus）。
// 玻璃纪律：mask 半透明纯色（无 backdrop-filter），卡身实心 --bg2——零新增 blur。
// 受控 API：后续抽屉化批次复用作「脏状态确认」（关抽屉前「有未保存修改，确定丢弃？」）。
export default function ConfirmCard({
  open,
  title,
  body,
  confirmLabel = "确认",
  danger = false,
  initialFocus = "card",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** 初始焦点落点：默认卡自身（陷阱起点）；"cancel" 让不可恢复的危险动作
      默认落在「取消」上——回车/空格误触不会直接执行删除（UI-004）。 */
  initialFocus?: "card" | "cancel";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<Element | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  // initialFocus 只在开卡那一刻读一次（进 ref 不进依赖：与 onCancel 同款纪律，
  // 父组件重渲染不得重跑 effect 覆盖 lastFocus）
  const focusMode = useRef(initialFocus);
  focusMode.current = initialFocus;

  useEffect(() => {
    if (!open) return;
    lastFocus.current = document.activeElement;
    if (focusMode.current === "cancel" && cancelBtnRef.current) cancelBtnRef.current.focus();
    else cardRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { cancelRef.current(); return; }
      // 焦点圈禁：Tab 只在卡内循环（focusables 选择器与 Drawer 一致：
      // disabled 按钮不可聚焦，圈禁把它当端点会让 Tab 卡死）
      if (e.key !== "Tab" || !cardRef.current) return;
      const focusables = cardRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) { e.preventDefault(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === cardRef.current)) {
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

  if (!open) return null;

  return (
    <>
      <div
        className="confirm-mask"
        onClick={onCancel}
        data-testid="confirm-card-mask"
        aria-hidden="true"
      />
      <div
        ref={cardRef}
        className="confirm-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid="confirm-card"
      >
        <h2 className="confirm-card-title">{title}</h2>
        <div className="confirm-card-body">{body}</div>
        <div className="confirm-card-actions">
          <button
            ref={cancelBtnRef}
            type="button"
            className="btn ghost"
            data-testid="confirm-card-cancel"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className={`btn${danger ? " confirm-danger" : ""}`}
            data-testid="confirm-card-ok"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
