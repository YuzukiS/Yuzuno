import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Github,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { SettingsEditor } from "./settings-catalog";
import { SettingsCenter, type SettingsNavigation, type SettingsOpenAt } from "./SettingsCenter";
import { RuntimeSection } from "./RuntimeSection";
import { AboutSection } from "./AboutSection";
import { AppearanceSection } from "./AppearanceSettings";
import { SharedAppearanceSection } from "./SharedAppearance";
import { InputPreferencesSection } from "./InputPreferences";
import { LanguagePreferencesSection } from "./LanguagePreferences";
import { langTag, strings, useLanguage, useStrings } from "./i18n";
import { TimePreferencesSection } from "./TimePreferences";
import { ShortcutHelpSection } from "./ShortcutHelp";
import { DeviceTransferSection } from "./DeviceTransfer";
import { Modal } from "./components";
import { DesktopUpdate } from "./DesktopUpdate";
import { DiagnosticsCopy } from "./RecoveryPage";
import { HistoryComposition } from "./HistoryComposition";
import { DraftExport } from "./DraftExport";
import { StorageOverview } from "./StorageOverview";
import { ReviewSettings } from "./ReviewSettings";
import { AutoContinueDefault } from "./QuotaResume";
import { AgentDefaults } from "./AgentDefaults";
import { HomePresentationSettings } from "./HomePresentationSettings";
import { NotificationSettings } from "./NotificationSettings";
import { WorkspaceBackup } from "./WorkspaceBackup";
import { RemoteAccessSettings } from "./RemoteAccessSettings";
import { api, errorText, HttpError } from "./api";
import {
  loadedRelease,
  releaseTransferActive,
  savedUpdateIntent,
  saveUpdateIntent,
  updateBytes,
  updateChain,
  updateChainStep,
  updateInProgress,
  updateIntentKey,
  updateLabel,
  updateStatusFresh,
  updateStepLabel,
  updateSteps,
  updateStopText,
  updateWaitRows,
  type ReleaseSummary,
  type UpdateIntent,
  type UpdateStep,
  type UpdateStatus,
  type UpdateStop,
} from "./updates";
import { updatesText } from "./updates-text";
import "./updates.css";

export function useWorkspaceUpdates(enabled: boolean, open: boolean) {
  // Each status keeps when its request began, so a step Core accepted is
  // judged only by a status read after that acceptance.
  const [read, setRead] = useState<{ status: UpdateStatus; at: number } | null>(null);
  const status = read?.status ?? null;
  const [connectionError, setConnectionError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const request = ++generation.current;
    const at = Date.now();
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const next = await api<UpdateStatus>("/updates", {
        signal: controller.signal,
      });
      if (!next || typeof next.managed !== "boolean" || !next.current ||
          typeof next.current.releaseId !== "string" ||
          typeof next.current.gitSha !== "string" || !next.storage ||
          !Array.isArray(next.candidates) || !Array.isArray(next.blockers))
        throw new Error(updatesText("en").statusUnavailable);
      if (request !== generation.current) return;
      setRead({ status: next, at });
      setConnectionError("");
    } catch (error) {
      if (request === generation.current) setConnectionError(errorText(error));
    } finally {
      clearTimeout(timeout);
    }
  }, [enabled]);
  useEffect(
    () => () => {
      generation.current++;
      pending.current?.abort();
    },
    [enabled],
  );
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh();
      if (!stopped)
        timer = setTimeout(
          tick,
          open || updateInProgress(status?.operation?.phase) ? 1500 : 10000,
        );
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, open, status?.operation?.phase, refresh]);
  const pageRelease = loadedRelease();
  const needsReload =
    !!pageRelease &&
    !!status?.managed &&
    status.current.releaseId !== pageRelease &&
    !updateInProgress(status.operation?.phase);
  return { status, statusAt: read?.at ?? 0, connectionError, refresh, needsReload };
}

/** The release chosen with one click in this Workspace, shared with its
 * other windows (T-195). `keep` saves a choice in the Workspace it was made
 * in, which a step that finishes after this window moved to another
 * Workspace still names; the window shows only its current Workspace's. */
function useUpdateIntent(workspace: string) {
  const [read, setRead] = useState(() => ({ workspace, intent: savedUpdateIntent(workspace) }));
  const current = useRef(workspace);
  current.current = workspace;
  useEffect(() => {
    setRead({ workspace, intent: savedUpdateIntent(workspace) });
    const changed = (event: StorageEvent) => {
      if (event.key === updateIntentKey(workspace) || event.key === null)
        setRead({ workspace, intent: savedUpdateIntent(workspace) });
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [workspace]);
  const keep = useCallback((owner: string, next: UpdateIntent | null) => {
    saveUpdateIntent(owner, next);
    if (owner === current.current) setRead({ workspace: owner, intent: next });
  }, []);
  return [read.workspace === workspace ? read.intent : null, keep, current] as const;
}

/** Only one window posts the next step for a Workspace; the others see it in
 * the shared choice. Without Web Locks (an insecure origin) this window acts
 * alone. */
async function exclusive(workspace: string, work: () => Promise<void>) {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks?.request) return work();
  await locks.request(`yuzuno.update-chain:${workspace}`, { ifAvailable: true }, async (lock) => {
    if (lock) await work();
  });
}

/** Unanswered requests for one step before the chain stops and asks. */
const UNANSWERED_LIMIT = 3;

/** This tab, kept across its reloads. Apply is sent only from the tab where
 * the release was chosen, after it saved its own drafts and uploads, as the
 * manual Apply did; other windows may download and prepare. */
function thisTab() {
  try {
    const saved = sessionStorage.getItem("yuzuno.tab");
    if (saved) return saved;
    const id = crypto.randomUUID();
    sessionStorage.setItem("yuzuno.tab", id);
    return id;
  } catch {
    return "";
  }
}

/** Carries a chosen release through download, preparation, saving drafts
 * and Apply, following Core's state after each accepted request. It lives
 * with the always-mounted host, so closing Settings does not stop it. */
function useUpdateChain(
  updates: ReturnType<typeof useWorkspaceUpdates>,
  [intent, keep, workspace]: ReturnType<typeof useUpdateIntent>,
  preserveDrafts: () => void,
) {
  const { status, statusAt, refresh } = updates;
  // The host's callback is new on every render; following it here keeps
  // the chain from re-running for renders that change nothing.
  const drafts = useRef(preserveDrafts);
  drafts.current = preserveDrafts;
  const acting = useRef(false);
  const [tab] = useState(thisTab);
  const [posting, setPosting] = useState(false);
  const [stopped, setStopped] = useState<{ version: string; reason: UpdateStop } | null>(null);
  const advance = useCallback(async () => {
    // Each step is one Workspace's: the one this window is in when it starts.
    const ws = workspace.current;
    if (acting.current || !status || !ws) return;
    acting.current = true;
    let posted = false;
    try {
      await exclusive(ws, async () => {
        // The shared record, which another window may have moved on.
        const chosen = savedUpdateIntent(ws);
        if (!chosen) return keep(ws, null);
        const chain = updateChain(status, chosen, updateStatusFresh(chosen, statusAt));
        if ("watch" in chain) return;
        if (!("next" in chain)) {
          keep(ws, null);
          if ("stop" in chain && chain.stop && !chain.shown && workspace.current === ws)
            setStopped({ version: chosen.version, reason: chain.stop });
          return;
        }
        const step = chain.next;
        // Another window chose this release; it saves its drafts and applies.
        if (step === "apply" && chosen.owner && chosen.owner !== tab) return;
        const stop = (reason: UpdateStop) => {
          keep(ws, null);
          if (workspace.current === ws) setStopped({ version: chosen.version, reason });
        };
        posted = true;
        setPosting(true);
        if (step === "apply") {
          try {
            drafts.current();
          } catch (error) {
            return stop({ why: "drafts", error: errorText(error) });
          }
        }
        // The pending step is saved before it is sent, so a reload or another
        // window while it is out can still tell Core's outcome from work never
        // started. Every send counts toward the limit, interrupted ones too.
        const sends = (chosen.asked?.step === step ? chosen.unanswered ?? 0 : 0) + 1;
        if (sends > UNANSWERED_LIMIT)
          return stop({ why: "unanswered" });
        const asked = { step, at: Date.now(), priorOperationId: status.operation?.id ?? null };
        const pending = { ...chosen, asked, unanswered: sends };
        // This window now answers as another Workspace: nothing chosen in
        // the first one is posted to it. The choice stays where it was.
        if (workspace.current !== ws) return;
        keep(ws, pending);
        // Apply verifies every file of the prepared release before it
        // answers; the other steps answer once their work is under way.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), step === "apply" ? 60000 : 10000);
        try {
          const reply = await api<{ operationId?: string }>(`/updates/${step}`, {
            method: "POST",
            body: JSON.stringify(
              step === "apply"
                ? { releaseId: chosen.releaseId, requestId: chosen.requestId }
                : { releaseId: chosen.releaseId },
            ),
            signal: controller.signal,
          });
          // Cancelled or replaced while the request was out: leave it be.
          if (savedUpdateIntent(ws)?.requestId !== chosen.requestId) return;
          keep(ws, {
            ...pending,
            accepted: { step, at: Date.now(), operationId: reply?.operationId },
            unanswered: 0,
            asked: undefined,
          });
        } catch (error) {
          if (savedUpdateIntent(ws)?.requestId !== chosen.requestId) return;
          // Core's refusal ends the chain. A lost answer is asked again, a
          // few times, only when the next status shows Core did not carry
          // the request out (Apply also repeats its request ID).
          if (error instanceof HttpError) return stop({ said: errorText(error) });
          if (sends >= UNANSWERED_LIMIT)
            return stop({ why: "unanswered" });
          // Judge it only from a status read after it gave up.
          keep(ws, { ...pending, asked: { ...asked, at: Date.now() } });
        } finally {
          clearTimeout(timeout);
        }
      });
    } catch (error) {
      if (workspace.current === ws)
        setStopped({ version: savedUpdateIntent(ws)?.version ?? "", reason: { said: errorText(error) } });
      keep(ws, null);
    } finally {
      acting.current = false;
      if (posted) {
        setPosting(false);
        await refresh();
      }
    }
  }, [status, statusAt, keep, refresh, tab, workspace]);
  useEffect(() => {
    if (intent && status) void advance();
  }, [intent, status, advance]);
  const chain = intent && status
    ? updateChain(status, intent, updateStatusFresh(intent, statusAt))
    : null;
  return {
    intent: chain && updateChainStep(chain) ? intent : null,
    step: chain ? updateChainStep(chain) : null,
    /** Ready to apply, but in the window where the release was chosen. */
    elsewhere: !!chain && "next" in chain && chain.next === "apply" &&
      !!intent?.owner && intent.owner !== tab,
    posting,
    stopped,
    /** Throws when the choice cannot be saved; nothing starts then. */
    start(release: ReleaseSummary) {
      if (!status) return;
      // A repeated click, here or in another window, joins the update
      // already under way instead of choosing again.
      const ws = workspace.current;
      const saved = savedUpdateIntent(ws);
      if (saved && updateChainStep(updateChain(status, saved, updateStatusFresh(saved, statusAt))))
        return;
      const first = updateChain(status, release, true);
      const step = updateChainStep(first);
      if (!step) {
        if ("stop" in first && first.stop)
          setStopped({ version: release.version, reason: first.stop });
        return;
      }
      setStopped(null);
      keep(ws, {
        releaseId: release.releaseId,
        version: release.version,
        requestId: crypto.randomUUID(),
        from: step,
        owner: tab,
      });
    },
    /** An explicit click here: this window saves its own drafts and applies. */
    continueHere() {
      const saved = savedUpdateIntent(workspace.current);
      if (saved) keep(workspace.current, { ...saved, owner: tab });
    },
    /** Forget the choice; nothing more is posted for it. */
    cancel() {
      keep(workspace.current, null);
    },
  };
}
export type UpdateChainControl = ReturnType<typeof useUpdateChain>;

/** Keep update polling local to Settings; only a changed reload banner
 * needs to notify the workspace that also renders the conversation. */
export function WorkspaceUpdatesHost({
  enabled,
  open,
  onOpenChange,
  onNeedsReloadChange,
  preserveDrafts,
  navigation,
  workspaceId,
  openAt,
}: {
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNeedsReloadChange: (needsReload: boolean) => void;
  navigation?: SettingsNavigation;
  preserveDrafts: () => void;
  /** Which Workspace's saved drafts the drafts tab reads (T-195). Empty until
   * the Workspace is known, and then none are shown as its own. */
  workspaceId: string;
  /** Opens Settings at this editor (a notification's click, T-196). */
  openAt?: SettingsOpenAt | null;
}) {
  const intent = useUpdateIntent(workspaceId);
  // A chosen update is followed closely even while Settings is closed.
  const updates = useWorkspaceUpdates(enabled, open || !!intent[0]);
  const chain = useUpdateChain(updates, intent, preserveDrafts);
  useEffect(() => {
    onNeedsReloadChange(updates.needsReload);
  }, [updates.needsReload, onNeedsReloadChange]);
  return (
    <WorkspaceUpdates
      open={open}
      onOpenChange={onOpenChange}
      preserveDrafts={preserveDrafts}
      chain={chain}
      navigation={navigation}
      workspaceId={workspaceId}
      openAt={openAt}
      {...updates}
    />
  );
}

// The Settings dialog's own title and close button (T-189).
const settingsDialogText = strings(
  { title: "Settings", description: "Find a setting, check what it affects and open its editor.", close: "Close dialog" },
  { title: "设置", description: "查找一项设置，了解它影响什么，并打开它的编辑页。", close: "关闭对话框" },
);

export function WorkspaceUpdates({
  open,
  onOpenChange,
  status,
  connectionError,
  refresh,
  preserveDrafts,
  needsReload,
  chain,
  navigation,
  workspaceId,
  openAt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: UpdateStatus | null;
  connectionError: string;
  refresh: () => Promise<void>;
  preserveDrafts: () => void;
  needsReload: boolean;
  chain: UpdateChainControl;
  navigation?: SettingsNavigation;
  workspaceId: string;
  openAt?: SettingsOpenAt | null;
}) {
  const language = useLanguage();
  const dialog = settingsDialogText(language);
  const t = updatesText(language);
  const [activeEditor, setActiveEditor] = useState<SettingsEditor | null>("updates");
  const [action, setAction] = useState("");
  // What stopped this editor's own request, worded where it is shown.
  const [error, setError] = useState<{ said: string } | { why: "notSaved"; error: string } | { why: "timedOut" } | null>(null);
  const acting = useRef(false);
  const candidate =
    status?.candidates.find((r) => r.releaseId === status.preparedReleaseId) ||
    status?.candidates[0];
  const operation = status?.operation;
  const active = updateInProgress(operation?.phase);
  const transferring = releaseTransferActive(status?.releaseSource);
  const prepared =
    !!candidate && status?.preparedReleaseId === candidate.releaseId;
  const blocked = !!action || !!connectionError;
  // The step in hand: the chosen release's, or that of an update another
  // window or client began.
  const step: UpdateStep | null =
    chain.step ??
    (!active
      ? null
      : operation?.phase === "preparing"
        ? "prepare"
        : operation?.phase === "waiting"
          ? "wait"
          : "install");
  const targetId = chain.intent?.releaseId ?? operation?.releaseId;
  const targetVersion =
    chain.intent?.version ??
    [...(status?.candidates ?? []), status?.releaseSource?.candidate].find(
      (r) => r?.releaseId === targetId,
    )?.version ??
    targetId;
  function update(release: ReleaseSummary) {
    setError(null);
    try {
      chain.start(release);
    } catch (e) {
      setError({ why: "notSaved", error: errorText(e) });
    }
  }
  async function perform(name: "check" | "cancel" | "cancel-download") {
    if (acting.current) return;
    acting.current = true;
    setAction(name);
    setError(null);
    let timedOut = false;
    try {
      const body = name === "cancel" ? { operationId: operation?.id } : {};
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        await api(`/updates/${name === "cancel-download" ? "download/cancel" : name}`, {
          method: "POST",
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        timedOut = controller.signal.aborted;
        throw e;
      } finally {
        clearTimeout(timeout);
      }
      await refresh();
    } catch (e) {
      setError(timedOut ? { why: "timedOut" } : { said: errorText(e) });
      await refresh();
    } finally {
      acting.current = false;
      setAction("");
    }
  }
  function reload() {
    try {
      preserveDrafts();
      window.location.reload();
    } catch (e) {
      setError({ said: errorText(e) });
    }
  }
  const completed = operation?.phase === "complete";
  const waiting = operation?.phase === "waiting";
  const source = status?.managed ? status.releaseSource : undefined;
  // A signed release on GitHub that is not yet a local package.
  const offered =
    source?.candidate &&
    !status?.candidates.some((c) => c.releaseId === source.candidate?.releaseId)
      ? source.candidate
      : null;
  // A transfer in progress shows its progress and can be cancelled wherever
  // the offered release appears: its own card or the "also published" row.
  const cancellable = source?.phase === "downloading" || source?.phase === "verifying";
  const downloadProgress = source?.phase === "downloading" && (
    <div className="updates-download-progress">
      <progress
        aria-label={t.download}
        max={source.totalBytes || 1}
        value={source.receivedBytes}
      />
      <small>
        {updateBytes(source.receivedBytes)} /{" "}
        {updateBytes(source.totalBytes || 0)}
      </small>
    </div>
  );
  const cancelDownload = (
    <button
      className="quiet-button"
      disabled={blocked || active}
      onClick={() => void perform("cancel-download")}
    >
      <X size={14} />
      {t.cancelDownload}
    </button>
  );
  // Where the Workspace is, as one answer: each stage has one next step.
  const stage = !status
    ? "loading"
    : !status.managed
      ? "unmanaged"
      : step
        ? "running"
        : needsReload
          ? "reload"
          : candidate && prepared
            ? "prepared"
            : candidate
              ? "local"
              : offered
                ? "published"
                : "current";
  // An earlier outcome stays out of the way of the update now in hand.
  const finished =
    operation && !active && !step && operation.phase !== "prepared" ? operation : null;
  const checkButton = (
    <button
      className="quiet-button"
      disabled={blocked || transferring || !status?.managed || !!step}
      onClick={() => void perform("check")}
    >
      <RefreshCw size={14} className={action === "check" ? "updates-spin" : ""} />
      {t.check}
    </button>
  );
  // Opening Settings looks for a newer release, at most every few minutes.
  // Seeing one is not consent: only the button below starts an update.
  useEffect(() => {
    if (!open || activeEditor !== "updates" || !status?.managed || needsReload || step || transferring)
      return;
    const checked = Date.parse(source?.checkedAt || "") || 0;
    if (Date.now() - Math.max(checked, lastAutoCheck) < AUTO_CHECK_MS) return;
    lastAutoCheck = Date.now();
    void perform("check");
    // Only opening Settings, or its first status, asks for a check.
  }, [open, activeEditor, !!status?.managed]);
  /** One click carries this release through every step it still needs. */
  const updateButton = (release: ReleaseSummary, quiet = false) => (
    <button
      className={quiet ? "quiet-button" : "primary-button"}
      disabled={blocked || chain.posting || !!step}
      onClick={() => update(release)}
    >
      <ArrowDownToLine size={quiet ? 14 : 15} />
      {t.updateTo(release.version)}
    </button>
  );
  // What a cancel can still stop: a transfer, the wait for idle agents, or
  // only the rest of the chain once preparation is under way.
  const downloadingTarget =
    (step === "download" || step === "verify") && cancellable &&
    source?.candidate?.releaseId === targetId;
  const cancelUpdate =
    step === "wait" || downloadingTarget || (chain.intent && (step === "download" || step === "prepare")) ? (
      <button
        className="quiet-button"
        // While a step is being sent, cancel only what Core already shows.
        disabled={blocked || (chain.posting && !active)}
        onClick={() => {
          chain.cancel();
          if (waiting) void perform("cancel");
          else if (downloadingTarget) void perform("cancel-download");
        }}
      >
        <X size={14} />
        {t.cancelUpdate}
      </button>
    ) : null;
  // What the one click still does from here.
  const oneClick = t.oneClick;
  const notes = (text?: string) =>
    text ? (
      <details className="updates-notes">
        <summary>
          <ChevronRight size={12} aria-hidden="true" />
          {t.whatsNew}
        </summary>
        <p className="updates-release-notes">{text}</p>
      </details>
    ) : null;
  const card = {
    loading: {
      tone: "quiet",
      Icon: LoaderCircle,
      title: t.loading,
      body: null,
      act: null,
    },
    unmanaged: {
      tone: "quiet",
      Icon: CircleAlert,
      title: t.unmanaged,
      body: (
        <p className="update-card-line">
          {status?.reason || t.development}
        </p>
      ),
      act: checkButton,
    },
    running: {
      tone: "busy",
      Icon: LoaderCircle,
      title: t.updating(targetVersion ?? null),
      body: (
        <>
          <p className="update-card-line">
            {step === "download"
              ? source?.phase === "checking"
                ? t.checkingSigned
                : t.downloading
              : step === "verify"
                ? source && t.sources[source.phase]
                : step === "prepare"
                  ? t.preparing
                  : step === "wait"
                    ? waiting
                      ? t.waiting
                      : chain.elsewhere
                        ? t.elsewhere
                        // Until Core reports the wait, it has not begun.
                        : t.asking
                    : operation?.phase === "restoring"
                      ? t.restoring(operation.recoveredSessions || 0, operation.totalSessions)
                      : t.installing(operation ? updateLabel(operation.phase, language) : null)}
          </p>
          {(step === "download" || step === "verify") && downloadProgress}
          {operation?.deadline && waiting && (
            <p className="update-card-meta updates-deadline">
              <Clock3 size={12} />
              {t.waitEnds}
              {new Date(operation.deadline).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}
        </>
      ),
      act: chain.elsewhere ? (
        <>
          {cancelUpdate}
          <button
            className="quiet-button"
            disabled={blocked || chain.posting}
            onClick={() => chain.continueHere()}
          >
            {t.continueHere}
          </button>
        </>
      ) : (
        cancelUpdate
      ),
    },
    reload: {
      tone: "action",
      Icon: RefreshCw,
      title: t.installed(status?.current.version ?? ""),
      body: <p className="update-card-line">{t.reloadLine}</p>,
      act: (
        <button className="primary-button" onClick={reload}>
          <RefreshCw size={15} />
          {t.reload}
        </button>
      ),
    },
    prepared: {
      tone: "action",
      Icon: ArrowDownToLine,
      title: t.ready(candidate?.version),
      body: (
        <>
          <p className="update-card-line">
            {t.preparedHere}{oneClick("prepared")}
          </p>
          {notes(candidate?.notes)}
        </>
      ),
      act: candidate && updateButton(candidate),
    },
    local: {
      tone: "action",
      Icon: ArrowDownToLine,
      title: t.available(candidate?.version),
      body: (
        <>
          <p className="update-card-line">
            {candidate?.source || t.reviewedLocal}
            {t.sized(updateBytes(candidate?.bytes ?? 0))}{oneClick("local")}
          </p>
          {notes(candidate?.notes)}
        </>
      ),
      act: candidate && updateButton(candidate),
    },
    published: {
      tone: "action",
      Icon: ArrowDownToLine,
      title: t.available(offered?.version),
      body: (
        <>
          <p className="update-card-line">
            {source?.phase === "available"
              ? t.signedFrom(source.repository || "GitHub")
              : source && t.sources[source.phase]}{" "}
            · {updateBytes(offered?.bytes ?? 0)}
          </p>
          <p className="update-card-meta">
            <ShieldCheck size={13} />
            {t.signature}{offered?.platform}
          </p>
          <p className="update-card-line">{oneClick("published")}</p>
          {downloadProgress}
          {notes(offered?.notes)}
        </>
      ),
      // A transfer someone began without choosing to update can still be
      // stopped, or followed through with the same one click.
      act: offered && (
        <>
          {cancellable && cancelDownload}
          {updateButton(offered)}
        </>
      ),
    },
    current: {
      tone: "ok",
      Icon: source?.phase === "checking" ? LoaderCircle : Check,
      title: t.upToDate(status?.current.version ?? ""),
      body: (
        <p className="update-card-line">
          {source?.phase === "checking"
            ? t.checkingSigned
            : source?.configured && source.checkedAt
              ? t.checked(new Date(source.checkedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))
              : t.noneWaiting}
        </p>
      ),
      act: checkButton,
    },
  }[stage];
  const CardIcon = card.Icon;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={dialog.title}
      description={dialog.description}
      wide
      className="settings-modal"
      lang={langTag(language)}
      closeLabel={dialog.close}
    >
      <SettingsCenter
        navigation={navigation}
        openAt={openAt}
        onEditorChange={setActiveEditor}
        attention={stage === "running" || stage === "reload" || stage === "prepared" || stage === "local" || stage === "published"}
        renderEditor={(tab, visible, openEditor) => <>
          {tab === "updates" && (
            <section
              className="settings-section"
              aria-labelledby="settings-updates-title"
            >
              <header className="settings-section-heading">
                <div>
                  <h3 id="settings-updates-title">{t.title}</h3>
                  <p>{t.intro}</p>
                </div>
                {status && (
                  <span className="settings-current" title={t.installedNow}>
                    {status.current.version}
                  </span>
                )}
              </header>
              <div
                className={`update-card is-${card.tone}`}
                role="group"
                aria-label={t.status}
              >
                <div className="update-card-main">
                  <CardIcon
                    size={20}
                    className={`update-card-icon ${CardIcon === LoaderCircle ? "updates-spin" : ""}`}
                    aria-hidden="true"
                  />
                  <div className="update-card-text">
                    <strong className="update-card-title">{card.title}</strong>
                    {card.body}
                  </div>
                  {card.act && <div className="update-card-action updates-actions">{card.act}</div>}
                </div>
                {stage === "running" && step && (
                  <div className="update-card-part">
                    <UpdateSteps current={step} from={chain.intent?.from ?? step} />
                  </div>
                )}
                {!!updateWaitRows(status).length && (active || prepared) && (
                  <div className="update-card-part">
                    <p className="update-card-label">{t.waitingFor}</p>
                    <ul
                      className="updates-blockers"
                      aria-label={t.waitingForLabel}
                    >
                      {updateWaitRows(status, language).map((b, i) => (
                        <li key={`${b.agentId || b.name}-${i}`} className={b.idle ? "is-idle" : undefined}>
                          <span className="updates-blocker-dot" />
                          <strong>{b.name}</strong>
                          <span>{b.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {finished && (
                  <div
                    className={`update-card-part updates-progress is-${finished.phase}`}
                    role="status"
                    aria-live="polite"
                  >
                    <p className="update-card-result">
                      {completed ? <Check size={15} /> : <CircleAlert size={15} />}
                      <strong>{updateLabel(finished.phase, language)}</strong>
                      <span>
                        {finished.phase === "complete" || finished.phase === "rolledBack" || finished.phase === "cancelled"
                          ? t.finished[finished.phase]
                          : t.finished.other}
                      </span>
                    </p>
                    {finished.error && <p className="updates-error">{finished.error}</p>}
                  </div>
                )}
                {active && operation?.error && (
                  <div className="update-card-part">
                    <p className="updates-error">{operation.error}</p>
                  </div>
                )}
                {source?.error && (
                  <div className="update-card-part">
                    <p className="updates-error" role="alert">
                      {source.error}
                      {source.candidate ? t.lastKept : ""}
                    </p>
                  </div>
                )}
                {connectionError && (
                  <div className="update-card-part">
                    <p className="updates-notice" role="status">
                      <RefreshCw size={15} />
                      {step
                        ? t.reconnecting
                        : t.unavailable(connectionError === updatesText("en").statusUnavailable ? t.statusUnavailable : connectionError)}
                    </p>
                  </div>
                )}
                {error && (
                  <div className="update-card-part">
                    <p className="updates-error" role="alert">
                      {"said" in error ? error.said : error.why === "notSaved" ? t.notSaved(error.error) : t.timedOut}
                    </p>
                  </div>
                )}
                {chain.stopped && !step && (
                  <div className="update-card-part">
                    <p className="updates-error" role="alert">
                      {t.stopped(chain.stopped.version, updateStopText(chain.stopped.reason, language))}
                    </p>
                  </div>
                )}
                {/* A later version may already be published while one waits here. */}
                {(stage === "local" || stage === "prepared") && offered && (
                  <div className="update-card-part update-card-also">
                    <p className="update-card-meta">
                      {t.alsoPublished(offered.version)}
                      {source && t.sources[source.phase]}
                    </p>
                    <span className="update-card-also-actions">
                      {cancellable && cancelDownload}
                      {updateButton(offered, true)}
                    </span>
                    {downloadProgress}
                  </div>
                )}
                {(stage === "local" || stage === "prepared" || stage === "published") && (
                  <div className="update-card-part update-card-foot">{checkButton}</div>
                )}
              </div>
              {status && (
                <details className="update-details">
                  <summary>
                    <ChevronRight size={13} aria-hidden="true" />
                    {t.details}
                  </summary>
                  <dl>
                    <div>
                      <dt>{t.installedLabel}</dt>
                      <dd>
                        <span className="updates-version-number">{status.current.version}</span>
                        <code title={status.current.releaseId}>{status.current.releaseId}</code>
                        <code>{status.current.gitSha.slice(0, 8)}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{t.runsAs}</dt>
                      <dd>{t.runsAsValue}</dd>
                    </div>
                    {candidate && (
                      <div>
                        <dt>{prepared ? t.preparedLabel : t.nextVersion}</dt>
                        <dd>
                          <span className="updates-version-number">{candidate.version}</span>
                          <code>{candidate.releaseId}</code>
                          <span>{t.release(candidate.platform, candidate.protocol, candidate.schema.writes, candidate.records.writes)}</span>
                          <span>{candidate.source || t.reviewedLocal}</span>
                          <code>{candidate.gitSha.slice(0, 8)}</code>
                        </dd>
                      </div>
                    )}
                    {status.managed && (
                      <div>
                        <dt>{t.source}</dt>
                        <dd>
                          {!source ? (
                            t.localOnly
                          ) : !source.configured ? (
                            source.reason
                          ) : (
                            <>
                              <span>
                                <Github size={13} /> {source.repository || t.publishedReleases}
                              </span>
                              <span>
                                {source.checkedAt
                                  ? t.checked(new Date(source.checkedAt).toLocaleString())
                                  : t.usesCli}
                              </span>
                            </>
                          )}
                        </dd>
                      </div>
                    )}
                    {status.managed && (
                      <div>
                        <dt>{t.storage}</dt>
                        <dd className="updates-storage">
                          <HardDrive size={13} />
                          {t.stored(
                            updateBytes(status.storage.releaseBytes + status.storage.backupBytes),
                            status.storage.retainedReleases,
                            status.storage.keepReleases,
                          )}
                        </dd>
                      </div>
                    )}
                  </dl>
                </details>
              )}
            </section>
          )}
          {/* The Windows app's own updates sit with the service's, not in a
              category of their own. */}
          {tab === "updates" && <DesktopUpdate preserveDrafts={preserveDrafts} />}
          {tab === "diagnostics" && <DiagnosticsCopy />}
          {tab === "history" && <HistoryComposition />}
          {tab === "drafts" && <DraftExport active={open && visible} agents={navigation?.agents ?? null} workspaceId={workspaceId} />}
          {tab === "storage" && (
            <StorageOverview
              active={open && visible}
              updates={status ? { managed: status.managed, storage: status.storage } : null}
              onOpenTaskWorkspaces={navigation && !navigation.disabled ? (taskId) => navigation.onNavigate({ kind: "taskWorkspaces", taskId }) : undefined}
            />
          )}
          {tab === "runtime" && (
            <RuntimeSection
              active={open && visible}
              onOpenMachines={navigation && !navigation.disabled ? () => navigation.onNavigate({ kind: "machines" }) : undefined}
            />
          )}
          {tab === "appearance" && (
            <>
              <AppearanceSection />
              <SharedAppearanceSection active={open && visible} />
            </>
          )}
          {tab === "input" && <InputPreferencesSection />}
          {tab === "time" && <TimePreferencesSection />}
          {tab === "language" && <LanguagePreferencesSection />}
          {tab === "shortcuts" && <ShortcutHelpSection />}
          {tab === "transfer" && <DeviceTransferSection />}
          {tab === "agent-defaults" && <AgentDefaults active={open} />}
          {tab === "review" && <ReviewSettings active={open} />}
          {tab === "auto-continue" && <AutoContinueDefault active={open} />}
          {tab === "home" && <HomePresentationSettings active={open} />}
          {tab === "notifications" && <NotificationSettings />}
          {tab === "backup" && <WorkspaceBackup active={open && visible} />}
          {tab === "remote" && <RemoteAccessSettings key={workspaceId} active={open && visible} workspaceId={workspaceId} />}
          {tab === "about" && <AboutSection current={status?.current ?? null} openEditor={openEditor} />}
        </>}
      />
    </Modal>
  );
}

// Shared by every mount, so React's double effects and quick reopenings
// don't check twice.
let lastAutoCheck = 0;
const AUTO_CHECK_MS = 5 * 60_000;

/** The steps of the update in hand. Those the release already had when it
 * was chosen are marked as reused rather than redone. */
function UpdateSteps({ current, from }: { current: UpdateStep; from: UpdateStep }) {
  const t = useStrings(updatesText);
  const language = useLanguage();
  const at = updateSteps.indexOf(current);
  const reused = updateSteps.indexOf(from);
  return (
    <ol className="update-steps" aria-label={t.progress}>
      {updateSteps.map((step, i) => {
        const state =
          i < at ? (i < reused ? "reused" : "done") : i === at ? "current" : "next";
        return (
          <li
            key={step}
            className={`is-${state}`}
            aria-current={state === "current" ? "step" : undefined}
            title={state === "reused" ? t.reusedTitle : undefined}
          >
            <span className="update-step-label">
              <span className="update-step-mark" aria-hidden="true">
                {state === "current" ? (
                  <LoaderCircle size={11} className="updates-spin" />
                ) : i < at ? (
                  <Check size={10} strokeWidth={3} />
                ) : null}
              </span>
              {updateStepLabel(step, language)}
            </span>
            {state === "reused" && <span className="sr-only">{t.reusedNote}</span>}
            {state === "done" && <span className="sr-only">{t.doneNote}</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function UpdateBanner({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="updates-banner" onClick={onOpen}>
      <Sparkles size={14} />
      <span>Workspace updated · reload when you’re ready</span>
      <ArrowRight size={14} />
    </button>
  );
}
