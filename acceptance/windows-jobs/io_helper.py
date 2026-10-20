#!/usr/bin/env python3
"""Windows inputs and artifacts at the helper level, on real Windows: direct
calls of two helper files, this run's own calls only, in a data root of its
own (%LOCALAPPDATA%\\yuzuno-acceptance\\<run>, created here and kept). No Core.

- the OLD helper (the one a release ships today, protocol 1) given a v3 start
  refuses it before anything is written or run; on an attempt the NEW helper
  started it reads status and logs and cancels as for any attempt, never
  misreads it, and never runs it again;
- the NEW helper: inspect, inputs checked again before the command runs (a
  changed one means not started), artifacts checked after a clean exit
  (verified, missing, malformed, outside cwd through a junction), a non-zero
  exit reported apart from artifacts, and a file another process holds open
  for writing named as such.

Setup only: the run's root, its work folder and fixture files are made through
WSL's view of the drive (as check.py does); every verdict comes from a helper
reading on Windows. Commands are short cmd.exe lines; nothing else on Windows
is touched. The digest is remote_job.py's own (the same encoding Core uses).

Usage: io_helper.py --old <exe> --new <exe> --run <name> --report <file>
"""
import argparse
import importlib.util
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve()
MARK = "YUZUNO-JOBS-REPLY "
CMD = r"C:\Windows\System32\cmd.exe"


def load_digest():
    spec = importlib.util.spec_from_file_location("remote_job_digest", HERE.parents[2] / "core/src/jobs/remote_job.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.digest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--old", required=True)
    parser.add_argument("--new", required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    digest = load_digest()
    report = {"run": args.run, "items": []}

    def call(program, request, root=None):
        request = dict(request, replyNonce=uuid.uuid4().hex)
        extra = ["--root", root] if root else []
        done = subprocess.run([program, *extra], input=json.dumps(request).encode(), capture_output=True, timeout=90)
        prefix = MARK + request["replyNonce"] + " "
        lines = [line[len(prefix):] for line in done.stdout.decode("utf-8", "replace").split("\n") if line.startswith(prefix)]
        reply = json.loads(lines[0]) if len(lines) == 1 else None
        return done.returncode, reply

    def item(name, check):
        entry = {"name": name}
        try:
            entry.update(check() or {})
            entry["passed"] = True
        except AssertionError as error:
            entry["passed"] = False
            entry["failure"] = str(error)[:2000]
        report["items"].append(entry)
        print(("PASS " if entry["passed"] else "FAIL ") + name + ("" if entry["passed"] else ": " + entry["failure"]))

    code, hello = call(args.new, {"action": "hello"})
    assert code == 0 and hello["status"] == "hello", (code, hello)
    host = hello["hostId"]
    root = hello["localAppData"].rstrip("\\") + "\\yuzuno-acceptance\\t108wio-" + args.run
    root_wsl = Path(subprocess.run(["wslpath", "-u", root], capture_output=True, text=True, check=True).stdout.strip())
    root_wsl.parent.mkdir(parents=True, exist_ok=True)
    root_wsl.mkdir()  # fails if it exists: never someone else's
    (root_wsl / "acceptance-run.json").write_text(json.dumps({"run": args.run, "createdAtUnix": time.time()}))
    work, work_wsl = root + "\\work", root_wsl / "work"
    work_wsl.mkdir()
    (root_wsl / "elsewhere").mkdir()
    (root_wsl / "elsewhere" / "o.json").write_text("[1]\n")
    (work_wsl / "in.txt").write_text("input one\n")
    report.update({"root": root, "hostId": host, "newHello": {k: hello.get(k) for k in ("protocol", "helperSha256", "os")}})
    old_hello = call(args.old, {"action": "hello"})[1]
    report["oldHello"] = {k: old_hello.get(k) for k in ("protocol", "helperSha256", "os")}

    def inspect(paths):
        code, reply = call(args.new, {"action": "inspect", "cwd": work, "inputs": paths}, root)
        assert code == 0 and reply["status"] == "inspected", (code, reply)
        return reply

    def start_request(argv, inputs=None, artifacts=None):
        spec = {"argv": argv, "cwd": work, "env": {}, "timeoutSeconds": 60,
                "limits": {"mode": "strict", "cpuMillis": 500, "memoryMiB": 256, "swapMiB": 0}}
        if inputs:
            spec["inputs"] = inputs
        if artifacts:
            spec["artifacts"] = artifacts
        return dict(spec, action="start", jobId=str(uuid.uuid4()), attempt=str(uuid.uuid4()), workspaceKey="t108wio-" + args.run,
                    machineId="windows", digest=digest(spec), expectHost=host)

    def bound(request, action, **extra):
        keys = ("jobId", "attempt", "workspaceKey", "machineId", "digest", "expectHost")
        return dict({k: request[k] for k in keys}, action=action, **extra)

    def settle(program, request, seconds=60):
        deadline = time.monotonic() + seconds
        while True:
            code, reply = call(program, bound(request, "status"), root)
            assert code == 0, (code, reply)
            if reply["status"] in ("terminal", "unclear") or time.monotonic() > deadline:
                return reply
            time.sleep(0.5)

    frozen = inspect(["in.txt"])["files"][0]
    report["frozen"] = frozen

    def old_refuses_v3():
        request = start_request([CMD, "/d", "/c", "echo ran>ran-old.txt"], [frozen], [{"path": "out.json", "format": "json", "minBytes": 1}])
        code, reply = call(args.old, request, root)
        assert code == 3 and "digest does not match" in (reply or {}).get("error", ""), (code, reply)
        # Nothing was written there for this attempt, and nothing ran.
        assert call(args.old, bound(request, "status"), root)[1]["status"] == "absent"
        assert call(args.new, bound(request, "status"), root)[1]["status"] == "absent"
        assert inspect(["ran-old.txt"])["files"][0].get("problem") == "missing"
        return {"oldReply": reply}
    item("old helper refuses a v3 start before writing or running anything", old_refuses_v3)

    def new_runs_v3_and_old_reads_it():
        artifacts = [{"path": "out.json", "format": "json", "minBytes": 1}, {"path": "lines.jsonl", "format": "jsonl", "minBytes": 1}]
        request = start_request([CMD, "/d", "/c", "echo [1,2]>out.json&echo {}>lines.jsonl&echo run>>runs.txt"], [frozen], artifacts)
        code, reply = call(args.new, request, root)
        assert code == 0 and reply["status"] in ("starting", "running", "settling", "terminal"), (code, reply)
        done = settle(args.new, request)
        result = done["result"]
        assert done["status"] == "terminal" and result["status"] == "succeeded", done
        checked = {a["path"]: a for a in result["artifacts"]}
        assert checked["out.json"]["ok"] and checked["lines.jsonl"]["ok"] and checked["lines.jsonl"]["lines"] == 1, checked
        assert checked["out.json"]["absolutePath"].lower() == (work + "\\out.json").lower(), checked
        # The old helper reads the same attempt as it is: terminal, the same result.
        code, old = call(args.old, bound(request, "status"), root)
        assert code == 0 and old["status"] == "terminal" and old["result"] == result, old
        code, logs = call(args.old, bound(request, "logs"), root)
        assert code == 0 and logs["status"] == "logs", logs
        # A repeated start through the old helper is refused: it never runs again.
        code, again = call(args.old, request, root)
        assert code == 3 and "digest does not match" in again["error"], again
        runs = inspect(["runs.txt"])["files"][0]
        assert runs.get("bytes") == len(b"run\r\n"), runs
        return {"result": result, "oldStatus": old["status"], "runsTxt": runs}
    item("new helper runs a v3 start; the old one reads it and never runs it again", new_runs_v3_and_old_reads_it)

    def old_cancels_new_attempt():
        request = start_request([CMD, "/d", "/c", "ping -n 30 127.0.0.1 >nul"], [frozen], [{"path": "never.json", "format": "json", "minBytes": 1}])
        code, reply = call(args.new, request, root)
        assert code == 0, (code, reply)
        code, running = call(args.old, bound(request, "status"), root)
        assert running["status"] == "running", running
        code, cancelled = call(args.old, bound(request, "cancel"), root)
        assert code == 0 and cancelled["status"] == "terminal" and cancelled["result"]["status"] == "cancelled", cancelled
        assert "artifacts" not in cancelled["result"], cancelled
        return {"cancelled": cancelled["result"]["reason"]}
    item("the old helper cancels a running v3 attempt of the new one", old_cancels_new_attempt)

    def changed_input_not_started():
        stale = dict(frozen, sha256="0" * 64)
        request = start_request([CMD, "/d", "/c", "echo ran>ran-changed.txt"], [stale])
        call(args.new, request, root)
        done = settle(args.new, request)
        assert done["result"]["status"] == "rejected", done
        assert done["result"]["reason"] == "Inputs changed on this machine while queued (in.txt (its content changed)); command was not started", done
        assert inspect(["ran-changed.txt"])["files"][0].get("problem") == "missing"
        return {"reason": done["result"]["reason"]}
    item("an input that changed after it was frozen: not started, nothing ran", changed_input_not_started)

    def artifact_failures_named():
        cases = {"missing": ("echo nothing", "missing.json", "json", "missing"),
                 "malformed": ("echo {x>bad.json", "bad.json", "json", "not complete JSON"),
                 "outside": ("mklink /J outside " + root + "\\elsewhere >nul", "outside\\o.json", "json", "resolves outside the working directory")}
        seen = {}
        for name, (line, path, fmt, problem) in cases.items():
            request = start_request([CMD, "/d", "/c", line], None, [{"path": path, "format": fmt, "minBytes": 1}])
            call(args.new, request, root)
            result = settle(args.new, request)["result"]
            assert result["status"] == "failed" and result["reason"].startswith("Exit 0, but declared artifacts failed verification: "), result
            assert result["artifacts"][0]["problem"].startswith(problem), result
            seen[name] = result["artifacts"][0]["problem"]
        return {"problems": seen}
    item("missing, malformed and outside-cwd artifacts each fail with their own reason", artifact_failures_named)

    def exit_code_apart():
        request = start_request([CMD, "/d", "/c", "echo [1]>late.json&exit 3"], None, [{"path": "late.json", "format": "json", "minBytes": 1}])
        call(args.new, request, root)
        result = settle(args.new, request)["result"]
        assert result["status"] == "failed" and result["reason"].startswith("exit-code 3"), result
        assert "artifacts" not in result, result
        return {"reason": result["reason"]}
    item("a non-zero exit is reported as such, with no artifact check", exit_code_apart)

    def held_open():
        request = start_request([CMD, "/d", "/c", "ping -n 20 127.0.0.1 >held.txt"])
        call(args.new, request, root)
        time.sleep(2)
        problem = inspect(["held.txt"])["files"][0].get("problem", "")
        call(args.new, bound(request, "cancel"), root)
        assert problem.startswith("cannot be read: another process has it open"), problem
        return {"problem": problem}
    item("a file another process holds open for writing is named, not read", held_open)

    report["passed"] = all(i["passed"] for i in report["items"])
    Path(args.report).write_text(json.dumps(report, indent=1, ensure_ascii=False))
    print(f"{sum(i['passed'] for i in report['items'])}/{len(report['items'])} passed")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
