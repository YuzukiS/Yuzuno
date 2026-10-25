import { errorText, HttpError, NetworkError } from "./api";
import { strings, type Language } from "./i18n";
import { SnapshotTimeoutError } from "./snapshot-request";
import type { EventConnection } from "./useWorkspaceEvents";

type State = "connecting" | "preview" | "failed" | "timedOut" | "unreachable" | "connected";

// What this window says about Core (T-189); the error's own words, and
// Core's, are shown as they came.
const words = strings({
  labels: {
    connecting: "Connecting to Core",
    preview: "Preview · no Core",
    failed: "Core update failed",
    timedOut: "Core request timed out",
    unreachable: "Core unreachable",
    connected: "Core connected",
  } as Record<State, string>,
  waiting: "Waiting for the first workspace snapshot.",
  preview: "Read-only design preview; no runtime is connected.",
  http: (status: number, error: string) => `Workspace request returned HTTP ${status}. ${error}`,
  timedOut: "No workspace snapshot arrived within 10 seconds.",
  notRefreshed: (error: string) => `Could not refresh the workspace snapshot. ${error}`,
  kept: " Showing the last loaded data; drafts are kept.",
  retrying: " Drafts are kept; the next refresh will try again.",
  connected: "The latest workspace snapshot loaded successfully.",
  stream: {
    connecting: "Live updates connecting",
    open: "Live updates connected",
    reconnecting: "Live updates reconnecting · refreshing every 5s while visible",
  } as Record<EventConnection, string>,
  browser: "Browser reports offline",
  description: (label: string, detail: string, browser: string, stream: string) =>
    `${label}. ${detail}${browser ? ` ${browser}.` : ""}${stream ? ` ${stream}.` : ""}`,
}, {
  labels: {
    connecting: "正在连接 Core",
    preview: "预览 · 无 Core",
    failed: "Core 更新失败",
    timedOut: "Core 请求超时",
    unreachable: "无法连接 Core",
    connected: "Core 已连接",
  },
  waiting: "正在等待第一份 Workspace 快照。",
  preview: "只读的设计预览；未连接任何运行时。",
  http: (status, error) => `Workspace 请求返回 HTTP ${status}（${error}）。`,
  timedOut: "10 秒内没有收到 Workspace 快照。",
  notRefreshed: (error) => `无法刷新 Workspace 快照（${error}）。`,
  kept: "正在显示上次加载的数据；草稿会保留。",
  retrying: "草稿会保留；下一次刷新会再试。",
  connected: "最新的 Workspace 快照已成功加载。",
  stream: {
    connecting: "实时更新正在连接",
    open: "实时更新已连接",
    reconnecting: "实时更新正在重新连接 · 窗口可见时每 5 秒刷新一次",
  },
  browser: "浏览器报告离线",
  description: (label, detail, browser, stream) => `${label}。${detail}${browser ? `${browser}。` : ""}${stream ? `${stream}。` : ""}`,
});

/** All Core indicators use the same HTTP evidence. The legacy runtime field
 * describes the Codex catalog probe, not Core or every Agent's Harness.
 * `browserOffline` is the browser's own report (navigator.onLine): a guess
 * that can be wrong either way, so it is said beside that evidence and never
 * replaces it (T-170). Worded in `language`; `status` is the English label,
 * kept for scripts and tests that read data-core-status. */
export function coreConnection(
  hasSnapshot: boolean,
  error: unknown,
  events: EventConnection,
  preview = false,
  browserOffline = false,
  language: Language = "en",
) {
  const w = words(language);
  let state: State = "connecting";
  let detail = w.waiting;
  if (preview) {
    state = "preview";
    detail = w.preview;
  } else if (error) {
    if (error instanceof HttpError) {
      state = "failed";
      detail = w.http(error.status, errorText(error));
    } else if (error instanceof SnapshotTimeoutError) {
      state = "timedOut";
      detail = w.timedOut;
    } else {
      // A read that got no answer is a NetworkError (api.ts). An open event
      // stream still shows Core answering, unless the browser has since said
      // it is offline: then the stream may be dead without knowing it yet.
      // A malformed snapshot (for example invalid JSON) is an update failure,
      // not proof that Core is unreachable.
      state = error instanceof NetworkError && (events !== "open" || browserOffline)
        ? "unreachable"
        : "failed";
      detail = w.notRefreshed(errorText(error));
    }
    detail += hasSnapshot ? w.kept : w.retrying;
  } else if (hasSnapshot) {
    state = "connected";
    detail = w.connected;
  }
  const label = w.labels[state];
  const stream = preview ? "" : w.stream[events];
  const browser = !preview && browserOffline ? w.browser : "";
  return {
    label,
    status: words("en").labels[state],
    detail,
    stream,
    browser,
    healthy: !preview && hasSnapshot && !error,
    description: w.description(label, detail, browser, stream),
  };
}
