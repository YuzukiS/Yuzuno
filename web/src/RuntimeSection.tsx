import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { readRuntime, runtimeView, type Fact, type MachineFacts, type RuntimeRead } from "./runtime-status";
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

function MachineCard({ machine }: { machine: MachineFacts }) {
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
    </article>
  );
}

/**
 * Runtime & versions (T-191): what this Workspace runs on, as Core and this
 * client hold it, each fact with where and when it was observed. Read-only:
 * opening it, or Read again, signs nothing in, reconnects nothing, updates
 * nothing and runs no machine check. Checks are the Machines page's.
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
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setReading(true);
    void readRuntime(controller.signal)
      .then((next) => !controller.signal.aborted && setRead(next))
      .finally(() => !controller.signal.aborted && setReading(false));
    return () => controller.abort();
  }, [active, again]);
  const view = read ? runtimeView(read) : null;
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
            </dl>
            <p className="runtime-note">Updated from Versions & updates; installing is never started here.</p>
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
              Each machine's facts are from its last check, not live. Its CLIs and their sign-in belong to that machine
              and are updated with its own tools.
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
              <MachineCard key={machine.id} machine={machine} />
            ))}
          </section>
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
