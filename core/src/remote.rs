//! SSH-first execution. OpenSSH owns authentication and encrypted forwarding;
//! the remote helper exits after a bounded operation and never reads credentials.
use crate::rpc::Rpc;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    process::Command,
    time::{sleep, timeout, Duration, Instant},
};

const HELPER: &str = include_str!("remote_helper.py");
const FILE_LIMIT: usize = 8 * 1024 * 1024;
/// The packaged Claude runtime (bridge, host, official SDK) is at most this.
const CLAUDE_RUNTIME_LIMIT: u64 = 256 * 1024 * 1024;

/// Everything Yuzuno keeps on a remote machine lives under one folder of
/// that account, its data root: this one unless the machine names another.
pub const DEFAULT_ROOT: &str = "~/.yuzuno";
/// The data root of Agents and Jobs recorded before machines had one. Only
/// those records are routed here; nothing new is created in it.
pub const LEGACY_ROOT: &str = "~/.yuzuno-next";

/// Unpacks a Claude runtime archive from stdin into its content-addressed,
/// private directory. Regular files only, no absolute or parent paths, and
/// the directory appears complete or not at all. Reads no credentials.
const CLAUDE_INSTALL: &str = r#"
import json, os, shutil, stat, sys, tarfile, uuid
from pathlib import Path
import re
digest, given = sys.argv[1], sys.argv[2]
if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
    raise SystemExit("Claude Runtime 摘要无效")
parts = given[2:].split("/") if given.startswith("~/") else given[1:].split("/") if given.startswith("/") else []
if len(given) > 1024 or not parts or any(p in (".", "..") or not re.fullmatch(r"[A-Za-z0-9._-]+", p) for p in parts):
    raise SystemExit("数据目录无效")
def private(path):
    try:
        path.mkdir(mode=0o700, exist_ok=True)
    except FileNotFoundError:
        raise SystemExit(f"{path.parent} 不存在；数据目录的上级目录必须已存在")
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SystemExit("Runtime 目录必须由当前用户独占且不能是符号链接")
base = (Path.home() if given.startswith("~/") else Path("/")).joinpath(*parts)
private(base)
private(base / "claude-runtime")
final = base / "claude-runtime" / digest
def complete(root):
    return (root / "bridge.mjs").is_file() and (root / "remote-host.mjs").is_file() and \
        (root / "node_modules" / "@anthropic-ai" / "claude-agent-sdk" / "package.json").is_file()
if complete(final):
    while sys.stdin.buffer.read(1 << 20):
        pass
    print(json.dumps({"root": str(final), "installed": False}))
    raise SystemExit(0)
temporary = base / "claude-runtime" / ("." + digest + "." + uuid.uuid4().hex + ".tmp")
temporary.mkdir(mode=0o700)
try:
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz") as archive:
        for member in archive:
            parts = Path(member.name).parts
            if member.isdir():
                continue
            if not member.isfile() or not parts or Path(member.name).is_absolute() or ".." in parts:
                raise SystemExit("Claude Runtime 包含不允许的条目")
            target = temporary.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            with open(target, "wb") as output:
                shutil.copyfileobj(source, output)
            os.chmod(target, 0o755 if member.mode & 0o100 else 0o644)
    if not complete(temporary):
        raise SystemExit("Claude Runtime 不完整")
    if final.exists():
        shutil.rmtree(temporary)
    else:
        os.rename(temporary, final)
except BaseException:
    shutil.rmtree(temporary, ignore_errors=True)
    raise
print(json.dumps({"root": str(final), "installed": True}))
"#;

/// Joins this SSH session's stdin/stdout to a Claude host's private socket.
/// The host keeps running when the session ends.
const CLAUDE_ATTACH: &str = r#"
import os, socket, sys, threading
connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
connection.connect(sys.argv[1])
def upstream():
    try:
        while True:
            data = os.read(0, 65536)
            if not data:
                break
            connection.sendall(data)
    except OSError:
        pass
    finally:
        try:
            connection.shutdown(socket.SHUT_WR)
        except OSError:
            pass
threading.Thread(target=upstream, daemon=True).start()
while True:
    data = connection.recv(65536)
    if not data:
        break
    view = memoryview(data)
    while view:
        view = view[os.write(1, view):]
"#;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMachine {
    pub id: String,
    pub name: String,
    pub target: String,
    pub codex: String,
    pub default_cwd: String,
    /// The machine's data root (see `validate_root`). None on a registered
    /// machine means DEFAULT_ROOT; an Agent's copy always names one (see
    /// model::RemoteAgent), and a Job records the one it was started in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_root: Option<String>,
    /// Native sessions there keep their own folders under the data root
    /// too: Claude's config, temporary and XDG folders (`session_folders` in
    /// remote_helper.py), and no Codex Agent runs there, since Codex keeps
    /// its sessions in ~/.codex. Off, an Agent uses that account's own CLI
    /// login and folders, as before.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub contained: bool,
    /// The next three are settings for Jobs admission on that machine
    /// (T-108), applied when an attempt takes its slot there
    /// (jobs::remote::reserve_remote) and, for the mode, by the helper there.
    ///
    /// At most this many attempts there at once, 1–64 (None: two); only a
    /// ceiling, beside CPU and RAM admission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_jobs: Option<u32>,
    /// What attempts there may reserve together on that host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<MachineBudget>,
    /// `strict` (what a machine added now gets unless it chooses): a limit
    /// the machine cannot hold for as long as the job runs is refused;
    /// `limited`: it runs with what is held and says what is not; None (a
    /// machine registered before limits, or set back to it): the
    /// record-only behaviour it had, nothing held (jobs::remote LEGACY).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_mode: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineBudget {
    pub cpu_millis: u32,
    #[serde(rename = "memoryMiB")]
    pub memory_mib: u32,
}

impl RemoteMachine {
    /// Where this machine's runtimes, image copies and Job attempts go.
    pub fn root(&self) -> &str {
        self.data_root.as_deref().unwrap_or(DEFAULT_ROOT)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRef {
    pub root: String,
    pub socket: String,
    pub pid: u32,
    pub codex: String,
    pub instance_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub hostname: String,
    pub platform: String,
    pub home: String,
    #[serde(default)]
    pub codex: Option<String>,
    #[serde(default)]
    pub codex_version: Option<String>,
    #[serde(default)]
    pub codex_error: Option<String>,
    #[serde(default)]
    pub default_cwd: Option<String>,
    #[serde(default)]
    pub default_cwd_error: Option<String>,
    /// The machine's data root there, as an absolute path, and why it can't
    /// be used, if so. Checked only: the check creates nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_root_error: Option<String>,
    /// Claude on that machine: its Node.js and its own installed CLI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_error: Option<String>,
    /// `claude auth status` there, run as SSH runs it: logged in or not, and
    /// the method's name. No account details.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_logged_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_auth_method: Option<String>,
}

/// A remote Claude host (runtimes/claude/remote-host.mjs) as the helper found
/// or started it for one Workspace/Agent.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHost {
    pub root: String,
    pub socket: String,
    pub pid: u32,
    pub runtime: String,
    pub instance_id: String,
    /// Another connection was attached when this one asked; the host replaces it.
    #[serde(default)]
    pub attached: bool,
}

pub fn validate_machine(machine: &RemoteMachine) -> Result<()> {
    for (label, value, limit) in [
        ("机器标识", &machine.id, 128),
        ("机器名称", &machine.name, 128),
        ("SSH 目标", &machine.target, 255),
        ("Codex 路径", &machine.codex, 4096),
        ("工作目录", &machine.default_cwd, 4096),
    ] {
        if value.trim().is_empty() || value.len() > limit || value.chars().any(char::is_control) {
            bail!("{label}为空、过长或包含控制字符");
        }
    }
    // A single destination argument, never options or remote shell syntax.
    // Ports/jump hosts belong in the existing OpenSSH configuration.
    if machine.target.starts_with('-')
        || !machine
            .target
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-@[]:".contains(c))
    {
        bail!("SSH 目标应是已有 Host 别名或 user@hostname；端口和跳板机请写入 SSH 配置");
    }
    if machine.codex.starts_with('-') {
        bail!("Codex 必须是可执行文件名或路径");
    }
    if let Some(root) = &machine.data_root {
        validate_root(root)?;
    }
    if machine.max_jobs.is_some_and(|jobs| !(1..=64).contains(&jobs)) {
        bail!("maxJobs 应在 1–64 之间");
    }
    if machine.budget.as_ref().is_some_and(|budget| budget.cpu_millis < 100 || budget.memory_mib < 64) {
        bail!("budget 至少要 cpuMillis 100、memoryMiB 64");
    }
    if machine.limit_mode.as_deref().is_some_and(|mode| !matches!(mode, "strict" | "limited")) {
        bail!("limitMode 只能是 strict 或 limited");
    }
    Ok(())
}

/// A data root as a machine names it: `~/<folder>` in that account's home or
/// an absolute folder, of plain names only, so it is never shell syntax or a
/// way out of the folder. The helpers check it again before using it.
pub fn validate_root(root: &str) -> Result<()> {
    let plain = |part: &str| {
        !part.is_empty() && part != "." && part != ".."
            && part.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    let rest = root.strip_prefix("~/").or_else(|| root.strip_prefix('/'));
    if root.len() > 1024 || !rest.is_some_and(|rest| rest.split('/').all(plain)) {
        bail!("数据目录应是 ~/<目录> 或绝对路径，每段只含字母、数字和 . _ -，且不能是 . 或 ..");
    }
    Ok(())
}

/// `relative` under a data root as one shell word: `"$HOME"/'…'` for a root
/// in the home folder.
fn root_word(root: &str, relative: &str) -> String {
    match root.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"/{}", shell_quote(&format!("{rest}/{relative}"))),
        None => shell_quote(&format!("{root}/{relative}")),
    }
}

pub(crate) fn ssh() -> Command {
    ssh_with("ssh")
}

/// The same OpenSSH invocation through another program with ssh's argument
/// conventions; tests use a stand-in that runs the remote command locally.
pub(crate) fn ssh_with(program: &str) -> Command {
    ssh_with_control(program, Control::Off)
}

/// Whether an invocation shares a connection, always through a socket Core
/// names: never the user's ControlMaster or ControlPersist (OpenSSH keeps
/// the first value given for an option, so these come before any config).
pub(crate) enum Control<'a> {
    /// Its own connection, as every call had before T-163.
    Off,
    /// The master of the connection at this socket; it stays in the
    /// foreground, a child of whoever started it.
    Master(&'a Path),
    /// A session through the master at this socket. Where none answers
    /// there, OpenSSH connects directly instead.
    Client(&'a Path),
}

/// `ssh_with`, sharing a connection as `control` says.
pub(crate) fn ssh_with_control(program: &str, control: Control<'_>) -> Command {
    let (master, path, persist) = match control {
        Control::Off => ("ControlMaster=no".to_owned(), "ControlPath=none".to_owned(), None),
        Control::Master(path) => ("ControlMaster=yes".to_owned(), format!("ControlPath={}", path.display()), Some("ControlPersist=no")),
        Control::Client(path) => ("ControlMaster=no".to_owned(), format!("ControlPath={}", path.display()), None),
    };
    let mut command = Command::new(program);
    if let Some(persist) = persist {
        command.args(["-o", persist]);
    }
    command
        .args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ConnectionAttempts=1",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "UpdateHostKeys=no",
            "-o",
            master.as_str(),
            "-o",
            path.as_str(),
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            "ForwardAgent=no",
            "-o",
            "ForwardX11=no",
            "-o",
            "RemoteCommand=none",
        ])
        .kill_on_drop(true);
    command
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

async fn helper(machine: &RemoteMachine, request: Value, maximum: usize) -> Result<Vec<u8>> {
    validate_machine(machine)?;
    let operation = async {
        let mut child = ssh()
            .args(["-o", "ClearAllForwardings=yes"])
            .arg(&machine.target)
            // Only fixed repository helper code enters the shell command. All
            // variable paths, executable names and IDs travel in JSON stdin.
            .arg(format!("python3 -c {}", shell_quote(HELPER)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("无法启动 OpenSSH")?;
        let mut stdin = child.stdin.take().context("SSH stdin 不可用")?;
        let mut stdout = child
            .stdout
            .take()
            .context("SSH stdout 不可用")?
            .take(maximum as u64 + 1);
        let mut stderr = child.stderr.take().context("SSH stderr 不可用")?.take(8192);
        let payload = serde_json::to_vec(&request)?;
        let input = async move {
            stdin.write_all(&payload).await?;
            stdin.shutdown().await
        };
        let output = async {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).await?;
            Result::<Vec<u8>>::Ok(bytes)
        };
        let errors = async {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).await?;
            Result::<Vec<u8>>::Ok(bytes)
        };
        let (_, bytes, errors) = tokio::try_join!(
            async { input.await.map_err(anyhow::Error::from) },
            output,
            errors
        )?;
        let status = child.wait().await?;
        if !status.success() {
            bail!("远程操作失败：{}", String::from_utf8_lossy(&errors).trim());
        }
        if bytes.len() > maximum {
            bail!("远程返回内容超过允许大小");
        }
        Ok(bytes)
    };
    timeout(Duration::from_secs(65), operation)
        .await
        .context("SSH 操作超时；远程 Runtime 若已启动会继续保留")?
}

pub async fn probe(machine: &RemoteMachine) -> Result<RemoteInfo> {
    Ok(serde_json::from_slice(
        &helper(
            machine,
            json!({
                "action":"probe", "codex":machine.codex, "defaultCwd":machine.default_cwd,
                "root":machine.root(), "contained":machine.contained
            }),
            16 * 1024,
        )
        .await?,
    )
    .context("无法解析远程能力信息")?)
}

pub async fn canonicalize(machine: &RemoteMachine, path: &str) -> Result<String> {
    Ok(serde_json::from_slice(
        &helper(
            machine,
            json!({"action":"canonicalize","path":path}),
            16 * 1024,
        )
        .await?,
    )?)
}

pub async fn ensure_runtime(
    machine: &RemoteMachine,
    workspace_key: &str,
    agent_id: &str,
) -> Result<RuntimeRef> {
    Ok(serde_json::from_slice(&helper(machine, json!({
        "action":"ensure", "codex":machine.codex, "workspaceKey":workspace_key, "agentId":agent_id,
        "root":machine.root(), "contained":machine.contained
    }), 16 * 1024).await?).context("无法解析远程 Runtime 信息")?)
}

/// Verify the recorded Workspace/Agent runtime and stop it. Never signal a PID
/// from the browser or an unverified/replaced remote instance.
pub async fn stop_runtime(
    machine: &RemoteMachine, workspace_key: &str, agent_id: &str,
    runtime: Option<&RuntimeRef>,
) -> Result<()> {
    let result: Value = serde_json::from_slice(&helper(machine, json!({
        "action":"stop", "workspaceKey":workspace_key, "agentId":agent_id, "runtime":runtime,
        "root":machine.root()
    }), 16 * 1024).await?)?;
    anyhow::ensure!(result["stopped"] == true, "无法确认远程 Runtime 已停止；Agent 未关闭");
    Ok(())
}

pub async fn read_artifact(machine: &RemoteMachine, cwd: &str, path: &str) -> Result<Vec<u8>> {
    helper(
        machine,
        json!({"action":"read","cwd":cwd,"path":path}),
        FILE_LIMIT,
    )
    .await
}

/// The Claude runtime directory's files Core uploads: the bridge and host
/// modules, the package manifests and the installed dependencies. The bridge
/// explicitly resolves the remote machine's own CLI, so local platform CLI
/// binaries bundled by newer SDKs are neither needed nor portable. No tests,
/// no `.bin` links, no symlinks.
fn claude_runtime_files(root: &std::path::Path) -> Result<Vec<(String, std::path::PathBuf)>> {
    fn walk(dir: &std::path::Path, prefix: &str, depth: usize, out: &mut Vec<(String, std::path::PathBuf)>) -> Result<()> {
        anyhow::ensure!(depth < 48, "Claude Runtime 目录层级过深");
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<std::io::Result<_>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            // A worktree may link node_modules to another checkout's; follow
            // that link, but never one inside the dependency tree.
            let kind = entry.file_type()?;
            let followed = if kind.is_symlink() && depth == 0 && name == "node_modules" { std::fs::metadata(&path)? } else if kind.is_symlink() { continue } else { entry.metadata()? };
            if followed.is_dir() {
                if name == ".bin" || (depth == 0 && name != "node_modules") {
                    continue;
                }
                if prefix == "node_modules/@anthropic-ai" && matches!(name.as_str(),
                    "claude-agent-sdk-linux-x64" | "claude-agent-sdk-linux-arm64"
                    | "claude-agent-sdk-linux-x64-musl" | "claude-agent-sdk-linux-arm64-musl"
                    | "claude-agent-sdk-darwin-x64" | "claude-agent-sdk-darwin-arm64"
                    | "claude-agent-sdk-win32-x64" | "claude-agent-sdk-win32-arm64") {
                    continue;
                }
                walk(&path, &relative, depth + 1, out)?;
            } else if followed.is_file() {
                let wanted = depth > 0
                    || matches!(name.as_str(), "package.json" | "package-lock.json")
                    || (name.ends_with(".mjs") && !name.ends_with(".test.mjs"));
                if wanted {
                    out.push((relative, path));
                }
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(root, "", 0, &mut files)?;
    for required in ["bridge.mjs", "remote-host.mjs", "node_modules/@anthropic-ai/claude-agent-sdk/package.json"] {
        anyhow::ensure!(files.iter().any(|(name, _)| name == required), "本机 Claude Runtime 缺少 {required}；请安装其依赖");
    }
    Ok(files)
}

/// The local Claude runtime as one archive and its digest. Deterministic:
/// sorted entries, fixed times and owners, so equal content has one digest.
pub fn claude_runtime_archive(root: &std::path::Path) -> Result<(String, Vec<u8>)> {
    use sha2::{Digest, Sha256};
    let files = claude_runtime_files(root)?;
    let mut size = 0u64;
    let mut archive = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default()));
    for (name, path) in &files {
        let bytes = std::fs::read(path)?;
        size += bytes.len() as u64;
        anyhow::ensure!(size <= CLAUDE_RUNTIME_LIMIT, "本机 Claude Runtime 超过上传上限");
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(path)?.permissions().mode() & 0o100 != 0
        };
        #[cfg(not(unix))]
        let executable = false;
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(if executable { 0o755 } else { 0o644 });
        header.set_mtime(0);
        header.set_uid(0);
        header.set_gid(0);
        header.set_entry_type(tar::EntryType::Regular);
        archive.append_data(&mut header, name, bytes.as_slice())?;
    }
    let bytes = archive.into_inner()?.finish()?;
    Ok((format!("{:x}", Sha256::digest(&bytes)), bytes))
}

/// The archive of the local runtime at `root` (claude_sdk::runtime_root: the
/// bridge's own, or its prepared copy), built once per Core process: a
/// release's runtime does not change while Core runs.
pub fn claude_runtime_cached(root: &std::path::Path) -> Result<(String, Arc<Vec<u8>>)> {
    static CACHE: std::sync::Mutex<Option<(std::path::PathBuf, String, Arc<Vec<u8>>)>> = std::sync::Mutex::new(None);
    let root = root.to_path_buf();
    let mut cache = CACHE.lock().unwrap();
    if let Some((cached, digest, archive)) = cache.as_ref().filter(|(cached, ..)| *cached == root) {
        let _ = cached;
        return Ok((digest.clone(), archive.clone()));
    }
    let (digest, archive) = claude_runtime_archive(&root)?;
    let archive = Arc::new(archive);
    *cache = Some((root, digest.clone(), archive.clone()));
    Ok((digest, archive))
}

fn claude_digest_valid(digest: &str) -> bool {
    digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The Node and the PATH the helper found Claude Code with on a machine
/// (remote_helper.py tool_path): the ones `claude_ensure` starts the host
/// with, which a direct bridge uses as they are.
#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeTools {
    pub node: String,
    pub path: String,
}

/// Installs this Core's Claude runtime on the machine, unless that exact
/// content is already there. Only into <data root>/claude-runtime/<digest>;
/// no global Node, npm or CLI change, and no credentials are sent.
pub async fn claude_install(machine: &RemoteMachine, digest: &str, archive: &[u8]) -> Result<ClaudeTools> {
    validate_machine(machine)?;
    anyhow::ensure!(claude_digest_valid(digest), "Claude Runtime 摘要无效");
    let installed: Value = serde_json::from_slice(&helper(machine, json!({"action":"claude_runtime","digest":digest,"root":machine.root(),"contained":machine.contained}), 32 * 1024).await?)?;
    let node = installed["node"].as_str()
        .filter(|node| node.starts_with('/') && !node.chars().any(char::is_control))
        .context("远程机器找不到 Node.js；请先安装 Node 20 或更新版本")?
        .to_owned();
    let path = installed["path"].as_str()
        .filter(|path| !path.is_empty() && path.len() <= 16 * 1024 && !path.chars().any(char::is_control))
        .context("远程 helper 没有给出有效的 PATH")?
        .to_owned();
    let tools = ClaudeTools { node, path };
    if installed["installed"] == true {
        return Ok(tools);
    }
    let operation = async {
        let mut child = ssh()
            .args(["-o", "ClearAllForwardings=yes"])
            .arg(&machine.target)
            .arg(format!("python3 -c {} {} {}", shell_quote(CLAUDE_INSTALL), shell_quote(digest), shell_quote(machine.root())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("无法启动 OpenSSH")?;
        let mut stdin = child.stdin.take().context("SSH stdin 不可用")?;
        let payload = archive.to_vec();
        let writer = tokio::spawn(async move {
            stdin.write_all(&payload).await?;
            stdin.shutdown().await
        });
        let output = child.wait_with_output().await?;
        writer.await??;
        if !output.status.success() {
            bail!("无法安装远程 Claude Runtime：{}", String::from_utf8_lossy(&output.stderr).trim().chars().take(500).collect::<String>());
        }
        Ok(tools)
    };
    timeout(Duration::from_secs(300), operation).await.context("上传 Claude Runtime 超时")?
}

/// Finds or starts this Workspace/Agent's Claude host on the machine.
pub async fn claude_ensure(machine: &RemoteMachine, workspace_key: &str, agent_id: &str, digest: &str) -> Result<ClaudeHost> {
    let host: ClaudeHost = serde_json::from_slice(&helper(machine, json!({
        "action":"claude_ensure", "workspaceKey":workspace_key, "agentId":agent_id, "digest":digest,
        "root":machine.root(), "contained":machine.contained
    }), 16 * 1024).await?).context("无法解析远程 Claude Runtime 信息")?;
    anyhow::ensure!(
        host.socket.starts_with('/') && !host.socket.chars().any(char::is_control),
        "远程 Claude Runtime socket 路径无效"
    );
    Ok(host)
}

/// SSH joined to the host's socket: its stdin and stdout carry the bridge
/// protocol, as a local bridge's do. The host outlives this session.
pub fn claude_attach_command(machine: &RemoteMachine, host: &ClaudeHost) -> Result<Command> {
    validate_machine(machine)?;
    let mut command = ssh();
    command
        .args(["-o", "ClearAllForwardings=yes"])
        .arg(&machine.target)
        .arg(format!("python3 -c {} {}", shell_quote(CLAUDE_ATTACH), shell_quote(&host.socket)));
    Ok(command)
}

/// SSH running the installed runtime's bridge directly, for one bounded
/// request (the model catalog); it ends with the session.
pub fn claude_direct_command(machine: &RemoteMachine, digest: &str, tools: &ClaudeTools) -> Result<Command> {
    validate_machine(machine)?;
    anyhow::ensure!(claude_digest_valid(digest), "Claude Runtime 摘要无效");
    let ClaudeTools { node, path } = tools;
    anyhow::ensure!(node.starts_with('/') && !node.chars().any(char::is_control), "远程 Node 路径无效");
    anyhow::ensure!(!path.chars().any(char::is_control), "远程 PATH 无效");
    let mut command = ssh();
    let root = machine.root();
    // The helper's Node and the PATH it resolved (remote_helper.py
    // tool_path), so the bridge finds the same Claude Code as the host. On a
    // contained machine, the same session folders under the data root as
    // the host's; claude_install made them.
    let mut env = format!("PATH={}", shell_quote(path));
    if machine.contained {
        for (name, folder) in SESSION_FOLDERS {
            env.push_str(&format!(" {name}={}", root_word(root, folder)));
        }
        env.push_str(" DISABLE_AUTOUPDATER=1");
    }
    command.args(["-o", "ClearAllForwardings=yes"]).arg(&machine.target).arg(format!(
        "{env} exec {} {}",
        shell_quote(node),
        root_word(root, &format!("claude-runtime/{digest}/bridge.mjs"))
    ));
    Ok(command)
}

/// A contained machine's session folders under its data root, as
/// remote_helper.py `session_folders` makes them.
const SESSION_FOLDERS: [(&str, &str); 6] = [
    ("CLAUDE_CONFIG_DIR", "claude-config"),
    ("TMPDIR", "tmp"),
    ("XDG_CACHE_HOME", "xdg/cache"),
    ("XDG_CONFIG_HOME", "xdg/config"),
    ("XDG_DATA_HOME", "xdg/data"),
    ("XDG_STATE_HOME", "xdg/state"),
];

pub async fn connect(
    machine: &RemoteMachine,
    runtime: &RuntimeRef,
    events: crate::backlog::EventSender,
) -> Result<Arc<Rpc>> {
    validate_machine(machine)?;
    if !runtime.socket.starts_with('/')
        || runtime.socket.contains(':')
        || runtime.socket.chars().any(char::is_control)
    {
        bail!("远程 Runtime socket 路径无效");
    }
    // Reserve an available loopback port. SSH's ExitOnForwardFailure detects
    // another process winning the small handoff race; no public listener.
    let reservation = TcpListener::bind("127.0.0.1:0").await?;
    let port = reservation.local_addr()?.port();
    drop(reservation);
    let mut tunnel = ssh()
        .args([
            "-N",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "GatewayPorts=no",
            "-L",
        ])
        .arg(format!("127.0.0.1:{port}:{}", runtime.socket))
        .arg(&machine.target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("无法启动 SSH 隧道")?;
    // Drain stderr immediately; a long-lived tunnel must never block on logs.
    // Retain only an initial bounded diagnostic, never native tool output.
    let stderr = tunnel.stderr.take().context("SSH stderr 不可用")?;
    let diagnostic = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let diagnostic_writer = diagnostic.clone();
    tokio::spawn(async move {
        let mut stream = stderr;
        let mut buffer = [0; 1024];
        while let Ok(size) = stream.read(&mut buffer).await {
            if size == 0 {
                break;
            }
            let mut kept = diagnostic_writer.lock().await;
            let keep = size.min(8192usize.saturating_sub(kept.len()));
            kept.extend_from_slice(&buffer[..keep]);
        }
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    let url = format!("ws://127.0.0.1:{port}");
    loop {
        if let Some(status) = tunnel.try_wait()? {
            bail!(
                "SSH 隧道启动失败（{status}）：{}",
                String::from_utf8_lossy(&diagnostic.lock().await).trim()
            );
        }
        if let Ok(Ok((socket, _))) = timeout(
            Duration::from_secs(2),
            tokio_tungstenite::connect_async(&url),
        )
        .await
        {
            // Do not accept a connection if SSH failed to bind and an unrelated
            // local listener happened to answer at the reserved port.
            if tunnel.try_wait()?.is_some() {
                bail!("SSH 隧道在握手期间退出");
            }
            return Ok(Rpc::websocket(socket, tunnel, events));
        }
        if Instant::now() >= deadline {
            let _ = tunnel.kill().await;
            let _ = tunnel.wait().await;
            bail!("SSH 已启动但远程 Codex WebSocket 未就绪；请检查连接与 Runtime");
        }
        sleep(Duration::from_millis(150)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn runtime_helpers_serialize_startup_and_recover_only_after_process_exit() {
        use std::{io::Write, os::unix::fs::PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("fake-codex");
        std::fs::write(
            &executable,
            r#"#!/usr/bin/python3
import os,socket,sys,time
from pathlib import Path
sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
sock.bind(sys.argv[-1][len('unix://'):])
sock.listen(10)
with (Path.home()/'starts').open('a') as output: output.write(str(os.getpid())+'\n')
while True:
    connection,_=sock.accept()
    connection.close()
"#,
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let home = temp.path().to_path_buf();
        let payload=serde_json::to_vec(&json!({"action":"ensure","codex":executable,"workspaceKey":"isolated-test","agentId":"agent-one","root":DEFAULT_ROOT})).unwrap();
        let run = move || {
            let mut child = std::process::Command::new("python3")
                .args(["-c", HELPER])
                .env("HOME", &home)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(&payload).unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            serde_json::from_slice::<RuntimeRef>(&output.stdout).unwrap()
        };
        // Each helper is a separate OS process, exercising the actual flock.
        let helpers: Vec<_> = (0..4)
            .map(|_| {
                let run = run.clone();
                std::thread::spawn(run)
            })
            .collect();
        let runtimes: Vec<_> = helpers.into_iter().map(|h| h.join().unwrap()).collect();
        let first = &runtimes[0];
        struct Cleanup(u32);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", &self.0.to_string()])
                    .status();
            }
        }
        let cleanup = Cleanup(first.pid);
        for runtime in &runtimes[1..] {
            assert_eq!(runtime.pid, first.pid);
            assert_eq!(runtime.instance_id, first.instance_id);
        }
        assert_eq!(
            std::fs::read_to_string(temp.path().join("starts"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert_eq!(
            run().instance_id,
            first.instance_id,
            "detached process survives every helper exit"
        );
        // The official Node launcher can exec a native binary: its command
        // changes, but the persisted birth time still identifies this runtime.
        let metadata_path = std::path::Path::new(&first.root).join("runtime.json");
        let mut metadata: Value =
            serde_json::from_slice(&std::fs::read(&metadata_path).unwrap()).unwrap();
        let birth = metadata["processIdentity"]
            .as_str()
            .unwrap()
            .split_whitespace()
            .take(5)
            .collect::<Vec<_>>()
            .join(" ");
        metadata["processIdentity"] = json!(format!("{birth} launcher-before-exec"));
        std::fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();
        assert_eq!(run().instance_id, first.instance_id);
        // A live process with an unavailable socket must not spawn a duplicate,
        // including after the launcher's command changed during startup.
        std::fs::remove_file(&first.socket).unwrap();
        let mut retry = std::process::Command::new("python3")
            .args(["-c", HELPER])
            .env("HOME", temp.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        retry.stdin.take().unwrap().write_all(&serde_json::to_vec(&json!({"action":"ensure","codex":executable,"workspaceKey":"isolated-test","agentId":"agent-one","root":DEFAULT_ROOT})).unwrap()).unwrap();
        assert!(!retry.wait_with_output().unwrap().status.success());
        assert_eq!(
            std::fs::read_to_string(temp.path().join("starts"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        drop(cleanup);
        std::thread::sleep(std::time::Duration::from_millis(150));
        // macOS Codex may leave a shortened socket target + a private symlink
        // after a hard crash. Only the owned link may be removed on recovery.
        let native_socket = temp.path().join("native-short.sock");
        drop(std::os::unix::net::UnixListener::bind(&native_socket).unwrap());
        std::os::unix::fs::symlink(&native_socket, &first.socket).unwrap();
        let replacement = run();
        let _cleanup = Cleanup(replacement.pid);
        assert!(
            native_socket.exists(),
            "never remove Codex's external symlink target"
        );
        assert!(!std::fs::symlink_metadata(&first.socket)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_ne!(replacement.instance_id, first.instance_id);
        assert_eq!(replacement.root, first.root);
        assert_eq!(
            std::fs::read_to_string(temp.path().join("starts"))
                .unwrap()
                .lines()
                .count(),
            2
        );
    }
    #[cfg(unix)]
    #[test]
    fn remote_stop_checks_instance_and_process_identity_and_preserves_files() {
        let script = format!(r##"
namespace = {{"__name__":"helper_fixture"}}
exec({helper:?}, namespace)
import json, os, signal, tempfile
from pathlib import Path
with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    namespace["Path"].home = classmethod(lambda cls: home)
    executable = home / "codex"
    executable.write_text("#!/usr/bin/python3\nimport socket,sys\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)\ns.bind(sys.argv[-1][7:])\ns.listen(10)\nwhile True:\n c,_=s.accept();c.close()\n")
    executable.chmod(0o700)
    request = {{"workspaceKey":"management-test", "agentId":"owned", "codex":str(executable), "root":"~/.yuzuno"}}
    ensure, stop = namespace["ensure_runtime"], namespace["stop_runtime"]
    runtime = ensure(request)
    project = home / "project.txt"
    project.write_text("preserve")
    def rejected(value):
        try: stop(value)
        except ValueError: return
        raise AssertionError("unsafe stop accepted")
    try:
        wrong = dict(runtime, instanceId="different-instance")
        rejected(dict(request, runtime=wrong))
        assert namespace["ready"](runtime)
        metadata = Path(runtime["root"]) / "runtime.json"
        forged = dict(runtime, processIdentity="Mon Jan 1 00:00:00 1900 foreign process")
        metadata.write_text(json.dumps(forged))
        rejected(dict(request, runtime=runtime))
        assert namespace["ready"](runtime), "identity mismatch must not signal the process"
        metadata.write_text(json.dumps(runtime))
        assert stop(dict(request, runtime=runtime))["stopped"]
        assert namespace["process_identity"](runtime["pid"]) is None
        assert stop(dict(request, runtime=runtime))["stopped"], "already dead runtime is idempotent"
        assert project.read_text() == "preserve"
        assert metadata.exists(), "stop leaves native runtime files intact"
        replacement = ensure(request)
        try:
            rejected(dict(request, runtime=runtime))
            assert namespace["ready"](replacement)
            assert stop(dict(request, runtime=replacement))["stopped"]
        finally:
            if namespace["ready"](replacement): os.kill(replacement["pid"], signal.SIGTERM)
    finally:
        if namespace["ready"](runtime): os.kill(runtime["pid"], signal.SIGTERM)
"##, helper = HELPER);
        let output = std::process::Command::new("python3").args(["-c", &script]).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }

    /// A runtime directory like the packaged one: bridge, host, manifests and
    /// the SDK, plus files that must not be uploaded.
    #[cfg(unix)]
    fn fake_runtime(root: &std::path::Path, bridge: &str) {
        let sdk = root.join("node_modules/@anthropic-ai/claude-agent-sdk");
        std::fs::create_dir_all(&sdk).unwrap();
        std::fs::create_dir_all(root.join("node_modules/.bin")).unwrap();
        std::fs::write(root.join("bridge.mjs"), bridge).unwrap();
        std::fs::write(root.join("remote-host.mjs"), include_str!("../../runtimes/claude/remote-host.mjs")).unwrap();
        std::fs::write(root.join("bridge.test.mjs"), "test").unwrap();
        std::fs::write(root.join("README.md"), "docs").unwrap();
        std::fs::write(root.join("package.json"), "{}").unwrap();
        std::fs::write(sdk.join("package.json"), r#"{"version":"0.0.1"}"#).unwrap();
        std::fs::write(root.join("node_modules/.bin/x"), "#!/bin/sh").unwrap();
        std::os::unix::fs::symlink("/etc", root.join("node_modules/escape")).unwrap();
    }

    #[cfg(unix)]
    fn run_install(home: &std::path::Path, digest: &str, archive: &[u8]) -> std::process::Output {
        use std::io::Write;
        let mut child = std::process::Command::new("python3")
            .args(["-c", CLAUDE_INSTALL, digest, DEFAULT_ROOT])
            .env("HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(archive).unwrap();
        child.wait_with_output().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn claude_runtime_archive_is_deterministic_and_holds_only_runtime_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("claude");
        fake_runtime(&root, "// bridge");
        // npm installs both glibc and musl binaries on Linux. They can exceed
        // the archive budget together and cannot run on a remote Mac anyway.
        for platform in ["linux-x64", "linux-x64-musl", "darwin-arm64", "win32-x64"] {
            let package = root.join(format!("node_modules/@anthropic-ai/claude-agent-sdk-{platform}"));
            std::fs::create_dir_all(&package).unwrap();
            std::fs::File::create(package.join("claude")).unwrap().set_len(CLAUDE_RUNTIME_LIMIT + 1).unwrap();
        }
        let (digest, archive) = claude_runtime_archive(&root).unwrap();
        let names: Vec<String> = tar::Archive::new(flate2::read::GzDecoder::new(archive.as_slice()))
            .entries().unwrap().map(|e| e.unwrap().path().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["bridge.mjs", "node_modules/@anthropic-ai/claude-agent-sdk/package.json", "package.json", "remote-host.mjs"]);
        // Times do not matter; content does.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(root.join("package.json"), "{}").unwrap();
        assert_eq!(claude_runtime_archive(&root).unwrap(), (digest.clone(), archive));
        std::fs::write(root.join("bridge.mjs"), "// changed").unwrap();
        assert_ne!(claude_runtime_archive(&root).unwrap().0, digest);
        std::fs::remove_file(root.join("remote-host.mjs")).unwrap();
        assert!(claude_runtime_archive(&root).is_err(), "an incomplete runtime is not uploaded");
    }

    #[cfg(unix)]
    #[test]
    fn claude_install_unpacks_once_into_a_private_digest_dir_and_refuses_unsafe_entries() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let root = temp.path().join("claude");
        fake_runtime(&root, "// bridge");
        let (digest, archive) = claude_runtime_archive(&root).unwrap();
        let first = run_install(&home, &digest, &archive);
        assert!(first.status.success(), "{}", String::from_utf8_lossy(&first.stderr));
        let report: Value = serde_json::from_slice(&first.stdout).unwrap();
        assert_eq!(report["installed"], true);
        let installed = home.join(".yuzuno/claude-runtime").join(&digest);
        assert_eq!(std::fs::read_to_string(installed.join("bridge.mjs")).unwrap(), "// bridge");
        assert!(!installed.join("bridge.test.mjs").exists() && !installed.join("node_modules/.bin").exists());
        let mode = std::fs::metadata(home.join(".yuzuno/claude-runtime")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        let again = run_install(&home, &digest, &archive);
        assert!(again.status.success());
        assert_eq!(serde_json::from_slice::<Value>(&again.stdout).unwrap()["installed"], false, "the same content is not unpacked twice");
        // An entry that climbs out of the directory is refused, and nothing is left.
        let mut bad = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default()));
        let mut header = tar::Header::new_gnu();
        header.set_size(1);
        header.set_mode(0o644);
        header.as_gnu_mut().unwrap().name[..12].copy_from_slice(b"../escape.js");
        header.set_cksum();
        bad.append(&header, &b"x"[..]).unwrap();
        let bad = bad.into_inner().unwrap().finish().unwrap();
        let other = "f".repeat(64);
        let refused = run_install(&home, &other, &bad);
        assert!(!refused.status.success());
        assert!(!home.join(".yuzuno/claude-runtime").join(&other).exists());
        assert!(!home.join(".yuzuno/escape.js").exists());
        let leftovers: Vec<_> = std::fs::read_dir(home.join(".yuzuno/claude-runtime")).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(leftovers, [digest.clone()]);
    }

    #[cfg(unix)]
    #[test]
    fn claude_ensure_starts_one_host_and_refuses_while_its_turn_runs_without_yuzuno() {
        use std::io::Write;
        let Ok(node) = std::process::Command::new("node").arg("--version").output() else {
            eprintln!("node is not installed; skipped");
            return;
        };
        assert!(node.status.success());
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let root = temp.path().join("claude");
        fake_runtime(&root, "process.stdin.resume();");
        let (digest, archive) = claude_runtime_archive(&root).unwrap();
        assert!(run_install(&home, &digest, &archive).status.success());
        let ensure = |agent: &str| {
            let mut child = std::process::Command::new("python3")
                .args(["-c", HELPER])
                .env("HOME", &home)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(serde_json::to_string(&json!({
                "action":"claude_ensure","workspaceKey":"ws","agentId":agent,"digest":digest,"root":DEFAULT_ROOT
            })).unwrap().as_bytes()).unwrap();
            child.wait_with_output().unwrap()
        };
        let first = ensure("agent-one");
        assert!(first.status.success(), "{}", String::from_utf8_lossy(&first.stderr));
        let host: ClaudeHost = serde_json::from_slice(&first.stdout).unwrap();
        struct Stop(u32);
        impl Drop for Stop {
            fn drop(&mut self) {
                let _ = std::process::Command::new("kill").args(["-TERM", &self.0.to_string()]).status();
            }
        }
        let _stop = Stop(host.pid);
        assert!(std::path::Path::new(&host.socket).exists());
        assert!(host.root.starts_with(&home.join(".yuzuno/claude").to_string_lossy().into_owned()));
        let second: ClaudeHost = serde_json::from_slice(&ensure("agent-one").stdout).unwrap();
        assert_eq!((second.pid, second.instance_id.clone()), (host.pid, host.instance_id.clone()), "one host per Agent");
        // Its turn still runs with no client: neither attached to nor replaced.
        std::fs::write(std::path::Path::new(&host.root).join("state.json"), r#"{"busy":true,"attached":false}"#).unwrap();
        let refused = ensure("agent-one");
        assert!(!refused.status.success());
        assert!(String::from_utf8_lossy(&refused.stderr).contains("上一轮仍在"), "{}", String::from_utf8_lossy(&refused.stderr));
        // Another Agent has its own host.
        let other: ClaudeHost = serde_json::from_slice(&ensure("agent-two").stdout).unwrap();
        let _stop_other = Stop(other.pid);
        assert_ne!(other.pid, host.pid);
        assert_ne!(other.root, host.root);
    }

    #[cfg(unix)]
    #[test]
    fn claude_attach_joins_stdin_and_stdout_to_the_hosts_socket() {
        use std::io::{BufRead, Read, Write};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("host.sock");
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let echo = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            (&stream).write_all(format!("echo {line}").as_bytes()).unwrap();
        });
        let mut child = std::process::Command::new("python3")
            .args(["-c", CLAUDE_ATTACH, path.to_str().unwrap()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"{\"op\":\"status\"}\n").unwrap();
        let mut output = String::new();
        child.stdout.take().unwrap().read_to_string(&mut output).unwrap();
        echo.join().unwrap();
        assert_eq!(output, "echo {\"op\":\"status\"}\n");
        assert!(child.wait().unwrap().success(), "the session ends when the host closes it");
    }

    #[test]
    fn ssh_target_cannot_be_an_option_or_shell_program() {
        let mut machine = RemoteMachine {
            id: "m1".into(),
            name: "Mac mini".into(),
            target: "tester@192.0.2.10".into(),
            codex: "/a path/codex".into(),
            default_cwd: "~/project".into(),
            ..Default::default()
        };
        validate_machine(&machine).unwrap();
        for bad in [
            "-oProxyCommand=cat",
            "host; touch /tmp/x",
            "host\n-oFoo",
            "$(whoami)",
            "user@host pwd",
        ] {
            machine.target = bad.into();
            assert!(validate_machine(&machine).is_err(), "{bad}");
        }
    }

    #[test]
    fn helper_roundtrips_shell_metacharacters_without_interpolation() {
        let script = "quote ' dollar $HOME backtick `pwd` newline\n雪";
        let output = std::process::Command::new("sh")
            .args(["-c", &format!("printf %s {}", shell_quote(script))])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), script);
    }

    #[cfg(unix)]
    #[test]
    fn remote_file_reader_enforces_real_boundary_size_and_regular_files() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("work");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a ' $ b.txt"), "可读").unwrap();
        std::fs::write(temp.path().join("outside"), "private").unwrap();
        symlink(temp.path().join("outside"), root.join("escape")).unwrap();
        symlink(root.join("a ' $ b.txt"), root.join("inside")).unwrap();
        std::fs::File::create(root.join("big"))
            .unwrap()
            .set_len(FILE_LIMIT as u64 + 1)
            .unwrap();
        let fifo = root.join("pipe");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let read = |path: &str| {
            let mut child = std::process::Command::new("python3")
                .args(["-c", HELPER])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            use std::io::Write;
            child
                .stdin
                .take()
                .unwrap()
                .write_all(
                    serde_json::to_string(&json!({"action":"read","cwd":root,"path":path}))
                        .unwrap()
                        .as_bytes(),
                )
                .unwrap();
            child.wait_with_output().unwrap()
        };
        for good in ["a ' $ b.txt", "inside"] {
            let output = read(good);
            assert!(output.status.success());
            assert_eq!(output.stdout, "可读".as_bytes());
        }
        for bad in ["../outside", "escape", "big", "pipe", "."] {
            let output = read(bad);
            assert!(!output.status.success(), "{bad}");
            assert!(output.stdout.is_empty());
        }
    }

    #[test]
    fn a_data_root_is_a_plain_folder_in_home_or_absolute() {
        for good in ["~/.yuzuno", "~/jobs-lab/.yuzuno", "/srv/yuzuno-data", LEGACY_ROOT] {
            validate_root(good).unwrap();
        }
        for bad in ["~", "~/", ".yuzuno", "~/a/../b", "~/./a", "~/a//b", "~/a/", "/", "~/a b", "~/$(id)", "~/a;b", "~user/a", "/a\n"] {
            assert!(validate_root(bad).is_err(), "{bad:?}");
        }
        let machine = |root: Option<&str>| RemoteMachine {
            id: "m".into(), name: "m".into(), target: "host".into(), codex: "codex".into(), default_cwd: "/".into(),
            data_root: root.map(Into::into), ..Default::default()
        };
        assert!(validate_machine(&machine(Some("~/a b"))).is_err());
        assert_eq!(machine(None).root(), DEFAULT_ROOT);
        assert_eq!(machine(Some("~/jobs-lab/.yuzuno")).root(), "~/jobs-lab/.yuzuno");
        // As one shell word, expanded only for the home folder.
        for (root, expected) in [("~/jobs-lab/.yuzuno", "/h/jobs-lab/.yuzuno/x/bridge.mjs"), ("/srv/data", "/srv/data/x/bridge.mjs")] {
            let output = std::process::Command::new("sh")
                .args(["-c", &format!("printf %s {}", root_word(root, "x/bridge.mjs"))])
                .env("HOME", "/h")
                .output()
                .unwrap();
            assert_eq!(String::from_utf8(output.stdout).unwrap(), expected);
        }
    }

    #[test]
    fn an_agents_machine_copy_keeps_the_root_its_runtime_is_in() {
        let registered = RemoteMachine {
            id: "lab_host".into(), name: "lab_host".into(), target: "lab_host".into(), codex: "codex".into(), default_cwd: "/".into(),
            ..Default::default()
        };
        // An Agent from before data roots: its runtime is in the legacy root.
        let mut old = serde_json::to_value(crate::model::RemoteAgent { machine: registered.clone(), runtime: None }).unwrap();
        old["machine"].as_object_mut().unwrap().remove("dataRoot");
        let old: crate::model::RemoteAgent = serde_json::from_value(old).unwrap();
        assert_eq!(old.machine.root(), LEGACY_ROOT);
        // A new one is fixed to the machine's root when it is created, and
        // keeps it when the machine changes or its record is read again.
        let new = crate::model::RemoteAgent::new(registered.clone());
        assert_eq!(new.machine.data_root.as_deref(), Some(DEFAULT_ROOT));
        let read: crate::model::RemoteAgent = serde_json::from_value(serde_json::to_value(&new).unwrap()).unwrap();
        assert_eq!(read.machine.root(), DEFAULT_ROOT);
        let lab_host = crate::model::RemoteAgent::new(RemoteMachine { data_root: Some("~/jobs-lab/.yuzuno".into()), ..registered });
        assert_eq!(lab_host.machine.root(), "~/jobs-lab/.yuzuno");
    }

    #[cfg(unix)]
    #[test]
    fn runtimes_live_only_in_the_root_the_request_names() {
        use std::{io::Write, os::unix::fs::PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        std::fs::create_dir_all(home.join("jobs-lab")).unwrap();
        let codex = temp.path().join("fake-codex");
        std::fs::write(&codex, "#!/usr/bin/python3\nimport socket,sys,time\ns=socket.socket(socket.AF_UNIX)\ns.bind(sys.argv[-1][7:])\ns.listen(4)\nwhile True: s.accept()[0].close()\n").unwrap();
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o700)).unwrap();
        // No Claude CLI on this PATH: the check below runs no real one.
        let call = |request: Value| {
            let mut child = std::process::Command::new("python3")
                .args(["-c", HELPER])
                .env("HOME", &home)
                .env("PATH", "/usr/bin:/bin")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(&serde_json::to_vec(&request).unwrap()).unwrap();
            child.wait_with_output().unwrap()
        };
        let ensure = |root: &str| call(json!({"action":"ensure","codex":codex,"workspaceKey":"w","agentId":"a","root":root}));
        let output = ensure("~/jobs-lab/.yuzuno");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let runtime: RuntimeRef = serde_json::from_slice(&output.stdout).unwrap();
        struct Stop(u32);
        impl Drop for Stop {
            fn drop(&mut self) {
                let _ = std::process::Command::new("kill").args(["-TERM", &self.0.to_string()]).status();
            }
        }
        let _stop = Stop(runtime.pid);
        assert!(runtime.root.starts_with(&*home.join("jobs-lab/.yuzuno/runtimes").to_string_lossy()), "{}", runtime.root);
        let mode = std::fs::metadata(home.join("jobs-lab/.yuzuno")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        let names: Vec<_> = std::fs::read_dir(&home).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["jobs-lab"], "nothing in the home folder outside that root");
        // Asked again in that root, the same runtime: one per Agent.
        let again: RuntimeRef = serde_json::from_slice(&ensure("~/jobs-lab/.yuzuno").stdout).unwrap();
        assert_eq!((again.pid, again.instance_id), (runtime.pid, runtime.instance_id.clone()));
        // A root whose parent is missing, a malformed one or none: refused, nothing made.
        for bad in [json!("~/missing/.yuzuno"), json!("~/../escape"), json!("~/a b"), Value::Null] {
            let mut request = json!({"action":"ensure","codex":codex,"workspaceKey":"w","agentId":"b"});
            if !bad.is_null() {
                request["root"] = bad.clone();
            }
            assert!(!call(request).status.success(), "{bad}");
        }
        assert!(!home.join("missing").exists() && !temp.path().join("escape").exists());
        // The check reports the root without creating it.
        let probe = |root: &str| -> Value {
            serde_json::from_slice(&call(json!({"action":"probe","codex":"true","defaultCwd":"/","root":root})).stdout).unwrap()
        };
        let fresh = probe("~/jobs-lab/other");
        assert_eq!(fresh["dataRoot"], home.join("jobs-lab/other").to_string_lossy().as_ref());
        assert!(fresh.get("dataRootError").is_none(), "{fresh}");
        assert!(!home.join("jobs-lab/other").exists());
        assert!(probe("~/missing/.yuzuno")["dataRootError"].as_str().unwrap().contains("不存在"));
        std::fs::create_dir(home.join("jobs-lab/open")).unwrap();
        std::fs::set_permissions(home.join("jobs-lab/open"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(probe("~/jobs-lab/open")["dataRootError"].as_str().unwrap().contains("独占"));
    }

    #[cfg(unix)]
    #[test]
    fn a_contained_machine_keeps_the_sessions_folders_and_tools_under_its_root() {
        use std::{io::Write, os::unix::fs::PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let root = home.join("jobs-lab/.yuzuno");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        // A Claude Code kept under the root, which says what its session's folders are.
        let claude = root.join("bin/claude");
        std::fs::write(&claude, "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '%s|%s|%s|%s\\n' \"$CLAUDE_CONFIG_DIR\" \"$TMPDIR\" \"$XDG_STATE_HOME\" \"$DISABLE_AUTOUPDATER\"; else echo '{\"loggedIn\":false}'; fi\n").unwrap();
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o700)).unwrap();
        let call = |request: Value| -> Value {
            let mut child = std::process::Command::new("python3")
                .args(["-c", HELPER])
                .env_clear()
                .env("HOME", &home)
                .env("PATH", "/usr/bin:/bin")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(&serde_json::to_vec(&request).unwrap()).unwrap();
            let output = child.wait_with_output().unwrap();
            if output.status.success() { serde_json::from_slice(&output.stdout).unwrap() } else { json!({"failed": String::from_utf8_lossy(&output.stderr)}) }
        };
        let probe = |contained: bool| call(json!({"action":"probe","codex":"true","defaultCwd":"/","root":"~/jobs-lab/.yuzuno","contained":contained}));
        let open = probe(false);
        assert_eq!(open["claude"], claude.to_string_lossy().as_ref(), "found in the root's bin: {open}");
        assert_eq!(open["claudeVersion"], "|||", "as before: the account's own folders");
        // Before the session folders exist the check creates nothing and runs no CLI.
        let early = probe(true);
        assert!(early["claudeError"].as_str().unwrap().contains("尚不存在"), "{early}");
        assert!(early.get("claudeVersion").is_none() && !root.join("claude-config").exists(), "{early}");
        // Installing the runtime makes them, and reports the PATH it found Claude with.
        std::fs::create_dir_all(root.join("tools/node-v22/bin")).unwrap();
        let installed = call(json!({"action":"claude_runtime","digest":"a".repeat(64),"root":"~/jobs-lab/.yuzuno","contained":true}));
        let path = installed["path"].as_str().unwrap().to_owned();
        let folders: Vec<&str> = path.split(':').collect();
        assert_eq!(folders[..2], [folder_of(&root, "bin"), folder_of(&root, "tools/node-v22/bin")], "{path}");
        assert_eq!(folders.last().copied(), Some(home.join(".local/bin").to_str().unwrap()));
        let contained = probe(true);
        let folder = |name: &str| root.join(name).to_string_lossy().into_owned();
        assert_eq!(contained["claudeVersion"], format!("{}|{}|{}|1", folder("claude-config"), folder("tmp"), folder("xdg/state")));
        for name in ["claude-config", "tmp", "xdg", "xdg/cache", "xdg/config", "xdg/data", "xdg/state"] {
            let mode = std::fs::metadata(root.join(name)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{name}");
        }
        let names: Vec<_> = std::fs::read_dir(&home).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["jobs-lab"], "nothing of the session outside the root");
        // Codex keeps its sessions in ~/.codex: not run on such a machine.
        let codex = call(json!({"action":"ensure","codex":"true","workspaceKey":"w","agentId":"a","root":"~/jobs-lab/.yuzuno","contained":true}));
        assert!(codex["failed"].as_str().unwrap().contains("Codex"), "{codex}");
        assert!(!root.join("runtimes").exists());
        // The direct bridge gets the same folders and PATH as the host.
        let machine = RemoteMachine {
            id: "lab_host".into(), name: "lab_host".into(), target: "lab_host".into(), codex: "codex".into(), default_cwd: "/".into(),
            data_root: Some("~/jobs-lab/.yuzuno".into()), contained: true, ..Default::default()
        };
        let digest = "a".repeat(64);
        let tools = ClaudeTools {
            node: "/home/lab_host/jobs-lab/.yuzuno/tools/node/bin/node".into(),
            path: "/h/jobs-lab/.yuzuno/bin:/h/jobs-lab/.yuzuno/tools/node/bin:/usr/bin:/h/.local/bin".into(),
        };
        let command = claude_direct_command(&machine, &digest, &tools).unwrap();
        let remote = command.as_std().get_args().last().unwrap().to_string_lossy().into_owned();
        let (assignments, program) = remote.split_once(" exec ").unwrap();
        assert_eq!(program, format!("'/home/lab_host/jobs-lab/.yuzuno/tools/node/bin/node' \"$HOME\"/'jobs-lab/.yuzuno/claude-runtime/{digest}/bridge.mjs'"));
        let output = std::process::Command::new("sh")
            .args(["-c", &format!("{assignments} exec /bin/sh -c 'printf \"%s\\n\" \"$PATH\" \"$CLAUDE_CONFIG_DIR\" \"$TMPDIR\" \"$XDG_CACHE_HOME\" \"$DISABLE_AUTOUPDATER\"'")])
            .env_clear()
            .env("HOME", "/h")
            .env("PATH", "/usr/bin")
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(output.stdout).unwrap(), [
            tools.path.as_str(),
            "/h/jobs-lab/.yuzuno/claude-config", "/h/jobs-lab/.yuzuno/tmp", "/h/jobs-lab/.yuzuno/xdg/cache", "1", "",
        ].join("\n"));
    }

    fn folder_of(root: &std::path::Path, relative: &str) -> String {
        root.join(relative).to_string_lossy().into_owned()
    }
}
