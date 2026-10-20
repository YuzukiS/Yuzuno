# T-77：左右侧栏与会话切换性能调查

> 下文保留第一阶段基线与归因记录。第二阶段正文窗口的实现、同条件性能对照、行为验收和已知限制见 [WINDOWING.md](WINDOWING.md)。最终本地候选已通过 Job，尚需 PR 的 CI 与独立评审；没有发布。阶段性 Job 与失败证据保留在 `target/t77/window-v*/`；下面 CSS 诊断的收益不是最终结构性候选收益。

第一阶段调查结论：在固定 core.5 的隔离长会话中，侧栏开关最主要的成本是两项侧栏宽度 CSS 变量从 `.app` 继承进整个正文，触发约 2.3 万元素的样式重算。将这两项变量在正文边界固定后，节点数、面板几何和底部位置完全相同，四次开关从 241–259 ms 降至 81–90 ms。此结论来自隔离页面诊断；产品源码未修改，也未发布修复。

会话切换是另一个成本组合：切回长会话会重新 GET 全部已保存详情，并重新挂载正文。不能把侧栏诊断的收益推广为会话切换收益，也不能把已有 `LiveTurn` memo 说成失效或每次都重绘全部 React 正文。

## 固定条件与数据规模

- 源码：`8eac935a5a9a6536e33dbbf3ad43f8b6f013e19b`，2026.10.16-core.5。独立分支 `investigate/t77-sidebar-profile`。
- 所有有效样本和诊断共用一次生产构建及其 sourcemap；逐文件校验 `target/t77/baseline-assets.json`。没有混入 T-74 或其他并行工作。
- 原有脱敏 fixture SHA-256：`b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d`。短会话只取长会话末尾两轮；二者使用不同的合成 Agent ID/name，其他 Agent 元数据相同。工作区始终同时有这两个 Agent。
- Chromium 153.0.8010.52，Node 26.11.1，Linux headless，1440×1000，20px/light/garden、reduced motion、无 CPU 降速。
- Jobs + 全局 heavy-slot：2 CPU、3072 MiB、0 swap、Node heap 2048 MiB、TasksMax 512、浏览器 affinity 8,9、LP_NUM_THREADS=2。有效采样 Job 上限 360 秒；没有轮询 Job。

| 数据 | 长会话 | 短会话 |
| --- | ---: | ---: |
| 加载、挂载的轮次 | 157 | 2 |
| 详情中的 items | 6,197 | 11 |
| 详情 JSON 字节数 | 12,576,273 | 23,444 |
| 带大字段预览标记的 items | 949 | 3 |
| 两栏打开时页面元素数 | 23,599 | 477 |
| 轮次内元素数（含 turn 自身） | 23,215 | 133 |
| 已关闭且从未展开的工具正文后代元素 | 0 | 0 |

DOM 数量不等于 items 数量。工具正文首次展开前不挂载；已展开过的正文随后折叠仍保留。诊断双方各增加同样一个 style 节点，页面元素数相应增加 1，正文节点数不变。

## 默认究竟加载多少轮

| 路径 | 当前实现 |
| --- | --- |
| 普通本地 Codex / Claude 会话详情 | 返回 Core 当前保存的全部 turns/items 结构，没有“最近 N 轮”的全局上限。新建空会话初始 0 轮，随会话增长。 |
| 本机导入 / 原生 fork 的 Codex 历史 | 初次完整内容页、每次 Load earlier 页请求最多 3 轮；原生线程不足 3 轮则更少。这个数字不是普通会话上限。 |
| 导入会话重连 | 刷新最近页并补查缓存中未完成的轮次，与已缓存内容合并；不会把已有历史硬裁成 3 轮。 |
| UI 手动加载的 earlier 页 | 在当前选中会话内累积合并；切换会话或 base cursor 不再匹配时清空这层临时页。 |
| UI 会话切换 | `DetailSync.select` 清掉当前 detail 并发起一次新 GET；没有跨 Agent 的详情保活缓存。返回刚看过的 Agent 也重新读取。 |
| 正文挂载 | `currentDetail.turns.map` 挂载全部当前已加载轮次；没有按视口虚拟化。 |

“全部”指 Core 已保存内容，不保证任意原生线程尚未导入的旧历史已经全部读取。工具大字段另有预览/按需读取机制：超过 8 KiB 的适用字段投影为最多约 4 KiB 预览，正文消息、计划、推理及审批所需内容等有保留规则；这不是轮次分页。Codex history 页不走这项投影，因为完整内容不在 Core 记录中可供后续读取。

可核对的源码位置（均为固定基线）：

- `core/src/server.rs:455`、`store.rs:988`、`record_rows.rs:551`：详情边界及所有 turns/items 的读取，无轮数 LIMIT。
- `core/src/client_view.rs:1`：大字段投影规则及 history 页例外。
- `core/src/codex_sessions.rs:17,201,292,331,680`：3 轮页、导入、加载更早内容、原生 fork。
- `core/src/workspace.rs:586,674,1867,1971`：恢复时合并缓存并更新 loaded_count。
- `core/src/claude.rs:564`：普通 Claude detail 的 `history: None`。
- `web/src/detail-sync.ts:68`、`useSessionHistory.ts:81`：切换和当前会话分页的保留范围。
- `web/src/App.tsx:162,1566`、`components.tsx:476`：LiveTurn memo、全部轮次 map、首次访问工具正文后保留。

## 基线结果

耗时为 click capture 到预期 DOM 提交后的第二个 requestAnimationFrame，是绘制机会代理，不是屏幕实际呈现时间。每格一个代表性样本，不是 p50/p95 或稳定统计值。

| 操作 | 长会话 ms | 短会话 ms | 长会话样式重算 ms | 长会话 Layout ms |
| --- | ---: | ---: | ---: | ---: |
| 关闭左栏 | 227.3 | 26.3 | 145.7 | 28.1 |
| 打开左栏 | 243.9 | 28.5 | 158.4 | 32.6 |
| 关闭右栏 | 251.5 | 27.8 | 165.2 | 31.7 |
| 打开右栏 | 233.6 | 27.5 | 149.8 | 32.6 |

八次开关都没有 API 请求、传输或 JSON 解析。长会话 click 到提交约 6.2–7.4 ms，CDP ScriptDuration 约 9.8–12.3 ms；每个样本记录两个根 commit，不能据此推断每个正文组件的 render 次数。长会话 UpdateLayoutTree 涉及 23,372–23,446 个元素，另有 PrePaint 34.7–36.8 ms、Paint 4.4–7.5 ms。

每次开关的 TurnNavigator ResizeObserver 回调读 157 个 turn rect，另读 1 个 scroller rect，共约 0.7–0.9 ms。其他跟随增长/已读/编辑器 observer 总量也很小。这里布局已在 observer 前发生，不能把约 250 ms 归因于这次逐轮扫描。CPU 主体为浏览器 native 工作，JS 采样和 React 提交均不是主导成本。

## 样式因果对照

`usePanelWidths` 在 `.app` 上写 `--rail-width` / `--inspector-width`，关闭时相应变量变为 `0px`（`ResizablePanels.tsx:54–101`）。源码中这两个变量只由 `.app` 的 grid 列定义消费，但 CSS 自定义属性默认向所有后代继承。

在相同已构建页面中只加入以下诊断样式；对照也加入一个空 style 节点：

```css
.main-panel {
  --rail-width: 0px;
  --inspector-width: 0px;
}
```

| 操作 | 对照 → 隔离变量 ms | 样式重算 ms | 样式重算元素数 |
| --- | ---: | ---: | ---: |
| 关闭左栏 | 248.1 → 81.5 | 156.7 → 3.5 | 23,372 → 132 |
| 打开左栏 | 259.1 → 83.7 | 162.3 → 5.2 | 23,446 → 206 |
| 关闭右栏 | 254.1 → 89.7 | 169.5 → 3.0 | 23,380 → 140 |
| 打开右栏 | 240.7 → 81.4 | 159.1 → 3.4 | 23,446 → 206 |

四组操作前后的 DOM/几何对象逐字段相等断言通过，包括元素数、157 轮、23,215 个轮内元素、工具正文状态、面板宽高、scrollHeight、scrollTop、侧栏 class。所有样本都从底部开始并保持底部，gap=0；没有隐藏、卸载或丢弃历史来换性能。主栏宽度按预期在 924 ↔ 1168/1196 px 之间变化。

隔离后 Layout 仍有 27–33 ms，PrePaint 31–36 ms：实际布局和绘制前工作没有消失。这解释了为何诊断仍约 80–90 ms，而不是短会话的约 28 ms。

## 会话切换

| 操作 | click→ready ms | ScriptDuration ms | Layout ms | 根 commits |
| --- | ---: | ---: | ---: | ---: |
| 长 → 短 | 104.7 | 62.3 | 5.9 | 6 |
| 短 → 已看过的长会话 | 975.1 | 350.9 | 351.3 | 8 |

返回长会话仍重新 GET 12,576,273 字节，且重新挂载全部 157 轮。该 loopback 样本中 fetch 到原生 `Response.json()` 完成约 196.9 ms：请求发出到 responseEnd 126.4 ms（其中 body 传输 102.9 ms），responseEnd 到 JSON promise 完成 63.2 ms。后者包含解码、解析和主线程调度，不能称为纯 JSON CPU。mock 序列化约 18.9 ms，不能当作实际 Core/SQLite 耗时。

JSON 完成到目标 DOM 提交另有约 680.5 ms。CPU stack 将约 353 ms 的 `getBoundingClientRect` 指向 `TurnNavigator.tsx:238`，调用方为 `:223` 的初次 useLayoutEffect；trace 中对应最大 Layout 为 342.3 ms。这次同步测量迫使新挂载正文完成布局，**不同于侧栏开关时小于 1 ms 的 ResizeObserver 回调**。其余脚本包括 React DOM、DOMPurify/HTML 解析和 DOM 操作，不能将全部 ScriptDuration 叫作 React 计算。

首次切离长会话的基线样本从顶部开始；返回长会话最终位于底部。此切换对不是与样式诊断的一项等价功能回归。没有针对切换路径测试或声称变量隔离能改善 975 ms。

## 建议和交付边界

首选一个小范围修复：在 `.main-panel` 边界固定这两个只供祖先 grid 使用的变量，或采用等价的变量作用域限制。当前诊断已证明它能消除主要的全正文样式重算，不需要先重写 App 或引入全面虚拟列表。预计影响是侧栏开关的样式成本；残余 Layout/PrePaint 和长会话首次挂载不在这项修复收益内。

正式实现后仍需有针对性地验证调整侧栏宽度、响应式断点、阅读中段锚点、Back to latest、来源跳转、选中文本、草稿、审批、已读与流式更新。此次底部几何断言只是其中一部分，不能替代完整交互验收或 Windows WebView2 测量。

切换路径建议另做定点设计：初次导航位置测量能否合并到布局后的观察回调，避免 commit 内强制布局；但布局本身仍必需，当前证据不足以承诺总时延下降。重新请求和全文重新挂载的收益/内存/修订一致性需要单独评估。此阶段不通过裁掉旧消息、随意详情缓存或全面虚拟化跳过这些语义问题。

## 证据和复现

本目录只有测量脚本及报告，`web/` 与固定基线 diff 为空；未改日用 Core、用户窗口或真实任务记录。所有真实会话内容仍留在原有隔离脱敏 fixture，本轮未将其发送给外部模型。fixture 和原始 trace/CPU JSON 不提交到 Git。

相对独立 worktree 的证据：

- `target/t77/baseline-assets.json`：固定资产和 fixture 哈希。
- `target/t77/baseline-profile-v4/report.json`，SHA-256 `afd4031b6224c53de3c6be31942517819d09c85c1840e20f3cf9ff28bb5e361f`。
- `target/t77/width-vars-matched/report.json`，SHA-256 `bbb80eb43f292c107534ee244498adade794fb0960e3ef03759ef9b8de89f641`。
- 两个目录保留各样本的 `.trace.json`、`.cpu.json`、runner log；基线原 harness 保存在其目录。
- `target/t77/analysis.json`：紧凑派生数值和强制布局 CPU 调用栈。
- `target/t77/evidence-sha256.json`：原始结果哈希索引。
- `target/t77/dispatch.json`：原 dispatch `18b4cf72-b5a4-4469-9216-f2e1392d30de`。

基线成功 Job：`e7d835c5-03b1-478d-834a-92dbf13335e9`，10 样本通过；匹配诊断成功 Job：`4482359a-996d-42ff-b05a-213838a0ed63`，8 样本及四组几何相等断言通过。两者均无意外 API、外连、写请求、页面错误、OOM 或 pids 上限事件，峰值分别 147/148 tasks。

保留但不作有效总时延收益依据的运行：首次 Job 构建成功但 Chromium 临时 socket 路径过长；第二次缺 `/jobs/live` mock，预检终止；第三次 harness 错误假定右栏默认关闭而超时。三次均无完整样本。首次变量诊断 Job `3be4e4a4-bf5c-4d23-86da-6bff285d801f` 的滚动位置不匹配，仅用于发现假设，不以其总时延计算收益；严格对照替代了它。

`baseline.sh` 只用于从固定干净基线构建一次，拒绝覆盖现有产物；浏览器阶段应使用 `sample.sh`，它创建短 `/tmp/t77-profile.*` 目录避免 Unix socket 长度限制。设置 `T77_ASSETS`、新的 `T77_OUT`；`T77_MODE=baseline` 运行长短及切换，`T77_MODE=isolate-width-vars` 运行匹配变量诊断。按本卡约定通过有界 Jobs/heavy-slot 执行，不自动重跑或覆盖既有证据。

这些是少量 Linux 无头浏览器样本，不是实际 Windows 体感保证。CPU 采样、trace 和测量包装有开销；嵌套 trace 时长不能直接相加。CDP ScriptDuration 窗口略宽于页面 marker 窗口。原发布结果正文不在 fixture 中，统一使用小型合成 Text 结果；工具均未先展开，真实长期使用后的 DOM 可能更大。没有测量实际 Core DB、真实网络、活跃流式场景或所有阅读位置。
