import { useEffect, useRef, useState } from "react";
import { LoaderCircle, SquareTerminal } from "lucide-react";
import { api, errorText } from "./api";
import { Modal } from "./components";
import type { Agent } from "./types";
import "./codex-changes.css";
import "./codex-terminals.css";

/** One background terminal as Codex lists it, by its number and the tool call that started it. */
export interface BackgroundTerminal {
  processId: string;
  itemId: string;
  command: string;
  cwd: string;
  inRunningTurn: boolean;
}

export interface TerminalListing {
  state: "listed" | "unavailable" | "failed";
  reason: string;
  detail: string | null;
  generation: number | null;
  threadId: string | null;
  terminals: BackgroundTerminal[];
  complete: boolean;
}

interface Outcome {
  processId: string;
  itemId: string;
  outcome: "stopped" | "gone" | "replaced" | "not_stopped" | "refused" | "unsupported" | "unknown" | "not_sent";
  sent: boolean;
  detail: string | null;
}

interface StopReport {
  state: "done" | "unavailable" | "busy";
  reason: string;
  generation: number | null;
  outcomes: Outcome[];
  after: TerminalListing | null;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The most terminals one stop names: Core checks each one just before stopping it, and refuses more. */
export const STOP_AT_ONCE = 100;

const unavailable: Record<string, string> = {
  not_connected: "This Agent isn't connected to Codex. Nothing is listed or stopped here, and nothing connects by itself.",
  closed: "This Agent is closed.",
  harness: "Background terminals here are Codex's.",
  no_thread: "This Agent has no Codex conversation yet, so it has no background terminals.",
  old_protocol: "This Agent's Codex can't list its background terminals; a newer Codex can.",
  target_changed: "This Agent's connection or conversation changed since the list was read, so nothing was stopped. Refresh to list it again.",
  busy: "A stop is already running for this Agent.",
};

function outcomeText(o: Outcome) {
  switch (o.outcome) {
    case "stopped": return "Stopped.";
    case "gone": return o.sent ? "It ended before Codex stopped it." : "It had already ended; nothing was sent.";
    case "replaced": return "Its number now names another terminal, so nothing was sent.";
    case "not_stopped": return o.detail === "unchecked"
      ? "Codex didn't stop it, and whether it still runs couldn't be checked."
      : "Codex didn't stop it; it is still running.";
    case "refused": return `Codex refused: ${o.detail ?? "no reason given"}`;
    case "unsupported": return "This Agent's Codex can't stop background terminals.";
    case "unknown": return "No answer came, so whether it stopped isn't known. It isn't sent again; the list below is a fresh check.";
    case "not_sent": return `Not sent: ${o.detail === "connection" ? "the connection changed" : o.detail === "unknown" ? "an earlier stop got no answer"
      : o.detail === "unsupported" ? "this Codex can't stop background terminals" : o.detail ? `the check before it failed (${o.detail})` : "an earlier stop ended the run"}.`;
  }
}

/**
 * `/ps` and `/stop` (T-29): the commands Codex keeps running in this Agent's
 * conversation after their tool call returned, read once when this opens on
 * the Agent's current connection.
 *
 * - `/ps` only lists them. `/stop` lists them with one explicit button for a
 *   terminal and one for every terminal listed; the button says which. Core
 *   checks each just before stopping it and never stops one that was not
 *   listed here, so a terminal started later is never stopped by it.
 * - Closing without pressing Stop changes nothing. A pressed Stop is never
 *   sent again by itself; what Codex answered is shown with a fresh list.
 * - The Turn is never interrupted, and nothing connects for this.
 */
export function CodexTerminalsDialog({ agent, mode, open, onOpenChange }: {
  agent: Agent;
  /** list: /ps; stop: /stop. */
  mode: "list" | "stop";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [listing, setListing] = useState<TerminalListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState<string | null>(null);
  const [report, setReport] = useState<StopReport | null>(null);
  const requests = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const path = `/agents/${encodeURIComponent(agent.id)}/codex/terminals`;

  async function read() {
    requests.current?.abort();
    const own = new AbortController();
    requests.current = own;
    setLoading(true);
    setError("");
    try {
      const listed = await api<TerminalListing>(path, { signal: own.signal });
      if (requests.current === own) setListing(listed);
    } catch (e) {
      if (requests.current === own) setError(errorText(e));
    }
    if (requests.current === own) setLoading(false);
  }

  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
      requests.current?.abort();
    };
    // One read when it opens; later ones only by Refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** One press, one request: the terminals named here, as they were listed. */
  async function stop(targets: BackgroundTerminal[], label: string) {
    if (busy.current || !listing || listing.state !== "listed" || listing.generation === null || !listing.threadId) return;
    busy.current = true;
    setStopping(label);
    setReport(null);
    setError("");
    try {
      const answer = await api<StopReport>(`${path}/stop`, {
        method: "POST",
        body: JSON.stringify({ generation: listing.generation, threadId: listing.threadId,
          targets: targets.map(({ processId, itemId }) => ({ processId, itemId })) }),
      });
      if (!alive.current) return;
      setReport(answer);
      if (answer.after) setListing(answer.after);
    } catch (e) {
      if (alive.current) setError(`Couldn't send the stop: ${errorText(e)}. Whether anything stopped isn't known; Refresh to list again.`);
    } finally {
      busy.current = false;
      if (alive.current) setStopping(null);
    }
  }

  const machine = agent.remote?.machine.name || "Core host";
  const terminals = listing?.state === "listed" ? listing.terminals : [];
  const canStop = mode === "stop" && listing?.state === "listed" && !stopping && !loading;
  return (
    <Modal open={open} onOpenChange={onOpenChange} wide className="codex-changes codex-terminals"
      title={mode === "stop" ? "Stop background terminals" : "Background terminals"}
      description={`Commands Codex keeps running in this conversation · ${agent.name}`}>
      <div className="changes-body">
        <section className="terminals-scope" aria-label="Where">
          <span className="changes-note">
            On {machine}, in this Agent's Codex conversation (folder <span className="changes-path">{agent.cwd}</span>), on its current connection.
          </span>
          {mode === "stop" && (
            <span className="changes-note">
              Stop acts only on the terminals named on its button, as listed here; one started later is not stopped. The Agent's turn is
              not interrupted.
            </span>
          )}
        </section>
        {loading && <p role="status"><LoaderCircle size={12} className="spin" /> Listing background terminals…</p>}
        {!loading && error && <p role="alert" className="remote-field-error">{error}</p>}
        {report && report.state !== "done" && (
          <p role="alert" className="remote-field-error">{unavailable[report.reason] ?? `Nothing was stopped (${report.reason}).`}</p>
        )}
        {report?.state === "done" && (
          <section className="terminals-outcomes" aria-label="What happened">
            <h3 className="terminals-heading">What happened</h3>
            <ul>
              {report.outcomes.map((o) => (
                <li key={o.processId} data-outcome={o.outcome}>
                  <span className="changes-path">process {o.processId}</span>: {outcomeText(o)}
                </li>
              ))}
            </ul>
            {!report.after && <p className="changes-note">The connection changed, so no fresh list was read.</p>}
          </section>
        )}
        {!loading && listing && listing.state !== "listed" && (
          <p role="status" className={listing.state === "failed" ? "remote-field-error" : "remote-field-note"}>
            {listing.state === "failed"
              ? `Couldn't list them: ${listing.reason === "no_answer" ? "no answer from Codex" : "Codex refused"}${listing.detail ? ` (${listing.detail})` : ""}.`
              : unavailable[listing.reason] ?? `Nothing was listed (${listing.reason}).`}
          </p>
        )}
        {!loading && listing?.state === "listed" && (
          <section className="changes-file" aria-label="Background terminals">
            <h3 className="terminals-heading">
              {report ? "Running now (a fresh check)" : "Running now"} · {plural(terminals.length, "terminal")}
            </h3>
            {!terminals.length ? <p className="changes-note">No background terminals are running in this conversation.</p> : (
              <ol className="terminals-list">
                {terminals.map((t) => (
                  <li key={`${t.processId}:${t.itemId}`}>
                    <div className="changes-edit-heading">
                      <SquareTerminal size={14} />
                      <code className="terminals-command">{t.command || "(no command reported)"}</code>
                      {mode === "stop" && (
                        <button type="button" className="secondary-button" disabled={!canStop}
                          onClick={() => void stop([t], `process ${t.processId}`)}>
                          Stop process {t.processId}
                        </button>
                      )}
                    </div>
                    <span className="changes-note">process {t.processId} · in <span className="changes-path">{t.cwd}</span></span>
                    {t.inRunningTurn && (
                      <span className="changes-note">Started by a command of the running turn: stopping it can change what that turn is doing.</span>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {!listing.complete && <p className="changes-note">There are more background terminals than this list shows.</p>}
            {mode === "stop" && terminals.length > 1 && terminals.length <= STOP_AT_ONCE && (
              <button type="button" className="secondary-button" disabled={!canStop}
                onClick={() => void stop(terminals, `the ${terminals.length} listed`)}>
                Stop these {terminals.length} listed terminals
              </button>
            )}
            {mode === "stop" && terminals.length > STOP_AT_ONCE && (
              <p className="changes-note">Stopping every listed terminal at once is offered for up to {STOP_AT_ONCE}; stop these one at a time.</p>
            )}
          </section>
        )}
        {stopping && <p role="status"><LoaderCircle size={12} className="spin" /> Stopping {stopping}…</p>}
        <p className="remote-field-note changes-scope">
          Listed from Codex, not from the conversation's history. {mode === "list" ? "Nothing here stops a terminal; /stop does. " : ""}
          Yuzuno's own Jobs are not shown or stopped here.
        </p>
      </div>
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={loading || !!stopping} onClick={() => { setReport(null); void read(); }}>Refresh</button>
        <button type="button" className="secondary-button" onClick={() => onOpenChange(false)}>Close</button>
      </div>
    </Modal>
  );
}
