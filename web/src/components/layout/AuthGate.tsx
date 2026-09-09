import { useEffect } from "react";
import { didExchangeFail, loginUrl, stashReturnHash, useAuth, wasSignedOut } from "../../lib/auth";
import { Icon } from "./Icons";

// 登录门（一步化）：未登录访问不再停在门面页，直接自动跳 Cognito Hosted UI。
// 防循环护栏——以下情形**不**自动跳，停在门面页等用户点按钮：
// 1. 刚登出（sessionStorage agentgate_signed_out=1）：登出回跳若立即再跳登录就是无限循环；
// 2. URL 带 ?code=（exchangeCode 流程中）：正在换 token，跳走会作废授权码；
// 3. exchangeCode 失败（error 态）：坏 code 再自动跳 = 失败→跳→失败死循环。
// 「恢复会话中」中间态由 main.tsx 在 React 渲染前处理（initAuth resolve 前不渲染），
// 静默续期期间根本走不到这里，天然不会误跳。
export default function AuthGate() {
  const { login } = useAuth();
  const signedOut = wasSignedOut();
  const exchangeFailed = didExchangeFail();
  const inCodeExchange = new URLSearchParams(location.search).has("code");
  const autoRedirect = !signedOut && !exchangeFailed && !inCodeExchange;

  useEffect(() => {
    if (!autoRedirect) return;
    let cancelled = false;
    void loginUrl().then((url) => {
      if (!cancelled) {
        // 出发前存深链 hash（stashReturnHash 的注释讲了为什么必须在这一步存：
        // 回跳 URL 是裸 origin，去 Cognito 的瞬间 hash 就丢了）。自动跳转不走
        // login()，所以这里要自己存一份。
        stashReturnHash();
        location.assign(url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [autoRedirect]);

  // 自动跳转中：不渲染门面（闪一下按钮又跳走只会显得卡），给安静的过渡文案
  if (autoRedirect) {
    return (
      <section className="auth-gate" aria-labelledby="authTitle" data-testid="auth-gate">
        <div className="auth-card">
          <div className="auth-brand">
            <svg className="mark" aria-hidden="true"><use href="#i-logo" /></svg>
            <span>Agent<b>Gate</b></span>
          </div>
          <h1 id="authTitle">正在跳转登录…</h1>
          <p role="status" data-testid="auth-redirecting">即将前往安全登录页。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="auth-gate" aria-labelledby="authTitle" data-testid="auth-gate">
      <div className="auth-card">
        <div className="auth-brand">
          <svg className="mark" aria-hidden="true"><use href="#i-logo" /></svg>
          <span>Agent<b>Gate</b></span>
        </div>
        <h1 id="authTitle">{signedOut ? "已退出登录" : "登录 AgentGate"}</h1>
        {/* 默认态那句「登录后管理评估方案、运行记录和质量报告」是产品说明 ⇒ 删；
            只在有状态可说时出一行（prose-sweep 2026-09-03） */}
        {(exchangeFailed || signedOut) && (
          <p>{exchangeFailed ? "登录未完成，请重试。" : "你已安全退出。"}</p>
        )}
        <button
          type="button"
          className="btn auth-sso"
          onClick={() => void login()} // login() 内部先清 signed_out 标记再跳
          data-testid="auth-login"
        >
          <Icon name="lock" />{signedOut ? "重新登录" : "安全登录"}
        </button>
      </div>
    </section>
  );
}
