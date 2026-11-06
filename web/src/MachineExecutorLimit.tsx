// A machine's own limit on executors at once (T-35 S3): this Core host's
// (`local`) or a registered machine's, saved through its own route against
// the version GET /api/executor-slots lists it at. The Machines editor holds
// a registered machine's; the Core host's card has this control of its own.
import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { errorText } from "./api";
import { readExecutorSlots, saveMachineSlots, type MachineSlots } from "./executor-slots";
import { strings, type Language } from "./i18n";

export const machineLimitText = strings({
  title: "Executors at once",
  placeholder: "No limit of its own",
  help: "At most this many executors run on this machine at once, within the Workspace’s limit. Empty: only the Workspace’s applies. Lowering it stops no running executor; none more starts here until fewer run.",
  range: (min: number, max: number) => `Executors at once is a whole number from ${min} to ${max}, or empty.`,
  conflict: "This machine’s executor limit changed meanwhile and was read again. Save again to apply yours.",
  notSaved: (why: string) => `The machine is saved; its executor limit is not. ${why}`,
  save: "Save executors at once",
  saved: "Saved.",
  here: (n: number) => `${n} on this machine now.`,
}, {
  title: "同时运行的执行者",
  placeholder: "没有自己的上限",
  help: "此机器上同时最多运行这么多个执行者，且不超过 Workspace 的上限。留空：只按 Workspace 的上限。调低不会停止正在运行的执行者；运行的执行者少于上限之前，这里不再启动新的。",
  range: (min, max) => `同时运行的执行者是 ${min} 到 ${max} 之间的整数，或留空。`,
  conflict: "此机器的执行者上限已被更改，已重新读取。再次保存以应用你的值。",
  notSaved: (why) => `机器已保存，但执行者上限未保存。${why}`,
  save: "保存同时运行的执行者",
  saved: "已保存。",
  here: (n) => `此机器上现在有 ${n} 个。`,
});

/** The limit this field's text asks for: null for none of its own (empty),
 * or a whole number from 1 to `max`; undefined when Core wouldn't take it. */
export const parseMachineLimit = (draft: string, max: number): number | null | undefined => {
  const value = draft.trim();
  if (!value) return null;
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n >= 1 && n <= max ? n : undefined;
};

/** Whether an error is Core refusing a save against a stale version. */
export const versionConflict = (error: unknown) => errorText(error).startsWith("version_conflict");

/** This machine's own limit as Core lists it, read while `active`; a machine
 * with none saved reads as version 0, no limit. `reload` reads it again. */
export function useMachineLimit(machineId: string | undefined, active: boolean) {
  const [limit, setLimit] = useState<MachineSlots | null>(null);
  const [max, setMax] = useState(64);
  const [error, setError] = useState("");
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!active || !machineId) return;
    const controller = new AbortController();
    readExecutorSlots(controller.signal).then((view) => {
      if (controller.signal.aborted) return;
      setMax(view.limits.max);
      setLimit(view.machines.find((m) => m.id === machineId) ?? { id: machineId, name: machineId, version: 0, slots: null, executors: 0 });
    }).catch((e) => {
      if (!controller.signal.aborted) setError(errorText(e));
    });
    return () => controller.abort();
  }, [active, machineId, reads]);
  return { limit, max, error, setError, adopt: setLimit, reload: () => setReads((n) => n + 1) };
}

/** The Core host card's own control: the field and its Save. */
export function MachineExecutorLimit({ machineId, language, disabled = false }: { machineId: string; language: Language; disabled?: boolean }) {
  const t = machineLimitText(language);
  const { limit, max, error, setError, adopt, reload } = useMachineLimit(machineId, true);
  // Untouched, the field shows what is saved.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  if (!limit) return error ? <p className="inline-error" role="alert">{error}</p> : null;
  const shown = draft ?? (limit.slots === null ? "" : String(limit.slots));
  const parsed = parseMachineLimit(shown, max);
  const changed = parsed !== undefined && parsed !== limit.slots;
  async function save() {
    if (!limit || parsed === undefined) return;
    setBusy(true);
    setError("");
    try {
      const view = await saveMachineSlots(machineId, limit.version, parsed);
      const saved = view.machines.find((m) => m.id === machineId);
      if (saved) adopt(saved);
      setDraft(null);
      setDone(true);
    } catch (e) {
      if (versionConflict(e)) {
        setError(t.conflict);
        reload();
      } else setError(errorText(e));
    } finally { setBusy(false); }
  }
  return (
    <div className="machine-executor-limit create-form" role="group" aria-label={t.title}>
      <label>
        {t.title}
        <input type="number" inputMode="numeric" min={1} max={max} step={1} aria-label={t.title}
          value={shown} placeholder={t.placeholder} disabled={disabled || busy}
          aria-invalid={parsed === undefined || undefined}
          onChange={(e) => { setDone(false); setDraft(e.target.value); }} />
        <span className="field-hint">{parsed === undefined ? t.range(1, max) : t.help}</span>
      </label>
      <p className="machine-note">{t.here(limit.executors)}</p>
      <div className="machine-executor-limit-actions">
        <button type="button" className="secondary-button" disabled={disabled || busy || !changed} onClick={() => void save()}>
          {busy && <LoaderCircle size={13} className="spin" />} {t.save}
        </button>
        {done && !changed && <span className="field-hint" role="status">{t.saved}</span>}
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  );
}
