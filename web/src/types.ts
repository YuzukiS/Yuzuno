export interface WorkSummary {
  requestParts?: import("./message-content").RequestPart[];
  text: string;
  kind: "task" | "progress" | "result" | "pending" | "error" | "interrupted";
  source: "user" | "agent" | "runtime";
  turnId?: string;
  itemId?: string;
  requestId?: string;
}
export interface Agent {
  workSummary?: WorkSummary | null;
  harness?: "codex" | "claude" | "opencode";
  claudeSessionId?: string;
  opencodeSessionId?: string;
  id: string;
  name: string;
  goal: string;
  cwd: string;
  model: string;
  settings?: AgentSettings;
  color: string;
  threadId?: string;
  status: "idle" | "working" | "waiting" | "offline" | "error" | "uncertain";
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  /** When the user disconnected this open Agent (T-184): its native session
   * stays stopped, and nothing starts it, until they reconnect it. */
  disconnectedAt?: string | null;
  unreadCount: number;
  pendingCount: number;
  lastMessage?: string;
  lastSeq: number;
  reviewedSeq: number;
  error?: string;
  remote?: {
    machine: {
      id: string;
      name: string;
      target: string;
      codex: string;
      defaultCwd: string;
    };
    runtime?: {
      root: string;
      socket: string;
      pid: number;
      codex: string;
      instanceId: string;
    } | null;
  };
  connectionState?: "connecting" | "connected" | "disconnected" | "unconfirmed";
  /** This Core's revision of the record as read (see the event stream). */
  rev?: number | null;
  /** Explicit membership; absent means no project. */
  projectId?: string | null;
}
export interface Project {
  id: string;
  name: string;
  /** Machine ID to the folder that pre-fills new agents there. */
  defaultDirs: Record<string, string>;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectUsage {
  agents: number;
  tasks: number;
}
export interface Workspace {
  workspace?: { id: string };
  projects?: Project[];
  projectUsage?: Record<string, ProjectUsage>;
  agents: Agent[];
  runtime: {
    connected: boolean;
    version?: string;
    account?: string;
    error?: string;
  };
  defaultCwd: string;
  /** Whether this Core creates OpenCode Agents (an experimental switch). */
  opencode?: { enabled: boolean; version?: string };
}
export interface NativeItem {
  _yuzunoTextBlocks?: import("./message-content").TextBlock[];
  _yuzunoInputText?: string;
  id: string;
  type: string;
  /** A particular collaboration reminder added to an existing turn, or
   * Yuzuno's reminder that a turn ended without a Brief update. */
  _yuzunoSource?: "peer" | "brief-reminder";
  _yuzunoMailbox?: import("./MailboxNotice").MailboxSnapshot;
  /**
   * A follow-up sent while Claude worked: "queued" until Claude names it as
   * read, "unknown" if its connection ended first (it is not sent again).
   */
  _yuzunoDelivery?: "queued" | "unknown";
  /**
   * The message a new Claude Turn starts with, by its sender's client ID,
   * set with the Turn before Claude's bridge answers. Unlike `clientId` it
   * confirms nothing; see delivery-note's `sendingInTurn` (T-120).
   */
  _yuzunoClientMessageId?: string;
  /**
   * Core record of when a message first appeared, in Unix ms: "codex" is the
   * Harness's own item time, "core" is when Core received it live, "claude"
   * is the time Claude saved it with (filled in from its saved history). Not
   * a native field; history items usually have none.
   */
  _yuzunoTime?: { at: number; source: "codex" | "core" | "claude" };
  /** Filled in from what Claude saved after Core lost the connection (T-22). */
  _yuzunoSaved?: boolean;
  /** Reply text that streamed live but that Claude never saved: may be incomplete. */
  _yuzunoUnsaved?: boolean;
  /** The uuid a Claude prompt was sent with, which names it in Claude's saved history. */
  nativeUuid?: string;
  text?: string;
  /** Codex's own review (`/review`): on `enteredReviewMode` what it
   * reviews, on `exitedReviewMode` its findings. */
  review?: string;
  phase?: string;
  delivery?: string;
  questions?: { title: string; options?: string[] }[] | null;
  content?: { type: string; text?: string; url?: string; path?: string }[];
  command?: string;
  aggregatedOutput?: string;
  status?: string;
  exitCode?: number | null;
  changes?: { path: string; kind?: { type?: string }; diff?: string }[];
  summary?: string[];
  /** Fields Core sent as previews; the full values are fetched on request. */
  _yuzunoTruncated?: Record<string, TruncatedField>;
  [key: string]: unknown;
}
/** A field Core shortened for the snapshot (see core/src/client_view.rs). */
export interface TruncatedField {
  /** Full size: a string's UTF-8 length, else its JSON size. */
  bytes: number;
  /** Line count of a string field. */
  lines?: number;
  /** Which end of the value the preview shows. */
  keep: "head" | "tail";
  /** File changes left out of the preview. */
  omitted?: number;
  /** Kept file changes whose diff is shortened or empty in the preview. */
  cutDiffs?: number[];
}
export interface NativeTurn {
  _yuzunoIndex?: boolean;
  _yuzunoRequestCount?: number;
  /** Body slice in the saved history window; Copy turn loads the original. */
  _yuzunoSlice?: { start: number; total: number; index: number };
  /** Read-only evidence: this question-bearing Turn predates Codex import/fork. */
  _yuzunoImportedQuestions?: boolean;
  id: string;
  status: string;
  items: NativeItem[];
  error?: unknown;
  /** Set when you ended this Turn because Codex's own history didn't have it
   * (T-198): when it was found missing and when you ended it. */
  missingNative?: { checkedAt: string; endedAt: string } | null;
  /** Native turn start and completion, in Unix seconds. */
  startedAt?: number | null;
  completedAt?: number | null;
  /** Native turn duration in milliseconds, if the Harness knows it. */
  durationMs?: number | null;
  /** Core-observed turn/compaction starts, in Unix milliseconds. */
  _yuzunoStartedAt?: number | null;
  /** When Core saw this turn end live, in Unix milliseconds. */
  _yuzunoCompletedAt?: number | null;
  /** Claude SDK result duration_ms, kept by Core on its turn record. */
  _yuzunoDurationMs?: number | null;
  _yuzunoCompactionStartedAt?: number | null;
  /**
   * Provenance supplied by Core: "peer" from a recorded collaboration
   * delivery; "native" for a Claude turn no prompt of yours started;
   * "brief-reminder" for the turn Yuzuno started because a Codex turn
   * ended without a Brief update.
   */
  _yuzunoSource?: "peer" | "native" | "brief-reminder";
  _yuzunoMailbox?: import("./MailboxNotice").MailboxSnapshot;
  /** Claude SDK result origin.kind of a "native" turn, once it ends. */
  _yuzunoOrigin?: string;
  /**
   * A "native" turn whose output arrived while a message of yours was in
   * progress and that nothing matched to it or to Claude itself.
   */
  _yuzunoUnmatched?: boolean;
  /** Last plan from native turn/plan/updated, without inventing a conversation Item. */
  _yuzunoPlan?: { step: string; status: string }[];
  /** Live contextCompaction item ID; omitted when execution is unconfirmed. */
  _yuzunoCompactionId?: string | null;
  /** Interactive results published in this Turn with result_publish: the
   * latest version of each, in publication order (see core/src/results.rs). */
  _yuzunoResults?: PublishedResultRef[];
}
export interface PublishedResultRef {
  /** This version's resultId; a version never changes. */
  id: string;
  chainId: string;
  version: number;
  createdAt: string;
}
export interface PendingRequest {
  id: string;
  agentId: string;
  method: string;
  params: Record<string, any>;
  createdAt: string;
  stale?: boolean;
}
export interface Artifact {
  path: string;
  name: string;
  kind: "text" | "image" | "file";
  sourceItemId?: string;
}
// Local preview state; line references are never sent to the Core API.
export interface ArtifactPreview extends Artifact {
  line?: number;
}
/**
 * Background shells the Harness reports for the live runtime connection.
 * "unknown" means an earlier count can no longer be confirmed; it is never 0.
 */
export type BackgroundShells =
  | { state: "known"; count: number; checkedAt: number }
  | { state: "unknown"; lastCount: number; checkedAt: number };
/** A Codex conversation's mode as its live connection's Codex reported it
 * (core/src/codex_plan.rs): from its resume answer or its settings report.
 * `switch` is the user's switch that Codex has not reported yet. */
export interface CodexPlanState {
  generation: number;
  reported: { mode: string; source: "resume" | "settings"; observedAt: string } | null;
  switch: { to: "plan" | "default"; state: "sending" | "accepted" | "unknown"; requestedAt: string } | null;
}
/** A call Core lists from outside the window while its task runs: its
 * preview, at its Turn's and its own position in the record. */
export interface RunningCall {
  turnId: string;
  position: [turn: number, item: number];
  item: NativeItem;
}
export type RunningSubAgent = RunningCall;
export interface AgentDetail {
  conversation?: {
    index: (NativeTurn & { number: number; itemCount: number })[];
    questions: NativeTurn[];
    /** Claude sub-agents still running whose calls are outside this window
     * (core/src/conversation_window.rs): each call's preview, at its Turn's
     * and its own position in the record. */
    runningSubAgents?: RunningSubAgent[];
    /** Claude's background tasks (shells, monitors) still running, starting
     * or paused whose calls are outside this window, likewise. */
    runningBackgroundTasks?: RunningCall[];
    nativeClientIds: string[];
    start: string | null;
    end: string | null;
    hasBefore: boolean;
    hasAfter: boolean;
    totalItems: number;
  };
  collaboration?: { ready: boolean; error?: string; reason?: string } | null;
  agent: Agent;
  turns: NativeTurn[];
  pending: PendingRequest[];
  artifacts: Artifact[];
  contextUsage?: ContextUsage | null;
  backgroundShells?: BackgroundShells;
  codexPlan?: CodexPlanState;
  messageReceipts?: MessageReceipt[];
  claudeRuntime?: ClaudeRuntime | null;
  codexHandoff?: CodexHandoff | null;
  history?: SessionHistory;
}
export interface SessionHistory {
  nextCursor: string | null;
  hasMore: boolean;
  loadedCount?: number;
  totalCount?: number;
}
/** Facts reported by the native Claude Code runtime, for display only. */
/** One side of an explicit official Codex fork between two Agents. */
export interface ForkLink {
  agentId: string;
  threadId: string;
  throughTurnId: string;
  turnCount: number;
  at: string;
}
export interface CodexHandoff {
  /** Another client's writer last refused to let Yuzuno continue. */
  writerConflictAt?: string | null;
  forkedTo?: ForkLink | null;
  forkedFrom?: ForkLink | null;
  /** Unfinished Turns the native history, read to its end, doesn't have
   * (T-198): Codex never saved them, so their result is unknown. */
  missingTurns?: MissingTurns | null;
}
export interface MissingTurns {
  turnIds: string[];
  threadId: string;
  /** The connection whose check found them; ending them names it. */
  generation: number;
  /** What Codex said the thread was doing then: "idle", "active", ... */
  nativeStatus: string;
  checkedAt: string;
}
export interface ForkPreview {
  sourceThreadId: string;
  throughTurnId: string | null;
  /** When the boundary Turn completed, in Codex seconds. */
  throughCompletedAt: number | null;
  includedTurns: number;
  excludedTurns: number;
  name: string;
  cwd: string;
  model: string;
  reasoningEffort: string | null;
  permissionPreset: string | null;
  projectId: string | null;
  forkedTo: ForkLink | null;
  warnings: string[];
}
export interface ForkOutcome {
  state: "completed" | "failed" | "uncertain";
  requestId: string;
  agent: Agent | null;
  connected: boolean;
  message: string | null;
  warnings: string[];
}
export interface ClaudeRuntime {
  account?: {
    email?: string;
    organization?: string;
    subscriptionType?: string;
    apiProvider?: string;
  } | null;
  version?: string | null;
  /** What this session's bridge started with (runtimes/claude/bridge.mjs runtimeProvenance). */
  provenance?: ClaudeProvenance | null;
  model?: string | null;
  /** Mode the live session reports; the user's choice is settings.permissionMode. */
  permissionMode?: string | null;
  contextWindow?: number | null;
  /** Native rate_limit_info, verbatim. */
  rateLimits?: Record<string, any> | null;
  rateLimitsAt?: string | null;
  /** Effort Claude Code reported for a turn; the choice is settings.reasoningEffort. */
  effort?: ClaudeEffort | null;
}
export interface ClaudeProvenance {
  cli?: {
    path?: string;
    /** The PATH entry that matched, before symlinks were resolved. */
    found?: string;
    source?: "path" | "explicit";
    version?: string;
    versionSource?: "init" | "--version";
  };
  sdk?: { version?: string; builtInCli?: string };
  compatibility?: "built-in" | "verified" | "older" | "unverified" | "unknown";
}
export interface ClaudeEffort {
  level: string;
  turnId?: string | null;
}
export interface CodexContextSettings {
  supported: boolean;
  inheritedContextWindow?: number | null;
  inheritedAutoCompactTokenLimit?: number | null;
  settingsSubmitted: boolean;
  requestedWindowTokens?: number | null;
  canApply: boolean;
  needsFirstTurn?: boolean;
  needsReconnect?: boolean;
  observedWindowTokens?: number | null;
  observedStale: boolean;
}
export interface AgentSettings {
  contextWindow?: number | null;
  autoCompactTokenLimit?: number | null;
  reasoningEffort: string | null;
  approvalPolicy: "on-request" | "untrusted" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  permissionPreset?: "config" | "ask" | "auto" | "full" | null;
  /** Claude Code native permission mode, as last selected or reported. */
  permissionMode?: string | null;
}
export interface PermissionCatalog {
  presets: {
    id: NonNullable<AgentSettings["permissionPreset"]>;
    available: boolean;
    reason?: string;
    permissions?: {
      approvalPolicy: unknown;
      approvalsReviewer: string;
      sandbox: string;
      profile: string | null;
    };
  }[];
}
export interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
  usedPercent: number;
  turnId: string;
  updatedAt: string;
  stale: boolean;
}
export interface QuestionSource {
  turnId: string;
  itemId: string;
}
/** A Codex skill a message invokes: its name and path on the Agent's machine. */
export interface SkillRef {
  name: string;
  path: string;
}
export interface MessageInput {
  textBlocks?: import("./message-content").TextBlock[];
  /** Codex only. Sent beside the input; Core keeps them on the receipt. */
  skills?: SkillRef[];
  clarification?: import("./intelligent-ui/clarification").ClarificationAnswer;
  images?: string[];
  clientMessageId: string;
  text: string;
  expectedTurnId: string | null;
  question: QuestionSource | null;
}
export interface MessageReceipt {
  binding?: { turnId: string; itemId: string; userIndex: number };
  input: MessageInput;
  skills?: SkillRef[];
  /**
   * Claude adds "queued" (sent to Claude, not yet read) and "unknown" (its
   * connection ended before it said it read it; never sent again).
   */
  status: "sending" | "queued" | "accepted" | "rejected" | "uncertain" | "unknown";
  turnId: string | null;
  error: string | null;
}
export interface Model {
  inputModalities?: string[];
  id: string;
  model: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  supportsAutoMode?: boolean;
  /** Claude: whether the model takes a reasoning effort, and which levels. */
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: {
    reasoningEffort: string;
    description: string;
  }[];
}
export interface CatchupItem {
  id: string;
  agentId: string;
  agentName: string;
  kind: "pending" | "result" | "error" | "progress";
  title: string;
  body: string;
  turnId?: string;
  itemId?: string;
  seq: number;
}
export interface Catchup {
  generatedAt: string;
  items: CatchupItem[];
  summary?: string;
  source: "records" | "model";
  coverage: { fromSeq: number; toSeq: number };
}
