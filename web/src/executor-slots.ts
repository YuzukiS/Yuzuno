import { api } from "./api";

/** How many executors run at once, and what holds or waits for a slot
 * (`/api/executor-slots`, T-35). A Project's own limit is unset (null)
 * unless saved; then only the Workspace's applies. */
export type ExecutorSlotsView = {
  /** `startLimitSeconds`: how long an executor's start may take before Core cuts it off (S2). */
  workspace: { version: number; slots: number; saved: boolean; default: number; startLimitSeconds: number };
  limits: { min: number; max: number; startLimitSeconds: { min: number; max: number; default: number } };
  inUse: { waiting: number; starting: number; running: number };
  project?: { id: string; version: number; slots: number | null };
};

const whole = (value: unknown, otherwise: number) => (typeof value === "number" && Number.isInteger(value) ? value : otherwise);

/** The view as this client reads it, with Core's defaults where an answer lacks a field. */
export const slotsView = (value: Partial<ExecutorSlotsView> | null | undefined): ExecutorSlotsView => {
  const workspace = value?.workspace;
  const defaults = whole(workspace?.default, 3);
  const startLimits = value?.limits?.startLimitSeconds;
  const startDefault = whole(startLimits?.default, 300);
  const project = value?.project;
  return {
    workspace: {
      version: whole(workspace?.version, 0),
      slots: whole(workspace?.slots, defaults),
      saved: workspace?.saved === true,
      default: defaults,
      startLimitSeconds: whole(workspace?.startLimitSeconds, startDefault),
    },
    limits: {
      min: whole(value?.limits?.min, 1), max: whole(value?.limits?.max, 64),
      startLimitSeconds: { min: whole(startLimits?.min, 30), max: whole(startLimits?.max, 3600), default: startDefault },
    },
    inUse: {
      waiting: whole(value?.inUse?.waiting, 0),
      starting: whole(value?.inUse?.starting, 0),
      running: whole(value?.inUse?.running, 0),
    },
    ...(project && typeof project.id === "string"
      ? { project: { id: project.id, version: whole(project.version, 0), slots: typeof project.slots === "number" ? project.slots : null } }
      : {}),
  };
};

export const readExecutorSlots = (signal?: AbortSignal, projectId?: string) =>
  api<ExecutorSlotsView>(projectId ? `/executor-slots?projectId=${encodeURIComponent(projectId)}` : "/executor-slots", { signal })
    .then(slotsView);

/** Saved against the version it was read at; null unsets a Project's own.
 * `startLimitSeconds`: the Workspace's only; left out, it stays as saved. */
export const saveExecutorSlots = (expectedVersion: number, slots: number | null, projectId?: string, startLimitSeconds?: number) =>
  api<ExecutorSlotsView>(projectId ? `/projects/${encodeURIComponent(projectId)}/executor-slots` : "/executor-slots", {
    method: "PUT",
    body: JSON.stringify(startLimitSeconds === undefined ? { expectedVersion, slots } : { expectedVersion, slots, startLimitSeconds }),
  }).then(slotsView);
