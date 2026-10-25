import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, NetworkError } from "./api";
import { BackupRetention } from "./BackupRetention";
import { strings, useLanguage } from "./i18n";
import "./workspace-backup.css";

/** T-192: Settings → Backup. Core backs up its own Workspace, checks a
 * backup and restores one into a new or empty folder, each as an operation
 * it runs and reports (core/src/workspace_backup/online.rs). This page never
 * replaces or switches the Workspace this Core uses and never starts a Core
 * on a restored copy; through the phone entry it only reads. */

type Excluded = { path: string; reason: string };
type Summary = {
  path: string;
  workspaceId: string;
  createdAt: string;
  agents: number;
  files: number;
  bytes: number;
  excluded: Excluded[];
  notCovered: string[];
};
type Operation = {
  id: string;
  requestId: string;
  kind: "backup" | "check" | "restore" | "remove";
  state: "running" | "succeeded" | "failed" | "stopped" | "interrupted";
  step: string;
  /** As started; an automatic removal (T-196) says `automatic`. */
  request: Record<string, string | number | boolean | undefined>;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: (Summary & {
    restoredTo?: string;
    nextSteps?: string[];
    notes?: string[];
    /** A removal (T-196): what it removed and the backup it read back whole first;
     * an automatic one (slice 6) lists what it removed. */
    removed?: string | Pass["removed"];
    freedEstimateBytes?: number | null;
    keptChecked?: string;
  }) | null;
};
type View = {
  canChange: boolean;
  workspaceId: string;
  canBackUp: boolean;
  refusals: { code: string; detail: string }[];
  unfinishedJobs: { id: string; name: string }[];
  estimateBytes: number;
  current: Operation | null;
  recent: Operation[];
  notCovered: string[];
  replaceRunningWorkspace: string;
  /** Absent from a Core before T-196. */
  schedule?: Schedule;
};
/** What one automatic removal pass did (core retention::prune). */
type Pass = {
  removed: { name: string; freedEstimateBytes?: number | null }[];
  skipped: { name: string; reason: string }[];
  left: number;
  removedEstimateBytes?: number;
  keptCheckedName?: string;
  sizeBasis: string;
};
/** Automatic removal after each daily backup that succeeds (T-196, slice 6),
 * as confirmed for the schedule's folder. */
type Retention = { keep: number; budgetBytes?: number; folder: string; confirmedAt: string };
/** What automatic removal did after one run, apart from its backup. */
type Cleanup = {
  state: "due" | "running" | "succeeded" | "failed" | "stopped" | "interrupted" | "not_run";
  keep: number;
  budgetBytes?: number;
  folder: string;
  decidedAt: string;
  operationId: string | null;
  reason: string | null;
  error: string | null;
  result: Pass | null;
  finishedAt: string | null;
};
/** The daily backup (T-196): a time of day in UTC, a folder each run writes a
 * new folder in, the next slot and the last run as its operation ended. */
type Schedule = {
  enabled: boolean;
  timeUtc: string;
  folder: string | null;
  nextRunAt: string | null;
  /** Absent from a Core before slice 6. */
  retention?: Retention | null;
  retentionNote?: string | null;
  lastRun: {
    slot: string;
    missed: number;
    startedAt: string;
    to: string;
    operationId: string | null;
    state: "running" | "succeeded" | "failed" | "stopped" | "interrupted" | "not_started";
    error: string | null;
    finishedAt: string | null;
    cleanup?: Cleanup | null;
  } | null;
};
type Precheck = {
  ok: true;
  workspaceId: string;
  createdAt: string;
  agents: number;
  files: number;
  bytes: number;
  target: "new" | "empty";
  sameIdentity: boolean;
  notes: string[];
};
/** A request sent and not yet answered: a retry sends it again as is. */
type Pending = { path: string; body: Record<string, string | number | undefined> & { requestId: string } };

// The page's own words (T-189). Paths, folder and backup names, Workspace and
// operation IDs, hashes, sizes, times, states and codes as Core sends them,
// and what Core says (a refusal, an error, a reason, a note, a next step, how
// sizes are told) come as they are; a state is put in words only where shown.
const text = strings({
  steps: {
    start: "Starting",
    database: "Copying the database",
    files: "Copying files",
    verify: "Reading the backup back",
    check: "Checking the restored Workspace",
    preview: "Checking the folder",
    recheck: "Checking the folder again",
    remove: "Removing the old backup",
  } as Record<string, string>,
  kinds: { backup: "Backup", check: "Check", restore: "Restore", remove: "Removal" } as Record<Operation["kind"], string>,
  automaticRemoval: "Automatic removal",
  states: {
    running: "running", succeeded: "succeeded", failed: "failed", stopped: "stopped", interrupted: "interrupted", not_started: "not_started",
  } as Record<string, string>,
  section: "Workspace backup",
  intro:
    "A backup is a folder on the computer that runs Core. It holds the database, image copies, Brief attachments, finished reviews and Job folders, with a manifest of every file and of what was left out.",
  readOnly: "Backups and restores start from the computer that runs Core. Here they can only be seen.",
  never: "Never in a backup",
  backUpTitle: "Back up this Workspace",
  backUpHelp: (about: string | null) => `A new folder, as an absolute path on the computer that runs Core.${about ? ` About ${about}.` : ""}`,
  backupFolder: "Backup folder",
  backUp: "Back up",
  refusalLead: (detail: string) => `${detail}:`,
  job: "Job",
  checkTitle: "Check a backup",
  checkHelp: "Reads every file and the database back against its manifest.",
  checkPath: "Backup to check",
  check: "Check",
  restoreTitle: "Restore into a new folder",
  restoreHelp:
    "A new or empty folder. The Workspace this Core uses is never replaced, and no Core is started on the restored copy.",
  restoreFrom: "Backup to restore",
  restoreInto: "Restore into",
  checkRestore: "Check restore",
  restore: "Restore",
  canRestore: (target: "new" | "empty", agents: number, files: number, size: string, at: string) =>
    `Can be restored into this ${target === "new" ? "new" : "empty"} folder: ${agents} Agents, ${files} files, ${size}, backed up ${at}.`,
  lost: "No answer from Core. The request may have arrived; trying again sends the same request.",
  tryAgain: "Try again",
  recent: "Recent",
  limit: (said: string) => `${said}.`,
  made: (n: number) => ` It made up for ${n} missed ${n === 1 ? "day" : "days"}.`,
  noReason: "no reason was given",
  runRunning: (slot: string, to: string, made: string) => `The run for ${slot} is backing up to ${to}.${made}`,
  runSucceeded: (slot: string, to: string, made: string) => `Last run, for ${slot}: backed up to ${to} and checked.${made}`,
  runNotStarted: (slot: string, error: string, made: string) => `Last run, for ${slot}, did not start: ${error}.${made}`,
  runEnded: (slot: string, state: string, error: string, made: string) => `Last run, for ${slot}, ${state}: ${error}.${made}`,
  ended: { failed: "failed", stopped: "stopped", interrupted: "interrupted", running: "running", succeeded: "succeeded", not_started: "not_started", due: "due", not_run: "not_run" } as Record<string, string>,
  removed: (n: number, names: string, about: string | null, kept: string | null) =>
    `Removed ${n} old ${n === 1 ? "backup" : "backups"}: ${names}${about ? `, about ${about} as their manifests declared (disk use can differ)` : ""}.${kept ? ` First, ${kept} was read back whole.` : ""}`,
  nothingRemoved: "Nothing needed removing.",
  notRemoved: (items: { name: string; reason: string }[]) => ` Not removed: ${items.map((s) => `${s.name} (${s.reason})`).join("; ")}.`,
  left: (n: number) => ` ${n} more wait for the next run that succeeds.`,
  cleanupDue: "Removing old backups after this run waits for another backup, check or restore to end.",
  cleanupRunning: "Removing old backups after this run…",
  cleanupDone: (pass: string | null) => `After this run: ${pass ?? "done."}`,
  cleanupNotRun: (reason: string) => `Old backups were not removed after this run: ${reason}.`,
  cleanupEnded: (state: string, error: string) =>
    `Removing old backups after this run ${state === "interrupted" ? "was interrupted" : state}: ${error}. The backup itself is as said above; this is not tried again on its own.`,
  daily: "Daily backup",
  dailyOn: (time: string, local: string, folder: string, removal: boolean) =>
    `Every day at ${time} UTC (${local} on this device), into a new folder in ${folder}. ${
      removal ? "Old backups there are removed as Automatic removal below says." : "Old backups are never deleted."
    }`,
  dailyOff: "Off. When on, Core backs up once a day while it runs, as Back up does; a day it was stopped or asleep is made up once.",
  everyDay: "Back up every day",
  timeOfDay: "Time of day (UTC)",
  dailyFolder: "Folder for daily backups",
  save: "Save",
  timeHere: (time: string, local: string) => `${time} UTC is ${local} on this device today.`,
  nextRun: (at: string) => `Next run: ${at}.`,
  autoRemoval: "Automatic removal",
  autoOn: (since: string, keep: number, within: string | null, folder: string) =>
    `On since ${since}: after each daily backup that succeeds, Core keeps the latest ${keep}${
      within ? ` within ${within} (by the sizes their manifests declare)` : ""
    } in ${folder} and removes older backups of this Workspace there, at most 20 at a time.`,
  autoOff: "Off: old daily backups are never removed on their own.",
  autoRules:
    " A protected backup or one that can't be judged is never removed, and each removal first reads a kept backup back whole, as Remove… does. A failed, stopped or interrupted backup removes nothing; nothing is retried on its own.",
  note: (said: string) => `${said}.`,
  folderFirst: "Save a folder for the daily backup first.",
  autoKeep: "Daily backups to keep",
  autoBudget: "Space budget for daily backups in GiB (optional)",
  noBudget: "No budget",
  preview: "Preview",
  turnOff: "Turn off",
  autoPreview: "Automatic removal preview",
  autoSummary: (p: { folder: string; keep: number; within: string | null; kept: number; removable: number; about: string; held: number; unreadable: boolean }) =>
    `In ${p.folder} now, keeping the latest ${p.keep}${p.within ? ` within ${p.within}` : ""} would keep ${p.kept} and remove ${p.removable}${
      p.removable > 0 ? ` (about ${p.about} as their manifests declare)` : ""
    }; ${p.held} protected or can't be judged.${p.unreadable ? " Some names can't be read, so nothing in this folder would be removed." : ""}`,
  wouldRemove: "Would be removed now",
  autoAfter: (basis: string) =>
    `Turning it on removes nothing now. After each daily backup that succeeds, Core previews this folder again and removes what that preview offers then. ${basis}`,
  saveSettings: "Save these settings",
  turnOn: "Turn on automatic removal",
  sameSettings: "These are the settings on now.",
  opLabel: (kind: string, state: string) => `${kind} ${state}`,
  opRunning: (kind: string, step: string) => `${kind}: ${step}…`,
  opDone: (kind: string) => `${kind} finished`,
  opStopped: (kind: string, writes: boolean) => `${kind} stopped${writes ? "; nothing it was writing was kept" : ""}`,
  opInterrupted: (kind: string, writes: boolean) => `${kind} interrupted when Core stopped${writes ? "; nothing it was writing was kept" : ""}`,
  opFailed: (kind: string, step: string) => `${kind} failed at “${step}”`,
  stopping: "Stopping…",
  stop: "Stop",
  stopLost: "No answer from Core to Stop. It may have arrived; Stop asks again.",
  removedBefore: "Removed ",
  removedMiddle: (about: string | null) => `${about ? `, about ${about} as its manifest declared` : ""}. First, `,
  removedAfter: " was read back whole. A removed backup can't be brought back.",
  restoredBefore: "Restored into ",
  restoredAfter: (agents: number, files: number) => `: ${agents} Agents, ${files} files.`,
  nextSteps: "To use the restored Workspace",
  backedUpTo: "Backed up to ",
  checked: "Checked ",
  summaryAfter: (agents: number, files: number, size: string) => `: ${agents} Agents, ${files} files, ${size}.`,
  leftOut: (n: number) => `Left out (${n})`,
}, {
  steps: {
    start: "正在开始",
    database: "正在复制数据库",
    files: "正在复制文件",
    verify: "正在回读备份",
    check: "正在检查恢复的 Workspace",
    preview: "正在检查文件夹",
    recheck: "正在再次检查文件夹",
    remove: "正在删除旧备份",
  },
  kinds: { backup: "备份", check: "检查", restore: "恢复", remove: "删除" },
  automaticRemoval: "自动删除",
  states: { running: "运行中", succeeded: "成功", failed: "失败", stopped: "已停止", interrupted: "已中断", not_started: "未开始" },
  section: "Workspace 备份",
  intro: "备份是运行 Core 的电脑上的一个文件夹。它包含数据库、图片副本、Brief 附件、已完成的审查和 Job 文件夹，并附有列出每个文件以及未包含内容的清单。",
  readOnly: "备份和恢复要从运行 Core 的电脑上开始。在这里只能查看。",
  never: "从不包含在备份中",
  backUpTitle: "备份此 Workspace",
  backUpHelp: (about) => `一个新文件夹，填写运行 Core 的电脑上的绝对路径。${about ? `约 ${about}。` : ""}`,
  backupFolder: "备份文件夹",
  backUp: "备份",
  refusalLead: (detail) => `${detail}：`,
  job: "Job",
  checkTitle: "检查备份",
  checkHelp: "按清单回读每个文件和数据库。",
  checkPath: "要检查的备份",
  check: "检查",
  restoreTitle: "恢复到新文件夹",
  restoreHelp: "一个新的或空的文件夹。此 Core 使用的 Workspace 从不会被替换，也不会在恢复的副本上启动 Core。",
  restoreFrom: "要恢复的备份",
  restoreInto: "恢复到",
  checkRestore: "检查恢复",
  restore: "恢复",
  canRestore: (target, agents, files, size, at) =>
    `可以恢复到这个${target === "new" ? "新" : "空"}文件夹：${agents} 个 Agent、${files} 个文件、${size}，备份于 ${at}。`,
  lost: "Core 没有回答。请求可能已经到达；重试会发送同一个请求。",
  tryAgain: "重试",
  recent: "最近",
  limit: (said) => `${said}.`,
  made: (n) => `它补做了 ${n} 天错过的备份。`,
  noReason: "没有给出原因",
  runRunning: (slot, to, made) => `${slot} 的运行正在备份到 ${to}。${made}`,
  runSucceeded: (slot, to, made) => `上次运行（${slot}）：已备份到 ${to} 并已检查。${made}`,
  runNotStarted: (slot, error, made) => `上次运行（${slot}）没有开始：${error}。${made}`,
  runEnded: (slot, state, error, made) => `上次运行（${slot}）${state}：${error}。${made}`,
  ended: { failed: "失败", stopped: "已停止", interrupted: "被中断", running: "运行中", succeeded: "成功", not_started: "未开始", due: "待运行", not_run: "未运行" },
  removed: (n, names, about, kept) =>
    `已删除 ${n} 个旧备份：${names}${about ? `，按其清单声明约 ${about}（实际磁盘占用可能不同）` : ""}。${kept ? `删除前已完整回读 ${kept}。` : ""}`,
  nothingRemoved: "没有需要删除的。",
  notRemoved: (items) => `未删除：${items.map((s) => `${s.name}（${s.reason}）`).join("；")}。`,
  left: (n) => `另有 ${n} 个等待下一次成功的运行。`,
  cleanupDue: "本次运行后的旧备份删除，正在等待另一个备份、检查或恢复结束。",
  cleanupRunning: "正在删除本次运行后的旧备份…",
  cleanupDone: (pass) => `本次运行后：${pass ?? "已完成。"}`,
  cleanupNotRun: (reason) => `本次运行后没有删除旧备份：${reason}。`,
  cleanupEnded: (state, error) =>
    `本次运行后的旧备份删除${state === "interrupted" ? "被中断" : state === "failed" ? "失败" : state === "stopped" ? "已停止" : state}：${error}。备份本身如上所述；这一步不会自动重试。`,
  daily: "每日备份",
  dailyOn: (time, local, folder, removal) =>
    `每天 UTC ${time}（此设备上为 ${local}），在 ${folder} 中新建一个文件夹。${removal ? "那里的旧备份会按下方“自动删除”的说明删除。" : "旧备份从不会被删除。"}`,
  dailyOff: "关闭。开启后，Core 在运行期间每天备份一次，与“备份”相同；它停止或休眠的某一天会补做一次。",
  everyDay: "每天备份",
  timeOfDay: "每天的时间（UTC）",
  dailyFolder: "每日备份的文件夹",
  save: "保存",
  timeHere: (time, local) => `UTC ${time} 是此设备今天的 ${local}。`,
  nextRun: (at) => `下次运行：${at}。`,
  autoRemoval: "自动删除",
  autoOn: (since, keep, within, folder) =>
    `自 ${since} 起开启：每次成功的每日备份之后，Core 会在 ${folder} 中保留最新的 ${keep} 个${
      within ? `，合计不超过 ${within}（按其清单声明的大小）` : ""
    }，并删除那里此 Workspace 更旧的备份，每次最多 20 个。`,
  autoOff: "关闭：旧的每日备份不会被自动删除。",
  autoRules: "受保护或无法判断的备份从不会被删除；每次删除前，都会像“删除…”一样先完整回读一个保留的备份。失败、停止或中断的备份不会删除任何内容；不会自动重试。",
  note: (said) => `${said}.`,
  folderFirst: "请先为每日备份保存一个文件夹。",
  autoKeep: "要保留的每日备份数",
  autoBudget: "每日备份的空间预算（GiB，可选）",
  noBudget: "无预算",
  preview: "预览",
  turnOff: "关闭",
  autoPreview: "自动删除预览",
  autoSummary: (p) =>
    `现在在 ${p.folder} 中保留最新的 ${p.keep} 个${p.within ? `（不超过 ${p.within}）` : ""}，会保留 ${p.kept} 个、删除 ${p.removable} 个${
      p.removable > 0 ? `（按其清单声明约 ${p.about}）` : ""
    }；${p.held} 个受保护或无法判断。${p.unreadable ? "有些名称无法读取，因此这个文件夹中不会删除任何内容。" : ""}`,
  wouldRemove: "现在会删除的",
  autoAfter: (basis) => `开启不会立即删除任何内容。每次成功的每日备份之后，Core 会再次预览这个文件夹，并删除那时预览给出的备份。${basis}`,
  saveSettings: "保存这些设置",
  turnOn: "开启自动删除",
  sameSettings: "这些就是当前生效的设置。",
  opLabel: (kind, state) => `${kind}${state}`,
  opRunning: (kind, step) => `${kind}：${step}…`,
  opDone: (kind) => `${kind}已完成`,
  opStopped: (kind, writes) => `${kind}已停止${writes ? "；它正在写入的内容没有保留" : ""}`,
  opInterrupted: (kind, writes) => `${kind}在 Core 停止时被中断${writes ? "；它正在写入的内容没有保留" : ""}`,
  opFailed: (kind, step) => `${kind}在“${step}”失败`,
  stopping: "正在停止…",
  stop: "停止",
  stopLost: "Core 没有回答“停止”。它可能已经到达；“停止”会再次请求。",
  removedBefore: "已删除 ",
  removedMiddle: (about) => `${about ? `，按其清单声明约 ${about}` : ""}。删除前已完整回读 `,
  removedAfter: "。删除的备份无法恢复。",
  restoredBefore: "已恢复到 ",
  restoredAfter: (agents, files) => `：${agents} 个 Agent、${files} 个文件。`,
  nextSteps: "要使用恢复的 Workspace",
  backedUpTo: "已备份到 ",
  checked: "已检查 ",
  summaryAfter: (agents, files, size) => `：${agents} 个 Agent、${files} 个文件、${size}。`,
  leftOut: (n) => `未包含（${n}）`,
});
type Words = ReturnType<typeof text>;
/** An automatic removal (T-196, slice 6) is said as one. */
const kindName = (op: Operation, t: Words) => (op.request.automatic ? t.automaticRemoval : t.kinds[op.kind]);
const stepName = (step: string, t: Words) => t.steps[step] ?? step;
const stateName = (state: string, t: Words) => t.states[state] ?? state;

function bytes(n: number) {
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

function requestId() {
  return crypto.randomUUID();
}

export function WorkspaceBackup({ active }: { active: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [to, setTo] = useState("");
  const [checkPath, setCheckPath] = useState("");
  const [from, setFrom] = useState("");
  const [into, setInto] = useState("");
  const [precheck, setPrecheck] = useState<{ from: string; to: string; result: Precheck } | null>(null);
  const [prechecking, setPrechecking] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [lost, setLost] = useState(false);
  const [watched, setWatched] = useState<Operation | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const read = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api<View>("/workspace/backup", { signal });
      setView(next);
      if (next.current) setWatched(next.current);
    } catch (e) {
      if (!signal?.aborted) setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [active, read]);

  // While an operation runs, its step is read once a second.
  useEffect(() => {
    if (!active || watched?.state !== "running") return;
    const id = watched.id;
    timer.current = window.setTimeout(async () => {
      try {
        const op = await api<Operation>(`/workspace/backup/operations/${id}`);
        setWatched(op);
        if (op.state !== "running") void read();
      } catch (e) {
        setError(errorText(e));
        setWatched((old) => (old ? { ...old } : old));
      }
    }, 1000);
    return () => window.clearTimeout(timer.current);
  }, [active, watched, read]);

  async function send(next: Pending) {
    setPending(next);
    setLost(false);
    setError("");
    try {
      const answer = await api<{ operation: Operation }>(next.path, {
        method: "POST",
        body: JSON.stringify(next.body),
      });
      setPending(null);
      setWatched(answer.operation);
      void read();
    } catch (e) {
      if (e instanceof NetworkError) {
        // The request may have arrived: Try again sends the same requestId.
        setLost(true);
      } else {
        setPending(null);
        setError(errorText(e));
      }
    }
  }

  async function runPrecheck() {
    setPrechecking(true);
    setError("");
    setPrecheck(null);
    try {
      const result = await api<Precheck>("/workspace/restore/precheck", {
        method: "POST",
        body: JSON.stringify({ from, to: into }),
      });
      setPrecheck({ from, to: into, result });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPrechecking(false);
    }
  }

  const running = watched?.state === "running";
  const busy = running || !!pending;
  const canChange = !!view?.canChange;
  const prechecked = !!precheck && precheck.from === from && precheck.to === into;
  const jobsRefusal = view?.refusals.find((r) => r.code === "unfinished_jobs");
  const otherRefusals = view?.refusals.filter((r) => r.code !== "unfinished_jobs" && r.code !== "busy") ?? [];

  return (
    <section id="settings-backup" className="settings-section workspace-backup" aria-label={t.section}>
      <header className="settings-section-heading">
        <div>
          <h3>{t.section}</h3>
          <p>{t.intro}</p>
        </div>
      </header>

      {view && !canChange && (
        <p className="workspace-backup-note" role="note">
          {t.readOnly}
        </p>
      )}
      {view && (
        <details className="workspace-backup-coverage">
          <summary>{t.never}</summary>
          <ul>
            {view.notCovered.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      )}

      {canChange && (
        <div className="settings-group" aria-label={t.backUpTitle}>
          <div className="settings-row workspace-backup-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.backUpTitle}</span>
              <span className="settings-row-help">{t.backUpHelp(view ? bytes(view.estimateBytes) : null)}</span>
            </span>
            <input
              className="settings-input"
              aria-label={t.backupFolder}
              placeholder="/path/to/new-backup-folder"
              value={to}
              disabled={busy}
              onChange={(e) => setTo(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || !view?.canBackUp || !to.trim()}
              onClick={() => void send({ path: "/workspace/backups", body: { requestId: requestId(), to: to.trim() } })}
            >
              {t.backUp}
            </button>
          </div>
          {jobsRefusal && (
            <div className="workspace-backup-refusal" role="status">
              <p>{t.refusalLead(jobsRefusal.detail)}</p>
              <ul>
                {view?.unfinishedJobs.map((job) => (
                  <li key={job.id}>
                    {job.name || t.job} <code>{job.id}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {otherRefusals.map((r) => (
            <p key={r.code} className="workspace-backup-refusal" role="status">
              {r.detail}
            </p>
          ))}
        </div>
      )}

      {canChange && (
        <div className="settings-group" aria-label={t.checkTitle}>
          <div className="settings-row workspace-backup-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.checkTitle}</span>
              <span className="settings-row-help">{t.checkHelp}</span>
            </span>
            <input
              className="settings-input"
              aria-label={t.checkPath}
              placeholder="/path/to/backup-folder"
              value={checkPath}
              disabled={busy}
              onChange={(e) => setCheckPath(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || !checkPath.trim()}
              onClick={() =>
                void send({ path: "/workspace/backups/check", body: { requestId: requestId(), path: checkPath.trim() } })
              }
            >
              {t.check}
            </button>
          </div>
        </div>
      )}

      {canChange && (
        <div className="settings-group" aria-label={t.restoreTitle}>
          <div className="settings-row workspace-backup-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.restoreTitle}</span>
              <span className="settings-row-help">{t.restoreHelp}</span>
            </span>
          </div>
          <div className="settings-row workspace-backup-row">
            <input
              className="settings-input"
              aria-label={t.restoreFrom}
              placeholder="/path/to/backup-folder"
              value={from}
              disabled={busy}
              onChange={(e) => setFrom(e.target.value)}
            />
            <input
              className="settings-input"
              aria-label={t.restoreInto}
              placeholder="/path/to/new-workspace-folder"
              value={into}
              disabled={busy}
              onChange={(e) => setInto(e.target.value)}
            />
            <button type="button" disabled={busy || prechecking || !from.trim() || !into.trim()} onClick={() => void runPrecheck()}>
              {t.checkRestore}
            </button>
            <button
              type="button"
              disabled={busy || !prechecked}
              onClick={() =>
                void send({ path: "/workspace/restores", body: { requestId: requestId(), from, to: into } })
              }
            >
              {t.restore}
            </button>
          </div>
          {prechecked && precheck && (
            <div className="workspace-backup-precheck" role="status">
              <p>
                {t.canRestore(
                  precheck.result.target,
                  precheck.result.agents,
                  precheck.result.files,
                  bytes(precheck.result.bytes),
                  new Date(precheck.result.createdAt).toLocaleString(),
                )}
              </p>
              {precheck.result.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {view?.schedule && (
        <DailyBackup
          schedule={view.schedule}
          canChange={canChange}
          onSaved={(schedule) => setView((old) => (old ? { ...old, schedule } : old))}
        />
      )}

      {lost && pending && (
        <div className="workspace-backup-refusal" role="alert">
          <p>{t.lost}</p>
          <button type="button" onClick={() => void send(pending)}>
            {t.tryAgain}
          </button>
        </div>
      )}
      {error && (
        <p className="workspace-backup-error" role="alert">
          {error}
        </p>
      )}

      {/* Keyed by operation: the next one starts with its own Stop. */}
      {watched && <OperationView key={watched.id} op={watched} canStop={canChange && running} />}

      {canChange && (
        <BackupRetention
          defaultFolder={view?.schedule?.folder ?? null}
          busy={busy}
          onCheck={(path) => void send({ path: "/workspace/backups/check", body: { requestId: requestId(), path } })}
          onRemove={(target) =>
            void send({ path: "/workspace/backup/retention/remove", body: { requestId: requestId(), ...target } })
          }
        />
      )}

      {view && view.recent.filter((op) => op.id !== watched?.id).length > 0 && (
        <div className="workspace-backup-recent">
          <h4>{t.recent}</h4>
          <ul>
            {view.recent
              .filter((op) => op.id !== watched?.id)
              .map((op) => (
                <li key={op.id} data-state={op.state}>
                  {kindName(op, t)} · {stateName(op.state, t)}
                  {op.finishedAt ? ` · ${new Date(op.finishedAt).toLocaleString()}` : ""}
                  {op.request.to || op.request.path ? ` · ${op.request.to || op.request.path}` : ""}
                  {op.kind === "remove" && op.request.name ? ` · ${op.request.name}` : ""}
                </li>
              ))}
          </ul>
        </div>
      )}
      {view && <p className="settings-row-help workspace-backup-limit">{t.limit(view.replaceRunningWorkspace)}</p>}
    </section>
  );
}

/** "03:00" UTC as this device's clock shows it today. */
function localTime(timeUtc: string) {
  const [hours, minutes] = timeUtc.split(":").map(Number);
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes))
    .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function lastRunText(run: NonNullable<Schedule["lastRun"]>, t: Words) {
  const made = run.missed > 0 ? t.made(run.missed) : "";
  switch (run.state) {
    case "running":
      return t.runRunning(utc(run.slot), run.to, made);
    case "succeeded":
      return t.runSucceeded(utc(run.slot), run.to, made);
    case "not_started":
      return t.runNotStarted(utc(run.slot), run.error ?? t.noReason, made);
    default:
      return t.runEnded(utc(run.slot), t.ended[run.state] ?? run.state, run.error ?? t.noReason, made);
  }
}

/** What an automatic removal pass removed, by the sizes manifests declared. */
function passText(pass: Pass, t: Words) {
  const n = pass.removed.length;
  const removed = n
    ? t.removed(n, pass.removed.map((r) => r.name).join(", "), pass.removedEstimateBytes ? bytes(pass.removedEstimateBytes) : null, pass.keptCheckedName ?? null)
    : t.nothingRemoved;
  const skipped = pass.skipped.length ? t.notRemoved(pass.skipped) : "";
  const left = pass.left > 0 ? t.left(pass.left) : "";
  return removed + skipped + left;
}

/** What automatic removal did after the last run: said apart from its backup. */
function cleanupText(cleanup: Cleanup, t: Words) {
  switch (cleanup.state) {
    case "due":
      return t.cleanupDue;
    case "running":
      return t.cleanupRunning;
    case "succeeded":
      return t.cleanupDone(cleanup.result ? passText(cleanup.result, t) : null);
    case "not_run":
      return t.cleanupNotRun(cleanup.reason ?? t.noReason);
    default:
      return t.cleanupEnded(cleanup.state, cleanup.error ?? t.noReason);
  }
}

/** The daily backup in Settings (T-196): off until turned on here. Its time
 * is UTC, shown with this device's equivalent. A run starting is not shown
 * as a success; its outcome is, once the backup ends. Nothing is deleted. */
function DailyBackup({ schedule, canChange, onSaved }: {
  schedule: Schedule;
  canChange: boolean;
  onSaved: (schedule: Schedule) => void;
}) {
  const t = text(useLanguage());
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [time, setTime] = useState(schedule.timeUtc || "03:00");
  const [folder, setFolder] = useState(schedule.folder ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const changed = enabled !== schedule.enabled || time !== (schedule.timeUtc || "03:00") || folder !== (schedule.folder ?? "");
  async function save() {
    setSaving(true);
    setError("");
    try {
      const answer = await api<{ schedule: Schedule }>("/workspace/backup/schedule", {
        method: "POST",
        body: JSON.stringify({ enabled, timeUtc: time, folder: folder.trim() || null }),
      });
      onSaved(answer.schedule);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  const run = schedule.lastRun;
  return (
    <div className="settings-group workspace-backup-daily" aria-label={t.daily}>
      <div className="settings-row workspace-backup-row">
        <span className="settings-row-main">
          <span className="settings-row-title">{t.daily}</span>
          <span className="settings-row-help">
            {schedule.enabled
              ? t.dailyOn(schedule.timeUtc, localTime(schedule.timeUtc), String(schedule.folder), !!schedule.retention)
              : t.dailyOff}
          </span>
        </span>
      </div>
      {canChange && (
        <div className="settings-row workspace-backup-row">
          <label className="workspace-backup-check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t.everyDay}
          </label>
          <input
            className="settings-input workspace-backup-time"
            type="time"
            aria-label={t.timeOfDay}
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
          <input
            className="settings-input"
            aria-label={t.dailyFolder}
            placeholder="/path/to/backups-folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          />
          <button type="button" disabled={saving || !changed} onClick={() => void save()}>
            {t.save}
          </button>
        </div>
      )}
      {canChange && /^\d\d:\d\d$/.test(time) && (
        <p className="settings-row-help workspace-backup-note">
          {t.timeHere(time, localTime(time))}
        </p>
      )}
      {schedule.enabled && schedule.nextRunAt && (
        <p className="workspace-backup-note" role="status">
          {t.nextRun(utc(schedule.nextRunAt))}
        </p>
      )}
      {run && (
        <p className={run.state === "succeeded" || run.state === "running" ? "workspace-backup-note" : "workspace-backup-error"}>
          {lastRunText(run, t)}
        </p>
      )}
      {run?.cleanup && (
        <p
          className={["failed", "stopped", "interrupted"].includes(run.cleanup.state) ? "workspace-backup-error" : "workspace-backup-note"}
          data-cleanup={run.cleanup.state}
        >
          {cleanupText(run.cleanup, t)}
        </p>
      )}
      {schedule.retention !== undefined && <AutoRemoval schedule={schedule} canChange={canChange} onSaved={onSaved} />}
      {error && (
        <p className="workspace-backup-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The preview Core gives for the schedule's folder (retention.rs), as much of it as this needs. */
type RemovalPreview = {
  folder: string;
  keep: number;
  entries: { name: string; verdict: "keep" | "remove" | "protected" | "unknown" | "ignored"; reason: string }[];
  unreadableNames: number;
  removableEstimateBytes: number;
  removableUnknownSizes: number;
  sizeBasis: string;
  budget?: { bytes: number; state: "met" | "over" | "unknown"; reason: string };
};
const GIB = 1024 ** 3;

/** Automatic removal of old daily backups (T-196, slice 6): off until turned
 * on here, for the schedule's folder, after a preview of what it would
 * remove now. Turning it on removes nothing; after each daily backup that
 * succeeds Core removes what such a preview offers then, as Remove… does. */
function AutoRemoval({ schedule, canChange, onSaved }: {
  schedule: Schedule;
  canChange: boolean;
  onSaved: (schedule: Schedule) => void;
}) {
  const t = text(useLanguage());
  const on = schedule.retention ?? null;
  const [keep, setKeep] = useState(String(on?.keep ?? 7));
  const [budget, setBudget] = useState(on?.budgetBytes ? String(Math.round((on.budgetBytes / GIB) * 100) / 100) : "");
  const [preview, setPreview] = useState<RemovalPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const count = Number(keep);
  const gib = Number(budget);
  const budgetBytes = budget.trim() === "" ? undefined : Math.max(1, Math.round(gib * GIB));
  const valid =
    Number.isInteger(count) && count >= 1 && count <= 100 && (budget.trim() === "" || (Number.isFinite(gib) && gib > 0 && gib <= 1024 * 1024));
  const folder = schedule.folder;
  // Confirmed only as previewed: these settings, for the schedule's folder as it is now.
  const previewed =
    !!preview && !!folder && preview.folder === folder && preview.keep === count && (preview.budget?.bytes ?? undefined) === budgetBytes;
  const same = !!on && on.keep === count && (on.budgetBytes ?? undefined) === budgetBytes && on.folder === folder;

  async function call<T>(path: string, body: object) {
    setBusy(true);
    setError("");
    try {
      return await api<T>(path, { method: "POST", body: JSON.stringify(body) });
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function runPreview() {
    setPreview(null);
    const answer = await call<RemovalPreview>("/workspace/backup/retention/preview", {
      folder,
      keep: count,
      ...(budgetBytes === undefined ? {} : { budgetBytes }),
    });
    if (answer) setPreview(answer);
  }
  async function turnOn() {
    if (!preview) return;
    const answer = await call<{ schedule: Schedule }>("/workspace/backup/schedule/retention", {
      enabled: true,
      keep: preview.keep,
      ...(preview.budget ? { budgetBytes: preview.budget.bytes } : {}),
      folder: preview.folder,
    });
    if (answer) {
      setPreview(null);
      onSaved(answer.schedule);
    }
  }
  async function turnOff() {
    const answer = await call<{ schedule: Schedule }>("/workspace/backup/schedule/retention", { enabled: false });
    if (answer) {
      setPreview(null);
      onSaved(answer.schedule);
    }
  }

  const removable = preview?.entries.filter((e) => e.verdict === "remove") ?? [];
  const kept = preview?.entries.filter((e) => e.verdict === "keep").length ?? 0;
  const held = preview?.entries.filter((e) => e.verdict === "protected" || e.verdict === "unknown").length ?? 0;
  return (
    <div className="settings-group workspace-backup-auto-removal" aria-label={t.autoRemoval}>
      <div className="settings-row workspace-backup-row">
        <span className="settings-row-main">
          <span className="settings-row-title">{t.autoRemoval}</span>
          <span className="settings-row-help" data-auto-removal={on ? "on" : "off"}>
            {on ? t.autoOn(utc(on.confirmedAt), on.keep, on.budgetBytes ? bytes(on.budgetBytes) : null, on.folder) : t.autoOff}
            {t.autoRules}
          </span>
        </span>
      </div>
      {schedule.retentionNote && (
        <p className="workspace-backup-error" role="status">
          {t.note(schedule.retentionNote)}
        </p>
      )}
      {canChange && !folder && <p className="settings-row-help">{t.folderFirst}</p>}
      {canChange && folder && (
        <div className="settings-row workspace-backup-row">
          <input
            className="settings-input backup-retention-keep"
            type="number"
            min={1}
            max={100}
            aria-label={t.autoKeep}
            value={keep}
            onChange={(e) => {
              setKeep(e.target.value);
              setPreview(null);
            }}
          />
          <input
            className="settings-input backup-retention-keep"
            type="number"
            min={0}
            step="any"
            aria-label={t.autoBudget}
            placeholder={t.noBudget}
            value={budget}
            onChange={(e) => {
              setBudget(e.target.value);
              setPreview(null);
            }}
          />
          <button type="button" disabled={!valid || busy} onClick={() => void runPreview()}>
            {t.preview}
          </button>
          {on && (
            <button type="button" disabled={busy} onClick={() => void turnOff()}>
              {t.turnOff}
            </button>
          )}
        </div>
      )}
      {preview && (
        <div className="backup-retention-result" role="region" aria-label={t.autoPreview}>
          <p role="status">
            {t.autoSummary({
              folder: preview.folder,
              keep: preview.keep,
              within: preview.budget ? bytes(preview.budget.bytes) : null,
              kept,
              removable: removable.length,
              about: bytes(preview.removableEstimateBytes),
              held,
              unreadable: preview.unreadableNames > 0,
            })}
          </p>
          {preview.budget && (
            <p className={preview.budget.state === "met" ? "workspace-backup-note" : "workspace-backup-error"}>{t.note(preview.budget.reason)}</p>
          )}
          {removable.length > 0 && (
            <ul aria-label={t.wouldRemove}>
              {removable.map((e) => (
                <li key={e.name}>
                  <code>{e.name}</code> · {e.reason}
                </li>
              ))}
            </ul>
          )}
          <p className="settings-row-help">{t.autoAfter(preview.sizeBasis)}</p>
          {previewed && !same && (
            <button type="button" disabled={busy} onClick={() => void turnOn()}>
              {on ? t.saveSettings : t.turnOn}
            </button>
          )}
          {previewed && same && <p className="settings-row-help">{t.sameSettings}</p>}
        </div>
      )}
      {error && (
        <p className="workspace-backup-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function OperationView({ op, canStop }: { op: Operation; canStop: boolean }) {
  const t = text(useLanguage());
  const [stopping, setStopping] = useState(false);
  // Why Stop didn't happen: no answer (worded when shown), or Core's own words.
  const [stopError, setStopError] = useState<{ lost: true } | { error: string } | null>(null);
  const [said, setSaid] = useState(0);
  const stopLine = useRef<HTMLParagraphElement>(null);
  // On a phone's screen the line saying why Stop did not happen can be below
  // the button that was pressed: it is brought into view each time.
  useEffect(() => {
    if (said) stopLine.current?.scrollIntoView?.({ block: "nearest" });
  }, [said]);
  const kind = kindName(op, t);
  const label = t.opLabel(kind, stateName(op.state, t));
  return (
    <div className="workspace-backup-operation" data-state={op.state} aria-label={label}>
      <p className="workspace-backup-operation-title" role="status">
        {op.state === "running"
          ? t.opRunning(kind, stepName(op.step, t))
          : op.state === "succeeded"
            ? t.opDone(kind)
            : op.state === "stopped"
              ? // A removal writes nothing to keep: what it had removed is in its error below.
                t.opStopped(kind, op.kind !== "remove")
              : op.state === "interrupted"
                ? t.opInterrupted(kind, op.kind !== "remove")
                : t.opFailed(kind, stepName(op.step, t))}
      </p>
      {canStop && (
        <button
          type="button"
          disabled={stopping}
          onClick={async () => {
            setStopping(true);
            setStopError(null);
            try {
              await api(`/workspace/backup/operations/${op.id}/stop`, { method: "POST", body: "{}" });
            } catch (e) {
              setStopping(false);
              // Stopping a running operation twice is harmless, so Stop asks again as is.
              setStopError(e instanceof NetworkError ? { lost: true } : { error: errorText(e) });
              setSaid((n) => n + 1);
            }
          }}
        >
          {stopping ? t.stopping : t.stop}
        </button>
      )}
      {stopError && (
        <p className="workspace-backup-error" role="alert" ref={stopLine}>
          {"lost" in stopError ? t.stopLost : stopError.error}
        </p>
      )}
      {op.error && op.state !== "running" && <p className="workspace-backup-error">{op.error}</p>}
      {op.state === "succeeded" && op.result && <Result op={op} />}
    </div>
  );
}

function Result({ op }: { op: Operation }) {
  const t = text(useLanguage());
  const result = op.result!;
  if (op.kind === "remove") {
    // An automatic removal lists what it removed (T-196, slice 6).
    if (Array.isArray(result.removed)) {
      return (
        <div className="workspace-backup-result">
          <p>{passText(result as unknown as Pass, t)}</p>
        </div>
      );
    }
    return (
      <div className="workspace-backup-result">
        <p>
          {t.removedBefore}
          <code>{result.removed}</code>
          {t.removedMiddle(result.freedEstimateBytes ? bytes(result.freedEstimateBytes) : null)}
          <code>{result.keptChecked}</code>
          {t.removedAfter}
        </p>
      </div>
    );
  }
  if (op.kind === "restore") {
    return (
      <div className="workspace-backup-result">
        <p>
          {t.restoredBefore}
          <code>{result.restoredTo}</code>
          {t.restoredAfter(result.agents, result.files)}
        </p>
        {result.nextSteps && (
          <ol aria-label={t.nextSteps}>
            {result.nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
        {result.notes?.map((note) => (
          <p key={note} className="settings-row-help">
            {note}
          </p>
        ))}
      </div>
    );
  }
  return (
    <div className="workspace-backup-result">
      <p>
        {op.kind === "backup" ? t.backedUpTo : t.checked}
        <code>{result.path}</code>
        {t.summaryAfter(result.agents, result.files, bytes(result.bytes))}
      </p>
      <details>
        <summary>{t.leftOut(result.excluded.length)}</summary>
        <ul>
          {result.excluded.map((item) => (
            <li key={item.path}>
              <code>{item.path}</code>: {item.reason}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
