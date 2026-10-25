import { useEffect, useRef, useState } from "react";
import { ChevronDown, LoaderCircle, Settings2 } from "lucide-react";
import { api, errorText, post } from "./api";
import { Modal } from "./components";
import { ChoiceChips } from "./ChoiceChips";
import type { Agent, AgentSettings as Settings, ContextUsage, Model, PermissionCatalog } from "./types";
import { CodexContextSettings, tokenSetting } from "./CodexContextSettings";
import type { CodexContextSettings as ContextSettings } from "./types";
import { CodexPermissions } from "./CodexPermissions";
import "./agent-settings.css";

const defaults: Settings = {
  reasoningEffort: null,
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
};
const chosenMode = (agent: Agent) =>
  agent.settings?.permissionMode === "auto" ? "auto" : "default";
export function AgentSettings({
  agent,
  disabled,
  onSaved,
  onOpenChange,
  observedPermissionMode,
  observedEffort,
  observedContextUsage,
  request,
  onRequestOpened,
}: {
  agent: Agent;
  disabled?: boolean;
  onSaved: () => void;
  onOpenChange?: (open: boolean) => void;
  /** Mode the live Claude session reports, which may differ from the choice. */
  observedPermissionMode?: string | null;
  /** Effort Claude Code reported for a turn, and whether that is the latest. */
  observedEffort?: { level: string; latest: boolean } | null;
  observedContextUsage?: ContextUsage | null;
  /** The composer's `/model [name]`: open, preselecting that model. */
  request?: { model: string; nonce: number; agentId?: string; section?: "model" | "context" } | null;
  /** Called once the dialog has actually opened for `request`. */
  onRequestOpened?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const requested = useRef("");
  // A request made before this mount (for another Agent) is not this one's.
  const seen = useRef(request?.agentId === agent.id ? undefined : request?.nonce);
  const form = useRef<HTMLFormElement>(null);
  const focusContext = useRef(false);
  const claude = agent.harness === "claude";
  const [reload, setReload] = useState(0);
  const [models, setModels] = useState<Model[]>([]);
  const [permissions, setPermissions] = useState<PermissionCatalog>();
  const [context, setContext] = useState<ContextSettings>();
  const [contextWindow, setContextWindow] = useState("");
  const [compactLimit, setCompactLimit] = useState("");
  const [contextNote, setContextNote] = useState("");
  const [model, setModel] = useState(agent.model);
  const [settings, setSettings] = useState<Settings>(
    agent.settings || defaults,
  );
  // Sessions start only in a mode the user chose; older records may hold a
  // mode Claude reported (e.g. accept edits), which is not a choice.
  const currentMode = chosenMode(agent);
  const [permissionMode, setPermissionMode] = useState(currentMode);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [effortNote, setEffortNote] = useState("");
  useEffect(() => {
    if (!open) return;
    let valid = true;
    setLoading(true);
    setError("");
    setEffortNote("");
    setModels([]);
    setPermissions(undefined);
    setModel(agent.model);
    setSettings(agent.settings || defaults);
    setContextWindow(String(agent.settings?.contextWindow ?? ""));
    setCompactLimit(String(agent.settings?.autoCompactTokenLimit ?? ""));
    setContext(undefined);
    setContextNote("");
    setPermissionMode(chosenMode(agent));
    api<{ models: Model[]; permissions?: PermissionCatalog; context?: ContextSettings }>(`/agents/${encodeURIComponent(agent.id)}/models`)
      .then(({ models, permissions, context }) => {
        if (!valid) return;
        setModels(models);
        setPermissions(permissions);
        setContext(context);
        const wanted = requested.current;
        requested.current = "";
        if (wanted) {
          const row = models.find((m) => m.model === wanted || m.id === wanted);
          // Chosen exactly as its chip would choose it; only Save keeps it.
          if (row && (row.model || row.id) !== agent.model) {
            selectModel(row.model || row.id, models, agent.settings?.reasoningEffort || "");
            return;
          }
          if (!row) setError(`“${wanted}” is not a model this Agent's ${agent.harness === "claude" ? "Claude Code" : "Codex"} offers; choose one below.`);
        }
        // A Claude effort is only ever the user's choice; no default fills it.
        if (agent.harness === "claude") return;
        const selected = models.find((m) => (m.model || m.id) === agent.model);
        setSettings((s) => ({
          ...s,
          reasoningEffort:
            s.reasoningEffort || selected?.defaultReasoningEffort || null,
        }));
      })
      .catch((e) => valid && setError(errorText(e)))
      .finally(() => valid && setLoading(false));
    return () => {
      valid = false;
    };
  }, [open, agent.id, agent.harness, reload]);
  useEffect(() => {
    if (!open || observedContextUsage === undefined) return;
    setContext((current) => current && ({ ...current,
      observedWindowTokens: observedContextUsage?.windowTokens ?? null,
      observedStale: observedContextUsage?.stale ?? false,
    }));
  }, [open, observedContextUsage]);
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  function changeOpen(next: boolean) {
    if (saving) return;
    setOpen(next);
    onOpenChange?.(next);
  }
  useEffect(() => {
    if (!request || (request.agentId && request.agentId !== agent.id) || request.nonce === seen.current || disabled) return;
    seen.current = request.nonce;
    requested.current = request.model;
    focusContext.current = request.section === "context";
    // Already open: read the catalog again so the requested model is chosen.
    if (open) setReload((n) => n + 1);
    else if (saving) return;
    else changeOpen(true);
    onRequestOpened?.();
    // Only a new request opens it; nothing else here reopens the dialog.
  }, [request?.nonce]);
  useEffect(() => {
    if (!open || loading || !focusContext.current) return;
    const fieldset = form.current?.querySelector<HTMLElement>(".codex-context-settings");
    if (fieldset) {
      focusContext.current = false;
      fieldset.tabIndex = -1;
      fieldset.focus();
      fieldset.scrollIntoView?.({ block: "start" });
    }
  }, [open, loading, request?.nonce]);
  const selected = models.find((m) => (m.model || m.id) === model);
  const efforts = selected?.supportedReasoningEfforts || [];
  // Claude's levels come from the chosen model's catalog row; no model is
  // Claude Code's default model, the catalog's "default" row.
  const effortRow = (m: string) =>
    models.find((row) => (row.model || row.id) === (m || "default"));
  const levelsFor = (row?: Model) =>
    row?.supportsEffort ? row.supportedEffortLevels || [] : [];
  const claudeEffortRow = claude ? effortRow(model) : undefined;
  const effortLevels = levelsFor(claudeEffortRow);
  const claudeEffort = claude ? settings.reasoningEffort || "" : "";
  // Without the model's row (catalog loading or failed) the saved effort
  // can be neither offered nor refused; Core checks it again on save.
  const effortUnlisted = !!claudeEffort && !effortLevels.includes(claudeEffort);
  // Choosing a model, from its chip or from the composer's /model: the same
  // switch either way, against `catalog` and the effort chosen so far.
  // Nothing is saved until Save.
  function selectModel(value: string, catalog: Model[], effort: string) {
    setModel(value);
    if (claude) {
      // A chosen effort survives a model switch only if the new model takes
      // it; otherwise say so and fall back to default.
      const row = catalog.find((r) => (r.model || r.id) === (value || "default"));
      if (effort && !levelsFor(row).includes(effort)) {
        setSettings((s) => ({ ...s, reasoningEffort: null }));
        setEffortNote(
          `${row?.displayName || value || "This model"} does not take reasoning effort ${effort}; it is back to Claude Code default.`,
        );
      } else setEffortNote("");
      return;
    }
    setContextWindow(""); setCompactLimit("");
    setContextNote("Context overrides reset to automatic for the new model. Save, then apply when idle.");
    setSettings((s) => ({
      ...s,
      reasoningEffort: catalog.find((m) => (m.model || m.id) === value)?.defaultReasoningEffort || null,
    }));
  }
  const effortRefused = effortUnlisted && !!claudeEffortRow;
  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const window = claude ? null : tokenSetting(contextWindow);
      const compact = claude ? null : tokenSetting(compactLimit);
      if (window !== null && compact !== null && compact > window) throw new Error("The compaction threshold cannot exceed the configured window.");
      const contextChanged = !claude && (window !== (agent.settings?.contextWindow ?? null) || compact !== (agent.settings?.autoCompactTokenLimit ?? null));
      await post(`/agents/${encodeURIComponent(agent.id)}/settings`, {
        model,
        // Claude always receives the chosen mode: saving also returns a live
        // session from a mode Claude switched to, and replaces older records.
        ...(claude
          ? { permissionMode, effort: claudeEffort || null }
          : { settings: { ...settings, contextWindow: window, autoCompactTokenLimit: compact } }),
      });
      onSaved();
      if (contextChanged) {
        // Saved. What follows only reads the context status again, which
        // needs Codex; its failure must not read as a failed save (T-187).
        setContextNote("Saved. Apply them when this conversation is idle.");
        try {
          const updated = await api<{ context: ContextSettings }>(`/agents/${encodeURIComponent(agent.id)}/models`);
          setContext(updated.context);
        } catch (e) {
          setContextNote(`Saved, but the context status couldn’t be read again (${errorText(e)}). Refresh it before applying.`);
        }
        return;
      }
      setOpen(false);
      onOpenChange?.(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  async function applyContext() {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const applied = await post<ContextSettings>(`/agents/${encodeURIComponent(agent.id)}/context/apply`, {});
      setContext(applied); setContextNote("Reload requested for this same conversation. The available window above updates when Codex reports it.");
      onSaved();
    } catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  }
  async function resetContext() {
    if (saving) return;
    setSaving(true); setError("");
    try {
      await post(`/agents/${encodeURIComponent(agent.id)}/settings`, {
        model: agent.model,
        settings: { ...(agent.settings || defaults), contextWindow: null, autoCompactTokenLimit: null },
      });
      setContextWindow(""); setCompactLimit("");
      setContext((current) => current && ({ ...current, requestedWindowTokens: null, settingsSubmitted: false, observedStale: true }));
      setContextNote("Saved context overrides cleared. Reconnect to use your Codex configuration, or apply when available and idle.");
      onSaved();
    } catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  }
  async function refreshContext() {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const updated = await api<{ context: ContextSettings }>(`/agents/${encodeURIComponent(agent.id)}/models`);
      setContext(updated.context);
    } catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  }
  return (
    <>
      <button
        type="button"
        className="conversation-action agent-settings-button"
        aria-label="Agent settings"
        title={
          claude
            ? "Claude Code model, reasoning effort and approvals"
            : "Model, reasoning and permissions"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => changeOpen(true)}
      >
        <Settings2 size={16} />
        <span>
          Model
          <span className="reasoning-label">
            {" "}
            &amp; {claude ? "approvals" : "reasoning"}
          </span>
        </span>
        <ChevronDown size={12} className="settings-chevron" />
      </button>
      <Modal
        open={open}
        onOpenChange={changeOpen}
        title={`${agent.name} · Agent settings`}
        description={
          claude
            ? "The model and reasoning effort apply from the next turn; a running turn keeps its own, and this conversation stays together. Approvals apply to Claude’s next permission check, including in a running turn."
            : "Model, effort and permissions apply to new turns. The current turn and pending requests keep their existing permissions. Context settings need a separate safe reload while the conversation is idle."
        }
      >
        <form
          ref={form}
          className="agent-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="agent-settings-location">
            Execution machine: {agent.remote?.machine.name || "Core host"}
          </p>
          {loading && (
            <p role="status">
              <LoaderCircle size={14} className="spin" /> Loading this agent’s
              model catalog…
            </p>
          )}
          <div className="agent-setting">
            <ChoiceChips
              label="Model"
              name="agent-model"
              value={model}
              disabled={loading || saving}
              onChange={(value) => selectModel(value, models, claudeEffort)}
              choices={[
                ...(claude ? [{ value: "", label: "Harness default" }] : []),
                // The model in use stays shown while the catalog loads, or
                // when the catalog no longer lists it.
                ...(!selected && model
                  ? [{ value: model, label: model, note: "current" }]
                  : []),
                ...models.map((m) => ({
                  value: m.model || m.id,
                  label: m.displayName,
                  note: m.isDefault ? "default" : undefined,
                  title: m.description || undefined,
                })),
              ]}
            />
            {selected?.description && (
              <small className="model-catalog-note">{selected.description}</small>
            )}
          </div>
          {claude && (
            <div className="agent-setting">
              <ChoiceChips
                label="Reasoning effort"
                name="agent-effort"
                value={claudeEffort}
                disabled={loading || saving}
                onChange={(value) => {
                  setEffortNote("");
                  setSettings((s) => ({
                    ...s,
                    reasoningEffort: value || null,
                  }));
                }}
                choices={[
                  { value: "", label: "Claude Code default" },
                  ...(effortUnlisted
                    ? [
                        {
                          value: claudeEffort,
                          label: claudeEffort,
                          note: effortRefused
                            ? "not available for this model"
                            : undefined,
                        },
                      ]
                    : []),
                  ...effortLevels.map((level) => ({ value: level, label: level })),
                ]}
              />
              <small>
                {effortRefused
                  ? "This model does not take the saved effort. Choose another, or Claude Code default."
                  : claudeEffortRow && !claudeEffortRow.supportsEffort
                    ? "This model does not take a reasoning effort."
                    : claudeEffort
                      ? "Claude runs at this effort from the next turn."
                      : "Claude Code decides: the model’s default, or the effort in your Claude settings when a session starts."}
              </small>
              {effortNote && (
                <small className="model-catalog-note" role="status">
                  {effortNote}
                </small>
              )}
              {observedEffort && (
                <small className="model-catalog-note">
                  Claude Code reported {observedEffort.level} for{" "}
                  {observedEffort.latest ? "the latest turn" : "an earlier turn"}
                  .
                </small>
              )}
            </div>
          )}
          {claude && (
            <div className="agent-setting">
              <ChoiceChips
                label="Approvals"
                name="agent-approvals"
                value={permissionMode}
                disabled={saving}
                onChange={setPermissionMode}
                choices={[
                  { value: "default", label: "Ask before actions" },
                  {
                    value: "auto",
                    label: "Auto mode",
                    disabled: selected?.supportsAutoMode === false,
                    note:
                      selected?.supportsAutoMode === false
                        ? "not available for this model"
                        : undefined,
                  },
                ]}
              />
              <small>
                {permissionMode === "auto"
                  ? "Claude Code’s classifier approves or blocks each action. It still asks when it cannot decide, and for questions."
                  : "Claude asks before any action its permission rules do not already allow."}
              </small>
              {observedPermissionMode &&
                observedPermissionMode !== currentMode && (
                  <small className="model-catalog-note">
                    This session is currently in {observedPermissionMode} mode.
                    Saving applies the mode chosen here to it now.
                  </small>
                )}
            </div>
          )}
          {!claude && (
            <>
              <div className="agent-setting">
                <ChoiceChips
                  label="Reasoning effort"
                  name="agent-effort"
                  value={settings.reasoningEffort || ""}
                  disabled={loading || saving || !efforts.length}
                  onChange={(value) =>
                    setSettings((s) => ({
                      ...s,
                      reasoningEffort: value,
                    }))
                  }
                  choices={[
                    // A saved effort the model no longer lists stays shown.
                    ...(settings.reasoningEffort &&
                    !efforts.some(
                      (e) => e.reasoningEffort === settings.reasoningEffort,
                    )
                      ? [
                          {
                            value: settings.reasoningEffort,
                            label: settings.reasoningEffort,
                            note: "current",
                          },
                        ]
                      : []),
                    ...efforts.map((e) => ({
                      value: e.reasoningEffort,
                      label: e.reasoningEffort,
                    })),
                  ]}
                />
                <small>
                  {efforts.find(
                    (e) => e.reasoningEffort === settings.reasoningEffort,
                  )?.description ||
                    (!efforts.length && !loading ? "Choose a model to see its reasoning efforts." : "")}
                </small>
              </div>
              <CodexContextSettings context={context} window={contextWindow} compact={compactLimit}
                disabled={loading || saving} note={contextNote} onWindow={setContextWindow} onCompact={setCompactLimit}
                onApply={() => void applyContext()} onRefresh={() => void refreshContext()}
                onReset={agent.settings?.contextWindow != null || agent.settings?.autoCompactTokenLimit != null
                  ? () => void resetContext() : undefined} />
              <CodexPermissions
                settings={settings}
                catalog={permissions}
                disabled={loading || saving}
                onChange={setSettings}
              />
            </>
          )}
          {error && (
            <div role="alert" className="inline-error model-catalog-error">
              <span>{error}</span>
              <button
                className="quiet-button"
                type="button"
                disabled={loading || saving}
                onClick={() => setReload((n) => n + 1)}
              >
                Retry models
              </button>
            </div>
          )}
          <div className="button-row">
            <button
              type="submit"
              className="primary-button"
              disabled={
                saving ||
                loading ||
                (claude
                  ? (!!model && !selected) || effortUnlisted
                  : !selected ||
                    !efforts.some(
                      (e) => e.reasoningEffort === settings.reasoningEffort,
                    ))
              }
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
