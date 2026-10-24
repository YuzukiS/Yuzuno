import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "./api";
import {
  browserEstimate,
  deviceGroups,
  deviceInventory,
  entryLabels,
  harnessNames,
  sizeText,
  type BrowserEstimate,
  type DeviceInventory,
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

function at(iso: string) {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Settings → Data & storage (T-193): where this Workspace's data is kept, who
 * keeps it and what is known of its size. It reads this browser's storage and
 * Core's overview while it is shown; a size that is not known is said to be
 * unknown, never 0. Nothing here deletes or changes anything.
 */
export function StorageOverview({ active, updates }: { active: boolean; updates: UpdatesStorage | null }) {
  const [view, setView] = useState<StorageOverviewView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [device, setDevice] = useState<DeviceInventory | null>(null);
  const [estimate, setEstimate] = useState<BrowserEstimate | undefined>(undefined);

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

  return (
    <section id="settings-storage" className="settings-section storage-overview" aria-labelledby="settings-storage-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-storage-title">Data & storage</h3>
          <p>
            Where this Workspace's data is kept, who keeps it and what is known of its size. This page only reads:
            nothing here deletes or changes anything.
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
              {device.unreadableDrafts > 0 &&
                `; ${device.unreadableDrafts} saved ${device.unreadableDrafts === 1 ? "draft could" : "drafts could"} not be read and ${device.unreadableDrafts === 1 ? "is" : "are"} left as ${device.unreadableDrafts === 1 ? "it is" : "they are"}`}
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
              In <code>{view.dataDir}</code> on the computer that runs Core · read {at(view.readAt)}. A folder's size is not
              measured here.
            </p>
            {view.unreadable && <p className="updates-error">Part of this folder could not be read: {view.unreadable}</p>}
            <ul className="storage-rows">
              {view.entries.map((entry) => (
                <EntryRow key={entry.name} entry={entry} />
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
                <span className="storage-size">size unknown</span>
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

      <p className="storage-note">
        What each held Agent's stored history takes inside the database is in History & memory information. To report a
        problem, Copy diagnostics shows its text before anything is copied.
      </p>
    </section>
  );
}

function EntryRow({ entry }: { entry: StorageEntry }) {
  const size =
    entry.kind === "file" && entry.bytes !== undefined
      ? `${sizeText(entry.bytes)} · ${sizeText(entry.diskBytes ?? 0)} on disk`
      : entry.kind === "folder"
        ? "size unknown"
        : entry.kind === "link"
          ? "a link: not followed"
          : entry.kind === "unreadable"
            ? "could not be read"
            : "not a file or folder";
  return (
    <li data-entry={entry.name}>
      <span className="storage-name">{entryLabels[entry.what] ?? entry.what}</span>
      <span className="storage-size">{size}</span>
      <span className="storage-detail">
        <code>{entry.name}</code>
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
