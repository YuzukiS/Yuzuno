import { strings, useStrings } from "../i18n";
import { SaveStatus } from "../SaveStatus";
import {
  openWithStored,
  saveOpenWith,
  useOpenWith,
  useOpenWithSave,
  type OpenWith,
} from "./portal-preference";
import "../device-preferences.css";

const text = strings({
  title: "Opening web pages and prototypes",
  intro: "Where project services and HTML prototypes open by default. Kept on this device only; every time you open one, the other way is there too.",
  legend: "Open",
  inside: "Inside Yuzuno",
  insideNote: "Beside the conversation on a wide window, which you can drag wider or narrower; full screen on a phone. The conversation stays where it was.",
  browser: "In the browser",
  browserNote: "A new tab on the web; the system browser in the desktop app.",
}, {
  title: "网页与原型的打开方式",
  intro: "服务、HTML 原型默认在哪里打开。只保存在此设备；每次打开时都能临时换另一种。",
  legend: "打开方式",
  inside: "在 Yuzuno 内打开",
  insideNote: "宽窗口在会话旁边显示，可拖动调整宽度；手机全屏。会话的位置保持不动。",
  browser: "在浏览器打开",
  browserNote: "网页端开新标签页；桌面应用交给系统浏览器。",
});

/** Where services and prototypes open by default on this device (T-5). */
export function PortalPreferencesSection() {
  const t = useStrings(text);
  const open = useOpenWith();
  const save = useOpenWithSave();
  const choices: { value: OpenWith; label: string; note: string }[] = [
    { value: "inside", label: t.inside, note: t.insideNote },
    { value: "browser", label: t.browser, note: t.browserNote },
  ];
  return (
    <section className="settings-section input-preferences" aria-labelledby="settings-portal-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-portal-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
      </header>
      <div className="settings-group">
        <fieldset className="input-send-key">
          <legend>{t.legend}</legend>
          {choices.map(({ value, label, note }) => (
            <label key={value} className="input-send-choice">
              <input type="radio" name="portal-open-with" value={value} checked={open === value} onChange={() => saveOpenWith(value)} />
              <span>
                <strong>{label}</strong>
                <small>{note}</small>
              </span>
            </label>
          ))}
        </fieldset>
      </div>
      <SaveStatus
        outcome={save?.outcome ?? null}
        attempt={save?.attempt}
        stored={openWithStored()}
        scope="this device"
        onRetry={() => saveOpenWith(open)}
      />
    </section>
  );
}
