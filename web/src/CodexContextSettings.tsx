import { RefreshCw } from "lucide-react";
import type { CodexContextSettings as Context } from "./types";

export function tokenSetting(value: string): number | null {
  if (!value.trim()) return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    throw new Error("Enter a positive whole number, or leave blank for automatic.");
  return Number(value);
}

const tokens = (n: number) => n.toLocaleString();

/** Where applying stands: one line, its tone, and whether Apply is the next step. */
function applyState(context: Context | undefined): { tone: "ready" | "done" | "wait" | "blocked"; text: string } {
  if (!context?.supported)
    return { tone: "blocked", text: "This execution machine has not reported support for these settings. Update its Codex runtime to configure them." };
  if (context.needsReconnect)
    return { tone: "wait", text: "Reload has not finished. You can save corrected settings after a rejection, then reconnect to resume this same conversation." };
  if (context.needsFirstTurn)
    return { tone: "wait", text: "This new conversation must finish its first turn before reloading. Saved context changes apply when you click Apply then." };
  if (context.settingsSubmitted)
    return { tone: "done", text: "Sent to Codex. Effective limits are only known from its native usage report." };
  return { tone: "ready", text: "Saved settings have not been submitted for reload. Save first, then apply while the conversation is idle." };
}

/**
 * Codex's context window for one Agent: what Codex reports now, the two
 * overrides, and applying them, which reloads this same conversation.
 */
export function CodexContextSettings({ context, window, compact, disabled, note, onWindow, onCompact, onApply, onRefresh, onReset }: {
  context?: Context; window: string; compact: string; disabled: boolean;
  /** The outcome of the user's last action here (save, apply, reset). */
  note?: string;
  onWindow: (value: string) => void; onCompact: (value: string) => void; onApply: () => void;
  onRefresh?: () => void;
  /** Present while overrides are saved: clears them. */
  onReset?: () => void;
}) {
  const supported = !!context?.supported;
  const observed = context?.observedWindowTokens ?? null;
  const requested = context?.requestedWindowTokens ?? null;
  const state = applyState(context);
  return <fieldset className="agent-setting codex-context-settings" disabled={disabled}>
    <legend>Context window</legend>
    <div className="codex-context-reported">
      <div className="codex-context-reported-head">
        <span>Available window</span>
        {onRefresh && <button type="button" className="icon-button" aria-label="Refresh context status" title="Refresh context status" onClick={onRefresh}>
          <RefreshCw size={13} />
        </button>}
      </div>
      <p className="codex-context-figure">
        {observed == null ? <strong>Unknown</strong> : <><strong>{tokens(observed)}</strong> tokens</>}
        {observed != null && context?.observedStale && <span className="codex-context-stale">last known</span>}
      </p>
      <small>{observed == null ? "Codex has not reported it yet." : "As Codex last reported it; the usage meter uses this."}</small>
      {requested != null && observed != null && requested !== observed &&
        <small className="codex-context-differs">Differs from the saved request ({tokens(requested)} tokens): model limits and the output reserve can lower it.</small>}
    </div>
    <div className="codex-context-fields">
      <label>Window
        <span className="codex-context-input">
          <input aria-label="Context window tokens" inputMode="numeric" value={window}
            disabled={!supported} placeholder="Automatic"
            onChange={(event) => onWindow(event.target.value)} />
          <span aria-hidden="true">tokens</span>
        </span>
        <small>
          Blank uses Codex’s configuration{context?.inheritedContextWindow != null ? ` (${tokens(context.inheritedContextWindow)})` : ""}.
        </small>
      </label>
      <label>Compact at
        <span className="codex-context-input">
          <input aria-label="Auto-compaction threshold" inputMode="numeric" value={compact}
            disabled={!supported} placeholder={window ? "90% of window" : "Automatic"}
            onChange={(event) => onCompact(event.target.value)} />
          <span aria-hidden="true">tokens</span>
        </span>
        <small>
          {window
            ? "Blank uses 90% of the window."
            : `Blank uses Codex’s configuration${context?.inheritedAutoCompactTokenLimit != null ? ` (${tokens(context.inheritedAutoCompactTokenLimit)})` : ""}.`}
        </small>
      </label>
    </div>
    <details className="codex-context-more">
      <summary>How these apply</summary>
      <p>A custom value applies only to this Agent. Codex may lower the window to the model’s limit and reserve space for output.</p>
      <p>With a custom window, automatic compaction uses 90% of it and replaces any lower inherited threshold; Codex can clamp it further.</p>
      <p>Applying reloads this same conversation while it is idle: running turns and pending approvals finish first.</p>
    </details>
    <div className="codex-context-apply" data-tone={state.tone}>
      {/* The last action's outcome stands in for a routine state; a state
          that blocks applying always shows. */}
      <p role="status">{note && state.tone !== "blocked" && state.tone !== "wait" ? note : state.text}</p>
      {note && (state.tone === "blocked" || state.tone === "wait") && <p className="codex-context-note">{note}</p>}
      <div className="codex-context-actions">
        {onReset && <button type="button" className="quiet-button" onClick={onReset}>Reset to automatic</button>}
        <button type="button" className="secondary-button" disabled={!supported || !context?.canApply} onClick={onApply}>Apply now</button>
      </div>
    </div>
  </fieldset>;
}
