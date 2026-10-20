"""One-shot SSH helper; no resident Yuzuno worker or credential handling.

JSON request on stdin. Metadata responses are JSON; read returns bounded bytes.
Only an official app-server survives this helper's exit.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
import uuid

MAX_FILE = 8 * 1024 * 1024
# A contained machine's session folders under its data root (remote.rs
# SESSION_FOLDERS): Claude's config, temporary files and the XDG folders.
SESSION_FOLDERS = (("CLAUDE_CONFIG_DIR", ("claude-config",)), ("TMPDIR", ("tmp",)),
                   ("XDG_CACHE_HOME", ("xdg", "cache")), ("XDG_CONFIG_HOME", ("xdg", "config")),
                   ("XDG_DATA_HOME", ("xdg", "data")), ("XDG_STATE_HOME", ("xdg", "state")))


def tool_path(request):
    """Where executables are found, Node and Claude Code included: the data
    root's bin and tools/*/bin (a machine can keep pinned tools there),
    Homebrew's (SSH non-login shells on macOS lack it), the session's own
    PATH, then ~/.local/bin, where Claude Code installs itself and which only
    login shells add."""
    folders = []
    try:
        root = data_root(request)
        folders += [str(root / "bin")] + sorted(str(p) for p in (root / "tools").glob("*/bin"))
    except (ValueError, OSError):
        pass
    folders += [p for p in ("/opt/homebrew/bin", "/usr/local/bin") if os.path.isdir(p)]
    folders += [os.environ.get("PATH", "/usr/bin:/bin"), str(Path.home() / ".local" / "bin")]
    os.environ["PATH"] = os.pathsep.join(folders)


def session_env(request, create=True):
    """The environment native sessions start with. On a contained machine
    their own folders are under the data root, made private here (only
    checked, with create=False): nothing of the session is written to this
    account's ~/.claude, cache or temp."""
    env = dict(os.environ)
    if request.get("contained") is not True:
        return env
    base = data_root(request)
    if create:
        private_dir(base)
    for name, parts in SESSION_FOLDERS:
        folder = base.joinpath(*parts)
        if create:
            made = base
            for part in parts:
                made = made / part
                private_dir(made)
        elif folder.is_symlink() or not folder.is_dir():
            raise ValueError(f"{folder} 尚不存在：这些会话目录在这台机器第一次启动 Claude 时创建，在那之前检查不运行它的 CLI")
        env[name] = str(folder)
    env["DISABLE_AUTOUPDATER"] = "1"
    return env


def canonical(path):
    path = Path(path).expanduser().resolve(strict=True)
    if not path.is_dir():
        raise ValueError("工作目录不是目录")
    return path


def executable(program):
    program = os.path.expanduser(program)
    found = shutil.which(program)
    if not found:
        raise ValueError("找不到指定的远程 Codex；请先安装官方 CLI")
    return str(Path(found).absolute())


def data_root(request):
    """The machine's data root Core names in each request (remote.rs
    validate_root): ~/<folder> in this account's home or an absolute folder."""
    given = request.get("root")
    if not isinstance(given, str):
        raise ValueError("请求没有指明数据目录")
    parts = given[2:].split("/") if given.startswith("~/") else given[1:].split("/") if given.startswith("/") else []
    if len(given) > 1024 or not parts or any(p in (".", "..") or not re.fullmatch(r"[A-Za-z0-9._-]+", p) for p in parts):
        raise ValueError("数据目录无效")
    return (Path.home() if given.startswith("~/") else Path("/")).joinpath(*parts)


def private_dir(path):
    try:
        path.mkdir(mode=0o700, exist_ok=True)
    except FileNotFoundError:
        raise ValueError(f"{path.parent} 不存在；数据目录的上级目录必须已存在") from None
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Runtime 目录必须由当前用户独占且不能是符号链接")


def process_identity(pid):
    # Match both birth time and command/socket before trusting a persisted PID.
    result = subprocess.run(["ps", "-p", str(pid), "-o", "stat=", "-o", "lstart=", "-o", "args="],
                            capture_output=True, text=True, timeout=5)
    fields = result.stdout.strip().split(None, 1)
    if result.returncode != 0 or len(fields) != 2 or fields[0].startswith("Z"):
        return None
    return fields[1]


def socket_alive(path):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(0.3)
    try:
        client.connect(str(path))
        return True
    except OSError:
        return False
    finally:
        client.close()


def ready(runtime):
    identity = process_identity(runtime["pid"])
    return (identity is not None and birth(identity) == birth(runtime.get("processIdentity"))
            and runtime["socket"] in identity and "app-server" in identity)


def birth(identity):
    # lstart has five fields. exec() can change argv but not the process birth.
    return " ".join(identity.split()[:5]) if identity else None


def save_runtime(path, value):
    temporary = path.with_name("runtime." + uuid.uuid4().hex + ".tmp")
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(str(temporary), str(path))


def ensure_runtime(request):
    workspace, agent = request["workspaceKey"], request["agentId"]
    if not isinstance(workspace, str) or not workspace or not isinstance(agent, str) or not agent:
        raise ValueError("Runtime 需要稳定的 Workspace 和 Agent 标识")
    if request.get("contained") is True:
        raise ValueError("这台机器把会话数据都放在数据目录下；Codex 把会话写在 ~/.codex，所以这里不运行 Codex Agent")
    codex = executable(request["codex"])
    base = data_root(request)
    private_dir(base)
    private_dir(base / "runtimes")
    key = hashlib.sha256(json.dumps([workspace, agent]).encode()).hexdigest()[:24]
    root = base / "runtimes" / key
    private_dir(root)
    sock = root / "rpc.sock"
    # Darwin sockaddr_un.sun_path is only 104 bytes including NUL.
    if len(os.fsencode(sock)) >= 104:
        raise ValueError("远程 Home 路径太长，无法建立私有 Unix socket")
    fd = os.open(str(root / "lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        deadline = time.monotonic() + 20
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError("另一连接正在启动这个 Runtime，请稍后重连")
                time.sleep(0.1)
        metadata = root / "runtime.json"
        if metadata.is_symlink():
            raise ValueError("Runtime 元数据不能是符号链接")
        previous = json.loads(metadata.read_text()) if metadata.exists() else None
        if previous:
            if previous.get("root") != str(root) or previous.get("socket") != str(sock):
                raise ValueError("Runtime 元数据与专属目录不一致")
            if ready(previous):
                if previous.get("codex") != codex:
                    raise ValueError("这个 Agent 的 Runtime 已使用另一 Codex 路径启动；不会静默替换")
                if not socket_alive(sock):
                    raise ValueError("远程 Runtime 仍存在但 socket 不可用；不会重复启动")
                return previous
            identity = process_identity(previous["pid"])
            if identity and (birth(identity) == birth(previous.get("processIdentity"))
                             or str(sock) in identity):
                raise ValueError("原 Runtime 仍在启动或身份尚未确认；不会重复启动")
        if socket_alive(sock):
            raise ValueError("专属 socket 已有服务但不能确认身份；不会覆盖")
        if sock.is_symlink():
            # Codex on macOS shortens long Unix paths by publishing a symlink
            # to its own /private/tmp/codex-daemon-<uid>/ socket. SIGKILL leaves
            # that link behind. At this point the recorded process is gone and
            # no listener answers. Remove only our private link, never its target.
            if not previous:
                raise ValueError("没有自有 Runtime 记录，不能替换未知 socket 链接")
            sock.unlink()
        elif sock.exists() and not stat.S_ISSOCK(sock.lstat().st_mode):
            raise ValueError("Runtime socket 路径不是预期的 Unix socket")
        if sock.exists():
            sock.unlink()
        log_fd = os.open(str(root / "runtime.log"),
                         os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(log_fd, "ab") as log:
            process = subprocess.Popen([codex, "app-server", "--listen", "unix://" + str(sock)],
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                       start_new_session=True, cwd=str(root), close_fds=True)
        runtime = {"root": str(root), "socket": str(sock), "pid": process.pid,
                   "codex": codex, "instanceId": uuid.uuid4().hex,
                   "processIdentity": process_identity(process.pid)}
        # Node's launcher may exec the native binary. Only the birth time is stable
        # until it has bound its socket; metadata is refreshed after readiness.
        save_runtime(metadata, runtime)
        deadline = time.monotonic() + 25
        while not socket_alive(sock):
            if process.poll() is not None:
                raise ValueError("远程 Codex 在 socket 就绪前退出；请检查专属 runtime.log")
            if time.monotonic() >= deadline:
                raise ValueError("远程 Codex socket 尚未就绪；保留 Runtime，不自动重复启动")
            time.sleep(0.1)
        runtime["processIdentity"] = process_identity(process.pid)
        save_runtime(metadata, runtime)
        return runtime



def claude_runtime_dir(request):
    """The installed Claude runtime for this content digest, or None."""
    digest = request.get("digest")
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("Claude Runtime 摘要无效")
    base = data_root(request)
    private_dir(base)
    private_dir(base / "claude-runtime")
    root = base / "claude-runtime" / digest
    if root.is_symlink():
        raise ValueError("Claude Runtime 目录不能是符号链接")
    complete = (root / "bridge.mjs").is_file() and (root / "remote-host.mjs").is_file() \
        and (root / "node_modules" / "@anthropic-ai" / "claude-agent-sdk" / "package.json").is_file()
    return root if complete else None


def claude_host_ready(host):
    identity = process_identity(host["pid"])
    return (identity is not None and birth(identity) == birth(host.get("processIdentity"))
            and "remote-host.mjs" in identity and host["root"] in identity)


def claude_ensure(request):
    """Start, or find, this Workspace/Agent's Claude host. A host whose earlier
    turn still runs without a client is never attached to or replaced."""
    workspace, agent = request["workspaceKey"], request["agentId"]
    if not isinstance(workspace, str) or not workspace or not isinstance(agent, str) or not agent:
        raise ValueError("Runtime 需要稳定的 Workspace 和 Agent 标识")
    runtime = claude_runtime_dir(request)
    if runtime is None:
        raise ValueError("Claude Runtime 尚未安装到这台机器")
    node = shutil.which("node")
    if not node:
        raise ValueError("远程机器找不到 Node.js；请先安装 Node 20 或更新版本")
    env = session_env(request)
    base = data_root(request)
    private_dir(base / "claude")
    key = hashlib.sha256(json.dumps([workspace, agent]).encode()).hexdigest()[:24]
    root = base / "claude" / key
    private_dir(root)
    sock = root / "claude.sock"
    if len(os.fsencode(sock)) >= 104:
        raise ValueError("远程 Home 路径太长，无法建立私有 Unix socket")
    fd = os.open(str(root / "lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        deadline = time.monotonic() + 20
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError("另一连接正在启动这个 Claude Runtime，请稍后重连")
                time.sleep(0.1)
        metadata = root / "host.json"
        if metadata.is_symlink():
            raise ValueError("Runtime 元数据不能是符号链接")
        previous = json.loads(metadata.read_text()) if metadata.exists() else None
        if previous and previous.get("root") == str(root) and claude_host_ready(previous):
            state_path = root / "state.json"
            state = json.loads(state_path.read_text()) if state_path.is_file() else {}
            if state.get("busy") and not state.get("attached"):
                raise ValueError("这个 Agent 上一轮仍在 {} 上运行（Yuzuno 断开时它正在执行）；它结束后会自行退出，届时再重连即可恢复同一 Session"
                                 .format(socket.gethostname()))
            if not state.get("stopping") and socket_alive(sock):
                return dict(previous, attached=bool(state.get("attached")))
            # Idle without a client: it is stopping on its own. Let it finish.
            deadline = time.monotonic() + 15
            while claude_host_ready(previous):
                if time.monotonic() >= deadline:
                    raise ValueError("上一个 Claude Runtime 正在退出；请稍后重连")
                time.sleep(0.2)
        if socket_alive(sock):
            raise ValueError("专属 socket 已有服务但不能确认身份；不会覆盖")
        if sock.exists() or sock.is_symlink():
            sock.unlink()
        log_fd = os.open(str(root / "host.out"),
                         os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(log_fd, "ab") as log:
            process = subprocess.Popen([node, str(runtime / "remote-host.mjs"), "serve", str(root)],
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env,
                                       start_new_session=True, cwd=str(root), close_fds=True)
        host = {"root": str(root), "socket": str(sock), "pid": process.pid, "node": node,
                "runtime": str(runtime), "instanceId": uuid.uuid4().hex,
                "processIdentity": process_identity(process.pid)}
        save_runtime(metadata, host)
        deadline = time.monotonic() + 20
        while not socket_alive(sock):
            if process.poll() is not None:
                raise ValueError("远程 Claude Runtime 在 socket 就绪前退出；请检查专属 host.out")
            if time.monotonic() >= deadline:
                raise ValueError("远程 Claude Runtime socket 尚未就绪；保留 Runtime，不自动重复启动")
            time.sleep(0.1)
        # Right after the fork its command may not be Node's yet; record the
        # identity it has once it listens.
        host["processIdentity"] = process_identity(process.pid)
        save_runtime(metadata, host)
        return dict(host, attached=False)


def stop_runtime(request):
    """Stop only the runtime belonging to this exact Workspace/Agent instance."""
    workspace, agent = request["workspaceKey"], request["agentId"]
    if not isinstance(workspace, str) or not workspace or not isinstance(agent, str) or not agent:
        raise ValueError("Runtime 需要稳定的 Workspace 和 Agent 标识")
    key = hashlib.sha256(json.dumps([workspace, agent]).encode()).hexdigest()[:24]
    root = data_root(request) / "runtimes" / key
    if not root.exists():
        return {"stopped": True}
    for directory in (root.parent.parent, root.parent, root):
        private_dir(directory)
    sock = root / "rpc.sock"
    fd = os.open(str(root / "lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        deadline = time.monotonic() + 20
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError("另一连接正在操作这个 Runtime；Agent 未关闭")
                time.sleep(0.1)
        metadata = root / "runtime.json"
        if metadata.is_symlink():
            raise ValueError("Runtime 元数据不能是符号链接")
        if not metadata.exists():
            if socket_alive(sock):
                raise ValueError("无法确认远程服务身份；不会停止未知进程")
            return {"stopped": True}
        runtime = json.loads(metadata.read_text())
        if runtime.get("root") != str(root) or runtime.get("socket") != str(sock):
            raise ValueError("Runtime 元数据与专属目录不一致；不会停止进程")
        expected = request.get("runtime")
        if expected and any(runtime.get(field) != expected.get(field)
                            for field in ("instanceId", "pid", "root", "socket", "codex")):
            raise ValueError("远程 Runtime 已变化；请重连确认后再关闭")
        identity = process_identity(runtime["pid"])
        if identity is not None:
            if not ready(runtime):
                raise ValueError("远程进程身份无法确认；不会停止未知进程")
            # No process-group kill: background processes are distinct from the
            # harness runtime. Active turns must be interrupted natively first.
            os.kill(runtime["pid"], signal.SIGTERM)
            deadline = time.monotonic() + 8
            while process_identity(runtime["pid"]) is not None:
                if time.monotonic() >= deadline:
                    raise ValueError("远程 Runtime 尚未退出；Agent 未关闭")
                time.sleep(0.1)
        if socket_alive(sock):
            raise ValueError("远程 socket 仍有服务；无法确认关闭")
        return {"stopped": True, "instanceId": runtime["instanceId"]}


def read_artifact(cwd, requested):
    root = canonical(cwd)
    source = Path(requested)
    target = (source if source.is_absolute() else root / source).resolve(strict=True)
    try:
        relative = target.relative_to(root)
    except ValueError:
        raise ValueError("只能预览 Agent 工作目录内的文件") from None
    # Hold directory descriptors and refuse symlinks while opening, including
    # the absolute root's ancestors. A concurrent rename/symlink swap cannot
    # redirect a component outside the selected directory.
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in root.parts[1:] + relative.parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                              dir_fd=directory)
            os.close(directory)
            directory = next_fd
        if not relative.parts:
            raise ValueError("只能预览普通文件")
        fd = os.open(relative.parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=directory)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("只能预览普通文件")
            if info.st_size > MAX_FILE:
                raise ValueError("文件超过 8 MB 预览上限")
            data = stream.read(MAX_FILE + 1)
            if len(data) > MAX_FILE:
                raise ValueError("文件超过 8 MB 预览上限")
            return data
    finally:
        os.close(directory)


def main():
    request = json.load(sys.stdin)
    action = request["action"]
    tool_path(request)
    if action == "read":
        sys.stdout.buffer.write(read_artifact(request["cwd"], request["path"]))
        return
    if action == "canonicalize":
        response = str(canonical(request["path"]))
    elif action == "ensure":
        response = ensure_runtime(request)
    elif action == "stop":
        response = stop_runtime(request)
    elif action == "claude_runtime":
        root = claude_runtime_dir(request)
        # The folders a direct bridge (remote.rs claude_direct_command) uses,
        # and the PATH it runs with: this one, from tool_path.
        session_env(request)
        # The same Node claude_ensure starts the host with (PATH above).
        response = {"installed": root is not None, "node": shutil.which("node"), "path": os.environ["PATH"]}
    elif action == "claude_ensure":
        response = claude_ensure(request)
    elif action == "probe":
        # Reaching this line means SSH and the helper work. A missing Codex or
        # folder is reported beside that fact instead of failing the probe.
        response = {"hostname": socket.gethostname(), "platform": platform.system(),
                    "home": str(Path.home())}
        try:
            codex = executable(request["codex"])
            version = subprocess.run([codex, "--version"], capture_output=True, text=True,
                                     timeout=10, check=True).stdout.strip()
            response.update({"codex": codex, "codexVersion": version})
        except Exception as error:
            response["codexError"] = str(error)[:500]
        try:
            response["defaultCwd"] = str(canonical(request["defaultCwd"]))
        except Exception as error:
            response["defaultCwdError"] = str(error)[:500]
        # Whether the data root can be used, without creating it.
        try:
            root = data_root(request)
            response["dataRoot"] = str(root)
            if root.is_symlink() or root.exists():
                info = root.lstat()
                if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise ValueError(f"{root} 必须是当前用户独占的目录，且不能是符号链接")
            elif not root.parent.is_dir():
                raise ValueError(f"{root.parent} 不存在；数据目录的上级目录必须已存在")
        except Exception as error:
            response["dataRootError"] = str(error)[:500]
        # Claude on this machine: its Node and its own installed CLI. Versions
        # only; the CLI's login stays its own and is not read here. On a
        # contained machine the CLI runs with its folders under the data root,
        # once they exist: the check creates nothing.
        try:
            env = session_env(request, create=False)
        except Exception as error:
            env = None
            response["claudeError"] = str(error)[:500]
        for name, key in (("node", "node"), ("claude", "claude")):
            if name == "claude" and env is None:
                continue
            found = shutil.which(name)
            if not found:
                response[key + "Error"] = "找不到 " + name
                continue
            try:
                version = subprocess.run([found, "--version"], capture_output=True, text=True,
                                         timeout=10, check=True, env=env).stdout.strip()
                response.update({key: found, key + "Version": version[:200]})
            except Exception as error:
                response[key + "Error"] = str(error)[:500]
                continue
            if name == "claude":
                # Whether this session can use the CLI's own login. No model
                # call; only these two fields are kept, never account details.
                try:
                    status = json.loads(subprocess.run([found, "auth", "status", "--json"], capture_output=True,
                                                       text=True, timeout=15, env=env).stdout or "null")
                    if isinstance(status, dict) and isinstance(status.get("loggedIn"), bool):
                        response["claudeLoggedIn"] = status["loggedIn"]
                        method = status.get("authMethod")
                        if isinstance(method, str) and len(method) <= 40:
                            response["claudeAuthMethod"] = method
                except Exception:
                    pass
    else:
        raise ValueError("未知远程操作")
    print(json.dumps(response))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never print requests or environment/authentication contents.
        print(str(error), file=sys.stderr)
        sys.exit(1)
