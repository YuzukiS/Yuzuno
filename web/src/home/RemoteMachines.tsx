import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStrings } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
import { errorText } from "../api";
import { clockTime, mebibytes, overTotal, percent, UNKNOWN } from "./format";
import { readMachineLive } from "./home-api";
import { useHomeNavigation } from "./home-navigation";
import { previewMachineLive } from "./preview-home";
import type { LiveMachine, MachineLive } from "./types";
import { homeText } from "./home-text";
import { Tip, TipText } from "../Tip";

/** While the card is expanded and the page visible, how often it asks. One
 * request is in flight at most, and the next starts after this one ends. */
export const MACHINE_LIVE_POLL_MS = 2_000;
/** No successful answer for this long is shown as unknown: three polls. It is
 * measured on this page's monotonic clock, never against the remote's. */
export const MACHINE_LIVE_STALE_MS = 6_000;
/** A request that has not answered by then is cancelled, so reading resumes. */
export const MACHINE_LIVE_REQUEST_MS = 6_000;
/** Rows shown before "N more". */
export const MACHINE_LIVE_ROWS = 6;

type View =
  | { phase: "reading"; data: null; at: ""; reason: "" }
  | { phase: "live"; data: MachineLive; at: string; reason: "" }
  | { phase: "stale"; data: MachineLive | null; at: string; reason: string };

const START: View = { phase: "reading", data: null, at: "", reason: "" };

/**
 * The other machines' live sessions (YN-83 S1). It is mounted only while the
 * machine card is expanded and the page is visible: mounting asks at once,
 * unmounting aborts and stops the timer, so Core stops counting this page's
 * interest. Every success is timed with performance.now; the watchdog hides
 * online values after 6 s even if a request hangs. A late answer from an
 * earlier mount cannot reach this view, which starts as reading.
 */
function useMachineLive(invalidReason: string): View {
  const [view, setView] = useState<View>(START);
  // The current language's words for an untrusted answer, without restarting
  // the read when the language changes.
  const reason = useRef(invalidReason);
  reason.current = invalidReason;
  useEffect(() => {
    let stopped = false;
    /** performance.now() of the last successful answer, or of this round's
     * start until the first one: a first read that hangs still expires. */
    let last: number | null = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight: AbortController | null = null;
    const expire = (reason: string) => {
      if (stopped) return;
      last = null;
      setView((current) =>
        current.phase === "stale"
          ? reason && !current.reason
            ? { ...current, reason }
            : current
          : { phase: "stale", data: current.data, at: current.at, reason },
      );
    };
    // Independent of any request: a hung fetch cannot keep old values up.
    const watchdog = setInterval(() => {
      if (stopped || last === null) return;
      if (performance.now() - last >= MACHINE_LIVE_STALE_MS) expire("");
    }, 250);
    const sample = async () => {
      const controller = new AbortController();
      inflight = controller;
      const deadline = setTimeout(() => controller.abort(), MACHINE_LIVE_REQUEST_MS);
      try {
        const data = await readMachineLive(controller.signal);
        // Aborted or unmounted: this answer is not this view's to show.
        if (stopped || controller.signal.aborted) return;
        // Only {machines: []} means no machines. Any other shape is an answer
        // this page cannot trust: a failure, keeping the last valid rows.
        if (!data || !Array.isArray(data.machines)) {
          expire(reason.current);
          return;
        }
        last = performance.now();
        setView({ phase: "live", data, at: data.machines[0]?.observedAt ?? "", reason: "" });
      } catch (error) {
        // Our own deadline (or the unmount) is not Core's failure: the
        // watchdog turns six seconds without an answer into unknown.
        if (stopped || controller.signal.aborted) return;
        expire(errorText(error));
      } finally {
        clearTimeout(deadline);
        inflight = null;
        if (!stopped) timer = setTimeout(sample, MACHINE_LIVE_POLL_MS);
      }
    };
    void sample();
    return () => {
      stopped = true;
      clearInterval(watchdog);
      clearTimeout(timer);
      inflight?.abort();
    };
  }, []);
  return view;
}

type Reasons = ReturnType<typeof homeText>["remoteReason"];
type State = LiveMachine["state"] | "unknown";

function reasonOf(code: string | null, reasons: Reasons) {
  switch (code) {
    case "ssh_unreachable":
      return reasons.sshUnreachable;
    case "silent":
      return reasons.silent;
    case "unclean_exit":
      return reasons.uncleanExit;
    case "ssh_auth":
      return reasons.sshAuth;
    case "ssh_host_key":
      return reasons.sshHostKey;
    case "ssh_failed":
      return reasons.sshFailed;
    case "no_python":
      return reasons.noPython;
    case "python_too_old":
      return reasons.pythonTooOld;
    case "python_stand_in":
      return reasons.pythonStandIn;
    case "unsupported_platform":
      return reasons.platform;
    case "root_unsafe":
      return reasons.rootUnsafe;
    case "upload_short":
    case "upload_mismatch":
      return reasons.upload;
    case "bad_request":
    case "boot_timeout":
    case "boot_internal":
    case "boot_error":
      return reasons.boot;
    case "version":
      return reasons.version;
    case "protocol":
      return reasons.protocol;
    case "machine_invalid":
      return reasons.machineInvalid;
    default:
      return reasons.unknown;
  }
}

const DISK_BUSY = new Set(["busy", "pending", "timeout", "unanswered"]);

/** One reading: its label, its value, and a small tag where one applies. An
 * unknown is never written as 0, and reading is not the same as unknown. */
function Fact({
  name,
  label,
  value,
  tag,
  tagTip,
}: {
  name: string;
  label: string;
  value: string;
  tag?: string;
  tagTip?: ReactNode;
}) {
  const t = useStrings(homeText);
  const state = value === UNKNOWN ? " is-unknown" : value === t.remoteReading ? " is-reading" : "";
  const badge = tag ? <span className="home-remote-tag">{tag}</span> : null;
  return (
    <span className={`home-fact${state}`} data-remote-fact={name}>
      {label} <strong>{value === UNKNOWN ? t.unknown : value}</strong>
      {badge && tagTip ? <Tip content={tagTip}>{badge}</Tip> : badge}
    </span>
  );
}

function Row({
  machine,
  rows,
  stale,
  at,
  readOnly,
}: {
  machine: LiveMachine;
  /** Every machine as Core returned them, for a display name by id. */
  rows: LiveMachine[];
  stale: boolean;
  at: string;
  readOnly: boolean;
}) {
  const t = useStrings(homeText);
  const time = useTimeDisplay();
  const navigate = useHomeNavigation();
  const state: State = stale ? "unknown" : machine.state;
  const online = state === "online";
  const load = online ? (machine.load ?? null) : null;
  const cpu = load?.cpu ?? null;
  const memory = load?.memory ?? null;
  const disk = load?.disks?.find((row) => row.roles.includes("root")) ?? load?.disks?.[0] ?? null;
  const diskTag = disk?.error ? (DISK_BUSY.has(disk.error) ? t.remoteDiskBusy : t.remoteDiskError) : undefined;
  const reading = state === "idle" || state === "connecting" || (online && load == null);
  const value = (known: string) => (reading ? t.remoteReading : known);
  const sameName = machine.sameAs && machine.sameAs !== "local" ? rows.find((row) => row.id === machine.sameAs)?.name : undefined;
  const sameAs =
    stale || !machine.sameAs
      ? ""
      : machine.sameAs === "local"
        ? t.remoteSameLocal
        : sameName
          ? t.remoteSameAs(sameName)
          : t.remoteSameUnknown;
  let why: ReactNode = null;
  if (state === "connecting") why = t.remoteConnectingNote;
  else if (state === "idle") why = t.remoteIdleNote;
  else if (state === "offline" || state === "unavailable") {
    const retry = machine.retryAt ? t.remoteRetryAt(clockTime(machine.retryAt, time)) : "";
    why = (
      <>
        <span>{reasonOf(machine.code, t.remoteReason)}</span>
        {retry && <span> {retry}.</span>}{" "}
        {readOnly ? (
          <span className="home-remote-check">{t.remoteCheck}</span>
        ) : (
          <button
            type="button"
            className="home-remote-check"
            onClick={() => navigate({ kind: "machine", machineId: machine.id })}
          >
            {t.remoteCheck}
          </button>
        )}
      </>
    );
  } else if (sameAs) why = sameAs;
  return (
    <div className={`home-remote-row is-${state}`} data-machine-id={machine.id}>
      <Tip content={<TipText title={machine.name} />} cut>
        <div className="home-remote-name">
          {machine.name}
          <span className="home-remote-platform">
            {machine.platform ? t.remotePlatform[machine.platform] : t.unknown}
          </span>
        </div>
      </Tip>
      <div className="home-remote-chip">
        <span className="home-remote-dot" aria-hidden />
        {t.remoteState[state]}
      </div>
      <div className="home-remote-facts">
        {state === "unknown" ? (
          at ? <span className="home-fact is-unknown">{t.remoteLastAt(clockTime(at, time))}</span> : null
        ) : state === "offline" || state === "unavailable" ? (
          <span className="home-fact is-unknown">{t.remoteLiveUnavailable}</span>
        ) : online ? (
          <>
            <Fact
              name="CPU"
              label={t.remoteCpu}
              value={value(cpu ? `${percent(cpu.pct)}${cpu.cores == null ? "" : t.ofCores(cpu.cores)}` : UNKNOWN)}
            />
            <Fact
              name="Memory"
              label={t.remoteMemory}
              value={value(memory ? overTotal(mebibytes(memory.usedMiB), mebibytes(memory.totalMiB)) : UNKNOWN)}
              tag={memory?.estimate ? t.remoteEstimate : undefined}
              tagTip={memory?.estimate ? <TipText body={t.remoteEstimateTitle} /> : undefined}
            />
            <Fact
              name="Disk"
              label={t.remoteDisk}
              value={disk ? value(disk.availableMiB == null ? UNKNOWN : mebibytes(disk.availableMiB)) : value(UNKNOWN)}
              tag={diskTag}
            />
            <span className="home-fact" data-remote-fact="GPU">
              {t.remoteGpu} <span className="home-remote-tag">{t.remoteGpuOff}</span>
            </span>
          </>
        ) : (
          <>
            <Fact name="CPU" label={t.remoteCpu} value={t.remoteReading} />
            <Fact name="Memory" label={t.remoteMemory} value={t.remoteReading} />
            <Fact name="Disk" label={t.remoteDisk} value={t.remoteReading} />
          </>
        )}
      </div>
      {why && <div className="home-remote-why">{why}</div>}
    </div>
  );
}

function RemoteMachinesView({
  rows,
  at,
  stale,
  reason,
  readOnly,
  reading = false,
}: {
  rows: LiveMachine[];
  at: string;
  stale: boolean;
  reason: string;
  readOnly: boolean;
  reading?: boolean;
}) {
  const t = useStrings(homeText);
  const time = useTimeDisplay();
  const navigate = useHomeNavigation();
  const shown = rows.slice(0, MACHINE_LIVE_ROWS);
  const more = rows.length - shown.length;
  const status = stale
    ? `${t.remoteReadFailed(reason || t.remoteExpired)}${at ? ` · ${t.remoteLastRead(clockTime(at, time))}` : ""}`
    : "";
  return (
    <div className="home-remote-machines">
      <div className="home-remote-head">
        <h3>{t.otherMachines}</h3>
        {status && (
          <Tip content={<TipText body={status} />} cut>
            <span className="home-remote-status" role="status">
              {status}
            </span>
          </Tip>
        )}
      </div>
      {reading ? (
        <p className="home-note">{t.remoteReadingNote}</p>
      ) : stale && rows.length === 0 ? null : rows.length === 0 ? (
        <p className="home-note">{t.remoteNone}</p>
      ) : (
        <>
          {shown.map((machine) => (
            <Row key={machine.id} machine={machine} rows={rows} stale={stale} at={at} readOnly={readOnly} />
          ))}
          {more > 0 && (
            <p className="home-remote-more">
              {t.remoteMore(more)}
              {" · "}
              {readOnly ? (
                <span>{t.remoteMorePage}</span>
              ) : (
                <button
                  type="button"
                  className="home-remote-check"
                  onClick={() => navigate({ kind: "machine", machineId: "local" })}
                >
                  {t.remoteMorePage}
                </button>
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function RemoteMachinesLive() {
  const t = useStrings(homeText);
  const view = useMachineLive(t.remoteBadAnswer);
  if (view.phase === "reading") {
    return <RemoteMachinesView rows={[]} at="" stale={false} reason="" readOnly={false} reading />;
  }
  return (
    <RemoteMachinesView
      rows={view.data?.machines ?? []}
      at={view.at}
      stale={view.phase === "stale"}
      reason={view.reason}
      readOnly={false}
    />
  );
}

/**
 * The "Other machines" part of Home's machine card. In the read-only design
 * preview it shows a synthetic fixture and reads nothing; otherwise it reads
 * /api/machine-live only while `active` (expanded and visible). Collapsing or
 * hiding unmounts it, which aborts the request and clears its timer, so Core
 * sees this page's interest end. The local load above is untouched.
 */
export function RemoteMachines({ readOnly, active }: { readOnly: boolean; active: boolean }) {
  if (readOnly) {
    return (
      <RemoteMachinesView
        rows={previewMachineLive.machines}
        at=""
        stale={false}
        reason=""
        readOnly
      />
    );
  }
  if (!active) return null;
  return <RemoteMachinesLive />;
}
