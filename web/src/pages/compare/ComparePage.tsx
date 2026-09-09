// 跨版本对比独立页（`#/compare`，可带 `#/compare/<aKey>/<bKey>`）。
//
// 为什么要有这一页：方案详情里的对比抽屉只能在**同一个方案**的运行历史里挑两条，
// 而「换了一版 Agent，评估方案也跟着改了」是真实发生的事（航空案例：v1 只有线上
// 评估，v3 加了回归 + 红队 ⇒ 两个方案）。抽屉那条路在结构上到不了跨方案的那一对：
// 候选池就是本方案的历史。所以出口不是把抽屉改宽，而是**把「选两个 run」这件事
// 从某个方案里拎出来**——池子来自 `list_recent_runs`（多方案混排）。
//
// 分工（本页只做壳，判据一概不在这里）：
//   本页        = 候选池 + 筛选 + 选两条 + URL 镜像 + 空态
//   CompareView = 两栏身份 / 口径披露 / 逐量纲指标 / 用例三桶（与抽屉同一份）
//   compare/derive.ts = 谁在左、怎么分桶、哪些量纲不许合成
// 「谁在左」不是本页决定的：`orderComparePair` 按 started_at 排，**较早的恒在左**
// ⇒ 两条选择的先后、URL 里两个 key 的先后，都不影响读出来的结论（换序不变）。
//
// 后端零改动：`list_recent_runs`（app/planrun.py:1745）本来就是跨方案的 run 流。
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import PageHeader from "../../components/layout/PageHeader";
import { fmtRunTime } from "../../lib/time";
import { fmtScoreExact, runBadge } from "../../lib/scoring";
import { sortRunsDesc } from "../plan/derive";
import { orderComparePair } from "../plan/compare/derive";
import {
  CompareView, SIDE_WORD, type CompareFocus, type CompareViewRun,
} from "../plan/compare/CompareView";
// 跨 run 区块（趋势图 / 两段卡 / 采纳追踪表，ADR-0014 后果②④）：只在两次都选上时挂
import AnalysisSections from "./AnalysisSections";
// 同题配对 tab（ADR-0017 D3，变体 B）：配对表 + 行内展开双栏 diff / 单栏回放
import PairsCard, { usePairRows } from "./PairsTable";
import type { RecentRunsEvent, RunSummary } from "../agents/types";
import "./compare.css";
import "./pairs.css";

/**
 * 候选池大小。工作台/大屏取 20（那是「最近发生了什么」），对比要往回翻好几个版本
 * ⇒ 明显更大。后端硬顶 500（planrun.py list_recent_runs），这里留余量。
 * ⚠️ queryKey 带上它：工作台的 `["recent-runs"]` 是 limit=20 的那一份，共用同一个
 * key 会让先加载的那页决定另一页看到多少条（缓存命中，谁也不会报错）。
 */
const POOL_LIMIT = 200;

/** 选择上限恒 2：对比的是「上一次 vs 这一次」，三栏没有定义。 */
const MAX_SEL = 2;

export default function ComparePage({ aKey, bKey }: { aKey: string; bKey: string }) {
  const runsQuery = useQuery({
    queryKey: ["recent-runs", POOL_LIMIT],
    queryFn: () =>
      apiOne<RecentRunsEvent>({ action: "list_recent_runs", limit: POOL_LIMIT }, "recent_runs"),
  });

  // 池子按时间倒序（最新在前）：CompareView 的 `#N` 序号**按数组下标**算，所以序
  // 必须与方案详情运行历史表同一个函数产出 —— 两个入口各排一次会让同一次运行在
  // 两处拿到两个 `#N`。（后端 list_recent_runs 也按 (started_at, started_epoch)
  // 倒序返回；这里不是纠正它，而是让「谁排的」只有一个答案。）
  // ⚠️ 「谁在左」不看这个序：那是 orderComparePair 直接比时刻的事（见文件头）。
  const pool = useMemo<CompareViewRun[]>(
    () => sortRunsDesc((runsQuery.data?.runs ?? []).map(toViewRun)),
    [runsQuery.data],
  );

  // 选中的 run_key。**只存 key 不存顺序**——顺序由时间决定（见文件头）。
  const [sel, setSel] = useState<string[]>(() => [aKey, bKey].filter((k) => k !== ""));
  const [agent, setAgent] = useState("");
  const [q, setQ] = useState("");

  // URL 镜像：可分享、可刷新、可后退到别的页再回来。
  // 用 replaceState 而不是 navigate/改 hash —— 改 hash 会触发 hashchange ⇒ 路由重
  // 挂载 ⇒ 每点一条就把筛选条件和另一条选择清空（本页的 route key 含两个 key）。
  useEffect(() => {
    const target = sel.length === MAX_SEL
      ? `#/compare/${encodeURIComponent(sel[0])}/${encodeURIComponent(sel[1])}`
      : "#/compare";
    if (window.location.hash !== target) {
      window.history.replaceState(null, "", target);
    }
  }, [sel]);

  function toggle(key: string) {
    setSel((cur) => {
      if (cur.includes(key)) return cur.filter((k) => k !== key);
      // 选满之后**不挤掉**任何一条，因为「选错了去掉勾再选」才是用户预期的改法
      // ——静默替换会让上一次的选择凭空消失，而用户并没有取消过它。
      // 早先这里挤掉最早那条，理由是「点了没反应」与「这行不能选」同形；现在勾选
      // 框是**真的 disabled**（可见地变灰、指针变 not-allowed、还带 title 说明），
      // 那个同形不再成立：它读起来是规则，不是页面坏了。
      if (cur.length >= MAX_SEL) return cur;
      return [...cur, key];
    });
  }

  const agents = useMemo(() => {
    const set = new Set<string>();
    for (const r of pool) if (r.agent_name) set.add(r.agent_name);
    return [...set].sort();
  }, [pool]);

  const kw = q.trim().toLowerCase();
  const shown = useMemo(() => pool.filter((r) => {
    if (agent && r.agent_name !== agent) return false;
    if (!kw) return true;
    const hay = [r.plan_name, r.agent_name, r.run_key, r.agent_version_label, r.status]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(kw);
  }), [pool, agent, kw]);

  const picked = sel.map((k) => ({ key: k, run: pool.find((r) => r.run_key === k) }));
  const poolReady = runsQuery.isSuccess;
  const missing = picked.filter((p) => !p.run).map((p) => p.key);
  const pair = sel.length === MAX_SEL && missing.length === 0
    ? orderComparePair(pool, sel[0], sel[1])
    : null;
  const full = sel.length >= MAX_SEL;

  /**
   * 这条 run 在对比里是哪一栏。**只选了一条时恒 null** —— 那时方向还没定，
   * 提前上色等于替时间做决定（谁是「上一次」由 orderComparePair 比 started_at 算，
   * 不看勾选先后）。宁可中性，也不给一个可能反过来的身份。
   * ⚠️ `pair` 为 null 的成因不止「只选了一条」：还有 missing、同一条选两次。
   * 这几种下面都轮不到结果区，所以这里一概按「没身份」处理。
   */
  const sideOf = (key: string): "a" | "b" | null =>
    !pair ? null : pair.aKey === key ? "a" : pair.bKey === key ? "b" : null;

  // 两段卡的引用 chip → 逐用例对照那一行（ADR-0014 后果④双向深链）。
  // nonce 递增：同一条再点一次也要再滚一次（title 不变时没有别的东西会变）。
  const [focus, setFocus] = useState<CompareFocus | null>(null);
  const focusNonce = useRef(0);
  const jumpTo = (title: string) => {
    focusNonce.current += 1;
    setFocus({ title, nonce: focusNonce.current });
  };

  // 结果区两个 tab：「对比」= 原有三段 + 跨 run 区块；「同题配对 N」= ADR-0017 D3。
  // tab 态只在内存（router 不在本批白名单，不进 URL）；配对行数一到就上 tab。
  const [tab, setTab] = useState<"compare" | "pairs">("compare");
  const pairRows = usePairRows(pair);

  return (
    <section data-testid="page-compare" className="cmp-page">
      <PageHeader title="评估分析" testid="compare-head" />

      <div className="card" data-testid="compare-picker">
        <div className="card-head">
          <span className="card-title">候选运行</span>
          <span className="card-sub">最近 {POOL_LIMIT} 次</span>
          <span className="spacer" />
          <span className="cp-selcount" data-testid="compare-selcount">
            已选 {sel.length} / {MAX_SEL}
          </span>
          {/* 选满之后其余勾选框会灰掉；这里只说状态。「去掉一个勾再选别的」那半句
              是操作说明，对任何用户恒成立 ⇒ 删（prose-sweep 2026-09-03） */}
          {full && (
            <span className="cp-selfull" data-testid="compare-selfull">
              已选满
            </span>
          )}
          {sel.length > 0 && (
            <button
              type="button"
              className="btn-link"
              data-testid="compare-clear"
              onClick={() => setSel([])}
            >
              清空
            </button>
          )}
        </div>

        <div className="cp-filters" data-testid="compare-filters">
          <label className="cp-f">
            <span className="cp-flabel">Agent</span>
            <select
              className="u-select"
              data-testid="compare-filter-agent"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
            >
              <option value="">全部</option>
              {agents.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="cp-f cp-f-grow">
            <span className="cp-flabel">搜索</span>
            <input
              className="u-input"
              data-testid="compare-filter-q"
              placeholder="计划名 / Agent / 版本标签 / run key"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
        </div>

        {/* 已选行单独列一遍：筛选条件一改就可能把选中的那条藏起来，
            那时「清空」是唯一出口，而用户看不到自己选了什么。
            这里也是身份色的**文字等价读数**：chip 上写着「上一次 / 这一次」，
            所以下面候选行只带颜色不加列，颜色识别有困难时这两枚 chip 照样读得出。 */}
        {sel.length > 0 && (
          <div className="cp-picked" data-testid="compare-picked">
            {picked.map((p) => {
              const side = sideOf(p.key);
              return (
                <button
                  key={p.key}
                  type="button"
                  className={side ? `chip cp-pchip is-side-${side}` : "chip cp-pchip"}
                  data-testid={`compare-picked-${p.run ? "ok" : "missing"}`}
                  title="取消选择"
                  onClick={() => toggle(p.key)}
                >
                  {side && <span className="cp-pdot" aria-hidden="true" />}
                  {side && <span className="cp-pside">{SIDE_WORD[side]}</span>}
                  {p.run
                    ? `${p.run.plan_name || p.run.agent_name || "运行"} · ${fmtRunTime(p.run.started_at)}`
                    : p.key}
                  <span aria-hidden="true"> ×</span>
                </button>
              );
            })}
            {/* 「较早的那次恒为上一次，勾选先后不影响结论」那句已删：对任何一对
                恒成立 ⇒ 文档不是界面；方向由两枚 chip 上的「上一次 / 这一次」自身承担 */}
          </div>
        )}

        {runsQuery.isError ? (
          <p className="cp-error" data-testid="compare-load-error">
            {runsQuery.error instanceof Error ? runsQuery.error.message : String(runsQuery.error)}
          </p>
        ) : runsQuery.isLoading ? (
          <div className="cp-list" aria-hidden="true" data-testid="compare-list-skeleton">
            {[0, 1, 2, 3].map((i) => <div key={i} className="cp-row cp-sk" />)}
          </div>
        ) : pool.length === 0 ? (
          <div className="u-empty" data-testid="compare-pool-empty">
            <p>还没有运行记录</p>
          </div>
        ) : shown.length === 0 ? (
          <p className="cp-none" data-testid="compare-filter-empty">
            这些筛选条件下没有运行（池子里共 {pool.length} 条）。
          </p>
        ) : (
          <div className="cp-list" data-testid="compare-list" role="list">
            {shown.map((r) => {
              const on = sel.includes(r.run_key);
              const side = sideOf(r.run_key);
              // 选满之后、且这一条没被选中 ⇒ 勾不上。用 disabled 而不是「点了不响应」：
              // 前者自带灰底与 not-allowed 指针，后者与「页面坏了」同形。
              const locked = full && !on;
              const badge = runBadge(r);
              const cls = ["cp-row", on ? "is-sel" : "", side ? `is-side-${side}` : "",
                           locked ? "is-locked" : ""].filter(Boolean).join(" ");
              return (
                // label 而不是 button：整行仍然可点（点哪都切换勾选框），但「选中」
                // 这件事由**真的 checkbox** 承载 —— 用户找的就是那个勾，
                // aria-pressed 的按钮在读屏里也报成「按钮」而不是「复选框」。
                <label
                  key={r.run_key}
                  role="listitem"
                  className={cls}
                  data-testid={`compare-row-${r.run_key}`}
                >
                  <input
                    type="checkbox"
                    className="cp-check"
                    data-testid={`compare-check-${r.run_key}`}
                    checked={on}
                    disabled={locked}
                    onChange={() => toggle(r.run_key)}
                  />
                  <span className="cp-c-time lat">{fmtRunTime(r.started_at)}</span>
                  <span className="cp-c-plan cjk">{r.plan_name || "—"}</span>
                  <span className="cp-c-agent lat">{r.agent_name || "—"}</span>
                  <span className="cp-c-ver">
                    {r.agent_version_label
                      ? <span className="chip mono">{r.agent_version_label}</span>
                      : null}
                  </span>
                  <span className={`cp-c-badge ${badge.cls}`}>{badge.label}</span>
                  {/* 端点加位（fmtScoreExact，不是全站的 fmtScore）：这一列是
                      「挑哪两次来比」的依据，而用户挑的就是分数看起来不一样的那两
                      次。0.9981 印成 1.00 会让「都满分，没什么可比」的误判发生在
                      点进对比之前 —— 现网两轮的候选行正是这个形态。 */}
                  <span className="cp-c-score num">{fmtScoreExact(r.score)}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {runsQuery.isError ? (
        // 取数失败的原话已经在选择器里了（`compare-load-error`）。这里再挂一张
        // 空态卡只会给出第二个、且更不准的解释，所以下半区留空。
        null
      ) : !poolReady && sel.length > 0 ? (
        // ⚠️ 这一支必须排在 missing 前面：「池子还没到」与「这个 key 真不在池子
        // 里」在数据上同形（两种情况下 `pool.find` 都是 undefined），而下面那张卡
        // 片说的是**更早或已被删除**——加载中就下这个结论，等于对着还在飞的请求
        // 判死刑。深链进来必经这一态（实测头一帧写的是「有 2 条运行不在候选池
        // 里」，而两条都健在）。
        <div className="u-empty" data-testid="compare-pending">
          <p>正在取候选运行…</p>
        </div>
      ) : missing.length > 0 ? (
        // URL 里带的 key 不在池子里（比它更早的运行，或已被删）。**不能只是空着**：
        // 空白与「这一对不可比」同形，而这里的成因是「没取到这条」，两件事的下一步
        // 动作完全不同（放宽范围 vs 换一对）。
        <div className="u-empty" data-testid="compare-missing">
          <p>有 {missing.length} 条运行不在候选池里</p>
          <p className="sub mono cp-missing-keys">{missing.join("、")}</p>
        </div>
      ) : pair ? (
        <>
          <div className="cp-tabs" role="tablist" aria-label="评估分析分区" data-testid="compare-tabs">
            <button
              type="button"
              role="tab"
              className="cp-tab"
              aria-selected={tab === "compare"}
              data-testid="compare-tab-compare"
              onClick={() => setTab("compare")}
            >
              对比
            </button>
            <button
              type="button"
              role="tab"
              className="cp-tab"
              aria-selected={tab === "pairs"}
              data-testid="compare-tab-pairs"
              onClick={() => setTab("pairs")}
            >
              同题配对
              {pairRows.data && <span className="n" data-testid="compare-tab-pairs-n">{pairRows.data.total}</span>}
            </button>
          </div>
          {tab === "pairs" ? (
            <PairsCard
              pair={pair}
              rows={pairRows.data}
              loading={pairRows.isLoading}
              error={pairRows.isError
                ? (pairRows.error instanceof Error ? pairRows.error.message : String(pairRows.error))
                : null}
            />
          ) : (
            <>
              {/* 跨 run 区块在既有三段之上（变体 C）：趋势图 → 两段卡 → 采纳追踪表 */}
              <AnalysisSections pair={pair} pool={pool} onJump={jumpTo} />
              <div className="card cp-result" data-testid="compare-result">
                <CompareView pair={pair} runs={pool} showOrigin focus={focus} />
              </div>
            </>
          )}
        </>
      ) : (
        <div className="u-empty" data-testid="compare-empty">
          <p>勾选两次运行开始对比</p>
        </div>
      )}
    </section>
  );
}

/**
 * `list_recent_runs` 的行 → 共享视图契约。
 *
 * 为什么要这一层：同一个 action 的行形状在仓里已有三处声明（workbench / agents /
 * bigscreen 各一份，字段可选性还不一致），CompareView 的契约取的是并集。这里
 * **复用 agents 那一份**（唯一带 `agent_version_label` 的：两栏身份的版本 chip
 * 读它），只把三个「那边可选、视图必需」的字段显式补齐 —— 逐字段写而不是 `as`：
 * 真有字段不兼容时这里会红，`as` 会把它咽下去。
 * ⚠️ `?? null` 补的是**缺键**，不是「值是 0」：三个字段都不是数值语义的 0。
 */
function toViewRun(r: RunSummary): CompareViewRun {
  return {
    ...r,
    score: r.score ?? null,
    started_at: r.started_at ?? null,
    duration_s: r.duration_s ?? null,
  };
}
