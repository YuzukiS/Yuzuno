import { errorText, HttpError, NetworkError } from "./api";
import { SnapshotTimeoutError } from "./snapshot-request";
import type { EventConnection } from "./useWorkspaceEvents";

/** All Core indicators use the same HTTP evidence. The legacy runtime field
 * describes the Codex catalog probe, not Core or every Agent's Harness.
 * `browserOffline` is the browser's own report (navigator.onLine): a guess
 * that can be wrong either way, so it is said beside that evidence and never
 * replaces it (T-170). */
export function coreConnection(
  hasSnapshot: boolean,
  error: unknown,
  events: EventConnection,
  preview = false,
  browserOffline = false,
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
      // A read that got no answer is a NetworkError (api.ts). An open event
      // stream still shows Core answering, unless the browser has since said
      // it is offline: then the stream may be dead without knowing it yet.
      // A malformed snapshot (for example invalid JSON) is an update failure,
      // not proof that Core is unreachable.
      label = error instanceof NetworkError && (events !== "open" || browserOffline)
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
  const browser = !preview && browserOffline ? "Browser reports offline" : "";
  return {
    label,
    detail,
    stream,
    browser,
    healthy: !preview && hasSnapshot && !error,
    description: `${label}. ${detail}${browser ? ` ${browser}.` : ""}${stream ? ` ${stream}.` : ""}`,
  };
}
