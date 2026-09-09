// 评估器页（#/evaluators）：评估器表格 + 新建/编辑抽屉（原资源库上块，2026-08-29 拆页）。
// 结构按已批准原型 ui-prototypes/resource-library/index.html，样式一律 ui.css 组件类。
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import type { CustomEvaluator, EvaluatorsEvent } from "./types";
import { parseRubric, scopeLabel, scopesToLabel } from "./rubric";
import { fmtTime } from "../../lib/time";
import EvaluatorForm from "./EvaluatorForm";
import FormDrawer from "./FormDrawer";
import ConfirmCard from "../../components/ConfirmCard";
import { EMPTY_MARK } from "../../lib/renderText";
import "./resources.css";
import PageHeader from "../../components/layout/PageHeader";
import EvaluatorUsage from "./EvaluatorUsage";

// 用户裁定（2026-08-31）：默认全列，超过 100 个才分页
const PAGE_SIZE = 100;
type EvalFilter = "all" | "builtin" | "custom";

/** 表格行的统一视图模型：自定义在前（updated_at 倒序），内置在后 */
interface EvalRow {
  name: string;
  type: "builtin" | "custom";
  scopeLabel: string;
  /** 描述列显示文本（全文上屏，列内自然折行）；null ⇒ 「—」，不编 */
  description: string | null;
  updatedAt: number | null;
  custom?: CustomEvaluator;
}

/** 自定义评估器的描述：优先 blocks.goal（评估目标）；无 blocks 的老评估器
 *  过 parseRubric 拆评估目标 —— 直接取 rubric 首行会抓到 `1.0 完全符合…`
 *  这种**档位行**（松散形态的 rubric 常以档位开头，档位是判定条件不是描述，
 *  现网 brand_tone 实拍踩到）。三档：
 *    拆得出且有目标 → 用目标；
 *    拆得出但目标为空（纯档位 rubric）→ null ⇒ 「—」—— 这份 rubric 里**没有**
 *      描述性文字，拿档位行凑数就是把判定条件冒充简介；
 *    拆不出（纯散文，一个档位都没有）→ 退首行。
 *  全文上屏不截断（用户 2026-08-31：描述要看得全）；文字已全量可见 ⇒ 不挂 title。 */
function customDescription(c: CustomEvaluator): string | null {
  const goal = c.blocks?.goal?.trim();
  if (goal) return goal;
  const parsed = parseRubric(c.rubric ?? "");
  const line = parsed
    ? (parsed.goal ?? "").trim()
    : ((c.rubric ?? "").split("\n")[0]?.trim() ?? "");
  return line || null;
}

function buildRows(data: EvaluatorsEvent): EvalRow[] {
  const customRows: EvalRow[] = [...data.custom]
    .sort((a, b) => b.updated_at - a.updated_at)
    .map((c) => ({
      name: c.name,
      type: "custom" as const,
      scopeLabel: scopeLabel(c.scope),
      description: customDescription(c),
      updatedAt: c.updated_at,
      custom: c,
    }));
  const builtinNames = [...data.available, ...data.dataset_only, ...data.multimodal];
  const builtinRows: EvalRow[] = builtinNames.map((name) => ({
    name,
    type: "builtin" as const,
    scopeLabel: scopesToLabel(data.scopes[name]),
    // 老后端没有 descriptions 键 ⇒ 整列「—」优雅降级
    description: data.descriptions?.[name] ?? null,
    updatedAt: null,
  }));
  return [...customRows, ...builtinRows];
}

export default function EvaluatorsPage() {
  const query = useQuery({
    queryKey: ["evaluators"],
    queryFn: () => apiOne<EvaluatorsEvent>({ action: "evaluators" }, "evaluators"),
  });

  const [filter, setFilter] = useState<EvalFilter>("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  /** 行内展开只剩「查看内置」；编辑/新建走右侧抽屉（ADR-0010） */
  const [viewing, setViewing] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** 表单脏状态由 EvaluatorForm 上报，抽屉壳据此决定关闭前是否弹丢弃确认 */
  const [formDirty, setFormDirty] = useState(false);

  const rows = useMemo(() => (query.data ? buildRows(query.data) : []), [query.data]);
  const counts = useMemo(() => ({
    all: rows.length,
    builtin: rows.filter((r) => r.type === "builtin").length,
    custom: rows.filter((r) => r.type === "custom").length,
  }), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all" && r.type !== filter) return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, filter, search]);

  const shown = filtered.slice(0, limit);

  function closeForm() {
    setEditing(null);
    setCreating(false);
    setFormDirty(false);
  }

  // 抽屉是单例（禁止抽屉叠抽屉）：新建与编辑共用一个壳，靠 editingRow 区分模式
  const editingRow = editing == null ? null : rows.find((r) => r.name === editing) ?? null;
  const formOpen = creating || (editingRow?.custom != null);

  // 跨 Agent 表现的行名单 = 本页列出的全部评估器（自定义 + 内置，同 rows 顺序）。
  // 评估器列表还没到时给 null：面板等两路数据都到才画表，不先闪一张只有 run 里名字的半表；
  // 评估器列表拉失败则给空名单，面板只列 run 里出过分的名字（不跟着一起卡在加载态）
  const evaluatorNames = useMemo(
    () => (query.data ? rows.map((r) => r.name) : query.isError ? [] : null),
    [query.data, query.isError, rows],
  );

  return (
    <section data-testid="page-evaluators">
      <PageHeader title="评估器" />

      <EvaluatorUsage evaluatorNames={evaluatorNames} />

      <div className="card" data-testid="evaluators-card">
        <div className="card-head">
          <span className="card-title">评估器</span>
          <span className="card-count" data-testid="evaluators-count">{counts.all}</span>
          <span className="spacer" />
          <div className="filters" role="group" aria-label="评估器筛选">
            {(["all", "builtin", "custom"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className="chip"
                aria-pressed={filter === f}
                data-testid={`evaluators-filter-${f}`}
                onClick={() => { setFilter(f); setLimit(PAGE_SIZE); }}
              >
                {f === "all" ? "全部" : f === "builtin" ? "内置" : "自定义"}
                <span className="n">{counts[f]}</span>
              </button>
            ))}
          </div>
          <input
            type="search"
            className="u-input res-search"
            placeholder="搜索评估器"
            aria-label="搜索评估器"
            data-testid="evaluators-search"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setLimit(PAGE_SIZE); }}
          />
          <button
            type="button"
            className="btn btn-primary"
            data-testid="evaluators-new"
            onClick={() => { setCreating(true); setEditing(null); setViewing(null); }}
          >
            + 新建评估器
          </button>
        </div>

        {query.isLoading && <div className="card-body subtle">加载中…</div>}
        {query.isError && (
          <div className="card-body res-error" data-testid="evaluators-error">
            {query.error instanceof Error ? query.error.message : String(query.error)}
          </div>
        )}

        {query.data && (
          <>
            <table className="u-table res-eval-table" data-testid="evaluators-table">
              <colgroup>
                <col />
                <col style={{ width: 96 }} />
                <col />
                <col style={{ width: 140 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 132 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>类型</th>
                  <th>描述</th>
                  <th>适用环节</th>
                  <th>更新时间</th>
                  <th className="r">操作</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <EvaluatorRow
                    key={r.name}
                    row={r}
                    expanded={viewing === r.name}
                    anchored={editing === r.name}
                    data={query.data}
                    onView={() => { setViewing(viewing === r.name ? null : r.name); }}
                    onEdit={() => { setEditing(r.name); setCreating(false); setViewing(null); }}
                  />
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="subtle" data-testid="evaluators-empty">
                      没有匹配的评估器
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="card-foot">
              <span data-testid="evaluators-foot-note">
                显示 {shown.length ? 1 : 0}–{shown.length}，共 {filtered.length} 个评估器
              </span>
              <span className="spacer" />
              {filtered.length > limit && (
                <button
                  type="button"
                  className="btn-link"
                  data-testid="evaluators-load-more"
                  onClick={() => setLimit((n) => n + PAGE_SIZE)}
                >
                  加载更多
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* 评估器表单抽屉（新建/编辑共用单例壳，600 普通档——无 JSON 编辑区） */}
      <FormDrawer
        open={formOpen}
        onClose={closeForm}
        title={creating ? "新建评估器" : "编辑评估器"}
        identity={creating ? undefined : editingRow?.name}
        dirty={formDirty}
        testId="evaluator-form-drawer"
      >
        {(requestClose) => (
          creating ? (
            <EvaluatorForm
              mode="create"
              onClose={closeForm}
              onCancel={requestClose}
              onDirtyChange={setFormDirty}
            />
          ) : editingRow?.custom ? (
            <EvaluatorForm
              mode="edit"
              evaluator={editingRow.custom}
              onClose={closeForm}
              onCancel={requestClose}
              onDirtyChange={setFormDirty}
            />
          ) : null
        )}
      </FormDrawer>
    </section>
  );
}

function EvaluatorRow({
  row, expanded, anchored, data, onView, onEdit,
}: {
  row: EvalRow;
  expanded: boolean;
  /** 双向锚定：该行的编辑抽屉正开着 → 行高亮 */
  anchored: boolean;
  data: EvaluatorsEvent;
  onView: () => void;
  onEdit: () => void;
}) {
  return (
    <>
      <tr
        className={anchored ? "row-anchored" : undefined}
        data-testid={`evaluator-row-${row.name}`}
      >
        <td><span className="lat">{row.name}</span></td>
        <td>
          {row.type === "builtin"
            ? <span className="badge">内置</span>
            : <span className="badge run badge-mono">自定义</span>}
        </td>
        {/* 描述：全文上屏自然折行（用户 2026-08-31：描述要看得全）；
            文字已全量可见 ⇒ 不挂 title；缺数据「—」不编 */}
        <td
          className="muted res-eval-desc"
          data-testid={`evaluator-row-${row.name}-desc`}
        >
          {row.description ?? EMPTY_MARK}
        </td>
        <td className="muted">{row.scopeLabel}</td>
        <td className="mono subtle">{row.updatedAt == null ? "—" : fmtTime(row.updatedAt)}</td>
        <td>
          <div className="row-actions">
            {row.type === "builtin" ? (
              <button
                type="button"
                className="btn-link"
                data-testid={`evaluator-row-${row.name}-view`}
                onClick={onView}
              >
                {expanded ? "收起" : "查看"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn-link"
                  data-testid={`evaluator-row-${row.name}-edit`}
                  onClick={onEdit}
                >
                  编辑
                </button>
                <DeleteEvaluatorButton name={row.name} />
              </>
            )}
          </div>
        </td>
      </tr>
      {expanded && row.type === "builtin" && (
        <tr data-testid={`evaluator-row-${row.name}-detail`}>
          <td colSpan={6} className="res-detail-cell">
            <div className="res-detail">
              <span className="lat">{row.name}</span>
              {/* 完整描述（读 descriptions[name]；老后端缺键 ⇒ 不渲染这行，不编内容） */}
              {data.descriptions?.[row.name] && (
                <span
                  className="muted"
                  data-testid={`evaluator-row-${row.name}-detail-desc`}
                >
                  {data.descriptions[row.name]}
                </span>
              )}
              <span className="subtle">
                内置评估器 · 适用环节：{row.scopeLabel}
                {data.multimodal.includes(row.name) ? " · 多模态（图片用例）" : ""}
              </span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DeleteEvaluatorButton({ name }: { name: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // UI-004 同款纪律：不可恢复的删除必须过确认卡（居中卡，不是抽屉）
  const [confirming, setConfirming] = useState(false);
  const { refetchEvaluators } = useResourceRefetch();
  async function del() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      await apiOne({ action: "delete_custom_evaluator", name }, "custom_evaluator_deleted");
      await refetchEvaluators();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="btn-link danger"
        data-testid={`evaluator-row-${name}-delete`}
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        {busy ? "删除中…" : "删除"}
      </button>
      {error && <span className="res-error" role="alert">{error}</span>}
      <ConfirmCard
        open={confirming}
        title="删除评估器"
        body={<>确定删除自定义评估器 <b>{name}</b>？引用它的方案在下次运行时会报缺失。此操作不可恢复。</>}
        confirmLabel="删除"
        danger
        initialFocus="cancel"
        onConfirm={() => { void del(); }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

// 局部小 hook：失效评估器/数据集查询（表单/删除后刷新）
export function useResourceRefetch() {
  const qc = useQueryClient();
  return {
    refetchEvaluators: () => qc.invalidateQueries({ queryKey: ["evaluators"] }),
    refetchDatasets: () => qc.invalidateQueries({ queryKey: ["datasets"] }),
  };
}
