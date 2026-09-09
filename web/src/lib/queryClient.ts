import { QueryClient } from "@tanstack/react-query";

// 模块级单例：auth 过期收口时需要在组件树外 clear() 全部缓存
// （对应旧版「清掉过期缓存——留着会让界面拿旧数据编造事实」）。
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 后端是流式 Lambda，重试语义交给用户显式操作；瞬时网络错误重试 1 次
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
