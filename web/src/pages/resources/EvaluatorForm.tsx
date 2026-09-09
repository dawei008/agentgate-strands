// 评估器分块表单（新建 / 编辑，一律在右侧抽屉里——ADR-0010 浮层三分法）：
// ①评估目标（单行）②关注点（可增删行）③评分标准（分值+判定条件，可增删）
// + 预览折叠区（拼好的 rubric 真实文本）+ 原始文本模式（textarea 直编，保存 blocks=null）。
// 组件本体照搬未重写，只换壳；既有 testid 全部保留。
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiOne } from "../../lib/api";
import type { CustomEvaluator, EvaluatorBlocks } from "./types";
import { SCOPE_LABELS, SYSTEM_APPENDIX, bandCriteria, buildRubric, fmtScore, parseRubric } from "./rubric";
import { useDirty } from "./useDirty";

interface BandDraft { score: string; criteria: string }

/** 空表单的两档默认（初始化与「拆不出档位」共用同一个形状） */
function emptyBands(): BandDraft[] {
  return [{ score: "1.0", criteria: "" }, { score: "0.0", criteria: "" }];
}

/** 分块模式下要不要挡一句话，以及挡哪一句 —— 两个变体的**存活期不同**：
 *  · failed = 那次切换拆不出档位（表单空白）。它描述的是刚刚那个动作，用户一动
 *    分块字段就不再成立，随即撤掉；
 *  · lossy  = 拆出来了，但与原文不逐字节一致（折行被合并、末尾说明挪了位置）。它描述
 *    的是**当前缓冲区的性质** —— 在分块模式保存就会用拆解结果整体替换原文本 ——
 *    编辑之后更成立，所以不随编辑撤掉。 */
type ParseNote = "failed" | "lossy" | null;

/** 两种明说：原文都还在（切回原始文本模式拿得回），但保存会整体替换它 */
const PARSE_NOTES: Record<"failed" | "lossy", string> = {
  failed:
    "原始文本不是分块格式，拆不出档位；下面是空白表单，保存会用分块内容整体替换原文本。" +
    "切回原始文本模式可以拿回原文。",
  lossy:
    "已按分块拆解，但排版与原文不完全一致（折行被合并、小节标题会重排、档位之后的整体说明并入了评估目标）。" +
    "在分块模式保存会用拆解结果整体替换原文本；切回原始文本模式可以拿回原文。",
};

/** 脏状态 key 的两层分隔符（字段内 / 行间）——**必须写成转义序列**。
 *  这里曾是两个裸控制字节（真的 0x00 / 0x01 写进源码）：本仓 grep 被包成
 *  `ugrep -I`（跳过二进制），该文件因此被判 binary 后**静默跳过**，一次审计
 *  据此把 create_custom_evaluator 误报成「前端不可达」，所有基于 grep 的审计
 *  与批量改名都会漏掉本文件。
 *  字节值不可改（tests/evaluator-form-separators.test.ts 钉住）：这两个字符
 *  不可能出现在用户写的 rubric 文本里；换成可见字符会让「1 项里含该字符」
 *  与「2 项」拼出同一个 key，脏状态被误判成干净 → 关抽屉时静默丢改动。 */
export const DIRTY_FIELD_SEP = "\u0000";
export const DIRTY_ROW_SEP = "\u0001";

interface Props {
  mode: "create" | "edit";
  evaluator?: CustomEvaluator;
  onClose: () => void;
  /** 脏状态上报给抽屉壳（壳据此决定 Esc/mask 关闭时是否弹丢弃确认） */
  onDirtyChange?: (dirty: boolean) => void;
  /** 取消：走抽屉壳的 requestClose（与 Esc/mask 同刑，过脏确认） */
  onCancel?: () => void;
}

export default function EvaluatorForm({ mode, evaluator, onClose, onDirtyChange, onCancel }: Props) {
  const qc = useQueryClient();
  // 编辑回填：有 blocks → 分块模式；无 blocks → 原始文本模式
  const initialBlocks = evaluator?.blocks ?? null;
  const [raw, setRaw] = useState(mode === "edit" && initialBlocks == null);

  const [name, setName] = useState(evaluator?.name ?? "");
  const [scope, setScope] = useState(evaluator?.scope ?? "all");
  const [goal, setGoal] = useState(initialBlocks?.goal ?? "");
  const [checks, setChecks] = useState<string[]>(
    initialBlocks?.checks?.length ? [...initialBlocks.checks] : [""],
  );
  const [bands, setBands] = useState<BandDraft[]>(
    initialBlocks?.bands?.length
      ? initialBlocks.bands.map((b) => ({ score: fmtScore(b.score), criteria: bandCriteria(b) }))
      : emptyBands(),
  );
  const [rawText, setRawText] = useState(evaluator?.rubric ?? "");
  const [parseNote, setParseNote] = useState<ParseNote>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // UI-006：校验失败聚焦首个错误字段（字段 ref 按错误键登记）
  const fieldRefs = useRef<Record<string, HTMLElement | null>>({});

  // 脏状态：浅比较（数组/对象序列化成串再比，避免每次渲染新引用永远算脏）
  const dirty = useDirty({
    raw, name, scope, goal, rawText,
    checks: checks.join(DIRTY_FIELD_SEP),
    bands: bands.map((b) => `${b.score}${DIRTY_FIELD_SEP}${b.criteria}`).join(DIRTY_ROW_SEP),
  });
  // 上报走 effect 不走渲染期——渲染期调父组件 setState 就是 UI-002 那类
  // 「Cannot update a component while rendering a different component」。
  const dirtyCb = useRef(onDirtyChange);
  dirtyCb.current = onDirtyChange;
  useEffect(() => { dirtyCb.current?.(dirty); }, [dirty]);

  /** 上一次自动播种进 rawText 的串（null = 还没播种过）。
   *  原始→分块时若拆解**逐字节可复原**（重建 == 原文）也登记：那种情况下 rawText
   *  只是 blocks 的投影，往回切用重建值覆盖不会吃掉任何原文字节；松散/有损的老文本
   *  （重建 ≠ 原文）不登记 —— 那份文本是唯一权威，只能由用户自己改。 */
  const seededRaw = useRef<string | null>(null);

  /** 分块字段的写入口一律过这三个：failed 那条描述的是「刚刚那次切换」，一改就不该
   *  再挡视线；lossy 那条描述的是缓冲区性质（保存会重排原文），编辑之后照样成立，留着。 */
  function clearFailedNote() { setParseNote((n) => (n === "failed" ? null : n)); }
  function editGoal(v: string) { clearFailedNote(); setGoal(v); }
  function editChecks(next: string[]) { clearFailedNote(); setChecks(next); }
  function editBands(next: BandDraft[]) { clearFailedNote(); setBands(next); }

  /** 两个模式之间搬运内容。不搬运就是本次缺陷本身：切过去空白表单 + 原文没有任何
   *  地方显示（用户 2026-08-29 实测 policy_compliance）。rawText **永远原样留在
   *  state 里**，切回去必须逐字节还是原文。 */
  function toggleRaw() {
    if (raw) {
      const parsed = parseRubric(rawText);
      if (parsed) {
        setGoal(parsed.goal);
        setChecks(parsed.checks.length > 0 ? parsed.checks : [""]);
        setBands(
          parsed.bands.length > 0
            ? parsed.bands.map((b) => ({ score: fmtScore(b.score), criteria: bandCriteria(b) }))
            : emptyBands(),
        );
        // 逐字节可复原 = rawText 只是 blocks 的投影，往回切覆盖它不吃字，也无话可说；
        // 不可复原就必须明说：保存写的是 buildRubric(currentBlocks())，会重排原文。
        const reversible = buildRubric(parsed) === rawText;
        seededRaw.current = reversible ? rawText : null;
        setParseNote(reversible ? null : "lossy");
      } else {
        // 用户点了就是要切；但有原文却拆不出档位时必须明说原文去哪了。
        // 空文本不提示：那时没有「原文」可拿回，提示条只会是噪音。
        setParseNote(rawText.trim() !== "" ? "failed" : null);
      }
      setRaw(false);
    } else {
      const seeded = buildRubric(currentBlocks());
      // 手写过的原始文本不许被覆盖（空 / 上次播种值 = 没有用户手写内容可丢）
      if (rawText.trim() === "" || rawText === seededRaw.current) {
        seededRaw.current = seeded;
        setRawText(seeded);
      }
      setParseNote(null);
      setRaw(true);
    }
  }

  function currentBlocks(): EvaluatorBlocks {
    return {
      goal: goal.trim(),
      checks: checks.map((c) => c.trim()).filter(Boolean),
      bands: bands
        .filter((b) => b.score.trim() !== "" || b.criteria.trim() !== "")
        .map((b) => ({ score: Number(b.score), criteria: b.criteria.trim() })),
    };
  }

  const preview = raw ? rawText : buildRubric(currentBlocks());

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "名称必填";
    if (raw) {
      if (!rawText.trim()) errs.raw = "评分标准文本必填";
    } else {
      if (!goal.trim()) errs.goal = "评估目标必填";
      const validBands = bands.filter((b) => b.criteria.trim() !== "");
      if (validBands.length === 0) {
        errs.bands = "至少填写一档评分标准";
      } else {
        for (const b of validBands) {
          const n = Number(b.score);
          if (b.score.trim() === "" || Number.isNaN(n) || n < 0 || n > 1) {
            errs.bands = "分值须在 0–1 之间";
            break;
          }
        }
      }
    }
    setErrors(errs);
    // UI-006：聚焦首个错误字段（按表单视觉顺序，不按对象键序）
    const order = ["name", "raw", "goal", "bands"];
    const first = order.find((k) => errs[k]);
    if (first) fieldRefs.current[first]?.focus();
    return Object.keys(errs).length === 0;
  }

  async function save() {
    setSubmitError(null);
    if (!validate()) return;
    const rubric = raw ? rawText.trim() : buildRubric(currentBlocks());
    const blocks = raw ? null : currentBlocks();
    setSaving(true);
    try {
      await apiOne(
        { action: "create_custom_evaluator", name: name.trim(), rubric, scope, blocks },
        "custom_evaluator_created",
      );
      await qc.invalidateQueries({ queryKey: ["evaluators"] });
      onClose();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="res-inlineform" data-testid="evaluator-form">
      <div className="res-if-head">
        <span className="res-if-title">
          {mode === "create" ? "新建评估器" : <>编辑评估器 <span className="lat">{evaluator?.name}</span></>}
        </span>
        <span className="subtle">{raw ? "原始文本模式（高级）" : "分块填写"}</span>
      </div>

      <div className="res-frow">
        <label className="res-fld">
          <span className="u-label">名称</span>
          <input
            ref={(el) => { fieldRefs.current.name = el; }}
            type="text"
            className="u-input mono"
            data-testid="evaluator-form-name"
            value={name}
            disabled={mode === "edit"}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? "evaluator-form-name-error" : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {errors.name && (
            <span
              className="res-error"
              id="evaluator-form-name-error"
              role="alert"
              data-testid="evaluator-form-name-error"
            >
              {errors.name}
            </span>
          )}
        </label>
        <label className="res-fld">
          <span className="u-label">适用环节</span>
          <select
            className="u-select"
            data-testid="evaluator-form-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
          >
            {Object.entries(SCOPE_LABELS).map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        </label>
      </div>

      {raw ? (
        <section className="res-fsec">
          <div className="res-fsec-h">评分标准（原始文本）</div>
          <textarea
            ref={(el) => { fieldRefs.current.raw = el; }}
            className="u-textarea"
            rows={8}
            data-testid="evaluator-form-raw"
            value={rawText}
            aria-invalid={errors.raw ? true : undefined}
            aria-describedby={errors.raw ? "evaluator-form-raw-error" : undefined}
            onChange={(e) => setRawText(e.target.value)}
          />
          {errors.raw && (
            <span
              className="res-error"
              id="evaluator-form-raw-error"
              role="alert"
              data-testid="evaluator-form-raw-error"
            >
              {errors.raw}
            </span>
          )}
        </section>
      ) : (
        <>
          {parseNote && (
            <p className="res-parse-note" role="status" data-testid="evaluator-form-parse-note">
              {PARSE_NOTES[parseNote]}
            </p>
          )}
          <section className="res-fsec">
            <div className="res-fsec-h">
              <span className="res-stepno num">1</span>评估目标
            </div>
            <input
              ref={(el) => { fieldRefs.current.goal = el; }}
              type="text"
              className="u-input res-wide"
              data-testid="evaluator-form-goal"
              value={goal}
              aria-invalid={errors.goal ? true : undefined}
              aria-describedby={errors.goal ? "evaluator-form-goal-error" : undefined}
              onChange={(e) => editGoal(e.target.value)}
            />
            {errors.goal && (
              <span
                className="res-error"
                id="evaluator-form-goal-error"
                role="alert"
                data-testid="evaluator-form-goal-error"
              >
                {errors.goal}
              </span>
            )}
          </section>

          <section className="res-fsec">
            <div className="res-fsec-h">
              <span className="res-stepno num">2</span>关注点
            </div>
            <ol className="res-rowlist" data-testid="evaluator-form-checks">
              {checks.map((c, i) => (
                <li key={i}>
                  <span className="num subtle res-fno">{i + 1}</span>
                  <input
                    type="text"
                    className="u-input"
                    data-testid={`evaluator-form-check-${i}`}
                    value={c}
                    onChange={(e) => editChecks(checks.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                  <button
                    type="button"
                    className="btn-link danger"
                    aria-label="删除该关注点"
                    data-testid={`evaluator-form-check-${i}-rm`}
                    disabled={checks.length <= 1}
                    onClick={() => editChecks(checks.filter((_, j) => j !== i))}
                  >
                    删
                  </button>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="btn-link"
              data-testid="evaluator-form-check-add"
              onClick={() => editChecks([...checks, ""])}
            >
              + 添加关注点
            </button>
          </section>

          <section className="res-fsec">
            <div className="res-fsec-h">
              <span className="res-stepno num">3</span>评分标准
            </div>
            <table className="u-table standalone res-rubric" data-testid="evaluator-form-bands">
              <colgroup>
                <col style={{ width: 96 }} />
                <col />
                <col style={{ width: 56 }} />
              </colgroup>
              <thead>
                <tr><th>分值</th><th>判定条件</th><th aria-label="操作" /></tr>
              </thead>
              <tbody>
                {bands.map((b, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        ref={i === 0 ? (el) => { fieldRefs.current.bands = el; } : undefined}
                        type="number"
                        className="u-input num res-score"
                        min={0}
                        max={1}
                        step={0.1}
                        data-testid={`evaluator-form-band-${i}-score`}
                        value={b.score}
                        aria-invalid={errors.bands ? true : undefined}
                        aria-describedby={errors.bands ? "evaluator-form-bands-error" : undefined}
                        onChange={(e) =>
                          editBands(bands.map((x, j) => (j === i ? { ...x, score: e.target.value } : x)))}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="u-input"
                        data-testid={`evaluator-form-band-${i}-criteria`}
                        value={b.criteria}
                        onChange={(e) =>
                          editBands(bands.map((x, j) => (j === i ? { ...x, criteria: e.target.value } : x)))}
                      />
                    </td>
                    <td className="r">
                      <button
                        type="button"
                        className="btn-link danger"
                        aria-label="删除该档位"
                        data-testid={`evaluator-form-band-${i}-rm`}
                        disabled={bands.length <= 1}
                        onClick={() => editBands(bands.filter((_, j) => j !== i))}
                      >
                        删
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {errors.bands && (
              <span
                className="res-error"
                id="evaluator-form-bands-error"
                role="alert"
                data-testid="evaluator-form-bands-error"
              >
                {errors.bands}
              </span>
            )}
            <div>
              <button
                type="button"
                className="btn-link"
                data-testid="evaluator-form-band-add"
                onClick={() => editBands([...bands, { score: "", criteria: "" }])}
              >
                + 添加档位
              </button>
            </div>
          </section>
        </>
      )}

      <details className="res-fold" data-testid="evaluator-form-preview">
        <summary>预览最终 prompt</summary>
        <pre className="res-prompt mono" data-testid="evaluator-form-preview-text">
          {preview}
          {"\n\n"}
          <span className="subtle">{SYSTEM_APPENDIX}</span>
        </pre>
      </details>

      {submitError && (
        <p className="res-error" role="alert" data-testid="evaluator-form-error">{submitError}</p>
      )}

      <div className="res-if-foot">
        <div className="res-if-foot-l">
          <button
            type="button"
            className="btn-link"
            data-testid="evaluator-form-toggle-raw"
            onClick={toggleRaw}
          >
            {raw ? "切换到分块模式" : "切换到原始文本模式（高级）"}
          </button>
        </div>
        <div className="res-if-foot-r">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="evaluator-form-save"
            disabled={saving}
            onClick={save}
          >
            {saving ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            className="btn ghost"
            data-testid="evaluator-form-cancel"
            onClick={onCancel ?? onClose}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
