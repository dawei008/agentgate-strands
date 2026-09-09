import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { loadConfig } from "../../lib/config";
import { useVersionStamp } from "../../lib/version";
import { navigate, type Route } from "../../router";
import { Icon } from "./Icons";
import CommandPalette from "../search/CommandPalette";

// 单行顶栏（ADR-0016「舰队级」· 版面契约 .scratch/adr0016-home/variant-b3-nav-b.html，
// 用户 2026-09-03 选定）。替代左侧栏 Sidebar：
//   品牌（门/闸几何 mark + AgentGate）· 主线「Agent」（激活 = 低饱和绿底实心胶囊）
//   · 次级一组「评估计划 · 评估器 · 数据集」竖分隔、降一级
//   · 右侧工具区：⌘K 搜索入口（点击 / ⌘K / Ctrl+K 开命令面板，components/search）/ 环境 chip
//     （prod · <region>）/ 时间窗「近 24h」（本批静态）/ 版本戳（漂移时旁边多一枚
//     「有新版本 … · 点此刷新」chip，不漂移零节点）/ 用户首字母头像。
// 「评估分析」「大屏」不再在导航里 —— 两条路由保留可直达（#/compare/…、#/bigscreen）。
// 术语七词不可变：导航项名字只准是 Agent / 评估计划 / 评估器 / 数据集。

/** 主线一项 */
const PRIMARY = { view: "agents", hash: "#/agents", label: "Agent", testid: "nav-agents" } as const;
/** 次级「评估资产」三项（视觉降一级：.nb-link.sub） */
const SECONDARY = [
  { view: "workbench", hash: "#/workbench", label: "评估计划", testid: "nav-workbench" },
  { view: "evaluators", hash: "#/evaluators", label: "评估器", testid: "nav-evaluators" },
  { view: "datasets", hash: "#/datasets", label: "数据集", testid: "nav-datasets" },
] as const;

type NavView = typeof PRIMARY.view | (typeof SECONDARY)[number]["view"] | null;

/** 详情页在导航上归属其父列表页（plan/run/report → 评估计划，agent → Agent）。
 *  评估分析 / 大屏不在导航里 ⇒ 没有项被点亮（null），不许把「评估计划」顶上去
 *  ——顶栏说你在评估计划、正文是评估分析页，两个都说不清你在哪。 */
export function activeNav(route: Route): NavView {
  switch (route.view) {
    case "agents":
    case "agent": return "agents";
    case "evaluators": return "evaluators";
    case "datasets": return "datasets";
    case "workbench":
    case "plan":
    case "plan-new":
    case "plan-edit":
    case "run":
    case "report": return "workbench";
    default: return null;
  }
}

/**
 * 头像首字母：从会话 access token（Cognito JWT）的 payload 取 `username` /
 * `cognito:username` / `email` 的首字符大写；解不出（非 JWT / 未登录）给 "A"
 * （AgentGate 首字母的中性占位，不冒充某个用户）。纯前端解码，不打网络。
 */
export function userInitial(token: string | null | undefined): string {
  if (!token) return "A";
  const parts = token.split(".");
  if (parts.length < 2) return "A";
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      Array.from(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")))
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join(""),
    );
    const p = JSON.parse(json) as Record<string, unknown>;
    const name = [p.username, p["cognito:username"], p.email, p.sub]
      .find((v) => typeof v === "string" && v.trim()) as string | undefined;
    return name ? name.trim()[0].toUpperCase() : "A";
  } catch {
    return "A";
  }
}

/**
 * 环境 chip 的 region：优先 config.json 的 `region`（部署时由 infra 写入；今天的
 * config.json 还没有这个键 ⇒ undefined），其次 discover 响应里的 `region`
 * （后端 discovery 按当前 AWS 区域扫描，同一份缓存 ["agents"]，不为 chip 多发请求）。
 * 两边都没有 ⇒ 只显示 `prod`，不写死任何区域名。
 */
function useRegion(): string | undefined {
  const [cfgRegion, setCfgRegion] = useState<string | undefined>();
  useEffect(() => {
    let alive = true;
    void loadConfig()
      .then((cfg) => { if (alive && cfg.region) setCfgRegion(cfg.region); })
      .catch(() => { /* config 拉不到时别处已报错；chip 只是少一段 */ });
    return () => { alive = false; };
  }, []);
  // enabled:false = 只读同一条缓存、不触发 fetch（Agent 页自己会拉）
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiOne<{ event: "agents"; region?: string }>({ action: "discover" }, "agents"),
    enabled: false,
  });
  return cfgRegion ?? agents.data?.region ?? undefined;
}

export default function TopNav({
  route,
  onOpenSettings,
}: {
  route: Route;
  onOpenSettings: () => void;
}) {
  const { token } = useAuth();
  const version = useVersionStamp();
  const region = useRegion();
  const active = activeNav(route);
  const [scrolled, setScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // 吸顶后背景加深 + 发丝线：滚过 0 才切类（jsdom 也能测；不依赖 animation-timeline）
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 0);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // ⌘K / Ctrl+K：开命令面板（此前只把焦点放到入口上 —— 按钮本身无 onClick，
  // 是「点了没反应」的装饰件；用户 2026-09-07 报障）。再按一次不关：面板自己管 Esc。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const link = (
    item: { view: NavView; hash: string; label: string; testid: string },
    sub: boolean,
  ) => {
    const on = active === item.view;
    return (
      <button
        key={item.view}
        type="button"
        className={`nb-link${sub ? " sub" : ""}${on ? " on" : ""}`}
        aria-current={on ? "page" : undefined}
        onClick={() => navigate(item.hash)}
        data-testid={item.testid}
      >
        {item.label}
      </button>
    );
  };

  return (
    <header className={`topnav${scrolled ? " scrolled" : ""}`} data-testid="topnav">
      <div className="tb-inner">
        <div className="tb-row">
          <button
            type="button"
            className="brand"
            onClick={() => navigate(PRIMARY.hash)}
            data-testid="brand"
            aria-label="AgentGate"
          >
            <span className="mark"><Icon name="gate" className="ic gate" /></span>
            <span className="word">AgentGate</span>
          </button>

          <div className="nb-group">
            <nav className="nb-nav" aria-label="主导航">
              {link(PRIMARY, false)}
            </nav>
            <span className="nb-sep" aria-hidden="true" />
            <nav className="nb-nav" aria-label="评估资产">
              {SECONDARY.map((item) => link(item, true))}
            </nav>
          </div>

          <div className="tb-tools" data-testid="topnav-tools">
            <button
              type="button"
              className="tb-search"
              aria-label="搜索"
              aria-haspopup="dialog"
              aria-expanded={searchOpen}
              onClick={() => setSearchOpen(true)}
              data-testid="topnav-search"
            >
              <Icon name="search" />
              <span className="tb-search-txt">搜索</span>
              <kbd>⌘K</kbd>
            </button>
            <span className="tb-vsep" aria-hidden="true" />
            <span className="tb-chip tb-env" data-testid="brand-env">
              <span className="dot" aria-hidden="true" />
              {region ? `prod · ${region}` : "prod"}
            </span>
            <span className="tb-chip tb-win" data-testid="topnav-window">近 24h</span>
            {/* 版本戳：现网跑的是哪一版（主显运行时系统发布号，拉不到降级成编译期
                UI 构建号；title 带 Runtime 版本 —— 口径在 lib/version.ts）。
                原住侧栏底部，侧栏撤了随工具区走。 */}
            <span className="tb-version" data-testid="app-version" title={version.title}>
              {version.label}
            </span>
            {/* 版本漂移：这个标签页在跑的字节比现网旧（久开没刷新）。不漂移时**不渲染
                任何节点** —— 顶栏零漂，正常状态下这枚 chip 不占位、不留空盒。
                口径与判定在 lib/version.ts（拉不到身份文件 / dev 无编译期身份都不算漂移）。 */}
            {version.drift ? (
              <button
                type="button"
                className="tb-newver"
                title={`当前页面是 ${version.drift.from}，点击重新加载`}
                onClick={() => location.reload()}
                data-testid="version-drift"
              >
                有新版本 {version.drift.to} · 点此刷新
              </button>
            ) : null}
            <button
              type="button"
              className="tb-avatar"
              aria-label="当前用户"
              onClick={onOpenSettings}
              data-testid="topnav-user"
            >
              {userInitial(token)}
            </button>
          </div>
        </div>
      </div>
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </header>
  );
}
