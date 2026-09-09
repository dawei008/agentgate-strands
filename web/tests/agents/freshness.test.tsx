// 首页数据新鲜度一行（home/Freshness.tsx）：原「缓存于 …」混了 discover 目录与舰队五数两个来源
// （issue fleet-cache-never-expires：现网 09-08 页头「→ 09-08 12:49」五数新算，下一行却
// 「缓存于 2026-09-04 08:52 UTC」= 目录 4 天没扫）。这里钉两态：窗口内只给「N 小时前」；
// 超过 24h 窗口才出徽章 + 后端自动重扫失败原话。锚点一律挑目标 span 专属 testid。
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AGENTS, applyAgentMeta, fleetStatus } from "../../src/mocks/handlers";
import AgentsPage from "../../src/pages/AgentsPage";
import { ageSeconds, catalogOverWindow, fmtAgo } from "../../src/pages/agents/home/derive";
import type { CatalogRefresh } from "../../src/pages/agents/home/types";
import { renderPage, setupAgentsPageHooks, sseResponse, stubFetch } from "./harness";

setupAgentsPageHooks();

const HOUR = 3600;
const DAY = 86_400;
const nowS = () => Math.floor(Date.now() / 1000);

function stubDiscover(opts: { from_cache: boolean; refreshed_at: number | string; catalog_refresh?: CatalogRefresh | null },
                      fleet?: Record<string, unknown>) {
  return stubFetch({
    discover: () => sseResponse([{
      event: "agents", region: "us-west-2", agents: applyAgentMeta(AGENTS),
      catalog_refresh: null, ...opts,
    }]),
    ...(fleet ? { fleet_status: () => sseResponse([fleet]) } : {}),
  });
}

describe("home/derive 新鲜度口径", () => {
  it("fmtAgo：秒 / 分 / 时 / 天 四档，向下取整；null 与负数给「—」", () => {
    expect(fmtAgo(0)).toBe("0 秒前");
    expect(fmtAgo(59)).toBe("59 秒前");
    expect(fmtAgo(137)).toBe("2 分钟前");
    expect(fmtAgo(2 * HOUR + 59 * 60)).toBe("2 小时前");
    // 现网读数：09-04 08:52 → 09-08 12:49 = 4 天 3 小时 57 分 ⇒ 「4 天前」
    expect(fmtAgo(4 * DAY + 3 * HOUR + 57 * 60)).toBe("4 天前");
    expect(fmtAgo(null)).toBe("—");
    expect(fmtAgo(-5)).toBe("—");
  });

  it("ageSeconds：epoch 秒 / 「YYYY-MM-DD HH:mm UTC」串都认；认不出 → null；未来时刻夹成 0", () => {
    const now = Date.UTC(2026, 8, 8, 12, 49, 0);
    expect(ageSeconds(Math.floor(Date.UTC(2026, 8, 4, 8, 52, 0) / 1000), now)).toBe(4 * DAY + 3 * HOUR + 57 * 60);
    expect(ageSeconds("2026-09-08 10:49 UTC", now)).toBe(2 * HOUR);
    expect(ageSeconds("未知", now)).toBeNull();
    expect(ageSeconds(undefined, now)).toBeNull();
    expect(ageSeconds(Math.floor(now / 1000) + 60, now)).toBe(0);
  });

  it("catalogOverWindow：严格大于窗口；年龄认不出不判超窗；窗口跟 window_hours", () => {
    expect(catalogOverWindow(DAY)).toBe(false);
    expect(catalogOverWindow(DAY + 1)).toBe(true);
    expect(catalogOverWindow(null)).toBe(false);
    expect(catalogOverWindow(7 * HOUR, 6)).toBe(true);
    expect(catalogOverWindow(7 * HOUR, 24)).toBe(false);
  });
});

describe("首页 Freshness 两态", () => {
  it("目录 2 小时前扫的：一句「Agent 目录缓存于 <UTC> · 2 小时前」，无徽章、无失败原话", async () => {
    stubDiscover({ from_cache: true, refreshed_at: nowS() - 2 * HOUR - 30 });
    renderPage(<AgentsPage />);
    const note = await screen.findByTestId("agents-cache-note");
    expect(note.textContent).toMatch(/^Agent 目录缓存于 \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · 2 小时前$/);
    expect(screen.queryByTestId("catalog-over-window")).not.toBeInTheDocument();
    expect(screen.queryByTestId("catalog-refresh-error")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("超过 24h 窗口");
  });

  it("目录 4 天前扫的 + 后端自动重扫失败：「4 天前」+ 徽章「超过 24h 窗口」+ 失败原话", async () => {
    stubDiscover({
      from_cache: true, refreshed_at: nowS() - 4 * DAY - 3 * HOUR,
      catalog_refresh: { attempted: true, ok: false, error: "ListAgentRuntimes ThrottlingException: Rate exceeded" },
    });
    renderPage(<AgentsPage />);
    const note = await screen.findByTestId("agents-cache-note");
    expect(note).toHaveTextContent("· 4 天前");
    expect(screen.getByTestId("catalog-over-window")).toHaveTextContent("超过 24h 窗口");
    expect(screen.getByTestId("catalog-refresh-error"))
      .toHaveTextContent("自动重扫失败：ListAgentRuntimes ThrottlingException: Rate exceeded");
  });

  it("防抖期内（attempted:false）同样把上次失败原话带出来；旧后端没有 catalog_refresh 时只出徽章", async () => {
    stubDiscover({
      from_cache: true, refreshed_at: nowS() - 30 * HOUR,
      catalog_refresh: { attempted: false, ok: false, error: "boom" },
    });
    renderPage(<AgentsPage />);
    expect(await screen.findByTestId("catalog-refresh-error")).toHaveTextContent("自动重扫失败：boom");
  });

  it("旧后端（无 catalog_refresh 键）目录超窗：徽章在、失败原话不在", async () => {
    stubFetch({
      discover: () => sseResponse([{
        event: "agents", region: "us-west-2", agents: applyAgentMeta(AGENTS),
        from_cache: true, refreshed_at: nowS() - 30 * HOUR,
      }]),
    });
    renderPage(<AgentsPage />);
    expect(await screen.findByTestId("catalog-over-window")).toHaveTextContent("超过 24h 窗口");
    expect(screen.queryByTestId("catalog-refresh-error")).not.toBeInTheDocument();
  });

  it("超窗徽章的窗口数跟 fleet_status.window_hours（6h 窗口下 7 小时前的目录就超窗）", async () => {
    stubDiscover({ from_cache: true, refreshed_at: nowS() - 7 * HOUR },
                 { ...fleetStatus(), window_hours: 6 });
    renderPage(<AgentsPage />);
    expect(await screen.findByTestId("catalog-over-window")).toHaveTextContent("超过 6h 窗口");
  });

  it("后端刚自动重扫成功（from_cache:false + ok:true）：标「自动重扫（上一份超过 24h）」，无「缓存于」", async () => {
    stubDiscover({ from_cache: false, refreshed_at: nowS(),
                   catalog_refresh: { attempted: true, ok: true, error: null } });
    renderPage(<AgentsPage />);
    const line = await screen.findByTestId("catalog-auto-rescanned");
    expect(line.textContent).toMatch(/^Agent 目录 \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC 自动重扫（上一份超过 24h）$/);
    expect(screen.queryByTestId("agents-cache-note")).not.toBeInTheDocument();
  });

  it("舰队五数命中进程内缓存：「舰队数据 2 分钟前算出」（cache_age_s=137）；未命中不出这段", async () => {
    stubDiscover({ from_cache: false, refreshed_at: nowS() });
    renderPage(<AgentsPage />);
    expect(await screen.findByTestId("fleet-freshness")).toHaveTextContent("舰队数据 2 分钟前算出");
    // 与页头时间窗的「· 缓存」后缀同源（fleet.cached）
    expect(screen.getByTestId("home-window")).toHaveTextContent("· 缓存");
  });

  it("没有任何缓存态（目录新扫、五数新算、无自动重扫）⇒ 整行不渲染", async () => {
    stubDiscover({ from_cache: false, refreshed_at: nowS() },
                 { ...fleetStatus(), cached: false, cache_age_s: 0 });
    renderPage(<AgentsPage />);
    await screen.findByTestId("fleet-hero");
    await waitFor(() => expect(screen.queryByTestId("home-freshness")).not.toBeInTheDocument());
    expect(screen.queryByTestId("fleet-freshness")).not.toBeInTheDocument();
  });
});
