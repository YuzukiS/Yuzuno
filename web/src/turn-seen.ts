import { useSyncExternalStore } from "react";
import type { TurnSeen } from "./attention";
import { onDeviceValueChange, readDeviceValue, saveDeviceValue } from "./device-storage";

/**
 * What this device has seen of each Agent's last Turn end (T-42), kept in
 * this browser or app only (device-storage.ts, as Appearance is): another
 * device has seen nothing of it. Per Workspace.
 */
const seenKey = (workspaceId: string) => `yuzuno.turnSeen.${workspaceId}`;
const EMPTY: TurnSeen = Object.freeze({});
const cache = new Map<string, { raw: unknown; seen: TurnSeen }>();

function parsed(value: unknown): TurnSeen {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY;
  const seen: Record<string, number> = {};
  for (const [id, seq] of Object.entries(value)) {
    if (typeof seq === "number" && Number.isFinite(seq)) seen[id] = seq;
  }
  return seen;
}

/** This device's seen marks for the Workspace (none for no Workspace). */
export function readTurnSeen(workspaceId: string): TurnSeen {
  if (!workspaceId) return EMPTY;
  const raw = readDeviceValue(seenKey(workspaceId));
  const kept = cache.get(workspaceId);
  if (kept && kept.raw === raw) return kept.seen;
  const seen = parsed(raw);
  cache.set(workspaceId, { raw, seen });
  return seen;
}

/** Marks the Agent's Turn end `seq` seen on this device. A mark never goes
 * back, so an older read cannot undo a newer one; nothing is saved when it
 * already holds. */
export function markTurnSeen(workspaceId: string, agentId: string, seq: number) {
  if (!workspaceId) return;
  const seen = readTurnSeen(workspaceId);
  if ((seen[agentId] ?? 0) >= seq) return;
  saveDeviceValue(seenKey(workspaceId), { ...seen, [agentId]: seq });
}

/** This device's seen marks, following saves here and in its other windows. */
export function useTurnSeen(workspaceId: string): TurnSeen {
  return useSyncExternalStore(
    (listener) => (workspaceId ? onDeviceValueChange(seenKey(workspaceId), listener) : () => {}),
    () => readTurnSeen(workspaceId),
    () => EMPTY,
  );
}
