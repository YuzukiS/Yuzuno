import { useState } from "react";
import { shortcutModifier } from "./api";
import { readPreferences, returnSends, savePreferences, type SaveResult, type SendKey } from "./device-preferences";
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
 * (T-189). The choice applies at once; the editor says whether it was kept
 * here, and never "Saved" when the browser refused it. */
export function InputPreferencesSection() {
  const [preferences, setPreferences] = useState(readPreferences);
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const touch = touchKeyboard();
  function choose(sendKey: SendKey) {
    const next = { ...preferences, sendKey };
    setPreferences(next);
    setSaved(savePreferences(next));
  }
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
        {saved && (
          <p className={saved.ok ? "settings-saved" : "settings-save-failed"} role={saved.ok ? "status" : "alert"}>
            {saved.ok
              ? "Saved on this device."
              : `Not saved: ${saved.reason}. It applies until this page closes.`}
          </p>
        )}
      </div>
    </section>
  );
}
