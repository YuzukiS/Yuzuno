#!/usr/bin/env python3
"""T-108 acceptance of remote inputs and artifacts on an independent machine.

    python3 acceptance/remote-jobs/io.py --target ALIAS --remote-root ~/jobs-lab/.yuzuno
        [--port 4613] [--ssh-config FILE] [--allow-same-host]

ALIAS is an SSH destination this account can already reach with its own
configuration and keys (batch mode, strict host keys: an unknown or changed
host key stops the run). Like independent.py, the run starts an isolated
acceptance Core (its own folder and port, never the daily Core), registers the
machine there with its data root (--remote-root) in the limited mode and one
attempt at a time, and works in <root>/acceptance/<run>/work there. Every file
the run and its jobs create on the machine is under that data root, whose
parent must already exist; it is kept as evidence. The files are a few bytes
and the commands short. Faults are only this run's: the acceptance Core's
`ssh` is a wrapper that can drop the reply to a start; the machine, its sshd,
its account and the network are never touched.

Items:
- inputs frozen there and artifacts checked there, recorded with the machine;
- an input changed while the job is queued rejects it before it runs;
- missing and malformed artifacts are each named;
- a path that exists only on this host, or a same-named file here, is never
  read for an input: the machine's file is;
- a start whose reply is lost is the same attempt when the machine answers,
  run once, with its inputs and artifacts;
- a command that fails is told apart from artifacts that fail.

Writes report.json in the lab folder (its path is the last line printed).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import labkit  # noqa: E402

ROOT = labkit.ROOT


class Stop(Exception):
    """The run cannot go on; the reason is the report's."""


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--target", required=True)
    parser.add_argument("--port", type=int, default=int(os.environ.get("T108_PORT", "4613")))
    parser.add_argument("--ssh-config")
    parser.add_argument("--allow-same-host", action="store_true")
    parser.add_argument("--remote-root", default="~/.yuzuno")
    args = parser.parse_args()

    run = uuid.uuid4().hex[:8]
    # The acceptance Core (local_jobs_lab) takes only target/t47/lab-* folders.
    lab = ROOT / "target" / "t47" / f"lab-io-{run}"
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
        same = there["hostId"] == here["hostId"]
        report["independent"] = not same
        if same and not args.allow_same_host:
            raise Stop("the target is this machine (same machine identity), not an independent remote")
        root = there.get("root")
        if not isinstance(root, str) or not root.startswith("/"):
            raise Stop("the Jobs helper there did not report the data root it would use")
        parent = root.rsplit("/", 1)[0] or "/"
        if remote(f"test -d {shlex.quote(parent)} && test ! -L {shlex.quote(root)} && echo ok").stdout.strip() != "ok":
            raise Stop(f"{parent} does not exist there, or the data root is a link; nothing was created")
        work = f"{root}/acceptance/{run}"
        work = f"{work}/work"
        remote(f"umask 077 && mkdir -p {shlex.quote(work)}")
        report["environment"] = {"hostIdPrefix": there["hostId"][:8], "dataRoot": root, "work": work,
                                 "workExistsOnThisHost": os.path.exists(work)}

        def put(name, text):
            remote(f"cat > {shlex.quote(work + '/' + name)}", stdin=text)

        def read(name):
            return remote(f"cat {shlex.quote(work + '/' + name)} 2>/dev/null").stdout

        def exists(path):
            return remote(f"test -e {shlex.quote(path)} && echo yes").stdout.strip() == "yes"

        def realpath(name):
            return remote(f"realpath {shlex.quote(work + '/' + name)}").stdout.strip()

        fault = lab / "fault"
        fault.mkdir()
        bin_dir = lab / "bin"
        bin_dir.mkdir()
        real = " ".join(shlex.quote(part) for part in ["/usr/bin/ssh", *config])
        # As independent.py: a fault here touches only this run's calls.
        (bin_dir / "ssh").write_text(f"""#!/bin/sh
fault={shlex.quote(str(fault))}
if [ -e "$fault/lose-start" ]; then
  request=$(cat)
  case "$request" in *'"action":"start"'*)
    rm -f "$fault/lose-start"
    printf '%s' "$request" | {real} "$@" >/dev/null 2>&1
    echo "ssh: acceptance fault: the reply to this start was dropped" >&2
    exit 255;;
  esac
  printf '%s' "$request" | {real} "$@"
  exit $?
fi
exec {real} "$@"
""")
        os.chmod(bin_dir / "ssh", 0o755)
        # The acceptance Core runs in the lab folder, where a same-named
        # decoy of an input is put below.
        os.chdir(lab)
        core = labkit.Core(lab, args.port, bin_dir)
        core.start()
        mcp = core.mcp()
        name = f"acceptance {args.target}"
        machine = core.request("/machines", {"name": name, "target": args.target, "codex": "codex", "defaultCwd": work,
                                             "dataRoot": args.remote_root, "limitMode": "limited", "maxJobs": 1})

        def body(label, command, **extra):
            return {"requestId": str(uuid.uuid4()), "taskId": "T-1", "name": label, "cwd": work,
                    "argv": ["/bin/sh", "-c", command], "env": {"PATH": "/usr/bin:/bin"}, "guardGit": False,
                    "resources": {"cpuMillis": 500, "memoryMiB": 128, "swapMiB": 0}, "timeoutSeconds": 120,
                    "machineId": machine["id"], **extra}

        def submit(label, command, **extra):
            job = mcp.call("job_submit", body(label, command, **extra))
            created.append(job["id"])
            return job

        def result(job):
            # The job's outcome; what the machine replied is its `evidence`.
            return job.get("result") or {}

        def exit_code(job):
            return ((result(job).get("evidence") or {}).get("result") or {}).get("exitCode")

        def download(job_id, index=0):
            req = urllib.request.Request(f"{core.base}/api/jobs/{job_id}/artifacts/{index}",
                                         headers={"X-Yuzuno-Client": "desktop"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.status, r.read()[:200].decode(errors="replace")
            except urllib.error.HTTPError as error:
                return error.code, error.read().decode(errors="replace")[:500]

        content = f"remote input {run}\n"
        put("in.txt", content)

        def normal():
            job = submit("io ok", "cat in.txt > copy.txt; printf '{\"ok\":true}' > out.json; "
                                  "printf '{\"n\":1}\\n{\"n\":2}\\n' > out.jsonl",
                         inputs=["in.txt"], artifacts=[{"path": "copy.txt"}, {"path": "out.json", "format": "json"},
                                                       {"path": "out.jsonl", "format": "jsonl"}])
            frozen = job["snapshot"]
            assert frozen["hostId"] == there["hostId"], frozen
            assert frozen["frozenOn"]["id"] == machine["id"] and frozen["frozenOn"]["target"] == args.target, frozen
            assert [(f["path"], f["absolutePath"], f["sha256"]) for f in frozen["files"]] == \
                [("in.txt", realpath("in.txt"), sha(content))], frozen["files"]
            done = core.status(job["id"], "succeeded", "failed", "rejected", seconds=90)
            assert (done["status"], done["reason"]) == ("succeeded", "success"), done
            evidence = result(done)
            checked = evidence["artifacts"]
            assert [a["path"] for a in checked] == ["copy.txt", "out.json", "out.jsonl"], checked
            assert all(a["ok"] is True and a["preExisting"] is False for a in checked), checked
            assert checked[0]["sha256"] == sha(content) and checked[0]["absolutePath"] == realpath("copy.txt"), checked
            assert checked[2]["lines"] == 2, checked
            assert evidence["artifactsOn"] == {"machineId": machine["id"], "name": name, "hostId": there["hostId"]}, evidence
            folder = f"{root}/jobs/{job['id']}/{job['attempt']}"
            kept = json.loads(remote(f"cat {shlex.quote(folder + '/artifacts.json')}").stdout)
            assert kept["attempt"] == job["attempt"] and kept["artifacts"] == checked, kept
            code, text = download(job["id"])
            assert code >= 400 and "does not copy it, so it cannot be downloaded here" in text, (code, text)
            return {"jobId": job["id"], "attempt": job["attempt"], "frozen": frozen["files"], "artifacts": checked,
                    "artifactsOn": evidence["artifactsOn"], "download": [code, text]}
        item("Inputs are frozen there and artifacts checked there, recorded with the machine; none is downloadable here",
             "real host", normal)

        def changed_while_queued():
            blocker = submit("blocker", "sleep 12")
            core.status(blocker["id"], "running", seconds=60)
            put("queued.txt", "v1\n")
            queued = submit("queued", "touch ran-queued", inputs=["queued.txt"])
            waiting = core.job(queued["id"])
            assert waiting["status"] == "queued", waiting
            put("queued.txt", "v2\n")
            done = core.status(queued["id"], "succeeded", "failed", "rejected", seconds=90)
            assert done["status"] == "rejected", done
            assert done["reason"] == ("Inputs changed on this machine while queued (queued.txt (its content changed)); "
                                      "command was not started"), done["reason"]
            assert not exists(work + "/ran-queued"), "the command did not run"
            core.status(blocker["id"], "succeeded", seconds=60)
            return {"jobId": queued["id"], "queuedReason": waiting["reason"], "reason": done["reason"]}
        item("An input changed there while the job is queued rejects it before the command runs", "real host",
             changed_while_queued)

        def malformed():
            job = submit("bad artifacts", "printf '{\"a\":' > bad.json; printf '{\"n\":1}' > cut.jsonl; : > empty.txt",
                         artifacts=[{"path": "bad.json", "format": "json"}, {"path": "cut.jsonl", "format": "jsonl"},
                                    {"path": "empty.txt"}, {"path": "none.txt"}])
            done = core.status(job["id"], "succeeded", "failed", "rejected", seconds=90)
            evidence = result(done)
            assert done["status"] == "failed" and exit_code(done) == 0, done
            assert done["reason"].startswith("Exit 0, but declared artifacts failed verification: bad.json: not complete JSON"), done["reason"]
            problems = {a["path"]: a.get("problem") for a in evidence["artifacts"]}
            assert problems["cut.jsonl"] == "the last line is not terminated: the file may be partly written", problems
            assert problems["empty.txt"] == "0 bytes, fewer than the required 1", problems
            assert problems["none.txt"] == "missing", problems
            assert problems["bad.json"].startswith("not complete JSON: "), problems
            assert not any(a["ok"] for a in evidence["artifacts"]), evidence["artifacts"]
            return {"jobId": job["id"], "reason": done["reason"], "problems": problems}
        item("Missing and malformed artifacts are each named and fail the job", "real host", malformed)

        def same_named():
            # A file only this host has, by an absolute path: never read for an input.
            decoy = lab / "decoy" / "in.txt"
            decoy.parent.mkdir()
            decoy.write_text("LOCAL decoy\n")
            if report["independent"]:
                assert not exists(str(decoy)), "the decoy path exists on the machine too"
                text = mcp.call("job_submit", body("decoy", "true", inputs=[str(decoy)]), error=True)
                assert f"Inputs on {name} cannot be frozen, so nothing was submitted: {decoy}: missing" in text, text
                listed = core.request("/jobs")
                jobs = listed["jobs"] if isinstance(listed, dict) else listed
                assert not any(j.get("name") == "decoy" for j in jobs), "no job was created"
            else:
                # Over loopback this host's paths are the machine's.
                text = "not covered over loopback: a path only this host has cannot exist here"
            # The same relative name here and there: the machine's file is the input.
            (lab / "in.txt").write_text("LOCAL decoy\n")
            job = submit("same name", "cat in.txt", inputs=["in.txt"])
            assert job["snapshot"]["files"][0]["sha256"] == sha(content) != sha("LOCAL decoy\n"), job["snapshot"]
            done = core.status(job["id"], "succeeded", "failed", "rejected", seconds=90)
            log = core.request(f"/jobs/{job['id']}/logs")
            assert done["status"] == "succeeded" and log["text"] == content, (done, log)
            return {"refused": text, "frozen": job["snapshot"]["files"], "localDecoySha256": sha("LOCAL decoy\n")}
        item("A path or same-named file that exists only on this host is never read for an input; the machine's is",
             "real host", same_named)

        def lost_start():
            (fault / "lose-start").write_text("")
            job = submit("lossy", "echo run >> lossy-runs.txt; cp in.txt lossy-copy.txt", inputs=["in.txt"],
                         artifacts=[{"path": "lossy-copy.txt"}])
            unknown = core.status(job["id"], "unknown", seconds=60)
            assert unknown["reason"].startswith(f"No acknowledgement from {name}"), unknown
            assert not (fault / "lose-start").exists(), "the start went through the wrapper"
            done = core.status(job["id"], "succeeded", "failed", "rejected", seconds=90)
            assert (done["status"], done["attempt"]) == ("succeeded", job["attempt"]), done
            assert read("lossy-runs.txt") == "run\n", "it ran once"
            checked = result(done)["artifacts"]
            assert checked[0]["ok"] and checked[0]["sha256"] == sha(content), checked
            return {"jobId": job["id"], "unknownReason": unknown["reason"], "artifacts": checked}
        item("A start whose reply is lost is the same attempt when the machine answers, run once, with its inputs and artifacts",
             "real host; the reply was dropped by this run's ssh wrapper", lost_start)

        def failure_kinds():
            job = submit("exit 3", "printf x > fail.txt; exit 3", inputs=["in.txt"], artifacts=[{"path": "fail.txt"}])
            done = core.status(job["id"], "succeeded", "failed", "rejected", seconds=90)
            evidence = result(done)
            assert (done["status"], done["reason"], exit_code(done)) == ("failed", "exit-code 3", 3), done
            assert "artifacts" not in evidence and "artifacts" not in evidence["evidence"]["result"], evidence
            return {"jobId": job["id"], "reason": done["reason"]}
        item("A command that fails is reported as such, without an artifact check (artifact failures: above)",
             "real host", failure_kinds)

        report["passed"] = all(entry["result"] == "PASS" for entry in report["items"]) and len(report["items"]) == 6
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
                    if core.job(job_id)["reserved"]:
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
