import { api } from "./api";
import type { ReadingPosition } from "./reading-position";
import { nextSeq, observeSeq, readingSource, sharedPosition, type Answer, type Handoff } from "./reading-handoff";

/* Core's side of reading-handoff.ts (T-170): publish where this browser left
   a conversation, and read where another left it. */
const path = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/reading`;

/** Sends where this browser left a conversation; best effort, once. A
 * failure (an older Core, no network) leaves local reading as it is. */
export function publishReading(workspaceId: string, agentId: string, position: ReadingPosition, label: Handoff["label"]) {
  const clientSeq = nextSeq(workspaceId);
  if (clientSeq === null) return;
  void api<Answer>(path(agentId), {
    method: "PUT",
    keepalive: true,
    body: JSON.stringify({ position: sharedPosition(position), source: readingSource(workspaceId), label, clientSeq }),
  })
    .then((answer) => observeSeq(workspaceId, answer?.sourceSeq))
    .catch(() => {});
}

/** The place Core holds for a conversation, or null (none, or an older Core). */
export async function readHandoff(workspaceId: string, agentId: string): Promise<Handoff | null> {
  try {
    const answer = await api<Answer>(`${path(agentId)}?source=${readingSource(workspaceId)}`);
    observeSeq(workspaceId, answer?.sourceSeq);
    return answer?.handoff ?? null;
  } catch {
    return null;
  }
}

