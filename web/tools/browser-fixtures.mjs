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
/** /api/ci/live when no Agent is waiting on a CI run (live-ci.ts). */
export const noLiveCi = { agents: {} };
/** /api/agents/{id}/conversation/inputs (T-6) when the conversation lists no inputs. */
export const noConversationInputs = { inputs: [], hasBefore: false, total: 0 };
/** /api/home with nothing on it, which the app reads once it knows its Workspace. */
export const emptyHome = { generatedAt: "2026-10-12T12:00:00Z", order: [], needsYou: [], projects: [] };

/**
 * The identity a draft is saved under: its Workspace and its Agent, as
 * composer-draft.ts's draftIdentity spells it (T-195). The paste bodies' keys
 * use it too. Both parts are needed: a key is never looked for by its Agent
 * alone, which can be another Workspace's, and a missing part is an error,
 * not "no draft".
 *
 * Plain, so it runs here or in the page:
 * `page.evaluate(draftIdentityInPage, [workspaceId, agentId])`.
 */
export function draftIdentityInPage([workspace, agent] = []) {
  if (typeof workspace !== "string" || !workspace || typeof agent !== "string" || !agent)
    throw new Error(`A saved draft is found by its Workspace and its Agent, not ${JSON.stringify([workspace, agent])} (T-195)`);
  return JSON.stringify([workspace, agent]);
}

/** Runs in the page: the draft saved for [Workspace, Agent], pasted blocks
 * included, or null when there is none. Since long pastes became blocks (T-33)
 * the composer saves `yuzuno.composer.v1:<identity>`, the identity being the
 * Workspace and the Agent since T-195 (as draftIdentityInPage; a function
 * sent to the page takes nothing with it). Drafts saved before Workspaces were
 * recorded are not read, as the composer no longer reads them either. */
function readSavedDraft([workspace, agent] = []) {
  if (typeof workspace !== "string" || !workspace || typeof agent !== "string" || !agent)
    throw new Error(`A saved draft is found by its Workspace and its Agent, not ${JSON.stringify([workspace, agent])} (T-195)`);
  const identity = JSON.stringify([workspace, agent]);
  const saved = localStorage.getItem("yuzuno.composer.v1:" + identity);
  if (saved === null) return null;
  return JSON.parse(saved).parts
    .map((part) =>
      part.kind === "text"
        ? part.text
        : (localStorage.getItem("yuzuno.paste.v1:" + identity + ":" + part.bodyId) ?? ""),
    )
    .join("");
}

/** The draft saved in `page` for Agent `agentId` of Workspace `workspaceId`
 * (see readSavedDraft), or null when there is none. */
export function savedDraft(page, workspaceId, agentId) {
  return page.evaluate(readSavedDraft, [workspaceId, agentId]);
}

/** The draft in the message composer on screen: the open Agent's, in the
 * Workspace the page is in, which the caller names (its fixture's id, or the
 * one its lab Core answered with). The composer is a CodeMirror editor that
 * draws only the lines in view, so this reads the draft it saves on every
 * change, under the Agent the page keeps open for that Workspace
 * (`yuzuno.selected.<id>` since T-195; the older unscoped key is not read).
 * No Workspace, or no open Agent saved for it, is an error: a page that never
 * learned its Workspace keeps drafts in memory only, and reads as the editor
 * shows them. A real form field still reads as its value. */
export async function composerDraft(locator, workspaceId) {
  const field = await locator.evaluate((el) =>
    el.matches("input, textarea, select") ? el.value : null,
  );
  if (field != null) return field;
  if (typeof workspaceId !== "string" || !workspaceId)
    throw new Error("composerDraft needs the Workspace the page is in: drafts are saved per Workspace (T-195)");
  const agent = await locator.evaluate(
    (_, key) => JSON.parse(localStorage.getItem(key) || "null"),
    `yuzuno.selected.${workspaceId}`,
  );
  if (typeof agent !== "string" || !agent)
    throw new Error(`No open Agent is saved for Workspace ${workspaceId} (yuzuno.selected.${workspaceId})`);
  return (await savedDraft(locator.page(), workspaceId, agent)) ?? "";
}
