// Agent 详情页测试（原 agents-pages.test.tsx 的「AgentDetailPage 详情页」describe，断言零语义改动）。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expectProseGone } from "../prose";
import { describe, expect, it } from "vitest";
import { sseFrames, AGENT_CONFIG } from "../../src/mocks/handlers";
import AgentDetailPage from "../../src/pages/AgentDetailPage";
import { useSession } from "../../src/stores/session";
import { renderPage, setupAgentsPageHooks, sseResponse, stubFetch } from "./harness";

setupAgentsPageHooks();

// ---------- 详情页 ----------
describe("AgentDetailPage 详情页", () => {
  // 改钉（agent-hub 批）：三个区块仍全部挂载（分住 ② ④ 两个 Tab 面板，非当前面板 hidden）
  it("渲染三个区块：调用配置 / 评估计划 / 运行历史", async () => {
    stubFetch();
    renderPage(<AgentDetailPage name="support-bot" />);
    expect(screen.getByTestId("agent-config-block")).toBeInTheDocument();
    expect(screen.getByTestId("agent-plans-block")).toBeInTheDocument();
    expect(screen.getByTestId("agent-runs-block")).toBeInTheDocument();
    // 配置加载完成后表单灌入已存值
    await waitFor(() => {
      expect(screen.getByTestId("agent-config-template")).toHaveValue(AGENT_CONFIG.payload_template);
    });
    expect(screen.getByTestId("agent-config-response-path")).toHaveValue(AGENT_CONFIG.response_path);
  });

  it("list_plans/list_recent_runs 带 agent_name 过滤，方案行点击跳 #/plan/:id", async () => {
    const calls = stubFetch();
    renderPage(<AgentDetailPage name="support-bot" />);
    const plansTable = await screen.findByTestId("agent-plans-table");
    expect(within(plansTable).getByText("FAQ 周回归")).toBeInTheDocument();
    expect(calls.find((c) => c.action === "list_plans")?.agent_name).toBe("support-bot");
    expect(calls.find((c) => c.action === "list_recent_runs")?.agent_name).toBe("support-bot");
    fireEvent.click(screen.getByTestId("agent-plan-row-plan-aaa111"));
    expect(location.hash).toBe("#/plan/plan-aaa111");
  });

  it("运行记录：状态 badge 语义类 + 分数/耗时格式化", async () => {
    stubFetch();
    renderPage(<AgentDetailPage name="support-bot" />);
    const runsTable = await screen.findByTestId("agent-runs-table");
    const ok = within(runsTable).getByTestId("agent-run-row-plan-aaa111#2026-08-11T09:00:00Z");
    // 状态列改走 runBadge 口径（与方案详情页同一 derive）：completed 有分 → ok badge
    expect(
      within(ok).getByTestId("agent-run-row-plan-aaa111#2026-08-11T09:00:00Z-badge"),
    ).toHaveClass("badge", "ok");
    expect(ok).toHaveTextContent("0.86");
    expect(ok).toHaveTextContent("1m14s");
    const failed = within(runsTable).getByTestId("agent-run-row-plan-bbb222#2026-08-10T21:00:00Z");
    expect(
      within(failed).getByTestId("agent-run-row-plan-bbb222#2026-08-10T21:00:00Z-badge"),
    ).toHaveClass("badge", "bad");
    expect(failed).toHaveTextContent("失败");
  });

  // 口径统一（用户点名过「完成但没分算什么」）：**无 stage_summaries 的老归档**
  // completed 而 score 为空 → 退化路径，中性「完成 · 无可评估数据」。
  // （带 stage_summaries 的新数据按环节判定——见下一条部分失败用例）
  it("运行记录 runBadge 口径：老归档 completed 无分无环节 → 中性「完成 · 无可评估数据」", async () => {
    stubFetch({
      list_recent_runs: () => sseResponse([{
        event: "recent_runs",
        runs: [{
          run_key: "rk-nodata", plan_id: "plan-aaa111", plan_name: "FAQ 周回归",
          agent_name: "support-bot", status: "completed", score: null,
          started_at: "2026-08-12 03:00", duration_s: 5,
        }],
      }]),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    await screen.findByTestId("agent-runs-table");
    const badge = screen.getByTestId("agent-run-row-rk-nodata-badge");
    expect(badge).toHaveTextContent("完成 · 无可评估数据");
    // 中性：不能是绿（ok）也不能是红（bad）
    expect(badge).toHaveClass("badge");
    expect(badge).not.toHaveClass("ok");
    expect(badge).not.toHaveClass("bad");
    // 分数列显示 —
    const row = screen.getByTestId("agent-run-row-rk-nodata");
    expect(row).toHaveTextContent("—");
  });

  // UI-013/UI-025：默认假数据里有纯回归成功 run 与部分失败 run（AGENT_RUNS），
  // Agent 详情的 badge 必须与工作台/方案详情同判
  it("运行记录按环节判定：纯回归成功=完成；红队环节炸了=部分失败", async () => {
    stubFetch();
    renderPage(<AgentDetailPage name="support-bot" />);
    await screen.findByTestId("agent-runs-table");
    // 纯回归（plan-ddd444）：顶层 score null，但 dataset 环节 pass_rate 有值
    const reg = screen.getByTestId("agent-run-row-plan-ddd444#2026-08-21T05:00:00Z-badge");
    expect(reg).toHaveClass("badge", "ok");
    expect(reg).toHaveTextContent("完成");
    expect(reg).not.toHaveTextContent("无可评估数据");
    // 部分失败（plan-eee555）：observe 有结果 + redteam 环节 error
    const part = screen.getByTestId("agent-run-row-plan-eee555#2026-08-21T04:00:00Z-badge");
    expect(part).toHaveClass("badge", "warn");
    expect(part).toHaveTextContent("部分失败 · 红队测试");
  });

  it("探测连通：请求带当前模板与 response_path，流式 heartbeat 后显示成功结果", async () => {
    const calls = stubFetch();
    renderPage(<AgentDetailPage name="support-bot" />);
    await waitFor(() => {
      expect(screen.getByTestId("agent-config-template")).toHaveValue(AGENT_CONFIG.payload_template);
    });
    fireEvent.click(screen.getByTestId("agent-config-probe"));
    await screen.findByTestId("agent-probe-ok");
    expect(screen.getByTestId("agent-probe-extracted")).toHaveTextContent("30 天内可无理由退货。");
    expect(screen.getByTestId("agent-probe-paths")).toHaveTextContent("output.message.content[0].text");
    const probeCall = calls.find((c) => c.action === "probe_agent_invoke")!;
    expect(probeCall.agent_name).toBe("support-bot");
    expect(probeCall.payload_template).toBe(AGENT_CONFIG.payload_template);
    expect(probeCall.response_path).toBe(AGENT_CONFIG.response_path);
  });

  it("探测中显示「探测中…」（heartbeat 阶段）", async () => {
    // 只回 heartbeat、不给终帧的挂起流
    stubFetch({
      probe_agent_invoke: () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              sseFrames([{ event: "heartbeat", phase: "probe_agent_invoke" }])));
            // 不 close：模拟探测进行中
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    await waitFor(() => {
      expect(screen.getByTestId("agent-config-probe")).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId("agent-config-probe"));
    await waitFor(() => {
      expect(screen.getByTestId("agent-probe-status")).toHaveTextContent("探测中…");
    });
    // 括号「（正在真实调用目标 Agent，最长约 45 秒）」是机制讲解 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(screen.getByTestId("agent-probe-status"), "最长约 45 秒", "正在真实调用");
  });

  it("探测收到 error 事件显示失败文案", async () => {
    stubFetch({
      probe_agent_invoke: () => sseResponse([
        { event: "heartbeat", phase: "probe_agent_invoke" },
        { event: "error", error: "unknown agent: support-bot" },
      ]),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    await waitFor(() => {
      expect(screen.getByTestId("agent-config-probe")).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId("agent-config-probe"));
    await waitFor(() => {
      const box = screen.getByTestId("agent-probe-status");
      expect(box).toHaveTextContent("✗ 探测失败");
      expect(box).toHaveTextContent("unknown agent: support-bot");
      // 真实失败必须是红（--bad）；.is-bad 是语义色载体
      expect(box).toHaveClass("is-bad");
      expect(box).not.toHaveClass("is-good");
    });
  });

  it("探测 ok=false（连通但提取失败）展示后端错误说明", async () => {
    stubFetch({
      probe_agent_invoke: () => sseResponse([
        { event: "invoke_probed", agent_name: "support-bot", ok: false,
          error: "response_path='a.b' 在本次响应中取不到值", response_paths: [] },
      ]),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    await waitFor(() => {
      expect(screen.getByTestId("agent-config-probe")).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId("agent-config-probe"));
    const fail = await screen.findByTestId("agent-probe-fail");
    expect(fail).toHaveTextContent("取不到值");
    expect(fail).toHaveTextContent("✗ 探测失败");
    expect(screen.getByTestId("agent-probe-status")).toHaveClass("is-bad");
    // 「建议检查：Agent 是否已部署并可调用、payload 模板…」排障清单对任何失败恒成立 ⇒ 删
    expectProseGone(screen.getByTestId("agent-probe-status"), "建议检查");
  });

  // 此前这里钉的是区块用途说明与探测引导文案**在**（「回归测试和红队测试按此配置调用
  // 该 Agent；线上评估读取已有 trace，不使用本配置」「先探测查看返回结构，再确认取值
  // 路径；返回纯文本时留空即可」）—— 对任何 Agent 恒成立 ⇒ 删（prose-sweep 2026-09-03）
  it("调用配置区块不挂用途说明与探测引导（版面与 title 双无）", async () => {
    stubFetch();
    renderPage(<AgentDetailPage name="support-bot" />);
    await screen.findByTestId("agent-config-response-path");
    expect(screen.queryByTestId("agent-config-caption")).toBeNull();
    expectProseGone(screen.getByTestId("agent-config-block"),
      "按此配置调用", "不使用本配置", "先探测查看返回结构", "返回纯文本时留空即可");
  });

  // ===== 第 8 项：探测结果三态的「颜色必须与语义一致」=====
  // 用户原话「那用红字标它干什么，如果不用改应该显示绿色啊」——点名的是颜色。
  it("态1 纯文本成功：绿色 + 成功语气开头 + 留空说明（不是报错）", async () => {
    stubFetch({
      probe_agent_invoke: () => sseResponse([
        { event: "invoke_probed", agent_name: "support-bot", ok: true, error: null,
          plain_text: true, latency_ms: 806, response_bytes: 42,
          extracted_text: "30 天内可无理由退货。", response_paths: [] },
      ]),
    });
    renderPage(<AgentDetailPage name="support-bot" />);
    await waitFor(() => expect(screen.getByTestId("agent-config-probe")).toBeEnabled());
    fireEvent.click(screen.getByTestId("agent-config-probe"));
    // 「探测中…」占位与终态共用 agent-probe-status testid，只等它会抓到 probing 态（曾偶发红）。
    // 先等只在终态出现的 agent-probe-ok，再取容器断色。
    await screen.findByTestId("agent-probe-ok");
    const box = screen.getByTestId("agent-probe-status");
    // 颜色语义：绿，且绝不能是红
    expect(box).toHaveClass("is-good");
    expect(box).not.toHaveClass("is-bad");
    // 成功语气开头，且不出现旧的误导文案
    expect(screen.getByTestId("agent-probe-ok")).toHaveTextContent("✓ 探测成功 · 该 Agent 返回纯文本");
    expect(box).not.toHaveTextContent("响应不是 JSON");
    expect(box).not.toHaveTextContent("无法生成可选路径");
    expect(box).not.toHaveTextContent("探测失败");
    // 此前钉的是留空说明**在**（「整段文本将作为被评估的输出，response_path 留空即可，
    // 无需改造 Agent」）—— 对任何纯文本 Agent 恒成立 ⇒ 删（prose-sweep 2026-09-03）
    expect(screen.queryByTestId("agent-probe-plaintext-note")).toBeNull();
    expectProseGone(box, "留空即可", "无需改造 Agent");
    expect(box).toHaveTextContent("806 ms");
    expect(box).toHaveTextContent("42 字节");
    expect(screen.getByTestId("agent-probe-extracted")).toHaveTextContent("30 天内可无理由退货。");
    // 纯文本没有可选路径，不该渲染路径列表
    expect(screen.queryByTestId("agent-probe-paths")).toBeNull();
  });

  it("态2 JSON 成功：绿色 + 路径列表供选 + 耗时/字节", async () => {
    stubFetch();
    renderPage(<AgentDetailPage name="support-bot" />);
    await waitFor(() => expect(screen.getByTestId("agent-config-probe")).toBeEnabled());
    fireEvent.click(screen.getByTestId("agent-config-probe"));
    // 同上：等终态专属节点，避免抓到 probing 占位
    await screen.findByTestId("agent-probe-ok");
    const box = screen.getByTestId("agent-probe-status");
    expect(box).toHaveClass("is-good");
    expect(box).not.toHaveClass("is-bad");
    expect(screen.getByTestId("agent-probe-ok")).toHaveTextContent("✓ 探测成功");
    expect(await screen.findByTestId("agent-probe-paths")).toBeInTheDocument();
    // 路径列表标题只留「可选取值路径」；「（确认哪条是最终回答）」是操作说明 ⇒ 删
    expectProseGone(box, "确认哪条是最终回答", "选择实际存放最终回答");
    expect(box).toHaveTextContent("1234 ms");
    expect(box).toHaveTextContent("512 字节");
  });

  it("保存模板：请求体带编辑后的 payload_template/response_path，成功显示已保存", async () => {
    const calls = stubFetch();
    renderPage(<AgentDetailPage name="support-bot" />);
    const tpl = await screen.findByTestId("agent-config-template");
    await waitFor(() => expect(tpl).toHaveValue(AGENT_CONFIG.payload_template));
    fireEvent.change(tpl, { target: { value: '{"q": "{input}"}' } });
    const rp = screen.getByTestId("agent-config-response-path");
    fireEvent.change(rp, { target: { value: "answer.text" } });
    fireEvent.click(screen.getByTestId("agent-config-save"));
    await screen.findByTestId("agent-config-saved");
    const saveCall = calls.find((c) => c.action === "set_agent_config")!;
    expect(saveCall).toMatchObject({
      action: "set_agent_config",
      agent_name: "support-bot",
      payload_template: '{"q": "{input}"}',
      response_path: "answer.text",
    });
  });

  it("未登录：探测与保存均 disabled 且带 title", async () => {
    useSession.setState({ token: null, authed: false, everAuthed: false, authExpired: false });
    stubFetch(); // stub 不校验 token：配置能加载，从而渲染出表单与按钮
    renderPage(<AgentDetailPage name="support-bot" />);
    await waitFor(() => {
      expect(screen.getByTestId("agent-config-template")).toHaveValue(AGENT_CONFIG.payload_template);
    });
    const probeBtn = screen.getByTestId("agent-config-probe");
    const saveBtn = screen.getByTestId("agent-config-save");
    expect(probeBtn).toBeDisabled();
    expect(probeBtn).toHaveAttribute("title", "请先登录");
    expect(saveBtn).toBeDisabled();
    expect(saveBtn).toHaveAttribute("title", "请先登录");
  });
});
