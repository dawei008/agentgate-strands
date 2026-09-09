// 监控大屏（#/bigscreen）：1920×1080 固定舞台，挂墙远读场景（3–5m）。
// 无壳布局——不渲染侧栏/PageHeader（Shell 对 bigscreen 路由单独分流）。
// 结构与推导口径照原型 ui-prototypes/dashboard-bigscreen/index.html：
//   顶条（健康灯三态）/ KPI 带 / Agent 健康矩阵（15s 翻页）/ 事件侧栏（实测
//   自适配溢出摘尾）/ 最近运行带。零 hover 依赖；reduced-motion 停动画与翻页。
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { apiOne } from "../../lib/api";
import type { PlansEvent } from "../../lib/apiTypes";
import { fmtScoreFloor, parseUtc } from "../../lib/scoring";
import {
  ago, breachOf, deriveAgents, deriveEvents, deriveKpi, deriveLamp,
  deriveStale, fmtHM, isScored, needsAttentionCount, outcomeOf, passRateOf,
  scoreOf, NO_SCORE_TEXT, REFRESH_MS,
  type AgentHealth, type BigscreenEvent, type BigscreenKpi,
} from "./derive";
import type { BigscreenRun, BigscreenRunsEvent } from "./types";
import "./bigscreen.css";

export const RUNS_LIMIT = 50;
/** 矩阵每页 6 张（3×2），多于 6 个才翻页 */
export const PAGE_SIZE = 6;
export const MATRIX_FLIP_MS = 15_000;
/** 事件侧栏初始容量（实测自适配只会往下摘，不会超过它） */
export const EV_MAX = 3;

const WD = ["日", "一", "二", "三", "四", "五", "六"];

/** ?mock=bigscreen-* 时钉死时钟到假数据基准（截图可复现；见 mocks/handlers.ts） */
function pinnedNow(): number | null {
  if (typeof location === "undefined") return null;
  const m = new URLSearchParams(location.search).get("mock");
  return m?.startsWith("bigscreen") ? Date.UTC(2026, 7, 22, 4, 12, 0) : null;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ---------- 图标（照原型 IC 表，线性 stroke） ----------
const IC: Record<string, ReactElement> = {
  shield: <><path d="M12 3l7.5 3v5.2c0 4.3-3 7.6-7.5 8.8-4.5-1.2-7.5-4.5-7.5-8.8V6z" /><path d="M12 9v3.6" /><circle cx="12" cy="15.8" r=".95" fill="currentColor" stroke="none" /></>,
  x: <><circle cx="12" cy="12" r="8.5" /><path d="M9 9l6 6M15 9l-6 6" /></>,
  alert: <><path d="M12 4.5l8.5 15h-17z" /><path d="M12 10v4" /><circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none" /></>,
  skip: <><circle cx="12" cy="12" r="8.5" /><path d="M8.6 8.6l6.8 6.8" /></>,
  trend: <><path d="M4 7l5.5 6.5 3.5-3L20 17" /><path d="M20 12v5h-5" /></>,
  check: <path d="M20 6.5L9.5 17 4.5 12" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.6V12l3.2 2" /></>,
  chart: <path d="M4 17l4.5-5.5 3.5 3L16.5 8 20 11.5" />,
  /** 2×2 卡片阵 —— 呼应下方 Agent 健康矩阵（这格的数就是矩阵全集数） */
  agents: <><rect x="3.6" y="3.6" width="7.2" height="7.2" rx="1.8" /><rect x="13.2" y="3.6" width="7.2" height="7.2" rx="1.8" /><rect x="3.6" y="13.2" width="7.2" height="7.2" rx="1.8" /><rect x="13.2" y="13.2" width="7.2" height="7.2" rx="1.8" /></>,
};

function Ic({ name, size = 24, sw = 1.9 }: { name: string; size?: number; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {IC[name]}
    </svg>
  );
}

// ---------- 迷你趋势线（照原型 sparkline） ----------
function Sparkline({ vals, w, h, color, fill }: {
  vals: number[]; w: number; h: number; color: string; fill?: string;
}) {
  if (vals.length < 2) return null;
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  const pad = (max - min) * 0.18 || 0.02;
  min -= pad;
  max += pad;
  const pts = vals.map((v, i) => [
    Math.round(i * (w / (vals.length - 1)) * 10) / 10,
    Math.round((h - ((v - min) / (max - min)) * h) * 10) / 10,
  ]);
  const line = pts.map((p) => `${p[0]},${p[1]}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      {fill && <polygon points={`${line} ${w},${h} 0,${h}`} fill={fill} />}
      <polyline points={line} fill="none" stroke={color} strokeWidth="2.6"
        strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="3.4" fill={color} />
    </svg>
  );
}

function scoreCls(s: number | null): string {
  return s == null ? "na" : s >= 0.80 ? "ok" : s >= 0.70 ? "warn" : "bad";
}

// ---------- 4K 自适配：量测视口，整体 transform scale（原型建议） ----------
function useStageScale(): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const update = () =>
      setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return scale;
}

// ============================================================
export default function BigscreenPage() {
  const pinned = pinnedNow();
  const [now, setNow] = useState(() => pinned ?? Date.now());
  useEffect(() => {
    if (pinned != null) return; // 钉死时钟：截图/手验两态数据基准
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [pinned]);

  // 30s 轮询：大屏无人操作，数据自己活。窗口失焦也照刷（挂墙场景永远"失焦"）。
  const plansQuery = useQuery({
    queryKey: ["bigscreen-plans"],
    queryFn: () => apiOne<PlansEvent>({ action: "list_plans" }, "plans"),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: true,
  });
  const runsQuery = useQuery({
    queryKey: ["bigscreen-runs"],
    queryFn: () =>
      apiOne<BigscreenRunsEvent>({ action: "list_recent_runs", limit: RUNS_LIMIT }, "recent_runs"),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: true,
  });

  const plans = plansQuery.data?.plans;
  const runs = runsQuery.data?.runs;

  const kpi = deriveKpi(runs, plans, now);
  const agents = deriveAgents(runs, plans);
  const events = deriveEvents(runs);
  const lamp = deriveLamp(events, agents.length);

  // 数据陈旧保护：拉取失败或超 2 个周期无更新 → 顶条转灰 + 停止更新提示
  const lastUpdated = Math.max(plansQuery.dataUpdatedAt, runsQuery.dataUpdatedAt);
  const stale = deriveStale(
    now, lastUpdated || null, plansQuery.isError || runsQuery.isError,
  );

  const scale = useStageScale();

  return (
    <div
      className={
        `bs-root${lamp.state === "bad" ? " bs-alert" : ""}${pinned != null ? " bs-freeze" : ""}`
      }
      data-testid="bigscreen-root"
    >
      <div
        className="bs-stage"
        data-testid="bigscreen-stage"
        style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
      >
        <div className="bs-aurora" aria-hidden="true">
          <i className="bs-b1" /><i className="bs-b2" /><i className="bs-gridbg" />
        </div>
        <div className="bs-grid">
          <TopBar lamp={lamp} now={now} stale={stale} />
          {/* agents 与 AgentMatrix 是同一个数组：KPI 格主数字与矩阵头 N 同源 */}
          <KpiBand kpi={kpi} runs={runs} agents={agents} />
          <section className="bs-mid">
            <AgentMatrix agents={agents} now={now} />
            <EventsPanel events={events} now={now} />
          </section>
          <RunsStrip runs={runs} />
        </div>
      </div>
    </div>
  );
}

// ================= 顶条 =================
function TopBar({ lamp, now, stale }: {
  lamp: ReturnType<typeof deriveLamp>;
  now: number;
  stale: ReturnType<typeof deriveStale>;
}) {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <header
      className={`bs-glass bs-top${stale.stale ? " is-stale" : ""}`}
      data-testid="bs-top"
    >
      <div className="bs-brand">
        <div className="bs-brand-mark" aria-hidden="true">
          <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="#0F172A"
            strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
          </svg>
        </div>
        <div>
          <div className="bs-brand-name">AgentGate</div>
        </div>
        <span className="bs-env">prod</span>
      </div>
      <div className="bs-spacer" />
      <div className={`bs-lamp ${stale.stale ? "stale" : lamp.state}`} data-testid="bs-lamp">
        <span className="bs-lamp-dot" />
        <div>
          <div className="bs-lamp-txt">{lamp.txt}</div>
          <div className="bs-lamp-sub">{lamp.sub}</div>
        </div>
      </div>
      <div className="bs-clock">
        <div className="bs-clock-t num">{pad(d.getUTCHours())}:{pad(d.getUTCMinutes())}</div>
        <div className="bs-clock-d">
          <span>
            {d.getUTCFullYear()}-{pad(d.getUTCMonth() + 1)}-{pad(d.getUTCDate())}
            {" 周"}{WD[d.getUTCDay()]} UTC
          </span>
          <i className="bs-dot-sep" />
          {stale.stale ? (
            <span className="bs-refresh is-stale" data-testid="bs-stale">
              <i className="bs-sp" />数据已停止更新 {stale.minutes} 分钟
            </span>
          ) : (
            <span className="bs-refresh" data-testid="bs-refresh">
              <i className="bs-sp" />
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

// ================= KPI 带 =================
function KpiBand({ kpi, runs, agents }: {
  kpi: BigscreenKpi;
  runs: BigscreenRun[] | undefined;
  agents: AgentHealth[];
}) {
  const breachOn = kpi.breach != null && kpi.breach > 0;
  // 「需关注」与矩阵头同一个函数（derive.needsAttentionCount）——同词也同判据
  const attention = needsAttentionCount(agents);
  const runningN = agents.filter((a) => a.running).length;
  // hero 趋势：全部有分 run 的 observe 分按时间升序（全局趋势，有分才画）
  const heroHist = (runs ?? [])
    .filter(isScored)
    .sort((a, b) => parseUtc(a.started_at) - parseUtc(b.started_at))
    .map((r) => scoreOf(r) as number);

  // 分段口径 = runOutcome（按环节判定）。「有分数」改成「完成」：纯回归/
  // 纯红队 run 有结果但没有 observe 分，旧口径把它们从所有分段里排除掉，
  // 分段合计小于 runs24（UI-013）。「部分失败」是 UI-025 新增分段，复用
  // 既有琥珀/红两色，不新造颜色。
  const seg = [
    { n: kpi.ok24, c: "#22C55E", l: "完成" },
    { n: kpi.err24, c: "#EF4444", l: "失败" },
    { n: kpi.partial24, c: "#F59E0B", l: "部分失败" },
    // D-3：与全站同词（derive.NO_SCORE_TEXT，权威是 scoring 的 nodata label）
    { n: kpi.noscore24, c: "#F59E0B", l: NO_SCORE_TEXT },
    { n: kpi.skip24, c: "#64748B", l: "跳过" },
    { n: kpi.running24, c: "#60A5FA", l: "运行中" },
  ].filter((x) => x.n > 0);
  const tot = seg.reduce((a, x) => a + x.n, 0) || 1;

  const C = 2 * Math.PI * 30;
  const pr = kpi.passRate;

  return (
    <section className="bs-kpis" data-testid="bs-kpis">
      {/* 1. hero 线上评估均分 */}
      <div className="bs-glass bs-kpi bs-kpi-hero" data-testid="bs-kpi-avg">
        <div className="bs-kpi-k"><Ic name="chart" />线上评估均分</div>
        <div className="bs-kpi-v">
          {/* 并置处向下取整（threshold-adjacent-precision 方案 c）：脚注「目标线
              ≥ 0.70」就在同格，toFixed(2) 四舍五入会把 [0.695, 0.70) 印成 0.70。
              ⚠️ avg 是 round4 分数的裸算术平均（deriveKpi 刻意不再 round）——
              0.69996667 这类值 floor 成 0.69 恰是诚实方向；给 avg 补 round4
              会把它变回 0.70、与「低于目标线」的事实相反，把矛盾反向造回来。 */}
          <span className="bs-kpi-n num">{fmtScoreFloor(kpi.avg)}</span>
          {kpi.delta != null && (
            <span className={`bs-delta ${kpi.delta >= 0 ? "up" : "down"} num`}>
              {kpi.delta >= 0 ? "▲" : "▼"}{Math.abs(kpi.delta).toFixed(2)}
            </span>
          )}
        </div>
        <div className="bs-spark">
          {heroHist.length >= 2 && (
            <Sparkline vals={heroHist} w={420} h={28} color="#4ADE80" fill="rgba(34,197,94,.16)" />
          )}
        </div>
        <div className="bs-kpi-foot">
          {/* 「目标线」写全：CONTEXT.md「目标线」词条 _不指_ 被测 Agent，文案里
              不得简写成「目标」—— 大屏这一格与红队卡同屏，裸「目标」两义 */}
          <span>目标线 <span className="num" style={{ color: "var(--text)" }}>≥ 0.70</span></span>
          <i className="bs-dot-sep" />
          <span>样本 <span className="num">{kpi.avgN}</span> 次有分运行</span>
        </div>
      </div>

      {/* 2. 评估监控 Agent（用户第一问「多少个 agent 在评估监控」——紧跟 hero 的
          第一眼位）。主数字 = deriveAgents 全集（与下方矩阵同一个数组，禁止再算
          第二遍）；副行「M 个需关注」与矩阵头同词同函数，>0 染琥珀（需关注含
          warn 级，比 breach 的红轻一档），=0 中性绿「全部健康」。 */}
      <div className="bs-glass bs-kpi" data-testid="bs-kpi-agents">
        <div className="bs-kpi-k"><Ic name="agents" />评估监控 Agent</div>
        <div className="bs-kpi-v">
          <span className="bs-kpi-n num">{agents.length}</span>
          <span className="bs-kpi-u">个</span>
        </div>
        <div className="bs-kpi-foot">
          {attention > 0 ? (
            <span style={{ color: "var(--warn, #FBBF24)", fontWeight: 500 }}>
              <span className="num">{attention}</span> 个需关注
            </span>
          ) : (
            <span style={{ color: "#5BE68C" }}>全部健康</span>
          )}
          {runningN > 0 && (
            <>
              <i className="bs-dot-sep" />
              <span><span className="num">{runningN}</span> 个运行中</span>
            </>
          )}
        </div>
      </div>

      {/* 3. 近 24h 运行 */}
      <div className="bs-glass bs-kpi" data-testid="bs-kpi-runs24">
        <div className="bs-kpi-k"><Ic name="clock" />近 24h 运行</div>
        <div className="bs-kpi-v">
          <span className="bs-kpi-n num">{kpi.runs24}</span>
          <span className="bs-kpi-u">次</span>
        </div>
        <div className="bs-segbar">
          {seg.map((x) => (
            <i key={x.l} style={{ flex: `0 0 ${(x.n / tot) * 100}%`, background: x.c }} />
          ))}
        </div>
        <div className="bs-legend">
          {seg.map((x) => (
            <span key={x.l}>
              <i style={{ background: x.c }} />{x.l} <span className="num">{x.n}</span>
            </span>
          ))}
        </div>
      </div>

      {/* 4. 回归通过率 */}
      <div className="bs-glass bs-kpi" data-testid="bs-kpi-pass">
        <div className="bs-kpi-k"><Ic name="check" sw={2.2} />回归通过率</div>
        <div className="bs-kpi-v" style={{ alignItems: "center", gap: 20 }}>
          <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true" style={{ flex: "0 0 auto" }}>
            <circle cx="38" cy="38" r="30" fill="none" stroke="rgba(255,255,255,.11)" strokeWidth="8" />
            {pr != null && (
              <circle cx="38" cy="38" r="30" fill="none" stroke="#22C55E" strokeWidth="8"
                strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - pr)}
                transform="rotate(-90 38 38)" />
            )}
          </svg>
          <span>
            <span className="bs-kpi-n num" style={{ fontSize: 76 }}>
              {pr == null ? "—" : (pr * 100).toFixed(1)}
            </span>
            <span className="bs-kpi-u">%</span>
          </span>
        </div>
        <div className="bs-kpi-foot">
          <span><span className="num">{kpi.passN}</span> 个回归 run</span>
          {kpi.dsErr > 0 && (
            <>
              <i className="bs-dot-sep" />
              <span style={{ color: "var(--bs-danger-fg)" }}>{kpi.dsErr} 次失败</span>
            </>
          )}
        </div>
      </div>

      {/* 5. 红队攻破（从 stage_summaries[].breached 聚合） */}
      <div className={`bs-glass bs-kpi${breachOn ? " breach" : ""}`} data-testid="bs-kpi-breach">
        <div className="bs-kpi-k"><Ic name="shield" />红队攻破 · 近 24h</div>
        <div className="bs-kpi-v">
          <span className="bs-kpi-n num" style={breachOn ? undefined : { color: "#5BE68C" }}>
            {kpi.breach == null ? "—" : kpi.breach}
          </span>
          <span className="bs-kpi-u">{kpi.breach == null ? "无红队 run" : "次"}</span>
        </div>
        <div className="bs-kpi-foot">
          {kpi.breach == null ? (
            <span>近 24h 未执行红队测试</span>
          ) : breachOn ? (
            <span style={{ color: "#FF9E9E", fontWeight: 500 }}>
              {kpi.attacks} 次攻击中被攻破 —— 需立即处理
            </span>
          ) : (
            <span><span className="num">{kpi.attacks}</span> 次攻击全部抵御</span>
          )}
        </div>
      </div>
    </section>
  );
}

// ================= Agent 健康矩阵 =================
function AgentMatrix({ agents, now }: { agents: AgentHealth[]; now: number }) {
  const pages = Math.max(1, Math.ceil(agents.length / PAGE_SIZE));
  const [page, setPage] = useState(0);

  // >6 卡才翻页；reduced-motion 停翻页。异常排前保证恒在第一页。
  useEffect(() => {
    if (pages <= 1 || prefersReducedMotion()) return;
    const id = setInterval(() => setPage((p) => (p + 1) % pages), MATRIX_FLIP_MS);
    return () => clearInterval(id);
  }, [pages]);
  const cur = ((page % pages) + pages) % pages;
  const slice = agents.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);
  // 判据单一住所（derive.needsAttentionCount）：KPI 带「评估监控 Agent」副行同源
  const abnormal = needsAttentionCount(agents);

  return (
    <div className="bs-glass bs-panel" data-testid="bs-matrix">
      <div className="bs-ph">
        <h2>Agent 健康矩阵</h2>
        <span className="bs-note">
          <span className="num">{agents.length}</span> 个 Agent
          {abnormal > 0
            ? <> · <span style={{ color: "var(--warn, #FBBF24)" }}>{abnormal} 个需关注（已排前）</span></>
            : " · 全部健康"}
        </span>
        <div className="bs-spacer" />
        {pages > 1 && (
          <>
            <span className="bs-pb num">第 {cur + 1} / {pages} 页</span>
            <div className="bs-pager" data-testid="bs-pager">
              {Array.from({ length: pages }).map((_, i) => (
                <i key={i} className={i === cur ? "on" : ""} />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="bs-matrix">
        {slice.map((a) => <AgentCard key={a.name} a={a} now={now} />)}
        {agents.length === 0 && (
          <div className="bs-matrix-empty" data-testid="bs-matrix-empty">暂无 Agent 数据</div>
        )}
      </div>
    </div>
  );
}

function AgentCard({ a, now }: { a: AgentHealth; now: number }) {
  const cls = a.level === "bad" ? "bad" : a.level === "warn" || a.level === "idle" ? "warn" : "";
  const col = a.level === "bad" ? "#FF8A8A" : a.level === "warn" ? "#FBBF24" : "#4ADE80";
  const fill = a.level === "bad" ? "rgba(239,68,68,.15)"
    : a.level === "warn" ? "rgba(251,191,36,.13)" : "rgba(34,197,94,.14)";
  // 主数字口径：有 observe 分用分；否则退回归通过率；再否则才是「—」。
  // 绝不"分数显示 — 但旁边照画趋势线"——有 observe 分才画线（原型的诚实规则）。
  // 显示用 floor：与同卡「低于目标」标签（derive.ts 按四位判 <0.70）并置，
  // 低于线的值不许被 toFixed(2) 舍入印成 0.70（threshold-adjacent-precision）。
  let headline = fmtScoreFloor(a.score);
  let hcls = scoreCls(a.score);
  const showSpark = a.score != null;
  if (a.score == null && a.pass != null) {
    headline = `${(a.pass * 100).toFixed(1)}%`;
    hcls = a.pass >= 0.9 ? "ok" : "warn";
  }
  return (
    <div className={`bs-acard ${cls}`} data-testid={`bs-acard-${a.name}`} data-level={a.level}>
      <div className="bs-a-top">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="bs-a-name">{a.name}</div>
          <div className="bs-a-id num">{a.plans} 个评估计划</div>
        </div>
        <span className={`bs-a-dot ${a.level}`} />
      </div>
      <div className="bs-a-mid">
        <span className={`bs-a-score num ${hcls}`}>{headline}</span>
        {showSpark ? (
          <span className="bs-a-spark" data-testid={`bs-spark-${a.name}`}>
            <Sparkline vals={a.hist} w={150} h={34} color={col} fill={fill} />
          </span>
        ) : (
          <span className="bs-a-spark bs-a-nospark">无线上评估分</span>
        )}
      </div>
      <div className="bs-a-foot">
        {a.tag && <span className={`bs-a-tag ${a.tag.c}`}>{a.tag.t}</span>}
        {a.running && <span className="bs-a-tag run">运行中</span>}
        <span>{a.latest ? ago(a.latest.started_at, now) : "无运行记录"}</span>
      </div>
    </div>
  );
}

// ================= 事件侧栏 =================
function EventsPanel({ events, now }: { events: BigscreenEvent[]; now: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [maxShow, setMaxShow] = useState(EV_MAX);

  // 事件集变了 → 从初始容量重试
  const evKey = events.map((e) => e.t + e.at).join("|");
  useLayoutEffect(() => {
    setMaxShow(EV_MAX);
  }, [evKey]);

  // 自适配：渲染后实测，只要溢出就摘掉最后一条并把它计入「还有 N 项」。
  // 大屏没有滚动条，靠常量猜容量迟早在某个文案长度下崩——实测收敛才可靠。
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    if (maxShow > 1 && el.scrollHeight > el.clientHeight + 1) {
      setMaxShow(maxShow - 1);
    }
  });

  const shown = events.slice(0, maxShow);
  const rest = events.length - shown.length;

  return (
    <div className="bs-glass bs-panel" data-testid="bs-events">
      <div className="bs-ph">
        <h2>待处理事项</h2>
        <span className="bs-note">
          {events.length
            ? <><span className="num">{events.length}</span> 项{rest > 0 ? ` · 显示前 ${shown.length}` : ""}</>
            : "无"}
        </span>
      </div>
      {events.length === 0 ? (
        <div className="bs-events">
          <div className="bs-empty-ok" data-testid="bs-events-empty">
            <div className="bs-empty-ico"><Ic name="check" size={46} sw={2.6} /></div>
            <div className="bs-empty-t">无待处理事项</div>
          </div>
        </div>
      ) : (
        <div className="bs-events" ref={boxRef}>
          {shown.map((e, i) => (
            <div className={`bs-ev ${e.lv}`} key={`${e.t}-${e.at}-${i}`}>
              <span className="bs-ev-ico"><Ic name={e.ic} size={21} sw={2.1} /></span>
              <span className="bs-ev-b">
                <span className="bs-ev-t">{e.t}</span>
                <span className="bs-ev-d">{e.d}</span>
              </span>
              <span className="bs-ev-when num">{ago(e.at, now)}</span>
            </div>
          ))}
          {rest > 0 && (
            <div className="bs-ev-more" data-testid="bs-ev-more">
              还有 <span className="num">{rest}</span> 项待处理 —— 详见评估计划
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ================= 最近运行带 =================
function RunsStrip({ runs }: { runs: BigscreenRun[] | undefined }) {
  const sorted = [...(runs ?? [])]
    .sort((a, b) => parseUtc(b.started_at) - parseUtc(a.started_at))
    .slice(0, 10);
  return (
    <section className="bs-glass bs-strip" data-testid="bs-strip">
      <div className="bs-ph">
        <h2>最近运行</h2>
        <span className="bs-note">近 <span className="num">{sorted.length}</span> 次 · 按时间倒序</span>
        <div className="bs-spacer" />
      </div>
      <div className="bs-strip-body">
        {sorted.map((r) => <RunCell key={r.run_key} r={r} />)}
        {sorted.length === 0 && (
          <div className="bs-strip-empty" data-testid="bs-strip-empty">暂无运行记录</div>
        )}
      </div>
    </section>
  );
}

function RunCell({ r }: { r: BigscreenRun }) {
  const s = scoreOf(r);
  const pr = passRateOf(r);
  const b = breachOf(r);
  // 判定顺序不可调换（lib/scoring.ts runOutcome 同序）：
  // 顶层非终态 → **环节失败** → 具体指标 → 无可评估数据。
  // 环节失败一定要排在指标前面：部分失败的 run 也有指标，若先读指标就会
  // 显示成一个漂亮的分数，把炸掉的环节盖掉（UI-025）。
  const oc = outcomeOf(r);
  let cls = ""; let dot = "ok"; let val = ""; let vcls = "na";
  if (r.status === "error") { cls = "bad"; dot = "bad"; val = "失败"; vcls = "bad"; }
  else if (r.status === "skipped") { cls = "skip"; dot = "skip"; val = "跳过"; vcls = "na"; }
  else if (r.status === "running") { cls = "run"; dot = "run"; val = "运行中"; vcls = "na"; }
  else if (oc.kind === "failed") { cls = "bad"; dot = "bad"; val = "失败"; vcls = "bad"; }
  else if (oc.kind === "partial") { cls = "bad"; dot = "warn"; val = "部分失败"; vcls = "warn"; }
  else if (b != null && b > 0) { cls = "bad"; dot = "bad"; val = `${b} 攻破`; vcls = "bad"; }
  else if (b != null) { dot = "ok"; val = "0 攻破"; vcls = "ok"; }
  // 分数格与 <0.70 判定同一行并置 → 显示用 fmtScoreFloor（低于线的值显不出 0.70）
  else if (s != null) { cls = s < 0.70 ? "bad" : ""; dot = s < 0.70 ? "warn" : "ok"; val = fmtScoreFloor(s); vcls = scoreCls(s); }
  else if (pr != null) { dot = "ok"; val = `${(pr * 100).toFixed(1)}%`; vcls = pr >= 0.9 ? "ok" : "warn"; }
  // D-3：同词（此前这格叫「未计分」，而方案详情/导出叫「无可评估数据」）
  else { cls = "skip"; dot = "warn"; val = NO_SCORE_TEXT; vcls = "na"; }
  return (
    <div className={`bs-rcell ${cls}`} data-testid={`bs-rcell-${r.run_key}`} data-state={dot}>
      <div className="bs-r-top">
        <span className={`bs-st-dot ${dot}`} />
        <span className="bs-r-name">{r.plan_name}</span>
      </div>
      <div className="bs-r-mid">
        <span className={`bs-r-score num ${vcls}`}>{val}</span>
      </div>
      <div className="bs-r-foot"><span className="num">{fmtHM(r.started_at)}</span></div>
    </div>
  );
}
