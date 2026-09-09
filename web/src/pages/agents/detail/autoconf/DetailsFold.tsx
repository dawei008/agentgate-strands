import type { AutoconfProgressEvent } from "../../types";
import ProgressRows from "./ProgressRows";

/** 折叠的探测详情：逐模板进度回放 */
export default function DetailsFold({ progress }: { progress: AutoconfProgressEvent[] }) {
  if (progress.length === 0) return null;
  return (
    <details className="fold" data-testid="autoconf-fold">
      <summary>查看探测详情</summary>
      <div className="foldbody">
        <div className="u-label">逐模板探测结果</div>
        <ProgressRows progress={progress} />
      </div>
    </details>
  );
}
