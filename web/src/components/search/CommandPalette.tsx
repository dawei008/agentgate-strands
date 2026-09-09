import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import type { AgentsEvent, PlansEvent } from "../../lib/apiTypes";
import type { DatasetsEvent, EvaluatorsEvent } from "../../pages/resources/types";
import type { AgentsRowsEvent } from "../../pages/agents/types";
import { displayName, isRenamed } from "../../lib/agentName";
import { navigate } from "../../router";
import { Icon } from "../layout/Icons";
import { searchGroups, type SearchGroup, type SearchItem } from "./searchIndex";

// 顶栏「搜索 ⌘K」的命令面板（批 topnav-search）。
// 此前 .tb-search 是 nav-b 单行顶栏带过来的**装饰按钮**：无 onClick，⌘K 只把焦点
// 放到按钮上 —— 用户 2026-09-07 报「agent 页面里搜索按钮不生效」。
//
// 数据源：四组全部走 react-query **已有的缓存键**（["agents"] / ["plans"] /
// ["evaluators"] / ["datasets"]），`enabled: false` = 只读缓存不发请求（与
// TopNav.useRegion 同一手法）。哪一组还没被对应页面拉过，这一组就是空的 ——
// 面板不替页面发请求（任务书硬约束）。
// 匹配 / 分组 / 排序在 searchIndex.ts（纯函数，可单测）。
//
// 浮层纪律（glass-guard）：面板是实心卡（--card-bg + --card-border + --sh-overlay），
// 零 backdrop-filter；遮罩复用 .drawer-mask（纯 rgba 底，不是玻璃）。
// 经 createPortal 挂到 body（同 Drawer：fixed 元素别落在带 transform 的祖先下）。

/** 组标题只准是术语七词里的四个（不许出现「方案 / 工作台 / 资源库」） */
const GROUP_LABEL: Record<SearchGroup, string> = {
  agent: "Agent",
  plan: "评估计划",
  evaluator: "评估器",
  dataset: "数据集",
};

const enc = encodeURIComponent;

export function hrefOf(item: SearchItem): string {
  switch (item.group) {
    case "agent": return `#/agent/${enc(item.key)}/status`;
    case "plan": return `#/plan/${enc(item.key)}`;
    case "evaluator": return "#/evaluators";
    case "dataset": return "#/datasets";
  }
}

/** 只读缓存（不 fetch）：四个键都是各页面自己的 queryFn，这里照抄以满足类型，
 *  但 enabled:false 保证永不执行。 */
function useCachedIndex(): SearchItem[] {
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiOne<AgentsRowsEvent>({ action: "discover" }, "agents"),
    enabled: false,
  });
  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: () => apiOne<PlansEvent>({ action: "list_plans" }, "plans"),
    enabled: false,
  });
  const evaluators = useQuery({
    queryKey: ["evaluators"],
    queryFn: () => apiOne<EvaluatorsEvent>({ action: "evaluators" }, "evaluators"),
    enabled: false,
  });
  const datasets = useQuery({
    queryKey: ["datasets"],
    queryFn: () => apiOne<DatasetsEvent>({ action: "list_datasets" }, "datasets"),
    enabled: false,
  });
  const a = agents.data as AgentsRowsEvent | AgentsEvent | undefined;
  const p = plans.data;
  const e = evaluators.data;
  const d = datasets.data;
  return useMemo<SearchItem[]>(() => {
    const out: SearchItem[] = [];
    for (const ag of a?.agents ?? []) {
      const shown = displayName(ag);
      out.push({
        group: "agent",
        key: ag.agent_name,
        label: shown || ag.agent_name,
        // 改过显示名 ⇒ 原名（关联键）作副标，且两个名字都参与匹配
        sub: isRenamed(ag) ? ag.agent_name : undefined,
        terms: [shown, ag.agent_name],
      });
    }
    for (const pl of p?.plans ?? []) {
      out.push({
        group: "plan",
        key: pl.plan_id,
        label: pl.name || pl.plan_id,
        sub: pl.agent_name || undefined,
        terms: [pl.name, pl.plan_id],
      });
    }
    if (e) {
      const names = new Set<string>([
        ...(e.custom ?? []).map((c) => c.name),
        ...(e.available ?? []),
        ...(e.dataset_only ?? []),
        ...(e.multimodal ?? []),
      ]);
      for (const n of names) {
        out.push({ group: "evaluator", key: n, label: n, terms: [n] });
      }
    }
    for (const ds of d?.datasets ?? []) {
      out.push({ group: "dataset", key: ds.name, label: ds.name, terms: [ds.name] });
    }
    return out;
  }, [a, p, e, d]);
}

export default function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<Element | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const index = useCachedIndex();
  const groups = useMemo(() => searchGroups(index, q), [index, q]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const hasQuery = q.trim() !== "";

  // 打开：清空上次输入、光标归零、聚焦输入框；关闭：焦点还给触发它的元素
  useEffect(() => {
    if (!open) return;
    lastFocus.current = document.activeElement;
    setQ("");
    setCursor(0);
    inputRef.current?.focus();
    return () => {
      (lastFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  // 结果变了光标别越界
  useEffect(() => {
    setCursor((c) => (flat.length === 0 ? 0 : Math.min(c, flat.length - 1)));
  }, [flat.length]);

  // Esc 关闭走 document（与 Drawer 同：portal 里 React 树冒泡照常，但焦点可能在 mask 上）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const go = (item: SearchItem) => {
    navigate(hrefOf(item));
    closeRef.current();
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length) setCursor((c) => (c + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setCursor((c) => (c - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[cursor];
      if (item) go(item);
    }
  };

  if (!open) return null;

  let running = 0;
  return createPortal(
    <>
      <div
        className="drawer-mask open"
        onClick={onClose}
        data-testid="cmdk-mask"
        aria-hidden="true"
      />
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="搜索"
        data-testid="cmdk"
      >
        <div className="cmdk-input-row">
          <Icon name="search" className="ic" />
          <input
            ref={inputRef}
            type="search"
            className="cmdk-input"
            placeholder="输入 Agent、评估计划、评估器或数据集名称"
            value={q}
            onChange={(e) => { setQ(e.target.value); setCursor(0); }}
            onKeyDown={onInputKey}
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="cmdk-list"
            aria-activedescendant={flat[cursor] ? `cmdk-opt-${cursor}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            data-testid="cmdk-input"
          />
          <kbd>Esc</kbd>
        </div>
        {hasQuery && flat.length === 0 && (
          <p className="cmdk-empty" data-testid="cmdk-empty">
            没有匹配的 Agent / 评估计划 / 评估器 / 数据集
          </p>
        )}
        {flat.length > 0 && (
          <ul className="cmdk-list" id="cmdk-list" role="listbox" data-testid="cmdk-list">
            {groups.map((g) => {
              const start = running;
              running += g.items.length;
              return (
                <li key={g.group} className="cmdk-group" role="presentation" data-testid={`cmdk-group-${g.group}`}>
                  <div className="cmdk-group-head" role="presentation">{GROUP_LABEL[g.group]}</div>
                  <ul role="group" aria-label={GROUP_LABEL[g.group]}>
                    {g.items.map((item, i) => {
                      const idx = start + i;
                      const on = idx === cursor;
                      return (
                        <li
                          key={`${item.group}:${item.key}`}
                          id={`cmdk-opt-${idx}`}
                          role="option"
                          aria-selected={on}
                          className={`cmdk-item${on ? " on" : ""}`}
                          onMouseEnter={() => setCursor(idx)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => go(item)}
                          data-testid={`cmdk-item-${item.group}-${item.key}`}
                        >
                          <span className="cmdk-item-label">{item.label}</span>
                          {item.sub && <span className="cmdk-item-sub">{item.sub}</span>}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>,
    document.body,
  );
}
