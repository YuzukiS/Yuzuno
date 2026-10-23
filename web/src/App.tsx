import { ImageAttachments, inputImageUrl } from "./ImageAttachments";
import { SkillChips } from "./SkillChips";
import { MAX_DRAFT_SKILLS } from "./composer-draft";
import { useImageUploads } from "./useImageUploads";
import { PointFix, imageRefusal } from "./PointFix";
import { PointFixOpen, type PointFixSource } from "./point-fix";
import { appendImage, MAX_IMAGES, MAX_IMAGE_TOTAL, type DraftImage } from "./image-input";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  History,
  House,
  Link2,
  ImagePlus,
  SquareDashedMousePointer,
  Leaf,
  LoaderCircle,
  MessageSquare,
  Monitor,
  PanelLeft,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Square,
  WifiOff,
  X,
} from "lucide-react";
import {
  artifactUrl,
  errorText,
  isNative,
  isTauri,
  openDesktopConnection,
  post,
  reconnectAgent,
  shortcutModifier,
} from "./api";
import { nativeControl } from "./slash-commands";
import { touchKeyboard } from "./touch-input";
import {
  ArtifactModal,
  Avatar,
  Modal,
  PendingCard,
  Turn,
  Yuzu,
} from "./components";
import {
  previewContextPercent,
  previewDetail,
  previewMode,
  previewWorkspace,
} from "./preview";
import type {
  Agent,
  ArtifactPreview,
  CatchupItem,
  Model,
  PendingRequest,
  Project,
  Workspace,
  WorkSummary,
} from "./types";
import { UpdateBanner, WorkspaceUpdatesHost } from "./WorkspaceUpdates";
import { RemoteCreateAgent, type CreateInitial } from "./RemoteCreateAgent";
import { useSessionHistory } from "./useSessionHistory";
import { useSavedPages } from "./useSavedPages";
import { MessageLinks, messageLinkHref, parseMessageLink, type MessageLink, type MessageLinkApi } from "./deep-link";
import { localReadingPositions, readingAnchor, type ReadingPosition } from "./reading-position";
import { ageText, markOfferHandled, offerable, restoredOffset, type Handoff } from "./reading-handoff";
import { publishReading, readHandoff } from "./reading-handoff-api";
import { MachineBadge, RemoteControls } from "./RemoteControls";
import { ConversationSearch } from "./ConversationSearch";
import { hasAgentContent, isCompacting } from "./conversation-blocks";
import { ContextUsage } from "./ContextUsage";
import { AgentSettings } from "./AgentSettings";
import { agentHarnessName, nativeSession } from "./machine-checks";
import { observedEffort } from "./claude-effort";
import { CodexWriterNotice, ForkCodexDialog } from "./ForkCodexSession";
import { CodexReviewDialog, startCodexReview } from "./CodexReview";
import { CodexGoalDialog } from "./CodexGoal";
import { CodexPlanChip, CodexPlanDialog } from "./CodexPlan";
import { RecoveryNotice, recoveryReason } from "./RecoveryNotice";
import { AutoContinueSetting, QuotaResumeNotice } from "./QuotaResume";
import { ClaudeRuntimeFacts } from "./ClaudeControls";
import { ClaudeMcpStatus } from "./ClaudeMcpStatus";
import { CodexMcpStatus } from "./CodexMcpStatus";
import { CodexChangesDialog } from "./CodexChanges";
import { CodexDiffDialog } from "./CodexDiff";
import { CodexTerminalsDialog } from "./CodexTerminals";
import { latestTurnWithEdits } from "./changes";
import { CodexPlanUsage } from "./CodexPlanUsage";
import { AgentManagement, type AgentAction } from "./AgentManagement";
import { useConversationSend } from "./useConversationSend";
import { ClarificationHost } from "./intelligent-ui/ClarificationHost";
import { AgentRailRow, summaryOrigin, workingFolder } from "./AgentRailRow";
import { RailHeading } from "./RailHeading";
import { GroupedAgents } from "./ProjectGroups";
import { groupAgents } from "./project-groups";
import { useAppearance } from "./appearance";
import { StatusBar } from "./StatusBar";
import { useAutoRead } from "./useAutoRead";
import { PanelResizeHandle, usePanelWidths } from "./ResizablePanels";
import { CollaborationBoard } from "./CollaborationBoard";
import { MachinesPage } from "./MachinesPage";
import {
  AgentProjectPicker,
  ProjectManager,
  ProjectSwitcher,
} from "./ProjectWorkspace";
import {
  ALL_PROJECTS,
  inScope,
  pendingElsewhere,
  projectName,
  scopeForAgent,
  scopeProjectId,
  scopeStorageKey,
  validScope,
  type ProjectScope,
} from "./projects";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { ResultRequest } from "./intelligent-ui/ResultRequest";
import { pruneResultViewCache } from "./intelligent-ui/view-storage";
import { useSnapshot } from "./useSnapshot";
import { POLL_MS, SAFETY_NET_MS, useWorkspaceEvents } from "./useWorkspaceEvents";
import { useBrowserOffline, watchBrowserNetwork } from "./browser-offline";
import type { WorkspaceEvent } from "./workspace-events.ts";
import { useAgentDetail } from "./useAgentDetail";
import { useRefreshTrigger } from "./refresh-trigger";
import { coreConnection } from "./connection-status";
import "./connection-status.css";
import { OutgoingMessages } from "./OutgoingMessages";
import { sendingInTurn } from "./delivery-note";
import { CurrentTurnPrompt } from "./CurrentTurnPrompt";
import { Jobs, ConversationJobs } from "./Jobs";
import { ConversationSubAgentDock } from "./ClaudeSubAgentDock";
import { ConversationBackgroundTaskDock } from "./ClaudeBackgroundTasks";
import { refreshLiveJobs } from "./live-jobs";
import { clearLiveCI, refreshLiveCI } from "./live-ci";
import { TurnNavigator } from "./TurnNavigator";
import { ConversationWindow, ConversationRows } from "./ConversationWindow";
import { ConversationMetadata } from "./ConversationMetadata";
import { moveWindow, useCustomFrame, WindowControls } from "./WindowControls";
import { conversationTimeMarks } from "./conversation-time";
import { PastedTextComposer, type ComposerHandle } from "./PastedTextComposer";
import { draftTextBlocks } from "./message-content";
import { RequestSummary } from "./MessageContent";
import { appendDraft, draftText, hasDraftContent, type ComposerDraft } from "./composer-draft";
import { HandoffContext, HandoffDropStrip, type HandoffApi } from "./SendToAgent";
import { handoffLabel, handoffRefusal, handoffText, type HandoffSource } from "./handoff";
import { useComposerDraft } from "./useComposerDraft";
import { DraftRecovery } from "./DraftRecovery";
import { PendingQuestions, type PendingQuestionsHandle } from "./PendingQuestions";
import { QuestionIndex, questionKey } from "./pending-questions";
import { pruneRequestDrafts } from "./request-draft";
import { usePhone } from "./phone-layout";
import type { QuestionSource } from "./types";
import { Home, type HomeTarget } from "./home/Home";
import { useOpenAsks } from "./home/open-asks";

// Core fits a large image to Yuzuno's Claude budget (core/src/input_images.rs).
const CLAUDE_IMAGE_NOTE = "Large images are scaled or compressed when sent to Claude · originals are kept";

const statusLabels: Record<Agent["status"], string> = {
  idle: "Ready",
  working: "Working",
  waiting: "Waiting",
  offline: "Offline",
  error: "Needs a look",
  uncertain: "Check result",
};
type TurnProps = ComponentProps<typeof Turn>;
/** Streamed changes replace only the Turn they touch; the others keep their
 * identity and are not rendered again. Callbacks are compared by presence
 * only: App passes ones that always call its latest handlers. */
const LiveTurn = memo(Turn, (a: TurnProps, b: TurnProps) =>
  a.turn === b.turn &&
  a.index === b.index &&
  a.loadedNumbering === b.loadedNumbering &&
  a.isLatestAgentTurn === b.isLatestAgentTurn &&
  a.sourceItemId === b.sourceItemId &&
  a.pendingToolIds === b.pendingToolIds &&
  a.highlightSource === b.highlightSource &&
  a.receipts === b.receipts &&
  a.sendingInTurn === b.sendingInTurn &&
  a.agent.id === b.agent.id &&
  a.agent.name === b.agent.name &&
  a.agent.color === b.agent.color &&
  a.agent.harness === b.agent.harness &&
  a.agent.status === b.agent.status &&
  !a.onAnswer === !b.onAnswer &&
  !a.onRewindDraft === !b.onRewindDraft &&
  a.questionSources === b.questionSources &&
  !a.onOpenQuestion === !b.onOpenQuestion &&
  !a.onResultInteract === !b.onResultInteract,
);
function readStorage<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private storage can be unavailable. */
  }
}
// A stable empty list, so the sub-agent dock's memo holds without a detail.
const EMPTY_TURNS: never[] = [];

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(
    previewMode ? previewWorkspace : null,
  );
  const [selected, setSelected] = useState<string>(() =>
    previewMode ? "mikan" : readStorage("yuzuno.selected", ""),
  );
  // The shown Agent's detail: read once, then patched from the event stream.
  const live = useAgentDetail(previewMode ? null : selected || null);
  const previewShown = useMemo(
    () => (previewMode && selected ? previewDetail(selected) : null),
    [selected],
  );
  const detail = previewMode ? previewShown : live.detail;
  const [workspaceFailure, setWorkspaceFailure] = useState<unknown>(null);
  // Whether the last workspace read failed, set by the read itself (T-170).
  const workspaceFailed = useRef(false);
  const workspaceError = workspaceFailure ? errorText(workspaceFailure) : "";
  const detailError = live.error ? errorText(live.error) : "";
  // Each view is read again only for changes that concern it.
  const [fullRevision, fullRefresh] = useRefreshTrigger();
  const [workspaceRevision, workspaceRefresh] = useRefreshTrigger();
  const [homeRevision, homeRefresh] = useRefreshTrigger();
  const [boardRevision, boardRefresh] = useRefreshTrigger();
  const [machinesRevision, machinesRefresh] = useRefreshTrigger();
  const [jobsRevision, jobsRefresh] = useRefreshTrigger();
  // Only for the Home tab's count of open Asks while Home is closed.
  const [asksRevision, asksRefresh] = useRefreshTrigger();
  const [loading, setLoading] = useState(!previewMode);
  const [createOpen, setCreateOpen] = useState(false);
  // A project chosen by a group's "+": its id, "" for none, null to follow
  // the project scope.
  const [createProject, setCreateProject] = useState<string | null>(null);
  // Settings that change what the Agent list renders, not only its look.
  const appearance = useAppearance();
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [updatesNeedReload, setUpdatesNeedReload] = useState(false);
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  // The composer's `/model`: opens this Agent's settings, never a prompt.
  const [modelRequest, setModelRequest] = useState<{ model: string; nonce: number; kind?: "permissions" } | null>(null);
  // What /new and /resume open New agent with (T-29); null is its usual start.
  const [createInitial, setCreateInitial] = useState<CreateInitial | null>(null);
  // /status, /usage and /mcp: the context panel, at that part of it.
  const [inspectorFocus, setInspectorFocus] = useState<{ id: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!inspectorFocus) return;
    const frame = requestAnimationFrame(() => document.getElementById(inspectorFocus.id)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [inspectorFocus]);
  const [forkOpen, setForkOpen] = useState(false);
  // `/changes`: the record of one turn's file edits, that turn fixed when asked.
  const [changesRequest, setChangesRequest] = useState<{ agentId: string; turnId: string | null; nonce: number } | null>(null);
  // `/diff`: Git's diff of the Agent's folder, read when it opens.
  const [diffRequest, setDiffRequest] = useState<{ agentId: string; nonce: number } | null>(null);
  // `/ps` and `/stop`: the conversation's background terminals, listed when asked.
  const [terminalsRequest, setTerminalsRequest] = useState<{ agentId: string; mode: "list" | "stop"; nonce: number } | null>(null);
  // `/review` alone: Review with Codex, for the draft that asked for it.
  const [reviewRequest, setReviewRequest] = useState<{ agentId: string; draft: ComposerDraft; nonce: number } | null>(null);
  // `/goal`: the Codex goal dialog, with the objective typed after it.
  const [goalRequest, setGoalRequest] = useState<{ agentId: string; draft: ComposerDraft; nonce: number; objective: string } | null>(null);
  // `/plan`, or the composer's Plan mode sign (no draft): the Codex mode dialog.
  const [planRequest, setPlanRequest] = useState<{ agentId: string; draft: ComposerDraft | null; nonce: number } | null>(null);
  // Each is for the Agent it was asked from: selecting another Agent drops it,
  // so it neither keeps read tracking off elsewhere nor reopens on return.
  useEffect(() => {
    setChangesRequest((request) => request && request.agentId !== selected ? null : request);
    setDiffRequest((request) => request && request.agentId !== selected ? null : request);
    setTerminalsRequest((request) => request && request.agentId !== selected ? null : request);
    setReviewRequest((request) => request && request.agentId !== selected ? null : request);
    setGoalRequest((request) => request && request.agentId !== selected ? null : request);
    setPlanRequest((request) => request && request.agentId !== selected ? null : request);
  }, [selected]);
  const [turnDockEngaged, setTurnDockEngaged] = useState(false);
  const [inspector, setInspector] = useState(true);
  // A wide window's choice; on a phone the list is a screen of its own.
  const [railOpen, setRailOpen] = useState(true);
  // Phones (T-170): one screen at a time, the Agent list or what is open.
  // The list covers the open view instead of replacing it, so its drafts,
  // reading place and any annotation stay as they were.
  const phone = usePhone();
  const [phoneList, setPhoneList] = useState(true);
  const [phoneInspector, setPhoneInspector] = useState(false);
  const phoneBack = useRef<HTMLButtonElement>(null);
  const listShown = phone && phoneList;
  // Without a system frame (Windows desktop), the toolbar is the title bar.
  const frame = useCustomFrame();
  const [homeOpen, setHomeOpen] = useState(false);
  const [collaborationOpen, setCollaborationOpen] = useState(false);
  const [taskFocus, setTaskFocus] = useState<{ taskId: string; reviewId?: string; at: number } | null>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactPreview | null>(null);
  // An image being marked for Point & Fix (T-167).
  const [pointFix, setPointFix] = useState<PointFixSource | null>(null);
  const { draft, getDraft, setDraft, clearIfUnchanged, preserveDrafts, removeDraft, copyDraft, discardSavedDraft, draftError, draftBlocked } = useComposerDraft(selected);
  const [interrupting, setInterrupting] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [readActionsOpen, setReadActionsOpen] = useState(false);
  const [agentScope, setAgentScope] = useState<"active" | "closed">("active");
  const [storedScope, setStoredScope] = useState<ProjectScope>(ALL_PROJECTS);
  const [projectDialog, setProjectDialog] = useState<"new" | "manage" | null>(
    null,
  );
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [machinesOpen, setMachinesOpen] = useState(false);
  const [requestReopen, setRequestReopen] = useState<{
    agentId: string;
    sequence: number;
  } | null>(null);
  const [historyReading, setHistoryReading] = useState(false);
  // Where a source was opened from: Home leads back to Home.
  const [sourceOrigin, setSourceOrigin] = useState<"home" | "rail">(
    "home",
  );
  const [atBottom, setAtBottom] = useState(true);
  const [jumpToTurn, setJumpToTurn] = useState<string | null>(null);
  const [readingTurn, setReadingTurn] = useState<string>();
  // A message link (T-166) or a saved reading position opens like a source.
  // `progress`: a place shared from another browser (T-170), restored by how
  // far into the message it was; `thread`: the native session it was read in.
  const [catchupSource, setCatchupSource] = useState<(CatchupItem & { openDetails?: boolean; link?: MessageLink; restore?: number; progress?: number; thread?: string }) | null>(null);
  const [sourceJump, setSourceJump] = useState(false);
  const [sourceNotice, setSourceNotice] = useState("");
  // A message link waiting for the Workspace to load.
  const [incomingLink, setIncomingLink] = useState<MessageLink | null>(null);
  // Where the shown conversation was last being read, kept when it is left.
  const reading = useRef<{ agentId: string; position: ReadingPosition } | null>(null);
  const readingFrame = useRef(0);
  const initialReading = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const readEnd = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const stickToBottom = useRef(true);
  const searchReading = useRef(false);
  const draggingScrollbar = useRef(false);
  // What grows after it is drawn (a tool row unfolding, a chart laying out),
  // or a pane that shrinks under a growing composer, keeps the end in view
  // while the conversation follows it, as an update does. A row the reader
  // has just opened stays where they clicked it.
  const followHeld = useRef(false);
  const readerToggled = useRef(-Infinity);
  const followGrowth = useCallback((inner: HTMLDivElement | null) => {
    if (!inner || typeof ResizeObserver === "undefined") return;
    let last: { height: number; pane: number } | null = null;
    const observer = new ResizeObserver(() => {
      const el = scroll.current;
      if (!el) return;
      const grown = last
        ? el.scrollHeight - last.height + (last.pane - el.clientHeight)
        : 0;
      last = { height: el.scrollHeight, pane: el.clientHeight };
      // Only when the end was in view before it grew (as onScroll counts the
      // bottom): a smooth scroll back to the latest is still on its way.
      const gapBefore = el.scrollHeight - el.scrollTop - el.clientHeight - grown;
      if (
        grown > 0 &&
        gapBefore < 72 &&
        stickToBottom.current &&
        !followHeld.current &&
        performance.now() - readerToggled.current > 600
      )
        el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    if (inner.parentElement) observer.observe(inner.parentElement);
    return () => observer.disconnect();
  }, []);
  const fileReturn = useRef<{
    agentId: string;
    scrollTop: number;
    follow: boolean;
    focus: HTMLElement | null;
  } | null>(null);
  const currentSelected = useRef(selected);
  const historyAnchor = useRef<{
    agentId: string;
    element: HTMLElement;
    top: number;
  } | null>(null);
  currentSelected.current = selected;
  const scopeWorkspace = useRef("");
  const scopeRef = useRef<ProjectScope>(ALL_PROJECTS);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  /** Everything shown is read again: after the user's own actions, when Core
   * resets the stream, and while polling because it is not open. */
  const refresh = useCallback(() => {
    fullRefresh.now();
    workspaceRefresh.now();
    homeRefresh.now();
    asksRefresh.now();
    boardRefresh.now();
    machinesRefresh.now();
  }, [fullRefresh, workspaceRefresh, homeRefresh, asksRefresh, boardRefresh, machinesRefresh]);
  useEffect(() => {
    // Read together with the workspace list, which also reads on render.
    if (fullRevision) live.sync.refetch({ now: true });
  }, [fullRevision, live.sync]);
  const onWorkspaceEvent = useCallback(
    (event: WorkspaceEvent) => {
      switch (event.type) {
        case "agent.delta":
        case "agent.item":
        case "agent.context":
          // Only the shown Agent's detail is kept; others are read when opened.
          if (event.agentId === currentSelected.current) live.sync.push(event);
          return;
        case "agent.changed":
          workspaceRefresh.soon(250);
          homeRefresh.soon(1_000);
          if (event.agentId === currentSelected.current) live.sync.refetch();
          return;
        case "agent.progress": {
          // Its Items went out already; only its rail entry changes.
          const listed = event.agent;
          if (
            !listed ||
            !workspaceRef.current?.agents.some((a) => a.id === listed.id)
          ) {
            workspaceRefresh.soon(500);
          } else {
            setWorkspace((w) => {
              const index = w?.agents.findIndex((a) => a.id === listed.id) ?? -1;
              if (!w || index < 0) return w;
              const old = w.agents[index];
              // An entry sent before the last list was read never replaces it.
              const newer =
                listed.rev != null && old.rev != null
                  ? listed.rev > old.rev
                  : listed.lastSeq > old.lastSeq;
              if (!newer) return w;
              const agents = w.agents.slice();
              agents[index] = { ...listed, projectId: old.projectId };
              return { ...w, agents };
            });
          }
          // Home's Agent counts can wait for progress lines.
          homeRefresh.atMostEvery(15_000);
          return;
        }
        case "workspace.changed":
          // A conversation that shows mail delivery gets its own notice.
          if (event.scope === "collaboration") boardRefresh.now();
          else if (event.scope === "jobs") jobsRefresh.now();
          else if (event.scope === "machines") machinesRefresh.now();
          else if (event.scope === "brief" || event.scope === "home") {
            homeRefresh.soon(250);
            asksRefresh.soon(250);
          }
          else if (event.scope === "projects" || event.scope === "runtime")
            workspaceRefresh.soon(250);
          else refresh();
          return;
        case "reset":
          jobsRefresh.now();
          refresh();
          return;
      }
    },
    [workspaceRefresh, homeRefresh, asksRefresh, boardRefresh, machinesRefresh, jobsRefresh, live.sync, refresh],
  );
  const eventConnection = useWorkspaceEvents(!previewMode, onWorkspaceEvent);
  useEffect(() => {
    if (eventConnection === "open" && !previewMode) jobsRefresh.now();
  }, [eventConnection, previewMode, jobsRefresh]);
  useEffect(() => {
    const refreshJobs = () => jobsRefresh.now();
    // Jobs open as a dialog above Home (whose own Jobs widget sends this),
    // so Home stays: closing it would put a conversation on screen behind
    // the dialog and start its read dwell.
    const openJobs = () => setCollaborationOpen(false);
    window.addEventListener("yuzuno:open-job", openJobs);
    window.addEventListener("yuzuno:jobs-refresh", refreshJobs);
    return () => { window.removeEventListener("yuzuno:jobs-refresh", refreshJobs); window.removeEventListener("yuzuno:open-job", openJobs); };
  }, [jobsRefresh]);
  useEffect(() => {
    // A review link opens its task with that review's report; nothing is started or marked read.
    const openTaskReview = (event: Event) => {
      const { taskId, reviewId } = (event as CustomEvent<{ taskId?: string; reviewId?: string }>).detail || {};
      if (typeof taskId !== "string" || !taskId) return;
      // The task board is a dialog too; Home stays beneath it.
      setTaskFocus({ taskId, reviewId: typeof reviewId === "string" ? reviewId : undefined, at: Date.now() });
      setCollaborationOpen(true);
    };
    window.addEventListener("yuzuno:open-task-review", openTaskReview);
    return () => window.removeEventListener("yuzuno:open-task-review", openTaskReview);
  }, []);
  useEffect(() => {
    // Live updates do not retry a failed read; this does. And should Core
    // ever change the list without saying so, the rail heals within a
    // minute (the list is small; the shown detail is never polled).
    if (previewMode || eventConnection !== "open") return;
    const timer = setInterval(
      () => workspaceRefresh.now(),
      workspaceFailure ? POLL_MS : SAFETY_NET_MS,
    );
    return () => clearInterval(timer);
  }, [workspaceFailure, eventConnection, workspaceRefresh]);
  useEffect(() => {
    // Back online after a failed workspace read: read it again now, not at
    // the next interval (T-170). Reports share one read, queued behind one
    // already running; only its success clears the failure, never coming
    // online or the stream opening. With no failure nothing more is read.
    // The last read is checked when the report comes, so a failure just
    // before it counts even before its render's effects have run.
    if (previewMode) return;
    return watchBrowserNetwork({
      online: () => {
        if (workspaceFailed.current) workspaceRefresh.now();
      },
    });
  }, [workspaceRefresh]);
  const browserOffline = useBrowserOffline();
  const core = coreConnection(!!workspace, workspaceFailure, eventConnection, previewMode, browserOffline);
  const agent = workspace?.agents.find((a) => a.id === selected);
  const inspectorShown = (phone ? phoneInspector : inspector) && !!agent && !homeOpen;
  const projects = workspace?.projects || [];
  const workspaceId = workspace?.workspace?.id || "";
  const readingPositions = useMemo(
    () => (workspaceId && !previewMode ? localReadingPositions(workspaceId) : null),
    [workspaceId],
  );
  useEffect(() => {
    // Unfinished jobs per Agent for the Agent list, read again on every job
    // change and reconnect (jobsRevision); rows subscribe, App keeps no copy.
    if (!previewMode) refreshLiveJobs(workspaceId);
  }, [jobsRevision, workspaceId, previewMode]);
  useEffect(() => {
    // Task closure and delivery stop close CI interests via collaboration;
    // monitor/subscription changes publish Jobs. Neither needs a chat read.
    if (!previewMode && workspaceId) refreshLiveCI(workspaceId);
  }, [jobsRevision, boardRevision, workspaceId, previewMode]);
  useEffect(() => {
    // Expiry and stale observations can change without an event. One small
    // local aggregate read serves every row; no GitHub request or chat read.
    if (previewMode || !workspaceId) { clearLiveCI(); return; }
    const timer = setInterval(() => refreshLiveCI(workspaceId), 30_000);
    return () => { clearInterval(timer); clearLiveCI(); };
  }, [workspaceId, previewMode]);
  const scope = validScope(storedScope, projects);
  scopeRef.current = scope;
  const panelWidths = usePanelWidths(
    railOpen,
    inspector && !!agent && !homeOpen,
  );
  useEffect(() => {
    if (agent) setAgentScope(agent.closedAt ? "closed" : "active");
  }, [agent?.id, agent?.closedAt]);
  const savedPages = useSavedPages(detail, selected);
  const sessionHistory = useSessionHistory(savedPages.detail, selected);
  const currentDetail = sessionHistory.detail;
  // Earlier native Turns come before the oldest saved one, so they are
  // offered only where the saved conversation starts (T-161).
  const nativeHistoryHere = !currentDetail?.conversation?.hasBefore;
  const [pageTarget, setPageTarget] = useState<{agentId:string; turnId:string; itemId?:string; top:number; start:string|null; end:string|null} | null>(null);
  const [pageSpace, setPageSpace] = useState<"before" | "after" | null>(null);
  useEffect(() => { setPageTarget(null); setPageSpace(null); }, [selected]);
  useEffect(() => { if (sourceJump || jumpToTurn) setPageSpace(null); }, [sourceJump, jumpToTurn]);
  // An earlier window that could not be read moves nothing to hold in place.
  useEffect(() => { if (savedPages.error) setPageTarget(null); }, [savedPages.error]);
  function pageAnchor(turnId: string, itemId?: string) {
    const turn = document.getElementById(`turn-${turnId}`);
    if (!itemId) return turn;
    const elements = Array.from(turn?.querySelectorAll<HTMLElement>("[data-item-id], [id], [data-window-key]") || []);
    return elements.find(el => el.dataset.itemId === itemId || el.id === `item-${itemId}`)
      || elements.find(el => el.dataset.windowKey === itemId);
  }
  useLayoutEffect(() => {
    if (!pageTarget || pageTarget.agentId !== selected || live.windowLoading || !scroll.current) return;
    const window = currentDetail?.conversation;
    if (!window || (window.start === pageTarget.start && window.end === pageTarget.end)) return;
    // Keep the mount hint through the first measurement pass. Otherwise a
    // target in an estimated gap can disappear before its position is stable.
    const restore = () => {
      const item = pageAnchor(pageTarget.turnId, pageTarget.itemId);
      if (item && scroll.current) scroll.current.scrollTop += item.getBoundingClientRect().top - pageTarget.top;
    };
    restore();
    let frame = requestAnimationFrame(() => {
      restore();
      frame = requestAnimationFrame(() => { restore(); setPageTarget(null); });
    });
    return () => cancelAnimationFrame(frame);
  }, [currentDetail, live.windowLoading, pageTarget, selected]);
  const questionPanel = useRef<PendingQuestionsHandle>(null);
  const [questionIndex] = useState(() => new QuestionIndex());
  const coreQuestions = useMemo(() => questionIndex.read(detail?.agent.id === selected ? detail.conversation?.questions || detail.turns : []), [questionIndex, detail?.turns, detail?.conversation?.questions, detail?.agent.id, selected]);
  const questionSources = useMemo(() => new Set(coreQuestions.map(questionKey)), [coreQuestions]);
  const openQuestion = useCallback((source: QuestionSource) => questionPanel.current?.open(source), []);
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    historyAnchor.current = null;
    if (
      anchor?.agentId === selected &&
      anchor.element.isConnected &&
      scroll.current
    ) {
      scroll.current.scrollTop +=
        anchor.element.getBoundingClientRect().top - anchor.top;
    }
  }, [currentDetail, selected]);
  const compacting =
    agent?.status === "working" && !!currentDetail?.turns.some(isCompacting);
  const latestAgentTurnId = currentDetail?.turns
    .slice()
    .reverse()
    .find((turn) => turn.items.some(hasAgentContent))?.id;
  const timeMarks = conversationTimeMarks(currentDetail?.turns ?? []);
  const pending = currentDetail?.pending || [];
  // Browser drafts of answers to native questions (T-170) last only while
  // Core still lists their request for this Agent.
  const requestDraftScope = previewMode || !workspaceId ? null : workspaceId;
  useEffect(() => {
    if (requestDraftScope !== null && detail && detail.agent.id === selected)
      pruneRequestDrafts(requestDraftScope, detail.agent.id, detail.pending);
  }, [requestDraftScope, detail?.agent.id, detail?.pending, selected]);
  const pendingToolIds = useMemo(() => new Set<string>(
    (currentDetail?.pending || []).flatMap((request) =>
      request.method === "item/fileChange/requestApproval" && typeof request.params.itemId === "string"
        ? [request.params.itemId] : [],
    ),
  ), [currentDetail?.pending]);
  const hasDraft = hasDraftContent(draft);
  const imageSupported = (agent?.harness === "codex" || agent?.harness === "claude");
  const imageUploads = useImageUploads(selected, imageSupported && !previewMode && !draftBlocked, getDraft, setDraft);
  const imagePicker = useRef<HTMLInputElement>(null);
  const pointFixPicker = useRef<HTMLInputElement>(null);
  const closed = !!agent?.closedAt;
  const busy =
    !closed && (agent?.status === "working" || agent?.status === "waiting");
  const activeAgents = workspace?.agents.filter((a) => !a.closedAt) || [];
  const closedAgents = workspace?.agents.filter((a) => !!a.closedAt) || [];
  const scopedActive = activeAgents.filter((a) => inScope(a, scope));
  const scopedClosed = closedAgents.filter((a) => inScope(a, scope));
  const outsidePending = pendingElsewhere(workspace?.agents || [], scope);
  const isClaude = agent?.harness === "claude";
  const isOpenCode = agent?.harness === "opencode";
  const logicalTurns = sessionHistory.navigationTurns;
  // Claude takes a follow-up to your running turn, not to a turn of its own.
  const claudeFollowUpTurnId = isClaude && busy
    ? logicalTurns
        .slice()
        .reverse()
        .find((turn) => turn.status === "inProgress" && turn._yuzunoSource !== "native")?.id || null
    : null;
  // OpenCode takes no message into a running turn.
  const cannotSendWhileWorking = (isClaude && busy && !claudeFollowUpTurnId) || (isOpenCode && busy);
  // Codex would refuse to add to a Turn whose result is unconfirmed; the
  // draft waits until reconnecting has checked it. Claude resumes on send.
  const recovery =
    currentDetail && !previewMode ? recoveryReason(currentDetail) : null;
  const holdForRecovery = (recovery === "running" && !isClaude) || recovery === "collaboration";
  // The one line under the draft that asks something of you; otherwise the
  // line stays quiet and shows the keys only while you type.
  const composerNotice = busy
    ? pending.some((r) => r.params.isBlocking !== false && !r.stale)
      ? "Waiting for your response above"
      : null
    : holdForRecovery
      ? recovery === "collaboration"
        ? "Reconnect above to check the workspace connection; your draft is kept"
        : "Reconnect above to check the last turn; your draft is kept"
      : agent?.status === "uncertain"
        ? "Send to check the previous result first"
        : agent?.status === "offline"
          ? "Send a message to resume this session"
          : null;
  const logicalRunningTurn = busy
    ? logicalTurns
        .slice()
        .reverse()
        .find((turn) => /inProgress|running/.test(turn.status))
    : undefined;
  const loadedRunningTurn = currentDetail?.turns.find(t => t.id === logicalRunningTurn?.id);
  const runningTurn = loadedRunningTurn && !loadedRunningTurn._yuzunoSlice?.start && loadedRunningTurn.items.some(i => i.type === "userMessage")
    ? loadedRunningTurn : logicalRunningTurn;
  const activeTurnId =
    logicalTurns
      .slice()
      .reverse()
      .find((turn) => turn.status === "inProgress")?.id || null;
  // The turn a message joins: Claude's follow-up, Codex's running turn;
  // none for OpenCode.
  const sendTurnId = isClaude ? claudeFollowUpTurnId : isOpenCode ? null : activeTurnId;
  const {
    submit: submitMessage,
    sending,
    outgoing,
    pendingInputs,
  } = useConversationSend(
    selected,
    sendTurnId,
    refresh,
    agent?.harness,
    currentDetail,
  );
  // New Claude messages still sending that their own Turn shows: once, there,
  // with the delivery note (T-120). The same set while its members stay the
  // same, so a streamed change does not draw every Turn again.
  const inTurnKey = [...sendingInTurn(currentDetail, selected, outgoing)].sort().join("\n");
  const inTurn = useMemo<ReadonlySet<string>>(() => new Set(inTurnKey ? inTurnKey.split("\n") : []), [inTurnKey]);
  // A message this tab is still sending is on its way, not unconfirmed: Core
  // records its receipt before the harness answers, and a read in between
  // shows it sending (T-120). Only that same message, while its request runs.
  const unconfirmedMessage = currentDetail?.messageReceipts?.some(
    (r) => r.status === "uncertain" || (r.status === "sending" && !(sending && outgoing.some((m) =>
      m.agentId === selected && m.receipt.status === "sending" && m.receipt.input.clientMessageId === r.input.clientMessageId))),
  );
  // The Home tab counts what Needs you lists: requests and open Asks. Unread
  // turns stay with their conversations: Home does not list them, so its
  // badge does not count them.
  const totalPending = activeAgents.reduce((n, a) => n + a.pendingCount, 0);
  const [openAsks, reportNeedsYou] = useOpenAsks(workspaceId, !homeOpen && !previewMode, asksRevision);
  const needsYou = totalPending + openAsks;
  const reviewDisplayed = useCallback(
    async (id: string, throughSeq: number) => {
      await post(`/agents/${encodeURIComponent(id)}/review`, { throughSeq });
      refresh();
    },
    [refresh],
  );
  useAutoRead({
    agentId: currentDetail?.agent.id || null,
    throughSeq: currentDetail?.agent.lastSeq || 0,
    reviewedSeq: currentDetail?.agent.reviewedSeq || 0,
    unreadCount: currentDetail?.agent.unreadCount || 0,
    enabled:
      !previewMode &&
      !!currentDetail &&
      !closed &&
      !detailError &&
      !live.windowLoading &&
      !currentDetail?.conversation?.hasAfter &&
      !pageTarget &&
      !workspaceError &&
      !homeOpen &&
      !listShown &&
      !(phone && phoneInspector) &&
      !collaborationOpen &&
      !historyReading &&
      !sourceJump &&
      !jumpToTurn &&
      !artifact &&
      !createOpen &&
      !updatesOpen &&
      !agentSettingsOpen &&
      !turnDockEngaged &&
      !readActionsOpen &&
      !projectDialog &&
      !scopeMenuOpen &&
      !machinesOpen &&
      !changesRequest &&
      !forkOpen &&
      !reviewRequest &&
      !goalRequest &&
      !planRequest,
    scrollRef: scroll,
    endRef: readEnd,
    onRead: reviewDisplayed,
  });

  useSnapshot<Workspace>(
    previewMode ? null : "/workspace",
    workspaceRevision,
    (w) => {
      setWorkspace(w);
      workspaceFailed.current = false;
      setWorkspaceFailure(null);
      const id = w.workspace?.id || "";
      const firstLoad = !!id && scopeWorkspace.current !== id;
      if (firstLoad) {
        scopeWorkspace.current = id;
        scopeRef.current = validScope(
          readStorage(scopeStorageKey(id), ALL_PROJECTS),
          w.projects || [],
        );
        setStoredScope(scopeRef.current);
      }
      const current = scopeRef.current;
      const visible = w.agents.filter((a) => inScope(a, current));
      const kept = w.agents.find((a) => a.id === currentSelected.current);
      // A remembered agent outside the remembered project is not opened
      // into view: the window starts on Home instead of reading it.
      if (kept && firstLoad && !inScope(kept, current)) setHomeOpen(true);
      setSelected((s) =>
        w.agents.some((a) => a.id === s)
          ? s
          : visible.find((a) => !a.closedAt)?.id || visible[0]?.id || "",
      );
    },
    (error) => {
      workspaceFailed.current = true;
      setWorkspaceFailure(error);
    },
    () => setLoading(false),
  );
  useEffect(() => {
    writeStorage("yuzuno.selected", selected);
    setActionError("");
    setInterrupting(false);
    setRequestReopen(null);
    setTurnDockEngaged(false);
    setReadingTurn(undefined);
    stickToBottom.current = !historyReading;
    searchReading.current = historyReading;
    setAtBottom(!historyReading);
    setArtifact(null);
  }, [selected]);
  useEffect(() => { pruneResultViewCache(); }, []);
  // A message link in the address (T-166): read once, then removed, so a
  // reload returns to where the user is reading rather than to the link.
  useEffect(() => {
    if (previewMode) return;
    const take = () => {
      const link = parseMessageLink(window.location.href);
      if (!link) return;
      history.replaceState(history.state, "", window.location.pathname + window.location.search);
      setIncomingLink(link);
    };
    take();
    window.addEventListener("hashchange", take);
    return () => window.removeEventListener("hashchange", take);
  }, []);
  useEffect(() => {
    if (!incomingLink || !workspace) return;
    setIncomingLink(null);
    initialReading.current = true;
    openMessageLink(incomingLink);
  }, [incomingLink, workspace]);
  // Another browser's place in the open conversation (T-170): offered, never
  // applied by itself. Read when it opens or the page shows again; an answer
  // for another Agent or Workspace, or an older ask, is dropped.
  const published = useRef(new Map<string, string>());
  const [readingOffer, setReadingOffer] = useState<{ agentId: string; workspaceId: string; handoff: Handoff } | null>(null);
  const offerAsk = useRef("");
  useEffect(() => {
    setReadingOffer(null);
    if (!workspaceId || previewMode || !selected || homeOpen || listShown) return;
    const agentId = selected, ws = workspaceId;
    let asks = 0;
    const ask = () => {
      if (document.visibilityState === "hidden") return;
      const token = `${ws}\n${agentId}\n${++asks}`;
      offerAsk.current = token;
      void readHandoff(ws, agentId).then((handoff) => {
        if (offerAsk.current !== token) return;
        setReadingOffer(offerable(ws, agentId, handoff, readingPositions?.get(agentId) ?? null) ? { agentId, workspaceId: ws, handoff } : null);
      });
    };
    ask();
    const visible = () => { if (document.visibilityState === "visible") ask(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      offerAsk.current = "";
      document.removeEventListener("visibilitychange", visible);
    };
  }, [workspaceId, selected, homeOpen, listShown, readingPositions]);
  // After a reload, the shown conversation opens where it was left.
  useEffect(() => {
    if (initialReading.current || !workspace || !selected || homeOpen || incomingLink) return;
    initialReading.current = true;
    const saved = readingPositions?.get(selected);
    if (saved?.mode === "anchor") restoreReading(selected, saved);
  }, [workspace, selected, homeOpen, incomingLink, readingPositions]);
  // Leaving a conversation (another Agent, Home, a hidden or closed page)
  // keeps where it was being read.
  useEffect(() => {
    const save = () => {
      if (!reading.current) return;
      const { agentId, position } = reading.current;
      readingPositions?.set(agentId, position);
      // The same place for the user's other browsers (T-170), once per change.
      const shared = position.mode === "latest" ? "latest" : JSON.stringify([position.turnId, position.itemId, position.threadId, position.progress]);
      const key = `${workspaceId}\n${agentId}`;
      if (workspaceId && !previewMode && published.current.get(key) !== shared) {
        published.current.set(key, shared);
        publishReading(workspaceId, agentId, position, isNative ? "desktop" : "browser");
      }
    };
    const hidden = () => { if (document.visibilityState === "hidden") save(); };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [selected, homeOpen, readingPositions]);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(""), 4000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  useEffect(() => {
    followHeld.current = sourceJump || !!artifact;
  }, [sourceJump, artifact]);
  useEffect(() => {
    if (sourceJump || artifact) return;
    if (jumpToTurn && currentDetail?.conversation && !currentDetail.turns.some(t => t.id === jumpToTurn && !t._yuzunoSlice?.start)) {
      void live.navigate({turnId:jumpToTurn});
      return;
    }
    if (jumpToTurn && currentDetail?.turns.some((t) => t.id === jumpToTurn)) {
      const target = document.getElementById(`turn-${jumpToTurn}`);
      target?.scrollIntoView({ behavior: "instant", block: "start" });
      target?.focus({ preventScroll: true });
      stickToBottom.current = false;
      setJumpToTurn(null);
      return;
    }
    if (stickToBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [currentDetail, jumpToTurn, homeOpen, sourceJump, artifact, outgoing]);
  useEffect(() => {
    if (!sourceJump || !catchupSource || homeOpen || !currentDetail) return;
    if (currentDetail.agent.id !== catchupSource.agentId) return;
    if (live.windowLoading) return;
    // A link or a saved position may name a message that is gone (T-166).
    const owner = workspace?.agents.find(a => a.id === catchupSource.agentId);
    // An earlier native session is said first, for a saved place too (T-170).
    const thread = catchupSource.link?.threadId ?? catchupSource.thread;
    const gone = thread && owner?.threadId && thread !== owner.threadId
      ? `This message was in an earlier native session of ${catchupSource.agentName}, not the current one. Showing ${catchupSource.restore !== undefined ? "the latest messages" : "the conversation"}.`
      : catchupSource.restore !== undefined
        ? "Where you left off is no longer in this conversation. Showing the latest messages."
        : catchupSource.link
          ? `This message is no longer in ${catchupSource.agentName}’s conversation, for example after Rewind. Showing the conversation.`
          : "";
    if (currentDetail.conversation && catchupSource.turnId) {
      const loaded = currentDetail.turns.find(t => t.id === catchupSource.turnId);
      if (!loaded || (catchupSource.itemId && catchupSource.itemId !== `yuzuno-plan-${loaded.id}` && !loaded.items.some(i => i.id === catchupSource.itemId))) {
        if (detailError) { setSourceNotice(`Could not load the original: ${detailError}`); return; }
        const wanted = {turnId:catchupSource.turnId, ...(catchupSource.itemId && catchupSource.itemId !== `yuzuno-plan-${catchupSource.turnId}` ? {itemId:catchupSource.itemId} : {})};
        if (live.missing === JSON.stringify(wanted)) {
          // Core has no such Turn or Item: say so once, at the latest
          // messages, instead of asking for it again.
          if (catchupSource.restore !== undefined) { setNotice(gone); backToLatest(); return; }
          setSourceNotice(gone || (catchupSource.itemId ? "The original reply is unavailable. Showing the available conversation." : "The original turn is unavailable. Showing this conversation."));
          stickToBottom.current = true;
          scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
          setSourceJump(false);
          return;
        }
        void live.navigate(wanted);
        return;
      }
    }
    const turn = catchupSource.turnId
      ? document.getElementById(`turn-${catchupSource.turnId}`)
      : null;
    const message = catchupSource.itemId
      ? Array.from(
          turn?.querySelectorAll<HTMLElement>("[data-item-id], [id]") || [],
        ).find(
          (element) =>
            element.dataset.itemId === catchupSource.itemId ||
            element.id === `item-${catchupSource.itemId}`,
        )
      : null;
    const request =
      catchupSource.kind === "pending"
        ? document.getElementById(`request-${catchupSource.id}`)
        : null;
    const target =
      request ||
      message ||
      (catchupSource.kind === "error" &&
      (sourceOrigin === "rail" || !catchupSource.turnId)
        ? document.getElementById(`runtime-error-${selected}`)
        : null) ||
      turn;
    const absent = (!!catchupSource.itemId && !message) || (!!catchupSource.turnId && !turn);
    if (absent && catchupSource.restore !== undefined) { setNotice(gone); backToLatest(); return; }
    setSourceNotice(
      catchupSource.kind === "pending" && !request
        ? "This request is no longer pending. Showing its conversation."
        : absent && gone
          ? gone
        : catchupSource.itemId && !message
          ? "The original reply is unavailable. Showing the available conversation."
          : catchupSource.turnId && !turn
            ? "The original turn is unavailable. Showing this conversation."
            : "",
    );
    stickToBottom.current = false;
    if (target) {
      const disclosures: HTMLDetailsElement[] = [];
      // Approval navigation must reveal the diff itself as well as its group.
      let parent = catchupSource.openDetails ? target : target.parentElement;
      while (parent && parent !== scroll.current) {
        if (parent instanceof HTMLDetailsElement) {
          parent.setAttribute("data-source-jump", "");
          parent.open = true;
          disclosures.push(parent);
        }
        parent = parent.parentElement;
      }
      const focusTarget = () => {
        if (!target.isConnected) return;
        target.tabIndex = -1;
        target.scrollIntoView({ behavior: "instant", block: "start" });
        // Where the user left it, not just its start. Measured, since
        // scrollIntoView keeps the pane's scroll padding above the target.
        if (catchupSource.restore !== undefined && scroll.current) {
          // Another screen's place: as far into the message, still in view.
          const offset = catchupSource.progress !== undefined
            ? restoredOffset(catchupSource.progress, target.getBoundingClientRect().height, scroll.current.clientHeight)
            : catchupSource.restore;
          scroll.current.scrollTop += target.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - offset;
        }
        target.focus({ preventScroll: true });
        setSourceJump(false);
      };
      if (disclosures.length) {
        // Chromium unlocks a native details subtree on its rendering update.
        // Suppress the pseudo-element's disclosure transition while revealing
        // the target. A new navigation cancels this deferred focus.
        let frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(focusTarget);
        });
        return () => {
          cancelAnimationFrame(frame);
          for (const disclosure of disclosures) disclosure.removeAttribute("data-source-jump");
        };
      }
      focusTarget();
    } else {
      scroll.current?.scrollTo({ top: 0 });
      setSourceJump(false);
    }
  }, [sourceJump, catchupSource, homeOpen, currentDetail, live.windowLoading, live.missing, detailError, live.navigate, workspace]);
  useEffect(() => {
    if (!busy) setInterrupting(false);
  }, [busy]);
  const interrupt = useCallback(async () => {
    if (!selected || previewMode || interrupting) return;
    setInterrupting(true);
    setActionError("");
    try {
      await post(`/agents/${encodeURIComponent(selected)}/interrupt`);
      setNotice("Interrupt requested. Your conversation is preserved.");
      refresh();
    } catch (e) {
      setActionError(errorText(e));
      setInterrupting(false);
    }
  }, [selected, interrupting, refresh]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      // Radix consumes Escape while dismissing a dialog in the capture phase.
      // That dismissal can finish before this window listener sees the event.
      if (event.defaultPrevented) return;
      if (isTauri && (event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        openDesktopConnection();
        return;
      }
      if (
        event.key === "Escape" &&
        busy &&
        !createOpen &&
        !artifact &&
        !homeOpen &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        void interrupt();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "n") {
        event.preventDefault();
        setCreateOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setSearchOpen((v) => !v);
        setRailOpen(true);
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [busy, createOpen, artifact, homeOpen, interrupt]);
  function persistScope(next: ProjectScope) {
    setStoredScope(next);
    scopeRef.current = next;
    if (workspaceId) writeStorage(scopeStorageKey(workspaceId), next);
  }
  function changeScope(next: ProjectScope) {
    persistScope(next);
    // Never pick another agent for the user: an automatic selection would
    // start the read dwell. Out-of-scope conversations yield to Home.
    if (agent && !inScope(agent, next)) {
      setHomeOpen(true);
      setCatchupSource(null);
      setSourceJump(false);
    }
  }
  /** Opening an agent elsewhere moves the window to where it lives. */
  function revealAgent(target: Agent | undefined) {
    if (target && !inScope(target, scope))
      persistScope(scopeForAgent(target, projects));
  }
  /** Phones: back to the Agent list, with focus on the open Agent's row. */
  function showAgentList() {
    setPhoneList(true);
    setPhoneInspector(false);
    requestAnimationFrame(() =>
      (document.querySelector<HTMLElement>(".agent-row.selected .agent-select")
        || document.querySelector<HTMLElement>(".agent-row .agent-select"))?.focus());
  }
  /** An Agent chosen in the list. On a phone the open one comes back as it
   * was left, not at its latest message, and focus moves to the way back. */
  function openFromList(id: string) {
    if (phone && id === selected && !homeOpen) setPhoneList(false);
    else selectAgent(id);
    if (phone) requestAnimationFrame(() => phoneBack.current?.focus());
  }
  function selectAgent(id: string, turnId?: string) {
    setPhoneList(false);
    // Reopening a conversation returns where it was left (T-166).
    const saved = !turnId && (id !== selected || homeOpen) ? readingPositions?.get(id) : null;
    if (saved?.mode === "anchor" && restoreReading(id, saved)) return;
    revealAgent(workspace?.agents.find((a) => a.id === id));
    setAgentScope(
      workspace?.agents.find((a) => a.id === id)?.closedAt
        ? "closed"
        : "active",
    );
    setHistoryReading(!!turnId);
    setSelected(id);
    if (!turnId) {
      searchReading.current = false;
      stickToBottom.current = true;
      setAtBottom(true);
      requestAnimationFrame(() =>
        scroll.current?.scrollTo({ top: scroll.current.scrollHeight }),
      );
    }
    setHomeOpen(false);
    setCatchupSource(null);
    setSourceJump(false);
    setJumpToTurn(turnId || null);
  }
  /** Opens a conversation at a source (a request, reply, turn or error),
   * from Home or the rail; the Catch-up item type is its target shape. */
  function openCatchupSource(
    item: CatchupItem,
    origin: "home" | "rail" = "home",
    openDetails = false,
    extra: { link?: MessageLink; restore?: number; progress?: number; thread?: string } = {},
  ) {
    setPhoneList(false);
    revealAgent(workspace?.agents.find((a) => a.id === item.agentId));
    setHistoryReading(true);
    setSourceOrigin(origin);
    searchReading.current = true;
    stickToBottom.current = false;
    setAtBottom(false);
    setSelected(item.agentId);
    setHomeOpen(false);
    setCatchupSource({ ...item, openDetails, ...extra });
    setSourceNotice("");
    setSourceJump(true);
    setJumpToTurn(null);
  }
  /** Home links into a conversation (or the Machines page) and leads back. */
  function openFromHome(target: HomeTarget) {
    if (target.kind === "machine") {
      setMachinesOpen(true);
      return;
    }
    const owner = workspace?.agents.find((a) => a.id === target.agentId);
    const source = {
      agentId: target.agentId,
      agentName: owner?.name || "",
      body: "",
      seq: owner?.lastSeq || 0,
    };
    if (target.kind === "agent") selectAgent(target.agentId);
    else if (target.kind === "error")
      openCatchupSource({ ...source, id: `${target.agentId}:error`, kind: "error", title: "Agent error" });
    else if (target.kind === "changes" && target.turnId && target.itemId)
      openCatchupSource(
        { ...source, id: target.itemId, kind: "progress", title: "Proposed changes", turnId: target.turnId, itemId: target.itemId },
        "home",
        true,
      );
    else
      openCatchupSource({ ...source, id: target.requestId, kind: "pending", title: "Pending request" });
  }
  /** Continue: opens another browser's place through the usual restore. It
   * marks nothing read and keeps this browser's own saved place until the
   * user leaves from the new one. */
  function continueReading() {
    const offer = readingOffer;
    if (!offer || offer.agentId !== selected) return;
    markOfferHandled(offer.workspaceId, offer.agentId, offer.handoff.version);
    setReadingOffer(null);
    const owner = workspace?.agents.find((a) => a.id === offer.agentId);
    if (!owner || !offer.handoff.turnId) return;
    openCatchupSource(
      { id: `handoff:${owner.id}`, agentId: owner.id, agentName: owner.name, kind: "progress",
        title: offer.handoff.label === "desktop" ? "Where you were reading in the desktop app" : "Where you were reading in another browser",
        body: "", turnId: offer.handoff.turnId, itemId: offer.handoff.itemId, seq: owner.lastSeq },
      "rail", false, { restore: 0, progress: offer.handoff.progress ?? 0, thread: offer.handoff.threadId },
    );
  }
  function dismissReading() {
    if (readingOffer) markOfferHandled(readingOffer.workspaceId, readingOffer.agentId, readingOffer.handoff.version);
    setReadingOffer(null);
  }
  /** Opens a saved reading position like a source, without highlighting it. */
  function restoreReading(agentId: string, saved: Extract<ReadingPosition, { mode: "anchor" }>) {
    const owner = workspace?.agents.find((a) => a.id === agentId);
    if (!owner) return false;
    openCatchupSource(
      { id: `reading:${agentId}`, agentId, agentName: owner.name, kind: "progress", title: "Where you left off",
        body: "", turnId: saved.turnId, itemId: saved.itemId, seq: owner.lastSeq },
      "rail", false, { restore: saved.offset, thread: saved.threadId },
    );
    return true;
  }
  /**
   * Opens the message a link names (T-166). Only navigates: an Ask, approval
   * or Task it shows is left as it is.
   */
  function openMessageLink(link: MessageLink) {
    if (!workspace) { setIncomingLink(link); return; }
    if (link.workspaceId !== workspaceId) {
      setNotice("This link is to a message in another Workspace. Open it in the Yuzuno that holds that Workspace.");
      return;
    }
    const owner = workspace.agents.find((a) => a.id === link.agentId);
    if (!owner) {
      setNotice("The Agent this link points to is no longer in this Workspace.");
      return;
    }
    openCatchupSource(
      { id: `link:${link.turnId}:${link.itemId || ""}`, agentId: owner.id, agentName: owner.name, kind: "progress",
        title: "Linked message", body: "", turnId: link.turnId, itemId: link.itemId, seq: owner.lastSeq },
      homeOpen ? "home" : "rail", false, { link },
    );
  }
  const openLink = useRef(openMessageLink);
  openLink.current = openMessageLink;
  const linkBase = /^https?:$/.test(window.location.protocol) ? `${window.location.origin}${window.location.pathname}` : "";
  const messageLinks = useMemo<MessageLinkApi>(() => ({
    href: (owner, turnId, itemId) => linkBase && workspaceId && !previewMode
      ? messageLinkHref(linkBase, { workspaceId, agentId: owner.id, turnId, itemId, threadId: owner.threadId })
      : null,
    open: (link) => openLink.current(link),
  }), [linkBase, workspaceId]);
  /** Notes where the shown conversation is being read (T-166). */
  function noteReading(latest: boolean) {
    const shown = currentDetail?.agent.id;
    if (!shown || shown !== selected || homeOpen || previewMode) return;
    if (latest) {
      cancelAnimationFrame(readingFrame.current);
      readingFrame.current = 0;
      reading.current = { agentId: shown, position: { mode: "latest", savedAt: Date.now() } };
      return;
    }
    if (readingFrame.current) return;
    const threadId = currentDetail?.agent.threadId;
    readingFrame.current = requestAnimationFrame(() => {
      readingFrame.current = 0;
      const pane = scroll.current;
      // The pane may already show another Agent.
      if (!pane || pane.dataset.agentId !== shown) return;
      const position = readingAnchor(pane, threadId);
      if (position) reading.current = { agentId: shown, position };
    });
  }
  const searchLink = searchOpen ? parseMessageLink(search) : null;
  function openSearchLink() {
    if (!searchLink) return;
    setSearchOpen(false);
    setSearch("");
    openMessageLink(searchLink);
  }
  function navigateToTurn(turnId: string) {
    setHistoryReading(true);
    searchReading.current = true;
    setAtBottom(false);
    setSourceJump(false);
    setJumpToTurn(turnId);
    stickToBottom.current = false;
  }
  function openRailSource(a: Agent, summary: WorkSummary) {
    openCatchupSource(
      {
        id: summary.requestId || `${a.id}:work`,
        agentId: a.id,
        agentName: a.name,
        kind:
          summary.kind === "pending"
            ? "pending"
            : summary.kind === "result"
              ? "result"
              : summary.kind === "error"
                ? "error"
                : "progress",
        title: summaryOrigin(summary),
        body: summary.text,
        turnId: summary.turnId,
        itemId: summary.itemId,
        seq: a.lastSeq,
      },
      "rail",
    );
  }
  function backToLatest() {
    setPageTarget(null);
    setPageSpace(null);
    savedPages.drop();
    if (currentDetail?.conversation) void live.navigate({});
    setHistoryReading(false);
    searchReading.current = false;
    setAtBottom(true);
    setCatchupSource(null);
    setSourceJump(false);
    setJumpToTurn(null);
    stickToBottom.current = true;
    requestAnimationFrame(() =>
      scroll.current?.scrollTo({
        top: scroll.current.scrollHeight,
        // Estimated gaps change as the final rows mount. A smooth scroll's
        // intermediate events look like reading history and cancel following.
        behavior: "instant",
      }),
    );
  }
  function changeHistoryPage(direction: "before" | "after") {
    const window = currentDetail?.conversation;
    let cursor = direction === "before" ? window?.start : window?.end;
    if (!window || !cursor || live.windowLoading || savedPages.loading) return;
    // Native reasoning lifecycle entries may have no visible content. Use a
    // rendered boundary when possible, so the overlapping item can actually
    // preserve the reader's position. The page still includes all earlier or
    // later entries, including the invisible lifecycle records.
    // Native pages are a separate read-through source. Their IDs are not
    // necessarily stored in Core, so never use them as a saved-body cursor.
    const positions = (savedPages.detail?.turns || []).flatMap(turn => turn.items
      .filter(item => item.type === "userMessage" || hasAgentContent(item))
      .map(item => ({turnId:turn.id, itemId:item.id})));
    const boundary = direction === "before" ? positions[0] : positions.at(-1);
    if (boundary) {
      const visibleCursor = JSON.stringify([boundary.turnId, boundary.itemId]);
      // A page may contain only one visible record plus hidden lifecycle
      // records. Do not keep paging from its opposite edge forever.
      if (visibleCursor !== (direction === "before" ? window.end : window.start)) cursor = visibleCursor;
    }
    const [turnId, itemId] = JSON.parse(cursor) as [string, string | null];
    const item = pageAnchor(turnId, itemId || undefined);
    const target = {agentId:selected, turnId, itemId:itemId || undefined,
      top:item?.getBoundingClientRect().top ?? (scroll.current?.getBoundingClientRect().top ?? 0) + 32,
      start:window.start, end:window.end};
    stickToBottom.current = false;
    setHistoryReading(true);
    setAtBottom(false);
    if (direction === "before") {
      // The earlier window goes in front of what is being read (T-161). The
      // live window is pinned, so new messages do not move it out from
      // under the earlier ones.
      live.pinWindow();
      if (savedPages.loadEarlier(cursor)) {
        setPageSpace(null);
        setPageTarget(target);
        return;
      }
    }
    // Replacing a page removes content on the opposite side of its overlap.
    // Reserve at most one viewport there so scrollTop is not clamped before
    // the overlapping item can return to the same screen position.
    setPageSpace(direction === "before" ? "after" : "before");
    setPageTarget(target);
    void live.navigate({[direction]:cursor}, true);
  }
  function readerScrollIntent() {
    requestAnimationFrame(() => {
      const el = scroll.current;
      if (el && !currentDetail?.conversation?.hasAfter && el.scrollHeight - el.scrollTop - el.clientHeight < 24) {
        void live.navigate({});
        stickToBottom.current = true;
        setHistoryReading(false);
        searchReading.current = false;
        setAtBottom(true);
      }
    });
  }
  useEffect(() => {
    const finishDrag = () => {
      if (draggingScrollbar.current) readerScrollIntent();
      draggingScrollbar.current = false;
    };
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    window.addEventListener("blur", finishDrag);
    return () => {
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      window.removeEventListener("blur", finishDrag);
    };
  }, []);
  function openFile(path: string, line?: number) {
    fileReturn.current = {
      agentId: selected,
      scrollTop: scroll.current?.scrollTop || 0,
      follow: stickToBottom.current,
      focus:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    };
    stickToBottom.current = false;
    setArtifact({
      ...(currentDetail?.artifacts.find((a) => a.path === path) || {
        path,
        name: path.split("/").pop() || path,
        kind: /\.(png|jpg|jpeg|gif|webp)$/i.test(path) ? "image" : "text",
      }),
      line,
    });
  }
  function restoreFilePosition(event: Event) {
    event.preventDefault();
    const previous = fileReturn.current;
    fileReturn.current = null;
    if (!previous || previous.agentId !== currentSelected.current) return;
    if (previous.focus?.isConnected)
      previous.focus.focus({ preventScroll: true });
    if (scroll.current) scroll.current.scrollTop = previous.scrollTop;
    stickToBottom.current = previous.follow;
  }
  async function send() {
    if (
      !hasDraft ||
      imageUploads.busy ||
      draftBlocked ||
      !agent ||
      !currentDetail ||
      sending ||
      previewMode ||
      cannotSendWhileWorking ||
      holdForRecovery ||
      closed
    )
      return;
    const target = selected;
    const sentDraft = draft;
    const text = draftText(sentDraft);
    setActionError("");
    searchReading.current = false;
    setHistoryReading(false);
    stickToBottom.current = true;
    try {
      // `/model` and a Codex `/compact` are Yuzuno controls: run here, never
      // sent to the model as a prompt. Anything else is a message as before.
      const control = sentDraft.images?.length || sentDraft.skills?.length || draftTextBlocks(sentDraft)?.length ? null : nativeControl(text, agent.harness || "codex");
      if (control?.command === "model") {
        if (/\s/.test(control.args)) throw new Error("Give one model name, for example /model followed by a name from this Agent's settings. Your draft is kept.");
        // The notice comes once the settings have opened for it.
        setModelRequest({ model: control.args, nonce: Date.now() });
        return;
      }
      // `/review` asks this Agent's own Codex for its review: of the words
      // after it, as its CLI does; alone, of what the user chooses in Review
      // with Codex. The draft stays until Codex has accepted.
      if (control?.command === "review") {
        if (!control.args) {
          setReviewRequest({ agentId: target, draft: sentDraft, nonce: Date.now() });
          return;
        }
        await startCodexReview(target, { type: "custom", instructions: control.args });
        reviewStarted(target, sentDraft);
        return;
      }
      // `/goal` shows this Agent's Codex goal; words after it (other than
      // the CLI's own pause, resume, clear and edit) are a new objective,
      // set there only when the user confirms it.
      if (control?.command === "goal") {
        const objective = ["pause", "resume", "clear", "edit"].includes(control.args) ? "" : control.args;
        setGoalRequest({ agentId: target, draft: sentDraft, nonce: Date.now(), objective });
        return;
      }
      // The rest open their part of Yuzuno, as the CLI command opens its
      // own: nothing is sent, and the draft stays until the user acts there.
      if (control && control.command !== "compact" && control.args)
        throw new Error(`/${control.command} takes nothing after it here. Send /${control.command} alone; your draft is kept.`);
      if (control?.command === "permissions") {
        setModelRequest({ model: "", nonce: Date.now(), kind: "permissions" });
        return;
      }
      // `/plan` shows this Agent's Codex mode; a switch there is the user's
      // click. The draft stays until Codex has accepted one.
      if (control?.command === "plan") {
        setPlanRequest({ agentId: target, draft: sentDraft, nonce: Date.now() });
        return;
      }
      if (control?.command === "fork") {
        setForkOpen(true);
        return;
      }
      if (control?.command === "new" || control?.command === "resume") {
        const claudeAgent = agent.harness === "claude";
        setCreateInitial(control.command === "new"
          ? { nonce: Date.now(), mode: "new", harness: claudeAgent ? "claude" : "codex", machineId: agent.remote?.machine.id || "local",
            cwd: agent.cwd, projectId: agent.projectId || "" }
          : { nonce: Date.now(), mode: claudeAgent ? "claude" : "existing" });
        setCreateOpen(true);
        return;
      }
      // `/changes` shows Yuzuno's record of the file edits Codex made, for the
      // latest turn loaded here that has any. It reads nothing until asked
      // there and sends nothing; the draft stays, as the panels leave it.
      if (control?.command === "changes") {
        setChangesRequest({ agentId: target, turnId: latestTurnWithEdits(currentDetail?.turns || [])?.id ?? null, nonce: Date.now() });
        return;
      }
      // `/diff` reads Git's diff of the Agent's folder through its Codex
      // connection as soon as its dialog opens; nothing is sent to the model,
      // nothing connects, and the draft stays.
      if (control?.command === "diff") {
        setDiffRequest({ agentId: target, nonce: Date.now() });
        return;
      }
      // `/ps` lists the conversation's background terminals; `/stop` (or
      // Codex's alias `/clean`) lists them to stop. Nothing stops on Send:
      // only a Stop pressed in the dialog does. The draft stays.
      if (control?.command === "ps" || control?.command === "stop") {
        setTerminalsRequest({ agentId: target, mode: control.command === "ps" ? "list" : "stop", nonce: Date.now() });
        return;
      }
      if (control?.command === "status" || control?.command === "usage" || control?.command === "mcp") {
        if (phone) {
          setPhoneInspector(true);
          setPhoneList(false);
        } else setInspector(true);
        setInspectorFocus({ id: control.command === "mcp" ? "agent-mcp-status" : "agent-plan-usage", nonce: Date.now() });
        return;
      }
      if (control?.command === "compact") {
        if (control.args) throw new Error("Codex's own compaction takes no instructions. Send /compact alone; your draft is kept.");
        await post(`/agents/${encodeURIComponent(target)}/compact`);
        clearIfUnchanged(target, sentDraft);
        setNotice("Codex accepted /compact. Its compaction shows in this conversation when it runs; until then nothing else is sent.");
        refresh();
        return;
      }
      if (sentDraft.images?.some(image => image.agentId !== target)) throw new Error("These images belong to the original Agent. Attach them again in this Agent; your draft is kept.");
      if (sentDraft.skills?.some(skill => skill.agentId !== target)) throw new Error("Some skills here were listed for another Agent. Remove them and choose this Agent's own; your draft is kept.");
      await submitMessage(text, null, sentDraft.images?.map(image => image.id), undefined, draftTextBlocks(sentDraft),
        sentDraft.skills?.map(({ name, path }) => ({ name, path })));
      clearIfUnchanged(target, sentDraft);
      refresh();
      if (currentSelected.current === target) composer.current?.focus();
    } catch (e) {
      if (currentSelected.current === target) setActionError(errorText(e));
    }
  }
  function reviewStarted(agentId: string, sentDraft: ComposerDraft) {
    clearIfUnchanged(agentId, sentDraft);
    setNotice("Codex started its review as a turn in this conversation. Its findings show here when it ends.");
    refresh();
  }
  function holdResultReading() {
    stickToBottom.current = false;
    searchReading.current = true;
    setHistoryReading(true);
  }
  function appendToDraft(text: string) {
    const target = selected;
    if (composer.current) composer.current.append(text);
    else setDraft(target, appendDraft(draft, text));
    setNotice("Added to your draft. Send when ready.");
  }
  // Stable callbacks for memoized Turns that always reach the latest handlers.
  const turnHandlers = useRef({ openFile, holdResultReading, appendToDraft, submitMessage });
  turnHandlers.current = { openFile, holdResultReading, appendToDraft, submitMessage };
  const turnFile = useCallback(
    (path: string, line?: number) => turnHandlers.current.openFile(path, line),
    [],
  );
  const turnInteract = useCallback(() => turnHandlers.current.holdResultReading(), []);
  const turnAnswer = useCallback(
    (text: string) => turnHandlers.current.appendToDraft(text),
    [],
  );
  const rewindDraft = useCallback((agentId: string, text: string) => {
    setDraft(agentId, current => appendDraft(current, text));
    setNotice("Rewind input saved to this Agent’s draft. Send when ready.");
  }, [setDraft]);
  /**
   * Send to Agent (T-152): the menu and a drop on the rail both end here. It
   * only adds to that Agent's draft, after what is there, and opens it: the
   * user edits and sends it, or not. Nothing is sent, assigned or dispatched.
   */
  function handoffToAgent(source: HandoffSource, targetId: string) {
    const target = workspace?.agents.find(a => a.id === targetId);
    const refusal = previewMode
      ? "Drafts cannot be changed in this preview."
      : targetId === selected && draftBlocked
        ? "Recover or reset this Agent’s saved draft first; nothing was added."
        : handoffRefusal(source, target);
    if (refusal || !target) {
      setNotice(refusal || "That Agent is no longer in this Workspace.");
      return false;
    }
    const text = handoffText(source, target, new Date());
    if (targetId === selected && composer.current) composer.current.append(text);
    else {
      // A damaged saved draft is never overwritten (reading it throws, or the
      // write is skipped), so say so rather than lose this.
      let added = false;
      try {
        setDraft(targetId, current => appendDraft(current, text));
        added = draftText(getDraft(targetId)).endsWith(text);
      } catch {
        added = false;
      }
      if (!added) {
        setNotice(`${target.name}’s saved draft needs recovering first; nothing was added. Open ${target.name} to recover it.`);
        return false;
      }
    }
    // Dialogs it was picked up in close on this, so the draft is in view.
    setCollaborationOpen(false);
    window.dispatchEvent(new Event("yuzuno:handoff-sent"));
    selectAgent(targetId);
    requestAnimationFrame(() => composer.current?.focus());
    setNotice(`Added ${handoffLabel(source)} to ${target.name}’s draft. Edit it, then send.`);
    return true;
  }
  /** Why that Agent's draft cannot take Point & Fix images of these sizes. */
  function pointFixRoom(targetId: string, images: { bytes: number }[]) {
    const target = workspace?.agents.find(a => a.id === targetId);
    const refusal = previewMode ? "Drafts cannot be changed in this preview." : imageRefusal(target);
    if (refusal || !target) return refusal || "That Agent is no longer in this Workspace.";
    if (targetId === selected && draftBlocked) return "Recover or reset this Agent’s saved draft first; nothing was added.";
    let current: readonly DraftImage[];
    try {
      current = getDraft(targetId).images || [];
    } catch {
      return `${target.name}’s saved draft needs recovering first; nothing was added. Open ${target.name} to recover it.`;
    }
    if (current.length + images.length > MAX_IMAGES)
      return `${target.name}’s draft already has ${current.length} images, and a message takes at most ${MAX_IMAGES}.`;
    if (current.reduce((n, i) => n + i.bytes, 0) + images.reduce((n, i) => n + i.bytes, 0) > MAX_IMAGE_TOTAL)
      return `${target.name}’s draft cannot take these images: a message takes at most 40 MiB of images.`;
    return null;
  }
  /**
   * Point & Fix (T-167) ends here, like Send to Agent: the annotated image,
   * the original and the notes are added to that Agent's draft, after what is
   * there, and it opens. The user edits and sends it; nothing is sent here.
   */
  function addPointFix(targetId: string, images: DraftImage[], text: string) {
    const full = pointFixRoom(targetId, images.filter(image => !getDraftImages(targetId).some(saved => saved.id === image.id)));
    if (full) return full;
    const target = workspace!.agents.find(a => a.id === targetId)!;
    try {
      // Checked first, so the text never goes in without its images.
      images.reduce(appendImage, getDraft(targetId));
      // The open composer saves its text with the images it last drew, so
      // the text goes in first and the images after it.
      if (targetId === selected && composer.current) composer.current.append(text);
      else {
        setDraft(targetId, current => appendDraft(current, text));
        if (!draftText(getDraft(targetId)).endsWith(text)) throw new Error("not added");
      }
      setDraft(targetId, current => images.reduce(appendImage, current));
    } catch {
      return `${target.name}’s saved draft needs recovering first; nothing was added. Open ${target.name} to recover it.`;
    }
    selectAgent(targetId);
    requestAnimationFrame(() => composer.current?.focus());
    setNotice(`Added the annotated image and notes to ${target.name}’s draft. Edit it, then send.`);
    return null;
  }
  function getDraftImages(targetId: string) {
    try {
      return getDraft(targetId).images || [];
    } catch {
      return [];
    }
  }
  /** Point & Fix (T-167) on an image already in the draft: read from Core
   * where it was saved, never chosen again from the user's files. */
  function markUpDraftImage(image: { id: string; agentId: string; name?: string }) {
    const name = image.name || "Pasted image";
    openPointFix({
      name,
      ownerId: image.agentId,
      provenance: `the image ${name} you attached`,
      inDraft: { agentId: image.agentId, id: image.id },
      load: async (signal) => {
        const response = await fetch(inputImageUrl(image.agentId, image.id), { signal });
        if (!response.ok) throw new Error(`the saved image is unavailable (HTTP ${response.status})`);
        return response.blob();
      },
    });
  }
  const openPointFix = useCallback((source: PointFixSource) => {
    setArtifact(null);
    setPointFix(source);
  }, []);
  const handoffRef = useRef({ agents: () => [] as Agent[], send: handoffToAgent });
  handoffRef.current = { agents: () => workspace?.agents || [], send: handoffToAgent };
  const handoffApi = useMemo<HandoffApi>(() => ({
    agents: () => handoffRef.current.agents(),
    send: (source, id) => handoffRef.current.send(source, id),
  }), []);
  const sendQuestionAnswer = useCallback((text: string, source: QuestionSource) => turnHandlers.current.submitMessage(text, source), []);
  function showQuestionSource(source: QuestionSource) {
    showConversationSource(source);
  }
  function showConversationSource(source: QuestionSource, openDetails = false) {
    if (!agent) return;
    openCatchupSource({
      ...source, id: source.itemId, agentId: agent.id, agentName: agent.name,
      kind: "progress", title: "Original source", body: "", seq: agent.lastSeq,
    }, "rail", openDetails);
  }
  function showProposedChanges(request: PendingRequest) {
    const itemId = request.params.itemId;
    if (typeof itemId !== "string") return;
    const turnId = typeof request.params.turnId === "string"
      ? request.params.turnId
      : currentDetail?.turns.find(turn => turn.items.some(item => item.id === itemId))?.id;
    if (!turnId) {
      setNotice("This request has no turn reference, so its proposed changes cannot be located. Check the request details.");
      return;
    }
    showConversationSource({ turnId, itemId }, true);
  }
  async function markReviewed() {
    if (!currentDetail || previewMode) return;
    const throughSeq = currentDetail.agent.lastSeq;
    try {
      await post(`/agents/${encodeURIComponent(selected)}/review`, {
        throughSeq,
      });
      refresh();
      setReadActionsOpen(false);
      setNotice("Conversation marked as read. Pending requests stay open.");
    } catch (e) {
      throw e;
    }
  }
  function agentChanged(action: AgentAction, updated?: Agent) {
    if (!agent) return;
    const id = agent.id;
    if (action === "delete") {
      const remaining = workspace?.agents.filter((a) => a.id !== id) || [];
      // Only an agent in this scope may take its place; opening one from
      // another project would also start reading it.
      const nearby = remaining.filter((a) => inScope(a, scope));
      const next =
        nearby.find((a) =>
          agentScope === "closed" ? !!a.closedAt : !a.closedAt,
        ) ||
        nearby.find((a) => !a.closedAt) ||
        nearby[0];
      setWorkspace((w) => (w ? { ...w, agents: remaining } : w));
      removeDraft(id);
      if (currentSelected.current === id) {
        setSelected(next?.id || "");
        setAgentScope(next?.closedAt ? "closed" : "active");
        if (!next && remaining.length) setHomeOpen(true);
      }
      setNotice(
        `${agent.name} was deleted. Project files and the original session were kept.`,
      );
    } else if (updated) {
      setWorkspace((w) =>
        w
          ? { ...w, agents: w.agents.map((a) => (a.id === id ? updated : a)) }
          : w,
      );
      live.sync.mutate((d) => (d.agent.id === id ? { ...d, agent: updated } : d));
      if (currentSelected.current === id)
        setAgentScope(action === "close" ? "closed" : "active");
      setNotice(
        action === "close"
          ? `${agent.name} is in Closed. Conversation and draft are saved.`
          : `${agent.name} is back with the same conversation.`,
      );
    }
    live.clearError();
    setCatchupSource(null);
    refresh();
  }
  const filteredAgents =
    (agentScope === "closed" ? scopedClosed : scopedActive).filter((a) =>
      `${a.name} ${a.workSummary?.text || ""} ${a.cwd} ${a.remote?.machine.name || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) || [];

  return (
    <HandoffContext.Provider value={handoffApi}>
    <PointFixOpen.Provider value={previewMode ? null : openPointFix}>
    <MessageLinks.Provider value={messageLinks}>
    <div
      className={`app ${isNative ? "native" : "web"} ${railOpen || phone ? "" : "rail-hidden"} ${inspectorShown && !phone ? "with-inspector" : ""}${phone ? ` phone${listShown ? " phone-list" : ""}${inspectorShown ? " phone-inspector" : ""}` : ""}`}
      style={panelWidths.style}
    >
      {previewMode && (
        <div className="preview-strip">
          <Sparkles size={12} />
          <strong>Design preview</strong>
          <span>Sample content · read-only · no runtime connected</span>
          <a
            href={
              window.location.protocol === "file:"
                ? "http://127.0.0.1:4317/"
                : window.location.pathname
            }
          >
            Open workspace <ArrowUpRight size={12} />
          </a>
        </div>
      )}
      <header
        className={`toolbar${frame ? " window-frame" : ""}`}
        onMouseDown={(event) => moveWindow(frame, event)}
      >
        <div className="toolbar-brand">
          {phone && !phoneList ? (
            <button
              ref={phoneBack}
              className="phone-back"
              title="Back to the Agent list"
              onClick={showAgentList}
            >
              <ChevronLeft size={18} />
              Agents
            </button>
          ) : (
            <>
              <Yuzu size={32} />
              <span>
                yuzuno<span className="brand-dot">.</span>
              </span>
              <span className="early-label">early days</span>
            </>
          )}
        </div>
        <div className="toolbar-middle">
          <span className="toolbar-separator" />
          <button
            className="icon-button"
            aria-label={railOpen ? "Hide agent sidebar" : "Show agent sidebar"}
            title="Toggle sidebar"
            onClick={() => setRailOpen((v) => !v)}
          >
            <PanelLeft size={17} />
          </button>
          <span className="workspace-name">Personal workspace</span>
          <span className="toolbar-context">
            {isNative ? "Desktop" : "Workspace"}
          </span>
          {/* Workspace-wide views live here; the sidebar is all agents. */}
          <nav className="toolbar-nav" aria-label="Workspace views">
            <button
              className={`catchup-nav ${homeOpen ? "selected" : ""}`}
              aria-current={homeOpen ? "page" : undefined}
              title={needsYou > 0 ? `Home · ${needsYou} waiting for your response` : "Home"}
              onClick={() => {
                setHomeOpen(true);
                setPhoneList(false);
              }}
            >
              <House size={15} />
              <span className="toolbar-nav-label">Home</span>
              {needsYou > 0 && (
                <span className="nav-count attention">{needsYou}</span>
              )}
            </button>
            <button
              className="catchup-nav collab-nav"
              title="Tasks & messages"
              onClick={() => setCollaborationOpen(true)}
              disabled={loading}
            >
              <MessageSquare size={15} />
              <span className="toolbar-nav-label">Tasks & messages</span>
            </button>
            <Jobs key={`jobs-${workspaceId}`} workspaceId={workspaceId} agent={agent} agents={workspace?.agents || []} revision={String(jobsRevision)} disabled={previewMode || loading} />
          </nav>
        </div>
        <div className="toolbar-actions">
          <span
            className={`connection ${core.healthy ? "connected" : ""}`}
            title={core.description}
            data-core-status={core.label}
          >
            <span />
            {core.label}
          </span>
          {updatesNeedReload && <UpdateBanner onOpen={() => setUpdatesOpen(true)} />}
            <button
              className="icon-button workspace-settings"
              title="Settings · updates, appearance, desktop app and code review"
              aria-label="Settings and updates"
              onClick={() => setUpdatesOpen(true)}
            >
              <Settings2 size={16} />
            </button>
          <button
            className={`icon-button ${(phone ? phoneInspector : inspector) ? "active" : ""}`}
            title="Toggle context panel"
            aria-label="Toggle context panel"
            onClick={() => {
              if (!phone) return setInspector((v) => !v);
              // On a phone the panel is a screen of its own, over what is open.
              setPhoneInspector((v) => !v);
              setPhoneList(false);
            }}
          >
            <PanelRight size={17} />
          </button>
        </div>
        {frame && <WindowControls frame={frame} />}
      </header>
      <aside className="rail" id="agent-sidebar" inert={phone && !phoneList ? true : undefined}>
        <PanelResizeHandle side="rail" size={panelWidths.rail} />
        <div className="rail-top">
          <RailHeading
            scope={agentScope}
            active={scopedActive.length}
            closed={scopedClosed.length}
            shortcut={shortcutModifier}
            onScope={setAgentScope}
            onSearch={() => setSearchOpen((v) => !v)}
            onCreate={() => setCreateOpen(true)}
          />
          {searchOpen && (
            <div className="agent-search">
              <Search size={13} />
              <input
                autoFocus
                placeholder="Find an agent or paste a message link…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && searchLink) {
                    e.preventDefault();
                    openSearchLink();
                  }
                }}
                aria-label="Search agents"
              />
              <button
                className="icon-button"
                aria-label="Close search"
                onClick={() => {
                  setSearchOpen(false);
                  setSearch("");
                }}
              >
                <X size={12} />
              </button>
            </div>
          )}
          {searchLink && (
            <button className="quiet-button open-message-link" onClick={openSearchLink}>
              <Link2 size={13} />
              Open linked message
            </button>
          )}
        </div>
        <nav className="agent-list" aria-label="Agents">
          {(() => {
            const row = (a: Agent) => (
            <AgentRailRow
              key={a.id}
              agent={a}
              selected={selected === a.id && !homeOpen}
              statusLabel={
                a.closedAt
                  ? "Closed"
                  : a.id === selected && compacting
                    ? "Compacting"
                    : statusLabels[a.status]
              }
              idle={
                !a.closedAt &&
                !(a.id === selected && compacting) &&
                a.status === "idle"
              }
              onSelect={() => openFromList(a.id)}
            />
            );
            // All projects, grouped as Settings chooses; a project's own
            // list, or No grouping, stays one list.
            const groups =
              scope === ALL_PROJECTS && appearance.projectGroups !== "none"
                ? groupAgents(filteredAgents, projects)
                : null;
            return groups ? (
              <GroupedAgents
                groups={groups}
                style={appearance.projectGroups as Exclude<typeof appearance.projectGroups, "none">}
                workspaceId={workspaceId}
                selectedId={homeOpen ? null : selected}
                searching={!!search.trim()}
                renderAgent={row}
                onCreate={(projectId) => {
                  setCreateProject(projectId ?? "");
                  setCreateOpen(true);
                }}
              />
            ) : (
              filteredAgents.map(row)
            );
          })()}
          {!loading && filteredAgents.length === 0 && !searchLink && (
            <div className="rail-empty">
              {search
                ? "No agents match your search."
                : agentScope === "closed"
                  ? "Closed agents wait here, ready to reopen."
                  : "Create an agent, then send a task."}
            </div>
          )}
          {/* Last in the list, so it scrolls with the agents. */}
          <button className="add-agent" onClick={() => setCreateOpen(true)}>
            <Plus size={15} />
            New agent<span>{shortcutModifier} N</span>
          </button>
        </nav>
        {outsidePending > 0 && (
          <button
            className="elsewhere-notice"
            onClick={() => {
              setHomeOpen(true);
              setPhoneList(false);
            }}
            title="Open Home to see them"
          >
            <Bell size={14} />
            <span>{outsidePending} waiting in other projects</span>
            <ChevronRight size={13} />
          </button>
        )}
        <ProjectSwitcher
          workspaceName="Personal workspace"
          reachable={core.healthy}
          reachability={core.description}
          scope={scope}
          projects={projects}
          agents={workspace?.agents || []}
          onScope={changeScope}
          onNewProject={() => setProjectDialog("new")}
          onManage={() => setProjectDialog("manage")}
          onMachines={() => setMachinesOpen(true)}
          onOpenChange={setScopeMenuOpen}
          readOnly={previewMode}
        />
      </aside>

      <ClarificationHost.Provider value={{ detail: currentDetail, outgoing, pendingInputs, readOnly: previewMode, submit: submitMessage, refresh }}>
      {/* On a phone the list or the context panel covers it, still mounted. */}
      <main className="main-panel" inert={listShown || (phone && inspectorShown) ? true : undefined}>
        {(workspaceError || core.browser) && (
          <div className="connection-banner core-connection-banner" role={workspaceError ? "alert" : "status"}>
            <WifiOff size={15} />
            <div>
              <strong>{workspaceError ? core.label : core.browser}</strong>
              <span>
                {workspaceError
                  ? core.detail
                  : workspace
                    ? "The last read from Core worked. Nothing is turned off: Yuzuno keeps checking, and drafts are kept."
                    : "No workspace has loaded yet. Nothing is turned off: Yuzuno keeps trying, and drafts are kept."}
              </span>
              {workspaceError && core.browser && <span>{core.browser}.</span>}
              <span>{core.stream}</span>
            </div>
            <button className="quiet-button" onClick={refresh}>
              <RefreshCw size={13} />
              Retry
            </button>
          </div>
        )}
        {!previewMode && !workspaceError && !core.browser && eventConnection === "reconnecting" && (
          <div className="connection-banner core-connection-banner event-connection-banner" role="status">
            <RefreshCw size={15} />
            <div>
              <strong>Live updates reconnecting</strong>
              <span>The event stream is reconnecting automatically. Workspace snapshots still refresh every 5 seconds while this window is visible.</span>
            </div>
          </div>
        )}
        {!workspaceError && workspace?.runtime.error && (
          <div className="connection-banner" role="alert">
            <CircleAlert size={15} />
            <div>
              <strong>Codex model list is unavailable.</strong>
              <span>{workspace.runtime.error}</span>
            </div>
          </div>
        )}
        {homeOpen ? (
          <Home
            revision={homeRevision}
            jobsRevision={jobsRevision}
            workspaceId={workspaceId}
            agents={workspace?.agents || []}
            projects={projects}
            readOnly={previewMode}
            onNavigate={openFromHome}
            onChanged={refresh}
            onNeedsYou={reportNeedsYou}
          />
        ) : agent ? (
          <>
            <div className="conversation-header">
              <div className="conversation-title">
                <Avatar agent={agent} />
                <div className="conversation-heading">
                  <h1 title={agent.name}>{agent.name}</h1>
                  <span className={`status-label runtime-${agent.status}`}>
                    <span className={`status-dot ${agent.status}`} />
                    {closed
                      ? "Closed"
                      : compacting
                        ? "Compacting"
                        : statusLabels[agent.status]}
                  </span>
                </div>
              </div>
              <div
                className="conversation-actions"
                role="group"
                aria-label="Conversation tools"
              >
                {!isOpenCode && <AgentSettings
                  key={`settings-${selected}`}
                  agent={agent}
                  observedPermissionMode={
                    currentDetail?.claudeRuntime?.permissionMode
                  }
                  observedEffort={observedEffort(detail)}
                  observedContextUsage={currentDetail?.contextUsage}
                  disabled={previewMode || closed}
                  onOpenChange={setAgentSettingsOpen}
                  request={modelRequest}
                  onRequestOpened={() => setNotice(modelRequest?.kind === "permissions"
                    ? "Agent settings are open, with this Agent's permissions. A change applies from its next turn."
                    : "Model settings are open. A change applies from this Agent's next turn.")}
                  onSaved={() => {
                    refresh();
                    setNotice(
                      agent.harness === "claude"
                        ? "Agent settings saved."
                        : "Agent settings saved. Context changes need Apply in Agent settings.",
                    );
                  }}
                />}
                <ConversationSearch
                  savedAgentId={currentDetail?.conversation && !previewMode ? selected : undefined}
                  key={selected}
                  agentName={agent.name}
                  turns={currentDetail?.turns || []}
                  nativeHistory={sessionHistory.nativeTurns}
                  loadedNumbering={!!currentDetail?.history}
                  disabled={!currentDetail}
                  onLocate={result => openCatchupSource({
                    id: `search:${result.turnId}:${result.itemId}`, agentId: selected, agentName: agent.name,
                    kind: "result", title: "Search result", body: "", seq: 0, turnId: result.turnId, itemId: result.itemId,
                  }, "rail")}
                  onNavigate={() => {
                    searchReading.current = true;
                    setHistoryReading(true);
                    stickToBottom.current = false;
                    setAtBottom(false);
                    setJumpToTurn(null);
                    setSourceJump(false);
                  }}
                />
                <AgentManagement
                  key={`management-${selected}`}
                  agent={agent}
                  disabled={previewMode || !!workspaceError}
                  onOpenChange={setReadActionsOpen}
                  onChanged={agentChanged}
                  onRead={markReviewed}
                  requestReopen={requestReopen}
                  projectControl={
                    <AgentProjectPicker
                      agent={agent}
                      projects={projects}
                      disabled={previewMode || !!workspaceError}
                      onMoved={(moved) => {
                        // Keep the open conversation listed beside it.
                        revealAgent(moved);
                        setWorkspace((w) =>
                          w
                            ? {
                                ...w,
                                agents: w.agents.map((a) =>
                                  a.id === moved.id ? moved : a,
                                ),
                              }
                            : w,
                        );
                        setNotice(
                          moved.projectId
                            ? `${moved.name} is now in ${projectName(moved.projectId, projects)}.`
                            : `${moved.name} is no longer in a project.`,
                        );
                        refresh();
                      }}
                    />
                  }
                />
              </div>
            </div>
            {!closed && (
              <RemoteControls
                agent={agent}
                disabled={previewMode}
                onReconnected={refresh}
              />
            )}
            {/* Over this browser's own place too, not over a link or a source being read. */}
            {readingOffer?.agentId === selected && (!catchupSource || (catchupSource.restore !== undefined && catchupSource.progress === undefined)) && (
              <div className="source-navigation reading-offer" role="status">
                <span>
                  Continue where you were reading{" "}
                  {readingOffer.handoff.label === "desktop" ? "in the desktop app" : "in another browser"} ·{" "}
                  {ageText(readingOffer.handoff.ageSeconds)}
                </span>
                <button className="secondary-button" onClick={continueReading}>Continue</button>
                <button className="quiet-button" onClick={dismissReading}>Not now</button>
              </div>
            )}
            {catchupSource?.agentId === selected && (
              <div className="source-navigation">
                <button
                  className="quiet-button"
                  onClick={() =>
                    sourceOrigin === "home"
                      ? setHomeOpen(true)
                      : backToLatest()
                  }
                >
                  <ArrowLeft size={13} />
                  {sourceOrigin === "home"
                    ? "Back to Home"
                    : "Back to latest"}
                </button>
                <span role="status">
                  {sourceNotice || (catchupSource.progress !== undefined ? catchupSource.title
                    : catchupSource.restore !== undefined ? "Where you left off"
                    : catchupSource.link ? "Linked message" : "Original source")}
                </span>
              </div>
            )}
            <div className="conversation-body">
              {runningTurn && (
                <CurrentTurnPrompt
                  key={`${selected}:${runningTurn.id}`}
                  turn={runningTurn}
                  number={logicalTurns.findIndex(t => t.id === runningTurn.id) + 1}
                  loadedNumbering={!!currentDetail?.history}
                  loaded={runningTurn === loadedRunningTurn}
                  scrollRef={scroll}
                  onLocate={() => {
                    stickToBottom.current = false;
                    setHistoryReading(true);
                    setJumpToTurn(runningTurn.id);
                  }}
                />
              )}
              <div
                className="conversation-scroll"
                ref={scroll}
                data-agent-id={selected}
                onWheel={(e) => {
                  if (e.deltaY < 0) {
                    live.pinWindow();
                    stickToBottom.current = false;
                  }
                  if (e.deltaY > 0) readerScrollIntent();
                }}
                onTouchEnd={readerScrollIntent}
                onKeyDownCapture={(e) => {
                  if (
                    e.target instanceof HTMLElement &&
                    e.target.closest(
                      "input, textarea, select, [contenteditable=true]",
                    )
                  )
                    return;
                  if (["End", "PageDown", "ArrowDown", " "].includes(e.key))
                    readerScrollIntent();
                  if (["Home", "PageUp", "ArrowUp"].includes(e.key)) {
                    live.pinWindow();
                    stickToBottom.current = false;
                  }
                }}
                onClickCapture={(e) => {
                  if ((e.target as Element).closest?.("summary"))
                    readerToggled.current = performance.now();
                }}
                onPointerDown={(e) => {
                  // Native scrollbar events target the scroll container itself.
                  // Clicking a message or a source link must not leave history mode.
                  if (e.target === e.currentTarget)
                    draggingScrollbar.current = true;
                }}
                onScroll={() => {
                  const el = scroll.current;
                  if (el) {
                    if (
                      draggingScrollbar.current &&
                      el.scrollHeight - el.scrollTop - el.clientHeight < 8
                    ) {
                      setHistoryReading(false);
                      searchReading.current = false;
                    }
                    const bottom =
                      el.scrollHeight - el.scrollTop - el.clientHeight < 72;
                    if (!bottom && stickToBottom.current) live.pinWindow();
                    const latest = bottom && !searchReading.current && !currentDetail?.conversation?.hasAfter;
                    setAtBottom(latest);
                    stickToBottom.current = latest;
                    noteReading(latest);
                  }
                }}
              >
                <div className="conversation-inner" ref={followGrowth}>
                  <ConversationWindow key={selected} scroll={scroll} follow={stickToBottom}
                    target={sourceJump && catchupSource?.turnId ? { turnId: catchupSource.turnId, itemId: catchupSource.itemId }
                      : jumpToTurn ? { turnId: jumpToTurn } : pageTarget}>
                  {currentDetail?.conversation && <div className="conversation-history-window">
                    {currentDetail.conversation.hasBefore && <button className="inline-link" disabled={live.windowLoading || savedPages.loading} onClick={() => changeHistoryPage("before")}>
                      {live.windowLoading || savedPages.loading ? "Loading history…" : "Load earlier messages"}
                    </button>}
                    <p>Showing part of the saved conversation. Search finds saved messages; Copy turn includes the full turn. Text selection covers visible messages.</p>
                    {savedPages.error && <p role="alert" className="inline-error">{savedPages.error}</p>}
                  </div>}
                  {currentDetail?.history && (
                    <div className="session-history-loader">
                      <p>
                        {currentDetail.history.hasMore
                          ? nativeHistoryHere
                            ? "Recent conversation is loaded. Earlier turns are available on demand."
                            : "Earlier native turns come before the start of the saved conversation. Load earlier messages to reach them."
                          : currentDetail.conversation ? "All earlier native history pages are loaded." : "All saved turns are loaded."}
                      </p>
                      {currentDetail.history.hasMore && nativeHistoryHere && <p className="question-history-note">Earlier history has not been checked for questions.</p>}
                      {currentDetail.history.hasMore && nativeHistoryHere && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={sessionHistory.loading}
                          onClick={() => {
                            setHistoryReading(true);
                            searchReading.current = true;
                            stickToBottom.current = false;
                            void sessionHistory.loadEarlier(() => {
                              const el = scroll.current;
                              const anchor =
                                el?.querySelector<HTMLElement>(".turn");
                              if (anchor)
                                historyAnchor.current = {
                                  agentId: selected,
                                  element: anchor,
                                  top: anchor.getBoundingClientRect().top,
                                };
                            });
                          }}
                        >
                          {sessionHistory.loading ? (
                            <LoaderCircle size={14} className="spin" />
                          ) : (
                            <History size={14} />
                          )}
                          {sessionHistory.loading
                            ? "Loading earlier turns…"
                            : "Load earlier turns"}
                        </button>
                      )}
                      {sessionHistory.added !== null && !sessionHistory.loading && (
                        <p role="status" className="field-hint">
                          {sessionHistory.added
                            ? `Loaded ${sessionHistory.added} earlier ${sessionHistory.added === 1 ? "turn" : "turns"}.`
                            : "That page had no turns beyond the saved conversation."}
                        </p>
                      )}
                      {sessionHistory.error && (
                        <p role="alert" className="inline-error">
                          {sessionHistory.error}
                        </p>
                      )}
                    </div>
                  )}
                  {detailError && (
                    <p role="alert" className="inline-error">
                      {detailError}
                    </p>
                  )}
                  {pageSpace === "before" && currentDetail?.conversation?.hasBefore &&
                    <div aria-hidden="true" style={{ height: scroll.current?.clientHeight || 0 }} />}
                  {!currentDetail && !detailError ? (
                    <div className="loading-state">
                      <LoaderCircle size={18} className="spin" />
                      Opening conversation…
                    </div>
                  ) : currentDetail?.turns.length ? (
                    <ConversationRows id="turns" items={currentDetail.turns} itemKey={turn => turn.id}
                      estimate={turn => Math.max(180, turn.items.length * 65)}
                      onReading={turn => setReadingTurn(turn.id)}
                      targetKey={sourceJump ? catchupSource?.turnId : jumpToTurn || pageTarget?.turnId || undefined}>
                    {(turn, i) => (
                      <LiveTurn
                        key={turn.id}
                        turn={turn}
                        index={turn._yuzunoSlice?.index ?? i}
                        loadedNumbering={!!currentDetail.history}
                        isLatestAgentTurn={turn.id === latestAgentTurnId}
                        timeMarks={timeMarks}
                        backgroundShells={currentDetail.backgroundShells}
                        agent={agent}
                        pendingToolIds={pendingToolIds}
                        sourceItemId={
                          catchupSource?.agentId === selected &&
                          catchupSource.restore === undefined &&
                          catchupSource.turnId === turn.id
                            ? catchupSource.itemId
                            : undefined
                        }
                        highlightSource={
                          catchupSource?.agentId === selected &&
                          catchupSource.restore === undefined &&
                          catchupSource.turnId === turn.id &&
                          (!catchupSource.itemId ||
                            (catchupSource.itemId !==
                              `yuzuno-plan-${turn.id}` &&
                              !turn.items.some(
                                (item) => item.id === catchupSource.itemId,
                              )))
                        }
                        onFile={turnFile}
                        onRewindDraft={previewMode || closed ? undefined : rewindDraft}
                        receipts={currentDetail?.messageReceipts}
                        sendingInTurn={inTurn}
                        onResultInteract={turnInteract}
                        onOpenQuestion={openQuestion}
                        questionSources={questionSources}
                        onAnswer={
                          previewMode || closed
                            ? undefined
                            : turnAnswer
                        }
                      />
                    )}</ConversationRows>
                  ) : (
                    <div className="conversation-empty">
                      <Yuzu size={80} />
                      <h2>A fresh little beginning.</h2>
                      <p>
                        {agent.name} is ready. Give them a task,
                        <br />a question, or something to explore.
                      </p>
                    </div>
                  )}
                  {currentDetail?.conversation?.hasAfter && <div className="conversation-history-window">
                    <button className="inline-link" disabled={live.windowLoading} onClick={() => changeHistoryPage("after")}>
                      {live.windowLoading ? "Loading history…" : "Continue to newer messages"}
                    </button>
                    <button className="inline-link" onClick={backToLatest}>Back to latest</button>
                  </div>}
                  <OutgoingMessages
                    agentId={agent.id}
                    messages={outgoing}
                    detail={currentDetail}
                  />
                  {pending.map((request) => (
                    <PendingCard
                      key={request.id}
                      request={request}
                      refresh={refresh}
                      disabled={previewMode || closed}
                      onViewChanges={() => showProposedChanges(request)}
                      permissionMode={currentDetail?.claudeRuntime?.permissionMode}
                      draftScope={requestDraftScope}
                      highlightSource={
                        catchupSource?.kind === "pending" &&
                        catchupSource.id === request.id
                      }
                    />
                  ))}
                  {agent.error && !closed && (
                    <p
                      className={`inline-error${sourceOrigin === "rail" && catchupSource?.agentId === agent.id && catchupSource.kind === "error" ? " source-highlight" : ""}`}
                      id={`runtime-error-${agent.id}`}
                      tabIndex={-1}
                    >
                      {agent.error}
                    </p>
                  )}
                  <div
                    ref={readEnd}
                    className="read-end-marker"
                    aria-hidden="true"
                  />
                  {pageSpace === "after" && currentDetail?.conversation?.hasAfter &&
                    <div aria-hidden="true" style={{ height: scroll.current?.clientHeight || 0 }} />}
                  </ConversationWindow>
                </div>
              </div>
              {/* Jobs and CI on the left edge; the turn dock is on the right. */}
              <ConversationJobs key={`job-cards-${selected}`} agentId={agent.id} revision={String(jobsRevision)} disabled={previewMode}>
                {/* Sub-agents of the loaded Turns, under the jobs and runs. */}
                <ConversationSubAgentDock agent={agent} turns={currentDetail?.turns || EMPTY_TURNS}
                  running={currentDetail?.conversation?.runningSubAgents} onNavigate={navigateToTurn} />
                {/* Claude's shells, monitors and workflows running in the background. */}
                <ConversationBackgroundTaskDock agent={agent} turns={currentDetail?.turns || EMPTY_TURNS}
                  running={currentDetail?.conversation?.runningBackgroundTasks} onNavigate={navigateToTurn} />
              </ConversationJobs>
              <TurnNavigator
                key={selected}
                turns={logicalTurns}
                loadedNumbering={!!currentDetail?.history}
                scrollRef={scroll}
                readingTurnId={readingTurn}
                onInteractionChange={setTurnDockEngaged}
                onNavigate={navigateToTurn}
                atLatest={atBottom && !historyReading}
                onLatest={backToLatest}
              />
              {(!atBottom || historyReading) && (
                <button className="jump-latest" onClick={backToLatest}>
                  <ArrowDown size={13} />
                  Back to latest
                </button>
              )}
            </div>
            <PendingQuestions key={`${workspaceId}:${selected}`} ref={questionPanel} agentId={selected} workspaceId={workspaceId}
              detail={detail?.agent.id === selected ? detail : null} shown={currentDetail} known={coreQuestions}
              outgoing={outgoing} pendingInputs={pendingInputs} disabled={closed || previewMode || isClaude}
              onSend={sendQuestionAnswer} onAdd={turnAnswer} onSource={showQuestionSource}
              onCheck={() => reconnectAgent(selected).then(refresh)} />
            {closed ? (
              <>
                <div className="closed-agent-note">
                  <Archive size={23} />
                  <div>
                    <strong>This conversation is saved.</strong>
                    <p>
                      {hasDraft ? "Your unfinished draft is saved too. " : ""}
                      Reopen this agent to continue from the same session.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={previewMode || !!workspaceError}
                    onClick={() =>
                      setRequestReopen((v) => ({
                        agentId: agent.id,
                        sequence: (v?.sequence || 0) + 1,
                      }))
                    }
                  >
                    <ArchiveRestore size={15} /> Reopen
                  </button>
                </div>
                <div className="closed-conversation-metadata">
                  <ConversationMetadata
                    agent={agent}
                    projectName={
                      projectName(agent.projectId, projects) || "No project"
                    }
                  />
                </div>
              </>
            ) : (
              <div className="composer-area">
                {currentDetail && !isClaude && !previewMode && (
                  <CodexWriterNotice
                    detail={currentDetail}
                    agents={workspace?.agents || []}
                    disabled={closed}
                    onReconnect={() =>
                      reconnectAgent(selected)
                        .then(refresh)
                        .catch((e) => {
                          refresh();
                          setActionError(errorText(e));
                        })
                    }
                    onFork={() => setForkOpen(true)}
                    onOpen={(id) => selectAgent(id)}
                  />
                )}
                {currentDetail && recovery && (
                  <RecoveryNotice
                    key={selected}
                    detail={currentDetail}
                    disabled={closed || !!workspaceError}
                    hasDraft={hasDraft}
                    onRecovered={refresh}
                  />
                )}
                {currentDetail?.agent.harness === "claude" && !currentDetail.agent.remote && (
                  <QuotaResumeNotice key={selected} detail={currentDetail} disabled={closed || !!workspaceError} />
                )}
                {unconfirmedMessage && (
                  <div className="message-delivery-notice" role="status">
                    Message delivery is not confirmed. Your text is kept; it
                    will not be sent twice.
                    <button
                      type="button"
                      className="inline-link"
                      disabled={sending}
                      onClick={() =>
                        void reconnectAgent(selected)
                          .then(refresh)
                          .catch((e) => setActionError(errorText(e)))
                      }
                    >
                      Check delivery
                    </button>
                  </div>
                )}
                {actionError && (
                  <div role="alert" className="inline-error">
                    <CircleAlert size={14} />
                    {actionError}
                    <button
                      className="icon-button"
                      aria-label="Dismiss error"
                      onClick={() => setActionError("")}
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}
                <form
                  className={`composer ${busy ? "is-working" : ""}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                  onMouseDown={(e) => {
                    // The whole box is the input: a press anywhere but a
                    // control types at the end, as below the last line.
                    const field = composer.current;
                    if (
                      !field ||
                      e.button !== 0 ||
                      // Portals (e.g. a dialog overlay) bubble here in React.
                      !e.currentTarget.contains(e.target as Node) ||
                      (e.target as Element).closest(
                        "textarea, button, a, input, select, summary, [role], [tabindex]",
                      )
                    )
                      return;
                    e.preventDefault();
                    field.focusEnd();
                  }}
                >
                  <PastedTextComposer
                    ref={composer}
                    agentId={selected}
                    label={`Message ${agent.name}`}
                    placeholder={
                      previewMode
                        ? "This is a read-only design preview…"
                        : cannotSendWhileWorking
                          ? "Your draft will be ready when this turn finishes…"
                          : busy
                            ? "Add a thought while your agent works…"
                            : `A task, a question, a new idea for ${agent.name}…`
                    }
                    draft={draft}
                    readOnly={previewMode || draftBlocked}
                    slashCommands={previewMode || isOpenCode ? false : isClaude ? "claude" : "codex"}
                    onChange={next => setDraft(selected, next)}
                    onSkill={skill => skill.path && setDraft(selected, current => {
                      const others = (current.skills || []).filter(s => s.agentId === selected && !(s.name === skill.name && s.path === skill.path));
                      return { ...current, skills: [...others, { agentId: selected, name: skill.name, path: skill.path!, scope: skill.scope || "" }].slice(-MAX_DRAFT_SKILLS) };
                    })}
                    onImages={files => void imageUploads.add(files)}
                    onSubmit={() => void send()}
                  />
                  <ImageAttachments images={draft.images || []} description={agent?.harness === "claude" ? CLAUDE_IMAGE_NOTE : undefined} onRemove={previewMode || draftBlocked ? undefined : id => setDraft(selected, current => ({ ...current, images: current.images?.filter(image => image.id !== id) }))}
                    annotateThumbnails onAnnotate={previewMode || draftBlocked ? undefined : image => markUpDraftImage(image)} />
                  {/* Every chosen skill shows, so one that is not this Agent's can be removed. */}
                  <SkillChips skills={draft.skills || []}
                    onRemove={previewMode || draftBlocked ? undefined : skill => setDraft(selected, current => ({ ...current,
                      skills: current.skills?.filter(s => !(s.name === skill.name && s.path === skill.path)) }))} />
                  {imageUploads.error && <p className="inline-error" role="alert">{imageUploads.error}</p>}
                  {draftError && <p className="inline-error" role="alert">{draftError}</p>}
                  {draftBlocked && !previewMode && <DraftRecovery key={selected} onDiscard={() => discardSavedDraft(selected)} />}
                  <div className="composer-bottom">
                    <div className="composer-tools">
                      <input ref={imagePicker} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden aria-label="Choose images" onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; void imageUploads.add(files); }} />
                      {/* Agents that cannot take images keep the button, quieted, so
                          its tooltip can say why. */}
                      <button
                        type="button"
                        className="composer-tool"
                        aria-label={imageUploads.busy ? "Saving images…" : "Add images"}
                        aria-disabled={!imageSupported || undefined}
                        disabled={previewMode || draftBlocked || imageUploads.busy}
                        title={
                          imageSupported
                            ? `Add images · paste or choose PNG, JPEG or WebP, up to 8 images of 10 MiB each${agent?.harness === "claude" ? ` · ${CLAUDE_IMAGE_NOTE}` : ""}`
                            : "Images are available for Codex and Claude Agents"
                        }
                        onClick={() => { if (imageSupported) imagePicker.current?.click(); }}
                      >
                        {imageUploads.busy ? <LoaderCircle size={15} className="spin" /> : <ImagePlus size={15} />}
                      </button>
                      <input ref={pointFixPicker} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Choose an image to mark" onChange={event => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) openPointFix({ name: file.name || "Screenshot", ownerId: selected, provenance: `an image you chose (${file.name || "pasted"})`, load: async () => file });
                      }} />
                      <button
                        type="button"
                        className="composer-tool"
                        aria-label="Mark up an image"
                        title="Point & Fix · mark areas on a screenshot or image and add your notes to a draft"
                        disabled={previewMode}
                        onClick={() => pointFixPicker.current?.click()}
                      >
                        <SquareDashedMousePointer size={15} />
                      </button>
                      {!previewMode && <ResultRequest key={selected} onDraft={appendToDraft} />}
                      {!previewMode && !isClaude && !isOpenCode && (
                        <CodexPlanChip state={currentDetail?.codexPlan}
                          onOpen={() => setPlanRequest({ agentId: selected, draft: null, nonce: Date.now() })} />
                      )}
                    </div>
                    <span className="composer-hint" data-notice={composerNotice ? "" : undefined}>
                      {composerNotice ? (
                        <>
                          <Leaf size={13} />
                          {composerNotice}
                        </>
                      ) : (
                        <span className="composer-keys">
                          {touchKeyboard() ? (
                            <>
                              <kbd>↵</kbd> New line{" "}
                              <kbd>{shortcutModifier} ↵</kbd> Send
                            </>
                          ) : (
                            <>
                              <kbd>↵</kbd> Send{" "}
                              <kbd>⇧ ↵</kbd> New line
                            </>
                          )}
                        </span>
                      )}
                    </span>
                    <div className="composer-send-actions">
                      {busy && (
                        <button
                          type="button"
                          className="interrupt-button"
                          title="Interrupt · Esc"
                          disabled={previewMode || interrupting}
                          onClick={() => void interrupt()}
                        >
                          {interrupting ? (
                            <LoaderCircle size={13} className="spin" />
                          ) : (
                            <Square size={11} fill="currentColor" />
                          )}
                          {interrupting ? "Interrupting…" : "Interrupt"}
                        </button>
                      )}
                      <button
                        type="submit"
                        className="send-button"
                        disabled={
                          !hasDraft ||
                          imageUploads.busy ||
                          draftBlocked ||
                          !currentDetail ||
                          sending ||
                          cannotSendWhileWorking ||
                          holdForRecovery ||
                          previewMode ||
                          !!workspaceError
                        }
                        aria-label={
                          sendTurnId
                            ? "Send while working"
                            : "Send message"
                        }
                        title={
                          cannotSendWhileWorking || closed
                            ? "Wait for this turn to finish, or interrupt"
                            : holdForRecovery
                              ? recovery === "collaboration"
                                ? "Reconnect and check the workspace connection first"
                                : "Reconnect and check the last turn first"
                              : sendTurnId && !isClaude
                              ? "Add input to the current turn"
                              : "Send message"
                        }
                      >
                        {sending ? (
                          <LoaderCircle size={17} className="spin" />
                        ) : (
                          <ArrowUp size={18} />
                        )}
                      </button>
                    </div>
                  </div>
                </form>
                <div className="composer-footnote">
                  <ConversationMetadata
                    agent={agent}
                    projectName={
                      projectName(agent.projectId, projects) || "No project"
                    }
                  />
                  <div className="composer-context">
                    <ContextUsage
                      key={selected}
                      usedPercent={
                        previewMode && !isClaude
                          ? previewContextPercent[selected]
                          : null
                      }
                      sample={previewMode && !isClaude}
                      usage={currentDetail?.contextUsage}
                    />
                  </div>
                </div>
              </div>
            )}
          </>
        ) : loading ? (
          <div className="loading-state full">
            <LoaderCircle className="spin" size={22} />
            Opening your workspace…
          </div>
        ) : (
          <div className="welcome">
            <div className="welcome-eyebrow">
              <span />
              YOUR OWN LITTLE WORKSPACE
            </div>
            <div className="welcome-art">
              <span className="orbit o1" />
              <span className="orbit o2" />
              <span className="tiny-spark s1">✧</span>
              <span className="tiny-spark s2">✧</span>
              <Yuzu size={142} />
              <span className="welcome-ground" />
            </div>
            <h1>
              Good work starts
              <br />
              with a little space.
            </h1>
            <p>
              A home for your agents, their ideas,
              <br />
              and the things you’re making together.
            </p>
            <button
              className="primary-button welcome-create"
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={17} />
              Create your first agent
              <ArrowRight size={16} />
            </button>
            <div className="welcome-promises">
              <span>
                <MessageSquare size={14} />A conversation you can follow
              </span>
              <span>
                <Leaf size={14} />
                Your agents, in one place
              </span>
              <span>
                <History size={14} />A place to pick things up
              </span>
            </div>
            <div className="welcome-bottom">
              A little less juggling. <span>A little more doing.</span>
            </div>
          </div>
        )}
      </main>
      </ClarificationHost.Provider>

      {inspectorShown && (
        <aside className="inspector" id="context-panel">
          <PanelResizeHandle side="inspector" size={panelWidths.inspector} />
          <div className="inspector-content">
            <div className="inspector-heading">
              <span>At a glance</span>
              <button
                className="icon-button"
                aria-label="Close context panel"
                onClick={() => (phone ? setPhoneInspector(false) : setInspector(false))}
              >
                <X size={14} />
              </button>
            </div>
            <section className="purpose-section">
              <span className="section-eyebrow">
                <Leaf size={12} />
                CURRENT WORK
              </span>
              {agent.workSummary ? (
                <p>
                  {agent.workSummary.source === "user" && agent.workSummary.requestParts?.length ? (
                    <RequestSummary agentId={agent.id} summary={agent.workSummary} />
                  ) : <button
                    className="inspector-work-source"
                    onClick={() => openRailSource(agent, agent.workSummary!)}
                    title={summaryOrigin(agent.workSummary)}
                  >
                    {agent.workSummary.source === "agent" ? "Agent report · " : ""}
                    {agent.workSummary.text}
                  </button>}
                </p>
              ) : (
                <p className="field-hint">No task yet.</p>
              )}
              <div className="purpose-rule" />
              <dl>
                <div>
                  <dt>Working folder</dt>
                  <dd title={agent.cwd}>{workingFolder(agent.cwd)}</dd>
                </div>
                <div>
                  <dt>Harness</dt>
                  <dd>
                    {agentHarnessName(agent)}
                  </dd>
                </div>
                <div>
                  <dt>Location</dt>
                  <dd>
                    <Monitor size={12} />
                    {agent.remote?.machine.name || "Core host"}
                  </dd>
                </div>
                <div>
                  <dt>Session</dt>
                  <dd title={nativeSession(agent)}>
                    {nativeSession(agent)?.slice(0, 8) || "Not started yet"}
                  </dd>
                </div>
                {isClaude && (
                  <ClaudeRuntimeFacts runtime={currentDetail?.claudeRuntime} />
                )}
                {isClaude && currentDetail && !agent.remote && (
                  <AutoContinueSetting key={agent.id} detail={currentDetail} disabled={!!agent.closedAt} />
                )}
                {!isClaude && !isOpenCode && <CodexPlanUsage key={agent.id} agent={agent} streamConnected={eventConnection === "open"} />}
              </dl>
            </section>
            <ArtifactsPanel
              key={agent.id}
              artifacts={currentDetail?.artifacts || []}
              latestTurn={currentDetail?.turns.at(-1)}
              cwd={agent.cwd}
              onOpen={openFile}
            />
            {isClaude && <ClaudeMcpStatus agent={agent} />}
            {!isClaude && !isOpenCode && !previewMode && <CodexMcpStatus agent={agent} />}
            <section className="inspector-section">
              <div className="section-title">
                <h2>
                  <Clock3 size={14} />
                  This conversation
                </h2>
              </div>
              <div className="context-stat">
                <span>Turns</span>
                <strong>{currentDetail?.turns.length || 0}</strong>
              </div>
              <div className="context-stat">
                <span>Unread updates</span>
                <strong>{agent.unreadCount}</strong>
              </div>
              <div className="context-stat">
                <span>Needs your response</span>
                <strong className={agent.pendingCount ? "attention-text" : ""}>
                  {agent.pendingCount}
                </strong>
              </div>
              {agent.pendingCount > 0 && (
                <button
                  className="pending-shortcut"
                  onClick={() => {
                    scroll.current?.scrollTo({
                      top: scroll.current.scrollHeight,
                      behavior: "smooth",
                    });
                    stickToBottom.current = true;
                  }}
                >
                  <Bell size={13} />
                  Go to pending request
                  <ArrowRight size={13} />
                </button>
              )}
            </section>
            <div className="inspector-note">
              <Yuzu size={43} sleepy />
              <p>
                Every little step
                <br />
                is part of the story.
              </p>
            </div>
          </div>
        </aside>
      )}
      <StatusBar
        previewMode={previewMode}
        eventConnection={eventConnection}
        live={core.healthy && eventConnection === "open"}
        agents={workspace?.agents || []}
        revision={String(jobsRevision)}
        machinesRevision={String(machinesRevision)}
        claudeRuntime={isClaude ? currentDetail?.claudeRuntime : undefined}
        codexAgent={agent?.harness === "codex" ? agent : null}
        onMachines={() => setMachinesOpen(true)}
      />
      <WorkspaceUpdatesHost
        enabled={!previewMode}
        open={updatesOpen}
        onOpenChange={setUpdatesOpen}
        onNeedsReloadChange={setUpdatesNeedReload}
        preserveDrafts={() => { if (imageUploads.hasPending()) throw new Error("Wait for images to finish saving before updating."); preserveDrafts(); }}
      />
      <CollaborationBoard
        open={collaborationOpen}
        onOpenChange={setCollaborationOpen}
        agents={workspace?.agents || []}
        initialAgentId={selected}
        onOpenAgent={selectAgent}
        disabled={previewMode}
        revision={boardRevision}
        projects={projects}
        scope={scope}
        focus={taskFocus}
      />
      {agent && !isClaude && !isOpenCode && (
        <CodexGoalDialog
          key={`goal-${agent.id}-${goalRequest?.nonce ?? 0}`}
          agent={agent}
          open={goalRequest?.agentId === agent.id}
          initialObjective={goalRequest?.objective ?? ""}
          onOpenChange={(open) => { if (!open) setGoalRequest(null); }}
          onChanged={(notice) => {
            // The command is done once Codex has changed its goal.
            if (goalRequest) clearIfUnchanged(goalRequest.agentId, goalRequest.draft);
            setNotice(notice);
            refresh();
          }}
        />
      )}
      {agent && !isClaude && !isOpenCode && (
        <CodexPlanDialog
          key={`plan-${agent.id}-${planRequest?.nonce ?? 0}`}
          agent={agent}
          open={planRequest?.agentId === agent.id}
          // Working, or waiting on a request that blocks the turn, as Core checks.
          turnRunning={busy}
          onOpenChange={(open) => { if (!open) setPlanRequest(null); }}
          onChanged={(notice) => {
            // `/plan` is done once Codex has accepted a switch; the dialog
            // stays open on what Codex reports.
            if (planRequest?.draft) clearIfUnchanged(planRequest.agentId, planRequest.draft);
            setNotice(notice);
            refresh();
          }}
        />
      )}
      {agent && !isClaude && !isOpenCode && (
        <CodexReviewDialog
          key={`review-${agent.id}-${reviewRequest?.nonce ?? 0}`}
          agent={agent}
          open={reviewRequest?.agentId === agent.id}
          onOpenChange={(open) => { if (!open) setReviewRequest(null); }}
          onStarted={() => { if (reviewRequest) reviewStarted(reviewRequest.agentId, reviewRequest.draft); }}
        />
      )}
      {agent && !isClaude && !isOpenCode && changesRequest?.agentId === agent.id && (
        <CodexChangesDialog
          key={`changes-${agent.id}-${changesRequest.nonce}`}
          agent={agent}
          open
          turnId={changesRequest.turnId}
          turns={currentDetail?.agent.id === agent.id ? currentDetail.turns : []}
          turnNumber={changesRequest.turnId ? logicalTurns.findIndex((turn) => turn.id === changesRequest.turnId) + 1 || null : null}
          olderNotLoaded={!!currentDetail?.conversation?.hasBefore || !!currentDetail?.history?.hasMore}
          onOpenChange={(open) => { if (!open) setChangesRequest(null); }}
          onFile={(path) => { setChangesRequest(null); turnFile(path); }}
          onShowEdit={(turnId, itemId) => {
            setChangesRequest(null);
            openCatchupSource({ id: `changes:${turnId}:${itemId}`, agentId: agent.id, agentName: agent.name, kind: "progress",
              title: "File edit", body: "", turnId, itemId, seq: agent.lastSeq }, "rail", true);
          }}
        />
      )}
      {agent && !isClaude && !isOpenCode && terminalsRequest?.agentId === agent.id && (
        <CodexTerminalsDialog
          key={`terminals-${agent.id}-${terminalsRequest.nonce}`}
          agent={agent}
          mode={terminalsRequest.mode}
          open
          onOpenChange={(open) => { if (!open) setTerminalsRequest(null); }}
        />
      )}
      {agent && !isClaude && !isOpenCode && diffRequest?.agentId === agent.id && (
        <CodexDiffDialog
          key={`diff-${agent.id}-${diffRequest.nonce}`}
          agent={agent}
          open
          onOpenChange={(open) => { if (!open) setDiffRequest(null); }}
        />
      )}
      {agent && !isClaude && !isOpenCode && (
        <ForkCodexDialog
          key={`fork-${agent.id}`}
          agent={agent}
          open={forkOpen}
          onOpenChange={setForkOpen}
          projectLabel={(id) => projectName(id, projects)}
          onForked={(outcome) => {
            const fork = outcome.agent!;
            const sourceId = agent.id;
            // Draft protection: the unsent text is copied, never sent.
            copyDraft(sourceId, fork.id);
            setWorkspace((w) =>
              w
                ? {
                    ...w,
                    agents: [...w.agents.filter((a) => a.id !== fork.id), fork],
                  }
                : w,
            );
            revealAgent(fork);
            setSelected(fork.id);
            // An earlier fork for this boundary may since have been closed.
            setAgentScope(fork.closedAt ? "closed" : "active");
            refresh();
            setNotice(
              fork.closedAt
                ? `This conversation already continues in ${fork.name}, which is closed. Reopen it to continue; nothing was sent.`
                : outcome.connected
                  ? `Continuing in ${fork.name} from the fork. Nothing was sent.`
                  : `${fork.name} was created from the fork but isn’t connected yet. ${outcome.warnings.join(" ")}`,
            );
          }}
        />
      )}
      <RemoteCreateAgent
        open={createOpen}
        initial={createInitial}
        close={() => {
          setCreateOpen(false);
          setCreateProject(null);
          setCreateInitial(null);
        }}
        defaultCwd={workspace?.defaultCwd || ""}
        opencode={!!workspace?.opencode?.enabled}
        disabled={previewMode}
        projects={projects}
        initialProjectId={createProject ?? (scopeProjectId(scope) || "")}
        onCreated={(a, source) => {
          setWorkspace((w) =>
            w
              ? {
                  ...w,
                  agents: [...w.agents.filter((agent) => agent.id !== a.id), a],
                }
              : {
                  agents: [a],
                  defaultCwd: a.cwd,
                  runtime: { connected: true },
                },
          );
          revealAgent(a);
          setSelected(a.id);
          setAgentScope(a.closedAt ? "closed" : "active");
          setHomeOpen(false);
          refresh();
          setNotice(
            a.projectDefaultError
              ? `${a.name} is ready, but the project's default folder wasn't saved: ${a.projectDefaultError}`
              : source === "imported"
                ? "Added with history. The original client must release the session before you continue here; an idle session may still be owned there."
                : source === "existing"
                  ? `Opened ${a.name}’s saved conversation.`
                  : `${a.name} has a little space of their own.`,
          );
        }}
      />
      <MachinesPage
        open={machinesOpen}
        onOpenChange={setMachinesOpen}
        agents={workspace?.agents || []}
        projects={projects}
        revision={machinesRevision}
        onOpenAgent={(id) => {
          setMachinesOpen(false);
          selectAgent(id);
        }}
      />
      <ProjectManager
        open={!!projectDialog}
        onOpenChange={(open) => !open && setProjectDialog(null)}
        initialView={projectDialog || "manage"}
        projects={projects}
        usage={workspace?.projectUsage}
        agents={workspace?.agents || []}
        onChanged={refresh}
        onCreated={(project) =>
          setNotice(`${project.name} is ready. Add agents or tasks to it.`)
        }
      />
      <ArtifactModal
        artifact={artifact}
        agentId={selected}
        onClose={() => setArtifact(null)}
        onCloseAutoFocus={restoreFilePosition}
        preview={previewMode}
        onAnnotate={previewMode || artifact?.kind !== "image" ? undefined : () => {
          const shown = artifact, owner = agent;
          openPointFix({
            name: shown.name,
            ownerId: owner?.id || null,
            provenance: `the file ${shown.path} in ${owner?.name || "this Agent"}’s conversation`,
            load: async (signal) => {
              const response = await fetch(artifactUrl(selected, shown.path), { signal });
              if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
              return response.blob();
            },
          });
        }}
      />
      <PointFix
        source={pointFix}
        agents={workspace?.agents || []}
        room={pointFixRoom}
        draftPosition={(agentId, imageId) => getDraftImages(agentId).findIndex(image => image.id === imageId) + 1}
        onAdd={addPointFix}
        onClose={() => setPointFix(null)}
      />
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
      <HandoffDropStrip />
    </div>
    </MessageLinks.Provider>
    </PointFixOpen.Provider>
    </HandoffContext.Provider>
  );
}
