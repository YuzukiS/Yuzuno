import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowRight, Archive, Bell, Bot, ChevronLeft, ClipboardList, Cpu, Database, Folder, Globe, HardDrive, House, Info,
  Monitor, Palette, RefreshCw, Route, Search, Send, Server, Type, Users, type LucideIcon,
} from "lucide-react";
import type { Agent, Project } from "./types";
import { langTag, strings, TranslatedPart, useLanguage, useStrings } from "./i18n";
import { findSettings, localizedEntry, translatedEditors, type SettingEntry, type SettingsDestination, type SettingsEditor } from "./settings-catalog";
import { groupLabel, legacyEditors, pageLabel, pageOfEditor, pageOfEntry, settingsGroups, settingsPages, type PageEditor, type SettingsPage } from "./settings-pages";
import { usePhone } from "./phone-layout";
import { SaveBarScope } from "./SettingsSaveBar";
import "./settings-center.css";

export type SettingsNavigation = {
  agents: Agent[];
  projects: Project[];
  disabled?: boolean;
  onNavigate: (destination: SettingsDestination) => void;
};
/** Settings opened at a page from elsewhere: a page (and within it a
 * project or machine, `sub`), or the editor an older caller names. Each
 * nonce opens it once. */
export type SettingsOpenAt = { page?: SettingsPage; sub?: string; block?: string; editor?: PageEditor; nonce: number };
/** The latest request to open a page at something in it: `sub` is a
 * project or machine id, or "new". Each request has its own `n`, so a page
 * starts anew for a request and keeps its state across tab changes. */
export type SettingsRequest = { sub?: string; block?: string; n: number };
const pageIcons: Record<SettingsPage, LucideIcon> = {
  appearance: Palette, typing: Send, language: Globe, shortcuts: Type, notifications: Bell, transfer: HardDrive,
  projects: Folder, machines: Server, agents: Bot, executors: Users, routing: Route, home: House, phone: Monitor,
  storage: Database, backup: Archive, diagnostics: ClipboardList,
  updates: RefreshCw, runtime: Cpu, about: Info,
};

// Settings' own words (T-189); its directory's are in settings-catalog-zh.ts
// and its pages' in settings-pages.ts.
const text = strings({
  search: "Search settings",
  searchPlaceholder: "Search settings…",
  settings: "Settings",
  back: "Settings",
  updateAvailable: "Update available",
  results: "Search results",
  resultsRegion: "Settings search results",
  resultsHelp: "Open a setting to see its saved value and available actions.",
  found: (count: number) => `${count} settings found`,
  none: "No matching settings. Try a different term.",
  elsewhere: "Elsewhere",
  elsewhereHelp: "Not on a page of Settings: each says where it is set.",
  scope: "Scope:",
  source: "Value source:",
  effect: "When it takes effect:",
  unavailable: "Unavailable here.",
  // After a label: a space in English, none after a Chinese colon or stop.
  gap: " ",
  agent: "Agent",
  // Ending the picker's accessible name: "<entry> agent".
  agentKind: "agent",
  chooseAgent: "Choose an Agent…",
  noAgents: "No eligible Agents are available.",
  project: "Project",
  projectKind: "project",
  chooseProject: "Choose a project…",
  noProjects: "No eligible projects are available.",
  connect: "Connect to your Workspace to open this editor.",
  open: (title: string) => `Open ${title}`,
}, {
  search: "搜索设置",
  searchPlaceholder: "搜索设置…",
  settings: "设置",
  back: "设置",
  updateAvailable: "有可用更新",
  results: "搜索结果",
  resultsRegion: "设置搜索结果",
  resultsHelp: "打开一项设置，查看它保存的值和可用的操作。",
  found: (count: number) => `找到 ${count} 项设置`,
  none: "没有匹配的设置。换个词试试。",
  elsewhere: "在别处",
  elsewhereHelp: "不在设置的页面里：每一项写着在哪里设。",
  scope: "范围：",
  source: "取值来源：",
  effect: "何时生效：",
  unavailable: "此处不可用。",
  gap: "",
  agent: "Agent",
  agentKind: "Agent",
  chooseAgent: "选择一个 Agent…",
  noAgents: "没有符合条件的 Agent。",
  project: "项目",
  projectKind: "项目",
  chooseProject: "选择一个项目…",
  noProjects: "没有符合条件的项目。",
  connect: "连接到你的 Workspace 后才能打开此编辑页。",
  open: (title: string) => `打开${title}`,
});

const editorsOf = (page: SettingsPage) => settingsPages.find((item) => item.id === page)!.editors;
/** An editor as a page shows it: one an older caller names that is now part
 * of a page (the Job budgets) is that page's first editor, at its `sub`. */
function resolve(editor: PageEditor, sub?: string, block?: string): { editor: PageEditor; sub?: string; block?: string } {
  const legacy = legacyEditors[editor as SettingsEditor];
  return legacy ? { editor: editorsOf(legacy.page)[0], sub: sub ?? legacy.sub, block: block ?? legacy.block } : { editor, sub, block };
}
/** Whether this version shows an editor in the interface language (T-189). */
const translated = (id: PageEditor) => id === "projects" || id === "machines" || translatedEditors.includes(id as SettingsEditor);

/** The catalog never reads or writes a setting. Each editor remains its only owner. */
export function SettingsCenter({ attention, navigation, renderEditor, onEditorChange, openAt }: {
  attention: boolean;
  navigation?: SettingsNavigation;
  /** Opens a page (or an editor's page), as its tab would (a notification's click, T-196; the rail, YN-8). */
  openAt?: SettingsOpenAt | null;
  /** `open` shows another editor's page, as its card would; `request` is
   * the latest request for the editor's page. */
  renderEditor: (editor: PageEditor, visible: boolean, open: (editor: SettingsEditor) => void, request?: SettingsRequest) => ReactNode;
  onEditorChange?: (editor: SettingsEditor | null) => void;
}) {
  const phone = usePhone();
  // Opened at a page, Settings starts there; otherwise at Updates, as before.
  const [initial] = useState<SettingsPage>(() => (openAt?.editor ? pageOfEditor(openAt.editor) : openAt?.page) ?? "updates");
  const [page, setPage] = useState<SettingsPage>(initial);
  // A request Settings is opened with is its page's from the first render,
  // so that page is built once, at what was asked for.
  const [opening] = useState(() => openAt ? resolve(openAt.editor ?? editorsOf(initial)[0], openAt.sub, openAt.block) : null);
  const [requests, setRequests] = useState<Partial<Record<SettingsPage, SettingsRequest>>>(() =>
    opening ? { [initial]: { sub: opening.sub, block: opening.block, n: 1 } } : {});
  const applied = useRef(openAt?.nonce);
  // A phone starts at the list of pages; a page has Back to it.
  const [root, setRoot] = useState(phone && !openAt);
  const [query, setQuery] = useState("");
  const [visited, setVisited] = useState<PageEditor[]>(() => [...editorsOf(initial)]);
  // The visited editors by page, in the order the pages were first visited.
  const visitedPages = [...visited.reduce((pages, id) => {
    const of = pageOfEditor(id);
    pages.set(of, [...(pages.get(of) ?? []), id]);
    return pages;
  }, new Map<SettingsPage, PageEditor[]>())];
  const [focusEditor, setFocusEditor] = useState<{ editor: PageEditor; block?: string; n: number } | null>(() =>
    opening ? { editor: opening.editor, block: opening.block, n: 1 } : null);
  const content = useRef<HTMLDivElement>(null);
  const language = useLanguage();
  const t = text(language);
  const searching = !!query.trim();
  // On a phone the list of pages, with search, comes first; search runs from it.
  const atRoot = phone && root;
  const first = editorsOf(page)[0];
  useEffect(() => {
    onEditorChange?.(searching || atRoot || first === "projects" || first === "machines" ? null : first);
  }, [searching, atRoot, first, onEditorChange]);
  const entries = searching ? findSettings(query) : [];
  const onPages = entries.filter((entry) => pageOfEntry(entry));
  const elsewhere = entries.filter((entry) => !pageOfEntry(entry));
  // While searching, the sidebar keeps the pages that have a match.
  const found = new Set(onPages.map(pageOfEntry));
  const words = query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const shownPage = (id: SettingsPage) => !searching || found.has(id) || words.every((word) => `${pageLabel(id, "en")} ${pageLabel(id, "zh-Hans")}`.toLocaleLowerCase().includes(word));
  function show(next: SettingsPage) {
    setPage(next);
    setRoot(false);
    setVisited((old) => [...old, ...editorsOf(next).filter((id) => !old.includes(id))]);
  }
  function choose(next: SettingsPage) {
    setQuery("");
    show(next);
    content.current?.scrollTo?.({ top: 0 });
  }
  /** Shows an editor's page, as a new request for it, and moves focus to
   * that editor. */
  function openEditor(named: PageEditor, asked?: string, askedBlock?: string) {
    const { editor, sub, block } = resolve(named, asked, askedBlock);
    const next = pageOfEditor(editor);
    setQuery("");
    show(next);
    setRequests((old) => ({ ...old, [next]: { sub, block, n: (old[next]?.n ?? 0) + 1 } }));
    setFocusEditor((old) => ({ editor, block, n: (old?.n ?? 0) + 1 }));
  }
  function open(entry: SettingEntry, objectId?: string) {
    const target = entry.target;
    if (target.kind === "editor") openEditor(target.editor);
    else if (target.kind === "project") openEditor("projects", objectId);
    else if (target.kind === "machines") openEditor("machines");
  }
  useEffect(() => {
    // Each request once: not again when the catalog re-renders, nor the one
    // Settings was opened with.
    if (!openAt || openAt.nonce === applied.current) return;
    applied.current = openAt.nonce;
    const editor = openAt.editor ?? (openAt.page ? editorsOf(openAt.page)[0] : undefined);
    if (editor) openEditor(editor, openAt.sub, openAt.block);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAt?.nonce]);
  // Opened together with its dialog (openAt), this comes after the dialog's
  // own first focus, which moves nothing once focus is inside it. A dialog
  // that hands off to Settings gives no focus back to its trigger (Jobs'
  // Edit in Settings, T-55), so nothing comes after this.
  useEffect(() => {
    if (!focusEditor) return;
    // A block asked for (the Core host's Job budget) when its page shows it.
    const target = (focusEditor.block && document.getElementById(`settings-block-${focusEditor.block}`))
      || document.getElementById(`settings-editor-${focusEditor.editor}`);
    target?.focus();
    target?.scrollIntoView?.({ block: "start" });
  }, [focusEditor]);
  const pages = settingsPages.filter((item) => shownPage(item.id));
  function onKey(event: KeyboardEvent) {
    const keys = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key) || !pages.length) return;
    event.preventDefault();
    const current = Math.max(0, pages.findIndex((item) => item.id === page));
    const next = event.key === "Home" ? 0 : event.key === "End" ? pages.length - 1
      : (current + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + pages.length) % pages.length;
    const id = pages[next].id;
    choose(id);
    document.getElementById(`settings-tab-${id}`)?.focus();
  }
  // This shell and its directory are in the language shown; an editor is
  // only when this version translates it (translatedEditors).
  return <div className={`workspace-updates settings-center${atRoot ? " is-root" : ""}${phone ? " is-phone" : ""}${searching ? " is-searching" : ""}`} lang={langTag(language)}>
    <div className="settings-layout">
      <div className="settings-side">
        <label className="settings-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">{t.search}</span>
          <input type="search" value={query} placeholder={t.searchPlaceholder} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="settings-nav" onKeyDown={onKey}>
          {settingsGroups.map((group) => {
            const inGroup = pages.filter((item) => item.group === group.id);
            if (!inGroup.length) return null;
            const heading = `settings-group-${group.id}`;
            return <div className="settings-nav-group" key={group.id}>
              <h3 id={heading} className="settings-nav-heading">{groupLabel(group.id, language)}</h3>
              <div role="tablist" aria-labelledby={heading} aria-orientation="vertical">
                {inGroup.map((item) => {
                  const Icon = pageIcons[item.id];
                  const selected = page === item.id && !searching && !atRoot;
                  // While searching, the pane is the results, not a page: no aria-controls.
                  return <button type="button" role="tab" key={item.id}
                    id={`settings-tab-${item.id}`} aria-controls={searching ? undefined : "settings-page"} aria-selected={selected}
                    tabIndex={page === item.id ? 0 : -1} onClick={() => choose(item.id)}>
                    <Icon size={16} aria-hidden="true" />
                    <span className="settings-nav-label">{pageLabel(item.id, language)}</span>
                    {item.id === "updates" && attention && <span className="settings-nav-dot" aria-label={t.updateAvailable} />}
                  </button>;
                })}
              </div>
            </div>;
          })}
        </div>
      </div>
      <div ref={content} className="settings-pane" role={searching ? "region" : "tabpanel"}
        id={searching ? "settings-search-results" : "settings-page"}
        aria-label={searching ? t.resultsRegion : undefined}
        aria-labelledby={searching ? undefined : `settings-tab-${page}`}>
        {phone && !atRoot && !searching && <button type="button" className="settings-back" onClick={() => setRoot(true)}>
          <ChevronLeft size={16} aria-hidden="true" />{t.back}
        </button>}
        {searching && <>
          <header className="settings-catalog-heading">
            <h3>{t.results}</h3>
            <p>{t.resultsHelp}</p>
            <p role="status">{entries.length ? t.found(entries.length) : t.none}</p>
          </header>
          <div className="settings-catalog">
            {onPages.map((entry) => <SettingCard key={entry.id} entry={localizedEntry(entry, language)} navigation={navigation}
              onOpen={(objectId) => open(entry, objectId)} />)}
          </div>
          {elsewhere.length > 0 && <section className="settings-elsewhere" aria-labelledby="settings-elsewhere-title">
            <h3 id="settings-elsewhere-title">{t.elsewhere}</h3>
            <p>{t.elsewhereHelp}</p>
            <div className="settings-catalog">
              {elsewhere.map((entry) => <SettingCard key={entry.id} entry={localizedEntry(entry, language)} navigation={navigation}
                onOpen={() => open(entry)} />)}
            </div>
          </section>}
        </>}
        {/* Keep visited editors mounted while searching or changing page:
            failed saves and unfinished compound inputs must not disappear.
            A page's editors share its one save bar (YN-8), shown with it. */}
        {visitedPages.map(([pageId, ids]) => (
          <SaveBarScope key={pageId} hidden={searching || atRoot || pageId !== page}>
            {ids.map((id) => {
              const visible = !searching && !atRoot && pageId === page;
              return <div key={id} hidden={!visible} className="settings-editor"
                id={`settings-editor-${id}`} tabIndex={-1} lang={translated(id) ? langTag(language) : "en"}>
                <TranslatedPart value={translated(id)}>
                  {renderEditor(id, visible, openEditor, requests[pageId])}
                </TranslatedPart>
              </div>;
            })}
          </SaveBarScope>
        ))}
      </div>
    </div>
  </div>;
}

/** A setting in search results, whole; one edited elsewhere says where.
 * One of a selected Agent or project names it first: never the first one. */
function SettingCard({ entry, navigation, onOpen }: {
  entry: SettingEntry;
  navigation?: SettingsNavigation;
  onOpen: (objectId?: string) => void;
}) {
  const t = useStrings(text);
  const [objectId, setObjectId] = useState("");
  const target = entry.target;
  const agents = target.kind === "agent" ? (navigation?.agents ?? []).filter((agent) => !agent.closedAt &&
    (target.section === "context" ? agent.harness === "codex" : target.section === "auto-continue" ? agent.harness === "claude" && !agent.remote : true)) : [];
  const projects = target.kind === "project" ? (navigation?.projects ?? []).filter((project) => !project.archivedAt) : [];
  const choices = target.kind === "agent" ? agents : projects;
  const selected = choices.find((item) => item.id === objectId);
  const requiresObject = target.kind === "agent" || target.kind === "project";
  const unavailable = target.kind === "unavailable";
  // An Agent's own settings leave Settings, so they need the Workspace;
  // a project's are a page of Settings.
  const leaves = target.kind === "agent";
  const routable = (!leaves || !!navigation && !navigation.disabled) && (!requiresObject || !!selected);
  function navigate() {
    if (target.kind === "agent") {
      if (navigation && !navigation.disabled && selected) navigation.onNavigate({ ...target, agentId: selected.id });
      return;
    }
    onOpen(selected?.id);
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
      {leaves && (!navigation || navigation.disabled) && <p>{t.connect}</p>}
      <button type="button" className="secondary-button" disabled={!routable} onClick={navigate}>
        {t.open(entry.title)}<ArrowRight size={14} aria-hidden="true" />
      </button>
    </>}
  </section>;
}
