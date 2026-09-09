// 运行报告抽屉：**只是壳**（宽度 + 出场动画 + 关闭 + 焦点圈禁）。
//
// 版面、判据、派生全在 ReportView.tsx —— 独立报告页（#/report/:runKey）用的是
// 同一份。这个文件里不许出现任何口径/措辞：同一个 run 的报告在抽屉和页面读出
// 两个结论，比读出一个错结论更难查（同 compare/CompareDrawer.tsx 的纪律）。
//
// ⚠️ 报告的**主路是独立页**，不是这个抽屉：内容量决定容器，一张全量表（一行=
// 一个用例/会话/攻击，展开态还有证据链）远超一屏，读几分钟的长文不该关在浮层里
// （用户原话「很多字但只有一半屏幕能看」）。所以运行历史的「查看报告」现在走路由，
// 这个壳当下**没有生产入口**；留着是因为「一份视图两个壳」这件事只有两个壳都在才
// 成立 —— 将来真需要一个「瞥一眼就走」的入口，它是现成的 50 行。
//
// 玻璃纪律：整壳的玻璃由 .drawer-panel 给（base.css，白名单内），视图内的面一律
// 实心，不新增 backdrop-filter。
import { useRef } from "react";
import Drawer from "../../components/Drawer";
import { ReportView } from "./ReportView";
import type { Plan, PlanRunSummary } from "./types";

/**
 * 抽屉宽度：全站最宽的一档。照 `FormDrawer`（600/760 两档命名常量）与
 * `CompareDrawer`（880）的先例给名字 —— 裸数字在四个抽屉之间没法比较，也说不出
 * 「为什么是这个数」。这是内容最长的一个面，此前和「填一个表单」共用 600。
 *
 * ⚠️ 宽度只给结构，不给行长：富余宽度进全量表的两列（行名 / 判定格），长文段落
 * 由 `--rd-measure` 钉住行长（reportview.css）。
 *
 * `Drawer` 自己夹 `maxWidth: 92vw`（components/Drawer.tsx），窄屏自动落回。
 */
const WIDTH = 1080;

export default function ReportDrawer({ runKey, runs, planId, plan, onClose, onNavigate, onCompare }: {
  /** null = 关闭（抽屉保持挂载走 180ms 出场动画） */
  runKey: string | null;
  /** 运行历史（最新在前，与表格同序）：供 #N 序号 / ← → 切换 / Δ 推导 */
  runs: PlanRunSummary[];
  planId: string;
  /** 方案定义（D-5）：环节展示名要判数据集侧别，只有方案定义知道这个环节
   *  指向哪个集合（`stage_summaries` 不带 dataset kind）。缺省 = 退回三类映射。 */
  plan?: Plan | null;
  onClose: () => void;
  onNavigate: (runKey: string) => void;
  /** 「与上次对比」（默认相邻两次）：由宿主承载对比面，这里只透传意图。 */
  onCompare?: (aKey: string, bKey: string) => void;
}) {
  // 关闭动画期间保留最后一个 runKey，避免内容闪空（同 CompareDrawer 的 last）
  const lastKey = useRef<string | null>(runKey);
  if (runKey != null) lastKey.current = runKey;
  const key = runKey ?? lastKey.current;

  return (
    <Drawer
      open={runKey != null}
      onClose={onClose}
      width={WIDTH}
      label="运行报告"
      className="report-drawer"
      testId="report-drawer"
    >
      {/* ← → 切换不在这里挂：它是**视图的行为**（底部那句提示就写在视图里），
          而且要放过 textarea 里的光标移动 —— 判据只该有一份，见 ReportView。 */}
      {key != null && (
        <ReportView
          runKey={key}
          runs={runs}
          planId={planId}
          plan={plan}
          entry="drawer"
          onClose={onClose}
          onNavigate={onNavigate}
          onCompare={onCompare}
        />
      )}
    </Drawer>
  );
}
