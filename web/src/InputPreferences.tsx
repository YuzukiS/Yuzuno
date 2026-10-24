import { shortcutModifier } from "./api";
import {
  preferencesStored,
  restoreDefaultPreferences,
  retryPreferencesWrite,
  returnSends,
  savePreferences,
  useDevicePreferences,
  useDevicePreferencesSave,
  type SendKey,
} from "./device-preferences";
import { SaveStatus } from "./SaveStatus";
import { touchKeyboard } from "./touch-input";
import "./device-preferences.css";

const choices: { value: SendKey; label: string; note: (touch: boolean) => string }[] = [
  {
    value: "auto",
    label: "Automatic",
    note: (touch) =>
      touch
        ? "On this touch screen Return makes a new line and Send sends. With a keyboard, Return sends."
        : "Return sends and Shift+Return makes a new line. On a phone's own keyboard, Return makes a new line.",
  },
  { value: "enter", label: "Return sends", note: () => "Shift+Return makes a new line, on every keyboard of this device." },
  { value: "modEnter", label: `${shortcutModifier}+Return sends`, note: () => "Return makes a new line." },
];

/** How a message is sent from the conversation's composer, on this device
 * (T-189). The choice applies at once; whether it was saved here is said as
 * Appearance says it (SaveStatus), never "Saved" when the browser refused,
 * and before a save in this visit, what this device holds. */
export function InputPreferencesSection() {
  const preferences = useDevicePreferences();
  const save = useDevicePreferencesSave();
  const touch = touchKeyboard();
  const choose = (sendKey: SendKey) => savePreferences({ ...preferences, sendKey });
  return (
    <section className="settings-section input-preferences" aria-labelledby="settings-input-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-input-title">Sending messages</h3>
          <p>Which key sends from a conversation. It is kept on this device only.</p>
        </div>
        <span className="settings-current" title="In effect now">
          Return {returnSends(preferences.sendKey, touch) ? "sends" : "makes a new line"}
        </span>
      </header>
      <div className="settings-group">
        <fieldset className="input-send-key">
          <legend>Send with</legend>
          {choices.map(({ value, label, note }) => (
            <label key={value} className="input-send-choice">
              <input
                type="radio"
                name="input-send-key"
                value={value}
                checked={preferences.sendKey === value}
                onChange={() => choose(value)}
              />
              <span>
                <strong>{label}</strong>
                <small>{note(touch)}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="input-preferences-fixed">
          {shortcutModifier}+Return always sends and Shift+Return always makes a new line. While an input method is
          composing, Return is the input method's.
        </p>
      </div>
      <SaveStatus
        outcome={save?.outcome ?? null}
        action={save?.action}
        stored={preferencesStored()}
        scope="this device"
        onRetry={retryPreferencesWrite}
        onRestoreDefaults={restoreDefaultPreferences}
      />
    </section>
  );
}
