import { strings, type Language } from "./i18n";

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

/** What the update is waiting for: Core's blockers in its own words, with
 * how each pause request went, worded in `language`. */
export function updateWaitRows(status: UpdateStatus | null, language: Language = "en") {
  const w = words(language);
  const rows = (status?.blockers || []).map((b) => ({ ...b, idle: false }));
  for (const notice of status?.waitNotices || []) {
    const existing = rows.find((row) => row.agentId === notice.agentId);
    const delivery = !notice.active ? w.notice.inactive
      : notice.readAt ? w.notice.read
      : notice.delivery === "delivered" ? w.notice.delivered
      : notice.delivery === "sending" ? w.notice.sending
      : notice.delivery === "uncertain" ? w.notice.uncertain
      : notice.delivery === "error" ? w.notice.error
      : w.notice.pending;
    if (existing) {
      existing.reason += ` · ${delivery}`;
    } else {
      rows.push({ agentId: notice.agentId, name: notice.name, idle: notice.idle,
        reason: notice.idle ? w.idle : `${w.stillWaiting} · ${delivery}` });
    }
  }
  return rows;
}

export function releaseTransferActive(status?: UpdateStatus["releaseSource"]) {
  return !!status && ["checking", "downloading", "verifying", "registering"].includes(status.phase);
}

// What this window says about an update (T-189); Core's own words, versions
// and names are shown as they came.
const words = strings({
  phases: {
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
  } as Record<UpdatePhase, string>,
  steps: { download: "Download", verify: "Verify", prepare: "Prepare", wait: "Wait for agents", install: "Install" } as Record<UpdateStep, string>,
  notice: {
    inactive: "Pause request no longer active",
    read: "Pause request read",
    delivered: "Pause request delivered",
    sending: "Waiting for native delivery receipt",
    uncertain: "Pause delivery uncertain",
    error: "Pause request could not be delivered",
    pending: "Pause request not yet delivered",
  },
  idle: "Idle",
  stillWaiting: "Still waiting",
  stops: {
    off: "Updates are off for this Core.",
    another: "Another update is already in progress.",
    applyChanged: "This update changed in another window or client. Check its state and choose the version again.",
    prepareChanged: "Preparation changed in another window or client. Choose the version again.",
    downloadFailed: "The download failed.",
    downloadUnfinished: "The download did not finish. Check for updates and try again.",
    unanswered: "Workspace did not answer. Check the update state, then choose the version again.",
  },
  notOffered: (version: string) => `Version ${version} is no longer offered. Check for updates to choose again.`,
  drafts: (error: string) => `${error} Nothing was applied; your draft is still here.`,
}, {
  phases: {
    preparing: "正在准备更新",
    prepared: "已准备就绪，等你开始",
    waiting: "正在等待你的 Agent",
    flushing: "正在保存最后的更改",
    stopping: "正在切换 Workspace 服务",
    starting: "正在启动新版本",
    restoring: "正在重新连接你的会话",
    complete: "你的 Workspace 已是最新",
    rolledBack: "已回到之前的版本",
    failed: "更新需要处理",
    cancelled: "已取消等待更新",
  },
  steps: { download: "下载", verify: "验证", prepare: "准备", wait: "等待 Agent", install: "安装" },
  notice: {
    inactive: "暂停请求已失效",
    read: "暂停请求已读",
    delivered: "暂停请求已送达",
    sending: "正在等待原生送达回执",
    uncertain: "暂停请求是否送达不确定",
    error: "暂停请求无法送达",
    pending: "暂停请求尚未送达",
  },
  idle: "空闲",
  stillWaiting: "仍在等待",
  stops: {
    off: "此 Core 未开启更新。",
    another: "另一个更新已在进行中。",
    applyChanged: "此更新已在另一个窗口或客户端中改变。请查看它的状态，再重新选择版本。",
    prepareChanged: "准备工作已在另一个窗口或客户端中改变。请重新选择版本。",
    downloadFailed: "下载失败。",
    downloadUnfinished: "下载没有完成。请检查更新后重试。",
    unanswered: "Workspace 没有回答。请查看更新状态，再重新选择版本。",
  },
  notOffered: (version) => `版本 ${version} 已不再提供。请检查更新后重新选择。`,
  drafts: (error) => `${error} 没有应用任何更改；你的草稿还在。`,
});
/** A phase as this window names it, in `language`. */
export const updateLabel = (phase: UpdatePhase, language: Language = "en") => words(language).phases[phase];
/** A step as the card names it, in `language`. */
export const updateStepLabel = (step: UpdateStep, language: Language = "en") => words(language).steps[step];

/** Why an update stopped, worded where it is shown: what Core or the error
 * said (`said`, as it came), or this window's own account. */
export type UpdateStop =
  | { said: string }
  | { why: keyof ReturnType<typeof words>["stops"] }
  | { why: "phase"; phase: UpdatePhase }
  | { why: "notOffered"; version: string }
  | { why: "drafts"; error: string };
export function updateStopText(stop: UpdateStop, language: Language = "en"): string {
  const w = words(language);
  if ("said" in stop) return stop.said;
  if (stop.why === "phase") return w.phases[stop.phase];
  if (stop.why === "notOffered") return w.notOffered(stop.version);
  if (stop.why === "drafts") return w.drafts(stop.error);
  return w.stops[stop.why];
}

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
export const updateSteps: UpdateStep[] = ["download", "verify", "prepare", "wait", "install"];

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
  /** Why the chain ends; null when someone cancelled it. `shown` when the
   * card already shows Core's own account of the failure. */
  | { stop: UpdateStop | null; shown?: boolean };

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
    return { stop: status.reason ? { said: status.reason } : { why: "off" } };
  if (status.current.releaseId === target) return { done: true };
  if (op && updateInProgress(op.phase)) {
    if (op.releaseId !== target)
      return { stop: { why: "another" } };
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
    if (op.phase === "cancelled") return { stop: null };
    if (op.phase !== "prepared")
      return { stop: op.error ? { said: op.error } : { why: "phase", phase: op.phase }, shown: true };
  }
  // Apply is sent once per choice; Core keeps its answer for a repeat.
  if (accepted?.step === "apply")
    return { stop: { why: "applyChanged" } };
  if (status.preparedReleaseId === target) return { next: "apply" };
  if (accepted?.step === "prepare")
    return { stop: { why: "prepareChanged" } };
  if (status.candidates.some((c) => c.releaseId === target))
    return { next: "prepare" };
  const offered = source?.candidate?.releaseId === target;
  const moving = source ? transferSteps[source.phase] : undefined;
  if (accepted?.step === "download") {
    if (offered && moving && source?.phase !== "checking") return { watch: moving };
    if (source?.phase === "cancelled") return { stop: null };
    return source?.phase === "failed"
      ? { stop: source.error ? { said: source.error } : { why: "downloadFailed" }, shown: true }
      : { stop: { why: "downloadUnfinished" } };
  }
  if (source?.phase === "checking") return { watch: "download" };
  if (offered) return moving ? { watch: moving } : { next: "download" };
  return { stop: { why: "notOffered", version: intent.version } };
}

/** The step the card shows as current, or null once the chain has ended. */
export function updateChainStep(chain: UpdateChain): UpdateStep | null {
  if ("watch" in chain) return chain.watch;
  if ("next" in chain) return chain.next === "apply" ? "wait" : chain.next;
  return null;
}
