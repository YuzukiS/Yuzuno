// T-193 slice 3: one Agent's draft saved on this device, as a text file the
// user saves. Read through DraftStorage (composer-draft.ts) on storage that
// cannot be written; nothing here changes, sends or clears a draft.
import {
  DraftStorage,
  savedDraftAgents,
  savedDraftSummary,
  type ComposerDraft,
  type SavedDraftSummary,
} from "./composer-draft";

export type DraftRow = { agentId: string; name: string; closed: boolean; summary: Exclude<SavedDraftSummary, { state: "none" }> };
export type DraftListing =
  | { available: false; reason: string }
  | { available: true; rows: DraftRow[]; otherAgents: number };

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

/** Drafts saved for the Agent IDs this Workspace lists, from manifests alone:
 * no paste body is read. A draft is keyed by Agent ID only (no Workspace is
 * recorded), so a match is by ID, not proof of the Workspace. Drafts for IDs
 * this Workspace doesn't list are only counted. */
export function listDrafts(
  storage: Pick<Storage, "getItem" | "key" | "length"> | null,
  agents: readonly { id: string; name: string; closedAt?: string | null }[],
): DraftListing {
  if (!storage) return { available: false, reason: "this browser gives Yuzuno no storage here" };
  try {
    const rows: DraftRow[] = [];
    for (const agent of agents) {
      const summary = savedDraftSummary(storage, agent.id);
      if (summary.state !== "none") rows.push({ agentId: agent.id, name: agent.name || "Unnamed Agent", closed: !!agent.closedAt, summary });
    }
    const known = new Set(agents.map((agent) => agent.id));
    const otherAgents = savedDraftAgents(storage).filter((id) => !known.has(id) && savedDraftSummary(storage, id).state !== "none").length;
    return { available: true, rows, otherAgents };
  } catch (error) {
    return { available: false, reason: `this browser refused to read its storage (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** The whole saved draft of one Agent: its text and pasted texts in order;
 * images and skills are named by count and name only. */
export function draftExportText(draft: ComposerDraft, agentName: string, at = new Date()): string {
  const lines = [
    `Yuzuno draft for ${agentName}`,
    `Exported ${at.toISOString()} from the copy saved in this browser for this site. Text typed since it was last saved is not included.`,
    "Saved under the Agent's ID only: the Workspace it was written in is not recorded.",
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
export function exportDraft(storage: Pick<Storage, "getItem">, agentId: string, agentName: string): { text: string } | { error: string } {
  try {
    return { text: draftExportText(new DraftStorage(readOnly(storage)).load(agentId), agentName) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** One draft in the file of several: its Agent's ID and the name listed for
 * it, and its text in order with its pasted texts as they were; images by
 * count and skills by name only. */
export type ExportedDraft = {
  agentId: string;
  name: string;
  closed: boolean;
  savedBy: "thisVersion" | "earlierVersion";
  parts: ({ kind: "text"; text: string } | { kind: "paste"; number: number; lines: number; text: string })[];
  images: number;
  skills: string[];
};
export const DRAFTS_FORMAT = "yuzuno-drafts";
export type DraftsFailure = { agentId: string; name: string; reason: string };

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
  const read = new DraftStorage(readOnly(storage));
  for (const row of rows) {
    // Every read of this draft, its summary's included, is this draft's: a
    // read the browser refuses names it as a failure, like any other.
    try {
      const now = savedDraftSummary(storage, row.agentId);
      if (now.state === "none" || now.state === "damaged") {
        failed.push({ agentId: row.agentId, name: row.name, reason: now.state === "none" ? "it is no longer saved here" : now.reason });
        continue;
      }
      const draft = read.load(row.agentId);
      drafts.push({
        agentId: row.agentId,
        name: row.name,
        closed: row.closed,
        savedBy: now.state === "legacy" ? "earlierVersion" : "thisVersion",
        parts: draft.parts.map((part) =>
          part.kind === "text" ? { kind: "text", text: part.text } : { kind: "paste", number: part.number, lines: part.lines, text: part.text },
        ),
        images: draft.images?.length ?? 0,
        skills: (draft.skills ?? []).map((skill) => skill.name),
      });
    } catch (error) {
      failed.push({ agentId: row.agentId, name: row.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (failed.length) return { failed };
  const file = {
    format: DRAFTS_FORMAT,
    version: 1,
    exportedAt: at.toISOString(),
    note:
      "The copies saved in this browser for this site when exported: text typed since it was last saved is not included. " +
      "Each draft is saved under its Agent's ID only: the Workspace it was written in is not recorded. Images are counted, not included.",
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
