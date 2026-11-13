import { attentionRank, type TurnSeen } from "./attention";
import { strings } from "./i18n";
import type { Agent } from "./types";

/**
 * An executor's lifecycle as Core works it out (T-36 S3, Core's
 * executor_lifecycle.rs): the states, and the order their rules apply in,
 * are docs/executor-model.md "An executor's lifecycle".
 */
export type ExecutorState = "queued" | "starting" | "running" | "delivering" | "archiving" | "archived" | "failed" | "closed";

export type ExecutorLifecycle = {
  state: ExecutorState;
  agentId: string;
  /** Its task: `id` is the key it has now (YN-3), `T-<n>` while it has none (T-43 S2);
   * `shortName` what it is about in plain words, as a lead named it (T-43 R1). */
  task?: { id: string; title: string; shortName?: string | null } | null;
  /** The template it was made from (T-43 S2); `label` as its dispatch's materials give it, null for an older
   * dispatch. An empty `id` is an executor made from no template. */
  template?: { id: string; label?: string | null } | null;
  /** When it was dispatched: its time on the task starts here (T-43 S2). */
  dispatchedAt?: string | null;
  /** Who dispatched it; absent from a release's answer, which doesn't say. */
  dispatcher?: { kind: "user" } | { kind: "agent"; id: string; name?: string | null };
  since?: string | null;
  /** What an archiving one waits for, or why a start failed. */
  reason?: string | null;
  /** Its place in the queue, 1 first, while queued. */
  position?: number | null;
  /** Its task's blocker, while it runs on a blocked task. */
  blocked?: string | null;
  /** While it runs: when its task's newest result was handed in on its own dispatch (as doing, or its task no longer in
   * review; YN-92). Absent otherwise, and from an older Core's answer. */
  resultAt?: string | null;
  /** What executor routing gave it (YN-57 S4a), when its dispatch has a record; absent from an older Core's answer. */
  route?: ExecutorRoute | null;
  /** Its own temporary directory, or why it has none (YN-78 S2a); `usage` its latest measurement (S2c), absent
   * until one was made and from an older Core. */
  tempDir?: { path?: string; releasedAt?: string; note?: string; usage?: TempUsage | null } | null;
};

/** The latest measurement of an executor's temporary directory, as Core keeps it (YN-78 S2c): a byte count only from a
 * complete walk; otherwise unknown with a reason code. `lastMeasured` is the last byte count, with its own time. */
export type TempUsage = {
  revision: number;
  state: "measured" | "unknown";
  bytes: number | null;
  reason?: string | null;
  at: string;
  limitBytes: number;
  over?: boolean;
  lastMeasured?: { bytes: number; at: string } | null;
};

/** What routing gave an executor, as Core says it (docs/executor-model.md): chosen, with what it runs and its account
 * or key; waiting for a candidate, from when one's reason ends; or not routed and why. Never a key's value or an email. */
export type ExecutorRoute = (
  | { kind: "chosen"; candidate: string; label?: string; harness: string; model: string; effort?: string;
      credential: { kind: "login" } | { kind: "apiKey"; keyId: string } | { kind: "codexHome"; id: string }
        | { kind: "pool"; account: { fingerprint: string; number: number | null } } }
  | { kind: "waiting"; earliest?: string }
  | { kind: "unrouted"; why: string }
  /** The kind of work its dispatch wanted and whose that was (YN-70): `template`, `lead` or `user`; absent without one. */
) & { tier?: string; tierSource?: string };

export const lifecycleText = strings(
  {
    states: {
      queued: "Queued",
      starting: "Starting",
      running: "Running",
      delivering: "Handed in",
      archiving: "Archiving",
      archived: "Archived",
      failed: "Failed",
      closed: "Closed",
    } as Record<ExecutorState, string>,
    queuedAt: (position: number) => `Queued · ${position} in line`,
    queuedCandidate: "Queued · waiting for a routing candidate",
    executor: "Executor",
    executors: "Task executors",
    // How many wait for a slot and how many run (T-43 S2, g7): the queue
    // first, so a narrow rail that cuts the line keeps it.
    slotUse: (running: number, queued: number) => `${queued} queued · ${running} running`,
    slotUseTitle: "Running: started and not yet archived. Queued: waiting for an executor slot (each machine's limit, in Machines).",
    archived: "Archived",
    archivingReason: (reason: string) => `Archiving: ${reason}`,
    blocked: (blocker: string) => `Its task is blocked: ${blocker}`,
    byUser: "Dispatched by you",
    byAgent: (name: string) => `Dispatched by ${name}`,
  },
  {
    states: {
      queued: "排队中",
      starting: "启动中",
      running: "运行中",
      delivering: "已交",
      archiving: "归档中",
      archived: "已归档",
      failed: "失败",
      closed: "已关闭",
    },
    queuedAt: (position) => `排队中 · 第 ${position} 位`,
    queuedCandidate: "排队中 · 在等路由候选",
    executor: "执行者",
    executors: "任务执行者",
    slotUse: (running, queued) => `${queued} 排队 · ${running} 运行`,
    slotUseTitle: "运行：已启动、尚未归档。排队：在等执行者槽位（每台机器的上限，在「机器」里）。",
    archived: "已归档",
    archivingReason: (reason) => `归档中：${reason}`,
    blocked: (blocker) => `任务受阻：${blocker}`,
    byUser: "由你派发",
    byAgent: (name) => `由 ${name} 派发`,
  },
);

type Text = ReturnType<typeof lifecycleText>;

/** The state as the sidebar and the task card say it, with its place in the queue. */
export function stateLabel(lifecycle: ExecutorLifecycle, t: Text): string {
  // Waiting for a routing candidate is not a place in the slot queue (YN-57).
  if (lifecycle.state === "queued" && lifecycle.route?.kind === "waiting") return t.queuedCandidate;
  return lifecycle.state === "queued" && lifecycle.position ? t.queuedAt(lifecycle.position) : t.states[lifecycle.state];
}

/** What a title adds: why it is in that state, its task's blocker, who dispatched it. */
export function stateDetail(lifecycle: ExecutorLifecycle, t: Text): string[] {
  const lines: string[] = [];
  if (lifecycle.reason) lines.push(lifecycle.state === "archiving" ? t.archivingReason(lifecycle.reason) : lifecycle.reason);
  if (lifecycle.blocked) lines.push(t.blocked(lifecycle.blocked));
  const by = lifecycle.dispatcher;
  if (by) lines.push(by.kind === "user" ? t.byUser : t.byAgent(by.name || by.id));
  return lines;
}

/** An executor shown in a Project's 任务执行者 group: open, or failed while its
 * task is blocked on it. Archived ones go in the fold; closed ones only in Closed. */
export const inExecutors = (agent: Agent) =>
  agent.kind === "executor" && (!agent.closedAt || agent.executor?.state === "failed") && agent.executor?.state !== "archived";
export const isArchived = (agent: Agent) => agent.kind === "executor" && agent.executor?.state === "archived";

/** The executors' attention order (docs/executor-model.md): waiting on you,
 * or failed; delivered, awaiting release; running; archiving; queued or
 * starting. */
export function executorRank(agent: Agent, seen: TurnSeen): number {
  const state = agent.executor?.state;
  if (state === "failed" || (!agent.closedAt && attentionRank(agent, seen) === "needsYou")) return 0;
  if (state === "delivering") return 1;
  if (state === "archiving") return 3;
  if (state === "queued" || state === "starting") return 4;
  if (state === "closed" || state === "archived") return 5;
  return 2;
}

export type RailParts = { members: Agent[]; executors: Agent[]; archived: Agent[] };

/**
 * A Project's list in the sidebar's parts (T-36 S3): its leads, then its
 * other Agents, as given; then its executors (with `order`, the attention
 * order of executorRank, ties as given); and its archived executors.
 */
export function railParts(agents: readonly Agent[], order?: { seen: TurnSeen }): RailParts {
  const members = agents.filter((a) => a.kind !== "executor");
  const leads = members.filter((a) => a.kind === "lead");
  const executors = agents.filter(inExecutors);
  const ranked = order
    ? executors
        .map((agent, index) => ({ agent, index, rank: executorRank(agent, order.seen) }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map((r) => r.agent)
    : executors;
  return {
    members: [...leads, ...members.filter((a) => a.kind !== "lead")],
    executors: ranked,
    archived: agents.filter(isArchived),
  };
}
