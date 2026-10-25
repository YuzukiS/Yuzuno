import { Fragment } from "react";
import { isTauri, shortcutModifier } from "./api";
import { useDevicePreferences } from "./device-preferences";
import { strings, useLanguage } from "./i18n";
import { shortcutGroups } from "./shortcuts";
import { touchKeyboard } from "./touch-input";
import "./device-preferences.css";

const text = strings(
  { title: "Keyboard shortcuts", intro: "The shortcuts this version has, as they work on this device. They cannot be changed yet.", or: " or " },
  { title: "键盘快捷键", intro: "此版本已有的快捷键，按它们在此设备上的实际效果列出。暂时还不能更改。", or: " 或 " },
);

/** The keyboard shortcuts Yuzuno has (shortcuts.ts), as they work on this
 * device: Return as its sending preference says, ⌘ or Ctrl as it has. */
export function ShortcutHelpSection() {
  const { sendKey } = useDevicePreferences();
  const language = useLanguage();
  const t = text(language);
  const groups = shortcutGroups({ modifier: shortcutModifier, sendKey, touch: touchKeyboard(), desktopApp: isTauri, language });
  return (
    <section className="settings-section shortcut-help" aria-labelledby="settings-shortcuts-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-shortcuts-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
      </header>
      {groups.map((group) => (
        <div key={group.title} className="settings-group shortcut-group">
          <h4>{group.title}</h4>
          {group.note && <p className="shortcut-note">{group.note}</p>}
          <dl>
            {group.shortcuts.map((shortcut) => (
              <Fragment key={`${shortcut.keys.join("+")} ${shortcut.action}`}>
                <dt>
                  {shortcut.keys.map((key, index) => (
                    <Fragment key={index}>
                      {index > 0 && (shortcut.either ? <span className="shortcut-or">{t.or}</span> : <span aria-hidden="true">+</span>)}
                      <kbd>{key}</kbd>
                    </Fragment>
                  ))}
                </dt>
                <dd>{shortcut.action}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      ))}
    </section>
  );
}
