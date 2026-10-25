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
import { strings, useStrings } from "./i18n";
import { SaveStatus } from "./SaveStatus";
import { touchKeyboard } from "./touch-input";
import "./device-preferences.css";

// Key names (Return, Shift, Ctrl, ⌘) are written as on the keys.
const text = strings({
  title: "Sending messages",
  intro: "Which key sends from a conversation. It is kept on this device only.",
  current: "In effect now",
  returnDoes: (sends: boolean) => `Return: ${sends ? "Send" : "New line"}`,
  legend: "Send with",
  auto: "Automatic",
  autoTouch: "On this touch screen Return makes a new line and Send sends. With a keyboard, Return sends.",
  autoKeyboard: "Return sends and Shift+Return makes a new line. On a phone's own keyboard, Return makes a new line.",
  enter: "Return sends",
  enterNote: "Shift+Return makes a new line, on every keyboard of this device.",
  modEnter: (modifier: string) => `${modifier}+Return sends`,
  modEnterNote: "Return makes a new line.",
  fixed: (modifier: string) =>
    `${modifier}+Return always sends and Shift+Return always makes a new line. While an input method is composing, Return is the input method's.`,
}, {
  title: "发送消息",
  intro: "在会话中用哪个键发送。只保存在此设备上。",
  current: "当前生效",
  returnDoes: (sends) => `Return：${sends ? "发送" : "换行"}`,
  legend: "发送方式",
  auto: "自动",
  autoTouch: "在此触摸屏上，Return 换行，“发送”按钮发送。使用实体键盘时，Return 发送。",
  autoKeyboard: "Return 发送，Shift+Return 换行。在手机自带的键盘上，Return 换行。",
  enter: "Return 发送",
  enterNote: "在此设备的所有键盘上，Shift+Return 换行。",
  modEnter: (modifier) => `${modifier}+Return 发送`,
  modEnterNote: "Return 换行。",
  fixed: (modifier) => `${modifier}+Return 始终发送，Shift+Return 始终换行。输入法正在组字时，Return 归输入法使用。`,
});

/** How a message is sent from the conversation's composer, on this device
 * (T-189). The choice applies at once; whether it was saved here is said as
 * Appearance says it (SaveStatus), never "Saved" when the browser refused,
 * and before a save in this visit, what this device holds. */
export function InputPreferencesSection() {
  const t = useStrings(text);
  const preferences = useDevicePreferences();
  const save = useDevicePreferencesSave();
  const touch = touchKeyboard();
  const choose = (sendKey: SendKey) => savePreferences({ ...preferences, sendKey });
  const choices: { value: SendKey; label: string; note: string }[] = [
    { value: "auto", label: t.auto, note: touch ? t.autoTouch : t.autoKeyboard },
    { value: "enter", label: t.enter, note: t.enterNote },
    { value: "modEnter", label: t.modEnter(shortcutModifier), note: t.modEnterNote },
  ];
  return (
    <section className="settings-section input-preferences" aria-labelledby="settings-input-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-input-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
        {/* As the shortcuts help names it; short enough for a phone at the largest text. */}
        <span className="settings-current" title={t.current}>
          {t.returnDoes(returnSends(preferences.sendKey, touch))}
        </span>
      </header>
      <div className="settings-group">
        <fieldset className="input-send-key">
          <legend>{t.legend}</legend>
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
                <small>{note}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="input-preferences-fixed">{t.fixed(shortcutModifier)}</p>
      </div>
      <SaveStatus
        outcome={save?.outcome ?? null}
        action={save?.action}
        attempt={save?.attempt}
        stored={preferencesStored()}
        scope="this device"
        onRetry={retryPreferencesWrite}
        onRestoreDefaults={restoreDefaultPreferences}
      />
    </section>
  );
}
