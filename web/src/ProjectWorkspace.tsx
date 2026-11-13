import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Folder,
  FolderPlus,
  Layers,
  LoaderCircle,
  Monitor,
  Plus,
  Server,
  Settings2,
  Trash2,
} from "lucide-react";
import { api, errorText, patch, post, remove } from "./api";
import { strings, useLanguage, useStrings } from "./i18n";
import { Tip, TipText } from "./Tip";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import {
  ALL_PROJECTS,
  NO_PROJECT,
  activeProjects,
  folderName,
  inScope,
  projectName,
  projectScope,
  scopeLabel,
  unassignedFolders,
  type ProjectScope,
} from "./projects";
import type { Agent, Project, ProjectUsage } from "./types";
import { PROJECT_KEY } from "./intelligent-ui/task-key";
import "./projects.css";
import { GitHubLinks } from "./GitHubLinks";
import { ProjectServices } from "./ProjectServices";
import { AgentDefaults } from "./AgentDefaults";
import { ProjectHandover } from "./ProjectHandover";
import { ReviewSettings } from "./ReviewSettings";
import { ProjectMembers } from "./ProjectLeads";
import { SaveBarScope, useSaveBarPart } from "./SettingsSaveBar";
import { FieldLength } from "./FieldLength";
import { coreLimits, overLimit } from "./core-limits";

function useOutsideClose(
  open: boolean,
  close: () => void,
  ref: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", pointer);
    return () => document.removeEventListener("pointerdown", pointer);
  }, [open, close, ref]);
}

/** How long the project menu takes to sink back (projects.css). */
const MENU_OUT_MS = 130;

/** The bottom-left entry: which part of this Workspace the window shows. */
// The project menu's own words (T-189); project and workspace names are
// shown as they were given.
const switcherText = strings({
  menu: "Show project",
  note: "Switching changes only what this window shows.",
  all: "All projects",
  none: "No project",
  project: "Project",
  waiting: (count: number) => `${count} waiting for you`,
  open: (count: number) => `${count} open agent${count === 1 ? "" : "s"}`,
  newProject: "New project…",
  manage: "Manage projects…",
  machines: "Machines…",
  showing: (workspace: string, scope: string) => `${workspace}: showing ${scope}`,
}, {
  menu: "显示项目",
  note: "切换只改变此窗口显示的内容。",
  all: "所有项目",
  none: "无项目",
  project: "项目",
  waiting: (count) => `${count} 项等待你`,
  open: (count) => `${count} 个打开的 Agent`,
  newProject: "新建项目…",
  manage: "管理项目…",
  machines: "机器…",
  showing: (workspace, scope) => `${workspace}：显示“${scope}”`,
});

export function ProjectSwitcher({
  workspaceName,
  reachable,
  reachability,
  scope,
  projects,
  agents,
  onScope,
  onNewProject,
  onManage,
  onMachines,
  onOpenChange,
  readOnly = false,
}: {
  workspaceName: string;
  reachable: boolean;
  reachability: string;
  scope: ProjectScope;
  projects: Project[];
  agents: Agent[];
  onScope: (scope: ProjectScope) => void;
  onNewProject: () => void;
  onManage: () => void;
  onMachines?: () => void;
  onOpenChange: (open: boolean) => void;
  /** The design specimen offers scopes only; managing needs a real Core. */
  readOnly?: boolean;
}) {
  const t = useStrings(switcherText);
  const shown = scopeLabel(scope, projects, t);
  const [open, setOpenState] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const setOpen = (value: boolean) => {
    setOpenState(value);
    onOpenChange(value);
  };
  useOutsideClose(open, () => setOpen(false), root);
  useEffect(() => () => onOpenChange(false), [onOpenChange]);
  // The menu rises from the switcher and sinks back into it. It stays on
  // screen, inert, for its short way out; reduced motion closes it at once.
  // Set in the same render that closes it, so the menu is never taken off
  // the screen and put back for its way out.
  const [leaving, setLeaving] = useState(false);
  const [shownOpen, setShownOpen] = useState(open);
  if (open !== shownOpen) {
    setShownOpen(open);
    setLeaving(!open && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(false), MENU_OUT_MS + 100);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const open_ = agents.filter((agent) => !agent.closedAt);
  const count = (s: ProjectScope) =>
    open_.filter((agent) => inScope(agent, s)).length;
  const pending = (s: ProjectScope) =>
    open_
      .filter((agent) => inScope(agent, s))
      .reduce((n, agent) => n + agent.pendingCount, 0);
  const choose = (next: ProjectScope) => {
    setOpen(false);
    trigger.current?.focus();
    onScope(next);
  };
  const option = (
    value: ProjectScope,
    label: string,
    icon: React.ReactNode,
  ) => (
    <button
      key={value}
      type="button"
      role="menuitemradio"
      aria-checked={scope === value}
      className="scope-option"
      onClick={() => choose(value)}
    >
      {icon}
      <span className="scope-option-name">{label}</span>
      {pending(value) > 0 && (
        <Tip side="right" content={<TipText title={t.waiting(pending(value))} />}>
          <span className="nav-count attention">{pending(value)}</span>
        </Tip>
      )}
      <Tip side="right" content={<TipText title={t.open(count(value))} />}>
        <span className="scope-option-count">{count(value)}</span>
      </Tip>
      {scope === value && <Check size={13} className="scope-check" />}
    </button>
  );
  return (
    <div
      className="rail-bottom project-switcher"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          // Keep Escape from reaching the conversation's interrupt shortcut.
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      {(open || leaving) && (
        <div
          className={`scope-menu${open ? "" : " is-leaving"}`}
          role="menu"
          aria-label={t.menu}
          aria-hidden={open ? undefined : true}
          inert={!open}
          onAnimationEnd={(event) => {
            if (!open && event.animationName === "scope-menu-out") setLeaving(false);
          }}
        >
          <div className="scope-menu-heading">
            <span>{workspaceName}</span>
            <small>{t.note}</small>
          </div>
          {option(ALL_PROJECTS, t.all, <Layers size={14} />)}
          {activeProjects(projects).map((project) =>
            option(
              projectScope(project.id),
              project.name,
              <Folder size={14} />,
            ),
          )}
          {option(NO_PROJECT, t.none, <span className="scope-blank" />)}
          {!readOnly && (
            <div className="scope-menu-actions">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onNewProject();
                }}
              >
                <FolderPlus size={14} />
                {t.newProject}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onManage();
                }}
              >
                <Settings2 size={14} />
                {t.manage}
              </button>
              {onMachines && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onMachines();
                  }}
                >
                  <Server size={14} />
                  {t.machines}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <button
        ref={trigger}
        type="button"
        className="workspace-scope"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.showing(workspaceName, shown)}
        onClick={() => setOpen(!open)}
      >
        <span className="machine-icon">
          {scope === ALL_PROJECTS ? <Layers size={15} /> : <Folder size={15} />}
        </span>
        <span className="workspace-scope-text">
          <strong>{shown}</strong>
          <span>{workspaceName}</span>
        </span>
        <Tip side="top" describe={false} content={<TipText title={reachability} />}>
          <span className={`status-dot ${reachable ? "idle" : "offline"}`} role="img" aria-label={reachability} />
        </Tip>
        <ChevronsUpDown size={14} className="scope-chevron" />
      </button>
    </div>
  );
}

// The Projects window's own words (T-189). Project, Agent and machine names,
// folders, repository and service names, and what Core says are shown as
// they are. New Agent defaults and Code review come translated from their
// own editors.
const managerText = strings({
  title: "Projects",
  description: "Group long-running work. Agents keep collaborating across projects; each project numbers its own tasks.",
  // Settings › Projects (YN-8): the list, then a page for each.
  backTo: "Back to Projects",
  count: (active: number, archived: number) => (archived ? `${active} · ${archived} archived` : String(active)),
  rowSub: (agents: number, leads: number) =>
    `${agents} ${agents === 1 ? "Agent" : "Agents"} · ${leads} ${leads === 1 ? "lead" : "leads"}`,
  archivedRow: "Archived · its files stay where they are",
  projectIntro: (agents: number, leads: number) =>
    `${agents} ${agents === 1 ? "Agent" : "Agents"}, ${leads} of them ${leads === 1 ? "a lead" : "leads"}.`,
  unassignedRow: (count: number) => `${count} ${count === 1 ? "Agent is" : "Agents are"} in no project`,
  unassignedHelp: "Suggested by folder; nothing moves until you choose.",
  nameAndKey: "Name & task keys",
  membersTitle: "Members & leads",
  defaultsTitle: "This project’s defaults",
  archiveOrDelete: "Archive or delete",
  archiveHelp: "Archiving moves no files. Only a project with no Agents and no tasks can be deleted.",
  unarchiveHelp: "Unarchiving brings it back to the list and the rail’s project menu.",
  list: "Projects",
  without: "Without a project",
  newProject: "New project",
  archivedList: "Archived",
  gone: "This project is no longer available.",
  coreHost: "Core host",
  // New project
  newTitle: "A new project",
  newNote: "A project is where a long piece of work belongs, such as an app or a study. It can use several machines and folders.",
  name: "Name",
  folderOn: (machine: string) => `Default folder on ${machine}`,
  optional: "optional",
  folderHint: "Fills in new agents’ folder. Agents can still use any folder, such as a worktree elsewhere.",
  create: "Create project",
  // A project
  projectName: "Project name",
  nameNeeded: "A project needs a name.",
  projectKey: "Task key prefix",
  keyNote: (key: string) =>
    `Tasks in this project are numbered ${key}-1, ${key}-2 and so on; a task in no project keeps T-1. A new prefix applies to every task here at once, every key a task had still names it, and an old prefix is never given to another project. A prefix is an uppercase letter, then 1 to 9 uppercase letters or digits.`,
  archivedNote: "Archived. Its agents and tasks stay where they are and still reach you when they need you; nothing new joins it.",
  folders: "Default folders",
  foldersNote: "Fills in new agents’ folder on each machine. It does not limit which folders an agent may use, and changing it never moves existing agents.",
  machinesFailed: (error: string) => `Couldn’t load machines: ${error}`,
  noDefault: "No default",
  unarchive: "Unarchive",
  archive: "Archive project",
  stillLinked: (agents: number, tasks: number) =>
    `Still linked to ${agents} agent${agents === 1 ? "" : "s"} and ${tasks} task${tasks === 1 ? "" : "s"}; archive it instead`,
  deleteEmpty: "Delete this empty project",
  delete: "Delete",
  // Without a project
  unassignedTitle: "Agents without a project",
  unassignedNote: "Grouped by folder as a suggestion. Nothing is assigned until you choose.",
  allAssigned: "Every agent has a project.",
  newNameFor: (folder: string) => `New project name for ${folder}`,
  partlyJoined: (project: string, failed: string) =>
    `${project} was created, but not every agent joined it (${failed}). Add them to ${project} below.`,
  existingFor: (folder: string) => `Existing project for ${folder}`,
  addToExisting: "Add to an existing project…",
  addAll: (count: number) => (count > 1 ? `Add all ${count}` : "Add"),
  partlyAdded: (failed: string) => `Not every agent was added (${failed}).`,
}, {
  title: "项目",
  description: "把长期工作分组。Agent 可以跨项目协作；每个项目的任务各自编号。",
  backTo: "返回项目列表",
  count: (active, archived) => (archived ? `${active} 个 · ${archived} 个已归档` : `${active} 个`),
  rowSub: (agents, leads) => `${agents} 个 Agent · ${leads} 个负责人`,
  archivedRow: "已归档 · 文件留在原处",
  projectIntro: (agents, leads) => `${agents} 个 Agent，其中 ${leads} 个负责人。`,
  unassignedRow: (count) => `${count} 个 Agent 不属于任何项目`,
  unassignedHelp: "按文件夹给出建议；你选择之前什么都不移动。",
  nameAndKey: "名称与任务编号",
  membersTitle: "成员与负责人",
  defaultsTitle: "这个项目的默认",
  archiveOrDelete: "归档或删除",
  archiveHelp: "归档不移动文件。只有没有 Agent 和任务的项目可以删除。",
  unarchiveHelp: "取消归档后它回到项目列表和左侧的项目菜单。",
  list: "项目",
  without: "无项目",
  newProject: "新建项目",
  archivedList: "已归档",
  gone: "此项目已不存在。",
  coreHost: "Core 主机",
  newTitle: "新项目",
  newNote: "项目是一项长期工作的归属，例如一个应用或一项研究。它可以使用多台机器和多个文件夹。",
  name: "名称",
  folderOn: (machine) => `${machine} 上的默认文件夹`,
  optional: "可选",
  folderHint: "用于预填新 Agent 的文件夹。Agent 仍可使用任何文件夹，例如别处的 worktree。",
  create: "创建项目",
  projectName: "项目名称",
  nameNeeded: "项目需要一个名称。",
  projectKey: "任务编号前缀",
  keyNote: (key) =>
    `这个项目的任务编号为 ${key}-1、${key}-2 等；不属于任何项目的任务仍是 T-1 这样的编号。新前缀立即用于这里的所有任务，任务用过的每个编号仍能找到它，旧前缀也不会给其他项目。前缀以一个大写字母开头，后跟 1 到 9 个大写字母或数字。`,
  archivedNote: "已归档。它的 Agent 和任务保持原样，需要你时仍会找你；不会再有新的加入。",
  folders: "默认文件夹",
  foldersNote: "用于在每台机器上预填新 Agent 的文件夹。它不限制 Agent 可以使用哪些文件夹，更改它也不会移动现有 Agent。",
  machinesFailed: (error) => `无法加载机器：${error}`,
  noDefault: "无默认值",
  unarchive: "取消归档",
  archive: "归档项目",
  stillLinked: (agents, tasks) => `仍关联 ${agents} 个 Agent 和 ${tasks} 个任务；请改为归档`,
  deleteEmpty: "删除这个空项目",
  delete: "删除",
  unassignedTitle: "无项目的 Agent",
  unassignedNote: "按文件夹分组作为建议。在你选择之前不会分配任何项目。",
  allAssigned: "每个 Agent 都有项目。",
  newNameFor: (folder) => `${folder} 的新项目名称`,
  partlyJoined: (project, failed) => `已创建 ${project}，但并非所有 Agent 都已加入（${failed}）。请在下方把它们加入 ${project}。`,
  existingFor: (folder) => `${folder} 的现有项目`,
  addToExisting: "加入现有项目…",
  addAll: (count) => (count > 1 ? `全部添加（${count}）` : "添加"),
  partlyAdded: (failed) => `并非所有 Agent 都已添加（${failed}）。`,
});

type ManagerView =
  | { kind: "list" }
  | { kind: "project"; id: string }
  | { kind: "new" }
  | { kind: "unassigned" };

/** Settings › Projects (YN-8): the list of projects, then a page for each,
 * for a new one and for the Agents in no project. A request opens one of
 * them (`initialView`, `initialProjectId`); otherwise the list, with no
 * project chosen for you. `open` is whether Settings is open. */
export function ProjectsPage({
  open,
  onOpenChange,
  initialView,
  initialProjectId,
  projects,
  usage = {},
  agents,
  onChanged,
  onCreated,
}: {
  open: boolean;
  /** Closes Settings: a service opened in the Portal is shown beside the conversation. */
  onOpenChange: (open: boolean) => void;
  initialView: "new" | "manage";
  initialProjectId?: string | null;
  projects: Project[];
  /** Linked agents and tasks per project, as Core counts them. */
  usage?: Record<string, ProjectUsage>;
  agents: Agent[];
  onChanged: () => void;
  onCreated: (project: Project) => void;
}) {
  const t = useStrings(managerText);
  const [view, setView] = useState<ManagerView>(() =>
    initialView === "new"
      ? { kind: "new" }
      : initialProjectId && projects.some((project) => project.id === initialProjectId)
        ? { kind: "project", id: initialProjectId }
        : { kind: "list" },
  );
  const [machines, setMachines] = useState<WorkspaceMachine[]>([]);
  const [machineError, setMachineError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setMachineError("");
    api<{ machines: WorkspaceMachine[] }>("/machines", {
      signal: controller.signal,
    })
      .then((result) => setMachines(result.machines || []))
      .catch((e) => {
        if (!controller.signal.aborted) setMachineError(errorText(e));
      });
    return () => controller.abort();
  }, [open]);
  // Another view of the page starts at its top, its title focused; the first
  // keeps the focus Settings gave the page.
  useEffect(() => {
    if (!shown.current) {
      shown.current = true;
      return;
    }
    heading.current?.closest(".settings-pane")?.scrollTo?.({ top: 0 });
    heading.current?.focus();
  }, [view]);
  const unassigned = agents.filter((agent) => !agent.projectId);
  const active = activeProjects(projects);
  const archived = projects.filter((p) => !!p.archivedAt);
  const membersOf = (id: string) => agents.filter((agent) => agent.projectId === id);
  const leadsOf = (id: string) => membersOf(id).filter((agent) => agent.kind === "lead").length;
  const project =
    view.kind === "project"
      ? projects.find((candidate) => candidate.id === view.id)
      : undefined;
  const row = (p: Project, quiet = false) => (
    <li key={p.id}>
      <button
        type="button"
        className={`settings-list-row is-open${quiet ? " is-quiet" : ""}`}
        onClick={() => setView({ kind: "project", id: p.id })}
      >
        <Folder size={15} className="settings-list-icon" aria-hidden="true" />
        <span className="settings-list-main">
          <span className="settings-list-title">{p.name}</span>
          <span className="settings-list-sub">
            {quiet ? t.archivedRow : t.rowSub(membersOf(p.id).length, leadsOf(p.id))}
          </span>
        </span>
        {p.key && <span className="settings-tag is-mono">{p.key}</span>}
        <ChevronRight size={15} className="settings-list-chev" aria-hidden="true" />
      </button>
    </li>
  );
  const folders = unassignedFolders(agents);
  const title =
    view.kind === "list"
      ? t.title
      : view.kind === "new"
        ? t.newTitle
        : view.kind === "unassigned"
          ? t.unassignedTitle
          : project?.name ?? t.title;
  const intro =
    view.kind === "list"
      ? t.description
      : view.kind === "new"
        ? t.newNote
        : view.kind === "unassigned"
          ? t.unassignedNote
          : project
            ? t.projectIntro(membersOf(project.id).length, leadsOf(project.id))
            : t.gone;
  const chip =
    view.kind === "list" ? t.count(active.length, archived.length) : view.kind === "project" ? project?.key : undefined;
  return (
    <section className="settings-section settings-manager settings-projects" aria-labelledby="settings-projects-title">
      {view.kind !== "list" && (
        <button type="button" className="settings-crumb" aria-label={t.backTo} onClick={() => setView({ kind: "list" })}>
          <ChevronLeft size={14} aria-hidden="true" />
          {t.title}
        </button>
      )}
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-projects-title" ref={heading} tabIndex={-1}>{title}</h3>
          <p>{intro}</p>
        </div>
        {chip && <span className="settings-current">{chip}</span>}
      </header>
      {view.kind === "list" ? (
        <div className="settings-group appearance-group">
          <fieldset className="appearance-field">
            <legend>{t.list}</legend>
            <ul className="settings-list">
              {active.map((p) => row(p))}
              <li>
                <button type="button" className="settings-list-row is-open is-add" onClick={() => setView({ kind: "new" })}>
                  <Plus size={15} className="settings-list-icon" aria-hidden="true" />
                  <span className="settings-list-main">
                    <span className="settings-list-title">{t.newProject}</span>
                  </span>
                </button>
              </li>
            </ul>
          </fieldset>
          <fieldset className="appearance-field">
            <legend>{t.unassignedTitle}</legend>
            <p className="settings-block-help">{t.unassignedHelp}</p>
            <ul className="settings-list">
              <li>
                {unassigned.length ? (
                  <button type="button" className="settings-list-row is-open" onClick={() => setView({ kind: "unassigned" })}>
                    <FolderPlus size={15} className="settings-list-icon" aria-hidden="true" />
                    <span className="settings-list-main">
                      <span className="settings-list-title">{t.unassignedRow(unassigned.length)}</span>
                      <span className="settings-list-sub">
                        {folders.map((group) => `${group.cwd} ${group.agents.length}`).join(" · ")}
                      </span>
                    </span>
                    <ChevronRight size={15} className="settings-list-chev" aria-hidden="true" />
                  </button>
                ) : (
                  <span className="settings-list-row">
                    <span className="settings-list-main">
                      <span className="settings-list-sub">{t.allAssigned}</span>
                    </span>
                  </span>
                )}
              </li>
            </ul>
          </fieldset>
          {archived.length > 0 && (
            <fieldset className="appearance-field">
              <legend>{t.archivedList}</legend>
              <ul className="settings-list">{archived.map((p) => row(p, true))}</ul>
            </fieldset>
          )}
        </div>
      ) : view.kind === "new" ? (
        <div className="settings-group appearance-group">
          <NewProject
            key="new"
            machines={machines}
            onCreated={(created) => {
              onChanged();
              onCreated(created);
              setView({ kind: "project", id: created.id });
            }}
          />
        </div>
      ) : view.kind === "unassigned" ? (
        <div className="settings-group appearance-group">
          <Unassigned
            agents={agents}
            projects={projects}
            onChanged={onChanged}
            onCreated={(created) => {
              onChanged();
              setView({ kind: "project", id: created.id });
            }}
          />
        </div>
      ) : project ? (
        // One save bar for the page (YN-8), anew for each project.
        <SaveBarScope key={project.id}>
        <ProjectDetail
          project={project}
          projects={projects}
          tasks={usage[project.id]?.tasks || 0}
          agents={agents}
          machines={machines}
          machineError={machineError}
          onChanged={onChanged}
          onLeave={() => onOpenChange(false)}
          onDeleted={() => {
            onChanged();
            setView({ kind: "list" });
          }}
        />
        </SaveBarScope>
      ) : null}
    </section>
  );
}

function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const run = async <T,>(name: string, action: () => Promise<T>) => {
    if (busy) return null;
    setBusy(name);
    setError("");
    try {
      return await action();
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run, clear: () => setError("") };
}

function NewProject({
  machines,
  onCreated,
}: {
  machines: WorkspaceMachine[];
  onCreated: (project: Project) => void;
}) {
  const t = useStrings(managerText);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const action = useAction();
  const host = machines.find((machine) => machine.id === "local");
  return (
    <form
      className="appearance-field project-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim() || overLimit(name, coreLimits.projectName)) return;
        const created = await action.run("create", () =>
          post<Project>("/projects", {
            name: name.trim(),
            ...(folder.trim() ? { defaultDirs: { local: folder.trim() } } : {}),
          }),
        );
        if (created) onCreated(created);
      }}
    >
      <label>
        {t.name}
        <input
          autoFocus
          required
          value={name}
          aria-invalid={overLimit(name, coreLimits.projectName) || undefined}
          onChange={(event) => setName(event.target.value)}
          placeholder="my-project"
        />
      </label>
      <FieldLength value={name} limit={coreLimits.projectName} />
      <label>
        {t.folderOn(host?.name || t.coreHost)} <small>{t.optional}</small>
        <input
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          placeholder="/home/you/projects/app"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <span className="field-hint">{t.folderHint}</span>
      </label>
      {action.error && (
        <p role="alert" className="inline-error">
          {action.error}
        </p>
      )}
      <div className="modal-actions">
        <button
          className="primary-button"
          disabled={!!action.busy || !name.trim() || overLimit(name, coreLimits.projectName)}
        >
          {action.busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <FolderPlus size={15} />
          )}
          {t.create}
        </button>
      </div>
    </form>
  );
}

function ProjectDetail({
  project,
  projects,
  tasks,
  agents,
  machines,
  machineError,
  onChanged,
  onLeave,
  onDeleted,
}: {
  project: Project;
  projects: Project[];
  tasks: number;
  agents: Agent[];
  machines: WorkspaceMachine[];
  machineError: string;
  onChanged: () => void;
  /** Closes this dialog: a service opened in the Portal is shown beside the conversation, not under it. */
  onLeave: () => void;
  onDeleted: () => void;
}) {
  const t = useStrings(managerText);
  const language = useLanguage();
  const [name, setName] = useState(project.name);
  const [key, setKey] = useState(project.key ?? "");
  const nameAction = useAction();
  const keyAction = useAction();
  const folderAction = useAction();
  const action = useAction();
  const path = `/projects/${encodeURIComponent(project.id)}`;
  // What Core saved last: this page's own save, until the Workspace's
  // refresh (every few seconds) has caught up with it.
  const [fresh, setFresh] = useState<Project | null>(null);
  const base = fresh && fresh.updatedAt >= project.updatedAt ? fresh : project;
  // Unsaved folder edits per machine; only an edit that now matches what
  // Core saved is dropped.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const savedDirs = JSON.stringify(base.defaultDirs);
  useEffect(
    () =>
      setEdits((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([machine, value]) =>
              value.trim() !== (base.defaultDirs[machine] || ""),
          ),
        ),
      ),
    [savedDirs],
  );
  const members = agents.filter((agent) => agent.projectId === project.id);
  const archived = !!project.archivedAt;
  const change = async (body: Record<string, unknown>) => {
    const saved = await patch<Project>(path, body);
    setFresh(saved);
    onChanged();
    return saved;
  };
  // The name, the task prefix and the folders join the page's save bar,
  // each its own request (YN-8); Archive and Delete are done at once.
  const nextName = name.trim();
  useSaveBarPart("name", nextName !== base.name ? {
    ready: !!nextName && !overLimit(nextName, coreLimits.projectName),
    save: async () => !!(await nameAction.run("name", () => change({ name: nextName }))),
    discard: () => { nameAction.clear(); setName(base.name); },
  } : null);
  const nextKey = key.trim();
  const keyChanged = base.key !== undefined && nextKey !== base.key;
  // The rule is only a hint here; Core decides and says why not.
  const keyFits = PROJECT_KEY.test(nextKey);
  useSaveBarPart("key", keyChanged ? {
    ready: keyFits,
    save: async () => !!(await keyAction.run("key", () => change({ key: nextKey }))),
    discard: () => { keyAction.clear(); setKey(base.key ?? ""); },
  } : null);
  const folderChanges: Record<string, string | null> = Object.fromEntries(
    machines.flatMap((machine) => {
      const value = edits[machine.id];
      return value !== undefined && value.trim() !== (base.defaultDirs[machine.id] || "") ? [[machine.id, value.trim() || null]] : [];
    }),
  );
  useSaveBarPart("folders", Object.keys(folderChanges).length ? {
    save: async () => {
      const updated = await folderAction.run("folders", () => change({ defaultDirs: folderChanges }));
      // Core's canonical folders show once the edits are gone.
      if (updated) setEdits((current) => Object.fromEntries(Object.entries(current).filter(([machine]) => !(machine in folderChanges))));
      return !!updated;
    },
    discard: () => { folderAction.clear(); setEdits({}); },
  } : null);
  // Four cards, as the design has them (YN-8): the basics, members and
  // leads, this project's defaults, then archive or delete. The blocks with
  // an editor of their own are mounted as they were, one block each.
  return (
    <>
      {archived && (
        <p className="project-note project-archived-note">
          <Archive size={14} /> {t.archivedNote}
        </p>
      )}
      <div className="settings-group appearance-group">
        <fieldset className="appearance-field project-form">
          <legend>{t.nameAndKey}</legend>
          <div className="project-rename">
            <label>
              {t.projectName}
              <input
                required
                value={name}
                aria-invalid={!nextName || overLimit(nextName, coreLimits.projectName)}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <FieldLength value={nextName} limit={coreLimits.projectName} />
          </div>
          {!nextName && <p className="inline-error">{t.nameNeeded}</p>}
          {nameAction.error && (
            <p role="alert" className="inline-error">
              {nameAction.error}
            </p>
          )}
          {project.key !== undefined && (
            <>
              <div className="project-rename project-key">
                <label>
                  {t.projectKey}
                  <input
                    value={key}
                    maxLength={10}
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="characters"
                    aria-invalid={keyChanged && !keyFits}
                    onChange={(event) => setKey(event.target.value.toUpperCase())}
                  />
                </label>
              </div>
              <p className="project-note">{t.keyNote(base.key ?? project.key)}</p>
              {keyAction.error && (
                <p role="alert" className="inline-error">
                  {keyAction.error}
                </p>
              )}
            </>
          )}
        </fieldset>
        <fieldset className="appearance-field project-form">
          <legend>{t.folders}</legend>
          <p className="project-note">{t.foldersNote}</p>
          {machineError && (
            <p role="alert" className="inline-error">
              {t.machinesFailed(machineError)}
            </p>
          )}
          <div className="project-folders">
            {machines.map((machine) => {
              const saved = base.defaultDirs[machine.id] || "";
              const value = edits[machine.id] ?? saved;
              return (
                <div key={machine.id} className="project-folder-row">
                  <span className="project-machine">
                    {machine.kind === "ssh" ? (
                      <Server size={14} />
                    ) : (
                      <Monitor size={14} />
                    )}
                    {machine.name}
                  </span>
                  <input
                    aria-label={t.folderOn(machine.name)}
                    value={value}
                    placeholder={machine.defaultCwd || t.noDefault}
                    onChange={(event) =>
                      setEdits({ ...edits, [machine.id]: event.target.value })
                    }
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </div>
              );
            })}
          </div>
          {folderAction.error && (
            <p role="alert" className="inline-error">
              {folderAction.error}
            </p>
          )}
        </fieldset>
        <div className="appearance-field project-block">
          <GitHubLinks key={project.id} projectId={project.id} disabled={archived} language={language} />
        </div>
        <div className="appearance-field project-block">
          <ProjectServices key={`services:${project.id}`} projectId={project.id} machines={machines} disabled={archived} onOpened={onLeave} />
        </div>
      </div>

      <h4 className="settings-group-title">{t.membersTitle}</h4>
      <div className="settings-group appearance-group">
        <ProjectMembers key={`members:${project.id}`} project={project} agents={agents} projects={projects} disabled={archived} onChanged={onChanged} />
        <div className="appearance-field project-block">
          <ProjectHandover key={`handover:${project.id}`} projectId={project.id} disabled={archived} />
        </div>
      </div>

      <h4 className="settings-group-title">{t.defaultsTitle}</h4>
      <div className="settings-group appearance-group">
        <div className="appearance-field project-block">
          <AgentDefaults key={`defaults:${project.id}`} active projectId={project.id} disabled={archived} />
        </div>
        <div className="appearance-field project-block">
          <ReviewSettings key={`review:${project.id}`} active projectId={project.id} disabled={archived} />
        </div>
      </div>

      <div className="settings-group appearance-group">
        <fieldset className="appearance-field project-form">
          <legend>{t.archiveOrDelete}</legend>
          <p className="project-note">{archived ? t.unarchiveHelp : t.archiveHelp}</p>
          {action.error && (
            <p role="alert" className="inline-error">
              {action.error}
            </p>
          )}
          <div className="modal-actions project-lifecycle">
            <button
              type="button"
              className="secondary-button"
              disabled={!!action.busy}
              onClick={() => void action.run("archive", () => change({ archived: !archived }))}
            >
              {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              {archived ? t.unarchive : t.archive}
            </button>
            <Tip content={<TipText body={members.length || tasks ? t.stillLinked(members.length, tasks) : t.deleteEmpty} />} hold>
              <button
                type="button"
                className="danger-button"
                disabled={!!action.busy || members.length > 0 || tasks > 0}
                aria-description={members.length || tasks ? t.stillLinked(members.length, tasks) : undefined}
                onClick={() =>
                  void action.run("delete", async () => {
                    await remove(path);
                    onDeleted();
                  })
                }
              >
                <Trash2 size={14} />
                {t.delete}
              </button>
            </Tip>
          </div>
        </fieldset>
      </div>
    </>
  );
}

function Unassigned({
  agents,
  projects,
  onChanged,
  onCreated,
}: {
  agents: Agent[];
  projects: Project[];
  onChanged: () => void;
  onCreated: (project: Project) => void;
}) {
  const t = useStrings(managerText);
  const groups = unassignedFolders(agents);
  const [names, setNames] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const action = useAction();
  /** Moves each agent independently and reports the ones that failed. */
  const assign = async (group: (typeof groups)[number], projectId: string) => {
    const results = await Promise.allSettled(
      group.agents.map((agent) =>
        post(`/agents/${encodeURIComponent(agent.id)}/project`, { projectId }),
      ),
    );
    return results.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${group.agents[index].name}: ${errorText(result.reason)}`]
        : [],
    );
  };
  return (
    <div className="appearance-field project-form">
      {!groups.length && (
        <p className="project-note">{t.allAssigned}</p>
      )}
      {groups.map((group) => {
        const name = names[group.key] ?? folderName(group.cwd);
        const target = targets[group.key] ?? "";
        return (
          <div className="project-suggestion" key={group.key}>
            <div className="project-suggestion-folder">
              <Folder size={15} />
              <span>
                <Tip content={<TipText value={group.cwd} />} size="wide" cut><strong>{group.cwd}</strong></Tip>
                <small>
                  {group.machineId === "local" ? t.coreHost : group.machineName} ·{" "}
                  {group.agents.map((agent) => agent.name).join(", ")}
                </small>
              </span>
            </div>
            <form
              className="project-suggestion-row"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!name.trim() || overLimit(name, coreLimits.projectName)) return;
                const created = await action.run(
                  `create:${group.key}`,
                  async () => {
                    const project = await post<Project>("/projects", {
                      name: name.trim(),
                      defaultDirs: { [group.machineId]: group.cwd },
                    });
                    const failed = await assign(group, project.id);
                    // The project exists either way; show it and what is left.
                    onChanged();
                    if (failed.length)
                      throw new Error(t.partlyJoined(project.name, failed.join("; ")));
                    return project;
                  },
                );
                if (created) onCreated(created);
              }}
            >
              <input
                aria-label={t.newNameFor(group.cwd)}
                value={name}
                aria-invalid={overLimit(name, coreLimits.projectName) || undefined}
                onChange={(event) =>
                  setNames({ ...names, [group.key]: event.target.value })
                }
              />
              <button
                className="secondary-button"
                disabled={!!action.busy || !name.trim() || overLimit(name, coreLimits.projectName)}
              >
                <FolderPlus size={14} /> {t.create}
              </button>
            </form>
            {/* Why Create waits, as each name field says it (YN-106 R1). */}
            <FieldLength value={name} limit={coreLimits.projectName} />
            {activeProjects(projects).length > 0 && (
              <form
                className="project-suggestion-row"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!target) return;
                  await action.run(`add:${group.key}`, async () => {
                    const failed = await assign(group, target);
                    onChanged();
                    if (failed.length)
                      throw new Error(t.partlyAdded(failed.join("; ")));
                  });
                }}
              >
                <select
                  aria-label={t.existingFor(group.cwd)}
                  value={target}
                  onChange={(event) =>
                    setTargets({ ...targets, [group.key]: event.target.value })
                  }
                >
                  <option value="">{t.addToExisting}</option>
                  {activeProjects(projects).map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <button
                  className="quiet-button"
                  disabled={!!action.busy || !target}
                >
                  {t.addAll(group.agents.length)}
                </button>
              </form>
            )}
          </div>
        );
      })}
      {action.error && (
        <p role="alert" className="inline-error">
          {action.error}
        </p>
      )}
    </div>
  );
}

// The picker's own words (T-189); project and Agent names as they are.
const pickerText = strings({
  project: "Project",
  none: "No project",
  archived: " · archived",
  move: "Move",
  note: (name: string) => `Changes only where ${name} is listed. Folder and conversation stay.`,
}, {
  project: "项目",
  none: "无项目",
  archived: " · 已归档",
  move: "移动",
  note: (name) => `只改变 ${name} 列在哪里。文件夹和会话保持不变。`,
});

/** Membership is chosen explicitly from the conversation's actions dialog. */
export function AgentProjectPicker({
  agent,
  projects,
  disabled,
  onMoved,
}: {
  agent: Agent;
  projects: Project[];
  disabled: boolean;
  onMoved: (agent: Agent) => void;
}) {
  const [value, setValue] = useState(agent.projectId || "");
  const action = useAction();
  const t = useStrings(pickerText);
  useEffect(() => setValue(agent.projectId || ""), [agent.id, agent.projectId]);
  const choices = projects.filter(
    (project) => !project.archivedAt || project.id === agent.projectId,
  );
  return (
    <form
      className="agent-project-picker"
      onSubmit={async (event) => {
        event.preventDefault();
        const moved = await action.run("move", () =>
          post<Agent>(`/agents/${encodeURIComponent(agent.id)}/project`, {
            projectId: value || null,
          }),
        );
        if (moved) onMoved(moved);
      }}
    >
      <label>
        {t.project}
        <select
          value={value}
          disabled={disabled || !!action.busy}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="">{t.none}</option>
          {choices.map((project) => (
            <option
              key={project.id}
              value={project.id}
              disabled={!!project.archivedAt && project.id !== agent.projectId}
            >
              {project.name}
              {project.archivedAt ? t.archived : ""}
            </option>
          ))}
        </select>
      </label>
      <button
        className="secondary-button"
        disabled={
          disabled || !!action.busy || value === (agent.projectId || "")
        }
      >
        {action.busy ? <LoaderCircle size={14} className="spin" /> : null}
        {t.move}
      </button>
      <p>{t.note(agent.name)}</p>
      {action.error && (
        <p role="alert" className="inline-error">
          {action.error}
        </p>
      )}
    </form>
  );
}
