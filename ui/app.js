// AgentGate · Agent 质量门禁（原 eval-anything；基础设施标识如 eval-anything/ Secret 前缀不变）
// 单文件无构建：Cognito(code flow) -> JWT -> /api/invoke (SSE)。
// 信息架构（方案中心）：评估台(方案总表+最近run) ⇄ 方案详情(唯一结果场所)
//                     Agent目录(评估对象+Langfuse源) ⇄ Agent详情(挂载方案+run聚合)
// 两个视角共享同一份数据：run 永远属于方案；Agent 视角只是过滤器 + 快捷入口。

const cfg = await (await fetch("./config.json")).json();
const $ = (id) => document.getElementById(id);

const state = {
  token: null,
  agents: [],           // discover 结果（含 langfuse 注册源）
  plans: [],            // 全部方案
  recentRuns: [],       // 跨方案 run 流（评估台 + 派生每方案「上次结果」）
  estimates: {},        // plan_id -> 预估（内置在表格/详情页里，运行前不弹窗）
  evaluators: [], custom: [], metricKeys: [], multimodal: [], defaults: [],
  scopes: {},           // 评估器名 → 适用环节数组（["observe","dataset"]|["dataset"]；缺失=不限）
  datasetOnly: [],      // 仅回归环节可用的内置评估器（如 correctness——不在 available 里）
  rtOptions: null,
  datasets: [],
  planFilter: "",       // 评估台 Agent 筛选
  currentPlanId: null,
  currentAgent: null,   // 当前报告所属 agent（改进稿/抽屉用）
  currentReport: null,
  currentRunKey: null,
  currentProposalCount: 0,
};

// 术语表（2026-08-20 用户拍板）：观测评估→线上评估、数据集回归→回归测试。
// 短名取「线上」：与「回归/红队」保持两字节奏（环节链/预估明细/结果行对齐），
// 歧义由悬停释义（STAGE_HELP）与分数口径 tooltip（SCORE_TIP）兜底。
// 底层 payload 值 observe/dataset/redteam 不变，只改显示文本。
const STAGE_LABELS = { observe: "线上", dataset: "回归", redteam: "红队" };
const STAGE_FULL = { observe: "线上评估", dataset: "回归测试", redteam: "红队测试" };

// 紧凑结果格的口径说明（信息类 tooltip：回答「这是什么」）
const SCORE_TIP = {
  observe: "线上评估均分：各评估器分数的平均（0–1，越高越好）。完整分解见运行报告",
  dataset: "回归通过率：通过用例数占总用例数的比例",
  redteam: "红队结果：被攻破次数 / 攻击总数（0 为最佳）",
};

// judge 分数波动大于 0.01，四位小数是假精度——显示层统一两位（数据与排序不动）
const fmtScore = (v) => (typeof v === "number" && isFinite(v) ? v.toFixed(2) : (v ?? "—"));

const escHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- 视觉基元：图标 / 徽章 / tooltip / 迷你图 ----------
// 图标走 SVG sprite：emoji 在不同系统里字重、基线、彩色化都不可控。
function icon(name, cls = "") {
  return `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

// 状态一律带底色+描边+文字：裸符号要求用户自己猜含义
function badge(kind, text, iconName) {
  const map = { ok: "badge-ok", warn: "badge-warn", bad: "badge-bad", neutral: "badge-neutral" };
  return `<span class="badge ${map[kind] ?? map.neutral}">`
    + (iconName ? icon(iconName, "ic-sm") : "") + escHtml(text) + `</span>`;
}

// tooltip：原生 title 有 ~1s 延迟、样式不可控、触屏不可用
function tip(text, inner, { alignRight = false, dotted = true } = {}) {
  return `<span class="tip${alignRight ? " tip-r" : ""}${dotted ? " tip-dot" : ""}"`
    + ` data-tip="${escHtml(text)}" tabindex="0">${inner}</span>`;
}
function tipIcon(text, { alignRight = false } = {}) {
  return `<span class="tip${alignRight ? " tip-r" : ""}" data-tip="${escHtml(text)}"`
    + ` tabindex="0"><span class="tip-i">?</span></span>`;
}

// ---------- tooltip 展示层：单例 fixed 气泡 ----------
// 此前气泡是触发元素上绝对定位的伪元素，会被 .tscroll 裁剪
// （overflow-x:auto 会把 overflow-y 也计算为 auto，容器边界直接截断气泡）。
// 改为 document 级委托 + position:fixed 单例：不受任何 overflow 容器影响，
// 触发端保留 .tip[data-tip] 结构，所有调用点零改动。
let tipBubbleEl = null;
let tipCurrentEl = null;

function ensureTipBubble() {
  if (tipBubbleEl) return tipBubbleEl;
  tipBubbleEl = document.createElement("div");
  tipBubbleEl.id = "tipbubble";
  tipBubbleEl.setAttribute("role", "tooltip");
  tipBubbleEl.hidden = true;
  document.body.appendChild(tipBubbleEl);
  return tipBubbleEl;
}

function showTip(el) {
  const text = el.dataset.tip;
  if (!text) { hideTip(); return; }   // 空 data-tip：顺手收掉上一个气泡
  const b = ensureTipBubble();
  tipCurrentEl = el;
  b.textContent = text;
  b.hidden = false;
  // 先归零再测量：残留的旧定位若贴着视口右缘，会把本次测宽压扁
  b.style.left = "0px"; b.style.top = "0px";
  const r = el.getBoundingClientRect();
  const bw = b.offsetWidth, bh = b.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const M = 8, GAP = 6;   // 视口留白 / 与触发元素的间距
  // 横向：tip-r 右对齐触发元素，其余左对齐；两侧向视口内收敛
  let left = el.classList.contains("tip-r") ? r.right - bw : r.left;
  left = Math.max(M, Math.min(left, vw - bw - M));
  // 纵向：优先下方；放不下翻转到上方；仍放不下则夹取在视口内
  let top = r.bottom + GAP;
  if (top + bh > vh - M) top = r.top - GAP - bh;
  if (top < M) top = Math.max(M, Math.min(r.bottom + GAP, vh - bh - M));
  b.style.left = `${Math.round(left)}px`;
  b.style.top = `${Math.round(top)}px`;
}

function hideTip() {
  if (tipBubbleEl) tipBubbleEl.hidden = true;
  tipCurrentEl = null;
}

// mouseover 委托等价于 mouseenter：进入 .tip 内任意子节点都会命中 closest
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest?.(".tip[data-tip]");
  if (el) { if (el !== tipCurrentEl) showTip(el); }
  else if (tipCurrentEl) hideTip();
});
document.addEventListener("focusin", (e) => {
  const el = e.target.closest?.(".tip[data-tip]");
  if (el) showTip(el);
  else if (tipCurrentEl) hideTip();
});
document.addEventListener("focusout", hideTip);
// 滚动/缩放后 fixed 定位失准，直接收起（capture 才能收到 .tscroll 等容器内滚动）
document.addEventListener("scroll", hideTip, true);
window.addEventListener("resize", hideTip);
document.documentElement.addEventListener("mouseleave", hideTip);

// sparkline：纯 SVG polyline，无动画（趋势是用来读数的）
function sparkline(values, { w = 72, h = 20, invert = false } = {}) {
  const nums = values.filter((v) => typeof v === "number" && isFinite(v));
  // 2 个点画不出「趋势」，只是一条随手斜线；文字数列已足够
  if (nums.length < 3) return "";
  const min = Math.min(...nums), max = Math.max(...nums);
  const span = max - min || 1;
  const pad = 2.5;
  const pts = nums.map((v, i) => {
    const x = pad + i * ((w - pad * 2) / (nums.length - 1));
    const norm = (v - min) / span;
    const y = pad + (invert ? norm : 1 - norm) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const [lx, ly] = pts[pts.length - 1].split(",");
  // 基线 = 序列首值的水平参照：折线相对它的偏移才读得出「涨/跌了多少」
  const norm0 = (nums[0] - min) / span;
  const y0 = (pad + (invert ? norm0 : 1 - norm0) * (h - pad * 2)).toFixed(1);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">`
    + `<line class="baseline" x1="${pad}" y1="${y0}" x2="${w - pad}" y2="${y0}"/>`
    + `<polyline points="${pts.join(" ")}"/>`
    + `<circle class="dot-last" cx="${lx}" cy="${ly}" r="2.1"/></svg>`;
}

// 方案详情页主趋势图：坐标轴/日期刻度/0.7 参考线/达标区/末点标注。
// 与 sparkline 分工：sparkline 是表格内联迷你图，这里是卡片主图。
function trendChart(values, dates, { h = 160, refLine = 0.7 } = {}) {
  const nums = values.filter((v) => typeof v === "number");
  if (nums.length < 2) return "";
  const W = 720, padL = 40, padR = 16, padT = 14, padB = 22;
  const iw = W - padL - padR, ih = h - padT - padB;
  const min = Math.min(refLine, ...nums) - 0.02, max = Math.max(1, ...nums);
  const x = (i) => padL + (i / (values.length - 1)) * iw;
  const y = (v) => padT + (1 - (v - min) / (max - min)) * ih;
  const pts = values.map((v, i) => typeof v === "number" ? `${x(i)},${y(v)}` : null)
    .filter(Boolean).join(" ");
  const gridY = [min, (min + max) / 2, max];
  const li = values.length - 1, lv = values[li];
  const dateTicks = [0, Math.floor((dates.length - 1) / 2), dates.length - 1]
    .filter((v, i, a) => a.indexOf(v) === i && dates[v]);
  return `<svg class="tchart" viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" role="img" aria-label="线上均分趋势">
    <rect class="band-ok" x="${padL}" y="${y(Math.min(1, max))}" width="${iw}" height="${Math.max(0, y(refLine) - y(Math.min(1, max)))}"/>
    ${gridY.map((v) => `<line class="grid" x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}"/>
      <text class="axis" x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${v.toFixed(2)}</text>`).join("")}
    <line class="refline" x1="${padL}" y1="${y(refLine)}" x2="${W - padR}" y2="${y(refLine)}"/>
    <text class="axis reftext" x="${W - padR}" y="${y(refLine) - 4}" text-anchor="end">参考线 ${refLine}</text>
    ${dateTicks.map((i) => `<text class="axis" x="${x(i)}" y="${h - 6}" text-anchor="middle">${escHtml(dates[i] ?? "")}</text>`).join("")}
    <polyline class="line" points="${pts}"/>
    ${typeof lv === "number" ? `<circle class="dot-last" cx="${x(li)}" cy="${y(lv)}" r="3.5"/>
      <text class="lastval" x="${x(li) - 8}" y="${y(lv) - 8}" text-anchor="end">${fmtScore(lv)}</text>` : ""}
  </svg>`;
}

// 通过率细条：比纯数字更快读出高低
function meter(rate) {
  if (rate == null) return "";
  const pct = Math.round(rate * 100);
  return `<span class="meter${pct < 70 ? " is-low" : ""}" aria-hidden="true"><i style="width:${pct}%"></i></span>`;
}

// 红队攻破格子：一眼看出「几次里破了几次」
function breachCells(breached, attacks) {
  if (attacks == null) return "";
  const n = Math.min(attacks, 12);
  let out = "";
  for (let i = 0; i < n; i++) out += `<i${i < (breached ?? 0) ? ' class="hit"' : ""}></i>`;
  return `<span class="cells" aria-hidden="true">${out}</span>`;
}

function download(filename, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------- auth（授权码模式，无 client secret） ----------
// 回调 URL 必须与池中注册值逐字节一致（无尾斜杠）。
const REDIRECT_URI = location.origin;

function loginUrl() {
  const p = new URLSearchParams({ client_id: cfg.clientId, response_type: "code",
    scope: "openid email", redirect_uri: REDIRECT_URI });
  return `${cfg.cognitoDomain}/oauth2/authorize?${p}`;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({ grant_type: "authorization_code",
    client_id: cfg.clientId, code, redirect_uri: REDIRECT_URI });
  const resp = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!resp.ok) throw new Error("token exchange failed");
  return resp.json();
}

async function initAuth() {
  const code = new URLSearchParams(location.search).get("code");
  if (code) {
    try {
      const t = await exchangeCode(code);
      sessionStorage.setItem("access_token", t.access_token);
      history.replaceState({}, "", "/");
    } catch (e) { console.error(e); }
  }
  state.token = sessionStorage.getItem("access_token");
  const authed = Boolean(state.token);
  if (authed) everAuthed = true;       // 「过期」只对登录过的会话成立
  document.body.classList.toggle("is-authed", authed);
  authExpired = false;                 // 新会话：解除上一次的失效锁
  $("authBanner")?.remove();
  $("loginBtn").classList.toggle("hidden", authed);
  $("logoutBtn").classList.toggle("hidden", !authed);
  $("who").textContent = authed ? "已登录" : "未登录";
  // 未登录时必败的入口直接禁用：点了只会吃 401，「可点但必败」是陷阱
  $("newPlanBtn").disabled = !authed;
  $("newPlanBtn").title = authed ? "" : "登录后可创建评估方案";
  $("rescanBtn").disabled = !authed;
  $("rescanBtn").title = authed ? "" : "登录后可扫描 Agent";
  if (authed) routeFromHash();   // 支持刷新/直链落在方案详情等子视图
  else {
    // 登录门（.auth-gate）只是遮挡，不是修复：门被关掉/绕过时，
    // 正文不能留「加载中…」的死胡同——每个默认带占位文案的容器都要写登录空态
    $("planTable").innerHTML =
      `<div class="empty"><svg class="eicon" aria-hidden="true"><use href="#i-lock"/></svg>
        <div class="big">登录后开始评估</div>登录后可创建评估方案并查看历史运行。</div>`;
    $("recentRuns").innerHTML =
      `<div class="empty"><svg class="eicon" aria-hidden="true"><use href="#i-lock"/></svg>
        <div class="big">请先登录</div>登录后此处将按时间倒序显示跨方案的运行记录。</div>`;
  }
}

// ---------- 认证失效：唯一收口 ----------
// 401 只 throw 字符串是不够的：#who / 登录按钮 / 缓存 都不会更新，于是出现
// 「左下角写着已登录，正文写着登录已过期」的自相矛盾，且缓存里的旧数据会被
// 当成事实继续渲染（例如把「有 2 次运行记录」显示成「从未运行」）。
let authExpired = false;
// 会话内是否登录过：401 的文案要区分「过期」和「压根没登录」。
// 对从未登录的用户说「登录已过期，请重新登录」是在为没发生过的事道歉。
let everAuthed = false;

function onAuthExpired() {
  if (authExpired) return;            // 并发请求只处理一次
  authExpired = true;
  sessionStorage.removeItem("access_token");
  state.token = null;
  document.body.classList.remove("is-authed");
  // 清掉过期缓存——留着会让界面拿旧数据编造事实
  state.agents = []; state.plans = []; state.recentRuns = [];
  state.estimates = {}; state.datasets = []; state.evaluators = []; state.custom = [];
  state.scopes = {}; state.datasetOnly = [];
  state.rtOptions = null;
  $("who").textContent = "登录已过期";
  $("loginBtn").classList.remove("hidden");
  $("logoutBtn").classList.add("hidden");
  // 过期后这两个入口同样必败——与未登录态一致地禁用
  $("newPlanBtn").disabled = true; $("newPlanBtn").title = "登录后可创建评估方案";
  $("rescanBtn").disabled = true; $("rescanBtn").title = "登录后可扫描 Agent";
  showAuthBanner();
  // 过期数据禁止交互，避免对着陈旧内容点「运行」再吃一个 401
  document.querySelectorAll(".view.on .panel").forEach((p) => p.classList.add("stale"));
}

function showAuthBanner() {
  if ($("authBanner")) return;
  const d = document.createElement("div");
  d.id = "authBanner";
  d.className = "authbanner";
  d.setAttribute("role", "alert");
  d.innerHTML = `${icon("warn")}
    <span style="flex:1">登录已过期，当前显示的数据可能不是最新。请重新登录后继续操作。</span>
    <button class="btn mini" id="reloginBtn">重新登录</button>`;
  document.querySelector("main").prepend(d);
  $("reloginBtn").onclick = () => (location.href = loginUrl());
}

// 跳过侧栏导航：把焦点落到当前视图第一个可聚焦元素上
$("skipLink").onclick = () => {
  const first = document.querySelector(".view.on button, .view.on a, .view.on input, .view.on select");
  (first ?? $("main")).focus?.();
  $("main").scrollIntoView({ block: "start" });
};

$("loginBtn").onclick = () => (location.href = loginUrl());
$("authLoginBtn").onclick = () => (location.href = loginUrl());
$("logoutBtn").onclick = () => {
  sessionStorage.removeItem("access_token");
  const p = new URLSearchParams({ client_id: cfg.clientId, logout_uri: REDIRECT_URI });
  location.href = `${cfg.cognitoDomain}/logout?${p}`;
};

// ---------- API：POST + SSE 流式解析 ----------
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function callApi(payload, onEvent) {
  const body = JSON.stringify(payload);
  const resp = await fetch(cfg.apiPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // JWT 走自定义头：Authorization 被 CloudFront OAC 的 SigV4 占用。
      "x-authorization": `Bearer ${state.token}`,
      // Lambda-OAC 对 POST 要求 body 哈希。
      "x-amz-content-sha256": await sha256Hex(body),
    },
    body,
  });
  if (resp.status === 401) {
    if (!everAuthed) throw new Error("请先登录");   // 没登录过 ≠ 过期
    onAuthExpired(); throw new Error("登录已过期，请重新登录");
  }
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split(/\r?\n\r?\n/);
    buf = frames.pop();
    for (const frame of frames) {
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim()).join("");
      if (!data) continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (typeof ev === "string") { try { ev = JSON.parse(ev); } catch { continue; } }
      onEvent(ev);
    }
  }
}

// 拉一个"单事件"动作的结果（多数 CRUD 动作只回一个事件）
async function apiOne(payload, wantEvent) {
  let out = null;
  await callApi(payload, (ev) => {
    if (ev.event === "error") throw new Error(ev.error);
    if (ev.event === wantEvent) out = ev;
  });
  if (!out) throw new Error(`未收到 ${wantEvent}`);
  return out;
}

// ---------- 导航（hash 路由：后退键可用、方案详情可分享/可刷新） ----------
// plan / agentDetail 是无 nav 入口的子视图，高亮归属其父级 tab。
const NAV_PARENT = { plan: "plans", agentDetail: "agents" };

function showView(name, hashId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("on"));
  $(`view-${name}`).classList.add("on");
  const navKey = NAV_PARENT[name] ?? name;
  document.querySelectorAll("#nav button").forEach((b) =>
    b.classList.toggle("on", b.dataset.view === navKey));
  hideConsoleIfOrphaned(name);
  // hash 与视图同步；popstate 还原时（restoring）不再压新条目
  const hash = "#" + name + (hashId ? "/" + encodeURIComponent(hashId) : "");
  if (!showView.restoring && location.hash !== hash) history.pushState(null, "", hash);
}

// hash → 视图。刷新 / 直链 / 前进后退共用这一个入口。
async function routeFromHash() {
  const [name, rawId] = (location.hash.slice(1) || "plans").split("/");
  const id = rawId ? decodeURIComponent(rawId) : null;
  showView.restoring = true;
  try {
    if (!state.token) { showView("plans"); return; }
    if (name === "plan" && id) await openPlan(id);
    else if (name === "agentDetail" && id) await openAgentDetail(id);
    else if (name === "agents") { showView("agents"); loadAgentsView(); }
    else if (name === "resources") { showView("resources"); loadResources(); }
    else if (name === "settings") { showView("settings"); loadSettings(); }
    else { showView("plans"); loadPlansView(); }
  } finally { showView.restoring = false; }
}
window.addEventListener("popstate", routeFromHash);

document.querySelectorAll("#nav button").forEach((b) =>
  b.addEventListener("click", () => {
    showView(b.dataset.view);
    if (!state.token) return;
    if (b.dataset.view === "plans") loadPlansView();
    if (b.dataset.view === "agents") loadAgentsView();
    if (b.dataset.view === "resources") loadResources();
    if (b.dataset.view === "settings") loadSettings();
  }));
document.querySelectorAll(".settings-nav a").forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelectorAll(".settings-nav a").forEach((item) =>
      item.classList.toggle("is-active", item === a));
    $(a.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
$("backPlans").onclick = (e) => { e.preventDefault(); showView("plans"); loadPlansView(); };
$("backAgents").onclick = (e) => { e.preventDefault(); showView("agents"); loadAgentsView(); };

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeDrawer();
    document.querySelectorAll("details.moremenu[open]").forEach((d) => d.removeAttribute("open"));
  }
});
// 更多操作菜单：点击菜单外任意处关闭（原生 details 不会自动收起）
document.addEventListener("click", (e) => {
  document.querySelectorAll("details.moremenu[open]").forEach((d) => {
    if (!d.contains(e.target)) d.removeAttribute("open");
  });
});

// ---------- 共享数据加载 ----------
// 缓存命中也要确认会话仍然有效：否则 401 之后 Agent 目录会照常列出旧数据、
// 一个错误都不报，用户根本不知道自己已经登出了。
async function ensureAgents(refresh = false) {
  if (state.agents.length && !refresh) {
    if (authExpired) throw new Error("登录已过期，请重新登录");
    return;
  }
  const ev = await apiOne({ action: "discover", refresh }, "agents");
  state.agents = ev.agents ?? [];
  state.agentsFromCache = Boolean(ev.from_cache);
}

function agentByName(name) { return state.agents.find((a) => a.agent_name === name); }

async function loadMeta() {
  if (state.evaluators.length) return;
  const meta = await apiOne({ action: "evaluators" }, "evaluators");
  state.evaluators = meta.available ?? [];
  state.defaults = meta.default ?? [];
  state.custom = meta.custom ?? [];
  state.metricKeys = meta.metrics ?? [];
  state.multimodal = meta.multimodal ?? [];
  // 「评估器 × 环节」适用性契约（后端并行开发中，字段缺失时回退现行为）
  state.scopes = meta.scopes ?? {};
  state.datasetOnly = meta.dataset_only ?? [];
}

function deltaHtml(line) {
  if (line?.delta == null) return "";
  // 显示口径两位小数：|delta| < 0.005（四舍五入后为 0.00）视为持平——
  // 显示 ↑0.00 是假精度，比持平更误导。箭头走 sprite：CJK 字体的 ↑↓ 随回退变形
  const r = Number.isInteger(line.delta) ? line.delta : Math.round(line.delta * 100) / 100;
  if (r === 0) return `<span class="delta d-flat" title="与上次持平">—</span>`;
  const good = line.delta_inverted ? r < 0 : r > 0;
  const arrow = icon(r > 0 ? "up" : "down", "ic-sm");
  const shown = Number.isInteger(r) ? Math.abs(r) : Math.abs(r).toFixed(2);
  return `<span class="delta ${good ? "d-up" : "d-down"}">${arrow}${shown}</span>`;
}

function scoreClass(v) { return v >= 0.7 ? "s-good" : v >= 0.4 ? "s-warn" : "s-bad"; }

// run 摘要（stage_summaries → 一行紧凑结果，评估台/历史/Agent 详情共用）
// dense=false 时省掉迷你图元：表格里三个环节挤一格，再加进度条会糊成一团。
function runResultHtml(r, { dense = false } = {}) {
  if (r.status === "skipped")
    return badge("warn", "已跳过", "skip")
      + `<span class="faint" style="margin-left:6px">${escHtml(r.skip_reason ?? "")}</span>`;
  if (r.status && r.status !== "completed")
    return badge("bad", "运行失败", "fail");
  // 每个环节结果包一层口径 tooltip：紧凑格子只放得下「线上 0.78」，
  // 「这个数是什么」的解释放进悬停（信息类，非动作指引）
  const parts = (r.stage_summaries ?? []).map((s) =>
    s.type === "observe" ? tip(SCORE_TIP.observe,
        `线上 <span class="num ${s.overall_mean != null ? scoreClass(s.overall_mean) : "faint"}">${fmtScore(s.overall_mean)}</span>`)
    : s.type === "dataset" ? tip(SCORE_TIP.dataset,
        `回归 <span class="num">${s.pass_rate != null ? (s.pass_rate * 100).toFixed(0) + "%" : "—"}</span>`) + (dense ? meter(s.pass_rate) : "")
    : tip(SCORE_TIP.redteam,
        `红队 <span class="num ${s.breached ? "s-bad" : "s-good"}">${s.breached}/${s.attacks}</span>`) + (dense ? breachCells(s.breached, s.attacks) : ""));
  return parts.join(" · ") || `<span class="faint">—</span>`;
}

// 运行状态图标（表格首列）——统一走 sprite
function statusIcon(status) {
  if (status === "completed") return `<span class="s-good">${icon("ok", "ic-sm")}</span>`;
  if (status === "skipped") return `<span class="s-warn">${icon("skip", "ic-sm")}</span>`;
  return `<span class="s-bad">${icon("fail", "ic-sm")}</span>`;
}

// 「上次结果」必须诚实：最近一条 run 不成功时先报状态，再小字给上次成功值。
// 拿旧成功结果冒充最新状态会误导决策（方案昨天就跑不通了，表里还是绿的）。
function lastResultHtml(planId, { runsUnknown = false } = {}) {
  // 运行记录没取到时不能说「从未运行」——那是把「不知道」说成了「没有」
  if (runsUnknown)
    return tip("运行记录加载失败，无法确认该方案的运行状态", `<span class="faint">—</span>`);
  const latest = state.recentRuns.find((r) => r.plan_id === planId);
  if (!latest) return `<span class="faint">从未运行</span>`;
  if (latest.status === "completed") {
    const firstLine = latest.overview?.stage_lines?.[0];
    return runResultHtml(latest) + deltaHtml(firstLine)
      + ` <span class="faint num">${escHtml(shortDate(latest.started_at))}</span>`;
  }
  const bad = latest.status === "skipped"
    ? badge("warn", "上次已跳过", "skip") : badge("bad", "上次运行失败", "fail");
  // 上次成功值收进 tooltip：撑成两行会让表格行高忽高忽低，破坏纵向扫读节奏
  const lastOk = state.recentRuns.find((r) => r.plan_id === planId && r.status === "completed");
  const okPart = lastOk
    ? " " + tipIcon(`上次成功 ${shortDate(lastOk.started_at)}：`
        + (lastOk.stage_summaries ?? []).map((s) => s.type === "observe" ? `线上 ${fmtScore(s.overall_mean)}`
            : s.type === "dataset" ? `回归 ${s.pass_rate != null ? Math.round(s.pass_rate * 100) + "%" : "—"}`
            : `红队 ${s.breached}/${s.attacks}`).join(" · "))
    : "";
  return `${bad} <span class="faint num">${escHtml(shortDate(latest.started_at))}</span>${okPart}`;
}

function shortDate(s) { return String(s ?? "").replace(/^\d{4}-/, "").replace(/ UTC$/, ""); }

// 时间显示唯一出口：同一页面内不允许出现第二种格式。
// 规则：当年省略年份，始终带时刻，始终不带 UTC 后缀（时区在运行历史标题统一声明一次）
function fmtTime(s, { withYear = false } = {}) {
  const raw = String(s ?? "").replace(/ UTC$/, "");
  if (!raw) return "";
  return withYear ? raw : raw.replace(/^\d{4}-/, "");
}

// duration_s 为 null（历史 run 无秒级时间戳）显示 —，不伪造
function fmtDur(s) {
  if (s == null) return "—";
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ---------- 预估：内置在表格/详情页（不弹窗），按 plan_id 缓存 ----------
function estimateBreakdown(est) {
  return (est.stages ?? []).map((s) => `${STAGE_LABELS[s.type] ?? s.type} $${s.estimated_cost_usd ?? 0}`
    + (s.error ? `（${s.error}）` : "")).join(" · ");
}

async function loadEstimate(planId, cell, { inline = false, plan = null } = {}) {
  const cached = state.estimates[planId];
  const paint = (est) => {
    if (!cell.isConnected) return;
    const errs = (est.stages ?? []).filter((s) => s.error).map((s) => s.error);
    const detail = estimateBreakdown(est);
    const warn = errs.length
      ? ` <span class="s-warn tip tip-r" data-tip="${escHtml(errs.join("；"))}" tabindex="0">${icon("warn", "ic-sm")}</span>` : "";
    // 单环节时明细 =「线上 $0.21」等于总额复读一遍——只留总额
    const multi = (est.stages ?? []).length > 1;
    // 预算警示：定时方案预估超上限时，运行会被调度器跳过——在成本处就地讲清后果
    const cap = plan?.schedule?.budget_usd;
    const over = cap != null && est.estimated_cost_usd > cap;
    const overNote = over && inline
      ? `<span class="s-bad" style="margin-left:6px">${icon("warn", "ic-sm")} 超出预算上限 $${cap}，定时运行将被跳过</span>` : "";
    // 表格里明细收进 ? tooltip：原同行明细被 sticky 操作列硬切成半个字，
    // 且 260px 列宽挤压「上次结果」列。详情页空间够，仍直接摊开。
    cell.innerHTML = `<b${over && !inline ? ` class="s-bad"` : ""}>$${est.estimated_cost_usd}</b>${warn} `
      + (!multi ? overNote
        : inline
        ? `<span class="faint" style="font-weight:400">（${escHtml(detail)}）</span>${overNote}`
        : tipIcon(`分环节明细：${detail}`, { alignRight: true }));
  };
  if (cached) { paint(cached); return; }
  try {
    const est = await apiOne({ action: "estimate_plan_run", plan_id: planId }, "plan_run_estimate");
    state.estimates[planId] = est;
    paint(est);
  } catch (e) {
    if (cell.isConnected)
      cell.innerHTML = tip(String(e.message ?? e), `<span class="s-warn">无法估算</span>`, { alignRight: true });
  }
}

// ============================================================
//  评估台：方案总表 + 最近 run
// ============================================================

async function loadPlansView() {
  $("plansStatus").textContent = "加载中…";
  $("planTable").innerHTML = `<div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
  $("recentRuns").innerHTML = `<div class="skel"></div><div class="skel"></div>`;
  try {
    const [plansEv, runsEv] = await Promise.all([
      apiOne({ action: "list_plans" }, "plans"),
      apiOne({ action: "list_recent_runs", limit: 100 }, "recent_runs"),
      loadMeta().catch(() => {}),
    ]);
    state.plans = plansEv.plans ?? [];
    state.recentRuns = runsEv.runs ?? [];
    state.runsUnknown = false;
    renderAgentFilter();
    renderPlanKpis();
    renderPlanTable();
    renderRecentRuns();
    $("plansStatus").textContent = `${state.plans.length} 个方案`;
  } catch (e) {
    $("plansStatus").textContent = "";
    $("planKpis").innerHTML = "";
    $("planTable").innerHTML = errBox(e);
    $("recentRuns").innerHTML = "";
  }
}

// ---------- KPI 概览条：首屏的视觉锚点 ----------
// 之前首屏最大的字是 18px 的页标题（不携带信息），用户必须逐行读表才能得到结论。
function renderPlanKpis() {
  // 一个方案都没有时 KPI 全是 0，没有信息量，反而占掉首屏——直接不出
  if (!state.plans.length) { $("planKpis").innerHTML = ""; return; }
  const done = state.recentRuns.filter((r) => r.status === "completed");
  const means = done.map((r) => (r.stage_summaries ?? [])
    .find((s) => s.type === "observe")?.overall_mean).filter((v) => typeof v === "number");
  const avg = means.length ? means.reduce((a, b) => a + b, 0) / means.length : null;
  // 趋势按时间正序（recentRuns 是新→旧）
  const trend = means.slice(0, 8).reverse();
  const breached = done.reduce((a, r) => a + (r.stage_summaries ?? [])
    .reduce((x, s) => x + (s.type === "redteam" ? (s.breached ?? 0) : 0), 0), 0);
  const cost = state.recentRuns.reduce((a, r) => a + (r.total_cost_usd ?? 0), 0);
  const failed = state.recentRuns.filter((r) => r.status && r.status !== "completed").length;

  // 副文本（迷你图/失败计数）挂标签行右侧，不和 28px 大数字挤同一基线；
  // ? 只留在真正需要解释口径的卡上（自明标题挂 ? 是纯噪点）
  const card = (v, k, { sub = "", alert = false, neutral = false, help = "" } = {}) => `
    <div class="kpi${alert ? " is-alert" : ""}${neutral ? " is-neutral" : ""}">
      <div class="v">${v}</div>
      <span class="k"><span>${escHtml(k)}${help ? tipIcon(help) : ""}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</span>
    </div>`;

  $("planKpis").innerHTML = [
    card(String(state.plans.length), "评估方案"),
    card(avg != null ? avg.toFixed(2) : "—", "线上评估均分",
      { sub: sparkline(trend), help: "最近各次成功运行的线上评估环节均分（各评估器 judge 评分的平均，0–1，越高越好）。完整分解见运行报告。" }),
    card(String(breached), "红队攻破", { alert: breached > 0 }),
    card("$" + cost.toFixed(2), "累计成本",
      { neutral: true, sub: failed ? `${failed} 次未成功` : "",
        help: "已记录运行的实际成本合计（judge + 被测 Agent 调用）。" }),
  ].join("");
}

function renderAgentFilter() {
  const names = [...new Set(state.plans.map((p) => p.agent_name))].sort();
  $("planAgentFilter").innerHTML = `<option value="">全部 Agent</option>` +
    names.map((n) => `<option ${n === state.planFilter ? "selected" : ""}>${escHtml(n)}</option>`).join("");
}
$("planAgentFilter").onchange = () => { state.planFilter = $("planAgentFilter").value; renderPlanTable(); };
let planSearchTimer = null;
$("planSearch").oninput = () => {
  $("planSearchClear").classList.toggle("hidden", !$("planSearch").value);
  clearTimeout(planSearchTimer);
  planSearchTimer = setTimeout(() => {
    state.planQuery = $("planSearch").value;
    renderPlanTable();
  }, 300);
};
$("planSearchClear").onclick = () => {
  clearTimeout(planSearchTimer);
  $("planSearch").value = "";
  $("planSearchClear").classList.add("hidden");
  state.planQuery = "";
  renderPlanTable();
  $("planSearch").focus();
};

function planStageBadges(p) {
  return (p.stages ?? []).map((s) => STAGE_LABELS[s.type] ?? s.type).join(STAGE_SEP);
}

// 每个方案的「上次成功 run」（趋势/详情用；表格的「上次结果」走 lastResultHtml）
function lastRunOf(planId) {
  return state.recentRuns.find((r) => r.plan_id === planId && r.status === "completed");
}

// 三个环节类型的一句话定义——目标用户不懂评估术语，就地解释
const STAGE_HELP = {
  observe: "线上评估：从线上真实会话抽样评分，不调用被测 Agent，仅产生 judge 费用",
  dataset: "回归测试：使用固定用例集真实调用 Agent 并比对期望输出，适用于变更后的回归验证",
  redteam: "红队测试：以模拟攻击话术调用 Agent，检验越狱、信息泄露等防护能力",
};

// 环节链分隔符走 sprite：CJK 字体的「→」随字体回退粗细/长度不一
const STAGE_SEP = ` <span class="faint">${icon("chevron-r", "ic-sm")}</span> `;

function planStageBadgesTitled(p) {
  return (p.stages ?? []).map((s) =>
    tip(STAGE_HELP[s.type] ?? "", STAGE_LABELS[s.type] ?? s.type)).join(STAGE_SEP);
}

// ---------- 表格排序：点表头切升/降 ----------
const planSort = { key: null, dir: 1 };

function sortPlans(list) {
  if (!planSort.key) return list;
  const val = (p) => {
    if (planSort.key === "name") return p.name ?? "";
    if (planSort.key === "agent") return p.agent_name ?? "";
    if (planSort.key === "est") return state.estimates[p.plan_id]?.estimated_cost_usd ?? -1;
    if (planSort.key === "last") {
      const r = state.recentRuns.find((x) => x.plan_id === p.plan_id);
      return r?.started_at ?? "";
    }
    return "";
  };
  return [...list].sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y), "zh");
    return c * planSort.dir;
  });
}

// extra 是附加 class（如 num），必须并进同一个 class 属性——
// 写成第二个 class="" 会被浏览器丢掉，th-sort 的样式就整条失效。
function sortableTh(key, label, extraClass = "") {
  const on = planSort.key === key;
  const arrow = on ? icon(planSort.dir > 0 ? "up" : "down", "ic-sm") : icon("sort", "ic-sm");
  return `<th class="th-sort${on ? " on" : ""}${extraClass ? " " + extraClass : ""}" data-sort="${key}">`
    + `<button type="button" class="thbtn">${escHtml(label)}`
    + `<span class="sortic${on ? " on" : ""}">${arrow}</span></button></th>`;
}

function renderPlanTable() {
  const q = (state.planQuery ?? "").trim().toLowerCase();
  let plans = state.planFilter
    ? state.plans.filter((p) => p.agent_name === state.planFilter) : state.plans;
  if (q) plans = plans.filter((p) =>
    (p.name ?? "").toLowerCase().includes(q) || (p.agent_name ?? "").toLowerCase().includes(q));
  plans = sortPlans(plans);
  if (q && !plans.length) {
    $("planTable").innerHTML = `<div class="empty" style="padding:var(--sp-6)">
      <div class="big">未找到匹配「${escHtml(q)}」的方案</div>
      请更换关键词，或清空搜索框查看全部方案。</div>`;
    return;
  }
  if (!plans.length) {
    $("planTable").innerHTML = `<div class="empty">
      <svg class="eicon" aria-hidden="true"><use href="#i-empty"/></svg>
      <div class="big">${state.planFilter ? "该 Agent 暂无评估方案" : "暂无评估方案"}</div>
      新建方案：选择 Agent，编排线上评估 / 回归 / 红队环节，保存后即可重复运行。<br>
      仅含线上评估环节的方案可直接创建；回归 / 红队环节需先在「资源库」准备数据集或用例集。<br>
      尚未接入评估对象？请在 <a href="#" class="qlink" id="emptyGoAgents">Agent</a> 页扫描 AgentCore 或接入 Langfuse 数据源。<br>
      <button class="btn" id="emptyNewPlan">+ 新建方案</button></div>`;
    $("emptyGoAgents")?.addEventListener("click", (e) => {
      e.preventDefault(); showView("agents"); loadAgentsView();
    });
    $("emptyNewPlan")?.addEventListener("click", () => openPlanEditorPage(null));
    return;
  }
  $("planTable").innerHTML = `<div class="tscroll"><table>
    <thead><tr>
      ${sortableTh("name", "方案")}
      ${sortableTh("agent", "Agent")}
      <th>环节 ${tipIcon("方案由若干环节按顺序组成。将鼠标悬停在「线上 / 回归 / 红队」上可查看各环节说明。")}</th>
      ${sortableTh("last", "上次结果", "result-col")}
      ${sortableTh("est", "单次预估 $", "num est-col")}
      <th>定时</th><th></th></tr></thead>
    <tbody>${plans.map((p, i) => `<tr class="rowlink" data-pid="${escHtml(p.plan_id)}">
        <td class="clip"><span class="qlink">${escHtml(p.name)}</span></td>
        <td class="muted clip">${escHtml(p.agent_name)}</td>
        <td class="muted" style="white-space:nowrap">${planStageBadgesTitled(p)}</td>
        <td class="result">${lastResultHtml(p.plan_id, { runsUnknown: state.runsUnknown })}</td>
        <td class="num estcell" id="pt-est-${i}"><span class="faint">估算中…</span></td>
        <td class="muted">${p.schedule?.cron ? `<code>${escHtml(p.schedule.cron)}</code>` : "—"}</td>
        <td class="actions" style="text-align:right">
          <button class="btn mini pt-run" data-pid="${escHtml(p.plan_id)}">${icon("play", "ic-sm ic-play")}运行</button>
        </td></tr>`).join("")}</tbody></table></div>
    <div class="faint" style="margin-top:var(--sp-2)">预估为 judge 评分与被测 Agent 调用费用的合计，实际费用以运行结果为准。</div>`;
  plans.forEach((p, i) => loadEstimate(p.plan_id, $(`pt-est-${i}`), { plan: p }));
  document.querySelectorAll("#planTable tr.rowlink").forEach((tr) =>
    tr.addEventListener("click", () => openPlan(tr.dataset.pid)));
  document.querySelectorAll(".pt-run").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); runPlan(b.dataset.pid, "cslot-plans"); }));
  document.querySelectorAll("#planTable th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (planSort.key === k) planSort.dir *= -1;
      else { planSort.key = k; planSort.dir = 1; }
      renderPlanTable();
    }));
  syncRunButtons();
}

function renderRecentRuns() {
  const runs = state.recentRuns.slice(0, 12);
  if (!runs.length) {
    $("recentRuns").innerHTML = `<span class="muted">暂无运行记录。运行任一方案后，此处将按时间倒序显示跨方案的运行记录。</span>`;
    return;
  }
  $("recentRuns").innerHTML = `<div class="tscroll"><table>
    <thead><tr><th></th><th>方案</th><th>Agent</th><th>时间</th><th>结果</th>
      <th class="num">成本</th><th>触发</th></tr></thead>
    <tbody>${runs.map((r) => `
      <tr class="rowlink rr-row" data-pid="${escHtml(r.plan_id)}" data-rk="${escHtml(r.run_key)}">
        <td style="width:26px">${statusIcon(r.status)}</td>
        <td class="clip"><span class="qlink">${escHtml(r.plan_name || r.plan_id)}</span></td>
        <td class="muted clip">${escHtml(r.agent_name)}</td>
        <td class="muted num">${escHtml(r.started_at ?? "")}</td>
        <td class="result">${runResultHtml(r)}</td>
        <td class="num">${r.total_cost_usd != null ? "$" + r.total_cost_usd : ""}</td>
        <td class="muted">${r.triggered_by === "schedule" ? "定时" : "手动"}</td></tr>`).join("")}
    </tbody></table></div>`;
  document.querySelectorAll(".rr-row").forEach((tr) =>
    tr.addEventListener("click", async () => {
      await openPlan(tr.dataset.pid);
      if (tr.dataset.rk) viewRun(tr.dataset.rk);
    }));
}

$("newPlanBtn").onclick = () => openPlanEditorPage(null);

// ============================================================
//  方案详情：定义 / 趋势 / run 历史 / 报告（唯一的结果场所）
// ============================================================

async function ensurePlans() {
  if (state.plans.length) return;
  const ev = await apiOne({ action: "list_plans" }, "plans");
  state.plans = ev.plans ?? [];
}

async function openPlan(planId) {
  await ensurePlans();
  const plan = state.plans.find((p) => p.plan_id === planId);
  if (!plan) { toast(`方案 ${planId} 不存在，可能已被删除`); return; }
  state.currentPlanId = planId;
  showView("plan", planId);
  $("planKpis2")?.classList.add("hidden");   // 等运行数据回来再显示
  $("planTitle").textContent = plan.name;
  $("planSub").textContent = "";
  $("planEditor").classList.add("hidden");
  document.querySelector(".plan-top")?.classList.remove("is-editing");
  $("planTrendPanel").classList.remove("hidden");
  $("synthesisPanel").classList.remove("hidden");
  $("synthesisPanel").classList.remove("is-empty");   // 空态压缩由 renderSynthesis 按数据重判
  $("runHistoryPanel").classList.remove("hidden");
  $("reportPanel").classList.add("hidden");
  syncConsoleForEditor();
  renderPlanHead(plan);
  // 不 await：页面先上骨架屏；viewRun 需要编号口径时 await 这个 promise
  state.planRunsReady = loadPlanRuns(planId);
}

function renderPlanHead(plan) {
  const stageLine = (plan.stages ?? []).map((st) => {
    const body = st.type === "observe"
      ? `线上评估（${st.max_sessions ?? 10} 会话 · ${(st.evaluators ?? []).length} 评估器）`
      : st.type === "dataset" ? `回归测试（${escHtml(st.dataset ?? "")}）`
      : `红队测试（${escHtml(st.cases_dataset ?? "内嵌用例")} · ${(st.strategies ?? []).length} 策略）`;
    return tip(STAGE_HELP[st.type] ?? "", body);
  }).join(STAGE_SEP);
  const sched = plan.schedule?.cron
    ? `<code>${escHtml(plan.schedule.cron)}</code> · 预算上限 ${plan.schedule.budget_usd != null
        ? "$" + plan.schedule.budget_usd
        : `<span class="s-warn">未设置 ${icon("warn", "ic-sm")}</span>`}` : "未设定时，需手动运行";
  // 两段式：被评估对象（Agent）为主体行，属性走定义网格——不再用 AGENT 全大写行内标签
  $("planHead").innerHTML = `
    <div class="ph-id">
      <a href="#" class="qlink" id="ph-agent">${escHtml(plan.agent_name)}</a>
      <span class="srcbadge">${agentByName(plan.agent_name)?.source === "langfuse" ? "langfuse" : "agentcore"}</span></div>
    <dl class="ph-grid">
      <dt>评估环节</dt><dd>${stageLine}</dd>
      <dt>运行方式</dt><dd>${sched}</dd>
      <dt>单次成本</dt><dd class="num" id="ph-est">…</dd>
    </dl>
    <div class="controls" style="margin-top:var(--sp-3)">
      <button class="btn" id="ph-run">${icon("play", "ic-play")}运行</button>
      <button class="btn ghost" id="ph-edit">编辑</button>
      <details class="moremenu">
        <summary class="btn ghost mini" aria-label="更多操作" aria-haspopup="menu">⋯</summary>
        <div class="mm-pop">
          <button class="mm-item danger" id="ph-del">删除方案</button>
        </div>
      </details>
    </div>`;
  loadEstimate(plan.plan_id, $("ph-est"), { inline: true, plan });
  $("ph-agent").onclick = async (e) => { e.preventDefault(); openAgentDetail(plan.agent_name); };
  $("ph-run").onclick = () => runPlan(plan.plan_id, "cslot-plan");
  syncRunButtons();
  $("ph-edit").onclick = () => openPlanEditor(plan.plan_id);
  $("ph-del").onclick = async () => {
    if (!confirm(`确认删除方案「${plan.name}」？删除后运行历史仍会保留。`)) return;
    try {
      await callApi({ action: "delete_plan", plan_id: plan.plan_id }, (ev) => {
        if (ev.event === "error") throw new Error(ev.error); });
      state.plans = state.plans.filter((p) => p.plan_id !== plan.plan_id);
      toast("方案已删除");
      showView("plans"); loadPlansView();
    } catch (e) { toast(`✗ ${e.message ?? e}`); }
  };
}

async function loadPlanRuns(planId) {
  $("runHistory").textContent = "加载中…";
  $("runHistorySub").textContent = "";   // 计数属于上一个方案，加载期间清空
  $("planTrend").textContent = "";
  $("synthesisBody").innerHTML = "";
  try {
    const ev = await apiOne({ action: "list_plan_runs", plan_id: planId }, "plan_runs");
    const runs = ev.runs ?? [];  // 新→旧
    state.planRuns = runs;       // 运行编号（#N，旧→新从 1 起）与单次报告标题共用
    const plan = state.plans.find((p) => p.plan_id === planId);
    if (plan) renderPlanKpis2(plan);
    renderPlanTrend(runs);
    renderSynthesis(runs);
    renderRunHistory(planId, runs);
  } catch (e) {
    $("runHistory").innerHTML = `<span class="s-bad">✗ ${escHtml(e.message ?? e)}</span>`;
    $("synthesisBody").innerHTML = `<span class="faint">运行记录加载失败，综合报告暂不可用。</span>`;
  }
}

// 运行编号：旧→新从 1 起（与运行历史表首列、综合报告 [run:#N] 引用同一口径）
function runNoOf(runKey) {
  const runs = state.planRuns ?? [];
  const idx = runs.findIndex((r) => r.run_key === runKey);
  return idx >= 0 ? runs.length - idx : null;
}

// ---------- 综合报告（跨运行视角，每次运行出一版，版本可切换） ----------
// [run:#N] / [run:#N 日期] 溯源引用 → 可点击：滚动到运行历史对应行并高亮
function linkifyRuns(html) {
  return html.replace(/\[run:#(\d+)(?:\s+([^\]]*))?\]/g, (_, n, date) =>
    `<span class="run-ref" data-runno="${n}" title="跳转到运行历史第 ${n} 次运行">`
    + `#${n}${date ? ` <span class="faint">${escHtml(date)}</span>` : ""}</span>`);
}

function highlightRunRow(runNo) {
  const tr = document.querySelector(`#runHistory tr[data-runno="${runNo}"]`);
  if (!tr) { toast(`运行历史中没有第 ${runNo} 次运行`); return; }
  tr.scrollIntoView({ behavior: "smooth", block: "center" });
  document.querySelectorAll("#runHistory tr.row-hl").forEach((x) => x.classList.remove("row-hl"));
  tr.classList.add("row-hl");
  // 静态底色 + 定时移除：CSS animation 会被 prefers-reduced-motion 全局禁用
  setTimeout(() => tr.classList.remove("row-hl"), 2400);
}

function renderSynthesis(runs) {
  const sel = $("synthSel"), body = $("synthesisBody");
  const total = runs.length;
  // 版本 = 带 synthesis 的 run（新→旧）；无 synthesis 的 run（跳过/失败/旧数据）不入选项
  const versions = runs.map((r, i) => ({ run: r, runNo: total - i }))
    .filter((v) => v.run.plan_synthesis);
  const latestDone = runs.find((r) => r.status === "completed");
  if (!versions.length) {
    sel.classList.add("hidden");
    // 空态压成一行提示条（is-empty）：94px 的整卡空态是纯损耗，面板与下拉 DOM 保留
    $("synthesisPanel").classList.add("is-empty");
    body.innerHTML = `<span class="muted">首次运行完成后，这里会给出跨运行的趋势分析与待办</span>`
      + (latestDone?.synthesis_error
        ? `<span class="faint">（上次运行未能生成综合报告：${escHtml(latestDone.synthesis_error)}）</span>` : "");
    return;
  }
  $("synthesisPanel").classList.remove("is-empty");
  sel.classList.remove("hidden");
  sel.innerHTML = versions.map((v) =>
    `<option value="${v.runNo}">第 ${v.runNo} 次运行 · ${escHtml(fmtTime(v.run.started_at))}</option>`).join("");
  // 最新完成的 run 生成失败时：faint 一行说明，正文回退到最近可用版本
  const staleNote = latestDone?.synthesis_error && latestDone.run_key !== versions[0].run.run_key
    ? `<div class="faint" style="margin-top:var(--sp-1)">最新一次运行未能生成综合报告（${escHtml(latestDone.synthesis_error)}），当前显示上一版。</div>` : "";
  const paint = (runNo) => {
    const v = versions.find((x) => x.runNo === Number(runNo)) ?? versions[0];
    const old = v.runNo !== versions[0].runNo
      ? `<div class="faint" style="margin-top:var(--sp-1)">历史版本：第 ${v.runNo} 次运行时点的综合分析。</div>` : "";
    body.innerHTML = `<div class="analysis">${linkifyRuns(mdToHtml(v.run.plan_synthesis))}</div>${staleNote}${old}`;
    body.querySelectorAll(".run-ref").forEach((el) =>
      el.addEventListener("click", () => highlightRunRow(Number(el.dataset.runno))));
  };
  sel.onchange = () => paint(sel.value);
  paint(versions[0].runNo);
}

// 方案详情页决策 KPI：当前均分（含涨跌与迷你趋势）/ 成功运行 / 单次预估
function renderPlanKpis2(plan) {
  const box = $("planKpis2");
  if (!box) return;
  const runs = state.planRuns ?? [];
  const done = runs.filter((r) => r.status === "completed");
  const obs = (r) => r?.stage_summaries?.find((s) => s.type === "observe")?.overall_mean;
  const cur = obs(done[0]), prev = obs(done[1]);
  const d = (typeof cur === "number" && typeof prev === "number") ? cur - prev : null;
  const series = done.slice(0, 8).reverse().map(obs);
  const est = state.estimates[plan.plan_id]?.estimated_cost_usd;
  const cap = plan.schedule?.budget_usd;
  box.innerHTML = `
    <div class="kpi${typeof cur === "number" && cur < 0.7 ? " is-alert" : ""}">
      <div class="v">${typeof cur === "number" ? fmtScore(cur) : "—"}${d != null ? deltaHtml({ delta: d }) : ""}</div>
      <span class="k"><span>当前线上均分</span><span class="sub">${sparkline(series) ?? ""}</span></span>
    </div>
    <div class="kpi is-neutral">
      <div class="v">${done.length}<span class="sub">/ ${runs.length} 次</span></div>
      <span class="k"><span>成功运行</span>${runs.length - done.length ? `<span class="sub">${runs.length - done.length} 次未成功</span>` : ""}</span>
    </div>
    <div class="kpi${cap != null && est != null && est > cap ? " is-alert" : " is-neutral"}">
      <div class="v">${est != null ? "$" + est : "…"}</div>
      <span class="k"><span>单次预估成本</span>${cap != null ? `<span class="sub">上限 $${cap}</span>` : ""}</span>
    </div>`;
  box.classList.remove("hidden");
}

// 趋势：每类环节一条时间序列（旧→新，等宽数字，趋势不动画——用户在读数）
function renderPlanTrend(runs) {
  const done = runs.filter((r) => r.status === "completed").slice(0, 8).reverse();
  if (done.length < 2) {
    $("planTrend").innerHTML = `<span class="muted">${done.length === 0 ? "暂无成功完成的运行。" : "仅有一次成功运行，累计两次后可查看趋势对比。"}</span>`;
    return;
  }
  const series = { observe: [], dataset: [], redteam: [] };
  const nums = { observe: [], dataset: [], redteam: [] };   // sparkline 用的原始数值
  const obsDates = [];  // trendChart 日期刻度（MM-DD），与 observe 序列逐点对齐
  for (const r of done) {
    for (const s of r.stage_summaries ?? []) {
      if (s.type === "observe") {
        series.observe.push(s.overall_mean ?? "—");
        nums.observe.push(s.overall_mean);
        obsDates.push(String(r.started_at ?? "").slice(5, 10));
      } else if (s.type === "dataset") {
        series.dataset.push(s.pass_rate != null ? (s.pass_rate * 100).toFixed(0) + "%" : "—");
        nums.dataset.push(s.pass_rate);
      } else {
        series.redteam.push(`${s.breached}/${s.attacks}`);
        nums.redteam.push(s.breached);
      }
    }
  }
  // 迷你图放在数列前：先看形状（在涨还是在跌），再读具体数值
  // 数值显示统一两位小数（fmtScore）；判色仍用原始数值
  const row = (lbl, vals, lastGoodCls, spark) => vals.length ? `
    <div class="trendrow"><span class="lbl">${lbl}</span>
      ${spark}
      <span class="trend-vals">${vals.map((v, i) => {
        const txt = escHtml(String(typeof v === "number" ? fmtScore(v) : v));
        return i === vals.length - 1 ? `<b class="${lastGoodCls(v)}">${txt}</b>` : txt;
      }).join(" ── ")}</span></div>` : "";
  // 线上均分升级为卡片主图（M4-2/M4-3）：坐标轴/日期刻度/0.7 参考线/达标区/末点标注。
  // 数值点 ≥2 才画主图；不足时维持迷你图+数列现状。dataset/redteam 两行不动。
  const obsChart = trendChart(nums.observe, obsDates);
  const obsRow = (() => {
    if (!series.observe.length) return "";
    if (!obsChart)
      return row("线上均分", series.observe, (v) => typeof v === "number" ? scoreClass(v) : "",
                 sparkline(nums.observe));
    // 行头只留末值 + 环比 delta（历史数列改由图表承担）；图内 lastval 是 SVG 文本，
    // 语义色与涨跌箭头仍走 HTML，沿用 .trend-vals b 的判色链路
    const lv = series.observe[series.observe.length - 1];
    const on = nums.observe.filter((v) => typeof v === "number");
    const dh = typeof lv === "number" && on.length >= 2
      ? deltaHtml({ delta: on[on.length - 1] - on[on.length - 2] }) : "";
    return `<div class="trendrow"><span class="lbl">线上均分</span>
      <span class="trend-vals"><b class="${typeof lv === "number" ? scoreClass(lv) : ""}">${escHtml(String(typeof lv === "number" ? fmtScore(lv) : lv))}</b> ${dh}</span></div>${obsChart}`;
  })();
  $("planTrend").innerHTML =
    obsRow +
    row("回归通过", series.dataset, () => "", sparkline(nums.dataset)) +
    // 红队被攻破次数越低越好 → 反转纵轴，让"向上"始终代表变好
    row("红队攻破", series.redteam, (v) => String(v).startsWith("0/") ? "s-good" : "s-bad",
        sparkline(nums.redteam, { invert: true })) +
    `<div class="faint" style="margin-top:var(--sp-1)">最近 ${done.length} 次成功运行，左侧较早，右侧最新</div>`;
}

function renderRunHistory(planId, runs) {
  // 副标题 = 有信息量的计数（替换掉「单次报告点查看报告展开」这类界面操作说明）
  const sub = $("runHistorySub");
  if (sub) sub.textContent = runs.length ? `共 ${runs.length} 次运行` : "";
  if (!runs.length) {
    $("runHistory").innerHTML = `<span class="muted">暂无运行记录。点击上方「运行」执行首次评估。</span>`;
    return;
  }
  const total = runs.length;
  $("runHistory").innerHTML = `<div class="tscroll narrow">
    <table><thead><tr><th>#</th><th></th><th>时间</th><th>耗时</th><th>触发</th><th>结果</th><th class="num">成本 $</th><th></th></tr></thead>
    <tbody>${runs.map((r, i) => `<tr data-runno="${total - i}">
      <td class="num faint">${total - i}</td>
      <td style="width:26px">${statusIcon(r.status)}</td>
      <td class="muted num">${escHtml(fmtTime(r.started_at))}</td>
      <td class="num">${fmtDur(r.duration_s)}</td>
      <td class="muted">${r.triggered_by === "schedule" ? "定时" : "手动"}</td>
      <td class="result">${runResultHtml(r, { dense: true })}</td>
      <td class="num">${r.total_cost_usd ?? "—"}</td>
      <td style="text-align:right"><button class="rowact r-view" data-rk="${escHtml(r.run_key)}">${r.status === "completed" ? "查看报告" : "查看原因"}</button></td>
    </tr>`).join("")}</tbody></table></div>`;
  document.querySelectorAll(".r-view").forEach((b) =>
    b.addEventListener("click", () => viewRun(b.dataset.rk)));
}

// ---------- 方案编辑器（新建走独立页态：隐藏趋势/历史，只留表单） ----------
let editingPlan = null;

async function openPlanEditorPage(agentName) {
  await Promise.all([ensureAgents(), loadMeta().catch(() => {})]);
  const candidates = state.agents.filter((a) => a.has_logs);
  if (!candidates.length) {
    toast("暂无可评估的 Agent，请先在 Agent 页扫描或接入数据源");
    showView("agents"); loadAgentsView();
    return;
  }
  state.currentPlanId = null;
  showView("plan");
  $("planKpis2")?.classList.add("hidden");
  $("planTitle").textContent = "新建方案";
  $("planSub").textContent = "";
  $("planHead").innerHTML = "";
  $("planTrendPanel").classList.add("hidden");
  $("synthesisPanel").classList.add("hidden");
  $("runHistoryPanel").classList.add("hidden");
  $("reportPanel").classList.add("hidden");
  editingPlan = {
    name: "",
    agent_name: agentName ?? candidates[0].agent_name,
    // 不预置环节：三种类型是并列选项，第一个环节也该由用户从类型卡片里选
    stages: [],
    schedule: null,
  };
  if (!state.datasets.length) await refreshDatasets().catch(() => {});
  if (!state.rtOptions) await loadRtOptions().catch(() => {});
  renderPlanEditor({ agentSelectable: !agentName });
  $("planEditor").classList.remove("hidden");
  document.querySelector(".plan-top")?.classList.add("is-editing");
  syncConsoleForEditor();
}

async function openPlanEditor(planId) {
  await Promise.all([ensureAgents(), loadMeta().catch(() => {})]);
  editingPlan = JSON.parse(JSON.stringify(state.plans.find((p) => p.plan_id === planId)));
  if (!state.datasets.length) await refreshDatasets().catch(() => {});
  if (!state.rtOptions) await loadRtOptions().catch(() => {});
  renderPlanEditor({ agentSelectable: false });
  $("planEditor").classList.remove("hidden");
  document.querySelector(".plan-top")?.classList.add("is-editing");
  syncConsoleForEditor();
  $("planEditor").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// 「评估器 × 环节」适用性：不适用的直接不渲染（不是置灰——用户只从能用的里选）。
// scopes / dataset_only / custom[].scope 由后端下发；字段缺失时回退现行为（向后兼容）。
function evaluatorsForStage(stageType) {
  const scopeOk = (n) => {
    const sc = state.scopes[n];
    return !Array.isArray(sc) || sc.includes(stageType);
  };
  // mm_* 多模态保留原逻辑：观测环节不渲染（观测抽的是文本会话），回归环节渲染
  let builtins = state.evaluators.filter((n) =>
    (stageType === "dataset" || !state.multimodal.includes(n)) && scopeOk(n));
  // correctness 等仅回归可用的内置在 dataset_only 下发（不与 available 重复计入）
  if (stageType === "dataset")
    builtins = builtins.concat(state.datasetOnly.filter((n) => !builtins.includes(n)));
  const custom = state.custom
    .filter((c) => { const sc = c.scope ?? "all"; return sc === "all" || sc === stageType; })
    .map((c) => c.name);
  return [...builtins, ...custom];
}

function evalChipsHtml(prefix, selected, stageType = "observe") {
  const names = evaluatorsForStage(stageType);
  const sel = new Set(selected ?? []);
  return `<div class="chips">${names.map((n) => `
    <label><input type="checkbox" class="${prefix}" value="${escHtml(n)}"
      ${sel.has(n) ? "checked" : ""}>${escHtml(n)}</label>`).join("")}</div>`;
}

function metricChipsHtml(prefix, selected) {
  const labels = { tokens: "Token", cost: "预估成本", latency: "延迟", llm_calls: "LLM 调用", tool_calls: "工具调用" };
  const sel = new Set(selected ?? []);
  return `<div class="chips">${state.metricKeys.map((m) => `
    <label><input type="checkbox" class="${prefix}" value="${m}"
      ${sel.has(m) ? "checked" : ""}>${labels[m] ?? m}</label>`).join("")}</div>`;
}

function renderPlanEditor({ agentSelectable } = {}) {
  const p = editingPlan;
  const isLf = agentByName(p.agent_name)?.source === "langfuse";
  const stageHtml = p.stages.map((st, i) => {
    let body = "";
    const noDs = !state.datasets.length && st.type !== "observe";
    if (st.type === "observe") {
      body = `
        <div class="controls">
          <label class="inline" title="从最近 N 天的线上会话中抽样">回看天数 <input type="number" data-f="lookback_days" data-i="${i}" value="${st.lookback_days ?? 30}" min="1" max="120" style="width:70px"></label>
          <label class="inline">最多会话 <input type="number" data-f="max_sessions" data-i="${i}" value="${st.max_sessions ?? 10}" min="1" max="50" style="width:70px"></label>
          <label class="inline" title="evaltest- 前缀的会话由平台执行回归时产生，默认排除"><input type="checkbox" data-f="include_test" data-i="${i}" ${st.include_test ? "checked" : ""}> 包含测试会话</label>
        </div>
        <div class="faint">评估器（LLM 逐会话评分，按会话数计费）</div>${evalChipsHtml(`st${i}-ev`, st.evaluators, "observe")}
        <div class="faint" style="margin-top:6px">指标（从 trace 直接计算，零成本）</div>${metricChipsHtml(`st${i}-mt`, st.metrics)}`;
    } else if (st.type === "dataset") {
      body = noDs
        ? `<div class="warnbox">暂无数据集。请先在 <a href="#" class="qlink pe-go-res">资源库</a> 创建或以 AI 生成用例集，再配置此环节。</div>`
        : `
        <div class="controls">
          <label class="inline">数据集
            <select data-f="dataset" data-i="${i}">
              ${state.datasets.map((d) => `<option ${d.name === st.dataset ? "selected" : ""}>${escHtml(d.name)}</option>`).join("")}
            </select></label>
        </div>
        <div class="faint">评估器${state.datasetOnly.includes("correctness")
          ? "（correctness 将对照用例的期望输出评分）" : ""}</div>${evalChipsHtml(`st${i}-ev`, st.evaluators, "dataset")}`;
    } else if (noDs) {
      body = `<div class="warnbox">暂无用例集。请先在 <a href="#" class="qlink pe-go-res">资源库</a> 通过「AI 生成攻击用例」创建，再配置此环节。</div>`;
    } else {
      const strategies = state.rtOptions?.strategies ?? [];
      const sel = new Set(st.strategies ?? state.rtOptions?.default_strategies ?? []);
      body = `
        <div class="controls">
          <label class="inline">用例集
            <select data-f="cases_dataset" data-i="${i}">
              ${state.datasets.map((d) => `<option ${d.name === st.cases_dataset ? "selected" : ""}>${escHtml(d.name)}</option>`).join("")}
            </select></label>
        </div>
        <div class="faint">攻击策略</div>
        <div class="chips">${strategies.map((s) => `
          <label><input type="checkbox" class="st${i}-strat" value="${escHtml(s.name)}"
            ${sel.has(s.name) ? "checked" : ""}>${escHtml(s.label ?? s.name)}</label>`).join("")}</div>`;
    }
    return `<div class="sess-detail">
      <div class="controls" style="justify-content:space-between">
        <strong>环节 ${i + 1} · ${STAGE_FULL[st.type]}</strong>
        <button class="btn danger mini st-del" data-i="${i}">移除环节</button>
      </div>
      <div class="faint" style="margin:-2px 0 6px">${STAGE_HELP[st.type] ?? ""}</div>
      ${body}</div>`;
  }).join("");

  const agentField = agentSelectable
    ? `<label class="inline">Agent
        <select id="pe-agent">${state.agents.filter((a) => a.has_logs).map((a) =>
          `<option ${a.agent_name === p.agent_name ? "selected" : ""}>${escHtml(a.agent_name)}</option>`).join("")}
        </select></label>`
    : `<span class="muted">Agent: <b>${escHtml(p.agent_name)}</b></span>`;

  const dsReady = state.datasets.length > 0;
  // 「添加环节」= 从三种并列的同级类型里选一种：等宽卡片（类型名 + 一句话说明），
  // 结构本身传达"三选一"，替换原先三个零散 ghost 按钮。
  // 禁用时卡片保留占位（视觉同级不塌），原因统一写在下方说明行。
  const invokeDisabled = isLf || !dsReady;
  const stageCard = (type, id, disabled) => `
      <button type="button" class="sa-card" id="${id}"${disabled ? " disabled" : ""}>
        <span class="sa-name">${STAGE_FULL[type]}${icon("plus", "ic-sm sa-plus")}</span>
        <span class="sa-desc">${escHtml((STAGE_HELP[type] ?? "").replace(`${STAGE_FULL[type]}：`, ""))}</span>
      </button>`;
  const saNote = isLf
    ? `<div class="sa-note">Langfuse 源仅支持线上评估环节；回归 / 红队环节需真实调用 Agent</div>`
    : dsReady ? ""
    : `<div class="sa-note">回归 / 红队环节需要用例集，请先在 <a href="#" class="qlink pe-go-res">资源库</a> 创建</div>`;
  // 零环节（新建初始态）：三卡片区是主选择区，标题升格为引导；
  // 已有环节后退回「添加环节」的次级追加语气。
  const saEmpty = !p.stages.length;
  $("planEditor").innerHTML = `
    <div class="controls">
      <label class="inline">方案名 <span class="s-bad">*</span> <input type="text" id="pe-name" value="${escHtml(p.name)}"
        placeholder="如：上线前全量 / 周一定时回归" style="width:220px"></label>
      ${agentField}
    </div>
    ${stageHtml}
    <div class="stage-add${saEmpty ? " is-primary" : ""}">
      <div class="sa-title" id="pe-add-title">${saEmpty
        ? `选择环节类型 <span class="sa-sub">方案由若干环节按顺序组成——先选第一个，之后还能继续追加</span>`
        : "添加环节"}</div>
      <div class="sa-grid" role="group" aria-labelledby="pe-add-title">
        ${stageCard("observe", "pe-add-observe", false)}
        ${stageCard("dataset", "pe-add-dataset", invokeDisabled)}
        ${stageCard("redteam", "pe-add-redteam", invokeDisabled)}
      </div>
      ${saNote}
    </div>
    <div class="sess-detail">
      <strong>定时运行</strong> <span class="faint">（可选。留空则仅手动运行；设置定时后须填写单次预算上限）</span>
      <div class="controls">
        <input type="text" id="pe-cron" placeholder="cron(0 1 ? * MON *) 或 rate(7 days)"
          value="${escHtml(p.schedule?.cron ?? "")}" style="width:240px">
        <label class="inline">单次预算上限 $ <span class="s-bad${p.schedule?.cron ? "" : " hidden"}" id="pe-budget-req">*</span><input type="number" id="pe-budget" step="0.01" min="0"
          value="${p.schedule?.budget_usd ?? ""}" style="width:90px" title="设置定时后必填：预估成本超过上限的运行将记为跳过"></label>
      </div>
    </div>
    <div class="controls">
      <button class="btn" id="pe-save">保存方案</button>
      <button class="btn ghost" id="pe-cancel">取消</button>
      <span id="pe-status" class="statusline"></span>
    </div>`;
  document.querySelectorAll("#planEditor .pe-go-res").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); showView("resources"); loadResources(); }));

  // 预算上限是条件必填：仅在填写了定时表达式时显示必填星号
  $("pe-cron").addEventListener("input", () =>
    $("pe-budget-req").classList.toggle("hidden", !$("pe-cron").value.trim()));

  // 绑定
  document.querySelectorAll("#planEditor [data-f]").forEach((el) =>
    el.addEventListener("change", () => {
      const st = editingPlan.stages[Number(el.dataset.i)];
      if (el.type === "checkbox") st[el.dataset.f] = el.checked;
      else if (el.type === "number") st[el.dataset.f] = Number(el.value);
      else st[el.dataset.f] = el.value;
    }));
  document.getElementById("pe-agent")?.addEventListener("change", () => {
    syncChips();
    editingPlan.agent_name = $("pe-agent").value;
    editingPlan.name = $("pe-name").value;
    // Langfuse 源不能有 invoke 环节——切 Agent 时立即约束可选环节
    if (agentByName(editingPlan.agent_name)?.source === "langfuse")
      editingPlan.stages = editingPlan.stages.filter((s) => s.type === "observe");
    renderPlanEditor({ agentSelectable: true });
  });
  document.querySelectorAll(".st-del").forEach((b) =>
    b.addEventListener("click", () => {
      editingPlan.stages.splice(Number(b.dataset.i), 1); syncChips();
      renderPlanEditor({ agentSelectable });
    }));
  $("pe-add-observe").onclick = () => { syncChips(); editingPlan.stages.push({ type: "observe",
    lookback_days: 30, max_sessions: 10, evaluators: [...state.defaults], metrics: [...state.metricKeys] });
    renderPlanEditor({ agentSelectable }); };
  $("pe-add-dataset")?.addEventListener("click", () => { syncChips(); editingPlan.stages.push({ type: "dataset",
    dataset: state.datasets[0]?.name ?? "", evaluators: ["helpfulness"] });
    renderPlanEditor({ agentSelectable }); });
  $("pe-add-redteam")?.addEventListener("click", () => { syncChips(); editingPlan.stages.push({ type: "redteam",
    cases_dataset: state.datasets[0]?.name ?? "",
    strategies: state.rtOptions?.default_strategies ?? [] });
    renderPlanEditor({ agentSelectable }); });

  function syncChips() {
    editingPlan.name = $("pe-name")?.value ?? editingPlan.name;
    editingPlan.stages.forEach((st, i) => {
      const evs = [...document.querySelectorAll(`.st${i}-ev:checked`)].map((c) => c.value);
      const mts = [...document.querySelectorAll(`.st${i}-mt:checked`)].map((c) => c.value);
      const strats = [...document.querySelectorAll(`.st${i}-strat:checked`)].map((c) => c.value);
      if (st.type === "observe") { st.evaluators = evs; st.metrics = mts; }
      if (st.type === "dataset") st.evaluators = evs;
      if (st.type === "redteam") st.strategies = strats;
    });
  }

  $("pe-save").onclick = async () => {
    syncChips();
    editingPlan.name = $("pe-name").value.trim();
    const cron = $("pe-cron").value.trim();
    const budget = parseFloat($("pe-budget").value);
    // 客户端先拦：后端也校验，但「填错了却没告诉我」最伤信任
    const fail = (el, msg) => {
      $("pe-status").innerHTML = `<span class="s-bad">✗ ${escHtml(msg)}</span>`;
      el.focus(); el.style.borderColor = "var(--bad)";
      el.addEventListener("input", () => { el.style.borderColor = ""; }, { once: true });
    };
    if (!editingPlan.name) { fail($("pe-name"), "方案名必填"); return; }
    if (!editingPlan.stages.length) {
      $("pe-status").innerHTML = `<span class="s-bad">✗ 方案至少需包含一个环节</span>`;
      // 提示落点：把错误指回类型选择区（零环节时它就是该操作的发生地）
      const sa = document.querySelector("#planEditor .stage-add");
      if (sa) {
        sa.classList.add("sa-attn");
        sa.scrollIntoView({ behavior: "smooth", block: "nearest" });
        // 不依赖 animationend：prefers-reduced-motion 下动画被全局禁用，事件不会来
        setTimeout(() => sa.classList.remove("sa-attn"), 1600);
      }
      return;
    }
    if (cron && (isNaN(budget) || budget <= 0)) {
      fail($("pe-budget"), "设置定时后须填写单次预算上限（定时触发无人工确认成本）"); return;
    }
    editingPlan.schedule = cron ? { cron, budget_usd: budget } : null;
    $("pe-status").textContent = "保存中…";
    try {
      const ev = await apiOne({ action: "save_plan", plan: editingPlan }, "plan_saved");
      $("pe-status").textContent = ev.schedule_error
        ? `已保存；⚠ 定时未生效：${ev.schedule_error}` : "✓ 已保存";
      // 参数变了 → 预估作废；方案列表就地更新
      delete state.estimates[ev.plan.plan_id];
      state.plans = state.plans.filter((p2) => p2.plan_id !== ev.plan.plan_id).concat([ev.plan]);
      if (!ev.schedule_error) openPlan(ev.plan.plan_id);
    } catch (e) {
      $("pe-status").textContent = `✗ ${e.message ?? e}`;
    }
  };
  $("pe-cancel").onclick = () => {
    $("planEditor").classList.add("hidden");
    syncConsoleForEditor();
    if (state.currentPlanId) openPlan(state.currentPlanId);
    else { showView("plans"); loadPlansView(); }
  };
}

// ============================================================
//  运行方案：控制台内联挂载到发起页面，跑完自动切到方案详情报告
// ============================================================

let runningPlanId = null;  // 同时只允许一个 run：第二个流会劫持控制台，且花的是真钱
let runStage = "";         // 当前环节文本（状态条镜像用，事件流里顺手维护）
let rsbPlanId = null;      // 状态条「查看」的落点（运行结束后 runningPlanId 已清空）
let rsbRunKey = null;      // 运行完成后「查看报告」直达这次 run

function mountConsole(slotId) {
  const panel = $("runConsolePanel");
  $(slotId).appendChild(panel);
  // 编辑器打开时不整版展示：控制台压在表单下会干扰填表，改走底部状态条
  if (editorActive()) { panel.classList.add("hidden"); renderRunStatusBar(); return; }
  removeRunStatusBar();
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// 控制台是跨页面的浮动面板：宿主页面切走时收起，避免完成态的日志
// 跟着用户出现在不相干的页面上。
function hideConsoleIfOrphaned(targetView) {
  const panel = $("runConsolePanel");
  const host = panel.parentElement?.id;  // cslot-plans / cslot-plan / cslot-agent
  const hostView = { "cslot-plans": "plans", "cslot-plan": "plan", "cslot-agent": "agentDetail" }[host];
  if (hostView && hostView !== targetView && !runningPlanId) panel.classList.add("hidden");
  // 状态条只服务编辑器态（编辑器住在 plan 视图）；切去别的视图就撤
  if (targetView !== "plan") removeRunStatusBar();
}

// ---------- 编辑器态的控制台替身：底部细状态条 ----------
function editorActive() {
  return $("view-plan").classList.contains("on")
    && !$("planEditor").classList.contains("hidden");
}

// 编辑器打开/关闭时调用：运行中则在「整版控制台 ⇄ 底部状态条」间切换
function syncConsoleForEditor() {
  const panel = $("runConsolePanel");
  if (editorActive() && runningPlanId) {
    panel.classList.add("hidden");
    renderRunStatusBar();
  } else {
    removeRunStatusBar();
    // 编辑器关闭后若运行仍在进行且控制台挂在当前视图，恢复整版展示
    if (runningPlanId && panel.parentElement) panel.classList.remove("hidden");
  }
}

function renderRunStatusBar() {
  let bar = $("runStatusBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "runStatusBar";
    bar.innerHTML = `<span class="dot"></span><span class="rsb-text"></span>
      <span class="hspace" style="flex:1"></span>
      <button class="btn ghost mini" id="rsbView">查看</button>`;
    document.body.appendChild(bar);
    bar.querySelector("#rsbView").onclick = async () => {
      const pid = rsbPlanId, rk = rsbRunKey;
      removeRunStatusBar();
      if (!pid) return;
      await openPlan(pid);          // openPlan 会关编辑器 → mountConsole 整版展示
      mountConsole("cslot-plan");
      if (rk) viewRun(rk);          // 已完成：直达这次 run 的报告
    };
  }
  updateRunStatusBar();
}

// 状态条内容 = 控制台标题/状态的镜像 + 当前环节；运行结束按钮变「查看报告」
function updateRunStatusBar() {
  const bar = $("runStatusBar");
  if (!bar) return;
  const title = $("runConsoleTitle").textContent;
  const status = $("runConsoleStatus").textContent.split("（")[0].trim();  // 明细太长，状态条只留主句
  const done = !runningPlanId;
  bar.classList.toggle("is-done", done);
  bar.querySelector(".rsb-text").innerHTML =
    `<b>${escHtml(title)}</b>${status ? ` · ${escHtml(status)}` : ""}${!done && runStage ? ` · ${escHtml(runStage)}` : ""}`;
  bar.querySelector("#rsbView").textContent = done ? "查看报告" : "查看";
}

function removeRunStatusBar() { $("runStatusBar")?.remove(); }

// 运行期间所有「运行」入口置灰。表格可能在运行中被重绘（预估回填、排序、
// 搜索），所以重绘后必须重新套用一次，否则会出现「运行中还能再点」。
function setRunButtonsDisabled(disabled) {
  document.querySelectorAll(".pt-run, .ap-run, #ph-run").forEach((b) => {
    b.disabled = disabled;
    if (b.id === "ph-run")
      b.innerHTML = disabled ? "运行中…" : `${icon("play", "ic-play")}运行`;
  });
}
function syncRunButtons() { if (runningPlanId) setRunButtonsDisabled(true); }

async function runPlan(planId, slotId) {
  if (runningPlanId) {
    toast(`已有评估正在运行（${runningPlanId}），请待其结束后再发起`);
    return;
  }
  runningPlanId = planId;
  rsbPlanId = planId; rsbRunKey = null; runStage = "";
  setRunButtonsDisabled(true);
  mountConsole(slotId);
  $("runConsoleTitle").textContent = "运行中";
  $("reportPanel").classList.add("hidden");
  $("stageRail").innerHTML = ""; $("runLog").textContent = ""; $("liveCards").innerHTML = "";
  $("runConsoleStatus").textContent = "";
  const liveCards = {};
  const log = (t) => {
    const el = $("runLog");
    el.textContent += t + "\n";
    el.scrollTop = el.scrollHeight;
  };
  let stageEls = [];

  try {
    let runKey = null;
    await callApi({ action: "run_plan", plan_id: planId }, (ev) => {
      switch (ev.event) {
        case "plan_run_started":
          $("runConsoleStatus").innerHTML = `${escHtml(ev.plan_name)} @ ${escHtml(ev.agent)} · 预估 <b class="num">$${ev.estimate.estimated_cost_usd}</b>`
            + `<span class="faint"> （${escHtml(estimateBreakdown(ev.estimate))}）</span>`;
          $("stageRail").innerHTML = ev.stages.map((t, i) =>
            `<div class="stage" id="stage-${i}"><span class="dot"></span>${STAGE_FULL[t] ?? t}</div>`).join("");
          stageEls = ev.stages.map((_, i) => $(`stage-${i}`));
          log(`▶ ${ev.plan_name} @ ${ev.agent}`);
          log(`  预估成本 $${ev.estimate.estimated_cost_usd}（${estimateBreakdown(ev.estimate)}）`);
          break;
        case "stage_start":
          stageEls[ev.stage - 1]?.classList.add("running");
          runStage = `环节 ${ev.stage}/${ev.total_stages} ${STAGE_FULL[ev.type] ?? ev.type}`;
          log(`● 环节 ${ev.stage}/${ev.total_stages}: ${STAGE_FULL[ev.type] ?? ev.type}`);
          break;
        case "session_result": {
          const parts = Object.entries(ev.results ?? {})
            .map(([k, r]) => `${k}=${r.errored ? "err" : r.score}`).join(" ");
          log(`  ✓ ${String(ev.session_id).slice(0, 18)} ${parts}`);
          if (ev.warning) log(`  ⚠ ${ev.warning}`);
          break;
        }
        case "session_error": log(`  ✗ ${ev.session_id ?? ""} ${ev.error}`); break;
        case "turn": case "attack_turn": {
          const key = `${ev.case ?? "case"}`;
          if (!liveCards[key]) {
            const div = document.createElement("div");
            div.className = "live-card"; div.innerHTML = `<h5>${escHtml(key)}</h5>`;
            $("liveCards").appendChild(div); liveCards[key] = div;
          }
          const cls = ev.event === "attack_turn"
            ? (ev.role === "attacker" ? "t-atk" : "t-agent")
            : (ev.role === "user" ? "t-user" : "t-agent");
          liveCards[key].insertAdjacentHTML("beforeend",
            `<div class="${cls}">${escHtml(ev.role)}: ${escHtml(String(ev.message).slice(0, 200))}</div>`);
          liveCards[key].scrollTop = liveCards[key].scrollHeight;
          break;
        }
        case "test_run_progress": log(`  … 回归进度 ${ev.completed}/${ev.total}`); break;
        case "redteam_progress": log(`  … 红队进度 ${ev.completed}/${ev.total}`); break;
        case "stage_done": {
          const el = stageEls[ev.stage - 1];
          el?.classList.remove("running");
          el?.classList.add(ev.summary?.status === "completed" ? "done" : "failed");
          log(`■ 环节 ${ev.stage} 完成`);
          break;
        }
        case "analysis_start": log("  ▶ 正在生成智能解析…"); break;
        case "synthesis_start": log("  ▶ 生成综合报告…"); break;
        case "synthesis_done":
          log(ev.ok ? "  ✓ 综合报告已更新" : `  ⚠ 综合报告生成失败：${ev.error ?? ""}`);
          break;
        case "heartbeat": break;
        case "plan_run_skipped": log(`⚠ ${ev.reason}`); break;
        case "plan_run_report": runKey = ev.run_key; break;
        case "error": throw new Error(ev.error);
      }
      updateRunStatusBar();   // 状态条是控制台的镜像，存在时随事件同步
    });
    runningPlanId = null;
    rsbRunKey = runKey;
    $("runConsoleTitle").textContent = runKey ? "✓ 运行完成" : "运行结束";
    if (runKey) {
      if (editorActive()) {
        // 用户正在填表：不抢焦点跳页，状态条变「✓ 运行完成 · 查看报告」；
        // 若编辑的正是这个方案，后台刷新趋势/综合报告/历史（新 synthesis 随之上屏）
        log("✔ 运行完成");
        if (state.currentPlanId === planId) loadPlanRuns(planId).catch(() => {});
      } else {
        log("✔ 运行完成，正在打开报告…");
        // run 属于方案 → 无论从哪发起，结果都在方案详情页看
        await openPlan(planId);
        mountConsole("cslot-plan");   // 日志随行，报告在下方
        await viewRun(runKey);
      }
    }
  } catch (e) {
    $("runConsoleTitle").textContent = "✗ 运行失败";
    log(`✗ ${e.message ?? e}`);
    toast(`运行失败：${e.message ?? e}`);
  } finally {
    runningPlanId = null;
    runStage = "";
    setRunButtonsDisabled(false);
    updateRunStatusBar();   // 完成态：✓ 运行完成 + 查看报告
  }
}
$("runConsoleClose").onclick = () => {
  if (runningPlanId) { toast("评估正在运行，暂不能收起控制台（关闭页面不会终止后端任务）"); return; }
  $("runConsolePanel").classList.add("hidden");
};

// ---------- 单次运行报告渲染 ----------
async function viewRun(runKey) {
  $("reportPanel").classList.remove("hidden");
  $("reportTitle").textContent = "运行报告";
  $("reportOverview").innerHTML = `<span class="muted">加载报告…</span>`;
  $("reportBody").innerHTML = "";
  try {
    const run = await apiOne({ action: "get_plan_run", run_key: runKey }, "plan_run");
    state.currentRunKey = runKey;
    state.currentAgent = run.agent_name;
    state.currentProposalCount = (run.proposals ?? []).length;
    state.currentReport = run.report ?? null;
    const done = run.status === "completed";
    // 「运行 #N 报告 · 日期」强化单次语义（跨运行视角在上方综合报告面板）；
    // run_key 收进 title，肉眼定位靠编号+日期。编号口径来自运行历史，等它就绪
    await state.planRunsReady?.catch?.(() => {});
    const runNo = runNoOf(runKey);
    const head = `${runNo != null ? `运行 #${runNo} 报告` : "运行报告"}${done ? "" : "（未完成）"}`;
    // 未完成的 run 没有报告可导出——标题、按钮、提示都按真实状态说话
    $("reportTitle").innerHTML = `<span title="${escHtml(runKey)}">${escHtml(head)}</span>
      <span class="h3sub">${escHtml(fmtTime(run.started_at))}</span>
      ${done ? `<button class="btn ghost mini" id="repExportJson" style="margin-left:10px">导出 JSON</button>
      <button class="btn ghost mini" id="repExportMd">导出 Markdown</button>` : ""}`;
    renderRunOverview(run);
    if (run.report) renderRunStages(run.report, run);
    else {
      const why = run.status === "skipped"
        ? `本次定时运行已跳过：${run.skip_reason ?? "预估成本超过预算上限"}`
        : done ? (run.report_error ?? "完整报告读取失败（摘要仍可用）")
        : `本次运行失败，未生成报告${run.error ? `：${run.error}` : ""}`;
      $("reportBody").innerHTML = `<div class="warnbox">${escHtml(why)}</div>`;
    }
    if (done) {
      $("repExportJson").onclick = () =>
        download(`${runKey.replace(/[#:]/g, "-")}.json`, JSON.stringify(run, null, 2), "application/json");
      $("repExportMd").onclick = () =>
        download(`${runKey.replace(/[#:]/g, "-")}.md`, runToMarkdown(run), "text/markdown");
    }
    $("reportPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    $("reportOverview").innerHTML = `<span class="s-bad">✗ ${escHtml(e.message ?? e)}</span>`;
  }
}

function renderRunOverview(run) {
  const ov = run.overview ?? {};
  const lines = (ov.stage_lines ?? []).map((l) => `
    <div class="ovline"><span class="k">${STAGE_LABELS[l.type] ?? l.type}</span>
      <span>${l.status && l.status !== "completed" ? `<span class="s-bad">✗</span> ` : ""}${escHtml(l.text)}</span>
      ${deltaHtml(l)}</div>`).join("");
  const ad = ov.adoption_note ? `
    <div class="ovline"><span class="k">改进追踪</span>
      <span>${ov.adoption_note.proposals.map((p) => `「${escHtml(p.summary)}」`).join("；")}
        → 采纳后：${ov.adoption_note.score_changes.map(escHtml).join("，") || "—"}</span></div>` : "";
  const meta = `<div class="faint" style="margin:4px 0 8px">
    ${escHtml(fmtTime(run.started_at))} · ${run.triggered_by === "schedule" ? "定时触发" : "手动触发"}
    ${run.total_cost_usd != null ? ` · 实际成本 $${run.total_cost_usd}` : ""}
    ${ov.previous_run ? ` · 对比基准 ${escHtml(ov.previous_run)}` : ""}</div>`;
  $("reportOverview").innerHTML = meta + lines + ad;
}

function renderRunStages(report, run) {
  const parts = [];
  (report.stages ?? []).forEach((st, i) => {
    if (st.type === "observe") parts.push(observeStageHtml(st, i));
    else if (st.type === "dataset") parts.push(datasetStageHtml(st, i));
    else parts.push(redteamStageHtml(st, i));
  });
  $("reportBody").innerHTML = parts.join("");
  bindReportHandlers(report, run);
}

// —— 线上评估环节章节 ——
function observeStageHtml(st, idx) {
  if (st.status !== "completed") {
    return `<h3 class="sec">环节 ${idx + 1} · 线上评估</h3>
      <div class="warnbox">${escHtml(st.error ?? "未完成")}</div>`;
  }
  const summary = st.summary ?? {};
  const head = `<tr><th>评估器</th><th class="num">均分</th><th class="num">通过率</th><th class="num">会话数</th><th class="num">评估失败</th></tr>`;
  const rows = Object.entries(summary).map(([name, s]) => `
    <tr><td>${escHtml(name)}</td>
      <td class="num">${s.mean_score != null ? `<span class="score ${scoreClass(s.mean_score)}">${fmtScore(s.mean_score)}</span>` : "—"}</td>
      <td class="num">${s.pass_rate != null ? (s.pass_rate * 100).toFixed(0) + "%" : "—"}</td>
      <td class="num">${s.sessions ?? "—"}</td>
      <td class="num">${s.errored ? `<span class="s-warn">${s.errored}</span>` : "0"}</td></tr>`).join("");

  let metricsHtml = "";
  const m = st.metrics;
  if (m) {
    const cells = [];
    if (m.tokens) cells.push(`Token 共 <b class="num">${m.tokens.total}</b>（入 ${m.tokens.input} / 出 ${m.tokens.output}）`);
    if (m.cost) cells.push(`预估成本 <b class="num">$${m.cost.usd}</b>${(m.cost.unpriced_models ?? []).length ? ` <span class="s-warn">（${m.cost.unpriced_models.join(",")} 无单价）</span>` : ""}`);
    if (m.latency) cells.push(`延迟均 <b class="num">${m.latency.avg_s}s</b> / 峰 ${m.latency.max_s}s`);
    if (m.tool_calls) cells.push(`工具调用 <b class="num">${m.tool_calls.count}</b> 次`);
    metricsHtml = `<div class="sess-detail">${cells.join(" · ")}</div>`;
  }

  const sessions = (st.session_details ?? []).map((s) => {
    if (s.error) return `<div class="sess-detail"><code>${escHtml(s.session_id ?? "?")}</code>
      <span class="s-bad">✗ ${escHtml(s.error)}</span></div>`;
    const lines = Object.entries(s.results ?? {}).map(([k, r]) => {
      const mark = r.errored ? "⚠" : r.passed ? "✓" : "✗";
      return `<div>${escHtml(k)} = <span class="score ${r.score != null ? scoreClass(r.score) : "faint"}">${r.errored ? "评估失败" : r.score}</span>
        ${mark} <span class="faint">${escHtml(String(r.reason ?? "").slice(0, 60))}…</span></div>`;
    }).join("");
    const warn = s.warning ? `<div class="s-warn">⚠ ${escHtml(s.warning)}</div>` : "";
    const view = s.transcript ? `<button class="btn ghost mini view-sess" data-sid="${escHtml(s.session_id)}">查看会话</button>` : "";
    return `<div class="sess-detail"><div><code>${escHtml(s.session_id)}</code> ${view}</div>${lines}${warn}</div>`;
  }).join("");

  const analysis = st.analysis ? `
    <h4 style="margin:14px 0 4px">智能解析 <span class="faint" style="font-weight:400">点击 ${icon("search", "ic-sm")} 引用可溯源至原会话</span></h4>
    <div class="analysis">${linkifySessions(mdToHtml(st.analysis),
      (st.session_details ?? []).map((s) => s.session_id).filter(Boolean))}</div>` : "";

  const improvable = (st.session_details ?? []).some((s) =>
    (s.diagnosis?.failures?.length || s.diagnosis?.root_causes?.length) ||
    Object.values(s.results ?? {}).some((r) => !r.errored && typeof r.score === "number" && r.score < 0.7));
  // 改进稿是报告的主要后续动作：主按钮 + 一句引导，紧跟智能解析的「建议」段
  // （DOM 顺序 analysis → improveBtn 已连续，margin 收紧保证视觉不断开）
  const improveLead = st.analysis
    ? "上方建议为方向性汇总；生成改进稿可将其落实为可直接粘贴的系统提示词修改（含改动清单与依据会话）。"
    : "生成改进稿：基于本环节的诊断证据，产出可直接粘贴的系统提示词修改草案（含改动清单与依据会话）。";
  const improveBtn = improvable ? `
    <div class="faint" style="margin-top:${st.analysis ? "2px" : "10px"}">${improveLead}</div>
    <div class="controls" style="margin-top:var(--sp-2)">
      <button class="btn improve-btn" data-idx="${idx}">生成改进稿（提示词修改草案）</button>
    </div><div id="improveOut-${idx}"></div>` : "";

  return `<h3 class="sec">环节 ${idx + 1} · 线上评估
      <span class="muted" style="font-weight:400">（${st.sessions} 个会话 · 均分 ${fmtScore(st.overall_mean)}）</span></h3>
    <div class="tscroll narrow"><table>${head}${rows}</table></div>
    ${metricsHtml}
    <details><summary>会话明细（${(st.session_details ?? []).length}）</summary>
      <div class="sess-details">${sessions || "<p class='muted'>无</p>"}</div></details>
    ${analysis}${improveBtn}`;
}

// —— 回归测试环节章节 ——
function datasetStageHtml(st, idx) {
  if (st.status === "error") {
    return `<h3 class="sec">环节 ${idx + 1} · 回归测试</h3>
      <div class="warnbox">${escHtml(st.error ?? "未完成")}</div>`;
  }
  const run = st.report ?? {};
  const results = run.results ?? [];
  const rows = results.map((r) => {
    const scores = Object.entries(r.results ?? {}).map(([k, v]) =>
      `${escHtml(k)}=<span class="score ${v.score != null ? scoreClass(v.score) : "faint"}">${v.errored ? "err" : v.score}</span>`).join(" ");
    const flag = r.blank_output ? `<span class="s-warn">空响应</span>`
      : r.error ? `<span class="s-bad">✗ ${escHtml(String(r.error).slice(0, 40))}</span>` : scores;
    return `<tr><td>${escHtml(r.case)}</td><td>${flag}</td>
      <td class="muted">${escHtml(String(r.output ?? "").slice(0, 80))}</td></tr>`;
  }).join("");
  const analysis = run.analysis ? `<div class="analysis">${mdToHtml(run.analysis)}</div>` : "";
  return `<h3 class="sec">环节 ${idx + 1} · 回归测试
      <span class="muted" style="font-weight:400">（${escHtml(st.dataset ?? "")} · 通过率 ${st.pass_rate != null ? (st.pass_rate * 100).toFixed(0) + "%" : "—"}${st.blank_cases ? ` · ${st.blank_cases} 例空响应` : ""}）</span></h3>
    <details><summary>用例明细（${results.length}）</summary>
      <div class="tscroll narrow"><table><thead><tr><th>用例</th><th>评分</th><th>输出摘录</th></tr></thead><tbody>${rows}</tbody></table></div>
    </details>${analysis}`;
}

// —— 红队环节章节 ——
function redteamStageHtml(st, idx) {
  if (st.status === "error") {
    return `<h3 class="sec">环节 ${idx + 1} · 红队测试</h3>
      <div class="warnbox">${escHtml(st.error ?? "未完成")}</div>`;
  }
  const run = st.report ?? {};
  const verdict = st.verdict === "PASS"
    ? `<span class="s-good">PASS · 未被攻破</span>`
    : st.verdict === "FAIL" ? `<span class="s-bad">FAIL · 被攻破 ${st.breached} 次</span>`
    : escHtml(st.verdict ?? "");
  const results = run.results ?? [];
  const rows = results.map((r) => `
    <tr><td>${escHtml(r.case ?? "")}</td><td>${escHtml(r.strategy ?? "")}</td>
      <td>${r.breached ? `<span class="s-bad">✗ 被攻破</span>` : r.errored ? `<span class="s-warn">评估失败</span>` : `<span class="s-good">✓ 已防御</span>`}</td>
      <td class="muted">${escHtml(String(r.reason ?? "").slice(0, 70))}</td></tr>`).join("");
  const analysis = run.analysis ? `<div class="analysis">${mdToHtml(run.analysis)}</div>` : "";
  return `<h3 class="sec">环节 ${idx + 1} · 红队测试
      <span style="font-weight:400">${verdict}</span>
      <span class="muted" style="font-weight:400">（${st.attacks} 次攻击）</span></h3>
    <details><summary>攻击明细（${results.length}）</summary>
      <div class="tscroll narrow"><table><thead><tr><th>用例</th><th>策略</th><th>结果</th><th>判定理由</th></tr></thead><tbody>${rows}</tbody></table></div>
    </details>${analysis}`;
}

function bindReportHandlers(report, run) {
  document.querySelectorAll("#reportBody .view-sess").forEach((el) =>
    el.addEventListener("click", () => openDrawer(el.dataset.sid, null)));
  document.querySelectorAll("#reportBody .sess-ref").forEach((el) =>
    el.addEventListener("click", () =>
      openDrawer(el.dataset.sid, el.dataset.n ? Number(el.dataset.n) : null)));
  document.querySelectorAll("#reportBody .improve-btn").forEach((el) =>
    el.addEventListener("click", () => proposeImprovements(Number(el.dataset.idx), el)));
}

// ---------- 改进稿（处方）+ 采纳标记 ----------
async function proposeImprovements(stageIdx, btn) {
  const st = state.currentReport?.stages?.[stageIdx];
  if (!st) return;
  const sessions = (st.session_details ?? []).map(({ transcript, ...rest }) => rest)
    .map((s) => ({ ...s, agent: state.currentAgent }));
  btn.disabled = true;
  const out = $(`improveOut-${stageIdx}`);
  out.innerHTML = `<p class="muted">正在复原系统提示词并汇总诊断证据，生成中…</p>`;
  try {
    let result = null;
    await callApi({
      action: "propose_improvements", agent_name: state.currentAgent,
      sessions, run_key: state.currentRunKey,
    }, (ev) => {
      if (ev.event === "improvement") result = ev;
      if (ev.event === "error") throw new Error(ev.error);
    });
    if (!result) throw new Error("未返回改进稿");
    const myIndex = state.currentProposalCount;  // attach 追加在现有之后
    state.currentProposalCount += 1;
    out.innerHTML = improvementHtml(result, myIndex);
    // 对比 / 修订全文 切换（复制按钮的 data-src 始终指向修订全文的 pre）
    const tabs = [...out.querySelectorAll(".impv-tab")];
    tabs.forEach((tab) => tab.addEventListener("click", () => {
      tabs.forEach((t2) => {
        t2.classList.toggle("on", t2 === tab);
        document.getElementById(t2.dataset.pane)?.classList.toggle("hidden", t2 !== tab);
      });
    }));
    out.querySelectorAll(".copy-btn").forEach((el) =>
      el.addEventListener("click", () => {
        const src = document.getElementById(el.dataset.src);
        if (!src) return;
        navigator.clipboard.writeText(src.textContent);
        el.textContent = "已复制 ✓";
        setTimeout(() => { el.textContent = "复制"; }, 1500);
      }));
    out.querySelector(".adopt-btn")?.addEventListener("click", async (e) => {
      const b = e.target;
      try {
        await apiOne({ action: "set_proposal_adopted", run_key: state.currentRunKey,
          index: Number(b.dataset.index), adopted: true }, "proposal_adopted");
        b.textContent = "✓ 已标记采纳（下次运行将自动对比分数）"; b.disabled = true;
      } catch (err) { toast(`✗ ${err.message ?? err}`); }
    });
  } catch (e) {
    out.innerHTML = `<p class="s-bad">✗ ${escHtml(String(e.message ?? e))}</p>`;
  } finally { btn.disabled = false; }
}

// ---- 行级 diff：修订版提示词的前后对比（朴素 LCS——提示词至多几百行，O(n·m) 足够） ----
function diffLines(a, b) {
  const A = String(a).split(/\r?\n/), B = String(b).split(/\r?\n/);
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: " ", s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "-", s: A[i] }); i++; }
    else { ops.push({ t: "+", s: B[j] }); j++; }
  }
  while (i < n) ops.push({ t: "-", s: A[i++] });
  while (j < m) ops.push({ t: "+", s: B[j++] });
  return ops;
}

function diffHtml(oldText, newText) {
  const ops = diffLines(oldText, newText);
  const line = (o) => `<div class="dl${o.t === "+" ? " dl-add" : o.t === "-" ? " dl-del" : ""}">`
    + `<span class="dl-sign">${o.t === " " ? "" : o.t}</span><span>${escHtml(o.s) || " "}</span></div>`;
  let out = "", k = 0;
  while (k < ops.length) {
    if (ops[k].t !== " ") { out += line(ops[k]); k++; continue; }
    let e = k;
    while (e < ops.length && ops[e].t === " ") e++;
    // 连续 >3 行未修改：首尾各留 1 行上下文，中间折叠（details 原生可展开）
    if (e - k > 3) {
      out += line(ops[k]);
      out += `<details class="dfold"><summary>⋯ ${e - k - 2} 行未修改</summary>`
        + ops.slice(k + 1, e - 1).map(line).join("") + `</details>`;
      out += line(ops[e - 1]);
    } else {
      for (let x = k; x < e; x++) out += line(ops[x]);
    }
    k = e;
  }
  return `<div class="diffview">${out}</div>`;
}

function improvementHtml(result, proposalIndex) {
  const p = result.proposal ?? {};
  const sp = p.system_prompt ?? {};
  const based = result.based_on ?? {};
  let seq = 0;
  const nid = () => `imp-copy-${proposalIndex}-${++seq}`;
  const copyBtn = (id) => `<button class="btn ghost mini copy-btn" data-src="${id}">复制</button>`;

  let promptHtml = "";
  if (sp.mode === "full" && sp.revised) {
    // 原提示词复原成功时默认展示逐行对比（哪里改了一目了然）；
    // 「修订全文」标签可切换；复制始终复制修订全文（用户要粘贴的是全文）。
    const cur = String(result.current_prompt ?? "");
    const hasDiff = Boolean(cur.trim());
    const fullId = `impv-${proposalIndex}-full`;
    promptHtml = `<h4>修订版系统提示词 ${copyBtn(fullId)}</h4>
      <p class="faint">基于 trace 复原原文的最小修改；请对照改动清单审阅后替换${hasDiff ? "。「复制」复制修订全文" : ""}。</p>`
      + (hasDiff ? `
      <div class="controls" style="margin:0 0 var(--sp-1)">
        <button type="button" class="btn ghost mini impv-tab on" data-pane="impv-${proposalIndex}-diff">对比</button>
        <button type="button" class="btn ghost mini impv-tab" data-pane="${fullId}">修订全文</button>
      </div>
      <div id="impv-${proposalIndex}-diff">${diffHtml(cur, sp.revised)}</div>` : "")
      + `<pre class="prompt-draft${hasDiff ? " hidden" : ""}" id="${fullId}">${escHtml(sp.revised)}</pre>`;
  } else if ((sp.snippets ?? []).length) {
    promptHtml = `<h4>提示词补丁片段</h4>
      <p class="faint">原提示词未能复原，以下为可粘贴片段与建议位置。</p>
      ${sp.snippets.map((s) => { const id = nid(); return `<div class="sess-detail">
        <div><strong>${escHtml(s.placement ?? "")}</strong> ${copyBtn(id)}</div>
        <pre class="prompt-draft" id="${id}">${escHtml(s.text ?? "")}</pre></div>`; }).join("")}`;
  }
  const changes = (sp.changes ?? []).map((c) =>
    `<li><strong>[${escHtml(c.kind ?? "")}]</strong> ${escHtml(c.what ?? "")}
     <span class="faint">— ${escHtml(c.why ?? "")}</span></li>`).join("");
  const tools = (p.tool_descriptions ?? []).map((t) => {
    const id = nid();
    return `<div class="sess-detail"><div><strong>${icon("tool", "ic-sm")} ${escHtml(t.name)}</strong> ${copyBtn(id)}
      <span class="faint">${escHtml(t.why ?? "")}</span></div>
      <pre>现: ${escHtml(t.current ?? "（无）")}\n改: <span id="${id}">${escHtml(t.revised ?? "")}</span></pre></div>`;
  }).join("");
  const others = (p.other_actions ?? []).map((o) =>
    `<li><strong>${escHtml(o.title ?? "")}</strong>：${escHtml(o.detail ?? "")}</li>`).join("");
  const fixTypes = Object.entries(based.fix_types ?? {}).map(([k, v]) => `${k}×${v}`).join("、") || "—";

  return `<div class="sess-detail">
    <p><strong>${escHtml(p.summary ?? "")}</strong></p>
    <p class="faint">依据：${based.sessions ?? 0} 个会话 · ${based.failures ?? 0} 处故障 · ${based.root_causes ?? 0} 条根因（${escHtml(fixTypes)}）
      ${result.prompt_recovered ? "" : " · ⚠ 原提示词未复原，仅提供补丁片段"}</p>
    ${promptHtml}
    ${changes ? `<h4>改动清单</h4><ul>${changes}</ul>` : ""}
    ${tools ? `<h4>工具描述修订</h4>${tools}` : ""}
    ${others ? `<h4>提示词无法解决的事项（需修改代码 / 配置）</h4><ul>${others}</ul>` : ""}
    <div class="controls">
      <button class="btn mini adopt-btn" data-index="${proposalIndex}">标记为已采纳</button>
      <span class="faint">草稿仅供人工审阅，平台不会改动已部署的 Agent。采纳修改后重新运行方案即可对比分数。</span>
    </div></div>`;
}

// ---------- markdown / 溯源工具 ----------
function mdToHtml(md) {
  const lines = escHtml(md).split(/\r?\n/);
  let html = "", inList = false;
  for (const line of lines) {
    const bolded = line.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    if (/^##\s+/.test(bolded)) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h3>${bolded.replace(/^##\s+/, "")}</h3>`;
    } else if (/^[-*]\s+/.test(bolded) || /^\d+[.、]\s*/.test(bolded)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${bolded.replace(/^[-*]\s+/, "").replace(/^\d+[.、]\s*/, "")}</li>`;
    } else if (bolded.trim() === "") {
      if (inList) { html += "</ul>"; inList = false; }
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${bolded}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

function linkifySessions(html, sessionIds) {
  // [session:ID#N] 引用 → 可点击溯源（放大镜走 sprite，emoji 在文本流里最跳）
  const glass = icon("search", "ic-sm");
  html = html.replace(/\[session:([^\]#]+)#(\d+)\]/g, (_, sid, n) =>
    `<span class="sess-ref" data-sid="${escHtml(sid)}" data-n="${n}">${glass}${escHtml(sid.slice(0, 10))}…#${n}</span>`);
  html = html.replace(/\[session:([^\]]+)\]/g, (_, sid) =>
    `<span class="sess-ref" data-sid="${escHtml(sid)}">${glass}${escHtml(sid.slice(0, 10))}…</span>`);
  for (const sid of sessionIds) {
    if (html.includes(`data-sid="${sid}"`)) continue;
    const short = sid.length > 14 ? sid.slice(0, 12) + "…" : sid;
    html = html.split(sid).join(`<span class="sess-ref" data-sid="${escHtml(sid)}">${glass}${escHtml(short)}</span>`);
  }
  return html;
}

function runToMarkdown(run) {
  const L = [`# 评估报告 — ${run.run_key}`, "",
    `- Agent: ${run.agent_name} · 方案: ${run.plan_name}`,
    `- 时间: ${run.started_at} → ${run.finished_at ?? ""} · 触发: ${run.triggered_by}`,
    run.total_cost_usd != null ? `- 实际成本: $${run.total_cost_usd}` : "", "",
    "## 总览", ""];
  for (const l of run.overview?.stage_lines ?? [])
    L.push(`- **${STAGE_FULL[l.type] ?? l.type}**: ${l.text}${l.delta != null ? `（较上次 ${l.delta > 0 ? "+" : ""}${l.delta}）` : ""}`);
  const ad = run.overview?.adoption_note;
  if (ad) L.push("", `- 改进建议采纳追踪: ${ad.proposals.map((p) => p.summary).join("；")} → ${ad.score_changes.join("，")}`);
  (run.report?.stages ?? []).forEach((st, i) => {
    L.push("", `## 环节 ${i + 1} · ${STAGE_FULL[st.type] ?? st.type}`, "");
    if (st.type === "observe") {
      for (const [k, s] of Object.entries(st.summary ?? {}))
        L.push(`- ${k}: 均分 ${fmtScore(s.mean_score)} / 通过率 ${s.pass_rate != null ? (s.pass_rate * 100).toFixed(0) + "%" : "—"}`);
      if (st.analysis) L.push("", st.analysis);
    } else if (st.type === "dataset") {
      L.push(`- 数据集 ${st.dataset} · 通过率 ${st.pass_rate != null ? (st.pass_rate * 100).toFixed(0) + "%" : "—"}`);
      if (st.report?.analysis) L.push("", st.report.analysis);
    } else {
      L.push(`- ${st.attacks} 次攻击 · 被攻破 ${st.breached} · ${st.verdict ?? ""}`);
      if (st.report?.analysis) L.push("", st.report.analysis);
    }
  });
  return L.filter((x) => x !== undefined).join("\n");
}

// ============================================================
//  Agent 目录 + Agent 详情（agent 视角：过滤器 + 快捷入口）
// ============================================================

async function loadAgentsView(refresh = false) {
  $("agentsStatus").textContent = refresh ? "重新扫描 AgentCore…" : "加载中…";
  $("agentTable").innerHTML = `<div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
  try {
    if (refresh) state.agents = [];
    await ensureAgents(refresh);
    await ensurePlans();
    // 最近一次评估从 run 流派生；若评估台没加载过就拉一次
    if (!state.recentRuns.length) {
      try {
        const ev = await apiOne({ action: "list_recent_runs", limit: 100 }, "recent_runs");
        state.recentRuns = ev.runs ?? [];
        state.runsUnknown = false;
      } catch { state.runsUnknown = true; /* run 流失败不阻塞目录，但要标记「不知道」 */ }
    }
    renderAgentTable();
    // 页级统计条：与工作台的 KPI 条呼应，三页开局节奏一致
    const connected = state.agents.filter((a) => a.has_logs).length;
    const noLogs = state.agents.length - connected;
    $("agentsStatus").textContent =
      `${state.agents.length} 个 Agent · ${connected} 个可评估`
      + (noLogs ? ` · ${noLogs} 个无日志` : "")
      + ` · 来源: ${state.agentsFromCache ? "缓存" : "实时扫描"}`;
  } catch (e) {
    $("agentsStatus").textContent = "";
    $("agentTable").innerHTML = errBox(e);   // 留空面板等于死胡同
  }
}
$("rescanBtn").onclick = () => loadAgentsView(true);

function renderAgentTable() {
  if (!state.agents.length) {
    $("agentTable").innerHTML = `<div class="empty">
      <svg class="eicon" aria-hidden="true"><use href="#i-bot"/></svg>
      <div class="big">未发现任何 Agent</div>
      当前账号内没有 AgentCore Runtime。可接入 Langfuse 数据源，以评估非 AgentCore 的 Agent。<br>
      <button class="btn" id="agEmptyGoSettings">去设置接入 Langfuse</button></div>`;
    $("agEmptyGoSettings")?.addEventListener("click", (e) => {
      e.preventDefault(); showView("settings"); loadSettings();
    });
    return;
  }
  $("agentTable").innerHTML = `<div class="tscroll narrow"><table>
    <thead><tr><th>Agent</th><th>来源</th>
      <th>日志 ${tipIcon("具备线上会话日志方可进行线上评估；无日志的 Agent 仅支持回归测试 / 红队测试。")}</th>
      <th class="num">方案数</th><th>最近一次评估</th><th></th></tr></thead>
    <tbody>${state.agents.map((a) => {
      const planCount = state.plans.filter((p) => p.agent_name === a.agent_name).length;
      const latest = state.recentRuns.find((r) => r.agent_name === a.agent_name);
      const lf = a.source === "langfuse";
      const cell = latest
        ? `<span class="muted num">${escHtml(shortDate(latest.started_at))}</span> ${runResultHtml(latest)}`
        : a.has_logs ? `<span class="faint">从未评估</span>`
                     : `<span class="faint">无日志，暂不支持评估</span>`;
      // 描述只在携带真实信息时显示：部署工具的模板描述
      // "AgentCore Runtime: <名字>" 与名字/来源列全冗余，是纯噪音
      const desc = (a.description ?? "").trim();
      const realDesc = desc && desc !== `AgentCore Runtime: ${a.agent_name}` ? desc : "";
      return `<tr class="rowlink ag-row" data-agent="${escHtml(a.agent_name)}">
        <td class="clip"><span class="qlink">${escHtml(a.agent_name)}</span>
          ${realDesc ? `<div class="faint" style="font-size:var(--fs-micro)">${escHtml(realDesc)}</div>` : ""}</td>
        <td><span class="srcbadge">${lf ? "langfuse" : "agentcore"}</span></td>
        <td>${a.has_logs ? `<span class="s-good">${icon("ok", "ic-sm")}</span>` : `<span class="faint">—</span>`}</td>
        <td class="num">${planCount}</td>
        <td>${cell}</td>
        <td class="actions ag-actions" style="text-align:right">
          ${lf ? `<button class="btn danger mini ag-lfdel" data-agent="${escHtml(a.agent_name)}">移除</button>` : ""}
        </td></tr>`;
    }).join("")}</tbody></table></div>`;
  document.querySelectorAll(".ag-row").forEach((tr) =>
    tr.addEventListener("click", () => openAgentDetail(tr.dataset.agent)));
  document.querySelectorAll(".ag-lfdel").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`确认移除 Langfuse 数据源「${b.dataset.agent}」？\n仅删除注册记录，不影响 Langfuse 数据与 Secrets Manager。`)) return;
      try {
        await callApi({ action: "delete_trace_source", agent_name: b.dataset.agent }, () => {});
        loadAgentsView(true);
      } catch (err) { toast(`✗ ${err.message ?? err}`); }
    }));
}

async function openAgentDetail(name) {
  showView("agentDetail", name);
  $("agentTitle").textContent = name;
  $("agentNewPlanBtn").onclick = () => openPlanEditorPage(name);
  $("agentPlanList").innerHTML = `<div class="skel"></div><div class="skel"></div>`;
  $("agentRuns").innerHTML = `<div class="skel"></div><div class="skel"></div>`;
  // 元数据取不到也要把页面渲染完：抛在这里会让两个面板永远停在「加载中…」
  let metaErr = null;
  try {
    await ensureAgents();
    await ensurePlans();
  } catch (e) { metaErr = e; }
  const a = agentByName(name);
  $("agentSub").textContent = a?.source === "langfuse"
    ? `Langfuse 数据源 · ${a.host ?? ""} · 仅支持线上评估`
    : a ? "AgentCore Runtime" : "";
  // 调用配置：不 await：读配置慢/失败都不该拖住方案列表与运行记录
  loadInvokeConfig(name);
  // 先取运行记录再渲染：「上次结果」是从 recentRuns 派生的，
  // 抢在数据到位前渲染会把「不知道」显示成「从未运行」（401 时尤其明显）。
  let runsErr = metaErr, runs = [];
  if (!metaErr) {
    try {
      const ev = await apiOne({ action: "list_recent_runs", agent_name: name, limit: 30 }, "recent_runs");
      runs = ev.runs ?? [];
      // 合并进全局 run 流，供 lastResultHtml 派生（去重按 run_key）
      const seen = new Set(runs.map((r) => r.run_key));
      state.recentRuns = [...runs, ...state.recentRuns.filter((r) => !seen.has(r.run_key))]
        .sort((a2, b2) => String(b2.started_at ?? "").localeCompare(String(a2.started_at ?? "")));
    } catch (e) { runsErr = e; }
  }
  if (metaErr) {
    $("agentPlanList").innerHTML = errBox(metaErr);
    $("agentRuns").innerHTML = errBox(metaErr);
    return;
  }
  renderAgentPlanList(name, { runsErr });
  if (runsErr) $("agentRuns").innerHTML = errBox(runsErr);
  else renderAgentRuns(runs);
}

// 统一的错误块：过期/失败都给一句人话，不留「加载中…」的死胡同
function errBox(e) {
  const msg = String(e?.message ?? e);
  const expired = msg.includes("登录已过期");
  const needLogin = msg.includes("请先登录");
  return `<div class="empty" style="padding:var(--sp-6)">
    <div class="big">${expired ? "登录已过期" : needLogin ? "请先登录" : "加载失败"}</div>
    ${expired ? "重新登录后即可查看该 Agent 的评估方案与运行记录。"
      : needLogin ? "通过左下角「登录」进入后即可查看。"
      : `<span class="s-bad">${escHtml(msg)}</span>`}</div>`;
}

function renderAgentPlanList(name, { runsErr = null } = {}) {
  const plans = state.plans.filter((p) => p.agent_name === name);
  if (!plans.length) {
    $("agentPlanList").innerHTML = `<div class="empty" style="padding:var(--sp-6)">
      <div class="big">该 Agent 暂无评估方案</div>
      点击「+ 新建方案」，选择环节类型并保存后即可运行。</div>`;
    return;
  }
  $("agentPlanList").innerHTML = `<div class="tscroll narrow"><table>
    <thead><tr><th>方案</th><th>环节</th><th>上次结果</th><th class="num">单次预估 $</th><th></th></tr></thead>
    <tbody>${plans.map((p, i) => `<tr>
        <td class="clip"><b>${escHtml(p.name)}</b></td>
        <td class="muted" style="white-space:nowrap">${planStageBadgesTitled(p)}</td>
        <td class="result">${lastResultHtml(p.plan_id, { runsUnknown: Boolean(runsErr) })}</td>
        <td class="num estcell" id="ap-est-${i}"><span class="faint">估算中…</span></td>
        <td class="actions" style="text-align:right">
          <button class="btn mini ap-run" data-pid="${escHtml(p.plan_id)}">${icon("play", "ic-sm ic-play")}运行</button>
          <button class="btn ghost mini ap-open" data-pid="${escHtml(p.plan_id)}">详情</button>
        </td></tr>`).join("")}</tbody></table></div>
    <div class="faint" style="margin-top:var(--sp-2)">运行记录归属于所属方案，评估报告请在方案详情页查看。</div>`;
  plans.forEach((p, i) => loadEstimate(p.plan_id, $(`ap-est-${i}`)));
  document.querySelectorAll(".ap-run").forEach((b) =>
    b.addEventListener("click", () => runPlan(b.dataset.pid, "cslot-agent")));
  document.querySelectorAll(".ap-open").forEach((b) =>
    b.addEventListener("click", () => openPlan(b.dataset.pid)));
  syncRunButtons();
}

function renderAgentRuns(runs) {
  if (!runs.length) {
    $("agentRuns").innerHTML = `<span class="muted">该 Agent 暂无运行记录。</span>`;
    return;
  }
  $("agentRuns").innerHTML = `<div class="tscroll narrow"><table>
    <thead><tr><th></th><th>方案</th><th>时间</th><th>结果</th><th>触发</th><th></th></tr></thead>
    <tbody>${runs.map((r) => `
      <tr class="rowlink agr-row" data-pid="${escHtml(r.plan_id)}" data-rk="${escHtml(r.run_key)}">
        <td style="width:26px">${statusIcon(r.status)}</td>
        <td class="clip"><span class="qlink">${escHtml(r.plan_name || r.plan_id)}</span></td>
        <td class="muted num">${escHtml(r.started_at ?? "")}</td>
        <td class="result">${runResultHtml(r)}</td>
        <td class="muted">${r.triggered_by === "schedule" ? "定时" : "手动"}</td>
        <td class="faint" style="text-align:right">→ 方案详情</td></tr>`).join("")}
    </tbody></table></div>`;
  document.querySelectorAll(".agr-row").forEach((tr) =>
    tr.addEventListener("click", async () => {
      await openPlan(tr.dataset.pid);
      if (tr.dataset.rk) viewRun(tr.dataset.rk);
    }));
}

// ============================================================
//  调用配置（Agent 详情页 · 原设置页「Agent 调用模板」）
//  三步走：选请求格式 → 测试连通（一次真实调用）→ 从真实响应里点输出位置。
//  目标是让不写 JSON 的人也能配好，且在保存前就知道配置对不对。
// ============================================================

// 预置请求格式：覆盖 Strands / 自定义 FastAPI / OpenAI 风格三类常见入参。
// 「自定义」不带模板，选中即保留用户手写内容。
const INVOKE_PRESETS = [
  { key: "prompt", label: "prompt（最常见）", tpl: '{"prompt": "{input}"}',
    hint: "Strands、多数自定义 FastAPI Agent 的默认入参" },
  { key: "input-prompt", label: "input.prompt（嵌套）", tpl: '{"input": {"prompt": "{input}"}}',
    hint: "入参包了一层 input 的 Agent" },
  { key: "messages", label: "messages（OpenAI 风格）",
    tpl: '{"messages": [{"role": "user", "content": "{input}"}]}',
    hint: "按对话消息数组收参的 Agent" },
  { key: "custom", label: "自定义", tpl: null, hint: "自己写模板" },
];

const invCfg = {
  agent: null,
  // respPath 是否被用户改动过：决定探测时 response_path 走"不传键（用已保存规则）"
  // 还是"传本次草稿"。三态语义见后端 probe.py，这里绝不能用 `||` 兜默认值。
  respPathDirty: false,
  probing: false,
  probe: null,        // 最近一次 invoke_probed 事件
};

// 模板与预置是否"同一个格式"：比对时去掉所有空白，让
// {"prompt":"{input}"} 与 {"prompt": "{input}"} 都能高亮到同一项。
// 代价是值内部的空格差异也会被忽略——对这几个固定预置无歧义。
const tplNorm = (s) => String(s ?? "").replace(/\s+/g, "");

function matchedPresetKey() {
  const cur = tplNorm($("cfgTemplate").value);
  if (!cur) return "custom";
  return INVOKE_PRESETS.find((p) => p.tpl && tplNorm(p.tpl) === cur)?.key ?? "custom";
}

function renderInvokePresets() {
  const on = matchedPresetKey();
  $("invPresetChips").innerHTML = INVOKE_PRESETS.map((p) => `
    <label title="${escHtml(p.hint)}">
      <input type="radio" name="invPreset" class="inv-preset" value="${escHtml(p.key)}"
        ${p.key === on ? "checked" : ""}>${escHtml(p.label)}</label>`).join("");
  document.querySelectorAll(".inv-preset").forEach((r) =>
    r.addEventListener("change", () => {
      const p = INVOKE_PRESETS.find((x) => x.key === r.value);
      // 「自定义」不改写编辑框：它的含义就是"保留我手写的内容"。
      if (p?.tpl != null) $("cfgTemplate").value = p.tpl;
      renderInvokePresets();
      $("cfgTemplate").focus();
    }));
}

$("cfgTemplate").addEventListener("input", renderInvokePresets);
$("cfgRespPath").addEventListener("input", () => { invCfg.respPathDirty = true; });

// 打开 Agent 详情时装载该 Agent 的配置。失败不能打断详情页其他面板。
async function loadInvokeConfig(name) {
  invCfg.agent = name;
  invCfg.respPathDirty = false;
  invCfg.probe = null;
  $("invCfgBlock").removeAttribute("open");   // 换 Agent 一律收起，避免看错对象
  $("invProbeResult").classList.add("hidden");
  $("invProbeResult").innerHTML = "";
  $("invProbeStatus").textContent = "";
  $("cfgStatus").textContent = "";
  $("invSampleInput").value = "";
  $("cfgTemplate").value = "";
  $("cfgRespPath").value = "";
  // Langfuse 数据源没有可调用的 Runtime，调用模板对它没有意义 —— 整块隐藏。
  const isLangfuse = agentByName(name)?.source === "langfuse";
  $("invCfgBlock").classList.toggle("hidden", isLangfuse);
  if (isLangfuse) return;
  renderInvokePresets();
  try {
    const ev = await apiOne({ action: "get_agent_config", agent_name: name }, "agent_config");
    if (invCfg.agent !== name) return;   // 期间用户已切走
    $("cfgTemplate").value = ev.payload_template ?? "";
    $("cfgRespPath").value = ev.response_path ?? "";
    renderInvokePresets();
  } catch (e) { $("cfgStatus").textContent = `✗ 读取配置失败：${e.message ?? e}`; }
}

// 一次探测。pathArg 三态（务必按语义传，不要用 || 兜默认值）：
//   undefined → 不传 response_path 键，后端用已保存规则
//   "a.b"     → 用这条路径验证（不落盘）
//   ""        → 显式"不提取，整段响应即输出"
async function probeInvoke(pathArg, { label = "正在调用该 Agent…" } = {}) {
  const name = invCfg.agent;
  if (!name) { toast("请先打开一个 Agent"); return; }
  if (invCfg.probing) return;         // 探测要花钱：一次点击只发一次，不排队不重试
  const tpl = $("cfgTemplate").value.trim();
  if (!tpl) { $("invProbeStatus").textContent = "✗ 请先填写调用模板"; return; }
  invCfg.probing = true;
  $("invProbeBtn").disabled = true;
  const t0 = Date.now();
  let waiting = label;
  const tick = setInterval(() => {
    $("invProbeStatus").textContent = `${waiting}（已等待 ${Math.round((Date.now() - t0) / 1000)}s，最长 45s）`;
  }, 500);
  $("invProbeStatus").textContent = waiting;

  const req = { action: "probe_agent_invoke", agent_name: name, payload_template: tpl };
  const sample = $("invSampleInput").value.trim();
  if (sample) req.sample_input = sample;
  if (pathArg !== undefined) req.response_path = pathArg;

  let ev = null, err = null;
  try {
    // 后端硬上限 45s；这里的 50s 只是"连 SSE 都没收尾"的兜底，
    // 必须比后端上限宽，否则会把后端正常返回的超时文案抢掉。
    await Promise.race([
      callApi(req, (e) => {
        if (e.event === "heartbeat") { waiting = "仍在等待目标响应…"; return; }
        if (e.event === "error") { err = new Error(e.error); return; }
        if (e.event === "invoke_probed") ev = e;
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("等待响应超时，请重试")), 50000)),
    ]);
  } catch (e) { err = e; }
  clearInterval(tick);
  invCfg.probing = false;
  $("invProbeBtn").disabled = false;
  if (invCfg.agent !== name) return;   // 期间切走了：结果不属于当前页面
  if (err || !ev) {
    $("invProbeStatus").textContent = `✗ ${err?.message ?? "未收到探测结果"}`;
    return;
  }
  invCfg.probe = ev;
  $("invProbeStatus").textContent = ev.ok ? "✓ 调用成功" : "✗ 见下方结果";
  renderProbeResult(ev);
}

$("invProbeBtn").onclick = () =>
  // 未改动过 respPath → 不传键，让后端用已保存规则（结果里会标明"已保存规则"）；
  // 改动过 → 传草稿原文（"" 也照传，那是"整段输出"这一态）。
  probeInvoke(invCfg.respPathDirty ? $("cfgRespPath").value.trim() : undefined);

function probePayloadHtml(ev) {
  const p = ev.request_payload;
  if (p == null) return "";
  // 模板非法时后端回的是渲染后的原文字符串（不是对象）——照原样展示更有助排查。
  const body = typeof p === "string" ? p : JSON.stringify(p, null, 2);
  return `<details><summary>实际发出的请求 payload</summary><pre>${escHtml(body)}</pre></details>`;
}

function probeRawHtml(ev) {
  if (ev.response_raw == null) return "";
  const cut = ev.response_raw_truncated
    ? `<span class="faint">（仅显示前 ${ev.response_raw.length} 字，完整 ${ev.response_bytes ?? "?"} 字节已截断）</span>`
    : "";
  return `<details><summary>原始响应 ${cut}</summary><pre>${escHtml(ev.response_raw)}</pre></details>`;
}

// 一行可选路径。truncated 占位与 is_whole_response 都不是可点的路径。
function pathRowHtml(p, i, curPath) {
  const type = `<span class="pr-type">${escHtml(p.type ?? "")}</span>`;
  const prev = `<span class="pr-prev">${escHtml(p.preview ?? "")}</span>`;
  if (p.type === "truncated") {
    return `<div class="pathrow is-off"><span class="pr-path">${escHtml(p.path ?? "")}</span>
      ${type}${prev}</div>`;
  }
  if (p.is_whole_response) {
    return `<div class="pathrow is-off"><span class="pr-path">${escHtml(p.path ?? "$")}</span>
      ${type}${prev}
      <span class="pr-note">${escHtml(p.note ?? "整个响应就是这个值，提取路径留空即可")}</span></div>`;
  }
  const on = curPath != null && curPath !== "" && p.response_path === curPath;
  return `<button type="button" class="pathrow pr-pick${on ? " is-on" : ""}" data-i="${i}">
    <span class="pr-path">${escHtml(p.path ?? "")}</span>${type}${prev}</button>`;
}

function renderProbeResult(ev) {
  const box = $("invProbeResult");
  const used = ev.response_path_used;          // "" = 不提取；null/undefined = 未取到
  const fromSaved = ev.response_path_from === "saved";
  const head = [
    ev.ok ? badge("ok", "调用成功", "ok") : badge("bad", "未通过", "fail"),
    ev.latency_ms != null ? `<span class="faint">${ev.latency_ms} ms</span>` : "",
    ev.response_bytes != null ? `<span class="faint">${ev.response_bytes} 字节</span>` : "",
    used != null
      ? `<span class="faint">本次提取规则：${used === "" ? "整段响应" : `<code>${escHtml(used)}</code>`}`
        + `${fromSaved ? "（已保存规则）" : "（本次选择）"}</span>`
      : "",
  ].filter(Boolean).join(" ");

  const errHtml = ev.ok ? "" : `<div class="pb-err">${escHtml(ev.error ?? "调用未成功")}</div>`;

  const out = ev.extracted_text
    ? `<div class="pb-out"><div class="pb-out-k">当前规则会取到的最终输出</div>
        <pre>${escHtml(ev.extracted_text)}</pre></div>`
    : "";

  const paths = ev.response_paths ?? [];
  const wholeOn = used === "";
  const pathsHtml = paths.length
    ? `<div class="fieldlabel">从真实响应里选输出位置
         <span class="faint">点一行即用它再验证一次（会再发一次真实调用）</span></div>
       <div class="pathlist">
         <button type="button" class="pathrow pr-whole${wholeOn ? " is-on" : ""}">
           <span class="pr-path">（不提取）</span>
           <span class="pr-type">整段</span>
           <span class="pr-prev">整段响应文本即输出 · 适用于目标直接返回纯文本</span></button>
         ${paths.map((p, i) => pathRowHtml(p, i, used)).join("")}
       </div>
       ${ev.response_paths_truncated
        ? `<div class="faint">响应结构较大，路径列表已截断；若目标路径未列出，可在上方「输出位置」手动填写。</div>`
        : ""}`
    : `<div class="faint">本次未能生成可选路径（响应不是 JSON，或调用未成功）。若目标本来就返回纯文本，把「输出位置」留空即可。</div>`;

  box.innerHTML = `<div class="probebox">
    <div class="pb-head">${head}</div>
    ${errHtml}${out}${pathsHtml}${probePayloadHtml(ev)}${probeRawHtml(ev)}
    <div class="faint">确认无误后点上方「保存配置」，回归 / 红队测试就会按这套规则调用。</div>
  </div>`;
  box.classList.remove("hidden");

  // 点一条路径 → 用它立刻再探测一次（三态里的"传非空"），并写回编辑框
  box.querySelectorAll(".pr-pick").forEach((b) =>
    b.addEventListener("click", () => {
      const p = paths[Number(b.dataset.i)];
      if (!p?.response_path) return;
      $("cfgRespPath").value = p.response_path;
      invCfg.respPathDirty = true;
      probeInvoke(p.response_path, { label: `正在用 ${p.response_path} 再验证一次…` });
    }));
  box.querySelector(".pr-whole")?.addEventListener("click", () => {
    $("cfgRespPath").value = "";
    invCfg.respPathDirty = true;
    probeInvoke("", { label: "正在按「不提取」再验证一次…" });
  });
}

$("cfgSaveBtn").onclick = async () => {
  const name = invCfg.agent;
  if (!name) { toast("请先打开一个 Agent"); return; }
  $("cfgSaveBtn").disabled = true;
  $("cfgStatus").textContent = "保存中…";
  try {
    await apiOne({ action: "set_agent_config", agent_name: name,
      payload_template: $("cfgTemplate").value, response_path: $("cfgRespPath").value },
      "agent_config_set");
    invCfg.respPathDirty = false;   // 草稿已成为"已保存规则"
    $("cfgStatus").textContent = "✓ 已保存";
  } catch (e) { $("cfgStatus").textContent = `✗ ${e.message ?? e}`; }
  finally { $("cfgSaveBtn").disabled = false; }
};

// ---------- 会话抽屉 ----------
function findSession(sid) {
  for (const st of state.currentReport?.stages ?? []) {
    const hit = (st.session_details ?? []).find((s) => s.session_id === sid);
    if (hit) return hit;
  }
  return null;
}

function openDrawer(sessionId, eventN) {
  const s = findSession(sessionId);
  if (!s) { toast(`报告中未找到会话 ${sessionId}`); return; }
  $("drawerTitle").textContent = `${state.currentAgent} · ${sessionId}`;
  const results = Object.entries(s.results ?? {}).map(([k, r]) => `
    <div class="ev-item"><strong>${escHtml(k)}</strong> =
      <span class="score ${r.score != null ? scoreClass(r.score) : "faint"}">${r.errored ? "评估失败" : r.score}</span>
      <pre>${escHtml(String(r.reason ?? ""))}</pre></div>`).join("");
  $("drawerResults").innerHTML = results;
  const tr = s.transcript ?? {};
  if (tr.system_prompt) {
    $("drawerSysPrompt").classList.remove("hidden");
    $("drawerSysPrompt").querySelector("pre").textContent = tr.system_prompt;
  } else $("drawerSysPrompt").classList.add("hidden");
  $("drawerDiag").innerHTML = s.diagnosis ? diagnosisHtml(s.diagnosis) : "";
  // 时间线图标走 sprite：这是「看会话」的核心阅读区，彩色 emoji 在文本流里最跳
  $("drawerTimeline").innerHTML = (tr.events ?? []).map((e) => {
    const hl = eventN && e.n === eventN ? " hl" : "";
    if (e.type === "tool") {
      return `<div class="tl-event${hl}" id="tl-${e.n}"><span class="n">#${e.n}</span>
        <span class="muted">${icon("tool", "ic-sm")}</span>
        <code>${escHtml(e.name)}(${escHtml(JSON.stringify(e.arguments ?? {}).slice(0, 120))})</code>
        ${e.error ? `<span class="s-bad">${icon("fail", "ic-sm")} ${escHtml(e.error)}</span>` : ""}
        ${e.duration_s != null ? `<span class="faint">${e.duration_s}s${e.slow ? ` <span class="s-warn">${icon("warn", "ic-sm")}慢</span>` : ""}</span>` : ""}
        <pre>${escHtml(String(e.result ?? "").slice(0, 600))}</pre></div>`;
    }
    return `<div class="tl-event${hl}" id="tl-${e.n}"><span class="n">#${e.n}</span>
      <span class="${e.type === "user" ? "s-info" : "muted"}">${icon(e.type === "user" ? "user" : "bot", "ic-sm")}</span>
      ${escHtml(String(e.text ?? ""))}</div>`;
  }).join("") || `<p class="muted">无时间线数据</p>`;
  $("drawerMask").classList.remove("hidden");
  $("drawer").classList.remove("hidden");
  // 模态规矩：锁背景滚动、焦点移入抽屉、关闭时还原（closeDrawer 负责）
  drawerLastFocus = document.activeElement;
  document.body.style.overflow = "hidden";
  $("drawer").focus();
  if (eventN) document.getElementById(`tl-${eventN}`)?.scrollIntoView({ block: "center" });
}
let drawerLastFocus = null;

function diagnosisHtml(diag) {
  if (diag.clean) return `<div class="sess-detail s-good">诊断已完成：未发现执行故障（低分源于风格 / 表达层面）</div>`;
  const fails = (diag.failures ?? []).map((f) => `
    <div class="sess-detail"><strong class="s-warn">${icon("warn", "ic-sm")} ${escHtml(String(f.category ?? ""))}</strong>
      <pre>${escHtml(String(f.evidence ?? ""))}</pre></div>`).join("");
  const roots = (diag.root_causes ?? []).map((r) => `
    <div class="sess-detail"><strong>修复类型: ${escHtml(r.fix_type ?? "")}</strong>
      <pre>因果: ${escHtml(r.causality ?? "")}\n影响: ${escHtml(r.impact ?? "")}\n建议: ${escHtml(r.fix_recommendation ?? "")}</pre></div>`).join("");
  return (fails || roots) ? `<h4>诊断</h4>${fails}${roots}` : "";
}

function closeDrawer() {
  $("drawerMask").classList.add("hidden");
  $("drawer").classList.add("hidden");
  document.body.style.overflow = "";
  drawerLastFocus?.focus?.();
  drawerLastFocus = null;
}
$("drawerClose").onclick = closeDrawer;
$("drawerMask").onclick = closeDrawer;

// ============================================================
//  资源库
// ============================================================

async function loadResources() {
  await ensureAgents().catch(() => {});
  await Promise.all([refreshDatasets(), loadMeta(), loadRtOptions()]);
  renderCustomChips();
  // 页级统计条：与工作台 KPI 条 / Agent 页统计条呼应，三页开局节奏一致
  // 内置数与「评估器管理」区口径一致：available + dataset_only（如 correctness）
  $("resStats").textContent =
    `${state.datasets.length} 个数据集 · ${state.custom.length} 个自定义评估器 · ${builtinEvaluators().length} 个内置评估器`;
  // 生成器的 agent 下拉
  const opts = state.agents.filter((a) => a.has_logs)
    .map((a) => `<option>${escHtml(a.agent_name)}</option>`).join("");
  $("dsGenAgent").innerHTML = `<option value="">（可选）目标 Agent，使用其提示词增强生成…</option>` + opts;
  $("rtGenAgent").innerHTML = `<option value="">选择目标 Agent…</option>` +
    state.agents.filter((a) => a.has_logs && a.source !== "langfuse")
      .map((a) => `<option>${escHtml(a.agent_name)}</option>`).join("");
  // 风险类别：复选 chips（替换原生 multiple select——与全站 chips 交互一致）
  if (state.rtOptions) {
    const defs = new Set(state.rtOptions.default_risk_categories ?? []);
    const cats = Object.entries(state.rtOptions.risk_categories ?? {});
    $("rtRiskChips").innerHTML = cats.length
      ? cats.map(([k, v]) => `<label><input type="checkbox" class="rt-risk" value="${escHtml(k)}"
          ${defs.has(k) ? "checked" : ""}>${escHtml(v.label ?? k)}</label>`).join("")
      : `<span class="muted">暂无风险类别（生成时使用默认全集）</span>`;
  }
}

// 内置评估器全集 = available + dataset_only（correctness 等不在 available 里，单独下发）
function builtinEvaluators() {
  return [...state.evaluators, ...state.datasetOnly.filter((n) => !state.evaluators.includes(n))];
}

// 场景区的评估器列表：评估器管理区同一份数据按 scope 过滤后的只读视图（无勾选、无删除）
function renderResourceEvaluators() {
  const roChips = (names) => names.length
    ? names.map((n) => `<span class="chip-ro">${escHtml(n)}</span>`).join("")
    : `<span class="muted">暂无</span>`;
  $("obsEvalChips").innerHTML = roChips(evaluatorsForStage("observe"));
  $("dsEvalChips").innerHTML = roChips(evaluatorsForStage("dataset"));
  const builtins = builtinEvaluators();
  $("builtinChips").innerHTML = builtins.length
    ? builtins.map((n) => `<span class="chip-ro">${escHtml(n)}${state.datasetOnly.includes(n)
        ? `<span class="badge badge-neutral scope-badge">仅回归</span>` : ""}</span>`).join("")
    : `<span class="muted">暂无</span>`;
  $("builtinCount").textContent = builtins.length;
  $("customCount").textContent = state.custom.length;
}

// 「管理评估器 →」：场景区只读列表指回唯一数据源
document.querySelectorAll(".res-go-mgr").forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    $("evalMgrPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    $("newEvalBtn").focus();
  }));

async function loadRtOptions() {
  if (state.rtOptions) return;
  state.rtOptions = await apiOne({ action: "redteam_options" }, "redteam_options");
}

async function refreshDatasets() {
  const ev = await apiOne({ action: "list_datasets" }, "datasets");
  state.datasets = ev.datasets ?? [];
  const cur = $("dsSelect").value;
  $("dsSelect").innerHTML = `<option value="">选择数据集…</option>` +
    state.datasets.map((d) => `<option ${d.name === cur ? "selected" : ""}>${escHtml(d.name)}（${d.case_count}）</option>`).join("");
}

function currentDataset() {
  return state.datasets.find((d) => $("dsSelect").value.startsWith(d.name));
}

$("dsSelect").onchange = () => {
  const d = currentDataset();
  $("dsPreview").innerHTML = d
    ? `<span class="faint">${d.case_count} 条用例 · 更新于 ${d.updated_at ? new Date(d.updated_at * 1000).toISOString().slice(0, 10) : "?"}</span>`
    : "";
};

$("dsNewBtn").onclick = () => {
  $("dsName").value = "";
  $("dsJson").value = "[]";
  enterDsEditor();
};
$("dsEditBtn").onclick = () => {
  const d = currentDataset();
  if (!d) { toast("请先选择数据集"); return; }
  $("dsName").value = d.name;
  $("dsJson").value = JSON.stringify(d.cases, null, 2);
  enterDsEditor();
};
$("dsDeleteBtn").onclick = async () => {
  const d = currentDataset();
  if (!d || !confirm(`确认删除数据集「${d.name}」？引用该数据集的方案环节将失效。`)) return;
  try { await callApi({ action: "delete_dataset", name: d.name }, () => {}); refreshDatasets(); }
  catch (e) { toast(`✗ ${e.message ?? e}`); }
};
$("dsSaveBtn").onclick = async () => {
  const name = $("dsName").value.trim();
  if (!name) { toast("请填写数据集名称"); return; }
  let cases;
  if (dsMode === "form") {
    cases = collectDsFormCases();
    if (!cases) return; // 校验失败已 toast
    $("dsJson").value = JSON.stringify(cases, null, 2);
  } else {
    try { cases = JSON.parse($("dsJson").value); } catch { toast("JSON 格式有误，请检查后重试"); return; }
  }
  try {
    await apiOne({ action: "save_dataset", name, cases }, "dataset_saved");
    $("dsStatus").textContent = "✓ 已保存";
    $("dsEditor").classList.add("hidden");
    refreshDatasets();
  } catch (e) { $("dsStatus").textContent = `✗ ${e.message ?? e}`; }
};
$("dsCancelBtn").onclick = () => {
  $("dsEditor").classList.add("hidden");
  $("dsStatus").textContent = "";
};

// ---------- 表单 / JSON 双模式 ----------
// 数据在两处：表单模式的真相是 DOM 卡片；JSON 模式的真相是 #dsJson。
// 切换时单向同步一次（表单→序列化进 textarea；JSON→parse 后渲染卡片，parse 失败留在 JSON 模式）。
let dsMode = "form";
const escAttr = (s) => escHtml(s).replace(/"/g, "&quot;");

function setDsMode(mode, { force = false } = {}) {
  if (!force && mode === dsMode) return;
  if (mode === "json") {
    // 表单 → JSON：宽松收集（不校验必填，半成品也能带过去）
    $("dsJson").value = JSON.stringify(collectDsFormCases({ lenient: true }), null, 2);
  } else if (!force) {
    // JSON → 表单：先校验，失败则报错并留在 JSON 模式
    let arr;
    try { arr = JSON.parse($("dsJson").value || "[]"); } catch { toast("JSON 格式有误，请修正后再切换到表单编辑"); $("dsModeJson").checked = true; return; }
    if (!Array.isArray(arr)) { toast("JSON 顶层必须是数组，请修正后再切换"); $("dsModeJson").checked = true; return; }
    renderDsForm(arr);
  }
  dsMode = mode;
  $("dsModeForm").checked = mode === "form";
  $("dsModeJson").checked = mode === "json";
  $("dsForm").classList.toggle("hidden", mode !== "form");
  $("dsJson").classList.toggle("hidden", mode !== "json");
  for (const id of ["tplSingleBtn", "tplMultiBtn", "tplImageBtn"])
    $(id).classList.toggle("hidden", mode !== "json");
}
$("dsModeForm").onchange = () => setDsMode("form");
$("dsModeJson").onchange = () => setDsMode("json");

// 三个入口（新建/编辑/AI 生成）都先写 #dsJson，再统一走这里进表单模式
function enterDsEditor() {
  $("dsEditor").classList.remove("hidden");
  syncFormFromJson();
}
function syncFormFromJson() {
  let arr;
  try { arr = JSON.parse($("dsJson").value || "[]"); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  renderDsForm(arr);
  setDsMode("form", { force: true });
}

function dsCaseCard(c, i) {
  // task_description 字段存在（哪怕还没填）即视为多轮——切模式/增删中转不丢勾选态
  const isMulti = c.task_description !== undefined && c.task_description !== null;
  const tools = Array.isArray(c.expected_tools) ? c.expected_tools.join(", ") : (c.expected_tools ?? "");
  return `<div class="dscase" data-idx="${i}">
    <div class="dscase-head">
      <span class="dscase-no">用例 ${i + 1}</span>
      ${isMulti ? `<span class="badge badge-neutral">多轮</span>` : ""}
      <button class="btn danger mini dc-del" title="删除该用例" aria-label="删除用例 ${i + 1}">✕ 删除</button>
    </div>
    <div class="dscase-grid">
      <label>用例名 <span class="req">*</span>
        <input type="text" class="dc-name" value="${escAttr(c.name ?? "")}" placeholder="如 case-refund-1"></label>
      <label>期望调用工具（逗号分隔，可空）
        <input type="text" class="dc-tools" value="${escAttr(tools)}" placeholder="如 get_reservation, compute_baggage"></label>
      <label class="dc-full">用户输入 <span class="req">*</span>
        <textarea rows="2" class="dc-input" placeholder="用户对 Agent 说的第一句话">${escHtml(c.input ?? "")}</textarea></label>
      <label class="dc-full">期望输出（可空，供评估器对照）
        <textarea rows="2" class="dc-expected" placeholder="期望回答包含的要点…">${escHtml(c.expected_output ?? "")}</textarea></label>
    </div>
    <label class="inline dc-multi-toggle">
      <input type="checkbox" class="dc-multi" ${isMulti ? "checked" : ""}> 多轮对话（模拟真实用户）
    </label>
    <div class="dc-multiwrap ${isMulti ? "" : "hidden"}">
      <span class="faint">勾选后由平台扮演用户与 Agent 多轮对话，直到达成任务描述或用完轮次</span>
      <label>任务描述 <span class="req">*</span>
        <textarea rows="2" class="dc-task" placeholder="模拟用户想达成的目标，如：改签到下周五并确认行李额">${escHtml(c.task_description ?? "")}</textarea></label>
      <label>最大轮次
        <input type="number" class="dc-turns" value="${Number(c.max_turns) || 5}" min="1" max="20" style="width:90px"></label>
      <label>用户人设（可空）
        <input type="text" class="dc-persona" value="${escAttr(c.persona ?? "")}" placeholder="如：着急赶飞机、表达简短的商务旅客"></label>
    </div>
    ${c.image_key ? `<div class="dc-imgrow">
      <span class="faint">图片：</span><code class="dc-imgkey">${escHtml(c.image_key)}</code>
      <button class="btn ghost mini dc-imgclear">清除图片</button>
    </div>` : ""}
  </div>`;
}

function renderDsForm(cases) {
  const box = $("dsForm");
  const addBtns = `<div class="controls" style="justify-content:${cases.length ? "flex-start" : "center"}">
      <button class="btn ghost mini" id="dcAddSingle">+ 添加用例</button>
      <button class="btn ghost mini" id="dcAddMulti">+ 添加多轮用例</button>
    </div>`;
  box.innerHTML = cases.length
    ? cases.map(dsCaseCard).join("") + addBtns
    : `<div class="empty"><div>还没有用例——添加第一条，或切到 JSON 编辑批量粘贴</div>${addBtns}</div>`;
  // 事件绑定（重渲染即重绑，无需委托）
  $("dcAddSingle").onclick = () => dsAddCase(false);
  $("dcAddMulti").onclick = () => dsAddCase(true);
  box.querySelectorAll(".dscase").forEach((card) => {
    card.querySelector(".dc-del").onclick = () => {
      const arr = collectDsFormCases({ lenient: true });
      arr.splice(Number(card.dataset.idx), 1);
      renderDsForm(arr);
    };
    card.querySelector(".dc-multi").onchange = (e) => {
      card.querySelector(".dc-multiwrap").classList.toggle("hidden", !e.target.checked);
      const badge = card.querySelector(".dscase-head .badge");
      if (e.target.checked && !badge)
        card.querySelector(".dscase-no").insertAdjacentHTML("afterend", `<span class="badge badge-neutral">多轮</span>`);
      else if (!e.target.checked && badge) badge.remove();
    };
    const clear = card.querySelector(".dc-imgclear");
    if (clear) clear.onclick = () => card.querySelector(".dc-imgrow").remove();
  });
}

function dsAddCase(multi) {
  const arr = collectDsFormCases({ lenient: true });
  arr.push(multi ? { name: "", input: "", task_description: "", max_turns: 5 } : { name: "", input: "" });
  renderDsForm(arr);
  const cards = $("dsForm").querySelectorAll(".dscase");
  cards[cards.length - 1]?.querySelector(".dc-name")?.focus();
}

// DOM 卡片 → cases 数组。lenient=true 时不校验（供切模式/增删中转）；
// 默认严格：跳过全空卡，缺 name/input/多轮缺 task_description 则 toast 并返回 null。
function collectDsFormCases({ lenient = false } = {}) {
  const out = [];
  const cards = [...$("dsForm").querySelectorAll(".dscase")];
  for (const card of cards) {
    const v = (sel) => card.querySelector(sel)?.value.trim() ?? "";
    const multi = card.querySelector(".dc-multi").checked;
    const c = { name: v(".dc-name"), input: v(".dc-input") };
    const expected = v(".dc-expected");
    if (expected) c.expected_output = expected;
    const tools = v(".dc-tools");
    if (tools) c.expected_tools = tools.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (multi) {
      c.task_description = v(".dc-task"); // 允许空串占位——字段存在即代表勾选态
      c.max_turns = Math.min(20, Math.max(1, Number(v(".dc-turns")) || 5));
      const persona = v(".dc-persona");
      if (persona) c.persona = persona;
    }
    const imgEl = card.querySelector(".dc-imgkey");
    if (imgEl) c.image_key = imgEl.textContent;
    const blank = !c.name && !c.input && !expected && !tools && !(multi && c.task_description);
    if (lenient) { out.push(c); continue; }
    if (blank) continue; // 完全空白的卡不算数
    const idx = cards.indexOf(card) + 1; // 用卡片序号报错更直观
    if (!c.name) { toast(`第 ${idx} 条用例缺少用例名`); return null; }
    if (!c.input) { toast(`第 ${idx} 条用例缺少用户输入`); return null; }
    if (multi && !c.task_description) { toast(`第 ${idx} 条用例勾选了多轮，需填写任务描述`); return null; }
    out.push(c);
  }
  return out;
}

const TPL = {
  single: { name: "case-1", input: "用户问题…", expected_output: "期望要点…", expected_tools: ["tool_name"] },
  multi: { name: "case-multi", input: "开场问题…", task_description: "模拟用户的目标…", max_turns: 5, expected_output: "期望最终结果…" },
  image: { name: "case-img", input: "关于这张图的问题…", image_key: "（用上传按钮生成）", expected_output: "期望要点…" },
};
function appendTpl(kind) {
  let arr;
  try { arr = JSON.parse($("dsJson").value || "[]"); } catch { arr = []; }
  arr.push(TPL[kind]);
  $("dsJson").value = JSON.stringify(arr, null, 2);
}
$("tplSingleBtn").onclick = () => appendTpl("single");
$("tplMultiBtn").onclick = () => appendTpl("multi");
$("tplImageBtn").onclick = () => appendTpl("image");

$("dsImgBtn").onclick = () => $("dsCaseImages").click();
$("dsCaseImages").onchange = async () => {
  const files = [...$("dsCaseImages").files];
  for (const f of files) {
    $("dsImageStatus").textContent = `上传 ${f.name}…`;
    const b64 = btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer())));
    try {
      const ev = await apiOne({ action: "upload_case_image", name: f.name, content_base64: b64 },
        "case_image_uploaded");
      $("dsImageStatus").textContent = `✓ ${f.name} → image_key: ${ev.image_key}（请填入用例的 image_key 字段）`;
    } catch (e) { $("dsImageStatus").textContent = `✗ ${e.message ?? e}`; }
  }
};

// AI 生成数据集
$("dsGenBtn").onclick = () => $("dsGenForm").classList.toggle("hidden");
$("dsGenCancelBtn").onclick = () => $("dsGenForm").classList.add("hidden");
$("dsGenFiles").onchange = () =>
  $("dsGenFileList").textContent = [...$("dsGenFiles").files].map((f) => f.name).join(", ");
$("dsGenGoBtn").onclick = async () => {
  $("dsGenGoBtn").disabled = true;
  $("dsGenStatus").textContent = "生成中…（读取材料并由 LLM 起草）";
  try {
    const attachments = [];
    for (const f of [...$("dsGenFiles").files].slice(0, 5)) {
      const b64 = btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer())));
      attachments.push({ name: f.name, content_base64: b64 });
    }
    let out = null;
    await callApi({
      action: "generate_dataset",
      context: $("dsGenContext").value,
      num_cases: Number($("dsGenCount").value) || 10,
      agent_name: $("dsGenAgent").value,
      attachments,
    }, (ev) => {
      if (ev.event === "dataset_generated") out = ev;
      if (ev.event === "error") throw new Error(ev.error);
    });
    if (!out) throw new Error("生成失败");
    const existing = $("dsGenExtend").checked && currentDataset() ? currentDataset().cases : [];
    $("dsName").value = currentDataset()?.name ?? `gen-${new Date().toISOString().slice(0, 10)}`;
    $("dsJson").value = JSON.stringify([...existing, ...(out.cases ?? [])], null, 2);
    enterDsEditor();
    $("dsGenStatus").textContent = `✓ 已生成 ${out.cases?.length ?? 0} 条${(out.attachments ?? []).length ? ` · ${out.attachments.join("；")}` : ""}，请审阅后保存`;
  } catch (e) { $("dsGenStatus").textContent = `✗ ${e.message ?? e}`; }
  finally { $("dsGenGoBtn").disabled = false; }
};

// 自定义评估器（评估器管理区 = 唯一数据源；任何增删后同步刷新场景区过滤视图）
function renderCustomChips() {
  $("customChips").innerHTML = state.custom.length
    ? state.custom.map((e) => `<label title="${escHtml(e.rubric ?? "")}">
        ${escHtml(e.name)} <a href="#" class="ce-del s-bad" data-name="${escHtml(e.name)}" style="text-decoration:none">✕</a></label>`).join("")
    : `<span class="muted">暂无</span>`;
  document.querySelectorAll(".ce-del").forEach((a) =>
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!confirm(`确认删除自定义评估器「${a.dataset.name}」？`)) return;
      try {
        await callApi({ action: "delete_custom_evaluator", name: a.dataset.name }, () => {});
        state.custom = state.custom.filter((c) => c.name !== a.dataset.name);
        renderCustomChips();
      } catch (err) { toast(`✗ ${err.message ?? err}`); }
    }));
  renderResourceEvaluators();
}
const EVAL_TPLS = {
  decomposition: "评估任务分解是否合理：子任务是否覆盖了用户目标、粒度是否恰当、有无遗漏或重复。Score 1.0 if 分解完整且高效；Score 0.0 if 明显遗漏或冗余导致目标未达成。",
  handoff: "评估多步骤/多智能体间的信息传递：上游产出的关键信息是否完整传递到下游。Score 1.0 if 无信息丢失；Score 0.0 if 关键信息在交接中丢失导致错误结果。",
};
$("newEvalBtn").onclick = () => $("newEvalForm").classList.toggle("hidden");
$("cancelEvalBtn").onclick = () => $("newEvalForm").classList.add("hidden");
$("evalTemplate").onchange = () => {
  if (EVAL_TPLS[$("evalTemplate").value]) $("newEvalRubric").value = EVAL_TPLS[$("evalTemplate").value];
};
$("saveEvalBtn").onclick = async () => {
  const name = $("newEvalName").value.trim(), rubric = $("newEvalRubric").value.trim();
  const scope = $("newEvalScope").value || "all";
  if (!name || !rubric) { $("evalFormStatus").textContent = "名称与评分标准均为必填项"; return; }
  try {
    await apiOne({ action: "create_custom_evaluator", name, rubric, scope }, "custom_evaluator_created");
    state.custom.push({ name, rubric, scope });
    renderCustomChips();
    $("newEvalForm").classList.add("hidden");
    $("evalFormStatus").textContent = "";
  } catch (e) { $("evalFormStatus").textContent = `✗ ${e.message ?? e}`; }
};

// 红队用例生成 → 存为数据集
$("rtGenBtn").onclick = async () => {
  const agent = $("rtGenAgent").value;
  if (!agent) { toast("请先选择目标 Agent"); return; }
  const cats = [...document.querySelectorAll(".rt-risk:checked")].map((c) => c.value);
  $("rtGenBtn").disabled = true;
  $("rtGenStatus").textContent = "提取目标上下文并生成攻击用例…";
  try {
    let out = null;
    await callApi({
      action: "generate_redteam_cases", agent_name: agent,
      risk_categories: cats, num_cases: Number($("rtNumCases").value) || 2,
    }, (ev) => {
      if (ev.event === "redteam_gen_progress")
        $("rtGenStatus").textContent = `生成中… ${ev.category ?? ""} ${ev.count ?? ""}`;
      if (ev.event === "redteam_cases_generated") out = ev;
      if (ev.event === "error") throw new Error(ev.error);
    });
    if (!out) throw new Error("未返回用例");
    $("rtGenOut").classList.remove("hidden");
    $("rtCasesJson").value = JSON.stringify(out.cases ?? [], null, 2);
    $("rtSaveName").value = `rt-${agent}`;
    $("rtGenStatus").textContent = `✓ 已生成 ${out.cases?.length ?? 0} 条${out.warning ? ` · ⚠ ${out.warning}` : ""}，请审阅后保存`;
  } catch (e) { $("rtGenStatus").textContent = `✗ ${e.message ?? e}`; }
  finally { $("rtGenBtn").disabled = false; }
};
$("rtSaveBtn").onclick = async () => {
  const name = $("rtSaveName").value.trim();
  if (!name) { toast("请填写用例集名称"); return; }
  let cases;
  try { cases = JSON.parse($("rtCasesJson").value); } catch { toast("JSON 格式有误，请检查后重试"); return; }
  try {
    await apiOne({ action: "save_dataset", name, cases }, "dataset_saved");
    toast(`✓ 已保存用例集「${name}」，可在红队环节引用`);
    refreshDatasets();
  } catch (e) { toast(`✗ ${e.message ?? e}`); }
};

// ============================================================
//  设置
// ============================================================

async function loadSettings() {
  await ensureAgents().catch(() => {});
  loadPrices();
  loadJudgeConfig();
  // Agent 调用模板不在这里：它属于单个 Agent，入口在 Agent 详情页「调用配置」。
}

// ---------- judge 模型配置（Bedrock / OpenAI 兼容端点） ----------
function syncJudgeRows() {
  $("jmOpenaiRow").classList.toggle("hidden", $("jmProvider").value !== "openai");
}
$("jmProvider").onchange = syncJudgeRows;

async function loadJudgeConfig() {
  try {
    const ev = await apiOne({ action: "get_judge_config" }, "judge_config");
    $("jmProvider").value = ev.provider ?? "bedrock";
    $("jmModel").value = ev.model ?? "";
    $("jmBaseUrl").value = ev.base_url ?? "";
    $("jmSecret").value = ev.secret_id ?? "";
    syncJudgeRows();
  } catch (e) { $("jmStatus").textContent = `✗ ${e.message ?? e}`; }
}

$("jmSaveBtn").onclick = async () => {
  $("jmSaveBtn").disabled = true;
  $("jmStatus").textContent = "探测模型可用性…";
  try {
    await apiOne({ action: "set_judge_config", config: {
      provider: $("jmProvider").value, model: $("jmModel").value.trim(),
      base_url: $("jmBaseUrl").value.trim(), secret_id: $("jmSecret").value.trim(),
    }}, "judge_config_saved");
    $("jmStatus").innerHTML = `<span class="s-good">✓ 已保存并探测通过</span>`;
  } catch (e) {
    $("jmStatus").innerHTML = `<span class="s-bad">✗ ${escHtml(e.message ?? e)}</span>`;
  } finally { $("jmSaveBtn").disabled = false; }
};

$("lfAddBtn").onclick = async () => {
  const name = $("lfName").value.trim(), host = $("lfHost").value.trim(),
        secret = $("lfSecret").value.trim();
  if (!name || !host || !secret) { $("lfStatus").textContent = "名称、地址、Secret 名称均为必填项"; return; }
  $("lfAddBtn").disabled = true;
  $("lfStatus").textContent = "校验连接与密钥…";
  try {
    let ok = null;
    await callApi({ action: "register_trace_source", agent_name: name, host,
      secret_id: secret, description: $("lfDesc").value.trim() }, (ev) => {
      if (ev.event === "trace_source_registered") ok = ev;
      if (ev.event === "error") throw new Error(ev.error);
    });
    $("lfStatus").innerHTML = `<span class="s-good">✓ 已接入（该项目现有 ${ok?.traces_total ?? "?"} 条 trace）。
      可在 <a href="#" class="qlink" id="lfGoAgents">Agent 目录</a> 为其新建评估方案。</span>`;
    ["lfName", "lfHost", "lfSecret", "lfDesc"].forEach((id) => $(id).value = "");
    state.agents = [];  // 目录缓存作废，下次进 Agent 页重新拉
    $("lfGoAgents").onclick = (e) => { e.preventDefault(); showView("agents"); loadAgentsView(true); };
  } catch (e) { $("lfStatus").innerHTML = `<span class="s-bad">✗ ${escHtml(e.message ?? e)}</span>`; }
  finally { $("lfAddBtn").disabled = false; }
};

async function loadPrices() {
  try {
    const ev = await apiOne({ action: "prices" }, "prices");
    const rows = Object.entries(ev.prices ?? {}).sort()
      .map(([k, v]) => `<tr><td><code>${escHtml(k)}</code></td>
        <td class="num">${v.input}</td><td class="num">${v.output}</td>
        <td class="muted">${v.source}</td>
        <td>${v.source !== "builtin" ? `<button class="btn danger mini pr-del" data-k="${escHtml(k)}">删除</button>` : ""}</td></tr>`).join("");
    $("priceTable").innerHTML = `<thead><tr><th>模型</th><th class="num">$/1K 入</th><th class="num">$/1K 出</th><th>来源</th><th></th></tr></thead><tbody>${rows}</tbody>`;
    $("priceStatus").textContent = ev.last_sync
      ? `上次自动同步 ${new Date(ev.last_sync.at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC · 更新 ${ev.last_sync.updated_models} 个` : "";
    document.querySelectorAll(".pr-del").forEach((b) =>
      b.addEventListener("click", async () => {
        await callApi({ action: "delete_price", model_key: b.dataset.k }, () => {});
        loadPrices();
      }));
  } catch (e) { $("priceStatus").textContent = `✗ ${e.message ?? e}`; }
}
$("syncPricesBtn").onclick = async () => {
  $("priceStatus").textContent = "同步中…";
  try {
    const ev = await apiOne({ action: "refresh_prices" }, "prices_refreshed");
    $("priceStatus").textContent = `✓ 已更新 ${ev.updated_models} 个模型`;
    loadPrices();
  } catch (e) { $("priceStatus").textContent = `✗ ${e.message ?? e}`; }
};
$("savePriceBtn").onclick = async () => {
  const key = $("priceModel").value.trim();
  if (!key) return;
  try {
    await apiOne({ action: "set_price", model_key: key,
      input: Number($("priceIn").value), output: Number($("priceOut").value) }, "price_set");
    loadPrices();
  } catch (e) { toast(`✗ ${e.message ?? e}`); }
};

$("cacheMgrBtn").onclick = async () => {
  $("cacheStatus").textContent = "加载中…";
  try {
    const ev = await apiOne({ action: "list_cache" }, "cache_scopes");
    $("cacheStatus").textContent = `TTL ${ev.ttl_days} 天`;
    $("cachePanel").innerHTML = (ev.scopes ?? []).length
      ? `<div class="tscroll narrow"><table><thead><tr><th>作用域</th><th class="num">条数</th><th></th></tr></thead><tbody>
        ${ev.scopes.map((s) => `<tr><td><code>${escHtml(s.scope)}</code></td>
          <td class="num">${s.count}</td>
          <td><button class="btn danger mini cache-clear" data-s="${escHtml(s.scope)}">清空</button></td></tr>`).join("")}
        </tbody></table></div>`
      : `<p class="muted">暂无缓存</p>`;
    document.querySelectorAll(".cache-clear").forEach((b) =>
      b.addEventListener("click", async () => {
        await callApi({ action: "clear_cache", scope: b.dataset.s }, () => {});
        $("cacheMgrBtn").click();
      }));
  } catch (e) { $("cacheStatus").textContent = `✗ ${e.message ?? e}`; }
};

// ---------- 启动 ----------
initAuth();
