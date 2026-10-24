/** Navigation metadata only. Values and persistence belong to the existing editors. */
export const settingsCategories = [
  { id: "appearance", label: "Appearance & interaction", description: "How this device displays your Workspace." },
  { id: "notifications", label: "Notifications & attention", description: "Attention inside Yuzuno and notification capabilities." },
  { id: "agents", label: "Agents & runtime", description: "Choose an Agent before changing its runtime settings." },
  { id: "connections", label: "Connections & devices", description: "The client, Workspace service and execution machines have separate roles." },
  { id: "projects", label: "Projects & collaboration", description: "Project configuration and shared Workspace preferences." },
  { id: "jobs", label: "Jobs & resources", description: "Budgets apply to managed Jobs on the selected machine." },
  { id: "data", label: "Data, privacy & recovery", description: "Storage information and recovery capabilities." },
  { id: "updates", label: "Updates & about", description: "Versions and updates for the Workspace service and desktop client." },
] as const;
export type SettingsCategory = typeof settingsCategories[number]["id"];
export type SettingsEditor = "appearance" | "updates" | "home" | "review" | "diagnostics" | "history" | "remote";
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
  { id: "appearance", category: "appearance", title: "Theme, text & layout", keywords: "外观 主题 字体 字号 密度 颜色 明暗 分组 dock turn", scope: "This device · this site", source: "Preferences saved in this browser or WebView; built-in defaults when unset.", effect: "Changes preview immediately. Storage must succeed to keep them after reopening.", target: { kind: "editor", editor: "appearance" } },
  { id: "language", category: "appearance", title: "Language, time & shortcuts", keywords: "语言 时间 时区 快捷键 发送键 回车 keyboard enter", scope: "This device", source: "The interface uses its built-in language and shortcuts; dates use the browser locale.", effect: "Touch input keeps Enter for a new line. Keyboard shortcuts are currently fixed.", target: { kind: "unavailable", reason: "Custom language, time zone and shortcut controls are not available in this version." } },
  { id: "notifications", category: "notifications", title: "Notification preferences", keywords: "通知 注意力 声音 免打扰 系统 权限 推送 needs you unread", scope: "This device", source: "Yuzuno shows Needs you and unread activity inside the Workspace.", effect: "System notification delivery also depends on the client and operating system.", target: { kind: "unavailable", reason: "System notification permissions, sounds, quiet hours and a test notification are not available here yet." } },
  { id: "agent-model", category: "agents", title: "Model, reasoning & permissions", keywords: "Agent 模型 推理 权限 approvals sandbox effort runtime", scope: "Selected Agent", source: "This Agent’s saved choices and its harness catalog. Native observations remain separate.", effect: "Model and effort changes apply from the next turn. The editor explains the harness’s permission timing.", target: { kind: "agent", section: "model" } },
  { id: "agent-context", category: "agents", title: "Context window & compaction", keywords: "上下文 窗口 压缩 context token automatic compact", scope: "Selected Codex Agent", source: "Saved overrides, requested application and native observed usage are shown separately.", effect: "Save keeps the choice; Apply requires a safe idle conversation. Unknown native values stay unknown.", target: { kind: "agent", section: "context" } },
  { id: "auto-continue", category: "agents", title: "Continue after Claude’s usage limit resets", keywords: "自动继续 自动恢复 配额 限额 quota resume auto continue", scope: "Selected local Claude Agent · Workspace default", source: "The Agent can choose continue, wait, or use the saved Workspace default.", effect: "When a usage limit stops the Agent, the policy controls whether Yuzuno sends a continuation after reset.", target: { kind: "agent", section: "auto-continue" } },
  { id: "review", category: "agents", title: "Code review", keywords: "审查 审阅 review harness 默认 模型", scope: "This Workspace", source: "Reviewer harness and model saved by Core.", effect: "Used for new reviews. Running reviews keep their original settings.", target: { kind: "editor", editor: "review" } },
  { id: "credentials", category: "agents", title: "Accounts, credentials & MCP", keywords: "账户 登录 密钥 token 凭证 MCP CLI native", scope: "Execution machine · native harness", source: "Login and credentials belong to the native tools on their execution machine.", effect: "Agent runtime and MCP status are visible in the conversation inspector.", target: { kind: "unavailable", reason: "This settings center does not store API keys or edit native login and MCP configuration." } },
  { id: "machines", category: "connections", title: "Execution machines & SSH", keywords: "设备 机器 连接 SSH 主机 默认目录 default folder cwd", scope: "Selected execution machine", source: "Machine registration is saved by Core; SSH keys and host configuration belong to OpenSSH.", effect: "Choose a machine in Machines to edit its connection and new-Agent default folder. Existing Agents do not move.", target: { kind: "machines" } },
  { id: "phone", category: "connections", title: "Phone & remote access", keywords: "手机访问 手机 远程访问 tailscale serve 网络 remote phone", scope: "Workspace service · Tailscale on its Windows PC", source: "The phone entry saved by Core, what Core listens on, and the Tailscale Serve entry, each read and shown separately.", effect: "Opening and Check change nothing. Save and apply changes Core’s phone entry and its own Serve entry only; other Serve entries are left as they are.", target: { kind: "editor", editor: "remote" } },
  { id: "projects", category: "projects", title: "Project directories, repositories & services", keywords: "项目 默认目录 工作目录 仓库 服务 default directory folder cwd repository service", scope: "Selected project · per execution machine", source: "Project settings saved by Core. Default directories are recorded per machine.", effect: "Default directories prefill new Agents only. Registering a service does not start it; archiving does not move files.", target: { kind: "project" } },
  { id: "home", category: "projects", title: "Home presentation", keywords: "Home 首页 主页 展示 偏好 视觉 图表 协作", scope: "This Workspace", source: "The shared Home presentation preference saved by Core.", effect: "Used in later Home and result interactions. This does not change editor access or Agent permissions.", target: { kind: "editor", editor: "home" } },
  { id: "budget", category: "jobs", title: "Core host Job budget", keywords: "预算 资源 CPU RAM 内存 swap GPU 磁盘 并发 本地 budget resource disk", scope: "Core execution machine", source: "Managed Job CPU, memory, swap, disk and GPU limits saved by Core.", effect: "New Job admission uses the budget. Running Jobs retain their reservations; native background tasks are outside it.", target: { kind: "jobs" } },
  { id: "remote-budget", category: "jobs", title: "Remote machine Job budgets", keywords: "预算 远程 机器 SSH 并发 内存 budget remote", scope: "Selected execution machine", source: "The selected machine’s saved Job budget and reported enforcement capabilities.", effect: "Choose a machine before editing. Limits depend on that executor’s capabilities.", target: { kind: "machines" } },
  { id: "diagnostics", category: "data", title: "Copy diagnostics", keywords: "隐私 诊断 脱敏 日志 diagnostics privacy", scope: "This client · Workspace service", source: "A redacted diagnostic report collected on request.", effect: "Copying a report does not upload it automatically.", target: { kind: "editor", editor: "diagnostics" } },
  { id: "history", category: "data", title: "History & memory information", keywords: "历史 内存 数据 占用 history storage memory", scope: "Workspace service", source: "Core’s reported history composition and memory information.", effect: "Read-only information; this does not erase conversations or native sessions.", target: { kind: "editor", editor: "history" } },
  { id: "backup", category: "data", title: "Workspace backup & restore", keywords: "备份 恢复 导出 保留 清理 缓存 backup restore export retention", scope: "Workspace data · native sessions", source: "Update recovery keeps a database backup, not a complete Workspace backup.", effect: "Attachments and native sessions require their own recovery coverage.", target: { kind: "unavailable", reason: "Full Workspace backup, export and restore are not available in this settings center." } },
  { id: "drafts", category: "data", title: "Draft storage", keywords: "草稿 draft 缓存 设备 同步 origin", scope: "This device · this site", source: "Drafts are saved by this browser or WebView.", effect: "Changing the site address does not migrate drafts. Appearance resets do not clear drafts.", target: { kind: "unavailable", reason: "Cross-device draft sync is not available. A damaged draft has its own recovery controls in the conversation." } },
  { id: "updates", category: "updates", title: "Versions & updates", keywords: "更新 版本 关于 Core 客户端 桌面 client version about release", scope: "Workspace service · desktop client", source: "Installed Core and client versions, and available signed releases.", effect: "Checking installs nothing. Service updates and desktop updates have separate actions.", target: { kind: "editor", editor: "updates" } },
];

export function findSettings(query: string): readonly SettingEntry[] {
  const words = query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return settingsCatalog.filter((entry) => {
    const category = settingsCategories.find((category) => category.id === entry.category)!;
    const text = `${entry.title} ${entry.keywords} ${entry.scope} ${category.label}`.normalize("NFKC").toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}
