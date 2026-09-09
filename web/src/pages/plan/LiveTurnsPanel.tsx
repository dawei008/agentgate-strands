// 运行中实时对话面板：进度卡内、滚动日志下方的一格。
// **三类环节共用同一个面板**（用户拍板：「复用红队面板，三类环节统一看对话」）：
//   · 红队测试    ← attack_turn 事件（app/redteam.py:685）
//   · 回归 / 模拟 ← turn 事件（app/testrun.py:601）
// 原型权威：ui-prototypes/redteam-turns/index.html 场景 A（shot-a.png）。
//
// 形态取舍照原型「为什么这么选（场景 A）」，逐条落地：
//   · 并发多路 → 分栏并排（红队上限 3 = MAX_CONCURRENT_ATTACKS；
//     回归/模拟上限 5 = RUN_TTL_BATCH，超 3 路由 grid 换行）
//   · 每栏只渲染最近 LANE_TAIL 轮，之前折叠成「前 N 轮已折叠 / 展开本路」；
//     尾窗在 liveTurns.pushLiveTurn 里**真丢弃**老轮次（DOM 与内存都恒定）
//   · 角色靠 2px 左色条 + 单字标区分，不用左右气泡对齐
//     ——栏宽约 440px，气泡会把每条挤成两三字一行
//   · 每条最多 3 行截断，「展开本路」看更全
//   · 空响应单独成形（斜纹档条 + 虚线框），绝不按普通回复渲染
//     ——那会被读成「Agent 拒绝了」，语义正好反过来
//   · 「跟随最新」可关：关掉/手动滚动即冻结当前视窗
//
// ── 栏头文案：两类来源的 `case` 语义不同，**必须分开**（见 liveTurns.ts 差异 2）
//   · 红队：case 是 attack#N（构造顺序编号，不是用例名）→ 只显示「攻击 #N」，
//     并保留常驻说明条。绝不做「猜用例名」的映射。
//   · 回归/模拟：case 是**真用例名** → 直接显示用例名 + agent 名。
//
// ── UI-027 余地：后端 simulation 与 regression 都走 dataset runner，运行时无法
//   区分二者（planrun.py 只有 stage["type"] === "dataset"）。故本面板的分组标题
//   **不写死「回归测试」**，用「用例对话」这个对两类都真的说法；等 UI-027 把
//   环节类型分开后，只需给 KIND_LABEL 多一档即可，无需改结构。
//
// ── 性能：一次运行几百条事件（线上实测 216 条且在涨），每条都会 setState。
//   Lane / TurnRow 都套 memo，且**不接任何每次渲染都变的 prop**：
//     · pushLiveTurn 对未变动的 lane 保持引用不变 → 只有收到轮次的那一栏重渲
//     · TurnRow 只吃 turn（对象一旦入桶就不再变）+ 一个布尔 → 老行零重渲
//     · 相对时间只在栏头出现，且 now 量化到秒（每秒最多重渲一次，不是每条事件）
//     · 回调走 useCallback + ref，引用稳定，不破 memo
//
// 玻璃纪律：本面板在生产里位于**唯一玻璃层内部**（.plan-progress 是实心
// --bg2 卡），内部禁止再开 blur；所有新增元素实心 --bg2/--panel，
// 颜色一律按名引用 tokens.css。样式见 plan.css 的 .atk-* 段。
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  LANE_TAIL, laneCapOf,
  type LiveLane, type LiveTurn, type LiveTurnsState, type TurnKind,
} from "./liveTurns";

/** 分栏键含 `#` / `@` / `:`，都不适合进 CSS 选择器 → testid 用连字符形态 */
export function laneTestId(key: string): string {
  return `plan-live-lane-${key.replace(/[^\w-]+/g, "-")}`;
}

/** 每条轮次的角色单字标 + 读屏全称。
 *  单轮回归里 role="user" 其实是**用例输入**、多轮模拟里才是模拟用户所说
 *  （app/testrun.py:679 vs :284）—— 实时期分不出，故用对两者都真的「用户输入」。 */
const ROLE_LABEL = {
  attacker: { mark: "攻", full: "攻击方" },
  target: { mark: "靶", full: "被测方" },
  user: { mark: "用", full: "用户输入" },
  agent: { mark: "答", full: "被测 Agent 回复" },
} as const;

/** 秒级相对时间。运行中由 RunProgress 的 useLiveness 每秒 tick 带着重渲，
 *  本组件不自己起定时器（多一个 interval 只为刷「8s 前」不值得）。 */
function agoLabel(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m 前` : `${Math.floor(m / 60)}h 前`;
}

/** attack#7 → 「攻击 #7」；非该形态则原样显示（不猜、不编） */
function attackLabel(caseKey: string): string {
  const m = /^attack#(\d+)$/.exec(caseKey);
  return m ? `攻击 #${m[1]}` : caseKey;
}

/** 空响应/调用失败的短标签。marker 原文仍原样展示在后面（见 TurnRow）：
 *  让排查者知道 judge 读到的就是那段，不是我们编的解释。 */
const BLANK_LABEL = {
  silenced: "空响应 · 0 字节",
  errored: "调用失败 · 本轮未送达",
} as const;

/** 回归/模拟侧没有 marker（后端直接发真 output），0 字节就是空 message
 *  —— 此时没有「原文」可展示，占位说明这一轮是空输出。「既未回答也未拒绝，不得据此
 *  判断它拒绝了请求」那半句对任何空响应恒成立 ⇒ 删（prose-sweep 2026-09-03）。 */
const BLANK_HINT = "被测 Agent 未产生任何输出";

const TurnRow = memo(function TurnRow(
  { turn, latest }: { turn: LiveTurn; latest: boolean },
) {
  const label = turn.role === "other" ? null : ROLE_LABEL[turn.role];
  const subject = turn.role === "target" || turn.role === "agent";
  const cls = [
    "atk-turn",
    subject ? "target" : "attacker",
    turn.blank ? "blank" : "",
    latest ? "latest" : "",
  ].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      data-testid={`plan-live-turn-${turn.seq}`}
      data-role={turn.role}
      data-blank={turn.blank ?? undefined}
    >
      {/* turn_no 断流重连后会有空洞（后端 live_turns 每 2/4 轮才落盘）——
          只当标签显示，不参与任何索引；缺失显示「—」不伪造 */}
      <span className="atk-tno num">{turn.turnNo ?? "—"}</span>
      {label ? (
        <>
          <span className="atk-who" aria-hidden="true">{label.mark}</span>
          <span className="sr-only">{label.full}</span>
        </>
      ) : (
        // 未知 role（缓存回放的历史 conversation 可能带别的值）：原样显示原文，
        // 不空白、不崩、不归到任何一侧
        <span className="atk-who unknown" title={turn.roleRaw ?? undefined}>
          {(turn.roleRaw ?? "?").slice(0, 1)}
        </span>
      )}
      {turn.blank ? (
        <p className="atk-msg">
          <b>{BLANK_LABEL[turn.blank]}</b>
          <span className="atk-marker">{turn.message.trim() || BLANK_HINT}</span>
        </p>
      ) : (
        <p className="atk-msg">{turn.message}</p>
      )}
    </div>
  );
});

/** 栏头标识：红队只给攻击编号，回归/模拟给真用例名（+ agent 名） */
function LaneTitle({ lane }: { lane: LiveLane }) {
  if (lane.kind === "redteam") {
    return <span className="atk-lane-id num">{attackLabel(lane.caseKey)}</span>;
  }
  return (
    <>
      <span className="atk-lane-id" title={lane.caseKey}>{lane.caseKey}</span>
      {/* agent 名只有 turn 事件才有（attack_turn 没这个字段）→ 有才画 */}
      {lane.agentName && (
        <span className="atk-lane-agent num" title={lane.agentName}>{lane.agentName}</span>
      )}
    </>
  );
}

const Lane = memo(function Lane({ lane, expanded, follow, live, nowSec, onToggle, onUserScroll }: {
  lane: LiveLane;
  expanded: boolean;
  follow: boolean;
  live: boolean;
  /** 量化到秒的时间戳：每秒最多让本栏重渲一次，不随每条事件抖动 */
  nowSec: number;
  onToggle: (key: string) => void;
  onUserScroll: (el: HTMLDivElement) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const visible = expanded ? lane.turns : lane.turns.slice(-LANE_TAIL);
  // 折叠掉的 = 尾窗外还留在内存里的 + 已真丢弃的
  const folded = lane.total - visible.length;
  const latestSeq = lane.turns.length > 0 ? lane.turns[lane.turns.length - 1].seq : -1;
  const tid = laneTestId(lane.key);

  // 跟随最新：新轮次到达时把本栏滚到底；关掉即不再拽动用户视线
  useEffect(() => {
    if (!follow) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [follow, latestSeq, expanded]);

  return (
    <div className="atk-lane" data-testid={tid} data-kind={lane.kind}>
      <div className="atk-lane-head">
        <LaneTitle lane={lane} />
        {/* 实时期没有判定 —— 后端不给的不画。这里只说链路事实：
            被测侧空响应轮数，其余一律「进行中」。
            流结束后不许再说「进行中」（那时这路的结论要看报告）。 */}
        {lane.blank > 0 ? (
          <span className="badge warn atk-lane-badge">被测侧 {lane.blank} 条空响应</span>
        ) : live ? (
          <span className="badge run atk-lane-badge"><span className="dot" />进行中</span>
        ) : null}
        <span className="atk-lane-meta num">
          {/* 本路已收到的**条数**（不是「第几轮」：一轮 = 一问一答，两条消息） */}
          共 {lane.total} 条 · {agoLabel(lane.lastTs, nowSec)}
        </span>
      </div>
      <div
        className="atk-lane-body"
        ref={bodyRef}
        data-testid={`${tid}-body`}
        onScroll={(e) => onUserScroll(e.currentTarget)}
      >
        {/* 折叠条：三种可达状态一块出（对刑测试钉了三态 DOM，
            tests/r2-consolidation-live-turns.test.tsx）——
              folded > 0            → 计数（有真丢弃时加小句）+ 按钮
              folded <= 0 && 展开   → 只有按钮（展开后内存里就是全文）
              folded <= 0 && 收起   → 整块不画（没有可展开的东西） */}
        {(folded > 0 || expanded) && (
          <div className="atk-fold">
            {folded > 0 && (
              <>
                前 {folded} 条已折叠
                {lane.dropped > 0 && `（其中 ${lane.dropped} 条已释放，不再留存全文）`}
              </>
            )}
            <button
              type="button"
              className="btn-link atk-fold-btn"
              data-testid={`${tid}-expand`}
              onClick={() => onToggle(lane.key)}
            >
              {expanded ? `只看最近 ${LANE_TAIL} 条` : "展开本路"}
            </button>
          </div>
        )}
        {visible.map((t) => (
          <TurnRow key={t.seq} turn={t} latest={t.seq === latestSeq} />
        ))}
      </div>
    </div>
  );
});

/** 分组标题：**不写死「回归测试」** —— 后端 simulation / regression 同走 dataset
 *  runner，运行时分不开（UI-027）。「用例对话」对两类都真。 */
const KIND_LABEL: Record<TurnKind, string> = {
  redteam: "攻击对话",
  dataset: "用例对话",
};

/** 手动滚动离底多少 px 判定为「用户在自己读」→ 自动冻结 */
const FOLLOW_SLACK = 24;

/** 同屏最多列数：超出由 grid 换行（5 路 → 3+2），不把栏挤到读不了 */
const LANE_COLS = 3;

export default function LiveTurnsPanel(
  { turns, live = false }: { turns?: LiveTurnsState; live?: boolean },
) {
  const [open, setOpen] = useState(true);
  const [follow, setFollow] = useState(true);
  const [expandedAll, setExpandedAll] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  /** 冻结快照：跟随关掉那一刻的 lanes。之后到达的轮次只进计数不进视窗 */
  const [frozen, setFrozen] = useState<LiveTurnsState | null>(null);

  // memo 不能被「每次渲染都新建的回调」破掉：闭包里要读的可变量走 ref
  const followRef = useRef(follow);
  followRef.current = follow;
  const allRef = useRef<LiveTurnsState | undefined>(turns);
  allRef.current = turns;

  const setFollowing = useCallback((next: boolean) => {
    setFollow(next);
    setFrozen(next ? null : (allRef.current ?? null));
  }, []);

  const onLaneScroll = useCallback((el: HTMLDivElement) => {
    if (!followRef.current) return;
    // 用户往上翻 = 在读某一路，别被下一轮拽走（原型：关掉即冻结）
    if (el.scrollHeight - el.scrollTop - el.clientHeight > FOLLOW_SLACK) setFollowing(false);
  }, [setFollowing]);

  const toggleLane = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 后端不发逐轮事件（如 observe 环节）就整格不存在——不画空壳
  if (!turns || turns.lanes.length === 0) return null;

  const all = turns;
  const view = frozen ?? all;
  const pending = all.total - view.total;
  // 当前视图里**真的**被折叠掉的条数（档 live-turns-counter-two-denominators）。
  // 用户原话：「显示累计 6 轮，为什么只看到 3 轮」—— 真相是一条都没被隐藏
  // （3 路 × 每路 2 条 = 6，尾窗 LANE_TAIL=3 根本没触发），而界面**无条件**印着
  // 「本页只留每路最近 3 轮」，把没发生的截断说成发生了。
  // 逐路按与 Lane 组件**同一条规则**算（展开的那路不算折叠），求和；0 就不印。
  const foldedTotal = view.lanes.reduce((sum, l) => {
    const shown = expandedAll || expanded.has(l.key)
      ? l.turns.length
      : Math.min(l.turns.length, LANE_TAIL);
    return sum + Math.max(0, l.total - shown);
  }, 0);
  // 量化到秒：相对时间每秒最多变一次，几百条事件不会因它逐条重渲每一栏
  const nowSec = Math.floor(Date.now() / 1000) * 1000;

  // 分组按**首次出现顺序**（红队与用例对话谁先来谁在上），组内沿用 lanes 原序
  const kinds = [...new Set(view.lanes.map((l) => l.kind))];
  const grouped = kinds.length > 1;

  return (
    // aria-live=off：祖先 .plan-progress 是 role=status 活区，逐轮对话灌进去
    // 会让读屏器把每一轮都念出来（进度卡的活区是给「运行中/完成」那一行的）
    <div
      className="atk"
      data-open={open}
      data-testid="plan-live-turns"
      aria-live="off"
    >
      <div className="atk-head">
        <button
          type="button"
          className="atk-toggle"
          data-testid="plan-live-turns-toggle"
          aria-expanded={open}
          aria-controls="plan-live-lanes"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="atk-tw" aria-hidden="true">▾</span>实时对话
        </button>
        {live ? (
          <span className="badge run atk-lane-badge">
            <span className="dot" />{all.lanes.length} 路并发
          </span>
        ) : (
          <span className="badge atk-lane-badge">{all.lanes.length} 路 · 已停止推送</span>
        )}
        <span className="atk-count num" data-testid="plan-live-turns-count">
          {/* 分母写进合计（档 live-turns-counter-two-denominators 第 1 条）：原文是
              「累计 N 轮」＋紧跟一句「本页只留每路最近 3 轮」—— 前者是**跨路合计**、
              后者是**每路上限**，两个不同分母裸着并排，用户只能读成「6 条里只给我
              看 3 条」。
              单位词同时改「条」（第 3 条）：这个数数的是**单条消息**（用户 1 +
              Agent 1 = 2），印成「2 轮」违反直觉 —— 人认为一轮 = 一问一答。 */}
          {all.lanes.length} 路合计 <b>{all.total}</b> 条
          {/* 计数按实际出现的角色列，不给没发生的类别留 0（混跑时两组都列） */}
          {all.attacker + all.target > 0 && ` · 攻 ${all.attacker} / 靶 ${all.target}`}
          {all.user + all.agent > 0 && ` · 用户 ${all.user} / Agent ${all.agent}`}
          {all.other > 0 && ` · 未知角色 ${all.other}`}
          {all.blank > 0 && ` · 被测侧空响应 ${all.blank}`}
          {/* 截断提示**条件化**（第 2 条）：只在真折叠了东西时才印，并且印**实际
              折叠掉的条数** —— 无条件印一句没发生的截断与本仓「无条件印出没发生的
              事」是同族缺陷。 */}
          {foldedTotal > 0
            && ` · 每路只显示最近 ${LANE_TAIL} 条（已折叠 ${foldedTotal} 条，展开可看）`}
          {all.retiredLanes > 0
            && `（已结束的 ${all.retiredLanes} 路共 ${all.retiredTurns} 条已释放）`}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        {pending > 0 && (
          <span className="badge atk-lane-badge" data-testid="plan-live-turns-frozen">
            已冻结 · 新增 {pending} 条未显示
          </span>
        )}
        <label className="atk-sw">
          <input
            type="checkbox"
            checked={follow}
            data-testid="plan-live-turns-follow"
            onChange={(e) => setFollowing(e.currentTarget.checked)}
          />
          跟随最新
        </label>
        <button
          type="button"
          className="chip atk-chip"
          aria-pressed={!expandedAll}
          data-testid="plan-live-turns-tail"
          onClick={() => setExpandedAll(false)}
        >
          最近 {LANE_TAIL} 条 <span className="n">×{view.lanes.length} 路</span>
        </button>
        <button
          type="button"
          className="chip atk-chip"
          aria-pressed={expandedAll}
          data-testid="plan-live-turns-all"
          onClick={() => setExpandedAll(true)}
        >
          全部 <span className="n">{view.total}</span>
        </button>
      </div>

      {/* 红队路的常驻说明条（「攻击对话在实时期只有攻击编号，没有用例名…判定要等
          报告」）对任何红队 run 恒成立 ⇒ 整块删（prose-sweep 2026-09-03） */}

      <div id="plan-live-lanes" data-testid="plan-live-lanes">
        {kinds.map((kind) => {
          const lanes = view.lanes.filter((l) => l.kind === kind);
          return (
            <div className="atk-group" key={kind} data-testid={`plan-live-group-${kind}`}>
              {/* 只有混跑（两类同时在场）才加组标题，单类时不多一层噪音 */}
              {grouped && (
                <p className="atk-group-head">
                  {KIND_LABEL[kind]}
                  <span className="atk-group-n num">
                    {lanes.length} 路（同屏上限 {laneCapOf(kind)}）
                  </span>
                </p>
              )}
              {/* 列数跟随实际路数：只有 1 路时不留空格子；超 3 路换行 */}
              <div
                className="atk-lanes"
                style={{ "--atk-cols": Math.min(lanes.length, LANE_COLS) } as React.CSSProperties}
              >
                {lanes.map((lane) => (
                  <Lane
                    key={lane.key}
                    lane={lane}
                    expanded={expandedAll || expanded.has(lane.key)}
                    follow={follow}
                    live={live}
                    nowSec={nowSec}
                    onToggle={toggleLane}
                    onUserScroll={onLaneScroll}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
