import { create } from "zustand";

interface SessionState {
  /** Cognito access token（sessionStorage 持久，见 lib/auth.ts） */
  token: string | null;
  /** 当前是否已登录 */
  authed: boolean;
  /**
   * 会话内是否登录过：401 的文案要区分「过期」和「压根没登录」。
   * 对从未登录的用户说「登录已过期」是在为没发生过的事道歉。（旧版 everAuthed）
   */
  everAuthed: boolean;
  /** 认证失效锁：并发 401 只处理一次（旧版 authExpired 幂等语义） */
  authExpired: boolean;
  setSession: (patch: Partial<Pick<SessionState, "token" | "authed" | "everAuthed" | "authExpired">>) => void;
}

// v3-C：全站恒暗（tokens.css 单一暗色主题），theme 状态与
// html[data-theme] 切换机制整体移除。

export const useSession = create<SessionState>((set) => ({
  token: null,
  authed: false,
  everAuthed: false,
  authExpired: false,
  setSession: (patch) => set(patch),
}));
