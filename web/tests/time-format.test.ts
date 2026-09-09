// lib/time.ts 的形态契约测试（H-3）。
//
// 后端同一字段给四种形态，前端此前只认「数字」一种，字符串一律原样透出：
//   1. epoch 秒（数字）           —— discover 的 refreshed_at
//   2. 裸 epoch **字符串**        —— Langfuse 注册源 last_updated（catalog.py:65）
//   3. Python str(datetime)      —— AgentCore 源 last_updated（discovery.py）
//   4. 已排版好的字符串           —— 旧 mock / 部分接口
//
// 形态 2 让 Langfuse 注册的 Agent 在列表里显示裸 epoch "1755500000"。
// 这与「缓存于 1787030227」是同族 bug——上次只修了 refreshed_at（数字分支），
// last_updated（字符串分支）漏了，因为 mock 给 ISO 串永远触发不到。
import { describe, expect, it } from "vitest";
import { fmtTime, fmtTimeUtc, shortArn, isPlaceholderDescription } from "../src/lib/time";

describe("fmtTimeUtc：四种后端形态", () => {
  it("形态 1 —— epoch 秒（数字）", () => {
    expect(fmtTimeUtc(1755500000)).toBe("2025-08-18 06:53 UTC");
  });

  it("形态 2 —— 裸 epoch 字符串（Langfuse 注册源）：不再显示无意义数字", () => {
    expect(fmtTimeUtc("1755500000")).toBe("2025-08-18 06:53 UTC");
    // 关键回归：绝不把裸 epoch 原样透给用户看
    expect(fmtTimeUtc("1755500000")).not.toBe("1755500000");
  });

  it("形态 3 —— Python str(datetime)（AgentCore 源）：带 +00:00 偏移", () => {
    expect(fmtTimeUtc("2026-08-10 08:00:00+00:00")).toBe("2026-08-10 08:00 UTC");
  });

  it("形态 3' —— 非零时区偏移按真实时刻换算到 UTC", () => {
    // +08:00 的 16:00 == UTC 08:00
    expect(fmtTimeUtc("2026-08-10 16:00:00+08:00")).toBe("2026-08-10 08:00 UTC");
  });

  it("形态 4 —— ISO 串 / 带 \" UTC\" 后缀的 run 时间戳", () => {
    expect(fmtTimeUtc("2026-08-10T08:00:00Z")).toBe("2026-08-10 08:00 UTC");
    // run 时间戳的真形态：剥后缀后不重复标 UTC
    expect(fmtTimeUtc("2026-08-11 09:00 UTC")).toBe("2026-08-11 09:00 UTC");
  });

  it("认不出的字符串原样透出（可能是后端已排版好的文案）", () => {
    expect(fmtTimeUtc("刚刚")).toBe("刚刚");
    expect(fmtTimeUtc("unknown")).toBe("unknown");
  });

  it("空值 → 「未知时间」", () => {
    expect(fmtTimeUtc(null)).toBe("未知时间");
    expect(fmtTimeUtc(undefined)).toBe("未知时间");
    expect(fmtTimeUtc("")).toBe("未知时间");
  });
});

describe("fmtTime：同四形态，但不带 UTC 后缀", () => {
  it("数字与裸 epoch 串等价", () => {
    expect(fmtTime(1755500000)).toBe("2025-08-18 06:53");
    expect(fmtTime("1755500000")).toBe("2025-08-18 06:53");
  });

  it("Python str(datetime) 被格式化而非原样透出", () => {
    expect(fmtTime("2026-08-10 08:00:00+00:00")).toBe("2026-08-10 08:00");
  });

  it("空值 → 「—」；认不出 → 原样", () => {
    expect(fmtTime(null)).toBe("—");
    expect(fmtTime("")).toBe("—");
    expect(fmtTime("待定")).toBe("待定");
  });
});

describe("shortArn / isPlaceholderDescription（runtime_arn 配套）", () => {
  it("ARN 收成尾段资源标识", () => {
    expect(shortArn("arn:aws:bedrock-agentcore:us-west-2:1111:runtime/support-bot-abc123"))
      .toBe("runtime/support-bot-abc123");
  });

  it("Langfuse 注册源 runtime_arn 为空串 → 空字符串（调用方短路不渲染副行）", () => {
    expect(shortArn("")).toBe("");
    expect(shortArn(undefined)).toBe("");
    expect(shortArn(null)).toBe("");
  });

  it("占位描述识别（AgentCore 未填描述时后端回 \"AgentCore Runtime: {name}\"）", () => {
    expect(isPlaceholderDescription("AgentCore Runtime: echo-bot", "echo-bot")).toBe(true);
    expect(isPlaceholderDescription("", "echo-bot")).toBe(true);
    expect(isPlaceholderDescription(undefined, "echo-bot")).toBe(true);
    expect(isPlaceholderDescription("客服问答 Agent", "echo-bot")).toBe(false);
  });
});
