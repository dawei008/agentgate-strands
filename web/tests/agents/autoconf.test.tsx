// Agent 详情页自动配置测试（原 agents-pages.test.tsx 的「AgentDetailPage 自动配置」describe，断言零语义改动）。
// 改钉（agent-hub 批）：调用配置住在 ④ 配置 Tab，非当前面板 hidden ⇒ role 查询看不见 ⇒
// 一律以 tab="config" 渲染（断言本身不变）。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expectProseGone } from "../prose";
import { describe, expect, it } from "vitest";
import { sseFrames } from "../../src/mocks/handlers";
import AgentDetailPage from "../../src/pages/AgentDetailPage";
import { autoconfResponse, renderPage, setupAgentsPageHooks, sseResponse, stubFetch } from "./harness";

setupAgentsPageHooks();

// ---------- 自动推断五态（auto_configure_agent） ----------
describe("AgentDetailPage 自动配置", () => {
  /** 渲染 + 等配置加载 + 点「自动配置」 */
  async function clickAutoconf() {
    renderPage(<AgentDetailPage name="support-bot" tab="config" />);
    const btn = await screen.findByTestId("agent-autoconf-btn");
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
  }

  it("主按钮是「自动配置」，原探测保留为「手动探测」文字链且流程不变", async () => {
    const calls = stubFetch();
    renderPage(<AgentDetailPage name="support-bot" tab="config" />);
    const auto = await screen.findByTestId("agent-autoconf-btn");
    expect(auto).toHaveTextContent("自动配置");
    expect(auto).toHaveClass("btn");
    const probe = screen.getByTestId("agent-config-probe");
    expect(probe).toHaveTextContent("手动探测");
    expect(probe).toHaveClass("btn-link");
    // 手动探测仍走既有 probe_agent_invoke
    fireEvent.click(probe);
    await screen.findByTestId("agent-probe-ok");
    expect(calls.some((c) => c.action === "probe_agent_invoke")).toBe(true);
  });

  it("态 saved：绿 ✓ 已自动配置 + 路径 chip + vmeta + 折叠详情 + 改为手动", async () => {
    const calls = stubFetch({
      auto_configure_agent: (p) => autoconfResponse("saved", p),
    });
    await clickAutoconf();
    const box = await screen.findByTestId("autoconf-saved");
    expect(box).toHaveTextContent("已自动配置");
    expect(screen.getByTestId("autoconf-path")).toHaveTextContent("output.message.content.0.text");
    expect(box).toHaveTextContent("置信度高");
    // 依据句只留这一次推断的依据；尾巴「配置已保存，可直接运行测试」对任何结果恒成立 ⇒ 删
    // （prose-sweep 2026-09-03）
    expectProseGone(box, "配置已保存", "可直接运行测试");
    // vmeta mono 行：耗时·字节·尝试·命中模板
    const meta = screen.getByTestId("autoconf-vmeta");
    expect(meta).toHaveTextContent("142 ms");
    expect(meta).toHaveTextContent("1,284 B");
    expect(meta).toHaveTextContent("尝试 1 个模板");
    // 折叠探测详情 + 结论行右端「改为手动」
    expect(screen.getByTestId("autoconf-fold")).toHaveTextContent("查看探测详情");
    expect(screen.getByTestId("autoconf-to-manual")).toHaveTextContent("改为手动");
    // 请求体：action + agent_name
    const call = calls.find((c) => c.action === "auto_configure_agent")!;
    expect(call.agent_name).toBe("support-bot");
  });

  it("态 unchanged：绿 ✓ + 「一致未修改」说明", async () => {
    stubFetch({ auto_configure_agent: (p) => autoconfResponse("unchanged", p) });
    await clickAutoconf();
    const box = await screen.findByTestId("autoconf-unchanged");
    expect(box).toHaveTextContent("已自动配置");
    expect(box).toHaveTextContent("与现有配置一致，未做修改");
    expectProseGone(box, "可直接运行测试");
    expect(screen.getByTestId("autoconf-path")).toHaveTextContent("output.message.content.0.text");
  });

  it("态 candidates：琥珀标题 N 个候选 + 单选卡（路径 mono/预览/长度）+ 手动出口", async () => {
    stubFetch({ auto_configure_agent: (p) => autoconfResponse("candidates", p) });
    await clickAutoconf();
    const box = await screen.findByTestId("autoconf-candidates");
    expect(box).toHaveTextContent("检测到 2 个候选回答字段");
    // 卡片内容：路径 + 预览截断 + 长度
    const c0 = screen.getByTestId("autoconf-cand-0");
    expect(within(c0).getByText("output.answer")).toHaveClass("cpath");
    expect(c0).toHaveTextContent("退改签政策");
    expect(c0).toHaveTextContent("142 字");
    expect(screen.getByTestId("autoconf-cand-1")).toHaveTextContent("output.debug_log");
    // 手动填路径出口 + 未确认提示
    expect(screen.getByTestId("autoconf-cand-manual")).toHaveTextContent("都不对，手动填路径");
    // 改钉（agent-hub 批）：术语七词 —— 「方案」→「评估计划」
    expect(box).toHaveTextContent("未确认前该 Agent 的评估计划不会运行");
    // 副句「多个字段都是较长的文本，无法从字段名和结构判断…选定后即保存，正式运行按它
    // 提取」对任何候选态恒成立 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(box, "无法从字段名", "正式运行按它提取");
  });

  it("态 candidates：预选第一个（带推荐标注），确认发 set_agent_config 带选中路径", async () => {
    const calls = stubFetch({ auto_configure_agent: (p) => autoconfResponse("candidates", p) });
    await clickAutoconf();
    await screen.findByTestId("autoconf-candidates");
    // 预选第一个 + 「推荐」标注只在第一个
    const c0 = screen.getByTestId("autoconf-cand-0");
    expect(c0).toHaveClass("on");
    expect(within(c0).getByRole("radio")).toBeChecked();
    expect(c0).toHaveTextContent("推荐");
    expect(screen.getByTestId("autoconf-cand-1")).not.toHaveTextContent("推荐");
    // 直接确认 → set_agent_config 带预选路径与命中模板
    fireEvent.click(screen.getByTestId("autoconf-cand-confirm"));
    await screen.findByTestId("autoconf-applied");
    const saveCall = calls.find((c) => c.action === "set_agent_config")!;
    expect(saveCall).toMatchObject({
      agent_name: "support-bot",
      payload_template: '{"input": {"query": "{input}"}}',
      response_path: "output.answer",
    });
  });

  it("态 candidates：改选第二个后确认，请求体是第二条路径", async () => {
    const calls = stubFetch({ auto_configure_agent: (p) => autoconfResponse("candidates", p) });
    await clickAutoconf();
    await screen.findByTestId("autoconf-candidates");
    fireEvent.click(within(screen.getByTestId("autoconf-cand-1")).getByRole("radio"));
    expect(screen.getByTestId("autoconf-cand-1")).toHaveClass("on");
    fireEvent.click(screen.getByTestId("autoconf-cand-confirm"));
    await screen.findByTestId("autoconf-applied");
    expect(calls.find((c) => c.action === "set_agent_config")!.response_path).toBe("output.debug_log");
  });

  it("态 confirm_overwrite：对话卡显示原/新路径与原配置来源时间；「更新配置」发 set_agent_config", async () => {
    const calls = stubFetch({ auto_configure_agent: (p) => autoconfResponse("confirm_overwrite", p) });
    await clickAutoconf();
    const box = await screen.findByTestId("autoconf-confirm_overwrite");
    expect(box).toHaveTextContent("是否更新");
    expect(screen.getByTestId("autoconf-ow-current")).toHaveTextContent("result.text");
    expect(screen.getByTestId("autoconf-ow-proposed")).toHaveTextContent("output.message.content.0.text");
    // 原配置的 configured_by / updated_at（fmtTimeUtc）
    const meta = screen.getByTestId("autoconf-ow-meta");
    expect(meta).toHaveTextContent("手动配置");
    expect(meta).toHaveTextContent("2026-08-14 11:02 UTC");
    // 「未确认前不会改动现有配置」对任何覆盖确认恒成立 ⇒ 删（prose-sweep 2026-09-03）
    expectProseGone(meta, "未确认前不会改动");
    // 更新 → set_agent_config 带 proposed 值
    fireEvent.click(screen.getByTestId("autoconf-ow-update"));
    await screen.findByTestId("autoconf-applied");
    // 已保存态的副句「配置已保存到该 Agent，所有引用它的方案下次运行即生效」恒成立 ⇒ 删
    expectProseGone(screen.getByTestId("autoconf-applied"), "下次运行即生效");
    expect(calls.find((c) => c.action === "set_agent_config")!).toMatchObject({
      agent_name: "support-bot",
      payload_template: '{"prompt": "{input}"}',
      response_path: "output.message.content.0.text",
    });
  });

  it("态 confirm_overwrite：「保留原配置」不发 set_agent_config，卡片关闭", async () => {
    const calls = stubFetch({ auto_configure_agent: (p) => autoconfResponse("confirm_overwrite", p) });
    await clickAutoconf();
    await screen.findByTestId("autoconf-confirm_overwrite");
    fireEvent.click(screen.getByTestId("autoconf-ow-keep"));
    await waitFor(() => {
      expect(screen.queryByTestId("autoconf-confirm_overwrite")).toBeNull();
    });
    expect(calls.some((c) => c.action === "set_agent_config")).toBe(false);
  });

  it("态 failed：红 ✗ + error + 已试模板小表格（#/模板/结果/耗时）+ 重试/手动编辑", async () => {
    stubFetch({ auto_configure_agent: (p) => autoconfResponse("failed", p) });
    await clickAutoconf();
    const box = await screen.findByTestId("autoconf-failed");
    expect(box).toHaveTextContent("探测失败");
    expect(screen.getByTestId("autoconf-failed-error"))
      .toHaveTextContent("UpstreamTimeout: no response in 300ms");
    // 已试模板小表格：4 行、模板 mono、失败红、耗时
    const table = screen.getByTestId("autoconf-tried");
    for (const h of ["#", "模板", "结果", "耗时"]) {
      expect(within(table).getByText(h)).toBeInTheDocument();
    }
    const row0 = screen.getByTestId("autoconf-tried-0");
    expect(row0).toHaveTextContent('{"prompt": "{input}"}');
    expect(within(row0).getByText("超时")).toHaveClass("fail");
    expect(row0).toHaveTextContent("318 ms");
    expect(screen.getByTestId("autoconf-tried-3")).toHaveTextContent('{"inputText": "{input}"}');
    // 此前钉的是「建议检查」三条排障清单**在**（含 bedrock-agentcore:InvokeAgentRuntime）
    // —— 对任何失败恒成立 ⇒ 整块删；副句里「说明问题可能不在 payload 结构，更可能是…冷启动」
    // 同理（prose-sweep 2026-09-03）
    expectProseGone(box, "建议检查", "InvokeAgentRuntime", "冷启动", "更可能是目标 Agent");
    expect(screen.getByTestId("autoconf-retry")).toHaveTextContent("重试");
    expect(screen.getByTestId("autoconf-failed-manual")).toHaveTextContent("手动编辑");
  });

  it("进度逐条：每个 autoconf_progress 一行（模板 mono + ✓/✗ + 耗时）", async () => {
    stubFetch({ auto_configure_agent: (p) => autoconfResponse("candidates", p) });
    await clickAutoconf();
    await screen.findByTestId("autoconf-candidates");
    // candidates 假数据两帧进度：第 1 个模板 ✗（HTTP 400）、第 2 个 ✓——折叠详情里可回放
    const fold = screen.getByTestId("autoconf-fold");
    fireEvent.click(within(fold).getByText("查看探测详情"));
    const r0 = within(fold).getByTestId("autoconf-progress-0");
    expect(r0).toHaveTextContent("✗");
    expect(r0).toHaveTextContent('{"prompt": "{input}"}');
    expect(r0).toHaveTextContent("88 ms");
    const r1 = within(fold).getByTestId("autoconf-progress-1");
    expect(r1).toHaveTextContent("✓");
    expect(r1).toHaveTextContent('{"input": {"query": "{input}"}}');
    expect(r1).toHaveTextContent("168 ms");
  });

  it("运行中：heartbeat 阶段显示「探测中…」+ 已到的进度行", async () => {
    // 只回 heartbeat + 一帧进度、不给终态的挂起流
    stubFetch({
      auto_configure_agent: () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseFrames([
              { event: "heartbeat", phase: "auto_configure_agent" },
              { event: "autoconf_progress", agent_name: "support-bot",
                template: '{"prompt": "{input}"}', ok: false, error: "HTTP 400", latency_ms: 90 },
            ])));
            // 不 close：模拟推断进行中
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    });
    await clickAutoconf();
    await waitFor(() => {
      expect(screen.getByTestId("autoconf-probing")).toHaveTextContent("探测中…");
    });
    // 括号「（正在逐个尝试常见 payload 模板真实调用目标 Agent）」是机制讲解 ⇒ 删
    expectProseGone(screen.getByTestId("autoconf-probing"), "逐个尝试");
    // 「探测中…」在 heartbeat 就位，进度行是后一帧才到——只等前者会偶发抓不到进度行
    await screen.findByTestId("autoconf-progress-0");
    expect(screen.getByTestId("autoconf-progress-0")).toHaveTextContent('{"prompt": "{input}"}');
    expect(screen.getByTestId("agent-autoconf-btn")).toBeDisabled();
  });

  it("改为手动：展开手动编辑区并预填推断值", async () => {
    stubFetch({ auto_configure_agent: (p) => autoconfResponse("saved", p) });
    await clickAutoconf();
    await screen.findByTestId("autoconf-saved");
    // 手动编辑区默认折叠
    expect(screen.getByTestId("agent-config-manual")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByTestId("autoconf-to-manual"));
    await waitFor(() => {
      expect(screen.getByTestId("agent-config-manual")).toHaveAttribute("open");
    });
    // 预填推断值（saved 假数据的 template + response_path）
    expect(screen.getByTestId("agent-config-template")).toHaveValue('{"prompt": "{input}"}');
    expect(screen.getByTestId("agent-config-response-path")).toHaveValue("output.message.content.0.text");
  });

  it("配置状态行：configured_by=auto 显示「自动配置」badge + fmtTimeUtc 时间", async () => {
    stubFetch();
    renderPage(<AgentDetailPage name="support-bot" tab="config" />);
    const status = await screen.findByTestId("agent-config-status");
    expect(within(status).getByTestId("agent-config-source")).toHaveTextContent("自动配置");
    expect(within(status).getByTestId("agent-config-source")).toHaveClass("badge", "ok");
    expect(within(status).getByTestId("agent-config-updated")).toHaveTextContent("2026-08-11 09:00 UTC");
  });

  it("配置状态行：configured_by=manual 显示「手动配置」中性 badge；null 不渲染状态行", async () => {
    stubFetch({
      get_agent_config: (p) => sseResponse([{
        event: "agent_config", agent_name: p.agent_name,
        payload_template: "{}", response_path: "", updated_at: 1786705320, configured_by: "manual",
      }]),
    });
    renderPage(<AgentDetailPage name="support-bot" tab="config" />);
    const src = await screen.findByTestId("agent-config-source");
    expect(src).toHaveTextContent("手动配置");
    expect(src).not.toHaveClass("ok");
    expect(screen.getByTestId("agent-config-updated")).toHaveTextContent("2026-08-14 11:02 UTC");
  });

  it("configured_by=null（从未配置）：不渲染来源状态行", async () => {
    stubFetch({
      get_agent_config: (p) => sseResponse([{
        event: "agent_config", agent_name: p.agent_name,
        payload_template: "{}", response_path: "", updated_at: null, configured_by: null,
      }]),
    });
    renderPage(<AgentDetailPage name="support-bot" tab="config" />);
    await screen.findByTestId("agent-autoconf-btn");
    expect(screen.queryByTestId("agent-config-status")).toBeNull();
  });

  it("传输层失败（error 事件）：红结论 + 重试按钮可再次发起", async () => {
    let n = 0;
    const calls = stubFetch({
      auto_configure_agent: (p) => {
        n += 1;
        if (n === 1) {
          return sseResponse([
            { event: "heartbeat", phase: "auto_configure_agent" },
            { event: "error", error: "unknown agent: support-bot" },
          ]);
        }
        return autoconfResponse("saved", p);
      },
    });
    await clickAutoconf();
    const box = await screen.findByTestId("autoconf-transport-failed");
    expect(box).toHaveTextContent("探测失败");
    expect(box).toHaveTextContent("unknown agent: support-bot");
    fireEvent.click(screen.getByTestId("autoconf-retry"));
    await screen.findByTestId("autoconf-saved");
    expect(calls.filter((c) => c.action === "auto_configure_agent").length).toBe(2);
  });

  it("saved 落库后刷新 get_agent_config（invalidate）", async () => {
    const calls = stubFetch({ auto_configure_agent: (p) => autoconfResponse("saved", p) });
    await clickAutoconf();
    await screen.findByTestId("autoconf-saved");
    // 首屏一次 + saved 后 invalidate 重取一次
    await waitFor(() => {
      expect(calls.filter((c) => c.action === "get_agent_config").length).toBeGreaterThanOrEqual(2);
    });
  });
});
