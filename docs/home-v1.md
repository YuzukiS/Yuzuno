# Home V1：设计

状态：设计已经用户确认（2026-10-16），切片 1 已登记为低优先级 **T-85**，尚未派工或实现；两个现存兼容问题分别登记为 **T-86 / T-87**。本批不作为当前 `core.7` 发布前置。术语以 [CONTEXT.md](../CONTEXT.md) 为准，架构决定见 [ADR 0001](adr/0001-project-brief-leaves-the-conversation.md)。下文原有代码位置来自调研时的 main `68ccf06`，开工时需按实际版本重新核对。

## 目标

用户同时管理多个 Project 和多个 Agent，已经无法逐个巡视会话。Home 让用户不读会话也能理解每个 Project 的现状、做出决定，并直接回复 Agent。

Home 的内容分两类：
- **Widget**：Yuzuno 根据 Core 掌握的事实渲染。
- **Project Brief**：由各 Project 的 Agents 撰写和维护，排版由 Yuzuno 决定。

## Home 的构成

- **取代 Catch Up**，沿用它的入口。
- **全局 Home 和项目页**（YN-86）：全局 Home 自上而下是"需要你"、项目一览、我的组件；每个 Project 的卡片都在它自己的项目页上（从 rail 的项目名或项目一览进入，地址 `#/home?w=<ws>&p=<projectId>`，浏览器后退回到全局 Home）。两处显示的是同一批 Brief section，不复制内容。
- **需要你**位于全局 Home 顶部，汇总所有 Project 的开着的 ask 节、Core 审批、提问和用户派发的执行者事项，先按 Project Priority、再按等待时长排序。ask 和审批直接显示成卡片（和项目页上是同一张），每张标出项目，可以当场回答；在这里回答的 ask 在本次访问内留在原处，显示成已回复的卡片。提问（在会话里回答）、执行者事项和不属于任何项目的审批仍是一行链接。
- **页内跳转**（YN-86）：Home 自己的滚动区顶部常驻一条跳转栏，无论滚到哪里都能点。三个入口：等你回复的提问（只算 Needs you 里开着的 ask，再按一次到下一个；审批和问题仍在 Needs you）、最新报告（各项目 live report 里 updatedAt 最新的一张：全局 Home 上直接打开它的报告页，返回后焦点回到这个按钮；项目页上跳到它的卡片）、我的组件（按当前的显示和顺序，隐藏的不算；只在全局 Home）。只滚 Home 自己，目标停在跳转栏下方并取得焦点；减少动态效果时不做平滑滚动；新内容到来时不会自己滚动。没有可去的地方时按钮说明原因、什么都不做。报告页盖住 Home 时，跳转栏随 Home 一起隐藏。
- **Machines Widget** 是全局的，显示 Machine Load 和所有 Jobs，并标明每个 Job 来自哪个 Project 和 Agent。Job 本身没有 Project 字段，需要经由它的任务推出。
- **项目一览**：每个 Project 一张，按用户设定的 Project Priority 排列，可以调整顺序；Home 宽 900px 以上时两列。数据都来自 `/api/home` 和 Workspace 的 Agents，Agent 不必为它多写：
  - 头部：项目名、"需要你 N"（Core 的 Needs you 里这个项目的条数）、"N 条新内容"（和项目页同一个算法）。
  - 一句状态：项目负责人写的、未过期的 status 里最新一张的摘要，最多两行；没有就是最新报告的标题，都没有就写"还没有卡片"。
  - 事实行：进行中的卡片数、执行者运行和排队数（与 rail 的执行者组同一算法）、运行中和等待中的 Job、Agent 错误（都只在有时显示）。
  - 最近：最近有变化的两张卡片，没读过的带标记，点了进入项目页并定位到那张卡。
  - 没有需要你、没有新内容、没有执行者或 Job 在跑、也没有 Agent 错误的项目收成一行。整张卡可点，另有"打开项目"按钮。
- **项目页**：
  - 头部是项目名、需要你和新内容的数，以及全部已看、项目设置和刷新；下面是本项目的跳转栏和「对项目说」。
  - **对项目说**（YN-86 S3b）：左边需求单，右边对话，靠选中联动；头部的「需求单 | 两者 | 对话」切换让一边占满宽度或两边并排，按项目记在这台设备上，默认两者；主栏窄于 900px 时只有「需求单 | 对话」，先看需求单。切换时列宽按任务窗口列表 / 详情的过渡移动，收起的一列是 inert；减少动态效果时直接切换。需求单只显示前台起的标题（没有时是浅色占位）、状态（未确认送达 · 重发 / 等前台 / 进行中 / 已完成）、卡片和进度，补充和默认折叠的转交记录；原话只在对话里你的气泡中，长粘贴是会话的胶囊。对话里是前台的短回复（显示为「项目」，悬停看是谁）、你的补充和 Core 写的「已转给 …」，以及 Core 的「需要你选一个 · 去回答 / 做完了 · 看结果」行；前台还没处理时只显示「正在看」。输入框是 Home 的回复框，上限同 Home 回复；点需求单上的「补充」后发出的是这条需求的补充。前台在项目设置的负责人页里从已保存的负责人中选。
  - **卡片的来源和改派**（YN-86 S3b-2）：前台转交过来的卡片，在负责人那一行上方有一行浅色的「需求：<标题>」，一条需求开了几张卡时写「（共 N 张卡）」，有别的需求并入时写「另有 N 条补充需求并入」；同一任务下的子节不重复这一行。「详情」里是每条来源需求（标题、时间、「看原话 →」）、这条需求的其他卡片和这张卡的转交记录，不出现用户原话；「看原话 →」回到「对项目说」，选中并展开那张需求单，对话里那句话高亮（在全局 Home 上则打开项目页并定位到这张卡）。负责人那一行的「改派」打开一个对话框：交给项目里另一个打开着的、不是执行者的 Agent，或者选一个执行者模板重新派，可以写一句原因（≤ 120 字）；Core 先派新的，成功后才释放原来的执行者（先归档，不硬停），同一次改派重发用同一个 clientRequestId。回复按钮的提示写的是回复实际默认发给谁。需求单的卡片行和转交记录里的卡片链接：卡片在页面上就定位过去；已不在页面上（归档超过 30 天）就打开它的任务。
  - 卡片分三组："需要你"（开着的 ask、本项目的审批和执行者事项，延后的 ask 在组尾）、"进行中"、"已完成"（默认收起，含 30 天历史）。同一主题的卡片放在一起；一次访问内卡片的组和位置不变，新内容到来时已有的块不移动。
  - "团队与运行"在宽屏时放在右侧，窄屏放在卡片之后并收起：Agents 的状态计数、成员、Jobs、Agent 报错、未写 Brief 的回合、repo 变化（通过 GitHub API 读取已关联仓库的最近提交、PR 和 CI；没有关联仓库的项目不显示这一块），以及非负责人写的卡片。
  - Agent 只写内容，不能提示尺寸；卡片大小和排版由 Yuzuno 根据 Brief 的结构决定。
  - 不列出旧 Catch Up 的"未读的已结束回合"，也不提取最终回答兜底；会话自己的未读标记和完整记录仍保留。

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
- **卡片、任务与负责人**（YN-86 S2a）：一节可以是某个任务的卡片。
  - **绑定**：负责人（lead）在 `brief_update` 的 put 或 edit 里写 `task`（任务键如 `YN-90`、`T-12` 或任务 ID）。edit 可以只带 `task`、不带 `elements`。任务必须属于本 Project 且没有归档，否则以 `invalid_task` 拒收；Ask-only 成员（包括执行者）写 `task` 也以 `invalid_task` 拒收。put 不带 `task` 时保留原来的绑定，所以一节的各个版本都带着它；看过后由 owner 重写的报告也接着原来的绑定。`task: null` 解除绑定。Core 把它存在 `project_brief_sections.task_id`（任务 ID）。这一列在打开数据库时补上，已有的就不再动，所以迁移可以重复跑。之前写的节这一列为空，显示和以前一样。
  - **算出的绑定**：子主题 `T/<sub>` 自己没写 `task` 时，算作主题节 `T` 的任务。另外两种只用来显示卡片：Ask 的 gate 写了任务，或者 owner 是某任务的执行者。这两种不写进数据，也不会因此归档或授予写权限。
  - **投影**：`brief_get` 和 `/api/home` 的节，凡是某任务的卡片，多一个 `card: {task: {id, title, shortName, status, archived}, responsible}`。不是卡片的节，JSON 和以前完全一样。`responsible` 是 `{agentId, name, kind, state}` 或 null：先取该任务最新派发、还没释放的执行者，没有就取任务的 assignee，都没有就是 null。kind 是 executor、lead 或 agent。执行者的 state 取它的生命周期状态，其他 Agent 取 Agent 状态。每次读取时计算，不落库，所以同一任务换了执行者，卡片的负责人自动跟着换。
  - **执行者写子节**：卡片任务的当前执行者（最新的、还没释放的那个）可以 put、edit、patch 这张卡主题下的 report 和 status 子节，前提是主题节自己写了 `task`。子节归执行者所有，Home 上和卡片放在一起显示（`sections`，不放进 `teamSections`）。执行者在别的主题下、或已经不是当前执行者时这样写，以 `not_card_responsible` 拒收；其他 Ask-only 规则不变。子节数量仍受每个主题 4 个的上限约束。
  - **任务结束时归档**：任务进入 done 或 cancelled、或被归档的那次写入里，绑定它的节（自己的 `task`）和它们下面没有自己 `task` 的子节离开 live，进入历史，原因是 `archived`。有两种例外：用户还没在当前版本读过（Seen 或已打开）的 report 留在 live，等用户打开时顺带归档，标 Seen 时照常以 `seen` 收入历史；还没 resolve 的 Ask 留到 owner resolve。归档不改节的版本，也不改 Brief 的版本，同 Seen。只在任务刚结束那次触发：重新打开任务不会恢复已归档的卡；任务结束以后再绑定，也不会立刻归档。之后释放执行者照旧，剩下的 live 节照旧交给派发者。同一任务换执行者时任务没有结束，卡片不归档。
- **已打开**（YN-86）：报告页把一篇 live report 的某个版本完整显示出来（页面可见、正文画完）后，浏览器把这个版本记给 Core（`POST /api/projects/{id}/brief/opened`，带 Workspace、节的身份、key 和显示的版本）。Core 只记当前 Workspace 上那篇 live report 的这个版本：旧版本、更新的版本、别的节、历史里的版本都不记，也不改成当前版本；同一版本再发不变。它让这个版本不再显示"新 / 已更新"，也不再算进新内容计数（取 Seen 和已打开中较新的一个版本）；下一个版本又算新内容。它不是 Seen：报告留在原处，不收进历史，Seen 照旧提供；不改节的版本和更新时间，Ask 和任务都不变。没有 Agent 工具写它，Agent 在 brief_get 里读到的 `seen` 仍只是用户的 Seen。没记上时报告页说明原因，卡片仍是新内容，下次打开时再试。

## Agent 的写入流程

工具（yuzuno MCP）：
- `brief_get`：返回 Brief 的当前版本和版本号。
- `brief_update`：必须带上读取时得到的版本号。版本过期时拒收，并在拒收结果里附上最新内容。没有变化时，显式提交"无变化"。
  - 加上 `validateOnly:true` 只做预检查（T-176）：运行正式写入之前的全部检查，这些检查给出的 problems 与正式调用相同。什么都不写：不记 requestId、不复制附件、不算本回合的更新，也不预留版本或容量。正式调用做同样的检查，被拒时也什么都不写，所以现在就要发出的节直接发：按拒绝列出的问题改好，换一个 requestId 再发；预检查只用于暂不发出的草稿。
  - `valid` 表示这次预检查通过；`checkedAll` 只表示预检查的步骤都走完了。预检查在第一个出问题的步骤停下，所以 `checkedAll` 为 false 时，后面的检查没有执行，列出的问题也可能不全，但这不表示知道还有几条。
  - 只在写入时做的检查不在预检查之内，例如 Brief 级 1 GB 快照总量。正式写入还会针对当时的 Brief 重新检查版本、Turn 和权限，所以预检查通过后，正式写入仍可能被拒（例如 `snapshot_limit`）。
  - 被接受的更新和有效的预览，可以带至多 3 条不阻断的 `advice`。advice 只针对本次发送的正文，edit 只针对它替换的块，只看 report 和 status 节。
  - advice 是按长度和数量给出的启发式，可以调整，阈值只在 contract 的 `limits.advice`。它不是可读性评分，也不是验收的硬限制：不截断、不拒收、不改写。
  - 拒收的问题每节至多 5 条（Node 校验器），整次调用至多 10 条（Core）。`moreProblems` 只给 Core 确知省略的条数；Node 每节超出的部分不计数，也不估计。
  - **纯 Markdown 的 put**（YN-14 A3）：put 可以用 `markdown`（一段文字）代替 `body`，Core 把它包成 BriefBody 下的一个 Markdown 块 `text`，注册了附件时后面再加一个列出全部附件的 Attachments 块 `files`；`size` 给卡片大小（等于 summary {lead:"text", size}）。三种 kind 都能用（Ask 的说明、status 的状态）。存下来的是建好的正文，以后用 edit 或 patch（`/elements/text/props/text`）照常改。body 和 markdown 只能给一个。
  - **按条修改**（YN-14 A2）：`{op:"patch", key, patch:[…], status?}` 用 RFC 6902 操作（add、remove、replace、move、copy、test）改一节正文里的单个值，路径是正文里的 JSON Pointer，例如 `/elements/refs/props/items/3/note`。数组那一段也可以写 `@<id>`，指 id 为它的那一项（YN-31），例如 `/elements/runs/props/rows/@r8/cells/status`：行被插入或重排后仍指 r8；作 add 的最后一段时指那一项之前的位置。下标、`-` 和对象的键照旧（对象上的 `@x` 仍是键 `@x`）；没有这个 id 或有两项同 id 时拒收（`patch_path`）。和 edit 一样保留标题、附件、时间和 Ask 的状态，Core 对整节重新检查（含修复式接受）；也可以加一个块并挂到根下。按顺序执行，某个操作的路径不存在、move 或 copy 的 from 是 `""`（整个正文），或 test 不相等就整条拒收（`patch_path`、`patch_test`）；一次 patch 要把正文做得远超上限（例如反复把一部分复制进它自己）也整条拒收（`too_large`）。拒收时什么都不改。改一条备注、一个步骤的状态时用它，不必重发整块。
  - **修复式接受**（YN-14）：一节没通过严格检查时，Node 校验器先修补 Core 不用猜就能修的小错，再用同一份 contract 严格检查一遍；通过就接受，并在回答的 `repairs` 里逐条说明改了什么（整次调用至多 10 条，`moreRepairs` 计其余；每节超过 8 处就按原样拒收）。能修的：未知组件改成 Markdown（文本做 HTML 转义）或 Group、按固定别名改名或删掉组件没有的字段、补或去重 id、枚举的大小写和少数同义词、Findings 缺 severity 记为 info、Table 缺的格子留空、文字写的 Ask 选项改成 {id, label}、修树和版式、put 里注册了却没显示的附件加到根下的 Attachments 块。不修的：key、kind、title、Ask 的问题和其他回复方式、status、time、附件的注册（正文之外只修 Ask 的选项；put 里没显示的附件只是在正文里显示出来，注册不变）、没有可用回复方式的 Ask、超限（不截断）、文件 / 来源 / 研究记录的引用、ResearchDesk 和 Sources、组件要求而 Agent 没给的内容（如 Finding 的 source）。修不好时，拒收给出的是原样发送时的问题。合法的节一字不改。
  - 修补过的节在 Core 里带着 `repairs` 保存，`brief_get` 和 Home 都能读到；Home 在卡片和报告页上标「已修补 / Repaired」，报告页列出前几条。put 换掉整节时重新计算；edit 只去掉它替换的块上的条目，其余保留，所以整节层面的修补（树、根的版式、Ask 的选项）要到下一次 put 才去掉。
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
| 每份 Brief | 最多 12 个顶层主题，每个主题最多 4 个子主题；看过的 report 在历史里保留 30 天 |
| 每节的内联内容 | 合计不超过 64 KB，与 `result_publish` 的 `MAX_SPEC_BYTES` 一致 |
| 单个块 | 代码块和日志摘录 ≤ 200 行；内联表格 ≤ 200 行；内联图表 ≤ 500 个点；清单和意见条目各 ≤ 30 条；活引用每节 ≤ 50 个。超出时，拒收理由会告诉 Agent 改用附件 |
| 附件 | 单个文件 25 MB 以内保存快照，超过的只引用；每节最多 12 个；每份 Brief 的快照总量上限 1 GB，超出时先清理历史里最旧的快照；设置里可以手动清理缓存 |
| 图表数据 | 图表只能读取已保存快照的数据文件；每条曲线降采样到 5000 个点以内，每张图最多 12 条曲线 |
| ask 表单 | 沿用 Clarification 的上限：1–8 个字段，每个字段 2–12 个选项 |

快照和引用的区别：小文件在写入时保存快照，内容固定为当时的版本；大文件和目录只引用位置，并标注"可能已变化"。图表只能读快照，这样数据文件被下一轮实验覆盖后，图和结论仍然对得上。

## 回复与审批

- **回复方式**：自由文本，或 ask 节声明的选项按钮。两者都只生成一条用户消息，发给该节的 owner，消息里引用这一节。项目级的自由回复，设了 Steward 就发给 Steward，否则由用户在项目的 Agent 里选。任何情况下都可以手动改发给其他 Agent。
  - **发给已释放的执行者**（T-36、YN-86 S2a）：页面打开时还是执行者、发送时已经释放的，Core 改投：report 和 status 卡片发给这张卡的当前负责人，没有就发给 owner；Ask 发给 owner，因为只有 owner 能 resolve。都没有时拒收，回复留在页面上。发给卡片负责人的卡片回复多一行 `This card is bound to task YN-90; you are its responsible Agent.`；用同一个 clientMessageId 重发时，不管这一行当时写了什么，都认作同一条回复。
- **对项目说**（YN-86 S3a-1）：用户对项目说的话是一条需求，`POST /api/projects/{id}/requests`（`workspaceId`、`text`、可选的 `textBlocks`、`clientMessageId`）。Core 把它记成项目的下一个 R-n，原文和粘贴块原样保存，送给项目的前台（见 CONTEXT.md「前台」）：开头一句 `Request R-n from the user to the project …. Route or answer it with project_route; …`，空一行，然后是原文，粘贴块挪到开头之后，前台的会话里也是同样的胶囊。消息的 `origin.kind` 是 `project_request`，会话里算作用户从 Home 发的。补充是 `POST /api/projects/{id}/requests/{n}/replies`，同样原样保存，开头是 `Follow-up to request R-n from the user, …`；需求转交到卡片以后，发给它每张卡片现在的负责人（打开着的，按转交的顺序，同一个 Agent 只发一次），还没转交、或者这些卡片都没有打开着的负责人时，发给现在的前台。两者的上限都是 Home 回复的 `MAX_REPLY`（超出以 `reply_too_long` 拒绝），加上开头仍在一条消息的上限之内。用同一个 clientMessageId 重发，得到的是同一条需求或补充和它原来的收据；换了内容就拒绝。没有前台、前台已关闭、项目已归档，或者页面是另一个 Workspace 的，都在发出前拒绝，什么都不留，也不占编号，原话留在页面上。`GET /api/projects/{id}/requests?before=&limit=` 按编号从新到旧读需求、它们的补充和送达状态，以及转交的结果（见下一条）。前台的设置是 `GET/PUT /api/projects/{id}/front-desk`（`expectedVersion`、`agentId` 或 null）。这几条路由只给用户的页面用（本机和手机入口），带 Agent 凭据（Authorization 头）的请求一律拒绝。
- **转交**（YN-86 S3a-2，CONTEXT.md「转交」）：前台用 MCP 工具 `project_route {request: "R-n", title, note, routes}` 处理需求。只有项目现在的前台能调用，只读权限等级下被拒。`title` 和 `note` 去掉首尾空白后 1–120 字：`title` 写进需求，`note` 是对话里「项目」的那句短话（和上一句不同时才记一条新的）。`routes` 1–6 条，每条都要 `why`（1–120 字）：
  - `card` 加 `executor {templateId, tier?, machineId?}`：以前台的身份 `task_create`，再 `task_dispatch` 派新执行者（模板、路由按用户的设置，同前台自己调用），然后以前台的身份 `brief_update` 写一张 status 卡：key 是任务键的小写，owner 是前台，绑定这个任务，正文是一行 `→ <执行者名>: <why>` 和这个任务的 Live Reference，`validFor` 取合同允许的最长值。任务描述是 Core 写的开头、空一行、原话逐字节不变，后面是前台的 why；「开头 + 空行 + 原话」超过任务描述的上限减去 why 的余量时，这条转交以 `words_too_long_for_task` 拒绝，什么都不建，前台可以改交给已有的 Agent。还可以带 `materials` 和 `body`（YN-135），和 `task_dispatch` 的同名字段一样，只进派发材料，不进任务描述；`baseSha`、`headSha` 只收完整 SHA。Core 在记下这条转交之前就按派发的规则检查它们（字段、仓库是不是这个项目的、问 GitHub 提交在不在、`worktree` 是不是这台主机上项目文件夹里面现有的文件夹，带 `worktree` 的执行者是不是在这台主机上：转交的 `executor.machineId`，没写就是模板的机器，须是 `local` 或 `auto`），不对就整次拒绝，什么都不记也不建；带了 `worktree` 的执行者在那个 worktree 里起，没带就在项目文件夹本身起。
  - `card` 加 `agentId`：同上建任务和卡，交给项目里一个打开着、不是执行者的成员（`task_dispatch` 的 `toAgentId`）；是前台自己就只建任务、指派给自己、不发消息。原话放不进任务描述时，Core 另把原话作为一条来自 Home 的消息发给他。
  - `existing` 加 `cardKey`：并到一张活着的、绑定了任务、任务还没结束的卡上。Core 把原话作为一条来自 Home 的消息（`origin.kind` 仍是 `project_request`，带粘贴块）发给这张卡现在的负责人，开头只有 Core 写的字和用户起的名字（项目、前台），卡片用任务键说；前台的 why 以前台的名义另发一封邮件。负责人是前台自己时不发。负责人是还在等执行者槽的执行者时，它开始前收不了来自 Home 的消息，Core 改用前台署名的一封邮件，等它开始后再读：Core 的开头、原话逐字节不变、前台的 why；放不进一封邮件（16,384 字节）时，这条转交以 `executor_queued` 拒绝，等执行者开始以后再转。
  - `answer`（YN-136）：只有 `kind` 和 `why`，不建任务、不建卡、不写 Brief，也不发消息；记下就算完成。这次调用的 `note` 就是回答，`why` 写为什么不用开卡（例如「只问进度；YN-115 已合入」），只显示在转交记录里。只用于前台凭已知的事实一两句话就能答完的问题（状态、结果、东西在哪）；要做的事（代码、修复、调研、设计、审查、发布）和要用户拿主意的事都要开卡，拿不准就开卡。一次调用可以只有 `[answer]`，以后也可以在它后面接着加 card 或 existing，序号规则不变。
  每条按（需求，序号）记在 `project_routes` 里，只做一次：同样的转交再发，做过的不再做，失败的从停下的那一步接着做；同一序号换了内容就整次拒绝。一条失败不撤销别的。卡片上的 `card.handoffs` 列出转到这张卡的需求（`n`、标题、时间、是否并入、`messageId`）和转交记录，不带原话。`GET /requests` 的每条需求多了 `notes`、`routes`、`cards`（每个任务一张：卡片、任务状态、现在的负责人）、`progress`（卡片数和任务已结束的数）、`state`（`waiting`/`doing`/`done`/`answered`）和 `lines`：卡片上每个 Ask 一行、每个结束的任务一行，同一张卡转自几条需求时只出现在编号最小的那条上。没有卡片的需求，前台用 `answer` 回答过、并且最新的 note 晚于最新的补充（没有补充也算）时是 `answered`：用户之后又补充，补充照旧发给前台，需求回到 `waiting`；前台再回一句新的 note 就又是 `answered`，回一句和上次一模一样的话不会新记一条 note，所以还是 `waiting`。开了卡以后照旧由卡片算出 `doing` 或 `done`，`answer` 不影响。
- **改派**（YN-86 S3a-2）：用户在卡片上改派，`POST /api/projects/{id}/cards/{sectionId}/reassign {workspaceId, to: {agentId} | {executor: {templateId, tier?, machineId?}}, why?, clientRequestId}`，只给浏览器用。Core 以用户的身份先把卡片的任务派给新的负责人（派发里写明卡片），成功后在同一个请求里以用户的身份释放原来的执行者（原来的负责人不是执行者时不释放）。释放会结束旧执行者正在做的事；它还有在跑的 Job、交付流或 PR 操作时，`executor_release` 让它先进入 archiving，等这些结束再关闭，不会硬杀。返回值的 `released.note` 也这样写，`released.release` 是 `executor_release` 的回答。释放失败不撤销新的派发，同一个 clientRequestId 再发一次会再释放。改派记成一条 `kind: reassign`、由用户发起的转交。
- **Agent 正忙时**，效果和在会话输入框里发送完全一样。现有的发送 hook 绑定在当前选中的 Agent 上（`web/src/useConversationSend.ts:87-131`），Home 需要自己的发送路径，自行处理 `clientMessageId` 和 `expectedTurnId`。接口是 `POST /api/agents/{id}/messages`（`core/src/server.rs:579`）。
- **Agent 写的内容永远不能直接执行操作**，例如合并、部署或批准。
- **Core 审批**：在 Home 上直接调用 `POST /api/requests/{id}/respond`（`core/src/server.rs:104,632`）。现在审批卡片 `PendingCard`（`web/src/components.tsx:851-1106`）只挂在会话里。

## Machine Load

- **目标**：所有 Machine 都通过 SSH 采样，GPU 也采。当前连接的机器有 WSL 本机（RTX 5090，`nvidia-smi` 可用）、Mac mini 和 远端 Linux 主机（WSL 可以直接 SSH）。
  - Mac mini 的 GPU 打算用 `ioreg` 读取，有待验证。
  - 远端 Linux 主机 上，GPU 按卡显示占用率、显存，以及占用它的用户和进程。
- **本机 GPU**（T-58）：Core 进程里只有一个 GPU 采样器读 GPU，每 5 秒一次：常驻一个 NVML 会话，NVML 不能用时常驻一个 `nvidia-smi -l 5` 进程。Machine Load 和 Jobs 读同一份样本；有读者时启动，10 分钟没人读就停，再读时重启。WSL 里每新启动一次 nvidia-smi（或开关一次 NVML）都会让 Windows 显卡驱动漏内存，直到重启电脑。
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
