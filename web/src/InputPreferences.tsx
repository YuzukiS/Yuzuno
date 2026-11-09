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
import { ChoiceCards } from "./SettingsChoices";
import { touchKeyboard } from "./touch-input";
import { PortalPreferencesSection } from "./portal/PortalPreferences";
import { useOpenWith } from "./portal/portal-preference";
import "./device-preferences.css";
import { Tip, TipText } from "./Tip";

// Key names (Return, Shift, Ctrl, ⌘) are written as on the keys.
const text = strings({
  // Settings › Typing & time (YN-8): this page's heading; its blocks follow.
  page: "Typing & time",
  pageIntro: "Which key sends, how web pages and prototypes open, and how times are written. Kept on this device only.",
  opens: (inside: boolean): string => (inside ? "Opens inside Yuzuno" : "Opens in the browser"),
  title: "Sending messages",
  intro: "Which key sends from a conversation. It is kept on this device only.",
  current: "In effect now",
  returnDoes: (sends: boolean) => `Return: ${sends ? "Send" : "New line"}`,
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
  page: "输入与时间",
  pageIntro: "在会话中用哪个键发送、网页和原型怎么打开、时间怎么写。只保存在此设备上。",
  opens: (inside) => (inside ? "在 Yuzuno 内打开" : "在浏览器打开"),
  title: "发送消息",
  intro: "在会话中用哪个键发送。只保存在此设备上。",
  current: "当前生效",
  returnDoes: (sends) => `Return：${sends ? "发送" : "换行"}`,
  auto: "自动",
  autoTouch: "在此触摸屏上，Return 换行，“发送”按钮发送。使用实体键盘时，Return 发送。",
  autoKeyboard: "Return 发送，Shift+Return 换行。在手机自带的键盘上，Return 换行。",
  enter: "Return 发送",
  enterNote: "在此设备的所有键盘上，Shift+Return 换行。",
  modEnter: (modifier) => `${modifier}+Return 发送`,
  modEnterNote: "Return 换行。",
  fixed: (modifier) => `${modifier}+Return 始终发送，Shift+Return 始终换行。输入法正在组字时，Return 归输入法使用。`,
});

/** Settings › Typing & time (YN-8), its first card: how a message is sent
 * from the conversation's composer (T-189), then where web pages and
 * prototypes open (T-5); the clock and time zone follow in their own card.
 * A choice applies at once; whether it was saved here is said as Appearance
 * says it (SaveStatus), never "Saved" when the browser refused, and before
 * a save in this visit, what this device holds. */
export function InputPreferencesSection() {
  const t = useStrings(text);
  const preferences = useDevicePreferences();
  const save = useDevicePreferencesSave();
  const open = useOpenWith();
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
          <h3 id="settings-input-title">{t.page}</h3>
          <p>{t.pageIntro}</p>
        </div>
        {/* As the shortcuts help names it; short enough for a phone at the largest text. */}
        <Tip content={<TipText title={t.current} />}>
          <span className="settings-current">
            {t.returnDoes(returnSends(preferences.sendKey, touch))} · {t.opens(open === "inside")}
          </span>
        </Tip>
      </header>
      <div className="settings-group appearance-group">
        <fieldset className="appearance-field input-send-key">
          <legend>{t.title}</legend>
          <ChoiceCards name="input-send-key" value={preferences.sendKey} choices={choices} onChange={choose} className="input-send-choice" />
          <p className="appearance-help input-preferences-fixed">{t.fixed(shortcutModifier)}</p>
          <SaveStatus
            outcome={save?.outcome ?? null}
            action={save?.action}
            attempt={save?.attempt}
            stored={preferencesStored()}
            scope="this device"
            onRetry={retryPreferencesWrite}
            onRestoreDefaults={restoreDefaultPreferences}
          />
        </fieldset>
        <PortalPreferencesSection />
      </div>
    </section>
  );
}
