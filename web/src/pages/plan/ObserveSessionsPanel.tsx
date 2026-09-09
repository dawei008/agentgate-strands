// 线上评估（observe）环节的实时会话清单：进度卡内、实时对话面板旁的一格。
//
// 为什么是清单不是对话分栏：observe 评的是已结束的 trace，后端不发逐轮事件
// （app/planrun.py 的 observe 出口只有 session_result / session_error），且会话
// 并发评、乱序完成。用户拍板「实时会话清单：评完一条落一行」。
// 状态层与四个数据坑的说明见 observeSessions.ts 顶部。
//
// 界面上必须说清的两件事（不说就会被读错）：
//   1. **行序 = 评完顺序**，不是会话时间顺序（并发 4 条同时在评）。
//   2. **无分数 ≠ 0 分**。判定/趋势一律指向报告，本格只报已发生的事实。
//
// 玻璃纪律：位于唯一玻璃层（.plan-progress 实心 --bg2 卡）内部，零 blur；
// chip/badge 沿用全站实心底类；颜色按名引用 tokens.css。样式见 plan.css .obs-* 段。
import { memo, useCallback, useState } from "react";
// 分数排版（无分 → "—"）走 lib/scoring.fmtScore：口径单一来源，ADR-0003
import { fmtScore } from "../../lib/scoring";
import {
  ROW_KEEP, doneCount, shortSessionId,
  type ObserveRow, type ObserveSessionsState, type ObserveStatus,
} from "./observeSessions";

/** session_id 里可能有 `:`/`#`（trace id 形态各家不同）→ testid 用连字符形态 */
export function rowTestId(key: string): string {
  return `plan-observe-row-${key.replace(/[^\w-]+/g, "-")}`;
}

/** 四档结论的短标签。**没有 0 分档** —— 实时期不做判定。 */
const STATUS: Record<ObserveStatus, { badge: string; cls: string; mean: string }> = {
  scored: { badge: "已评分", cls: "ok", mean: "" },
  // 评估器全挂（judge 被限流/传输错）→ SDK 会伪造 0 分，后端已置 null
  "no-score": { badge: "无可评分项", cls: "warn", mean: "无分" },
  // trace 里没有消息内容（多为被测 agent 没开 capture message content）
  "no-content": { badge: "无内容可评", cls: "warn", mean: "无分" },
  errored: { badge: "评分失败", cls: "bad", mean: "—" },
};

const Row = memo(function Row(
  { row, expanded, onToggle }: {
    row: ObserveRow;
    expanded: boolean;
    onToggle: (key: string) => void;
  },
) {
  const st = STATUS[row.status];
  const tid = rowTestId(row.key);
  // 有 reason 可看才给「详情」——大多数已评分会话的 reason 是长文，默认不占屏
  const hasDetail = row.scores.some((s) => s.reason) || !!row.outputPreview;
  return (
    <li className="obs-row" data-testid={tid} data-status={row.status}>
      <div className="obs-row-head">
        <span className="obs-seq num" aria-hidden="true">{row.seq}</span>
        {/* 短 id 与滚动日志同口径；全文进 title，排查时可复制 */}
        <span className="obs-id num" title={row.sessionId ?? undefined}>
          {row.sessionId ? shortSessionId(row.sessionId) : "（未带会话 id）"}
        </span>
        {/* 本会话均分：null **不显示 0**，显示「无分」/「—」并另有档位 badge */}
        <span className="obs-mean num" data-testid={`${tid}-mean`}>
          {row.mean != null ? row.mean.toFixed(2) : st.mean}
        </span>
        <span className={`badge ${st.cls} obs-badge`}>{st.badge}</span>
        <span className="obs-scores">
          {row.scores.map((s) => (
            <span
              key={s.name}
              className="chip obs-score"
              data-errored={s.errored || undefined}
              title={s.reason || undefined}
            >
              {s.name}
              <span className="n">{fmtScore(s.score)}</span>
            </span>
          ))}
        </span>
        {row.spanCount != null && row.spanCount > 0 && (
          <span className="obs-spans num">{row.spanCount} span</span>
        )}
        <span className="spacer" style={{ flex: 1 }} />
        {hasDetail && (
          <button
            type="button"
            className="btn-link obs-more"
            data-testid={`${tid}-expand`}
            aria-expanded={expanded}
            onClick={() => onToggle(row.key)}
          >
            {expanded ? "收起" : "详情"}
          </button>
        )}
      </div>
      {/* session_error：后端给的原因原样展示（缺原因时状态层已给中性兜底） */}
      {row.error && <p className="obs-err" data-testid={`${tid}-error`}>{row.error}</p>}
      {/* no_content 的 warning 解释「为什么没内容」，比一个 0 分有用得多 */}
      {row.warning && <p className="obs-warn" data-testid={`${tid}-warning`}>{row.warning}</p>}
      {expanded && (
        <div className="obs-detail" data-testid={`${tid}-detail`}>
          {row.outputPreview && (
            <p className="obs-preview">{row.outputPreview}</p>
          )}
          {row.scores.filter((s) => s.reason).map((s) => (
            <p className="obs-reason" key={s.name}>
              <b>{s.name}</b>
              {/* reason 后端可能给对象（app/main.py 不做 str 强转），状态层已
                  规范化成字符串 —— 组件永远只拿到 string，不会白屏 */}
              <span>{s.reason}</span>
            </p>
          ))}
        </div>
      )}
    </li>
  );
});

export default function ObserveSessionsPanel(
  { sessions, live = false }: { sessions?: ObserveSessionsState; live?: boolean },
) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggleRow = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 没有 observe 环节就整格不存在——不画空壳。
  // 只收到分母还没落行时也不画：一个「已评 0/10」的空框比没有更让人焦虑。
  if (!sessions || sessions.rows.length === 0) return null;

  const done = doneCount(sessions);

  return (
    // aria-live=off：祖先 .plan-progress 是 role=status 活区，逐条会话灌进去
    // 会让读屏器把每一条都念出来
    <div
      className="obs"
      data-open={open}
      data-testid="plan-observe-sessions"
      aria-live="off"
    >
      <div className="obs-head">
        <button
          type="button"
          className="atk-toggle"
          data-testid="plan-observe-sessions-toggle"
          aria-expanded={open}
          aria-controls="plan-observe-rows"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="atk-tw" aria-hidden="true">▾</span>实时会话清单
        </button>
        {live ? (
          <span className="badge run obs-badge"><span className="dot" />评估中</span>
        ) : (
          <span className="badge obs-badge">已停止推送</span>
        )}
        <span className="obs-count num" data-testid="plan-observe-sessions-count">
          {/* 分母来自 observe_sessions 事件；没收到就**不编分母**，只说已评几条 */}
          已评 <b>{done}</b>{sessions.total != null && `/${sessions.total}`} 会话
          {sessions.scored > 0 && ` · 有分数 ${sessions.scored}`}
          {sessions.noScore > 0 && ` · 无可评分项 ${sessions.noScore}`}
          {sessions.noContent > 0 && ` · 无内容可评 ${sessions.noContent}`}
          {sessions.errored > 0 && ` · 失败 ${sessions.errored}`}
          {sessions.dropped > 0
            && ` · 本页只留最近 ${ROW_KEEP} 条（前 ${sessions.dropped} 条已释放）`}
        </span>
      </div>

      {/* 常驻说明条（「按评完顺序排列…本会话均分只统计有分数的评估器…结论与趋势见
          报告」）对任何线上评估 run 恒成立 ⇒ 整块删（prose-sweep 2026-09-03） */}

      <ul id="plan-observe-rows" className="obs-rows" data-testid="plan-observe-rows">
        {sessions.rows.map((row) => (
          // key 用 session_id（乱序到达 + 可能重发，下标/到达序都会漂）
          <Row
            key={row.key}
            row={row}
            expanded={expanded.has(row.key)}
            onToggle={toggleRow}
          />
        ))}
      </ul>
    </div>
  );
}
