import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronUp, CircleAlert, CircleHelp, Clock, Gauge, GripVertical, Layers, Pencil, Plus, Wallet } from "lucide-react";
import { errorText } from "./api";
import { PRESETS, PolicyRefused, isKnown, modelShort, moved, newCandidateId, pathPlace, presetCandidates, readPolicy, savePolicy, type AnyCondition, type Candidate, type Harness, type Policy, type PolicyView, type PresetId } from "./executor-routing";
import { langTag, useLanguage } from "./i18n";
import { ROUTING_CREDENTIALS_CHANGED, readAccountsShared, readKeys, type AccountsView, type RoutingKey } from "./routing-keys";
import { CandidateLive, NowCard, RecentChoices, SpendLine, StatePill, useLiveRouting } from "./RoutingLive";
import { RoutingSimulate } from "./RoutingSimulate";
import { RoutingTemplates } from "./RoutingTemplates";
import type { RouteCandidate, RouteRecord } from "./routing-live";
import { useSaveBarPart } from "./SettingsSaveBar";
import { Tip, TipText } from "./Tip";
import { timeFormatter, useTimeDisplay } from "./time-preferences";
import { chipText, harnessName, nameOf, problemsOf, slotWords, titleOf, usdFits, zoneWords, credentialWords, text, type Text } from "./executor-routing-text";
import { CandidateEditor } from "./RoutingCandidateEditor";
import "./executor-routing.css";

const savedAt = timeFormatter({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const chipIcon = (c: AnyCondition) => (c.kind === "timeWindow" ? Clock : c.kind === "quota" ? Gauge : c.kind === "dailyApiCap" ? Wallet : CircleHelp);

/** Settings → Executor routing: the ordered candidates (YN-49 S4a), saved
 * whole against the version read, through the page's save bar. */
export function ExecutorRouting({ active }: { active: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const time = useTimeDisplay();
  const [view, setView] = useState<PolicyView | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [readError, setReadError] = useState("");
  // null until read: a key a candidate names is called missing only from a list that was read.
  const [keys, setKeys] = useState<RoutingKey[] | null>(null);
  const [accounts, setAccounts] = useState<AccountsView | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [conflict, setConflict] = useState<PolicyView | null>(null);
  const [refused, setRefused] = useState<{ text: string; path?: string } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [asking, setAsking] = useState<PresetId | null>(null);
  const [live, setLive] = useState("");
  // Each candidate's colour, by id, in the order first seen: a move keeps it.
  const colours = useRef(new Map<string, number>());
  const colourOf = (id: string) => {
    if (!colours.current.has(id)) {
      const used = new Set(colours.current.values());
      let n = 1;
      while (used.has(n) && n < 8) n++;
      colours.current.set(id, used.has(n) ? (colours.current.size % 8) + 1 : n);
    }
    return colours.current.get(id)!;
  };
  const focusGrip = useRef<string | null>(null);
  // Read by the page's re-read when it is shown again: an unsaved change, and the version it was read at.
  const editing = useRef<{ changed: boolean; version?: number }>({ changed: false });

  const adopt = (next: PolicyView) => { setView(next); setDraft(next.policy); setConflict(null); setRefused(null); setSaveError(""); };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const signal = controller.signal;
    setReadError("");
    readPolicy(signal).then((next) => {
      if (signal.aborted) return;
      // Coming back to the page keeps what is being edited (R1 75964dfb): a
      // fresh read replaces only a draft with no change, and a version saved
      // meanwhile is shown as one, never put over the changes.
      if (!editing.current.changed) adopt(next);
      else if (next.version !== editing.current.version) setConflict(next);
    }).catch((e) => { if (!signal.aborted) setReadError(errorText(e)); });
    // Keys and accounts as Accounts and keys below shows them; that block says why when they can't be read.
    const credentials = () => {
      readKeys(signal).then((next) => { if (!signal.aborted) setKeys(next.keys); }).catch(() => {});
      readAccountsShared().then((next) => { if (!signal.aborted) setAccounts(next); }).catch(() => {});
    };
    credentials();
    window.addEventListener(ROUTING_CREDENTIALS_CHANGED, credentials);
    return () => { controller.abort(); window.removeEventListener(ROUTING_CREDENTIALS_CHANGED, credentials); };
  }, [active]);
  useLayoutEffect(() => {
    if (!focusGrip.current) return;
    const id = focusGrip.current;
    [...document.querySelectorAll<HTMLElement>(".routing-cand")].find((card) => card.dataset.cand === id)
      ?.querySelector<HTMLButtonElement>(".routing-grip")?.focus();
    focusGrip.current = null;
  });

  const policy = draft;
  const changed = !!view && !!policy && JSON.stringify(policy) !== JSON.stringify(view.policy);
  editing.current = { changed, version: view?.version };
  const problems = new Map((policy?.candidates ?? []).map((c) => [c.id, problemsOf(c, t, keys, accounts)]));
  const capBad = policy?.dailyApiCapUsd != null && !usdFits(policy.dailyApiCapUsd);
  const invalid = [...problems.values()].some((p) => p.length > 0) || capBad;
  // What Core would choose now, by this page's policy, unsaved changes included
  // (S4b); not asked while the draft can't be saved.
  const evaluation = useLiveRouting(policy, active && !!view, invalid);
  const edit = (change: (p: Policy) => Policy) => { setDraft((p) => (p ? change(p) : p)); setRefused(null); setSaveError(""); };
  const editCandidate = (id: string, change: (c: Candidate) => Candidate) =>
    edit((p) => ({ ...p, candidates: p.candidates.map((c) => (c.id === id ? change(c) : c)) }));
  const move = (from: number, to: number, focus = false) => {
    if (!policy || to < 0 || to >= policy.candidates.length || from === to) return;
    const c = policy.candidates[from];
    edit((p) => ({ ...p, candidates: moved(p.candidates, from, to) }));
    setLive(t.movedTo(nameOf(c), to + 1));
    if (focus) focusGrip.current = c.id;
  };

  async function save(): Promise<boolean> {
    if (!policy || !view) return false;
    try {
      adopt(await savePolicy(view.version, policy));
      return true;
    } catch (e) {
      if (e instanceof PolicyRefused && e.code === "version_conflict") {
        setConflict(e.current ?? await readPolicy().catch(() => null));
      } else if (e instanceof PolicyRefused && e.code === "invalid") {
        setRefused({ text: e.message, path: e.path });
        const at = pathPlace(e.path).candidate;
        if (at != null && policy.candidates[at]) setOpen(policy.candidates[at].id);
      } else setSaveError(errorText(e));
      return false;
    }
  }
  useSaveBarPart("executor-routing", changed && view ? {
    ready: !invalid && !conflict,
    save,
    discard: () => { if (view) adopt(view); },
  } : null);

  const limit = view?.limits.candidates ?? 8;
  const addCandidate = () => {
    if (!policy) return;
    const id = newCandidateId(policy.candidates.map((c) => c.id));
    edit((p) => ({ ...p, candidates: [...p.candidates, { id, enabled: true, harness: "claude", model: "sonnet", credential: { kind: "login" }, conditions: [], unknown: "skip" }] }));
    setOpen(id);
  };
  const applyPreset = (preset: PresetId) => {
    edit((p) => ({ ...p, candidates: presetCandidates(preset, keys ?? [], p.candidates.map((c) => c.id)).slice(0, limit) }));
    setAsking(null);
    setOpen(null);
  };
  const refusedPlace = pathPlace(refused?.path);
  const refusedId = refusedPlace.candidate != null ? policy?.candidates[refusedPlace.candidate]?.id : undefined;

  return (
    <section className="settings-section executor-routing" aria-labelledby="routing-title" lang={langTag(language)}>
      <header className="settings-section-heading">
        <div>
          <h3 id="routing-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
        {policy && (
          <label className="routing-head-switch">
            <input type="checkbox" role="switch" className="settings-toggle" aria-label={t.switchLabel} checked={policy.enabled}
              onChange={(e) => edit((p) => ({ ...p, enabled: e.target.checked }))} />
            {policy.enabled ? t.on : t.off}
          </label>
        )}
      </header>
      {readError && <p className="inline-error" role="alert">{readError}</p>}
      {active && !view && !readError && <p className="settings-row-help" role="status">{t.reading}</p>}
      {conflict && (
        <div className="routing-conflict" role="alert">
          <p><CircleAlert size={14} className="routing-icon" aria-hidden="true" /> {t.conflict(conflict.version, conflict.updatedAt && Number.isFinite(Date.parse(conflict.updatedAt)) ? savedAt(time).format(Date.parse(conflict.updatedAt)) : "")}</p>
          <p className="settings-row-help">{conflict.policy.enabled ? t.conflictOrder : t.conflictOff}</p>
          {conflict.policy.enabled && <ol className="routing-conflict-order">{conflict.policy.candidates.map((c) => <li key={c.id}>{nameOf(c)}</li>)}</ol>}
          <div className="routing-form-actions">
            <button type="button" className="secondary-button" onClick={() => adopt(conflict)}>{t.useSaved}</button>
            <button type="button" className="quiet-button" onClick={() => { setView(conflict); setConflict(null); }}>{t.keepMine}</button>
          </div>
        </div>
      )}
      {refused && (
        <p className="inline-error routing-refused" role="alert">
          {refusedPlace.candidate != null ? t.refusedAt(refusedPlace.candidate + 1, refusedPlace.condition) : t.refused} <span lang="en">{refused.text}</span>
        </p>
      )}
      {saveError && <p className="inline-error" role="alert">{saveError}</p>}
      {policy && view && <>
        {!policy.enabled && <p className="settings-block-help routing-off-note">{t.offNote}</p>}
        <NowCard record={evaluation.record} policy={policy} names={nameOf} colourOf={colourOf} changed={changed} error={evaluation.error} unavailable={evaluation.unavailable} held={evaluation.held} refused={evaluation.refused} />
        <div className="routing-order-head">
          <h4 className="settings-group-title">{t.orderTitle} <span className="settings-current">{t.version(view.version)}</span></h4>
          <p className="settings-block-help">{t.orderHelp}</p>
        </div>
        <CandidateList policy={policy} t={t} keys={keys} accounts={accounts} live={policy.enabled ? evaluation.record : null} open={open} problems={problems} refusedId={refusedId}
          refusedCondition={refusedPlace.condition} colourOf={colourOf} onOpen={setOpen} onMove={move}
          onEdit={editCandidate} onRemove={(id) => { edit((p) => ({ ...p, candidates: p.candidates.filter((c) => c.id !== id) })); setOpen(null); }} />
        <p className="sr-only" role="status" aria-live="polite">{live}</p>
        <div className="routing-list-foot">
          <button type="button" className="secondary-button" disabled={policy.candidates.length >= limit} onClick={addCandidate}><Plus size={14} /> {t.add}</button>
          {policy.candidates.length >= limit && <small className="settings-row-meta">{t.max(limit)}</small>}
          <span className="settings-row-meta">{t.presets}</span>
          {PRESETS.map((p) => (
            <button type="button" key={p} className="quiet-button" aria-pressed={asking === p}
              onClick={() => (policy.candidates.length ? setAsking(p) : applyPreset(p))}>{t.preset[p]}</button>
          ))}
        </div>
        {asking && (
          <div className="settings-confirm" role="group" aria-label={t.presetReplace(t.preset[asking])}>
            <p>{t.presetReplace(t.preset[asking])}</p>
            <span className="settings-confirm-actions">
              <button type="button" className="secondary-button" onClick={() => applyPreset(asking)}>{t.replace}</button>
              <button type="button" className="quiet-button" onClick={() => setAsking(null)}>{t.cancel}</button>
            </span>
          </div>
        )}
        {policy.enabled && policy.candidates.length > 0 && (
          <RoutingSimulate policy={policy} active={active} names={nameOf} colourOf={colourOf} accounts={accounts} keys={keys} />
        )}
        <div className="settings-group routing-workspace">
          <div className="settings-row">
            <Clock size={16} className="settings-row-icon" aria-hidden="true" />
            <div className="settings-row-main">
              <span className="settings-row-title">{t.whenNoneTitle}</span>
              <p className="settings-row-help">{t.whenNoneWait}</p>
            </div>
          </div>
          <div className="settings-row">
            <Wallet size={16} className="settings-row-icon" aria-hidden="true" />
            <div className="settings-row-main">
              <span className="settings-row-title">{t.capTitle}</span>
              <p className="settings-row-help">{t.capHelp}</p>
              <label className="routing-inline-field">
                <span>{t.capInput}</span>
                <input type="number" className="settings-input routing-number" min={0} step={1} inputMode="decimal" placeholder={t.capNone}
                  aria-label={t.capInput} value={policy.dailyApiCapUsd ?? ""} aria-invalid={capBad || undefined}
                  onChange={(e) => edit((p) => {
                    const { dailyApiCapUsd: _, ...rest } = p;
                    return e.target.value === "" ? (rest as Policy) : { ...rest, dailyApiCapUsd: Number(e.target.value) };
                  })} />
              </label>
              {capBad && <span className="inline-error">{t.capBad}</span>}
              <SpendLine active={active} cap={policy.dailyApiCapUsd} />
            </div>
          </div>
        </div>
        <RoutingTemplates active={active} />
        <RecentChoices active={active} names={(id, fallback) => {
          const c = policy.candidates.find((x) => x.id === id);
          return c ? nameOf(c) : fallback?.label || [fallback?.harness && (harnessName[fallback.harness as Harness] ?? fallback.harness), modelShort(fallback?.model ?? "")].filter(Boolean).join(" · ") || id;
        }} />
      </>}
    </section>
  );
}

/** The candidates as cards, reordered by a handle's drag, its arrow keys, or the arrows beside each card. */
function CandidateList({ policy, t, keys, accounts, live, open, problems, refusedId, refusedCondition, colourOf, onOpen, onMove, onEdit, onRemove }: {
  policy: Policy; t: Text; keys: RoutingKey[] | null; accounts: AccountsView | null; live: RouteRecord | null; open: string | null;
  problems: Map<string, { at: string; text: string }[]>; refusedId?: string; refusedCondition?: number;
  colourOf: (id: string) => number; onOpen: (id: string | null) => void; onMove: (from: number, to: number, focus?: boolean) => void;
  onEdit: (id: string, change: (c: Candidate) => Candidate) => void; onRemove: (id: string) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number; y0: number; line: number } | null>(null);
  const cards = () => [...(list.current?.querySelectorAll<HTMLLIElement>(":scope > .routing-cand") ?? [])];
  const start = (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ from: index, to: index, dy: 0, y0: event.clientY, line: -1 });
  };
  const follow = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const dy = event.clientY - drag.y0;
    const items = cards();
    const dragged = items[drag.from];
    if (!dragged || !list.current) return;
    const top = list.current.getBoundingClientRect().top;
    const middle = dragged.getBoundingClientRect().top - (drag.dy) + dragged.offsetHeight / 2 + dy;
    // The place among the others whose middles are above the dragged card's.
    const others = items.filter((_, i) => i !== drag.from);
    let to = 0;
    for (const other of others) if (other.getBoundingClientRect().top + other.offsetHeight / 2 < middle) to++;
    const edge = to < others.length ? others[to].getBoundingClientRect().top - 4 : others.at(-1) ? others.at(-1)!.getBoundingClientRect().bottom + 4 : 0;
    setDrag({ ...drag, dy, to, line: edge - top });
  };
  const end = () => {
    if (drag && drag.to !== drag.from) onMove(drag.from, drag.to);
    setDrag(null);
  };
  const keyMove = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    onMove(index, index + (event.key === "ArrowUp" ? -1 : 1), true);
  };
  if (!policy.candidates.length) return <p className="settings-block-help routing-none">{t.none}</p>;
  return (
    <ol ref={list} className={`routing-list${policy.enabled ? "" : " is-off"}`} aria-label={t.orderTitle}>
      {policy.candidates.map((c, i) => {
        const title = titleOf(c);
        const name = nameOf(c);
        const cred = credentialWords(c, t, keys, accounts);
        const issues = problems.get(c.id) ?? [];
        const expanded = open === c.id;
        const dragging = drag?.from === i;
        const readingBound = c.conditions.some((x) => x.kind === "quota") || c.credential.kind === "pool";
        const now: RouteCandidate | undefined = live?.candidates.find((x) => x.id === c.id);
        return (
          <li key={c.id} className={`routing-cand${c.enabled ? "" : " is-disabled"}${dragging ? " is-dragging" : ""}${refusedId === c.id ? " is-refused" : ""}${now?.state === "chosen" ? " is-chosen" : ""}`}
            data-cand={c.id} style={{ ["--cc" as string]: `var(--route-c${colourOf(c.id)})`, ...(dragging ? { transform: `translateY(${drag.dy}px)` } : {}) }}>
            <div className="routing-cand-head">
              <button type="button" className="routing-grip" aria-label={t.grip(name)} aria-roledescription="sortable"
                onPointerDown={(e) => start(e, i)} onPointerMove={follow} onPointerUp={end} onPointerCancel={() => setDrag(null)} onKeyDown={(e) => keyMove(e, i)}>
                <GripVertical size={16} aria-hidden="true" />
              </button>
              <span className={`routing-num${colourOf(c.id) === 4 ? " is-light" : ""}`} aria-hidden="true">{i + 1}</span>
              <div className="routing-cand-main">
                <div className="routing-cand-title">
                  <span>{title}</span>
                  {c.credential.kind === "apiKey" ? <span className="settings-tag">{t.tagApi}</span>
                    : c.harness !== "opencode" && <span className="settings-tag">{t.tagSub}</span>}
                  {issues.length > 0 && !expanded && <span className="settings-tag is-error">{t.needsFix}</span>}
                </div>
                <div className={`routing-cand-sub${cred.missing ? " is-missing" : ""}`}>{cred.missing && <CircleAlert size={12} className="routing-icon" aria-hidden="true" />} {cred.text}</div>
              </div>
              <div className="routing-cand-end">
                <StatePill state={now?.state} />
                <span className="routing-move">
                  <button type="button" className="icon-button" aria-label={t.moveUp(name)} disabled={i === 0} onClick={() => onMove(i, i - 1)}><ChevronUp size={16} /></button>
                  <button type="button" className="icon-button" aria-label={t.moveDown(name)} disabled={i === policy.candidates.length - 1} onClick={() => onMove(i, i + 1)}><ChevronDown size={16} /></button>
                </span>
                <input type="checkbox" role="switch" className="settings-toggle" aria-label={t.enable(name)} checked={c.enabled}
                  onChange={(e) => onEdit(c.id, (x) => ({ ...x, enabled: e.target.checked }))} />
                <button type="button" className="icon-button" aria-expanded={expanded} aria-controls={`routing-edit-${c.id}`}
                  aria-label={expanded ? t.collapse(name) : t.edit(name)} onClick={() => onOpen(expanded ? null : c.id)}>
                  {expanded ? <ChevronUp size={15} /> : <Pencil size={15} />}
                </button>
              </div>
            </div>
            <div className="routing-cand-body">
              <div className="routing-chips">
                {c.conditions.map((cond, n) => {
                  const Icon = chipIcon(cond);
                  const chip = <span key={n} className="routing-chip"><Icon size={13} aria-hidden="true" /><span>{chipText(cond, t)}</span></span>;
                  // A time window's chip names its first period; its tip has every one (YN-44's Tip).
                  return isKnown(cond) && cond.kind === "timeWindow"
                    ? <Tip key={n} content={<TipText title={`${t.timeWindow} · ${zoneWords(cond.schedule, t)}`} status={cond.inside ? t.insideOption : t.outsideOption}
                        body={cond.schedule.slots.map((slot) => slotWords(slot, t)).join(t.slotJoin)} />}>{chip}</Tip>
                    : chip;
                })}
                {c.credential.kind === "pool" && <span className="routing-chip"><Layers size={13} aria-hidden="true" /><span>{t.chipPick}</span></span>}
                {readingBound && <span className="routing-chip"><CircleHelp size={13} aria-hidden="true" /><span>{c.unknown === "pass" ? t.chipPass : t.chipSkip}</span></span>}
              </div>
              <CandidateLive live={now} />
              {expanded && (
                <CandidateEditor c={c} t={t} keys={keys ?? []} accounts={accounts} issues={issues} refusedCondition={refusedId === c.id ? refusedCondition : undefined}
                  onEdit={(change) => onEdit(c.id, change)} onRemove={() => onRemove(c.id)} onClose={() => onOpen(null)} />
              )}
            </div>
          </li>
        );
      })}
      {drag && drag.to !== drag.from && <li className="routing-drop-line" aria-hidden="true" style={{ top: drag.line }} />}
    </ol>
  );
}
