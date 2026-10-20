# Project Brief：结果离开会话，由 Agents 在回合末维护

T-8（`docs/intelligent-ui-v1.md`）把会话定为用户的阅读面：交互结果只挂在产生它的 Turn 下，不另设 Core 存储或发布工具。现在改为每个 Project 有一份由 Core 保存的 Project Brief。该 Project 的 Agents 在回合末通过 MCP 先读取当前版本，再更新自己负责的 Section。Home 按 Project Priority 呈现各 Project 的 Brief，用户不读会话也能理解现状、做出决定并直接回复。这样改，是因为用户同时管理的 Project 和 Agents 已经多到无法逐个巡视会话；而由 Yuzuno 事后从会话推导摘要（旧 Catch Up 与 summarize 实验的路线）只能复述事实，无法表达 Agent 自己的判断。

## Considered Options

- **Core 事后从会话和 journal 推导**（旧 Catch Up）：只能表达审批、报错、未读结果等事实；摘要生成始终没有做成产品。
- **每个 Agent 各自发卡片**：会导致注意力通胀和重复，排序也会被 Agent 自己抬高。因此改为以 Project 为单位、按主题分节、每节一个 owner，顺序由用户的 Project Priority 决定。
- **由单一 curator 或管理者独写**：内容最连贯，但干活 Agent 手里的细节和图表要多转交一次。保留为可选的 Brief Steward，不作为默认方式。

## Consequences

- **Yuzuno 只强制能机械判定的规则**，例如 schema、ask 节是否写明问题、篇幅上限、版本号是否最新、是否违反 owner 规则。内容是否相关、是否重复、写得好不好，都由 Agents 和 Brief Steward 负责，Yuzuno 不做语义判断。
- 回合末只检查一件事：属于某个 Project 的 Agent 在这个回合里有没有被 Core 接受的 `brief_update`（没有变化就显式提交有效的"无变化"）。没有成功提交时，Claude 在同一回合内被要求补上；Codex 在原生 Stop hook 验证可行之前，改为回合结束后补一个提醒回合。补救有上限，仍未完成时如实保留状态；不能把调用尝试或提醒当作内容完整性的保证。
- 读后才能写：`brief_update` 必须带上读取时得到的版本号，版本过期就拒收，并附上最新内容。Yuzuno 不在每个回合注入完整的 Brief。
- 会话仍是完整的工作记录。Brief 的更新以折叠的工具调用出现在会话中，不改变 Agent 的最终回答。
- T-8 的交互结果仍挂在 Turn 下，与 Brief 并存。
- Home 项目头部不继承旧 Catch Up 的“未读的已结束回合”或最终回答兜底。项目结论由 Brief 承载，会话未读与完整工作记录仍保留；Core 的审批、错误和执行状态继续独立展示。
- 规则必须通过 MCP 送达所有 Agent，因为 yuzuno skill 不随 Core 发布，其他仓库的 Agent 读不到。
