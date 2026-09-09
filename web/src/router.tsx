import { useEffect, useState, type ReactElement } from "react";
import AgentsPage from "./pages/AgentsPage";
import WorkbenchPage from "./pages/WorkbenchPage";
import EvaluatorsPage from "./pages/resources/EvaluatorsPage";
import DatasetsPage from "./pages/resources/DatasetsPage";
import PlanDetailPage from "./pages/plan/PlanDetailPage";
import PlanEditorPage from "./pages/plan/PlanEditorPage";
import RunDetailPage from "./pages/run/RunDetailPage";
import AgentDetailPage from "./pages/AgentDetailPage";
import BigscreenPage from "./pages/bigscreen/BigscreenPage";
import ComparePage from "./pages/compare/ComparePage";
import ReportPage from "./pages/report/ReportPage";
import ErrorBoundary from "./components/ErrorBoundary";
import { isAgentTab, type AgentTab } from "./pages/agents/detail/hub/tabs";

// ---------- hash 路由 ----------
// #/agents #/workbench #/evaluators #/datasets #/plan/:id #/run/:id[?session=<session_id>[&span=<span_id>]] #/agent/:name
// #/plan/new[?dataset=<name>]（新建编辑器；?dataset 预选数据集环节——入集抽屉「为它建评估计划」带过来）
// #/resources 是旧地址（拆页前的资源库）：解析成评估器页——老书签/旧 index 不许死
// #/report/:runKey（运行报告；参数就是 run_key —— 可加书签、可后退、可分享）
// #/agent/:name[/status|evaluate|optimize|config][?this=<run_key>]（ADR-0016 四 Tab 枢纽；
//   无子段 = ① 现状；?this 只对 optimize 有意义 —— 预选「这一次」）
// #/compare[/:aKey/:bKey]（跨计划 run 对比；两个参数都是 run_key）
// #/bigscreen（监控大屏：无壳布局，不进导航——挂墙场景直接输 URL）
// 默认 #/agents（ADR-0016：首页 = Agent 总览，登录后落这里）。
// 设置不是路由——它是右侧抽屉（见 SettingsDrawer）。

export type Route =
  | { view: "agents" }
  | { view: "workbench" }
  | { view: "evaluators" }
  | { view: "datasets" }
  | { view: "plan"; id: string }
  /** 新建编辑器；`dataset` = `?dataset=<name>` 预选的数据集名（入集抽屉「为它建评估计划」带过来） */
  | { view: "plan-new"; dataset?: string }
  | { view: "plan-edit"; id: string }
  /** 运行详情；`session` = `?session=<session_id>` 会话级深链（报告页问题台账「查看 trace」带过来）；
   *  `span` = `&span=<span_id>` span 级深链（台账 span chip 带过来；只在 session 同在时有意义——
   *  RunDetailPage 在那条会话的 trace 树里找它） */
  | { view: "run"; id: string; session?: string; span?: string }
  /** 运行报告独立页；`id` 是 run_key（自带 "#"，入 URL 必是 %23） */
  | { view: "report"; id: string }
  /** 四 Tab 枢纽；`thisKey` = ③ 优化预选的「这一次」run_key（报告页页脚的门带过来） */
  | { view: "agent"; name: string; tab: AgentTab; thisKey?: string }
  /** 两个 run_key 都可空（"" = 还没选）；顺序由 derive.orderComparePair 定，不由 URL 定 */
  | { view: "compare"; aKey: string; bKey: string }
  | { view: "bigscreen" };

const DEFAULT_HASH = "#/agents";

/**
 * `decodeURIComponent` 的安全版：畸形百分号编码（`%ZZ`、落单的 `%`）会抛
 * URIError，而 parseHash 是在 useState 初值和 hashchange 里调的 —— 抛出去就是
 * **整个应用白屏**（页面级围栏在它下游，罩不住路由解析本身）。粘错一个 URL
 * 不该等于应用挂掉：解不开就当原样字符串用，后面按「找不到这个 run」降级。
 */
function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * hash 内部的查询串：`#/run/<key>?session=…`。**不用 location.search**——hash 路由里
 * `?` 在 `#` 之后，浏览器不会把它放进 search。返回 `[path, query]`；无 `?` 时 query 为 ""。
 * 参数值走同一个 dec：畸形编码不抛（见上），坏参数按「没有这个参数」降级。
 */
function splitQuery(raw: string): [string, string] {
  const qi = raw.indexOf("?");
  return qi >= 0 ? [raw.slice(0, qi), raw.slice(qi + 1)] : [raw, ""];
}
function queryParam(query: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|&)${key}=([^&]*)`).exec(query);
  if (!m || !m[1]) return undefined;
  const v = dec(m[1]);
  return v ? v : undefined;
}

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  const [head, ...rest] = parts;
  const arg = dec(rest.join("/"));
  switch (head) {
    case "agents": return { view: "agents" };
    // 此前靠「认不出就落工作台」的兜底隐式命中；默认落点改成 Agent 后必须显式列出
    case "workbench": return { view: "workbench" };
    case "evaluators": return { view: "evaluators" };
    case "datasets": return { view: "datasets" };
    // 旧地址重定向语义：#/resources 落到评估器页（不保留 resources view）
    case "resources": return { view: "evaluators" };
    case "plan":
      if (rest.length === 1 && splitQuery(rest[0])[0] === "new") {
        // `#/plan/new?dataset=<name>`：入集抽屉带过来的预选数据集；坏值 ⇒ 当没带
        const dataset = queryParam(splitQuery(rest[0])[1], "dataset");
        return dataset ? { view: "plan-new", dataset } : { view: "plan-new" };
      }
      if (rest.length >= 2 && rest[rest.length - 1] === "edit") {
        return { view: "plan-edit", id: dec(rest.slice(0, -1).join("/")) };
      }
      if (arg) return { view: "plan", id: arg };
      break;
    case "run": {
      // `#/run/<run_key>?session=<session_id>`：run_key 经 encodeURIComponent 不含裸 `?`，
      // 所以第一个 `?` 一定是查询串起点；**先切再解**（解后的 run_key 可能含任意字符）。
      const [rawKey, query] = splitQuery(rest.join("/"));
      const id = dec(rawKey);
      if (!id) break;
      const session = queryParam(query, "session");
      const span = queryParam(query, "span");
      // 键只在有值时才挂上：无参数形态与旧路由逐字相同（不多 undefined 键）
      return { view: "run", id, ...(session ? { session } : {}), ...(span ? { span } : {}) };
    }
    // 单参数，所以先拼后解（`dec(rest.join("/"))`）是安全的 —— 没有第二个参数可
    // 错位。run_key 自带 "#"（`<plan_id>#<ts>`）⇒ 链接里必是 %23，这里必须解码。
    case "report": if (arg) return { view: "report", id: arg }; break;
    case "agent": {
      // 末段若是 Tab 名就切下来（Tab 名是四个固定 ASCII 词，编码后的 Agent 名撞不上）；
      // 查询串只认 ?this=，挂在末段之后。名字仍按「先拼后解」（单参数，安全）。
      const seg = [...rest];
      let tab: AgentTab = "status";
      let thisKey: string | undefined;
      const lastRaw = seg[seg.length - 1] ?? "";
      const qi = lastRaw.indexOf("?");
      const last = qi >= 0 ? lastRaw.slice(0, qi) : lastRaw;
      if (seg.length >= 2 && isAgentTab(last)) {
        tab = last;
        if (qi >= 0) {
          const m = /(?:^|&)this=([^&]*)/.exec(lastRaw.slice(qi + 1));
          if (m && m[1]) thisKey = dec(m[1]);
        }
        seg.pop();
      }
      const name = dec(seg.join("/"));
      if (name) return { view: "agent", name, tab, thisKey };
      break;
    }
    case "compare": {
      // ⚠️ **先按 / 切段，再逐段 decode**。上面单参数路由那条 `dec(rest.join("/"))`
      // 是先拼后解，对两个参数会错位：run_key 里若含 %2F，先解成 "/" 再按 "/" 切分
      // 就把一个 key 劈成两半 —— 结果是**另一对 run** 的对比，而不是一个报错。
      // 同形陷阱：run_key 本身自带 "#"（`<plan_id>#<ts>`），入 URL 必是 %23，
      // 所以这里必须解码，不能图省事直接用原串。
      const seg = rest.filter((x) => x !== "");
      if (seg.length >= 2) return { view: "compare", aKey: dec(seg[0]), bKey: dec(seg[1]) };
      return { view: "compare", aKey: "", bKey: "" };
    }
    case "bigscreen": return { view: "bigscreen" };
  }
  // 空 hash / 认不出的地址 → 首页（与 DEFAULT_HASH 同一落点）
  return { view: "agents" };
}

export function navigate(hash: string): void {
  location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    // URL 规范化：空 hash 落到默认路由（不产生历史记录）
    if (!location.hash) history.replaceState({}, "", DEFAULT_HASH);
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function viewOf(route: Route): ReactElement {
  switch (route.view) {
    case "agents": return <AgentsPage />;
    case "evaluators": return <EvaluatorsPage />;
    case "datasets": return <DatasetsPage />;
    case "plan": return <PlanDetailPage id={route.id} />;
    case "plan-new": return <PlanEditorPage dataset={route.dataset} />;
    case "plan-edit": return <PlanEditorPage id={route.id} />;
    case "run": return <RunDetailPage id={route.id} session={route.session} span={route.span} />;
    case "report": return <ReportPage id={route.id} />;
    case "agent": return <AgentDetailPage name={route.name} tab={route.tab} thisKey={route.thisKey} />;
    case "compare": return <ComparePage aKey={route.aKey} bKey={route.bKey} />;
    case "bigscreen": return <BigscreenPage />;
    case "workbench": return <WorkbenchPage />;
  }
}

// 页面级围栏：渲染异常只吃掉 <main> 里的这一页，**顶栏导航保持可用**
// （UI-026：一个字段形态异常把整个应用卸干净，只能刷新）。
// key=route 让换路由时自动复位降级态——否则从坏页跳到好页还是那张降级卡。
export function RouteView({ route }: { route: Route }): ReactElement {
  return (
    <ErrorBoundary
      key={`${route.view}:${
        "id" in route ? route.id
          : "name" in route ? route.name
          // 对比页有两个参数：只拿其中一个当 key，换另一半时降级态不复位
          : "aKey" in route ? `${route.aKey}|${route.bKey}`
          : ""}`}
      scope={`route:${route.view}`}
      testId="route-boundary"
      title="这个页面渲染失败了"
      showHome
    >
      {viewOf(route)}
    </ErrorBoundary>
  );
}
