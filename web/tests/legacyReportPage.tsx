// 旧版报告独立页的**测试壳**（= 05ab33b 之前的 pages/report/ReportPage.tsx 原文，只改了
// import 路径与函数名）。
//
// 为什么留着：报告独立页在批 report-redesign-a 换成了变体 A（评估器 tile + 行 × 评估器
// 矩阵，见 tests/report-page-a.test.tsx），而这一批测试钉的是**共享视图 ReportView**
// （全量表 / 裁决句 / 本次建议 / 页脚）—— 那份视图仍是计划详情报告抽屉（plan/ReportDrawer.tsx）
// 的正文，判据全部还在生效。它们此前借独立页当渲染壳（列表 + 计划两条增强查询 + 版本快照
// 退路），换掉独立页后壳没了，所以把旧壳原样搬到这里，测试文件只改一行 import。
// ⚠️ 不是产品代码：src/ 里没有任何东西 import 它。
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiOne } from "../src/lib/api";
import { navigate } from "../src/router";
import PageHeader from "../src/components/layout/PageHeader";
import { agentTabHash } from "../src/pages/agents/detail/hub/tabs";
import { sortRunsDesc } from "../src/pages/plan/derive";
import { ReportView } from "../src/pages/plan/ReportView";
import type { PlanRunsEvent, PlansEvent } from "../src/pages/plan/types";

export default function LegacyReportPage({ id }: { id: string }) {
  // run_key = `<plan_id>#<ts>`。切前缀而不是再要一个路由参数 —— 同 run 详情页
  // （pages/run/RunDetailPage.tsx）那一份读法，两处不许各写一套。
  const planId = id.split("#")[0];

  // 方案定义：给页头的返回位一个人看得懂的名字，并让报告里的环节展示名能判数据集
  // 侧别（D-5）。与方案页共用 queryKey ["plans"] ⇒ 从方案页点进来直接命中缓存。
  const plansQuery = useQuery({
    queryKey: ["plans"],
    queryFn: () => apiOne<PlansEvent>({ action: "list_plans" }, "plans"),
  });
  // 运行历史：只为 `#N` 序号、← → 切换、与上次对比这三件**增强**。
  // ⚠️ 绝不当渲染闸门：报告本体由 ReportView 自己拉 `get_plan_run`，那才是权威。
  // 拉不到就退化成「没有序号、不能左右切」，而不是整页空白 —— 深链进来时这条
  // 查询与报告本体是两个请求，用它当闸门等于让一个增强决定主内容的生死。
  const runsQuery = useQuery({
    queryKey: ["plan_runs", planId],
    queryFn: () =>
      apiOne<PlanRunsEvent>({ action: "list_plan_runs", plan_id: planId }, "plan_runs"),
  });

  const plan = plansQuery.data?.plans.find((p) => p.plan_id === planId);
  // 序必须与方案详情运行历史表同一个函数产出：`#N` 按数组下标算，两处各排一次
  // 会让同一次运行在两处拿到两个 `#N`。
  const runs = useMemo(() => sortRunsDesc(runsQuery.data?.runs ?? []), [runsQuery.data]);

  // 当前正在看的 run。存本地态而不是每次改 hash：
  // ← → 切换若走 navigate，一是每切一次压一条历史（看了十个 run 要按十次后退才
  // 回得到运行列表，而用户要的是「看完了回运行列表」），二是改 hash 触发
  // hashchange ⇒ 路由重挂载 ⇒ 展开态、滚动位置全丢。
  const [runKey, setRunKey] = useState(id);
  // 路由参数变了（外部链接、后退/前进）就跟上。replaceState 不触发 hashchange，
  // 所以本页自己的切换不会走到这里 —— 这条只服务真正的路由变更。
  useEffect(() => { setRunKey(id); }, [id]);
  // URL 镜像：地址栏里那一串**就是**要发给同事的链接，所以它必须跟着看的那份走。
  useEffect(() => {
    const target = `#/report/${encodeURIComponent(runKey)}`;
    if (window.location.hash !== target) {
      window.history.replaceState(null, "", target);
    }
  }, [runKey]);

  return (
    <section className="rpage" data-testid="page-report">
      {/* 返回位统一走 PageHeader back（全站同形态，同 run 详情页）：
          「看完了回运行列表」这件事不靠浏览器后退独撑 —— 深链进来的同事没有
          可后退的上一页，那时这个链接是他回到方案的唯一出口。 */}
      <PageHeader
        back={{ label: plan?.name ?? planId, to: `#/plan/${encodeURIComponent(planId)}` }}
        title="运行报告"
        meta={<span className="chip mono rpage-key" data-testid="report-head-key">{runKey}</span>}
        testid="report-head"
      />

      {/* ⚠️ 不写 loading / 找不到这个 run 的空态：报告本体的取数在 ReportView 里，
          它自己有加载态与错误原话。本页再摆一张卡，就会出现「两个解释同时在说这
          一页怎么了」，而其中一个必定是猜的（运行历史里没有这条 ≠ 这条不存在：
          list_plan_runs 与 get_plan_run 是两条通路）。 */}
      <div className="card rpage-card" data-testid="report-page-card">
        <ReportView
          runKey={runKey}
          runs={runs}
          planId={planId}
          plan={plan}
          entry="page"
          onNavigate={setRunKey}
          /* 「与上次对比」的门 → 该 Agent 详情 ③ 优化（ADR-0016 决定 5），预选本次为
             「这一次」（?this=<run_key>；③ 自己挑同计划的上一次）。Agent 名来自计划定义；
             计划还没到 / 不在册时退回独立对比页 —— 门不许因为一条增强查询而死。 */
          onCompare={(aKey, bKey) => {
            const agentName = plan?.agent_name;
            navigate(agentName
              ? agentTabHash(agentName, "optimize", bKey)
              : `#/compare/${encodeURIComponent(aKey)}/${encodeURIComponent(bKey)}`);
          }}
        />
      </div>
    </section>
  );
}
