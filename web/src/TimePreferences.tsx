import { strings, useStrings } from "./i18n";
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

// Time zone names are identifiers (IANA's), shown as they are written.
const text = strings({
  title: "Clock & time zone",
  intro: "How times are written. It is kept on this device only.",
  current: "In effect now",
  clockLegend: "Write times with",
  system: "System",
  systemNote: "As this browser writes times for its language and region.",
  h12: "12-hour",
  h12Note: "Morning and evening hours, as this language writes a 12-hour clock.",
  h24: "24-hour",
  h24Note: "Hours from 0 to 23.",
  zoneLegend: "Show times in",
  zoneLabel: "Time zone",
  ownZone: (zone: string) => `This device’s time zone · ${zone}`,
  where: "Used for message times and Turn endings in conversations, and for times on Home, with their dates in that time zone. Other places, such as Jobs, CI and Settings, still write times as this browser does. Relative times (“5 min ago”) don’t change, nor does any time Yuzuno stores; Defer’s “Tomorrow 9:00” is this device’s 9:00.",
}, {
  title: "时钟与时区",
  intro: "时间的显示方式。只保存在此设备上。",
  current: "当前生效",
  clockLegend: "时间显示为",
  system: "系统",
  systemNote: "按此浏览器的语言和地区显示时间。",
  h12: "12 小时制",
  h12Note: "分上午和下午，按此语言的 12 小时制书写。",
  h24: "24 小时制",
  h24Note: "小时为 0 到 23。",
  zoneLegend: "时间所在时区",
  zoneLabel: "时区",
  ownZone: (zone) => `此设备的时区 · ${zone}`,
  where: "用于会话中的消息时间和 Turn 结束时间，以及 Home 上的时间，其日期也按该时区显示。Jobs、CI 和设置等其他地方仍按此浏览器的方式显示时间。相对时间（“5 分钟前”）不变，Yuzuno 保存的任何时间也不变；Home 上 Defer 的 “Tomorrow”（9:00）指此设备的 9:00。",
});

/** How times are written on this device (T-189): a 12- or 24-hour clock, or
 * the browser's own, in this device's time zone or another. A choice applies
 * at once to every time shown where it is used; whether it was saved here is
 * said as Appearance says it (SaveStatus), never "Saved" when the browser
 * refused. */
export function TimePreferencesSection() {
  const t = useStrings(text);
  const choices: { value: ClockFormat; label: string; note: string }[] = [
    { value: "system", label: t.system, note: t.systemNote },
    { value: "h12", label: t.h12, note: t.h12Note },
    { value: "h24", label: t.h24, note: t.h24Note },
  ];
  const preferences = useTimePreferences();
  const { clock, timeZone } = preferences;
  const save = useTimePreferencesSave();
  const own = systemTimeZone();
  const zones = timeZones();
  return (
    <section className="settings-section input-preferences time-preferences" aria-labelledby="settings-time-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-time-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
        <span className="settings-current" title={t.current}>
          {sample(clock)}
          {timeZone && ` · ${zoneName(timeZone)}`}
        </span>
      </header>
      <div className="settings-group">
        <fieldset className="input-send-key">
          <legend>{t.clockLegend}</legend>
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
          <legend>{t.zoneLegend}</legend>
          <select
            className="settings-select"
            aria-label={t.zoneLabel}
            value={timeZone ?? ""}
            onChange={(event) => saveTimePreferences({ ...preferences, timeZone: event.target.value || null })}
          >
            <option value="">{t.ownZone(zoneName(own))}</option>
            {/* A saved zone this browser can show but doesn't list stays choosable. */}
            {timeZone && !zones.includes(timeZone) && <option value={timeZone}>{zoneName(timeZone)}</option>}
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zoneName(zone)}
              </option>
            ))}
          </select>
        </fieldset>
        <p className="input-preferences-fixed">{t.where}</p>
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
