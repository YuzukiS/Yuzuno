import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { checkModels, readRuntime, runtimeView, type Fact, type MachineFacts, type ModelChecks, type RuntimeRead } from "./runtime-status";
import { ClaudeMcpStatus } from "./ClaudeMcpStatus";
import { CodexMcpStatus } from "./CodexMcpStatus";
import type { Agent } from "./types";
import "./runtime-section.css";

const stateWord = { yes: "Yes", no: "No", unknown: "Unknown" } as const;
const timeText = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
};

/** One fact: its name, Yes / No / Unknown in words, what it says and where
 * it came from. */
function FactRow({ label, fact }: { label: string; fact: Fact }) {
  return (
    <div className="runtime-fact" data-state={fact.state}>
      <dt>{label}</dt>
      <dd>
        <span className="runtime-state">{stateWord[fact.state]}</span>
        <span className="runtime-text">{fact.text}</span>
        {fact.detail && <span className="runtime-detail">{fact.detail}</span>}
      </dd>
    </div>
  );
}

function MachineCard({ machine, onCheckModels, checkingModels = false }: {
  machine: MachineFacts;
  /** The Core host's explicit model check; other machines have none here. */
  onCheckModels?: () => void;
  checkingModels?: boolean;
}) {
  return (
    <article className="runtime-machine" aria-labelledby={`runtime-machine-${machine.id}`}>
      <header>
        <h5 id={`runtime-machine-${machine.id}`}>{machine.name}</h5>
        <span className="runtime-where">{machine.kind === "local" ? "Core host" : machine.target ?? "SSH machine"}</span>
        <p className="runtime-checked" data-stale={machine.stale || undefined}>
          {machine.checkedAt ? (
            <>
              Last checked {machine.age} (<time dateTime={machine.checkedAt}>{timeText(machine.checkedAt)}</time>)
              {machine.stale && " · older than an hour"}
            </>
          ) : (
            "Never checked"
          )}
        </p>
      </header>
      <dl>
        <FactRow label="Reached" fact={machine.reachable} />
        {machine.codexConnection && <FactRow label="Codex connection" fact={machine.codexConnection} />}
        <FactRow label="Managed Jobs" fact={machine.jobs} />
        {machine.windowsJobs && <FactRow label="Windows Jobs" fact={machine.windowsJobs} />}
      </dl>
      {machine.harnesses.map((harness) => (
        <section key={harness.harness} className="runtime-harness" aria-label={`${harness.name} on ${machine.name}`}>
          <h6>{harness.name}</h6>
          <dl>
            <FactRow label="CLI" fact={harness.cli} />
            <FactRow label="Signed in" fact={harness.signedIn} />
            <FactRow label="Models" fact={harness.models} />
          </dl>
        </section>
      ))}
      {onCheckModels && machine.kind === "local" && (
        <p className="runtime-note runtime-models-check">
          <button type="button" className="quiet-button" disabled={checkingModels} onClick={onCheckModels}>
            {checkingModels ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            {checkingModels ? "Checking models…" : "Check models"}
          </button>
          Lists the models of this host's Codex and Claude Code, as the New Agent dialog does when it opens. If Codex
          can't list them, Core marks it not connected, as the dialog would.
        </p>
      )}
    </article>
  );
}

/** MCP services as each Agent's harness reported them (T-191), one Agent at
 * a time. Claude Code: opening shows its session's last report and asks
 * nothing; only Refresh asks that session. Codex: the startup reports its
 * connection received; reading asks Codex nothing. A harness without a
 * report is named, not guessed. */
function McpServices({ agents }: { agents: Agent[] }) {
  const open = agents.filter((agent) => !agent.closedAt);
  const listed = open.filter((agent) => agent.harness === "claude" || (agent.harness ?? "codex") === "codex");
  const others = open.length - listed.length;
  const [chosen, setChosen] = useState("");
  const agent = listed.find((item) => item.id === chosen) ?? listed[0];
  const where = (item: Agent) => (item.remote ? item.remote.machine.name : "Core host");
  const label = (item: Agent) => `${item.name} · ${item.harness === "claude" ? "Claude Code" : "Codex"} · ${where(item)}`;
  return (
    <section className="runtime-group runtime-mcp" aria-labelledby="runtime-mcp">
      <h4 id="runtime-mcp">MCP services</h4>
      <p className="runtime-note">
        As each Agent's harness reported them. Claude Code: its session's last report; Refresh asks that session
        once. Codex: the startup reports its connection received; reading asks Codex nothing. Showing an Agent
        asks nothing. Configuration and sign-in stay in each CLI.
      </p>
      {agent ? (
        <>
          <label className="runtime-mcp-agent">
            <span>Agent</span>
            <select className="settings-select" value={agent.id} onChange={(event) => setChosen(event.target.value)}>
              {listed.map((item) => (
                <option key={item.id} value={item.id}>
                  {label(item)}
                </option>
              ))}
            </select>
          </label>
          {agent.harness === "claude" ? (
            <ClaudeMcpStatus agent={agent} cachedOnOpen heading={label(agent)} headingLevel={5} />
          ) : (
            <CodexMcpStatus agent={agent} heading={label(agent)} headingLevel={5} anchor={false} />
          )}
        </>
      ) : (
        <p className="runtime-note">No open Claude Code or Codex Agents to report MCP services.</p>
      )}
      {others > 0 && (
        <p className="runtime-note">
          {others === 1 ? "1 OpenCode Agent" : `${others} OpenCode Agents`}: OpenCode doesn't report MCP status to
          Yuzuno in this version.
        </p>
      )}
    </section>
  );
}

/**
 * Runtime & versions (T-191): what this Workspace runs on, as Core and this
 * client hold it, each fact with where and when it was observed. Read-only:
 * opening it, or Read again, signs nothing in, reconnects nothing, updates
 * nothing and runs no machine check. Checks are the Machines page's; the
 * Core host's Check models makes only the New Agent dialog's catalog reads.
 */
export function RuntimeSection({
  active = true,
  onOpenMachines,
}: {
  /** Read while shown; nothing is read while closed. */
  active?: boolean;
  /** Where machine checks are run; without it the section says where. */
  onOpenMachines?: () => void;
}) {
  const [read, setRead] = useState<RuntimeRead | null>(null);
  const [reading, setReading] = useState(false);
  const [again, setAgain] = useState(0);
  const [models, setModels] = useState<ModelChecks>({});
  const [checkingModels, setCheckingModels] = useState(false);
  /** Only on the button: the dialog's own catalog reads. Afterwards the
   * section reads again, since a Codex failure changes its connection. */
  async function onCheckModels() {
    if (checkingModels) return;
    setCheckingModels(true);
    try {
      setModels(await checkModels());
      setAgain((n) => n + 1);
    } finally {
      setCheckingModels(false);
    }
  }
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setReading(true);
    void readRuntime(controller.signal)
      .then((next) => !controller.signal.aborted && setRead(next))
      .finally(() => !controller.signal.aborted && setReading(false));
    return () => controller.abort();
  }, [active, again]);
  const view = read ? runtimeView(read, undefined, models) : null;
  return (
    <section id="settings-runtime" className="settings-section runtime-section" aria-labelledby="settings-runtime-title" aria-busy={reading}>
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-runtime-title">Runtime & versions</h3>
          <p>
            What this Workspace runs on, as Core and this device last knew it. Nothing here signs in, reconnects or
            updates anything.
          </p>
        </div>
        <div className="runtime-read">
          <span role="status">
            {view ? (
              <>
                Read <time dateTime={view.at}>{timeText(view.at)}</time>
                <span className="runtime-read-note"> · each source answered on its own</span>
              </>
            ) : reading ? (
              "Reading…"
            ) : (
              ""
            )}
          </span>
          <button type="button" className="quiet-button" disabled={reading} onClick={() => setAgain((n) => n + 1)}>
            {reading ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            Read again
          </button>
        </div>
      </header>
      {view && (
        <>
          <section className="runtime-group" aria-labelledby="runtime-core">
            <h4 id="runtime-core">Workspace service</h4>
            <dl>
              <FactRow label="Version" fact={view.core.version} />
              <FactRow label="Release" fact={view.core.release} />
              <FactRow label="State" fact={view.core.ready} />
              <FactRow label="Claude Agent SDK" fact={view.core.sdk} />
              <FactRow label="SDK copy" fact={view.core.sdkCopy} />
            </dl>
            <p className="runtime-note">
              Updated from Versions & updates; installing is never started here. The Claude Agent SDK is what Core's
              Claude bridge runs and comes with Core's Claude runtime; Claude Code's CLI is another program, listed
              under Machines. Reading it prepares and downloads nothing.
            </p>
          </section>
          <section className="runtime-group" aria-labelledby="runtime-client">
            <h4 id="runtime-client">This device</h4>
            <dl>
              <FactRow label="This page" fact={view.client.page} />
              <FactRow label="Desktop app" fact={view.client.desktop} />
              <FactRow label="iPhone app" fact={view.client.iphone} />
            </dl>
          </section>
          <section className="runtime-group" aria-labelledby="runtime-machines">
            <h4 id="runtime-machines">Machines</h4>
            <p className="runtime-note">
              Reached and each CLI are from the machine's last check, not live. On the Core host, Codex's connection
              and sign-in are as Core holds them now, and Managed Jobs as Core reads its budget. A machine's CLIs and
              their sign-in belong to that machine and are updated with its own tools.
              {onOpenMachines ? " " : " Checks run from the Machines page."}
              {onOpenMachines && (
                <button type="button" className="quiet-button runtime-machines-link" onClick={onOpenMachines}>
                  Check machines
                </button>
              )}
            </p>
            {view.machinesError && (
              <p className="runtime-note" role="alert">
                The machines could not be read: {view.machinesError}
              </p>
            )}
            {view.machines.map((machine) => (
              <MachineCard key={machine.id} machine={machine} onCheckModels={onCheckModels} checkingModels={checkingModels} />
            ))}
          </section>
          {read?.agents && <McpServices agents={read.agents} />}
          <dl className="runtime-group">
            <FactRow
              label="Compatibility"
              fact={{ state: "unknown", text: "Not defined", detail: "Which versions work together isn't defined for this release, so it isn't guessed from version numbers." }}
            />
          </dl>
        </>
      )}
    </section>
  );
}
