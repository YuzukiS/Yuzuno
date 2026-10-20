import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, Plug } from "lucide-react";
import { api } from "./api";
import type { Agent } from "./types";
import "./claude-mcp-status.css";

type Server = { name: string; status: string; reason?: string };
type View = {
  state: string; reason: string; generation: number | null; sessionId: string | null;
  checkedAt: string | null; stale: boolean; freshForSeconds: number;
  observation: { observedAt: string; servers: Server[]; total: number; truncated: boolean } | null;
};

const statuses: Record<string, string> = {
  connected: "Connected", failed: "Failed", "needs-auth": "Needs authentication",
  pending: "Connecting", disabled: "Disabled", unknown: "Unknown",
};
const reasons: Record<string, string> = {
  authentication: "Authentication was rejected. Check this service in Claude Code.",
  timeout: "The service did not respond in time.",
  executable: "Claude Code could not start the service executable.",
  connection: "Claude Code could not connect to the service.",
  configuration: "Claude Code reported a configuration problem.",
  failed: "Claude Code reported a failure. Check its MCP settings for details.",
};
const notices: Record<string, string> = {
  closed: "This Agent is closed. Current MCP status is unavailable.",
  remote_unavailable: "MCP status is unavailable for this remote runtime.",
  initializing: "Claude Code is still connecting. Refresh when it is ready.",
  not_connected: "Claude Code is disconnected or has not started. Current MCP status is unavailable.",
  unsupported: "This Claude runtime does not support MCP status queries.",
  changed: "The Claude session changed during the read. Refresh to check the current session.",
  read_failed: "Could not read MCP status. Try refreshing.",
  expired: "This observation is over a minute old. Refresh to check current status.",
  not_observed: "MCP status has not been checked for this connection.",
};

/** Remount before painting a different Agent/session/environment's observation. */
export function ClaudeMcpStatus({ agent }: { agent: Agent }) {
  const identity = JSON.stringify([agent.id, agent.cwd, agent.claudeSessionId,
    agent.remote?.machine.id, agent.remote?.runtime?.instanceId, agent.connectionState, agent.closedAt]);
  return <StatusPanel key={identity} agent={agent} />;
}

function StatusPanel({ agent }: { agent: Agent }) {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const active = useRef(true);
  const pending = useRef(false);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const path = `/agents/${encodeURIComponent(agent.id)}/claude/mcp-status`;
  const load = async (refresh: boolean) => {
    if (pending.current) return;
    pending.current = true;
    const sequence = ++request.current;
    const abort = new AbortController();
    controller.current = abort;
    const timeout = window.setTimeout(() => abort.abort(), 45_000);
    setBusy(true);
    try {
      const result = await api<View>(path, { signal: abort.signal,
        ...(refresh ? { method: "POST", body: "{}" } : {}) });
      if (active.current && sequence === request.current) {
        setView(result); setFailed(false); setNow(Date.now());
      }
    } catch {
      // Native or proxy error text is not a display-safe status response.
      if (active.current && sequence === request.current) setFailed(true);
    } finally {
      window.clearTimeout(timeout);
      if (active.current && sequence === request.current) { pending.current = false; setBusy(false); }
    }
  };
  useEffect(() => {
    active.current = true;
    void load(false);
    // Age the label locally; this timer makes no API/native requests.
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => { active.current = false; ++request.current; pending.current = false;
      controller.current?.abort(); window.clearInterval(timer); };
  }, [path]);

  const observation = view?.observation;
  const expired = !!observation && now - Date.parse(observation.observedAt) >= (view?.freshForSeconds ?? 60) * 1000;
  const disconnected = agent.connectionState !== "connected" || !!agent.closedAt;
  const stale = failed || disconnected || view?.stale || expired;
  const notice = failed ? notices.read_failed : disconnected
    ? (agent.closedAt ? notices.closed : agent.connectionState === "connecting" ? notices.initializing : notices.not_connected)
    : expired && view?.state === "ready" ? notices.expired : notices[view?.reason ?? ""];
  const hasAuth = observation?.servers.some(server => server.status === "needs-auth");
  return <section className="inspector-section claude-mcp-status" aria-label="Claude MCP services">
    <div className="section-title">
      <h2><Plug size={14} />MCP services</h2>
      <button type="button" className="icon-button" aria-label="Refresh MCP status" title="Refresh MCP status"
        disabled={busy || disconnected} onClick={() => void load(true)}>
        <RefreshCw size={13} className={busy ? "mcp-refreshing" : undefined} />
      </button>
    </div>
    <p className="mcp-status-note" role="status">
      {busy ? "Reading Claude Code status…" : notice ?? (view?.state === "ready" ? "Reported by this Claude Code session." : "Status unknown.")}
    </p>
    {observation && <>
      <p className="mcp-observed">{stale ? "Previous observation" : "Observed"} · <time dateTime={observation.observedAt}>
        {new Date(observation.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </time></p>
      {observation.servers.length === 0 ? <p className="mcp-status-note">{stale ? "No services were reported then." : "No MCP services reported."}</p> :
        <ul className="mcp-server-list" data-stale={stale || undefined}>
          {observation.servers.map((server, index) => <li key={`${index}:${server.name}`}>
            <div className="mcp-server-heading"><span className="mcp-server-name">{server.name}</span>
              <span className="mcp-server-state" data-state={stale ? "unknown" : server.status}>
                {statuses[server.status] ?? statuses.unknown}
              </span></div>
            {server.status === "failed" && <p>{reasons[server.reason ?? "failed"] ?? reasons.failed}</p>}
          </li>)}
        </ul>}
      {observation.truncated && <p className="mcp-status-note">Showing {observation.servers.length} of {observation.total} reported services.</p>}
    </>}
    {hasAuth && <p className="mcp-auth-help">Authenticate through <code>/mcp</code> in Claude Code on the Core host, in this Agent’s folder, then refresh.
      {" "}<a href="https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers" target="_blank" rel="noreferrer">Authentication help <ExternalLink size={11} /></a>
    </p>}
  </section>;
}
