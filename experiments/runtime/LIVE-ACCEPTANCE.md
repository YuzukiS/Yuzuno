# 真机验收前置检查 — 2026-10-12

> Public copy: hostnames, account names and absolute machine paths below are illustrative replacements. Historical outcomes remain observations of the original private environment; these example endpoints were not contacted. Raw evidence is retained privately.

> **后续已经开放 full access 并完成 SSH 实测。** 最新结论见 [LIVE-RUNTIME-RESULTS.md](LIVE-RUNTIME-RESULTS.md)：Mac mini 离线工具执行、审批重连、Runtime 重启后历史恢复通过；Claude WSL 完成真实新建与恢复。Windows 重新登录后的只读核对显示两端同一账户，双账户验收未完成，后续可完全在 WSL 使用独立官方配置目录。下文保留权限尚未开放时的前置检查记录，不能作为当前执行状态。

本轮用户已经授权 socket、Tauri 安装、真机验收；**授权已具备，执行环境权限尚未放开**。主代理的 socket 升级请求被执行工具以 `sandbox_approval:false` 拒绝。本报告不要求重复批准，也不把静态资料当成远程实测结果。

## 本轮明确结果

| 检查 | 结果 | 依据与边界 |
| --- | --- | --- |
| Mac mini SSH 目标定位 | PASS | 旧项目私有实验明确以 Mac mini 为对象，目标 `192.0.2.10`；本地 `ssh -G` 确认为 `tester@192.0.2.10:22`。没有连接该机器 |
| 已有 Codex 登录 | PASS | 官方 `codex login status` 为 `Logged in using ChatGPT`；没有读取或复制认证文件 |
| Claude 已登录配置发现 | PASS | 官方 `claude auth status --json` 在 WSL 默认目录、显式 WSL 目录及 Windows 配置目录均报告 `loggedIn=true` / `claude.ai` / `max` |
| Claude 两个隔离账户 | UNRESOLVED | WSL 默认与显式目录其实指向同一物理目录，却显示不同账户；Windows 目录的 Linux CLI 读取结果没有账户标识。不能据此确认两份有效、隔离的认证 |
| TCP 本地监听 | BLOCKED | 本轮探测 `socket(AF_INET)` 为 `EPERM` |
| Unix socket 本地监听 | BLOCKED | 该实验执行环境的 `socket(AF_UNIX)` 同样为 `EPERM`；不把另一执行环境的结果外推到这里 |
| 成功模型任务、真实工具与审批 | NOT RUN | 已知网络禁用后未继续发送会重试的模型请求，未消耗账户额度来重复确认限制 |
| Mac mini daemon、离线完成与重连 | NOT RUN | 网络权限未开放；没有 bootstrap、启停或更改任何既有远程 runtime |
| Claude 两账户新会话／恢复 | NOT RUN | 未选定两份明确隔离的实际登录配置；没有登录、退出、刷新或迁移凭据 |

脱敏原始结果：[live-preflight-observations.json](live-preflight-observations.json)。复现脚本为 [probe_live_preflight.py](probe_live_preflight.py)。与上一轮的空配置实验不同，这次只读查询了用户现有登录状态。

## Mac mini 的来源证据

目标来自用户已有的 SSH 配置和明确标注的私有验收记录，再由本地 `ssh -G` 核对。原始主机地址、账户、缓存路径和节点 ID 保留在私有证据中，不随公开版说明发布。另一台笔记本和旧转发端口没有被误当成本次目标；旧实验使用过模拟模型，不能证明当时的官方 Harness 认证或推理可用。

## Claude 目录别名带来的身份歧义

官方 CLI 的实际输出有一个需要保留的边界：

| 启动方式 | 官方报告的 configDirectory | 官方报告的账户相等性 |
| --- | --- | --- |
| 不设置 `CLAUDE_CONFIG_DIR` | `/home/developer/.claude` | account-1 |
| 显式设置为 `/home/developer/.claude` | `/home/developer/.claude` | account-2 |
| 显式设置为 `/mnt/c/Users/developer/.claude` | `/mnt/c/Users/developer/.claude` | 没有账户标识 |

`account-1` / `account-2` 是同次查询内的相等性标签，不是保存的邮箱或 token。只读配置 metadata 对照显示：默认路径的 `~/.claude.json` 和显式目录内的 `~/.claude/.claude.json` 保留了不同的 `oauthAccount`；Windows 用户目录的父层 metadata 对应 account-2。没有读取 `.credentials.json` 来推断认证归属。

这说明**显示的账户不同，不足以证明凭据隔离**。前两项引用同一物理配置目录，不应该作为两个独立账户选项交付。Windows 配置经 Linux CLI 的读取也不等价于已完成 Windows 原生认证验收。

实现上应先保存官方启动方式与实际配置位置；不能为了统一形式，自动把“默认配置”改写为显式 `CLAUDE_CONFIG_DIR=~/.claude`，也不能只按显示邮箱合并或拆分账户。账户标签的最终确认仍需在所选原生运行环境用官方接口完成。

## 权限开放后的具体验收顺序

1. 在同一个实际执行环境重跑前置检查，确认 TCP / SSH 真正可用。用已授权的 Codex 官方登录，在新建临时工作目录完成一条小任务：创建文件、读取结果、返回固定 marker；随后验证一次真实审批拒绝／批准和 Interrupt。不改现有 Session。
2. 运行已有只读 SSH 探针，确认 Mac mini 的 OS、实际 binary 路径及版本。先查官方认证可用性，再创建本轮独立临时 runtime；不碰旧 node lab 或现有 daemon。
3. 对该独立 runtime 测试“启动长 Turn → 断开客户端 → 重新连接 → 读取最终结果”，另测离线期间的 Pending。事件补回、最终历史读取、Pending 恢复分别判定，不能用一个成功结果代替三项验收。
4. 确认两个实际独立的 Claude 配置根，在各自原生机器／用户上下文中用官方状态接口核实。分别新建 Session，记录 profile 与 Session 归属，重开后检查恢复。当前不做退出／刷新破坏性实验，不移动任何凭据。

前置检查复现：

```sh
python3 experiments/runtime/probe_live_preflight.py \
  --claude-config-dir /home/developer/.claude \
  --claude-config-dir /mnt/c/Users/developer/.claude \
  --ssh-target tester@192.0.2.10 \
  --ssh-config /home/developer/.ssh/config \
  --output /tmp/yuzuno-live-preflight.json
```

环境权限开放后，Mac mini 只读能力探针：

```sh
python3 experiments/runtime/probe_ssh.py tester@192.0.2.10 \
  --ssh-config /home/developer/.ssh/config \
  --output /tmp/yuzuno-mac-mini-capabilities.json
```

`probe_ssh.py` 不安装、bootstrap 或启动服务。真实 Tauri / Core 的跨 Windows–WSL 运行验收由主实现线另行记录；本报告没有把前端测试替代原生窗口验收。
