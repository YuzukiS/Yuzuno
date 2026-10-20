import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, post } from "./api";
import type { Agent } from "./types";
import "./codex-plan-usage.css";

type Window = {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
  observedAt: string;
};
export type CodexUsage = {
  revision: number;
  status:
    | "ready"
    | "unknown"
    | "unavailable"
    | "unsupported"
    | "disconnected"
    | "error";
  account: {
    type: string | null;
    label: string | null;
    planType: string | null;
  } | null;
  accountId: string | null;
  source: {
    generation: string;
    label: string;
    machineId: string | null;
    runtimeId: string | null;
  };
  checkedAt: string | null;
  observedAt: string | null;
  ordinaryUsageAllowed: boolean | null;
  error: string | null;
  buckets: {
    limitId: string;
    limitName: string | null;
    planType: string | null;
    primary: Window | null;
    secondary: Window | null;
    observedAt: string;
    credits: {
      hasCredits: boolean | null;
      unlimited: boolean | null;
      balance: string | null;
    } | null;
  }[];
};

// StrictMode and concurrent mounts share one read. No persistent account cache
// and no sharing across Agents or Core origins.
const reads = new Map<string, Promise<CodexUsage>>();
function read(agentId: string, force: boolean) {
  const pending = reads.get(agentId);
  if (pending) return pending;
  const path = `/agents/${encodeURIComponent(agentId)}/codex/usage`;
  const promise = (
    force ? post<CodexUsage>(path) : api<CodexUsage>(path)
  ).finally(() => {
    if (reads.get(agentId) === promise) reads.delete(agentId);
  });
  reads.set(agentId, promise);
  return promise;
}
export function duration(mins: number | null) {
  if (!mins) return "Window";
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}
function date(value: string | number | null) {
  if (value === null) return "unknown";
  const result = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isFinite(result.getTime())
    ? result.toLocaleString()
    : "unknown";
}
export function usageWindows(usage: CodexUsage, now: number) {
  return usage.buckets.flatMap((bucket) =>
    [bucket.primary, bucket.secondary].flatMap((w, index) => {
      if (!w) return [];
      const expired = w.resetsAt !== null && w.resetsAt * 1000 <= now;
      const stale =
        !Number.isFinite(Date.parse(w.observedAt)) ||
        now - Date.parse(w.observedAt) > 300_000;
      const unavailable = usage.status !== "ready";
      return [
        {
          key: `${bucket.limitId}:${index}`,
          name: `${bucket.limitName || bucket.limitId} · ${duration(w.windowDurationMins)}`,
          text: expired
            ? "Waiting for update"
            : stale || unavailable
              ? "Last report"
              : w.usedPercent === null
                ? "Unknown"
                : `${w.usedPercent}% used`,
          percent: w.usedPercent,
          expired,
          stale: stale || unavailable,
          detail: `${bucket.limitName || bucket.limitId}: ${w.usedPercent === null ? "usage unknown" : `${w.usedPercent}% used at last report`}. ${expired ? "Reset time passed; waiting for a new report." : ""} Resets: ${date(w.resetsAt)}. Observed: ${date(w.observedAt)}.`,
        },
      ];
    }),
  );
}

/**
 * One Agent's Codex plan usage as its native connection reports it: read
 * while shown, kept current by usage events, cleared on a stream reset or
 * for another Agent. Never kept on the device or shared across Agents.
 * `tick` is how often time alone rechecks the reset and staleness labels.
 * No Agent (null) reads nothing.
 *
 * A report belongs to the Agent and connection it was read for: a render
 * for any other (before the effect clears it, as when an unkeyed caller
 * switches Agents) gets none.
 */
export function useCodexUsage(
  agent: Agent | null,
  streamConnected: boolean,
  tick = 1000,
) {
  const [usage, setUsage] = useState<{
    scope: string;
    value: CodexUsage;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const request = useRef<(force?: boolean) => void>(() => {});
  const id = agent?.id ?? null;
  const connected =
    !!agent && agent.connectionState === "connected" && !agent.closedAt;
  const scope = `${id}|${connected}|${streamConnected}`;
  const previousConnection = useRef({
    id,
    connected,
    streamConnected,
  });
  useEffect(() => {
    let alive = true,
      pending = false,
      invalidated = false;
    let epoch = 0,
      latest: CodexUsage | null = null;
    const previous = previousConnection.current;
    if (
      id &&
      previous.id === id &&
      (previous.connected !== connected ||
        previous.streamConnected !== streamConnected)
    )
      reads.delete(id);
    previousConnection.current = { id, connected, streamConnected };
    setUsage(null);
    setError(false);
    setBusy(false);
    request.current = () => {};
    if (!id) return;
    const accept = (value: CodexUsage) => {
      if (latest && latest.revision > value.revision) return false;
      latest = value;
      setUsage({ scope, value });
      setError(false);
      return true;
    };
    const load = (force = false) => {
      if (!alive || pending || !connected || !streamConnected) return;
      const requestedEpoch = epoch;
      pending = true;
      setBusy(true);
      void read(id, force)
        .then(
          (value) => {
            if (alive && requestedEpoch === epoch) accept(value);
          },
          () => {
            if (alive && requestedEpoch === epoch) setError(true);
          },
        )
        .finally(() => {
          pending = false;
          if (alive) {
            setBusy(false);
            if (invalidated) {
              invalidated = false;
              load();
            }
          }
        });
    };
    request.current = load;
    const update = (event: Event) => {
      const data = (
        event as CustomEvent<{ agentId: string; usage: CodexUsage } | null>
      ).detail;
      if (!data) {
        epoch++;
        latest = null;
        setUsage(null);
        setError(false);
        if (pending) invalidated = true;
        else load();
        return;
      }
      if (data.agentId !== id) return;
      if (!accept(data.usage)) return;
      if (
        data.usage.status === "unknown" ||
        data.usage.status === "disconnected"
      )
        epoch++;
      if (data.usage.status === "unknown") {
        if (pending) invalidated = true;
        else load();
      }
    };
    window.addEventListener("yuzuno:codex-usage", update);
    load();
    // Time alone can make a reset/staleness label obsolete; never polls Core.
    const timer = window.setInterval(() => setClock(Date.now()), tick);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("yuzuno:codex-usage", update);
    };
  }, [id, connected, streamConnected, tick]);
  return {
    usage: usage?.scope === scope ? usage.value : null,
    busy,
    error,
    clock,
    connected,
    refresh: (force?: boolean) => request.current(force),
  };
}

/** Account facts only: does not mark the conversation read or refetch detail. */
export function CodexPlanUsage({
  agent,
  streamConnected,
}: {
  agent: Agent;
  streamConnected: boolean;
}) {
  const { usage, busy, error, clock, connected, refresh } = useCodexUsage(
    agent,
    streamConnected,
  );
  const live = connected && streamConnected;
  const windows = usage ? usageWindows(usage, clock) : [];
  const cooldown = usage?.checkedAt
    ? Math.max(0, 5000 - (clock - Date.parse(usage.checkedAt)))
    : 0;
  const reason = !connected
    ? "Native connection unavailable"
    : !streamConnected
      ? "Live updates disconnected"
      : error
        ? "Could not refresh; previous report retained"
        : usage?.error ||
          (usage?.status === "unavailable"
            ? usage.account?.type === "apiKey"
              ? "Not available for API-key authentication"
              : usage.account?.type
                ? `Not available for ${usage.account.type}`
                : "Not signed in"
            : usage?.status === "unknown"
              ? "Account changed; waiting for a new report"
              : usage?.status === "disconnected"
                ? "Native connection unavailable"
                : !usage
                  ? busy
                    ? "Checking…"
                    : "Unknown"
                  : windows.length === 0
                    ? "No quota windows reported"
                    : null);
  const who = [
    usage?.account?.label || usage?.account?.type,
    usage?.account?.planType,
  ]
    .filter(Boolean)
    .join(" · ");
  const source = usage
    ? `${usage.source.label} · native connection ${usage.source.generation}${usage.accountId ? ` · account ${usage.accountId}` : " · account ID not supplied"}`
    : agent.remote?.machine.name || "Core host";
  return (
    <>
      {who && (
        <div className="codex-account">
          <dt>Account</dt>
          <dd title={`${who}\n${source}`}>{who}</dd>
        </div>
      )}
      <div className="codex-plan-usage">
        <dt>Plan usage</dt>
        <dd>
          <div className="codex-plan-values" aria-live="polite">
            {reason && <span className="codex-plan-note">{reason}</span>}
            {live &&
              windows.map((w) => (
                <span
                  key={w.key}
                  title={w.detail}
                  className="codex-plan-window"
                >
                  <span>{w.name}</span>
                  <span>
                    {w.text}
                    {w.stale && !w.expired && w.percent !== null
                      ? ` · ${w.percent}%`
                      : ""}
                  </span>
                </span>
              ))}
            {usage && live && (
              <details className="codex-plan-details">
                <summary title="Account source, reset times and observation time">
                  Details
                </summary>
                <span>Shared account quota · {source}</span>
                {windows.map((w) => (
                  <span key={w.key}>{w.detail}</span>
                ))}
                {usage.buckets.map(
                  (b) =>
                    b.credits && (
                      <span key={b.limitId}>
                        {b.limitName || b.limitId} credits:{" "}
                        {b.credits.unlimited === true
                          ? "unlimited (reported)"
                          : b.credits.balance !== null
                            ? b.credits.balance
                            : b.credits.hasCredits === false
                              ? "none reported"
                              : "unknown"}
                      </span>
                    ),
                )}
                <span>
                  Ordinary usage:{" "}
                  {usage.ordinaryUsageAllowed === null
                    ? "unknown"
                    : usage.ordinaryUsageAllowed
                      ? "allowed (reported)"
                      : "not allowed (reported)"}
                </span>
                <span>
                  Observed: {date(usage.observedAt)} · Checked:{" "}
                  {date(usage.checkedAt)}
                </span>
              </details>
            )}
          </div>
          <button
            type="button"
            className="codex-plan-refresh"
            aria-label="Refresh Codex plan usage"
            aria-busy={busy}
            disabled={busy || !live || cooldown > 0}
            title={
              cooldown > 0
                ? "Recently checked; refresh available shortly"
                : "Read account usage from this Agent’s native connection"
            }
            onClick={() => refresh(true)}
          >
            <RefreshCw
              size={13}
              className={busy ? "codex-plan-spinning" : undefined}
            />
          </button>
        </dd>
      </div>
    </>
  );
}
