// 设置分节 1：评估模型（judge 配置）。
// 契约：get_judge_config -> {event:"judge_config", provider, model, base_url, secret_id}
//       set_judge_config 入参 {action, config:{provider,model,base_url,secret_id}}
//       成功 {event:"judge_config_saved", ...同上}
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiOne, useApiOne } from "../../lib/api";
import s from "./settings.module.css";

export type JudgeConfig = {
  provider: "bedrock" | "openai";
  model: string;
  base_url: string;
  secret_id: string;
};
type JudgeConfigEvent = JudgeConfig & { event: "judge_config" };
type JudgeConfigSavedEvent = JudgeConfig & { event: "judge_config_saved" };

export default function JudgeConfigSection() {
  const { data } = useQuery({
    queryKey: ["judge_config"],
    queryFn: () => apiOne<JudgeConfigEvent>({ action: "get_judge_config" }, "judge_config"),
  });

  const [form, setForm] = useState<JudgeConfig>({
    provider: "bedrock", model: "", base_url: "", secret_id: "",
  });
  useEffect(() => {
    if (!data) return;
    setForm({
      provider: data.provider ?? "bedrock",
      model: data.model ?? "",
      base_url: data.base_url ?? "",
      secret_id: data.secret_id ?? "",
    });
  }, [data]);

  const save = useApiOne<JudgeConfigSavedEvent>("judge_config_saved");
  const set = (patch: Partial<JudgeConfig>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <section className={s.section} aria-labelledby="settings-judge-title">
      <h3 className={s.sectionTitle} id="settings-judge-title">评估模型</h3>

      <div className={s.field}>
        <label className={s.label} htmlFor="judge-provider">提供方</label>
        <select
          id="judge-provider"
          className={s.input}
          value={form.provider}
          onChange={(e) => set({ provider: e.target.value as JudgeConfig["provider"] })}
          data-testid="settings-judge-provider"
        >
          <option value="bedrock">Amazon Bedrock</option>
          <option value="openai">OpenAI 兼容端点</option>
        </select>
      </div>

      <div className={s.field}>
        <label className={s.label} htmlFor="judge-model">模型</label>
        <input
          id="judge-model"
          className={s.input}
          value={form.model}
          onChange={(e) => set({ model: e.target.value })}
          placeholder="global.anthropic.claude-sonnet-5"
          data-testid="settings-judge-model"
        />
      </div>

      {form.provider === "openai" && (
        <>
          <div className={s.field}>
            <label className={s.label} htmlFor="judge-base-url">Base URL</label>
            <input
              id="judge-base-url"
              className={s.input}
              value={form.base_url}
              onChange={(e) => set({ base_url: e.target.value })}
              placeholder="https://api.example.com/v1"
              data-testid="settings-judge-base-url"
            />
          </div>
          <div className={s.field}>
            <label className={s.label} htmlFor="judge-secret-id">Secret ID</label>
            <input
              id="judge-secret-id"
              className={s.input}
              value={form.secret_id}
              onChange={(e) => set({ secret_id: e.target.value })}
              placeholder="secretsmanager 中的密钥 ID"
              data-testid="settings-judge-secret-id"
            />
          </div>
        </>
      )}

      <div className={s.actions}>
        <button
          type="button"
          className={s.btnPrimary}
          disabled={save.isPending}
          onClick={() => save.mutate({ action: "set_judge_config", config: { ...form } })}
          data-testid="settings-judge-save"
        >
          {save.isPending ? "验证中…" : "验证并保存"}
        </button>
      </div>

      {save.isError && (
        <div className={s.err} role="alert" data-testid="settings-judge-error">
          {save.error.message}
        </div>
      )}
      {save.isSuccess && (
        <div className={s.ok} role="status" data-testid="settings-judge-ok">
          配置已保存：{save.data.provider} / {save.data.model}
        </div>
      )}
    </section>
  );
}
