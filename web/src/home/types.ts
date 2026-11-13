/**
 * What Home reads from Core (GET /api/home and its companions). Core owns
 * these facts. Section bodies are written by Agents and checked by the
 * brief contract (intelligent-ui/brief-contract.ts) before Core keeps them.
 */
import type { PendingRequest } from "../types";

export type SectionKind = "ask" | "report" | "status";

export type AskReply = {
  options?: { id: string; label: string }[];
  freeText?: true | { prompt?: string };
  /** A small Clarification form (1–8 fields, 2–12 options each). */
  form?: unknown;
  /** Pick one of two approaches. */
  choice?: {
    a: { id: string; label: string; detail?: string };
    b: { id: string; label: string; detail?: string };
  };
};

export type SectionAttachment = {
  name: string;
  kind: "image" | "data" | "pdf" | "text" | "link";
  mime: string;
  size: number;
  /** Kept as it was when written; otherwise only a reference that may since have changed. */
  snapshot: boolean;
  mayChange: boolean;
  takenAt: string;
  caption?: string;
  /** External links only. */
  url?: string;
  /** Where a referenced (not snapshotted) file lives on its machine. */
  path?: string;
  /** A kept image's size as drawn, which Core read from the bytes it keeps
   * (T-19 HM:B14); absent when it could not, or for anything not kept. */
  width?: number;
  height?: number;
};

/**
 * A Live Reference as Core sees it now, keyed `${kind}:${id}`. Core reads
 * the current state; the Agent only names the item.
 */
export type LiveRefState = {
  kind: "task" | "pr" | "ci" | "job" | "run" | "review" | "agent" | "machine";
  id: string;
  /** Unknown when Core can't find it: shown as such, never guessed. */
  found: boolean;
  title?: string;
  /** Core's own state word, e.g. doing, running, passed, merged, idle. */
  state?: string;
  /** Attention: failed, changes requested, error, needs approval. */
  tone?: "ok" | "active" | "attention" | "neutral";
  url?: string;
  /** For a review: the task it belongs to, so Jobs can open it. */
  taskId?: string;
  /** For a task (T-56): the key it has now, which may differ from the one
   * the Agent wrote (an old key, or `T-<n>`); every key it had still names it. */
  key?: string;
  observedAt?: string;
  /** For a task (T-9): who has it, null when no one does. */
  assignee?: { kind: string; id: string; name: string } | null;
  /** For a task: when its record last changed. */
  updatedAt?: string;
  /** For a task: archived. */
  archived?: boolean;
  /** Core could not read the item: not the same as not found. */
  unavailable?: boolean;
  /** For a run of stages (YN-7): how many of its stages are done, of how many. */
  stages?: { done: number; total: number };
  /** For a run: the Job of its newest attempt, where Jobs shows the run with every stage. */
  jobId?: string;
  /** For a queued run (YN-30): what its first stage in the queue waits for,
   * e.g. gpu, memory, cpu, slot, disk, exclusive, budget or capacity. */
  waitingFor?: string;
};

export type Section = {
  /** Home's identity of the section (absent from older Cores): the same
   * through every put and edit of it; a section removed and written again
   * under the same key has another. */
  id?: number;
  key: string;
  kind: SectionKind;
  title: string;
  version: number;
  owner: { agentId: string; name: string; state: "active" | "closed" | "deleted" | "moved" };
  updatedAt: string;
  updatedTurnId: string | null;
  /** A json-render spec: { root, elements } with a BriefBody root. */
  body: unknown;
  ask?: {
    question: string;
    reply: AskReply;
    state: "open" | "replied" | "resolved";
    repliedAt?: string;
    replyText?: string;
    deferredUntil?: string;
    /** An executor's gate (T-43 S4): the step of its task's template this asks you to approve. */
    gate?: AskGate;
  };
  status?: { asOf: string; validFor: number; stale: boolean };
  time?: { due?: string; eta?: string; nextUpdate?: string };
  attachments: SectionAttachment[];
  /** Current state of every Live Reference in the body, keyed `${kind}:${id}`. */
  refs: Record<string, LiveRefState>;
  /** The version the user explicitly marked seen, never inferred. */
  seen: { version: number; at: string } | null;
  /** A live report: the newest version the user's browser showed whole on its
   * page (YN-86), by the section's id. A receipt of reading, apart from
   * `seen`: it never puts the report into History. Absent from older Cores. */
  opened?: { version: number; at: string } | null;
  /** A seen report kept for 30 days, or a removed section. */
  history: boolean;
  /** What Core changed to accept this version (YN-14), in Core's words;
   * absent when it was accepted as sent, and from older Cores. */
  repairs?: { code: string; path: string; reason: string }[];
  /** History entries on Home: why it is history. */
  historyReason?: "seen" | "removed" | "resolved" | "archived";
  /** History entries on Home: whether Home shows its source now (its owner may still edit Home). */
  currentSource?: boolean;
  /** The task this section is the card of and who answers for it (YN-86 S2a), as Core reads them now; absent for
   * a section that is no task's card, and from older Cores. */
  card?: CardBinding;
};

/**
 * A card's task and its responsible Agent (YN-86 §3.1, Core's cards.rs): the task's newest executor not yet
 * released, else its assignee, else nobody. Read each time, never stored.
 */
export type CardBinding = {
  /** `id` is the key the task has now (YN-90, T-12). */
  task: { id: string; title: string; shortName?: string | null; status: string; archived: boolean };
  responsible: {
    agentId: string;
    name: string;
    kind: "executor" | "lead" | "agent";
    /** An executor's lifecycle state; another Agent's status, or closed. */
    state: string;
  } | null;
};

export type BriefOutcome =
  | "updated"
  | "noChange"
  | "missing"
  | "reminded"
  | "remindFailed"
  | "skipped";

export type HomeJob = {
  id: string;
  name: string;
  status: string;
  agentId: string | null;
  agentName: string | null;
  taskRef?: string | null;
};

export type ContentEditors = { version: number; editorAgentIds: string[] | null };

export type ProjectPanel = {
  project: { id: string; name: string };
  contentEditors?: ContentEditors;
  agents: {
    working: number;
    idle: number;
    waiting: number;
    error: number;
    offline: number;
    total: number;
  };
  errors: { agentId: string; agentName: string; message: string; at: string }[];
  pending: (PendingRequest & { agentName: string })[];
  jobs: HomeJob[];
  brief: { version: number; sections: Section[]; teamSections?: Section[]; history: Section[] };
  /** Live sections changed since the user last read them: marked seen, or a
   * report opened whole (YN-86). */
  unseen: number;
  /** Recent turns that ended without an accepted Brief update. */
  missing: {
    agentId: string;
    agentName: string;
    turnId: string;
    at: string;
    outcome: BriefOutcome;
  }[];
};

export type NeedsYouItem = {
  kind: "approval" | "ask" | "question" | "executor";
  projectId: string | null;
  agentId: string;
  agentName: string;
  requestId?: string;
  sectionKey?: string;
  /** A question's Turn and Item (T-42). */
  turnId?: string;
  itemId?: string;
  /** An executor the user dispatched (T-36 S3): its result waits for the
   * user's release, its start failed, or its task is blocked while it runs. */
  state?: "delivering" | "failed" | "blocked";
  taskId?: string;
  reason?: string | null;
  /** An ask that is an executor's gate (T-43 S4): its executor waits for your answer. */
  gate?: AskGate;
  title: string;
  since: string;
};

/** The step of its task's template an executor's ask is the approval of (T-43 S4), counted from 0. */
export type AskGate = { taskId: string; step: number };

export type HomeData = {
  generatedAt: string;
  /** Project Priority: display order only. */
  order: string[];
  needsYou: NeedsYouItem[];
  projects: ProjectPanel[];
};

export type MachineLoad = {
  at: string;
  cpu: {
    cores: number;
    totalPct: number;
    jobsPct: number;
    agentsPct: number | null;
    otherPct: number | null;
  };
  memory: {
    totalMiB: number;
    usedMiB: number;
    availableMiB: number;
    jobsMiB: number;
    agentsMiB: number | null;
  };
  gpus:
    | {
        name: string;
        utilPct: number;
        memUsedMiB: number;
        memTotalMiB: number;
        attribution: "unknown";
      }[]
    | null;
  jobs: {
    id: string;
    name: string;
    agentId: string | null;
    agentName: string | null;
    projectId: string | null;
    cpuPct: number | null;
    memMiB: number | null;
  }[];
};

/**
 * GET /api/machine-live (YN-83 S1): each registered SSH machine's remote
 * session as Core has it now. Reading it records the user's interest and may
 * start a session, so Home reads it only while the machine card is expanded
 * and the page is visible. Unknown is null, never 0.
 */
export type MachineLiveState = "idle" | "connecting" | "online" | "offline" | "unavailable";

export type LiveMachine = {
  id: string;
  name: string;
  state: MachineLiveState;
  /** Offline: ssh_unreachable or silent. Unavailable: a transport code. */
  code: string | null;
  since: string;
  /** Only during an offline backoff: when a session may start again. */
  retryAt: string | null;
  /** When Core made this answer. */
  observedAt: string;
  /** Linux or Darwin, from the hello of a session online now. */
  platform: "Linux" | "Darwin" | null;
  /** Display only: `local` for this Core host, else the first machine above
   * with the same account key. Never a shared connection. */
  sameAs: string | null;
  /** Null unless online. Each reading is null once it is no longer fresh. */
  load: {
    cpu: { pct: number; cores: number | null; observedAt: string } | null;
    memory: { totalMiB: number; usedMiB: number; availableMiB: number; estimate: boolean; observedAt: string } | null;
    disks:
      | {
          roles: string[];
          totalMiB: number | null;
          availableMiB: number | null;
          observedAt: string | null;
          error: string | null;
          permanent: boolean | null;
        }[]
      | null;
    gpu: { state: "off"; code: "not_enabled" };
  } | null;
};

export type MachineLive = { machines: LiveMachine[] };
