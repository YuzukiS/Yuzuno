#!/usr/bin/env python3
"""T-108 acceptance of pause and resume for remote Linux Jobs.

    python3 acceptance/remote-jobs/pause.py --target ALIAS --remote-root ~/jobs-lab/.yuzuno
        [--port 4616] [--ssh-config FILE] [--allow-same-host] [--expect scope|none]

As io.py: an isolated acceptance Core (its own folder and port, never the
daily Core) registers ALIAS (batch mode, strict host keys) in the limited
mode with its data root, and works in <root>/acceptance/<run>/work there,
with small files and short commands; everything is kept as evidence. The
acceptance Core's `ssh` is a wrapper that can drop the reply to one pause or
resume; the machine, its sshd and its account are never changed.

What a pause can do depends on the machine, and the run checks what it finds
(--expect makes a different finding a failure):
- the attempt runs in a scope of its own there (its limits are held): pause
  freezes it (read back from the scope's cgroup.events, and its output
  stops); a resume whose reply is lost is unknown, then settled by the
  machine's status; cancel and a timeout while paused thaw it, and its
  processes act on TERM;
- no scope of its own (a non-lingering account): the pause is
  refused with the reason and nothing changes there.

Writes report.json in the lab folder (its path is the last line printed).
"""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import urllib.error
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import labkit  # noqa: E402

ROOT = labkit.ROOT


class Stop(Exception):
    """The run cannot go on; the reason is the report's."""


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--target", required=True)
    parser.add_argument("--port", type=int, default=int(os.environ.get("T108_PORT", "4616")))
    parser.add_argument("--ssh-config")
    parser.add_argument("--allow-same-host", action="store_true")
    parser.add_argument("--remote-root", default="~/.yuzuno")
    parser.add_argument("--expect", choices=("scope", "none"))
    args = parser.parse_args()

    run = uuid.uuid4().hex[:8]
    # The acceptance Core (local_jobs_lab) takes only target/t47/lab-* folders.
    lab = ROOT / "target" / "t47" / f"lab-pause-{run}"
    lab.mkdir(parents=True, mode=0o700)
    print(str(lab), flush=True)
    report = {"run": run, "target": args.target, "items": [], "independent": None, "passed": False}
    config = ["-F", args.ssh_config] if args.ssh_config else []
    ssh = ["/usr/bin/ssh", *config, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
           "-o", "ConnectTimeout=10", "-o", "ClearAllForwardings=yes", args.target]

    def remote(command, stdin=None, timeout=60):
        out = subprocess.run(ssh + [command], input=stdin, capture_output=True, text=True, timeout=timeout)
        if out.returncode == 255:
            raise Stop("the machine did not answer over SSH: " + out.stderr.strip()[-300:])
        return out

    helper = labkit.HELPER.read_text()
    mark = labkit.load_helper().MARK

    def hello(local):
        nonce = uuid.uuid4().hex
        request = json.dumps({"action": "hello", "replyNonce": nonce, "root": args.remote_root})
        if local:
            out = subprocess.run([sys.executable, "-c", helper], input=request, capture_output=True, text=True, timeout=60)
        else:
            out = remote("python3 -c " + shlex.quote(helper), stdin=request)
        lines = [line[len(mark) + 33:] for line in out.stdout.splitlines() if line.startswith(f"{mark}{nonce} ")]
        if out.returncode != 0 or len(lines) != 1:
            raise Stop(f"the Jobs helper did not answer hello there (exit {out.returncode}): {out.stderr.strip()[-300:]}")
        return json.loads(lines[0])

    core = None
    created = []

    def item(name, coverage, check):
        started = time.monotonic()
        if not report["independent"]:
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
        finally:
            entry["seconds"] = round(time.monotonic() - started, 1)

    try:
        there, here = hello(False), hello(True)
        report["independent"] = there["hostId"] != here["hostId"]
        if not report["independent"] and not args.allow_same_host:
            raise Stop("the target is this machine (same machine identity), not an independent remote")
        root = there.get("root")
        if not isinstance(root, str) or not root.startswith("/"):
            raise Stop("the Jobs helper there did not report the data root it would use")
        work = f"{root}/acceptance/{run}/work"
        remote(f"umask 077 && mkdir -p {shlex.quote(work)}")
        report["environment"] = {"hostIdPrefix": there["hostId"][:8], "dataRoot": root, "work": work,
                                 "enforcement": there.get("resources")}

        def lines(name):
            out = remote(f"cat {shlex.quote(work + '/' + name)} 2>/dev/null | wc -l").stdout.strip()
            return int(out or 0)

        def ticking(name, seconds=1.5):
            before = lines(name)
            time.sleep(seconds)
            return lines(name) > before

        def read(path):
            return remote(f"cat {shlex.quote(path)} 2>/dev/null").stdout

        fault = lab / "fault"
        fault.mkdir()
        bin_dir = lab / "bin"
        bin_dir.mkdir()
        real = " ".join(shlex.quote(part) for part in ["/usr/bin/ssh", *config])
        # A fault here touches only this run's calls: the reply to one resume is dropped.
        (bin_dir / "ssh").write_text(f"""#!/bin/sh
fault={shlex.quote(str(fault))}
if [ -e "$fault/lose-resume" ]; then
  request=$(cat)
  case "$request" in *'"action":"resume"'*)
    rm -f "$fault/lose-resume"
    printf '%s' "$request" | {real} "$@" >/dev/null 2>&1
    echo "ssh: acceptance fault: the reply to this resume was dropped" >&2
    exit 255;;
  esac
  printf '%s' "$request" | {real} "$@"
  exit $?
fi
exec {real} "$@"
""")
        os.chmod(bin_dir / "ssh", 0o755)
        os.chdir(lab)
        core = labkit.Core(lab, args.port, bin_dir)
        core.start()
        mcp = core.mcp()
        name = f"acceptance {args.target}"
        machine = core.request("/machines", {"name": name, "target": args.target, "codex": "codex", "defaultCwd": work,
                                             "dataRoot": args.remote_root, "limitMode": "limited"})

        def submit(label, ticks, timeout=300):
            command = (f"trap 'echo term > {ticks}.term; exit 0' TERM; "
                       f"while :; do date +%s%N >> {ticks}; sleep 0.05; done")
            job = mcp.call("job_submit", {"requestId": str(uuid.uuid4()), "taskId": "T-1", "name": label, "cwd": work,
                                          "argv": ["/bin/sh", "-c", command], "env": {"PATH": "/usr/bin:/bin"},
                                          "guardGit": False, "timeoutSeconds": timeout, "machineId": machine["id"],
                                          "resources": {"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0}})
            created.append(job["id"])
            running = core.status(job["id"], "running", seconds=90)
            labkit.wait_for(lambda: lines(ticks), bool, 30)
            return running

        def control(job_id, verb):
            try:
                return core.request(f"/jobs/{job_id}/{verb}", {}), None
            except urllib.error.HTTPError as error:
                return None, error.read().decode(errors="replace")[:600]

        def held_of(job):
            return (((job.get("result") or {}).get("started") or {}).get("limits") or {}).get("held") or {}

        def frozen_now(job):
            group = held_of(job).get("cgroup")
            text = read(f"/sys/fs/cgroup{group}/cgroup.events") if group else ""
            return "frozen 1" in text

        first = submit("pausable", "ticks-a")
        held = held_of(first)
        found = "scope" if held.get("unit") else "none"
        report["found"] = {"scope": found, "held": held}
        if args.expect and args.expect != found:
            raise Stop(f"expected an attempt with {args.expect!r} scope there, found {found!r}: {held}")

        if found == "none":
            def refused():
                job, error = control(first["id"], "pause")
                assert job is None and error and (
                    f"Pause is not available for this job on {name}: it runs without a scope of its own there" in error), error
                now = core.job(first["id"])
                assert now["status"] == "running" and not now.get("pause"), now
                assert ticking("ticks-a"), "it keeps running"
                folder = f"{root}/jobs/{first['id']}/{first['attempt']}"
                assert remote(f"test -e {shlex.quote(folder + '/paused.json')} && echo yes").stdout.strip() != "yes"
                return {"refusal": error, "machineEnforcement": there.get("resources")}
            item("Without a scope of its own there, pause is refused with the reason and nothing changes",
                 "real host; its account does not linger, so no scope is made (nothing changed on the machine)", refused)
        else:
            def pauses():
                job, error = control(first["id"], "pause")
                assert error is None and job["pause"]["state"] == "paused", (job, error)
                assert frozen_now(first), "the scope's cgroup.events reads frozen"
                assert not ticking("ticks-a"), "its output stops"
                kept = core.job(first["id"])
                assert (kept["status"], kept["reserved"]) == ("running", True), kept
                return {"pause": job["pause"], "unit": held["unit"]}
            item("Pause freezes the attempt's own scope there, read back from its cgroup; it keeps its slot",
                 "real host; this account's systemd user manager", pauses)

            def lost_resume():
                (fault / "lose-resume").write_text("")
                job, error = control(first["id"], "resume")
                assert error is None and job["pause"]["state"] == "unknown", (job, error)
                assert not (fault / "lose-resume").exists(), "the resume went through the wrapper"
                settled = labkit.wait_for(lambda: core.job(first["id"]), lambda j: not j.get("pause"), 60)
                assert not frozen_now(first) and ticking("ticks-a"), "thawed, and its output goes on"
                return {"unknownReason": job["pause"]["reason"], "settled": settled.get("pauses", [])[-1:]}
            item("A resume whose reply is lost is unknown, then settled by the machine's status: resumed",
                 "real host; the reply was dropped by this run's ssh wrapper", lost_resume)

            def cancel_paused():
                job, error = control(first["id"], "pause")
                assert error is None and job["pause"]["state"] == "paused", (job, error)
                core.request(f"/jobs/{first['id']}/cancel", {})
                done = core.status(first["id"], "cancelled", "failed", "unknown", seconds=90)
                assert done["status"] == "cancelled", done
                thawed = ((done["result"] or {}).get("evidence") or {}).get("result", {}).get("thawedToStop")
                assert thawed and thawed["wasFrozen"] is True, done["result"]
                assert read(f"{work}/ticks-a.term") == "term\n", "it acted on TERM"
                return {"thawedToStop": thawed}
            item("Cancel of a paused job thaws it, so its processes act on TERM, then stops it",
                 "real host", cancel_paused)

            def timeout_paused():
                second = submit("short", "ticks-b", timeout=8)
                job, error = control(second["id"], "pause")
                assert error is None and job["pause"]["state"] == "paused", (job, error)
                done = core.status(second["id"], "failed", "cancelled", "unknown", "succeeded", seconds=90)
                assert (done["status"], done["reason"]) == ("failed", "timeout after 8 s; its process group was stopped"), done
                thawed = ((done["result"] or {}).get("evidence") or {}).get("result", {}).get("thawedToStop")
                assert thawed and thawed["wasFrozen"] is True, done["result"]
                return {"reason": done["reason"]}
            item("A paused job's timeout still counts: it is thawed and stopped at its deadline", "real host", timeout_paused)

        report["passed"] = bool(report["items"]) and all(entry["result"] == "PASS" for entry in report["items"])
    except Stop as stop:
        report["stopped"] = str(stop)
        print(f"STOP {stop}", flush=True)
    except Exception as error:
        report.setdefault("error", f"{type(error).__name__}: {error}"[:2000])
        print(f"ERROR {report['error']}", flush=True)
    finally:
        if core is not None:
            for job_id in created:
                try:
                    now = core.job(job_id)
                    if now.get("pause"):
                        core.request(f"/jobs/{job_id}/resume", {})
                    if now["reserved"]:
                        core.request(f"/jobs/{job_id}/cancel", {})
                        labkit.wait_for(lambda: not core.job(job_id)["reserved"], bool, 60)
                except Exception as error:  # noqa: BLE001 - reported, the rest still stops
                    report.setdefault("cleanupErrors", []).append(f"{job_id}: {error}"[:300])
            core.stop()
        report["kept"] = "everything this run created there is kept as evidence under the data root"
        (lab / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(str(lab / "report.json"), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
