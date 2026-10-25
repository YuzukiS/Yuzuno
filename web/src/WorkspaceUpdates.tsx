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
import { SettingsCenter, type SettingsNavigation } from "./SettingsCenter";
import { RuntimeSection } from "./RuntimeSection";
import { AboutSection } from "./AboutSection";
import { AppearanceSection } from "./AppearanceSettings";
import { SharedAppearanceSection } from "./SharedAppearance";
import { InputPreferencesSection } from "./InputPreferences";
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
  updateLabels,
  updateStatusFresh,
  updateSteps,
  updateWaitRows,
  type ReleaseSummary,
  type UpdateIntent,
  type UpdateStep,
  type UpdateStatus,
} from "./updates";
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
        throw new Error("Workspace update status is unavailable.");
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

/** The release chosen with one click, shared with other windows. */
function useUpdateIntent() {
  const [intent, setIntent] = useState<UpdateIntent | null>(savedUpdateIntent);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === updateIntentKey || event.key === null)
        setIntent(savedUpdateIntent());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const keep = useCallback((next: UpdateIntent | null) => {
    saveUpdateIntent(next);
    setIntent(next);
  }, []);
  return [intent, keep] as const;
}

/** Only one window posts the next step; the others see it in the shared
 * choice. Without Web Locks (an insecure origin) this window acts alone. */
async function exclusive(work: () => Promise<void>) {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks?.request) return work();
  await locks.request("yuzuno.update-chain", { ifAvailable: true }, async (lock) => {
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
  [intent, keep]: ReturnType<typeof useUpdateIntent>,
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
  const [stopped, setStopped] = useState<{ version: string; reason: string } | null>(null);
  const advance = useCallback(async () => {
    if (acting.current || !status) return;
    acting.current = true;
    let posted = false;
    try {
      await exclusive(async () => {
        // The shared record, which another window may have moved on.
        const chosen = savedUpdateIntent();
        if (!chosen) return keep(null);
        const chain = updateChain(status, chosen, updateStatusFresh(chosen, statusAt));
        if ("watch" in chain) return;
        if (!("next" in chain)) {
          keep(null);
          if ("stop" in chain && chain.stop && !chain.shown)
            setStopped({ version: chosen.version, reason: chain.stop });
          return;
        }
        const step = chain.next;
        // Another window chose this release; it saves its drafts and applies.
        if (step === "apply" && chosen.owner && chosen.owner !== tab) return;
        const stop = (reason: string) => {
          keep(null);
          setStopped({ version: chosen.version, reason });
        };
        posted = true;
        setPosting(true);
        if (step === "apply") {
          try {
            drafts.current();
          } catch (error) {
            return stop(`${errorText(error)} Nothing was applied; your draft is still here.`);
          }
        }
        // The pending step is saved before it is sent, so a reload or another
        // window while it is out can still tell Core's outcome from work never
        // started. Every send counts toward the limit, interrupted ones too.
        const sends = (chosen.asked?.step === step ? chosen.unanswered ?? 0 : 0) + 1;
        if (sends > UNANSWERED_LIMIT)
          return stop("Workspace did not answer. Check the update state, then choose the version again.");
        const asked = { step, at: Date.now(), priorOperationId: status.operation?.id ?? null };
        const pending = { ...chosen, asked, unanswered: sends };
        keep(pending);
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
          if (savedUpdateIntent()?.requestId !== chosen.requestId) return;
          keep({
            ...pending,
            accepted: { step, at: Date.now(), operationId: reply?.operationId },
            unanswered: 0,
            asked: undefined,
          });
        } catch (error) {
          if (savedUpdateIntent()?.requestId !== chosen.requestId) return;
          // Core's refusal ends the chain. A lost answer is asked again, a
          // few times, only when the next status shows Core did not carry
          // the request out (Apply also repeats its request ID).
          if (error instanceof HttpError) return stop(errorText(error));
          if (sends >= UNANSWERED_LIMIT)
            return stop("Workspace did not answer. Check the update state, then choose the version again.");
          // Judge it only from a status read after it gave up.
          keep({ ...pending, asked: { ...asked, at: Date.now() } });
        } finally {
          clearTimeout(timeout);
        }
      });
    } catch (error) {
      setStopped({ version: savedUpdateIntent()?.version ?? "", reason: errorText(error) });
      keep(null);
    } finally {
      acting.current = false;
      if (posted) {
        setPosting(false);
        await refresh();
      }
    }
  }, [status, statusAt, keep, refresh, tab]);
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
      const saved = savedUpdateIntent();
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
      keep({
        releaseId: release.releaseId,
        version: release.version,
        requestId: crypto.randomUUID(),
        from: step,
        owner: tab,
      });
    },
    /** An explicit click here: this window saves its own drafts and applies. */
    continueHere() {
      const saved = savedUpdateIntent();
      if (saved) keep({ ...saved, owner: tab });
    },
    /** Forget the choice; nothing more is posted for it. */
    cancel() {
      keep(null);
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
}: {
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNeedsReloadChange: (needsReload: boolean) => void;
  navigation?: SettingsNavigation;
  preserveDrafts: () => void;
}) {
  const intent = useUpdateIntent();
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
      {...updates}
    />
  );
}

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
}) {
  const [activeEditor, setActiveEditor] = useState<SettingsEditor | null>("updates");
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
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
    setError("");
    try {
      chain.start(release);
    } catch (e) {
      setError(`This window could not save your choice, so nothing started. ${errorText(e)}`);
    }
  }
  async function perform(name: "check" | "cancel" | "cancel-download") {
    if (acting.current) return;
    acting.current = true;
    setAction(name);
    setError("");
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
        if (controller.signal.aborted)
          throw new Error(
            "Request timed out. Check the saved update status before trying again.",
          );
        throw e;
      } finally {
        clearTimeout(timeout);
      }
      await refresh();
    } catch (e) {
      setError(errorText(e));
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
      setError(errorText(e));
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
        aria-label="Release download"
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
      Cancel download
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
      Check for updates
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
      Update to {release.version}
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
        Cancel update
      </button>
    ) : null;
  // What the one click still does from here.
  const oneClick = (from: "published" | "local" | "prepared") =>
    `One click ${
      from === "published"
        ? "downloads and verifies it, prepares it, and switches"
        : from === "local"
          ? "prepares it and switches"
          : "switches"
    } once your agents finish their current turns. Conversations and drafts stay.`;
  const notes = (text?: string) =>
    text ? (
      <details className="updates-notes">
        <summary>
          <ChevronRight size={12} aria-hidden="true" />
          What’s new
        </summary>
        <p className="updates-release-notes">{text}</p>
      </details>
    ) : null;
  const card = {
    loading: {
      tone: "quiet",
      Icon: LoaderCircle,
      title: "Checking your version…",
      body: null,
      act: null,
    },
    unmanaged: {
      tone: "quiet",
      Icon: CircleAlert,
      title: "Updates are off for this Core",
      body: (
        <p className="update-card-line">
          {status?.reason ||
            "This Core uses a development checkout. Install a managed release to enable updates here."}
        </p>
      ),
      act: checkButton,
    },
    running: {
      tone: "busy",
      Icon: LoaderCircle,
      title: `Updating to ${targetVersion ?? "a new version"}`,
      body: (
        <>
          <p className="update-card-line">
            {step === "download"
              ? source?.phase === "checking"
                ? "Checking signed releases…"
                : "Downloading the signed package. You can close Settings; the update keeps going."
              : step === "verify"
                ? source && sourceLabels[source.phase]
                : step === "prepare"
                  ? "Checking the complete release and making room. Your workspace is still available."
                  : step === "wait"
                    ? waiting
                      ? "Waiting for your agents. Active agents are asked to save progress and finish their current turn. Long tools may need more time; delivery does not mean paused."
                      : chain.elsewhere
                        ? "Prepared. The window where you chose this update saves its drafts, then switches once your agents finish their current turns."
                        // Until Core reports the wait, it has not begun.
                        : "Saving your drafts and asking Workspace to switch once your agents finish their current turns…"
                    : operation?.phase === "restoring"
                      ? `Returning to the same sessions${operation.totalSessions ? ` · ${operation.recoveredSessions || 0} of ${operation.totalSessions}` : ""}. No previous task is sent again.`
                      : `${operation ? updateLabels[operation.phase] : "Installing"}. This window reconnects by itself; your unfinished draft stays with you.`}
          </p>
          {(step === "download" || step === "verify") && downloadProgress}
          {operation?.deadline && waiting && (
            <p className="update-card-meta updates-deadline">
              <Clock3 size={12} />
              Wait ends at{" "}
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
            Continue in this window
          </button>
        </>
      ) : (
        cancelUpdate
      ),
    },
    reload: {
      tone: "action",
      Icon: RefreshCw,
      title: `Yuzuno ${status?.current.version ?? ""} is installed`,
      body: (
        <p className="update-card-line">
          This window still shows the previous version. Reload to use the new
          one; your drafts are kept.
        </p>
      ),
      act: (
        <button className="primary-button" onClick={reload}>
          <RefreshCw size={15} />
          Reload this window
        </button>
      ),
    },
    prepared: {
      tone: "action",
      Icon: ArrowDownToLine,
      title: `Version ${candidate?.version} is ready`,
      body: (
        <>
          <p className="update-card-line">
            Prepared on this Core. {oneClick("prepared")}
          </p>
          {notes(candidate?.notes)}
        </>
      ),
      act: candidate && updateButton(candidate),
    },
    local: {
      tone: "action",
      Icon: ArrowDownToLine,
      title: `Version ${candidate?.version} is available`,
      body: (
        <>
          <p className="update-card-line">
            {candidate?.source || "Reviewed local release"} ·{" "}
            {updateBytes(candidate?.bytes ?? 0)}. {oneClick("local")}
          </p>
          {notes(candidate?.notes)}
        </>
      ),
      act: candidate && updateButton(candidate),
    },
    published: {
      tone: "action",
      Icon: ArrowDownToLine,
      title: `Version ${offered?.version} is available`,
      body: (
        <>
          <p className="update-card-line">
            {source?.phase === "available"
              ? `Signed release from ${source.repository || "GitHub"}`
              : source && sourceLabels[source.phase]}{" "}
            · {updateBytes(offered?.bytes ?? 0)}
          </p>
          <p className="update-card-meta">
            <ShieldCheck size={13} />
            Publisher signature verified · {offered?.platform}
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
      title: `Yuzuno ${status?.current.version ?? ""} is up to date`,
      body: (
        <p className="update-card-line">
          {source?.phase === "checking"
            ? "Checking signed releases…"
            : source?.configured && source.checkedAt
              ? `Checked ${new Date(source.checkedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
              : "No newer version is waiting."}
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
      title="Settings"
      description="Find a setting, check what it affects and open its editor."
      wide
      className="settings-modal"
    >
      <SettingsCenter
        navigation={navigation}
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
                  <h3 id="settings-updates-title">Workspace service</h3>
                  <p>
                    The Workspace service, Core + Web UI on Linux / WSL,
                    changes only when you choose a version to update to.
                    Checking restarts nothing.
                  </p>
                </div>
                {status && (
                  <span className="settings-current" title="Installed now">
                    {status.current.version}
                  </span>
                )}
              </header>
              <div
                className={`update-card is-${card.tone}`}
                role="group"
                aria-label="Update status"
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
                    <p className="update-card-label">Waiting for</p>
                    <ul
                      className="updates-blockers"
                      aria-label="What the update is waiting for"
                    >
                      {updateWaitRows(status).map((b, i) => (
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
                      <strong>{updateLabels[finished.phase]}</strong>
                      <span>
                        {finished.phase === "complete"
                          ? "Your workspace, conversations and drafts are still here. Agents that yielded stay idle; send a message when you want to continue."
                          : finished.phase === "rolledBack"
                            ? "The previous compatible version is running. Your Workspace data was kept."
                            : finished.phase === "cancelled"
                              ? "Pause requests have expired. Agents that yielded stay idle; send a message when you want to continue."
                              : "The operation is saved. Review the details before trying again."}
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
                      {source.candidate ? " The last verified release is kept." : ""}
                    </p>
                  </div>
                )}
                {connectionError && (
                  <div className="update-card-part">
                    <p className="updates-notice" role="status">
                      <RefreshCw size={15} />
                      {step
                        ? "Reconnecting to Workspace service… Your update and drafts are saved."
                        : `Workspace is unavailable. ${connectionError}`}
                    </p>
                  </div>
                )}
                {error && (
                  <div className="update-card-part">
                    <p className="updates-error" role="alert">
                      {error}
                    </p>
                  </div>
                )}
                {chain.stopped && !step && (
                  <div className="update-card-part">
                    <p className="updates-error" role="alert">
                      The update to {chain.stopped.version} stopped. {chain.stopped.reason}
                    </p>
                  </div>
                )}
                {/* A later version may already be published while one waits here. */}
                {(stage === "local" || stage === "prepared") && offered && (
                  <div className="update-card-part update-card-also">
                    <p className="update-card-meta">
                      Version {offered.version} is also published ·{" "}
                      {source && sourceLabels[source.phase]}
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
                    Version details
                  </summary>
                  <dl>
                    <div>
                      <dt>Installed</dt>
                      <dd>
                        <span className="updates-version-number">{status.current.version}</span>
                        <code title={status.current.releaseId}>{status.current.releaseId}</code>
                        <code>{status.current.gitSha.slice(0, 8)}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Runs as</dt>
                      <dd>Workspace service · Core + Web UI · Linux / WSL</dd>
                    </div>
                    {candidate && (
                      <div>
                        <dt>{prepared ? "Prepared" : "Next version"}</dt>
                        <dd>
                          <span className="updates-version-number">{candidate.version}</span>
                          <code>{candidate.releaseId}</code>
                          <span>
                            {candidate.platform} · API {candidate.protocol} · data{" "}
                            {candidate.schema.writes} · records {candidate.records.writes}
                          </span>
                          <span>{candidate.source || "Reviewed local release"}</span>
                          <code>{candidate.gitSha.slice(0, 8)}</code>
                        </dd>
                      </div>
                    )}
                    {status.managed && (
                      <div>
                        <dt>Update source</dt>
                        <dd>
                          {!source ? (
                            "Local releases only"
                          ) : !source.configured ? (
                            source.reason
                          ) : (
                            <>
                              <span>
                                <Github size={13} /> {source.repository || "Published releases"}
                              </span>
                              <span>
                                {source.checkedAt
                                  ? `Checked ${new Date(source.checkedAt).toLocaleString()}`
                                  : "Uses GitHub CLI on the Core host"}
                              </span>
                            </>
                          )}
                        </dd>
                      </div>
                    )}
                    {status.managed && (
                      <div>
                        <dt>Storage</dt>
                        <dd className="updates-storage">
                          <HardDrive size={13} />
                          {updateBytes(
                            status.storage.releaseBytes + status.storage.backupBytes,
                          )}{" "}
                          on the Core host · {status.storage.retainedReleases} releases kept ·
                          up to {status.storage.keepReleases} retained for recovery
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
          {tab === "drafts" && <DraftExport active={open && visible} agents={navigation?.agents ?? null} />}
          {tab === "storage" && <StorageOverview active={open && visible} updates={status ? { managed: status.managed, storage: status.storage } : null} />}
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
          {tab === "shortcuts" && <ShortcutHelpSection />}
          {tab === "transfer" && <DeviceTransferSection />}
          {tab === "agent-defaults" && <AgentDefaults active={open} />}
          {tab === "review" && <ReviewSettings active={open} />}
          {tab === "home" && <HomePresentationSettings active={open} />}
          {tab === "notifications" && <NotificationSettings />}
          {tab === "backup" && <WorkspaceBackup active={open && visible} />}
          {tab === "remote" && <RemoteAccessSettings active={open && visible} />}
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
  const at = updateSteps.findIndex((s) => s.step === current);
  const reused = updateSteps.findIndex((s) => s.step === from);
  return (
    <ol className="update-steps" aria-label="Update progress">
      {updateSteps.map(({ step, label }, i) => {
        const state =
          i < at ? (i < reused ? "reused" : "done") : i === at ? "current" : "next";
        return (
          <li
            key={step}
            className={`is-${state}`}
            aria-current={state === "current" ? "step" : undefined}
            title={state === "reused" ? "Already done before this update" : undefined}
          >
            <span className="update-step-label">
              <span className="update-step-mark" aria-hidden="true">
                {state === "current" ? (
                  <LoaderCircle size={11} className="updates-spin" />
                ) : i < at ? (
                  <Check size={10} strokeWidth={3} />
                ) : null}
              </span>
              {label}
            </span>
            {state === "reused" && <span className="sr-only">, already done</span>}
            {state === "done" && <span className="sr-only">, done</span>}
          </li>
        );
      })}
    </ol>
  );
}

const sourceLabels: Record<NonNullable<UpdateStatus["releaseSource"]>["phase"], string> = {
  idle: "Check for a published release",
  checking: "Checking signed releases…",
  available: "Signed release available",
  current: "You’re on the latest published version",
  downloading: "Downloading update…",
  verifying: "Verifying the complete package…",
  registering: "Adding the verified update…",
  downloaded: "Download verified — ready to prepare",
  failed: "Release check or download needs attention",
  cancelled: "Download cancelled",
};

export function UpdateBanner({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="updates-banner" onClick={onOpen}>
      <Sparkles size={14} />
      <span>Workspace updated · reload when you’re ready</span>
      <ArrowRight size={14} />
    </button>
  );
}
