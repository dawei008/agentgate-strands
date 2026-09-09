// 设置抽屉三分节测试：渲染、条件显隐、请求体形状、loading、错误红条。
// fetch 打桩方式与 api.test.ts 一致（stubGlobal + SSE Response），
// 假后端按 payload.action 分发并记录请求体。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { expectProseGone } from "./prose";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsDrawer from "../src/components/layout/SettingsDrawer";
import { resetConfigForTest } from "../src/lib/config";
import { useSession } from "../src/stores/session";
import { sseFrames } from "../src/mocks/handlers";

const CFG = { apiPath: "/api/invoke", cognitoDomain: "/mock-cognito", clientId: "c" };

type Payload = { action: string } & Record<string, unknown>;

/** 记录到的 API 请求体（按到达顺序） */
let calls: Payload[] = [];
/** 按 action 覆盖默认响应（返回事件数组，或返回 Promise 以模拟长操作） */
let overrides: Record<string, (p: Payload) => unknown[] | Promise<unknown[]>> = {};

const DEFAULTS: Record<string, (p: Payload) => unknown[]> = {
  get_judge_config: () => [{
    event: "judge_config", provider: "bedrock",
    model: "global.anthropic.claude-sonnet-5", base_url: "", secret_id: "",
  }],
  set_judge_config: (p) => [{ event: "judge_config_saved", ...(p.config as object) }],
  prices: () => [{
    event: "prices",
    prices: { "model-a": { input: 0.003, output: 0.015, source: "pricing-api", updated_at: 1755400000 } },
    // 真形态：last_sync 是**对象** {at, updated_models}（app/pricing.py）
    last_sync: { at: 1755400000, updated_models: 3 },
  }],
  set_price: (p) => [{ event: "price_set", model: p.model }],
  refresh_prices: () => [{ event: "prices_refreshed", updated_models: ["model-a"], at: 1755400001 }],
  list_cache: () => [{
    event: "cache_scopes",
    scopes: [{ scope: "observe:support-bot", cases: 42, cached_at: 1755500000 }],
    ttl_days: 7,
  }],
};

function sseResponse(events: unknown[]): Response {
  return new Response(sseFrames(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("config.json")) return Response.json(CFG);
    const payload = JSON.parse(String(init?.body)) as Payload;
    calls.push(payload);
    const handler = overrides[payload.action] ?? DEFAULTS[payload.action];
    if (!handler) return sseResponse([{ event: "error", error: `未打桩 action '${payload.action}'` }]);
    return sseResponse(await handler(payload));
  }));
}

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

beforeEach(() => {
  calls = [];
  overrides = {};
  resetConfigForTest();
  useSession.setState({ token: "t", authed: true, everAuthed: true, authExpired: false });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("设置抽屉三分节", () => {
  it("渲染三个分节标题并加载各自数据", async () => {
    renderDrawer();
    expect(screen.getByText("评估模型")).toBeInTheDocument();
    expect(screen.getByText("模型单价")).toBeInTheDocument();
    expect(screen.getByText("结果缓存")).toBeInTheDocument();
    // 分节说明「保存前会先验证连通性」「成本核算用的模型单价，…」对任何账号恒成立 ⇒ 删，
    // 单价节只留单位标注（prose-sweep 2026-09-03）
    expectProseGone(screen.getByText("评估模型").closest("section")!, "验证连通性");
    expectProseGone(screen.getByText("模型单价").closest("section")!, "成本核算用的");
    // 各查询到位
    await waitFor(() => {
      expect((screen.getByTestId("settings-judge-model") as HTMLInputElement).value)
        .toBe("global.anthropic.claude-sonnet-5");
    });
    expect(await screen.findByTestId("settings-price-row-model-a")).toBeInTheDocument();
    expect(await screen.findByTestId("settings-cache-row-observe:support-bot")).toBeInTheDocument();
  });

  it("openai 才显示 base_url / secret_id 字段", async () => {
    renderDrawer();
    // 等 get_judge_config 回填完成再切 provider（否则 useEffect 回填会覆盖选择）
    await waitFor(() => {
      expect((screen.getByTestId("settings-judge-model") as HTMLInputElement).value).not.toBe("");
    });
    expect(screen.queryByTestId("settings-judge-base-url")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("settings-judge-provider"), { target: { value: "openai" } });
    expect(screen.getByTestId("settings-judge-base-url")).toBeInTheDocument();
    expect(screen.getByTestId("settings-judge-secret-id")).toBeInTheDocument();
    // 字段帮助「OpenAI 兼容端点地址（含 /v1）」「API Key 存于 Secrets Manager，此处只填
    // 密钥 ID」与 placeholder 同义 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(screen.getByText("评估模型").closest("section")!, "含 /v1", "Secrets Manager");
    fireEvent.change(screen.getByTestId("settings-judge-provider"), { target: { value: "bedrock" } });
    expect(screen.queryByTestId("settings-judge-base-url")).not.toBeInTheDocument();
  });

  it("set_judge_config 请求体带 config 包裹层", async () => {
    renderDrawer();
    await waitFor(() => {
      expect((screen.getByTestId("settings-judge-model") as HTMLInputElement).value).not.toBe("");
    });
    fireEvent.change(screen.getByTestId("settings-judge-provider"), { target: { value: "openai" } });
    fireEvent.change(screen.getByTestId("settings-judge-model"), { target: { value: "gpt-4o" } });
    fireEvent.change(screen.getByTestId("settings-judge-base-url"), { target: { value: "https://x/v1" } });
    fireEvent.change(screen.getByTestId("settings-judge-secret-id"), { target: { value: "sec-1" } });
    fireEvent.click(screen.getByTestId("settings-judge-save"));
    await screen.findByTestId("settings-judge-ok");
    const call = calls.find((c) => c.action === "set_judge_config")!;
    expect(call).toEqual({
      action: "set_judge_config",
      config: { provider: "openai", model: "gpt-4o", base_url: "https://x/v1", secret_id: "sec-1" },
    });
  });

  it("保存评估模型失败时红条显示 error 原文", async () => {
    overrides.set_judge_config = () => [{ event: "error", error: "验证失败：无法连接端点" }];
    renderDrawer();
    await waitFor(() => {
      expect((screen.getByTestId("settings-judge-model") as HTMLInputElement).value).not.toBe("");
    });
    fireEvent.click(screen.getByTestId("settings-judge-save"));
    const bar = await screen.findByTestId("settings-judge-error");
    expect(bar).toHaveTextContent("验证失败：无法连接端点");
  });

  // B 案形态护栏：表内操作必须是文字链（btnLink），不是带框次按钮（btnSecondary）。
  // CSS Modules 在 vitest 下不编译，s.x 返回键名本身，故用 className 子串断言。
  it("表内操作是文字链形态，不是带框按钮", async () => {
    renderDrawer();
    const edit = await screen.findByTestId("settings-price-row-model-a-edit");
    expect(edit.className).toMatch(/btnLink/);
    expect(edit.className).not.toMatch(/btnSecondary/);
  });

  it("行内编辑保存发 set_price（model/input/output 键名）", async () => {
    renderDrawer();
    fireEvent.click(await screen.findByTestId("settings-price-row-model-a-edit"));
    fireEvent.change(screen.getByTestId("settings-price-row-model-a-input"), { target: { value: "0.005" } });
    fireEvent.change(screen.getByTestId("settings-price-row-model-a-output"), { target: { value: "0.02" } });
    fireEvent.click(screen.getByTestId("settings-price-row-model-a-save"));
    await waitFor(() => {
      expect(calls.find((c) => c.action === "set_price")).toEqual({
        action: "set_price",
        model: "model-a",
        input: 0.005,
        output: 0.02,
      });
    });
  });

  it("同步价格期间按钮 loading 且禁点，完成后恢复", async () => {
    let release!: () => void;
    overrides.refresh_prices = () =>
      new Promise<unknown[]>((resolve) => {
        release = () => resolve([{ event: "prices_refreshed", updated_models: ["model-a"] }]);
      });
    renderDrawer();
    const btn = await screen.findByTestId("settings-price-refresh");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn).toBeDisabled();
      expect(btn).toHaveTextContent("同步中…");
    });
    release();
    await waitFor(() => {
      expect(btn).toBeEnabled();
      expect(btn).toHaveTextContent("从 Pricing API 同步");
    });
    expect(await screen.findByTestId("settings-price-ok")).toBeInTheDocument();
  });

  it("同步失败时红条显示 error 原文", async () => {
    overrides.refresh_prices = () => [{ event: "error", error: "Pricing API 超时" }];
    renderDrawer();
    fireEvent.click(await screen.findByTestId("settings-price-refresh"));
    expect(await screen.findByTestId("settings-price-error")).toHaveTextContent("Pricing API 超时");
  });

  // last_sync 真形态是对象 {at, updated_models}；此前 mock 写成扁平数字，
  // 类型也只声明 number|string，真后端一来 fmtTime(对象) → Invalid Date →
  // 用户看到「上次同步：[object Object]」。
  it("上次同步：last_sync 对象形态（真后端）取 at 渲染，不出 [object Object]", async () => {
    renderDrawer();
    const el = await screen.findByTestId("settings-price-last-sync");
    await waitFor(() => expect(el).toHaveTextContent("2025-08-17 03:06"));
    expect(el).not.toHaveTextContent("[object Object]");
  });

  it("上次同步：扁平数字（历史形态）同样渲染", async () => {
    overrides.prices = () => [{
      event: "prices",
      prices: { "model-a": { input: 0.003, output: 0.015, source: "manual", updated_at: 1755400000 } },
      last_sync: 1755400000,
    }];
    renderDrawer();
    const el = await screen.findByTestId("settings-price-last-sync");
    await waitFor(() => expect(el).toHaveTextContent("2025-08-17 03:06"));
  });

  it("上次同步：last_sync 为 null → 「—」不崩", async () => {
    overrides.prices = () => [{
      event: "prices",
      prices: { "model-a": { input: 0.003, output: 0.015, source: "manual", updated_at: 1755400000 } },
      last_sync: null,
    }];
    renderDrawer();
    const el = await screen.findByTestId("settings-price-last-sync");
    await waitFor(() => expect(el).toHaveTextContent("上次同步：—"));
  });

  it("缓存摘要渲染 ttl 说明与各 scope 行", async () => {
    renderDrawer();
    await waitFor(() => {
      expect(screen.getByTestId("settings-cache-ttl")).toHaveTextContent("7 天后自动过期");
    });
    const row = screen.getByTestId("settings-cache-row-observe:support-bot");
    expect(row).toHaveTextContent("observe:support-bot");
    expect(row).toHaveTextContent("42 条");
  });
});
