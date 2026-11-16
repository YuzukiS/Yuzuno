"""Tests for the desktop's scripts for WSL (YN-107), run under a fake HOME:

- the read-only check (desktop/src/local_core/check.sh, design 4.3), under a
  PATH of stand-ins: what it printed, and that nothing changed in HOME,
  TMPDIR or the working folder;
- the temporary folder of an installation (desktop/src/local_core/stage.sh,
  design 4.5): what it makes, that it removes only a folder named as it
  names one, holding its marker and belonging to this account, and an
  unpack from stdin into it as the desktop runs one;
- the built-in Core release key (desktop/core-release.pub): the key the
  documentation publishes.

Each script runs as the desktop runs it (`sh -s -- …`, the script on stdin),
under every POSIX shell found here (dash and bash: a distribution's /bin/sh
is either).

Standard library only; no network. Run: python3 desktop/tests/local_core_scripts.py
"""

import base64
import io
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.join(HERE, "..")
SCRIPT = os.path.join(DESKTOP, "src", "local_core", "check.sh")
with open(SCRIPT, "rb") as _script:
    SCRIPT_BYTES = _script.read()
STAGE = os.path.join(DESKTOP, "src", "local_core", "stage.sh")
with open(STAGE, "rb") as _script:
    STAGE_BYTES = _script.read()
GUARD = os.path.join(DESKTOP, "src", "local_core", "guard.sh")
with open(GUARD, "rb") as _script:
    GUARD_BYTES = _script.read()
MAC_CHECK = os.path.join(DESKTOP, "src", "local_core", "mac_check.sh")
with open(MAC_CHECK, "rb") as _script:
    MAC_CHECK_BYTES = _script.read()
FIXTURES = os.path.join(HERE, "fixtures", "release")

# Every key the script prints; check_rules.rs reads them.
KEYS = [
    "format", "user", "uid", "home", "shell", "arch", "glibc", "tools.missing",
    "env.source", "env.note", "root", "root.state", "data", "data.state",
    "tool.node", "tool.git", "tool.gh", "tool.claude", "tool.codex",
    "tool.python3", "gh.auth", "init", "systemd", "cgroup",
]
INSTALLED_KEYS = ["root.current", "root.launch", "root.entry"]
# DeepSeek Harness (YN-119 S4b), printed last.
KEYS += ["tool.dsh"]

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
                self.assertEqual(printed["tool.dsh"], "-")
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


STAGE_NAME = re.compile(r"^\.yuzuno-core-install\.[A-Za-z0-9]{8}$")
MARKER = ".yuzuno-desktop-stage"


class StageScript(unittest.TestCase):
    """stage.sh, as the desktop runs it: `sh -s -- prepare <installDir>` and
    `sh -s -- clean <stage>`, the script on stdin, with the system's tools."""

    def setUp(self):
        self.assertTrue(SHELLS, "no dash or bash here")
        self.base = tempfile.mkdtemp(prefix="yn107-stage-")
        self.addCleanup(shutil.rmtree, self.base, True)
        self.home = os.path.join(self.base, "home", "someone")
        self.share = os.path.join(self.home, ".local", "share")
        self.root = os.path.join(self.share, "yuzuno-core")
        os.makedirs(self.home)

    def run_stage(self, interpreter, *arguments):
        done = subprocess.run(
            [interpreter, "-s", "--", *arguments],
            input=STAGE_BYTES,
            capture_output=True,
            env={"HOME": self.home, "PATH": "/usr/bin:/bin", "TMPDIR": self.base},
            cwd=self.home,
            timeout=60,
        )
        printed = dict(line.partition("=")[::2] for line in done.stdout.decode().splitlines())
        return done.returncode, printed

    def prepare(self, interpreter):
        code, printed = self.run_stage(interpreter, "prepare", self.root)
        self.assertEqual(code, 0, printed)
        return printed["stage"], printed

    def fake_stage(self, name, marker=True, age=0):
        """A folder as stage.sh makes one (or not quite), `age` seconds old."""
        path = os.path.join(self.share, name)
        os.makedirs(os.path.join(path, "bundle", "bin"))
        with open(os.path.join(path, "bundle", "bin", "file"), "w") as handle:
            handle.write("x")
        if marker:
            open(os.path.join(path, MARKER), "w").close()
        if age:
            past = time.time() - age
            os.utime(path, (past, past))
        return path

    def test_prepare_makes_a_private_folder_beside_the_install_folder(self):
        for interpreter in SHELLS:
            with self.subTest(sh=os.path.basename(interpreter)):
                stage, printed = self.prepare(interpreter)
                self.assertEqual(os.path.dirname(stage), self.share)
                self.assertRegex(os.path.basename(stage), STAGE_NAME)
                self.assertEqual(printed["swept"], "0")
                self.assertEqual(sorted(os.listdir(stage)), sorted(["bundle", MARKER]))
                self.assertEqual(os.listdir(os.path.join(stage, "bundle")), [])
                self.assertEqual(stat.S_IMODE(os.lstat(stage).st_mode), 0o700)
                # The missing parents were made, private (XDG's 0700).
                self.assertEqual(stat.S_IMODE(os.lstat(self.share).st_mode), 0o700)
                # Nothing at the install folder itself: install makes it.
                self.assertFalse(os.path.exists(self.root))
                code, printed = self.run_stage(interpreter, "clean", stage)
                self.assertEqual((code, printed), (0, {"removed": stage}))
                self.assertFalse(os.path.exists(stage))

    def test_an_unpack_from_stdin_as_the_desktop_runs_it(self):
        # A small release-shaped archive, as the release tool packs one.
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz", format=tarfile.USTAR_FORMAT) as tar:
            for name, data, mode in (
                ("bin/yuzuno-update-helper", b"#!/bin/sh\nexit 1\n", 0o755),
                ("manifest.json", b"{}\n", 0o600),
            ):
                info = tarfile.TarInfo(name)
                info.size, info.mode = len(data), mode
                tar.addfile(info, io.BytesIO(data))
        archive = buffer.getvalue()
        for interpreter in SHELLS:
            with self.subTest(sh=os.path.basename(interpreter)):
                stage, _ = self.prepare(interpreter)
                # The arguments after `wsl.exe … --exec` (local_core/mod.rs, Steps::unpack).
                done = subprocess.run(
                    ["/usr/bin/env", "tar", "-xzf", "-", "-C", f"{stage}/bundle"],
                    input=archive,
                    capture_output=True,
                    env={"HOME": self.home, "PATH": "/usr/bin:/bin"},
                    cwd=self.home,
                    timeout=60,
                )
                self.assertEqual(done.returncode, 0, done.stderr)
                bundle = os.path.join(stage, "bundle")
                self.assertEqual(sorted(os.listdir(bundle)), ["bin", "manifest.json"])
                self.assertTrue(os.access(os.path.join(bundle, "bin", "yuzuno-update-helper"), os.X_OK))
                code, _ = self.run_stage(interpreter, "clean", stage)
                self.assertEqual(code, 0)
                self.assertFalse(os.path.exists(stage))

    def test_clean_removes_nothing_but_a_marked_folder_of_its_own_name(self):
        os.makedirs(self.share)
        for interpreter in SHELLS:
            with self.subTest(sh=os.path.basename(interpreter)):
                kept = [
                    self.fake_stage("other.Ab3dEf9h"),
                    self.fake_stage(".yuzuno-core-install.Ab3dEf9"),
                    self.fake_stage(".yuzuno-core-install.Ab3d-f9h"),
                    self.fake_stage(".yuzuno-core-install.NoMarker", marker=False),
                ]
                linked = self.fake_stage(".yuzuno-core-install.LinkedTo")
                os.symlink(linked, os.path.join(self.share, ".yuzuno-core-install.ALinkHer"))
                marker_link = self.fake_stage(".yuzuno-core-install.MarkLink", marker=False)
                os.symlink(os.path.join(linked, MARKER), os.path.join(marker_link, MARKER))
                for path in kept + [
                    os.path.join(self.share, ".yuzuno-core-install.ALinkHer"),
                    marker_link,
                    os.path.join(self.share, "x", "..", ".yuzuno-core-install.LinkedTo"),
                    os.path.join(self.share, ".", ".yuzuno-core-install.LinkedTo"),
                    "relative/.yuzuno-core-install.LinkedTo",
                    "/.yuzuno-core-install.LinkedTo",
                ]:
                    code, printed = self.run_stage(interpreter, "clean", path)
                    self.assertEqual(code, 1, path)
                    self.assertIn("nothing was removed", printed["error"])
                for path in kept + [linked, marker_link]:
                    self.assertTrue(os.path.isdir(path), path)
                self.assertTrue(os.path.exists(os.path.join(linked, "bundle", "bin", "file")))
                shutil.rmtree(self.share)
                os.makedirs(self.share)

    def test_clean_leaves_another_accounts_folder(self):
        if subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode != 0:
            self.skipTest("needs sudo without a password to give a folder to another account")
        os.makedirs(self.share)
        stage = self.fake_stage(".yuzuno-core-install.NotMine1")
        subprocess.run(["sudo", "-n", "chown", "0:0", stage], check=True)
        self.addCleanup(subprocess.run, ["sudo", "-n", "rm", "-rf", "--", stage])
        for interpreter in SHELLS:
            with self.subTest(sh=os.path.basename(interpreter)):
                code, printed = self.run_stage(interpreter, "clean", stage)
                self.assertEqual(code, 1, printed)
                self.assertTrue(os.path.isdir(stage))

    def test_prepare_sweeps_only_old_marked_folders_of_its_own_name(self):
        os.makedirs(self.share)
        for interpreter in SHELLS:
            with self.subTest(sh=os.path.basename(interpreter)):
                old = self.fake_stage(".yuzuno-core-install.OldOne01", age=61 * 60)
                young = self.fake_stage(".yuzuno-core-install.Young001", age=50 * 60)
                unmarked = self.fake_stage(".yuzuno-core-install.OldOne02", marker=False, age=61 * 60)
                named = self.fake_stage("yuzuno-core-install.OldOne03", age=61 * 60)
                target = self.fake_stage("elsewhere", age=61 * 60)
                link = os.path.join(self.share, ".yuzuno-core-install.OldLink1")
                os.symlink(target, link)
                past = time.time() - 61 * 60
                os.utime(link, (past, past), follow_symlinks=False)
                stage, printed = self.prepare(interpreter)
                self.assertEqual(printed["swept"], "1")
                self.assertFalse(os.path.exists(old))
                for path in (young, unmarked, named, target, stage):
                    self.assertTrue(os.path.isdir(path), path)
                self.assertTrue(os.path.islink(link))
                self.assertTrue(os.path.exists(os.path.join(target, MARKER)))
                shutil.rmtree(self.share)
                os.makedirs(self.share)

    def test_prepare_refuses_a_folder_it_cannot_put_one_beside(self):
        for interpreter in SHELLS:
            with self.subTest(sh=os.path.basename(interpreter)):
                for root in ("/yuzuno-core", "relative/core", f"{self.home}/../core", f"{self.home}//core", f"{self.home}/core/"):
                    code, printed = self.run_stage(interpreter, "prepare", root)
                    self.assertEqual(code, 1, root)
                    self.assertIn("error", printed)
                code, printed = self.run_stage(interpreter, "remove", self.root)
                self.assertEqual((code, printed["error"]), (1, "Unknown step: remove"))
                self.assertFalse(os.path.exists(os.path.join(self.home, ".local")))


class GuardScript(unittest.TestCase):
    """guard.sh, as the desktop runs it: `sh -s`, the script on stdin, in a
    distribution that is already running. A fake root supplies its /proc and
    /sys (the script's YUZUNO_GUARD_ROOT, which wsl.exe never passes) and
    nothing may change under it."""

    def setUp(self):
        self.assertTrue(SHELLS, "no dash or bash here")
        self.base = tempfile.mkdtemp(prefix="yn156-guard-")
        self.addCleanup(shutil.rmtree, self.base, True)
        self.root = os.path.join(self.base, "root")
        self.binfmt = os.path.join(self.root, "proc", "sys", "fs", "binfmt_misc")
        self.cgroup = os.path.join(self.root, "sys", "fs", "cgroup")
        self.user = os.path.join(self.cgroup, "user.slice", "user-1000.slice", "user@1000.service")
        self.make()

    def make(self):
        write(os.path.join(self.binfmt, "status"), "enabled\n")
        self.entry("WSLInterop", "enabled", "4d5a", "/init", "P")
        self.entry("OtherInterop", "enabled", "4d5a", "/init", "")
        self.entry("Elsewhere", "enabled", "7f454c46", "/usr/bin/wine")
        write(os.path.join(self.cgroup, "cgroup.subtree_control"), "+cpu +memory +pids\n")
        write(os.path.join(self.cgroup, "user.slice", "cgroup.subtree_control"), "+cpu +memory +pids\n")
        write(os.path.join(self.cgroup, "system.slice", "cgroup.subtree_control"), "+cpu +memory +pids\n")
        write(os.path.join(self.user, "cgroup.subtree_control"), "+cpu +memory +pids\n")
        write(os.path.join(self.user, "app.slice", "cgroup.subtree_control"), "+cpu\n")

    def entry(self, name, state, magic, interpreter, flags=""):
        lines = [state, f"interpreter {interpreter}", "offset 0", f"magic {magic}"]
        if flags:
            lines.append(f"flags: {flags}")
        write(os.path.join(self.binfmt, name), "\n".join(lines) + "\n")

    def run_guard(self, interpreter, root=True):
        env = {"PATH": "/usr/bin:/bin", "TMPDIR": self.base}
        if root:
            env["YUZUNO_GUARD_ROOT"] = self.root if root is True else root
        before = snapshot(self.base)
        done = subprocess.run(
            [interpreter, "-s"],
            input=GUARD_BYTES,
            capture_output=True,
            env=env,
            cwd=self.base,
            timeout=30,
        )
        self.assertEqual(snapshot(self.base), before, "the guard changed files")
        self.assertEqual(done.returncode, 0, done.stderr)
        printed = []
        for line in done.stdout.decode().splitlines():
            key, _, value = line.partition("=")
            printed.append((key, value))
        return printed

    def values(self, printed, key):
        return [value for printed_key, value in printed if printed_key == key]

    def test_what_the_witness_sees(self):
        for interpreter in SHELLS:
            with self.subTest(sh=os.path.basename(interpreter)):
                printed = self.run_guard(interpreter)
                self.assertEqual(self.values(printed, "format"), ["1"])
                self.assertEqual(self.values(printed, "binfmt.status"), ["enabled"])
                self.assertEqual(
                    sorted(self.values(printed, "interop")),
                    ["OtherInterop enabled -", "WSLInterop enabled P"],
                )
                self.assertEqual(self.values(printed, "binfmt.other"), ["1"])
                self.assertEqual(self.values(printed, "cgroup.root"), ["+cpu +memory +pids"])
                self.assertEqual(self.values(printed, "cgroup.user-slice"), ["+cpu +memory +pids"])
                self.assertEqual(self.values(printed, "cgroup.system-slice"), ["+cpu +memory +pids"])
                self.assertEqual(self.values(printed, "user.1000.control"), ["+cpu +memory +pids"])
                self.assertEqual(self.values(printed, "user.1000.app"), ["+cpu"])
                # Keys are printed once each, in the order the app reads.
                keys = [key for key, _ in printed]
                self.assertEqual(keys.count("interop"), 2)
                self.assertEqual(len(keys), len(set(keys)) + 1)

    def test_a_fake_root_without_anything(self):
        for interpreter in SHELLS:
            with self.subTest(sh=os.path.basename(interpreter)):
                printed = self.run_guard(interpreter, root=os.path.join(self.base, "missing"))
                self.assertEqual(self.values(printed, "binfmt.status"), ["absent"])
                self.assertEqual(self.values(printed, "binfmt.other"), ["0"])
                self.assertEqual(self.values(printed, "interop"), [])
                self.assertEqual(self.values(printed, "cgroup.root"), ["(absent)"])

    def test_a_disabled_table_and_entries_that_are_not_interop(self):
        write(os.path.join(self.binfmt, "status"), "disabled\n")
        self.entry("WSLInterop", "disabled", "4d5a", "/init", "P")
        self.entry("NoFlags", "enabled", "4d5a", "/init", "")
        self.entry("OtherInit", "enabled", "4d5a", "/bin/not-init", "P")
        for interpreter in SHELLS:
            with self.subTest(sh=os.path.basename(interpreter)):
                printed = self.run_guard(interpreter)
                self.assertEqual(self.values(printed, "binfmt.status"), ["disabled"])
                self.assertEqual(
                    sorted(self.values(printed, "interop")),
                    ["NoFlags enabled -", "OtherInterop enabled -", "WSLInterop disabled P"],
                )
                # Elsewhere, OtherInit: not an interop rule.
                self.assertEqual(self.values(printed, "binfmt.other"), ["2"])

    def test_a_manager_directory_that_is_not_a_number_is_left_out(self):
        odd = os.path.join(self.cgroup, "user.slice", "user-nobody.slice", "user@nobody.service")
        write(os.path.join(odd, "cgroup.subtree_control"), "+cpu\n")
        for interpreter in SHELLS:
            with self.subTest(sh=os.path.basename(interpreter)):
                printed = self.run_guard(interpreter)
                self.assertNotIn("user.nobody.control", [key for key, _ in printed])
                self.assertEqual(self.values(printed, "user.1000.control"), ["+cpu +memory +pids"])


class MacCheckScript(unittest.TestCase):
    """The Mac's tools script (YN-108 design 4.2): the app runs it with
    /bin/sh and the PATH it read from the login shell, and it prints only
    versions and the gh sign-in's exit code. It writes nothing."""

    def run_script(self, path, extra_env=None):
        with tempfile.TemporaryDirectory() as base:
            bin = os.path.join(base, "bin")
            os.makedirs(bin)
            for name in ("head",):
                os.symlink(shutil.which(name), os.path.join(bin, name))
            for name, body in [
                ("node", 'echo v22.11.0\necho a second line'),
                ("git", "echo 'git version 2.43.0'"),
                ("gh", 'case "$1" in auth) exit 1 ;; --version) echo "gh version 2.45.0" ;; esac'),
                ("claude", "echo '2.1.3 (Claude Code)'"),
                ("codex", "echo 'codex-cli 0.80.0'"),
            ]:
                write(os.path.join(bin, name), "#!/bin/sh\n" + body + "\n", 0o755)
            env = {"PATH": f"{bin}:{os.environ.get('PATH', '')}", "HOME": base}
            env.update(extra_env or {})
            before = snapshot(bin)
            done = subprocess.run(["/bin/sh", MAC_CHECK], capture_output=True, env=env, cwd=base, timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(before, snapshot(bin), "the script changed a program")
            printed = {}
            for line in done.stdout.decode().splitlines():
                key, _, value = line.partition("=")
                self.assertNotIn(key, printed, f"{key} printed twice")
                printed[key] = value
            return printed

    def test_versions_are_the_programs_own_first_lines(self):
        printed = self.run_script(MAC_CHECK)
        self.assertEqual(printed["format"], "1")
        self.assertEqual(printed["tool.node"], "v22.11.0")
        self.assertEqual(printed["tool.git"], "git version 2.43.0")
        self.assertEqual(printed["tool.gh"], "gh version 2.45.0")
        self.assertEqual(printed["gh.auth"], "1")
        self.assertEqual(printed["tool.claude"], "2.1.3 (Claude Code)")
        self.assertEqual(printed["tool.codex"], "codex-cli 0.80.0")
        self.assertEqual(printed["done"], "1")

    def test_missing_programs_are_a_dash(self):
        with tempfile.TemporaryDirectory() as base:
            done = subprocess.run(
                ["/bin/sh", MAC_CHECK],
                capture_output=True,
                env={"PATH": base, "HOME": base},
                cwd=base,
                timeout=60,
            )
            printed = dict(line.split("=", 1) for line in done.stdout.decode().splitlines())
            for key in ("tool.node", "tool.git", "tool.gh", "tool.claude", "tool.codex"):
                self.assertEqual(printed[key], "-", key)
            self.assertEqual(printed["gh.auth"], "-")

    def test_the_missing_command_line_tools_keep_git_from_being_run(self):
        printed = self.run_script(MAC_CHECK, {"YUZUNO_CHECK_GIT": "0"})
        self.assertEqual(printed["tool.git"], "?", "not run, because /usr/bin/git is Xcode's installer shim")


class ReleaseKey(unittest.TestCase):
    def test_the_built_in_key_is_the_published_one(self):
        with open(os.path.join(DESKTOP, "core-release.pub")) as handle:
            built_in = handle.read()
        with open(os.path.join(DESKTOP, "..", "docs", "independent-core.md")) as handle:
            published = re.findall(r"^\s*KEY=(RW[A-Za-z0-9+/=]+)$", handle.read(), re.M)
        self.assertEqual(len(published), 1)
        self.assertEqual(built_in, published[0] + "\n")
        with open(os.path.join(FIXTURES, "test-key.pub")) as handle:
            self.assertNotEqual(handle.read().strip(), published[0], "the tests' throwaway key is not the publisher's")


if __name__ == "__main__":
    unittest.main()
