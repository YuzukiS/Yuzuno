#!/usr/bin/env python3
"""Real acceptance of Jobs on Windows on this PC (T-108), from isolated Cores.

    python3 acceptance/windows-jobs/check.py --run t108w-r5

The helper is the committed release input runtimes/windows-jobs, built on
Windows from a fixed commit by tools/build-windows-helper.py. The run checks
it against its windows-helper.json and this tree's windows_job.cs first and
never copies it anywhere by hand. It needs this checkout's debug build of
yuzuno-workspace, yuzuno-update-helper and the local_jobs_lab example.

A. Clean install, the product path: a fixture release is packaged with
   tools/package-release.py from those Core binaries, fixture UI, Claude
   runtime and notices, and the committed helper; its own
   yuzuno-update-helper registers it into a new managed folder, and it runs
   as a managed Core with an empty data folder. Core takes the helper from
   that release and checks its bytes against the release manifest before
   each run; the environment's own YUZUNO_WINDOWS_JOBS_HELPER names a decoy
   that a managed Core must not use. Every item that needs no injected fault
   runs here. Last, the installed helper's bytes are changed (and restored)
   twice: before Core starts, which the release's own verification refuses,
   and under a running Core with an attempt running.
B. Faults, a development configuration: the lab Core (local_jobs_lab) is
   given a wrapper explicitly (YUZUNO_WINDOWS_JOBS_HELPER with its SHA-256)
   that runs the same committed helper, so a dropped start reply and failing
   calls touch only this run's own calls.

Everything on Windows lives under this run's own data roots,
<LocalAppData>\\yuzuno-next-acceptance\\<run> (A) and <run>-faults (B), which
must not exist yet. Nothing is removed: those roots and the lab folder stay
as evidence. No PowerShell, no setting is changed. Fixtures are short cmd.exe
commands; the waits ping 127.0.0.1 (loopback packets only).
"""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import time
import types
import urllib.error
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "remote-jobs"))
import labkit  # noqa: E402

ROOT = labkit.ROOT
HELPER_DIR = ROOT / "runtimes/windows-jobs"
SOURCE = ROOT / "core/src/jobs/windows_job.cs"
RELEASE_HELPER = "runtimes/windows-jobs/yuzuno-jobs-helper.exe"
FAKE_CODEX = ROOT / "acceptance/turn-cost/fake_codex.py"
MARK = "YUZUNO-JOBS-REPLY "
CMD = r"C:\Windows\System32\cmd.exe"
PING = r"C:\Windows\System32\ping.exe"
# Windows' own .NET Framework 4 compiler (as tools/build-windows-helper.py),
# for the load fixture acceptance/windows-jobs/load.cs.
COMPILER = "/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
NAME = "Windows on this PC"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


packager = load("package_release", ROOT / "tools/package-release.py")


class Stop(Exception):
    """The run cannot go on safely; nothing more is started."""


def run_item(report, name, coverage, check):
    """One acceptance item. A failure is recorded and the run goes on; a Stop
    (not safe to go on) is recorded and ends the run: no later item starts."""
    try:
        facts = check()
        report["items"].append({"item": name, "passed": True, "coverage": coverage, "facts": facts})
        print(f"PASS {name} [{coverage}]", flush=True)
    except Stop:
        report["items"].append({"item": name, "passed": False, "coverage": coverage, "error": "stopped"})
        raise
    except Exception as error:  # noqa: BLE001 - every failure is reported as such
        report["items"].append({"item": name, "passed": False, "coverage": coverage, "error": repr(error)})
        print(f"FAIL {name}: {error!r}", flush=True)


def claim_root(root):
    """Creates this run's data root and says whether this call created it.
    The last mkdir is atomic and fails on an existing folder, which is never
    taken for this run's."""
    root.parent.mkdir(parents=True, exist_ok=True)
    try:
        root.mkdir()
    except FileExistsError:
        return False
    return True


def attempts_under(root):
    """Every attempt folder under this run's data root, recorded by Core or not."""
    jobs = root / "jobs"
    if not jobs.is_dir():
        return []
    return [(job.name, attempt.name) for job in sorted(jobs.iterdir()) if job.is_dir()
            for attempt in sorted(job.iterdir()) if attempt.is_dir()]


def listener_pid(port):
    """The PID whose socket listens on 127.0.0.1:port (IPv4), from /proc."""
    inode = None
    for line in Path("/proc/net/tcp").read_text().splitlines()[1:]:
        fields = line.split()
        local, state = fields[1], fields[3]
        if state == "0A" and int(local.split(":")[1], 16) == port:
            inode = fields[9]
            break
    if inode is None:
        return None
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            for fd in (proc / "fd").iterdir():
                if os.readlink(fd) == f"socket:[{inode}]":
                    return int(proc.name)
        except OSError:
            continue
    return None


def port_free(port):
    import socket
    with socket.socket() as probe:
        probe.settimeout(1)
        return probe.connect_ex(("127.0.0.1", port)) != 0


def start_fresh(core, lab, port, connection=True):
    """Starts a Core and proves it is this run's own, just-started instance:
    nothing on the port before, then the live child is the one listening;
    for the lab Core also no old connection file before and a new one for
    this port after."""
    file = lab / "connection.json"
    if file.exists():
        raise Stop(f"{file} is left from another Core; use a new --run")
    if not port_free(port):
        raise Stop(f"port {port} is already in use; nothing was started")
    core.start()
    if core.process.poll() is not None:
        raise Stop("the Core exited right after starting")
    if listener_pid(port) != core.process.pid:
        raise Stop(f"port {port} is not served by the Core just started (pid {core.process.pid})")
    if connection and f"127.0.0.1:{port}" not in json.loads(file.read_text()).get("url", ""):
        raise Stop("the connection file is not this Core's")


def cleanup(root, owned, probes):
    """Nothing is removed: the run's Windows data root is kept as evidence
    (Lead seq 3419). A probe cannot see an attempt between its intent and its
    supervisor's lock, so no probe is taken to show that a run has ended."""
    if root is None or not owned:
        return {"removed": False, "kept": "not this run's data root; left as it is"}
    return {"removed": False, "kept": "this run's data root, as evidence", "probes": probes}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fixture_inputs(folder):
    """The UI, Claude runtime and notices a release must carry; this run uses none of them."""
    (folder / "licenses").mkdir(parents=True)
    for name in ("LICENSE", "THIRD_PARTY_NOTICES-core.txt", "rust-std-COPYRIGHT-library.html",
                 "THIRD_PARTY_NOTICES-claude-runtime.txt"):
        (folder / "licenses" / name).write_text("T-108 acceptance fixture; not a release\n")
    (folder / "web/licenses").mkdir(parents=True)
    (folder / "web/index.html").write_text("<html><head></head><body>T-108 acceptance fixture</body></html>\n")
    (folder / "web/licenses/THIRD_PARTY_NOTICES.txt").write_text("T-108 acceptance fixture\n")
    sdk = folder / "claude/node_modules/@anthropic-ai/claude-agent-sdk"
    sdk.mkdir(parents=True)
    (sdk / "package.json").write_text('{"name": "fixture"}\n')
    (folder / "claude/package.json").write_text("{}\n")
    (folder / "claude/bridge.mjs").write_text("// T-108 acceptance fixture: no Claude runs here\n")
    (folder / "notes.txt").write_text("T-108 Windows Jobs acceptance fixture; never published\n")


def package_fixture(lab, release_id, git_sha, core, update_helper):
    """A fixture release with the committed Windows helper, as packaging ships it."""
    inputs = lab / "fixture-inputs"
    fixture_inputs(inputs)
    args = types.SimpleNamespace(core=core, helper=update_helper, licenses=inputs / "licenses", web=inputs / "web",
                                 claude=inputs / "claude", result_validator=ROOT / "runtimes/result-validator",
                                 windows_helper=HELPER_DIR, out=lab / "bundle", notes_file=inputs / "notes.txt",
                                 release_id=release_id, version="T-108 acceptance fixture", git_sha=git_sha)
    printed = io.StringIO()
    with contextlib.redirect_stdout(printed):
        packager.assemble(args)
    return json.loads(printed.getvalue())


class ManagedCore(labkit.Core):
    """A managed Core run from its installed release, with its own data folder."""

    def __init__(self, lab, port, managed, release_id, data, env):
        super().__init__(lab, port, lab)
        self.managed, self.release_id, self.data, self.env = managed, release_id, data, env

    def start(self):
        executable = self.managed / "releases" / self.release_id / "bin/yuzuno-workspace"
        with (self.lab / "core.log").open("ab") as log:
            self.process = subprocess.Popen(
                [str(executable), "--install-dir", str(self.managed), "--data-dir", str(self.data),
                 "--cwd", str(self.lab / "work"), "--port", str(self.port), "--codex", str(FAKE_CODEX)],
                cwd=self.lab / "work", stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=self.env)
        for _ in range(300):
            if self.process.poll() is not None:
                raise AssertionError("The managed Core exited: " + (self.lab / "core.log").read_text()[-2000:])
            try:
                if self.request("/health").get("releaseId") == self.release_id:
                    return
            except OSError:
                pass
            time.sleep(0.1)
        raise AssertionError("The managed Core did not answer")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--run", required=True, help="run name, e.g. t108w-r5")
    parser.add_argument("--port", type=int, default=4620, help="the managed Core's port (A)")
    parser.add_argument("--lab-port", type=int, default=4621, help="the lab Core's port (B)")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9-]{1,40}", args.run):
        raise SystemExit("--run must be lowercase letters, digits and dashes")
    lab = ROOT / "target/t47" / f"lab-windows-{args.run}"
    committed = HELPER_DIR / "yuzuno-jobs-helper.exe"
    report = {"run": args.run, "items": [], "notCovered": [
        "a real Windows restart (only Core restarts and failed helper calls are covered)",
        "WSL interop turned off (a system setting this run does not change)",
        "Windows GPU, pause and run stages (refused, by design of this slice)",
        "memory over a Job's limit under other programs' pressure, and resident (not committed) memory, which "
        "a Job Object does not limit"]}
    roots = {}  # "install" / "faults" -> (Windows path, WSL path)
    cores = []

    def helper(program, request, *extra):
        """One direct call of a real helper file (this run's own calls only)."""
        request = dict(request, replyNonce=uuid.uuid4().hex)
        done = subprocess.run([str(program), *extra], input=json.dumps(request).encode(), capture_output=True, timeout=60)
        prefix = MARK + request["replyNonce"] + " "
        lines = [line[len(prefix):] for line in done.stdout.decode("utf-8", "replace").split("\n") if line.startswith(prefix)]
        if done.returncode not in (0, 3) or len(lines) != 1:
            raise Stop(f"the helper gave no reply (exit {done.returncode}): {done.stderr.decode('utf-8', 'replace')[:300]}")
        reply = json.loads(lines[0])
        if done.returncode == 3:
            raise Stop(f"the helper refused: {reply.get('error')}")
        return reply

    def claim(key, suffix, local_app_data):
        root_win = local_app_data.rstrip("\\") + "\\yuzuno-next-acceptance\\" + args.run + suffix
        root_wsl = Path(subprocess.run(["wslpath", "-u", root_win], capture_output=True, text=True, check=True).stdout.strip())
        # No link anywhere on its existing parents (the helper checks again).
        for parent in root_wsl.parents:
            if parent in (Path("/mnt"), Path("/")):
                break
            if parent.is_symlink():
                raise Stop(f"{parent} is a link; this run's data root must not be under one")
        if not claim_root(root_wsl):
            raise Stop(f"this run's data root already exists, so it is not this run's: {root_win}")
        roots[key] = (root_win, root_wsl)
        # The helper's test actions work only in a root holding this marker.
        (root_wsl / "acceptance-run.json").write_text(json.dumps({"run": args.run, "part": key, "createdAtUnix": time.time()}))
        (root_wsl / "work").mkdir()
        return root_win

    def item(name, coverage, check):
        run_item(report, name, coverage, check)

    try:
        # 0. A fresh lab, and the committed helper exactly as its record says.
        if lab.exists():
            raise Stop(f"{lab} already exists; use a new --run (nothing there is removed)")
        record = packager.check_windows_helper(HELPER_DIR, SOURCE)
        git_sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
        changed = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT,
                                 capture_output=True, text=True, check=True).stdout.strip()
        binaries = {name: ROOT / "target/debug" / name for name in ("yuzuno-workspace", "yuzuno-update-helper")}
        binaries["local_jobs_lab"] = ROOT / "target/debug/examples/local_jobs_lab"
        report["source"] = {"head": git_sha, "trackedChanges": changed.splitlines(),
                            "binaries": {name: {"sha256": sha256(path), "modifiedAtUnix": path.stat().st_mtime}
                                         for name, path in binaries.items()},
                            "helper": {key: record[key] for key in ("sha256", "bytes", "protocol", "source", "builtAt")}}
        lab.mkdir(parents=True)

        # 1. Hello from the committed file: where the data roots go; it writes nothing.
        hello = helper(committed, {"action": "hello"})
        if hello.get("status") != "hello" or not re.fullmatch(r"[0-9a-f]{32}", hello.get("hostId", "")):
            raise Stop(f"unexpected hello: {hello}")
        report["host"] = {"hostIdPrefix": hello["hostId"][:8], "os": hello.get("os"), "bootId": hello.get("bootId"),
                          "protocol": hello.get("protocol"), "helperSha256OnWindows": hello.get("helperSha256")}
        if hello.get("helperSha256") != record["sha256"] or hello.get("protocol") != record["protocol"]:
            raise Stop(f"the helper answering on Windows is not the committed one: {report['host']}")

        # 2. A: package, register and start a managed Core from a clean install.
        install = lab / "install"
        (install / "work").mkdir(parents=True)
        release_id = "t108w-" + args.run
        receipt = package_fixture(lab, release_id, git_sha, binaries["yuzuno-workspace"], binaries["yuzuno-update-helper"])
        manifest = json.loads((lab / "bundle/manifest.json").read_text())
        if manifest["files"].get(RELEASE_HELPER, {}).get("sha256") != record["sha256"]:
            raise Stop(f"the packaged release does not carry the committed helper: {manifest['files'].get(RELEASE_HELPER)}")
        # Short: its update socket's path must fit a Unix socket address. On disk, not tmpfs.
        managed = Path.home() / ".t108w" / f"{args.run}-managed"
        if managed.exists() or len(str(managed / "updates/control.sock")) > 100:
            raise Stop(f"{managed} exists or is too long for the update socket; use a new --run")
        managed.parent.mkdir(exist_ok=True)
        registered = subprocess.run(
            [str(lab / "bundle/bin/yuzuno-update-helper"), "register", "--install-dir", str(managed), "--bundle", str(lab / "bundle"),
             "--manifest-sha256", receipt["manifestSha256"], "--reviewed-source", "T-108 Windows Jobs acceptance fixture",
             "--initialize"], capture_output=True, text=True, timeout=180)
        if registered.returncode != 0:
            raise Stop(f"registering the fixture release failed: {registered.stderr[-1000:]}")
        installed = managed / "releases" / release_id / RELEASE_HELPER
        report["install"] = {"releaseId": release_id, "manifestSha256": receipt["manifestSha256"], "managed": str(managed),
                             "installedHelper": str(installed), "installedHelperSha256": sha256(installed)}
        install_root = claim("install", "", hello["localAppData"])
        decoy = install / "decoy-helper.exe"
        decoy.write_text("#!/bin/sh\nexit 99\n")
        decoy.chmod(0o755)
        env = {key: value for key, value in os.environ.items() if not key.startswith("YUZUNO_")}
        env.update(YUZUNO_WINDOWS_JOBS_ROOT=install_root, YUZUNO_WINDOWS_JOBS_HELPER=str(decoy),
                   YUZUNO_WINDOWS_JOBS_HELPER_SHA256=sha256(decoy), T9_TIMELINE=str(install / "timeline"))
        core = ManagedCore(install, args.port, managed, release_id, install / "data", env)
        cores.append(core)
        start_fresh(core, install, args.port, connection=False)

        def post(path, body):
            """A request to the managed Core; a refusal is raised with Core's own reason."""
            try:
                return core.request(path, body)
            except urllib.error.HTTPError as error:
                raise AssertionError(f"POST {path}: {error.code} {error.read().decode()[:500]}") from None

        task = post("/collaboration/task_create", {"requestId": "t108w-" + args.run, "title": "T-108 Windows Jobs acceptance"})
        task_id = task["task"]["id"]
        # A job belongs to an Agent: a scripted Codex fixture (no model, no tools), as the release smoke uses.
        agent_id = post("/agents", {"name": "T-108 Windows acceptance", "harness": "codex", "cwd": str(install / "work")})["id"]
        work = install_root + "\\work"

        def submit(label, argv, request_id=None, timeout=120, **extra):
            body = {"requestId": request_id or str(uuid.uuid4()), "taskId": task_id, "agentId": agent_id, "name": label,
                    "cwd": work, "argv": argv, "guardGit": False, "resources": {"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0},
                    "timeoutSeconds": timeout, "machineId": "windows", **extra}
            return post("/jobs", body)

        def processes(job, program=installed, root=None):
            return helper(program, {"action": "test-job-processes", "jobId": job["id"], "attempt": job["attempt"]},
                          "--root", root or install_root, "--test-actions")

        def outcome_record(job):
            """The helper's result record for a finished job, as Core keeps it."""
            return ((job.get("result") or {}).get("evidence") or {}).get("result") or {}

        def runs():
            ok = submit("ok", [CMD, "/d", "/c", "echo begin& echo DONE"])
            done = core.status(ok["id"], "succeeded", "failed", "rejected")
            assert (done["status"], done["reason"]) == ("succeeded", "success"), done
            log = core.request(f"/jobs/{ok['id']}/logs")
            assert log["text"].replace("\r\n", "\n") == "begin\nDONE\n", log
            # The helper Core checked and ran is the release's; what it says of itself agrees.
            pinned = done["remote"]["helper"]
            assert pinned["sha256"] == record["sha256"] == report["install"]["installedHelperSha256"], pinned
            assert pinned["reportedSha256"] == record["sha256"] and pinned["protocol"] == record["protocol"], pinned
            # The supervisor ran from the helper's own content-addressed copy of exactly that file.
            copies = sorted(p.name for p in (roots["install"][1] / "bin").iterdir())
            assert copies == [f"yuzuno-jobs-helper-{record['sha256']}.exe"], copies
            return {"reason": done["reason"], "helper": pinned, "copies": copies,
                    "supervisorBrokeAway": processes(ok).get("breakaway"), "inJobAtExit": outcome_record(done).get("inJobAtExit")}
        item("Clean install: a job runs with the release's own helper, checked by Core; outcome and output come back",
             "real Windows; managed Core from a fixture release with the committed helper", runs)

        def fails():
            bad = submit("bad", [CMD, "/d", "/c", "echo DONE& exit 4"])
            failed = core.status(bad["id"], "succeeded", "failed", "rejected")
            assert (failed["status"], failed["reason"]) == ("failed", "exit-code 4"), failed
            assert outcome_record(failed).get("exitCode") == 4, failed
            return {"reason": failed["reason"], "inJobAtExit": outcome_record(failed).get("inJobAtExit")}
        item("A command that prints DONE and exits 4 is failed", "real Windows; managed Core", fails)

        # The loads for the limit items: load.cs, compiled by Windows' own
        # .NET Framework 4 compiler into this run's work folder (a fixture,
        # not a release input).
        load_exe = work + "\\load.exe"

        def compile_load():
            work_wsl = roots["install"][1] / "work"
            (work_wsl / "load.cs").write_text((Path(__file__).resolve().parent / "load.cs").read_text())
            built = subprocess.run([COMPILER, "/nologo", "/noconfig", "/target:exe", "/platform:x64", "/optimize",
                                    "/r:System.dll", "/out:" + load_exe, work + "\\load.cs"], capture_output=True, timeout=180)
            assert built.returncode == 0, built.stdout.decode("utf-8", "replace")[-1500:]
            return {"loadExe": load_exe, "sha256": sha256(work_wsl / "load.exe"), "bytes": (work_wsl / "load.exe").stat().st_size}
        item("The load fixture builds with Windows' own compiler in this run's folder", "real Windows", compile_load)

        def started_limits(job):
            return (((job.get("result") or {}).get("evidence") or {}).get("started") or {}).get("limits") or {}

        def last_line(job_id):
            lines = [l for l in core.request(f"/jobs/{job_id}/logs")["text"].splitlines() if l.startswith("{")]
            return json.loads(lines[-1]) if lines else {}

        def memory_over():
            over = submit("memory over", [load_exe, "memory", "16", "256", "0"],
                          resources={"cpuMillis": 500, "memoryMiB": 64, "swapMiB": 0})
            done = core.status(over["id"], "succeeded", "failed", "rejected", seconds=90)
            plan, used, reached = started_limits(done), outcome_record(done).get("limits") or {}, last_line(over["id"])
            assert (done["status"], done["reason"]) == ("failed", "exit-code 3"), done
            assert reached.get("refused") == 16 and reached.get("mib", 64) < 64, reached
            assert plan["memory"] == "limited" and plan["held"]["jobMemoryLimitBytes"] == 64 << 20, plan
            assert any("committed memory" in c for c in plan["caveats"]), plan["caveats"]
            # Recorded as Windows reports it, not compared with the limit: run
            # t108w-r9 showed PeakJobMemoryUsed 81076224 bytes above the
            # 67108864-byte limit the Job Object enforced (the refused step is
            # the proof). The native control below (runs t108w-r11, r12) shows
            # Windows' peak counters include the commit it refused: the peak
            # rose by the refused 8 MiB while PrivateUsage did not, error 1455.
            # This run's peak (48 MiB held, 16 refused) matches the within run's
            # (64 MiB held), consistent with that.
            assert used.get("peakJobMemoryBytes", 0) > 0, used
            return {"lastStep": reached, "held": plan["held"], "peakJobMemoryBytes": used.get("peakJobMemoryBytes"),
                    "peakAboveLimit": used.get("peakJobMemoryBytes", 0) > 64 << 20}
        item("Memory over its 64 MiB limit: the Job Object refuses the commit that would exceed it, nothing is killed",
             "real Windows; managed Core; the job's own allocation", memory_over)

        def memory_within():
            ok = submit("memory within", [load_exe, "memory", "16", "64", "1"],
                        resources={"cpuMillis": 500, "memoryMiB": 256, "swapMiB": 0})
            done = core.status(ok["id"], "succeeded", "failed", "rejected", seconds=90)
            plan, used = started_limits(done), outcome_record(done).get("limits") or {}
            assert done["status"] == "succeeded", done
            assert plan["held"]["jobMemoryLimitBytes"] == 256 << 20, plan
            assert 64 << 20 < used.get("peakJobMemoryBytes", 0) <= 256 << 20, used
            return {"peakJobMemoryBytes": used["peakJobMemoryBytes"]}
        item("Within its limit the job succeeds and its peak committed memory is recorded", "real Windows; managed Core",
             memory_within)

        def cpu_cap():
            burn = submit("cpu", [load_exe, "cpu", "2", "3"], resources={"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0})
            done = core.status(burn["id"], "succeeded", "failed", "rejected", seconds=90)
            plan, measured = started_limits(done), last_line(burn["id"])
            assert done["status"] == "succeeded" and "cores" in measured, (done, measured)
            held = plan["held"]
            assert plan["cpu"] == "limited" and held["cpuRatePer"] == 10000, plan
            assert held["cpuRate"] == max(1, min(10000, 500 * 10 // held["processors"])), held
            assert measured["cores"] < 0.75, measured
            return {"held": held, "measuredCores": measured["cores"]}
        item("CPU of 500 millicores, two busy threads for 3 s: the Job Object's hard cap holds them near half a core",
             "real Windows; managed Core; small load", cpu_cap)

        # The memory limit observed with native commits (native.cs): the same
        # load under a low and a high limit, and two processes of one Job. Each
        # step's commit, PrivateUsage and the Job's peak are recorded as Windows
        # reports them; nothing is clamped or compared away.
        native_exe = work + "\\native.exe"

        def compile_native():
            work_wsl = roots["install"][1] / "work"
            (work_wsl / "native.cs").write_text((Path(__file__).resolve().parent / "native.cs").read_text())
            built = subprocess.run([COMPILER, "/nologo", "/noconfig", "/target:exe", "/platform:x64", "/optimize",
                                    "/r:System.dll", "/out:" + native_exe, work + "\\native.cs"], capture_output=True, timeout=180)
            assert built.returncode == 0, built.stdout.decode("utf-8", "replace")[-1500:]
            return {"nativeExe": native_exe, "sha256": sha256(work_wsl / "native.exe")}
        item("The native fixture builds with Windows' own compiler in this run's folder", "real Windows", compile_native)

        def events(job_id):
            return [json.loads(l) for l in core.request(f"/jobs/{job_id}/logs")["text"].splitlines() if l.startswith("{")]

        def native_run(label, argv, memory_mib):
            job = submit(label, [native_exe, *argv], resources={"cpuMillis": 500, "memoryMiB": memory_mib, "swapMiB": 0})
            done = core.status(job["id"], "succeeded", "failed", "rejected", seconds=120)
            seen = events(job["id"])
            start = seen[0] if seen and seen[0].get("event") == "start" else {}
            # As compiled on this Windows: JOBOBJECT_EXTENDED_LIMIT_INFORMATION's x64 layout.
            assert start.get("struct") == {"extendedSize": 144, "jobMemoryLimitOffset": 120, "peakJobMemoryUsedOffset": 136}, start
            # The Job and its limit are in force when the program first runs.
            assert start["inJob"] is True and start["job"]["limitFlags"] & 0x200, start
            assert start["job"]["jobMemoryLimit"] == memory_mib << 20, start
            facts = {"status": done["status"], "reason": done["reason"], "start": start,
                     "steps": [e for e in seen if e.get("event") == "step"],
                     "refused": [e for e in seen if e.get("event") == "refused"],
                     "child": [e for e in seen if e.get("event") in ("child", "childExit")],
                     "peakJobMemoryBytesAtExit": (outcome_record(done).get("limits") or {}).get("peakJobMemoryBytes")}
            return done, facts

        def native_low():
            done, facts = native_run("native low", ["alloc", "8", "256"], 64)
            assert (done["status"], done["reason"]) == ("failed", "exit-code 3"), done
            assert len(facts["refused"]) == 1 and facts["refused"][0]["lastError"] != 0, facts["refused"]
            return facts
        item("Native commits under a 64 MiB Job limit: the commit that would exceed it fails with its Win32 error",
             "real Windows; managed Core; VirtualAlloc in 8 MiB steps", native_low)

        def native_high():
            done, facts = native_run("native high", ["alloc", "8", "256"], 512)
            assert done["status"] == "succeeded" and len(facts["steps"]) == 32 and not facts["refused"], facts
            return facts
        item("The same native load under a 512 MiB Job limit commits all 256 MiB (the control)",
             "real Windows; managed Core", native_high)

        def native_pair():
            # 24 + 24 MiB with two runtimes of about 12 MB each: the child starts
            # and its own commit is what the Job refuses. (Run t108w-r11 used
            # 40 + 40: the child's .NET runtime could not even start in what was
            # left, exit 0xE0434352 before its first line.)
            done, facts = native_run("native pair", ["pair", "24", "24"], 64)
            child_lines = [e["line"] for e in facts["child"] if e.get("event") == "child"]
            child_refused = [line for line in child_lines if line.get("event") == "refused"]
            assert len(facts["steps"]) == 1 and facts["steps"][0]["committedMiB"] == 24, facts["steps"]
            assert child_lines and child_lines[0].get("event") == "start" and child_lines[0]["inJob"] is True, child_lines
            assert len(child_refused) == 1 and child_refused[0]["lastError"] != 0, child_lines
            assert (done["status"], done["reason"]) == ("failed", "exit-code 4"), done
            return facts
        item("Two processes of one Job under its 64 MiB limit: 24 MiB in the parent, then the child's 24 MiB is refused",
             "real Windows; managed Core; the child is the parent's own process, in its Job", native_pair)

        def leaves_a_child():
            # The command exits at once and leaves a background ping in its Job:
            # a real leftover, which must be stopped and reported, not drained away.
            left = submit("leaves", [CMD, "/d", "/c", f"start /b {PING} -n 60 127.0.0.1 >nul & exit 0"])
            done = core.status(left["id"], "succeeded", "failed", "rejected", seconds=60)
            assert done["status"] == "succeeded", done
            assert done["reason"].startswith("success; ") and \
                "still in its Job Object 5 s after it exited were stopped" in done["reason"], done
            record_ = outcome_record(done)
            # The helper reports image names (diagnostic only), e.g. PING.EXE.
            images = [str(p.get("image") or "").lower().rsplit("\\", 1)[-1] for p in record_.get("leftoverProcesses") or []]
            assert "ping.exe" in images, record_
            after = processes(left)
            assert after["processes"] <= 0, after
            return {"reason": done["reason"], "leftoverProcesses": record_.get("leftoverProcesses"),
                    "inJobAtExit": record_.get("inJobAtExit"), "jobAfter": after["processes"]}
        item("A command that leaves a child: the child is stopped after the grace and reported by name",
             "real Windows; managed Core", leaves_a_child)

        def dedup():
            key = str(uuid.uuid4())
            first = submit("same", [CMD, "/d", "/c", "echo once"], request_id=key)
            again = submit("same", [CMD, "/d", "/c", "echo once"], request_id=key)
            assert first["id"] == again["id"], (first["id"], again["id"])
            done = core.status(first["id"], "succeeded", "failed", "rejected")
            assert done["status"] == "succeeded", done
            return {"job": first["id"], "status": done["status"]}
        item("The same requestId is the same job", "real Windows; managed Core", dedup)

        def core_restart():
            long = submit("restart", [CMD, "/d", "/c", f"{PING} -n 15 127.0.0.1 >nul"])
            core.status(long["id"], "running")
            core.stop()
            time.sleep(3)
            start_fresh(core, install, args.port, connection=False)
            done = core.status(long["id"], "succeeded", "failed", seconds=90)
            assert done["status"] == "succeeded" and done["attempt"] == long["attempt"], done
            return {"after": done["status"]}
        item("The managed Core restarts mid-run and finds the same attempt", "real Windows; managed Core restarted",
             core_restart)

        def cancel_tree():
            tree = submit("tree", [CMD, "/d", "/c", f"start /b {PING} -n 120 127.0.0.1 >nul & {PING} -n 120 127.0.0.1 >nul"])
            core.status(tree["id"], "running")
            time.sleep(3)
            before = processes(tree)
            assert before["processes"] >= 2, before
            core.request(f"/jobs/{tree['id']}/cancel", {})
            done = core.status(tree["id"], "cancelled", seconds=60)
            after = labkit.wait_for(lambda: processes(tree), lambda r: r["processes"] <= 0, 30)
            return {"before": before["processes"], "after": after["processes"], "reason": done["reason"]}
        item("Cancel stops the attempt's whole tree (its Job Object holds nothing after)", "real Windows; managed Core",
             cancel_tree)

        def supervisor_killed():
            orphan = submit("orphan", [CMD, "/d", "/c", f"{PING} -n 60 127.0.0.1 >nul"])
            core.status(orphan["id"], "running")
            killed = helper(installed, {"action": "test-kill-supervisor", "jobId": orphan["id"], "attempt": orphan["attempt"]},
                            "--root", install_root, "--test-actions")
            assert killed["status"] == "killed", killed
            lost = core.status(orphan["id"], "unknown", seconds=60)
            assert lost["reserved"] is True, lost
            left = labkit.wait_for(lambda: processes(orphan), lambda r: r["processes"] <= 0, 30)
            core.request(f"/jobs/{orphan['id']}/cancel", {})
            released = core.status(orphan["id"], "cancelled", seconds=60)
            return {"lostReason": lost["reason"], "processesLeft": left["processes"], "after": released["status"]}
        item("The supervisor killed (same-handle check): unknown with the slot held; its Job's processes end with it",
             "real Windows; this run killed only its own attempt's supervisor", supervisor_killed)

        def refused():
            body = {"requestId": str(uuid.uuid4()), "taskId": task_id, "agentId": agent_id, "name": "gpu", "cwd": work,
                    "argv": [CMD, "/d", "/c", "echo"], "guardGit": False, "machineId": "windows",
                    "resources": {"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0}, "gpu": {"memoryMiB": 1024}}
            gpu = core.refused("/jobs", body)
            assert "GPU" in gpu, gpu
            return {"gpu": gpu[:300]}
        item("GPU admission is refused for a Windows job, with the reason", "managed Core", refused)

        @contextlib.contextmanager
        def changed_helper():
            """The installed fixture's helper with one byte more, restored afterwards."""
            original = installed.read_bytes()
            installed.chmod(0o755)
            installed.write_bytes(original + b"\0")
            try:
                yield
            finally:
                installed.write_bytes(original)
                installed.chmod(0o555)
            assert sha256(installed) == record["sha256"]

        def changed_before_start():
            # The release no longer matches its manifest: Core refuses to start from it at all.
            core.stop()
            with changed_helper():
                refused = ManagedCore(install, args.port, managed, release_id, install / "data", env)
                try:
                    refused.start()
                    started = True
                except AssertionError:
                    started = False
                finally:
                    refused.stop()
                log = (install / "core.log").read_text()[-3000:]
            assert not started, "the managed Core started from a changed release"
            assert f"Release asset differs: {RELEASE_HELPER}" in log, log
            assert port_free(args.port)
            start_fresh(core, install, args.port, connection=False)
            return {"refusal": f"Release asset differs: {RELEASE_HELPER}"}
        item("Changed helper bytes before Core starts: the release fails its own verification and Core does not start",
             "managed Core; the installed fixture's helper changed and restored by this run", changed_before_start)

        def changed_while_running():
            # Changed under a running Core: no new work is started, and the running
            # attempt is held unknown, never ended; once restored it goes on.
            active = submit("active", [CMD, "/d", "/c", f"{PING} -n 60 127.0.0.1 >nul"])
            core.status(active["id"], "running")
            with changed_helper():
                job = submit("changed", [CMD, "/d", "/c", "echo never"])
                refused = core.status(job["id"], "rejected", "succeeded", "failed")
                held = core.status(active["id"], "unknown", "succeeded", "failed", "cancelled", seconds=60)
            assert refused["status"] == "rejected", refused
            assert refused["reason"].startswith(f"Not started on {NAME}: the Windows Jobs helper at "), refused
            assert f"/releases/{release_id}/{RELEASE_HELPER} is not the one this Core trusts" in refused["reason"], refused
            remote = refused.get("remote") or {}
            assert remote.get("startSentAt") is None and remote.get("hostId") is None, refused
            assert held["status"] == "unknown" and held["reserved"] is True and held["attempt"] == active["attempt"], held
            assert "is not the one this Core trusts" in held["result"]["evidence"]["error"], held
            done = core.status(active["id"], "succeeded", "failed", "cancelled", seconds=120)
            assert done["status"] == "succeeded" and done["attempt"] == active["attempt"], done
            return {"newJob": refused["reason"], "activeWhileChanged": held["reason"], "activeAfter": done["status"]}
        item("Changed helper bytes under a running Core: no new job starts; the running attempt is held unknown, then finishes",
             "real Windows; managed Core; the installed fixture's helper changed and restored by this run", changed_while_running)
        core.stop()

        # 3. B: faults through a wrapper the lab Core is given explicitly.
        faults_root = claim("faults", "-faults", hello["localAppData"])
        faults = lab / "faults"
        fault = faults / "fault"
        fault.mkdir(parents=True)
        wrapper = faults / "wrapper/yuzuno-jobs-helper"
        wrapper.parent.mkdir()
        wrapper.write_text(f"""#!/bin/sh
# This run's helper wrapper: a fault here touches only this lab Core's calls.
fault='{fault}'
real='{committed}'
if [ -e "$fault/down" ]; then echo "acceptance fault: this run's helper call failed" >&2; exit 255; fi
if [ -e "$fault/lose-start" ]; then
  request=$(cat)
  case "$request" in *'"action":"start"'*)
    rm -f "$fault/lose-start"
    printf '%s' "$request" | "$real" "$@" >/dev/null 2>&1
    echo "acceptance fault: the reply to this start was dropped" >&2
    exit 255;;
  esac
  printf '%s' "$request" | "$real" "$@"
  exit $?
fi
exec "$real" "$@"
""")
        wrapper.chmod(0o755)
        os.environ.update(YUZUNO_WINDOWS_JOBS_ROOT=faults_root, YUZUNO_WINDOWS_JOBS_HELPER=str(wrapper),
                          YUZUNO_WINDOWS_JOBS_HELPER_SHA256=sha256(wrapper))
        (faults / "bin").mkdir()
        lab_core = labkit.Core(faults, args.lab_port, faults / "bin")
        cores.append(lab_core)
        start_fresh(lab_core, faults, args.lab_port)
        mcp = lab_core.mcp()
        faults_work = faults_root + "\\work"

        def lab_submit(label, argv):
            return mcp.call("job_submit", {"requestId": str(uuid.uuid4()), "taskId": "T-1", "name": label, "cwd": faults_work,
                                           "argv": argv, "guardGit": False, "timeoutSeconds": 120, "machineId": "windows",
                                           "resources": {"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0}})

        def lost_start():
            (fault / "lose-start").write_text("")
            lost = lab_submit("lost", [CMD, "/d", "/c", f"{PING} -n 4 127.0.0.1 >nul"])
            unknown = lab_core.status(lost["id"], "unknown", seconds=60)
            assert unknown["reason"].startswith(f"No acknowledgement from {NAME}"), unknown
            done = lab_core.status(lost["id"], "succeeded", "failed", seconds=90)
            assert done["status"] == "succeeded" and done["attempt"] == lost["attempt"], done
            # Behind the wrapper, the committed helper answered.
            assert done["remote"]["helper"]["reportedSha256"] == record["sha256"], done["remote"]
            return {"unknownReason": unknown["reason"], "helper": done["remote"]["helper"]}
        item("A start whose reply is lost: unknown, then the same attempt is found",
             "real Windows; the reply was dropped by this run's wrapper (development configuration)", lost_start)

        def call_failures():
            steady = lab_submit("steady", [CMD, "/d", "/c", f"{PING} -n 25 127.0.0.1 >nul"])
            lab_core.status(steady["id"], "running")
            (fault / "down").write_text("")
            try:
                unknown = lab_core.status(steady["id"], "unknown", seconds=60)
                assert unknown["reserved"] is True, unknown
                time.sleep(15)
                told = [m for m in lab_core.mails(steady["id"]) if m["metadata"].get("status") == "unknown"]
                assert len(told) == 1, told
            finally:
                (fault / "down").unlink()
            done = lab_core.status(steady["id"], "succeeded", "failed", seconds=90)
            assert done["status"] == "succeeded" and done["attempt"] == steady["attempt"], done
            return {"unknownReason": unknown["reason"]}
        item("Helper calls fail mid-run: unknown with the slot held, told once; then the same attempt finishes",
             "real Windows kept running; only this lab Core's calls failed (development configuration)", call_failures)
    except Stop as stop:
        report["stopped"] = str(stop)
        print(f"STOP {stop}", flush=True)
    except Exception as error:  # noqa: BLE001 - an unexpected setup error is reported, never passed
        report["stopped"] = f"unexpected error: {error!r}"
        print(f"STOP unexpected error: {error!r}", flush=True)
    finally:
        for core in cores:
            core.stop()
        # Report only: every attempt folder under this run's roots, whether or
        # not Core's reply reached this run, as the committed helper's probe shows it now.
        report["cleanup"] = {}
        for key, (root_win, root_wsl) in roots.items():
            probes = []
            for job_id, attempt in attempts_under(root_wsl):
                try:
                    state = helper(committed, {"action": "test-job-processes", "jobId": job_id, "attempt": attempt},
                                   "--root", root_win, "--test-actions")
                except Exception as error:  # noqa: BLE001 - reported as it is
                    state = {"error": repr(error)}
                probes.append({"jobId": job_id, "attempt": attempt, "probe": state})
            report["cleanup"][key] = dict(cleanup(root_wsl, True, probes), root=root_win)
            print(f"KEPT {key}: {root_win} ({len(probes)} attempt(s) probed)", flush=True)
        report["passed"] = all(i["passed"] for i in report["items"]) and "stopped" not in report and bool(report["items"])
        if lab.exists():
            (lab / "report.json").write_text(json.dumps(report, indent=2))
        else:
            print(json.dumps(report, indent=2))
    sys.exit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
