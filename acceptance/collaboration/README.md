# Peer Message 与共享任务板验收

2026-10-12，独立 worktree `/home/developer/yuzuno-next-collaboration`，分支 `feat/collaboration-mcp`，起点 `dc7752d`。调研先提交为 `bf37f7e`，随后实现。日用 Core 4317、日用数据库、主工作目录的 `web/dist` 均未切换。

后续状态：本记录描述独立开发时的验收；现已合入 `main` 并经用户批准完成日用 Core/UI 切换。原 worktree 与 4379 实验服务已关闭，生成证据保留在主目录同路径。最新结果见 [合并与切换记录](../collaboration-merge/README.md)，日用入口为 `http://localhost:4317`。

## 实现范围

- [行业调研](../../docs/task-board-grounding.md)：对照旧 Yuzuno 的 Turn→Task 写入路径、Linear Issue/AgentSession、GitHub Copilot 后续 Session、OpenProject WorkPackage/Journal。任务与执行从存储和写入入口分开；不把运行记录过滤隐藏后称为解决。
- 官方 Rust MCP SDK `rmcp 3.5.1` 提供 Streamable HTTP；已有 Axum/Tokio/rusqlite 承载操作、通知和持久化。React/Radix 复用当前界面。无新消息中间件或独立任务服务。
- GUI 与 MCP 共用 11 个操作：`peers_list`、`peer_send`、`peer_read`、`task_list`、`task_get`、`task_create`、`task_update`、`task_claim`、`task_comment`、`task_submit_result`、`task_dispatch`。
- 邮件正文与待提醒状态原子保存。默认 `normal` 等当前 Turn 结束；`urgent` 尽快使用 Codex `turn/steer` 或 Claude 原生工具 hook 交付门铃，正文仍通过 MCP 取回，不主动中断工作。两类邮件单独分批、按优先级取信。先记录发送意图，输入结果未知不自动重放；分页重读不会跳过消息。
- 空闲 Agent 的普通邮件新 Turn 唤醒最小间隔 10 秒、每 10 分钟最多 6 次；紧急邮件单独计数，每分钟最多 20 次，没有普通邮件的最小间隔。运行中追加门铃不消耗新 Turn 预算。正常流量不会用掉紧急容量，同时限制空闲 Agent 相互发送紧急回执造成的空转。
- 任务公开编号统一为 `T-1`、`T-2`；GUI、MCP 结果、关联消息和全部任务操作使用同一编号，归档/恢复不重排或复用。内部 UUID 与旧请求缓存仍兼容，不改历史消息自由正文。
- 原生 Turn、plan、日志和恢复不会创建/完成任务或覆盖任务定义。任务成果、进展、阻碍、追加评论分别保存；字段修改检查版本，评论不推进字段版本。来源由 Core 根据真实 Agent/Turn/Session 记录。
- 每个 Harness 使用独立持久凭证。Codex 只为本服务的有限工具目录授予自动调用；Claude 只允许 `mcp__yuzuno__*`。没有改变 shell、文件或其他 MCP 的原生权限，没有写全局账户配置。
- Mac mini 通过一条只绑定 loopback 的 SSH 反向转发访问同一 Core MCP。其本地目标是只提供 MCP 的独立监听端口，不暴露桌面 `/api/*`；每个 Workspace 按需创建一个监听器并随其关闭。转发独立恢复，保留原 Harness runtime 与 Session。

## 自动检查

在 worktree 中，Cargo 编译最多 2 个 job，测试最多 2 个线程；使用现有前端/Claude 依赖缓存，未复制整套依赖。

```sh
CARGO_BUILD_JOBS=2 cargo test --workspace -- --test-threads=2
node --test runtimes/claude/bridge.test.mjs
cd web
npm test
npm run typecheck
npm run build
```

- Core 全量 117 项通过、1 个原有忽略项；随后调整普通/紧急的独立唤醒预算，7 项 collaboration runtime 检查再次通过，二进制重新构建。覆盖远程专用端口拒绝桌面 API、旧数据/缓存短编号兼容、优先级分批、未知结果不重放及原 Turn 署名的回归。
- Claude bridge：20 通过，含原生 hook 的会话/Turn/审批边界与一次性交付。
- 前端原有 32 项与 collaboration 10 项组件检查通过（共 42 项）；新增检查已加入 `npm test`。新增检查首次有一个固定延时导致的定位失败，改为有界等待目标表单后 10 项重跑通过。
- TypeScript 和 Vite 构建通过，输出仅在本 worktree。

关键自动场景：50 轮原生事件与 plan 不污染任务；两 Agent 同时领取只有一名负责人，其他协作者仍能提交结果；请求重试不重复写入，异 payload 同 key 报冲突；发送/关闭并发；已取信不再敲门；发送结果未知不重放；重启后保留；删除 Agent 后任务/消息/署名仍在；任务与多 Agent/多 Turn 精确关联，普通对话不继承上次任务。

## 真实 Harness 与远程验收

`native-check.py` 只操作隔离 Core 4379，创建专用工作目录和测试 Agent；不会自动同意原生审批。真实 Codex `gpt-6.1-sol` 发出核对请求，Claude `haiku` 用 MCP 在原任务提交结论并回复，Codex 取回后结束。包含重试，共 5 轮、4 封邮件，仍只有 1 张任务卡；等待超过门铃最小间隔后没有无意义回执循环。结果实际署名 Claude，并关联其原始 Turn。

`remote-check.py` 使用 Mac mini 上已安装的 Codex 0.162.1、单独临时目录与测试 Agent。两轮真实 `task_list → task_get → task_comment` 成功；中间只终止本实验 Core 拥有的反向 SSH，自动修复后继续调用，原 runtime 和 Session 不变。没有新增任务或改变任务状态。测试 Agent 已关闭，远端对应 runtime 与 socket 已退出。

修正远程入口后，`remote-check.py boundary` 又用一名新的专用 Agent 完整复验通过，单独保留 `remote-boundary-state.json`：从 Mac mini 访问 `/api/health`、`/api/workspace`、`/api/collaboration/task_list`，即使携带 desktop header 都返回 404；真正的 MCP 调用在切断 SSH 前后均成功，原 Session/runtime 保持不变。该 Agent、原生 runtime、socket 和最后的实验 SSH 转发均已关闭，预览 Core 继续保留。

`priority-check.py` 新增真实优先级验收，Codex → Claude 顺序运行，每次仅一个测试 Agent。两者均在原生前台 `sleep 12` 执行中收到普通与紧急邮件：紧急门铃在原 Turn 内交付并实际通过 `peer_read priority:"urgent"` 取信；此时普通邮件仍为 pending，`firstReadAt` 为空。原 Turn 自然结束后，普通邮件才启动下一 Turn 并用 `priority:"normal"` 取信。每个 Harness 的 5 项检查均通过，评论关联同一原生 Session 和准确 Turn；两者都使用真实 MCP 短编号 `T-4`，没有另建任务卡或因执行而改变任务业务状态。

本次观察中，Codex 门铃约 0.37 秒被原生 steer 接受、约 11 秒后实际取信；Claude 约 12 秒后在工具结束 hook 交付、约 23 秒后实际取信。它们是这一次运行的观察值，不是时延保证。原命令自然完成，没有请求 Interrupt；Claude 不保证在长命令、API 调用或审批等待的中间消费门铃。两个测试 Agent 已关闭，`T-4` 显式归档。旧任务与旧 Agent 快照没有改变。原始参数、消息、来源和时间线保存在被忽略的 `priority-state.json`，已离线复查。本次优先级改动未重新运行 Mac mini，远程证据来自上述先前验收。

调试中真实发现并修正：

1. Codex 原先要求 `mcpServer/elicitation/request` 授权，本项目尚未支持该请求，首次取信被拒绝。最终为内建协作服务的明确工具目录配置原生授权，再用真实调用复验。
2. Haiku 首次把弱措辞门铃理解成可选建议，询问用户是否取信。最终在原生 preset append 与门铃中明确 Core 自动通知、取信操作和来源边界，再验证实际调用；没有把工具目录可见当作互通成功。
3. 最后审查发现反向转发整个 Core 端口会同时暴露桌面 API，固定 desktop header 不是远端身份凭证。已改为 MCP-only 监听器，自动测试验证即使携带 desktop header 和合法 Agent bearer，GUI 路由仍返回 404；并发初始化和监听器关闭也有覆盖。

原始观察存于被 Git 忽略的 `native-state.json`、`remote-state.json` 与 `core-data/`。脚本保留失败观察且拒绝覆盖既有记录。重跑须使用新的独立实验数据，不能删除日用状态。`native-check.py resume/retry-mail` 是本次调试续跑入口，完整命令含义见脚本；不用于自动重放未知输入。

## GUI 阅读与操作

`browser.mjs` 对真实协作记录做只读验收：15 项通过、零页面错误。覆盖浅深主题、20px 字体、1440/680/390px 宽度、结果精确跳到 Claude 对应 Turn 顶部、窄屏底部来源可到达、Escape 关闭，以及消息页没有独立用户发信入口、`T-1` 关联链接可达。GUI 查看邮箱不伪造 Agent 取信回执，不更改任务业务版本。截图与报告在本目录被忽略的 `screenshots/`、`browser-report.json`。

`browser-write.mjs` 的 9 项真实写入检查通过：GUI 仅标题创建、编辑、评论不推进版本、通过 API 制造并发修改、旧版本保存被拒且保留草稿、比较后显式仅应用改过的字段并保留对方进展、提交待检查/完成成果。没有发信或启动 Agent，未改原真机任务；测试任务最后归档。首次运行中测试自身的非空 textarea 定位器不准确，修正后完整重跑；没有将定位失败归为产品通过。报告为被忽略的 `browser-write-report.json`。

`browser-priority.mjs` 的 10 项只读检查通过：真实 `T-4` 邮件的 normal/urgent、Codex 当前 Turn 与 Claude native hook 的交付事实、实际取信、原 Turn 的人工输入与门铃署名、20px 深色 390px 阅读、派发紧急选项默认关闭且可选择。没有派发消息或启动 Agent。三套浏览器验收共 34 项，顺序运行且均已关闭；本轮 GUI 写入创建的 `T-5` 已归档。

卡片展示目标、状态、负责人、阻碍或成果；执行过程在关联对话中。消息页仅观察协作邮件，用户继续使用既有对话与 Agent 交流；任务“交给 Agent”保留普通/紧急选择。消息门铃在对话中标为 `Workspace mailbox`，原任务及后续人工输入仍标为 `You`。Claude 排进 hook 显示等待工具边界，收到 hook 回执后才显示投递；取信另行显示。后台刷新保留编辑草稿与开始编辑时的版本，冲突后显式比较再应用。

## 独立预览与限制

```sh
CARGO_BUILD_JOBS=2 cargo build --bin yuzuno-workspace
target/debug/yuzuno-workspace --port 4379 \
  --data-dir acceptance/collaboration/core-data \
  --web-dir web/dist --cwd acceptance/collaboration/task
```

打开 `http://localhost:4379`，左侧 **Tasks & messages**。关闭测试 Agent 后，任务与消息保留；查看关闭 Agent 的原始对话可以通过对应来源链接。预览使用测试数据，不是日用 Workspace。

实验后已关闭本地与远程测试 Harness，并关闭浏览器。一次清理后的 Core RSS 采样约 27 MiB；这只是隔离实验的驻留量，没有宣称长期负载或每 Agent 的内存上限。

当前限制：

- 尚未合并主分支、切换日用服务或重新打包 Windows Tauri；既有 GUI/API 接口仍共用 Core。
- 实验发现既有空会话恢复限制：Claude 在首个 Turn 前重启 Core，恢复可能报 `No conversation found`；Mac mini Codex 0.162.1 的空 Session reopen 可能报 `list_turns is not supported yet`。本 slice 未改变这些恢复路径，关闭空测试 Agent 后创建替代 Agent 才继续验收，证据保留。
- 未模拟实际 WSL 重启的整个机器故障；持久化/未知输入边界由自动测试覆盖，真实故障实验只切断 MCP 的 SSH 转发。
- 没有稳定 Project 实体、子任务层级或自动调度。筛选明确作用于已加载任务页。结果外部链接目前仅 http/https；本地文件从原始对话的 Artifact 入口查看。
- 任务结构不会被原生运行事件污染；Agent 显式创建的标题仍可能含糊，需要真实工作反馈改善工具提示和编辑体验。用户能否在 30 秒内读懂长期真实任务尚待日用验收。
- 浏览器检查记录一个既有警告：Appearance 对话框 Escape 关闭后没有把键盘焦点返回启动按钮；本 slice 不改该组件。
