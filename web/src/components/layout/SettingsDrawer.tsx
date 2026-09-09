import { Icon } from "./Icons";
import Drawer from "../Drawer";
import { useAuth } from "../../lib/auth";
import {
  JudgeConfigSection,
  PricesSection,
  CacheSection,
} from "../settings";

// 设置抽屉：右侧滑入 180ms。壳职责（开关动画 / Esc 关闭 / 焦点圈禁 /
// 关闭后焦点还原）统一走公共 components/Drawer.tsx；本组件只负责内容：
// 抽屉头 + 账户行 + 三分节（components/settings/）：评估模型 / 模型单价 / 结果缓存。
// 分节住 components/ 而不是 pages/：设置没有路由（router.tsx:15 明示它只是抽屉），
// 叫「页」名不副实，而 components 树里唯一的向上依赖也就此消掉（L8）。
// 分节 open 时才挂载（壳的 children 门），避免抽屉关着也发请求。
//
// 账户行（当前账户 / 登录态 / 登录·退出）原住侧栏底部；顶栏（ADR-0016 nav-b）
// 只留一个头像按钮，点开就是这里 —— 账户动作与设置同一张抽屉。
export default function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { authed, authExpired, login, logout } = useAuth();
  const who = authExpired ? "登录已过期" : authed ? "已登录" : "未登录";
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={420}
      label="设置"
      className="settings-drawer"
      testId="settings-drawer"
    >
      <div className="drawer-head">
        <h2>设置</h2>
        <button
          type="button"
          className="btn ghost mini"
          onClick={onClose}
          aria-label="关闭设置"
          data-testid="settings-drawer-close"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="drawer-body">
        <div className="account-row" data-testid="account-row">
          <span className="account-meta">
            <span className="account-label">当前账户</span>
            <span className="account-who" data-testid="account-who">{who}</span>
          </span>
          <span className="account-actions">
            {authed ? (
              <button
                type="button"
                className="btn ghost mini"
                onClick={() => void logout()}
                data-testid="account-logout"
              >
                <Icon name="logout" />退出登录
              </button>
            ) : (
              <button
                type="button"
                className="btn mini"
                onClick={() => void login()}
                data-testid="account-login"
              >
                登录
              </button>
            )}
          </span>
        </div>
        <JudgeConfigSection />
        <PricesSection />
        <CacheSection />
      </div>
    </Drawer>
  );
}
