import type { ReactNode } from "react";
import { fmtTimeUtc } from "../../../lib/time";
import { ageSeconds, catalogOverWindow, fmtAgo } from "./derive";
import type { CatalogFreshnessInput, FleetStatusEvent } from "./types";

/**
 * 首页数据新鲜度一行 —— 原来那句「缓存于 …」把**两个来源**的时刻混成了一句
 * （2026-09-04 评审把 discover 目录的 01:27 读成舰队五数过期 6 小时；2026-09-08 现网
 * 「缓存于 2026-09-04 08:52 UTC」= 目录 4 天没扫，五数却是当次新算的）。这里分开标：
 *   · 舰队数据：fleet_status 的 computed_at / cache_age_s（进程内 300s 缓存，命中才有话说）
 *   · Agent 目录：discover 的 refreshed_at（DDB 持久缓存）——超过观测窗口（24h）才出
 *     「超过 24h 窗口」徽章；后端自动重扫失败时后接原话（catalog_refresh.error），
 *     刚自动重扫成功时标「自动重扫」。
 * 三段都只在各自状态成立时出现；全部不成立 ⇒ 整行不渲染（不放恒成立散文）。
 */
export default function Freshness({ discover, fleet, nowMs = Date.now() }: {
  discover: CatalogFreshnessInput | undefined;
  fleet: FleetStatusEvent | undefined;
  nowMs?: number;
}) {
  const parts: ReactNode[] = [];

  if (fleet?.cached) {
    parts.push(
      <span key="fleet" data-testid="fleet-freshness">舰队数据 {fmtAgo(fleet.cache_age_s)}算出</span>,
    );
  }

  const refresh = discover?.catalog_refresh;
  if (discover?.from_cache) {
    const age = ageSeconds(discover.refreshed_at, nowMs);
    const over = catalogOverWindow(age, fleet?.window_hours);
    parts.push(
      <span key="catalog" data-testid="agents-cache-note">
        Agent 目录缓存于 {fmtTimeUtc(discover.refreshed_at)}
        {age != null && ` · ${fmtAgo(age)}`}
        {over && (
          <>
            {" "}
            <span className="badge warn" data-testid="catalog-over-window">
              超过 {fleet?.window_hours ?? 24}h 窗口
            </span>
            {refresh && !refresh.ok && refresh.error && (
              <span data-testid="catalog-refresh-error"> · 自动重扫失败：{refresh.error}</span>
            )}
          </>
        )}
      </span>,
    );
  } else if (discover && refresh?.attempted && refresh.ok) {
    parts.push(
      <span key="rescanned" data-testid="catalog-auto-rescanned">
        Agent 目录 {fmtTimeUtc(discover.refreshed_at)} 自动重扫（上一份超过 {fleet?.window_hours ?? 24}h）
      </span>,
    );
  }

  if (parts.length === 0) return null;
  return (
    <p className="agents-cache-note" data-testid="home-freshness">
      {parts.map((p, i) => (i === 0 ? p : [<span key={`sep-${i}`}> · </span>, p]))}
    </p>
  );
}
