import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
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
  X,
} from "lucide-react";
import { api, errorText, patch, post, remove } from "./api";
import { strings, useLanguage, useStrings } from "./i18n";
import { Avatar, Modal } from "./components";
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
import "./projects.css";
import { GitHubLinks } from "./GitHubLinks";
import { ProjectServices } from "./ProjectServices";
import { AgentDefaults } from "./AgentDefaults";
import { ReviewSettings } from "./ReviewSettings";
import { HomeContentEditors } from "./home/HomeContentEditors";

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
const MENU_OUT_MS = 120;

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
        <span
          className="nav-count attention"
          title={t.waiting(pending(value))}
        >
          {pending(value)}
        </span>
      )}
      <span
        className="scope-option-count"
        title={t.open(count(value))}
      >
        {count(value)}
      </span>
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
        <span
          className={`status-dot ${reachable ? "idle" : "offline"}`}
          title={reachability}
          role="img"
          aria-label={reachability}
        />
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
  description: "Group long-running work. Agents keep collaborating across projects, and task numbers stay shared.",
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
  rename: "Rename",
  archivedNote: "Archived. Its agents and tasks stay where they are and still reach you when they need you; nothing new joins it.",
  folders: "Default folders",
  foldersNote: "Fills in new agents’ folder on each machine. It does not limit which folders an agent may use, and changing it never moves existing agents.",
  machinesFailed: (error: string) => `Couldn’t load machines: ${error}`,
  noDefault: "No default",
  save: "Save",
  clear: "Clear",
  agents: "Agents",
  closedSuffix: " · closed",
  removeFrom: (agent: string, project: string) => `Remove ${agent} from ${project}`,
  removeTip: "Remove from project",
  noAgents: "No agents yet.",
  agentToAdd: "Agent to add",
  addAgent: "Add an agent…",
  fromProject: (project: string) => ` · from ${project}`,
  add: "Add",
  moveNote: "Moving an agent changes only where it is listed. Its folder, conversation and read state stay the same.",
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
  description: "把长期工作分组。Agent 可以跨项目协作，任务编号仍共用。",
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
  rename: "重命名",
  archivedNote: "已归档。它的 Agent 和任务保持原样，需要你时仍会找你；不会再有新的加入。",
  folders: "默认文件夹",
  foldersNote: "用于在每台机器上预填新 Agent 的文件夹。它不限制 Agent 可以使用哪些文件夹，更改它也不会移动现有 Agent。",
  machinesFailed: (error) => `无法加载机器：${error}`,
  noDefault: "无默认值",
  save: "保存",
  clear: "清除",
  agents: "Agent",
  closedSuffix: " · 已关闭",
  removeFrom: (agent, project) => `将 ${agent} 移出 ${project}`,
  removeTip: "移出项目",
  noAgents: "还没有 Agent。",
  agentToAdd: "要添加的 Agent",
  addAgent: "添加 Agent…",
  fromProject: (project) => ` · 来自 ${project}`,
  add: "添加",
  moveNote: "移动 Agent 只改变它列在哪里。它的文件夹、会话和已读状态保持不变。",
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
  | { kind: "project"; id: string }
  | { kind: "new" }
  | { kind: "unassigned" };

export function ProjectManager({
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
  const [view, setView] = useState<ManagerView>({ kind: "new" });
  const [machines, setMachines] = useState<WorkspaceMachine[]>([]);
  const [machineError, setMachineError] = useState("");
  const unassigned = agents.filter((agent) => !agent.projectId);
  useEffect(() => {
    if (!open) return;
    const first = activeProjects(projects).find((project) => project.id === initialProjectId) || activeProjects(projects)[0];
    setView(
      initialView === "new"
        ? { kind: "new" }
        : first
          ? { kind: "project", id: first.id }
          : unassigned.length
            ? { kind: "unassigned" }
            : { kind: "new" },
    );
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
  const project =
    view.kind === "project"
      ? projects.find((candidate) => candidate.id === view.id)
      : undefined;
  const listItem = (p: Project) => (
    <button
      key={p.id}
      type="button"
      className={`project-list-item ${project?.id === p.id ? "selected" : ""}`}
      aria-current={project?.id === p.id ? "true" : undefined}
      onClick={() => setView({ kind: "project", id: p.id })}
    >
      <Folder size={14} />
      <span>{p.name}</span>
      <small>{agents.filter((agent) => agent.projectId === p.id).length}</small>
    </button>
  );
  const archived = projects.filter((p) => !!p.archivedAt);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={t.title}
      description={t.description}
    >
      <div className="project-manager">
        <nav className="project-list" aria-label={t.list}>
          {activeProjects(projects).map(listItem)}
          <button
            type="button"
            className={`project-list-item ${view.kind === "unassigned" ? "selected" : ""}`}
            onClick={() => setView({ kind: "unassigned" })}
          >
            <span className="scope-blank" />
            <span>{t.without}</span>
            <small>{unassigned.length}</small>
          </button>
          <button
            type="button"
            className="quiet-button project-new"
            onClick={() => setView({ kind: "new" })}
          >
            <Plus size={14} /> {t.newProject}
          </button>
          {archived.length > 0 && (
            <div className="project-archived-list">
              <span>{t.archivedList}</span>
              {archived.map(listItem)}
            </div>
          )}
        </nav>
        <section className="project-pane">
          {view.kind === "new" ? (
            <NewProject
              key="new"
              machines={machines}
              onCreated={(created) => {
                onChanged();
                onCreated(created);
                setView({ kind: "project", id: created.id });
              }}
            />
          ) : view.kind === "unassigned" ? (
            <Unassigned
              agents={agents}
              projects={projects}
              onChanged={onChanged}
              onCreated={(created) => {
                onChanged();
                setView({ kind: "project", id: created.id });
              }}
            />
          ) : project ? (
            <ProjectDetail
              key={project.id}
              project={project}
              projects={projects}
              tasks={usage[project.id]?.tasks || 0}
              agents={agents}
              machines={machines}
              machineError={machineError}
              onChanged={onChanged}
              onDeleted={() => {
                onChanged();
                setView({ kind: "new" });
              }}
            />
          ) : (
            <p className="project-note">{t.gone}</p>
          )}
        </section>
      </div>
    </Modal>
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
  return { busy, error, run };
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
      className="project-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim()) return;
        const created = await action.run("create", () =>
          post<Project>("/projects", {
            name: name.trim(),
            ...(folder.trim() ? { defaultDirs: { local: folder.trim() } } : {}),
          }),
        );
        if (created) onCreated(created);
      }}
    >
      <h3>{t.newTitle}</h3>
      <p className="project-note">{t.newNote}</p>
      <label>
        {t.name}
        <input
          autoFocus
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="my-project"
        />
      </label>
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
          disabled={!!action.busy || !name.trim()}
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
  onDeleted,
}: {
  project: Project;
  projects: Project[];
  tasks: number;
  agents: Agent[];
  machines: WorkspaceMachine[];
  machineError: string;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const t = useStrings(managerText);
  const language = useLanguage();
  const [name, setName] = useState(project.name);
  // Unsaved folder edits per machine. The workspace refreshes every few
  // seconds; only an edit that now matches what Core saved is dropped.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const savedDirs = JSON.stringify(project.defaultDirs);
  useEffect(
    () =>
      setEdits((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([machine, value]) =>
              value.trim() !== (project.defaultDirs[machine] || ""),
          ),
        ),
      ),
    [savedDirs],
  );
  const [adding, setAdding] = useState("");
  const action = useAction();
  const members = agents.filter((agent) => agent.projectId === project.id);
  const others = agents.filter((agent) => agent.projectId !== project.id);
  const archived = !!project.archivedAt;
  const path = `/projects/${encodeURIComponent(project.id)}`;
  const save = (label: string, body: Record<string, unknown>) =>
    action.run(label, async () => {
      const saved = await patch<Project>(path, body);
      onChanged();
      return saved;
    });
  const move = (agent: Agent, projectId: string | null) =>
    action.run(`agent:${agent.id}`, async () => {
      await post(`/agents/${encodeURIComponent(agent.id)}/project`, {
        projectId,
      });
      onChanged();
    });
  return (
    <div className="project-form">
      <form
        className="project-rename"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && name.trim() !== project.name)
            void save("name", { name: name.trim() });
        }}
      >
        <label>
          {t.projectName}
          <input
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button
          className="secondary-button"
          disabled={
            !!action.busy || !name.trim() || name.trim() === project.name
          }
        >
          {t.rename}
        </button>
      </form>
      <GitHubLinks key={project.id} projectId={project.id} disabled={archived} language={language} />
      <ProjectServices key={`services:${project.id}`} projectId={project.id} machines={machines} disabled={archived} />
      <HomeContentEditors key={`editors:${project.id}`} projectId={project.id} agents={members} disabled={archived} onChanged={onChanged} />
      <AgentDefaults key={`defaults:${project.id}`} active projectId={project.id} disabled={archived} />
      <ReviewSettings key={`review:${project.id}`} active projectId={project.id} disabled={archived} />
      {archived && (
        <p className="project-note project-archived-note">
          <Archive size={14} /> {t.archivedNote}
        </p>
      )}

      <h3>{t.folders}</h3>
      <p className="project-note">{t.foldersNote}</p>
      {machineError && (
        <p role="alert" className="inline-error">
          {t.machinesFailed(machineError)}
        </p>
      )}
      <div className="project-folders">
        {machines.map((machine) => {
          const saved = project.defaultDirs[machine.id] || "";
          const value = edits[machine.id] ?? saved;
          return (
            <form
              key={machine.id}
              className="project-folder-row"
              onSubmit={(event) => {
                event.preventDefault();
                void save(`folder:${machine.id}`, {
                  defaultDirs: { [machine.id]: value.trim() || null },
                }).then((updated) => {
                  // Show Core's canonical folder until the refresh arrives.
                  if (updated)
                    setEdits((current) => ({
                      ...current,
                      [machine.id]: updated.defaultDirs[machine.id] || "",
                    }));
                });
              }}
            >
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
              <button
                className="quiet-button"
                disabled={!!action.busy || value.trim() === saved}
              >
                {action.busy === `folder:${machine.id}` ? (
                  <LoaderCircle size={13} className="spin" />
                ) : value.trim() || !saved ? (
                  t.save
                ) : (
                  t.clear
                )}
              </button>
            </form>
          );
        })}
      </div>

      <h3>
        {t.agents} <span className="project-count">{members.length}</span>
      </h3>
      {members.length ? (
        <ul className="project-members">
          {members.map((agent) => (
            <li key={agent.id}>
              <Avatar agent={agent} small />
              <span className="project-member-text">
                <strong>
                  {agent.name}
                  {agent.closedAt ? t.closedSuffix : ""}
                </strong>
                <small title={agent.cwd}>
                  {agent.remote?.machine.name || t.coreHost} · {agent.cwd}
                </small>
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={t.removeFrom(agent.name, project.name)}
                title={t.removeTip}
                disabled={!!action.busy}
                onClick={() => void move(agent, null)}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="project-note">{t.noAgents}</p>
      )}
      {!archived && others.length > 0 && (
        <form
          className="project-add-agent"
          onSubmit={(event) => {
            event.preventDefault();
            const agent = others.find((candidate) => candidate.id === adding);
            if (agent) void move(agent, project.id).then(() => setAdding(""));
          }}
        >
          <select
            aria-label={t.agentToAdd}
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
          >
            <option value="">{t.addAgent}</option>
            {others.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
                {agent.projectId
                  ? t.fromProject(projectName(agent.projectId, projects))
                  : ""}
                {agent.closedAt ? t.closedSuffix : ""}
              </option>
            ))}
          </select>
          <button
            className="secondary-button"
            disabled={!adding || !!action.busy}
          >
            {t.add}
          </button>
        </form>
      )}
      <p className="project-note">{t.moveNote}</p>

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
          onClick={() => void save("archive", { archived: !archived })}
        >
          {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          {archived ? t.unarchive : t.archive}
        </button>
        <button
          type="button"
          className="danger-button"
          disabled={!!action.busy || members.length > 0 || tasks > 0}
          title={
            members.length || tasks
              ? t.stillLinked(members.length, tasks)
              : t.deleteEmpty
          }
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
      </div>
    </div>
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
    <div className="project-form">
      <h3>{t.unassignedTitle}</h3>
      <p className="project-note">{t.unassignedNote}</p>
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
                <strong title={group.cwd}>{group.cwd}</strong>
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
                maxLength={100}
                onChange={(event) =>
                  setNames({ ...names, [group.key]: event.target.value })
                }
              />
              <button
                className="secondary-button"
                disabled={!!action.busy || !name.trim()}
              >
                <FolderPlus size={14} /> {t.create}
              </button>
            </form>
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
        Project
        <select
          value={value}
          disabled={disabled || !!action.busy}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="">No project</option>
          {choices.map((project) => (
            <option
              key={project.id}
              value={project.id}
              disabled={!!project.archivedAt && project.id !== agent.projectId}
            >
              {project.name}
              {project.archivedAt ? " · archived" : ""}
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
        Move
      </button>
      <p>
        Changes only where {agent.name} is listed. Folder and conversation stay.
      </p>
      {action.error && (
        <p role="alert" className="inline-error">
          {action.error}
        </p>
      )}
    </form>
  );
}
