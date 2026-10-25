// T-193: Settings → Data & storage. What this device keeps for this site,
// what the Workspace keeps on the Core host (GET /api/storage, which walks no
// folder), and what is kept elsewhere. Read only: nothing here removes anything.

/** One top-level name in Core's data folder (storage_overview.rs `describe`). */
export type StorageEntry = {
  name: string;
  what: string;
  kind: "file" | "folder" | "link" | "special" | "unreadable";
  bytes?: number;
  diskBytes?: number;
  modifiedAt?: string | null;
  backup: "copied" | "excluded" | "notCopied";
  backupReason: string | null;
  error?: string;
};

export type NativeGroup = { harness: string; machine: string | null; agents: number; closed: number };

export type StorageOverviewView = {
  format: 1;
  readAt: string;
  dataDir: string;
  entries: StorageEntry[];
  unreadable: string | null;
  database: { pageSize: number | null; pages: number | null; freePages: number | null };
  jobs: { total: number | null; unfinished: number | null };
  native: NativeGroup[];
  notInBackup: string[];
};

/** What each name Core makes in its data folder holds. */
export const entryLabels: Record<string, string> = {
  database: "Workspace database",
  databaseLog: "Database write-ahead log",
  databaseIndex: "Database log index",
  databaseJournal: "Database rollback journal",
  lock: "Workspace lock",
  inputImages: "Images sent to Agents",
  briefAttachments: "Brief attachments",
  reviews: "Code review sources",
  jobs: "Job records and output logs",
  claudeRuntime: "Claude runtime cache",
  opencode: "OpenCode session databases",
  desktopDownloads: "Desktop app downloads",
  backupOperations: "Record of backups and restores",
  backupSchedule: "Daily backup schedule",
  earlierDatabaseCopy: "Earlier database copy, kept from a one-time conversion",
  unknown: "Not made by this Core",
};

export const harnessNames: Record<string, string> = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" };

/** Bytes in binary units; never rounds a non-zero size to 0. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Groups of this site's browser storage, in the order the page shows them. */
export type DeviceGroupId = "unsent" | "drafts" | "pending" | "preferences" | "reading" | "records" | "other" | "foreign";

export const deviceGroups: { id: DeviceGroupId; label: string; note: string }[] = [
  { id: "unsent", label: "Messages not yet accepted by Core", note: "Sent again from this browser until Core has them." },
  { id: "drafts", label: "Drafts", note: "Composer drafts and pastes, Home replies, answers and forms not sent yet." },
  { id: "pending", label: "Requests waiting for an answer", note: "Kept so that asking again is the same request." },
  { id: "preferences", label: "Preferences for this device", note: "Appearance, sending, panel widths and Home layout." },
  { id: "reading", label: "Reading places and views", note: "Made again as you use Yuzuno." },
  { id: "records", label: "Diagnostics and plan records", note: "The last errors and reads kept for Copy diagnostics, and Claude's last usage report." },
  { id: "other", label: "Other Yuzuno data", note: "Saved by another version of Yuzuno at this address." },
  { id: "foreign", label: "Not saved by Yuzuno", note: "Saved by something else at this address." },
];

/** Key prefixes and names, as the modules that own them write them. */
const keyGroups: [DeviceGroupId, string[]][] = [
  ["unsent", ["yuzuno.outbox", "yuzuno.home-outbox.v1"]],
  ["drafts", [
    "yuzuno.composer.v1:", "yuzuno.paste.v1:", "yuzuno.drafts", "yuzuno.home-card-drafts.v1",
    "yuzuno.request-drafts.v1:", "yuzuno.question-draft.v1:", "yuzuno.job-submission.v1:", "yuzuno.clarification.v1:",
  ]],
  ["pending", ["yuzuno.update-intent", "yuzuno.codexForkRequests", "yuzuno.taskProposal."]],
  ["preferences", [
    "yuzuno.appearance", "yuzuno.preferences", "yuzuno.panel-widths", "yuzuno.projectScope.",
    "yuzuno.projectGroupsFolded.", "yuzuno.homeWidgets", "yuzuno.homeWidgets.", "yuzuno.home-panel.v1:", "yuzuno.home-cards.v1:",
  ]],
  ["reading", [
    "yuzuno.selected.", "yuzuno.selected", "yuzuno.reading.", "yuzuno.reading-source.v1:", "yuzuno.reading-seq.v1:",
    "yuzuno.reading-offers.v1:", "yuzuno.home-seen-blocks.v1:", "yuzuno.result-view.", "yuzuno.hiddenDeliveries",
    "yuzuno.question-dismissed.v1:",
  ]],
  ["records", ["yuzuno.diagnostics.v1", "yuzuno.claude-plan"]],
];

function groupOf(key: string): DeviceGroupId {
  for (const [id, names] of keyGroups) {
    if (names.some((name) => key === name || (/[:.]$/.test(name) && key.startsWith(name)))) return id;
  }
  return key.startsWith("yuzuno.") ? "other" : "foreign";
}

export type DeviceGroup = { id: DeviceGroupId; keys: number; bytes: number };
export type DeviceInventory = {
  readAt: string;
  available: boolean;
  reason?: string;
  groups: DeviceGroup[];
  /** Agents with a composer draft that has text, a paste, an image or a skill. */
  draftAgents: number;
  /** Composer drafts this page could not read: kept as they are. */
  unreadableDrafts: number;
  unsentMessages: number;
  bytes: number;
};

/** (key + value) × 2 bytes: browsers keep this storage as UTF-16 text. */
const estimate = (key: string, value: string) => (key.length + value.length) * 2;

/** Reads this site's localStorage without changing it. Draft text is never kept. */
export function deviceInventory(storage: Storage | null, now = new Date()): DeviceInventory {
  const readAt = now.toISOString();
  const empty = { readAt, groups: [], draftAgents: 0, unreadableDrafts: 0, unsentMessages: 0, bytes: 0 };
  if (!storage) return { ...empty, available: false, reason: "This browser gives Yuzuno no storage here." };
  const totals = new Map<DeviceGroupId, DeviceGroup>();
  let draftAgents = 0;
  let unreadableDrafts = 0;
  let unsentMessages = 0;
  let bytes = 0;
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key === null) continue;
      const value = storage.getItem(key) ?? "";
      const id = groupOf(key);
      const group = totals.get(id) ?? { id, keys: 0, bytes: 0 };
      group.keys += 1;
      group.bytes += estimate(key, value);
      bytes += estimate(key, value);
      totals.set(id, group);
      if (key.startsWith("yuzuno.composer.v1:")) {
        try {
          const draft = JSON.parse(value);
          if (draft?.parts?.length || draft?.images?.length || draft?.skills?.length) draftAgents += 1;
        } catch {
          unreadableDrafts += 1;
        }
      }
      if (key === "yuzuno.outbox") {
        try {
          // A Workspace's id to its records (useConversationSend.ts), plus any
          // record saved before the outbox was kept per Workspace, which sits
          // at the top of the file. Every unsent message at this address is
          // counted, whichever Workspace it belongs to: this view is the
          // device's, and saying a smaller number would hide what is here.
          for (const entry of Object.values(JSON.parse(value) ?? {}))
            unsentMessages +=
              entry && typeof entry === "object" && typeof (entry as { clientMessageId?: unknown }).clientMessageId !== "string"
                ? Object.keys(entry).length
                : 1;
        } catch {
          /* counted by size only */
        }
      }
    }
  } catch (error) {
    return { ...empty, available: false, reason: `This browser refused to read its storage (${error instanceof Error ? error.message : String(error)}).` };
  }
  const groups = deviceGroups.map(({ id }) => totals.get(id)).filter((group): group is DeviceGroup => !!group);
  return { readAt, available: true, groups, draftAgents, unreadableDrafts, unsentMessages, bytes };
}

/** The browser's own figures for this site, when it reports them. */
export type BrowserEstimate = { usage: number; quota: number } | null;

export async function browserEstimate(): Promise<BrowserEstimate> {
  try {
    const value = await navigator.storage?.estimate?.();
    return typeof value?.usage === "number" && typeof value?.quota === "number" ? { usage: value.usage, quota: value.quota } : null;
  } catch {
    return null;
  }
}
