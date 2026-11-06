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
  /** Its task: `id` is the key it has now (YN-3), `T-<n>` while it has none (T-43 S2). */
  task?: { id: string; title: string } | null;
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
};

export const lifecycleText = strings(
  {
    states: {
      queued: "Queued",
      starting: "Starting",
      running: "Running",
      delivering: "Awaiting release",
      archiving: "Archiving",
      archived: "Archived",
      failed: "Failed",
      closed: "Closed",
    } as Record<ExecutorState, string>,
    queuedAt: (position: number) => `Queued · ${position} in line`,
    executor: "Executor",
    executors: "Task executors",
    // How many of them run and how many wait for a slot (T-43 S2, g7).
    slotUse: (running: number, queued: number) => `${running} running · ${queued} queued`,
    slotUseTitle: "Running: started and not released. Queued: waiting for an executor slot (Settings → Executor templates).",
    archived: "Archived",
    archivedToggle: (folded: boolean, count: number) => `${folded ? "Show" : "Hide"} ${count} archived ${count === 1 ? "executor" : "executors"}`,
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
      delivering: "交付待放行",
      archiving: "归档中",
      archived: "已归档",
      failed: "失败",
      closed: "已关闭",
    },
    queuedAt: (position) => `排队中 · 第 ${position} 位`,
    executor: "执行者",
    executors: "任务执行者",
    slotUse: (running, queued) => `${running} 运行 · ${queued} 排队`,
    slotUseTitle: "运行：已启动、尚未放行。排队：在等执行者槽位（设置 → 执行者模板）。",
    archived: "已归档",
    archivedToggle: (folded, count) => `${folded ? "显示" : "隐藏"} ${count} 个已归档的执行者`,
    archivingReason: (reason) => `归档中：${reason}`,
    blocked: (blocker) => `任务受阻：${blocker}`,
    byUser: "由你派发",
    byAgent: (name) => `由 ${name} 派发`,
  },
);

type Text = ReturnType<typeof lifecycleText>;

/** The state as the sidebar and the task card say it, with its place in the queue. */
export function stateLabel(lifecycle: ExecutorLifecycle, t: Text): string {
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
export function executorRank(agent: Agent, seen: TurnSeen, waiting?: ReadonlySet<string>): number {
  const state = agent.executor?.state;
  if (state === "failed" || (!agent.closedAt && attentionRank(agent, seen, waiting) === "needsYou")) return 0;
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
export function railParts(agents: readonly Agent[], order?: { seen: TurnSeen; waiting?: ReadonlySet<string> }): RailParts {
  const members = agents.filter((a) => a.kind !== "executor");
  const leads = members.filter((a) => a.kind === "lead");
  const executors = agents.filter(inExecutors);
  const ranked = order
    ? executors
        .map((agent, index) => ({ agent, index, rank: executorRank(agent, order.seen, order.waiting) }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map((r) => r.agent)
    : executors;
  return {
    members: [...leads, ...members.filter((a) => a.kind !== "lead")],
    executors: ranked,
    archived: agents.filter(isArchived),
  };
}
