#!/usr/bin/env python3
"""T-186 managed Jobs on a Mac over real SSH, from an isolated Core.

The Mac is a registered SSH machine (T186_TARGET, an alias of this account's
own SSH config; nothing in it or in its keys is changed) in the limited mode,
with a data root and a work folder of the lab's own there (T186_ROOT,
T186_WORK; the work folder must exist). The isolated Core is the
local_jobs_lab example (T108_LAB_BIN) with its own folder and port; it
reaches the Mac through a PATH `ssh` wrapper that passes everything to
/usr/bin/ssh, except helper calls while the lab asks it to lose them: the
reply of one start (the start itself reaches the Mac), or every call while
the lab says the machine is down. Never the daily Core or its machines.

Checks: the platform learned at hello and what the Job is told it gets (limits
declared only, no pause); a run and its output; a failure; a timeout; an
input frozen there at submit; an artifact checked there; cancel stopping the
attempt's process group and nothing else; a repeated submission and a Core
restart that never start twice; the machine down mid-run (unknown, slot held,
then the same attempt); a lost start reply (unknown, then found, never started
twice); pause refused; strict refused with nothing started.
"""
import json
import os
from pathlib import Path
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import labkit  # noqa: E402

LAB = Path(os.environ["T186_LAB"])
TARGET = os.environ["T186_TARGET"]
ROOT = os.environ.get("T186_ROOT", "~/yuzuno-t186-lab")
WORK = os.environ["T186_WORK"]
PORT = int(os.environ.get("T186_PORT", "4690"))
REPORT = {"target": TARGET, "root": ROOT, "work": WORK, "checks": []}

WRAPPER = r"""#!/bin/sh
# The lab's ssh: everything goes to /usr/bin/ssh, except helper calls while
# the lab asks to lose them.
case "$*" in *"python3 -c"*) ;; *) exec /usr/bin/ssh "$@";; esac
if [ -e "$LAB/down" ]; then
  cat >/dev/null; echo "ssh: connect to host lab-mac port 22: Connection refused (lab)" >&2; exit 255
fi
request=$(cat)
case "$request" in
  *'"action":"start"'*)
    if [ -e "$LAB/lose-start-reply" ]; then
      rm -f "$LAB/lose-start-reply"
      printf '%s' "$request" | /usr/bin/ssh "$@" >/dev/null 2>&1
      echo "Connection reset by peer (lab)" >&2; exit 255
    fi;;
esac
printf '%s' "$request" | exec /usr/bin/ssh "$@"
"""


def dig(value, *keys):
    for key in keys:
        value = value.get(key) if isinstance(value, dict) else None
    return value


def check(name):
    REPORT["checks"].append(name)
    print("PASS " + name, flush=True)


def main():
    LAB.mkdir(parents=True, mode=0o700)
    bin_dir = LAB / "bin"
    bin_dir.mkdir()
    (bin_dir / "ssh").write_text(WRAPPER.replace("$LAB", str(LAB)))
    (bin_dir / "ssh").chmod(0o755)
    core = labkit.Core(LAB, PORT, bin_dir)
    core.start()
    try:
        run(core)
    finally:
        core.stop()
        (LAB / "report.json").write_text(json.dumps(REPORT, indent=1))


def run(core):
    request, status = core.request, core.status
    mcp = core.mcp()
    machine = request("/machines", {"name": "lab Mac", "target": TARGET, "codex": "codex", "defaultCwd": WORK,
                                    "dataRoot": ROOT, "limitMode": "limited"})
    probe = request(f"/machines/{machine['id']}/check", {})
    REPORT["machine"] = {"id": machine["id"], "check": {"reachable": probe.get("reachable"), "platform": (probe.get("host") or {}).get("platform")}}
    assert probe["reachable"], probe
    check(f"The Mac is registered in the limited mode and its check reaches it over real SSH (platform {REPORT['machine']['check']['platform']})")

    def submit(name, command, request_id=None, mcp_client=None, **extra):
        body = {"requestId": request_id or str(uuid.uuid4()), "taskId": "T-1", "name": name, "cwd": WORK,
                "argv": ["/bin/sh", "-c", command], "env": {"PATH": "/usr/bin:/bin"}, "guardGit": False,
                "resources": {"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0}, "timeoutSeconds": 120,
                "machineId": machine["id"], **extra}
        return (mcp_client or mcp).call("job_submit", body)

    # 1. A run there: the platform is learned at hello, and the Job says what a Mac gives.
    tag = uuid.uuid4().hex[:8]
    REPORT["tag"] = tag
    ok = submit("ok", f"echo begin; echo {tag} > ok-{tag}.txt; sleep 3; echo end")
    first_told = dig(ok, "capabilities", "platform")
    running = status(ok["id"], "running")
    assert running["remote"]["platform"] == "Darwin", running["remote"]
    assert running["capabilities"]["platform"] == "macOS", running["capabilities"]
    assert "macOS holds no CPU or RAM limit (it has no cgroup)" in running["reason"], running["reason"]
    budget = request("/jobs/budget")
    assert budget["reserved"]["cpuMillis"] == 0 and budget["reserved"]["memoryMiB"] == 0, budget["reserved"]
    done = status(ok["id"], "succeeded", "failed")
    assert done["status"] == "succeeded" and done["reserved"] is False, done
    log = request(f"/jobs/{ok['id']}/logs")
    assert log["text"] == "begin\nend\n", log
    REPORT["run"] = {"toldAtSubmit": first_told, "reason": running["reason"],
                     "limits": dig(done, "result", "evidence", "started", "limits") or dig(done, "result", "evidence", "result", "limits"),
                     "pgid": dig(done, "result", "evidence", "started", "pgid"), "bootId": dig(done, "result", "evidence", "started", "bootId")}
    check("A job runs on the Mac: the helper names Darwin at hello, the Job is told a Mac's capabilities, the running reason says the limits are only declared, nothing of this host's budget is held, and its output comes back")

    # 2. The next submit is told what the machine was when it last answered,
    # before it answers again (the lab holds its replies back meanwhile).
    (LAB / "down").touch()
    second = submit("told", "true")
    waiting = status(second["id"], "starting", "queued", seconds=30)
    assert waiting["remote"].get("hostId") is None, waiting
    told = waiting["capabilities"]["platform"]
    assert told == "macOS", told
    (LAB / "down").unlink()
    status(second["id"], "succeeded", "failed")
    check("A later submit to the Mac is told the Mac's capabilities at submit, before the Mac answers again")

    # 3. A failure, and a timeout.
    bad = submit("bad", "echo DONE; exit 4")
    failed = status(bad["id"], "succeeded", "failed")
    assert (failed["status"], failed["reason"]) == ("failed", "exit-code 4"), failed
    slow = submit("slow", "sleep 60", timeoutSeconds=3)
    timed = status(slow["id"], "succeeded", "failed", "cancelled", seconds=90)
    assert timed["status"] == "failed" and "timeout" in timed["reason"].lower(), timed
    REPORT["timeout"] = timed["reason"]
    check("A command that exits 4 is failed, exit-code 4; one past its timeout is failed by the timeout")

    # 4. An input frozen there at submit, and an artifact checked there.
    frozen = submit("frozen", f"cat ok-{tag}.txt > out-{tag}.json.tmp && printf '{{\"tag\": \"%s\"}}' \"$(cat out-{tag}.json.tmp)\" > out-{tag}.json",
                    inputs=[f"ok-{tag}.txt"], artifacts=[{"path": f"out-{tag}.json", "format": "json"}])
    assert dig(frozen, "snapshot", "hostId"), frozen.get("snapshot")
    built = status(frozen["id"], "succeeded", "failed")
    assert built["status"] == "succeeded", built
    artifacts = built["result"]["artifacts"]
    assert artifacts[0]["path"].endswith(f"out-{tag}.json") and len(artifacts[0]["sha256"]) == 64, artifacts
    REPORT["io"] = {"inputHost": dig(frozen, "snapshot", "hostId"), "artifact": artifacts[0]}
    check("An input is frozen on the Mac at submit and an artifact is checked there after a clean exit")

    # 5. Cancel stops the attempt's own process group and nothing else.
    bystander = submit("bystander", f"echo $$ > bystander-{tag}.pid; sleep 40")
    status(bystander["id"], "running")
    tree = submit("tree", f"sleep 60 & echo $! > child-{tag}.pid; sleep 60")
    status(tree["id"], "running")
    request(f"/jobs/{tree['id']}/cancel", {})
    cancelled = status(tree["id"], "cancelled", "failed", "unknown", seconds=60)
    assert cancelled["status"] == "cancelled" and cancelled["reserved"] is False, cancelled
    probe_job = submit("probe", f"kill -0 $(cat child-{tag}.pid) 2>/dev/null && echo child-alive || echo child-gone; "
                                f"kill -0 $(cat bystander-{tag}.pid) 2>/dev/null && echo bystander-alive || echo bystander-gone")
    status(probe_job["id"], "succeeded", "failed")
    seen = request(f"/jobs/{probe_job['id']}/logs")["text"]
    assert seen == "child-gone\nbystander-alive\n", seen
    assert core.job(bystander["id"])["status"] == "running"
    request(f"/jobs/{bystander['id']}/cancel", {})
    status(bystander["id"], "cancelled", seconds=60)
    REPORT["cancel"] = {"reason": cancelled["reason"], "after": seen.split()}
    check("Cancel stops the attempt's process group there, its child included; another job's process is left running")

    # 6. Pause is refused on a Mac, with nothing changed.
    held = submit("held", "sleep 20")
    status(held["id"], "running")
    refusal = core.refused(f"/jobs/{held['id']}/pause", {})
    assert "it is a Mac" in refusal and "nothing was changed" in refusal, refusal
    assert core.job(held["id"])["status"] == "running"
    request(f"/jobs/{held['id']}/cancel", {})
    status(held["id"], "cancelled", seconds=60)
    REPORT["pause"] = refusal
    check("Pause is refused on the Mac with its reason, and the job keeps running")

    # 7. A repeated submission and a Core restart never start it twice.
    key = str(uuid.uuid4())
    once = submit("once", f"echo run >> once-{tag}.txt; sleep 8", request_id=key)
    again = submit("once", f"echo run >> once-{tag}.txt; sleep 8", request_id=key)
    assert once["id"] == again["id"]
    status(once["id"], "running")
    core.stop()
    time.sleep(2)
    core.start()
    mcp = core.mcp()
    done = status(once["id"], "succeeded", "failed", seconds=90)
    assert done["status"] == "succeeded" and done["attempt"] == once["attempt"], done
    counted = submit("count", f"wc -l < once-{tag}.txt", mcp_client=mcp)
    status(counted["id"], "succeeded", "failed")
    lines = request(f"/jobs/{counted['id']}/logs")["text"].strip()
    assert lines == "1", lines
    check("The same requestId is the same job, and a Core restart mid-run finds the same attempt on the Mac: it ran once")

    # 8. The machine down mid-run: unknown with its slot held, then the same attempt.
    steady = submit("steady", "sleep 15; echo finished", mcp_client=mcp)
    status(steady["id"], "running")
    (LAB / "down").touch()
    unknown = status(steady["id"], "unknown", seconds=60)
    assert unknown["reserved"] is True, unknown
    (LAB / "down").unlink()
    back = status(steady["id"], "running", "succeeded", seconds=60)
    assert back["attempt"] == steady["attempt"]
    finished = status(steady["id"], "succeeded", "failed", seconds=60)
    assert finished["status"] == "succeeded", finished
    REPORT["down"] = {"unknownReason": unknown["reason"], "after": back["status"]}
    check("The Mac unreachable mid-run: the job is unknown with its slot held; once it answers, the same attempt is found and finishes")

    # 9. A start whose reply is lost: unknown, then found there, never started twice.
    (LAB / "lose-start-reply").touch()
    lost = submit("lost", f"echo run >> lost-{tag}.txt; sleep 4", mcp_client=mcp)
    unacked = status(lost["id"], "unknown", seconds=60)
    assert unacked["reserved"] is True and "No acknowledgement" in unacked["reason"], unacked
    assert not (LAB / "lose-start-reply").exists(), "the start was sent"
    found = status(lost["id"], "succeeded", "failed", seconds=90)
    assert found["status"] == "succeeded" and found["attempt"] == lost["attempt"], found
    counted = submit("count-lost", f"wc -l < lost-{tag}.txt", mcp_client=mcp)
    status(counted["id"], "succeeded", "failed")
    lines = request(f"/jobs/{counted['id']}/logs")["text"].strip()
    assert lines == "1", lines
    REPORT["lostAck"] = {"unknownReason": unacked["reason"]}
    check("A start whose reply is lost is unknown with its slot held, then found on the Mac and finished; it ran once")

    # 10. strict: nothing it cannot hold is started.
    settings = {"name": machine["name"], "target": TARGET, "codex": "codex", "defaultCwd": WORK, "dataRoot": ROOT}
    request(f"/machines/{machine['id']}", {**settings, "limitMode": "strict"}, method="PUT")
    strict = submit("strict", f"echo run >> strict-{tag}.txt", mcp_client=mcp)
    ended = status(strict["id"], "rejected", "failed", "succeeded", seconds=60)
    assert ended["status"] == "rejected" and "cannot hold strict limits" in ended["reason"], ended
    assert (ended.get("remote") or {}).get("startSentAt") is not None, "the helper refused the start itself"
    request(f"/machines/{machine['id']}", {**settings, "limitMode": "limited"}, method="PUT")
    REPORT["strict"] = ended["reason"]
    check("In the strict mode a Mac starts nothing: refused before the command runs, with why")


if __name__ == "__main__":
    main()
