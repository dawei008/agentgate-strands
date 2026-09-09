// 设置分节 4：结果缓存（只读摘要）。
// 契约：list_cache -> {event:"cache_scopes", scopes:[{scope, cases, cached_at}], ttl_days}
import { useQuery } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import { fmtTime } from "../../lib/time";
import s from "./settings.module.css";

export interface CacheScope {
  scope: string;
  cases: number;
  cached_at?: number | string;
}
type CacheScopesEvent = { event: "cache_scopes"; scopes: CacheScope[]; ttl_days: number };

export default function CacheSection() {
  const { data } = useQuery({
    queryKey: ["cache_scopes"],
    queryFn: () => apiOne<CacheScopesEvent>({ action: "list_cache" }, "cache_scopes"),
  });

  return (
    <section className={s.section} aria-labelledby="settings-cache-title">
      <h3 className={s.sectionTitle} id="settings-cache-title">结果缓存</h3>
      <p className={s.sectionDesc} data-testid="settings-cache-ttl">
        {data ? `评估结果按 scope 缓存，${data.ttl_days} 天后自动过期。` : "评估结果按 scope 缓存。"}
      </p>

      {!data || data.scopes.length === 0 ? (
        <p className={s.empty}>暂无缓存。</p>
      ) : (
        <table className={s.table}>
          <thead>
            <tr>
              <th className={s.lat}>Scope</th>
              <th className={s.num}>用例</th>
              <th>缓存于</th>
            </tr>
          </thead>
          <tbody>
            {data.scopes.map((row) => (
              <tr key={row.scope} data-testid={`settings-cache-row-${row.scope}`}>
                <td className={s.mono}>{row.scope}</td>
                <td className={s.num}>{row.cases} 条</td>
                <td>{fmtTime(row.cached_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
