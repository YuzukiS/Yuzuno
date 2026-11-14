import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { useSurfaceIn } from "./surface";
import { ChoiceChips } from "./ChoiceChips";
import { MachineEditor } from "./MachineEditor";
import type { Agent, Model, Project } from "./types";
import { activeProjects } from "./projects";
import { ImportCodexSession } from "./ImportCodexSession";
import { ImportClaudeSession } from "./ImportClaudeSession";
import { ImportOpenCodeSession } from "./ImportOpenCodeSession";
import { harnessName, runMachineCheck, type MachineCheck } from "./machine-checks";
import { DSH_LEVELS, DSH_NAME, dshAvailable, dshLevelName, type DshStatus } from "./dsh";
import { readKeys, type RoutingKey } from "./routing-keys";
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
import { Tip, TipText } from "./Tip";
import { FieldLength } from "./FieldLength";
import { coreLimits, overLimit } from "./core-limits";

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
  /** What it runs on as Core last learnt it (SSH only, YN-104): its newest
   * check that reached it, else its newest Job's at its current address;
   * null when neither has. "Darwin" is a Mac, whose Jobs always run limited
   * whatever limitMode says: macOS can't hold a limit. */
  platform?: string | null;
  /** Its Agents are kept contained there: no Codex Agent runs on it. */
  contained?: boolean;
  /** The most recent manual check, shared with the Machines page. */
  lastCheck?: MachineCheck | null;
}

/** How the dialog opens for /new and /resume (T-29): the tab, and for a
 * new Agent the machine, folder, harness and project to start from. */
export type CreateInitial = {
  nonce: number;
  mode: "new" | "existing" | "claude";
  harness?: "codex" | "claude" | "dsh";
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
  dsh = null,
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
    /** Whether Core says an import made the Agent; a create always does. */
    added?: boolean,
  ) => void;
  projects?: Project[];
  /** The project being viewed, if any; the user can still choose another. */
  initialProjectId?: string;
  /** Whether Core creates OpenCode Agents (`opencode.enabled` of /workspace):
   * yes unless it was started with them off (YN-27). Each entry is marked
   * experimental. */
  opencode?: boolean;
  /** `dsh` of /workspace (YN-119 W1): DeepSeek Harness is offered only while
   * Core says it starts it, on the Core host, with a DeepSeek key. */
  dsh?: DshStatus | null;
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
  const [harness, setHarness] = useState<"codex" | "claude" | "opencode" | "dsh">("codex");
  // OpenCode is offered only while Core says it creates such Agents, and
  // only on the Core host, with OpenCode's own default model.
  const isOpenCode = harness === "opencode";
  useEffect(() => {
    if (!opencode && isOpenCode) setHarness("codex");
  }, [opencode, isOpenCode]);
  // DeepSeek Harness likewise, while Core says it starts it (YN-119 W1).
  const offerDsh = dshAvailable(dsh);
  const isDsh = harness === "dsh";
  useEffect(() => {
    if (!offerDsh && isDsh) setHarness("codex");
  }, [offerDsh, isDsh]);
  // Both run on the Core host only.
  const hostOnly = isOpenCode || isDsh;
  const hostOnlyNote = isDsh ? t.dshLocal : t.openCodeLocal;
  // A DeepSeek Harness Agent's key: the Workspace's DeepSeek keys, read for it.
  const [dshKeys, setDshKeys] = useState<RoutingKey[] | null>(null);
  const [keysError, setKeysError] = useState("");
  const [keysReload, setKeysReload] = useState(0);
  const [keyId, setKeyId] = useState("");
  // The Workspace's defaults for new Agents (T-190): "unknown" from a Core
  // that doesn't report them. The harness starts on the default until this
  // Agent's own harness is chosen; a permission is sent only when chosen.
  const [defaults, setDefaults] = useState<AgentDefaultsView | "unknown" | null>(null);
  // While they are read, the harness and model choices wait, so an answer
  // that comes late never undoes a pick (T-19 ST:SX-14).
  const [defaultsReading, setDefaultsReading] = useState(false);
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
  const [mode, setMode] = useState<"new" | "existing" | "claude" | "opencode">("new");
  // A pane shown once in this opening stays, hidden, so a session ID, its
  // preview and a name typed there survive a switch; the one switched to
  // fades in over small (T-19 ST:SX-02). The New form is never remounted.
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
  const [switches, setSwitches] = useState(0);
  const shownPane = useRef<HTMLDivElement>(null);
  useSurfaceIn(shownPane, switches, "small", switches > 0);
  const kept = (pane: typeof mode) => pane === mode || visited.has(pane);
  function switchTo(next: typeof mode) {
    if (next === mode) return;
    setVisited((panes) => new Set(panes).add(mode));
    setMode(next);
    setSwitches((n) => n + 1);
  }
  const [importBusy, setImportBusy] = useState(false);
  // The OpenCode export tab, as OpenCode Agents, only while Core creates them.
  useEffect(() => {
    if (!opencode && mode === "opencode" && !importBusy) setMode("new");
  }, [opencode, mode, importBusy]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  // Escape with the machine editor open closes the editor, not the dialog,
  // and gives focus back to its button (T-19 ST:SX-50).
  const addMachineButton = useRef<HTMLButtonElement>(null);
  const refocusAdd = useRef(false);
  useLayoutEffect(() => {
    if (!adding && refocusAdd.current) {
      refocusAdd.current = false;
      addMachineButton.current?.focus();
    }
  }, [adding]);
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
      harness === "claude" ? "/models?harness=claude" : harness === "dsh" ? "/models?harness=dsh" : "/models",
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

  // The DeepSeek keys, read on each opening with DeepSeek Harness chosen. A
  // key chosen stays while it is still there and set; else the first that is.
  useEffect(() => {
    if (!open || disabled || mode !== "new" || !isDsh) return;
    const controller = new AbortController();
    setDshKeys(null);
    setKeysError("");
    readKeys(controller.signal)
      .then((view) => {
        if (controller.signal.aborted) return;
        const deepseek = view.keys.filter((k) => k.provider === "deepseek");
        setDshKeys(deepseek);
        setKeyId((current) => (deepseek.some((k) => k.id === current && k.set) ? current : deepseek.find((k) => k.set)?.id ?? ""));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setKeysError(errorText(e));
      });
    return () => controller.abort();
  }, [open, disabled, mode, isDsh, keysReload]);
  const dshKey = isDsh ? dshKeys?.find((k) => k.id === keyId && k.set) : undefined;

  // Read on each opening, so a change in Settings or another client shows,
  // and again for the project chosen: its overrides come before the
  // Workspace's (T-190).
  useEffect(() => {
    if (!open || disabled || mode !== "new") return;
    const controller = new AbortController();
    setDefaultsReading(true);
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
      })
      .finally(() => {
        if (!controller.signal.aborted) setDefaultsReading(false);
      });
    return () => {
      controller.abort();
      setDefaultsReading(false);
    };
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
      setAdding(false);
      setVisited(new Set());
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

  // The list with this machine as Core saved it: replaced, or added once.
  function listMachine(saved: WorkspaceMachine) {
    setMachines((current) => {
      const list = current.length ? current : [localMachine];
      return list.some((m) => m.id === saved.id) ? list.map((m) => (m.id === saved.id ? saved : m)) : [...list, saved];
    });
  }
  function machineAdded(saved: WorkspaceMachine) {
    listMachine(saved);
    // An OpenCode or DeepSeek Harness Agent stays on the Core host; the machine is kept for later.
    if (!hostOnly) selectMachine(saved);
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
    if (disabled || locked || adding || checking || permissionConflict || (isDsh && !dshKey) || overLimit(name, coreLimits.agentName)) return;
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
          // DeepSeek Harness: its level, Ask you first unless chosen, and the DeepSeek key it runs with (YN-119 §3.6, §3.10).
          ...(dshKey ? { permissionLevel: permission || "ask", runtimeProfile: { kind: "apiKey", keyId: dshKey.id } } : {}),
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
      onEscapeKeyDown={(event) => {
        // Only while the editor shows: kept in the hidden New pane, it waits
        // there, and Escape in another pane closes the dialog (R1 bd985b53).
        if (!adding || mode !== "new") return;
        event.preventDefault();
        if (savingMachine) return;
        refocusAdd.current = true;
        setAdding(false);
      }}
      title={mode === "new" ? t.newTitle : t.existingTitle}
      description={
        mode === "new"
          ? t.newDescription
          : mode === "claude"
            ? t.claudeDescription
            : mode === "opencode"
              ? t.openCodeDescription
              : t.codexDescription
      }
      lang={langTag(language)}
      closeLabel={t.close}
    >
      <div className="agent-create-modes" role="group" aria-label={t.setup}>
        <button
          type="button"
          aria-pressed={mode === "new"}
          disabled={locked}
          onClick={() => switchTo("new")}
        >
          {t.newAgent}
        </button>
        <button
          type="button"
          aria-pressed={mode === "existing"}
          disabled={locked}
          onClick={() => switchTo("existing")}
        >
          {t.existingCodex}
        </button>
        <button
          type="button"
          aria-pressed={mode === "claude"}
          disabled={locked}
          onClick={() => switchTo("claude")}
        >
          {t.existingClaude}
        </button>
        {opencode && (
          <button
            type="button"
            aria-pressed={mode === "opencode"}
            disabled={locked}
            onClick={() => switchTo("opencode")}
          >
            {t.existingOpenCode}{" "}
            <small className="agent-create-mode-note">{t.experimental}</small>
          </button>
        )}
      </div>
      {kept("existing") && (
        <div ref={mode === "existing" ? shownPane : undefined} hidden={mode !== "existing"}>
          <ImportCodexSession
            disabled={disabled}
            close={close}
            onCreated={onCreated}
            onBusyChange={setImportBusy}
          />
        </div>
      )}
      {kept("claude") && (
        <div ref={mode === "claude" ? shownPane : undefined} hidden={mode !== "claude"}>
          <ImportClaudeSession
            disabled={disabled}
            close={close}
            onCreated={onCreated}
            onBusyChange={setImportBusy}
            projects={projects}
            initialProjectId={projectId}
          />
        </div>
      )}
      {opencode && kept("opencode") && (
        <div ref={mode === "opencode" ? shownPane : undefined} hidden={mode !== "opencode"}>
          <ImportOpenCodeSession
            disabled={disabled}
            close={close}
            onCreated={onCreated}
            onBusyChange={setImportBusy}
          />
        </div>
      )}
      <div ref={mode === "new" ? shownPane : undefined} hidden={mode !== "new"}>
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
                aria-invalid={overLimit(name, coreLimits.agentName) || undefined}
              />
            </label>
            <FieldLength value={name} limit={coreLimits.agentName} />
            <ChoiceChips
              label={t.harness}
              name="create-harness"
              value={harness}
              disabled={defaultsReading}
              onChange={(value) => {
                harnessChosen.current = true;
                setHarness(value as "codex" | "claude" | "opencode" | "dsh");
                setPermission("");
                setModel("");
                if ((value === "opencode" || value === "dsh") && remote)
                  selectMachine(machines.find((m) => m.kind === "local") || localMachine);
              }}
              choices={[
                { value: "codex", label: "Codex" },
                { value: "claude", label: "Claude Code" },
                ...(opencode ? [{ value: "opencode", label: "OpenCode", note: t.experimental }] : []),
                ...(offerDsh ? [{ value: "dsh", label: DSH_NAME, note: dsh?.version || undefined }] : []),
              ]}
            />
            {defaultsReading && (
              <p className="remote-field-note" role="status">
                {t.readingDefaults}
              </p>
            )}
            {known && !defaultsReading && (
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
                title: m.kind === "ssh" ? hostOnly ? hostOnlyNote : m.target : t.coreMachine,
                disabled: hostOnly && m.kind === "ssh",
              }))}
              after={
                <Tip content={hostOnly ? <TipText body={hostOnlyNote} /> : null} hold>
                  <button
                    ref={addMachineButton}
                    type="button"
                    className="choice-chip-action"
                    aria-expanded={adding}
                    aria-controls="new-ssh-machine"
                    disabled={disabled || adding || loadingMachines || hostOnly}
                    aria-description={hostOnly ? hostOnlyNote : undefined}
                    onClick={() => setAdding(true)}
                  >
                    <Plus size={13} /> {t.addMachine}
                  </button>
                </Tip>
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
                // Saved, but not its executor limit: listed, the form stays open (T-35 S3c).
                onMachineSaved={listMachine}
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
            {isDsh && <p className="remote-field-note create-dsh-note">{t.dshNote(dsh?.label || null)}</p>}
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
                disabled={loadingModels || defaultsReading}
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
            {isDsh && (
              <ChoiceChips
                label={t.permissions}
                name="create-permissions"
                value={permission || "ask"}
                onChange={setPermission}
                // The three levels it keeps; never Read only (YN-119 §3.6).
                choices={DSH_LEVELS.map((level) => ({ value: level, label: dshLevelName(level, language) }))}
              />
            )}
            {!isOpenCode && !isDsh && (
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
                {harness === "codex" ? t.codexPermissionNote : isDsh ? t.dshPermissionNote : t.claudePermissionNote}
              </p>
            )}
            {isDsh && (dshKeys?.length ? (
              <ChoiceChips
                label={t.dshKey}
                name="create-dsh-key"
                className="create-dsh-key"
                value={dshKey?.id ?? ""}
                onChange={setKeyId}
                choices={dshKeys.map((k) => ({
                  value: k.id,
                  label: k.id,
                  note: !k.set ? t.dshKeyUnset : k.source === "1password" ? "1Password" : undefined,
                  disabled: !k.set,
                }))}
              />
            ) : null)}
            {isDsh && !dshKeys && !keysError && (
              <p className="remote-field-note" role="status">{t.dshKeysReading}</p>
            )}
            {isDsh && keysError && (
              <div className="remote-field-error" role="alert">
                <span>{t.dshKeysError(keysError)}</span>
                <button type="button" className="quiet-button" onClick={() => setKeysReload((n) => n + 1)}>
                  {t.tryAgain}
                </button>
              </div>
            )}
            {isDsh && dshKeys && !dshKeys.some((k) => k.set) && (
              <p className="remote-field-error create-dsh-no-key" role="alert">{t.dshNoKey}</p>
            )}
            {isDsh && dshKey && (
              <p className="remote-login-note">
                <Server size={13} />
                <span>{t.dshKeyNote}</span>
              </p>
            )}
            {!isOpenCode && !isDsh && (
              <p className="remote-login-note">
                <Server size={13} />
                <span>{t.login(harnessName(harness), remote ? machine.name : null)}</span>
              </p>
            )}
          </fieldset>
          {disabled && (
            <p className="field-hint">{t.createDisabled}</p>
          )}
          {/* The error's two lines are kept while empty: a failure fills them instead of
              pushing the buttons down under the pointer. Below them it could fall out of this
              dialog's scrolled view (T-19 SX-25). */}
          {error ? (
            // The whole error, when its one line cuts it.
            <Tip key="error" content={<TipText body={error} />} size="wide" cut>
              <p role="alert" className="inline-error kept-error">
                <span>{error}</span>
              </p>
            </Tip>
          ) : (
            <p key="line" className="inline-error kept-error is-empty" aria-hidden="true">
              <span>&nbsp;</span>
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
                overLimit(name, coreLimits.agentName) ||
                !cwd.trim() ||
                permissionConflict ||
                (isDsh && !dshKey)
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
      </div>
    </Modal>
  );
}
