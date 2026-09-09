// AI 生成测试用例/模拟任务（回归数据集 tab 与模拟测试 tab 共用）：
// 业务背景（必填）+ 可选目标 Agent（用其系统提示词增强）+ 参考附件（txt/md/json/csv/pdf）
// → 流式 generate_dataset（heartbeat 显示生成中，照 RedteamGenerator 模式）
// → 结果 JSON 预览可编辑 → 保存为数据集/模拟集。
// 后端契约实测自 app/main.py generate_dataset：attachments=[{name, content_base64}]（≤5 个，
// 单个 >5MB 后端跳过）；extend_dataset=已有数据集名，后端自取现有用例并在
// dataset_generated.existing_cases 回传，追加保存时前端负责合并。
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiOne, callApi } from "../../lib/api";
import { useLiveness, fmtClock, heartbeatLabel } from "../../lib/useLiveness";
import { isSimulationSide } from "../../lib/datasetSide";
import type { AgentsEvent } from "../../lib/apiTypes";
import type { Dataset, DatasetCase, DatasetGeneratedEvent } from "./types";

const ACCEPT = ".txt,.md,.json,.csv,.pdf";
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

interface Attachment {
  name: string;
  content_base64: string;
}

/** File → base64（FileReader dataURL 去前缀；照旧版 ui/app.js 做法，jsdom 也支持） */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

/** 后端明确报错（error 事件/空结果）——与前端断流区分：断流 ≠ 生成失败 */
class GenFailedError extends Error {}

/** 结果 JSON 合法性：非空数组才允许保存（与任务书「非法 JSON 时保存禁用」一致） */
export function parseCases(text: string | null): DatasetCase[] | null {
  if (text == null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as DatasetCase[];
  } catch {
    /* invalid JSON */
  }
  return null;
}

export default function GenCasesForm({
  kind, candidates, onSaved, onBusyChange, onDirtyChange, onCancel,
}: {
  kind: "regression" | "simulation";
  /** 可追加的集合（当前侧全部）——抽屉化后表格被遮罩挡住，追加目标改在抽屉内选 */
  candidates?: Dataset[];
  /** 保存成功回调；notice 非空 = 集合实际归类侧与当前 tab 不一致的搬家提示（不再静默搬家） */
  onSaved: (notice?: string | null) => void;
  /** 进行中锁上报给抽屉壳：生成流式期间 Esc/mask 关闭要先问「确定中断？」 */
  onBusyChange?: (busy: boolean) => void;
  /** review 态（有未保存结果）上报：生成结果只随流回传、不落库，关掉就没了 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 关闭：走抽屉壳的 requestClose（与 Esc/mask 同刑，过进行中确认） */
  onCancel?: () => void;
}) {
  const qc = useQueryClient();
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiOne<AgentsEvent>({ action: "discover" }, "agents"),
  });

  const [agentName, setAgentName] = useState("");
  const [numCases, setNumCases] = useState("10");
  const [context, setContext] = useState("");
  const [appendMode, setAppendMode] = useState(false);
  // 追加目标名：勾选追加时缺省第一个候选，可在抽屉内改选
  const [appendTarget, setAppendTarget] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  // 心跳活性：任何流式事件（含 heartbeat）都刷新 lastEventAt
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const live = useLiveness(generating, startedAt, lastEventAt);
  const [casesText, setCasesText] = useState<string | null>(null);
  const [attachmentNotes, setAttachmentNotes] = useState<string[]>([]);
  // 追加模式下后端回传的现有用例（合并保存的权威来源；兜底用 currentDataset.cases）
  const [existingCases, setExistingCases] = useState<DatasetCase[] | null>(null);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSim = kind === "simulation";
  // 可追加的集合：抽屉遮罩挡住表格，候选只能来自 props（当前侧全部）
  const appendable = candidates ?? [];
  const target = appendable.find((d) => d.name === appendTarget) ?? null;
  const appending = appendMode && target != null;
  const parsedCases = parseCases(casesText);

  // 进行中锁上报走 effect 不走渲染期（渲染期调父 setState 会触发
  // 「Cannot update a component while rendering a different component」）
  const busyCb = useRef(onBusyChange);
  busyCb.current = onBusyChange;
  useEffect(() => { busyCb.current?.(generating); }, [generating]);
  // 有未保存的生成结果就算脏：结果不落库，关抽屉等于丢掉，得问一句
  const hasResult = casesText != null;
  const dirtyCb = useRef(onDirtyChange);
  dirtyCb.current = onDirtyChange;
  useEffect(() => { dirtyCb.current?.(hasResult); }, [hasResult]);

  async function addFiles(files: FileList | null) {
    setError(null);
    if (!files || files.length === 0) return;
    const next = [...attachments];
    for (const f of Array.from(files)) {
      if (next.length >= MAX_ATTACHMENTS) {
        setError(`附件最多 ${MAX_ATTACHMENTS} 个，多余的已忽略`);
        break;
      }
      if (f.size > MAX_ATTACHMENT_BYTES) {
        setError(`${f.name} 超过 5MB，已跳过`);
        continue;
      }
      next.push({ name: f.name, content_base64: await fileToBase64(f) });
    }
    setAttachments(next);
  }

  async function generate() {
    setError(null);
    if (!context.trim()) { setError("请填写业务背景"); return; }
    const n = Math.max(1, Math.min(Number(numCases) || 10, 50));
    setGenerating(true);
    setProgress("正在生成…");
    setStartedAt(Date.now());
    setLastEventAt(Date.now());
    setCasesText(null);
    setAttachmentNotes([]);
    setExistingCases(null);
    try {
      let result: DatasetGeneratedEvent | null = null;
      await callApi(
        {
          action: "generate_dataset",
          context: context.trim(),
          num_cases: n,
          // 形态锁（ADR-0009）：按当前 tab 声明用例形态，后端据此选 toolSpec；
          // 追加模式后端按被追加集合的现有形态推断，此值仅作缺省。
          case_shape: isSim ? "multi" : "single",
          ...(agentName ? { agent_name: agentName } : {}),
          ...(appending && target ? { extend_dataset: target.name } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        (ev) => {
          setLastEventAt(Date.now());
          if (ev.event === "error") throw new GenFailedError(String((ev as { error?: string }).error ?? "生成失败"));
          if (ev.event === "heartbeat") setProgress("生成中");
          if (ev.event === "dataset_generated") {
            result = ev as unknown as DatasetGeneratedEvent;
          }
        },
      );
      if (!result) throw new Error("流已结束但未收到生成结果");
      const got: DatasetGeneratedEvent = result;
      if (!Array.isArray(got.cases) || got.cases.length === 0) {
        throw new GenFailedError("生成结果为空，请调整业务背景后重试");
      }
      setCasesText(JSON.stringify(got.cases, null, 2));
      setAttachmentNotes(got.attachments ?? []);
      setExistingCases(got.existing_cases ?? null);
      if (appending && target) setSaveName(target.name);
      setProgress(
        `生成完成，共 ${got.cases.length} 条` +
        (got.agent_context_used ? "（已使用目标 Agent 提示词增强）" : ""),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 诚实兜底：断流≠生成失败（后端任务不受前端断线影响），但 generate_dataset
      // 的结果只随流回传、不落库——断了就取不回，只能重试
      setError(e instanceof GenFailedError
        ? msg
        : `${msg}——连接中断，这不代表生成失败，但结果未能送达，请重试。`);
      setProgress(null);
    } finally {
      setGenerating(false);
    }
  }

  async function save() {
    setError(null);
    if (!parsedCases) { setError("用例 JSON 解析失败或为空，请检查格式"); return; }
    const name = (appending && target ? target.name : saveName).trim();
    if (!name) { setError(isSim ? "请填写模拟集名称" : "请填写数据集名称"); return; }
    // 追加：现有用例（后端回传优先）+ 生成的新用例；kind 沿用原集合，避免混合集翻面
    const cases = appending && target
      ? [...(existingCases ?? target.cases), ...parsedCases]
      : parsedCases;
    const saveKind = appending && target ? target.kind : kind;
    setSaving(true);
    try {
      await apiOne(
        { action: "save_dataset", name, cases, kind: saveKind },
        "dataset_saved",
      );
      await qc.invalidateQueries({ queryKey: ["datasets"] });
      // 搬家提示：保存后按双读规则算集合实际归类侧，与当前 tab 不一致时明说
      // 而不是静默搬家。新建路径已被后端纯度校验拦住，能走到这里的主要是
      // 存量混合集的编辑/追加场景。
      const savedSide = isSimulationSide({ kind: saveKind, cases }) ? "simulation" : "regression";
      const notice = savedSide === kind ? null
        : savedSide === "simulation"
          ? `「${name}」已保存到『模拟测试』tab（用例含多轮字段）`
          : `「${name}」已保存到『回归数据集』tab（用例均为单轮）`;
      onSaved(notice);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="res-inlineform" data-testid="dsgen-form">
      <div className="res-if-head">
        <span className="res-if-title">{isSim ? "AI 生成任务" : "AI 生成用例"}</span>
      </div>

      <div className="res-frow">
        <label className="res-fld">
          <span className="u-label">目标 Agent（可选）</span>
          <select
            className="u-select"
            data-testid="dsgen-agent"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
          >
            <option value="">不指定</option>
            {(agentsQuery.data?.agents ?? []).map((a) => (
              <option key={a.agent_name} value={a.agent_name}>{a.agent_name}</option>
            ))}
          </select>
        </label>
        <label className="res-fld">
          <span className="u-label">{isSim ? "任务条数（1–50）" : "用例条数（1–50）"}</span>
          <input
            type="number"
            className="u-input num"
            min={1}
            max={50}
            data-testid="dsgen-num"
            value={numCases}
            onChange={(e) => setNumCases(e.target.value)}
          />
        </label>
      </div>

      <label className="res-fld">
        <span className="u-label">业务背景（必填）</span>
        <textarea
          className="u-textarea"
          rows={5}
          data-testid="dsgen-context"
          placeholder={isSim
            ? "描述要模拟的任务场景（业务流程、用户目标、常见波折），生成含 task_description 的多轮任务"
            : "粘贴业务背景、FAQ、需求要点等参考资料，AI 将据此生成测试用例"}
          value={context}
          onChange={(e) => setContext(e.target.value)}
        />
      </label>

      <div className="res-frow">
        <label className="res-fld">
          <span className="u-label">参考附件（可选，txt/md/json/csv/pdf，最多 5 个）</span>
          <input
            type="file"
            className="u-input"
            data-testid="dsgen-files"
            accept={ACCEPT}
            multiple
            onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }}
          />
        </label>
        {/* 追加目标就在抽屉内选：抽屉遮罩挡住表格，「先去表格里打开编辑」的老交互
            在抽屉里走不通（ADR-0011 禁止抽屉叠抽屉，也不能半遮罩） */}
        <div className="res-fld">
          <label className="res-cat">
            <input
              type="checkbox"
              data-testid="dsgen-append"
              disabled={appendable.length === 0}
              checked={appendMode}
              onChange={(e) => {
                setAppendMode(e.target.checked);
                if (e.target.checked && !appendTarget && appendable.length > 0) {
                  setAppendTarget(appendable[0].name);
                }
              }}
            />
            <span>
              追加到已有{isSim ? "模拟集" : "数据集"}
              {appendable.length === 0 && (
                <span className="subtle">（当前还没有可追加的集合）</span>
              )}
            </span>
          </label>
          {appendMode && appendable.length > 0 && (
            <select
              className="u-select mono"
              data-testid="dsgen-append-target"
              aria-label={isSim ? "追加目标模拟集" : "追加目标数据集"}
              value={appendTarget}
              onChange={(e) => setAppendTarget(e.target.value)}
            >
              <option value="">请选择…</option>
              {appendable.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}（{d.case_count} 条）
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {attachments.length > 0 && (
        <ul className="res-att-list" data-testid="dsgen-att-list">
          {attachments.map((a, i) => (
            <li key={`${a.name}-${i}`}>
              <span className="lat">{a.name}</span>
              <button
                type="button"
                className="btn-link danger"
                data-testid={`dsgen-att-remove-${i}`}
                onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="res-gen-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="dsgen-run"
          disabled={generating || !context.trim()}
          onClick={generate}
        >
          {generating ? "生成中…" : "生成"}
        </button>
        {progress && (
          <span className="subtle num" data-testid="dsgen-progress">
            {progress}
            {live && ` · 已 ${fmtClock(live.elapsedS)}`}
          </span>
        )}
      </div>
      {/* 心跳行在进度行下方（与 RedteamGenerator 同形态） */}
      {live && (
        <p className={`res-liveness ${live.level}`} data-testid="dsgen-liveness">
          <span className="dot" />
          {live.level === "ok" && `链路正常 · ${heartbeatLabel(live)}`}
          {live.level === "waiting" && "等待响应…"}
          {live.level === "stale" && "可能已断开，若久无结果请重试"}
        </p>
      )}

      {casesText != null && (
        <section className="res-fsec" data-testid="dsgen-result">
          <div className="res-fsec-h">生成结果（可直接修改）</div>
          {attachmentNotes.length > 0 && (
            <p className="subtle" data-testid="dsgen-att-notes">{attachmentNotes.join("；")}</p>
          )}
          <textarea
            className="u-textarea mono"
            rows={12}
            data-testid="dsgen-cases"
            value={casesText}
            aria-invalid={!parsedCases ? true : undefined}
            aria-describedby={!parsedCases ? "dsgen-invalid" : undefined}
            onChange={(e) => setCasesText(e.target.value)}
          />
          {!parsedCases && (
            <p className="res-error" id="dsgen-invalid" role="alert" data-testid="dsgen-invalid">
              用例 JSON 非法或为空，修正后才能保存
            </p>
          )}
          <div className="res-gen-save">
            <input
              type="text"
              className="u-input mono"
              placeholder={isSim ? "模拟集名称" : "数据集名称"}
              aria-label={isSim ? "模拟集名称" : "数据集名称"}
              data-testid="dsgen-save-name"
              value={appending && target ? target.name : saveName}
              disabled={appending}
              onChange={(e) => setSaveName(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary"
              data-testid="dsgen-save"
              disabled={saving || !parsedCases}
              onClick={save}
            >
              {saving
                ? "保存中…"
                : appending ? "追加保存" : (isSim ? "保存为模拟集" : "保存为数据集")}
            </button>
          </div>
        </section>
      )}

      {error && <p className="res-error" role="alert" data-testid="dsgen-error">{error}</p>}

      <div className="res-if-foot">
        <span className="spacer" />
        <div className="res-if-foot-r">
          <button
            type="button"
            className="btn ghost"
            data-testid="dsgen-close"
            onClick={onCancel}
          >
            {generating ? "中断并关闭" : "关闭"}
          </button>
        </div>
      </div>
    </div>
  );
}
