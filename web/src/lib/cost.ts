// 成本怎么印——全站唯一一份（报告页 hero / Agent 详情①现状 / 首页 Agent 卡 / 评估分析对比）。
//
// 口径（docs/payload-contract.md「成本字段」+ 现网 P1 2026-09-08 复查，
// .scratch/triage-r1/issues/cost-zero-instead-of-unpriced.md）：
//   · `actual_cost_usd` 恒等于「算得出的部分之和」= judge_usd + 已定价被测 Agent 的费用；
//     被测 Agent 无价 ⇒ `cost_breakdown.agent_usd = null`、`cost_is_partial = true`、
//     `cost_breakdown.unpriced` 点名。此时那个数**不是**全额 ⇒ 数字旁标「部分」，
//     未定价名单进 title；agent_usd 的 null 绝不并进总额当 0。
//   · 老 run 没有这两个键（不回填）⇒ 「不可拆分」：0 分不出「真 0」还是「算不出」，
//     所以 0 印「—」；非 0 照印、不标。**只有** `cost_is_partial === false`（或拆分里
//     agent_usd 是数且无未定价名）时 0 才印成 $0.00 —— 真 0 才印 0。
//   · 值为 null / 非数 ⇒ 「—」（后端 agent_status 就是这么表达「未定价模型」的：值 null、
//     原因在 unavailable_reason，那个原因由调用方自己塞 title）。
//
// 只作展示：排序 / 求和 / 阈值比较一律用原始数字。
import { EMPTY_MARK } from "./renderText";

/** 后端 `cost_breakdown`（testrun.py execute_test_run；旧 run 缺席） */
export interface CostBreakdown {
  judge_usd?: number | null;
  /** null = 被测 Agent 无价（不是 0） */
  agent_usd?: number | null;
  /** == unpriced_agents；缓存命中的用例不进 */
  unpriced?: string[] | null;
}

export interface CostText {
  /** "$0.21" / "$0.00"（真 0）/ "—" */
  text: string;
  /** 「部分」= 只含算得出的那半；null = 不标 */
  badge: "部分" | null;
  /** 「未定价：a、b」；没名单 ⇒ undefined（调用方可换成自己的原因文案） */
  title: string | undefined;
  /** 是否只含有价那半（badge 的布尔形态，给需要分支的调用方） */
  partial: boolean;
}

export const PARTIAL_BADGE = "部分" as const;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 未定价名单：只收字符串、去重、保序 */
export function unpricedNames(breakdown: CostBreakdown | null | undefined, extra?: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of [...(breakdown?.unpriced ?? []), ...(extra ?? [])]) {
    if (typeof n === "string" && n && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * 成本 → {text, badge, title}。
 *
 * @param actual     `actual_cost_usd` / `total_cost_usd` / `cost.usd` / `agent_cost_usd.value`
 * @param breakdown  `cost_breakdown`（缺 ⇒ null / undefined）
 * @param isPartial  `cost_is_partial`；**缺键传 undefined 而不是 false**（契约：别当 false）
 * @param opts.digits 小数位（默认 2；会话级成本用 4，那一档钱太小两位全是 0）
 * @param opts.unpriced 拆分之外的未定价名单（观测环节 metrics.cost.unpriced_models）
 */
export function fmtCost(
  actual: number | null | undefined,
  breakdown?: CostBreakdown | null,
  isPartial?: boolean | null,
  opts: { digits?: number; unpriced?: readonly string[] } = {},
): CostText {
  const digits = opts.digits ?? 2;
  const names = unpricedNames(breakdown, opts.unpriced);
  const agentNull = breakdown != null && "agent_usd" in breakdown && breakdown.agent_usd === null;
  const partial = isPartial === true || agentNull || names.length > 0;
  // 「可判」= 后端明说了 partial 与否，或拆分里 agent_usd 是个数（有价且算出）
  const known = typeof isPartial === "boolean" || partial || (breakdown != null && finite(breakdown.agent_usd));
  const title = names.length > 0 ? `未定价：${names.join("、")}` : undefined;
  const badge = partial ? PARTIAL_BADGE : null;

  // 金额：有 actual 用 actual（契约：≡ 有价部分之和）；没有就从拆分里把**是数的**项加起来
  // —— agent_usd 为 null 时它不参与，不是当 0。
  let amount: number | null = finite(actual) ? actual : null;
  if (amount == null && breakdown) {
    const parts = [breakdown.judge_usd, breakdown.agent_usd].filter(finite);
    amount = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null;
  }
  if (amount == null) return { text: EMPTY_MARK, badge, title, partial };
  // 0 只有在「可判且非部分」时才是真 0
  if (amount === 0 && (partial || !known)) return { text: EMPTY_MARK, badge, title, partial };
  return { text: `$${amount.toFixed(digits)}`, badge, title, partial };
}

// ---------- 跨环节合并（plan-run 级 / 预估级） ----------

/** 一条记录上能读到的成本拆分事实；三者都缺 ⇒ {breakdown:null, isPartial:undefined} */
export interface CostFacts {
  breakdown: CostBreakdown | null;
  /** undefined = 没有一条记录说过（旧 run） */
  isPartial: boolean | undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** 单条环节记录：键在环节顶层（planrun 将来上浮）或子 run 对象 `report` 上
 *  （今天的真形态：testrun 的 run 对象整个挂在 stage.report），预估侧是
 *  `stages[i].{cost_is_partial, unpriced_agents}`（testrun.estimate_test_run）。 */
function factsOfOne(rec: unknown): CostFacts {
  if (!isObj(rec)) return { breakdown: null, isPartial: undefined };
  const layers = [rec, rec.report].filter(isObj);
  let breakdown: CostBreakdown | null = null;
  let isPartial: boolean | undefined;
  const extra: string[] = [];
  for (const l of layers) {
    if (breakdown == null && isObj(l.cost_breakdown)) {
      const b = l.cost_breakdown;
      breakdown = {
        ...("judge_usd" in b ? { judge_usd: finite(b.judge_usd) ? b.judge_usd : null } : {}),
        ...("agent_usd" in b ? { agent_usd: finite(b.agent_usd) ? b.agent_usd : null } : {}),
        unpriced: strings(b.unpriced),
      };
    }
    if (isPartial === undefined && typeof l.cost_is_partial === "boolean") isPartial = l.cost_is_partial;
    extra.push(...strings(l.unpriced_agents));
  }
  if (extra.length > 0) breakdown = { ...(breakdown ?? {}), unpriced: unpricedNames(breakdown, extra) };
  return { breakdown, isPartial };
}

/**
 * 多条环节记录 → 一份事实：judge/agent 各自把**是数的**加起来，任一环节
 * agent_usd 为 null ⇒ 合并后也是 null（不是 0）；未定价名单取并集；
 * isPartial：有一条 true ⇒ true；每条都明说 false ⇒ false；谁都没说 ⇒ undefined。
 */
export function costFactsOf(records: unknown): CostFacts {
  const list = Array.isArray(records) ? records.map(factsOfOne) : [];
  const withB = list.map((f) => f.breakdown).filter((b): b is CostBreakdown => b != null);
  const said = list.map((f) => f.isPartial).filter((p): p is boolean => typeof p === "boolean");
  const isPartial = said.some(Boolean) ? true : said.length > 0 && said.length === list.length ? false : undefined;
  if (withB.length === 0) return { breakdown: null, isPartial };
  const sumOf = (pick: (b: CostBreakdown) => number | null | undefined): number | null | undefined => {
    const vals = withB.map(pick);
    if (vals.some((v) => v === null)) return null;
    const nums = vals.filter(finite);
    return nums.length > 0 ? Math.round(nums.reduce((a, b) => a + b, 0) * 1e6) / 1e6 : undefined;
  };
  const judge = sumOf((b) => b.judge_usd);
  const agent = sumOf((b) => b.agent_usd);
  return {
    breakdown: {
      ...(judge !== undefined ? { judge_usd: judge } : {}),
      ...(agent !== undefined ? { agent_usd: agent } : {}),
      unpriced: withB.reduce<string[]>((acc, b) => unpricedNames({ unpriced: acc }, b.unpriced ?? []), []),
    },
    isPartial,
  };
}
