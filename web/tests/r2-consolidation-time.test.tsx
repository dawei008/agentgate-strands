// simplify-r2 Track D：时间格式化收敛后的对刑测试。
//
// 背景：settings/format.ts 的 fmtTime 副本已删（四消费方改 import lib/time）。
// 两边旧实现**都**只拦 null/undefined/""，数字 `0` 穿透成 "1970-01-01 00:00"
// —— 而后端对「缺失时间戳」的统一回退恰恰是 0（issue
// `settings-fmttime-epoch-zero`，P3）。收敛后这个洞在 lib/time 一处修完，
// 覆盖设置抽屉缓存表 / 单价表 / 资源库数据集列三处消费点。
//
// 边界纪律：只有**数字** 0（与任何非正 epoch 秒）算「缺失」；ISO 串
// "1970-01-01T00:00:00Z" 是用户真的指那一刻，照原样排版。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fmtTime } from "../src/lib/time";
import SettingsDrawer from "../src/components/layout/SettingsDrawer";
import { resetConfigForTest } from "../src/lib/config";
import { useSession } from "../src/stores/session";
import { sseFrames } from "../src/mocks/handlers";

describe("fmtTime：epoch 0 = 缺失，不是 1970", () => {
  it("数字 0 → 占位符（与 null 同款）", () => {
    expect(fmtTime(0)).toBe("—");
  });

  it("负 epoch 秒同样视为缺失", () => {
    expect(fmtTime(-1)).toBe("—");
  });

  it("ISO 串真的指 1970 那一刻 → 照原样排版，不当缺失", () => {
    expect(fmtTime("1970-01-01T00:00:00Z")).toBe("1970-01-01 00:00");
  });

  it("合法 epoch 秒 / null / 空串 / 认不出的串输出不变", () => {
    expect(fmtTime(1755500000)).toBe("2025-08-18 06:53");
    expect(fmtTime(null)).toBe("—");
    expect(fmtTime("")).toBe("—");
    expect(fmtTime("待定")).toBe("待定");
  });
});

// ---------- 消费点：设置抽屉缓存表 + 单价表（fetch 打桩同 settings.test.tsx） ----------

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };
type Payload = { action: string } & Record<string, unknown>;

const STUBS: Record<string, unknown[]> = {
  get_judge_config: [{
    event: "judge_config", provider: "bedrock",
    model: "global.anthropic.claude-sonnet-5", base_url: "", secret_id: "",
  }],
  // 真后端对缺失时间戳回退 0（app/pricing.py / app/catalog.py）
  prices: [{
    event: "prices",
    prices: { "model-a": { input: 0.003, output: 0.015, source: "manual", updated_at: 0 } },
    last_sync: { at: 1755400000, updated_models: 3 },
  }],
  list_cache: [{
    event: "cache_scopes",
    scopes: [{ scope: "observe:support-bot", cases: 42, cached_at: 0 }],
    ttl_days: 7,
  }],
};

beforeEach(() => {
  resetConfigForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    const events = STUBS[payload.action] ?? [{ event: "error", error: `未打桩 ${payload.action}` }];
    return new Response(sseFrames(events), {
      status: 200, headers: { "Content-Type": "text/event-stream" },
    });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDrawer() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsDrawer open onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("设置抽屉：时间戳字段为 0 的行不显示 1970", () => {
  it("缓存表「缓存于」列 → 占位符", async () => {
    renderDrawer();
    const row = await screen.findByTestId("settings-cache-row-observe:support-bot");
    await waitFor(() => expect(within(row).getByText("42 条")).toBeInTheDocument());
    expect(row).not.toHaveTextContent("1970");
    expect(row).toHaveTextContent("—");
  });

  it("单价表「更新时间」列 → 占位符", async () => {
    renderDrawer();
    const row = await screen.findByTestId("settings-price-row-model-a");
    await waitFor(() => expect(within(row).getByText("manual")).toBeInTheDocument());
    expect(row).not.toHaveTextContent("1970");
  });
});
