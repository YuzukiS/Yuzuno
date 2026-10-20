#!/usr/bin/python3
"""Derive small timing tables without including answer bodies or history."""
import datetime
import json
import pathlib
import sys


def summarize(root):
    root = pathlib.Path(root)
    report = {"head": (root / "head.txt").read_text().strip(), "cases": []}
    for case in ["short", "long", "delayed"]:
        directory = root / case
        browser = json.loads((directory / "browser.json").read_text())
        http = [r for r in json.loads((directory / "http.json").read_text()) if r["method"] == "POST"]
        native = [json.loads(line) for line in (directory / "native.jsonl").read_text().splitlines()]
        journal = [{"kind": e["kind"], "at": datetime.datetime.fromisoformat(e["at"]).timestamp()*1000}
                   for e in json.loads((directory / "journal.json").read_text())]
        assert browser["passed"] and not browser["errors"]
        assert len(browser["runs"]) == len(http) == 3
        rows = []
        for run, request in zip(browser["runs"], http):
            assert request["path"] == run["requestPath"] and request["status"] == 200
            row = {"kind": run["kind"], "domNodes": run["domNodes"]}
            for field in ["requestStart", "busyCommit", "busyFrameOpportunity", "responseHeaders", "responseJson",
                          "acceptedCommit", "resolvedCommit", "completedFrameOpportunity"]:
                if field in run:
                    row[field + "Ms"] = round(run[field] - run["click"], 2)
            row["httpHandlerMs"] = round(request["end"] - request["start"], 2)
            row["journalFromHandlerMs"] = [{"kind": e["kind"], "ms": round(e["at"] - request["start"], 2)}
                for e in journal if request["start"] <= e["at"] <= request["end"]]
            if run["kind"] == "native":
                receive = next(e["at"] for e in native if e["kind"] == "native_answer_received")
                resolve = next(e["at"] for e in native if e["kind"] == "native_answer_resolved")
                row["coreToNativeReceiveMs"] = round(receive-request["start"], 2)
                row["nativeReceiveToResolvedMs"] = round(resolve-receive, 2)
            else:
                client = run["requestBody"]["clientMessageId"]
                events = [e for e in native if e.get("clientId") == client]
                assert len(events) == 2, "exactly one native send and reply"
                row["coreToNativeReceiveMs"] = round(events[0]["at"]-request["start"], 2)
                row["nativeReceiveToReplyMs"] = round(events[1]["at"]-events[0]["at"], 2)
                assert run["responseBody"]["status"] == "accepted"
            rows.append(row)
        entry = {"name": case, "fixture": json.loads((directory / "fixture.json").read_text()), "runs": rows}
        costs = directory / "store-costs.json"
        if costs.exists():
            entry["storeCosts"] = json.loads(costs.read_text())
        report["cases"].append(entry)
    return report


reports = [summarize(path) for path in sys.argv[1:]]
json.dump({"limitations": "One sample per path/case, same-host Linux Chromium and production release Core. Synthetic protocol mock, no real model latency. Browser routing adds shared instrumentation overhead. Two RAFs show a rendering opportunity, not proof of a painted frame. Journal timestamps are event record times, not isolated fsync timings. Native reply logs follow stdout emission.",
           "runs": reports}, sys.stdout, indent=2)
print()
