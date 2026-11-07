import { flushSync } from "react-dom";
import { ImageAttachments, inputImageUrl } from "./ImageAttachments";
import { SkillChips } from "./SkillChips";
import { MAX_DRAFT_SKILLS } from "./composer-draft";
import { useImageUploads } from "./useImageUploads";
import { PointFix, imageRefusal } from "./PointFix";
import { PointFixOpen, type PointFixSource } from "./point-fix";
import { appendImage, clipboardImages, MAX_IMAGES, MAX_IMAGE_TOTAL, type DraftImage } from "./image-input";
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
import { ringAgain, settleWhenLanded } from "./settle";
import { ToastStack, type ToastText } from "./Toasts";
import { animates } from "./motion";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Bell,
  BellRing,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  History,
  House,
  Link2,
  ImagePlus,
  Shapes,
  SquareDashedMousePointer,
  Leaf,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minimize2,
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
  interruptAgent,
  scopeRequests,
  shortcutModifier,
} from "./api";
import { nativeControl } from "./slash-commands";
import { touchKeyboard, useTouchInput } from "./touch-input";
import { returnSends, useDevicePreferences } from "./device-preferences";
import { pressed, shortcutKeys, useShortcutKeys } from "./shortcut-keys";
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
import type { SettingsDestination, SettingsEditor } from "./settings-catalog";
import { destinationPage, type SettingsPage } from "./settings-pages";
import type { SettingsOpenAt } from "./SettingsCenter";
import { UpdateBanner, WorkspaceUpdatesHost } from "./WorkspaceUpdates";
import { onFollowApplied, useAppearanceFollow } from "./appearance-follow";
import { RemoteCreateAgent, type CreateInitial } from "./RemoteCreateAgent";
import { useSessionHistory } from "./useSessionHistory";
import { useSavedPages } from "./useSavedPages";
import { MessageLinks, agentLinkHref, messageLinkHref, parseAppLink, reportLinkHref, type AgentLink, type AppLink, type HomeLink, type MessageLink, type MessageLinkApi, type ReportLink } from "./deep-link";
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
import { EndMissingTurnDialog } from "./EndMissingTurn";
import { DisconnectAgentDialog } from "./DisconnectAgent";
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
import { AgentActionsMenu } from "./AgentActionsMenu";
import { BatchReconnect } from "./BatchReconnect";
import type { AgentActionHandlers } from "./agent-actions";
import { useConversationSend } from "./useConversationSend";
import { ClarificationHost } from "./intelligent-ui/ClarificationHost";
import { AgentRailRow, summaryOrigin, workingFolder } from "./AgentRailRow";
import { RailHeading } from "./RailHeading";
import { GroupedAgents } from "./ProjectGroups";
import { ExecutorRail } from "./ExecutorRail";
import { inExecutors, isArchived } from "./executor-lifecycle";
import { groupAgents } from "./project-groups";
import { useAppearance } from "./appearance";
import { StatusBar } from "./StatusBar";
import { AUTO_READ_DWELL_MS, useAutoRead } from "./useAutoRead";
import { PanelResizeHandle, usePanelWidths } from "./ResizablePanels";
import { CollaborationBoard } from "./CollaborationBoard";
import { MachinesPage } from "./MachinesPage";
import {
  AgentProjectPicker,
  ProjectsPage,
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
import { langTag, useLanguage } from "./i18n";
import { shellText, type ShellWords } from "./shell-text";
import "./connection-status.css";
import { OutgoingMessages } from "./OutgoingMessages";
import { sendingInTurn } from "./delivery-note";
import { CurrentTurnPrompt } from "./CurrentTurnPrompt";
import { Jobs, ConversationJobs } from "./Jobs";
import { WorkActivityColumn, WorkActivityEntry, WorkActivityProvider } from "./WorkDock";
import { RailTurnIndex } from "./RailTurnIndex";
import { ConversationSubAgentDock } from "./ClaudeSubAgentDock";
import { ConversationBackgroundTaskDock } from "./ClaudeBackgroundTasks";
import { refreshLiveJobs } from "./live-jobs";
import { clearLiveCI, refreshLiveCI } from "./live-ci";
import { clearLiveExecutors, refreshLiveExecutors } from "./live-executors";
import { TurnNavigator } from "./TurnNavigator";
import { useConversationInputs } from "./useConversationInputs";
import { entryInput, inputEntries, readingEntry, type ReadBy } from "./input-dock";
import { InputReading } from "./input-reading";
import { ConversationWindow, ConversationRows } from "./ConversationWindow";
import { HistoryEntry } from "./HistoryEntry";
import { ConversationMetadata } from "./ConversationMetadata";
import { moveWindow, useCustomFrame, WindowControls } from "./WindowControls";
import { conversationTimeMarks } from "./conversation-time";
import { useTimeDisplay } from "./time-preferences";
import { PastedTextComposer, type ComposerHandle } from "./PastedTextComposer";
import { ComposerAddMenu } from "./ComposerAddMenu";
import { useComposerShape } from "./composer-shape";
import { draftTextBlocks } from "./message-content";
import { RequestSummary } from "./MessageContent";
import { appendDraft, appendDraftOnce, draftText, hasDraftContent, type ComposerDraft } from "./composer-draft";
import { HandoffContext, HandoffDropStrip, type HandoffApi } from "./SendToAgent";
import { handoffLabel, handoffNotices, handoffRefusal, handoffText, type HandoffSource } from "./handoff";
import { useComposerDraft } from "./useComposerDraft";
import { DraftRecovery } from "./DraftRecovery";
import { PendingQuestions, type PendingQuestionsHandle } from "./PendingQuestions";
import { QuestionIndex, questionKey } from "./pending-questions";
import { pruneRequestDrafts } from "./request-draft";
import { usePhone } from "./phone-layout";
import { PhoneDockButtons, usePhoneDockMotion, type PhoneDock } from "./PhoneDocks";
import { useArrivalsIn, useDelayedPresence, useSurfaceIn } from "./surface";
import { ConversationStrips } from "./ConversationStrips";
import { followVisualViewport } from "./keyboard-viewport";
import type { HomeReplyOrigin, NativeTurn, QuestionSource } from "./types";
import { HomeReplyLinks, homeReplyText, type HomeReplyLinksApi } from "./home-reply/HomeReply";
import { reportText } from "./home/report/report-text";
import { Home, type HomeTarget } from "./home/Home";
import {
  needsYouTargets,
  nextTarget,
  orderByAttention,
  unseenEnd,
  waitingSince,
  type NeedsJump,
  type NeedsTarget,
} from "./attention";
import { markTurnSeen, useTurnSeen } from "./turn-seen";
import { useOpenAsks } from "./home/open-asks";
import { useBackupRun, useSystemNotifications } from "./useSystemNotifications";
import { OpenCodeRevertHost } from "./Rewind";
import { OpenCodeForkHost, type OpenCodeForkOutcome } from "./ForkOpenCode";
import { ExecutorOverview, ExecutorPaneTabs, type ExecutorPaneTab } from "./ExecutorOverview";

type TurnProps = ComponentProps<typeof Turn>;
/** Streamed changes replace only the Turn they touch; the others keep their
 * identity and are not rendered again. Callbacks are compared by presence
 * only: App passes ones that always call its latest handlers. */
const LiveTurn = memo(Turn, (a: TurnProps, b: TurnProps) =>
  a.turn === b.turn &&
  a.index === b.index &&
  a.loadedNumbering === b.loadedNumbering &&
  a.isLatestAgentTurn === b.isLatestAgentTurn &&
  a.time === b.time &&
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
  a.inputNumbers === b.inputNumbers &&
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
/**
 * Which Agent this window last had open, per Workspace (T-195). Two saved
 * Workspaces can sit at one address: one memory between them meant each
 * visit overwrote the other's, and where an Agent id happened to exist in
 * both, one Workspace opened the other's choice.
 *
 * Shaped like its sibling in this same read, `scopeStorageKey`. The older
 * unscoped `yuzuno.selected` is not read: it says which Agent but not which
 * Workspace. It is left where it is -- this is a reading place, which the
 * storage view already says is made again as you use Yuzuno.
 */
const selectedStorageKey = (workspaceId: string) => `yuzuno.selected.${workspaceId}`;
function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private storage can be unavailable. */
  }
}
// A stable empty list, so the sub-agent dock's memo holds without a detail.
const EMPTY_TURNS: never[] = [];
/** The page's own title, which a count of what needs the user prefixes (T-42). */
const PAGE_TITLE = typeof document === "undefined" ? "Yuzuno" : document.title;
/** Frames a new Agent's row waits for its folded group to open (T-19 SH:R11). */
const JOIN_WAIT = 90;
/** A Turn still working, as its own view tells (components.tsx `running`). */
const RUNNING_TURN = /inProgress|running/;
/** Where a held message is read: its text, below its minute mark. A run of
 * messages in one minute shows only its first time, so loading earlier ones
 * can take that line away; holding the message's box would move its text by
 * the line (T-161). */
function readingTop(element: HTMLElement) {
  const text = Array.from(element.children).find(child => !child.classList.contains("message-time"));
  return (text ?? element).getBoundingClientRect().top;
}

/**
 * Whether an event on the conversation's scroller is its own: one whose
 * target is inside it. A dialog or menu portaled out of it (an OpenCode
 * revert's, a rewind's) still sends its clicks, wheels, touches and keys
 * there through React, and they must neither take the conversation from
 * following nor send it back to the end (T-10, Lead 4153, 4154).
 */
function ownEvent(e: { target: EventTarget; currentTarget: EventTarget }): boolean {
  return e.target instanceof Node && e.currentTarget instanceof Node && e.currentTarget.contains(e.target);
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(
    previewMode ? previewWorkspace : null,
  );
  // Empty until /api/workspace says which Workspace this is: the Agent to
  // open is that Workspace's to remember (selectedStorageKey), and the same
  // read already settles which Agent is shown.
  const [selected, setSelected] = useState<string>(previewMode ? "mikan" : "");
  // Which Workspace this window is in. Empty until /api/workspace answers,
  // and what belongs to one Workspace -- the shown conversation, drafts,
  // unsent messages, shared requests -- is neither read nor written while it
  // is (T-195).
  const workspaceId = workspace?.workspace?.id || "";
  // First, so a request started by any hook, effect or control below is
  // shared only within the Workspace it was started in.
  useEffect(() => {
    scopeRequests(previewMode ? "" : workspaceId);
  }, [workspaceId]);
  // The shown Agent's detail: read once, then patched from the event stream.
  const live = useAgentDetail(workspaceId, previewMode ? null : selected || null);
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
  // Core's merge queue (T-65): its tick and actions say `mergeQueue`.
  const [mergeQueueRevision, mergeQueueRefresh] = useRefreshTrigger();
  // Only for the Home tab's count of open Asks while Home is closed.
  const [asksRevision, asksRefresh] = useRefreshTrigger();
  // The shared Appearance preset, for a device that follows it (T-194).
  const [presetRevision, presetRefresh] = useRefreshTrigger();
  const [loading, setLoading] = useState(!previewMode);
  // Retry in the connection banner, from its press until the read it starts
  // is over (T-19 SH:M05).
  const [retrying, setRetrying] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // A project chosen by a group's "+": its id, "" for none, null to follow
  // the project scope.
  const [createProject, setCreateProject] = useState<string | null>(null);
  // Settings that change what the Agent list renders, not only its look.
  const appearance = useAppearance();
  // Which key sends, on this device (T-189); unset, as before.
  const { sendKey } = useDevicePreferences();
  // The letters shown beside New agent, as this device has them.
  const boundKeys = useShortcutKeys();
  const [updatesOpen, setUpdatesOpen] = useState(false);
  // Settings opened at a page or an editor, as a backup notification's click
  // (T-196) and the rail's project and machine entries (YN-8) do.
  const [settingsAt, setSettingsAt] = useState<SettingsOpenAt | null>(null);
  // Core said the daily backup's last run changed: read again for notifications.
  const [backupRevision, setBackupRevision] = useState(0);
  const [updatesNeedReload, setUpdatesNeedReload] = useState(false);
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const [settingsInspectorAgent, setSettingsInspectorAgent] = useState<string | null>(null);
  // The composer's `/model`: opens this Agent's settings, never a prompt.
  const [modelRequest, setModelRequest] = useState<{ model: string; nonce: number; kind?: "permissions"; agentId?: string; section?: "model" | "context" } | null>(null);
  // What /new and /resume open New agent with (T-29); null is its usual start.
  const [createInitial, setCreateInitial] = useState<CreateInitial | null>(null);
  // /status, /usage and /mcp: the context panel, at that part of it.
  const [inspectorFocus, setInspectorFocus] = useState<{ id: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!inspectorFocus) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(inspectorFocus.id);
      target?.scrollIntoView({ block: "nearest" });
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [inspectorFocus]);
  const [forkOpen, setForkOpen] = useState(false);
  // An Agent row this window just added (T-19 SH:R11): one it created, or
  // forked, or one Core says this import made; never one a read of the
  // Workspace brings, nor one an import found already there. Once the row is
  // shown, it is brought into view at once, comes in over small (opacity,
  // 4 px up) and settles once; under reduced motion it is there at once and
  // settles. It is this Workspace's, this choice's and this action's only:
  // - its group folded, opening because the new Agent is chosen: the row is
  //   kept hidden until the group has opened, then comes in, so it is seen
  //   coming in once (at most JOIN_WAIT frames; past that it shows still);
  // - listed already when the answer came (a read after Core said the
  //   Workspace changed got there first): it was shown then, so it does not
  //   come in again; it is brought into view and settles;
  // - not shown at all (a search it does not match, a phone's conversation
  //   in front of the list, the list hidden): nothing plays, now or later;
  // - another Agent chosen, or another Workspace, before it shows: dropped.
  const [joined, setJoined] = useState<{ workspace: string; id: string; n: number; enter: boolean } | null>(null);
  const joinedRow = useRef<HTMLElement | null>(null);
  const [entered, setEntered] = useState(0);
  useLayoutEffect(() => {
    if (!joined) return;
    let frame = 0;
    let waited = 0;
    let row: HTMLElement | undefined;
    let settled: (() => void) | null = null;
    const hide = (hidden: boolean) => row?.toggleAttribute("data-joining", hidden);
    const land = (later: boolean) => {
      row = [...document.querySelectorAll<HTMLElement>(".agent-list .agent-row")].find((shown) => shown.dataset.agentId === joined.id);
      const still = joined.workspace === currentWorkspace.current && currentSelected.current === joined.id;
      if (!still || !row || !row.getClientRects().length) return hide(false);
      const body = row.closest<HTMLElement>(".project-group-body");
      const opening = !!row.closest(".project-group.is-folded") ||
        (!!body && (Number(getComputedStyle(body).opacity) < 1 || body.getAnimations().some((a) => a.playState === "running")));
      if (opening) {
        if (++waited > JOIN_WAIT) return hide(false);
        hide(joined.enter);
        frame = requestAnimationFrame(() => land(true));
        return;
      }
      row.scrollIntoView?.({ block: "nearest", behavior: "instant" });
      joinedRow.current = row;
      // Its entrance starts before this frame is painted, so the row is
      // never seen between hidden and coming in.
      if (joined.enter) {
        if (later) flushSync(() => setEntered((n) => n + 1));
        else setEntered((n) => n + 1);
      }
      hide(false);
      settled = settleWhenLanded(row, "data-settle", false, "animation");
    };
    land(false);
    return () => {
      cancelAnimationFrame(frame);
      hide(false);
      settled?.();
    };
  }, [joined]);
  useSurfaceIn(joinedRow, entered, "small", entered > 0, "translateY(4px)");
  /** `id` is the Agent this window's create, fork or import has just made. */
  const markJoined = (id: string) => {
    const workspace = currentWorkspace.current;
    const enter = !workspaceRef.current?.agents.some((listed) => listed.id === id);
    setJoined((last) => ({ workspace, id, n: (last?.n ?? 0) + 1, enter }));
  };
  // The Agent whose Turns missing from the native history are being ended (T-198).
  const [endMissingFor, setEndMissingFor] = useState<string | null>(null);
  const [disconnectFor, setDisconnectFor] = useState<string | null>(null);
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
  // On a phone the work and turn docks open one at a time over the
  // conversation (PhoneDocks.tsx); closed, they take no width.
  const [phoneDock, setPhoneDock] = useState<PhoneDock>(null);
  const dockMotion = usePhoneDockMotion(phoneDock, setPhoneDock);
  const [inspector, setInspector] = useState(true);
  // A wide window's choice; on a phone the list is a screen of its own.
  const [railOpen, setRailOpen] = useState(true);
  // The rail shows where the reader is instead of the Agents, until they go
  // back. One place for it, rather than a drawer of its own beside the one a
  // phone already has (T-15).
  const [railIndex, setRailIndex] = useState(false);
  // The same left column, showing this Agent's work instead (T-15, V9).
  const [railWork, setRailWork] = useState(false);
  // Phones (T-170): one screen at a time, the Agent list or what is open.
  // The list covers the open view instead of replacing it, so its drafts,
  // reading place and any annotation stay as they were.
  const phone = usePhone();
  // Both head entries open a view *in the rail*, so opening one has to bring
  // the rail back: collapsed from the toolbar the rail is `display: none`
  // (styles.css `.rail-hidden .rail`), and a press that only swapped which
  // view it renders changed nothing a reader could see — while the index
  // beside it still reported itself open. On a touched screen that is the
  // whole way in to the work list and the Turn index, since the docks there
  // take no presses, so it was a dead path (#459 R1, P2).
  //
  // Each press answers what is *on screen*, not what was last asked for.
  // Reading the view's own state instead left a second dead press: with the
  // work view open and the rail then collapsed from the toolbar, the state
  // still said open, so a press turned it off behind a hidden rail and a
  // second press was needed to see anything (#459 R2, P3-1). Closing a view
  // that is on screen leaves the rail as it is: the reader asked for the
  // view to go, not for the column to.
  //
  // On a phone each opens its drawer the way the drawer's own buttons do,
  // through the dock's motion: setting it directly skipped T-19's way in and
  // out (#459 R8, P3).
  const chooseDock = dockMotion.choose;
  const openWorkView = useCallback(() => {
    if (phone) return chooseDock(phoneDock === "work" ? null : "work");
    if (railWork && railOpen) return setRailWork(false);
    setRailIndex(false);
    setRailWork(true);
    setRailOpen(true);
  }, [phone, phoneDock, chooseDock, railWork, railOpen]);
  const openIndexView = useCallback(() => {
    if (phone) return chooseDock(phoneDock === "turns" ? null : "turns");
    if (railIndex && railOpen) return setRailIndex(false);
    setRailWork(false);
    setRailIndex(true);
    setRailOpen(true);
  }, [phone, phoneDock, chooseDock, railIndex, railOpen]);
  // Touch rows wherever a finger is the pointer, not only where the phone
  // layout applies: a folding phone opened is wide and still all touch (T-15).
  const touchInput = useTouchInput();
  // The shell fits what the on-screen keyboard leaves wherever a finger is
  // the pointer, not only where the phone layout applies (T-15). A tablet, or
  // a folding phone opened, is wide enough to keep the side-by-side layout
  // and still has the same keyboard over the bottom of it: with this gated on
  // the phone layout, the input area on those screens was left under the
  // keyboard, which is the very thing T-170 fixed for phones.
  useEffect(() => (phone || touchInput ? followVisualViewport() : undefined), [phone, touchInput]);
  const [phoneList, setPhoneList] = useState(true);
  const [phoneInspector, setPhoneInspector] = useState(false);
  const phoneBack = useRef<HTMLButtonElement>(null);
  const listShown = phone && phoneList;
  // Without a system frame (Windows desktop), the toolbar is the title bar.
  const frame = useCustomFrame();
  const [homeOpen, setHomeOpen] = useState(false);
  // A conversation fades in as it opens from Home or another Agent's takes its
  // place (T-19 M6: SH:M11, C01). A phone's list and conversation are push and
  // pop (M8), not this.
  const conversationBody = useRef<HTMLDivElement>(null);
  useSurfaceIn(conversationBody, homeOpen ? null : selected, "small", !phone);
  // On a phone (T-19 M8), what the list opens is pushed in from the right and
  // Back brings the list in from the left, over medium; the toolbar's brand
  // and Back swap with a fade over micro. Only a move between the list and
  // what is open plays them, never a window turning into a phone's, and
  // never the first screen: nothing has moved before the first one.
  const phoneMove = useRef({ list: phoneList, n: 0 });
  if (phoneMove.current.list !== phoneList) phoneMove.current = { list: phoneList, n: phoneMove.current.n + 1 };
  const moved = phoneMove.current.n > 0;
  const railBox = useRef<HTMLElement>(null);
  const mainBox = useRef<HTMLElement>(null);
  const brandBox = useRef<HTMLDivElement>(null);
  useSurfaceIn(mainBox, phoneMove.current.n, "medium", phone && moved && !phoneList, "translateX(8px)");
  useSurfaceIn(railBox, phoneMove.current.n, "medium", phone && moved && phoneList, "translateX(-8px)");
  useSurfaceIn(brandBox, phoneMove.current.n, "micro", phone && moved);
  /** The reply from Home a conversation's "Open on Home" opened Home for (T-9),
   * and the message to go back to; another opening is another `n`. */
  const [homeArrival, setHomeArrival] = useState<{ origin: HomeReplyOrigin; back: MessageLink; n: number } | null>(null);
  /** A report link opened from outside Home (T-18), the message it was
   * clicked in, for Back, and whether it came from the address; another
   * opening is another `n`. */
  const [homeReport, setHomeReport] = useState<{ link: ReportLink; back: MessageLink | null; fromAddress: boolean; n: number } | null>(null);
  /** Each explicit way to Home (T-18 R3): Home closes a report open over it. */
  const [homeVisit, setHomeVisit] = useState(0);
  /** Each report opening, numbered once and only upward: Home, mounted all
   * along, tells a new opening from one it has handled by this number, even
   * after a way to Home has dropped the last report (T-18 R3). */
  const reportOpenings = useRef(0);
  /** Home, by the user's own way there: the toolbar, a notification, a Home
   * link, a reply's Open on Home, the way back from a jump. A report open over
   * Home closes, and none opened before comes back. */
  function goHome() {
    setHomeReport(null);
    setHomeVisit((n) => n + 1);
    setHomeOpen(true);
    setPhoneList(false);
  }
  const [collaborationOpen, setCollaborationOpen] = useState(false);
  const [taskFocus, setTaskFocus] = useState<{ taskId: string; reviewId?: string; section?: "workspaces"; at: number } | null>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactPreview | null>(null);
  // An image being marked for Point & Fix (T-167).
  const [pointFix, setPointFix] = useState<PointFixSource | null>(null);
  const { draft, getDraft, setDraft, clearIfUnchanged, preserveDrafts, removeDraft, copyDraft, discardSavedDraft, draftError, draftBlocked } = useComposerDraft(workspaceId, selected);
  const [interrupting, setInterrupting] = useState(false);
  const [actionError, setActionError] = useState("");
  // Set again with the same text, a notice shows again for its full time (T-19).
  const [notice, setNoticeShown] = useState<ToastText>({ text: "", serial: 0 });
  const setNotice = useCallback((text: string) => setNoticeShown((was) => ({ text, serial: was.serial + 1 })), []);
  const [readActionsOpen, setReadActionsOpen] = useState(false);
  const [agentScope, setAgentScope] = useState<"active" | "closed">("active");
  const [storedScope, setStoredScope] = useState<ProjectScope>(ALL_PROJECTS);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [requestReopen, setRequestReopen] = useState<{
    agentId: string;
    sequence: number;
  } | null>(null);
  // An Agent action menu's "Manage…" and "Agent settings…" (T-184), held
  // until that Agent's conversation is shown: its settings dialog takes only
  // a request made after it appeared.
  const [requestActions, setRequestActions] = useState<{
    agentId: string;
    sequence: number;
  } | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  // A menu action that failed for an Agent other than the one shown.
  const [menuError, setMenuErrorShown] = useState<ToastText>({ text: "", serial: 0 });
  const setMenuError = useCallback((text: string) => setMenuErrorShown((was) => ({ text, serial: was.serial + 1 })), []);
  const [historyReading, setHistoryReading] = useState(false);
  // Where a source was opened from: Home leads back to Home.
  const [sourceOrigin, setSourceOrigin] = useState<"home" | "rail">(
    "home",
  );
  const [atBottom, setAtBottomState] = useState(true);
  // Whether Back to latest shows (T-19 SH:C19, CV:CW-05). Set with `atBottom`
  // wherever the app decides, but a scroll shows it only 96 px or more from
  // the end and hides it only under 48 px, so it does not flicker while a
  // stream grows the page. `atBottom` (follow, reading) keeps its 72 px.
  const [latestAway, setLatestAway] = useState(false);
  const setAtBottom = useCallback((at: boolean) => {
    setAtBottomState(at);
    setLatestAway(!at);
  }, []);
  // A window older than the newest one is never the latest, wherever in it
  // the reader is, its end included (YN-19): the newest end is not in view.
  const olderWindow = !!detail && detail.agent.id === selected && !!detail.conversation?.hasAfter;
  const latestShown = latestAway || historyReading || olderWindow;
  // Back to latest leaves through a copy (T-19): aria-hidden, inert and not
  // hit by the pointer, it fades out where the button was, while the button
  // itself is gone at once. Only within one conversation: another one shown
  // takes it away at once, and what showed for the one before is not a
  // baseline it can leave from (some ways of opening an Agent reset `atBottom`
  // only after it is shown). None under reduced motion or without Web
  // Animations; reduced motion turned on, or the copy's fade cancelled, takes
  // it away.
  const [latestLeaving, setLatestLeaving] = useState(0);
  const latestWas = useRef({ shown: latestShown, scope: "" });
  useLayoutEffect(() => {
    const scope = `${workspaceId}\n${selected}`;
    const was = latestWas.current;
    const sameScope = was.scope === scope;
    latestWas.current = { shown: latestShown && sameScope, scope };
    if (latestShown || !sameScope) {
      setLatestLeaving(0);
      return;
    }
    if (!was.shown || !animates()) return;
    setLatestLeaving((n) => n + 1);
    const gone = setTimeout(() => setLatestLeaving(0), 400);
    return () => clearTimeout(gone);
  }, [latestShown, workspaceId, selected]);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query?.addEventListener) return;
    const change = () => {
      if (query.matches) setLatestLeaving(0);
    };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const latestLeavingCopy = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const cancelled = () => setLatestLeaving(0);
    el.addEventListener("animationcancel", cancelled);
    return () => el.removeEventListener("animationcancel", cancelled);
  }, []);
  // Each time it shows, it comes in, rising 4 px as it fades in over small.
  const latestButton = useRef<HTMLButtonElement>(null);
  const latestShows = useRef({ shown: false, n: 0 });
  if (latestShows.current.shown !== latestShown)
    latestShows.current = { shown: latestShown, n: latestShows.current.n + (latestShown ? 1 : 0) };
  useSurfaceIn(latestButton, latestShows.current.n, "small", true, "translateY(4px)");
  const [jumpToTurn, setJumpTarget] = useState<string | null>(null);
  // The input a jump to `jumpToTurn` reads from, when it is one (T-6).
  const jumpItem = useRef<string | null>(null);
  // The Turn a jump last landed on, tinted once (T-19).
  const turnSettled = useRef<(() => void) | null>(null);
  // Whose conversation a jump from its dock was asked in (T-6): one still on
  // its way when the Workspace or the Agent changes is dropped, not taken into
  // the other conversation, where the same Turn id names nothing of its.
  const jumpScope = useRef<{ turnId: string; scope: string } | null>(null);
  // Any jump has no scope but one from the dock, whose scope ends with it,
  // done or dropped: left behind, it would drop a later jump to the same
  // Turn id from anywhere else.
  const setJumpToTurn = (turnId: string | null) => {
    jumpScope.current = null;
    setJumpTarget(turnId);
  };
  // The turn dock reads by the person's inputs unless switched to Turns.
  const [readBy, setReadBy] = useState<ReadBy>("inputs");
  const [readingTurn, setReadingTurn] = useState<string>();
  // A message link (T-166) or a saved reading position opens like a source.
  // `progress`: a place shared from another browser (T-170), restored by how
  // far into the message it was; `thread`: the native session it was read in.
  const [catchupSource, setCatchupSource] = useState<(CatchupItem & { openDetails?: boolean; link?: MessageLink; restore?: number; progress?: number; thread?: string; where?: "desktop" | "browser" }) | null>(null);
  const [sourceJump, setSourceJump] = useState(false);
  // An executor's session has two tabs (T-43 S3): its Overview, the one it
  // opens on, and its Conversation. Each executor keeps the one last chosen.
  const [executorTabs, setExecutorTabs] = useState<Record<string, ExecutorPaneTab>>({});
  const overviewFirst = (id: string) =>
    workspace?.agents.find((a) => a.id === id)?.kind === "executor" && (executorTabs[id] ?? "overview") === "overview";
  // Where its conversation was read when its Overview was chosen, put back
  // when the Conversation is chosen again.
  const conversationTop = useRef<{ agentId: string; top: number } | null>(null);
  // A reading position left in an executor's conversation waits until its
  // Conversation shows (T-166 returns there): its Overview shows first.
  const readingDeferred = useRef<string | null>(null);
  // A jump into a conversation (a source, a link, a Turn) shows it.
  const showConversation = (id: string) => {
    conversationTop.current = null;
    if (readingDeferred.current === id) readingDeferred.current = null;
    setExecutorTabs((tabs) => (tabs[id] === "conversation" ? tabs : { ...tabs, [id]: "conversation" }));
  };
  // What the source strip says about a place that is gone, worded on show (T-189).
  const [sourceNotice, setSourceNotice] = useState<((t: ShellWords) => string) | null>(null);
  // A message link waiting for the Workspace to load.
  // `fromAddress`: a report link read from the address (T-18), whose page
  // takes that history entry rather than adding one.
  const [incomingLink, setIncomingLink] = useState<(AppLink & { fromAddress?: boolean }) | null>(null);
  // Where the shown conversation was last being read, kept when it is left.
  const reading = useRef<{ agentId: string; position: ReadingPosition } | null>(null);
  const readingFrame = useRef(0);
  const initialReading = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  // The last thing focused inside the composer, and nothing else: a layout
  // change may drop the focus, and only a composer's is given back (T-15).
  const composerFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const note = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      composerFocus.current = target?.closest?.(".composer") ? target : null;
    };
    document.addEventListener("focusin", note);
    return () => document.removeEventListener("focusin", note);
  }, []);
  /**
   * Folding a phone open or shut crosses the phone layout under the app, with
   * no reload: the conversation reflows at a new width and the composer may be
   * drawn again. What the reader was at is held by the anchor the conversation
   * already keeps -- its Turn and message, not a scroll ratio, which a reflow
   * does not preserve -- and the focus is given back to the composer it was in.
   *
   * The conversation's own ReadingAnchor (ConversationWindow) does not reach
   * this: it holds a reflow it is part of, by looking at the old DOM before
   * its own commit, and folding changes the layout in CSS without an update to
   * that subtree for it to look before. Extending it to settle width changes
   * was tried and left the message 300px from where it had been, so the hold
   * is driven from here instead, off the anchor the conversation already keeps.
   *
   * Neither is forced: with no anchor, or none of it still drawn, the
   * conversation is left where it is rather than sent to the end, and the
   * focus is only restored when the change dropped it, never taken from
   * whatever the reader moved to themselves (T-15).
   */
  useLayoutEffect(() => {
    const pane = scroll.current;
    const saved = reading.current?.position;
    const hold = () => {
      if (!pane?.isConnected || saved?.mode !== "anchor") return;
      const of = (id: string) => `[data-turn-id="${CSS.escape(id)}"]`;
      const read = saved.itemId
        ? pane.querySelector<HTMLElement>(`${of(saved.turnId)} [data-item-id="${CSS.escape(saved.itemId)}"]`)
        : pane.querySelector<HTMLElement>(of(saved.turnId));
      if (!read) return;
      const drift = read.getBoundingClientRect().top - pane.getBoundingClientRect().top - saved.offset;
      if (Math.abs(drift) > 1) pane.scrollTop += drift;
    };
    // Rows measured after the width change move it again, as the Portal's own
    // resize finds (portal/Portal.tsx); a few frames of correction settle it.
    hold();
    let frames = 0;
    let request = requestAnimationFrame(function again() {
      hold();
      if (++frames < 6) request = requestAnimationFrame(again);
    });
    const was = composerFocus.current;
    const active = document.activeElement;
    if (was?.isConnected && (!active || active === document.body) && was.closest(".composer"))
      was.focus({ preventScroll: true });
    return () => cancelAnimationFrame(request);
  }, [phone]);
  // The conversation's scroller, as state too: its end is put in view when
  // the scroller is first drawn, not only when the detail arrives. The detail
  // can come before the Workspace that draws it (T-170): the conversation
  // then opened at the top of its window, with no Back to latest.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const attachScroll = useCallback((element: HTMLDivElement | null) => {
    scroll.current = element;
    setScroller(element);
  }, []);
  const readEnd = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const stickToBottom = useRef(true);
  // Back to latest shows when the conversation's end is out of view, as
  // measured, never only because it was assumed to open there. It says only
  // that (a scroll says the rest) and moves nothing.
  const measureLatest = useCallback(() => {
    const el = scroll.current;
    if (!el || el.clientHeight <= 0) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap >= 72) setAtBottomState(false);
    if (gap >= 96) setLatestAway(true);
  }, []);
  const searchReading = useRef(false);
  const draggingScrollbar = useRef(false);
  // A touch on the pane: where the pane was when it began, and whether the
  // browser took it as a pan (pointercancel, which it sends when a finger
  // moves the page rather than taps, and after which no click comes). Either
  // that or the pane having moved makes it the reader scrolling, even when
  // the pan moved nothing (already at the end) or came back where it began.
  const touch = useRef<{ from: number; panned: boolean; y?: number } | null>(null);
  // What grows after it is drawn (a tool row unfolding, a chart laying out),
  // or a pane that shrinks under a growing composer, keeps the end in view
  // while the conversation follows it, as an update does. A row the reader
  // opens or closes stops the following (onClickCapture), so it stays where
  // they clicked it, and what it opens below is theirs to scroll to (T-19).
  const followHeld = useRef(false);
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
        !followHeld.current
      )
        el.scrollTop = el.scrollHeight;
      // Not moved to the end: said once the frame is done (by then a
      // conversation that has just opened has been put there), so Back to
      // latest shows once the end is out of view, as after a row the reader
      // opened there.
      else requestAnimationFrame(measureLatest);
    });
    observer.observe(inner);
    if (inner.parentElement) observer.observe(inner.parentElement);
    return () => observer.disconnect();
  }, [measureLatest]);
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
  // The Workspace this window is in now, for work that finishes later. An
  // Agent id can name a different Agent in another Workspace at this
  // address, so "the same Agent is still open" is only true within the
  // Workspace the work started in (T-195).
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  // The Agent whose conversation is on screen now, for a reply that comes later.
  const shownConversation = useRef<string | null>(null);
  shownConversation.current = homeOpen || listShown ? null : selected;
  // Core announced a change to the open Agent (`agent.changed`, which is how a
  // new request is announced) since the stream last reset: the next request
  // its detail lists arrived live and may fade in (T-19 CV:Q-01).
  const liveChange = useRef<{ workspace: string; agent: string } | null>(null);
  // Since a reset, since the stream broke, or since the conversation was
  // left: until a detail from a read started after `after` (DetailSync.reads;
  // never while the stream is down) is shown, nothing arrives live. That
  // detail only becomes what was shown, so neither a read already on its way,
  // a copy kept from before, nor a change Core replays when the stream resumes
  // makes an old request play (Lead 3299, 3301). After Core resumed the stream
  // (`drain`), only the end of what it replays (`drained`) or a reset ends the
  // wait: no read starts for it, and no timer guesses it (Lead 3356).
  const arrivalsSettle = useRef<{ after: number; drain?: boolean; drained?: boolean } | null>(null);
  // Core streamed or announced a change to the open Agent since the stream
  // last reset: a Turn the next detail adds after the shown ones arrived live
  // (T-19 CV:T-01).
  const liveTurn = useRef<{ workspace: string; agent: string } | null>(null);
  // Renders the app when a resumed stream's replay ends, so the wait is looked at again.
  const [, setDrains] = useState(0);
  // Told in the stream's order, so a reset that follows always wins (R1 276d4a1d; Lead 3356).
  const onReplay = useCallback((state: "resumed" | "drained") => {
    if (state === "resumed") {
      liveChange.current = liveTurn.current = null;
      arrivalsSettle.current = { after: Infinity, drain: true };
      return;
    }
    const mark = arrivalsSettle.current;
    if (!mark?.drain) return;
    mark.drained = true;
    setDrains((n) => n + 1);
  }, []);
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
          if (event.agentId === currentSelected.current) {
            if (event.type !== "agent.context") liveTurn.current = { workspace: currentWorkspace.current, agent: event.agentId };
            live.sync.push(event);
          }
          return;
        case "agent.changed":
          workspaceRefresh.soon(250);
          homeRefresh.soon(1_000);
          if (event.agentId === currentSelected.current) {
            liveChange.current = liveTurn.current = { workspace: currentWorkspace.current, agent: event.agentId };
            live.sync.refetch();
          }
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
              agents[index] = { ...listed, projectId: old.projectId, kind: old.kind, executor: old.executor };
              return { ...w, agents };
            });
          }
          // Home's Agent counts can wait for progress lines.
          homeRefresh.atMostEvery(15_000);
          return;
        }
        case "workspace.changed":
          if (event.mergeQueue) mergeQueueRefresh.atMostEvery(1_000);
          // A conversation that shows mail delivery gets its own notice.
          if (event.scope === "collaboration") {
            boardRefresh.now();
            // A task's row changed: Home's live task references read it
            // again, one read for a burst of changes (T-9).
            if (event.tasks) homeRefresh.atMostEvery(2_000);
          }
          else if (event.scope === "jobs") jobsRefresh.now();
          else if (event.scope === "machines") machinesRefresh.now();
          else if (event.scope === "brief" || event.scope === "home") {
            homeRefresh.soon(250);
            asksRefresh.soon(250);
          }
          else if (event.scope === "projects" || event.scope === "runtime")
            workspaceRefresh.soon(250);
          // An executor's lifecycle (T-36 S3): its row, Home, its task's card.
          else if (event.scope === "executors") {
            workspaceRefresh.soon(250);
            homeRefresh.soon(500);
            boardRefresh.now();
          }
          else if (event.scope === "backup") setBackupRevision((n) => n + 1);
          else if (event.scope === "appearance-preset") presetRefresh.now();
          else refresh();
          return;
        case "reset":
          // What a reconnect, poll or Core's reset brings only shows (T-19 CV:Q-01, CV:T-01).
          liveChange.current = liveTurn.current = null;
          arrivalsSettle.current = { after: live.sync.reads };
          jobsRefresh.now();
          // The merge queue: at once on a reconnect; while the stream is down,
          // at most once a minute (T-65 R1).
          if (event.reason === "poll") mergeQueueRefresh.atMostEvery(60_000);
          else mergeQueueRefresh.now();
          presetRefresh.now();
          refresh();
          // Not each poll while the stream is down: a reconnect resets anew.
          if (event.reason !== "poll") setBackupRevision((n) => n + 1);
          return;
      }
    },
    [workspaceRefresh, homeRefresh, asksRefresh, boardRefresh, machinesRefresh, jobsRefresh, mergeQueueRefresh, presetRefresh, live.sync, refresh],
  );
  const eventConnection = useWorkspaceEvents(!previewMode, onWorkspaceEvent, onReplay);
  // The stream broke (T-19 CV:Q-01, Lead 3299): nothing arrives live until it is open again and
  // Core has resumed it (`onReplay`, then the end of its replay) or reset it (a read after that).
  // Those two are told in the stream's order; this render only marks the break.
  const lastConnection = useRef(eventConnection);
  if (lastConnection.current !== eventConnection) {
    lastConnection.current = eventConnection;
    if (eventConnection !== "open") {
      liveChange.current = liveTurn.current = null;
      arrivalsSettle.current = { after: Infinity };
    }
  }
  useEffect(() => {
    if (eventConnection === "open" && !previewMode) jobsRefresh.now();
  }, [eventConnection, previewMode, jobsRefresh]);
  useEffect(() => {
    const refreshJobs = () => jobsRefresh.now();
    // Jobs open as a dialog above Home (whose own Jobs widget sends this),
    // so Home stays: closing it would put a conversation on screen behind
    // the dialog and start its read dwell. On a phone the work panel a job
    // was opened from closes, so the conversation is whole on return.
    const openJobs = () => {
      setCollaborationOpen(false);
      setPhoneDock(null);
    };
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
  const language = useLanguage();
  const shell = shellText(language);
  // For the callbacks kept across renders: the words of the language shown now.
  const shellNow = useRef(shell);
  shellNow.current = shell;
  const core = coreConnection(!!workspace, workspaceFailure, eventConnection, previewMode, browserOffline, language);
  // The connection banners show once their cause has held 600 ms, so a flap
  // never flashes one; they reveal over small, leave over exit-small and keep
  // what they said while they leave (T-19 SH:M04, SH:M06).
  const coreWanted = !!(workspaceError || core.browser);
  const coreBanner = useDelayedPresence(coreWanted, 600);
  const coreSaid = useRef({ error: workspaceError, label: core.label, detail: core.detail, browser: core.browser, stream: core.stream, loaded: !!workspace });
  if (coreWanted) coreSaid.current = { error: workspaceError, label: core.label, detail: core.detail, browser: core.browser, stream: core.stream, loaded: !!workspace };
  const liveBanner = useDelayedPresence(!previewMode && !workspaceError && !core.browser && eventConnection === "reconnecting", 600);
  // A newer revision of the shared Appearance preset applied here in the
  // background says so, as the look changed with no action here (T-19 ST:SA7).
  useEffect(() => {
    if (previewMode || !workspaceId) return;
    return onFollowApplied((id) => {
      if (id === workspaceId) setNotice(shellNow.current.appearanceFollowed);
    });
  }, [workspaceId, setNotice]);
  const agent = workspace?.agents.find((a) => a.id === selected);
  const inspectorShown = (phone ? phoneInspector : inspector) && !!agent && !homeOpen;
  // A side panel shown again comes in from its side over medium (T-19 M7): the Agent list from
  // the left on a desktop window, the context panel from the right. Its column changes at once,
  // as before, and hiding stays instant. Counted where the setting turns on, not where a panel
  // mounts: arriving at a conversation, or a window turning into a phone's, plays none.
  const panelOpens = useRef({ rail: railOpen, inspector, phoneInspector, rails: 0, inspectors: 0 });
  if (panelOpens.current.rail !== railOpen || panelOpens.current.inspector !== inspector || panelOpens.current.phoneInspector !== phoneInspector) {
    const was = panelOpens.current;
    panelOpens.current = {
      rail: railOpen,
      inspector,
      phoneInspector,
      rails: was.rails + (railOpen && !was.rail ? 1 : 0),
      inspectors: was.inspectors + ((inspector && !was.inspector) || (phoneInspector && !was.phoneInspector) ? 1 : 0),
    };
  }
  const inspectorBox = useRef<HTMLElement>(null);
  const inspectorTitle = useRef<HTMLSpanElement>(null);
  // Shown, not just counted: hiding the list while it comes in stops its move (Lead 3219).
  useSurfaceIn(railBox, panelOpens.current.rails, "medium", !phone && railOpen && panelOpens.current.rails > 0, "translateX(-8px)");
  useSurfaceIn(inspectorBox, panelOpens.current.inspectors, "medium", inspectorShown && panelOpens.current.inspectors > 0, "translateX(8px)");
  // An action's error above the composer fades in as it appears (T-19 SH:X05); the room it takes is
  // made at once. Another error replacing it while it shows plays nothing; dismissing it stops it.
  const actionErrorBox = useRef<HTMLDivElement>(null);
  const actionErrors = useRef({ shown: false, n: 0 });
  if (actionErrors.current.shown !== !!actionError)
    actionErrors.current = { shown: !!actionError, n: actionErrors.current.n + (actionError ? 1 : 0) };
  useSurfaceIn(actionErrorBox, actionErrors.current.n, "small", !!actionError && actionErrors.current.n > 0);
  // On a phone the context panel is a screen of its own: opening it takes focus to its heading
  // (T-19 SH:P03), unless something in it already has focus (a settings destination's control).
  useEffect(() => {
    if (phone && phoneInspector && inspectorShown && !inspectorBox.current?.contains(document.activeElement))
      inspectorTitle.current?.focus({ preventScroll: true });
    // Only an opening moves focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpens.current.inspectors]);
  // An open dock panel closes when something covers the conversation (the
  // Agent list, or the context panel a job opens) or the window widens.
  useEffect(() => {
    if (!phone || listShown || inspectorShown) setPhoneDock(null);
  }, [phone, listShown, inspectorShown]);
  const projects = workspace?.projects || [];
  // Read when Core announces a save, the events reset or reconnect; never polled.
  useAppearanceFollow(previewMode ? "" : workspaceId, eventConnection, presetRevision);
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
  // Each open executor's PR for its row (T-43 S2): read again on every
  // collaboration change (a link, a GitHub refresh, a review's end) and
  // when the open executors change; one local read, never GitHub.
  const openExecutors = workspace?.agents.filter((a) => a.kind === "executor" && !a.closedAt).map((a) => a.id).join(",") ?? "";
  useEffect(() => {
    if (previewMode || !workspaceId || !openExecutors) { clearLiveExecutors(); return; }
    refreshLiveExecutors(workspaceId);
  }, [boardRevision, openExecutors, workspaceId, previewMode]);
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
  useEffect(() => {
    if (settingsInspectorAgent && inspectorShown && currentDetail?.agent.id === settingsInspectorAgent) {
      setInspectorFocus({ id: "agent-auto-continue", nonce: Date.now() });
      setSettingsInspectorAgent(null);
    }
  }, [settingsInspectorAgent, inspectorShown, currentDetail?.agent.id]);
  // Earlier native Turns come before the oldest saved one, so they are
  // offered only where the saved conversation starts (T-161).
  const nativeHistoryHere = !currentDetail?.conversation?.hasBefore;
  const [pageTarget, setPageTarget] = useState<{agentId:string; turnId:string; itemId?:string; top:number; start:string|null; end:string|null; hold:true} | null>(null);
  // Room kept on a side of the window while a page replaces it, so the
  // scroll is not clamped before the place being read is put back. A side
  // stays until the place holds; one page's room is never taken away by the
  // next page's read (YN-19: pages now follow each other as the reader
  // scrolls, so a read can start while the last one's room is still there).
  const [pageSpace, setPageSpace] = useState<{ before?: true; after?: true } | null>(null);
  const beforeSpace = useRef<HTMLDivElement>(null);
  const afterSpace = useRef<HTMLDivElement>(null);
  // The saved window being read in place of the shown one, and which way:
  // its loading line, or why it could not be read, shows on that side.
  const [windowPage, setWindowPage] = useState<{ direction: "before" | "after"; failed?: true } | null>(null);
  const windowRead = useRef<{ direction: "before" | "after" } | null>(null);
  // Which way the reader last scrolled, by their own wheel, keys, finger or
  // scrollbar, never by the app's own scrolling: pages load only that way.
  const readerWay = useRef<"up" | "down" | null>(null);
  const lastTop = useRef(0);
  // Puts the page target's place back, while it holds (ConversationRows calls it).
  const heldPlace = useRef<(() => void) | null>(null);
  // Where the reader is while the page target's window is still on its way:
  // pages now load as the reader scrolls (YN-19), and the reader keeps
  // scrolling while one loads, so the place held is the one they are at
  // when it arrives, not the one where the read began.
  const pageHold = useRef<{ turnId: string; itemId?: string; top: number } | null>(null);
  // Back to latest from a window that is not the newest waits for it (T-6).
  const toLatest = useRef(false);
  // Back to latest keeps the end in view until the newest window is in and
  // its rows have measured (YN-19); the reader's own scroll ends it.
  const latestPin = useRef<{ frame: number } | null>(null);
  const stopLatestPin = useCallback(() => {
    if (latestPin.current) cancelAnimationFrame(latestPin.current.frame);
    latestPin.current = null;
  }, []);
  useEffect(() => {
    setPageTarget(null); setPageSpace(null); setWindowPage(null); toLatest.current = false; stopLatestPin();
    windowRead.current = null; readerWay.current = null;
  }, [selected, stopLatestPin]);
  useEffect(() => stopLatestPin, [stopLatestPin]);
  // A Turn's landing is the conversation's it was in: another Agent's, or none, ends it (T-19).
  useEffect(() => () => turnSettled.current?.(), [selected]);
  useEffect(() => {
    if (!sourceJump && !jumpToTurn) return;
    setPageSpace(null); setWindowPage(null); windowRead.current = null; readerWay.current = null;
  }, [sourceJump, jumpToTurn]);
  // An earlier window that could not be read moves nothing to hold in place.
  useEffect(() => { if (savedPages.error) setPageTarget(null); }, [savedPages.error]);
  /** What the reader sees at the top of the conversation: the first item
   * whose top is in view, as ReadingAnchor picks it. Earlier messages are put
   * in front of everything shown, so it stays mounted and can be held in
   * place; an item still hidden in a closed group never is (T-161). `last`:
   * the last item in view instead. */
  function readerAnchor(last = false) {
    const pane = scroll.current;
    if (!pane) return null;
    const box = pane.getBoundingClientRect();
    const visible = Array.from(pane.querySelectorAll<HTMLElement>("[data-item-id]"))
      .map(element => ({element, rect:element.getBoundingClientRect()}))
      .filter(({rect}) => rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom);
    const found = last ? visible.at(-1) : visible.find(({rect}) => rect.top >= box.top) || visible[0];
    const turnId = found?.element.closest<HTMLElement>("[id^='turn-']")?.id.slice("turn-".length);
    return found && turnId && found.element.dataset.itemId
      ? {turnId, itemId:found.element.dataset.itemId, top:readingTop(found.element)} : null;
  }
  /** Once a page's place holds, the room kept for it goes, in the same
   * commit as the hold ends: before the window, the reading anchor keeps
   * what is in view where it is as that room goes (ReadingAnchor). After
   * it, only when none of it is in view, or taking it away would bring the
   * end up under the reader. */
  function releaseSpace() {
    const pane = scroll.current;
    const after = afterSpace.current;
    const keepAfter = !!pane && !!after && after.getBoundingClientRect().top < pane.getBoundingClientRect().bottom;
    setPageSpace(space => (space?.after && keepAfter ? { after: true } : null));
  }
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
    const place = pageHold.current ?? pageTarget;
    const restore = () => {
      const item = pageAnchor(place.turnId, place.itemId);
      const moved = item && scroll.current ? readingTop(item) - place.top : 0;
      if (moved) scroll.current!.scrollTop += moved;
      return Math.abs(moved) >= 0.5;
    };
    // Rows in front are measured over the next frames, and once this holds
    // they leave the correcting to it (ConversationRows); both would count
    // the same change twice (T-161). They call it after each measure, so no
    // frame is drawn with the item moved. Hold until it has stayed put for
    // two frames, at most a second.
    let frame = 0, still = 0, frames = 0;
    const settle = () => {
      still = restore() ? 0 : still + 1;
      if (still >= 2 || ++frames >= 60) {
        setPageTarget(null);
        releaseSpace();
      } else frame = requestAnimationFrame(settle);
    };
    restore();
    frame = requestAnimationFrame(settle);
    heldPlace.current = () => { if (restore()) still = 0; };
    return () => { cancelAnimationFrame(frame); heldPlace.current = null; };
  }, [currentDetail, live.windowLoading, pageTarget, selected]);
  // The newest window is the one shown, with no read of another on its way
  // (Back to latest's pin waits for it, YN-19).
  const newestShown = useRef(false);
  newestShown.current = !!currentDetail && currentDetail.agent.id === selected && !currentDetail.conversation?.hasAfter && !live.windowLoading;
  // Back to latest from a window that is not the newest (the windows were
  // replaced, or a jump into history) shows the newest window's end once it
  // is in (T-6). Scrolled before, the end was the old window's, which has
  // newer messages after it: no latest place, so following stopped there.
  useLayoutEffect(() => {
    const el = scroll.current;
    const window = currentDetail?.conversation;
    if (!toLatest.current || !el || live.windowLoading || !window || window.hasAfter) return;
    toLatest.current = false;
    stickToBottom.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  }, [currentDetail, live.windowLoading]);
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
  // Times are written again, in every loaded Turn, when the clock format
  // or time zone changes (T-189).
  const time = useTimeDisplay();
  const timeMarks = conversationTimeMarks(currentDetail?.turns ?? [], time);
  const pending = currentDetail?.pending || [];
  // An executor's Overview, while it is the tab chosen (T-43 S3).
  const overviewShown = !!agent && !homeOpen && overviewFirst(agent.id);
  // Choosing its Conversation again puts it back where it was read: where it
  // was left before this tab, or a reading position kept from earlier.
  function chooseExecutorTab(tab: ExecutorPaneTab) {
    if (!agent) return;
    if (tab === "conversation" && readingDeferred.current === agent.id) {
      readingDeferred.current = null;
      const saved = readingPositions?.get(agent.id);
      if (saved?.mode === "anchor" && restoreReading(agent.id, saved)) return;
    }
    if (tab === "overview" && !overviewShown)
      conversationTop.current = scroll.current ? { agentId: agent.id, top: scroll.current.scrollTop } : null;
    setExecutorTabs((tabs) => (tabs[agent.id] === tab ? tabs : { ...tabs, [agent.id]: tab }));
  }
  // A hidden conversation has no scroll position of its own to keep: put
  // back the one it had, or its end while it follows the latest.
  useLayoutEffect(() => {
    if (overviewShown) return;
    const kept = conversationTop.current;
    conversationTop.current = null;
    const el = scroll.current;
    if (!el || !kept || kept.agentId !== selected) return;
    el.scrollTop = stickToBottom.current ? el.scrollHeight : kept.top;
  }, [overviewShown, selected]);
  // A request that arrives live while its conversation is open fades in, once (T-19 CV:Q-01): one
  // that a detail lists, new in this Workspace, Agent and native session, after Core announced a
  // change to the Agent. The first detail of that scope, and any new request a reconnect, poll or
  // reset brings, only become what was shown; so do a return to the Agent and another session.
  const pendingScope = currentDetail && currentDetail.agent.id === selected && !homeOpen && !listShown
    ? [workspaceId, selected, nativeSession(currentDetail.agent) ?? ""].join("\n") : null;
  const pendingSeen = useRef<{ scope: string; ids: Set<string>; arrived: string[] } | null>(null);
  // The conversation was left: another Agent or Workspace opened, or Home or
  // the phone's list over it. Nothing arrives live until a detail read after
  // this is shown, and that one is a new baseline (Lead 3301).
  if (!pendingScope && pendingSeen.current) {
    const was = arrivalsSettle.current;
    pendingSeen.current = null;
    liveChange.current = null;
    arrivalsSettle.current = { ...was, after: Math.max(was?.after ?? 0, live.sync.reads) };
  }
  // The detail shown came from this read; the first one started after a
  // reset or leaving settles it, and what it lists only becomes shown. It is
  // current when it is the newest read and the sync has nothing failed,
  // running, queued, due or waiting to be applied.
  const readNumber = (live.detail && live.sync.readOf.get(live.detail)) ?? 0;
  const sync = live.sync;
  const current = !!live.detail && readNumber === sync.currentRead && !sync.running && !sync.queued && !sync.failed
    && sync.refetchTimer === undefined && sync.retryTimer === undefined && sync.flushTimer === undefined && !sync.queue.length;
  // After a stream opened again, only once its replay is over: if a read was on its way then, when
  // it and any after it are done.
  const mark = arrivalsSettle.current;
  let settles = !!mark && (mark.drain ? !!mark.drained && current && !!pendingScope : readNumber > mark.after);
  // Nothing arrives live in this render, requests or Turns (T-19 CV:T-01 too).
  const arrivalsQuiet = !!mark;
  if (pendingScope) {
    const seen = pendingSeen.current;
    if (!seen || seen.scope !== pendingScope) {
      pendingSeen.current = { scope: pendingScope, ids: new Set(pending.map((request) => request.id)), arrived: [] };
      liveChange.current = null;
      // Back to a conversation whose detail is current (from Home, say): it is the new baseline
      // now, unless the stream is down or its replay not over (the case above).
      if (current && !mark?.drain && mark?.after !== Infinity) settles = true;
    } else {
      const fresh = pending.filter((request) => !seen.ids.has(request.id)).map((request) => request.id);
      if (fresh.length) {
        const announced = !arrivalsQuiet && liveChange.current?.workspace === workspaceId && liveChange.current.agent === selected;
        if (announced) liveChange.current = null;
        pendingSeen.current = { scope: pendingScope, ids: new Set([...seen.ids, ...fresh].slice(-200)),
          arrived: announced ? [...seen.arrived, ...fresh].slice(-20) : seen.arrived };
      }
    }
  }
  if (settles) arrivalsSettle.current = liveChange.current = liveTurn.current = null;
  useArrivalsIn(
    pendingSeen.current?.scope === pendingScope ? pendingSeen.current.arrived.map((id) => `${pendingScope}\n${id}`) : [],
    (key) => document.getElementById(`request-${key.slice(key.lastIndexOf("\n") + 1)}`),
    "small",
  );
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
  const imageSupported = (agent?.harness === "codex" || agent?.harness === "claude" || agent?.harness === "opencode");
  // What happens to an image on its way to this Agent, said beside the image button.
  const imageNote = agent?.harness === "claude" ? shell.claudeImages : agent?.harness === "opencode" ? shell.openCodeImages : null;
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
  // The Turn being read, counted from 1: the latest while none is.
  const readingIndex = readingTurn ? logicalTurns.findIndex((turn) => turn.id === readingTurn) : -1;
  const readingTurnNumber = readingIndex >= 0 ? readingIndex + 1 : logicalTurns.length;
  // Reading by your inputs (T-6): read once for each Agent opened, so the
  // switch shows in either mode, and while the dock shows them, the newest
  // page first, again when the newest Turn or its messages change.
  const lastTurn = logicalTurns.at(-1);
  const conversationInputs = useConversationInputs(workspaceId, selected, !!agent && !previewMode && logicalTurns.length > 0, readBy === "inputs",
    `${logicalTurns.length}:${lastTurn?.id}:${lastTurn?._yuzunoRequestCount ?? lastTurn?.items?.length}`);
  // With no inputs to read by (none recorded yet), the dock reads by Turn and
  // offers no switch.
  const readingBy: ReadBy = readBy === "inputs" && conversationInputs.total > 0 ? "inputs" : "turns";
  const canReadByInputs = conversationInputs.total > 0;
  const inputDockEntries = useMemo(() => inputEntries(conversationInputs.inputs, logicalTurns),
    [conversationInputs.inputs, logicalTurns]);
  // The input being read (T-6): as the Turn being read reports it from its
  // rows at the reading line, on every scroll (InputReading).
  const inputReading = useRef(new Map<string, string | null>());
  const [inputReadingChanged, setInputReadingChanged] = useState(0);
  const reportInput = useCallback((turnId: string, itemId: string | null) => {
    if (inputReading.current.get(turnId) === itemId) return;
    inputReading.current.set(turnId, itemId);
    setInputReadingChanged(n => n + 1);
  }, []);
  const readingInputId = useMemo(() => readingBy === "inputs"
    ? readingEntry(inputDockEntries, logicalTurns, readingTurn, readingTurn === undefined ? undefined : inputReading.current.get(readingTurn))
    : undefined, [readingBy, inputDockEntries, logicalTurns, readingTurn, inputReadingChanged]);
  // Each of the person's inputs read so far, by its number among all of
  // them: the Turns label the parts those inputs open.
  const inputNumbers = useMemo(() => new Map(conversationInputs.inputs.map((input, at) =>
    [`${input.turnId}\n${input.itemId}`, conversationInputs.total - conversationInputs.inputs.length + at + 1])),
  [conversationInputs.inputs, conversationInputs.total]);
  const readingInputNumber = conversationInputs.total - inputDockEntries.length
    + (readingInputId ? inputDockEntries.findIndex(entry => entry.id === readingInputId) + 1 : inputDockEntries.length);
  // Claude takes a follow-up to its newest running turn: yours, or one of its
  // own, such as a mailbox notice's or a reconnect's (T-45).
  const claudeFollowUpTurnId = isClaude && busy
    ? logicalTurns
        .slice()
        .reverse()
        .find((turn) => turn.status === "inProgress")?.id || null
    : null;
  // OpenCode takes a message into its running turn and answers it from its
  // next step (T-10), but not while it waits for your answer to a request.
  const openCodeTurnId = isOpenCode && agent?.status === "working"
    ? logicalTurns
        .slice()
        .reverse()
        .find((turn) => turn.status === "inProgress")?.id || null
    : null;
  const cannotSendWhileWorking = (isClaude && busy && !claudeFollowUpTurnId) || (isOpenCode && busy && !openCodeTurnId);
  // Codex would refuse to add to a Turn whose result is unconfirmed; the
  // draft waits until reconnecting has checked it. Claude resumes on send.
  const recovery =
    currentDetail && !previewMode ? recoveryReason(currentDetail) : null;
  // One the user disconnected is started only by their Reconnect (T-184).
  const holdForRecovery =
    (recovery === "running" && !isClaude) || recovery === "collaboration" || recovery === "missing" || recovery === "disconnected" || recovery === "archived";
  // The one line under the draft that asks something of you; otherwise the
  // line stays quiet and shows the keys only while you type.
  const composerNotice = busy
    ? pending.some((r) => r.params.isBlocking !== false && !r.stale)
      ? "Waiting for your response above"
      : null
    : holdForRecovery
      ? recovery === "collaboration"
        ? "Reconnect above to check the workspace connection; your draft is kept"
        : recovery === "missing"
          ? "End the unconfirmed turn above, or check again; your draft is kept"
          : recovery === "disconnected"
            ? "You disconnected this agent. Reconnect above to send; your draft is kept"
            : recovery === "archived"
              ? "This agent is kept to read; create a new OpenCode agent to go on"
              : "Reconnect above to check the last turn; your draft is kept"
      : agent?.status === "uncertain"
        ? "Send to check the previous result first"
        : agent?.status === "offline"
          ? recovery === "offline"
            ? "Reconnect above, or send a message to resume this session"
            : "Send a message to resume this session"
          : null;
  const [composerPlaceholder, shortPlaceholder] = previewMode
    ? [shell.preview, shell.preview]
    : cannotSendWhileWorking
      ? [shell.waitTurn, shell.waitTurnShort]
      : busy
        ? [shell.addThought, shell.addThoughtShort]
        : [shell.ask(agent?.name ?? ""), shell.askShort(agent?.name ?? "")];
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
  // The turn a message joins: Claude's follow-up, OpenCode's or Codex's
  // running turn.
  const sendTurnId = isClaude ? claudeFollowUpTurnId : isOpenCode ? openCodeTurnId : activeTurnId;
  const {
    submit: submitMessage,
    sending,
    outgoing,
    pendingInputs,
  } = useConversationSend(
    previewMode ? "" : workspaceId,
    selected,
    sendTurnId,
    refresh,
    agent?.harness,
    currentDetail,
  );
  // One line while the draft, or its placeholder, fits beside "+" and Send
  // with nothing under it; otherwise the text above the tools (T-44). The
  // controls' widths count, so what changes them is listed too. A placeholder
  // too long for the line shows its short form (Lead 2 4757).
  const [composerBox, setComposerBox] = useState<HTMLFormElement | null>(null);
  // Expanded for editing, as with the ChatGPT app's expand icon (T-44): a
  // block at a set height until the same button collapses it, the draft is
  // emptied (sent or cleared) or another Agent opens.
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const expanded = expandedFor === selected && draft.parts.some((p) => p.kind === "paste" || !!p.text);
  useLayoutEffect(() => {
    if (expandedFor !== null && !expanded) setExpandedFor(null);
  }, [expandedFor, expanded]);
  const { shape: composerShape, short: placeholderShort, tall: composerTall } = useComposerShape(
    composerBox,
    () => composer.current?.lineExtent() ?? null,
    expanded || !!draft.images?.length || !!draft.skills?.length || !!imageUploads.error || !!draftError || (draftBlocked && !previewMode) || !!composerNotice,
    [draft, selected, language, busy, interrupting, sending, currentDetail?.codexPlan, previewMode],
    composerPlaceholder,
    () => composer.current?.rows() ?? 0,
  );
  // Offered from a draft's third row, and while expanded, to collapse it.
  const offerExpand = composerShape === "block" && (composerTall || expanded);
  const [resultRequestFor, setResultRequestFor] = useState<string | null>(null);
  const resultRequestFrom = useRef<HTMLElement | null>(null);
  // New Claude messages still sending that their own Turn shows: once, there,
  // with the delivery note (T-120). The same set while its members stay the
  // same, so a streamed change does not draw every Turn again.
  const inTurnKey = [...sendingInTurn(currentDetail, selected, outgoing)].sort().join("\n");
  const inTurn = useMemo<ReadonlySet<string>>(() => new Set(inTurnKey ? inTurnKey.split("\n") : []), [inTurnKey]);
  // A Turn that arrives live while its conversation is open fades in, once (T-19 CV:T-01, Lead
  // 3250): one a detail adds after the Turns shown, both at the latest window, after Core streamed
  // or announced a change to the Agent. The first detail of a Workspace, Agent or native session,
  // a window being read, and what a reconnect, poll or reset brings only become what was shown; as
  // for requests, nothing arrives live until arrivals settle after a reconnect, reset or leaving
  // the conversation (Lead 3299, 3301). A Turn whose message this window showed as a preview, or
  // sending in its Turn, the frame before does not play: it is that message, confirmed. Matched by
  // its exact ID, never by its text.
  const turnScope = pendingScope;
  const turnsSeen = useRef<{ scope: string; latest: boolean; ids: Set<string>; arrived: string[] } | null>(null);
  // New Claude messages sending in their Turn, as of App's last commit (the layout effect below);
  // previews, as of their own last commit, for the conversation they were shown in.
  const shownMessages = useRef<ReadonlySet<string>>(new Set());
  const shownPreviews = useRef<{ scope: string; ids: ReadonlySet<string> }>({ scope: "", ids: new Set() });
  const previewsShown = useCallback((scope: string, ids: ReadonlySet<string>) => {
    shownPreviews.current = { scope, ids };
  }, []);
  // A shown Turn's own change, live (T-19 CV:T-04, CV:T-09; Lead 2 4591): its working indicator
  // comes in where the Turn itself does not (a Turn whose message was shown before, now confirmed;
  // a shown Turn running again), and a Turn Core records completed brings its reply actions and
  // files in. Once per change: each is named by how many times that Turn has made it in this
  // conversation, so a Turn that runs again, or completes again, cues again (R1 47f7c0f0). Told
  // apart as the arrivals above: in the latest window, after Core streamed or announced a change
  // to this Agent, never what a first read, a window, a reconnect, poll or reset brings.
  // Interrupted and failed Turns keep their own words with no cue, and the working indicator
  // always goes at once. Read before the arrivals below take the announcement.
  const turnAnnounced = !arrivalsQuiet && liveTurn.current?.workspace === workspaceId && liveTurn.current.agent === selected;
  // The question dock's arrivals too, once this conversation has shown a detail: the questions its
  // first one lists are what was there, even after an announcement while it loaded (#569 round
  // cfabe82d P3: opened from Home, with nothing else marking the wait).
  const dockLive = turnAnnounced && !!turnScope && turnsSeen.current?.scope === turnScope;
  const turnCues = useRef<{ scope: string; latest: boolean; status: Map<string, string>;
    started: string[]; completed: string[] } | null>(null);
  // How many times each Turn has started or completed live, per conversation, for as long as the
  // window is open: kept across leaving it and coming back, as the cues below keep every name they
  // have played (R2 3578219f).
  const turnChanges = useRef(new Map<string, number>());
  const handedRunning: string[] = [];
  // Left (the settle mark is the requests' above): the next detail is a new baseline.
  if (!turnScope && turnsSeen.current) {
    turnsSeen.current = null;
    liveTurn.current = null;
  }
  if (turnScope && currentDetail) {
    const seen = turnsSeen.current;
    const latest = !currentDetail.conversation?.hasAfter && !live.windowLoading;
    const ids = currentDetail.turns.map((turn) => turn.id);
    let last = -1;
    if (seen?.scope === turnScope) ids.forEach((id, index) => { if (seen.ids.has(id)) last = index; });
    // A conversation already shown with no Turns takes its first ones as added after nothing; one
    // whose Turns no longer overlap the shown ones (another window, a jump) is a new baseline.
    if (!seen || seen.scope !== turnScope || !seen.latest || !latest || (last < 0 && seen.ids.size > 0)) {
      turnsSeen.current = { scope: turnScope, latest, ids: new Set(ids.slice(-500)), arrived: seen?.scope === turnScope ? seen.arrived : [] };
      if (seen?.scope !== turnScope) liveTurn.current = null;
    } else if (ids.some((id) => !seen.ids.has(id))) {
      const fresh = currentDetail.turns.slice(last + 1).filter((turn) => !seen.ids.has(turn.id));
      const announced = !arrivalsQuiet && liveTurn.current?.workspace === workspaceId && liveTurn.current.agent === selected;
      if (announced && fresh.length) liveTurn.current = null;
      const handedOver = (turn: NativeTurn) => {
        const first = turn.items.find((item) => item.type === "userMessage");
        const id = typeof first?.clientId === "string" ? first.clientId
          : typeof first?._yuzunoClientMessageId === "string" && inTurn.has(first._yuzunoClientMessageId) ? first._yuzunoClientMessageId : null;
        const previews = shownPreviews.current.scope === turnScope ? shownPreviews.current.ids : null;
        const shown = (message: string) => shownMessages.current.has(message) || !!previews?.has(message);
        if (id && shown(id)) return true;
        return !!currentDetail.messageReceipts?.some((receipt) => receipt.binding?.turnId === turn.id
          && turn.items.some((item) => item.id === receipt.binding!.itemId) && shown(receipt.input.clientMessageId));
      };
      if (announced) for (const turn of fresh) if (handedOver(turn) && RUNNING_TURN.test(turn.status)) handedRunning.push(turn.id);
      turnsSeen.current = { scope: turnScope, latest, ids: new Set([...seen.ids, ...ids].slice(-500)),
        arrived: announced ? [...seen.arrived, ...fresh.filter((turn) => !handedOver(turn)).map((turn) => turn.id)].slice(-20) : seen.arrived };
    }
  }
  if (!turnScope) turnCues.current = null;
  else if (currentDetail) {
    const was = turnCues.current?.scope === turnScope ? turnCues.current : null;
    const latest = !currentDetail.conversation?.hasAfter && !live.windowLoading;
    const now = !!was?.latest && latest && turnAnnounced;
    // Its cue's name, "n\nid": the how-manieth time this Turn has started or completed live here.
    const change = (kind: "run" | "done", id: string) => {
      const key = `${turnScope}\n${kind}\n${id}`;
      const n = (turnChanges.current.get(key) ?? 0) + 1;
      turnChanges.current.set(key, n);
      return `${n}\n${id}`;
    };
    const started = [...(was?.started ?? []), ...handedRunning.map((id) => change("run", id))];
    const completed = [...(was?.completed ?? [])];
    const status = new Map<string, string>();
    for (const turn of currentDetail.turns) {
      status.set(turn.id, turn.status);
      const before = was?.status.get(turn.id);
      if (!now || before === undefined) continue;
      const runs = RUNNING_TURN.test(turn.status);
      if (runs && !RUNNING_TURN.test(before)) started.push(change("run", turn.id));
      else if (RUNNING_TURN.test(before) && turn.status === "completed") completed.push(change("done", turn.id));
    }
    turnCues.current = { scope: turnScope, latest, status, started: started.slice(-20), completed: completed.slice(-20) };
  }
  // By its data, not a selector: an ID may hold any character, and CSS.escape is not everywhere.
  // A key ends with its Turn's ID.
  const shownTurn = (key: string) => {
    const id = key.slice(key.lastIndexOf("\n") + 1);
    return [...document.querySelectorAll<HTMLElement>(".turn[data-turn-id]")].find((el) => el.dataset.turnId === id) ?? null;
  };
  useArrivalsIn(
    turnsSeen.current?.scope === turnScope ? turnsSeen.current.arrived.map((id) => `${turnScope}\n${id}`) : [],
    shownTurn,
    "small",
  );
  const cues = turnScope && turnCues.current?.scope === turnScope ? turnCues.current : null;
  useArrivalsIn(cues ? cues.started.map((id) => `${turnScope}\n${id}`) : [],
    (key) => shownTurn(key)?.querySelector<HTMLElement>(".turn-activity") ?? null, "small");
  useArrivalsIn(cues ? cues.completed.map((id) => `${turnScope}\n${id}`) : [],
    (key) => shownTurn(key)?.querySelector<HTMLElement>(".reply-actions") ?? null, "small");
  useArrivalsIn(cues ? cues.completed.map((id) => `${turnScope}\n${id}`) : [],
    (key) => shownTurn(key)?.querySelector<HTMLElement>(".turn-files") ?? null, "small");
  // New Claude messages this window shows sending in their Turn, as of this commit. Read by the next
  // render's Turn arrivals above, with the previews (`previewsShown`).
  useLayoutEffect(() => {
    const shown = new Set<string>();
    const sending = (currentDetail?.turns ?? []).flatMap((turn) => turn.items.filter((item) =>
      typeof item._yuzunoClientMessageId === "string" && inTurn.has(item._yuzunoClientMessageId)));
    if (sending.length) {
      const drawn = new Set([...document.querySelectorAll<HTMLElement>("[data-item-id]")].map((el) => el.dataset.itemId));
      for (const item of sending) if (drawn.has(item.id)) shown.add(item._yuzunoClientMessageId as string);
    }
    shownMessages.current = shown;
  });
  // A message this tab is still sending is on its way, not unconfirmed: Core
  // records its receipt before the harness answers, and a read in between
  // shows it sending (T-120). Only that same message, while its request runs.
  const unconfirmedMessage = currentDetail?.messageReceipts?.some(
    (r) => r.status === "uncertain" || (r.status === "sending" && !(sending && outgoing.some((m) =>
      m.agentId === selected && m.receipt.status === "sending" && m.receipt.input.clientMessageId === r.input.clientMessageId))),
  );
  // The Home tab counts what Needs you lists, only what waits for the user's
  // decision (YN-3): requests and questions, open Asks and executors the user
  // dispatched. Turns that ended unseen stay with their
  // conversations and the Agent list's mark: Home does not list or count them.
  const totalPending = activeAgents.reduce((n, a) => n + a.pendingCount, 0);
  const [openAsks, reportNeedsYou, needsYouItems] = useOpenAsks(workspaceId, !homeOpen && !previewMode, asksRevision);
  // This device's system notifications, where it chose them and its system
  // allows them (T-188). A preview's sample Workspace has none.
  const backupRun = useBackupRun(backupRevision, !previewMode);
  useSystemNotifications(workspaceId, previewMode ? undefined : workspace?.agents, previewMode ? null : needsYouItems, (notice) => {
    if (notice.backup) {
      // Only this Workspace's Backup status: retrying or anything else is the user's to choose there.
      if (notice.backup.workspaceId !== workspaceId) return;
      setSettingsAt({ editor: "backup", nonce: Date.now() });
      setUpdatesOpen(true);
    } else if (notice.home) goHome();
    else if (notice.agentId) selectAgent(notice.agentId);
  }, backupRun);
  // Settings closed, however (its own close, or a card that opens another
  // dialog): a notification's request is used up, not repeated next time.
  useEffect(() => {
    if (!updatesOpen) setSettingsAt(null);
  }, [updatesOpen]);
  const needsYou = totalPending + openAsks;
  // Who needs the user (T-42). What this device has seen of each Agent's last
  // Turn end, kept here only; a preview's sample Workspace keeps none.
  const turnSeen = useTurnSeen(previewMode ? "" : workspaceId);
  // A Turn end is seen once its conversation has been shown, in a visible
  // window, as long as reading marks it read (AUTO_READ_DWELL_MS): the one
  // a window opens on and leaves at once is not.
  const shownEnd = !homeOpen && agent?.lastTurnEnd ? agent.lastTurnEnd.seq : 0;
  useEffect(() => {
    if (previewMode || !selected || !shownEnd) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible")
        timer = setTimeout(() => markTurnSeen(workspaceId, selected, shownEnd), AUTO_READ_DWELL_MS);
    };
    watch();
    document.addEventListener("visibilitychange", watch);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", watch);
    };
  }, [previewMode, workspaceId, selected, shownEnd]);
  // The tab's title and the app's badge count what Home's tab counts. The
  // badge only where this browser or installed app has one; nothing else
  // depends on it.
  useEffect(() => {
    if (previewMode) return;
    document.title = needsYou > 0 ? `(${needsYou}) ${PAGE_TITLE}` : PAGE_TITLE;
    const badge = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    const done = needsYou > 0 ? badge.setAppBadge?.(needsYou) : badge.clearAppBadge?.();
    done?.catch(() => {});
  }, [previewMode, needsYou]);
  // Next needs you: Home's Needs you in Core's order (attention.ts). After an
  // Ask, Home stays the place shown.
  const needsTargets = useMemo(
    () => needsYouTargets(needsYouItems, activeAgents),
    [needsYouItems, activeAgents],
  );
  const lastNeedsJump = useRef<NeedsJump | null>(null);
  const [homeJump, setHomeJump] = useState<{ projectId: string | null; sectionKey?: string; agentId?: string; n: number } | null>(null);
  const goNextNeedsYou = () => {
    const shown: NeedsTarget | null = homeOpen
      ? lastNeedsJump.current && lastNeedsJump.current.target.kind !== "agent" ? lastNeedsJump.current.target : null
      : selected ? { kind: "agent", agentId: selected } : null;
    const jump = nextTarget(needsTargets, shown, lastNeedsJump.current);
    if (!jump) return;
    lastNeedsJump.current = jump;
    const { target } = jump;
    if (target.kind === "agent") {
      selectAgent(target.agentId);
    } else {
      goHome();
      setHomeJump((last) => ({ projectId: target.projectId, n: (last?.n ?? 0) + 1, sectionKey: target.sectionKey }));
    }
  };
  const nextNeedsYou = useRef(goNextNeedsYou);
  nextNeedsYou.current = goNextNeedsYou;
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
      !scopeMenuOpen &&
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
      // On this Workspace's first read, the Agent it remembers; after that,
      // whichever is open now.
      const wanted = firstLoad
        ? readStorage(selectedStorageKey(id), "")
        : currentSelected.current;
      const kept = w.agents.find((a) => a.id === wanted);
      // A remembered agent outside the remembered project is not opened
      // into view: the window starts on Home instead of reading it.
      if (kept && firstLoad && !inScope(kept, current)) setHomeOpen(true);
      setSelected((s) => {
        const asked = firstLoad ? wanted : s;
        return w.agents.some((a) => a.id === asked)
          ? asked
          : visible.find((a) => !a.closedAt)?.id || visible[0]?.id || "";
      });
    },
    (error) => {
      workspaceFailed.current = true;
      setWorkspaceFailure(error);
    },
    (more) => {
      setLoading(false);
      // Not while the read a Retry asked for still waits its turn.
      if (!more) setRetrying(false);
    },
  );
  // Remembered for this Workspace only, and not at all until it is known.
  // Its own effect, so a Workspace that arrives or changes records what is
  // open in it without also resetting the state that belongs to opening an
  // Agent.
  useEffect(() => {
    if (previewMode || !workspaceId) return;
    writeStorage(selectedStorageKey(workspaceId), selected);
  }, [workspaceId, selected]);
  useEffect(() => {
    setActionError("");
    setInterrupting(false);
    setRequestReopen(null);
    setTurnDockEngaged(false);
    setPhoneDock(null);
    setReadingTurn(undefined);
    stickToBottom.current = !historyReading;
    searchReading.current = historyReading;
    setAtBottom(!historyReading);
    setArtifact(null);
  }, [selected]);
  useEffect(() => { pruneResultViewCache(); }, []);
  // A message or Agent link in the address (T-166, T-184): read once, then
  // removed, so a reload returns to where the user is reading, not the link.
  // A report link (T-18) is where the user is reading: it stays while its
  // page is open, and a reload, or the browser's Forward to it, opens it
  // again in that same history entry.
  useEffect(() => {
    if (previewMode) return;
    const take = () => {
      const link = parseAppLink(window.location.href);
      if (!link) return;
      if (link.kind === "report") {
        setIncomingLink({ ...link, fromAddress: true });
        return;
      }
      history.replaceState(history.state, "", window.location.pathname + window.location.search);
      setIncomingLink(link);
    };
    take();
    window.addEventListener("hashchange", take);
    return () => window.removeEventListener("hashchange", take);
  }, []);
  // A push notification clicked while Yuzuno is open (T-200): the service
  // worker focuses this window and posts the link it built from its own
  // scope, never from the push.
  useEffect(() => {
    const worker = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
    if (previewMode || !worker) return;
    const take = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; href?: unknown } | null;
      if (data?.type !== "yuzuno:open" || typeof data.href !== "string") return;
      const link = parseAppLink(data.href);
      if (link) setIncomingLink(link);
    };
    worker.addEventListener("message", take);
    return () => worker.removeEventListener("message", take);
  }, []);
  useEffect(() => {
    if (!incomingLink || !workspace) return;
    setIncomingLink(null);
    initialReading.current = true;
    if (incomingLink.kind === "report") {
      const { kind: _kind, fromAddress, ...link } = incomingLink;
      openReportLink(link, undefined, fromAddress);
    } else openAppLink(incomingLink);
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
    if (saved?.mode === "anchor" && overviewFirst(selected)) readingDeferred.current = selected;
    else if (saved?.mode === "anchor") restoreReading(selected, saved);
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
    if (notice.text) {
      const timer = setTimeout(() => setNotice(""), 4000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  useEffect(() => {
    if (menuError.text) {
      const timer = setTimeout(() => setMenuError(""), 8000);
      return () => clearTimeout(timer);
    }
  }, [menuError]);
  useEffect(() => {
    followHeld.current = sourceJump || !!artifact;
  }, [sourceJump, artifact]);
  // A jump from the dock of a conversation no longer shown: none here, and
  // dropped before anything acts on it.
  const jumpElsewhere = !!jumpToTurn && jumpScope.current?.turnId === jumpToTurn
    && jumpScope.current.scope !== JSON.stringify([workspaceId, selected]);
  const jumpHere = jumpElsewhere ? null : jumpToTurn;
  useEffect(() => {
    if (jumpElsewhere) {
      jumpItem.current = null;
      jumpScope.current = null;
      setJumpToTurn(null);
      return;
    }
    if (sourceJump || artifact) return;
    // An input no longer in the conversation: its Turn instead.
    if (jumpToTurn && jumpItem.current && live.missing === JSON.stringify({turnId:jumpToTurn, itemId:jumpItem.current}))
      jumpItem.current = null;
    const wanted = jumpItem.current;
    if (jumpToTurn && currentDetail?.conversation && !currentDetail.turns.some(t => t.id === jumpToTurn
      && (wanted ? t.items.some(item => item.id === wanted) : !t._yuzunoSlice?.start))) {
      void live.navigate(wanted ? {turnId:jumpToTurn, itemId:wanted} : {turnId:jumpToTurn});
      return;
    }
    if (jumpToTurn && currentDetail?.turns.some((t) => t.id === jumpToTurn)) {
      const turn = document.getElementById(`turn-${jumpToTurn}`);
      const input = wanted ? Array.from(turn?.querySelectorAll<HTMLElement>("[data-item-id]") || [])
        .find(element => element.dataset.itemId === wanted) : undefined;
      const target = input || turn;
      target?.scrollIntoView({ behavior: "instant", block: "start" });
      target?.focus({ preventScroll: true });
      turnSettled.current?.();
      turnSettled.current = target ? settleWhenLanded(target, "data-settle", false, "animation") : null;
      stickToBottom.current = false;
      jumpItem.current = null;
      setJumpToTurn(null);
      return;
    }
    if (stickToBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [currentDetail, jumpToTurn, jumpElsewhere, homeOpen, sourceJump, artifact, outgoing, scroller, live.missing]);
  // A phone's conversation shown again from the Agent list (the same one
  // too, which keeps its place): Back to latest if it is not at its end.
  useEffect(() => {
    if (listShown) return;
    const frame = requestAnimationFrame(measureLatest);
    return () => cancelAnimationFrame(frame);
  }, [listShown, measureLatest]);
  useEffect(() => {
    if (!sourceJump || !catchupSource || homeOpen || !currentDetail) return;
    if (currentDetail.agent.id !== catchupSource.agentId) return;
    if (live.windowLoading) return;
    // A link or a saved position may name a message that is gone (T-166).
    const owner = workspace?.agents.find(a => a.id === catchupSource.agentId);
    // An earlier native session is said first, for a saved place too (T-170).
    const thread = catchupSource.link?.threadId ?? catchupSource.thread;
    const name = catchupSource.agentName;
    const gone: ((t: ShellWords) => string) | null = thread && owner?.threadId && thread !== owner.threadId
      ? t => t.earlierSession(name, catchupSource.restore !== undefined)
      : catchupSource.restore !== undefined
        ? t => t.leftOffGone
        : catchupSource.link
          ? t => t.linkGone(name)
          : null;
    if (currentDetail.conversation && catchupSource.turnId) {
      const loaded = currentDetail.turns.find(t => t.id === catchupSource.turnId);
      if (!loaded || (catchupSource.itemId && catchupSource.itemId !== `yuzuno-plan-${loaded.id}` && !loaded.items.some(i => i.id === catchupSource.itemId))) {
        if (detailError) { setSourceNotice(() => (t: ShellWords) => t.originalFailed(detailError)); return; }
        const wanted = {turnId:catchupSource.turnId, ...(catchupSource.itemId && catchupSource.itemId !== `yuzuno-plan-${catchupSource.turnId}` ? {itemId:catchupSource.itemId} : {})};
        if (live.missing === JSON.stringify(wanted)) {
          // Core has no such Turn or Item: say so once, at the latest
          // messages, instead of asking for it again.
          if (catchupSource.restore !== undefined) { setNotice(gone?.(shell) ?? ""); backToLatest(); return; }
          const itemId = catchupSource.itemId;
          setSourceNotice(() => gone ?? ((t: ShellWords) => (itemId ? t.replyGone : t.turnGone)));
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
    if (absent && catchupSource.restore !== undefined) { setNotice(gone?.(shell) ?? ""); backToLatest(); return; }
    const said: ((t: ShellWords) => string) | null =
      catchupSource.kind === "pending" && !request
        ? t => t.requestGone
        : absent && gone
          ? gone
        : catchupSource.itemId && !message
          ? t => t.replyGone
          : catchupSource.turnId && !turn
            ? t => t.turnGone
            : null;
    setSourceNotice(() => said);
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
        // Landed on the mark already there (the same message again): its ring plays again.
        ringAgain(target);
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
      await interruptAgent(selected);
      setNotice(shellNow.current.interruptHere);
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
      // This device's letters for them (shortcut-keys.ts), read as pressed.
      if (pressed(event, shortcutKeys().newAgent)) {
        event.preventDefault();
        setCreateOpen(true);
      }
      if (pressed(event, shortcutKeys().find)) {
        event.preventDefault();
        setSearchOpen((v) => !v);
        setRailOpen(true);
      }
      if (pressed(event, shortcutKeys().nextNeedsYou)) {
        event.preventDefault();
        nextNeedsYou.current();
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
  /** Settings at one editor, from another dialog that has just closed (the
   * Jobs card's Edit in Settings, T-55): it lets go of focus first. */
  function openSettingsAt(editor: SettingsEditor) {
    if (previewMode) return;
    requestAnimationFrame(() => {
      setSettingsAt({ editor, nonce: Date.now() });
      setUpdatesOpen(true);
    });
  }
  /** Settings at a page (YN-8): the rail's projects and machines, the status
   * bar's machines, Home's machine links. */
  function openSettingsPage(page: SettingsPage, sub?: string) {
    if (previewMode) return;
    setSettingsAt({ page, sub, nonce: Date.now() });
    setUpdatesOpen(true);
  }
  function openSettingsDestination(destination: SettingsDestination) {
    if (previewMode) return;
    // A project or the machines is a page of Settings: it stays open.
    const page = destinationPage(destination);
    if (page) {
      if (destination.kind === "project" && !projects.some((project) => project.id === destination.projectId && !project.archivedAt)) return;
      setSettingsAt({ ...page, nonce: Date.now() });
      return;
    }
    setUpdatesOpen(false);
    // Let the Settings dialog release its focus/aria-hidden layer before
    // another existing dialog or the conversation inspector takes over.
    requestAnimationFrame(() => {
    if (destination.kind === "agent") {
      const chosen = workspace?.agents.find((item) => item.id === destination.agentId && !item.closedAt);
      if (!chosen || (chosen.harness === "opencode" && destination.section !== "model") ||
        (destination.section === "context" && chosen.harness !== "codex") ||
        (destination.section === "auto-continue" && (chosen.harness !== "claude" || chosen.remote))) return;
      selectAgent(chosen.id);
      if (destination.section === "auto-continue") {
        if (phone) { setPhoneInspector(true); setPhoneList(false); }
        else setInspector(true);
        setSettingsInspectorAgent(chosen.id);
      } else {
        setModelRequest({ model: "", nonce: Date.now(), agentId: chosen.id, section: destination.section });
      }
    } else if (destination.kind === "taskWorkspaces") {
      // That Task, by its ID, at its own Workspace section: it opens there and
      // lists, and nothing is previewed or removed until it is asked there.
      setTaskFocus({ taskId: destination.taskId, section: "workspaces", at: Date.now() });
      setCollaborationOpen(true);
    }
    });
  }
  // An Agent's action menu (T-184), in the list and the conversation header.
  // Each entry acts on the Agent the menu was opened on, never on whichever
  // is selected by then; a reconnect or interrupt already running for that
  // Agent is not sent again (api.ts).
  // Said where it is seen when the reply comes: in that Agent's conversation
  // if it is on screen, otherwise naming the Agent.
  const agentName = (id: string) => workspace?.agents.find((a) => a.id === id)?.name || shell.theAgent;
  const menuFailed = (id: string, what: "reconnect" | "interrupt") => (error: unknown) => {
    if (shownConversation.current === id) setActionError(errorText(error));
    else setMenuError(shell.menuFailed(what, agentName(id), errorText(error)));
  };
  // Links are offered on an http(s) page only, as message links are (T-166).
  const linkBase = /^https?:$/.test(window.location.protocol) ? `${window.location.origin}${window.location.pathname}` : "";
  /** Copies the link to an Agent (T-184), saying whether it was copied. */
  const copyAgentLink = (id: string) => {
    const href = agentLinkHref(linkBase, { workspaceId, agentId: id });
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(href))
      .then(
        () => setNotice(shell.linkCopied(agentName(id))),
        () => setMenuError(shell.linkRefused(agentName(id), href)),
      );
  };
  // Shown already (its own header's menu): nothing to navigate.
  const showAgent = (id: string) => {
    if (id !== selected || homeOpen || (phone && phoneList)) openFromList(id);
  };
  const agentActions: AgentActionHandlers = {
    reconnect: (id) =>
      reconnectAgent(id).then(refresh, (error) => {
        refresh();
        menuFailed(id, "reconnect")(error);
      }),
    interrupt: (id) =>
      interruptAgent(id).then(() => {
        setNotice(shownConversation.current === id ? shell.interruptHere : shell.interruptFor(agentName(id)));
        refresh();
      }, menuFailed(id, "interrupt")),
    settings: (id) => {
      showAgent(id);
      setSettingsFor(id);
    },
    manage: (id) => {
      showAgent(id);
      setRequestActions((v) => ({ agentId: id, sequence: (v?.sequence || 0) + 1 }));
    },
    endMissing: (id) => {
      showAgent(id);
      setEndMissingFor(id);
    },
    disconnect: (id) => setDisconnectFor(id),
    copyLink: linkBase && workspaceId && !previewMode ? copyAgentLink : undefined,
  };
  useEffect(() => {
    if (!settingsFor || settingsFor !== selected) return;
    setSettingsFor(null);
    setModelRequest({ model: "", nonce: Date.now() });
  }, [settingsFor, selected]);
  // Taken by that Agent's management once it is shown (its effect runs first).
  useEffect(() => {
    if (requestActions && requestActions.agentId === selected) setRequestActions(null);
  }, [requestActions, selected]);
  function selectAgent(id: string, turnId?: string) {
    setPhoneList(false);
    // Reopening a conversation returns where it was left (T-166).
    const saved = !turnId && (id !== selected || homeOpen) ? readingPositions?.get(id) : null;
    const deferred = saved?.mode === "anchor" && overviewFirst(id);
    readingDeferred.current = deferred ? id : null;
    if (saved?.mode === "anchor" && !deferred && restoreReading(id, saved)) return;
    if (turnId) showConversation(id);
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
    extra: { link?: MessageLink; restore?: number; progress?: number; thread?: string; where?: "desktop" | "browser" } = {},
  ) {
    setPhoneList(false);
    revealAgent(workspace?.agents.find((a) => a.id === item.agentId));
    setHistoryReading(true);
    setSourceOrigin(origin);
    searchReading.current = true;
    stickToBottom.current = false;
    setAtBottom(false);
    setSelected(item.agentId);
    showConversation(item.agentId);
    setHomeOpen(false);
    setCatchupSource({ ...item, openDetails, ...extra });
    setSourceNotice(null);
    setSourceJump(true);
    setJumpToTurn(null);
  }
  /** Home links into a conversation (or Settings › Machines) and leads back. */
  function openFromHome(target: HomeTarget) {
    if (target.kind === "machine") {
      openSettingsPage("machines", target.machineId);
      return;
    }
    if (target.kind === "projectSettings") {
      openSettingsPage("projects", target.projectId);
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
      "rail", false, { restore: 0, progress: offer.handoff.progress ?? 0, thread: offer.handoff.threadId, where: offer.handoff.label },
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
    if (!workspace) { setIncomingLink({ kind: "message", ...link }); return; }
    if (link.workspaceId !== workspaceId) {
      setNotice(shell.linkOtherMessage);
      return;
    }
    const owner = workspace.agents.find((a) => a.id === link.agentId);
    if (!owner) {
      setNotice(shell.linkAgentGone);
      return;
    }
    openCatchupSource(
      { id: `link:${link.turnId}:${link.itemId || ""}`, agentId: owner.id, agentName: owner.name, kind: "progress",
        title: "Linked message", body: "", turnId: link.turnId, itemId: link.itemId, seq: owner.lastSeq },
      homeOpen ? "home" : "rail", false, { link },
    );
  }
  /**
   * Opens the Agent a link names (T-184): it is selected, as a click in the
   * list selects it, and only that. Nothing is reconnected, sent, created or
   * changed, and the draft stays. Another Workspace or a missing Agent is
   * said, and nothing else is selected instead.
   */
  function openAgentLink(link: AgentLink) {
    if (!workspace) { setIncomingLink({ kind: "agent", ...link }); return; }
    if (link.workspaceId !== workspaceId) {
      setNotice(shell.linkOtherAgent);
      return;
    }
    const owner = workspace.agents.find((a) => a.id === link.agentId);
    if (!owner) {
      setNotice(shell.linkAgentGone);
      return;
    }
    openFromList(owner.id);
    if (owner.closedAt) setNotice(shell.shownClosed(owner.name));
  }
  /** Opens the Workspace's Home a link names (T-200, a push about an Ask or
   * several updates). Another Workspace's is said, and nothing changes. */
  function openHomeLink(link: HomeLink) {
    if (link.workspaceId !== workspaceId) {
      setNotice(shell.linkOtherHome);
      return;
    }
    goHome();
  }
  /** Opens the report a link names (T-18) over Home; from a message, Back
   * returns to it. Another Workspace's report is said, and nothing opens. */
  function openReportLink(link: ReportLink, from?: { turnId: string; itemId?: string }, fromAddress = false) {
    if (!workspace) { setIncomingLink({ kind: "report", ...link, fromAddress }); return; }
    if (link.workspaceId !== workspaceId) {
      // The address keeps no link this Workspace can open.
      if (fromAddress) history.replaceState(history.state, "", window.location.pathname + window.location.search);
      setNotice(reportText(language).otherWorkspace);
      return;
    }
    const reading = from && !homeOpen ? currentDetail?.agent : undefined;
    const back = reading && from ? { workspaceId, agentId: reading.id, turnId: from.turnId, itemId: from.itemId, threadId: reading.threadId } : null;
    setHomeReport({ link, back, fromAddress, n: ++reportOpenings.current });
    setHomeOpen(true);
    setPhoneList(false);
  }
  function openAppLink(link: AppLink) {
    if (link.kind === "agent") openAgentLink(link);
    else if (link.kind === "home") openHomeLink(link);
    else if (link.kind === "report") openReportLink(link);
    else openMessageLink(link);
  }
  const openLink = useRef(openMessageLink);
  openLink.current = openMessageLink;
  const openReport = useRef(openReportLink);
  openReport.current = openReportLink;
  /** "Open on Home" on a reply from Home (T-9): Home, at the section and
   * version it answered, where Home says what has become of it. A reply
   * from another Workspace's Home opens nothing here. */
  const openHomeReply = useRef<HomeReplyLinksApi["open"]>(() => {});
  openHomeReply.current = (origin, from) => {
    if (origin.workspaceId && origin.workspaceId !== workspaceId) {
      setNotice(homeReplyText(language).otherWorkspace);
      return;
    }
    const owner = workspace?.agents.find((a) => a.id === from.agentId);
    setHomeArrival((last) => ({ origin, back: { workspaceId, ...from, threadId: owner?.threadId }, n: (last?.n ?? 0) + 1 }));
    goHome();
  };
  const homeReplyLinks = useMemo<HomeReplyLinksApi>(() => ({ open: (origin, from) => openHomeReply.current(origin, from) }), []);
  // Leaving Home ends the arrival: opening it again some other way is not one.
  useEffect(() => {
    if (!homeOpen) {
      setHomeArrival(null);
      setHomeReport(null);
    }
  }, [homeOpen]);
  const messageLinks = useMemo<MessageLinkApi>(() => ({
    href: (owner, turnId, itemId) => linkBase && workspaceId && !previewMode
      ? messageLinkHref(linkBase, { workspaceId, agentId: owner.id, turnId, itemId, threadId: owner.threadId })
      : null,
    open: (link) => openLink.current(link),
    reportHref: (link) => linkBase && workspaceId && !previewMode ? reportLinkHref(linkBase, { workspaceId, ...link }) : null,
    openReport: (link, from) => openReport.current(link, from),
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
  // A name too long for the header is opened by pressing it, since the rail
  // may have had to cut it too and a title only answers a pointer (T-15).
  const nameRef = useRef<HTMLHeadingElement>(null);
  const [nameOpen, setNameOpen] = useState(false);
  const [nameCut, setNameCut] = useState(false);
  useLayoutEffect(() => setNameOpen(false), [selected]);
  useLayoutEffect(() => { setRailIndex(false); setRailWork(false); }, [selected]);
  useLayoutEffect(() => {
    const element = nameRef.current;
    if (!element || nameOpen) return;
    const measure = () => {
      // Whatever is doing the clipping. Once the name is cut the h1 holds a
      // `.conversation-name` button that clips its own overflow, so the h1
      // stops overflowing and measuring the h1 answered "it fits" — which
      // rendered plain text, which overflowed, which cut it again. Each
      // frame and each ResizeObserver tick flipped it, and whichever
      // happened to be last decided whether a cut name had anything to
      // press at all: after closing an expanded name, the third measurement
      // left it truncated and unpressable, the one case this exists for
      // (#459 R2, P2).
      const box = element.querySelector<HTMLElement>(".conversation-name") ?? element;
      setNameCut(box.scrollWidth > box.clientWidth + 1);
    };
    measure();
    // Somewhere without one, the first measurement is the only one, as the
    // conversation's own layout does (ConversationWindow, useAutoRead).
    if (typeof ResizeObserver === "undefined") return;
    // The controls beside it and the fonts settle over the next frames, and
    // the heading's own box may never change while its text does.
    let frame = requestAnimationFrame(() => {
      measure();
      frame = requestAnimationFrame(measure);
    });
    const watch = new ResizeObserver(measure);
    watch.observe(element);
    if (element.parentElement) watch.observe(element.parentElement);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
    };
  }, [agent?.name, nameOpen, selected]);
  // The reading bar and what it says: a source being read, which carries the
  // single way back to the latest. A window of earlier messages has no bar of
  // its own: newer pages load as the reader nears its end, and Back to latest
  // floats above the composer meanwhile (YN-19).
  const source = catchupSource?.agentId === selected ? catchupSource : null;
  const historyWindow = !!currentDetail?.conversation?.hasAfter;
  const readingBar = !!source;
  const pillShown = latestShown && !readingBar;
  // The newer page on its way, or why it could not be read while Core has
  // not read it since (it retries): the line at the window's end (YN-19).
  const newerPage = windowPage?.direction !== "after" ? null : !windowPage.failed ? "loading" : detailError ? "failed" : null;
  // Search offers to open a message, Agent or report link; a Home link is
  // what a notification opens, not something to paste.
  const pastedLink = searchOpen ? parseAppLink(search) : null;
  const searchLink = pastedLink?.kind === "home" ? null : pastedLink;
  function openSearchLink() {
    if (!searchLink) return;
    setSearchOpen(false);
    setSearch("");
    openAppLink(searchLink);
  }
  // From a dock or a sub-agent's card, which on a phone is a panel over the
  // conversation (PhoneDocks.tsx): the panel closes on the Turn it goes to.
  function navigateToTurn(turnId: string) {
    jumpItem.current = null;
    if (selected) showConversation(selected);
    setPhoneDock(null);
    setHistoryReading(true);
    searchReading.current = true;
    setAtBottom(false);
    setSourceJump(false);
    setJumpToTurn(turnId);
    jumpScope.current = { turnId, scope: JSON.stringify([workspaceId, selected]) };
    stickToBottom.current = false;
  }
  /** Reads from one of the person's inputs (T-6): its Turn, at the input. */
  function navigateToInput(entry: string) {
    const { turnId, itemId } = entryInput(entry);
    navigateToTurn(turnId);
    jumpItem.current = itemId;
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
    setPhoneDock(null);
    setPageTarget(null);
    setPageSpace(null);
    setWindowPage(null);
    windowRead.current = null;
    readerWay.current = null;
    savedPages.drop();
    toLatest.current = !!currentDetail?.conversation?.hasAfter;
    if (currentDetail?.conversation) void live.navigate({});
    setHistoryReading(false);
    searchReading.current = false;
    setAtBottom(true);
    setCatchupSource(null);
    setSourceJump(false);
    setJumpToTurn(null);
    stickToBottom.current = true;
    // The reader's place is the latest from the press on (T-166).
    noteReading(true);
    pinLatest();
  }
  /** One press of Back to latest ends at the very end (YN-19). Each frame
   * the end is put in view, instantly (a smooth scroll's steps look like
   * the reader scrolling, and estimated gaps change as the final rows
   * mount): first the shown window's, while the newest is still on its way,
   * then the newest window's, until its rows have measured — the end has
   * stayed put for three frames, or a second has passed. Scrolled once when
   * the newest window arrived, the end moved on as its rows below the view
   * mounted and grew. The reader's own scroll ends it (stopLatestPin), as
   * does anything that stops following the end. */
  function pinLatest() {
    stopLatestPin();
    const pin = { frame: 0 };
    const began = performance.now();
    let arrived = 0, still = 0, height = -1;
    // Its scrolls were not the reader's (onScroll let them be): once it
    // ends, the pane says where it is as any scroll does.
    const finish = (el: HTMLDivElement | null) => {
      latestPin.current = null;
      el?.dispatchEvent(new Event("scroll"));
    };
    const step = () => {
      const el = scroll.current;
      if (latestPin.current !== pin) return;
      if (!el || !stickToBottom.current) return finish(el);
      const now = performance.now();
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 0.5) el.scrollTop = el.scrollHeight;
      if (newestShown.current) {
        arrived ||= now;
        still = el.scrollHeight === height ? still + 1 : 0;
        height = el.scrollHeight;
        if (still >= 3 || now - arrived >= 1000) return finish(el);
      } else if (now - began >= 10_000) return finish(el);
      pin.frame = requestAnimationFrame(step);
    };
    latestPin.current = pin;
    pin.frame = requestAnimationFrame(step);
  }
  /** The session's own earlier turns, read where the saved conversation
   * starts; the reader's first Turn is held in place. */
  function loadEarlierTurns() {
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
  }
  function changeHistoryPage(direction: "before" | "after") {
    toLatest.current = false;
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
    // Newer messages load as the reader nears the end (YN-19), so the newer
    // window starts a screen above what is in view, not at the last Item
    // shown: what is in view stays, with a screen of what was read before
    // it, and only what was scrolled past further up gives way.
    if (direction === "after") {
      const from = savedAbove(scroll.current?.clientHeight ?? 0);
      if (from && from !== window.start) cursor = from;
    }
    const [turnId, itemId] = JSON.parse(cursor) as [string, string | null];
    const item = pageAnchor(turnId, itemId || undefined);
    // A page target holds the reader's place; it opens nothing (T-161).
    const target = {agentId:selected, turnId, itemId:itemId || undefined,
      top:item ? readingTop(item) : (scroll.current?.getBoundingClientRect().top ?? 0) + 32,
      start:window.start, end:window.end, hold:true as const};
    const reading = readerAnchor();
    pageHold.current = null;
    stickToBottom.current = false;
    setHistoryReading(true);
    setAtBottom(false);
    if (direction === "before") {
      // The earlier window goes in front of what is being read (T-161). The
      // live window is pinned, so new messages do not move it out from
      // under the earlier ones.
      live.pinWindow();
      if (savedPages.loadEarlier(cursor)) {
        setPageTarget(reading ? {...target, ...reading} : target);
        return;
      }
      // Past the bound the windows are replaced. The new one ends at the
      // last saved message in view, not at the first Item shown (in a long
      // Turn, often a command in a closed group, below which everything in
      // view went): what is in view stays, and the message being read is
      // held in place (T-161).
      const last = readerAnchor(true);
      if (reading && last && savedPages.detail?.turns.some(turn => turn.id === last.turnId && turn.items.some(item => item.id === last.itemId))) {
        setPageSpace(space => ({...space, after:true}));
        setPageTarget({...target, ...reading});
        readWindow("before", {before:JSON.stringify([last.turnId, last.itemId])});
        return;
      }
    }
    // Replacing a page removes content on the opposite side of its overlap.
    // Reserve at most one viewport there so scrollTop is not clamped before
    // the overlapping item can return to the same screen position.
    setPageSpace(space => ({...space, [direction === "before" ? "after" : "before"]:true}));
    setPageTarget(direction === "after" && reading ? {...target, ...reading} : target);
    readWindow(direction, {[direction]:cursor});
  }
  /** Reads the saved window in place of the shown one. A read that fails
   * lets the place go, as an earlier page's does (the window it was held
   * for did not come), and says so on its side with a way to try again
   * (YN-19); Core's reader keeps retrying it meanwhile. */
  function readWindow(direction: "before" | "after", query: Record<string, string>) {
    const page = { direction };
    windowRead.current = page;
    setWindowPage(page);
    void live.navigate(query, true).then(() => {
      if (windowRead.current !== page) return;
      windowRead.current = null;
      if (!live.sync.failed) { setWindowPage(null); return; }
      setWindowPage({ ...page, failed: true });
      setPageTarget(null);
      releaseSpace();
    });
  }
  /** The saved message a newer window starts at: the last one starting at
   * least `reach` above the view, else the first mounted one. Only saved
   * messages: native pages and outgoing ones are no cursor. */
  function savedAbove(reach: number) {
    const pane = scroll.current;
    const turns = savedPages.detail?.turns;
    if (!pane || !turns) return null;
    const line = pane.getBoundingClientRect().top - reach;
    let found: string | null = null;
    for (const element of pane.querySelectorAll<HTMLElement>("[data-item-id]")) {
      const turnId = element.closest<HTMLElement>("[id^='turn-']")?.id.slice("turn-".length);
      const itemId = element.dataset.itemId;
      const rect = element.getBoundingClientRect();
      if (!turnId || !itemId || rect.height <= 0 || !turns.some(turn => turn.id === turnId && turn.items.some(item => item.id === itemId))) continue;
      if (found && rect.top > line) break;
      found = JSON.stringify([turnId, itemId]);
      if (rect.top > line) break;
    }
    return found;
  }
  /** Near either end of a saved window with more beyond it, the next one is
   * read by itself, as its link or button read it before (YN-19): newer
   * ones within a screen of the end as the reader goes down, earlier ones
   * within a screen of the top as they go up. The session's own earlier
   * turns stay behind their button. Not while another read, a held place,
   * a jump or Back to latest is on its way, nor after a read failed (Try
   * again reads it), nor where nothing is laid out. */
  function autoPage() {
    const el = scroll.current;
    const window = currentDetail?.conversation;
    const way = readerWay.current;
    if (!el || el.clientHeight <= 0 || !window || !way || previewMode || homeOpen || listShown) return;
    if (live.windowLoading || savedPages.loading || savedPages.error || windowPage || pageTarget || latestPin.current
      || toLatest.current || jumpToTurn || sourceJump || artifact) return;
    const reach = el.clientHeight;
    if (way === "down" && window.hasAfter) {
      const room = afterSpace.current?.offsetHeight ?? 0;
      if (el.scrollHeight - el.scrollTop - el.clientHeight - room < reach) changeHistoryPage("after");
    } else if (way === "up" && window.hasBefore) {
      const room = beforeSpace.current;
      if (el.scrollTop - (room ? room.offsetTop + room.offsetHeight : 0) < reach) changeHistoryPage("before");
    }
  }
  // Again when a read or a held place ends, or the window changes: a short
  // page can leave the reader near its end with nothing more to scroll.
  useEffect(() => autoPage(), [currentDetail, live.windowLoading, savedPages.loading, pageTarget, windowPage]);
  // A failed read that Core's reader has since read after all (it retries)
  // no longer stops the next page.
  useEffect(() => {
    if (!detailError) setWindowPage(page => (page?.failed ? null : page));
  }, [detailError]);
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
    // This send belongs to the Workspace and Agent it starts in: what it
    // says when it finishes is for them, not for whatever is open by then.
    const startedIn = workspaceId;
    const here = () =>
      currentSelected.current === target && currentWorkspace.current === startedIn;
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
        const opencode = agent.harness === "opencode";
        if (control.args) throw new Error(`${opencode ? "OpenCode" : "Codex"}'s own compaction takes no instructions. Send /compact alone; your draft is kept.`);
        await post(`/agents/${encodeURIComponent(target)}/compact`);
        clearIfUnchanged(target, sentDraft);
        setNotice(opencode ? shell.opencodeCompactAccepted : shell.compactAccepted);
        refresh();
        return;
      }
      if (sentDraft.images?.some(image => image.agentId !== target)) throw new Error("These images belong to the original Agent. Attach them again in this Agent; your draft is kept.");
      if (sentDraft.skills?.some(skill => skill.agentId !== target)) throw new Error("Some skills here were listed for another Agent. Remove them and choose this Agent's own; your draft is kept.");
      await submitMessage(text, null, sentDraft.images?.map(image => image.id), undefined, draftTextBlocks(sentDraft),
        sentDraft.skills?.map(({ name, path }) => ({ name, path })));
      clearIfUnchanged(target, sentDraft);
      refresh();
      if (here()) composer.current?.focus();
    } catch (e) {
      // A failure from a send that started in another Workspace is not this
      // Workspace's to show, even when the Agent id is the same.
      if (here()) setActionError(errorText(e));
    }
  }
  function reviewStarted(agentId: string, sentDraft: ComposerDraft) {
    clearIfUnchanged(agentId, sentDraft);
    setNotice(shell.reviewStarted);
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
    setNotice(shell.addedToDraft);
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
  // Whether the text was added and saved (an OpenCode revert counts its text as given only then).
  // With an `origin`, once: a draft that holds it already is saved again as it is, not added to.
  const rewindDraft = useCallback((agentId: string, text: string, origin?: string) => {
    const saved = setDraft(agentId, current => origin ? appendDraftOnce(current, text, origin) : appendDraft(current, text));
    if (saved) setNotice(shellNow.current.rewindSaved);
    return saved;
  }, [setDraft]);
  // An OpenCode fork (T-10 Fork): its new Agent shown and opened. The source
  // Agent stays as it is, its draft too: nothing is copied or sent.
  function openForked(outcome: OpenCodeForkOutcome) {
    const fork = outcome.agent;
    if (!fork) return;
    markJoined(fork.id);
    setWorkspace((w) => w ? { ...w, agents: [...w.agents.filter((a) => a.id !== fork.id), fork] } : w);
    revealAgent(fork);
    setSelected(fork.id);
    setAgentScope(fork.closedAt ? "closed" : "active");
    refresh();
    // No credential crosses Agents (T-61 slice 7, D-31): the new one's OpenCode has no login of this one's.
    setNotice(fork.closedAt ? shell.forkClosed(fork.name)
      : `${outcome.connected ? shell.forkContinuing(fork.name)
        : shell.forkNotConnected(fork.name, (outcome.warnings ?? []).join(" "))} ${shell.openCodeForkLogin}`);
  }
  /**
   * Send to Agent (T-152): the menu and a drop on the rail both end here. It
   * only adds to that Agent's draft, after what is there, and opens it: the
   * user edits and sends it, or not. Nothing is sent, assigned or dispatched.
   */
  function handoffToAgent(source: HandoffSource, targetId: string) {
    const target = workspace?.agents.find(a => a.id === targetId);
    // Said in the interface language; what is added to the draft is the
    // message itself, as it is (T-189).
    const said = handoffNotices(language);
    const refusal = previewMode
      ? said.preview
      : targetId === selected && draftBlocked
        ? said.recoverFirst
        : handoffRefusal(source, target, language);
    if (refusal || !target) {
      setNotice(refusal || handoffRefusal(source, undefined, language) || "");
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
        setNotice(said.needsRecovery(target.name));
        return false;
      }
    }
    // Dialogs it was picked up in close on this, so the draft is in view.
    setCollaborationOpen(false);
    window.dispatchEvent(new Event("yuzuno:handoff-sent"));
    selectAgent(targetId);
    requestAnimationFrame(() => composer.current?.focus());
    setNotice(said.added(handoffLabel(source, language), target.name));
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
    setNotice(shell.annotatedAdded(target.name));
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
      setNotice(shell.noTurnReference);
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
      setNotice(shell.markedRead);
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
      setNotice(shell.deleted(agent.name));
    } else if (updated) {
      setWorkspace((w) =>
        w
          ? { ...w, agents: w.agents.map((a) => (a.id === id ? updated : a)) }
          : w,
      );
      live.sync.mutate((d) => (d.agent.id === id ? { ...d, agent: updated } : d));
      // A release that waits for its work to end is archiving, still open (T-36 S3).
      const archiving = action === "release" && !updated.releasedAt ? updated.executor?.reason || "" : null;
      if (currentSelected.current === id)
        setAgentScope(action === "close" || (action === "release" && archiving === null) ? "closed" : "active");
      setNotice(action === "close" ? shell.closedSaved(agent.name)
        : archiving !== null ? shell.archiving(agent.name, archiving)
        : action === "release" ? shell.released(agent.name) : shell.reopened(agent.name));
    }
    live.clearError();
    setCatchupSource(null);
    refresh();
  }
  // A failed executor still blocking its task, and the archived ones in
  // their fold, are listed with the open Agents (T-36 S3).
  const searched =
    (agentScope === "closed" ? scopedClosed : [...scopedActive, ...scopedClosed.filter((a) => inExecutors(a) || isArchived(a))]).filter((a) =>
      `${a.name} ${a.workSummary?.text || ""} ${a.cwd} ${a.remote?.machine.name || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) || [];
  // In attention order when Appearance chooses it (T-42): the same Agents,
  // ordered within each group as grouping keeps the list's order.
  const filteredAgents =
    appearance.agentOrder === "attention"
      ? orderByAttention(searched, { seen: turnSeen, since: waitingSince(needsYouItems) })
      : searched;

  return (
    <HandoffContext.Provider value={handoffApi}>
    <PointFixOpen.Provider value={previewMode ? null : openPointFix}>
    <MessageLinks.Provider value={messageLinks}>
    <HomeReplyLinks.Provider value={previewMode || !workspaceId ? null : homeReplyLinks}>
    <WorkActivityProvider>
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
        lang={langTag(language)}
        onMouseDown={(event) => moveWindow(frame, event)}
      >
        <div className="toolbar-brand" ref={brandBox}>
          {phone && !phoneList ? (
            <button
              ref={phoneBack}
              className="phone-back"
              title={shell.backTitle}
              onClick={showAgentList}
            >
              <ChevronLeft size={18} />
              {shell.back}
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
            aria-label={railOpen ? shell.hideRail : shell.showRail}
            title={shell.toggleRail}
            onClick={() => setRailOpen((v) => !v)}
          >
            <PanelLeft size={17} />
          </button>
          <span className="workspace-name">{shell.workspace}</span>
          <span className="toolbar-context">
            {isNative ? shell.desktop : shell.web}
          </span>
          {/* Workspace-wide views live here; the sidebar is all agents. */}
          <nav className="toolbar-nav" aria-label={shell.views}>
            <button
              className={`catchup-nav ${homeOpen ? "selected" : ""}`}
              aria-current={homeOpen ? "page" : undefined}
              title={needsYou > 0 ? shell.homeWaiting(needsYou) : shell.home}
              onClick={goHome}
            >
              <House size={15} />
              <span className="toolbar-nav-label">{shell.home}</span>
              {needsYou > 0 && (
                <span className="nav-count attention">{needsYou}</span>
              )}
            </button>
            <button
              className="catchup-nav collab-nav"
              title={shell.tasks}
              onClick={() => setCollaborationOpen(true)}
              disabled={loading}
            >
              <MessageSquare size={15} />
              <span className="toolbar-nav-label">{shell.tasks}</span>
            </button>
            <Jobs key={`jobs-${workspaceId}`} workspaceId={workspaceId} agent={agent} agents={workspace?.agents || []} projects={workspace?.projects || []} revision={String(jobsRevision)} mergeQueueRevision={String(mergeQueueRevision)} disabled={previewMode || loading} onOpenSettings={openSettingsAt} />
          </nav>
        </div>
        <div className="toolbar-actions">
          <span
            className={`connection ${core.healthy ? "connected" : ""}`}
            title={core.description}
            data-core-status={core.status}
          >
            {/* The dot is named too: the dot rule once matched every span in
                here, the label included, which drew it as a second 5px dot
                with its words wrapped over the icons (YN-17). */}
            <span className="connection-dot" />
            {/* Named, so a screen too short for the words can keep the dot
                and its title (T-15 V5). */}
            <span className="connection-label">{core.label}</span>
          </span>
          {/* Where the bottom bar has no room to stand, its way in stands
              here instead; StatusBar.tsx fills this (T-15 V5). */}
          <span className="core-status-slot" id="core-status-slot" />
          {updatesNeedReload && <UpdateBanner onOpen={() => setUpdatesOpen(true)} />}
            <button
              className="icon-button workspace-settings"
              title={shell.settingsTitle}
              aria-label={shell.settings}
              onClick={() => setUpdatesOpen(true)}
            >
              <Settings2 size={16} />
            </button>
          <button
            className={`icon-button ${(phone ? phoneInspector : inspector) ? "active" : ""}`}
            title={shell.inspector}
            aria-label={shell.inspector}
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
      <aside className="rail" id="agent-sidebar" ref={railBox} lang={langTag(language)} inert={phone && !phoneList ? true : undefined}>
        <PanelResizeHandle side="rail" size={panelWidths.rail} />
        {railWork && !phone ? (
          <WorkActivityColumn
            onBack={() => {
              // Before the column goes, so the browser does not drop focus on
              // `body` when the button inside it is removed. The entry itself
              // is in the head and stays mounted either way.
              document.querySelector<HTMLElement>(".work-activity-entry")?.focus();
              setRailWork(false);
            }}
          />
        ) : railIndex && !phone ? (
          <RailTurnIndex
            turns={logicalTurns}
            readingTurnId={readingTurn}
            loadedNumbering={!!currentDetail?.history}
            onNavigate={navigateToTurn}
            onBack={() => setRailIndex(false)}
          />
        ) : (
        <>
        <div className="rail-top">
          <RailHeading
            scope={agentScope}
            active={scopedActive.length}
            closed={scopedClosed.length}
            shortcut={shortcutModifier}
            onScope={setAgentScope}
            onSearch={() => setSearchOpen((v) => !v)}
            onCreate={() => setCreateOpen(true)}
            extra={
              !previewMode && workspace ? (
                <BatchReconnect workspaceId={workspaceId} agents={workspace.agents} scope={scope} onSettled={refresh} />
              ) : null
            }
          />
          {searchOpen && (
            <div className="agent-search">
              <Search size={13} />
              <input
                autoFocus
                placeholder={shell.findAgent}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && searchLink) {
                    e.preventDefault();
                    openSearchLink();
                  }
                }}
                aria-label={shell.searchAgents}
              />
              <button
                className="icon-button"
                aria-label={shell.closeSearch}
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
              {searchLink.kind === "agent" ? shell.openLinkedAgent : searchLink.kind === "report" ? shell.openLinkedReport : shell.openLinkedMessage}
            </button>
          )}
        </div>
        {/* Next needs you (T-42): at the top of the list, on a phone too, while
            something waits; its own row, so the heading fits any rail. */}
        {needsTargets.length > 0 && (
          <button
            type="button"
            className="next-needs-you"
            title={shell.nextNeedsYouTitle(`${shortcutModifier} ${boundKeys.nextNeedsYou}`, needsTargets.length)}
            onClick={goNextNeedsYou}
          >
            <BellRing size={14} />
            <span>{shell.nextNeedsYou}</span>
            {!phone && <kbd>{shortcutModifier} {boundKeys.nextNeedsYou}</kbd>}
          </button>
        )}
        <nav className="agent-list" aria-label={shell.agents}>
          {(() => {
            // How long each has waited for you, from Home's Needs you (T-43 S2).
            const waited = waitingSince(needsYouItems);
            const row = (a: Agent) => {
            const unseen = unseenEnd(a, turnSeen);
            return (
            <AgentRailRow
              key={a.id}
              agent={a}
              selected={selected === a.id && !homeOpen}
              unseen={unseen}
              statusLabel={
                a.closedAt
                  ? shell.closed
                  : a.id === selected && compacting
                    ? shell.compacting
                    : unseen
                      ? shell.unseen[unseen]
                      : shell.status[a.status]
              }
              idle={
                !a.closedAt &&
                !(a.id === selected && compacting) &&
                a.status === "idle"
              }
              waitingSince={waited.get(a.id) ?? null}
              compacting={a.id === selected && compacting}
              onSelect={() => openFromList(a.id)}
              onOpenHome={(agentId) => {
                // Its ring (T-43 v10.2): Home, at what it asks in Needs you.
                goHome();
                setHomeJump((last) => ({ projectId: null, agentId, n: (last?.n ?? 0) + 1 }));
              }}
              onOpenTask={(taskId) => window.dispatchEvent(new CustomEvent("yuzuno:open-task-review", { detail: { taskId } }))}
              actions={agentActions}
            />
            );
            };
            // All projects, grouped as Settings chooses; a project's own
            // list, or No grouping, stays one list.
            const groups =
              scope === ALL_PROJECTS && appearance.projectGroups !== "none"
                ? groupAgents(filteredAgents, projects, { unknown: shell.unknownProject, none: shell.noProject })
                : null;
            // Each Project's list in its parts (T-36 S3): leads, the others,
            // its task executors, its archived ones folded. Closed as it was.
            const parts = (agents: Agent[], key: string) =>
              agentScope === "closed" ? agents.map(row) : (
                <ExecutorRail agents={agents} listKey={key} workspaceId={workspaceId} selectedId={homeOpen ? null : selected}
                  searching={!!search.trim()} renderAgent={row}
                  order={appearance.agentOrder === "attention" ? { seen: turnSeen } : undefined} />
              );
            return groups ? (
              <GroupedAgents
                groups={groups}
                style={appearance.projectGroups as Exclude<typeof appearance.projectGroups, "none">}
                workspaceId={workspaceId}
                selectedId={homeOpen ? null : selected}
                searching={!!search.trim()}
                renderAgent={row}
                renderList={parts}
                onCreate={(projectId) => {
                  setCreateProject(projectId ?? "");
                  setCreateOpen(true);
                }}
              />
            ) : (
              parts(filteredAgents, scope)
            );
          })()}
          {!loading && filteredAgents.length === 0 && !searchLink && (
            <div className="rail-empty">
              {search
                ? shell.noMatch
                : agentScope === "closed"
                  ? shell.closedEmpty
                  : shell.empty}
            </div>
          )}
          {/* Last in the list, so it scrolls with the agents. */}
          <button className="add-agent" onClick={() => setCreateOpen(true)}>
            <Plus size={15} />
            {shell.newAgent}<span>{shortcutModifier} {boundKeys.newAgent}</span>
          </button>
        </nav>
        {outsidePending > 0 && (
          <button
            className="elsewhere-notice"
            onClick={goHome}
            title={shell.elsewhereTitle}
          >
            <Bell size={14} />
            <span>{shell.elsewhere(outsidePending)}</span>
            <ChevronRight size={13} />
          </button>
        )}
        <ProjectSwitcher
          workspaceName={shell.workspace}
          reachable={core.healthy}
          reachability={core.description}
          scope={scope}
          projects={projects}
          agents={workspace?.agents || []}
          onScope={changeScope}
          onNewProject={() => openSettingsPage("projects", "new")}
          onManage={() => {
            // The project in scope, else the first, as the manager always opened (YN-8).
            openSettingsPage("projects", scope.startsWith("project:") ? scope.slice("project:".length) : undefined);
          }}
          onMachines={() => openSettingsPage("machines")}
          onOpenChange={setScopeMenuOpen}
          readOnly={previewMode}
        />
        </>
        )}
      </aside>

      <ClarificationHost.Provider value={{ workspaceId, detail: currentDetail, outgoing, pendingInputs, readOnly: previewMode, submit: submitMessage, refresh }}>
      {/* On a phone the list or the context panel covers it, still mounted. */}
      <main className="main-panel" ref={mainBox} inert={listShown || (phone && inspectorShown) ? true : undefined}>
        {coreBanner.shown && (
          <div className={`banner-reveal${coreBanner.leaving ? " is-leaving" : ""}`}>
            <div className="banner-reveal-clip">
              <div className="connection-banner core-connection-banner" role={coreSaid.current.error ? "alert" : "status"} lang={langTag(language)}>
                <WifiOff size={15} />
                <div>
                  <strong>{coreSaid.current.error ? coreSaid.current.label : coreSaid.current.browser}</strong>
                  <span>
                    {coreSaid.current.error
                      ? coreSaid.current.detail
                      : coreSaid.current.loaded
                        ? shell.lastReadWorked
                        : shell.noneLoaded}
                  </span>
                  {coreSaid.current.error && coreSaid.current.browser && <span>{shell.sentence(coreSaid.current.browser)}</span>}
                  <span>{coreSaid.current.stream}</span>
                </div>
                <button
                  className={`quiet-button${retrying ? " retrying" : ""}`}
                  aria-busy={retrying || undefined}
                  disabled={coreBanner.leaving}
                  onClick={() => {
                    setRetrying(true);
                    refresh();
                  }}
                >
                  <RefreshCw size={13} className={retrying ? "spin" : undefined} />
                  {retrying ? shell.retrying : shell.retry}
                </button>
              </div>
            </div>
          </div>
        )}
        {liveBanner.shown && (
          <div className={`banner-reveal${liveBanner.leaving ? " is-leaving" : ""}`}>
            <div className="banner-reveal-clip">
              <div className="connection-banner core-connection-banner event-connection-banner" role="status" lang={langTag(language)}>
                <RefreshCw size={15} />
                <div>
                  <strong>{shell.liveReconnecting}</strong>
                  <span>{shell.liveReconnectingLine}</span>
                </div>
              </div>
            </div>
          </div>
        )}
        {!workspaceError && workspace?.runtime.error && (
          <div className="connection-banner" role="alert">
            <CircleAlert size={15} />
            <div>
              <strong>{shell.modelsUnavailable}</strong>
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
            jumpTo={homeJump}
            arrival={homeArrival}
            onBackToReply={(link) => openMessageLink(link)}
            report={homeReport}
            visit={homeVisit}
          />
        ) : agent ? (
          <>
            <div className="conversation-header">
              <div className="conversation-title">
                <Avatar agent={agent} />
                <div className="conversation-heading">
                  {/* Whole, on demand: pressing it lets the name wrap, for
                      the reader who has no pointer to hover with. */}
                  <h1 ref={nameRef} title={agent.name} data-open={nameOpen || undefined}>
                    {nameCut || nameOpen ? (
                      <button
                        type="button"
                        className="conversation-name"
                        aria-expanded={nameOpen}
                        onClick={() => setNameOpen((open) => !open)}
                      >
                        {agent.name}
                      </button>
                    ) : (
                      agent.name
                    )}
                  </h1>
                  <span className={`status-label runtime-${agent.status}`}>
                    <span className={`status-dot ${agent.status}`} />
                    {closed
                      ? shell.closed
                      : compacting
                        ? shell.compacting
                        : shell.status[agent.status]}
                  </span>
                  {/* One line for the Jobs, runs and sub-agents this
                      conversation has, where there is room to read it; the
                      dock keeps the detail (T-15). */}
                  <WorkActivityEntry
                    expanded={phone ? phoneDock === "work" : railWork && railOpen}
                    drawer={phone}
                    onOpen={openWorkView}
                  />
                  {/* And beside it, the way into where the reader is: the
                      rail takes the index where there is a rail, and a phone
                      opens the drawer it already has. One entry either way,
                      rather than one per shape (T-15). */}
                  <button
                    type="button"
                    className="conversation-index-entry"
                    aria-expanded={phone ? phoneDock === "turns" : railIndex && railOpen}
                    aria-label={shell.readingIndex}
                    title={shell.readingIndex}
                    onClick={openIndexView}
                  >
                    <History size={14} aria-hidden="true" />
                    <span>{readingTurnNumber || logicalTurns.length}/{logicalTurns.length}</span>
                  </button>
                </div>
              </div>
              <div
                className="conversation-actions"
                role="group"
                lang={langTag(language)}
                aria-label={shell.conversationTools}
              >
                <AgentSettings
                  key={`settings-${selected}`}
                  agent={agent}
                  observedPermissionMode={
                    currentDetail?.claudeRuntime?.permissionMode
                  }
                  observedEffort={observedEffort(detail)}
                  observedContextUsage={currentDetail?.contextUsage}
                  disabled={previewMode || closed}
                  onOpenChange={setAgentSettingsOpen}
                  request={modelRequest?.agentId && modelRequest.agentId !== agent.id ? null : modelRequest}
                  onRequestOpened={() => {
                    if (modelRequest?.agentId) setModelRequest(null);
                    setNotice(modelRequest?.section === "context"
                      ? shell.contextOpen
                      : modelRequest?.kind === "permissions"
                        ? shell.permissionsOpen
                        : shell.modelOpen);
                  }}
                  onSaved={() => {
                    refresh();
                    // Only Codex has context settings to apply.
                    setNotice(shell.settingsSaved(agent.harness !== "codex"));
                  }}
                />
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
                  requestActions={requestActions}
                  actionsButton={false}
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
                            ? shell.movedTo(moved.name, projectName(moved.projectId, projects))
                            : shell.leftProject(moved.name),
                        );
                        refresh();
                      }}
                    />
                  }
                />
                <AgentActionsMenu agent={agent} handlers={agentActions} className="conversation-action" label={shell.conversationActions}
                  missingTurns={!!currentDetail?.codexHandoff?.missingTurns} />
              </div>
            </div>
            {!closed && (
              <RemoteControls
                agent={agent}
                disabled={previewMode}
                onReconnected={refresh}
              />
            )}
            {agent.kind === "executor" && (
              <ExecutorPaneTabs tab={overviewShown ? "overview" : "conversation"} onChoose={chooseExecutorTab} />
            )}
            <div
              ref={conversationBody}
              className="conversation-body"
              {...(agent.kind === "executor"
                ? { id: "executor-conversation", role: "tabpanel", "aria-labelledby": "executor-tab-conversation" }
                : {})}
              // Kept, not unmounted, behind an executor's Overview: its
              // reading place, drafts and live follow carry on.
              hidden={overviewShown}
              // Back to latest floats here: on a desktop the pane ends above
              // it while it shows (turn-dock.css, YN-19).
              data-latest={pillShown ? "shown" : undefined}
              data-phone-dock={phone && dockMotion.shown ? dockMotion.shown : undefined}
              data-phone-dock-way={phone && dockMotion.way ? dockMotion.way : undefined}
              onAnimationEnd={(event) => {
                if (event.animationName === "phone-dock-in" || event.animationName === "phone-dock-out") dockMotion.end();
              }}
            >
              {/* Over the conversation's top, not above it: one that appears moves no text (T-19 SH:C08, CV:CW-11). */}
              <ConversationStrips>
                {/* Over this browser's own place too, not over a link or a source being read. */}
                {readingOffer?.agentId === selected && (!catchupSource || (catchupSource.restore !== undefined && catchupSource.progress === undefined)) && (
                  <div className="source-navigation reading-offer" role="status" lang={langTag(language)}>
                    <span>
                      {shell.continueReading(readingOffer.handoff.label === "desktop" ? "desktop" : "browser", ageText(readingOffer.handoff.ageSeconds, language === "zh-Hans"))}
                    </span>
                    <button className="secondary-button" onClick={continueReading}>{shell.continue}</button>
                    <button className="quiet-button" onClick={dismissReading}>{shell.notNow}</button>
                  </div>
                )}
                {/* One reading bar, and one way back to the latest in it:
                    a source being read, or the place left off. The floating
                    button stands in only when no bar is showing, so two never
                    appear at once (T-15). */}
                {readingBar && (
                  <div className="source-navigation" lang={langTag(language)}>
                    {/* The way back to the latest, always: a reader who is
                        not at the end needs it whatever brought them here,
                        and the floating button is suppressed while this bar
                        shows. Going back to Home is a different destination,
                        so it stands beside this one rather than in its place.
                        It used to replace it, and `sourceOrigin` starts at
                        "home", so a source read from anywhere but the rail
                        offered no way to the latest at all — the window's own
                        link having gone when this bar became the one entry
                        (#459 R3, P2). */}
                    <button className="quiet-button" onClick={backToLatest}>
                      <ArrowLeft size={13} />
                      {shell.backLatest}
                    </button>
                    {source && sourceOrigin === "home" && (
                      <button className="inline-link source-navigation-home" onClick={goHome}>
                        {shell.backHome}
                      </button>
                    )}
                    <span role="status">
                      {source && (sourceNotice?.(shell) || (source.progress !== undefined ? (source.where ? shell.readingIn(source.where) : source.title)
                        : source.restore !== undefined ? shell.leftOff
                        : source.link ? shell.linked : shell.original))}
                    </span>
                  </div>
                )}
              </ConversationStrips>
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
                ref={attachScroll}
                data-agent-id={selected}
                onWheel={(e) => {
                  if (!ownEvent(e)) return;
                  if (e.deltaY < 0) {
                    readerWay.current = "up";
                    stopLatestPin();
                    live.pinWindow();
                    stickToBottom.current = false;
                  }
                  if (e.deltaY > 0) {
                    readerWay.current = "down";
                    readerScrollIntent();
                  }
                }}
                onTouchStart={(e) => {
                  if (!ownEvent(e)) return;
                  touch.current = { from: scroll.current?.scrollTop ?? 0, panned: false, y: e.touches[0]?.clientY };
                }}
                // Which way a finger moves the conversation; one moving it
                // back up ends Back to latest's pin, as a wheel up does.
                onTouchMove={(e) => {
                  const now = touch.current, y = e.touches[0]?.clientY;
                  if (!ownEvent(e) || !now || y === undefined) return;
                  if (now.y !== undefined && Math.abs(y - now.y) >= 2) {
                    readerWay.current = y < now.y ? "down" : "up";
                    if (y > now.y) stopLatestPin();
                  }
                  now.y = y;
                }}
                // The browser's pan: noted, never taken for a cancelled touch.
                onPointerCancel={(e) => {
                  if (ownEvent(e) && e.pointerType === "touch" && touch.current) touch.current.panned = true;
                }}
                // A touch the system took away ends nothing the reader did.
                onTouchCancel={(e) => {
                  if (ownEvent(e)) touch.current = null;
                }}
                // A tap on a disclosure opens or closes it (its click hands the
                // conversation to the reader); it is not the reader going to the
                // end. A pan is, wherever it began.
                onTouchEnd={(e) => {
                  if (!ownEvent(e)) return;
                  const began = touch.current;
                  touch.current = null;
                  const scrolled = !began || began.panned || Math.abs((scroll.current?.scrollTop ?? began.from) - began.from) >= 1;
                  if (scrolled || !(e.target as Element).closest?.("summary")) readerScrollIntent();
                }}
                onKeyDownCapture={(e) => {
                  if (!ownEvent(e)) return;
                  if (
                    e.target instanceof HTMLElement &&
                    e.target.closest(
                      "input, textarea, select, [contenteditable=true]",
                    )
                  )
                    return;
                  // Space on a disclosure opens or closes it rather than scrolling.
                  if (["End", "PageDown", "ArrowDown"].includes(e.key) ||
                    (e.key === " " && !(e.target as Element).closest?.("summary"))) {
                    readerWay.current = "down";
                    readerScrollIntent();
                  }
                  if (["Home", "PageUp", "ArrowUp"].includes(e.key)) {
                    readerWay.current = "up";
                    stopLatestPin();
                    live.pinWindow();
                    stickToBottom.current = false;
                  }
                }}
                onClickCapture={(e) => {
                  // The reader opens or closes a disclosure (by pointer, key or
                  // touch, which all click it): they take over from following,
                  // as a wheel up or Home does, so nothing moves what they
                  // clicked; their window is kept as it is, and where they are
                  // reading is noted, as a scroll would note it, so the
                  // conversation reopens there rather than at the end (T-19).
                  // Only a disclosure of the conversation itself (see ownEvent).
                  if (!ownEvent(e)) return;
                  if ((e.target as Element).closest?.("summary")) {
                    live.pinWindow();
                    stickToBottom.current = false;
                    noteReading(false);
                  }
                }}
                onPointerDown={(e) => {
                  // Native scrollbar events target the scroll container itself.
                  // Clicking a message or a source link must not leave history mode.
                  if (e.target === e.currentTarget) {
                    draggingScrollbar.current = true;
                    stopLatestPin();
                  }
                }}
                onScroll={() => {
                  const el = scroll.current;
                  if (el) {
                    const moved = el.scrollTop - lastTop.current;
                    lastTop.current = el.scrollTop;
                    // Back to latest's own scrolling on its way to the end
                    // says nothing about the reader (pinLatest), whose place
                    // is the latest from the press on: noted so, should they
                    // leave before it ends.
                    if (latestPin.current) {
                      noteReading(true);
                      return;
                    }
                    if (draggingScrollbar.current && Math.abs(moved) >= 1) readerWay.current = moved > 0 ? "down" : "up";
                    // Still scrolling while a page is on its way: the place
                    // to hold is where the reader is now (pageHold).
                    const shown = currentDetail?.conversation;
                    if (pageTarget && shown && shown.start === pageTarget.start && shown.end === pageTarget.end) {
                      const now = readerAnchor();
                      if (now) pageHold.current = now;
                    }
                    if (
                      draggingScrollbar.current &&
                      el.scrollHeight - el.scrollTop - el.clientHeight < 8
                    ) {
                      setHistoryReading(false);
                      searchReading.current = false;
                    }
                    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
                    const bottom = gap < 72;
                    if (!bottom && stickToBottom.current) live.pinWindow();
                    const elsewhere = searchReading.current || !!currentDetail?.conversation?.hasAfter;
                    const latest = bottom && !elsewhere;
                    setAtBottomState(latest);
                    setLatestAway((away) => (elsewhere || gap >= 96 ? true : gap < 48 ? false : away));
                    stickToBottom.current = latest;
                    noteReading(latest);
                    autoPage();
                  }
                }}
              >
                <div className="conversation-inner" ref={followGrowth}>
                  <InputReading.Provider value={readingBy === "inputs" ? reportInput : null}>
                  {/* OpenCode's revert, held for the Agent, not for the turn it removes (T-10). */}
                  <OpenCodeRevertHost workspaceId={previewMode ? "" : workspaceId} agent={agent} onDraft={previewMode || closed ? undefined : rewindDraft}>
                  {/* OpenCode's fork into a new Agent, also held for the Agent (T-10 Fork). */}
                  <OpenCodeForkHost workspaceId={previewMode ? "" : workspaceId} agent={agent} onForked={openForked}>
                  <ConversationWindow key={selected} scroll={scroll} follow={stickToBottom} hold={heldPlace}
                    target={sourceJump && catchupSource?.turnId ? { turnId: catchupSource.turnId, itemId: catchupSource.itemId }
                      : jumpHere ? { turnId: jumpHere, itemId: jumpItem.current ?? undefined } : pageTarget}>
                  {(currentDetail?.conversation || currentDetail?.history) && (() => {
                    // One way to earlier messages (T-6): the saved window
                    // before the shown one while there is one, then the
                    // session's own earlier turns where the saved
                    // conversation starts, each by its own handler.
                    const saved = !!currentDetail.conversation?.hasBefore;
                    const native = !!currentDetail.history?.hasMore && nativeHistoryHere;
                    return <HistoryEntry
                      more={saved || native}
                      loading={saved ? savedPages.loading || (windowPage?.direction === "before" && !windowPage.failed) : sessionHistory.loading}
                      busy={live.windowLoading || savedPages.loading || sessionHistory.loading}
                      error={savedPages.error || sessionHistory.error || ""}
                      added={sessionHistory.added}
                      beginning={!saved && !currentDetail.history?.hasMore}
                      session={!!currentDetail.history}
                      unchecked={native}
                      onLoad={saved ? () => changeHistoryPage("before") : loadEarlierTurns} />;
                  })()}
                  {detailError && (
                    <p role="alert" className="inline-error">
                      {detailError}
                    </p>
                  )}
                  {pageSpace?.before && currentDetail?.conversation?.hasBefore &&
                    <div ref={beforeSpace} aria-hidden="true" style={{ height: scroll.current?.clientHeight || 0 }} />}
                  {!currentDetail && !detailError ? (
                    <div className="loading-state">
                      <LoaderCircle size={18} className="spin" />
                      Opening conversation…
                    </div>
                  ) : currentDetail?.turns.length ? (
                    <ConversationRows id="turns" items={currentDetail.turns} itemKey={turn => turn.id}
                      estimate={turn => Math.max(180, turn.items.length * 65)}
                      onReading={turn => setReadingTurn(turn.id)}
                      targetKey={sourceJump ? catchupSource?.turnId : jumpHere || pageTarget?.turnId || undefined}>
                    {(turn, i) => (
                      <LiveTurn
                        key={turn.id}
                        turn={turn}
                        index={turn._yuzunoSlice?.index ?? i}
                        loadedNumbering={!!currentDetail.history}
                        isLatestAgentTurn={turn.id === latestAgentTurnId}
                        timeMarks={timeMarks}
                        time={time}
                        backgroundShells={currentDetail.backgroundShells}
                        inputNumbers={inputNumbers}
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
                  {/* Where the loaded window ends, when newer messages follow:
                      they load as the reader nears it, so there is no link
                      here, only a quiet line while they load and, when they
                      could not be read, why and a way to try again (YN-19).
                      Back to latest is the floating button's (T-15). */}
                  {historyWindow && newerPage && <div className="conversation-history-window" data-state={newerPage}>
                    {newerPage === "loading" ? (
                      <p role="status" className="conversation-history-loading">
                        <LoaderCircle size={13} className="spin" aria-hidden="true" />
                        {shell.newerLoading}
                      </p>
                    ) : (
                      <>
                        <p role="alert" className="history-entry-error">
                          {shell.newerFailed} <span className="history-entry-reason">{detailError}</span>
                        </p>
                        <button type="button" className="secondary-button" disabled={live.windowLoading}
                          onClick={() => changeHistoryPage("after")}>
                          {shell.tryAgain}
                        </button>
                      </>
                    )}
                  </div>}
                  <OutgoingMessages
                    agentId={agent.id}
                    messages={outgoing}
                    detail={currentDetail}
                    scope={turnScope ?? ""}
                    onShown={previewsShown}
                  />
                  {!overviewShown && pending.map((request) => (
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
                  {pageSpace?.after && currentDetail?.conversation?.hasAfter &&
                    <div ref={afterSpace} aria-hidden="true" style={{ height: scroll.current?.clientHeight || 0 }} />}
                  </ConversationWindow>
                  </OpenCodeForkHost>
                  </OpenCodeRevertHost>
                  </InputReading.Provider>
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
                key={`${selected}:${readingBy}`}
                turns={readingBy === "inputs" ? inputDockEntries : logicalTurns}
                loadedNumbering={!!currentDetail?.history}
                scrollRef={scroll}
                readingTurnId={readingBy === "inputs" ? readingInputId : readingTurn}
                onInteractionChange={setTurnDockEngaged}
                onNavigate={readingBy === "inputs" ? navigateToInput : navigateToTurn}
                by={canReadByInputs ? { value: readingBy, onChange: setReadBy } : undefined}
                inputs={readingBy === "inputs" ? { offset: conversationInputs.total - inputDockEntries.length,
                  total: conversationInputs.total, hasBefore: conversationInputs.hasBefore,
                  loading: conversationInputs.loading, onEarlier: conversationInputs.loadEarlier } : undefined}
                atLatest={atBottom && !historyReading}
                onLatest={backToLatest}
                // A phone presses this dock in its drawer, so there it keeps
                // its larger rows. Everywhere else a finger reads it and
                // chooses from the index instead, so it is a scale and its
                // rows are the smaller ones again (T-15, V8).
                touch={phone}
              />
              {phone && (
                <PhoneDockButtons
                  open={phoneDock}
                  onOpen={dockMotion.choose}
                  leaving={dockMotion.leaving}
                  turn={readingBy === "inputs" ? readingInputNumber : readingTurnNumber}
                  turns={readingBy === "inputs" ? conversationInputs.total : logicalTurns.length}
                  inputs={readingBy === "inputs"}
                />
              )}
              {pillShown && (
                <button className="jump-latest" ref={latestButton} onClick={backToLatest} lang={langTag(language)}>
                  <ArrowDown size={13} />
                  {shell.backLatest}
                </button>
              )}
              {latestLeaving > 0 && (
                <div key={latestLeaving} className="jump-latest-leaving" aria-hidden="true" inert ref={latestLeavingCopy}
                  onAnimationEnd={() => setLatestLeaving(0)} lang={langTag(language)}>
                  <ArrowDown size={13} />
                  {shell.backLatest}
                </div>
              )}
            </div>
            {overviewShown && (
              <ExecutorOverview
                agent={agent}
                revision={`${boardRevision}:${jobsRevision}:${mergeQueueRevision}`}
                // The same cards as in its Conversation, shown here instead while this tab is.
                requests={pending.length ? pending.map((request) => (
                  <PendingCard
                    key={request.id}
                    request={request}
                    refresh={refresh}
                    disabled={previewMode || closed}
                    onViewChanges={() => showProposedChanges(request)}
                    permissionMode={currentDetail?.claudeRuntime?.permissionMode}
                    draftScope={requestDraftScope}
                  />
                )) : null}
                onOpenTask={(taskId) => window.dispatchEvent(new CustomEvent("yuzuno:open-task-review", { detail: { taskId } }))}
              />
            )}
            <PendingQuestions key={`${workspaceId}:${selected}`} ref={questionPanel} agentId={selected} workspaceId={workspaceId}
              detail={detail?.agent.id === selected ? detail : null} shown={currentDetail} known={coreQuestions}
              outgoing={outgoing} pendingInputs={pendingInputs} disabled={closed || previewMode || isClaude} live={dockLive}
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
                      {agent.releasedAt
                        ? "This executor was released and stays closed. Dispatch its task again for new work."
                        : "Reopen this agent to continue from the same session."}
                    </p>
                  </div>
                  {!agent.releasedAt && <button
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
                  </button>}
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
              // An executor's Overview has no composer: its Conversation does (the T-43 preview).
              <div className="composer-area" hidden={overviewShown}>
                {/* What the conversation asks of you before you write; on a short
                    phone screen it gives way to the composer (T-170). */}
                <div className="composer-notices">
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
                  {/* Each notice its own key, per Agent so it starts anew in another's
                      conversation: siblings sharing one key are duplicated by React, a copy left in
                      the page on every render (YN-1). */}
                  {currentDetail && recovery && (
                    <RecoveryNotice
                      key={`recovery:${selected}`}
                      detail={currentDetail}
                      disabled={closed || !!workspaceError}
                      hasDraft={hasDraft}
                      onRecovered={refresh}
                      onEndMissing={() => setEndMissingFor(currentDetail.agent.id)}
                    />
                  )}
                  {currentDetail?.agent.harness === "claude" && !currentDetail.agent.remote && (
                    <QuotaResumeNotice key={`quota:${selected}`} detail={currentDetail} disabled={closed || !!workspaceError} />
                  )}
                  {unconfirmedMessage && (
                    <div className="message-delivery-notice" role="status" lang={langTag(language)}>
                      {shell.unconfirmedDelivery}
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
                        {shell.checkDelivery}
                      </button>
                    </div>
                  )}
                  {actionError && (
                    <div role="alert" className="inline-error" ref={actionErrorBox}>
                      <CircleAlert size={14} />
                      {actionError}
                      <button
                        className="icon-button"
                        aria-label={shell.dismissError}
                        onClick={() => setActionError("")}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  )}
                </div>
                <form
                  ref={setComposerBox}
                  className={`composer ${busy ? "is-working" : ""}`}
                  data-shape={composerShape}
                  data-expand={offerExpand ? (expanded ? "open" : "offered") : undefined}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    // Images dropped on the box go with the draft, as pasted
                    // ones do; the editor takes those dropped on its text.
                    if (e.defaultPrevented || !e.dataTransfer.types.includes("Files")) return;
                    e.preventDefault();
                    if (!previewMode && !draftBlocked) void imageUploads.add(clipboardImages(e.dataTransfer));
                  }}
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
                    label={shell.message(agent.name)}
                    placeholder={placeholderShort ? shortPlaceholder : composerPlaceholder}
                    draft={draft}
                    readOnly={previewMode || draftBlocked}
                    slashCommands={previewMode ? false : isClaude ? "claude" : isOpenCode ? "opencode" : "codex"}
                    sendKey={sendKey}
                    onChange={next => setDraft(selected, next)}
                    onSkill={skill => skill.path && setDraft(selected, current => {
                      const others = (current.skills || []).filter(s => s.agentId === selected && !(s.name === skill.name && s.path === skill.path));
                      return { ...current, skills: [...others, { agentId: selected, name: skill.name, path: skill.path!, scope: skill.scope || "" }].slice(-MAX_DRAFT_SKILLS) };
                    })}
                    onImages={files => void imageUploads.add(files)}
                    onSubmit={() => void send()}
                  />
                  {offerExpand && (
                    <button
                      type="button"
                      className="composer-tool composer-expand"
                      aria-label={expanded ? shell.collapseDraft : shell.expandDraft}
                      title={expanded ? shell.collapseDraft : shell.expandDraft}
                      // A click leaves the caret where it was in the text.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setExpandedFor(expanded ? null : selected)}
                    >
                      {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                    </button>
                  )}
                  <ImageAttachments images={draft.images || []} description={imageNote ?? undefined} onRemove={previewMode || draftBlocked ? undefined : id => setDraft(selected, current => ({ ...current, images: current.images?.filter(image => image.id !== id) }))}
                    annotateThumbnails onAnnotate={previewMode || draftBlocked ? undefined : image => markUpDraftImage(image)} />
                  {/* Every chosen skill shows, so one that is not this Agent's can be removed. */}
                  <SkillChips skills={draft.skills || []}
                    onRemove={previewMode || draftBlocked ? undefined : skill => setDraft(selected, current => ({ ...current,
                      skills: current.skills?.filter(s => !(s.name === skill.name && s.path === skill.path)) }))} />
                  {imageUploads.error && <p className="inline-error" role="alert">{imageUploads.error}</p>}
                  {draftError && <p className="inline-error" role="alert">{draftError}</p>}
                  {draftBlocked && !previewMode && <DraftRecovery key={selected} onDiscard={() => discardSavedDraft(selected)} />}
                  <div className="composer-bottom" lang={langTag(language)}>
                    <div className="composer-tools">
                      <input ref={imagePicker} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden aria-label={shell.chooseImages} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; void imageUploads.add(files); }} />
                      <input ref={pointFixPicker} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label={shell.chooseToMark} onChange={event => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) openPointFix({ name: file.name || "Screenshot", ownerId: selected, provenance: `an image you chose (${file.name || "pasted"})`, load: async () => file });
                      }} />
                      {/* Agents that cannot take images keep the entry, quieted,
                          so it can say why. */}
                      <ComposerAddMenu
                        label={shell.addMenu}
                        title={shell.addMenuTitle}
                        menuLabel={shell.addMenuLabel}
                        disabled={previewMode}
                        busy={imageUploads.busy}
                        items={[
                          {
                            key: "images",
                            label: imageUploads.busy ? shell.savingImages : shell.addImages,
                            icon: <ImagePlus size={16} />,
                            title: imageSupported ? shell.addImagesTitle(imageNote) : shell.imagesOnly,
                            note: imageSupported ? undefined : shell.imagesOnly,
                            unavailable: !imageSupported,
                            disabled: draftBlocked || imageUploads.busy,
                            onSelect: () => imagePicker.current?.click(),
                          },
                          {
                            key: "markUp",
                            label: shell.markUp,
                            icon: <SquareDashedMousePointer size={16} />,
                            title: shell.markUpTitle,
                            onSelect: () => pointFixPicker.current?.click(),
                          },
                          {
                            key: "result",
                            label: shell.askResult,
                            icon: <Shapes size={16} />,
                            title: shell.askResultTitle,
                            onSelect: (plus) => {
                              resultRequestFrom.current = plus;
                              setResultRequestFor(selected);
                            },
                          },
                        ]}
                      />
                      {!previewMode && (
                        <ResultRequest key={selected} open={resultRequestFor === selected}
                          onOpenChange={open => setResultRequestFor(open ? selected : null)} onDraft={appendToDraft}
                          returnFocus={() => resultRequestFrom.current?.focus()} />
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
                          {!returnSends(sendKey, touchKeyboard()) ? (
                            <>
                              <kbd>↵</kbd> {shell.newLine}{" "}
                              <kbd>{shortcutModifier} ↵</kbd> {shell.send}
                            </>
                          ) : (
                            <>
                              <kbd>↵</kbd> {shell.send}{" "}
                              <kbd>⇧ ↵</kbd> {shell.newLine}
                            </>
                          )}
                        </span>
                      )}
                    </span>
                    <div className="composer-send-actions">
                      {/* Codex's Plan mode, beside Send as a mode is in ChatGPT. */}
                      {!previewMode && !isClaude && !isOpenCode && (
                        <CodexPlanChip state={currentDetail?.codexPlan}
                          onOpen={() => setPlanRequest({ agentId: selected, draft: null, nonce: Date.now() })} />
                      )}
                      {busy && (
                        <button
                          type="button"
                          className="interrupt-button"
                          title={shell.interruptTitle}
                          disabled={previewMode || interrupting}
                          onClick={() => void interrupt()}
                        >
                          {interrupting ? (
                            <LoaderCircle size={13} className="spin" />
                          ) : (
                            <Square size={11} fill="currentColor" />
                          )}
                          {interrupting ? shell.interrupting : shell.interrupt}
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
                        aria-label={sendTurnId ? shell.sendWhileWorking : shell.sendMessage}
                        title={
                          cannotSendWhileWorking || closed
                            ? shell.waitOrInterrupt
                            : holdForRecovery
                              ? recovery === "collaboration"
                                ? shell.reconnectWorkspace
                                : recovery === "missing"
                                  ? shell.endOrCheck
                                  : recovery === "disconnected"
                                    ? shell.reconnectDisconnected
                                    : shell.reconnectLast
                              : sendTurnId && !isClaude
                              ? shell.addInput
                              : shell.sendMessage
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
        ) : !workspace ? (
          // No Workspace was read, so it isn't known to have no Agents; the
          // banner above has the error and Retry.
          <div className="welcome welcome-unread" lang={langTag(language)}>
            <div className="welcome-art">
              <Yuzu size={142} />
              <span className="welcome-ground" />
            </div>
            <h1>{shell.workspaceUnread}</h1>
            <p>{shell.workspaceUnreadDetail}</p>
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
        <aside className="inspector" id="context-panel" ref={inspectorBox} lang={langTag(language)}>
          <PanelResizeHandle side="inspector" size={panelWidths.inspector} />
          <div className="inspector-content">
            <div className="inspector-heading">
              <span ref={inspectorTitle} tabIndex={-1}>{shell.atGlance}</span>
              <button
                className="icon-button"
                aria-label={shell.closePanel}
                onClick={() => (phone ? setPhoneInspector(false) : setInspector(false))}
              >
                <X size={14} />
              </button>
            </div>
            <section className="purpose-section">
              <span className="section-eyebrow">
                <Leaf size={12} />
                {shell.currentWork}
              </span>
              {agent.workSummary ? (
                // What was asked or reported, as written.
                <p lang="">
                  {agent.workSummary.source === "user" && agent.workSummary.requestParts?.length ? (
                    <RequestSummary agentId={agent.id} summary={agent.workSummary} />
                  ) : <button
                    className="inspector-work-source"
                    onClick={() => openRailSource(agent, agent.workSummary!)}
                    title={summaryOrigin(agent.workSummary, language)}
                  >
                    {agent.workSummary.source === "agent" ? shell.agentReport : ""}
                    {agent.workSummary.text}
                  </button>}
                </p>
              ) : (
                <p className="field-hint">{shell.noTask}</p>
              )}
              <div className="purpose-rule" />
              <dl>
                <div>
                  <dt>{shell.workingFolder}</dt>
                  <dd title={agent.cwd}>{workingFolder(agent.cwd)}</dd>
                </div>
                <div>
                  <dt>{shell.harness}</dt>
                  <dd>
                    {agentHarnessName(agent)}
                    {isOpenCode && <>{" "}<small className="harness-experimental">{shell.experimental}</small></>}
                  </dd>
                </div>
                <div>
                  <dt>{shell.location}</dt>
                  <dd>
                    <Monitor size={12} />
                    {agent.remote?.machine.name || shell.coreHost}
                  </dd>
                </div>
                <div>
                  <dt>{shell.session}</dt>
                  <dd title={nativeSession(agent)}>
                    {nativeSession(agent)?.slice(0, 8) || shell.notStarted}
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
            {isClaude && <ClaudeMcpStatus agent={agent} language={language} />}
            {!isClaude && !isOpenCode && !previewMode && <CodexMcpStatus agent={agent} language={language} />}
            <section className="inspector-section">
              <div className="section-title">
                <h2>
                  <Clock3 size={14} />
                  {shell.thisConversation}
                </h2>
              </div>
              <div className="context-stat">
                <span>{shell.turns}</span>
                <strong>{currentDetail?.turns.length || 0}</strong>
              </div>
              <div className="context-stat">
                <span>{shell.unreadUpdates}</span>
                <strong>{agent.unreadCount}</strong>
              </div>
              <div className="context-stat">
                <span>{shell.needsResponse}</span>
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
                      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
                        ? "auto"
                        : "smooth",
                    });
                    stickToBottom.current = true;
                  }}
                >
                  <Bell size={13} />
                  {shell.goPending}
                  <ArrowRight size={13} />
                </button>
              )}
            </section>
            <div className="inspector-note">
              <Yuzu size={43} sleepy />
              <p>
                {shell.storyA}
                <br />
                {shell.storyB}
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
        coreLabel={core.label}
        coreHealthy={core.healthy}
        onMachines={() => openSettingsPage("machines")}
      />
      <WorkspaceUpdatesHost
        enabled={!previewMode}
        open={updatesOpen}
        onOpenChange={setUpdatesOpen}
        openAt={settingsAt}
        onNeedsReloadChange={setUpdatesNeedReload}
        navigation={{ agents: workspace?.agents || [], projects, disabled: previewMode, onNavigate: openSettingsDestination }}
        workspaceId={previewMode ? "" : workspaceId}
        preserveDrafts={() => { if (imageUploads.hasPending()) throw new Error("Wait for images to finish saving before updating."); preserveDrafts(); }}
        pages={{
          // Settings › Projects and › Machines (YN-8). Each request (the rail,
          // a search result) opens the projects page anew, at what it names.
          projects: (open, request) => (
            <ProjectsPage
              key={request?.n ?? 0}
              open={open}
              onOpenChange={(open) => { if (!open) setUpdatesOpen(false); }}
              initialView={request?.sub === "new" ? "new" : "manage"}
              initialProjectId={request?.sub && request.sub !== "new" ? request.sub : null}
              projects={projects}
              usage={workspace?.projectUsage}
              agents={workspace?.agents || []}
              onChanged={refresh}
              onCreated={(project) => setNotice(shell.projectReady(project.name))}
            />
          ),
          machines: (open, request) => (
            <MachinesPage
              key={request?.n ?? 0}
              open={open}
              initialMachineId={request?.sub ?? null}
              initialBlock={request?.block}
              agents={workspace?.agents || []}
              projects={projects}
              revision={machinesRevision}
              onOpenAgent={(id) => {
                setUpdatesOpen(false);
                selectAgent(id);
              }}
            />
          ),
        }}
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
        workspaceId={previewMode ? "" : workspaceId}
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
      {currentDetail?.codexHandoff?.missingTurns && (
        <EndMissingTurnDialog
          key={`end-missing-${currentDetail.agent.id}`}
          detail={currentDetail}
          open={endMissingFor === currentDetail.agent.id}
          onOpenChange={(open) => setEndMissingFor(open ? currentDetail.agent.id : null)}
          onEnded={() => {
            setNotice(shell.endedMissing);
            refresh();
          }}
        />
      )}
      <DisconnectAgentDialog
        agent={workspace?.agents.find((candidate) => candidate.id === disconnectFor) ?? null}
        open={!!disconnectFor}
        onOpenChange={(open) => { if (!open) setDisconnectFor(null); }}
        onDone={(name) => {
          setNotice(shell.disconnected(name));
          refresh();
        }}
      />
      {agent && !isClaude && !isOpenCode && (
        <ForkCodexDialog
          key={`fork-${workspaceId}-${agent.id}`}
          agent={agent}
          workspaceId={previewMode ? "" : workspaceId}
          open={forkOpen}
          onOpenChange={setForkOpen}
          projectLabel={(id) => projectName(id, projects)}
          onForked={(outcome) => {
            const fork = outcome.agent!;
            const sourceId = agent.id;
            markJoined(fork.id);
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
                ? shell.forkClosed(fork.name)
                : outcome.connected
                  ? shell.forkContinuing(fork.name)
                  : shell.forkNotConnected(fork.name, outcome.warnings.join(" ")),
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
        onCreated={(a, source, added) => {
          // A create always makes its Agent; an import says whether it did.
          if (added ?? !source) markJoined(a.id);
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
              ? shell.defaultFolderFailed(a.name, a.projectDefaultError)
              : source === "imported"
                ? shell.imported
                : source === "existing"
                  ? shell.openedSaved(a.name)
                  : shell.created(a.name),
          );
        }}
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
      <ToastStack notice={notice} error={menuError} />
      <HandoffDropStrip />
    </div>
    </WorkActivityProvider>
    </HomeReplyLinks.Provider>
    </MessageLinks.Provider>
    </PointFixOpen.Provider>
    </HandoffContext.Provider>
  );
}
