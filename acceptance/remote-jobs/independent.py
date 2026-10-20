#!/usr/bin/env python3
"""T-108 acceptance of remote Linux Jobs on an independent machine.

    python3 acceptance/remote-jobs/independent.py --target ALIAS
        [--remote-root ~/.yuzuno] [--port 4609] [--ssh-config FILE]
        [--allow-same-host] [--clean]

ALIAS is an SSH destination this account can already reach with its own
configuration and keys. Every connection uses batch mode and strict host
keys: an unknown or changed host key stops the run; it is never accepted
here. The run:

1. Asks the machine, read-only, what it is: Linux, distribution, kernel,
   python3, whether it has a machine-id and whether the account is root. It
   compares the Jobs helper's machine identity with this host's: the same
   machine (loopback, a namespace of this host) is not independent, and the
   run stops there unless --allow-same-host (the tool's self-test; the
   report then says independent: false).
2. Starts an isolated acceptance Core (its own folder and port, never the
   daily Core) and registers the machine there with its data root
   (--remote-root, as the machine's dataRoot) in the limited mode. Nothing
   of the daily Workspace or its machines changes.
3. Runs short commands (echo, sleep up to 60 s, and acceptance/remote-jobs/
   load.py's small CPU and memory loads) in a private folder under that
   data root, <root>/acceptance/<run>, and checks each item below. Every
   file the run and its jobs create on the machine is under the data root,
   whose parent must already exist. The control connection is broken only
   inside this run: the acceptance Core's `ssh` is a wrapper that can fail
   its calls (exit 255) or drop the reply to a start. The machine, its sshd,
   its account and the network are never touched.
   The resource items follow what the machine's helper reports it can
   enforce: limits really held where it can, recorded as declared where it
   cannot, and strict refusing what it cannot hold.
4. Keeps what it created there as evidence (the run's folder and its jobs'
   attempt folders under <root>/jobs), or with --clean removes exactly those,
   and writes report.json with what each item actually covered.

A reboot of the machine is never done here: it is reported as not covered
(the fixtures in core/src/jobs/remote_tests.rs simulate one).
"""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import labkit  # noqa: E402

ROOT = labkit.ROOT
ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
PREFLIGHT = r"""
printf 'os=%s\n' "$(uname -s)"
printf 'kernel=%s\n' "$(uname -r)"
printf 'arch=%s\n' "$(uname -m)"
printf 'home=%s\n' "$HOME"
printf 'uid=%s\n' "$(id -u)"
if [ -r /etc/os-release ]; then . /etc/os-release; printf 'distro=%s %s\n' "$ID" "$VERSION_ID"; fi
if command -v python3 >/dev/null 2>&1; then printf 'python=%s\n' "$(python3 -c 'import sys; print(sys.version.split()[0])')"; fi
if [ -s /etc/machine-id ] || [ -s /var/lib/dbus/machine-id ]; then echo machine_id=present; else echo machine_id=missing; fi
"""


class Stop(Exception):
    """The run cannot go on; the reason is the report's."""


def parse(text):
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--target", required=True, help="SSH destination (an alias of this account's SSH config)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("T108_PORT", "4609")))
    parser.add_argument("--ssh-config", help="an SSH config file to use instead of the account's (self-test)")
    parser.add_argument("--allow-same-host", action="store_true",
                        help="go on when the target is this machine (self-test only; never independent acceptance)")
    parser.add_argument("--remote-root", default="~/.yuzuno",
                        help="the machine's data root (~/<folder> or an absolute folder; its parent must exist): "
                             "everything this run and its jobs create there is under it")
    parser.add_argument("--clean", action="store_true",
                        help="remove what this run created there afterwards (kept as evidence by default)")
    args = parser.parse_args()

    run = uuid.uuid4().hex[:8]
    lab = ROOT / "target" / "t47" / f"lab-independent-{run}"
    lab.mkdir(parents=True, mode=0o700)
    print(str(lab), flush=True)
    report = {"run": run, "target": args.target, "items": [], "independent": None, "passed": False}
    config = ["-F", args.ssh_config] if args.ssh_config else []
    ssh = ["/usr/bin/ssh", *config, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
           "-o", "ConnectTimeout=10", "-o", "ClearAllForwardings=yes", args.target]

    def remote(command, stdin=None, timeout=60):
        out = subprocess.run(ssh + [command], input=stdin, capture_output=True, text=True, timeout=timeout)
        if out.returncode == 255:
            if "Host key verification failed" in out.stderr or "IDENTIFICATION HAS CHANGED" in out.stderr:
                raise Stop("the machine's host key is unknown or changed; it is never accepted automatically")
            raise Stop("the machine did not answer over SSH: " + out.stderr.strip()[-300:])
        return out

    helper = labkit.HELPER.read_text()
    mark = labkit.load_helper().MARK

    def hello(local):
        # As Core asks: only the line with this call's nonce is the reply.
        nonce = uuid.uuid4().hex
        prefix = f"{mark}{nonce} "
        request = json.dumps({"action": "hello", "replyNonce": nonce, "root": args.remote_root})
        if local:
            out = subprocess.run([sys.executable, "-c", helper], input=request, capture_output=True, text=True, timeout=60)
        else:
            out = remote("python3 -c " + shlex.quote(helper), stdin=request)
        lines = [line[len(prefix):] for line in out.stdout.splitlines() if line.startswith(prefix)]
        if out.returncode != 0 or len(lines) != 1:
            raise Stop(f"the Jobs helper did not answer hello there (exit {out.returncode}): {out.stderr.strip()[-300:]}")
        return json.loads(lines[0])

    core = None
    created = []
    remote_dir = None

    def item(name, coverage, check):
        started = time.monotonic()
        if not report["independent"]:
            # A self-test: never reported as the independent machine it is not.
            coverage = coverage.replace("real host", "this machine over loopback (self-test, not independent)")
        entry = {"name": name, "coverage": coverage}
        report["items"].append(entry)
        try:
            entry["evidence"] = check() or {}
            entry["result"] = "PASS"
            print(f"PASS {name} [{coverage}]", flush=True)
        except Exception as error:
            entry["result"] = "FAIL"
            entry["error"] = f"{type(error).__name__}: {error}"[:2000]
            print(f"FAIL {name}: {entry['error']}", flush=True)
            raise
        finally:
            entry["seconds"] = round(time.monotonic() - started, 1)

    try:
        # 1. What the machine is, read-only.
        facts = parse(remote(PREFLIGHT).stdout)
        if facts.get("os") != "Linux":
            raise Stop(f"the target runs {facts.get('os')!r}, not Linux")
        there, here = hello(False), hello(True)
        same = there["hostId"] == here["hostId"]
        report["independent"] = not same
        # The data root as the helper expands it there, and what this account
        # can enforce (its systemd user manager, delegated controllers, linger).
        root = there.get("root")
        if not isinstance(root, str) or not root.startswith("/"):
            raise Stop("the Jobs helper there did not report the data root it would use")
        can = there.get("resources") or {}
        usable = can.get("manager") is True and can.get("busctl") is True
        # Held only in a scope that lasts: on an account that does not
        # linger, limited holds nothing (the helper's limit_plan).
        lingers = can.get("linger") is True
        unlingering = usable and not lingers and "memory" in (can.get("delegated") or [])
        controls = {kind: usable and kind in (can.get("delegated") or []) for kind in ("memory", "cpu")}
        holds = {kind: controls[kind] and lingers for kind in ("memory", "cpu")}
        report["environment"] = {
            "os": facts.get("os"), "distro": (facts.get("distro") or "").strip() or None, "kernel": facts.get("kernel"),
            "arch": facts.get("arch"), "python": facts.get("python"), "machineId": facts.get("machine_id"),
            "accountIsRoot": facts.get("uid") == "0", "hostIdPrefix": there["hostId"][:8],
            "sameMachineAsCore": same, "dataRoot": root, "enforcement": can,
        }
        if same and not args.allow_same_host:
            raise Stop("the target is this machine (same machine identity), not an independent remote")
        parent = root.rsplit("/", 1)[0] or "/"
        if remote(f"test -d {shlex.quote(parent)} && test ! -L {shlex.quote(root)} && echo ok").stdout.strip() != "ok":
            raise Stop(f"{parent} does not exist there, or the data root is a link; nothing was created")
        remote_dir = f"{root}/acceptance/{run}"
        work = f"{remote_dir}/work"
        # Private folders, all under the data root (its parent exists).
        remote(f"umask 077 && mkdir -p {shlex.quote(work)}")
        remote(f"cat > {shlex.quote(work + '/load.py')}", stdin=(Path(__file__).resolve().parent / "load.py").read_text())

        # 2. An isolated acceptance Core whose ssh can break this run's connection only.
        fault = lab / "fault"
        fault.mkdir()
        bin_dir = lab / "bin"
        bin_dir.mkdir()
        real = " ".join(shlex.quote(part) for part in ["/usr/bin/ssh", *config])
        (bin_dir / "ssh").write_text(f"""#!/bin/sh
# The acceptance Core's own SSH: a fault here touches only this run's calls.
fault={shlex.quote(str(fault))}
if [ -e "$fault/down" ]; then echo "ssh: acceptance fault: this run's control connection is down" >&2; exit 255; fi
if [ -e "$fault/lose-start" ]; then
  request=$(cat)
  case "$request" in *'"action":"start"'*)
    rm -f "$fault/lose-start"
    printf '%s' "$request" | {real} "$@" >/dev/null 2>&1
    echo "ssh: acceptance fault: the reply to this start was dropped" >&2
    exit 255;;
  esac
  # Not exec: inside a pipeline it would replace only the pipeline's subshell.
  printf '%s' "$request" | {real} "$@"
  exit $?
fi
exec {real} "$@"
""")
        os.chmod(bin_dir / "ssh", 0o755)
        core = labkit.Core(lab, args.port, bin_dir)
        core.start()
        mcp = core.mcp()
        name = f"acceptance {args.target}"
        machine = core.request("/machines", {"name": name, "target": args.target, "codex": "codex", "defaultCwd": work,
                                             "dataRoot": args.remote_root, "limitMode": "limited"})

        def set_mode(mode):
            listed = core.request("/machines")
            entry = next(m for m in (listed["machines"] if isinstance(listed, dict) else listed) if m["id"] == machine["id"])
            core.request(f"/machines/{machine['id']}", dict(entry, limitMode=mode), method="PUT")

        def submit(label, command, request_id=None, **extra):
            body = {"requestId": request_id or str(uuid.uuid4()), "taskId": "T-1", "name": label, "cwd": work,
                    "argv": ["/bin/sh", "-c", command], "env": {"PATH": "/usr/bin:/bin"}, "guardGit": False,
                    "resources": {"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0}, "timeoutSeconds": 120,
                    "machineId": machine["id"], **extra}
            job = mcp.call("job_submit", body)
            if job["id"] not in created:
                created.append(job["id"])
            return job

        def read(path):
            return remote(f"cat {shlex.quote(path)} 2>/dev/null").stdout

        def alive(pid):
            return remote(f"test -d /proc/{int(pid)} && echo alive").stdout.strip() == "alive"

        def gone(pid, seconds=20):
            return labkit.wait_for(lambda: not alive(pid), bool, seconds)

        def attempt_dir(job):
            return f"{root}/jobs/{job['id']}/{job['attempt']}"

        def identity():
            probe = core.request(f"/machines/{machine['id']}/check", {})
            assert probe["reachable"] and probe["host"]["platform"] == "Linux", probe
            return {"checkReachable": True, "platform": "Linux"}
        item("The machine registers in an isolated Core and its check reaches it over SSH", "real host", identity)

        def runs():
            ok = submit("ok", "echo begin; echo once >> ok.txt; sleep 2; echo end")
            running = core.status(ok["id"], "running")
            assert running["reason"].startswith(f"Running on {name} in its own process group"), running["reason"]
            budget = core.request("/jobs/budget")
            assert budget["reserved"]["cpuMillis"] == 0 and budget["reserved"]["memoryMiB"] == 0, budget["reserved"]
            done = core.status(ok["id"], "succeeded", "failed")
            assert done["status"] == "succeeded", done
            log = core.request(f"/jobs/{ok['id']}/logs")
            assert log["text"] == "begin\nend\n", log
            assert read(f"{work}/ok.txt") == "once\n"
            return {"reason": running["reason"], "exitCode": done["result"]["evidence"]["result"]["exitCode"],
                    "hostBudgetReserved": budget["reserved"]}
        item("A job runs there; outcome and output come back; this host's budget is untouched", "real host", runs)

        def fails():
            bad = submit("bad", "echo DONE; exit 4")
            failed = core.status(bad["id"], "succeeded", "failed")
            assert (failed["status"], failed["reason"]) == ("failed", "exit-code 4"), failed
            return {"reason": failed["reason"]}
        item("A command that prints DONE and exits 4 is failed", "real host", fails)

        def limits_of(job):
            return ((job.get("result") or {}).get("evidence") or {}).get("result", {}).get("limits") or {}

        def last_line(job_id):
            lines = [l for l in core.request(f"/jobs/{job_id}/logs")["text"].splitlines() if l.startswith("{")]
            return json.loads(lines[-1]) if lines else {}

        def strict():
            set_mode("strict")
            try:
                job = submit("strict", "echo ran > strict.txt")
                done = core.status(job["id"], "rejected", "succeeded", "failed", seconds=60)
            finally:
                set_mode("limited")
            if holds["memory"] and holds["cpu"]:
                assert done["status"] == "succeeded", done
            else:
                assert done["status"] == "rejected", done
                assert "This machine cannot hold strict limits, so nothing was started" in done["reason"], done["reason"]
                for kind, phrase in (("cpu", "CPU cannot be limited here"), ("memory", "memory cannot be limited here")):
                    assert (phrase in done["reason"]) == (not controls[kind]), done["reason"]
                assert ("linger is off" in done["reason"]) == (not lingers and (controls["memory"] or controls["cpu"])), done["reason"]
                assert read(f"{work}/strict.txt") == "", "nothing ran"
            return {"status": done["status"], "reason": done["reason"]}
        item("Strict (the default mode) starts nothing where the machine cannot hold the declared limits",
             "real host; the helper's own facts decide", strict)

        def memory_over():
            over = submit("memory over", f"exec python3 {work}/load.py memory --step-mib 16 --max-mib 256",
                          resources={"cpuMillis": 500, "memoryMiB": 64, "swapMiB": 0})
            done = core.status(over["id"], "succeeded", "failed", seconds=90)
            limits, reached = limits_of(done), last_line(over["id"])
            if holds["memory"]:
                assert (done["status"], done["result"]["evidence"]["result"]["signal"]) == ("failed", 9), done
                assert "out of memory: its limit is 64 MiB" in done["reason"], done["reason"]
                assert limits["memory"] == "limited" and limits["held"]["memory.max"] == str(64 << 20), limits
                if can.get("swap", True) is True:
                    assert limits["held"]["memory.swap.max"] == "0", limits
                assert limits.get("oomKills", 0) >= 1, limits
                assert reached.get("mib", 0) < 64, reached
            else:
                assert limits["memory"] == "declared" and done["status"] == "succeeded", done
                assert limits.get("held") is None, limits
                if unlingering:
                    assert any("this account does not linger" in c for c in limits["caveats"]), limits["caveats"]
            return {"status": done["status"], "reason": done["reason"], "lastStep": reached, "held": limits.get("held"),
                    "oomKills": limits.get("oomKills"), "caveats": limits.get("caveats")}
        item("Memory over its 64 MiB limit: held in its own scope there and reported as out of memory",
             "real host; the job's own allocation" if holds["memory"] else
             "real host; this account does not linger, so limited holds nothing (declared only)" if unlingering else
             "real host; this account cannot hold memory, so declared only",
             memory_over)

        def no_scope():
            # Where limited holds nothing, the command runs in no scope of the
            # account's user manager: its own cgroup says so.
            seen = submit("cgroup", "cat /proc/self/cgroup", resources={"cpuMillis": 500, "memoryMiB": 64, "swapMiB": 0})
            done = core.status(seen["id"], "succeeded", "failed", seconds=60)
            limits, text = limits_of(done), core.request(f"/jobs/{seen['id']}/logs")["text"]
            assert done["status"] == "succeeded" and text.strip(), (done, text)
            in_scope = "yuzuno-remote-job-" in text
            assert in_scope == bool(holds["memory"] or holds["cpu"]), (text, limits)
            return {"cgroup": text.strip()[-300:], "held": limits.get("held"), "reason": done["reason"]}
        item("The command's own cgroup: in its attempt's scope only where limits are held",
             "real host; read from /proc/self/cgroup by the job", no_scope)

        def memory_within():
            ok = submit("memory within", f"exec python3 {work}/load.py memory --step-mib 16 --max-mib 48 --hold-seconds 1",
                        resources={"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0})
            done = core.status(ok["id"], "succeeded", "failed", seconds=90)
            limits = limits_of(done)
            assert done["status"] == "succeeded", done
            if holds["memory"]:
                assert limits["held"]["memory.max"] == str(128 << 20) and limits.get("peakBytes", 0) > 48 << 20, limits
            return {"peakBytes": limits.get("peakBytes"), "held": limits.get("held")}
        item("Within its limit the job succeeds and its peak memory is recorded", "real host", memory_within)

        def cpu():
            burn = submit("cpu", f"exec python3 {work}/load.py cpu --workers 2 --seconds 3",
                          resources={"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0})
            done = core.status(burn["id"], "succeeded", "failed", seconds=90)
            limits, measured = limits_of(done), last_line(burn["id"])
            assert done["status"] == "succeeded" and "cores" in measured, (done, measured)
            if holds["cpu"]:
                assert limits["cpu"] == "limited" and limits["held"]["cpu.max"] == "50000 100000", limits
                assert measured["cores"] < 0.75, measured
            else:
                # Not limited there: recorded as declared, and the job used what it took.
                assert limits["cpu"] == "declared", limits
                assert any("CPU is declared only" in c or "this account does not linger" in c
                           for c in limits["caveats"]), limits["caveats"]
            return {"cpu": limits.get("cpu"), "measuredCores": measured.get("cores"), "declaredMillis": 500}
        item("CPU of 500 millicores, two busy workers for 3 s: limited where it can be, otherwise declared and measured as used",
             "real host; small load", cpu)

        def lost_start():
            (fault / "lose-start").write_text("")
            lost = submit("lost", "echo run >> lost.txt; sleep 3")
            unknown = core.status(lost["id"], "unknown", seconds=60)
            assert unknown["reason"].startswith(f"No acknowledgement from {name}"), unknown
            assert not (fault / "lose-start").exists(), "the start went through the wrapper"
            done = core.status(lost["id"], "succeeded", "failed", seconds=90)
            assert done["status"] == "succeeded" and done["attempt"] == lost["attempt"], done
            assert read(f"{work}/lost.txt") == "run\n", "it ran once"
            return {"unknownReason": unknown["reason"]}
        item("A start whose reply is lost: unknown, then the same attempt is found; it ran once",
             "real host; the reply was dropped by this run's ssh wrapper", lost_start)

        def connection_loss():
            steady = submit("steady", "sleep 20; echo finished")
            core.status(steady["id"], "running")
            (fault / "down").write_text("")
            try:
                unknown = core.status(steady["id"], "unknown", seconds=60)
                assert unknown["reserved"] is True and unknown["reason"].startswith(f"{name} did not answer"), unknown
                time.sleep(15)
                told = [m for m in core.mails(steady["id"]) if m["metadata"].get("status") == "unknown"]
                assert len(told) == 1, told
            finally:
                (fault / "down").unlink()
            back = core.status(steady["id"], "running", "succeeded", seconds=60)
            assert back["attempt"] == steady["attempt"]
            done = core.status(steady["id"], "succeeded", "failed", seconds=60)
            assert done["status"] == "succeeded", done
            return {"unknownReason": unknown["reason"], "after": back["status"]}
        item("The control connection drops mid-run: unknown with the slot held, told once; then the same attempt finishes",
             "real host kept running; only this Core's ssh calls failed (exit 255), not the machine, its sshd or the network",
             connection_loss)

        def dedup_restart():
            nonlocal mcp
            key = str(uuid.uuid4())
            once = submit("once", "echo run >> once.txt; sleep 6", request_id=key)
            again = submit("once", "echo run >> once.txt; sleep 6", request_id=key)
            assert once["id"] == again["id"]
            core.status(once["id"], "running")
            core.stop()
            time.sleep(2)
            core.start()
            mcp = core.mcp()
            done = core.status(once["id"], "succeeded", "failed", seconds=90)
            assert done["status"] == "succeeded" and read(f"{work}/once.txt") == "run\n", done
            assert len([m for m in core.mails(once["id"]) if m["metadata"].get("status") == "succeeded"]) == 1
            return {}
        item("The same requestId is the same job; a Core restart mid-run finds the same attempt; it ran once, told once",
             "real host; acceptance Core restarted", dedup_restart)

        def cancel_tree():
            tree = submit("tree", "sleep 60 & echo $! > child.pid; sleep 60")
            core.status(tree["id"], "running")
            child = int(labkit.wait_for(lambda: read(f"{work}/child.pid").strip(), bool, 20))
            core.request(f"/jobs/{tree['id']}/cancel", {})
            cancelled = core.status(tree["id"], "cancelled", "failed", "unknown", seconds=60)
            assert cancelled["status"] == "cancelled", cancelled
            assert gone(child), "the backgrounded child is gone"
            return {}
        item("Cancel stops the attempt's own process tree there", "real host", cancel_tree)

        def supervisor_death():
            orphan = submit("orphan", "sleep 60 & echo $! > orphan.pid; while [ ! -e orphan.go ]; do sleep 0.2; done")
            core.status(orphan["id"], "running")
            child = int(labkit.wait_for(lambda: read(f"{work}/orphan.pid").strip(), bool, 20))
            folder = attempt_dir(orphan)
            supervisor = int(json.loads(read(f"{folder}/supervisor.json"))["pid"])
            # Only this attempt's own supervisor: its command line names the attempt.
            cmdline = remote(f"tr '\\0' ' ' < /proc/{supervisor}/cmdline").stdout
            assert "supervisor.py" in cmdline and orphan["attempt"] in cmdline, cmdline
            remote(f"kill -KILL {supervisor}")
            lost = labkit.wait_for(lambda: core.job(orphan["id"]),
                                   lambda j: "its command is still running" in (j["reason"] or ""), 60)
            assert (lost["status"], lost["reserved"]) == ("unknown", True), lost
            remote(f"touch {shlex.quote(work + '/orphan.go')}")
            left = labkit.wait_for(lambda: core.job(orphan["id"]),
                                   lambda j: "1 process(es) of its group are still running" in (j["reason"] or ""), 60)
            assert (left["status"], left["reserved"]) == ("unknown", True) and alive(child), left
            core.request(f"/jobs/{orphan['id']}/cancel", {})
            stopped = core.status(orphan["id"], "cancelled", seconds=60)
            assert "its supervisor was gone" in stopped["reason"], stopped
            assert gone(child)
            return {"lost": lost["reason"], "left": left["reason"]}
        item("A killed supervisor leaves the job unknown with its slot held; a child left behind is no outcome; cancel stops it",
             "real host; this run killed its own attempt's supervisor", supervisor_death)

        def unavailable():
            no_gpu = mcp.call("job_submit", {"requestId": str(uuid.uuid4()), "taskId": "T-1", "name": "gpu", "cwd": work,
                                             "argv": ["/bin/true"], "guardGit": False, "machineId": machine["id"],
                                             "resources": {"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0},
                                             "gpu": {"memoryMiB": 1000}}, error=True)
            assert "GPU admission is not available" in no_gpu, no_gpu
            paused = submit("paused", "sleep 20")
            core.status(paused["id"], "running")
            pause_error = core.refused(f"/jobs/{paused['id']}/pause", {})
            assert f"Pause is not available for jobs on {name}" in pause_error, pause_error
            core.request(f"/jobs/{paused['id']}/cancel", {})
            core.status(paused["id"], "cancelled", seconds=60)
            return {}
        item("GPU admission and pause are refused for a remote job, with the reason", "acceptance Core; real host for the paused job",
             unavailable)

        report["notCovered"] = [
            {"name": "A real reboot of the machine", "why": "never done in acceptance; simulated by the fixtures (boot id)"},
            {"name": "The SSH name re-pointed at another machine", "why": "needs a second machine; covered by check.py over loopback"},
            {"name": "The account's last session ending while a job runs (linger off)",
             "why": "never done on the real host: no session is logged out and the user manager is never stopped. "
                    "Without linger no scope is made; whether a process outlives the last session still depends on "
                    "the host's logind settings (KillUserProcesses, UserStopDelaySec), which this run does not read or change"},
        ]
        report["passed"] = True
    except Stop as stop:
        report["stopped"] = str(stop)
        print(f"STOP {stop}", flush=True)
    except Exception as error:
        report.setdefault("error", f"{type(error).__name__}: {error}"[:2000])
    finally:
        if core is not None:
            for job_id in created:
                try:
                    if core.job(job_id)["reserved"]:
                        core.request(f"/jobs/{job_id}/cancel", {})
                        labkit.wait_for(lambda: not core.job(job_id)["reserved"], bool, 60)
                except Exception as error:
                    report.setdefault("cleanupProblems", []).append(f"{job_id}: {error}"[:300])
            core.stop()
        # Only what this run created there, all under the data root: kept as
        # evidence unless --clean.
        paths = []
        if remote_dir and remote_dir.endswith(f"/acceptance/{run}"):
            paths = [f"{remote_dir.rsplit('/acceptance/', 1)[0]}/jobs/{job_id}" for job_id in created if ID.fullmatch(job_id)]
            paths.append(remote_dir)
        report["remoteFolders"] = paths
        if paths and args.clean:
            try:
                remote("rm -rf -- " + " ".join(shlex.quote(p) for p in paths))
                report["removed"] = True
            except Exception as error:
                report.setdefault("cleanupProblems", []).append(f"remote cleanup: {error}"[:300])
        (lab / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(str(lab / "report.json"), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
