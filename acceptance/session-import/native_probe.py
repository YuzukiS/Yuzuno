#!/usr/bin/env python3
"""Read native metadata/pages and optionally fork through a completed turn.

Never resumes or sends input to the source. Only sanitized field/count evidence
is written. Credentials are neither inspected nor copied. The optional fork is
persisted in the user's existing Codex profile for isolated import acceptance.
"""
from __future__ import annotations

import argparse
from collections import Counter
import gc
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "experiments/runtime"))
from probe_local import Rpc


def memory(pid: int) -> dict:
    try:
        fields = dict(line.split(":", 1) for line in Path(f"/proc/{pid}/status").read_text().splitlines() if ":" in line)
        return {name: int(fields[name].split()[0]) for name in ("VmRSS", "VmHWM") if name in fields}
    except (OSError, ValueError):
        return {}


def process_tree_memory(pid: int) -> dict:
    rows = []
    for status in Path("/proc").glob("[0-9]*/status"):
        try:
            fields = dict(line.split(":", 1) for line in status.read_text().splitlines() if ":" in line)
            rows.append((int(status.parent.name), int(fields["PPid"].strip()), fields.get("Name", "").strip()))
        except (OSError, ValueError, KeyError):
            continue
    included = {pid}
    while True:
        additions = {child for child, parent, _ in rows if parent in included} - included
        if not additions:
            break
        included |= additions
    processes = [{"pid": child, "name": name, **memory(child)} for child, _, name in rows if child in included]
    return {"totalRssKiB": sum(row.get("VmRSS", 0) for row in processes), "processes": processes}


def metadata(thread: dict) -> dict:
    return {key: thread.get(key) for key in (
        "id", "name", "cwd", "model", "modelProvider", "reasoningEffort",
        "historyMode", "createdAt", "updatedAt", "status", "cliVersion",
        "originator", "source", "sessionId", "forkedFromId",
    )} | {"previewCharacters": len(thread.get("preview", "")), "returnedTurns": len(thread.get("turns", []))}


def effective_settings(response: dict) -> dict:
    return {key: response.get(key) for key in (
        "model", "modelProvider", "reasoningEffort", "cwd", "approvalPolicy",
        "approvalsReviewer", "sandbox", "serviceTier", "activePermissionProfile",
        "turnsBackwardsCursor", "itemsBackwardsCursor",
    )}


def checked(client: Rpc, method: str, params: dict, timeout: int = 60) -> tuple[dict, dict]:
    start = time.monotonic()
    response = client.call(method, params, timeout=timeout)
    stats = {"seconds": round(time.monotonic() - start, 4), "responseBytes": len(json.dumps(response, ensure_ascii=False).encode()), "serverMemoryKiB": process_tree_memory(client.process.pid)}
    if "result" not in response:
        raise RuntimeError(json.dumps({"method": method, "error": response.get("error", response)}, ensure_ascii=False))
    return response["result"], stats


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--codex-home", type=Path, default=Path.home() / ".codex")
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("native-probe.json"))
    parser.add_argument("--fork", action="store_true")
    parser.add_argument("--full-read", action="store_true", help="Opt in to the deprecated, high-memory full-history read")
    parser.add_argument("--resume-fork", help="Resume an existing fork, never the original source")
    parser.add_argument("--last-turn", help="Explicit completed source turn; otherwise newest completed turn")
    args = parser.parse_args()
    report = {"sourceId": args.source, "sourceResumed": False, "sourceTurnSent": False, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    client = Rpc(args.codex_home, "session-import-native-probe")
    try:
        init = client.initialize()
        if "result" not in init:
            raise RuntimeError("Initialization failed")
        original, stats = checked(client, "thread/read", {"threadId": args.source, "includeTurns": False})
        report["metadata"] = metadata(original["thread"])
        report["metadataRead"] = stats
        cursor = None
        turns = []
        page_count = 0
        while True:
            params = {"threadId": args.source, "itemsView": "summary", "limit": 100, "sortDirection": "desc"}
            if cursor:
                params["cursor"] = cursor
            page, page_stats = checked(client, "thread/turns/list", params)
            turns.extend({key: turn.get(key) for key in ("id", "status", "startedAt", "completedAt")} for turn in page["data"])
            cursor = page.get("nextCursor")
            page_count += 1
            if not cursor:
                break
            if page_count > 100:
                raise RuntimeError("Unexpectedly large thread; bounded probe stopped")
        report["summaryPagination"] = {"turnCount": len(turns), "pageCount": page_count, "statusCounts": dict(Counter(t["status"] for t in turns)), "newest": turns[:3], "serverMemoryKiB": process_tree_memory(client.process.pid)}
        page, stats = checked(client, "thread/turns/list", {"threadId": args.source, "itemsView": "full", "limit": 20, "sortDirection": "desc"})
        report["latest20Full"] = stats | {"turnCount": len(page["data"]), "itemCount": sum(len(t.get("items", [])) for t in page["data"]), "hasOlder": bool(page.get("nextCursor")), "itemTypes": dict(Counter(i.get("type") for t in page["data"] for i in t.get("items", [])))}
        del page
        gc.collect()
        # A paginated read may return bounded history or reject full hydration;
        # record the installed protocol behavior without persisting contents.
        if args.full_read:
            start = time.monotonic()
            response = client.call("thread/read", {"threadId": args.source, "includeTurns": True}, timeout=60)
            if "result" in response:
                thread = response["result"]["thread"]
                report["readIncludeTurns"] = {"seconds": round(time.monotonic() - start, 4), "responseBytes": len(json.dumps(response, ensure_ascii=False).encode()), "turnCount": len(thread["turns"]), "itemCount": sum(len(t.get("items", [])) for t in thread["turns"]), "serverMemoryKiB": process_tree_memory(client.process.pid)}
            else:
                report["readIncludeTurns"] = {"error": response.get("error", response), "serverMemoryKiB": process_tree_memory(client.process.pid)}
            del response
            gc.collect()
        if args.fork:
            completed = [turn for turn in turns if turn["status"] == "completed"]
            selected = args.last_turn or completed[0]["id"]
            if selected not in {turn["id"] for turn in completed}:
                raise RuntimeError("Fork target must be an observed completed turn")
            fork, stats = checked(client, "thread/fork", {"threadId": args.source, "lastTurnId": selected, "excludeTurns": True}, timeout=90)
            fork_id = fork["thread"]["id"]
            if fork_id == args.source:
                raise RuntimeError("Fork unexpectedly retained source id")
            report["fork"] = {"lastTurnId": selected, "metadata": metadata(fork["thread"]), "settings": effective_settings(fork), "stats": stats}
            # The fork is our own isolated object. Resuming it is safe and
            # verifies native effective configuration, without any model call.
            resumed, stats = checked(client, "thread/resume", {"threadId": fork_id, "excludeTurns": True}, timeout=90)
            report["forkResume"] = {"metadata": metadata(resumed["thread"]), "settings": effective_settings(resumed), "stats": stats}
            first_page, stats = checked(client, "thread/turns/list", {"threadId": fork_id, "itemsView": "full", "limit": 20, "sortDirection": "desc"})
            report["forkLatest20Full"] = stats | {"turnCount": len(first_page["data"]), "newestTurnId": first_page["data"][0]["id"] if first_page["data"] else None, "hasOlder": bool(first_page.get("nextCursor"))}
        if args.resume_fork:
            if args.resume_fork == args.source:
                raise RuntimeError("Refusing to resume original source")
            fork_meta, _ = checked(client, "thread/read", {"threadId": args.resume_fork, "includeTurns": False})
            if fork_meta["thread"].get("forkedFromId") != args.source:
                raise RuntimeError("Acceptance thread is not a direct source fork")
            params = {"threadId": args.resume_fork, "excludeTurns": True,
                      "model": original["thread"].get("model"),
                      "config": {"model_reasoning_effort": original["thread"].get("reasoningEffort")}}
            resumed, stats = checked(client, "thread/resume", params, timeout=90)
            report["explicitSettingsResume"] = {"metadata": metadata(resumed["thread"]), "settings": effective_settings(resumed), "stats": stats}
        report["notificationSummary"] = {"count": len(client.events), "methods": dict(Counter(event.get("method") for event in client.events)), "bytes": sum(len(json.dumps(event, ensure_ascii=False).encode()) for event in client.events)}
    finally:
        # getrusage(RUSAGE_SELF).ru_maxrss can retain a pre-exec launcher peak
        # in this environment; /proc reflects this Python executable's memory.
        report["pythonMemoryKiB"] = memory(os.getpid())
        report["serverFinalMemoryKiB"] = process_tree_memory(client.process.pid)
        client.close()
        report["temporaryServerStopped"] = client.process.poll() is not None
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
