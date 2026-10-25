import { useEffect, useRef, useState } from "react";
import {
  Folder,
  LoaderCircle,
  Monitor,
  Plus,
  Server,
  Wifi,
} from "lucide-react";
import { api, errorText, post } from "./api";
import { langTag, useLanguage } from "./i18n";
import { newAgentText } from "./new-agent-text";
import { Modal } from "./components";
import { ChoiceChips } from "./ChoiceChips";
import { MachineEditor } from "./MachineEditor";
import type { Agent, Model, Project } from "./types";
import { activeProjects } from "./projects";
import { ImportCodexSession } from "./ImportCodexSession";
import { ImportClaudeSession } from "./ImportClaudeSession";
import { harnessName, runMachineCheck, type MachineCheck } from "./machine-checks";
import { LastCheck } from "./MachinesPage";
import {
  CLAUDE_MODES,
  CODEX_PRESETS,
  type AgentDefaultsView,
  claudeModeText,
  claudeModelText,
  codexModelText,
  codexPermissionText,
  readAgentDefaults,
  sourceText,
} from "./agent-defaults";

/** The dialog's choice of the harness's own default model, sent as `model: null` (T-190). */
const OWN_MODEL = "(the harness’s own default)";
import "./remote.css";

export interface WorkspaceMachine {
  id: string;
  name: string;
  kind: "local" | "ssh";
  target?: string;
  codex?: string;
  defaultCwd: string;
  /** Jobs there (SSH only, T-108): at most this many at once (absent: two),
   * what they may reserve together, and whether a limit the machine cannot
   * hold refuses the job (strict, what a new machine gets) or runs it and
   * says so (limited). Absent: the record-only mode of a machine saved
   * before limits; nothing is held. */
  maxJobs?: number;
  budget?: { cpuMillis: number; memoryMiB: number };
  limitMode?: "strict" | "limited";
  /** The most recent manual check, shared with the Machines page. */
  lastCheck?: MachineCheck | null;
}

/** How the dialog opens for /new and /resume (T-29): the tab, and for a
 * new Agent the machine, folder, harness and project to start from. */
export type CreateInitial = {
  nonce: number;
  mode: "new" | "existing" | "claude";
  harness?: "codex" | "claude";
  machineId?: string;
  cwd?: string;
  projectId?: string;
};

export function RemoteCreateAgent({
  open,
  initial = null,
  close,
  defaultCwd,
  disabled,
  onCreated,
  projects = [],
  initialProjectId = "",
  opencode = false,
}: {
  open: boolean;
  /** Where to start, once per opening (`nonce`); null is the usual start. */
  initial?: CreateInitial | null;
  close: () => void;
  defaultCwd: string;
  disabled: boolean;
  onCreated: (
    agent: Agent & { projectDefaultError?: string },
    source?: "imported" | "existing",
  ) => void;
  projects?: Project[];
  /** The project being viewed, if any; the user can still choose another. */
  initialProjectId?: string;
  /** Whether Core creates OpenCode Agents (`opencode.enabled` of /workspace). */
  opencode?: boolean;
}) {
  const language = useLanguage();
  const t = newAgentText(language);
  const localMachine: WorkspaceMachine = {
    id: "local",
    name: "Core host",
    kind: "local",
    defaultCwd,
  };
  const [machines, setMachines] = useState<WorkspaceMachine[]>([]);
  const [machineId, setMachineId] = useState("local");
  const machine = machines.find((m) => m.id === machineId) || localMachine;
  const remote = machine.kind === "ssh";
  const [loadingMachines, setLoadingMachines] = useState(false);
  const [machineError, setMachineError] = useState("");
  const [reload, setReload] = useState(0);
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState(defaultCwd);
  const [model, setModel] = useState("");
  /** This Agent's own reasoning effort ("" is the default), for Codex on the Core host. */
  const [effort, setEffort] = useState("");
  const [harness, setHarness] = useState<"codex" | "claude" | "opencode">("codex");
  // OpenCode is offered only while Core says it creates such Agents, and
  // only on the Core host, with OpenCode's own default model.
  const isOpenCode = harness === "opencode";
  useEffect(() => {
    if (!opencode && isOpenCode) setHarness("codex");
  }, [opencode, isOpenCode]);
  // The Workspace's defaults for new Agents (T-190): "unknown" from a Core
  // that doesn't report them. The harness starts on the default until this
  // Agent's own harness is chosen; a permission is sent only when chosen.
  const [defaults, setDefaults] = useState<AgentDefaultsView | "unknown" | null>(null);
  const harnessChosen = useRef(false);
  // The harness as last rendered, for the defaults' answer that arrives later.
  const harnessNow = useRef(harness);
  harnessNow.current = harness;
  const [permission, setPermission] = useState("");
  const [projectId, setProjectId] = useState(initialProjectId);
  const [saveDefault, setSaveDefault] = useState(false);
  const activeProjectList = activeProjects(projects);
  // A folder the user typed survives closing and reopening the dialog; only
  // a changed project or machine fills in that project's default again.
  const cwdTyped = useRef(false);
  const fillCwd = (folder: string) => {
    cwdTyped.current = false;
    setCwd(folder);
  };
  const project = activeProjectList.find((p) => p.id === projectId);
  const projectDefault = project?.defaultDirs[machineId] || "";
  /** A project's default folder pre-fills; it never restricts the folder. */
  const folderFor = (target: WorkspaceMachine, id: string) =>
    activeProjectList.find((p) => p.id === id)?.defaultDirs[target.id] ||
    target.defaultCwd ||
    (target.kind === "local" ? defaultCwd : "");
  const [models, setModels] = useState<Model[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const [modelReload, setModelReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"new" | "existing" | "claude">("new");
  const [importBusy, setImportBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [savingMachine, setSavingMachine] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const checkRequest = useRef(0);
  const locked = busy || savingMachine || importBusy;

  useEffect(() => {
    if (open && machineId === "local")
      setCwd((current) => current || defaultCwd);
  }, [open, defaultCwd, machineId]);

  useEffect(() => {
    if (!open) return;
    const id = projects.some((p) => p.id === initialProjectId && !p.archivedAt)
      ? initialProjectId
      : "";
    setSaveDefault(false);
    if (id !== projectId || !cwdTyped.current) fillCwd(folderFor(machine, id));
    setProjectId(id);
  }, [open, initialProjectId]);

  // After the effects above, so what /new or /resume asked for wins over
  // the usual start: a folder given counts as one the user typed.
  const startedFrom = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !initial || startedFrom.current === initial.nonce) return;
    startedFrom.current = initial.nonce;
    setMode(initial.mode);
    if (initial.harness || initial.machineId) {
      // As choosing them does: a model or a machine check of an earlier
      // opening is not this harness's or machine's.
      if (initial.harness) {
        harnessChosen.current = true;
        setHarness(initial.harness);
        setPermission("");
      }
      if (initial.machineId) setMachineId(initial.machineId);
      checkRequest.current += 1;
      setModel("");
      setCheckError("");
      setChecking(false);
      setError("");
    }
    // A project that is no longer active is not offered, as at the usual start.
    if (initial.projectId !== undefined)
      setProjectId(projects.some((p) => p.id === initial.projectId && !p.archivedAt) ? initial.projectId : "");
    if (initial.cwd) {
      cwdTyped.current = true;
      setCwd(initial.cwd);
    }
  }, [open, initial?.nonce]);

  useEffect(() => {
    if (!open || disabled || mode !== "new") return;
    const controller = new AbortController();
    setLoadingMachines(true);
    setMachineError("");
    api<{ machines: WorkspaceMachine[] }>("/machines", {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const registered = result.machines || [];
        setMachines(
          registered.some((m) => m.id === "local")
            ? registered
            : [localMachine, ...registered],
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setMachineError(errorText(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMachines(false);
      });
    return () => controller.abort();
  }, [open, disabled, defaultCwd, reload, mode]);

  useEffect(() => {
    if (!open || disabled || remote || mode !== "new") return;
    if (harness === "opencode") {
      // No list to load: the model is OpenCode's own default. A list still
      // loading for another harness was aborted above.
      setModels([]);
      setLoadingModels(false);
      setModelError("");
      return;
    }
    const controller = new AbortController();
    setModels([]);
    setLoadingModels(true);
    setModelError("");
    api<{ models: Model[] }>(
      harness === "claude" ? "/models?harness=claude" : "/models",
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setModels(result.models || []);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setModelError(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingModels(false);
      });
    return () => controller.abort();
  }, [open, disabled, remote, harness, modelReload, mode]);

  // Read on each opening, so a change in Settings or another client shows,
  // and again for the project chosen: its overrides come before the
  // Workspace's (T-190).
  useEffect(() => {
    if (!open || disabled || mode !== "new") return;
    const controller = new AbortController();
    void readAgentDefaults(controller.signal, projectId || undefined)
      .then((view) => {
        if (controller.signal.aborted) return;
        const fallback = view?.effective?.harness?.value;
        if (fallback !== "codex" && fallback !== "claude") {
          setDefaults("unknown");
          return;
        }
        setDefaults(view);
        // As choosing a harness does: a model or permission chosen for the
        // other harness (in a cancelled opening, or before this answer) is
        // not this one's.
        if (!harnessChosen.current && harnessNow.current !== fallback) {
          setHarness(fallback);
          setModel("");
          setPermission("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setDefaults("unknown");
      });
    return () => controller.abort();
  }, [open, disabled, mode, projectId]);
  const known = defaults && defaults !== "unknown" ? defaults : null;
  // A default model: Codex (with an effort) and Claude Code on the Core host
  // only, from a Core that reports them.
  const localCodex = harness === "codex" && !remote;
  const localClaude = harness === "claude" && !remote;
  const defaultModel = localCodex ? known?.effective.codexModel : localClaude ? known?.effective.claudeModel : undefined;
  const modelText = localClaude ? claudeModelText : codexModelText;
  const namedModel = localCodex && model && model !== OWN_MODEL ? models.find((m) => (m.model || m.id) === model) : undefined;
  useEffect(() => {
    // An effort belongs to the model chosen with it; the harness's own model is the Core host's.
    setEffort("");
    if (!localCodex && !localClaude && model === OWN_MODEL) setModel("");
  }, [model, localCodex, localClaude]);
  const defaultPermission =
    harness === "claude"
      ? known && { text: claudeModeText(known.effective.claudePermissionMode.value, language), source: known.effective.claudePermissionMode.source }
      : known && { text: codexPermissionText(known.effective.codexPermissionPreset.value, language), source: known.effective.codexPermissionPreset.source };
  // The model this Agent gets: its own, or the default it inherits.
  const chosenModel = models.find((m) => (m.model || m.id) === (model || (localClaude ? defaultModel?.value : "")));
  // Auto mode needs a model that supports it; where Core's catalog says this
  // one doesn't, a default of Auto mode is not sent for it.
  const autoUnavailable = harness === "claude" && !remote && chosenModel?.supportsAutoMode === false;
  const permissionConflict =
    autoUnavailable && !permission && known?.effective.claudePermissionMode.value === "auto";
  useEffect(() => {
    if (autoUnavailable && permission === "auto") setPermission("");
  }, [autoUnavailable, permission]);

  useEffect(() => {
    if (!open) {
      checkRequest.current += 1;
      setChecking(false);
      // A harness picked in a dialog that was cancelled is not this
      // Workspace's choice: the next opening starts on the default again.
      harnessChosen.current = false;
      setPermission("");
    }
  }, [open]);

  function selectMachine(selected: WorkspaceMachine) {
    checkRequest.current += 1;
    setMachineId(selected.id);
    fillCwd(folderFor(selected, projectId));
    setModel("");
    setCheckError("");
    setChecking(false);
    setError("");
  }

  function machineAdded(saved: WorkspaceMachine) {
    setMachines((current) => [
      ...(current.length ? current : [localMachine]),
      saved,
    ]);
    // An OpenCode Agent stays on the Core host; the machine is kept for later.
    if (!isOpenCode) selectMachine(saved);
    setAdding(false);
  }

  async function checkConnection() {
    if (disabled || checking) return;
    const request = ++checkRequest.current;
    const checked = machine.id;
    setChecking(true);
    setCheckError("");
    try {
      // Stored by Core, so the Machines page shows this same result.
      const result = await runMachineCheck(checked);
      setMachines((current) =>
        current.map((m) =>
          m.id === checked ? { ...m, lastCheck: result } : m,
        ),
      );
    } catch (e) {
      if (request === checkRequest.current) setCheckError(errorText(e));
    } finally {
      if (request === checkRequest.current) setChecking(false);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (disabled || locked || adding || checking || permissionConflict) return;
    setBusy(true);
    setError("");
    try {
      const agent = await post<Agent & { projectDefaultError?: string }>(
        "/agents",
        {
          name: name.trim(),
          cwd: cwd.trim(),
          machineId: machine.id,
          harness,
          // Left out, the default for new Agents; null, Codex's own default (T-190).
          ...(model === OWN_MODEL ? { model: null } : model.trim() ? { model: model.trim() } : {}),
          ...(effort && namedModel ? { reasoningEffort: effort } : {}),
          // Only this Agent's own choice; Core applies the default otherwise.
          ...(permission && harness === "codex" ? { permissionPreset: permission } : {}),
          ...(permission && harness === "claude" ? { permissionMode: permission } : {}),
          ...(projectId
            ? { projectId, saveProjectDefault: saveDefault && !!cwd.trim() }
            : {}),
        },
      );
      onCreated(agent);
      close();
      setName("");
      harnessChosen.current = false;
      setPermission("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(value) => !value && !locked && close()}
      title={mode === "new" ? t.newTitle : t.existingTitle}
      description={
        mode === "new" ? t.newDescription : mode === "claude" ? t.claudeDescription : t.codexDescription
      }
      lang={langTag(language)}
      closeLabel={t.close}
    >
      <div className="agent-create-modes" role="group" aria-label={t.setup}>
        <button
          type="button"
          aria-pressed={mode === "new"}
          disabled={locked}
          onClick={() => setMode("new")}
        >
          {t.newAgent}
        </button>
        <button
          type="button"
          aria-pressed={mode === "existing"}
          disabled={locked}
          onClick={() => setMode("existing")}
        >
          {t.existingCodex}
        </button>
        <button
          type="button"
          aria-pressed={mode === "claude"}
          disabled={locked}
          onClick={() => setMode("claude")}
        >
          {t.existingClaude}
        </button>
      </div>
      {mode === "existing" ? (
        <ImportCodexSession
          disabled={disabled}
          close={close}
          onCreated={onCreated}
          onBusyChange={setImportBusy}
        />
      ) : mode === "claude" ? (
        <ImportClaudeSession
          disabled={disabled}
          close={close}
          onCreated={onCreated}
          onBusyChange={setImportBusy}
          projects={projects}
          initialProjectId={projectId}
        />
      ) : (
        <form
          className="create-form remote-create"
          onSubmit={(e) => void create(e)}
        >
          <fieldset className="remote-form-fields" disabled={locked}>
            <label>
              {t.name}
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.namePlaceholder}
                required
                maxLength={60}
              />
            </label>
            <ChoiceChips
              label={t.harness}
              name="create-harness"
              value={harness}
              onChange={(value) => {
                harnessChosen.current = true;
                setHarness(value as "codex" | "claude" | "opencode");
                setPermission("");
                setModel("");
                if (value === "opencode" && remote)
                  selectMachine(machines.find((m) => m.kind === "local") || localMachine);
              }}
              choices={[
                { value: "codex", label: "Codex" },
                { value: "claude", label: "Claude Code" },
                ...(opencode ? [{ value: "opencode", label: "OpenCode", note: t.experimental }] : []),
              ]}
            />
            {known && (
              <p className="remote-field-note create-default-source" data-source={known.effective.harness.source}>
                {t.defaultHarness(sourceText(known.effective.harness.source, language), harnessName(known.effective.harness.value))}
              </p>
            )}
            <ChoiceChips
              label={t.whereToWork}
              name="create-machine"
              className="create-machines"
              value={machine.id}
              disabled={loadingMachines || adding}
              onChange={(value) => {
                const selected = machines.find((m) => m.id === value);
                if (selected) selectMachine(selected);
              }}
              choices={(machines.length ? machines : [localMachine]).map((m) => ({
                value: m.id,
                label: m.name,
                note: m.kind === "ssh" ? "SSH" : t.local,
                icon: m.kind === "ssh" ? <Server size={13} /> : <Monitor size={13} />,
                title: m.kind === "ssh" ? isOpenCode ? t.openCodeLocal : m.target : t.coreMachine,
                disabled: isOpenCode && m.kind === "ssh",
              }))}
              after={
                <button
                  type="button"
                  className="choice-chip-action"
                  aria-expanded={adding}
                  aria-controls="new-ssh-machine"
                  disabled={disabled || adding || loadingMachines || isOpenCode}
                  title={isOpenCode ? t.openCodeLocal : undefined}
                  onClick={() => setAdding(true)}
                >
                  <Plus size={13} /> {t.addMachine}
                </button>
              }
            />
            {loadingMachines && (
              <p className="remote-field-note" role="status">
                {t.loadingMachines}
              </p>
            )}
            {machineError && (
              <div className="remote-field-error" role="alert">
                <span>{t.machinesError(machineError)}</span>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => setReload((value) => value + 1)}
                >
                  {t.tryAgain}
                </button>
              </div>
            )}
            {adding ? (
              <MachineEditor
                id="new-ssh-machine"
                disabled={disabled}
                onBusyChange={setSavingMachine}
                onCancel={() => setAdding(false)}
                onSaved={machineAdded}
                language={language}
              />
            ) : (
              <div className="remote-machine-status">
                <LastCheck check={machine.lastCheck} checking={checking} compact language={language} />
                <button
                  type="button"
                  className="quiet-button"
                  disabled={disabled || checking}
                  onClick={() => void checkConnection()}
                >
                  {checking ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Wifi size={14} />
                  )}
                  {checking ? t.checking : t.testConnection}
                </button>
              </div>
            )}
            {!adding && checkError && (
              <p className="remote-field-error" role="alert">
                {checkError}
              </p>
            )}
            <label>
              {t.folder}
              <div className="input-with-icon">
                <Folder size={15} />
                <input
                  value={cwd}
                  onChange={(e) => {
                    cwdTyped.current = true;
                    setCwd(e.target.value);
                  }}
                  placeholder={
                    remote ? "/Users/you/projects" : "/path/to/your/project"
                  }
                  required
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              </div>
              <span className="field-hint">
                {t.folderOn(remote ? machine.name : null, project && projectDefault ? project.name : null)}
              </span>
            </label>
            <ChoiceChips
              label={t.project}
              name="create-project"
              value={projectId}
              onChange={(value) => {
                setProjectId(value);
                setSaveDefault(false);
                fillCwd(folderFor(machine, value));
              }}
              choices={[
                { value: "", label: t.noProject },
                ...activeProjectList.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
            {project && cwd.trim() && cwd.trim() !== projectDefault && (
              <label className="create-project-default">
                <input
                  type="checkbox"
                  checked={saveDefault}
                  onChange={(e) => setSaveDefault(e.target.checked)}
                />
                {projectDefault ? t.makeDefault(project.name, machine.name) : t.saveDefault(project.name, machine.name)}
              </label>
            )}
            {isOpenCode ? (
              <p className="remote-field-note">{t.openCodeNote}</p>
            ) : remote ? (
              <label>
                {t.model}
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={t.harnessDefault}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              </label>
            ) : (
              <ChoiceChips
                label={t.model}
                name="create-model"
                value={model}
                disabled={loadingModels}
                onChange={setModel}
                choices={[
                  defaultModel
                    ? { value: "", label: t.defaultIs(modelText(defaultModel.value, language)), note: sourceText(defaultModel.source, language) }
                    : { value: "", label: t.harnessDefault },
                  // Only where it differs from the default: Codex's own, whatever is inherited.
                  ...(defaultModel?.value ? [{ value: OWN_MODEL, label: modelText(null, language) }] : []),
                  ...models.map((m) => ({
                    value: m.model || m.id,
                    label: m.displayName,
                    note: m.isDefault ? t.defaultNote : undefined,
                    title: m.description || undefined,
                  })),
                ]}
              />
            )}
            {!remote && loadingModels && (
              <p className="remote-field-note" role="status">
                <LoaderCircle size={13} className="spin" /> {t.loadingModels(harnessName(harness))}
              </p>
            )}
            {!remote && modelError && (
              <div
                className="remote-field-error model-catalog-error"
                role="alert"
              >
                <span>{t.modelsError(modelError)}</span>
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => setModelReload((n) => n + 1)}
                >
                  {t.retryModels}
                </button>
              </div>
            )}
            {!remote &&
              !isOpenCode &&
              !loadingModels &&
              !modelError &&
              models.length === 0 && (
                <p className="remote-field-note">{t.noModels}</p>
              )}
            {!remote &&
              models.find((m) => (m.model || m.id) === model)?.description && (
                <p className="remote-field-note">
                  {models.find((m) => (m.model || m.id) === model)?.description}
                </p>
              )}
            {localCodex && namedModel && !!namedModel.supportedReasoningEfforts?.length && (
              <ChoiceChips
                label={t.effort}
                name="create-effort"
                value={effort}
                onChange={setEffort}
                choices={[
                  { value: "", label: t.modelsOwn(namedModel.defaultReasoningEffort ?? null) },
                  ...(namedModel.supportedReasoningEfforts ?? []).map((e) => ({ value: e.reasoningEffort, label: e.reasoningEffort, title: e.description || undefined })),
                ]}
              />
            )}
            {localCodex && !model && defaultModel?.value && (
              <p className="remote-field-note create-default-source" data-source={defaultModel.source}>
                {t.effortWith(known?.effective.codexReasoningEffort?.value || null)}
              </p>
            )}
            {remote && (
              <p className="remote-field-note">
                {t.remoteModel(
                  harnessName(harness),
                  machine.name,
                  !!(harness === "codex" ? known?.effective.codexModel?.value : harness === "claude" ? known?.effective.claudeModel?.value : null),
                )}
              </p>
            )}
            {!isOpenCode && (
              <ChoiceChips
                label={t.permissions}
                name="create-permissions"
                value={permission}
                onChange={setPermission}
                choices={[
                  {
                    value: "",
                    label: t.defaultIs(defaultPermission ? defaultPermission.text : t.unreported),
                    note: defaultPermission ? sourceText(defaultPermission.source, language) : undefined,
                  },
                  ...(harness === "claude"
                    ? CLAUDE_MODES.map((mode) => ({
                        value: mode,
                        label: claudeModeText(mode, language),
                        disabled: mode === "auto" && autoUnavailable,
                        note: mode === "auto" && autoUnavailable ? t.notForModel : undefined,
                      }))
                    : CODEX_PRESETS.map((preset) => ({ value: preset, label: codexPermissionText(preset, language) }))),
                ]}
              />
            )}
            {permissionConflict && (
              <p className="remote-field-error" role="alert">
                {t.autoConflict}
              </p>
            )}
            {!isOpenCode && (
              <p className="remote-field-note">
                {harness === "codex" ? t.codexPermissionNote : t.claudePermissionNote}
              </p>
            )}
            {!isOpenCode && (
              <p className="remote-login-note">
                <Server size={13} />
                <span>{t.login(harnessName(harness), remote ? machine.name : null)}</span>
              </p>
            )}
          </fieldset>
          {disabled && (
            <p className="field-hint">{t.createDisabled}</p>
          )}
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={close}
              disabled={locked}
            >
              {t.cancel}
            </button>
            <button
              className="primary-button"
              disabled={
                disabled ||
                locked ||
                adding ||
                checking ||
                !name.trim() ||
                !cwd.trim() ||
                permissionConflict
              }
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Plus size={15} />
              )}
              {busy ? t.creating : t.create}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
