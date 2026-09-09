// UI-001 语义标题回归：登录后每个主要路由恰好一个 <h1>（PageHeader 页面级
// 标题 h2→h1 后的护栏）。局部标题（设置抽屉等）维持 h2/h3，不制造第二个 h1。
// 独立测试文件，不动现有测试（避免与并行批冲突）；夹具复用 tests/agents/harness。
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AgentDetailPage from "../src/pages/agents/AgentDetailPage";
import AgentsPage from "../src/pages/agents/AgentsPage";
import WorkbenchPage from "../src/pages/workbench/WorkbenchPage";
import { renderPage, setupAgentsPageHooks, stubFetch } from "./agents/harness";

setupAgentsPageHooks();

function expectExactlyOneH1(title: string) {
  const h1s = document.querySelectorAll("h1");
  expect(h1s.length).toBe(1);
  expect(h1s[0]).toHaveClass("viewtitle");
  expect(h1s[0]).toHaveTextContent(title);
  // 页面级标题只有一个层级顶点：不允许再出现别的 .viewtitle
  expect(document.querySelectorAll(".viewtitle").length).toBe(1);
}

describe("页面级标题语义（UI-001）", () => {
  it("评估计划：恰好一个 h1，且是 PageHeader 的 .viewtitle", async () => {
    stubFetch();
    renderPage(<WorkbenchPage />);
    await screen.findByTestId("plans-table");
    expectExactlyOneH1("评估计划");
  });

  it("Agent 列表页：恰好一个 h1", async () => {
    stubFetch();
    renderPage(<AgentsPage />);
    await screen.findByTestId("pagehead");
    expectExactlyOneH1("Agent");
  });

  it("Agent 详情页（二级页，带返回位）：恰好一个 h1", async () => {
    stubFetch();
    renderPage(<AgentDetailPage name="support-bot" />);
    await screen.findByTestId("agent-config-block");
    expectExactlyOneH1("support-bot");
  });
});
