import { api } from "./api";

/** One saved version of a Project's handover document (`/api/projects/{id}/handover`, T-34). */
export type HandoverVersion = {
  version: number;
  writtenBy: { id: string; name: string };
  approvedBy?: string | null;
  reason?: string | null;
  at: string;
  bytes: number;
  /** Only when one past version is read. */
  markdown?: string;
};
/** A lead's proposal for the document (T-34 S3b), as a list shows it. */
export type HandoverProposalSummary = {
  id: string;
  projectId: string;
  proposer: { id: string; name: string };
  baseVersion: number;
  reason?: string | null;
  bytes: number;
  at: string;
  state: "pending" | "approved" | "rejected" | "superseded";
  note?: string | null;
  version?: number | null;
  /** On Home: the document's version now; the card reads the proposal again when it moves (#612 R1). */
  currentVersion?: number;
};
/** One proposal with the text it would replace, for the user's decision. */
export type HandoverProposalDetail = {
  proposal: HandoverProposalSummary & { markdown: string };
  base: { version: number; markdown: string };
  currentVersion: number;
  stale: boolean;
};
/** The document as Core keeps it: its latest version, and who wrote each. */
export type Handover = {
  projectId: string;
  version: number;
  markdown: string;
  history: HandoverVersion[];
  limit: number;
  /** The proposal waiting for the user, if any; absent from an answer that doesn't say (an older Core's save). */
  proposal?: HandoverProposalSummary | null;
};

/** The document as this client reads it: a list, even from an answer without one. */
export const handoverView = (projectId: string, value: Partial<Handover>): Handover => ({
  projectId,
  version: typeof value.version === "number" ? value.version : 0,
  markdown: typeof value.markdown === "string" ? value.markdown : "",
  history: Array.isArray(value.history) ? value.history : [],
  limit: typeof value.limit === "number" ? value.limit : 32 * 1024,
  proposal: !("proposal" in value) ? undefined : value.proposal && typeof value.proposal === "object" ? value.proposal : null,
});

export const readHandover = (projectId: string, signal?: AbortSignal) =>
  api<Partial<Handover>>(`/projects/${encodeURIComponent(projectId)}/handover`, { signal }).then(value => handoverView(projectId, value));
export const readHandoverVersion = (projectId: string, version: number) =>
  api<{ projectId: string; past: HandoverVersion }>(`/projects/${encodeURIComponent(projectId)}/handover?version=${version}`);
/** A new version, checked against the version it was read at. */
export const saveHandover = (projectId: string, expectedVersion: number, markdown: string, reason?: string) =>
  api<Partial<Handover>>(`/projects/${encodeURIComponent(projectId)}/handover`, {
    method: "PUT", body: JSON.stringify({ expectedVersion, markdown, ...(reason?.trim() ? { reason: reason.trim() } : {}) }),
  }).then(value => handoverView(projectId, value));

const proposalPath = (projectId: string, id: string) =>
  `/projects/${encodeURIComponent(projectId)}/handover/proposals/${encodeURIComponent(id)}`;
export const readHandoverProposal = (projectId: string, id: string, signal?: AbortSignal) =>
  api<HandoverProposalDetail>(proposalPath(projectId, id), { signal });
/** The user's decision, checked against the version read and the proposal; a retry with the same requestId gets the same answer. */
export const decideHandoverProposal = (projectId: string, id: string, decision: {
  requestId: string; action: "approve" | "reject"; expectedVersion: number; note?: string;
}) =>
  api<{ proposal: HandoverProposalSummary; handover: Partial<Handover> }>(`${proposalPath(projectId, id)}/decision`, {
    method: "POST",
    body: JSON.stringify({ ...decision, ...(decision.note?.trim() ? { note: decision.note.trim() } : { note: undefined }) }),
  });
