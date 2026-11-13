"""Tests for the desktop's read-only WSL check (desktop/src/local_core/check.sh,
YN-107 design 4.3), run under a fake HOME and a PATH of stand-ins.

Each case runs the script as the desktop does (`sh -s -- <install> <data>`,
the script on stdin), under every POSIX shell found here (dash and bash: a
distribution's /bin/sh is either), and checks what it printed and that
nothing changed in HOME, TMPDIR or the working folder.

Standard library only; no network. Run: python3 desktop/tests/local_core_scripts.py
"""

import base64
import os
import shutil
import stat
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "src", "local_core", "check.sh")
with open(SCRIPT, "rb") as _script:
    SCRIPT_BYTES = _script.read()

# Every key the script prints; check_rules.rs reads them.
KEYS = [
    "format", "user", "uid", "home", "shell", "arch", "glibc", "tools.missing",
    "env.source", "env.note", "root", "root.state", "data", "data.state",
    "tool.node", "tool.git", "tool.gh", "tool.claude", "tool.codex",
    "tool.python3", "gh.auth", "systemd", "cgroup",
]
INSTALLED_KEYS = ["root.current", "root.launch", "root.entry"]

# Real programs the stand-in PATH links to: what the script and the
# installation use.
REAL = ["tar", "gzip", "mktemp", "env", "base64", "timeout", "od", "head", "tr", "awk", "cut", "uname", "ls"]

SHELLS = [path for path in (shutil.which("dash"), shutil.which("bash")) if path]


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)
    os.chmod(path, mode)


def snapshot(*roots):
    """Every file and folder below roots: type, size, mode and times."""
    seen = {}
    for root in roots:
        for folder, folders, files in os.walk(root):
            for name in folders + files:
                path = os.path.join(folder, name)
                info = os.lstat(path)
                seen[path] = (stat.S_IFMT(info.st_mode), info.st_size, info.st_mode, info.st_mtime_ns, info.st_ctime_ns)
    return seen


class Lab:
    """A fake account: HOME, a stand-in PATH, a login shell and passwd."""

    def __init__(self, base):
        self.base = base
        self.home = os.path.join(base, "home", "someone")
        self.bin = os.path.join(base, "bin")
        self.login_bin = os.path.join(base, "login-bin")
        self.shells = os.path.join(base, "shells")
        self.tmp = os.path.join(base, "tmp")
        self.record = os.path.join(base, "record")
        for folder in (self.home, self.bin, self.login_bin, self.shells, self.tmp, self.record):
            os.makedirs(folder)
        for name in REAL:
            os.symlink(shutil.which(name), os.path.join(self.bin, name))
        self.sleep = shutil.which("sleep")
        self.shell("bash")
        self.passwd("someone", 1000, os.path.join(self.shells, "bash"))
        self.stub("getconf", 'echo "glibc 2.39"')
        # Reads its input as a careless program would: the script's own
        # input must not reach it.
        self.stub("node", f'{shutil.which("cat")} >/dev/null; echo v22.11.0; echo more', login=True)
        self.stub("git", "echo 'git version 2.43.0'")
        self.stub("gh", 'case "$1" in auth) [ "$*" = "auth status --hostname github.com" ] ;; --version) echo "gh version 2.45.0" ;; esac')
        self.stub("systemctl", 'case "$*" in "--user is-system-running") echo degraded ;; "--user show --property=ControlGroup --value") echo /nonexistent.slice ;; esac')

    def stub(self, name, body, login=False):
        folder = self.login_bin if login else self.bin
        write(os.path.join(folder, name), "#!/bin/sh\n" + body + "\n", 0o755)

    def drop(self, name):
        os.unlink(os.path.join(self.bin, name))

    def passwd(self, user, uid, shell):
        self.stub("getent", f'[ "$1" = passwd ] && [ "$2" = {uid} ] && echo "{user}:x:{uid}:{uid}::{self.home}:{shell}"')
        self.stub("id", f'case "$1" in -un) echo {user} ;; -u) echo {uid} ;; esac')

    def shell(self, name, before="", extra=""):
        """A login shell that records its options, prints a banner, adds
        login-bin to PATH, then runs the command it was given."""
        options = '"$1" "$2" "$3"' if name not in ("csh", "tcsh") else '"$1"'
        command = '"$4"' if name not in ("csh", "tcsh") else '"$2"'
        write(
            os.path.join(self.shells, name),
            "#!/bin/sh\n"
            f'printf "%s " {options} > {self.record}/{name}.options\n'
            f'printf "%s" "$HISTFILE" > {self.record}/{name}.histfile\n'
            f"{before}\n"
            "printf 'Welcome to the login shell\\nwith a banner '\n"
            f'PATH="{self.login_bin}:$PATH"; export PATH\n'
            "XDG_RUNTIME_DIR=/run/user/1000; export XDG_RUNTIME_DIR\n"
            f"{extra}\n"
            f"exec /bin/sh -c {command}\n",
            0o755,
        )

    def run(self, interpreter, *arguments, timeout=60):
        before = snapshot(self.home, self.tmp)
        started = time.monotonic()
        done = subprocess.run(
            [interpreter, "-s", "--", *arguments],
            input=SCRIPT_BYTES,
            capture_output=True,
            env={"HOME": self.home, "PATH": self.bin, "TMPDIR": self.tmp},
            cwd=self.home,
            timeout=timeout,
        )
        took = time.monotonic() - started
        after = snapshot(self.home, self.tmp)
        assert before == after, f"the check changed files: {set(before) ^ set(after) or 'times or modes'}"
        assert done.returncode == 0, done.stderr
        printed = {}
        for line in done.stdout.decode().splitlines():
            key, _, value = line.partition("=")
            assert key not in printed, f"{key} printed twice"
            printed[key] = value
        return printed, took


class CheckScript(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SHELLS, "no dash or bash here")
        self.base = tempfile.mkdtemp(prefix="yn109-check-")
        self.addCleanup(shutil.rmtree, self.base)
        self.lab = Lab(self.base)

    def each_shell(self, *arguments, **options):
        """The check run under each shell: (shell's name, printed, seconds)."""
        for interpreter in SHELLS:
            printed, took = self.lab.run(interpreter, *arguments, **options)
            yield os.path.basename(interpreter), printed, took

    def test_a_fresh_account(self):
        for sh, printed, _ in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual(list(printed), KEYS)
                self.assertEqual(printed["format"], "1")
                self.assertEqual(printed["user"], "someone")
                self.assertEqual(printed["uid"], "1000")
                self.assertEqual(printed["home"], self.lab.home)
                self.assertEqual(printed["shell"], os.path.join(self.lab.shells, "bash"))
                self.assertEqual(printed["glibc"], "2.39")
                self.assertEqual(printed["tools.missing"], "")
                self.assertEqual(printed["env.source"], "login")
                self.assertEqual(printed["env.note"], "")
                self.assertEqual(printed["root"], self.lab.home + "/.local/share/yuzuno-core")
                self.assertEqual(printed["root.state"], "absent")
                self.assertEqual(printed["data"], self.lab.home + "/.local/share/yuzuno-core-data")
                self.assertEqual(printed["data.state"], "absent")
                # Found on the login shell's PATH only; its first line.
                self.assertEqual(printed["tool.node"], "v22.11.0")
                self.assertEqual(printed["tool.git"], "git version 2.43.0")
                self.assertEqual(printed["tool.gh"], "gh version 2.45.0")
                self.assertEqual(printed["tool.claude"], "-")
                self.assertEqual(printed["tool.codex"], "-")
                python = "/usr/bin/python3"
                self.assertEqual(printed["tool.python3"].startswith("Python 3"), os.access(python, os.X_OK))
                self.assertEqual(printed["gh.auth"], "ok")
                self.assertEqual(printed["systemd"], "degraded")
                self.assertEqual(printed["cgroup"], "")
                with open(os.path.join(self.lab.record, "bash.options")) as handle:
                    self.assertEqual(handle.read(), "-i -l -c ")
                with open(os.path.join(self.lab.record, "bash.histfile")) as handle:
                    self.assertEqual(handle.read(), "")

    def test_an_installation_and_a_workspace(self):
        root = self.lab.home + "/.local/share/yuzuno-core"
        current = b'{"releaseId":"20261113-b870c92","manifestSha256":"' + b"0" * 64 + b'"}'
        launch = b'{"port":4317,"workspaceId":"ws-1","pad":"' + b"x" * 70000 + b'"}'
        write(root + "/current.json", current.decode())
        write(root + "/updates/launch.json", launch.decode())
        write(root + "/updates/start", "#!/bin/sh\n", 0o755)
        data = self.lab.home + "/.local/share/yuzuno-core-data"
        write(data + "/workspace.lock", "")
        for sh, printed, _ in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual(list(printed), KEYS[:12] + INSTALLED_KEYS + KEYS[12:])
                self.assertEqual(printed["root.state"], "installed")
                self.assertEqual(base64.b64decode(printed["root.current"]), current)
                # The first 64 KiB, on one line.
                self.assertEqual(base64.b64decode(printed["root.launch"]), launch[:65536])
                self.assertEqual(printed["root.entry"], "yes")
                self.assertEqual(printed["data.state"], "workspace")

    def test_installed_without_a_start_record(self):
        root = self.lab.home + "/.local/share/yuzuno-core"
        write(root + "/current.json", "{}")
        for sh, printed, _ in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual(printed["root.state"], "installed")
                self.assertEqual(printed["root.launch"], "")
                self.assertEqual(printed["root.entry"], "no")

    def test_other_contents_and_given_paths(self):
        root = os.path.join(self.lab.home, "somewhere", "core")
        data = os.path.join(self.lab.home, "somewhere", "data")
        write(root + "/notes.txt", "mine")
        os.makedirs(data)
        for sh, printed, _ in self.each_shell(root, data):
            with self.subTest(sh=sh):
                self.assertEqual((printed["root"], printed["root.state"]), (root, "other"))
                self.assertEqual((printed["data"], printed["data.state"]), (data, "empty"))
                self.assertNotIn("root.current", printed)
        write(data + "/file", "x")
        for sh, printed, _ in self.each_shell(root, data):
            with self.subTest(sh=sh):
                self.assertEqual(printed["data.state"], "other")
        # A file where a folder should be.
        for sh, printed, _ in self.each_shell(root + "/notes.txt", data + "/file"):
            with self.subTest(sh=sh):
                self.assertEqual(printed["root.state"], "other")
                self.assertEqual(printed["data.state"], "other")

    def test_missing_tools_and_no_timeout(self):
        for name in ("tar", "gzip"):
            self.lab.drop(name)
        for sh, printed, _ in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual(printed["tools.missing"], "tar gzip")
        self.lab.drop("timeout")
        for sh, printed, _ in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual(printed["tools.missing"], "tar gzip timeout")
                # Nothing that might wait is run without a time limit.
                self.assertEqual((printed["env.source"], printed["env.note"]), ("inherited", "noTimeout"))
                self.assertEqual(printed["tool.git"], "?")
                self.assertEqual(printed["tool.node"], "-")
                self.assertEqual(printed["gh.auth"], "?")
                self.assertEqual(printed["systemd"], "?")

    def test_root_and_old_glibc(self):
        self.lab.passwd("root", 0, os.path.join(self.lab.shells, "bash"))
        self.lab.stub("getconf", 'echo "glibc 2.31"')
        for sh, printed, _ in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual((printed["user"], printed["uid"], printed["glibc"]), ("root", "0", "2.31"))
        self.lab.stub("getconf", "exit 1")
        for sh, printed, _ in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual(printed["glibc"], "")

    def test_gh_not_signed_in_and_no_systemctl(self):
        self.lab.stub("gh", 'case "$1" in auth) exit 1 ;; --version) echo "gh version 2.45.0" ;; esac')
        self.lab.drop("systemctl")
        for sh, printed, _ in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual(printed["gh.auth"], "no")
                self.assertEqual(printed["systemd"], "-")

    def test_a_login_shell_that_hangs_is_killed_with_its_group(self):
        pids = os.path.join(self.lab.record, "pids")
        self.lab.shell("bash", before=f"{self.lab.sleep} 300 & echo $! >> {pids}; {self.lab.sleep} 300")
        for sh, printed, took in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual((printed["env.source"], printed["env.note"]), ("inherited", "timeout"))
                self.assertLess(took, 25)
                # Not on the PATH the check started with.
                self.assertEqual(printed["tool.node"], "-")
        time.sleep(0.5)
        with open(pids) as handle:
            for pid in handle.read().split():
                try:
                    with open(f"/proc/{pid}/stat") as proc:
                        self.assertEqual(proc.read().rsplit(")", 1)[1].split()[0], "Z", f"{pid} still runs")
                except FileNotFoundError:
                    pass

    def test_a_long_banner_is_read_in_time(self):
        self.lab.shell("bash", before=f"{shutil.which('head')} -c 600000 /dev/zero | {shutil.which('tr')} '\\0' x")
        for sh, printed, took in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual(printed["env.source"], "login")
                self.assertEqual(printed["tool.node"], "v22.11.0")
                self.assertLess(took, 20)

    def test_a_value_with_a_line_break_is_not_a_path(self):
        self.lab.shell("bash", extra='FAKE="x\nPATH=/nowhere"; export FAKE')
        for sh, printed, _ in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual(printed["env.source"], "login")
                self.assertEqual(printed["tool.node"], "v22.11.0")

    def test_csh_and_an_unsupported_shell(self):
        self.lab.shell("tcsh")
        self.lab.passwd("someone", 1000, os.path.join(self.lab.shells, "tcsh"))
        for sh, printed, _ in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual(printed["env.source"], "login")
                with open(os.path.join(self.lab.record, "tcsh.options")) as handle:
                    self.assertEqual(handle.read(), "-ic ")
        self.lab.shell("nu")
        self.lab.passwd("someone", 1000, os.path.join(self.lab.shells, "nu"))
        for sh, printed, _ in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual((printed["env.source"], printed["env.note"]), ("inherited", "unsupportedShell"))
                self.assertFalse(os.path.exists(os.path.join(self.lab.record, "nu.options")))

    def test_a_shell_that_fails(self):
        write(os.path.join(self.lab.shells, "bash"), "#!/bin/sh\nexit 3\n", 0o755)
        for sh, printed, _ in self.each_shell("default", "default"):
            with self.subTest(sh=sh):
                self.assertEqual((printed["env.source"], printed["env.note"]), ("inherited", "failed"))


if __name__ == "__main__":
    unittest.main()
