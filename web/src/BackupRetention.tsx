import { useState } from "react";
import { api, errorText } from "./api";

/** T-196, slice 2: what keeping only the latest backups in one folder would
 * do, as Core previews it (core/src/workspace_backup/retention.rs). A
 * preview only: nothing here deletes a backup or turns on a clean-up. Core
 * reads each manifest and checks no files, so sizes are estimates and no
 * backup is called verified; Check reads one back, as Check a backup does. */

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
};
type Preview = {
  folder: string;
  keep: number;
  entries: Entry[];
  notInspected: number;
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

export function BackupRetention({ defaultFolder, busy, onCheck }: {
  /** The daily backup's folder, when one is set. */
  defaultFolder: string | null;
  /** A backup, check or restore is running: Check waits for it. */
  busy: boolean;
  /** Starts Check a backup on `path`, as that control does. */
  onCheck: (path: string) => void;
}) {
  const [folder, setFolder] = useState(defaultFolder ?? "");
  const [keep, setKeep] = useState("7");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const count = Number(keep);
  const valid = folder.trim() !== "" && Number.isInteger(count) && count >= 1 && count <= 100;

  async function run() {
    setReading(true);
    setError("");
    setPreview(null);
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
          <span className="settings-row-title">Keep the latest backups: preview</span>
          <span className="settings-row-help">
            What keeping only the latest backups in one folder would keep, and what it could remove. Nothing is
            deleted here, and nothing removes backups on its own.
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
      {preview && (
        <div className="backup-retention-result" role="region" aria-label="Retention preview">
          <p role="status">
            Keeping the latest {preview.keep}: {shown.filter((e) => e.verdict === "keep").length} kept,{" "}
            {shown.filter((e) => e.verdict === "remove").length} could be removed (about{" "}
            {size(preview.removableEstimateBytes)}, as their manifests declare),{" "}
            {shown.filter((e) => e.verdict === "protected" || e.verdict === "unknown").length} protected or can't be
            judged.
            {ignored > 0 && ` ${ignored} other ${ignored === 1 ? "entry is" : "entries are"} not a backup.`}
            {preview.notInspected > 0 && ` ${preview.notInspected} more ${preview.notInspected === 1 ? "entry was" : "entries were"} not looked at.`}
          </p>
          <p className="settings-row-help">
            The preview reads each backup's manifest only; no backup's files were checked. Check one to read every file
            back.
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
                        <button type="button" disabled={busy} onClick={() => onCheck(e.path)}>
                          Check
                        </button>
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
