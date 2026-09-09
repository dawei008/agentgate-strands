// Run 对比抽屉：**只是壳**（宽度 + 出场动画 + 关闭）。
//
// 版面、判据、派生全在 compare/CompareView.tsx —— 独立对比页（#/compare）用的是
// 同一份。这个文件里不许出现任何分桶/口径/措辞：同一对 run 在抽屉和页面读出两个
// 结论，比读出一个错结论更难查。
//
// 玻璃纪律：整壳的玻璃由 .drawer-panel 给（base.css，白名单内），视图内的面一律
// 实心，不新增 backdrop-filter。
import { useRef } from "react";
import Drawer from "../../../components/Drawer";
import { CompareView, type ComparePair, type CompareViewRun } from "./CompareView";

export type { ComparePair } from "./CompareView";

/** 抽屉宽度：两栏并排 + 判分理由左右对照，600px（表单那档）装不下。
 *  Drawer 自己会夹到 92vw，窄屏靠 CSS 把两栏改成上下堆叠。 */
const WIDTH = 880;

export default function CompareDrawer({ pair, runs, onClose }: {
  /** null = 关闭（抽屉保持挂载走出场动画） */
  pair: ComparePair | null;
  /** 运行历史（最新在前，与表格同序）：供 #N 序号与两栏身份 */
  runs: CompareViewRun[];
  onClose: () => void;
}) {
  // 关闭动画期间保留最后一对，避免内容闪空（同 ReportDrawer 的 lastKey）
  const last = useRef<ComparePair | null>(pair);
  if (pair != null) last.current = pair;
  const shown = pair ?? last.current;

  return (
    <Drawer
      open={pair != null}
      onClose={onClose}
      width={WIDTH}
      label="运行对比"
      className="compare-drawer"
      testId="plan-compare-drawer"
    >
      {shown != null && (
        <CompareView
          pair={shown}
          runs={runs}
          onClose={onClose}
          heading={{ title: "运行对比" }}
        />
      )}
    </Drawer>
  );
}
