#!/usr/bin/env python3
"""T-108 remote Linux jobs over real OpenSSH, on an isolated Core.

The "remote machine" is a user-level sshd on 127.0.0.1 with its own host
key, authorized key and config in this lab's folder: no system service and
no change to accounts or ~/.ssh. Its sessions get HOME in the lab, so the
remote helper writes nothing into the real home. The lab Core reaches it
through a PATH `ssh` wrapper that adds `-F` for the lab's client config; the
machine is registered through the ordinary Machines API. A second sshd
stands for another machine: its own host key (known, so SSH accepts it),
HOME and machine-id file; the client config's alias is re-pointed at it.

This is the same physical host over loopback, not a separate remote Linux
machine: it shows the executor over real SSH (connections, disconnects,
reconnects, a re-pointed name), not acceptance on a real remote host.

Checks: a run and its output; a failure that prints DONE; a disconnect
mid-run (sshd stopped) that leaves the job unknown with its slot held and
told once, then the same attempt found after sshd returns; a repeated
submission and a Core restart that never start twice; cancel stopping the
attempt's process tree; the alias re-pointed at another machine mid-run
(unknown and held; cancel cannot release it until the alias is back); a
supervisor killed while its command runs, the command then exiting with a
child left (unknown and held until cancel stops the child); and what is
not available (GPU, pause).
"""
import getpass
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import labkit  # noqa: E402

ROOT = labkit.ROOT
remote_job = labkit.load_helper()
wait_for = labkit.wait_for
LAB = ROOT / "target" / "t47" / ("lab-r108-" + uuid.uuid4().hex[:8])
PORT = int(os.environ.get("T108_PORT", "4608"))
CORE = labkit.Core(LAB, PORT, LAB / "bin")
request, refused, job, status, mails = CORE.request, CORE.refused, CORE.job, CORE.status, CORE.mails
SSHD = {}
REPORT = {"checks": [], "fixture": "Isolated Core + user-level sshd on 127.0.0.1 (same physical host); short shell commands only"}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def make_sshd(name, environment):
    """A user-level sshd on 127.0.0.1 with its own host key; returns its port."""
    folder = LAB / name
    folder.mkdir(mode=0o700)
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(folder / "host_key")], check=True)
    port = free_port()
    (folder / "sshd_config").write_text(f"""Port {port}
ListenAddress 127.0.0.1
HostKey {folder / 'host_key'}
AuthorizedKeysFile {LAB / 'client' / 'authorized_keys'}
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
StrictModes no
PidFile {folder / 'sshd.pid'}
SetEnv {environment}
LogLevel INFO
""")
    host_public = (folder / "host_key.pub").read_text().split()
    with (LAB / "ssh" / "known_hosts").open("a") as known:
        known.write(f"[127.0.0.1]:{port} {host_public[0]} {host_public[1]}\n")
    return port


def point(port):
    """The alias the machine is registered with now leads to this port."""
    client = LAB / "ssh"
    (client / "config").write_text(f"""Host yuzuno-lab
  HostName 127.0.0.1
  Port {port}
Host *
  User {getpass.getuser()}
  IdentityFile {LAB / 'client' / 'client_key'}
  IdentitiesOnly yes
  UserKnownHostsFile {client / 'known_hosts'}
  GlobalKnownHostsFile /dev/null
""")


def setup_sshd():
    """Keys, both sshd configs, the client config and the ssh wrapper; returns
    the alias and each sshd's port."""
    client_keys = LAB / "client"
    client_keys.mkdir(mode=0o700)
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(client_keys / "client_key")], check=True)
    shutil.copy(client_keys / "client_key.pub", client_keys / "authorized_keys")
    os.chmod(client_keys / "authorized_keys", 0o600)
    (LAB / "ssh").mkdir(mode=0o700)
    remote_home, other_home = LAB / "remote-home", LAB / "other-home"
    remote_home.mkdir(mode=0o700)
    other_home.mkdir(mode=0o700)
    # The other machine's identity, for this lab only: a fixed machine-id file.
    (LAB / "other-machine-id").write_text("fedcba9876543210fedcba9876543210\n")
    ports = {"sshd": make_sshd("sshd", f"HOME={remote_home}"),
             "other": make_sshd("other", f"HOME={other_home} YUZUNO_JOBS_MACHINE_ID_FILE={LAB / 'other-machine-id'}")}
    point(ports["sshd"])
    bin_dir = LAB / "bin"
    bin_dir.mkdir()
    (bin_dir / "ssh").write_text(f"#!/bin/sh\nexec /usr/bin/ssh -F {LAB / 'ssh' / 'config'} \"$@\"\n")
    os.chmod(bin_dir / "ssh", 0o755)
    REPORT["sshd"] = {"listen": f"127.0.0.1:{ports['sshd']}", "remoteHome": str(remote_home),
                      "other": f"127.0.0.1:{ports['other']}", "otherHome": str(other_home)}
    return "yuzuno-lab", ports


def start_sshd(name, port):
    log = (LAB / f"{name}.log").open("ab")
    SSHD[name] = subprocess.Popen(["/usr/bin/sshd", "-D", "-e", "-f", str(LAB / name / "sshd_config")],
                                  stdout=log, stderr=log)
    log.close()
    reachable = lambda: subprocess.run([str(LAB / "bin" / "ssh"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=3",
                                        "-p", str(port), "127.0.0.1", "true"], capture_output=True,
                                       timeout=15).returncode == 0
    wait_for(reachable, bool, 20)


def stop_sshd(name):
    """The machine gone: sshd and the connections it holds. Core keeps one
    connection open to a machine (T-163), which stopping the listener alone
    would leave working."""
    process = SSHD.pop(name, None)
    if process:
        def parent(pid):
            try:
                stat = Path(f"/proc/{pid}/stat").read_text()
            except OSError:
                return None
            return int(stat[stat.rindex(")") + 2:].split()[1])
        connections = [int(entry.name) for entry in Path("/proc").iterdir()
                       if entry.name.isdigit() and parent(entry.name) == process.pid]
        process.terminate()
        process.wait(timeout=10)
        for pid in connections:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass


def start_core():
    CORE.start()


def stop_core():
    CORE.stop()


def MCP():
    return CORE.mcp()


def check(name):
    REPORT["checks"].append(name)
    print("PASS " + name, flush=True)


def main():
    LAB.mkdir(parents=True, mode=0o700)
    work = LAB / "remote-work"
    work.mkdir()
    print(str(LAB), flush=True)
    target, ports = setup_sshd()
    try:
        start_sshd("sshd", ports["sshd"])
        start_sshd("other", ports["other"])
        start_core()
        mcp = MCP()
        spec = {"name": "lab Linux", "target": target, "codex": "codex", "defaultCwd": str(work)}
        # An account without linger cannot hold strict limits (the default);
        # T108_LIMIT_MODE=limited runs the lab there.
        if os.environ.get("T108_LIMIT_MODE"):
            spec["limitMode"] = os.environ["T108_LIMIT_MODE"]
        machine = request("/machines", spec)
        probe = request(f"/machines/{machine['id']}/check", {})
        assert probe["reachable"] and probe["host"]["platform"] == "Linux", probe
        assert probe["host"]["home"] == REPORT["sshd"]["remoteHome"], probe["host"]
        REPORT["machine"] = {"id": machine["id"], "checkReachable": probe["reachable"], "platform": probe["host"]["platform"]}
        check("The machine is registered through the Machines API and its check reaches it over real SSH (Linux, lab HOME)")

        def submit(name, command, request_id=None, **extra):
            body = {"requestId": request_id or str(uuid.uuid4()), "taskId": "T-1", "name": name, "cwd": str(work),
                    "argv": ["/bin/sh", "-c", command], "env": {"PATH": "/usr/bin:/bin"}, "guardGit": False,
                    "resources": {"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0}, "timeoutSeconds": 120,
                    "machineId": machine["id"], **extra}
            return mcp.call("job_submit", body)

        # 1. A run there, its output read back over SSH.
        ok = submit("ok", "echo begin; echo once >> ok.txt; sleep 2; echo end")
        assert ok["executor"] == {"kind": "ssh", "machineId": machine["id"], "machineName": "lab Linux"}, ok["executor"]
        running = status(ok["id"], "running")
        assert running["reason"].startswith("Running on lab Linux in its own process group"), running["reason"]
        # Its slot is the machine's: nothing of this host's budget is reserved.
        budget = request("/jobs/budget")
        assert budget["reserved"]["cpuMillis"] == 0 and budget["reserved"]["memoryMiB"] == 0, budget["reserved"]
        done = status(ok["id"], "succeeded", "failed")
        assert done["status"] == "succeeded", done
        log = request(f"/jobs/{ok['id']}/logs")
        assert log["text"] == "begin\nend\n", log
        assert (work / "ok.txt").read_text() == "once\n"
        REPORT["run"] = {"reason": running["reason"], "exitCode": done["result"]["evidence"]["result"]["exitCode"]}
        check("A job submitted with machineId runs there under its supervisor; its outcome and output come back over SSH")

        # 2. A failure that prints DONE is still a failure.
        bad = submit("bad", "echo DONE; exit 4")
        failed = status(bad["id"], "succeeded", "failed")
        assert (failed["status"], failed["reason"]) == ("failed", "exit-code 4"), failed
        check("A command that prints DONE and exits 4 is failed, exit-code 4")

        # 3. Disconnect mid-run, then the same attempt again.
        steady = submit("steady", "sleep 12; echo finished")
        status(steady["id"], "running")
        stop_sshd("sshd")
        unknown = status(steady["id"], "unknown", seconds=60)
        assert unknown["reserved"] is True and unknown["reason"].startswith("lab Linux did not answer"), unknown
        time.sleep(15)  # more checks while it is down: told once
        assert len([m for m in mails(steady["id"]) if m["metadata"].get("status") == "unknown"]) == 1
        start_sshd("sshd", ports["sshd"])
        back = status(steady["id"], "running", "succeeded", seconds=60)
        assert back["attempt"] == steady["attempt"]
        finished = status(steady["id"], "succeeded", "failed", seconds=60)
        assert finished["status"] == "succeeded", finished
        REPORT["disconnect"] = {"unknownReason": unknown["reason"], "after": back["status"]}
        check("sshd stopped mid-run: the job is unknown with its slot held, told once; after sshd returns the same attempt is found and finishes")

        # 4. A repeated submission and a Core restart never start it twice.
        key = str(uuid.uuid4())
        once = submit("once", "echo run >> once.txt; sleep 6", request_id=key)
        again = submit("once", "echo run >> once.txt; sleep 6", request_id=key)
        assert once["id"] == again["id"]
        status(once["id"], "running")
        stop_core()
        time.sleep(2)
        start_core()
        mcp = MCP()
        done = status(once["id"], "succeeded", "failed", seconds=90)
        assert done["status"] == "succeeded" and (work / "once.txt").read_text() == "run\n", done
        assert len([m for m in mails(once["id"]) if m["metadata"].get("status") == "succeeded"]) == 1
        check("The same requestId is the same job, and a Core restart mid-run finds the same attempt: it ran once, told once")

        # 5. Cancel stops the attempt's process tree there.
        tree = submit("tree", "sleep 60 & echo $! > child.pid; sleep 60")
        status(tree["id"], "running")
        wait_for(lambda: (work / "child.pid").exists(), bool, 20)
        child = int((work / "child.pid").read_text())
        request(f"/jobs/{tree['id']}/cancel", {})
        cancelled = status(tree["id"], "cancelled", "failed", "unknown", seconds=60)
        assert cancelled["status"] == "cancelled", cancelled
        alive = subprocess.run(["kill", "-0", str(child)], capture_output=True).returncode == 0
        assert not alive, "the backgrounded child is gone"
        check("Cancel stops the attempt's own process tree on the machine, its backgrounded child included")

        remote_jobs = Path(REPORT["sshd"]["remoteHome"]) / ".yuzuno" / "jobs"

        def record(of, name):
            return json.loads((remote_jobs / of["id"] / of["attempt"] / name).read_text())

        def alive_pid(pid):
            try:
                stat = Path(f"/proc/{pid}/stat").read_text()
            except OSError:
                return False
            return stat[stat.rindex(")") + 2] not in "ZX"

        # 7. The alias re-pointed at another machine mid-run.
        pinned = submit("pinned", "sleep 40")
        status(pinned["id"], "running")
        leader = record(pinned, "started.json")["pid"]
        point(ports["other"])
        moved = status(pinned["id"], "unknown", seconds=60)
        assert moved["reserved"] is True and moved["reason"].startswith("lab Linux now reaches a different machine"), moved
        request(f"/jobs/{pinned['id']}/cancel", {})
        time.sleep(12)
        held = job(pinned["id"])
        assert (held["status"], held["reserved"]) == ("unknown", True), held
        assert alive_pid(leader), "nothing was stopped through the other machine"
        assert not (Path(REPORT["sshd"]["otherHome"]) / ".yuzuno" / "jobs" / pinned["id"]).exists()
        point(ports["sshd"])
        released = status(pinned["id"], "cancelled", seconds=60)
        assert not alive_pid(leader), "the cancel went through once the alias was back"
        REPORT["repointed"] = {"reason": moved["reason"], "afterCancelWhileMoved": held["status"],
                               "afterAliasBack": released["status"]}
        check("The alias re-pointed at another machine mid-run: unknown with the slot held, cancel could not release "
              "it, nothing was written there; with the alias back the cancel stopped the attempt")

        # 8. The supervisor killed, then the command exits leaving a child.
        orphan = submit("orphan", "sleep 60 & echo $! > orphan.pid; while [ ! -e orphan.go ]; do sleep 0.1; done")
        status(orphan["id"], "running")
        wait_for(lambda: (work / "orphan.pid").exists(), bool, 20)
        child = int((work / "orphan.pid").read_text())
        supervisor = record(orphan, "supervisor.json")["pid"]
        os.kill(supervisor, signal.SIGKILL)
        lost = wait_for(lambda: job(orphan["id"]), lambda j: "its command is still running" in (j["reason"] or ""), 60)
        assert (lost["status"], lost["reserved"]) == ("unknown", True), lost
        (work / "orphan.go").write_text("")
        left = wait_for(lambda: job(orphan["id"]), lambda j: "1 process(es) of its group are still running" in (j["reason"] or ""), 60)
        assert (left["status"], left["reserved"]) == ("unknown", True) and alive_pid(child), left
        request(f"/jobs/{orphan['id']}/cancel", {})
        stopped = status(orphan["id"], "cancelled", seconds=60)
        assert "its supervisor was gone" in stopped["reason"], stopped
        assert not alive_pid(child), "the child left by the command was stopped"
        REPORT["supervisorDeath"] = {"lost": lost["reason"], "left": left["reason"], "cancelled": stopped["reason"]}
        check("A killed supervisor leaves the job unknown with its slot held; the command exiting with a child left "
              "is still no outcome; cancel stops the child and only then releases the slot")

        # 6. What this executor does not do.
        no_gpu = mcp.call("job_submit", {"requestId": str(uuid.uuid4()), "taskId": "T-1", "name": "gpu",
            "cwd": str(work), "argv": ["/bin/true"], "guardGit": False, "machineId": machine["id"],
            "resources": {"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0}, "gpu": {"memoryMiB": 1000}}, error=True)
        assert "GPU admission is not available" in no_gpu, no_gpu
        paused = submit("paused", "sleep 20")
        status(paused["id"], "running")
        pause_error = refused(f"/jobs/{paused['id']}/pause", {})
        assert "Pause is not available for" in pause_error and "on lab Linux" in pause_error, pause_error
        request(f"/jobs/{paused['id']}/cancel", {})
        status(paused["id"], "cancelled", seconds=60)
        REPORT["unavailable"] = {"gpu": no_gpu, "pause": pause_error}
        check("GPU admission and pause are refused for a remote job, with the reason")
        assert not (Path.home() / ".yuzuno" / "jobs" / ok["id"]).exists(), "nothing in the real home"
        REPORT["passed"] = True
    finally:
        stop_core()
        for name in list(SSHD):
            stop_sshd(name)
        # Nothing of this lab keeps running: what is left of every attempt's
        # process group, checked as the helper checks it.
        for started in LAB.glob("*-home/.yuzuno/jobs/*/*/started.json"):
            try:
                group = json.loads(started.read_text())
            except ValueError:
                continue
            for pid in remote_job.members(group):
                remote_job.send(pid, signal.SIGKILL, group)
        (LAB / "report.json").write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))
        print(str(LAB / "report.json"), flush=True)


if __name__ == "__main__":
    main()
    sys.exit(0 if REPORT.get("passed") else 1)
