import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Monitor, RotateCw, Server, WifiOff } from "lucide-react";
import { errorText, post } from "./api";
import type { Agent } from "./types";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import "./remote.css";

export type RemoteWorkspaceAgent = Agent & {
  remote?: {
    machine: Omit<WorkspaceMachine, "kind">;
    runtime?: { socket: string; pid?: number; root?: string } | null;
  };
  connectionState?: "connecting" | "connected" | "disconnected" | "unconfirmed";
};

export function MachineBadge({ agent }: { agent: RemoteWorkspaceAgent }) {
  const machineName = agent.remote?.machine.name || "Core host";
  return (
    <span
      className="remote-machine-badge"
      title={
        agent.remote
          ? `SSH · ${agent.remote.machine.target || machineName}`
          : "Local · Core host"
      }
    >
      {agent.remote ? <Server size={12} /> : <Monitor size={12} />}
      <span>{machineName}</span>
    </span>
  );
}

export function RemoteControls({
  agent,
  disabled = false,
  onReconnected,
}: {
  agent: RemoteWorkspaceAgent;
  disabled?: boolean;
  onReconnected?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const running = useRef(false);
  useEffect(() => {
    requestId.current += 1;
    running.current = false;
    setBusy(false);
    setError("");
    return () => {
      requestId.current += 1;
    };
  }, [agent.id]);
  if (!agent.remote) return null;
  const disconnected = agent.connectionState === "disconnected";
  const connecting = agent.connectionState === "connecting" || busy;
  const unknown = !agent.connectionState || agent.connectionState === "unconfirmed" || agent.status === "uncertain";
  const needsConnection = disconnected || unknown;
  async function reconnect() {
    if (running.current || disabled) return;
    running.current = true;
    const request = ++requestId.current;
    setBusy(true);
    setError("");
    try {
      await post(`/agents/${encodeURIComponent(agent.id)}/reconnect`);
      if (request === requestId.current) onReconnected?.();
    } catch (e) {
      if (request === requestId.current) {
        setError(errorText(e));
        onReconnected?.();
      }
    } finally {
      if (request === requestId.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <div
      className={`remote-controls${needsConnection ? " remote-needs-connection" : ""}`}
    >
      <div className="remote-controls-top">
        <MachineBadge agent={agent} />
        {connecting ? (
          <span className="remote-connection-label" role="status">
            <LoaderCircle size={13} className="spin" />
            Connecting…
          </span>
        ) : needsConnection ? (
          <span className="remote-connection-label" role="status">
            <WifiOff size={13} />
            {disconnected ? "Disconnected" : "Connection unknown"}
          </span>
        ) : (
          <span className="remote-connection-label" role="status">
            <span className="status-dot idle" />
            Connected
          </span>
        )}
        {(needsConnection || connecting) && (
          <button
            type="button"
            className="quiet-button"
            disabled={disabled || connecting}
            onClick={() => void reconnect()}
          >
            <RotateCw size={13} />
            Reconnect
          </button>
        )}
      </div>
      {(needsConnection || connecting) && (
        <p className="remote-connection-note">
          {connecting
            ? "Restoring this agent’s session and recent work."
            : "This agent may still be working on its machine. Reconnect to check its latest state."}
        </p>
      )}
      {error && (
        <p className="remote-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
