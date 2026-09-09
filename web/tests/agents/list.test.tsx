// 首页（#/agents = Agent 总览）的页壳行为：重新扫描 / 缓存提示 / 空态 / 加载错误 /
// 单 Agent 直落详情 / 卡片头身份（显示名 · 版本 · runtime）。
//
// 2026-09-03 ADR-0016 舰队级：本文件此前钉的是**目录表格**（.u-table 五列：来源 / 日志 /
// 方案数 / 最近一次评估、卡头搜索框、骨架屏表头）。首页改成观测视角卡片后那一整族钉子
// 的载体不存在了 —— 逐条处置：
//   · 表格五列 / .u-table 形态 / 主行 .btn-link / 来源 badge / 日志两态 / 方案数三态 /
//     最近一次评估三态与 runBadge 委托 / 「查看」列已删 / 双行单元格 ARN / 搜索过滤：
//     载体（表格）随契约撤除 ⇒ 删。评估结果口径改成卡底「评估」行（tests/agents/home.test.tsx
//     钉「M/K 评估器过线」四态；runBadge 委托只剩「部分失败」那一态仍走它）。
//   · card-head 页级统计「N 个 Agent · M 个可评估 · 来源」⇒ 改钉「全部 Agent N」计数。
//   · 缓存提示两态 / 重新扫描 refresh:true / 未登录 disabled / 空态 / 骨架屏：保留，
//     骨架屏的锚点由表头文字改成 testid。
//   · 点名字进详情：主行 .btn-link → 卡头 agent-card-<name>-name。
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expectProseGone } from "../prose";
import { describe, expect, it, vi } from "vitest";
import { AGENTS } from "../../src/mocks/handlers";
import AgentsPage from "../../src/pages/AgentsPage";
import { useSession } from "../../src/stores/session";
import {
  CFG, renderPage, setupAgentsPageHooks, sseResponse, stubFetch,
} from "./harness";

setupAgentsPageHooks();

describe("AgentsPage 页壳", () => {
  it("每个 Agent 一张卡：名 · 版本标签 · runtime 短形式；「全部 Agent」计数 = 全量", async () => {
    stubFetch();
    renderPage(<AgentsPage />);
    const name = await screen.findByTestId("agent-card-support-bot-name");
    expect(name).toHaveTextContent("support-bot");
    expect(name.tagName).toBe("BUTTON");
    // AGENT_META 种子给 support-bot 版本标签 v1.3
    expect(screen.getByTestId("agent-card-support-bot-version")).toHaveTextContent("v1.3");
    // runtime = ARN 短形式，不带 region 与账号 ID（键名是 runtime_arn，后端真字段）
    const rt = screen.getByTestId("agent-card-support-bot-runtime");
    expect(rt).toHaveTextContent("runtime/support-bot-abc123");
    expect(rt.textContent).not.toMatch(/111122223333|arn:aws/);
    // research-agent 的 runtime_arn 为空串 → 不画 runtime，不崩
    expect(screen.getByTestId("agent-card-research-agent")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-research-agent-runtime")).toBeNull();
    expect(screen.getByTestId("agents-count")).toHaveTextContent(String(AGENTS.length));
  });

  it("点卡头名字 navigate 到 #/agent/:name", async () => {
    stubFetch();
    renderPage(<AgentsPage />);
    fireEvent.click(await screen.findByTestId("agent-card-support-bot-name"));
    expect(location.hash).toBe("#/agent/support-bot");
  });

  it("单 Agent 规则：只有 1 个 Agent 时直接落到该 Agent 详情，不渲染卡片也不拉 fleet_status", async () => {
    const calls = stubFetch({
      discover: () => sseResponse([{
        event: "agents", region: "us-west-2", from_cache: false, agents: [AGENTS[0]],
      }]),
    });
    renderPage(<AgentsPage />);
    await waitFor(() => expect(location.hash).toBe("#/agent/support-bot"));
    expect(screen.queryByTestId("agents-grid")).toBeNull();
    expect(screen.queryByTestId("fleet-hero")).toBeNull();
    expect(calls.some((c) => c.action === "fleet_status")).toBe(false);
  });

  it("加载中显示卡片骨架屏", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("config.json")) return Response.json(CFG);
      return new Promise<Response>(() => {});
    }));
    renderPage(<AgentsPage />);
    expect(await screen.findByTestId("agents-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("agents-grid")).toBeNull();
  });

  it("空列表显示空态：尚未接入 Agent + 扫描按钮", async () => {
    stubFetch({
      discover: () => sseResponse([{
        event: "agents", region: "us-west-2", agents: [], from_cache: false,
      }]),
    });
    renderPage(<AgentsPage />);
    const empty = await screen.findByTestId("agents-empty");
    expect(empty).toHaveTextContent("尚未接入 Agent");
    // 副句「扫描本区域的 AgentCore Runtime 以接入评估对象」是操作说明 ⇒ 删
    expectProseGone(empty, "扫描本区域");
    expect(screen.getByTestId("agents-empty-rescan")).toBeEnabled();
  });

  it("discover 回 error 事件 → 页面显示 error 原文（不静默）", async () => {
    stubFetch({
      discover: () => sseResponse([{ event: "error", error: "后端炸了：discovery 限流" }]),
    });
    renderPage(<AgentsPage />);
    expect(await screen.findByTestId("agents-load-error")).toHaveTextContent("后端炸了：discovery 限流");
  });

  it("from_cache=true 显示缓存提示行（epoch 秒格式化成 UTC）；页头无通用散文", async () => {
    stubFetch();
    renderPage(<AgentsPage />);
    const note = await screen.findByTestId("agents-cache-note");
    expect(note).toHaveTextContent("缓存于 2026-08-15 07:55 UTC");
    expect(note.textContent).not.toMatch(/1786780500/);
    // 「点击重新扫描获取最新」是操作说明 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(note, "点击重新扫描获取最新");
    // 页头副标题曾写「已接入的评估对象」（对任何账号恒成立）⇒ 删
    expectProseGone(screen.getByTestId("pagehead"), "已接入的评估对象");
  });

  it("缓存提示兼容后端给已格式化字符串的情况（原样透出）", async () => {
    stubFetch({
      discover: () => sseResponse([{
        event: "agents", region: "us-west-2", agents: AGENTS,
        from_cache: true, refreshed_at: "2026-08-11 07:55 UTC",
      }]),
    });
    renderPage(<AgentsPage />);
    expect(await screen.findByTestId("agents-cache-note"))
      .toHaveTextContent("缓存于 2026-08-11 07:55 UTC");
  });

  it("重新扫描发 refresh:true，刷新后缓存提示消失，且 fleet_status 重拉", async () => {
    const calls = stubFetch();
    renderPage(<AgentsPage />);
    await screen.findByTestId("agents-cache-note");
    await screen.findByTestId("fleet-hero");
    const fleetCallsBefore = calls.filter((c) => c.action === "fleet_status").length;
    fireEvent.click(screen.getByTestId("agents-rescan"));
    await waitFor(() => {
      expect(calls.some((c) => c.action === "discover" && c.refresh === true)).toBe(true);
    });
    // mock 里 refresh=true → from_cache=false → 提示行消失
    await waitFor(() => {
      expect(screen.queryByTestId("agents-cache-note")).not.toBeInTheDocument();
    });
    await waitFor(() =>
      expect(calls.filter((c) => c.action === "fleet_status").length).toBeGreaterThan(fleetCallsBefore));
  });

  it("未登录时重新扫描 disabled 且带 title 提示", async () => {
    useSession.setState({ token: null, authed: false, everAuthed: false, authExpired: false });
    stubFetch();
    renderPage(<AgentsPage />);
    const btn = screen.getByTestId("agents-rescan");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "请先登录");
  });
});
