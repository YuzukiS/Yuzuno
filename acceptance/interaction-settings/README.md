# 对话交互与设置验收

2026-10-12 完成。可打开独立实例 **http://localhost:4347**；它使用专属数据，不是日用工作区。没有刷新或操作日用窗口，没有停止或重启日用 Core，没有覆盖日用 `web/dist`。

## 本次行为

- Working 保持单行小字、原 Yuzuno character 和轻微动画，尊重减少动态效果的系统设置。20px 字号实测高度约 23.8px。
- Context 圆环接入真实 Codex 用量，按最近一次请求的 `last.totalTokens / modelContextWindow` 估算。绿色、黄色、红色区分占用，hover/聚焦/点击可看百分比和 token 数；无数据显示未知，断线或压缩后标为最近已知值。没有拿累计消耗当 Context。
- 运行中仍可发送，使用原生 `turn/steer` 和明确的当前 Turn ID。Turn 已结束会保留草稿并提示，不偷偷开启新任务。
- 异步问题有 **Send answer**，可直接回答并保留输入框草稿；**Add answer to draft** 仍可选。刷新后已回答状态保留。
- 对话右上角 **Agent settings** 可选择执行机器实际提供的模型、推理强度、文件访问范围与审批策略。保存从下一轮生效；不会中断当前任务或批准已有 Pending。
- 原生明确提供 `acceptForSession` 时显示 **Allow for this session**。`Never request approval` 不会扩大文件访问权限，越界动作会失败。
- 每次消息有持久化编号和提交回执。重复点击/HTTP 重试使用同一编号；传输结果未知时不自动重发，通过原生用户消息的 `clientId` 核对。若核对仍无明确证据，继续显示未确认，避免重复执行。

搜索、Agent 发言在折叠外、文件行号预览、Catch-up 来源跳转、字号设置和旧重连保护均保留。

## 实际验收

| 验收 | 结果与证据 |
| --- | --- |
| Core 回归 | 47 项通过；1 项原有的特殊环境测试保持 ignored。最后的原生默认推理强度接入另有构建和 6 项针对性测试通过。包括断线、过期审批、并发重试、未知回执、无 steering→新任务回退、下一轮设置。 |
| 前端 | TypeScript 检查、独立 Vite 构建、25 项生产 bundle 测试、3 项搜索函数测试通过；见 `web-check.json`。 |
| 搜索浏览器 | 15 项通过：精确原始消息、中文/大小写、Agent 切换、Escape、持续事件不抢滚动、回到最新、无已读/Pending 写入；见 `search/report.json`。 |
| 交互与布局浏览器 | 8 项通过；浅/深色，1440/940/390px，20px 字号，无横向溢出；直接回答保留草稿、运行中发送、Context 切换；见 `browser/report.json` 和截图。 |
| 真实 Codex | 运行 `sleep 20` 期间发送补充，仍为同一个 Turn、两条用户消息，最终回复采用 `YUZUNO-STEER-4347`；真实异步问题直接回答 Sage，模型最终确认 Sage，原草稿未丢；见 `real/report.json`、`real/agent-detail.json`。 |
| 真实设置生效 | 原生 rollout 的 `turn_context` 依次为 `gpt-6.1-sol / low`、`gpt-6.1-sol / high`、`gpt-6-astra / low`；三轮均为 `never / read-only`。模型切换后重连保留设置。见 `real/native-settings-evidence.json`、`model/report.json`。 |
| 日用保护 | PID **2241574**、启动 tick **49302988** 未变；日用所有静态文件哈希未变。见 `daily-verification.json`。 |

测试分清了真实原生验收和 fixture：故障注入、重复发送及审批按钮边界用独立协议 fixture 验证；真实验收没有申请全盘访问，也没有替用户批准任何日用请求。

## 手动体验

1. 打开 http://localhost:4347，选择名称以 **Interaction acceptance** 开头、包含三轮验收记录的 Agent。
2. 搜索 `YUZUNO-STEER-4347`，点结果跳回原消息；搜索框按 Escape 只关闭搜索。
3. 发一句“先执行 sleep 20，最后回复我期间补充的代号”，Working 出现后再发代号，确认能留在同一 Turn。
4. 请它调用异步提问工具，先在输入框写一段草稿，再在问题卡选择并 **Send answer**，检查草稿保留。
5. hover 右下圆环看实际 Context；打开右上设置切换模型/推理强度，发下一轮验证。搜索跳转后继续执行时，页面保持阅读位置；**Back to latest** 恢复跟随。

文件定位的可点击源代码示例（Agent 工作目录为项目根目录时）：[源文件](../../web/src/useConversationSend.ts)。在对话中可使用 `[查看代码](web/src/useConversationSend.ts:19)` 或 `[查看代码](web/src/useConversationSend.ts#L19)`。

## 改动与复现

`changes.patch` 是相对此 Slice 开始时的源码差异，`source-review.json` 列出文件及哈希。新增独立的 `AgentSettings`、`useConversationSend`、样式与验收脚本；Core 在 `model.rs`、`workspace.rs`、`server.rs` 和 Store 的恢复字段处理上接入。没有修改数据库表结构、`remote.rs`、`rpc.rs`、`main.rs`、SSH 或 Tauri。

隔离目录：

- 数据：`acceptance/interaction-settings/core-data`
- 前端：`acceptance/interaction-settings/web-build-src/dist`
- Rust 构建：`/tmp/yuzuno-interaction-target`
- 端口：4347（4337 已有另一个独立实例，因此避开）

`python3 scripts/interaction-lab.py` 提供 `snapshot`、`check-web`、`build-core`、`start-core`、`stop-core`、`status`、`verify-daily`。停止操作必须匹配记录的 PID、启动时间和全部目录参数。构建不会使用日用 `web/dist`。浏览器验收命令在 `web` 下运行：`node tools/interaction-check.mjs`、`node tools/interaction-check.mjs --real`、随后 `node tools/interaction-check.mjs --model-check`。真实验收会创建自己的 Agent 和有限模型调用。

## 日用切换方案（尚未执行）

这批交互需要新 Core 的消息、用量与设置接口，单独刷新旧日用窗口无法启用全套功能；不能只把新 UI 覆盖到旧 Core 上。

1. 现在保留 4347 做独立体验，4317 继续承载当前开发会话。不把验收数据库替换成日用数据库。
2. 当前会话完成、需要整合的 Claude 模块独立验收完成后，在一个明确的整合窗口合并共享改动，再构建同一版本的 Core 和 UI。
3. 整合窗口确认日用 Agent 均无执行中任务，保存草稿与旧二进制/静态资源；使用一致性 SQLite 备份，不能只复制正在写入的数据库主文件。
4. 在该窗口才停止旧日用 Core，使用原日用数据目录、端口与工作目录启动已验收的新 Core，配套切换新 UI。不要同时让两个 Core 打开同一数据库。
5. 先检查原 Agent/Thread 身份、历史、Pending/已读、模型设置和连接，再由用户刷新日用窗口。失败时停止候选 Core并恢复备份版本；不让失效审批自动生效。

本次只交付候选实现与切换步骤，未执行以上日用切换。
