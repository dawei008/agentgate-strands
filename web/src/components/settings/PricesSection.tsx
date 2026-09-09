// 设置分节 3：模型单价（$/1K token）。
// 契约：prices -> {event:"prices", prices:{<model_key>:{input, output, source, updated_at}}, last_sync}
//       set_price 入参 {action, model, input, output}；成功 {event:"price_set", model}
//       refresh_prices -> {event:"prices_refreshed", updated_models, at?}（失败带 error 字段；长操作）
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiOne, useApiOne } from "../../lib/api";
import { fmtTime } from "../../lib/time";
import s from "./settings.module.css";

export interface PriceEntry {
  input: number;
  output: number;
  source?: string;
  updated_at?: number | string;
}
type PricesEvent = {
  event: "prices";
  prices: Record<string, PriceEntry>;
  /** 真形态是**对象** {at, updated_models}（app/pricing.py），可为 null。
   *  旧扁平数字形态保留在联合里兜历史响应。此前类型只写 number|string，
   *  fmtTime 收到对象 → Invalid Date → 用户看到「上次同步：[object Object]」。 */
  last_sync?: { at?: number; updated_models?: number } | number | string | null;
};
type PriceSetEvent = { event: "price_set"; model: string };
type RefreshedEvent = {
  event: "prices_refreshed";
  updated_models?: unknown;
  at?: number | string;
  error?: string;
};

function refreshedText(updated: unknown): string {
  const n = Array.isArray(updated) ? updated.length : typeof updated === "number" ? updated : null;
  return n == null ? "价格已同步" : `已同步 ${n} 个模型`;
}

/** last_sync → epoch 秒。真后端给对象 {at, updated_models}，历史/旧 mock 给
 *  扁平数字。直接把对象喂给 fmtTime 会渲染成「[object Object]」。 */
export function lastSyncAt(
  v: { at?: number; updated_models?: number } | number | string | null | undefined,
): number | string | null {
  if (v == null) return null;
  if (typeof v === "object") return v.at ?? null;
  return v;
}

export default function PricesSection() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["prices"],
    queryFn: () => apiOne<PricesEvent>({ action: "prices" }, "prices"),
  });
  const rows = Object.entries(data?.prices ?? {}).sort(([a], [b]) => a.localeCompare(b));

  const [editing, setEditing] = useState<{ key: string; input: string; output: string } | null>(null);
  const setPrice = useApiOne<PriceSetEvent>("price_set");
  const refresh = useApiOne<RefreshedEvent>("prices_refreshed");

  const onSaveRow = () => {
    if (!editing) return;
    setPrice.mutate(
      {
        action: "set_price",
        model: editing.key,
        input: Number(editing.input),
        output: Number(editing.output),
      },
      {
        onSuccess: () => {
          setEditing(null);
          void qc.invalidateQueries({ queryKey: ["prices"] });
        },
      },
    );
  };
  const onRefresh = () =>
    refresh.mutate(
      { action: "refresh_prices" },
      { onSuccess: () => void qc.invalidateQueries({ queryKey: ["prices"] }) },
    );

  return (
    <section className={s.section} aria-labelledby="settings-price-title">
      <h3 className={s.sectionTitle} id="settings-price-title">模型单价</h3>
      <p className={s.sectionDesc}>单位 $/1K token</p>

      <div className={s.actions} style={{ marginTop: 0, marginBottom: 10 }}>
        <button
          type="button"
          className={s.btnSecondary}
          disabled={refresh.isPending}
          onClick={onRefresh}
          data-testid="settings-price-refresh"
        >
          {refresh.isPending ? "同步中…" : "从 Pricing API 同步"}
        </button>
        <span className={s.help} style={{ margin: 0 }} data-testid="settings-price-last-sync">
          上次同步：{fmtTime(lastSyncAt(data?.last_sync))}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className={s.empty}>暂无单价数据。</p>
      ) : (
        <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>模型</th>
              <th className={s.num}>输入</th>
              <th className={s.num}>输出</th>
              <th>来源</th>
              <th>更新于</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, p]) => {
              const isEditing = editing?.key === key;
              return (
                <tr key={key} data-testid={`settings-price-row-${key}`}>
                  <td className={s.mono}>{key}</td>
                  {isEditing ? (
                    <>
                      <td className={s.num}>
                        <label className={s.srOnly} htmlFor={`price-input-${key}`}>输入单价</label>
                        <input
                          id={`price-input-${key}`}
                          className={s.cellInput}
                          value={editing.input}
                          onChange={(e) => setEditing({ ...editing, input: e.target.value })}
                          data-testid={`settings-price-row-${key}-input`}
                        />
                      </td>
                      <td className={s.num}>
                        <label className={s.srOnly} htmlFor={`price-output-${key}`}>输出单价</label>
                        <input
                          id={`price-output-${key}`}
                          className={s.cellInput}
                          value={editing.output}
                          onChange={(e) => setEditing({ ...editing, output: e.target.value })}
                          data-testid={`settings-price-row-${key}-output`}
                        />
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={s.num}>{p.input}</td>
                      <td className={s.num}>{p.output}</td>
                    </>
                  )}
                  <td>{p.source ? <span className={s.badge}>{p.source}</span> : "—"}</td>
                  <td>{fmtTime(p.updated_at)}</td>
                  <td>
                    {isEditing ? (
                      <span className={s.rowActions}>
                        <button
                          type="button"
                          className={s.btnLink}
                          disabled={setPrice.isPending}
                          onClick={onSaveRow}
                          data-testid={`settings-price-row-${key}-save`}
                        >
                          {setPrice.isPending ? "保存中…" : "保存"}
                        </button>
                        <button
                          type="button"
                          className={s.btnLinkMuted}
                          onClick={() => setEditing(null)}
                          data-testid={`settings-price-row-${key}-cancel`}
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={s.btnLink}
                        onClick={() => setEditing({ key, input: String(p.input), output: String(p.output) })}
                        data-testid={`settings-price-row-${key}-edit`}
                      >
                        编辑
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}

      {setPrice.isError && (
        <div className={s.err} role="alert" data-testid="settings-price-set-error">
          {setPrice.error.message}
        </div>
      )}
      {refresh.isError && (
        <div className={s.err} role="alert" data-testid="settings-price-error">
          {refresh.error.message}
        </div>
      )}
      {refresh.data && (refresh.data.error ? (
        <div className={s.err} role="alert" data-testid="settings-price-error">
          {String(refresh.data.error)}
        </div>
      ) : (
        <div className={s.ok} role="status" data-testid="settings-price-ok">
          {refreshedText(refresh.data.updated_models)}
        </div>
      ))}
    </section>
  );
}
