import { useSyncExternalStore } from "react";
import type { TurnSeen } from "./attention";
import { onDeviceValueChange, saveDeviceValue } from "./device-storage";

/**
 * What this device has seen of each Agent's last Turn end (T-42), kept in
 * this browser or app only (device-storage.ts, as Appearance is): another
 * device has seen nothing of it. Per Workspace.
 */
const seenKey = (workspaceId: string) => `yuzuno.turnSeen.${workspaceId}`;
const EMPTY: TurnSeen = Object.freeze({});
// The marks as last read, by the text stored: an unchanged text is the same
// object, as useSyncExternalStore needs (readDeviceValue parses anew).
const cache = new Map<string, { text: string | null; seen: TurnSeen }>();
// This window's own saves: storage events tell only the other windows.
const listeners = new Set<() => void>();

function parsed(text: string | null): TurnSeen {
  let value: unknown = null;
  try {
    value = text === null ? null : JSON.parse(text);
  } catch {
    return EMPTY;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY;
  const seen: Record<string, number> = {};
  for (const [id, seq] of Object.entries(value)) {
    if (typeof seq === "number" && Number.isFinite(seq)) seen[id] = seq;
  }
  return seen;
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** This device's seen marks for the Workspace (none for no Workspace). */
export function readTurnSeen(workspaceId: string): TurnSeen {
  if (!workspaceId) return EMPTY;
  const text = stored(seenKey(workspaceId));
  const kept = cache.get(workspaceId);
  if (kept && kept.text === text) return kept.seen;
  const seen = parsed(text);
  cache.set(workspaceId, { text, seen });
  return seen;
}

/** Marks the Agent's Turn end `seq` seen on this device. A mark never goes
 * back, so an older read cannot undo a newer one; nothing is saved when it
 * already holds. A mark this device couldn't save still holds in this window
 * until it closes. */
export function markTurnSeen(workspaceId: string, agentId: string, seq: number) {
  if (!workspaceId) return;
  const seen = readTurnSeen(workspaceId);
  if ((seen[agentId] ?? 0) >= seq) return;
  const next = { ...seen, [agentId]: seq };
  const outcome = saveDeviceValue(seenKey(workspaceId), next);
  if (!outcome.saved) cache.set(workspaceId, { text: stored(seenKey(workspaceId)), seen: next });
  for (const listener of listeners) listener();
}

/** This device's seen marks, following saves here and in its other windows. */
export function useTurnSeen(workspaceId: string): TurnSeen {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      const other = workspaceId ? onDeviceValueChange(seenKey(workspaceId), listener) : () => {};
      return () => {
        listeners.delete(listener);
        other();
      };
    },
    () => readTurnSeen(workspaceId),
    () => EMPTY,
  );
}
