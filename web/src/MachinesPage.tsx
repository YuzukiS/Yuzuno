import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock3,
  LoaderCircle,
  Monitor,
  Pencil,
  Plus,
  Server,
  Trash2,
  Wifi,
} from "lucide-react";
import { api, errorText, remove } from "./api";
import { Avatar, Modal } from "./components";
import {
  checkAge,
  harnessLabel,
  harnessName,
  harnessTip,
  runMachineCheck,
  type MachineCheck,
} from "./machine-checks";
import { MachineEditor } from "./MachineEditor";
import { machineIdOf, projectName } from "./projects";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import type { Agent, Project } from "./types";
import "./machines.css";

/** Re-render relative times while visible; the check itself is not repeated. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** The one presentation of a stored check, shared with New agent. */
export function LastCheck({
  check,
  checking = false,
  compact = false,
  now = Date.now(),
}: {
  check?: MachineCheck | null;
  checking?: boolean;
  /** Shorter wording for New agent; failure reasons are never hidden. */
  compact?: boolean;
  now?: number;
}) {
  if (!check)
    return (
      <div className="last-check state-unknown" role="status">
        {checking ? (
          <LoaderCircle size={14} className="spin" />
        ) : (
          <CircleDashed size={14} />
        )}
        <span className="last-check-line">
          <strong>{checking ? "Checking…" : "Not checked yet"}</strong>
          {!checking && !compact && (
            <span>Test the connection to see what Core can reach.</span>
          )}
        </span>
      </div>
    );
  const age = checkAge(check, now);
  const at = new Date(check.checkedAt).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <div
      className={`last-check ${check.reachable ? "state-reached" : "state-failed"}`}
      role="status"
    >
      {checking ? (
        <LoaderCircle size={14} className="spin" />
      ) : check.reachable ? (
        <CircleCheck size={14} />
      ) : (
        <CircleAlert size={14} />
      )}
      <span className="last-check-line">
        <strong>
          {check.reachable
            ? `Reached${check.host ? ` ${check.host.hostname}` : ""}`
            : "Couldn’t reach"}
        </strong>
        <time dateTime={check.checkedAt} title={`Last checked ${at}`}>
          Last check {age.label}
        </time>
        {age.stale && (
          <span
            className="last-check-stale"
            title="An old result; it does not mean the machine is offline."
          >
            <Clock3 size={11} /> May be out of date
          </span>
        )}
      </span>
      {check.harnesses.length > 0 && (
        <span className="last-check-harnesses">
          {check.harnesses.map((h) => (
            <span
              key={h.harness}
              className={`harness-chip ${h.supported ? (h.found ? "found" : "missing") : "unsupported"}`}
              title={h.error || (h.found ? harnessTip(h) : undefined)}
            >
              {harnessLabel(h)}
            </span>
          ))}
        </span>
      )}
      {/* Reasons are visible text in every layout, including New agent:
          a failed check is a stored result, not a request error. */}
      {check.error && <p className="last-check-error">{check.error}</p>}
      {check.harnesses
        .filter((h) => h.supported && !h.found && h.error)
        .map((h) => (
          <p className="last-check-error" key={`${h.harness}-error`}>
            {harnessName(h.harness)}: {h.error}
          </p>
        ))}
      {check.defaultFolder?.error && (
        <p className="last-check-error">
          Default folder {check.defaultFolder.path}: {check.defaultFolder.error}
        </p>
      )}
    </div>
  );
}

const agentStates: Record<Agent["status"], string> = {
  idle: "Ready",
  working: "Working",
  waiting: "Waiting",
  offline: "Offline",
  error: "Needs a look",
  uncertain: "Check result",
};

export function MachinesPage({
  open,
  onOpenChange,
  agents,
  projects,
  revision,
  onOpenAgent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  projects: Project[];
  /** Workspace change counter; another window's check refreshes this list. */
  revision: number;
  onOpenAgent: (id: string) => void;
}) {
  const [machines, setMachines] = useState<WorkspaceMachine[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  // One change at a time: adding a machine, or editing or removing one.
  const [change, setChange] = useState<
    { kind: "add" } | { kind: "edit" | "remove"; id: string } | null
  >(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const load = useRef(0);
  const now = useNow(open);
  const reload = useCallback(() => {
    const generation = ++load.current;
    api<{ machines: WorkspaceMachine[] }>("/machines")
      .then((result) => {
        if (generation !== load.current) return;
        setMachines(result.machines || []);
        setLoadError("");
      })
      .catch((e) => {
        if (generation === load.current) setLoadError(errorText(e));
      });
  }, []);
  useEffect(() => {
    if (open) reload();
  }, [open, revision, reload]);
  useEffect(() => {
    if (!open) setChange(null);
  }, [open]);
  function startChange(next: typeof change) {
    setChange(next);
    setRemoveError("");
  }
  async function removeMachine(machine: WorkspaceMachine) {
    if (removing) return;
    setRemoving(true);
    setRemoveError("");
    try {
      await remove(`/machines/${encodeURIComponent(machine.id)}`);
      setMachines((list) => (list || []).filter((m) => m.id !== machine.id));
      setChange(null);
    } catch (e) {
      setRemoveError(errorText(e));
    } finally {
      setRemoving(false);
    }
  }
  async function check(machine: WorkspaceMachine) {
    if (checking[machine.id]) return;
    setChecking((c) => ({ ...c, [machine.id]: true }));
    setCheckErrors((e) => ({ ...e, [machine.id]: "" }));
    try {
      const result = await runMachineCheck(machine.id);
      setMachines((list) =>
        (list || []).map((m) =>
          m.id === machine.id ? { ...m, lastCheck: result } : m,
        ),
      );
    } catch (e) {
      setCheckErrors((errors) => ({ ...errors, [machine.id]: errorText(e) }));
    } finally {
      setChecking((c) => ({ ...c, [machine.id]: false }));
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="Machines"
      description="Where your agents run. A check shows what Core could reach at that moment; nothing checks in the background."
    >
      <div className="machines-page">
        <div className="machines-toolbar">
          <button
            type="button"
            className="secondary-button"
            aria-expanded={change?.kind === "add"}
            aria-controls="machines-new-ssh"
            disabled={!machines || change?.kind === "add"}
            onClick={() => startChange({ kind: "add" })}
          >
            <Plus size={14} /> Add SSH machine
          </button>
        </div>
        {change?.kind === "add" && (
          <MachineEditor
            id="machines-new-ssh"
            onCancel={() => setChange(null)}
            onSaved={(saved) => {
              setMachines((list) => [...(list || []), saved]);
              setChange(null);
            }}
          />
        )}
        {loadError && (
          <p role="alert" className="inline-error">
            Couldn’t load machines: {loadError}
          </p>
        )}
        {!machines && !loadError && (
          <p className="machines-loading" role="status">
            <LoaderCircle size={15} className="spin" /> Loading machines…
          </p>
        )}
        {machines?.map((machine) => {
          const here = agents.filter((a) => machineIdOf(a) === machine.id);
          const working = here.filter((a) => !a.closedAt);
          const busy = !!checking[machine.id];
          const editing = change?.kind === "edit" && change.id === machine.id;
          const confirming =
            change?.kind === "remove" && change.id === machine.id;
          return (
            <article
              className="machine-card"
              key={machine.id}
              data-machine-id={machine.id}
              aria-label={machine.name}
            >
              <header className="machine-card-heading">
                <span className="machine-icon">
                  {machine.kind === "ssh" ? (
                    <Server size={16} />
                  ) : (
                    <Monitor size={16} />
                  )}
                </span>
                <div>
                  <h3>{machine.name}</h3>
                  <span>
                    {machine.kind === "ssh"
                      ? `SSH · ${machine.target}`
                      : "Local · runs your Workspace Core"}
                  </span>
                </div>
                <div className="machine-card-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void check(machine)}
                  >
                    {busy ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Wifi size={14} />
                    )}
                    {busy ? "Checking…" : "Test connection"}
                  </button>
                  {/* The Core host is where Core runs: checked, not edited. */}
                  {machine.kind === "ssh" && (
                    <>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Edit ${machine.name}`}
                        title="Edit"
                        disabled={busy}
                        aria-pressed={editing}
                        onClick={() =>
                          startChange(
                            editing ? null : { kind: "edit", id: machine.id },
                          )
                        }
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove ${machine.name}`}
                        title="Remove"
                        disabled={busy}
                        aria-pressed={confirming}
                        onClick={() =>
                          startChange(
                            confirming
                              ? null
                              : { kind: "remove", id: machine.id },
                          )
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              </header>
              {confirming && (
                <div
                  className="machine-remove"
                  role="group"
                  aria-label={`Remove ${machine.name}`}
                >
                  <p>
                    {working.length
                      ? `${working.map((a) => a.name).join(", ")} still ${working.length === 1 ? "works" : "work"} here. Close ${working.length === 1 ? "that agent" : "those agents"} first, then remove this machine.`
                      : `Remove ${machine.name} from this workspace? Closed agents created on it keep their own settings; its last check is deleted.`}
                  </p>
                  {removeError && (
                    <p role="alert" className="inline-error">
                      {removeError}
                    </p>
                  )}
                  <div className="machine-remove-actions">
                    <button
                      type="button"
                      className="quiet-button"
                      disabled={removing}
                      onClick={() => setChange(null)}
                    >
                      {working.length ? "OK" : "Cancel"}
                    </button>
                    {!working.length && (
                      <button
                        type="button"
                        className="danger-button"
                        disabled={removing}
                        onClick={() => void removeMachine(machine)}
                      >
                        {removing ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                        Remove machine
                      </button>
                    )}
                  </div>
                </div>
              )}
              {editing && (
                <MachineEditor
                  key={machine.id}
                  machine={machine}
                  onCancel={() => setChange(null)}
                  onSaved={() => {
                    setChange(null);
                    // Core drops a check that described the old address.
                    reload();
                  }}
                />
              )}
              <LastCheck check={machine.lastCheck} checking={busy} now={now} />
              {checkErrors[machine.id] && (
                <p role="alert" className="inline-error">
                  {checkErrors[machine.id]}
                </p>
              )}
              <dl className="machine-facts">
                <div>
                  <dt>Default folder</dt>
                  <dd title={machine.defaultCwd}>
                    {machine.defaultCwd || "—"}
                  </dd>
                </div>
                {machine.kind === "ssh" && (
                  <div>
                    <dt>Codex executable</dt>
                    <dd>{machine.codex || "codex"}</dd>
                  </div>
                )}
                {machine.lastCheck?.host && (
                  <div>
                    <dt>At last check</dt>
                    <dd>
                      {machine.lastCheck.host.platform} ·{" "}
                      {machine.lastCheck.host.home}
                    </dd>
                  </div>
                )}
              </dl>
              <section
                className="machine-agents"
                aria-label={`Agents on ${machine.name}`}
              >
                <h4>
                  Agents here now <span>{here.length}</span>
                </h4>
                {here.length ? (
                  <ul>
                    {here.map((agent) => (
                      <li key={agent.id}>
                        {/* A small tile, several to a row; the folder is in its tip. */}
                        <button
                          type="button"
                          className="machine-agent"
                          onClick={() => onOpenAgent(agent.id)}
                          title={`Open ${agent.name}\n${agent.cwd}`}
                        >
                          <Avatar agent={agent} small />
                          <span className="machine-agent-name">
                            <strong>{agent.name}</strong>
                            <small>
                              {agent.projectId
                                ? projectName(agent.projectId, projects)
                                : "No project"}
                            </small>
                          </span>
                          <span className="machine-agent-state">
                            {agent.closedAt
                              ? "Closed"
                              : agentStates[agent.status]}
                            {agent.remote && !agent.closedAt
                              ? ` · ${agent.connectionState === "connected" ? "Connected" : agent.connectionState === "connecting" ? "Connecting" : "Not connected"}`
                              : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="machine-note">No agents on this machine yet.</p>
                )}
              </section>
            </article>
          );
        })}
        <p className="machine-note machines-footnote">
          Agent states come from their own sessions, not from these checks. An
          old check does not mean a machine is offline, and a found CLI does not
          mean it is signed in.
        </p>
      </div>
    </Modal>
  );
}
