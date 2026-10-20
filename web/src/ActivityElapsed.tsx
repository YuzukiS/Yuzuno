import { useEffect, useState } from "react";
import { formatElapsed } from "./activity-time";

/** Only the small timer rerenders each second, not the conversation history. */
export function ActivityElapsed({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);
  // Older records may not have timing evidence. Don't count from page mount.
  if (startedAt === undefined) return null;
  return (
    <span className="activity-elapsed" role="timer" aria-live="off">
      <span aria-hidden="true">· </span>{formatElapsed(now - startedAt)}
    </span>
  );
}
