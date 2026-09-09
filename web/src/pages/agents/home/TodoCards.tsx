import { navigate } from "../../../router";
import { todoActionLabel, todoHref, todoKicker, todoSeverity } from "./derive";
import type { TodoItem } from "./types";

/**
 * 待处理：动作小卡，每条 = Agent 名 + 事实（后端一句带数字）+ 一个动作
 * （去看 → 该 Agent 详情；运行 → 该计划的运行入口；采纳 → 该 Agent 详情的优化区）。
 * 顺序照后端（观测在前、评估在后）。零条时整节缺席（不写「暂无」）。
 */
export default function TodoCards({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null;
  const enc = encodeURIComponent;
  return (
    <>
      <div className="row-title">
        <h2>待处理 <span className="card-count" data-testid="todo-count">{items.length}</span></h2>
      </div>
      <section className="todo-grid" data-testid="todo-grid">
        {items.map((t, i) => (
          <article
            key={`${t.kind}:${t.agent_name}:${i}`}
            className="card barred todo-card"
            data-severity={todoSeverity(t)}
            data-testid={`todo-${t.agent_name}-${t.kind}`}
          >
            <div className="todo-main">
              <span className="todo-kicker">{todoKicker(t)}</span>
              <div className="todo-line">
                <button
                  type="button"
                  className="agent-link"
                  onClick={() => navigate(`#/agent/${enc(t.agent_name)}`)}
                >
                  {t.agent_name}
                </button>
                <span className="todo-fact">{t.fact}</span>
              </div>
            </div>
            <button
              type="button"
              className="btn ghost mini"
              onClick={() => navigate(todoHref(t))}
              data-testid={`todo-${t.agent_name}-${t.kind}-action`}
            >
              {todoActionLabel(t.action)}
            </button>
          </article>
        ))}
      </section>
    </>
  );
}
