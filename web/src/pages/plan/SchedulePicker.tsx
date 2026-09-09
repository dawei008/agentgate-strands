// 定时选择器（结构与逻辑权威：ui-prototypes/schedule-picker/index.html）。
// 三档：仅手动（null）｜简单定时（频率+星期/日期+时间，cron 只读生成）｜高级（直写 cron）。
// cron 逻辑全部走 cronEngine（原型引擎移植版）；本文件只做状态与渲染。
// 受控：value = plan.schedule 对象 {cron, budget_usd} 或 null（仅手动）——
// 契约见 app/plan.py:109-117：启用定时必须带单次预算上限（成本闸门）。
// onChange 上报——简单档报 buildCron 产物（EventBridge cron(...) 形态），
// 高级档报原文（保存时由 normalizeSchedule 归一/拦截）；预算随对象一并上报。
import { useMemo, useState } from "react";
import type { PlanSchedule } from "./types";
import {
  DOW_CRON, DOW_LABEL, FIELDS, YEAR_FIELD, WD,
  bjEcho, buildCron, cronToSimple, fmtUTC, humanize, isRate, nextRuns, pad, parseCron, toBJ,
  type SimpleSchedule,
} from "./cronEngine";

export type SchedMode = "manual" | "simple" | "advanced";

const DEFAULT_SIMPLE: SimpleSchedule = { freq: "weekly", hour: 3, min: 0, days: [1, 3, 5], dom: 15 };

/** 定时档预算默认值（USD）：无历史值时的起步预算 */
export const DEFAULT_BUDGET_USD = 2.0;

/** 编辑回填分档：null/空 cron→仅手动；能解析进简单档；其余（含 rate/非法）进高级档 */
export function initMode(value: PlanSchedule | null): SchedMode {
  const cron = value?.cron?.trim() ?? "";
  if (!cron) return "manual";
  return cronToSimple(cron).ok ? "simple" : "advanced";
}

function initSimple(cron: string): SimpleSchedule {
  const bk = cronToSimple(cron);
  if (bk.ok) {
    const { freq, hour, min, days, dom } = bk;
    return { freq, hour, min, days, dom };
  }
  return { ...DEFAULT_SIMPLE };
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const DOMS = Array.from({ length: 28 }, (_, i) => i + 1);

/* ---- 小图标（沿原型 stroke 线稿） ---- */
const IcCheck = ({ color = "currentColor" }: { color?: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6.5L9.5 17 4.5 12" /></svg>
);
const IcCross = ({ color = "currentColor" }: { color?: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>
);
const IcWarn = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4.5l8.5 15h-17z" /><path d="M12 10v4" /><circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none" /></svg>
);
const IcInfo = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.4" /><circle cx="12" cy="7.9" r=".95" fill="currentColor" stroke="none" /></svg>
);
const IcCopy = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.2" /><path d="M15 6.5V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7a2 2 0 002 2h.5" /></svg>
);

export default function SchedulePicker({ value, onChange, now }: {
  value: PlanSchedule | null;
  onChange: (v: PlanSchedule | null) => void;
  /** 测试/截图注入基准时间；缺省取当前时间 */
  now?: Date;
}) {
  const valueCron = value?.cron ?? "";
  const [mode, setMode] = useState<SchedMode>(() => initMode(value));
  const [simple, setSimple] = useState<SimpleSchedule>(() => initSimple(valueCron));
  // 高级档文本独立于 value：仅手动/切档来回时保留用户上次的表达式
  const [cronText, setCronText] = useState(() => (valueCron.trim() ? valueCron : buildCron(DEFAULT_SIMPLE)));
  const [dayWarn, setDayWarn] = useState(false);
  // 预算独立于档位保留：切「仅手动」上报 null 后再切回，仍用上次的预算。
  // 存量字符串数据回填进来是 budget_usd:0（PlanEditor 兼容层），原样保留以触发补预算提示。
  const [budget, setBudget] = useState<number>(() =>
    value && Number.isFinite(value.budget_usd) ? value.budget_usd : DEFAULT_BUDGET_USD);

  const baseNow = useMemo(() => now ?? new Date(), [now]);

  /** 定时档统一出口：cron + 预算成对上报（后端契约是对象，见文件头注释） */
  function emit(cronExpr: string, b: number = budget) {
    onChange({ cron: cronExpr, budget_usd: b });
  }

  function switchMode(to: SchedMode) {
    if (to === mode) return;
    setDayWarn(false);
    if (to === "manual") {
      setMode("manual");
      onChange(null);
      return;
    }
    if (to === "simple") {
      // 高级→简单：能解析就回填；不能则用简单档当前选择覆盖（高级档已有黄条预警）
      const bk = cronToSimple(mode === "advanced" ? cronText : valueCron);
      const next = bk.ok
        ? { freq: bk.freq, hour: bk.hour, min: bk.min, days: bk.days, dom: bk.dom }
        : simple;
      setSimple(next);
      setMode("simple");
      emit(buildCron(next));
      return;
    }
    // →高级：简单档带走生成的表达式
    if (mode === "simple") {
      const expr = buildCron(simple);
      setCronText(expr);
      emit(expr);
    } else {
      emit(cronText);
    }
    setMode("advanced");
  }

  function patchSimple(patch: Partial<SimpleSchedule>) {
    setDayWarn(false);
    const next = { ...simple, ...patch };
    setSimple(next);
    emit(buildCron(next));
  }

  function patchBudget(raw: string) {
    const n = raw === "" ? 0 : Number(raw);
    const b = Number.isFinite(n) ? n : 0;
    setBudget(b);
    emit(mode === "simple" ? buildCron(simple) : cronText, b);
  }

  function toggleDay(v: number) {
    const i = simple.days.indexOf(v);
    if (i >= 0) {
      if (simple.days.length === 1) { setDayWarn(true); return; } // 不允许清空
      patchSimple({ days: simple.days.filter((d) => d !== v) });
    } else {
      patchSimple({ days: [...simple.days, v] });
    }
  }

  const cron = mode === "simple" ? buildCron(simple) : cronText;
  const parsed = useMemo(() => parseCron(cron), [cron]);
  const rate = mode === "advanced" && isRate(cronText);
  const human = useMemo(() => humanize(parsed), [parsed]);
  const runs = useMemo(() => nextRuns(parsed, baseNow, 3), [parsed, baseNow]);
  const backfill = useMemo(() => cronToSimple(cronText), [cronText]);

  function copyExpr() {
    try { void navigator.clipboard?.writeText(cron); } catch { /* ignore */ }
  }

  return (
    <div className="card" data-testid="plan-form-schedule-picker">
      <div className="card-head">
        <span className="card-title">定时</span>
        <span className="spacer" />
        <div className="sched-seg" role="group" aria-label="定时模式">
          {([["manual", "仅手动"], ["simple", "简单定时"], ["advanced", "高级"]] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              data-testid={`sched-mode-${m}`}
              aria-pressed={mode === m}
              onClick={() => switchMode(m)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="card-body">
        {/* 仅手动档此前有一块「不设定时，需手动运行。方案保存后可在…点立即运行触发；
            也可由 CI 通过 API…」—— 使用说明 ⇒ 整块删（prose-sweep 2026-09-03） */}

        {mode === "simple" && (
          <div className="sched-fields">
            <div className="sched-frow">
              <div className="sched-flabel">频率</div>
              <div className="sched-fbody">
                <div className="sched-inline">
                  <select
                    className="u-select"
                    style={{ width: "auto" }}
                    aria-label="频率"
                    data-testid="sched-freq"
                    value={simple.freq}
                    onChange={(e) => patchSimple({ freq: e.target.value as SimpleSchedule["freq"] })}
                  >
                    <option value="daily">每天</option>
                    <option value="weekly">每周</option>
                    <option value="monthly">每月</option>
                  </select>
                </div>
              </div>
            </div>

            {simple.freq === "weekly" && (
              <div className="sched-frow">
                <div className="sched-flabel">星期</div>
                <div className="sched-fbody">
                  <div className="sched-days" role="group" aria-label="星期多选">
                    {DOW_LABEL.map((label, i) => {
                      const v = DOW_CRON[i];
                      return (
                        <button
                          key={v}
                          type="button"
                          className={`sched-day${i >= 5 ? " weekend" : ""}`}
                          data-testid={`sched-day-${v}`}
                          aria-pressed={simple.days.includes(v)}
                          onClick={() => toggleDay(v)}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="sched-quick">
                    {([["workday", "工作日", [1, 2, 3, 4, 5]],
                      ["weekend", "周末", [6, 0]],
                      ["all", "每天", [1, 2, 3, 4, 5, 6, 0]]] as const).map(([key, label, days]) => (
                      <button
                        key={key}
                        type="button"
                        className="sched-qbtn"
                        data-testid={`sched-quick-${key}`}
                        onClick={() => patchSimple({ days: [...days] })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div
                    className={`sched-note${dayWarn ? " warn" : ""}`}
                    data-testid="sched-day-note"
                    aria-live="polite"
                  >
                    {dayWarn ? (
                      <><IcWarn /><span>至少要保留 1 天</span></>
                    ) : (
                      <span>已选 <span className="mono">{simple.days.length}</span> 天</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {simple.freq === "monthly" && (
              <div className="sched-frow">
                <div className="sched-flabel">日期</div>
                <div className="sched-fbody">
                  <div className="sched-inline">
                    <select
                      className="u-select mono"
                      style={{ width: "auto" }}
                      aria-label="每月日期"
                      data-testid="sched-dom"
                      value={simple.dom}
                      onChange={(e) => patchSimple({ dom: Number(e.target.value) })}
                    >
                      {DOMS.map((d) => <option key={d} value={d}>{d} 日</option>)}
                    </select>
                  </div>
                  {/* 「只提供 1–28 号：29–31 号在短月会被整月跳过…请用高级模式」是对下拉
                      范围的讲解，对任何用户恒成立 ⇒ 删（prose-sweep 2026-09-03） */}
                </div>
              </div>
            )}

            <div className="sched-frow">
              <div className="sched-flabel">时间</div>
              <div className="sched-fbody">
                <div className="sched-inline">
                  <div className="sched-timeset">
                    <select
                      className="u-select mono"
                      aria-label="小时 (UTC)"
                      data-testid="sched-hour"
                      value={simple.hour}
                      onChange={(e) => patchSimple({ hour: Number(e.target.value) })}
                    >
                      {HOURS.map((h) => <option key={h} value={h}>{pad(h)}</option>)}
                    </select>
                    <span className="colon">:</span>
                    <select
                      className="u-select mono"
                      aria-label="分钟 (UTC)"
                      data-testid="sched-min"
                      value={simple.min}
                      onChange={(e) => patchSimple({ min: Number(e.target.value) })}
                    >
                      {MINS.map((m) => <option key={m} value={m}>{pad(m)}</option>)}
                    </select>
                  </div>
                  <span className="sched-tz">UTC</span>
                  <span className="sched-note">
                    = 北京时间 <span className="mono" data-testid="sched-bj-echo">{bjEcho(simple.hour, simple.min).text}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {mode === "advanced" && (
          <div className="sched-fields">
            <div className="sched-frow">
              <div className="sched-flabel">表达式</div>
              <div className="sched-fbody">
                <div className={`sched-cron-input${parsed.ok || rate ? "" : " bad"}`}>
                  <input
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="cron 表达式"
                    aria-invalid={!(parsed.ok || rate)}
                    data-testid="sched-cron-input"
                    value={cronText}
                    placeholder="分 时 日 月 周    例：0 3 * * 1"
                    onChange={(e) => { setCronText(e.target.value); emit(e.target.value); }}
                  />
                  <span className="state" data-testid="sched-cron-state">
                    {parsed.ok || rate ? <IcCheck color="#4ADE80" /> : <IcCross color="#F87171" />}
                  </span>
                </div>
                {!rate && <SegMap parsed={parsed} />}
                <BackfillCallout
                  parsed={parsed}
                  rate={rate}
                  backfill={backfill}
                  onToSimple={() => switchMode("simple")}
                />
              </div>
            </div>
          </div>
        )}

        {/* 预算行：定时两档共用（仅手动隐藏）。后端强制 budget_usd>0（app/plan.py:114-117）
            ——定时触发时无人在场确认成本，这是成本闸门，不是可选项。 */}
        {mode !== "manual" && (
          <div className="sched-fields" style={{ marginTop: "var(--sp-3, 12px)" }}>
            <div className="sched-frow">
              <div className="sched-flabel">
                <label htmlFor="sched-budget">单次预算上限（USD）</label>
              </div>
              <div className="sched-fbody">
                <div className="sched-inline">
                  <input
                    id="sched-budget"
                    type="number"
                    className="u-input num mono"
                    style={{ width: 110 }}
                    min={0.01}
                    step={0.01}
                    aria-invalid={budget <= 0}
                    data-testid="sched-budget"
                    value={budget === 0 ? "" : budget}
                    onChange={(e) => patchBudget(e.target.value)}
                  />
                </div>
                <div
                  className={`sched-note${budget <= 0 ? " warn" : ""}`}
                  data-testid="sched-budget-note"
                  aria-live="polite"
                >
                  {/* 预算有值时那句「定时触发时无人在场确认成本，超出预算的运行会被记为
                      跳过」对任何方案恒成立 ⇒ 删，只留校验态（prose-sweep 2026-09-03） */}
                  {budget <= 0 && (
                    <><IcWarn /><span><b>请设置预算：</b>启用定时必须填单次预算上限（&gt;0），否则无法保存。</span></>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {mode !== "manual" && (
        <>
          <div className="sched-preview" data-testid="sched-preview">
            {rate ? (
              <div className="sched-pv-row">
                <span className="sched-pv-ico off" aria-hidden="true">—</span>
                <span className="sched-pv-main">
                  <span className="sched-pv-human" data-testid="sched-preview-human">
                    EventBridge rate 表达式（固定间隔运行）
                  </span>
                  <span className="sched-pv-next">rate 语法不支持下次运行推算；保存原样生效</span>
                </span>
              </div>
            ) : parsed.ok && runs.length > 0 ? (
              <NextRunRow human={human!} run={runs[0]} />
            ) : parsed.ok ? (
              <div className="sched-pv-row">
                <span className="sched-pv-ico off" aria-hidden="true">—</span>
                <span className="sched-pv-main">
                  <span className="sched-pv-human" data-testid="sched-preview-human">{human}</span>
                  <span className="sched-pv-next">未来 366 天内没有匹配时刻</span>
                </span>
              </div>
            ) : (
              <div className="sched-pv-row">
                <span className="sched-pv-ico bad" aria-hidden="true"><IcCross /></span>
                <span className="sched-pv-main">
                  <span className="sched-pv-human bad" data-testid="sched-preview-human">
                    无法解析：{parsed.ok ? "" : parsed.err}
                  </span>
                </span>
              </div>
            )}
            <div className="sched-pv-expr">
              <span className="sched-pv-label">{mode === "advanced" ? "当前表达式" : "生成的 cron"}</span>
              <span
                className={`sched-expr${parsed.ok || rate ? "" : " dimmed"}`}
                data-testid="sched-cron-readonly"
              >
                {cron}
              </span>
              <button
                type="button"
                className="btn ghost mini"
                aria-label="复制表达式"
                title="复制"
                data-testid="sched-copy"
                onClick={copyExpr}
              >
                <IcCopy />
              </button>
            </div>
          </div>

          {parsed.ok && runs.length > 1 && (
            <div className="sched-upcoming" data-testid="sched-upcoming">
              <div className="sched-upc-head">未来 3 次运行</div>
              {runs.map((r, i) => {
                const b = toBJ(r);
                return (
                  <div className="sched-upc-row" key={r.getTime()} data-testid={`sched-upc-${i}`}>
                    <span className="sched-upc-n">{i + 1}</span>
                    <span className="sched-upc-utc">{fmtUTC(r)} UTC</span>
                    <span className="sched-upc-bj">
                      北京 {pad(b.getUTCMonth() + 1)}-{pad(b.getUTCDate())} 周{WD[b.getUTCDay()]} {pad(b.getUTCHours())}:{pad(b.getUTCMinutes())}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

        </>
      )}
    </div>
  );
}

/* ---- 下次运行行：人话 + 首次时间 + 跨日徽标 ---- */
function NextRunRow({ human, run }: { human: string; run: Date }) {
  const bj = toBJ(run);
  const cross = bj.getUTCDate() !== run.getUTCDate();
  return (
    <div className="sched-pv-row">
      <span className="sched-pv-ico" aria-hidden="true"><IcCheck /></span>
      <span className="sched-pv-main">
        <span className="sched-pv-human" data-testid="sched-preview-human">{human}</span>
        <span className="sched-pv-next" data-testid="sched-next-run">
          下次：<span className="num">{fmtUTC(run)} UTC</span>
          <i className="sched-dot" />
          <span>北京时间 <span className="num">{pad(bj.getUTCHours())}:{pad(bj.getUTCMinutes())}</span></span>
          {cross && (
            <span className="sched-crossday" data-testid="sched-crossday">
              跨日 · 北京 {pad(bj.getUTCMonth() + 1)}-{pad(bj.getUTCDate())} 周{WD[bj.getUTCDay()]}
            </span>
          )}
        </span>
      </span>
    </div>
  );
}

/* ---- cron 段图例：标准 5 格 / EB 6 格（含年），出错段染红 ---- */
function SegMap({ parsed }: { parsed: ReturnType<typeof parseCron> }) {
  const eb = parsed.dialect === "eventbridge";
  const metas = eb ? [...FIELDS, YEAR_FIELD] : FIELDS;
  // EB 的 dow 数字空间 1–7（1=周日）；展示范围跟方言走
  const rangeFor = (i: number) => {
    if (eb && i === 4) return "1–7";
    return `${metas[i].min}–${metas[i].max}`;
  };
  return (
    <div className={`sched-segmap${eb ? " cols-6" : ""}`} data-testid="sched-segmap">
      {metas.map((f, i) => {
        const raw = parsed.parts[i] !== undefined ? parsed.parts[i] : "—";
        const bad = !parsed.ok && parsed.errSeg === i;
        return (
          <div key={f.name} className={`sched-segcell${bad ? " err" : ""}`} data-testid={`sched-segcell-${i}`}>
            <div className="sk">{f.name}</div>
            <div className="sv">{raw}</div>
            <div className="sr">{rangeFor(i)}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ---- 回填可行性三态：灰可切 / 黄警告覆盖 / 红非法 ---- */
function BackfillCallout({ parsed, rate, backfill, onToSimple }: {
  parsed: ReturnType<typeof parseCron>;
  rate: boolean;
  backfill: ReturnType<typeof cronToSimple>;
  onToSimple: () => void;
}) {
  if (rate) {
    return (
      <div className="sched-callout info" data-testid="sched-callout" data-state="rate">
        <IcInfo />
        <span>
          <b>rate 表达式</b>无法用简单定时表示；切回简单档会<b>覆盖</b>它。
        </span>
      </div>
    );
  }
  if (parsed.ok && backfill.ok) {
    return (
      <div className="sched-callout info" data-testid="sched-callout" data-state="info">
        <IcCheck />
        <span>此表达式可用<b>简单定时</b>表示</span>
        <span className="act">
          <button type="button" className="btn ghost mini" data-testid="sched-to-simple" onClick={onToSimple}>
            切到简单定时
          </button>
        </span>
      </div>
    );
  }
  if (parsed.ok) {
    return (
      <div className="sched-callout warn" data-testid="sched-callout" data-state="warn">
        <IcWarn />
        <span>
          <b>此表达式无法用简单定时表示</b>（{backfill.ok ? "" : backfill.reason}）；
          切回简单档会<b>覆盖</b>它。
        </span>
      </div>
    );
  }
  return (
    <div className="sched-callout err" data-testid="sched-callout" data-state="err">
      <IcCross />
      <span><b>表达式非法：</b>{parsed.ok ? "" : parsed.err}</span>
    </div>
  );
}
