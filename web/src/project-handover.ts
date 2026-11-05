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
/** The document as Core keeps it: its latest version, and who wrote each. */
export type Handover = { projectId: string; version: number; markdown: string; history: HandoverVersion[]; limit: number };

export const readHandover = (projectId: string, signal?: AbortSignal) =>
  api<Handover>(`/projects/${encodeURIComponent(projectId)}/handover`, { signal });
export const readHandoverVersion = (projectId: string, version: number) =>
  api<{ projectId: string; past: HandoverVersion }>(`/projects/${encodeURIComponent(projectId)}/handover?version=${version}`);
/** A new version, checked against the version it was read at. */
export const saveHandover = (projectId: string, expectedVersion: number, markdown: string, reason?: string) =>
  api<Handover>(`/projects/${encodeURIComponent(projectId)}/handover`, {
    method: "PUT", body: JSON.stringify({ expectedVersion, markdown, ...(reason?.trim() ? { reason: reason.trim() } : {}) }),
  });
