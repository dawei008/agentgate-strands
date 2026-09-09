// 定时选择器组件测试（结构权威：ui-prototypes/schedule-picker/index.html）。
// 直接渲染组件并注入基准时间（原型钉死的 2026-08-22 00:47 UTC 周六），
// 下次运行推算可逐字断言。与 PlanEditor 的接入（保存格式/编辑回填）在 plan.test.tsx。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { expectProseGone } from "./prose";
import { useState } from "react";
import SchedulePicker, { DEFAULT_BUDGET_USD, initMode } from "../src/pages/plan/SchedulePicker";
import type { PlanSchedule } from "../src/pages/plan/types";

afterEach(cleanup);

const NOW = new Date(Date.UTC(2026, 7, 22, 0, 47, 0)); // 周六

/** 受控外壳：value 是契约对象 {cron, budget_usd} | null；分别外显 cron 与预算，
    既保住原有 cron 断言（val() 语义不变），又能断言预算随对象双向流动 */
function Host({ initial = null }: { initial?: PlanSchedule | string | null }) {
  const init: PlanSchedule | null = typeof initial === "string"
    ? (initial.trim() ? { cron: initial, budget_usd: DEFAULT_BUDGET_USD } : null)
    : initial;
  const [v, setV] = useState<PlanSchedule | null>(init);
  return (
    <>
      <SchedulePicker value={v} onChange={setV} now={NOW} />
      <output data-testid="picker-value">{v?.cron ?? ""}</output>
      <output data-testid="picker-budget">{v ? String(v.budget_usd) : "∅"}</output>
    </>
  );
}

const val = () => screen.getByTestId("picker-value").textContent;
const budgetOut = () => screen.getByTestId("picker-budget").textContent;

describe("SchedulePicker：三档切换", () => {
  it("空串初始 = 仅手动档，无预览区；使用说明块与卡头模式说明已删", () => {
    render(<Host />);
    expect(screen.getByTestId("sched-mode-manual")).toHaveAttribute("aria-pressed", "true");
    // 此前钉的是 sched-manual-hint **在**（「不设定时，需手动运行。方案保存后可在…也可由
    // CI 通过 API…」）—— 使用说明，对任何方案恒成立 ⇒ 整块删（prose-sweep 2026-09-03）
    expect(screen.queryByTestId("sched-manual-hint")).toBeNull();
    const picker = screen.getByTestId("plan-form-schedule-picker");
    expectProseGone(picker, "需手动运行", "也可由 CI 通过 API", "不设定时",
      "系统自动生成 cron", "直接编写 cron 表达式");
    expect(screen.queryByTestId("sched-mode-note")).toBeNull();
    expect(screen.queryByTestId("sched-preview")).toBeNull();
    expect(val()).toBe("");
  });

  it("仅手动 → 简单：上报生成的 EB cron；→ 仅手动：清空为空串", () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId("sched-mode-simple"));
    // 默认简单档：每周一三五 03:00
    expect(val()).toBe("cron(0 3 ? * MON,WED,FRI *)");
    fireEvent.click(screen.getByTestId("sched-mode-manual"));
    expect(val()).toBe("");
  });

  it("简单 → 高级：带走生成的表达式进输入框；改动后切回简单可回填", () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId("sched-mode-simple"));
    fireEvent.click(screen.getByTestId("sched-mode-advanced"));
    expect(screen.getByTestId("sched-cron-input")).toHaveValue("cron(0 3 ? * MON,WED,FRI *)");
    // 手改成每天 23:30（标准五段）→ 提示可回填 → 点「切到简单定时」
    fireEvent.change(screen.getByTestId("sched-cron-input"), { target: { value: "30 23 * * *" } });
    expect(screen.getByTestId("sched-callout")).toHaveAttribute("data-state", "info");
    fireEvent.click(screen.getByTestId("sched-to-simple"));
    expect(screen.getByTestId("sched-mode-simple")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sched-freq")).toHaveValue("daily");
    expect(val()).toBe("cron(30 23 * * ? *)");
  });
});

describe("SchedulePicker：简单档", () => {
  it("星期 chips 可增减，quick 快捷（工作日/周末/每天）整组替换", () => {
    render(<Host initial="0 3 * * 1" />); // 回填：周一
    expect(screen.getByTestId("sched-day-1")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sched-day-3")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("sched-day-3"));
    expect(val()).toBe("cron(0 3 ? * MON,WED *)");
    fireEvent.click(screen.getByTestId("sched-quick-workday"));
    expect(val()).toBe("cron(0 3 ? * MON,TUE,WED,THU,FRI *)");
    fireEvent.click(screen.getByTestId("sched-quick-weekend"));
    expect(val()).toBe("cron(0 3 ? * SUN,SAT *)");
    fireEvent.click(screen.getByTestId("sched-quick-all"));
    expect(val()).toBe("cron(0 3 ? * SUN,MON,TUE,WED,THU,FRI,SAT *)");
  });

  it("星期不许清空：最后一天点掉被拒，警示文案出现", () => {
    render(<Host initial="0 3 * * 1" />);
    fireEvent.click(screen.getByTestId("sched-day-1"));
    // 仍选中，值不变，note 转警示
    expect(screen.getByTestId("sched-day-1")).toHaveAttribute("aria-pressed", "true");
    expect(val()).toBe("0 3 * * 1"); // 没有触发 onChange，原值保留
    expect(screen.getByTestId("sched-day-note")).toHaveTextContent("至少要保留 1 天");
    expect(screen.getByTestId("sched-day-note")).toHaveClass("warn");
    // 「如需停止定时请切到「仅手动」」是操作说明 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("sched-day-note"), "如需停止定时");
    // 再选一天警示消失
    fireEvent.click(screen.getByTestId("sched-day-5"));
    expect(screen.getByTestId("sched-day-note")).toHaveTextContent("已选 2 天");
    // 非警示态的「· 至少需选 1 天」是规则复述 ⇒ 删
    expectProseGone(screen.getByTestId("sched-day-note"), "至少需选 1 天");
  });

  it("每月档：日期下拉只有 1–28；29-31 风险讲解块已删", () => {
    render(<Host initial="0 3 15 * *" />); // 回填：每月 15 日
    expect(screen.getByTestId("sched-freq")).toHaveValue("monthly");
    const dom = screen.getByTestId("sched-dom");
    expect(dom).toHaveValue("15");
    expect(dom.querySelectorAll("option")).toHaveLength(28);
    // 此前钉的是 sched-dom-warn **在**（「只提供 1–28 号：29–31 号在短月会被整月跳过…
    // 请用高级模式」）—— 对下拉范围的讲解，对任何用户恒成立 ⇒ 删（prose-sweep 2026-09-03）
    expect(screen.queryByTestId("sched-dom-warn")).toBeNull();
    expectProseGone(screen.getByTestId("plan-form-schedule-picker"), "29–31 号在短月", "请用高级模式");
    fireEvent.change(dom, { target: { value: "28" } });
    expect(val()).toBe("cron(0 3 28 * ? *)");
  });

  it("时间选择 + 北京时间回显；23:30 UTC 显示（次日）且预览带跨日徽标", () => {
    render(<Host initial="0 3 * * 1" />);
    expect(screen.getByTestId("sched-bj-echo")).toHaveTextContent("11:00");
    expect(screen.queryByTestId("sched-crossday")).toBeNull();
    fireEvent.change(screen.getByTestId("sched-hour"), { target: { value: "23" } });
    fireEvent.change(screen.getByTestId("sched-min"), { target: { value: "30" } });
    expect(val()).toBe("cron(30 23 ? * MON *)");
    expect(screen.getByTestId("sched-bj-echo")).toHaveTextContent("07:30 （次日）");
    // 下次：08-24 周一 23:30 UTC = 北京 08-25 → 跨日徽标
    expect(screen.getByTestId("sched-crossday")).toHaveTextContent("跨日 · 北京 08-25 周二");
  });

  it("人话预览 + 未来 3 次运行双列（UTC/北京），简单档 cron 只读展示", () => {
    render(<Host initial="0 3 * * 1,3,5" />);
    expect(screen.getByTestId("sched-preview-human"))
      .toHaveTextContent("每周一、三、五 03:00 UTC 运行");
    // 基准 2026-08-22 周六 → 下三次 08-24(一)/08-26(三)/08-28(五)
    expect(screen.getByTestId("sched-next-run")).toHaveTextContent("08-24 周一 03:00 UTC");
    expect(screen.getByTestId("sched-upc-0")).toHaveTextContent("08-24 周一 03:00 UTC");
    expect(screen.getByTestId("sched-upc-0")).toHaveTextContent("北京 08-24 周一 11:00");
    expect(screen.getByTestId("sched-upc-1")).toHaveTextContent("08-26 周三 03:00 UTC");
    expect(screen.getByTestId("sched-upc-2")).toHaveTextContent("08-28 周五 03:00 UTC");
    // 只读框：显示生成的 EB 形态 + 只读说明；简单档没有可编辑 cron 输入
    expect(screen.getByTestId("sched-cron-readonly")).toHaveTextContent("cron(0 3 ? * MON,WED,FRI *)");
    // 此前钉的是「（只读 · 由上方选择生成）」**在** —— 对简单档恒成立的说明 ⇒ 删；
    // 底部「定时以 UTC 存储与执行…仅用于换算显示」同理（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("plan-form-schedule-picker"),
      "只读 · 由上方选择生成", "UTC 存储与执行", "仅用于换算显示");
    expect(screen.queryByTestId("sched-cron-input")).toBeNull();
  });

  it("复制按钮把当前表达式写进剪贴板", () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<Host initial="0 3 * * 1" />);
    fireEvent.click(screen.getByTestId("sched-copy"));
    expect(writeText).toHaveBeenCalledWith("cron(0 3 ? * MON *)");
    vi.unstubAllGlobals();
  });
});

describe("SchedulePicker：高级档", () => {
  it("回填三态之一（info 灰可切）：合法且可回填", () => {
    render(<Host initial="0 3 * * 1" />);
    fireEvent.click(screen.getByTestId("sched-mode-advanced"));
    expect(screen.getByTestId("sched-callout")).toHaveAttribute("data-state", "info");
    expect(screen.getByTestId("sched-to-simple")).toBeInTheDocument();
    // 「切换过去不会丢信息」对任何可回填表达式恒成立 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("sched-callout"), "不会丢信息");
  });

  it("回填三态之二（warn 黄覆盖）：合法但不可回填，给出原因", () => {
    render(<Host initial="*/30 9-18 * * 1-5" />); // 步长 → 直接进高级档
    expect(screen.getByTestId("sched-mode-advanced")).toHaveAttribute("aria-pressed", "true");
    const callout = screen.getByTestId("sched-callout");
    expect(callout).toHaveAttribute("data-state", "warn");
    expect(callout).toHaveTextContent("无法用简单定时表示");
    expect(callout).toHaveTextContent("分钟不是单一固定值");
    expect(callout).toHaveTextContent("覆盖");
    // 「请先复制备份」是操作建议 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(callout, "请先复制备份");
    // 人话预览照常
    expect(screen.getByTestId("sched-preview-human"))
      .toHaveTextContent("每周一至周五 09:00–18:59 之间每 30 分钟 UTC 运行");
  });

  it("回填三态之三（err 红非法）：出错段染红，只报错误本身", () => {
    render(<Host initial="0 25 * * 1" />); // 小时 25 越界（原型状态 3 变体 B）
    expect(screen.getByTestId("sched-mode-advanced")).toHaveAttribute("aria-pressed", "true");
    const callout = screen.getByTestId("sched-callout");
    expect(callout).toHaveAttribute("data-state", "err");
    expect(callout).toHaveTextContent("25 超出范围 0–23");
    // 此前钉的是「保存将被拒绝」**在** —— 对任何非法表达式恒成立 ⇒ 删；预览行的
    // 「修正后才会显示预览与下次运行时间」同理（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("plan-form-schedule-picker"), "保存将被拒绝", "修正后才会显示");
    // 五段图例：第 2 段（时）染红，其余正常
    expect(screen.getByTestId("sched-segcell-1")).toHaveClass("err");
    expect(screen.getByTestId("sched-segcell-0")).not.toHaveClass("err");
    // 输入框红边 + aria-invalid + 预览错误行
    expect(screen.getByTestId("sched-cron-input")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("sched-preview-human")).toHaveTextContent("无法解析");
  });

  it("EB 形态输入：六段图例（含年），dow 展示范围 1–7", () => {
    render(<Host initial="cron(0 3 ? * MON 2027)" />); // 限定年份 → 不可回填 → 高级档
    const segmap = screen.getByTestId("sched-segmap");
    expect(segmap).toHaveClass("cols-6");
    expect(screen.getByTestId("sched-segcell-5")).toHaveTextContent("年");
    expect(screen.getByTestId("sched-segcell-4")).toHaveTextContent("1–7");
  });

  it("rate(1 day)：进高级档、绿勾放行、预览说明不推算、无段图例", () => {
    render(<Host initial="rate(1 day)" />);
    expect(screen.getByTestId("sched-mode-advanced")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sched-cron-input")).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByTestId("sched-callout")).toHaveAttribute("data-state", "rate");
    expect(screen.getByTestId("sched-preview-human")).toHaveTextContent("rate 表达式");
    // callout 里「固定间隔语法（EventBridge）…保存原样生效」是语法讲解 ⇒ 删，只留
    // 「无法用简单定时表示；切回简单档会覆盖它」（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("sched-callout"), "固定间隔语法", "保存原样生效");
    expect(screen.queryByTestId("sched-segmap")).toBeNull();
  });

  it("输入实时联动：人话/下次运行随字符更新", () => {
    render(<Host initial="*/30 9-18 * * 1-5" />);
    fireEvent.change(screen.getByTestId("sched-cron-input"), { target: { value: "0 12 * * 0" } });
    expect(val()).toBe("0 12 * * 0");
    expect(screen.getByTestId("sched-preview-human")).toHaveTextContent("每周日 12:00 UTC 运行");
    // 基准周六 00:47 → 下一个周日 = 08-23
    expect(screen.getByTestId("sched-next-run")).toHaveTextContent("08-23 周日 12:00 UTC");
  });
});

describe("initMode：编辑回填分档", () => {
  const sched = (cron: string): PlanSchedule => ({ cron, budget_usd: 1 });

  it("null/空 cron→manual；可回填→simple；不可回填/非法/rate→advanced", () => {
    expect(initMode(null)).toBe("manual");
    expect(initMode(sched(""))).toBe("manual");
    expect(initMode(sched("   "))).toBe("manual");
    expect(initMode(sched("0 3 * * 1"))).toBe("simple");
    expect(initMode(sched("cron(0 3 ? * MON *)"))).toBe("simple");
    expect(initMode(sched("*/30 9-18 * * 1-5"))).toBe("advanced");
    expect(initMode(sched("rate(1 day)"))).toBe("advanced");
    expect(initMode(sched("not a cron"))).toBe("advanced");
  });
});

// ==================== 预算（schedule 契约对象 {cron, budget_usd}） ====================
describe("SchedulePicker：预算", () => {
  it("仅手动档隐藏预算输入；定时档显示 label + 帮助文字 + min/step 约束与默认 2.00", () => {
    render(<Host />);
    expect(screen.queryByTestId("sched-budget")).toBeNull();
    fireEvent.click(screen.getByTestId("sched-mode-simple"));
    const budget = screen.getByTestId("sched-budget");
    expect(screen.getByText("单次预算上限（USD）")).toBeInTheDocument();
    expect(budget).toHaveAttribute("min", "0.01");
    expect(budget).toHaveAttribute("step", "0.01");
    expect(budget).toHaveValue(DEFAULT_BUDGET_USD);
    // 此前钉的是帮助文字「定时触发时无人在场确认成本，超出预算的运行会被记为跳过」
    // **在** —— 对任何方案恒成立 ⇒ 删，预算有值时不再有话（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("sched-budget-note"), "无人在场", "会被记为跳过");
    // 高级档同样有预算行
    fireEvent.click(screen.getByTestId("sched-mode-advanced"));
    expect(screen.getByTestId("sched-budget")).toBeInTheDocument();
  });

  it("对象 value 双向：编辑回填显示历史预算；改预算/改 cron 都整对象上报", () => {
    render(<Host initial={{ cron: "0 3 * * 1", budget_usd: 5.5 }} />);
    expect(screen.getByTestId("sched-budget")).toHaveValue(5.5);
    expect(budgetOut()).toBe("5.5");
    // 改预算 → 上报对象里 cron 不变、budget_usd 更新
    fireEvent.change(screen.getByTestId("sched-budget"), { target: { value: "3.25" } });
    expect(budgetOut()).toBe("3.25");
    expect(val()).toBe("cron(0 3 ? * MON *)"); // 简单档上报归一形态
    // 改 cron（换一天）→ 预算跟着对象带回
    fireEvent.click(screen.getByTestId("sched-day-3"));
    expect(val()).toBe("cron(0 3 ? * MON,WED *)");
    expect(budgetOut()).toBe("3.25");
  });

  it("切仅手动上报 null；切回定时档预算保留上次值", () => {
    render(<Host initial={{ cron: "0 3 * * 1", budget_usd: 7 }} />);
    fireEvent.click(screen.getByTestId("sched-mode-manual"));
    expect(budgetOut()).toBe("∅");
    fireEvent.click(screen.getByTestId("sched-mode-simple"));
    expect(screen.getByTestId("sched-budget")).toHaveValue(7);
    expect(budgetOut()).toBe("7");
  });

  it("预算 ≤0/清空：警示文案 + aria-invalid（存量字符串回填 budget=0 走同一路）", () => {
    render(<Host initial={{ cron: "0 3 * * 1", budget_usd: 0 }} />);
    const budget = screen.getByTestId("sched-budget");
    expect(budget).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("sched-budget-note")).toHaveTextContent("请设置预算");
    expect(screen.getByTestId("sched-budget-note")).toHaveClass("warn");
    // 补上预算 → 警示消失，恢复帮助文字
    fireEvent.change(budget, { target: { value: "2" } });
    expect(budget).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByTestId("sched-budget-note")).not.toHaveClass("warn");
    // 警示消失后不再回到帮助文字（那句已删，见上）
    expectProseGone(screen.getByTestId("sched-budget-note"), "超出预算的运行会被记为跳过");
  });
});
