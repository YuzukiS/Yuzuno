# 真机 Runtime 验收 — 2026-10-12

> Public copy: hostnames, account names and absolute machine paths below are illustrative replacements. Historical outcomes remain observations of the original private environment; these example endpoints were not contacted. Raw evidence is retained privately.

**Mac mini 的 SSH 持续执行、离线审批回补和原生历史恢复已经实测通过。Claude 的 WSL 账户完成新建和恢复。用户已重新登录 Windows Claude；最新只读核对显示 Windows 与 WSL 是同一账户，因此双账户有效运行仍未通过，续验在模型调用前停止。** Windows 是早期利用既有第二个登录的实验选择，不是产品要求；Claude 可以继续运行在 WSL。用户开放本任务的 full access 后，Unix/TCP socket 与 SSH 均已在本执行环境成功使用。旧报告里的 EPERM 只代表先前环境。

## 结果

| 检查 | 结果 | 实测边界 |
| --- | --- | --- |
| 本机 Unix/TCP | PASS | 两种 socket 真实 bind 成功 |
| Mac mini SSH | PASS | `tester@192.0.2.10:22`，Darwin/macOS 27 arm64 |
| Mac mini 现有 Codex | FOUND / TOOL FAIL | 全局 0.156.1，官方 ChatGPT 登录可用；默认 gpt-6-astra 的工具报 `timed out negotiating with the code-mode host` |
| 隔离安装官方 Codex | PASS | 仅在远程 `/tmp/yuzuno-next-codex-rqvam2uk` 安装 npm `@openai/codex@0.162.1`；没有升级全局 CLI |
| SSH 断开后真实工具完成 | PASS | 0.162.1 默认 gpt-6.1-sol；原生命令启动后关闭 SSH 客户端 35 秒，25 秒命令离线写完测试文件 |
| 重连取回最终 Turn | PASS | `thread/resume` + `thread/read` 返回同一 Turn ID、completed 和完整命令结果 |
| 离线期间出现审批 | PASS | 先运行 `sleep 15`，断开 25 秒；重连恢复原生 `item/commandExecution/requestApproval` |
| 审批往返 | PASS | 仅对固定的 `printf YUZUNO_APPROVAL_OK` 回复一次性 accept；命令 exit 0、marker 与最后回复均正确，没有保存规则 |
| Runtime 停止后历史恢复 | PASS | 只停止本实验 App Server，重新启动后恢复同一已完成 Turn；这不代表中断中的工具可无损继续 |
| 错过的逐条事件补发 | NOT PROVIDED | 重连没有重新发送离线期间的 item/started、item/completed；通过原生历史补回完成结果 |
| daemon bootstrap / 自启动 / 升级管理 | NOT TESTED | 使用 detached 官方 App Server + 私有 Unix socket，未调用用户默认 daemon 的生命周期操作 |
| WSL Claude 新建和恢复 | PASS | 真实 Haiku 任务；新进程 resume 保持同一 Session ID，并正确回忆前轮独有 marker |
| Windows Claude 运行 | NOT REVALIDATED | 早期实际调用报 OAuth 已过期、0 tokens；用户重新登录后，官方状态报告已登录且与 WSL 同一账户。本次没有发送模型请求，不继续声称当前 OAuth 过期，也不以状态查询宣称调用已成功 |
| Claude 跨 profile resume | PASS（存储边界） | WSL、Windows 都明确拒绝另一个原生配置根的 Session ID：No conversation found |
| 两个有效 Claude 账户并行/恢复 | INCOMPLETE | 当前两端报告同一身份，缺少第二个不同账户的独立 profile 实测；后续可完全在 WSL 用官方独立配置目录完成，不要求 Windows |

## 证据

- [remote-live-observations.json](remote-live-observations.json)：6 项通过、实际版本/模型、原生 Turn 和审批结果、实验 PID 清理记录。
- [probe_remote_live.py](probe_remote_live.py)：可复现 SSH 实验；依赖已安装并维护的 `websocket-client` 1.9.2，没有自写 WebSocket framing。
- [live-access-preflight.json](live-access-preflight.json)、[mac-mini-capabilities.json](mac-mini-capabilities.json)：开放权限后的真实前置检查。前者是本轮初始状态，不是最终完成表。
- [claude-native-status.json](claude-native-status.json)：各原生 CLI 的匿名账户相等性标签。
- [claude-session-observations.json](claude-session-observations.json)、[probe_claude_native.py](probe_claude_native.py)：实际模型输出、Session ID、正确恢复和 Windows 原生认证错误。
- [claude-login-recheck.json](claude-login-recheck.json)：用户重新登录后的匿名身份相等性核对；两端同一身份，未发送模型请求。旧会话报告保留，不能把其中的旧账户标签当作本次状态。
- [remote-live-0156-host-failure.json](remote-live-0156-host-failure.json)：旧版本模型成功回答但工具失败的历史。官方 host 文件存在且为 arm64；没有简单当作缺文件处理。

测试不读取或复制认证文件，不替用户执行登录、退出或账户切换，不停止已有 Agent。远程 runtime 的 PID、socket、cwd 独立；为了使用用户既有官方登录，原生会话仍由原来的 `/Users/developer/.codex` 存储。这是运行实验隔离，不是新建独立认证域。新建的官方会话和临时测试文件保留供检查；所有本实验 App Server 已按已核实的 PID 停止。

## 对实现的直接影响

1. **本地 stdio 和远程 control socket 不能直接互换 JSONL transport。** 官方 Unix control socket 是 WebSocket；`codex app-server proxy --sock` 仅搬运原始字节，不把 JSONL 转成 WebSocket。本轮最初 initialize 超时由这个协议差异引起，随后用 OpenSSH 原生 stream-local 转发与现成 WebSocket 客户端解决。
2. **重连需要重新附着并读取原生历史。** 没有证据支持“原生事件订阅自动补回全部离线事件”。GUI/Core 可保存在线事件，重连再按原生 ID 合并 Turn/Item；不能仅靠最后一次 SSE 序号构造完整远程历史。
3. **Pending 与 Runtime 存活是不同问题。** 本轮确认仍存活的 runtime 能在客户端恢复时送回审批。没有验证 daemon 退出后审批能原样恢复，不把它与已完成历史恢复混同。
4. **记录服务端实际版本和模型。** 0.156.1 + 默认 gpt-6-astra 失败，独立 0.162.1 + 默认 gpt-6.1-sol 通过；本轮没有分离版本和模型因素，因此不能把结果完全归因于某一个版本修复。
5. **官方 auth status 是线索，真实调用才是可用性证据。** 早期 Windows Claude 的 metadata 合法且身份不同，真实请求却显示 OAuth 已不能使用；用户重新登录后的状态查询同样不能替代一次真实调用。Yuzuno 应按实际错误提示重新登录，不默默换账户或复制另一个 profile 的认证。

## Claude 配置目录边界

WSL 不设置 `CLAUDE_CONFIG_DIR` 与显式设为 `/home/developer/.claude` 指向同一物理目录，却会因 `~/.claude.json` / `~/.claude/.claude.json` 的不同 metadata 显示不同账户。它们不能当作两个隔离 profile。本轮保持两个平台各自的官方默认启动方式，没有把 unset 改成 explicit，也没有读 `.credentials.json`。

早期选中的两个不同配置根是 WSL 默认目录和 Windows 默认目录 `C:\Users\developer\.claude`，并使用各平台原生 CLI 核实。选择 Windows 只是因为当时它已有另一个官方登录，避免新建或搬动用户的认证；这不是要求 Claude 跟着 Windows Tauri 一起运行。两边原先运行 `--safe-mode --tools= --model haiku`，关闭自定义工作流与工具，只做最小 marker 对话。WSL 调用和恢复成功；Windows 当时返回的认证错误保留为历史。

用户现已通过官方流程重新登录 Windows。本轮执行 `probe_claude_native.py --finish-windows` 时，前置检查发现两端官方状态报告同一个 claude.ai Max 身份，在新建 Session 和模型调用前停止，原始报告未改动。本轮不做额外的同账户跨平台实验，也不要求用户为此再次登录 Windows。

后续如果继续双 Subscription 验收，可以全部放在 WSL：默认 `claude` 保留原启动方式；第二个账户使用真正不同的 `CLAUDE_CONFIG_DIR`，由用户在该目录完成官方浏览器登录。官方文档明确说明每个目录分别保存设置、会话历史和 claude.ai 登录；不必把凭证复制进 Yuzuno。两个不创建 API key 的 Claude Console 登录是例外，不会仅靠此变量隔离；此例外与当前 claude.ai Max 订阅方案不同。[官方多账户说明](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts)

这仍是后续验证方案，本次没有创建新 profile 或更改常用配置。配置目录隔离不等于同一 OS 用户下的安全隔离。验收时还须确认实际认证来源，避免继承的 API key、OAuth token 或 provider 环境覆盖预期的目录登录。[官方认证优先级](https://code.claude.com/docs/en/authentication#authentication-precedence)

原 Windows 续验命令保留给将来确实需要且两端身份不同的实验；当前不需要继续此路径：

```sh
python3 experiments/runtime/probe_claude_native.py --finish-windows
```

脚本保留已通过的 WSL 测试会话和结果（标识仅在私有证据中）。只有两个不同身份的前置检查通过，才会新建 Windows Session、保留其原失败记录并继续恢复检查；本次没有执行到这些步骤。

## 复现 SSH 实验

```sh
python3 experiments/runtime/probe_remote_live.py \
  --target tester@192.0.2.10 \
  --ssh-config /home/developer/.ssh/config \
  --codex-bin /tmp/yuzuno-next-codex-rqvam2uk/node_modules/.bin/codex
```

每次新建临时 cwd/socket/runtime 和测试 Session，结束时只停止本次 PID。它不安装服务、不操作默认 daemon。Mac mini 目标由私有记录与 SSH 配置核对，并通过真实 SSH 实测；原始定位信息保留私有。

协议依据为本机生成的官方 schema 与实际握手；文档参照 [官方 App Server 文档](https://developers.openai.com/codex/app-server)、[官方 daemon README](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md) 和 [官方 Unix transport 实现](https://github.com/openai/codex/blob/main/codex-rs/app-server-transport/src/transport/unix_socket.rs)。daemon 生命周期仍标为 experimental，不能把这次小实验当成完整服务管理器的验收。
