/** GET /api/backlog: native events Core has received but not yet applied,
 * per connected Agent (core/src/backlog.rs). An Agent that is missing has no
 * connection Core can see; its backlog is unknown. */
export type BacklogRead = {
  observedAt: string;
  agents: Record<
    string,
    { generation: number; pending: number; oldestMs: number }
  >;
};

/** Behind: the oldest event Core has not finished applying has waited this
 * long, in two reads in a row. Applying an event normally takes milliseconds,
 * and a burst of thousands catches up within about a second. */
export const BEHIND_MS = 5000;
export const READ_EVERY_MS = 5000;

/** Consecutive reads in which each Agent was at least `BEHIND_MS` behind. */
export type Streaks = Record<string, number>;

/** The next streaks after a read; no read (failed, disconnected, hidden)
 * forgets them all, so nothing stale is shown. */
export function nextStreaks(
  previous: Streaks,
  read: BacklogRead | null,
): Streaks {
  const next: Streaks = {};
  if (!read) return next;
  for (const [id, agent] of Object.entries(read.agents)) {
    if (agent.oldestMs >= BEHIND_MS) next[id] = (previous[id] ?? 0) + 1;
  }
  return next;
}

export function behindAgents(streaks: Streaks, read: BacklogRead | null) {
  if (!read) return [];
  return Object.entries(streaks)
    .filter(([id, streak]) => streak >= 2 && read.agents[id])
    .map(([id]) => ({ id, ...read.agents[id] }));
}
