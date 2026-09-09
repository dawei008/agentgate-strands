// 时间戳格式化（全站共用）。
//
// run 时间戳的解析口径在 lib/scoring.toMillis（ADR-0003 把「时间解析」判给它）；
// 本模块只管**排版**，故 fmtRunTime 从那里取 ms。scoring 零 import，无环。
import { toMillis } from "./scoring";
//
// 后端同一字段会给**四种**形态，逐一都得认（H-3）：
//   1. epoch 秒（数字）—— discover 的 refreshed_at
//   2. 裸 epoch **字符串** —— Langfuse 注册源的 last_updated 是
//      `str(int(...))`（catalog.py:65），如 "1755500000"
//   3. Python `str(datetime)` —— AgentCore 源的 last_updated 是
//      `str(rt["lastUpdatedAt"])`（discovery.py），如 "2026-08-10 08:00:00+00:00"
//   4. 已排版好的字符串（旧 mock / 部分接口）—— 原样透出
//
// 「字符串一律原样透出」曾让 Langfuse 注册的 Agent 在列表里显示裸 epoch
// "1755500000"。那是与「缓存于 1787030227」同族的 bug——上次只修了
// refreshed_at（数字分支），last_updated 这条（字符串分支）漏了，
// 因为 mock 给的是 ISO 串，永远触发不到。

/** 纯数字串（裸 epoch 秒）→ 数字；否则 null。
 *  10 位是秒、13 位是毫秒；后端只产秒，但两者都兜住不至于错 1000 倍。 */
function epochFromString(s: string): number | null {
  if (!/^\d{9,13}$/.test(s)) return null;
  const n = Number(s);
  return s.length >= 12 ? n / 1000 : n;
}

/** 可解析为具体时刻的字符串（Python str(datetime) / ISO / 带 " UTC" 后缀的
 *  run 时间戳）→ epoch 秒；否则 null。 */
function epochFromDateString(raw: string): number | null {
  // run 时间戳带 " UTC" 后缀（strftime("%Y-%m-%d %H:%M UTC")）——先剥掉，
  // 否则拼出 "…T09:00 UTCZ" → NaN（与 scoring.toMillis 同一处理）
  const s = raw.replace(/\s*UTC$/i, "").trim();
  // 只接受以 4 位年份开头的形态，避免把普通中文文案喂给 Date.parse
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return null;
  // "2026-08-10 08:00:00+00:00" → V8 需要 T 分隔才稳；无时区则按 UTC
  const hasTz = /[+-]\d{2}:?\d{2}$|Z$/.test(s);
  const iso = s.replace(" ", "T") + (hasTz ? "" : "Z");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/** 字符串 → epoch 秒（裸 epoch 串或可解析时刻串）；都不是则 null。 */
function secondsOf(v: string): number | null {
  const s = v.trim();
  return epochFromString(s) ?? epochFromDateString(s);
}

/**
 * 截断粒度。三档都是**同一个 ISO 串上切出来的**，别再各写一份 Date.parse ——
 * 那样写出来的副本必然缺掉本模块攒的三道处理（剥 " UTC" 后缀、认裸 epoch 串、
 * 把数字 0 当缺失），而这三道都是踩过的实拍坑。
 *   ymd-hm  "2026-08-11 09:00"  默认；带日期的完整时刻
 *   md-hm   "08-11 09:00"       同年内的近期时刻（首页「下次 …」、舰队窗口）
 *   hm      "09:00"             24 桶小时轴（同一天内，日期是噪声）
 */
export type TimeGrain = "ymd-hm" | "md-hm" | "hm";

const GRAIN_SLICE: Record<TimeGrain, [number, number]> = {
  "ymd-hm": [0, 16],
  "md-hm": [5, 16],
  hm: [11, 16],
};

function fmtSeconds(sec: number, grain: TimeGrain = "ymd-hm"): string | null {
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const [from, to] = GRAIN_SLICE[grain];
  return d.toISOString().slice(from, to).replace("T", " ");
}

/** epoch 秒 / 裸 epoch 串 / Python str(datetime) / ISO → "YYYY-MM-DD HH:mm"
 *  （无时区后缀）；认不出的字符串原样透出。
 *
 *  数字 `0`（及任何非正 epoch 秒）当**缺失**处理，与 null 同样给占位符：后端对
 *  「没有这个时间戳」的统一回退就是 0（catalog.py / pricing.py 的 `.get(…, 0)`），
 *  照 1970-01-01 渲染等于把「不知道什么时候」说成一个具体历史日期
 *  （issue `settings-fmttime-epoch-zero`，P3）。
 *  只拦**数字**：字符串 "1970-01-01T00:00:00Z" 是调用方真的指那一刻，照原样排版。
 *  fmtTimeUtc 不带这道闸——它的消费点（Agent 目录页「缓存于」等）另一套占位文案，
 *  行为变化范围另议，别顺手抄过去。 */
export function fmtTime(v?: number | string | null, grain: TimeGrain = "ymd-hm"): string {
  if (v == null || v === "") return "—";
  if (typeof v === "number" && v <= 0) return "—";
  if (typeof v === "string") {
    const sec = secondsOf(v);
    return sec != null ? fmtSeconds(sec, grain) ?? v : v;
  }
  return fmtSeconds(v, grain) ?? String(v);
}

/**
 * 同 fmtTime，但输出带 " UTC" 显式标时区。
 * 用于要显式标时区的位置（Agent 目录页「缓存于」、最近评估时间等）。
 * 裸 epoch 直接显示（"缓存于 1787030227"）是用户实拍截图里抓到的 bug；
 * Langfuse 注册源的 last_updated 就是裸 epoch **字符串**，同族第二例。
 */
export function fmtTimeUtc(v?: number | string | null): string {
  if (v == null || v === "") return "未知时间";
  if (typeof v === "string") {
    const sec = secondsOf(v);
    if (sec == null) return v;                      // 认不出 → 原样（可能已排版好）
    const out = fmtSeconds(sec);
    return out ? `${out} UTC` : v;
  }
  const out = fmtSeconds(v);
  return out ? `${out} UTC` : String(v);
}

/**
 * run 时间戳 → "YYYY-MM-DD HH:mm"（**剥掉 " UTC" 后缀**）。
 *
 * 后端所有 run 时间戳的真形态是 `strftime("%Y-%m-%d %H:%M UTC")`；表格/列表逐行
 * 重复标 UTC 是噪声（时区在表头/页头说一次就够），所以展示层剥后缀 —— 解析口径
 * 仍走 lib/scoring.toMillis（那里记着「后缀必须显式剥离」的实拍坑）。
 * 认不出的非空字符串原样透出（可能已排版好），空/解析失败 → "—"。
 *
 * 原住 pages/plan/derive.ts —— 但消费方跨四个页面族（workbench / run /
 * agents 详情 / plan 自己），时间排版本来就是本模块的辖区（L6）。
 * 与 fmtTime 的分工：fmtTime 认「四形态后端时间戳」（epoch/裸串/ISO/已排版），
 * fmtRunTime 专收 run 时间戳那一种形态并剥后缀。
 */
export function fmtRunTime(v: string | number | null | undefined): string {
  const ms = toMillis(v); // 解析失败 = NaN，!ms 与旧 0-fallback 同样成立
  if (!ms) return typeof v === "string" && v ? v : "—";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * ARN → 短形式，保留最后一段资源标识。
 * arn:aws:bedrock-agentcore:us-west-2:1111:runtime/support-bot-abc123
 *   → runtime/support-bot-abc123
 * 表格副行只需要辨识度，账号 ID 和 region 是噪声（region 已在页标题）。
 */
export function shortArn(arn?: string | null): string {
  if (!arn) return "";
  const tail = arn.split(":").pop() ?? "";
  return tail || arn;
}

/**
 * description 是否只是「没写描述」的占位。
 * 真实后端对未填描述的 runtime 回 "AgentCore Runtime: {name}"，
 * 逐行重复 agent 名＝纯冗余，按空描述处理。
 */
export function isPlaceholderDescription(desc: string | undefined, agentName: string): boolean {
  if (!desc) return true;
  const d = desc.trim();
  if (d === "") return true;
  return d.toLowerCase() === `agentcore runtime: ${agentName}`.toLowerCase();
}
