// ② 结论一句：一行现算事实句，只列这一次的数（ADR-0014 第 2 条）。
//
// 决策口径（CONTEXT.md「线上评估均分」词条 2026-09-03 修订）：看每个评估器过不过
// 0.70 目标线。所以这一句的主语是**最差的那个评估器**（它的「该评估器均分」、通过率、
// 几个会话被判成什么标签），其余过线的只报名字与区间；全过时写「N 个评估器全部过线 ·
// 最低 X」。合成均分不进这一句。
//
// 没有任何评估器有均分（纯红队 run / 全部 errored / 非终态）⇒ 退回 reportRows.runVerdict
// 的裁决句（红队被攻破 N/M、环节执行失败、没跑成…），那一份口径与抽屉同源。
import { SCORE_TARGET } from "../plan/derive";
import { matrixRowAnchor, shortSessionId, type RunVerdict } from "../plan/reportRows";
import { f3, pct, type PageVerdictFacts, type TileRef } from "./model";

export default function VerdictLine({ facts, fallback, onJump }: {
  facts: PageVerdictFacts;
  fallback: RunVerdict;
  /** 深链到矩阵行（会话 / 用例）：滚动 + 高亮，由页面持有目标态 */
  onJump: (anchorId: string) => void;
}) {
  const { worstRef, underRefs } = facts;
  if (!worstRef) {
    return (
      <p className={`rpg-verdict is-${fallback.tone}`} data-testid="report-verdict">
        <span className={`badge ${fallback.tone === "ok" ? "ok" : fallback.tone === "bad" ? "bad" : ""}`}>
          {fallback.tone === "ok" ? "过线" : fallback.tone === "bad" ? "未过线" : "无结论"}
        </span>
        <span>{fallback.text}</span>
      </p>
    );
  }

  // 评估器维度说不出的两件：红队被攻破、没跑成的行 —— 两个分支都要带上
  const extras: React.ReactNode[] = [];
  if (facts.breached && facts.breached.n > 0) {
    extras.push(<span key="rt">红队被攻破 <span className="rpg-n">{facts.breached.n}/{facts.breached.total}</span></span>);
  }
  if (facts.none > 0) {
    extras.push(<span key="none"><span className="rpg-n">{facts.none}</span> 条没跑成</span>);
  }
  const extraTail = extras.length > 0 && (
    <span data-testid="report-verdict-extras">
      {extras.map((e, i) => <span key={i}>{" · "}{e}</span>)}
    </span>
  );

  if (facts.allPass) {
    const n = facts.scoredRefs.length;
    const breachedAny = (facts.breached?.n ?? 0) > 0;
    return (
      <p className={`rpg-verdict ${breachedAny ? "is-bad" : "is-ok"}`} data-testid="report-verdict">
        <span className={`badge ${breachedAny ? "bad" : "ok"}`}>{breachedAny ? "被攻破" : "过线"}</span>
        <span>
          {n} 个评估器全部过线 · 最低 <span className="rpg-ev">{worstRef.tile.name}</span>{" "}
          <span className="rpg-n">{f3(worstRef.tile.mean as number)}</span>
          <span className="rpg-verdict-note" title={`目标线 ${f3(SCORE_TARGET)}：每个评估器的该评估器均分都要 ≥ 这条线`}>
            {" "}· 目标线 {f3(SCORE_TARGET)}
          </span>
          {extraTail}
        </span>
      </p>
    );
  }

  const w = worstRef.tile;
  const unit = worstRef.view.unit;
  const gi = worstRef.view.group.index;
  const okRefs = facts.scoredRefs.filter((r) => !r.tile.under);
  const okMeans = okRefs.map((r) => r.tile.mean as number);
  const othersUnder = underRefs.filter((r) => r !== worstRef);
  const failing = facts.worstFailing;
  const allFail = facts.allFailRows[0];
  const evCount = worstRef.view.tiles.length;

  return (
    <p className="rpg-verdict is-bad" data-testid="report-verdict">
      <span className="badge warn">未过线</span>
      <span>
        <span className="rpg-ev">{w.name}</span> 该评估器均分 <span className="rpg-n">{f3(w.mean as number)}</span>
        {w.passRate != null && <>、通过 <span className="rpg-n">{pct(w.passRate)}</span></>}
        {failing.rows.length > 0 && (
          <>
            ，{w.judged} 个{unit}里 <span className="rpg-n">{failing.rows.length}</span> 个
            {failing.label ? <>被判 “<span className="rpg-label">{failing.label}</span>”</> : "未过"}
          </>
        )}
        {othersUnder.length > 0 && (
          <>；{joinNames(othersUnder)} 也未过线</>
        )}
        {okRefs.length > 0 && (
          <>
            ；{joinNames(okRefs)}{" "}
            <span className="rpg-n">
              {okMeans.length > 1 && Math.min(...okMeans) !== Math.max(...okMeans)
                ? `${f3(Math.min(...okMeans))}–${f3(Math.max(...okMeans))}`
                : f3(okMeans[0])}
            </span>{" "}过线
          </>
        )}
        。
        {allFail && (
          <>
            {unit}{" "}
            <a
              className="rpg-sid"
              href={`#${matrixRowAnchor(gi, allFail.name)}`}
              title={allFail.name}
              data-testid="report-verdict-allfail"
              onClick={(e) => { e.preventDefault(); onJump(matrixRowAnchor(gi, allFail.name)); }}
            >
              {shortSessionId(allFail.name)}
            </a>{" "}
            {evCount} 项全部未过。
          </>
        )}
        {extraTail}
      </span>
    </p>
  );
}

function joinNames(refs: TileRef[]) {
  return refs.map((r, i) => (
    <span key={`${r.view.group.index}:${r.tile.name}`}>
      {i > 0 && " / "}
      <span className="rpg-ev">{r.tile.name}</span>
    </span>
  ));
}
