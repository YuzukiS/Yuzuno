#!/usr/bin/env python3
"""T-185 lab for a browser check: a real Core with the stand-in tailscale.exe and
curl.exe (as smoke.py sets them up), left running for the page.

    lab.py start --core <yuzuno-workspace> --out <new dir> [--web-dir <web/dist>] [--environment]
    lab.py stop --out <dir>

start prints and writes <out>/lab.json: Core's port, the free local port to
apply, the stand-ins' state file, and Core's pid and start time. With
--environment, Core starts with YUZUNO_REMOTE_* for that port and the stand-in
already serves it, as an entry set up before Settings existed. stop signals
only that Core, after checking its pid and start time. Nothing else is touched:
no port 4317, no daily Core, no real Tailscale or Serve. Needs a WSL host.
"""
import argparse, json, os, signal, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from smoke import DNS, OWNER, Lab, free_port  # noqa: E402


def started(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["start", "stop"])
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--core")
    parser.add_argument("--web-dir", type=Path)
    parser.add_argument("--environment", action="store_true")
    args = parser.parse_args()
    out = args.out.resolve()
    if args.action == "stop":
        lab = json.loads((out / "lab.json").read_text())
        if started(lab["pid"]) != lab["startTime"]:
            print("Core already stopped (or its pid is another process now); nothing signalled")
            return
        os.kill(lab["pid"], signal.SIGINT)
        for _ in range(300):
            if started(lab["pid"]) != lab["startTime"]:
                print("stopped")
                return
            time.sleep(0.1)
        sys.exit("Core did not stop within 30 s; left as it is")
    out.mkdir(parents=True, exist_ok=False)
    lab = Lab(args.core, out)
    if args.web_dir:
        lab.web.rmdir()
        lab.web.symlink_to(args.web_dir.resolve())
    local = free_port()
    extra = None
    if args.environment:
        state = lab.fake()
        state["serve"]["TCP"]["8444"] = {"HTTPS": True}
        state["serve"]["Web"][f"{DNS}:8444"] = {"Handlers": {"/": {"Proxy": f"http://127.0.0.1:{local}"}}}
        lab.state.write_text(json.dumps(state))
        extra = {"YUZUNO_REMOTE_PORT": str(local), "YUZUNO_REMOTE_ORIGIN": f"https://{DNS}:8444", "YUZUNO_REMOTE_LOGIN": OWNER}
    lab.start(extra)
    pid = lab.process.pid
    info = {"corePort": lab.port, "page": f"http://127.0.0.1:{lab.port}/", "localPort": local, "dns": DNS, "owner": OWNER,
            "state": str(lab.state), "log": str(out / f"core-{lab.runs}.log"), "pid": pid, "startTime": started(pid)}
    (out / "lab.json").write_text(json.dumps(info, indent=1))
    print(json.dumps(info))


if __name__ == "__main__":
    main()
