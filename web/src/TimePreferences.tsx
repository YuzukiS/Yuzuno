import { SaveStatus } from "./SaveStatus";
import {
  clockFormatter,
  restoreDefaultTimePreferences,
  retryTimePreferencesWrite,
  saveTimePreferences,
  timePreferencesStored,
  useTimePreferences,
  useTimePreferencesSave,
  type ClockFormat,
} from "./time-preferences";
import "./device-preferences.css";

// Each choice shows how it writes 9:05 in the evening, today.
const sampleTime = clockFormatter({ hour: "numeric", minute: "2-digit" });
const sample = (clock: ClockFormat) => {
  const evening = new Date();
  evening.setHours(21, 5, 0, 0);
  return sampleTime(clock).format(evening);
};

const choices: { value: ClockFormat; label: string; note: string }[] = [
  { value: "system", label: "System", note: "As this browser writes times for its language and region." },
  { value: "h12", label: "12-hour", note: "Morning and evening hours, as this language writes a 12-hour clock." },
  { value: "h24", label: "24-hour", note: "Hours from 0 to 23." },
];

/** How times are written on this device (T-189): a 12- or 24-hour clock, or
 * the browser's own. The choice applies at once to every time shown where
 * it is used; whether it was saved here is said as Appearance says it
 * (SaveStatus), never "Saved" when the browser refused. */
export function TimePreferencesSection() {
  const { clock } = useTimePreferences();
  const save = useTimePreferencesSave();
  return (
    <section className="settings-section input-preferences time-preferences" aria-labelledby="settings-time-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-time-title">Clock format</h3>
          <p>How times are written. It is kept on this device only.</p>
        </div>
        <span className="settings-current" title="In effect now">
          {sample(clock)}
        </span>
      </header>
      <div className="settings-group">
        <fieldset className="input-send-key">
          <legend>Write times with</legend>
          {choices.map(({ value, label, note }) => (
            <label key={value} className="input-send-choice">
              <input
                type="radio"
                name="time-clock-format"
                value={value}
                checked={clock === value}
                onChange={() => saveTimePreferences({ clock: value })}
              />
              <span>
                <strong>
                  {label} · {sample(value)}
                </strong>
                <small>{note}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="input-preferences-fixed">
          Used for message times and Turn endings in conversations, and for times on Home. Other places, such as Jobs,
          CI and Settings, still write times as this browser does. Dates, time zones and relative times (“5 min ago”)
          don’t change, nor does any time Yuzuno stores.
        </p>
      </div>
      <SaveStatus
        outcome={save?.outcome ?? null}
        action={save?.action}
        attempt={save?.attempt}
        stored={timePreferencesStored()}
        scope="this device"
        onRetry={retryTimePreferencesWrite}
        onRestoreDefaults={restoreDefaultTimePreferences}
      />
    </section>
  );
}
