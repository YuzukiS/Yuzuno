# Home V1：设计

状态：设计已经用户确认（2026-10-16），切片 1 已登记为低优先级 **T-85**，尚未派工或实现；两个现存兼容问题分别登记为 **T-86 / T-87**。本批不作为当前 `core.7` 发布前置。术语以 [CONTEXT.md](../CONTEXT.md) 为准，架构决定见 [ADR 0001](adr/0001-project-brief-leaves-the-conversation.md)。下文原有代码位置来自调研时的 main `68ccf06`，开工时需按实际版本重新核对。

## 目标

用户同时管理多个 Project 和多个 Agent，已经无法逐个巡视会话。Home 让用户不读会话也能理解每个 Project 的现状、做出决定，并直接回复 Agent。

Home 的内容分两类：
- **Widget**：Yuzuno 根据 Core 掌握的事实渲染。
- **Project Brief**：由各 Project 的 Agents 撰写和维护，排版由 Yuzuno 决定。

## Home 的构成

- **取代 Catch Up**，沿用它的入口。
- **全局"需要你"条**位于顶部，汇总所有 Project 的 Core 审批和 ask 节，先按 Project Priority、再按等待时长排序，点击后跳到对应位置。它只汇总，不改变各项目面板的顺序。
- **Machines Widget** 是全局的，显示 Machine Load 和所有 Jobs，并标明每个 Job 来自哪个 Project 和 Agent。Job 本身没有 Project 字段，需要经由它的任务推出。
- **每个 Project 一个面板**，按用户设定的 Project Priority 排列：
  - 排名决定先后和尺寸上限。实际大小和排版由 Yuzuno 根据 Brief 的结构在上限内决定；Agent 只写内容，不能提示尺寸。
  - 自上次看过以来没有变化的项目收成一行。用户手动展开或收起后，Yuzuno 会记住。
  - 新内容到来时，已有的块不移动。
  - 面板头部是 Core Widget：
    - 该项目 Agents 的状态计数（工作中、空闲、等待、出错）
    - 该项目的 Jobs
    - repo 变化：通过 GitHub API 读取已关联仓库的最近提交、PR 和 CI；没有关联仓库的项目不显示这一块
    - 待处理的审批和提问，可以直接在这里批准、拒绝或回答
    - Agent 报错
  - 面板主体是该项目的 Project Brief。
  - 项目头部不列出旧 Catch Up 的“未读的已结束回合”，也不提取最终回答兜底；会话自己的未读标记和完整记录仍保留。

## Project Brief

- **Section**：按主题 key 划分，每节有一个种类（ask / report / status）和一个 Section Owner。
  - **ask**：必须写明问题，并给出至少一个选项或明确的回复要求，否则拒收。只有 owner 把它标为已解决时才离开。用户回复后，它离开 Needs you，紧凑显示为"已回复 · 等待 owner"，原问题收在可展开处。owner 在 brief_get 的 you.repliedAsks 里看到它，处理完再 resolve：偏好或信息类收到即可关闭，执行类在授权动作确认完成、结果写入任务或 Brief 后才关闭；处理中或失败时保持已回复，只更新进度。若 owner 重新 put，就是再次提问。还没回复的 ask，用户可以把它延后到某个时间。
  - **report**：用户标记看过后收入历史，历史保留 30 天。
  - **status**：一直保留，显示"数据截至"时间。超过该节声明的有效期后变灰。目标是由 Status Feeder 刷新，见切片 3。
- **Owner 规则**：
  - 只有 owner 能修改自己的节。
  - 其他 Agent 要补充时，在该主题下挂子主题（例如 `round-12/review`），Yuzuno 把父节和子节合并显示，并分别标明作者。
  - owner 被关闭或删除时，归属转给 Brief Steward；没有 Steward 时，由项目内的 Agent 领取。
- **Brief Steward**：可选设置，被指定的 Agent 可以合并、拆分和重组别人的节。
- **Seen**：只能由用户明确标记，可以逐节标记，也可以一键标记"本项目全部看过"。记录用户实际标记的版本，不根据停留时间推断，与会话的已读分别记录。标记过程中到达的新版本仍未看过；之后又有变化的节会高亮。

## Agent 的写入流程

工具（yuzuno MCP）：
- `brief_get`：返回 Brief 的当前版本和版本号。
- `brief_update`：必须带上读取时得到的版本号。版本过期时拒收，并在拒收结果里附上最新内容。没有变化时，显式提交"无变化"。
  - 加上 `validateOnly:true` 只做检查（T-176）。检查与正式调用相同，同一输入得到同样的 problems。什么都不写：不记 requestId、不复制附件、不算本回合的更新，也不预留版本。检查在第一个出问题的步骤停下。`checkedAll` 说明这次检查有没有走完：为 false 时，后面的检查没有执行，列出的问题也可能不全，但这不表示知道还有几条。
  - 被接受的更新和有效的预览，可以带至多 3 条不阻断的 `advice`。advice 只针对本次发送的正文，edit 只针对它替换的块，只看 report 和 status 节。
  - advice 是按长度和数量给出的启发式，可以调整，阈值只在 contract 的 `limits.advice`。它不是可读性评分，也不是验收的硬限制：不截断、不拒收、不改写。
  - 拒收的问题每节至多 5 条（Node 校验器），整次调用至多 10 条（Core）。`moreProblems` 只给 Core 确知省略的条数；Node 每节超出的部分不计数，也不估计。
- `brief_guide`：详细指南和示例，内容从组件 catalog 自动生成。

规则：
- **只强制能机械判定的规则**：schema、ask 节是否写明问题、各项上限、版本号、owner 规则。内容是否相关、是否重复、写得好不好，由 Agents 和 Brief Steward 负责。Yuzuno 不做语义判断，也不从会话里事后推导 Brief 的内容。
- **回合末检查**：属于某个 Project 的 Agent，每个回合都应有一次被 Core 接受的 `brief_update`（包括有效的"无变化"）。不属于任何 Project 的 Agent 不检查。回执绑定 Agent、Project 和 Turn；版本冲突、schema 拒收、越权或仅观察到调用尝试不算完成。
  - Claude：在 bridge 里加一个 SDK `Stop` 回调。如果本回合没有成功提交，就返回 `decision:"block"` 并附上原因，用 `stop_hook_active` 保证每个回合最多强制续一次。现有的 hook 回调在 `runtimes/claude/bridge.mjs:371-379`。bridge 只在原生的 `result` 帧结束一个 Turn（`bridge.mjs:717-800`），所以续写仍在同一个 `turnId` 内。成功标记须来自 Core 接受回执；仅看到 `tool_use` 帧不足以证明更新成功。
  - Codex：Codex 的 hook 必须写入用户配置并通过信任才能运行，Core 不写这些配置。所以检查在 Core 侧做：回合结束时如果没有成功提交，就补一个提醒回合。
    - 复用邮箱唤醒的路径（`core/src/collaboration_runtime.rs:510-548`），但使用独立的额度，不占邮箱的 6 次/10 分钟（`:408-415`）。
    - 被中断或失败的回合、提醒回合本身都不再触发提醒。
    - 提醒回合在会话里显示成 Yuzuno 提醒卡。
  - 一次有界补救仍可能失败或被中断；此时保留未完成更新的事实，不无限续写，也不让 Core 代写摘要。检查不保证内容相关、完整或正确；上述原生 hook 和恢复行为仍需实测。
- **Brief 的更新不改变 Agent 的最终回答**。工具调用在会话里折叠显示，不完全隐藏。
- **规则送达分四层**：
  1. **硬规则**，控制在 2048 个字符以内，最重要的写在最前面：
     - Claude：写进 bridge 追加的 system prompt，同时写进 MCP server instructions。两者都会一直加载，压缩后会重新宣告。
     - Codex：写进 `developerInstructions` 和 server instructions。**恢复会话时也要重新发送 `developerInstructions`**。目前 `core/src/workspace.rs:1794` 在恢复时去掉了它，而压缩会按当前配置重建开头的上下文，所以 Core 重启后的第一次压缩会把规则丢掉。
  2. **免搜索加载**：Claude 给 `brief_get` / `brief_update` 加上 `_meta["anthropic/alwaysLoad"]`。Codex 不把全部 39 个 yuzuno 工具预先加载，而是在硬规则里写明准确的工具名，让 Agent 去搜索。
  3. **遗漏由回合末检查发现并有界补救**，不只依赖文字提示，也不把一次提醒当作更新必然成功的保证。
  4. **详细内容放在 `brief_guide`**，硬规则写明它的名字，拒收理由指向指南里的相应部分。仓库里的 yuzuno skill 只放一个链接。Skill 和插件分发（Claude SDK 的 `plugins`、Codex 的 `skills/extraRoots/set`）需要在每台远程机器上放文件，切片 1 不做。
- **命名冲突**：`core/src/store.rs:205` 已有一个 `store::Brief`，指的是 Agent 的缓存摘要。实现时要避免撞名。

## 内容与渲染

- **格式**：保留 T-8 的 json-render catalog 和校验器（`web/src/intelligent-ui/contract.ts`、`runtimes/result-validator/`），扩展为不绑定 Turn 的 Section。拒收结果写成 Agent 可以直接照着改的问题列表，沿用 `result_publish` 的做法。
- **借鉴 OpenUI 的思路，但不引入它的依赖**：
  - Agent 的指南从组件库自动生成。
  - 选项按钮只发出一条预填好的消息。
  - 错误提示写给模型看。
- **不支持流式生成**。生成中逐节展开的动画放在切片 3。
- **切片 1 支持的内容**：
  - 内联内容：
    - Markdown 正文，含代码块和日志摘录（现在的 Text 只支持 2000 字的纯文本）
    - 数学公式（KaTeX）
    - 清单和计划
    - 意见条目（来源加严重度）
    - 指标（带单位，以及相对上一版的变化）
    - 表格
    - 折线图、柱状图、散点图：数据可以内联，也可以读取数据附件；读附件时降采样后渲染
  - Live Reference：任务、PR、CI run、Job、Review Run、Agent、Machine，由 Yuzuno 按当前状态渲染。
  - Section Attachment：图片、数据文件（CSV / JSON / JSONL）、PDF、日志和文本（预览最后 200 行）、外部链接（只显示为链接，不内嵌外部网站）。
  - ask 节里的交互：选项按钮、自由文本、小表单（复用 T-8 的 Clarification）、两个方案二选一。
  - 时间信息：数据截至、截止时间或预计完成时间、预计下次更新时间。
- **往后放的**：热力图和直方图、Diff 视图、进度和时间线组件、沙箱 HTML 报告、视频和音频、Notebook。

### 上限

| 范围 | 上限 |
|---|---|
| 每份 Brief | 最多 12 个顶层主题，每个主题最多 4 个子主题；每个 Agent 同时最多 3 个未解决的 ask 节；看过的 report 在历史里保留 30 天 |
| 每节的内联内容 | 合计不超过 64 KB，与 `result_publish` 的 `MAX_SPEC_BYTES` 一致 |
| 单个块 | 代码块和日志摘录 ≤ 200 行；内联表格 ≤ 200 行；内联图表 ≤ 500 个点；清单和意见条目各 ≤ 30 条；活引用每节 ≤ 50 个。超出时，拒收理由会告诉 Agent 改用附件 |
| 附件 | 单个文件 25 MB 以内保存快照，超过的只引用；每节最多 12 个；每份 Brief 的快照总量上限 1 GB，超出时先清理历史里最旧的快照；设置里可以手动清理缓存 |
| 图表数据 | 图表只能读取已保存快照的数据文件；每条曲线降采样到 5000 个点以内，每张图最多 12 条曲线 |
| ask 表单 | 沿用 Clarification 的上限：1–8 个字段，每个字段 2–12 个选项 |

快照和引用的区别：小文件在写入时保存快照，内容固定为当时的版本；大文件和目录只引用位置，并标注"可能已变化"。图表只能读快照，这样数据文件被下一轮实验覆盖后，图和结论仍然对得上。

## 回复与审批

- **回复方式**：自由文本，或 ask 节声明的选项按钮。两者都只生成一条用户消息，发给该节的 owner，消息里引用这一节。项目级的自由回复，设了 Steward 就发给 Steward，否则由用户在项目的 Agent 里选。任何情况下都可以手动改发给其他 Agent。
- **Agent 正忙时**，效果和在会话输入框里发送完全一样。现有的发送 hook 绑定在当前选中的 Agent 上（`web/src/useConversationSend.ts:87-131`），Home 需要自己的发送路径，自行处理 `clientMessageId` 和 `expectedTurnId`。接口是 `POST /api/agents/{id}/messages`（`core/src/server.rs:579`）。
- **Agent 写的内容永远不能直接执行操作**，例如合并、部署或批准。
- **Core 审批**：在 Home 上直接调用 `POST /api/requests/{id}/respond`（`core/src/server.rs:104,632`）。现在审批卡片 `PendingCard`（`web/src/components.tsx:851-1106`）只挂在会话里。

## Machine Load

- **目标**：所有 Machine 都通过 SSH 采样，GPU 也采。当前连接的机器有 WSL 本机（RTX 5090，`nvidia-smi` 可用）、Mac mini 和 远端 Linux 主机（WSL 可以直接 SSH）。
  - Mac mini 的 GPU 打算用 `ioreg` 读取，有待验证。
  - 远端 Linux 主机 上，GPU 按卡显示占用率、显存，以及占用它的用户和进程。
- **区分来源**：其他来源的负载 = 机器总负载 − Yuzuno 的 Agents 和 Jobs 所用的部分。
- **采样**：Home 打开时每 2 秒一次。开启了"持续记录"的机器，即使 Home 没打开也每 30 秒一次。"持续记录"按机器单独开关，供以后在其他来源负载高时暂缓 Yuzuno 的 Jobs。
- **保留**：原始数据保留 7 天，之后降采样到每 5 分钟一个点，保留 90 天。
- **现状**：Core 不采集任何负载数据。只有 `core/src/jobs/host.rs:120-150` 在需要时读取本机的内存和 CPU 数量。Jobs 只能在本机运行（`core/src/jobs/store.rs:258`）。日常使用的 Core 目前只登记了本机这一台 Machine。

## 切片

1. **Brief 端到端，加上本机的 Machine Load**：
   - Home 取代 Catch Up
   - Brief 的存储、`brief_get` / `brief_update` / `brief_guide`、校验和上限
   - 回合末检查：Claude 用 Stop hook，Codex 用提醒回合（T-154 起不再要求编辑者每轮更新 Brief，这项检查不再拦截或提醒）
   - 规则送达，按上面的四层
   - 全局"需要你"条，以及按 Project Priority 排列的面板和 Core Widget
   - Seen、两种回复、在 Home 上处理审批
   - 没有 Steward 时，关闭或删除 owner 后保留原节和待办，由同 Project Agent 原子领取；并发领取与旧 owner 的过期写入不会越权
   - 本机附件快照和清理缓存
   - 本机的 CPU、内存、GPU 和 Jobs
2. **远程机器**：Mac mini 和 远端 Linux 主机 的 SSH 采样、持续记录，以及远程附件快照（在发布那一刻通过 SSH 拷回）。
3. **其余**：
   - Status Feeder：不调用 LLM 的数据脚本，用户首次登记时批准，由 Yuzuno 作为 Job 定期运行，只更新该节的数据
   - Brief Steward
   - 换用 Codex 原生 Stop hook：需要用户同意写入一次信任配置
   - 生成中逐节展开的动画

## 切片 1 的验收

- 用全新的 worktree 构建，起一个独立端口、独立数据的实验 Core。不碰日常使用的 4317，也不修改现有 Agent。
- 重活全部走 Yuzuno Jobs。
- 用**真实的原生 Agent** 跑两个 Project：
  - 一个代码类项目，Claude 和 Codex 各一个 Agent。
  - 一个研究类项目，产出一份实验结果：主曲线用 Yuzuno 的折线图从数据附件读取，样本网格之类用图片附件。
- 要验证的内容：
  - 正常回合有 Core 接受的 Brief 更新或有效"无变化"，拒收的调用不计完成，旧回合的回执不能抵扣新回合。
  - 故意不调用时，回合末检查会触发：Claude 在同一回合内补上，Codex 出现提醒回合，并且两者都不会循环。
  - 拒收后修正成功，以及补救仍失败或被中断的情形均有真实证据；后者如实保留未更新状态，提醒和 Core 重启不造成重复续写。
  - 用旧版本号写入会被拒收；修改别人的节会被拒收；超过上限会被拒收，并且拒收理由可以照着改。
  - 从 Home 回复能到达 owner；ask 节进入"已回复"状态，只有 owner 明确解决才离开。owner 关闭后同 Project 的领取不会丢失待办或发生双重归属。
  - 在 Home 上批准审批能生效。
  - 调整 Project Priority 后布局保持稳定，新内容不会挤动已有的块。
  - 规则在压缩后仍然存在：Claude 要测；Codex 要测 Core 重启、恢复会话再压缩的情况。
  - 浅色/深色、窄屏都正常。
- 只用 fixture 跑通不算验收。

## 需要在实验中证实的假设

- Claude 2.1.280 下，在 bridge 里加的 `Stop` 回调能阻止回合结束；拦截原因在 UI 里不可见，只能看到续写的工作。
- Claude 2.1.280 会遵守 `_meta["anthropic/alwaysLoad"]`。
- Codex 恢复会话时重新发送 `developerInstructions` 不会造成重复，并且压缩后规则仍然存在。
- 用 `ioreg` 能在不需要 sudo 的情况下读到 Mac mini 的 GPU 占用。
- 每个回合多一次很小的工具调用，成本可以接受。

## 已登记给 Lead 的现存问题

- **T-86：`result_publish` 的描述被截断（低优先级）**。本地生成描述为 3250 字符 / 3260 UTF-8 字节；实际 CLI 2.1.280 的内嵌实现默认把 MCP 工具描述和 server instructions 截到 2048，并支持环境变量覆盖。当前 shell 未设置覆盖项，截点在 Table 规格中间；BarChart、Sources、Continue 和末尾约束位于其后。Clarification 的主体说明在截点前，并非全部丢失。已核对静态实现，未抓取活动 Agent 的实际模型请求；修复验收须验证真实可见内容和完整指南获取路径。
- **T-87：Claude SDK / CLI 兼容策略与实际版本诊断（低优先级）**。SDK 为 0.3.296，随附 manifest 标记 CLI 2.1.296；bridge 显式选择 PATH 的可执行文件，当前 `--version` 为 2.1.280。版本差异已确认，但不据此断言必须严格同版本；任务应明确并验证支持组合、有效路径和不足时的处理，不自动升级用户 CLI。原调研关于 2.1.295 / 2.1.296 放宽截断的说法仍需独立核实。

## 立项决定与排期

- 项目头部不显示旧 Catch Up 的“未读的已结束回合”。项目结论归 Brief，会话未读留在会话；这依据内容职责，不依据“回合末检查保证 Brief 一定更新”。Core 仍展示审批、报错、Jobs 等它真实掌握的状态。
- T-85 只安排切片 1，切片 2、3 保持以上后续路线。本次三卡均为低优先级待办，尚未派工，不打断当前 UI 与发布工作。
- 三份设计文件仍保留在 main 工作区，立项未替用户提交或推送；实施前按正式设计提交与当时的主干基线固定材料。
