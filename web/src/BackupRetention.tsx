import { useState } from "react";
import { api, errorText } from "./api";
import { strings, useStrings } from "./i18n";

/** T-196: what keeping only the latest backups in one folder would do, as
 * Core previews it (core/src/workspace_backup/retention.rs), and (slice 3)
 * removing one of those that could be removed, once the user confirms that
 * one; removal without that is only the daily backup's Automatic removal
 * (slice 6, WorkspaceBackup.tsx), which the user turns on. Core reads each manifest and
 * checks no files for the preview, so sizes are estimates and no backup is
 * called verified; Check reads one back, as Check a backup does. A removal is
 * judged again by Core, which first reads another backup back whole.
 * (Slice 5) A space budget is optional: of the latest, Core keeps only as many
 * as fit in it, by the sizes manifests declare, and says when what stays is
 * over it; the count is unchanged without one. */

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
export type RemoveTarget = { folder: string; keep: number; budgetBytes?: number; name: string; manifestSha256: string };
type Budget = {
  bytes: number;
  /** met; over: what stays can't be brought within it; unknown: a size can't be trusted. */
  state: "met" | "over" | "unknown";
  reason: string;
  keptEstimateBytes: number;
};
type Preview = {
  folder: string;
  keep: number;
  entries: Entry[];
  unreadableNames: number;
  removableEstimateBytes: number;
  removableUnknownSizes: number;
  sizeBasis: string;
  budget?: Budget;
};
const GIB = 1024 ** 3;
/** The verdicts listed, in order; an entry that is not a backup is only counted. */
type Listed = Exclude<Verdict, "ignored">;
const groups: Listed[] = ["keep", "remove", "protected", "unknown"];

// This part's own words (T-189). Folders, names, paths, hashes, sizes, times
// and what Core says (a reason, a budget's reason, how sizes are told) come
// as they are.
const text = strings({
  budgetSaid: {
    met: "Within the space budget",
    over: "The space budget can't be reached",
    unknown: "Whether the space budget is met can't be told",
  } as Record<Budget["state"], string>,
  groups: { keep: "Kept", remove: "Could be removed", protected: "Protected", unknown: "Can't be judged" } as Record<Listed, string>,
  section: "Keep the latest backups",
  help:
    "What keeping only the latest backups in one folder would keep, and what it could remove. Here a backup is removed only when you confirm that one; the daily backup's Automatic removal, when you turn it on above, is its own setting.",
  budgetHelp:
    "A space budget is optional. With one, of the latest only as many are kept as fit in it together, by the sizes their manifests declare; the newest is always kept, and the count still limits how many.",
  folder: "Folder holding backups",
  keep: "Backups to keep",
  budget: "Space budget in GiB (optional)",
  noBudget: "No budget",
  preview: "Preview",
  started: (name: string) => `Removal of ${name} requested; Core's answer shows above. Preview again once it has ended.`,
  region: "Retention preview",
  summary: (p: { keep: number; within: string | null; kept: number; removable: number; about: string; unknownSizes: number; held: number; ignored: number; unreadable: number }) =>
    `Keeping the latest ${p.keep}${p.within ? ` within ${p.within}` : ""}: ${p.kept} kept, ${p.removable} could be removed (about ${p.about}, as their manifests declare${
      p.unknownSizes > 0 ? `; ${p.unknownSizes} more of a size that can't be trusted` : ""
    }), ${p.held} protected or can't be judged.${p.ignored > 0 ? ` ${p.ignored} other ${p.ignored === 1 ? "entry is" : "entries are"} not a backup.` : ""}${
      p.unreadable > 0 ? ` ${p.unreadable} ${p.unreadable === 1 ? "name" : "names"} can't be read, so nothing in this folder can be removed.` : ""
    }`,
  budgetLine: (said: string, reason: string) => `${said}: ${reason}.`,
  readsManifests: (basis: string) =>
    `The preview reads each backup's manifest only; no backup's files were checked. Check one to read every file back. Remove… removes one backup, after you confirm it. ${basis}`,
  group: (title: string, n: number) => `${title} (${n})`,
  backedUp: (when: string) => ` · backed up ${when}`,
  about: (size: string) => ` · about ${size}`,
  lastChecked: (when: string | null) => ` · ${when ? `last checked ${when}` : "not checked"}`,
  check: "Check",
  remove: "Remove…",
  removeLabel: (name: string) => `Remove ${name}`,
  confirmBefore: "Remove ",
  confirmAfter: (when: string | null, size: string | null) =>
    `${when ? `, backed up ${when}` : ""}${size ? `, about ${size}` : ""}? Only this one backup is removed. Core first checks the folder again and reads another backup of this Workspace back whole; if it can't, nothing is removed. A removed backup can't be brought back.`,
  removeThis: "Remove this backup",
  cancel: "Cancel",
}, {
  budgetSaid: { met: "在空间预算之内", over: "无法达到空间预算", unknown: "无法判断是否满足空间预算" },
  groups: { keep: "保留", remove: "可以删除", protected: "受保护", unknown: "无法判断" },
  section: "保留最新的备份",
  help: "如果一个文件夹中只保留最新的备份，会保留哪些、可以删除哪些。在这里，只有你确认某一个备份时才会删除它；每日备份的“自动删除”（在上方开启时）是单独的设置。",
  budgetHelp: "空间预算是可选的。设置后，在最新的备份中，只保留按其清单声明的大小合计能放进预算的数量；最新的一个总会保留，数量上限仍然有效。",
  folder: "存放备份的文件夹",
  keep: "要保留的备份数",
  budget: "空间预算（GiB，可选）",
  noBudget: "无预算",
  preview: "预览",
  started: (name) => `已请求删除 ${name}；Core 的回答显示在上方。删除结束后请重新预览。`,
  region: "保留预览",
  summary: (p) =>
    `保留最新的 ${p.keep} 个${p.within ? `（不超过 ${p.within}）` : ""}：保留 ${p.kept} 个，可以删除 ${p.removable} 个（按其清单声明约 ${p.about}${
      p.unknownSizes > 0 ? `；另有 ${p.unknownSizes} 个的大小不可信` : ""
    }），${p.held} 个受保护或无法判断。${p.ignored > 0 ? `另有 ${p.ignored} 个条目不是备份。` : ""}${
      p.unreadable > 0 ? `有 ${p.unreadable} 个名称无法读取，因此这个文件夹中不能删除任何内容。` : ""
    }`,
  budgetLine: (said, reason) => `${said}：${reason}。`,
  readsManifests: (basis) => `预览只读取每个备份的清单；没有检查任何备份的文件。检查某一个即可回读它的每个文件。“删除…”会在你确认后删除一个备份。${basis}`,
  group: (title, n) => `${title}（${n}）`,
  backedUp: (when) => ` · 备份于 ${when}`,
  about: (size) => ` · 约 ${size}`,
  lastChecked: (when) => ` · ${when ? `上次检查于 ${when}` : "未检查"}`,
  check: "检查",
  remove: "删除…",
  removeLabel: (name) => `删除 ${name}`,
  confirmBefore: "删除 ",
  confirmAfter: (when, size) =>
    `${when ? `，备份于 ${when}` : ""}${size ? `，约 ${size}` : ""}？只会删除这一个备份。Core 会先再次检查文件夹，并完整回读此 Workspace 的另一个备份；如果做不到，就不会删除任何内容。删除的备份无法恢复。`,
  removeThis: "删除这个备份",
  cancel: "取消",
});

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
  const t = useStrings(text);
  const [folder, setFolder] = useState(defaultFolder ?? "");
  const [keep, setKeep] = useState("7");
  /** In GiB; empty is no budget, the count alone. */
  const [budget, setBudget] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  /** The one backup whose removal is being confirmed. */
  const [confirming, setConfirming] = useState<Entry | null>(null);
  /** The backup whose removal was just asked for, said until the next preview. */
  const [started, setStarted] = useState("");
  const count = Number(keep);
  const gib = Number(budget);
  const budgetBytes = budget.trim() === "" ? undefined : Math.max(1, Math.round(gib * GIB));
  const budgetValid = budget.trim() === "" || (Number.isFinite(gib) && gib > 0 && gib <= 1024 * 1024);
  const valid = folder.trim() !== "" && Number.isInteger(count) && count >= 1 && count <= 100 && budgetValid;

  async function run() {
    setReading(true);
    setError("");
    setPreview(null);
    setConfirming(null);
    setStarted("");
    try {
      setPreview(await api<Preview>("/workspace/backup/retention/preview", {
        method: "POST",
        body: JSON.stringify({ folder: folder.trim(), keep: count, ...(budgetBytes === undefined ? {} : { budgetBytes }) }),
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
    <div className="settings-group backup-retention" aria-label={t.section}>
      <div className="settings-row workspace-backup-row">
        <span className="settings-row-main">
          <span className="settings-row-title">{t.section}</span>
          <span className="settings-row-help">{t.help}</span>
          <span className="settings-row-help">{t.budgetHelp}</span>
        </span>
      </div>
      <div className="settings-row workspace-backup-row">
        <input
          className="settings-input"
          aria-label={t.folder}
          placeholder="/path/to/backups-folder"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        />
        <input
          className="settings-input backup-retention-keep"
          type="number"
          min={1}
          max={100}
          aria-label={t.keep}
          value={keep}
          onChange={(e) => setKeep(e.target.value)}
        />
        <input
          className="settings-input backup-retention-keep"
          type="number"
          min={0}
          step="any"
          aria-label={t.budget}
          placeholder={t.noBudget}
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
        />
        <button type="button" disabled={!valid || reading} onClick={() => void run()}>
          {t.preview}
        </button>
      </div>
      {error && (
        <p className="workspace-backup-error" role="alert">
          {error}
        </p>
      )}
      {started && (
        <p className="workspace-backup-note" role="status">
          {t.started(started)}
        </p>
      )}
      {preview && (
        <div className="backup-retention-result" role="region" aria-label={t.region}>
          <p role="status">
            {t.summary({
              keep: preview.keep,
              within: preview.budget ? size(preview.budget.bytes) : null,
              kept: shown.filter((e) => e.verdict === "keep").length,
              removable: shown.filter((e) => e.verdict === "remove").length,
              about: size(preview.removableEstimateBytes),
              unknownSizes: preview.removableUnknownSizes,
              held: shown.filter((e) => e.verdict === "protected" || e.verdict === "unknown").length,
              ignored,
              unreadable: preview.unreadableNames,
            })}
          </p>
          {preview.budget && (
            <p className={preview.budget.state === "met" ? "workspace-backup-note" : "workspace-backup-error"} data-budget={preview.budget.state}>
              {t.budgetLine(t.budgetSaid[preview.budget.state], preview.budget.reason)}
            </p>
          )}
          <p className="settings-row-help">{t.readsManifests(preview.sizeBasis)}</p>
          {groups.map((verdict) => {
            const items = shown.filter((e) => e.verdict === verdict);
            if (!items.length) return null;
            return (
              <section key={verdict} className="backup-retention-group" data-verdict={verdict}>
                <h4>{t.group(t.groups[verdict], items.length)}</h4>
                <ul>
                  {items.map((e) => (
                    <li key={e.name}>
                      <span className="backup-retention-name">
                        <code>{e.name}</code>
                        {e.createdAt && t.backedUp(when(e.createdAt))}
                        {e.estimateBytes !== undefined && t.about(size(e.estimateBytes))}
                        {t.lastChecked(e.lastCheckedAt ? when(e.lastCheckedAt) : null)}
                      </span>
                      <span className="settings-row-help">{e.reason}</span>
                      {(verdict === "keep" || verdict === "remove") && (
                        <span className="backup-retention-actions">
                          <button type="button" disabled={busy} onClick={() => onCheck(e.path)}>
                            {t.check}
                          </button>
                          {verdict === "remove" && e.manifestSha256 && preview.unreadableNames === 0 && (
                            <button type="button" disabled={busy} onClick={() => setConfirming(e)}>
                              {t.remove}
                            </button>
                          )}
                        </span>
                      )}
                      {confirming?.name === e.name && e.manifestSha256 && (
                        <div className="backup-retention-confirm" role="group" aria-label={t.removeLabel(e.name)}>
                          <p>
                            {t.confirmBefore}
                            <code>{e.path}</code>
                            {t.confirmAfter(e.createdAt ? when(e.createdAt) : null, e.estimateBytes !== undefined ? size(e.estimateBytes) : null)}
                          </p>
                          <span className="backup-retention-actions">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                // Judged again by Core under the same count and budget.
                                const rule = preview.budget ? { keep: preview.keep, budgetBytes: preview.budget.bytes } : { keep: preview.keep };
                                onRemove({ folder: preview.folder, ...rule, name: e.name, manifestSha256: e.manifestSha256! });
                                // The preview is from before the removal; it is read again once that has ended.
                                setPreview(null);
                                setConfirming(null);
                                // Core may still refuse it at once; its answer shows above, with the backup operations.
                                setStarted(e.name);
                              }}
                            >
                              {t.removeThis}
                            </button>
                            <button type="button" onClick={() => setConfirming(null)}>
                              {t.cancel}
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
