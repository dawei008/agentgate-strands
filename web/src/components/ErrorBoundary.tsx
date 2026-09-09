import { Component, type ErrorInfo, type ReactNode } from "react";
import { navigate } from "../router";

// 渲染期异常的兜底围栏（class 组件——React 没有 hook 版 componentDidCatch）。
//
// 为什么必须有（UI-026）
//   线上点开某个线上评估会话，一个字段形态异常（工具入参是 dict，被当 React
//   child 直渲 → React error #31）就把**整个应用**卸干净：<main> 消失、body
//   只剩空 root，只能刷新恢复。React 的设计就是这样——没有边界的渲染异常会
//   一路冒泡到根并卸载整棵树。所以「修字段」和「加围栏」是两件事，都要做：
//   字段修的是这一次，围栏管的是下一次。
//
// 两级挂载：
//   1) 应用根（App 内，Shell 外）—— 最后一道，任何地方炸都还剩一张可读的卡
//   2) 运行详情页（RouteView 内）—— 页面级降级后**侧栏仍可用**，能走去别处
//
// 玻璃纪律：复用既有 .u-empty 卡面，**不新增任何 backdrop-filter**
//   （全站 blur 预算 10/13，见 tests/glass-guard.test.ts）。

interface Props {
  children: ReactNode;
  /** 降级卡标题，按挂载层级给不同口径 */
  title?: string;
  /** 降级卡 data-testid，便于测试与遥测定位 */
  testId?: string;
  /** console.error 前缀，标明是哪一级围栏接住的 */
  scope?: string;
  /** 是否给「返回评估计划」——页面级给，根级不给（根级连路由都可能不可信） */
  showHome?: boolean;
}

interface State {
  /** 抛出物不一定是 Error（第三方库会抛字符串/对象），所以是 unknown */
  error: unknown;
  /** 有没有抛过——不能靠 error 真假判断，抛 ""/0/null 都是合法抛出物 */
  crashed: boolean;
}

/**
 * 抛出物 → 可读报错原文。**必须**保证返回非空字符串：降级卡的意义就是可诊断，
 * 给出一张写着 "undefined" 或干脆空白的卡等于没兜。
 *
 * 逐种形态都得管，因为抛出物完全不受我们控制：
 *   - `new Error("")` 的 `String()` 是 `"Error"` —— 有字符但零信息，要补说明
 *   - 抛字符串 / 数字：直接可读
 *   - 抛对象：**绝不能**塞进 JSX（那就是 UI-026 本身的错），压成 JSON
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.trim() !== "") return error.message;
    // 空 message：至少把类名给出来，比 "Error" 三个字母多一点线索
    return `${error.name || "Error"}（无报错信息，请看控制台 componentStack）`;
  }
  if (typeof error === "string") {
    return error.trim() !== "" ? error : "未知错误（抛出了空字符串）";
  }
  if (error == null) return "未知错误（抛出了 null/undefined）";
  if (typeof error === "object") {
    try {
      const json = JSON.stringify(error);
      if (json != null && json !== "{}") return `非 Error 抛出物：${json.slice(0, 300)}`;
    } catch {
      /* 循环引用 / BigInt：退到下面的 String() */
    }
    const keys = Object.keys(error as Record<string, unknown>);
    return `非 Error 抛出物（键：${keys.length ? keys.join(", ") : "无"}）`;
  }
  return `非 Error 抛出物：${String(error)}`;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, crashed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, crashed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // 遥测：本仓库没有遥测系统，console.error 就是遥测通道（不引第三方 SDK）。
    // componentStack 是定位「哪个组件的哪个字段」的唯一线索，必须一起记。
    console.error(
      `[ErrorBoundary${this.props.scope ? `:${this.props.scope}` : ""}] 渲染异常已被兜住`,
      error,
      info.componentStack,
    );
  }

  private retry = (): void => {
    this.setState({ error: null, crashed: false });
  };

  render(): ReactNode {
    if (!this.state.crashed) return this.props.children;

    const { title = "这一部分渲染失败了", testId = "error-boundary", showHome } = this.props;
    return (
      <div className="u-empty" data-testid={testId} role="alert">
        <p>{title}</p>
        {/* 可诊断：原始报错原文照给。describeError 保证非空——空 message、
            抛字符串、抛对象都有各自文案，绝不出现空白卡或 "undefined"。 */}
        <p className="sub mono" data-testid={`${testId}-message`}>
          {describeError(this.state.error)}
        </p>
        <button type="button" className="btn ghost" data-testid={`${testId}-retry`} onClick={this.retry}>
          重试
        </button>
        {showHome && (
          <button
            type="button"
            className="btn ghost"
            data-testid={`${testId}-home`}
            onClick={() => {
              // 先复位再跳：不复位的话回到本页仍是降级态
              this.retry();
              navigate("#/workbench");
            }}
            style={{ marginLeft: "var(--sp-2)" }}
          >
            返回评估计划
          </button>
        )}
      </div>
    );
  }
}
