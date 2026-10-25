import type { SettingEntry, SettingsCategory } from "./settings-catalog.ts";

/**
 * Settings' directory in Simplified Chinese (T-189): each category's and
 * entry's visible text, by id. Product names (Agent, Core, Job, Home, Brief,
 * Workspace, Turn, Codex, Claude, MCP) stay as they are written, as other
 * names and identifiers do. An entry or field missing here is shown in
 * English (localizedEntry).
 */
export const categoriesZh: Record<SettingsCategory, { label: string; description: string }> = {
  appearance: { label: "外观与交互", description: "此设备如何显示你的 Workspace。" },
  notifications: { label: "通知与提醒", description: "Yuzuno 内的提醒，以及通知能力。" },
  agents: { label: "Agent 与运行环境", description: "先选择一个 Agent，再更改它的运行设置。" },
  connections: { label: "连接与设备", description: "客户端、Workspace 服务与执行机器各有分工。" },
  projects: { label: "项目与协作", description: "项目配置与 Workspace 共享偏好。" },
  jobs: { label: "Job 与资源", description: "预算作用于所选机器上的托管 Job。" },
  data: { label: "数据、隐私与恢复", description: "存储信息与恢复能力。" },
  updates: { label: "更新与关于", description: "Workspace 服务与桌面客户端的版本和更新，以及帮助、发布说明与许可证。" },
};

type EntryText = Partial<Pick<SettingEntry, "title" | "scope" | "source" | "effect">> & { reason?: string };

export const entriesZh: Record<string, EntryText> = {
  appearance: { title: "主题、文字与布局", scope: "此设备 · 此站点", source: "保存在此浏览器或 WebView 中的偏好；未设置时使用内置默认值。", effect: "更改会立即预览。存储成功后，重新打开仍会保留。可导出为文件，预览后再导入。" },
  "send-key": { title: "发送消息", scope: "此设备 · 此站点", source: "保存在此浏览器或 WebView 中的选择；未设置时为“自动”。", effect: "立即作用于会话的输入框。存储成功后，重新打开仍会保留。" },
  shortcuts: { title: "键盘快捷键", scope: "此设备", source: "此版本已有的快捷键，按它们在此设备上的实际效果列出。", effect: "仅供查看。此版本还不能改用其他按键。" },
  transfer: { title: "把偏好移到另一台设备", scope: "此设备 · 你保存的文件", source: "此设备当前生效的外观、发送键和时间显示。不含 Workspace、账户或权限的任何内容。", effect: "导出会写出一个文件。导入会把每组设置与你现有的并排显示；每组单独应用，只在保存到此设备后才生效。它不会在设备之间同步。" },
  "appearance-preset": { title: "共享外观预设", scope: "此 Workspace · 在此设备上应用", source: "此 Workspace 的 Core 保存的一个外观预设，由你选择时从某台设备保存；在那之前没有。", effect: "保存只在它自你读取后未被更改时才会替换它。应用会把每项设置与你的并排显示，并保存到此设备上。只有在你开启后，设备才会单向跟随它；它不是双向同步。" },
  clock: { title: "时钟与时区", scope: "此设备 · 此站点", source: "保存在此浏览器或 WebView 中的选择；未设置时为“系统”和此设备的时区。", effect: "立即改写会话和 Home 中的时间及其日期。保存的时间与相对时间不变。存储成功后，重新打开仍会保留。" },
  language: { title: "界面语言", scope: "此设备 · 此站点", source: "保存在此浏览器或 WebView 中的选择；未设置时为“系统”，即此浏览器的语言。此版本没有的语言显示为英文。", effect: "设置目录、搜索和此设备的页面会立即切换；其他页面仍为英文。人和 Agent 写下的内容、代码与日志从不翻译。" },
  notifications: { title: "通知偏好", scope: "此设备 · 此浏览器", source: "此设备的选择，保存在此浏览器中；权限由浏览器自己管理。“需要你处理”和未读动态始终在 Workspace 内显示。", effect: "仅在 Yuzuno 打开而你在看别处时通知；若选择了每日备份失败提醒，你正在看时也会通知。静音不会改变 Agent 或 Workspace 投递的任何内容；没有推送或后台通知。" },
  "agent-model": { title: "模型、推理与权限", scope: "所选 Agent", source: "此 Agent 保存的选择及其 harness 的目录。原生观测结果另行显示。", effect: "模型与推理强度的更改从下一个 Turn 起生效。编辑页会说明该 harness 的权限生效时机。" },
  "agent-context": { title: "上下文窗口与压缩", scope: "所选 Codex Agent", source: "保存的覆盖值、请求应用的值与原生观测到的用量分开显示。", effect: "“保存”保留选择；“应用”需要会话安全空闲。未知的原生值保持未知。" },
  "auto-continue": { title: "Claude 用量限额重置后继续", scope: "所选本地 Claude Agent · Workspace 默认值", source: "Agent 可以选择继续、等待，或使用已保存的 Workspace 默认值。", effect: "当用量限额让 Agent 停下时，此策略决定重置后 Yuzuno 是否发送继续消息。" },
  "agent-defaults": { title: "新 Agent 默认值", scope: "此 Workspace · 此后创建的 Agent", source: "由 Core 保存；未设置即 Yuzuno 的内置行为。“跟随 Codex 配置”使用每台机器自己的配置。", effect: "在创建 Agent 时使用。现有 Agent 保留各自的设置，机器仍会在启动时决定是否允许某项权限。" },
  review: { title: "代码审查", scope: "此 Workspace", source: "Core 保存的审查 harness 与模型；未保存时使用内置审查者。", effect: "用于新的审查。进行中的审查保留原来的设置。" },
  credentials: { title: "账户、凭据与 MCP", scope: "执行机器 · 原生 harness", source: "登录与凭据属于执行机器上的原生工具。", effect: "Agent 运行环境与 MCP 状态可在会话检查器中查看，也都在“运行环境与版本”中。", reason: "此设置中心不保存 API 密钥，也不编辑原生登录与 MCP 配置。" },
  machines: { title: "执行机器与 SSH", scope: "所选执行机器", source: "机器注册由 Core 保存；SSH 密钥与主机配置属于 OpenSSH。", effect: "在“机器”中选择一台机器，编辑它的连接和新 Agent 默认文件夹。现有 Agent 不会移动。" },
  phone: { title: "手机与远程访问", scope: "Workspace 服务 · 其 Windows 电脑上的 Tailscale", source: "Core 保存的手机入口、Core 监听的地址，以及 Tailscale Serve 入口，分别读取并分别显示。", effect: "打开和“检查”不会更改任何内容。“保存并应用”只更改 Core 的手机入口及其自己的 Serve 入口；其他 Serve 入口保持不变。" },
  projects: { title: "项目目录、仓库与服务", scope: "所选项目 · 按执行机器", source: "由 Core 保存的项目设置。默认目录按机器分别记录。", effect: "默认目录只用于预填新 Agent。注册服务不会启动它；归档不会移动文件。" },
  home: { title: "Home 展示", scope: "此 Workspace", source: "由 Core 保存的共享 Home 展示偏好。", effect: "用于之后的 Home 与结果交互。不会更改编辑权限或 Agent 权限。" },
  budget: { title: "Core 主机 Job 预算", scope: "Core 执行机器", source: "由 Core 保存的托管 Job 的 CPU、内存、交换空间、磁盘与 GPU 限制。", effect: "新 Job 的准入使用此预算。运行中的 Job 保留各自的预留；原生后台任务不在其内。" },
  "remote-budget": { title: "远程机器 Job 预算", scope: "所选执行机器", source: "所选机器保存的 Job 预算及其报告的限制能力。", effect: "编辑前先选择机器。限制取决于该执行器的能力。" },
  storage: { title: "数据与存储概览", scope: "此设备 · Workspace 服务 · 原生 CLI", source: "此浏览器为此站点保存的数据，在这里读取；Core 的数据文件夹，由 Core 读取。原生会话历史只计数，不测量大小。", effect: "打开它只会读取。这里不测量文件夹大小，也不删除任何内容。" },
  diagnostics: { title: "复制诊断信息", scope: "此客户端 · Workspace 服务", source: "按需收集、已脱敏的诊断报告。", effect: "复制报告不会自动上传它。清除只会删除此设备上记录的错误。" },
  history: { title: "历史与内存信息", scope: "Workspace 服务", source: "Core 报告的历史构成与内存信息。", effect: "只读信息；不会清除会话或原生会话。" },
  backup: { title: "Workspace 备份与恢复", scope: "Workspace 服务 · 其电脑上的一个文件夹", source: "此 Core 制作的备份：数据库、图片副本、Brief 附件、已完成的审查和 Job 文件夹，并附一份未包含内容的清单。更新恢复用的数据库副本不是它。", effect: "在 Core 运行且没有 Job 运行时备份；只恢复到新的或空的文件夹。原生会话与 CLI 账户从不在备份中。" },
  drafts: { title: "草稿存储", scope: "此设备 · 此站点", source: "由此浏览器或 WebView 保存的草稿，每个 Agent ID 一份；不记录草稿是在哪个 Workspace 中写的。粘贴的文本单独保存，只在你选择的草稿中打开。", effect: "显示草稿或把它保存为文本文件不会更改任何内容；图片只计数，不会保存。草稿只在此设备上，不跨设备同步。" },
  updates: { title: "版本与更新", scope: "Workspace 服务 · 桌面客户端", source: "已安装的 Core 与客户端版本，以及可用的已签名发布。", effect: "检查不会安装任何内容。服务更新与桌面更新是分开的操作。" },
  runtime: { title: "运行环境与版本", scope: "Workspace 服务 · 每台执行机器 · 此客户端", source: "Core 的版本、每台机器保存的最近一次检查、Core 当前持有的 Core 主机上 Codex 的连接、Core 主机的 Job 预算、每个 Agent 最近一次的 MCP 报告，以及此客户端自己的版本。", effect: "只读。检查在“机器”中进行；这里不会登录、重连或更新。读取 Job 预算可能让 Core 采样 GPU；MCP 的“刷新”会询问一个 Claude Code 会话；“检查模型”会在 Core 主机上进行“新建 Agent”对话框的目录读取。" },
  about: { title: "关于与帮助", scope: "Workspace 服务 · 此页面", source: "Workspace 服务所运行发布中的说明、随此页面提供的许可证文本，以及项目在 GitHub 上的页面。", effect: "只读。链接会在 Yuzuno 之外打开 GitHub；这里不会发送任何内容。" },
};
