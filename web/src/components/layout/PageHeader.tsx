import type { ReactNode } from "react";
import { navigate } from "../../router";

/**
 * 48px sticky 顶栏（B 案原型形态）：左侧页名 + 副文案，右侧页级动作。
 *
 * 为什么做成组件而不是塞进 Shell：页级动作（重新扫描 / 保存方案 / 立即运行）
 * 的 disabled、loading、handler 全在各页自己的 state 里，抬到 Shell 就得把
 * 这些状态往上层拎——改动面远大于每页换一个标题标签。
 *
 * 迁移：`<h2 className="viewtitle">X<span className="sub">Y</span></h2>`
 *   → `<PageHeader title="X" sub="Y" actions={…} />`
 * 标题层级为 h1（UI-001）：每个主要路由恰好一个一级标题。AuthGate 里也有 h1，
 * 但那是登录门态、与页面内容互斥，不会同时出现两个。
 * sticky 定位依赖 main 的滚动容器＝window，故 top:0 生效；main 的横向内边距
 * 由 .pagehead 用负边距抵消，让顶栏底边线拉通整个内容区宽度。
 */
export default function PageHeader({
  title,
  sub,
  meta,
  actions,
  back,
  className,
  testid,
}: {
  title: ReactNode;
  /** 标题右侧的浅灰跟随文案 */
  sub?: ReactNode;
  /** 标题右侧、sub 之后的徽章/ID 等元素（如 plan_id 芯片、状态徽章） */
  meta?: ReactNode;
  /** 右侧页级动作按钮组 */
  actions?: ReactNode;
  /** 统一返回位（二级页专用；一级页不传）：标题左侧「← label」文字链 */
  back?: { label: string; to: string };
  /** 追加到 .pagehead 的页面级修饰类（如 run 页的 .run-head 间距覆盖） */
  className?: string;
  testid?: string;
}) {
  return (
    <header
      className={className ? `pagehead ${className}` : "pagehead"}
      data-testid={testid ?? "pagehead"}
    >
      {back ? (
        <button
          className="btn-link"
          data-testid="pagehead-back"
          style={{ marginRight: "var(--sp-3)", whiteSpace: "nowrap", flexShrink: 0 }}
          onClick={() => navigate(back.to)}
        >
          <span aria-hidden="true">←</span> {back.label}
        </button>
      ) : null}
      <h1 className="viewtitle">
        {title}
        {sub ? <span className="sub">{sub}</span> : null}
      </h1>
      {meta ? <span className="pagehead-meta">{meta}</span> : null}
      {actions ? <div className="pagehead-actions">{actions}</div> : null}
    </header>
  );
}
