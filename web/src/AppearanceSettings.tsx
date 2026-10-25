import { useEffect, useRef, useState } from "react";
import { Check, Monitor, Moon, Rows2, Rows4, Sun, Type } from "lucide-react";
import {
  appearanceStored,
  importAppearance,
  restoreDefaultAppearance,
  retryAppearanceWrite,
  saveAppearance,
  useAppearance,
  useAppearanceSave,
  type AgentListDensity,
  type Appearance,
  type DockLimits,
  type ProjectGroupStyle,
  MAX_DOCK_LIMIT,
  MAX_FONT_SIZE,
  MAX_TURN_BARS,
  MAX_TURN_NUMBERS,
  MIN_FONT_SIZE,
  type ThemePreference,
  palettes,
  type Palette,
} from "./appearance";
import {
  appearanceFields,
  exportAppearance,
  fieldValue,
  importedAppearance,
  MAX_APPEARANCE_FILE_BYTES,
  readAppearanceFile,
  type AppearanceField,
  type AppearanceFileContents,
  type FileRefusal,
} from "./appearance-file";
import { strings, useLanguage, type Language } from "./i18n";
import { SaveStatus, saveRefusalReason } from "./SaveStatus";
import type { SaveOutcome } from "./device-storage";

// Appearance's words (T-189), in the interface language. Values and the file
// keep their ids ("garden", "dark"); only how they are named changes.
const text = strings({
  title: "Appearance",
  intro: "Make yourself comfortable. Changes apply as you choose and stay on this device.",
  current: "In effect now",
  compactList: " · Compact list",
  palette: "Palette",
  palettes: { garden: "Garden", yuzu: "Yuzu", graphite: "Graphite", pine: "Pine", sunroom: "Sunroom" } as Record<Palette, string>,
  theme: "Theme",
  themes: { light: ["Light", "Daylight"], dark: ["Dark", "Low light"], system: ["System", "Follow your device"] } as Record<ThemePreference, [string, string]>,
  textSize: "Text size",
  textSizeHelp: "Conversation text, controls and file previews grow together. Below 14 px only conversation text gets smaller, so controls stay legible.",
  agentList: "Agent list",
  agentListHelp: "Each Agent's report or update stays in its conversation either way, and anything that needs you still shows.",
  agentLists: {
    detailed: ["Detailed", "The latest report or update under each name"],
    compact: ["Compact", "Name and status only"],
  } as Record<AgentListDensity, [string, string]>,
  projectGroups: "Project groups",
  projectGroupsHelp: "How the Agent list sets projects apart when it shows All projects. Each group folds, and its + starts a new agent in it.",
  groups: {
    headers: ["Headers", "Small titles and a thin line"],
    cards: ["Cards", "A light card for each project"],
    bands: ["Colour bands", "A thin project colour beside each"],
    none: ["No grouping", "One list, as before"],
  } as Record<ProjectGroupStyle, [string, string]>,
  dock: "Conversation dock",
  dockHelp: "The most of each the left edge of a conversation shows, what is running or queued first. 0 hides that group there; the Jobs panel still lists everything.",
  docks: { jobs: "Local jobs", actions: "GitHub Actions", subAgents: "Sub-agents" } as Record<keyof DockLimits, string>,
  turnDock: "Turn dock",
  turnDockHelp: "The right edge of a conversation: how many turns around the one you are reading show their number, and how many short bars lead on to further turns on each side. 0 numbered turns hides the dock; scrolling and Back to latest still work.",
  numbered: "Numbered turns",
  bars: "Bars on each side",
  hidden: "Hidden",
  none: "None",
  preview: "A little preview",
}, {
  title: "外观",
  intro: "让自己用得舒服。更改在你选择时生效，并保存在此设备上。",
  current: "当前生效",
  compactList: " · 紧凑列表",
  palette: "配色",
  palettes: { garden: "花园", yuzu: "柚子", graphite: "石墨", pine: "松林", sunroom: "阳光房" },
  theme: "主题",
  themes: { light: ["浅色", "日间"], dark: ["深色", "弱光环境"], system: ["系统", "跟随你的设备"] },
  textSize: "文字大小",
  textSizeHelp: "会话文字、控件和文件预览一起变大。小于 14 px 时只有会话文字变小，控件保持清晰可读。",
  agentList: "Agent 列表",
  agentListHelp: "无论选哪种，每个 Agent 的报告或更新都留在它的会话中，需要你处理的事情也照样显示。",
  agentLists: { detailed: ["详细", "每个名称下显示最新的报告或更新"], compact: ["紧凑", "只显示名称和状态"] },
  projectGroups: "项目分组",
  projectGroupsHelp: "Agent 列表显示 All projects 时如何区分各个项目。每组都可以折叠，组上的 + 会在其中新建 Agent。",
  groups: {
    headers: ["标题", "小标题加一条细线"],
    cards: ["卡片", "每个项目一张浅色卡片"],
    bands: ["色带", "每项旁边一条细细的项目颜色"],
    none: ["不分组", "一个列表，与以前一样"],
  },
  dock: "会话侧栏",
  dockHelp: "会话左侧每类最多显示几项，正在运行或排队的排在前面。0 会在那里隐藏这一组；Jobs 面板仍会列出全部。",
  docks: { jobs: "本地 Job", actions: "GitHub Actions", subAgents: "子 Agent" },
  turnDock: "Turn 栏",
  turnDockHelp: "会话右侧：你正在阅读的 Turn 周围有几个显示编号，以及两侧各有几条通往更多 Turn 的短条。编号 Turn 为 0 时隐藏此栏；滚动和 Back to latest 仍然可用。",
  numbered: "编号 Turn",
  bars: "每侧短条",
  hidden: "隐藏",
  none: "无",
  preview: "小小预览",
});
const themeIcons: Record<ThemePreference, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const themeOrder: ThemePreference[] = ["light", "dark", "system"];
const projectGroupOrder: ProjectGroupStyle[] = ["headers", "cards", "bands", "none"];
const agentLists: { value: AgentListDensity; icon: typeof Sun; rows: number }[] = [
  { value: "detailed", icon: Rows2, rows: 2 },
  { value: "compact", icon: Rows4, rows: 3 },
];
const dockOrder: (keyof DockLimits)[] = ["jobs", "actions", "subAgents"];
/** One count on a slider, its name before it and its value, or what 0
 * means, after. */
function CountSlider({
  name,
  label,
  value,
  max,
  zero,
  onChange,
}: {
  name: string;
  label: string;
  value: number;
  max: number;
  /** What 0 means here, such as "Hidden". */
  zero: string;
  onChange: (value: number) => void;
}) {
  const shown = value === 0 ? zero : String(value);
  return (
    <label className="dock-limit">
      <span>{label}</span>
      <input
        type="range"
        name={name}
        min={0}
        max={max}
        step={1}
        value={value}
        aria-valuetext={shown}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output aria-hidden="true">{shown}</output>
    </label>
  );
}

/** Appearance, one category of Settings: how Yuzuno looks on this device.
 * It shows the choice in effect, which is the saved one unless this device
 * refused to save it (T-187); then it says so, keeps the choice, and offers
 * to try again or restore the defaults. Before a save in this visit it says
 * what this device holds: a saved choice, the defaults, or one it can't read. */
export function AppearanceSection() {
  const appearance = useAppearance();
  const save = useAppearanceSave();
  const t = text(useLanguage());
  function update(next: Partial<Appearance>) {
    saveAppearance({ ...appearance, ...next });
  }
  const theme = t.themes[appearance.theme][0];
  return (
    <section
      className="settings-section appearance-settings"
      aria-labelledby="settings-appearance-title"
    >
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-appearance-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
        <span className="settings-current" title={t.current}>
          {t.palettes[appearance.palette]} · {theme} · {appearance.fontSize} px
          {appearance.agentList === "compact" && t.compactList}
        </span>
      </header>
      <div className="settings-group appearance-group">
        <fieldset className="appearance-field">
          <legend>{t.palette}</legend>
          <div className="palette-options">
            {palettes.map((palette) => (
              <label
                key={palette}
                className="palette-choice"
                data-swatch={palette}
              >
                <input
                  type="radio"
                  name="appearance-palette"
                  value={palette}
                  checked={appearance.palette === palette}
                  onChange={() => update({ palette })}
                />
                <span className="palette-swatch" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>{t.palettes[palette]}</span>
                <Check
                  size={13}
                  className="palette-selected"
                  aria-hidden="true"
                />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="appearance-field">
          <legend>{t.theme}</legend>
          <div className="theme-options">
            {themeOrder.map((value) => {
              const [label, note] = t.themes[value];
              const Icon = themeIcons[value];
              return (
              <label
                key={value}
                className={`theme-choice theme-choice-${value}`}
              >
                <input
                  type="radio"
                  name="appearance-theme"
                  value={value}
                  checked={appearance.theme === value}
                  onChange={() => update({ theme: value })}
                />
                <span className="theme-swatch" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="theme-choice-name">
                  <Icon size={14} />
                  {label}
                  <Check size={13} className="theme-selected" />
                </span>
                <small>{note}</small>
              </label>
              );
            })}
          </div>
        </fieldset>
        <fieldset className="appearance-field">
          <legend>{t.textSize}</legend>
          <p className="appearance-help">{t.textSizeHelp}</p>
          <div className="font-size-slider">
            <span className="font-size-end" aria-hidden="true" style={{ fontSize: MIN_FONT_SIZE }}>
              Aa
            </span>
            <input
              type="range"
              name="appearance-font-size"
              min={MIN_FONT_SIZE}
              max={MAX_FONT_SIZE}
              step={1}
              value={appearance.fontSize}
              aria-label={t.textSize}
              aria-valuetext={`${appearance.fontSize} px`}
              onChange={(event) => update({ fontSize: Number(event.target.value) })}
            />
            <span className="font-size-end" aria-hidden="true" style={{ fontSize: MAX_FONT_SIZE }}>
              Aa
            </span>
            <output className="font-size-value" aria-hidden="true">
              {appearance.fontSize} px
            </output>
          </div>
        </fieldset>
        <fieldset className="appearance-field">
          <legend>{t.agentList}</legend>
          <p className="appearance-help">{t.agentListHelp}</p>
          <div className="agent-list-options">
            {agentLists.map(({ value, icon: Icon, rows }) => {
              const [label, note] = t.agentLists[value];
              return (
              <label
                key={value}
                className={`theme-choice agent-list-choice agent-list-choice-${value}`}
              >
                <input
                  type="radio"
                  name="appearance-agent-list"
                  value={value}
                  checked={appearance.agentList === value}
                  onChange={() => update({ agentList: value })}
                />
                <span className="agent-list-swatch" aria-hidden="true">
                  {Array.from({ length: rows }, (_, row) => (
                    <span key={row}>
                      <i />
                      <b />
                      <b />
                    </span>
                  ))}
                </span>
                <span className="theme-choice-name">
                  <Icon size={14} />
                  {label}
                  <Check size={13} className="theme-selected" />
                </span>
                <small>{note}</small>
              </label>
              );
            })}
          </div>
        </fieldset>
        <fieldset className="appearance-field">
          <legend>{t.projectGroups}</legend>
          <p className="appearance-help">{t.projectGroupsHelp}</p>
          <div className="project-group-options">
            {projectGroupOrder.map((value) => {
              const [label, note] = t.groups[value];
              return (
              <label
                key={value}
                className={`theme-choice project-group-choice project-group-choice-${value}`}
              >
                <input
                  type="radio"
                  name="appearance-project-groups"
                  value={value}
                  checked={appearance.projectGroups === value}
                  onChange={() => update({ projectGroups: value })}
                />
                <span className="project-group-swatch" aria-hidden="true">
                  <span className="swatch-group">
                    <span>
                      <i />
                      <b />
                    </span>
                    <span>
                      <i />
                      <b />
                    </span>
                  </span>
                  <span className="swatch-group">
                    <span>
                      <i />
                      <b />
                    </span>
                  </span>
                </span>
                <span className="theme-choice-name">
                  {label}
                  <Check size={13} className="theme-selected" />
                </span>
                <small>{note}</small>
              </label>
              );
            })}
          </div>
        </fieldset>
        <fieldset className="appearance-field">
          <legend>{t.dock}</legend>
          <p className="appearance-help">{t.dockHelp}</p>
          <div className="dock-limits">
            {dockOrder.map((key) => (
              <CountSlider
                key={key}
                name={`appearance-dock-${key}`}
                label={t.docks[key]}
                value={appearance.dock[key]}
                max={MAX_DOCK_LIMIT}
                zero={t.hidden}
                onChange={(value) =>
                  update({ dock: { ...appearance.dock, [key]: value } })
                }
              />
            ))}
          </div>
        </fieldset>
        <fieldset className="appearance-field">
          <legend>{t.turnDock}</legend>
          <p className="appearance-help">{t.turnDockHelp}</p>
          <div className="dock-limits">
            <CountSlider
              name="appearance-turn-numbers"
              label={t.numbered}
              value={appearance.turnDock.numbers}
              max={MAX_TURN_NUMBERS}
              zero={t.hidden}
              onChange={(numbers) =>
                update({ turnDock: { ...appearance.turnDock, numbers } })
              }
            />
            <CountSlider
              name="appearance-turn-bars"
              label={t.bars}
              value={appearance.turnDock.bars}
              max={MAX_TURN_BARS}
              zero={t.none}
              onChange={(bars) =>
                update({ turnDock: { ...appearance.turnDock, bars } })
              }
            />
          </div>
        </fieldset>
        <div className="appearance-preview">
          <span className="appearance-preview-label">
            <Type size={13} /> {t.preview}
          </span>
          {/* Sample text, in the languages it shows; never translated. */}
          <p>Room for your next idea.</p>
          <p lang="zh-CN">让每个想法，都有舒服的落脚处。</p>
          <code>const next = "something good";</code>
        </div>
      </div>
      <SaveStatus
        outcome={save?.outcome ?? null}
        action={save?.action}
        attempt={save?.attempt}
        stored={appearanceStored()}
        scope="this device"
        onRetry={retryAppearanceWrite}
        onRestoreDefaults={restoreDefaultAppearance}
      />
      <AppearanceFile appearance={appearance} />
    </section>
  );
}

/** A setting's name as the controls above name it, in `language`. */
export function fieldLabel(field: AppearanceField, language: Language = "en"): string {
  const t = text(language);
  const parts: Record<AppearanceField, string> = {
    palette: t.palette,
    theme: t.theme,
    fontSize: t.textSize,
    agentList: t.agentList,
    projectGroups: t.projectGroups,
    "dock.jobs": `${t.dock}: ${t.docks.jobs}`,
    "dock.actions": `${t.dock}: ${t.docks.actions}`,
    "dock.subAgents": `${t.dock}: ${t.docks.subAgents}`,
    "turnDock.numbers": `${t.turnDock}: ${t.numbered}`,
    "turnDock.bars": `${t.turnDock}: ${t.bars}`,
  };
  // A colon between a group and its part: a full-width one in Chinese.
  return language === "zh-Hans" ? parts[field].replace(": ", "：") : parts[field];
}

/** A setting's value as the controls above name it, in `language`. A value
 * this version doesn't name is shown as the file wrote it. */
export function fieldText(field: AppearanceField, value: string | number, language: Language = "en"): string {
  const t = text(language);
  switch (field) {
    case "palette":
      return t.palettes[value as Palette] ?? String(value);
    case "theme":
      return t.themes[value as ThemePreference]?.[0] ?? String(value);
    case "fontSize":
      return `${value} px`;
    case "agentList":
      return t.agentLists[value as AgentListDensity]?.[0] ?? String(value);
    case "projectGroups":
      return t.groups[value as ProjectGroupStyle]?.[0] ?? String(value);
    case "turnDock.bars":
      return value === 0 ? t.none : String(value);
    default:
      return value === 0 ? t.hidden : String(value);
  }
}

/** What the file part said last, as what happened, so it is worded in the
 * language shown, also after a switch. */
type FileMessage =
  | { kind: "tooLarge"; name: string }
  | { kind: "unreadable"; name: string }
  | { kind: "refused"; refusal: FileRefusal }
  | { kind: "notImported"; outcome: Extract<SaveOutcome, { saved: false }> }
  | { kind: "imported"; count: number; name: string };

// A refused file's reason: its English as the reader wrote it; in Chinese, by
// its code.
const refusalZh = (refusal: FileRefusal) =>
  ({
    notJson: "此文件不是 JSON，因此不是外观导出文件",
    notExport: "此文件不是 Yuzuno 的外观导出文件",
    newer: `此文件来自更新的 Yuzuno（外观文件版本 ${refusal.version}），此版本只能读取版本 ${refusal.reads}`,
    unknownVersion: "此文件的版本不是 Yuzuno 认识的版本",
    empty: "此文件不含外观设置",
  })[refusal.code] ?? refusal.error;
const fileText = strings({
  group: "Appearance file",
  title: "Move Appearance to another device",
  help: "A file of the settings above as they are in effect: palette, theme, text size, Agent list, project groups and docks. Accounts, permissions, folders and conversations are never in it. Importing shows each setting beside yours before anything changes.",
  export: "Export to a file",
  import: "Import from a file…",
  choose: "Choose an Appearance file",
  preview: "Import preview",
  from: (name: string, exportedAt: string | null) =>
    `From ${name}${exportedAt ? `, exported ${exportedAt}` : ""}. Ticked settings are taken from the file; the others stay as they are.`,
  now: (value: string) => `Now: ${value}`,
  same: "File: the same",
  file: (value: string) => `File: ${value}`,
  invalid: (value: string) => `File: ${value}, not a value Yuzuno accepts; kept as now`,
  unknown: (names: string) => `Not Appearance settings this version knows, so left out: ${names}`,
  apply: (count: number) => (count ? `Apply ${count} selected` : "Nothing to apply"),
  cancel: "Cancel",
  message: (message: FileMessage): string => {
    switch (message.kind) {
      case "tooLarge":
        return `${message.name} is larger than 16 KiB, too large for an Appearance export, so it was not read. Nothing was changed.`;
      case "unreadable":
        return `${message.name} could not be read. Nothing was changed.`;
      case "refused":
        return `${message.refusal.error}. Nothing was changed.`;
      case "notImported":
        return `Not imported: ${message.outcome.detail}. Nothing was changed; your Appearance stays as it is.`;
      case "imported":
        return `Imported ${message.count} ${message.count === 1 ? "setting" : "settings"} from ${message.name}; saved on this device.`;
    }
  },
}, {
  group: "外观文件",
  title: "把外观移到另一台设备",
  help: "一个文件，包含上面这些设置当前生效的值：配色、主题、文字大小、Agent 列表、项目分组和侧栏。账户、权限、文件夹和会话从不在其中。导入时会先把每项设置与你的并排显示，再做任何更改。",
  export: "导出到文件",
  import: "从文件导入…",
  choose: "选择外观文件",
  preview: "导入预览",
  from: (name, exportedAt) => `来自 ${name}${exportedAt ? `，导出于 ${exportedAt}` : ""}。勾选的设置取自文件，其他的保持不变。`,
  now: (value) => `当前：${value}`,
  same: "文件：相同",
  file: (value) => `文件：${value}`,
  invalid: (value) => `文件：${value}，不是 Yuzuno 接受的值；保持当前`,
  unknown: (names) => `此版本不认识的外观设置，因此未包含：${names}`,
  apply: (count) => (count ? `应用所选的 ${count} 项` : "没有可应用的"),
  cancel: "取消",
  message: (message) => {
    switch (message.kind) {
      case "tooLarge":
        return `${message.name} 大于 16 KiB，作为外观导出文件太大，因此没有读取。没有更改任何内容。`;
      case "unreadable":
        return `无法读取 ${message.name}。没有更改任何内容。`;
      case "refused":
        return `${refusalZh(message.refusal)}。没有更改任何内容。`;
      case "notImported":
        return `未导入：${saveRefusalReason(message.outcome, "zh-Hans")}。没有更改任何内容，你的外观保持不变。`;
      case "imported":
        return `已从 ${message.name} 导入 ${message.count} 项设置，并保存到此设备。`;
    }
  },
});

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Appearance to and from a file (T-194). Export writes the settings in
 * effect. Import shows each setting the file holds beside the one in effect,
 * ticked where they differ, and applies only the ticked ones, once saved on
 * this device; a file it can't use, Cancel or a refused save change nothing. */
function AppearanceFile({ appearance }: { appearance: Appearance }) {
  const language = useLanguage();
  const t = fileText(language);
  const [file, setFile] = useState<{ name: string; contents: AppearanceFileContents } | null>(null);
  const [chosen, setChosen] = useState<AppearanceField[]>([]);
  const [said, setSaid] = useState<{ error: boolean; message: FileMessage; n: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const line = useRef<HTMLParagraphElement>(null);
  // In a short pane the line can lie below the button pressed.
  useEffect(() => {
    if (said?.error) line.current?.scrollIntoView?.({ block: "nearest" });
  }, [said]);
  const say = (error: boolean, message: FileMessage) => setSaid((old) => ({ error, message, n: (old?.n ?? 0) + 1 }));
  const differs = (field: AppearanceField, contents: AppearanceFileContents) => {
    const value = contents.values[field];
    return value !== undefined && value !== fieldValue(appearance, field);
  };
  const selected = file ? chosen.filter((field) => differs(field, file.contents)) : [];

  function exportFile() {
    const url = URL.createObjectURL(new Blob([exportAppearance(appearance)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "yuzuno-appearance.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  async function choose(picked: File | undefined) {
    setSaid(null);
    setFile(null);
    if (!picked) return;
    if (picked.size > MAX_APPEARANCE_FILE_BYTES) {
      say(true, { kind: "tooLarge", name: picked.name });
      return;
    }
    let text: string;
    try {
      text = await readText(picked);
    } catch {
      say(true, { kind: "unreadable", name: picked.name });
      return;
    }
    const read = readAppearanceFile(text);
    if ("error" in read) {
      say(true, { kind: "refused", refusal: read });
      return;
    }
    setFile({ name: picked.name, contents: read.contents });
    setChosen(appearanceFields.filter((field) => differs(field, read.contents)));
  }
  function apply() {
    if (!file || !selected.length) return;
    const outcome = importAppearance(importedAppearance(appearance, file.contents, selected));
    if (!outcome.saved) {
      say(true, { kind: "notImported", outcome });
      return;
    }
    setFile(null);
    say(false, { kind: "imported", count: selected.length, name: file.name });
  }
  const exportedAt = file?.contents.exportedAt && !Number.isNaN(Date.parse(file.contents.exportedAt))
    ? new Date(file.contents.exportedAt).toLocaleString()
    : null;

  return (
    <div className="settings-group appearance-file" aria-label={t.group}>
      <div className="settings-row">
        <span className="settings-row-main">
          <span className="settings-row-title">{t.title}</span>
          <span className="settings-row-help">{t.help}</span>
        </span>
        <span className="settings-row-action appearance-file-buttons">
          <button type="button" onClick={exportFile}>
            {t.export}
          </button>
          <button type="button" onClick={() => picker.current?.click()}>
            {t.import}
          </button>
          <input
            ref={picker}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label={t.choose}
            onChange={(event) => {
              const picked = event.target.files?.[0];
              event.target.value = "";
              void choose(picked);
            }}
          />
        </span>
      </div>
      {file && (
        <div className="appearance-file-preview" role="group" aria-label={t.preview}>
          {/* The file's name, as the system wrote it, is never translated. */}
          <p>{t.from(file.name, exportedAt)}</p>
          <ul>
            {appearanceFields.map((field) => {
              const value = file.contents.values[field];
              const bad = file.contents.invalid.find((item) => item.field === field);
              if (value === undefined && !bad) return null;
              const now = fieldText(field, fieldValue(appearance, field), language);
              if (value === undefined)
                return (
                  <li key={field} data-state="invalid">
                    <span className="appearance-file-name">{fieldLabel(field, language)}</span>
                    <span>{t.now(now)}</span>
                    <span>{t.invalid(bad!.value)}</span>
                  </li>
                );
              const same = !differs(field, file.contents);
              return (
                <li key={field} data-state={same ? "same" : "differs"}>
                  <label className="appearance-file-name">
                    <input
                      type="checkbox"
                      disabled={same}
                      checked={!same && chosen.includes(field)}
                      onChange={(event) =>
                        setChosen((old) => (event.target.checked ? [...old, field] : old.filter((f) => f !== field)))
                      }
                    />
                    {fieldLabel(field, language)}
                  </label>
                  <span>{t.now(now)}</span>
                  <span>{same ? t.same : t.file(fieldText(field, value, language))}</span>
                </li>
              );
            })}
          </ul>
          {file.contents.unknown.length > 0 && (
            <p className="settings-row-help">{t.unknown(file.contents.unknown.join(", "))}</p>
          )}
          <div className="appearance-file-buttons">
            <button type="button" disabled={!selected.length} onClick={apply}>
              {t.apply(selected.length)}
            </button>
            <button
              type="button"
              onClick={() => {
                setFile(null);
                setSaid(null);
              }}
            >
              {t.cancel}
            </button>
          </div>
        </div>
      )}
      {said && (
        <p
          ref={line}
          className={said.error ? "appearance-file-error" : "appearance-file-done"}
          role={said.error ? "alert" : "status"}
        >
          {t.message(said.message)}
        </p>
      )}
    </div>
  );
}
