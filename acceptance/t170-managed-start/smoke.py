#!/usr/bin/env python3
"""T-170: the phone's remote entry through an installed Core's own start
entry, with the real Core and update helper.

    python3 acceptance/t170-managed-start/smoke.py --run r1 --target <cargo target>/debug

A fixture release of this tree's Core (the debug yuzuno-workspace and
yuzuno-update-helper in --target, fixture UI) is packaged with
tools/package-release.py and registered into a new managed folder under
/var/tmp, as desktop/tests/start-lab.py does. Its Core runs on loopback ports
of its own, never 4317, with its own data and working folders and a fake
Codex; no model is called, and Tailscale is not used (requests carry the
headers Serve would). The daily Core is never read or changed. The lab folder
and report.json stay as evidence; every lab Core and start is stopped.

In order:
1. Core started once with the documented command records how it started.
2. `updates/start stop` stops it.
3. `updates/start start --remote-…`: the remote entry answers for the login
   and refuses without it, Core's own port refuses Serve's header, and the
   record holds the three settings.
4. While it runs, a start with other settings, or with --no-remote, is
   refused and changes neither the record nor Core.
5. `stop` stops only that Core: the start that stays, and another program
   on a port of its own, go on.
6. `start --no-remote`: the remote port is closed and the record has none
   of the settings.
7. A remote port another program holds: Core exits before it records, so
   the record stays as it was.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import socket
import subprocess
import time
import types
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FAKE_CODEX = ROOT / "acceptance/turn-cost/fake_codex.py"
ORIGIN_HOST = "core.example-tailnet.ts.net:8444"
LOGIN = "person@example.com"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def free(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def request(port, path, headers=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except OSError:
        return None, ""


def health(port):
    status, body = request(port, "/api/health")
    return json.loads(body) if status == 200 else None


def until(check, timeout, what):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.25)
    raise AssertionError(f"timed out waiting for {what}")


def alive(pid):
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except OSError:
        return False
    return state != "Z"


def digest(path):
    with open(path, "rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--run", required=True)
    parser.add_argument("--target", type=Path, required=True, help="cargo target dir with the Core binaries")
    parser.add_argument("--port", type=int, default=4591)
    parser.add_argument("--remote-port", type=int, default=4594)
    parser.add_argument("--other-port", type=int, default=4596)
    args = parser.parse_args()
    assert re.fullmatch(r"[a-z0-9-]{1,12}", args.run)
    ports = (args.port, args.remote_port, args.remote_port + 1, args.other_port, 4592, 4593)
    assert 4317 not in ports, "never the daily Core's port"
    for port in ports:
        assert free(port), f"port {port} is in use"
    # A short path: Core binds a private socket under its install folder.
    lab = Path(f"/var/tmp/t170s-{args.run}")
    lab.mkdir(mode=0o700)
    managed, data, work = lab / "m", lab / "d", lab / "w"
    for folder in (data, work):
        folder.mkdir(mode=0o700)
    report = {"run": args.run, "binaries": {name: digest(args.target / name) for name in ("yuzuno-workspace", "yuzuno-update-helper")},
              "steps": [], "notCovered": [
                  "Tailscale Serve and a phone: requests carry the headers Serve sends",
                  "the Windows desktop app, which passes none of the new options",
                  "a Core update between releases",
                  "stop's second check that Core holds its port, right before the interrupt",
              ]}
    started = []
    workspace = first = None

    def step(name, **facts):
        report["steps"].append({"step": name, **facts})
        print(json.dumps({"step": name, **facts}), flush=True)

    entry = managed / "updates/start"
    record_path = managed / "updates/launch.json"
    env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG") if key in os.environ}
    env["YUZUNO_SERVICE_PORTS"] = "4592-4593"

    def helper(*arguments):
        return subprocess.run([str(entry), *arguments, "--install-dir", str(managed), "--port", str(args.port),
                               "--workspace-id", workspace], capture_output=True, text=True, env=env, timeout=180)

    def start(*options):
        """`updates/start start …`; it stays while the Core it started runs."""
        process = subprocess.Popen([str(entry), "start", "--install-dir", str(managed), "--port", str(args.port),
                                    "--workspace-id", workspace, *options], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, env=env, cwd=work)
        started.append(process)
        line = process.stdout.readline()
        assert line, process.stderr.read()
        return process, json.loads(line)

    def stop():
        done = helper("stop")
        outcome = json.loads(done.stdout.splitlines()[-1])
        return done.returncode, outcome

    remote_headers = {"Host": ORIGIN_HOST, "Tailscale-User-Login": LOGIN}
    other = None
    try:
        # A fixture release of this tree's Core, registered as a new installation.
        packager = load("package_release", ROOT / "tools/package-release.py")
        inputs = lab / "inputs"
        (inputs / "licenses").mkdir(parents=True)
        for name in ("LICENSE", "THIRD_PARTY_NOTICES-core.txt", "rust-std-COPYRIGHT-library.html", "THIRD_PARTY_NOTICES-claude-runtime.txt"):
            (inputs / "licenses" / name).write_text("T-170 lab fixture; not a release\n")
        (inputs / "web/licenses").mkdir(parents=True)
        (inputs / "web/index.html").write_text("<html><head></head><body><h1>T-170 lab Workspace</h1></body></html>\n")
        (inputs / "web/licenses/THIRD_PARTY_NOTICES.txt").write_text("T-170 lab fixture\n")
        sdk = inputs / "claude/node_modules/@anthropic-ai/claude-agent-sdk"
        sdk.mkdir(parents=True)
        (sdk / "package.json").write_text('{"name": "fixture"}\n')
        (inputs / "claude/package.json").write_text("{}\n")
        (inputs / "claude/bridge.mjs").write_text("// T-170 lab fixture: no Claude runs here\n")
        (inputs / "notes.txt").write_text("T-170 lab fixture; never published\n")
        git_sha = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            packager.assemble(types.SimpleNamespace(
                core=args.target / "yuzuno-workspace", helper=args.target / "yuzuno-update-helper",
                licenses=inputs / "licenses", web=inputs / "web", claude=inputs / "claude",
                result_validator=ROOT / "runtimes/result-validator", windows_helper=ROOT / "runtimes/windows-jobs",
                out=lab / "bundle", notes_file=inputs / "notes.txt", release_id=f"t170s-{args.run}",
                version="T-170 lab fixture", git_sha=git_sha))
        bundle = json.loads(printed.getvalue())
        subprocess.run([str(lab / "bundle/bin/yuzuno-update-helper"), "register", "--install-dir", str(managed),
                        "--bundle", str(lab / "bundle"), "--manifest-sha256", bundle["manifestSha256"],
                        "--reviewed-source", "t170-lab", "--initialize"], check=True, capture_output=True)
        core = managed / "releases" / bundle["releaseId"] / "bin/yuzuno-workspace"

        # 1. Started once with the documented command.
        with (managed / "core.log").open("ab") as log:
            first = subprocess.Popen([str(core), "--install-dir", str(managed), "--port", str(args.port), "--data-dir", str(data),
                                      "--cwd", str(work), "--codex", str(FAKE_CODEX)], cwd=work, env=env,
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        workspace = until(lambda: (health(args.port) or {}).get("workspaceId"), 180, "the first lab Core")
        record = json.loads(record_path.read_text())
        assert not {"YUZUNO_REMOTE_PORT", "YUZUNO_REMOTE_ORIGIN", "YUZUNO_REMOTE_LOGIN"} & set(record["environment"]), record
        step("recorded", workspace=workspace, entry=os.readlink(entry), recordedNames=sorted(record["environment"]))

        # 2. Stopped by the start entry.
        code, outcome = stop()
        assert (code, outcome["state"], outcome["pid"]) == (0, "stopped", first.pid), outcome
        first.wait(timeout=30)
        assert free(args.port), "the port is still held"
        step("stopped", outcome=outcome, exit=first.returncode)

        # 3. Started with the remote entry.
        origin = f"https://{ORIGIN_HOST}"
        remote = ["--remote-port", str(args.remote_port), "--remote-origin", origin, "--remote-login", LOGIN]
        stays, outcome = start(*remote)
        assert outcome["state"] == "started" and outcome["remote"] == {"entry": "on", "port": args.remote_port, "origin": origin,
                                                                        "listening": True, "recorded": True}, outcome
        record = json.loads(record_path.read_text())
        environment = {name: record["environment"].get(name) for name in ("YUZUNO_REMOTE_PORT", "YUZUNO_REMOTE_ORIGIN", "YUZUNO_REMOTE_LOGIN")}
        assert environment == {"YUZUNO_REMOTE_PORT": str(args.remote_port), "YUZUNO_REMOTE_ORIGIN": origin, "YUZUNO_REMOTE_LOGIN": LOGIN}, environment
        admitted = request(args.remote_port, "/api/health", remote_headers)
        assert admitted[0] == 200 and json.loads(admitted[1])["workspaceId"] == workspace, admitted
        no_login = request(args.remote_port, "/api/health", {"Host": ORIGIN_HOST})
        other_login = request(args.remote_port, "/api/health", {"Host": ORIGIN_HOST, "Tailscale-User-Login": "someone@example.com"})
        proxied = request(args.port, "/api/health", {"Tailscale-User-Login": LOGIN})
        assert (no_login[0], other_login[0], proxied[0]) == (403, 403, 403), (no_login, other_login, proxied)
        log = (managed / "core.log").read_text(errors="replace")
        assert f"Remote entry: http://127.0.0.1:{args.remote_port} for Tailscale Serve, as {origin}" in log
        step("remote", outcome=outcome, recorded=environment, admitted=admitted[0], withoutLogin=no_login[0],
             otherLogin=other_login[0], proxiedToCorePort=proxied[0])

        # 4. While it runs, nothing changes it.
        before = record_path.read_bytes()
        refusals = []
        for options in (["--no-remote"], ["--remote-port", str(args.remote_port + 1), "--remote-origin", origin, "--remote-login", LOGIN]):
            done = subprocess.run([str(entry), "start", "--install-dir", str(managed), "--port", str(args.port),
                                   "--workspace-id", workspace, *options], capture_output=True, text=True, env=env, timeout=180)
            refused = json.loads(done.stdout.splitlines()[0])
            assert done.returncode == 3 and (refused["state"], refused["code"]) == ("refused", "running"), refused
            refusals.append(refused["code"])
        assert record_path.read_bytes() == before, "the record changed"
        assert health(args.port)["workspaceId"] == workspace and alive(outcome["pid"])
        assert request(args.remote_port, "/api/health", remote_headers)[0] == 200 and free(args.remote_port + 1)
        step("unchanged", refusals=refusals)

        # 5. Stop stops that Core only.
        other = subprocess.Popen(["python3", "-m", "http.server", str(args.other_port), "--bind", "127.0.0.1"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=work)
        until(lambda: not free(args.other_port), 20, "the other program")
        code, stopped = stop()
        assert (code, stopped["state"], stopped["pid"]) == (0, "stopped", outcome["pid"]), stopped
        assert free(args.port) and free(args.remote_port) and not alive(outcome["pid"])
        assert stays.poll() is None, "the start that stays was stopped"
        assert other.poll() is None and not free(args.other_port), "another program was stopped"
        step("stoppedOnlyIt", outcome=stopped, startStays=True, otherProgram=True)

        # 6. Started without the remote entry.
        _, outcome = start("--no-remote")
        assert outcome["state"] == "started" and outcome["remote"] == {"entry": "off", "recorded": True}, outcome
        record = json.loads(record_path.read_text())
        assert not {"YUZUNO_REMOTE_PORT", "YUZUNO_REMOTE_ORIGIN", "YUZUNO_REMOTE_LOGIN"} & set(record["environment"]), record
        assert free(args.remote_port), "the remote port still listens"
        step("remoteOff", outcome=outcome, recordedNames=sorted(record["environment"]))

        # 7. A remote port another program holds: nothing recorded.
        code, stopped = stop()
        assert (code, stopped["state"]) == (0, "stopped"), stopped
        before = record_path.read_bytes()
        holder = socket.socket()
        # As Core's own listener does, so that connections the earlier steps
        # left in TIME_WAIT on this port don't refuse it; a second listener
        # (Core's) is still refused.
        holder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        holder.bind(("127.0.0.1", args.remote_port))
        holder.listen()
        try:
            _, outcome = start(*remote)
        finally:
            holder.close()
        assert (outcome["state"], outcome["code"]) == ("failed", "exited"), outcome
        assert "remote entry" in outcome.get("log", ""), outcome
        assert record_path.read_bytes() == before, "the record changed"
        step("remoteTaken", outcome={key: outcome[key] for key in ("state", "code", "message")})
        report["passed"] = True
    finally:
        # Every lab Core this installation runs, then the starts and the other program.
        if workspace and health(args.port):
            stop()
        if first is not None and first.poll() is None:
            first.send_signal(2)
            first.wait(timeout=60)
        for process in started:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=30)
        if other is not None and other.poll() is None:
            other.terminate()
            other.wait(timeout=10)
        (lab / "report.json").write_text(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
