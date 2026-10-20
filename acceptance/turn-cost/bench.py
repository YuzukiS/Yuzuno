#!/usr/bin/env python3
"""T-9: repeatable cost and latency run for long Turns on an isolated Core.

Starts its own Core (never 4317) with scripted Codex/Claude runtimes, builds
large Agent records through Core's own event path (warm-up), then replays one
measured Turn per Agent and reports Core CPU, RSS, bytes written, journal
volume and the delay between a runtime emitting an event and Core recording
it. Everything lives under target/turn-cost/runs/<label> (disk, not /tmp).

  bench.py --label base-codex --harness codex --agents 1 --run 2000:200:1:0
  bench.py --label base-claude --harness claude --agents 3 --ui-poll
  bench.py --label mix-3 --harness mixed --agents 3 --mix 3000:1:0 --ui-poll --ui-read --mail

--mix replays real native events extracted by mix.py (data/mix-<harness>.jsonl)
instead of the synthetic --run script. --harness mixed alternates Codex and
Claude Agents, starting with Codex.
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import re
import shutil
import signal
import sqlite3
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TICK = os.sysconf("SC_CLK_TCK")


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--label", required=True)
    p.add_argument("--core", default=str(ROOT / "target/debug/yuzuno-workspace"))
    p.add_argument("--port", type=int, default=4361)
    p.add_argument("--harness", choices=["codex", "claude", "mixed"], default="codex")
    p.add_argument("--agents", type=int, default=1)
    p.add_argument("--warmup", default="40:150", help="N:KB large Items per Agent before measuring")
    p.add_argument("--run", default="2000:200:1:0", help="deltas:outputs:approvals:rate")
    p.add_argument("--mix", help="events:approvals:rate: replay the first N real events of data/mix-<harness>.jsonl")
    p.add_argument("--ui-poll", action="store_true", help="fetch /api/workspace and the first Agent like the open GUI")
    p.add_argument("--ui-read", action="store_true", help="with --ui-poll, also send the GUI's read receipt for what it fetched")
    p.add_argument("--mail", action="store_true",
                   help="during the run, send the first Agent urgent and normal mail and time both doorbells")
    p.add_argument("--timeout", type=float, default=1800)
    return p.parse_args()


class Core:
    def __init__(self, args, run):
        self.base = f"http://127.0.0.1:{args.port}"
        env = dict(os.environ, YUZUNO_NODE=sys.executable, YUZUNO_CLAUDE_BRIDGE=str(HERE / "fake_claude.py"),
                   T9_TIMELINE=str(run / "timeline"))
        self.log = (run / "core.log").open("w")
        self.proc = subprocess.Popen([args.core, "--port", str(args.port), "--data-dir", str(run / "data"),
                                      "--web-dir", str(ROOT / "web/dist"), "--cwd", str(run / "task"),
                                      "--codex", str(HERE / "fake_codex.py")],
                                     env=env, stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                self.get("/api/workspace")
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("Core did not start; see core.log")

    def call(self, method, path, body=None, timeout=120):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method,
                                         headers={"Content-Type": "application/json", "x-yuzuno-client": "desktop"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}

    def get(self, path):
        return self.call("GET", path)

    def stats(self):
        pid = self.proc.pid
        stat = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        status = dict(line.split(":", 1) for line in pathlib.Path(f"/proc/{pid}/status").read_text().splitlines() if ":" in line)
        io = dict(line.split(": ") for line in pathlib.Path(f"/proc/{pid}/io").read_text().splitlines())
        kib = lambda key: int(status[key].split()[0])
        return {"t": time.time(), "cpu": (int(stat[11]) + int(stat[12])) / TICK, "rssMiB": kib("VmRSS") / 1024,
                "hwmMiB": kib("VmHWM") / 1024, **{k: int(v) for k, v in io.items()}}

    def stop(self):
        self.proc.send_signal(signal.SIGINT)
        try:
            self.proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self.log.close()


def db(run):
    return sqlite3.connect(f"file:{run / 'data/workspace.sqlite'}?mode=ro", uri=True, timeout=30)


def completions(run, ids, after):
    marks = ",".join("?" * len(ids))
    with db(run) as c:
        rows = c.execute(f"SELECT agent_id, COUNT(*) FROM journal WHERE seq>? AND kind='turn/completed' AND agent_id IN ({marks}) GROUP BY agent_id",
                         [after, *ids]).fetchall()
    return dict(rows)


def wait_completed(run, ids, after, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if len(completions(run, ids, after)) == len(ids):
            return True
        time.sleep(0.2)
    return False


def at_seconds(text):
    text = re.sub(r"(\.\d{6})\d+", r"\1", text)
    return dt.datetime.fromisoformat(text).timestamp()


def pct(values, q):
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, int(round(q * (len(values) - 1))))]


def summary(values):
    return {"n": len(values), "p50": pct(values, 0.5), "p95": pct(values, 0.95), "max": max(values) if values else None,
            "mean": statistics.fmean(values) if values else None}


def main():
    args = parse_args()
    run = ROOT / "target/turn-cost/runs" / args.label
    if run.exists():
        shutil.rmtree(run)
    for sub in ("data", "task", "timeline"):
        (run / sub).mkdir(parents=True)
    core = Core(args, run)
    result = {"label": args.label, "core": args.core, "harness": args.harness, "agents": args.agents,
              "warmup": args.warmup, "run": args.run, "mix": args.mix, "uiPoll": args.ui_poll, "uiRead": args.ui_read}
    try:
        ids, harness = [], {}
        for n in range(args.agents):
            kind = args.harness if args.harness != "mixed" else ("codex", "claude")[n % 2]
            body = {"name": f"bench-{n}", "cwd": str(run / "task"), "harness": kind,
                    "model": "bench" if kind == "claude" else "bench-model"}
            ids.append(core.call("POST", "/api/agents", body)["id"])
            harness[ids[-1]] = kind
        result["harnesses"] = [harness[a] for a in ids]
        for agent in ids:
            if harness[agent] == "claude":
                core.call("POST", f"/api/agents/{agent}/reconnect")
            for _ in range(100):
                if core.get(f"/api/agents/{agent}")["agent"]["connectionState"] == "connected":
                    break
                time.sleep(0.2)
            else:
                raise RuntimeError(f"Agent {agent} did not connect")

        def send_all(prompt):
            failures = []

            def send(agent):
                text = prompt(agent)
                try:
                    # The GUI sends Claude prompts as plain Turns, Codex ones as receipted messages.
                    if harness[agent] == "claude":
                        core.call("POST", f"/api/agents/{agent}/turns", {"text": text})
                    else:
                        core.call("POST", f"/api/agents/{agent}/messages", {"clientMessageId": str(uuid.uuid4()), "text": text})
                except urllib.error.HTTPError as error:
                    failures.append(f"{agent}: HTTP {error.code} {error.read()[:300]!r}")

            threads = [threading.Thread(target=send, args=(a,)) for a in ids]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            if failures:
                raise RuntimeError("; ".join(failures))

        started = time.time()
        send_all(lambda agent: f"warmup:{args.warmup}")
        assert wait_completed(run, ids, 0, args.timeout), "warm-up did not complete"
        result["warmupSeconds"] = time.time() - started
        with db(run) as c:
            result["recordBytes"] = {a: c.execute("SELECT length(data) FROM agents WHERE id=?", [a]).fetchone()[0] for a in ids}
            first_seq = c.execute("SELECT MAX(seq) FROM journal").fetchone()[0]

        stop = threading.Event()
        samples, fetches = [], []

        def sample():
            while not stop.is_set():
                samples.append(core.stats())
                stop.wait(0.5)

        reviewed = [0]

        def poll_ui():
            while not stop.is_set():
                began = time.time()
                for path in ("/api/workspace", f"/api/agents/{ids[0]}"):
                    t0 = time.time()
                    try:
                        body = core.get(path)
                        fetches.append({"path": path.split("/")[2], "seconds": time.time() - t0})
                        # As the open conversation does: what was shown is read.
                        seen = body.get("agent", {}).get("lastSeq", 0) if "agents/" in path else 0
                        if args.ui_read and seen > reviewed[0]:
                            t0 = time.time()
                            core.call("POST", f"/api/agents/{ids[0]}/review", {"throughSeq": seen})
                            fetches.append({"path": "review", "seconds": time.time() - t0})
                            reviewed[0] = seen
                    except Exception as error:
                        fetches.append({"path": path, "error": str(error)})
                stop.wait(max(0.0, 0.16 - (time.time() - began)))

        answered = {}

        def answer():
            while not stop.is_set():
                with db(run) as c:
                    for agent in ids:
                        raw = c.execute("SELECT json_extract(data,'$.pending') FROM agents WHERE id=?", [agent]).fetchone()[0]
                        for request in json.loads(raw or "[]"):
                            rid = request["id"]
                            if rid not in answered and not request.get("stale"):
                                answered[rid] = time.time()
                                try:
                                    decision = "allow" if harness[agent] == "claude" else "accept"
                                    core.call("POST", f"/api/requests/{rid}/respond", {"response": {"decision": decision}})
                                except urllib.error.HTTPError as error:
                                    answered[rid] = f"HTTP {error.code}: {error.read()[:200]!r}"
                stop.wait(0.2)

        workers = [threading.Thread(target=sample), threading.Thread(target=answer)]
        if args.ui_poll:
            workers.append(threading.Thread(target=poll_ui))
        before = core.stats()
        for worker in workers:
            worker.start()
        started = time.time()
        if args.mix:
            send_all(lambda agent: f"mix:{HERE / 'data' / ('mix-' + harness[agent] + '.jsonl')}:{args.mix}")
        else:
            send_all(lambda agent: f"run:{args.run}")
        mail = {}
        if args.mail:
            for priority in ("urgent", "normal"):
                mail[priority] = time.time()
                core.call("POST", "/api/collaboration/peer_send", {"requestId": str(uuid.uuid4()), "toAgentId": ids[0],
                                                                  "body": f"T-9 bench {priority} mail", "priority": priority})
        done = wait_completed(run, ids, first_seq, args.timeout)
        finished = time.time()

        def doorbells():
            rows = [json.loads(line) for path in (run / "timeline").glob("*.jsonl") for line in path.read_text().splitlines()]
            return [r for r in rows if r["m"].startswith("received/") and "mailbox" in r.get("text", "")]

        if args.mail:
            deadline = time.time() + 300
            while time.time() < deadline and not any(r["m"] == "received/start" for r in doorbells()):
                time.sleep(0.5)
        after = core.stats()
        stop.set()
        for worker in workers:
            worker.join()
        result["completed"] = done
        result["wallSeconds"] = finished - started
        result["coreCpuSeconds"] = after["cpu"] - before["cpu"]
        result["coreCpuPercent"] = 100 * result["coreCpuSeconds"] / result["wallSeconds"]
        result["rssMiB"] = {"before": before["rssMiB"], "peak": max(s["rssMiB"] for s in samples + [after]), "hwm": after["hwmMiB"]}
        result["writtenMiB"] = {"wchar": (after["wchar"] - before["wchar"]) / 2**20,
                                "write_bytes": (after["write_bytes"] - before["write_bytes"]) / 2**20}
        result["approvalsAnswered"] = answered

        # Lag: runtime emit time (timeline) to Core's journal time, per event.
        emitted = {}
        for path in (run / "timeline").glob("*.jsonl"):
            for line in path.read_text().splitlines():
                row = json.loads(line)
                if row["m"] != "reply" and not row["m"].startswith(("received/", "marker/")):
                    emitted[(row["thread"], row["k"])] = row
        # Runtime events of the measured Turns (journaled or not).
        result["events"] = sum(1 for row in emitted.values() if row["t"] >= started)
        with db(run) as c:
            threads = {a: c.execute("SELECT COALESCE(json_extract(data,'$.agent.threadId'),json_extract(data,'$.agent.claudeSessionId')) FROM agents WHERE id=?", [a]).fetchone()[0] for a in ids}
            rows = c.execute("SELECT agent_id, kind, at, json_extract(data,'$._bench'), length(data) FROM journal WHERE seq>?", [first_seq]).fetchall()
            result["journal"] = {"rows": len(rows), "MiB": sum(r[4] or 0 for r in rows) / 2**20}
            result["recordBytesAfter"] = {a: c.execute("SELECT length(data) FROM agents WHERE id=?", [a]).fetchone()[0] for a in ids}
        lags = {"all": [], "stream": [], "deltas": [], "terminal": [], "approval": []}
        for agent, kind, at, k, _ in rows:
            if k is None or agent not in threads:
                continue
            source = emitted.get((threads[agent], k))
            if not source:
                continue
            lag = at_seconds(at) - source["t"]
            lags["all"].append(lag)
            if kind in ("turn/completed", "claude/result") and "warm" not in str(source):
                lags["terminal"].append(lag)
            elif kind == "request":
                lags["approval"].append(lag)
            else:
                # Everything else streamed during the Turn. Deltas are journaled
                # only by builds before T-9 R2 ("deltas"); Core handles each
                # Agent's events strictly in order, so the journaled events
                # between them carry the same backlog.
                lags["stream"].append(lag)
                if "delta" in source["m"].lower() or kind == "claude/stream_event":
                    lags["deltas"].append(lag)
        result["lagSeconds"] = {k: summary(v) for k, v in lags.items()}
        if args.mail:
            # Urgent: posted -> steered into the running Turn. Normal: the
            # runtime finished that Turn -> the doorbell started a new one.
            rings = doorbells()
            first = threads[ids[0]]
            ended = [row["t"] for row in emitted.values() if row["thread"] == first and row["m"] in ("turn/completed", "claude/result")]
            steer = [r["t"] for r in rings if r["m"] == "received/steer"]
            start = [r["t"] for r in rings if r["m"] == "received/start"]
            before = [t for t in ended if start and t <= min(start)]
            result["doorbellSeconds"] = {
                "urgent": min(steer) - mail["urgent"] if steer else None,
                "normal": min(start) - max(before) if before else None,
            }
        if fetches:
            ok = [f for f in fetches if "seconds" in f]
            result["uiFetch"] = {path: summary([f["seconds"] for f in ok if f["path"] == path]) for path in ("workspace", "agents", "review")}
            result["uiFetch"]["errors"] = len(fetches) - len(ok)
        files = run / "data"
        result["dbMiB"] = sum(p.stat().st_size for p in files.glob("workspace.sqlite*")) / 2**20
    finally:
        core.stop()
    (run / "result.json").write_text(json.dumps(result, indent=2))
    brief = {k: result.get(k) for k in ("label", "completed", "wallSeconds", "coreCpuSeconds", "coreCpuPercent",
                                        "rssMiB", "writtenMiB", "journal", "lagSeconds", "uiFetch", "doorbellSeconds")}
    print(json.dumps(brief, indent=1))


if __name__ == "__main__":
    main()
