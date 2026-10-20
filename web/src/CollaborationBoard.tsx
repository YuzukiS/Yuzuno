import { DeliveryFlow, type DeliveryCandidate } from "./DeliveryFlow";
import { openJobs } from "./Jobs";
import { SendToAgentButton } from "./SendToAgent";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CircleAlert,
  History,
  ClipboardList,
  Inbox,
  Leaf,
  LoaderCircle,
  MessageCircle,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  X,
} from "lucide-react";
import { api, errorText, post } from "./api";
import { Avatar, Modal, Prose } from "./components";
import type { Agent, Project } from "./types";
import {
  ALL_PROJECTS,
  NO_PROJECT,
  activeProjects,
  inScope,
  projectName,
  projectScope,
  scopeProjectId,
  type ProjectScope,
} from "./projects";
import "./collaboration.css";
import { GitHubLinks, GitHubSummary, type GitHubLink } from "./GitHubLinks";
import { relative } from "./home/format";

type TaskStatus =
  | "todo"
  | "doing"
  | "blocked"
  | "review"
  | "done"
  | "cancelled";
type ResultStatus = "review" | "done";
const statuses: Record<TaskStatus, string> = {
  todo: "To do",
  doing: "In progress",
  blocked: "Blocked",
  review: "To review",
  done: "Done",
  cancelled: "Cancelled",
};
type Person = { kind: "user" | "agent" | "system"; id: string; name: string };
type ExecutionSource = {
  agentId: string;
  turnId?: string | null;
  sessionId?: string | null;
};
type ResultLink = { label: string; url: string };
export interface SharedTask {
  github?: GitHubLink[];
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assigneeAgentId?: string | null;
  assignee?: Person | null;
  progress?: string | null;
  blocker?: string | null;
  result?: {
    summary: string;
    links: ResultLink[];
    reportedAt?: string;
    reportedBy?: Person;
    source?: ExecutionSource | null;
  } | null;
  archivedAt?: string | null;
  /** Project membership; null or absent means no project. */
  projectId?: string | null;
  version: number;
  createdAt: string;
  createdBy: Person;
  updatedAt: string;
  updatedBy: Person;
}
interface Activity {
  seq: number;
  taskId: string;
  kind: "created" | "updated" | "claimed" | "comment" | "result" | "dispatched";
  body?: string;
  actor: Person;
  at: string;
  source?: ExecutionSource | null;
  changes?: Record<string, unknown>;
}
interface PeerMessage {
  id: string;
  seq: number;
  priority?: "normal" | "urgent";
  body: string;
  sender: Person;
  recipient: Person;
  taskId?: string | null;
  replyTo?: string | null;
  threadId: string;
  createdAt: string;
  firstReadAt?: string | null;
  delivery: { state: string; detail?: Record<string, unknown> | null };
  source?: ExecutionSource | null;
  /** Set by Core on a review's result mail. */
  reviewId?: string | null;
}
interface TaskPage {
  tasks: SharedTask[];
  nextAfterSeq?: number | null;
  hasMore: boolean;
  counts?: Record<TaskStatus, number>;
  /** Pages loaded under the current conditions (client only). */
  pages?: number;
}
interface TaskDetail {
  task: SharedTask;
  activities: Activity[];
  nextAfterSeq?: number | null;
  hasMore: boolean;
  executions: ExecutionSource[];
}
interface MessagePage {
  messages: PeerMessage[];
  nextAfterSeq?: number | null;
  hasMore: boolean;
}
interface TaskDraft {
  title: string;
  description: string;
  status: TaskStatus;
  assigneeAgentId: string;
  progress: string;
  blocker: string;
  projectId: string;
}

const emptyTask: TaskDraft = {
  title: "",
  description: "",
  status: "todo",
  assigneeAgentId: "",
  progress: "",
  blocker: "",
  projectId: "",
};
const taskDraft = (task: SharedTask): TaskDraft => ({
  title: task.title,
  description: task.description || "",
  status: task.status,
  assigneeAgentId: task.assigneeAgentId || "",
  progress: task.progress || "",
  blocker: task.blocker || "",
  projectId: task.projectId || "",
});
const actorName = (actor?: Person | null) =>
  actor?.name || (actor?.kind === "user" ? "You" : "Agent");
const activeAgents = (agents: Agent[]) =>
  agents.filter((agent) => !agent.closedAt);
const timeLabel = (value?: string) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

/** Only changed fields cross the wire. Comments never participate in this version check. */
export function taskPatch(task: SharedTask, draft: TaskDraft) {
  const before = taskDraft(task);
  const patch: Record<string, string | null> = {};
  for (const key of Object.keys(before) as (keyof TaskDraft)[]) {
    const value = draft[key].trim();
    if (value !== before[key])
      patch[key] =
        (key === "assigneeAgentId" || key === "projectId") && !value
          ? null
          : value;
  }
  return patch;
}
export function safeCollaborationLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
/** The first paragraph of Markdown text, as one plain line. */
export function plainLine(text: string) {
  const first = text.split(/\n\s*\n/).map((part) => part.trim()).find(Boolean) || "";
  return first
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
/**
 * One line on where a task stands, from the field that describes its current
 * state: a blocked task's reason, a reviewed or finished task's result, work
 * in progress's latest progress, otherwise what the task is. An earlier
 * round's result never stands in for current progress.
 */
export function taskLine(task: SharedTask) {
  const text =
    task.status === "blocked"
      ? task.blocker || task.progress || task.description
      : task.status === "review" || task.status === "done"
        ? task.result?.summary || task.progress || task.description
        : task.status === "doing"
          ? task.progress || task.description
          : task.description;
  return plainLine(text || "");
}
const emptyLine: Record<TaskStatus, string> = {
  todo: "No description yet",
  doing: "No progress reported yet",
  blocked: "No reason given yet",
  review: "No result yet",
  done: "No result recorded",
  cancelled: "No description",
};
/** A task's result is the current one while it waits for review or is done. */
export const currentResult = (task: SharedTask) =>
  !!task.result && (task.status === "review" || task.status === "done");
const GROUP_ORDER: TaskStatus[] = ["review", "blocked", "doing", "todo", "done", "cancelled"];
/** The list's groups: what waits on someone first, each most recently changed first. */
export function groupTasks(tasks: SharedTask[]) {
  const changed = (task: SharedTask) => Date.parse(task.updatedAt) || 0;
  return GROUP_ORDER.map((status) => ({
    status,
    tasks: tasks
      .filter((task) => task.status === status)
      .sort((a, b) => changed(b) - changed(a)),
  })).filter((group) => group.tasks.length);
}
/** How long the list takes to narrow or widen beside the detail (the CSS
 * grid transition). Leaving ends when that transition does; this much
 * longer is only a fallback for when it reports no end. */
const DETAIL_MOVE_MS = 260;
/** A task's row in the list; ids are compared, never put into a selector. */
const taskRow = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".collab-task-card")].find((row) => row.dataset.taskId === id);
const DETAIL_LEAVE_FALLBACK_MS = 600;
const quickClose = () =>
  !!window.matchMedia?.("(prefers-reduced-motion: reduce), (max-width: 850px)")
    .matches;
function call<T>(operation: string, body: unknown, signal?: AbortSignal) {
  return api<T>(`/collaboration/${operation}`, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
}

/** Keep one request ID after a lost answer; a changed intention gets a new ID. */
function useMutation() {
  const requests = useRef(
    new Map<string, { fingerprint: string; id: string }>(),
  );
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const execute = async <T,>(
    operation: string,
    body: Record<string, unknown>,
  ): Promise<T | null> => {
    if (busy.current) return null;
    const fingerprint = JSON.stringify(body);
    let request = requests.current.get(operation);
    if (!request || request.fingerprint !== fingerprint) {
      request = { fingerprint, id: crypto.randomUUID() };
      requests.current.set(operation, request);
    }
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const answer = await post<T>(`/collaboration/${operation}`, {
        ...body,
        requestId: request.id,
      });
      requests.current.delete(operation);
      return answer;
    } catch (error) {
      setError(errorText(error));
      return null;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return { execute, pending, error, clearError: () => setError("") };
}

function Status({ status }: { status: TaskStatus }) {
  return (
    <span className={`collab-status status-${status}`}>
      <span />
      {statuses[status] || status}
    </span>
  );
}
function MutationForm({
  pending,
  children,
  ...props
}: React.ComponentProps<"form"> & { pending: boolean }) {
  return (
    <form {...props} aria-busy={pending}>
      <fieldset className="collab-form-fields" disabled={pending}>
        {children}
      </fieldset>
    </form>
  );
}
function ErrorNote({ text }: { text: string }) {
  return text ? (
    <div className="collab-error" role="alert">
      <CircleAlert size={16} />
      <span>{text}</span>
    </div>
  ) : null;
}
function PersonSelect({
  value,
  onChange,
  agents,
  label,
  empty = "Unassigned",
  disabled = false,
}: {
  value: string;
  onChange: (id: string) => void;
  agents: Agent[];
  label: string;
  empty?: string;
  disabled?: boolean;
}) {
  return (
    <label className="collab-field">
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{empty}</option>
        {value && !activeAgents(agents).some((agent) => agent.id === value) && (
          <option value={value}>
            {agents.find((agent) => agent.id === value)?.name ||
              "Previous agent"}{" "}
            · unavailable
          </option>
        )}
        {activeAgents(agents).map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
            {agent.remote ? ` · ${agent.remote.machine.name}` : ""}
            {agent.status === "offline" ? " · offline" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/** "" means no project. Archived projects stay visible only when already chosen. */
function ProjectSelect({
  value,
  onChange,
  projects,
  label = "Project",
}: {
  value: string;
  onChange: (id: string) => void;
  projects: Project[];
  label?: string;
}) {
  const current = projects.find((project) => project.id === value);
  return (
    <label className="collab-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">No project</option>
        {current?.archivedAt && (
          <option value={current.id}>{current.name} · archived</option>
        )}
        {activeProjects(projects).map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}
const projectFilterInput = (filter: ProjectScope) =>
  filter === ALL_PROJECTS
    ? {}
    : { projectId: filter === NO_PROJECT ? null : scopeProjectId(filter) };
const OPEN_STATUSES: TaskStatus[] = ["todo", "doing", "blocked", "review"];
/** One set of conditions for the list, its counts and every page, all applied by Core. */
function listConditions(status: string, owner: string, project: ProjectScope) {
  return {
    ...(status === "active"
      ? { statuses: OPEN_STATUSES }
      : status === "all"
        ? {}
        : { status }),
    ...(owner ? { assigneeAgentId: owner } : {}),
    ...projectFilterInput(project),
  };
}
/** Core's conditions, used only to keep loaded pages in step after a save. */
function matchesConditions(
  task: SharedTask,
  status: string,
  owner: string,
  project: ProjectScope,
) {
  if (task.archivedAt || !inScope(task, project)) return false;
  if (owner && task.assigneeAgentId !== owner) return false;
  if (status === "active") return OPEN_STATUSES.includes(task.status);
  return status === "all" || task.status === status;
}

export function CollaborationBoard({
  open,
  onOpenChange,
  agents,
  onOpenAgent,
  disabled = false,
  revision: workspaceRevision = 0,
  projects = [],
  scope = ALL_PROJECTS,
  focus = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  initialAgentId?: string;
  onOpenAgent: (id: string, turnId?: string) => void;
  disabled?: boolean;
  revision?: number;
  projects?: Project[];
  /** The window's project; the board starts there each time it opens. */
  scope?: ProjectScope;
  /** A link to one task, optionally to one of its reviews. */
  focus?: { taskId: string; reviewId?: string; at: number } | null;
}) {
  const [tab, setTab] = useState<"tasks" | "messages">("tasks");
  const [page, setPage] = useState<TaskPage | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The detail slides in beside the list, and out again before it unmounts;
  // moving to another task only fades its content in.
  const [leaving, setLeaving] = useState(false);
  const [entry, setEntry] = useState<"open" | "switch">("open");
  const leaveTimer = useRef<number | undefined>(undefined);
  const finishLeave = useRef<(() => void) | null>(null);
  const detailOpen = (selected !== null || creating) && !leaving;
  const stay = () => {
    window.clearTimeout(leaveTimer.current);
    finishLeave.current = null;
    setLeaving(false);
  };
  /** The task whose card had focus when it was opened. */
  const followFocus = useRef<string | null>(null);
  const showTask = (id: string) => {
    followFocus.current = document.activeElement === taskRow(id) ? id : null;
    setEntry(detailOpen ? "switch" : "open");
    stay();
    setCreating(false);
    setSelected(id);
  };
  /** Focus returns to the row the detail was opened from (or New task). */
  const returnFocus = (id: string | null) =>
    window.requestAnimationFrame(() => {
      const target = id ? taskRow(id) : document.querySelector<HTMLElement>(".collab-new");
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: "nearest" });
    });
  const closeDetail = () => {
    window.clearTimeout(leaveTimer.current);
    followFocus.current = null;
    const from = creating ? null : selected;
    const done = () => {
      window.clearTimeout(leaveTimer.current);
      finishLeave.current = null;
      setLeaving(false);
      setSelected(null);
      setCreating(false);
      returnFocus(from);
    };
    if (quickClose()) return done();
    setLeaving(true);
    finishLeave.current = done;
    leaveTimer.current = window.setTimeout(done, DETAIL_LEAVE_FALLBACK_MS);
  };
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  // A card opened from becomes its row: focus follows it there. (The dialog
  // takes focus when the card goes, so where focus is now cannot tell.)
  useEffect(() => {
    if (!selected || leaving || followFocus.current !== selected) return;
    const frame = window.requestAnimationFrame(() => {
      followFocus.current = null;
      taskRow(selected)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selected, leaving]);
  // The narrower list reflows; the open task's row stays in view.
  useEffect(() => {
    if (!selected || leaving) return;
    const timer = window.setTimeout(() => {
      taskRow(selected)?.scrollIntoView?.({ block: "nearest" });
    }, DETAIL_MOVE_MS + 60);
    return () => window.clearTimeout(timer);
  }, [selected, leaving]);
  const [status, setStatus] = useState("active");
  const [owner, setOwner] = useState("");
  const [projectFilter, setProjectFilter] = useState<ProjectScope>(scope);
  useEffect(() => {
    if (open) setProjectFilter(scope);
  }, [open, scope]);
  const [reviewFocus, setReviewFocus] = useState<{
    taskId: string;
    reviewId?: string;
  } | null>(null);
  useEffect(() => {
    if (!focus) return;
    setEntry("open");
    stay();
    setSelected(focus.taskId);
    setReviewFocus(focus);
    setCreating(false);
    setTab("tasks");
  }, [focus]);
  useEffect(() => {
    if (!open) setReviewFocus(null);
  }, [open]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  // Later pages are never replaced behind the user's back; they are told.
  const [outdated, setOutdated] = useState(false);
  const conditions = JSON.stringify(
    listConditions(status, owner, projectFilter),
  );
  const taskLoad = useRef<{ generation: number; controller?: AbortController }>(
    { generation: 0 },
  );
  const pageRef = useRef(page);
  pageRef.current = page;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const loadTasks = useCallback(
    async (afterSeq?: number) => {
      // A newer request (other conditions, or a reload) supersedes this one:
      // its response, error and completion are all ignored.
      taskLoad.current.controller?.abort();
      const controller = new AbortController();
      const generation = ++taskLoad.current.generation;
      taskLoad.current.controller = controller;
      setLoading(true);
      setError("");
      try {
        const next = await call<TaskPage>(
          "task_list",
          {
            ...JSON.parse(conditions),
            ...(afterSeq === undefined ? {} : { afterSeq }),
            limit: 100,
          },
          controller.signal,
        );
        if (generation !== taskLoad.current.generation) return;
        setPage((previous) =>
          afterSeq === undefined || !previous
            ? { ...next, pages: 1 }
            : {
                ...next,
                pages: (previous.pages || 1) + 1,
                tasks: [
                  ...previous.tasks,
                  ...next.tasks.filter(
                    (task) => !previous.tasks.some((old) => old.id === task.id),
                  ),
                ],
              },
        );
        if (afterSeq === undefined) setOutdated(false);
      } catch (error) {
        if (generation === taskLoad.current.generation)
          setError(errorText(error));
      } finally {
        if (generation === taskLoad.current.generation) setLoading(false);
      }
    },
    [conditions],
  );
  useEffect(() => {
    // New conditions start from nothing: no page from older conditions shows.
    setPage(null);
    setOutdated(false);
    if (open && tab === "tasks" && !disabled) void loadTasks();
    return () => {
      taskLoad.current.generation++;
      taskLoad.current.controller?.abort();
    };
  }, [open, tab, disabled, loadTasks]);
  /**
   * Workspace revisions arrive every few seconds, changed or not. With only
   * the first page loaded it is simply reloaded. Later pages are kept, and
   * the user is told only when Core's counts or the first 200 matching
   * tasks (Core's largest page, one request) differ from what is loaded.
   * Edits to tasks beyond the first 200 show after Refresh.
   */
  const checkForChanges = useCallback(async () => {
    const loaded = pageRef.current;
    if (!loaded || loadingRef.current) return;
    if ((loaded.pages || 1) <= 1) {
      void loadTasks();
      return;
    }
    const generation = taskLoad.current.generation;
    try {
      const first = await call<TaskPage>("task_list", {
        ...JSON.parse(conditions),
        limit: 200,
      });
      const current = pageRef.current;
      if (generation !== taskLoad.current.generation || !current) return;
      const versions = new Map(current.tasks.map((t) => [t.id, t.version]));
      const changed =
        JSON.stringify(first.counts || {}) !==
          JSON.stringify(current.counts || {}) ||
        first.tasks.some((task) => versions.get(task.id) !== task.version);
      if (changed) setOutdated(true);
    } catch {
      /* A failed background check changes nothing; Refresh is still there. */
    }
  }, [conditions, loadTasks]);
  useEffect(() => {
    if (!open || disabled) return;
    const timer = window.setTimeout(() => {
      setRevision((n) => n + 1);
      if (tab === "tasks") void checkForChanges();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [workspaceRevision, open, disabled, tab, checkForChanges]);
  const refresh = () => {
    setRevision((n) => n + 1);
    void loadTasks();
  };
  const saved = (task: SharedTask) => {
    const matches = matchesConditions(task, status, owner, projectFilter);
    setPage((previous) => {
      if (!previous) return previous;
      const old = previous.tasks.find((existing) => existing.id === task.id);
      const counts = previous.counts ? { ...previous.counts } : undefined;
      if (counts && old)
        counts[old.status] = Math.max(0, counts[old.status] - 1);
      if (counts && matches)
        counts[task.status] = (counts[task.status] || 0) + 1;
      // A task that no longer matches leaves the list instead of lingering.
      const tasks = old
        ? matches
          ? previous.tasks.map((existing) =>
              existing.id === task.id ? task : existing,
            )
          : previous.tasks.filter((existing) => existing.id !== task.id)
        : matches
          ? [task, ...previous.tasks]
          : previous.tasks;
      return { ...previous, tasks, counts };
    });
    // With only the first page loaded, Core's own answer replaces the estimate.
    if ((pageRef.current?.pages || 1) <= 1) void loadTasks();
    setEntry("switch");
    stay();
    setCreating(false);
    setSelected(task.id);
  };
  const tasks = page?.tasks || [];
  /** With no task open, one grid of cards (each says its status); beside
   * an open task, and while it leaves, rows under status headings. Both
   * keep the same order: what waits on someone first, newest change first. */
  const groups = groupTasks(tasks);
  const listAsRows = detailOpen || leaving;
  const taskButton = (task: SharedTask, card: boolean) => {
    const agent = agents.find(
      (agent) => agent.id === task.assigneeAgentId,
    );
    const line = taskLine(task);
    return (
      <button
        className={`collab-task-card ${selected === task.id ? "selected" : ""}`}
        key={task.id}
        onClick={() => showTask(task.id)}
        aria-pressed={selected === task.id}
        data-task-id={task.id}
        data-status={task.status}
      >
        <span className="collab-row-head">
          {card ? (
            <span className="collab-card-top">
              <Status status={task.status} />
              <span className="collab-task-id">{task.id}</span>
            </span>
          ) : (
            <span className="collab-task-id">{task.id}</span>
          )}
          <span className="collab-row-title">{task.title}</span>
        </span>
        <span
          className={`collab-row-line${line ? "" : " is-empty"}`}
        >
          {line || emptyLine[task.status]}
        </span>
        <span className="collab-row-meta">
          <span className="collab-row-owner">
            {agent ? (
              <>
                <Avatar agent={agent} small />
                <span>{agent.name}</span>
              </>
            ) : (
              <span>
                {task.assignee?.name || "Not assigned yet"}
              </span>
            )}
          </span>
          {projectFilter === ALL_PROJECTS &&
            task.projectId && (
              <span className="collab-task-project">
                {projectName(task.projectId, projects)}
              </span>
            )}
          <GitHubSummary links={task.github} openOnly />
          {currentResult(task) && (
            <span className="collab-has-result">
              <Check size={13} />
              Result
            </span>
          )}
          <time
            className="collab-row-time"
            dateTime={task.updatedAt}
            title={`Updated ${timeLabel(task.updatedAt)}`}
          >
            {relative(task.updatedAt)}
          </time>
        </span>
      </button>
    );
  };
  const total = page?.counts
    ? Object.values(page.counts).reduce((n, count) => n + count, 0)
    : tasks.length;
  const filtered =
    status !== "all" || !!owner || projectFilter !== ALL_PROJECTS;
  const openAgent = (id: string, turnId?: string) => {
    onOpenChange(false);
    onOpenAgent(id, turnId);
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="A place to work together"
      description="Shared tasks, conversations, and the work they lead to."
    >
      <div className="collaboration">
        <div className="collab-tabs" role="tablist" aria-label="Collaboration">
          <button
            role="tab"
            aria-selected={tab === "tasks"}
            aria-controls="collab-tasks"
            onClick={() => setTab("tasks")}
          >
            <ClipboardList size={17} />
            Tasks
          </button>
          <button
            role="tab"
            aria-selected={tab === "messages"}
            aria-controls="collab-messages"
            onClick={() => setTab("messages")}
          >
            <MessageCircle size={17} />
            Messages
          </button>
        </div>
        {disabled ? (
          <div className="collab-empty">
            <Leaf size={34} />
            <h3>Your shared workspace</h3>
            <p>
              Open the connected workspace to manage tasks and follow your
              agents’ collaboration.
            </p>
          </div>
        ) : tab === "tasks" ? (
          <section
            id="collab-tasks"
            role="tabpanel"
            aria-label="Tasks"
            className={`collab-task-layout ${detailOpen ? "with-detail" : leaving ? "detail-leaving" : ""}`}
            data-entry={entry}
            onTransitionEnd={(event) => {
              // The list is back at full width: the detail has gone.
              if (event.target === event.currentTarget && event.propertyName === "grid-template-columns")
                finishLeave.current?.();
            }}
          >
            <div className="collab-task-list">
              <div className="collab-list-heading">
                <div>
                  <h3>What we’re making</h3>
                  <p>A home for work worth keeping track of.</p>
                </div>
                <button
                  className="primary-button collab-new"
                  onClick={() => {
                    setEntry(detailOpen ? "switch" : "open");
                    stay();
                    setSelected(null);
                    setCreating(true);
                  }}
                >
                  <Plus size={16} />
                  New task
                </button>
              </div>
              <div className="collab-filters">
                <label className="collab-field">
                  <span>Show</span>
                  <select
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                  >
                    <option value="active">Open tasks</option>
                    <option value="all">All tasks</option>
                    {Object.entries(statuses).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="collab-field">
                  <span>Project</span>
                  <select
                    value={projectFilter}
                    onChange={(event) =>
                      setProjectFilter(event.target.value as ProjectScope)
                    }
                  >
                    <option value={ALL_PROJECTS}>All projects</option>
                    {activeProjects(projects).map((project) => (
                      <option key={project.id} value={projectScope(project.id)}>
                        {project.name}
                      </option>
                    ))}
                    <option value={NO_PROJECT}>No project</option>
                  </select>
                </label>
                <PersonSelect
                  agents={agents}
                  value={owner}
                  onChange={setOwner}
                  label="Owner"
                  empty="Everyone"
                />
                <button
                  className="icon-button"
                  disabled={loading}
                  onClick={refresh}
                  aria-label="Refresh tasks"
                  title="Refresh tasks"
                >
                  <RefreshCw size={17} className={loading ? "spin" : ""} />
                </button>
              </div>
              <ErrorNote text={error} />
              {outdated && (
                <div className="collab-outdated" role="status">
                  <span>Tasks changed since these pages loaded.</span>
                  <button
                    className="text-button"
                    disabled={loading}
                    onClick={refresh}
                  >
                    Refresh tasks
                  </button>
                </div>
              )}
              {!page && (loading || !error) ? (
                <div className="collab-loading">
                  <LoaderCircle className="spin" size={20} />
                  Gathering your tasks…
                </div>
              ) : (
                <>
                  {/* The page is reset to null when the conditions change, so this
                      never shows before Core answers; a background reload of
                      the same empty answer must not unmount it (focus, flicker). */}
                  {page && !tasks.length && !error && (
                    <div className="collab-empty">
                      <Leaf size={34} />
                      <h3>
                        {filtered
                          ? "A little breathing room"
                          : "Make room for your next idea"}
                      </h3>
                      <p>
                        {filtered
                          ? "No tasks match these filters."
                          : "Start with a title. Add an agent, a note, or a result as the work takes shape."}
                      </p>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setEntry("open");
                          stay();
                          setCreating(true);
                        }}
                      >
                        <Plus size={15} />
                        Create a task
                      </button>
                    </div>
                  )}
                  {listAsRows ? (
                    <div className="collab-groups">
                      {groups.map((group) => (
                        <section
                          key={group.status}
                          className={`collab-group group-${group.status}`}
                          aria-label={`${statuses[group.status]}, ${group.tasks.length}`}
                        >
                          <h4 className="collab-group-head">
                            <Status status={group.status} />
                            <span className="collab-group-count">
                              {group.tasks.length}
                            </span>
                          </h4>
                          <div className="collab-rows">
                            {group.tasks.map((task) => taskButton(task, false))}
                          </div>
                        </section>
                      ))}
                    </div>
                  ) : (
                    <div className="collab-cards">
                      {groups.flatMap((group) => group.tasks).map((task) => taskButton(task, true))}
                    </div>
                  )}
                  {page && tasks.length > 0 && (
                    <p className="collab-list-count" role="status">
                      Showing {tasks.length} of {total}{" "}
                      {filtered ? "matching tasks" : "tasks"}
                    </p>
                  )}
                  {page?.hasMore && (
                    <div className="collab-load-more">
                      <p>More tasks match these filters.</p>
                      <button
                        className="secondary-button"
                        disabled={loading || page.nextAfterSeq == null}
                        onClick={() => void loadTasks(page.nextAfterSeq!)}
                      >
                        Load more tasks
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
            {creating ? (
              <NewTask
                key="new-task"
                agents={agents}
                projects={projects}
                initialProjectId={scopeProjectId(projectFilter) || ""}
                onClose={closeDetail}
                onSaved={saved}
              />
            ) : (
              selected && (
                <TaskPane
                  key={selected}
                  id={selected}
                  agents={agents}
                  projects={projects}
                  revision={revision}
                  onClose={closeDetail}
                  onSaved={saved}
                  onOpenAgent={openAgent}
                  reviewId={
                    reviewFocus?.taskId === selected
                      ? reviewFocus.reviewId
                      : undefined
                  }
                />
              )
            )}
          </section>
        ) : (
          <Messages
            key="messages"
            agents={agents}
            onOpenAgent={openAgent}
            onOpenTask={(id, reviewId) => {
              setEntry("open");
              stay();
              setSelected(id);
              setReviewFocus(reviewId ? { taskId: id, reviewId } : null);
              setCreating(false);
              setStatus("all");
              setOwner("");
              setTab("tasks");
            }}
            revision={revision}
          />
        )}
      </div>
    </Modal>
  );
}

function NewTask({
  agents,
  projects,
  initialProjectId,
  onClose,
  onSaved,
}: {
  agents: Agent[];
  projects: Project[];
  initialProjectId: string;
  onClose: () => void;
  onSaved: (task: SharedTask) => void;
}) {
  const [draft, setDraft] = useState({
    ...emptyTask,
    projectId: initialProjectId,
  });
  const mutation = useMutation();
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.title.trim()) return;
    const answer = await mutation.execute<{ task: SharedTask }>("task_create", {
      title: draft.title.trim(),
      description: draft.description.trim(),
      ...(draft.assigneeAgentId
        ? { assigneeAgentId: draft.assigneeAgentId }
        : {}),
      // The GUI always states the project; only agents rely on a default.
      projectId: draft.projectId || null,
    });
    if (answer) onSaved(answer.task);
  }
  return (
    <aside className="collab-detail" aria-label="New task">
      <div className="collab-detail-top">
        <span className="collab-eyebrow">
          <Leaf size={15} />
          Something to work on
        </span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close new task"
        >
          <X size={17} />
        </button>
      </div>
      <MutationForm
        pending={mutation.pending}
        onSubmit={create}
        className="collab-form"
      >
        <label className="collab-field">
          <span>Task title</span>
          <input
            autoFocus
            required
            maxLength={240}
            placeholder="What would you like to make possible?"
            value={draft.title}
            onChange={(event) =>
              setDraft({ ...draft, title: event.target.value })
            }
          />
        </label>
        <label className="collab-field">
          <span>
            Description <small>optional</small>
          </span>
          <textarea
            rows={5}
            placeholder="Scope, a little context, or what a good result looks like."
            value={draft.description}
            onChange={(event) =>
              setDraft({ ...draft, description: event.target.value })
            }
          />
        </label>
        <PersonSelect
          agents={agents}
          value={draft.assigneeAgentId}
          onChange={(assigneeAgentId) =>
            setDraft({ ...draft, assigneeAgentId })
          }
          label="Owner"
        />
        <ProjectSelect
          projects={projects}
          value={draft.projectId}
          onChange={(projectId) => setDraft({ ...draft, projectId })}
        />
        <p className="collab-hint">
          Adding an owner keeps track of responsibility. You can send the task
          to them once it’s created.
        </p>
        <ErrorNote text={mutation.error} />
        <button
          className="primary-button"
          disabled={mutation.pending || !draft.title.trim()}
        >
          {mutation.pending ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <Plus size={15} />
          )}
          Create task
        </button>
      </MutationForm>
    </aside>
  );
}

function TaskPane({
  id,
  agents,
  projects,
  revision,
  onClose,
  onSaved,
  onOpenAgent,
  reviewId,
}: {
  id: string;
  agents: Agent[];
  projects: Project[];
  revision: number;
  onClose: () => void;
  onSaved: (task: SharedTask) => void;
  onOpenAgent: (id: string, turnId?: string) => void;
  /** Open this review's report among the task's PR reviews. */
  reviewId?: string;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [editBase, setEditBase] = useState<SharedTask | null>(null);
  const [editVersion, setEditVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState("");
  const [editing, setEditing] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [toAgentId, setToAgentId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [comment, setComment] = useState("");
  const [result, setResult] = useState("");
  const [resultStatus, setResultStatus] = useState<ResultStatus>("review");
  const [resultVersion, setResultVersion] = useState(0);
  const [deliveryCandidate, setDeliveryCandidate] = useState<DeliveryCandidate | null>(null);
  const [submitDelivery, setSubmitDelivery] = useState(false);
  useEffect(() => { setSubmitDelivery(false); }, [deliveryCandidate?.flowId, deliveryCandidate?.round]);
  const [links, setLinks] = useState<ResultLink[]>([]);
  const [notice, setNotice] = useState("");
  // Linking, PR operations, review and delivery setup: shown on request.
  const [managing, setManaging] = useState(false);
  const mutation = useMutation();
  const loadGeneration = useRef(0);
  const load = useCallback(
    async (afterSeq?: number) => {
      const generation = ++loadGeneration.current;
      setLoading(true);
      setReadError("");
      try {
        const next = await call<TaskDetail>("task_get", {
          taskId: id,
          ...(afterSeq === undefined ? {} : { afterSeq }),
          limit: 50,
        });
        if (generation === loadGeneration.current)
          setDetail((previous) =>
            afterSeq === undefined
              ? next
              : {
                  ...next,
                  activities: [
                    ...(previous?.activities || []),
                    ...next.activities.filter(
                      (activity) =>
                        !previous?.activities.some(
                          (old) => old.seq === activity.seq,
                        ),
                    ),
                  ],
                },
          );
      } catch (error) {
        if (generation === loadGeneration.current)
          setReadError(errorText(error));
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
      }
    },
    [id],
  );
  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current++;
    };
  }, [load, revision]);
  const task = detail?.task;
  const owner = agents.find((agent) => agent.id === task?.assigneeAgentId);
  const changed = (next: SharedTask) => {
    setDetail((previous) =>
      previous ? { ...previous, task: next } : previous,
    );
    onSaved(next);
    void load();
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!task || !draft || !editBase) return;
    const patch = taskPatch(editBase, draft);
    if (!Object.keys(patch).length) {
      setEditing(false);
      return;
    }
    const answer = await mutation.execute<{ task: SharedTask }>("task_update", {
      taskId: id,
      expectedVersion: editVersion,
      patch,
    });
    if (answer) {
      setEditing(false);
      changed(answer.task);
    }
  };
  const dispatch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!task || !toAgentId) return;
    const answer = await mutation.execute<{ task: SharedTask }>(
      "task_dispatch",
      {
        taskId: id,
        expectedVersion: task.version,
        toAgentId,
        priority: urgent ? "urgent" : "normal",
        ...(instruction.trim() ? { body: instruction.trim() } : {}),
      },
    );
    if (answer) {
      setDispatching(false);
      setInstruction("");
      setUrgent(false);
      setNotice(
        "Task sent. You can follow the work in the agent’s conversation.",
      );
      changed(answer.task);
    }
  };
  const submitResult = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!task || !result.trim()) return;
    if (links.some((link) => !safeCollaborationLink(link.url))) return;
    const answer = await mutation.execute<{ task: SharedTask }>(
      "task_submit_result",
      {
        taskId: id,
        expectedVersion: resultVersion,
        summary: result.trim(),
        links: links.map((link) => {
          const url = safeCollaborationLink(link.url)!;
          return { label: link.label.trim() || new URL(url).hostname, url };
        }),
        status: resultStatus,
        ...(submitDelivery && deliveryCandidate && resultStatus === "review" ? { delivery: deliveryCandidate } : {}),
      },
    );
    if (answer) {
      setReporting(false);
      setResult("");
      setLinks([]);
      changed(answer.task);
    }
  };
  const addComment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!comment.trim()) return;
    const sent = comment;
    const answer = await mutation.execute<unknown>("task_comment", {
      taskId: id,
      body: sent.trim(),
    });
    if (answer) {
      setComment((current) => (current === sent ? "" : current));
      void load();
    }
  };
  // The result belongs to where things stand once there is one; until then
  // its place (and Add result) follows the description.
  const current = task && (task.status === "review" || task.status === "done");
  const resultSection = task && (
          <section className="collab-section collab-result">
            <div className="collab-section-heading">
              <h4>
                {task.result && !current ? <History size={16} /> : <Check size={16} />}
                {task.result && !current ? "Earlier result" : "The result"}
              </h4>
              <button
                className="text-button"
                disabled={mutation.pending}
                onClick={() => {
                  setReporting(!reporting);
                  setResultVersion(task.version);
                  setResultStatus(task.status === "done" ? "done" : "review");
                  setResult(task.result?.summary || "");
                  setLinks(task.result?.links || []);
                  mutation.clearError();
                }}
              >
                {task.result ? "Update result" : "Add result"}
              </button>
            </div>
            {task.result ? (
              <>
                <Prose text={task.result.summary} />
                {!!task.result.links?.length && (
                  <div className="collab-result-links">
                    {task.result.links.map((link, index) => {
                      const url = safeCollaborationLink(link.url);
                      return url ? (
                        <a
                          key={index}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {link.label || link.url}
                          <ArrowUpRight size={14} />
                        </a>
                      ) : (
                        <span key={index}>
                          {link.label || link.url}
                          <small>Link unavailable</small>
                        </span>
                      );
                    })}
                  </div>
                )}
                <p className="collab-hint">
                  Reported by {actorName(task.result.reportedBy)}
                  {task.result.reportedAt &&
                    ` · ${timeLabel(task.result.reportedAt)}`}
                </p>
                {task.result.source &&
                  agents.some(
                    (agent) => agent.id === task.result?.source?.agentId,
                  ) && (
                    <button
                      className="text-button"
                      onClick={() =>
                        onOpenAgent(
                          task.result!.source!.agentId,
                          task.result!.source!.turnId || undefined,
                        )
                      }
                    >
                      View original conversation
                      <ArrowUpRight size={14} />
                    </button>
                  )}
              </>
            ) : (
              <p className="collab-hint">
                The finished work and useful links will live here.
              </p>
            )}
            {reporting && (
              <MutationForm
                pending={mutation.pending}
                className="collab-form collab-inset"
                onSubmit={submitResult}
              >
                {task.version !== resultVersion && (
                  <div className="collab-conflict" role="status">
                    <p>
                      The task changed. Review the current result above before
                      saving yours.
                    </p>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setResultVersion(task.version)}
                    >
                      Use the current version and keep my result
                    </button>
                  </div>
                )}
                <label className="collab-field">
                  <span>Result summary</span>
                  <textarea
                    required
                    rows={4}
                    placeholder="What changed, and what should someone look at?"
                    value={result}
                    onChange={(event) => setResult(event.target.value)}
                  />
                </label>
                <label className="collab-field">
                  <span>After adding this result</span>
                  <select
                    value={resultStatus}
                    onChange={(event) =>
                      setResultStatus(
                        event.target.value === "done" ? "done" : "review",
                      )
                    }
                  >
                    <option value="review">Ready to review</option>
                    <option value="done">Done</option>
                  </select>
                </label>
                {deliveryCandidate && resultStatus === "review" && <label className="delivery-submit"><input type="checkbox" checked={submitDelivery} onChange={event => setSubmitDelivery(event.target.checked)} />Start the authorized review and CI for {deliveryCandidate.headSha.slice(0, 8)} with this result (round {deliveryCandidate.round}).</label>}
                {links.map((link, index) => (
                  <div className="collab-link-fields" key={index}>
                    <label className="collab-field">
                      <span>Link label</span>
                      <input
                        value={link.label}
                        onChange={(event) =>
                          setLinks(
                            links.map((row, i) =>
                              i === index
                                ? { ...row, label: event.target.value }
                                : row,
                            ),
                          )
                        }
                      />
                    </label>
                    <label className="collab-field">
                      <span>Web address</span>
                      <input
                        type="url"
                        required
                        placeholder="https://…"
                        value={link.url}
                        onChange={(event) =>
                          setLinks(
                            links.map((row, i) =>
                              i === index
                                ? { ...row, url: event.target.value }
                                : row,
                            ),
                          )
                        }
                        aria-invalid={
                          !!link.url && !safeCollaborationLink(link.url)
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() =>
                        setLinks(links.filter((_, i) => i !== index))
                      }
                      aria-label={`Remove link ${index + 1}`}
                    >
                      <X size={15} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="text-button"
                  disabled={links.length >= 30}
                  onClick={() => setLinks([...links, { label: "", url: "" }])}
                >
                  <Plus size={14} />
                  Add a web link
                </button>
                {links.some(
                  (link) => link.url && !safeCollaborationLink(link.url),
                ) && (
                  <p className="collab-hint">
                    Use an http or https address. Local files are available in
                    the agent’s conversation.
                  </p>
                )}
                <button
                  className="primary-button"
                  disabled={
                    mutation.pending ||
                    !result.trim() ||
                    links.some((link) => !safeCollaborationLink(link.url))
                  }
                >
                  <Check size={15} />
                  Save result
                </button>
              </MutationForm>
            )}
          </section>
  );
  return (
    <aside className="collab-detail" aria-label="Task details">
      <div className="collab-detail-top">
        {/* Beside the list a close button; alone (narrow), a way back to it. */}
        <button className="collab-back" onClick={onClose}>
          <ArrowLeft size={16} />
          All tasks
        </button>
        <button
          className="icon-button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh task details"
        >
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </button>
        <button
          className="icon-button collab-close"
          onClick={onClose}
          aria-label="Close task"
          title="Close"
        >
          <X size={17} />
        </button>
      </div>
      <ErrorNote text={readError} />
      {!task ? (
        !readError && (
          <div className="collab-loading">
            <LoaderCircle size={18} className="spin" />
            Opening task…
          </div>
        )
      ) : (
        <>
          <div className="collab-task-title">
            <div className="collab-card-heading">
              <Status status={task.status} />
              <span className="collab-task-id" data-task-id={task.id}>
                {task.id}
              </span>
              <span className="collab-task-project">
                {projectName(task.projectId, projects) || "No project"}
              </span>
            </div>
            <h3>{task.title}</h3>
            <div className="collab-owner-line">
              {owner ? (
                <>
                  <Avatar agent={owner} small />
                  <button
                    className="text-button"
                    onClick={() => onOpenAgent(owner.id)}
                  >
                    {owner.name}
                    <ArrowUpRight size={13} />
                  </button>
                </>
              ) : (
                <span>{task.assignee?.name || "Not assigned yet"}</span>
              )}
            </div>
            <div className="collab-task-actions">
              <button className="secondary-button" onClick={() => openJobs({taskId:task.id})}>Related jobs</button>
              {/* A reference in an Agent's draft (T-152), unlike Give to agent below. */}
              <SendToAgentButton
                draggable={false}
                source={() => ({
                  kind: "task",
                  taskId: task.id,
                  title: task.title,
                  status: task.status,
                  assignee: task.assignee?.name || null,
                  version: task.version,
                  summary: task.result?.summary || task.progress || task.description || "",
                })}
              />
              <button
                className="primary-button"
                disabled={mutation.pending}
                onClick={() => {
                  setDispatching(!dispatching);
                  setToAgentId(task.assigneeAgentId || "");
                  setUrgent(false);
                  mutation.clearError();
                }}
              >
                <Send size={15} />
                Give to agent
              </button>
              <button
                className="secondary-button"
                disabled={mutation.pending}
                onClick={() => {
                  setDraft(taskDraft(task));
                  setEditBase(task);
                  setEditVersion(task.version);
                  setEditing(!editing);
                  mutation.clearError();
                }}
              >
                Edit task
              </button>
            </div>
          </div>
          <ErrorNote text={mutation.error} />
          {mutation.error && editing && (
            <p className="collab-hint">
              Your edits are still here. Refresh to see the current task before
              applying them again.
            </p>
          )}
          {notice && (
            <p className="collab-notice" role="status">
              <Check size={15} />
              {notice}
            </p>
          )}
          {dispatching && (
            <MutationForm
              pending={mutation.pending}
              onSubmit={dispatch}
              className="collab-form collab-inset"
            >
              <h4>Send this work along</h4>
              <PersonSelect
                agents={agents}
                value={toAgentId}
                onChange={setToAgentId}
                label="Send to"
                empty="Choose an agent"
              />
              <label className="collab-field">
                <span>
                  A note <small>optional</small>
                </span>
                <textarea
                  rows={3}
                  placeholder="Anything they should keep in mind?"
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                />
              </label>
              <label className="collab-urgent-option">
                <input
                  type="checkbox"
                  checked={urgent}
                  onChange={(event) => setUrgent(event.target.checked)}
                />
                <span>Urgent · notify during current work</span>
              </label>
              <p className="collab-hint">
                Normal messages wait until the current turn ends. Urgent
                messages request a reminder during current work. Offline
                messages wait for reconnection.
              </p>
              <button
                className="primary-button"
                disabled={
                  mutation.pending ||
                  !toAgentId ||
                  !activeAgents(agents).some((agent) => agent.id === toAgentId)
                }
              >
                <Send size={14} />
                Assign and send
              </button>
            </MutationForm>
          )}
          {editing && draft && (
            <MutationForm
              pending={mutation.pending}
              className="collab-form collab-inset"
              onSubmit={save}
            >
              {task.version !== editVersion && (
                <div className="collab-conflict" role="status">
                  <p>
                    This task changed while you were editing. Your draft is
                    kept.
                  </p>
                  <details>
                    <summary>Compare with the current task</summary>
                    <dl>
                      {Object.keys(taskPatch(editBase!, draft)).map((key) => (
                        <div key={key}>
                          <dt>
                            {
                              (
                                {
                                  title: "Title",
                                  description: "Description",
                                  status: "Status",
                                  assigneeAgentId: "Owner",
                                  progress: "Progress",
                                  blocker: "Blocker",
                                  projectId: "Project",
                                } as Record<string, string>
                              )[key]
                            }
                          </dt>
                          <dd>
                            {key === "projectId"
                              ? projectName(task.projectId, projects) ||
                                "No project"
                              : String(
                                  taskDraft(task)[key as keyof TaskDraft] ||
                                    "Not set",
                                )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setEditVersion(task.version)}
                  >
                    Keep my changed fields on this version
                  </button>
                </div>
              )}
              <label className="collab-field">
                <span>Task title</span>
                <input
                  required
                  maxLength={240}
                  value={draft.title}
                  onChange={(event) =>
                    setDraft({ ...draft, title: event.target.value })
                  }
                />
              </label>
              <label className="collab-field">
                <span>Description</span>
                <textarea
                  rows={4}
                  value={draft.description}
                  onChange={(event) =>
                    setDraft({ ...draft, description: event.target.value })
                  }
                />
              </label>
              <div className="collab-form-pair">
                <label className="collab-field">
                  <span>Task status</span>
                  <select
                    value={draft.status}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        status: event.target.value as TaskStatus,
                      })
                    }
                  >
                    {Object.entries(statuses).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <PersonSelect
                  agents={agents}
                  value={draft.assigneeAgentId}
                  onChange={(assigneeAgentId) =>
                    setDraft({ ...draft, assigneeAgentId })
                  }
                  label="Owner"
                />
              </div>
              <ProjectSelect
                projects={projects}
                value={draft.projectId}
                onChange={(projectId) => setDraft({ ...draft, projectId })}
              />
              <label className="collab-field">
                <span>
                  Latest progress <small>optional</small>
                </span>
                <textarea
                  rows={2}
                  value={draft.progress}
                  onChange={(event) =>
                    setDraft({ ...draft, progress: event.target.value })
                  }
                />
              </label>
              <label className="collab-field">
                <span>
                  What’s in the way? <small>optional</small>
                </span>
                <textarea
                  rows={2}
                  value={draft.blocker}
                  onChange={(event) =>
                    setDraft({ ...draft, blocker: event.target.value })
                  }
                />
              </label>
              <div className="collab-actions">
                <button
                  className="primary-button"
                  disabled={mutation.pending || !draft.title.trim()}
                >
                  <Check size={15} />
                  Save changes
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={mutation.pending}
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </button>
              </div>
            </MutationForm>
          )}
          {task.blocker && (
            <section className="collab-blocker">
              <CircleAlert size={18} />
              <div>
                <h4>Waiting on</h4>
                <p>{task.blocker}</p>
              </div>
            </section>
          )}
          {task.progress && (
            <section className="collab-section">
              <h4>Where things stand</h4>
              <Prose text={task.progress} />
            </section>
          )}
          {task.result && resultSection}
          {!editing && task.description && (
            <section className="collab-section">
              <h4>The work</h4>
              <Prose text={task.description} />
            </section>
          )}
          {!task.result && resultSection}
          <section className="collab-section collab-delivery" aria-label="Delivery">
            <div className="collab-section-heading">
              <h4>Delivery</h4>
              <button
                type="button"
                className="quiet-button"
                aria-expanded={managing}
                onClick={() => setManaging((value) => !value)}
              >
                <Settings2 size={14} />
                {managing ? "Done" : "Manage"}
              </button>
            </div>
            <GitHubLinks
              key={task.id}
              taskId={task.id}
              reviewId={reviewId}
              manage={managing}
              onManage={() => setManaging(true)}
            />
            <DeliveryFlow
              key={`delivery-${task.id}`}
              taskId={task.id}
              revision={revision + task.version}
              onCandidate={setDeliveryCandidate}
              manage={managing}
            />
          </section>
          {!!detail.executions?.length && (
            <section className="collab-section">
              <h4>Related conversations</h4>
              <div className="collab-executions">
                {detail.executions.map((source, index) => {
                  const agent = agents.find(
                    (agent) => agent.id === source.agentId,
                  );
                  return agent ? (
                    <button
                      key={`${source.agentId}:${source.turnId || index}`}
                      className="secondary-button"
                      onClick={() =>
                        onOpenAgent(agent.id, source.turnId || undefined)
                      }
                    >
                      <MessageCircle size={14} />
                      {agent.name}
                      <ArrowUpRight size={13} />
                    </button>
                  ) : (
                    <span
                      className="collab-hint"
                      key={`${source.agentId}:${source.turnId || index}`}
                    >
                      Conversation from a removed agent
                    </span>
                  );
                })}
              </div>
            </section>
          )}
          <section className="collab-section">
            <h4>Conversation & updates</h4>
            <div className="collab-activity">
              {detail.activities.map((activity) => (
                <article key={activity.seq}>
                  <div className="collab-activity-heading">
                    <strong>{actorName(activity.actor)}</strong>
                    <time>{timeLabel(activity.at)}</time>
                  </div>
                  {activity.body ? (
                    <Prose text={activity.body} />
                  ) : (
                    <p className="collab-hint">
                      {
                        {
                          created: "Created this task",
                          updated: "Updated the task",
                          claimed: "Picked up this task",
                          result: "Shared a result",
                          dispatched: "Sent this task to an agent",
                          comment: "Added a note",
                        }[activity.kind]
                      }
                    </p>
                  )}
                  {activity.source &&
                    agents.some(
                      (agent) => agent.id === activity.source?.agentId,
                    ) && (
                      <button
                        className="text-button"
                        onClick={() =>
                          onOpenAgent(
                            activity.source!.agentId,
                            activity.source!.turnId || undefined,
                          )
                        }
                      >
                        View conversation
                        <ArrowUpRight size={13} />
                      </button>
                    )}
                </article>
              ))}
            </div>
            {detail.hasMore && (
              <button
                className="text-button"
                disabled={loading || detail.nextAfterSeq == null}
                onClick={() => void load(detail.nextAfterSeq!)}
              >
                More updates
              </button>
            )}
            <MutationForm
              pending={mutation.pending}
              className="collab-form collab-comment"
              onSubmit={addComment}
            >
              <label className="collab-field">
                <span>Add a note</span>
                <textarea
                  rows={3}
                  placeholder="A useful update, question, or thought…"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              </label>
              <div className="collab-comment-foot">
                <span>Shared on this task</span>
                <button
                  className="secondary-button"
                  disabled={mutation.pending || !comment.trim()}
                >
                  <MessageCircle size={14} />
                  Add note
                </button>
              </div>
            </MutationForm>
          </section>
        </>
      )}
    </aside>
  );
}

function Messages({
  agents,
  onOpenAgent,
  onOpenTask,
  revision,
}: {
  agents: Agent[];
  onOpenAgent: (id: string, turnId?: string) => void;
  onOpenTask: (id: string, reviewId?: string) => void;
  revision: number;
}) {
  const [mailbox, setMailbox] = useState("");
  const [page, setPage] = useState<MessagePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(
    async (afterSeq?: number) => {
      const request = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const next = await call<MessagePage>("peer_read", {
          ...(mailbox ? { agentId: mailbox } : {}),
          ...(afterSeq === undefined ? {} : { afterSeq }),
          limit: 50,
        });
        if (request === generation.current)
          setPage((previous) =>
            afterSeq === undefined
              ? next
              : {
                  ...next,
                  messages: [
                    ...(previous?.messages || []),
                    ...next.messages.filter(
                      (message) =>
                        !previous?.messages.some(
                          (old) => old.id === message.id,
                        ),
                    ),
                  ],
                },
          );
      } catch (error) {
        if (request === generation.current) setError(errorText(error));
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [mailbox],
  );
  useEffect(() => {
    setPage(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    if (revision) void load();
  }, [revision, load]);
  return (
    <section
      id="collab-messages"
      role="tabpanel"
      aria-label="Messages"
      className="collab-messages"
    >
      <div className="collab-mailbox">
        <div className="collab-list-heading">
          <div>
            <h3>A conversation between teammates</h3>
            <p>
              Follow who is helping whom, what they shared, and the work it
              belongs to.
            </p>
          </div>
        </div>
        <div className="collab-filters">
          <label className="collab-field">
            <span>Mailbox</span>
            <select
              value={mailbox}
              onChange={(event) => setMailbox(event.target.value)}
            >
              <option value="">All agents</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.closedAt ? " · closed" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            className="icon-button"
            disabled={loading}
            onClick={() => void load()}
            aria-label="Refresh messages"
          >
            <RefreshCw size={17} className={loading ? "spin" : ""} />
          </button>
        </div>
        <ErrorNote text={error} />
        {!page && loading ? (
          <div className="collab-loading">
            <LoaderCircle size={18} className="spin" />
            Opening the mailbox…
          </div>
        ) : !page?.messages.length && !error ? (
          <div className="collab-empty">
            <Inbox size={33} />
            <h3>Quiet for now</h3>
            <p>
              {mailbox
                ? "Messages sent to this agent will appear here."
                : "Messages between your agents will appear here."}
            </p>
          </div>
        ) : (
          <div className="collab-message-list">
            {page?.messages.map((message) => {
              const sender = message.sender;
              const senderId = sender.kind === "agent" ? sender.id : null;
              const senderAgent = agents.find((agent) => agent.id === senderId);
              return (
                <article
                  className="collab-message"
                  key={message.id}
                  id={`peer-message-${message.id}`}
                  tabIndex={-1}
                >
                  <div className="collab-message-heading">
                    <strong>{senderAgent?.name || actorName(sender)}</strong>
                    <span>
                      to{" "}
                      {agents.find((agent) => agent.id === message.recipient.id)
                        ?.name ||
                        message.recipient.name ||
                        "previous agent"}
                    </span>
                    {message.priority === "urgent" && (
                      <span className="collab-urgent-badge">Urgent</span>
                    )}
                    <time>{timeLabel(message.createdAt)}</time>
                  </div>
                  {message.replyTo &&
                    (page?.messages.some(
                      (item) => item.id === message.replyTo,
                    ) ? (
                      <button
                        className="collab-reply-label"
                        onClick={() => {
                          const original = document.getElementById(
                            `peer-message-${message.replyTo}`,
                          );
                          original?.scrollIntoView({
                            block: "center",
                            behavior: "smooth",
                          });
                          original?.focus({ preventScroll: true });
                        }}
                      >
                        Reply to an earlier message
                        <ArrowUpRight size={12} />
                      </button>
                    ) : (
                      <span className="collab-reply-label">
                        Reply to an earlier message
                      </span>
                    ))}
                  {message.taskId && (
                    <button
                      className="collab-message-task"
                      aria-label={`View task ${message.taskId}`}
                      onClick={() => onOpenTask(message.taskId!)}
                    >
                      <ClipboardList size={13} />
                      <span>{message.taskId}</span>
                      <ArrowUpRight size={12} />
                    </button>
                  )}
                  {message.taskId &&
                    message.sender.kind === "system" &&
                    typeof message.reviewId === "string" && (
                      <button
                        className="collab-message-task"
                        onClick={() =>
                          onOpenTask(message.taskId!, message.reviewId!)
                        }
                      >
                        <span>Open review</span>
                        <ArrowUpRight size={12} />
                      </button>
                    )}
                  <Prose text={message.body} />
                  <div className="collab-message-footer">
                    <span>
                      {message.firstReadAt
                        ? "Fetched by recipient"
                        : message.delivery?.state === "sending" &&
                            message.delivery?.detail?.mode === "hook"
                          ? "Awaiting tool boundary"
                          : (
                              {
                                pending: "Waiting in mailbox",
                                sending: "Notifying recipient",
                                delivered: "Recipient notified",
                                accepted: "Recipient notified",
                                uncertain: "Reminder unconfirmed",
                                error: "Reminder unavailable",
                                failed: "Reminder unavailable",
                              } as Record<string, string>
                            )[message.delivery?.state] || "Saved in mailbox"}
                    </span>
                    {message.delivery?.state === "delivered" &&
                      typeof message.delivery?.detail?.mode === "string" &&
                      ["steer", "start", "hook"].includes(
                        message.delivery.detail.mode,
                      ) && (
                        <span className="collab-delivery-mode">
                          {
                            {
                              steer: "Via active turn",
                              start: "Via new turn",
                              hook: "Via native hook",
                            }[
                              message.delivery.detail.mode as
                                | "steer"
                                | "start"
                                | "hook"
                            ]
                          }
                        </span>
                      )}
                    {senderAgent && (
                      <button
                        className="text-button"
                        onClick={() =>
                          onOpenAgent(
                            senderAgent.id,
                            message.source?.turnId || undefined,
                          )
                        }
                      >
                        Sender conversation
                        <ArrowUpRight size={12} />
                      </button>
                    )}
                    {typeof message.delivery?.detail?.turnId === "string" &&
                      agents.some(
                        (agent) => agent.id === message.recipient.id,
                      ) && (
                        <button
                          className="text-button"
                          onClick={() =>
                            onOpenAgent(
                              message.recipient.id,
                              message.delivery.detail!.turnId as string,
                            )
                          }
                        >
                          Recipient conversation
                          <ArrowUpRight size={12} />
                        </button>
                      )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {page?.hasMore && (
          <button
            className="secondary-button"
            disabled={loading || page.nextAfterSeq == null}
            onClick={() => void load(page.nextAfterSeq!)}
          >
            Load more messages
          </button>
        )}
      </div>
    </section>
  );
}
