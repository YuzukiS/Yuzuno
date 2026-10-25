/** Navigation metadata only. Values and persistence belong to the existing editors. */
import type { Language } from "./i18n.ts";
import { categoriesZh, entriesZh } from "./settings-catalog-zh.ts";

export const settingsCategories = [
  { id: "appearance", label: "Appearance & interaction", description: "How this device displays your Workspace." },
  { id: "notifications", label: "Notifications & attention", description: "Attention inside Yuzuno and notification capabilities." },
  { id: "agents", label: "Agents & runtime", description: "Choose an Agent before changing its runtime settings." },
  { id: "connections", label: "Connections & devices", description: "The client, Workspace service and execution machines have separate roles." },
  { id: "projects", label: "Projects & collaboration", description: "Project configuration and shared Workspace preferences." },
  { id: "jobs", label: "Jobs & resources", description: "Budgets apply to managed Jobs on the selected machine." },
  { id: "data", label: "Data, privacy & recovery", description: "Storage information and recovery capabilities." },
  { id: "updates", label: "Updates & about", description: "Versions and updates for the Workspace service and desktop client, with help, release notes and licenses." },
] as const;
export type SettingsCategory = typeof settingsCategories[number]["id"];
export type SettingsEditor = "appearance" | "updates" | "home" | "review" | "diagnostics" | "history" | "runtime" | "input" | "time" | "language" | "shortcuts" | "notifications" | "backup" | "remote" | "agent-defaults" | "about" | "storage" | "drafts" | "transfer";
export type SettingsDestination =
  | { kind: "agent"; section: "model" | "context" | "auto-continue"; agentId: string }
  | { kind: "project"; projectId: string }
  | { kind: "machines" }
  | { kind: "jobs" };
export type SettingTarget =
  | { kind: "editor"; editor: SettingsEditor }
  | { kind: "agent"; section: "model" | "context" | "auto-continue" }
  | { kind: "project" }
  | { kind: "machines" }
  | { kind: "jobs" }
  | { kind: "unavailable"; reason: string };
export type SettingEntry = {
  id: string;
  category: SettingsCategory;
  title: string;
  keywords: string;
  scope: string;
  source: string;
  effect: string;
  target: SettingTarget;
};
export const settingsCatalog: readonly SettingEntry[] = [
  { id: "appearance", category: "appearance", title: "Theme, text & layout", keywords: "外观 主题 字体 字号 密度 颜色 明暗 分组 dock turn 导出 导入 文件 export import file", scope: "This device · this site", source: "Preferences saved in this browser or WebView; built-in defaults when unset.", effect: "Changes preview immediately. Storage must succeed to keep them after reopening. They can be exported to a file and imported after a preview.", target: { kind: "editor", editor: "appearance" } },
  { id: "send-key", category: "appearance", title: "Sending messages", keywords: "发送 发送键 回车 换行 输入法 enter return send newline composer ctrl cmd", scope: "This device · this site", source: "The choice saved in this browser or WebView; Automatic when unset.", effect: "Applies to the conversation’s composer at once. Storage must succeed to keep it after reopening.", target: { kind: "editor", editor: "input" } },
  { id: "shortcuts", category: "appearance", title: "Keyboard shortcuts", keywords: "快捷键 键盘 帮助 shortcuts keyboard hotkeys keys help", scope: "This device", source: "The shortcuts this version has, listed as they work on this device.", effect: "A list to read. Choosing other keys is not available in this version.", target: { kind: "editor", editor: "shortcuts" } },
  { id: "transfer", category: "appearance", title: "Move preferences to another device", keywords: "导出 导入 迁移 文件 备份 偏好 外观 发送 时间 export import move file transfer preferences appearance send time device", scope: "This device · a file you keep", source: "This device's Appearance, send key and time display, as in effect. Nothing of the Workspace, accounts or permissions.", effect: "Export writes a file. Import shows each group beside yours; each group is applied on its own, only once saved on this device. It doesn't sync devices.", target: { kind: "editor", editor: "transfer" } },
  { id: "appearance-preset", category: "appearance", title: "Shared Appearance preset", keywords: "共享 预设 外观 工作区 其他设备 应用 shared preset appearance workspace devices apply", scope: "This Workspace · applied on this device", source: "One Appearance preset this Workspace's Core keeps, saved from a device when you choose; none until then.", effect: "Saving replaces it only if it hasn't changed since you read it. Applying shows each setting beside yours and saves it on this device. Nothing follows along by itself; it isn't sync.", target: { kind: "editor", editor: "appearance" } },
  { id: "clock", category: "appearance", title: "Clock & time zone", keywords: "时间 时钟 12 24 小时制 上午 下午 时区 time clock 12-hour 24-hour am pm time zone timezone", scope: "This device · this site", source: "The choices saved in this browser or WebView; System and this device’s time zone when unset.", effect: "Rewrites times and their dates in conversations and on Home at once. Stored times and relative times don’t change. Storage must succeed to keep it after reopening.", target: { kind: "editor", editor: "time" } },
  { id: "language", category: "appearance", title: "Language", keywords: "语言 界面 中文 简体 英文 language locale interface chinese english", scope: "This device · this site", source: "The choice saved in this browser or WebView; System, this browser’s language, when unset. English is shown for a language this version doesn’t have.", effect: "Settings’ directory, its search and this device’s pages change at once; other pages stay in English. What people and Agents wrote, code and logs are never translated.", target: { kind: "editor", editor: "language" } },
  { id: "notifications", category: "notifications", title: "Notification preferences", keywords: "通知 注意力 声音 免打扰 静音 系统 权限 推送 测试 预览 needs you unread mute test", scope: "This device · this browser", source: "This device’s choices, saved in this browser; the permission is the browser’s own. Needs you and unread activity always show inside the Workspace.", effect: "Notifies only while Yuzuno is open and you look elsewhere. Muting changes nothing Agents or the Workspace deliver; no push or background notifications.", target: { kind: "editor", editor: "notifications" } },
  { id: "agent-model", category: "agents", title: "Model, reasoning & permissions", keywords: "Agent 模型 推理 权限 approvals sandbox effort runtime", scope: "Selected Agent", source: "This Agent’s saved choices and its harness catalog. Native observations remain separate.", effect: "Model and effort changes apply from the next turn. The editor explains the harness’s permission timing.", target: { kind: "agent", section: "model" } },
  { id: "agent-context", category: "agents", title: "Context window & compaction", keywords: "上下文 窗口 压缩 context token automatic compact", scope: "Selected Codex Agent", source: "Saved overrides, requested application and native observed usage are shown separately.", effect: "Save keeps the choice; Apply requires a safe idle conversation. Unknown native values stay unknown.", target: { kind: "agent", section: "context" } },
  { id: "auto-continue", category: "agents", title: "Continue after Claude’s usage limit resets", keywords: "自动继续 自动恢复 配额 限额 quota resume auto continue", scope: "Selected local Claude Agent · Workspace default", source: "The Agent can choose continue, wait, or use the saved Workspace default.", effect: "When a usage limit stops the Agent, the policy controls whether Yuzuno sends a continuation after reset.", target: { kind: "agent", section: "auto-continue" } },
  { id: "agent-defaults", category: "agents", title: "New Agent defaults", keywords: "默认 新建 新 Agent harness 权限 来源 继承 default new agent permissions codex claude follow config", scope: "This Workspace · Agents created from now on", source: "Saved by Core; unset means Yuzuno’s built-in behaviour. Follow Codex config uses each machine’s own configuration.", effect: "Used when an Agent is created. Existing Agents keep their settings, and a machine still decides at start whether it allows a permission.", target: { kind: "editor", editor: "agent-defaults" } },
  { id: "review", category: "agents", title: "Code review", keywords: "审查 审阅 review harness 默认 模型", scope: "This Workspace", source: "Reviewer harness and model saved by Core, or the built-in reviewer when none is saved.", effect: "Used for new reviews. Running reviews keep their original settings.", target: { kind: "editor", editor: "review" } },
  { id: "credentials", category: "agents", title: "Accounts, credentials & MCP", keywords: "账户 登录 密钥 token 凭证 MCP CLI native", scope: "Execution machine · native harness", source: "Login and credentials belong to the native tools on their execution machine.", effect: "Agent runtime and MCP status are visible in the conversation inspector; both also in Runtime & versions.", target: { kind: "unavailable", reason: "This settings center does not store API keys or edit native login and MCP configuration." } },
  { id: "machines", category: "connections", title: "Execution machines & SSH", keywords: "设备 机器 连接 SSH 主机 默认目录 default folder cwd", scope: "Selected execution machine", source: "Machine registration is saved by Core; SSH keys and host configuration belong to OpenSSH.", effect: "Choose a machine in Machines to edit its connection and new-Agent default folder. Existing Agents do not move.", target: { kind: "machines" } },
  { id: "phone", category: "connections", title: "Phone & remote access", keywords: "手机访问 手机 远程访问 tailscale serve 网络 remote phone", scope: "Workspace service · Tailscale on its Windows PC", source: "The phone entry saved by Core, what Core listens on, and the Tailscale Serve entry, each read and shown separately.", effect: "Opening and Check change nothing. Save and apply changes Core’s phone entry and its own Serve entry only; other Serve entries are left as they are.", target: { kind: "editor", editor: "remote" } },
  { id: "projects", category: "projects", title: "Project directories, repositories & services", keywords: "项目 默认目录 工作目录 仓库 服务 default directory folder cwd repository service", scope: "Selected project · per execution machine", source: "Project settings saved by Core. Default directories are recorded per machine.", effect: "Default directories prefill new Agents only. Registering a service does not start it; archiving does not move files.", target: { kind: "project" } },
  { id: "home", category: "projects", title: "Home presentation", keywords: "Home 首页 主页 展示 偏好 视觉 图表 协作", scope: "This Workspace", source: "The shared Home presentation preference saved by Core.", effect: "Used in later Home and result interactions. This does not change editor access or Agent permissions.", target: { kind: "editor", editor: "home" } },
  { id: "budget", category: "jobs", title: "Core host Job budget", keywords: "预算 资源 CPU RAM 内存 swap GPU 磁盘 并发 本地 budget resource disk", scope: "Core execution machine", source: "Managed Job CPU, memory, swap, disk and GPU limits saved by Core.", effect: "New Job admission uses the budget. Running Jobs retain their reservations; native background tasks are outside it.", target: { kind: "jobs" } },
  { id: "remote-budget", category: "jobs", title: "Remote machine Job budgets", keywords: "预算 远程 机器 SSH 并发 内存 budget remote", scope: "Selected execution machine", source: "The selected machine’s saved Job budget and reported enforcement capabilities.", effect: "Choose a machine before editing. Limits depend on that executor’s capabilities.", target: { kind: "machines" } },
  { id: "storage", category: "data", title: "Data & storage overview", keywords: "存储 数据 占用 空间 位置 草稿 附件 缓存 会话 storage disk space usage size location drafts attachments cache sessions", scope: "This device · Workspace service · native CLIs", source: "This browser’s storage for this site, read here; Core’s data folder, read by Core. Native session histories are counted, not measured.", effect: "Opening it only reads. A folder’s size is not measured here, and nothing is deleted from here.", target: { kind: "editor", editor: "storage" } },
  { id: "diagnostics", category: "data", title: "Copy diagnostics", keywords: "隐私 诊断 脱敏 日志 清除错误 diagnostics privacy clear errors", scope: "This client · Workspace service", source: "A redacted diagnostic report collected on request.", effect: "Copying a report does not upload it automatically. Clearing removes only the errors recorded on this device.", target: { kind: "editor", editor: "diagnostics" } },
  { id: "history", category: "data", title: "History & memory information", keywords: "历史 内存 数据 占用 history storage memory", scope: "Workspace service", source: "Core’s reported history composition and memory information.", effect: "Read-only information; this does not erase conversations or native sessions.", target: { kind: "editor", editor: "history" } },
  { id: "backup", category: "data", title: "Workspace backup & restore", keywords: "备份 恢复 导出 校验 检查 backup restore export verify check", scope: "Workspace service · a folder on its computer", source: "A backup this Core makes: its database, image copies, Brief attachments, finished reviews and Job folders, with a manifest of what is left out. Update recovery's database copy is not this.", effect: "Backs up while Core runs, once no Job is running; restores only into a new or empty folder. Native sessions and CLI accounts are never in a backup.", target: { kind: "editor", editor: "backup" } },
  { id: "drafts", category: "data", title: "Draft storage", keywords: "草稿 导出 保存 文件 draft export file 缓存 设备 origin", scope: "This device · this site", source: "Drafts saved by this browser or WebView, one per Agent ID; the Workspace a draft was written in is not recorded. Pasted texts are kept apart and opened only for the draft you choose.", effect: "Showing and saving a draft as a text file changes nothing; images are named, not saved. Drafts stay on this device: there is no cross-device sync.", target: { kind: "editor", editor: "drafts" } },
  { id: "updates", category: "updates", title: "Versions & updates", keywords: "更新 版本 关于 Core 客户端 桌面 client version about release", scope: "Workspace service · desktop client", source: "Installed Core and client versions, and available signed releases.", effect: "Checking installs nothing. Service updates and desktop updates have separate actions.", target: { kind: "editor", editor: "updates" } },
  { id: "runtime", category: "updates", title: "Runtime & versions", keywords: "版本 运行环境 CLI 登录 账户 连接 机器 兼容 MCP 服务 模型 runtime version sign-in machine mcp services models", scope: "Workspace service · each execution machine · this client", source: "Core's version, each machine's stored last check, Codex's connection on the Core host as Core holds it now, the Core host's Jobs budget, each Agent's last MCP report and this client's own version.", effect: "Read-only. Checks run from Machines; nothing here signs in, reconnects or updates. Reading the Jobs budget may have Core sample the GPUs; an MCP Refresh asks one Claude Code session; Check models makes the New Agent dialog's catalog reads on the Core host.", target: { kind: "editor", editor: "runtime" } },
  { id: "about", category: "updates", title: "About & help", keywords: "关于 帮助 文档 说明 反馈 问题 报告 安全 漏洞 许可证 许可 声明 发行说明 版本说明 about help docs documentation readme feedback issue bug report security vulnerability license licenses notices release notes", scope: "Workspace service · this page", source: "The notes inside the release the Workspace service runs, the license texts served with this page, and the project's pages on GitHub.", effect: "Read-only. Links open GitHub outside Yuzuno; nothing is sent from here.", target: { kind: "editor", editor: "about" } },
];

/** The editors this version shows in the interface language (T-189); the
 * others, and the rest of Yuzuno, stay in English. */
export const translatedEditors: readonly SettingsEditor[] = ["language", "input", "time", "shortcuts"];

/** Search finds an entry by its words in either language, whichever is
 * shown (T-189): its English and Chinese title, scope and category. */
export function findSettings(query: string): readonly SettingEntry[] {
  const words = query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return settingsCatalog.filter((entry) => {
    const category = settingsCategories.find((category) => category.id === entry.category)!;
    const zh = entriesZh[entry.id] ?? {};
    const text = [entry.title, entry.keywords, entry.scope, category.label, zh.title, zh.scope, categoriesZh[entry.category].label]
      .filter(Boolean).join(" ").normalize("NFKC").toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** An entry's visible text in `language`; what the table lacks stays English. */
export function localizedEntry(entry: SettingEntry, language: Language): SettingEntry {
  if (language !== "zh-Hans") return entry;
  const zh = entriesZh[entry.id] ?? {};
  const target = entry.target.kind === "unavailable" && zh.reason ? { ...entry.target, reason: zh.reason } : entry.target;
  return { ...entry, title: zh.title ?? entry.title, scope: zh.scope ?? entry.scope, source: zh.source ?? entry.source, effect: zh.effect ?? entry.effect, target };
}
/** A category's label and description in `language`. */
export function localizedCategory(id: SettingsCategory, language: Language): { label: string; description: string } {
  const category = settingsCategories.find((item) => item.id === id)!;
  return language === "zh-Hans" ? categoriesZh[id] : category;
}
