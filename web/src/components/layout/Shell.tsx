import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useRoute, RouteView } from "../../router";
import { IconSprite } from "./Icons";
import TopNav from "./TopNav";
import SettingsDrawer from "./SettingsDrawer";
import AuthGate from "./AuthGate";
import AuthExpiredBanner from "./AuthExpiredBanner";

// 布局壳：登录门 + 单行顶栏 + 主区 + 设置抽屉挂点（ADR-0016：左侧栏改为顶栏）。
// 登录门语义照旧版：body.is-authed 由 CSS 控制门/壳的互斥显隐。
// 「过期」不关门——旧数据仍可见但配警告条（AuthExpiredBanner），与旧版一致。
export default function Shell() {
  const { authed, everAuthed } = useAuth();
  const route = useRoute();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  // 门的开合 = 「本会话从未成功登录」；登录过期时保持壳可见
  const gateOpen = !authed && !everAuthed;
  useEffect(() => {
    document.body.classList.toggle("is-authed", !gateOpen);
  }, [gateOpen]);

  // 跳过顶栏导航：焦点落到当前视图第一个可聚焦元素（旧版 skipLink 语义）
  const skipToMain = () => {
    const first = mainRef.current?.querySelector<HTMLElement>("button, a, input, select, textarea");
    (first ?? mainRef.current)?.focus?.();
    mainRef.current?.scrollIntoView({ block: "start" });
  };

  // 监控大屏：无壳布局——不渲染顶栏/PageHeader/设置抽屉（挂墙场景零操作）。
  // 登录门语义保留：未登录仍先过门。路由保留可直达（#/bigscreen），只是不在导航里。
  if (route.view === "bigscreen") {
    return (
      <>
        <IconSprite />
        {gateOpen ? <AuthGate /> : <RouteView route={route} />}
      </>
    );
  }

  return (
    <>
      <IconSprite />
      {gateOpen && <AuthGate />}
      <button type="button" className="skip-link" onClick={skipToMain} data-testid="skip-link">
        跳到主要内容
      </button>
      <div className="shell">
        <TopNav route={route} onOpenSettings={() => setSettingsOpen(true)} />
        <main ref={mainRef} tabIndex={-1} data-testid="main">
          <AuthExpiredBanner />
          <RouteView route={route} />
        </main>
      </div>
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
