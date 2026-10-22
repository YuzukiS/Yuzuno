#!/usr/bin/env python3
"""T-171 lab: the Windows desktop starts its saved WSL Core, for real.

    python3 desktop/tests/start-lab.py --run r1 --target <cargo target>/debug

A fixture release of this tree's Core (the debug yuzuno-workspace and
yuzuno-update-helper in --target, fixture UI) is packaged with
tools/package-release.py and registered into a new managed folder under
/var/tmp. Its Core runs on its own port with its own data and working
folders and a fake Codex; no model is called. The desktop is the lab build
from scripts/desktop.ps1 with TAURI_CONFIG
{"identifier":"dev.yuzuno.workspace.t171lab"}, so its saved Core and WebView
data are its own; desktop/tests/start-lab.ps1 runs only that build, debug or
(--desktop-build release) the release build that ships. The
regular app, the daily Core and their data are never read or changed.

Run it as a Yuzuno Job with WSL_DISTRO_NAME, HOME and USER in its
environment, as a Core started from a WSL shell has them. The lab folder,
screenshots and report.json are kept as evidence; the lab Cores and the lab
window are stopped at the end.
"""
import argparse
import importlib.util
import io
import contextlib
import json
import os
import re
import signal
import subprocess
import sys
import time
import types
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FAKE_CODEX = ROOT / "acceptance/turn-cost/fake_codex.py"
NODE = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin/node"
POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# A Core stand-in for 9b: it answers health and a start profile it is
# given, and a page; nothing else.
STAND_IN = r"""
import http.server, json, sys
port, profile = int(sys.argv[1]), json.loads(sys.argv[2])
class Answer(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/health":
            body = {"product": "yuzuno", "workspaceId": profile["workspaceId"]}
        elif self.path == "/api/desktop/start-profile":
            body = profile
        else:
            page = b"<html><body>stand-in</body></html>"
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers(); self.wfile.write(page)
            return
        payload = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(payload)
    def log_message(self, *args): pass
http.server.HTTPServer(("127.0.0.1", port), Answer).serve_forever()
"""


def health(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=3) as response:
            return json.loads(response.read())
    except (OSError, ValueError):
        return None


def devtools(port):
    """Whether the lab window's test-only DevTools port answers."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2):
            return True
    except OSError:
        return False


def get(port, path):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as response:
        return json.loads(response.read())


def until(check, timeout, what):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.5)
    raise AssertionError(f"timed out waiting for {what}")


def listener(port):
    """The PID listening on 127.0.0.1:port, from /proc (this user's processes)."""
    inode = None
    for line in Path("/proc/net/tcp").read_text().splitlines()[1:]:
        fields = line.split()
        if fields[3] == "0A" and int(fields[1].split(":")[1], 16) == port:
            inode = fields[9]
    if inode is None:
        return None
    for proc in Path("/proc").iterdir():
        if proc.name.isdigit():
            try:
                if any(os.readlink(fd) == f"socket:[{inode}]" for fd in (proc / "fd").iterdir()):
                    return int(proc.name)
            except OSError:
                continue
    return None


def process(pid):
    """What the lab may know about one of its own Cores."""
    proc = Path(f"/proc/{pid}")
    stat = proc.joinpath("stat").read_text().rsplit(")", 1)[1].split()
    environ = dict(item.split("=", 1) for item in proc.joinpath("environ").read_bytes().decode().split("\0") if "=" in item)
    return {
        "pid": pid,
        "exe": os.readlink(proc / "exe"),
        "argv": proc.joinpath("cmdline").read_bytes().decode().split("\0")[1:-1],
        "session": int(stat[3]),
        "parent": parent(pid),
        "cgroup": proc.joinpath("cgroup").read_text().strip(),
        "servicePorts": environ.get("YUZUNO_SERVICE_PORTS"),
    }


def session(sid):
    """The processes of one session: a lab Core and what it runs."""
    members = []
    for proc in Path("/proc").iterdir():
        if proc.name.isdigit():
            try:
                stat = proc.joinpath("stat").read_text().rsplit(")", 1)[1].split()
            except OSError:
                continue
            if int(stat[3]) == sid and stat[0] != "Z":
                members.append(int(proc.name))
    return sorted(members)


def parent(pid):
    """A process's parent and the parent's name, as WSL arranges them."""
    ppid = int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
    try:
        name = Path(f"/proc/{ppid}/comm").read_text().strip()
    except OSError:
        name = None
    return {"ppid": ppid, "name": name}


def lab_processes(managed):
    """Running processes whose executable is in the lab installation."""
    found = []
    for proc in Path("/proc").iterdir():
        if proc.name.isdigit():
            try:
                if os.readlink(proc / "exe").startswith(str(managed) + "/"):
                    found.append(int(proc.name))
            except OSError:
                continue
    return sorted(found)


def stop(pid, managed):
    """Stops a lab Core, and only one: its executable must be the lab's."""
    try:
        exe = os.readlink(f"/proc/{pid}/exe")
    except FileNotFoundError:
        return  # already gone
    if not exe.startswith(str(managed / "releases") + "/"):
        raise AssertionError(f"{pid} is not a lab Core")
    os.kill(pid, signal.SIGINT)
    until(lambda: not Path(f"/proc/{pid}").exists() or "Z" == Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0], 60, "the lab Core to stop")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--run", required=True)
    parser.add_argument("--target", type=Path, required=True, help="cargo target dir (debug or release) with the Core binaries")
    parser.add_argument("--port", type=int, default=4491)
    parser.add_argument("--cdp-port", type=int, default=9341)
    parser.add_argument("--desktop-build", choices=["debug", "release"], default="debug",
                        help="the lab desktop to run: the debug build, or the release build that ships")
    args = parser.parse_args()
    assert re.fullmatch(r"[a-z0-9-]{1,20}", args.run)
    assert os.environ.get("WSL_DISTRO_NAME"), "run with WSL_DISTRO_NAME set"
    lab = Path(f"/var/tmp/t171-{args.run}")
    lab.mkdir(mode=0o700)
    managed, data, work, shots = lab / "m", lab / "d", lab / "w", lab / "shots"
    for folder in (data, work, shots):
        folder.mkdir(mode=0o700)
    url = f"http://127.0.0.1:{args.port}"
    report = {"run": args.run, "distro": os.environ["WSL_DISTRO_NAME"], "desktopBuild": args.desktop_build, "steps": [], "notCovered": [
        "WSL not running before the start (the distribution was running: stopping it would stop the daily Core)",
        "WSL not installed (only that wsl.exe is missing is checked, in unit tests)",
        "a Windows restart, and a Core release built by CI (this is a fixture release of --target's binaries)",
    ]}
    assert health(args.port) is None and listener(args.port) is None, f"port {args.port} is in use"
    assert not devtools(args.cdp_port), f"DevTools port {args.cdp_port} is in use"

    def step(name, **facts):
        report["steps"].append({"step": name, **facts})
        print(json.dumps({"step": name, **facts}), flush=True)

    def windows(action, **params):
        script = subprocess.run(["wslpath", "-w", str(HERE / "start-lab.ps1")], capture_output=True, text=True, check=True).stdout.strip()
        command = [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action,
                   "-Build", args.desktop_build]
        for key, value in params.items():
            command += [f"-{key}", str(value)]
        done = subprocess.run(command, capture_output=True, timeout=120, cwd="/mnt/c/Windows")
        if done.returncode:
            raise RuntimeError(f"start-lab.ps1 {action}: {done.stderr.decode('utf-8', 'replace')[-1500:]}")
        return json.loads(done.stdout.decode("utf-8", "replace"))

    def window(name, core=None):
        done = subprocess.run([str(NODE), str(HERE / "start-lab.mjs"), name, f"http://127.0.0.1:{args.cdp_port}", core or url, str(shots)],
                              capture_output=True, text=True, timeout=400, cwd=ROOT)
        lines = [line for line in done.stdout.splitlines() if line.startswith("{")]
        if not lines:
            raise RuntimeError(f"start-lab.mjs {name}: {done.stderr[-1500:]}")
        result = json.loads(lines[-1])
        if not result.get("ok"):
            raise AssertionError(f"window step {name}: {result}")
        return result

    def starts():
        log = managed / "core.log"
        return log.read_text(errors="replace").count(f"Yuzuno Core: http://127.0.0.1:{args.port}") if log.exists() else 0

    def observe():
        running = {}
        for pid in lab_processes(managed):
            try:
                running[pid] = os.readlink(f"/proc/{pid}/exe").rsplit("/", 1)[1]
            except OSError:
                continue
        return {"wsl": windows("Starts", InstallDir=str(managed)),
                "helpers": [pid for pid, name in running.items() if name == "yuzuno-update-helper"],
                "cores": [pid for pid, name in running.items() if name == "yuzuno-workspace"],
                "listener": listener(args.port), "starts": starts()}

    desktop = None
    lab_cores = []
    try:
        # A fixture release of this tree's Core, registered as a new installation.
        packager = load("package_release", ROOT / "tools/package-release.py")
        inputs = lab / "inputs"
        (inputs / "licenses").mkdir(parents=True)
        for name in ("LICENSE", "THIRD_PARTY_NOTICES-core.txt", "rust-std-COPYRIGHT-library.html", "THIRD_PARTY_NOTICES-claude-runtime.txt"):
            (inputs / "licenses" / name).write_text("T-171 lab fixture; not a release\n")
        (inputs / "web/licenses").mkdir(parents=True)
        (inputs / "web/index.html").write_text("<html><head></head><body><h1>T-171 lab Workspace</h1></body></html>\n")
        (inputs / "web/licenses/THIRD_PARTY_NOTICES.txt").write_text("T-171 lab fixture\n")
        sdk = inputs / "claude/node_modules/@anthropic-ai/claude-agent-sdk"
        sdk.mkdir(parents=True)
        (sdk / "package.json").write_text('{"name": "fixture"}\n')
        (inputs / "claude/package.json").write_text("{}\n")
        (inputs / "claude/bridge.mjs").write_text("// T-171 lab fixture: no Claude runs here\n")
        (inputs / "notes.txt").write_text("T-171 lab fixture; never published\n")
        git_sha = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            packager.assemble(types.SimpleNamespace(
                core=args.target / "yuzuno-workspace", helper=args.target / "yuzuno-update-helper",
                licenses=inputs / "licenses", web=inputs / "web", claude=inputs / "claude",
                result_validator=ROOT / "runtimes/result-validator", windows_helper=ROOT / "runtimes/windows-jobs",
                out=lab / "bundle", notes_file=inputs / "notes.txt", release_id=f"t171-{args.run}",
                version="T-171 lab fixture", git_sha=git_sha))
        bundle = json.loads(printed.getvalue())
        subprocess.run([str(lab / "bundle/bin/yuzuno-update-helper"), "register", "--install-dir", str(managed),
                        "--bundle", str(lab / "bundle"), "--manifest-sha256", bundle["manifestSha256"],
                        "--reviewed-source", "t171-lab", "--initialize"], check=True, capture_output=True)
        release = managed / "releases" / bundle["releaseId"] / "bin/yuzuno-workspace"
        expected_argv = ["--install-dir", str(managed), "--port", str(args.port), "--data-dir", str(data),
                         "--cwd", str(work), "--codex", str(FAKE_CODEX)]

        # 1. The user starts Core once, as the documented command does.
        env = {key: os.environ[key] for key in ("PATH", "HOME", "USER", "LANG", "WSL_DISTRO_NAME") if key in os.environ}
        env["YUZUNO_SERVICE_PORTS"] = "4492-4493"
        with (lab / "first.log").open("ab") as log:
            first = subprocess.Popen([str(release), *expected_argv], cwd=work, env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=log, start_new_session=True)
        lab_cores.append(first.pid)
        workspace = until(lambda: (health(args.port) or {}).get("workspaceId"), 120, "the first lab Core")
        record = json.loads((managed / "updates/launch.json").read_text())
        profile = get(args.port, "/api/desktop/start-profile")
        assert profile == {"available": True, "wslDistro": env["WSL_DISTRO_NAME"], "user": env["USER"],
                           "installDir": str(managed), "port": args.port, "workspaceId": workspace}, profile
        assert record["environment"].get("YUZUNO_SERVICE_PORTS") == "4492-4493" and "USER" not in record["environment"], record
        step("recorded", workspace=workspace, entry=os.readlink(managed / "updates/start"), profile=profile,
             recordedNames=sorted(record["environment"]))

        # 2. The lab desktop connects and keeps where Core is installed.
        paths = windows("Paths")
        report["desktop"] = {"build": args.desktop_build, "sha256": paths["sha256"]}
        saved_path = Path(subprocess.run(["wslpath", "-u", paths["appData"]], capture_output=True, text=True, check=True).stdout.strip()) / "core.json"
        if saved_path.exists():
            saved_path.unlink()  # the lab identity's own saved Core from an earlier run
        desktop = windows("Launch", CoreUrl=url, CdpPort=args.cdp_port)["pid"]
        until(lambda: devtools(args.cdp_port), 60, "the lab window's DevTools")
        connected = window("connected")
        saved = json.loads(saved_path.read_text())
        # Saved, but not confirmed: only the Core has said where it is.
        assert saved == {"coreUrl": url + "/", "start": {"wslDistro": profile["wslDistro"], "user": profile["user"],
                                                          "installDir": str(managed), "workspaceId": workspace,
                                                          "confirmed": False}}, saved
        step("connected-and-saved", url=connected["url"], saved=saved)

        # 3. Core stops; the page offers the start, which starts it through wsl.exe.
        stop(first.pid, managed)
        started = window("start")
        assert started["startShown"] and started["startLabel"] == "Start in this computer's WSL", started
        assert started["disabledDuringStart"], started
        second = until(lambda: listener(args.port), 10, "the started Core's listener")
        lab_cores.append(second)
        facts = process(second)
        assert facts["exe"] == str(release) and facts["argv"] == expected_argv, facts
        assert facts["session"] == second, "its own session"
        assert facts["servicePorts"] == "4492-4493", facts
        assert health(args.port)["workspaceId"] == workspace and starts() == 1
        # The start stays while Core runs, and with it a hidden wsl.exe, so
        # WSL keeps the distribution running.
        keeping = observe()
        assert keeping["wsl"] and len(keeping["helpers"]) == 1, keeping
        # This computer's start entry accepted the installation: confirmed.
        assert json.loads(saved_path.read_text())["start"]["confirmed"] is True
        step("started-from-the-window", seconds=started["seconds"], offered=started["connectError"],
             during=started["duringStart"], core=facts, keeping=keeping, confirmed=True)

        # 4. It outlives wsl.exe, which has exited by now (the start waited for it).
        time.sleep(20)
        assert listener(args.port) == second and health(args.port)["workspaceId"] == workspace
        step("still-running-20s-later", pid=second)

        # 5. Closing the window, as its close button does, leaves Core and
        #    every process of its session (what its Agents would run) alone.
        before = session(second)
        closed = windows("CloseWindow", DesktopProcessId=desktop)
        desktop = None if closed["exited"] else desktop
        assert closed["exited"], closed
        time.sleep(10)
        after = session(second)
        assert listener(args.port) == second and health(args.port)["workspaceId"] == workspace
        assert set(before) <= set(after), (before, after)
        still = observe()
        assert still["wsl"] == keeping["wsl"] and still["helpers"] == keeping["helpers"], (keeping, still)
        step("window-closed-core-stays", close=closed, sessionBefore=before, sessionAfter=after, keeping=still)
        until(lambda: not devtools(args.cdp_port), 60, "the closed window's DevTools to go")
        desktop = windows("Launch", CoreUrl=url, CdpPort=args.cdp_port)["pid"]
        until(lambda: devtools(args.cdp_port), 60, "the lab window's DevTools")
        window("connected")
        # Reopened (an app restart, not a Windows one) and connected again to
        # the same Core: still confirmed.
        assert json.loads(saved_path.read_text())["start"]["confirmed"] is True

        # 5. A Core that answers is opened, never started again.
        running = window("running")
        assert listener(args.port) == second and starts() == 1, running
        step("running-is-not-restarted", answer=running["answer"])

        # 6. Two starts at once: one runs, the other is told.
        stop(second, managed)
        twice = window("twice")
        third = until(lambda: listener(args.port), 10, "the Core of the double start")
        lab_cores.append(third)
        answers = twice["answers"]
        assert sorted("ok" in one for one in answers) == [False, True], answers
        assert any("already being started" in one.get("error", "") for one in answers), answers
        assert starts() == 2, starts()
        step("two-starts-one-core", answers=answers)

        # 7. The window is killed while its start runs. What becomes of the
        #    start is observed: the wsl.exe running it (and its parent) on
        #    Windows, the helper and Core in WSL. The start goes on without the
        #    window, and the Core it starts stays.
        stop(third, managed)


        window("click-start")
        # This window's own start: a wsl.exe it launched. An earlier start
        # that stays (and its wsl.exe) is not this one.
        seen = {"beforeKill": until(lambda: (lambda o: o if any(w["parent"] == desktop for w in o["wsl"]) else None)(observe()), 20,
                                    "this window's start to be under way")}
        windows("Kill", DesktopProcessId=desktop)
        desktop = None
        killed_at = time.monotonic()
        time.sleep(3)
        seen["3sAfterKill"] = observe()
        # A debug Core checks its 1 GB release before it listens.
        fourth = until(lambda: listener(args.port), 180, "the start to go on after the window was killed")
        lab_cores.append(fourth)
        until(lambda: (health(args.port) or {}).get("workspaceId") == workspace, 120, "that Core to answer")
        seen["answering"] = {"secondsAfterKill": round(time.monotonic() - killed_at, 1), **observe()}
        time.sleep(20)
        assert listener(args.port) == fourth, "the Core a killed window started was stopped"
        seen["20sLater"] = observe()
        seen["core"] = process(fourth)
        assert starts() == 3, starts()
        step("window-killed-mid-start", **seen)
        until(lambda: not devtools(args.cdp_port), 60, "the killed window's DevTools to go")
        stop(fourth, managed)
        desktop = windows("Launch", CoreUrl=url, CdpPort=args.cdp_port)["pid"]
        until(lambda: devtools(args.cdp_port), 60, "the lab window's DevTools")

        # 8. Something else holds the port: nothing is started.
        other = subprocess.Popen([sys.executable, "-m", "http.server", str(args.port), "--bind", "127.0.0.1"],
                                 cwd=lab, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            until(lambda: listener(args.port) == other.pid, 10, "the other program's listener")
            taken = window("port-taken")
            assert "Nothing was started" in taken["error"] and listener(args.port) == other.pid, taken
            assert not observe()["cores"]
            step("port-held-by-another-program", error=taken["error"])
        finally:
            other.terminate()
            other.wait(10)

        # 9. What WSL itself refuses, said in the page: a distribution or an
        #    installation that is not there.
        for name, change in [("no-such-distribution", {"wslDistro": "NoSuchT171"}),
                             ("no-such-installation", {"installDir": str(lab / "gone")})]:
            windows("Kill", DesktopProcessId=desktop)
            desktop = None
            until(lambda: not devtools(args.cdp_port), 60, "the closed window's DevTools to go")
            changed = json.loads(saved_path.read_text())
            changed["start"] = {**saved["start"], **change}
            saved_path.write_text(json.dumps(changed))
            desktop = windows("Launch", CdpPort=args.cdp_port)["pid"]
            until(lambda: devtools(args.cdp_port), 60, "the lab window's DevTools")
            refused = window("refused")
            assert refused["startShown"] and refused["error"].startswith("WSL could not run Yuzuno's start"), refused
            assert listener(args.port) is None and not observe()["cores"]
            # WSL's own failure is not "not installed here": kept as it was.
            assert json.loads(saved_path.read_text())["start"] == changed["start"]
            step(name, label=refused["startLabel"], error=refused["error"])

        # 9b. A Core reached at a loopback address that is not this computer's,
        #     as through an SSH tunnel: a stand-in on a port of its own, saying
        #     it is installed where this computer's installation recorded
        #     another port. Offered unconfirmed; refused by this computer's
        #     start entry; then offered no more. Nothing starts.
        windows("Kill", DesktopProcessId=desktop)
        desktop = None
        until(lambda: not devtools(args.cdp_port), 60, "the closed window's DevTools to go")
        remote_port = args.port + 3
        remote_url = f"http://127.0.0.1:{remote_port}"
        remote_workspace = "a0a0a0a0-1111-4222-8333-944444444444"
        stand_in = subprocess.Popen([sys.executable, "-c", STAND_IN, str(remote_port), json.dumps({
            "available": True, "wslDistro": profile["wslDistro"], "user": profile["user"],
            "installDir": str(managed), "port": remote_port, "workspaceId": remote_workspace})],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            until(lambda: (health(remote_port) or {}).get("workspaceId") == remote_workspace, 20, "the stand-in")
            desktop = windows("Launch", CoreUrl=remote_url, CdpPort=args.cdp_port)["pid"]
            until(lambda: devtools(args.cdp_port), 60, "the lab window's DevTools")
            window("connected", remote_url)
            remembered = json.loads(saved_path.read_text())
            assert remembered["coreUrl"] == remote_url + "/" and remembered["start"]["confirmed"] is False, remembered
        finally:
            stand_in.terminate()
            stand_in.wait(10)
        before_starts = starts()
        not_here = window("not-here", remote_url)
        assert not_here["startLabel"] == "Start in this computer's WSL", not_here
        assert "no matching installation" in not_here["error"] and not not_here["startShownAfter"], not_here
        forgotten = json.loads(saved_path.read_text())
        assert forgotten == {"coreUrl": remote_url + "/"}, forgotten
        assert starts() == before_starts and not observe()["cores"]
        step("remote-stand-in-not-here", label=not_here["startLabel"], hint=not_here["startHint"], error=not_here["error"])
        # 10. With no Core left, the start that kept WSL running ends within
        #     its grace (two minutes), and its wsl.exe with it.
        ended = time.monotonic()
        until(lambda: (lambda seen: not seen["helpers"] and not seen["wsl"])(observe()), 240, "the keeping start to end")
        step("keeping-ends-without-core", seconds=round(time.monotonic() - ended, 1))
        report["passed"] = True
    except Exception as error:  # noqa: BLE001 - recorded, then raised
        report["passed"] = False
        report["error"] = repr(error)
        raise
    finally:
        if desktop:
            try:
                windows("Kill", DesktopProcessId=desktop)
            except Exception as error:  # noqa: BLE001
                report["closeError"] = repr(error)
        for pid in lab_cores:
            if Path(f"/proc/{pid}").exists():
                try:
                    stop(pid, managed)
                except Exception as error:  # noqa: BLE001
                    report.setdefault("cleanupErrors", []).append(repr(error))
        (lab / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(f"report: {lab / 'report.json'}", flush=True)


if __name__ == "__main__":
    main()
