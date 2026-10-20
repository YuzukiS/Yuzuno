#!/usr/bin/env python3
"""T-108: a job with inputs and artifacts queued by this Core, not yet pinned
to its machine, then handled by an older Core (one that knows data roots but
not remote inputs and artifacts, such as a build of 8651079) on the same
Workspace, as after a rollback.

    python3 acceptance/remote-jobs/rollback.py --target ALIAS --ssh-config FILE
        --remote-root ROOT --new-bin LAB_CORE --old-bin LAB_CORE
        --expect red|green [--port 4615]

Both Cores are local_jobs_lab builds run in turn on one isolated lab folder
(target/t47/lab-rb-<run>), never the daily Core. The machine is registered
with one attempt at a time; a blocker holds its slot so the job stays queued
and unpinned while the new Core stops, its input changes, and the old Core
starts. Then the old Core takes the slot.

red:   the old Core runs the command anyway: its input was not checked again
       and its declared artifact (never written) was not checked.
green: the old Core starts nothing: the machine refuses the start (the digest
       bound at submit does not match the older request), nothing is written
       for the attempt there, and the job ends visibly as not started. The new
       Core, started again, leaves that outcome as it is and runs nothing.

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
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import labkit  # noqa: E402

ROOT = labkit.ROOT
TERMINAL = ("succeeded", "failed", "rejected", "cancelled")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--target", required=True)
    parser.add_argument("--ssh-config", required=True)
    parser.add_argument("--remote-root", required=True)
    parser.add_argument("--new-bin", required=True)
    parser.add_argument("--old-bin", required=True)
    parser.add_argument("--expect", choices=("red", "green"), required=True)
    parser.add_argument("--port", type=int, default=4615)
    args = parser.parse_args()

    run = uuid.uuid4().hex[:8]
    lab = ROOT / "target" / "t47" / f"lab-rb-{run}"
    lab.mkdir(parents=True, mode=0o700)
    print(str(lab), flush=True)
    report = {"run": run, "expect": args.expect, "newBin": args.new_bin, "oldBin": args.old_bin, "steps": [], "passed": False}
    ssh = ["/usr/bin/ssh", "-F", args.ssh_config, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", args.target]

    def remote(command):
        out = subprocess.run(ssh + [command], capture_output=True, text=True, timeout=60)
        assert out.returncode != 255, out.stderr[-300:]
        return out.stdout

    def step(name, **facts):
        report["steps"].append(dict(facts, step=name, at=time.time()))
        print(f"{name}: {json.dumps(facts)[:600]}", flush=True)

    bin_dir = lab / "bin"
    bin_dir.mkdir()
    (bin_dir / "ssh").write_text(f"#!/bin/sh\nexec /usr/bin/ssh -F {shlex.quote(args.ssh_config)} \"$@\"\n")
    os.chmod(bin_dir / "ssh", 0o755)
    core = None
    try:
        work = f"{args.remote_root}/acceptance/{run}/work"
        remote(f"umask 077 && mkdir -p {shlex.quote(work)}")

        def put(name, text):
            subprocess.run(ssh + [f"cat > {shlex.quote(work + '/' + name)}"], input=text, text=True, check=True, timeout=60)

        def start(binary):
            os.environ["T108_LAB_BIN"] = binary
            started = labkit.Core(lab, args.port, bin_dir)
            started.start()
            return started

        # 1. This Core: the machine, a blocker in its only slot, and the job queued behind it.
        core = start(args.new_bin)
        mcp = core.mcp()
        machine = core.request("/machines", {"name": "rollback box", "target": args.target, "codex": "codex", "defaultCwd": work,
                                             "dataRoot": args.remote_root, "limitMode": "limited", "maxJobs": 1})

        def body(label, command, **extra):
            return {"requestId": str(uuid.uuid4()), "taskId": "T-1", "name": label, "cwd": work,
                    "argv": ["/bin/sh", "-c", command], "env": {"PATH": "/usr/bin:/bin"}, "guardGit": False,
                    "resources": {"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0}, "timeoutSeconds": 120,
                    "machineId": machine["id"], **extra}

        blocker = mcp.call("job_submit", body("blocker", "sleep 25"))
        core.status(blocker["id"], "running", seconds=60)
        put("in.txt", "v1\n")
        queued = mcp.call("job_submit", body("queued", "echo ran >> ran.txt", inputs=["in.txt"],
                                             artifacts=[{"path": "never.json", "format": "json"}]))
        waiting = core.job(queued["id"])
        assert waiting["status"] == "queued" and not (waiting.get("remote") or {}).get("hostId"), waiting
        step("queued by this Core, not pinned", jobId=queued["id"], attempt=queued["attempt"], remote=waiting.get("remote"),
             limitMode=waiting["executor"].get("limitMode"))
        core.stop()
        core = None

        # 2. Rolled back: its input changes, and the older Core opens the same Workspace.
        put("in.txt", "v2\n")
        try:
            core = start(args.old_bin)
        except AssertionError as error:
            step("the older Core did not open the Workspace", error=str(error)[-1500:])
            report["oldCoreOpened"] = False
            raise
        report["oldCoreOpened"] = True
        deadline = time.monotonic() + 150
        while True:
            now = core.job(queued["id"])
            if now["status"] in TERMINAL or time.monotonic() > deadline:
                break
            time.sleep(1)
        ran = remote(f"cat {shlex.quote(work + '/ran.txt')} 2>/dev/null")
        attempt_dir = f"{args.remote_root}/jobs/{queued['id']}/{queued['attempt']}"
        written = remote(f"test -e {shlex.quote(attempt_dir)} && echo yes").strip() == "yes"
        step("handled by the older Core", status=now["status"], reason=now.get("reason"), remote=now.get("remote"),
             ranTxt=ran, attemptFolderWritten=written)
        core.stop()
        core = None

        # 3. This Core again: what the older one left is kept, and nothing runs again.
        core = start(args.new_bin)
        time.sleep(8)
        again = core.job(queued["id"])
        ran_again = remote(f"cat {shlex.quote(work + '/ran.txt')} 2>/dev/null")
        step("this Core again", status=again["status"], reason=again.get("reason"), ranTxt=ran_again)
        core.status(blocker["id"], *TERMINAL, seconds=60)

        if args.expect == "red":
            assert now["status"] == "succeeded" and ran == "ran\n", "red: the older Core ran it without its checks"
        else:
            assert now["status"] == "rejected" and "digest does not match" in (now.get("reason") or ""), now
            assert ran == "" and not written, (ran, written)
            assert again["status"] == "rejected" and ran_again == "", (again, ran_again)
        report["passed"] = True
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"[:2000]
        print(f"ERROR {report['error']}", flush=True)
    finally:
        if core is not None:
            core.stop()
        (lab / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(str(lab / "report.json"), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
