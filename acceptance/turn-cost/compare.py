#!/usr/bin/env python3
"""Prints baseline vs candidate rows from target/turn-cost/runs/*/result.json.

Written MiB: "disk" is what Core sent to storage (/proc write_bytes: SQLite's
WAL and checkpoints); "all" is every byte Core wrote (wchar), which also
counts HTTP responses, so with --ui-poll it includes each detail the GUI
fetched."""
import json
import pathlib
import sys

RUNS = pathlib.Path(__file__).resolve().parents[2] / "target/turn-cost/runs"


def row(spec):
    # LABEL or LABEL=shown name
    label, _, shown = spec.partition("=")
    path = RUNS / label / "result.json"
    if not path.exists():
        return f"| {shown or label} | (missing) |"
    r = json.loads(path.read_text())
    lag = r["lagSeconds"]
    fmt = lambda v: "–" if v is None else f"{v:.2f}"
    bell = r.get("doorbellSeconds") or {}
    ui = r.get("uiFetch") or {}
    events = r.get("events") or r["journal"]["rows"]
    return (f"| {shown or label} | {events} | {r['wallSeconds']:.1f} | {r['coreCpuSeconds']:.1f} | {r['rssMiB']['peak']:.0f} | "
            f"{r['writtenMiB']['write_bytes']:.0f} / {r['writtenMiB']['wchar']:.0f} | {r['journal']['rows']} / {r['journal']['MiB']:.1f} | {fmt(lag['stream']['p50'])} / {fmt(lag['stream']['max'])} | "
            f"{fmt(lag['approval']['max'])} | {fmt(lag['terminal']['max'])} | {fmt(bell.get('urgent'))} / {fmt(bell.get('normal'))} | "
            f"{fmt((ui.get('workspace') or {}).get('p50'))} / {fmt((ui.get('agents') or {}).get('p50'))} |")


print("| run | events | wall s | Core CPU s | peak RSS MiB | written MiB disk / all | journal rows / MiB | stream lag p50/max s | approval s | Turn end s | doorbell urgent/normal s | GUI fetch list/agent p50 s |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|")
for label in sys.argv[1:]:
    print(row(label))
