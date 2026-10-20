import type { Agent } from "./types";

/**
 * Send to Agent (T-152): something in Yuzuno, passed to another Agent as text
 * the user adds to that Agent's draft and sends themselves. A snapshot taken
 * where it was picked up; nothing here sends, assigns or dispatches.
 */
export const HANDOFF_TYPE = "application/x-yuzuno-handoff";
export const MESSAGE_LIMIT = 4000;
export const SUMMARY_LIMIT = 1200;
export const ARTIFACT_LIMIT = 10;

/** Who wrote a message, apart from the user who forwards it. */
export type MessageAuthor =
  | { kind: "agent" }
  | { kind: "user" }
  | { kind: "mailbox" }
  | { kind: "reminder" };
/** Where a Job's files stay: this Core's host, an SSH machine or Windows on this PC. */
export type JobMachine =
  | { kind: "core" }
  | { kind: "ssh"; id: string; name: string }
  | { kind: "windows"; name: string };
export type HandoffSource =
  | {
      kind: "message";
      agentId: string;
      agentName: string;
      turnId: string;
      itemId: string;
      author: MessageAuthor;
      /** When the message appeared, in Unix ms, if known. */
      at: number | null;
      text: string;
      /** A selection from the message rather than all of it. */
      excerpt: boolean;
    }
  | {
      kind: "task";
      taskId: string;
      title: string;
      status: string;
      assignee: string | null;
      version: number;
      summary: string;
    }
  | {
      kind: "job";
      jobId: string;
      name: string;
      status: string;
      reason: string | null;
      finishedAt: string | null;
      machine: JobMachine;
      artifacts: string[];
    };

export function handoffLabel(source: HandoffSource) {
  if (source.kind === "task") return `task ${source.taskId}`;
  if (source.kind === "job") return `Job “${source.name}”`;
  return source.excerpt ? `an excerpt from ${source.agentName}` : `a message from ${source.agentName}’s conversation`;
}

/** Why this cannot go to that Agent, or null. */
export function handoffRefusal(source: HandoffSource, target: Agent | undefined): string | null {
  if (!target) return "That Agent is no longer in this Workspace.";
  if (target.closedAt) return `${target.name} is closed and cannot receive messages.`;
  if (source.kind === "message" && source.agentId === target.id)
    return `This already comes from ${target.name}’s conversation.`;
  if (source.kind === "message" && !source.text.trim()) return "There is no text to send.";
  return null;
}

/** Whether `target` reads files where the Job left them. */
export function sameMachine(machine: JobMachine, target: Agent) {
  if (machine.kind === "core") return !target.remote;
  if (machine.kind === "ssh") return target.remote?.machine.id === machine.id;
  return false;
}

/** The text added to `target`'s draft, in the voice of the user who sends it. */
export function handoffText(source: HandoffSource, target: Agent, now: Date): string {
  if (source.kind === "message") {
    const of = source.at === null ? "" : ` of ${utc(source.at)}`;
    const what =
      source.author.kind === "agent"
        ? `${source.excerpt ? "an excerpt of " : ""}${source.agentName}’s reply${of}. ${source.agentName} wrote it; I am passing it on.`
        : source.author.kind === "user"
          ? `${source.excerpt ? "an excerpt of " : ""}my message to ${source.agentName}${of}.`
          : source.author.kind === "mailbox"
            ? `${source.excerpt ? "an excerpt of " : ""}a Workspace mailbox notice ${source.agentName} received${of}. Yuzuno wrote it; I am passing it on.`
            : `${source.excerpt ? "an excerpt of " : ""}a Yuzuno reminder to ${source.agentName}${of}. Yuzuno wrote it; I am passing it on.`;
    return [
      `Forwarded from ${source.agentName}’s conversation: ${what}`,
      `(Turn ${source.turnId}, item ${source.itemId}. You cannot open that conversation; the quote below is what I am sending.)`,
      "",
      quote(bounded(source.text, MESSAGE_LIMIT, "characters")),
    ].join("\n");
  }
  if (source.kind === "task") {
    const assigned = source.assignee ? `assigned to ${source.assignee}` : "not assigned";
    const lines = [
      `For reference: task ${source.taskId} “${source.title}”, status ${source.status}, ${assigned}, version ${source.version}, as of ${utc(now.getTime())}. This does not assign it to you. Read its latest state with task_get(taskId="${source.taskId}").`,
    ];
    if (source.summary.trim()) lines.push("", quote(bounded(source.summary, SUMMARY_LIMIT, "characters")));
    return lines.join("\n");
  }
  const finished = source.finishedAt ? `, finished ${utc(Date.parse(source.finishedAt))}` : "";
  const lines = [
    `For reference: Job “${source.name}” (${source.jobId}), ${source.status}${finished}, as of ${utc(now.getTime())}. Read it with job_get(jobId="${source.jobId}").`,
  ];
  if (source.reason) lines.push(`Reason: ${bounded(source.reason, SUMMARY_LIMIT, "characters")}`);
  if (source.artifacts.length) {
    const shown = source.artifacts.slice(0, ARTIFACT_LIMIT).join(", ");
    const more = source.artifacts.length - ARTIFACT_LIMIT;
    lines.push(`Artifacts, on ${machineLabel(source.machine)}: ${shown}${more > 0 ? ` and ${more} more` : ""}.`);
    if (!sameMachine(source.machine, target))
      lines.push(`Those files are on ${machineLabel(source.machine)}, not where you run, so their paths will not open for you. Use job_get, or ask me for what you need from them.`);
  }
  return lines.join("\n");
}

function machineLabel(machine: JobMachine) {
  return machine.kind === "core" ? "this Core’s host" : machine.kind === "ssh" ? machine.name : `Windows on this PC (${machine.name})`;
}
function utc(ms: number) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "an unknown time";
}
function bounded(text: string, limit: number, unit: string) {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[… only the first ${limit} of ${text.length} ${unit} are included]`;
}
function quote(text: string) {
  return text.split(/\r\n|\r|\n/).map(line => (line ? `> ${line}` : ">")).join("\n");
}

/** The handoff a drag carries, or null for anything else. */
export function readHandoff(raw: string): HandoffSource | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  // Generous: the draft quotes only the start of a long message, but says how long it was.
  if (!value || typeof value !== "object" || raw.length > 8_000_000) return null;
  const v = value as Record<string, unknown>;
  const str = (key: string) => typeof v[key] === "string";
  if (v.kind === "message") {
    const author = v.author as { kind?: unknown } | null;
    return str("agentId") && str("agentName") && str("turnId") && str("itemId") && str("text") &&
      typeof v.excerpt === "boolean" && (v.at === null || typeof v.at === "number") &&
      !!author && ["agent", "user", "mailbox", "reminder"].includes(author.kind as string)
      ? (v as HandoffSource)
      : null;
  }
  if (v.kind === "task")
    return str("taskId") && str("title") && str("status") && str("summary") &&
      (v.assignee === null || str("assignee")) && Number.isSafeInteger(v.version)
      ? (v as HandoffSource)
      : null;
  if (v.kind === "job") {
    const machine = v.machine as Record<string, unknown> | null;
    const machineOk = !!machine && (machine.kind === "core" ||
      (machine.kind === "ssh" && typeof machine.id === "string" && typeof machine.name === "string") ||
      (machine.kind === "windows" && typeof machine.name === "string"));
    return str("jobId") && str("name") && str("status") && machineOk &&
      (v.reason === null || str("reason")) && (v.finishedAt === null || str("finishedAt")) &&
      Array.isArray(v.artifacts) && v.artifacts.every(a => typeof a === "string")
      ? (v as HandoffSource)
      : null;
  }
  return null;
}
