// ⑤ 评估器 tile：每个评估器一张实心卡 —— 名 · 过线/未过线 badge · 大数字（该评估器均分）
// · 目标线刻度条 · 通过率 · 最差会话（深链矩阵行）· 报错数。
//
// 颜色只给状态：未过线 = warn（badge + 条 + 左侧色条），过线 = ok；没评出均分（mean null）
// 是中性档，**不是** 0 —— 0 是「评了且很差」。
import { SCORE_TARGET } from "../plan/derive";
import { matrixRowAnchor, shortSessionId } from "../plan/reportRows";
import { f3, pct, type StageView } from "./model";

export default function EvaluatorTiles({ view, showStage, onJump }: {
  view: StageView;
  /** 多环节 run：tile 名旁带环节名（同名评估器可能在两个环节各有一张） */
  showStage: boolean;
  onJump: (anchorId: string) => void;
}) {
  const gi = view.group.index;
  return (
    <div className="rpg-tiles" data-testid={`report-tiles-${gi}`}>
      {view.tiles.map((t) => {
        const tone = t.mean == null ? "none" : t.under ? "warn" : "ok";
        const worst = t.worst;
        return (
          <article
            key={t.name}
            className={`card rpg-tile is-${tone}`}
            data-testid={`report-tile-${gi}-${t.name}`}
          >
            <div className="rpg-tile-head">
              <span className="rpg-tile-name mono">
                {t.name}
                {showStage && <span className="rpg-tile-stage">{view.label}</span>}
              </span>
              <span
                className={`badge${tone === "ok" ? " ok" : tone === "warn" ? " warn" : ""}`}
                data-testid={`report-tile-${gi}-${t.name}-badge`}
              >
                {tone === "ok" ? "过线" : tone === "warn" ? "未过线" : "未评出"}
              </span>
            </div>
            <div className="rpg-tile-num" data-testid={`report-tile-${gi}-${t.name}-mean`}>
              {t.mean == null ? "—" : f3(t.mean)}
              <span className="lbl">该评估器均分</span>
            </div>
            <div className="rpg-tile-bar">
              <span
                className="meter-track with-target rpg-meter"
                style={{ "--meter-target": `${Math.round(SCORE_TARGET * 100)}%` } as React.CSSProperties}
                aria-hidden="true"
              >
                <span
                  className={`meter-fill${tone === "warn" ? " warn" : ""}`}
                  style={{ width: `${Math.round((t.mean ?? 0) * 100)}%` }}
                />
              </span>
              <span>目标线 <span className="mono">{f3(SCORE_TARGET)}</span></span>
            </div>
            <dl className="rpg-tile-sub">
              <div className="row">
                <dt>通过率</dt>
                <dd className="mono" data-testid={`report-tile-${gi}-${t.name}-pass`}>
                  {t.passRate == null ? "—" : `${pct(t.passRate)} · ${t.passed}/${t.judged}`}
                </dd>
              </div>
              <div className="row">
                <dt>最差{view.unit}</dt>
                <dd className="mono" data-testid={`report-tile-${gi}-${t.name}-worst`}>
                  {worst.length === 0 ? "—" : worst.length > 1 ? (
                    <>
                      <a
                        className="rpg-sid"
                        href={`#${matrixRowAnchor(gi, worst[0].rowName)}`}
                        title={worst.map((w) => w.rowName).join("\n")}
                        onClick={(e) => { e.preventDefault(); onJump(matrixRowAnchor(gi, worst[0].rowName)); }}
                      >
                        {worst.length} 个{view.unit}并列
                      </a>{" "}{f3(worst[0].score)}
                    </>
                  ) : (
                    <>
                      <a
                        className="rpg-sid"
                        href={`#${matrixRowAnchor(gi, worst[0].rowName)}`}
                        title={worst[0].rowName}
                        onClick={(e) => { e.preventDefault(); onJump(matrixRowAnchor(gi, worst[0].rowName)); }}
                      >
                        {shortSessionId(worst[0].rowName)}
                      </a>{" "}{f3(worst[0].score)}
                    </>
                  )}
                </dd>
              </div>
              <div className="row">
                <dt>报错</dt>
                <dd className="mono" data-testid={`report-tile-${gi}-${t.name}-errored`}>{t.errored}</dd>
              </div>
            </dl>
          </article>
        );
      })}
    </div>
  );
}
