// AI 生成攻击用例：目标 Agent 下拉（discover）+ 每类条数 + 风险类别复选
// → 流式生成（heartbeat/逐类进度）→ 结果 JSON 预览可改 → 保存为用例集。
// 一律在右侧抽屉里（宽档 760——含 JSON 编辑区，ADR-0011 浮层三分法）。
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiOne, callApi } from "../../lib/api";
import { useLiveness, fmtClock, heartbeatLabel } from "../../lib/useLiveness";
import { parseCases } from "./GenCasesForm";
import type { AgentsEvent } from "../../lib/apiTypes";
import type {
  RedteamCase,
  RedteamCasesGeneratedEvent,
  RedteamGenProgressEvent,
  RedteamOptionsEvent,
} from "./types";

/** 后端明确报错——与前端断流区分：断流 ≠ 生成失败 */
class GenFailedError extends Error {}

export default function RedteamGenerator({ onSaved, onBusyChange, onDirtyChange, onCancel }: {
  onSaved: () => void;
  /** 进行中锁上报给抽屉壳：生成流式期间 Esc/mask 关闭要先问「确定中断？」 */
  onBusyChange?: (busy: boolean) => void;
  /** review 态（有未保存结果）上报：结果只随流回传、不落库，关掉就没了 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 关闭：走抽屉壳的 requestClose（与 Esc/mask 同刑） */
  onCancel?: () => void;
}) {
  const qc = useQueryClient();
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiOne<AgentsEvent>({ action: "discover" }, "agents"),
  });
  const optionsQuery = useQuery({
    queryKey: ["redteam-options"],
    queryFn: () => apiOne<RedteamOptionsEvent>({ action: "redteam_options" }, "redteam_options"),
  });

  const [agentName, setAgentName] = useState("");
  const [numCases, setNumCases] = useState("2");
  const [selectedCats, setSelectedCats] = useState<string[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  // 心跳活性：任何流式事件（含 heartbeat/逐类进度）都刷新 lastEventAt
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const live = useLiveness(generating, startedAt, lastEventAt);
  const [casesText, setCasesText] = useState<string | null>(null);
  const [generatedCats, setGeneratedCats] = useState<string[]>([]);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allCats = optionsQuery.data ? Object.keys(optionsQuery.data.risk_categories) : [];
  // 未手动选择前默认勾选 default_risk_categories
  const cats = selectedCats ?? optionsQuery.data?.default_risk_categories ?? [];
  // UI-008：结果合法性实时判定，与 GenCasesForm 共用 parseCases（非空数组才算合法）
  // ——此前只在点保存时才校验，非法 JSON 下按钮仍可点，与同页另两个生成器规则不一致。
  const parsedCases = parseCases(casesText) as RedteamCase[] | null;

  // 进行中锁上报走 effect 不走渲染期（渲染期调父 setState 是 React 报错那类事故）
  const busyCb = useRef(onBusyChange);
  busyCb.current = onBusyChange;
  useEffect(() => { busyCb.current?.(generating); }, [generating]);
  const hasResult = casesText != null;
  const dirtyCb = useRef(onDirtyChange);
  dirtyCb.current = onDirtyChange;
  useEffect(() => { dirtyCb.current?.(hasResult); }, [hasResult]);

  function toggleCat(cat: string) {
    const next = cats.includes(cat) ? cats.filter((c) => c !== cat) : [...cats, cat];
    setSelectedCats(next);
  }

  async function generate() {
    setError(null);
    if (!agentName) { setError("请选择目标 Agent"); return; }
    if (cats.length === 0) { setError("至少勾选一个风险类别"); return; }
    const n = Math.max(1, Math.min(Number(numCases) || 1, 5));
    setGenerating(true);
    setProgress("正在生成…");
    setStartedAt(Date.now());
    setLastEventAt(Date.now());
    setCasesText(null);
    try {
      let result: RedteamCasesGeneratedEvent | null = null;
      await callApi(
        { action: "generate_redteam_cases", agent_name: agentName, num_cases: n, risk_categories: cats },
        (ev) => {
          setLastEventAt(Date.now());
          if (ev.event === "error") throw new GenFailedError(String((ev as { error?: string }).error ?? "生成失败"));
          if (ev.event === "heartbeat") setProgress("生成中");
          if (ev.event === "redteam_gen_progress") {
            const p = ev as unknown as RedteamGenProgressEvent;
            setProgress(`已完成 ${p.done}/${p.total} 类（${p.risk_category}）`);
          }
          if (ev.event === "redteam_cases_generated") {
            result = ev as unknown as RedteamCasesGeneratedEvent;
          }
        },
      );
      if (!result) throw new Error("流已结束但未收到生成结果");
      const got: RedteamCasesGeneratedEvent = result;
      setCasesText(JSON.stringify(got.cases, null, 2));
      setGeneratedCats(got.risk_categories);
      if (got.failed_categories.length > 0) {
        setProgress(`生成完成（失败类别：${got.failed_categories.join(", ")}）`);
      } else {
        setProgress(`生成完成，共 ${got.cases.length} 条`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 诚实兜底：断流≠生成失败，但结果只随流回传、未落库——断了只能重试
      setError(e instanceof GenFailedError
        ? msg
        : `${msg}——连接中断，这不代表生成失败，但结果未能送达，请重试。`);
      setProgress(null);
    } finally {
      setGenerating(false);
    }
  }

  async function saveAsDataset() {
    setError(null);
    // 合法性已由 parsedCases 实时判定并禁用按钮（UI-008）；这里保留兜底分支，
    // 键盘/程序化点击也拦得住。
    if (!parsedCases) { setError("用例 JSON 非法或为空，修正后才能保存"); return; }
    if (!saveName.trim()) { setError("请填写用例集名称"); return; }
    const parsed = parsedCases;
    setSaving(true);
    try {
      await apiOne(
        {
          action: "save_dataset",
          name: saveName.trim(),
          cases: parsed,
          kind: "redteam",
          target_agent: agentName,
          risk_categories: generatedCats.length > 0 ? generatedCats : cats,
        },
        "dataset_saved",
      );
      await qc.invalidateQueries({ queryKey: ["datasets"] });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="res-inlineform" data-testid="redteam-generator">
      <div className="res-if-head">
        <span className="res-if-title">AI 生成攻击用例</span>
      </div>

      <div className="res-frow">
        <label className="res-fld">
          <span className="u-label">目标 Agent</span>
          <select
            className="u-select"
            data-testid="redteam-gen-agent"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
          >
            <option value="">请选择…</option>
            {(agentsQuery.data?.agents ?? []).map((a) => (
              <option key={a.agent_name} value={a.agent_name}>{a.agent_name}</option>
            ))}
          </select>
        </label>
        <label className="res-fld">
          <span className="u-label">每类条数（1–5）</span>
          <input
            type="number"
            className="u-input num"
            min={1}
            max={5}
            data-testid="redteam-gen-num"
            value={numCases}
            onChange={(e) => setNumCases(e.target.value)}
          />
        </label>
      </div>

      <section className="res-fsec">
        <div className="res-fsec-h">风险类别</div>
        <div className="res-cats" data-testid="redteam-gen-cats">
          {allCats.map((cat) => (
            <label key={cat} className="res-cat">
              <input
                type="checkbox"
                data-testid={`redteam-gen-cat-${cat}`}
                checked={cats.includes(cat)}
                onChange={() => toggleCat(cat)}
              />
              <span className="lat">{cat}</span>
              <span className="subtle">{optionsQuery.data?.risk_categories[cat]?.description ?? ""}</span>
            </label>
          ))}
          {optionsQuery.isLoading && <span className="subtle">加载风险类别…</span>}
        </div>
      </section>

      <div className="res-gen-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="redteam-gen-run"
          disabled={generating}
          onClick={generate}
        >
          {generating ? "生成中…" : "生成"}
        </button>
        {progress && (
          <span className="subtle num" data-testid="redteam-gen-progress">
            {progress}
            {live && ` · 已 ${fmtClock(live.elapsedS)}`}
          </span>
        )}
      </div>
      {/* 心跳行在进度行下方：逐类进度照旧，活性单独一行 */}
      {live && (
        <p className={`res-liveness ${live.level}`} data-testid="redteam-gen-liveness">
          <span className="dot" />
          {live.level === "ok" && `链路正常 · ${heartbeatLabel(live)}`}
          {live.level === "waiting" && "等待响应…"}
          {live.level === "stale" && "可能已断开，若久无结果请重试"}
        </p>
      )}

      {casesText != null && (
        <section className="res-fsec" data-testid="redteam-gen-result">
          <div className="res-fsec-h">生成结果（可直接修改）</div>
          <textarea
            className="u-textarea mono"
            rows={12}
            data-testid="redteam-gen-cases"
            value={casesText}
            aria-invalid={!parsedCases ? true : undefined}
            aria-describedby={!parsedCases ? "redteam-gen-invalid" : undefined}
            onChange={(e) => setCasesText(e.target.value)}
          />
          {/* UI-008：与回归/模拟生成器同款就地提示（dsgen-invalid 同形态） */}
          {!parsedCases && (
            <p
              className="res-error"
              id="redteam-gen-invalid"
              role="alert"
              data-testid="redteam-gen-invalid"
            >
              用例 JSON 非法或为空，修正后才能保存
            </p>
          )}
          <div className="res-gen-save">
            <input
              type="text"
              className="u-input mono"
              placeholder="用例集名称"
              aria-label="用例集名称"
              data-testid="redteam-gen-save-name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary"
              data-testid="redteam-gen-save"
              disabled={saving || !parsedCases}
              onClick={saveAsDataset}
            >
              {saving ? "保存中…" : "保存为用例集"}
            </button>
          </div>
        </section>
      )}

      {error && <p className="res-error" role="alert" data-testid="redteam-gen-error">{error}</p>}

      <div className="res-if-foot">
        <span className="spacer" />
        <div className="res-if-foot-r">
          <button
            type="button"
            className="btn ghost"
            data-testid="redteam-gen-close"
            onClick={onCancel}
          >
            {generating ? "中断并关闭" : "关闭"}
          </button>
        </div>
      </div>
    </div>
  );
}
