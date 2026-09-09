// 渲染异常围栏测试（UI-026 的结构性缺口）。
//
// 事故形态：线上点开一个线上评估会话，一个字段形态异常（工具入参是 dict 被当
// React child 直渲 → React error #31）就把**整个应用**卸干净——<main> 消失、
// body 只剩空 root、只能刷新。React 的设计如此：没有边界的渲染异常一路冒泡到
// 根并卸载整棵树。所以「修字段」与「加围栏」是两件事：字段修这一次，围栏管下一次。
//
// ⚠️ 围栏本身的风险：它会把真异常吃掉，让测试静默变绿。所以这里**每一条**都
// 断言了「异常确实被抛出并被记录」（console.error 收到 error 实例 +
// componentStack），而不是只断言「页面没崩」。业务测试那侧的对策是反向断言
// ——断言围栏 testid **不出现**（见 run-detail.test.tsx 的逐会话点击用例）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { expectProseGone } from "./prose";
import type { ReactElement } from "react";
import ErrorBoundary, { describeError } from "../src/components/ErrorBoundary";

/** 受控爆炸组件：boom=true 时在渲染期抛。
 *  ⚠️ 不用 `thrown ?? 默认值` —— 那会把「抛 null」这条用例悄悄换成抛 Error，
 *  测试就照不到 state.error 为假值的分支（曾把这条测成假绿）。用键存在性判断。 */
function Boom(props: { boom: boolean; thrown?: unknown }): ReactElement {
  if (props.boom) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw "thrown" in props ? props.thrown : new Error("arguments 是 dict，被当 React child 直渲");
  }
  return <p data-testid="happy">正常内容</p>;
}

/** 复刻线上那一次的报错原文（React error #31） */
const REACT_31 = "Objects are not valid as a React child (object with keys {summary})";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React 自己也会往 console.error 打一份；这里只做静音 + 记录，不改行为
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  location.hash = "#/run/plan-aaa111%232026-08-11T09%3A00%3A00Z";
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 取出围栏自己打的那一条遥测（区别于 React 的默认报错日志） */
function boundaryLogs(): unknown[][] {
  return errorSpy.mock.calls.filter((c) => String(c[0]).startsWith("[ErrorBoundary"));
}

describe("ErrorBoundary 兜住渲染异常", () => {
  it("子树抛错 → 显示可诊断降级卡（标题 + 报错原文 + 重试），不是空白", () => {
    render(
      <ErrorBoundary testId="eb" title="这条明细渲染失败了">
        <Boom boom thrown={new Error(REACT_31)} />
      </ErrorBoundary>,
    );
    const card = screen.getByTestId("eb");
    expect(card).toHaveTextContent("这条明细渲染失败了");
    // 「数据本身没有丢失，重试即可重新渲染；若反复失败，请把上面这行报错原文反馈给我们」
    // 对任何崩溃恒成立 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(card, "重试即可重新渲染", "反馈给我们");
    // 可诊断：报错原文照给（线上就是靠这行才知道是 {summary}）
    expect(within(card).getByTestId("eb-message")).toHaveTextContent(REACT_31);
    expect(within(card).getByTestId("eb-retry")).toBeInTheDocument();
    // 降级卡不是空白板：必须有实际文本
    expect((card.textContent ?? "").trim().length).toBeGreaterThan(10);
    // 无障碍：降级是需要被念出来的状态变化
    expect(card).toHaveAttribute("role", "alert");
    // 正常内容确实没渲染出来（证明异常真的发生了，不是这条测试自己假绿）
    expect(screen.queryByTestId("happy")).toBeNull();
  });

  it("记录遥测：console.error 收到 scope 前缀 + error 实例 + componentStack", () => {
    render(
      <ErrorBoundary testId="eb" scope="run-detail:right-pane">
        <Boom boom thrown={new Error(REACT_31)} />
      </ErrorBoundary>,
    );
    const logs = boundaryLogs();
    // 这条断言就是「围栏没把异常静默吃掉」的凭据
    expect(logs).toHaveLength(1);
    const [prefix, err, stack] = logs[0];
    expect(String(prefix)).toContain("[ErrorBoundary:run-detail:right-pane]");
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(REACT_31);
    // componentStack 是定位「哪个组件的哪个字段」的唯一线索
    expect(String(stack)).toContain("Boom");
  });

  it("重试：修好数据后点重试恢复正常内容（不必刷新整页）", () => {
    function Host({ boom }: { boom: boolean }) {
      return (
        <ErrorBoundary testId="eb">
          <Boom boom={boom} />
        </ErrorBoundary>
      );
    }
    const { rerender } = render(<Host boom />);
    expect(screen.getByTestId("eb")).toBeInTheDocument();
    // 数据侧恢复（等价于换选一个正常会话），再点重试
    rerender(<Host boom={false} />);
    fireEvent.click(screen.getByTestId("eb-retry"));
    expect(screen.getByTestId("happy")).toBeInTheDocument();
    expect(screen.queryByTestId("eb")).toBeNull();
  });

  it("重试后仍失败：降级卡还在，不进死循环白屏", () => {
    render(
      <ErrorBoundary testId="eb">
        <Boom boom />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByTestId("eb-retry"));
    expect(screen.getByTestId("eb")).toBeInTheDocument();
    // 两次渲染都记了遥测——重试失败也要留痕
    expect(boundaryLogs().length).toBeGreaterThanOrEqual(2);
  });

  it("showHome：点「返回工作台」跳 #/workbench（页面级围栏才给）", () => {
    render(
      <ErrorBoundary testId="eb" showHome>
        <Boom boom />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByTestId("eb-home"));
    expect(location.hash).toBe("#/workbench");
  });

  it("不给 showHome 时没有「返回工作台」（根级围栏连路由都不可信）", () => {
    render(
      <ErrorBoundary testId="eb">
        <Boom boom />
      </ErrorBoundary>,
    );
    expect(screen.queryByTestId("eb-home")).toBeNull();
    expect(screen.getByTestId("eb-retry")).toBeInTheDocument();
  });

  it("空 message：不给「Error」这种零信息文案，补上排查指引", () => {
    // String(new Error("")) === "Error" —— 有字符但零信息，等于空白卡
    render(
      <ErrorBoundary testId="eb1">
        <Boom boom thrown={new Error("")} />
      </ErrorBoundary>,
    );
    const msg = screen.getByTestId("eb1-message");
    expect(msg).toHaveTextContent("无报错信息");
    expect(msg).toHaveTextContent("componentStack");
    expect(msg.textContent).not.toBe("Error");
  });

  it("非 Error 抛出物（字符串 / 对象 / null）：都给得出文案，绝不空白或 undefined", () => {
    // 抛字符串（第三方库常干的事）
    render(
      <ErrorBoundary testId="eb2">
        <Boom boom thrown={"手写字符串异常"} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("eb2-message")).toHaveTextContent("手写字符串异常");

    // 抛对象：降级卡自己**绝不能**再犯同一个错（把对象塞进 JSX）
    render(
      <ErrorBoundary testId="eb3">
        <Boom boom thrown={{ summary: "对象抛出物" }} />
      </ErrorBoundary>,
    );
    const msg3 = screen.getByTestId("eb3-message");
    expect(msg3).toHaveTextContent("对象抛出物");
    expect(msg3.textContent).not.toContain("[object Object]");
    expect(msg3.textContent).not.toContain("undefined");

    // 抛 null：state.error 为假值也必须显示降级卡（不能靠 error 真假判 crashed）
    render(
      <ErrorBoundary testId="eb4">
        <Boom boom thrown={null} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("eb4")).toBeInTheDocument();
    expect(screen.getByTestId("eb4-message")).toHaveTextContent("null/undefined");
    expect(screen.queryByTestId("happy")).toBeNull();
  });

  it("describeError 对任意抛出物都返回非空字符串", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const thrown: unknown[] = [
      new Error("x"), new Error(""), new TypeError(""), "s", "", 0, NaN,
      null, undefined, {}, { a: 1 }, [1, 2], cyclic, Symbol("s"),
    ];
    for (const v of thrown) {
      const out = describeError(v);
      expect(typeof out, `describeError(${String(v)}) 必须返回 string`).toBe("string");
      expect(out.trim(), `describeError(${String(v)}) 不许为空`).not.toBe("");
      expect(out).not.toContain("[object Object]");
    }
  });

  it("正常时完全透明：不加任何包装节点、不打日志", () => {
    const { container } = render(
      <ErrorBoundary testId="eb">
        <p data-testid="happy">正常内容</p>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("happy")).toBeInTheDocument();
    expect(screen.queryByTestId("eb")).toBeNull();
    expect(container.firstElementChild?.tagName).toBe("P");
    expect(boundaryLogs()).toHaveLength(0);
  });

  it("玻璃纪律：降级卡复用既有实心 .u-empty 卡面，不带 blur 类", () => {
    render(
      <ErrorBoundary testId="eb">
        <Boom boom />
      </ErrorBoundary>,
    );
    const card = screen.getByTestId("eb");
    // 全站 blur 预算 10/13（tests/glass-guard.test.ts），围栏不许再吃余量
    expect(card.className.split(/\s+/)).toContain("u-empty");
    expect(card.className).not.toContain("glass");
  });
});
