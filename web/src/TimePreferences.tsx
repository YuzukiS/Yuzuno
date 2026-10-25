import { SaveStatus } from "./SaveStatus";
import {
  restoreDefaultTimePreferences,
  retryTimePreferencesWrite,
  saveTimePreferences,
  systemTimeZone,
  timeFormatter,
  timePreferencesStored,
  timeZoneName as zoneName,
  timeZones,
  useTimePreferences,
  useTimePreferencesSave,
  type ClockFormat,
} from "./time-preferences";
import "./device-preferences.css";

// Each clock format shows how it writes 9:05 in the evening, today, here.
const sampleTime = timeFormatter({ hour: "numeric", minute: "2-digit" });
const sample = (clock: ClockFormat) => {
  const evening = new Date();
  evening.setHours(21, 5, 0, 0);
  return sampleTime({ clock, timeZone: null }).format(evening);
};

const choices: { value: ClockFormat; label: string; note: string }[] = [
  { value: "system", label: "System", note: "As this browser writes times for its language and region." },
  { value: "h12", label: "12-hour", note: "Morning and evening hours, as this language writes a 12-hour clock." },
  { value: "h24", label: "24-hour", note: "Hours from 0 to 23." },
];

/** How times are written on this device (T-189): a 12- or 24-hour clock, or
 * the browser's own, in this device's time zone or another. A choice applies
 * at once to every time shown where it is used; whether it was saved here is
 * said as Appearance says it (SaveStatus), never "Saved" when the browser
 * refused. */
export function TimePreferencesSection() {
  const preferences = useTimePreferences();
  const { clock, timeZone } = preferences;
  const save = useTimePreferencesSave();
  const own = systemTimeZone();
  const zones = timeZones();
  return (
    <section className="settings-section input-preferences time-preferences" aria-labelledby="settings-time-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-time-title">Clock & time zone</h3>
          <p>How times are written. It is kept on this device only.</p>
        </div>
        <span className="settings-current" title="In effect now">
          {sample(clock)}
          {timeZone && ` · ${zoneName(timeZone)}`}
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
                onChange={() => saveTimePreferences({ ...preferences, clock: value })}
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
        <fieldset className="input-send-key time-zone-choice">
          <legend>Show times in</legend>
          <select
            className="settings-select"
            aria-label="Time zone"
            value={timeZone ?? ""}
            onChange={(event) => saveTimePreferences({ ...preferences, timeZone: event.target.value || null })}
          >
            <option value="">This device’s time zone · {zoneName(own)}</option>
            {/* A saved zone this browser can show but doesn't list stays choosable. */}
            {timeZone && !zones.includes(timeZone) && <option value={timeZone}>{zoneName(timeZone)}</option>}
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zoneName(zone)}
              </option>
            ))}
          </select>
        </fieldset>
        <p className="input-preferences-fixed">
          Used for message times and Turn endings in conversations, and for times on Home, with their dates in that time
          zone. Other places, such as Jobs, CI and Settings, still write times as this browser does. Relative times
          (“5 min ago”) don’t change, nor does any time Yuzuno stores; Defer’s “Tomorrow 9:00” is this device’s 9:00.
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
