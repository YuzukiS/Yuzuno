import { useEffect, useId, useMemo, useRef, useState } from "react";
import { errorText, HttpError } from "../api";
import { useLanguage, useStrings } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
import { randomId } from "../random-id";
import { Tip, TipText } from "../Tip";
import { changeRefresh, refreshNow, removeRefresh } from "./home-api";
import { cadenceLabel, recentLabel, refreshClock, refreshDateTime, reasonText, weeklyRunsOf } from "./refresh-state";
import { refreshText } from "./refresh-text";
import type { RefreshCadence, Section, SectionRefresh } from "./types";
import "./refresh.css";

/** The hours a schedule may run every: the divisors of 24, as brief_update's refresh (YN-113 §1.3). */
const HOUR_CHOICES = [1, 2, 3, 4, 6, 8, 12];

type Draft = { every: RefreshCadence["every"]; at: string; hours: number; days: number[]; zone: string; instruction: string };

const draftOf = (refresh: SectionRefresh): Draft => ({
  every: refresh.cadence.every,
  at: refresh.cadence.at ?? "00:00",
  hours: refresh.cadence.hours ?? 1,
  days: refresh.cadence.days ?? [],
  zone: refresh.zone,
  instruction: refresh.instruction,
});

const cadenceOf = (draft: Draft): RefreshCadence =>
  draft.every === "day"
    ? { every: "day", at: draft.at }
    : draft.every === "hours"
      ? { every: "hours", at: draft.at, hours: draft.hours }
      : { every: "week", at: draft.at, days: [...draft.days].sort((a, b) => a - b) };

/**
 * A refreshing card's schedule (YN-113 R3, design §3.2): how often, when and
 * in which zone, the instruction the Agent follows, how many Turns a week it
 * is, its last ten runs, then Save, Pause, Refresh now and Remove schedule.
 * The user's own changes; nothing asks again (the user's rule), and every
 * write goes against the version the page read, so another window's change is
 * said and the panel takes Core's answer. The panel is the card's and the
 * report page's alike (`variant` is only how wide the fields sit).
 */
export function RefreshPanel({
  section,
  projectId,
  refresh,
  readOnly,
  variant = "card",
  panelId,
  onOpenIssues = null,
  onChanged,
  onClose,
}: {
  section: Section;
  projectId: string;
  refresh: SectionRefresh;
  readOnly: boolean;
  variant?: "card" | "report";
  /** The id the control that opens it points at (aria-controls). */
  panelId?: string;
  /** The card's past issues, where the report page lists them; null when there is nowhere to show them. */
  onOpenIssues?: (() => void) | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const language = useLanguage();
  const t = useStrings(refreshText);
  const time = useTimeDisplay();
  const clock = useMemo(() => refreshClock(time), [time]);
  const dates = useMemo(() => refreshDateTime(time), [time]);
  const recent = refresh.recent.slice(-10);
  const [draft, setDraft] = useState(() => draftOf(refresh));
  const shownVersion = useRef(refresh.version);
  useEffect(() => {
    // Core's new schedule (the answer to a write, or another window's): the fields take it; a read of the same
    // version leaves what the user is typing alone.
    if (shownVersion.current === refresh.version) return;
    shownVersion.current = refresh.version;
    setDraft(draftOf(refresh));
  }, [refresh]);
  const [busy, setBusy] = useState<"save" | "pause" | "now" | "remove" | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [nowRequest, setNowRequest] = useState(() => randomId());
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);
  const id = useId();
  const identity = section.id;
  const runs = weeklyRunsOf({ ...cadenceOf(draft) });
  const heading = refresh.enabled ? cadenceLabel(refresh.cadence, language, t) : t.pausedTag;

  async function write(what: "save" | "pause", body: { cadence?: RefreshCadence; zone?: string; instruction?: string; enabled?: boolean }) {
    if (identity === undefined) return;
    setBusy(what);
    setError("");
    try {
      await changeRefresh(projectId, identity, { version: refresh.version, ...body });
      if (what === "save") setSaved(true);
      onChanged();
    } catch (e) {
      setError(errorText(e));
      // A version conflict carries the schedule as it is now: take it.
      if (e instanceof HttpError && e.status === 409) onChanged();
    } finally {
      setBusy(null);
    }
  }

  function save() {
    if (draft.every !== "hours" && !/^\d\d:\d\d$/.test(draft.at)) return setError(t.panel.noTime);
    if (draft.every === "week" && draft.days.length === 0) return setError(t.panel.noDays);
    void write("save", { cadence: cadenceOf(draft), zone: draft.zone, instruction: draft.instruction.trim() });
  }

  async function now() {
    if (identity === undefined) return;
    setBusy("now");
    setError("");
    try {
      await refreshNow(projectId, identity, nowRequest);
      setNowRequest(randomId());
      onChanged();
    } catch (e) {
      setError(errorText(e));
      if (e instanceof HttpError && e.status === 409) onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (identity === undefined) return;
    setBusy("remove");
    setError("");
    try {
      await removeRefresh(projectId, identity);
      onChanged();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const disabled = readOnly || busy !== null;
  const nowWaiting = refresh.waiting?.manual ? refresh.waiting.agentName || section.owner.name : null;
  const going = refresh.run?.state === "sent";
  return (
    <section
      id={panelId}
      className={`home-refresh-panel is-${variant}`}
      aria-label={t.panel.title}
      aria-describedby={`${id}-note`}
      data-refresh-version={refresh.version}
      data-refresh-state={refresh.enabled ? (refresh.waiting ? "waiting" : going ? "refreshing" : "on") : "paused"}
    >
      <h4 className="home-refresh-heading">
        {heading}
        <span className="home-refresh-runs">{t.panel.weeklyRuns(refresh.weeklyRuns)}</span>
      </h4>
      <div className="home-refresh-frequency" role="group" aria-label={t.panel.frequency}>
        {(["day", "hours", "week"] as const).map((every) => (
          <button
            key={every}
            type="button"
            className="home-refresh-choice"
            aria-pressed={draft.every === every}
            disabled={disabled}
            onClick={() => setDraft((was) => ({ ...was, every }))}
          >
            {every === "day" ? t.panel.everyDay : every === "hours" ? t.panel.everyHours : t.panel.everyWeek}
          </button>
        ))}
      </div>
      <div className="home-refresh-when">
        {draft.every !== "hours" && (
          <label className="home-refresh-field">
            <span>{t.panel.time}</span>
            <input type="time" value={draft.at} disabled={disabled} onChange={(event) => setDraft((was) => ({ ...was, at: event.target.value }))} />
          </label>
        )}
        {draft.every === "hours" && (
          <div className="home-refresh-field" role="group" aria-label={t.panel.hoursBetween}>
            <span>{t.panel.hoursBetween}</span>
            <span className="home-refresh-choices">
              {HOUR_CHOICES.map((hours) => (
                <button
                  key={hours}
                  type="button"
                  className="home-refresh-choice"
                  aria-pressed={draft.hours === hours}
                  disabled={disabled}
                  onClick={() => setDraft((was) => ({ ...was, hours }))}
                >
                  {hours}
                </button>
              ))}
            </span>
          </div>
        )}
        {draft.every === "week" && (
          <div className="home-refresh-field" role="group" aria-label={t.panel.days}>
            <span>{t.panel.days}</span>
            <span className="home-refresh-choices">
              {t.panel.weekdays.map((name, index) => {
                const day = index + 1;
                return (
                  <button
                    key={day}
                    type="button"
                    className="home-refresh-choice"
                    aria-pressed={draft.days.includes(day)}
                    disabled={disabled}
                    onClick={() =>
                      setDraft((was) => ({ ...was, days: was.days.includes(day) ? was.days.filter((one) => one !== day) : [...was.days, day] }))
                    }
                  >
                    {name}
                  </button>
                );
              })}
            </span>
          </div>
        )}
        <label className="home-refresh-field">
          <span>{t.panel.zone}</span>
          <select value={draft.zone} disabled={disabled} onChange={(event) => setDraft((was) => ({ ...was, zone: event.target.value }))}>
            <option value="local">{t.panel.zoneLocal}</option>
            <option value="UTC">{t.panel.zoneUtc}</option>
          </select>
        </label>
      </div>
      <label className="home-refresh-field home-refresh-instruction">
        <span>{t.panel.instruction}</span>
        <textarea
          rows={3}
          maxLength={2000}
          value={draft.instruction}
          disabled={disabled}
          onChange={(event) => setDraft((was) => ({ ...was, instruction: event.target.value }))}
        />
      </label>
      <p id={`${id}-note`} className="home-refresh-note">
        {t.panel.instructionNote} · {t.panel.weeklyRuns(runs)}
      </p>
      {recent.length > 0 && (
        <div className="home-refresh-recent">
          <span>{t.panel.recent}</span>
          <ol aria-label={t.panel.recent}>
            {recent.map((run, index) => {
              const state = recentLabel(run, language);
              const reason = reasonText(run.reason, language);
              return (
                <Tip
                  key={`${run.slot} ${index}`}
                  content={<TipText title={dates(run.slot)} body={reason ? `${state} · ${reason}` : state} />}
                  describe={false}
                >
                  <li
                    data-state={run.state === "refreshed" && run.missed > 0 ? "caughtUp" : run.state}
                    aria-label={t.panel.recentItem(dates(run.slot), state, reason)}
                  >
                    <span aria-hidden="true" />
                  </li>
                </Tip>
              );
            })}
          </ol>
        </div>
      )}
      <div className="home-refresh-actions">
        <button type="button" className="primary-button" disabled={disabled} onClick={save}>
          {busy === "save" ? t.panel.saving : saved ? t.panel.saved : t.panel.save}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled}
          onClick={() => void write("pause", { enabled: !refresh.enabled })}
        >
          {busy === "pause" ? t.panel.saving : refresh.enabled ? t.panel.pause : t.panel.resume}
        </button>
        {refresh.enabled && (
          <button type="button" className="quiet-button" disabled={disabled || going || !!refresh.waiting} onClick={() => void now()}>
            {busy === "now" || going ? t.state.refreshing(going ? refresh.run?.missed ?? 0 : 0) : nowWaiting ? t.panel.waitingFor(nowWaiting) : t.panel.refreshNow}
          </button>
        )}
        {refresh.versions > 0 && onOpenIssues && (
          <button type="button" className="quiet-button home-refresh-history" disabled={disabled} onClick={onOpenIssues}>
            {t.panel.history(refresh.versions)} →
          </button>
        )}
        <button type="button" className="quiet-button danger" disabled={disabled} onClick={() => void remove()}>
          {busy === "remove" ? t.panel.removing : t.panel.remove}
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
