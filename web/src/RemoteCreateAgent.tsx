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
import { Modal } from "./components";
import { ChoiceChips } from "./ChoiceChips";
import { MachineEditor } from "./MachineEditor";
import type { Agent, Model, Project } from "./types";
import { activeProjects } from "./projects";
import { ImportCodexSession } from "./ImportCodexSession";
import { ImportClaudeSession } from "./ImportClaudeSession";
import { harnessName, runMachineCheck, type MachineCheck } from "./machine-checks";
import { LastCheck } from "./MachinesPage";
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

export function RemoteCreateAgent({
  open,
  close,
  defaultCwd,
  disabled,
  onCreated,
  projects = [],
  initialProjectId = "",
  opencode = false,
}: {
  open: boolean;
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
  const [harness, setHarness] = useState<"codex" | "claude" | "opencode">("codex");
  // OpenCode is offered only while Core says it creates such Agents, and
  // only on the Core host, with OpenCode's own default model.
  const isOpenCode = harness === "opencode";
  useEffect(() => {
    if (!opencode && isOpenCode) setHarness("codex");
  }, [opencode, isOpenCode]);
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

  useEffect(() => {
    if (!open) {
      checkRequest.current += 1;
      setChecking(false);
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
    if (disabled || locked || adding || checking) return;
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
          ...(model.trim() ? { model: model.trim() } : {}),
          ...(projectId
            ? { projectId, saveProjectDefault: saveDefault && !!cwd.trim() }
            : {}),
        },
      );
      onCreated(agent);
      close();
      setName("");
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
      title={
        mode === "new" ? "A new little teammate" : "Welcome back to your work"
      }
      description={
        mode === "new"
          ? "Choose a name and a place to work. Send the first task in the conversation."
          : mode === "claude"
            ? "Continue a Claude Code session saved on this machine in Yuzuno."
            : "Continue an existing Codex session in Yuzuno."
      }
    >
      <div className="agent-create-modes" role="group" aria-label="Agent setup">
        <button
          type="button"
          aria-pressed={mode === "new"}
          disabled={locked}
          onClick={() => setMode("new")}
        >
          New agent
        </button>
        <button
          type="button"
          aria-pressed={mode === "existing"}
          disabled={locked}
          onClick={() => setMode("existing")}
        >
          Existing Codex session
        </button>
        <button
          type="button"
          aria-pressed={mode === "claude"}
          disabled={locked}
          onClick={() => setMode("claude")}
        >
          Existing Claude session
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
              Name
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mikan, Mori, or something entirely you"
                required
                maxLength={60}
              />
            </label>
            <ChoiceChips
              label="Harness"
              name="create-harness"
              value={harness}
              onChange={(value) => {
                setHarness(value as "codex" | "claude" | "opencode");
                setModel("");
                if (value === "opencode" && remote)
                  selectMachine(machines.find((m) => m.kind === "local") || localMachine);
              }}
              choices={[
                { value: "codex", label: "Codex" },
                { value: "claude", label: "Claude Code" },
                ...(opencode ? [{ value: "opencode", label: "OpenCode", note: "Experimental" }] : []),
              ]}
            />
            <ChoiceChips
              label="Where to work"
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
                note: m.kind === "ssh" ? "SSH" : "Local",
                icon: m.kind === "ssh" ? <Server size={13} /> : <Monitor size={13} />,
                title: m.kind === "ssh" ? isOpenCode ? "OpenCode Agents run only on the Core host for now" : m.target : "The machine running your workspace Core",
                disabled: isOpenCode && m.kind === "ssh",
              }))}
              after={
                <button
                  type="button"
                  className="choice-chip-action"
                  aria-expanded={adding}
                  aria-controls="new-ssh-machine"
                  disabled={disabled || adding || loadingMachines || isOpenCode}
                  title={isOpenCode ? "OpenCode Agents run only on the Core host for now" : undefined}
                  onClick={() => setAdding(true)}
                >
                  <Plus size={13} /> Add SSH machine
                </button>
              }
            />
            {loadingMachines && (
              <p className="remote-field-note" role="status">
                Loading machines…
              </p>
            )}
            {machineError && (
              <div className="remote-field-error" role="alert">
                <span>Couldn’t load machines: {machineError}</span>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => setReload((value) => value + 1)}
                >
                  Try again
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
              />
            ) : (
              <div className="remote-machine-status">
                <LastCheck check={machine.lastCheck} checking={checking} compact />
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
                  {checking ? "Checking…" : "Test connection"}
                </button>
              </div>
            )}
            {!adding && checkError && (
              <p className="remote-field-error" role="alert">
                {checkError}
              </p>
            )}
            <label>
              Working folder
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
                A folder on{" "}
                {remote
                  ? machine.name
                  : "the machine running your workspace Core"}
                {project && projectDefault
                  ? `. ${project.name}’s default here is filled in; any folder works, such as a worktree.`
                  : "."}
              </span>
            </label>
            <ChoiceChips
              label="Project"
              name="create-project"
              value={projectId}
              onChange={(value) => {
                setProjectId(value);
                setSaveDefault(false);
                fillCwd(folderFor(machine, value));
              }}
              choices={[
                { value: "", label: "No project" },
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
                {projectDefault
                  ? `Make this ${project.name}’s default folder on ${machine.name}`
                  : `Save as ${project.name}’s default folder on ${machine.name}`}
              </label>
            )}
            {isOpenCode ? (
              <p className="remote-field-note">
                Uses OpenCode’s own default model, login and permission rules on
                your Core host; OpenCode may download or update its own
                dependencies when it starts. Experimental: no images, rewind or
                slash commands, and a message waits until the current turn ends.
              </p>
            ) : remote ? (
              <label>
                Model
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="Harness default"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              </label>
            ) : (
              <ChoiceChips
                label="Model"
                name="create-model"
                value={model}
                disabled={loadingModels}
                onChange={setModel}
                choices={[
                  { value: "", label: "Harness default" },
                  ...models.map((m) => ({
                    value: m.model || m.id,
                    label: m.displayName,
                    note: m.isDefault ? "default" : undefined,
                    title: m.description || undefined,
                  })),
                ]}
              />
            )}
            {!remote && loadingModels && (
              <p className="remote-field-note" role="status">
                <LoaderCircle size={13} className="spin" /> Loading{" "}
                {harnessName(harness)} models…
              </p>
            )}
            {!remote && modelError && (
              <div
                className="remote-field-error model-catalog-error"
                role="alert"
              >
                <span>
                  Couldn’t load models: {modelError}. You can still use the
                  harness default.
                </span>
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => setModelReload((n) => n + 1)}
                >
                  Retry models
                </button>
              </div>
            )}
            {!remote &&
              !isOpenCode &&
              !loadingModels &&
              !modelError &&
              models.length === 0 && (
                <p className="remote-field-note">
                  No model choices were returned. The harness default is still
                  available.
                </p>
              )}
            {!remote &&
              models.find((m) => (m.model || m.id) === model)?.description && (
                <p className="remote-field-note">
                  {models.find((m) => (m.model || m.id) === model)?.description}
                </p>
              )}
            {remote && (
              <p className="remote-field-note">
                Leave the model empty to use {harnessName(harness)}’s default on {machine.name}.
              </p>
            )}
            {!isOpenCode && (
              <p className="remote-login-note">
                <Server size={13} />
                <span>
                  Uses the {harnessName(harness)} login
                  on {remote ? machine.name : "your Core host"}.
                </span>
              </p>
            )}
          </fieldset>
          {disabled && (
            <p className="field-hint">
              Creation is disabled in the read-only design preview.
            </p>
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
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={
                disabled ||
                locked ||
                adding ||
                checking ||
                !name.trim() ||
                !cwd.trim()
              }
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Plus size={15} />
              )}
              {busy ? "Creating…" : "Create agent"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
