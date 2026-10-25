// An SSH machine's settings, for adding one (New agent, Machines) or editing
// one (Machines). Core checks them again when saving them.
import { useEffect, useState } from "react";
import { LoaderCircle, Plus, Server } from "lucide-react";
import { api, errorText, post } from "./api";
import { strings, type Language } from "./i18n";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import "./remote.css";

// The editor's own words, in the language its page passes (T-189): Machines
// and New agent pass the interface language. What the user types and Core's
// errors are shown as they are.
const text = strings({
  editTitle: (name: string) => `Edit ${name}`,
  addTitle: "A place for remote work",
  editNote: "Changes apply to new agents and checks. Agents already on this machine keep the connection they started with.",
  addNote: "Uses the SSH setup on your Core host.",
  name: "Machine name",
  target: "SSH destination",
  targetPlaceholder: "mac-mini or you@hostname",
  targetHint: "An alias from your SSH config, or user@hostname.",
  folder: "Default working folder",
  codex: "Codex executable",
  codexHint: "Use a full path if Codex isn’t on the remote SSH PATH.",
  jobsNote: "Jobs on this machine. Empty fields use the defaults: two at once and no CPU or RAM budget. Saving changes only jobs that have not started.",
  maxJobs: "Jobs at once",
  maxJobsPlaceholder: "Default (2)",
  cpu: "Jobs CPU budget (CPUs)",
  memory: "Jobs RAM budget (MiB)",
  noBudget: "No budget",
  memoryHint: "What jobs there may reserve together. Each job still declares its own CPU and RAM.",
  mode: "A limit this machine can’t enforce",
  strict: "Refuse the job (strict)",
  limited: "Run it and say what isn’t enforced",
  legacy: "Hold no limits: record resources only, as before",
  legacyHint: "Jobs there run as they did before limits: their CPU and RAM are recorded, not held. Choose strict or limited to hold them.",
  missing: "Add a name, an SSH destination, and a working folder.",
  noOptions: "Use an SSH alias or user@hostname, without SSH options.",
  budgetPair: "Give the Jobs budget both CPU and RAM, or leave both empty.",
  cancel: "Cancel",
  saveChanges: "Save changes",
  saveMachine: "Save machine",
}, {
  editTitle: (name) => `编辑 ${name}`,
  addTitle: "远程工作的地方",
  editNote: "更改用于新的 Agent 和检查。已在此机器上的 Agent 保留它们启动时的连接。",
  addNote: "使用你的 Core 主机上的 SSH 配置。",
  name: "机器名称",
  target: "SSH 目标",
  targetPlaceholder: "mac-mini 或 you@hostname",
  targetHint: "SSH 配置中的别名，或 user@hostname。",
  folder: "默认工作文件夹",
  codex: "Codex 可执行文件",
  codexHint: "如果 Codex 不在远程 SSH 的 PATH 中，请使用完整路径。",
  jobsNote: "此机器上的 Job。留空则使用默认值：同时运行两个，不设 CPU 或内存预算。保存只影响尚未开始的 Job。",
  maxJobs: "同时运行的 Job 数",
  maxJobsPlaceholder: "默认（2）",
  cpu: "Job CPU 预算（CPU 数）",
  memory: "Job 内存预算（MiB）",
  noBudget: "不设预算",
  memoryHint: "该机器上的 Job 合计可预留的量。每个 Job 仍各自声明 CPU 和内存。",
  mode: "此机器无法强制执行的限制",
  strict: "拒绝该 Job（严格）",
  limited: "运行它，并说明哪些未被强制执行",
  legacy: "不设限制：只记录资源，与以前一样",
  legacyHint: "该机器上的 Job 按设限之前的方式运行：只记录 CPU 和内存，不预留。选择严格或受限才会预留。",
  missing: "请填写名称、SSH 目标和工作文件夹。",
  noOptions: "请使用 SSH 别名或 user@hostname，不要带 SSH 选项。",
  budgetPair: "Job 预算请同时填写 CPU 和内存，或都留空。",
  cancel: "取消",
  saveChanges: "保存更改",
  saveMachine: "保存机器",
});

export function MachineEditor({
  id,
  machine,
  disabled = false,
  onSaved,
  onCancel,
  onBusyChange,
  language = "en",
}: {
  id?: string;
  /** The machine to edit; without one, a new machine is added. */
  machine?: WorkspaceMachine;
  disabled?: boolean;
  onSaved: (saved: WorkspaceMachine) => void;
  onCancel: () => void;
  onBusyChange?: (busy: boolean) => void;
  /** The language of its own words; English where a page doesn't pass one. */
  language?: Language;
}) {
  const t = text(language);
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
      setError(t.missing);
      return;
    }
    if (/^\-|\s/.test(target.trim())) {
      setError(t.noOptions);
      return;
    }
    if (!cpu.trim() !== !memory.trim()) {
      setError(t.budgetPair);
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
        <strong>{machine ? t.editTitle(machine.name) : t.addTitle}</strong>
      </div>
      <p className="remote-field-note">
        {machine ? t.editNote : t.addNote}
      </p>
      <label>
        {t.name}
        <input
          autoFocus
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="Mac mini"
        />
      </label>
      <label>
        {t.target}
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={t.targetPlaceholder}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <span className="field-hint">{t.targetHint}</span>
      </label>
      <label>
        {t.folder}
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
        {t.codex}
        <input
          value={codex}
          onChange={(e) => setCodex(e.target.value)}
          placeholder="codex"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <span className="field-hint">{t.codexHint}</span>
      </label>
      <p className="remote-field-note">{t.jobsNote}</p>
      <label>
        {t.maxJobs}
        <input
          type="number"
          min={1}
          max={64}
          step="1"
          value={maxJobs}
          onChange={(e) => setMaxJobs(e.target.value)}
          placeholder={t.maxJobsPlaceholder}
        />
      </label>
      <label>
        {t.cpu}
        <input
          type="number"
          min="0.1"
          step="0.1"
          value={cpu}
          onChange={(e) => setCpu(e.target.value)}
          placeholder={t.noBudget}
        />
      </label>
      <label>
        {t.memory}
        <input
          type="number"
          min="64"
          step="1"
          value={memory}
          onChange={(e) => setMemory(e.target.value)}
          placeholder={t.noBudget}
        />
        <span className="field-hint">{t.memoryHint}</span>
      </label>
      <label>
        {t.mode}
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="strict">{t.strict}</option>
          <option value="limited">{t.limited}</option>
          <option value="legacy">{t.legacy}</option>
        </select>
        {mode === "legacy" && (
          <span className="field-hint">{t.legacyHint}</span>
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
          {t.cancel}
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
          {machine ? t.saveChanges : t.saveMachine}
        </button>
      </div>
    </div>
  );
}
