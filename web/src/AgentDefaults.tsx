import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import type { Model } from "./types";
import {
  CLAUDE_MODES,
  CODEX_PRESETS,
  type AgentDefaultsChange,
  type AgentDefaultsView,
  type SavedDefaults,
  changeAgentDefaults,
  changeProjectAgentDefaults,
  claudeModeText,
  codexModelText,
  codexPermissionText,
  harnessName,
  readAgentDefaults,
  sourceText,
} from "./agent-defaults";

/** One choice in the editor: "" is no choice here (built in for the
 * Workspace; inherited for a project). */
type Draft = { harness: string; codexPermissionPreset: string; claudePermissionMode: string; codexModel: string; codexReasoningEffort: string };
const draftFrom = (saved: SavedDefaults): Draft => ({
  harness: saved.harness ?? "",
  codexPermissionPreset: saved.codexPermissionPreset ?? "",
  claudePermissionMode: saved.claudePermissionMode ?? "",
  codexModel: saved.codexModel ?? "",
  codexReasoningEffort: saved.codexReasoningEffort ?? "",
});
const FIELDS = ["harness", "codexPermissionPreset", "claudePermissionMode", "codexModel", "codexReasoningEffort"] as const;
const modelName = (m: Model) => m.model || m.id;

/**
 * New Agent defaults (T-190): the Workspace's own choice of harness and of
 * each harness's permissions, used only when an Agent is created. "Built in"
 * is no choice at all; choosing it deletes the Workspace's value rather than
 * copying Yuzuno's. Existing Agents keep their own settings, and a machine
 * still decides at start whether it allows a permission.
 *
 * With `projectId`, the same fields for Agents created in that project: no
 * choice there inherits the Workspace's (or the built-in), and clearing one
 * deletes only that project's override.
 */
export function AgentDefaults({ active, projectId, disabled = false }: { active: boolean; projectId?: string; disabled?: boolean }) {
  const [view, setView] = useState<AgentDefaultsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  // The Core host's Codex catalog, for a default model and effort (T-190).
  const [models, setModels] = useState<Model[] | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const own = (from: AgentDefaultsView) => (projectId ? from.project?.saved ?? {} : from.saved);
  const draftOf = (from: AgentDefaultsView) => draftFrom(own(from));
  const adopt = (next: AgentDefaultsView) => {
    setView(next);
    setDraft(draftOf(next));
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError("");
    void readAgentDefaults(controller.signal, projectId)
      .then((value) => {
        if (!controller.signal.aborted) adopt(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, projectId]);
  // Only from a Core that has model defaults: an older one doesn't report them.
  const modelDefaults = !!view?.effective.codexModel;
  useEffect(() => {
    if (!active || !modelDefaults) return;
    const controller = new AbortController();
    setCatalogError("");
    void api<{ models: Model[] }>("/models", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setModels(result.models || []);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setCatalogError(errorText(e));
      });
    return () => controller.abort();
  }, [active, modelDefaults]);
  const savedDraft = view ? draftOf(view) : null;
  const changes: AgentDefaultsChange = {};
  if (draft && savedDraft) {
    for (const field of FIELDS) {
      if (draft[field] !== savedDraft[field]) (changes as Record<string, string | null>)[field] = draft[field] || null;
    }
  }
  const changed = Object.keys(changes).length > 0;
  const chosenModel = draft?.codexModel ? models?.find((m) => modelName(m) === draft.codexModel) : undefined;
  // A saved model the Core host no longer offers: shown, and said.
  const stale = !!draft?.codexModel && models !== null && !chosenModel;
  const anySaved = !!savedDraft && FIELDS.some((field) => savedDraft[field]);
  async function save(change: AgentDefaultsChange) {
    if (saving) return;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      adopt(await (projectId ? changeProjectAgentDefaults(projectId, change) : changeAgentDefaults(change)));
      setStatus(
        projectId
          ? "Saved for this project. Agents created in it from now on use these; existing Agents keep their settings."
          : "Saved. Agents created from now on use these; existing Agents keep their settings.",
      );
    } catch (e) {
      // The choice stays as made, to save again or change.
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  const effective = view?.effective;
  // What "no choice here" means: the built-in for the Workspace, what the project inherits for a project.
  const inherited = projectId ? view?.project?.inherited : undefined;
  const none = (text: string, source?: Parameters<typeof sourceText>[0]) =>
    projectId ? `Inherit · ${text} (${sourceText(source)})` : `Built in · ${text}`;
  const locked = saving || disabled;
  const set = (field: keyof Draft) => (event: React.ChangeEvent<HTMLSelectElement>) => {
    setStatus("");
    const value = event.target.value;
    setDraft((old) => {
      if (!old) return old;
      const next = { ...old, [field]: value };
      // An effort belongs to its model: one the new model doesn't offer goes.
      if (field === "codexModel") {
        const offered = models?.find((m) => modelName(m) === value)?.supportedReasoningEfforts?.some((e) => e.reasoningEffort === old.codexReasoningEffort);
        if (!offered) next.codexReasoningEffort = "";
      }
      return next;
    });
  };
  return (
    <section
      id={projectId ? undefined : "settings-agent-defaults"}
      className="settings-section agent-defaults-settings"
      aria-label={projectId ? "New Agent defaults for this project" : "New Agent defaults"}
    >
      <header className="settings-section-heading">
        <div>
          <h3>New Agent defaults</h3>
          <p>
            {projectId
              ? "For Agents created in this project. A setting left to inherit uses the Workspace’s choice, or the built-in. Existing Agents keep their own settings."
              : "Used when an Agent is created, here or by another client. Existing Agents keep their own settings; change those from each Agent."}
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
              disabled={locked}
              onChange={set("harness")}
            >
              <option value="">
                {none(harnessName(inherited?.harness.value ?? view.builtIn.harness), inherited?.harness.source)}
              </option>
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
              disabled={locked}
              onChange={set("codexPermissionPreset")}
            >
              <option value="">
                {none(codexPermissionText(inherited ? inherited.codexPermissionPreset.value : null), inherited?.codexPermissionPreset.source)}
              </option>
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
              disabled={locked}
              onChange={set("claudePermissionMode")}
            >
              <option value="">
                {none(claudeModeText(inherited?.claudePermissionMode.value ?? view.builtIn.claudePermissionMode), inherited?.claudePermissionMode.source)}
              </option>
              {CLAUDE_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {claudeModeText(mode)}
                </option>
              ))}
            </select>
          </label>
          {effective.codexModel ? (
            <>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">Codex model on the Core host</span>
                  <span className="settings-row-help agent-default-source" data-source={effective.codexModel.source}>
                    {sourceText(effective.codexModel.source)}: {codexModelText(effective.codexModel.value)}
                    {effective.codexReasoningEffort?.value ? `, reasoning effort ${effective.codexReasoningEffort.value}` : ""}.
                  </span>
                  <span className="settings-row-help">
                    {view.modelAppliesTo ??
                      "Codex Agents created on the Core host. SSH machines, Claude Code and OpenCode keep their own model and effort."}
                  </span>
                  {catalogError && (
                    <span className="settings-row-help updates-error" role="alert">
                      Couldn’t read this Core host’s Codex models: {catalogError}. A model can’t be chosen now.
                    </span>
                  )}
                  {stale && (
                    <span className="settings-row-help updates-error" role="alert">
                      {draft.codexModel} is no longer offered by this Core host’s Codex, so new Agents can’t use it.
                      Choose another, or {projectId ? "inherit" : "Built in"}.
                    </span>
                  )}
                </span>
                <select
                  className="settings-select"
                  aria-label="Codex model for new Agents"
                  value={draft.codexModel}
                  disabled={locked}
                  onChange={set("codexModel")}
                >
                  <option value="">
                    {none(codexModelText(inherited ? inherited.codexModel?.value : null), inherited?.codexModel?.source)}
                  </option>
                  {stale && <option value={draft.codexModel}>{draft.codexModel} (no longer offered)</option>}
                  {catalogError && draft.codexModel && !models && <option value={draft.codexModel}>{draft.codexModel}</option>}
                  {(models ?? []).map((m) => (
                    <option key={modelName(m)} value={modelName(m)}>
                      {m.displayName || modelName(m)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">Codex reasoning effort</span>
                  <span className="settings-row-help">
                    One the chosen model offers; with none chosen, the model’s own. Choose a model first.
                  </span>
                </span>
                <select
                  className="settings-select"
                  aria-label="Codex reasoning effort for new Agents"
                  value={draft.codexReasoningEffort}
                  disabled={locked || !chosenModel}
                  onChange={set("codexReasoningEffort")}
                >
                  <option value="">
                    Model’s own{chosenModel?.defaultReasoningEffort ? ` · ${chosenModel.defaultReasoningEffort}` : ""}
                  </option>
                  {(chosenModel?.supportedReasoningEfforts ?? []).map((e) => (
                    <option key={e.reasoningEffort} value={e.reasoningEffort}>
                      {e.reasoningEffort}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <div className="settings-row">
              <span className="settings-row-main">
                <span className="settings-row-title">Model and reasoning</span>
                <span className="settings-row-help">
                  Chosen for each Agent when it is created. Model lists differ per machine, so there is no Workspace
                  default for them yet.
                </span>
              </span>
            </div>
          )}
          {(changed || saving || anySaved) && (
            <div className="settings-row settings-row-end">
              <div className="settings-row-action">
                {anySaved && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={() =>
                      void save({
                        harness: null,
                        codexPermissionPreset: null,
                        claudePermissionMode: null,
                        // Only to a Core that has them: an older one refuses fields it doesn't know.
                        ...(modelDefaults ? { codexModel: null, codexReasoningEffort: null } : {}),
                      })
                    }
                  >
                    {projectId ? "Inherit all" : "Use built-in for all"}
                  </button>
                )}
                {changed && (
                  <button type="button" className="primary-button" disabled={locked} onClick={() => void save(changes)}>
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
