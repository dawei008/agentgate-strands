// 分数趋势卡：两套口径，按方案实际产出的数据自动选。
//
// (A) 有线上评估分的方案（原口径，形态照 B 案原型 plandetail.html 的「评分趋势」
//     区）：最近 N 次成功 run 的 score 折线 + 面积填充 + 目标线右侧标注 +
//     末点强调 + 右侧 hairline 区间统计列。**行为一字未改。**
// (B) 纯回归方案（没有任何有分 run，但跑出过回归环节）：改画**总体通过率主线
//     + 每个评估器一条线**。此前这类方案的趋势永远是一句「已有 0 次有分运行」
//     ——因为顶层 score 只由 observe 环节写，纯回归 run 恒为 null。用户原话：
//     「分数趋势……这里应该显示每次评估后，评估器的分数和总体分数」。
//
// 图规格照 dataviz 纪律与设计骨架 v2（ADR-0016 / tokens.css 纪律 5）：主线
// strokeWidth 2 = --viz-stroke、逐评估器次序列 1.5 = --viz-stroke-min（任何趋势线
// 的下限）、数据点 r=4 = --viz-dot、点带 2px 底色圈、面积渐变顶部 stop-opacity .18
// = --viz-1-fill（必画，不低于此值）、hairline 实线网格、文字一律文本色（不穿数据色）。
// 这些常量在 SVG 属性里只能写数字，故此处记来源令牌名，改令牌时同步改这里。
// 单序列（口径 A）不出图例；多序列（口径 B）出图例，否则四条线没法认——图例项带
// 最近一次的数字，「谁在拖」一眼可见。
//
// (C) 两套口径共有的**版本变更竖线**（deploy marker）：相邻两次运行的版本标签
//     不同就画一条，标注新标签。数据只来自 run **自己的快照**
//     （agent_version_label，落库那一刻冻结）—— 见 derive.versionMarkers 的护栏说明。
//
// ⚠️ ADR-0003 硬线：口径 B 的数字**只活在这张卡里**。总体线只能是后端算好的
// pass_rate，逐评估器均分绝不 reduce 成一个「总分」（那会流进「线上评估均分」
// KPI 与跨方案聚合）。本卡不新增任何「有没有分」的判据 —— 那条口径的物理住所
// 只有 lib/scoring.ts：isScored 的取分口径见该文件头部说明（effectiveScore
// 读侧兜底），本卡照用不复制。
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer, Label,
} from "recharts";
import type { PlanRunSummary, PlanStage } from "./types";
import {
  evSeriesKey, planMetricKind, regressionRunsAsc, regressionTrend, scoredRunsAsc,
  trendEmptyReason, trendPoints, trendStats, versionMarkerText, versionMarkers,
  SCORE_TARGET,
  type RegressionTrend, type TrendPoint, type TrendStats, type VersionMarker,
} from "./derive";
import { fmtPctInt, isRunSuccess, isScored } from "../../lib/scoring";

/** 目标线：与环节 warn 判定同一条（derive.SCORE_TARGET，全站单一来源） */
export const TREND_TARGET = SCORE_TARGET;

/** 逐评估器序列色（次序列；主线通过率走 --viz-1 绿）。令牌定义在 plan.css 的
 *  .plan-trend-wrap 上。评估器多于色数时循环复用——同色不同名靠图例里的名字
 *  区分，比硬造八种暗底可辨色更诚实。 */
const EV_COLORS = ["var(--ev-1)", "var(--ev-2)", "var(--ev-3)", "var(--ev-4)", "var(--ev-5)"];

/** 末点强调：最后一个点画大号实心点 + 外环（原型的末点处理） */
function TrendDot({ cx, cy, index, total }: {
  cx?: number; cy?: number; index?: number; total: number;
}) {
  if (cx == null || cy == null) return null;
  if (index !== total - 1) {
    return <circle cx={cx} cy={cy} r={4} fill="var(--viz-1)" stroke="var(--panel)" strokeWidth={2} />;
  }
  return (
    <g data-testid="trend-last-dot">
      <circle cx={cx} cy={cy} r={7} fill="none" stroke="var(--viz-1)" strokeWidth={1} opacity={0.28} />
      <circle cx={cx} cy={cy} r={4.5} fill="var(--viz-1)" stroke="var(--panel)" strokeWidth={2} />
    </g>
  );
}

/**
 * 版本变更竖线（图内）。
 *
 * 刻意是**返回数组的函数**而不是组件：Recharts 靠子元素的类型识别
 * `<ReferenceLine>`，包一层自定义组件它就当普通子元素扔掉（图上啥也不出）。
 */
function versionLines(markers: VersionMarker[]) {
  return markers.map((m) => (
    <ReferenceLine
      key={`${m.at}-${m.label}`}
      x={m.at}
      // 中性 hairline（--line-strong），**不用** --viz-baseline：那个琥珀色在这张
      // 图上已经是「目标线」的语义，同色会被读成又一条目标线。竖线是标注不是数据，
      // 也不许穿数据色（dataviz 纪律：文字/标注一律不穿数据色）。
      stroke="var(--line-strong)"
      strokeDasharray="2 3"
      ifOverflow="extendDomain"
    >
      {/* 标注新标签（旧标签在图下说明行的悬停文案里，图上只放一个短词）。
          字号 10 + --muted（档 trend-version-marker-contrast，P3）。
          ⚠️ 数字更正（合流侧按 glass-guard 的 WCAG 公式逐个实算）：
            改前 9px + --faint  (#7D8CA3) 压玻璃底 = **4.86:1**
            改后 10px + --muted (#94A3B8) 压玻璃底 = **6.46:1**
          档里与 commit message 里的「1.9:1 → 6.2:1」两个数**都复现不出来**
          （1.9 在任何合理底色上都算不出；tokens.css 自己记的也是 --faint vs
          --panel 4.59 / vs --bg 5.1）。也就是说改前其实已过图形文字 3:1 下限，
          真缺陷是 **9px 字号太小**；本次改动仍然成立（更大 + 更亮），只是理由
          得按实算的写。--muted 同时仍是中性色 —— 标注不许穿数据色（dataviz
          纪律，见上面竖线的选色说明）。 */}
      <Label
        value={m.label}
        position="top"
        offset={4}
        style={{ fontSize: 10, fill: "var(--muted)", fontFamily: "var(--mono)" }}
      />
    </ReferenceLine>
  ));
}

/**
 * 图下方的版本变更说明行：一项一条竖线，悬停说得出「从哪一版换到哪一版」。
 *
 * 为什么图内竖线之外还要这一行：① jsdom 下 ResponsiveContainer 量到 0×0，
 * Recharts 不渲染 svg 内部（plan.test.tsx:593 的既有说明）——图内的东西测不到；
 * ② SVG 里的标注挂不住 title 悬停，而「换到哪一版」这句话必须能读到。
 * 一条变更都没有 → 整行不画（不留一个空的「版本变更：」）。
 */
function VersionMarkerLine({ markers }: { markers: VersionMarker[] }) {
  if (markers.length === 0) return null;
  return (
    <div className="plan-trend-versions" data-testid="plan-trend-versions">
      <span className="tv-cap">版本变更</span>
      {markers.map((m) => (
        <span
          className="tv-item"
          key={`${m.at}-${m.label}`}
          data-testid={`plan-trend-version-${m.label}`}
          title={versionMarkerText(m)}
        >
          <span className="badge badge-mono">{m.label}</span>
          <span className="tv-at mono">{m.at}</span>
        </span>
      ))}
    </div>
  );
}

const PASS_RATE_LABEL = "通过率";
const fmtMean = (v: number | null) => (v == null ? "无判定" : v.toFixed(2));

export default function TrendCard({ runs, stages }: {
  runs: PlanRunSummary[];
  /** 方案定义的环节（D-2）：空态要说得出「有没有线上评估环节」——那是
   *  「成功 N 次却 0 个点」的真正原因，从 runs 里推不出来（没有 observe
   *  环节的方案，run 里也就没有 observe 环节可看）。 */
  stages?: PlanStage[];
}) {
  const points = trendPoints(runs);
  // 空态文案要把「为什么还没有图」说清楚，所以这里数的必须**与图的取样口径
  // 同一条**（isScored：有 observe 分才是一个点），不能用「成功运行数」——
  // 那条口径改成按环节判定后，纯回归/纯红队 run 也算成功，会出现「已有 3 次
  // 成功运行，趋势图需要至少 2 次」却仍是空态的自相矛盾（UI-013 的连带项）。
  const scoredCount = runs.filter(isScored).length;
  // 口径切换只发生在**一次有分 run 都没有**时：有 observe 分的方案（含
  // observe+dataset 混合方案）行为完全保持原样，回归测试钉住。
  const reg = scoredCount === 0 ? regressionTrend(runs) : null;
  const regression = reg && reg.points.length > 0 ? reg : null;
  // D-2 空态原因（追加一行，不改主句）。数据现场决定说哪一句：
  // 「没有 observe 环节」vs「有 observe 环节但尚无有分运行」是两件事。
  const reason = trendEmptyReason({
    kind: planMetricKind(stages),
    scoredCount,
    successCount: runs.filter(isRunSuccess).length,
    totalCount: runs.length,
    regressionPoints: reg?.points.length ?? 0,
  });

  if (regression) {
    return (
      <RegressionTrendCard
        reg={regression}
        reason={reason}
        markers={versionMarkers(regressionRunsAsc(runs))}
      />
    );
  }

  return (
    <div className="card" data-testid="plan-trend-card">
      <div className="card-head">
        <span className="card-title">分数趋势</span>
        {/* 「有分运行」而非「成功运行」：本图只画 observe 分，纯回归/纯红队
            run 即使成功也没有点位，用「成功」当量词会与 KPI 的成功数打架 */}
        <span className="card-sub">最近 {points.length} 次有分运行 · 目标线 {TREND_TARGET}</span>
      </div>
      {points.length < 2 ? (
        // 空态：把触发条件显示出来——用户在线上看到空态不知道差什么
        <div className="plan-trend-empty" data-testid="plan-trend-empty">
          已有 <span className="mono">{scoredCount}</span> 次有分运行，趋势图需要至少 2 次
          {/* D-2：主句只说「差几次」，为什么可以「成功 N 次却 0 个点」在这一行
              （纯回归/纯红队方案的那句「没有线上评估环节」正是用户困惑的答案） */}
          {reason && <span className="sub" data-testid="plan-trend-empty-reason">{reason}</span>}
        </div>
      ) : (
        <ScoreTrendBody runs={runs} />
      )}
    </div>
  );
}

/**
 * 口径 A 的图体（折线 + 面积 + 目标线 + 版本竖线 + 右侧区间统计列）。
 *
 * 从 TrendCard 里**原样抽出**（adr0014-migrate 批）：评估分析页的趋势图承担
 * 原综合报告「整体趋势」段的职责，画的必须是这一张图 —— 派生（trendPoints /
 * versionMarkers / trendStats）与图形都只有这一份，页面只换卡头。
 * 调用方自己保证 `runs` 里有 ≥2 个有分点（空态的措辞归各自的卡头）。
 * 样式住在 plan.css（.plan-trend-*），消费方要自己 import。
 */
export function ScoreTrendBody({ runs }: { runs: PlanRunSummary[] }) {
  const points = trendPoints(runs);
  const stats = trendStats(points, TREND_TARGET);
  // 竖线与折线点同一批 run（scoredRunsAsc 就是 trendPoints 的取样器）
  const markers = versionMarkers(scoredRunsAsc(runs));
  return (
    <div className="plan-trend-wrap">
      <div className="plan-trend-body" data-testid="plan-trend-chart" aria-label="分数趋势折线图">
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={points} margin={{ top: 8, right: 64, bottom: 0, left: 0 }}>
            <defs>
              {/* 面积渐变：顶部 --viz-1 按 --viz-1-fill 的 .18（v2 必画下限），底部收到近 0 */}
              <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--viz-1)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--viz-1)" stopOpacity={0.01} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "var(--faint)", fontFamily: "var(--mono)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--viz-axis)" }}
            />
            <YAxis
              domain={[0, 1]}
              ticks={[0, 0.5, 1]}
              width={36}
              tick={{ fontSize: 10, fill: "var(--faint)", fontFamily: "var(--mono)" }}
              tickLine={false}
              axisLine={false}
            />
            <ReferenceLine
              y={TREND_TARGET}
              stroke="var(--viz-baseline)"
              strokeDasharray="4 3"
              ifOverflow="extendDomain"
            >
              {/* 目标线右侧标注（原型形态：线尾挂标签，不进图例） */}
              <Label
                value={`目标 ${TREND_TARGET}`}
                position="right"
                offset={8}
                style={{ fontSize: 10, fill: "var(--faint)", fontFamily: "var(--mono)" }}
              />
            </ReferenceLine>
            <Tooltip
              cursor={{ stroke: "var(--line-strong)", strokeWidth: 1 }}
              contentStyle={{
                border: "1px solid var(--line)",
                borderRadius: 6,
                background: "var(--panel)",
                fontSize: 11,
                fontFamily: "var(--mono)",
                padding: "6px 8px",
              }}
              labelStyle={{ color: "var(--muted)" }}
              itemStyle={{ color: "var(--text)" }}
              formatter={(value) => [Number(value).toFixed(2), "分数"]}
            />
            {/* 面积只做填充，描边交给下面的 Line（同时描边会加粗成 4px） */}
            <Area
              type="monotone"
              dataKey="score"
              stroke="none"
              fill="url(#trendFill)"
              isAnimationActive={false}
              activeDot={false}
            />
            <Line
              type="monotone"
              dataKey="score"
              stroke="var(--viz-1)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={<TrendDot total={points.length} />}
              activeDot={{ r: 5, fill: "var(--viz-1)", stroke: "var(--panel)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
            {/* 版本变更竖线：最后画 = 压在折线上方，但用 hairline 虚线不抢戏 */}
            {versionLines(markers)}
          </ComposedChart>
        </ResponsiveContainer>
        <VersionMarkerLine markers={markers} />
      </div>

      {/* 右侧区间统计列（原型的 hairline .stat-list） */}
      <TrendSideStats stats={stats} title="区间统计" />
    </div>
  );
}

// ---------- 口径 B：纯回归方案（通过率主线 + 逐评估器） ----------
function RegressionTrendCard({ reg, reason, markers = [] }: {
  reg: RegressionTrend;
  /** D-2 空态原因（<2 点时追加在既有说明之后） */
  reason?: string;
  /** 版本变更竖线（与口径 A 同一份推导，见 derive.versionMarkers） */
  markers?: VersionMarker[];
}) {
  const { points, evaluators } = reg;
  // 区间统计走**通过率序列**（这张图的总体线）。缺 pass_rate 的老 run 不进统计，
  // 不用 0 顶——「没给」和「0% 通过」是两件事。
  const ratePoints: TrendPoint[] = points
    .filter((p) => typeof p.passRate === "number")
    .map((p) => ({ t: p.t, label: p.label, score: p.passRate as number }));
  const stats = trendStats(ratePoints, TREND_TARGET);
  const last = points[points.length - 1];

  return (
    <div className="card" data-testid="plan-trend-card">
      <div className="card-head">
        <span className="card-title">分数趋势</span>
        {/* 量词说「回归运行」：本方案没有线上评估环节，说「有分运行」会让用户
            以为方案没跑出分（那正是这批要修的误导） */}
        <span className="card-sub">
          最近 {points.length} 次回归运行 · {evaluators.length} 个评估器 · 目标线 {TREND_TARGET}
        </span>
      </div>
      {points.length < 2 ? (
        <div className="plan-trend-empty" data-testid="plan-trend-empty">
          已有 <span className="mono">{points.length}</span> 次回归运行，趋势图需要至少 2 次
          {/* D-2：既有那句说的是「这张图画什么」，追加的这句说「为什么现在还没有
              点位 / 差什么」——两句都在场时读起来是「画什么 + 差什么」 */}
          {reason && (
            <span className="sub" data-testid="plan-trend-empty-reason">{reason}</span>
          )}
        </div>
      ) : (
        <div className="plan-trend-wrap">
          <div
            className="plan-trend-body"
            data-testid="plan-trend-chart"
            aria-label="回归趋势折线图（总体通过率 + 逐评估器均分）"
          >
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={points} margin={{ top: 8, right: 64, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="trendFillRate" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--viz-1)" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="var(--viz-1)" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "var(--faint)", fontFamily: "var(--mono)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--viz-axis)" }}
                />
                <YAxis
                  domain={[0, 1]}
                  ticks={[0, 0.5, 1]}
                  width={36}
                  tick={{ fontSize: 10, fill: "var(--faint)", fontFamily: "var(--mono)" }}
                  tickLine={false}
                  axisLine={false}
                />
                <ReferenceLine
                  y={TREND_TARGET}
                  stroke="var(--viz-baseline)"
                  strokeDasharray="4 3"
                  ifOverflow="extendDomain"
                >
                  <Label
                    value={`目标 ${TREND_TARGET}`}
                    position="right"
                    offset={8}
                    style={{ fontSize: 10, fill: "var(--faint)", fontFamily: "var(--mono)" }}
                  />
                </ReferenceLine>
                <Tooltip
                  cursor={{ stroke: "var(--line-strong)", strokeWidth: 1 }}
                  contentStyle={{
                    border: "1px solid var(--line)",
                    borderRadius: 6,
                    background: "var(--panel)",
                    fontSize: 11,
                    fontFamily: "var(--mono)",
                    padding: "6px 8px",
                  }}
                  labelStyle={{ color: "var(--muted)" }}
                  itemStyle={{ color: "var(--text)" }}
                  formatter={(value, name) => {
                    const n = String(name);
                    if (value == null) return ["无判定", n];   // 全被限流那次，不显示 0
                    return [n === PASS_RATE_LABEL
                      ? fmtPctInt(Number(value))
                      : Number(value).toFixed(2), n];
                  }}
                />
                {/* 通过率是主线：面积填充只给它（逐评估器是次序列，不填面积）。
                    Area 不进 tooltip，否则通过率会重复出现两行。 */}
                <Area
                  type="monotone"
                  dataKey="passRate"
                  stroke="none"
                  fill="url(#trendFillRate)"
                  tooltipType="none"
                  isAnimationActive={false}
                  activeDot={false}
                />
                {/* 逐评估器：1.5px 细线 + 小点，connectNulls=false 让「那次没有
                    有效判定」如实断开（补 0 会把限流说成质量崩了） */}
                {evaluators.map((name, i) => (
                  <Line
                    key={name}
                    type="monotone"
                    dataKey={evSeriesKey(name)}
                    name={name}
                    stroke={EV_COLORS[i % EV_COLORS.length]}
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    dot={{ r: 2.5, fill: EV_COLORS[i % EV_COLORS.length],
                           stroke: "var(--panel)", strokeWidth: 1 }}
                    activeDot={{ r: 4, stroke: "var(--panel)", strokeWidth: 2 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
                {/* 主线最后画 = 压在次序列上方 */}
                <Line
                  type="monotone"
                  dataKey="passRate"
                  name={PASS_RATE_LABEL}
                  stroke="var(--viz-1)"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  dot={<TrendDot total={points.length} />}
                  activeDot={{ r: 5, fill: "var(--viz-1)", stroke: "var(--panel)", strokeWidth: 2 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
                {/* 版本变更竖线（口径 B 同款，见 versionLines 的注释） */}
                {versionLines(markers)}
              </ComposedChart>
            </ResponsiveContainer>
            <VersionMarkerLine markers={markers} />

            {/* 图例（多序列才有）：色点 + 名字 + 最近一次的数字。
                评估器名是资源库里的注册名，**原文不翻译**。 */}
            <div className="plan-trend-legend" data-testid="plan-trend-legend">
              <span className="lg-item is-main" data-testid="plan-trend-legend-pass-rate">
                <i className="lg-dot" style={{ background: "var(--viz-1)" }} />
                <span className="lg-n">{PASS_RATE_LABEL}</span>
                <span className="lg-v">{fmtPctInt(last.passRate)}</span>
              </span>
              {evaluators.map((name, i) => {
                const v = last[evSeriesKey(name)];
                return (
                  <span className="lg-item" key={name} data-testid={`plan-trend-legend-${name}`}>
                    <i
                      className="lg-dot"
                      style={{ background: EV_COLORS[i % EV_COLORS.length] }}
                    />
                    <span className="lg-n lat">{name}</span>
                    <span className="lg-v">
                      {fmtMean(typeof v === "number" ? v : null)}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>

          {/* 区间统计列：口径 B 的总体线是通过率，标题就说通过率 */}
          <TrendSideStats stats={stats} title="通过率区间统计" />
        </div>
      )}
    </div>
  );
}

// ---------- 小趋势（Agent 详情 ③ 评估器面板每行一枚，ADR-0016 口径修订） ----------
//
// 纯 SVG、无 Recharts：一行 28px 高的格子里放不下坐标轴与图例，也不需要 —— 它只回答
// 「这条评估器最近几次在目标线上下怎么走」。三条与大图同源的规则：
//   · 目标线虚线走 --viz-baseline（同 ScoreTrendBody 的 ReferenceLine）；
//   · 版本变更竖线走 --line-strong hairline（同 versionLines 的选色：不许穿数据色）；
//   · null 点断开不补 0（同口径 B 的 connectNulls=false：「那次没有判定」≠「0 分」）。
// 描边 1.5 = --viz-stroke-min（任何趋势线的下限）；SVG 属性只能写数字，故此处记令牌名。
// 颜色由调用方按「过 / 未过 / 无判定」三态给：过 = --viz-1，未过 = --warn-dot，
// 无判定 = --viz-neutral（线色承的是这一行的结论，不是装饰）。
export function SparkTrend({ values, target, markers = [], tone = "ok", width = 124, height = 28, label }: {
  /** 逐 run 的值（时间升序）；null = 那次没有判定 → 线在此断开 */
  values: (number | null)[];
  /** 目标线（0-1 域内的值） */
  target: number;
  /** 版本变更落点：下标 i 表示第 i 个点与前一个点之间画一条竖线 */
  markers?: number[];
  tone?: "ok" | "miss" | "none";
  width?: number;
  height?: number;
  /** 无障碍名（role=img 的 aria-label），由调用方按这一行的数据拼 */
  label: string;
}) {
  const n = values.length;
  const nums = values.filter((v): v is number => typeof v === "number");
  if (n < 2 || nums.length === 0) return null;
  const pad = 3;
  const lo = Math.min(...nums, target) - 0.04;
  const hi = Math.max(...nums, target) + 0.04;
  const span = Math.max(hi - lo, 0.1);
  const x = (i: number) => pad + (i * (width - 2 * pad)) / (n - 1);
  const y = (v: number) => height - pad - ((v - lo) / span) * (height - 2 * pad);
  const stroke = tone === "ok" ? "var(--viz-1)" : tone === "miss" ? "var(--warn-dot)" : "var(--viz-neutral)";
  const fill = tone === "ok" ? "var(--viz-1-fill)" : tone === "miss" ? "var(--warn-bg)" : "var(--viz-neutral-fill)";
  // 连续非空段各画一条折线 + 面积（null 处断开）
  const segments: number[][] = [];
  let cur: number[] = [];
  values.forEach((v, i) => {
    if (typeof v === "number") cur.push(i);
    else if (cur.length) { segments.push(cur); cur = []; }
  });
  if (cur.length) segments.push(cur);
  const lastIdx = values.reduce<number>((acc, v, i) => (typeof v === "number" ? i : acc), -1);
  const ty = y(target).toFixed(1);
  return (
    <svg
      className="spark-trend"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={label}
      data-testid="spark-trend"
    >
      {segments.map((seg) => {
        const pts = seg.map((i) => `${x(i).toFixed(1)},${y(values[i] as number).toFixed(1)}`);
        if (seg.length === 1) {
          return <circle key={`p${seg[0]}`} cx={x(seg[0])} cy={y(values[seg[0]] as number)} r={1.8} fill={stroke} />;
        }
        const area = `M${x(seg[0]).toFixed(1)},${height - pad} L${pts.join(" L")} L${x(seg[seg.length - 1]).toFixed(1)},${height - pad} Z`;
        return (
          <g key={`s${seg[0]}`}>
            <path d={area} fill={fill} />
            <polyline points={pts.join(" ")} fill="none" stroke={stroke} strokeWidth={1.5}
                      strokeLinejoin="round" strokeLinecap="round" />
          </g>
        );
      })}
      <line x1={pad} x2={width - pad} y1={ty} y2={ty} stroke="var(--viz-baseline)" strokeWidth={1}
            strokeDasharray="2 3" data-testid="spark-trend-target" />
      {markers.filter((m) => m > 0 && m < n).map((m) => {
        const vx = ((x(m - 1) + x(m)) / 2).toFixed(1);
        return <line key={m} x1={vx} x2={vx} y1={pad} y2={height - pad} stroke="var(--line-strong)"
                     strokeWidth={1} data-testid="spark-trend-version" />;
      })}
      {lastIdx >= 0 && (
        <circle cx={x(lastIdx)} cy={y(values[lastIdx] as number)} r={2.2} fill={stroke} />
      )}
    </svg>
  );
}

// ---------- 右侧区间统计列（两套口径共用，原型的 hairline .stat-list） ----------
function TrendSideStats({ stats, title }: { stats: TrendStats | null; title: string }) {
  if (!stats) return null;
  return (
    <div className="plan-trend-side" data-testid="plan-trend-stats">
      <div className="side-title">{title}</div>
      <div className="stat-list">
        <div className="stat-row">
          <span className="k">最高</span>
          <span className="v" data-testid="trend-stat-max">
            {stats.max.toFixed(2)}
            <span className="subtle" style={{ fontWeight: 400 }}> {stats.maxLabel}</span>
          </span>
        </div>
        <div className="stat-row">
          <span className="k">最低</span>
          <span className="v" data-testid="trend-stat-min">
            {stats.min.toFixed(2)}
            <span className="subtle" style={{ fontWeight: 400 }}> {stats.minLabel}</span>
          </span>
        </div>
        <div className="stat-row">
          <span className="k">均值</span>
          <span className="v" data-testid="trend-stat-avg">{stats.avg.toFixed(2)}</span>
        </div>
        <div className="stat-row">
          <span className="k">环比</span>
          <span
            className={`v ${stats.delta == null ? "" : stats.delta >= 0 ? "pos" : "neg"}`}
            data-testid="trend-stat-delta"
          >
            {stats.delta == null
              ? "—"
              : `${stats.delta >= 0 ? "+" : "−"}${Math.abs(stats.delta).toFixed(2)}`}
          </span>
        </div>
        <div className="stat-row">
          <span className="k">跌破目标</span>
          <span
            className={`v ${stats.belowTarget > 0 ? "neg" : ""}`}
            data-testid="trend-stat-below"
          >
            {stats.belowTarget} 次
          </span>
        </div>
      </div>
    </div>
  );
}
