# 空 Session 恢复修复与实测

2026-10-12，Codex CLI 0.162.1。所有原生进程使用新建临时 `CODEX_HOME`、file 凭据存储和受限环境变量；没有复制认证、连接现有 daemon 或发送模型 Turn。

## 原生错误已复现

第一个 stdio App Server 创建 thread 后不发消息，结束该进程；第二个进程恢复同一 thread，得到：

```json
{"code":-32600,"message":"no rollout found for thread id <exact-thread-id>"}
```

同条件的 `thread/read` 为 `-32600 / thread not loaded: <id>`。**只有前一个完整错误形式**可用于识别没有 rollout；错误码相同、权限错误、另一个 thread ID、额外 error data、普通未加载状态都不触发重建。

[原始脱敏协议结果](empty-session-native-observations.json)，[复现脚本](empty-session-probe.py)。

## 修复的范围

- RPC 保留官方错误的 code、message、data，恢复逻辑不再只能观察显示文案。
- 新建 thread 的成功 attachment 记录保护版本；每次 `turn/start` 在发往进程前先持久记录 `turn/requested`，同时标记请求结果尚待确认。
- 只有明确的未落盘错误，加上“由有此保护的新版本创建、没有任何 Turn 尝试／Item／Pending／未知操作证据”的空 thread，才申请新 native thread。Workspace Agent ID、名称与目标保持。
- 重建意图在发请求前落盘；中断、超时或崩溃留下未知结果时，不能自动再创建。旧版本没有保护记录的空 Session 保守报错，不猜测它是否在崩溃前发送过任务。
- Core 为 Workspace 数据库持有跨进程 OS 独占锁。第二个 Core 即使使用另一端口，也无法打开同一 Workspace 并把第一个 Core 的状态误改为 offline。不同数据目录可并行运行。

## 实际验证

正常测试套件全部通过：22 项测试，另有 1 项默认忽略的原生 smoke。本次已明确启用并运行该 smoke，结果通过：

1. 第一代 Core 创建空 Agent，取得原生 thread，未发消息。
2. 终止该测试专用 runtime，包括它拥有的 App Server；第二代 Core 打开相同数据，恢复同一 Agent，为已确认未落盘的空 Session 创建新 thread。
3. 再次完整重启；第三代 Core 同样恢复成功。

三次 Agent ID 相同、native Thread ID 各不相同、状态均为 idle、Turn 数均为 0。结果见 [empty-session-core-observations.json](empty-session-core-observations.json)。这验证空会话恢复，不宣称成功模型推理。

新回归覆盖：权限／其他错误不满足缺失判据；已有 Turn、曾尝试 Turn、未知操作、旧版本无日志均禁止替换；重建预约不能重复执行且跨重启保留；第二个 Store 无法打开同一数据库且第一份状态不变；独立目录和释放后的再次打开成功。

## 复现

```sh
python3 experiments/runtime/empty-session-probe.py \
  --output /tmp/yuzuno-empty-native.json
cargo test --offline -p yuzuno-workspace --test empty_session_recovery
```

原生 Core smoke 要求外部提供一个新建临时 `CODEX_HOME`，其 `config.toml` 含 `cli_auth_credentials_store = "file"`，没有 `auth.json`，并清除继承的 provider 凭据变量。只运行这一项：

```sh
cargo test --offline -p yuzuno-workspace --lib \
  workspace::tests::real_empty_session_reopens_without_a_model_turn \
  -- --ignored --exact --nocapture
```

可通过 `YUZUNO_EMPTY_REPORT` 指定结果 JSON 输出路径。测试拒绝默认用户配置和包含现有认证的目录。
