import type { AgentDetail } from "./types";

/**
 * The effort Claude Code last reported, and whether it was for the latest
 * turn. The loaded turns may be an older window of the conversation, so the
 * latest turn comes from the conversation index of every turn; a detail
 * without one has all its turns loaded. A running turn has not reported yet.
 */
export function observedEffort(detail?: AgentDetail | null) {
  const effort = detail?.claudeRuntime?.effort;
  if (!effort?.level) return null;
  const latest =
    detail?.conversation?.index.at(-1)?.id ?? detail?.turns.at(-1)?.id;
  return { level: effort.level, latest: !!latest && effort.turnId === latest };
}
