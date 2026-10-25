import { useState } from "react";
import { api, errorText } from "./api";

/** T-196: what keeping only the latest backups in one folder would do, as
 * Core previews it (core/src/workspace_backup/retention.rs), and (slice 3)
 * removing one of those that could be removed, once the user confirms that
 * one. Nothing removes backups on its own. Core reads each manifest and
 * checks no files for the preview, so sizes are estimates and no backup is
 * called verified; Check reads one back, as Check a backup does. A removal is
 * judged again by Core, which first reads another backup back whole. */

type Verdict = "keep" | "remove" | "protected" | "unknown" | "ignored";
type Entry = {
  name: string;
  path: string;
  verdict: Verdict;
  reason: string;
  workspaceId?: string;
  createdAt?: string;
  estimateBytes?: number;
  lastCheckedAt?: string;
  manifestSha256?: string;
};
export type RemoveTarget = { folder: string; keep: number; name: string; manifestSha256: string };
type Preview = {
  folder: string;
  keep: number;
  entries: Entry[];
  unreadableNames: number;
  removableEstimateBytes: number;
};

const groups: { verdict: Verdict; title: string }[] = [
  { verdict: "keep", title: "Kept" },
  { verdict: "remove", title: "Could be removed" },
  { verdict: "protected", title: "Protected" },
  { verdict: "unknown", title: "Can't be judged" },
];

function size(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export function BackupRetention({ defaultFolder, busy, onCheck, onRemove }: {
  /** The daily backup's folder, when one is set. */
  defaultFolder: string | null;
  /** A backup, check or restore is running: Check and removal wait for it. */
  busy: boolean;
  /** Starts Check a backup on `path`, as that control does. */
  onCheck: (path: string) => void;
  /** Starts the removal of one backup the user confirmed. */
  onRemove: (target: RemoveTarget) => void;
}) {
  const [folder, setFolder] = useState(defaultFolder ?? "");
  const [keep, setKeep] = useState("7");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  /** The one backup whose removal is being confirmed. */
  const [confirming, setConfirming] = useState<Entry | null>(null);
  const [started, setStarted] = useState("");
  const count = Number(keep);
  const valid = folder.trim() !== "" && Number.isInteger(count) && count >= 1 && count <= 100;

  async function run() {
    setReading(true);
    setError("");
    setPreview(null);
    setConfirming(null);
    setStarted("");
    try {
      setPreview(await api<Preview>("/workspace/backup/retention/preview", {
        method: "POST",
        body: JSON.stringify({ folder: folder.trim(), keep: count }),
      }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setReading(false);
    }
  }

  const shown = preview?.entries.filter((e) => e.verdict !== "ignored") ?? [];
  const ignored = preview ? preview.entries.length - shown.length : 0;
  return (
    <div className="settings-group backup-retention" aria-label="Keep the latest backups">
      <div className="settings-row workspace-backup-row">
        <span className="settings-row-main">
          <span className="settings-row-title">Keep the latest backups</span>
          <span className="settings-row-help">
            What keeping only the latest backups in one folder would keep, and what it could remove. A backup is removed
            only when you confirm that one; nothing removes backups on its own.
          </span>
        </span>
      </div>
      <div className="settings-row workspace-backup-row">
        <input
          className="settings-input"
          aria-label="Folder holding backups"
          placeholder="/path/to/backups-folder"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        />
        <input
          className="settings-input backup-retention-keep"
          type="number"
          min={1}
          max={100}
          aria-label="Backups to keep"
          value={keep}
          onChange={(e) => setKeep(e.target.value)}
        />
        <button type="button" disabled={!valid || reading} onClick={() => void run()}>
          Preview
        </button>
      </div>
      {error && (
        <p className="workspace-backup-error" role="alert">
          {error}
        </p>
      )}
      {started && (
        <p className="workspace-backup-note" role="status">
          {started}
        </p>
      )}
      {preview && (
        <div className="backup-retention-result" role="region" aria-label="Retention preview">
          <p role="status">
            Keeping the latest {preview.keep}: {shown.filter((e) => e.verdict === "keep").length} kept,{" "}
            {shown.filter((e) => e.verdict === "remove").length} could be removed (about{" "}
            {size(preview.removableEstimateBytes)}, as their manifests declare),{" "}
            {shown.filter((e) => e.verdict === "protected" || e.verdict === "unknown").length} protected or can't be
            judged.
            {ignored > 0 && ` ${ignored} other ${ignored === 1 ? "entry is" : "entries are"} not a backup.`}
            {preview.unreadableNames > 0 && ` ${preview.unreadableNames} ${preview.unreadableNames === 1 ? "name" : "names"} can't be read, so nothing in this folder can be removed.`}
          </p>
          <p className="settings-row-help">
            The preview reads each backup's manifest only; no backup's files were checked. Check one to read every file
            back. Remove… removes one backup, after you confirm it.
          </p>
          {groups.map(({ verdict, title }) => {
            const items = shown.filter((e) => e.verdict === verdict);
            if (!items.length) return null;
            return (
              <section key={verdict} className="backup-retention-group" data-verdict={verdict}>
                <h4>
                  {title} ({items.length})
                </h4>
                <ul>
                  {items.map((e) => (
                    <li key={e.name}>
                      <span className="backup-retention-name">
                        <code>{e.name}</code>
                        {e.createdAt && ` · backed up ${when(e.createdAt)}`}
                        {e.estimateBytes !== undefined && ` · about ${size(e.estimateBytes)}`}
                        {` · ${e.lastCheckedAt ? `last checked ${when(e.lastCheckedAt)}` : "not checked"}`}
                      </span>
                      <span className="settings-row-help">{e.reason}</span>
                      {(verdict === "keep" || verdict === "remove") && (
                        <span className="backup-retention-actions">
                          <button type="button" disabled={busy} onClick={() => onCheck(e.path)}>
                            Check
                          </button>
                          {verdict === "remove" && e.manifestSha256 && preview.unreadableNames === 0 && (
                            <button type="button" disabled={busy} onClick={() => setConfirming(e)}>
                              Remove…
                            </button>
                          )}
                        </span>
                      )}
                      {confirming?.name === e.name && e.manifestSha256 && (
                        <div className="backup-retention-confirm" role="group" aria-label={`Remove ${e.name}`}>
                          <p>
                            Remove <code>{e.path}</code>
                            {e.createdAt && `, backed up ${when(e.createdAt)}`}
                            {e.estimateBytes !== undefined && `, about ${size(e.estimateBytes)}`}? Only this one backup is
                            removed. Core first checks the folder again and reads another backup of this Workspace back
                            whole; if it can't, nothing is removed. A removed backup can't be brought back.
                          </p>
                          <span className="backup-retention-actions">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                onRemove({ folder: preview.folder, keep: preview.keep, name: e.name, manifestSha256: e.manifestSha256! });
                                // The preview is from before the removal; it is read again once that has ended.
                                setPreview(null);
                                setConfirming(null);
                                setStarted(`Removal of ${e.name} started; preview again once it has ended.`);
                              }}
                            >
                              Remove this backup
                            </button>
                            <button type="button" onClick={() => setConfirming(null)}>
                              Cancel
                            </button>
                          </span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
