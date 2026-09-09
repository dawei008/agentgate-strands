// 评估分析页的跨 run 区块（ADR-0014 后果②④，批 adr0014-migrate，用户选定变体 C）。
// 压在既有三段（口径 / 逐环节对比 / 逐用例对照）之上，自上而下：
//   1. 趋势图 —— 线上评估均分逐 run 折线 + 目标线。**复用** plan/TrendCard 的派生
//      与图体（ScoreTrendBody），承担原综合报告「整体趋势」段的职责；那一段正文
//      不渲染（图比话准）。
//   2. 两段并排卡 —— 「反复出现的问题」「改进采纳效果」。正文 = **这一次** run 的
//      synthesis_sections（综合报告是计划级、每次 run 出一版，planrun.py:1204；
//      评估分析选中的「这一次」就是要读的那版）；老数据无 sections 时按 `## ` 切
//      plan_synthesis（derive.sectionsOf，四个消费方同一份 fallback）。
//      正文用 SynthesisText 渲；引用 chip 点了跳下方逐用例对照里那一行（后果④）。
//   3. 采纳追踪表 —— 该计划各 run 的 proposals 合成一张表。原「当前优先建议」段
//      不再作为正文出现：它的条目就是表里「未采纳」组的行。采纳复用既有 action
//      set_proposal_adopted（原 ImprovementBlock 的调用与回执处理搬过来）。
//
// 缺席规则（不留空壳）：两次没选够 ⇒ 整块不挂（ComparePage 只在 pair 成立时渲染
// 本组件）；有分点 <2 ⇒ 趋势卡不画；两段标题都不在 ⇒ 两段块不画；一条处方都
// 没有 ⇒ 采纳表不画；三块都没有 ⇒ 本组件返回 null。
//
// 界面零通用散文：本文件的静态字串只有标题 / 表头 / 状态词 / 动作词，没有一句对
// 任何 run 都成立的话。
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import type { ApiEvent } from "../../lib/api";
import { EMPTY_MARK, textOf } from "../../lib/renderText";
import SynthesisText, {
  synthRefFull, synthRefLabel, synthesisRefs, type SynthRef,
} from "../../components/SynthesisText";
import ConfirmCard from "../../components/ConfirmCard";
import { ScoreTrendBody, TREND_TARGET } from "../plan/TrendCard";
import { improvementPayload, sectionsOf, trendPoints } from "../plan/derive";
import type {
  ImprovementEvent, PlanRunDetail, PlanRunsEvent, ProposalAdoptedEvent, SynthesisSection,
} from "../plan/types";
import { adoptionRows, compareStages, type AdoptionRow, type RunWithProposals } from "../plan/compare/derive";
import type { ComparePair, CompareViewRun } from "../plan/compare/CompareView";
// 趋势图体的样式住在 plan.css（.plan-trend-*）；本页不经方案详情页，得自己带上
import "../plan/plan.css";
import "./analysis.css";

/** 两段卡各自的标题（后端 SYNTHESIS_SYSTEM_PROMPT 固定四节里的两节，逐字）。 */
const SECTION_RECURRING = "反复出现的问题";
const SECTION_ADOPTED = "改进采纳效果";

export default function AnalysisSections({ pair, pool, onJump, showTrend: wantTrend = true }: {
  pair: ComparePair;
  /** 候选池（本页 list_recent_runs 那份）：只为读「这一次」的 plan_id */
  pool: CompareViewRun[];
  /** 引用 chip → 下方逐用例对照那一行（title = UnitPair.title） */
  onJump: (title: string) => void;
  /** 趋势卡开关（默认开 = 对比页原样）。Agent 详情 ③ 用评估器面板取代合成分趋势
   *  （ADR-0016 口径修订），挂本组件只为老形状 run 的两段卡 + 采纳追踪 ⇒ 传 false。 */
  showTrend?: boolean;
}) {
  // 「这一次」所属的计划：候选池行带 plan_id；缺了退到 run_key 前缀
  // （run_key = `<plan_id>#<ts>`，planrun._planrun_item 的 sk）。
  const thisRun = pool.find((r) => r.run_key === pair.bKey);
  const planId = thisRun?.plan_id || pair.bKey.split("#")[0];

  // 计划的运行历史：趋势点位与采纳表都吃它。queryKey 与方案详情 / 报告页同键
  // ⇒ 从那边过来直接命中缓存。
  const runsQuery = useQuery({
    queryKey: ["plan_runs", planId],
    queryFn: () =>
      apiOne<PlanRunsEvent>({ action: "list_plan_runs", plan_id: planId }, "plan_runs"),
  });
  const runs = useMemo<RunWithProposals[]>(
    () => (runsQuery.data?.runs ?? []) as RunWithProposals[], [runsQuery.data]);

  // 两侧归档：与 CompareView 同 queryKey（["plan_run", key]）⇒ 同一份请求。
  // 这里要它们是为了①「这一次」的分节正文、②逐用例对照里有哪些行（chip 有没有落点）。
  const aQuery = useRunDetail(pair.aKey);
  const bQuery = useRunDetail(pair.bKey);
  const unitTitles = useMemo(() => {
    const set = new Set<string>();
    for (const s of compareStages(aQuery.data, bQuery.data)) {
      for (const p of s.pairs) set.add(p.title);
    }
    return set;
  }, [aQuery.data, bQuery.data]);

  const sections = useMemo<SynthesisSection[]>(() => sectionsOf(bQuery.data), [bQuery.data]);
  const recurring = sectionOf(sections, SECTION_RECURRING);
  const adopted = sectionOf(sections, SECTION_ADOPTED);

  const points = useMemo(() => trendPoints(runs), [runs]);
  const rows = useMemo(() => adoptionRows(runs, (s) => synthesisRefs(s).length), [runs]);

  // 「生成改进稿」的料：判据在 generateInputOf（与 Agent 详情 ③ 的台账共用）
  const generate = useMemo(() => generateInputOf(bQuery.data, pair.bKey), [bQuery.data, pair.bKey]);

  const showTrend = wantTrend && points.length >= 2;
  const showTwo = recurring != null || adopted != null;
  // 一条处方都没有但这一次能生成 ⇒ 卡照画（只有卡头与入口），否则第一条永远发不起
  const showAdoption = rows.pending.length + rows.done.length > 0 || generate != null;
  if (!showTrend && !showTwo && !showAdoption) return null;

  /** chip 有没有落点：用例名 / 会话 id 在下方逐用例对照里有一行才算；run 编号没有 */
  const jumpable = (ref: SynthRef) =>
    ref.kind === "case" ? unitTitles.has(ref.name)
      : ref.kind === "session" ? unitTitles.has(ref.id)
        : false;
  const jump = (ref: SynthRef) => {
    if (ref.kind === "case") onJump(ref.name);
    else if (ref.kind === "session") onJump(ref.id);
  };

  return (
    <div className="an-sections" data-testid="analysis-sections">
      {showTrend && (
        <div className="card" data-testid="analysis-trend">
          <div className="card-head">
            <span className="card-title">线上评估均分</span>
            {/* 量词与方案详情的趋势卡同一句：本图只画 observe 分（有分运行），
                纯回归 / 纯红队 run 即使成功也没有点位 */}
            <span className="card-sub">最近 {points.length} 次有分运行 · 目标线 {TREND_TARGET}</span>
          </div>
          <ScoreTrendBody runs={runs} />
        </div>
      )}

      {showTwo && (
        <div
          className={`an-two${recurring && adopted ? "" : " is-one"}`}
          data-testid="analysis-synthesis"
        >
          {recurring && (
            <SectionCard id="recurring" section={recurring} jumpable={jumpable} onJump={jump} />
          )}
          {adopted && (
            <SectionCard id="adopted" section={adopted} jumpable={jumpable} onJump={jump} />
          )}
        </div>
      )}

      {showAdoption && <AdoptionTable rows={rows} planId={planId} generate={generate} />}
    </div>
  );
}

function useRunDetail(runKey: string) {
  return useQuery({
    queryKey: ["plan_run", runKey],
    queryFn: () =>
      apiOne<PlanRunDetail & ApiEvent>({ action: "get_plan_run", run_key: runKey }, "plan_run"),
  });
}

/** 标题逐字匹配且正文非空的那一节；老数据 fallback 会保留空正文的节，空的不画。 */
function sectionOf(sections: SynthesisSection[], title: string): SynthesisSection | null {
  const s = sections.find((x) => textOf(x.title).trim() === title);
  return s && textOf(s.body).trim() !== "" ? s : null;
}

// ---------- 两段卡 ----------
function SectionCard({ id, section, jumpable, onJump }: {
  id: "recurring" | "adopted";
  section: SynthesisSection;
  jumpable: (ref: SynthRef) => boolean;
  onJump: (ref: SynthRef) => void;
}) {
  const body = textOf(section.body);
  const refs = useMemo(() => synthesisRefs(body), [body]);
  return (
    <section className="card" data-testid={`analysis-section-${id}`}>
      <div className="card-head">
        <span className="card-title cjk">{textOf(section.title)}</span>
      </div>
      <div className="an-sec-body">
        <SynthesisText text={body} onRefClick={onJump} jumpable={jumpable} />
      </div>
      {/* 卡底「引用」行：正文点名的用例 / 会话 / run 去重各一枚；有落点的是按钮
          （双向深链，ADR-0014 后果④），没有落点的保持 span —— 不给死按钮 */}
      {refs.length > 0 && (
        <div className="an-refs" data-testid="analysis-section-refs">
          <span className="lbl">引用</span>
          {refs.map((ref) => {
            const label = synthRefLabel(ref);
            const full = synthRefFull(ref);
            return jumpable(ref) ? (
              <button
                key={`${ref.kind}|${full}`}
                type="button"
                className="badge an-ref is-link"
                data-testid="analysis-ref"
                data-full={full}
                onClick={() => onJump(ref)}
              >
                {label}
              </button>
            ) : (
              <span
                key={`${ref.kind}|${full}`}
                className="badge an-ref"
                data-testid="analysis-ref"
                data-full={full}
              >
                {label}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------- 采纳追踪表 ----------
//
// 采纳动作原样搬自 pages/plan/ImprovementBlock.tsx 的 onAdopt（该文件随本批删除）：
// set_proposal_adopted {run_key, index, adopted:true} → 回执 proposal_adopted 的
// adopted_at 就地翻转这一行；失效 ["plan_runs", planId]（列表行上就带 proposals，
// 重拉一次列表即得采纳态）。刻意**不**失效 ["plan_run", runKey]：那是一趟 S3 归档
// 读，而采纳态本表自己记着。后端是读改写整个数组 ⇒ 一次只转一颗圈。
//
// 「生成改进稿」（卡头右侧）：优化闭环里唯一会产生新建议的付费动作，同样搬自
// ImprovementBlock.onGenerate —— propose_improvements {agent_name, sessions, run_key}
// → 后端 attach_proposal 把新稿追加到这一次 run 的 proposals ⇒ 失效 ["plan_runs",
// planId] 重拉列表，新行就落进「未采纳」组。付费动作先出确认卡（成本披露只说这一次
// 的数：依据 N 个会话），失败原话钉在卡头下一行。
export interface GenerateInput {
  runKey: string;
  agentName: string;
  sessions: Record<string, unknown>[];
  usable: number;
}

/**
 * 「生成改进稿」的料：**这一次** run 的线上评估会话明细（derive.improvementPayload，
 * 判据与后端 collect_evidence 同刑）。usable = 0（没有 observe 明细 / 旧形状 run）
 * 或这份归档没记被测 Agent 名（后端 propose_improvements 的必填入参）⇒ 后端必抛
 * ⇒ 返回 null，入口整块缺席，不留禁用态。Agent 名只读归档自己的 agent_name，不退到
 * 候选池行 —— 两者本是同一个 DDB item 的两个投影，退过去等于替归档编一个它没记的名。
 * Agent 详情 ③ 的台账「待建议」行与本页采纳表卡头共用这一份判据。
 */
export function generateInputOf(detail: PlanRunDetail | null | undefined, runKey: string): GenerateInput | null {
  const agentName = textOf(detail?.agent_name).trim();
  const payload = improvementPayload(detail, agentName);
  return agentName !== "" && payload.usable > 0
    ? { runKey, agentName, sessions: payload.sessions, usable: payload.usable }
    : null;
}

/**
 * 采纳动作（原样搬自 pages/plan/ImprovementBlock.tsx 的 onAdopt，该文件已删）：
 * set_proposal_adopted {run_key, index, adopted:true} → 回执 proposal_adopted 的
 * adopted_at 就地翻转这一行；失效 ["plan_runs", planId]（列表行上就带 proposals，
 * 重拉一次列表即得采纳态）。刻意**不**失效 ["plan_run", runKey]：那是一趟 S3 归档读，
 * 而采纳态本表自己记着。后端是读改写整个数组 ⇒ 一次只转一颗圈。
 *
 * `adoptAdvice` 是同一个闭环的另一条入口（adopt_run_advice，ADR-0014 §6）：建议文本
 * 还没落成 proposals 条目时（台账里由诊断直接产出的建议），后端按 fix 文本落一条
 * **生成即已采纳**的条目；幂等键 = summary 全等。两条入口都记进同一份 adoptedAt。
 *
 * 抽成 hook（optimize-ledger 批）：评估分析页的采纳表与 Agent 详情 ③ 的问题台账
 * 共用一份状态机，对比页输出一字未改。
 */
export function useAdoption(planId: string) {
  const qc = useQueryClient();
  /** 本会话采纳成功的（key 由调用方定：采纳表用 rowKey，台账用 issue id） */
  const [adoptedAt, setAdoptedAt] = useState<Record<string, string>>({});
  const [adopting, setAdopting] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function run(key: string, call: () => Promise<string>) {
    if (adopting != null) return;
    setAdopting(key);
    setErrors((m) => {
      const next = { ...m };
      delete next[key];
      return next;
    });
    let ok = false;
    try {
      const at = await call();
      setAdoptedAt((m) => ({ ...m, [key]: at }));
      ok = true;
    } catch (e) {
      setErrors((m) => ({ ...m, [key]: e instanceof Error ? e.message : String(e) }));
    } finally {
      // 先放开别的行再重拉列表：重拉是网络往返，期间别的「采纳」链不该被连坐禁用
      setAdopting(null);
    }
    if (ok) await qc.invalidateQueries({ queryKey: ["plan_runs", planId] });
  }

  const adopt = (runKey: string, index: number, key: string) => run(key, async () => {
    const ev = await apiOne<ProposalAdoptedEvent & ApiEvent>({
      action: "set_proposal_adopted", run_key: runKey, index, adopted: true,
    }, "proposal_adopted");
    return textOf(ev.proposal?.adopted_at).trim() || "已采纳";
  });

  const adoptAdvice = (runKey: string, fix: string, refs: string[], key: string) => run(key, async () => {
    const ev = await apiOne<ProposalAdoptedEvent & ApiEvent>({
      action: "adopt_run_advice", run_key: runKey, fix, refs,
    }, "advice_adopted");
    return textOf(ev.proposal?.adopted_at).trim() || "已采纳";
  });

  return { adoptedAt, adopting, errors, adopt, adoptAdvice };
}

/**
 * 「生成改进稿」：优化闭环里唯一会产生新建议的付费动作（搬自 ImprovementBlock.onGenerate）
 * —— propose_improvements {agent_name, sessions, run_key} → 后端 attach_proposal 把新稿
 * 追加到这一次 run 的 proposals ⇒ 失效 ["plan_runs", planId] 重拉列表。付费动作先出确认卡
 * （成本披露只说这一次的数：依据 N 个会话），失败原话由调用方钉在版面上。
 * 生成态：idle（可点）/ confirm（确认卡开着）/ loading（真在调 judge）。
 */
export function useGenerate(planId: string) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<"idle" | "confirm" | "loading">("idle");
  const [error, setError] = useState<string | null>(null);

  async function run(generate: GenerateInput) {
    setPhase("loading");
    setError(null);
    try {
      await apiOne<ImprovementEvent & ApiEvent>({
        action: "propose_improvements",
        agent_name: generate.agentName,
        sessions: generate.sessions,
        // 挂到这一次 run 上：采纳标记与下次运行的分数对比都需要这个锚
        run_key: generate.runKey,
      }, "improvement");
      // 新稿已由后端 attach 到该 run 的 proposals ⇒ 重拉列表即得新行
      await qc.invalidateQueries({ queryKey: ["plan_runs", planId] });
    } catch (e) {
      // 后端原话直出（证据不足 / maxTokens 被推理占满 / judge 报错），不改写不概括
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
    }
  }

  return { phase, error, open: () => setPhase("confirm"), cancel: () => setPhase("idle"), run };
}

/** 生成改进稿的确认卡（成本披露：这一次 run 的会话数），两处入口共用同一段话 */
export function GenerateConfirmCard({ generate, open, onConfirm, onCancel }: {
  generate: GenerateInput;
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmCard
      open={open}
      title="生成改进稿"
      body={
        <p>
          调用评估模型（judge）产生真实费用；依据本次 run 的 {generate.usable} 个会话，不重跑评估。
        </p>
      }
      confirmLabel="确认生成"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

function AdoptionTable({ rows, planId, generate }: {
  rows: { pending: AdoptionRow[]; done: AdoptionRow[] };
  planId: string;
  /** null = 这一次没有可依据的会话 ⇒ 入口整块不画 */
  generate: GenerateInput | null;
}) {
  const { adoptedAt, adopting, errors, adopt } = useAdoption(planId);
  const gen = useGenerate(planId);
  const genPhase = gen.phase;
  const genError = gen.error;
  const onAdopt = (row: AdoptionRow) => adopt(row.runKey, row.index, rowKey(row));

  const total = rows.pending.length + rows.done.length;
  return (
    <div className="card" data-testid="analysis-adoption">
      <div className="card-head">
        <span className="card-title">采纳追踪</span>
        {total > 0 && (
          <span className="card-sub">{total} 条建议 · 未采纳 {rows.pending.length}</span>
        )}
        {generate && (
          <>
            <span className="spacer" />
            <button
              type="button"
              className="btn-link"
              disabled={genPhase === "loading"}
              data-testid="analysis-generate"
              onClick={gen.open}
            >
              {genPhase === "loading" ? "生成中…" : "生成改进稿"}
            </button>
          </>
        )}
      </div>
      {genError && (
        <p className="an-gen-error" data-testid="analysis-generate-error">{genError}</p>
      )}
      {generate && (
        <GenerateConfirmCard
          generate={generate}
          open={genPhase === "confirm"}
          onConfirm={() => void gen.run(generate)}
          onCancel={gen.cancel}
        />
      )}
      {total > 0 && (
      <table className="u-table an-adopt">
        <thead>
          <tr>
            <th scope="col" className="c-sum">建议摘要</th>
            <th scope="col" className="c-gen">生成于</th>
            <th scope="col" className="c-state">采纳</th>
            <th scope="col" className="c-eff">采纳后效果</th>
            <th scope="col" className="c-act" />
          </tr>
        </thead>
        <tbody>
          {rows.pending.length > 0 && (
            <tr className="an-group" data-testid="analysis-adopt-group-pending">
              <td colSpan={5}>未采纳<span className="cnt">{rows.pending.length}</span></td>
            </tr>
          )}
          {rows.pending.map((row, i) => (
            <Row
              key={rowKey(row)}
              row={row}
              rank={i + 1}
              adoptedAt={adoptedAt[rowKey(row)] ?? row.adoptedAt}
              adopting={adopting === rowKey(row)}
              busy={adopting != null}
              error={errors[rowKey(row)]}
              onAdopt={() => void onAdopt(row)}
            />
          ))}
          {rows.done.length > 0 && (
            <tr className="an-group" data-testid="analysis-adopt-group-done">
              <td colSpan={5}>已采纳<span className="cnt">{rows.done.length}</span></td>
            </tr>
          )}
          {rows.done.map((row) => (
            <Row
              key={rowKey(row)}
              row={row}
              rank={null}
              adoptedAt={row.adoptedAt}
              adopting={false}
              busy={adopting != null}
              onAdopt={() => undefined}
            />
          ))}
        </tbody>
      </table>
      )}
    </div>
  );
}

/** run_key 自带 `#`，分隔用 `|` */
const rowKey = (row: AdoptionRow) => `${row.runKey}|${row.index}`;

function Row({ row, rank, adoptedAt, adopting, busy, error, onAdopt }: {
  row: AdoptionRow;
  /** 未采纳组的优先序号（1 起）；已采纳组不编号 */
  rank: number | null;
  /** 空串 = 未采纳 */
  adoptedAt: string;
  adopting: boolean;
  busy: boolean;
  error?: string;
  onAdopt: () => void;
}) {
  const id = `analysis-adopt-row-${row.runKey}-${row.index}`;
  return (
    <>
      <tr data-testid={id}>
        <td className="c-sum">
          {rank != null && <span className="an-rank num">{rank}</span>}
          {/* 摘要过 SynthesisText：LLM 摘要里点名的用例渲成 chip，不是裸 [case:…] */}
          <span className="an-sum">
            {row.summary ? <SynthesisText text={row.summary} /> : EMPTY_MARK}
          </span>
          {/* 依据（adopt_run_advice 落库的引用行）：这一条自己的事实，有才写 */}
          {row.refs.length > 0 && (
            <span className="an-sub" data-testid={`${id}-refs`}>{row.refs.join(" / ")}</span>
          )}
        </td>
        <td className="c-gen" data-testid={`${id}-gen`}>
          {row.seq != null && <span className="seq">#{row.seq}</span>}
          {row.generatedAt || EMPTY_MARK}
        </td>
        <td className="c-state">
          {adoptedAt ? (
            <span className="badge ok badge-mono" data-testid={`${id}-state`}>已采纳 · {adoptedAt}</span>
          ) : (
            <span className="badge warn" data-testid={`${id}-state`}>未采纳</span>
          )}
        </td>
        <td className="c-eff" data-testid={`${id}-effect`}>
          {row.effect.length > 0
            ? row.effect.map((t, i) => <span className="an-eff-item" key={i}>{t}</span>)
            : <span className="an-empty">{EMPTY_MARK}</span>}
        </td>
        <td className="c-act">
          {!adoptedAt && (
            <button
              type="button"
              className="btn-link"
              disabled={busy}
              data-testid={`${id}-adopt`}
              onClick={onAdopt}
            >
              {adopting ? "标记中…" : "采纳"}
            </button>
          )}
        </td>
      </tr>
      {error && (
        <tr className="an-row-error">
          <td colSpan={5} data-testid={`${id}-error`}>{error}</td>
        </tr>
      )}
    </>
  );
}
