#!/usr/bin/env python3
"""T-108 acceptance of Windows inputs and artifacts through a real Core, on
this PC's Windows.

    python3 acceptance/windows-jobs/io_windows.py --helper EXE [--port 4627]

An isolated acceptance Core (local_jobs_lab, its own folder and port, never
the daily Core) is given the Windows helper explicitly, as a development
configuration: a wrapper (YUZUNO_WINDOWS_JOBS_HELPER with its SHA-256) that
runs EXE and can drop the reply to one start, so a fault touches only this
run's calls. Its data root is a new folder of this run,
<LocalAppData>\\yuzuno-acceptance\\t108wio-io-<run>, kept as evidence, with
the jobs' working folder in it. Setup files are written there through WSL's
view of the drive; every verdict comes from Core and the helper reading on
Windows. The files are a few bytes, the commands short cmd.exe lines.

Items (as acceptance/remote-jobs/io.py on an SSH machine):
- inputs frozen and artifacts checked on Windows, recorded with it; none is
  downloadable here;
- an input changed while the job is queued rejects it before it runs;
- missing, malformed, cut-off and empty artifacts are each named;
- a path only this host has is refused for an input, and a same-named file
  here is never read: Windows' is;
- a start whose reply is lost is the same attempt when Windows answers, run
  once, with its inputs and artifacts;
- a command that fails is told apart from artifacts that fail.

Writes report.json in the lab folder (its path is the last line printed).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "remote-jobs"))
import labkit  # noqa: E402

ROOT = labkit.ROOT
CMD = r"C:\Windows\System32\cmd.exe"
NAME = "Windows on this PC"


def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--helper", required=True, help="the Windows helper exe to use (built from this tree)")
    parser.add_argument("--port", type=int, default=4627)
    args = parser.parse_args()
    helper_exe = Path(args.helper).resolve()

    run = uuid.uuid4().hex[:8]
    # The acceptance Core (local_jobs_lab) takes only target/t47/lab-* folders.
    lab = ROOT / "target" / "t47" / f"lab-wio-{run}"
    lab.mkdir(parents=True, mode=0o700)
    print(str(lab), flush=True)
    report = {"run": run, "items": [], "helperSha256": sha(helper_exe.read_bytes()), "passed": False}
    core = None
    created = []

    def item(name, coverage, check):
        started = time.monotonic()
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

    def direct(request):
        nonce = uuid.uuid4().hex
        done = subprocess.run([str(helper_exe)], input=json.dumps(dict(request, replyNonce=nonce)).encode(),
                              capture_output=True, timeout=60)
        prefix = f"YUZUNO-JOBS-REPLY {nonce} "
        lines = [line[len(prefix):] for line in done.stdout.decode("utf-8", "replace").split("\n") if line.startswith(prefix)]
        assert done.returncode == 0 and len(lines) == 1, (done.returncode, done.stderr[-300:])
        return json.loads(lines[0])

    try:
        hello = direct({"action": "hello"})
        root = hello["localAppData"].rstrip("\\") + "\\yuzuno-acceptance\\t108wio-io-" + run
        root_wsl = Path(subprocess.run(["wslpath", "-u", root], capture_output=True, text=True, check=True).stdout.strip())
        root_wsl.parent.mkdir(parents=True, exist_ok=True)
        root_wsl.mkdir()  # never someone else's: it must not exist yet
        work, work_wsl = root + "\\work", root_wsl / "work"
        work_wsl.mkdir()
        report["environment"] = {"hostIdPrefix": hello["hostId"][:8], "protocol": hello["protocol"], "work": work}

        def put(name, data):
            (work_wsl / name).write_bytes(data if isinstance(data, bytes) else data.encode())

        def read(name):
            path = work_wsl / name
            return path.read_bytes() if path.exists() else None

        fault = lab / "fault"
        fault.mkdir()
        wrapper = lab / "bin" / "windows-helper"
        wrapper.parent.mkdir()
        # A fault here touches only this run's calls: the start's reply is dropped once.
        wrapper.write_text(f"""#!/bin/sh
fault='{fault}'
exe='{helper_exe}'
if [ -e "$fault/lose-start" ]; then
  request=$(cat)
  case "$request" in *'"action":"start"'*)
    rm -f "$fault/lose-start"
    printf '%s' "$request" | "$exe" "$@" >/dev/null 2>&1
    echo "acceptance fault: the reply to this start was dropped" >&2
    exit 1;;
  esac
  printf '%s' "$request" | "$exe" "$@"
  exit $?
fi
exec "$exe" "$@"
""")
        os.chmod(wrapper, 0o755)
        os.environ["YUZUNO_WINDOWS_JOBS_HELPER"] = str(wrapper)
        os.environ["YUZUNO_WINDOWS_JOBS_HELPER_SHA256"] = sha(wrapper.read_bytes())
        os.environ["YUZUNO_WINDOWS_JOBS_ROOT"] = root
        # The acceptance Core runs in the lab folder, where a same-named decoy
        # of an input is put below.
        os.chdir(lab)
        core = labkit.Core(lab, args.port, lab / "bin")
        core.start()
        mcp = core.mcp()

        def body(label, line, **extra):
            return {"requestId": str(uuid.uuid4()), "taskId": "T-1", "name": label, "cwd": work,
                    "argv": [CMD, "/d", "/c", line], "guardGit": False, "machineId": "windows",
                    "resources": {"cpuMillis": 500, "memoryMiB": 256, "swapMiB": 0}, "timeoutSeconds": 120, **extra}

        def submit(label, line, **extra):
            job = mcp.call("job_submit", body(label, line, **extra))
            created.append(job["id"])
            return job

        def result(job):
            return job.get("result") or {}

        def exit_code(job):
            return ((result(job).get("evidence") or {}).get("result") or {}).get("exitCode")

        def download(job_id, index=0):
            req = urllib.request.Request(f"{core.base}/api/jobs/{job_id}/artifacts/{index}", headers={"X-Yuzuno-Client": "desktop"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.status, r.read()[:200].decode(errors="replace")
            except urllib.error.HTTPError as error:
                return error.code, error.read().decode(errors="replace")[:500]

        content = f"windows input {run}\n"
        put("in.txt", content)

        def normal():
            job = submit("io ok", "copy /y in.txt copy.txt>nul&echo [1,2]>out.json&echo {}>out.jsonl&echo []>>out.jsonl",
                         inputs=["in.txt"], artifacts=[{"path": "copy.txt"}, {"path": "out.json", "format": "json"},
                                                       {"path": "out.jsonl", "format": "jsonl"}])
            frozen = job["snapshot"]
            assert frozen["hostId"] == hello["hostId"] and frozen["frozenOn"]["kind"] == "windows", frozen
            assert [(f["path"], f["absolutePath"], f["sha256"]) for f in frozen["files"]] == \
                [("in.txt", work + "\\in.txt", sha(content))], frozen["files"]
            done = core.status(job["id"], "succeeded", "failed", "rejected", seconds=90)
            assert (done["status"], done["reason"]) == ("succeeded", "success"), done
            evidence = result(done)
            checked = evidence["artifacts"]
            assert [a["path"] for a in checked] == ["copy.txt", "out.json", "out.jsonl"], checked
            assert all(a["ok"] is True and a["preExisting"] is False for a in checked), checked
            assert checked[0]["sha256"] == sha(content) and checked[0]["absolutePath"] == work + "\\copy.txt", checked
            assert checked[2]["lines"] == 2, checked
            assert evidence["artifactsOn"] == {"machineId": "windows", "name": NAME, "hostId": hello["hostId"]}, evidence
            kept = json.loads((root_wsl / "jobs" / job["id"] / job["attempt"] / "artifacts.json").read_text())
            assert kept["attempt"] == job["attempt"] and kept["artifacts"] == checked, kept
            code, text = download(job["id"])
            assert code >= 400 and "does not copy it, so it cannot be downloaded here" in text, (code, text)
            return {"jobId": job["id"], "attempt": job["attempt"], "frozen": frozen["files"], "artifacts": checked,
                    "artifactsOn": evidence["artifactsOn"], "download": [code, text]}
        item("Inputs are frozen on Windows and artifacts checked there, recorded with it; none is downloadable here",
             "real Windows on this PC", normal)

        def changed_while_queued():
            core.request("/jobs/windows", {"maxJobs": 1})
            blocker = submit("blocker", "ping -n 13 127.0.0.1 >nul")
            core.status(blocker["id"], "running", seconds=60)
            put("queued.txt", "v1\n")
            queued = submit("queued", "echo ran>ran-queued.txt", inputs=["queued.txt"])
            waiting = core.job(queued["id"])
            assert waiting["status"] == "queued", waiting
            put("queued.txt", "v2\n")
            done = core.status(queued["id"], "succeeded", "failed", "rejected", seconds=90)
            assert done["status"] == "rejected", done
            assert done["reason"] == ("Inputs changed on this machine while queued (queued.txt (its content changed)); "
                                      "command was not started"), done["reason"]
            assert read("ran-queued.txt") is None, "the command did not run"
            core.status(blocker["id"], "succeeded", seconds=60)
            core.request("/jobs/windows", {"maxJobs": None})
            return {"jobId": queued["id"], "queuedReason": waiting["reason"], "reason": done["reason"]}
        item("An input changed on Windows while the job is queued rejects it before the command runs",
             "real Windows on this PC", changed_while_queued)

        def malformed():
            job = submit("bad artifacts", "echo {x>bad.json&<nul set /p ={}>cut.jsonl&type nul>empty.txt",
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
        item("Missing, malformed, cut-off and empty artifacts are each named and fail the job", "real Windows on this PC", malformed)

        def same_named():
            # A file only this host has, by its absolute path: refused at submit, no job.
            decoy = lab / "decoy" / "in.txt"
            decoy.parent.mkdir()
            decoy.write_text("LOCAL decoy\n")
            text = mcp.call("job_submit", body("decoy", "echo x", inputs=[str(decoy)]), error=True)
            assert "inputs on Windows are drive paths" in text, text
            listed = core.request("/jobs")
            jobs = listed["jobs"] if isinstance(listed, dict) else listed
            assert not any(j.get("name") == "decoy" for j in jobs), "no job was created"
            # The same relative name here and on Windows: Windows' file is the input.
            (lab / "in.txt").write_text("LOCAL decoy\n")
            job = submit("same name", "type in.txt", inputs=["in.txt"])
            assert job["snapshot"]["files"][0]["sha256"] == sha(content) != sha("LOCAL decoy\n"), job["snapshot"]
            done = core.status(job["id"], "succeeded", "failed", "rejected", seconds=90)
            log = core.request(f"/jobs/{job['id']}/logs")
            assert done["status"] == "succeeded" and log["text"] == content, (done, log)
            return {"refused": text, "frozen": job["snapshot"]["files"], "localDecoySha256": sha("LOCAL decoy\n")}
        item("A path only this host has is refused for an input, and a same-named file here is never read; Windows' is",
             "real Windows on this PC", same_named)

        def lost_start():
            (fault / "lose-start").write_text("")
            job = submit("lossy", "echo run>>lossy-runs.txt&copy /y in.txt lossy-copy.txt>nul", inputs=["in.txt"],
                         artifacts=[{"path": "lossy-copy.txt"}])
            unknown = core.status(job["id"], "unknown", seconds=60)
            assert not (fault / "lose-start").exists(), "the start went through the wrapper"
            done = core.status(job["id"], "succeeded", "failed", "rejected", seconds=90)
            assert (done["status"], done["attempt"]) == ("succeeded", job["attempt"]), done
            assert read("lossy-runs.txt") == b"run\r\n", "it ran once"
            checked = result(done)["artifacts"]
            assert checked[0]["ok"] and checked[0]["sha256"] == sha(content), checked
            return {"jobId": job["id"], "unknownReason": unknown["reason"], "artifacts": checked}
        item("A start whose reply is lost is the same attempt when Windows answers, run once, with its inputs and artifacts",
             "real Windows on this PC; the reply was dropped by this run's helper wrapper", lost_start)

        def failure_kinds():
            job = submit("exit 3", "echo x>fail.txt&exit 3", inputs=["in.txt"], artifacts=[{"path": "fail.txt"}])
            done = core.status(job["id"], "succeeded", "failed", "rejected", seconds=90)
            evidence = result(done)
            assert (done["status"], exit_code(done)) == ("failed", 3) and done["reason"].startswith("exit-code 3"), done
            assert "artifacts" not in evidence and "artifacts" not in evidence["evidence"]["result"], evidence
            return {"jobId": job["id"], "reason": done["reason"]}
        item("A command that fails is reported as such, without an artifact check (artifact failures: above)",
             "real Windows on this PC", failure_kinds)

        report["passed"] = all(entry["result"] == "PASS" for entry in report["items"]) and len(report["items"]) == 6
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
        report["kept"] = "everything this run created on Windows is kept under its data root"
        (lab / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(str(lab / "report.json"), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
