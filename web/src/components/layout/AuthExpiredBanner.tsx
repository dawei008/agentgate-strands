import { useAuth } from "../../lib/auth";
import { Icon } from "./Icons";

// 认证过期全局警告条（旧版 showAuthBanner 语义：role=alert + 重新登录按钮）。
// 只在「登录过且过期」时出现；从未登录的用户走 AuthGate，不看到这条。
export default function AuthExpiredBanner() {
  const { authExpired, login } = useAuth();
  if (!authExpired) return null;
  return (
    <div className="authbanner" role="alert" data-testid="auth-expired-banner">
      <Icon name="warn" />
      <span style={{ flex: 1 }}>登录已过期，当前显示的数据可能不是最新。</span>
      <button
        type="button"
        className="btn mini"
        onClick={() => void login()}
        data-testid="auth-relogin"
      >
        重新登录
      </button>
    </div>
  );
}
