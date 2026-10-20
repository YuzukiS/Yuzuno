#!/usr/bin/env python3
"""T-9: SIGKILL Core while text streams, restart it on the same data, and check
the contract for a crash. Streamed text (deltas) is never journaled, so:

- completed Items and messages, and every synchronous event, are never lost;
- the partial text of the Item still streaming may be lost (or kept, if a
  record write happened to include it);
- nothing is repeated: a completed message replaces whatever partial text a
  mid-stream record write left, and no journal row is written twice.

For Codex and for Claude (scripted runtimes, the `killtest` script): msg-1 is
streamed and completed; msg-2 streams for 12.5 s (so the timed record write,
every 10 s, catches it half-way) and completes; msg-3 then streams. Core is killed 0.5 s
after msg-2 completes, before the next timed write. Isolated Core on its own
port and data, never 4317.

  kill.py [--core target/debug/yuzuno-workspace]
"""
import argparse
import json
import pathlib
import shutil
import sqlite3
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from bench import ROOT, Core  # noqa: E402

DELTA_KINDS = ("item/agentMessage/delta", "claude/stream_event")


def full_text(message, deltas):
    return "".join(f"Chunk {d} of {message}. " for d in range(deltas))


def items(turns):
    return [item for turn in turns for item in turn.get("items", [])]


def texts(turns, message):
    return [item.get("text") for item in items(turns) if item.get("id") == message]


def journal(run, agent):
    with sqlite3.connect(f"file:{run / 'data/workspace.sqlite'}?mode=ro", uri=True) as c:
        kinds = dict(c.execute("SELECT kind, COUNT(*) FROM journal WHERE agent_id=? GROUP BY kind", [agent]).fetchall())
        thinking = c.execute("SELECT COUNT(*) FROM journal WHERE agent_id=? AND kind='claude/system' "
                             "AND json_extract(data,'$.event.subtype')='thinking_tokens'", [agent]).fetchone()[0]
        record = json.loads(c.execute("SELECT data FROM agents WHERE id=?", [agent]).fetchone()[0])
    return kinds, thinking, record


def run_one(args, harness):
    run = ROOT / f"target/turn-cost/runs/kill-{harness}"
    if run.exists():
        shutil.rmtree(run)
    for sub in ("data", "task", "timeline"):
        (run / sub).mkdir(parents=True)
    args.harness = harness
    core = Core(args, run)
    agent = core.call("POST", "/api/agents", {"name": f"kill-{harness}", "cwd": str(run / "task"), "harness": harness,
                                              "model": "bench" if harness == "claude" else "bench-model"})["id"]
    if harness == "claude":
        core.call("POST", f"/api/agents/{agent}/reconnect")
    for _ in range(100):
        if core.get(f"/api/agents/{agent}")["agent"]["connectionState"] == "connected":
            break
        time.sleep(0.2)
    if harness == "claude":
        core.call("POST", f"/api/agents/{agent}/turns", {"text": "killtest"})
    else:
        core.call("POST", f"/api/agents/{agent}/messages", {"clientMessageId": "kill-run", "text": "killtest"})
    deadline = time.time() + 90
    marker = None
    while time.time() < deadline and marker is None:
        for path in (run / "timeline").glob("*.jsonl"):
            for line in path.read_text().splitlines():
                row = json.loads(line)
                if row["m"] == "marker/msg-2":
                    marker = row["t"]
        time.sleep(0.05)
    assert marker, "msg-2 never completed"
    time.sleep(max(0.0, marker + 0.5 - time.time()))
    core.proc.kill()
    core.proc.wait()
    core.log.close()
    killed_at = time.time()
    result = {"harness": harness, "killedSecondsAfterMsg2": killed_at - marker}
    kinds, thinking, record = journal(run, agent)
    result["deltaRowsJournaled"] = sum(kinds.get(k, 0) for k in DELTA_KINDS) + thinking
    result["journalAtKill"] = kinds
    msg2 = full_text("msg-2", 250)
    at_kill = texts(record["turns"], "msg-2")
    result["msg2InRecordAtKill"] = ("complete" if at_kill == [msg2] else
                                    "partial" if at_kill and at_kill[0] and msg2.startswith(at_kill[0]) else
                                    "absent" if not at_kill or not at_kill[0] else repr(at_kill)[:80])

    core = Core(args, run)
    try:
        detail = core.get(f"/api/agents/{agent}")
    finally:
        core.stop()
    kinds_after, _, record = journal(run, agent)
    for name, turns in (("detail", detail["turns"]), ("record", record["turns"])):
        msg3 = texts(turns, "msg-3")
        result[name] = {
            "msg1": texts(turns, "msg-1") == [full_text("msg-1", 30)],
            "msg2": texts(turns, "msg-2") == [msg2],
            # Partial text of the Item still streaming may be lost, never wrong.
            "msg3": "absent" if not msg3 or not msg3[0] else
                    "prefix" if len(msg3) == 1 and full_text("msg-3", 2000).startswith(msg3[0]) else repr(msg3)[:80],
        }
    result["statusAfterRestart"] = detail["agent"]["status"]
    result["errorAfterRestart"] = detail["agent"].get("error")
    restarted = {k: v - kinds.get(k, 0) for k, v in kinds_after.items() if v != kinds.get(k, 0)}
    result["journalAddedByRestart"] = restarted
    result["passed"] = (result["deltaRowsJournaled"] == 0
                        and all(result[n]["msg1"] and result[n]["msg2"] and result[n]["msg3"] in ("absent", "prefix")
                                for n in ("detail", "record"))
                        and set(restarted) <= {"workspace/restarted"}
                        and result["statusAfterRestart"] in ("offline", "uncertain"))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", default=str(ROOT / "target/debug/yuzuno-workspace"))
    parser.add_argument("--port", type=int, default=4361)
    args = parser.parse_args()
    results = {"core": args.core, "runs": [run_one(args, harness) for harness in ("codex", "claude")]}
    results["passed"] = all(r["passed"] for r in results["runs"])
    out = ROOT / "target/turn-cost/runs/kill.json"
    out.write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print(json.dumps(results, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
