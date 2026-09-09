// SVG sprite：图标形状自 master:ui/index.html 的 <symbol> 原样迁移。
// emoji 在不同系统里字重、基线、彩色化都不可控——统一走 sprite。
// 本波只带壳需要的图标；页面波按需把其余 symbol 从旧版搬进来。

export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        {/* AND 门 logo：多路输入全真才输出真——「质量门禁」的视觉双关。
            v3-C：形状走 currentColor（容器给色：绿渐变芯片上配深色 glyph），
            输出「真」点用亮绿——观测台信号色。 */}
        <symbol id="i-logo" viewBox="0 0 48 48"><path d="M12 10h12a14 14 0 0 1 0 28H12z" fill="currentColor" stroke="none" /><path d="M4 17h8M4 31h8" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /><path d="M38 24h6" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /><circle cx="33" cy="24" r="3" style={{ fill: "var(--text, #F8FAFC)" }} stroke="none" /></symbol>
        <symbol id="i-bot" viewBox="0 0 16 16"><rect x="2.8" y="5" width="10.4" height="8" rx="2.2" /><line x1="8" y1="2.2" x2="8" y2="5" /><circle cx="6" cy="8.6" r=".7" fill="currentColor" stroke="none" /><circle cx="10" cy="8.6" r=".7" fill="currentColor" stroke="none" /></symbol>
        <symbol id="i-layout" viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><line x1="2" y1="6" x2="14" y2="6" /><line x1="6" y1="6" x2="6" y2="13.5" /></symbol>
        <symbol id="i-database" viewBox="0 0 16 16"><ellipse cx="8" cy="3.5" rx="5.5" ry="2" /><path d="M2.5 3.5v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-4" /><path d="M2.5 7.5v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-4" /></symbol>
        <symbol id="i-settings" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2" /><path d="M13.4 9.2v-2.4l-1.7-.5-.4-.9.8-1.6-1.7-1.7-1.6.8-.9-.4L7.4.8H5l-.5 1.7-.9.4L2 2.1.3 3.8l.8 1.6-.4.9-1.7.5v2.4l1.7.5.4.9-.8 1.6L2 13.9l1.6-.8.9.4.5 1.7h2.4l.5-1.7.9-.4 1.6.8 1.7-1.7-.8-1.6.4-.9z" transform="translate(1 0) scale(.875)" /></symbol>
        <symbol id="i-lock" viewBox="0 0 16 16"><rect x="2.5" y="7" width="11" height="7" rx="1.5" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /><circle cx="8" cy="10.5" r=".7" fill="currentColor" stroke="none" /></symbol>
        <symbol id="i-logout" viewBox="0 0 16 16"><path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" /><path d="M10 5l3 3-3 3M13 8H6" /></symbol>
        <symbol id="i-warn" viewBox="0 0 16 16"><path d="M8 2.2 14.6 13.3H1.4Z" /><line x1="8" y1="6.4" x2="8" y2="9.6" /><circle cx="8" cy="11.4" r=".55" fill="currentColor" stroke="none" /></symbol>
        <symbol id="i-close" viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" /></symbol>
        {/* 报告抽屉（原型 report-drawer/index.html 的 symbol 原样搬） */}
        <symbol id="i-check" viewBox="0 0 16 16"><polyline points="3,8.5 6.2,11.7 13,4.5" /></symbol>
        <symbol id="i-circle" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.2" strokeDasharray="2.6 2.2" /></symbol>
        <symbol id="i-download" viewBox="0 0 16 16"><path d="M8 2.6v7.2" /><polyline points="5,7.4 8,10.4 11,7.4" /><path d="M2.8 12.8h10.4" /></symbol>
        <symbol id="i-ext" viewBox="0 0 16 16"><path d="M9 3h4v4" /><path d="M13 3 7.6 8.4" /><path d="M11.4 9.6v3H3.4V4.6h3" /></symbol>
        {/* 对比（侧栏第三项）：两栏底对齐、右栏更高 —— 「两次并排 + 有变化」。
            13px 下任何箭头/双向符号都糊成一团，只有面积对比读得出来。 */}
        <symbol id="i-compare" viewBox="0 0 16 16"><rect x="2" y="6.5" width="4.6" height="7" rx="1" /><rect x="9.4" y="2.5" width="4.6" height="11" rx="1" /></symbol>
        {/* 顶栏品牌 mark：门/闸几何（ADR-0016 nav-b 契约的 .gate glyph 原样搬，viewBox 20）。
            与 #i-logo（AND 门，登录卡仍在用）并存：登录门不在本批射程。 */}
        <symbol id="i-gate" viewBox="0 0 20 20"><path d="M4 17V7.5A3.5 3.5 0 0 1 7.5 4h5A3.5 3.5 0 0 1 16 7.5V17" /><path d="M2 17h4.5M13.5 17H18" /><circle cx="10" cy="12.5" r="1.9" /></symbol>
        <symbol id="i-search" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></symbol>
        <symbol id="i-chev-l" viewBox="0 0 16 16"><polyline points="10,3.5 5.5,8 10,12.5" /></symbol>
        <symbol id="i-chev-r" viewBox="0 0 16 16"><polyline points="6,3.5 10.5,8 6,12.5" /></symbol>
      </defs>
    </svg>
  );
}

export function Icon({ name, className = "ic" }: { name: string; className?: string }) {
  return (
    <svg className={className} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}
