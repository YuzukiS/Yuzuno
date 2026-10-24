import { useCallback, useEffect, useState } from "react";
import { Copy, HardDrive, LoaderCircle, Square } from "lucide-react";
import { api, errorText, post } from "./api";
import { DiagnosticsText } from "./RecoveryPage";
import {
  browserEstimate,
  deviceGroups,
  deviceInventory,
  entryLabels,
  harnessNames,
  measuredFolder,
  overviewText,
  sizeText,
  type BrowserEstimate,
  type DeviceInventory,
  type Measurement,
  type StorageEntry,
  type StorageOverviewView,
} from "./storage-overview";
import "./storage-overview.css";

type UpdatesStorage = { managed: boolean; storage: { releaseBytes: number; backupBytes: number; retainedReleases: number; keepReleases: number } };

function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function at(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
}

/**
 * Settings → Data & storage (T-193): where this Workspace's data is kept, how
 * much of it there is and who keeps it. It reads this browser's storage and
 * Core's overview while it is shown; folder sizes come only from Measure.
 * Nothing here deletes or changes anything.
 */
export function StorageOverview({ active, updates }: { active: boolean; updates: UpdatesStorage | null }) {
  const [view, setView] = useState<StorageOverviewView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [device, setDevice] = useState<DeviceInventory | null>(null);
  const [estimate, setEstimate] = useState<BrowserEstimate | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [actionError, setActionError] = useState("");
  const [copyText, setCopyText] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "select">("idle");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api<StorageOverviewView>("/storage", { signal });
      if (!signal?.aborted) {
        setView(next);
        setLoadError("");
      }
    } catch (e) {
      if (!signal?.aborted) setLoadError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    setDevice(deviceInventory(readStorage()));
    void browserEstimate().then(setEstimate);
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [active, refresh]);

  // While a measurement runs, Core's overview is read about once a second.
  const running = view?.measurement?.state === "running";
  useEffect(() => {
    if (!active || !running) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void refresh(controller.signal), 1000);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, running, view, refresh]);

  async function measure(path: "/storage/measure" | "/storage/measure/stop") {
    setAsking(true);
    setActionError("");
    try {
      const { measurement } = await post<{ measurement: Measurement | null }>(path);
      setView((old) => (old ? { ...old, measurement } : old));
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setAsking(false);
    }
  }

  async function copy() {
    const text = overviewText(view, device, updates?.managed
      ? { managed: true, releaseBytes: updates.storage.releaseBytes, backupBytes: updates.storage.backupBytes }
      : updates ? { managed: false, releaseBytes: 0, backupBytes: 0 } : null);
    setCopyText(text);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("select");
    }
  }

  const measurement = view?.measurement ?? null;
  return (
    <section id="settings-storage" className="settings-section storage-overview" aria-labelledby="settings-storage-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-storage-title">Data & storage</h3>
          <p>
            Where this Workspace's data is kept, how much there is and who keeps it. This page only reads: nothing here
            deletes or changes anything.
          </p>
        </div>
      </header>

      <section className="storage-part" aria-labelledby="storage-device">
        <h4 id="storage-device">On this device, for this site</h4>
        <p className="storage-note">
          Kept only in this browser at this address. It is not in a Workspace backup, and clearing this site's data in the
          browser removes it.
        </p>
        {device && !device.available && <p className="updates-error" role="alert">{device.reason}</p>}
        {device?.available && (
          <>
            <ul className="storage-rows">
              {device.groups.map((group) => {
                const about = deviceGroups.find((item) => item.id === group.id)!;
                return (
                  <li key={group.id} data-group={group.id}>
                    <span className="storage-name">{about.label}</span>
                    <span className="storage-size">about {sizeText(group.bytes)}</span>
                    <span className="storage-detail">
                      {group.keys} {group.keys === 1 ? "entry" : "entries"} · {about.note}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="storage-note">
              {device.draftAgents} {device.draftAgents === 1 ? "Agent has" : "Agents have"} a saved draft
              {device.unreadableDrafts > 0 && `; ${device.unreadableDrafts} saved ${device.unreadableDrafts === 1 ? "draft" : "drafts"} could not be read and ${device.unreadableDrafts === 1 ? "is" : "are"} left as ${device.unreadableDrafts === 1 ? "it is" : "they are"}`}
              . {device.unsentMessages} {device.unsentMessages === 1 ? "message is" : "messages are"} waiting for Core to
              accept {device.unsentMessages === 1 ? "it" : "them"}. Sizes are estimates: the text as this browser keeps it.
            </p>
          </>
        )}
        <p className="storage-note" data-estimate>
          {estimate === undefined
            ? "Asking this browser for its own figures…"
            : estimate === null
              ? "This browser does not report how much it keeps for this site."
              : `This browser's own estimate for this site: ${sizeText(estimate.usage)} used of ${sizeText(estimate.quota)} it allows.`}
        </p>
      </section>

      <section className="storage-part" aria-labelledby="storage-core">
        <h4 id="storage-core">In the Workspace, on the Core host</h4>
        {loadError && (
          <p className="updates-error" role="alert">
            Could not read the Workspace's storage: {loadError}{" "}
            <button type="button" className="inline-link" onClick={() => void refresh()}>
              Try again
            </button>
          </p>
        )}
        {!view && !loadError && <p className="storage-note">Reading…</p>}
        {view && (
          <>
            <p className="storage-note">
              In <code>{view.dataDir}</code> on the computer that runs Core · read {at(view.readAt)}
            </p>
            {view.unreadable && <p className="updates-error">Part of this folder could not be read: {view.unreadable}</p>}
            <ul className="storage-rows">
              {view.entries.map((entry) => (
                <EntryRow key={entry.name} entry={entry} view={view} />
              ))}
            </ul>
            {view.database.freePages !== null && view.database.pageSize !== null && (
              <p className="storage-note">
                Free space inside the database file: {sizeText(view.database.freePages * view.database.pageSize)}, reused
                by later writes.
              </p>
            )}
            {view.jobs.total !== null && (
              <p className="storage-note">
                {view.jobs.total} Job {view.jobs.total === 1 ? "record" : "records"}
                {view.jobs.unfinished ? `, ${view.jobs.unfinished} not finished` : ""}. Each Job's folder of records and
                output is kept; what a Job writes in its own working folder is not in this list.
              </p>
            )}
            <div className="storage-measure">
              {running ? (
                <>
                  <p role="status">
                    <LoaderCircle size={14} className="spin" aria-hidden="true" /> Measuring
                    {measurement?.current ? ` ${entryLabels[view.entries.find((e) => e.name === measurement.current)?.what ?? ""] ?? measurement.current}` : ""}
                    … {measurement?.entries ?? 0} entries read
                  </p>
                  <button type="button" className="secondary-button" disabled={asking} onClick={() => void measure("/storage/measure/stop")}>
                    <Square size={14} aria-hidden="true" /> Stop
                  </button>
                </>
              ) : (
                <>
                  <p className="storage-note">
                    {measurement
                      ? measurementSummary(measurement, view.bounds)
                      : `Folder sizes are measured only when you ask: Core reads at most ${view.bounds.entries.toLocaleString()} entries for at most ${view.bounds.seconds} s, follows no links and stays on the folder's own disk.`}
                  </p>
                  <button type="button" className="secondary-button" disabled={asking} onClick={() => void measure("/storage/measure")}>
                    <HardDrive size={14} aria-hidden="true" /> {measurement ? "Measure again" : "Measure folders"}
                  </button>
                </>
              )}
              {actionError && <p className="updates-error" role="alert">{actionError}</p>}
            </div>
          </>
        )}
      </section>

      <section className="storage-part" aria-labelledby="storage-updates">
        <h4 id="storage-updates">Update releases and recovery copies</h4>
        {!updates ? (
          <p className="storage-note">Not read yet: Settings reads it with the update status.</p>
        ) : updates.managed ? (
          <p className="storage-note">
            Releases: {sizeText(updates.storage.releaseBytes)} ({updates.storage.retainedReleases} kept, up to{" "}
            {updates.storage.keepReleases}). Database copies made before updates: {sizeText(updates.storage.backupBytes)}.
            They are in the managed install, beside the Workspace, and let an update be undone.
          </p>
        ) : (
          <p className="storage-note">This Core is not a managed install, so Yuzuno keeps no releases or update copies for it.</p>
        )}
      </section>

      <section className="storage-part" aria-labelledby="storage-native">
        <h4 id="storage-native">Native session histories</h4>
        {view && view.native.length === 0 && <p className="storage-note">No Agent has a native session yet.</p>}
        {view && view.native.length > 0 && (
          <ul className="storage-rows">
            {view.native.map((group) => (
              <li key={`${group.harness}:${group.machine ?? ""}`}>
                <span className="storage-name">
                  {harnessNames[group.harness] ?? group.harness} · {group.machine ?? "the Core host"}
                </span>
                <span className="storage-size">not measured</span>
                <span className="storage-detail">
                  {group.agents} {group.agents === 1 ? "Agent" : "Agents"}
                  {group.closed ? ` (${group.closed} closed)` : ""} ·{" "}
                  {group.harness === "opencode"
                    ? "Kept in this Workspace's folder (OpenCode session databases above); not in a backup."
                    : `Kept by ${harnessNames[group.harness] ?? group.harness} in its own folder on that computer. Yuzuno does not measure, back up or remove it.`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="storage-note">
          What each held Agent's stored history takes inside the database is in History & memory information.
        </p>
      </section>

      {view && view.notInBackup.length > 0 && (
        <section className="storage-part" aria-labelledby="storage-not-backed-up">
          <h4 id="storage-not-backed-up">Never in a Workspace backup</h4>
          <ul className="storage-list">
            {view.notInBackup.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="storage-copy">
        <button type="button" className="secondary-button" disabled={!view && !device} onClick={() => void copy()}>
          <Copy size={14} aria-hidden="true" /> Copy this overview
        </button>
        <p className="storage-note">Sizes and counts only: no folder paths, names, IDs or draft text.</p>
        <DiagnosticsText text={copyText} state={copyState} label="Data & storage overview" />
      </div>
    </section>
  );
}

function EntryRow({ entry, view }: { entry: StorageEntry; view: StorageOverviewView }) {
  const folder = measuredFolder(view, entry.name);
  let size: string;
  if (entry.kind === "file" && entry.bytes !== undefined) {
    size = `${sizeText(entry.bytes)} · ${sizeText(entry.diskBytes ?? 0)} on disk`;
  } else if (folder?.measured) {
    size = `${folder.complete ? "" : "at least "}${sizeText(folder.bytes)} · ${sizeText(folder.diskBytes)} on disk`;
  } else if (entry.kind === "folder") {
    size = folder && !folder.measured ? "not reached by the measurement" : entry.what === "unknown" ? "not measured: not made by Core" : "not measured";
  } else {
    size = entry.kind === "link" ? "a link: not followed" : entry.kind === "unreadable" ? "could not be read" : "not a file or folder";
  }
  const skipped = folder?.measured
    ? [
        folder.links && `${folder.links} ${folder.links === 1 ? "link" : "links"} not followed`,
        folder.otherDevice && `${folder.otherDevice} on another disk not counted`,
        folder.unreadable && `${folder.unreadable} could not be read`,
      ].filter(Boolean)
    : [];
  return (
    <li data-entry={entry.name}>
      <span className="storage-name">{entryLabels[entry.what] ?? entry.what}</span>
      <span className="storage-size">{size}</span>
      <span className="storage-detail">
        <code>{entry.name}</code>
        {folder?.measured && ` · ${folder.files} ${folder.files === 1 ? "file" : "files"}`}
        {skipped.length > 0 && ` · ${skipped.join(", ")}`}
        {" · "}
        {entry.backup === "copied"
          ? "In a Workspace backup"
          : entry.backup === "excluded"
            ? `Not in a backup: ${entry.backupReason}`
            : "Not in a backup"}
      </span>
    </li>
  );
}

function measurementSummary(measurement: Measurement, bounds: { entries: number; seconds: number }) {
  const when = at(measurement.endedAt ?? measurement.startedAt);
  switch (measurement.state) {
    case "done":
      return `Measured ${when}: ${measurement.entries.toLocaleString()} entries read.`;
    case "limited":
      return `Measured ${when}, cut short at ${bounds.entries.toLocaleString()} entries or ${bounds.seconds} s: sizes marked "at least" are incomplete, and folders not reached have no size.`;
    case "stopped":
      return `Stopped ${when}: sizes marked "at least" are incomplete, and folders not reached have no size.`;
    default:
      return `The measurement could not run (${when}).`;
  }
}
