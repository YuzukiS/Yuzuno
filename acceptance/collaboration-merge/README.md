# Collaboration / Permissions 合并与日用切换

用户明确批准合并协作分支、移除 worktree，并在没有运行中开发任务时切换 Core 与 UI。

## 合并

- `f4c4d09` 原样保存主目录中另一位 Agent 完成的会话顺序、Working/Compacting、异步回答和 Permissions 实现。
- `401fb7a` 将 `feat/collaboration-mcp`（截至 `56fd379`）合入 `main`。手工解决 `workspace.rs`、`components.tsx`、`types.ts` 的冲突。
- 原生 thread/start/resume 同时保留 Permissions、reasoning 与每 Agent 的 MCP 配置。进行中 steer 不覆盖权限，下一 Turn 才应用设置。
- 保留原生消息顺序与工具分组；门铃单独标记为 Workspace mailbox，不给原始人工输入改署名。
- 短编号继续使用 Workspace 范围的 `T-N`，内部 UUID 保留。行业依据与未来跨 Workspace 边界记在 `docs/task-board-grounding.md`。

## 合并后的验证

编译最多 2 个 job，Core 测试串行；Chromium 顺序运行，每次仅一个实例。

| 检查 | 结果 |
| --- | --- |
| Core 全量 | 138 通过，2 个既有忽略项 |
| 前端基础 / collaboration 组件 | 37 + 10 通过 |
| Claude bridge | 20 通过 |
| Permissions 浏览器 fixtures | 14 通过 |
| 会话顺序 / Working / Compacting 浏览器 fixtures | 22 通过 |
| 真实协作历史在合并 Core/UI 中的只读浏览器检查 | 10 通过 |
| 日用切换后的只读浏览器检查 | 19 通过，零页面错误、零 HTTP 错误、零写请求 |
| TypeScript、Vite、Core 构建 | 通过 |

新增 Core 组合回归覆盖新建/恢复时 Permissions 与 MCP 配置共存、配置变化只影响下一 Turn、steer 不携带权限覆盖。UI 回归覆盖 You → commentary → tool → urgent mailbox → commentary → You 的原生顺序、署名、复制、Working 与来源定位。

原有真实 Codex/Claude 普通和紧急投递、Mac mini MCP 与 SSH 恢复证据保存在 `acceptance/collaboration/`。此次合并没有重新执行付费模型任务；对原始记录做了合并 UI 的阅读验证，并对日用两个已恢复 Agent 的 MCP 执行了只读 `task_list` 请求。

## 已完成的切换

`switch.py` 的进程身份、候选文件 hash、源码 hash、旧 UI hash 与空闲状态检查通过后，前台执行切换。保留旧执行环境于内存，保存旧 Core、UI index 和 SQLite 一致性备份；使用原数据库、原端口 `4317` 和原启动位置。

- 5 个既有 Agent 身份、原生会话 ID、历史 Turn、成果、设置及已读位置在启动时核对保留。
- Dev 1 / Dev 2 均恢复到同一个 Codex / Claude Session，保持 idle，没有发送消息、开始新 Turn、批准操作或代替用户标记已读。
- 两个 Agent 的认证 MCP `task_list` 成功，日用任务板与 Messages 可访问。实验任务没有导入日用数据库。
- 日用浏览器验收检查了真实历史、Permissions 四选项、Tasks/Messages、浅深主题、20px 和窄屏；测试浏览器已关闭。
- `4379` 实验 Core 已停止；`/home/developer/yuzuno-next-collaboration` worktree 已移除。测试记录迁入主目录的 `acceptance/collaboration/`；旧构建缓存随 worktree 释放。

现有窗口需要刷新以加载新版 UI，入口仍是 `http://localhost:4317`。Windows 原生客户端继续连接 WSL Core，无需重新打包。

## 本机证据与恢复材料

以下生成文件均被 Git 忽略，不提交对话、数据库或凭证：

- `switch.json`：状态 `complete`、进程身份、会话恢复与 MCP 结果。
- `plan.json`：候选/源码/UI hash 及原进程定位。
- `workspace-cutover.sqlite`、`previous-core`、`previous-index.html`、`previous-preview.html`：切换前恢复材料。
- `daily-browser-report.json` 与 `screenshots/`：日用只读验收。
- `browser-permissions/`、`browser-turn-flow/`、`browser-priority/`：合并候选的浏览器验收。
- `core-tests.log`、`core-build.log`、`bridge-tests.log`、`ui-stage.log`：构建与测试记录。

切换脚本是一次性的：既有报告或备份存在时拒绝再次执行，也不覆盖记录。以后切换应建立新的验收目录和计划。脚本失败恢复二进制/UI，不自动覆盖用户数据库。
