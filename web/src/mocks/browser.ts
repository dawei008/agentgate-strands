import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

// dev 模式浏览器端 mock（main.tsx 在 import.meta.env.DEV 时启动）
export const worker = setupWorker(...handlers);
