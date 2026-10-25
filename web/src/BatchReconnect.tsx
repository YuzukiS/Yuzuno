import { useEffect, useState } from "react";
import { LoaderCircle, RotateCw } from "lucide-react";
import { reconnectOffer } from "./agent-actions";
import {
  batchCandidates,
  busy,
  choose,
  choosable,
  forgetSettled,
  forgetStale,
  reconnectBatch,
  remember,
  useBatch,
  type BatchOutcome,
} from "./batch-reconnect";
import { Modal } from "./components";
import { ALL_PROJECTS, inScope, type ProjectScope } from "./projects";
import type { Agent } from "./types";
import "./batch-reconnect.css";

const reported: Record<Agent["status"], string> = {
  idle: "Ready",
  working: "Working",
  waiting: "Waiting for you",
  offline: "Offline",
  error: "Needs a look",
  uncertain: "Result unconfirmed",
};

/** What a row says: what its reconnect answered, or how Core lists it now. */
function stateText(agent: Agent, outcome: BatchOutcome | undefined): string {
  switch (outcome?.state) {
    case "waiting":
      return "Waiting…";
    case "running":
      return "Reconnecting…";
    case "failed":
      return `Couldn’t reconnect: ${outcome.error}`;
    case "skipped":
      return `Skipped: ${outcome.reason}`;
    case "done": {
      const after = outcome.agent;
      if (!after) return "Reconnected";
      const offer = reconnectOffer(after);
      if (offer === "connecting") return "Core is still connecting";
      if (offer === "check") return "Result unconfirmed";
      if (offer === "reconnect") return "Still offline";
      return `Connected · ${reported[after.status]}`;
    }
  }
  const offer = reconnectOffer(agent);
  if (offer === "reconnect" && agent.disconnectedAt) return "Disconnected by you; tick it to reconnect it";
  return offer === "connecting" ? "Reconnecting…" : offer === "check" ? "Result unconfirmed" : "Offline";
}

/**
 * Reconnecting several Agents at once, for example after Core restarted
 * (T-184): a rail button, shown while any Agent can be reconnected, opens a
 * list of them. Nothing is chosen for the user. Each chosen Agent goes
 * through the same reconnect as its own menu, a few at a time; nothing is
 * sent, closed Agents are not listed, and each row says what Core answered.
 */
export function BatchReconnect({
  workspaceId,
  agents,
  scope,
  onSettled,
}: {
  workspaceId: string;
  /** The Workspace's Agents, closed ones included (they are left out). */
  agents: Agent[];
  /** The list's project scope: the dialog's default view. */
  scope: ProjectScope;
  /** After each reconnect, to read the Workspace again. */
  onSettled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  const batch = useBatch(workspaceId);
  // What a queued reconnect is checked against before it is sent.
  useEffect(() => remember(workspaceId, agents), [workspaceId, agents]);
  const candidates = batchCandidates(agents);
  const count = candidates.filter(choosable).length;
  const running = busy(batch);
  // Kept while a batch runs, so its results can be opened again.
  if (!count && !open && !running) return null;

  const wide = everywhere || scope === ALL_PROJECTS;
  // A failure stays listed while the Agent still needs a reconnect; one
  // reconnected since (from its menu, say) is not shown as failed again.
  const listed = (agent: Agent) => {
    const outcome = batch.outcomes.get(agent.id);
    return candidates.includes(agent) || (!!outcome && outcome.state !== "failed");
  };
  const rows = agents.filter((agent) => listed(agent) && (wide || inScope(agent, scope)));
  const elsewhere = scope === ALL_PROJECTS ? 0 : candidates.filter((agent) => !inScope(agent, scope)).length;
  const pending = (id: string) => {
    const state = batch.outcomes.get(id)?.state;
    return state === "waiting" || state === "running";
  };
  // Only what the dialog shows runs: a choice hidden by the scope does not.
  const ready = rows.filter((agent) => batch.selected.has(agent.id) && choosable(agent) && !pending(agent.id));
  // One the user disconnected is reconnected only when they tick it
  // themselves, never by Select all (T-184).
  const offered = rows.filter((agent) => choosable(agent) && !pending(agent.id) && !agent.disconnectedAt);
  const readyOffered = ready.filter((agent) => !agent.disconnectedAt);
  // Said again for a screen reader as answers come in.
  const counts = { reconnected: 0, notYet: 0, failed: 0, skipped: 0, going: 0 };
  for (const agent of rows) {
    const outcome = batch.outcomes.get(agent.id);
    if (outcome?.state === "waiting" || outcome?.state === "running") counts.going++;
    else if (outcome?.state === "failed") counts.failed++;
    else if (outcome?.state === "skipped") counts.skipped++;
    else if (outcome?.state === "done") {
      if (outcome.agent && reconnectOffer(outcome.agent) === null) counts.reconnected++;
      else counts.notYet++;
    }
  }
  const summary = [
    counts.reconnected ? `${counts.reconnected} reconnected` : "",
    counts.notYet ? `${counts.notYet} not connected yet` : "",
    counts.failed ? `${counts.failed} couldn’t reconnect` : "",
    counts.skipped ? `${counts.skipped} skipped` : "",
    counts.going ? `${counts.going} on the way` : "",
  ].filter(Boolean).join(" · ");

  return (
    <>
      <button
        type="button"
        className="icon-button rail-reconnect"
        aria-label={count ? `Reconnect agents: ${count} not connected` : "Reconnect agents: reconnecting"}
        title="Reconnect agents"
        onClick={() => {
          forgetStale(workspaceId, new Set(candidates.filter(choosable).map((agent) => agent.id)));
          setOpen(true);
        }}
      >
        {count ? (
          <>
            <RotateCw size={13} />
            <span>{count}</span>
          </>
        ) : (
          <LoaderCircle size={13} className="spin" />
        )}
      </button>
      <Modal
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) forgetSettled(workspaceId);
        }}
        title="Reconnect agents"
        description="Agents whose session isn’t connected, for example after Core restarted. Reconnecting opens the same session; nothing is sent and drafts stay."
        className="batch-reconnect"
      >
        {elsewhere > 0 && (
          <label className="batch-scope">
            <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} />
            Include other projects ({elsewhere})
          </label>
        )}
        {rows.length === 0 ? (
          <p className="batch-empty">Every agent here is connected.</p>
        ) : (
          <ul className="batch-list" aria-label="Agents to reconnect">
            {rows.map((agent) => {
              const outcome = batch.outcomes.get(agent.id);
              const can = choosable(agent) && !pending(agent.id);
              return (
                <li key={agent.id} className="batch-row" data-state={outcome?.state ?? (can ? "idle" : "busy")}>
                  <label>
                    <input
                      type="checkbox"
                      checked={can && batch.selected.has(agent.id)}
                      disabled={!can}
                      onChange={(e) => choose(workspaceId, [agent.id], e.target.checked)}
                    />
                    <span className="batch-name">{agent.name}</span>
                    <span className="batch-machine">{agent.remote?.machine.name || "Core host"}</span>
                  </label>
                  <span className="batch-state">
                    {(outcome?.state === "running" || outcome?.state === "waiting") && (
                      <LoaderCircle size={13} className="spin" aria-hidden="true" />
                    )}
                    {stateText(agent, outcome)}
                  </span>
                  {outcome?.state === "failed" && can && (
                    <button
                      type="button"
                      className="quiet-button"
                      onClick={() => reconnectBatch(workspaceId, [agent], onSettled)}
                    >
                      Retry
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="batch-summary" role="status">
          {summary}
        </p>
        {running && (
          <p className="batch-note">
            Closing this doesn’t cancel anything: reconnects already started or queued go on, and their results stay here.
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={!offered.length && !ready.length}
            // Select all chooses what it offers; Clear unchooses every row,
            // one the user ticked themselves too (T-184).
            onClick={() =>
              readyOffered.length < offered.length
                ? choose(workspaceId, offered.map((agent) => agent.id), true)
                : choose(workspaceId, ready.map((agent) => agent.id), false)
            }
          >
            {readyOffered.length < offered.length ? "Select all" : "Clear"}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!ready.length}
            onClick={() => reconnectBatch(workspaceId, ready, onSettled)}
          >
            {running && <LoaderCircle size={15} className="spin" />}
            {ready.length ? `Reconnect ${ready.length}` : running ? "Reconnecting…" : "Reconnect"}
          </button>
        </div>
      </Modal>
    </>
  );
}
