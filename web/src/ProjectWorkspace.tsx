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
          title={`${pending(value)} waiting for you`}
        >
          {pending(value)}
        </span>
      )}
      <span
        className="scope-option-count"
        title={`${count(value)} open agent${count(value) === 1 ? "" : "s"}`}
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
          aria-label="Show project"
          aria-hidden={open ? undefined : true}
          inert={!open}
          onAnimationEnd={(event) => {
            if (!open && event.animationName === "scope-menu-out") setLeaving(false);
          }}
        >
          <div className="scope-menu-heading">
            <span>{workspaceName}</span>
            <small>Switching changes only what this window shows.</small>
          </div>
          {option(ALL_PROJECTS, "All projects", <Layers size={14} />)}
          {activeProjects(projects).map((project) =>
            option(
              projectScope(project.id),
              project.name,
              <Folder size={14} />,
            ),
          )}
          {option(NO_PROJECT, "No project", <span className="scope-blank" />)}
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
                New project…
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
                Manage projects…
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
                  Machines…
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
        aria-label={`${workspaceName}: showing ${scopeLabel(scope, projects)}`}
        onClick={() => setOpen(!open)}
      >
        <span className="machine-icon">
          {scope === ALL_PROJECTS ? <Layers size={15} /> : <Folder size={15} />}
        </span>
        <span className="workspace-scope-text">
          <strong>{scopeLabel(scope, projects)}</strong>
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
      title="Projects"
      description="Group long-running work. Agents keep collaborating across projects, and task numbers stay shared."
    >
      <div className="project-manager">
        <nav className="project-list" aria-label="Projects">
          {activeProjects(projects).map(listItem)}
          <button
            type="button"
            className={`project-list-item ${view.kind === "unassigned" ? "selected" : ""}`}
            onClick={() => setView({ kind: "unassigned" })}
          >
            <span className="scope-blank" />
            <span>Without a project</span>
            <small>{unassigned.length}</small>
          </button>
          <button
            type="button"
            className="quiet-button project-new"
            onClick={() => setView({ kind: "new" })}
          >
            <Plus size={14} /> New project
          </button>
          {archived.length > 0 && (
            <div className="project-archived-list">
              <span>Archived</span>
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
            <p className="project-note">This project is no longer available.</p>
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
      <h3>A new project</h3>
      <p className="project-note">
        A project is where a long piece of work belongs, such as an app or a
        study. It can use several machines and folders.
      </p>
      <label>
        Name
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
        Default folder on {host?.name || "Core host"} <small>optional</small>
        <input
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          placeholder="/home/you/projects/app"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <span className="field-hint">
          Fills in new agents’ folder. Agents can still use any folder, such as
          a worktree elsewhere.
        </span>
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
          Create project
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
          Project name
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
          Rename
        </button>
      </form>
      <GitHubLinks key={project.id} projectId={project.id} disabled={archived} />
      <ProjectServices key={`services:${project.id}`} projectId={project.id} machines={machines} disabled={archived} />
      <HomeContentEditors key={`editors:${project.id}`} projectId={project.id} agents={members} disabled={archived} onChanged={onChanged} />
      <AgentDefaults key={`defaults:${project.id}`} active projectId={project.id} disabled={archived} />
      {archived && (
        <p className="project-note project-archived-note">
          <Archive size={14} /> Archived. Its agents and tasks stay where they
          are and still reach you when they need you; nothing new joins it.
        </p>
      )}

      <h3>Default folders</h3>
      <p className="project-note">
        Fills in new agents’ folder on each machine. It does not limit which
        folders an agent may use, and changing it never moves existing agents.
      </p>
      {machineError && (
        <p role="alert" className="inline-error">
          Couldn’t load machines: {machineError}
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
                aria-label={`Default folder on ${machine.name}`}
                value={value}
                placeholder={machine.defaultCwd || "No default"}
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
                  "Save"
                ) : (
                  "Clear"
                )}
              </button>
            </form>
          );
        })}
      </div>

      <h3>
        Agents <span className="project-count">{members.length}</span>
      </h3>
      {members.length ? (
        <ul className="project-members">
          {members.map((agent) => (
            <li key={agent.id}>
              <Avatar agent={agent} small />
              <span className="project-member-text">
                <strong>
                  {agent.name}
                  {agent.closedAt ? " · closed" : ""}
                </strong>
                <small title={agent.cwd}>
                  {agent.remote?.machine.name || "Core host"} · {agent.cwd}
                </small>
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${agent.name} from ${project.name}`}
                title="Remove from project"
                disabled={!!action.busy}
                onClick={() => void move(agent, null)}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="project-note">No agents yet.</p>
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
            aria-label="Agent to add"
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
          >
            <option value="">Add an agent…</option>
            {others.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
                {agent.projectId
                  ? ` · from ${projectName(agent.projectId, projects)}`
                  : ""}
                {agent.closedAt ? " · closed" : ""}
              </option>
            ))}
          </select>
          <button
            className="secondary-button"
            disabled={!adding || !!action.busy}
          >
            Add
          </button>
        </form>
      )}
      <p className="project-note">
        Moving an agent changes only where it is listed. Its folder,
        conversation and read state stay the same.
      </p>

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
          {archived ? "Unarchive" : "Archive project"}
        </button>
        <button
          type="button"
          className="danger-button"
          disabled={!!action.busy || members.length > 0 || tasks > 0}
          title={
            members.length || tasks
              ? `Still linked to ${members.length} agent${members.length === 1 ? "" : "s"} and ${tasks} task${tasks === 1 ? "" : "s"}; archive it instead`
              : "Delete this empty project"
          }
          onClick={() =>
            void action.run("delete", async () => {
              await remove(path);
              onDeleted();
            })
          }
        >
          <Trash2 size={14} />
          Delete
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
      <h3>Agents without a project</h3>
      <p className="project-note">
        Grouped by folder as a suggestion. Nothing is assigned until you choose.
      </p>
      {!groups.length && (
        <p className="project-note">Every agent has a project.</p>
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
                  {group.machineName} ·{" "}
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
                      throw new Error(
                        `${project.name} was created, but not every agent joined it (${failed.join("; ")}). Add them to ${project.name} below.`,
                      );
                    return project;
                  },
                );
                if (created) onCreated(created);
              }}
            >
              <input
                aria-label={`New project name for ${group.cwd}`}
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
                <FolderPlus size={14} /> Create project
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
                      throw new Error(
                        `Not every agent was added (${failed.join("; ")}).`,
                      );
                  });
                }}
              >
                <select
                  aria-label={`Existing project for ${group.cwd}`}
                  value={target}
                  onChange={(event) =>
                    setTargets({ ...targets, [group.key]: event.target.value })
                  }
                >
                  <option value="">Add to an existing project…</option>
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
                  Add{" "}
                  {group.agents.length > 1 ? `all ${group.agents.length}` : ""}
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
