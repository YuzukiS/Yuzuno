import { SaveStatus } from "./SaveStatus";
import {
  languageStored,
  restoreDefaultLanguage,
  retryLanguageWrite,
  saveLanguagePreferences,
  strings,
  systemLanguage,
  useLanguage,
  useLanguagePreferences,
  useLanguageSave,
  type Language,
  type LanguageChoice,
} from "./i18n";
import { localizedEntry, settingsCatalog, translatedEditors } from "./settings-catalog";
import "./device-preferences.css";

// Each language is named in its own words, whatever the interface's.
const names: Record<Language, string> = { en: "English", "zh-Hans": "简体中文" };

const text = strings({
  title: "Language",
  intro: "The language of Yuzuno’s interface. It is kept on this device only.",
  current: "In effect now",
  legend: "Show the interface in",
  system: "System",
  systemNote: (name: string) => `This browser’s language: ${name}.`,
  systemFallback: (asked: string) => `This browser asks for ${asked}, which this version doesn’t have, so English is shown.`,
  chosen: "Whatever this browser’s language is.",
  coverage: (pages: string) =>
    `This version translates Settings’ directory, its search and save messages, and these pages: ${pages}. Other Settings pages and the rest of Yuzuno stay in English, as does anything a page has no translation for, such as the Shared Appearance preset under Appearance. System notifications, the test one included, stay in English too, and release notes, license texts, what Agents receive for Home and a model’s own description are shown as written. What you and Agents write, code, logs and names are never translated. Times keep their own clock format and time zone.`,
  list: (items: string[]) => items.map((item) => `“${item}”`).join(", "),
}, {
  title: "界面语言",
  intro: "Yuzuno 界面使用的语言。只保存在此设备上。",
  current: "当前生效",
  legend: "界面显示为",
  system: "系统",
  systemNote: (name) => `此浏览器的语言：${name}。`,
  systemFallback: (asked) => `此浏览器要求使用 ${asked}，此版本没有该语言，因此显示英文。`,
  chosen: "无论此浏览器使用什么语言。",
  coverage: (pages) =>
    `此版本已翻译设置目录、搜索与保存提示，以及这些页面：${pages}。其他设置页面和 Yuzuno 的其余部分仍为英文，页面中没有译文的文字也显示为英文，例如“外观”下的“共享外观预设”。系统通知（包括测试通知）也仍为英文；发布说明、许可证文本、Agent 收到的 Home 偏好和模型自带的说明按原文显示。你和 Agent 写下的内容、代码、日志与名称从不翻译。时间仍按各自的时钟格式与时区显示。`,
  list: (items) => items.map((item) => `“${item}”`).join("、"),
});

/** A language tag as people read it, in `language`; the tag when the
 * browser can't name it. */
function languageName(tag: string, language: Language) {
  try {
    return new Intl.DisplayNames([language], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The interface language of this device (T-189). A choice applies at once
 * to the parts this version translates; whether it was saved here is said as
 * Appearance says it (SaveStatus), never "Saved" when the browser refused. */
export function LanguagePreferencesSection() {
  const { language: choice } = useLanguagePreferences();
  const language = useLanguage();
  const t = text(language);
  const save = useLanguageSave();
  const system = systemLanguage();
  const pages = t.list(
    translatedEditors.flatMap((editor) => {
      const entry = settingsCatalog.find((item) => item.target.kind === "editor" && item.target.editor === editor);
      return entry ? [localizedEntry(entry, language).title] : [];
    }),
  );
  const choices: { value: LanguageChoice; label: string; lang?: string; note: string }[] = [
    {
      value: "system",
      label: `${t.system} · ${names[system.language]}`,
      note: system.unavailable ? t.systemFallback(languageName(system.unavailable, language)) : t.systemNote(names[system.language]),
    },
    { value: "en", label: names.en, lang: "en", note: t.chosen },
    { value: "zh-Hans", label: names["zh-Hans"], lang: "zh-Hans", note: t.chosen },
  ];
  return (
    <section className="settings-section input-preferences language-preferences" aria-labelledby="settings-language-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-language-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
        <span className="settings-current" title={t.current}>
          {names[language]}
        </span>
      </header>
      <div className="settings-group">
        <fieldset className="input-send-key">
          <legend>{t.legend}</legend>
          {choices.map(({ value, label, lang, note }) => (
            <label key={value} className="input-send-choice">
              <input
                type="radio"
                name="interface-language"
                value={value}
                checked={choice === value}
                onChange={() => saveLanguagePreferences({ language: value })}
              />
              <span>
                <strong lang={lang}>{label}</strong>
                <small>{note}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="input-preferences-fixed">{t.coverage(pages)}</p>
      </div>
      <SaveStatus
        outcome={save?.outcome ?? null}
        action={save?.action}
        attempt={save?.attempt}
        stored={languageStored()}
        scope="this device"
        onRetry={retryLanguageWrite}
        onRestoreDefaults={restoreDefaultLanguage}
      />
    </section>
  );
}
