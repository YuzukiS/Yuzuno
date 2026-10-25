import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Search } from "lucide-react";
import type { Agent, Project } from "./types";
import { langTag, strings, TranslatedPart, useLanguage, useStrings } from "./i18n";
import { findSettings, localizedCategory, localizedEntry, settingsCatalog, settingsCategories, translatedEditors, type SettingEntry, type SettingsCategory, type SettingsDestination, type SettingsEditor } from "./settings-catalog";
import "./settings-center.css";

export type SettingsNavigation = {
  agents: Agent[];
  projects: Project[];
  disabled?: boolean;
  onNavigate: (destination: SettingsDestination) => void;
};

// Settings' own words (T-189); its directory's are in settings-catalog-zh.ts.
const text = strings({
  search: "Search settings",
  searchPlaceholder: "Search settings…",
  category: "Settings category",
  settings: "Settings",
  updateAvailable: "Update available",
  results: "Search results",
  resultsRegion: "Settings search results",
  resultsHelp: "Open a setting to see its saved value and available actions.",
  found: (count: number) => `${count} settings found`,
  none: "No matching settings. Try a different term.",
  scope: "Scope:",
  source: "Value source:",
  effect: "When it takes effect:",
  unavailable: "Unavailable here.",
  // After a label: a space in English, none after a Chinese colon or stop.
  gap: " ",
  agent: "Agent",
  project: "Project",
  // Ending the picker's accessible name: "<entry> agent".
  agentKind: "agent",
  projectKind: "project",
  chooseAgent: "Choose an Agent…",
  chooseProject: "Choose a project…",
  noAgents: "No eligible Agents are available.",
  noProjects: "No eligible projects are available.",
  connect: "Connect to your Workspace to open this editor.",
  editorBelow: "Editor below",
  open: (title: string) => `Open ${title}`,
}, {
  search: "搜索设置",
  searchPlaceholder: "搜索设置…",
  category: "设置类别",
  settings: "设置",
  updateAvailable: "有可用更新",
  results: "搜索结果",
  resultsRegion: "设置搜索结果",
  resultsHelp: "打开一项设置，查看它保存的值和可用的操作。",
  found: (count: number) => `找到 ${count} 项设置`,
  none: "没有匹配的设置。换个词试试。",
  scope: "范围：",
  source: "取值来源：",
  effect: "何时生效：",
  unavailable: "此处不可用。",
  gap: "",
  agent: "Agent",
  project: "项目",
  agentKind: "Agent",
  projectKind: "项目",
  chooseAgent: "选择一个 Agent…",
  chooseProject: "选择一个项目…",
  noAgents: "没有符合条件的 Agent。",
  noProjects: "没有符合条件的项目。",
  connect: "连接到你的 Workspace 后才能打开此编辑页。",
  editorBelow: "编辑页在下方",
  open: (title: string) => `打开${title}`,
});

/** The catalog never reads or writes a setting. Each editor remains its only owner. */
export function SettingsCenter({ attention, navigation, renderEditor, onEditorChange }: {
  attention: boolean;
  navigation?: SettingsNavigation;
  /** `open` shows another editor, as its card would. */
  renderEditor: (editor: SettingsEditor, visible: boolean, open: (editor: SettingsEditor) => void) => ReactNode;
  onEditorChange?: (editor: SettingsEditor | null) => void;
}) {
  const [category, setCategory] = useState<SettingsCategory>("updates");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<SettingsEditor | null>("updates");
  const [visited, setVisited] = useState<SettingsEditor[]>(["updates"]);
  const [focusEditor, setFocusEditor] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const language = useLanguage();
  const t = text(language);
  const searching = !!query.trim();
  useEffect(() => { onEditorChange?.(searching ? null : editor); }, [searching, editor, onEditorChange]);
  const selectedCategory = localizedCategory(category, language);
  const entries = searching ? findSettings(query) : settingsCatalog.filter((entry) => entry.category === category);
  function showEditor(next: SettingsEditor) {
    setEditor(next);
    setVisited((old) => old.includes(next) ? old : [...old, next]);
  }
  function chooseCategory(next: SettingsCategory) {
    setCategory(next);
    setQuery("");
    // A category with one editor of its own opens it (T-188: Notifications).
    if (next === "updates" || next === "appearance" || next === "notifications") showEditor(next);
    else setEditor(null);
    content.current?.scrollTo?.({ top: 0 });
  }
  function open(entry: SettingEntry) {
    if (entry.target.kind !== "editor") return;
    setCategory(entry.category);
    setQuery("");
    showEditor(entry.target.editor);
    setFocusEditor((old) => old + 1);
  }
  function openEditor(next: SettingsEditor) {
    const entry = settingsCatalog.find((item) => item.target.kind === "editor" && item.target.editor === next);
    if (entry) open(entry);
  }
  useEffect(() => {
    if (!focusEditor || !editor) return;
    const target = document.getElementById(`settings-editor-${editor}`);
    target?.focus();
    target?.scrollIntoView?.({ block: "start" });
  }, [focusEditor, editor]);
  // This shell and its directory are in the language shown; an editor is
  // only when this version translates it (translatedEditors).
  return <div className="workspace-updates settings-center" lang={langTag(language)}>
    <label className="settings-search">
      <Search size={16} aria-hidden="true" />
      <span className="sr-only">{t.search}</span>
      <input type="search" value={query} placeholder={t.searchPlaceholder} onChange={(event) => setQuery(event.target.value)} />
    </label>
    <div className="settings-layout">
      <label className="settings-category-picker">
        <span className="sr-only">{t.category}</span>
        <select value={category} onChange={(event) => chooseCategory(event.target.value as SettingsCategory)}>
          {settingsCategories.map((item) => <option value={item.id} key={item.id}>{localizedCategory(item.id, language).label}</option>)}
        </select>
      </label>
      <div className="settings-nav" role="tablist" aria-label={t.settings} aria-orientation="vertical" onKeyDown={(event) => {
        const keys = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const current = settingsCategories.findIndex((item) => item.id === category);
        const next = event.key === "Home" ? 0 : event.key === "End" ? settingsCategories.length - 1
          : (current + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + settingsCategories.length) % settingsCategories.length;
        const id = settingsCategories[next].id;
        chooseCategory(id);
        document.getElementById(`settings-tab-${id}`)?.focus();
      }}>
        {settingsCategories.map((item) => <button type="button" role="tab" key={item.id}
          id={`settings-tab-${item.id}`} aria-controls={`settings-panel-${item.id}`} aria-selected={category === item.id && !searching}
          tabIndex={category === item.id ? 0 : -1} onClick={() => chooseCategory(item.id)}>
          {localizedCategory(item.id, language).label}{item.id === "updates" && attention && <span className="settings-nav-dot" aria-label={t.updateAvailable} />}
        </button>)}
      </div>
      <div ref={content} className="settings-pane" role={searching ? "region" : "tabpanel"}
        id={searching ? "settings-search-results" : `settings-panel-${category}`}
        aria-label={searching ? t.resultsRegion : undefined}
        aria-labelledby={searching ? undefined : `settings-tab-${category}`}>
        <header className="settings-catalog-heading">
          <h3>{searching ? t.results : selectedCategory.label}</h3>
          <p>{searching ? t.resultsHelp : selectedCategory.description}</p>
          {searching && <p role="status">{entries.length ? t.found(entries.length) : t.none}</p>}
        </header>
        <div className="settings-catalog">
          {entries.map((entry) => <SettingCard key={entry.id} entry={localizedEntry(entry, language)} navigation={navigation}
            active={!searching && entry.target.kind === "editor" && entry.target.editor === editor}
            onOpen={() => open(entry)} />)}
        </div>
        {/* Keep visited editors mounted while searching or changing category:
            failed saves and unfinished compound inputs must not disappear. */}
        {visited.map((id) => <div key={id} hidden={searching || id !== editor} className="settings-editor"
          id={`settings-editor-${id}`} tabIndex={-1} lang={translatedEditors.includes(id) ? langTag(language) : "en"}>
          <TranslatedPart value={translatedEditors.includes(id)}>
            {renderEditor(id, !searching && id === editor, openEditor)}
          </TranslatedPart>
        </div>)}
      </div>
    </div>
  </div>;
}

function SettingCard({ entry, navigation, active, onOpen }: {
  entry: SettingEntry;
  navigation?: SettingsNavigation;
  active: boolean;
  onOpen: () => void;
}) {
  const t = useStrings(text);
  const [objectId, setObjectId] = useState("");
  const target = entry.target;
  const agents = target.kind === "agent" ? (navigation?.agents ?? []).filter((agent) => !agent.closedAt &&
    (target.section === "context" ? agent.harness === "codex" : target.section === "auto-continue" ? agent.harness === "claude" && !agent.remote : agent.harness !== "opencode")) : [];
  const projects = (navigation?.projects ?? []).filter((project) => !project.archivedAt);
  const choices = target.kind === "agent" ? agents : target.kind === "project" ? projects : [];
  const selected = choices.find((item) => item.id === objectId);
  const requiresObject = target.kind === "agent" || target.kind === "project";
  const unavailable = target.kind === "unavailable";
  const routable = target.kind === "editor" || !!navigation && !navigation.disabled && (!requiresObject || !!selected);
  function navigate() {
    if (target.kind === "editor") return onOpen();
    if (!navigation || navigation.disabled) return;
    if (target.kind === "agent" && selected) navigation.onNavigate({ ...target, agentId: selected.id });
    else if (target.kind === "project" && selected) navigation.onNavigate({ kind: "project", projectId: selected.id });
    else if (target.kind === "jobs" || target.kind === "machines") navigation.onNavigate(target);
  }
  return <section className="settings-catalog-card" aria-labelledby={`setting-${entry.id}`}>
    <h4 id={`setting-${entry.id}`}>{entry.title}</h4>
    <p className="settings-scope"><strong>{t.scope}</strong>{t.gap}{entry.scope}{selected ? ` · ${selected.name}` : ""}</p>
    <p><strong>{t.source}</strong>{t.gap}{entry.source}</p>
    <p><strong>{t.effect}</strong>{t.gap}{entry.effect}</p>
    {unavailable ? <p className="settings-unavailable"><strong>{t.unavailable}</strong>{t.gap}{target.reason}</p> : <>
      {requiresObject && <label className="settings-object-choice">
        {target.kind === "agent" ? t.agent : t.project}
        <select value={selected?.id ?? ""} onChange={(event) => setObjectId(event.target.value)} aria-label={`${entry.title} ${target.kind === "agent" ? t.agentKind : t.projectKind}`}>
          <option value="">{target.kind === "agent" ? t.chooseAgent : t.chooseProject}</option>
          {/* Names are as their owners wrote them. */}
          {choices.map((item) => <option key={item.id} value={item.id} lang="">{item.name}</option>)}
        </select>
      </label>}
      {requiresObject && !choices.length && <p>{target.kind === "agent" ? t.noAgents : t.noProjects}</p>}
      {target.kind !== "editor" && (!navigation || navigation.disabled) && <p>{t.connect}</p>}
      {active ? <p className="settings-editor-location">{t.editorBelow}</p> : <button type="button" className="secondary-button" disabled={!routable} onClick={navigate}>
        {t.open(entry.title)}<ArrowRight size={14} aria-hidden="true" />
      </button>}
    </>}
  </section>;
}
