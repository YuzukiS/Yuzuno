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
import { strings, useLanguage } from "./i18n";
import "./storage-overview.css";

type UpdatesStorage = { managed: boolean; storage: { releaseBytes: number; backupBytes: number; retainedReleases: number; keepReleases: number } };
/** A Task as Core's task list gives it: only what choosing it needs. */
type TaskChoice = { id: string; title: string; status: string };
/** `complete` is false when the pages read stopped before Core's last one. */
type TaskChoices = { tasks: TaskChoice[]; complete: boolean };
type TaskPage = { tasks?: TaskChoice[]; hasMore?: boolean; nextAfterSeq?: number };
const TASK_PAGE = 200;
const TASK_PAGES = 10;

/**
 * The Workspace's unarchived tasks, every status, as the task board pages
 * them: Core lists them oldest first, so every page up to TASK_PAGES is read
 * and the newest is shown first.
 */
async function readTaskChoices(signal: AbortSignal): Promise<TaskChoices> {
  const tasks: TaskChoice[] = [];
  let after = 0;
  for (let read = 0; read < TASK_PAGES; read++) {
    const page = await api<TaskPage>("/collaboration/task_list", {
      method: "POST", body: JSON.stringify({ limit: TASK_PAGE, ...(after ? { afterSeq: after } : {}) }), signal,
    });
    tasks.push(...(Array.isArray(page?.tasks) ? page.tasks : []).filter((task) => typeof task?.id === "string" && !!task.id));
    const next = page?.nextAfterSeq;
    if (page?.hasMore !== true) return { tasks: tasks.reverse(), complete: true };
    if (typeof next !== "number" || next <= after) break;
    after = next;
  }
  return { tasks: tasks.reverse(), complete: false };
}

function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// Data & storage in the interface language (T-189). What Core reports (a
// reason, a path, an item it lists, a name it doesn't know) and what this
// browser says of an error are shown as they come; sizes keep their units.
const deviceGroupsZh: Record<string, [string, string]> = {
  unsent: ["尚未被 Core 接受的消息", "在 Core 收到之前，会从此浏览器再次发送。"],
  drafts: ["草稿", "输入框草稿和粘贴内容，以及尚未发送的 Home 回复、回答和表单。"],
  pending: ["等待回答的请求", "保存下来，以便再次询问时仍是同一个请求。"],
  preferences: ["此设备的偏好", "外观、发送方式、面板宽度和 Home 布局。"],
  reading: ["阅读位置与视图", "随着你使用 Yuzuno 会重新生成。"],
  records: ["诊断与用量记录", "为“复制诊断信息”保留的最近错误和读取，以及 Claude 最近一次的用量报告。"],
  other: ["其他 Yuzuno 数据", "由另一个版本的 Yuzuno 在这个地址保存。"],
  foreign: ["不是 Yuzuno 保存的", "由这个地址上的其他内容保存。"],
};
const entryLabelsZh: Record<string, string> = {
  database: "Workspace 数据库",
  databaseLog: "数据库预写日志",
  databaseIndex: "数据库日志索引",
  databaseJournal: "数据库回滚日志",
  lock: "Workspace 锁",
  inputImages: "发送给 Agent 的图片",
  briefAttachments: "Brief 附件",
  reviews: "代码审查源",
  jobs: "Job 记录与输出日志",
  claudeRuntime: "Claude 运行环境缓存",
  opencode: "OpenCode 会话数据库",
  desktopDownloads: "桌面应用下载",
  backupOperations: "备份与恢复记录",
  backupSchedule: "每日备份计划",
  earlierDatabaseCopy: "早期数据库副本，保留自一次性转换",
  unknown: "不是此 Core 生成的",
};
const text = strings({
  title: "Data & storage",
  intro: "Where this Workspace's data is kept, who keeps it and what is known of its size. This page only reads: nothing here deletes or changes anything.",
  device: "On this device, for this site",
  deviceNote: "Kept only in this browser at this address. It is not in a Workspace backup, and clearing this site's data in the browser removes it.",
  deviceReason: (reason: string) => reason,
  group: (id: string): [string, string] => {
    const about = deviceGroups.find((item) => item.id === id);
    return about ? [about.label, about.note] : [id, ""];
  },
  about: (size: string) => `about ${size}`,
  entries: (count: number) => `${count} ${count === 1 ? "entry" : "entries"}`,
  drafts: (agents: number, unreadable: number, unsent: number) =>
    `${agents} ${agents === 1 ? "Agent has" : "Agents have"} a saved draft${
      unreadable > 0
        ? `; ${unreadable} saved ${unreadable === 1 ? "draft could" : "drafts could"} not be read and ${unreadable === 1 ? "is" : "are"} left as ${unreadable === 1 ? "it is" : "they are"}`
        : ""
    }. ${unsent} ${unsent === 1 ? "message is" : "messages are"} waiting for Core to accept ${unsent === 1 ? "it" : "them"}. Sizes are estimates: the text as this browser keeps it.`,
  asking: "Asking this browser for its own figures…",
  noEstimate: "This browser does not report how much it keeps for this site.",
  estimate: (used: string, quota: string) => `This browser's own estimate for this site: ${used} used of ${quota} it allows.`,
  core: "In the Workspace, on the Core host",
  couldNotRead: (error: string) => `Could not read the Workspace's storage: ${error}`,
  tryAgain: "Try again",
  reading: "Reading…",
  where: (date: string): [string, string] => ["In ", ` on the computer that runs Core · read ${date}. A folder's size is not measured here.`],
  partUnreadable: (reason: string) => `Part of this folder could not be read: ${reason}`,
  freeSpace: (size: string) => `Free space inside the database file: ${size}, reused by later writes.`,
  jobs: (total: number, unfinished: number | null | undefined) =>
    `${total} Job ${total === 1 ? "record" : "records"}${unfinished ? `, ${unfinished} not finished` : ""}. Each Job's folder of records and output is kept; what a Job writes in its own working folder is not in this list.`,
  updates: "Update releases and recovery copies",
  notRead: "Not read yet: Settings reads it with the update status.",
  releases: (releases: string, kept: number, upTo: number, copies: string) =>
    `Releases: ${releases} (${kept} kept, up to ${upTo}). Database copies made before updates: ${copies}. They are in the managed install, beside the Workspace, and let an update be undone.`,
  notManaged: "This Core is not a managed install, so Yuzuno keeps no releases or update copies for it.",
  native: "Native session histories",
  noNative: "No Agent has a native session yet.",
  coreHost: "the Core host",
  sizeUnknown: "size unknown",
  agents: (count: number, closed: number) => `${count} ${count === 1 ? "Agent" : "Agents"}${closed ? ` (${closed} closed)` : ""}`,
  opencodeKept: "Kept in this Workspace's folder (OpenCode session databases above); not in a backup.",
  keptBy: (name: string) => `Kept by ${name} in its own folder on that computer. Yuzuno does not measure, back up or remove it.`,
  never: "Never in a Workspace backup",
  footer: "What each held Agent's stored history takes inside the database is in History & memory information. To report a problem, Copy diagnostics shows its text before anything is copied.",
  taskFolders: "Build output in task work folders",
  taskFoldersNote:
    "Cargo's build output in a task's registered work folders can be removed from that task's Workspace section. It lists each folder, previews what would go and removes only what you then choose: regenerable Cargo build output, never source files, the folder or its branch. Whether it can run there, and why not, is what Core reports in that section. Choosing a task here only opens it: nothing is previewed or removed. Archived tasks are not listed.",
  taskFoldersElsewhere: "Open a task's Workspace section from Tasks to remove its build output.",
  readingTasks: "Reading this Workspace's tasks…",
  tasksNotRead: (reason: string) => `The tasks could not be read: ${reason}`,
  noTasks: "This Workspace has no tasks.",
  task: "Task",
  chooseTask: "Choose a task…",
  openFolders: "Open its Workspace section",
  moreTasks: (count: number) => `Only the ${count} oldest tasks are listed; open a later one from Tasks.`,
  entryLabel: (what: string) => entryLabels[what] ?? what,
  onDisk: (size: string, disk: string) => `${size} · ${disk} on disk`,
  link: "a link: not followed",
  unreadable: "could not be read",
  notFile: "not a file or folder",
  copiedFolder: "A Workspace backup copies files from here; its manifest lists which",
  copiedFile: "In a Workspace backup, as a consistent copy",
  excluded: (reason: string) => `Not in a backup: ${reason}`,
  notInBackup: "Not in a backup",
}, {
  title: "数据与存储",
  intro: "这个 Workspace 的数据存放在哪里、由谁保存，以及已知的大小。此页面只读取：这里不会删除或更改任何内容。",
  device: "在此设备上，此站点",
  deviceNote: "只保存在此浏览器的这个地址下。它不在 Workspace 备份中，在浏览器中清除此站点的数据会删除它。",
  deviceReason: (reason) => {
    if (reason === "This browser gives Yuzuno no storage here.") return "此浏览器不给 Yuzuno 在这里存储。";
    const refused = /^This browser refused to read its storage \((.*)\)\.$/.exec(reason);
    return refused ? `此浏览器拒绝读取它的存储（${refused[1]}）。` : reason;
  },
  group: (id) => deviceGroupsZh[id] ?? [id, ""],
  about: (size) => `约 ${size}`,
  entries: (count) => `${count} 项`,
  drafts: (agents, unreadable, unsent) =>
    `${agents} 个 Agent 有已保存的草稿${unreadable > 0 ? `；${unreadable} 份已保存的草稿无法读取，保持原样` : ""}。${unsent} 条消息正在等待 Core 接受。大小是估计值：按此浏览器保存的文本计算。`,
  asking: "正在向此浏览器询问它自己的数据…",
  noEstimate: "此浏览器没有报告它为此站点保存了多少数据。",
  estimate: (used, quota) => `此浏览器对此站点的估计：已用 ${used}，允许 ${quota}。`,
  core: "在 Workspace 中，位于 Core 主机上",
  couldNotRead: (error) => `无法读取 Workspace 的存储：${error}`,
  tryAgain: "重试",
  reading: "正在读取…",
  where: (date) => ["位于运行 Core 的电脑上的 ", ` · 读取于 ${date}。这里不测量文件夹的大小。`],
  partUnreadable: (reason) => `此文件夹的一部分无法读取：${reason}`,
  freeSpace: (size) => `数据库文件内的空闲空间：${size}，之后写入时会重复使用。`,
  jobs: (total, unfinished) =>
    `${total} 条 Job 记录${unfinished ? `，${unfinished} 条未完成` : ""}。每个 Job 的记录与输出文件夹都会保留；Job 在它自己的工作文件夹中写入的内容不在此列表中。`,
  updates: "更新版本与恢复副本",
  notRead: "尚未读取：设置会在读取更新状态时一并读取。",
  releases: (releases, kept, upTo, copies) =>
    `发布版本：${releases}（保留 ${kept} 个，最多 ${upTo} 个）。更新前制作的数据库副本：${copies}。它们在托管安装中，与 Workspace 并列，可用于撤销更新。`,
  notManaged: "此 Core 不是托管安装，因此 Yuzuno 不为它保留发布版本或更新副本。",
  native: "原生会话历史",
  noNative: "还没有 Agent 有原生会话。",
  coreHost: "Core 主机",
  sizeUnknown: "大小未知",
  agents: (count, closed) => `${count} 个 Agent${closed ? `（${closed} 个已关闭）` : ""}`,
  opencodeKept: "保存在这个 Workspace 的文件夹中（上面的 OpenCode 会话数据库）；不在备份中。",
  keptBy: (name) => `由 ${name} 保存在那台电脑上它自己的文件夹中。Yuzuno 不会测量、备份或删除它。`,
  never: "从不在 Workspace 备份中的内容",
  footer: "每个保留的 Agent 的历史在数据库中占用多少，见“历史与内存信息”。要报告问题，“复制诊断信息”会先显示文本，再复制任何内容。",
  taskFolders: "任务工作目录中的构建输出",
  taskFoldersNote:
    "任务已登记工作目录中由 Cargo 生成的构建输出，可以在该任务的 Workspace 部分移除。那里列出每个目录，先预览将移除的内容，然后只移除你选中的部分：可再生成的 Cargo 构建输出，从不包括源代码、目录本身或其分支。能否在那里执行以及原因，以 Core 在那部分报告的为准。在这里选择任务只会打开它：不会预览或移除任何内容。已归档的任务不在此列出。",
  taskFoldersElsewhere: "从“任务”打开任务的 Workspace 部分，即可移除它的构建输出。",
  readingTasks: "正在读取此 Workspace 的任务…",
  tasksNotRead: (reason) => `无法读取任务：${reason}`,
  noTasks: "此 Workspace 没有任务。",
  task: "任务",
  chooseTask: "选择任务…",
  openFolders: "打开它的 Workspace 部分",
  moreTasks: (count) => `只列出最早的 ${count} 个任务；更晚的任务请从“任务”打开。`,
  entryLabel: (what) => entryLabelsZh[what] ?? entryLabels[what] ?? what,
  onDisk: (size, disk) => `${size} · 磁盘上 ${disk}`,
  link: "链接：不跟随",
  unreadable: "无法读取",
  notFile: "不是文件或文件夹",
  copiedFolder: "Workspace 备份会从这里复制文件；其清单列出复制了哪些",
  copiedFile: "在 Workspace 备份中，作为一致的副本",
  excluded: (reason) => `不在备份中：${reason}`,
  notInBackup: "不在备份中",
});

function at(iso: string) {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Settings → Data & storage (T-193): where this Workspace's data is kept, who
 * keeps it and what is known of its size. It reads this browser's storage and
 * Core's overview while it is shown; a size that is not known is said to be
 * unknown, never 0. Nothing here deletes or changes anything.
 */
export function StorageOverview({ active, updates, onOpenTaskWorkspaces }: {
  active: boolean;
  updates: UpdatesStorage | null;
  /** Opens that Task's own Workspace section, by its ID (T-193). */
  onOpenTaskWorkspaces?: (taskId: string) => void;
}) {
  const t = text(useLanguage());
  const [taskChoices, setTaskChoices] = useState<TaskChoices | null>(null);
  const [tasksError, setTasksError] = useState("");
  const [chosenTask, setChosenTask] = useState("");
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

  // The Workspace's tasks to choose from (readTaskChoices): reads only.
  useEffect(() => {
    if (!active || !onOpenTaskWorkspaces) return;
    const controller = new AbortController();
    setTasksError("");
    void readTaskChoices(controller.signal)
      .then((choices) => {
        if (controller.signal.aborted) return;
        setTaskChoices(choices);
        setChosenTask((was) => (choices.tasks.some((task) => task.id === was) ? was : ""));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setTasksError(errorText(e));
      });
    return () => controller.abort();
  }, [active, !!onOpenTaskWorkspaces]);

  return (
    <section id="settings-storage" className="settings-section storage-overview" aria-labelledby="settings-storage-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-storage-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
      </header>

      <section className="storage-part" aria-labelledby="storage-device">
        <h4 id="storage-device">{t.device}</h4>
        <p className="storage-note">{t.deviceNote}</p>
        {device && !device.available && <p className="updates-error" role="alert">{t.deviceReason(device.reason ?? "")}</p>}
        {device?.available && (
          <>
            <ul className="storage-rows">
              {device.groups.map((group) => {
                const [label, note] = t.group(group.id);
                return (
                  <li key={group.id} data-group={group.id}>
                    <span className="storage-name">{label}</span>
                    <span className="storage-size">{t.about(sizeText(group.bytes))}</span>
                    <span className="storage-detail">
                      {t.entries(group.keys)} · {note}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="storage-note">{t.drafts(device.draftAgents, device.unreadableDrafts, device.unsentMessages)}</p>
          </>
        )}
        <p className="storage-note" data-estimate>
          {estimate === undefined
            ? t.asking
            : estimate === null
              ? t.noEstimate
              : t.estimate(sizeText(estimate.usage), sizeText(estimate.quota))}
        </p>
      </section>

      <section className="storage-part" aria-labelledby="storage-core">
        <h4 id="storage-core">{t.core}</h4>
        {loadError && (
          <p className="updates-error" role="alert">
            {t.couldNotRead(loadError)}{" "}
            <button type="button" className="inline-link" onClick={() => void refresh()}>
              {t.tryAgain}
            </button>
          </p>
        )}
        {!view && !loadError && <p className="storage-note">{t.reading}</p>}
        {view && (
          <>
            <p className="storage-note">
              {t.where(at(view.readAt))[0]}
              <code>{view.dataDir}</code>
              {t.where(at(view.readAt))[1]}
            </p>
            {view.unreadable && <p className="updates-error">{t.partUnreadable(view.unreadable)}</p>}
            <ul className="storage-rows">
              {view.entries.map((entry) => (
                <EntryRow key={entry.name} entry={entry} t={t} />
              ))}
            </ul>
            {view.database.freePages !== null && view.database.pageSize !== null && (
              <p className="storage-note">{t.freeSpace(sizeText(view.database.freePages * view.database.pageSize))}</p>
            )}
            {view.jobs.total !== null && (
              <p className="storage-note">{t.jobs(view.jobs.total, view.jobs.unfinished)}</p>
            )}
          </>
        )}
      </section>

      <section className="storage-part" aria-labelledby="storage-task-folders">
        <h4 id="storage-task-folders">{t.taskFolders}</h4>
        <p className="storage-note">{t.taskFoldersNote}</p>
        {!onOpenTaskWorkspaces ? (
          <p className="storage-note">{t.taskFoldersElsewhere}</p>
        ) : tasksError ? (
          <p className="updates-error" role="alert">{t.tasksNotRead(tasksError)}</p>
        ) : !taskChoices ? (
          <p className="storage-note">{t.readingTasks}</p>
        ) : taskChoices.tasks.length === 0 ? (
          <p className="storage-note">{t.noTasks}</p>
        ) : (
          <div className="storage-task-open">
            <label>
              <span>{t.task}</span>
              <select className="settings-select" value={chosenTask} onChange={(event) => setChosenTask(event.target.value)}>
                <option value="">{t.chooseTask}</option>
                {taskChoices.tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.id} · {task.title} · {task.status}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={!taskChoices.tasks.some((task) => task.id === chosenTask)}
              onClick={() => onOpenTaskWorkspaces(chosenTask)}
            >
              {t.openFolders}
            </button>
            {!taskChoices.complete && <p className="storage-note">{t.moreTasks(taskChoices.tasks.length)}</p>}
          </div>
        )}
      </section>

      <section className="storage-part" aria-labelledby="storage-updates">
        <h4 id="storage-updates">{t.updates}</h4>
        {!updates ? (
          <p className="storage-note">{t.notRead}</p>
        ) : updates.managed ? (
          <p className="storage-note">
            {t.releases(
              sizeText(updates.storage.releaseBytes),
              updates.storage.retainedReleases,
              updates.storage.keepReleases,
              sizeText(updates.storage.backupBytes),
            )}
          </p>
        ) : (
          <p className="storage-note">{t.notManaged}</p>
        )}
      </section>

      <section className="storage-part" aria-labelledby="storage-native">
        <h4 id="storage-native">{t.native}</h4>
        {view && view.native.length === 0 && <p className="storage-note">{t.noNative}</p>}
        {view && view.native.length > 0 && (
          <ul className="storage-rows">
            {view.native.map((group) => (
              <li key={`${group.harness}:${group.machine ?? ""}`}>
                <span className="storage-name">
                  {harnessNames[group.harness] ?? group.harness} · {group.machine ?? t.coreHost}
                </span>
                <span className="storage-size">{t.sizeUnknown}</span>
                <span className="storage-detail">
                  {t.agents(group.agents, group.closed)} ·{" "}
                  {group.harness === "opencode" ? t.opencodeKept : t.keptBy(harnessNames[group.harness] ?? group.harness)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {view && view.notInBackup.length > 0 && (
        <section className="storage-part" aria-labelledby="storage-not-backed-up">
          <h4 id="storage-not-backed-up">{t.never}</h4>
          <ul className="storage-list">
            {view.notInBackup.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      <p className="storage-note">{t.footer}</p>
    </section>
  );
}

function EntryRow({ entry, t }: { entry: StorageEntry; t: ReturnType<typeof text> }) {
  const size =
    entry.kind === "file" && entry.bytes !== undefined
      ? t.onDisk(sizeText(entry.bytes), sizeText(entry.diskBytes ?? 0))
      : entry.kind === "folder"
        ? t.sizeUnknown
        : entry.kind === "link"
          ? t.link
          : entry.kind === "unreadable"
            ? t.unreadable
            : t.notFile;
  return (
    <li data-entry={entry.name}>
      <span className="storage-name">{t.entryLabel(entry.what)}</span>
      <span className="storage-size">{size}</span>
      <span className="storage-detail">
        <code>{entry.name}</code>
        {" · "}
        {entry.backup === "copied"
          ? entry.kind === "folder"
            ? t.copiedFolder
            : t.copiedFile
          : entry.backup === "excluded"
            ? t.excluded(entry.backupReason ?? "")
            : t.notInBackup}
      </span>
    </li>
  );
}
