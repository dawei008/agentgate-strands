import { useRef } from "react";

/** 表单脏状态：当前值与初始值浅比较（用户定案：别过度工程）。
    初始值只在首次调用时定格（useRef），后续重渲染不会把「已改过的值」
    误当成新基线——那会让脏确认永远不触发。 */
export function useDirty(values: Record<string, unknown>): boolean {
  const initial = useRef<Record<string, unknown> | null>(null);
  if (initial.current == null) initial.current = { ...values };
  const base = initial.current;
  const keys = new Set([...Object.keys(base), ...Object.keys(values)]);
  for (const k of keys) {
    if (base[k] !== values[k]) return true;
  }
  return false;
}
