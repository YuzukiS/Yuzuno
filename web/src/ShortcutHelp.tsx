import { Fragment, useState } from "react";
import { isTauri, shortcutModifier } from "./api";
import { useDevicePreferences } from "./device-preferences";
import { strings, useLanguage } from "./i18n";
import { SaveStatus } from "./SaveStatus";
import {
  keyTakenBy,
  rebindable,
  restoreDefaultShortcutKeys,
  retryShortcutKeysWrite,
  saveShortcutKey,
  shortcutKeysStored,
  shortcutLetters,
  useShortcutKeys,
  useShortcutKeysWrite,
  type Rebindable,
} from "./shortcut-keys";
import { shortcutGroups } from "./shortcuts";
import { touchKeyboard } from "./touch-input";
import "./device-preferences.css";

const text = strings({
  title: "Keyboard shortcuts",
  intro: "The shortcuts this version has, as they work on this device. Three of them can take another letter here.",
  or: " or ",
  change: "Keys you can change",
  changeNote: (mod: string) =>
    `${mod} with one letter. The letters text editing and the browser use with ${mod} (A, C, V, X, Y, Z, W, T, Q, R, L) aren’t offered. Return, Esc, Tab, the arrows, Home, End and the message box’s keys keep theirs.`,
  names: { find: "Find an Agent", newAgent: "New Agent", search: "Search this conversation" },
  keyFor: (name: string) => `Key for ${name}`,
  taken: (mod: string, key: string, other: string) =>
    `${mod}+${key} is already ${other}. Nothing was changed: choose another letter, or give ${other} another one first.`,
}, {
  title: "键盘快捷键",
  intro: "此版本已有的快捷键，按它们在此设备上的实际效果列出。其中三个可以在这里换一个字母。",
  or: " 或 ",
  change: "可以更改的按键",
  changeNote: (mod) =>
    `${mod} 加一个字母。文本编辑和浏览器与 ${mod} 一起使用的字母（A、C、V、X、Y、Z、W、T、Q、R、L）不提供。Return、Esc、Tab、方向键、Home、End 和消息框的按键保持不变。`,
  names: { find: "查找 Agent", newAgent: "新建 Agent", search: "搜索此会话" },
  keyFor: (name) => `${name}的按键`,
  taken: (mod, key, other) => `${mod}+${key} 已用于“${other}”。没有做任何更改：请换一个字母，或先给“${other}”换一个。`,
});

/** The keyboard shortcuts Yuzuno has (shortcuts.ts), as they work on this
 * device: Return as its sending preference says, ⌘ or Ctrl as it has, and
 * the letters this device chose for the three it may change
 * (shortcut-keys.ts). A letter another of them uses is refused, never
 * swapped; whether a choice was saved is said as the send key's is. */
export function ShortcutHelpSection() {
  const { sendKey } = useDevicePreferences();
  const keys = useShortcutKeys();
  const write = useShortcutKeysWrite();
  const language = useLanguage();
  const t = text(language);
  const [refused, setRefused] = useState<{ key: string; other: Rebindable } | null>(null);
  const groups = shortcutGroups({ modifier: shortcutModifier, sendKey, touch: touchKeyboard(), desktopApp: isTauri, keys, language });
  function choose(action: Rebindable, key: string) {
    const other = keyTakenBy(keys, action, key);
    setRefused(other ? { key, other } : null);
    if (!other) saveShortcutKey(action, key);
  }
  return (
    <section className="settings-section shortcut-help" aria-labelledby="settings-shortcuts-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-shortcuts-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
      </header>
      <div className="settings-group shortcut-keys">
        <h4>{t.change}</h4>
        <p className="shortcut-note">{t.changeNote(shortcutModifier)}</p>
        {rebindable.map((action) => (
          <label key={action} className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.names[action]}</span>
            </span>
            <span className="shortcut-key-choice">
              <kbd>{shortcutModifier}</kbd>
              <span aria-hidden="true">+</span>
              <select
                className="settings-select"
                aria-label={t.keyFor(t.names[action])}
                value={keys[action]}
                onChange={(event) => choose(action, event.target.value)}
              >
                {shortcutLetters.map((letter) => <option key={letter} value={letter}>{letter}</option>)}
              </select>
            </span>
          </label>
        ))}
        {refused && <p className="shortcut-refused" role="alert">{t.taken(shortcutModifier, refused.key, t.names[refused.other])}</p>}
      </div>
      <SaveStatus
        outcome={write?.outcome ?? null}
        action={write?.action}
        attempt={write?.attempt}
        stored={shortcutKeysStored()}
        scope="this device"
        onRetry={retryShortcutKeysWrite}
        onRestoreDefaults={() => {
          setRefused(null);
          restoreDefaultShortcutKeys();
        }}
      />
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
