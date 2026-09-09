// ① 调用配置区块：手动模板编辑 + 探测 + 自动推断五态。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiOne, callApi, useApiOne } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { fmtTimeUtc } from "../../../lib/time";
import type {
  AgentAutoconfiguredEvent,
  AgentConfigEvent,
  AgentConfigSetEvent,
  AutoconfProgressEvent,
  InvokeProbedEvent,
} from "../types";
import AutoconfArea, { type AutoconfState } from "./autoconf/AutoconfArea";
import ProbeResult, { type ProbeState } from "./probe/ProbeResult";

export default function ConfigBlock({ name }: { name: string }) {
  const { authed } = useAuth();
  const qc = useQueryClient();
  const [template, setTemplate] = useState("");
  const [responsePath, setResponsePath] = useState("");
  const [probe, setProbe] = useState<ProbeState>({ phase: "idle" });
  const [autoconf, setAutoconf] = useState<AutoconfState>({ phase: "idle" });
  // 手动编辑区默认折叠；「改为手动」「手动填路径」会程序化展开
  const [manualOpen, setManualOpen] = useState(false);
  const loadedFor = useRef<string | null>(null);

  const configQuery = useQuery({
    queryKey: ["agent_config", name],
    queryFn: () =>
      apiOne<AgentConfigEvent>({ action: "get_agent_config", agent_name: name }, "agent_config"),
  });

  // 首次拿到配置时灌入表单（切换 agent 时重灌）
  useEffect(() => {
    if (configQuery.data && loadedFor.current !== name) {
      loadedFor.current = name;
      setTemplate(configQuery.data.payload_template);
      setResponsePath(configQuery.data.response_path);
    }
  }, [configQuery.data, name]);

  const save = useApiOne<AgentConfigSetEvent>("agent_config_set");
  // candidates / confirm_overwrite 经用户确认后的落库（走既有 set_agent_config）
  const apply = useApiOne<AgentConfigSetEvent>("agent_config_set");

  async function runProbe() {
    const startedAt = Date.now();
    setProbe({ phase: "probing", startedAt, lastEventAt: startedAt });
    try {
      let result: InvokeProbedEvent | null = null;
      // response_path 三态：探测时显式传当前输入框的值（"" = 整段文本、
      // 非空 = 按路径提取）。表单里没有「缺省」态——用户看到什么就探测什么。
      await callApi(
        {
          action: "probe_agent_invoke",
          agent_name: name,
          payload_template: template,
          response_path: responsePath,
        },
        (ev) => {
          if (ev.event === "error") throw new Error(String(ev.error));
          if (ev.event === "invoke_probed") result = ev as unknown as InvokeProbedEvent;
          // 任意流式事件（含 heartbeat 帧）：不进 UI 但刷 lastEventAt 养活性行
          setProbe({ phase: "probing", startedAt, lastEventAt: Date.now() });
        },
      );
      if (!result) throw new Error("探测未返回结果（未收到 invoke_probed）");
      setProbe({ phase: "done", result });
    } catch (e) {
      setProbe({ phase: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function runAutoconf() {
    const progress: AutoconfProgressEvent[] = [];
    const startedAt = Date.now();
    setAutoconf({ phase: "running", progress: [], startedAt, lastEventAt: startedAt });
    try {
      let result: AgentAutoconfiguredEvent | null = null;
      await callApi({ action: "auto_configure_agent", agent_name: name }, (ev) => {
        if (ev.event === "error") throw new Error(String(ev.error));
        if (ev.event === "autoconf_progress") {
          progress.push(ev as unknown as AutoconfProgressEvent);
        }
        if (ev.event === "agent_autoconfigured") {
          result = ev as unknown as AgentAutoconfiguredEvent;
        }
        // 任意流式事件（含 heartbeat 帧）：不进 UI 但刷 lastEventAt 养活性行
        setAutoconf({ phase: "running", progress: [...progress], startedAt, lastEventAt: Date.now() });
      });
      if (!result) throw new Error("未收到 agent_autoconfigured（自动配置未返回终态）");
      setAutoconf({ phase: "done", result, progress });
      const r = result as AgentAutoconfiguredEvent;
      if (r.outcome === "saved" || r.outcome === "unchanged") {
        // 后端已落库（或确认一致）——刷新配置状态行（configured_by/updated_at）
        qc.invalidateQueries({ queryKey: ["agent_config", name] });
      }
    } catch (e) {
      setAutoconf({
        phase: "transport_failed",
        error: e instanceof Error ? e.message : String(e),
        progress,
      });
    }
  }

  /** 用户确认后的落库：candidates 单选 / confirm_overwrite 更新 */
  function applyConfig(payloadTemplate: string, path: string) {
    apply.mutate(
      {
        action: "set_agent_config",
        agent_name: name,
        payload_template: payloadTemplate,
        response_path: path,
      },
      {
        onSuccess: () => {
          setTemplate(payloadTemplate);
          setResponsePath(path);
          setAutoconf({ phase: "applied", responsePath: path });
          qc.invalidateQueries({ queryKey: ["agent_config", name] });
        },
      },
    );
  }

  /** 「改为手动」/「手动填路径」：展开手动编辑区，可选预填推断值 */
  function openManual(prefill?: { template?: string; responsePath?: string }) {
    if (prefill?.template != null) setTemplate(prefill.template);
    if (prefill?.responsePath != null) setResponsePath(prefill.responsePath);
    setManualOpen(true);
  }

  const cfg = configQuery.data;

  return (
    <div className="agent-detail-block" data-testid="agent-config-block">
      <h3>调用配置</h3>
      {/* 区块用途说明（「回归测试和红队测试按此配置调用该 Agent；线上评估读取已有
          trace，不使用本配置」）对任何 Agent 恒成立 ⇒ 删（prose-sweep 2026-09-03） */}
      {configQuery.isLoading ? (
        <p className="agent-detail-empty" data-testid="agent-config-loading">加载配置中…</p>
      ) : configQuery.isError ? (
        <p className="agents-error" data-testid="agent-config-error">
          {configQuery.error instanceof Error ? configQuery.error.message : String(configQuery.error)}
        </p>
      ) : (
        <>
          {/* 配置状态行：来源 badge（自动/手动）+ 更新时间 */}
          {cfg?.configured_by && (
            <div className="autoconf-status" data-testid="agent-config-status">
              <span
                className={`badge ${cfg.configured_by === "auto" ? "ok" : ""}`}
                data-testid="agent-config-source"
              >
                <span className="dot" />
                {cfg.configured_by === "auto" ? "自动配置" : "手动配置"}
              </span>
              {cfg.updated_at != null && (
                <span className="autoconf-status-time" data-testid="agent-config-updated">
                  {fmtTimeUtc(cfg.updated_at)}
                </span>
              )}
            </div>
          )}
          <div className="agent-config-actions">
            <button
              className="btn"
              data-testid="agent-autoconf-btn"
              disabled={!authed || autoconf.phase === "running"}
              title={!authed ? "请先登录" : undefined}
              onClick={runAutoconf}
            >
              {autoconf.phase === "running" ? "自动配置中…" : "自动配置"}
            </button>
            {/* 原「探测连通」保留为次级文字链，走既有 probe 流程不动 */}
            <button
              className="btn-link"
              data-testid="agent-config-probe"
              disabled={!authed || probe.phase === "probing"}
              title={!authed ? "请先登录" : undefined}
              onClick={runProbe}
            >
              {probe.phase === "probing" ? "探测中…" : "手动探测"}
            </button>
          </div>
          <AutoconfArea
            state={autoconf}
            applying={apply.isPending}
            applyError={apply.isError ? (apply.error instanceof Error ? apply.error.message : String(apply.error)) : null}
            onApply={applyConfig}
            onRetry={runAutoconf}
            onDismiss={() => setAutoconf({ phase: "idle" })}
            onManual={openManual}
            fallbackTemplate={template}
          />
          <ProbeResult state={probe} />
          {/* 手动编辑区：保留既有流程，默认折叠 */}
          <details
            className="autoconf-manual"
            data-testid="agent-config-manual"
            open={manualOpen}
            onToggle={(e) => setManualOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary data-testid="agent-config-manual-toggle">手动编辑模板</summary>
            <div className="autoconf-manual-body">
              <div className="agent-config-field">
                <label htmlFor="agent-config-template">payload 模板（{"{input}"} 会被替换为用例输入）</label>
                <textarea
                  id="agent-config-template"
                  data-testid="agent-config-template"
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="agent-config-field">
                <label htmlFor="agent-config-response-path">response_path（留空 = 整段响应文本）</label>
                <input
                  id="agent-config-response-path"
                  data-testid="agent-config-response-path"
                  value={responsePath}
                  onChange={(e) => setResponsePath(e.target.value)}
                  spellCheck={false}
                  placeholder="如 output.message.content.0.text"
                />
              </div>
              <div className="agent-config-actions">
                <button
                  className="btn"
                  data-testid="agent-config-save"
                  disabled={!authed || save.isPending}
                  title={!authed ? "请先登录" : undefined}
                  onClick={() =>
                    save.mutate({
                      action: "set_agent_config",
                      agent_name: name,
                      payload_template: template,
                      response_path: responsePath,
                    })
                  }
                >
                  {save.isPending ? "保存中…" : "保存模板"}
                </button>
                {save.isSuccess && (
                  <span className="agent-config-saved" data-testid="agent-config-saved">✓ 已保存</span>
                )}
                {save.isError && (
                  <span className="agents-error" data-testid="agent-config-save-error" style={{ margin: 0 }}>
                    ✗ 保存失败 · {save.error instanceof Error ? save.error.message : String(save.error)}
                  </span>
                )}
              </div>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
