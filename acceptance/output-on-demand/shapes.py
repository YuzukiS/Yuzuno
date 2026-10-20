#!/usr/bin/env python3
"""Structural shapes (types and keys, never values) of large item fields."""
import json
import sqlite3
import sys
from collections import Counter


def size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


def shape(value, depth=0):
    if isinstance(value, dict):
        if depth > 2:
            return "{...}"
        return "{" + ",".join(f"{k}:{shape(v, depth + 1)}" for k, v in sorted(value.items())) + "}"
    if isinstance(value, list):
        if not value:
            return "[]"
        kinds = sorted({shape(v, depth + 1) for v in value[:20]})
        return "[" + "|".join(kinds[:3]) + ("|..." if len(kinds) > 3 else "") + "]"
    return type(value).__name__


def main():
    db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
    shapes = Counter()
    big = Counter()
    for _, raw in db.execute("SELECT id, data FROM agents"):
        detail = json.loads(raw)
        for turn in detail.get("turns", []):
            for item in turn.get("items") or []:
                typ = item.get("type")
                for key in ("aggregatedOutput", "changes", "result", "output", "input", "commandActions", "contentItems", "results"):
                    if key in item:
                        s = shape(item[key])
                        shapes[(typ, key, s[:160])] += 1
                        if size(item[key]) > 16384:
                            big[(typ, key, s[:160])] += 1
                if typ == "claudeToolUse":
                    shapes[(typ, "name=" + str(item.get("name")), "")] += 1
                    if size(item.get("output")) > 8192:
                        big[(typ, "bigOutputName=" + str(item.get("name")), "")] += 1
                    if size(item.get("input")) > 8192:
                        big[(typ, "bigInputName=" + str(item.get("name")), "")] += 1
    for (typ, key, s), n in sorted(shapes.items()):
        print(f"{n:6} {typ} {key} {s}")
    print("--- >16K (or named >8K)")
    for (typ, key, s), n in sorted(big.items()):
        print(f"{n:6} {typ} {key} {s}")


if __name__ == "__main__":
    main()
