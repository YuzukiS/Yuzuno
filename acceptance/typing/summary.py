#!/usr/bin/env python3
"""Prints T-18 profile runs side by side: summary.py LABEL [LABEL ...]"""
import json
import pathlib
import sys

RUNS = pathlib.Path(__file__).resolve().parents[2] / "target/t18/runs"
WINDOWS = ("idle", "typing", "backspace", "paste")


def trio(d, keys=("p50", "p95", "max")):
    return " / ".join("–" if d.get(k) is None else str(d[k]) for k in keys)


def line(label, name, w):
    drafts = w["storage"].get("yuzuno.drafts", {})
    c = w["chromiumMs"]
    keys = f"{w['keydowns']} ({w['repeats']} repeat) at {w['keysPerSecond'] or '–'}/s, max gap {w['keyGapMs']['max'] or '–'}"
    note = ""
    if name == "backspace":
        note = f"deleted {w['deleted']} of {w['draftBefore']} in {w['actSeconds']} s; delete inputs {w['inputs'].get('deleteContentBackward', 0)}"
    elif name == "typing":
        note = f"{w['draftLength']}/{w['typed']} chars in {w['actSeconds']} s"
    elif name == "paste":
        note = f"{w['kind']} {w['draftLength']} chars, paste events {w['pastes']}"
    return (f"| {label} | {name} | {w['commits']} | {keys if w['keydowns'] else '–'} | "
            f"{w['longtasks']['count']} / {w['longtasks']['ms']} / {w['longtasks']['max']} | "
            f"{trio(w['frameGapMs'])} ({w['frameGapMs']['over50']}) | "
            f"{w['keyEventsOver16ms']['n']} / {trio(w['keyEventsOver16ms'], ('p95', 'max'))} | "
            f"{trio(w['sseCallbackToDomMs'])} ({w['openNotInDom']}/{w['openReceived']}) | {trio(w['runtimeToDomMs'], ('p50', 'p95'))} | "
            f"{drafts.get('count', 0)} / {drafts.get('ms', 0)} | {c['ScriptDuration']} / {c['LayoutDuration']} / {c['RecalcStyleDuration']} | {note} |")


print("| run | window | commits | keydowns | long tasks n / ms / max | frame gap p50 / p95 / max ms (>50) "
      "| key events ≥16 ms: n / p95 / max | open Agent SSE callback→DOM p50 / p95 / max ms (not in DOM / received) "
      "| runtime→DOM p50 / p95 ms | draft saves n / ms | script / layout / style ms | checks |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|")
for label in sys.argv[1:]:
    report = json.loads((RUNS / f"{label}.json").read_text())
    if report.get("status") not in ("passed", "inconsistent"):
        print(f"| {label} | failed: {report.get('error', '')[:300]} |")
        continue
    for name in WINDOWS:
        if name in report["windows"]:
            print(line(label, name, report["windows"][name]))
    if report.get("problems"):
        print(f"| {label} | INCONSISTENT: {'; '.join(report['problems'])} |")
    renders = {n: w.get("renders") for n, w in report["windows"].items() if w.get("renders")}
    if renders:
        print(f"\n{label} renders per window (top components):")
        for name, counts in renders.items():
            print(f"- {name}: " + ", ".join(f"{k} {v}" for k, v in list(counts.items())[:14]))
