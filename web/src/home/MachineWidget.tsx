import { useEffect, useState } from "react";
import { useClockFormat } from "../time-preferences";
import { Cpu, Gpu, MemoryStick, Monitor } from "lucide-react";
import { errorText } from "../api";
import { openJobs } from "../Jobs";
import { absolute, mebibytes, percent, plural, UNKNOWN } from "./format";
import { readMachineLoad } from "./home-api";
import { useHomeNavigation } from "./home-navigation";
import { previewMachineLoad } from "./preview-home";
import type { MachineLoad } from "./types";
import { FoldButton, useCardFold } from "./card-fold";

const POLL_MS = 2_000;

function useDocumentVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return visible;
}

/** A share of the whole, as a bar segment; an unknown share draws nothing. */
const width = (part: number | null | undefined, whole: number) =>
  part == null || !(whole > 0) ? 0 : Math.min(100, Math.max(0, (part / whole) * 100));

function Meter({
  label,
  segments,
}: {
  label: string;
  segments: { name: string; share: number }[];
}) {
  return (
    <div className="home-meter" role="img" aria-label={label}>
      {segments.map((segment) =>
        segment.share > 0 ? (
          <span key={segment.name} className={`home-meter-${segment.name}`} style={{ width: `${segment.share}%` }} />
        ) : null,
      )}
    </div>
  );
}

/** Shown until the first reading arrives; not a value and not unknown. */
const READING = "…";

function Fact({ name, value, swatch }: { name: string; value: string; swatch?: string }) {
  const state = value === UNKNOWN ? " is-unknown" : value === READING ? " is-reading" : "";
  return (
    <span className={`home-fact${state}`} data-fact={name}>
      {swatch && <span className={`home-swatch home-meter-${swatch}`} aria-hidden />}
      {name} <strong>{value}</strong>
    </span>
  );
}

/** One of a GPU's two readings as a bar: the name, the bar, the value. */
function GpuBar({ name, value, share }: { name: string; value: string; share: number }) {
  return (
    <span className="home-gpu-bar">
      <Fact name={name} value={value} />
      <Meter label={`GPU ${name.toLowerCase()} ${value}`} segments={[{ name: "gpu", share }]} />
    </span>
  );
}

/**
 * This Core host's load (slice 1: no remote machines), sampled every two
 * seconds while Home is on screen. Another source's share is only what Core
 * reports for it; nothing is subtracted here, and unknown is never shown as 0.
 * Until the first reading (about a second) and while the list of Jobs
 * changes, the widget keeps its height, so the panels below never move.
 */
export function MachineWidget({
  projectName,
  readOnly,
}: {
  projectName: (id: string | null) => string;
  readOnly: boolean;
}) {
  const clock = useClockFormat();
  const visible = useDocumentVisible();
  const navigate = useHomeNavigation();
  // Collapsed, it reads no load; the header keeps the last reading's time (T-115).
  const [collapsed, toggleFold] = useCardFold("widget:machines");
  const [load, setLoad] = useState<MachineLoad | null>(readOnly ? previewMachineLoad : null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (readOnly || !visible || collapsed) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sample = async () => {
      try {
        const value = await readMachineLoad(controller.signal);
        if (controller.signal.aborted) return;
        setLoad(value);
        setError("");
      } catch (e) {
        if (!controller.signal.aborted) setError(errorText(e));
      }
      // One read at a time: the next starts two seconds after this one ends.
      if (!controller.signal.aborted) timer = setTimeout(sample, POLL_MS);
    };
    void sample();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [readOnly, visible, collapsed]);
  const cpu = load?.cpu;
  const memory = load?.memory;
  const atText = load ? `Core host · as of ${absolute(load.at, clock)}` : readOnly ? "Core host" : "Reading…";
  const errorLine = error && `Machine load is unavailable: ${error}${load ? " · Showing the last reading." : ""}`;
  const jobs = load?.jobs;
  return (
    <section className={`home-machines${collapsed ? " is-collapsed" : ""}`} aria-label="Machines">
      <header>
        <h2>
          <FoldButton collapsed={collapsed} onToggle={toggleFold} label="Machines" controls="home-machines-body" />
          <Monitor size={14} />
          Machines
        </h2>
        {/* Adding, editing and testing machines happens on the Machines page. */}
        {!readOnly && (
          <button
            type="button"
            className="quiet-button home-machines-manage"
            onClick={() => navigate({ kind: "machine", machineId: "local" })}
          >
            Manage
          </button>
        )}
        {/* One line either way: an error replaces the time instead of adding a row. */}
        {errorLine ? (
          <span className="home-machines-at is-error" role="alert" title={errorLine}>
            {errorLine}
          </span>
        ) : (
          <span className="home-machines-at">{atText}</span>
        )}
      </header>
      <div className="home-card-body" id="home-machines-body" hidden={collapsed}>
      <div className="home-machine" aria-busy={load ? undefined : true}>
        <div className="home-load">
          <span className="home-load-title">
            <Cpu size={13} /> CPU <strong>{cpu ? percent(cpu.totalPct) : READING}</strong>
            {cpu && <> of {plural(cpu.cores, "core")}</>}
          </span>
          <Meter
            label={cpu ? `CPU ${percent(cpu.totalPct)}` : "CPU, reading"}
            segments={
              cpu
                ? [
                    { name: "jobs", share: width(cpu.jobsPct, 100) },
                    { name: "agents", share: width(cpu.agentsPct, 100) },
                    { name: "other", share: width(cpu.otherPct, 100) },
                  ]
                : []
            }
          />
          <span className="home-facts">
            <Fact name="Jobs" value={cpu ? percent(cpu.jobsPct) : READING} swatch="jobs" />
            <Fact name="Agents" value={cpu ? percent(cpu.agentsPct) : READING} swatch="agents" />
            <Fact name="Other" value={cpu ? percent(cpu.otherPct) : READING} swatch="other" />
          </span>
        </div>
        <div className="home-load">
          <span className="home-load-title">
            <MemoryStick size={13} /> Memory <strong>{memory ? mebibytes(memory.usedMiB) : READING}</strong>
            {memory && <> of {mebibytes(memory.totalMiB)}</>}
          </span>
          <Meter
            label={memory ? `Memory ${mebibytes(memory.usedMiB)} used` : "Memory, reading"}
            segments={
              memory
                ? [
                    { name: "jobs", share: width(memory.jobsMiB, memory.totalMiB) },
                    { name: "agents", share: width(memory.agentsMiB, memory.totalMiB) },
                  ]
                : []
            }
          />
          <span className="home-facts">
            <Fact name="Jobs" value={memory ? mebibytes(memory.jobsMiB) : READING} swatch="jobs" />
            <Fact name="Agents" value={memory ? mebibytes(memory.agentsMiB) : READING} swatch="agents" />
            <Fact name="Available" value={memory ? mebibytes(memory.availableMiB) : READING} />
          </span>
        </div>
        <div className="home-load home-gpus">
          <span className="home-load-title">
            <Gpu size={13} /> GPU
          </span>
          {!load ? (
            // The shape of one GPU, so a GPU arriving keeps the height.
            <ul>
              <li>
                <span className="home-gpu-name">Reading…</span>
                <GpuBar name="Use" value={READING} share={0} />
                <GpuBar name="Memory" value={READING} share={0} />
              </li>
            </ul>
          ) : load.gpus == null ? (
            <span className="home-facts">
              <Fact name="GPU" value={UNKNOWN} />
            </span>
          ) : load.gpus.length === 0 ? (
            <span className="home-note">No GPU reported</span>
          ) : (
            <ul>
              {load.gpus.map((gpu, index) => (
                <li key={index} title="The whole card, other programs included; not split by Agent or Job">
                  <span className="home-gpu-name">{gpu.name}</span>
                  <GpuBar
                    name="Use"
                    value={percent(gpu.utilPct)}
                    share={width(gpu.utilPct, 100)}
                  />
                  <GpuBar
                    name="Memory"
                    value={`${mebibytes(gpu.memUsedMiB)} / ${mebibytes(gpu.memTotalMiB)}`}
                    share={width(gpu.memUsedMiB, gpu.memTotalMiB)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="home-machine-jobs">
          <span className="home-load-title">
            Jobs on this machine
            {/* Plain text: a badge would make this line taller when Jobs appear. */}
            {jobs?.length ? <span className="home-machine-jobs-count">· {jobs.length}</span> : null}
          </span>
          {/* A fixed height that scrolls: Jobs starting and ending move nothing below. */}
          <div className="home-machine-jobs-list" tabIndex={jobs && jobs.length > 3 ? 0 : undefined}>
            {!jobs ? (
              <span className="home-note">Reading…</span>
            ) : jobs.length ? (
              <ul>
                {jobs.map((job) => {
                  const who = `${projectName(job.projectId)} · ${job.agentName || "No Agent"}`;
                  const body = (
                    <>
                      <span className="home-machine-job-dot" aria-hidden />
                      <span className="home-machine-job-text">
                        <strong>{job.name}</strong>
                        <small>
                          <span className="home-machine-job-who">{who}</span>
                          <Fact name="CPU" value={percent(job.cpuPct)} />
                          <Fact name="Memory" value={mebibytes(job.memMiB)} />
                        </small>
                      </span>
                    </>
                  );
                  return (
                    <li key={job.id}>
                      {/* As the conversation's dock: a Job opens in the Jobs panel. */}
                      {readOnly ? (
                        <span className="home-machine-job" title={`${job.name}\n${who}`}>
                          {body}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="home-machine-job"
                          title={`${job.name}\n${who}`}
                          aria-label={`${job.name}, ${who}, CPU ${percent(job.cpuPct)}, memory ${mebibytes(job.memMiB)}: open in Jobs`}
                          onClick={() => openJobs({ source: "local", jobId: job.id })}
                        >
                          {body}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <span className="home-note">No Jobs running</span>
            )}
          </div>
        </div>
      </div>
      </div>
    </section>
  );
}
