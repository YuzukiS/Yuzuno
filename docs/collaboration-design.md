# Peer Message 与共享任务板的实施依据

状态：已合入 `main` 并经用户批准完成日用 Core/UI 切换；真实 Codex/Claude 互通与 Mac mini SSH 通道恢复通过。具体证据、复现命令和限制见 [独立验收记录](../acceptance/collaboration/README.md) 与 [合并切换记录](../acceptance/collaboration-merge/README.md)。

前提：Yuzuno next 创建并管理 Harness，已经掌握 Agent 身份、Session、输入通道和运行事件。直接使用这些信息，不继承旧版的被动身份推断、终端注入、Hook 关联和 Supervisor 体系。实现放在现有 Core 内，不增加独立协作平台。

## 派工时的固定工作材料

`task_dispatch` 自动附上任务目标、显式登记的验收/基线/worktree/资料引用/返回要求，以及已关联 Project 仓库和任务 GitHub 观察。`body` 是本次补充要求，省略或空字符串都保留自动材料。缺项显示“未指定”，不会从 Agent cwd、Project 默认目录或聊天推断；已保存 GitHub 观察标时间和过期状态，不代表当前批准或自动选中的工作基线。

`task_create.materials` 与 `task_update.patch.materials` 显式登记资料，后者替换整个登记对象，`null` 清空。字段为 `acceptance`、`repositoryId`、`baseSha`、`headSha`、`baseline`、`worktree`、`references`、`returnRequirements`。有 base/head SHA 时必须指定关联仓库；SHA 为完整 40 或 64 位十六进制值，或 4–39 位十六进制缩写。缩写由 Core 在写入前到该 `repositoryId`（`task_dispatch` 未给时用已登记资料的仓库）对应的 GitHub 仓库解析，只接受恰好一个且以该缩写开头的提交，保存并比较完整 SHA；歧义、找不到、非提交对象或没有已保存仓库时拒绝，不猜、不截断、不补零，分支名、标签等表达式也不解析。引用最多 20 条，每条有 `kind`（acceptance/decision/evidence）和 `label`，以及 http(s) `url` 或属于指定 `taskId` 的 `activitySeq`。链接和目录仅是资料，不扩大权限；除解析缩写 SHA 的一次 GitHub 查询外，生成材料不读取其文件或网络内容。

派工的 `materials` 对登记字段做仅本次覆盖，字段 `null` 取消该项，整体 `null` 清空本次材料。它不修改长期登记，也不能改写 Core 绑定的执行者和原派工结果接收者。

同一派工事务把完整材料保存到活动记录，并在消息中提供 `materialsRef`。它包含原 `dispatchId`、任务版本、采集时间、登记来源和覆盖字段；同 requestId 重试返回同一派工。后续修改任务、GitHub 观察或重新派工不会改写这个快照：

- `task_get({taskId, dispatchId})` 直接按任务与原派工 ID 查询，仅返回 `dispatchMaterials` 和 `latestTask.taskId` 入口，不展开最新任务、活动或执行历史。
- `task_get({taskId, view: "full"})` 读取最新任务、登记资料及原有活动/执行信息。常规活动页只返回派工材料引用；读取决定活动可用 `afterSeq: activitySeq - 1, limit: 1`。GUI 不带 `view`，仍读这份完整记录。
- Agent 经 MCP 不带 `view` 时读 `current`（T-153）：状态、版本、负责人、派工、短结果、最新活动及当前交付（各 PR 的固定 head/base、该 head 最后观察到的 CI、最新评审、最新 CI 订阅及其最新 run，均带观察时间）。它按索引读取，不扫描历史；超过 1500 字符的文本截断并注明。未观察、其他提交或过期的状态写作 unknown，不当作通过，也不据此合并或完成任何事。带 `afterSeq`/`limit` 时默认 `view: "activity"`，按 seq 光标分页，期间新写入的活动只出现在后续页。
- Agent 的任务写入（create/update/claim/comment/submit_result/dispatch）返回短回执：完整回答删去字段后的子集，路径与名称不变（`task.id`、`task.version`、`task.result.id`、`message.id` 等）。存储的幂等回执仍是完整对象，重试经同一投影返回同样内容。`review_get` 默认返回摘要（结论、全部发现、覆盖计数和未覆盖路径及原因），`view: "full"` 返回原始报告、上下文读取和逐文件证据。
- 旧派工没有材料快照时，显式查询返回 `dispatch_materials_not_found`，不会拿最新资料冒充旧快照。

登记对象上限 32 KiB，固定快照上限 128 KiB，最终消息正文上限 16 KiB（均为 UTF-8 字节）；Project 仓库最多 20 项、任务 GitHub 链接最多 30 项。正文中的长字段以固定快照字段入口代替，不静默截断；超过存储上限或引用无效时整个派工事务回滚。执行者沿原任务调用 `task_submit_result` 并保留原 `dispatchId`；自动通知不等于独立评审、合并或上线。

定向 Store/MCP 回归覆盖固定快照、重复请求、覆盖/清空、跨任务拒绝、索引读取、长度预算和兼容。`tools/dispatch-materials-native-acceptance.py` 在有资源限制的 Job 中启动独立 Core，用空正文派工驱动真实 Codex 修复一个解析器；它通过 SSE 观察进度，独立复跑未修改的测试，核对原任务/派工回报及权限不变，并收尾自己的进程。它不更新日用 Core 或 UI。

任务板的具体产品边界以 [任务与执行的行业调研](task-board-grounding.md) 为准：明确区分任务定义、进展、成果与关联执行；从存储和写入入口保证运行事件不会生成任务卡，不能只靠看板过滤。

## Peer Message 从第一版采用邮箱与门铃

基本路径：发送消息 → Core 保存正文 → 原生输入通道提醒收件 Agent → Agent 用 MCP 取正文 → 按消息 ID 回复。

这借鉴 PostgreSQL 的通知模式：数据留在表中，通知表示有变化可读；通知在提交之后发出，也可以合并。我们采用这个模式，存储仍用已有 SQLite。[PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)

- **保存与提醒分开。** 保存成功就返回消息 ID，不等待对方回答。保存和待提醒记录在同一事务提交，Core 重启后检查待办记录。
- **门铃简短且合并。** 同一 Agent 短时间收到多条消息只提醒一次，正文按需分页读取。Core 内部复用 Tokio Notify；它不是消息存储。[Tokio Notify](https://docs.rs/tokio/latest/tokio/sync/struct.Notify.html)
- **普通与紧急分开。** `peer_send` 与任务派发默认 `priority: normal`，在当前 Turn 结束后合并提醒；`urgent` 在原生能力允许的最近机会投递门铃。两类消息单独分批、按优先级取信，紧急门铃不会顺带投递普通邮件。已连接且空闲的 Agent 可以被门铃唤起。
- **直接用原生接口。** Codex 紧急门铃通过 `turn/steer` 追加到当前 Turn，不打断或重开。Claude 的流式输入仅提供排队行为，缺少相同的 Turn 条件确认，因此使用 SDK 官方 `PostToolUse`、`PostToolUseFailure`、`PostToolBatch` 的 `additionalContext`，在原生工具边界返回简短门铃；未遇边界就到结束后再处理。排进 hook、返回原生 hook、实际取信分别记录。长工具/API 调用未结束时不宣称模型已经看到，审批仍由用户决定。[Codex App Server](https://learn.chatgpt.com/docs/app-server) · [Claude SDK 输入队列](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) · [Claude SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- **离线保留、关闭尊重。** 首版离线消息等待正常恢复，GUI 提供恢复并处理的入口；已关闭 Agent 不被新消息自动打开。删除后不能把旧地址投递给同名新 Agent。
- **身份由 Core 绑定。** 创建 Harness 时配置对应 Agent 的 MCP 访问范围，调用者不用填写或猜测自己是谁。保留实际来源，Peer Message 不伪装成用户亲自下达的指令。
- **读取不删除正文。** 按实际返回的消息 ID 记录取信事实，GUI 浏览不替 Agent 取信；返回/送入 Harness 的证据不宣称模型理解了内容。分页游标随请求/响应显式传递，不因服务器发出响应就自动推进默认读取位置；响应丢失后重试仍能取到同一页。同伴未读/待回复也不计为等待用户审批的 Pending。
- **重试只做必要保证。** 消息写入在发送者范围内按请求 ID 去重；同 ID 的收件人、正文、线程和回复关联必须一致，否则报冲突。模型输入结果未知时查询原会话，不盲目重复启动 Turn；这不妨碍继续保存新消息。
- **已处理的结果不再敲门（T-202）。** 结果通知的收件 Agent 可以用 `task_result_ack` 带该结果的 `resultId` 和 `dispatchId` 明确确认已处理；只有被通知的 Agent 能确认，重复确认幂等，记录在 `collaboration_result_acks`，重启后保留。确认时只把仍在等待的该结果提醒标为 `skipped`；发送中、未确认、已送达或失败的不撤回，之后退回等待的（原生 hook 或 steer 延后、失败后重试）也跳过。邮件、审计和同批其他邮件不变；读信、`task_get`、标记完成或评论都不算确认。
- **避免空转。** 已提醒的旧消息不在每轮结束后重复敲门；取信与传输回执不产生回复消息。普通与紧急的新 Turn 唤醒预算分开，普通流量不会用掉紧急提醒容量；运行中追加门铃不消耗新 Turn 预算。短时间消息合并，真实验收检查两 Agent 是否会相互无意义回复。

消息页是协作观察入口：展示实际作者、接收者、关联任务和原始对话、通知/取信事实。没有独立的用户发信框，用户在已有对话中与 Agent 交流；任务板保留明确的“交给 Agent”操作及普通/紧急选择。

MCP 负责工具访问，是否将通知送入模型由 Harness/Host 决定。因此门铃直接走我们掌管的原生输入通道，不假设 MCP 资源变更通知会自动唤醒模型。[MCP Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)

## 任务板采用共享工作记录

第一版字段：稳定标题与说明、负责人、状态、关键进展、阻塞说明、结果摘要与成果链接、版本、创建/更新时间；另有追加活动和执行关联。状态用待办、进行中、受阻、待检查、完成、取消；归档单独记录。需要检查的交付进入待检查，无须为每个任务增加审批。创建时仍只需标题，状态有默认值。

公开任务编号统一为稳定的 `T-1`、`T-2`。GUI、MCP 返回、结构化消息关联和所有任务操作使用同一个短编号，Agent 不必另起一套编号。内部 UUID 留作历史关联，旧 UUID 请求与缓存回执仍兼容；归档、排序、换 Agent 和恢复都不改变或复用短编号。不修改已写下的消息自由正文。

- **共同维护同一份任务。** GUI 和 MCP 调用相同的 Core 操作，所有机器连接这个 Core。SQLite 文件只由 Core 管理，不跨机器共享数据库文件。[SQLite WAL](https://sqlite.org/wal.html)
- **领取是原子操作。** 两个 Agent 同时领取，只有一个成功；另一个看到当前负责人。领取不因离线自动失效，不引入续租、心跳或过期抢占。领取只争夺主要负责人，其他协作者仍可评论和提交检查结果；用户可以显式转交或解除分配。
- **修改采用小补丁和版本检查。** 提交只包含改变的字段以及读到的版本；过期修改返回当前任务，GUI 保留草稿。首版不做旧版的三方自动合并，也不静默覆盖。[HTTP If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match)
- **活动追加，正文保持清晰。** 纯评论只需幂等追加，不要求或推进任务字段版本；修改当前进展、结果或状态才检查并推进版本。评论不反复改任务说明，也不制造任务字段的版本冲突。当前记录、活动历史和重试回执一起提交。
- **责任与执行分开，但操作可以一键完成。** 修改负责人只改变归属；GUI 的“交给 Agent”可以一次完成分配、创建关联消息和门铃提醒。任务与消息先原子保存，事务外调用 Harness。用户无需手动走两套流程。
- **进展有来源。** 完成显示谁标记了完成，并链接实际 Turn/文件/回复；Harness Turn 结束不自动等于任务完成。取消任务不偷偷停止进程，必要时提供明确的停止操作。
- **运行不生成任务。** 任务只能由显式任务操作创建或改变语义状态；原生运行事件更新现有执行信息。重试、恢复、换 Agent、收到同伴回复和原生 plan 变化不会新增卡片、覆盖任务定义或把任务标成完成。任务板只查询共享任务存储。
- **保持历史。** 关闭或删除 Agent 不连带删除共享任务和消息；历史保留发送者/负责人当时的显示信息。原生 Harness 的个人 plan/todo 中选定的独立工作只有显式发布后才成为共享任务，不整份同步执行步骤。

责任归属、工作状态和活动历史的分离可参考 [Linear 分配与委托](https://linear.app/docs/assigning-issues) 和 [GitHub issue timeline](https://docs.github.com/en/rest/issues/timeline)。这些模式不要求引入它们的平台。

当前代码尚没有稳定的 Project 实体。首版先支持 Workspace 任务板与负责人筛选，不拿 cwd 冒充跨机器项目 ID。任务依赖可以后加，第一步用阻塞说明即可。

## 现有代码的复用边界

- [Store](../core/src/store.rs)：已有单 Core 独占锁、SQLite WAL 和事务。新增邮箱/任务记录，沿用这些基础设施。
- [Workspace](../core/src/workspace.rs)：已有 Agent 生命周期锁、Codex 输入/Interrupt/恢复。Peer Message 的入库不能直接套用普通对话发送入口，因为它会因前一次输入结果未知而拒绝新输入。
- [Claude](../core/src/claude.rs)：普通输入仍遵守空闲边界；紧急门铃另经官方工具 hook 注入，不把流式 stdin 排队当作当前 Turn 的条件追加接口。
- 旧版邮箱设计（私有参考资料）：保留邮箱与门铃分离、幂等和不因未回复堵住发送的教训；舍弃被动观察架构带来的机制。
- 旧版任务实现（私有参考资料）：参考原子修改、活动历史和重试测试，不移植旧领域模型或三方合并框架。
- MCP 协议用[官方 Rust SDK rmcp](https://github.com/modelcontextprotocol/rust-sdk)，实施时锁定与当前两个 Harness 兼容的发布版。继续使用现有 Axum、Tokio、rusqlite 和 UI 组件；不另起消息中间件或每 Agent 一个任务服务。

MCP 的 Tasks 扩展描述长时间工具请求的执行状态；共享任务板是独立业务对象，不强行映射成该协议机制。[MCP Tasks](https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html)

## 最小实施顺序与验收

1. **先通真实消息链。** 两个隔离的 Codex/Claude Agent 配置同一个 Core MCP：发信、合并门铃、取信、回复，GUI 能看到来源与原文。首轮就加入一次 Mac mini 经 SSH 访问同一 MCP 的验证，避免把单机地址写进设计。
2. **接任务板。** GUI/MCP 建任务、领取、更新、评论、附成果；实现“交给 Agent”复用消息链。先把列表和详情做舒服，再考虑拖拽等交互。
3. **用一次真实协作收尾。** 一个 Agent 实现、另一个检查，任务和消息相互链接，重启 GUI 后仍能看懂结果。

实施验收必须包含：

- 一张任务经历多轮执行、换 Agent、原生 plan 变化和重启后仍是一张；原始运行事件不改变任务定义、语义版本或完成状态。测试检查数据库与 API，不只检查 UI 过滤。
- 一次发送多条消息只产生合并提醒；忙碌时不打断当前工作，审批仍可正常处理。
- 保存后断线或重启，消息仍可读取；同一请求重试不重复消息/任务/评论。
- 关闭与提醒同时发生，Agent 不被重新打开；删除不破坏其他 Agent 的协作历史。
- 两 Agent 抢同一任务只成功一个；人和 Agent 同时编辑时草稿保留、没有静默覆盖。
- 分配任务后，接收者能够实际取信并开始工作，而不仅是任务板上的名字变化。
- 检查自动回复循环、重复门铃与闲置模型调用；测 Core/桥接的内存增量，实验后释放进程。

自动回归覆盖任务/执行隔离、领取冲突、幂等、关闭与投递竞态、重启保留及未知输入不重放；真实验收覆盖跨 Harness 消息、任务成果和远程通道修复。未用真实运行强行制造每一种崩溃窗口，也未把自动检查替代用户的任务板阅读验收。详见 [验收记录](../acceptance/collaboration/README.md)。
