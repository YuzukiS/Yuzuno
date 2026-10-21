import { useEffect, useRef, useState } from "react";
import type { PendingRequest } from "./types";

/** Unsent answers to native questions (T-170): what a person chose or typed on
 * a Codex, Claude or OpenCode question card, kept in this browser so a
 * refresh, a reopened page or another Agent in between does not lose it. One
 * localStorage key per Workspace, bounded; nothing is sent anywhere, and a
 * restored answer is only filled in, never sent. */
const PREFIX = "yuzuno.request-drafts.v1:";
const MAX_ENTRIES = 30;
const MAX_CHARS = 200_000;
/** One answer larger than this is not kept, rather than pushing out others. */
const MAX_ENTRY_CHARS = 50_000;

type Entry = { answers: unknown; attempted?: true; at: number };
type Saved = { version: 1; entries: Record<string, Entry> };

const storageKey = (workspaceId: string) => PREFIX + JSON.stringify([workspaceId]);

/** The native request a card answers. Core gives the card a new id on each
 * reconnect (an action token), so the draft follows the harness's own id:
 * Codex's thread, turn and item (what Core matches a replay by), Claude's
 * request id, OpenCode's session and request id. */
export function nativeRequestKey(request: PendingRequest) {
  const p = request.params;
  const native =
    request.method === "item/tool/requestUserInput" && typeof p.turnId === "string" && typeof p.itemId === "string"
      ? ["codex", String(p.threadId ?? ""), p.turnId, p.itemId]
      : request.method === "claude/canUseTool" && typeof p.requestId === "string"
        ? ["claude", p.requestId]
        : request.method === "opencode/question" && typeof p.id === "string"
          ? ["opencode", String(p._opencodeSession ?? ""), p.id]
          : ["request", request.id];
  return JSON.stringify([request.agentId, ...native]);
}

/** null: saved data this version cannot read, which is left as it is. */
function read(workspaceId: string): Saved | null {
  const raw = localStorage.getItem(storageKey(workspaceId));
  if (!raw) return { version: 1, entries: {} };
  try {
    const saved = JSON.parse(raw);
    if (saved?.version === 1 && saved.entries && typeof saved.entries === "object" && !Array.isArray(saved.entries))
      return saved;
  } catch {
    /* damaged */
  }
  return null;
}

/** Applies `change` and keeps the newest entries within the bounds: the
 * entries saved, or null when nothing could be. */
function write(workspaceId: string, change: (entries: Record<string, Entry>) => void) {
  try {
    const saved = read(workspaceId);
    if (!saved) return null;
    change(saved.entries);
    const oldestLast = Object.keys(saved.entries).sort((a, b) => (saved.entries[b].at || 0) - (saved.entries[a].at || 0));
    let text = JSON.stringify(saved);
    while (oldestLast.length > MAX_ENTRIES || text.length > MAX_CHARS) {
      delete saved.entries[oldestLast.pop()!];
      text = JSON.stringify(saved);
    }
    if (Object.keys(saved.entries).length) localStorage.setItem(storageKey(workspaceId), text);
    else localStorage.removeItem(storageKey(workspaceId));
    return saved.entries;
  } catch {
    return null;
  }
}

/** Drops this Agent's drafts for requests it no longer has pending. */
export function pruneRequestDrafts(workspaceId: string, agentId: string, pending: readonly PendingRequest[]) {
  const live = new Set(pending.map(nativeRequestKey));
  let saved: Saved | null = null;
  try {
    saved = read(workspaceId);
  } catch {
    return;
  }
  const gone = Object.keys(saved?.entries || {}).filter((key) => {
    try {
      return JSON.parse(key)[0] === agentId && !live.has(key);
    } catch {
      return false;
    }
  });
  if (gone.length) write(workspaceId, (entries) => gone.forEach((key) => delete entries[key]));
}

/** One question card's draft. `workspaceId` null keeps nothing (a preview, or
 * a card that asks no question). `parse` reads a saved answer for this card's
 * questions, or null; what it leaves out (a secret answer) is never restored.
 * A draft is filled in only into a request that can still be answered. */
export function useRequestDraft<T>(workspaceId: string | null, request: PendingRequest, parse: (saved: unknown) => T | null) {
  const key = workspaceId === null ? null : nativeRequestKey(request);
  const sent = !!request.params._responseSent;
  const [loaded] = useState(() => {
    if (key === null || sent || request.stale) return null;
    try {
      const entry = read(workspaceId!)?.entries[key];
      const answers = entry ? parse(entry.answers) : null;
      return answers === null ? null : { answers, attempted: entry!.attempted === true };
    } catch {
      return null;
    }
  });
  const last = useRef(JSON.stringify(loaded?.answers ?? null));
  const attempted = useRef(!!loaded?.attempted);
  const [notSaved, setNotSaved] = useState(false);
  function put(answers: unknown, empty: boolean) {
    if (key === null) return;
    const keep = !empty || attempted.current;
    const entry: Entry = { answers, ...(attempted.current ? { attempted: true as const } : {}), at: Date.now() };
    if (keep && JSON.stringify(entry).length > MAX_ENTRY_CHARS) return setNotSaved(true);
    const entries = write(workspaceId!, (entries) => {
      if (keep) entries[key] = entry;
      else delete entries[key];
    });
    // Storage refused it, or saved data this version cannot read.
    setNotSaved(!entries || (keep && !(key in entries)));
  }
  function remove() {
    if (key === null) return;
    attempted.current = false;
    write(workspaceId!, (entries) => delete entries[key]);
  }
  // Core's record shows the request answered: the old input is not kept.
  useEffect(() => {
    if (sent) remove();
  }, [key, sent]);
  return {
    initial: loaded?.answers ?? null,
    /** An answer from this browser got no reply; whether it arrived is not known. */
    attempted: !!loaded?.attempted,
    notSaved,
    /** Saves what the card holds now; `empty` when nothing is chosen or typed. */
    save(answers: T, empty: boolean) {
      const text = JSON.stringify(empty ? null : answers);
      if (text === last.current || sent || request.stale) return;
      last.current = text;
      put(answers, empty);
    },
    /** Before an answer is sent (true), and after Core refused it (false). */
    attempt(on: boolean, answers: T, empty: boolean) {
      attempted.current = on;
      last.current = JSON.stringify(empty ? null : answers);
      put(answers, empty);
    },
    /** Core recorded the answer. */
    remove,
  };
}

/** A Claude or OpenCode question card's answer: options chosen and text
 * typed, by question (Claude's text, OpenCode's index). */
export type ChoiceDraft = { answers: Record<string, string[]>; free: Record<string, string> };
export function choiceAnswers(saved: unknown, keys: readonly string[]): ChoiceDraft | null {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
  const object = (value: unknown) =>
    (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const answers = object((saved as ChoiceDraft).answers);
  const free = object((saved as ChoiceDraft).free);
  return {
    answers: Object.fromEntries(keys.flatMap((key) => {
      const value = answers[key];
      return Array.isArray(value) && value.every((v) => typeof v === "string") ? [[key, value as string[]]] : [];
    })),
    free: Object.fromEntries(keys.flatMap((key) => (typeof free[key] === "string" ? [[key, free[key] as string]] : []))),
  };
}
export const choiceEmpty = (draft: ChoiceDraft) =>
  !Object.values(draft.answers).some((v) => v.length) && !Object.values(draft.free).some((v) => v.trim());
