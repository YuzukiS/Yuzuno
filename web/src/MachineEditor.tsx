// An SSH machine's settings, for adding one (New agent, Machines) or editing
// one (Machines). Core checks them again when saving them.
import { useEffect, useState } from "react";
import { LoaderCircle, Plus, Server } from "lucide-react";
import { api, errorText, post } from "./api";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import "./remote.css";

export function MachineEditor({
  id,
  machine,
  disabled = false,
  onSaved,
  onCancel,
  onBusyChange,
}: {
  id?: string;
  /** The machine to edit; without one, a new machine is added. */
  machine?: WorkspaceMachine;
  disabled?: boolean;
  onSaved: (saved: WorkspaceMachine) => void;
  onCancel: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [name, setName] = useState(machine?.name || "");
  const [target, setTarget] = useState(machine?.target || "");
  const [folder, setFolder] = useState(machine?.defaultCwd || "");
  const [codex, setCodex] = useState(machine?.codex || "codex");
  // Jobs there; empty is the default (two at once, no budget). A new machine
  // is strict; one saved without a mode keeps the record-only mode it had
  // before limits ("legacy") until it chooses.
  const [jobs] = useState(() => ({
    maxJobs: machine?.maxJobs == null ? "" : String(machine.maxJobs),
    cpu: machine?.budget ? String(machine.budget.cpuMillis / 1000) : "",
    memory: machine?.budget ? String(machine.budget.memoryMiB) : "",
    mode: (machine ? (machine.limitMode ?? "legacy") : "strict") as string,
  }));
  const [maxJobs, setMaxJobs] = useState(jobs.maxJobs);
  const [cpu, setCpu] = useState(jobs.cpu);
  const [memory, setMemory] = useState(jobs.memory);
  const [mode, setMode] = useState(jobs.mode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => onBusyChange?.(saving), [saving, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  async function save() {
    if (disabled || saving) return;
    if (!name.trim() || !target.trim() || !folder.trim()) {
      setError("Add a name, an SSH destination, and a working folder.");
      return;
    }
    if (/^\-|\s/.test(target.trim())) {
      setError("Use an SSH alias or user@hostname, without SSH options.");
      return;
    }
    if (!cpu.trim() !== !memory.trim()) {
      setError("Give the Jobs budget both CPU and RAM, or leave both empty.");
      return;
    }
    setSaving(true);
    setError("");
    // Only a Jobs setting changed here is sent: Core keeps one left out and
    // clears one sent as null, and checks the ranges again.
    const body = {
      name: name.trim(),
      target: target.trim(),
      codex: codex.trim() || "codex",
      defaultCwd: folder.trim(),
      ...(maxJobs.trim() !== jobs.maxJobs ? { maxJobs: maxJobs.trim() ? Number(maxJobs) : null } : {}),
      ...(cpu.trim() !== jobs.cpu || memory.trim() !== jobs.memory
        ? { budget: cpu.trim() ? { cpuMillis: Math.round(Number(cpu) * 1000), memoryMiB: Number(memory) } : null }
        : {}),
      // null is the record-only mode; Core makes a new machine strict unless told.
      ...(mode !== jobs.mode ? { limitMode: mode === "legacy" ? null : mode } : {}),
    };
    try {
      const saved = machine
        ? await api<WorkspaceMachine>(
            `/machines/${encodeURIComponent(machine.id)}`,
            { method: "PUT", body: JSON.stringify(body) },
          )
        : await post<WorkspaceMachine>("/machines", body);
      setSaving(false);
      onSaved(saved);
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  }

  return (
    <div id={id} className="remote-machine-editor create-form remote-create">
      <div className="remote-editor-heading">
        <Server size={17} />
        <strong>{machine ? `Edit ${machine.name}` : "A place for remote work"}</strong>
      </div>
      <p className="remote-field-note">
        {machine
          ? "Changes apply to new agents and checks. Agents already on this machine keep the connection they started with."
          : "Uses the SSH setup on your Core host."}
      </p>
      <label>
        Machine name
        <input
          autoFocus
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="Mac mini"
        />
      </label>
      <label>
        SSH destination
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="mac-mini or you@hostname"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <span className="field-hint">
          An alias from your SSH config, or user@hostname.
        </span>
      </label>
      <label>
        Default working folder
        <input
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder="/Users/you/projects"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </label>
      <label>
        Codex executable
        <input
          value={codex}
          onChange={(e) => setCodex(e.target.value)}
          placeholder="codex"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <span className="field-hint">
          Use a full path if Codex isn’t on the remote SSH PATH.
        </span>
      </label>
      <p className="remote-field-note">
        Jobs on this machine. Empty fields use the defaults: two at once and no
        CPU or RAM budget. Saving changes only jobs that have not started.
      </p>
      <label>
        Jobs at once
        <input
          type="number"
          min={1}
          max={64}
          step="1"
          value={maxJobs}
          onChange={(e) => setMaxJobs(e.target.value)}
          placeholder="Default (2)"
        />
      </label>
      <label>
        Jobs CPU budget (CPUs)
        <input
          type="number"
          min="0.1"
          step="0.1"
          value={cpu}
          onChange={(e) => setCpu(e.target.value)}
          placeholder="No budget"
        />
      </label>
      <label>
        Jobs RAM budget (MiB)
        <input
          type="number"
          min="64"
          step="1"
          value={memory}
          onChange={(e) => setMemory(e.target.value)}
          placeholder="No budget"
        />
        <span className="field-hint">
          What jobs there may reserve together. Each job still declares its own
          CPU and RAM.
        </span>
      </label>
      <label>
        A limit this machine can’t enforce
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="strict">Refuse the job (strict)</option>
          <option value="limited">Run it and say what isn’t enforced</option>
          <option value="legacy">Hold no limits: record resources only, as before</option>
        </select>
        {mode === "legacy" && (
          <span className="field-hint">
            Jobs there run as they did before limits: their CPU and RAM are
            recorded, not held. Choose strict or limited to hold them.
          </span>
        )}
      </label>
      {error && (
        <p role="alert" className="remote-field-error">
          {error}
        </p>
      )}
      <div className="remote-editor-actions">
        <button
          type="button"
          className="quiet-button"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || saving}
          onClick={() => void save()}
        >
          {saving ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            !machine && <Plus size={14} />
          )}
          {machine ? "Save changes" : "Save machine"}
        </button>
      </div>
    </div>
  );
}
