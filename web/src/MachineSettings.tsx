// An SSH machine's settings on its own page (YN-8): its connection and its
// Jobs and executors, as two blocks saved with the page's bar. Adding a
// machine (and New agent) keeps MachineEditor's form.
import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import { saveMachineSlots } from "./executor-slots";
import type { Language } from "./i18n";
import { machineEditorText } from "./MachineEditor";
import { machineLimitText, useMachineLimit, versionConflict } from "./MachineExecutorLimit";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import { ChoiceCards } from "./SettingsChoices";
import { useSaveBarPart } from "./SettingsSaveBar";
import { SettingsSlider } from "./SettingsSlider";
import "./remote.css";

/** Jobs at once when a machine has none of its own (Core's remote::SLOTS). */
const DEFAULT_JOBS = 2;
/** Core's range for Jobs at once (remote::MAX_JOBS_RANGE). */
const MAX_JOBS = 64;

type Field = "name" | "target" | "folder" | "codex" | "maxJobs" | "cpu" | "memory" | "mode";
type Mode = "strict" | "limited" | "legacy";

/** A Mac, as Core last learnt it (YN-104): macOS holds no limit, so its Jobs
 * run limited whatever mode it saved, and its page offers no other. */
const isMac = (machine: WorkspaceMachine) => machine.platform === "Darwin";

/** The fields as Core saved them, written as the fields show them. */
const savedOf = (machine: WorkspaceMachine): Record<Field, string> => ({
  name: machine.name,
  target: machine.target ?? "",
  folder: machine.defaultCwd,
  codex: machine.codex || "codex",
  maxJobs: machine.maxJobs == null ? "" : String(machine.maxJobs),
  cpu: machine.budget ? String(machine.budget.cpuMillis / 1000) : "",
  memory: machine.budget ? String(machine.budget.memoryMiB) : "",
  // A machine saved before limits has no mode: it holds none ("legacy").
  // A Mac shows the mode its Jobs run in; what it saved is kept, unsent.
  mode: isMac(machine) ? "limited" : machine.limitMode ?? "legacy",
});

/** The machine's connection and Jobs settings and its executor limit, each
 * a part of the page's save bar with its own request: the machine through
 * PUT /machines/{id} (only a changed Jobs setting is sent), its executor
 * limit through its own route against the version read. A field not touched
 * shows what Core has saved, as it changes. */
export function MachineSettings({ machine, language, onSaved }: {
  machine: WorkspaceMachine;
  language: Language;
  onSaved: (saved: WorkspaceMachine) => void;
}) {
  const t = machineEditorText(language);
  const lt = machineLimitText(language);
  const saved = savedOf(machine);
  const savedKey = JSON.stringify(saved);
  const [edits, setEdits] = useState<Partial<Record<Field, string>>>({});
  // An edit that now matches what Core saved is no longer one.
  useEffect(() => {
    setEdits((current) => Object.fromEntries(Object.entries(current).filter(([field, value]) => value !== saved[field as Field])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);
  const mac = isMac(machine);
  // A mode chosen before Core learnt it is a Mac is not one to save.
  const value = (field: Field) => (mac && field === "mode" ? saved.mode : edits[field] ?? saved[field]);
  const set = (field: Field) => (next: string) => setEdits((current) => ({ ...current, [field]: next }));
  const changed = (field: Field) => value(field).trim() !== saved[field];
  const fields: Field[] = ["name", "target", "folder", "codex", "maxJobs", "cpu", "memory", "mode"];
  const machineChanged = fields.some(changed);
  const [error, setError] = useState("");
  // What keeps it from being saved, as the add form says it.
  const problem = !value("name").trim() || !value("target").trim() || !value("folder").trim()
    ? t.missing
    : /^-|\s/.test(value("target").trim())
      ? t.noOptions
      : !value("cpu").trim() !== !value("memory").trim()
        ? t.budgetPair
        : "";
  async function saveMachine(): Promise<boolean> {
    setError("");
    // What is sent: a field changed while it is on its way stays a change (#730 R1 P3).
    const sent = { ...edits };
    const v = (field: Field) => value(field).trim();
    // Core keeps a Jobs setting left out and clears one sent as null.
    const body = {
      name: v("name"),
      target: v("target"),
      codex: v("codex") || "codex",
      defaultCwd: v("folder"),
      ...(changed("maxJobs") ? { maxJobs: v("maxJobs") ? Number(v("maxJobs")) : null } : {}),
      ...(changed("cpu") || changed("memory")
        ? { budget: v("cpu") ? { cpuMillis: Math.round(Number(v("cpu")) * 1000), memoryMiB: Number(v("memory")) } : null }
        : {}),
      ...(changed("mode") ? { limitMode: v("mode") === "legacy" ? null : v("mode") } : {}),
    };
    try {
      const next = await api<WorkspaceMachine>(`/machines/${encodeURIComponent(machine.id)}`, { method: "PUT", body: JSON.stringify(body) });
      setEdits((current) => Object.fromEntries(Object.entries(current).filter(([field, value]) => value !== sent[field as Field])));
      onSaved(next);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }
  useSaveBarPart(`machine:${machine.id}`, machineChanged ? {
    ready: !problem,
    save: saveMachine,
    discard: () => { setError(""); setEdits({}); },
  } : null);

  // Its own limit on executors at once: undefined untouched, null for none of its own.
  const limit = useMachineLimit(machine.id, true);
  const [slots, setSlots] = useState<number | null | undefined>(undefined);
  const [slotsError, setSlotsError] = useState("");
  const savedSlots = limit.limit?.slots ?? null;
  const shownSlots = slots === undefined ? savedSlots : slots;
  const slotsChanged = !!limit.limit && slots !== undefined && slots !== savedSlots;
  async function saveSlots(): Promise<boolean> {
    if (!limit.limit) return false;
    setSlotsError("");
    try {
      const view = await saveMachineSlots(machine.id, limit.limit.version, shownSlots);
      const next = view.machines.find((m) => m.id === machine.id);
      if (next) limit.adopt(next);
      setSlots(undefined);
      return true;
    } catch (e) {
      // On a conflict only the limit and its version are read again; the change stays to save again.
      if (versionConflict(e)) {
        setSlotsError(lt.conflict);
        limit.reload();
      } else setSlotsError(errorText(e));
      return false;
    }
  }
  useSaveBarPart(`executors:${machine.id}`, slotsChanged ? {
    save: saveSlots,
    discard: () => { setSlotsError(""); setSlots(undefined); },
  } : null);

  // Unset is the default: the slider shows that number, and a set one can go back to it.
  const ownJobs = Number(value("maxJobs")) || null;
  const mode = value("mode") as Mode;
  const toDefault = (set: boolean, n: number, back: () => void) =>
    set ? (
      <button type="button" className="quiet-button machine-settings-default" onClick={back}>{t.useDefault(n)}</button>
    ) : (
      <p className="appearance-help machine-settings-default">{t.isDefault(n)}</p>
    );
  return (
    <div className="settings-group appearance-group machine-settings">
      <fieldset className="appearance-field machine-settings-connection">
        <legend>{t.connection}</legend>
        <p className="appearance-help">{t.editNote}</p>
        <div className="create-form remote-create machine-settings-fields">
          <label>
            {t.name}
            <input value={value("name")} maxLength={60} onChange={(e) => set("name")(e.target.value)} placeholder="Mac mini" />
          </label>
          <label>
            {t.target}
            <input value={value("target")} onChange={(e) => set("target")(e.target.value)} placeholder={t.targetPlaceholder}
              spellCheck={false} autoCapitalize="none" autoCorrect="off" />
            <span className="field-hint">{t.targetHint}</span>
          </label>
          <label>
            {t.folder}
            <input value={value("folder")} onChange={(e) => set("folder")(e.target.value)} placeholder="/Users/you/projects"
              spellCheck={false} autoCapitalize="none" autoCorrect="off" />
          </label>
          <label>
            {t.codex}
            <input value={value("codex")} onChange={(e) => set("codex")(e.target.value)} placeholder="codex"
              spellCheck={false} autoCapitalize="none" autoCorrect="off" />
            <span className="field-hint">{t.codexHint}</span>
          </label>
        </div>
        {machineChanged && problem && <p className="remote-field-error">{problem}</p>}
        {error && <p role="alert" className="remote-field-error">{error}</p>}
      </fieldset>
      <fieldset className="appearance-field machine-settings-jobs">
        <legend>{t.jobsLegend}</legend>
        <p className="appearance-help">{t.jobsNote}</p>
        <SettingsSlider name={`machine-jobs-${machine.id}`} label={t.maxJobs} value={ownJobs ?? DEFAULT_JOBS} min={1} max={MAX_JOBS}
          onChange={(n) => set("maxJobs")(String(n))} />
        {toDefault(ownJobs !== null, DEFAULT_JOBS, () => set("maxJobs")(""))}
        <div className="create-form remote-create machine-settings-budget" role="group" aria-label={t.budgetLegend}>
          <label>
            {t.cpu}
            <input type="number" min="0.1" step="0.1" value={value("cpu")} onChange={(e) => set("cpu")(e.target.value)} placeholder={t.noBudget} />
          </label>
          <label>
            {t.memory}
            <input type="number" min="64" step="1" value={value("memory")} onChange={(e) => set("memory")(e.target.value)} placeholder={t.noBudget} />
          </label>
        </div>
        <p className="appearance-help">{mac ? t.macBudgetHint : t.memoryHint}</p>
        <p className="machine-settings-label">{mac ? t.macMode : t.mode}</p>
        <ChoiceCards<Mode>
          name={`machine-limit-mode-${machine.id}`}
          value={mode}
          choices={mac ? [
            { value: "limited", label: t.limitedName, note: t.macLimitedNote },
          ] : [
            { value: "strict", label: t.strictName, note: t.strictNote },
            { value: "limited", label: t.limitedName, note: t.limitedNote },
            { value: "legacy", label: t.legacyName, note: t.legacyHint },
          ]}
          onChange={(next) => set("mode")(next)}
        />
        {/* Not known yet: whatever is chosen, a Mac runs limited. */}
        {machine.platform == null && <p className="appearance-help">{t.macNote} {t.checkToShow}</p>}
        {limit.limit ? (
          <>
            <SettingsSlider name={`machine-executors-${machine.id}`} label={lt.title} value={shownSlots ?? limit.preset} min={1} max={limit.max}
              onChange={(n) => setSlots(n)} />
            {toDefault(shownSlots !== null, limit.preset, () => setSlots(null))}
            <p className="appearance-help">{lt.helpSlider} {lt.here(limit.limit.executors)}</p>
          </>
        ) : null}
        {(slotsError || limit.readError) && (
          <p role="alert" className="remote-field-error">{[slotsError, limit.readError].filter(Boolean).join(" ")}</p>
        )}
        {/* Without a limit read there is nothing to show or save: read it again when asked. */}
        {!limit.limit && limit.readError && (
          <button type="button" className="quiet-button" onClick={limit.reload}>{t.readAgain}</button>
        )}
      </fieldset>
    </div>
  );
}
