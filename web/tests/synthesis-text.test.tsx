// SynthesisText（综合报告 markdown-lite 渲染件）单测：切块层纯函数直测 +
// 行内 chip 渲染。切块与 ref 正则是 99fc941 ReportView 渲染件的收窄复刻
// （多编号 [run:#1→#2] 的逐编号切分修过一轮缺陷），这里把那些行为钉住。
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import SynthesisText, {
  parseSynthesisBlocks, synthesisRefs, type SynthRef,
} from "../src/components/SynthesisText";

afterEach(cleanup);

describe("parseSynthesisBlocks（切块层）", () => {
  it("空行分段：两段散文成两个 p 块", () => {
    expect(parseSynthesisBlocks("第一段。\n\n第二段。")).toEqual([
      { kind: "p", text: "第一段。" },
      { kind: "p", text: "第二段。" },
    ]);
  });

  it("`> ` 引用行连读成一个引文块；段落与引用互不吞", () => {
    const blocks = parseSynthesisBlocks("引言。\n> 第一行\n> 第二行\n尾段。");
    expect(blocks).toEqual([
      { kind: "p", text: "引言。" },
      { kind: "quote", text: "第一行\n第二行" },
      { kind: "p", text: "尾段。" },
    ]);
  });

  it("`- ` 列表逐项切；缩进续行并进上一项（judge 写长句会折行）", () => {
    const blocks = parseSynthesisBlocks("- 第一条\n  续行\n- 第二条");
    expect(blocks).toEqual([
      { kind: "list", ordered: false, start: 1, items: [
        { depth: 0, text: "第一条\n续行" },
        { depth: 0, text: "第二条" },
      ] },
    ]);
  });

  it("有序列表保留 judge 写的起始序号，不重编号", () => {
    const blocks = parseSynthesisBlocks("2. 从二开始\n3. 第三条");
    expect(blocks).toEqual([
      { kind: "list", ordered: true, start: 2, items: [
        { depth: 0, text: "从二开始" },
        { depth: 0, text: "第三条" },
      ] },
    ]);
  });

  it("同型列表跨空行合并（有序列表不从 1 重新数）", () => {
    const blocks = parseSynthesisBlocks("- a\n\n- b");
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it("空正文 → 零块；纯空白行不产块", () => {
    expect(parseSynthesisBlocks("")).toEqual([]);
    expect(parseSynthesisBlocks("\n  \n")).toEqual([]);
  });
});

describe("行内渲染（ref chip 与加粗）", () => {
  it("多编号 [run:#1→#5]：逐编号切两个 chip，分隔符原样回填，不展开中间", () => {
    render(<SynthesisText text="均分上升（[run:#1→#5]）。" />);
    const chips = screen.getAllByTestId("syn-run-ref");
    expect(chips.map((c) => c.textContent)).toEqual(["run:#1", "run:#5"]);
    const body = document.querySelector(".syn-p")!;
    expect(body.textContent).toBe("均分上升（run:#1→run:#5）。");
    expect(body.textContent).not.toContain("[run:");
  });

  it("逗号分隔 [run:#2, #3] 同样逐编号切", () => {
    render(<SynthesisText text="见 [run:#2, #3]。" />);
    expect(screen.getAllByTestId("syn-run-ref").map((c) => c.textContent))
      .toEqual(["run:#2", "run:#3"]);
  });

  it("一个编号都切不出的 [run:…] 块按原文渲染——不吞字", () => {
    render(<SynthesisText text="损坏引用 [run:#] 原样。" />);
    expect(screen.queryByTestId("syn-run-ref")).toBeNull();
    expect(document.querySelector(".syn-p")!.textContent)
      .toBe("损坏引用 [run:#] 原样。");
  });

  it("[case:名@agent] 与不带 agent 的 [case:名] 都成 chip，完整引用在 data-full", () => {
    render(<SynthesisText text="[case:改绑@bot] 与 [case:退货]。" />);
    const chips = screen.getAllByTestId("syn-case-ref");
    expect(chips.map((c) => c.textContent)).toEqual(["改绑", "退货"]);
    expect(chips[0].dataset.full).toBe("改绑@bot");
    expect(chips[1].dataset.full).toBe("退货");
  });

  it("[session:id#N]：带消息编号；短 id = 首段 8 位 hex（lib/text 唯一实现）", () => {
    render(<SynthesisText text="见 [session:sess-a41f9c2b#7]。" />);
    const chip = screen.getByTestId("syn-session-ref");
    // 短 id = 首段 8 位 hex（批 fmt-converge；旧值 "sess-a41f9c2b #7" 是 18 字截尾）
    expect(chip.textContent).toBe("a41f9c2b #7");
    expect(chip.dataset.full).toBe("sess-a41f9c2b");
  });

  it("粗体、引用 chip 可同段共存；列表项与引文块里也切", () => {
    render(<SynthesisText text={"- **落点**：见 [run:#3]\n\n> 引文里 [case:c1@a]"} />);
    expect(screen.getByTestId("syn-list").querySelector("b")!.textContent).toBe("落点");
    expect(screen.getByTestId("syn-run-ref")).toHaveTextContent("run:#3");
    const quote = screen.getByTestId("syn-quote");
    expect(quote.querySelector("[data-testid=syn-case-ref]")).toHaveTextContent("c1");
    // 负钉：裸标记不上屏
    const all = document.body.textContent ?? "";
    expect(all).not.toContain("**");
    expect(all).not.toContain("[run:");
    expect(all).not.toContain("[case:");
  });

  it("chips 是 badge 语义类的 <span>：不带跳转、不挂 title（零通用散文）", () => {
    render(<SynthesisText text="[run:#1] [case:c@a] [session:sid-1]" />);
    for (const id of ["syn-run-ref", "syn-case-ref", "syn-session-ref"]) {
      const chip = screen.getByTestId(id);
      expect(chip.tagName).toBe("SPAN");
      expect(chip.className).toContain("badge");
      expect(chip).not.toHaveAttribute("title");
      expect(chip.querySelector("a, button")).toBeNull();
    }
  });
});

// ---- adr0014-migrate 批：双向深链的两个 prop + 引用清单纯函数 ----
// 不传 onRefClick 时输出与此前逐字节相同（上面那条「chips 是 <span>」就是钉）。
describe("onRefClick / jumpable：有落点的 chip 才是 <button>", () => {
  it("传了 onRefClick：三种 chip 都成 <button>，点击回传结构化引用；仍不挂 title", () => {
    const seen: SynthRef[] = [];
    render(<SynthesisText text="[run:#3] [case:c1@bot] [session:sid-1#7]" onRefClick={(r) => seen.push(r)} />);
    for (const id of ["syn-run-ref", "syn-case-ref", "syn-session-ref"]) {
      const chip = screen.getByTestId(id);
      expect(chip.tagName).toBe("BUTTON");
      expect(chip.className).toContain("badge");
      expect(chip).not.toHaveAttribute("title");
      fireEvent.click(chip);
    }
    expect(seen).toEqual([
      { kind: "run", n: 3 },
      { kind: "case", name: "c1", agent: "bot" },
      { kind: "session", id: "sid-1", msgNo: 7 },
    ]);
  });

  it("jumpable 说没落点的保持 <span>（不给一个点了没反应的按钮）", () => {
    const onRefClick = vi.fn();
    render(
      <SynthesisText
        text="[case:has@bot] [case:ghost@bot] [run:#2]"
        onRefClick={onRefClick}
        jumpable={(r) => r.kind === "case" && r.name === "has"}
      />,
    );
    const cases = screen.getAllByTestId("syn-case-ref");
    expect(cases.map((c) => c.tagName)).toEqual(["BUTTON", "SPAN"]);
    expect(screen.getByTestId("syn-run-ref").tagName).toBe("SPAN");
    fireEvent.click(cases[1]);
    expect(onRefClick).not.toHaveBeenCalled();
  });
});

describe("synthesisRefs：正文里的引用去重、保首见序", () => {
  it("三种记号各切出来；同一处被点名两次只算一处；多编号 run 块逐编号", () => {
    const refs = synthesisRefs(
      "见 [run:#1→#5]，[case:case-2@bot] 与 [case:case-2@bot] 都在 [session:sess-a#3] 里；[run:#5] 再提一次。",
    );
    expect(refs).toEqual([
      { kind: "run", n: 1 },
      { kind: "run", n: 5 },
      { kind: "case", name: "case-2", agent: "bot" },
      { kind: "session", id: "sess-a", msgNo: 3 },
    ]);
  });

  it("不带 agent 的 case 与带 agent 的同名 case 是两处（data-full 不同）；空文本 → 空数组", () => {
    expect(synthesisRefs("[case:x] [case:x@a]")).toHaveLength(2);
    expect(synthesisRefs("")).toEqual([]);
    expect(synthesisRefs("没有引用的一句话。")).toEqual([]);
  });
});
