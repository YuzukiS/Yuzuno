import { api } from "./api";

/** How many executors run at once, and what holds or waits for a slot
 * (`/api/executor-slots`, T-35). Since YN-2 S5 each machine's limit is the
 * only one: every machine has one (its own, else the default) and the
 * Workspace runs at most their sum. A Project or a template has none. */
export type ExecutorSlotsView = {
  /** `startLimitSeconds`: how long an executor's start may take before Core cuts it off (S2), the Workspace's. */
  workspace: { version: number; startLimitSeconds: number };
  limits: { min: number; max: number; default: number; startLimitSeconds: { min: number; max: number; default: number } };
  inUse: { waiting: number; starting: number; running: number };
  /** Each machine's limit, this Core host's (`local`) first. */
  machines: MachineSlots[];
  /** The machines' limits added up: the most that run at once in the Workspace. */
  total: number;
};
/** `slots`: the machine's own number, or null when none is saved; `limit`:
 * the one that applies, its own or the default; `executors`: those holding
 * a slot there now. */
export type MachineSlots = { id: string; name: string; version: number; slots: number | null; limit: number; executors: number };

const whole = (value: unknown, otherwise: number) => (typeof value === "number" && Number.isInteger(value) ? value : otherwise);

/** The view as this client reads it, with Core's defaults where an answer lacks a field. */
export const slotsView = (value: Partial<ExecutorSlotsView> | null | undefined): ExecutorSlotsView => {
  const defaults = whole(value?.limits?.default, 3);
  const startLimits = value?.limits?.startLimitSeconds;
  const startDefault = whole(startLimits?.default, 300);
  // Core's answer: `slots` is the limit that applies and `saved` says whether it is the machine's own.
  type Answered = { id?: unknown; name?: unknown; version?: unknown; slots?: unknown; saved?: unknown; executors?: unknown };
  const machines: MachineSlots[] = Array.isArray(value?.machines)
    ? (value.machines as Answered[]).filter((m) => typeof m?.id === "string").map((m) => {
        const number = typeof m.slots === "number" ? m.slots : null;
        const own = m.saved === false ? null : number;
        return {
          id: m.id as string, name: typeof m.name === "string" ? m.name : (m.id as string), version: whole(m.version, 0),
          slots: own, limit: number ?? defaults, executors: whole(m.executors, 0),
        };
      })
    : [];
  return {
    workspace: {
      version: whole(value?.workspace?.version, 0),
      startLimitSeconds: whole(value?.workspace?.startLimitSeconds, startDefault),
    },
    limits: {
      min: whole(value?.limits?.min, 1), max: whole(value?.limits?.max, 64), default: defaults,
      startLimitSeconds: { min: whole(startLimits?.min, 30), max: whole(startLimits?.max, 3600), default: startDefault },
    },
    inUse: {
      waiting: whole(value?.inUse?.waiting, 0),
      starting: whole(value?.inUse?.starting, 0),
      running: whole(value?.inUse?.running, 0),
    },
    machines,
    total: whole(value?.total, machines.reduce((sum, m) => sum + m.limit, 0)),
  };
};

export const readExecutorSlots = (signal?: AbortSignal) => api<ExecutorSlotsView>("/executor-slots", { signal }).then(slotsView);

/** A machine's own limit (`local` for this Core host), saved against the
 * version it was read at; null clears it, for the default. Lowering it stops
 * no running executor: none more starts there until fewer hold a slot (T-35 S3). */
export const saveMachineSlots = (machineId: string, expectedVersion: number, slots: number | null) =>
  api<ExecutorSlotsView>(`/machines/${encodeURIComponent(machineId)}/executor-slots`, {
    method: "PUT",
    body: JSON.stringify({ expectedVersion, slots }),
  }).then(slotsView);

/** The Workspace's start time limit, saved against the version it was read at. */
export const saveStartLimit = (expectedVersion: number, startLimitSeconds: number) =>
  api<ExecutorSlotsView>("/executor-slots", {
    method: "PUT",
    body: JSON.stringify({ expectedVersion, startLimitSeconds }),
  }).then(slotsView);
