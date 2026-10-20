export type ReleaseSummary = {
  releaseId: string;
  version: string;
  gitSha: string;
  builtAt: string;
  platform: string;
  protocol: number;
  schema: { writes: number; readsMin: number; readsMax: number };
  records: { writes: number; readsMin: number; readsMax: number };
  notes: string;
  bytes: number;
  source?: string;
};

export type UpdatePhase =
  | "preparing"
  | "prepared"
  | "waiting"
  | "flushing"
  | "stopping"
  | "starting"
  | "restoring"
  | "complete"
  | "rolledBack"
  | "failed"
  | "cancelled";

export type UpdateOperation = {
  id: string;
  releaseId: string;
  phase: UpdatePhase;
  startedAt: string;
  updatedAt: string;
  deadline?: string;
  error?: string;
  recoveredSessions?: number;
  totalSessions?: number;
};

export type UpdateStatus = {
  managed: boolean;
  reason?: string;
  current: ReleaseSummary;
  candidates: ReleaseSummary[];
  preparedReleaseId?: string;
  operation?: UpdateOperation;
  blockers: { agentId?: string; name: string; reason: string }[];
  waitNotices?: {
    agentId: string; name: string; messageId: string; turnId: string;
    delivery: string; readAt?: string | null; idle: boolean; active: boolean;
  }[];
  acceptingWork: boolean;
  storage: {
    releaseBytes: number;
    backupBytes: number;
    retainedReleases: number;
    keepReleases: number;
  };
  releaseSource?: {
    configured: boolean;
    repository?: string;
    reason?: string;
    phase: "idle" | "checking" | "available" | "current" | "downloading" | "verifying" | "registering" | "downloaded" | "failed" | "cancelled";
    candidate?: ReleaseSummary;
    checkedAt?: string;
    error?: string;
    receivedBytes: number;
    totalBytes?: number;
  };
};

export function updateWaitRows(status: UpdateStatus | null) {
  const rows = (status?.blockers || []).map((b) => ({ ...b, idle: false }));
  for (const notice of status?.waitNotices || []) {
    const existing = rows.find((row) => row.agentId === notice.agentId);
    const delivery = !notice.active ? "Pause request no longer active"
      : notice.readAt ? "Pause request read"
      : notice.delivery === "delivered" ? "Pause request delivered"
      : notice.delivery === "sending" ? "Waiting for native delivery receipt"
      : notice.delivery === "uncertain" ? "Pause delivery uncertain"
      : notice.delivery === "error" ? "Pause request could not be delivered"
      : "Pause request not yet delivered";
    if (existing) {
      existing.reason += ` · ${delivery}`;
    } else {
      rows.push({ agentId: notice.agentId, name: notice.name, idle: notice.idle,
        reason: notice.idle ? "Idle" : `Still waiting · ${delivery}` });
    }
  }
  return rows;
}

export function releaseTransferActive(status?: UpdateStatus["releaseSource"]) {
  return !!status && ["checking", "downloading", "verifying", "registering"].includes(status.phase);
}

export const updateLabels: Record<UpdatePhase, string> = {
  preparing: "Preparing the update",
  prepared: "Ready when you are",
  waiting: "Waiting for your agents",
  flushing: "Saving the last changes",
  stopping: "Switching Workspace service",
  starting: "Starting the new version",
  restoring: "Reconnecting your sessions",
  complete: "Your workspace is up to date",
  rolledBack: "Back on the previous version",
  failed: "The update needs attention",
  cancelled: "Update wait cancelled",
};

export function updateInProgress(phase?: UpdatePhase) {
  return (
    !!phase &&
    [
      "preparing",
      "waiting",
      "flushing",
      "stopping",
      "starting",
      "restoring",
    ].includes(phase)
  );
}

export function updateBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return bytes < 1024 ** 3
    ? `${(bytes / 1024 ** 2).toFixed(0)} MB`
    : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function loadedRelease() {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="yuzuno-release"]')
      ?.content || null
  );
}

/** One update as the card shows it, whichever steps it still needs. */
export type UpdateStep = "download" | "verify" | "prepare" | "wait" | "install";
export const updateSteps: { step: UpdateStep; label: string }[] = [
  { step: "download", label: "Download" },
  { step: "verify", label: "Verify" },
  { step: "prepare", label: "Prepare" },
  { step: "wait", label: "Wait for agents" },
  { step: "install", label: "Install" },
];

/** What one "Update to <version>" click chose. It is saved, so a closed
 * dialog, a reload, another window or a lost connection continues the same
 * release — never a different one. */
export type UpdateIntent = {
  releaseId: string;
  version: string;
  /** Sent with Apply. Core answers a repeat with the operation it began. */
  requestId: string;
  /** The first step this release still needed when it was chosen. */
  from: UpdateStep;
  /** The last request Core accepted, when, and the operation it named. */
  accepted?: {
    step: "download" | "prepare" | "apply";
    at: number;
    operationId?: string;
  };
  /** The last request that went unanswered, which Core may still have
   * carried out, and the operation Core showed when it was sent: one that
   * appears for this release afterwards is that request's. */
  asked?: {
    step: "download" | "prepare" | "apply";
    at: number;
    priorOperationId?: string | null;
  };
  /** Unanswered requests for the next step. */
  unanswered?: number;
  /** The tab where the release was chosen; only it sends Apply. */
  owner?: string;
};

const intentKey = "yuzuno.update-intent";
export function savedUpdateIntent(): UpdateIntent | null {
  try {
    const saved = JSON.parse(localStorage.getItem(intentKey) || "null");
    return saved && typeof saved.releaseId === "string" &&
      typeof saved.requestId === "string"
      ? saved
      : null;
  } catch {
    return null;
  }
}
/** Throws when storage refuses: an update must not start without the
 * identity that lets it resume and keeps Apply from repeating. */
export function saveUpdateIntent(intent: UpdateIntent | null) {
  if (intent) localStorage.setItem(intentKey, JSON.stringify(intent));
  else localStorage.removeItem(intentKey);
}
export const updateIntentKey = intentKey;

/** Whether a status was read after the choice's last request ended, so it
 * shows what Core did with that request. */
export function updateStatusFresh(intent: UpdateIntent, statusAt: number) {
  return statusAt > Math.max(intent.accepted?.at ?? 0, intent.asked?.at ?? 0);
}

export type UpdateChain =
  | { next: "download" | "prepare" | "apply" }
  | { watch: UpdateStep }
  | { done: true }
  /** Why the chain ends; empty when someone cancelled it. `shown` when the
   * card already shows Core's own account of the failure. */
  | { stop: string; shown?: boolean };

const transferSteps: Record<string, UpdateStep> = {
  checking: "download",
  downloading: "download",
  verifying: "verify",
  registering: "verify",
};

/** The next step for a chosen release, judged only from Core's state. An
 * accepted request is not a finished step: what became of it is read from
 * a status fetched after Core accepted it (`fresh`). Nothing here posts
 * the same step twice once Core has accepted it, and nothing picks another
 * release. */
export function updateChain(
  status: UpdateStatus,
  intent: Pick<UpdateIntent, "releaseId" | "version" | "accepted" | "asked">,
  fresh: boolean,
): UpdateChain {
  const target = intent.releaseId;
  const op = status.operation;
  const source = status.releaseSource;
  let accepted = intent.accepted;
  if (!status.managed)
    return { stop: status.reason || "Updates are off for this Core." };
  if (status.current.releaseId === target) return { done: true };
  if (op && updateInProgress(op.phase)) {
    if (op.releaseId !== target)
      return { stop: "Another update is already in progress." };
    return {
      watch:
        op.phase === "preparing"
          ? "prepare"
          : op.phase === "waiting"
            ? "wait"
            : "install",
    };
  }
  if (accepted && !fresh)
    return {
      watch:
        accepted.step === "apply"
          ? "wait"
          : source && transferSteps[source.phase]
            ? transferSteps[source.phase]
            : accepted.step,
    };
  // After an unanswered request, decide nothing until a later status shows
  // whether Core acted on it.
  if (!fresh) {
    const then = updateChain(status, intent, true);
    return "watch" in then ? then : { watch: updateChainStep(then) ?? "download" };
  }
  // A request whose answer was lost may still have been carried out. Its
  // outcome is then judged like any accepted request, never by sending the
  // work again: an operation for this release that appeared since it was
  // sent is its own, and a download that has since failed was this one.
  const asked = intent.asked;
  if (asked?.step === "download") {
    if (source?.candidate?.releaseId === target && (source.phase === "failed" || source.phase === "cancelled"))
      accepted = { step: "download", at: asked.at };
  } else if (asked && op?.releaseId === target && op.id !== asked.priorOperationId) {
    accepted = { step: asked.step, at: asked.at, operationId: op.id };
  }
  if (op && accepted?.operationId === op.id) {
    if (op.phase === "cancelled") return { stop: "" };
    if (op.phase !== "prepared")
      return { stop: op.error || updateLabels[op.phase], shown: true };
  }
  // Apply is sent once per choice; Core keeps its answer for a repeat.
  if (accepted?.step === "apply")
    return {
      stop: "This update changed in another window or client. Check its state and choose the version again.",
    };
  if (status.preparedReleaseId === target) return { next: "apply" };
  if (accepted?.step === "prepare")
    return {
      stop: "Preparation changed in another window or client. Choose the version again.",
    };
  if (status.candidates.some((c) => c.releaseId === target))
    return { next: "prepare" };
  const offered = source?.candidate?.releaseId === target;
  const moving = source ? transferSteps[source.phase] : undefined;
  if (accepted?.step === "download") {
    if (offered && moving && source?.phase !== "checking") return { watch: moving };
    if (source?.phase === "cancelled") return { stop: "" };
    return source?.phase === "failed"
      ? { stop: source.error || "The download failed.", shown: true }
      : { stop: "The download did not finish. Check for updates and try again." };
  }
  if (source?.phase === "checking") return { watch: "download" };
  if (offered) return moving ? { watch: moving } : { next: "download" };
  return {
    stop: `Version ${intent.version} is no longer offered. Check for updates to choose again.`,
  };
}

/** The step the card shows as current, or null once the chain has ended. */
export function updateChainStep(chain: UpdateChain): UpdateStep | null {
  if ("watch" in chain) return chain.watch;
  if ("next" in chain) return chain.next === "apply" ? "wait" : chain.next;
  return null;
}
