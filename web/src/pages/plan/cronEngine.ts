// cron 引擎：从 ui-prototypes/schedule-picker/index.html 移植（解析/人话/下次运行/回填判定）。
// 原型按标准五段 cron（dow 0=周日）实现；后端 app/plansched.py:98 把 plan.schedule
// 原样传给 EventBridge Scheduler 的 ScheduleExpression（无任何包裹/转换逻辑），
// 而 EventBridge 只接受 cron(分 时 日 月 周 年) 六段包裹语法、dow 数字 1=周日。
// 因此本模块内部统一用标准语义（dow 0=周日）做解析/推算，保存输出一律归一为
// EventBridge cron(...) 形态（dow 用 SUN–SAT 英文名回避两方言数字基准差异）。
//
// 解析双方言：
//   - "cron(0 3 ? * MON *)"  → EventBridge 六段（? 视作 *，数字 dow 1=周日平移 -1）
//   - "0 3 * * 1"            → 标准五段（7 归一为 0）
// 生成单方言：EventBridge cron(...)（cron(分 时 日 月 周 年)，dom/dow 恰一个为 ?）。

/* ---------- 常量 ---------- */
export const WD = ["日", "一", "二", "三", "四", "五", "六"]; // 内部 dow: 0=日
export const DOW_LABEL = ["一", "二", "三", "四", "五", "六", "日"]; // UI 顺序：周一起
export const DOW_CRON = [1, 2, 3, 4, 5, 6, 0]; // UI 顺序对应内部 dow 值
const EB_DOW_NAME = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]; // 内部 dow → EB 名

const MON_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
// 标准方言：0=周日；EventBridge 数字方言：1=周日（名字两边一致）
const DAY_NAMES_STD: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const DAY_NAMES_EB: Record<string, number> = {
  sun: 1, mon: 2, tue: 3, wed: 4, thu: 5, fri: 6, sat: 7,
};

export interface FieldMeta {
  name: string;
  min: number;
  max: number;
  names: Record<string, number> | null;
}

/** 五段图例元数据（高级档 segmap 用） */
export const FIELDS: FieldMeta[] = [
  { name: "分", min: 0, max: 59, names: null },
  { name: "时", min: 0, max: 23, names: null },
  { name: "日", min: 1, max: 31, names: null },
  { name: "月", min: 1, max: 12, names: MON_NAMES },
  { name: "周", min: 0, max: 7, names: DAY_NAMES_STD },
];
/** EventBridge 第六段（年）的图例元数据 */
export const YEAR_FIELD: FieldMeta = { name: "年", min: 1970, max: 2199, names: null };

/* ---------- 类型 ---------- */
export interface CronField {
  set: Set<number>;
  star: boolean;
  raw: string;
}

export type CronDialect = "standard" | "eventbridge";

export interface CronParseOk {
  ok: true;
  dialect: CronDialect;
  /** 展示用分段（EB 含第 6 段年） */
  parts: string[];
  /** 内部标准语义五段：分 时 日 月 周（dow 0=周日） */
  f: [CronField, CronField, CronField, CronField, CronField];
  /** EB 年字段（* / 标准方言 → null） */
  year: CronField | null;
}

export interface CronParseErr {
  ok: false;
  err: string;
  /** 出错段下标：0–4 核心段，5=年；缺省 = 整体结构错误 */
  errSeg?: number;
  parts: string[];
  dialect: CronDialect | "unknown";
}

export type CronParse = CronParseOk | CronParseErr;

export type Freq = "daily" | "weekly" | "monthly";

export interface SimpleSchedule {
  freq: Freq;
  /** UTC 时 */
  hour: number;
  /** UTC 分 */
  min: number;
  /** 每周勾选的天（内部 dow 0=周日） */
  days: number[];
  /** 每月日期 1–28 */
  dom: number;
}

export type SimpleBackfill =
  | ({ ok: true } & SimpleSchedule)
  | { ok: false; reason: string };

/* ---------- 字段解析 ----------
   支持：星号 / 单值 a / 区间 a-b / 步长（星号斜杠 n、a 斜杠 n、a-b 斜杠 n）/ 逗号列表 / 英文月与星期名
   步长语义（三种起点写法统一为「起点 → 上界，每 step 步」）：
     "*"/n → min-max/n     "a-b"/n → a-b/n     "a"/n → a-<该字段上界>/n
   最后一种（起点 + 步长，无区间）的上界是**该字段的 max**，随字段/方言不同：
   分 59、时 23、日 31、月 12、年 2199、周（标准 7 / EventBridge 7 但基准 1=周日）。
   曾把 "a"/n 当单值 a 处理（hi=lo）导致步长被整段丢弃 → 频率被静默低估数倍
   （cron(0/15 …) 每小时 4 次却按 1 次预览），tests/cronStep.test.ts 钉死语义。 */
interface FieldError { seg: string; msg: string }

function isFieldError(e: unknown): e is FieldError {
  return typeof e === "object" && e !== null && "msg" in e;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  names: Record<string, number> | null,
  fieldName: string,
): CronField {
  const f = String(raw).trim();
  if (!f) throw { seg: fieldName, msg: "为空" } as FieldError;
  const set = new Set<number>();
  let star = false;
  f.split(",").forEach((partRaw) => {
    const part = partRaw.trim();
    if (!part) throw { seg: fieldName, msg: "列表中有空项" } as FieldError;
    let step = 1;
    let hasStep = false;
    let body = part;
    const slash = part.split("/");
    if (slash.length === 2) {
      hasStep = true;
      body = slash[0];
      step = parseInt(slash[1], 10);
      if (!(step >= 1)) throw { seg: fieldName, msg: `步长 "${slash[1]}" 非法` } as FieldError;
    } else if (slash.length > 2) {
      throw { seg: fieldName, msg: `"${part}" 有多个 /` } as FieldError;
    }
    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = min; hi = max;
      if (step === 1) star = true;
    } else {
      const dash = body.split("-");
      const num = (t: string): number => {
        const s = t.trim().toLowerCase();
        if (names && names[s] !== undefined) return names[s];
        if (!/^\d+$/.test(s)) throw { seg: fieldName, msg: `"${s}" 不是数字` } as FieldError;
        return parseInt(s, 10);
      };
      // 有步长时单值是「起点」而非「唯一值」：a/n ≡ a-max/n（无步长才是单值 a）
      if (dash.length === 1) { lo = num(body); hi = hasStep ? max : lo; }
      else if (dash.length === 2) { lo = num(dash[0]); hi = num(dash[1]); }
      else throw { seg: fieldName, msg: `"${body}" 区间格式错误` } as FieldError;
    }
    [lo, hi].forEach((v) => {
      if (v < min || v > max) throw { seg: fieldName, msg: `${v} 超出范围 ${min}–${max}` } as FieldError;
    });
    if (lo > hi) throw { seg: fieldName, msg: `区间 ${lo}-${hi} 起点大于终点` } as FieldError;
    for (let v = lo; v <= hi; v += step) set.add(v);
  });
  return { set, star, raw: f };
}

/* ---------- 表达式解析（双方言） ---------- */
const EB_WRAP = /^cron\(([^)]*)\)$/i;

export function parseCron(expr: string): CronParse {
  const trimmed = String(expr).trim();
  const ebMatch = EB_WRAP.exec(trimmed);
  if (ebMatch) return parseEventBridge(ebMatch[1]);
  if (/^cron\(/i.test(trimmed)) {
    return { ok: false, err: "cron(...) 缺少右括号", parts: [trimmed], dialect: "eventbridge" };
  }
  return parseStandard(trimmed);
}

function parseStandard(expr: string): CronParse {
  const parts = expr.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 6) {
    return {
      ok: false,
      err: "6 段疑似 EventBridge 语法，需用 cron(…) 包裹（分 时 日 月 周 年）",
      parts, dialect: "unknown",
    };
  }
  if (parts.length !== 5) {
    return {
      ok: false,
      err: `需要 5 段（分 时 日 月 周），当前 ${expr.trim() === "" ? 0 : parts.length} 段`,
      parts, dialect: "standard",
    };
  }
  const out: (CronField | null)[] = [];
  let errSeg = -1;
  let errMsg = "";
  for (let i = 0; i < 5; i++) {
    try {
      out.push(parseField(parts[i], FIELDS[i].min, FIELDS[i].max, FIELDS[i].names, FIELDS[i].name));
    } catch (e) {
      errSeg = i;
      errMsg = `第 ${i + 1} 段（${FIELDS[i].name}）${isFieldError(e) ? e.msg : "格式错误"}`;
      out.push(null);
    }
  }
  if (errSeg >= 0) return { ok: false, err: errMsg, errSeg, parts, dialect: "standard" };
  // 周 7 归一为 0（周日）
  const dow = out[4] as CronField;
  if (dow.set.has(7)) { dow.set.delete(7); dow.set.add(0); }
  return {
    ok: true, dialect: "standard", parts,
    f: out as CronParseOk["f"], year: null,
  };
}

function parseEventBridge(inner: string): CronParse {
  const parts = inner.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 6) {
    return {
      ok: false,
      err: `cron(…) 内需要 6 段（分 时 日 月 周 年），当前 ${parts.length} 段`,
      parts, dialect: "eventbridge",
    };
  }
  // 不支持的 EventBridge 扩展语法：L / W / #（引擎无法推算下次运行）。
  // 先剥掉三字母英文名（WED 含 W、JUL 含 L，避免误报）再检。
  for (let i = 0; i < 6; i++) {
    if (/[LW#]/i.test(parts[i].replace(/[a-z]{3}/gi, ""))) {
      return {
        ok: false,
        err: `第 ${i + 1} 段含 L/W/# 扩展语法，暂不支持（无法推算下次运行）`,
        errSeg: i, parts, dialect: "eventbridge",
      };
    }
  }
  const core: (CronField | null)[] = [];
  let errSeg = -1;
  let errMsg = "";
  const specs: { raw: string; meta: FieldMeta; names: Record<string, number> | null }[] = [
    { raw: parts[0], meta: FIELDS[0], names: null },
    { raw: parts[1], meta: FIELDS[1], names: null },
    { raw: parts[2] === "?" ? "*" : parts[2], meta: FIELDS[2], names: null },
    { raw: parts[3], meta: FIELDS[3], names: MON_NAMES },
    // EB dow：数字 1–7（1=周日），名字与标准一致
    { raw: parts[4] === "?" ? "*" : parts[4], meta: { ...FIELDS[4], min: 1, max: 7 }, names: DAY_NAMES_EB },
  ];
  for (let i = 0; i < 5; i++) {
    try {
      const s = specs[i];
      core.push(parseField(s.raw, s.meta.min, s.meta.max, s.names, s.meta.name));
    } catch (e) {
      errSeg = i;
      errMsg = `第 ${i + 1} 段（${FIELDS[i].name}）${isFieldError(e) ? e.msg : "格式错误"}`;
      core.push(null);
    }
  }
  let year: CronField | null = null;
  if (errSeg < 0) {
    try {
      const y = parseField(parts[5], YEAR_FIELD.min, YEAR_FIELD.max, null, YEAR_FIELD.name);
      year = y.star ? null : y;
    } catch (e) {
      errSeg = 5;
      errMsg = `第 6 段（年）${isFieldError(e) ? e.msg : "格式错误"}`;
    }
  }
  if (errSeg >= 0) return { ok: false, err: errMsg, errSeg, parts, dialect: "eventbridge" };
  // dow：EB 数字空间（1=周日）平移到内部标准空间（0=周日）
  const dowEb = core[4] as CronField;
  const dow: CronField = {
    set: new Set(Array.from(dowEb.set).map((v) => v - 1)),
    star: dowEb.star,
    raw: dowEb.raw === "*" && parts[4] === "?" ? "*" : dowEb.raw,
  };
  return {
    ok: true, dialect: "eventbridge", parts,
    f: [core[0], core[1], core[2], core[3], dow] as CronParseOk["f"],
    year,
  };
}

/* ---------- 下次运行（逐分钟推进，上限 366 天） ---------- */
export function nextRuns(p: CronParse, from: Date, count: number): Date[] {
  if (!p.ok) return [];
  const res: Date[] = [];
  let d = new Date(from.getTime());
  d.setUTCSeconds(0, 0);
  d = new Date(d.getTime() + 60e3);
  const domStar = p.f[2].star;
  const dowStar = p.f[4].star;
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit && res.length < count; i++, d = new Date(d.getTime() + 60e3)) {
    if (!p.f[0].set.has(d.getUTCMinutes())) continue;
    if (!p.f[1].set.has(d.getUTCHours())) continue;
    if (!p.f[3].set.has(d.getUTCMonth() + 1)) continue;
    if (p.year && !p.year.set.has(d.getUTCFullYear())) continue;
    const okDom = p.f[2].set.has(d.getUTCDate());
    const okDow = p.f[4].set.has(d.getUTCDay());
    // cron 语义：日与周都非 * 时取「或」
    const dayOK = (domStar && dowStar) ? true
      : (!domStar && !dowStar) ? (okDom || okDow)
        : (domStar ? okDow : okDom);
    if (!dayOK) continue;
    res.push(new Date(d.getTime()));
  }
  return res;
}

/* ---------- 人话描述 ---------- */
function listFmt(set: Set<number>, map: (v: number) => string): string {
  return Array.from(set).sort((a, b) => a - b).map(map).join("、");
}

function describeSet(fld: CronField, unit: string): string | null {
  if (fld.star) return null;
  const arr = Array.from(fld.set).sort((a, b) => a - b);
  if (/^\*\/\d+$/.test(fld.raw)) return `每 ${fld.raw.split("/")[1]} ${unit}`;
  if (arr.length === 1) return `${arr[0]} ${unit}`;
  return `${arr.join("、")} ${unit}`;
}

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/* 字段集合若是「从下界起、等步长、一直铺到上界」的全覆盖周期序列 → 返回步长，否则 null。
   判据取解析后的集合而非 raw，所以语义等价的「星号斜杠 6」、`0/6`、`0,6,12,18` 同结论
   （缺陷 2：小时全集曾走「逐个列小时」分支，把 24 个小时全枚举撑爆预览区）。
   三个条件各自都不能松（每条都有专属用例，见 tests/cronHumanizeHours.test.ts）：
     1) 末项 + step 越过上界，即铺满全域（`0-12/6` 得 0、6、12，18 点根本不跑）；
     2) (max-min+1) 能被 step 整除（`0/5` 得 0、5、…、20，20 点到次日 0 点只隔
        4 小时，「每 5 小时」是假话）；
     3) 每一项都落在「下界 + i × step」上，一并管住「起点必须是下界」（`2/6` 得
        2、8、14、20，说「每 6 小时」会丢掉「从 2 点起」）与「步长处处相等」
        （`0,6,18` 不是等步长）。
   不满足就返回 null，让调用方落回逐项列举——那种情况项数天然很少，不会撑爆。 */
function periodStep(fld: CronField, min: number, max: number): number | null {
  const arr = Array.from(fld.set).sort((a, b) => a - b);
  if (arr.length < 2) return null; // 单值不谈周期（留给「HH:MM」那支）
  const step = arr[1] - arr[0];
  if (arr[arr.length - 1] + step <= max) return null;
  if ((max - min + 1) % step !== 0) return null;
  if (!arr.every((v, i) => v === min + i * step)) return null;
  return step;
}

export function humanize(p: CronParse): string | null {
  if (!p.ok) return null;
  const [mm, hh, dom, mon, dow] = p.f;
  const seg: string[] = [];
  // 频率范围（月/日/周）
  if (!mon.star) seg.push(`每年 ${listFmt(mon.set, (v) => `${v} 月`)}`);
  if (!dom.star && !dow.star) {
    seg.push(`每月 ${listFmt(dom.set, (v) => `${v} 日`)}、以及每周${listFmt(dow.set, (v) => WD[v])}`);
  } else if (!dom.star) {
    seg.push(`${mon.star ? "每月 " : ""}${listFmt(dom.set, (v) => `${v} 日`)}`);
  } else if (!dow.star) {
    const ds = Array.from(dow.set).sort((a, b) => a - b);
    const isWorkday = ds.length === 5 && [1, 2, 3, 4, 5].every((v) => dow.set.has(v));
    const isWeekend = ds.length === 2 && dow.set.has(0) && dow.set.has(6);
    seg.push(isWorkday ? "每周一至周五" : isWeekend ? "每周六、周日" : `每周${listFmt(dow.set, (v) => WD[v])}`);
  } else if (mon.star) {
    seg.push("每天");
  }
  const dateTxt = seg.filter(Boolean).join(" ");
  // 时刻
  let timeTxt: string;
  // 分钟铺满 0–59 全域 = 「每分钟」。判解析后的**集合**而非 raw（与小时侧
  // periodStep 同一原则）：`*`、`0-59`、`0/1`、`*/1` 是同义写法，读出来必须
  // 一致。曾只认 `mm.star`：`* 9-17 * * *` 落到兜底分支把 60 个分钟逐项枚举
  // （issue cron-humanize-enumerates-all-minutes——描述是保存前唯一的
  // 频率-成本护栏，枚举 60 项等于没有描述）。
  const mFull = mm.set.size === FIELDS[0].max - FIELDS[0].min + 1;
  const mStep = /^\*\/(\d+)$/.exec(mm.raw);
  const hStep = periodStep(hh, FIELDS[1].min, FIELDS[1].max);
  const hRange = /^(\d+)-(\d+)$/.exec(hh.raw);
  if (mFull && hh.star) timeTxt = "每分钟";
  else if (mFull && hRange) timeTxt = `${pad(+hRange[1])}:00–${pad(+hRange[2])}:59 之间每分钟`;
  else if (mFull) timeTxt = `${describeSet(hh, "时")} 内每分钟`;
  else if (mStep && hh.star) timeTxt = `每 ${mStep[1]} 分钟`;
  else if (mStep && hRange) timeTxt = `${pad(+hRange[1])}:00–${pad(+hRange[2])}:59 之间每 ${mStep[1]} 分钟`;
  else if (mStep && !hh.star) timeTxt = `${describeSet(hh, "时")} 内每 ${mStep[1]} 分钟`;
  else if (hStep && mm.set.size === 1) {
    const m0 = Array.from(mm.set)[0];
    // 步长 1 = 每个小时都跑（`*` / `0-23` / `0/1` 同义）：说「每小时」，不枚举 24 个小时
    timeTxt = hStep === 1
      ? `每小时的第 ${m0} 分`
      : `每 ${hStep} 小时${m0 === 0 ? "（整点）" : `的第 ${m0} 分`}`;
  } else if (mm.set.size === 1 && hh.set.size === 1) {
    timeTxt = `${pad(Array.from(hh.set)[0])}:${pad(Array.from(mm.set)[0])}`;
  } else if (mm.set.size === 1 && hRange) {
    timeTxt = `${pad(+hRange[1])}–${pad(+hRange[2])} 点的第 ${Array.from(mm.set)[0]} 分`;
  } else if (mm.set.size === 1) {
    timeTxt = `${listFmt(hh.set, (v) => pad(v))} 点的第 ${Array.from(mm.set)[0]} 分`;
  } else {
    // 周期词「每小时」直接接「的第」（与上面单分钟分支「每小时的第 N 分」同排版，
    // issue cron-humanize-hourly-extra-space）；小时枚举列表与「的第」之间保留空格。
    const minTxt = `的第 ${listFmt(mm.set, (v) => String(v))} 分`;
    timeTxt = hh.star
      ? `每小时${minTxt}`
      : `${listFmt(hh.set, (v) => `${pad(v)} 点`)} ${minTxt}`;
  }
  // 时刻已自带周期语义（每分钟 / 每 n 分钟 / 每 n 小时）时，不再叠加「每天」
  const selfPeriodic = /^每/.test(timeTxt);
  const prefix = (dateTxt === "每天" && selfPeriodic) ? "" : dateTxt;
  return `${prefix ? prefix + " " : ""}${timeTxt} UTC 运行`;
}

/* ---------- 简单模式 → cron（EventBridge 形态） ---------- */
export function buildCron(s: SimpleSchedule): string {
  if (s.freq === "daily") return `cron(${s.min} ${s.hour} * * ? *)`;
  if (s.freq === "weekly") {
    const days = s.days.slice().sort((a, b) => a - b).map((v) => EB_DOW_NAME[v]).join(",");
    return `cron(${s.min} ${s.hour} ? * ${days} *)`;
  }
  if (s.freq === "monthly") return `cron(${s.min} ${s.hour} ${s.dom} * ? *)`;
  return "";
}

/* ---------- 任意合法表达式 → EventBridge 归一（保存前调用） ----------
   标准五段（含裸方言历史数据）与 EB 形态都归一成 cron(分 时 日 月 周 年)：
   dom/dow 恰一个为 ?；dow 一律用 SUN–SAT 名字（回避 1=周日 的数字基准差异）。 */
export function toEventBridge(expr: string): { ok: true; expr: string } | { ok: false; err: string } {
  const p = parseCron(expr);
  if (!p.ok) return { ok: false, err: p.err };
  const [mm, hh, dom, mon, dow] = p.f;
  if (!dom.star && !dow.star) {
    return { ok: false, err: "EventBridge 不支持同时限定「日」和「星期」（标准 cron 的「或」语义无法表达）" };
  }
  const domPart = dom.star ? (dow.star ? "*" : "?") : dom.raw;
  const dowPart = dow.star
    ? "?"
    : Array.from(dow.set).sort((a, b) => a - b).map((v) => EB_DOW_NAME[v]).join(",");
  const yearPart = p.year ? p.year.raw : "*";
  return { ok: true, expr: `cron(${mm.raw} ${hh.raw} ${domPart} ${mon.raw.toUpperCase()} ${dowPart} ${yearPart})` };
}

/* ---------- cron → 简单模式（回填解析） ----------
   支持回填的形态（其余一律进高级档）：
     每天  m H * * *          m,H 均为单个字面整数
     每周  m H * * <dow列表>   dow 为单值/列表/连续区间，可含英文名
     每月  m H D * *          D 为单个 1–28 的整数
   （两方言等价形态均可，EB 的 ? 视作 *，年字段必须为 *。）
   明确不回填：任何步长语法、分或时为列表或区间、月份被限定、日与周同时限定、
              日 >28、限定了年份、L/W/# 等扩展语法、段数不合法 */
export function cronToSimple(expr: string): SimpleBackfill {
  const p = parseCron(expr);
  if (!p.ok) return { ok: false, reason: "表达式非法" };
  const [mm, hh, dom, mon, dow] = p.f;
  if (p.year) return { ok: false, reason: "限定了年份" };
  const single = (f: CronField): boolean => !f.star && f.set.size === 1 && /^\d+$/.test(f.raw);
  if (!single(mm)) return { ok: false, reason: "分钟不是单一固定值" };
  if (!single(hh)) return { ok: false, reason: "小时不是单一固定值" };
  if (!mon.star) return { ok: false, reason: "限定了月份" };
  const min = Array.from(mm.set)[0];
  const hour = Array.from(hh.set)[0];
  if (dom.star && dow.star) return { ok: true, freq: "daily", min, hour, days: [1], dom: 1 };
  if (dom.star && !dow.star) {
    if (/\//.test(dow.raw)) return { ok: false, reason: "星期使用了步长" };
    return { ok: true, freq: "weekly", min, hour, days: Array.from(dow.set), dom: 1 };
  }
  if (!dom.star && dow.star) {
    if (dom.set.size !== 1 || !/^\d+$/.test(dom.raw)) return { ok: false, reason: "日期不是单一固定值" };
    const d = Array.from(dom.set)[0];
    if (d > 28) return { ok: false, reason: `日期 ${d} 号超出 1–28（短月会跳过）` };
    return { ok: true, freq: "monthly", min, hour, days: [1], dom: d };
  }
  return { ok: false, reason: "同时限定了「日」和「星期」" };
}

/** 编辑回填分档判定：能无损进简单档吗 */
export function canBackfill(expr: string): boolean {
  return cronToSimple(expr).ok;
}

/* ---------- rate(...) 直通 ----------
   现有方案数据里有 "rate(1 day)"（EventBridge 另一种合法语法）。引擎不解析
   rate（无 cron 语义可推算），但识别它以便高级档原样保留、保存放行。 */
const RATE_RE = /^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/i;

export function isRate(expr: string): boolean {
  return RATE_RE.test(String(expr).trim());
}

/** rate(n unit) 的人话「每 n 单位」（humanize 只吃 CronParse，rate 没有 cron 语义）；
 *  不是 rate ⇒ null。判定与取数同一条 RATE_RE：单位白名单只此一份。 */
export function rateHuman(expr: string): string | null {
  const m = RATE_RE.exec(String(expr).trim());
  if (!m) return null;
  const u = m[2].toLowerCase();
  const unit = u.startsWith("minute") ? "分钟" : u.startsWith("hour") ? "小时" : "天";
  return `每 ${m[1]} ${unit}`;
}

/** 保存前归一：空串/rate 直通；合法 cron 归一为 EventBridge 形态；其余拒绝 */
export function normalizeSchedule(expr: string):
  | { ok: true; value: string }
  | { ok: false; err: string } {
  const v = String(expr).trim();
  if (!v) return { ok: true, value: "" };
  if (isRate(v)) return { ok: true, value: v };
  const eb = toEventBridge(v);
  if (eb.ok) return { ok: true, value: eb.expr };
  return { ok: false, err: eb.err };
}

/* ---------- 时间格式化（预览用，全 UTC 计算） ---------- */
export function toBJ(d: Date): Date {
  return new Date(d.getTime() + 8 * 3600e3);
}

export function fmtUTC(d: Date): string {
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} 周${WD[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 简单档时间回显：北京时间 + 是否跨日 */
export function bjEcho(hour: number, min: number): { text: string; cross: boolean } {
  const h = (hour + 8) % 24;
  const cross = hour + 8 >= 24;
  return { text: `${pad(h)}:${pad(min)}${cross ? " （次日）" : ""}`, cross };
}
