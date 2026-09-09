// 下块「测试数据 ── 拿什么测」：四个下划线 tab（回归数据集 / 模拟测试 / 红队用例集 / 线上评估）。
// 结构照已批准原型 ui-prototypes/regression-split/index.html；
// 归类双读规则见 lib/datasetSide（kind==="simulation" 或按 cases 形态推断）。
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import { isMixedDataset, isSimulationSide } from "../../lib/datasetSide";
import type { Dataset, DatasetCase, DatasetsEvent } from "./types";
import { fmtTime } from "../../lib/time";
import { stageLabel } from "../../lib/scoring";
import type { CaseSource } from "../../lib/apiTypes";
import RedteamGenerator from "./RedteamGenerator";
import GenCasesForm from "./GenCasesForm";
import FormDrawer from "./FormDrawer";
import ConfirmCard from "../../components/ConfirmCard";
import { useDirty } from "./useDirty";

type Tab = "dataset" | "simulation" | "redteam" | "observe";

/** 生成结果只随流回传、不落库：关抽屉就是丢掉，措辞要说清取不回（ADR-0011 脏确认） */
const GEN_DISCARD_MSG = "生成结果还没保存，关闭就会丢失（需重新生成）。确定丢弃？";

/** 形态推断：有 task_description=多轮、有 image_key=图片、否则单轮 */
export function datasetShape(cases: DatasetCase[]): "单轮" | "多轮" | "图片" {
  if (cases.some((c) => c.image_key)) return "图片";
  if (cases.some((c) => c.task_description)) return "多轮";
  return "单轮";
}

/** 模拟集任务数：带 task_description 的用例才算任务（混合集里的单轮用例不计入） */
export function simTaskCount(cases: DatasetCase[]): number {
  return cases.filter((c) => Boolean(c.task_description)).length;
}

/** 模拟集最大轮次：任务用例的 max_turns 逐条缺省 5 后取最大；没有任务用例时缺省 5 */
export function simMaxTurns(cases: DatasetCase[]): number {
  const turns = cases
    .filter((c) => Boolean(c.task_description))
    .map((c) => (typeof c.max_turns === "number" && c.max_turns > 0 ? c.max_turns : 5));
  return turns.length ? Math.max(...turns) : 5;
}

/** 用例上的留痕（ADR-0017 D1 `source`）：坏例入集写的；手工/AI 生成的用例没有 ⇒ null。
 *  只认带 run_key / row_key 的对象，别的形状一律当没有（不渲染 chip，不猜）。 */
export function caseSourceOf(c: DatasetCase): CaseSource | null {
  const s = c.source;
  if (!s || typeof s !== "object") return null;
  const o = s as Partial<CaseSource>;
  if (typeof o.run_key !== "string" || !o.run_key || typeof o.row_key !== "string" || !o.row_key) return null;
  return o as CaseSource;
}

/** 来源 chip 的深链：报告页 + `?row=<行名>`（ReportPage.splitReportId 切它，落到 `#rp-row-…` 锚点） */
export function caseSourceHref(src: CaseSource): string {
  return `#/report/${encodeURIComponent(src.run_key)}?row=${encodeURIComponent(src.row_key)}`;
}

/** 来源 chip：「来自 线上评估 run」/「来自 红队测试 run」，深链报告页该行 */
function CaseSourceChip({ src, testid }: { src: CaseSource; testid: string }) {
  const kind = src.kind === "attack" ? stageLabel("redteam") : stageLabel("observe");
  return (
    <a
      className="chip res-case-source"
      href={caseSourceHref(src)}
      title={`${src.run_key} · ${src.row_key}${src.evaluators_failed?.length ? ` · 未过 ${src.evaluators_failed.join(" / ")}` : ""}`}
      data-testid={testid}
    >
      来自 {kind} run
    </a>
  );
}

/** 人设摘要：取首个非空 persona；没有则 null（列里显示 —） */
export function personaSummary(cases: DatasetCase[]): string | null {
  for (const c of cases) {
    const p = typeof c.persona === "string" ? c.persona.trim() : "";
    if (p) return p;
  }
  return null;
}

export default function DatasetsBlock() {
  const [tab, setTab] = useState<Tab>("dataset");
  const query = useQuery({
    queryKey: ["datasets"],
    queryFn: () => apiOne<DatasetsEvent>({ action: "list_datasets" }, "datasets"),
  });

  const datasets = query.data?.datasets ?? [];
  // 双读归类：simulation 侧 = 显式 kind 或形态推断（历史多轮集 kind 仍是 regression）
  const simulation = datasets.filter((d) => isSimulationSide(d));
  const regression = datasets.filter((d) => d.kind === "regression" && !isSimulationSide(d));
  const redteam = datasets.filter((d) => d.kind === "redteam");

  return (
    <div className="card" data-testid="testdata-card">
      <div className="card-head">
        <span className="card-title">测试数据</span>
      </div>
      <div className="card-body">
        <div className="res-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className="res-tab"
            aria-selected={tab === "dataset"}
            data-testid="testdata-tab-dataset"
            onClick={() => setTab("dataset")}
          >
            回归数据集 <span className="card-count">{regression.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            className="res-tab"
            aria-selected={tab === "simulation"}
            data-testid="testdata-tab-simulation"
            onClick={() => setTab("simulation")}
          >
            模拟测试 <span className="card-count">{simulation.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            className="res-tab"
            aria-selected={tab === "redteam"}
            data-testid="testdata-tab-redteam"
            onClick={() => setTab("redteam")}
          >
            红队用例集 <span className="card-count">{redteam.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            className="res-tab"
            aria-selected={tab === "observe"}
            data-testid="testdata-tab-observe"
            onClick={() => setTab("observe")}
          >
            线上评估
          </button>
        </div>

        {query.isLoading && <div className="subtle">加载中…</div>}
        {query.isError && (
          <div className="res-error" data-testid="datasets-error">
            {query.error instanceof Error ? query.error.message : String(query.error)}
          </div>
        )}

        {query.data && tab === "dataset" && (
          <RegressionPane datasets={regression} allNames={datasets.map((d) => d.name)} />
        )}
        {query.data && tab === "simulation" && (
          <SimulationPane datasets={simulation} allNames={datasets.map((d) => d.name)} />
        )}
        {query.data && tab === "redteam" && <RedteamPane datasets={redteam} />}
        {tab === "observe" && (
          <p className="muted" data-testid="testdata-observe-note">
            线上评估直接分析真实会话，无需准备用例。
          </p>
        )}
      </div>
    </div>
  );
}

// ==================== tab ❶ 回归数据集 ====================
function RegressionPane({ datasets, allNames }: { datasets: Dataset[]; allNames: string[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  // 归类搬家提示（保存后集合实际归属侧 ≠ 当前 tab；不再静默搬家）
  const [sideNotice, setSideNotice] = useState<string | null>(null);
  // 表单脏状态由 DatasetForm 上报，抽屉壳据此决定关闭前是否弹丢弃确认
  const [formDirty, setFormDirty] = useState(false);
  // 进行中锁：AI 生成流式期间关抽屉先问「生成中，确定中断？」
  const [genBusy, setGenBusy] = useState(false);
  // review 态未保存结果：关抽屉先问丢弃（生成结果不落库，丢了要重跑）
  const [genDirty, setGenDirty] = useState(false);
  const editingDataset = datasets.find((d) => d.name === editing) ?? null;
  // 抽屉单例（禁止抽屉叠抽屉）：新建与编辑共用一个壳，靠 editingDataset 区分模式
  const formOpen = creating || editingDataset != null;
  function closeForm() { setCreating(false); setEditing(null); setFormDirty(false); }
  function closeGen() { setGenerating(false); setGenBusy(false); setGenDirty(false); }

  return (
    <div data-testid="testdata-pane-dataset" role="tabpanel">
      {sideNotice && (
        <p className="sim-note" data-testid="datasets-side-notice">
          <span aria-hidden="true">ⓘ</span>
          <span>{sideNotice}</span>
        </p>
      )}
      <table className="u-table standalone res-ds-table" data-testid="datasets-table">
        <colgroup>
          <col />
          <col style={{ width: 88 }} />
          <col style={{ width: 96 }} />
          <col style={{ width: 150 }} />
          <col style={{ width: 120 }} />
        </colgroup>
        <thead>
          <tr>
            <th>名称</th>
            <th className="num">用例数</th>
            <th>形态</th>
            <th>更新时间</th>
            <th className="r">操作</th>
          </tr>
        </thead>
        <tbody>
          {datasets.map((d) => (
            <DatasetRow
              key={d.name}
              dataset={d}
              anchored={editing === d.name}
              onEdit={() => { setEditing(editing === d.name ? null : d.name); setCreating(false); }}
            />
          ))}
          {datasets.length === 0 && (
            <tr>
              <td colSpan={5} className="subtle" data-testid="datasets-empty">还没有回归数据集</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="res-tablefoot">
        <span className="subtle num" data-testid="datasets-foot-note">
          共 {datasets.length} 个数据集 · {datasets.reduce((n, d) => n + d.case_count, 0)} 条用例
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          data-testid="datasets-new"
          onClick={() => { setCreating(true); setEditing(null); }}
        >
          + 新建数据集
        </button>
        <button
          type="button"
          className="btn ghost"
          data-testid="datasets-ai-generate"
          onClick={() => setGenerating((v) => !v)}
        >
          ✦ AI 生成用例
        </button>
      </div>
      {/* 数据集表单抽屉（宽档 760——含 JSON 编辑区；新建/编辑共用单例壳） */}
      <FormDrawer
        open={formOpen}
        onClose={closeForm}
        title={creating ? "新建数据集" : "编辑数据集"}
        identity={creating ? undefined : editingDataset?.name}
        wide
        dirty={formDirty}
        testId="dataset-form-drawer"
      >
        {(requestClose) => (
          <DatasetForm
            mode={creating ? "create" : "edit"}
            kind={creating ? "regression" : (editingDataset?.kind ?? "regression")}
            dataset={creating ? undefined : editingDataset ?? undefined}
            existingNames={allNames}
            onClose={closeForm}
            onCancel={requestClose}
            onDirtyChange={setFormDirty}
          />
        )}
      </FormDrawer>
      {/* AI 生成抽屉（宽档 760）：流式过程留在抽屉内，生成中关闭先问「确定中断？」 */}
      <FormDrawer
        open={generating}
        onClose={closeGen}
        title="AI 生成用例"
        wide
        busy={genBusy}
        dirty={genDirty}
        dirtyMessage={GEN_DISCARD_MSG}
        testId="dsgen-drawer"
      >
        {(requestClose) => (
          <GenCasesForm
            kind="regression"
            candidates={datasets}
            onSaved={(notice) => { closeGen(); setSideNotice(notice ?? null); }}
            onBusyChange={setGenBusy}
            onDirtyChange={setGenDirty}
            onCancel={requestClose}
          />
        )}
      </FormDrawer>
    </div>
  );
}

function DatasetRow({
  dataset, anchored, onEdit,
}: {
  dataset: Dataset;
  /** 双向锚定：该行的编辑抽屉正开着 → 行高亮 */
  anchored: boolean;
  onEdit: () => void;
}) {
  // 用例清单展开（与红队侧「查看」同形）：坏例入集写的用例带 source ⇒ 来源 chip 深链报告行
  const [expanded, setExpanded] = useState(false);
  const sourced = dataset.cases.filter((c) => caseSourceOf(c) != null).length;
  return (
    <>
      <tr
        className={anchored ? "row-anchored" : undefined}
        data-testid={`dataset-row-${dataset.name}`}
      >
        <td>
          <span className="cell-main">{dataset.name}</span>
          {sourced > 0 && (
            <span className="badge ok" data-testid={`dataset-row-${dataset.name}-sourced`} title="来自线上评估 / 红队测试 run 的坏例条数">
              {sourced} 条坏例
            </span>
          )}
        </td>
        <td className="num">{dataset.case_count}</td>
        <td><span className="badge">{datasetShape(dataset.cases)}</span></td>
        <td className="mono subtle">{fmtTime(dataset.updated_at)}</td>
        <td>
          <div className="row-actions">
            <button
              type="button"
              className="btn-link"
              data-testid={`dataset-row-${dataset.name}-view`}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "收起" : "查看"}
            </button>
            <button
              type="button"
              className="btn-link"
              data-testid={`dataset-row-${dataset.name}-edit`}
              onClick={onEdit}
            >
              编辑
            </button>
            <DeleteDatasetButton
              name={dataset.name}
              caseCount={dataset.case_count}
              testidPrefix="dataset"
            />
          </div>
        </td>
      </tr>
      {expanded && (
        <tr data-testid={`dataset-row-${dataset.name}-detail`}>
          <td colSpan={5} className="res-detail-cell">
            <ol className="res-case-list" data-testid={`dataset-row-${dataset.name}-cases`}>
              {dataset.cases.map((c, i) => {
                const src = caseSourceOf(c);
                const name = String(c.name ?? `case-${i + 1}`);
                return (
                  <li key={i} data-testid={`dataset-case-${dataset.name}-${name}`}>
                    <span className="lat subtle">{name}</span>
                    <span className="res-case-input">{String(c.input ?? "")}</span>
                    {src && <CaseSourceChip src={src} testid={`dataset-case-${dataset.name}-${name}-source`} />}
                  </li>
                );
              })}
            </ol>
          </td>
        </tr>
      )}
    </>
  );
}

// ==================== tab ❷ 模拟测试（新） ====================
function SimulationPane({ datasets, allNames }: { datasets: Dataset[]; allNames: string[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  // 归类搬家提示（保存后集合实际归属侧 ≠ 当前 tab；不再静默搬家）
  const [sideNotice, setSideNotice] = useState<string | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genDirty, setGenDirty] = useState(false);
  const editingDataset = datasets.find((d) => d.name === editing) ?? null;
  const formOpen = creating || editingDataset != null;
  function closeForm() { setCreating(false); setEditing(null); setFormDirty(false); }
  function closeGen() { setGenerating(false); setGenBusy(false); setGenDirty(false); }

  return (
    <div data-testid="testdata-pane-simulation" role="tabpanel">
      {sideNotice && (
        <p className="sim-note" data-testid="simsets-side-notice">
          <span aria-hidden="true">ⓘ</span>
          <span>{sideNotice}</span>
        </p>
      )}
      <table className="u-table standalone res-ds-table" data-testid="simsets-table">
        <colgroup>
          <col />
          <col style={{ width: 80 }} />
          <col style={{ width: 88 }} />
          <col />
          <col style={{ width: 150 }} />
          <col style={{ width: 120 }} />
        </colgroup>
        <thead>
          <tr>
            <th>名称</th>
            <th className="num">任务数</th>
            <th className="num">最大轮次</th>
            <th>人设</th>
            <th>更新时间</th>
            <th className="r">操作</th>
          </tr>
        </thead>
        <tbody>
          {datasets.map((d) => (
            <SimulationRow
              key={d.name}
              dataset={d}
              anchored={editing === d.name}
              onEdit={() => { setEditing(editing === d.name ? null : d.name); setCreating(false); }}
            />
          ))}
          {datasets.length === 0 && (
            <tr>
              <td colSpan={6} className="subtle" data-testid="simsets-empty">还没有模拟集</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="res-tablefoot">
        <span className="subtle num" data-testid="simsets-foot-note">
          共 {datasets.length} 个模拟集 · {datasets.reduce((n, d) => n + simTaskCount(d.cases), 0)} 个任务
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          data-testid="simsets-new"
          onClick={() => { setCreating(true); setEditing(null); }}
        >
          + 新建模拟集
        </button>
        <button
          type="button"
          className="btn ghost"
          data-testid="simsets-ai-generate"
          onClick={() => setGenerating((v) => !v)}
        >
          ✦ AI 生成任务
        </button>
      </div>
      {/* 模拟集表单抽屉（宽档 760——含 JSON 编辑区） */}
      <FormDrawer
        open={formOpen}
        onClose={closeForm}
        title={creating ? "新建模拟集" : "编辑模拟集"}
        identity={creating ? undefined : editingDataset?.name}
        wide
        dirty={formDirty}
        testId="dataset-form-drawer"
      >
        {(requestClose) => (
          <DatasetForm
            mode={creating ? "create" : "edit"}
            kind={creating ? "simulation" : (editingDataset?.kind ?? "simulation")}
            dataset={creating ? undefined : editingDataset ?? undefined}
            existingNames={allNames}
            onClose={closeForm}
            onCancel={requestClose}
            onDirtyChange={setFormDirty}
          />
        )}
      </FormDrawer>
      {/* AI 生成抽屉（宽档 760）：与回归侧同壳同刑 */}
      <FormDrawer
        open={generating}
        onClose={closeGen}
        title="AI 生成任务"
        wide
        busy={genBusy}
        dirty={genDirty}
        dirtyMessage={GEN_DISCARD_MSG}
        testId="dsgen-drawer"
      >
        {(requestClose) => (
          <GenCasesForm
            kind="simulation"
            candidates={datasets}
            onSaved={(notice) => { closeGen(); setSideNotice(notice ?? null); }}
            onBusyChange={setGenBusy}
            onDirtyChange={setGenDirty}
            onCancel={requestClose}
          />
        )}
      </FormDrawer>
    </div>
  );
}

function SimulationRow({
  dataset, anchored, onEdit,
}: {
  dataset: Dataset;
  /** 双向锚定：该行的编辑抽屉正开着 → 行高亮 */
  anchored: boolean;
  onEdit: () => void;
}) {
  const persona = personaSummary(dataset.cases);
  return (
    <>
      <tr
        className={anchored ? "row-anchored" : undefined}
        data-testid={`simset-row-${dataset.name}`}
      >
        <td>
          <span className="cell-main">{dataset.name}</span>
          {isMixedDataset(dataset) && (
            <span
              className="badge"
              data-testid={`simset-row-${dataset.name}-mixed`}
              title="该集合同时含多轮任务与单轮用例"
            >
              混合
            </span>
          )}
        </td>
        <td className="num">{simTaskCount(dataset.cases)}</td>
        <td className="num">{simMaxTurns(dataset.cases)}</td>
        <td>
          {persona ? (
            <>
              <span className="persona-yes" aria-hidden="true">✓</span>
              <span className="persona-text" title={persona}>{persona}</span>
            </>
          ) : (
            <span className="subtle">—</span>
          )}
        </td>
        <td className="mono subtle">{fmtTime(dataset.updated_at)}</td>
        <td>
          <div className="row-actions">
            <button
              type="button"
              className="btn-link"
              data-testid={`simset-row-${dataset.name}-edit`}
              onClick={onEdit}
            >
              编辑
            </button>
            <DeleteDatasetButton
              name={dataset.name}
              caseCount={dataset.case_count}
              testidPrefix="simset"
            />
          </div>
        </td>
      </tr>
    </>
  );
}

/** 新建模拟集的任务模板：input 是开场消息（后端必填），task_description 触发多轮跑法 */
const SIM_CASE_TEMPLATE = [{
  name: "task-1",
  input: "",
  task_description: "",
  max_turns: 5,
  persona: "",
}];

/** 简化编辑器：名称 + 用例 JSON textarea（表单化逐条编辑器后续批次接）。
    一律在右侧抽屉里（宽档 760——含 JSON 编辑区，ADR-0011 浮层三分法）；
    组件本体照搬未重写，只换壳 + 补三道校验，既有 testid 全部保留。
    kind 决定保存请求体与新建模板：模拟集存 kind:"simulation"（UI 四类/存储三类，环节仍 type:"dataset"）。 */
function DatasetForm({ mode, kind, dataset, existingNames, onClose, onCancel, onDirtyChange }: {
  mode: "create" | "edit";
  kind: Dataset["kind"];
  dataset?: Dataset;
  /** 全部已存在的集合名（跨 tab，不只当前侧）——新建同名就地拦（UI-003） */
  existingNames?: string[];
  onClose: () => void;
  /** 取消：走抽屉壳的 requestClose（与 Esc/mask 同刑，过脏确认） */
  onCancel?: () => void;
  /** 脏状态上报给抽屉壳 */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(dataset?.name ?? "");
  const [casesText, setCasesText] = useState(
    JSON.stringify(
      dataset?.cases
        ?? (kind === "simulation" ? SIM_CASE_TEMPLATE : [{ name: "case-1", input: "", expected_output: "" }]),
      null,
      2,
    ),
  );
  /** 字段级错误（UI-006 要按字段聚焦 + ARIA 关联，不能再用单个 error 串） */
  const [errors, setErrors] = useState<{ name?: string; cases?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fieldRefs = useRef<Record<string, HTMLElement | null>>({});

  const dirty = useDirty({ name, casesText });
  // 上报走 effect 不走渲染期（渲染期调父 setState 就是「Cannot update a component
  // while rendering a different component」那类事故）
  const dirtyCb = useRef(onDirtyChange);
  dirtyCb.current = onDirtyChange;
  useEffect(() => { dirtyCb.current?.(dirty); }, [dirty]);

  /** 三道校验（UI-003 同名 / UI-005 空数组 / 非法 JSON），返回 cases 或 null */
  function validate(): DatasetCase[] | null {
    const errs: { name?: string; cases?: string } = {};
    const trimmed = name.trim();
    if (!trimmed) {
      errs.name = "名称必填";
    } else if (mode === "create" && (existingNames ?? []).includes(trimmed)) {
      // UI-003：新建同名会静默覆盖原集合——就地拦住，文案与后端 create_only 同义。
      // 编辑模式不拦（原名保存是正常路径）。后端 create_only 是第二道闸（绕 UI 也拦）。
      errs.name = `名称已存在，请更换名称（或在列表中打开「${trimmed}」编辑）`;
    }
    let cases: unknown = null;
    try {
      cases = JSON.parse(casesText);
    } catch {
      errs.cases = "用例 JSON 解析失败，请检查格式";
    }
    if (!errs.cases) {
      if (!Array.isArray(cases)) {
        errs.cases = "用例 JSON 必须是数组";
      } else if (cases.length === 0) {
        // UI-005：空数组能存成 0 条用例的空集合——与 AI 生成入口规则对齐。
        // 文案逐字照抄后端 catalog.save_dataset 的拒空错误。
        errs.cases = "数据集至少需要一条用例";
      }
    }
    setErrors(errs);
    // UI-006：聚焦首个错误字段（按表单视觉顺序）
    const first = (["name", "cases"] as const).find((k) => errs[k]);
    if (first) { fieldRefs.current[first]?.focus(); return null; }
    return cases as DatasetCase[];
  }

  async function save() {
    setSubmitError(null);
    const cases = validate();
    if (!cases) return;
    setSaving(true);
    try {
      await apiOne(
        {
          action: "save_dataset", name: name.trim(), cases, kind,
          // UI-003 第二道闸：新建入口声明「只创建不覆盖」，后端同名即拒
          // （app/catalog.py save_dataset create_only）。编辑不带此键，行为不变。
          ...(mode === "create" ? { create_only: true } : {}),
        },
        "dataset_saved",
      );
      await qc.invalidateQueries({ queryKey: ["datasets"] });
      onClose();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="res-inlineform" data-testid="dataset-form">
      <div className="res-if-head">
        <span className="res-if-title">
          {mode === "create"
            ? (kind === "simulation" ? "新建模拟集" : "新建数据集")
            : <>{kind === "simulation" ? "编辑模拟集" : "编辑数据集"} <span className="lat">{dataset?.name}</span></>}
        </span>
        {/* 回归数据集那句「用例以 JSON 数组直编；表单化逐条编辑器后续提供」是路线图
            不是数据 ⇒ 删；模拟集这句列的是字段契约（必填/可选键），保留 */}
        {kind === "simulation" && (
          <span className="subtle">任务以 JSON 数组直编：task_description 必填，max_turns/persona 可选</span>
        )}
      </div>
      <label className="res-fld res-fld-narrow">
        <span className="u-label">名称</span>
        <input
          ref={(el) => { fieldRefs.current.name = el; }}
          type="text"
          className="u-input mono"
          data-testid="dataset-form-name"
          value={name}
          disabled={mode === "edit"}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? "dataset-form-name-error" : undefined}
          onChange={(e) => {
            setName(e.target.value);
            // 用户改动即清该字段错误，不残留无效 ARIA
            if (errors.name) setErrors(({ name: _drop, ...rest }) => rest);
          }}
        />
        {errors.name && (
          <span
            className="res-error"
            id="dataset-form-name-error"
            role="alert"
            data-testid="dataset-form-name-error"
          >
            {errors.name}
          </span>
        )}
      </label>
      <label className="res-fld">
        <span className="u-label">{kind === "simulation" ? "任务（JSON 数组）" : "用例（JSON 数组）"}</span>
        <textarea
          ref={(el) => { fieldRefs.current.cases = el; }}
          className="u-textarea mono"
          rows={10}
          data-testid="dataset-form-cases"
          value={casesText}
          aria-invalid={errors.cases ? true : undefined}
          aria-describedby={errors.cases ? "dataset-form-cases-error" : undefined}
          onChange={(e) => {
            setCasesText(e.target.value);
            if (errors.cases) setErrors(({ cases: _drop, ...rest }) => rest);
          }}
        />
        {errors.cases && (
          <span
            className="res-error"
            id="dataset-form-cases-error"
            role="alert"
            data-testid="dataset-form-cases-error"
          >
            {errors.cases}
          </span>
        )}
      </label>
      {submitError && (
        <p className="res-error" role="alert" data-testid="dataset-form-error">{submitError}</p>
      )}
      <div className="res-if-foot">
        <span className="spacer" />
        <div className="res-if-foot-r">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="dataset-form-save"
            disabled={saving}
            onClick={save}
          >
            {saving ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            className="btn ghost"
            data-testid="dataset-form-cancel"
            onClick={onCancel ?? onClose}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteDatasetButton({ name, caseCount, testidPrefix }: {
  name: string;
  caseCount: number;
  testidPrefix: string;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // UI-004：不可恢复的删除必须过确认卡（居中卡，不是抽屉），默认焦点在取消
  const [confirming, setConfirming] = useState(false);
  async function del() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      await apiOne({ action: "delete_dataset", name }, "dataset_deleted");
      await qc.invalidateQueries({ queryKey: ["datasets"] });
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
        data-testid={`${testidPrefix}-row-${name}-delete`}
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        {busy ? "删除中…" : "删除"}
      </button>
      {error && <span className="res-error" role="alert">{error}</span>}
      <ConfirmCard
        open={confirming}
        title="删除数据集"
        body={
          <>确定删除 <b>{name}</b>（{caseCount} 条用例）？引用它的评估计划在下次运行时会报缺失。
          此操作不可恢复。</>
        }
        confirmLabel="确认删除"
        danger
        initialFocus="cancel"
        onConfirm={() => { void del(); }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

// ==================== tab ❸ 红队用例集 ====================
function RedteamPane({ datasets }: { datasets: Dataset[] }) {
  const [viewing, setViewing] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genDirty, setGenDirty] = useState(false);
  function closeGen() { setGenerating(false); setGenBusy(false); setGenDirty(false); }

  return (
    <div data-testid="testdata-pane-redteam" role="tabpanel">
      <table className="u-table standalone res-rt-table" data-testid="redteam-table">
        <colgroup>
          <col />
          <col style={{ width: 150 }} />
          <col style={{ width: 72 }} />
          <col style={{ width: 220 }} />
          <col style={{ width: 150 }} />
          <col style={{ width: 120 }} />
        </colgroup>
        <thead>
          <tr>
            <th>名称</th>
            <th>目标 <span className="lat">Agent</span></th>
            <th className="num">条数</th>
            <th>风险类别</th>
            <th>更新时间</th>
            <th className="r">操作</th>
          </tr>
        </thead>
        <tbody>
          {datasets.map((d) => (
            <RedteamRow
              key={d.name}
              dataset={d}
              expanded={viewing === d.name}
              onView={() => setViewing(viewing === d.name ? null : d.name)}
            />
          ))}
          {datasets.length === 0 && (
            <tr>
              <td colSpan={6} className="subtle" data-testid="redteam-empty">还没有红队用例集</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="res-tablefoot">
        <span className="subtle num" data-testid="redteam-foot-note">
          共 {datasets.length} 个用例集 · {datasets.reduce((n, d) => n + d.case_count, 0)} 条攻击话术
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          data-testid="redteam-generate"
          onClick={() => setGenerating((v) => !v)}
        >
          ✦ AI 生成攻击用例
        </button>
      </div>
      {/* 红队生成抽屉（宽档 760）：进行中锁同回归/模拟侧 */}
      <FormDrawer
        open={generating}
        onClose={closeGen}
        title="AI 生成攻击用例"
        wide
        busy={genBusy}
        dirty={genDirty}
        dirtyMessage={GEN_DISCARD_MSG}
        testId="redteam-gen-drawer"
      >
        {(requestClose) => (
          <RedteamGenerator
            onSaved={closeGen}
            onBusyChange={setGenBusy}
            onDirtyChange={setGenDirty}
            onCancel={requestClose}
          />
        )}
      </FormDrawer>
    </div>
  );
}

function RedteamRow({ dataset, expanded, onView }: {
  dataset: Dataset;
  expanded: boolean;
  onView: () => void;
}) {
  return (
    <>
      <tr data-testid={`redteam-row-${dataset.name}`}>
        <td><span className="cell-main">{dataset.name}</span></td>
        <td><span className="lat">{dataset.target_agent || "—"}</span></td>
        <td className="num">{dataset.case_count}</td>
        <td>
          <span className="res-badges">
            {dataset.risk_categories.map((c) => (
              <span key={c} className="badge badge-mono">{c}</span>
            ))}
          </span>
        </td>
        <td className="mono subtle">{fmtTime(dataset.updated_at)}</td>
        <td>
          <div className="row-actions">
            <button
              type="button"
              className="btn-link"
              data-testid={`redteam-row-${dataset.name}-view`}
              onClick={onView}
            >
              {expanded ? "收起" : "查看"}
            </button>
            <DeleteDatasetButton
              name={dataset.name}
              caseCount={dataset.case_count}
              testidPrefix="redteam"
            />
          </div>
        </td>
      </tr>
      {expanded && (
        <tr data-testid={`redteam-row-${dataset.name}-detail`}>
          <td colSpan={6} className="res-detail-cell">
            <ol className="res-case-list" data-testid={`redteam-row-${dataset.name}-cases`}>
              {dataset.cases.map((c, i) => (
                <li key={i}>
                  <span className="lat subtle">{String(c.name ?? `case-${i + 1}`)}</span>
                  {c.risk_category != null && <span className="badge badge-mono">{String(c.risk_category)}</span>}
                  <span className="res-case-input">{String(c.input ?? "")}</span>
                </li>
              ))}
            </ol>
          </td>
        </tr>
      )}
    </>
  );
}
