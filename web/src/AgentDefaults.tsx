import { useEffect, useState } from "react";
import { errorText } from "./api";
import {
  CLAUDE_MODES,
  CODEX_PRESETS,
  type AgentDefaultsChange,
  type AgentDefaultsView,
  changeAgentDefaults,
  claudeModeText,
  codexPermissionText,
  harnessName,
  readAgentDefaults,
  sourceText,
} from "./agent-defaults";

/** One choice in the editor: "" is the built-in behaviour (no Workspace choice). */
type Draft = { harness: string; codexPermissionPreset: string; claudePermissionMode: string };
const draftOf = (view: AgentDefaultsView): Draft => ({
  harness: view.saved.harness ?? "",
  codexPermissionPreset: view.saved.codexPermissionPreset ?? "",
  claudePermissionMode: view.saved.claudePermissionMode ?? "",
});
const FIELDS = ["harness", "codexPermissionPreset", "claudePermissionMode"] as const;

/**
 * New Agent defaults (T-190): the Workspace's own choice of harness and of
 * each harness's permissions, used only when an Agent is created. "Built in"
 * is no choice at all; choosing it deletes the Workspace's value rather than
 * copying Yuzuno's. Existing Agents keep their own settings, and a machine
 * still decides at start whether it allows a permission.
 */
export function AgentDefaults({ active }: { active: boolean }) {
  const [view, setView] = useState<AgentDefaultsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const adopt = (next: AgentDefaultsView) => {
    setView(next);
    setDraft(draftOf(next));
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError("");
    void readAgentDefaults(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) adopt(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [active]);
  const savedDraft = view ? draftOf(view) : null;
  const changes: AgentDefaultsChange = {};
  if (draft && savedDraft) {
    for (const field of FIELDS) {
      if (draft[field] !== savedDraft[field]) (changes as Record<string, string | null>)[field] = draft[field] || null;
    }
  }
  const changed = Object.keys(changes).length > 0;
  const anySaved = !!savedDraft && FIELDS.some((field) => savedDraft[field]);
  async function save(change: AgentDefaultsChange) {
    if (saving) return;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      adopt(await changeAgentDefaults(change));
      setStatus("Saved. Agents created from now on use these; existing Agents keep their settings.");
    } catch (e) {
      // The choice stays as made, to save again or change.
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  const effective = view?.effective;
  const set = (field: keyof Draft) => (event: React.ChangeEvent<HTMLSelectElement>) => {
    setStatus("");
    setDraft((old) => (old ? { ...old, [field]: event.target.value } : old));
  };
  return (
    <section
      id="settings-agent-defaults"
      className="settings-section agent-defaults-settings"
      aria-label="New Agent defaults"
    >
      <header className="settings-section-heading">
        <div>
          <h3>New Agent defaults</h3>
          <p>
            Used when an Agent is created, here or by another client. Existing Agents keep their own settings; change
            those from each Agent.
          </p>
        </div>
        {effective && (
          <span className="settings-current" title="What a new Agent gets now">
            {harnessName(effective.harness.value)} ·{" "}
            {effective.harness.value === "claude"
              ? claudeModeText(effective.claudePermissionMode.value)
              : codexPermissionText(effective.codexPermissionPreset.value)}
          </span>
        )}
      </header>
      {draft && view && effective && (
        <div className="settings-group">
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">Harness</span>
              <span className="settings-row-help agent-default-source" data-source={effective.harness.source}>
                {sourceText(effective.harness.source)}: {harnessName(effective.harness.value)}. The create dialog starts
                on it; you can pick another for each Agent.
              </span>
            </span>
            <select
              className="settings-select"
              aria-label="Harness for new Agents"
              value={draft.harness}
              disabled={saving}
              onChange={set("harness")}
            >
              <option value="">Built in · {harnessName(view.builtIn.harness)}</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">Codex permissions</span>
              <span className="settings-row-help agent-default-source" data-source={effective.codexPermissionPreset.source}>
                {sourceText(effective.codexPermissionPreset.source)}:{" "}
                {codexPermissionText(effective.codexPermissionPreset.value)}.
              </span>
              <span className="settings-row-help">
                Follow Codex config uses each machine’s own Codex configuration; the others are Yuzuno’s choice.
                Whether a machine allows it is checked when the Agent starts there.
              </span>
            </span>
            <select
              className="settings-select"
              aria-label="Codex permissions for new Agents"
              value={draft.codexPermissionPreset}
              disabled={saving}
              onChange={set("codexPermissionPreset")}
            >
              <option value="">Built in · {codexPermissionText(null)}</option>
              {CODEX_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {codexPermissionText(preset)}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">Claude Code permissions</span>
              <span className="settings-row-help agent-default-source" data-source={effective.claudePermissionMode.source}>
                {sourceText(effective.claudePermissionMode.source)}:{" "}
                {claudeModeText(effective.claudePermissionMode.value)}.
              </span>
              <span className="settings-row-help">
                Auto mode needs a model that supports it. Each Agent shows the mode its session reports.
              </span>
            </span>
            <select
              className="settings-select"
              aria-label="Claude Code permissions for new Agents"
              value={draft.claudePermissionMode}
              disabled={saving}
              onChange={set("claudePermissionMode")}
            >
              <option value="">Built in · {claudeModeText(view.builtIn.claudePermissionMode)}</option>
              {CLAUDE_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {claudeModeText(mode)}
                </option>
              ))}
            </select>
          </label>
          <div className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">Model and reasoning</span>
              <span className="settings-row-help">
                Chosen for each Agent when it is created. Model lists differ per machine, so there is no Workspace
                default for them yet.
              </span>
            </span>
          </div>
          {(changed || saving || anySaved) && (
            <div className="settings-row settings-row-end">
              <div className="settings-row-action">
                {anySaved && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={saving}
                    onClick={() => void save({ harness: null, codexPermissionPreset: null, claudePermissionMode: null })}
                  >
                    Use built-in for all
                  </button>
                )}
                {changed && (
                  <button type="button" className="primary-button" disabled={saving} onClick={() => void save(changes)}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {status && (
        <p className="settings-row-help" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="updates-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
