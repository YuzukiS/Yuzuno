/** Settings' pages (YN-8 S1): one sidebar of pages in four groups. A group
 * says whose setting it is (this device, the Workspace, its data, about
 * Yuzuno), so a page needs no scope disclosure of its own. Each page shows
 * the existing editors listed for it, as they are; navigation only. */
import type { Language } from "./i18n.ts";
import type { SettingEntry, SettingsDestination, SettingsEditor } from "./settings-catalog.ts";

export type SettingsGroup = "device" | "workspace" | "data" | "about";
export type SettingsPage =
  | "appearance" | "typing" | "language" | "shortcuts" | "notifications" | "transfer"
  | "projects" | "machines" | "agents" | "executors" | "home" | "phone"
  | "storage" | "backup" | "diagnostics"
  | "updates" | "runtime" | "about";
/** An editor of a page; `projects` and `machines` are the Project and
 * Machines managers, mounted in their pages. */
export type PageEditor = SettingsEditor | "projects" | "machines";

type Words = { en: string; zh: string };
export const settingsGroups: readonly { id: SettingsGroup; label: Words }[] = [
  { id: "device", label: { en: "This device", zh: "这台设备" } },
  { id: "workspace", label: { en: "Workspace", zh: "工作区" } },
  { id: "data", label: { en: "Data", zh: "数据" } },
  { id: "about", label: { en: "About", zh: "关于" } },
];
export const settingsPages: readonly { id: SettingsPage; group: SettingsGroup; label: Words; editors: readonly PageEditor[] }[] = [
  { id: "appearance", group: "device", label: { en: "Appearance", zh: "外观" }, editors: ["appearance"] },
  { id: "typing", group: "device", label: { en: "Typing & time", zh: "输入与时间" }, editors: ["input", "time"] },
  { id: "language", group: "device", label: { en: "Language", zh: "语言" }, editors: ["language"] },
  { id: "shortcuts", group: "device", label: { en: "Shortcuts", zh: "快捷键" }, editors: ["shortcuts"] },
  { id: "notifications", group: "device", label: { en: "Notifications", zh: "通知" }, editors: ["notifications"] },
  { id: "transfer", group: "device", label: { en: "Move to another device", zh: "迁移到其他设备" }, editors: ["transfer"] },
  { id: "projects", group: "workspace", label: { en: "Projects", zh: "项目" }, editors: ["projects"] },
  // Each machine's page has its Job settings (S3): the Core host's budget on its own page.
  { id: "machines", group: "workspace", label: { en: "Machines", zh: "机器" }, editors: ["machines"] },
  { id: "agents", group: "workspace", label: { en: "Agent defaults", zh: "Agent 默认" }, editors: ["agent-defaults", "auto-continue", "review"] },
  { id: "executors", group: "workspace", label: { en: "Executors", zh: "执行者" }, editors: ["executor-templates"] },
  { id: "home", group: "workspace", label: { en: "Home", zh: "主页" }, editors: ["home"] },
  { id: "phone", group: "workspace", label: { en: "Phone access", zh: "手机访问" }, editors: ["remote"] },
  { id: "storage", group: "data", label: { en: "Storage", zh: "存储" }, editors: ["storage", "drafts", "history"] },
  { id: "backup", group: "data", label: { en: "Backup & restore", zh: "备份与恢复" }, editors: ["backup"] },
  { id: "diagnostics", group: "data", label: { en: "Diagnostics", zh: "诊断" }, editors: ["diagnostics"] },
  { id: "updates", group: "about", label: { en: "Updates", zh: "更新" }, editors: ["updates"] },
  { id: "runtime", group: "about", label: { en: "Runtime", zh: "运行环境" }, editors: ["runtime"] },
  { id: "about", group: "about", label: { en: "About & help", zh: "关于与帮助" }, editors: ["about"] },
];

/** Editors older callers still name that are now part of a page: the Job
 * budgets are each machine's (YN-8 S3), the Core host's on its own page. */
export const legacyEditors: Partial<Record<SettingsEditor, { page: SettingsPage; sub?: string; block?: string }>> = {
  "jobs-budget": { page: "machines", sub: "local", block: "jobs" },
  "jobs-remote": { page: "machines" },
};
/** The page an editor is on. */
export function pageOfEditor(editor: PageEditor): SettingsPage {
  const legacy = legacyEditors[editor as SettingsEditor];
  return legacy ? legacy.page : settingsPages.find((page) => page.editors.includes(editor))!.id;
}
/** A catalog entry's page, or null for one edited elsewhere (an Agent's own
 * settings, accounts): search lists those under Elsewhere. */
export function pageOfEntry(entry: SettingEntry): SettingsPage | null {
  const target = entry.target;
  if (target.kind === "editor") return pageOfEditor(target.editor);
  if (target.kind === "project") return "projects";
  if (target.kind === "machines") return "machines";
  return null;
}
export function pageLabel(page: SettingsPage, language: Language): string {
  const words = settingsPages.find((item) => item.id === page)!.label;
  return language === "zh-Hans" ? words.zh : words.en;
}
export function groupLabel(group: SettingsGroup, language: Language): string {
  const words = settingsGroups.find((item) => item.id === group)!.label;
  return language === "zh-Hans" ? words.zh : words.en;
}

/** Where Settings opens: a page, and within it a project or machine (`sub`:
 * a project or machine id, or "new"), or the editor an older caller names. */
export type SettingsOpenTarget = { page: SettingsPage; sub?: string; editor?: PageEditor };
/** A destination that is now a page of Settings, or null for one that still
 * leaves it (an Agent's own settings, a task's Workspaces). */
export function destinationPage(destination: SettingsDestination): SettingsOpenTarget | null {
  if (destination.kind === "project") return { page: "projects", sub: destination.projectId };
  if (destination.kind === "machines") return { page: "machines" };
  return null;
}
