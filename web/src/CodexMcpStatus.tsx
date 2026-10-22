import { useEffect, useRef, useState } from "react";
import { Plug, RefreshCw } from "lucide-react";
import { api } from "./api";
import type { Agent } from "./types";
import "./claude-mcp-status.css";

type Server = { name: string; status: string; error: string | null; failureReason: string | null; observedAt: string };
type View = { state: string; reason: string; generation: number | null; servers: Server[]; more: number };

/** Codex's startup states, and the colour each takes in the shared list. */
const statuses: Record<string, [string, string]> = {
  starting: ["Starting", "pending"],
  ready: ["Ready at startup", "connected"],
  failed: ["Failed to start", "failed"],
  cancelled: ["Start cancelled", "disabled"],
  unknown: ["Unknown state", "unknown"],
};

const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * `/mcp` for a Codex Agent (T-29): its MCP services as they reported starting
 * on this connection, kept by Core for this connection only. Reading, or
 * Refresh, asks Codex nothing: Codex's own status list would start every
 * configured server to list it. So "ready" is what a server reported as it
 * started, not a later health check; there are no tools or sign-in states;
 * and an empty list means no report yet, not that none are configured.
 * Remounts for another Agent or connection; reads nothing while there is no
 * connection to have reported.
 */
export function CodexMcpStatus({ agent }: { agent: Agent }) {
  return <StatusPanel key={JSON.stringify([agent.id, agent.connectionState, agent.closedAt])} agent={agent} />;
}

function StatusPanel({ agent }: { agent: Agent }) {
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const connected = agent.connectionState === "connected" && !agent.closedAt;
  const path = `/agents/${encodeURIComponent(agent.id)}/codex/mcp`;
  const load = async () => {
    const sequence = ++request.current;
    setBusy(true);
    try {
      const result = await api<View>(path);
      if (sequence === request.current) { setView(result); setFailed(false); }
    } catch {
      if (sequence === request.current) setFailed(true);
    } finally {
      if (sequence === request.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (connected) void load();
    return () => { ++request.current; };
  }, [path, connected]);

  const servers = connected && view?.state === "observed" ? view.servers : [];
  const notice = agent.closedAt ? "This Agent is closed."
    : !connected || view?.reason === "not_connected" ? "Codex is not connected. Its MCP services report here once this Agent connects."
      : failed ? "Could not read the startup reports. Try again."
        : view && view.state !== "observed" ? "MCP status is unavailable."
          : view && !servers.length ? "No startup report received on this connection yet. That does not mean none are configured, or that all are fine."
            : null;
  return <section id="agent-mcp-status" tabIndex={-1} className="inspector-section claude-mcp-status" aria-label="Codex MCP services">
    <div className="section-title">
      <h2><Plug size={14} />MCP services</h2>
      <button type="button" className="icon-button" aria-label="Read MCP startup reports again" title="Read again (asks Codex nothing)"
        disabled={busy || !connected} onClick={() => void load()}>
        <RefreshCw size={13} className={busy ? "mcp-refreshing" : undefined} />
      </button>
    </div>
    <p className="mcp-status-note">
      Startup states this connection received, with when each was last seen. Codex is not asked here: ready means
      ready when it started, not checked since; tools and sign-in are not shown.
    </p>
    {notice && <p className="mcp-status-note" role="status">{notice}</p>}
    {servers.length > 0 && <ul className="mcp-server-list">
      {servers.map((server) => {
        const [label, state] = statuses[server.status] ?? statuses.unknown;
        return <li key={server.name}>
          <div className="mcp-server-heading"><span className="mcp-server-name">{server.name}</span>
            <span className="mcp-server-state" data-state={state}>{label}</span></div>
          <p className="mcp-observed">Seen <time dateTime={server.observedAt}>{time(server.observedAt)}</time></p>
          {server.failureReason === "reauthenticationRequired" && <p>Codex needs this server signed in again. Sign in with Codex on that machine, then reconnect this Agent.</p>}
          {server.error && <p>{server.error}</p>}
        </li>;
      })}
    </ul>}
    {!!view?.more && <p className="mcp-status-note">{view.more} more services reported and are not listed.</p>}
  </section>;
}
