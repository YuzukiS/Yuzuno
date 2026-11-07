import { api } from "./api";

/** Who changed a Project's handover document last: the user ("user", named You) or a lead of the Project (YN-2 S3). */
export type HandoverModified = {
  by: { id: string; name: string };
  at: string;
  note?: string | null;
};
/** The document as Core keeps it (`/api/projects/{id}/handover`, T-34). `version` is its internal revision,
 * which a save is checked against; it is never shown. No history is listed (YN-2 S3). */
export type Handover = {
  projectId: string;
  version: number;
  markdown: string;
  lastModified: HandoverModified | null;
  limit: number;
};

const modifiedOf = (value: unknown): HandoverModified | null => {
  const m = value as Partial<HandoverModified> | null | undefined;
  return m && m.by && typeof m.by.name === "string" && typeof m.at === "string"
    ? { by: { id: String(m.by.id ?? ""), name: m.by.name }, at: m.at, note: typeof m.note === "string" ? m.note : null }
    : null;
};

/** The document as this client reads it, even from an answer without some of it. */
export const handoverView = (projectId: string, value: Partial<Handover>): Handover => ({
  projectId,
  version: typeof value.version === "number" ? value.version : 0,
  markdown: typeof value.markdown === "string" ? value.markdown : "",
  lastModified: modifiedOf(value.lastModified),
  limit: typeof value.limit === "number" ? value.limit : 32 * 1024,
});

export const readHandover = (projectId: string, signal?: AbortSignal) =>
  api<Partial<Handover>>(`/projects/${encodeURIComponent(projectId)}/handover`, { signal }).then(value => handoverView(projectId, value));
/** A save, checked against the revision it was read at, with an optional note. */
export const saveHandover = (projectId: string, expectedVersion: number, markdown: string, note?: string) =>
  api<Partial<Handover>>(`/projects/${encodeURIComponent(projectId)}/handover`, {
    method: "PUT", body: JSON.stringify({ expectedVersion, markdown, ...(note?.trim() ? { note: note.trim() } : {}) }),
  }).then(value => handoverView(projectId, value));
