// 契约归一化纯函数测试（UI-026）。
//
// 背景：线上点开线上评估会话整页白屏，React error #31
// `Objects are not valid as a React child (object with keys {summary})`。
// 实测根因是 **transcript.events[].arguments**（app/transcript.py:64 原样透传
// SDK 的 `ToolCall.arguments: dict`，428/428 次全是 dict），而不是 scorer 的
// reason（28 份线上报告 190 条 reason 全是字符串）。但 app/main.py:151 的
// reason 赋值确实**没有 str() 兜**，契约上给对象合法 —— 所以两者都在这层归一。
//
// 这个文件只测纯函数；「点了不白屏」在 run-detail.test.tsx 里测。
import { describe, expect, it } from "vitest";
import { EMPTY_MARK, displayText, inlineJson, prettyJson, textOf } from "../src/lib/renderText";

describe("textOf：后端任意形态 → 可渲染文本", () => {
  it("字符串原样返回（含空串——空态由调用方表达）", () => {
    expect(textOf("回答完整且给出下一步。")).toBe("回答完整且给出下一步。");
    expect(textOf("")).toBe("");
  });

  it("{summary: string} 取 summary —— 线上崩的那一种形态", () => {
    expect(textOf({ summary: "旅客咨询宠物托运费用，超出范围，转人工。" }))
      .toBe("旅客咨询宠物托运费用，超出范围，转人工。");
  });

  it("null / undefined → 空串（调用方用 EMPTY_MARK 占位）", () => {
    expect(textOf(null)).toBe("");
    expect(textOf(undefined)).toBe("");
  });

  it("number / boolean → String()，绝不返回 undefined", () => {
    expect(textOf(0)).toBe("0");
    expect(textOf(0.75)).toBe("0.75");
    expect(textOf(false)).toBe("false");
  });

  it("数组逐项归一并用「 · 」连——真后端 diagnosis category 是 list[str]", () => {
    // 直渲数组 React 不会炸但会粘连成 "ab"，看不出这是两项
    expect(textOf(["tool_error", "timeout"])).toBe("tool_error · timeout");
    // 实测线上形态：单元素数组
    expect(textOf(["incorrect-actions-category-clarification"]))
      .toBe("incorrect-actions-category-clarification");
    expect(textOf([])).toBe("");
    // 空项被滤掉，不留 " ·  · " 这种脏连接符
    expect(textOf(["a", null, "", "b"])).toBe("a · b");
  });

  it("未预期对象 → 可诊断降级文本（列出键 + JSON），绝不返回对象本身", () => {
    const out = textOf({ verdict: "fail", note: "judge 超时" });
    expect(typeof out).toBe("string");
    // 键要列出来——这是「照着去查后端」的唯一线索
    expect(out).toContain("未预期的结构");
    expect(out).toContain("verdict");
    expect(out).toContain("note");
    // JSON 原文也要在，能看到值
    expect(out).toContain("judge 超时");
    // 绝不静默变空白（那样问题会被藏起来）
    expect(out.trim()).not.toBe("");
  });

  it("summary 是空串或非字符串时不当它是摘要，走降级（不能返回空白）", () => {
    expect(textOf({ summary: "" })).toContain("未预期的结构");
    const nested = textOf({ summary: { deep: 1 } });
    expect(nested).toContain("未预期的结构");
    expect(nested).toContain("summary");
  });

  it("超长对象截断但保留可读前缀，不把一行撑爆", () => {
    const out = textOf({ blob: "x".repeat(2000) });
    expect(out.length).toBeLessThan(500);
    expect(out).toContain("blob");
    expect(out).toContain("…");
  });

  it("循环引用不抛（JSON.stringify 会抛，必须兜住）", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => textOf(cyclic)).not.toThrow();
    expect(typeof textOf(cyclic)).toBe("string");
  });

  it("任何输入的返回值都是 string —— 这条就是不白屏的充分条件", () => {
    const inputs: unknown[] = [
      "s", 1, true, null, undefined, [], {}, { summary: "x" }, { a: 1 },
      [{ summary: "x" }], new Date(0), Symbol("s"), () => 1, NaN,
    ];
    for (const v of inputs) {
      expect(typeof textOf(v), `textOf(${String(v)}) 必须返回 string`).toBe("string");
    }
  });
});

describe("displayText：一定要占位的位置", () => {
  it("空值/空白 → 长破折号占位，「没有」要看得见", () => {
    expect(displayText(null)).toBe(EMPTY_MARK);
    expect(displayText(undefined)).toBe(EMPTY_MARK);
    expect(displayText("")).toBe(EMPTY_MARK);
    expect(displayText("   ")).toBe(EMPTY_MARK);
    expect(displayText([])).toBe(EMPTY_MARK);
  });

  it("有值时与 textOf 一致", () => {
    expect(displayText({ summary: "ok" })).toBe("ok");
    expect(displayText(["a", "b"])).toBe("a · b");
  });
});

describe("inlineJson：工具入参的行内预览", () => {
  it("dict → 紧凑 JSON（对齐旧版 ui/app.js:2504 的 JSON.stringify 兜底）", () => {
    expect(inlineJson({ dep: "PEK", arr: "SHA" })).toBe('{"dep":"PEK","arr":"SHA"}');
  });

  it("{summary} 也照样压成 JSON —— 不是取 summary，入参要看全貌", () => {
    expect(inlineJson({ summary: "转人工" })).toBe('{"summary":"转人工"}');
  });

  it("字符串入参（旧归档形态）原样，只截断", () => {
    expect(inlineJson('{"dep":"PEK"}')).toBe('{"dep":"PEK"}');
    expect(inlineJson("x".repeat(200))).toHaveLength(121); // 120 + 省略号
  });

  it("超长 dict 截断到 120 + 省略号", () => {
    const out = inlineJson({ blob: "y".repeat(500) });
    expect(out).toHaveLength(121);
    expect(out.endsWith("…")).toBe(true);
  });

  it("null → 空串（行内不占位，由布局吸收）", () => {
    expect(inlineJson(null)).toBe("");
    expect(inlineJson(undefined)).toBe("");
  });
});

describe("prettyJson：右栏代码块", () => {
  it("dict → 缩进 JSON（原实现签名是 string，对象会被原样返回 → 第二个白屏点）", () => {
    const out = prettyJson({ summary: "转人工" });
    expect(typeof out).toBe("string");
    expect(out).toBe('{\n  "summary": "转人工"\n}');
  });

  it("JSON 字符串 → 解析后美化", () => {
    expect(prettyJson('{"eligible":true}')).toBe('{\n  "eligible": true\n}');
  });

  it("非 JSON 字符串（错误原文）原样返回，不硬塞引号", () => {
    expect(prettyJson("UpstreamTimeout: no response in 300ms"))
      .toBe("UpstreamTimeout: no response in 300ms");
  });

  it("null → 占位符；数组 → 缩进 JSON", () => {
    expect(prettyJson(null)).toBe(EMPTY_MARK);
    expect(prettyJson(undefined)).toBe(EMPTY_MARK);
    expect(prettyJson(["a"])).toBe('[\n  "a"\n]');
  });

  it("任何输入都返回 string", () => {
    for (const v of ["s", 1, true, null, undefined, [], {}, { a: 1 }] as unknown[]) {
      expect(typeof prettyJson(v)).toBe("string");
    }
  });
});
