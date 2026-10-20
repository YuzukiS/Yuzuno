import type { NativeTurn } from "./types";

const positiveTime = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;

export function activityStartedAt(
  turn: NativeTurn,
  state: "working" | "compacting",
): number | undefined {
  if (state === "compacting")
    return positiveTime(turn._yuzunoCompactionStartedAt);
  const nativeStart = positiveTime(turn.startedAt);
  return nativeStart ? nativeStart * 1000 : positiveTime(turn._yuzunoStartedAt);
}

export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}
