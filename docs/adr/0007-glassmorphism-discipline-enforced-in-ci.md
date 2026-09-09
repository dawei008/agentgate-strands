# 0007 玻璃拟态纪律 CI 化——形态护栏写进测试

Status: accepted（2026-08）

## Context

选定的视觉形态是「暗色玻璃拟态观测台」（原型权威
ui-prototypes/design-v3/variant-c-glass）。玻璃是极易滥用的形态：blur
叠层伤性能与可读性、表格上玻璃毁数据密度、半透明小字底毁对比度。仅靠
评审约定挡不住多 agent 并行改样式的漂移。

## Decision

把原型定下的克制纪律钉死在 CI（`web/tests/glass-guard.test.ts`，对全部
样式表做 CSS 原文静态断言 + 对比度实算，见文件头 1-9 行）：

1. **blur 白名单制、恒 1 层不嵌套**：所有 backdrop-filter 必须落在
   白名单选择器上（`glass-guard.test.ts:64-65`），且玻璃值只走
   `--glass-blur` 令牌、禁止手写 blur(...)（`:93-99`）。新增玻璃面
   必须先过设计评审再进白名单。
2. **表格零玻璃**：含 table/thead/tbody/td/th/tr 的选择器出现
   backdrop-filter 的违规数必须为 0（`:108-113`）。
3. **chip / badge / 输入面实心底**：chip 基底 = 实心 `--bg2`
   （`:129-133`），badge 中性基底 = 实心 `--neutral-bg`（`:134-137`）。
4. **焦点环 outline 型**：box-shadow 环会被玻璃 glow 吃掉（原型实测坑，
   `:154-155`），`--focus-outline` 令牌须为 2px 实线亮绿（`:170-171`）。
5. **对比度下限**：主文字对玻璃有效底 ≥ 7、次要文字 ≥ 4.5
   （`:202-208`，jsdom 不渲染 backdrop-filter，按叠色公式实算）。

## Consequences

- 样式改动可能被「设计测试」拦下——这是特性不是误伤；放宽任何一条须
  改测试本身并说明理由。
- 白名单是「玻璃只上卡片与浮层」的物质形式：绕过它的唯一途径是改
  测试文件，天然留下评审痕迹。
- 断言基于朴素 CSS 文本解析，样式若迁移到 CSS-in-JS 需重写护栏。
