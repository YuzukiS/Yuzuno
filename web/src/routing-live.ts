/** Executor routing as Core evaluates it (YN-34 S3b; docs/executor-routing.md,
 * "Shapes for routing and its Settings page"): why each candidate would or
 * wouldn't be chosen now, the recent choices, and today's spend. Nothing here
 * changes anything: every route only reads or evaluates. */
import { api, HttpError } from "./api";
import type { Policy, Tier } from "./executor-routing";

export type CandidateState = "chosen" | "skipped" | "unknown" | "failed" | "notTried" | "off";
/** Why, in both languages as Core words it; `params` carry ISO times. */
export interface Reason { code: string; message: string; messageZh: string; params?: Record<string, unknown>; condition?: number }
export interface Reading { what: string; account?: string; value: number | string; observedAt?: string; source?: string }
export interface RouteAccount { number: number; fingerprint: string; state: "pick" | "ok" | "low" | "unknown" }
export interface RouteCandidate {
  id: string; label?: string; harness?: string; model?: string; state: CandidateState;
  reasons: Reason[]; readings: Reading[]; accounts?: RouteAccount[];
}
/** One choice: kept on a dispatch (`at` dispatch or start), or a preview. */
export interface RouteRecord {
  policyVersion?: number; evaluatedAt?: string; at: "dispatch" | "start" | "preview" | string;
  chosen: string | null;
  account?: { number: number; fingerprint: string } | { home: string };
  candidates: RouteCandidate[];
  changedAtStart?: { from: string; reason: string | Reason };
  earliest?: { at: string; candidate: string };
  /** An executor no candidate could ever take: it started without routing (#805). */
  released?: Reason & { at?: string };
}
export interface Choice { dispatchId: string; taskId: string; executorName?: string; route: RouteRecord }
export interface Spend { day: string; utcOffset?: string; resetsAt?: string; totalUsd: number; capUsd?: number; byKey: Record<string, number>; note?: string; noteZh?: string }
export interface Readings { at?: string; staleAfterSeconds?: number; spend?: Spend }
export type Assume = { accountsUsedUp?: string[]; codexUsedUp?: string[]; spendCapReached?: boolean; onePasswordDown?: boolean };

const STATES: readonly CandidateState[] = ["chosen", "skipped", "unknown", "failed", "notTried", "off"];
const text = (v: unknown): v is string => typeof v === "string";
const reasonOf = (v: unknown): Reason | null => {
  const r = v as Partial<Reason> | null;
  if (!r || !text(r.code)) return null;
  const message = text(r.message) ? r.message : r.code;
  return { code: r.code, message, messageZh: text(r.messageZh) ? r.messageZh : message,
    ...(r.params && typeof r.params === "object" ? { params: r.params } : {}), ...(typeof r.condition === "number" ? { condition: r.condition } : {}) };
};
const list = <T>(v: unknown, of: (x: unknown) => T | null): T[] => (Array.isArray(v) ? v.map(of).filter((x): x is T => x !== null) : []);
const readingOf = (v: unknown): Reading | null => {
  const r = v as Partial<Reading> | null;
  return r && text(r.what) && (typeof r.value === "number" || text(r.value))
    ? { what: r.what, value: r.value, ...(text(r.account) ? { account: r.account } : {}), ...(text(r.observedAt) ? { observedAt: r.observedAt } : {}), ...(text(r.source) ? { source: r.source } : {}) }
    : null;
};
const accountOf = (v: unknown): RouteAccount | null => {
  const a = v as Partial<RouteAccount> | null;
  return a && typeof a.number === "number" && text(a.fingerprint) && ["pick", "ok", "low", "unknown"].includes(a.state as string)
    ? { number: a.number, fingerprint: a.fingerprint, state: a.state as RouteAccount["state"] } : null;
};
const candidateOf = (v: unknown): RouteCandidate | null => {
  const c = v as Partial<RouteCandidate> | null;
  if (!c || !text(c.id)) return null;
  return {
    id: c.id, state: STATES.includes(c.state as CandidateState) ? c.state as CandidateState : "unknown",
    reasons: list(c.reasons, reasonOf), readings: list(c.readings, readingOf),
    ...(text(c.label) ? { label: c.label } : {}), ...(text(c.harness) ? { harness: c.harness } : {}), ...(text(c.model) ? { model: c.model } : {}),
    ...(Array.isArray(c.accounts) ? { accounts: list(c.accounts, accountOf) } : {}),
  };
};
const releasedOf = (v: unknown): { released?: Reason & { at?: string } } => {
  const why = reasonOf(v);
  const at = (v as { at?: unknown } | null)?.at;
  return why ? { released: { ...why, ...(text(at) ? { at } : {}) } } : {};
};
/** A record as this client reads it: only the fields it shows, an account by
 * number and fingerprint only. */
export function routeRecord(v: unknown): RouteRecord {
  const r = (v ?? {}) as Partial<RouteRecord>;
  const account = r.account as Record<string, unknown> | undefined;
  return {
    at: text(r.at) ? r.at : "preview",
    chosen: text(r.chosen) ? r.chosen : null,
    candidates: list(r.candidates, candidateOf),
    ...(typeof r.policyVersion === "number" ? { policyVersion: r.policyVersion } : {}),
    ...(text(r.evaluatedAt) ? { evaluatedAt: r.evaluatedAt } : {}),
    ...(account && typeof account.number === "number" && text(account.fingerprint) ? { account: { number: account.number, fingerprint: account.fingerprint } }
      : account && text(account.home) ? { account: { home: account.home } } : {}),
    ...(r.changedAtStart && text(r.changedAtStart.from) ? { changedAtStart: { from: r.changedAtStart.from,
      reason: reasonOf(r.changedAtStart.reason) ?? (text(r.changedAtStart.reason) ? r.changedAtStart.reason : "") } } : {}),
    ...(r.earliest && text(r.earliest.at) && text(r.earliest.candidate) ? { earliest: { at: r.earliest.at, candidate: r.earliest.candidate } } : {}),
    ...releasedOf(r.released),
  };
}

/** Evaluates a policy (a draft, or the saved one when none is given) at a time
 * (now when none), as Core would choose. Null when this Core can't evaluate
 * routing yet (no such route: older than YN-34 S3b). */
/** `tier`: for an executor of that kind of work (YN-70), only the candidates that take it. */
export async function evaluate(policy: Policy | undefined, at?: string, assume?: Assume, signal?: AbortSignal, tier?: Tier): Promise<RouteRecord | null> {
  try {
    const answer = await api<unknown>("/routing/evaluate", { method: "POST", signal,
      body: JSON.stringify({ ...(policy ? { policy } : {}), ...(at ? { at } : {}), ...(assume ? { assume } : {}), ...(tier ? { tier } : {}) }) });
    return routeRecord(answer);
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 405)) return null;
    throw e;
  }
}

export async function readChoices(limit = 20, signal?: AbortSignal): Promise<Choice[] | null> {
  try {
    const answer = await api<{ choices?: unknown }>(`/routing/choices?limit=${limit}`, { signal });
    return list(answer.choices, (v) => {
      const c = v as Partial<Choice> | null;
      return c && text(c.dispatchId) && text(c.taskId) && c.route
        ? { dispatchId: c.dispatchId, taskId: c.taskId, route: routeRecord(c.route), ...(text(c.executorName) ? { executorName: c.executorName } : {}) } : null;
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

export async function readReadings(signal?: AbortSignal): Promise<Readings | null> {
  try {
    const r = await api<Record<string, unknown>>("/routing/readings", { signal });
    const s = r.spend as Partial<Spend> | undefined;
    const byKey = s?.byKey && typeof s.byKey === "object"
      ? Object.fromEntries(Object.entries(s.byKey).filter(([, v]) => typeof v === "number")) as Record<string, number> : {};
    return {
      ...(text(r.at) ? { at: r.at } : {}),
      ...(typeof r.staleAfterSeconds === "number" ? { staleAfterSeconds: r.staleAfterSeconds } : {}),
      ...(s && text(s.day) && typeof s.totalUsd === "number" ? { spend: { day: s.day, totalUsd: s.totalUsd, byKey,
        ...(typeof s.capUsd === "number" ? { capUsd: s.capUsd } : {}), ...(text(s.utcOffset) ? { utcOffset: s.utcOffset } : {}),
        ...(text(s.resetsAt) ? { resetsAt: s.resetsAt } : {}), ...(text(s.note) ? { note: s.note } : {}), ...(text(s.noteZh) ? { noteZh: s.noteZh } : {}) } } : {}),
    };
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

/** The oldest observation among a record's readings, for "read N min ago". */
export function oldestReading(record: RouteRecord): number | null {
  const times = record.candidates.flatMap((c) => c.readings.map((r) => (r.observedAt ? Date.parse(r.observedAt) : NaN))).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

/** A stretch of time and whom Core would choose in it (null: none, new executors wait). */
export interface Segment { from: string; to: string; chosen: string | null }
/** Whom Core would choose across a stretch of time, by a policy (a draft, or
 * the saved one), keeping the readings it has now and varying only the time
 * (YN-34 S3b). Null when this Core can't simulate routing yet. */
export async function simulate(policy: Policy | undefined, from: string, to: string, stepMinutes: number, assume?: Assume, signal?: AbortSignal,
  tier?: Tier): Promise<Segment[] | null> {
  try {
    const answer = await api<{ segments?: unknown }>("/routing/simulate", { method: "POST", signal,
      body: JSON.stringify({ ...(policy ? { policy } : {}), from, to, stepMinutes, ...(assume ? { assume } : {}), ...(tier ? { tier } : {}) }) });
    return list(answer.segments, (v) => {
      const s = v as Partial<Segment> | null;
      return s && text(s.from) && text(s.to) && Number.isFinite(Date.parse(s.from)) && Number.isFinite(Date.parse(s.to))
        ? { from: s.from, to: s.to, chosen: text(s.chosen) ? s.chosen : null } : null;
    });
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 405)) return null;
    throw e;
  }
}
