// Agent 身份：显示名 + 版本标签（用户拍板的设计 —— 人工标签替代自动指纹）。
//
// 功能形状：Agent = 显示名 + 版本标签 + runtime。显示名默认 = AgentCore discovery
// 的名字，版本标签默认 = runtime version（读得到就填），两者在详情页可编辑。
//
// 本文件钉 **护栏 2（关联键不动）** 的前端一侧：界面编辑的是显示名，`agent_name`
// 是关联键（方案绑定 / run 归属 / evaltest 会话前缀）—— 改显示名之后
//   · 列表行的 testid / 跳转 hash / 请求参数一律仍是 agent_name；
//   · 原名在界面上**看得见**（用户得能对照关联键，否则改完名字就找不到自己的
//     方案属于谁）。
// 全 UI 显示处只许走 lib/agentName.displayName 一个入口（散装三元会漂）。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expectProseGone } from "../prose";
import { describe, expect, it } from "vitest";
import { displayName, isRenamed } from "../../src/lib/agentName";
import AgentDetailPage from "../../src/pages/agents/AgentDetailPage";
import AgentsPage from "../../src/pages/agents/AgentsPage";
import { AGENTS } from "../../src/mocks/handlers";
import { renderPage, setupAgentsPageHooks, sseResponse, stubFetch } from "./harness";

setupAgentsPageHooks();

const ARN = AGENTS[0].runtime_arn;

/** discover 一行的真形态：后端 catalog.apply_agent_meta 让**每一行**都带这两个
 *  键（没标注过就是空串），所以前端不用判 undefined。 */
function agentRow(over: Record<string, unknown> = {}) {
  return { ...AGENTS[0], display_name: "", version_label: "", ...over };
}

function discoverStub(agents: Record<string, unknown>[]) {
  return () => sseResponse([{
    event: "agents", region: "us-west-2", agents, from_cache: true,
    refreshed_at: 1786780500,
  }]);
}

// ==================== 取名函数（唯一入口） ====================
describe("displayName 取名函数", () => {
  it("有显示名用显示名，没有就用原名", () => {
    expect(displayName({ agent_name: "support-bot", display_name: "客服机器人" }))
      .toBe("客服机器人");
    expect(displayName({ agent_name: "support-bot", display_name: "" })).toBe("support-bot");
    expect(displayName({ agent_name: "support-bot" })).toBe("support-bot");
    expect(displayName({ agent_name: "support-bot", display_name: null }))
      .toBe("support-bot");
  });

  it("只有空白的显示名等于没标注（不许渲染出一个空名字）", () => {
    expect(displayName({ agent_name: "support-bot", display_name: "   " }))
      .toBe("support-bot");
  });

  it("agent 缺失时返回空串，不抛（列表在途/行被删都会走到）", () => {
    expect(displayName(null)).toBe("");
    expect(displayName(undefined)).toBe("");
  });

  it("isRenamed：只有显示名与原名**不同**时才为真（要不要显示关联键靠它）", () => {
    expect(isRenamed({ agent_name: "support-bot", display_name: "客服机器人" })).toBe(true);
    expect(isRenamed({ agent_name: "support-bot", display_name: "support-bot" })).toBe(false);
    expect(isRenamed({ agent_name: "support-bot", display_name: "" })).toBe(false);
    expect(isRenamed(null)).toBe(false);
  });
});

// ==================== 首页 Agent 卡 ====================
// 2026-09-03 ADR-0016：列表页从表格改成首页卡片。原钉 agent-row-<name>-link / -key / -version
// 改钉 agent-card-<name>-name / -key / -version（语义不变）；「搜索按原名/显示名命中」两条随
// 搜索框撤除（顶栏 ⌘K 搜索是后续能力）而删。夹具至少两台：单台会触发「直落详情」规则。
const OTHER = { ...AGENTS[1], display_name: "", version_label: "" };

describe("首页 Agent 卡的显示名", () => {
  it("卡头名走显示名，原名（关联键）在旁边看得见", async () => {
    stubFetch({ discover: discoverStub([agentRow({ display_name: "客服机器人" }), OTHER]) });
    renderPage(<AgentsPage />);
    // 锚点挑本用例的目标数据：显示名那颗按钮
    const link = await screen.findByTestId("agent-card-support-bot-name");
    expect(link).toHaveTextContent("客服机器人");
    expect(screen.getByTestId("agent-card-support-bot-key")).toHaveTextContent("support-bot");
  });

  it("护栏 2：改了显示名，testid / 跳转 hash 仍是 agent_name", async () => {
    stubFetch({ discover: discoverStub([agentRow({ display_name: "客服机器人" }), OTHER]) });
    renderPage(<AgentsPage />);
    fireEvent.click(await screen.findByTestId("agent-card-support-bot-name"));
    expect(location.hash).toBe("#/agent/support-bot");
  });

  it("没标注显示名：卡头仍是原名，且不多画关联键", async () => {
    stubFetch({ discover: discoverStub([agentRow(), OTHER]) });
    renderPage(<AgentsPage />);
    const link = await screen.findByTestId("agent-card-support-bot-name");
    expect(link).toHaveTextContent("support-bot");
    expect(screen.queryByTestId("agent-card-support-bot-key")).toBeNull();
  });

  it("版本标签有值才出（没标注 = 不画，绝不画一个空标签）", async () => {
    stubFetch({ discover: discoverStub([agentRow({ version_label: "v1.3" }), OTHER]) });
    renderPage(<AgentsPage />);
    expect(await screen.findByTestId("agent-card-support-bot-version"))
      .toHaveTextContent("v1.3");
  });

  it("版本标签为空：不出", async () => {
    stubFetch({ discover: discoverStub([agentRow(), OTHER]) });
    renderPage(<AgentsPage />);
    await screen.findByTestId("agent-card-support-bot-name");
    expect(screen.queryByTestId("agent-card-support-bot-version")).toBeNull();
  });
});

// ==================== 详情页编辑 ====================
describe("Agent 详情页：显示名 / 版本标签编辑", () => {
  it("两个字段预填当前值，关联键原样显示", async () => {
    stubFetch({
      discover: discoverStub([agentRow({ display_name: "客服机器人", version_label: "v1.3" })]),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    await waitFor(() => {
      expect(screen.getByTestId("agent-identity-display-name")).toHaveValue("客服机器人");
    });
    expect(screen.getByTestId("agent-identity-version-label")).toHaveValue("v1.3");
    // 关联键：改显示名不动它，原名照样在场
    expect(screen.getByTestId("agent-identity-key")).toHaveTextContent("support-bot");
    // 区块说明（「显示名与版本标签只用于展示：Agent 名是关联键…」）、版本标签提示
    // （「…趋势图会在版本变化处画一条竖线」）与标签括号「（关联键）」对任何 Agent 恒成立
    // ⇒ 删（prose-sweep 2026-09-03）
    expect(screen.queryByTestId("agent-identity-caption")).toBeNull();
    expectProseGone(screen.getByTestId("agent-identity-block"), "只用于展示", "画一条竖线", "关联键");
  });

  it("保存发 set_agent_meta，带 agent_name + 两个字段", async () => {
    const calls = stubFetch({
      discover: discoverStub([agentRow()]),
      set_agent_meta: (p) => sseResponse([{
        event: "agent_meta_set", agent_name: p.agent_name,
        display_name: p.display_name, version_label: p.version_label,
        updated_at: 1787000000,
      }]),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    const nameInput = await screen.findByTestId("agent-identity-display-name");
    fireEvent.change(nameInput, { target: { value: "客服机器人" } });
    fireEvent.change(screen.getByTestId("agent-identity-version-label"),
      { target: { value: "v1.4" } });
    fireEvent.click(screen.getByTestId("agent-identity-save"));
    await screen.findByTestId("agent-identity-saved");
    const sent = calls.find((c) => c.action === "set_agent_meta");
    expect(sent).toMatchObject({
      action: "set_agent_meta", agent_name: "support-bot",
      display_name: "客服机器人", version_label: "v1.4",
    });
  });

  it("护栏 2：请求体里没有任何改 agent_name 的字段", async () => {
    const calls = stubFetch({
      discover: discoverStub([agentRow()]),
      set_agent_meta: (p) => sseResponse([{
        event: "agent_meta_set", agent_name: p.agent_name,
        display_name: p.display_name, version_label: p.version_label,
        updated_at: 1787000000,
      }]),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    fireEvent.change(await screen.findByTestId("agent-identity-display-name"),
      { target: { value: "客服机器人" } });
    fireEvent.click(screen.getByTestId("agent-identity-save"));
    await screen.findByTestId("agent-identity-saved");
    const sent = calls.find((c) => c.action === "set_agent_meta")!;
    expect(sent.agent_name).toBe("support-bot");
    expect(Object.keys(sent).sort()).toEqual(
      ["action", "agent_name", "display_name", "version_label"]);
  });

  it("保存失败照实说，不假装成功", async () => {
    stubFetch({
      discover: discoverStub([agentRow()]),
      set_agent_meta: () => sseResponse([{ event: "error", error: "DDB 限流" }]),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    fireEvent.change(await screen.findByTestId("agent-identity-display-name"),
      { target: { value: "客服机器人" } });
    fireEvent.click(screen.getByTestId("agent-identity-save"));
    expect(await screen.findByTestId("agent-identity-error")).toHaveTextContent("DDB 限流");
    expect(screen.queryByTestId("agent-identity-saved")).toBeNull();
  });

  it("未登录不给保存（写路径与其它区块同刑）", async () => {
    stubFetch({ discover: discoverStub([agentRow()]) });
    const { useSession } = await import("../../src/stores/session");
    useSession.setState({ token: null, authed: false });
    renderPage(<AgentDetailPage name="support-bot" />);
    expect(await screen.findByTestId("agent-identity-save")).toBeDisabled();
  });

  it("页头标题走显示名，版本 chip 在标题旁（h1 仍只有一个）", async () => {
    stubFetch({
      discover: discoverStub([agentRow({ display_name: "客服机器人", version_label: "v1.3" })]),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    await waitFor(() => {
      expect(within(screen.getByTestId("pagehead")).getByText("客服机器人"))
        .toBeInTheDocument();
    });
    expect(screen.getByTestId("agent-head-version")).toHaveTextContent("v1.3");
    expect(document.querySelectorAll("h1").length).toBe(1);
  });

  it("discover 还没到 / agent 不在册：标题退回原名，不白屏", async () => {
    stubFetch({ discover: discoverStub([]) });
    renderPage(<AgentDetailPage name="support-bot" />);
    await screen.findByTestId("agent-config-block");
    expect(within(screen.getByTestId("pagehead")).getByText("support-bot"))
      .toBeInTheDocument();
    expect(screen.queryByTestId("agent-head-version")).toBeNull();
  });

  it("ARN 与关联键都在场：用户能确认「这是哪个 runtime 的哪一版」", async () => {
    stubFetch({
      discover: discoverStub([agentRow({ display_name: "客服机器人", version_label: "v1.3" })]),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    // 锚点挑本用例的目标数据（ARN 那一格），不拿区块外壳当门槛 ——
    // 外壳在 discover 还没到时就已经在 DOM 里了
    expect(await screen.findByTestId("agent-identity-arn"))
      .toHaveTextContent("runtime/support-bot-abc123");
    const block = screen.getByTestId("agent-identity-block");
    expect(block).toHaveTextContent("support-bot");
    expect(String(ARN)).toContain("runtime/support-bot-abc123");
  });
});
