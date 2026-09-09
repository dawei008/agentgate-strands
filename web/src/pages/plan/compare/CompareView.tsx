// Run 对比的**共享视图**：抽屉（同方案两次运行）与独立对比页（跨方案/跨版本）
// 用的是这一份，不是两份。
//
// 为什么共享：三桶（修好的 / 改坏的 / 仍失败）的分桶判据、量纲不合成的硬线、
// 缺席一侧的措辞，都是**判据**而不是排版。两个入口各写一套的话，同一对 run 会
// 在两处读出两个结论，而「哪一处是对的」没人答得上来 —— 那种不一致查起来比
// 一个错还贵。入口只负责壳（抽屉的宽度与出场动画 / 页面的选择器与 URL）。
//
// 它只回答一个问题：**这次改进修好了什么、有没有副作用**。所以版面是
//   两栏身份（各带自己的版本标签快照）
// → 口径披露（两次是不是同一把尺子量的）
// → 逐量纲指标并排（各比各的，绝不合成一个数 —— ADR-0003）
// → 用例三桶（修好的 / 改坏的 / 仍失败）+ 两个说明桶（无判定 / 无法对齐）
// → 点开任一用例：两次的回答与各评估器判分理由左右并排。
//
// 数据来自两次 get_plan_run（queryKey 与报告抽屉同键 ["plan_run", runKey]，
// 从报告抽屉过来时直接命中缓存，不重复打接口）。派生全在 compare/derive.ts。
//
// 玻璃纪律：整壳的玻璃由 .drawer-panel / 页面卡片给（白名单内），本文件的面
// 一律实心 --bg2 / 透出壳，不新增任何 backdrop-filter；桶与结论用既有 badge
// 语义类（实心底），不新造颜色令牌。
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiOne } from "../../../lib/api";
import type { ApiEvent } from "../../../lib/api";
import { Icon } from "../../../components/layout/Icons";
import { EMPTY_MARK, textOf } from "../../../lib/renderText";
import { fmtRunTime } from "../../../lib/time";
import { fmtScoreExact, runBadge } from "../../../lib/scoring";
import type { DatasetsEvent, PlanRunDetail, PlanRunSummary } from "../types";
import { reportStages, versionSnapshot } from "../derive";
import {
  ALIGN_TEXT, BUCKET_CLASS, BUCKET_LABEL, BUCKET_ORDER,
  calibrationNotes,
  calibrationVerdict, compareMetricGroups, compareStages,
  type BucketKind, type CalibrationNote, type CompareMetric, type CompareMetricGroup,
  type CompareUnit, type StageCompare, type UnitPair,
} from "./derive";
// 共享样式跟着共享视图走（不留在 plan.css 里）：页面入口不 import plan.css，
// 样式留在那边就等于「独立对比页整页没样式」。
import "./compareview.css";

/** 两栏的称呼（栏头 / 指标表头 / 缺席说明全用这一份，免得同屏两种叫法）。 */
export const SIDE_WORD: Record<"a" | "b", string> = { a: "上一次", b: "这一次" };

export interface ComparePair {
  /** 较早那次（左栏） */
  aKey: string;
  /** 较新那次（右栏） */
  bKey: string;
}

/**
 * 候选池里的一行。**视图契约，不是又一份后端事件形状**。
 *
 * 两个入口喂进来的东西不同源：抽屉给 `list_plan_runs`（PlanRunSummary，同一个
 * 方案，没有 plan_id/plan_name），页面给 `list_recent_runs`（多方案混排，带方案
 * 与 Agent 名）。取**并集**成一个类型，两边都能喂 —— 而不是在 lib/apiTypes.ts
 * 再添一份 `RecentRunsEvent`：那个行形状已经在 workbench/types.ts 与
 * agents/types.ts 各声明过一遍（同名不同形），第四份只会让漂移更难收。
 * ⚠️ 三个可选字段**缺了就是缺了**：跨方案身份行读不到方案名时不画，不去猜。
 */
export interface CompareViewRun extends PlanRunSummary {
  plan_id?: string;
  plan_name?: string;
  agent_name?: string;
}

/**
 * 「跳到这一条」的请求（评估分析页两段卡的引用 chip → 逐用例对照里那一行）。
 * `title` = UnitPair.title（用例名 / 会话 id / 攻击用例名）；`nonce` 让同一条被
 * 再点一次时也能再滚一次（title 不变 ⇒ 没有别的东西会变）。
 */
export interface CompareFocus {
  title: string;
  nonce: number;
}

export function CompareView({ pair, runs, onClose, showOrigin = false, heading, focus = null }: {
  pair: ComparePair;
  /** 候选池（**最新在前**，与运行历史表同序）：供 #N 序号与两栏身份。
   *  #N 按方案各自数（见 seqOf）—— 跨方案池里全局序号会让两栏的 #N 出自两把尺子。 */
  runs: CompareViewRun[];
  /** 有就画关闭按钮（抽屉）；没有就不画（页面靠路由退出，画个 × 是假出口） */
  onClose?: () => void;
  /** 两栏身份是否带方案名 + Agent 名。跨方案对比必须带（否则两栏看着一样），
   *  同方案抽屉里是冗余噪音 ⇒ 默认关。 */
  showOrigin?: boolean;
  /** 标题行；页面自己有 h1，不需要再来一个标题 ⇒ 缺省不画整行 */
  heading?: { title: string; sub?: string };
  /** 深链落点（见 CompareFocus）：匹配 title 的那一行展开并滚入视口。缺省无。 */
  focus?: CompareFocus | null;
}) {
  const a = useRunDetail(pair.aKey, runs);
  const b = useRunDetail(pair.bKey, runs);
  // 数据集名单：**只为读 updated_at**（判「数据集在两次运行之间改过没有」）。
  // queryKey 与方案编辑器/报告抽屉同键 → 通常直接命中缓存；拉不到就不判，
  // 对比其余部分完全不受影响（这份查询绝不当渲染闸门）。
  const datasetsQuery = useQuery({
    queryKey: ["datasets"],
    queryFn: () => apiOne<DatasetsEvent>({ action: "list_datasets" }, "datasets"),
  });

  const groups = useMemo(
    () => compareMetricGroups(
      { detail: a.detail, summary: a.summary }, { detail: b.detail, summary: b.summary }),
    [a.detail, a.summary, b.detail, b.summary],
  );
  const stages = useMemo(
    () => compareStages(a.detail, b.detail, { datasets: datasetsQuery.data?.datasets }),
    [a.detail, b.detail, datasetsQuery.data],
  );
  const notes = useMemo(
    () => calibrationNotes({ detail: a.detail, summary: a.summary }, { detail: b.detail, summary: b.summary }),
    [a.detail, a.summary, b.detail, b.summary],
  );

  const loading = a.query.isLoading || b.query.isLoading;
  const error = a.errorText ?? b.errorText;

  /** 「这个方案的第 N 次运行」。
   *  ⚠️ 按 **plan_id 分组**后再数：跨方案候选池里全局下标会让左右两栏的 #N 出自
   *  两把不同的尺子（同一个「#3」指两件事，比不写序号更坏）。没有 plan_id（抽屉
   *  喂的 PlanRunSummary 不带）就是单方案池，全池即同方案 —— 与旧行为逐字相同。 */
  function seqOf(runKey: string): number | null {
    const target = runs.find((r) => r.run_key === runKey);
    if (!target) return null;
    const pool = target.plan_id ? runs.filter((r) => r.plan_id === target.plan_id) : runs;
    const i = pool.findIndex((r) => r.run_key === runKey);
    return i >= 0 ? pool.length - i : null;
  }

  /** 列头身份 `#N · 2026-08-09 03:00`（用户 2026-08-30：光写「上一次/这一次」
   *  分不清列指的是哪次运行，得挪回头部两栏卡去对——列头直接写 run 身份）。
   *  #N 与两栏身份卡同一个 seqOf、时间同 RunColumn 的取法（detail 优先），
   *  三者说的必须是同一个 run。判不出的部分不编（都判不出 → 空串，列头退回
   *  只有「上一次/这一次」——与旧形态逐字同，这是老 run 的降级态不是缺陷）。 */
  function runIdLabel(runKey: string, side: SideData): string {
    const seq = seqOf(runKey);
    const t = fmtRunTime(side.detail?.started_at ?? side.summary?.started_at);
    return [seq != null ? `#${seq}` : "", t !== EMPTY_MARK ? t : ""]
      .filter(Boolean).join(" · ");
  }
  const idA = runIdLabel(pair.aKey, a);
  const idB = runIdLabel(pair.bKey, b);
  const seqA = seqOf(pair.aKey);
  const seqB = seqOf(pair.bKey);

  return (
    <>
      {/* ---- 头部固定：两栏身份 + 各自的版本标签快照 ---- */}
      <div className="cmp-head" data-testid="plan-compare-head">
        {(heading || onClose) && (
          <div className="cmp-head-top">
            {heading && <span className="cmp-title">{heading.title}</span>}
            {heading?.sub && <span className="cmp-sub">{heading.sub}</span>}
            <span className="spacer" style={{ flex: 1 }} />
            {onClose && (
              <button
                type="button"
                className="rd-close"
                aria-label="关闭运行对比"
                data-testid="plan-compare-close"
                onClick={onClose}
              >
                <Icon name="close" className="ic-sm" />
              </button>
            )}
          </div>
        )}
        <div className="cmp-cols">
          <RunColumn side="a" seq={seqOf(pair.aKey)} run={a} showOrigin={showOrigin} />
          <RunColumn side="b" seq={seqOf(pair.bKey)} run={b} showOrigin={showOrigin} />
        </div>
        {/* 颜色对照：整份对比里蓝恒指较早那次、绿恒指较新那次。
            最后半句不是客套 —— 分数列的绿/红说的是**达标/未达标**，与栏身份的绿
            是两种意思。同屏两个绿不解释一句，读者只能靠猜哪个绿在说什么。 */}
        {/* 通用说明一律直接删（用户 2026-08-30 终裁：「也不要进悬停，直接删掉」——
            对任何 run 都一字不差成立的话是使用文档，写进 docs 不写进界面）。 */}
        <div className="cmp-legend" data-testid="plan-compare-legend">
          <span className="lg is-a">
            <span className="cdot" aria-hidden="true" />{SIDE_WORD.a}（较早）
          </span>
          <span className="lg is-b">
            <span className="cdot" aria-hidden="true" />{SIDE_WORD.b}（较新）
          </span>
        </div>
      </div>

      {/* ---- 口径披露：先说清「是不是同一把尺子量的」，再给数 ----
           必须等两侧报告都到了才画：加载中两侧都读不到数据集名，与「老 run 不带
           这个字段」在数据上同形 —— 那会让一个正常的对比在头两秒里挂上一条假警示。 */}
      {!loading && !error && <CalibrationStrip notes={notes} ids={{ a: idA, b: idB }} />}

      {/* ---- 指标区固定：**按环节分组**，组内逐量纲一行，永不合成 ---- */}
      <div className="cmp-kpis" data-testid="plan-compare-kpis">
        {/* 分区编号 ①②③（用户 2026-08-30「对比报告分几部分？」——结构此前只在
            读者脑子里，现在写在脸上：① 口径 → ② 逐环节对比 → ③ 逐用例对照，
            头部两栏身份是标题区不编号） */}
        <div className="cmp-kpis-cap">② 逐环节对比</div>
        {loading && <div className="cmp-kpi-empty" data-testid="plan-compare-loading">加载两次运行的报告中…</div>}
        {error && <div className="cmp-kpi-empty is-error" data-testid="plan-compare-error">{error}</div>}
        {!loading && !error && groups.length === 0 && (
          <div className="cmp-kpi-empty" data-testid="plan-compare-kpis-empty">
            这两次运行没有可比的指标
          </div>
        )}
        {/* 真表格 + 表格线（用户 2026-08-30：「格式也不好，用表格方式，显示表格
            线」）：<table> 一张，环节组各占一个 <tbody>（组标题行跨四列），
            行线列线由集合边框画。表头仍只出一次（在所有组之上）：每组各出一遍
            的话，同样四个字要读三次，而它们说的是同一件事；列宽由 <thead> 那一行
            定死（table-layout: fixed），跨组仍对得齐。
            玻璃纪律 2（表格零玻璃）：本表实心 --bg2 面，零 backdrop-filter。 */}
        {groups.length > 0 && (
          <table className="cmp-kpi-table">
            <thead>
              <tr className="cmp-kpi is-head">
                <th scope="col" className="kn">指标</th>
                {/* 栏名带 #N（84px 装不下完整时间，全串进 title；口径表的列头有全串）。
                    seq 判不出（跨方案候选池缺 plan_id 等）就只写侧别词，不编号 */}
                <th scope="col" className="ka" title={idA || undefined}>
                  {SIDE_WORD.a}{seqA != null ? ` #${seqA}` : ""}
                </th>
                <th scope="col" className="kb" title={idB || undefined}>
                  {SIDE_WORD.b}{seqB != null ? ` #${seqB}` : ""}
                </th>
                <th scope="col" className="kd">变化</th>
              </tr>
            </thead>
            {groups.map((g) => <MetricGroup key={g.stage} group={g} />)}
          </table>
        )}
      </div>

      {/* ---- 正文滚动：逐环节三桶 ---- */}
      <div className="cmp-body" data-testid="plan-compare-body">
        {stages.length > 0 && (
          <div className="cmp-body-cap" data-testid="plan-compare-body-cap">
            ③ 逐用例对照
          </div>
        )}
        {!loading && !error && stages.length === 0 && (
          <p className="subtle" data-testid="plan-compare-stages-empty">
            这两次运行都没有可读的环节信息，无法逐条对照。
          </p>
        )}
        {stages.map((s, i) => (
          <StageBlock key={`${s.type}-${i}`} stage={s} index={i} focus={focus} />
        ))}
      </div>

      {/* 底部那句「结论翻面看…分数动了看…」对任何 run 恒成立 ⇒ 文档不是界面
          （用户 2026-08-30）。抽屉只留 Esc 出口提示；页面上没有 Esc 也没有别的话
          ⇒ 整条不渲染，不留空壳。 */}
      {onClose && (
        <div className="cmp-foot" data-testid="plan-compare-foot">
          <span className="hint">Esc 关闭</span>
        </div>
      )}
    </>
  );
}

/**
 * 口径披露条：三档语义不同的话，各画各的，绝不合成一个「可比 / 不可比」布尔。
 *
 * 为什么不合成：`blocking`（量的不是同一批题）和 `unknown`（平台没记，判不出来）
 * 都会被一个布尔压成「不可比」，而它们要读者做的事完全不同 —— 前者是「别看三桶」，
 * 后者是「看了要自己留个心」。压成一个数就等于把「不知道」说成「不行」。
 */
function CalibrationStrip({ notes, ids }: {
  notes: CalibrationNote[];
  /** 两列的 run 身份（`#N · 时间`；判不出为空串）——列头用（用户 2026-08-30：
   *  「上一次/这一次」分不清是谁，改成 run id 加时间）。 */
  ids: { a: string; b: string };
}) {
  if (notes.length === 0) return null;
  const verdict = calibrationVerdict(notes);
  // 总结论只在**要警告**时占行（blocking/diff）—— same/unknown 那两句被用户点名
  // 是废话（2026-08-30「类似这种废话还在报告里」）：same 的绿标签自己会说话，
  // unknown 的「未记录」就在格子里。「一条 blocking 混在五条绿里被稀释」的防线
  // 只需要坏消息那两档，好消息与不可知不需要横幅。
  const warn = verdict && (verdict.level === "blocking" || verdict.level === "diff")
    ? verdict : null;
  return (
    <div className="cmp-cal" data-testid="plan-compare-calibration">
      {/* 标题不带解释句（同上一条用户反馈）：「口径」配上表格与色标已经自明 */}
      <div className="cmp-cal-cap">① 口径</div>
      {warn && (
        <div
          className={`cmp-cal-verdict is-${warn.level}`}
          data-testid="plan-compare-cal-verdict"
          data-level={warn.level}
        >
          {warn.text}
        </div>
      )}
      {/* 表头：侧别词 + run 身份（#N · 时间）。此前每行重复「上一次：/这一次：」
          七遍还是分不清指谁（用户原话）——表格化后侧别只在表头说一次，身份直接
          写在列名上。身份判不出（老 run）时列头退回只有侧别词，不编。 */}
      <div className="cmp-cal-row is-head" data-testid="plan-compare-cal-head">
        <span className="cn">口径项</span>
        <span className="ch is-a" data-testid="plan-compare-cal-head-a">
          <span className="cs">{SIDE_WORD.a}</span>
          {ids.a && <span className="cid num">{ids.a}</span>}
        </span>
        <span className="ch is-b" data-testid="plan-compare-cal-head-b">
          <span className="cs">{SIDE_WORD.b}</span>
          {ids.b && <span className="cid num">{ids.b}</span>}
        </span>
      </div>
      {notes.map((n) => {
        // 警示留版面，解释直接删（用户 2026-08-30 终裁：不进悬停）：
        // blocking/diff 的话改变「下面的数怎么读」，留在行下；
        // same/unknown 的解释句不渲染 —— 色标与「未记录」格子自己会说话。
        const warnRow = n.level === "blocking" || n.level === "diff";
        return (
          <div
            key={n.id}
            className={`cmp-cal-row is-${n.level}`}
            data-testid={`plan-compare-cal-${n.id}`}
            data-level={n.level}
          >
            <span className="cn">{n.label}</span>
            {/* 两个值各占一列（真表格）；**值**留在 --text 不动色 —— 口径这一栏
                比的是「一样不一样」，值本身没有好坏。警示说明整行另起（ct 跨
                全宽）：塞进第三列会把两列值挤到对不齐。 */}
            <span className="ca" data-testid={`plan-compare-cal-${n.id}-a`}>{n.a}</span>
            <span className="cb" data-testid={`plan-compare-cal-${n.id}-b`}>{n.b}</span>
            {warnRow && n.text && <span className="ct">{n.text}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** 一侧的取数（两侧各一份查询，key 与报告抽屉同键 → 缓存共用）。
 *  摘要行从运行历史里取：report 还在飞的时候，身份/版本 chip 先用它顶上，
 *  且老归档若 detail 侧缺版本快照也靠它兜（derive.versionSnapshot 的双读）。 */
function useRunDetail(runKey: string, runs: CompareViewRun[]) {
  const query = useQuery({
    queryKey: ["plan_run", runKey],
    queryFn: () =>
      apiOne<PlanRunDetail & ApiEvent>({ action: "get_plan_run", run_key: runKey }, "plan_run"),
  });
  return {
    query,
    runKey,
    detail: query.data,
    summary: runs.find((r) => r.run_key === runKey) ?? null,
    errorText: query.isError
      ? `报告加载失败：${query.error instanceof Error ? query.error.message : String(query.error)}`
      : null,
  };
}

type SideData = ReturnType<typeof useRunDetail>;

/** 一栏身份：#N · 时间 · 结果 badge · **这一次运行时**的版本标签快照。
 *  版本走 derive.versionSnapshot（只读 run 快照，绝不读 Agent 当前标签 —— 护栏 1）。 */
function RunColumn({ side, seq, run, showOrigin }: {
  side: "a" | "b";
  seq: number | null;
  run: SideData;
  showOrigin: boolean;
}) {
  const d = run.detail;
  const status = d?.status ?? run.summary?.status ?? "";
  const stages = reportStages(d);
  const badge = runBadge({ status, score: d?.score ?? run.summary?.score ?? null, stage_summaries: stages });
  const version = versionSnapshot(d, run.summary);
  // 跨方案对比里「这一栏是谁」全靠这两个名字。detail 侧也带 plan_name/agent_name
  // （get_plan_run 的归档里有），摘要缺了就读它 —— 两个都缺就不画那一行，不猜。
  const planName = textOf(run.summary?.plan_name ?? d?.plan_name ?? "").trim();
  const agentName = textOf(run.summary?.agent_name ?? d?.agent_name ?? "").trim();
  return (
    <div className={`cmp-col is-${side}`} data-testid={`plan-compare-col-${side}`}>
      <div className="cmp-col-cap">
        <span className="cdot" aria-hidden="true" />{SIDE_WORD[side]}
      </div>
      {showOrigin && (planName || agentName) && (
        <div className="cmp-col-origin" data-testid={`plan-compare-origin-${side}`}>
          {planName && <span className="cjk pn">{planName}</span>}
          {agentName && <span className="lat an" title="Agent">{agentName}</span>}
        </div>
      )}
      <div className="cmp-runid">
        {seq != null && <span className="seq">#{seq}</span>}
        {fmtRunTime(d?.started_at ?? run.summary?.started_at)}
      </div>
      <div className="cmp-col-meta">
        <span className={badge.cls}>
          <span className="dot" />
          {badge.label || EMPTY_MARK}
        </span>
        {/* 老 run 没有版本快照（旧数据不修）→ 整个 chip 不画，绝不画空 chip */}
        {version && (
          <span
            className="badge badge-mono"
            data-testid={`plan-compare-version-${side}`}
          >
            {version}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 一个环节一块（tbody）：组标题行 + 环节级那一行 + 它自己的评估器级各行。
 *
 * 为什么要分块（用户 2026-08-28 原话：「线上测试不是测试类型吗，回归测试分数指的是
 * 什么？为什么和 corecness 评估器分数放一起」）：此前这里是一张**平表**，两个层级
 * 被说成一层，环节名被读成指标名。分块解决两件事：层级看得见（组标题行）、
 * 评估器级各行归谁（缩进 + 小标题）；量纲由每行的 unit 角标承载。
 */
function MetricGroup({ group }: { group: CompareMetricGroup }) {
  const tid = `plan-compare-mgroup-${group.stage}`;
  return (
    <tbody className={`cmp-mgroup is-${group.stage}`} data-testid={tid}>
      {/* 量纲讲解句已整句删除（用户终裁：不进悬停）；量纲仍逐行明写在 .ku 上，
          那是数据标注不是散文 */}
      {/* 组标题行跨全宽：字级升到 --fs-section semibold（用户 2026-08-30：
          「不都是标题大正文小么」——此前组标题与数据行同为 --fs-sm，比 mono
          数字看着还小）。与 ③ 区 .cmp-stage-h 同字号：同屏同层级同大小。 */}
      <tr className="cmp-mgroup-h">
        <th scope="rowgroup" colSpan={4}>
          <span className="gl cjk">{group.label}</span>
        </th>
      </tr>
      {group.empty
        ? (
          <tr>
            <td colSpan={4} className="cmp-kpi-empty" data-testid={`${tid}-empty`}>
              {group.empty}
            </td>
          </tr>
        )
        : (
          <>
            {group.headline && <MetricRow m={group.headline} lead />}
            {/* 小标题只在真有评估器级行时出现：一条都没有时写「评估器级」再接空白，
                读起来像「这一环没配评估器」，而真相是老 run 不记 evaluator_stats。 */}
            {group.rows.length > 0 && (
              <tr>
                <td colSpan={4} className="cmp-mgroup-sub" data-testid={`${tid}-sub`}>
                  评估器级
                </td>
              </tr>
            )}
            {group.rows.map((m) => <MetricRow key={m.id} m={m} />)}
          </>
        )}
    </tbody>
  );
}

/** 一行指标。`lead` = 环节级那一行（组内第一行，字重更沉）。
 *  行名用 `rowLabel`（组标题已经承担了环节这一层），缺了退回全名 `label`。 */
function MetricRow({ m, lead = false }: { m: CompareMetric; lead?: boolean }) {
  return (
    <>
      <tr className={`cmp-kpi${lead ? " is-lead" : " is-sub"}`} data-testid={`plan-compare-metric-${m.id}`}>
        <th scope="row" className="kn">
          <span className="kl">{m.rowLabel || m.label}</span>
          {/* 量纲跟着数走：同屏三种量纲，不写出来就会被读成同一个尺子。
              只在环节级那一行挂（评估器行 unit 为空串，同量纲不重复挂） */}
          {m.unit && <span className="ku">{m.unit}</span>}
        </th>
        <td className="ka" data-testid={`plan-compare-metric-${m.id}-a`}>{m.a ?? EMPTY_MARK}</td>
        <td className="kb" data-testid={`plan-compare-metric-${m.id}-b`}>{m.b ?? EMPTY_MARK}</td>
        <td
          className={`kd${m.deltaText == null ? " is-none" : m.worse ? " is-worse" : " is-better"}`}
          data-testid={`plan-compare-metric-${m.id}-delta`}
        >
          {m.deltaText ?? EMPTY_MARK}
        </td>
      </tr>
      {/* 分母小字：均分旁边**必须**有它，否则「涨了」有两个不可分的成因 ——
          真的评得更好，或者这一次评出结论的条数变了（现网线上评估环节枚举 12 条、
          只评出 9 条判定）。两侧相同就合成一句，不同就点名说是哪一侧多少 ——
          那种不同本身是读者要知道的事（分母换了的涨跌另当别论）。
          ⚠️ 跨全宽一行而不是塞进 84px 的数值列：那两列放不下「9 判定 · 3 未评出」，
          挤进去只会折行，而折行后「3」看着像另一个指标。跨列 ⇒ 天然无列线；
          与上一行之间的行线在 CSS 里抹掉（border-top: hidden）——它是上一行的
          脚注，不是又一条独立记录，表格线切在中间会把两者读成两回事。 */}
      {(m.subA || m.subB) && (
        <tr className="cmp-kpi-wide is-note">
          <td colSpan={4} className="cmp-kpi-sub" data-testid={`plan-compare-metric-${m.id}-sub`}>
            {m.subA === m.subB
              ? `两次都是 ${m.subA}`
              : `${SIDE_WORD.a} ${m.subA || EMPTY_MARK} · ${SIDE_WORD.b} ${m.subB || EMPTY_MARK}`}
          </td>
        </tr>
      )}
      {m.note && (
        <tr className="cmp-kpi-wide is-note">
          <td colSpan={4} className="cmp-kpi-note" data-testid={`plan-compare-metric-${m.id}-note`}>
            {m.note}
          </td>
        </tr>
      )}
    </>
  );
}

// ---------- 一个环节一块 ----------
function StageBlock({ stage, index, focus }: {
  stage: StageCompare; index: number; focus: CompareFocus | null;
}) {
  const shown = BUCKET_ORDER.filter(
    // 三个主桶恒显示（「改坏的 0」本身就是答案 —— 没有副作用这件事要看得见）；
    // 两个说明桶只在真有条目时出现，不然满屏都是解释
    (b) => MAIN_BUCKETS.includes(b) || stage.counts[b] > 0,
  );
  return (
    <section className="cmp-stage" data-testid={`plan-compare-stage-${index}`}>
      <h3 className="cmp-stage-h">
        {/* 术语五词照 lib/scoring.STAGE_LABEL（derive 里取好，这里不再映射） */}
        <span className="cjk">{stage.label}</span>
        {stage.dataset && <span className="ds lat" title={stage.dataset}>{stage.dataset}</span>}
        {/* 按什么对齐要写出来：按题面 / 按用例名（退化）/ 按会话 —— 它决定了
            下面三桶的可信度（用例名是按位置派生的，不是身份）。
            明细缺失时**不写**这句：一条都没对齐，说「按题面对齐」是假交代。 */}
        <span className="uw" data-testid={`plan-compare-alignby-${index}`}>
          {stage.missing == null
            ? `${stage.unitWord} · ${ALIGN_TEXT[stage.alignBy]}`
            : stage.unitWord}
        </span>
        {/* **「且分数持平」四个字是这一行的全部要点**：它此前写「两次都通过 N」，
            而那个 N 里混着 0.10 → 1.00 这种分数动了、结论没翻面的用例 —— 于是唯一
            有变化的东西被算进了一个读起来是「没什么可看」的计数里。现在这两类各自
            成桶（scoreUp / scoreDown），这句才真的成立：留在这个数里的是既没翻面、
            分数也没动的那些。 */}
        {stage.missing == null && (
          <span className="bp">两次都通过且分数持平 {stage.bothPass} {stage.unitWord}</span>
        )}
      </h3>
      {/* 警示横幅：退化按名对齐 + 数据集在较早那次运行之后改过 */}
      {stage.staleText && (
        <p className="cmp-stale" role="note" data-testid={`plan-compare-stale-${index}`}>
          <Icon name="warn" className="ic-sm" />
          <span>{stage.staleText}</span>
        </p>
      )}
      {stage.missing != null ? (
        <p className="cmp-missing" data-testid={`plan-compare-missing-${index}`}>
          {stage.missingText}
        </p>
      ) : (
        shown.map((b) => (
          <Bucket key={b} stage={stage} stageIndex={index} bucket={b} focus={focus} />
        ))
      )}
    </section>
  );
}

/** 恒显示的三个主桶（本视图要回答的那两个问题就在这三桶里）。 */
const MAIN_BUCKETS: BucketKind[] = ["fixed", "broken", "still"];

function Bucket({ stage, stageIndex, bucket, focus }: {
  stage: StageCompare;
  stageIndex: number;
  bucket: BucketKind;
  focus: CompareFocus | null;
}) {
  const pairs = stage.pairs.filter((p) => p.bucket === bucket);
  const cls = BUCKET_CLASS[bucket];
  const empty = pairs.length === 0;
  // 判据/说明句一律不渲染（用户 2026-08-30 终裁：也不进悬停，直接删）——
  // 桶名自解释（较上一次改进/退步…），行级 pair.why（这一条自己的事实）保留。
  return (
    <div
      /* has-rows：有行的桶带左侧色条把行圈进来 —— 「和下面的每一条啥关系」的
         另一半根因是桶头与行在版面上是两截，行像一张独立的平表 */
      className={`cmp-bucket is-${bucket}${empty ? "" : " has-rows"}`}
      data-testid={`plan-compare-bucket-${stageIndex}-${bucket}`}
    >
      <div className="cmp-bucket-head">
        <span className={`badge${cls ? ` ${cls}` : ""}`}>
          <span className="dot" />
          {BUCKET_LABEL[bucket]}
        </span>
        <span className="n">{pairs.length}</span>
        <span className="uw">{stage.unitWord}</span>
      </div>
      {pairs.map((p) => (
        <PairRow
          key={p.key}
          pair={p}
          stageIndex={stageIndex}
          unitWord={stage.unitWord}
          focus={focus && focus.title === p.title ? focus : null}
        />
      ))}
    </div>
  );
}

/** 结论词：pass/fail 说人话，none 摆后端给的短标记（空响应 / 无内容可评…）。
 *  **绝不**把 none 写成 0 分或「不通过」—— 那是本视图最要紧的一条区分。 */
function outcomeText(u: CompareUnit | null): string {
  if (!u) return "缺席";
  if (u.outcome === "pass") return "通过";
  if (u.outcome === "fail") return "不通过";
  return u.noteMark || "无判定";
}

function outcomeCls(u: CompareUnit | null): string {
  if (!u) return "is-absent";
  return u.outcome === "pass" ? "is-pass" : u.outcome === "fail" ? "is-fail" : "is-none";
}

function PairRow({ pair, stageIndex, unitWord, focus }: {
  pair: UnitPair;
  stageIndex: number;
  unitWord: string;
  /** 只在这一行就是深链落点时非空（父级按 title 已经筛过） */
  focus: CompareFocus | null;
}) {
  const [open, setOpen] = useState(false);
  const id = `plan-compare-pair-${stageIndex}-${pair.slug}`;
  const rootRef = useRef<HTMLDivElement>(null);
  // 深链落点：展开 + 滚入视口。依赖 nonce 而不是 focus 对象：同一条再点一次
  // 也要再滚一次（用户已经滚走了）。jsdom 没有 scrollIntoView ⇒ 守卫。
  const nonce = focus?.nonce ?? null;
  useEffect(() => {
    if (nonce == null) return;
    setOpen(true);
    const el = rootRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [nonce]);
  return (
    <div
      ref={rootRef}
      className={`cmp-pair${open ? " is-open" : ""}${nonce != null ? " is-focus" : ""}`}
      data-testid={id}
    >
      <button
        type="button"
        className="cmp-pair-head"
        aria-expanded={open}
        data-testid={`${id}-toggle`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chev-r" className="ic-sm chev" />
        <span className="pn lat" title={pair.title}>{pair.title}</span>
        {pair.sub && <span className="ps" title={pair.sub}>{pair.sub}</span>}
        <span className="spacer" style={{ flex: 1 }} />
        {/* 两个结论词各带一道本栏色的下划线（`is-side-*`），**文字颜色仍归
            过/挂**：折叠态是全屏最常扫的一行，只靠位置分「哪个是哪一次」，
            在长列表里翻着看时很容易读串。两套语义各占一个通道，互不覆盖。 */}
        {/* 分数桶专属的那对数：这两桶的两个结论词都是「通过」，只印结论词读出来是
            「通过 → 通过」，与它所在的「分数涨了/跌了」自相矛盾 —— 唯一的差别只有
            这对数说得出来。摆在结论词**前面**：结论词是这一行的固定收尾（每一桶都
            有，眼睛按位置找它），插在它后面会把那个位置挤掉。 */}
        {pair.scoreText && (
          <span
            className={`pd is-${pair.bucket === "scoreUp" ? "up" : "down"}`}
            data-testid={`${id}-score`}
          >
            {pair.scoreText}
          </span>
        )}
        <span className={`pv is-side-a ${outcomeCls(pair.a)}`}>{outcomeText(pair.a)}</span>
        <span className="pv-arrow">→</span>
        <span className={`pv is-side-b ${outcomeCls(pair.b)}`}>{outcomeText(pair.b)}</span>
      </button>
      {/* 对不上的原因（同名不同题面那条最要紧）——折叠态就得看见，
          它解释的正是「为什么这一条不在三桶里」 */}
      {pair.why && (
        <p className="cmp-pair-why" data-testid={`${id}-why`}>{pair.why}</p>
      )}
      {open && (
        <div className="cmp-pair-body" data-testid={`${id}-body`}>
          <PairBody pair={pair} unitWord={unitWord} />
        </div>
      )}
    </div>
  );
}

/** 展开态：输入（两次相同就只摆一次）→ 回答并排 → 逐评估器判分理由并排。 */
function PairBody({ pair, unitWord }: { pair: UnitPair; unitWord: string }) {
  const { a, b } = pair;
  const sameInput = (a?.input ?? "") === (b?.input ?? "");
  const names: string[] = [];
  for (const v of a?.verdicts ?? []) if (!names.includes(v.name)) names.push(v.name);
  for (const v of b?.verdicts ?? []) if (!names.includes(v.name)) names.push(v.name);

  return (
    <>
      {(a?.input || b?.input) && (
        sameInput ? (
          <Field label="输入">
            {/* 两次输入逐字相同 ⇒ 这一格**不属于任何一栏**。给它 `is-a` 会让它
                挂上「上一次」的身份色，读起来像是只有那一次有这个输入。 */}
            <Text side="both" text={a?.input ?? b?.input ?? ""} testId="plan-compare-input" />
          </Field>
        ) : (
          <Pair2 label="输入（两次不同）">
            <Text side="a" text={a?.input ?? ""} testId="plan-compare-input-a" absent={!a} unitWord={unitWord} />
            <Text side="b" text={b?.input ?? ""} testId="plan-compare-input-b" absent={!b} unitWord={unitWord} />
          </Pair2>
        )
      )}
      <Pair2 label="回答">
        <Text side="a" text={a?.output ?? ""} testId="plan-compare-output-a" absent={!a} unitWord={unitWord} />
        <Text side="b" text={b?.output ?? ""} testId="plan-compare-output-b" absent={!b} unitWord={unitWord} />
      </Pair2>
      {/* 没有判定的那一侧：后端原话摆在最前面 —— 「为什么没有判定」就是这一侧的
          全部信息（空响应 / 调用失败 / judge 无对话可判…） */}
      {(a?.noteText || b?.noteText) && (
        <Pair2 label="没有判定的原因">
          <Note side="a" u={a} />
          <Note side="b" u={b} />
        </Pair2>
      )}
      {names.map((name) => (
        <Pair2 key={name} label={`判分理由 · ${name}`}>
          <Verdict side="a" u={a} name={name} unitWord={unitWord} />
          <Verdict side="b" u={b} name={name} unitWord={unitWord} />
        </Pair2>
      ))}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cmp-field">
      <div className="fl">{label}</div>
      {children}
    </div>
  );
}

function Pair2({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cmp-field">
      <div className="fl">{label}</div>
      <div className="cmp-2">
        {/* 每一对格子自带栏头。展开态离顶部那两栏身份可能隔着好几屏，此前这一对
            格子里**没有任何**说明哪格是哪一次的东西 —— 只有「左边是较早的」这个
            约定，而滚到屏幕中间的一对格子看不出左右属于谁。四个字 + 一个圆点：
            认色的人扫色，不认色的人读字，两条路都通。 */}
        <div className="cmp-2h is-a"><span className="cdot" aria-hidden="true" />{SIDE_WORD.a}</div>
        <div className="cmp-2h is-b"><span className="cdot" aria-hidden="true" />{SIDE_WORD.b}</div>
        {children}
      </div>
    </div>
  );
}

/** 长文本不截断、不给「展开全文」：改用固定高度内滚动 —— 对比要的是同时看见
 *  两侧，一侧展开把另一侧顶走就失去了并排的意义（高度由 CSS 管）。 */
function Text({ side, text, testId, absent, unitWord }: {
  /** `both` = 两侧逐字相同、只摆一次的那一格（没有身份色，也没有缺席措辞） */
  side: "a" | "b" | "both";
  text: string;
  testId: string;
  absent?: boolean;
  unitWord?: string;
}) {
  return (
    <div className={`cmp-tx is-${side}`} data-testid={testId}>
      {absent && side !== "both"
        ? <span className="cmp-absent">{SIDE_WORD[side]}没有这个{unitWord ?? "条目"}</span>
        : <span className="tx">{text || EMPTY_MARK}</span>}
    </div>
  );
}

function Note({ side, u }: { side: "a" | "b"; u: CompareUnit | null }) {
  return (
    <div className={`cmp-tx is-${side}`} data-testid={`plan-compare-note-${side}`}>
      {u?.noteText
        ? <><span className="cmp-mark">{u.noteMark}</span><span className="tx">{u.noteText}</span></>
        : <span className="tx subtle">{EMPTY_MARK}</span>}
    </div>
  );
}

/** 一侧的一个评估器判定：分数 + 通过与否 + judge 原话。
 *  errored 走中性「评估失败」（**不是 0**）；这一侧压根没有这个评估器时说清楚。 */
function Verdict({ side, u, name, unitWord }: {
  side: "a" | "b";
  u: CompareUnit | null;
  name: string;
  unitWord: string;
}) {
  const v = u?.verdicts.find((x) => x.name === name) ?? null;
  return (
    <div className={`cmp-tx is-${side}`} data-testid={`plan-compare-reason-${name}-${side}`}>
      {!u ? (
        <span className="cmp-absent">{SIDE_WORD[side]}没有这个{unitWord}</span>
      ) : !v ? (
        // 两侧配的评估器可以不同（方案在两次运行之间改过）——说清是哪一侧没有
        <span className="cmp-absent">{SIDE_WORD[side]}没有这个评估器的判定</span>
      ) : (
        <>
          <span className="cmp-vh">
            {/* 端点加位（fmtScoreExact，不是全站的 fmtScore）：这一格是逐评估器
                涨跌的**读数处** —— 两侧一个 0.9981 一个 1.0，用 fmtScore 印出来
                都是 1.00，于是「同一把尺子给了两个不同的分」在界面上消失，而这一整
                页问的就是那个差。全站其余消费点仍用 fmtScore。 */}
            <span className={`vs${v.errored ? " is-none" : ""}`}>
              {v.errored ? "评估失败（未产出判定）" : fmtScoreExact(v.score)}
            </span>
            {!v.errored && v.passed != null && (
              <span className={v.passed ? "vp is-pass" : "vp is-fail"}>
                {v.passed ? "通过" : "不通过"}
              </span>
            )}
          </span>
          <span className="tx">{v.reason || EMPTY_MARK}</span>
        </>
      )}
    </div>
  );
}
