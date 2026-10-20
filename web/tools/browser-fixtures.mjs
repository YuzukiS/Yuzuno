// Shared pieces for the Chromium acceptance checks (*-check.mjs).

/** /api/updates for a workspace that is not a managed install: nothing to
 * offer. The UI asks for it on load since workspace updates (T-12). */
export const unmanagedUpdates = {
  managed: false,
  reason: "Not a managed install",
  current: {
    releaseId: "workspace-dev",
    version: "dev",
    gitSha: "0".repeat(40),
    builtAt: "",
    platform: "linux-x86_64",
    protocol: 1,
    schema: { writes: 1, readsMin: 1, readsMax: 1 },
    records: { writes: 1, readsMin: 1, readsMax: 1 },
    notes: "",
    bytes: 0,
  },
  candidates: [],
  blockers: [],
  acceptingWork: true,
  storage: { releaseBytes: 0, backupBytes: 0, retainedReleases: 0, keepReleases: 2 },
};

/** /api/jobs/budget for a machine with nothing running or queued. The UI
 * asks for it on load since Jobs arrived. */
export const idleJobsBudget = {
  machine: { name: "Core host", memoryAvailableMiB: null, scope: "fixture" },
  budget: { cpuMillis: 0, memoryMiB: 0, swapMiB: 0 },
  reserved: { cpuMillis: 0, memoryMiB: 0, swapMiB: 0 },
  queuedCount: 0,
  activeCount: 0,
};

/** /api/jobs and /api/ci for an Agent with no jobs or CI runs. The
 * conversation asks for both on load since Jobs and CI monitoring arrived. */
export const noJobs = { jobs: [], liveJobs: [], hasMore: false, nextBefore: null };
export const noCiRuns = { runs: [], subscriptions: [], hasMore: false, nextBefore: null };
/** /api/reviews when no PR review was asked for. The bottom bar reads it on
 * load since T-82. */
export const noReviews = { reviews: [], hasMore: false, nextBefore: null };
/** /api/jobs/live (T-70) when no Agent is waiting on a job. */
export const noLiveJobs = { agents: {} };

/** The draft saved for Agent `id`, pasted blocks included, or null when it
 * has none. Since long pastes became blocks (T-33) the composer saves
 * `yuzuno.composer.v1:<id>`; before its first save the editor shows the old
 * string draft, as DraftStorage.load does. Runs in the page. */
function readSavedDraft(id) {
  const saved = localStorage.getItem("yuzuno.composer.v1:" + id);
  if (!saved) {
    const legacy = JSON.parse(localStorage.getItem("yuzuno.drafts") || "{}");
    return typeof legacy?.[id] === "string" ? legacy[id] : null;
  }
  return JSON.parse(saved).parts
    .map((part) =>
      part.kind === "text"
        ? part.text
        : (localStorage.getItem("yuzuno.paste.v1:" + id + ":" + part.bodyId) ?? ""),
    )
    .join("");
}

/** The draft saved for Agent `id` in `page` (see readSavedDraft). */
export function savedDraft(page, id) {
  return page.evaluate(readSavedDraft, id);
}

/** The draft in the message composer on screen (the selected agent's).
 * The composer is a CodeMirror editor that draws only the lines in view, so
 * read the draft it saves on every change, as pasted-text-browser.mjs does.
 * A real form field still reads as its value. */
export async function composerDraft(locator) {
  const field = await locator.evaluate((el) =>
    el.matches("input, textarea, select") ? el.value : null,
  );
  if (field != null) return field;
  const id = await locator.evaluate(() =>
    JSON.parse(localStorage.getItem("yuzuno.selected") || '""'),
  );
  return (await savedDraft(locator.page(), id)) ?? "";
}
