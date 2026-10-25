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
    `This version translates Settings’ directory, its search and save messages, and these pages: ${pages}. The Projects window follows it too: its list, a new project, a project’s page with its New Agent defaults, Code review, repositories and services, and Without a project. Outside Settings, the toolbar, the Agent list, Agent states, the status bar, an Agent’s actions with their confirmations, Reconnect all, the Jobs panel, the Machines page, the Core connection banners and a conversation’s own controls (its search, its jobs and CI, and the message box with its pasted text and images) follow it as well, and so do an Agent’s settings, its Manage dialog, the context panel and the notices that offer a reconnect or a continue. On Home, its header, Needs you, each project’s frame, the cards’ controls, states and replies, the widgets and pinned cards, repository activity, content editors and the controls of a Brief’s blocks follow it too. The rest of Yuzuno stays in English, as does anything a page has no translation for. System notifications, the test one included, stay in English too. Release notes, license texts, what Agents receive for Home, a model’s own description, what Core reports about phone access, backups and stored history, a draft’s export text and files, what Core and the desktop app say about updates, the reasons a machine check gives, what Core says about a project’s services, a Brief’s text, its custom labels and table columns and values, an Ask’s question, options and prompt, a plan usage window’s name and details, and versions, paths and errors under Runtime & versions are shown as written. What you and Agents write, code, logs and names are never translated. Times keep their own clock format and time zone.`,
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
    `此版本已翻译设置目录、搜索与保存提示，以及这些页面：${pages}。“项目”窗口也会随之显示：项目列表、新建项目、项目页面及其中的“新 Agent 默认值”、“代码审查”、仓库与服务，以及“无项目”。设置之外，工具栏、Agent 列表、Agent 状态、状态栏、Agent 操作及其确认、批量重新连接、Job 面板、“机器”页面、Core 连接提示，以及会话自身的控件（会话搜索、会话中的 Job 与 CI、消息输入框及其中的粘贴文本与图片）也会随之显示，Agent 的设置、“管理”对话框、上下文面板以及提供重新连接或继续的提示也是如此。Home 的标题、“需要你处理”、各项目的框架、卡片的控件、状态和回复、小组件和固定卡片、仓库动态、内容编辑者以及 Brief 区块的控件也会随之显示。Yuzuno 的其余部分仍为英文，页面中没有译文的文字也显示为英文。系统通知（包括测试通知）也仍为英文；发布说明、许可证文本、Agent 收到的 Home 偏好、模型自带的说明、Core 报告的手机访问、备份与已存储历史详情、草稿导出的文本与文件、Core 与桌面应用关于更新的说明、机器检查给出的原因、Core 关于项目服务的说明、Brief 的正文、自定义标签和表格的列与值、Ask 的问题、选项和提示、套餐用量窗口的名称与详情，以及“运行环境与版本”中的版本、路径和错误按原文显示。你和 Agent 写下的内容、代码、日志与名称从不翻译。时间仍按各自的时钟格式与时区显示。`,
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
