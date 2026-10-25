import { useEffect, useState } from "react";
import { api, errorText } from "./api";
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
export function ReviewSettings({ active }: { active: boolean }) {
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
      aria-label="Code review settings"
    >
      <header className="settings-section-heading">
        <div>
          <h3>Code review</h3>
          <p>
            Choose the reviewer for new PR reviews requested from tasks or by
            Agents. Running reviews keep their original settings.
          </p>
          {saved?.source && (
            <p className="settings-row-help review-settings-source" data-source={saved.source}>
              {saved.source === "workspace" ? "Set for this Workspace" : "Built in"}
              {saved.builtIn && saved.source === "workspace"
                ? `. Built in: ${reviewerName(saved.builtIn)}.`
                : "."}
            </p>
          )}
        </div>
        {saved && (
          <span className="settings-current" title="In use now">
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
              <span className="settings-row-title">Harness</span>
              <span className="settings-row-help">The runtime that reads the PR.</span>
            </span>
            <select
              className="settings-select"
              aria-label="Review Harness"
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
              <span className="settings-row-title">Model</span>
              {draft.harness === "claude" && loading ? (
                <span className="settings-row-help" role="status">
                  Loading native Claude models…
                </span>
              ) : (
                <span className="settings-row-help">
                  {(draft.harness === "claude" && selected?.description) ||
                    "Used for every new review."}
                </span>
              )}
            </span>
            <select
              className="settings-select"
              aria-label="Review model"
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
                      {draft.model || "Choose a model"}
                    </option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.model}>
                      {m.displayName}
                      {m.isDefault ? " · default" : ""}
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
                    Use built-in
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
                    {saving ? "Saving…" : "Save review settings"}
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
