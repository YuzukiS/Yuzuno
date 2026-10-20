#!/usr/bin/env python3
"""Exercise real Codex history APIs with unauthenticated test turns.

This tests protocol persistence, not model execution. It uses new empty config
directories, never copies credentials, and never attaches to existing threads.
"""

import argparse
import json
from pathlib import Path
import queue
import tempfile
import time

from probe_local import Rpc


def drain_turn(client, thread_id, turn_id, seconds=12):
    events = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            event = client.messages.get(timeout=0.2)
        except queue.Empty:
            continue
        events.append(event)
        if event.get("method") == "turn/completed" and event.get("params", {}).get("threadId") == thread_id:
            return {"completed": True, "events": events}
    interrupt = client.call("turn/interrupt", {"threadId": thread_id, "turnId": turn_id})
    return {"completed": False, "interrupt": interrupt, "events": events}


def reads(client, thread_id):
    return {
        "readMetadata": client.call("thread/read", {"threadId": thread_id, "includeTurns": False}),
        "readTurns": client.call("thread/read", {"threadId": thread_id, "includeTurns": True}),
        "listTurns": client.call("thread/turns/list", {"threadId": thread_id, "itemsView": "full"}),
        "listItems": client.call("thread/items/list", {"threadId": thread_id}),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="yuzuno-history-"))
    profile = root / "profile"
    profile.mkdir(mode=0o700)
    (profile / "config.toml").write_text('cli_auth_credentials_store = "file"\n')
    report = {"root": str(root), "kind": "unauthenticated-interrupted-turn-persistence", "modes": {}}
    client = Rpc(profile, "history-probe")
    try:
        report["initialize"] = client.initialize()
        report["account"] = client.call("account/read", {"refreshToken": False})
        if report["account"].get("result", {}).get("account") is not None:
            raise RuntimeError("Refusing test: expected fresh unauthenticated profile")
        for mode in ("paginated", "legacy"):
            case = {"start": client.call("thread/start", {
                "cwd": str(root), "historyMode": mode, "approvalPolicy": "never", "sandbox": "read-only",
            })}
            thread_id = case["start"].get("result", {}).get("thread", {}).get("id")
            if not thread_id:
                report["modes"][mode] = case
                continue
            case["beforeTurn"] = reads(client, thread_id)
            case["turnStart"] = client.call("turn/start", {
                "threadId": thread_id,
                "input": [{"type": "text", "text": f"YUZUNO_PERSISTENCE_{mode}: reply with OK only.", "text_elements": []}],
            })
            turn_id = case["turnStart"].get("result", {}).get("turn", {}).get("id")
            if turn_id:
                case["turnOutcome"] = drain_turn(client, thread_id, turn_id)
            case["afterTurn"] = reads(client, thread_id)
            report["modes"][mode] = case
            print(f"Checked {mode} history in initial process", flush=True)
    finally:
        client.close()
    restarted = Rpc(profile, "history-probe-restarted")
    try:
        report["restartedInitialize"] = restarted.initialize()
        for mode, case in report["modes"].items():
            thread_id = case["start"].get("result", {}).get("thread", {}).get("id")
            if not thread_id:
                continue
            case["restartRead"] = reads(restarted, thread_id)
            case["resumeFull"] = restarted.call("thread/resume", {"threadId": thread_id})
            case["resumeMetadata"] = restarted.call("thread/resume", {"threadId": thread_id, "excludeTurns": True})
            print(f"Checked {mode} history after process restart", flush=True)
    finally:
        restarted.close()
    report["checks"] = {}
    for mode, case in report["modes"].items():
        expected = f"YUZUNO_PERSISTENCE_{mode}: reply with OK only."
        turns = case.get("resumeFull", {}).get("result", {}).get("thread", {}).get("turns", [])
        found = [part.get("text") for turn in turns for item in turn.get("items", [])
                 if item.get("type") == "userMessage" for part in item.get("content", [])]
        report["checks"][mode] = {
            "messageSurvivesProcessRestart": expected in found,
            "interruptedStateSurvivesProcessRestart": any(turn.get("status") == "interrupted" for turn in turns),
        }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    # Full results go only into the explicitly selected artifact; print the small summary.
    for mode, case in report["modes"].items():
        summary = {}
        for phase in ("beforeTurn", "afterTurn", "restartRead"):
            summary[phase] = {key: value.get("error", "ok") for key, value in case.get(phase, {}).items()}
        summary["resumeFull"] = case.get("resumeFull", {}).get("error", "ok")
        summary["resumeMetadata"] = case.get("resumeMetadata", {}).get("error", "ok")
        print(mode, json.dumps(summary))


if __name__ == "__main__":
    main()
