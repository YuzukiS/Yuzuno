#!/usr/bin/env python3
"""Medians of repeated browser.mjs runs: summarize.py runs/codex-before-*.json -- runs/codex-after-*.json"""
import json
import statistics
import sys

KEYS = ["detailBytes", "detailFetchMs", "renderedMs", "renderAfterFetchMs", "loadLongTasksMs", "preChars",
        "heapMB", "refreshFetchMs", "refreshLongTasksMs", "sequentialFetchAndParseMs", "sequentialParseMs"]


def load(paths):
    return [json.load(open(p)) for p in paths]


def main():
    split = sys.argv.index("--")
    before, after = load(sys.argv[1:split]), load(sys.argv[split + 1:])
    print(f"{'metric':28} {'before':>12} {'after':>12}   (median of {len(before)} / {len(after)} runs)")
    for key in KEYS:
        b = statistics.median(r[key] for r in before)
        a = statistics.median(r[key] for r in after)
        print(f"{key:28} {b:12,.1f} {a:12,.1f}")
    for run in after:
        if "expandItem" in run:
            print("expand:", json.dumps(run["expandItem"]), "copy:", json.dumps(run["copyTurn"]))


if __name__ == "__main__":
    main()
