import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import Shell from "./components/layout/Shell";
import ErrorBoundary from "./components/ErrorBoundary";

// 应用根围栏（UI-026）：React 的渲染异常若无边界会一路冒泡到根并**卸载整棵树**
// ——线上表现就是 <main> 消失、body 只剩空 root、只能刷新。这里是最后一道，
// 兜住连页面级围栏都没能覆盖的位置（壳/侧栏/登录门本身）。
// 细粒度围栏在 router.tsx（按路由）与 RunDetailPage（按栏/按环节）。
export default function App() {
  return (
    <ErrorBoundary scope="app-root" testId="app-boundary" title="应用渲染失败">
      <QueryClientProvider client={queryClient}>
        <Shell />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
