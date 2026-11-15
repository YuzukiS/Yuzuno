"""Bounded copies of an Agent's message files over the existing SSH channel.

One bounded JSON line, then exact binary bodies. All mutable cache paths are
opened relative to held, private directory descriptors; no caller paths.
Images (`install`) go to `image-cache/<key>/…`, files (`install-files`) to
`file-cache/<key>/<sha256>/<name>`, and `delete` removes both for one owner.
"""
import contextlib
import fcntl
import hashlib
import json
import os
import re
import socket
import signal
import stat
import subprocess
import sys
import time
import unicodedata
import uuid
from pathlib import Path

MAX_FILE = 10 * 1024 * 1024
MAX_TOTAL = 40 * 1024 * 1024
MAX_CACHE = 256 * 1024 * 1024
# A file's name, as `input_files::safe_name` makes it (design §2.2): 200
# UTF-16 units and 240 bytes, an extension of at most 16 characters kept.
NAME_UNITS = 200
NAME_BYTES = 240
MAX_EXTENSION = 16
BANNED = set('\\/:*?"<>|`')
ID = re.compile(r"[0-9a-f]{64}\.(png|jpg|webp)\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")


def require(ok, message):
    if not ok:
        raise ValueError(message)


def private(fd, directory=False):
    info = os.fstat(fd)
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            "Image storage must be private and owned by this user")


def units(name):
    """The UTF-16 units Rust's `encode_utf16().count()` counts."""
    return len(name.encode("utf-16-le")) // 2


def fit(name):
    """`name` within the name limits, keeping its extension (safe_name)."""
    if units(name) <= NAME_UNITS and len(name.encode("utf-8")) <= NAME_BYTES:
        return name
    at = name.rfind(".")
    extension = name[at:] if at > 0 and len(name[at + 1:]) <= MAX_EXTENSION else ""
    units_left = NAME_UNITS - units(extension)
    bytes_left = NAME_BYTES - len(extension.encode("utf-8"))
    kept = []
    for c in name[:len(name) - len(extension)]:
        if units(c) > units_left or len(c.encode("utf-8")) > bytes_left:
            break
        units_left -= units(c)
        bytes_left -= len(c.encode("utf-8"))
        kept.append(c)
    return "".join(kept) + extension


def safe_name(name):
    """The name a file is kept under, as Core's `input_files::safe_name`."""
    last = name.replace("\\", "/").rsplit("/", 1)[-1]
    replaced = "".join("_" if unicodedata.category(c) == "Cc" or c in BANNED else c for c in last)
    safe = replaced.rstrip(" .")
    if not safe:
        return "file"
    if safe[0] in ".-":
        safe = "_" + safe
    fitted = fit(safe).rstrip(" .")
    return fitted or "file"


@contextlib.contextmanager
def directory(parent, name, create=True):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        private(fd, True)
        yield fd
    finally:
        os.close(fd)


def read_file(parent, name, maximum):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    with os.fdopen(fd, "rb") as stream:
        private(stream.fileno())
        require(os.fstat(stream.fileno()).st_size <= maximum, "Oversized image storage file")
        data = stream.read(maximum + 1)
        require(len(data) <= maximum, "Oversized image storage file")
        return data


@contextlib.contextmanager
def locked(parent):
    fd = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                 0o600, dir_fd=parent)
    try:
        private(fd)
        deadline = time.monotonic() + 20
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                require(time.monotonic() < deadline, "Image storage is busy; retry this draft")
                time.sleep(0.05)
        yield
    finally:
        os.close(fd)


def atomic(parent, name, data, mode=0o600):
    temporary = ".upload-" + uuid.uuid4().hex
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            # The file a message carries is read-only (0400); an image is 0600.
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
        os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass


def inventory(parent, count, images=None, relative=()):
    """Also recover interrupted temporary writes, under the cache lock."""
    total = 0
    for name in os.listdir(parent):
        count[0] += 1
        require(count[0] <= 4096, "Agent image cache has too many files")
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            with directory(parent, name, False) as child:
                total += inventory(child, count, images, relative + (name,))
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                    and info.st_mode & 0o077 == 0, "Unsafe image cache entry")
            if re.fullmatch(r"\.upload-[0-9a-f]{32}", name):
                os.unlink(name, dir_fd=parent)
            else:
                total += info.st_size
                if (images is not None and len(relative) == 3 and HASH.fullmatch(relative[0])
                        and relative[1] == "input-images" and ID.fullmatch(name)):
                    images.setdefault(name, []).append(relative + (name,))
    return total


def saved_image(root, parts):
    with contextlib.ExitStack() as stack:
        parent = root
        for name in parts[:-1]:
            parent = stack.enter_context(directory(parent, name, False))
        return read_file(parent, parts[-1], MAX_FILE)


def erase(parent):
    # Never follow a link, including one swapped in after inspection.
    for name in os.listdir(parent):
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            with directory(parent, name, False) as child:
                erase(child)
            os.rmdir(name, dir_fd=parent)
        else:
            os.unlink(name, dir_fd=parent)


def identity(request):
    for key, maximum in [("workspace", 128), ("agent", 100), ("machine", 128),
                         ("target", 255), ("harness", 10)]:
        value = request.get(key)
        require(isinstance(value, str) and 0 < len(value) <= maximum
                and all(ord(c) >= 32 for c in value), "Invalid image destination")
    require(re.fullmatch(r"[a-zA-Z0-9-]+", request["agent"]), "Invalid image owner")
    require(request["harness"] in ("codex", "claude"), "Unsupported image harness")
    return {k: request[k] for k in ("workspace", "agent", "machine", "target", "harness")}


def data_root(request):
    """The Agent's data root Core names (remote.rs validate_root): its parent,
    resolved, and the root's own name, which must be a private folder."""
    given = request.get("root")
    require(isinstance(given, str), "Missing image data root")
    parts = given[2:].split("/") if given.startswith("~/") else given[1:].split("/") if given.startswith("/") else []
    require(len(given) <= 1024 and parts and all(p not in (".", "..") and re.fullmatch(r"[A-Za-z0-9._-]+", p)
                                                 for p in parts), "Invalid image data root")
    parent = (Path.home() if given.startswith("~/") else Path("/")).joinpath(*parts[:-1])
    try:
        return parent.resolve(strict=True), parts[-1]
    except FileNotFoundError:
        raise ValueError(f"{parent} does not exist; the data root's parent must exist") from None


def key_for(owner):
    return hashlib.sha256("\0".join(owner[k] for k in
                          ("workspace", "agent", "machine", "target", "harness")).encode()).hexdigest()


def runtime_check(runtime, request, deleting):
    meta = json.loads(read_file(runtime, "host.json" if request["harness"] == "claude"
                               else "runtime.json", 16384))
    pid = meta.get("pid")
    require(type(pid) is int and pid > 1, "Invalid remote runtime identity")
    # Closing the SSH bridge can finish just before the detached host exits.
    # Wait under its lifecycle lock, without signaling a PID or probing a live
    # host's socket. If it stays alive (including a reused PID), keep the files.
    deadline = time.monotonic() + 10
    while True:
        result = subprocess.run(["ps", "-p", str(pid), "-o", "stat=", "-o", "lstart=", "-o", "args="],
                                capture_output=True, text=True, timeout=5)
        require(result.returncode in (0, 1) and not result.stderr.strip(),
                "Remote runtime process state could not be confirmed")
        fields = result.stdout.strip().split(None, 1)
        require(result.returncode != 0 or len(fields) == 2, "Invalid remote process state")
        live = result.returncode == 0 and not fields[0].startswith("Z")
        if not deleting or not live or time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    if deleting:
        # A recycled PID conservatively postpones cleanup. Never kill it.
        require(not live, "Remote runtime may still use images; retry deletion after it stops")
    else:
        require(live and meta.get("instanceId") == request.get("instance")
                and " ".join(fields[1].split()[:5]) == " ".join(meta.get("processIdentity", "").split()[:5]),
                "Remote runtime changed; images were not submitted")
        require(("remote-host.mjs" in fields[1] and meta["root"] in fields[1])
                if request["harness"] == "claude" else
                ("app-server" in fields[1] and meta["socket"] in fields[1]),
                "Remote runtime identity does not match")
    # A live socket is independent evidence even when ps metadata is stale.
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(0.3)
    try:
        client.connect(meta["socket"])
        socket_live = True
    except OSError:
        socket_live = False
    finally:
        client.close()
    require(not socket_live if deleting else socket_live, "Remote runtime state changed")


def install(root, path, request, owner, stream):
    scope = request.get("scope")
    require(isinstance(scope, dict) and set(scope) == {"session", "cwd", "generation"}, "Invalid image session")
    require(isinstance(scope["cwd"], str) and 0 < len(scope["cwd"]) <= 4096
            and (scope["session"] is None or isinstance(scope["session"], str) and len(scope["session"]) <= 256)
            and type(scope["generation"]) is int and scope["generation"] >= 0,
            "Invalid image session")
    files = request.get("files")
    require(isinstance(files, list) and 1 <= len(files) <= 8, "Attach between 1 and 8 images")
    total, seen = 0, set()
    for file in files:
        require(isinstance(file, dict) and isinstance(file.get("id"), str) and ID.fullmatch(file["id"])
                and isinstance(file.get("sha256"), str) and HASH.fullmatch(file["sha256"])
                and type(file.get("bytes")) is int and 0 < file["bytes"] <=
                (512000 if owner["harness"] == "claude" else MAX_FILE), "Invalid image manifest")
        require(file["id"] not in seen, "Duplicate image")
        seen.add(file["id"])
        if owner["harness"] == "codex":
            require(file["id"].split(".")[0] == file["sha256"], "Original image digest mismatch")
        total += file["bytes"]
    require(total <= MAX_TOTAL, "Image message exceeds 40 MiB")
    # Request scope and live runtime are validated on every transfer; disk
    # identity is content-based so reconnects cannot consume the cache again.
    # Reuse older scoped paths too: native history may still refer to them.
    count, saved = [0], {}
    used = inventory(root, count, saved)
    result = []
    for file in files:
        data = stream.read(file["bytes"])
        require(len(data) == file["bytes"] and hashlib.sha256(data).hexdigest() == file["sha256"],
                "Image transfer truncated or changed; draft was not submitted")
        media = ("image/png" if data.startswith(b"\x89PNG\r\n\x1a\n") else
                 "image/jpeg" if data.startswith(b"\xff\xd8\xff") else
                 "image/webp" if data[:4] == b"RIFF" and data[8:12] == b"WEBP" else None)
        require(media is not None and media == file.get("mediaType"), "Invalid image format")
        existing_path = None
        for parts in saved.get(file["id"], []):
            require(parts[2] == owner["agent"], "Remote image owner mismatch")
            existing = saved_image(root, parts)
            require(existing == data or (owner["harness"] == "claude" and parts[0] != file["sha256"]),
                    "Saved remote image changed; refusing to overwrite")
            if existing == data:
                existing_path = parts
                break
        if existing_path is None:
            require(used + len(data) <= MAX_CACHE, "Agent remote image cache reached 256 MiB")
            # At most three directories and one file. Reserve before creating
            # anything; interrupted partial directories remain bounded too.
            require(count[0] + 4 <= 4096, "Agent image cache has too many files")
            existing_path = (file["sha256"], "input-images", owner["agent"], file["id"])
            with directory(root, file["sha256"]) as content:
                with directory(content, "input-images") as images:
                    with directory(images, owner["agent"]) as agent:
                        atomic(agent, file["id"], data)
            count[0] += 4
            used += len(data)
        result.append({**file, "path": str(path.joinpath(*existing_path))})
    require(stream.read(1) == b"", "Unexpected image transfer data")
    return {"owner": owner, "instance": request["instance"], "files": result}


def check_file(file):
    require(isinstance(file, dict) and isinstance(file.get("id"), str) and HASH.fullmatch(file["id"])
            and isinstance(file.get("name"), str) and type(file.get("bytes")) is int
            and 0 < file["bytes"] <= MAX_TOTAL, "Invalid file manifest")
    # The name is Core's own safe name: no path, link, hidden file or shell
    # option, and within the same limits (design §2.2). Checked again here.
    require(safe_name(file["name"]) == file["name"], "Invalid file name")


def existing_file(root, file):
    """(its content folder would be new, the kept bytes or None) for
    `<root>/<id>/<name>`: links and unexpected entries are refused."""
    try:
        content = os.open(file["id"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
    except FileNotFoundError:
        return True, None
    try:
        private(content, True)
        try:
            return False, read_file(content, file["name"], MAX_TOTAL)
        except FileNotFoundError:
            return False, None
    finally:
        os.close(content)


def install_files(root, path, request, owner, stream):
    files = request.get("files")
    require(isinstance(files, list) and 1 <= len(files) <= 8, "Attach between 1 and 8 files")
    total, seen = 0, set()
    for file in files:
        check_file(file)
        require((file["id"], file["name"]) not in seen, "Duplicate file")
        seen.add((file["id"], file["name"]))
        total += file["bytes"]
    require(total <= MAX_TOTAL, "Files in one message must total at most 40 MiB")
    # The whole cache is counted before anything is written: reconnects and
    # retries find their content by digest, never consuming it again.
    count, used = [0], 0
    used = inventory(root, count)
    result = []
    for file in files:
        data = stream.read(file["bytes"])
        require(len(data) == file["bytes"] and hashlib.sha256(data).hexdigest() == file["id"],
                "File transfer truncated or changed; draft was not submitted")
        new_folder, existing = existing_file(root, file)
        if existing is None:
            need = (1 if new_folder else 0) + 1
            require(used + len(data) <= MAX_CACHE, "Agent remote file cache reached 256 MiB")
            require(count[0] + need <= 4096, "Agent file cache has too many files")
            with directory(root, file["id"]) as content:
                atomic(content, file["name"], data, 0o400)
            count[0] += need
            used += len(data)
        else:
            require(existing == data, "Saved remote file changed; refusing to overwrite")
        result.append({**file, "path": str(path.joinpath(file["id"], file["name"]))})
    require(stream.read(1) == b"", "Unexpected file transfer data")
    return {"owner": owner, "instance": request["instance"], "files": result}


def remove_cache(base, cache_name, key, owner):
    """Removes one owner's cache, `image-cache/<key>` or `file-cache/<key>`;
    a cache that is not there is nothing to remove."""
    try:
        caches = os.open(cache_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base)
    except FileNotFoundError:
        return
    try:
        private(caches, True)
        try:
            os.stat(key, dir_fd=caches, follow_symlinks=False)
        except FileNotFoundError:
            return
        with directory(caches, key) as root, locked(root):
            encoded = json.dumps(owner, sort_keys=True).encode()
            try:
                require(read_file(root, "owner.json", 16384) == encoded, "Remote image owner mismatch")
            except FileNotFoundError:
                # First install may have stopped between mkdir and persisting
                # owner.json. Under both locks, with runtime already stopped,
                # only empty initialization debris is safe. Unknown
                # files/directories/links are never interpreted as an
                # uninitialized cache.
                entries = os.listdir(root)
                require(len(entries) <= 4096 and all(name == "lock" or
                        re.fullmatch(r"\.upload-[0-9a-f]{32}", name) for name in entries),
                        "Missing %s ownership record; cache has unknown contents" % cache_name)
                for name in entries:
                    read_file(root, name, 16384)  # Private regular files, no links.
            inventory(root, [0])  # Validate before any removal.
            erase(root)
        os.rmdir(key, dir_fd=caches)
    finally:
        os.close(caches)


def run(stream):
    header = stream.readline(16385)
    require(len(header) <= 16384 and header.endswith(b"\n"), "Oversized image transfer header")
    request = json.loads(header)
    owner = identity(request)
    require(request.get("op") in ("install", "install-files", "delete"), "Invalid image operation")
    deleting = request["op"] == "delete"
    parent, name = data_root(request)
    parent_fd = os.open(str(parent), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with directory(parent_fd, name) as base:
            runtime_key = hashlib.sha256(json.dumps([owner["workspace"], owner["agent"]]).encode()).hexdigest()[:24]
            with directory(base, "claude" if owner["harness"] == "claude" else "runtimes", False) as runtimes:
                with directory(runtimes, runtime_key, False) as runtime, locked(runtime):
                    key = key_for(owner)
                    if deleting:
                        runtime_check(runtime, request, True)
                        # Both kinds of copies belong to the same owner, and
                        # one marker records the obligation for both.
                        remove_cache(base, "image-cache", key, owner)
                        remove_cache(base, "file-cache", key, owner)
                        return {"deleted": True}
                    cache_name = "file-cache" if request["op"] == "install-files" else "image-cache"
                    with directory(base, cache_name) as caches:
                        with directory(caches, key) as root, locked(root):
                            encoded = json.dumps(owner, sort_keys=True).encode()
                            try:
                                require(read_file(root, "owner.json", 16384) == encoded, "Remote image owner mismatch")
                            except FileNotFoundError:
                                atomic(root, "owner.json", encoded)
                            if request["op"] == "install-files":
                                result = install_files(root, parent / name / cache_name / key, request, owner, stream)
                            else:
                                result = install(root, parent / name / "image-cache" / key,
                                                 request, owner, stream)
                            runtime_check(runtime, request, False)
                            return result
    finally:
        os.close(parent_fd)


def timed_out(*_):
    raise TimeoutError("Image transfer timed out")


if __name__ == "__main__":
    try:
        signal.signal(signal.SIGALRM, timed_out)
        signal.alarm(80)
        print(json.dumps(run(sys.stdin.buffer)))
    except Exception as error:
        # Never echo the request, image bytes, environment, or credentials.
        print(str(error)[:500], file=sys.stderr)
        sys.exit(1)
