import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Search } from "lucide-react";
import type { Agent, Project } from "./types";
import { findSettings, settingsCatalog, settingsCategories, type SettingEntry, type SettingsCategory, type SettingsDestination, type SettingsEditor } from "./settings-catalog";
import "./settings-center.css";

export type SettingsNavigation = {
  agents: Agent[];
  projects: Project[];
  disabled?: boolean;
  onNavigate: (destination: SettingsDestination) => void;
};

/** The catalog never reads or writes a setting. Each editor remains its only owner. */
export function SettingsCenter({ attention, navigation, renderEditor, onEditorChange }: {
  attention: boolean;
  navigation?: SettingsNavigation;
  renderEditor: (editor: SettingsEditor, visible: boolean) => ReactNode;
  onEditorChange?: (editor: SettingsEditor | null) => void;
}) {
  const [category, setCategory] = useState<SettingsCategory>("updates");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<SettingsEditor | null>("updates");
  const [visited, setVisited] = useState<SettingsEditor[]>(["updates"]);
  const [focusEditor, setFocusEditor] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const searching = !!query.trim();
  useEffect(() => { onEditorChange?.(searching ? null : editor); }, [searching, editor, onEditorChange]);
  const selectedCategory = settingsCategories.find((item) => item.id === category)!;
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
  useEffect(() => {
    if (!focusEditor || !editor) return;
    const target = document.getElementById(`settings-editor-${editor}`);
    target?.focus();
    target?.scrollIntoView?.({ block: "start" });
  }, [focusEditor, editor]);
  return <div className="workspace-updates settings-center">
    <label className="settings-search">
      <Search size={16} aria-hidden="true" />
      <span className="sr-only">Search settings</span>
      <input type="search" value={query} placeholder="Search settings…" onChange={(event) => setQuery(event.target.value)} />
    </label>
    <div className="settings-layout">
      <label className="settings-category-picker">
        <span className="sr-only">Settings category</span>
        <select value={category} onChange={(event) => chooseCategory(event.target.value as SettingsCategory)}>
          {settingsCategories.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
        </select>
      </label>
      <div className="settings-nav" role="tablist" aria-label="Settings" aria-orientation="vertical" onKeyDown={(event) => {
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
          {item.label}{item.id === "updates" && attention && <span className="settings-nav-dot" aria-label="Update available" />}
        </button>)}
      </div>
      <div ref={content} className="settings-pane" role={searching ? "region" : "tabpanel"}
        id={searching ? "settings-search-results" : `settings-panel-${category}`}
        aria-label={searching ? "Settings search results" : undefined}
        aria-labelledby={searching ? undefined : `settings-tab-${category}`}>
        <header className="settings-catalog-heading">
          <h3>{searching ? "Search results" : selectedCategory.label}</h3>
          <p>{searching ? "Open a setting to see its saved value and available actions." : selectedCategory.description}</p>
          {searching && <p role="status">{entries.length ? `${entries.length} settings found` : "No matching settings. Try a different term."}</p>}
        </header>
        <div className="settings-catalog">
          {entries.map((entry) => <SettingCard key={entry.id} entry={entry} navigation={navigation}
            active={!searching && entry.target.kind === "editor" && entry.target.editor === editor}
            onOpen={() => open(entry)} />)}
        </div>
        {/* Keep visited editors mounted while searching or changing category:
            failed saves and unfinished compound inputs must not disappear. */}
        {visited.map((id) => <div key={id} hidden={searching || id !== editor} className="settings-editor"
          id={`settings-editor-${id}`} tabIndex={-1}>
          {renderEditor(id, !searching && id === editor)}
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
    <p className="settings-scope"><strong>Scope:</strong> {entry.scope}{selected ? ` · ${selected.name}` : ""}</p>
    <p><strong>Value source:</strong> {entry.source}</p>
    <p><strong>When it takes effect:</strong> {entry.effect}</p>
    {unavailable ? <p className="settings-unavailable"><strong>Unavailable here.</strong> {target.reason}</p> : <>
      {requiresObject && <label className="settings-object-choice">
        {target.kind === "agent" ? "Agent" : "Project"}
        <select value={selected?.id ?? ""} onChange={(event) => setObjectId(event.target.value)} aria-label={`${entry.title} ${target.kind}`}>
          <option value="">Choose {target.kind === "agent" ? "an Agent" : "a project"}…</option>
          {choices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>}
      {requiresObject && !choices.length && <p>No eligible {target.kind === "agent" ? "Agents" : "projects"} are available.</p>}
      {target.kind !== "editor" && (!navigation || navigation.disabled) && <p>Connect to your Workspace to open this editor.</p>}
      {active ? <p className="settings-editor-location">Editor below</p> : <button type="button" className="secondary-button" disabled={!routable} onClick={navigate}>
        Open {entry.title}<ArrowRight size={14} aria-hidden="true" />
      </button>}
    </>}
  </section>;
}
