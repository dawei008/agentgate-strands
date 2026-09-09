// 公共抽屉壳的 portal 契约（ADR-0011 Consequences）：
// panel 是 position: fixed，若留在调用处、祖先带 backdrop-filter/filter/
// transform，该祖先会按 CSS 规范劫持 fixed 的 containing block——线上实测
// ReportDrawer 被 .card（玻璃卡）夹扁并被 overflow: hidden 裁剪。
// 修法：mask+panel 一律 createPortal 到 document.body。本文件钉死这个契约，
// 并确认迁出后焦点还原 / Esc / mask 关闭不受影响（React 合成事件在 portal
// 里仍沿 React 树冒泡，原生 keydown 走 document 监听）。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import Drawer from "../src/components/Drawer";

// 复现线上陷阱条件：带 backdrop-filter + overflow: hidden 的玻璃卡祖先
function GlassCardHost({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <div
      className="card"
      data-testid="glass-host"
      style={{ backdropFilter: "blur(16px)", overflow: "hidden" }}
    >
      <button data-testid="trigger">查看报告</button>
      <Drawer open={open} onClose={onClose} label="测试抽屉" testId="portal-drawer">
        <button data-testid="inner-btn">抽屉内按钮</button>
      </Drawer>
    </div>
  );
}

describe("Drawer portal 到 body", () => {
  it("panel 与 mask 挂在 document.body 下，不在玻璃卡祖先内（containing block 不被劫持）", () => {
    render(<GlassCardHost open onClose={() => {}} />);
    const panel = screen.getByTestId("portal-drawer");
    const mask = screen.getByTestId("portal-drawer-mask");
    // 核心断言：DOM 父级就是 body——fixed 定位坐标基准回到视口
    expect(panel.parentElement).toBe(document.body);
    expect(mask.parentElement).toBe(document.body);
    // 反向断言：不再是玻璃卡的后代（否则 overflow: hidden 会裁剪）
    const host = screen.getByTestId("glass-host");
    expect(host.contains(panel)).toBe(false);
    expect(host.contains(mask)).toBe(false);
  });

  it("迁出后关闭行为不坏：Esc 关、mask 点击关（合成事件仍沿 React 树冒泡）", () => {
    const onClose = vi.fn();
    render(<GlassCardHost open onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("portal-drawer-mask"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("迁出后焦点管理不坏：打开聚焦进 panel，关闭还原到触发按钮", () => {
    function GlassCardHostStateful() {
      const [open, setOpen] = useState(false);
      return (
        <div className="card" style={{ backdropFilter: "blur(16px)" }}>
          <button data-testid="trigger" onClick={() => setOpen(true)}>打开</button>
          <Drawer open={open} onClose={() => setOpen(false)} label="测试抽屉" testId="portal-drawer">
            <button data-testid="inner-btn" onClick={() => setOpen(false)}>关闭</button>
          </Drawer>
        </div>
      );
    }
    render(<GlassCardHostStateful />);
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    fireEvent.click(trigger);
    // 打开：焦点进入 panel（panel 自身 tabIndex=-1 接住）
    expect(document.activeElement).toBe(screen.getByTestId("portal-drawer"));
    fireEvent.click(screen.getByTestId("inner-btn"));
    // 关闭：焦点还原到触发按钮（lastFocus 机制跨 portal 依然成立）
    expect(document.activeElement).toBe(trigger);
  });
});
