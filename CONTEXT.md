# Yuzuno Workspace

Yuzuno 管理具有稳定身份的 Agents，并让用户和 Agents 在同一个 Workspace 中协作。

## Language

**Workspace**：用户持久的工作空间，包含多个 Project、Agents、任务、消息和机器配置。身份由 `workspaceId` 表示；Core 停止时 Workspace 依然存在。

**Project（项目）**：一项长期工作的归属，例如 Yuzuno-next。它可以在不同机器上有各自的默认目录；默认目录只用来预填新 Agent 的工作目录，不限制 Agent 使用其他目录（例如外部 worktree）。切换 Project 只改变界面显示范围，不切换 Core、数据库或 Workspace。

**Project Membership（项目归属）**：Agent 或任务属于哪个 Project 的明确记录，每项最多属于一个 Project，也可以不属于任何 Project。归属由用户或 Agent 明确指定，不根据目录推断；更改归属不改变 Agent 的工作目录、会话或已读状态。跨项目的 Agent 仍可互发消息、接受指派，任务编号在整个 Workspace 统一。

**Machine（机器）**：Agent 的执行环境，例如 Core 所在主机或通过 SSH 登记的 Mac mini；可以被多个 Project 使用。工作目录、CLI 登录和运行时都属于所在机器。

**Core**：管理 Workspace 的服务；重启 Core 不改变 Workspace 身份。

**Client（客户端）**：连接 Core 的桌面窗口或浏览器，只负责显示，不是 Machine。

**Workspace Agent**：用户命名、可以持续工作的协作者。身份在关闭、重开和恢复原生会话后保留；名称用于展示，身份不随名称变化。

**Harness Session**：Codex 或 Claude 保存的原生对话与执行上下文。它属于 Workspace Agent 的执行经历，不是 Agent 身份本身。

**Peer Message**：一个协作者发给另一个协作者的持久消息，可以关联任务、回复和成果。发送者是实际发起消息的协作者。

**Message Priority（消息优先级）**：普通消息在当前工作轮次结束后提醒；紧急消息在原生执行允许的最近机会提醒。两者都通过门铃通知，优先级不改变消息作者的权限。

**System Notification（系统通知）**：Core 对其负责的操作结果发出的持久消息，作者是 Core，而不是用户、发起 Agent 或评审模型。通知已入箱或已投递，不代表接收者已处理。

**Mailbox**：某个 Agent 可以读取和回溯的同伴消息和系统通知集合。用户查看消息和 Agent 获取消息是不同的阅读行为。

**Doorbell（门铃）**：提醒 Agent 有新消息可取的简短通知。多条消息可以共用一次门铃，正文仍属于邮箱。

**Notification Delivery（通知投递）**：按消息优先级将门铃交给正在工作的 Agent 或唤起空闲 Agent。通知进入执行上下文与 Agent 实际取信是不同事实；通知不会替用户批准操作，也不代表收件者已理解或完成消息中的请求。

**Shared Task**：Workspace 中一个有独立目标、可以交接和结束的工作项。标题和说明表达要做成什么；同一项工作可以跨多个 Agent、Turn 或 Session，身份保持不变。

**Task Reference（任务编号）**：用户和 Agents 共同引用任务的稳定短编号，例如 `T-42`。它在 Workspace 内唯一，不因排序、负责人或状态变化而改变，任务归档后也不复用。

**Task Definition（任务定义）**：任务的标题与说明，表达预期结果、范围和必要的完成条件。它与随执行变化的进展、阻碍和交付结果分别表达。

**Task Execution（任务执行）**：Agent 为完成某项任务进行的实际工作，可包含多次 Turn。一次执行结束、失败或重启，不等于任务已经完成、取消或变成另一项任务。

**Task Result（任务结果）**：针对任务目标提交的实际结论或交付物，包含结果摘要和可用的查看入口。结果保留报告者；Agent 声明完成与用户验收分别表达。

**Review Run（评审执行）**：针对固定代码版本的一次独立评审工作，有自身身份和报告，可关联任务及外部 PR。报告生成成功、评审结论、检查结果和任务完成是分别表达的事实。

**PR Operation（PR 操作）**：一次明确请求的 PR 创建或更新工作，有持久身份和可核对结果。远端 PR 的结果与任务关联的结果分别记录；操作结束不代表评审、合并或任务完成。

**Assignee（负责人）**：当前承担任务责任的 Agent。责任归属与 Agent 此刻是否正在执行分别记录。

**Claim（领取）**：Agent 接下一个尚未分配任务的行为。同一任务不能同时被两个 Agent 成功领取。

**Task Activity（任务活动）**：围绕任务发生的修改、评论和成果记录，保留行为来源及先后关系。执行中的工具调用和原生步骤属于关联执行的过程。

**Home（首页）**：用户不读会话也能一眼掌握所有 Project 现状并直接做出决定的页面，取代 Catch Up。各 Project 按 Project Priority 排列，机器负载等跨 Project 的内容以全局 Widget 呈现。
_Avoid_：Catch Up、dashboard、portal、attention portal

**Project Priority（项目优先级）**：用户为 Project 设定的先后次序，决定它在 Home 上的位置和可占的展示份量。它只是用户的显示偏好，不影响 Agent 的工作调度，也不会因 Agent 的内容而改变。

**Project Brief（项目简报）**：每个 Project 唯一一份、由该 Project 的 Agents 共同持续维护的文档，表达用户需要知道和决定的事。内容由 Agents 撰写，大小和排版由 Yuzuno 决定。它不替代会话，会话仍是完整的工作记录。
_Avoid_：card、dashboard、summary

**Section（节）**：Project Brief 中按主题划分的单元，有稳定的主题标识、种类和 Section Owner，可附带 Section Attachment。同一主题只有一节；其他 Agent 要补充时，在该主题下挂子主题，与父节一起呈现。种类有三种：**ask**（需要用户做出具体决定，必须写明问题，owner 标记解决后才离开）、**report**（已有结论，用户看过后收入历史）、**status**（长期状态，一直保留并显示数据截至时间）。

**Section Owner（节负责人）**：创建某节、也是唯一有权修改它的 Agent；用户对该节的回复默认发给它。owner 被关闭或删除时，归属转给 Brief Steward；没有 Brief Steward 时，由项目内的 Agent 领取。
_Avoid_：author、最后作者

**Brief Steward（简报管理者）**：Project 可以选择指定的一个 Agent，有权合并、拆分和重组其他 Agents 写的 Section，并在 Section Owner 离开时接管其节。

**Seen（看过）**：用户在 Home 上明确标记已看到某节当前版本（或整份 Project Brief）的行为。不根据停留时间推断，与会话的已读分别记录；之后又有变化的节会再次提示。

**Section Attachment（附件）**：Agent 明确附在节上的链接或文件。小文件在写入时保存快照，内容固定为当时的版本；大文件和目录只引用位置，内容可能已经变化。
_Avoid_：Artifact（指会话侧栏中自动发现的文件）

**Live Reference（活引用）**：Section 中对 Core 所管对象的引用，例如任务、PR、CI run、Job、Review Run、Agent 或 Machine。Yuzuno 按对象的当前状态渲染它，Agent 不抄写可能过时的状态。

**Status Feeder（状态采集脚本）**：status 节登记的、不调用 LLM 的数据脚本。经用户批准后由 Yuzuno 定期运行，只更新该节的数据；文字和排版仍由 Agent 撰写。

**Widget**：Home 上由 Yuzuno 根据 Core 掌握的事实渲染的区块，例如机器负载、Jobs、Agent 状态、repo 变化和待处理的审批，不由 Agent 撰写。

**Machine Load（机器负载）**：Machine 的 CPU、内存和 GPU 使用情况，分为 Yuzuno 所用（其 Agents 与 Jobs）和其他来源两部分。Machine 可以开启持续记录，供以后在其他来源负载高时暂缓 Yuzuno 的 Jobs。
