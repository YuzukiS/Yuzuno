// T-193 slice 3: one Agent's draft saved on this device, as a text file the
// user saves. Read through DraftStorage (composer-draft.ts) on storage that
// cannot be written; nothing here changes, sends or clears a draft.
import {
  DraftStorage,
  draftIdentity,
  readUnattributedDraft,
  unattributedDraftAgents,
  savedDraftAgents,
  savedDraftSummary,
  type ComposerDraft,
  type SavedDraftSummary,
} from "./composer-draft";

export type DraftRow = {
  agentId: string;
  name: string;
  closed: boolean;
  /** The key this draft is saved under: this Workspace and Agent, or the
   * Agent alone for one saved before Workspaces were recorded (T-195). Rows
   * are told apart by it, since both can exist for one Agent ID. */
  identity: string;
  /** Whether this draft says which Workspace it was written in. A row that
   * does not is shown as what it is, not as this Workspace's. */
  attributed: boolean;
  summary: Exclude<SavedDraftSummary, { state: "none" }>;
};
/** Why drafts, or one of them, can't be read, worded where it is shown: this
 * browser gives Yuzuno no storage here, it refused a read, the draft is no
 * longer saved, or what stopped it (the browser's or the draft's own check's
 * words, composer-draft.ts). */
export type DraftProblem = { kind: "noStorage" } | { kind: "refused"; error: string } | { kind: "gone" } | { kind: "error"; error: string };
export type DraftListing =
  | { available: false; why: DraftProblem }
  | { available: true; rows: DraftRow[]; otherAgents: number; unattributed: number };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Storage that can only be read: a slip that writes fails instead of changing a draft. */
export function readOnly(storage: Pick<Storage, "getItem">): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  return {
    getItem: (key) => storage.getItem(key),
    setItem: () => {
      throw new Error("Draft export only reads");
    },
    removeItem: () => {
      throw new Error("Draft export only reads");
    },
  };
}

/**
 * Drafts saved for the Agent IDs this Workspace lists, from manifests alone:
 * no paste body is read.
 *
 * A draft now records which Workspace it belongs to (T-195), so a row here is
 * this Workspace's own: an Agent ID that another Workspace also uses no
 * longer matches. `otherAgents` counts drafts this Workspace saved for Agents
 * it no longer lists. `unattributed` counts drafts from before Workspaces
 * were recorded -- they say which Agent but not which Workspace, so they are
 * counted and never shown as this Workspace's, nor read, rewritten or
 * removed.
 */
export function listDrafts(
  storage: Pick<Storage, "getItem" | "key" | "length"> | null,
  agents: readonly { id: string; name: string; closedAt?: string | null }[],
  workspaceId: string,
): DraftListing {
  if (!storage) return { available: false, why: { kind: "noStorage" } };
  if (!workspaceId) return { available: true, rows: [], otherAgents: 0, unattributed: unattributedDraftAgents(storage).length };
  try {
    const rows: DraftRow[] = [];
    for (const agent of agents) {
      const identity = draftIdentity(workspaceId, agent.id);
      const summary = savedDraftSummary(storage, identity);
      if (summary.state !== "none")
        rows.push({ agentId: agent.id, name: agent.name || "Unnamed Agent", closed: !!agent.closedAt, identity, attributed: true, summary });
    }
    const listed = new Map(agents.map((agent) => [agent.id, agent]));
    const otherAgents = savedDraftAgents(storage, workspaceId).filter(
      (id) => !listed.has(id) && savedDraftSummary(storage, draftIdentity(workspaceId, id)).state !== "none",
    ).length;
    // Saved before Workspaces were recorded: still on this device, so still
    // shown and still exportable, and named by the Agent ID they do say. A
    // listed Agent's name is shown when the ID matches, which is all it is --
    // the match does not prove the draft was written in this Workspace.
    let unattributed = 0;
    for (const agent of unattributedDraftAgents(storage)) {
      const summary = savedDraftSummary(storage, agent);
      if (summary.state === "none") continue;
      const known = listed.get(agent);
      rows.push({ agentId: agent, name: known?.name || agent, closed: !!known?.closedAt, identity: agent, attributed: false, summary });
      unattributed += 1;
    }
    return { available: true, rows, otherAgents, unattributed };
  } catch (error) {
    return { available: false, why: { kind: "refused", error: message(error) } };
  }
}

/** The whole saved draft of one Agent: its text and pasted texts in order;
 * images and skills are named by count and name only. */
export function draftExportText(draft: ComposerDraft, agentName: string, at = new Date(), attributed: boolean): string {
  const lines = [
    `Yuzuno draft for ${agentName}`,
    `Exported ${at.toISOString()} from the copy saved in this browser for this site. Text typed since it was last saved is not included.`,
    attributed
      ? "Saved under the Workspace and Agent it was written in."
      : "Saved before Yuzuno recorded the Workspace a draft belongs to: it names this Agent ID only, so which Workspace it was written in is not known.",
  ];
  if (draft.images?.length)
    lines.push(`Images in the draft: ${draft.images.length} (references only; the images themselves are not in this file)`);
  if (draft.skills?.length) lines.push(`Skills chosen: ${draft.skills.map((skill) => skill.name).join(", ")}`);
  const body = draft.parts
    .map((part) =>
      part.kind === "text"
        ? part.text
        : `\n[Pasted text #${part.number}, ${part.lines} ${part.lines === 1 ? "line" : "lines"}]\n${part.text}\n[End of pasted text #${part.number}]\n`,
    )
    .join("");
  return `${lines.join("\n")}\n\n${body}`;
}

/** One Agent's saved draft, opened only when the user chooses it. */
export function exportDraft(storage: Pick<Storage, "getItem">, row: Pick<DraftRow, "identity" | "attributed" | "name">): { text: string } | { why: DraftProblem } {
  try {
    return { text: draftExportText(readRow(storage, row), row.name, undefined, row.attributed) };
  } catch (error) {
    return { why: { kind: "error", error: message(error) } };
  }
}

/** A row's draft as it is saved, through storage that cannot be written. */
function readRow(storage: Pick<Storage, "getItem">, row: Pick<DraftRow, "identity" | "attributed">): ComposerDraft {
  const only = readOnly(storage);
  return row.attributed ? new DraftStorage(only).load(row.identity) : readUnattributedDraft(only, row.identity);
}

/** One draft in the file of several: its Agent's ID and the name listed for
 * it, and its text in order with its pasted texts as they were; images by
 * count and skills by name only. */
export type ExportedDraft = {
  agentId: string;
  name: string;
  closed: boolean;
  /** Whether the draft says it was written in the Workspace this export was
   * made from, or was saved before that was recorded (T-195). */
  workspace: "thisWorkspace" | "notRecorded";
  savedBy: "thisVersion" | "earlierVersion";
  parts: ({ kind: "text"; text: string } | { kind: "paste"; number: number; lines: number; text: string })[];
  images: number;
  skills: string[];
};
export const DRAFTS_FORMAT = "yuzuno-drafts";
export type DraftsFailure = { agentId: string; name: string; why: DraftProblem };

/** The chosen drafts, each read now and only these, through storage that
 * cannot be written: as they are now, which another window may have changed
 * since the list was read. All or nothing: when any can't be read, or is no
 * longer saved, those are named and no file is made. */
export function exportDrafts(
  storage: Pick<Storage, "getItem">,
  rows: readonly DraftRow[],
  at = new Date(),
): { text: string; count: number } | { failed: DraftsFailure[] } {
  const drafts: ExportedDraft[] = [];
  const failed: DraftsFailure[] = [];
  for (const row of rows) {
    // Every read of this draft, its summary's included, is this draft's: a
    // read the browser refuses names it as a failure, like any other.
    try {
      const now = savedDraftSummary(storage, row.identity);
      if (now.state === "none" || now.state === "damaged") {
        failed.push({ agentId: row.agentId, name: row.name, why: now.state === "none" ? { kind: "gone" } : { kind: "error", error: now.reason } });
        continue;
      }
      const draft = readRow(storage, row);
      drafts.push({
        agentId: row.agentId,
        name: row.name,
        closed: row.closed,
        workspace: row.attributed ? "thisWorkspace" : "notRecorded",
        savedBy: now.state === "legacy" ? "earlierVersion" : "thisVersion",
        parts: draft.parts.map((part) =>
          part.kind === "text" ? { kind: "text", text: part.text } : { kind: "paste", number: part.number, lines: part.lines, text: part.text },
        ),
        images: draft.images?.length ?? 0,
        skills: (draft.skills ?? []).map((skill) => skill.name),
      });
    } catch (error) {
      failed.push({ agentId: row.agentId, name: row.name, why: { kind: "error", error: message(error) } });
    }
  }
  if (failed.length) return { failed };
  const file = {
    format: DRAFTS_FORMAT,
    version: 1,
    exportedAt: at.toISOString(),
    note:
      "The copies saved in this browser for this site when exported: text typed since it was last saved is not included. " +
      "Each draft says the Workspace and Agent it was written in, unless it was saved before Yuzuno recorded the Workspace (workspace: notRecorded). Images are counted, not included.",
    drafts,
  };
  return { text: `${JSON.stringify(file, null, 2)}\n`, count: drafts.length };
}

export function draftsFileName(at = new Date()): string {
  return `yuzuno-drafts-${at.toISOString().replace(/[:.]/g, "-")}.json`;
}

export function draftFileName(agentName: string, at = new Date()): string {
  const name = agentName.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
  return `yuzuno-draft-${name}-${at.toISOString().replace(/[:.]/g, "-")}.txt`;
}
