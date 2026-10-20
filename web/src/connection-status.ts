import { errorText, HttpError } from "./api";
import { SnapshotTimeoutError } from "./snapshot-request";
import type { EventConnection } from "./useWorkspaceEvents";

/** All Core indicators use the same HTTP evidence. The legacy runtime field
 * describes the Codex catalog probe, not Core or every Agent's Harness. */
export function coreConnection(
  hasSnapshot: boolean,
  error: unknown,
  events: EventConnection,
  preview = false,
) {
  let label = "Connecting to Core";
  let detail = "Waiting for the first workspace snapshot.";
  if (preview) {
    label = "Preview · no Core";
    detail = "Read-only design preview; no runtime is connected.";
  } else if (error) {
    if (error instanceof HttpError) {
      label = "Core update failed";
      detail = `Workspace request returned HTTP ${error.status}. ${errorText(error)}`;
    } else if (error instanceof SnapshotTimeoutError) {
      label = "Core request timed out";
      detail = "No workspace snapshot arrived within 10 seconds.";
    } else {
      // Fetch network failures are TypeError. A malformed snapshot (for example
      // invalid JSON) is an update failure, not proof that Core is unreachable.
      label = error instanceof TypeError && events !== "open"
        ? "Core unreachable"
        : "Core update failed";
      detail = `Could not refresh the workspace snapshot. ${errorText(error)}`;
    }
    detail += hasSnapshot
      ? " Showing the last loaded data; drafts are kept."
      : " Drafts are kept; the next refresh will try again.";
  } else if (hasSnapshot) {
    label = "Core connected";
    detail = "The latest workspace snapshot loaded successfully.";
  }
  const stream = preview ? "" : {
    connecting: "Live updates connecting",
    open: "Live updates connected",
    reconnecting: "Live updates reconnecting · refreshing every 5s while visible",
  }[events];
  return {
    label,
    detail,
    stream,
    healthy: !preview && hasSnapshot && !error,
    description: `${label}. ${detail}${stream ? ` ${stream}.` : ""}`,
  };
}
