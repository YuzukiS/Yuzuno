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
};

/**
 * A Live Reference as Core sees it now, keyed `${kind}:${id}`. Core reads
 * the current state; the Agent only names the item.
 */
export type LiveRefState = {
  kind: "task" | "pr" | "ci" | "job" | "review" | "agent" | "machine";
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
  observedAt?: string;
  /** For a task (T-9): who has it, null when no one does. */
  assignee?: { kind: string; id: string; name: string } | null;
  /** For a task: when its record last changed. */
  updatedAt?: string;
  /** For a task: archived. */
  archived?: boolean;
  /** Core could not read the item: not the same as not found. */
  unavailable?: boolean;
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
  };
  status?: { asOf: string; validFor: number; stale: boolean };
  time?: { due?: string; eta?: string; nextUpdate?: string };
  attachments: SectionAttachment[];
  /** Current state of every Live Reference in the body, keyed `${kind}:${id}`. */
  refs: Record<string, LiveRefState>;
  /** The version the user explicitly marked seen, never inferred. */
  seen: { version: number; at: string } | null;
  /** A seen report kept for 30 days, or a removed section. */
  history: boolean;
  /** History entries on Home: why it is history. */
  historyReason?: "seen" | "removed" | "resolved";
  /** History entries on Home: whether Home shows its source now (its owner may still edit Home). */
  currentSource?: boolean;
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
  /** Live sections changed since the user last marked them seen. */
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
  kind: "approval" | "ask";
  projectId: string | null;
  agentId: string;
  agentName: string;
  requestId?: string;
  sectionKey?: string;
  title: string;
  since: string;
};

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
