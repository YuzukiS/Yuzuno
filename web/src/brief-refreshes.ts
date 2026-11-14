/** Home cards that refresh themselves (YN-113 R4): Core's list of every
 * refresh and its limits, the user's save against the version read, and the
 * words Settings shows them in. The timer and the writes are Core's
 * (core/src/project_brief/refresh.rs, refresh_writes.rs). */
import { API_BASE, NetworkError, api } from "./api";
import type { Language } from "./i18n";

export type RefreshReason = { code: string; message: string; messageZh?: string };
export type RefreshCadence = { every: "day" | "hours" | "week"; at?: string; hours?: number; days?: number[] };
export type RefreshRun = {
  slot: string;
  missed: number;
  state: "sent" | "refreshed" | "failed" | "skipped";
  reason?: RefreshReason;
  turnId?: string;
  sentAt?: string;
  endedAt?: string;
  manual?: string;
};
/** A slot waiting for its owner (`GET /api/brief-refreshes`). */
export type RefreshWaiting = { reason: "busy" | "offline" | "approval" | "refused" | string; agentId?: string; agentName?: string | null; slot: string; missed: number; since: string; error?: string | null };
export type RefreshRecent = { slot: string; state: string; missed: number; reason?: RefreshReason };
/** One refresh as Core lists it, its card's name included. */
export type RefreshItem = {
  projectId: string;
  projectName: string | null;
  identity: number;
  key: string;
  title: string | null;
  live: boolean;
  version: number;
  cadence: RefreshCadence;
  zone: string;
  utcOffset: string;
  instruction: string;
  enabled: boolean;
  pausedReason: RefreshReason | null;
  weeklyRuns: number;
  nextAt: string | null;
  lastSlot: string | null;
  run: RefreshRun | null;
  recent: RefreshRecent[];
  failures: number;
  waiting: RefreshWaiting | null;
  versions: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
};
export type RefreshLimits = {
  version: number;
  minHours: number;
  maxActive: number;
  pauseAfterFailures: number;
  ranges: { minHours: [number, number]; maxActive: [number, number]; pauseAfterFailures: [number, number] };
};
export type RefreshList = {
  limits: RefreshLimits;
  total: { cards: number; active: number; weeklyRuns: number };
  items: RefreshItem[];
};

/** A save Core refused: a newer version was saved (`current`), or a field or
 * a limit isn't accepted (`code`). */
export class RefreshRefused extends Error {
  constructor(message: string, readonly code: string, readonly current?: RefreshItem | RefreshLimits) {
    super(message);
    this.name = "RefreshRefused";
  }
}

async function send<T>(path: string, method: "GET" | "PUT", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Yuzuno-Client": "desktop" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof TypeError) throw new NetworkError(error);
    throw error;
  }
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* a plain HTTP error */ }
  if (response.ok) return parsed as T;
  const message = typeof parsed.error === "string" ? parsed.error : text || `HTTP ${response.status}`;
  const code = typeof parsed.code === "string" ? parsed.code : response.status === 409 ? "version_conflict" : "refused";
  const current = parsed.current && typeof parsed.current === "object" ? parsed.current as RefreshItem | RefreshLimits : undefined;
  throw new RefreshRefused(message, code, current);
}

export const readRefreshes = (signal?: AbortSignal): Promise<RefreshList> =>
  api<RefreshList>("/brief-refreshes", { signal });

/** Saves one refresh against the version the page read. */
export const saveRefresh = (projectId: string, identity: number, change: { version: number; enabled?: boolean }): Promise<RefreshItem> =>
  send<RefreshItem>(`/projects/${encodeURIComponent(projectId)}/brief/refreshes/${identity}`, "PUT", change);

/** Saves the three limits against the version the page read. */
export const saveRefreshLimits = (limits: RefreshLimits, values: { minHours: number; maxActive: number; pauseAfterFailures: number }): Promise<RefreshLimits> =>
  send<RefreshLimits>("/brief-refreshes/limits", "PUT", { version: limits.version, ...values });

/** A refresh's schedule in the reader's words: its time, and its zone when
 * that is not this machine's. */
export function cadenceText(cadence: RefreshCadence, zone: string, language: Language): string {
  const zh = language === "zh-Hans";
  const at = cadence.at || "00:00";
  const where = zone === "UTC" ? " UTC" : "";
  if (cadence.every === "hours") {
    const hours = cadence.hours ?? 1;
    return zh ? `每 ${hours} 小时，从 ${at} 起${where}` : `Every ${hours} hours from ${at}${where}`;
  }
  const days = cadence.days?.length ? [...cadence.days].sort((a, b) => a - b) : [1, 2, 3, 4, 5, 6, 7];
  if (cadence.every === "week") {
    const names = days.map((day) => weekdayName(day, zh));
    return zh ? `每周${names.join("、")} ${at}${where}` : `${names.join(", ")} at ${at}${where}`;
  }
  return zh ? `每天 ${at}${where}` : `Every day at ${at}${where}`;
}

function weekdayName(day: number, zh: boolean): string {
  const names = zh ? ["一", "二", "三", "四", "五", "六", "日"] : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return names[Math.min(6, Math.max(0, day - 1))];
}

/** The Turns a refresh asks for each week: one a day, 168/N every N hours,
 * or one on each chosen day. */
export function weeklyRuns(cadence: RefreshCadence): number {
  if (cadence.every === "hours") return Math.round(168 / (cadence.hours ?? 1));
  if (cadence.every === "week") return cadence.days?.length || 7;
  return 7;
}

const clock = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

export function lastRunText(item: RefreshItem, language: Language): string {
  const zh = language === "zh-Hans";
  const run = item.run;
  if (!run) return zh ? "还没刷新" : "Not refreshed yet";
  const why = run.reason ? (zh ? run.reason.messageZh || run.reason.message : run.reason.message) : "";
  if (run.state === "refreshed") {
    const missed = run.missed > 0 ? (zh ? ` · 补跑，错过 ${run.missed} 次` : ` · caught up, ${run.missed} missed`) : "";
    return `${zh ? "已刷新" : "Refreshed"} ${clock(run.slot)}${missed}`;
  }
  if (run.state === "failed") return `${zh ? "没刷新" : "Didn't refresh"}${why ? `${zh ? "：" : ": "}${why}` : ""}`;
  if (run.state === "skipped") return `${zh ? "跳过" : "Skipped"}${why ? `${zh ? "：" : ": "}${why}` : ""}`;
  return zh ? "刷新中…" : "Refreshing…";
}

/** What a slot waiting for its owner says, or null once none waits. */
export function waitingText(item: RefreshItem, language: Language): string | null {
  const waiting = item.waiting;
  if (!waiting) return null;
  const zh = language === "zh-Hans";
  const name = waiting.agentName || (zh ? "主人" : "its owner");
  if (waiting.reason === "busy") return zh ? `等 ${name} 空闲` : `Waiting for ${name}`;
  if (waiting.reason === "offline") return zh ? `等 ${name} 连上` : `Waiting for ${name} to connect`;
  if (waiting.reason === "approval") return zh ? `${name} 在等你批准` : `${name} needs your approval`;
  return zh ? `等 ${name}` : `Waiting for ${name}`;
}

/** A moment as Settings shows it: the date and the time, in this device's
 * zone (Core's times are UTC). */
export const momentText = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
