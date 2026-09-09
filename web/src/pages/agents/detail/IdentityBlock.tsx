// ⓪ 身份区块：显示名 + 版本标签（用户拍板的设计 —— 人工标签替代自动指纹）。
//
// 用户原话：「用户标记不同 runtime 对应 agent 不同版本，需要 agent name /
// version / runtime；默认如果用户不改 agent name 是 agentcore 显示的，允许用户
// 自己在界面修改 —— 避免指纹」。目的：同一个 agent 改进后换了 runtime 再评一次，
// 趋势与对比视图里能分清是哪一版。
//
// ⚠️ 护栏 2（关联键不动）：这里改的是**显示名**，`agent_name` 一律不动 ——
// 方案绑定 / run 归属 / evaltest 会话前缀全按它走。所以区块里把关联键与 runtime
// ARN 原样摆出来：用户得看得见「改的是标签，不是身份」。
// ⚠️ 护栏 1（快照冻结）：这里改的是 Agent 的**当前**标签，历史 run 显示的是它们
// 各自落库时冻结的快照（app/planrun.py:_planrun_item）—— 改这里不会动历史归属，
// 提示语里明说这件事。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiOne, useApiOne } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { shortArn } from "../../../lib/time";
import type { AgentItem, AgentMetaSetEvent, AgentsRowsEvent } from "../types";

/** discover 查询本体：详情页与列表页共用同一个 query key（TanStack 去重，
 *  不多打接口）。显示名/版本标签的**读路径**就是它（后端 overlay 在 discover 上）。 */
function useAgentsQuery() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: () => apiOne<AgentsRowsEvent>({ action: "discover" }, "agents"),
  });
}

/** 这一个 agent 的 discover 行（页头取名/版本 chip 用）；不在册 → undefined。 */
export function useAgentItem(name: string): AgentItem | undefined {
  return useAgentsQuery().data?.agents.find((a) => a.agent_name === name);
}

export default function IdentityBlock({ name }: { name: string }) {
  const { authed } = useAuth();
  const qc = useQueryClient();
  const agentsQuery = useAgentsQuery();
  const agent = agentsQuery.data?.agents.find((a) => a.agent_name === name);
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [versionInput, setVersionInput] = useState("");
  const loadedFor = useRef<string | null>(null);

  // 首次拿到 discover 数据时灌入表单（切换 agent 时重灌）——与 ConfigBlock 同套路。
  // 闸门是 isSuccess 而不是「agent 有值」：不在册的 agent 也要把表单标记成已灌，
  // 否则查询稍后再刷新一次就会把用户刚打的字**覆盖掉**（表单在下方也只在数据
  // 到齐后才渲染，两道一起兜住这个覆盖窗口）。
  useEffect(() => {
    if (agentsQuery.isSuccess && loadedFor.current !== name) {
      loadedFor.current = name;
      setDisplayNameInput(agent?.display_name ?? "");
      setVersionInput(agent?.version_label ?? "");
    }
  }, [agentsQuery.isSuccess, agent, name]);

  const save = useApiOne<AgentMetaSetEvent>("agent_meta_set");

  if (agentsQuery.isLoading) {
    return (
      <div className="agent-detail-block" data-testid="agent-identity-block">
        <h3>身份与版本</h3>
        <p className="agent-detail-empty" data-testid="agent-identity-loading">加载中…</p>
      </div>
    );
  }

  return (
    <div className="agent-detail-block" data-testid="agent-identity-block">
      <h3>身份与版本</h3>
      {/* 区块说明（「显示名与版本标签只用于展示：Agent 名是关联键…」）与版本标签的
          提示（「换了 runtime 就更新一次版本标签：趋势图会…画一条竖线」）对任何 Agent
          恒成立 ⇒ 删（prose-sweep 2026-09-03） */}
      <div className="agent-config-field">
        <label htmlFor="agent-identity-display-name">显示名（留空 = 用 Agent 名）</label>
        <input
          id="agent-identity-display-name"
          data-testid="agent-identity-display-name"
          className="u-input"
          value={displayNameInput}
          onChange={(e) => setDisplayNameInput(e.target.value)}
          placeholder={name}
          spellCheck={false}
        />
      </div>
      <div className="agent-config-field">
        <label htmlFor="agent-identity-version-label">版本标签（如 v1.3 / 2026-08-24）</label>
        <input
          id="agent-identity-version-label"
          data-testid="agent-identity-version-label"
          className="u-input"
          value={versionInput}
          onChange={(e) => setVersionInput(e.target.value)}
          placeholder="未标注"
          spellCheck={false}
        />
      </div>
      {/* 身份三件里不可编辑的两件：关联键与 runtime ARN（原样，mono） */}
      <div className="autoconf-status" data-testid="agent-identity-facts">
        <span className="agent-config-hint" style={{ margin: 0 }}>Agent 名</span>
        <span className="mono" data-testid="agent-identity-key">{name}</span>
        {agent?.runtime_arn ? (
          <>
            <span className="agent-config-hint" style={{ margin: 0 }}>runtime</span>
            <span className="mono" data-testid="agent-identity-arn" title={agent.runtime_arn}>
              {shortArn(agent.runtime_arn)}
            </span>
          </>
        ) : null}
      </div>
      <div className="agent-config-actions">
        <button
          className="btn"
          data-testid="agent-identity-save"
          disabled={!authed || save.isPending}
          title={!authed ? "请先登录" : undefined}
          onClick={() =>
            save.mutate(
              {
                action: "set_agent_meta",
                // 关联键原样上送；后端也只按它定位那一行元数据（护栏 2）
                agent_name: name,
                display_name: displayNameInput,
                version_label: versionInput,
              },
              {
                // discover 是显示名/版本标签的读路径（后端 overlay）——保存后刷新它，
                // 列表页与页头才会跟着换名字
                onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
              },
            )
          }
        >
          {save.isPending ? "保存中…" : "保存"}
        </button>
        {save.isSuccess && (
          <span className="agent-config-saved" data-testid="agent-identity-saved">✓ 已保存</span>
        )}
        {save.isError && (
          <span
            className="agents-error"
            data-testid="agent-identity-error"
            style={{ margin: 0 }}
          >
            ✗ 保存失败 · {save.error instanceof Error ? save.error.message : String(save.error)}
          </span>
        )}
      </div>
    </div>
  );
}
