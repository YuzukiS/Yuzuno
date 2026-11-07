// A machine's limit on executors at once (T-35 S3; YN-2 S5: the only one): this Core host's
// (`local`) or a registered machine's, saved through its own route against
// the version GET /api/executor-slots lists it at. The Machines editor holds
// a registered machine's; the Core host's card has this control of its own.
import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { errorText } from "./api";
import { readExecutorSlots, saveMachineSlots, type MachineSlots } from "./executor-slots";
import { strings, type Language } from "./i18n";
import { useSaveBarPart } from "./SettingsSaveBar";
import { SettingsSlider } from "./SettingsSlider";

export const machineLimitText = strings({
  title: "Executors at once",
  placeholder: (preset: number) => `Default: ${preset}`,
  help: (preset: number) => `At most this many executors run on this machine at once; empty for the default, ${preset}. The Workspace runs at most its machines’ numbers added up. Lowering it stops no running executor; none more starts here until fewer run.`,
  // On a slider (YN-8) there is no empty: the default is said beside it.
  helpSlider: "At most this many executors run on this machine at once. The Workspace runs at most its machines’ numbers added up. Lowering it stops no running executor; none more starts here until fewer run.",
  range: (min: number, max: number) => `Executors at once is a whole number from ${min} to ${max}, or empty for the default.`,
  conflict: "This machine’s executor limit changed meanwhile and was read again. Save again to apply yours.",
  notSaved: (why: string) => `The machine is saved; its executor limit is not. ${why}`,
  save: "Save executors at once",
  saved: "Saved.",
  here: (n: number) => `${n} on this machine now.`,
  isDefault: (n: number) => `The default, ${n}.`,
  useDefault: (n: number) => `Use the default (${n})`,
}, {
  title: "同时运行的执行者",
  placeholder: (preset) => `默认：${preset}`,
  help: (preset) => `此机器上同时最多运行这么多个执行者；留空为默认的 ${preset} 个。整个 Workspace 最多运行各机器数量之和。调低不会停止正在运行的执行者；运行的执行者少于上限之前，这里不再启动新的。`,
  helpSlider: "此机器上同时最多运行这么多个执行者。整个 Workspace 最多运行各机器数量之和。调低不会停止正在运行的执行者；运行的执行者少于上限之前，这里不再启动新的。",
  range: (min, max) => `同时运行的执行者是 ${min} 到 ${max} 之间的整数，或留空使用默认值。`,
  conflict: "此机器的执行者上限已被更改，已重新读取。再次保存以应用你的值。",
  notSaved: (why) => `机器已保存，但执行者上限未保存。${why}`,
  save: "保存同时运行的执行者",
  saved: "已保存。",
  here: (n) => `此机器上现在有 ${n} 个。`,
  isDefault: (n) => `默认值 ${n}。`,
  useDefault: (n) => `使用默认值（${n}）`,
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
 * with none saved reads as version 0, no limit. `reload` reads it again.
 * `readError` is the last read's failure only: each read starts without it,
 * so one that succeeds clears it (#645 R2 62b6a3ef). */
export function useMachineLimit(machineId: string | undefined, active: boolean) {
  const [limit, setLimit] = useState<MachineSlots | null>(null);
  const [max, setMax] = useState(64);
  const [preset, setPreset] = useState(3);
  const [readError, setReadError] = useState("");
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!active || !machineId) return;
    const controller = new AbortController();
    setReadError("");
    readExecutorSlots(controller.signal).then((view) => {
      if (controller.signal.aborted) return;
      setMax(view.limits.max);
      setPreset(view.limits.default);
      setLimit(view.machines.find((m) => m.id === machineId)
        ?? { id: machineId, name: machineId, version: 0, slots: null, limit: view.limits.default, executors: 0 });
    }).catch((e) => {
      if (!controller.signal.aborted) setReadError(errorText(e));
    });
    return () => controller.abort();
  }, [active, machineId, reads]);
  return { limit, max, preset, readError, adopt: setLimit, reload: () => setReads((n) => n + 1) };
}

/** The Core host card's own control (YN-8: a slider, as on a machine's
 * page): unset shows the default, and a set one can go back to it. On the
 * Core host's page it joins the page's save bar; alone it has its own Save. */
export function MachineExecutorLimit({ machineId, language, disabled = false }: { machineId: string; language: Language; disabled?: boolean }) {
  const t = machineLimitText(language);
  const { limit, max, preset, readError, adopt, reload } = useMachineLimit(machineId, true);
  // What a save said (a refusal or a conflict), apart from the read's own
  // failure: a conflict's reload keeps it in view.
  const [error, setError] = useState("");
  // Undefined untouched (what is saved shows); null for the default.
  const [draft, setDraft] = useState<number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const saved = limit?.slots ?? null;
  const shown = draft === undefined ? saved : draft;
  const changed = !!limit && draft !== undefined && draft !== saved;
  async function save(): Promise<boolean> {
    if (!limit) return false;
    setBusy(true);
    setError("");
    try {
      const view = await saveMachineSlots(machineId, limit.version, shown);
      const next = view.machines.find((m) => m.id === machineId);
      if (next) adopt(next);
      setDraft(undefined);
      setDone(true);
      return true;
    } catch (e) {
      if (versionConflict(e)) {
        setError(t.conflict);
        reload();
      } else setError(errorText(e));
      return false;
    } finally { setBusy(false); }
  }
  const inBar = useSaveBarPart(`executors:${machineId}`, changed && !disabled ? {
    save,
    discard: () => { setError(""); setDraft(undefined); },
  } : null);
  if (!limit) return readError ? <p className="inline-error" role="alert">{readError}</p> : null;
  return (
    <div className="machine-executor-limit" role="group" aria-label={t.title}>
      <SettingsSlider name={`machine-executors-${machineId}`} label={t.title} value={shown ?? preset} min={1} max={max}
        used={limit.executors} disabled={disabled || busy}
        onChange={(n) => { setDone(false); setDraft(n); }} />
      {shown === null ? (
        <p className="field-hint">{t.isDefault(preset)}</p>
      ) : (
        <button type="button" className="quiet-button" disabled={disabled || busy} onClick={() => { setDone(false); setDraft(null); }}>
          {t.useDefault(preset)}
        </button>
      )}
      <p className="machine-note">{t.helpSlider} {t.here(limit.executors)}</p>
      {!inBar && (
        <div className="machine-executor-limit-actions">
          <button type="button" className="secondary-button" disabled={disabled || busy || !changed} onClick={() => void save()}>
            {busy && <LoaderCircle size={13} className="spin" />} {t.save}
          </button>
          {done && !changed && <span className="field-hint" role="status">{t.saved}</span>}
        </div>
      )}
      {(error || readError) && <p className="inline-error" role="alert">{[error, readError].filter(Boolean).join(" ")}</p>}
    </div>
  );
}
