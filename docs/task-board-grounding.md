# 让任务板表达工作目标

本分支负责 Peer Message 与任务板 MCP。实现前先确定：看板上的每张卡表示一件要做成的工作；Agent 的执行过程通过稳定关联进入详情。Yuzuno next 掌管 Harness，可以在发起工作时直接记录关联，不需要事后猜任务身份。

工作目录：`/home/developer/yuzuno-next-collaboration`；分支：`feat/collaboration-mcp`；起点：`dc7752d`。这份调研先于实现提交。随后在独立 Core 完成实现和真实 Harness 验收，未修改日用 Core；见 [验收记录](../acceptance/collaboration/README.md)。

## 任务与执行混在一起会怎样

以一个合成例子说明：用户创建一项工作，Agent 为它运行多轮。如果每轮结束都自动生成一张 Done 卡，任务板就会被执行结果占满，用户很难找到原来的工作目标。仅在界面隐藏这些卡片，不能消除底层身份混用。

因此本版为共享任务设置显式创建的独立存储，把 Turn 作为有关联的执行记录。卡片需要成果和阻碍摘要，详情保留活动与原始证据。这个例子解释设计选择，不是对其他私有项目记录的公开复述，也不声称本次读取过生产数据库。

## 业界怎样分开任务与执行

| 参考 | 文档或源码中的对象 | 借鉴到 Yuzuno |
| --- | --- | --- |
| [Linear Agent interaction](https://linear.app/developers/agent-interaction) | Issue 与 AgentSession 分开；Session 有自己的运行状态、AgentActivity 和可变化的 plan | 执行、工具与步骤有自己的位置，一项工作可以关联多轮执行；不把原生 plan 当共享任务列表 |
| [GitHub Copilot 后续执行](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github#tracking-and-continuing-a-session) | 在同一个 PR 上通过后续反馈开启新 session，继续更新原成果 | 返工、复查和恢复围绕原任务发生，不随 session 数量增加卡片 |
| [GitHub 检查交付](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/review-copilot-output) | Agent 完成工作后请求 review；Issue 可以通过关联 PR 的合并完成闭环 | 明确交付结果与查看入口；执行结束本身不能证明用户目标已达到 |
| [OpenProject WorkPackage schema](https://github.com/opf/openproject/blob/dev/docs/api/apiv3/components/schemas/work_package_model.yml)、[Journal 模型](https://github.com/opf/openproject/blob/dev/app/models/journal.rb) | 工作项自身有 subject、description、状态、负责人和关系，评论/变更另属 Journal | 稳定任务定义、最新进展、交付结果和活动历史分别保存与展示 |

这里借鉴产品与数据模型，不引入以上服务或 SDK。Linear 的 Agent API/plan 功能仍有预览标记，不作为 Yuzuno 的外部协议依赖。

[Linear 创建 Issue](https://linear.app/docs/creating-issues) 只要求标题和状态；[OpenProject 看板](https://www.openproject.org/docs/user-guide/agile-boards/) 允许输入标题后直接创建。任务可读性不靠更多必填字段获得。Yuzuno 不增加必填 purpose、objective 或验收表单，状态有默认值，说明按需要填写。

## 本分支采用的具体规则

以下是结合行业实现与 Yuzuno 使用方式作出的产品决定，不声称业界工具能自动保证所有标题的语义质量。

1. **只有任务命令创建工作项。** GUI 新建、从用户请求创建，或 Agent 显式调用创建工具可以产生任务。Harness 的 start/completed/error、工具调用、plan、peer reply、resume 不创建任务。任务表与现有运行日志分开，列表从任务表读取。
2. **任务定义保持稳定。** 标题说明目标，description 说明范围与完成条件。进度、阻碍和结果是独立内容；日志不能覆盖标题/说明，运行事件也不推进任务的语义版本、更新时间或看板排序。
3. **执行关联由 Core 建立。** “交给 Agent”“继续此任务”携带已有 taskId，Core 将本次输入、Agent 与原生 Turn/Session 关联。一个任务可关联多个 Agent、多轮执行；关联精确到本次工作，不能用 Agent 身份或整个 Session 代替 taskId。同一轮处理多封信时可关联多个任务，关联来自具体消息或任务操作；普通聊天可以没有 taskId，也不继承上一次任务。
4. **重试与返工更新原卡。** 更新工具优先使用既有 taskId；幂等键防止网络重试重复创建。只有新的独立目标才创建另一项任务。独立交付且可分别分配的部分可以是子任务，执行步骤留在原生 plan；首版无需为此实现层级和父子状态传播。
5. **运行状态与任务状态分别呈现。** Working、等待输入和运行失败来自已掌握的 Harness 状态；待办、进行中、受阻、待检查、完成、取消是工作项状态。原始运行事件不自动完成任务；显式“开始此任务”可以同步把任务改为进行中，这属于任务命令。
6. **交付有内容与来源。** Agent 完成工作时通过任务操作给出简短结果，并尽可能附原始回复、文件、Diff 或报告。需要检查时进入待检查；明确完成时保留报告者，用户验收另有来源。GUI 手动改状态仍保持简单，不要求每张卡都走审批流程。
7. **工具说明与返回值引导真实工作。** 创建工具说明给出目标式标题示例；读取工具返回任务定义、现有进展和成果，提醒继续更新同一项工作。进展用评论/进度操作，成果用结果操作，不用“把当前日志整段写回 description”代替更新。来源与执行关联由 Core 补，不让模型维护 PID 等运行元数据。
8. **按结果判断粒度。** 不用“标题包含运行/检查/研究就拒绝”的关键词规则；验证和调研同样可以有独立交付。不另起 LLM 来审批每次建卡，不靠新的 Observer 修正所有坏标题。
9. **提供可直接使用的短编号。** 用户指出旧版的长 UUID 曾让 Agent 另起编号系统。任务公开 `id` 统一为稳定 `T-N`，工具直接接受它，消息与看板也使用同一编号；不是仅在 UI 添加别名。内部 UUID 兼容历史请求，旧回执也返回规范短号，归档或排序不会重排、复用编号。

`SharedTask`、追加的 `TaskActivity`、已有执行的关联足以承载这些规则。继续使用现有 Harness 生命周期与日志；“任务执行”不意味着再建一个 Runtime 或调度引擎。首版沿用现有 Workspace 范围，稳定 Project 模型未实现前不以 cwd 冒充跨机器项目身份。

短编号的作用域在追加调研后确认为整个 Workspace，用户已同意。业界有多种成熟做法：[Linear](https://linear.app/developers/graphql) 用团队短编号并在 API 同时接受 UUID，[GitHub](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls) 用仓库内 `#123` 和跨仓库完整引用；[Azure Boards](https://learn.microsoft.com/en-us/azure/devops/boards/work-items/about-work-items?view=azure-devops) 在 organization/project collection 内统一编号，团队归属由 Area Path 表达；[Google Issue Tracker](https://developers.google.com/issue-tracker/references/glossary-of-fields) 也把数字 ID 与 Component 分开。Yuzuno 选择 Workspace 统一 `T-N`，机器、Agent、项目不各自起号，项目归属不改变编号。内部仍以 UUID 关联；未来独立 Workspace 之间引用或导入时，需要包含来源 Workspace 的完整引用/链接与冲突处理，不能把裸 `T-N` 当跨 Workspace 全局身份。当前尚未实现跨 Workspace 功能。

## 一眼能读懂的卡片

卡片优先展示：稳定标题、任务状态、负责人；必要时补一行阻碍或交付摘要和成果入口。运行中的小标记可以辅助识别，但不会取代任务状态。项目只在有明确项目关联时展示；缺信息直接省略，不显示一排空字段。

示意内容，不代表已经执行完成：

> **文件预览支持行号跳转和越界提示**  
> 待检查 · Dev 1  
> 已补定位与越界提示；请检查 20px 字体下的提示位置。  
> 查看成果 · 查看相关对话

不把版本号、PID、工具计数、运行时长或最近一条 shell 命令作为卡片正文。点开先看任务定义、结果和待处理事项，再看讨论/修改，最后进入原始执行。

| 应留在过程中的内容 | 可独立交接的任务示例 |
| --- | --- |
| Dev 2 正在读取 remote.rs | SSH 断线后重新连接原 Agent 会话 |
| 第 6 次运行 npm test | 修复预览边界错误，并验证原会话不丢失 |
| 浏览 Claude SDK 类型 | 确认 Claude 模型目录接口，并提交验证结论 |
| 调用 17 个工具、完成 3 步 | 点击 Catch-up 摘要能定位到原始回复 |

上表按本次工作上下文区分粒度，不是禁止单独建测试或调研任务。例如“审查消息投递实现并提交按严重性排序的问题清单”有独立交付，适合作为任务。[Atlassian 验收条件](https://www.atlassian.com/work-management/project-management/acceptance-criteria) 可作为可验证结果的写作参考；[Linear 子任务](https://linear.app/docs/parent-and-sub-issues) 可作为拆分工作的参考。

## 写功能前固定的回归场景

| 场景 | 必须观察到的结果 |
| --- | --- |
| 创建一项任务后，回放 50 轮 start/tool/plan/completed/error/interrupt/reconnect 事件 | 数据库/API 仍只有原任务；标题、说明、任务状态和语义版本不因这些原始事件改变，关联执行可增长 |
| 一个目标经 Codex 实现、Claude 检查、用户指出问题、修正与 WSL 恢复 | 始终使用同一个 taskId；结果与重要进展可更新，任务身份不变 |
| 两个原生 plan 各产生 10 步，全部 completed | 不增加任务卡，也不把原任务自动标成完成 |
| 大量日志持续更新 | 卡片标题/说明/业务排序保持稳定，Working 能正常反映执行状态 |
| 运行正常结束但没有提交成果 | 不自动显示 Done；用户能进入原始回复查看，结果与验收未知就保持未知 |
| 明确提交结果或改变任务状态 | 显示报告者和成果入口；需要检查的工作可以留在待检查 |
| Task MCP 请求重试、Core 重启、Agent 换名/关闭/删除 | 不复制或连带删除任务；历史来源与执行关联仍可辨识 |
| 明确出现另一个可独立交付的目标 | 显式创建第二项任务；不会禁止正常拆分或把所有工作塞在一张卡中 |

阅读验收使用一组真实任务：不打开日志，用户能在约 30 秒内指出每项工作要做成什么、谁负责、哪些被阻塞/等待检查，以及成果入口。读不懂时修正卡片内容与信息顺序，而不以 CRUD 测试通过替代产品验收。

实施后的自动回归已验证 50 轮原生事件/plan 不增加任务、不更改任务定义或状态；真实 Codex/Claude/Mac mini 的多轮协作保持同一个 taskId，结果可跳转原始 Turn。实际 WSL 重启及长期任务的 30 秒阅读效果仍需后续日用验证，不能用模拟 Store 重开替代。本次把结构性保证与语义质量分开：运行事件污染任务存储可以用写入边界和回归测试杜绝；Agent 主动写出含糊任务仍需工具设计、可编辑内容和真实使用来改善，不能宣称一个 schema 会理解所有工作目标。
