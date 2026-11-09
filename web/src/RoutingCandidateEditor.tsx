/** A candidate's editor in its card (YN-49 S4a): its name, tool, model,
 * effort, account or key, conditions and what an unavailable reading counts as. */
import { Plus, Trash2, X } from "lucide-react";
import { DEEPSEEK_PEAK, EFFORTS, HARNESSES, MODEL_HINTS, credentialFits, isKnown, keyFits, sameSchedule, usesApi, type AnyCondition, type Candidate, type Condition, type Credential, type Harness, type Schedule, type Slot } from "./executor-routing";
import { chipText, harnessName, providerName, type Text } from "./executor-routing-text";
import { shortFingerprint, type AccountsView, type RoutingKey } from "./routing-keys";


/** Whether a condition fits a credential: a daily spend cap is for an API key, the subscription left for an account (S3a). */
const fitsCredential = (cond: AnyCondition, credential: Credential) => (credential.kind === "apiKey" ? cond.kind !== "quota" : cond.kind !== "dailyApiCap");

/** The credential choices a harness offers, by a value of the select: "login", "pool", "key:<id>", "home:<id>". */
function credentialChoices(harness: Harness, t: Text, keys: RoutingKey[], accounts: AccountsView | null, current: Credential): { value: string; label: string }[] {
  const choices: { value: string; label: string }[] = [
    { value: "login", label: harness === "claude" ? t.credLoginClaude : harness === "codex" ? t.credLoginCodex : t.credLoginOpencode },
  ];
  if (harness === "claude") choices.push({ value: "pool", label: t.credPool });
  if (harness === "codex") for (const h of accounts?.codexHomes ?? []) choices.push({ value: `home:${h.id}`, label: t.credHome(h.label) });
  for (const k of keys) if (keyFits(harness, k.provider)) choices.push({ value: `key:${k.id}`, label: t.credKey(providerName[k.provider] ?? k.provider, k.id) });
  // The saved one, even if it's no longer offered: it stays chosen, marked.
  const value = credentialValue(current);
  if (!choices.some((c) => c.value === value)) choices.push({ value, label: current.kind === "apiKey" ? t.keyMissing(current.keyId) : current.kind === "codexHome" ? t.codexHomeMissing(current.id) : value });
  return choices;
}
const credentialValue = (c: Credential) => (c.kind === "apiKey" ? `key:${c.keyId}` : c.kind === "codexHome" ? `home:${c.id}` : c.kind);
const credentialOf = (value: string): Credential =>
  value === "pool" ? { kind: "pool", manager: "cswap", accounts: "all", pick: "mostRemaining" }
    : value.startsWith("key:") ? { kind: "apiKey", keyId: value.slice(4) }
      : value.startsWith("home:") ? { kind: "codexHome", id: value.slice(5) } : { kind: "login" };

export function CandidateEditor({ c, t, keys, accounts, issues, refusedCondition, onEdit, onRemove, onClose }: {
  c: Candidate; t: Text; keys: RoutingKey[]; accounts: AccountsView | null; issues: { at: string; text: string }[]; refusedCondition?: number;
  onEdit: (change: (c: Candidate) => Candidate) => void; onRemove: () => void; onClose: () => void;
}) {
  const choices = credentialChoices(c.harness, t, keys, accounts, c.credential);
  const api = usesApi(c);
  const has = (kind: string) => c.conditions.some((x) => x.kind === kind);
  const setConditions = (change: (list: AnyCondition[]) => AnyCondition[]) => onEdit((x) => ({ ...x, conditions: change(x.conditions) }));
  const pool = c.credential.kind === "pool" ? c.credential : null;
  const cswapAccounts = accounts?.cswap.accounts ?? [];
  const field = (key: string, value: unknown) => onEdit((x) => {
    const next = { ...x } as Candidate;
    if (value === "" || value == null) delete next[key]; else next[key] = value;
    return next;
  });
  return (
    <div className="routing-edit" id={`routing-edit-${c.id}`}>
      <div className="routing-edit-grid">
        <label className="routing-field"><span>{t.label}</span>
          <input className="settings-input" value={c.label ?? ""} maxLength={60} placeholder={t.labelPlaceholder} onChange={(e) => field("label", e.target.value)} />
        </label>
        <label className="routing-field"><span>{t.harness}</span>
          <select className="settings-select" value={c.harness} onChange={(e) => {
            const harness = e.target.value as Harness;
            onEdit((x) => {
              const { reasoningEffort: _, ...rest } = x;
              const keyKept = x.credential.kind !== "apiKey" || keys.some((k) => k.id === (x.credential as { keyId: string }).keyId && keyFits(harness, k.provider));
              // A reasoning effort is Codex's only (S3a); an account or key the new tool can't use goes back to the host's login,
              // and then, as when the credential is chosen, a daily spend cap goes with the key (R1 75964dfb).
              const credential: Credential = credentialFits(harness, x.credential) && keyKept ? x.credential : { kind: "login" };
              return { ...(harness === "codex" ? x : rest), harness, model: MODEL_HINTS[harness][0], credential,
                conditions: x.conditions.filter((cond) => fitsCredential(cond, credential)) } as Candidate;
            });
          }}>
            {HARNESSES.map((h) => <option key={h} value={h}>{harnessName[h]}</option>)}
          </select>
        </label>
        <label className="routing-field"><span>{t.model}</span>
          <input className="settings-input" value={c.model ?? ""} list={`routing-models-${c.harness}`} spellCheck={false} placeholder={t.modelPlaceholder}
            onChange={(e) => onEdit((x) => ({ ...x, model: e.target.value }))} />
          <datalist id={`routing-models-${c.harness}`}>{MODEL_HINTS[c.harness].map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        {c.harness === "codex" && (
          <label className="routing-field"><span>{t.effort}</span>
            <select className="settings-select" value={c.reasoningEffort ?? ""} onChange={(e) => field("reasoningEffort", e.target.value)}>
              <option value="">{t.effortDefault}</option>
              {[...EFFORTS, ...(c.reasoningEffort && !EFFORTS.includes(c.reasoningEffort) ? [c.reasoningEffort] : [])].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
        )}
        <label className="routing-field routing-field-wide"><span>{t.credential}</span>
          <select className="settings-select" value={credentialValue(c.credential)} onChange={(e) => {
            const credential = credentialOf(e.target.value);
            onEdit((x) => ({ ...x, credential, conditions: x.conditions.filter((cond) => fitsCredential(cond, credential)) }));
          }}>
            {choices.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>
      {pool && (
        <fieldset className="routing-field routing-pool">
          <legend>{t.poolAccounts}</legend>
          <label><input type="radio" name={`pool-${c.id}`} checked={pool.accounts === "all"} onChange={() => onEdit((x) => ({ ...x, credential: { ...pool, accounts: "all" } }))} /> {t.poolAll}</label>
          <label><input type="radio" name={`pool-${c.id}`} checked={pool.accounts !== "all"}
            onChange={() => onEdit((x) => ({ ...x, credential: { ...pool, accounts: cswapAccounts.map((a) => a.fingerprint) } }))} /> {t.poolSome}</label>
          {pool.accounts !== "all" && (cswapAccounts.length ? (
            <div className="routing-pool-accounts">
              {cswapAccounts.map((a) => {
                const chosen = (pool.accounts as string[]).includes(a.fingerprint);
                return (
                  <label key={a.fingerprint}>
                    <input type="checkbox" checked={chosen} onChange={() => onEdit((x) => ({ ...x, credential: { ...pool,
                      accounts: chosen ? (pool.accounts as string[]).filter((f) => f !== a.fingerprint) : [...(pool.accounts as string[]), a.fingerprint] } }))} />
                    {t.account(a.number)} <code>{shortFingerprint(a.fingerprint)}</code>
                  </label>
                );
              })}
            </div>
          ) : <p className="settings-row-meta">{t.noAccounts}</p>)}
        </fieldset>
      )}
      <div className="routing-field routing-conditions">
        <span>{t.conditions}</span>
        {c.conditions.length === 0 && <p className="settings-row-meta">{t.noConditions}</p>}
        <ul className="routing-conds">
          {c.conditions.map((cond, i) => (
            <li key={i} className={`routing-cond${refusedCondition === i ? " is-refused" : ""}`}>
              <ConditionEditor cond={cond} n={i} t={t} onChange={(next) => setConditions((list) => list.map((x, k) => (k === i ? next : x)))} />
              <button type="button" className="icon-button routing-cond-remove" aria-label={`${t.removeCondition} (${chipText(cond, t)})`}
                onClick={() => setConditions((list) => list.filter((_, k) => k !== i))}><X size={14} /></button>
              {issues.filter((p) => p.at === String(i)).map((p) => <span key={p.text} className="inline-error routing-cond-error">{p.text}</span>)}
            </li>
          ))}
        </ul>
        <div className="routing-add-menu">
          {!has("timeWindow") && <button type="button" className="quiet-button" onClick={() => setConditions((l) => [...l, { kind: "timeWindow", inside: false, schedule: DEEPSEEK_PEAK, minMinutesLeft: 30 }])}><Plus size={13} /> {t.addTime}</button>}
          {!has("quota") && !api && <button type="button" className="quiet-button" onClick={() => setConditions((l) => [...l, { kind: "quota", weekLeftPct: 10 }])}><Plus size={13} /> {t.addQuota}</button>}
          {!has("dailyApiCap") && api && <button type="button" className="quiet-button" onClick={() => setConditions((l) => [...l, { kind: "dailyApiCap", usd: 5 }])}><Plus size={13} /> {t.addCap}</button>}
        </div>
      </div>
      <fieldset className="routing-field routing-unknown">
        <legend>{t.unknown}</legend>
        {(["skip", "pass"] as const).map((v) => (
          <label key={v}><input type="radio" name={`unknown-${c.id}`} checked={c.unknown === v} onChange={() => onEdit((x) => ({ ...x, unknown: v }))} /> {v === "skip" ? t.skip : t.pass}</label>
        ))}
      </fieldset>
      {issues.filter((p) => p.at === "").map((p) => <p key={p.text} className="inline-error">{p.text}</p>)}
      <div className="routing-form-actions">
        <button type="button" className="quiet-button routing-danger" onClick={onRemove}><Trash2 size={14} /> {t.remove}</button>
        <span className="routing-spacer" />
        <button type="button" className="secondary-button" onClick={onClose}>{t.done}</button>
      </div>
    </div>
  );
}

const numberOrUnset = (value: string) => (value === "" ? undefined : Number(value));
/** `to` as a time field shows it: 24:00, midnight at the end, is 00:00 there. */
const toField = (to: string) => (to === "24:00" ? "00:00" : to);
const fromField = (value: string) => (value === "00:00" ? "24:00" : value);

function ConditionEditor({ cond, n, t, onChange }: { cond: AnyCondition; n: number; t: Text; onChange: (next: AnyCondition) => void }) {
  if (!isKnown(cond)) return <span className="routing-cond-kind">{t.chipUnknownKind(cond.kind)}</span>;
  if (cond.kind === "quota") {
    const set = (value: string) => {
      const next: Condition = { ...cond };
      const v = numberOrUnset(value);
      if (v == null) delete next.weekLeftPct; else next.weekLeftPct = Math.max(0, Math.min(100, v));
      onChange(next);
    };
    return <>
      <b className="routing-cond-kind">{t.quota}</b>
      <label className="routing-inline-field">{t.week}
        <input type="number" className="settings-input routing-number" min={0} max={100} value={cond.weekLeftPct ?? ""} onChange={(e) => set(e.target.value)} />%</label>
    </>;
  }
  if (cond.kind === "dailyApiCap") {
    return <>
      <b className="routing-cond-kind">{t.cap}</b>
      <label className="routing-inline-field">{t.capOwn}
        <input type="number" className="settings-input routing-number" min={0} step={1} inputMode="decimal" value={Number.isFinite(cond.usd) ? cond.usd : ""}
          aria-invalid={!(cond.usd > 0) || undefined} onChange={(e) => onChange({ ...cond, usd: e.target.value === "" ? NaN : Number(e.target.value) })} /></label>
    </>;
  }
  const deepseek = sameSchedule(cond.schedule, DEEPSEEK_PEAK);
  const schedule = cond.schedule;
  const setSlots = (slots: Slot[]) => onChange({ ...cond, schedule: { ...schedule, slots } });
  const setSlot = (i: number, slot: Partial<Slot>) => setSlots(schedule.slots.map((s, k) => (k === i ? { ...s, ...slot } : s)));
  return (
    <div className="routing-window">
      <div className="routing-window-head">
        <b className="routing-cond-kind">{t.timeWindow}</b>
        <select className="settings-select" aria-label={`${t.timeWindow} ${n + 1}`} value={cond.inside ? "inside" : "outside"} onChange={(e) => onChange({ ...cond, inside: e.target.value === "inside" })}>
          <option value="outside">{t.outsideOption}</option>
          <option value="inside">{t.insideOption}</option>
        </select>
        <label className="routing-inline-field">{t.timeZone}
          <select className="settings-select" value={schedule.timeZone} onChange={(e) => onChange({ ...cond, schedule: { ...schedule, timeZone: e.target.value as Schedule["timeZone"] } })}>
            <option value="UTC">{t.utc}</option>
            <option value="local">{t.local}</option>
          </select>
        </label>
        <button type="button" className="quiet-button" aria-pressed={deepseek} onClick={() => onChange({ ...cond, schedule: DEEPSEEK_PEAK })}>{t.useDeepseek}</button>
      </div>
      {deepseek && <p className="settings-row-meta">{t.deepseekHelp}</p>}
      <ol className="routing-slots">
        {schedule.slots.map((slot, i) => (
          <li key={i} className="routing-slot">
            <span className="routing-days" role="group" aria-label={t.slot(i + 1)}>
              {t.days.map((day, d) => (
                <button type="button" key={day} aria-pressed={slot.days.includes(d + 1)} aria-label={t.dayOf(i + 1, day)}
                  onClick={() => setSlot(i, { days: slot.days.includes(d + 1) ? slot.days.filter((x) => x !== d + 1) : [...slot.days, d + 1].sort((a, b) => a - b) })}>
                  {day.replace("周", "")}
                </button>
              ))}
            </span>
            <input type="time" className="settings-input routing-time" aria-label={t.from(i + 1)} value={slot.from} step={900} onChange={(e) => e.target.value && setSlot(i, { from: e.target.value })} />
            <span aria-hidden="true">–</span>
            <input type="time" className="settings-input routing-time" aria-label={t.to(i + 1)} value={toField(slot.to)} step={900} onChange={(e) => e.target.value && setSlot(i, { to: fromField(e.target.value) })} />
            <button type="button" className="icon-button" aria-label={t.removeSlot(i + 1)} onClick={() => setSlots(schedule.slots.filter((_, k) => k !== i))}><X size={13} /></button>
          </li>
        ))}
      </ol>
      <div className="routing-form-actions">
        <button type="button" className="quiet-button" disabled={schedule.slots.length >= 16}
          onClick={() => setSlots([...schedule.slots, { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }])}><Plus size={13} /> {t.addSlot}</button>
        <span className="settings-row-meta">{t.toHelp}</span>
      </div>
      <label className="routing-inline-field">{t.minLeft}
        <input type="number" className="settings-input routing-number" min={1} max={1440} step={5} value={cond.minMinutesLeft ?? ""}
          aria-invalid={(cond.minMinutesLeft != null && cond.minMinutesLeft > 1440) || undefined}
          onChange={(e) => { const next = { ...cond }; const v = numberOrUnset(e.target.value); if (!v) delete next.minMinutesLeft; else next.minMinutesLeft = v; onChange(next); }} />
        {t.minutes}
      </label>
    </div>
  );
}
