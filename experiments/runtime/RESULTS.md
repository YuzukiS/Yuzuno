# Runtime experiment — 2026-10-12

> Public copy: hostnames, account names and absolute machine paths below are illustrative replacements. Historical outcomes remain observations of the original private environment; these example endpoints were not contacted. Raw evidence is retained privately.

> 后续真机结果已经更新：[LIVE-RUNTIME-RESULTS.md](LIVE-RUNTIME-RESULTS.md)。SSH 的真实离线工具执行、审批回补及 Runtime 重启后历史恢复已通过；Claude WSL 新建/恢复通过。Windows 重新登录后的只读核对显示两端同一账户，双账户验收未完成；后续可完全在 WSL 使用独立官方配置目录。下面是先前受限环境的原始记录。

后续真机验收前置检查见 [LIVE-ACCEPTANCE.md](LIVE-ACCEPTANCE.md)：已从旧项目私有实验资料定位 Mac mini 的真实 SSH 目标，并发现 Claude 默认／显式配置目录的身份显示歧义。下文保留第一轮实验的当时结果。

**结论：可以继续采用 Codex 原生 App Server。独立进程、配置目录和中断后历史恢复已经通过真实本地协议实验；SSH daemon 的持续执行与事件补回没有通过实机验收，原因是本轮执行环境禁止网络及 Unix socket。多账户应按 Harness 的官方配置目录绑定运行实例，不需要自建凭证仓库。**

用户当前只有一个 Codex 账户、多个 Claude 账户。本轮没有要求第二个 Codex 账户，也没有读取、复制、迁移、登录或退出任何既有账户；没有连接、重启或停止既有 daemon/session。所有实验进程使用新建临时配置目录，结束时只停止这些进程。

## 实测结果

| 实验 | 结果 | 能证明什么 / 不能证明什么 |
| --- | --- | --- |
| 本机版本 | Codex CLI 0.162.1；Claude Code 2.1.280 | 记录了实际测试二进制版本，未外推远程版本 |
| 两个 Codex stdio App Server | 两者 `initialize` 成功，分别返回 `a`、`b` 下的 `codexHome` | 真正运行官方进程，没有 Mock Runtime |
| 空配置目录认证 | 两者 `account/read(refreshToken=false)` 均返回 `account: null` | 新目录没有自动继承默认登录；未证明两个已登录账户的刷新/退出互不影响 |
| Session 归属 | 两个 thread 的 rollout 路径分别位于对应目录的 `sessions/` | 独立存储根；不是同一 OS 用户之间的安全隔离 |
| 跨目录读取 | B 读取 A 的新 thread ID 返回 `thread not loaded` | 不自动混合目录中的会话；该用例尚无首条消息持久化 |
| daemon socket 路径 | 两个 `daemon version` 分别尝试 `a/app-server-control/app-server-control.sock` 与 `b/...` | 已证实路径按配置根变化；连接因沙箱 EPERM 失败，不能写成两个 daemon 已成功并行 |
| 首条消息前的历史读取 | 默认 `paginated` 模式的 `thread/read(includeTurns=true)`、`thread/turns/list`、`thread/items/list` 报 unsupported；`legacy` 明确提示尚未 materialize | GUI 必须容忍新建空 thread 尚无可读持久历史 |
| 首条消息与 Interrupt | 两种 history mode 均接受 `turn/start`，网络请求被 EPERM 阻断并重试；12 秒后 `turn/interrupt` 成功，Turn 变为 `interrupted` | 验证了真实请求/事件/中断路径，没有成功模型推理或工具执行 |
| App Server 进程重启后恢复 | 新进程使用同一实验配置目录，`thread/read` 与 `thread/resume` 保留原用户消息、Turn ID 和 `interrupted` 状态 | 证明这些消息的持久恢复；没有证明中断工具可以无损续跑 |
| 消息落盘后的分页 | `paginated` 的 read、turns/list、items/list 均可用；`legacy` 的 read、turns/list 可用，items/list 仍 unsupported | 不应因新建空 thread 的错误而直接禁用 paginated；应按实际历史状态处理 |
| `command/exec` 环境标记 | 仅打印自定义无敏感标记的请求超时，外层沙箱模式下仍未完成；`process/spawn` 同样超时 | 没有实测出 daemon 客户端的环境继承，不把预期当成结果 |
| 两个空 Claude 配置目录 | `claude auth status --json` 均 `loggedIn=false`、`authMethod=none` | 没有继承默认目录登录；未接管用户现有多账户 |
| Socket 前置探测 | AF_UNIX 与 AF_INET 均 `PermissionError: [Errno 1] Operation not permitted` | daemon/socket/SSH 网络验收受环境限制，stdio 协议仍可测 |

原始脱敏结果：[`local-observations.json`](local-observations.json)、[`history-observations.json`](history-observations.json)。`history-observations.json` 的 `checks` 对两种模式分别记录用户消息和中断状态是否跨进程重启保留。

## SSH 与 Mac mini

用户指定 Mac mini。本轮只读核对了用户授权的私有旧版节点注册表：

- 注册项记录系统为 macOS；节点唯一标识、机器显示名、最近在线时间和旧执行目录仅保留在私有原始证据中。
- 注册项的连接地址是旧系统的本机环回转发端点，不能用作 Mac mini SSH 目标；hostname 字段为空。

用户 SSH 配置没有 Mac mini 别名。没有把 `known_hosts` 中的其他 IP 猜作 Mac mini。一次在用户指定 Mac mini 前的只读 SSH 能力探测被本机 OpenSSH 拒绝：`Bad owner or permissions on /etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf`；未建立远程连接。之后 socket 前置探测证实本轮沙箱也不允许创建网络 socket。没有远程写入。

这些限制不等于 Mac mini 本身不可连接、不支持 Codex 或不支持 daemon。远程 binary、认证、断线后的存活、离线事件与审批补回均仍待实机验证。

## 官方文档 / 实现说明支持的结论

以下是文档结论，不是本轮实机通过项：

1. Codex 的 `CODEX_HOME` 管理 config、auth、sessions 等状态；file 凭证存储位于对应根。官方也支持 keyring/auto/ephemeral，因此不能把“独立文件夹”概括为所有认证模式均已验收。[环境变量](https://learn.chatgpt.com/docs/config-file/environment-variables)、[认证](https://learn.chatgpt.com/docs/auth)
2. daemon 官方实现 README 仍标为 experimental。共享客户端继承 daemon 启动时环境，不提供 per-client 环境隔离。生命周期操作按 `CODEX_HOME` 串行，daemon 使用该目录内的管理状态；运行版本可能不同于调用管理命令的 CLI 版本。因此 GUI 需要记录实际连接到的服务端版本。README 为检索当天的 main，不冒充 0.162.1 的逐行版本审计。[官方 daemon README](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md)
3. Claude 官方明确支持每个 claude.ai 账户使用单独的 `CLAUDE_CONFIG_DIR`。macOS Keychain entry 也以配置目录区分；Linux 的 `.credentials.json` 位于对应目录。例外：两个不创建 API key 的 Claude Console OAuth 登录不因这个变量隔离。用户的 Subscription 多账户优先使用前一条官方路径。[Claude 认证与多账户](https://code.claude.com/docs/en/authentication)、[环境变量](https://code.claude.com/docs/en/env-vars)

**设计推论：** Yuzuno 保存“机器 + Harness + profile 路径 + 启动配置”的引用，创建运行实例时绑定；账户显示来自官方状态接口，不自行解析或搬运 token。同一 daemon 内的客户端参数不能当作两个认证域。进程级环境共享也不代表所有工具参数都不能覆盖：生成的 `CommandExecParams` 含有请求级 `env`，但它不是账号登录接口。

## 对第一条 GUI Slice 的直接影响

- Codex 的 `initialize` 已给出 `codexHome` 与版本信息，保留为运行来源元数据。
- 新建空 thread 的历史 API 错误不能展示成“会话损坏”或导致重复创建 Agent。
- 保留 GUI 自己的可读 Turn 缓存；Resume 成功后按 ID 合并，空响应不覆盖已存在消息。
- 真实 `turn/interrupt` 已成功；UI 可以区分“正在请求停止”与后续确认的 `interrupted`。
- 将“模型无法连接、正在重试”与“等待用户审批”区分。此次真实网络错误的 `willRetry=true`，不是 Pending 请求。
- 暂不实现统一认证管理器、自动切换账户或 daemon 服务管理框架。

## 复现

在仓库根运行；Python 标准库足够，无额外依赖：

```sh
python3 experiments/runtime/probe_local.py --output /tmp/yuzuno-runtime-observations.json
python3 experiments/runtime/probe_history.py --output /tmp/yuzuno-history-observations.json
```

第二个脚本使用新建未认证配置，发送固定测试消息；没有网络时会主动 Interrupt，不消耗现有账户额度。它测试持久化，不应被用来宣称推理成功。脚本保留独立临时目录供检查，不清理或改动现有配置。

确认 SSH target 后，可运行只读探测；此脚本不会 bootstrap/start/stop 任何远程服务：

```sh
python3 experiments/runtime/probe_ssh.py user@confirmed-mac-mini --output /tmp/yuzuno-ssh-observations.json
```

## 下一步最小实验

1. 在允许 SSH/socket 的执行环境，确认 Mac mini target 与远程实际工具版本。为隔离实验新建远程临时 profile；不修改现有 daemon。
2. 用原生 daemon/proxy 路径验证一次启动、断开客户端、重连；记录实际 daemon 版本，而不只记录 CLI 版本。
3. 在一个授权的 Codex 登录 profile 中验证一条真实长 Turn：离线完成后能取回输出；另测一次离线期间出现审批。重连、历史恢复和待处理请求分别判定。
4. 第二个 Harness 接入时选用用户已经登录的两个 Claude profile，先只读确认归属，再验证新建会话/恢复仍绑定原 profile；登录、退出和刷新实验只在专门的测试 profile 中做。

本轮在协议与文档实验结果处停止；没有为了补齐上述未验项建设 Remote Worker 或完整账户管理器。

## 附录：真实 Workspace 核心通路验收

新增 [`core/examples/protocol_smoke.rs`](../../core/examples/protocol_smoke.rs)，直接调用本仓库的公开 `Workspace` API，对接真实 Codex App Server；没有 HTTP listener，也没有 Mock Runtime。这样在 socket 受限的环境中，仍能验证 Core 的实际集成。

2026-10-12 实际运行 `cargo run --offline --example protocol_smoke` 成功。子进程使用新建的空 `CODEX_HOME`、file 凭证存储和明确的环境变量白名单；既有认证未被使用。结果记录在 [`core-observations.json`](core-observations.json)。

实际通过的链路：

1. `Workspace::create` 创建持久 Agent，等待异步原生 thread 建立并进入 idle。
2. `Workspace::send` 发送固定测试文本，等待真正的 `item/started` / `item/completed` 用户消息进入 Core Store。
3. `Workspace::interrupt` 得到 ACK，再等待真正的 `turn/completed` 和 `interrupted` 状态；数据库 journal 中存在原生完成事件。
4. 用户消息在中断后仍可读取。
5. 销毁此示例专用的 Tokio runtime，让后台任务及其拥有的测试 App Server 一起结束；随后重开 SQLite Store。
6. 重开的 Agent ID、名称、目标、原生 Thread ID、Turn 内容与用户消息均保留；运行状态变为 `offline`，没有把持久记录误认成仍活着的进程。

报告中 `passed=true`，五个持久化检查全部为 `true`。本例在观察到用户消息后立即 Interrupt，**不声称完成模型推理、文件修改、审批往返或 GUI 操作验收**。

运行示例需要先为子进程提供一个新建的临时配置目录，写入 `cli_auth_credentials_store = "file"`，并清除继承的 provider 凭据环境。示例会拒绝默认目录、包含 `auth.json` 的目录及已设置的常见 Codex 凭据变量。可将 JSON 输出路径作为 executable 的第一个参数传入：

```sh
cargo run --offline --example protocol_smoke -- /tmp/yuzuno-core-observations.json
```

本机运行时另为 Cargo 子进程指定了 `/tmp/yuzuno-cargo-home` 作为可写缓存，Rustup 使用已安装工具链；没有更改用户全局 Cargo、Rustup 或 Codex 配置。
