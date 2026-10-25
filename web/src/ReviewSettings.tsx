import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import { strings, useStrings } from "./i18n";
import type { Model } from "./types";
import "./pr-reviews.css";

type Settings = {
  harness: "codex" | "claude";
  model: string;
  /** Whether this Workspace chose the reviewer (T-190); older Cores don't say. */
  source?: "workspace" | "builtin";
  builtIn?: { harness: "codex" | "claude"; model: string };
};
const reviewerName = (s: { harness: string; model: string }, label?: string) =>
  `${s.harness === "claude" ? "Claude Code" : "Codex"} · ${
    s.harness === "codex" && s.model === "gpt-6.1-sol" ? "GPT-6.1 Sol" : label || s.model
  }`;
// The page's own words (T-189). Harness and model names, a model's own
// description and Core's errors are shown as they come.
const text = strings({
  section: "Code review settings",
  title: "Code review",
  intro: "Choose the reviewer for new PR reviews requested from tasks or by Agents. Running reviews keep their original settings.",
  source: (source: "workspace" | "builtin", builtIn: string | null) =>
    `${source === "workspace" ? "Set for this Workspace" : "Built in"}${builtIn ? `. Built in: ${builtIn}.` : "."}`,
  inUse: "In use now",
  harness: "Harness",
  harnessHelp: "The runtime that reads the PR.",
  harnessLabel: "Review Harness",
  model: "Model",
  loadingModels: "Loading native Claude models…",
  modelHelp: "Used for every new review.",
  modelLabel: "Review model",
  chooseModel: "Choose a model",
  isDefault: " · default",
  useBuiltIn: "Use built-in",
  saving: "Saving…",
  save: "Save review settings",
}, {
  section: "代码审查设置",
  title: "代码审查",
  intro: "为从任务或由 Agent 请求的新 PR 审查选择审查者。进行中的审查保留原来的设置。",
  source: (source, builtIn) => `${source === "workspace" ? "已为此 Workspace 设置" : "内置"}${builtIn ? `。内置：${builtIn}。` : "。"}`,
  inUse: "当前使用",
  harness: "Harness",
  harnessHelp: "读取 PR 的运行环境。",
  harnessLabel: "审查 Harness",
  model: "模型",
  loadingModels: "正在加载原生 Claude 模型…",
  modelHelp: "用于每一次新的审查。",
  modelLabel: "审查模型",
  chooseModel: "选择一个模型",
  isDefault: " · 默认",
  useBuiltIn: "使用内置",
  saving: "正在保存…",
  save: "保存审查设置",
});

export function ReviewSettings({ active }: { active: boolean }) {
  const t = useStrings(text);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError("");
    void api<Settings>("/pr-reviews/settings", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setSaved(value);
          setDraft(value);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [active]);
  useEffect(() => {
    if (!active || draft?.harness !== "claude") return;
    const controller = new AbortController();
    setLoading(true);
    setModels([]);
    void api<{ models: Model[] }>("/models?harness=claude", {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        setModels(value.models);
        setDraft((old) =>
          old && !old.model
            ? {
                ...old,
                model:
                  (value.models.find((m) => m.isDefault) || value.models[0])
                    ?.model || "",
              }
            : old,
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, draft?.harness]);
  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setError("");
    try {
      setSaved(
        await api<Settings>("/pr-reviews/settings", {
          method: "POST",
          body: JSON.stringify({ harness: draft.harness, model: draft.model }),
        }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  /** Deletes this Workspace's choice: new reviews use the built-in reviewer. */
  async function useBuiltIn() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const value = await api<Settings>("/pr-reviews/settings", { method: "DELETE" });
      setSaved(value);
      setDraft(value);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  const selected = models.find((m) => m.model === draft?.model);
  const changed =
    !!draft && (draft.harness !== saved?.harness || draft.model !== saved?.model);
  return (
    <section
      id="settings-review"
      className="settings-section review-settings"
      aria-label={t.section}
    >
      <header className="settings-section-heading">
        <div>
          <h3>{t.title}</h3>
          <p>{t.intro}</p>
          {saved?.source && (
            <p className="settings-row-help review-settings-source" data-source={saved.source}>
              {t.source(saved.source, saved.builtIn && saved.source === "workspace" ? reviewerName(saved.builtIn) : null)}
            </p>
          )}
        </div>
        {saved && (
          <span className="settings-current" title={t.inUse}>
            {saved.harness === "claude" ? "Claude Code" : "Codex"} ·{" "}
            {saved.harness === "codex" && saved.model === "gpt-6.1-sol"
              ? "GPT-6.1 Sol"
              : models.find((m) => m.model === saved.model)?.displayName || saved.model}
          </span>
        )}
      </header>
      {draft && (
        <div className="settings-group">
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.harness}</span>
              <span className="settings-row-help">{t.harnessHelp}</span>
            </span>
            <select
              className="settings-select"
              aria-label={t.harnessLabel}
              value={draft.harness}
              disabled={saving}
              onChange={(e) => {
                const harness = e.target.value as Settings["harness"];
                setError("");
                setDraft({
                  harness,
                  model:
                    harness === "codex"
                      ? "gpt-6.1-sol"
                      : saved?.harness === "claude"
                        ? saved.model
                        : "",
                });
              }}
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.model}</span>
              {draft.harness === "claude" && loading ? (
                <span className="settings-row-help" role="status">
                  {t.loadingModels}
                </span>
              ) : (
                <span className="settings-row-help">
                  {(draft.harness === "claude" && selected?.description) || t.modelHelp}
                </span>
              )}
            </span>
            <select
              className="settings-select"
              aria-label={t.modelLabel}
              value={draft.model}
              disabled={saving || (draft.harness === "claude" && loading)}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            >
              {draft.harness === "codex" ? (
                <option value="gpt-6.1-sol">GPT-6.1 Sol</option>
              ) : (
                <>
                  {!selected && (
                    <option value={draft.model}>
                      {draft.model || t.chooseModel}
                    </option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.model}>
                      {m.displayName}
                      {m.isDefault ? t.isDefault : ""}
                    </option>
                  ))}
                </>
              )}
            </select>
          </label>
          {/* Saving is offered only once something has changed. */}
          {(changed || saving || saved?.source === "workspace") && (
            <div className="settings-row settings-row-end">
              <div className="settings-row-action">
                {saved?.source === "workspace" && (
                  <button type="button" className="secondary-button" disabled={saving} onClick={() => void useBuiltIn()}>
                    {t.useBuiltIn}
                  </button>
                )}
                {(changed || saving) && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={
                      saving ||
                      !draft.model ||
                      (draft.harness === "claude" && (loading || !selected))
                    }
                    onClick={() => void save()}
                  >
                    {saving ? t.saving : t.save}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="updates-error github-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
