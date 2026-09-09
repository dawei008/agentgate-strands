// 评估器表单「脏状态」分隔符的两道钉子。
//
// 背景（缺陷 5）：EvaluatorForm.tsx 里曾把**真的 0x00 / 0x01 字节**（不是
// "\0" 转义序列）写进源码当分隔符。本仓的 grep 被包成 `ugrep -I`（跳过
// 二进制），该文件因此被判 binary 后**静默跳过**——一次审计据此把
// create_custom_evaluator 误报成「前端不可达」，所有基于 grep 的审计与
// 改名都会漏掉这个文件。
//
// ① 分隔符的运行时字节值必须保持原样（脏状态判定拿它拼 key，改成可见
//    字符会让用户文本里含该字符时产生误判/漏判）。
// ② 源码里不许再出现裸控制字节。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DIRTY_FIELD_SEP, DIRTY_ROW_SEP } from "../src/pages/resources/EvaluatorForm";

// vitest 的 import.meta.url 不是 file: 协议（transform 后的模块 id），
// 只能走 cwd——vitest root 即 web/
const SRC = path.resolve(process.cwd(), "src/pages/resources/EvaluatorForm.tsx");

describe("EvaluatorForm 脏状态分隔符", () => {
  it("运行时字节不变：字段分隔 = U+0000，行分隔 = U+0001", () => {
    expect(DIRTY_FIELD_SEP).toHaveLength(1);
    expect(DIRTY_FIELD_SEP.charCodeAt(0)).toBe(0);
    expect(DIRTY_ROW_SEP).toHaveLength(1);
    expect(DIRTY_ROW_SEP.charCodeAt(0)).toBe(1);
    // 两者不同：bands 用「字段 + 行」两层拼，同一字符会让
    // [{a,b}] 与 [{a},{b}] 拼出同一个 key
    expect(DIRTY_FIELD_SEP).not.toBe(DIRTY_ROW_SEP);
  });

  it("源码不含裸控制字节（否则 grep -I 判 binary，整文件静默跳过）", () => {
    const bytes = readFileSync(SRC);
    // 合法的控制字节只有 tab(9) / LF(10) / CR(13)
    const offenders = [...bytes]
      .map((b, i) => [i, b] as const)
      .filter(([, b]) => b < 0x20 && b !== 9 && b !== 10 && b !== 13);
    expect(offenders).toEqual([]);
  });
});
