import { useEffect, useState } from "react";
import { formatElapsed } from "./activity-time";
import { useStrings } from "./i18n";
import { turnWords } from "./turn-text";
import type { NativeTurn } from "./types";

/** How long an OpenCode Turn may show nothing before it says so (YN-48). */
export const QUIET_MS = 30_000;

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * What a running OpenCode Turn waits on, so it is never a silent "Working"
 * (YN-48): OpenCode's retry of its provider, with why the last attempt
 * failed and when it tries next; and, once the Turn has shown nothing for
 * QUIET_MS, that the model has not replied yet, with Stop and Change model.
 * Only this small part rerenders each second, not the conversation.
 */
export function OpenCodeWaiting({
  turn,
  hasOutput,
  onStop,
  onChangeModel,
}: {
  turn: NativeTurn;
  /** Whether the Turn shows anything of the Agent's yet. */
  hasOutput: boolean;
  onStop?: () => void;
  onChangeModel?: () => void;
}) {
  const t = useStrings(turnWords);
  const [now, setNow] = useState(Date.now);
  const startedAt = positive(turn._yuzunoStartedAt);
  const retry = turn._opencodeRetry;
  const next = positive(retry?.next);
  const ticking = !!retry || (!hasOutput && startedAt !== undefined);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [ticking]);
  const quiet = !hasOutput && startedAt !== undefined && now - startedAt >= QUIET_MS;
  if (!retry && !quiet) return null;
  const model = turn._opencodeModel?.name || turn._opencodeModel?.id;
  return (
    <div className="opencode-waiting" role="status">
      {retry && (
        <p className="opencode-retry">
          <span>
            <strong>{t.retrying(positive(retry.attempt) ?? null)}</strong>
            {next !== undefined && next > now && <> · {t.nextTry(formatElapsed(next - now))}</>}
          </span>
          {retry.message && <span className="opencode-retry-error">{retry.message}</span>}
        </p>
      )}
      {quiet && startedAt !== undefined && (
        <>
          <p className="opencode-quiet">
            {/* How long it has waited is the Working line's, above. */}
            <strong>{model ? t.quiet(model) : t.quietUnknown}</strong>
            <span>{t.quietDetail}</span>
          </p>
          {(onStop || onChangeModel) && (
            <div className="opencode-waiting-actions">
              {onStop && <button type="button" className="quiet-button" onClick={onStop}>{t.stop}</button>}
              {onChangeModel && <button type="button" className="quiet-button" onClick={onChangeModel}>{t.changeModel}</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
