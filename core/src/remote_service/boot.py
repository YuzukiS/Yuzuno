"""First step of one remote session: install the program if needed, then run it.

Core sends one JSON line on stdin with the program digest and the data root.
This script checks the environment and the private folders, writes the program
from the upload when the installed copy is not the expected digest, writes one
marked line back, and execs the program. It uses only the standard library and
Python 3.6 syntax, and every read and write shares one deadline.
"""
import hashlib
import json
import os
import platform
import re
import select
import stat
import sys
import time

MARK = "YUZUNO-REMOTE "
MAX_LINE = 4096
MAX_UPLOAD = 8 * 1024 * 1024
HEX32 = re.compile(r"[0-9a-f]{32}")
HEX64 = re.compile(r"[0-9a-f]{64}")
ROOT_PART = re.compile(r"[A-Za-z0-9._-]+")


class Refused(Exception):
    def __init__(self, code, msg):
        Exception.__init__(self, msg)
        self.code = code
        self.msg = msg


class Deadline(Exception):
    pass


def seconds(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return float(default)


DEADLINE = time.monotonic() + seconds("YUZUNO_REMOTE_BOOT_DEADLINE", 60)
NONCE = "0" * 32


def remaining():
    left = DEADLINE - time.monotonic()
    if left <= 0:
        raise Deadline()
    return left


def read_byte(fd, code):
    while True:
        ready, _, _ = select.select([fd], [], [], remaining())
        if not ready:
            raise Refused(code, "timeout")
        try:
            data = os.read(fd, 1)
        except InterruptedError:
            continue
        except BlockingIOError:
            continue
        if not data:
            raise Refused(code, "eof")
        return data


def read_line(fd, limit, code):
    data = bytearray()
    while len(data) <= limit:
        byte = read_byte(fd, code)
        data.extend(byte)
        if byte == b"\n":
            return bytes(data[:-1])
    raise Refused(code, "line too long")


def read_exact(fd, count, code):
    chunks = []
    left = count
    while left:
        ready, _, _ = select.select([fd], [], [], remaining())
        if not ready:
            raise Refused(code, "timeout")
        try:
            data = os.read(fd, left)
        except InterruptedError:
            continue
        except BlockingIOError:
            continue
        if not data:
            raise Refused(code, "eof")
        chunks.append(data)
        left -= len(data)
    return b"".join(chunks)


def write_all(fd, data):
    view = memoryview(data)
    while view:
        _, writable, _ = select.select([], [fd], [], remaining())
        if not writable:
            raise Deadline()
        try:
            wrote = os.write(fd, view)
        except InterruptedError:
            continue
        except BlockingIOError:
            continue
        if wrote:
            view = view[wrote:]


def report(code, msg):
    line = (MARK + NONCE + " " + json.dumps(
        {"error": {"code": code, "msg": msg}}, separators=(",", ":")) + "\n").encode("utf-8")
    try:
        write_all(1, line)
    except Deadline:
        # The deadline is gone: one attempt, never wait again just to report it.
        try:
            os.write(1, line)
        except OSError:
            pass


def root_path(given):
    if not isinstance(given, str) or not given or len(given) > 1024:
        raise Refused("root_unsafe", "root must be ~/folder or an absolute path")
    if given.startswith("~/"):
        base, rest = os.path.expanduser("~"), given[2:]
    elif given.startswith("/"):
        base, rest = "/", given[1:]
    else:
        raise Refused("root_unsafe", "root must be ~/folder or an absolute path")
    parts = rest.split("/")
    if not parts or any(not ROOT_PART.fullmatch(part) or part in (".", "..") for part in parts):
        raise Refused("root_unsafe", "root has an invalid part")
    return os.path.join(base, *parts)


def private_dir(path):
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    except FileNotFoundError:
        raise Refused("root_unsafe", "the root's parent does not exist") from None
    except OSError:
        raise Refused("root_unsafe", "the root cannot be created") from None
    info = os.lstat(path)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077):
        raise Refused("root_unsafe", "the root must be a private directory owned by this account")


def installed(path, digest):
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return False
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077):
            return False
        hasher = hashlib.sha256()
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            hasher.update(chunk)
        return hasher.hexdigest() == digest
    finally:
        os.close(fd)


def install(path, digest, payload):
    directory = os.path.dirname(path)
    temporary = None
    fd = None
    for _ in range(3):
        candidate = os.path.join(directory, "." + digest + "." + os.urandom(8).hex() + ".tmp")
        try:
            fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                         | getattr(os, "O_NOFOLLOW", 0), 0o600)
        except FileExistsError:
            continue
        temporary = candidate
        break
    if temporary is None:
        raise Refused("internal", "no temporary file name")
    try:
        view = memoryview(payload)
        while view:
            wrote = os.write(fd, view)
            view = view[wrote:]
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.rename(temporary, path)
        temporary = None
        try:
            dirfd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
        except OSError:
            pass
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def main():
    global NONCE
    if sys.version_info < (3, 6):
        report("python_too_old", "python 3.6 or newer is needed")
        return 3
    if hasattr(os, "set_blocking"):
        os.set_blocking(1, False)
    try:
        line = read_line(0, MAX_LINE, "bad_request")
        try:
            request = json.loads(line.decode("utf-8"))
        except Exception:
            raise Refused("bad_request", "the first line is not JSON")
        if not isinstance(request, dict) or request.get("v") != 1:
            raise Refused("bad_request", "the request version is not 1")
        nonce = request.get("nonce")
        if not isinstance(nonce, str) or not HEX32.fullmatch(nonce):
            raise Refused("bad_request", "the nonce is invalid")
        NONCE = nonce
        digest = request.get("digest")
        if not isinstance(digest, str) or not HEX64.fullmatch(digest):
            raise Refused("bad_request", "the digest is invalid")
        root = root_path(request.get("root"))
        if platform.system() not in ("Linux", "Darwin"):
            raise Refused("unsupported_platform", "only Linux and macOS are supported")
        for step in ("", "remote", os.path.join("remote", "bin")):
            private_dir(os.path.join(root, step) if step else root)
        target = os.path.join(root, "remote", "bin", digest + ".py")
        if not installed(target, digest):
            write_all(1, (MARK + NONCE + " " + json.dumps({"need": True},
                                                          separators=(",", ":")) + "\n").encode("utf-8"))
            length = read_line(0, 17, "bad_request")
            if not length.isdigit() or len(length) > 16:
                raise Refused("bad_request", "the upload length is invalid")
            count = int(length)
            if count <= 0 or count > MAX_UPLOAD:
                raise Refused("bad_request", "the upload is too large")
            payload = read_exact(0, count, "upload_short")
            if hashlib.sha256(payload).hexdigest() != digest:
                raise Refused("upload_mismatch", "the upload does not match the digest")
            install(target, digest, payload)
        write_all(1, (MARK + NONCE + " " + json.dumps({"ready": True},
                                                      separators=(",", ":")) + "\n").encode("utf-8"))
        os.environ["YUZUNO_REMOTE_ROOT"] = root
        os.environ["YUZUNO_REMOTE_DIGEST"] = digest
        os.execv(sys.executable, [sys.executable, "-I", target, "session"])
        return 3
    except Refused as error:
        report(error.code, error.msg)
        return 3
    except Deadline:
        report("timeout", "the boot deadline passed")
        return 3
    except Exception as error:
        report("internal", str(error)[:200])
        return 3


if __name__ == "__main__":
    sys.exit(main())
