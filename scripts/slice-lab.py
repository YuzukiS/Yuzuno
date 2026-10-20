#!/usr/bin/env python3
"""Isolated multi-agent slice build/acceptance lab; never uses the daily Core.

No third-party Python packages. `prepare` and `check-web` do not start a Core,
model, SSH connection, or browser. Only `start-core` starts a lab runtime.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
LAB = ROOT / "acceptance/multi-agent"
WEB = LAB / "web-build-src"
DATA = LAB / "core-data"
TASKS = LAB / "tasks"
# This checkout's own target (or a shared $CARGO_TARGET_DIR), on disk; builds
# go through source_build.py, which keeps a shared one safe.
TARGET = Path(os.environ.get("CARGO_TARGET_DIR") or ROOT / "target")
SOURCE_BUILD = ROOT / "scripts/source_build.py"
PORT = 4327
BASE = f"http://127.0.0.1:{PORT}"
PROCESS = LAB / "core-process.json"
DAILY = LAB / "daily-baseline.json"


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def load(path):
    return json.loads(path.read_text())


def request_json(url):
    # GET only. Bypass ambient proxies for these strictly loopback endpoints.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=3) as response:
        return json.load(response)


def process_info(pid):
    path = Path("/proc") / str(pid)
    try:
        raw = (path / "stat").read_text()
        # comm can contain spaces/parentheses; field 22 follows its last ')'.
        tail = raw[raw.rfind(")") + 2 :].split()
        return {
            "pid": pid,
            "startTicks": tail[19],
            "state": tail[0],
            "argv": (path / "cmdline").read_bytes().decode().rstrip("\0").split("\0"),
        }
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None


def listener_pids(port):
    result = subprocess.run(
        ["ss", "-ltnp", f"sport = :{port}"],
        text=True, capture_output=True, check=True,
    )
    return sorted({int(pid) for pid in re.findall(r"pid=(\d+)", result.stdout)})


def hashes(directory):
    return {
        str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.rglob("*")) if path.is_file()
    }


def daily_state():
    try:
        health = request_json("http://127.0.0.1:4317/api/health")
    except Exception as error:
        health = {"error": str(error)}
    return {
        "observedAt": now(),
        "health": health,
        "processes": [process_info(pid) for pid in listener_pids(4317)],
        "webDist": hashes(ROOT / "web/dist"),
    }


def baseline():
    if not DAILY.exists():
        save(DAILY, daily_state())
        print(f"Recorded read-only daily baseline: {DAILY}")
    else:
        print(f"Preserving existing daily baseline: {DAILY}")


def verify_daily():
    if not DAILY.exists():
        raise RuntimeError("Run prepare first; no daily baseline exists.")
    before, after = load(DAILY), daily_state()
    before_files, after_files = before["webDist"], after["webDist"]
    changed = sorted(
        name for name in before_files.keys() | after_files.keys()
        if before_files.get(name) != after_files.get(name)
    )
    # A live process changes between sleeping/running; that is not a restart.
    identity = lambda records: [
        {k: value for k, value in record.items() if k != "state"}
        for record in records if record
    ]
    same_process = identity(before["processes"]) == identity(after["processes"])
    report = {
        "checkedAt": now(), "sameDailyProcess": same_process,
        "dailyWebDistUnchanged": not changed, "changedFiles": changed,
        "currentHealth": after["health"], "currentProcesses": after["processes"],
        "note": "Read-only comparison; changes by another actor are reported, never repaired.",
    }
    save(LAB / "daily-verification.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if changed or not same_process:
        raise RuntimeError("Daily baseline changed. Investigate; this script will not restore or restart it.")


def snapshot():
    original = ROOT / "web"
    if not (original / "node_modules").is_dir():
        raise RuntimeError("web/node_modules is missing; this script does not install packages.")
    temporary = LAB / "web-build-src.next"
    if temporary.exists():
        shutil.rmtree(temporary)
    ignored = shutil.ignore_patterns("node_modules", "dist", ".env*", "*.tsbuildinfo", ".vite*")
    shutil.copytree(original, temporary, ignore=ignored)
    (temporary / "node_modules").symlink_to(original / "node_modules", target_is_directory=True)
    # The snapshot is self-contained even if somebody starts its Vite dev server.
    config = temporary / "vite.config.ts"
    config.write_text(config.read_text().replace("http://127.0.0.1:4317", BASE))
    manifest = {
        "createdAt": now(), "source": str(original), "snapshot": str(WEB),
        "output": str(WEB / "dist"), "coreUrl": BASE,
        "sourceFiles": {
            str(path.relative_to(temporary)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(temporary.rglob("*"))
            if path.is_file() and "node_modules" not in path.parts
        },
    }
    if WEB.exists():
        shutil.rmtree(WEB)
    temporary.replace(WEB)
    save(LAB / "web-snapshot.json", manifest)
    print(f"Snapshot ready; only build output: {WEB / 'dist'}")


def fixtures():
    for name in ["local-alpha", "local-beta"]:
        task = TASKS / name
        task.mkdir(parents=True, exist_ok=True)
        instructions = task / "TASK-SCOPE.txt"
        if not instructions.exists():
            instructions.write_text(
                "Yuzuno isolated multi-agent acceptance task folder.\n"
                "Work only in this folder. Do not change the source repository, "
                "running Core services, SSH config, credentials, or system settings.\n"
            )
    DATA.mkdir(parents=True, exist_ok=True)


def command(args, cwd=ROOT, env=None):
    print("Running:", " ".join(map(str, args)), flush=True)
    subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True)


def check_web():
    if not (WEB / "package.json").exists():
        raise RuntimeError("Run prepare or snapshot first.")
    env = {key: value for key, value in os.environ.items() if not key.startswith("VITE_")}
    # --configLoader runner avoids Vite's temporary config in shared node_modules.
    command(["npm", "run", "typecheck"], WEB, env)
    command(["node", "node_modules/vite/bin/vite.js", "build", "--configLoader", "runner"], WEB, env)
    command(["node", "tools/create-preview.mjs"], WEB, env)
    command(["node", "tools/ui.test.mjs"], WEB, env)
    save(LAB / "web-check.json", {
        "passedAt": now(), "snapshot": load(LAB / "web-snapshot.json")["createdAt"],
        "checks": ["typecheck", "vite build", "create-preview", "ui.test.mjs"],
        "dist": str(WEB / "dist"),
    })
    verify_daily()


def build_core():
    cargo = shutil.which("cargo") or str(Path.home() / ".cargo/bin/cargo")
    if not Path(cargo).is_file():
        raise RuntimeError("Cargo is unavailable; install/use the existing Rust toolchain first.")
    env = dict(os.environ)
    env["PATH"] = str(Path(cargo).parent) + os.pathsep + env.get("PATH", "")
    # The lab runs its own copy of the binary, recorded with the source it was
    # built from, so later builds in TARGET cannot replace it under the lab.
    command([
        sys.executable, SOURCE_BUILD, "run", "--target-dir", TARGET, "--record", LAB / "core-build.json",
        "--artifact", "yuzuno-workspace", "--copy-to", LAB / "core-bin",
        "--", "cargo", "build", "--locked", "-p", "yuzuno-workspace",
    ], env=env)


def owned_process():
    if not PROCESS.exists():
        return None
    saved = load(PROCESS)
    current = process_info(saved["pid"])
    if current is None or current["state"] == "Z":
        return None
    if current["startTicks"] != saved["startTicks"] or current["argv"] != saved["argv"]:
        raise RuntimeError("Recorded lab PID no longer identifies the same process; refusing to control it.")
    expected = [
        "--port", str(PORT), "--data-dir", str(DATA), "--web-dir", str(WEB / "dist"),
        "--cwd", str(TASKS),
    ]
    if current["argv"][1 : 1 + len(expected)] != expected:
        raise RuntimeError("Lab process flags do not match isolated directories/port.")
    return current


def start_core(codex):
    if owned_process():
        raise RuntimeError("The recorded lab Core is already running.")
    if not (WEB / "dist/index.html").exists():
        raise RuntimeError("Build the isolated UI with check-web first.")
    binary = LAB / "core-bin/yuzuno-workspace"
    if not binary.exists():
        raise RuntimeError("Build the isolated Core with build-core first.")
    built = subprocess.run([sys.executable, str(SOURCE_BUILD), "verify", "--record", str(LAB / "core-build.json")],
                           capture_output=True, text=True)
    if built.returncode:
        raise RuntimeError(f"The lab's Core binary is not this source's build: {built.stderr.strip()} Run build-core again.")
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", PORT))
    fixtures()
    args = [str(binary), "--port", str(PORT), "--data-dir", str(DATA),
            "--web-dir", str(WEB / "dist"), "--cwd", str(TASKS), "--codex", codex]
    with (LAB / "core.log").open("ab") as log:
        child = subprocess.Popen(args, cwd=ROOT, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=log, start_new_session=True)
    current = process_info(child.pid)
    if not current:
        raise RuntimeError("Lab Core exited immediately; inspect acceptance/multi-agent/core.log.")
    save(PROCESS, {**current, "startedAt": now(), "baseUrl": BASE, "dataDir": str(DATA)})
    for _ in range(100):
        if child.poll() is not None:
            raise RuntimeError("Lab Core exited during startup; inspect its log.")
        try:
            health = request_json(BASE + "/api/health")
            if health.get("product") == "yuzuno" or health.get("application") == "yuzuno-next":
                print(f"Isolated Core running at {BASE}; pid {child.pid}")
                return
        except OSError:
            pass
        time.sleep(0.1)
    raise RuntimeError("Lab Core health timeout; process retained for diagnosis. Use status/stop-core.")


def stop_core():
    current = owned_process()
    if not current:
        print("No owned lab Core is running.")
        return
    # PID-scoped SIGINT only; never pkill, process-name matching, or daily PID.
    os.kill(current["pid"], signal.SIGINT)
    for _ in range(100):
        live = process_info(current["pid"])
        if live is None or live["state"] == "Z":
            print(f"Stopped owned lab Core {current['pid']}.")
            return
        time.sleep(0.1)
    raise RuntimeError("Lab Core did not exit after SIGINT; no stronger signal was sent.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=[
        "prepare", "snapshot", "check-web", "build-core", "start-core", "stop-core",
        "status", "verify-daily",
    ])
    parser.add_argument("--codex", default="codex", help="Lab Core's official Codex executable.")
    options = parser.parse_args()
    LAB.mkdir(parents=True, exist_ok=True)
    with (LAB / ".lab.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if options.action == "prepare":
            baseline()
            fixtures()
            snapshot()
        elif options.action == "snapshot":
            baseline()
            snapshot()
        elif options.action == "check-web":
            check_web()
        elif options.action == "build-core":
            build_core()
        elif options.action == "start-core":
            start_core(options.codex)
        elif options.action == "stop-core":
            stop_core()
        elif options.action == "verify-daily":
            verify_daily()
        else:
            current = owned_process()
            print(json.dumps({"baseUrl": BASE, "process": current, "webDir": str(WEB / "dist"),
                              "dataDir": str(DATA), "targetDir": str(TARGET)}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"slice-lab: {error}", file=sys.stderr)
        sys.exit(1)
